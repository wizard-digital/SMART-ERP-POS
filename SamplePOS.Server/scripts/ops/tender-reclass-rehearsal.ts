/**
 * LOCAL rehearsal of the split-tender historical correction against copies of the real Henber and Blis ledgers.
 * Production is never contacted by this script (it only talks to localhost rehearsal_* databases).
 *
 *   npx tsx scripts/ops/tender-reclass-rehearsal.ts [--out ../PROOF_SPLIT_TENDER_RECLASS_REHEARSAL.json]
 *
 * For each tenant: BEFORE metrics -> plan -> apply (approval ref + fingerprint) -> AFTER metrics -> assertions.
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import pg from 'pg';
import { planSaleTenderReclass, applySaleTenderReclass } from '../../src/services/saleTenderReclassService.js';

const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : '../PROOF_SPLIT_TENDER_RECLASS_REHEARSAL.json';
const base = 'postgresql://postgres:password@localhost:5432';

async function metrics(pool: pg.Pool) {
  const q = async (sql: string) => (await pool.query(sql)).rows;
  const acct = await q(`SELECT a."AccountCode" code, round(COALESCE(sum(le."DebitAmount"-le."CreditAmount"),0),2)::float8 net
      FROM accounts a LEFT JOIN ledger_entries le ON le."AccountId"=a."Id"
      LEFT JOIN ledger_transactions lt ON lt."Id"=le."TransactionId" AND lt."Status"='POSTED' AND COALESCE(lt."IsReversed",false)=false
     GROUP BY 1 ORDER BY 1`);
  const byCode = Object.fromEntries(acct.map((r) => [r.code, r.net as number]));
  const liquidity = Object.fromEntries(['1010', '1020', '1030', '1040'].map((c) => [c, byCode[c] ?? 0]));
  const [tb] = await q(`SELECT round(sum("DebitAmount"),2)::float8 dr, round(sum("CreditAmount"),2)::float8 cr, count(*)::int entries FROM ledger_entries`);
  const [lt] = await q(`SELECT count(*)::int n FROM ledger_transactions`);
  const nonLiquidChecksum = createHash('sha256').update(JSON.stringify(Object.entries(byCode).filter(([c]) => !['1010', '1020', '1030', '1040'].includes(c)))).digest('hex');
  const [src] = await q(`SELECT md5(string_agg(s.id::text||s.total_amount::text||s.payment_method::text||s.amount_paid::text, ',' ORDER BY s.id)) sales_md5,
        (SELECT md5(string_agg(p.id::text||p.payment_method||p.amount::text, ',' ORDER BY p.id)) FROM payment_lines p) lines_md5,
        (SELECT md5(string_agg(b.id::text||b.amount::text, ',' ORDER BY b.id)) FROM bank_transactions b) bank_md5,
        (SELECT md5(string_agg(le."Id"::text||le."AccountId"::text||le."DebitAmount"::text||le."CreditAmount"::text, ',' ORDER BY le."Id"))
           FROM ledger_entries le JOIN ledger_transactions t ON t."Id"=le."TransactionId" WHERE t."ReferenceType" <> 'SALE_TENDER_RECLASS') preexisting_entries_md5
      FROM sales s`);
  const [outbox] = await q(`SELECT count(*)::int n FROM gl_projection_events`);
  const liqTotal = Math.round(Object.values(liquidity).reduce((s: number, v) => s + (v as number), 0) * 100) / 100;
  return { liquidity, liquidityTotal: liqTotal, trialBalance: tb, ledgerTransactions: lt.n, nonLiquidAccountsChecksum: nonLiquidChecksum, sourceChecksums: src, outboxEvents: outbox.n };
}

/** The earlier Gate-4 definition vs this planner, to reconcile the two populations explicitly. */
async function gateReconciliation(pool: pg.Pool) {
  const [r] = (await pool.query(`
    WITH gl(method, code) AS (VALUES ('CASH','1010'),('CARD','1020'),('MOBILE_MONEY','1040'),('AIRTEL_MONEY','1040'),('BANK_TRANSFER','1030'),('CREDIT','1200'),('DEPOSIT','2400')),
    multi AS (SELECT sale_id FROM payment_lines GROUP BY 1 HAVING count(*)>1)
    SELECT
     count(DISTINCT s.id)::int gate_sales_incl_credit_lines,
     round(COALESCE(sum(pl.amount),0),2)::float8 gate_amount_incl_credit_lines,
     count(DISTINCT s.id) FILTER (WHERE pl.payment_method NOT IN ('CREDIT','DEPOSIT'))::int sales_excluding_credit_deposit_lines,
     round(COALESCE(sum(pl.amount) FILTER (WHERE pl.payment_method NOT IN ('CREDIT','DEPOSIT')),0),2)::float8 amount_excluding_credit_deposit_lines
    FROM payment_lines pl JOIN sales s ON s.id=pl.sale_id JOIN gl g1 ON g1.method=pl.payment_method JOIN gl g2 ON g2.method=s.payment_method::text
    WHERE s.status='COMPLETED' AND g1.code<>g2.code AND s.id IN (SELECT sale_id FROM multi)`)).rows;
  return r;
}

const result: Record<string, unknown> = { generatedAt: new Date().toISOString(), note: 'LOCAL rehearsal on copies of production ledgers; production untouched', tenants: {} };
let allOk = true;

for (const t of ['henber', 'blis']) {
  const pool = new pg.Pool({ connectionString: `${base}/rehearsal_${t}`, max: 4 });
  const checks: Array<{ id: string; pass: boolean; observed?: unknown }> = [];
  const chk = (id: string, pass: boolean, observed?: unknown) => { checks.push({ id, pass, observed }); if (!pass) allOk = false; };
  try {
    const before = await metrics(pool);
    const gate = await gateReconciliation(pool);
    const plan = await planSaleTenderReclass(pool);
    const planAgain = await planSaleTenderReclass(pool);
    chk('plan.deterministic', plan.fingerprint === planAgain.fingerprint);
    chk('plan.nets_to_zero', plan.netMovementCents === 0, plan.netMovementCents);
    chk('plan.dry_run_changed_nothing', JSON.stringify(await metrics(pool)) === JSON.stringify(before));

    // each population is planned, approved (fingerprint) and applied on its own
    const scopes = ['SPLIT_TENDER', 'SINGLE_TENDER_MISPOSTED'] as const;
    const perScope: Record<string, unknown> = {};
    let posted = 0;
    let failedN = 0;
    for (const scope of scopes) {
      const sp = await planSaleTenderReclass(pool, { scope });
      const r1 = await applySaleTenderReclass(pool, { approvalRef: `REHEARSAL-LOCAL-ONLY-${scope}`, approvedFingerprint: sp.fingerprint, entryDate: '2026-10-28', scope });
      posted += r1.posted;
      failedN += r1.failed.length;
      perScope[scope] = { sales: sp.eligible.length, grossAmountMoved: sp.grossReclassCents / 100, accountMovement: Object.fromEntries(Object.entries(sp.accountMovementCents).map(([k, v]) => [k, v / 100])), fingerprint: sp.fingerprint, result: r1 };
    }
    const res = { posted, failed: new Array(failedN) };
    const after = await metrics(pool);
    const planAfter = await planSaleTenderReclass(pool);

    chk('apply.posted_equals_eligible', res.posted === plan.eligible.length && res.failed.length === 0, res);
    chk('after.no_eligible_left', planAfter.population.ELIGIBLE === 0, planAfter.population);
    chk('after.review_populations_unchanged', JSON.stringify(Object.fromEntries(Object.entries(plan.population).filter(([k]) => k.startsWith('REVIEW_') || k.startsWith('NOT_')))) === JSON.stringify(Object.fromEntries(Object.entries(planAfter.population).filter(([k]) => k.startsWith('REVIEW_') || k.startsWith('NOT_')))));
    chk('after.total_liquidity_unchanged', after.liquidityTotal === before.liquidityTotal, { before: before.liquidityTotal, after: after.liquidityTotal });
    for (const c of ['1010', '1020', '1030', '1040']) {
      const moved = Math.round(((after.liquidity as Record<string, number>)[c] - (before.liquidity as Record<string, number>)[c]) * 100);
      chk(`after.account_${c}_moved_exactly_as_planned`, moved === plan.accountMovementCents[c], { moved, planned: plan.accountMovementCents[c] });
    }
    chk('after.trial_balance_balanced', (after.trialBalance as { dr: number; cr: number }).dr === (after.trialBalance as { dr: number; cr: number }).cr, after.trialBalance);
    chk('after.non_liquidity_accounts_identical', after.nonLiquidAccountsChecksum === before.nonLiquidAccountsChecksum);
    chk('after.sales_payment_lines_bank_untouched', JSON.stringify((after.sourceChecksums as Record<string, string>)) === JSON.stringify({ ...(before.sourceChecksums as Record<string, string>) }), { before: before.sourceChecksums, after: after.sourceChecksums });
    chk('after.new_journals_only', after.ledgerTransactions === before.ledgerTransactions + plan.eligible.length, { before: before.ledgerTransactions, after: after.ledgerTransactions, eligible: plan.eligible.length });

    const second = await applySaleTenderReclass(pool, { approvalRef: 'REHEARSAL-LOCAL-ONLY', approvedFingerprint: planAfter.fingerprint, entryDate: '2026-10-28' });
    chk('replay.noop', second.posted === 0 && second.failed.length === 0, second);

    (result.tenants as Record<string, unknown>)[t] = {
      gateDefinitionReconciliation: gate,
      population: plan.population,
      perScope,
      eligibleSales: plan.eligible.length,
      grossAmountMoved: plan.grossReclassCents / 100,
      accountMovement: Object.fromEntries(Object.entries(plan.accountMovementCents).map(([k, v]) => [k, v / 100])),
      fingerprint: plan.fingerprint,
      before,
      after,
      checks,
    };
  } finally {
    await pool.end();
  }
}
(result as { allChecksPass: boolean }).allChecksPass = allOk;
writeFileSync(out, JSON.stringify(result, null, 2));
const sha = createHash('sha256').update(JSON.stringify(result)).digest('hex');
console.log(JSON.stringify({ allOk, sha256: sha, out }, null, 1));
for (const [t, v] of Object.entries(result.tenants as Record<string, { checks: Array<{ id: string; pass: boolean }> }>)) {
  console.log(t, v.checks.map((c) => `${c.pass ? 'PASS' : 'FAIL'} ${c.id}`).join('\n   '));
}
process.exit(allOk ? 0 : 1);
