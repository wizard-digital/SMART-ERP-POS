import React, { useState } from 'react';
import {
  TrendingUp,
  TrendingDown,
  DollarSign,
  ShoppingCart,
  Receipt,
  BarChart3,
  Wallet,
  Package,
  CreditCard,
  Landmark,
  HandCoins,
} from 'lucide-react';
import Layout from '../../components/Layout';
import { DateRangeFilter } from '../../components/ui/DateRangeFilter';
import { ResponsiveTableWrapper } from '../../components/ui/ResponsiveTableWrapper';
import { formatCurrency } from '../../utils/currency';
import { useBusinessPerformance } from '../../hooks/useApi';
import { computeDateRange } from '../../utils/dateRangePresets';
import {
  AdaptivePage,
  AdaptiveReportFilters,
  AdaptiveReportShell,
  AdaptiveReportSummary,
  type AdaptiveReportMetric,
  useAdaptiveLayoutOptional,
} from '../../components/adaptive';
import { CustomerReceiptsByDayPanel } from '../../components/reports/CustomerReceiptsByDayPanel';
import { ReportBackLink } from '../../components/reports/ReportBackLink';
import {
  REPORT_FILTER_CONTROL_CLASS,
  REPORT_FILTER_FIELDS_CLASS,
  REPORT_FILTER_LABEL_CLASS,
  REPORT_PAGE_FRAME_CLASS,
  resolveReportDatePickersMode,
} from '../../lib/adaptiveReports';

// ---------------------------------------------------------------------------
// Types matching the new ledger-based API response
// ---------------------------------------------------------------------------

interface MoneyInEntry {
  flowType: string;
  flowLabel: string;
  accountCode: string;
  accountName: string;
  transactionCount: number;
  totalAmount: number;
}

interface RevenueByCategoryEntry {
  categoryName: string;
  transactionCount: number;
  unitsSold: number;
  totalRevenue: number;
  totalCogs: number;
  grossProfit: number;
  grossMarginPct: number;
}

interface CostAndStockEntry {
  accountCode: string;
  accountName: string;
  entryCount: number;
  totalAmount: number;
}

interface ExpenseByAccountEntry {
  accountCode: string;
  accountName: string;
  entryCount: number;
  totalAmount: number;
  pctOfTotal: number;
}

interface SupplierPaymentByAccountEntry {
  fundingAccountCode: string;
  fundingAccountName: string;
  supplierName: string;
  paymentCount: number;
  totalPaid: number;
}

interface CustomerDepositSummary {
  totalDeposited: number;
  totalCleared: number;
  depositCount: number;
  clearingCount: number;
  outstandingLiability: number;
  activeDepositCount: number;
  customersWithDeposits: number;
  byDay?: Array<{
    businessDate: string;
    totalAmount: number;
    receiptCount: number;
    lines: Array<{
      businessDate: string;
      customerId: string;
      customerNumber: string;
      customerName: string;
      documentNumber: string;
      paymentMethod: string;
      amount: number;
    }>;
  }>;
}

interface ArCollectionsSection {
  totalCollected: number;
  paymentCount: number;
  customerCount: number;
  byDay: Array<{
    businessDate: string;
    totalAmount: number;
    receiptCount: number;
    lines: Array<{
      businessDate: string;
      customerId: string;
      customerNumber: string;
      customerName: string;
      documentNumber: string;
      paymentMethod: string;
      amount: number;
    }>;
  }>;
}

interface BusinessSummary {
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
  /** Period SALE credits on REVENUE (GL). Optional for older API payloads. */
  glSalesRevenue?: number;
  /** Period SALE_REFUND debits on REVENUE (4010), incl. cross-period returns. */
  glSalesReturns?: number;
  glNetRevenue?: number;
  glGrossCogs?: number;
  glNetCogs?: number;
}

interface BusinessPerformanceData {
  summary: BusinessSummary;
  moneyIn: MoneyInEntry[];
  revenueByCategory: RevenueByCategoryEntry[];
  costAndStock: CostAndStockEntry[];
  expensesByAccount: ExpenseByAccountEntry[];
  supplierPaymentsByAccount?: SupplierPaymentByAccountEntry[];
  customerDeposits?: CustomerDepositSummary;
  arCollections?: ArCollectionsSection;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const PAYMENT_METHODS = [
  { value: '', label: 'All Methods' },
  { value: 'CASH', label: 'Cash' },
  { value: 'CREDIT', label: 'Credit (A/R)' },
  { value: 'MOBILE_MONEY', label: 'Mobile Money' },
  { value: 'CARD', label: 'Card' },
];

const SECTION_OPTIONS = [
  { value: 'ALL', label: 'All Sections' },
  { value: 'MONEY_IN', label: '1 — Money In' },
  { value: 'RECEIPTS', label: '1b — Collections & Deposits' },
  { value: 'REVENUE', label: '2 — Revenue by Category' },
  { value: 'COST_STOCK', label: '3 — Cost & Stock Impact' },
  { value: 'EXPENSES', label: '4 — Expenses by Account' },
  { value: 'NET_POSITION', label: '5 — Net Business Position' },
];

type SectionKey =
  | 'ALL'
  | 'MONEY_IN'
  | 'RECEIPTS'
  | 'REVENUE'
  | 'COST_STOCK'
  | 'EXPENSES'
  | 'NET_POSITION';

const BusinessPerformancePage: React.FC = () => {
  const initialRange = computeDateRange('THIS_MONTH')!;
  const [startDate, setStartDate] = useState(initialRange.startDate);
  const [endDate, setEndDate] = useState(initialRange.endDate);
  const [paymentMethod, setPaymentMethod] = useState('');
  const [includeStockAdj, setIncludeStockAdj] = useState(true);
  const [includeExpenses, setIncludeExpenses] = useState(true);
  const [visibleSection, setVisibleSection] = useState<SectionKey>('ALL');
  const layout = useAdaptiveLayoutOptional();
  const tier = layout?.tier ?? 'desktop';
  const datePickersMode = resolveReportDatePickersMode(tier);

  const showSection = (key: SectionKey) => visibleSection === 'ALL' || visibleSection === key;

  const { data, isLoading, error } = useBusinessPerformance({
    startDate,
    endDate,
    paymentMethod: paymentMethod || undefined,
    includeStockAdjustments: includeStockAdj,
    includeExpenses,
  });
  const report = data as BusinessPerformanceData | undefined;

  const moneyInTotal = report
    ? report.moneyIn.reduce((s, r) => s + r.totalAmount, 0)
    : 0;
  const moneyInTxns = report
    ? report.moneyIn.reduce((s, r) => s + r.transactionCount, 0)
    : 0;
  const categoryUnits = report
    ? report.revenueByCategory.reduce((s, r) => s + r.unitsSold, 0)
    : 0;
  const costStockTotal = report
    ? report.costAndStock.reduce((s, r) => s + r.totalAmount, 0)
    : 0;
  const costStockEntries = report
    ? report.costAndStock.reduce((s, r) => s + r.entryCount, 0)
    : 0;

  // KPI strip follows the visible section so "Section" filter is not cosmetic-only.
  const summaryCards = report?.summary
    ? (() => {
        const s = report.summary;
        const fullPl = [
          {
            label: 'Total Revenue',
            value: formatCurrency(s.totalRevenue),
            icon: ShoppingCart,
            color: 'text-blue-600',
            bg: 'bg-blue-50',
          },
          {
            label: 'COGS',
            value: formatCurrency(s.totalCogs),
            icon: Receipt,
            color: 'text-orange-600',
            bg: 'bg-orange-50',
          },
          {
            label: 'Gross Profit',
            value: formatCurrency(s.grossProfit),
            icon: s.grossProfit >= 0 ? TrendingUp : TrendingDown,
            color: s.grossProfit >= 0 ? 'text-green-600' : 'text-red-600',
            bg: s.grossProfit >= 0 ? 'bg-green-50' : 'bg-red-50',
            sub: `${s.grossMarginPct.toFixed(1)}% margin`,
          },
          {
            label: 'Expenses',
            value: formatCurrency(s.totalExpenses),
            icon: DollarSign,
            color: 'text-red-600',
            bg: 'bg-red-50',
          },
          {
            label: 'Net Profit',
            value: formatCurrency(s.netProfit),
            icon: s.netProfit >= 0 ? TrendingUp : TrendingDown,
            color: s.netProfit >= 0 ? 'text-emerald-600' : 'text-red-600',
            bg: s.netProfit >= 0 ? 'bg-emerald-50' : 'bg-red-50',
            sub: `${s.netMarginPct.toFixed(1)}% net margin`,
          },
          {
            label: 'Sale Transactions',
            value: s.saleCount.toLocaleString(),
            icon: BarChart3,
            color: 'text-indigo-600',
            bg: 'bg-indigo-50',
          },
        ];

        switch (visibleSection) {
          case 'MONEY_IN':
            return [
              {
                label: 'Money In',
                value: formatCurrency(moneyInTotal),
                icon: Wallet,
                color: 'text-blue-600',
                bg: 'bg-blue-50',
              },
              {
                label: 'Transactions',
                value: moneyInTxns.toLocaleString(),
                icon: BarChart3,
                color: 'text-indigo-600',
                bg: 'bg-indigo-50',
              },
            ];
          case 'RECEIPTS':
            return [
              {
                label: 'AR Collections',
                value: formatCurrency(report.arCollections?.totalCollected ?? 0),
                icon: HandCoins,
                color: 'text-teal-600',
                bg: 'bg-teal-50',
                sub: `${report.arCollections?.paymentCount ?? 0} payment(s)`,
              },
              {
                label: 'Deposits Taken',
                value: formatCurrency(report.customerDeposits?.totalDeposited ?? 0),
                icon: Landmark,
                color: 'text-purple-600',
                bg: 'bg-purple-50',
                sub: `${report.customerDeposits?.depositCount ?? 0} deposit(s)`,
              },
              {
                label: 'Deposit Liability',
                value: formatCurrency(report.customerDeposits?.outstandingLiability ?? 0),
                icon: Landmark,
                color: 'text-orange-600',
                bg: 'bg-orange-50',
              },
            ];
          case 'REVENUE':
            return [
              fullPl[0],
              fullPl[1],
              fullPl[2],
              {
                label: 'Sale Transactions',
                value: s.saleCount.toLocaleString(),
                icon: BarChart3,
                color: 'text-indigo-600',
                bg: 'bg-indigo-50',
              },
              {
                label: 'Units Sold',
                value: categoryUnits.toLocaleString(),
                icon: Package,
                color: 'text-slate-600',
                bg: 'bg-slate-50',
              },
            ];
          case 'COST_STOCK':
            return [
              {
                label: 'Cost & Stock Total',
                value: formatCurrency(costStockTotal),
                icon: Package,
                color: 'text-orange-600',
                bg: 'bg-orange-50',
                sub: `${costStockEntries} GL entries`,
              },
              {
                label: 'COGS (period sales)',
                value: formatCurrency(s.totalCogs),
                icon: Receipt,
                color: 'text-orange-600',
                bg: 'bg-orange-50',
              },
              {
                label: 'Stock Adjustments',
                value: formatCurrency(s.totalStockAdjustments),
                icon: Package,
                color: 'text-amber-700',
                bg: 'bg-amber-50',
              },
            ];
          case 'EXPENSES':
            return [
              {
                label: 'Operating Expenses',
                value: formatCurrency(s.totalExpenses),
                icon: DollarSign,
                color: 'text-red-600',
                bg: 'bg-red-50',
              },
              {
                label: 'Supplier Payments',
                value: formatCurrency(s.totalSupplierPayments),
                icon: CreditCard,
                color: 'text-orange-600',
                bg: 'bg-orange-50',
              },
            ];
          case 'NET_POSITION':
          case 'ALL':
          default:
            return fullPl;
        }
      })()
    : [];

  const kpiMetrics: AdaptiveReportMetric[] = summaryCards.map((card) => {
    const primary =
      card.label === 'Total Revenue' ||
      card.label === 'Gross Profit' ||
      card.label === 'Net Profit' ||
      card.label === 'Money In' ||
      card.label === 'Cost & Stock Total';
    return {
      id: card.label,
      label: card.label,
      value: card.value,
      sub: card.sub,
      toneClassName: card.color,
      priority: (primary ? 'primary' : 'secondary') as AdaptiveReportMetric['priority'],
    };
  });

  return (
    <Layout>
      <AdaptivePage
        className={REPORT_PAGE_FRAME_CLASS}
        title="Management P&L by Category"
        description="Ledger-based report — where did money come from, and where did it go?"
        backLink={<ReportBackLink />}
        toolbar={
          <AdaptiveReportFilters
            dataAttr="bp"
            secondaryLabel="More options"
            primary={
              <div data-bp-filters="true" className="space-y-3 sm:space-y-4">
                <DateRangeFilter
                  startDate={startDate}
                  endDate={endDate}
                  onStartDateChange={setStartDate}
                  onEndDateChange={setEndDate}
                  defaultPreset="THIS_MONTH"
                  pickersMode={datePickersMode}
                />
                <div className={REPORT_FILTER_FIELDS_CLASS}>
                  <div className="min-w-0">
                    <label className={REPORT_FILTER_LABEL_CLASS} htmlFor="bp-section">
                      Section
                    </label>
                    <select
                      id="bp-section"
                      value={visibleSection}
                      onChange={(e) => setVisibleSection(e.target.value as SectionKey)}
                      className={REPORT_FILTER_CONTROL_CLASS}
                      data-bp-section="true"
                    >
                      {SECTION_OPTIONS.map((s) => (
                        <option key={s.value} value={s.value}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="min-w-0">
                    <label className={REPORT_FILTER_LABEL_CLASS} htmlFor="bp-payment">
                      Payment Method
                    </label>
                    <select
                      id="bp-payment"
                      value={paymentMethod}
                      onChange={(e) => setPaymentMethod(e.target.value)}
                      className={REPORT_FILTER_CONTROL_CLASS}
                      data-bp-payment="true"
                    >
                      {PAYMENT_METHODS.map((m) => (
                        <option key={m.value} value={m.value}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
            }
            secondary={
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="flex items-center gap-2.5 text-sm font-medium text-slate-800 cursor-pointer min-h-[var(--layout-touch-target)]">
                  <input
                    type="checkbox"
                    checked={includeStockAdj}
                    onChange={(e) => setIncludeStockAdj(e.target.checked)}
                    className="h-4 w-4 rounded border-slate-300"
                  />
                  Include Stock Adjustments
                </label>
                <label className="flex items-center gap-2.5 text-sm font-medium text-slate-800 cursor-pointer min-h-[var(--layout-touch-target)]">
                  <input
                    type="checkbox"
                    checked={includeExpenses}
                    onChange={(e) => setIncludeExpenses(e.target.checked)}
                    className="h-4 w-4 rounded border-slate-300"
                  />
                  Include Expenses
                </label>
              </div>
            }
          />
        }
      >
        {/* Loading */}
        {isLoading && (
          <div className="text-center py-12 text-gray-500">Loading report…</div>
        )}

        {/* Error */}
        {error && (
          <div className="bg-red-50 border-l-4 border-red-500 p-4 rounded">
            <p className="text-sm text-red-700">
              {error instanceof Error ? error.message : 'Failed to load report'}
            </p>
          </div>
        )}

        {report && !isLoading && (
          <AdaptiveReportShell
            summary={
              kpiMetrics.length > 0 ? <AdaptiveReportSummary metrics={kpiMetrics} /> : null
            }
            table={
              <div className="space-y-4 sm:space-y-6" data-bp-detail="sections">
            {/* ── Section 1: Money In ── */}
            {showSection('MONEY_IN') && (
              <div className="bg-white rounded-lg border shadow-sm">
                <div className="px-3 py-3 sm:px-6 sm:py-4 border-b">
                  <div className="flex items-center gap-2">
                    <Wallet className="h-5 w-5 text-blue-600" />
                    <h2 className="text-lg font-semibold text-gray-900">
                      Section 1 — Money In
                    </h2>
                  </div>
                  <p className="text-sm text-gray-500 mt-1">
                    Cash and receivables from sales, customer payments received (incl. Undeposited
                    Funds 1015), and opening balances
                  </p>
                </div>
                <div className="overflow-x-auto">
                  {report.moneyIn.length === 0 ? (
                    <div className="text-center py-8 text-gray-500">
                      No settlement entries for this period
                    </div>
                  ) : (
                    <ResponsiveTableWrapper>
                      <table className="min-w-full">
                        <thead className="bg-gray-50">
                          <tr>
                            <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                              Source
                            </th>
                            <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                              Account
                            </th>
                            <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                              Name
                            </th>
                            <th className="px-4 py-3 text-right text-xs font-semibold text-gray-600 uppercase">
                              Transactions
                            </th>
                            <th className="px-4 py-3 text-right text-xs font-semibold text-gray-600 uppercase">
                              Amount
                            </th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                          {report.moneyIn.map((row) => (
                            <tr key={`${row.flowType}-${row.accountCode}`} className="hover:bg-gray-50">
                              <td className="px-4 py-3 text-sm text-gray-700">
                                {row.flowLabel}
                                {row.accountCode === '1200' && row.flowType === 'SALE_SETTLEMENT' && (
                                  <span className="ml-1 text-xs text-amber-700">(credit sale)</span>
                                )}
                              </td>
                              <td className="px-4 py-3 text-sm font-mono text-gray-600">
                                {row.accountCode}
                              </td>
                              <td className="px-4 py-3 text-sm font-medium text-gray-900">
                                {row.accountName}
                              </td>
                              <td className="px-4 py-3 text-sm text-right text-gray-600">
                                {row.transactionCount}
                              </td>
                              <td className="px-4 py-3 text-sm text-right text-blue-700 font-semibold">
                                {formatCurrency(row.totalAmount)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot className="bg-gray-50 border-t-2 border-gray-300">
                          <tr className="font-bold">
                            <td colSpan={3} className="px-4 py-3 text-sm text-gray-900">
                              TOTAL MONEY IN
                            </td>
                            <td className="px-4 py-3 text-sm text-right text-gray-600">
                              {report.moneyIn.reduce((s, r) => s + r.transactionCount, 0)}
                            </td>
                            <td className="px-4 py-3 text-sm text-right text-blue-700">
                              {formatCurrency(
                                report.moneyIn.reduce((s, r) => s + r.totalAmount, 0)
                              )}
                            </td>
                          </tr>
                        </tfoot>
                      </table>
                    </ResponsiveTableWrapper>
                  )}
                </div>
              </div>

            )}

            {/* ── Section 1b: AR collections by day + customer ── */}
            {(showSection('RECEIPTS') || showSection('MONEY_IN')) &&
              report.arCollections &&
              (visibleSection === 'RECEIPTS' || report.arCollections.paymentCount > 0) && (
              <CustomerReceiptsByDayPanel
                title="Section 1b — Receivable Collections"
                description="Money received against customer receivables (posted to Undeposited Funds 1015). Day → which customer paid."
                accentClass="text-teal-700"
                icon={<HandCoins className="h-5 w-5 text-teal-600" />}
                summaryCards={[
                  {
                    label: 'Collected from AR',
                    value: formatCurrency(report.arCollections.totalCollected),
                    sub: `${report.arCollections.paymentCount} payment(s)`,
                    tone: 'bg-teal-50',
                  },
                  {
                    label: 'Customers paid',
                    value: String(report.arCollections.customerCount),
                    sub: 'in period',
                    tone: 'bg-blue-50',
                  },
                  {
                    label: 'Days with collections',
                    value: String(report.arCollections.byDay.length),
                    sub: 'business days',
                    tone: 'bg-slate-50',
                  },
                ]}
                byDay={report.arCollections.byDay}
                emptyMessage="No receivable collections in this period"
              />
            )}

            {/* ── Section 2: Revenue by Product Category ── */}
            {showSection('REVENUE') && (
              <div className="bg-white rounded-lg border shadow-sm">
                <div className="px-3 py-3 sm:px-6 sm:py-4 border-b">
                  <div className="flex items-center gap-2">
                    <ShoppingCart className="h-5 w-5 text-green-600" />
                    <h2 className="text-lg font-semibold text-gray-900">
                      Section 2 — Revenue by Product Category
                    </h2>
                  </div>
                  <p className="text-sm text-gray-500 mt-1">
                    Period sales by product category (same totals as Management Revenue / COGS / Gross Profit)
                  </p>
                </div>
                <div className="overflow-x-auto">
                  {report.revenueByCategory.length === 0 ? (
                    <div className="text-center py-8 text-gray-500">
                      No revenue data for this period
                    </div>
                  ) : (
                    <ResponsiveTableWrapper>
                      <table className="min-w-full">
                        <thead className="bg-gray-50">
                          <tr>
                            <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                              Category
                            </th>
                            <th className="px-4 py-3 text-right text-xs font-semibold text-gray-600 uppercase">
                              Revenue
                            </th>
                            <th className="px-4 py-3 text-right text-xs font-semibold text-gray-600 uppercase">
                              COGS
                            </th>
                            <th className="px-4 py-3 text-right text-xs font-semibold text-gray-600 uppercase">
                              Gross Profit
                            </th>
                            <th className="px-4 py-3 text-right text-xs font-semibold text-gray-600 uppercase">
                              Margin %
                            </th>
                            <th className="px-4 py-3 text-right text-xs font-semibold text-gray-600 uppercase">
                              Txns
                            </th>
                            <th className="px-4 py-3 text-right text-xs font-semibold text-gray-600 uppercase">
                              Units
                            </th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                          {report.revenueByCategory.map((row) => (
                            <tr key={row.categoryName} className="hover:bg-gray-50">
                              <td className="px-4 py-3 text-sm font-medium text-gray-900">
                                {row.categoryName}
                              </td>
                              <td className="px-4 py-3 text-sm text-right text-green-700 font-semibold">
                                {formatCurrency(row.totalRevenue)}
                              </td>
                              <td className="px-4 py-3 text-sm text-right text-orange-600">
                                {formatCurrency(row.totalCogs)}
                              </td>
                              <td
                                className={`px-4 py-3 text-sm text-right font-semibold ${row.grossProfit >= 0 ? 'text-green-700' : 'text-red-600'
                                  }`}
                              >
                                {formatCurrency(row.grossProfit)}
                              </td>
                              <td className="px-4 py-3 text-sm text-right">
                                <span
                                  className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${row.grossMarginPct >= 30
                                    ? 'bg-green-100 text-green-800'
                                    : row.grossMarginPct >= 15
                                      ? 'bg-yellow-100 text-yellow-800'
                                      : 'bg-red-100 text-red-800'
                                    }`}
                                >
                                  {row.grossMarginPct.toFixed(1)}%
                                </span>
                              </td>
                              <td className="px-4 py-3 text-sm text-right text-gray-600">
                                {row.transactionCount}
                              </td>
                              <td className="px-4 py-3 text-sm text-right text-gray-600">
                                {row.unitsSold.toLocaleString()}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot className="bg-gray-50 border-t-2 border-gray-300">
                          <tr className="font-bold">
                            <td className="px-4 py-3 text-sm text-gray-900">TOTAL</td>
                            <td className="px-4 py-3 text-sm text-right text-green-700">
                              {formatCurrency(report.summary.totalRevenue)}
                            </td>
                            <td className="px-4 py-3 text-sm text-right text-orange-600">
                              {formatCurrency(report.summary.totalCogs)}
                            </td>
                            <td className="px-4 py-3 text-sm text-right text-green-700">
                              {formatCurrency(report.summary.grossProfit)}
                            </td>
                            <td className="px-4 py-3 text-sm text-right">
                              <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800">
                                {report.summary.grossMarginPct.toFixed(1)}%
                              </span>
                            </td>
                            <td className="px-4 py-3 text-sm text-right text-gray-600">
                              {report.summary.saleCount}
                            </td>
                            <td className="px-4 py-3 text-sm text-right text-gray-600">
                              {report.revenueByCategory
                                .reduce((s, r) => s + r.unitsSold, 0)
                                .toLocaleString()}
                            </td>
                          </tr>
                        </tfoot>
                      </table>
                    </ResponsiveTableWrapper>
                  )}
                </div>
              </div>

            )}

            {/* ── Section 3: Cost & Stock Impact ── */}
            {showSection('COST_STOCK') && (
              <div className="bg-white rounded-lg border shadow-sm">
                <div className="px-3 py-3 sm:px-6 sm:py-4 border-b">
                  <div className="flex items-center gap-2">
                    <Package className="h-5 w-5 text-orange-600" />
                    <h2 className="text-lg font-semibold text-gray-900">
                      Section 3 — Cost &amp; Stock Impact
                    </h2>
                  </div>
                  <p className="text-sm text-gray-500 mt-1">
                    COGS, shrinkage, damage, expiry, and stock adjustments from GL
                  </p>
                </div>
                <div className="overflow-x-auto">
                  {report.costAndStock.length === 0 ? (
                    <div className="text-center py-8 text-gray-500">
                      No cost / stock entries for this period
                    </div>
                  ) : (
                    <ResponsiveTableWrapper>
                      <table className="min-w-full">
                        <thead className="bg-gray-50">
                          <tr>
                            <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                              Account
                            </th>
                            <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                              Name
                            </th>
                            <th className="px-4 py-3 text-right text-xs font-semibold text-gray-600 uppercase">
                              Entries
                            </th>
                            <th className="px-4 py-3 text-right text-xs font-semibold text-gray-600 uppercase">
                              Amount
                            </th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                          {report.costAndStock.map((row) => (
                            <tr key={row.accountCode} className="hover:bg-gray-50">
                              <td className="px-4 py-3 text-sm font-mono text-gray-600">
                                {row.accountCode}
                              </td>
                              <td className="px-4 py-3 text-sm font-medium text-gray-900">
                                {row.accountName}
                              </td>
                              <td className="px-4 py-3 text-sm text-right text-gray-600">
                                {row.entryCount}
                              </td>
                              <td className="px-4 py-3 text-sm text-right text-orange-700 font-semibold">
                                {formatCurrency(row.totalAmount)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot className="bg-gray-50 border-t-2 border-gray-300">
                          <tr className="font-bold">
                            <td colSpan={2} className="px-4 py-3 text-sm text-gray-900">
                              TOTAL COST &amp; STOCK
                            </td>
                            <td className="px-4 py-3 text-sm text-right text-gray-600">
                              {report.costAndStock.reduce((s, r) => s + r.entryCount, 0)}
                            </td>
                            <td className="px-4 py-3 text-sm text-right text-orange-700">
                              {formatCurrency(
                                report.costAndStock.reduce((s, r) => s + r.totalAmount, 0)
                              )}
                            </td>
                          </tr>
                        </tfoot>
                      </table>
                    </ResponsiveTableWrapper>
                  )}
                </div>
              </div>

            )}

            {/* ── Section 4: Expenses by GL Account ── */}
            {includeExpenses && showSection('EXPENSES') && (
              <div className="bg-white rounded-lg border shadow-sm">
                <div className="px-3 py-3 sm:px-6 sm:py-4 border-b">
                  <div className="flex items-center gap-2">
                    <DollarSign className="h-5 w-5 text-red-600" />
                    <h2 className="text-lg font-semibold text-gray-900">
                      Section 4 — Expenses by Account
                    </h2>
                  </div>
                  <p className="text-sm text-gray-500 mt-1">
                    Operating &amp; financial expenses from GL (6xxx/7xxx accounts)
                  </p>
                </div>
                <div className="overflow-x-auto">
                  {report.expensesByAccount.length === 0 ? (
                    <div className="text-center py-8 text-gray-500">
                      No expense entries for this period
                    </div>
                  ) : (
                    <ResponsiveTableWrapper>
                      <table className="min-w-full">
                        <thead className="bg-gray-50">
                          <tr>
                            <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                              Account
                            </th>
                            <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                              Name
                            </th>
                            <th className="px-4 py-3 text-right text-xs font-semibold text-gray-600 uppercase">
                              Amount
                            </th>
                            <th className="px-4 py-3 text-right text-xs font-semibold text-gray-600 uppercase">
                              % of Total
                            </th>
                            <th className="px-4 py-3 text-right text-xs font-semibold text-gray-600 uppercase">
                              Entries
                            </th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                          {report.expensesByAccount.map((row) => (
                            <tr key={row.accountCode} className="hover:bg-gray-50">
                              <td className="px-4 py-3 text-sm font-mono text-gray-600">
                                {row.accountCode}
                              </td>
                              <td className="px-4 py-3 text-sm font-medium text-gray-900">
                                {row.accountName}
                              </td>
                              <td className="px-4 py-3 text-sm text-right text-red-600 font-semibold">
                                {formatCurrency(row.totalAmount)}
                              </td>
                              <td className="px-4 py-3 text-sm text-right text-gray-600">
                                {row.pctOfTotal.toFixed(1)}%
                              </td>
                              <td className="px-4 py-3 text-sm text-right text-gray-600">
                                {row.entryCount}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot className="bg-gray-50 border-t-2 border-gray-300">
                          <tr className="font-bold">
                            <td colSpan={2} className="px-4 py-3 text-sm text-gray-900">
                              TOTAL EXPENSES
                            </td>
                            <td className="px-4 py-3 text-sm text-right text-red-600">
                              {formatCurrency(report.summary.totalExpenses)}
                            </td>
                            <td className="px-4 py-3 text-sm text-right text-gray-600">
                              100%
                            </td>
                            <td className="px-4 py-3 text-sm text-right text-gray-600">
                              {report.expensesByAccount.reduce(
                                (s, r) => s + r.entryCount,
                                0
                              )}
                            </td>
                          </tr>
                        </tfoot>
                      </table>
                    </ResponsiveTableWrapper>
                  )}
                </div>
              </div>
            )}

            {/* ── Section 4b: Supplier Payments by Funding Account ── */}
            {(showSection('EXPENSES') || showSection('NET_POSITION')) &&
              report.supplierPaymentsByAccount &&
              report.supplierPaymentsByAccount.length > 0 && (
              <div className="bg-white rounded-lg border shadow-sm">
                <div className="px-3 py-3 sm:px-6 sm:py-4 border-b">
                  <div className="flex items-center gap-2">
                    <CreditCard className="h-5 w-5 text-orange-600" />
                    <h2 className="text-lg font-semibold text-gray-900">
                      Section 4b — Supplier Payments by Account
                    </h2>
                  </div>
                  <p className="text-sm text-gray-500 mt-1">
                    Payments made to suppliers and which account funded them
                  </p>
                </div>
                <div className="overflow-x-auto">
                  <ResponsiveTableWrapper>
                    <table className="min-w-full">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                            Funding Account
                          </th>
                          <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                            Supplier
                          </th>
                          <th className="px-4 py-3 text-right text-xs font-semibold text-gray-600 uppercase">
                            Payments
                          </th>
                          <th className="px-4 py-3 text-right text-xs font-semibold text-gray-600 uppercase">
                            Total Paid
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {report.supplierPaymentsByAccount.map((row, idx) => (
                          <tr key={`${row.fundingAccountCode}-${row.supplierName}-${idx}`} className="hover:bg-gray-50">
                            <td className="px-4 py-3 text-sm">
                              <span className="font-mono text-gray-600">{row.fundingAccountCode}</span>
                              {' — '}
                              <span className="text-gray-900">{row.fundingAccountName}</span>
                            </td>
                            <td className="px-4 py-3 text-sm font-medium text-gray-900">
                              {row.supplierName}
                            </td>
                            <td className="px-4 py-3 text-sm text-right text-gray-600">
                              {row.paymentCount}
                            </td>
                            <td className="px-4 py-3 text-sm text-right text-orange-600 font-semibold">
                              {formatCurrency(row.totalPaid)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot className="bg-gray-50 border-t-2 border-gray-300">
                        <tr className="font-bold">
                          <td colSpan={2} className="px-4 py-3 text-sm text-gray-900">
                            TOTAL SUPPLIER PAYMENTS
                          </td>
                          <td className="px-4 py-3 text-sm text-right text-gray-600">
                            {report.supplierPaymentsByAccount.reduce((s, r) => s + r.paymentCount, 0)}
                          </td>
                          <td className="px-4 py-3 text-sm text-right text-orange-600">
                            {formatCurrency(report.supplierPaymentsByAccount.reduce((s, r) => s + r.totalPaid, 0))}
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                  </ResponsiveTableWrapper>
                </div>
              </div>
            )}

            {/* ── Section 4c: Customer Deposits (Liability) ── */}
            {showSection('RECEIPTS') &&
              report.customerDeposits &&
              (report.customerDeposits.depositCount > 0 ||
                report.customerDeposits.outstandingLiability > 0 ||
                (report.customerDeposits.byDay && report.customerDeposits.byDay.length > 0)) && (
              <div className="space-y-0">
                <CustomerReceiptsByDayPanel
                  title="Section 4c — Customer Deposits"
                  description="Customer prepayments received (posted to Undeposited Funds 1015 / liability 2200). Day → which customer deposited."
                  accentClass="text-purple-700"
                  icon={<Landmark className="h-5 w-5 text-purple-600" />}
                  summaryCards={[
                    {
                      label: 'Deposits Received',
                      value: formatCurrency(report.customerDeposits.totalDeposited),
                      sub: `${report.customerDeposits.depositCount} deposit(s)`,
                      tone: 'bg-purple-50',
                    },
                    {
                      label: 'Clearings Applied',
                      value: formatCurrency(report.customerDeposits.totalCleared),
                      sub: `${report.customerDeposits.clearingCount} clearing(s)`,
                      tone: 'bg-green-50',
                    },
                    {
                      label: 'Outstanding Liability',
                      value: formatCurrency(report.customerDeposits.outstandingLiability),
                      sub: `${report.customerDeposits.activeDepositCount} active`,
                      tone: 'bg-orange-50',
                    },
                    {
                      label: 'Customers',
                      value: String(report.customerDeposits.customersWithDeposits),
                      sub: 'with deposits',
                      tone: 'bg-blue-50',
                    },
                  ]}
                  byDay={report.customerDeposits.byDay || []}
                  emptyMessage="No deposits taken in this period (outstanding liability may still exist)"
                />
              </div>
            )}

            {/* Keep EXPENSES section filter showing deposits under ALL too via RECEIPTS;
                when viewing EXPENSES-only, still show deposit summary without day table */}
            {visibleSection === 'EXPENSES' &&
              report.customerDeposits &&
              (report.customerDeposits.depositCount > 0 ||
                report.customerDeposits.outstandingLiability > 0) && (
              <div className="bg-white rounded-lg border shadow-sm">
                <div className="px-3 py-3 sm:px-6 sm:py-4 border-b">
                  <div className="flex items-center gap-2">
                    <Landmark className="h-5 w-5 text-purple-600" />
                    <h2 className="text-lg font-semibold text-gray-900">
                      Section 4c — Customer Deposits
                    </h2>
                  </div>
                  <p className="text-sm text-gray-500 mt-1">
                    Customer prepayments received, clearings applied, and outstanding liability (GL
                    2200)
                  </p>
                </div>
                <div className="p-4 sm:p-6">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-4">
                    <div className="bg-purple-50 p-4 rounded-lg text-center">
                      <p className="text-xs font-medium text-purple-600 uppercase tracking-wide mb-1">
                        Deposits Received
                      </p>
                      <p className="text-lg font-bold text-purple-700">
                        {formatCurrency(report.customerDeposits.totalDeposited)}
                      </p>
                      <p className="text-xs text-gray-500 mt-1">
                        {report.customerDeposits.depositCount} deposit(s)
                      </p>
                    </div>
                    <div className="bg-green-50 p-4 rounded-lg text-center">
                      <p className="text-xs font-medium text-green-600 uppercase tracking-wide mb-1">
                        Clearings Applied
                      </p>
                      <p className="text-lg font-bold text-green-700">
                        {formatCurrency(report.customerDeposits.totalCleared)}
                      </p>
                      <p className="text-xs text-gray-500 mt-1">
                        {report.customerDeposits.clearingCount} clearing(s)
                      </p>
                    </div>
                    <div className="bg-orange-50 p-4 rounded-lg text-center">
                      <p className="text-xs font-medium text-orange-600 uppercase tracking-wide mb-1">
                        Outstanding Liability
                      </p>
                      <p className="text-lg font-bold text-orange-700">
                        {formatCurrency(report.customerDeposits.outstandingLiability)}
                      </p>
                      <p className="text-xs text-gray-500 mt-1">
                        {report.customerDeposits.activeDepositCount} active
                      </p>
                    </div>
                    <div className="bg-blue-50 p-4 rounded-lg text-center">
                      <p className="text-xs font-medium text-blue-600 uppercase tracking-wide mb-1">
                        Customers
                      </p>
                      <p className="text-lg font-bold text-blue-700">
                        {report.customerDeposits.customersWithDeposits}
                      </p>
                      <p className="text-xs text-gray-500 mt-1">with deposits</p>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ── Section 5: Net Business Position (Income Statement) ── */}
            {showSection('NET_POSITION') && (
              <div className="bg-white rounded-lg border shadow-sm">
                <div className="px-3 py-3 sm:px-6 sm:py-4 border-b">
                  <div className="flex items-center gap-2">
                    <BarChart3 className="h-5 w-5 text-indigo-600" />
                    <h2 className="text-lg font-semibold text-gray-900">
                      Section 5 — Net Business Position
                    </h2>
                  </div>
                  <p className="text-sm text-gray-500 mt-1">
                    Combined income statement — revenue, cost, expenses, bottom line
                  </p>
                </div>
                <div className="overflow-x-auto">
                  <ResponsiveTableWrapper>
                    <table className="min-w-full">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase w-1/2">
                            Line Item
                          </th>
                          <th className="px-4 py-3 text-right text-xs font-semibold text-gray-600 uppercase">
                            Amount
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        <tr>
                          <td className="px-4 py-3 text-sm text-gray-900">
                            Total Revenue (period sales)
                          </td>
                          <td className="px-4 py-3 text-sm text-right text-green-700 font-semibold">
                            {formatCurrency(report.summary.totalRevenue)}
                          </td>
                        </tr>
                        <tr>
                          <td className="px-4 py-3 text-sm text-gray-900">
                            Less: Cost of Goods Sold
                          </td>
                          <td className="px-4 py-3 text-sm text-right text-orange-600">
                            ({formatCurrency(report.summary.totalCogs)})
                          </td>
                        </tr>
                        <tr className="bg-green-50">
                          <td className="px-4 py-3 text-sm font-bold text-gray-900">
                            Gross Profit
                          </td>
                          <td className="px-4 py-3 text-sm text-right font-bold text-green-700">
                            {formatCurrency(report.summary.grossProfit)}
                            <span className="ml-2 text-xs text-gray-500">
                              ({report.summary.grossMarginPct.toFixed(1)}%)
                            </span>
                          </td>
                        </tr>
                        {report.summary.totalStockAdjustments !== 0 && (
                          <tr>
                            <td className="px-4 py-3 text-sm text-gray-900">
                              Stock Adjustments (net)
                            </td>
                            <td className="px-4 py-3 text-sm text-right text-orange-600">
                              {report.summary.totalStockAdjustments >= 0
                                ? formatCurrency(report.summary.totalStockAdjustments)
                                : `(${formatCurrency(
                                  Math.abs(report.summary.totalStockAdjustments)
                                )})`}
                            </td>
                          </tr>
                        )}
                        <tr>
                          <td className="px-4 py-3 text-sm text-gray-900">
                            Less: Operating Expenses
                          </td>
                          <td className="px-4 py-3 text-sm text-right text-red-600">
                            ({formatCurrency(report.summary.totalExpenses)})
                          </td>
                        </tr>
                        <tr
                          className={`${report.summary.netProfit >= 0 ? 'bg-emerald-50' : 'bg-red-50'
                            } border-t-2 border-gray-300`}
                        >
                          <td className="px-4 py-4 text-base font-bold text-gray-900">
                            Net Profit
                          </td>
                          <td
                            className={`px-4 py-4 text-base text-right font-bold ${report.summary.netProfit >= 0
                              ? 'text-emerald-700'
                              : 'text-red-700'
                              }`}
                          >
                            {formatCurrency(report.summary.netProfit)}
                            <span className="ml-2 text-xs text-gray-500">
                              ({report.summary.netMarginPct.toFixed(1)}% net margin)
                            </span>
                          </td>
                        </tr>
                      </tbody>
                      {/* Supplementary: Cash Disbursements (not part of P&L) */}
                      {report.summary.totalSupplierPayments > 0 && (
                        <tfoot className="border-t-2 border-gray-200">
                          <tr className="bg-gray-50">
                            <td colSpan={2} className="px-4 py-2">
                              <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                                Supplementary — Cash Disbursements (non-P&L)
                              </span>
                            </td>
                          </tr>
                          <tr>
                            <td className="px-4 py-3 text-sm text-gray-700">
                              Payments to Vendors
                            </td>
                            <td className="px-4 py-3 text-sm text-right text-orange-600 font-semibold">
                              {formatCurrency(report.summary.totalSupplierPayments)}
                            </td>
                          </tr>
                        </tfoot>
                      )}
                    </table>
                  </ResponsiveTableWrapper>
                </div>
              </div>
            )}
              </div>
            }
          />
        )}
      </AdaptivePage>
    </Layout>
  );
};

export default BusinessPerformancePage;
