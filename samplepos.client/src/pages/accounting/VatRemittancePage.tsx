/**
 * VAT Remittance worksheet — ADR-005 Phase 3C
 * Posts Treasury Document VAT_REMITTANCE (DR 2300 / CR liquidity).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Landmark, Loader2, ShieldAlert } from 'lucide-react';
import { DatePicker } from '../../components/ui/date-picker';
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
  useRemitVat,
  useVatRemittanceEnabled,
  useVatRemittanceWorksheet,
} from '../../hooks/useAccountingModules';
import { usePaymentAccounts } from '../../hooks/useExpenses';
import { getBusinessDate } from '../../utils/businessDate';
import { useTransactionGuard, type GuardHandle } from '../../hooks/useTransactionGuard';
import { useSubmitOnEnter } from '../../hooks/useSubmitOnEnter';

function monthStart(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

function fmt(n: number | undefined): string {
  if (n == null) return '—';
  return n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

export default function VatRemittancePage() {
  const today = getBusinessDate();
  const [periodFrom, setPeriodFrom] = useState(() => monthStart(today));
  const [periodTo, setPeriodTo] = useState(today);
  const [amount, setAmount] = useState('');
  const [transactionDate, setTransactionDate] = useState(today);
  const [authorityReference, setAuthorityReference] = useState('');
  const [paymentAccountCode, setPaymentAccountCode] = useState('');
  const [memo, setMemo] = useState('');

  const enabledQ = useVatRemittanceEnabled();
  const worksheetQ = useVatRemittanceWorksheet(periodFrom, periodTo, true);
  const { data: paymentAccounts = [] } = usePaymentAccounts();
  const remitMutation = useRemitVat();
  const { openGuard, closeGuard } = useTransactionGuard();
  const guardRef = useRef<GuardHandle | null>(null);

  const worksheet = worksheetQ.data;
  const featureOn = enabledQ.data?.enabled === true;

  const cashOptions = useMemo(() => {
    const fromApi = paymentAccounts.filter((a) => a.code && a.code !== '1015');
    if (fromApi.length > 0) return fromApi;
    return [
      { id: '1010', code: '1010', name: 'Cash' },
      { id: '1030', code: '1030', name: 'Checking Account' },
    ];
  }, [paymentAccounts]);

  useEffect(() => {
    if (!cashOptions.length) return;
    const preferred =
      worksheet?.defaultPaymentAccountCode
      ?? cashOptions.find((a) => a.code === '1010')?.code
      ?? cashOptions[0]!.code;
    setPaymentAccountCode((prev) => prev || preferred);
  }, [cashOptions, worksheet?.defaultPaymentAccountCode]);

  useEffect(() => {
    if (worksheet && worksheet.availableVatPayable > 0 && amount === '') {
      setAmount(String(worksheet.availableVatPayable));
    }
  }, [worksheet, amount]);

  const canSubmit =
    featureOn
    && Number(amount) > 0
    && !!authorityReference.trim()
    && !!paymentAccountCode
    && !!transactionDate
    && periodFrom <= periodTo
    && !remitMutation.isPending;

  const handleRemit = async () => {
    if (!canSubmit) return;
    guardRef.current = openGuard({ cancellable: true, label: 'Remit VAT payable' });
    try {
      await remitMutation.mutateAsync({
        periodFrom,
        periodTo,
        amount: Number(amount),
        transactionDate,
        paymentAccountCode,
        authorityReference: authorityReference.trim(),
        memo: memo.trim() || undefined,
      });
      setAuthorityReference('');
      setMemo('');
      setAmount('');
      await worksheetQ.refetch();
    } finally {
      if (guardRef.current) {
        closeGuard(guardRef.current.id);
        guardRef.current = null;
      }
    }
  };

  useSubmitOnEnter(true, canSubmit, () => void handleRemit());

  return (
    <div className="space-y-6 p-6 max-w-3xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 flex items-center gap-2">
            <Landmark className="h-6 w-6" />
            VAT Remittance
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Clear Tax Payable (2300) via Treasury Document — Decision B uses document VAT boxes
            (capped by GL). Separate from{' '}
            <Link to="/accounting/withholding-tax" className="text-blue-600 hover:underline">
              WHT remittance
            </Link>
            .
          </p>
        </div>
        <Link
          to="/reports/tax-compliance"
          className="text-sm text-blue-600 hover:underline whitespace-nowrap"
        >
          Tax compliance report
        </Link>
      </div>

      {!featureOn && !enabledQ.isLoading && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            VAT remittance is disabled. Enable{' '}
            <code className="text-xs">vat_remittance_document_enabled</code> and{' '}
            <code className="text-xs">treasury_document_enabled</code> in system settings.
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 rounded-lg border bg-white p-4">
        <div>
          <Label>Period from</Label>
          <DatePicker value={periodFrom} onChange={setPeriodFrom} className="mt-1 w-full" />
        </div>
        <div>
          <Label>Period to</Label>
          <DatePicker value={periodTo} onChange={setPeriodTo} className="mt-1 w-full" />
        </div>
      </div>

      {worksheetQ.isLoading ? (
        <div className="flex justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
        </div>
      ) : worksheet ? (
        <div className="rounded-lg border bg-white p-4 space-y-3">
          <h2 className="font-medium text-gray-900">Boxes preview</h2>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="text-gray-500">Net output VAT</div>
            <div className="text-right tabular-nums">{fmt(worksheet.netOutputTax)}</div>
            <div className="text-gray-500">Net input VAT</div>
            <div className="text-right tabular-nums">{fmt(worksheet.netInputTax)}</div>
            <div className="text-gray-500">Document net payable</div>
            <div className="text-right tabular-nums font-medium">{fmt(worksheet.documentNetVatPayable)}</div>
            <div className="text-gray-500">Already remitted (period)</div>
            <div className="text-right tabular-nums">{fmt(worksheet.alreadyRemitted)}</div>
            <div className="text-gray-500">GL Tax Payable 2300</div>
            <div className="text-right tabular-nums">{fmt(worksheet.glTaxPayable2300)}</div>
            <div className="text-gray-900 font-medium">Available to remit</div>
            <div className="text-right tabular-nums font-semibold text-green-700">
              {fmt(worksheet.availableVatPayable)}
            </div>
          </div>
          <p className="text-xs text-gray-500">{worksheet.note}</p>
        </div>
      ) : null}

      <div className="rounded-lg border bg-white p-4 space-y-4">
        <h2 className="font-medium text-gray-900">Post remittance</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <Label>Amount</Label>
            <Input
              type="number"
              step="1"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="mt-1"
              disabled={!featureOn}
            />
          </div>
          <div>
            <Label>Payment date</Label>
            <DatePicker
              value={transactionDate}
              onChange={setTransactionDate}
              className="mt-1 w-full"
              disabled={!featureOn}
            />
          </div>
          <div>
            <Label>Payment account</Label>
            <Select
              value={paymentAccountCode}
              onValueChange={setPaymentAccountCode}
              disabled={!featureOn}
            >
              <SelectTrigger className="mt-1">
                <SelectValue placeholder="Select cash/bank" />
              </SelectTrigger>
              <SelectContent>
                {cashOptions.map((a) => (
                  <SelectItem key={a.code} value={a.code}>
                    {a.code} — {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Authority reference</Label>
            <Input
              value={authorityReference}
              onChange={(e) => setAuthorityReference(e.target.value)}
              placeholder="URA / receipt #"
              className="mt-1"
              disabled={!featureOn}
            />
          </div>
        </div>
        <div>
          <Label>Memo (optional)</Label>
          <Input
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            className="mt-1"
            disabled={!featureOn}
          />
        </div>
        <Button type="button" onClick={() => void handleRemit()} disabled={!canSubmit}>
          {remitMutation.isPending ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Posting…
            </>
          ) : (
            'Post VAT remittance'
          )}
        </Button>
      </div>
    </div>
  );
}