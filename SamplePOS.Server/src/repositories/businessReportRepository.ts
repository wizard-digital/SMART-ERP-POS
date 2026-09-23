import type { Pool, PoolClient } from 'pg';
import { pool as globalPool } from '../db/pool.js';
import { toUtcRange, BUSINESS_TIMEZONE } from '../utils/dateRange.js';
import { LEDGER_NET_ACTIVE_SQL } from '../utils/ledgerNetActive.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BusinessReportFilters {
  startDate?: string;
  endDate?: string;
  paymentMethod?: string;   // CASH | CREDIT | MOBILE_MONEY | CARD
  transactionType?: string; // SALE | EXPENSE | STOCK_MOVEMENT | GOODS_RECEIPT
  includeStockAdjustments?: boolean;
  includeExpenses?: boolean;
}

/** Section 1 — Money In: sales settlement, customer collections, opening AR */
export interface MoneyInRow {
  flow_type: string;
  flow_label: string;
  account_code: string;
  account_name: string;
  transaction_count: number;
  total_amount: string;
}

// Section 2 — Revenue by Product Category is now handled by reportsRepository.getSalesByCategory
// (reads from live sale_items transactions, not product_daily_summary state table)

/** Section 3 — Cost & stock impact from GL (COGS + inventory adjustments) */
export interface CostAndStockRow {
  account_code: string;
  account_name: string;
  entry_count: number;
  total_amount: string;
}

/** Section 4 — Expenses by GL account (6xxx/7xxx) */
export interface ExpenseByAccountRow {
  account_code: string;
  account_name: string;
  entry_count: number;
  total_amount: string;
  pct_of_total: string;
}

/** Section 4b — Supplier payments by funding account */
export interface SupplierPaymentByAccountRow {
  funding_account_code: string;
  funding_account_name: string;
  supplier_name: string;
  payment_count: number;
  total_paid: string;
}

/** Section 5 — summary totals (computed in service, but we gather raw numbers here) */
export interface SummaryTotalsRow {
  /** Net GL revenue (SALE CR − SALE_REFUND DR on REVENUE). Can be negative when returns of prior-period sales post in-range. */
  total_revenue: string;
  /** Period SALE credits on REVENUE (excludes 4010 returns). */
  gl_sales_revenue: string;
  /** Period SALE_REFUND debits on REVENUE (typically 4010). Includes cross-period returns. */
  gl_sales_returns: string;
  /** SALE_COGS debits on 5000 (gross goods issue). */
  total_cogs: string;
  /** SALE_COGS DR − refund CR on 5000 (SALE_REFUND / SALE_REFUND_COGS). */
  gl_net_cogs: string;
  total_expenses: string;
  total_stock_adjustments: string;
  sale_count: number;
}

/** Customer deposit summary for the period */
export interface CustomerDepositSummaryRow {
  total_deposited: string;
  total_cleared: string;
  deposit_count: number;
  clearing_count: number;
  outstanding_liability: string;
  active_deposit_count: number;
  customers_with_deposits: number;
}

/** Day + customer receipt line (AR collection or deposit taken) */
export interface CustomerReceiptDetailRow {
  business_date: string;
  customer_id: string;
  customer_number: string;
  customer_name: string;
  document_number: string;
  payment_method: string;
  amount: string;
}

// ---------------------------------------------------------------------------
// Helpers — date filter fragment for ledger_entries."EntryDate"
// ---------------------------------------------------------------------------

function dateClause(paramStart: number): string {
  return `
    AND ($${paramStart}::timestamptz IS NULL OR le."EntryDate" >= $${paramStart}::timestamptz)
    AND ($${paramStart + 1}::timestamptz IS NULL OR le."EntryDate" < $${paramStart + 1}::timestamptz)
  `;
}

/** Convert user-facing YYYY-MM-DD dates to UTC boundaries for TIMESTAMPTZ columns. */
function dateParams(f: BusinessReportFilters): (string | null)[] {
  if (!f.startDate && !f.endDate) return [null, null];
  if (f.startDate && f.endDate) {
    const { startUtc, endUtc } = toUtcRange(f.startDate, f.endDate, BUSINESS_TIMEZONE);
    return [startUtc, endUtc];
  }
  if (f.startDate) {
    const { startUtc } = toUtcRange(f.startDate, f.startDate, BUSINESS_TIMEZONE);
    return [startUtc, null];
  }
  const { endUtc } = toUtcRange(f.endDate!, f.endDate!, BUSINESS_TIMEZONE);
  return [null, endUtc];
}

// ---------------------------------------------------------------------------
// Section 1 — Money In (SAP/Odoo: settlement + collections + opening AR)
// ---------------------------------------------------------------------------

export async function getMoneyIn(
  filters: BusinessReportFilters,
  dbPool?: Pool | PoolClient
): Promise<MoneyInRow[]> {
  const db = dbPool || globalPool;

  const params: (string | null)[] = dateParams(filters);
  const paymentFilter = filters.paymentMethod ? `AND s.payment_method = $${params.length + 1}` : '';
  if (filters.paymentMethod) params.push(filters.paymentMethod);

  // Three GL flows that increase cash or receivables (debits on asset accounts):
  // 1. SALE_SETTLEMENT — cash/credit sale invoice (DR 1010 or DR 1200)
  // 2. CUSTOMER_COLLECTION — payment received (DR cash/bank, CR AR elsewhere)
  // 3. OPENING_BALANCE — customer AR brought forward (DR 1200)
  const query = `
    SELECT flow_type, flow_label, account_code, account_name,
           SUM(transaction_count)::integer AS transaction_count,
           ROUND(SUM(total_amount)::numeric, 2) AS total_amount
    FROM (
      SELECT
        'SALE_SETTLEMENT' AS flow_type,
        'Sales settlement (invoice)' AS flow_label,
        a."AccountCode" AS account_code,
        a."AccountName" AS account_name,
        COUNT(DISTINCT lt."Id")::integer AS transaction_count,
        COALESCE(SUM(le."DebitAmount"), 0) AS total_amount
      FROM ledger_entries le
      JOIN ledger_transactions lt ON lt."Id" = le."TransactionId"
      JOIN accounts a ON a."Id" = le."AccountId"
      LEFT JOIN sales s ON lt."ReferenceNumber" = s.sale_number
      WHERE lt."ReferenceType" = 'SALE'
        AND lt."Status" = 'POSTED'
        AND le."DebitAmount" > 0
        AND a."AccountType" = 'ASSET'
        AND (s.status IS NULL OR s.status NOT IN ('VOID', 'VOIDED_BY_RETURN', 'REFUNDED'))
        ${paymentFilter}
        ${dateClause(1)}
      GROUP BY a."AccountCode", a."AccountName"

      UNION ALL

      SELECT
        'CUSTOMER_COLLECTION' AS flow_type,
        'Customer payment received' AS flow_label,
        a."AccountCode" AS account_code,
        a."AccountName" AS account_name,
        COUNT(DISTINCT lt."Id")::integer AS transaction_count,
        COALESCE(SUM(le."DebitAmount"), 0) AS total_amount
      FROM ledger_entries le
      JOIN ledger_transactions lt ON lt."Id" = le."TransactionId"
      JOIN accounts a ON a."Id" = le."AccountId"
      WHERE lt."ReferenceType" IN ('CUSTOMER_PAYMENT', 'INVOICE_PAYMENT')
        AND lt."Status" = 'POSTED'
        AND le."DebitAmount" > 0
        AND a."AccountType" = 'ASSET'
        -- 1015 Undeposited Funds is the SSOT cash leg for AR receipts (and legacy paths may hit bank/cash)
        AND a."AccountCode" IN ('1010', '1015', '1020', '1030', '1040', '1050')
        ${dateClause(1)}
      GROUP BY a."AccountCode", a."AccountName"

      UNION ALL

      SELECT
        'OPENING_BALANCE' AS flow_type,
        'Customer opening balance (AR)' AS flow_label,
        a."AccountCode" AS account_code,
        a."AccountName" AS account_name,
        COUNT(DISTINCT lt."Id")::integer AS transaction_count,
        COALESCE(SUM(le."DebitAmount"), 0) AS total_amount
      FROM ledger_entries le
      JOIN ledger_transactions lt ON lt."Id" = le."TransactionId"
      JOIN accounts a ON a."Id" = le."AccountId"
      WHERE lt."ReferenceType" = 'CUSTOMER_OPENING_BALANCE'
        AND lt."Status" = 'POSTED'
        AND a."AccountCode" = '1200'
        AND le."DebitAmount" > 0
        ${dateClause(1)}
      GROUP BY a."AccountCode", a."AccountName"
    ) combined
  WHERE total_amount > 0
  GROUP BY flow_type, flow_label, account_code, account_name
  ORDER BY
    CASE flow_type
      WHEN 'SALE_SETTLEMENT' THEN 1
      WHEN 'CUSTOMER_COLLECTION' THEN 2
      WHEN 'OPENING_BALANCE' THEN 3
      ELSE 4
    END,
    account_code
  `;

  const result = await db.query(query, params);
  return result.rows;
}

// ---------------------------------------------------------------------------
// Section 3 — Cost & Stock Impact (COGS 5000 + inventory adjustment accounts 5110-5130, plus 4110 overage)
// ---------------------------------------------------------------------------

export async function getCostAndStock(
  filters: BusinessReportFilters,
  dbPool?: Pool | PoolClient
): Promise<CostAndStockRow[]> {
  const db = dbPool || globalPool;

  // COGS is posted as SALE_COGS (separate journal from revenue SALE).
  const refTypes = filters.includeStockAdjustments !== false
    ? ['SALE_COGS', 'STOCK_MOVEMENT', 'GOODS_RECEIPT', 'LOT_WRITE_DOWN']
    : ['SALE_COGS'];

  const query = `
    SELECT
      a."AccountCode"  AS account_code,
      a."AccountName"  AS account_name,
      COUNT(le."Id")::integer AS entry_count,
      ROUND(COALESCE(SUM(
        -- EXPENSE accounts (5110, 5120, 5130, 5000): positive = a cost
        -- INCOME accounts (4110 overage): negated → negative = a gain that offsets cost
        CASE WHEN a."NormalBalance" = 'DEBIT' THEN le."DebitAmount" - le."CreditAmount"
             ELSE -(le."CreditAmount" - le."DebitAmount")
        END
      ), 0)::numeric, 2) AS total_amount
    FROM ledger_entries le
    JOIN ledger_transactions lt ON lt."Id" = le."TransactionId"
    JOIN accounts a ON a."Id" = le."AccountId"
    LEFT JOIN sales s ON lt."ReferenceType" = 'SALE_COGS' AND lt."ReferenceId" = s.id
    WHERE lt."Status" = 'POSTED'
      AND lt."ReferenceType" = ANY($3::text[])
      AND (
        a."AccountCode" IN ('5000','5010','5110','5120','5130','5140','4110')
      )
      AND (lt."ReferenceType" != 'SALE_COGS' OR s.status IS NULL OR s.status NOT IN ('VOID', 'VOIDED_BY_RETURN', 'REFUNDED'))
      ${dateClause(1)}
    GROUP BY a."AccountCode", a."AccountName", a."NormalBalance"
    ORDER BY a."AccountCode"
  `;

  const result = await db.query(query, [
    ...dateParams(filters),
    refTypes,
  ]);
  return result.rows;
}

// ---------------------------------------------------------------------------
// Section 4 — Expenses by GL Account (6xxx operating + 7xxx financial)
// ---------------------------------------------------------------------------

export async function getExpensesByAccount(
  filters: BusinessReportFilters,
  dbPool?: Pool | PoolClient
): Promise<ExpenseByAccountRow[]> {
  const db = dbPool || globalPool;

  const query = `
    WITH expense_entries AS (
      SELECT
        a."AccountCode"  AS account_code,
        a."AccountName"  AS account_name,
        COUNT(le."Id")::integer AS entry_count,
        ROUND(COALESCE(SUM(le."DebitAmount"), 0)::numeric, 2) AS total_amount
      FROM ledger_entries le
      JOIN ledger_transactions lt ON lt."Id" = le."TransactionId"
      JOIN accounts a ON a."Id" = le."AccountId"
      WHERE ${LEDGER_NET_ACTIVE_SQL}
        AND lt."ReferenceType" IN ('EXPENSE', 'EXPENSE_PAYMENT')
        AND a."AccountType" = 'EXPENSE'
        AND le."DebitAmount" > 0
        ${dateClause(1)}
      GROUP BY a."AccountCode", a."AccountName"
    )
    SELECT
      account_code,
      account_name,
      entry_count,
      total_amount,
      CASE
        WHEN (SELECT SUM(total_amount) FROM expense_entries) > 0
        THEN ROUND(total_amount / (SELECT SUM(total_amount) FROM expense_entries) * 100, 2)
        ELSE 0
      END AS pct_of_total
    FROM expense_entries
    ORDER BY total_amount DESC
  `;

  const result = await db.query(query, dateParams(filters));
  return result.rows;
}

// ---------------------------------------------------------------------------
// Section 4b — Supplier Payments by Funding Account
// Shows which accounts (Cash-1010, Bank-1030) paid which suppliers
// ---------------------------------------------------------------------------

export async function getSupplierPaymentsByAccount(
  filters: BusinessReportFilters,
  dbPool?: Pool | PoolClient
): Promise<SupplierPaymentByAccountRow[]> {
  const db = dbPool || globalPool;

  const query = `
    SELECT
      a."AccountCode"  AS funding_account_code,
      a."AccountName"  AS funding_account_name,
      lt."Description" AS description,
      COUNT(DISTINCT lt."Id")::integer AS payment_count,
      ROUND(COALESCE(SUM(le."CreditAmount"), 0)::numeric, 2) AS total_paid
    FROM ledger_entries le
    JOIN ledger_transactions lt ON lt."Id" = le."TransactionId"
    JOIN accounts a ON a."Id" = le."AccountId"
    WHERE lt."Status" = 'POSTED'
      AND lt."ReferenceType" = 'SUPPLIER_PAYMENT'
      AND le."CreditAmount" > 0
      AND a."AccountType" IN ('ASSET', 'BANK')
      ${dateClause(1)}
    GROUP BY a."AccountCode", a."AccountName", lt."Description"
    ORDER BY total_paid DESC
  `;

  const rows = await db.query(query, dateParams(filters));

  // Extract supplier name from GL description: "Payment to supplier: XYZ"
  return rows.rows.map((r: Record<string, unknown>) => ({
    funding_account_code: r.funding_account_code as string,
    funding_account_name: r.funding_account_name as string,
    supplier_name: extractSupplierName(r.description as string),
    payment_count: r.payment_count as number,
    total_paid: r.total_paid as string,
  }));
}

/** Extract supplier name from GL description like "Payment to supplier: ABC Pharma" */
function extractSupplierName(description: string): string {
  const match = description?.match(/Payment to supplier:\s*(.+)/i);
  return match ? match[1].trim() : description || 'Unknown';
}

// ---------------------------------------------------------------------------
// Section 5 — Summary Totals (raw aggregates, service computes net)
// ---------------------------------------------------------------------------

export async function getSummaryTotals(
  filters: BusinessReportFilters,
  dbPool?: Pool | PoolClient
): Promise<SummaryTotalsRow> {
  const db = dbPool || globalPool;

  const params = dateParams(filters);
  const paymentParamIdx = filters.paymentMethod ? params.length + 1 : 0;
  if (filters.paymentMethod) {
    params.push(filters.paymentMethod);
  }
  // When payment method is set, keep only matching sale / original-sale refund rows.
  const paymentScope = paymentParamIdx
    ? `AND (
        (lt."ReferenceType" = 'SALE' AND s.payment_method::text = $${paymentParamIdx})
        OR (lt."ReferenceType" = 'SALE_REFUND' AND refund_sale.payment_method::text = $${paymentParamIdx})
      )`
    : '';
  const cogsPaymentScope = paymentParamIdx
    ? `AND (
        (lt."ReferenceType" = 'SALE_COGS' AND s.payment_method::text = $${paymentParamIdx})
        OR (lt."ReferenceType" IN ('SALE_REFUND', 'SALE_REFUND_COGS') AND refund_sale.payment_method::text = $${paymentParamIdx})
      )`
    : '';

  // Total revenue from GL — split sales vs returns so Management P&L can show both.
  //
  // SALE entries:      CR on REVENUE accounts (positive revenue) — typically 4000
  // SALE_REFUND entries: DR on REVENUE accounts (contra) — typically 4010
  //
  // Cross-period returns: SALE_REFUND can post in this range for a sale dated earlier.
  // That correctly hits 4010 for the period, but must NOT replace period sales revenue
  // in the category / management KPI strip (see businessReportService).
  const revenueQuery = `
    SELECT
      ROUND(COALESCE(SUM(
        CASE
          WHEN lt."ReferenceType" = 'SALE' AND le."CreditAmount" > 0
               AND (s.status IS NULL OR s.status NOT IN ('VOID', 'VOIDED_BY_RETURN', 'REFUNDED'))
            THEN le."CreditAmount"
          WHEN lt."ReferenceType" = 'SALE_REFUND' AND le."DebitAmount" > 0
               AND (refund_sale.status IS NULL OR refund_sale.status NOT IN ('VOID', 'VOIDED_BY_RETURN', 'REFUNDED'))
            THEN -le."DebitAmount"
          ELSE 0
        END
      ), 0)::numeric, 2) AS total_revenue,
      ROUND(COALESCE(SUM(
        CASE
          WHEN lt."ReferenceType" = 'SALE' AND le."CreditAmount" > 0
               AND (s.status IS NULL OR s.status NOT IN ('VOID', 'VOIDED_BY_RETURN', 'REFUNDED'))
            THEN le."CreditAmount"
          ELSE 0
        END
      ), 0)::numeric, 2) AS gl_sales_revenue,
      ROUND(COALESCE(SUM(
        CASE
          WHEN lt."ReferenceType" = 'SALE_REFUND' AND le."DebitAmount" > 0
               AND (refund_sale.status IS NULL OR refund_sale.status NOT IN ('VOID', 'VOIDED_BY_RETURN', 'REFUNDED'))
            THEN le."DebitAmount"
          ELSE 0
        END
      ), 0)::numeric, 2) AS gl_sales_returns,
      COUNT(DISTINCT CASE
        WHEN lt."ReferenceType" = 'SALE' AND le."CreditAmount" > 0
             AND (s.status IS NULL OR s.status NOT IN ('VOID', 'VOIDED_BY_RETURN', 'REFUNDED'))
        THEN lt."Id"
      END)::integer AS sale_count
    FROM ledger_entries le
    JOIN ledger_transactions lt ON lt."Id" = le."TransactionId"
    JOIN accounts a ON a."Id" = le."AccountId"
    LEFT JOIN sales s
      ON lt."ReferenceType" = 'SALE' AND lt."ReferenceNumber" = s.sale_number
    LEFT JOIN sale_refunds sr
      ON lt."ReferenceType" = 'SALE_REFUND' AND lt."ReferenceId" = sr.id
    LEFT JOIN sales refund_sale ON sr.sale_id = refund_sale.id
    WHERE lt."ReferenceType" IN ('SALE', 'SALE_REFUND')
      AND lt."Status" = 'POSTED'
      AND a."AccountType" = 'REVENUE'
      ${paymentScope}
      ${dateClause(1)}
  `;

  // Total COGS from GL — goods-issue (SALE_COGS DR) net of refund inventory restore (CR on 5000).
  const cogsQuery = `
    SELECT
      ROUND(COALESCE(SUM(
        CASE
          WHEN lt."ReferenceType" = 'SALE_COGS' AND le."DebitAmount" > 0
               AND (s.status IS NULL OR s.status NOT IN ('VOID', 'VOIDED_BY_RETURN', 'REFUNDED'))
            THEN le."DebitAmount"
          ELSE 0
        END
      ), 0)::numeric, 2) AS total_cogs,
      ROUND(COALESCE(SUM(
        CASE
          WHEN lt."ReferenceType" = 'SALE_COGS' AND le."DebitAmount" > 0
               AND (s.status IS NULL OR s.status NOT IN ('VOID', 'VOIDED_BY_RETURN', 'REFUNDED'))
            THEN le."DebitAmount"
          WHEN lt."ReferenceType" IN ('SALE_REFUND', 'SALE_REFUND_COGS') AND le."CreditAmount" > 0
               AND (refund_sale.status IS NULL OR refund_sale.status NOT IN ('VOID', 'VOIDED_BY_RETURN', 'REFUNDED'))
            THEN -le."CreditAmount"
          ELSE 0
        END
      ), 0)::numeric, 2) AS gl_net_cogs
    FROM ledger_entries le
    JOIN ledger_transactions lt ON lt."Id" = le."TransactionId"
    JOIN accounts a ON a."Id" = le."AccountId"
    LEFT JOIN sales s ON lt."ReferenceType" = 'SALE_COGS' AND lt."ReferenceId" = s.id
    LEFT JOIN sale_refunds sr
      ON lt."ReferenceType" IN ('SALE_REFUND', 'SALE_REFUND_COGS') AND lt."ReferenceId" = sr.id
    LEFT JOIN sales refund_sale ON sr.sale_id = refund_sale.id
    WHERE lt."ReferenceType" IN ('SALE_COGS', 'SALE_REFUND', 'SALE_REFUND_COGS')
      AND lt."Status" = 'POSTED'
      AND a."AccountCode" = '5000'
      ${cogsPaymentScope}
      ${dateClause(1)}
  `;

  // Total expenses from GL (DR on EXPENSE accounts for EXPENSE/EXPENSE_PAYMENT)
  // Expenses are not payment-method scoped (operating P&L, not till mix).
  const expenseParams = dateParams(filters);
  const expenseQuery = `
    SELECT
      ROUND(COALESCE(SUM(le."DebitAmount"), 0)::numeric, 2) AS total_expenses
    FROM ledger_entries le
    JOIN ledger_transactions lt ON lt."Id" = le."TransactionId"
    JOIN accounts a ON a."Id" = le."AccountId"
    WHERE ${LEDGER_NET_ACTIVE_SQL}
      AND lt."ReferenceType" IN ('EXPENSE', 'EXPENSE_PAYMENT')
      AND a."AccountType" = 'EXPENSE'
      AND le."DebitAmount" > 0
      ${dateClause(1)}
  `;

  // Stock adjustments from GL (DR/CR on adjustment accounts for STOCK_MOVEMENT)
  const stockAdjQuery = `
    SELECT
      ROUND(COALESCE(SUM(
        -- Expense accounts (5110, 5120, 5130): positive = stock loss
        -- Income account (4110 overage): negated → negative = stock gain
        -- Net result: positive = net stock cost, negative = net stock gain
        CASE WHEN a."NormalBalance" = 'DEBIT' THEN le."DebitAmount" - le."CreditAmount"
             ELSE -(le."CreditAmount" - le."DebitAmount")
        END
      ), 0)::numeric, 2) AS total_stock_adjustments
    FROM ledger_entries le
    JOIN ledger_transactions lt ON lt."Id" = le."TransactionId"
    JOIN accounts a ON a."Id" = le."AccountId"
    WHERE lt."Status" = 'POSTED'
      AND lt."ReferenceType" IN ('STOCK_MOVEMENT', 'LOT_WRITE_DOWN')
      AND a."AccountCode" IN ('5110','5120','5130','5140','4110')
      ${dateClause(1)}
  `;

  const [revResult, cogsResult, expResult, adjResult] = await Promise.all([
    db.query(revenueQuery, params),
    db.query(cogsQuery, params),
    db.query(expenseQuery, expenseParams),
    db.query(stockAdjQuery, expenseParams),
  ]);

  const rev = revResult.rows[0] || {};
  const cogs = cogsResult.rows[0] || {};
  const exp = expResult.rows[0] || {};
  const adj = adjResult.rows[0] || {};

  return {
    total_revenue: rev.total_revenue || '0',
    gl_sales_revenue: rev.gl_sales_revenue || '0',
    gl_sales_returns: rev.gl_sales_returns || '0',
    total_cogs: cogs.total_cogs || '0',
    gl_net_cogs: cogs.gl_net_cogs || '0',
    total_expenses: exp.total_expenses || '0',
    total_stock_adjustments: adj.total_stock_adjustments || '0',
    sale_count: parseInt(rev.sale_count, 10) || 0,
  };
}

// ---------------------------------------------------------------------------
// Customer Deposits Summary — deposits received and clearings in the period
// ---------------------------------------------------------------------------

export async function getCustomerDepositSummary(
  filters: BusinessReportFilters,
  dbPool?: Pool | PoolClient
): Promise<CustomerDepositSummaryRow> {
  const db = dbPool || globalPool;
  const params = dateParams(filters);

  // Deposits received in period
  const depositQuery = `
    SELECT
      COUNT(cd.id)::integer AS deposit_count,
      ROUND(COALESCE(SUM(cd.amount), 0)::numeric, 2) AS total_deposited
    FROM pos_customer_deposits cd
    WHERE cd.status IN ('ACTIVE', 'DEPLETED')
      AND ($1::timestamptz IS NULL OR cd.created_at >= $1::timestamptz)
      AND ($2::timestamptz IS NULL OR cd.created_at < $2::timestamptz)
  `;

  // Clearings applied in period
  const clearingQuery = `
    SELECT
      COUNT(dc.id)::integer AS clearing_count,
      ROUND(COALESCE(SUM(dc.amount), 0)::numeric, 2) AS total_cleared
    FROM down_payment_clearings dc
    WHERE ($1::timestamptz IS NULL OR dc.created_at >= $1::timestamptz)
      AND ($2::timestamptz IS NULL OR dc.created_at < $2::timestamptz)
  `;

  // Outstanding liability (all-time)
  const liabilityQuery = `
    SELECT
      COUNT(cd.id)::integer AS active_deposit_count,
      COUNT(DISTINCT cd.customer_id)::integer AS customers_with_deposits,
      ROUND(COALESCE(SUM(cd.amount_available), 0)::numeric, 2) AS outstanding_liability
    FROM pos_customer_deposits cd
    WHERE cd.status = 'ACTIVE' AND cd.amount_available > 0
  `;

  const [depResult, clrResult, liabResult] = await Promise.all([
    db.query(depositQuery, params),
    db.query(clearingQuery, params),
    db.query(liabilityQuery),
  ]);

  const dep = depResult.rows[0] || {};
  const clr = clrResult.rows[0] || {};
  const liab = liabResult.rows[0] || {};

  return {
    total_deposited: dep.total_deposited || '0',
    total_cleared: clr.total_cleared || '0',
    deposit_count: parseInt(dep.deposit_count, 10) || 0,
    clearing_count: parseInt(clr.clearing_count, 10) || 0,
    outstanding_liability: liab.outstanding_liability || '0',
    active_deposit_count: parseInt(liab.active_deposit_count, 10) || 0,
    customers_with_deposits: parseInt(liab.customers_with_deposits, 10) || 0,
  };
}

// ---------------------------------------------------------------------------
// AR collections by day + customer (open-item receipts → Undeposited Funds 1015)
// ---------------------------------------------------------------------------

export async function getArCollectionsByDay(
  filters: BusinessReportFilters,
  dbPool?: Pool | PoolClient
): Promise<CustomerReceiptDetailRow[]> {
  const db = dbPool || globalPool;
  const startDate = filters.startDate?.trim() || null;
  const endDate = filters.endDate?.trim() || null;

  const query = `
    SELECT
      p.payment_date::text AS business_date,
      c.id::text AS customer_id,
      c.customer_number,
      c.name AS customer_name,
      p.payment_number AS document_number,
      p.payment_method,
      ROUND(p.total_amount::numeric, 2)::text AS amount
    FROM ar_customer_payments p
    JOIN customers c ON c.id = p.customer_id
    WHERE p.status <> 'REVERSED'
      AND p.reversal_of_payment_id IS NULL
      AND ($1::date IS NULL OR p.payment_date >= $1::date)
      AND ($2::date IS NULL OR p.payment_date <= $2::date)
    ORDER BY p.payment_date ASC, c.name ASC, p.payment_number ASC
  `;

  const result = await db.query(query, [startDate, endDate]);
  return result.rows;
}

// ---------------------------------------------------------------------------
// Customer deposits taken by day + customer (prepayments → Undeposited Funds 1015)
// ---------------------------------------------------------------------------

export async function getCustomerDepositsByDay(
  filters: BusinessReportFilters,
  dbPool?: Pool | PoolClient
): Promise<CustomerReceiptDetailRow[]> {
  const db = dbPool || globalPool;
  const params = dateParams(filters);

  const query = `
    SELECT
      (cd.created_at AT TIME ZONE '${BUSINESS_TIMEZONE}')::date::text AS business_date,
      c.id::text AS customer_id,
      c.customer_number,
      c.name AS customer_name,
      cd.deposit_number AS document_number,
      cd.payment_method,
      ROUND(cd.amount::numeric, 2)::text AS amount
    FROM pos_customer_deposits cd
    JOIN customers c ON c.id = cd.customer_id
    WHERE cd.status IN ('ACTIVE', 'DEPLETED')
      AND ($1::timestamptz IS NULL OR cd.created_at >= $1::timestamptz)
      AND ($2::timestamptz IS NULL OR cd.created_at < $2::timestamptz)
    ORDER BY business_date ASC, c.name ASC, cd.deposit_number ASC
  `;

  const result = await db.query(query, params);
  return result.rows;
}
