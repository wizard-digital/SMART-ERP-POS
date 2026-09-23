/**
 * Distribution Module — Create Sales Order
 *
 * Keyboard-first: Tab between fields, Ctrl+Insert adds a line,
 * F2 saves, Escape cancels.  ATP shown inline per line.
 */
import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import Layout from '../../components/Layout';
import { DatePicker } from '../../components/ui/date-picker';
import distributionApi, { type AtpResult } from '../../api/distribution';
import { api } from '../../utils/api';
import apiClient from '../../utils/api';
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

interface OrderLine {
  key: number;
  productId: string;
  productName: string;
  orderedQty: number;
  unitPrice: number;
  atp: number | null;
}

export default function DistSalesOrderCreatePage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const lineKeyRef = useRef(0);

  const [customerId, setCustomerId] = useState('');
  const [customerSearch, setCustomerSearch] = useState('');
  const [orderDate, setOrderDate] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<OrderLine[]>([]);

  // ── Product search (identical to Quotations page) ──
  const [productSearch, setProductSearch] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const productListRef = useRef<HTMLDivElement>(null);
  const [searchSelectedIndex, setSearchSelectedIndex] = useState(0);

  // Customer search
  const { data: customers } = useQuery({
    queryKey: ['customers-search', customerSearch],
    queryFn: async () => {
      if (customerSearch.length < 2) return [];
      const res = await apiClient.get('/customers', { params: { search: customerSearch, limit: 10 } });
      return res.data.data ?? [];
    },
    enabled: customerSearch.length >= 2,
  });

  // Pre-fetch all stock data once (same pattern as Quotations)
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

  // Instant client-side filtering
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

  // ATP check when lines have products
  const productIds = lines.filter(l => l.productId).map(l => l.productId);
  const { data: atpData } = useQuery({
    queryKey: ['dist-atp', ...productIds],
    queryFn: () => distributionApi.checkAtp(productIds),
    enabled: productIds.length > 0,
  });

  useEffect(() => {
    if (!atpData) return;
    const atpMap = new Map(atpData.map((a: AtpResult) => [a.productId, a.atp]));
    setLines(prev => prev.map(l => ({
      ...l,
      atp: l.productId ? (atpMap.get(l.productId) ?? 0) : null,
    })));
  }, [atpData]);

  const removeLine = useCallback((key: number) => {
    setLines(prev => prev.filter(l => l.key !== key));
  }, []);

  const updateLine = useCallback((key: number, field: keyof OrderLine, value: string | number) => {
    setLines(prev => prev.map(l => l.key === key ? { ...l, [field]: value } : l));
  }, []);

  const addProduct = useCallback((product: StockLevelItem) => {
    const price = typeof product.selling_price === 'string' ? parseFloat(product.selling_price) : (product.selling_price ?? 0);
    // If product already in lines, increment qty instead
    const existing = lines.find(l => l.productId === product.product_id);
    if (existing) {
      setLines(prev => prev.map(l =>
        l.key === existing.key ? { ...l, orderedQty: l.orderedQty + 1 } : l
      ));
      toast.success(`Increased ${product.product_name} quantity`);
    } else {
      const key = lineKeyRef.current++;
      setLines(prev => [...prev, {
        key, productId: product.product_id, productName: product.product_name,
        orderedQty: 1, unitPrice: price, atp: null,
      }]);
      toast.success(`Added ${product.product_name}`);
    }
    setProductSearch('');
    setSearchSelectedIndex(0);
    searchInputRef.current?.focus();
  }, [lines]);

  // ── Keyboard navigation for search dropdown (same as Quotations) ──
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
      if (productSearch) {
        setProductSearch('');
        setSearchSelectedIndex(0);
      }
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

  // Global keyboard shortcuts
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';

      if (e.key === '/' && !isInput) {
        e.preventDefault();
        searchInputRef.current?.focus();
        return;
      }
      if (e.key === 'F2' && !isInput) {
        e.preventDefault();
        searchInputRef.current?.focus();
        return;
      }
    };
    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, []);

  // Submit
  const mutation = useMutation({
    mutationFn: () =>
      distributionApi.createSalesOrder({
        customerId,
        orderDate: orderDate || undefined,
        notes: notes || undefined,
        lines: lines
          .filter(l => l.productId)
          .map(l => ({ productId: l.productId, orderedQty: l.orderedQty, unitPrice: l.unitPrice })),
      }),
    onSuccess: (result) => {
      toast.success(`Order ${result.order.orderNumber} created`);
      queryClient.invalidateQueries({ queryKey: ['dist-sales-orders'] });
      navigate(`/distribution/sales-orders/${result.order.id}`);
    },
    onError: (err: { response?: { data?: { error?: string } } }) => {
      toast.error(err.response?.data?.error ?? 'Failed to create order');
    },
  });

  const totalAmount = lines.reduce((sum, l) => sum + l.orderedQty * l.unitPrice, 0);
  const hasBackorder = lines.some(l => l.atp !== null && l.orderedQty > l.atp);

  return (
    <Layout>
      <div className="p-4 lg:p-6 space-y-4 max-w-5xl">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button type="button" onClick={() => navigate(-1)} className="text-gray-500 hover:text-gray-800 text-sm">
              ← Back
            </button>
            <h1 className="text-xl font-bold text-gray-900">New Sales Order</h1>
          </div>
          <div className="flex gap-2">
            <button onClick={() => navigate(-1)} className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 text-gray-700">
              Cancel
            </button>
            <button
              onClick={() => mutation.mutate()}
              disabled={!customerId || lines.length === 0 || mutation.isPending}
              className="px-6 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-semibold disabled:opacity-50"
            >
              {mutation.isPending ? 'Saving…' : 'Create Order'}
            </button>
          </div>
        </div>

        {/* Header fields */}
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {/* Customer */}
            <div className="relative">
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Customer <span className="text-red-500">*</span></label>
              {customerId ? (
                <div className="flex items-center gap-2 px-3 py-2 bg-gray-50 rounded-lg">
                  <span className="text-sm font-medium flex-1">{customerSearch}</span>
                  <button onClick={() => { setCustomerId(''); setCustomerSearch(''); }} className="text-red-500 text-xs hover:underline">Change</button>
                </div>
              ) : (
                <div className="relative">
                  <input
                    type="text"
                    value={customerSearch}
                    onChange={e => setCustomerSearch(e.target.value)}
                    placeholder="Search customer…"
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                    autoFocus
                  />
                  {customers && customers.length > 0 && !customerId && (
                    <div className="absolute z-20 top-full left-0 right-0 bg-white border shadow-lg rounded-lg mt-1 max-h-48 overflow-y-auto">
                      {customers.map((c: { id: string; name: string; credit_limit?: string }) => (
                        <button
                          key={c.id}
                          className="w-full text-left px-3 py-2 text-sm hover:bg-blue-50 border-b last:border-b-0"
                          onMouseDown={e => e.preventDefault()}
                          onClick={() => { setCustomerId(c.id); setCustomerSearch(c.name); }}
                        >
                          {c.name}
                          {c.credit_limit && <span className="text-xs text-gray-400 ml-2">Limit: {formatCurrency(parseFloat(c.credit_limit))}</span>}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
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
          {/* Product Search — identical to Quotations */}
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
                placeholder="Search products by name, SKU, or barcode... (/ or F2 to focus)"
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
              <p className="text-sm">Search for products above to add order lines</p>
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
                      <th className="text-center py-2.5 px-3 w-24">ATP</th>
                      <th className="py-2.5 px-3 w-10"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((line, idx) => (
                      <tr key={line.key} className={`border-t border-gray-100 hover:bg-blue-50/30 ${line.atp !== null && line.orderedQty > line.atp ? 'bg-yellow-50' : ''}`}>
                        <td className="py-2 px-3 text-gray-400 text-xs">{idx + 1}</td>
                        <td className="py-2 px-3">
                          <span className="text-sm font-medium">{line.productName}</span>
                        </td>
                        <td className="py-2 px-3">
                          <input
                            type="number"
                            min={1}
                            value={line.orderedQty}
                            onChange={e => updateLine(line.key, 'orderedQty', Math.max(1, Number(e.target.value)))}
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
                          {line.atp !== null && (
                            <span className={`text-xs font-mono ${line.orderedQty > line.atp ? 'text-amber-600 font-bold' : 'text-green-600'}`}>
                              {line.atp}
                            </span>
                          )}
                        </td>
                        <td className="py-2 px-3">
                          <button onClick={() => removeLine(line.key)} className="text-red-400 hover:text-red-600" title="Remove line">✕</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Mobile cards */}
              <div className="sm:hidden divide-y">
                {lines.map((line, idx) => (
                  <div key={line.key} className={`p-3 space-y-2 ${line.atp !== null && line.orderedQty > line.atp ? 'bg-yellow-50' : ''}`}>
                    <div className="flex justify-between items-center">
                      <span className="text-sm font-medium">{idx + 1}. {line.productName}</span>
                      <button onClick={() => removeLine(line.key)} className="text-red-400 text-xs">Remove</button>
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-sm">
                      <div>
                        <label className="text-xs text-gray-500">Qty</label>
                        <input type="number" min={1} value={line.orderedQty} onChange={e => updateLine(line.key, 'orderedQty', Math.max(1, Number(e.target.value)))} className="w-full border rounded px-2 py-1 text-sm" />
                      </div>
                      <div>
                        <label className="text-xs text-gray-500">Price</label>
                        <input type="number" min={0} value={line.unitPrice} onChange={e => updateLine(line.key, 'unitPrice', Number(e.target.value))} className="w-full border rounded px-2 py-1 text-sm" />
                      </div>
                      <div>
                        <label className="text-xs text-gray-500">ATP</label>
                        <p className={`text-sm font-mono ${line.atp !== null && line.orderedQty > line.atp ? 'text-amber-600 font-bold' : 'text-green-600'}`}>
                          {line.atp ?? '—'}
                        </p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex flex-col sm:flex-row items-end justify-between gap-3 bg-white rounded-lg border border-gray-200 p-4">
          {hasBackorder && (
            <div className="text-sm text-amber-700 bg-amber-50 border border-amber-200 px-3 py-2 rounded">
              ⚠ Some lines exceed ATP — they will become backorders (partially confirmed).
            </div>
          )}
          <div className="text-right ml-auto">
            <p className="text-xs text-gray-500">Order Total</p>
            <p className="text-2xl font-bold">{formatCurrency(totalAmount)}</p>
          </div>
        </div>
      </div>
    </Layout>
  );
}
