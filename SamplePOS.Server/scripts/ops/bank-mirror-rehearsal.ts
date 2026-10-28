/**
 * C3 rehearsal (LOCAL copies only): historical sale -> bank-register mirror reconciliation.
 *   npx tsx scripts/ops/bank-mirror-rehearsal.ts [--out ../PROOF_BANK_MIRROR_RECONCILE_REHEARSAL.json]
 * Order mirrors the production sequence: tender reclass first (so the GL supports each tender), then mirror.
 */
import { writeFileSync } from 'node:fs';
import pg from 'pg';
import { planSaleTenderReclass, applySaleTenderReclass } from '../../src/services/saleTenderReclassService.js';
import { planBankMirrorReconcile, applyBankMirrorReconcile } from '../../src/services/bankMirrorReconcileService.js';

const a = process.argv.slice(2);
const out = a.includes('--out') ? a[a.indexOf('--out') + 1] : '../PROOF_BANK_MIRROR_RECONCILE_REHEARSAL.json';
const result: Record<string, unknown> = { generatedAt: new Date().toISOString(), note: 'LOCAL rehearsal on copies of production ledgers; production untouched', tenants: {} };
let ok = true;

for (const t of ['henber', 'blis']) {
  const pool = new pg.Pool({ connectionString: `postgresql://postgres:password@localhost:5432/rehearsal_${t}`, max: 4 });
  const checks: Array<{ id: string; pass: boolean; observed?: unknown }> = [];
  const chk = (id: string, pass: boolean, observed?: unknown) => { checks.push({ id, pass, observed }); if (!pass) ok = false; };
  const bankState = async () => (await pool.query(`SELECT count(*)::int n, round(COALESCE(sum(amount),0),2)::float8 amt FROM bank_transactions WHERE source_type='SALE'`)).rows[0];
  const ledger = async () => (await pool.query(`SELECT count(*)::int txns, (SELECT md5(string_agg("Id"::text||"AccountId"::text||"DebitAmount"::text||"CreditAmount"::text, ',' ORDER BY "Id")) FROM ledger_entries) md5 FROM ledger_transactions`)).rows[0];
  try {
    // sequencing step: reclass anything still eligible (idempotent: already-reclassed copies have nothing left)
    for (const scope of ['SPLIT_TENDER', 'SINGLE_TENDER_MISPOSTED'] as const) {
      const tp = await planSaleTenderReclass(pool, { scope });
      if (tp.eligible.length) await applySaleTenderReclass(pool, { approvalRef: 'REHEARSAL-LOCAL-ONLY', approvedFingerprint: tp.fingerprint, entryDate: '2026-10-28', scope });
    }
    const all = await planBankMirrorReconcile(pool);
    const post = await planBankMirrorReconcile(pool, { era: 'POST_GOLIVE' });
    const pre = await planBankMirrorReconcile(pool, { era: 'PRE_GOLIVE' });
    const bankBefore = await bankState();
    const ledBefore = await ledger();
    const res = await applyBankMirrorReconcile(pool, { approvalRef: 'REHEARSAL-LOCAL-ONLY', approvedFingerprint: post.fingerprint, era: 'POST_GOLIVE' });
    const bankAfter = await bankState();
    const ledAfter = await ledger();
    const postAfter = await planBankMirrorReconcile(pool, { era: 'POST_GOLIVE' });
    const preAfter = await planBankMirrorReconcile(pool, { era: 'PRE_GOLIVE' });
    const replay = await applyBankMirrorReconcile(pool, { approvalRef: 'REHEARSAL-LOCAL-ONLY', approvedFingerprint: postAfter.fingerprint, era: 'POST_GOLIVE' });
    const linked = (await pool.query(`SELECT lt."ReferenceType" rt, count(*)::int n FROM bank_transactions bt JOIN ledger_transactions lt ON lt."Id"=bt.gl_transaction_id WHERE bt.source_type='SALE' GROUP BY 1`)).rows;

    chk('apply.created_equals_planned', res.created === post.eligible.length && res.failed.length === 0, res);
    chk('apply.bank_rows_added_exactly', bankAfter.n === bankBefore.n + post.eligible.length && Math.abs(bankAfter.amt - bankBefore.amt - post.eligibleCents / 100) < 0.005, { bankBefore, bankAfter, planned: post.eligibleCents / 100 });
    chk('apply.no_journal_posted', JSON.stringify(ledBefore) === JSON.stringify(ledAfter), { ledBefore, ledAfter });
    chk('after.no_post_golive_eligible', postAfter.eligible.length === 0, postAfter.population);
    chk('after.pre_golive_untouched', preAfter.eligible.length === pre.eligible.length && preAfter.fingerprint === pre.fingerprint);
    chk('replay.noop', replay.created === 0 && replay.failed.length === 0, replay);
    (result.tenants as Record<string, unknown>)[t] = {
      goLive: all.goLive,
      populationBefore: all.population,
      postGoLive: { eligibleRows: post.eligible.length, amount: post.eligibleCents / 100, rows: post.eligible.map((r) => ({ sale: r.saleNumber, method: r.method, status: r.status, create: r.createCents / 100 })) },
      preGoLive: { eligibleRows: pre.eligible.length, amount: pre.eligibleCents / 100, note: 'NOT applied: back-fill of pre-go-live sales is a separate policy decision' },
      review: post.review.concat(pre.review).map((r) => ({ sale: r.saleNumber, method: r.method, status: r.status, era: r.era })).slice(0, 50),
      reviewTotal: post.review.length + pre.review.length,
      bankBefore, bankAfter, linkedJournalTypes: linked, checks,
    };
  } finally {
    await pool.end();
  }
}
(result as { allChecksPass: boolean }).allChecksPass = ok;
writeFileSync(out, JSON.stringify(result, null, 2));
for (const [t, v] of Object.entries(result.tenants as Record<string, any>)) {
  console.log(t, JSON.stringify({ postGoLive: v.postGoLive, preGoLive: v.preGoLive, reviewTotal: v.reviewTotal, linked: v.linkedJournalTypes }));
  console.log(v.checks.map((c: any) => `${c.pass ? 'PASS' : 'FAIL'} ${c.id}`).join('\n'));
}
process.exit(ok ? 0 : 1);
