/**
 * Split-tender HISTORICAL correction — plan (read-only) and apply (gated), liquidity <-> liquidity only.
 *
 * Problem: before the per-payment-line posting fix, a split-tender sale was posted as ONE debit of the whole
 * total to the HEADER method's account. Revenue, tax, COGS, AR and the total are all correct; only the split
 * between 1010/1020/1030/1040 is wrong.
 *
 * Correction (never edits a posted journal): one ADDITIONAL balanced journal per affected sale,
 *   source            SYSTEM_CORRECTION          (admin remediation; allowed on all four liquidity accounts)
 *   referenceType     SALE_TENDER_RECLASS        (distinct from 'SALE' so AccountingCore's reference guard allows it)
 *   referenceId       the sale id                (source-document link; tenant = the DB the pool points at)
 *   idempotencyKey    SALE-TENDER-RECLASS-<saleNumber>   (replay returns the existing journal, never a second)
 *   lines             DR accounts that were under-stated, CR accounts that were over-stated, by exactly the delta
 * Because the sum of deltas is zero the journal is balanced and the TOTAL liquidity, revenue, tax, AR and the
 * trial-balance totals are unchanged by construction. Reversal of a reclass is the standard AccountingCore reversal.
 *
 * The plan is computed from NET (debit - credit) liquidity per sale across journals with referenceType in
 * ('SALE','SALE_TENDER_RECLASS') for that sale, so after apply the same plan reports zero remaining deltas (that is
 * the post-operation reconciliation) and a second apply is a no-op.
 *
 * Not touched / reported as review-only (never auto-corrected): sales with DEPOSIT tender, sales without exactly one
 * SALE journal, non-completed sales, lines the allocator cannot map, and any sale whose deltas do not net to zero.
 */
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { AccountingCore } from './accountingCore.js';
import { allocateTenderToLiquidity } from './saleTenderAllocation.js';
import { refuseNonLocalPool } from './localApplyGuard.js';
import { SYSTEM_USER_ID } from '../utils/constants.js';

export const LIQUIDITY_CODES = ['1010', '1020', '1030', '1040'] as const;
export const RECLASS_REFERENCE_TYPE = 'SALE_TENDER_RECLASS';

export type ReclassStatus =
  | 'ELIGIBLE'
  | 'ALREADY_CORRECT'
  | 'REVIEW_NO_LINES'
  | 'NOT_APPLICABLE_NO_TENDER'
  | 'REVIEW_LIQUIDITY_WITHOUT_TENDER'
  | 'REVIEW_DEPOSIT_TENDER'
  | 'REVIEW_UNMAPPED_TENDER'
  | 'REVIEW_NOT_ONE_SALE_JOURNAL'
  | 'REVIEW_NOT_COMPLETED'
  | 'REVIEW_DELTA_DOES_NOT_NET_ZERO'
  | 'REVIEW_SHORTFALL'
  | 'REVIEW_TENDER_NOT_POSTED';

export type ReclassScope = 'SPLIT_TENDER' | 'SINGLE_TENDER_MISPOSTED';

export interface SaleReclassRow {
  /** SPLIT_TENDER: 2+ tender lines. SINGLE_TENDER_MISPOSTED: one tender line posted to the wrong liquidity account (e.g. MoMo posted to cash). Approved separately. */
  scope: ReclassScope;
  saleId: string;
  saleNumber: string;
  saleDate: string;
  headerMethod: string;
  status: ReclassStatus;
  targetCents: number;
  /** net posted per liquidity account, in cents */
  postedCents: Record<string, number>;
  expectedCents: Record<string, number>;
  /** expected - posted (cents); only populated when ELIGIBLE */
  deltaCents: Record<string, number>;
}

export interface ReclassPlan {
  generatedAt: string;
  population: Record<ReclassStatus, number>;
  eligible: SaleReclassRow[];
  review: SaleReclassRow[];
  /** sum of deltas per liquidity account over ELIGIBLE sales (cents) — the exact balance movement the apply causes */
  accountMovementCents: Record<string, number>;
  /** total liquidity before == after (must be 0) */
  netMovementCents: number;
  eligibleTotalCents: number;
  /** money that actually changes account = sum of positive deltas (== sum of negative deltas) */
  grossReclassCents: number;
  fingerprint: string;
}

const zeroMap = () => Object.fromEntries(LIQUIDITY_CODES.map((c) => [c, 0])) as Record<string, number>;
const toCents = (v: unknown) => Math.round(Number(v) * 100);

/** Pure: classify one sale given its facts. Exported for unit tests. */
export function classifySale(input: {
  saleId: string;
  saleNumber: string;
  saleDate: string;
  headerMethod: string;
  saleStatus: string;
  totalAmount: number;
  amountPaid: number;
  lines: Array<{ paymentMethod: string; amount: number }>;
  saleJournalCount: number;
  postedNetCents: Record<string, number>;
}): SaleReclassRow {
  const base = {
    scope: (input.lines.filter((l) => l.paymentMethod !== 'CREDIT').length > 1 ? 'SPLIT_TENDER' : 'SINGLE_TENDER_MISPOSTED') as ReclassScope,
    saleId: input.saleId,
    saleNumber: input.saleNumber,
    saleDate: input.saleDate,
    headerMethod: input.headerMethod,
    postedCents: { ...zeroMap(), ...input.postedNetCents },
    expectedCents: zeroMap(),
    deltaCents: zeroMap(),
  };
  // The amount to redistribute is what the SALE journal ALREADY recorded as received on liquidity accounts (net of any
  // earlier reclass). We never re-derive it from sales.amount_paid / header method: those are overwritten when an invoice
  // is settled later (evidence: Henber sales posted as part-paid CREDIT now read header CASH, amount_paid = total).
  const targetCents = LIQUIDITY_CODES.reduce((s, c) => s + (base.postedCents[c] ?? 0), 0);
  const row = (status: ReclassStatus): SaleReclassRow => ({ ...base, status, targetCents });

  if (input.saleStatus !== 'COMPLETED') return row('REVIEW_NOT_COMPLETED');
  if (input.saleJournalCount !== 1) return row('REVIEW_NOT_ONE_SALE_JOURNAL');
  if (input.lines.length === 0) return row('REVIEW_NO_LINES');
  const tender = input.lines.filter((l) => l.paymentMethod !== 'CREDIT');
  const physical = tender.filter((l) => l.paymentMethod !== 'DEPOSIT');
  if (physical.length === 0) {
    // credit-only / deposit-only lines: nothing may sit on a liquidity account (deposit application has its own journal).
    // Anything that does needs a human.
    const anyLiquid = LIQUIDITY_CODES.some((c) => (base.postedCents[c] ?? 0) !== 0);
    return row(anyLiquid ? 'REVIEW_LIQUIDITY_WITHOUT_TENDER' : 'NOT_APPLICABLE_NO_TENDER');
  }
  if (tender.some((l) => l.paymentMethod === 'DEPOSIT')) return row('REVIEW_DEPOSIT_TENDER'); // deposit mixed with cash/bank/MoMo
  if (targetCents <= 0 && tender.some((l) => Number(l.amount) > 0)) return row('REVIEW_TENDER_NOT_POSTED'); // tender recorded, no liquidity debit
  const alloc = allocateTenderToLiquidity(targetCents / 100, input.lines);
  if (!alloc) return row('REVIEW_UNMAPPED_TENDER');
  if (alloc.shortfallCents > 0) return row('REVIEW_SHORTFALL'); // lines do not cover what was debited

  const expected = zeroMap();
  for (const it of alloc.items) expected[it.accountCode] = (expected[it.accountCode] ?? 0) + it.amountCents;
  const delta = zeroMap();
  let net = 0;
  let any = false;
  for (const c of LIQUIDITY_CODES) {
    delta[c] = expected[c] - (base.postedCents[c] ?? 0);
    net += delta[c];
    if (delta[c] !== 0) any = true;
  }
  const out = { ...base, expectedCents: expected, deltaCents: delta };
  if (!any) return { ...out, status: 'ALREADY_CORRECT', targetCents };
  if (net !== 0) return { ...out, status: 'REVIEW_DELTA_DOES_NOT_NET_ZERO', targetCents };
  return { ...out, status: 'ELIGIBLE', targetCents };
}

const PLAN_SQL = `
WITH s AS (
  SELECT id, sale_number, sale_date::text sale_date, payment_method::text header_method, status::text sale_status,
         total_amount, amount_paid
    FROM sales
   WHERE id IN (SELECT sale_id FROM payment_lines)
     AND ($1::uuid[] IS NULL OR id = ANY($1::uuid[]))
),
lines AS (
  SELECT sale_id, json_agg(json_build_object('paymentMethod', payment_method::text, 'amount', amount) ORDER BY created_at, id) lines
    FROM payment_lines GROUP BY sale_id
),
j AS (
  SELECT lt."ReferenceId" sale_id,
         count(*) FILTER (WHERE lt."ReferenceType"='SALE' AND lt."Status"='POSTED' AND COALESCE(lt."IsReversed",false)=false AND lt."ReversesTransactionId" IS NULL) sale_journals
    FROM ledger_transactions lt WHERE lt."ReferenceType" IN ('SALE') GROUP BY lt."ReferenceId"
),
net AS (
  SELECT lt."ReferenceId" sale_id, a."AccountCode" code,
         round(sum(le."DebitAmount" - le."CreditAmount") * 100)::bigint cents
    FROM ledger_transactions lt
    JOIN ledger_entries le ON le."TransactionId" = lt."Id"
    JOIN accounts a ON a."Id" = le."AccountId"
   WHERE lt."ReferenceType" IN ('SALE','${RECLASS_REFERENCE_TYPE}')
     AND lt."Status"='POSTED' AND COALESCE(lt."IsReversed",false)=false
     AND a."AccountCode" IN ('1010','1020','1030','1040')
   GROUP BY 1,2
)
SELECT s.*, l.lines, COALESCE(j.sale_journals,0)::int sale_journals,
       COALESCE((SELECT json_object_agg(n.code, n.cents) FROM net n WHERE n.sale_id = s.id), '{}'::json) net
  FROM s LEFT JOIN lines l ON l.sale_id = s.id LEFT JOIN j ON j.sale_id = s.id
 ORDER BY s.sale_date, s.sale_number`;

/** READ-ONLY. Runs inside BEGIN READ ONLY so even a bug cannot write. */
export async function planSaleTenderReclass(pool: pg.Pool, opts: { saleIds?: string[]; scope?: ReclassScope } = {}): Promise<ReclassPlan> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const res = await client.query(PLAN_SQL, [opts.saleIds ?? null]);
    await client.query('ROLLBACK');
    const rows: SaleReclassRow[] = res.rows.map((r) =>
      classifySale({
        saleId: r.id,
        saleNumber: r.sale_number,
        saleDate: r.sale_date,
        headerMethod: r.header_method,
        saleStatus: r.sale_status,
        totalAmount: Number(r.total_amount),
        amountPaid: Number(r.amount_paid ?? 0),
        lines: (r.lines ?? []).map((l: { paymentMethod: string; amount: string | number }) => ({
          paymentMethod: l.paymentMethod,
          amount: Number(l.amount),
        })),
        saleJournalCount: r.sale_journals,
        postedNetCents: Object.fromEntries(Object.entries(r.net ?? {}).map(([k, v]) => [k, Number(v)])),
      }),
    );
    const population = Object.fromEntries(
      (['ELIGIBLE','ALREADY_CORRECT','NOT_APPLICABLE_NO_TENDER','REVIEW_NO_LINES','REVIEW_LIQUIDITY_WITHOUT_TENDER','REVIEW_DEPOSIT_TENDER','REVIEW_UNMAPPED_TENDER','REVIEW_NOT_ONE_SALE_JOURNAL','REVIEW_NOT_COMPLETED','REVIEW_DELTA_DOES_NOT_NET_ZERO','REVIEW_SHORTFALL','REVIEW_TENDER_NOT_POSTED'] as ReclassStatus[]).map((k) => [k, 0]),
    ) as Record<ReclassStatus, number>;
    for (const r of rows) population[r.status]++;
    const eligible = rows.filter((r) => r.status === 'ELIGIBLE' && (!opts.scope || r.scope === opts.scope));
    const review = rows.filter((r) => r.status.startsWith('REVIEW_'));
    const accountMovementCents = zeroMap();
    for (const r of eligible) for (const c of LIQUIDITY_CODES) accountMovementCents[c] += r.deltaCents[c];
    const netMovementCents = Object.values(accountMovementCents).reduce((s, v) => s + v, 0);
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(eligible.map((r) => [r.saleId, r.saleNumber, LIQUIDITY_CODES.map((c) => r.deltaCents[c])])))
      .digest('hex');
    return {
      generatedAt: new Date().toISOString(),
      population,
      eligible,
      review,
      accountMovementCents,
      netMovementCents,
      eligibleTotalCents: eligible.reduce((s, r) => s + r.targetCents, 0),
      grossReclassCents: eligible.reduce((s, r) => s + LIQUIDITY_CODES.reduce((a, c) => a + Math.max(0, r.deltaCents[c]), 0), 0),
      fingerprint,
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

export interface ApplyOptions {
  /** Written approval reference (ticket / signed decision). Required, recorded on every journal. */
  approvalRef: string;
  /** Fingerprint of the plan the approver reviewed; apply refuses if the live plan differs. */
  approvedFingerprint: string;
  /** Posting date of the correction journals (YYYY-MM-DD). Must be in an OPEN period (AccountingCore enforces). */
  entryDate: string;
  userId?: string;
  /** Restrict to one population so each can be approved on its own (default: all eligible). */
  scope?: ReclassScope;
}

export interface ApplyResult {
  posted: number;
  replayed: number;
  failed: Array<{ saleNumber: string; error: string }>;
  fingerprintBefore: string;
}

/** Posts one balanced SYSTEM_CORRECTION journal per ELIGIBLE sale through AccountingCore only. */
export async function applySaleTenderReclass(pool: pg.Pool, opts: ApplyOptions): Promise<ApplyResult> {
  refuseNonLocalPool(pool, 'tender-reclass');
  if (!opts.approvalRef || opts.approvalRef.trim().length < 3) throw new Error('approvalRef is required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.entryDate)) throw new Error('entryDate must be YYYY-MM-DD');
  const plan = await planSaleTenderReclass(pool, { scope: opts.scope });
  if (plan.fingerprint !== opts.approvedFingerprint) {
    throw new Error(`Plan changed since approval (approved ${opts.approvedFingerprint.slice(0, 12)}…, live ${plan.fingerprint.slice(0, 12)}…). Re-run the dry run and re-approve.`);
  }
  let posted = 0;
  let replayed = 0;
  const failed: ApplyResult['failed'] = [];
  for (const r of plan.eligible) {
    const lines = LIQUIDITY_CODES.filter((c) => r.deltaCents[c] !== 0).map((c) => ({
      accountCode: c,
      description: `Tender reclass ${r.saleNumber}: ${r.deltaCents[c] > 0 ? 'receipt belongs here' : 'receipt was posted here in error'} [${opts.approvalRef}]`,
      debitAmount: r.deltaCents[c] > 0 ? r.deltaCents[c] / 100 : 0,
      creditAmount: r.deltaCents[c] < 0 ? -r.deltaCents[c] / 100 : 0,
    }));
    try {
      const before = await pool.query(
        `SELECT count(*)::int n FROM ledger_transactions WHERE "IdempotencyKey" = $1`,
        [`SALE-TENDER-RECLASS-${r.saleNumber}`],
      );
      await AccountingCore.createJournalEntry(
        {
          entryDate: opts.entryDate,
          description: `Split-tender reclassification for ${r.saleNumber} (liquidity accounts only) [${opts.approvalRef}]`,
          referenceType: RECLASS_REFERENCE_TYPE,
          referenceId: r.saleId,
          referenceNumber: r.saleNumber,
          lines,
          userId: opts.userId ?? SYSTEM_USER_ID,
          idempotencyKey: `SALE-TENDER-RECLASS-${r.saleNumber}`,
          source: 'SYSTEM_CORRECTION',
        },
        pool,
      );
      if (before.rows[0].n > 0) replayed++;
      else posted++;
    } catch (e) {
      failed.push({ saleNumber: r.saleNumber, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { posted, replayed, failed, fingerprintBefore: plan.fingerprint };
}
