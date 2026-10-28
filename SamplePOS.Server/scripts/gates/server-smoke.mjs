/**
 * Gate 5 — real server startup smoke (LOCAL ONLY).
 *   - scratch Postgres DB cloned from the template schema (read-only pg_dump over ssh, same as migration-scratch.mjs)
 *   - local redis-server WITH requirepass
 *   - the real `src/server.ts` started via tsx
 * Asserts: /health + /api/health/ready respond, every Bull queue connects with auth (zero ACL denials),
 * the banking + notification workers register, and a planted job pushed into Redis is rejected by the REAL
 * running banking worker (not a unit double). Production is never written to.
 *
 * Usage: node scripts/gates/server-smoke.mjs [--host 209.38.203.138] [--out ../PROOF_GATE5_SERVER_SMOKE.json]
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import Redis from 'ioredis';
import Bull from 'bull';
import { Evidence, registerSecret } from './lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(here, '../..');
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const HOST = opt('--host', '209.38.203.138');
const OUT = opt('--out', '../PROOF_GATE5_SERVER_SMOKE.json');
const ADMIN_URL = process.env.LOCAL_PG_URL || 'postgresql://postgres:password@localhost:5432/postgres';
const REDIS_BIN = process.env.REDIS_SERVER_BIN || path.join(tmpdir(), 'gates-redis', 'x', 'Redis-8.10.3-Windows-x64-msys2', 'redis-server.exe');
const REDIS_PW = `smoke-${Math.random().toString(36).slice(2)}-pw`;
registerSecret(REDIS_PW);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

const ev = new Evidence('Gate 5 — real server startup smoke (local)');
const meta = { commands: [] };
if (!/localhost|127\.0\.0\.1/.test(ADMIN_URL)) { console.error('Refusing: LOCAL_PG_URL must be local'); process.exit(2); }
if (!existsSync(REDIS_BIN)) { ev.notExecuted({ gate: 'G5', id: 'G5.smoke.all', description: 'Server startup smoke', reason: `redis-server binary not found at ${REDIS_BIN}` }); ev.write(OUT, { meta }); process.exit(1); }

const dbName = `gate5_smoke_${Date.now()}`;
const scratchUrl = ADMIN_URL.replace(/\/[^/]*$/, `/${dbName}`);
let server = null; let redisProc = null; const logs = [];
const admin = new pg.Client({ connectionString: ADMIN_URL });
let rc = 0;
try {
  // 1) template clone (read-only dump)
  const remote = `PG=$(docker ps --format '{{.Names}}' | grep -i postgres | head -1)\necho "@@SCHEMA"; docker exec "$PG" pg_dump -U postgres --schema-only --no-owner --no-privileges pos_template\necho "@@DATA"; docker exec "$PG" pg_dump -U postgres --data-only --inserts --no-owner --no-privileges -t schema_migrations pos_template\necho "@@END"\n`;
  const d = spawnSync('ssh', ['-o', 'ConnectTimeout=25', `root@${HOST}`, 'sh -s'], { input: remote, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const text = d.stdout ?? '';
  const schema = text.slice(text.indexOf('@@SCHEMA') + 8, text.indexOf('@@DATA'));
  const data = text.slice(text.indexOf('@@DATA') + 6, text.indexOf('@@END'));
  await admin.connect(); await admin.query(`CREATE DATABASE ${dbName}`);
  const c = new pg.Client({ connectionString: scratchUrl }); c.on('error', () => undefined); await c.connect();
  await c.query(schema.replace(/^\\(un)?restrict.*$/gm, '')); await c.query(data.replace(/^\\(un)?restrict.*$/gm, '')); await c.end();
  meta.commands.push({ cmd: 'pg_dump template (read-only) -> local scratch DB', exitCode: d.status, scratchDb: dbName });

  // 2) redis with auth
  const rport = await freePort();
  const rdir = mkdtempSync(path.join(tmpdir(), 'smoke-redis-'));
  redisProc = spawn(REDIS_BIN, ['--port', String(rport), '--bind', '127.0.0.1', '--requirepass', REDIS_PW, '--dir', rdir.replace(/\\/g, '/'), '--appendonly', 'no', '--save', ''], { stdio: 'ignore', windowsHide: true });
  const rurl = `redis://:${REDIS_PW}@127.0.0.1:${rport}`;
  for (let i = 0; i < 60; i++) { try { const t = new Redis(rurl, { retryStrategy: () => null, maxRetriesPerRequest: 1 }); await t.ping(); t.disconnect(); break; } catch { await sleep(250); } }

  // 3) real server
  const port = await freePort();
  const env = { ...process.env, NODE_ENV: 'development', PORT: String(port), DATABASE_URL: scratchUrl, JWT_SECRET: 'smoke-test-jwt-secret-0123456789abcdef0123456789abcdef', REDIS_URL: rurl, REDIS_HOST: '127.0.0.1', REDIS_PORT: String(rport), REDIS_PASSWORD: REDIS_PW, LOG_LEVEL: 'info' };
  server = spawn(process.execPath, [path.join(serverDir, 'node_modules/tsx/dist/cli.mjs'), 'src/server.ts'], { cwd: serverDir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const onData = (b) => { for (const l of String(b).split(/\r?\n/)) if (l.trim()) logs.push(l); };
  server.stdout.on('data', onData); server.stderr.on('data', onData);
  let exited = null; server.on('exit', (code) => { exited = code; });
  meta.commands.push({ cmd: 'tsx src/server.ts (scratch DB + authenticated redis)', port });
  const has = (re) => logs.some((l) => re.test(l));

  let healthStatus = null;
  for (let i = 0; i < 240 && exited === null; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/health`); healthStatus = r.status; if (r.status === 200) break; } catch { /* not up yet */ }
    await sleep(500);
  }
  await ev.check({ gate: 'G5', id: 'G5.smoke.startup', description: 'Real server process starts and /health returns 200', expected: '200', evidence: 'GET /health' },
    async () => ({ observed: { healthStatus, exited, logTail: logs.slice(-6) }, pass: healthStatus === 200 }));
  if (healthStatus === 200) {
    const ready = await fetch(`http://127.0.0.1:${port}/api/health/ready`).then((r) => r.status).catch(() => null);
    const live = await fetch(`http://127.0.0.1:${port}/api/health/live`).then((r) => r.status).catch(() => null);
    await ev.check({ gate: 'G5', id: 'G5.smoke.healthEndpoints', severity: 'WARN', description: '/api/health/live and /ready respond 200', expected: '200/200', evidence: 'GET /api/health/*' }, async () => ({ observed: { ready, live }, pass: ready === 200 && live === 200 }));
    for (let i = 0; i < 40 && !(has(/Banking retry worker registered/) && has(/Notification worker registered/)); i++) await sleep(500);
    await ev.check({ gate: 'G5', id: 'G5.smoke.workersRegistered', description: 'Banking retry worker (new bankingRetryWorker module) and notification worker register at startup', expected: 'both log lines present', evidence: 'server log' },
      async () => ({ observed: { banking: has(/Banking retry worker registered/), notifications: has(/Notification worker registered/), warns: logs.filter((l) => /not started/i.test(l)).slice(0, 3) }, pass: has(/Banking retry worker registered/) && has(/Notification worker registered/) }));

    const adminR = new Redis(rurl, { retryStrategy: () => null });
    const stats = Object.fromEntries((await adminR.info('stats')).split(/\r?\n/).filter((l) => l.includes(':')).map((l) => l.split(':')));
    const clients = Object.fromEntries((await adminR.info('clients')).split(/\r?\n/).filter((l) => l.includes(':')).map((l) => l.split(':')));
    await ev.check({ gate: 'G5', id: 'G5.smoke.redisAuth', description: 'Every queue/cache connection of the real server authenticates (zero ACL denials, >= 8 clients)', expected: 'acl_access_denied_auth=0', evidence: 'redis INFO' },
      async () => ({ observed: { aclDeniedAuth: Number(stats.acl_access_denied_auth), connectedClients: Number(clients.connected_clients) }, pass: Number(stats.acl_access_denied_auth) === 0 && Number(clients.connected_clients) >= 8 }));

    // 4) planted job through the REAL worker
    const q = new Bull('banking', rurl);
    const planted = await q.add({ type: 'planted', payload: { saleId: "1'; DROP TABLE sales;--", payments: [{ amount: -1, paymentMethod: 'EVIL' }] } }, { attempts: 3, backoff: 100, removeOnFail: 100 });
    for (let i = 0; i < 40 && !has(/rejected invalid job payload/); i++) await sleep(250);
    const failedN = await q.getFailedCount();
    await ev.check({ gate: 'G5', id: 'G5.smoke.plantedJobRejected', description: 'A planted job in Redis is rejected by the REAL running banking worker and retained in the failed set (no DB write)', expected: 'rejected log line + failed=1', evidence: 'server log + bull:banking:failed' },
      async () => ({ observed: { rejectedLogged: has(/rejected invalid job payload/), failed: failedN, jobId: planted.id }, pass: has(/rejected invalid job payload/) && failedN === 1 }));
    await q.close(); adminR.disconnect();
  }
} catch (e) {
  rc = 1; console.error('SMOKE ERROR:', e?.stack ?? e);
  ev.notExecuted({ gate: 'G5', id: 'G5.smoke.error', description: 'Smoke harness aborted', reason: String(e?.message ?? e).slice(0, 300) });
} finally {
  if (server) { spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' }); }
  if (redisProc) { try { redisProc.kill('SIGKILL'); } catch { /* gone */ } }
  await sleep(1000);
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch((e) => console.error('drop failed', e.message));
  await admin.end().catch(() => undefined);
}
meta.serverLogTail = logs.slice(-25);
const res = ev.write(OUT, { meta });
console.log('SUMMARY', JSON.stringify(res.summary), 'sha256', res.sha256);
process.exit(rc || (res.summary.failBlocker > 0 ? 1 : 0));
