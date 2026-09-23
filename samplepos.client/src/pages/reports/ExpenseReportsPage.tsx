/**
 * Expense Reports designer.
 * Business logic:
 *   Recognized (P&L) = APPROVED + PAID (GL posts on approval)
 *   Unpaid AP        = APPROVED
 *   Cash paid        = PAID
 *   CANCELLED excluded from operational reports
 * Column chooser lets the operator pick visible fields (persisted per report).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import Layout from '../../components/Layout';
import { DateRangeFilter } from '../../components/ui/DateRangeFilter';
import { Button } from '../../components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover';
import { useAuth } from '../../contexts/AuthContext';
import { getBusinessDate } from '../../utils/businessDate';
import { formatCurrency } from '../../utils/currency';
import {
  AdaptivePage,
  AdaptiveReportShell,
  AdaptiveReportSummary,
  type AdaptiveReportMetric,
} from '../../components/adaptive';
import { REPORT_PAGE_FRAME_CLASS } from '../../lib/adaptiveReports';
import {
  Columns3,
  Download,
  FileText,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { ReportBackLink } from '../../components/reports/ReportBackLink';

function monthStart(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

type ReportDataValue = string | number | boolean | null | undefined;
type ReportDataRow = Record<string, ReportDataValue>;

type ExpenseReportType =
  | 'SUMMARY'
  | 'BY_CATEGORY'
  | 'BY_VENDOR'
  | 'TRENDS'
  | 'BY_PAYMENT_METHOD'
  | 'DETAILED_LIST'
  | 'APPROVAL_PIPELINE';

type ColumnDef = {
  id: string;
  label: string;
  money?: boolean;
  count?: boolean;
  default?: boolean;
};

const STORAGE_KEY = 'expense-reports-layout-v1';

const REPORT_OPTIONS: Array<{
  value: ExpenseReportType;
  label: string;
  description: string;
}> = [
  {
    value: 'SUMMARY',
    label: 'Executive summary',
    description: 'Recognized P&L, unpaid AP, paid cash, pipeline',
  },
  {
    value: 'BY_CATEGORY',
    label: 'By category / GL',
    description: 'Spend by expense category and P&L account',
  },
  {
    value: 'BY_VENDOR',
    label: 'By vendor',
    description: 'Who you spent with',
  },
  {
    value: 'TRENDS',
    label: 'Monthly trends',
    description: 'Recognized vs paid over time',
  },
  {
    value: 'BY_PAYMENT_METHOD',
    label: 'By payment method',
    description: 'Intended pay method on vouchers',
  },
  {
    value: 'DETAILED_LIST',
    label: 'Line list',
    description: 'Individual vouchers — pick columns to display',
  },
  {
    value: 'APPROVAL_PIPELINE',
    label: 'Approval pipeline',
    description: 'Workflow stages and aging',
  },
];

const ENDPOINTS: Record<ExpenseReportType, string> = {
  SUMMARY: '/api/expenses/summary',
  BY_CATEGORY: '/api/expenses/reports/by-category',
  BY_VENDOR: '/api/expenses/reports/by-vendor',
  TRENDS: '/api/expenses/reports/trends',
  BY_PAYMENT_METHOD: '/api/expenses/reports/by-payment-method',
  DETAILED_LIST: '/api/expenses/reports/detailed-list',
  APPROVAL_PIPELINE: '/api/expenses/reports/approval-pipeline',
};

/** Column catalogs — lean business fields only (no twin name+code columns). */
const COLUMN_CATALOG: Record<ExpenseReportType, ColumnDef[]> = {
  SUMMARY: [],
  BY_CATEGORY: [
    { id: 'category', label: 'Category', default: true },
    { id: 'glAccount', label: 'GL account', default: true },
    { id: 'expenseCount', label: 'Vouchers', count: true, default: true },
    { id: 'recognizedAmount', label: 'Recognized (P&L)', money: true, default: true },
    { id: 'unpaidApAmount', label: 'Unpaid AP', money: true, default: true },
    { id: 'paidAmount', label: 'Paid', money: true, default: true },
    { id: 'totalAmount', label: 'All statuses', money: true },
    { id: 'pendingCount', label: 'Pending #', count: true },
  ],
  BY_VENDOR: [
    { id: 'vendor', label: 'Vendor', default: true },
    { id: 'expenseCount', label: 'Vouchers', count: true, default: true },
    { id: 'recognizedAmount', label: 'Recognized (P&L)', money: true, default: true },
    { id: 'paidAmount', label: 'Paid', money: true, default: true },
    { id: 'totalAmount', label: 'All statuses', money: true },
    { id: 'firstExpenseDate', label: 'First date' },
    { id: 'lastExpenseDate', label: 'Last date', default: true },
  ],
  TRENDS: [
    { id: 'period', label: 'Month', default: true },
    { id: 'expenseCount', label: 'Vouchers', count: true, default: true },
    { id: 'recognizedAmount', label: 'Recognized (P&L)', money: true, default: true },
    { id: 'paidAmount', label: 'Paid', money: true, default: true },
    { id: 'totalAmount', label: 'All statuses', money: true },
    { id: 'categoryCount', label: 'Categories', count: true },
  ],
  BY_PAYMENT_METHOD: [
    { id: 'paymentMethod', label: 'Payment method', default: true },
    { id: 'expenseCount', label: 'Vouchers', count: true, default: true },
    { id: 'recognizedAmount', label: 'Recognized (P&L)', money: true, default: true },
    { id: 'paidAmount', label: 'Paid', money: true, default: true },
    { id: 'totalAmount', label: 'All statuses', money: true },
  ],
  DETAILED_LIST: [
    { id: 'expenseNumber', label: 'Expense #', default: true },
    { id: 'expenseDate', label: 'Date', default: true },
    { id: 'title', label: 'Title', default: true },
    { id: 'category', label: 'Category', default: true },
    { id: 'glAccount', label: 'GL account', default: true },
    { id: 'amount', label: 'Amount', money: true, default: true },
    { id: 'status', label: 'Status', default: true },
    { id: 'paymentStatus', label: 'Payment status' },
    { id: 'paymentMethod', label: 'Pay method' },
    { id: 'vendor', label: 'Vendor', default: true },
    { id: 'employeeName', label: 'Staff', default: true },
    { id: 'receiptNumber', label: 'Receipt #' },
    { id: 'referenceNumber', label: 'Reference' },
    { id: 'createdBy', label: 'Created by' },
    { id: 'approvedBy', label: 'Approved by' },
    { id: 'approvedAt', label: 'Approved at' },
    { id: 'paidBy', label: 'Paid by' },
    { id: 'paidAt', label: 'Paid at' },
    { id: 'daysPending', label: 'Days pending', count: true },
    { id: 'rejectionReason', label: 'Rejection reason' },
    { id: 'notes', label: 'Notes' },
  ],
  APPROVAL_PIPELINE: [
    { id: 'status', label: 'Stage', default: true },
    { id: 'expenseCount', label: 'Vouchers', count: true, default: true },
    { id: 'totalAmount', label: 'Amount', money: true, default: true },
    { id: 'averageAmount', label: 'Average', money: true },
    { id: 'avgDaysInStatus', label: 'Avg days', count: true, default: true },
  ],
};

const SUMMARY_CARDS: Array<{ id: string; label: string; hint: string; money?: boolean }> = [
  { id: 'recognizedAmount', label: 'Recognized (P&L)', hint: 'Approved + paid — hits expense GL', money: true },
  { id: 'unpaidApAmount', label: 'Unpaid AP', hint: 'Approved, not yet paid', money: true },
  { id: 'paidAmount', label: 'Paid (cash out)', hint: 'Cleared from bank / cash / MoMo', money: true },
  { id: 'pendingAmount', label: 'Awaiting approval', hint: 'Submitted, not decided', money: true },
  { id: 'voucherCount', label: 'Vouchers', hint: 'Non-cancelled, non-reversed in period' },
  { id: 'draftAmount', label: 'Drafts', hint: 'Not yet submitted', money: true },
  { id: 'rejectedAmount', label: 'Rejected', hint: 'Not recognized', money: true },
];

function defaultColumns(type: ExpenseReportType): string[] {
  return COLUMN_CATALOG[type].filter((c) => c.default).map((c) => c.id);
}

function loadLayout(): {
  report?: ExpenseReportType;
  columnsByReport?: Partial<Record<ExpenseReportType, string[]>>;
} {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function formatCell(col: ColumnDef, value: ReportDataValue): string {
  if (value === null || value === undefined || value === '') return '—';
  if (col.money && typeof value === 'number') return formatCurrency(value);
  if (col.money && typeof value === 'string' && value !== '' && !Number.isNaN(Number(value))) {
    return formatCurrency(Number(value));
  }
  if (col.count && typeof value === 'number') return value.toLocaleString();
  if (typeof value === 'string' && (col.id.toLowerCase().includes('date') || col.id === 'period')) {
    return value.includes('T') ? value.split('T')[0]! : value;
  }
  return String(value);
}

function downloadCsv(filename: string, headers: string[], rows: string[][]) {
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const body = [headers.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))].join('\n');
  const blob = new Blob([body], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function ExpenseReportsPage() {
  const { isAuthenticated } = useAuth();
  const today = getBusinessDate();
  const saved = useMemo(() => loadLayout(), []);

  const [selectedReport, setSelectedReport] = useState<ExpenseReportType>(
    saved.report || 'SUMMARY',
  );
  const [startDate, setStartDate] = useState(() => monthStart(today));
  const [endDate, setEndDate] = useState(today);
  const [columnsByReport, setColumnsByReport] = useState<
    Partial<Record<ExpenseReportType, string[]>>
  >(saved.columnsByReport || {});
  const [reportData, setReportData] = useState<ReportDataRow | ReportDataRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const catalog = COLUMN_CATALOG[selectedReport];
  const selectedColumns = columnsByReport[selectedReport] || defaultColumns(selectedReport);
  const visibleCols = catalog.filter((c) => selectedColumns.includes(c.id));

  useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ report: selectedReport, columnsByReport }),
      );
    } catch {
      /* ignore */
    }
  }, [selectedReport, columnsByReport]);

  const toggleColumn = (id: string) => {
    setColumnsByReport((prev) => {
      const current = prev[selectedReport] || defaultColumns(selectedReport);
      if (current.includes(id)) {
        if (current.length <= 2) return prev;
        return { ...prev, [selectedReport]: current.filter((c) => c !== id) };
      }
      return { ...prev, [selectedReport]: [...current, id] };
    });
  };

  const generateReport = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = localStorage.getItem('auth_token');
      if (!token) throw new Error('Authentication required. Please log in.');

      const params = new URLSearchParams();
      if (startDate) params.append('start_date', startDate);
      if (endDate) params.append('end_date', endDate);

      const response = await fetch(`${ENDPOINTS[selectedReport]}?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        const text = await response.text();
        let message = `Failed to generate report (${response.status})`;
        try {
          const json = JSON.parse(text);
          if (json.error) message = json.error;
        } catch {
          /* keep default */
        }
        throw new Error(message);
      }
      const result = await response.json();
      if (!result.success) throw new Error(result.error || 'Invalid response');
      setReportData(result.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
      setReportData(null);
    } finally {
      setLoading(false);
    }
  }, [selectedReport, startDate, endDate]);

  useEffect(() => {
    if (isAuthenticated) void generateReport();
  }, [isAuthenticated, generateReport]);

  const exportVisibleCsv = () => {
    if (!reportData || !Array.isArray(reportData) || visibleCols.length === 0) return;
    const headers = visibleCols.map((c) => c.label);
    const rows = reportData.map((row) =>
      visibleCols.map((c) => formatCell(c, row[c.id])),
    );
    downloadCsv(
      `expenses_${selectedReport.toLowerCase()}_${startDate}_${endDate}.csv`,
      headers,
      rows,
    );
  };

  if (!isAuthenticated) {
    return (
      <Layout>
        <div className="mx-auto max-w-3xl p-6">
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            Log in to view expense reports.{' '}
            <Link to="/login" className="font-medium underline">
              Log in
            </Link>
          </div>
        </div>
      </Layout>
    );
  }

  const summary = !Array.isArray(reportData) && reportData ? reportData : null;
  const tableRows = Array.isArray(reportData) ? reportData : null;

  const summaryMetrics: AdaptiveReportMetric[] =
    summary && selectedReport === 'SUMMARY'
      ? SUMMARY_CARDS.map((card, idx) => {
          const value = summary[card.id];
          return {
            id: card.id,
            label: card.label,
            value: card.money
              ? formatCurrency(Number(value || 0))
              : Number(value || 0).toLocaleString(),
            sub: card.hint,
            priority: (idx < 2 ? 'primary' : 'secondary') as AdaptiveReportMetric['priority'],
          };
        })
      : [];

  return (
    <Layout>
      <AdaptivePage
        className={REPORT_PAGE_FRAME_CLASS}
        title="Expense reports"
        description="Recognized expense hits P&L on approval; pay clears AP from Cash / Bank / MoMo / Petty. Cancelled vouchers are excluded."
        backLink={<ReportBackLink />}
        primaryActions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => void generateReport()} disabled={loading} className="min-h-[var(--layout-touch-target)]">
              {loading ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="mr-1.5 h-4 w-4" />
              )}
              Refresh
            </Button>
            {tableRows && visibleCols.length > 0 && (
              <Button variant="outline" size="sm" onClick={exportVisibleCsv} className="min-h-[var(--layout-touch-target)]">
                <Download className="mr-1.5 h-4 w-4" />
                Export CSV
              </Button>
            )}
          </div>
        }
      >
        <div className="space-y-5" data-expense-report-filters="true">
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Report type
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {REPORT_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => {
                  setSelectedReport(opt.value);
                  setReportData(null);
                }}
                className={`rounded-lg border px-3 py-2.5 text-left transition ${
                  selectedReport === opt.value
                    ? 'border-indigo-500 bg-indigo-50 ring-1 ring-indigo-500'
                    : 'border-slate-200 hover:border-slate-300'
                }`}
              >
                <div className="text-sm font-semibold text-slate-900">{opt.label}</div>
                <div className="mt-0.5 text-xs text-slate-500">{opt.description}</div>
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="min-w-[260px] flex-1">
            <DateRangeFilter
              startDate={startDate}
              endDate={endDate}
              onStartDateChange={setStartDate}
              onEndDateChange={setEndDate}
              defaultPreset="THIS_MONTH"
              pickersMode="custom"
            />
          </div>
          {catalog.length > 0 && (
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm">
                  <Columns3 className="mr-1.5 h-4 w-4" />
                  Columns ({visibleCols.length}/{catalog.length})
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-72 p-3">
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Display columns
                </div>
                <div className="max-h-72 space-y-1 overflow-auto">
                  {catalog.map((c) => (
                    <label
                      key={c.id}
                      className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-slate-50"
                    >
                      <input
                        type="checkbox"
                        className="rounded border-slate-300"
                        checked={selectedColumns.includes(c.id)}
                        onChange={() => toggleColumn(c.id)}
                      />
                      {c.label}
                    </label>
                  ))}
                </div>
                <button
                  type="button"
                  className="mt-2 text-xs font-medium text-indigo-600 hover:underline"
                  onClick={() =>
                    setColumnsByReport((prev) => ({
                      ...prev,
                      [selectedReport]: defaultColumns(selectedReport),
                    }))
                  }
                >
                  Reset to defaults
                </button>
              </PopoverContent>
            </Popover>
          )}
          <Button onClick={() => void generateReport()} disabled={loading}>
            <FileText className="mr-1.5 h-4 w-4" />
            {loading ? 'Loading…' : 'Run report'}
          </Button>
        </div>

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            {error}
          </div>
        )}

        {loading && !reportData && (
          <div className="flex items-center justify-center gap-2 py-16 text-slate-500">
            <Loader2 className="h-5 w-5 animate-spin" />
            Loading report…
          </div>
        )}

        {summary && selectedReport === 'SUMMARY' && (
          <AdaptiveReportShell
            detailLabel="Expense summary"
            summary={<AdaptiveReportSummary metrics={summaryMetrics} />}
            table={<div className="text-sm text-slate-500 p-2">Summary KPIs shown above — switch report type for tabular detail.</div>}
            cards={
              <div className="space-y-3" data-expense-report-detail="cards">
                {summaryMetrics.map((m) => (
                  <div key={m.id} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{m.label}</div>
                    <div className="mt-1 text-xl font-semibold tabular-nums text-slate-900">{m.value}</div>
                    {m.sub ? <div className="mt-1 text-xs text-slate-500">{m.sub}</div> : null}
                  </div>
                ))}
              </div>
            }
          />
        )}

        {tableRows && (
          <AdaptiveReportShell
            detailLabel="Expense report rows"
            table={
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm" data-expense-report-detail="table">
            <div className="overflow-auto">
              <table className="min-w-full text-sm">
                <thead className="sticky top-0 z-10 border-b border-slate-200 bg-slate-50/95 backdrop-blur">
                  <tr>
                    {visibleCols.map((col) => (
                      <th
                        key={col.id}
                        className={`whitespace-nowrap px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500 ${
                          col.money || col.count ? 'text-right' : ''
                        }`}
                      >
                        {col.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {tableRows.length === 0 ? (
                    <tr>
                      <td
                        colSpan={visibleCols.length || 1}
                        className="p-12 text-center text-slate-500"
                      >
                        No expenses in this period
                      </td>
                    </tr>
                  ) : (
                    tableRows.map((row, idx) => (
                      <tr key={idx} className="hover:bg-slate-50/80">
                        {visibleCols.map((col) => (
                          <td
                            key={col.id}
                            className={`whitespace-nowrap px-3 py-2.5 ${
                              col.money || col.count
                                ? 'text-right tabular-nums font-medium text-slate-900'
                                : 'text-slate-700'
                            }`}
                          >
                            {formatCell(col, row[col.id])}
                          </td>
                        ))}
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            {tableRows.length > 0 && (
              <div className="border-t border-slate-100 px-4 py-2 text-xs text-slate-500">
                {tableRows.length.toLocaleString()} row{tableRows.length === 1 ? '' : 's'} · showing{' '}
                {visibleCols.length} of {catalog.length} columns
              </div>
            )}
          </div>
            }
            cards={
              <div className="space-y-2 overflow-x-auto" data-expense-report-detail="cards">
                <p className="text-xs text-slate-500 px-1">{tableRows.length} rows — scroll horizontally on small screens.</p>
                <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
                  <div className="overflow-auto">
                    <table className="min-w-full text-sm">
                      <thead className="border-b border-slate-200 bg-slate-50">
                        <tr>
                          {visibleCols.slice(0, 4).map((col) => (
                            <th key={col.id} className="whitespace-nowrap px-3 py-2 text-left text-[11px] font-semibold uppercase text-slate-500">
                              {col.label}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {tableRows.slice(0, 25).map((row, idx) => (
                          <tr key={idx}>
                            {visibleCols.slice(0, 4).map((col) => (
                              <td key={col.id} className="whitespace-nowrap px-3 py-2 text-slate-700">
                                {formatCell(col, row[col.id])}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            }
          />
        )}
        </div>
      </AdaptivePage>
    </Layout>
  );
}
