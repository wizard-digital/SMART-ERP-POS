/**
 * Release gate — login, POS sale and tenant switching through the REAL server process, with SEEDED data (LOCAL ONLY).
 *
 *   * master registry DB + two tenant DBs (alpha, beta) cloned from `sp_template_local` (schema of production pos_template)
 *   * local redis-server 7.4.8 with requirepass
 *   * the real `src/server.ts` (tsx), tenants resolved by subdomain (Host header alpha.pos.test / beta.pos.test)
 *   * HTTP only: POST /api/auth/login, GET /api/auth/profile, POST /api/sales  (single CASH, split CASH+MOBILE_MONEY, replay)
 * Verifies in the databases afterwards: sale + payment lines, balanced journal, per-account liquidity debits, stock decrement,
 * and that nothing from alpha appears in beta.
 *
 *   node scripts/gates/e2e-login-pos-tenant.mjs [--out ../PROOF_E2E_LOGIN_POS_TENANT_LOCAL.json]
 * Requires: local Postgres (LOCAL_PG_URL), database sp_template_local (scripts/ops/clone-template-local.mjs), Redis 7.4.8 binary.
 * Production is never contacted.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcrypt';
import pg from 'pg';
import Redis from 'ioredis';
import { Evidence, registerSecret } from './lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(here, '../..');
const repoRoot = path.resolve(serverDir, '..');
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const OUT = opt('--out', '../PROOF_E2E_LOGIN_POS_TENANT_LOCAL.json');
const ADMIN_URL = process.env.LOCAL_PG_URL || 'postgresql://postgres:password@localhost:5432/postgres';
const REDIS_BIN = process.env.REDIS_748_BIN || path.join(tmpdir(), 'redis748', 'x', 'Redis-7.4.8-Windows-x64-msys2', 'redis-server.exe');
const REDIS_PW = `e2e-${Math.random().toString(36).slice(2)}-pw`;
registerSecret(REDIS_PW);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

const ev = new Evidence('Release gate — login / POS sale / tenant switch with seeded data (local, real server)');
const meta = { commands: [], seeded: {} };
if (!/localhost|127\.0\.0\.1/.test(ADMIN_URL)) { console.error('Refusing: LOCAL_PG_URL must be local'); process.exit(2); }
if (!existsSync(REDIS_BIN)) { ev.notExecuted({ gate: 'E2E', id: 'E2E.all', description: 'login/POS/tenant e2e', reason: `redis-server not found at ${REDIS_BIN}` }); ev.write(OUT, { meta }); process.exit(1); }

const stamp = Date.now();
const DB = { master: `e2e_master_${stamp}`, alpha: `e2e_alpha_${stamp}`, beta: `e2e_beta_${stamp}` };
const url = (db) => ADMIN_URL.replace(/\/[^/]*$/, `/${db}`);
const PASSWORDS = { alpha: 'Alpha-pass-123!', beta: 'Beta-pass-456!' };
const HOSTS = { alpha: 'alpha.pos.test', beta: 'beta.pos.test' };
let server = null; let redisProc = null; const logs = [];
const admin = new pg.Client({ connectionString: ADMIN_URL });
let rc = 0;

function call(port, host, method, p, { body, token } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { Host: host, 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) } }, (res) => {
      let buf = ''; res.on('data', (c) => (buf += c)); res.on('end', () => { let json = null; try { json = JSON.parse(buf); } catch { /* not json */ } resolve({ status: res.statusCode, json, text: buf.slice(0, 400) }); });
    });
    req.on('error', reject); req.setTimeout(30000, () => req.destroy(new Error('timeout')));
    if (data) req.write(data); req.end();
  });
}
const tokenOf = (r) => r.json?.data?.accessToken ?? r.json?.data?.token ?? r.json?.accessToken ?? r.json?.token ?? null;

async function seedTenant(db, slug, label) {
  const c = new pg.Client({ connectionString: url(db) }); await c.connect();
  const hash = await bcrypt.hash(PASSWORDS[slug], 10);
  const u = await c.query(`INSERT INTO users (email, password_hash, full_name, role, user_number, is_active) VALUES ($1,$2,$3,'ADMIN','USR-E2E-001', true) RETURNING id`, [`admin@${slug}.test`, hash, `${label} Admin`]);
  const p = await c.query(`INSERT INTO products (sku, name, selling_price, cost_price, is_active) VALUES ($1,$2,5000,3000,true) RETURNING id`, [`E2E-${slug}-1`, `E2E Widget ${label}`]);
  const pid = p.rows[0].id;
  await c.query(`INSERT INTO product_inventory (product_id, quantity_on_hand) VALUES ($1, 100) ON CONFLICT (product_id) DO UPDATE SET quantity_on_hand=100`, [pid]);
  await c.query(`INSERT INTO product_valuation (product_id, cost_price, selling_price, average_cost, last_cost) VALUES ($1,3000,5000,3000,3000) ON CONFLICT (product_id) DO UPDATE SET cost_price=3000, selling_price=5000, average_cost=3000, last_cost=3000`, [pid]);
  await c.query(`INSERT INTO inventory_batches (batch_number, product_id, quantity, remaining_quantity, cost_price) VALUES ($1,$2,100,100,3000)`, [`B-${slug}-1`, pid]);
  await c.query(`INSERT INTO cost_layers (product_id, quantity, remaining_quantity, unit_cost) VALUES ($1,100,100,3000)`, [pid]);
  await c.end();
  return { userId: u.rows[0].id, productId: pid };
}
const tenantState = async (db) => {
  const c = new pg.Client({ connectionString: url(db) }); await c.connect();
  const q = async (s, p = []) => (await c.query(s, p)).rows;
  const out = {
    sales: await q(`SELECT id, sale_number, total_amount::float8 total, payment_method, status FROM sales ORDER BY created_at`),
    lines: await q(`SELECT s.sale_number, pl.payment_method, pl.amount::float8 amount FROM payment_lines pl JOIN sales s ON s.id=pl.sale_id ORDER BY s.created_at, pl.payment_method`),
    journals: await q(`SELECT t."TransactionNumber" n, t."ReferenceNumber" ref, t."Status" st, t."TotalDebitAmount"::float8 dr, t."TotalCreditAmount"::float8 cr, (SELECT round(sum("DebitAmount")-sum("CreditAmount"),2)::float8 FROM ledger_entries e WHERE e."TransactionId"=t."Id") diff FROM ledger_transactions t WHERE t."ReferenceType"='SALE' ORDER BY t."CreatedAt"`),
    liquidity: await q(`SELECT a."AccountCode" code, sum(e."DebitAmount")::float8 dr, sum(e."CreditAmount")::float8 cr, t."ReferenceNumber" ref FROM ledger_entries e JOIN ledger_transactions t ON t."Id"=e."TransactionId" JOIN accounts a ON a."Id"=e."AccountId" WHERE t."ReferenceType"='SALE' AND a."AccountCode" IN ('1010','1020','1030','1040') GROUP BY a."AccountCode", t."ReferenceNumber" ORDER BY t."ReferenceNumber", a."AccountCode"`),
    stock: (await q(`SELECT quantity_on_hand::float8 q FROM product_inventory LIMIT 1`))[0]?.q,
    bank: await q(`SELECT description, amount::float8 amount FROM bank_transactions WHERE source_type='SALE' ORDER BY created_at`),
  };
  await c.end();
  return out;
};

try {
  await admin.connect();
  const tpl = await admin.query(`SELECT 1 FROM pg_database WHERE datname='sp_template_local'`);
  if (!tpl.rowCount) throw new Error('sp_template_local does not exist: run scripts/ops/clone-template-local.mjs');
  await admin.query(`CREATE DATABASE ${DB.master}`);
  await admin.query(`CREATE DATABASE ${DB.alpha} TEMPLATE sp_template_local`);
  await admin.query(`CREATE DATABASE ${DB.beta} TEMPLATE sp_template_local`);
  const m = new pg.Client({ connectionString: url(DB.master) }); await m.connect();
  await m.query(readFileSync(path.join(repoRoot, 'shared', 'sql', '400_multi_tenant.sql'), 'utf8'));
  for (const [slug, name] of [['alpha', 'Alpha Store'], ['beta', 'Beta Store']]) {
    await m.query(`INSERT INTO tenants (slug, name, database_name, database_host, database_port, status, plan) VALUES ($1,$2,$3,'localhost',5432,'ACTIVE','ENTERPRISE')`, [slug, name, DB[slug]]);
  }
  await m.end();
  const A = await seedTenant(DB.alpha, 'alpha', 'Alpha');
  const B = await seedTenant(DB.beta, 'beta', 'Beta');
  meta.seeded = { databases: DB, alpha: A, beta: B, passwordsInThisFile: 'test-only values, never used outside this script' };

  const rport = await freePort();
  const rdir = mkdtempSync(path.join(tmpdir(), 'e2e-redis-'));
  redisProc = spawn(REDIS_BIN, ['--port', String(rport), '--bind', '127.0.0.1', '--requirepass', REDIS_PW, '--dir', rdir.replace(/\\/g, '/'), '--appendonly', 'no', '--save', ''], { stdio: 'ignore', windowsHide: true });
  const rurl = `redis://:${REDIS_PW}@127.0.0.1:${rport}`;
  for (let i = 0; i < 60; i++) { try { const t = new Redis(rurl, { retryStrategy: () => null, maxRetriesPerRequest: 1 }); t.on('error', () => undefined); await t.ping(); t.disconnect(); break; } catch { await sleep(250); } }

  const port = await freePort();
  const u = new URL(ADMIN_URL);
  const env = { ...process.env, NODE_ENV: 'development', PORT: String(port), DATABASE_URL: url(DB.master), DB_HOST: u.hostname, DB_PORT: u.port || '5432', DB_USER: decodeURIComponent(u.username), DB_PASSWORD: decodeURIComponent(u.password), JWT_SECRET: 'e2e-test-jwt-secret-0123456789abcdef0123456789abcdef', JWT_REFRESH_SECRET: 'e2e-test-refresh-secret-0123456789abcdef0123456789ab', REDIS_URL: rurl, REDIS_HOST: '127.0.0.1', REDIS_PORT: String(rport), REDIS_PASSWORD: REDIS_PW, LOG_LEVEL: 'info' };
  registerSecret(env.JWT_SECRET); registerSecret(env.JWT_REFRESH_SECRET);
  server = spawn(process.execPath, [path.join(serverDir, 'node_modules/tsx/dist/cli.mjs'), 'src/server.ts'], { cwd: serverDir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const onData = (b) => { for (const l of String(b).split(/\r?\n/)) if (l.trim()) logs.push(l); };
  server.stdout.on('data', onData); server.stderr.on('data', onData);
  let exited = null; server.on('exit', (code) => { exited = code; });
  meta.commands.push({ cmd: 'tsx src/server.ts (master + 2 tenant DBs, authenticated redis)', port });

  let health = null;
  for (let i = 0; i < 240 && exited === null; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/health`); health = r.status; if (health === 200) break; } catch { /* not up */ } await sleep(500); }
  await ev.check({ gate: 'E2E', id: 'E2E.health', description: 'Server starts against the seeded master + tenant databases', expected: '200', evidence: 'GET /health' }, async () => ({ observed: { health, exited }, pass: health === 200 }));
  if (health !== 200) throw new Error('server did not start: ' + logs.slice(-8).join(' | '));

  // ── LOGIN ──
  const bad = await call(port, HOSTS.alpha, 'POST', '/api/auth/login', { body: { email: 'admin@alpha.test', password: 'wrong-password' } });
  await ev.check({ gate: 'E2E', id: 'E2E.login.wrongPassword', description: 'Wrong password is rejected', expected: '401', evidence: 'POST /api/auth/login' }, async () => ({ observed: { status: bad.status }, pass: bad.status === 401 }));
  const cross = await call(port, HOSTS.alpha, 'POST', '/api/auth/login', { body: { email: 'admin@beta.test', password: PASSWORDS.beta } });
  await ev.check({ gate: 'E2E', id: 'E2E.login.otherTenantCredentials', description: "Tenant B's user cannot log in on tenant A's host", expected: '401', evidence: 'POST /api/auth/login (alpha host, beta user)' }, async () => ({ observed: { status: cross.status }, pass: cross.status === 401 }));
  const la = await call(port, HOSTS.alpha, 'POST', '/api/auth/login', { body: { email: 'admin@alpha.test', password: PASSWORDS.alpha } });
  const ta = tokenOf(la);
  await ev.check({ gate: 'E2E', id: 'E2E.login.alpha', description: 'Alpha admin logs in on the alpha host and receives a token for tenant alpha', expected: '200 + token', evidence: 'POST /api/auth/login' }, async () => ({ observed: { status: la.status, hasToken: !!ta, keys: Object.keys(la.json?.data ?? {}), text: ta ? undefined : la.text }, pass: la.status === 200 && !!ta }));
  const lb = await call(port, HOSTS.beta, 'POST', '/api/auth/login', { body: { email: 'admin@beta.test', password: PASSWORDS.beta } });
  const tb = tokenOf(lb);
  await ev.check({ gate: 'E2E', id: 'E2E.login.beta', description: 'Beta admin logs in on the beta host (tenant switch = a different host/tenant)', expected: '200 + token', evidence: 'POST /api/auth/login' }, async () => ({ observed: { status: lb.status, hasToken: !!tb, text: tb ? undefined : lb.text }, pass: lb.status === 200 && !!tb }));
  if (!ta || !tb) throw new Error('login failed; see checks');

  const pa = await call(port, HOSTS.alpha, 'GET', '/api/auth/profile', { token: ta });
  const pb = await call(port, HOSTS.beta, 'GET', '/api/auth/profile', { token: tb });
  await ev.check({ gate: 'E2E', id: 'E2E.profile.ownTenant', description: 'Each token works on its own tenant and returns that tenant\'s user', expected: '200/200, emails admin@alpha.test / admin@beta.test', evidence: 'GET /api/auth/profile' }, async () => ({ observed: { alpha: [pa.status, pa.json?.data?.email ?? pa.json?.data?.user?.email], beta: [pb.status, pb.json?.data?.email ?? pb.json?.data?.user?.email] }, pass: pa.status === 200 && pb.status === 200 && JSON.stringify(pa.json).includes('admin@alpha.test') && JSON.stringify(pb.json).includes('admin@beta.test') }));
  const xa = await call(port, HOSTS.beta, 'GET', '/api/auth/profile', { token: ta });
  const xb = await call(port, HOSTS.alpha, 'GET', '/api/auth/profile', { token: tb });
  await ev.check({ gate: 'E2E', id: 'E2E.tenantSwitch.tokenNotPortable', description: "A token issued for tenant A is refused on tenant B's host and vice versa", expected: '401/403 both ways', evidence: 'GET /api/auth/profile with swapped hosts' }, async () => ({ observed: { aOnB: xa.status, bOnA: xb.status }, pass: [401, 403].includes(xa.status) && [401, 403].includes(xb.status) }));

  // ── POS SALE ──
  const sale = (pid, extra) => ({ lineItems: [{ productId: pid, productName: 'E2E Widget', sku: '', uom: 'PCS', quantity: 2, unitPrice: 5000, costPrice: 3000, subtotal: 10000, taxAmount: 0 }], subtotal: 10000, taxAmount: 0, totalAmount: 10000, ...extra });
  const s1 = await call(port, HOSTS.alpha, 'POST', '/api/sales', { token: ta, body: sale(A.productId, { paymentMethod: 'CASH', amountTendered: 10000, idempotencyKey: 'e2e-cash-1' }) });
  await ev.check({ gate: 'E2E', id: 'E2E.pos.singleCash', description: 'POS single-tender CASH sale is created', expected: '201/200 success', evidence: 'POST /api/sales' }, async () => ({ observed: { status: s1.status, ok: s1.json?.success, text: s1.json?.success ? undefined : s1.text }, pass: [200, 201].includes(s1.status) && s1.json?.success === true }));
  const s2 = await call(port, HOSTS.alpha, 'POST', '/api/sales', { token: ta, body: sale(A.productId, { paymentLines: [{ paymentMethod: 'CASH', amount: 6000 }, { paymentMethod: 'MOBILE_MONEY', amount: 4000 }], amountTendered: 10000, idempotencyKey: 'e2e-split-1' }) });
  await ev.check({ gate: 'E2E', id: 'E2E.pos.splitTender', description: 'POS split-tender (CASH 6,000 + MOBILE_MONEY 4,000) sale is created', expected: '201/200 success', evidence: 'POST /api/sales' }, async () => ({ observed: { status: s2.status, ok: s2.json?.success, text: s2.json?.success ? undefined : s2.text }, pass: [200, 201].includes(s2.status) && s2.json?.success === true }));
  const s2r = await call(port, HOSTS.alpha, 'POST', '/api/sales', { token: ta, body: sale(A.productId, { paymentLines: [{ paymentMethod: 'CASH', amount: 6000 }, { paymentMethod: 'MOBILE_MONEY', amount: 4000 }], amountTendered: 10000, idempotencyKey: 'e2e-split-1' }) });
  await ev.check({ gate: 'E2E', id: 'E2E.pos.replayIdempotent', description: 'Replaying the same idempotency key returns the existing sale and creates nothing', expected: '200 alreadySynced', evidence: 'POST /api/sales (same key)' }, async () => ({ observed: { status: s2r.status, alreadySynced: s2r.json?.data?.alreadySynced }, pass: s2r.status === 200 && s2r.json?.data?.alreadySynced === true }));
  const s3 = await call(port, HOSTS.beta, 'POST', '/api/sales', { token: tb, body: sale(B.productId, { paymentLines: [{ paymentMethod: 'MOBILE_MONEY', amount: 10000 }], amountTendered: 10000, idempotencyKey: 'e2e-beta-momo-1' }) });
  await ev.check({ gate: 'E2E', id: 'E2E.pos.betaSale', description: 'A sale on the other tenant (single MOBILE_MONEY line) is created', expected: '201/200 success', evidence: 'POST /api/sales (beta host)' }, async () => ({ observed: { status: s3.status, ok: s3.json?.success, text: s3.json?.success ? undefined : s3.text }, pass: [200, 201].includes(s3.status) && s3.json?.success === true }));
  const wrongProduct = await call(port, HOSTS.beta, 'POST', '/api/sales', { token: tb, body: sale(A.productId, { paymentMethod: 'CASH', amountTendered: 10000, idempotencyKey: 'e2e-beta-cross-1' }) });
  await ev.check({ gate: 'E2E', id: 'E2E.pos.crossTenantProductRefused', description: "Tenant B cannot sell tenant A's product id", expected: 'not 2xx', evidence: 'POST /api/sales' }, async () => ({ observed: { status: wrongProduct.status }, pass: ![200, 201].includes(wrongProduct.status) }));

  await sleep(4000); // let async GL / outbox / bank-mirror work finish
  const sa = await tenantState(DB.alpha); const sb = await tenantState(DB.beta);
  meta.alphaState = sa; meta.betaState = sb;
  const liq = (st, ref) => Object.fromEntries(st.liquidity.filter((x) => x.ref === ref).map((x) => [x.code, x.dr - x.cr]));
  const saleNums = sa.sales.map((s) => s.sale_number);
  await ev.check({ gate: 'E2E', id: 'E2E.db.alphaSales', description: 'Alpha DB has exactly the two created sales (replay created nothing)', expected: '2 sales; payment_lines only for the split sale (the legacy single-method path stores none): 2 lines', evidence: 'sales / payment_lines' }, async () => ({ observed: { sales: sa.sales.length, lines: sa.lines.length, stock: sa.stock }, pass: sa.sales.length === 2 && sa.lines.length === 2 }));
  await ev.check({ gate: 'E2E', id: 'E2E.db.journalsBalanced', description: 'Every sale journal in both tenants balances (debit = credit)', expected: 'diff 0, header dr = cr', evidence: 'ledger_entries' }, async () => ({ observed: { alpha: sa.journals, beta: sb.journals }, pass: sa.journals.length >= 2 && [...sa.journals, ...sb.journals].every((j) => j.diff === 0 && j.st === 'POSTED') }));
  const cashSale = liq(sa, sa.sales[0]?.sale_number); const splitSale = liq(sa, sa.sales[1]?.sale_number);
  await ev.check({ gate: 'E2E', id: 'E2E.db.cashSaleToCash', description: 'Single CASH sale debits 1010 for the whole amount', expected: '{1010: 10000}', evidence: 'ledger_entries' }, async () => ({ observed: cashSale, pass: cashSale['1010'] === 10000 && Object.keys(cashSale).length === 1 }));
  await ev.check({ gate: 'E2E', id: 'E2E.db.splitTenderPostedPerLine', description: 'Split sale posts CASH 6,000 to 1010 and MOBILE_MONEY 4,000 to 1040 (not 10,000 to one account)', expected: '{1010: 6000, 1040: 4000}', evidence: 'ledger_entries' }, async () => ({ observed: splitSale, pass: splitSale['1010'] === 6000 && splitSale['1040'] === 4000 }));
  const momoSale = liq(sb, sb.sales[0]?.sale_number);
  await ev.check({ gate: 'E2E', id: 'E2E.db.momoSaleTo1040', description: 'Beta single MOBILE_MONEY sale posts to 1040, not cash', expected: '{1040: 10000}', evidence: 'ledger_entries' }, async () => ({ observed: momoSale, pass: momoSale['1040'] === 10000 && Object.keys(momoSale).length === 1 }));
  await ev.check({ gate: 'E2E', id: 'E2E.db.tenantIsolation', description: 'Alpha sales never appear in beta and vice versa; cross-tenant product sale left no trace', expected: 'beta has exactly 1 sale; none shares a sale number with alpha only via own sequence', evidence: 'sales' }, async () => ({ observed: { alphaSales: saleNums, betaSales: sb.sales.map((s) => s.sale_number), betaStock: sb.stock }, pass: sb.sales.length === 1 && sb.lines.length === 1 }));
  await ev.check({ gate: 'E2E', id: 'E2E.db.stock', description: 'Stock moved by the sold quantity on each tenant (alpha 100-4=96, beta 100-2=98)', expected: '96 / 98', evidence: 'product_inventory' }, async () => ({ observed: { alpha: sa.stock, beta: sb.stock }, pass: sa.stock === 96 && sb.stock === 98 }));
  ev.info({ gate: 'E2E', id: 'E2E.info.bankMirror', description: 'Bank register rows created for the sales (informational; depends on seeded bank accounts, none seeded here)', observed: { alpha: sa.bank, beta: sb.bank }, evidence: 'bank_transactions' });
} catch (e) {
  rc = 1; console.error('E2E ERROR:', e?.stack ?? e);
  ev.notExecuted({ gate: 'E2E', id: 'E2E.error', description: 'e2e harness aborted', reason: String(e?.message ?? e).slice(0, 400) });
} finally {
  if (server) { spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' }); }
  if (redisProc) { try { redisProc.kill('SIGKILL'); } catch { /* gone */ } }
  await sleep(1500);
  for (const d of Object.values(DB)) await admin.query(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`).catch((e) => console.error('drop failed', d, e.message));
  await admin.end().catch(() => undefined);
}
meta.serverLogTail = logs.slice(-30);
const res = ev.write(OUT, { meta });
console.log('SUMMARY', JSON.stringify(res.summary), 'sha256', res.sha256);
process.exit(rc || (res.summary.failBlocker > 0 ? 1 : 0));
