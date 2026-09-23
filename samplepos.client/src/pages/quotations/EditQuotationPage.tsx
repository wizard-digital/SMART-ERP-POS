/**
 * Edit Quotation Page
 * Edit DRAFT quotations - loads existing data and allows modifications
 */

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-hot-toast';
import quotationApi from '../../api/quotations';
import { api } from '../../utils/api';
import type { Customer } from '@shared/zod/customer';
import type { QuotationItem, UpdateQuotationInput } from '@shared/types/quotation';
import { AxiosError } from 'axios';
import { formatCurrency } from '../../utils/currency';
import Layout from '../../components/Layout';
import { useAuth } from '../../hooks/useAuth';
import { isAuthQueryEnabled } from '../../lib/authQuery';
import CustomerSelector from '../../components/pos/CustomerSelector';
import { DatePicker } from '../../components/ui/date-picker';
import { getBusinessDate, addDaysToDateString } from '../../utils/businessDate';
import {
  adjustQuotationQuantity,
  calculateLineTotal,
  calculateQuotationTotals,
  hasTaxableQuotationLines,
} from '../../utils/quotationCalculations';
import { QuotationLineUomSelect } from '../../components/quotations/QuotationLineUomSelect';
import { useMasterUoms } from '../../hooks/useMasterUoms';
import { displayMasterUomName, pickDefaultMasterUom } from '../../utils/quotationUom';
import {
  buildQuoteLineFromStockProduct,
  displayProductUomName,
  normalizeStockLevelUoms,
  pickDefaultProductUom,
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
  unitCost?: number;
  productType?: string;
  stockOnHand?: number;
}

type StockLevelItem = StockLevelProductRow;

export default function EditQuotationPage() {
  const navigate = useNavigate();
  const { quoteNumber } = useParams<{ quoteNumber: string }>();
  const queryClient = useQueryClient();

  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [customerEmail, setCustomerEmail] = useState('');
  const [reference, setReference] = useState('');
  const [, setDescription] = useState('');
  const [validFrom, setValidFrom] = useState(getBusinessDate());
  const [validUntil, setValidUntil] = useState(
    addDaysToDateString(getBusinessDate(), 30)
  );
  const [items, setItems] = useState<QuoteItem[]>([]);
  const [termsAndConditions, setTermsAndConditions] = useState('');
  const [paymentTerms, setPaymentTerms] = useState('Net 30');
  const [deliveryTerms, setDeliveryTerms] = useState('');
  const [internalNotes, setInternalNotes] = useState('');
  const [requiresApproval, setRequiresApproval] = useState(false);
  const [activeTab, setActiveTab] = useState<'terms' | 'notes'>('terms');

  const { isAuthenticated } = useAuth();
  const { data: masterUoms = [] } = useMasterUoms();
  const defaultMasterUom = useMemo(() => pickDefaultMasterUom(masterUoms), [masterUoms]);

  // Load existing quotation
  const { data: quoteData, isLoading: isLoadingQuote } = useQuery({
    queryKey: ['quotation', quoteNumber],
    queryFn: () => quotationApi.getQuotationByNumber(quoteNumber!),
    enabled: !!quoteNumber && isAuthQueryEnabled(isAuthenticated),
  });

  const quote = quoteData;
  const quotation = quote?.quotation;

  // Populate form when quote loads
  useEffect(() => {
    if (quotation) {
      // Check if quote is editable (any OPEN status)
      if (quotation.status === 'CONVERTED' || quotation.status === 'CANCELLED' || quotation.status === 'EXPIRED') {
        toast.error('Cannot edit a converted, cancelled, or expired quote');
        navigate(`/quotations/${quoteNumber}`);
        return;
      }

      // Set customer data
      if (quotation.customerId) {
        // Load customer if we have ID
        api.customers.getById(quotation.customerId).then((res) => {
          if (res.data.success && res.data.data) {
            setSelectedCustomer(res.data.data as Customer);
          }
        });
      } else {
        // Walk-in customer
        setCustomerName(quotation.customerName || '');
        setCustomerPhone(quotation.customerPhone || '');
        setCustomerEmail(quotation.customerEmail || '');
      }

      // Set quote fields
      setReference(quotation.reference || '');
      setDescription(quotation.description || '');
      setValidFrom(quotation.validFrom);
      setValidUntil(quotation.validUntil);
      setTermsAndConditions(quotation.termsAndConditions || '');
      setPaymentTerms(quotation.paymentTerms || 'Net 30');
      setDeliveryTerms(quotation.deliveryTerms || '');
      setInternalNotes(quotation.internalNotes || '');
      setRequiresApproval(quotation.requiresApproval || false);

      // Set items
      if (quote?.items && Array.isArray(quote.items)) {
        const loadedItems: QuoteItem[] = quote.items.map((item: QuotationItem) => ({
          id: item.id || crypto.randomUUID(),
          productId: item.productId ?? undefined,
          itemType: item.itemType || 'product',
          sku: item.sku ?? undefined,
          description: item.description,
          notes: item.notes ?? undefined,
          quantity: Number(item.quantity),
          unitPrice: Number(item.unitPrice),
          discountAmount: Number(item.discountAmount || 0),
          isTaxable: item.isTaxable || false,
          taxRate: Number(item.taxRate || 0),
          uomId: item.uomId ?? undefined,
          uomName: item.uomName ?? undefined,
          unitCost: item.unitCost != null ? Number(item.unitCost) : undefined,
          productType: item.productType,
        }));
        setItems(loadedItems);
      }
    }
  }, [quotation, quote, quoteNumber, navigate]);

  // Pre-fetch all stock data once — filtering is instant in-memory
  const [productSearch, setProductSearch] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const productListRef = useRef<HTMLDivElement>(null);
  const [searchSelectedIndex, setSearchSelectedIndex] = useState(0);
  // Refs for item row inputs: editItemRefs[rowIndex][fieldIndex]
  // fieldIndex: 0=description, 1=quantity, 2=unitPrice, 3=discount
  const editItemRefs = useRef<(HTMLInputElement | HTMLSelectElement | null)[][]>([]);
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

  // Attach POS catalog UoMs to loaded product lines (enables selling-UoM selector on edit).
  useEffect(() => {
    if (!allStockData?.length || items.length === 0) return;
    setItems((prev) => {
      let changed = false;
      const next = prev.map((item) => {
        if (!item.productId) return item;
        const stock = allStockData.find((s) => s.product_id === item.productId);
        if (!stock) return item;

        const availableUoms = item.availableUoms?.length
          ? item.availableUoms
          : normalizeStockLevelUoms(stock);
        const stockOnHand = Number(stock.total_stock ?? item.stockOnHand ?? 0);

        let uomId = item.uomId;
        let uomName = item.uomName;
        if (!uomName?.trim() && availableUoms.length > 0) {
          const selected = pickDefaultProductUom(availableUoms);
          uomId = selected.uomId.startsWith('default-') ? undefined : selected.uomId;
          uomName = displayProductUomName(selected);
        }

        if (
          item.availableUoms === availableUoms
          && item.stockOnHand === stockOnHand
          && item.uomId === uomId
          && item.uomName === uomName
        ) {
          return item;
        }

        changed = true;
        return {
          ...item,
          availableUoms,
          stockOnHand,
          uomId,
          uomName,
        };
      });
      return changed ? next : prev;
    });
  }, [allStockData, items.length]);

  // Instant client-side filtering — no API call per keystroke
  const products = useMemo(() => {
    if (!productSearch || !allStockData) return [];
    const term = productSearch.toLowerCase();
    return allStockData.filter((item: StockLevelItem) =>
      item.product_name?.toLowerCase().includes(term) ||
      item.sku?.toLowerCase().includes(term) ||
      item.barcode?.toLowerCase().includes(term) ||
      item.generic_name?.toLowerCase().includes(term)
    );
  }, [productSearch, allStockData]);

  // Update mutation
  const updateMutation = useMutation({
    mutationFn: (data: UpdateQuotationInput) => quotationApi.updateQuotation(quotation!.id, data),
    onSuccess: () => {
      toast.success('Quotation updated successfully');
      queryClient.invalidateQueries({ queryKey: ['quotations'] });
      queryClient.invalidateQueries({ queryKey: ['quotation', quoteNumber] });
      navigate(`/quotations/${quoteNumber}`);
    },
    onError: (error: Error) => {
      toast.error((error as AxiosError<{ error?: string }>).response?.data?.error || 'Failed to update quotation');
    },
  });

  // Item management
  const addItem = () => {
    const newItem: QuoteItem = {
      id: crypto.randomUUID(),
      itemType: 'custom',
      description: '',
      quantity: 1,
      unitPrice: 0,
      discountAmount: 0,
      isTaxable: false,
      taxRate: 0,
      uomId: defaultMasterUom?.id,
      uomName: defaultMasterUom ? displayMasterUomName(defaultMasterUom) : '',
    };
    setItems([...items, newItem]);
  };

  const addProductAsItem = (product: StockLevelItem) => {
    const line = buildQuoteLineFromStockProduct(product);
    const newItem: QuoteItem = {
      id: crypto.randomUUID(),
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
      productType: product.product_type,
      stockOnHand: line.stockOnHand,
    };
    setItems([...items, newItem]);
    setProductSearch('');
  };

  const updateItem = (id: string, field: keyof QuoteItem, value: string | number | boolean) => {
    setItems(
      items.map((item) =>
        item.id === id ? { ...item, [field]: value } : item
      )
    );
  };

  const removeItem = (id: string) => {
    setItems(items.filter((item) => item.id !== id));
  };

  const totals = calculateQuotationTotals(items);
  const showTax = hasTaxableQuotationLines(items);

  // ── Keyboard Navigation ──

  // Reset search index when results change
  useEffect(() => {
    setSearchSelectedIndex(0);
  }, [products]);

  // Ensure editItemRefs array has correct size
  useEffect(() => {
    editItemRefs.current = items.map((_, i) => editItemRefs.current[i] || [null, null, null, null]);
  }, [items]);

  // Scroll a search result into view
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

  // Select the highlighted product from search results
  const selectHighlightedProduct = useCallback(() => {
    if (!products || products.length === 0) return;
    const clamped = Math.min(searchSelectedIndex, products.length - 1);
    if (clamped < 0) return;
    addProductAsItem(products[clamped]);
  }, [products, searchSelectedIndex]);

  // Search input keyboard handler
  const handleSearchKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (productSearch) {
        setProductSearch('');
        setSearchSelectedIndex(0);
      }
      return;
    }

    if (!products || products.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSearchSelectedIndex((prev) => {
        const next = Math.min(prev + 1, products.length - 1);
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
  }, [products, productSearch, scrollSearchItemIntoView, selectHighlightedProduct]);

  // Item row keyboard handler — Enter moves to next field/row, Ctrl+Delete removes row
  const handleItemKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement | HTMLSelectElement>, rowIndex: number, fieldIndex: number) => {
    const maxFieldIndex = 4; // description, quantity, uom, unitPrice, discount

    if (e.key === 'Enter') {
      e.preventDefault();
      if (fieldIndex < maxFieldIndex) {
        editItemRefs.current[rowIndex]?.[fieldIndex + 1]?.focus();
      } else {
        if (rowIndex < items.length - 1) {
          editItemRefs.current[rowIndex + 1]?.[0]?.focus();
        } else {
          searchInputRef.current?.focus();
        }
      }
      return;
    }

    if ((e.key === 'Delete' || e.key === 'Backspace') && e.ctrlKey) {
      e.preventDefault();
      const itemId = items[rowIndex]?.id;
      if (itemId) removeItem(itemId);
      setTimeout(() => {
        if (rowIndex > 0) {
          editItemRefs.current[rowIndex - 1]?.[0]?.focus();
        } else {
          searchInputRef.current?.focus();
        }
      }, 50);
      return;
    }

    if (e.key === 'ArrowDown' && e.altKey) {
      e.preventDefault();
      if (rowIndex < items.length - 1) {
        editItemRefs.current[rowIndex + 1]?.[fieldIndex]?.focus();
      }
      return;
    }

    if (e.key === 'ArrowUp' && e.altKey) {
      e.preventDefault();
      if (rowIndex > 0) {
        editItemRefs.current[rowIndex - 1]?.[fieldIndex]?.focus();
      }
      return;
    }
  }, [items]);

  const handleQuantityKeyDown = useCallback((
    e: React.KeyboardEvent<HTMLInputElement>,
    rowIndex: number,
  ) => {
    const item = items[rowIndex];
    if (!item) return;
    const step = e.shiftKey ? 10 : 1;
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      updateItem(item.id, 'quantity', adjustQuotationQuantity(item.quantity, step));
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      updateItem(item.id, 'quantity', adjustQuotationQuantity(item.quantity, -step));
      return;
    }
    handleItemKeyDown(e, rowIndex, 1);
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
          const lastRow = editItemRefs.current[items.length];
          lastRow?.[0]?.focus();
        }, 100);
        return;
      }
    };

    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [items.length]);

  const handleSubmit = () => {
    // Validation
    if (!selectedCustomer && !customerName.trim()) {
      toast.error('Please select or enter a customer');
      return;
    }

    if (items.length === 0) {
      toast.error('Please add at least one item');
      return;
    }

    if (items.some((item) => !item.description.trim())) {
      toast.error('All items must have a description');
      return;
    }

    if (items.some((item) => item.quantity <= 0)) {
      toast.error('All items must have a positive quantity');
      return;
    }

    if (items.some((item) => item.unitPrice < 0)) {
      toast.error('Unit prices cannot be negative');
      return;
    }

    if (items.some((item) => !item.productId && item.itemType === 'custom' && !item.uomId)) {
      toast.error('Select a UoM from the system list for each custom line');
      return;
    }

    // Prepare data
    const quoteData = {
      customerId: selectedCustomer?.id,
      customerName: selectedCustomer ? selectedCustomer.name : customerName,
      customerPhone: (selectedCustomer ? selectedCustomer.phone : customerPhone) || undefined,
      customerEmail: (selectedCustomer ? selectedCustomer.email : customerEmail) || undefined,
      reference: reference || undefined,
      paymentTerms: paymentTerms || undefined,
      deliveryTerms: deliveryTerms || undefined,
      validFrom: validFrom,
      validUntil: validUntil,
      notes: internalNotes || undefined,
      items: items.map((item) => ({
        productId: item.productId,
        itemType: item.itemType,
        sku: item.sku,
        description: item.description,
        notes: item.notes,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        discountAmount: item.discountAmount,
        isTaxable: item.isTaxable,
        taxRate: item.taxRate,
        uomId: item.uomId || undefined, // Convert null to undefined for Zod
        uomName: item.uomName,
        unitCost: item.unitCost,
        productType: item.productType,
      })),
    };

    updateMutation.mutate(quoteData);
  };

  if (isLoadingQuote) {
    return (
      <Layout>
        <div className="p-8 text-center">
          <div className="text-gray-600">Loading quotation...</div>
        </div>
      </Layout>
    );
  }

  if (!quote) {
    return (
      <Layout>
        <div className="p-8 text-center">
          <div className="text-red-600">Quotation not found</div>
          <button
            onClick={() => navigate('/quotations')}
            className="mt-4 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
          >
            Back to Quotations
          </button>
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="flex flex-col h-[calc(100vh-4rem)]">
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
            <h1 className="text-xl font-bold text-gray-900">Edit Quotation</h1>
            {quotation?.quoteNumber && (
              <span className="text-sm text-gray-500 font-mono bg-gray-100 px-2 py-0.5 rounded">{quotation.quoteNumber}</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => navigate(`/quotations/${quoteNumber}`)}
              className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 text-gray-700"
              disabled={updateMutation.isPending}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={updateMutation.isPending}
              className="px-6 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-semibold disabled:opacity-50"
            >
              {updateMutation.isPending ? 'Updating...' : 'Update Quotation'}
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
                  {!selectedCustomer && (
                    <input
                      type="text"
                      value={customerName}
                      onChange={(e) => setCustomerName(e.target.value)}
                      className="w-full mt-2 px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                      placeholder="Or type customer name"
                    />
                  )}
                </div>

                {/* Phone & Email */}
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
                    minDate={validFrom ? new Date(validFrom) : undefined}
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
                    onChange={(e) => { setProductSearch(e.target.value); setSearchSelectedIndex(0); }}
                    onKeyDown={handleSearchKeyDown}
                    className="flex-1 px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                    placeholder="Search products by name, SKU, or barcode... (/ or F2 to focus)"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      addItem();
                      setTimeout(() => {
                        const lastRow = editItemRefs.current[items.length];
                        lastRow?.[0]?.focus();
                      }, 100);
                    }}
                    className="px-3 py-2 text-xs bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg font-medium whitespace-nowrap"
                  >
                    + Custom Line
                  </button>
                </div>

                {/* Search Results Dropdown */}
                {productSearch && products.length > 0 && (
                  <div ref={productListRef} className="mt-1 border border-gray-300 rounded-lg max-h-56 overflow-y-auto bg-white shadow-lg absolute z-20 left-3 right-3">
                    {products.slice(0, 10).map((product: StockLevelItem, idx: number) => (
                      <button
                        key={product.product_id}
                        type="button"
                        onClick={() => addProductAsItem(product)}
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
                        <th className="text-right py-2.5 px-3 w-24">Discount</th>
                        {showTax && (
                          <th className="text-center py-2.5 px-3 w-16">Tax</th>
                        )}
                        <th className="text-right py-2.5 px-3 w-28">Total</th>
                        <th className="py-2.5 px-3 w-10"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((item, rowIndex) => {
                        const itemTotal = calculateLineTotal(item);

                        return (
                          <tr key={item.id} className="border-t border-gray-100 hover:bg-blue-50/30 focus-within:bg-blue-50/50">
                            <td className="py-2 px-3 text-gray-400 text-xs">{rowIndex + 1}</td>
                            <td className="py-2 px-3">
                              <input
                                ref={(el) => {
                                  if (!editItemRefs.current[rowIndex]) editItemRefs.current[rowIndex] = [null, null, null, null, null];
                                  editItemRefs.current[rowIndex][0] = el;
                                }}
                                type="text"
                                value={item.description}
                                onChange={(e) => updateItem(item.id, 'description', e.target.value)}
                                onKeyDown={(e) => handleItemKeyDown(e, rowIndex, 0)}
                                className="w-full px-2 py-1 text-sm border border-transparent hover:border-gray-300 focus:border-blue-500 rounded focus:ring-1 focus:ring-blue-500 bg-transparent"
                                placeholder="Item description"
                              />
                              {item.sku && <span className="text-[10px] text-gray-400 ml-2">SKU: {item.sku}</span>}
                            </td>
                            <td className="py-2 px-3">
                              <input
                                ref={(el) => {
                                  if (!editItemRefs.current[rowIndex]) editItemRefs.current[rowIndex] = [null, null, null, null, null];
                                  editItemRefs.current[rowIndex][1] = el;
                                }}
                                type="number"
                                value={item.quantity}
                                onChange={(e) => updateItem(item.id, 'quantity', parseFloat(e.target.value) || 0)}
                                onKeyDown={(e) => handleQuantityKeyDown(e, rowIndex)}
                                className={`w-full px-2 py-1 text-sm text-right border rounded focus:ring-1 focus:ring-blue-500 ${item.stockOnHand !== undefined && item.quantity > item.stockOnHand ? 'border-red-400 bg-red-50' : 'border-transparent hover:border-gray-300 focus:border-blue-500 bg-transparent'}`}
                                min="0"
                                step="1"
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
                                inputRef={(el) => {
                                  if (!editItemRefs.current[rowIndex]) editItemRefs.current[rowIndex] = [null, null, null, null, null];
                                  editItemRefs.current[rowIndex][2] = el;
                                }}
                                onKeyDown={(e) => handleItemKeyDown(e, rowIndex, 2)}
                                onChange={(uomId, uomName, unitPrice) => {
                                  setItems((prev) =>
                                    prev.map((row) =>
                                      row.id === item.id
                                        ? {
                                            ...row,
                                            uomId: uomId ?? undefined,
                                            uomName,
                                            ...(unitPrice != null ? { unitPrice } : {}),
                                          }
                                        : row
                                    )
                                  );
                                }}
                              />
                            </td>
                            <td className="py-2 px-3">
                              <input
                                ref={(el) => {
                                  if (!editItemRefs.current[rowIndex]) editItemRefs.current[rowIndex] = [null, null, null, null, null];
                                  editItemRefs.current[rowIndex][3] = el;
                                }}
                                type="number"
                                value={item.unitPrice}
                                onChange={(e) => updateItem(item.id, 'unitPrice', parseFloat(e.target.value) || 0)}
                                onKeyDown={(e) => handleItemKeyDown(e, rowIndex, 3)}
                                className="w-full px-2 py-1 text-sm text-right border border-transparent hover:border-gray-300 focus:border-blue-500 rounded focus:ring-1 focus:ring-blue-500 bg-transparent"
                                step="1"
                              />
                            </td>
                            <td className="py-2 px-3">
                              <input
                                ref={(el) => {
                                  if (!editItemRefs.current[rowIndex]) editItemRefs.current[rowIndex] = [null, null, null, null, null];
                                  editItemRefs.current[rowIndex][4] = el;
                                }}
                                type="number"
                                value={item.discountAmount}
                                onChange={(e) => updateItem(item.id, 'discountAmount', parseFloat(e.target.value) || 0)}
                                onKeyDown={(e) => handleItemKeyDown(e, rowIndex, 4)}
                                className="w-full px-2 py-1 text-sm text-right border border-transparent hover:border-gray-300 focus:border-blue-500 rounded focus:ring-1 focus:ring-blue-500 bg-transparent"
                                min="0"
                                step="1"
                              />
                            </td>
                            {showTax && (
                              <td className="py-2 px-3 text-center">
                                <input
                                  type="checkbox"
                                  checked={item.isTaxable}
                                  onChange={(e) => updateItem(item.id, 'isTaxable', e.target.checked)}
                                  className="rounded border-gray-300"
                                  title={item.isTaxable ? `Tax: ${item.taxRate}%` : 'Not taxable'}
                                />
                              </td>
                            )}
                            <td className="py-2 px-3 text-right font-medium text-gray-900">
                              {formatCurrency(itemTotal)}
                            </td>
                            <td className="py-2 px-3">
                              <button
                                type="button"
                                onClick={() => removeItem(item.id)}
                                className="text-gray-400 hover:text-red-600 text-sm"
                                title="Remove (Ctrl+Del)"
                              >
                                ✕
                              </button>
                            </td>
                          </tr>
                        );
                      })}
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
                type="button"
                onClick={handleSubmit}
                disabled={updateMutation.isPending}
                className="px-8 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-bold text-base shadow disabled:opacity-50"
              >
                {updateMutation.isPending ? 'Updating...' : 'Update Quotation'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </Layout>
  );
}