/**
 * Go-live cutover AR/AP — compact icon UI (Tally/SAP/Odoo style).
 * Long guidance is tooltip-only; primary surface is numbers + actions.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AxiosError } from 'axios';
import {
  AlertTriangle,
  Banknote,
  Calendar,
  ChevronDown,
  ChevronRight,
  CircleDollarSign,
  FileText,
  History,
  Plus,
  Replace,
  Upload,
  User,
  Wallet,
} from 'lucide-react';
import { toast } from 'react-hot-toast';
import { api } from '../../utils/api';
import { formatCurrency } from '../../utils/currency';
import { formatTimestampDate } from '../../utils/businessDate';
import {
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/temp-ui-components';
import { DatePicker } from '../ui/date-picker';

export type OpeningBalancePartyOption = { id: string; name: string };

type Mode = 'first' | 'increase' | 'rewrite';

type AuditRow = {
  id: string;
  action: string;
  userName?: string | null;
  notes?: string | null;
  createdAt: string;
  oldValues?: { amount?: number } | null;
  newValues?: { amount?: number; increaseBy?: number } | null;
};

type CutoverSummary = {
  customerId?: string;
  supplierId?: string;
  customerName?: string;
  supplierName?: string;
  currentOutstanding: number;
  hasActiveCutover: boolean;
  cutover: null | {
    invoiceId: string;
    invoiceNumber: string;
    documentTotal: number;
    amountPaid: number;
    amountDue: number;
    issueDate: string;
    status: string;
  };
  otherOpenInvoicesDue: number;
  otherOpenInvoiceCount: number;
  unallocatedCash: number;
  guidance: string[];
};

type ImpactDetails = {
  warnings?: string[];
  currentObAmount?: number;
  newObAmount?: number;
  allocatedOnOb?: number;
  projectedSurplusOnAccount?: number;
  otherOpenInvoicesDue?: number;
  currentOutstanding?: number;
  projectedOutstanding?: number;
};

type Props = {
  partyType: 'customer' | 'supplier';
  partyId: string;
  onPartyIdChange: (id: string) => void;
  parties: OpeningBalancePartyOption[];
  onSuccess?: () => void;
  defaultExpanded?: boolean;
};

export const OpeningBalancePanel: React.FC<Props> = ({
  partyType,
  partyId,
  onPartyIdChange,
  parties,
  onSuccess,
  defaultExpanded = false,
}) => {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [showHistory, setShowHistory] = useState(false);
  const [amount, setAmount] = useState('');
  const [asOfDate, setAsOfDate] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [notes, setNotes] = useState('');
  const [reason, setReason] = useState('');
  const [mode, setMode] = useState<Mode>('first');
  const [posting, setPosting] = useState(false);
  const [history, setHistory] = useState<AuditRow[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [summary, setSummary] = useState<CutoverSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);

  const loadHistory = useCallback(async () => {
    if (!partyId) {
      setHistory([]);
      return;
    }
    setHistoryLoading(true);
    try {
      const res =
        partyType === 'customer'
          ? await api.get<{ success: boolean; data: AuditRow[] }>('customers/opening-balance/history', {
              params: { customerId: partyId },
            })
          : await api.get<{ success: boolean; data: AuditRow[] }>(
              'supplier-payments/invoices/opening-balance/history',
              { params: { supplierId: partyId } },
            );
      setHistory(res.data.data ?? []);
    } catch {
      setHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  }, [partyId, partyType]);

  const loadSummary = useCallback(async () => {
    if (!partyId) {
      setSummary(null);
      return;
    }
    setSummaryLoading(true);
    try {
      const res =
        partyType === 'customer'
          ? await api.customers.getOpeningBalanceSummary(partyId)
          : await api.supplierPayments.getOpeningBalanceSummary(partyId);
      const data = (res.data as { data?: CutoverSummary })?.data ?? null;
      setSummary(data);
      if (data?.hasActiveCutover) {
        setMode((m) => (m === 'first' ? 'increase' : m));
        if (data.cutover?.issueDate) {
          setAsOfDate((prev) => prev || data.cutover!.issueDate);
        }
      } else {
        setMode('first');
      }
    } catch {
      setSummary(null);
    } finally {
      setSummaryLoading(false);
    }
  }, [partyId, partyType]);

  useEffect(() => {
    if (expanded && partyId) {
      void loadHistory();
      void loadSummary();
    }
  }, [expanded, partyId, loadHistory, loadSummary]);

  const amountPlaceholder = useMemo(() => {
    if (mode === 'increase') return 'Add amount only';
    if (mode === 'rewrite') return 'Full cutover total';
    return 'Cutover total';
  }, [mode]);

  const livePreview = useMemo(() => {
    const n = parseFloat(amount);
    if (!Number.isFinite(n) || n <= 0 || !summary) return null;
    if (mode === 'increase' && summary.cutover) {
      return {
        newCutoverTotal: summary.cutover.documentTotal + n,
        hintOutstanding: summary.currentOutstanding + n,
      };
    }
    if (mode === 'rewrite' && summary.cutover) {
      return { newCutoverTotal: n, hintOutstanding: null as number | null };
    }
    if (mode === 'first') {
      return {
        newCutoverTotal: n,
        hintOutstanding: summary.currentOutstanding + n,
      };
    }
    return null;
  }, [amount, mode, summary]);

  async function postCustomerReplace(body: {
    customerId: string;
    amount: number;
    asOfDate: string;
    dueDate?: string;
    notes?: string;
    replaceReason: string;
    confirmImpact?: boolean;
  }) {
    try {
      await api.customers.replaceOpeningBalance(body);
    } catch (err) {
      const axErr = err as AxiosError<{
        error?: string;
        error_code?: string;
        details?: ImpactDetails;
      }>;
      if (axErr.response?.data?.error_code !== 'OB_REPLACE_CONFIRM_REQUIRED') {
        throw err;
      }
      const d = axErr.response.data.details ?? {};
      const lines = [
        'Confirm rewrite',
        `Cutover ${formatCurrency(Number(d.currentObAmount ?? 0))} → ${formatCurrency(Number(d.newObAmount ?? 0))}`,
        `Outstanding now ${formatCurrency(Number(d.currentOutstanding ?? 0))} → ~${formatCurrency(Number(d.projectedOutstanding ?? 0))}`,
        ...(d.warnings ?? []).slice(0, 3),
        'Continue?',
      ];
      if (!window.confirm(lines.join('\n'))) throw new Error('Correction cancelled');
      await api.customers.replaceOpeningBalance({ ...body, confirmImpact: true });
    }
  }

  async function postCustomerIncrease(body: {
    customerId: string;
    increaseBy: number;
    asOfDate: string;
    dueDate?: string;
    notes?: string;
    reason: string;
  }) {
    try {
      await api.customers.increaseOpeningBalance(body);
    } catch (err) {
      const axErr = err as AxiosError<{
        error?: string;
        error_code?: string;
        details?: ImpactDetails;
      }>;
      if (axErr.response?.data?.error_code !== 'OB_REPLACE_CONFIRM_REQUIRED') {
        throw err;
      }
      const d = axErr.response.data.details ?? {};
      const lines = [
        `Confirm +${formatCurrency(body.increaseBy)}`,
        `Cutover → ${formatCurrency(Number(d.newObAmount ?? 0))}`,
        `Outstanding ~ ${formatCurrency(Number(d.projectedOutstanding ?? 0))}`,
        'Continue?',
      ];
      if (!window.confirm(lines.join('\n'))) throw new Error('Correction cancelled');
      await api.customers.increaseOpeningBalance({ ...body, confirmImpact: true });
    }
  }

  const handleSubmit = async () => {
    if (!partyId) {
      toast.error(partyType === 'customer' ? 'Select a customer' : 'Select a supplier');
      return;
    }
    const amt = parseFloat(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      toast.error('Enter a positive amount');
      return;
    }
    if (!asOfDate) {
      toast.error('Cutover date required');
      return;
    }
    if (dueDate && dueDate > asOfDate) {
      toast.error('Invoice date cannot be after cutover date');
      return;
    }
    const auditReason = reason.trim();
    if (auditReason.length < 5) {
      toast.error('Reason min 5 characters');
      return;
    }

    if (mode === 'first' && summary?.hasActiveCutover) {
      toast.error('Already has cutover — use Increase or Rewrite');
      return;
    }
    if ((mode === 'increase' || mode === 'rewrite') && !summary?.hasActiveCutover) {
      toast.error('Post go-live cutover first');
      return;
    }

    if (
      mode === 'rewrite' &&
      summary &&
      Math.abs(amt - summary.currentOutstanding) < 1 &&
      summary.cutover &&
      Math.abs(summary.cutover.documentTotal - summary.currentOutstanding) > 1
    ) {
      const ok = window.confirm(
        `Amount matches today’s outstanding (${formatCurrency(amt)}), not cutover ${formatCurrency(summary.cutover.documentTotal)}.\nUse Increase for extra debt. Rewrite anyway?`,
      );
      if (!ok) return;
    }

    setPosting(true);
    try {
      if (partyType === 'customer') {
        if (mode === 'first') {
          await api.customers.importOpeningBalance({
            customerId: partyId,
            amount: amt,
            asOfDate,
            dueDate: dueDate || undefined,
            notes: notes || undefined,
            postReason: auditReason,
          });
          toast.success('Cutover posted');
        } else if (mode === 'increase') {
          await postCustomerIncrease({
            customerId: partyId,
            increaseBy: amt,
            asOfDate,
            dueDate: dueDate || undefined,
            notes: notes || undefined,
            reason: auditReason,
          });
          toast.success(`+${formatCurrency(amt)}`);
        } else {
          await postCustomerReplace({
            customerId: partyId,
            amount: amt,
            asOfDate,
            dueDate: dueDate || undefined,
            notes: notes || undefined,
            replaceReason: auditReason,
          });
          toast.success('Cutover rewritten');
        }
      } else if (mode === 'first') {
        await api.supplierPayments.importOpeningBalance({
          supplierId: partyId,
          amount: amt,
          asOfDate,
          dueDate: dueDate || undefined,
          notes: notes || undefined,
          postReason: auditReason,
        });
        toast.success('Cutover posted');
      } else if (mode === 'increase') {
        await api.supplierPayments.increaseOpeningBalance({
          supplierId: partyId,
          increaseBy: amt,
          asOfDate,
          dueDate: dueDate || undefined,
          notes: notes || undefined,
          reason: auditReason,
        });
        toast.success(`+${formatCurrency(amt)}`);
      } else {
        if (!window.confirm('Rewrite supplier cutover total?')) return;
        await api.supplierPayments.replaceOpeningBalance({
          supplierId: partyId,
          amount: amt,
          asOfDate,
          dueDate: dueDate || undefined,
          notes: notes || undefined,
          replaceReason: auditReason,
        });
        toast.success('Cutover rewritten');
      }
      setAmount('');
      setNotes('');
      setReason('');
      void loadHistory();
      void loadSummary();
      onSuccess?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (msg === 'Correction cancelled') {
        toast('Cancelled');
        return;
      }
      const axErr = err as AxiosError<{ error?: string }>;
      toast.error(axErr.response?.data?.error ?? (msg || 'Failed'));
    } finally {
      setPosting(false);
    }
  };

  const partyLabel = partyType === 'customer' ? 'Customer' : 'Supplier';
  const submitLabel =
    mode === 'first' ? 'Post' : mode === 'increase' ? 'Increase' : 'Rewrite';

  return (
    <div className="rounded-lg border border-indigo-200 bg-indigo-50/30 overflow-hidden">
      <button
        type="button"
        className="w-full flex items-center justify-between gap-2 px-3 py-2.5 text-left hover:bg-indigo-50 transition-colors"
        onClick={() => setExpanded((e) => !e)}
        title="Legacy debt from the old system at go-live (not cash, not list balance)"
      >
        <span className="flex items-center gap-2 font-medium text-indigo-900 text-sm">
          <Wallet className="h-4 w-4 shrink-0" />
          Cutover
        </span>
        {expanded ? (
          <ChevronDown className="h-4 w-4 text-indigo-600 shrink-0" />
        ) : (
          <ChevronRight className="h-4 w-4 text-indigo-600 shrink-0" />
        )}
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-3 border-t border-indigo-100 bg-white/70">
          {/* Party */}
          <div className="pt-3 flex items-center gap-2">
            <User className="h-4 w-4 text-slate-500 shrink-0" />
            <Select value={partyId} onValueChange={onPartyIdChange}>
              <SelectTrigger className="h-9">
                <SelectValue placeholder={partyLabel} />
              </SelectTrigger>
              <SelectContent>
                {parties.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Metric icons */}
          {partyId && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {summaryLoading ? (
                <p className="col-span-full text-xs text-gray-500">Loading…</p>
              ) : summary ? (
                <>
                  <MetricTile
                    icon={<CircleDollarSign className="h-4 w-4" />}
                    label="Outstanding"
                    value={formatCurrency(summary.currentOutstanding)}
                    hint="Calculated today — do not type this into cutover"
                    muted
                  />
                  <MetricTile
                    icon={<FileText className="h-4 w-4" />}
                    label="Cutover doc"
                    value={
                      summary.cutover
                        ? formatCurrency(summary.cutover.documentTotal)
                        : '—'
                    }
                    hint={
                      summary.cutover
                        ? `${summary.cutover.invoiceNumber} · paid ${formatCurrency(summary.cutover.amountPaid)} · due ${formatCurrency(summary.cutover.amountDue)}`
                        : 'No go-live cutover yet'
                    }
                    accent
                  />
                  <MetricTile
                    icon={<FileText className="h-4 w-4 opacity-70" />}
                    label="Open bills"
                    value={formatCurrency(summary.otherOpenInvoicesDue)}
                    hint={
                      summary.otherOpenInvoiceCount > 0
                        ? `${summary.otherOpenInvoiceCount} open (excl. cutover)`
                        : 'No other open bills'
                    }
                    muted
                  />
                  {partyType === 'customer' ? (
                    <MetricTile
                      icon={<Banknote className="h-4 w-4" />}
                      label="On-account"
                      value={formatCurrency(summary.unallocatedCash)}
                      hint="Unallocated receipt cash"
                      muted
                    />
                  ) : (
                    <MetricTile
                      icon={<Banknote className="h-4 w-4 opacity-40" />}
                      label="On-account"
                      value="—"
                      hint="AR on-account n/a for supplier"
                      muted
                    />
                  )}
                </>
              ) : (
                <p className="col-span-full text-xs text-gray-500">Snapshot unavailable</p>
              )}
            </div>
          )}

          {/* Mode icons */}
          {partyId && (
            <div className="grid grid-cols-3 gap-2">
              <ModeIconBtn
                active={mode === 'first'}
                disabled={Boolean(summary?.hasActiveCutover)}
                onClick={() => setMode('first')}
                icon={<Upload className="h-5 w-5" />}
                label="Post"
                title="First go-live cutover — full amount they owed at cutover"
              />
              <ModeIconBtn
                active={mode === 'increase'}
                disabled={!summary?.hasActiveCutover}
                onClick={() => setMode('increase')}
                icon={<Plus className="h-5 w-5" />}
                label="Increase"
                title="Add extra legacy debt only (e.g. +50,000)"
              />
              <ModeIconBtn
                active={mode === 'rewrite'}
                disabled={!summary?.hasActiveCutover}
                onClick={() => setMode('rewrite')}
                icon={<Replace className="h-5 w-5" />}
                label="Rewrite"
                title="Advanced: set full cutover document total (not today’s outstanding)"
              />
            </div>
          )}

          {mode === 'rewrite' && (
            <div
              className="flex items-center gap-1.5 text-[11px] text-amber-800 bg-amber-50 border border-amber-100 rounded px-2 py-1"
              title="Reducing total may unallocate receipts on the old cutover"
            >
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              Full total from old books
            </div>
          )}

          {/* Form */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div>
              <Label className="text-[11px] text-gray-500 mb-0.5 flex items-center gap-1">
                <CircleDollarSign className="h-3 w-3" />
                {mode === 'increase' ? 'Add *' : mode === 'rewrite' ? 'Full total *' : 'Amount *'}
              </Label>
              <Input
                type="number"
                step="1"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder={amountPlaceholder}
                className="h-9"
              />
            </div>
            <div>
              <Label className="text-[11px] text-gray-500 mb-0.5 flex items-center gap-1">
                <Calendar className="h-3 w-3" />
                Date *
              </Label>
              <DatePicker value={asOfDate} onChange={setAsOfDate} placeholder="Cutover date" />
            </div>
            <div>
              <Label className="text-[11px] text-gray-500 mb-0.5 block">Invoice date</Label>
              <DatePicker value={dueDate} onChange={setDueDate} placeholder="Optional" />
            </div>
            <div>
              <Label className="text-[11px] text-gray-500 mb-0.5 block">Notes</Label>
              <Input
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Optional"
                className="h-9"
              />
            </div>
            <div className="sm:col-span-2">
              <Label className="text-[11px] text-gray-500 mb-0.5 block">Reason *</Label>
              <Input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={mode === 'increase' ? 'Why add legacy debt' : 'Audit reason'}
                className="h-9"
              />
            </div>
          </div>

          {livePreview && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-indigo-900 bg-indigo-50 border border-indigo-100 rounded px-2 py-1.5">
              <span>
                → doc <strong>{formatCurrency(livePreview.newCutoverTotal)}</strong>
              </span>
              {livePreview.hintOutstanding != null && (
                <span>
                  · out ~ <strong>{formatCurrency(livePreview.hintOutstanding)}</strong>
                </span>
              )}
            </div>
          )}

          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              className="inline-flex items-center gap-1 text-[11px] text-gray-600 hover:text-gray-900"
              onClick={() => setShowHistory((h) => !h)}
            >
              <History className="h-3.5 w-3.5" />
              History
              {showHistory ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
            </button>
            <Button onClick={() => void handleSubmit()} disabled={posting} size="sm">
              {posting ? '…' : submitLabel}
            </Button>
          </div>

          {showHistory && (
            <div className="border-t border-gray-100 pt-2">
              {historyLoading ? (
                <p className="text-xs text-gray-500">Loading…</p>
              ) : history.length === 0 ? (
                <p className="text-xs text-gray-500">No history</p>
              ) : (
                <ul className="space-y-1.5 max-h-36 overflow-y-auto text-[11px]">
                  {history.map((row) => (
                    <li
                      key={row.id}
                      className="rounded border border-gray-100 bg-gray-50 px-2 py-1 flex flex-wrap justify-between gap-1"
                    >
                      <span className="font-medium text-gray-800">
                        {row.action}
                        {row.oldValues?.amount != null && row.newValues?.amount != null && (
                          <>
                            {' '}
                            {formatCurrency(row.oldValues.amount)}→
                            {formatCurrency(row.newValues.amount)}
                          </>
                        )}
                        {row.newValues?.increaseBy != null && (
                          <> +{formatCurrency(row.newValues.increaseBy)}</>
                        )}
                      </span>
                      <span className="text-gray-500">
                        {formatTimestampDate(row.createdAt)} · {row.userName ?? '—'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

function MetricTile({
  icon,
  label,
  value,
  hint,
  muted,
  accent,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint: string;
  muted?: boolean;
  accent?: boolean;
}) {
  return (
    <div
      title={hint}
      className={`rounded-md border px-2 py-1.5 min-h-[3.25rem] ${
        accent
          ? 'border-indigo-200 bg-indigo-50/80'
          : muted
            ? 'border-slate-100 bg-slate-50/80'
            : 'border-gray-100 bg-white'
      }`}
    >
      <div
        className={`flex items-center gap-1 text-[10px] uppercase tracking-wide ${
          accent ? 'text-indigo-700' : 'text-slate-500'
        }`}
      >
        {icon}
        {label}
      </div>
      <div
        className={`text-sm font-semibold tabular-nums leading-tight mt-0.5 ${
          accent ? 'text-indigo-950' : 'text-slate-900'
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function ModeIconBtn({
  active,
  disabled,
  onClick,
  icon,
  label,
  title,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  title: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={title}
      className={`flex flex-col items-center justify-center gap-0.5 rounded-md border px-1 py-2 text-[11px] font-medium transition-colors ${
        active
          ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm'
          : disabled
            ? 'bg-gray-50 text-gray-300 border-gray-100 cursor-not-allowed'
            : 'bg-white text-gray-700 border-gray-200 hover:border-indigo-400 hover:bg-indigo-50/40'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}