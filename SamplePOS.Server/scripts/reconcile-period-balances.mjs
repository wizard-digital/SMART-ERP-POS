/**
 * Reconcile gl_period_balances (DERIVED table) against the ledger for ONE tenant database.
 *
 * - DRY-RUN by default (read-only transaction). Nothing is written without --apply.
 * - Classifies every difference: ORPHAN (stored row, no ledger backing), DRIFT (totals differ),
 *   MISSING (ledger activity, no stored row).
 * - --apply performs the SAME absolute recompute as rebuildSingleAccountPeriod
 *   (delete if zero, otherwise upsert absolute totals) inside ONE transaction, only for the
 *   differing tuples, skips CLOSED/LOCKED periods, re-verifies, and ROLLS BACK if any difference
 *   remains that is not a skipped locked period.
 * - NEVER touches ledger_transactions / ledger_entries (posted journals are not modified).
 * - Always writes an evidence JSON (before-values, planned/applied actions, post-check).
 *
 * Usage (prod via SSH tunnel: ssh -N -L 15432:127.0.0.1:5432 root@<host>):
 *   PROD_PG_PASSWORD=... node scripts/reconcile-period-balances.mjs --db pos_tenant_henber_pharmacy
 *   PROD_PG_PASSWORD=... node scripts/reconcile-period-balances.mjs --db pos_tenant_henber_pharmacy --apply --confirm-db pos_tenant_henber_pharmacy
 * Local scratch: PGHOST=localhost PGPORT=5432 PGUSER=postgres PGPASSWORD=password (see env below).
 */
import pg from 'pg';
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};

const db = opt('--db');
const apply = flag('--apply');
if (!db) {
  console.error('Usage: node scripts/reconcile-period-balances.mjs --db <database> [--apply --confirm-db <database>] [--out file.json]');
  process.exit(2);
}
if (apply && opt('--confirm-db') !== db) {
  console.error('Refusing to --apply: pass --confirm-db <same database name> to confirm the target.');
  process.exit(2);
}

const cfg = {
  host: process.env.PGHOST ?? process.env.PROD_PG_HOST ?? '127.0.0.1',
  port: Number(process.env.PGPORT ?? process.env.PROD_PG_PORT ?? 15432),
  user: process.env.PGUSER ?? 'postgres',
  password: process.env.PGPASSWORD ?? process.env.PROD_PG_PASSWORD ?? process.env.DB_PASSWORD,
  database: db,
  connectionTimeoutMillis: 20000,
};
if (!cfg.password) {
  console.error('No password: set PROD_PG_PASSWORD (or PGPASSWORD / DB_PASSWORD).');
  process.exit(2);
}

// Must stay identical to utils/ledgerNetActive.ts (LEDGER_NET_ACTIVE_SQL / fiscal year+period, UTC).
const DIFF_SQL = `
WITH calc AS (
  SELECT le."AccountId" AS account_id,
         EXTRACT(YEAR  FROM lt."TransactionDate" AT TIME ZONE 'UTC')::INT AS y,
         EXTRACT(MONTH FROM lt."TransactionDate" AT TIME ZONE 'UTC')::INT AS m,
         SUM(le."DebitAmount") AS d, SUM(le."CreditAmount") AS c
  FROM ledger_entries le
  JOIN ledger_transactions lt ON lt."Id" = le."TransactionId"
  WHERE lt."Status" = 'POSTED' AND lt."IsReversed" = FALSE
    AND lt."Id" NOT IN (SELECT "ReversedByTransactionId" FROM ledger_transactions WHERE "ReversedByTransactionId" IS NOT NULL)
  GROUP BY 1, 2, 3
)
SELECT COALESCE(b.account_id, calc.account_id) AS account_id,
       a."AccountCode" AS account_code,
       COALESCE(b.fiscal_year, calc.y)   AS fiscal_year,
       COALESCE(b.fiscal_period, calc.m) AS fiscal_period,
       b.debit_total::text  AS stored_debit,  b.credit_total::text AS stored_credit,
       COALESCE(calc.d, 0)::text AS ledger_debit, COALESCE(calc.c, 0)::text AS ledger_credit,
       CASE WHEN calc.account_id IS NULL THEN 'ORPHAN'
            WHEN b.account_id   IS NULL THEN 'MISSING'
            ELSE 'DRIFT' END AS kind,
       EXISTS (SELECT 1 FROM financial_periods fp
               WHERE fp.period_year = COALESCE(b.fiscal_year, calc.y)
                 AND fp.period_month = COALESCE(b.fiscal_period, calc.m)
                 AND fp."Status" IN ('CLOSED','LOCKED')) AS period_locked
FROM gl_period_balances b
FULL JOIN calc ON calc.account_id = b.account_id AND calc.y = b.fiscal_year AND calc.m = b.fiscal_period
JOIN accounts a ON a."Id" = COALESCE(b.account_id, calc.account_id)
WHERE COALESCE(b.debit_total, 0)  <> COALESCE(calc.d, 0)
   OR COALESCE(b.credit_total, 0) <> COALESCE(calc.c, 0)
ORDER BY 3, 4, 2`;

const pool = new pg.Pool({ ...cfg, max: 1 });
const client = await pool.connect();
const evidence = {
  database: db,
  mode: apply ? 'APPLY' : 'DRY_RUN',
  startedAt: new Date().toISOString(),
  differences: [],
  actions: [],
  postCheck: null,
  ledgerFingerprintBefore: null,
  ledgerFingerprintAfter: null,
};

const fingerprint = async () =>
  (await client.query(
    `SELECT count(*)::int AS entries, COALESCE(sum("DebitAmount"),0)::text AS debits, COALESCE(sum("CreditAmount"),0)::text AS credits,
            (SELECT count(*)::int FROM ledger_transactions) AS transactions FROM ledger_entries`,
  )).rows[0];

let exitCode = 0;
try {
  await client.query(apply ? 'BEGIN' : 'BEGIN READ ONLY');
  evidence.ledgerFingerprintBefore = await fingerprint();

  const diff = (await client.query(DIFF_SQL)).rows;
  evidence.differences = diff;

  console.log(`[${evidence.mode}] ${db}: ${diff.length} difference(s) between gl_period_balances and the ledger`);
  for (const r of diff) {
    console.log(
      `  ${r.kind.padEnd(7)} acct ${r.account_code} ${r.fiscal_year}-${String(r.fiscal_period).padStart(2, '0')}` +
        `  stored dr/cr ${r.stored_debit ?? '-'}/${r.stored_credit ?? '-'}  ledger dr/cr ${r.ledger_debit}/${r.ledger_credit}` +
        (r.period_locked ? '  [period CLOSED/LOCKED — will be skipped]' : ''),
    );
  }

  if (apply) {
    for (const r of diff) {
      if (r.period_locked) {
        evidence.actions.push({ ...r, action: 'SKIPPED_LOCKED_PERIOD' });
        continue;
      }
      const zero = Number(r.ledger_debit) === 0 && Number(r.ledger_credit) === 0;
      if (zero) {
        await client.query(
          `DELETE FROM gl_period_balances WHERE account_id=$1 AND fiscal_year=$2 AND fiscal_period=$3`,
          [r.account_id, r.fiscal_year, r.fiscal_period],
        );
        evidence.actions.push({ ...r, action: 'DELETED_ORPHAN' });
      } else {
        await client.query(
          `INSERT INTO gl_period_balances (account_id, fiscal_year, fiscal_period, debit_total, credit_total, running_balance, last_updated)
           VALUES ($1,$2,$3,$4,$5,$4::numeric-$5::numeric,NOW())
           ON CONFLICT (account_id, fiscal_year, fiscal_period) DO UPDATE SET
             debit_total=EXCLUDED.debit_total, credit_total=EXCLUDED.credit_total,
             running_balance=EXCLUDED.running_balance, last_updated=NOW()`,
          [r.account_id, r.fiscal_year, r.fiscal_period, r.ledger_debit, r.ledger_credit],
        );
        evidence.actions.push({ ...r, action: r.kind === 'MISSING' ? 'INSERTED' : 'CORRECTED' });
      }
    }

    const remaining = (await client.query(DIFF_SQL)).rows.filter((r) => !r.period_locked);
    evidence.ledgerFingerprintAfter = await fingerprint();
    const ledgerUntouched =
      JSON.stringify(evidence.ledgerFingerprintBefore) === JSON.stringify(evidence.ledgerFingerprintAfter);
    evidence.postCheck = { remainingDifferences: remaining.length, ledgerUntouched };
    if (remaining.length > 0 || !ledgerUntouched) {
      await client.query('ROLLBACK');
      evidence.postCheck.result = 'ROLLED_BACK';
      console.error('POST-CHECK FAILED — rolled back, nothing changed.', evidence.postCheck);
      exitCode = 1;
    } else {
      await client.query('COMMIT');
      evidence.postCheck.result = 'COMMITTED';
      console.log(`APPLIED ${evidence.actions.filter((a) => a.action !== 'SKIPPED_LOCKED_PERIOD').length} change(s); post-check clean; ledger untouched.`);
    }
  } else {
    evidence.ledgerFingerprintAfter = await fingerprint();
    await client.query('ROLLBACK');
    console.log('DRY-RUN only: nothing was written. Re-run with --apply --confirm-db <db> to apply.');
  }
} catch (e) {
  try { await client.query('ROLLBACK'); } catch { /* ignore */ }
  console.error('ERROR (rolled back):', e.message);
  evidence.error = e.message;
  exitCode = 1;
} finally {
  evidence.finishedAt = new Date().toISOString();
  const out = opt('--out') ?? `PROOF_PERIOD_BALANCE_RECONCILE_${db}_${evidence.mode}.json`;
  writeFileSync(out, JSON.stringify(evidence, null, 2));
  console.log(`Evidence written: ${out}`);
  client.release();
  await pool.end();
}
process.exit(exitCode);
