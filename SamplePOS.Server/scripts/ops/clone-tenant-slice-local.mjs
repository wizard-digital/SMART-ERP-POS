#!/usr/bin/env node
/**
 * Build a LOCAL rehearsal copy of ONE tenant's accounting slice (READ-ONLY on production).
 *
 *   production (read-only): docker exec samplepos-postgres pg_dump -Fc --data-only -t <accounting tables> <tenant db>
 *   local: new database <name> = CREATE DATABASE ... TEMPLATE sp_template_local, seeded accounts replaced by the tenant's.
 *
 * Only the tables needed to rehearse ledger/tender/bank/outbox corrections are pulled (no users, no product catalog,
 * no customer master). The dump lands in %TEMP%/tenant-slices (sensitive: delete after the rehearsal).
 *
 *   node scripts/ops/clone-tenant-slice-local.mjs --db pos_tenant_henber_pharmacy --name rehearsal_henber [--refresh]
 */
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const SRC = opt('--db');
const NAME = opt('--name');
const HOST = opt('--host', process.env.OPS_HOST_IP || '209.38.203.138');
const REFRESH = args.includes('--refresh');
const ADMIN_URL = process.env.LOCAL_PG_URL || 'postgresql://postgres:password@localhost:5432/postgres';
const PGBIN = process.env.LOCAL_PG_BIN || 'C:\\Program Files\\PostgreSQL\\16\\bin';
if (!/^[a-z0-9_]+$/.test(SRC ?? '') || !/^rehearsal_[a-z0-9_]+$/.test(NAME ?? '')) { console.error('need --db <src> and --name rehearsal_<x>'); process.exit(2); }
if (!/localhost|127\.0\.0\.1/.test(ADMIN_URL)) { console.error('Refusing: LOCAL_PG_URL must be local'); process.exit(2); }

const TABLES = ['accounts', 'financial_periods', 'sales', 'payment_lines', 'ledger_transactions', 'ledger_entries',
  'bank_accounts', 'bank_categories', 'bank_transactions', 'gl_period_balances', 'gl_projection_events'];
const dir = join(tmpdir(), 'tenant-slices');
mkdirSync(dir, { recursive: true });
const dump = join(dir, `${SRC}.dump`);
const exe = (n) => join(PGBIN, `${n}.exe`);

if (REFRESH || !existsSync(dump) || statSync(dump).size < 10_000) {
  console.log(`dumping ${SRC} slice from ${HOST} (read-only) ...`);
  const t = TABLES.map((x) => `-t public.${x}`).join(' ');
  await new Promise((resolve, reject) => {
    const ssh = spawn('ssh', ['-o', 'ConnectTimeout=25', '-o', 'ServerAliveInterval=15', `root@${HOST}`, `docker exec samplepos-postgres pg_dump -U postgres -Fc --data-only --no-owner --no-privileges ${t} ${SRC}`], { stdio: ['ignore', 'pipe', 'inherit'] });
    ssh.stdout.pipe(createWriteStream(dump));
    ssh.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`ssh pg_dump exit ${c}`))));
  });
}
console.log(`dump: ${dump} ${statSync(dump).size} bytes`);

const admin = new pg.Client({ connectionString: ADMIN_URL });
await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`);
await admin.query(`CREATE DATABASE ${NAME} TEMPLATE sp_template_local`);
await admin.end();
const u = new URL(ADMIN_URL);
const url = ADMIN_URL.replace(/\/[^/]*$/, `/${NAME}`);
const c = new pg.Client({ connectionString: url });
await c.connect();
await c.query(`TRUNCATE ${TABLES.join(', ')} CASCADE`); // drop template seed; tenant data replaces it
// SCHEMA DRIFT (evidence 2026-10-28): pos_template has CHECK chk_posted_requires_idempotency on ledger_transactions,
// but the live Henber/Blis databases do not (and Henber holds POSTED rows with NULL IdempotencyKey). Mirror the tenant.
await c.query(`ALTER TABLE ledger_transactions DROP CONSTRAINT IF EXISTS chk_posted_requires_idempotency`);
await c.end();
const r = spawnSync(exe('pg_restore'), ['-h', u.hostname, '-p', u.port || '5432', '-U', decodeURIComponent(u.username), '-d', NAME, '--data-only', '--disable-triggers', '--no-owner', dump], { encoding: 'utf8', env: { ...process.env, PGPASSWORD: decodeURIComponent(u.password) }, maxBuffer: 64 * 1024 * 1024 });
console.log(`pg_restore exit ${r.status}`);
if (r.stderr) console.log(r.stderr.split('\n').slice(0, 10).join('\n'));
const c2 = new pg.Client({ connectionString: url });
await c2.connect();
for (const t of TABLES) console.log(t, (await c2.query(`SELECT count(*)::int n FROM ${t}`)).rows[0].n);
await c2.end();
console.log(`local rehearsal DB: ${url.replace(/:[^:@]*@/, ':***@')}`);
process.exit(r.status === 0 ? 0 : 1);
