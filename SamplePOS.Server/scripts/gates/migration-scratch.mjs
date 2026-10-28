/**
 * Gate 5 — migrations against a CLONE of the real template schema, in a LOCAL scratch database.
 *
 * Why a clone and not "from empty": the migrator is incremental (migration 001 needs `products`), and every
 * production tenant DB is cloned from `pos_template`. So the meaningful, supported check is:
 *   template schema + its schema_migrations rows  ->  the repo's migrator must find NOTHING pending, and a
 *   second pass must also apply nothing (idempotent).
 *
 * Production access is READ-ONLY: `pg_dump --schema-only` (+ schema_migrations rows) over ssh. Nothing is
 * ever written to production; the scratch DB lives on the LOCAL Postgres and is dropped at the end.
 *
 * Usage: node scripts/gates/migration-scratch.mjs [--host 209.38.203.138] [--source-db pos_template]
 *            [--out ../PROOF_GATE5_MIGRATIONS.json]
 * Env:   LOCAL_PG_URL (default postgresql://postgres:password@localhost:5432/postgres)
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { Evidence } from './lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const HOST = opt('--host', '209.38.203.138');
const SRC_DB = opt('--source-db', 'pos_template');
const OUT = opt('--out', '../PROOF_GATE5_MIGRATIONS.json');
const ADMIN_URL = process.env.LOCAL_PG_URL || 'postgresql://postgres:password@localhost:5432/postgres';
if (!/localhost|127\.0\.0\.1/.test(ADMIN_URL)) { console.error('Refusing: LOCAL_PG_URL must be local'); process.exit(2); }
if (!/^[a-z0-9_]+$/.test(SRC_DB)) { console.error('bad --source-db'); process.exit(2); }
const dbName = `gate5_mig_${Date.now()}`;
const scratchUrl = ADMIN_URL.replace(/\/[^/]*$/, `/${dbName}`);

const ev = new Evidence('Gate 5 — migrations vs a clone of the template schema (local scratch DB)');
const meta = { scratchDb: dbName, sourceDb: SRC_DB, commands: [] };

// 1) read-only dump from the host (schema + schema_migrations rows)
const remote = `
PG=$(docker ps --format '{{.Names}}' | grep -i postgres | head -1)
echo "@@SCHEMA"; docker exec "$PG" pg_dump -U postgres --schema-only --no-owner --no-privileges ${SRC_DB}
echo "@@DATA"; docker exec "$PG" pg_dump -U postgres --data-only --inserts --no-owner --no-privileges -t schema_migrations ${SRC_DB}
echo "@@END"
`;
const t0 = Date.now();
const d = spawnSync('ssh', ['-o', 'ConnectTimeout=25', `root@${HOST}`, 'sh -s'], { input: remote, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
const text = d.stdout ?? '';
const schema = text.slice(text.indexOf('@@SCHEMA') + 8, text.indexOf('@@DATA'));
const data = text.slice(text.indexOf('@@DATA') + 6, text.indexOf('@@END'));
meta.commands.push({ cmd: `ssh root@${HOST}: docker exec pg_dump --schema-only ${SRC_DB} (+ schema_migrations rows) [READ-ONLY]`, exitCode: d.status, ms: Date.now() - t0, schemaBytes: schema.length, dataBytes: data.length });
await ev.check({ gate: 'G5', id: 'G5.migrate.dump', description: `Read-only schema dump of ${SRC_DB} obtained`, expected: 'schema > 100KB and CREATE TABLE present', evidence: 'pg_dump --schema-only' },
  async () => ({ observed: { exit: d.status, schemaBytes: schema.length, dataBytes: data.length }, pass: d.status === 0 && schema.length > 100_000 && /CREATE TABLE/.test(schema) && /INSERT INTO public\.schema_migrations/.test(data) }));

if (ev.results.some((r) => r.status !== 'PASS')) { const r0 = ev.write(OUT, { meta }); console.log('SUMMARY', JSON.stringify(r0.summary)); process.exit(1); }

const admin = new pg.Client({ connectionString: ADMIN_URL });
await admin.connect();
await admin.query(`CREATE DATABASE ${dbName}`);
try {
  const c = new pg.Client({ connectionString: scratchUrl });
  c.on('error', () => undefined);
  await c.connect();
  let loadErr = null;
  try {
    await c.query(schema.replace(/^\\(un)?restrict.*$/gm, ''));
    await c.query(data.replace(/^\\(un)?restrict.*$/gm, ''));
  } catch (e) { loadErr = e.message; }
  await ev.check({ gate: 'G5', id: 'G5.migrate.clone', description: 'Template schema + schema_migrations rows load into a local scratch DB', expected: 'no error', evidence: 'psql-equivalent load via node-pg' },
    async () => ({ observed: loadErr ?? 'loaded', pass: loadErr === null }));
  const recorded = loadErr ? null : Number((await c.query('SELECT count(*)::int n FROM public.schema_migrations')).rows[0].n);
  await c.end();

  if (!loadErr) {
    const migrate = path.resolve(here, '../../../shared/sql/migrate.mjs');
    const run = (extra = []) => spawnSync(process.execPath, [migrate, ...extra], { cwd: path.dirname(migrate), env: { ...process.env, DATABASE_URL: scratchUrl }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const tailOf = (r) => `${r.stdout ?? ''}${r.stderr ?? ''}`.split('\n').filter(Boolean).slice(-8).join('\n');
    const dry = run(['--dry-run']);
    const dryOut = `${dry.stdout ?? ''}${dry.stderr ?? ''}`;
    meta.commands.push({ cmd: 'node shared/sql/migrate.mjs --dry-run (scratch)', exitCode: dry.status, tail: tailOf(dry) });
    const pending = Number(dryOut.match(/(\d+) pending migration/)?.[1] ?? (/up to date|no pending/i.test(dryOut) ? 0 : NaN));
    await ev.check({ gate: 'G5', id: 'G5.migrate.nothingPending', description: 'Repo migrations vs template: no pending migrations (repo and template are in lockstep)', expected: '0 pending', evidence: 'migrate.mjs --dry-run' },
      async () => ({ observed: { recordedInTemplate: recorded, pending, tail: tailOf(dry) }, pass: dry.status === 0 && pending === 0 }));
    const p1 = run(); const p2 = run();
    meta.commands.push({ cmd: 'node shared/sql/migrate.mjs x2 (scratch)', exit: [p1.status, p2.status] });
    await ev.check({ gate: 'G5', id: 'G5.migrate.idempotent', description: 'Running the migrator twice applies nothing and exits 0', expected: 'exit 0 / exit 0, "0 applied"', evidence: 'migrate.mjs x2' },
      async () => ({ observed: { pass1: tailOf(p1), pass2: tailOf(p2) }, pass: p1.status === 0 && p2.status === 0 && !/[1-9]\d* applied/.test(`${p1.stdout}${p2.stdout}`) }));
    const c2 = new pg.Client({ connectionString: scratchUrl }); await c2.connect();
    try {
      const need = ['sales', 'ledger_transactions', 'ledger_entries', 'bank_transactions', 'gl_projection_events', 'gl_period_balances', 'payment_lines'];
      const have = (await c2.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1)`, [need])).rows.map((x) => x.table_name);
      await ev.check({ gate: 'G5', id: 'G5.migrate.coreTables', description: 'Core accounting/sales tables exist', expected: need.join(','), evidence: 'information_schema.tables' },
        async () => ({ observed: have, pass: need.every((t) => have.includes(t)) }));
      const uq = (await c2.query(`SELECT indexname FROM pg_indexes WHERE tablename='bank_transactions' AND indexname LIKE 'uq_bank_txn_sale%'`)).rows;
      await ev.check({ gate: 'G5', id: 'G5.migrate.bankIdempotencyIndex', description: 'Bank-mirror idempotency unique index (migration 626) exists', expected: '>=1 uq_bank_txn_sale* index', evidence: 'pg_indexes' },
        async () => ({ observed: uq, pass: uq.length >= 1 }));
      const code = Number(readFileSync(path.resolve(here, '../../src/constants/schemaVersion.ts'), 'utf8').match(/CURRENT_SCHEMA_VERSION\s*=\s*(\d+)/)?.[1]);
      const hi = (await c2.query(`SELECT max((regexp_match(filename, '^(\\d+)'))[1]::int) v FROM public.schema_migrations WHERE filename ~ '^\\d{1,4}_'`)).rows[0].v;
      // INFO only: file numbers include a catch-all 999_* and date-prefixed files, so they do not map 1:1 to the
      // code constant (src/modules/system/migrationAnchors.ts owns that mapping).
      ev.info({ gate: 'G5', id: 'G5.migrate.schemaVersion', description: 'Recorded sequence-numbered migrations vs CURRENT_SCHEMA_VERSION constant (informational)', evidence: 'schema_migrations vs src/constants/schemaVersion.ts', observed: { highestSequenceFile: hi, codeConstant: code } });
    } finally { await c2.end(); }
  }
} catch (e) {
  console.error('SCRIPT ERROR:', e?.stack ?? e);
  process.exitCode = 1;
} finally {
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch((e) => console.error('drop failed', e.message));
  await admin.end().catch(() => undefined);
}
const res = ev.write(OUT, { meta });
console.log('SUMMARY', JSON.stringify(res.summary), 'sha256', res.sha256);
process.exit(res.summary.failBlocker > 0 ? 1 : 0);
