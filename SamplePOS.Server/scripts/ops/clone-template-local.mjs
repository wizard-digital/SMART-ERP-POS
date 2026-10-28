#!/usr/bin/env node
/**
 * Build (or refresh) a LOCAL, read-only-sourced clone of the production `pos_template` database for real-Postgres tests.
 *
 *   production (READ-ONLY):  ssh root@HOST  docker exec samplepos-postgres pg_dump -U postgres -Fc pos_template   -> %TEMP%/sp_template.dump
 *   local:                   pg_restore into database `sp_template_local` on the local Postgres (never a pos_* name)
 *
 * Tests then do   CREATE DATABASE scratch TEMPLATE sp_template_local   (fast, isolated, disposable).
 * pos_template holds schema + reference seed (chart of accounts, governance flags, settings) and NO tenant data.
 *
 *   node scripts/ops/clone-template-local.mjs [--host 209.38.203.138] [--refresh]
 * Env: LOCAL_PG_URL (default postgresql://postgres:password@localhost:5432/postgres), LOCAL_PG_BIN
 */
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';

const args = process.argv.slice(2);
const HOST = args.includes('--host') ? args[args.indexOf('--host') + 1] : process.env.OPS_HOST_IP || '209.38.203.138';
const REFRESH = args.includes('--refresh');
const ADMIN_URL = process.env.LOCAL_PG_URL || 'postgresql://postgres:password@localhost:5432/postgres';
const PGBIN = process.env.LOCAL_PG_BIN || 'C:\\Program Files\\PostgreSQL\\16\\bin';
const DUMP = join(tmpdir(), 'sp_template.dump');
const LOCAL_DB = 'sp_template_local';
if (!/localhost|127\.0\.0\.1/.test(ADMIN_URL)) { console.error('Refusing: LOCAL_PG_URL must be local'); process.exit(2); }
const exe = (n) => join(PGBIN, existsSync(join(PGBIN, `${n}.exe`)) ? `${n}.exe` : n);

if (REFRESH || !existsSync(DUMP) || statSync(DUMP).size < 1_000_000) {
  console.log(`dumping pos_template from ${HOST} (read-only) ...`);
  await new Promise((resolve, reject) => {
    const ssh = spawn('ssh', ['-o', 'ConnectTimeout=25', `root@${HOST}`, 'docker exec samplepos-postgres pg_dump -U postgres -Fc --no-owner --no-privileges pos_template'], { stdio: ['ignore', 'pipe', 'inherit'] });
    ssh.stdout.pipe(createWriteStream(DUMP));
    ssh.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`ssh pg_dump exit ${c}`))));
  });
}
console.log(`dump: ${DUMP} ${statSync(DUMP).size} bytes`);

const admin = new pg.Client({ connectionString: ADMIN_URL });
await admin.connect();
const exists = (await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [LOCAL_DB])).rowCount > 0;
if (exists && !REFRESH) {
  console.log(`${LOCAL_DB} already exists (use --refresh to rebuild)`);
  await admin.end();
  process.exit(0);
}
if (exists) await admin.query(`DROP DATABASE ${LOCAL_DB} WITH (FORCE)`);
await admin.query(`CREATE DATABASE ${LOCAL_DB}`);
await admin.end();
const u = new URL(ADMIN_URL);
const r = spawnSync(exe('pg_restore'), ['-h', u.hostname, '-p', u.port || '5432', '-U', decodeURIComponent(u.username), '-d', LOCAL_DB, '--no-owner', '--no-privileges', DUMP], { encoding: 'utf8', env: { ...process.env, PGPASSWORD: decodeURIComponent(u.password) } });
console.log(`pg_restore exit ${r.status}`);
if (r.stderr) console.log(r.stderr.split('\n').slice(0, 8).join('\n'));
process.exit(r.status === 0 || /already exists|ignored/.test(r.stderr ?? '') ? 0 : 1);
