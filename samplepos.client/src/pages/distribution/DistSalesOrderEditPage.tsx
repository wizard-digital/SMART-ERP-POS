/**
 * Distribution Module — Edit Sales Order
 *
 * SAP VA02 equivalent. Editable only when OPEN or PARTIALLY_DELIVERED.
 * Lines with deliveries are locked (qty cannot go below delivered).
 */
import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import Layout from '../../components/Layout';
import { DatePicker } from '../../components/ui/date-picker';
import distributionApi, { type SalesOrderLine } from '../../api/distribution';
import { api } from '../../utils/api';
import { formatCurrency } from '../../utils/currency';

interface StockLevelItem {
  product_id: string;
  product_name: string;
  sku?: string;
  barcode?: string;
  generic_name?: string;
  total_stock: number | string;
  selling_price: number | string;
  average_cost: number | string;
  product_type?: string;
}

interface EditLine {
  /** Unique key for React (client-side only) */
  key: number;
  /** Existing line ID from DB — undefined for new lines */
  lineId?: string;
  productId: string;
  productName: string;
  orderedQty: number;
  unitPrice: number;
  /** Already delivered (locked, cannot go below) */
  deliveredQty: number;
  confirmedQty: number;
}

const EDITABLE_STATUSES = ['OPEN', 'PARTIALLY_DELIVERED'];

export default function DistSalesOrderEditPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const lineKeyRef = useRef(0);

  const [orderDate, setOrderDate] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<EditLine[]>([]);
  const [loaded, setLoaded] = useState(false);

  // ── Product search (same as Create page / Quotations) ──
  const [productSearch, setProductSearch] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const productListRef = useRef<HTMLDivElement>(null);
  const [searchSelectedIndex, setSearchSelectedIndex] = useState(0);

  // Load existing order
  const { data: orderData, isLoading } = useQuery({
    queryKey: ['dist-sales-order', id],
    queryFn: () => distributionApi.getSalesOrder(id!),
    enabled: !!id,
  });

  // Hydrate form state from loaded order (once)
  useEffect(() => {
    if (!orderData || loaded) return;
    const { order, lines: soLines } = orderData;
    setOrderDate(order.orderDate?.split('T')[0] || '');
    setNotes(order.notes || '');
    setLines(soLines.map((l: SalesOrderLine) => ({
      key: lineKeyRef.current++,
      lineId: l.id,
      productId: l.productId,
      productName: l.productName,
      orderedQty: l.orderedQty,
      unitPrice: l.unitPrice,
      deliveredQty: l.deliveredQty,
      confirmedQty: l.confirmedQty,
    })));
    setLoaded(true);
  }, [orderData, loaded]);

  // Pre-fetch all stock data (for adding new lines)
  const { data: allStockData } = useQuery({
    queryKey: ['stock-levels-cache'],
    queryFn: async () => {
      const res = await api.inventory.stockLevels();
      if (!res.data.success) return [];
      return (res.data.data ?? []) as StockLevelItem[];
    },
    staleTime: 60_000,
    gcTime: 5 * 60_000,
  });

  const productsData = useMemo(() => {
    if (!productSearch || !allStockData) return [];
    const term = productSearch.toLowerCase();
    return allStockData.filter((item: StockLevelItem) =>
      item.product_name?.toLowerCase().includes(term) ||
      item.sku?.toLowerCase().includes(term) ||
      item.barcode?.toLowerCase().includes(term) ||
      item.generic_name?.toLowerCase().includes(term)
    );
  }, [productSearch, allStockData]);

  // ── Line operations ──
  const removeLine = useCallback((key: number) => {
    setLines(prev => {
      const line = prev.find(l => l.key === key);
      if (line && line.deliveredQty > 0) {
        toast.error(`Cannot remove — ${line.deliveredQty} units already delivered`);
        return prev;
      }
      return prev.filter(l => l.key !== key);
    });
  }, []);

  const updateLine = useCallback((key: number, field: keyof EditLine, value: string | number) => {
    setLines(prev => prev.map(l => {
      if (l.key !== key) return l;
      if (field === 'orderedQty') {
        const newQty = Number(value);
        if (newQty < l.deliveredQty) {
          toast.error(`Qty cannot be less than delivered (${l.deliveredQty})`);
          return l;
        }
      }
      return { ...l, [field]: value };
    }));
  }, []);

  const addProduct = useCallback((product: StockLevelItem) => {
    const price = typeof product.selling_price === 'string' ? parseFloat(product.selling_price) : (product.selling_price ?? 0);
    const existing = lines.find(l => l.productId === product.product_id);
    if (existing) {
      setLines(prev => prev.map(l =>
        l.key === existing.key ? { ...l, orderedQty: l.orderedQty + 1 } : l
      ));
      toast.success(`Increased ${product.product_name} quantity`);
    } else {
      const key = lineKeyRef.current++;
      setLines(prev => [...prev, {
        key, lineId: undefined, productId: product.product_id,
        productName: product.product_name, orderedQty: 1,
        unitPrice: price, deliveredQty: 0, confirmedQty: 0,
      }]);
      toast.success(`Added ${product.product_name}`);
    }
    setProductSearch('');
    setSearchSelectedIndex(0);
    searchInputRef.current?.focus();
  }, [lines]);

  // ── Keyboard navigation for search (same as Quotations) ──
  const scrollSearchItemIntoView = useCallback((index: number, direction: 'up' | 'down') => {
    setTimeout(() => {
      const container = productListRef.current;
      const item = container?.children[index] as HTMLElement;
      if (item && container) {
        const containerRect = container.getBoundingClientRect();
        const itemRect = item.getBoundingClientRect();
        if (direction === 'down' && itemRect.bottom > containerRect.bottom) {
          item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        } else if (direction === 'up' && itemRect.top < containerRect.top) {
          item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
      }
    }, 0);
  }, []);

  const selectHighlightedProduct = useCallback(() => {
    if (!productsData || productsData.length === 0) return;
    const clamped = Math.min(searchSelectedIndex, productsData.length - 1);
    if (clamped < 0) return;
    addProduct(productsData[clamped]);
  }, [productsData, searchSelectedIndex, addProduct]);

  const handleSearchKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (productSearch) { setProductSearch(''); setSearchSelectedIndex(0); }
      return;
    }
    if (!productsData || productsData.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSearchSelectedIndex(prev => {
        const next = Math.min(prev + 1, productsData.length - 1);
        scrollSearchItemIntoView(next, 'down');
        return next;
      });
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSearchSelectedIndex(prev => {
        const next = Math.max(prev - 1, 0);
        scrollSearchItemIntoView(next, 'up');
        return next;
      });
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      selectHighlightedProduct();
      return;
    }
  }, [productsData, productSearch, scrollSearchItemIntoView, selectHighlightedProduct]);

  // Global shortcuts
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
      if ((e.key === '/' || e.key === 'F2') && !isInput) {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, []);

  // ── Submit ──
  const mutation = useMutation({
    mutationFn: () =>
      distributionApi.editSalesOrder(id!, {
        orderDate: orderDate || undefined,
        notes: notes || undefined,
        lines: lines.map(l => ({
          id: l.lineId,
          productId: l.productId,
          orderedQty: l.orderedQty,
          unitPrice: l.unitPrice,
        })),
      }),
    onSuccess: (result) => {
      toast.success(`Order ${result.order.orderNumber} updated`);
      queryClient.invalidateQueries({ queryKey: ['dist-sales-orders'] });
      queryClient.invalidateQueries({ queryKey: ['dist-sales-order', id] });
      navigate(`/distribution/sales-orders/${id}`);
    },
    onError: (err: { response?: { data?: { error?: string } } }) => {
      toast.error(err.response?.data?.error ?? 'Failed to update order');
    },
  });

  const order = orderData?.order;
  const isEditable = order && EDITABLE_STATUSES.includes(order.status);
  const totalAmount = lines.reduce((sum, l) => sum + l.orderedQty * l.unitPrice, 0);

  if (isLoading) {
    return (
      <Layout>
        <div className="p-6 text-center text-gray-400">Loading order…</div>
      </Layout>
    );
  }

  if (!order) {
    return (
      <Layout>
        <div className="p-6 text-center text-red-500">Order not found</div>
      </Layout>
    );
  }

  if (!isEditable) {
    return (
      <Layout>
        <div className="p-6 max-w-5xl space-y-4">
          <div className="flex items-center gap-3">
            <button onClick={() => navigate(-1)} className="text-gray-500 hover:text-gray-800 text-sm">← Back</button>
            <h1 className="text-xl font-bold text-gray-900">Edit Sales Order</h1>
          </div>
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-6 text-center">
            <p className="text-amber-800 font-medium">
              This order is <span className="font-bold">{order.status}</span> and cannot be edited.
            </p>
            <p className="text-amber-600 text-sm mt-1">Only OPEN or PARTIALLY_DELIVERED orders can be modified.</p>
          </div>
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="p-4 lg:p-6 space-y-4 max-w-5xl">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button type="button" onClick={() => navigate(-1)} className="text-gray-500 hover:text-gray-800 text-sm">
              ← Back
            </button>
            <div>
              <h1 className="text-xl font-bold text-gray-900">Edit {order.orderNumber}</h1>
              <p className="text-xs text-gray-500">{order.customerName}</p>
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={() => navigate(-1)} className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 text-gray-700">
              Cancel
            </button>
            <button
              onClick={() => mutation.mutate()}
              disabled={lines.length === 0 || mutation.isPending}
              className="px-6 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-semibold disabled:opacity-50"
            >
              {mutation.isPending ? 'Saving…' : 'Save Changes'}
            </button>
          </div>
        </div>

        {/* Info banner for partially delivered orders */}
        {order.status === 'PARTIALLY_DELIVERED' && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-2 text-sm text-amber-800">
            ⚠ This order has deliveries. Lines with delivered quantities cannot be removed, and qty cannot be reduced below delivered amounts.
          </div>
        )}

        {/* Header fields */}
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {/* Customer (read-only after creation) */}
            <div>
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Customer</label>
              <div className="px-3 py-2 bg-gray-50 rounded-lg text-sm font-medium text-gray-700">
                {order.customerName}
              </div>
            </div>

            {/* Date */}
            <div>
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Order Date</label>
              <DatePicker
                value={orderDate}
                onChange={setOrderDate}
                placeholder="Order date"
              />
            </div>

            {/* Notes */}
            <div>
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Notes</label>
              <input
                type="text"
                value={notes}
                onChange={e => setNotes(e.target.value)}
                placeholder="Optional"
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>
        </div>

        {/* ═══════════ ITEMS TABLE ═══════════ */}
        <div className="bg-white rounded-lg border border-gray-200">
          {/* Product Search */}
          <div className="p-3 border-b border-gray-200 relative">
            <div className="flex items-center gap-2">
              <span className="text-gray-400 text-lg">🔍</span>
              <input
                ref={searchInputRef}
                type="text"
                value={productSearch}
                onChange={e => { setProductSearch(e.target.value); setSearchSelectedIndex(0); }}
                onKeyDown={handleSearchKeyDown}
                className="flex-1 px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                placeholder="Add products by name, SKU, or barcode... (/ or F2 to focus)"
              />
            </div>

            {/* Search Results Dropdown */}
            {productSearch && productsData && productsData.length > 0 && (
              <div ref={productListRef} className="mt-1 border border-gray-300 rounded-lg max-h-56 overflow-y-auto bg-white shadow-lg absolute z-20 left-3 right-3">
                {productsData.slice(0, 15).map((product: StockLevelItem, idx: number) => {
                  const stock = typeof product.total_stock === 'string' ? parseFloat(product.total_stock) : (product.total_stock ?? 0);
                  const price = typeof product.selling_price === 'string' ? parseFloat(product.selling_price) : (product.selling_price ?? 0);
                  return (
                    <button
                      key={product.product_id}
                      type="button"
                      onClick={() => addProduct(product)}
                      className={`w-full px-4 py-2.5 text-left border-b last:border-b-0 transition-colors ${idx === searchSelectedIndex
                          ? 'bg-blue-100 border-l-4 border-l-blue-600'
                          : 'hover:bg-blue-50'
                        }`}
                    >
                      <div className="flex justify-between items-center">
                        <div>
                          <span className="font-medium text-gray-900 text-sm">{product.product_name}</span>
                          <span className="text-xs text-gray-500 ml-2">
                            {product.sku && `SKU: ${product.sku}`}
                            {product.barcode && ` | BC: ${product.barcode}`}
                          </span>
                        </div>
                        <div className="text-right text-xs">
                          <span className="text-green-600 font-medium">{formatCurrency(price)}</span>
                          <span className={`ml-2 ${stock <= 0 ? 'text-red-500' : 'text-gray-400'}`}>Stk: {stock}</span>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}

            {productSearch && productsData.length === 0 && allStockData && (
              <p className="text-xs text-gray-400 mt-1 ml-8">No products match &ldquo;{productSearch}&rdquo;</p>
            )}
          </div>

          {/* Items Table */}
          {lines.length === 0 ? (
            <div className="text-center py-12 text-gray-400">
              <div className="text-3xl mb-2">📦</div>
              <p className="text-sm">All lines removed. Add products above.</p>
            </div>
          ) : (
            <>
              {/* Desktop table */}
              <div className="hidden sm:block overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50 text-gray-600 text-xs uppercase tracking-wide">
                      <th className="text-left py-2.5 px-3 w-8">#</th>
                      <th className="text-left py-2.5 px-3">Product</th>
                      <th className="text-right py-2.5 px-3 w-24">Qty</th>
                      <th className="text-right py-2.5 px-3 w-28">Unit Price</th>
                      <th className="text-right py-2.5 px-3 w-28">Total</th>
                      <th className="text-center py-2.5 px-3 w-24">Delivered</th>
                      <th className="py-2.5 px-3 w-10"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((line, idx) => {
                      const hasDelivery = line.deliveredQty > 0;
                      return (
                        <tr key={line.key} className={`border-t border-gray-100 hover:bg-blue-50/30 ${hasDelivery ? 'bg-gray-50/50' : ''}`}>
                          <td className="py-2 px-3 text-gray-400 text-xs">{idx + 1}</td>
                          <td className="py-2 px-3">
                            <span className="text-sm font-medium">{line.productName}</span>
                            {hasDelivery && (
                              <span className="ml-2 text-[10px] text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded">🔒 Delivered</span>
                            )}
                          </td>
                          <td className="py-2 px-3">
                            <input
                              type="number"
                              min={line.deliveredQty || 1}
                              value={line.orderedQty}
                              onChange={e => updateLine(line.key, 'orderedQty', Math.max(line.deliveredQty || 1, Number(e.target.value)))}
                              className="w-20 px-2 py-1 text-sm text-right border border-transparent hover:border-gray-300 focus:border-blue-500 rounded focus:ring-1 focus:ring-blue-500 bg-transparent"
                            />
                          </td>
                          <td className="py-2 px-3">
                            <input
                              type="number"
                              min={0}
                              step="1"
                              value={line.unitPrice}
                              onChange={e => updateLine(line.key, 'unitPrice', Number(e.target.value))}
                              className="w-24 px-2 py-1 text-sm text-right border border-transparent hover:border-gray-300 focus:border-blue-500 rounded focus:ring-1 focus:ring-blue-500 bg-transparent"
                            />
                          </td>
                          <td className="py-2 px-3 text-right font-medium">{formatCurrency(line.orderedQty * line.unitPrice)}</td>
                          <td className="py-2 px-3 text-center">
                            {hasDelivery ? (
                              <span className="text-xs font-mono text-amber-600 font-bold">{line.deliveredQty}</span>
                            ) : (
                              <span className="text-xs text-gray-300">—</span>
                            )}
                          </td>
                          <td className="py-2 px-3">
                            {hasDelivery ? (
                              <span className="text-gray-300 cursor-not-allowed" title="Cannot remove — has deliveries">✕</span>
                            ) : (
                              <button onClick={() => removeLine(line.key)} className="text-red-400 hover:text-red-600" title="Remove line">✕</button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Mobile cards */}
              <div className="sm:hidden divide-y">
                {lines.map((line, idx) => {
                  const hasDelivery = line.deliveredQty > 0;
                  return (
                    <div key={line.key} className={`p-3 space-y-2 ${hasDelivery ? 'bg-gray-50/50' : ''}`}>
                      <div className="flex justify-between items-center">
                        <div>
                          <span className="text-sm font-medium">{idx + 1}. {line.productName}</span>
                          {hasDelivery && <span className="ml-2 text-[10px] text-amber-600">🔒</span>}
                        </div>
                        {!hasDelivery && (
                          <button onClick={() => removeLine(line.key)} className="text-red-400 text-xs">Remove</button>
                        )}
                      </div>
                      <div className="grid grid-cols-3 gap-2 text-sm">
                        <div>
                          <label className="text-xs text-gray-500">Qty (min: {line.deliveredQty || 1})</label>
                          <input type="number" min={line.deliveredQty || 1} value={line.orderedQty}
                            onChange={e => updateLine(line.key, 'orderedQty', Math.max(line.deliveredQty || 1, Number(e.target.value)))}
                            className="w-full border rounded px-2 py-1 text-sm"
                          />
                        </div>
                        <div>
                          <label className="text-xs text-gray-500">Price</label>
                          <input type="number" min={0} value={line.unitPrice}
                            onChange={e => updateLine(line.key, 'unitPrice', Number(e.target.value))}
                            className="w-full border rounded px-2 py-1 text-sm"
                          />
                        </div>
                        <div>
                          <label className="text-xs text-gray-500">Delivered</label>
                          <p className="text-sm font-mono text-amber-600">{line.deliveredQty || '—'}</p>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-end justify-end bg-white rounded-lg border border-gray-200 p-4">
          <div className="text-right">
            <p className="text-xs text-gray-500">Order Total</p>
            <p className="text-2xl font-bold">{formatCurrency(totalAmount)}</p>
          </div>
        </div>
      </div>
    </Layout>
  );
}
