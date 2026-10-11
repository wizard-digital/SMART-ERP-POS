/**
 * Centralized AR open-item reconciliation (SAP / Odoo SSOT).
 *
 * Formula:
 *   AR subledger = Σ GREATEST(0, open invoice amount_due − unallocated AR receipts)
 *   AR GL (integrity) = net-active 1200 (Debit − Credit)
 */
import type { Pool, PoolClient } from 'pg';
import { Money } from '../../utils/money.js';
import { LEDGER_NET_ACTIVE_SQL } from '../../utils/ledgerNetActive.js';

export type ArDbConn = Pool | PoolClient;

export type ArQueryContext = { asOfDate?: string };

export const AR_INACTIVE_INVOICE_STATUSES = ['CANCELLED', 'VOIDED', 'DRAFT'] as const;

/** Open AR documents: POS invoices, opening balances, and distribution deliveries. */
export const AR_OPEN_DOCUMENT_TYPES = ['INVOICE', 'OPENING_BALANCE', 'DIST_INVOICE'] as const;

export const AR_OPEN_DOCUMENT_TYPE_IN_SQL = `'INVOICE', 'OPENING_BALANCE', 'DIST_INVOICE'`;

export const AR_PAYMENT_STATUSES = ['POSTED', 'PARTIALLY_ALLOCATED', 'FULLY_ALLOCATED'] as const;

function asOfDateParam(ctx?: ArQueryContext): string[] {
  return ctx?.asOfDate ? [ctx.asOfDate] : [];
}

function glAsOfFilter(ctx?: ArQueryContext, ltAlias = 'lt'): string {
  return ctx?.asOfDate ? `AND ${ltAlias}."TransactionDate"::DATE <= $1::date` : '';
}

function invoiceAsOfFilter(ctx?: ArQueryContext): string {
  return ctx?.asOfDate ? `AND i.issue_date::DATE <= $1::date` : '';
}

function paymentAsOfFilter(ctx?: ArQueryContext): string {
  return ctx?.asOfDate ? `AND p.payment_date::DATE <= $1::date` : '';
}

/** Net-active GL 1200 (asset: debit − credit). */
export async function computeArGlNetActive(conn: ArDbConn, ctx?: ArQueryContext): Promise<number> {
  const params = asOfDateParam(ctx);
  const res = await conn.query(
    `
    SELECT COALESCE(SUM(le."DebitAmount") - SUM(le."CreditAmount"), 0) AS gl_balance
    FROM ledger_entries le
    JOIN ledger_transactions lt ON le."TransactionId" = lt."Id"
    JOIN accounts a ON le."AccountId" = a."Id"
    WHERE a."AccountCode" = '1200'
      AND ${LEDGER_NET_ACTIVE_SQL}
      ${glAsOfFilter(ctx)}
    `,
    params,
  );
  return Money.toNumber(Money.parseDb(res.rows[0]?.gl_balance ?? 0));
}

/** Gross posted GL 1200 (includes reversal pairs). */
export async function computeArGlGrossPosted(conn: ArDbConn, ctx?: ArQueryContext): Promise<number> {
  const params = asOfDateParam(ctx);
  const res = await conn.query(
    `
    SELECT COALESCE(SUM(le."DebitAmount") - SUM(le."CreditAmount"), 0) AS gl_balance
    FROM ledger_entries le
    JOIN ledger_transactions lt ON le."TransactionId" = lt."Id"
    JOIN accounts a ON le."AccountId" = a."Id"
    WHERE a."AccountCode" = '1200'
      AND lt."Status" = 'POSTED'
      ${glAsOfFilter(ctx)}
    `,
    params,
  );
  return Money.toNumber(Money.parseDb(res.rows[0]?.gl_balance ?? 0));
}

/** Customer-scoped net-active GL 1200. */
export async function computeArGlCustomerScope(conn: ArDbConn, ctx?: ArQueryContext): Promise<number> {
  const params = asOfDateParam(ctx);
  const res = await conn.query(
    `
    SELECT COALESCE(SUM(le."DebitAmount") - SUM(le."CreditAmount"), 0) AS gl_balance
    FROM ledger_entries le
    JOIN ledger_transactions lt ON le."TransactionId" = lt."Id"
    JOIN accounts a ON le."AccountId" = a."Id"
    WHERE a."AccountCode" = '1200'
      AND UPPER(le."EntityType") = 'CUSTOMER'
      AND le."EntityId" IS NOT NULL
      AND ${LEDGER_NET_ACTIVE_SQL}
      ${glAsOfFilter(ctx)}
    `,
    params,
  );
  return Money.toNumber(Money.parseDb(res.rows[0]?.gl_balance ?? 0));
}

/** Open-item subledger — invoices − unallocated receipts (all customers). */
export async function computeArOpenItemSubledger(
  conn: ArDbConn,
  ctx?: ArQueryContext,
): Promise<number> {
  const params = asOfDateParam(ctx);
  const res = await conn.query(
    `
    SELECT COALESCE(SUM(
      GREATEST(0, COALESCE(inv.inv_due, 0) - COALESCE(pay.unalloc, 0))
    ), 0) AS open_item
    FROM customers c
    LEFT JOIN LATERAL (
      SELECT SUM(i.amount_due) AS inv_due
      FROM invoices i
      WHERE i.customer_id = c.id
        AND COALESCE(i.document_type, 'INVOICE') IN (${AR_OPEN_DOCUMENT_TYPE_IN_SQL})
        AND i.status NOT IN ('CANCELLED', 'VOIDED', 'DRAFT')
        ${invoiceAsOfFilter(ctx)}
    ) inv ON TRUE
    LEFT JOIN LATERAL (
      SELECT SUM(p.unallocated_amount) AS unalloc
      FROM ar_customer_payments p
      WHERE p.customer_id = c.id
        AND p.status IN ('POSTED', 'PARTIALLY_ALLOCATED', 'FULLY_ALLOCATED')
        ${paymentAsOfFilter(ctx)}
    ) pay ON TRUE
    WHERE c.is_active = true
    `,
    params,
  );
  return Money.toNumber(Money.parseDb(res.rows[0]?.open_item ?? 0));
}

export async function computeUnallocatedArPayments(
  conn: ArDbConn,
  ctx?: ArQueryContext,
): Promise<number> {
  const params = asOfDateParam(ctx);
  const res = await conn.query(
    `
    SELECT COALESCE(SUM(unallocated_amount), 0) AS unalloc
    FROM ar_customer_payments p
    WHERE p.status IN ('POSTED', 'PARTIALLY_ALLOCATED', 'FULLY_ALLOCATED')
      AND COALESCE(p.unallocated_amount, 0) > 0.009
      ${paymentAsOfFilter(ctx)}
    `,
    params,
  );
  return Money.toNumber(Money.parseDb(res.rows[0]?.unalloc ?? 0));
}

export async function computeCustomersTableSum(conn: ArDbConn): Promise<number> {
  const res = await conn.query(`
    SELECT COALESCE(SUM(balance), 0) AS total
    FROM customers
    WHERE is_active = true
  `);
  return Money.toNumber(Money.parseDb(res.rows[0]?.total ?? 0));
}

export function arMaterialityThreshold(glBalance: number): number {
  const base = Math.max(Math.abs(glBalance) * 0.0001, 500);
  return Math.min(base, 5000);
}
