/**
 * Bad Debt workqueue — ADR-006 Phase 4C
 * Overdue open invoices → allocate (full/partial, multi-invoice) → post / reverse.
 * Commercial credit notes (4010) are a different path — do not use CN for uncollectibles.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, FileWarning, Loader2, ShieldAlert } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select';
import {
  useBadDebtDocuments,
  useBadDebtEnabled,
  useBadDebtWorkqueue,
  usePostBadDebtWriteoff,
  useReverseBadDebtWriteoff,
} from '../../hooks/useAccountingModules';
import { getBusinessDate } from '../../utils/businessDate';

type ReasonCode = 'UNCOLLECTIBLE' | 'DISPUTE_LOST' | 'BANKRUPTCY' | 'OTHER';

interface WorkqueueLine {
  invoiceId: string;
  invoiceNumber: string;
  customerId: string;
  customerName: string;
  dueDate: string | null;
  amountDue: number;
  ageDays: number;
  status: string;
}

interface WriteoffDoc {
  id: string;
  documentNumber: string;
  customerId: string;
  totalAmount: number;
  reasonCode: string;
  writeoffDate: string;
  postedAt: string | null;
  reversedByDocumentId: string | null;
  lines: Array<{ invoiceId: string; writeoffAmount: number }>;
}

function fmt(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function BadDebtWriteoffPage() {
  const today = getBusinessDate();
  const [minAgeDays, setMinAgeDays] = useState(30);
  const [reasonCode, setReasonCode] = useState<ReasonCode>('UNCOLLECTIBLE');
  const [writeoffDate, setWriteoffDate] = useState(today);
  const [memo, setMemo] = useState('');
  const [selected, setSelected] = useState<Record<string, { amount: string; customerId: string }>>(
    {},
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<string | null>(null);

  const enabledQ = useBadDebtEnabled();
  const workqueueQ = useBadDebtWorkqueue({ minAgeDays });
  const docsQ = useBadDebtDocuments({ limit: 30 });
  const postMutation = usePostBadDebtWriteoff();
  const reverseMutation = useReverseBadDebtWriteoff();

  const featureOn = enabledQ.data?.enabled === true;
  const workqueue = workqueueQ.data;
  const lines = (workqueue?.lines ?? []) as WorkqueueLine[];
  const docs = (docsQ.data ?? []) as WriteoffDoc[];

  const selectedLines = useMemo(() => {
    return Object.entries(selected)
      .map(([invoiceId, v]) => ({
        invoiceId,
        writeoffAmount: Number(v.amount),
        customerId: v.customerId,
      }))
      .filter((l) => l.writeoffAmount > 0);
  }, [selected]);

  const selectedCustomerIds = useMemo(
    () => [...new Set(selectedLines.map((l) => l.customerId))],
    [selectedLines],
  );

  const totalSelected = selectedLines.reduce((s, l) => s + l.writeoffAmount, 0);
  const canPost =
    featureOn
    && selectedLines.length > 0
    && selectedCustomerIds.length === 1
    && !!writeoffDate
    && !postMutation.isPending;

  const toggleLine = (line: WorkqueueLine, checked: boolean) => {
    setSelected((prev) => {
      const next = { ...prev };
      if (!checked) {
        delete next[line.invoiceId];
      } else {
        next[line.invoiceId] = {
          amount: String(line.amountDue),
          customerId: line.customerId,
        };
      }
      return next;
    });
  };

  const setAmount = (invoiceId: string, amount: string, customerId: string) => {
    setSelected((prev) => ({
      ...prev,
      [invoiceId]: { amount, customerId },
    }));
  };

  const handlePost = async () => {
    setActionError(null);
    setLastResult(null);
    if (!canPost) {
      if (selectedCustomerIds.length > 1) {
        setActionError('Select invoices for a single customer per write-off document.');
      }
      return;
    }
    try {
      const data = await postMutation.mutateAsync({
        customerId: selectedCustomerIds[0]!,
        writeoffDate,
        reasonCode,
        memo: memo.trim() || undefined,
        lines: selectedLines.map((l) => ({
          invoiceId: l.invoiceId,
          writeoffAmount: l.writeoffAmount,
        })),
      });
      setSelected({});
      setMemo('');
      setLastResult(`Posted ${data.documentNumber} — ${fmt(data.totalAmount)}`);
      await Promise.all([workqueueQ.refetch(), docsQ.refetch()]);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleReverse = async (doc: WriteoffDoc) => {
    setActionError(null);
    setLastResult(null);
    try {
      const data = await reverseMutation.mutateAsync({
        id: doc.id,
        reason: `UI reverse of ${doc.documentNumber}`,
      });
      setLastResult(
        `Reversed ${doc.documentNumber} → ${data.reversal.documentNumber}`,
      );
      await Promise.all([workqueueQ.refetch(), docsQ.refetch()]);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="space-y-6 p-6 max-w-6xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 flex items-center gap-2">
            <FileWarning className="h-6 w-6" />
            Bad Debt Write-off
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Recognize uncollectible receivables as Bad Debt Expense (5210) and clear AR (1200).
            Do <strong>not</strong> use a{' '}
            <Link to="/accounting/credit-debit-notes" className="text-blue-600 hover:underline">
              customer credit note
            </Link>{' '}
            for collections failures — CNs hit Sales Returns (4010), not bad debt.
          </p>
        </div>
        <Link
          to="/accounting/dunning"
          className="text-sm text-blue-600 hover:underline whitespace-nowrap"
        >
          Dunning
        </Link>
      </div>

      {!featureOn && !enabledQ.isLoading && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            Bad debt write-offs are disabled. Enable{' '}
            <code className="text-xs">bad_debt_writeoff_enabled</code> in system settings (after
            schema 551).
          </div>
        </div>
      )}

      <div className="rounded-lg border border-blue-100 bg-blue-50 p-3 text-sm text-blue-900 flex gap-2">
        <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
        <div>
          <strong>Credit note vs write-off:</strong> returns and price corrections stay on credit
          notes. This screen is only for amounts you will not collect.
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-4 rounded-lg border bg-white p-4">
        <div>
          <Label>Min overdue days</Label>
          <Input
            type="number"
            min={0}
            value={minAgeDays}
            onChange={(e) => setMinAgeDays(Number(e.target.value) || 0)}
            className="mt-1 w-32"
          />
        </div>
        <div>
          <Label>Write-off date</Label>
          <Input
            type="date"
            value={writeoffDate}
            onChange={(e) => setWriteoffDate(e.target.value)}
            className="mt-1"
            disabled={!featureOn}
          />
        </div>
        <div>
          <Label>Reason</Label>
          <Select
            value={reasonCode}
            onValueChange={(v) => setReasonCode(v as ReasonCode)}
            disabled={!featureOn}
          >
            <SelectTrigger className="mt-1 w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="UNCOLLECTIBLE">Uncollectible</SelectItem>
              <SelectItem value="DISPUTE_LOST">Dispute lost</SelectItem>
              <SelectItem value="BANKRUPTCY">Bankruptcy</SelectItem>
              <SelectItem value="OTHER">Other</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex-1 min-w-[12rem]">
          <Label>Memo (optional)</Label>
          <Input
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            className="mt-1"
            disabled={!featureOn}
          />
        </div>
        <Button type="button" onClick={() => void handlePost()} disabled={!canPost}>
          {postMutation.isPending ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Posting…
            </>
          ) : (
            `Post write-off (${fmt(totalSelected)})`
          )}
        </Button>
      </div>

      {selectedCustomerIds.length > 1 && (
        <p className="text-sm text-red-600">
          Selection spans multiple customers — post one customer at a time.
        </p>
      )}
      {actionError && <p className="text-sm text-red-600">{actionError}</p>}
      {lastResult && <p className="text-sm text-green-700">{lastResult}</p>}

      <div className="rounded-lg border bg-white overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <h2 className="font-medium text-gray-900">Open / overdue workqueue</h2>
          <span className="text-sm text-gray-500">
            {workqueue
              ? `${workqueue.summary.totalLines} invoices · ${fmt(workqueue.summary.totalDue)} due`
              : '—'}
          </span>
        </div>
        {workqueueQ.isLoading ? (
          <div className="flex justify-center py-10">
            <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
          </div>
        ) : lines.length === 0 ? (
          <p className="p-6 text-sm text-gray-500">No open invoices match the age filter.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-left text-gray-600">
                <tr>
                  <th className="px-3 py-2 w-10" />
                  <th className="px-3 py-2">Invoice</th>
                  <th className="px-3 py-2">Customer</th>
                  <th className="px-3 py-2">Due</th>
                  <th className="px-3 py-2 text-right">Age</th>
                  <th className="px-3 py-2 text-right">Open</th>
                  <th className="px-3 py-2 text-right">Write-off amt</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => {
                  const isOn = !!selected[line.invoiceId];
                  return (
                    <tr key={line.invoiceId} className="border-t">
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          checked={isOn}
                          disabled={!featureOn}
                          onChange={(e) => toggleLine(line, e.target.checked)}
                        />
                      </td>
                      <td className="px-3 py-2 font-medium">{line.invoiceNumber}</td>
                      <td className="px-3 py-2">{line.customerName}</td>
                      <td className="px-3 py-2 tabular-nums">{line.dueDate ?? '—'}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{line.ageDays}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmt(line.amountDue)}</td>
                      <td className="px-3 py-2 text-right">
                        <Input
                          type="number"
                          min={0}
                          max={line.amountDue}
                          step="1"
                          className="h-8 w-28 ml-auto text-right"
                          disabled={!featureOn || !isOn}
                          value={selected[line.invoiceId]?.amount ?? ''}
                          onChange={(e) =>
                            setAmount(line.invoiceId, e.target.value, line.customerId)
                          }
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="rounded-lg border bg-white overflow-hidden">
        <div className="px-4 py-3 border-b">
          <h2 className="font-medium text-gray-900">Recent posted write-offs</h2>
          <p className="text-xs text-gray-500 mt-0.5">Reverse restores AR residual and expense.</p>
        </div>
        {docsQ.isLoading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
          </div>
        ) : docs.length === 0 ? (
          <p className="p-6 text-sm text-gray-500">No posted write-offs yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-left text-gray-600">
                <tr>
                  <th className="px-3 py-2">Document</th>
                  <th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2">Reason</th>
                  <th className="px-3 py-2 text-right">Amount</th>
                  <th className="px-3 py-2 text-right">Lines</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {docs.map((doc) => (
                  <tr key={doc.id} className="border-t">
                    <td className="px-3 py-2 font-medium">{doc.documentNumber}</td>
                    <td className="px-3 py-2 tabular-nums">{doc.writeoffDate}</td>
                    <td className="px-3 py-2">{doc.reasonCode}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmt(doc.totalAmount)}</td>
                    <td className="px-3 py-2 text-right">{doc.lines?.length ?? 0}</td>
                    <td className="px-3 py-2 text-right">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={!featureOn || reverseMutation.isPending || !!doc.reversedByDocumentId}
                        onClick={() => void handleReverse(doc)}
                      >
                        Reverse
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
