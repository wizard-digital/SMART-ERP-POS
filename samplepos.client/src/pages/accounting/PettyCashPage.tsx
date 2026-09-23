/**
 * Petty Cash workspace — Phase 1D (1012 dedicated float)
 */

import { useCallback, useEffect, useState } from 'react';
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
import { Loader2, RefreshCw, Wallet } from 'lucide-react';
import toast from 'react-hot-toast';
import { formatCurrency } from '../../utils/currency';
import { handleApiError } from '../../utils/errorHandler';
import { TreasuryFeatureDisabledNotice } from '../../components/treasury/TreasuryFeatureDisabledNotice';

type Operation = 'FUND' | 'REPLENISH' | 'EXPENSE';

export default function PettyCashPage({ embedded = false }: { embedded?: boolean }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [balances, setBalances] = useState<{
    cashDrawer: number;
    pettyCash: number;
    undepositedFunds: number;
  } | null>(null);
  const [operation, setOperation] = useState<Operation>('FUND');
  const [amount, setAmount] = useState('');
  const [contraAccountCode, setContraAccountCode] = useState('1010');
  const [memo, setMemo] = useState('');
  const [transactionDate, setTransactionDate] = useState(
    () => new Date().toISOString().slice(0, 10),
  );
  const [loading, setLoading] = useState(true);
  const [posting, setPosting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const enabledRes = await api.treasury.getEnabled();
      const isOn = Boolean(enabledRes.data?.data?.enabled);
      setEnabled(isOn);
      if (!isOn) {
        setBalances(null);
        return;
      }
      const balRes = await api.treasury.getPettyCashBalances();
      setBalances(balRes.data?.data ?? null);
    } catch (err) {
      // HandledApiError already toasted by the API interceptor — do not pin a permanent banner
      handleApiError(err, { fallback: 'Failed to load petty cash' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (operation === 'EXPENSE') {
      setContraAccountCode('6900');
    } else if (contraAccountCode === '6900' || contraAccountCode === '1015') {
      setContraAccountCode('1010');
    }
  }, [operation, contraAccountCode]);

  const submit = async () => {
    setPosting(true);
    try {
      const value = Number(amount);
      if (!(value > 0)) {
        toast.error('Enter a positive amount', { duration: 4000 });
        return;
      }
      const res = await api.treasury.createPettyCash({
        transactionDate,
        operation,
        amount: value,
        contraAccountCode: contraAccountCode || undefined,
        memo: memo || undefined,
        postImmediately: true,
      });
      const doc = res.data?.data;
      toast.success(
        `Posted ${doc?.documentNumber ?? 'petty cash'} — ${formatCurrency(value)}`,
        { duration: 4000 },
      );
      setAmount('');
      setMemo('');
      await load();
    } catch (err) {
      // Insufficient-funds / other API errors: global toast already shown (~7s) and auto-dismisses
      handleApiError(err, { fallback: 'Failed to post petty cash' });
    } finally {
      setPosting(false);
    }
  };

  return (
    <div className={embedded ? 'space-y-6' : 'space-y-6 p-6'}>
      {!embedded && (
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
              <Wallet className="h-6 w-6" />
              Petty cash
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Fund and replenish the petty cash float, or spend from the float. For approved
              company expense vouchers paid from the bank, use Accounting → Expenses instead.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            <span className="ml-2">Refresh</span>
          </Button>
        </div>
      )}

      {embedded && (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <p className="text-sm text-muted-foreground max-w-2xl">
            Fund or replenish the float from cash drawer or bank, or spend from the float. For
            bank-paid expense vouchers (approve → mark paid), use Accounting → Expenses. Register
            sessions can also choose “Spend from petty float” while a till is open.
          </p>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            <span className="ml-2">Refresh</span>
          </Button>
        </div>
      )}

      {enabled === false && <TreasuryFeatureDisabledNotice featureLabel="Petty cash" />}

      {balances && (
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-lg border p-3">
            <div className="text-xs text-muted-foreground">1010 Cash Drawer</div>
            <div className="text-lg font-semibold">{formatCurrency(balances.cashDrawer)}</div>
          </div>
          <div className="rounded-lg border p-3">
            <div className="text-xs text-muted-foreground">1012 Petty Cash</div>
            <div className="text-lg font-semibold">{formatCurrency(balances.pettyCash)}</div>
          </div>
          <div className="rounded-lg border p-3">
            <div className="text-xs text-muted-foreground">1015 Undeposited (receipts)</div>
            <div className="text-lg font-semibold">{formatCurrency(balances.undepositedFunds)}</div>
          </div>
        </div>
      )}

      <div className="max-w-lg space-y-4 rounded-lg border p-4">
        <div className="space-y-2">
          <Label>Operation</Label>
          <Select value={operation} onValueChange={(v) => setOperation(v as Operation)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="FUND">Fund float from cash or bank</SelectItem>
              <SelectItem value="REPLENISH">Replenish float from cash or bank</SelectItem>
              <SelectItem value="EXPENSE">Spend from float (not an Expense voucher)</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>{operation === 'EXPENSE' ? 'Expense account' : 'Fund from'}</Label>
          <Select value={contraAccountCode} onValueChange={setContraAccountCode}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {operation === 'EXPENSE' ? (
                <SelectItem value="6900">6900 General Expense</SelectItem>
              ) : (
                <>
                  <SelectItem value="1010">1010 Cash Drawer</SelectItem>
                  <SelectItem value="1030">1030 Bank</SelectItem>
                </>
              )}
            </SelectContent>
          </Select>
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
        </div>
        <div className="space-y-2">
          <Label>Memo</Label>
          <Input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="Optional" />
        </div>
        <Button
          className="w-full"
          disabled={posting || enabled === false}
          onClick={() => void submit()}
        >
          {posting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          <span className={posting ? 'ml-2' : ''}>Post</span>
        </Button>
      </div>
    </div>
  );
}