/**
 * Historical sale -> bank-register mirror reconciliation (plan = read-only; apply = approval-gated, idempotent).
 *
 * The bank row is only a REGISTER VIEW of a journal that already exists; this service NEVER posts a journal. Per
 * (sale, tender method) it compares the amount the tender lines say with the live bank rows and with what the GL
 * journals of that sale actually debited on the method's liquidity account, and classifies:
 *
 *   OK                               nothing to do
 *   MISSING_ELIGIBLE                 no bank row, book exists, GL supports the amount            -> create 1 row
 *   UNDER_ELIGIBLE                   same-method split mirrored only in part                     -> add ONE supplement row
 *   REVIEW_NO_ACTIVE_BOOK            no active bank book on the method's GL (e.g. CARD): by policy not mirrored
 *   REVIEW_GL_DOES_NOT_SUPPORT       journals debit less on that account than the lines claim -> fix the GL first (tender reclass)
 *   REVIEW_OVER_MIRRORED             bank rows exceed the lines: never auto-corrected
 *
 * Eras: sales created before the first mirrored sale (the go-live of mirroring) are PRE_GOLIVE. Back-filling them is a
 * separate policy decision (they were never in the register); POST_GOLIVE gaps are genuine misses. `era` selects which
 * population a plan / approval covers, so each is approved on its own.
 *
 * IDEMPOTENCY: creation goes through BankingService.createFromSale, whose existence check + live unique index
 * (source_id, description) guarantee one row per (sale, method[, supplement]); a retry, a concurrent run or a replay
 * of the same approved plan cannot create a second bank transaction for the same payment.
 */
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { BankingService } from './bankingService.js';
import { SALE_BANK_MIRROR_GL } from '../modules/treasury/saleBankMirrorPolicy.js';
import { refuseNonLocalPool } from './localApplyGuard.js';

export type MirrorEra = 'POST_GOLIVE' | 'PRE_GOLIVE';
export type MirrorStatus =
  | 'OK'
  | 'MISSING_ELIGIBLE'
  | 'UNDER_ELIGIBLE'
  | 'REVIEW_NO_ACTIVE_BOOK'
  | 'REVIEW_GL_DOES_NOT_SUPPORT'
  | 'REVIEW_OVER_MIRRORED';

export interface MirrorRow {
  saleId: string;
  saleNumber: string;
  saleDate: string;
  era: MirrorEra;
  method: string;
  glCode: string;
  linesCents: number;
  bankCents: number;
  glDebitCents: number;
  /** amount to create (cents) when eligible */
  createCents: number;
  status: MirrorStatus;
}

export interface MirrorPlan {
  generatedAt: string;
  goLive: string | null;
  population: Record<string, number>;
  eligible: MirrorRow[];
  review: MirrorRow[];
  eligibleCents: number;
  fingerprint: string;
}

export function classifyMirror(r: Omit<MirrorRow, 'status' | 'createCents'> & { hasActiveBook: boolean }): { status: MirrorStatus; createCents: number } {
  const { linesCents, bankCents, glDebitCents } = r;
  if (bankCents > linesCents) return { status: 'REVIEW_OVER_MIRRORED', createCents: 0 };
  if (bankCents === linesCents) return { status: 'OK', createCents: 0 };
  if (!r.hasActiveBook) return { status: 'REVIEW_NO_ACTIVE_BOOK', createCents: 0 };
  if (glDebitCents < linesCents) return { status: 'REVIEW_GL_DOES_NOT_SUPPORT', createCents: 0 };
  return { status: bankCents === 0 ? 'MISSING_ELIGIBLE' : 'UNDER_ELIGIBLE', createCents: linesCents - bankCents };
}

const SQL = `
WITH golive AS (SELECT min(created_at) g FROM bank_transactions WHERE source_type='SALE'),
lines AS (
  SELECT pl.sale_id, pl.payment_method m, round(sum(pl.amount)*100)::bigint cents
    FROM payment_lines pl JOIN sales s ON s.id=pl.sale_id
   WHERE s.status='COMPLETED' AND pl.payment_method = ANY($1::text[])
   GROUP BY 1,2),
bank AS (
  SELECT bt.source_id sale_id, substring(bt.description from '\\[([A-Z_]+)\\]') m, round(sum(bt.amount)*100)::bigint cents
    FROM bank_transactions bt WHERE bt.source_type='SALE' AND COALESCE(bt.is_reversed,false)=false GROUP BY 1,2),
glnet AS (
  SELECT lt."ReferenceId" sale_id, a."AccountCode" code, round(sum(le."DebitAmount"-le."CreditAmount")*100)::bigint cents
    FROM ledger_transactions lt JOIN ledger_entries le ON le."TransactionId"=lt."Id" JOIN accounts a ON a."Id"=le."AccountId"
   WHERE lt."ReferenceType" IN ('SALE','SALE_TENDER_RECLASS') AND lt."Status"='POSTED' AND COALESCE(lt."IsReversed",false)=false
   GROUP BY 1,2),
books AS (
  SELECT DISTINCT a."AccountCode" code FROM bank_accounts ba JOIN accounts a ON a."Id"=ba.gl_account_id WHERE ba.is_active
)
SELECT s.id sale_id, s.sale_number, s.sale_date::text sale_date, s.created_at >= (SELECT g FROM golive) AS post_golive,
       l.m method, l.cents lines_cents, COALESCE(b.cents,0) bank_cents,
       COALESCE(g.cents,0) gl_cents, (SELECT g FROM golive)::text golive,
       EXISTS (SELECT 1 FROM books bk WHERE bk.code = ($2::jsonb ->> l.m)) has_book
  FROM lines l JOIN sales s ON s.id=l.sale_id
  LEFT JOIN bank b ON b.sale_id=l.sale_id AND b.m=l.m
  LEFT JOIN glnet g ON g.sale_id=l.sale_id AND g.code = ($2::jsonb ->> l.m)
 WHERE ($3::text IS NULL OR (CASE WHEN s.created_at >= (SELECT g FROM golive) THEN 'POST_GOLIVE' ELSE 'PRE_GOLIVE' END) = $3)
 ORDER BY s.created_at, s.sale_number, l.m`;

/** CARD is excluded on purpose (policy: card receipts settle via Treasury transfer; mirroring them would double-represent). */
const MIRROR_METHODS = Object.keys(SALE_BANK_MIRROR_GL).filter((m) => m !== 'CARD');

export async function planBankMirrorReconcile(pool: pg.Pool, opts: { era?: MirrorEra } = {}): Promise<MirrorPlan> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN READ ONLY');
    const res = await c.query(SQL, [MIRROR_METHODS, JSON.stringify(SALE_BANK_MIRROR_GL), opts.era ?? null]);
    await c.query('ROLLBACK');
    const rows: MirrorRow[] = res.rows.map((r) => {
      const base = {
        saleId: r.sale_id as string,
        saleNumber: r.sale_number as string,
        saleDate: r.sale_date as string,
        era: (r.post_golive ? 'POST_GOLIVE' : 'PRE_GOLIVE') as MirrorEra,
        method: r.method as string,
        glCode: SALE_BANK_MIRROR_GL[r.method as string],
        linesCents: Number(r.lines_cents),
        bankCents: Number(r.bank_cents),
        glDebitCents: Number(r.gl_cents),
      };
      return { ...base, ...classifyMirror({ ...base, hasActiveBook: Boolean(r.has_book) }) };
    });
    const population: Record<string, number> = {};
    for (const r of rows) {
      const k = `${r.era}:${r.status}`;
      population[k] = (population[k] ?? 0) + 1;
    }
    const eligible = rows.filter((r) => r.status === 'MISSING_ELIGIBLE' || r.status === 'UNDER_ELIGIBLE');
    const review = rows.filter((r) => r.status.startsWith('REVIEW_'));
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(eligible.map((r) => [r.saleId, r.method, r.createCents, r.status])))
      .digest('hex');
    return {
      generatedAt: new Date().toISOString(),
      goLive: res.rows[0]?.golive ?? null,
      population,
      eligible,
      review,
      eligibleCents: eligible.reduce((s, r) => s + r.createCents, 0),
      fingerprint,
    };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

export interface MirrorApplyOptions {
  approvalRef: string;
  approvedFingerprint: string;
  era: MirrorEra;
}
export interface MirrorApplyResult {
  created: number;
  alreadyMirrored: number;
  failed: Array<{ saleNumber: string; method: string; error: string }>;
}

export async function applyBankMirrorReconcile(pool: pg.Pool, opts: MirrorApplyOptions): Promise<MirrorApplyResult> {
  refuseNonLocalPool(pool, 'bank-mirror-reconcile');
  if (!opts.approvalRef || opts.approvalRef.trim().length < 3) throw new Error('approvalRef is required');
  const plan = await planBankMirrorReconcile(pool, { era: opts.era });
  if (plan.fingerprint !== opts.approvedFingerprint) {
    throw new Error(`Plan changed since approval (approved ${opts.approvedFingerprint.slice(0, 12)}…, live ${plan.fingerprint.slice(0, 12)}…). Re-run the dry run and re-approve.`);
  }
  let created = 0;
  let alreadyMirrored = 0;
  const failed: MirrorApplyResult['failed'] = [];
  for (const r of plan.eligible) {
    try {
      const row = await BankingService.createFromSale(
        r.saleId,
        r.saleNumber,
        r.createCents / 100,
        r.method,
        r.saleDate,
        pool,
        r.status === 'UNDER_ELIGIBLE' ? { descriptionSuffix: ' (supplement)' } : undefined,
      );
      if (row) created++;
      else alreadyMirrored++; // existence check / unique index: another run already did it, or the guard refused (reported by re-plan)
    } catch (e) {
      failed.push({ saleNumber: r.saleNumber, method: r.method, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { created, alreadyMirrored, failed };
}
