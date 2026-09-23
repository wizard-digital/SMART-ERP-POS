/**
 * New Standard Quotation Form - SAP-style single-page layout
 * Header (customer + details) → Items table → Bottom tabs (terms/notes) → Sticky footer
 */

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-hot-toast';
import quotationApi from '../../api/quotations';
import { api } from '../../utils/api';
import type { Customer } from '@shared/zod/customer';
import type { CreateQuotationInput, FulfillmentMode } from '@shared/types/quotation';
import { AxiosError } from 'axios';
import { formatCurrency } from '../../utils/currency';
import Layout from '../../components/Layout';
import { useAuth } from '../../hooks/useAuth';
import { isAuthQueryEnabled } from '../../lib/authQuery';
import CustomerSelector from '../../components/pos/CustomerSelector';
import { DatePicker } from '../../components/ui/date-picker';
import { getBusinessDate } from '../../utils/businessDate';
import {
  adjustQuotationQuantity,
  calculateLineTotal,
  calculateQuotationTotals,
  hasTaxableQuotationLines,
} from '../../utils/quotationCalculations';
import { QuotationLineUomSelect } from '../../components/quotations/QuotationLineUomSelect';
import { useMasterUoms } from '../../hooks/useMasterUoms';
import { displayMasterUomName, pickDefaultMasterUom } from '../../utils/quotationUom';
import { isPersistedCustomerId, resolvePosCustomerForSale } from '../../utils/resolvePosCustomerId';
import { customerIsAtCost } from '../../utils/customerPriceGroupEdit';
import {
  buildQuoteLineFromStockProduct,
  type StockLevelProductRow,
  type StockProductUom,
} from '../../utils/quotationStockProduct';

interface QuoteItem {
  id: string;
  productId?: string;
  itemType: 'product' | 'service' | 'custom';
  sku?: string;
  description: string;
  notes?: string;
  quantity: number;
  unitPrice: number;
  discountAmount: number;
  isTaxable: boolean;
  taxRate: number;
  uomId?: string;
  uomName?: string;
  availableUoms?: StockProductUom[];
  stockOnHand?: number;
}

type StockLevelItem = StockLevelProductRow;

export default function NewQuotationPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { isAuthenticated } = useAuth();
  const { data: masterUoms = [] } = useMasterUoms();
  const defaultMasterUom = useMemo(() => pickDefaultMasterUom(masterUoms), [masterUoms]);

  // Customer data
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [customerEmail, setCustomerEmail] = useState('');

  // Quote details
  const [reference, setReference] = useState('');
  const [validUntil, setValidUntil] = useState(
    new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toLocaleDateString('en-CA')
  );
  const [items, setItems] = useState<QuoteItem[]>([]);

  // Fulfillment mode
  const [fulfillmentMode, setFulfillmentMode] = useState<FulfillmentMode>('RETAIL');

  // Bottom tab
  const [activeTab, setActiveTab] = useState<'terms' | 'notes'>('terms');

  // Advanced fields
  const [termsAndConditions, setTermsAndConditions] = useState('');
  const [paymentTerms, setPaymentTerms] = useState('Net 30');
  const [deliveryTerms, setDeliveryTerms] = useState('7-14 business days');
  const [internalNotes, setInternalNotes] = useState('');
  const [requiresApproval, setRequiresApproval] = useState(false);

  // Pre-fetch all stock data once
  const [productSearch, setProductSearch] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const productListRef = useRef<HTMLDivElement>(null);
  const [searchSelectedIndex, setSearchSelectedIndex] = useState(0);
  const itemRefs = useRef<(HTMLInputElement | HTMLSelectElement | null)[][]>([]);
  const { data: allStockData } = useQuery({
    queryKey: ['stock-levels-cache'],
    enabled: isAuthQueryEnabled(isAuthenticated),
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

  const createQuoteMutation = useMutation({
    mutationFn: (data: CreateQuotationInput) => quotationApi.createQuotation(data),
    onSuccess: (response) => {
      queryClient.invalidateQueries({ queryKey: ['quotations'] });
      toast.success(`Quotation ${response.quotation.quoteNumber} created successfully!`);
      navigate('/quotations');
    },
    onError: (error: Error) => {
      toast.error((error as AxiosError<{ error?: string }>).response?.data?.error || 'Failed to create quotation');
    },
  });

  // Auto-fill from selected customer
  useEffect(() => {
    if (selectedCustomer) {
      setCustomerName(selectedCustomer.name);
      setCustomerPhone(selectedCustomer.phone || '');
      setCustomerEmail(selectedCustomer.email || '');
    }
  }, [selectedCustomer]);

  const addItem = () => {
    setItems([
      ...items,
      {
        id: `temp_${Date.now()}`,
        itemType: 'custom',
        description: '',
        quantity: 1,
        unitPrice: 0,
        discountAmount: 0,
        isTaxable: false,
        taxRate: 18,
        uomId: defaultMasterUom?.id,
        uomName: defaultMasterUom ? displayMasterUomName(defaultMasterUom) : '',
      },
    ]);
  };

  const addProductToItems = (product: StockLevelItem) => {
    const atCost = customerIsAtCost(selectedCustomer);
    const existing = items.find((item) => item.productId === product.product_id);
    if (existing) {
      updateItem(items.indexOf(existing), 'quantity', existing.quantity + 1);
      toast.success(`Increased ${product.product_name} quantity`);
    } else {
      const line = buildQuoteLineFromStockProduct(product, { atCost });
      setItems([
        ...items,
        {
          id: `temp_${Date.now()}`,
          productId: line.productId,
          itemType: 'product',
          sku: line.sku,
          description: line.description,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          discountAmount: 0,
          isTaxable: line.isTaxable,
          taxRate: line.taxRate,
          uomId: line.uomId || undefined,
          uomName: line.uomName,
          availableUoms: line.availableUoms,
          stockOnHand: line.stockOnHand,
        },
      ]);
      toast.success(
        atCost
          ? `Added ${product.product_name} at cost`
          : `Added ${product.product_name}`,
      );
    }
    setProductSearch('');
  };

  const updateItem = (index: number, field: keyof QuoteItem, value: string | number | boolean) => {
    const updated = [...items];
    updated[index] = { ...updated[index], [field]: value };
    setItems(updated);
  };

  const removeItem = (index: number) => {
    setItems(items.filter((_, i) => i !== index));
  };

  const calculateItemTotal = (item: QuoteItem): number => calculateLineTotal(item);

  const calculateTotals = () => calculateQuotationTotals(items);

  const showTax = hasTaxableQuotationLines(items);

  // ── Keyboard Navigation ──

  useEffect(() => {
    setSearchSelectedIndex(0);
  }, [productsData]);

  useEffect(() => {
    itemRefs.current = items.map((_, i) => itemRefs.current[i] || [null, null, null, null]);
  }, [items]);

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
    addProductToItems(productsData[clamped]);
  }, [productsData, searchSelectedIndex]);

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
      setSearchSelectedIndex((prev) => {
        const next = Math.min(prev + 1, productsData.length - 1);
        scrollSearchItemIntoView(next, 'down');
        return next;
      });
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSearchSelectedIndex((prev) => {
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

  const handleItemKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement | HTMLSelectElement>, rowIndex: number, fieldIndex: number) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (fieldIndex < 3) {
        itemRefs.current[rowIndex]?.[fieldIndex + 1]?.focus();
      } else {
        if (rowIndex < items.length - 1) {
          itemRefs.current[rowIndex + 1]?.[0]?.focus();
        } else {
          searchInputRef.current?.focus();
        }
      }
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && e.ctrlKey) {
      e.preventDefault();
      removeItem(rowIndex);
      setTimeout(() => {
        if (rowIndex > 0) {
          itemRefs.current[rowIndex - 1]?.[0]?.focus();
        } else {
          searchInputRef.current?.focus();
        }
      }, 50);
      return;
    }
    if (e.key === 'ArrowDown' && e.altKey) {
      e.preventDefault();
      if (rowIndex < items.length - 1) itemRefs.current[rowIndex + 1]?.[fieldIndex]?.focus();
      return;
    }
    if (e.key === 'ArrowUp' && e.altKey) {
      e.preventDefault();
      if (rowIndex > 0) itemRefs.current[rowIndex - 1]?.[fieldIndex]?.focus();
      return;
    }
  }, [items.length]);

  const handleQuantityKeyDown = useCallback((
    e: React.KeyboardEvent<HTMLInputElement>,
    index: number,
  ) => {
    const step = e.shiftKey ? 10 : 1;
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      updateItem(index, 'quantity', adjustQuotationQuantity(items[index].quantity, step));
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      updateItem(index, 'quantity', adjustQuotationQuantity(items[index].quantity, -step));
      return;
    }
    handleItemKeyDown(e, index, 1);
  }, [handleItemKeyDown, items]);

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
      if (e.key === 'F2') {
        e.preventDefault();
        searchInputRef.current?.focus();
        return;
      }
      if (e.key === 'Insert') {
        e.preventDefault();
        addItem();
        setTimeout(() => {
          const lastRow = itemRefs.current[items.length];
          lastRow?.[0]?.focus();
        }, 100);
        return;
      }
    };
    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [items.length]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!customerName.trim() && !selectedCustomer) {
      toast.error('Please enter a customer name');
      return;
    }
    if (items.length === 0) {
      toast.error('Please add at least one item');
      return;
    }
    const customMissingUom = items.find(
      (item) => !item.productId && item.itemType === 'custom' && !item.uomId
    );
    if (customMissingUom) {
      toast.error('Select a UoM from the system list for each custom line');
      return;
    }

    let customerId = selectedCustomer?.id;
    let resolvedCustomer = selectedCustomer;
    if (selectedCustomer && !isPersistedCustomerId(selectedCustomer.id)) {
      const resolved = await resolvePosCustomerForSale(selectedCustomer);
      if (resolved.error || !resolved.customerId) {
        toast.error(resolved.error || 'Select a saved customer before creating the quotation');
        return;
      }
      customerId = resolved.customerId;
      resolvedCustomer = resolved.customer;
      setSelectedCustomer(resolved.customer);
    }

    const quotationData = {
      quoteType: 'standard' as const,
      fulfillmentMode,
      customerId: customerId && isPersistedCustomerId(customerId) ? customerId : undefined,
      customerName: customerName || resolvedCustomer?.name || selectedCustomer?.name,
      customerPhone: (customerPhone || resolvedCustomer?.phone || selectedCustomer?.phone) || undefined,
      customerEmail: (customerEmail || resolvedCustomer?.email || selectedCustomer?.email) || undefined,
      reference: reference || undefined,
      paymentTerms: paymentTerms || undefined,
      deliveryTerms: deliveryTerms || undefined,
      validFrom: getBusinessDate(),
      validUntil,
      notes: internalNotes || undefined,
      items: items.map((item) => ({
        productId: item.productId,
        itemType: item.productId ? item.itemType : 'custom',
        sku: item.sku,
        description: item.description,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        discountAmount: item.discountAmount,
        isTaxable: item.isTaxable,
        taxRate: item.taxRate,
        uomId: item.uomId || undefined,
        uomName: item.uomName || undefined,
      })),
    };

    createQuoteMutation.mutate(quotationData);
  };

  const totals = calculateTotals();

  return (
    <Layout>
      <form onSubmit={handleSubmit} className="flex flex-col h-[calc(100vh-4rem)]">
        {/* ── Page Header ── */}
        <div className="flex items-center justify-between px-6 py-3 bg-white border-b shrink-0">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => navigate('/quotations')}
              className="text-gray-500 hover:text-gray-800 text-sm"
            >
              ← Back
            </button>
            <h1 className="text-xl font-bold text-gray-900">New Quotation</h1>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => navigate('/quotations')}
              className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 text-gray-700"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={createQuoteMutation.isPending}
              className="px-6 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 font-semibold disabled:opacity-50"
            >
              {createQuoteMutation.isPending ? 'Creating...' : 'Add Quotation'}
            </button>
          </div>
        </div>

        {/* ── Scrollable Content ── */}
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-7xl mx-auto px-6 py-4 space-y-4">

            {/* ═══════════ HEADER SECTION ═══════════ */}
            <div className="bg-white rounded-lg border border-gray-200 p-4">
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
                {/* Customer */}
                <div className="lg:col-span-4">
                  <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Customer <span className="text-red-500">*</span></label>
                  <CustomerSelector
                    selectedCustomer={selectedCustomer}
                    onSelectCustomer={setSelectedCustomer}
                    saleTotal={totals.total}
                  />
                  {customerIsAtCost(selectedCustomer) && (
                    <p className="mt-2 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1.5">
                      AT_COST customer — product lines use inventory cost (not FEFO layers).
                      For exact FEFO cost quotes, create from POS.
                    </p>
                  )}
                  {!selectedCustomer && (
                    <input
                      type="text"
                      value={customerName}
                      onChange={(e) => setCustomerName(e.target.value)}
                      className="w-full mt-2 px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                      placeholder="Or type customer name"
                      required={!selectedCustomer}
                    />
                  )}
                </div>

                {/* Customer Phone & Email */}
                <div className="lg:col-span-2">
                  <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Phone</label>
                  <input
                    type="tel"
                    value={customerPhone}
                    onChange={(e) => setCustomerPhone(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                    placeholder="0700000000"
                  />
                </div>
                <div className="lg:col-span-2">
                  <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Email</label>
                  <input
                    type="email"
                    value={customerEmail}
                    onChange={(e) => setCustomerEmail(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                    placeholder="email@example.com"
                  />
                </div>

                {/* Reference */}
                <div className="lg:col-span-2">
                  <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Reference</label>
                  <input
                    type="text"
                    value={reference}
                    onChange={(e) => setReference(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                    placeholder="PO-123"
                  />
                </div>

                {/* Valid Until */}
                <div className="lg:col-span-2">
                  <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Valid Until</label>
                  <DatePicker
                    value={validUntil}
                    onChange={(date) => setValidUntil(date)}
                    placeholder="Select date"
                    minDate={new Date()}
                  />
                </div>
              </div>

              {/* Fulfillment Mode Toggle */}
              <div className="mt-3 flex items-center gap-3 pt-3 border-t border-gray-100">
                <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Fulfillment:</span>
                <div className="flex rounded-lg border border-gray-300 overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setFulfillmentMode('RETAIL')}
                    className={`px-4 py-1.5 text-sm font-medium transition-colors ${fulfillmentMode === 'RETAIL'
                      ? 'bg-blue-600 text-white'
                      : 'bg-white text-gray-600 hover:bg-gray-50'
                      }`}
                  >
                    Retail
                  </button>
                  <button
                    type="button"
                    onClick={() => setFulfillmentMode('WHOLESALE')}
                    className={`px-4 py-1.5 text-sm font-medium border-l transition-colors ${fulfillmentMode === 'WHOLESALE'
                      ? 'bg-orange-600 text-white'
                      : 'bg-white text-gray-600 hover:bg-gray-50'
                      }`}
                  >
                    Wholesale
                  </button>
                </div>
                <span className="text-xs text-gray-400">
                  {fulfillmentMode === 'RETAIL' ? 'Quote → POS Sale → Invoice' : 'Quote → Delivery Notes → Invoice'}
                </span>
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
                    onChange={(e) => { setProductSearch(e.target.value); setSearchSelectedIndex(0); }}
                    onKeyDown={handleSearchKeyDown}
                    className="flex-1 px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                    placeholder="Search products by name, SKU, or barcode... (/ or F2 to focus)"
                    autoFocus
                  />
                  <button
                    type="button"
                    onClick={() => {
                      addItem();
                      setTimeout(() => {
                        const lastRow = itemRefs.current[items.length];
                        lastRow?.[0]?.focus();
                      }, 100);
                    }}
                    className="px-3 py-2 text-xs bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg font-medium whitespace-nowrap"
                  >
                    + Custom Line
                  </button>
                </div>

                {/* Search Results Dropdown */}
                {productSearch && productsData && productsData.length > 0 && (
                  <div ref={productListRef} className="mt-1 border border-gray-300 rounded-lg max-h-56 overflow-y-auto bg-white shadow-lg absolute z-20 left-3 right-3">
                    {productsData.slice(0, 10).map((product: StockLevelItem, idx: number) => (
                      <button
                        key={product.product_id}
                        type="button"
                        onClick={() => addProductToItems(product)}
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
                            <span className="text-green-600 font-medium">{formatCurrency(parseFloat(String(product.selling_price || 0)))}</span>
                            <span className="text-gray-400 ml-2">Stk: {Number(product.total_stock || 0)}</span>
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Items Table */}
              {items.length === 0 ? (
                <div className="text-center py-12 text-gray-400">
                  <div className="text-3xl mb-2">📦</div>
                  <p className="text-sm">Search for products above or add a custom line</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-gray-50 text-gray-600 text-xs uppercase tracking-wide">
                        <th className="text-left py-2.5 px-3 w-8">#</th>
                        <th className="text-left py-2.5 px-3">Description</th>
                        <th className="text-right py-2.5 px-3 w-24">Qty</th>
                        <th className="text-left py-2.5 px-3 w-24">UoM</th>
                        <th className="text-right py-2.5 px-3 w-28">Unit Price</th>
                        {showTax && (
                          <th className="text-center py-2.5 px-3 w-16">Tax</th>
                        )}
                        <th className="text-right py-2.5 px-3 w-28">Total</th>
                        <th className="py-2.5 px-3 w-10"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((item, index) => (
                        <tr key={item.id} className="border-t border-gray-100 hover:bg-blue-50/30 focus-within:bg-blue-50/50">
                          <td className="py-2 px-3 text-gray-400 text-xs">{index + 1}</td>
                          <td className="py-2 px-3">
                            <input
                              ref={(el) => {
                                if (!itemRefs.current[index]) itemRefs.current[index] = [null, null, null, null];
                                itemRefs.current[index][0] = el;
                              }}
                              type="text"
                              value={item.description}
                              onChange={(e) => updateItem(index, 'description', e.target.value)}
                              onKeyDown={(e) => handleItemKeyDown(e, index, 0)}
                              className="w-full px-2 py-1 text-sm border border-transparent hover:border-gray-300 focus:border-blue-500 rounded focus:ring-1 focus:ring-blue-500 bg-transparent"
                              placeholder="Item description"
                              required
                            />
                            {item.sku && <span className="text-[10px] text-gray-400 ml-2">SKU: {item.sku}</span>}
                          </td>
                          <td className="py-2 px-3">
                            <input
                              ref={(el) => {
                                if (!itemRefs.current[index]) itemRefs.current[index] = [null, null, null, null];
                                itemRefs.current[index][1] = el;
                              }}
                              type="number"
                              value={item.quantity}
                              onChange={(e) => updateItem(index, 'quantity', parseFloat(e.target.value) || 0)}
                              onKeyDown={(e) => handleQuantityKeyDown(e, index)}
                              className={`w-full px-2 py-1 text-sm text-right border rounded focus:ring-1 focus:ring-blue-500 ${item.stockOnHand !== undefined && item.quantity > item.stockOnHand ? 'border-red-400 bg-red-50' : 'border-transparent hover:border-gray-300 focus:border-blue-500 bg-transparent'}`}
                              min="0"
                              step="1"
                              required
                            />
                            {item.stockOnHand !== undefined && item.quantity > item.stockOnHand && (
                              <p className="text-red-600 text-[10px] text-right">Only {item.stockOnHand} in stock</p>
                            )}
                          </td>
                          <td className="py-2 px-3">
                            <QuotationLineUomSelect
                              productId={item.productId}
                              uomId={item.uomId}
                              uomName={item.uomName}
                              availableUoms={item.availableUoms}
                              atCost={customerIsAtCost(selectedCustomer)}
                              inputRef={(el) => {
                                if (!itemRefs.current[index]) itemRefs.current[index] = [null, null, null, null];
                                itemRefs.current[index][2] = el;
                              }}
                              onKeyDown={(e) => handleItemKeyDown(e, index, 2)}
                              onChange={(nextUomId, nextUomName, nextUnitPrice) => {
                                const updated = [...items];
                                updated[index] = {
                                  ...updated[index],
                                  uomId: nextUomId ?? undefined,
                                  uomName: nextUomName,
                                  ...(nextUnitPrice != null ? { unitPrice: nextUnitPrice } : {}),
                                };
                                setItems(updated);
                              }}
                            />
                          </td>
                          <td className="py-2 px-3">
                            <input
                              ref={(el) => {
                                if (!itemRefs.current[index]) itemRefs.current[index] = [null, null, null, null];
                                itemRefs.current[index][3] = el;
                              }}
                              type="number"
                              value={item.unitPrice}
                              onChange={(e) => updateItem(index, 'unitPrice', parseFloat(e.target.value) || 0)}
                              onKeyDown={(e) => handleItemKeyDown(e, index, 3)}
                              className="w-full px-2 py-1 text-sm text-right border border-transparent hover:border-gray-300 focus:border-blue-500 rounded focus:ring-1 focus:ring-blue-500 bg-transparent"
                              step="1"
                              required
                            />
                          </td>
                          {showTax && (
                            <td className="py-2 px-3 text-center">
                              <input
                                type="checkbox"
                                checked={item.isTaxable}
                                onChange={(e) => updateItem(index, 'isTaxable', e.target.checked)}
                                className="rounded border-gray-300"
                                title={item.isTaxable ? `Tax: ${item.taxRate}%` : 'Not taxable'}
                              />
                            </td>
                          )}
                          <td className="py-2 px-3 text-right font-medium text-gray-900">
                            {formatCurrency(calculateItemTotal(item))}
                          </td>
                          <td className="py-2 px-3">
                            <button
                              type="button"
                              onClick={() => removeItem(index)}
                              className="text-gray-400 hover:text-red-600 text-sm"
                              title="Remove (Ctrl+Del)"
                            >
                              ✕
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Keyboard Shortcuts */}
              <div className="px-3 py-2 border-t border-gray-100 bg-gray-50/50">
                <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[10px] text-gray-400">
                  <span><kbd className="px-1 py-0.5 bg-white border rounded font-mono">/</kbd> Search</span>
                  <span><kbd className="px-1 py-0.5 bg-white border rounded font-mono">↑↓</kbd> Navigate</span>
                  <span><kbd className="px-1 py-0.5 bg-white border rounded font-mono">Enter</kbd> Select/Next</span>
                  <span><kbd className="px-1 py-0.5 bg-white border rounded font-mono">Ins</kbd> Custom line</span>
                  <span><kbd className="px-1 py-0.5 bg-white border rounded font-mono">Ctrl+Del</kbd> Remove</span>
                </div>
              </div>
            </div>

            {/* ═══════════ BOTTOM TABS (Terms / Notes) ═══════════ */}
            <div className="bg-white rounded-lg border border-gray-200">
              <div className="flex border-b border-gray-200">
                <button
                  type="button"
                  onClick={() => setActiveTab('terms')}
                  className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${activeTab === 'terms'
                    ? 'border-blue-600 text-blue-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700'
                    }`}
                >
                  Terms & Conditions
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('notes')}
                  className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${activeTab === 'notes'
                    ? 'border-blue-600 text-blue-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700'
                    }`}
                >
                  Internal Notes
                </button>
              </div>

              <div className="p-4">
                {activeTab === 'terms' && (
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Payment Terms</label>
                      <input
                        type="text"
                        value={paymentTerms}
                        onChange={(e) => setPaymentTerms(e.target.value)}
                        className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                        placeholder="e.g., Net 30"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Delivery Terms</label>
                      <input
                        type="text"
                        value={deliveryTerms}
                        onChange={(e) => setDeliveryTerms(e.target.value)}
                        className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                        placeholder="e.g., 7-14 business days"
                      />
                    </div>
                    <div className="flex items-end">
                      <label className="flex items-center text-sm">
                        <input
                          type="checkbox"
                          checked={requiresApproval}
                          onChange={(e) => setRequiresApproval(e.target.checked)}
                          className="mr-2 rounded border-gray-300"
                        />
                        <span className="text-gray-700">Requires Approval</span>
                      </label>
                    </div>
                    <div className="md:col-span-3">
                      <label className="block text-xs font-medium text-gray-600 mb-1">Terms & Conditions</label>
                      <textarea
                        value={termsAndConditions}
                        onChange={(e) => setTermsAndConditions(e.target.value)}
                        className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                        rows={2}
                        placeholder="Add any special terms or conditions..."
                      />
                    </div>
                  </div>
                )}

                {activeTab === 'notes' && (
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Internal Notes (not shown to customer)</label>
                    <textarea
                      value={internalNotes}
                      onChange={(e) => setInternalNotes(e.target.value)}
                      className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                      rows={3}
                      placeholder="Notes for internal use only..."
                    />
                  </div>
                )}
              </div>
            </div>

          </div>
        </div>

        {/* ── Sticky Footer (Totals) ── */}
        <div className="border-t bg-white px-6 py-3 shrink-0">
          <div className="max-w-7xl mx-auto flex items-center justify-between">
            <div className="flex items-center gap-6 text-sm text-gray-600">
              <span>Items: <strong className="text-gray-900">{items.length}</strong></span>
              {totals.totalDiscount > 0 && (
                <span>Discount: <strong className="text-red-600">-{formatCurrency(totals.totalDiscount)}</strong></span>
              )}
              {showTax && (
                <span>Tax: <strong className="text-gray-900">{formatCurrency(totals.totalTax)}</strong></span>
              )}
            </div>
            <div className="flex items-center gap-4">
              <div className="text-right">
                <div className="text-xs text-gray-500">Total Amount</div>
                <div className="text-2xl font-bold text-blue-600">{formatCurrency(totals.total)}</div>
              </div>
              <button
                type="submit"
                disabled={createQuoteMutation.isPending}
                className="px-8 py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 font-bold text-base shadow disabled:opacity-50"
              >
                {createQuoteMutation.isPending ? 'Creating...' : 'Add Quotation'}
              </button>
            </div>
          </div>
        </div>
      </form>
    </Layout>
  );
}