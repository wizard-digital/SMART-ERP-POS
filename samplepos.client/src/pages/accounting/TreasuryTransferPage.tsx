/**
 * Treasury Transfer UI — Phase 1C (liquidity ↔ liquidity)
 * Quiet by default: policy essays live behind hover/focus help, not always-on copy.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api } from '../../utils/api';
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
import { Loader2, RefreshCw, ArrowLeftRight, Info } from 'lucide-react';
import { formatCurrency } from '../../utils/currency';
import { TreasuryFeatureDisabledNotice } from '../../components/treasury/TreasuryFeatureDisabledNotice';
import { cn } from '../../lib/utils';

/** Hover / focus-within tip — no always-visible essay noise. */
function QuietHoverHelp({
  title,
  children,
  className,
  align = 'left',
}: {
  title: string;
  children: ReactNode;
  className?: string;
  align?: 'left' | 'right';
}) {
  return (
    <div className={cn('group relative inline-flex items-center', className)}>
      <button
        type="button"
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-slate-50 text-slate-500 transition-colors hover:border-slate-300 hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
        aria-label={`${title} — details`}
      >
        <Info className="h-3.5 w-3.5" aria-hidden />
      </button>
      <div
        role="tooltip"
        className={cn(
          'pointer-events-none absolute top-full z-30 mt-1.5 w-[min(22rem,calc(100vw-2rem))] rounded-md border border-slate-200 bg-white p-3 text-xs leading-relaxed text-slate-600 opacity-0 shadow-md transition-opacity',
          'invisible group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100',
          align === 'right' ? 'right-0' : 'left-0',
        )}
      >
        <div className="mb-1.5 font-medium text-slate-900">{title}</div>
        <div className="space-y-2">{children}</div>
      </div>
    </div>
  );
}

interface LiquidityAccount {
  accountCode: string;
  accountName: string;
  systemAccountTag: string | null;
  currentBalance: number;
  available?: number;
}

export default function TreasuryTransferPage({ embedded = false }: { embedded?: boolean }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [accounts, setAccounts] = useState<LiquidityAccount[]>([]);
  const [fromAccountCode, setFromAccountCode] = useState('');
  const [toAccountCode, setToAccountCode] = useState('');
  const [amount, setAmount] = useState('');
  const [memo, setMemo] = useState('');
  const [transactionDate, setTransactionDate] = useState(
    () => new Date().toISOString().slice(0, 10),
  );
  const [loading, setLoading] = useState(true);
  const [posting, setPosting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const enabledRes = await api.treasury.getEnabled();
      const isOn = Boolean(enabledRes.data?.data?.enabled);
      setEnabled(isOn);
      if (!isOn) {
        setAccounts([]);
        return;
      }
      const listRes = await api.treasury.listLiquidityAccounts();
      const items = (listRes.data?.data?.items ?? []).map((a) => ({
        accountCode: a.accountCode,
        accountName: a.accountName,
        systemAccountTag: a.systemAccountTag ?? null,
        currentBalance: Number(a.currentBalance ?? a.available ?? 0),
        available: a.available,
      }));
      setAccounts(items);
      const movable = items.filter((a) => a.systemAccountTag !== 'UNDEPOSITED_FUNDS');
      const pickFrom =
        movable.find((a) => a.accountCode === '1010' && a.currentBalance > 0) ||
        movable.find((a) => a.currentBalance > 0) ||
        movable[0];
      const pickTo =
        movable.find((a) => a.accountCode === '1030') ||
        movable.find((a) => a.accountCode !== pickFrom?.accountCode && a.currentBalance >= 0) ||
        movable.find((a) => a.accountCode !== pickFrom?.accountCode);
      if (!fromAccountCode && pickFrom) setFromAccountCode(pickFrom.accountCode);
      if (!toAccountCode && pickTo) setToAccountCode(pickTo.accountCode);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load liquidity accounts');
    } finally {
      setLoading(false);
    }
  }, [fromAccountCode, toAccountCode]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const swap = () => {
    setFromAccountCode(toAccountCode);
    setToAccountCode(fromAccountCode);
  };

  const fromAcct = accounts.find((a) => a.accountCode === fromAccountCode);
  const toAcct = accounts.find((a) => a.accountCode === toAccountCode);
  const fromBal = fromAcct?.currentBalance;
  const amountNum = Number(amount);
  const fromIsNegativeOrEmpty = fromBal != null && fromBal <= 0.0001;
  const insufficient =
    Boolean(fromAccountCode) &&
    Number.isFinite(amountNum) &&
    amountNum > 0 &&
    fromBal != null &&
    amountNum > fromBal + 0.0001;

  /** Move Money is for funded liquidity only — undeposited clearing uses Deposit Worksheet. */
  const transferAccounts = accounts.filter((a) => a.systemAccountTag !== 'UNDEPOSITED_FUNDS');
  const blockedFromUndeposited = fromAccountCode === '1015' || fromAcct?.systemAccountTag === 'UNDEPOSITED_FUNDS';
  const blockedToUndeposited = toAccountCode === '1015' || toAcct?.systemAccountTag === 'UNDEPOSITED_FUNDS';

  const blockReason = (() => {
    if (blockedFromUndeposited || blockedToUndeposited) {
      return 'Undeposited Funds (1015) cannot be used in Move Money. Use Banking → Undeposited receipts to clear receipts into a bank.';
    }
    if (fromIsNegativeOrEmpty && fromAcct) {
      return (
        `${fromAcct.accountCode} ${fromAcct.accountName}` +
        (fromAcct.systemAccountTag ? ` [${fromAcct.systemAccountTag}]` : '') +
        ` has balance ${formatCurrency(fromBal ?? 0)}. ` +
        `You cannot move money out of an empty or overdrawn account. Fund it first (or reverse a wrong earlier move).`
      );
    }
    if (insufficient && fromAcct) {
      return (
        `Insufficient funds in ${fromAcct.accountCode} ${fromAcct.accountName}` +
        (fromAcct.systemAccountTag ? ` [${fromAcct.systemAccountTag}]` : '') +
        `. Available ${formatCurrency(fromBal ?? 0)}, required ${formatCurrency(amountNum)}.`
      );
    }
    return null;
  })();

  const submit = async () => {
    setPosting(true);
    setMessage(null);
    setError(null);
    try {
      const value = Number(amount);
      if (!fromAccountCode || !toAccountCode) throw new Error('Select from and to accounts');
      if (!(value > 0)) throw new Error('Enter a positive amount');
      if (blockReason) throw new Error(blockReason);
      const res = await api.treasury.createTransfer({
        transactionDate,
        fromAccountCode,
        toAccountCode,
        amount: value,
        memo: memo || undefined,
        postImmediately: true,
      });
      const doc = res.data?.data;
      setMessage(
        `Posted ${doc?.documentNumber ?? 'transfer'} — ${formatCurrency(value)} (${fromAccountCode} → ${toAccountCode})`,
      );
      setAmount('');
      setMemo('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to post transfer');
    } finally {
      setPosting(false);
    }
  };

  return (
    <div className={embedded ? 'space-y-6' : 'space-y-6 p-6'}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {!embedded && (
            <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
              <ArrowLeftRight className="h-6 w-6" />
              Move money
            </h1>
          )}
          <QuietHoverHelp title="Move money">
            <p>
              Move between cash, bank, mobile money, card clearing, and petty cash. For
              bank-book-to-bank-book only, use Transactions → Transfer (same posting when Treasury
              is on).
            </p>
            <p>
              Wrong move? Reverse from Banking → Transactions or Liquidity Documents → Reverse document
              (blocked if bank-reconciled).
            </p>
          </QuietHoverHelp>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          <span className="ml-2">Refresh</span>
        </Button>
      </div>

      {enabled === false && <TreasuryFeatureDisabledNotice featureLabel="Move money" />}

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

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4 rounded-lg border p-4">
          <div className="space-y-2">
            <Label>From account</Label>
            <Select value={fromAccountCode} onValueChange={setFromAccountCode}>
              <SelectTrigger>
                <SelectValue placeholder="From" />
              </SelectTrigger>
              <SelectContent>
                {transferAccounts.map((a) => (
                  <SelectItem key={a.accountCode} value={a.accountCode}>
                    {a.accountCode} — {a.accountName}
                    {a.systemAccountTag ? ` [${a.systemAccountTag}]` : ''} (
                    {formatCurrency(a.currentBalance)})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {fromAcct && (
              <p
                className={`text-xs ${fromIsNegativeOrEmpty ? 'text-red-700 font-medium' : 'text-muted-foreground'}`}
              >
                Selected: {fromAcct.accountCode} {fromAcct.accountName}
                {fromAcct.systemAccountTag ? ` [${fromAcct.systemAccountTag}]` : ''} — balance{' '}
                {formatCurrency(fromAcct.currentBalance)}
                {fromIsNegativeOrEmpty ? ' — cannot pay out from this account' : ''}
              </p>
            )}
          </div>
          <div className="flex justify-center">
            <Button type="button" variant="ghost" size="sm" onClick={swap}>
              <ArrowLeftRight className="h-4 w-4" />
              <span className="ml-2">Swap</span>
            </Button>
          </div>
          <div className="space-y-2">
            <Label>To account</Label>
            <Select value={toAccountCode} onValueChange={setToAccountCode}>
              <SelectTrigger>
                <SelectValue placeholder="To" />
              </SelectTrigger>
              <SelectContent>
                {transferAccounts.map((a) => (
                  <SelectItem key={a.accountCode} value={a.accountCode}>
                    {a.accountCode} — {a.accountName}
                    {a.systemAccountTag ? ` [${a.systemAccountTag}]` : ''} (
                    {formatCurrency(a.currentBalance)})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {toAcct && (
              <p className="text-xs text-muted-foreground">
                Selected: {toAcct.accountCode} {toAcct.accountName}
                {toAcct.systemAccountTag ? ` [${toAcct.systemAccountTag}]` : ''} — balance{' '}
                {formatCurrency(toAcct.currentBalance)}
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label>Date</Label>
            <Input
              type="date"
              value={transactionDate}
              onChange={(e) => setTransactionDate(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>Amount</Label>
            <Input
              type="number"
              step="1"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            {blockReason && (
              <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-950">
                {blockReason}
              </div>
            )}
          </div>
          <div className="space-y-2">
            <Label>Memo</Label>
            <Input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="Optional" />
          </div>
          <Button
            className="w-full"
            disabled={posting || enabled === false || !!blockReason || !(Number(amount) > 0)}
            onClick={() => void submit()}
          >
            {posting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            <span className={posting ? 'ml-2' : ''}>Post transfer</span>
          </Button>
        </div>

        <div className="rounded-lg border p-4 text-sm space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="font-medium text-foreground">Liquidity accounts</div>
            <QuietHoverHelp title="Which accounts?" align="right">
              <p>
                Only cash, bank, mobile money, card clearing, petty cash, and undeposited accounts
                appear here. Expense and customer/supplier balances are blocked.
              </p>
              <p>
                Undeposited Funds (1015) is listed for balance visibility but cannot be used in Move
                money — clear it via Undeposited receipts.
              </p>
            </QuietHoverHelp>
          </div>
          <ul className="divide-y rounded border text-muted-foreground">
            {accounts.map((a) => {
              const negative = a.currentBalance < -0.0001;
              const undeposited = a.systemAccountTag === 'UNDEPOSITED_FUNDS';
              return (
                <li
                  key={a.accountCode}
                  className={`flex justify-between gap-2 px-3 py-2 ${negative ? 'bg-red-50' : ''}`}
                  title={
                    negative
                      ? 'Overdrawn — cannot pay out'
                      : undeposited
                        ? 'Clear via Undeposited receipts — not Move money'
                        : undefined
                  }
                >
                  <span>
                    {a.accountCode} {a.accountName}
                    {a.systemAccountTag ? (
                      <span className="ml-2 text-xs">[{a.systemAccountTag}]</span>
                    ) : null}
                  </span>
                  <span className={negative ? 'font-medium text-red-700' : ''}>
                    {formatCurrency(a.currentBalance)}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
}
