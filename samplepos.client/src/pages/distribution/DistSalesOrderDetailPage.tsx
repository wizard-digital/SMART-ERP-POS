/**
 * Unified Sales Order Hub
 *
 * Single-page lifecycle management:
 *   Order Lines → Create Delivery → Invoices → Payment
 * No need to navigate to separate pages.
 */
import { useState, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import Layout from '../../components/Layout';
import distributionApi, {
  type SalesOrderLine,
  type Delivery,
  type DistInvoice,
  type DepositInfo,
} from '../../api/distribution';
import { formatCurrency } from '../../utils/currency';
import { computeInvoiceTender } from '../../utils/invoiceTenderChange';

type TabKey = 'lines' | 'deliveries' | 'invoices' | 'payment';

const STATUS_COLORS: Record<string, string> = {
  OPEN: 'bg-blue-100 text-blue-800',
  PARTIALLY_DELIVERED: 'bg-yellow-100 text-yellow-800',
  FULLY_DELIVERED: 'bg-green-100 text-green-800',
  CLOSED: 'bg-gray-100 text-gray-600',
  CANCELLED: 'bg-red-100 text-red-800',
  PAID: 'bg-green-100 text-green-800',
  PARTIALLY_PAID: 'bg-yellow-100 text-yellow-800',
  UNPAID: 'bg-red-100 text-red-800',
  OVERDUE: 'bg-red-200 text-red-900',
};

export default function DistSalesOrderDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<TabKey>('lines');

  // ─── Core Order Query ─────────────────────────
  const { data, isLoading } = useQuery({
    queryKey: ['dist-sales-order', id],
    queryFn: () => distributionApi.getSalesOrder(id!),
    enabled: !!id,
  });
  const order = data?.order;
  const lines = data?.lines ?? [];

  // ─── Deliveries Query ─────────────────────────
  const { data: deliveriesData } = useQuery({
    queryKey: ['dist-deliveries', id],
    queryFn: () => distributionApi.listDeliveries({ salesOrderId: id!, limit: 50 }),
    enabled: !!id,
  });
  const deliveries = deliveriesData?.data ?? [];

  // ─── Invoices Query ───────────────────────────
  const { data: invoicesData } = useQuery({
    queryKey: ['dist-invoices', id],
    queryFn: () => distributionApi.listInvoices({ salesOrderId: id!, limit: 50 }),
    enabled: !!id,
  });
  const invoices = invoicesData?.data ?? [];

  // ─── Clearing Query (lazy — only when payment tab active) ──
  const { data: clearingData } = useQuery({
    queryKey: ['dist-clearing', order?.customerId],
    queryFn: () => distributionApi.getClearingScreen(order!.customerId),
    enabled: !!order?.customerId && activeTab === 'payment',
  });

  // ─── Delivery State ───────────────────────────
  const [showDelivery, setShowDelivery] = useState(false);
  const [deliveryQtys, setDeliveryQtys] = useState<Record<string, number>>({});
  const [deliveryNotes, setDeliveryNotes] = useState('');

  const openLines = lines.filter(l => (l.confirmedQty - l.deliveredQty) > 0);
  const backorderLines = lines.filter(l => l.orderedQty > l.confirmedQty + 0.0001);
  const blockedByBackorder = openLines.length === 0 && backorderLines.length > 0;

  const initDelivery = useCallback(() => {
    const qtys: Record<string, number> = {};
    openLines.forEach(l => { qtys[l.id] = l.confirmedQty - l.deliveredQty; });
    setDeliveryQtys(qtys);
    setDeliveryNotes('');
    setShowDelivery(true);
    setActiveTab('lines');
  }, [openLines]);

  const invalidateAll = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['dist-sales-order', id] });
    queryClient.invalidateQueries({ queryKey: ['dist-deliveries', id] });
    queryClient.invalidateQueries({ queryKey: ['dist-invoices', id] });
    queryClient.invalidateQueries({ queryKey: ['dist-sales-orders'] });
  }, [queryClient, id]);

  const reconfirmMutation = useMutation({
    mutationFn: () => distributionApi.reconfirmSalesOrder(id!),
    onSuccess: (result) => {
      const deliverable = result.lines.reduce(
        (sum, l) => sum + Math.max(0, l.confirmedQty - l.deliveredQty),
        0,
      );
      if (deliverable > 0) {
        toast.success(`Stock confirmed for delivery (${deliverable} unit(s)). Create Delivery is available.`);
      } else {
        toast.error(
          'No sellable stock at the shop/outlet issue store. Receive or transfer stock there, then refresh.',
        );
      }
      queryClient.setQueryData(['dist-sales-order', id], {
        order: result.order,
        lines: result.lines,
      });
      invalidateAll();
    },
    onError: (err: { response?: { data?: { error?: string } } }) => {
      toast.error(err.response?.data?.error ?? 'Failed to refresh confirmation');
    },
  });

  const deliveryMutation = useMutation({
    mutationFn: () =>
      distributionApi.createDelivery({
        salesOrderId: id!,
        notes: deliveryNotes || undefined,
        lines: Object.entries(deliveryQtys)
          .filter(([, qty]) => qty > 0)
          .map(([salesOrderLineId, quantity]) => ({ salesOrderLineId, quantity })),
      }),
    onSuccess: (result) => {
      toast.success(`Delivery ${result.delivery.deliveryNumber} + Invoice ${result.invoice.invoiceNumber} created`);
      invalidateAll();
      setShowDelivery(false);
      setActiveTab('deliveries');
    },
    onError: (err: { response?: { data?: { error?: string } } }) => {
      toast.error(err.response?.data?.error ?? 'Failed to create delivery');
    },
  });

  // ─── Payment State ────────────────────────────
  const [selectedInvoiceId, setSelectedInvoiceId] = useState('');
  const [depositAllocations, setDepositAllocations] = useState<Record<string, number>>({});
  const [cashAmount, setCashAmount] = useState(0);
  const [paymentMethod, setPaymentMethod] = useState<'CASH' | 'CARD' | 'MOBILE_MONEY' | 'BANK_TRANSFER'>('CASH');
  const [paymentRef, setPaymentRef] = useState('');
  const [paymentNotes, setPaymentNotes] = useState('');

  const clearingMutation = useMutation({
    mutationFn: () => {
      const allocations = Object.entries(depositAllocations)
        .filter(([, amount]) => amount > 0)
        .map(([depositId, amount]) => ({ depositId, amount }));
      return distributionApi.processClearing({
        customerId: order!.customerId,
        invoiceId: selectedInvoiceId,
        depositAllocations: allocations,
        cashPayment: cashAmount > 0 ? { amount: cashAmount, paymentMethod, referenceNumber: paymentRef || undefined } : undefined,
        notes: paymentNotes || undefined,
      });
    },
    onSuccess: (result) => {
      const change = Number(result.changeGiven ?? 0);
      if (change > 0.009) {
        toast.success(
          `Took ${formatCurrency(result.totalCleared)} · Change ${formatCurrency(change)}`,
        );
      } else {
        toast.success(`Payment posted — ${formatCurrency(result.totalCleared)} cleared`);
      }
      invalidateAll();
      queryClient.invalidateQueries({ queryKey: ['dist-clearing', order?.customerId] });
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      setSelectedInvoiceId('');
      setDepositAllocations({});
      setCashAmount(0);
      setPaymentRef('');
      setPaymentNotes('');
    },
    onError: (err: { response?: { data?: { error?: string } } }) => {
      toast.error(err.response?.data?.error ?? 'Payment failed');
    },
  });

  // ─── Computed ─────────────────────────────────
  const openInvoices = invoices.filter(inv => inv.amountDue > 0);
  const totalPaid = invoices.reduce((s, inv) => s + inv.amountPaid, 0);
  const totalDue = invoices.reduce((s, inv) => s + inv.amountDue, 0);
  const selectedInvoice = openInvoices.find((inv) => inv.id === selectedInvoiceId);
  const depositRequested = useMemo(
    () => Object.values(depositAllocations).reduce((s, a) => s + (Number(a) || 0), 0),
    [depositAllocations],
  );
  const tenderPreview = useMemo(
    () =>
      computeInvoiceTender({
        invoiceDue: selectedInvoice?.amountDue ?? 0,
        depositRequested,
        cashTendered: cashAmount,
        paymentMethod,
      }),
    [selectedInvoice?.amountDue, depositRequested, cashAmount, paymentMethod],
  );

  const steps = [
    { label: 'Order', done: true },
    { label: 'Delivery', done: deliveries.length > 0 },
    { label: 'Invoice', done: invoices.length > 0 },
    { label: 'Paid', done: totalDue === 0 && invoices.length > 0 },
  ];

  const tabs: { key: TabKey; label: string; badge?: number | string }[] = [
    { key: 'lines', label: 'Order Lines', badge: lines.length },
    { key: 'deliveries', label: 'Deliveries', badge: deliveries.length },
    { key: 'invoices', label: 'Invoices', badge: invoices.length },
    { key: 'payment', label: 'Payment', badge: openInvoices.length > 0 ? `${openInvoices.length} due` : undefined },
  ];

  if (isLoading || !order) {
    return <Layout><div className="p-6 text-gray-400">Loading…</div></Layout>;
  }

  return (
    <Layout>
      <div className="p-4 lg:p-6 space-y-4 max-w-6xl">
        {/* ─── Header ──────────────────────────── */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <button onClick={() => navigate('/distribution/sales-orders')} className="text-sm text-blue-600 hover:underline mb-1">
              ← Back to Orders
            </button>
            <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-3">
              {order.orderNumber}
              <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[order.status] ?? 'bg-gray-100'}`}>
                {order.status.replace(/_/g, ' ')}
              </span>
            </h1>
          </div>
          <div className="flex flex-wrap gap-2">
            {['OPEN', 'PARTIALLY_DELIVERED'].includes(order.status) && (
              <button onClick={() => navigate(`/distribution/sales-orders/${id}/edit`)} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700">
                ✎ Edit Order
              </button>
            )}
            {backorderLines.length > 0 && ['OPEN', 'PARTIALLY_DELIVERED'].includes(order.status) && (
              <button
                type="button"
                onClick={() => reconfirmMutation.mutate()}
                disabled={reconfirmMutation.isPending}
                className="px-4 py-2 bg-amber-600 text-white rounded-lg text-sm font-medium hover:bg-amber-700 disabled:opacity-50"
              >
                {reconfirmMutation.isPending ? 'Checking stock…' : '↻ Refresh confirmation'}
              </button>
            )}
            {openLines.length > 0 && !showDelivery && (
              <button onClick={initDelivery} className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700">
                + Create Delivery
              </button>
            )}
          </div>
        </div>

        {blockedByBackorder && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <p className="font-semibold">Cannot Create Delivery yet — nothing is confirmed from stock</p>
            <p className="mt-1">
              Confirmed qty comes from inventory ATP (active batches minus qty already reserved on open sales orders).
              Both lines on this order are full backorders because there is no free stock.
            </p>
            <ol className="mt-2 list-decimal list-inside space-y-0.5 text-amber-800">
              <li>Receive stock via Inventory / Goods Receipt (GRN) for these products.</li>
              <li>Click <strong>Refresh confirmation</strong> so ATP can raise Confirmed qty.</li>
              <li>Then <strong>Create Delivery</strong> posts delivery + customer invoice (AR).</li>
            </ol>
          </div>
        )}

        {/* ─── Summary Cards ───────────────────── */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          <div className="bg-white border rounded-lg p-3">
            <p className="text-xs text-gray-500">Customer</p>
            <p className="font-medium text-sm truncate">{order.customerName}</p>
          </div>
          <div className="bg-white border rounded-lg p-3">
            <p className="text-xs text-gray-500">Order Date</p>
            <p className="text-sm">{order.orderDate}</p>
          </div>
          <div className="bg-white border rounded-lg p-3">
            <p className="text-xs text-gray-500">Order Total</p>
            <p className="font-bold text-sm">{formatCurrency(order.totalAmount)}</p>
            <p className="text-[10px] text-gray-400 mt-0.5">Ordered × price</p>
          </div>
          <div className="bg-white border rounded-lg p-3">
            <p className="text-xs text-gray-500">Confirmed Value</p>
            <p className="font-bold text-sm">{formatCurrency(order.totalConfirmed)}</p>
            <p className="text-[10px] text-gray-400 mt-0.5">ATP reserved</p>
          </div>
          <div className="bg-white border rounded-lg p-3">
            <p className="text-xs text-gray-500">Invoice Due</p>
            <p className={`font-bold text-sm ${totalDue > 0 ? 'text-red-600' : 'text-green-600'}`}>
              {formatCurrency(totalDue)}
            </p>
            <p className="text-[10px] text-gray-400 mt-0.5">
              {invoices.length === 0 ? 'No invoices yet' : 'Open AR on invoices'}
            </p>
          </div>
        </div>

        {/* ─── Document Flow Progress ──────────── */}
        <div className="bg-white border rounded-lg p-4">
          <div className="flex items-center justify-between">
            {steps.map((step, i) => (
              <div key={step.label} className="flex items-center flex-1">
                <div className="flex flex-col items-center">
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold
                    ${step.done ? 'bg-green-500 text-white' : 'bg-gray-200 text-gray-500'}`}>
                    {step.done ? '✓' : i + 1}
                  </div>
                  <span className="text-xs mt-1 text-gray-600">{step.label}</span>
                </div>
                {i < steps.length - 1 && (
                  <div className={`flex-1 h-0.5 mx-2 ${step.done ? 'bg-green-400' : 'bg-gray-200'}`} />
                )}
              </div>
            ))}
          </div>
        </div>

        {/* ─── Tab Navigation ──────────────────── */}
        <div className="border-b">
          <nav className="flex -mb-px overflow-x-auto">
            {tabs.map(tab => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 transition-colors
                  ${activeTab === tab.key
                    ? 'border-blue-600 text-blue-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'}`}
              >
                {tab.label}
                {tab.badge !== undefined && (
                  <span className={`ml-1.5 px-1.5 py-0.5 rounded-full text-xs
                    ${activeTab === tab.key ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'}`}>
                    {tab.badge}
                  </span>
                )}
              </button>
            ))}
          </nav>
        </div>

        {/* ═══════════════════════════════════════ */}
        {/* ORDER LINES TAB                        */}
        {/* ═══════════════════════════════════════ */}
        {activeTab === 'lines' && (
          <div className="space-y-4">
            {/* Desktop table */}
            <div className="bg-white border rounded-lg overflow-hidden">
              <div className="hidden md:block overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="bg-gray-50 border-b text-xs text-gray-500">
                    <tr>
                      <th className="px-3 py-2 text-left">Product</th>
                      <th className="px-3 py-2 text-right">Ordered</th>
                      <th className="px-3 py-2 text-right">Confirmed</th>
                      <th className="px-3 py-2 text-right">Delivered</th>
                      <th className="px-3 py-2 text-right">Open</th>
                      <th className="px-3 py-2 text-right">Unit Price</th>
                      <th className="px-3 py-2 text-right">Line Total</th>
                      {showDelivery && <th className="px-3 py-2 text-right">Deliver Qty</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {lines.map((line: SalesOrderLine) => {
                      const deliverable = line.confirmedQty - line.deliveredQty;
                      return (
                        <tr key={line.id} className={line.openQty > 0 ? '' : 'bg-gray-50 text-gray-500'}>
                          <td className="px-3 py-2">
                            <p className="font-medium">{line.productName}</p>
                            <p className="text-xs text-gray-400">{line.sku}</p>
                          </td>
                          <td className="px-3 py-2 text-right">{line.orderedQty}</td>
                          <td className="px-3 py-2 text-right">
                            {line.confirmedQty}
                            {line.confirmedQty < line.orderedQty && (
                              <span className="text-amber-600 text-xs ml-1">(backorder)</span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right">{line.deliveredQty}</td>
                          <td className="px-3 py-2 text-right font-medium">{line.openQty}</td>
                          <td className="px-3 py-2 text-right">{formatCurrency(line.unitPrice)}</td>
                          <td className="px-3 py-2 text-right font-medium">{formatCurrency(line.lineTotal)}</td>
                          {showDelivery && (
                            <td className="px-3 py-2 text-right">
                              {deliverable > 0 ? (
                                <input
                                  type="number"
                                  min={0}
                                  max={deliverable}
                                  value={deliveryQtys[line.id] ?? 0}
                                  onChange={e => setDeliveryQtys(prev => ({
                                    ...prev,
                                    [line.id]: Math.min(deliverable, Math.max(0, Number(e.target.value))),
                                  }))}
                                  className="w-20 border rounded px-2 py-1 text-sm text-right"
                                />
                              ) : (
                                <span className="text-gray-300">—</span>
                              )}
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Mobile cards */}
              <div className="md:hidden divide-y">
                {lines.map((line: SalesOrderLine) => {
                  const deliverable = line.confirmedQty - line.deliveredQty;
                  return (
                    <div key={line.id} className="p-3 space-y-1">
                      <p className="font-medium text-sm">{line.productName}</p>
                      <div className="grid grid-cols-3 gap-2 text-xs text-gray-500">
                        <span>Ord: {line.orderedQty}</span>
                        <span>Conf: {line.confirmedQty}</span>
                        <span>Del: {line.deliveredQty}</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span>Open: <strong>{line.openQty}</strong></span>
                        <span className="font-medium">{formatCurrency(line.lineTotal)}</span>
                      </div>
                      {showDelivery && deliverable > 0 && (
                        <div className="mt-1">
                          <label className="text-xs text-gray-500">Deliver Qty:</label>
                          <input
                            type="number"
                            min={0}
                            max={deliverable}
                            value={deliveryQtys[line.id] ?? 0}
                            onChange={e => setDeliveryQtys(prev => ({
                              ...prev,
                              [line.id]: Math.min(deliverable, Math.max(0, Number(e.target.value))),
                            }))}
                            className="w-full border rounded px-2 py-1 text-sm mt-0.5"
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Delivery action bar */}
            {showDelivery && (
              <div className="bg-green-50 border border-green-200 rounded-lg p-4 space-y-3">
                <h3 className="text-sm font-semibold text-green-800">Create Delivery + Invoice</h3>
                <p className="text-xs text-green-700">
                  This will deduct stock (FEFO), create a delivery document, and automatically generate an invoice.
                </p>
                <input
                  type="text"
                  placeholder="Delivery notes (optional)"
                  value={deliveryNotes}
                  onChange={e => setDeliveryNotes(e.target.value)}
                  className="w-full border rounded px-3 py-1.5 text-sm"
                />
                <div className="flex gap-2">
                  <button onClick={() => setShowDelivery(false)} className="px-3 py-1.5 border rounded text-sm hover:bg-gray-50">
                    Cancel
                  </button>
                  <button
                    onClick={() => deliveryMutation.mutate()}
                    disabled={deliveryMutation.isPending || Object.values(deliveryQtys).every(q => q <= 0)}
                    className="px-4 py-1.5 bg-green-600 text-white rounded text-sm font-medium hover:bg-green-700 disabled:opacity-40"
                  >
                    {deliveryMutation.isPending ? 'Processing…' : 'Confirm Delivery'}
                  </button>
                </div>
              </div>
            )}

            {order.notes && (
              <div className="text-sm text-gray-500 bg-gray-50 border rounded-lg p-3">
                <span className="font-medium">Notes:</span> {order.notes}
              </div>
            )}
          </div>
        )}

        {/* ═══════════════════════════════════════ */}
        {/* DELIVERIES TAB                         */}
        {/* ═══════════════════════════════════════ */}
        {activeTab === 'deliveries' && (
          <div className="space-y-3">
            {deliveries.length === 0 ? (
              <div className="bg-white border rounded-lg p-8 text-center text-gray-400">
                <p className="text-lg mb-2">No deliveries yet</p>
                <p className="text-sm mb-4">Create a delivery from the Order Lines tab to fulfill open quantities.</p>
                {openLines.length > 0 && (
                  <button onClick={initDelivery} className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700">
                    + Create First Delivery
                  </button>
                )}
              </div>
            ) : (
              <>
                {/* Desktop */}
                <div className="bg-white border rounded-lg overflow-hidden hidden md:block">
                  <table className="min-w-full text-sm">
                    <thead className="bg-gray-50 border-b text-xs text-gray-500">
                      <tr>
                        <th className="px-3 py-2 text-left">Delivery #</th>
                        <th className="px-3 py-2 text-left">Date</th>
                        <th className="px-3 py-2 text-right">Amount</th>
                        <th className="px-3 py-2 text-right">Cost</th>
                        <th className="px-3 py-2 text-center">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {deliveries.map((del: Delivery) => (
                        <tr key={del.id} className="hover:bg-gray-50">
                          <td className="px-3 py-2 font-medium text-blue-600">{del.deliveryNumber}</td>
                          <td className="px-3 py-2 text-gray-600">{del.deliveryDate}</td>
                          <td className="px-3 py-2 text-right font-medium">{formatCurrency(del.totalAmount)}</td>
                          <td className="px-3 py-2 text-right text-gray-500">{formatCurrency(del.totalCost)}</td>
                          <td className="px-3 py-2 text-center">
                            <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[del.status] ?? 'bg-gray-100'}`}>
                              {del.status}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {/* Mobile */}
                <div className="md:hidden space-y-2">
                  {deliveries.map((del: Delivery) => (
                    <div key={del.id} className="bg-white border rounded-lg p-3">
                      <div className="flex justify-between items-center mb-1">
                        <span className="font-medium text-sm text-blue-600">{del.deliveryNumber}</span>
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[del.status] ?? 'bg-gray-100'}`}>
                          {del.status}
                        </span>
                      </div>
                      <div className="flex justify-between text-xs text-gray-500">
                        <span>{del.deliveryDate}</span>
                        <span className="font-medium text-gray-900">{formatCurrency(del.totalAmount)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
            {deliveries.length > 0 && openLines.length > 0 && (
              <button onClick={initDelivery} className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700">
                + Create Another Delivery
              </button>
            )}
          </div>
        )}

        {/* ═══════════════════════════════════════ */}
        {/* INVOICES TAB                           */}
        {/* ═══════════════════════════════════════ */}
        {activeTab === 'invoices' && (
          <div className="space-y-3">
            {/* Summary row */}
            <div className="grid grid-cols-3 gap-3">
              <div className="bg-white border rounded-lg p-3">
                <p className="text-xs text-gray-500">Total Invoiced</p>
                <p className="font-bold text-sm">{formatCurrency(invoices.reduce((s, inv) => s + inv.totalAmount, 0))}</p>
              </div>
              <div className="bg-white border rounded-lg p-3">
                <p className="text-xs text-gray-500">Total Paid</p>
                <p className="font-bold text-sm text-green-600">{formatCurrency(totalPaid)}</p>
              </div>
              <div className="bg-white border rounded-lg p-3">
                <p className="text-xs text-gray-500">Total Due</p>
                <p className={`font-bold text-sm ${totalDue > 0 ? 'text-red-600' : 'text-green-600'}`}>{formatCurrency(totalDue)}</p>
              </div>
            </div>

            {invoices.length === 0 ? (
              <div className="bg-white border rounded-lg p-8 text-center text-gray-400">
                <p className="text-lg mb-2">No invoices yet</p>
                <p className="text-sm">Invoices are created automatically when deliveries are confirmed.</p>
              </div>
            ) : (
              <>
                {/* Desktop */}
                <div className="bg-white border rounded-lg overflow-hidden hidden md:block">
                  <table className="min-w-full text-sm">
                    <thead className="bg-gray-50 border-b text-xs text-gray-500">
                      <tr>
                        <th className="px-3 py-2 text-left">Invoice #</th>
                        <th className="px-3 py-2 text-left">Delivery #</th>
                        <th className="px-3 py-2 text-left">Date</th>
                        <th className="px-3 py-2 text-right">Amount</th>
                        <th className="px-3 py-2 text-right">Paid</th>
                        <th className="px-3 py-2 text-right">Due</th>
                        <th className="px-3 py-2 text-center">Status</th>
                        <th className="px-3 py-2 text-center"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {invoices.map((inv: DistInvoice) => (
                        <tr key={inv.id} className="hover:bg-gray-50">
                          <td className="px-3 py-2 font-medium">{inv.invoiceNumber}</td>
                          <td className="px-3 py-2 text-gray-500">{inv.deliveryNumber}</td>
                          <td className="px-3 py-2 text-gray-600">{inv.issueDate}</td>
                          <td className="px-3 py-2 text-right font-medium">{formatCurrency(inv.totalAmount)}</td>
                          <td className="px-3 py-2 text-right text-green-600">{formatCurrency(inv.amountPaid)}</td>
                          <td className="px-3 py-2 text-right font-medium text-red-600">{inv.amountDue > 0 ? formatCurrency(inv.amountDue) : '—'}</td>
                          <td className="px-3 py-2 text-center">
                            <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[inv.status] ?? 'bg-gray-100'}`}>
                              {inv.status.replace(/_/g, ' ')}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-center">
                            {inv.amountDue > 0 && (
                              <button
                                onClick={() => { setSelectedInvoiceId(inv.id); setActiveTab('payment'); }}
                                className="text-xs font-medium text-blue-600 hover:underline"
                              >
                                Pay →
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {/* Mobile */}
                <div className="md:hidden space-y-2">
                  {invoices.map((inv: DistInvoice) => (
                    <div key={inv.id} className="bg-white border rounded-lg p-3">
                      <div className="flex justify-between items-center mb-1">
                        <span className="font-medium text-sm">{inv.invoiceNumber}</span>
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[inv.status] ?? 'bg-gray-100'}`}>
                          {inv.status.replace(/_/g, ' ')}
                        </span>
                      </div>
                      <div className="flex justify-between text-xs text-gray-500 mb-1">
                        <span>{inv.issueDate}</span>
                        <span>Del: {inv.deliveryNumber}</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-green-600">Paid: {formatCurrency(inv.amountPaid)}</span>
                        <span className="font-bold text-red-600">{inv.amountDue > 0 ? `Due: ${formatCurrency(inv.amountDue)}` : 'Paid'}</span>
                      </div>
                      {inv.amountDue > 0 && (
                        <button
                          onClick={() => { setSelectedInvoiceId(inv.id); setActiveTab('payment'); }}
                          className="mt-2 w-full text-center text-xs font-medium text-blue-600 border border-blue-200 rounded py-1 hover:bg-blue-50"
                        >
                          Process Payment →
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}

            {totalDue > 0 && (
              <button
                onClick={() => setActiveTab('payment')}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700"
              >
                Process Payment
              </button>
            )}
          </div>
        )}

        {/* ═══════════════════════════════════════ */}
        {/* PAYMENT TAB                            */}
        {/* ═══════════════════════════════════════ */}
        {activeTab === 'payment' && (
          <div className="space-y-4">
            {openInvoices.length === 0 ? (
              <div className="bg-green-50 border border-green-200 rounded-lg p-8 text-center">
                <div className="text-4xl mb-2">✓</div>
                <p className="text-lg font-medium text-green-800 mb-1">All Paid</p>
                <p className="text-sm text-green-700">All invoices for this order have been fully paid.</p>
              </div>
            ) : (
              <>
                {/* Select invoice */}
                <div className="bg-white border rounded-lg p-4 space-y-3">
                  <h3 className="text-sm font-semibold text-gray-700">Select Invoice to Pay</h3>
                  <p className="text-xs text-gray-500">
                    Posts through customer invoice AR (same as Customers → Receive Payment). Deposit uses customer deposit balance; cash/card/MoMo/bank use the AR open-item engine.
                  </p>
                  <div className="space-y-2">
                    {openInvoices.map(inv => (
                      <label
                        key={inv.id}
                        className={`flex items-center gap-3 p-3 border rounded-lg cursor-pointer transition
                          ${selectedInvoiceId === inv.id ? 'border-blue-500 bg-blue-50' : 'hover:bg-gray-50'}`}
                      >
                        <input
                          type="radio"
                          name="invoice"
                          checked={selectedInvoiceId === inv.id}
                          onChange={() => setSelectedInvoiceId(inv.id)}
                          className="accent-blue-600"
                        />
                        <div className="flex-1 min-w-0">
                          <span className="font-medium text-sm">{inv.invoiceNumber}</span>
                          <span className="text-xs text-gray-500 ml-2">({inv.deliveryNumber})</span>
                        </div>
                        <span className="text-sm font-bold text-red-600 whitespace-nowrap">{formatCurrency(inv.amountDue)} due</span>
                      </label>
                    ))}
                  </div>
                </div>

                {selectedInvoiceId && (
                  <>
                    {/* Deposit allocations */}
                    {clearingData && clearingData.deposits.filter((d: DepositInfo) => d.remainingAmount > 0).length > 0 && (
                      <div className="bg-white border rounded-lg p-4 space-y-3">
                        <h3 className="text-sm font-semibold text-gray-700">Apply Customer Deposits</h3>
                        <p className="text-xs text-gray-500">Total entered is applied FIFO from customer deposits (same as Customer Center).</p>
                        {clearingData.deposits.filter((d: DepositInfo) => d.remainingAmount > 0).map((dep: DepositInfo) => (
                          <div key={dep.id} className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium">{dep.depositNumber}</p>
                              <p className="text-xs text-gray-500">Available: {formatCurrency(dep.remainingAmount)}</p>
                            </div>
                            <input
                              type="number"
                              min={0}
                              max={dep.remainingAmount}
                              value={depositAllocations[dep.id] ?? 0}
                              onChange={e => setDepositAllocations(prev => ({
                                ...prev,
                                [dep.id]: Math.min(dep.remainingAmount, Math.max(0, Number(e.target.value))),
                              }))}
                              className="w-28 border rounded px-2 py-1.5 text-sm text-right"
                              placeholder="0"
                            />
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Direct payment — POS-style tender */}
                    <div className="bg-white border rounded-lg p-4 space-y-3">
                      <h3 className="text-sm font-semibold text-gray-700">Direct Payment</h3>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <div>
                          <label className="text-xs text-gray-500">
                            {paymentMethod === 'CASH' ? 'Tendered' : 'Amount'}
                          </label>
                          <input
                            type="number"
                            min={0}
                            value={cashAmount || ''}
                            onChange={e => setCashAmount(Math.max(0, Number(e.target.value)))}
                            className="w-full border rounded px-3 py-1.5 text-sm mt-0.5"
                            placeholder="0"
                          />
                          {paymentMethod === 'CASH' && (
                            <button
                              type="button"
                              className="mt-1 text-xs text-blue-600 hover:underline"
                              onClick={() =>
                                setCashAmount(
                                  Math.max(0, (selectedInvoice?.amountDue ?? 0) - depositRequested),
                                )
                              }
                            >
                              Exact due
                            </button>
                          )}
                        </div>
                        <div>
                          <label className="text-xs text-gray-500">Method</label>
                          <select
                            value={paymentMethod}
                            onChange={e => setPaymentMethod(e.target.value as typeof paymentMethod)}
                            className="w-full border rounded px-3 py-1.5 text-sm mt-0.5"
                          >
                            <option value="CASH">Cash</option>
                            <option value="CARD">Card</option>
                            <option value="MOBILE_MONEY">Mobile Money</option>
                            <option value="BANK_TRANSFER">Bank Transfer</option>
                          </select>
                        </div>
                        <div>
                          <label className="text-xs text-gray-500">Reference #</label>
                          <input
                            type="text"
                            value={paymentRef}
                            onChange={e => setPaymentRef(e.target.value)}
                            className="w-full border rounded px-3 py-1.5 text-sm mt-0.5"
                            placeholder="Optional"
                          />
                        </div>
                      </div>
                      <div>
                        <label className="text-xs text-gray-500">Notes</label>
                        <input
                          type="text"
                          value={paymentNotes}
                          onChange={e => setPaymentNotes(e.target.value)}
                          className="w-full border rounded px-3 py-1.5 text-sm mt-0.5"
                          placeholder="Payment notes (optional)"
                        />
                      </div>
                    </div>

                    {/* POS-style take / change */}
                    <div className="bg-gray-50 border rounded-lg p-4 grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                      <div>
                        <p className="text-xs text-gray-500">Invoice due</p>
                        <p className="font-semibold">{formatCurrency(selectedInvoice?.amountDue ?? 0)}</p>
                      </div>
                      <div>
                        <p className="text-xs text-gray-500">Take (post to AR)</p>
                        <p className="font-semibold text-blue-700">{formatCurrency(tenderPreview.totalApplied)}</p>
                      </div>
                      <div>
                        <p className="text-xs text-gray-500">Change</p>
                        <p className={`font-bold ${tenderPreview.changeGiven > 0 ? 'text-green-700' : 'text-gray-700'}`}>
                          {formatCurrency(tenderPreview.changeGiven)}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-gray-500">Left on invoice</p>
                        <p className="font-semibold">{formatCurrency(tenderPreview.remainingDue)}</p>
                      </div>
                    </div>

                    {/* Submit */}
                    <button
                      onClick={() => clearingMutation.mutate()}
                      disabled={clearingMutation.isPending || tenderPreview.totalApplied <= 0}
                      className="w-full px-4 py-2.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-40"
                    >
                      {clearingMutation.isPending
                        ? 'Processing Payment…'
                        : tenderPreview.changeGiven > 0
                          ? `Take ${formatCurrency(tenderPreview.totalApplied)} · Change ${formatCurrency(tenderPreview.changeGiven)}`
                          : `Process Payment ${formatCurrency(tenderPreview.totalApplied)}`}
                    </button>
                  </>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </Layout>
  );
}
