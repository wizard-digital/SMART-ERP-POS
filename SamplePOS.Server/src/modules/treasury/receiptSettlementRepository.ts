/**
 * Receipt settlement repository — residual SSOT for Deposit Worksheets (Phase 1B)
 */

import type { Pool, PoolClient } from 'pg';
import {
  assertDepositConsumesUnsettled,
  assertSettlementCeiling,
  roundMoney,
} from '@shared/treasury/index.js';
import { LEDGER_NET_ACTIVE_SQL } from '../../utils/ledgerNetActive.js';

export type DbConn = Pool | PoolClient;

export type ReceiptSourceType =
  | 'AR_CUSTOMER_PAYMENT'
  | 'INVOICE_PAYMENT'
  | 'CUSTOMER_DEPOSIT';

export type SettlementStatus = 'UNSETTLED' | 'PARTIALLY_SETTLED' | 'SETTLED';

export interface ReceiptSettlement {
  id: string;
  sourceType: ReceiptSourceType;
  sourceId: string;
  sourceNumber: string | null;
  originatingAmount: number;
  settledAmount: number;
  residualAmount: number;
  clearingAccountCode: string;
  settlementStatus: SettlementStatus;
  customerId: string | null;
  customerName?: string | null;
  paymentDate: string | null;
  paymentMethod: string | null;
  ledgerTransactionId: string | null;
}

interface SettlementRow {
  id: string;
  source_type: ReceiptSourceType;
  source_id: string;
  source_number: string | null;
  originating_amount: string | number;
  settled_amount: string | number;
  residual_amount: string | number;
  clearing_account_code: string;
  settlement_status: SettlementStatus;
  customer_id: string | null;
  customer_name?: string | null;
  payment_date: Date | string | null;
  payment_method: string | null;
  ledger_transaction_id: string | null;
}

function toDate(v: Date | string | null | undefined): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

function mapSettlement(row: SettlementRow): ReceiptSettlement {
  return {
    id: row.id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    sourceNumber: row.source_number,
    originatingAmount: Number(row.originating_amount),
    settledAmount: Number(row.settled_amount),
    residualAmount: Number(row.residual_amount),
    clearingAccountCode: row.clearing_account_code,
    settlementStatus: row.settlement_status,
    customerId: row.customer_id,
    customerName: row.customer_name ?? null,
    paymentDate: toDate(row.payment_date),
    paymentMethod: row.payment_method,
    ledgerTransactionId: row.ledger_transaction_id,
  };
}

function statusFor(settled: number, residual: number): SettlementStatus {
  if (residual <= 0.009) return 'SETTLED';
  if (settled > 0.009) return 'PARTIALLY_SETTLED';
  return 'UNSETTLED';
}

/** Sync new AR payments / deposits into receipt_settlements (idempotent). */
export async function syncReceiptSettlements(conn: DbConn): Promise<number> {
  let inserted = 0;

  const ar = await conn.query(
    `INSERT INTO receipt_settlements (
       source_type, source_id, source_number, originating_amount, settled_amount, residual_amount,
       clearing_account_code, settlement_status, customer_id, payment_date, payment_method, ledger_transaction_id
     )
     SELECT
       'AR_CUSTOMER_PAYMENT', p.id, p.payment_number,
       ROUND(p.total_amount::numeric, 2), 0, ROUND(p.total_amount::numeric, 2),
       '1015', 'UNSETTLED', p.customer_id, p.payment_date, p.payment_method, p.gl_transaction_id
     FROM ar_customer_payments p
     WHERE p.status IS DISTINCT FROM 'REVERSED'
       AND p.total_amount > 0
       AND EXISTS (
         SELECT 1
         FROM ledger_transactions lt
         JOIN ledger_entries le ON le."TransactionId" = lt."Id"
         JOIN accounts a ON a."Id" = le."AccountId"
         WHERE lt."ReferenceType" = 'CUSTOMER_PAYMENT'
           AND lt."ReferenceId" = p.id
           AND a."AccountCode" = '1015'
           AND le."DebitAmount" > 0
       )
       AND NOT EXISTS (
         SELECT 1 FROM receipt_settlements rs
         WHERE rs.source_type = 'AR_CUSTOMER_PAYMENT' AND rs.source_id = p.id
       )
     ON CONFLICT (source_type, source_id) DO NOTHING`,
  );
  inserted += ar.rowCount ?? 0;

  const dep = await conn.query(
    `INSERT INTO receipt_settlements (
       source_type, source_id, source_number, originating_amount, settled_amount, residual_amount,
       clearing_account_code, settlement_status, customer_id, payment_date, payment_method
     )
     SELECT
       'CUSTOMER_DEPOSIT', d.id, d.deposit_number,
       ROUND(d.amount::numeric, 2), 0, ROUND(d.amount::numeric, 2),
       '1015', 'UNSETTLED', d.customer_id, d.created_at::date, d.payment_method
     FROM pos_customer_deposits d
     WHERE d.amount > 0
       AND d.status NOT IN ('REFUNDED', 'CANCELLED')
       AND NOT EXISTS (
         SELECT 1 FROM receipt_settlements rs
         WHERE rs.source_type = 'CUSTOMER_DEPOSIT' AND rs.source_id = d.id
       )
     ON CONFLICT (source_type, source_id) DO NOTHING`,
  );
  inserted += dep.rowCount ?? 0;

  // Legacy invoice_payments that posted DR 1015 (pre-AR-SSOT) — include in Deposit Worksheet SSOT
  const invPay = await conn.query(
    `INSERT INTO receipt_settlements (
       source_type, source_id, source_number, originating_amount, settled_amount, residual_amount,
       clearing_account_code, settlement_status, customer_id, payment_date, payment_method, ledger_transaction_id
     )
     SELECT
       'INVOICE_PAYMENT', ip.id, COALESCE(ip.receipt_number, ip.id::text),
       ROUND(le_cash.cash_debit::numeric, 2), 0, ROUND(le_cash.cash_debit::numeric, 2),
       '1015', 'UNSETTLED', i.customer_id, ip.payment_date::date, ip.payment_method, le_cash.txn_id
     FROM invoice_payments ip
     JOIN invoices i ON i.id = ip.invoice_id
     JOIN LATERAL (
       SELECT lt."Id" AS txn_id, SUM(le."DebitAmount") AS cash_debit
       FROM ledger_transactions lt
       JOIN ledger_entries le ON le."TransactionId" = lt."Id"
       JOIN accounts a ON a."Id" = le."AccountId"
       WHERE lt."ReferenceType" = 'INVOICE_PAYMENT'
         AND lt."ReferenceId" = ip.id
         AND a."AccountCode" = '1015'
         AND le."DebitAmount" > 0
       GROUP BY lt."Id"
     ) le_cash ON TRUE
     WHERE le_cash.cash_debit > 0.009
       AND NOT EXISTS (
         SELECT 1 FROM receipt_settlements rs
         WHERE rs.source_type = 'INVOICE_PAYMENT' AND rs.source_id = ip.id
       )
     ON CONFLICT (source_type, source_id) DO NOTHING`,
  );
  inserted += invPay.rowCount ?? 0;

  // Close deposit residuals for receipts that were fully reversed (no bank deposit applied).
  // Prevents Undeposited Funds recon: GL already credited by REVERSE, residual still counting.
  // Must keep chk_receipt_settlement_residual: residual = originating - settled.
  await conn.query(
    `UPDATE receipt_settlements rs
     SET settled_amount = rs.originating_amount,
         residual_amount = 0,
         settlement_status = 'SETTLED',
         updated_at = NOW()
     FROM ar_customer_payments p
     WHERE rs.source_type = 'AR_CUSTOMER_PAYMENT'
       AND rs.source_id = p.id
       AND p.status = 'REVERSED'
       AND rs.residual_amount > 0.009
       AND COALESCE(rs.settled_amount, 0) <= 0.009`,
  );

  // Align AR cash leg with 1015 debit when WHT split the payment
  await conn.query(
    `UPDATE receipt_settlements rs
     SET originating_amount = sub.cash_debit,
         residual_amount = ROUND((sub.cash_debit - rs.settled_amount)::numeric, 2),
         ledger_transaction_id = COALESCE(rs.ledger_transaction_id, sub.txn_id),
         settlement_status = CASE
           WHEN (sub.cash_debit - rs.settled_amount) <= 0.009 THEN 'SETTLED'
           WHEN rs.settled_amount > 0.009 THEN 'PARTIALLY_SETTLED'
           ELSE 'UNSETTLED'
         END,
         updated_at = NOW()
     FROM (
       SELECT lt."ReferenceId"::uuid AS payment_id, lt."Id" AS txn_id,
              ROUND(SUM(le."DebitAmount")::numeric, 2) AS cash_debit
       FROM ledger_transactions lt
       JOIN ledger_entries le ON le."TransactionId" = lt."Id"
       JOIN accounts a ON a."Id" = le."AccountId"
       WHERE lt."ReferenceType" = 'CUSTOMER_PAYMENT'
         AND a."AccountCode" = '1015'
         AND le."DebitAmount" > 0
       GROUP BY lt."ReferenceId", lt."Id"
     ) sub
     WHERE rs.source_type = 'AR_CUSTOMER_PAYMENT'
       AND rs.source_id = sub.payment_id
       AND sub.cash_debit > 0
       AND ABS(rs.originating_amount - sub.cash_debit) > 0.009
       AND rs.settled_amount <= 0.009`,
  );

  return inserted;
}

export async function listUnsettledReceipts(
  conn: DbConn,
  opts: { clearingAccountCode?: string; limit?: number } = {},
): Promise<ReceiptSettlement[]> {
  await syncReceiptSettlements(conn);
  const clearing = opts.clearingAccountCode ?? '1015';
  const limit = Math.min(500, Math.max(1, opts.limit ?? 200));

  const result = await conn.query<SettlementRow>(
    `SELECT rs.*, c.name AS customer_name
     FROM receipt_settlements rs
     LEFT JOIN customers c ON c.id = rs.customer_id
     LEFT JOIN ar_customer_payments p
       ON rs.source_type = 'AR_CUSTOMER_PAYMENT' AND p.id = rs.source_id
     WHERE rs.clearing_account_code = $1
       AND rs.residual_amount > 0.009
       AND rs.settlement_status IN ('UNSETTLED', 'PARTIALLY_SETTLED')
       AND (rs.source_type <> 'AR_CUSTOMER_PAYMENT' OR p.status IS DISTINCT FROM 'REVERSED')
     ORDER BY rs.payment_date ASC NULLS LAST, rs.created_at ASC
     LIMIT $2`,
    [clearing, limit],
  );
  return result.rows.map(mapSettlement);
}

export async function lockSettlement(
  conn: DbConn,
  sourceType: ReceiptSourceType,
  sourceId: string,
): Promise<ReceiptSettlement> {
  const result = await conn.query<SettlementRow>(
    `SELECT * FROM receipt_settlements
     WHERE source_type = $1 AND source_id = $2
     FOR UPDATE`,
    [sourceType, sourceId],
  );
  if (result.rows.length === 0) {
    await syncReceiptSettlements(conn);
    const retry = await conn.query<SettlementRow>(
      `SELECT * FROM receipt_settlements
       WHERE source_type = $1 AND source_id = $2
       FOR UPDATE`,
      [sourceType, sourceId],
    );
    if (retry.rows.length === 0) {
      throw Object.assign(new Error(`Receipt settlement not found: ${sourceType}/${sourceId}`), {
        code: 'NOT_FOUND',
      });
    }
    return mapSettlement(retry.rows[0]);
  }
  return mapSettlement(result.rows[0]);
}

export async function applySettlement(
  conn: DbConn,
  input: {
    sourceType: ReceiptSourceType;
    sourceId: string;
    amount: number;
    treasuryDocumentId: string;
    treasuryDocumentLineId?: string;
    sourceLabel?: string;
  },
): Promise<ReceiptSettlement> {
  const settlement = await lockSettlement(conn, input.sourceType, input.sourceId);
  assertDepositConsumesUnsettled({
    settlementStatus: settlement.settlementStatus,
    residualAmount: settlement.residualAmount,
    sourceLabel: input.sourceLabel ?? settlement.sourceNumber ?? undefined,
  });
  assertSettlementCeiling({
    applyAmount: input.amount,
    residualAmount: settlement.residualAmount,
    sourceLabel: input.sourceLabel ?? settlement.sourceNumber ?? undefined,
  });

  const amount = roundMoney(input.amount);
  const settledAmount = roundMoney(settlement.settledAmount + amount);
  const residualAmount = roundMoney(settlement.originatingAmount - settledAmount);
  const settlementStatus = statusFor(settledAmount, residualAmount);

  await conn.query(
    `UPDATE receipt_settlements
     SET settled_amount = $2,
         residual_amount = $3,
         settlement_status = $4,
         updated_at = NOW()
     WHERE id = $1`,
    [settlement.id, settledAmount, residualAmount, settlementStatus],
  );

  await conn.query(
    `INSERT INTO receipt_settlement_applications (
       receipt_settlement_id, treasury_document_id, treasury_document_line_id, amount
     ) VALUES ($1, $2, $3, $4)`,
    [
      settlement.id,
      input.treasuryDocumentId,
      input.treasuryDocumentLineId ?? null,
      amount,
    ],
  );

  return {
    ...settlement,
    settledAmount,
    residualAmount,
    settlementStatus,
  };
}

export async function reverseApplicationsForDocument(
  conn: DbConn,
  treasuryDocumentId: string,
): Promise<number> {
  const apps = await conn.query<{
    id: string;
    receipt_settlement_id: string;
    amount: string | number;
  }>(
    `SELECT id, receipt_settlement_id, amount
     FROM receipt_settlement_applications
     WHERE treasury_document_id = $1 AND reversed_at IS NULL
     FOR UPDATE`,
    [treasuryDocumentId],
  );

  for (const app of apps.rows) {
    const amount = roundMoney(Number(app.amount));
    await conn.query(
      `UPDATE receipt_settlements
       SET settled_amount = ROUND((settled_amount - $2)::numeric, 2),
           residual_amount = ROUND((residual_amount + $2)::numeric, 2),
           settlement_status = CASE
             WHEN ROUND((settled_amount - $2)::numeric, 2) <= 0.009 THEN 'UNSETTLED'
             WHEN ROUND((residual_amount + $2)::numeric, 2) <= 0.009 THEN 'SETTLED'
             ELSE 'PARTIALLY_SETTLED'
           END,
           updated_at = NOW()
       WHERE id = $1`,
      [app.receipt_settlement_id, amount],
    );
    await conn.query(
      `UPDATE receipt_settlement_applications SET reversed_at = NOW() WHERE id = $1`,
      [app.id],
    );
  }

  return apps.rows.length;
}

export async function getClearingGlBalance(
  conn: DbConn,
  accountCode = '1015',
): Promise<number> {
  // SSOT = LEDGER_NET_ACTIVE (same as Banking / Move Money / funds guard).
  // Bare POSTED orphans reverse-journal credits after AR receipt reverse (Henber −5.03M).
  // Unfiltered SUM of all entries can coincidentally net pairs, but includes DRAFT noise.
  const result = await conn.query<{ balance: string }>(
    `SELECT COALESCE(SUM(le."DebitAmount" - le."CreditAmount"), 0)::text AS balance
     FROM ledger_entries le
     JOIN ledger_transactions lt ON lt."Id" = le."TransactionId"
     JOIN accounts a ON a."Id" = le."AccountId"
     WHERE a."AccountCode" = $1
       AND ${LEDGER_NET_ACTIVE_SQL}`,
    [accountCode],
  );
  return Number(result.rows[0]?.balance ?? 0);
}

export async function sumUnsettledResidual(
  conn: DbConn,
  accountCode = '1015',
): Promise<number> {
  const result = await conn.query<{ total: string }>(
    `SELECT COALESCE(SUM(rs.residual_amount), 0)::text AS total
     FROM receipt_settlements rs
     LEFT JOIN ar_customer_payments p
       ON rs.source_type = 'AR_CUSTOMER_PAYMENT' AND p.id = rs.source_id
     WHERE rs.clearing_account_code = $1
       AND rs.residual_amount > 0.009
       AND (rs.source_type <> 'AR_CUSTOMER_PAYMENT' OR p.status IS DISTINCT FROM 'REVERSED')`,
    [accountCode],
  );
  return Number(result.rows[0]?.total ?? 0);
}

/**
 * Close undeposited residual when an AR receipt is reversed (not yet deposited).
 * Refuses if any amount was already applied on a Deposit Worksheet — reverse the deposit first.
 *
 * Enterprise rule: Undeposited Funds (1015) is a clearing account only.
 * Never reverse a receipt cash leg after it has been deposited (that over-credits 1015 → negative).
 */
export async function voidSettlementForReversedArPayment(
  conn: DbConn,
  paymentId: string,
): Promise<void> {
  const result = await conn.query<{
    id: string;
    settled_amount: string | number;
    residual_amount: string | number;
    source_number: string | null;
  }>(
    `SELECT id, settled_amount, residual_amount, source_number
     FROM receipt_settlements
     WHERE source_type = 'AR_CUSTOMER_PAYMENT' AND source_id = $1
     FOR UPDATE`,
    [paymentId],
  );

  // Belt-and-suspenders: even if settlement row missing/stale, block when deposit apps exist.
  const apps = await conn.query<{ n: string; amt: string }>(
    `SELECT COUNT(*)::text AS n, COALESCE(SUM(rsa.amount), 0)::text AS amt
     FROM receipt_settlement_applications rsa
     JOIN receipt_settlements rs ON rs.id = rsa.receipt_settlement_id
     WHERE rs.source_type = 'AR_CUSTOMER_PAYMENT'
       AND rs.source_id = $1
       AND rsa.reversed_at IS NULL`,
    [paymentId],
  );
  const appCount = Number(apps.rows[0]?.n || 0);
  const appAmt = Number(apps.rows[0]?.amt || 0);
  if (appCount > 0 || appAmt > 0.009) {
    throw Object.assign(
      new Error(
        `Cannot reverse receipt ${result.rows[0]?.source_number || paymentId}: ` +
          `${appAmt.toFixed(2)} already deposited via Deposit Worksheet. ` +
          `Reverse that deposit first, then reverse/correct the receipt. ` +
          `Undeposited Funds cannot go negative.`,
      ),
      { code: 'RECEIPT_ALREADY_DEPOSITED' },
    );
  }

  if (result.rows.length === 0) return;

  const row = result.rows[0];
  const settled = Number(row.settled_amount || 0);
  if (settled > 0.009) {
    throw Object.assign(
      new Error(
        `Cannot reverse receipt ${row.source_number || paymentId}: ` +
          `${settled.toFixed(2)} already deposited via Deposit Worksheet. ` +
          `Reverse that deposit first, then reverse the receipt. ` +
          `Undeposited Funds cannot go negative.`,
      ),
      { code: 'RECEIPT_ALREADY_DEPOSITED' },
    );
  }

  // Clear from undeposited pool. Constraint: residual = originating - settled.
  // SETTLED here means "no longer awaiting deposit" (reversed), not bank-deposited.
  await conn.query(
    `UPDATE receipt_settlements
     SET settled_amount = originating_amount,
         residual_amount = 0,
         settlement_status = 'SETTLED',
         updated_at = NOW()
     WHERE id = $1`,
    [row.id],
  );
}
