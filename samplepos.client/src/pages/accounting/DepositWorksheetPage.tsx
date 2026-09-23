/**
 * Deposit Worksheet UI — Undeposited Funds → Cash / Mobile Money / Bank
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../utils/api';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select';
import { Loader2, RefreshCw, Landmark, CheckSquare } from 'lucide-react';
import { formatCurrency } from '../../utils/currency';
import { TreasuryFeatureDisabledNotice } from '../../components/treasury/TreasuryFeatureDisabledNotice';

type DestinationKind = 'CASH' | 'MOBILE_MONEY' | 'BANK';

interface UnsettledReceipt {
  id: string;
  sourceType: string;
  sourceId: string;
  sourceNumber: string | null;
  originatingAmount: number;
  settledAmount: number;
  residualAmount: number;
  settlementStatus: string;
  customerName?: string | null;
  paymentDate: string | null;
  paymentMethod: string | null;
}

interface DepositRecon {
  clearingAccountCode: string;
  glBalance: number;
  unsettledResidual: number;
  difference: number;
}

interface DepositDestination {
  kind: DestinationKind;
  bankAccountId: string;
  name: string;
  glAccountCode: string;
  glAccountName: string | null;
  systemAccountTag: string | null;
  isDefault?: boolean;
}

interface DepositDestinations {
  cash: DepositDestination;
  mobileMoney: DepositDestination;
  banks: DepositDestination[];
}

function destinationLabel(kind: DestinationKind): string {
  if (kind === 'CASH') return 'Cash';
  if (kind === 'MOBILE_MONEY') return 'Mobile money';
  return 'Bank';
}

export default function DepositWorksheetPage({ embedded = false }: { embedded?: boolean }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [receipts, setReceipts] = useState<UnsettledReceipt[]>([]);
  const [selected, setSelected] = useState<Record<string, number>>({});
  const [destinations, setDestinations] = useState<DepositDestinations | null>(null);
  const [destinationKind, setDestinationKind] = useState<DestinationKind>('CASH');
  const [bankAccountId, setBankAccountId] = useState('');
  const [depositReference, setDepositReference] = useState('');
  const [transactionDate, setTransactionDate] = useState(
    () => new Date().toISOString().slice(0, 10),
  );
  const [shortageAmount, setShortageAmount] = useState('0');
  const [overageAmount, setOverageAmount] = useState('0');
  const [recon, setRecon] = useState<DepositRecon | null>(null);
  const [loading, setLoading] = useState(true);
  const [posting, setPosting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const bankOptions = destinations?.banks ?? [];

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const enabledRes = await api.treasury.getEnabled();
      const isOn = Boolean(enabledRes.data?.data?.enabled);
      setEnabled(isOn);
      if (!isOn) {
        setReceipts([]);
        setRecon(null);
        setDestinations(null);
        return;
      }
      const [receiptsRes, reconRes, destRes] = await Promise.all([
        api.treasury.listUnsettledReceipts({ limit: 200 }),
        api.treasury.getDepositReconciliation(),
        api.treasury.listDepositDestinations(),
      ]);
      setReceipts((receiptsRes.data?.data?.items ?? []) as unknown as UnsettledReceipt[]);
      setRecon((reconRes.data?.data ?? null) as DepositRecon | null);
      const dest = destRes.data?.data as DepositDestinations | undefined;
      setDestinations(dest ?? null);
      if (dest?.banks?.length) {
        setBankAccountId((prev) => {
          if (prev && dest.banks.some((b) => b.bankAccountId === prev)) return prev;
          const def =
            dest.banks.find((b) => b.isDefault) ??
            dest.banks.find((b) => b.glAccountCode === '1030') ??
            dest.banks[0];
          return def?.bankAccountId ?? '';
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load deposit worksheet data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (destinationKind !== 'BANK') return;
    if (!bankAccountId && bankOptions.length > 0) {
      const def =
        bankOptions.find((b) => b.isDefault) ??
        bankOptions.find((b) => b.glAccountCode === '1030') ??
        bankOptions[0];
      if (def?.bankAccountId) setBankAccountId(def.bankAccountId);
    }
  }, [destinationKind, bankAccountId, bankOptions]);

  const selectedTotal = useMemo(
    () =>
      Object.values(selected).reduce((sum, amount) => sum + (Number(amount) || 0), 0),
    [selected],
  );

  const depositAmount = useMemo(() => {
    const shortage = Number(shortageAmount) || 0;
    const overage = Number(overageAmount) || 0;
    return selectedTotal - shortage + overage;
  }, [selectedTotal, shortageAmount, overageAmount]);

  const canPost =
    selectedTotal > 0 &&
    enabled !== false &&
    (destinationKind !== 'BANK' || (bankAccountId && bankOptions.length > 0));

  const toggleReceipt = (receipt: UnsettledReceipt) => {
    setSelected((prev) => {
      const next = { ...prev };
      const key = `${receipt.sourceType}:${receipt.sourceId}`;
      if (next[key] != null) {
        delete next[key];
      } else {
        next[key] = receipt.residualAmount;
      }
      return next;
    });
  };

  const setPartialAmount = (receipt: UnsettledReceipt, value: string) => {
    const key = `${receipt.sourceType}:${receipt.sourceId}`;
    const amount = Number(value);
    setSelected((prev) => {
      if (!(key in prev)) return prev;
      return {
        ...prev,
        [key]: Number.isFinite(amount) ? Math.min(Math.max(amount, 0), receipt.residualAmount) : 0,
      };
    });
  };

  const createAndPost = async () => {
    setPosting(true);
    setMessage(null);
    setError(null);
    try {
      if (destinationKind === 'BANK' && !bankAccountId) {
        throw new Error('Select a bank account');
      }
      const receiptsPayload = Object.entries(selected)
        .filter(([, amount]) => amount > 0)
        .map(([key, amount]) => {
          const [sourceType, sourceId] = key.split(':');
          return {
            sourceType: sourceType as
              | 'AR_CUSTOMER_PAYMENT'
              | 'INVOICE_PAYMENT'
              | 'CUSTOMER_DEPOSIT',
            sourceId,
            amount,
          };
        });
      if (receiptsPayload.length === 0) throw new Error('Select at least one receipt');

      const createRes = await api.treasury.createDepositWorksheet({
        transactionDate,
        destinationKind,
        bankAccountId: destinationKind === 'BANK' ? bankAccountId : undefined,
        depositReference: depositReference || undefined,
        shortageAmount: Number(shortageAmount) || 0,
        overageAmount: Number(overageAmount) || 0,
        receipts: receiptsPayload,
      });
      const doc = createRes.data?.data;
      if (!doc?.id) throw new Error('Deposit worksheet was not created');

      const postRes = await api.treasury.post(doc.id);
      const posted = postRes.data?.data;
      setMessage(
        `Posted ${posted?.documentNumber ?? doc.documentNumber} — ${destinationLabel(destinationKind).toLowerCase()} ${formatCurrency(depositAmount)}`,
      );
      setSelected({});
      setDepositReference('');
      setShortageAmount('0');
      setOverageAmount('0');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to post deposit worksheet');
    } finally {
      setPosting(false);
    }
  };

  const destinationHint =
    destinationKind === 'CASH'
      ? destinations
        ? `${destinations.cash.name} (${destinations.cash.glAccountCode})`
        : 'Cash Drawer (1010)'
      : destinationKind === 'MOBILE_MONEY'
        ? destinations
          ? `${destinations.mobileMoney.name} (${destinations.mobileMoney.glAccountCode})`
          : 'Mobile Money (1040)'
        : null;

  return (
    <div className={embedded ? 'space-y-6' : 'space-y-6 p-6'}>
      {!embedded && (
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
              <Landmark className="h-6 w-6" />
              Undeposited receipts
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Clear sales and payment receipts sitting in Undeposited Funds into cash, mobile money,
              or a bank account. Supports partial deposits and shortage/overage.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            <span className="ml-2">Refresh</span>
          </Button>
        </div>
      )}

      {embedded && (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <p className="text-sm text-muted-foreground max-w-2xl">
            Select unsettled receipts and clear them into cash, mobile money, or a bank account.
            This is not a till cash-bag deposit — use the cash register for drawer cash to bank.
          </p>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            <span className="ml-2">Refresh</span>
          </Button>
        </div>
      )}

      {enabled === false && (
        <TreasuryFeatureDisabledNotice featureLabel="Undeposited receipt clearing" />
      )}

      {recon && enabled && (
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-lg border p-3">
            <div className="text-xs text-muted-foreground">Undeposited Funds (GL)</div>
            <div className="text-lg font-semibold">{formatCurrency(recon.glBalance)}</div>
          </div>
          <div className="rounded-lg border p-3">
            <div className="text-xs text-muted-foreground">Unsettled receipts</div>
            <div className="text-lg font-semibold">{formatCurrency(recon.unsettledResidual)}</div>
          </div>
          <div className="rounded-lg border p-3">
            <div className="text-xs text-muted-foreground">Difference</div>
            <div className="text-lg font-semibold">{formatCurrency(recon.difference)}</div>
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      )}
      {message && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          {message}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <div className="rounded-lg border">
          <div className="border-b px-4 py-3 text-sm font-medium">Unsettled receipts</div>
          {loading ? (
            <div className="flex justify-center p-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : receipts.length === 0 ? (
            <div className="p-6 text-sm text-muted-foreground">No unsettled receipts in 1015.</div>
          ) : (
            <ul className="divide-y max-h-[28rem] overflow-auto">
              {receipts.map((receipt) => {
                const key = `${receipt.sourceType}:${receipt.sourceId}`;
                const isSelected = selected[key] != null;
                return (
                  <li key={receipt.id} className="px-4 py-3">
                    <div className="flex items-start gap-3">
                      <button
                        type="button"
                        className={`mt-0.5 rounded border p-0.5 ${
                          isSelected ? 'border-primary bg-primary text-primary-foreground' : ''
                        }`}
                        onClick={() => toggleReceipt(receipt)}
                        aria-label="Select receipt"
                      >
                        <CheckSquare className="h-4 w-4" />
                      </button>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">
                            {receipt.sourceNumber ?? receipt.sourceId.slice(0, 8)}
                          </span>
                          <Badge variant="outline">{receipt.settlementStatus}</Badge>
                          <span className="text-xs text-muted-foreground">
                            {receipt.paymentDate} · {receipt.paymentMethod}
                          </span>
                        </div>
                        <div className="text-xs text-muted-foreground truncate">
                          {receipt.customerName ?? '—'} · residual{' '}
                          {formatCurrency(receipt.residualAmount)}
                        </div>
                        {isSelected && (
                          <div className="mt-2 flex items-center gap-2">
                            <Label className="text-xs">Apply</Label>
                            <Input
                              className="h-8 w-36"
                              type="number"
                              max={receipt.residualAmount}
                              step="1"
                              value={selected[key]}
                              onChange={(e) => setPartialAmount(receipt, e.target.value)}
                            />
                          </div>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="space-y-4 rounded-lg border p-4">
          <div className="text-sm font-medium">Deposit details</div>
          <div className="space-y-2">
            <Label>Deposit into</Label>
            <div className="grid grid-cols-3 gap-2">
              {(
                [
                  { kind: 'CASH' as const, label: 'Cash' },
                  { kind: 'MOBILE_MONEY' as const, label: 'Mobile money' },
                  { kind: 'BANK' as const, label: 'Bank' },
                ] as const
              ).map((opt) => (
                <Button
                  key={opt.kind}
                  type="button"
                  size="sm"
                  variant={destinationKind === opt.kind ? 'default' : 'outline'}
                  onClick={() => setDestinationKind(opt.kind)}
                  disabled={enabled === false}
                >
                  {opt.label}
                </Button>
              ))}
            </div>
            {destinationHint && (
              <p className="text-xs text-muted-foreground">Posts to {destinationHint}</p>
            )}
          </div>

          {destinationKind === 'BANK' && (
            <div className="space-y-2">
              <Label>Bank account</Label>
              <Select value={bankAccountId} onValueChange={setBankAccountId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select bank" />
                </SelectTrigger>
                <SelectContent>
                  {bankOptions.map((account) => (
                    <SelectItem key={account.bankAccountId} value={account.bankAccountId}>
                      {account.name}
                      {account.glAccountCode
                        ? ` (${account.glAccountCode}${account.glAccountName ? ` · ${account.glAccountName}` : ''})`
                        : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {bankOptions.length === 0 && (
                <p className="text-xs text-destructive">
                  No bank accounts yet. Create one under Banking → Accounts linked to a bank GL
                  (e.g. 1030), or deposit into Cash / Mobile money instead.
                </p>
              )}
            </div>
          )}

          <div className="space-y-2">
            <Label>Deposit date</Label>
            <Input
              type="date"
              value={transactionDate}
              onChange={(e) => setTransactionDate(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>Deposit reference</Label>
            <Input
              value={depositReference}
              onChange={(e) => setDepositReference(e.target.value)}
              placeholder={
                destinationKind === 'MOBILE_MONEY'
                  ? 'MoMo reference'
                  : destinationKind === 'CASH'
                    ? 'Optional note'
                    : 'Slip / bank reference'
              }
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Shortage</Label>
              <Input
                type="number"
                step="1"
                value={shortageAmount}
                onChange={(e) => setShortageAmount(e.target.value)}
              />
              <p className="text-[11px] text-muted-foreground">
                Short count only — leave 0 when the full amount lands
              </p>
            </div>
            <div className="space-y-2">
              <Label>Overage</Label>
              <Input
                type="number"
                step="1"
                value={overageAmount}
                onChange={(e) => setOverageAmount(e.target.value)}
              />
              <p className="text-[11px] text-muted-foreground">
                Over count only — leave 0 when the full amount lands
              </p>
            </div>
          </div>
          {(Number(overageAmount) > 0 || Number(shortageAmount) > 0) && (
            <p className="text-xs text-amber-700">
              Shortage/overage should usually be 0 for exact bank or MoMo transfers. Deposit amount
              must match what arrived ({formatCurrency(selectedTotal)} selected).
            </p>
          )}
          <div className="rounded-md bg-muted/50 p-3 text-sm space-y-1">
            <div className="flex justify-between">
              <span>Receipts selected</span>
              <span>{formatCurrency(selectedTotal)}</span>
            </div>
            <div className="flex justify-between font-medium">
              <span>{destinationLabel(destinationKind)} deposit</span>
              <span>{formatCurrency(depositAmount)}</span>
            </div>
          </div>
          <Button
            className="w-full"
            disabled={posting || !canPost}
            onClick={() => void createAndPost()}
          >
            {posting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            <span className={posting ? 'ml-2' : ''}>Create &amp; post deposit</span>
          </Button>
        </div>
      </div>
    </div>
  );
}