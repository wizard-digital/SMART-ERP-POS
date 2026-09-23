/**
 * Customer deposits — identity SSOT (browse list never gates money).
 *
 * Bound mode (customer detail/modal): customerId + customerName required.
 * Browse mode: picker may list customers; after pick, identity = useCustomer(id).
 */
import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import ReactDOM from 'react-dom';
import { formatCurrency } from '../../utils/currency';
import { useCustomers, useCustomer } from '../../hooks/useApi';
import { apiClient } from '../../utils/api';
import { formatTimestampDate } from '../../utils/businessDate';
import { useTransactionGuard, ZINDEX } from '../../hooks/useTransactionGuard';
import type { GuardHandle } from '../../hooks/useTransactionGuard';
import type { AxiosError } from 'axios';
import {
  canPostCustomerDeposit,
  resolveCustomerDepositDisplayName,
} from '@shared/domain/customerDepositSsot';

interface CustomerDeposit {
  id: string;
  depositNumber: string;
  customerId: string;
  customerName?: string;
  amount: number;
  amountUsed: number;
  amountAvailable: number;
  paymentMethod: 'CASH' | 'CARD' | 'MOBILE_MONEY' | 'BANK_TRANSFER';
  reference?: string;
  notes?: string;
  status: 'ACTIVE' | 'USED' | 'DEPLETED' | 'REFUNDED' | 'EXPIRED' | 'CANCELLED';
  createdAt: string;
  createdBy: string;
  updatedAt: string;
}

interface DepositSummary {
  customerId: string;
  customerName: string;
  availableBalance: number;
  totalDeposits: number;
  totalUsed: number;
  activeDepositCount: number;
}

/** Bound: opened on a known customer — name prop is mandatory (SSOT). */
type BoundCustomerDepositProps = {
  customerId: string;
  customerName: string;
  className?: string;
  onDepositChange?: () => void;
};

/** Browse: pick customer first; list is catalog only, not write identity. */
type BrowseCustomerDepositProps = {
  customerId?: undefined;
  customerName?: undefined;
  className?: string;
  onDepositChange?: () => void;
};

export type CustomerDepositsProps = BoundCustomerDepositProps | BrowseCustomerDepositProps;

function apiErrorMessage(err: unknown): string {
  if (!err) return 'Unknown error';
  const ax = err as AxiosError<{ error?: string; message?: string }>;
  const data = ax.response?.data;
  if (data && typeof data === 'object') {
    if (typeof data.error === 'string' && data.error.trim()) return data.error;
    if (typeof data.message === 'string' && data.message.trim()) return data.message;
  }
  if (err instanceof Error && err.message) return err.message;
  return 'Unknown error';
}

const CustomerDeposits: React.FC<CustomerDepositsProps> = (props) => {
  const { className = '', onDepositChange } = props;
  const isBound = typeof props.customerId === 'string' && props.customerId.length > 0;
  const boundId = isBound ? props.customerId : '';
  const boundName = isBound ? props.customerName : '';

  const [deposits, setDeposits] = useState<CustomerDeposit[]>([]);
  const [summary, setSummary] = useState<DepositSummary | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);

  const { openGuard, closeGuard } = useTransactionGuard();
  const guardRef = useRef<GuardHandle | null>(null);
  useEffect(() => {
    if (showAddModal) {
      guardRef.current = openGuard({ cancellable: false, label: 'Add customer deposit' });
      return () => {
        if (guardRef.current) {
          closeGuard(guardRef.current.id);
          guardRef.current = null;
        }
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showAddModal]);

  const [selectedCustomer, setSelectedCustomer] = useState<string>(boundId);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (boundId) setSelectedCustomer(boundId);
  }, [boundId]);

  const [depositForm, setDepositForm] = useState({
    amount: '',
    paymentMethod: 'CASH' as CustomerDeposit['paymentMethod'],
    reference: '',
    notes: '',
  });
  const [isSaving, setIsSaving] = useState(false);

  // Browse catalog ONLY — never used for save gate or bound identity
  const { data: customersResponse } = useCustomers(1, 100);
  const pickerCustomers = useMemo(
    () => (isBound ? [] : ((customersResponse?.data || []) as Array<{ id: string; name: string }>)),
    [isBound, customersResponse?.data],
  );

  // Master-data SSOT for selected id (bound or post-pick)
  const { data: customerDetail, isLoading: isLoadingMaster } = useCustomer(selectedCustomer);

  const masterName = (customerDetail as { name?: string } | undefined)?.name;

  const resolvedCustomerName = useMemo(
    () =>
      resolveCustomerDepositDisplayName({
        boundName: boundName || null,
        masterName: masterName ?? null,
        balanceName: summary?.customerName ?? null,
      }),
    [boundName, masterName, summary?.customerName],
  );

  const loadDeposits = useCallback(async () => {
    if (!selectedCustomer) {
      setDeposits([]);
      setSummary(null);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const [depositsResponse, summaryResponse] = await Promise.all([
        apiClient.get(`deposits`, { params: { customerId: selectedCustomer } }),
        apiClient.get(`deposits/customer/${selectedCustomer}/balance`),
      ]);

      if (depositsResponse.data?.success) {
        setDeposits(depositsResponse.data.data?.deposits || []);
      } else {
        setDeposits([]);
      }

      if (summaryResponse.data?.success && summaryResponse.data?.data) {
        setSummary(summaryResponse.data.data);
      } else {
        setSummary(null);
      }
    } catch (err) {
      console.error('Error loading deposits:', err);
      setError(apiErrorMessage(err) || 'Failed to load deposits');
      setDeposits([]);
      setSummary(null);
    } finally {
      setIsLoading(false);
    }
  }, [selectedCustomer]);

  useEffect(() => {
    loadDeposits();
  }, [loadDeposits]);

  const saveDeposit = async () => {
    try {
      // SSOT: write identity is customer UUID only — server findCustomerById is truth
      if (!canPostCustomerDeposit(selectedCustomer)) {
        alert('Please select a customer');
        return;
      }

      const amount = parseFloat(depositForm.amount);
      if (isNaN(amount) || amount <= 0) {
        alert('Please enter a valid amount');
        return;
      }

      setIsSaving(true);

      const response = await apiClient.post('deposits', {
        customerId: selectedCustomer,
        amount,
        paymentMethod: depositForm.paymentMethod,
        reference: depositForm.reference || undefined,
        notes: depositForm.notes || undefined,
      });

      if (response.data?.success) {
        setDepositForm({
          amount: '',
          paymentMethod: 'CASH',
          reference: '',
          notes: '',
        });
        setShowAddModal(false);
        await loadDeposits();
        onDepositChange?.();
        alert(`✅ Deposit ${response.data.data.depositNumber} created successfully!`);
      } else {
        throw new Error(response.data?.error || 'Failed to create deposit');
      }
    } catch (err: unknown) {
      console.error('Error saving deposit:', err);
      alert(`❌ Failed to save deposit: ${apiErrorMessage(err)}`);
    } finally {
      setIsSaving(false);
    }
  };

  const refundDeposit = async (depositId: string, depositNumber: string, availableAmount: number) => {
    if (!confirm(`Refund ${formatCurrency(availableAmount)} from deposit ${depositNumber}?`)) {
      return;
    }

    try {
      const response = await apiClient.post(`deposits/${depositId}/refund`, {
        reason: 'Customer requested refund',
      });

      if (response.data?.success) {
        await loadDeposits();
        onDepositChange?.();
        alert('✅ Deposit refunded successfully!');
      } else {
        throw new Error(response.data?.error || 'Failed to refund deposit');
      }
    } catch (err: unknown) {
      console.error('Error refunding deposit:', err);
      alert(`❌ Failed to refund deposit: ${apiErrorMessage(err)}`);
    }
  };

  const totalDeposits = summary?.totalDeposits || 0;
  const totalAvailable = summary?.availableBalance || 0;
  const totalUsed = summary?.totalUsed || 0;

  const displayName =
    resolvedCustomerName ||
    (selectedCustomer && isLoadingMaster ? 'Loading customer…' : selectedCustomer ? 'Customer' : '—');

  return (
    <div className={`bg-white rounded-lg shadow ${className}`}>
      <div className="px-6 py-4 border-b border-gray-200">
        <div className="flex justify-between items-center">
          <div>
            <h2 className="text-xl font-semibold text-gray-900">Customer Deposits</h2>
            <p className="text-sm text-gray-600 mt-1">
              Manage customer prepayments and deposits
            </p>
          </div>
          <button
            onClick={() => {
              if (!canPostCustomerDeposit(selectedCustomer)) {
                alert('Please select a customer first');
                return;
              }
              setShowAddModal(true);
            }}
            disabled={!canPostCustomerDeposit(selectedCustomer)}
            className={`px-4 py-2 rounded text-white ${
              canPostCustomerDeposit(selectedCustomer)
                ? 'bg-blue-600 hover:bg-blue-700'
                : 'bg-gray-400 cursor-not-allowed'
            }`}
          >
            + Add Deposit
          </button>
        </div>
      </div>

      {/* Browse picker — catalog only (SSOT: not identity / not save gate) */}
      {!isBound && (
        <div className="px-6 py-4 bg-gray-50 border-b border-gray-200">
          <label htmlFor="customer-select" className="block text-sm font-medium text-gray-700 mb-1">
            Select Customer
          </label>
          <select
            id="customer-select"
            value={selectedCustomer}
            onChange={(e) => setSelectedCustomer(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-md"
          >
            <option value="">-- Select a Customer --</option>
            {pickerCustomers.map((customer) => (
              <option key={customer.id} value={customer.id}>
                {customer.name}
              </option>
            ))}
          </select>
          {pickerCustomers.length >= 100 && (
            <p className="mt-1 text-xs text-amber-700">
              Picker shows a partial list. For other customers, open Customer Detail → Deposits
              (identity SSOT uses the customer record, not this list).
            </p>
          )}
        </div>
      )}

      <div className="px-6 py-3 bg-amber-50 border-b border-amber-200">
        <div className="flex items-start gap-2">
          <span className="text-amber-600 text-lg">💡</span>
          <div className="text-sm text-amber-800">
            <strong>How deposits work:</strong> Deposits are applied at the POS checkout. When this
            customer makes a purchase, select &quot;DEPOSIT&quot; as the payment method to use their
            available balance.
          </div>
        </div>
      </div>

      {error && (
        <div className="px-6 py-3 bg-red-50 border-b border-red-200">
          <div className="flex items-center gap-2 text-red-700">
            <span>⚠️</span>
            <span>{error}</span>
            <button
              onClick={() => setError(null)}
              className="ml-auto text-red-500 hover:text-red-700"
              type="button"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {selectedCustomer && (
        <div className="px-6 py-4 bg-gray-50 border-b border-gray-200">
          {resolvedCustomerName && (
            <p className="text-sm text-gray-700 mb-3">
              <span className="font-medium">{resolvedCustomerName}</span>
            </p>
          )}
          <div className="grid grid-cols-3 gap-4">
            <div className="text-center">
              <div className="text-2xl font-bold text-blue-600">{formatCurrency(totalDeposits)}</div>
              <div className="text-sm text-gray-600">Total Deposits</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-green-600">{formatCurrency(totalAvailable)}</div>
              <div className="text-sm text-gray-600">Available</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-gray-600">{formatCurrency(totalUsed)}</div>
              <div className="text-sm text-gray-600">Used</div>
            </div>
          </div>
        </div>
      )}

      <div className="overflow-x-auto">
        {!selectedCustomer ? (
          <div className="p-8 text-center text-gray-500">Please select a customer to view deposits</div>
        ) : isLoading ? (
          <div className="p-8 text-center">
            <div className="animate-spin inline-block w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full" />
            <p className="mt-2 text-gray-500">Loading deposits...</p>
          </div>
        ) : deposits.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            <p className="text-lg mb-2">No deposits found</p>
            <p className="text-sm">Click &quot;Add Deposit&quot; to record a customer prepayment</p>
          </div>
        ) : (
          <table className="w-full">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Date</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Deposit #</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Payment</th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Amount</th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Available</th>
                <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase">Status</th>
                <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {deposits.map((deposit, index) => (
                <tr key={deposit.id} className={index % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    {formatTimestampDate(deposit.createdAt)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-sm font-medium text-gray-900">{deposit.depositNumber}</div>
                    {deposit.reference && (
                      <div className="text-xs text-gray-500">Ref: {deposit.reference}</div>
                    )}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span className="px-2 py-1 text-xs rounded-full bg-blue-100 text-blue-800">
                      {deposit.paymentMethod.replace('_', ' ')}
                    </span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium text-gray-900">
                    {formatCurrency(deposit.amount)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-semibold text-green-600">
                    {formatCurrency(deposit.amountAvailable)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-center">
                    <span
                      className={`px-2 py-1 text-xs rounded-full ${
                        deposit.status === 'ACTIVE'
                          ? 'bg-green-100 text-green-800'
                          : deposit.status === 'USED' || deposit.status === 'DEPLETED'
                            ? 'bg-gray-100 text-gray-800'
                            : deposit.status === 'REFUNDED'
                              ? 'bg-red-100 text-red-800'
                              : 'bg-yellow-100 text-yellow-800'
                      }`}
                    >
                      {deposit.status === 'DEPLETED' ? 'USED' : deposit.status}
                    </span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-center text-sm font-medium">
                    {deposit.status === 'ACTIVE' && deposit.amountAvailable > 0 && (
                      <>
                        <span
                          className="text-gray-400 mr-3 text-xs"
                          title="Deposits are applied at POS checkout"
                        >
                          Use at POS →
                        </span>
                        <button
                          type="button"
                          onClick={() =>
                            refundDeposit(deposit.id, deposit.depositNumber, deposit.amountAvailable)
                          }
                          className="text-red-600 hover:text-red-900"
                        >
                          Refund
                        </button>
                      </>
                    )}
                    {(deposit.status === 'USED' || deposit.status === 'DEPLETED') && (
                      <span className="text-gray-400 text-xs">Fully used</span>
                    )}
                    {deposit.status === 'REFUNDED' && (
                      <span className="text-gray-400 text-xs">Refunded</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showAddModal &&
        ReactDOM.createPortal(
          <div
            className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center"
            style={{ zIndex: guardRef.current?.panelZIndex ?? ZINDEX.PANEL }}
            onClick={() => !isSaving && setShowAddModal(false)}
          >
            <div
              className="bg-white rounded-lg p-6 w-full max-w-md"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="text-lg font-semibold mb-4">Add Customer Deposit</h3>

              <div className="mb-4 p-3 bg-gray-50 rounded-md">
                <p className="text-sm text-gray-600">Customer:</p>
                <p className="font-medium">{displayName}</p>
              </div>

              <div className="space-y-4">
                <div>
                  <label
                    htmlFor="deposit-amount"
                    className="block text-sm font-medium text-gray-700 mb-1"
                  >
                    Amount <span className="text-red-500">*</span>
                  </label>
                  <input
                    id="deposit-amount"
                    type="number"
                    step="1"
                    value={depositForm.amount}
                    onChange={(e) => setDepositForm({ ...depositForm, amount: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md"
                    placeholder="Enter deposit amount"
                    required
                  />
                </div>

                <div>
                  <label
                    htmlFor="payment-method"
                    className="block text-sm font-medium text-gray-700 mb-1"
                  >
                    Payment Method
                  </label>
                  <select
                    id="payment-method"
                    value={depositForm.paymentMethod}
                    onChange={(e) =>
                      setDepositForm({
                        ...depositForm,
                        paymentMethod: e.target.value as CustomerDeposit['paymentMethod'],
                      })
                    }
                    className="w-full px-3 py-2 border border-gray-300 rounded-md"
                  >
                    <option value="CASH">Cash</option>
                    <option value="CARD">Card</option>
                    <option value="MOBILE_MONEY">Mobile Money</option>
                    <option value="BANK_TRANSFER">Bank Transfer</option>
                  </select>
                </div>

                <div>
                  <label
                    htmlFor="deposit-reference"
                    className="block text-sm font-medium text-gray-700 mb-1"
                  >
                    Reference (Optional)
                  </label>
                  <input
                    id="deposit-reference"
                    type="text"
                    value={depositForm.reference}
                    onChange={(e) => setDepositForm({ ...depositForm, reference: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md"
                    placeholder="Transaction reference"
                  />
                </div>

                <div>
                  <label
                    htmlFor="deposit-notes"
                    className="block text-sm font-medium text-gray-700 mb-1"
                  >
                    Notes (Optional)
                  </label>
                  <textarea
                    id="deposit-notes"
                    value={depositForm.notes}
                    onChange={(e) => setDepositForm({ ...depositForm, notes: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md"
                    rows={3}
                    placeholder="Additional notes"
                  />
                </div>
              </div>

              <div className="flex gap-2 mt-6">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  disabled={isSaving}
                  className="flex-1 px-4 py-2 text-gray-600 border border-gray-300 rounded hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={saveDeposit}
                  disabled={
                    isSaving ||
                    !depositForm.amount ||
                    !canPostCustomerDeposit(selectedCustomer)
                  }
                  className={`flex-1 px-4 py-2 rounded ${
                    isSaving ||
                    !depositForm.amount ||
                    !canPostCustomerDeposit(selectedCustomer)
                      ? 'bg-gray-400 cursor-not-allowed'
                      : 'bg-blue-600 hover:bg-blue-700'
                  } text-white`}
                >
                  {isSaving ? 'Saving...' : 'Save Deposit'}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
};

export default CustomerDeposits;