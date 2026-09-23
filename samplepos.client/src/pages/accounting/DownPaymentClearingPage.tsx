import { useState, useMemo, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../../utils/api';
import { formatCurrency } from '../../utils/currency';
import {
  ArrowRightLeft,
  Search,
  FileText,
  Wallet,
  Banknote,
  CheckCircle2,
  AlertTriangle,
  X,
  RefreshCcw,
  ClipboardCheck,
  History,
} from 'lucide-react';
import toast from 'react-hot-toast';

// ─── Types ───────────────────────────────────────────────────

interface Customer {
  id: string;
  name: string;
  customerNumber?: string;
}

interface OpenInvoice {
  id: string;
  invoiceNumber: string;
  customerId: string;
  customerName: string;
  totalAmount: number;
  amountPaid: number;
  outstandingBalance: number;
  issueDate: string;
  dueDate: string | null;
  status: string;
}

interface OpenDeposit {
  id: string;
  depositNumber: string;
  customerId: string;
  customerName: string;
  amount: number;
  amountUsed: number;
  amountAvailable: number;
  paymentMethod: string;
  createdAt: string;
}

interface DepositAllocation {
  depositId: string;
  depositNumber: string;
  amount: number;
  maxAmount: number;
}

interface ClearingRecord {
  id: string;
  clearingNumber: string;
  downPaymentId: string;
  invoiceId: string;
  amount: number;
  clearedBy: string | null;
  notes: string | null;
  createdAt: string;
  depositNumber?: string;
  invoiceNumber?: string;
  customerName?: string;
}

interface DepositLiability {
  customerId: string;
  customerName: string;
  totalDeposited: number;
  totalCleared: number;
  totalRemaining: number;
  activeDepositCount: number;
}

// ─── API Hooks ───────────────────────────────────────────────

function useCustomerSearch(search: string) {
  return useQuery({
    queryKey: ['customers', 'search', search],
    queryFn: async () => {
      const res = await apiClient.get('/customers', { params: { search, limit: 20 } });
      return (res.data?.data || res.data?.customers || []) as Customer[];
    },
    enabled: search.length >= 2,
  });
}

function useClearingScreenData(customerId: string) {
  return useQuery({
    queryKey: ['down-payment-clearing', 'screen', customerId],
    queryFn: async () => {
      const res = await apiClient.get(`/down-payment-clearing/screen/${customerId}`);
      return res.data.data as { invoices: OpenInvoice[]; deposits: OpenDeposit[] };
    },
    enabled: !!customerId,
  });
}

function useClearingHistory(customerId?: string) {
  return useQuery({
    queryKey: ['down-payment-clearing', 'history', customerId],
    queryFn: async () => {
      const res = await apiClient.get('/down-payment-clearing', {
        params: { customerId, limit: 50 },
      });
      return (res.data.data || []) as ClearingRecord[];
    },
    enabled: true,
  });
}

function useDepositLiabilityReport() {
  return useQuery({
    queryKey: ['down-payment-clearing', 'liability-report'],
    queryFn: async () => {
      const res = await apiClient.get('/down-payment-clearing/liability-report');
      return (res.data.data || []) as DepositLiability[];
    },
  });
}

function useProcessClearing() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      customerId: string;
      invoiceId: string;
      depositAllocations: Array<{ depositId: string; amount: number }>;
      cashPayment?: { amount: number; paymentMethod: string; referenceNumber?: string };
      notes?: string;
    }) => {
      const res = await apiClient.post('/down-payment-clearing', input);
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['down-payment-clearing'] });
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['deposits'] });
    },
  });
}

// ─── Component ───────────────────────────────────────────────

type Tab = 'clearing' | 'history' | 'liability';

export default function DownPaymentClearingPage() {
  const [activeTab, setActiveTab] = useState<Tab>('clearing');
  const [customerSearch, setCustomerSearch] = useState('');
  const [selectedCustomerId, setSelectedCustomerId] = useState('');
  const [showCustomerDropdown, setShowCustomerDropdown] = useState(false);

  // Clearing form state
  const [selectedInvoiceId, setSelectedInvoiceId] = useState('');
  const [depositAllocations, setDepositAllocations] = useState<DepositAllocation[]>([]);
  const [cashAmount, setCashAmount] = useState('');
  const [cashMethod, setCashMethod] = useState<'CASH' | 'CARD' | 'MOBILE_MONEY' | 'BANK_TRANSFER'>('CASH');
  const [cashReference, setCashReference] = useState('');
  const [clearingNotes, setClearingNotes] = useState('');

  // Queries
  const { data: customers } = useCustomerSearch(customerSearch);
  const { data: screenData, isLoading: screenLoading, refetch: refetchScreen } = useClearingScreenData(selectedCustomerId);
  const { data: clearingHistory } = useClearingHistory(activeTab === 'history' ? selectedCustomerId || undefined : undefined);
  const { data: liabilityReport } = useDepositLiabilityReport();
  const clearingMutation = useProcessClearing();

  // Selected invoice
  const selectedInvoice = useMemo(
    () => screenData?.invoices.find(i => i.id === selectedInvoiceId),
    [screenData, selectedInvoiceId]
  );

  // Totals
  const totalDepositAllocation = useMemo(
    () => depositAllocations.reduce((sum, a) => sum + a.amount, 0),
    [depositAllocations]
  );
  const cashAmountNum = parseFloat(cashAmount) || 0;
  const totalClearing = totalDepositAllocation + cashAmountNum;
  const remainingBalance = selectedInvoice ? selectedInvoice.outstandingBalance - totalClearing : 0;

  // ── Handlers ──────────────────────────────────────────────

  const selectCustomer = useCallback((customer: Customer) => {
    setSelectedCustomerId(customer.id);
    setCustomerSearch(customer.name);
    setShowCustomerDropdown(false);
    resetForm();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resetForm = useCallback(() => {
    setSelectedInvoiceId('');
    setDepositAllocations([]);
    setCashAmount('');
    setCashMethod('CASH');
    setCashReference('');
    setClearingNotes('');
  }, []);

  const toggleDeposit = useCallback((deposit: OpenDeposit) => {
    setDepositAllocations(prev => {
      const existing = prev.find(a => a.depositId === deposit.id);
      if (existing) {
        return prev.filter(a => a.depositId !== deposit.id);
      }
      return [...prev, {
        depositId: deposit.id,
        depositNumber: deposit.depositNumber,
        amount: deposit.amountAvailable,
        maxAmount: deposit.amountAvailable,
      }];
    });
  }, []);

  const updateAllocationAmount = useCallback((depositId: string, amount: number) => {
    setDepositAllocations(prev =>
      prev.map(a => a.depositId === depositId ? { ...a, amount: Math.min(Math.max(0, amount), a.maxAmount) } : a)
    );
  }, []);

  const handleSubmitClearing = useCallback(async () => {
    if (!selectedCustomerId || !selectedInvoiceId) {
      toast.error('Select a customer and invoice');
      return;
    }
    if (depositAllocations.length === 0 && cashAmountNum <= 0) {
      toast.error('Add at least one deposit allocation or cash payment');
      return;
    }
    if (selectedInvoice && totalClearing > selectedInvoice.outstandingBalance + 0.01) {
      toast.error('Total clearing exceeds invoice outstanding balance');
      return;
    }

    try {
      await clearingMutation.mutateAsync({
        customerId: selectedCustomerId,
        invoiceId: selectedInvoiceId,
        depositAllocations: depositAllocations.filter(a => a.amount > 0).map(a => ({
          depositId: a.depositId,
          amount: a.amount,
        })),
        cashPayment: cashAmountNum > 0 ? {
          amount: cashAmountNum,
          paymentMethod: cashMethod,
          referenceNumber: cashReference || undefined,
        } : undefined,
        notes: clearingNotes || undefined,
      });
      toast.success('Clearing processed successfully');
      resetForm();
      refetchScreen();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Clearing failed';
      const axiosMsg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      toast.error(axiosMsg || msg);
    }
  }, [selectedCustomerId, selectedInvoiceId, depositAllocations, cashAmountNum, cashMethod, cashReference, clearingNotes, selectedInvoice, totalClearing, clearingMutation, resetForm, refetchScreen]);

  // ── Render ────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-blue-100 rounded-lg">
            <ArrowRightLeft className="h-6 w-6 text-blue-600" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Down Payment Clearing</h1>
            <p className="text-sm text-gray-500">Apply customer deposits against open invoices</p>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200">
        <nav className="-mb-px flex gap-6">
          {([
            { key: 'clearing' as Tab, label: 'Clearing Screen', icon: ClipboardCheck },
            { key: 'history' as Tab, label: 'Clearing History', icon: History },
            { key: 'liability' as Tab, label: 'Deposit Liability', icon: Wallet },
          ]).map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-2 py-3 px-1 border-b-2 font-medium text-sm transition-colors ${activeTab === tab.key
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
            >
              <tab.icon className="h-4 w-4" />
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {/* ── Tab: Clearing Screen ────────────────────────────── */}
      {activeTab === 'clearing' && (
        <div className="space-y-6">
          {/* Customer Search */}
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              <Search className="inline h-4 w-4 mr-1" />
              Select Customer
            </label>
            <div className="relative">
              <input
                type="text"
                value={customerSearch}
                onChange={e => {
                  setCustomerSearch(e.target.value);
                  setShowCustomerDropdown(true);
                  if (!e.target.value) {
                    setSelectedCustomerId('');
                    resetForm();
                  }
                }}
                onFocus={() => setShowCustomerDropdown(true)}
                placeholder="Search customer by name..."
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
              {selectedCustomerId && (
                <button
                  onClick={() => {
                    setCustomerSearch('');
                    setSelectedCustomerId('');
                    resetForm();
                  }}
                  className="absolute right-3 top-2.5 text-gray-400 hover:text-gray-600"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
              {showCustomerDropdown && customers && customers.length > 0 && !selectedCustomerId && (
                <div className="absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                  {customers.map(c => (
                    <button
                      key={c.id}
                      onClick={() => selectCustomer(c)}
                      className="w-full text-left px-4 py-2 hover:bg-blue-50 text-sm"
                    >
                      <span className="font-medium">{c.name}</span>
                      {c.customerNumber && (
                        <span className="text-gray-400 ml-2">{c.customerNumber}</span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Loading / No customer */}
          {selectedCustomerId && screenLoading && (
            <div className="text-center py-8 text-gray-500">Loading clearing data...</div>
          )}

          {selectedCustomerId && screenData && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Left: Open Invoices */}
              <div className="bg-white rounded-lg border border-gray-200">
                <div className="p-4 border-b border-gray-100 flex items-center justify-between">
                  <h3 className="font-semibold text-gray-900 flex items-center gap-2">
                    <FileText className="h-5 w-5 text-orange-500" />
                    Open Invoices ({screenData.invoices.length})
                  </h3>
                  <button onClick={() => refetchScreen()} className="text-gray-400 hover:text-gray-600">
                    <RefreshCcw className="h-4 w-4" />
                  </button>
                </div>
                <div className="divide-y divide-gray-100 max-h-96 overflow-y-auto">
                  {screenData.invoices.length === 0 ? (
                    <div className="p-6 text-center text-gray-400">No open invoices</div>
                  ) : (
                    screenData.invoices.map(inv => (
                      <button
                        key={inv.id}
                        onClick={() => {
                          setSelectedInvoiceId(inv.id === selectedInvoiceId ? '' : inv.id);
                          setDepositAllocations([]);
                          setCashAmount('');
                        }}
                        className={`w-full text-left p-4 hover:bg-gray-50 transition-colors ${selectedInvoiceId === inv.id ? 'bg-blue-50 border-l-4 border-l-blue-500' : ''
                          }`}
                      >
                        <div className="flex justify-between items-start">
                          <div>
                            <p className="font-medium text-gray-900">{inv.invoiceNumber}</p>
                            <p className="text-xs text-gray-500 mt-0.5">
                              Issued: {inv.issueDate} {inv.dueDate && `• Due: ${inv.dueDate}`}
                            </p>
                          </div>
                          <div className="text-right">
                            <p className="font-semibold text-red-600">{formatCurrency(inv.outstandingBalance)}</p>
                            <p className="text-xs text-gray-400">of {formatCurrency(inv.totalAmount)}</p>
                          </div>
                        </div>
                        <div className="mt-2 w-full bg-gray-200 rounded-full h-1.5">
                          <div
                            className="bg-green-500 h-1.5 rounded-full"
                            style={{ width: `${(inv.amountPaid / inv.totalAmount) * 100}%` }}
                          />
                        </div>
                      </button>
                    ))
                  )}
                </div>
              </div>

              {/* Right: Open Deposits */}
              <div className="bg-white rounded-lg border border-gray-200">
                <div className="p-4 border-b border-gray-100">
                  <h3 className="font-semibold text-gray-900 flex items-center gap-2">
                    <Wallet className="h-5 w-5 text-green-500" />
                    Available Deposits ({screenData.deposits.length})
                  </h3>
                </div>
                <div className="divide-y divide-gray-100 max-h-96 overflow-y-auto">
                  {screenData.deposits.length === 0 ? (
                    <div className="p-6 text-center text-gray-400">No active deposits</div>
                  ) : (
                    screenData.deposits.map(dep => {
                      const isSelected = depositAllocations.some(a => a.depositId === dep.id);
                      const allocation = depositAllocations.find(a => a.depositId === dep.id);
                      return (
                        <div
                          key={dep.id}
                          className={`p-4 transition-colors ${isSelected ? 'bg-green-50' : 'hover:bg-gray-50'}`}
                        >
                          <div className="flex justify-between items-start">
                            <div className="flex items-start gap-3">
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => toggleDeposit(dep)}
                                disabled={!selectedInvoiceId}
                                className="mt-1 h-4 w-4 text-blue-600 rounded border-gray-300"
                              />
                              <div>
                                <p className="font-medium text-gray-900">{dep.depositNumber}</p>
                                <p className="text-xs text-gray-500">
                                  {dep.paymentMethod} • {dep.createdAt.split('T')[0]}
                                </p>
                              </div>
                            </div>
                            <div className="text-right">
                              <p className="font-semibold text-green-600">{formatCurrency(dep.amountAvailable)}</p>
                              <p className="text-xs text-gray-400">of {formatCurrency(dep.amount)}</p>
                            </div>
                          </div>
                          {isSelected && allocation && (
                            <div className="mt-3 ml-7">
                              <label className="text-xs text-gray-600 mb-1 block">Amount to apply:</label>
                              <input
                                type="number"
                                value={allocation.amount}
                                onChange={e => updateAllocationAmount(dep.id, parseFloat(e.target.value) || 0)}
                                max={allocation.maxAmount}
                                step="1"
                                className="w-full px-3 py-1.5 border border-gray-300 rounded text-sm focus:ring-2 focus:ring-blue-500"
                              />
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Clearing Form — only when invoice is selected */}
          {selectedInvoice && (
            <div className="bg-white rounded-lg border border-gray-200 p-6 space-y-6">
              <h3 className="font-semibold text-gray-900 flex items-center gap-2">
                <Banknote className="h-5 w-5 text-purple-500" />
                Clear Invoice: {selectedInvoice.invoiceNumber}
              </h3>

              {/* Summary Bar */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <div className="bg-gray-50 rounded-lg p-3">
                  <p className="text-xs text-gray-500">Invoice Total</p>
                  <p className="font-semibold text-gray-900">{formatCurrency(selectedInvoice.totalAmount)}</p>
                </div>
                <div className="bg-orange-50 rounded-lg p-3">
                  <p className="text-xs text-orange-600">Outstanding</p>
                  <p className="font-semibold text-orange-700">{formatCurrency(selectedInvoice.outstandingBalance)}</p>
                </div>
                <div className="bg-blue-50 rounded-lg p-3">
                  <p className="text-xs text-blue-600">This Clearing</p>
                  <p className="font-semibold text-blue-700">{formatCurrency(totalClearing)}</p>
                </div>
                <div className={`rounded-lg p-3 ${remainingBalance <= 0.01 ? 'bg-green-50' : 'bg-red-50'}`}>
                  <p className={`text-xs ${remainingBalance <= 0.01 ? 'text-green-600' : 'text-red-600'}`}>
                    Remaining After
                  </p>
                  <p className={`font-semibold ${remainingBalance <= 0.01 ? 'text-green-700' : 'text-red-700'}`}>
                    {formatCurrency(Math.max(0, remainingBalance))}
                  </p>
                </div>
              </div>

              {/* Deposit Allocations Summary */}
              {depositAllocations.length > 0 && (
                <div className="border border-green-200 rounded-lg p-4 bg-green-50">
                  <h4 className="text-sm font-medium text-green-800 mb-2">
                    Deposit Allocations ({depositAllocations.length})
                  </h4>
                  <div className="space-y-1">
                    {depositAllocations.map(a => (
                      <div key={a.depositId} className="flex justify-between text-sm">
                        <span className="text-green-700">{a.depositNumber}</span>
                        <span className="font-medium text-green-800">{formatCurrency(a.amount)}</span>
                      </div>
                    ))}
                    <div className="border-t border-green-300 pt-1 flex justify-between text-sm font-semibold text-green-900">
                      <span>Total from deposits</span>
                      <span>{formatCurrency(totalDepositAllocation)}</span>
                    </div>
                  </div>
                  <p className="text-xs text-green-600 mt-2 flex items-center gap-1">
                    <ArrowRightLeft className="h-3 w-3" />
                    GL: DR Customer Deposits (2200) / CR Accounts Receivable (1200)
                  </p>
                </div>
              )}

              {/* Cash Payment (optional) */}
              <div className="border border-gray-200 rounded-lg p-4">
                <h4 className="text-sm font-medium text-gray-700 mb-3 flex items-center gap-2">
                  <Banknote className="h-4 w-4" />
                  Cash Payment (optional)
                </h4>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div>
                    <label className="text-xs text-gray-500">Amount</label>
                    <input
                      type="number"
                      value={cashAmount}
                      onChange={e => setCashAmount(e.target.value)}
                      step="1"
                      placeholder="0.00"
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-gray-500">Method</label>
                    <select
                      value={cashMethod}
                      onChange={e => setCashMethod(e.target.value as typeof cashMethod)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="CASH">Cash</option>
                      <option value="CARD">Card</option>
                      <option value="MOBILE_MONEY">Mobile Money</option>
                      <option value="BANK_TRANSFER">Bank Transfer</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-gray-500">Reference</label>
                    <input
                      type="text"
                      value={cashReference}
                      onChange={e => setCashReference(e.target.value)}
                      placeholder="Cheque #, Txn ID..."
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                </div>
                {cashAmountNum > 0 && (
                  <p className="text-xs text-gray-500 mt-2 flex items-center gap-1">
                    <ArrowRightLeft className="h-3 w-3" />
                    GL: DR Cash/Bank / CR Accounts Receivable (1200)
                  </p>
                )}
              </div>

              {/* Notes */}
              <div>
                <label className="text-xs text-gray-500">Notes (optional)</label>
                <textarea
                  value={clearingNotes}
                  onChange={e => setClearingNotes(e.target.value)}
                  rows={2}
                  placeholder="Clearing notes..."
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
                />
              </div>

              {/* Validation Warnings */}
              {totalClearing > selectedInvoice.outstandingBalance + 0.01 && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-3 flex items-center gap-2 text-sm text-red-700">
                  <AlertTriangle className="h-4 w-4 flex-shrink-0" />
                  Total clearing ({formatCurrency(totalClearing)}) exceeds outstanding balance ({formatCurrency(selectedInvoice.outstandingBalance)})
                </div>
              )}

              {/* Submit */}
              <div className="flex items-center justify-between">
                <button
                  onClick={resetForm}
                  className="px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50"
                >
                  Reset
                </button>
                <button
                  onClick={handleSubmitClearing}
                  disabled={
                    clearingMutation.isPending ||
                    totalClearing <= 0 ||
                    totalClearing > selectedInvoice.outstandingBalance + 0.01
                  }
                  className="px-6 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                >
                  {clearingMutation.isPending ? (
                    <>Processing...</>
                  ) : (
                    <>
                      <CheckCircle2 className="h-4 w-4" />
                      Post Clearing ({formatCurrency(totalClearing)})
                    </>
                  )}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Tab: Clearing History ───────────────────────────── */}
      {activeTab === 'history' && (
        <div className="bg-white rounded-lg border border-gray-200">
          <div className="p-4 border-b border-gray-100">
            <h3 className="font-semibold text-gray-900 flex items-center gap-2">
              <History className="h-5 w-5 text-gray-500" />
              Clearing History
            </h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Clearing #</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Customer</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Deposit</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Invoice</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">Amount</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {!clearingHistory || clearingHistory.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="text-center py-8 text-gray-400">
                      No clearing records found
                    </td>
                  </tr>
                ) : (
                  clearingHistory.map(c => (
                    <tr key={c.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 font-medium text-blue-600">{c.clearingNumber}</td>
                      <td className="px-4 py-3">{c.customerName || '—'}</td>
                      <td className="px-4 py-3 text-green-600">{c.depositNumber || '—'}</td>
                      <td className="px-4 py-3 text-orange-600">{c.invoiceNumber || '—'}</td>
                      <td className="px-4 py-3 text-right font-medium">{formatCurrency(c.amount)}</td>
                      <td className="px-4 py-3 text-gray-500">{c.createdAt?.split('T')[0]}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Tab: Deposit Liability Report ────────────────────── */}
      {activeTab === 'liability' && (
        <div className="space-y-4">
          {/* Summary */}
          {liabilityReport && liabilityReport.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="bg-white rounded-lg border border-gray-200 p-4">
                <p className="text-sm text-gray-500">Total Liability</p>
                <p className="text-2xl font-bold text-red-600">
                  {formatCurrency(liabilityReport.reduce((s, r) => s + r.totalRemaining, 0))}
                </p>
              </div>
              <div className="bg-white rounded-lg border border-gray-200 p-4">
                <p className="text-sm text-gray-500">Total Deposited</p>
                <p className="text-2xl font-bold text-gray-900">
                  {formatCurrency(liabilityReport.reduce((s, r) => s + r.totalDeposited, 0))}
                </p>
              </div>
              <div className="bg-white rounded-lg border border-gray-200 p-4">
                <p className="text-sm text-gray-500">Customers with Deposits</p>
                <p className="text-2xl font-bold text-gray-900">{liabilityReport.length}</p>
              </div>
            </div>
          )}

          <div className="bg-white rounded-lg border border-gray-200">
            <div className="p-4 border-b border-gray-100">
              <h3 className="font-semibold text-gray-900 flex items-center gap-2">
                <Wallet className="h-5 w-5 text-red-500" />
                Customer Deposit Liabilities
              </h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">Customer</th>
                    <th className="text-right px-4 py-3 font-medium text-gray-600">Total Deposited</th>
                    <th className="text-right px-4 py-3 font-medium text-gray-600">Cleared</th>
                    <th className="text-right px-4 py-3 font-medium text-gray-600">Remaining (Liability)</th>
                    <th className="text-right px-4 py-3 font-medium text-gray-600">Active Deposits</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {!liabilityReport || liabilityReport.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="text-center py-8 text-gray-400">
                        No deposit liabilities
                      </td>
                    </tr>
                  ) : (
                    liabilityReport.map(r => (
                      <tr key={r.customerId} className="hover:bg-gray-50">
                        <td className="px-4 py-3 font-medium">{r.customerName}</td>
                        <td className="px-4 py-3 text-right">{formatCurrency(r.totalDeposited)}</td>
                        <td className="px-4 py-3 text-right text-green-600">{formatCurrency(r.totalCleared)}</td>
                        <td className="px-4 py-3 text-right font-semibold text-red-600">{formatCurrency(r.totalRemaining)}</td>
                        <td className="px-4 py-3 text-right">{r.activeDepositCount}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}