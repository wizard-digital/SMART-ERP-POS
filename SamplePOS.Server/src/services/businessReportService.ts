import type { Pool, PoolClient } from 'pg';
import { pool as globalPool } from '../db/pool.js';
import { Money } from '../utils/money.js';
import logger from '../utils/logger.js';
import { ValidationError } from '../middleware/errorHandler.js';
import * as repo from '../repositories/businessReportRepository.js';
import type { BusinessReportFilters } from '../repositories/businessReportRepository.js';
import { reportsRepository } from '../modules/reports/reportsRepository.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function requireReportDates(filters: BusinessReportFilters): { startDate: string; endDate: string } {
  const startDate = filters.startDate?.trim() ?? '';
  const endDate = filters.endDate?.trim() ?? '';
  if (!ISO_DATE.test(startDate) || !ISO_DATE.test(endDate)) {
    throw new ValidationError('start_date and end_date are required (YYYY-MM-DD)');
  }
  if (startDate > endDate) {
    throw new ValidationError('start_date must be on or before end_date');
  }
  return { startDate, endDate };
}

// ---------------------------------------------------------------------------
// Section 1 — Money In
// ---------------------------------------------------------------------------

export interface MoneyInEntry {
  flowType: string;
  flowLabel: string;
  accountCode: string;
  accountName: string;
  transactionCount: number;
  totalAmount: number;
}

// ---------------------------------------------------------------------------
// Section 2 — Revenue by Product Category
// ---------------------------------------------------------------------------

export interface RevenueByCategoryEntry {
  categoryName: string;
  transactionCount: number;
  unitsSold: number;
  totalRevenue: number;
  totalCogs: number;
  grossProfit: number;
  grossMarginPct: number;
}

// ---------------------------------------------------------------------------
// Section 3 — Cost & Stock Impact
// ---------------------------------------------------------------------------

export interface CostAndStockEntry {
  accountCode: string;
  accountName: string;
  entryCount: number;
  totalAmount: number;
}

// ---------------------------------------------------------------------------
// Section 4 — Expenses by Account
// ---------------------------------------------------------------------------

export interface ExpenseByAccountEntry {
  accountCode: string;
  accountName: string;
  entryCount: number;
  totalAmount: number;
  pctOfTotal: number;
}

// ---------------------------------------------------------------------------
// Section 4b — Supplier Payments by Funding Account
// ---------------------------------------------------------------------------

export interface SupplierPaymentByAccountEntry {
  fundingAccountCode: string;
  fundingAccountName: string;
  supplierName: string;
  paymentCount: number;
  totalPaid: number;
}

// ---------------------------------------------------------------------------
// Customer Deposits (Liability section)
// ---------------------------------------------------------------------------

export interface CustomerDepositSummary {
  totalDeposited: number;
  totalCleared: number;
  depositCount: number;
  clearingCount: number;
  outstandingLiability: number;
  activeDepositCount: number;
  customersWithDeposits: number;
  /** Additive: deposits taken in period, day → customer lines */
  byDay: CustomerReceiptsDayGroup[];
}

// ---------------------------------------------------------------------------
// AR collections / deposits — day + customer breakdown (additive)
// ---------------------------------------------------------------------------

export interface CustomerReceiptLine {
  businessDate: string;
  customerId: string;
  customerNumber: string;
  customerName: string;
  documentNumber: string;
  paymentMethod: string;
  amount: number;
}

export interface CustomerReceiptsDayGroup {
  businessDate: string;
  totalAmount: number;
  receiptCount: number;
  lines: CustomerReceiptLine[];
}

export interface ArCollectionsSection {
  totalCollected: number;
  paymentCount: number;
  customerCount: number;
  byDay: CustomerReceiptsDayGroup[];
}

export interface CustomerReceiptsDayBreakdown {
  arCollections: ArCollectionsSection;
  customerDeposits: {
    totalDeposited: number;
    depositCount: number;
    customerCount: number;
    byDay: CustomerReceiptsDayGroup[];
  };
}

// ---------------------------------------------------------------------------
// Section 5 — Summary
// ---------------------------------------------------------------------------

export interface BusinessSummary {
  /**
   * Management P&L primary revenue = sum of Section 2 category rows (period sales).
   * Not GL net (SALE − SALE_REFUND): cross-period returns live in glSalesReturns.
   */
  totalRevenue: number;
  totalCogs: number;
  grossProfit: number;
  grossMarginPct: number;
  totalExpenses: number;
  totalStockAdjustments: number;
  totalSupplierPayments: number;
  netProfit: number;
  netMarginPct: number;
  saleCount: number;
  /** Period SALE credits on REVENUE (GL). */
  glSalesRevenue: number;
  /** Period SALE_REFUND debits on REVENUE (typically 4010), incl. cross-period returns. */
  glSalesReturns: number;
  /** GL net revenue (sales − returns). Informational; may be negative. */
  glNetRevenue: number;
  /** SALE_COGS DR on 5000 (gross). */
  glGrossCogs: number;
  /** SALE_COGS DR − refund CR on 5000. */
  glNetCogs: number;
}

// ---------------------------------------------------------------------------
// Full report shape
// ---------------------------------------------------------------------------

export interface BusinessPerformanceReport {
  summary: BusinessSummary;
  moneyIn: MoneyInEntry[];
  revenueByCategory: RevenueByCategoryEntry[];
  costAndStock: CostAndStockEntry[];
  expensesByAccount: ExpenseByAccountEntry[];
  supplierPaymentsByAccount: SupplierPaymentByAccountEntry[];
  customerDeposits: CustomerDepositSummary;
  /** Additive: AR collections received in period (posts to Undeposited Funds) */
  arCollections: ArCollectionsSection;
}

// ---------------------------------------------------------------------------
// Main report builder
// ---------------------------------------------------------------------------

function mapReceiptLines(rows: repo.CustomerReceiptDetailRow[]): CustomerReceiptLine[] {
  return rows.map((r) => ({
    businessDate: String(r.business_date),
    customerId: String(r.customer_id),
    customerNumber: String(r.customer_number || ''),
    customerName: String(r.customer_name || ''),
    documentNumber: String(r.document_number || ''),
    paymentMethod: String(r.payment_method || ''),
    amount: Money.toNumber(Money.parseDb(r.amount)),
  }));
}

function groupReceiptsByDay(lines: CustomerReceiptLine[]): CustomerReceiptsDayGroup[] {
  const byDate = new Map<string, CustomerReceiptLine[]>();
  for (const line of lines) {
    const list = byDate.get(line.businessDate) || [];
    list.push(line);
    byDate.set(line.businessDate, list);
  }
  return Array.from(byDate.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([businessDate, dayLines]) => ({
      businessDate,
      receiptCount: dayLines.length,
      totalAmount: dayLines.reduce(
        (sum, l) => Money.toNumber(Money.add(sum, l.amount)),
        0,
      ),
      lines: dayLines,
    }));
}

function buildArCollectionsSection(rows: repo.CustomerReceiptDetailRow[]): ArCollectionsSection {
  const lines = mapReceiptLines(rows);
  const customerIds = new Set(lines.map((l) => l.customerId));
  return {
    totalCollected: lines.reduce((sum, l) => Money.toNumber(Money.add(sum, l.amount)), 0),
    paymentCount: lines.length,
    customerCount: customerIds.size,
    byDay: groupReceiptsByDay(lines),
  };
}

/**
 * Lightweight day breakdown of cash receipts into Undeposited Funds:
 * AR collections + customer deposits taken. Safe for cashiers (reports.read).
 */
export async function getCustomerReceiptsDayBreakdown(
  filters: BusinessReportFilters,
  dbPool?: Pool | PoolClient
): Promise<CustomerReceiptsDayBreakdown> {
  const pool = dbPool || globalPool;
  const { startDate, endDate } = requireReportDates(filters);
  const datedFilters: BusinessReportFilters = { ...filters, startDate, endDate };

  const [arRows, depositRows] = await Promise.all([
    repo.getArCollectionsByDay(datedFilters, pool),
    repo.getCustomerDepositsByDay(datedFilters, pool),
  ]);

  const arCollections = buildArCollectionsSection(arRows);
  const depositLines = mapReceiptLines(depositRows);
  const depositCustomerIds = new Set(depositLines.map((l) => l.customerId));

  return {
    arCollections,
    customerDeposits: {
      totalDeposited: depositLines.reduce(
        (sum, l) => Money.toNumber(Money.add(sum, l.amount)),
        0,
      ),
      depositCount: depositLines.length,
      customerCount: depositCustomerIds.size,
      byDay: groupReceiptsByDay(depositLines),
    },
  };
}

export async function getBusinessPerformanceReport(
  filters: BusinessReportFilters,
  dbPool?: Pool | PoolClient
): Promise<BusinessPerformanceReport> {
  const pool = dbPool || globalPool;
  const { startDate, endDate } = requireReportDates(filters);
  const datedFilters: BusinessReportFilters = { ...filters, startDate, endDate };

  try {
    // Run sections in parallel (additive receipt queries do not alter existing totals)
    const [
      moneyInRows,
      revRows,
      costRows,
      expRows,
      supplierPayRows,
      totals,
      depositSummary,
      arCollectionRows,
      depositDetailRows,
    ] = await Promise.all([
      repo.getMoneyIn(datedFilters, pool),
      reportsRepository.getSalesByCategory(pool as Pool, {
        startDate,
        endDate,
        paymentMethod: datedFilters.paymentMethod,
      }),
      repo.getCostAndStock(datedFilters, pool),
      datedFilters.includeExpenses !== false
        ? repo.getExpensesByAccount(datedFilters, pool)
        : Promise.resolve([]),
      repo.getSupplierPaymentsByAccount(datedFilters, pool),
      repo.getSummaryTotals(datedFilters, pool),
      repo.getCustomerDepositSummary(datedFilters, pool),
      repo.getArCollectionsByDay(datedFilters, pool),
      repo.getCustomerDepositsByDay(datedFilters, pool),
    ]);

    // --- Normalize Section 1 ---
    const moneyIn: MoneyInEntry[] = moneyInRows.map((r) => ({
      flowType: r.flow_type,
      flowLabel: r.flow_label,
      accountCode: r.account_code,
      accountName: r.account_name,
      transactionCount: r.transaction_count,
      totalAmount: Money.toNumber(Money.parseDb(r.total_amount)),
    }));

    // --- Normalize Section 2 ---
    // revRows is SalesByCategoryRow[] from canonical reportsRepository (already typed numbers)
    const revenueByCategory: RevenueByCategoryEntry[] = revRows.map((r) => ({
      categoryName: r.category,
      transactionCount: r.transactionCount,
      unitsSold: r.totalQuantitySold,
      totalRevenue: r.totalRevenue,
      totalCogs: r.totalCost,
      grossProfit: r.grossProfit,
      grossMarginPct: r.profitMargin,
    }));

    // --- Normalize Section 3 ---
    const costAndStock: CostAndStockEntry[] = costRows.map((r) => ({
      accountCode: r.account_code,
      accountName: r.account_name,
      entryCount: r.entry_count,
      totalAmount: Money.toNumber(Money.parseDb(r.total_amount)),
    }));

    // --- Normalize Section 4 ---
    const expensesByAccount: ExpenseByAccountEntry[] = expRows.map((r) => ({
      accountCode: r.account_code,
      accountName: r.account_name,
      entryCount: r.entry_count,
      totalAmount: Money.toNumber(Money.parseDb(r.total_amount)),
      pctOfTotal: Money.toNumber(Money.parseDb(r.pct_of_total)),
    }));

    // --- Normalize Section 4b ---
    const supplierPaymentsByAccount: SupplierPaymentByAccountEntry[] = supplierPayRows.map((r) => ({
      fundingAccountCode: r.funding_account_code,
      fundingAccountName: r.funding_account_name,
      supplierName: r.supplier_name,
      paymentCount: r.payment_count,
      totalPaid: Money.toNumber(Money.parseDb(r.total_paid)),
    }));

    const arCollections = buildArCollectionsSection(arCollectionRows);
    const depositByDay = groupReceiptsByDay(mapReceiptLines(depositDetailRows));

    // --- Normalize Customer Deposits ---
    const customerDeposits: CustomerDepositSummary = {
      totalDeposited: Money.toNumber(Money.parseDb(depositSummary.total_deposited)),
      totalCleared: Money.toNumber(Money.parseDb(depositSummary.total_cleared)),
      depositCount: depositSummary.deposit_count,
      clearingCount: depositSummary.clearing_count,
      outstandingLiability: Money.toNumber(Money.parseDb(depositSummary.outstanding_liability)),
      activeDepositCount: depositSummary.active_deposit_count,
      customersWithDeposits: depositSummary.customers_with_deposits,
      byDay: depositByDay,
    };

    // --- Section 5: Summary ---
    // Primary Management P&L KPIs follow Section 2 (period sale_items by category).
    // Mixing GL-net revenue (which subtracts cross-period 4010 returns) with category
    // rows made the header/TOTAL contradict the positive category table.
    const categoryRevenue = revenueByCategory.reduce(
      (sum, r) => Money.toNumber(Money.add(sum, r.totalRevenue)),
      0,
    );
    const categoryCogs = revenueByCategory.reduce(
      (sum, r) => Money.toNumber(Money.add(sum, r.totalCogs)),
      0,
    );
    const categoryGrossProfit = revenueByCategory.reduce(
      (sum, r) => Money.toNumber(Money.add(sum, r.grossProfit)),
      0,
    );

    const glNetRevenue = Money.toNumber(Money.parseDb(totals.total_revenue));
    const glSalesRevenue = Money.toNumber(Money.parseDb(totals.gl_sales_revenue));
    const glSalesReturns = Money.toNumber(Money.parseDb(totals.gl_sales_returns));
    const glGrossCogs = Money.toNumber(Money.parseDb(totals.total_cogs));
    const glNetCogs = Money.toNumber(Money.parseDb(totals.gl_net_cogs));

    const totalRevenue = categoryRevenue;
    // Prefer category COGS (same SSOT as revenue rows). Fall back to GL goods-issue if categories empty.
    const totalCogs = revenueByCategory.length > 0 ? categoryCogs : glGrossCogs;
    const totalExpenses =
      datedFilters.includeExpenses !== false
        ? Money.toNumber(Money.parseDb(totals.total_expenses))
        : 0;
    const totalStockAdjustments =
      datedFilters.includeStockAdjustments !== false
        ? Money.toNumber(Money.parseDb(totals.total_stock_adjustments))
        : 0;
    const totalSupplierPayments = supplierPaymentsByAccount.reduce(
      (sum, r) => Money.toNumber(Money.add(sum, r.totalPaid)),
      0,
    );
    const grossProfit =
      revenueByCategory.length > 0
        ? categoryGrossProfit
        : Money.toNumber(Money.subtract(totalRevenue, totalCogs));
    // Operating net = GP − operating expenses. Stock adjustments (5130/5140) stay in Section 3
    // and are disclosed separately — they are not silently folded into revenue.
    const netProfit = Money.toNumber(Money.subtract(grossProfit, totalExpenses));
    const grossMarginPct =
      totalRevenue > 0 ? Money.toNumber(Money.percentageRate(grossProfit, totalRevenue)) : 0;
    const netMarginPct =
      totalRevenue > 0 ? Money.toNumber(Money.percentageRate(netProfit, totalRevenue)) : 0;

    const summary: BusinessSummary = {
      totalRevenue,
      totalCogs,
      grossProfit,
      grossMarginPct,
      totalExpenses,
      totalStockAdjustments,
      totalSupplierPayments,
      netProfit,
      netMarginPct,
      saleCount: totals.sale_count,
      glSalesRevenue,
      glSalesReturns,
      glNetRevenue,
      glGrossCogs,
      glNetCogs,
    };

    return {
      summary,
      moneyIn,
      revenueByCategory,
      costAndStock,
      expensesByAccount,
      supplierPaymentsByAccount,
      customerDeposits,
      arCollections,
    };
  } catch (error) {
    logger.error('Error generating business performance report', { error, filters });
    throw error;
  }
}
