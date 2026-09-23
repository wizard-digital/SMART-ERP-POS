/**
 * Distribution Module — Clearing Page
 *
 * SAP-style manual clearing: select customer → pick invoices → allocate deposits/cash.
 * Never auto-clears.  User chooses deposit, cash, or mixed.
 */
import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import Layout from '../../components/Layout';
import distributionApi, { type DistInvoice, type DepositInfo } from '../../api/distribution';
import apiClient from '../../utils/api';
import { formatCurrency } from '../../utils/currency';

type PaymentMethod = 'CASH' | 'CARD' | 'MOBILE_MONEY' | 'BANK_TRANSFER';

export default function DistClearingPage() {
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();

  // Customer selection
  const [customerId, setCustomerId] = useState(searchParams.get('customerId') ?? '');
  const [customerSearch, setCustomerSearch] = useState('');

  const { data: customers } = useQuery({
    queryKey: ['customers-search-clr', customerSearch],
    queryFn: async () => {
      if (customerSearch.length < 2) return [];
      const res = await apiClient.get('/customers', { params: { search: customerSearch, limit: 10 } });
      return res.data.data ?? [];
    },
    enabled: customerSearch.length >= 2 && !customerId,
  });

  // Clearing screen data
  const { data: clearingData, isLoading } = useQuery({
    queryKey: ['dist-clearing-screen', customerId],
    queryFn: () => distributionApi.getClearingScreen(customerId),
    enabled: !!customerId,
  });

  const invoices = clearingData?.invoices ?? [];
  const deposits = clearingData?.deposits ?? [];
  const outstanding = clearingData?.outstanding ?? 0;

  // Selection state
  const [selectedInvoiceId, setSelectedInvoiceId] = useState<string>('');
  const [depositAllocations, setDepositAllocations] = useState<Record<string, number>>({});
  const [cashAmount, setCashAmount] = useState<number>(0);
  const [cashMethod, setCashMethod] = useState<PaymentMethod>('CASH');
  const [cashRef, setCashRef] = useState('');
  const [notes, setNotes] = useState('');

  const selectedInvoice = invoices.find(i => i.id === selectedInvoiceId);
  const totalDeposit = useMemo(() => Object.values(depositAllocations).reduce((s, a) => s + a, 0), [depositAllocations]);
  const totalClearing = totalDeposit + cashAmount;
  const invoiceDue = selectedInvoice?.amountDue ?? 0;
  const remaining = invoiceDue - totalClearing;

  // Reset allocations when invoice changes
  const selectInvoice = (invId: string) => {
    setSelectedInvoiceId(invId);
    setDepositAllocations({});
    setCashAmount(0);
  };

  const mutation = useMutation({
    mutationFn: () =>
      distributionApi.processClearing({
        customerId,
        invoiceId: selectedInvoiceId,
        depositAllocations: Object.entries(depositAllocations)
          .filter(([, amt]) => amt > 0)
          .map(([depositId, amount]) => ({ depositId, amount })),
        cashPayment: cashAmount > 0 ? { amount: cashAmount, paymentMethod: cashMethod, referenceNumber: cashRef || undefined } : undefined,
        notes: notes || undefined,
      }),
    onSuccess: (result) => {
      const parts: string[] = [];
      if (result.clearingNumbers.length > 0) parts.push(`Clearings: ${result.clearingNumbers.join(', ')}`);
      if (result.receiptNumber) parts.push(`Receipt: ${result.receiptNumber}`);
      toast.success(`Cleared ${formatCurrency(result.totalCleared)} — ${parts.join(' | ')}`);
      queryClient.invalidateQueries({ queryKey: ['dist-clearing-screen', customerId] });
      queryClient.invalidateQueries({ queryKey: ['dist-invoices'] });
      setSelectedInvoiceId('');
      setDepositAllocations({});
      setCashAmount(0);
    },
    onError: (err: { response?: { data?: { error?: string } } }) => {
      toast.error(err.response?.data?.error ?? 'Clearing failed');
    },
  });

  return (
    <Layout>
      <div className="p-4 lg:p-6 space-y-4 max-w-6xl">
        <h1 className="text-2xl font-bold text-gray-900">Invoice Clearing</h1>

        {/* Customer selector */}
        {!customerId ? (
          <div className="bg-white border rounded-lg p-4 max-w-md">
            <label className="block text-sm font-medium text-gray-700 mb-1">Select Customer</label>
            <div className="relative">
              <input
                type="text"
                value={customerSearch}
                onChange={e => setCustomerSearch(e.target.value)}
                placeholder="Search customer…"
                className="w-full border rounded px-3 py-2 text-sm focus:ring-2 focus:ring-blue-400"
                autoFocus
              />
              {customers && customers.length > 0 && (
                <div className="absolute z-20 top-full left-0 right-0 bg-white border shadow-lg rounded mt-1 max-h-48 overflow-y-auto">
                  {customers.map((c: { id: string; name: string }) => (
                    <button key={c.id} className="w-full text-left px-3 py-2 text-sm hover:bg-blue-50" onClick={() => { setCustomerId(c.id); setCustomerSearch(c.name); }}>
                      {c.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3 text-sm">
            <span className="text-gray-500">Customer:</span>
            <span className="font-medium">{customerSearch || customerId}</span>
            <span className="text-red-600 font-medium">Outstanding: {formatCurrency(outstanding)}</span>
            <button onClick={() => { setCustomerId(''); setCustomerSearch(''); setSelectedInvoiceId(''); }} className="text-blue-600 hover:underline text-xs">Change</button>
          </div>
        )}

        {customerId && !isLoading && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Left: Open invoices */}
            <div className="bg-white border rounded-lg overflow-hidden">
              <h2 className="px-4 py-2 bg-gray-50 border-b text-sm font-semibold text-gray-700">
                Open Invoices ({invoices.length})
              </h2>
              {invoices.length === 0 ? (
                <div className="p-4 text-sm text-gray-400">No open invoices</div>
              ) : (
                <div className="divide-y max-h-96 overflow-y-auto">
                  {invoices.map((inv: DistInvoice) => (
                    <button
                      key={inv.id}
                      onClick={() => selectInvoice(inv.id)}
                      className={`w-full text-left p-3 transition ${selectedInvoiceId === inv.id ? 'bg-blue-50 border-l-4 border-blue-600' : 'hover:bg-gray-50'
                        }`}
                    >
                      <div className="flex justify-between items-center">
                        <span className="font-mono font-medium text-blue-700 text-sm">{inv.invoiceNumber}</span>
                        <span className="font-bold text-red-600 text-sm">{formatCurrency(inv.amountDue)}</span>
                      </div>
                      <div className="flex justify-between text-xs text-gray-500 mt-1">
                        <span>Order: {inv.orderNumber}</span>
                        <span>Total: {formatCurrency(inv.totalAmount)}</span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Right: Clearing panel */}
            <div className="space-y-4">
              {selectedInvoice ? (
                <>
                  {/* Invoice summary */}
                  <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-sm">
                    <div className="flex justify-between">
                      <span className="font-mono font-bold">{selectedInvoice.invoiceNumber}</span>
                      <span className="text-xs text-gray-500">{selectedInvoice.issueDate}</span>
                    </div>
                    <div className="grid grid-cols-3 gap-2 mt-2">
                      <div><p className="text-xs text-gray-500">Total</p><p className="font-medium">{formatCurrency(selectedInvoice.totalAmount)}</p></div>
                      <div><p className="text-xs text-gray-500">Paid</p><p className="text-green-600">{formatCurrency(selectedInvoice.amountPaid)}</p></div>
                      <div><p className="text-xs text-gray-500">Due</p><p className="font-bold text-red-600">{formatCurrency(selectedInvoice.amountDue)}</p></div>
                    </div>
                  </div>

                  {/* Deposit allocations */}
                  {deposits.length > 0 && (
                    <div className="bg-white border rounded-lg p-4">
                      <h3 className="text-sm font-semibold text-gray-700 mb-2">Apply Deposits</h3>
                      <div className="space-y-2">
                        {deposits.map((dep: DepositInfo) => (
                          <div key={dep.id} className="flex items-center gap-3">
                            <div className="flex-1 text-xs">
                              <span className="font-mono">{dep.depositNumber}</span>
                              <span className="text-gray-400 ml-2">{dep.paymentMethod}</span>
                              <span className="text-green-600 ml-2">Avail: {formatCurrency(dep.remainingAmount)}</span>
                            </div>
                            <input
                              type="number"
                              max={dep.remainingAmount}
                              step="1"
                              value={depositAllocations[dep.id] ?? 0}
                              onChange={e => {
                                const val = Math.min(dep.remainingAmount, Math.max(0, Number(e.target.value)));
                                setDepositAllocations(prev => ({ ...prev, [dep.id]: val }));
                              }}
                              className="w-28 border rounded px-2 py-1 text-sm text-right"
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Cash payment */}
                  <div className="bg-white border rounded-lg p-4">
                    <h3 className="text-sm font-semibold text-gray-700 mb-2">Cash / Card Payment</h3>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div>
                        <label className="text-xs text-gray-500">Amount</label>
                        <input
                          type="number"
                          step="1"
                          value={cashAmount}
                          onChange={e => setCashAmount(Math.max(0, Number(e.target.value)))}
                          className="w-full border rounded px-2 py-1.5 text-sm"
                        />
                      </div>
                      <div>
                        <label className="text-xs text-gray-500">Method</label>
                        <select value={cashMethod} onChange={e => setCashMethod(e.target.value as PaymentMethod)} className="w-full border rounded px-2 py-1.5 text-sm">
                          <option value="CASH">Cash</option>
                          <option value="CARD">Card</option>
                          <option value="MOBILE_MONEY">Mobile Money</option>
                          <option value="BANK_TRANSFER">Bank Transfer</option>
                        </select>
                      </div>
                      <div>
                        <label className="text-xs text-gray-500">Reference</label>
                        <input type="text" value={cashRef} onChange={e => setCashRef(e.target.value)} placeholder="Optional" className="w-full border rounded px-2 py-1.5 text-sm" />
                      </div>
                    </div>
                  </div>

                  {/* Notes */}
                  <div>
                    <input type="text" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Notes (optional)" className="w-full border rounded px-3 py-1.5 text-sm" />
                  </div>

                  {/* Summary */}
                  <div className="bg-gray-50 border rounded-lg p-4">
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <span className="text-gray-500">Deposit allocation:</span><span className="text-right font-medium">{formatCurrency(totalDeposit)}</span>
                      <span className="text-gray-500">Cash payment:</span><span className="text-right font-medium">{formatCurrency(cashAmount)}</span>
                      <span className="text-gray-500 font-semibold">Total clearing:</span><span className="text-right font-bold">{formatCurrency(totalClearing)}</span>
                      <span className="text-gray-500">Remaining due:</span>
                      <span className={`text-right font-bold ${remaining > 0.01 ? 'text-red-600' : 'text-green-600'}`}>
                        {formatCurrency(Math.max(0, remaining))}
                      </span>
                    </div>
                    <button
                      onClick={() => mutation.mutate()}
                      disabled={totalClearing <= 0 || totalClearing > invoiceDue + 0.01 || mutation.isPending}
                      className="w-full mt-3 px-4 py-2 bg-purple-600 text-white rounded-lg font-medium hover:bg-purple-700 disabled:opacity-40 text-sm"
                    >
                      {mutation.isPending ? 'Processing…' : `Clear ${formatCurrency(totalClearing)}`}
                    </button>
                  </div>
                </>
              ) : (
                <div className="bg-gray-50 border rounded-lg p-8 text-center text-gray-400 text-sm">
                  Select an invoice to begin clearing
                </div>
              )}
            </div>
          </div>
        )}

        {customerId && isLoading && (
          <div className="text-center py-8 text-gray-400">Loading clearing data…</div>
        )}
      </div>
    </Layout>
  );
}