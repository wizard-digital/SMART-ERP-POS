/**
 * C1 rehearsal (LOCAL copy only): stuck gl_projection_events + orphan gl_period_balances rows.
 *
 *   npx tsx scripts/ops/outbox-recovery-rehearsal.ts --db rehearsal_henber [--out ../PROOF_...json]
 *
 * Establishes, per stuck event, whether the derived balance already equals the ledger (APPLIED / superseded) or would
 * change (NOT_APPLIED), BEFORE anything is reset. Recovery is the worker's own absolute recompute (idempotent: replaying an
 * already-applied event cannot double count), then scripts/reconcile-period-balances.mjs --apply for the orphan rows.
 * Posted ledger rows are never touched; the ledger fingerprint is asserted identical before and after.
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import pg from 'pg';
import { pollAndProcessPendingEvents } from '../../src/services/periodBalanceWorker.js';

const a = process.argv.slice(2);
const opt = (n: string, d?: string) => (a.includes(n) ? a[a.indexOf(n) + 1] : d);
const db = opt('--db', 'rehearsal_henber')!;
const out = opt('--out', '../PROOF_HENBER_OUTBOX_PERIOD_RECOVERY_REHEARSAL.json')!;
if (!/^rehearsal_[a-z0-9_]+$/.test(db)) { console.error('local rehearsal databases only (rehearsal_*)'); process.exit(2); }
const pool = new pg.Pool({ connectionString: `postgresql://postgres:password@localhost:5432/${db}`, max: 3 });
const q = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows as T[];

const DERIVED = `SELECT le."AccountId" account_id,
  EXTRACT(YEAR FROM lt."TransactionDate" AT TIME ZONE 'UTC')::int y, EXTRACT(MONTH FROM lt."TransactionDate" AT TIME ZONE 'UTC')::int m,
  SUM(le."DebitAmount") d, SUM(le."CreditAmount") c
  FROM ledger_entries le JOIN ledger_transactions lt ON lt."Id"=le."TransactionId"
  WHERE lt."Status"='POSTED' AND lt."IsReversed"=FALSE
    AND lt."Id" NOT IN (SELECT "ReversedByTransactionId" FROM ledger_transactions WHERE "ReversedByTransactionId" IS NOT NULL)
  GROUP BY 1,2,3`;

const fingerprint = async () => (await q(`SELECT count(*)::int entries, COALESCE(sum("DebitAmount"),0)::text dr, COALESCE(sum("CreditAmount"),0)::text cr,
   (SELECT count(*)::int FROM ledger_transactions) txns,
   (SELECT md5(string_agg(le."Id"::text||le."AccountId"::text||le."DebitAmount"::text||le."CreditAmount"::text, ',' ORDER BY le."Id")) FROM ledger_entries le) md5 FROM ledger_entries`))[0];
const diffCount = async () => (await q<{ n: number }>(`WITH calc AS (${DERIVED}) SELECT count(*)::int n FROM gl_period_balances b FULL JOIN calc ON calc.account_id=b.account_id AND calc.y=b.fiscal_year AND calc.m=b.fiscal_period WHERE COALESCE(b.debit_total,0)<>COALESCE(calc.d,0) OR COALESCE(b.credit_total,0)<>COALESCE(calc.c,0)`))[0].n;
const histogram = async () => Object.fromEntries((await q<{ status: string; n: number }>(`SELECT status, count(*)::int n FROM gl_projection_events GROUP BY 1`)).map((r) => [r.status, r.n]));

const result: Record<string, unknown> = { database: db, generatedAt: new Date().toISOString(), note: 'LOCAL rehearsal copy; production untouched' };
const checks: Array<{ id: string; pass: boolean; observed?: unknown }> = [];
const chk = (id: string, pass: boolean, observed?: unknown) => checks.push({ id, pass, observed });

const fpBefore = await fingerprint();
const histBefore = await histogram();
const diffBefore = await diffCount();

// ---- per-event: was it applied? (stored derived balance vs ledger-derived for the event's own tuple) ----
const events = await q<Record<string, any>>(`
  WITH calc AS (${DERIVED})
  SELECT e.id, e.status, e.created_at::text created_at, a."AccountCode" code, e.fiscal_year y, e.fiscal_period m,
         lt."TransactionNumber" txn, lt."ReferenceType" ref_type, lt."Status" txn_status,
         b.debit_total::float8 stored_d, b.credit_total::float8 stored_c, calc.d::float8 ledger_d, calc.c::float8 ledger_c
    FROM gl_projection_events e
    JOIN accounts a ON a."Id"=e.account_id
    LEFT JOIN ledger_transactions lt ON lt."Id"=e.transaction_id
    LEFT JOIN gl_period_balances b ON b.account_id=e.account_id AND b.fiscal_year=e.fiscal_year AND b.fiscal_period=e.fiscal_period
    LEFT JOIN calc ON calc.account_id=e.account_id AND calc.y=e.fiscal_year AND calc.m=e.fiscal_period
   WHERE e.status='PROCESSING' ORDER BY e.created_at`);
const classified = events.map((e) => {
  const consistent = Math.abs((e.stored_d ?? 0) - (e.ledger_d ?? 0)) < 0.005 && Math.abs((e.stored_c ?? 0) - (e.ledger_c ?? 0)) < 0.005;
  return { eventId: e.id, account: e.code, period: `${e.y}-${String(e.m).padStart(2, '0')}`, txn: e.txn, refType: e.ref_type, txnStatus: e.txn_status,
    classification: consistent ? 'ALREADY_APPLIED_OR_SUPERSEDED' : 'NOT_APPLIED', stored: [e.stored_d, e.stored_c], ledger: [e.ledger_d, e.ledger_c] };
});
result.stuckEvents = { count: classified.length, byClassification: classified.reduce((m: Record<string, number>, c) => ((m[c.classification] = (m[c.classification] ?? 0) + 1), m), {}), rows: classified };

// ---- orphan/drift rows (what reconcile-period-balances would delete/fix) ----
const orphans = await q(`WITH calc AS (${DERIVED})
  SELECT a."AccountCode" code, b.fiscal_year y, b.fiscal_period m, b.debit_total::float8 d, b.credit_total::float8 c, b.last_updated::text last_updated,
         CASE WHEN calc.account_id IS NULL THEN 'ORPHAN' WHEN b.account_id IS NULL THEN 'MISSING' ELSE 'DRIFT' END kind
    FROM gl_period_balances b FULL JOIN calc ON calc.account_id=b.account_id AND calc.y=b.fiscal_year AND calc.m=b.fiscal_period
    JOIN accounts a ON a."Id"=COALESCE(b.account_id, calc.account_id)
   WHERE COALESCE(b.debit_total,0)<>COALESCE(calc.d,0) OR COALESCE(b.credit_total,0)<>COALESCE(calc.c,0)`);
result.differencesBefore = orphans;

// ---- recovery step 1: the worker's own absolute recompute drains the legacy PROCESSING rows ----
const cycles: unknown[] = [];
for (let i = 0; i < 20; i++) {
  const r = await pollAndProcessPendingEvents(pool);
  cycles.push(r);
  if (r.claimed === 0) break;
}
const histMid = await histogram();
const diffMid = await diffCount();

// ---- recovery step 2: orphan rows via the reconcile script (dry run, then apply, then re-verify) ----
const env = { ...process.env, PGHOST: 'localhost', PGPORT: '5432', PGUSER: 'postgres', PGPASSWORD: 'password' };
const dry = spawnSync('node', ['scripts/reconcile-period-balances.mjs', '--db', db, '--out', `${process.env.TEMP}/recon-${db}-dry.json`], { env, encoding: 'utf8' });
const app = spawnSync('node', ['scripts/reconcile-period-balances.mjs', '--db', db, '--apply', '--confirm-db', db, '--out', `${process.env.TEMP}/recon-${db}-apply.json`], { env, encoding: 'utf8' });
const diffAfter = await diffCount();
const histAfter = await histogram();
const fpAfter = await fingerprint();
const again = spawnSync('node', ['scripts/reconcile-period-balances.mjs', '--db', db, '--apply', '--confirm-db', db, '--out', `${process.env.TEMP}/recon-${db}-apply2.json`], { env, encoding: 'utf8' });

chk('before.stuck_processing_present', (histBefore.PROCESSING ?? 0) > 0, histBefore);
chk('worker.drained_all_processing', (histMid.PROCESSING ?? 0) === 0, histMid);
chk('worker.no_failed_events', (histAfter.FAILED ?? 0) === 0 && (histAfter.PENDING ?? 0) === 0, histAfter);
chk('reconcile.dry_run_exit0', dry.status === 0, dry.stdout.split('\n').slice(0, 4));
chk('reconcile.apply_exit0', app.status === 0, app.stdout.split('\n').slice(-6));
chk('after.period_balances_equal_ledger', diffAfter === 0, { before: diffBefore, afterWorker: diffMid, after: diffAfter });
chk('after.ledger_fingerprint_identical', JSON.stringify(fpBefore) === JSON.stringify(fpAfter), { before: fpBefore, after: fpAfter });
chk('replay.second_apply_is_noop', again.status === 0 && /0 difference|nothing to do|no differences/i.test(again.stdout + again.stderr), again.stdout.split('\n').slice(0, 3));
result.recovery = { workerCycles: cycles, histogram: { before: histBefore, afterWorker: histMid, after: histAfter }, diffs: { before: diffBefore, afterWorker: diffMid, after: diffAfter }, reconcileApplyTail: app.stdout.split('\n').slice(-8) };
result.checks = checks;
result.allChecksPass = checks.every((c) => c.pass);
writeFileSync(out, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ stuck: (result.stuckEvents as any).byClassification, histogram: result.recovery && (result.recovery as any).histogram, diffs: (result.recovery as any).diffs }, null, 1));
for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'} ${c.id}`);
await pool.end();
process.exit(checks.every((c) => c.pass) ? 0 : 1);
