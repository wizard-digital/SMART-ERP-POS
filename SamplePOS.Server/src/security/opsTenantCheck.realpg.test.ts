/**
 * The inline `node -e` programs inside ops/security/*.sh run in production inside the backend container.
 * This executes the EXACT program text (extracted from the scripts) against a real local PostgreSQL:
 *   T1 tenant_check: every ACTIVE tenant authenticates and is reported OK; exit 0
 *   T2 tenant_check: a registry row pointing to a missing database => FAIL line and exit code 1 (never a silent pass)
 *   T3 old_pg_rejected: wrong password => "password authentication failed" and exit 0 (the assertion that rotation worked)
 *      (skipped when the local server uses `trust` auth, because then no password is ever checked)
 * Only substitution: the master database name "pos_system" -> the scratch master DB.
 */
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';

const OPS = join(resolve(process.cwd(), '..'), 'ops', 'security');
const ADMIN = process.env.LOCAL_PG_ADMIN_URL || 'postgresql://postgres:password@localhost:5432/postgres';
const MASTER = 'ops_tc_master', T1 = 'ops_tc_t1', T2 = 'ops_tc_t2';

function extractNodeProgram(file: string, fn: string): string {
  const body = readFileSync(join(OPS, file), 'utf8');
  const start = body.indexOf(`${fn}() {`);
  const rest = body.slice(start);
  const m = /node -e '([\s\S]*?)'(?:\n|\s*\|\|)/.exec(rest);
  if (!m) throw new Error(`no node -e program in ${file}:${fn}`);
  return m[1];
}
const run = (program: string, env: Record<string, string>) =>
  spawnSync(process.execPath, ['-e', program.replace(/"pos_system"/g, `"${MASTER}"`)], { encoding: 'utf8', cwd: process.cwd(), env: { ...process.env, ...env } });

let admin: pg.Client; let reachable = false; let enforcesPassword = false;
const u = new URL(ADMIN);
const baseEnv = () => ({ DB_HOST: u.hostname, DB_PORT: u.port || '5432', DB_USER: decodeURIComponent(u.username), DB_PASSWORD: decodeURIComponent(u.password), OLDPW: 'definitely-not-the-password' });

const PGBIN = process.env.LOCAL_PG_BIN || 'C:\\Program Files\\PostgreSQL\\16\\bin';
const havePgBin = existsSync(join(PGBIN, 'initdb.exe')) || existsSync(join(PGBIN, 'initdb'));
const exe = (n: string) => join(PGBIN, existsSync(join(PGBIN, `${n}.exe`)) ? `${n}.exe` : n);

(havePgBin ? describe : describe.skip)('ops rotation logic against a scram-sha-256 cluster (real password enforcement)', () => {
  let dir: string, port: number;
  const pw = { old: 'old-secret-value-1', next: 'new-secret-value-2' };
  const env = (password: string) => ({ DB_HOST: '127.0.0.1', DB_PORT: String(port), DB_USER: 'postgres', DB_PASSWORD: password, OLDPW: pw.old });
  const psql = (password: string, db: string, sql: string, stdin = false) =>
    spawnSync(exe('psql'), ['-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', db, '-v', 'ON_ERROR_STOP=1', '-q', ...(stdin ? ['-f', '-'] : ['-c', sql])], { encoding: 'utf8', input: stdin ? sql : undefined, env: { ...process.env, PGPASSWORD: password } });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ops-scram-'));
    writeFileSync(join(dir, 'pw'), pw.old);
    const s = net.createServer(); await new Promise<void>((r) => s.listen(0, '127.0.0.1', r)); port = (s.address() as net.AddressInfo).port; await new Promise((r) => s.close(r));
    const i = spawnSync(exe('initdb'), ['-D', join(dir, 'data'), '-U', 'postgres', '-E', 'UTF8', '--auth=scram-sha-256', `--pwfile=${join(dir, 'pw')}`], { encoding: 'utf8' });
    if (i.status !== 0) throw new Error(`initdb failed: ${i.stderr}`);
    // stdio MUST be 'ignore': the postmaster inherits pipes and spawnSync would wait on them forever (Windows)
    const st = spawnSync(exe('pg_ctl'), ['-D', join(dir, 'data'), '-o', `-p ${port} -c listen_addresses=127.0.0.1`, '-w', '-l', join(dir, 'log'), 'start'], { stdio: 'ignore', timeout: 60000 });
    if (st.status !== 0) throw new Error(`pg_ctl start failed (status ${st.status})`);
    for (const d of [MASTER, T1, T2]) expect(psql(pw.old, 'postgres', `CREATE DATABASE ${d}`).status).toBe(0);
    expect(psql(pw.old, MASTER, `CREATE TABLE tenants(slug text, database_name text, status text); INSERT INTO tenants VALUES ('t1','${T1}','ACTIVE'),('t2','${T2}','ACTIVE')`, true).status).toBe(0);
  }, 120000);
  afterAll(() => {
    if (!dir) return;
    spawnSync(exe('pg_ctl'), ['-D', join(dir, 'data'), '-m', 'immediate', 'stop'], { stdio: 'ignore', timeout: 30000 });
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('R1 before rotation: tenant_check OK with the old password; old_pg_rejected correctly reports "still accepted" (exit != 0)', () => {
    expect(run(extractNodeProgram('30-postgres-loopback.sh', 'tenant_check'), env(pw.old)).status).toBe(0);
    const r = run(extractNodeProgram('40-rotate-credentials.sh', 'old_pg_rejected'), env(pw.old));
    expect(r.stdout).toMatch(/OLD PASSWORD STILL ACCEPTED/); expect(r.status).toBe(1);
  });

  it('R2 rotate exactly as the script does (ALTER ROLE via stdin): new password OK, old rejected, stale-credential backend detected', () => {
    const alter = psql(pw.old, 'postgres', `ALTER ROLE postgres WITH PASSWORD '${pw.next}';\n`, true);
    expect(alter.status).toBe(0);
    const ok = run(extractNodeProgram('40-rotate-credentials.sh', 'tenant_check'), env(pw.next));
    expect(ok.status).toBe(0); expect(ok.stdout).toMatch(/OK\s+t1/); expect(ok.stdout).toMatch(/OK\s+t2/);
    const rej = run(extractNodeProgram('40-rotate-credentials.sh', 'old_pg_rejected'), env(pw.next));
    expect(rej.stdout).toMatch(/old password rejected: .*password authentication failed/); expect(rej.status).toBe(0);
    const stale = run(extractNodeProgram('40-rotate-credentials.sh', 'tenant_check'), env(pw.old));      // a backend that kept the old env
    expect(stale.status).toBe(1); expect(stale.stdout).toMatch(/FAIL/);
  }, 60000);

  it('R3 rollback ALTER ROLE restores the old password', () => {
    expect(psql(pw.next, 'postgres', `ALTER ROLE postgres WITH PASSWORD '${pw.old}';\n`, true).status).toBe(0);
    expect(run(extractNodeProgram('30-postgres-loopback.sh', 'tenant_check'), env(pw.old)).status).toBe(0);
  }, 60000);
});

describe('ops scripts: embedded node programs against real Postgres', () => {
  beforeAll(async () => {
    admin = new pg.Client({ connectionString: ADMIN });
    try { await admin.connect(); reachable = true; } catch { console.error('[OPS TENANT CHECK SKIPPED] local postgres not reachable'); return; }
    for (const d of [MASTER, T1, T2]) { await admin.query(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`); await admin.query(`CREATE DATABASE ${d}`); }
    const m = new pg.Client({ connectionString: ADMIN.replace(/\/[^/]*$/, `/${MASTER}`) }); await m.connect();
    await m.query(`CREATE TABLE tenants(slug text, database_name text, status text)`);
    await m.query(`INSERT INTO tenants VALUES ('t1','${T1}','ACTIVE'),('t2','${T2}','ACTIVE'),('gone','ops_tc_inactive','SUSPENDED')`);
    await m.end();
    const bad = spawnSync(process.execPath, ['-e', `const {Client}=require("pg");const c=new Client({host:"${u.hostname}",port:${u.port || 5432},user:"${decodeURIComponent(u.username)}",password:"wrong",database:"postgres"});c.connect().then(()=>{console.log("accepted");process.exit(0)}).catch(()=>{console.log("rejected");process.exit(0)})`], { encoding: 'utf8' });
    enforcesPassword = bad.stdout.trim() === 'rejected';
  });
  afterAll(async () => {
    if (!reachable) return;
    for (const d of [MASTER, T1, T2]) await admin.query(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`).catch(() => undefined);
    await admin.end();
  });

  it('T1 tenant_check: all ACTIVE tenants OK, SUSPENDED ignored, exit 0', () => {
    if (!reachable) return;
    const prog = extractNodeProgram('30-postgres-loopback.sh', 'tenant_check');
    const r = run(prog, baseEnv());
    expect(r.stdout).toMatch(/OK\s+t1 ops_tc_t1/); expect(r.stdout).toMatch(/OK\s+t2 ops_tc_t2/);
    expect(r.stdout).not.toMatch(/gone/);
    expect(r.status).toBe(0);
  });

  it('T2 tenant_check: a missing tenant database is reported FAIL and the exit code is 1', async () => {
    if (!reachable) return;
    const m = new pg.Client({ connectionString: ADMIN.replace(/\/[^/]*$/, `/${MASTER}`) }); await m.connect();
    await m.query(`INSERT INTO tenants VALUES ('broken','ops_tc_missing','ACTIVE')`); await m.end();
    const r = run(extractNodeProgram('40-rotate-credentials.sh', 'tenant_check'), baseEnv());
    expect(r.stdout).toMatch(/FAIL\s+broken/); expect(r.stdout).toMatch(/OK\s+t1/);
    expect(r.status).toBe(1);
  });

  it('T3 old_pg_rejected: wrong password => rejected message and exit 0', () => {
    if (!reachable) return;
    if (!enforcesPassword) { console.error('[T3 SKIPPED] local Postgres is trust-auth: password rejection cannot be observed here'); return; }
    const r = run(extractNodeProgram('40-rotate-credentials.sh', 'old_pg_rejected'), baseEnv());
    expect(r.stdout).toMatch(/old password rejected: .*password authentication failed/);
    expect(r.status).toBe(0);
  });
});
