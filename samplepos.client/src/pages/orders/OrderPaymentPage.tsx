import { useState, useMemo } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Layout from '../../components/Layout';
import CustomerSelector from '../../components/pos/CustomerSelector';
import { OpenRegisterDialog } from '../../components/cash-register';
import { useCurrentSession } from '../../hooks/useCashRegister';
import {
  getPosSessionPolicyDefinition,
  parsePosSessionPolicy,
  posSessionRequiresOpenSession,
} from '@shared/pos/posSessionPolicySsot';
import { api } from '../../utils/api';
import { formatCurrency } from '../../utils/currency';
import { toast } from 'react-hot-toast';
import type { Customer } from '@shared/zod/customer';
import Decimal from 'decimal.js';
import { useSubmitOnEnter } from '../../hooks/useSubmitOnEnter';
import { useCanAccess } from '../../authorization/useAuthorization';
import {
  clearPayDesiredLines,
  markRestaurantCheckSettledInJournal,
  resolveDesiredLinesForPaymentPage,
} from '../../lib/restaurantOfflineOps';
import { computeVoidItemsFromUpdatedLines, totalLineQuantity } from '@shared/utils/reconcileOrderLineVoids';
import {
  clearRestaurantBillRequestedOffline,
  paintRestaurantTableFreeOffline,
} from '../../lib/restaurantOfflineCache';
import { publishLanKdsBoardChanged } from '../../lib/restaurantLanKds';
import { getAllEvents, getAllSyncState } from '../../lib/offlineEventJournal';
import { deriveRestaurantOpenChecks } from '../../lib/offlineEventSelectors';
import {
  printRestaurantSettlementReceipt,
} from '../../lib/restaurantSettlementReceipt';
import {
  buildReceiptDataFromCheckout,
  fetchInvoiceSettingsForReceipt,
} from '../../lib/receiptFromSale';
import { useAuth } from '../../contexts/AuthContext';

/** Stable complete key per order for retries / double-submit (session-scoped). */
function getOrCreateOrderCompleteIdempotencyKey(orderId: string): string {
  const storageKey = `order_complete_idem:${orderId}`;
  try {
    const existing = sessionStorage.getItem(storageKey);
    if (existing && existing.length > 0 && existing.length <= 100) return existing;
  } catch {
    /* private mode — fall through */
  }
  const compactOrder = orderId.replace(/-/g, '').slice(0, 32);
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '')
      : `${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
  const key = `ordc_${compactOrder}_${rand}`.slice(0, 100);
  try {
    sessionStorage.setItem(storageKey, key);
  } catch {
    /* ignore */
  }
  return key;
}

function clearOrderCompleteIdempotencyKey(orderId: string): void {
  try {
    sessionStorage.removeItem(`order_complete_idem:${orderId}`);
  } catch {
    /* ignore */
  }
}

// ── Types ────────────────────────────────────────────────────────────

interface AtCostOrderLinePreview {
  productId: string;
  productName: string;
  quantity: number;
  orderUnitPrice: number;
  fefoUnitPrice: number;
  priceDrift: boolean;
}

interface AtCostOrderPreview {
  isAtCostCustomer: boolean;
  hasDrift: boolean;
  lines: AtCostOrderLinePreview[];
  orderTotal: number | null;
  repricedTotal: number | null;
}

interface OrderItem {
  id: string;
  orderId: string;
  productId: string;
  productName: string;
  quantity: string;
  unitPrice: string;
  lineTotal: string;
  discountAmount: string;
  uomId: string | null;
}

interface OrderDetail {
  id: string;
  orderNumber: string;
  customerId: string | null;
  customerName: string | null;
  subtotal: string;
  discountAmount: string;
  taxAmount: string;
  totalAmount: string;
  status: string;
  createdBy: string;
  createdByName: string | null;
  orderDate: string;
  notes: string | null;
  createdAt: string;
  items: OrderItem[];
}

type PaymentMethod = 'CASH' | 'CARD' | 'MOBILE_MONEY' | 'AIRTEL_MONEY' | 'CREDIT' | 'DEPOSIT' | 'BANK_TRANSFER';

// ── Component ────────────────────────────────────────────────────────

export default function OrderPaymentPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { user } = useAuth();

  /** Restaurant FOH passes ?returnTo=/restaurant so pay lands on the tables floor. */
  const returnToPath = (() => {
    const raw = searchParams.get('returnTo');
    if (raw === '/restaurant' || raw === '/orders-queue') return raw;
    // Legacy multi-ticket deep-links still land on the floor (not a specific table).
    if (raw?.startsWith('/restaurant?')) return '/restaurant';
    return '/orders-queue';
  })();
  const returnToLabel = returnToPath === '/restaurant' ? 'Back to Tables' : 'Back to Queue';
  /** Restaurant FOH settlement requires restaurant.pay — orders.pay alone is not enough. */
  const canRestaurantPay = useCanAccess(undefined, ['restaurant.pay']);
  const canOrdersPay = useCanAccess(undefined, ['orders.pay']);
  const canSettleThisOrder =
    returnToPath === '/restaurant' ? canRestaurantPay : canOrdersPay || canRestaurantPay;

  const {
    data: currentSession,
    posSessionPolicy,
    isLoading: isLoadingSession,
    isError: isSessionError,
    refetch: refetchSession,
  } = useCurrentSession();
  const sessionPolicy = parsePosSessionPolicy(posSessionPolicy);
  const sessionPolicyDef = getPosSessionPolicyDefinition(sessionPolicy);
  const sessionEnforced = posSessionRequiresOpenSession(sessionPolicy);
  const hasOpenRegister = !!currentSession;
  const [showOpenRegisterDialog, setShowOpenRegisterDialog] = useState(false);

  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('CASH');
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentReference, setPaymentReference] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [customerInitialized, setCustomerInitialized] = useState(false);
  // Extra discount the cashier can apply at payment time
  const [cashierDiscount, setCashierDiscount] = useState(0);
  const [discountInput, setDiscountInput] = useState('');
  const [showDiscountInput, setShowDiscountInput] = useState(false);
  const [paymentLines, setPaymentLines] = useState<
    Array<{
      id: string;
      paymentMethod: PaymentMethod;
      amount: number;
      reference?: string;
    }>
  >([]);

  // Fetch order details — restaurant pay heals ACK'd offline voids before showing totals.
  const { data: order, isLoading, error } = useQuery({
    queryKey: ['orders', id, returnToPath],
    queryFn: async () => {
      const resp = await api.orders.getById(id!);
      let detail = resp.data.data as OrderDetail;
      if (returnToPath === '/restaurant' && detail.status === 'PENDING' && detail.items?.length) {
        // Prefer ticket snapshot stored at Pay — never treat raw server lines as FOH truth.
        const desired = resolveDesiredLinesForPaymentPage(
          detail.id,
          detail.items.map((it) => ({
            id: it.id,
            productId: it.productId,
            quantity: it.quantity,
          })),
        );
        const voids = computeVoidItemsFromUpdatedLines(detail.items, desired);
        if (voids.length > 0) {
          await api.restaurant.voidItems(detail.id, {
            items: voids,
            reason: 'Reconcile voided lines before pay',
          });
          const refreshed = await api.orders.getById(id!);
          detail = refreshed.data.data as OrderDetail;
        }
        // Hard stop: refuse to show Complete Order totals that still exceed ticket truth.
        const stillExtra = computeVoidItemsFromUpdatedLines(detail.items, desired);
        if (stillExtra.length > 0 || totalLineQuantity(
          detail.items.map((it) => ({ lineId: it.id, quantity: Number(it.quantity) || 0 })),
        ) > totalLineQuantity(desired) + 1e-9) {
          throw new Error(
            'Ticket and server lines still disagree after void heal — go back to the ticket and retry Pay',
          );
        }
      }
      return detail;
    },
    enabled: !!id,
  });

  // Pre-populate customer from order (if order has one)
  const { data: orderCustomer } = useQuery({
    queryKey: ['customers', order?.customerId],
    queryFn: async () => {
      const resp = await api.customers.getById(order!.customerId!);
      return resp.data.data as Customer;
    },
    enabled: !!order?.customerId && !customerInitialized,
  });

  // Set customer once loaded from order
  if (orderCustomer && !customerInitialized) {
    setSelectedCustomer(orderCustomer);
    setCustomerInitialized(true);
  }

  const effectiveCustomerId = selectedCustomer?.id ?? order?.customerId ?? null;
  const isAtCostCustomer = selectedCustomer?.pricingMode === 'AT_COST';

  const { data: atCostPreview } = useQuery({
    queryKey: ['orders', id, 'at-cost-preview', effectiveCustomerId],
    queryFn: async () => {
      const resp = await api.orders.atCostPreview(id!, effectiveCustomerId ?? undefined);
      return resp.data.data as AtCostOrderPreview;
    },
    enabled: !!id && !!effectiveCustomerId && isAtCostCustomer,
  });

  const atCostLineByKey = useMemo(() => {
    const map = new Map<string, AtCostOrderLinePreview>();
    for (const line of atCostPreview?.lines ?? []) {
      map.set(`${line.productId}:${line.quantity}`, line);
    }
    return map;
  }, [atCostPreview?.lines]);

  const orderBaseTotal = useMemo(() => {
    if (!order) return 0;
    if (
      atCostPreview?.isAtCostCustomer &&
      atCostPreview.repricedTotal != null &&
      atCostPreview.hasDrift
    ) {
      return atCostPreview.repricedTotal;
    }
    return new Decimal(order.totalAmount).toNumber();
  }, [order, atCostPreview]);

  const totalAmount = useMemo(() => {
    return Math.max(0, new Decimal(orderBaseTotal).minus(cashierDiscount).toNumber());
  }, [orderBaseTotal, cashierDiscount]);

  // Split payment calculations
  const totalPaid = useMemo(() => {
    return paymentLines.reduce((sum, line) => new Decimal(sum).plus(line.amount).toNumber(), 0);
  }, [paymentLines]);

  const remainingBalance = useMemo(() => {
    return new Decimal(totalAmount).minus(totalPaid).toNumber();
  }, [totalAmount, totalPaid]);

  const changeAmount = useMemo(() => {
    if (remainingBalance < 0) return Math.abs(remainingBalance);
    return 0;
  }, [remainingBalance]);

  const hasCashPayment = useMemo(() => {
    return paymentLines.some((line) => line.paymentMethod === 'CASH');
  }, [paymentLines]);

  const depositBalance = useMemo(() => {
    return selectedCustomer?.depositBalance ?? 0;
  }, [selectedCustomer]);

  const depositAlreadyApplied = useMemo(() => {
    return paymentLines
      .filter((l) => l.paymentMethod === 'DEPOSIT')
      .reduce((sum, l) => sum + l.amount, 0);
  }, [paymentLines]);

  const canCompleteSale = useMemo(() => {
    if (!canSettleThisOrder) return false;
    if (paymentLines.length === 0) return false;
    const hasCreditPayment = paymentLines.some((l) => l.paymentMethod === 'CREDIT');
    // Exact payment
    if (Math.abs(remainingBalance) < 0.01) return true;
    // Overpaid with cash
    if (remainingBalance < -0.01 && hasCashPayment) return true;
    // Underpaid but has customer for auto-credit
    if (remainingBalance > 0.01 && hasCreditPayment) return true;
    if (remainingBalance > 0.01 && selectedCustomer) return true;
    return false;
  }, [canSettleThisOrder, paymentLines, remainingBalance, hasCashPayment, selectedCustomer]);

  // Add a payment line
  const handleAddPayment = () => {
    const amount = parseFloat(paymentAmount);
    if (isNaN(amount) || amount <= 0) {
      toast.error('Enter a valid payment amount');
      return;
    }

    // Only CASH allows overpayment
    if (paymentMethod !== 'CASH' && amount > remainingBalance + 0.01) {
      toast.error(`${paymentMethod} cannot exceed remaining balance of ${formatCurrency(remainingBalance)}`);
      return;
    }

    // DEPOSIT requires customer + sufficient balance
    if (paymentMethod === 'DEPOSIT') {
      if (!selectedCustomer) {
        toast.error('Deposit payment requires a customer');
        return;
      }
      const availableDeposit = depositBalance - depositAlreadyApplied;
      if (amount > availableDeposit + 0.01) {
        toast.error(`Insufficient deposit. Available: ${formatCurrency(availableDeposit)}`);
        return;
      }
    }

    // CREDIT requires customer
    if (paymentMethod === 'CREDIT') {
      if (!selectedCustomer) {
        toast.error('Credit payment requires a customer');
        return;
      }
    }

    const newLine = {
      id: `payment_${Date.now()}_${Math.random()}`,
      paymentMethod,
      amount,
      reference: paymentReference.trim() || undefined,
    };

    setPaymentLines([...paymentLines, newLine]);
    setPaymentAmount('');
    setPaymentReference('');
  };

  const handleRemovePaymentLine = (lineId: string) => {
    setPaymentLines(paymentLines.filter((line) => line.id !== lineId));
  };

  const handleQuickFill = () => {
    if (remainingBalance > 0) setPaymentAmount(remainingBalance.toFixed(2));
  };

  // Complete order mutation
  const completeMutation = useMutation({
    mutationFn: async () => {
      const effectiveCustomerId = selectedCustomer?.id ?? order?.customerId ?? null;

      // Build final payment lines — auto-add CREDIT for remaining if customer selected
      const finalPaymentLines = [...paymentLines];
      if (remainingBalance > 0.01 && selectedCustomer) {
        finalPaymentLines.push({
          id: `auto_credit_${Date.now()}`,
          paymentMethod: 'CREDIT' as PaymentMethod,
          amount: remainingBalance,
        });
      }

      // Determine effective payment method from first line
      const effectiveMethod = finalPaymentLines[0]?.paymentMethod || 'CASH';
      const totalPaidAmount = finalPaymentLines.reduce((s, l) => s + l.amount, 0);

      const payload: {
        paymentMethod: string;
        paymentReceived: number;
        customerId?: string | null;
        paymentLines?: { paymentMethod: string; amount: number; reference?: string }[];
        extraDiscountAmount?: number;
        cashRegisterSessionId?: string;
        idempotencyKey: string;
      } = {
        paymentMethod: effectiveMethod,
        paymentReceived: totalPaidAmount,
        customerId: effectiveCustomerId,
        paymentLines: finalPaymentLines.map((l) => ({
          paymentMethod: l.paymentMethod,
          amount: l.amount,
          reference: l.reference,
        })),
        ...(cashierDiscount > 0 ? { extraDiscountAmount: cashierDiscount } : {}),
        ...(currentSession?.id ? { cashRegisterSessionId: currentSession.id } : {}),
        idempotencyKey: getOrCreateOrderCompleteIdempotencyKey(id!),
      };

      const resp = await api.orders.complete(id!, payload);
      return resp.data;
    },
    onSuccess: async (data) => {
      if (id) clearOrderCompleteIdempotencyKey(id);
      const result = data.data as {
        order?: OrderDetail;
        sale?: { saleNumber?: string };
        atCostReprice?: { hasDrift: boolean };
      } | undefined;
      const saleNum = result?.sale?.saleNumber || '';
      if (result?.atCostReprice?.hasDrift) {
        toast.success(`Sale ${saleNum} created — prices updated to current FEFO stock`);
      } else {
        toast.success(`Sale ${saleNum} created successfully!`);
      }
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      queryClient.invalidateQueries({ queryKey: ['sales'] });
      queryClient.invalidateQueries({ queryKey: ['customers'] });
      if (returnToPath === '/restaurant') {
        void queryClient.invalidateQueries({ queryKey: ['restaurant'] });
        if (id) {
          clearPayDesiredLines(id);
          const openBefore = deriveRestaurantOpenChecks(getAllEvents(), getAllSyncState());
          const tableId = openBefore.find((c) => c.orderId === id)?.tableId ?? null;
          markRestaurantCheckSettledInJournal(id, 'PAID');
          if (tableId) {
            clearRestaurantBillRequestedOffline(tableId, id);
            const stillOpen = deriveRestaurantOpenChecks(getAllEvents(), getAllSyncState()).some(
              (c) => c.tableId === tableId,
            );
            if (!stillOpen) paintRestaurantTableFreeOffline(tableId);
          }
          publishLanKdsBoardChanged('SALE_COMPLETED');
        }
      }

      // Sale receipt — never silent skip: toast when disabled / fail / success.
      try {
        const invoiceSettings = await fetchInvoiceSettingsForReceipt();
        const paidForReceipt = paymentLines.reduce((s, l) => s + l.amount, 0);
        const changeForReceipt =
          paidForReceipt > totalAmount ? paidForReceipt - totalAmount : 0;
        const orderDiscount = Number(order?.discountAmount || 0) + cashierDiscount;
        await printRestaurantSettlementReceipt(
          buildReceiptDataFromCheckout({
            saleNumber: saleNum || order?.orderNumber || '',
            saleDate: new Date().toISOString(),
            subtotal: Number(order?.subtotal || totalAmount),
            discountAmount: orderDiscount > 0 ? orderDiscount : undefined,
            taxAmount: Number(order?.taxAmount || 0),
            totalAmount,
            cashierName: user?.fullName || user?.email || undefined,
            customer: selectedCustomer
              ? {
                  name: selectedCustomer.name,
                  phone: selectedCustomer.phone,
                  email: selectedCustomer.email,
                }
              : order?.customerName
                ? { name: order.customerName }
                : undefined,
            paymentMethod: paymentLines[0]?.paymentMethod || paymentMethod,
            amountPaid: paidForReceipt > 0 ? paidForReceipt : totalAmount,
            changeGiven: changeForReceipt > 0 ? changeForReceipt : undefined,
            items: (order?.items || []).map((it) => ({
              name: it.productName,
              quantity: Number(it.quantity),
              unitPrice: Number(it.unitPrice),
              subtotal: Number(it.lineTotal),
              discountAmount: Number(it.discountAmount || 0) || undefined,
            })),
            payments: paymentLines.map((l) => ({
              method: l.paymentMethod,
              amount: l.amount,
              reference: l.reference,
            })),
            invoiceSettings,
          }),
          // Restaurant: guest-bill printer first (bills already work there).
          { preferSettingsPrinter: returnToPath !== '/restaurant' },
        );
      } catch (printErr) {
        console.error('Receipt print after order complete failed:', printErr);
        toast.error('Sale completed — receipt print failed. Reprint from Sales if needed.');
      }

      navigate(returnToPath);
    },
    onError: (err: Error & { response?: { data?: { error?: string; error_code?: string; code?: string } } }) => {
      const body = err.response?.data;
      const code = body?.error_code || body?.code;
      const msg = body?.error || err.message || 'Payment failed';
      toast.error(code ? `${msg} (${code})` : msg);
    },
  });
  const handleSubmitPayment = () => {
    if (!canCompleteSale || isSubmitting) return;
    // Same gate as Direct Sale POS — session policy requires an open register
    if (sessionEnforced && (isSessionError || !hasOpenRegister)) {
      toast.error(
        isSessionError
          ? 'Could not verify cash register session. Sale was not posted.'
          : 'Please open a cash register before completing this order'
      );
      if (!isSessionError) setShowOpenRegisterDialog(true);
      return;
    }
    setIsSubmitting(true);
    completeMutation.mutate(undefined, {
      onSettled: () => setIsSubmitting(false),
    });
  };

  const methodLabel = (m: string) => {
    const labels: Record<string, string> = {
      CASH: '💵 Cash', CARD: '💳 Card', MOBILE_MONEY: '📱 MTN MoMo',
      AIRTEL_MONEY: '📱 Airtel', DEPOSIT: '🏦 Deposit', CREDIT: '📝 Credit',
      BANK_TRANSFER: '🏦 Transfer',
    };
    return labels[m] || m;
  };

  // Payment method options — DEPOSIT and CREDIT only available with customer
  const allPaymentMethods: { value: PaymentMethod; label: string; icon: string; requiresCustomer: boolean }[] = [
    { value: 'CASH', label: 'Cash', icon: '💵', requiresCustomer: false },
    { value: 'CARD', label: 'Card', icon: '💳', requiresCustomer: false },
    { value: 'MOBILE_MONEY', label: 'MTN MoMo', icon: '📱', requiresCustomer: false },
    { value: 'AIRTEL_MONEY', label: 'Airtel Money', icon: '📱', requiresCustomer: false },
    { value: 'DEPOSIT', label: 'Deposit', icon: '🏦', requiresCustomer: true },
    { value: 'CREDIT', label: 'Credit', icon: '📝', requiresCustomer: true },
  ];

  const paymentMethods = allPaymentMethods.filter(
    (m) => !m.requiresCustomer || selectedCustomer
  );

  useSubmitOnEnter(true, canCompleteSale && !isSubmitting, handleSubmitPayment);

  if (isLoading) {
    return (
      <Layout>
        <div className="flex justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
        </div>
      </Layout>
    );
  }

  if (error || !order) {
    return (
      <Layout>
        <div className="max-w-2xl mx-auto py-12 text-center">
          <div className="text-5xl mb-4">⚠️</div>
          <h2 className="text-xl font-bold text-gray-900 mb-2">Order Not Found</h2>
          <p className="text-gray-500 mb-4">This order may have been completed or cancelled.</p>
          <button onClick={() => navigate(returnToPath)} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm">
            {returnToLabel}
          </button>
        </div>
      </Layout>
    );
  }

  if (order.status !== 'PENDING') {
    return (
      <Layout>
        <div className="max-w-2xl mx-auto py-12 text-center">
          <div className="text-5xl mb-4">{order.status === 'COMPLETED' ? '✅' : '❌'}</div>
          <h2 className="text-xl font-bold text-gray-900 mb-2">Order {order.orderNumber}</h2>
          <p className="text-gray-500 mb-4">This order is already {order.status.toLowerCase()}.</p>
          <button onClick={() => navigate(returnToPath)} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm">
            {returnToLabel}
          </button>
        </div>
      </Layout>
    );
  }

  if (!canSettleThisOrder) {
    return (
      <Layout>
        <div className="max-w-2xl mx-auto py-12 text-center">
          <div className="text-5xl mb-4">🔒</div>
          <h2 className="text-xl font-bold text-gray-900 mb-2">Payment not allowed</h2>
          <p className="text-gray-500 mb-4">
            {returnToPath === '/restaurant'
              ? 'Restaurant settlement requires the restaurant.pay permission (cashier, accountant, or admin).'
              : 'Completing this order requires the orders.pay permission.'}
          </p>
          <button onClick={() => navigate(returnToPath)} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm">
            {returnToLabel}
          </button>
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="max-w-5xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <button onClick={() => navigate(returnToPath)} className="text-sm text-blue-600 hover:text-blue-800 mb-2 flex items-center gap-1">
              ← {returnToLabel}
            </button>
            <h1 className="text-2xl font-bold text-gray-900">Complete Order {order.orderNumber}</h1>
            <p className="text-sm text-gray-500 mt-1">
              Created by {order.createdByName || 'Unknown'} • {order.orderDate}
              {order.customerName && ` • Customer: ${order.customerName}`}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
          {/* Left: Order Items (read-only) */}
          <div className="lg:col-span-3">
            {atCostPreview?.hasDrift && (
              <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                <p className="font-medium">AT_COST — prices updated to current FEFO stock</p>
                <p className="mt-1 text-xs text-amber-800">
                  Order was priced from an earlier snapshot. Totals below match what will post at completion.
                </p>
              </div>
            )}
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm">
              <div className="px-5 py-4 border-b border-gray-100">
                <h2 className="text-lg font-semibold text-gray-900">Order Items</h2>
                <p className="text-xs text-gray-500">{order.items.length} item{order.items.length !== 1 ? 's' : ''}</p>
              </div>
              <div className="divide-y divide-gray-100">
                {order.items.map((item) => {
                  const qty = parseFloat(item.quantity);
                  const atCostLine = atCostLineByKey.get(`${item.productId}:${qty}`);
                  const displayUnitPrice =
                    atCostLine?.priceDrift ? atCostLine.fefoUnitPrice : parseFloat(item.unitPrice);
                  const displayLineTotal = atCostLine?.priceDrift
                    ? qty * atCostLine.fefoUnitPrice - parseFloat(item.discountAmount || '0')
                    : parseFloat(item.lineTotal);

                  return (
                  <div key={item.id} className="px-5 py-3 flex items-center justify-between">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">{item.productName}</p>
                      <p className="text-xs text-gray-500">
                        {qty} × {formatCurrency(displayUnitPrice)}
                      </p>
                      {atCostLine?.priceDrift && (
                        <p className="text-xs text-amber-700 mt-0.5">
                          Order {formatCurrency(atCostLine.orderUnitPrice)} → FEFO{' '}
                          {formatCurrency(atCostLine.fefoUnitPrice)}
                        </p>
                      )}
                    </div>
                    <span className="text-sm font-semibold text-gray-900 ml-3">
                      {formatCurrency(displayLineTotal)}
                    </span>
                  </div>
                  );
                })}
              </div>

              {/* Totals */}
              <div className="px-5 py-4 bg-gray-50 border-t border-gray-100 space-y-2">
                {parseFloat(order.discountAmount) > 0 && (
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-500">Discount</span>
                    <span className="text-red-600">-{formatCurrency(parseFloat(order.discountAmount))}</span>
                  </div>
                )}
                {parseFloat(order.taxAmount) > 0 && (
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-500">Tax</span>
                    <span className="text-gray-700">{formatCurrency(parseFloat(order.taxAmount))}</span>
                  </div>
                )}
                <div className="flex justify-between text-lg font-bold border-t border-gray-200 pt-2">
                  <span>Total</span>
                  <span>{formatCurrency(totalAmount)}</span>
                </div>
              </div>

              {/* Notes */}
              {order.notes && (
                <div className="px-5 py-3 bg-amber-50 border-t border-amber-100">
                  <p className="text-xs text-amber-700"><strong>Note:</strong> {order.notes}</p>
                </div>
              )}
            </div>
          </div>

          {/* Right: Payment Panel */}
          <div className="lg:col-span-2">
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm sticky top-4">
              <div className="px-5 py-4 border-b border-gray-100">
                <h2 className="text-lg font-semibold text-gray-900">Payment</h2>
              </div>
              <div className="px-5 py-4 space-y-5">
                {/* Customer Selection */}
                <CustomerSelector
                  selectedCustomer={selectedCustomer}
                  onSelectCustomer={(c) => {
                    setSelectedCustomer(c);
                    // Remove DEPOSIT/CREDIT lines if customer removed
                    if (!c) {
                      setPaymentLines(paymentLines.filter(
                        (l) => l.paymentMethod !== 'DEPOSIT' && l.paymentMethod !== 'CREDIT'
                      ));
                      if (paymentMethod === 'DEPOSIT' || paymentMethod === 'CREDIT') {
                        setPaymentMethod('CASH');
                      }
                    }
                  }}
                  saleTotal={totalAmount}
                />

                {/* Payment Method Selector */}
                <div>
                  <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
                    Payment Method
                  </label>

                  {/* Cashier Discount */}
                  <div className="mb-3">
                    {cashierDiscount > 0 ? (
                      <div className="flex items-center justify-between bg-green-50 border border-green-200 rounded-lg px-3 py-2">
                        <span className="text-sm text-green-700 font-medium">
                          🏷️ Discount: -{formatCurrency(cashierDiscount)}
                        </span>
                        <button
                          onClick={() => { setCashierDiscount(0); setDiscountInput(''); setShowDiscountInput(false); }}
                          className="text-red-500 hover:text-red-700 text-xs font-bold ml-2"
                          title="Remove discount"
                        >
                          ✕
                        </button>
                      </div>
                    ) : showDiscountInput ? (
                      <div className="flex gap-2 items-center">
                        <input
                          type="number"
                          value={discountInput}
                          onChange={(e) => setDiscountInput(e.target.value)}
                          placeholder="Discount amount"
                          className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                          min={0}
                          autoFocus
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              const v = parseFloat(discountInput);
                              if (!isNaN(v) && v > 0) { setCashierDiscount(v); setShowDiscountInput(false); }
                            }
                            if (e.key === 'Escape') { setShowDiscountInput(false); setDiscountInput(''); }
                          }}
                        />
                        <button
                          onClick={() => {
                            const v = parseFloat(discountInput);
                            if (!isNaN(v) && v > 0) { setCashierDiscount(v); setShowDiscountInput(false); }
                          }}
                          className="px-3 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700"
                        >
                          Apply
                        </button>
                        <button
                          onClick={() => { setShowDiscountInput(false); setDiscountInput(''); }}
                          className="px-3 py-2 bg-gray-100 text-gray-600 rounded-lg text-sm hover:bg-gray-200"
                        >
                          ✕
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setShowDiscountInput(true)}
                        className="w-full py-2 text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-lg hover:bg-amber-100 transition-colors"
                      >
                        🏷️ Add Discount
                      </button>
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    {paymentMethods.map((method) => (
                      <button
                        key={method.value}
                        onClick={() => setPaymentMethod(method.value)}
                        className={`px-3 py-2.5 rounded-lg text-sm font-medium border transition-colors flex items-center gap-2 ${paymentMethod === method.value
                          ? 'border-blue-500 bg-blue-50 text-blue-700'
                          : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50'
                          }`}
                      >
                        <span>{method.icon}</span>
                        {method.label}
                      </button>
                    ))}
                  </div>
                  {!selectedCustomer && (
                    <p className="mt-2 text-xs text-gray-400">
                      Select a customer to enable Deposit & Credit options
                    </p>
                  )}
                </div>

                {/* Deposit Balance Info */}
                {paymentMethod === 'DEPOSIT' && selectedCustomer && (
                  <div className={`rounded-lg p-3 text-sm ${(depositBalance - depositAlreadyApplied) > 0 ? 'bg-green-50 border border-green-200' : 'bg-red-50 border border-red-200'}`}>
                    <div className="flex justify-between">
                      <span className="font-medium">Deposit Balance:</span>
                      <span className="font-semibold">{formatCurrency(depositBalance)}</span>
                    </div>
                    {depositAlreadyApplied > 0 && (
                      <div className="flex justify-between text-xs mt-1">
                        <span>Already applied:</span>
                        <span className="text-orange-600">-{formatCurrency(depositAlreadyApplied)}</span>
                      </div>
                    )}
                    <div className="flex justify-between text-xs mt-1 pt-1 border-t border-gray-200">
                      <span>Available:</span>
                      <span className={(depositBalance - depositAlreadyApplied) > 0 ? 'text-green-700 font-semibold' : 'text-red-700 font-semibold'}>
                        {formatCurrency(depositBalance - depositAlreadyApplied)}
                      </span>
                    </div>
                  </div>
                )}

                {/* Amount Input */}
                {remainingBalance > 0.01 && (
                  <div>
                    <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
                      Amount
                    </label>
                    <div className="flex gap-2">
                      <div className="flex-1 relative">
                        <input
                          type="number"
                          value={paymentAmount}
                          onChange={(e) => setPaymentAmount(e.target.value)}
                          placeholder="0"
                          className="w-full border border-gray-300 rounded-lg px-4 py-3 text-lg font-semibold text-right focus:outline-none focus:ring-2 focus:ring-blue-500"
                          min={0}
                          step="any"
                          autoFocus
                        />
                      </div>
                      <button
                        onClick={handleQuickFill}
                        className="px-3 py-2 text-xs font-medium text-blue-600 bg-blue-50 rounded-lg hover:bg-blue-100 transition-colors border border-blue-200 whitespace-nowrap"
                        title="Fill remaining balance"
                      >
                        Fill
                      </button>
                    </div>
                    {/* Quick denomination buttons */}
                    {paymentMethod === 'CASH' && (
                      <div className="flex gap-1 mt-2 flex-wrap">
                        {[1000, 2000, 5000, 10000, 20000, 50000].map((val) => (
                          <button
                            key={val}
                            onClick={() => setPaymentAmount((parseFloat(paymentAmount || '0') + val).toString())}
                            className="px-2 py-1 text-xs bg-gray-100 rounded hover:bg-gray-200 transition-colors"
                          >
                            +{(val / 1000).toFixed(0)}k
                          </button>
                        ))}
                      </div>
                    )}

                    {/* Reference input for Card / Mobile Money */}
                    {(paymentMethod === 'CARD' || paymentMethod === 'MOBILE_MONEY' || paymentMethod === 'AIRTEL_MONEY') && (
                      <input
                        type="text"
                        value={paymentReference}
                        onChange={(e) => setPaymentReference(e.target.value)}
                        placeholder="Reference / Transaction ID"
                        className="w-full mt-2 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    )}

                    {/* Add Payment button */}
                    <button
                      onClick={handleAddPayment}
                      className="w-full mt-3 py-2.5 bg-blue-600 text-white rounded-lg text-sm font-semibold hover:bg-blue-700 transition-colors"
                    >
                      Add {methodLabel(paymentMethod).split(' ').slice(1).join(' ')} Payment
                    </button>
                  </div>
                )}

                {/* Payment Lines List */}
                {paymentLines.length > 0 && (
                  <div>
                    <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
                      Payments
                    </label>
                    <div className="space-y-1.5">
                      {paymentLines.map((line) => (
                        <div key={line.id} className="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2">
                          <div className="flex-1 min-w-0">
                            <span className="text-sm font-medium">{methodLabel(line.paymentMethod)}</span>
                            {line.reference && (
                              <span className="text-xs text-gray-400 ml-2">({line.reference})</span>
                            )}
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-semibold text-green-700">{formatCurrency(line.amount)}</span>
                            <button
                              onClick={() => handleRemovePaymentLine(line.id)}
                              className="text-red-400 hover:text-red-600 text-xs font-bold"
                              title="Remove"
                            >
                              ✕
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Running Totals */}
                <div className="bg-gray-50 rounded-lg p-4 space-y-2">
                  {(parseFloat(order?.discountAmount ?? '0') > 0 || cashierDiscount > 0) && (
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-500">Subtotal</span>
                      <span className="font-medium">{formatCurrency(parseFloat(order?.subtotal ?? '0'))}</span>
                    </div>
                  )}
                  {parseFloat(order?.discountAmount ?? '0') > 0 && (
                    <div className="flex justify-between text-sm text-green-700">
                      <span>Discount (order)</span>
                      <span>-{formatCurrency(parseFloat(order!.discountAmount))}</span>
                    </div>
                  )}
                  {cashierDiscount > 0 && (
                    <div className="flex justify-between text-sm text-green-700">
                      <span>Discount (cashier)</span>
                      <span>-{formatCurrency(cashierDiscount)}</span>
                    </div>
                  )}
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-600">Sale Total</span>
                    <span className="font-semibold">{formatCurrency(totalAmount)}</span>
                  </div>
                  {totalPaid > 0 && (
                    <div className="flex justify-between text-sm">
                      <span className="text-green-600">Paid</span>
                      <span className="font-semibold text-green-700">{formatCurrency(totalPaid)}</span>
                    </div>
                  )}
                  {remainingBalance > 0.01 && (
                    <div className="flex justify-between text-sm border-t border-gray-200 pt-2">
                      <span className="text-red-600 font-medium">Remaining</span>
                      <span className="font-bold text-red-700">{formatCurrency(remainingBalance)}</span>
                    </div>
                  )}
                  {changeAmount > 0 && (
                    <div className="flex justify-between text-sm border-t border-gray-200 pt-2">
                      <span className="text-blue-600 font-medium">Change Due</span>
                      <span className="font-bold text-blue-700 animate-pulse">{formatCurrency(changeAmount)}</span>
                    </div>
                  )}
                  {Math.abs(remainingBalance) < 0.01 && paymentLines.length > 0 && (
                    <div className="text-center text-xs text-green-600 font-semibold border-t border-gray-200 pt-2">
                      ✓ Exact Payment
                    </div>
                  )}
                </div>

                {/* Invoice indicator */}
                {remainingBalance > 0.01 && selectedCustomer && paymentLines.length > 0 && (
                  <div className="bg-orange-50 border border-orange-200 rounded-lg p-3 text-xs text-orange-700">
                    <strong>Invoice will be created</strong> — remaining {formatCurrency(remainingBalance)} will be added as credit on customer&apos;s account.
                  </div>
                )}

                {sessionEnforced && !isLoadingSession && (isSessionError || !hasOpenRegister) && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 space-y-2">
                    {isSessionError ? (
                      <>
                        <p className="font-medium">Could not verify register session</p>
                        <p className="text-xs text-amber-800">
                          Sales are blocked until the cash register session can be confirmed. The sale was not posted.
                        </p>
                        <button
                          type="button"
                          onClick={() => { void refetchSession(); }}
                          className="w-full py-2 bg-amber-600 text-white rounded-lg text-sm font-semibold hover:bg-amber-700"
                        >
                          Retry
                        </button>
                      </>
                    ) : (
                      <>
                        <p className="font-medium">{sessionPolicyDef.cashierPromptTitle}</p>
                        <p className="text-xs text-amber-800">
                          {sessionPolicyDef.cashierPromptBody}
                        </p>
                        <button
                          type="button"
                          onClick={() => setShowOpenRegisterDialog(true)}
                          className="w-full py-2 bg-amber-600 text-white rounded-lg text-sm font-semibold hover:bg-amber-700"
                        >
                          {sessionPolicyDef.cashierPromptAction}
                        </button>
                      </>
                    )}
                  </div>
                )}

                {/* Complete Sale Button */}
                <button
                  onClick={handleSubmitPayment}
                  disabled={
                    !canCompleteSale ||
                    isSubmitting ||
                    (sessionEnforced && (isSessionError || !hasOpenRegister))
                  }
                  className="w-full py-4 bg-green-600 text-white rounded-xl text-lg font-bold hover:bg-green-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isSubmitting ? 'Processing...' : (
                    remainingBalance > 0.01 && selectedCustomer
                      ? `Complete Sale & Invoice — ${formatCurrency(totalAmount)}`
                      : `Complete Sale — ${formatCurrency(totalAmount)}`
                  )}
                </button>

                {paymentLines.length === 0 && (
                  <p className="text-xs text-gray-400 text-center">
                    Add at least one payment to complete the sale
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      <OpenRegisterDialog
        open={showOpenRegisterDialog}
        onOpenChange={setShowOpenRegisterDialog}
        onSuccess={() => setShowOpenRegisterDialog(false)}
      />
    </Layout>
  );
}
