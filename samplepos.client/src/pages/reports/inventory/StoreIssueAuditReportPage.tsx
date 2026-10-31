/**
 * Store Issue Audit — posted goods issues and reversals.
 * KPIs + always-visible movement list. Reverse rate flags unusual cancellations.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, Loader2, RefreshCw, ShieldAlert } from 'lucide-react';
import Layout from '../../../components/Layout';
import { useRestaurantEnabled } from '../../../hooks/useRestaurantEnabled';
import { DateRangeFilter } from '../../../components/ui/DateRangeFilter';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { ReportBackLink } from '../../../components/reports/ReportBackLink';
import {
  AdaptivePage,
  AdaptiveReportFilters,
  AdaptiveReportShell,
  AdaptiveReportSummary,
  type AdaptiveReportMetric,
  useAdaptiveLayoutOptional,
} from '../../../components/adaptive';
import {
  REPORT_FILTER_CONTROL_CLASS,
  REPORT_FILTER_LABEL_CLASS,
  REPORT_PAGE_FRAME_CLASS,
  resolveReportDatePickersMode,
} from '../../../lib/adaptiveReports';
import apiClient from '../../../utils/api';
import { downloadFile } from '../../../utils/download';
import { getBusinessDate } from '../../../utils/businessDate';
import { formatCurrency } from '../../../utils/currency';
import {
  STORE_ISSUE_REVERSE_RATE_WATCH,
  formatQtyWithUom,
  storeIssueAuditMovementLabel,
} from '@shared/store-issue/issuePlan';

type MovementFilter = 'ALL' | 'ISSUE' | 'REVERSE';

type AuditRow = {
  documentId: string;
  documentNumber: string;
  postingDate: string;
  status: string;
  issuedTo: string;
  storeName: string | null;
  productId: string;
  productName: string;
  sku: string | null;
  movementType: 'GOODS_ISSUE' | 'GOODS_ISSUE_REVERSAL';
  quantity: number;
  uomName: string | null;
  amount: number;
  postedByName: string | null;
  reversedByName: string | null;
  reversalReason: string | null;
};

type AuditTotals = {
  issuedAmount: number;
  reversedAmount: number;
  netAmount: number;
  reverseRate: number;
  issuedQty: number;
  reversedQty: number;
  issueLines: number;
  reverseLines: number;
};

type AuditReport = {
  startDate: string;
  endDate: string;
  rows: AuditRow[];
  totals: AuditTotals;
};

function monthStart(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

function rowKey(row: AuditRow, index: number): string {
  return `${row.documentId}:${row.movementType}:${row.productId}:${index}`;
}

export default function StoreIssueAuditReportPage() {
  const { data: restaurantEnabled, isLoading: flagLoading } = useRestaurantEnabled();
  const today = getBusinessDate();
  const layout = useAdaptiveLayoutOptional();
  const datePickersMode = resolveReportDatePickersMode(layout?.tier ?? 'desktop');
  const [startDate, setStartDate] = useState(monthStart(today));
  const [endDate, setEndDate] = useState(today);
  const [movement, setMovement] = useState<MovementFilter>('ALL');
  const [search, setSearch] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [data, setData] = useState<AuditReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const handle = window.setTimeout(() => setAppliedSearch(search.trim()), 250);
    return () => window.clearTimeout(handle);
  }, [search]);

  useEffect(() => {
    if (!restaurantEnabled) {
      setLoading(false);
      setData(null);
      return;
    }
    const ac = new AbortController();
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiClient
      .get('/reports/inventory/store-issues', {
        signal: ac.signal,
        params: {
          startDate,
          endDate,
          movement,
          search: appliedSearch || undefined,
        },
      })
      .then((r) => {
        if (!cancelled) setData(r.data?.data as AuditReport);
      })
      .catch((e) => {
        if (cancelled || e?.code === 'ERR_CANCELED' || e?.name === 'CanceledError' || e?.name === 'AbortError') {
          return;
        }
        setError(e?.response?.data?.error || e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [restaurantEnabled, startDate, endDate, movement, appliedSearch, reloadKey]);

  const metrics: AdaptiveReportMetric[] = useMemo(() => {
    const totals = data?.totals;
    if (!totals) return [];
    const watch = totals.reverseRate >= STORE_ISSUE_REVERSE_RATE_WATCH;
    return [
      {
        id: 'issued',
        label: 'Issued',
        value: formatCurrency(totals.issuedAmount),
        sub: `${totals.issueLines.toLocaleString()} line(s)`,
        priority: 'primary',
      },
      {
        id: 'reversed',
        label: 'Reversed',
        value: formatCurrency(totals.reversedAmount),
        sub: `${totals.reverseLines.toLocaleString()} line(s)`,
        priority: 'primary',
        toneClassName: totals.reversedAmount > 0 ? 'text-amber-800' : undefined,
      },
      {
        id: 'net',
        label: 'Net consumption',
        value: formatCurrency(totals.netAmount),
        sub: 'Issued minus reversed',
        priority: 'primary',
        accent: true,
      },
      {
        id: 'rate',
        label: 'Reverse rate',
        value: `${(totals.reverseRate * 100).toFixed(1)}%`,
        sub: watch ? 'Watch — high cancellations' : 'Reversed / issued',
        priority: 'primary',
        toneClassName: watch ? 'text-amber-800' : undefined,
      },
    ];
  }, [data]);

  const exportQuery = useMemo(() => {
    const params = new URLSearchParams({ startDate, endDate, movement });
    if (appliedSearch) params.set('search', appliedSearch);
    return params.toString();
  }, [startDate, endDate, movement, appliedSearch]);

  const table = (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm" data-store-issue-audit="table">
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="sticky top-0 z-10 border-b border-slate-200 bg-slate-50/95 backdrop-blur">
            <tr>
              <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500">Date</th>
              <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500">Document</th>
              <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500">Movement</th>
              <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500">Product</th>
              <th className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wide text-slate-500">Qty</th>
              <th className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wide text-slate-500">Amount</th>
              <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500">Posted by</th>
              <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500">Reversed by</th>
              <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500">Reason</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {(data?.rows || []).map((row, i) => {
              const reverse = row.movementType === 'GOODS_ISSUE_REVERSAL';
              return (
                <tr key={rowKey(row, i)} className={reverse ? 'bg-amber-50/60' : 'hover:bg-slate-50'}>
                  <td className="whitespace-nowrap px-3 py-2 text-slate-700">{row.postingDate}</td>
                  <td className="whitespace-nowrap px-3 py-2 font-medium text-slate-900">{row.documentNumber}</td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${
                        reverse ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-700'
                      }`}
                    >
                      {storeIssueAuditMovementLabel(row.movementType)}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <div className="font-medium text-slate-900">{row.productName}</div>
                    <div className="text-xs text-slate-500">
                      {row.sku || '—'}
                      {row.storeName ? ` · ${row.storeName}` : ''}
                      {row.issuedTo ? ` · ${row.issuedTo}` : ''}
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right font-mono">
                    {formatQtyWithUom(row.quantity, row.uomName)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right font-medium">
                    {formatCurrency(row.amount)}
                  </td>
                  <td className="px-3 py-2 text-slate-700">{row.postedByName || '—'}</td>
                  <td className="px-3 py-2 text-slate-700">{row.reversedByName || '—'}</td>
                  <td className="px-3 py-2 text-slate-700">{row.reversalReason || '—'}</td>
                </tr>
              );
            })}
            {data && data.rows.length === 0 && (
              <tr>
                <td colSpan={9} className="px-3 py-8 text-center text-slate-500">
                  No posted issues or reversals in this period.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );

  const cards = (
    <div className="space-y-3" data-store-issue-audit="cards">
      {(data?.rows || []).map((row, i) => {
        const reverse = row.movementType === 'GOODS_ISSUE_REVERSAL';
        return (
          <div
            key={rowKey(row, i)}
            className={`rounded-xl border bg-white p-4 shadow-sm ${
              reverse ? 'border-amber-200' : 'border-slate-200'
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-slate-900">{row.documentNumber}</div>
                <div className="text-xs text-slate-500">{row.postingDate}</div>
              </div>
              <span
                className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${
                  reverse ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-700'
                }`}
              >
                {storeIssueAuditMovementLabel(row.movementType)}
              </span>
            </div>
            <div className="mt-2 text-sm font-medium text-slate-900">{row.productName}</div>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-600">
              <span>{formatQtyWithUom(row.quantity, row.uomName)}</span>
              <span className="font-medium text-slate-900">{formatCurrency(row.amount)}</span>
            </div>
            <div className="mt-2 text-xs text-slate-500">
              Posted by {row.postedByName || '—'}
              {reverse ? ` · Reversed by ${row.reversedByName || '—'}` : ''}
            </div>
            {row.reversalReason ? (
              <div className="mt-2 text-sm text-slate-700">Reason: {row.reversalReason}</div>
            ) : null}
          </div>
        );
      })}
      {data && data.rows.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-500">
          No posted issues or reversals in this period.
        </div>
      ) : null}
    </div>
  );

  if (flagLoading) {
    return (
      <Layout>
        <div className="p-6 text-gray-500">Loading…</div>
      </Layout>
    );
  }

  if (!restaurantEnabled) {
    return (
      <Layout>
        <div className="p-6">
          <div className="rounded-lg border bg-gray-50 p-8 text-center text-gray-600">
            <h2 className="text-2xl font-bold text-gray-900">Store Issue Audit</h2>
            <p className="mt-2">Restaurant mode is required.</p>
            <Link to="/reports" className="mt-3 inline-block text-sm text-indigo-600 hover:text-indigo-800">
              Back to reports
            </Link>
          </div>
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <AdaptivePage
        className={REPORT_PAGE_FRAME_CLASS}
        title="Store Issue Audit"
        description="Posted warehouse issues and reversals — who posted, who reversed, why, and reverse rate."
        backLink={<ReportBackLink />}
        primaryActions={
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setReloadKey((k) => k + 1)}
              disabled={loading}
              className="min-h-[var(--layout-touch-target)]"
            >
              {loading ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-1.5 h-4 w-4" />}
              Refresh
            </Button>
            {data && (
              <Button
                variant="outline"
                size="sm"
                className="min-h-[var(--layout-touch-target)]"
                onClick={() => {
                  const headers = [
                    'Date',
                    'Document',
                    'Movement',
                    'Product',
                    'SKU',
                    'Qty',
                    'UoM',
                    'Amount',
                    'Posted by',
                    'Reversed by',
                    'Reason',
                  ];
                  const rows = data.rows.map((r) => [
                    r.postingDate,
                    r.documentNumber,
                    storeIssueAuditMovementLabel(r.movementType),
                    r.productName,
                    r.sku ?? '',
                    r.quantity,
                    r.uomName ?? '',
                    r.amount,
                    r.postedByName ?? '',
                    r.reversedByName ?? '',
                    r.reversalReason ?? '',
                  ]);
                  const csv = [headers, ...rows].map((row) => row.map((v) => JSON.stringify(v)).join(',')).join('\n');
                  const a = Object.assign(document.createElement('a'), {
                    href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })),
                    download: `store_issue_audit_${startDate}_${endDate}.csv`,
                  });
                  a.click();
                }}
              >
                <Download className="mr-1.5 h-4 w-4" />
                CSV
              </Button>
            )}
            {data && (
              <Button
                variant="outline"
                size="sm"
                className="min-h-[var(--layout-touch-target)]"
                onClick={async () => {
                  try {
                    await downloadFile(
                      `/reports/inventory/store-issues?${exportQuery}&format=pdf`,
                      `store_issue_audit_${startDate}_${endDate}.pdf`,
                    );
                  } catch (err) {
                    alert(err instanceof Error ? err.message : 'Failed to export PDF');
                  }
                }}
              >
                <Download className="mr-1.5 h-4 w-4" />
                PDF
              </Button>
            )}
          </div>
        }
        toolbar={
          <AdaptiveReportFilters
            primary={
              <div className="space-y-3">
                <DateRangeFilter
                  startDate={startDate}
                  endDate={endDate}
                  onStartDateChange={setStartDate}
                  onEndDateChange={setEndDate}
                  defaultPreset="THIS_MONTH"
                  pickersMode={datePickersMode}
                />
                <div className="min-w-0">
                  <label className={REPORT_FILTER_LABEL_CLASS} htmlFor="si-audit-movement">
                    Movement
                  </label>
                  <select
                    id="si-audit-movement"
                    value={movement}
                    onChange={(e) => setMovement(e.target.value as MovementFilter)}
                    className={REPORT_FILTER_CONTROL_CLASS}
                    data-si-audit-movement="true"
                  >
                    <option value="ALL">All movements</option>
                    <option value="ISSUE">Issues</option>
                    <option value="REVERSE">Reversals</option>
                  </select>
                </div>
              </div>
            }
            secondary={
              <div className="min-w-0">
                <label className={REPORT_FILTER_LABEL_CLASS} htmlFor="si-audit-search">
                  Search
                </label>
                <Input
                  id="si-audit-search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Document, product, user, reason"
                  className={REPORT_FILTER_CONTROL_CLASS}
                />
              </div>
            }
          />
        }
      >
        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>
        )}

        {loading && !data && (
          <div className="flex items-center justify-center gap-2 py-16 text-slate-500">
            <Loader2 className="h-5 w-5 animate-spin" />
            Loading report…
          </div>
        )}

        {data && (data.totals.reverseRate >= STORE_ISSUE_REVERSE_RATE_WATCH) && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
            Reverse rate is high for this period. Check who reversed, the reason, and whether stock was actually returned.
          </div>
        )}

        {data && (
          <AdaptiveReportShell
            detailLabel="Store issue movements"
            summary={<AdaptiveReportSummary metrics={metrics} />}
            table={table}
            cards={cards}
            reducedTable={table}
          />
        )}
      </AdaptivePage>
    </Layout>
  );
}
