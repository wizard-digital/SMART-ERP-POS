import { useState, useMemo, useEffect } from 'react';
/**
 * Product catalog + detail (spec: ProductDetail.tsx) — route `/inventory/products`
 * Product detail surface: history modal with conditional Stock Distribution tab (multistore only).
 */
import ProductForm, { ProductFormField } from '@/components/products/ProductForm';
import { formatCurrency, parseCurrency } from '../../utils/currency';
import { BUSINESS_RULES } from '../../utils/constants';
import { normalizeProductSaveForType, resolveRestaurantKitchenCatalogFlags } from '@shared/utils/productTypeRules';
import { useRestaurantEnabled } from '../../hooks/useRestaurantEnabled';
// Zod-based form validation
import { validateProductValues } from '@/validation/product';
import { useCreateProduct, useUpdateProduct, useDeleteProduct, productKeys } from '../../hooks/useProducts';
import { useStockLevels } from '../../hooks/useInventory';
import { useSuppliers } from '../../hooks/useSuppliers';
import { useOfflineProducts } from '../../hooks/useOfflineData';
import { useOfflineContext } from '../../contexts/OfflineContext';
import { useMultistoreEnabled } from '../../hooks/useMultistore';
import { useAuth } from '../../hooks/useAuth';
import { hasWarehouseNetworkAccess } from '../../../../shared/utils/warehouseRbac';
import { useStoreLocations, useStockLevelsByStore } from '../../hooks/useWarehouse';
import { StoreLocationSelect } from '../../components/inventory/StoreLocationSelect';
import { StockViewModeToggle } from '../../components/inventory/StockViewModeToggle';
import { InventoryColumnPicker } from '../../components/inventory/InventoryColumnPicker';
import {
  readStockViewMode,
  readStockViewStoreId,
  writeStockViewMode,
  writeStockViewStoreId,
  type StockViewMode,
} from '../../components/inventory/stockViewPrefs';
import {
  operationalNetworkStores,
  retainOrDefaultStockViewStoreId,
  stockQtyByProductId,
  unwrapStockLevelRows,
} from '../../components/inventory/warehouseNetworkUtils';
import { useInventoryColumnPrefs } from '../../hooks/useInventoryColumnPrefs';
import { getErrorMessage, api } from '../../utils/api';
import Decimal from 'decimal.js';
import { computeUomPrices } from '@shared/utils/uom-pricing';
import { useQueryClient } from '@tanstack/react-query';
import { DatePicker } from '../../components/ui/date-picker';
import {
  useProductHistory,
  getHistoryTypeVariant,
  formatQuantityChange,
  isExpiringSoon,
  formatHistoryReference,
  getHistoryActor,
  type ProductHistoryType
} from '../../hooks/useProductHistory';
import { useSubmitOnEnter } from '../../hooks/useSubmitOnEnter';
import { DamagedItemsBanner, OpeningStockDialog } from '../../components/inventory/DamagedItemsBanner';
import { ProductStockDetailCards } from '../../components/inventory/ProductStockDetailCards';
import { MultistoreGate } from '../../components/inventory/MultistoreGate';
import { ProductDistributionPolicySection } from '../../components/inventory/ProductDistributionPolicySection';
import { SortableTableHeader } from '../../components/ui/SortableTableHeader';
import { MobileSortSelect } from '../../components/ui/MobileSortSelect';
import { useColumnSort } from '../../hooks/useColumnSort';
import { applyTableSort } from '../../lib/tableSortUtils';
import {
  AdaptivePage,
  AdaptiveToolbar,
  AdaptiveSearch,
  AdaptiveRowActions,
} from '../../components/adaptive';
import {
  ADAPTIVE_PAGE_PAD_CLASS,
  ADAPTIVE_WORKLIST_DENSITY,
  INVENTORY_WORKLIST_TABLE_CLASS,
  INVENTORY_COL_FILL_CLASS,
  INVENTORY_COL_FIT_CLASS,
} from '../../lib/adaptiveDashboard';

type ProductSortField =
  | 'product'
  | 'category'
  | 'sku'
  | 'pricing'
  | 'margin'
  | 'stock'
  | 'expiry'
  | 'status';

const PRODUCT_DESC_DEFAULT = new Set<ProductSortField>(['pricing', 'margin', 'stock']);

// TIMEZONE STRATEGY: Display dates without conversion
// Backend returns DATE as YYYY-MM-DD string (no timezone)
// Frontend displays as-is without parsing to Date object
const formatDisplayDate = (dateString: string | null | undefined): string => {
  if (!dateString) return 'N/A';

  // If it's an ISO string, extract the date part
  if (dateString.includes('T')) {
    return dateString.split('T')[0];
  }

  return dateString;
};

interface ProductUomRow {
  id: string;
  uomId: string;
  uomName?: string;
  uomSymbol?: string | null;
  uom_name?: string;
  uom_symbol?: string | null;
  conversionFactor: number | string;
  isDefault: boolean;
  overrideCost?: number | string;
  overridePrice?: number | string;
  priceOverride?: number | string;
  costOverride?: number | string;
  uom?: { name?: string; symbol?: string | null };
}

interface ProductListItem extends ProductFormData {
  productUoms?: ProductUomRow[];
  product_uoms?: ProductUomRow[];
}

interface ProductFormData {
  id?: string;
  name: string;
  sku: string;
  barcode: string;
  description: string;
  category: string;
  productType: 'inventory' | 'consumable' | 'service';
  genericName: string;
  conversionFactor: string;
  costPrice: string;
  sellingPrice: string;
  costingMethod: string;
  averageCost: string;
  lastCost: string;
  pricingFormula: string;
  autoUpdatePrice: boolean;
  quantityOnHand: string;
  reorderLevel: string;
  isTaxable: boolean;
  taxRate: string;
  isActive: boolean;
  availableInRestaurant: boolean;
  isPreparedFood: boolean;
  isBuffetCover: boolean;
  trackExpiry: boolean;
  minDaysBeforeExpirySale: string;
  // Procurement fields
  preferredSupplierId: string;
  supplierProductCode: string;
  purchaseUomId: string;
  leadTimeDays: string;
  reorderQuantity: string;
}

interface ProductUomFormData {
  id?: string;
  uomId: string;
  uomName?: string;
  uomSymbol?: string | null;
  conversionFactor: string;
  isDefault: boolean;
  priceOverride?: string;
  costOverride?: string;
}

interface MasterUom {
  id: string;
  name: string;
  symbol?: string | null;
  type: string;
}

const initialFormData: ProductFormData = {
  name: '',
  sku: '',
  barcode: '',
  description: '',
  category: '',
  productType: 'inventory',
  genericName: '',
  conversionFactor: '1',
  costPrice: '',
  sellingPrice: '',
  costingMethod: 'FIFO',
  averageCost: '0',
  lastCost: '0',
  pricingFormula: '',
  autoUpdatePrice: false,
  quantityOnHand: '0',
  reorderLevel: '10',
  isTaxable: false,
  taxRate: '18',
  isActive: true,
  availableInRestaurant: true,
  isPreparedFood: false,
  isBuffetCover: false,
  trackExpiry: false,
  minDaysBeforeExpirySale: '0',
  preferredSupplierId: '',
  supplierProductCode: '',
  purchaseUomId: '',
  leadTimeDays: '0',
  reorderQuantity: '0',
};

export default function ProductsPage() {
  // Offline-awareness
  const { isOnline } = useOfflineContext();
  const { isMultistoreEnabled } = useMultistoreEnabled();
  const { permissions } = useAuth();
  const { data: restaurantEnabled = false } = useRestaurantEnabled();
  const canUseStoreFilter = useMemo(() => {
    if (!isMultistoreEnabled) return false;
    return hasWarehouseNetworkAccess(permissions);
  }, [isMultistoreEnabled, permissions]);
  const [stockViewMode, setStockViewMode] = useState<StockViewMode>(() => readStockViewMode());
  const byStoreView = canUseStoreFilter && stockViewMode === 'store';
  const columnPrefs = useInventoryColumnPrefs('products', { includeStore: byStoreView });
  const { show: showCol } = columnPrefs;
  const { data: storeLocations = [] } = useStoreLocations(canUseStoreFilter && isOnline);
  const networkStores = useMemo(
    () => operationalNetworkStores(storeLocations),
    [storeLocations],
  );
  const [storeFilterId, setStoreFilterIdState] = useState(() => readStockViewStoreId());
  const setStoreFilterId = (id: string) => {
    setStoreFilterIdState(id);
    writeStockViewStoreId(id);
  };
  const useMultistoreStock = byStoreView && isOnline;

  useEffect(() => {
    if (!useMultistoreStock || networkStores.length === 0) return;
    setStoreFilterIdState((current) => {
      const next = retainOrDefaultStockViewStoreId(current, networkStores);
      if (next) writeStockViewStoreId(next);
      return next;
    });
  }, [useMultistoreStock, networkStores]);

  // API Hooks — use offline-aware hook for reading, standard hooks for mutations
  const queryClient = useQueryClient();
  const {
    data: productsResponse,
    isLoading: productsLoading,
    error: productsError,
    refetch: productsRefetch,
  } = useOfflineProducts({ includeUoms: true, limit: 5000 });
  const {
    data: storeStockData,
    isLoading: storeStockLoading,
    error: storeStockError,
    refetch: storeStockRefetch,
  } = useStockLevelsByStore(storeFilterId, useMultistoreStock && !!storeFilterId);
  const { data: companyStockLevels, isLoading: companyStockLoading } = useStockLevels();

  const nearestExpiryByProductId = useMemo(() => {
    const map = new Map<string, string | null>();
    const rows = useMultistoreStock
      ? unwrapStockLevelRows(storeStockData)
      : unwrapStockLevelRows(companyStockLevels);
    for (const row of rows) {
      const productId = row.product_id != null ? String(row.product_id) : '';
      if (!productId) continue;
      map.set(
        productId,
        row.nearest_expiry != null
          ? String(row.nearest_expiry)
          : row.nearestExpiry != null
            ? String(row.nearestExpiry)
            : null,
      );
    }
    return map;
  }, [useMultistoreStock, storeStockData, companyStockLevels]);

  const isLoading =
    productsLoading
    || (useMultistoreStock && storeStockLoading)
    || (isMultistoreEnabled && !byStoreView && isOnline && companyStockLoading);
  const error = productsError ?? (useMultistoreStock ? storeStockError : null);
  const refetch = () => {
    void productsRefetch();
    if (useMultistoreStock) void storeStockRefetch();
  };
  const createProductMutation = useCreateProduct();
  const updateProductMutation = useUpdateProduct();
  const deleteProductMutation = useDeleteProduct();

  // Suppliers for Procurement tab
  const { data: suppliersData } = useSuppliers();
  const suppliersList = useMemo(() => {
    const raw = suppliersData?.data;
    return (Array.isArray(raw) ? raw : []) as Array<{ id: string; name: string }>;
  }, [suppliersData]);

  // Pagination
  const ITEMS_PER_PAGE = 50;
  const [currentPage, setCurrentPage] = useState(1);

  // Local State
  const [searchTerm, setSearchTerm] = useState('');
  const [filterStatus, setFilterStatus] = useState<'all' | 'active' | 'inactive'>('all');
  const [filterCategory, setFilterCategory] = useState<string>('all');
  const [filterStockOnly, setFilterStockOnly] = useState(false);
  const { sortField, sortOrder, handleSort, setSortOrder } =
    useColumnSort<ProductSortField>('product', 'asc');
  const [showModal, setShowModal] = useState(false);
  const [modalMode, setModalMode] = useState<'create' | 'edit'>('create');
  const [formData, setFormData] = useState<ProductFormData>(initialFormData);
  const [productTaxMappings, setProductTaxMappings] = useState<
    Array<{ code?: string | null; name?: string | null; rate?: number | null }>
  >([]);
  const [productTaxMappingsLoading, setProductTaxMappingsLoading] = useState(false);
  /** Settings.tax_inclusive — price-mode SSOT for product tax status copy. */
  const [taxInclusivePricing, setTaxInclusivePricing] = useState(false);
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [productToDelete, setProductToDelete] = useState<string | null>(null);
  const [apiError, setApiError] = useState<string>('');
  const [successMessage, setSuccessMessage] = useState<string>('');
  const [showHistoryModal, setShowHistoryModal] = useState(false);
  const [selectedProductForHistory, setSelectedProductForHistory] = useState<string | null>(null);
  const [historyFilters, setHistoryFilters] = useState<{
    type?: ProductHistoryType;
    startDate?: string;
    endDate?: string;
  }>({});

  // Product UoM State
  const [productUoms, setProductUoms] = useState<ProductUomFormData[]>([]);
  const [masterUoms, setMasterUoms] = useState<MasterUom[]>([]);
  const [showAddUomForm, setShowAddUomForm] = useState(false);
  const [editingUomIndex, setEditingUomIndex] = useState<number | null>(null);
  const [uomFormData, setUomFormData] = useState<ProductUomFormData>({
    uomId: '',
    conversionFactor: '1',
    isDefault: false,
  });
  const [uomAutoApplied, setUomAutoApplied] = useState(false);

  // Load enterprise tax mappings when editing a product (explains "unticked but taxed" cases)
  useEffect(() => {
    if (!showModal || modalMode !== 'edit' || !formData.id || !isOnline) {
      setProductTaxMappings([]);
      setProductTaxMappingsLoading(false);
      return;
    }
    let cancelled = false;
    setProductTaxMappingsLoading(true);
    void api.enterprise
      .productTaxMappings(formData.id)
      .then((res) => {
        if (cancelled) return;
        const rows = (res.data?.data || []) as Array<{
          code?: string;
          name?: string;
          rate?: number;
        }>;
        setProductTaxMappings(
          rows.map((r) => ({
            code: r.code,
            name: r.name,
            rate: r.rate != null ? Number(r.rate) : null,
          })),
        );
      })
      .catch(() => {
        if (!cancelled) setProductTaxMappings([]);
      })
      .finally(() => {
        if (!cancelled) setProductTaxMappingsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [showModal, modalMode, formData.id, isOnline]);

  // Map master UoMs by id for quick lookups and inline validation
  const masterUomById = useMemo(() => {
    const map: Record<string, MasterUom> = {};
    for (const m of masterUoms) map[m.id] = m;
    return map;
  }, [masterUoms]);

  const invalidUomIndexes = useMemo(() => {
    return productUoms
      .map((u, i) => (!u.uomId || !masterUomById[u.uomId] ? i : -1))
      .filter(i => i >= 0);
  }, [productUoms, masterUomById]);

  // Helper: Autofill all missing/invalid UoMs with the first available master UoM
  const handleFixAllMissingUnits = () => {
    if (!invalidUomIndexes.length) return;
    if (!masterUoms || masterUoms.length === 0) {
      setApiError('No master units available. Please add master UoMs first.');
      return;
    }
    const firstMaster = masterUoms[0];
    const prev = productUoms;
    const next = prev.map((u) => (
      !u.uomId || !masterUomById[u.uomId]
        ? {
          ...u,
          uomId: firstMaster.id,
          uomName: firstMaster.name,
          uomSymbol: firstMaster.symbol ?? null,
        }
        : u
    ));
    // Focus the editor on the first previously invalid row for user confirmation
    const firstInvalid = prev.findIndex((u) => !u.uomId || !masterUomById[u.uomId]);
    setProductUoms(next);
    if (firstInvalid >= 0) {
      setEditingUomIndex(firstInvalid);
      setShowAddUomForm(true);
      const fixed = next[firstInvalid];
      setUomFormData({
        uomId: fixed.uomId || '',
        conversionFactor: fixed.conversionFactor || '1',
        isDefault: !!fixed.isDefault,
        priceOverride: fixed.priceOverride || '',
        costOverride: fixed.costOverride || '',
      });
    }
  };

  // Extract products from API response
  const products = useMemo(() => {
    if (!productsResponse?.success || !productsResponse?.data) return [];
    return Array.isArray(productsResponse.data) ? productsResponse.data : [];
  }, [productsResponse]);

  const productById = useMemo(() => {
    const map = new Map<string, ProductListItem>();
    for (const p of products) {
      if (p.id) map.set(p.id, p);
    }
    return map;
  }, [products]);

  const selectedStoreLabel = useMemo(() => {
    if (!storeFilterId) return '';
    const store = networkStores.find((s) => s.id === storeFilterId);
    return store ? `${store.name} (${store.code})` : '';
  }, [storeFilterId, networkStores]);

  const storeStockByProductId = useMemo(
    () => stockQtyByProductId(storeStockData),
    [storeStockData],
  );
  const companyStockByProductId = useMemo(
    () => stockQtyByProductId(companyStockLevels),
    [companyStockLevels],
  );

  /** List qty is inventory stock-levels SSOT, never the catalog product_inventory pool. */
  const catalogProducts = useMemo(() => {
    if (!isMultistoreEnabled) return products;
    const qtyMap = byStoreView ? storeStockByProductId : companyStockByProductId;
    if (byStoreView) {
      return products.map((p) => ({
        ...p,
        quantityOnHand: String(qtyMap.get(p.id!) ?? 0),
      }));
    }
    if (qtyMap.size === 0) return products;
    return products.map((p) => ({
      ...p,
      quantityOnHand: String(qtyMap.get(p.id!) ?? 0),
    }));
  }, [products, isMultistoreEnabled, byStoreView, storeStockByProductId, companyStockByProductId]);

  const handleStockViewModeChange = (mode: StockViewMode) => {
    setStockViewMode(mode);
    writeStockViewMode(mode);
    setCurrentPage(1);
  };

  // Helper function to format quantity with multi-UOM breakdown
  const formatMultiUomQuantity = (product: ProductListItem): string => {
    const baseQuantity = parseFloat(product.quantityOnHand) || 0;

    // Get product UOMs if available
    const productUoms = product.product_uoms || product.productUoms || [];

    if (!productUoms || productUoms.length === 0) {
      // No UOMs defined, show base quantity only
      return `${baseQuantity}`;
    }

    // Sort UOMs by conversion factor (descending) to show largest units first
    const sortedUoms = [...productUoms]
      .filter((uom: ProductUomRow) => Number(uom.conversionFactor) > 1)
      .sort((a: ProductUomRow, b: ProductUomRow) => parseFloat(String(b.conversionFactor)) - parseFloat(String(a.conversionFactor)));

    if (sortedUoms.length === 0) {
      // Only base unit exists
      const baseUom = productUoms.find((u: ProductUomRow) => u.isDefault) || productUoms[0];
      const uomSymbol = baseUom?.uomSymbol || baseUom?.uom_symbol || baseUom?.uomName || baseUom?.uom_name || 'PC';
      return `${baseQuantity} ${uomSymbol}`;
    }

    // Calculate breakdown
    let remainingQty = baseQuantity;
    const breakdown: string[] = [];

    for (const uom of sortedUoms) {
      const conversionFactor = parseFloat(String(uom.conversionFactor));
      if (remainingQty >= conversionFactor) {
        const units = Math.floor(remainingQty / conversionFactor);
        remainingQty = remainingQty % conversionFactor;
        const uomSymbol = uom.uomSymbol || uom.uom_symbol || uom.uomName || uom.uom_name || '';
        breakdown.push(`${units} ${uomSymbol}`);
      }
    }

    // Add remaining base units
    if (remainingQty > 0 || breakdown.length === 0) {
      const baseUom = productUoms.find((u: ProductUomRow) => u.isDefault) || productUoms[0];
      const uomSymbol = baseUom?.uomSymbol || baseUom?.uom_symbol || baseUom?.uomName || baseUom?.uom_name || 'PC';
      breakdown.push(`${remainingQty} ${uomSymbol}`);
    }

    return breakdown.join(' + ');
  };

  // Product history query when detail modal is open
  const { data: historyData, isLoading: historyLoading, error: historyError } = useProductHistory(
    showHistoryModal && selectedProductForHistory ? selectedProductForHistory : '',
    {
      page: 1,
      limit: 50,
      ...historyFilters
    }
  );

  // Load master UoMs when modal opens
  useEffect(() => {
    if (showModal && masterUoms.length === 0) {
      api.products.getMasterUoms()
        .then(response => {
          if (response.data.success && response.data.data) {
            setMasterUoms(response.data.data as MasterUom[]);
          }
        })
        .catch(error => {
          console.error('Failed to load master UoMs:', error);
        });
    }
  }, [showModal, masterUoms.length]);

  // Price-mode SSOT for product tax status panel
  useEffect(() => {
    if (!showModal) return;
    api
      .get<{ success?: boolean; data?: { taxInclusive?: boolean } }>('/system-settings')
      .then((response) => {
        const row = response.data?.data;
        if (row && typeof row.taxInclusive === 'boolean') {
          setTaxInclusivePricing(row.taxInclusive);
        }
      })
      .catch(() => undefined);
  }, [showModal]);

  // Load product UoMs when editing a product
  useEffect(() => {
    if (showModal && modalMode === 'edit' && formData.id) {
      api.products.getProductUoms(formData.id)
        .then(response => {
          if (response.data.success && response.data.data) {
            const uoms = (response.data.data as ProductUomRow[]).map((uom: ProductUomRow) => ({
              id: uom.id,
              uomId: uom.uomId,
              // Prefer flat fields from API; fall back to nested shape if present
              uomName: uom.uomName ?? uom.uom?.name,
              uomSymbol: uom.uomSymbol ?? uom.uom?.symbol,
              conversionFactor: uom.conversionFactor.toString(),
              isDefault: uom.isDefault,
              priceOverride: uom.priceOverride?.toString(),
              costOverride: uom.costOverride?.toString(),
            }));
            setProductUoms(uoms);
          }
        })
        .catch(error => {
          console.error('Failed to load product UoMs:', error);
        });
    } else if (showModal && modalMode === 'create') {
      // Clear UoMs for new product
      setProductUoms([]);
    }
  }, [showModal, modalMode, formData.id]);

  // Calculate profit margin
  const calculateMargin = (cost: string, selling: string): string => {
    if (!cost || !selling) return '0.00';
    try {
      const costDecimal = new Decimal(cost);
      const sellingDecimal = new Decimal(selling);
      if (costDecimal.equals(0)) return '0.00';
      const margin = sellingDecimal.minus(costDecimal).dividedBy(costDecimal).times(100);
      return margin.toFixed(2);
    } catch {
      return '0.00';
    }
  };

  // Generate SKU
  const generateSKU = (): string => {
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `PRD-${timestamp}-${random}`;
  };

  // Derive unique categories from loaded products
  const uniqueCategories = useMemo(() => {
    const cats = new Set<string>();
    for (const p of products) {
      if (p.category) cats.add(p.category);
    }
    return Array.from(cats).sort((a, b) => a.localeCompare(b));
  }, [products]);

  // Filter products
  const filteredProducts = useMemo(() => {
    let filtered = catalogProducts;

    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      filtered = filtered.filter((p: ProductListItem) =>
        String(p.name ?? '').toLowerCase().includes(term) ||
        String(p.sku ?? '').toLowerCase().includes(term) ||
        String(p.barcode ?? '').toLowerCase().includes(term) ||
        String(p.category ?? '').toLowerCase().includes(term)
      );
    }

    if (filterStatus !== 'all') {
      filtered = filtered.filter((p: ProductListItem) =>
        filterStatus === 'active' ? p.isActive : !p.isActive
      );
    }

    if (filterCategory !== 'all') {
      filtered = filtered.filter((p: ProductListItem) =>
        p.category === filterCategory
      );
    }

    return filtered;
  }, [catalogProducts, searchTerm, filterStatus, filterCategory]);

  const productSortAccessors = useMemo(
    () => ({
      product: (p: ProductListItem) => p.name ?? '',
      category: (p: ProductListItem) => p.category ?? '',
      sku: (p: ProductListItem) => `${p.sku ?? ''} ${p.barcode ?? ''}`.trim(),
      pricing: (p: ProductListItem) => parseFloat(p.sellingPrice) || 0,
      margin: (p: ProductListItem) => parseFloat(calculateMargin(p.costPrice, p.sellingPrice)) || 0,
      stock: (p: ProductListItem) => parseFloat(p.quantityOnHand) || 0,
      expiry: (p: ProductListItem) => nearestExpiryByProductId.get(p.id!) ?? '',
      status: (p: ProductListItem) => (p.isActive ? 1 : 0),
    }),
    // calculateMargin is stable per render; accessors recreated when products filter changes
    [products.length, searchTerm, filterStatus, filterCategory, nearestExpiryByProductId],
  );

  const handleColumnSort = (field: string) => {
    const f = field as ProductSortField;
    if (f === 'stock') {
      setFilterStockOnly(true);
      handleSort(f, { defaultOrder: 'desc' });
      return;
    }
    setFilterStockOnly(false);
    handleSort(f, {
      defaultOrder: PRODUCT_DESC_DEFAULT.has(f) ? 'desc' : 'asc',
    });
  };

  const mobileSortOptions = [
    { value: 'product', label: 'Sort by Product' },
    { value: 'category', label: 'Sort by Category' },
    { value: 'sku', label: 'Sort by SKU/Barcode' },
    { value: 'pricing', label: 'Sort by Price' },
    { value: 'margin', label: 'Sort by Margin' },
    { value: 'stock', label: 'Sort by Stock' },
    { value: 'expiry', label: 'Sort by Expiry' },
    { value: 'status', label: 'Sort by Status' },
  ];

  const sortedProducts = useMemo(() => {
    let rows = [...filteredProducts];
    if (filterStockOnly) {
      rows = rows.filter((p) => (parseFloat(p.quantityOnHand) || 0) > 0);
    }
    return applyTableSort(rows, sortField, sortOrder, productSortAccessors);
  }, [filteredProducts, filterStockOnly, sortField, sortOrder, productSortAccessors]);

  // Reset page when filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [searchTerm, filterStatus, filterCategory, filterStockOnly, sortField, sortOrder, storeFilterId, stockViewMode]);

  const tableColSpan = useMemo(() => {
    const ids = [
      'product',
      'category',
      'sku',
      'pricing',
      'margin',
      ...(byStoreView ? (['store'] as const) : []),
      'stock',
      'expiry',
      'status',
      'actions',
    ];
    return ids.filter((id) => showCol(id)).length;
  }, [byStoreView, showCol]);

  // Paginated products
  const totalPages = Math.max(1, Math.ceil(sortedProducts.length / ITEMS_PER_PAGE));
  const paginatedProducts = useMemo(() => {
    const start = (currentPage - 1) * ITEMS_PER_PAGE;
    return sortedProducts.slice(start, start + ITEMS_PER_PAGE);
  }, [sortedProducts, currentPage]);

  // Validate form (Zod + duplicate SKU check + UOM check)
  const validateForm = (): boolean => {
    const z = validateProductValues({
      name: formData.name,
      sku: formData.sku,
      barcode: formData.barcode,
      description: formData.description,
      category: formData.category,
      productType: formData.productType,
      costPrice: formData.costPrice,
      sellingPrice: formData.sellingPrice,
      costingMethod: formData.costingMethod,
      isTaxable: formData.isTaxable,
      taxRate: formData.taxRate,
      pricingFormula: formData.pricingFormula,
      autoUpdatePrice: formData.autoUpdatePrice,
      reorderLevel: formData.reorderLevel,
      trackExpiry: formData.trackExpiry,
      isActive: formData.isActive,
      genericName: formData.genericName,
      minDaysBeforeExpirySale: formData.minDaysBeforeExpirySale,
      preferredSupplierId: formData.preferredSupplierId,
      supplierProductCode: formData.supplierProductCode,
      purchaseUomId: formData.purchaseUomId,
      leadTimeDays: formData.leadTimeDays,
      reorderQuantity: formData.reorderQuantity,
      availableInRestaurant: formData.availableInRestaurant,
      isPreparedFood: formData.isPreparedFood,
      isBuffetCover: formData.isBuffetCover,
    }, modalMode === 'edit' ? 'update' : 'create');

    const errors: Record<string, string> = { ...(z.valid ? {} : z.errors) };

    // Duplicate SKU (client-side check)
    const duplicateSKU = products.find(p =>
      String(p.sku ?? '').toLowerCase() === String(formData.sku ?? '').toLowerCase() && p.id !== formData.id
    );
    if (duplicateSKU) {
      errors.sku = 'SKU already exists';
    }

    // Require at least one product UOM
    if (modalMode === 'create' && productUoms.length === 0) {
      errors.productUoms = 'Please add at least one unit of measure';
    }

    setValidationErrors(errors);
    return Object.keys(errors).length === 0;
  };

  // Handle create
  const handleCreate = () => {
    setModalMode('create');
    setFormData({
      ...initialFormData,
      sku: generateSKU()
    });
    setValidationErrors({});
    setShowModal(true);
  };

  // Handle edit
  const handleEdit = (product: ProductListItem) => {
    setModalMode('edit');
    // Normalize possible null/undefined fields from API into safe defaults for controlled inputs
    // Use String() for all text fields as they may come from DB as non-string types
    setFormData({
      ...initialFormData,
      ...product,
      name: String(product.name ?? ''),
      sku: String(product.sku ?? ''),
      barcode: String(product.barcode ?? ''),
      description: String(product.description ?? ''),
      category: String(product.category ?? ''),
      productType:
        product.productType === 'service' || product.productType === 'consumable'
          ? product.productType
          : 'inventory',
      genericName: String(product.genericName ?? ''),
      conversionFactor: String(product.conversionFactor ?? initialFormData.conversionFactor),
      costPrice: String(product.costPrice ?? ''),
      sellingPrice: String(product.sellingPrice ?? ''),
      costingMethod: product.costingMethod ?? initialFormData.costingMethod,
      averageCost: String(product.averageCost ?? initialFormData.averageCost),
      lastCost: String(product.lastCost ?? initialFormData.lastCost),
      pricingFormula: String(product.pricingFormula ?? ''),
      autoUpdatePrice: product.autoUpdatePrice ?? initialFormData.autoUpdatePrice,
      quantityOnHand: String(
        (product.id ? productById.get(product.id)?.quantityOnHand : undefined)
          ?? product.quantityOnHand
          ?? initialFormData.quantityOnHand,
      ),
      reorderLevel: String(product.reorderLevel ?? initialFormData.reorderLevel),
      isTaxable: product.isTaxable ?? false,
      taxRate: String(product.taxRate ?? initialFormData.taxRate),
      isActive: product.isActive ?? true,
      availableInRestaurant: product.availableInRestaurant !== false,
      isPreparedFood: Boolean((product as { isPreparedFood?: boolean }).isPreparedFood),
      isBuffetCover: Boolean((product as { isBuffetCover?: boolean }).isBuffetCover),
      trackExpiry: product.trackExpiry ?? false,
      minDaysBeforeExpirySale: String(product.minDaysBeforeExpirySale ?? '0'),
      preferredSupplierId: String(product.preferredSupplierId ?? ''),
      supplierProductCode: String(product.supplierProductCode ?? ''),
      purchaseUomId: String(product.purchaseUomId ?? ''),
      leadTimeDays: String(product.leadTimeDays ?? '0'),
      reorderQuantity: String(product.reorderQuantity ?? '0'),
    });
    setValidationErrors({});
    setShowModal(true);
  };

  // Handle save
  const handleSave = async () => {
    if (!validateForm()) {
      return;
    }

    // Block saving if any Product UoM rows are invalid (missing or deleted master UoM)
    if (invalidUomIndexes.length > 0) {
      setApiError('Some units are invalid or missing. Please select a valid unit for all rows.');
      return;
    }

    try {
      setApiError('');

      const baseFormUom = productUoms.find((u) => u.isDefault) ?? productUoms[0];

      const isService = formData.productType === 'service';
      const kitchenFlags = resolveRestaurantKitchenCatalogFlags(
        restaurantEnabled,
        {
          isPreparedFood: formData.isPreparedFood,
          isBuffetCover: formData.isBuffetCover,
        },
        { isService },
      );

      // Convert form data to API format matching backend schema
      const productData = normalizeProductSaveForType({
        name: formData.name,
        sku: formData.sku,
        unitOfMeasure: baseFormUom?.uomName || undefined,
        barcode: formData.barcode || undefined,
        description: formData.description || undefined,
        category: formData.category || undefined,
        productType: formData.productType || 'inventory',
        availableInRestaurant: formData.availableInRestaurant !== false,
        isPreparedFood: kitchenFlags.isPreparedFood,
        isBuffetCover: kitchenFlags.isBuffetCover,
        conversionFactor: parseFloat(formData.conversionFactor) || 1.0,
        costPrice: parseFloat(formData.costPrice) || 0,
        sellingPrice: parseFloat(formData.sellingPrice) || 0,
        isTaxable: !!formData.isTaxable,
        // When VAT is unticked, clear bridge rate so saved master matches SSOT
        taxRate: formData.isTaxable ? parseFloat(formData.taxRate) || 0 : 0,
        costingMethod: formData.costingMethod as 'FIFO' | 'AVCO' | 'STANDARD',
        averageCost: parseFloat(formData.averageCost) || 0,
        lastCost: parseFloat(formData.lastCost) || 0,
        pricingFormula: formData.pricingFormula || undefined,
        autoUpdatePrice: !!formData.autoUpdatePrice,
        quantityOnHand: parseFloat(formData.quantityOnHand) || 0,
        reorderLevel: parseFloat(formData.reorderLevel) || 0,
        trackExpiry: !!formData.trackExpiry,
        genericName: formData.genericName || undefined,
        minDaysBeforeExpirySale: parseInt(formData.minDaysBeforeExpirySale) || 0,
        preferredSupplierId: formData.preferredSupplierId || undefined,
        supplierProductCode: formData.supplierProductCode || undefined,
        purchaseUomId: formData.purchaseUomId || undefined,
        leadTimeDays: parseInt(formData.leadTimeDays) || 0,
        reorderQuantity: parseFloat(formData.reorderQuantity) || 0,
      });

      // API expects undefined (omit) rather than null for optional UUID clears on create
      if (isService) {
        (productData as { preferredSupplierId?: string | null }).preferredSupplierId = undefined;
        (productData as { supplierProductCode?: string | null }).supplierProductCode = undefined;
        (productData as { purchaseUomId?: string | null }).purchaseUomId = undefined;
        (productData as { pricingFormula?: string | null }).pricingFormula = undefined;
      }

      let productId: string;

      if (modalMode === 'create') {
        const createResponse = await createProductMutation.mutateAsync(productData);
        const createdProduct = createResponse.data as { id: string } | undefined;
        productId = createdProduct?.id || '';

        // Save product UoMs for new product (one at a time to avoid pool exhaustion)
        if (productUoms.length > 0 && productId) {
          for (const uom of productUoms) {
            await api.products.addProductUom(productId, {
              uomId: uom.uomId,
              conversionFactor: parseFloat(uom.conversionFactor),
              isDefault: uom.isDefault,
              overrideCost: uom.costOverride ? parseFloat(uom.costOverride) : undefined,
              overridePrice: uom.priceOverride ? parseFloat(uom.priceOverride) : undefined,
            });
          }
          // Invalidate product detail to refresh UoM data
          queryClient.invalidateQueries({ queryKey: productKeys.detail(productId) });
        }

        setSuccessMessage('Product created successfully!');
      } else {
        productId = formData.id!;
        await updateProductMutation.mutateAsync({
          id: productId,
          data: productData
        });

        // Close modal immediately after successful product update
        setShowModal(false);
        setFormData(initialFormData);
        setSuccessMessage('Product updated successfully!');
        setTimeout(() => setSuccessMessage(''), 3000);

        // Handle UoM changes in background (non-blocking, serialized to avoid pool exhaustion)
        try {
          const existingUoms = await api.products.getProductUoms(productId);
          const existingUomIds = existingUoms.data.success && existingUoms.data.data
            ? (existingUoms.data.data as ProductUomRow[]).map((u: ProductUomRow) => u.id)
            : [];

          // Delete removed UoMs (one at a time)
          const currentUomIds = productUoms.filter(u => u.id && u.id.trim() !== '').map(u => u.id);
          const toDelete = existingUomIds.filter((id: string) => id && !currentUomIds.includes(id));
          for (const id of toDelete) {
            await api.products.deleteProductUom(productId, id);
          }

          // Update existing and add new UoMs (one at a time) - filter out entries with empty uomId
          // Sort so the default (base) UoM is always processed first — the backend requires
          // base_uom_id to be set before any non-default canonical conversions can be added.
          const validUoms = productUoms
            .filter(uom => uom.uomId && uom.uomId.trim() !== '')
            .sort((a, b) => {
              if (a.isDefault === b.isDefault) return 0;
              return a.isDefault ? -1 : 1;
            });
          for (const uom of validUoms) {
            if (uom.id && uom.id.trim() !== '') {
              const updateData = {
                uomId: uom.uomId,
                conversionFactor: parseFloat(uom.conversionFactor),
                isDefault: uom.isDefault,
                overrideCost: uom.costOverride ? parseFloat(uom.costOverride) : undefined,
                overridePrice: uom.priceOverride ? parseFloat(uom.priceOverride) : undefined,
              };
              await api.products.updateProductUom(productId, uom.id, updateData);
            } else {
              const addData = {
                uomId: uom.uomId,
                conversionFactor: parseFloat(uom.conversionFactor),
                isDefault: uom.isDefault,
                overrideCost: uom.costOverride ? parseFloat(uom.costOverride) : undefined,
                overridePrice: uom.priceOverride ? parseFloat(uom.priceOverride) : undefined,
              };
              await api.products.addProductUom(productId, addData);
            }
          }
        } catch (uomError) {
          const uomErrorMsg = getErrorMessage(uomError);
          console.error('Failed to update UoMs:', uomErrorMsg);
          alert(`Product saved, but failed to update Units of Measure: ${uomErrorMsg}`);
        }

        // Invalidate product detail to refresh UoM data immediately
        queryClient.invalidateQueries({ queryKey: productKeys.detail(productId) });
        queryClient.invalidateQueries({ queryKey: productKeys.lists() });
        setProductUoms([]);
        return; // Exit early since we already handled everything
      }

      setShowModal(false);
      setFormData(initialFormData);
      setProductUoms([]);

      // Clear success message after 3 seconds
      setTimeout(() => setSuccessMessage(''), 3000);
    } catch (error) {
      const errorMsg = getErrorMessage(error);
      setApiError(errorMsg);
      console.error('Failed to save product:', errorMsg);
    }
  };

  // Handle delete
  const handleDeleteClick = (productId: string) => {
    setProductToDelete(productId);
    setShowDeleteConfirm(true);
  };

  const handleDeleteConfirm = async () => {
    if (!productToDelete) return;

    try {
      setApiError('');
      await deleteProductMutation.mutateAsync(productToDelete);
      setSuccessMessage('Product deleted successfully!');
      setProductToDelete(null);
      setShowDeleteConfirm(false);

      // Clear success message after 3 seconds
      setTimeout(() => setSuccessMessage(''), 3000);
    } catch (error) {
      const errorMsg = getErrorMessage(error);
      setApiError(errorMsg);
      console.error('Failed to delete product:', errorMsg);
      setShowDeleteConfirm(false);
    }
  };

  // Handle view history
  const handleViewHistory = (productId: string) => {
    setSelectedProductForHistory(productId);
    setShowHistoryModal(true);
    setHistoryFilters({});
  };

  // Get product name for history modal
  const selectedProductName = useMemo(() => {
    if (!selectedProductForHistory) return '';
    const product = products.find(p => p.id === selectedProductForHistory);
    return product?.name || '';
  }, [selectedProductForHistory, products]);

  const selectedProductWithUom = useMemo(() => {
    if (!selectedProductForHistory) return null;
    return products.find(p => p.id === selectedProductForHistory);
  }, [selectedProductForHistory, products]);

  const selectedProductUnitCost = useMemo(() => {
    const p = selectedProductWithUom as { costPrice?: number; cost_price?: number } | null;
    return Number(p?.costPrice ?? p?.cost_price ?? 0) || 0;
  }, [selectedProductWithUom]);

  const closeHistoryModal = () => {
    setShowHistoryModal(false);
    setSelectedProductForHistory(null);
    setHistoryFilters({});
  };

  // Handle form field change
  const handleFieldChange = (field: keyof ProductFormData, value: string | boolean) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
    // Clear validation error for this field
    if (validationErrors[field]) {
      setValidationErrors((prev) => ({ ...prev, [field]: '' }));
    }
  };

  // Product UoM Handlers
  const handleAddUomClick = () => {
    const hasBaseUom = productUoms.some((u) => u.isDefault);
    setUomFormData({
      uomId: '',
      conversionFactor: '1',
      isDefault: !hasBaseUom,
    });
    setUomAutoApplied(false);
    setEditingUomIndex(null);
    setShowAddUomForm(true);
  };

  const handleEditUomClick = (index: number) => {
    const uom = productUoms[index];
    // Format values to reduce decimal places when populating form
    setUomFormData({
      ...uom,
      conversionFactor: parseFloat(uom.conversionFactor).toString(),
      costOverride: uom.costOverride ? Math.round(parseFloat(uom.costOverride)).toString() : undefined,
      priceOverride: uom.priceOverride ? Math.round(parseFloat(uom.priceOverride)).toString() : undefined,
    });
    setUomAutoApplied(false);
    setEditingUomIndex(index);
    setShowAddUomForm(true);
  };

  const handleDeleteUomClick = async (index: number) => {
    const uomToDelete = productUoms[index];

    // If editing an existing product and UoM has an ID, delete from database immediately
    if (formData.id && uomToDelete.id) {
      if (!confirm(`Delete unit "${uomToDelete.uomName}"? This cannot be undone.`)) {
        return;
      }

      try {
        await api.products.deleteProductUom(formData.id, uomToDelete.id);

        // Update local state
        setProductUoms(productUoms.filter((_, i) => i !== index));

        // Invalidate cache to refresh immediately
        queryClient.invalidateQueries({ queryKey: productKeys.detail(formData.id) });
        queryClient.invalidateQueries({ queryKey: productKeys.lists() });

        setSuccessMessage('Unit of measure deleted successfully!');
        setTimeout(() => setSuccessMessage(''), 3000);
      } catch (error) {
        const errorMsg = getErrorMessage(error);
        setApiError(errorMsg);
        console.error('Failed to delete UoM:', errorMsg);
      }
    } else {
      // Just remove from local state (for new products or unsaved UoMs)
      setProductUoms(productUoms.filter((_, i) => i !== index));
    }
  };

  const handleSaveUom = async () => {
    // Validation
    if (!uomFormData.uomId) {
      setApiError('Please select a unit of measure');
      return;
    }

    const conversionFactor = parseFloat(uomFormData.conversionFactor);
    if (isNaN(conversionFactor) || conversionFactor <= 0) {
      setApiError('Conversion factor must be greater than 0');
      return;
    }

    // Check for duplicates
    const isDuplicate = productUoms.some((uom, index) =>
      uom.uomId === uomFormData.uomId && index !== editingUomIndex
    );
    if (isDuplicate) {
      setApiError('This unit of measure is already configured');
      return;
    }

    // Get master UoM details
    const masterUom = masterUoms.find(m => m.id === uomFormData.uomId);
    const uomWithDetails = {
      ...uomFormData,
      uomName: masterUom?.name,
      uomSymbol: masterUom?.symbol,
    };

    if (editingUomIndex !== null) {
      // Update existing
      const updated = [...productUoms];
      updated[editingUomIndex] = uomWithDetails;
      setProductUoms(updated);

      // If editing an existing product (has formData.id), save UoM change immediately
      if (formData.id && uomWithDetails.id) {
        try {
          await api.products.updateProductUom(formData.id, uomWithDetails.id, {
            uomId: uomWithDetails.uomId,
            conversionFactor: parseFloat(uomWithDetails.conversionFactor),
            isDefault: uomWithDetails.isDefault,
            overrideCost: uomWithDetails.costOverride ? parseFloat(uomWithDetails.costOverride) : undefined,
            overridePrice: uomWithDetails.priceOverride ? parseFloat(uomWithDetails.priceOverride) : undefined,
          });

          // Invalidate cache to refresh immediately
          queryClient.invalidateQueries({ queryKey: productKeys.detail(formData.id) });
          queryClient.invalidateQueries({ queryKey: productKeys.lists() });

          setSuccessMessage('Unit of measure updated successfully!');
          setTimeout(() => setSuccessMessage(''), 3000);
        } catch (error) {
          const errorMsg = getErrorMessage(error);
          setApiError(errorMsg);
          console.error('Failed to update UoM:', errorMsg);
          return;
        }
      }
    } else {
      // Add new
      setProductUoms([...productUoms, uomWithDetails]);

      // If editing an existing product (has formData.id), save new UoM immediately
      if (formData.id) {
        try {
          const response = await api.products.addProductUom(formData.id, {
            uomId: uomWithDetails.uomId,
            conversionFactor: parseFloat(uomWithDetails.conversionFactor),
            isDefault: uomWithDetails.isDefault,
            overrideCost: uomWithDetails.costOverride ? parseFloat(uomWithDetails.costOverride) : undefined,
            overridePrice: uomWithDetails.priceOverride ? parseFloat(uomWithDetails.priceOverride) : undefined,
          });

          // Update local state with returned ID
          const addedUomData = response.data?.data as { id?: string } | undefined;
          const newUomWithId = {
            ...uomWithDetails,
            id: addedUomData?.id,
          };
          setProductUoms([...productUoms, newUomWithId]);

          // Invalidate cache to refresh immediately
          queryClient.invalidateQueries({ queryKey: productKeys.detail(formData.id) });
          queryClient.invalidateQueries({ queryKey: productKeys.lists() });

          setSuccessMessage('Unit of measure added successfully!');
          setTimeout(() => setSuccessMessage(''), 3000);
        } catch (error) {
          const errorMsg = getErrorMessage(error);
          setApiError(errorMsg);
          console.error('Failed to add UoM:', errorMsg);
          return;
        }
      }
    }

    setShowAddUomForm(false);
    setApiError('');
  };

  const handleCancelUom = () => {
    setShowAddUomForm(false);
    setEditingUomIndex(null);
    const hasBaseUom = productUoms.some((u) => u.isDefault);
    setUomFormData({
      uomId: '',
      conversionFactor: '1',
      isDefault: !hasBaseUom,
    });
    setUomAutoApplied(false);
  };

  const handleSetDefaultUom = (index: number) => {
    const updated = productUoms.map((uom, i) => ({
      ...uom,
      isDefault: i === index,
    }));
    setProductUoms(updated);
  };

  // Persist auto-calculated MUoM values into overrides when empty
  useEffect(() => {
    if (!showAddUomForm) return;
    const baseCost = parseFloat(formData.costPrice || '0') || 0;
    const selling = parseFloat(formData.sellingPrice || '0') || 0;
    const factor = parseFloat(uomFormData.conversionFactor || '0');
    if (!baseCost || !factor || factor <= 0) return;

    const defaultMultiplier = baseCost > 0 && selling > 0 ? selling / baseCost : 1.2;
    // Only apply if overrides are empty to avoid clobbering user input
    const needsCost = !uomFormData.costOverride || uomFormData.costOverride === '';
    const needsPrice = !uomFormData.priceOverride || uomFormData.priceOverride === '';
    if (!needsCost && !needsPrice && uomAutoApplied) return;

    try {
      // Get base UOM name from first productUom or use fallback
      const baseUomName = productUoms[0]?.uomName || 'UNIT';

      const result = computeUomPrices({
        baseCost,
        baseUomName,
        units: [{ name: 'UNIT', factor }],
        defaultMultiplier,
        currencyDecimals: 0,
      });
      const row = result.rows[0];
      const next: ProductUomFormData = { ...uomFormData };
      if (needsCost) next.costOverride = String(row.unitCost);
      if (needsPrice) next.priceOverride = String(row.sellingPrice);
      if (needsCost || needsPrice) {
        setUomFormData(next);
        setUomAutoApplied(true);
      }
    } catch {
      // UoM auto-fill is best-effort when product row data is incomplete
    }
  }, [showAddUomForm, uomFormData.conversionFactor, formData.costPrice, formData.sellingPrice, productUoms]);

  useSubmitOnEnter(showModal, !createProductMutation.isPending && !updateProductMutation.isPending, handleSave);

  const [openingStockProduct, setOpeningStockProduct] = useState<{ id: string; name: string; sku: string } | null>(null);

  return (
    <div data-products-page="true">
      {!isOnline && (
        <div className="mx-3 mt-3 sm:mx-6 sm:mt-4 bg-amber-50 border border-amber-200 rounded-lg p-3 flex items-center gap-2 text-amber-800 text-sm">
          <span className="inline-block w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
          Offline — showing cached products (read-only). Create/edit/delete require an internet connection.
        </div>
      )}

      {isOnline && (
        <div className="px-3 pt-3 sm:px-6 sm:pt-4">
          <DamagedItemsBanner />
        </div>
      )}

      <AdaptivePage
        className={ADAPTIVE_PAGE_PAD_CLASS}
        title="Products"
        description={
          isOnline
            ? 'Manage product catalog with bank-grade precision'
            : 'Viewing cached product catalog (offline)'
        }
        densityOverride={ADAPTIVE_WORKLIST_DENSITY}
        toolbarInline
        toolbar={
          <div className="space-y-2" data-products-filters="true">
            {canUseStoreFilter ? (
              <StockViewModeToggle mode={stockViewMode} onChange={handleStockViewModeChange} />
            ) : null}
            <AdaptiveToolbar
              modeOverride="compact"
              actionsBeforeLeading
              leading={
                <AdaptiveSearch
                  value={searchTerm}
                  onChange={setSearchTerm}
                  placeholder="Search by name, SKU, barcode, or category..."
                  label="Search products"
                  presentationOverride="compact"
                />
              }
              secondaryLabel="Filters"
              secondary={({ close }) => (
                <div className="space-y-3 w-full" data-products-filter-panel="true">
                  <div className={`grid grid-cols-1 gap-3 ${byStoreView ? 'sm:grid-cols-2' : ''}`}>
                    {byStoreView ? (
                      <StoreLocationSelect
                        id="filter-store-location-products"
                        label="Warehouse or shop"
                        stores={networkStores}
                        value={storeFilterId}
                        onChange={setStoreFilterId}
                      />
                    ) : null}
                    <div>
                      <label htmlFor="filter-category" className="block text-sm font-medium text-gray-700 mb-1">
                        Category
                      </label>
                      <select
                        id="filter-category"
                        value={filterCategory}
                        onChange={(e) => {
                          setFilterCategory(e.target.value);
                          close();
                        }}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent min-h-[var(--layout-touch-target)]"
                      >
                        <option value="all">All Categories</option>
                        {uniqueCategories.map((cat) => (
                          <option key={cat} value={cat}>{cat}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label htmlFor="filter-status" className="block text-sm font-medium text-gray-700 mb-1">
                        Status
                      </label>
                      <select
                        id="filter-status"
                        value={filterStatus}
                        onChange={(e) => {
                          setFilterStatus(e.target.value as 'all' | 'active' | 'inactive');
                          close();
                        }}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent min-h-[var(--layout-touch-target)]"
                      >
                        <option value="all">All Products</option>
                        <option value="active">Active Only</option>
                        <option value="inactive">Inactive Only</option>
                      </select>
                    </div>
                  </div>
                </div>
              )}
              more={
                <>
                  <MobileSortSelect
                    presentation="menu"
                    sortField={sortField}
                    sortOrder={sortOrder}
                    options={mobileSortOptions}
                    onFieldChange={handleColumnSort}
                    onToggleOrder={() => setSortOrder((o) => (o === 'asc' ? 'desc' : 'asc'))}
                  />
                  <InventoryColumnPicker
                    presentation="menu"
                    catalog={columnPrefs.catalog}
                    visibleIds={columnPrefs.visibleIds}
                    visibleCount={columnPrefs.visibleCount}
                    totalCount={columnPrefs.totalCount}
                    onToggle={columnPrefs.toggle}
                    onResetDefaults={columnPrefs.resetDefaults}
                  />
                </>
              }
            >
              <button
                type="button"
                onClick={handleCreate}
                disabled={!isOnline}
                className={`inline-flex items-center justify-center rounded-lg px-3 py-2 text-sm font-medium min-h-[var(--layout-touch-target)] ${
                  isOnline
                    ? 'bg-blue-600 text-white hover:bg-blue-700'
                    : 'bg-gray-300 text-gray-500 cursor-not-allowed'
                }`}
                data-products-primary-cta="true"
              >
                + Add Product
              </button>
            </AdaptiveToolbar>
          </div>
        }
      >
      {successMessage && (
        <div className="p-3 bg-green-50 border border-green-200 rounded-lg">
          <p className="text-sm text-green-800">✓ {successMessage}</p>
        </div>
      )}

      {apiError && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg">
          <p className="text-sm text-red-800">❌ {apiError}</p>
        </div>
      )}

      {isLoading && (
        <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg">
          <p className="text-sm text-blue-800">Loading products...</p>
        </div>
      )}

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg">
          <p className="text-sm text-red-800">Failed to load products: {getErrorMessage(error)}</p>
          <button
            type="button"
            onClick={() => refetch()}
            className="mt-2 text-sm text-red-600 hover:text-red-800 font-medium"
          >
            Try Again
          </button>
        </div>
      )}

      {/* Products Table */}
      <div className="bg-white rounded-lg border border-gray-100 shadow-sm overflow-hidden">
        {filterStockOnly && (
          <div className="px-4 py-2 bg-amber-50 border-b border-amber-100 text-xs text-amber-900 flex items-center justify-between">
            <span>Showing products with stock on hand only ({sortedProducts.length})</span>
            <button
              type="button"
              className="text-amber-800 underline"
              onClick={() => {
                setFilterStockOnly(false);
                handleSort('product', { defaultOrder: 'asc' });
              }}
            >
              Clear filter
            </button>
          </div>
        )}
        {/* Mobile Card View */}
        <div className="block sm:hidden divide-y divide-gray-100">
          {paginatedProducts.length === 0 ? (
            <div className="text-center py-8 text-gray-500 text-sm px-3">
              {searchTerm || filterStatus !== 'all' || filterCategory !== 'all'
                ? 'No products match your filters'
                : 'No products yet. Tap + Add Product to create your first product.'}
            </div>
          ) : (
            paginatedProducts.map((product: ProductListItem) => {
              const margin = calculateMargin(product.costPrice, product.sellingPrice);
              return (
                <div
                  key={product.id}
                  className="p-3 min-w-0"
                  data-products-mobile-card="true"
                >
                  {/* Phone SSOT: one right control (⋯). Hide Active (default); only Inactive shows. */}
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <p className="font-semibold text-gray-900 text-sm truncate">
                          {product.name}
                        </p>
                        {!product.isActive ? (
                          <span
                            className="shrink-0 px-1.5 py-0.5 text-[10px] font-semibold rounded bg-gray-100 text-gray-700"
                            data-product-status="inactive"
                          >
                            Inactive
                          </span>
                        ) : null}
                      </div>
                      {product.category ? (
                        <p className="text-xs text-gray-500 truncate">{product.category}</p>
                      ) : null}
                      <p className="text-xs text-gray-600 leading-snug">
                        <span>
                          Sell {formatCurrency(parseCurrency(product.sellingPrice))}
                          <span className="text-gray-400"> · </span>
                          {margin}% margin
                        </span>
                        <span className="text-gray-300"> · </span>
                        <span className="tabular-nums text-gray-700" data-product-stock="true">
                          Stock {formatMultiUomQuantity(product)}
                        </span>
                      </p>
                      {byStoreView && selectedStoreLabel ? (
                        <p className="text-[11px] text-gray-500">Store: {selectedStoreLabel}</p>
                      ) : null}
                    </div>
                    <div className="shrink-0 self-start" data-products-card-actions="true">
                      <AdaptiveRowActions
                        menuLabel="More"
                        actions={[
                          {
                            id: 'history',
                            label: 'History',
                            tone: 'muted',
                            onClick: () => handleViewHistory(product.id!),
                          },
                          {
                            id: 'edit',
                            label: 'Edit',
                            tone: 'primary',
                            onClick: () => handleEdit(productById.get(product.id!) ?? product),
                          },
                          {
                            id: 'opening',
                            label: 'Opening Stock',
                            onClick: () =>
                              setOpeningStockProduct({
                                id: product.id!,
                                name: product.name,
                                sku: product.sku,
                              }),
                          },
                          {
                            id: 'delete',
                            label: 'Delete',
                            tone: 'danger',
                            onClick: () => handleDeleteClick(product.id!),
                          },
                        ]}
                      />
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Desktop Table View */}
        <div className="hidden sm:block overflow-x-auto w-full">
          <table className={INVENTORY_WORKLIST_TABLE_CLASS} data-inventory-worklist-table="true">
            <thead className="bg-gray-50">
              <tr>
                {showCol('product') ? (
                  <SortableTableHeader label="Product" field="product" activeField={sortField} direction={sortOrder} onSort={handleColumnSort} className={`px-3 ${INVENTORY_COL_FILL_CLASS}`} />
                ) : null}
                {showCol('category') ? (
                  <SortableTableHeader label="Category" field="category" activeField={sortField} direction={sortOrder} onSort={handleColumnSort} className={`px-3 ${INVENTORY_COL_FIT_CLASS}`} />
                ) : null}
                {showCol('sku') ? (
                  <SortableTableHeader label="SKU" field="sku" activeField={sortField} direction={sortOrder} onSort={handleColumnSort} className={`px-3 ${INVENTORY_COL_FIT_CLASS}`} />
                ) : null}
                {showCol('pricing') ? (
                  <SortableTableHeader label="Pricing" field="pricing" activeField={sortField} direction={sortOrder} onSort={handleColumnSort} className={`px-3 ${INVENTORY_COL_FIT_CLASS}`} />
                ) : null}
                {showCol('margin') ? (
                  <SortableTableHeader label="Margin" field="margin" activeField={sortField} direction={sortOrder} onSort={handleColumnSort} className={`px-3 ${INVENTORY_COL_FIT_CLASS}`} />
                ) : null}
                {byStoreView && showCol('store') ? (
                  <th className={`px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider ${INVENTORY_COL_FIT_CLASS}`}>
                    Store
                  </th>
                ) : null}
                {showCol('stock') ? (
                  <SortableTableHeader label="Stock" field="stock" activeField={sortField} direction={sortOrder} onSort={handleColumnSort} className={`px-3 ${INVENTORY_COL_FIT_CLASS}`} filtered={filterStockOnly} />
                ) : null}
                {showCol('expiry') ? (
                  <SortableTableHeader label="Expiry" field="expiry" activeField={sortField} direction={sortOrder} onSort={handleColumnSort} className={`px-3 ${INVENTORY_COL_FIT_CLASS}`} />
                ) : null}
                {showCol('status') ? (
                  <SortableTableHeader label="Status" field="status" activeField={sortField} direction={sortOrder} onSort={handleColumnSort} className={`px-3 ${INVENTORY_COL_FIT_CLASS}`} />
                ) : null}
                {showCol('actions') ? (
                  <th className={`px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase tracking-wider ${INVENTORY_COL_FIT_CLASS}`}>Actions</th>
                ) : null}
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {paginatedProducts.length === 0 ? (
                <tr>
                  <td colSpan={tableColSpan} className="px-6 py-8 text-center text-gray-500">
                    {searchTerm || filterStatus !== 'all' || filterCategory !== 'all'
                      ? 'No products match your filters'
                      : 'No products yet. Click "Add Product" to create your first product.'}
                  </td>
                </tr>
              ) : (
                paginatedProducts.map((product: ProductListItem) => {
                  const margin = calculateMargin(product.costPrice, product.sellingPrice);
                  return (
                    <tr key={product.id} className="hover:bg-gray-50/80">
                      {showCol('product') ? (
                      <td className={`px-3 py-2 align-middle ${INVENTORY_COL_FILL_CLASS}`}>
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="text-sm font-medium text-gray-900 truncate">{product.name}</span>
                          {product.trackExpiry ? (
                            <span
                              aria-label="Perishable"
                              className="shrink-0 px-1.5 py-0.5 text-[10px] font-semibold rounded bg-purple-100 text-purple-800"
                            >
                              Exp
                            </span>
                          ) : null}
                        </div>
                        {product.description ? (
                          <div className="text-xs text-gray-500 truncate">{product.description}</div>
                        ) : null}
                      </td>
                      ) : null}
                      {showCol('category') ? (
                      <td className={`px-3 py-2 align-middle ${INVENTORY_COL_FIT_CLASS}`}>
                        <span className={`text-xs font-medium ${product.category ? 'text-blue-700' : 'text-gray-400'}`}>
                          {product.category || '—'}
                        </span>
                      </td>
                      ) : null}
                      {showCol('sku') ? (
                      <td className={`px-3 py-2 align-middle ${INVENTORY_COL_FIT_CLASS}`}>
                        <div className="text-xs text-gray-900 tabular-nums">{product.sku}</div>
                        {product.barcode ? (
                          <div className="text-[11px] text-gray-500 tabular-nums">{product.barcode}</div>
                        ) : null}
                      </td>
                      ) : null}
                      {showCol('pricing') ? (
                      <td className={`px-3 py-2 align-middle ${INVENTORY_COL_FIT_CLASS}`}>
                        <div className="text-xs text-gray-600 tabular-nums">
                          {formatCurrency(parseCurrency(product.costPrice))}
                        </div>
                        <div className="text-sm font-medium text-gray-900 tabular-nums">
                          {formatCurrency(parseCurrency(product.sellingPrice))}
                        </div>
                      </td>
                      ) : null}
                      {showCol('margin') ? (
                      <td className={`px-3 py-2 align-middle ${INVENTORY_COL_FIT_CLASS}`}>
                        <span className={`text-sm font-medium tabular-nums ${parseFloat(margin) >= 30 ? 'text-green-600' :
                          parseFloat(margin) >= 15 ? 'text-amber-600' : 'text-red-600'
                          }`}>
                          {margin}%
                        </span>
                      </td>
                      ) : null}
                      {byStoreView && showCol('store') ? (
                        <td className={`px-3 py-2 align-middle text-xs text-gray-700 ${INVENTORY_COL_FIT_CLASS}`}>
                          {selectedStoreLabel || '—'}
                        </td>
                      ) : null}
                      {showCol('stock') ? (
                      <td className={`px-3 py-2 align-middle ${INVENTORY_COL_FIT_CLASS}`}>
                        <div className="text-xs text-gray-700 tabular-nums">{formatMultiUomQuantity(product)}</div>
                        <div className="text-[11px] text-gray-500">RO {product.reorderLevel}</div>
                      </td>
                      ) : null}
                      {showCol('expiry') ? (
                      <td className={`px-3 py-2 align-middle ${INVENTORY_COL_FIT_CLASS}`}>
                        {(() => {
                          const exp = nearestExpiryByProductId.get(product.id!) ?? null;
                          if (!product.trackExpiry) {
                            return <span className="text-xs text-gray-400">—</span>;
                          }
                          if (!exp) {
                            return <span className="text-xs text-gray-400">No date</span>;
                          }
                          return (
                            <span
                              className={`text-xs tabular-nums ${
                                isExpiringSoon(exp) ? 'text-red-700 font-semibold' : 'text-gray-700'
                              }`}
                            >
                              {formatDisplayDate(exp)}
                            </span>
                          );
                        })()}
                      </td>
                      ) : null}
                      {showCol('status') ? (
                      <td className={`px-3 py-2 align-middle ${INVENTORY_COL_FIT_CLASS}`}>
                        <span className={`inline-flex px-1.5 py-0.5 text-[11px] font-semibold rounded ${product.isActive
                          ? 'bg-green-100 text-green-800'
                          : 'bg-gray-100 text-gray-700'
                          }`}>
                          {product.isActive ? 'Active' : 'Off'}
                        </span>
                      </td>
                      ) : null}
                      {showCol('actions') ? (
                      <td className={`px-3 py-2 align-middle text-right ${INVENTORY_COL_FIT_CLASS}`}>
                        <AdaptiveRowActions
                          presentationOverride="inline"
                          actions={[
                            {
                              id: 'history',
                              label: 'History',
                              tone: 'muted',
                              onClick: () => handleViewHistory(product.id!),
                            },
                            {
                              id: 'edit',
                              label: 'Edit',
                              tone: 'primary',
                              onClick: () => handleEdit(productById.get(product.id!) ?? product),
                            },
                            {
                              id: 'delete',
                              label: 'Delete',
                              tone: 'danger',
                              onClick: () => handleDeleteClick(product.id!),
                            },
                          ]}
                        />
                      </td>
                      ) : null}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination Controls */}
        {sortedProducts.length > ITEMS_PER_PAGE && (
          <div className="flex items-center justify-between px-6 py-4 border-t border-gray-200">
            <p className="text-sm text-gray-600">
              Showing {((currentPage - 1) * ITEMS_PER_PAGE) + 1}–{Math.min(currentPage * ITEMS_PER_PAGE, sortedProducts.length)} of {sortedProducts.length} products
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                disabled={currentPage === 1}
                className="px-3 py-1.5 text-sm font-medium rounded-lg border border-gray-300 bg-white hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Previous
              </button>
              <span className="text-sm text-gray-700">
                Page {currentPage} of {totalPages}
              </span>
              <button
                onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                disabled={currentPage === totalPages}
                className="px-3 py-1.5 text-sm font-medium rounded-lg border border-gray-300 bg-white hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
      </AdaptivePage>

      {/* Create/Edit Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4" onClick={() => setShowModal(false)}>
          <div className="bg-white rounded-lg shadow-xl max-w-[95vw] sm:max-w-3xl w-full max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="sticky top-0 bg-white border-b px-6 py-4">
              <h3 className="text-xl font-bold text-gray-900">
                {modalMode === 'create' ? 'Add New Product' : 'Edit Product'}
              </h3>
            </div>

            <div className="p-6 space-y-4">
              <ProductForm
                values={{
                  name: formData.name,
                  sku: formData.sku,
                  barcode: formData.barcode,
                  description: formData.description,
                  category: formData.category,
                  productType: formData.productType,
                  costPrice: formData.costPrice,
                  sellingPrice: formData.sellingPrice,
                  costingMethod: formData.costingMethod,
                  isTaxable: formData.isTaxable,
                  taxRate: formData.taxRate,
                  pricingFormula: formData.pricingFormula,
                  autoUpdatePrice: formData.autoUpdatePrice,
                  reorderLevel: formData.reorderLevel,
                  trackExpiry: formData.trackExpiry,
                  isActive: formData.isActive,
                  availableInRestaurant: formData.availableInRestaurant,
                  isPreparedFood: formData.isPreparedFood,
                  isBuffetCover: formData.isBuffetCover,
                  genericName: formData.genericName,
                  minDaysBeforeExpirySale: formData.minDaysBeforeExpirySale,
                  preferredSupplierId: formData.preferredSupplierId,
                  supplierProductCode: formData.supplierProductCode,
                  purchaseUomId: formData.purchaseUomId,
                  leadTimeDays: formData.leadTimeDays,
                  reorderQuantity: formData.reorderQuantity,
                }}
                onChange={(field: ProductFormField, value: string | boolean) => handleFieldChange(field as keyof ProductFormData, value)}
                validationErrors={validationErrors as Partial<Record<ProductFormField, string>>}
                suppliers={suppliersList}
                masterUoms={masterUoms}
                configuredProductUoms={productUoms
                  .filter((u) => u.uomId)
                  .map((u) => ({
                    id: u.uomId,
                    name: u.uomName || masterUomById[u.uomId]?.name || u.uomId,
                    symbol: u.uomSymbol || masterUomById[u.uomId]?.symbol,
                  }))}
                restrictPurchaseUomToConfigured={modalMode === 'edit' || productUoms.some((u) => u.uomId)}
                lastPurchasePrice={formData.lastCost !== '0' ? formData.lastCost : undefined}
                taxMappings={modalMode === 'edit' ? productTaxMappings : []}
                taxMappingsLoading={modalMode === 'edit' && productTaxMappingsLoading}
                taxInclusivePricing={taxInclusivePricing}
              />

              {modalMode === 'edit' && formData.id && (
                <ProductDistributionPolicySection productId={formData.id} />
              )}

              {/* Cost Tracking (Read-only) — inventory products only */}
              {formData.productType !== 'service' && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
                <div>
                  <label htmlFor="average-cost" className="block text-sm font-medium text-gray-700 mb-1">
                    Average Cost (Read-only)
                  </label>
                  <input
                    id="average-cost"
                    type="number"
                    step="0.01"
                    value={formData.averageCost}
                    readOnly
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-gray-50 text-gray-600"
                    placeholder="0.00"
                  />
                  <p className="text-xs text-gray-500 mt-1">Calculated by system for AVCO method</p>
                </div>

                <div>
                  <label htmlFor="last-cost" className="block text-sm font-medium text-gray-700 mb-1">
                    Last Cost (Read-only)
                  </label>
                  <input
                    id="last-cost"
                    type="number"
                    step="0.01"
                    value={formData.lastCost}
                    readOnly
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-gray-50 text-gray-600"
                    placeholder="0.00"
                  />
                  <p className="text-xs text-gray-500 mt-1">Last purchase cost from goods receipt</p>
                </div>
              </div>
              )}

              {/* Margin Display */}
              {formData.costPrice && formData.sellingPrice && (
                <div className="mt-3 p-3 bg-blue-50 rounded-lg">
                  <div className="text-sm text-gray-700">
                    <strong>Profit Margin:</strong>{' '}
                    <span className="text-blue-600 font-semibold">
                      {calculateMargin(formData.costPrice, formData.sellingPrice)}%
                    </span>
                  </div>
                </div>
              )}

              {/* BR-PRC-001 — only when selling is below cost */}
              {(() => {
                const cost = parseFloat(formData.costPrice || '0') || 0;
                const sell = parseFloat(formData.sellingPrice || '0') || 0;
                if (sell >= cost) return null;
                return (
                  <div className="mt-3 p-3 bg-yellow-50 border border-yellow-200 rounded">
                    <p className="text-xs text-yellow-800">
                      <strong>⚠️ {BUSINESS_RULES.PRC_001}</strong>: Selling price must be greater than or
                      equal to cost price
                    </p>
                  </div>
                );
              })()}

              {/* Inventory Snapshot — not for service dishes */}
              {formData.productType !== 'service' && (
              <div className="border-t pt-4">
                <h4 className="font-medium text-gray-900 mb-3">Inventory Snapshot</h4>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div>
                    <label htmlFor="quantity-on-hand" className="block text-sm font-medium text-gray-700 mb-1">
                      Quantity On Hand (Read-only)
                    </label>
                    <input
                      id="quantity-on-hand"
                      type="number"
                      step="0.01"
                      value={formData.quantityOnHand}
                      readOnly
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-gray-50 text-gray-600"
                      placeholder="0"
                    />
                    <p className="text-xs text-gray-500 mt-1">Current stock from inventory</p>
                  </div>
                </div>
              </div>
              )}

              {/* Multi-Unit of Measure */}
              <div className="border-t pt-4">
                <div className="flex justify-between items-center mb-3">
                  <div>
                    <h4 className="font-medium text-gray-900">Multi-Unit of Measure</h4>
                    <p className="text-xs text-gray-500 mt-1">
                      Configure alternate units for this product with automatic conversion factors
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={handleAddUomClick}
                    className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
                  >
                    + Add Unit
                  </button>
                </div>

                {invalidUomIndexes.length > 0 && (
                  <div className="mb-3 p-3 rounded border border-yellow-300 bg-yellow-50 text-sm text-yellow-800 flex items-center justify-between gap-2">
                    <span>Some units are missing or invalid. Please select a valid unit for highlighted rows before saving.</span>
                    <button
                      type="button"
                      onClick={handleFixAllMissingUnits}
                      disabled={!masterUoms || masterUoms.length === 0}
                      className={`px-2.5 py-1 text-xs rounded border ${(!masterUoms || masterUoms.length === 0) ? 'bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed' : 'bg-white text-yellow-900 border-yellow-300 hover:bg-yellow-100'}`}
                      title={(!masterUoms || masterUoms.length === 0) ? 'No master units available' : 'Autofill missing units'}
                      aria-label="Fix all missing units"
                    >
                      Fix all missing units
                    </button>
                  </div>
                )}

                {/* UoM List */}
                {productUoms.length > 0 ? (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-3 py-2 text-left text-xs font-medium text-gray-700">Unit</th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-gray-700">Symbol</th>
                          <th className="px-3 py-2 text-right text-xs font-medium text-gray-700">Conversion</th>
                          <th className="px-3 py-2 text-center text-xs font-medium text-gray-700">Default</th>
                          <th className="px-3 py-2 text-right text-xs font-medium text-gray-700">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="bg-white divide-y divide-gray-200">
                        {productUoms.map((uom, index) => {
                          const master = uom.uomId ? masterUomById[uom.uomId] : undefined;
                          const isInvalid = !master;
                          const name = master ? master.name : null;
                          const symbol = master ? (master.symbol ?? null) : null;
                          return (
                            <tr key={index} className={isInvalid ? 'bg-yellow-50' : 'hover:bg-gray-50'}>
                              <td className="px-3 py-2 text-gray-900">
                                {isInvalid ? (
                                  <button
                                    type="button"
                                    onClick={() => handleEditUomClick(index)}
                                    className="text-red-600 underline"
                                    title="Select a valid unit"
                                    aria-label="Select a valid unit of measure"
                                  >
                                    Select unit…
                                  </button>
                                ) : (
                                  <span>{name}{symbol ? ` (${symbol})` : ''}</span>
                                )}
                              </td>
                              <td className="px-3 py-2 text-gray-600">{symbol || '-'}</td>
                              <td className="px-3 py-2 text-right text-gray-900">
                                {uom.isDefault
                                  ? 'Base'
                                  : `1 ${symbol || name} = ${parseFloat(uom.conversionFactor).toString()} ${productUoms[0]?.uomSymbol || productUoms[0]?.uomName || 'Base'}`}
                              </td>
                              <td className="px-3 py-2 text-center">
                                {uom.isDefault ? (
                                  <span className="inline-block px-2 py-0.5 text-xs bg-blue-100 text-blue-800 rounded">
                                    Default
                                  </span>
                                ) : isInvalid ? (
                                  <span className="inline-block px-2 py-0.5 text-xs bg-gray-100 text-gray-600 rounded" title="Select unit first">
                                    Set Default
                                  </span>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => handleSetDefaultUom(index)}
                                    className="text-xs text-blue-600 hover:underline"
                                  >
                                    Set Default
                                  </button>
                                )}
                              </td>
                              <td className="px-3 py-2 text-right space-x-2">
                                <button
                                  type="button"
                                  onClick={() => handleEditUomClick(index)}
                                  className="text-blue-600 hover:underline"
                                >
                                  Edit
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleDeleteUomClick(index)}
                                  className="text-red-600 hover:underline"
                                >
                                  Delete
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="text-center py-6 bg-gray-50 rounded border border-dashed border-gray-300">
                    <p className="text-sm text-gray-500">No alternate units configured</p>
                    <p className="text-xs text-gray-400 mt-1">Click "Add Unit" to configure conversion factors</p>
                  </div>
                )}
              </div>

              {/* Status handled within shared ProductForm */}
            </div>

            {/* Modal Actions */}
            <div className="sticky bottom-0 bg-gray-50 px-6 py-4 border-t flex gap-3">
              <button
                onClick={() => {
                  setShowModal(false);
                  setFormData(initialFormData);
                  setValidationErrors({});
                  setApiError('');
                }}
                className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 transition-colors"
                disabled={createProductMutation.isPending || updateProductMutation.isPending}
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={createProductMutation.isPending || updateProductMutation.isPending}
                className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
              >
                {(createProductMutation.isPending || updateProductMutation.isPending)
                  ? 'Saving...'
                  : modalMode === 'create' ? 'Create Product' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50" onClick={() => { setShowDeleteConfirm(false); setProductToDelete(null); }}>
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-xl font-bold text-gray-900 mb-4">Confirm Delete</h3>
            <p className="text-gray-600 mb-6">
              Are you sure you want to delete this product? This action cannot be undone.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => {
                  setShowDeleteConfirm(false);
                  setProductToDelete(null);
                }}
                disabled={deleteProductMutation.isPending}
                className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 disabled:bg-gray-100 disabled:cursor-not-allowed transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteConfirm}
                disabled={deleteProductMutation.isPending}
                className="flex-1 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
              >
                {deleteProductMutation.isPending ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Product History Modal */}
      {showHistoryModal && selectedProductForHistory && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4" onClick={closeHistoryModal}>
          <div className="bg-white rounded-lg shadow-xl max-w-[95vw] sm:max-w-5xl w-full max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            {/* Modal Header */}
            <div className="sticky top-0 bg-white border-b px-6 py-4 flex justify-between items-center rounded-t-lg z-10">
              <div>
                <h3 className="text-xl font-bold text-gray-900">{selectedProductName}</h3>
                <p className="text-sm text-gray-600 mt-1">Stock & movement history</p>
              </div>
              <button
                onClick={closeHistoryModal}
                className="text-gray-400 hover:text-gray-600 text-2xl leading-none"
              >
                ×
              </button>
            </div>

            <div className="flex-1 overflow-y-auto min-h-0">
            <MultistoreGate>
              {selectedProductForHistory && (
                <div className="px-6 pt-4">
                  <ProductDistributionPolicySection
                    productId={selectedProductForHistory}
                    readOnly
                  />
                </div>
              )}
              <ProductStockDetailCards
                productId={selectedProductForHistory ?? ''}
                enabled={!!selectedProductForHistory}
                unitCost={selectedProductUnitCost}
              />
            </MultistoreGate>

            <div className="px-6 py-3 border-b bg-white">
              <h4 className="text-sm font-semibold text-gray-800 uppercase tracking-wide">
                Movement History
              </h4>
            </div>

            {/* Filters */}
            <div className="px-6 py-4 bg-gray-50 border-b">
              {/* Quick type toggles */}
              <div className="flex flex-wrap items-center gap-2 mb-3" role="group" aria-label="History quick filters">
                <button
                  className={`px-3 py-1.5 text-xs rounded border ${!historyFilters.type ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-700 border-gray-300'}`}
                  onClick={() => setHistoryFilters({ ...historyFilters, type: undefined })}
                >All</button>
                <button
                  className={`px-3 py-1.5 text-xs rounded border ${historyFilters.type === 'GOODS_RECEIPT' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-700 border-gray-300'}`}
                  onClick={() => setHistoryFilters({ ...historyFilters, type: 'GOODS_RECEIPT' })}
                >Purchases</button>
                <button
                  className={`px-3 py-1.5 text-xs rounded border ${historyFilters.type === 'SALE' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-700 border-gray-300'}`}
                  onClick={() => setHistoryFilters({ ...historyFilters, type: 'SALE' })}
                >Sales</button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label htmlFor="history-event-type" className="block text-sm font-medium text-gray-700 mb-1">
                    Event Type
                  </label>
                  <select
                    id="history-event-type"
                    value={historyFilters.type || ''}
                    onChange={(e) => setHistoryFilters({ ...historyFilters, type: e.target.value as ProductHistoryType || undefined })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                  >
                    <option value="">All Types</option>
                    <option value="GOODS_RECEIPT">Goods Receipt</option>
                    <option value="SALE">Sale</option>
                    <option value="ADJUSTMENT_IN">Adjustment In</option>
                    <option value="ADJUSTMENT_OUT">Adjustment Out</option>
                    <option value="TRANSFER_IN">Transfer In</option>
                    <option value="TRANSFER_OUT">Transfer Out</option>
                    <option value="RETURN">Return</option>
                    <option value="DAMAGE">Damage</option>
                    <option value="EXPIRY">Expiry</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="history-start-date" className="block text-sm font-medium text-gray-700 mb-1">
                    Start Date
                  </label>
                  <DatePicker
                    value={historyFilters.startDate || ''}
                    onChange={(date) => setHistoryFilters({ ...historyFilters, startDate: date || undefined })}
                    placeholder="Start date"
                    maxDate={historyFilters.endDate ? new Date(historyFilters.endDate) : undefined}
                  />
                </div>
                <div>
                  <label htmlFor="history-end-date" className="block text-sm font-medium text-gray-700 mb-1">
                    End Date
                  </label>
                  <DatePicker
                    value={historyFilters.endDate || ''}
                    onChange={(date) => setHistoryFilters({ ...historyFilters, endDate: date || undefined })}
                    placeholder="End date"
                    minDate={historyFilters.startDate ? new Date(historyFilters.startDate) : undefined}
                  />
                </div>
              </div>
            </div>

            {/* Summary Stats */}
            {historyData?.summary && (
              <div className="px-6 py-4 bg-gradient-to-r from-blue-50 to-purple-50 border-b">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div>
                    <div className="text-xs text-gray-600 font-medium">Total IN</div>
                    <div className="text-lg font-bold text-green-600">
                      {historyData.summary.totalInQuantity.toFixed(2)}
                    </div>
                    <div className="text-xs text-gray-500">
                      {formatCurrency(historyData.summary.totalInValue)}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-gray-600 font-medium">Total OUT</div>
                    <div className="text-lg font-bold text-orange-600">
                      {historyData.summary.totalOutQuantity.toFixed(2)}
                    </div>
                    <div className="text-xs text-gray-500">
                      {formatCurrency(historyData.summary.totalOutValue)}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-gray-600 font-medium">Net Change</div>
                    <div className={`text-lg font-bold ${historyData.summary.netQuantityChange >= 0 ? 'text-green-600' : 'text-red-600'
                      }`}>
                      {formatQuantityChange(historyData.summary.netQuantityChange)} ({Math.abs(historyData.summary.netQuantityChange).toFixed(2)})
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-gray-600 font-medium">Current Valuation</div>
                    <div className="text-lg font-bold text-blue-600">
                      {formatCurrency(historyData.summary.currentValuation || 0)}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* History Timeline */}
            <div className="flex-1 overflow-y-auto px-6 py-4">
              {historyLoading && (
                <div className="text-center py-8 text-gray-500">
                  Loading history...
                </div>
              )}

              {historyError && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-center">
                  <p className="text-red-800">Failed to load history</p>
                  <p className="text-sm text-red-600 mt-1">{getErrorMessage(historyError)}</p>
                </div>
              )}

              {historyData && historyData.items.length === 0 && (
                <div className="text-center py-8 text-gray-500">
                  No history found for this product
                </div>
              )}

              {historyData && historyData.items.length > 0 && (
                <div className="space-y-3">
                  {historyData.items.map((item, idx) => {
                    const variant = getHistoryTypeVariant(item.type);
                    const expiring = isExpiringSoon(item.expiryDate);
                    const actor = getHistoryActor(item);

                    return (
                      <div
                        key={idx}
                        className={`bg-white border border-gray-200 rounded-lg p-4 hover:shadow-md transition-shadow border-l-4`}
                      >
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            {/* Type and Badges */}
                            <div className="flex flex-wrap items-center gap-2 mb-2">
                              <span className={`px-2 py-1 rounded text-xs font-medium ${variant.bgColor} ${variant.color}`}>
                                {variant.label}
                              </span>

                              {/* Actor chip — who performed this action */}
                              {actor && (
                                <span className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium bg-slate-100 text-slate-700">
                                  <svg className="w-3 h-3 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
                                    <path fillRule="evenodd" d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z" clipRule="evenodd" />
                                  </svg>
                                  <span className="text-slate-500">{actor.label}:</span>
                                  <span className="font-semibold">{actor.name}</span>
                                </span>
                              )}

                              {item.batchNumber && (
                                <span className="px-2 py-1 rounded text-xs font-medium bg-purple-100 text-purple-700">
                                  Batch: {item.batchNumber}
                                </span>
                              )}

                              {item.expiryDate && (
                                <span className={`px-2 py-1 rounded text-xs font-medium ${expiring ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-600'
                                  }`}>
                                  {expiring ? '⚠️ Expiring Soon' : `Exp: ${formatDisplayDate(item.expiryDate)}`}
                                </span>
                              )}
                            </div>

                            {/* Date */}
                            <div className="text-sm text-gray-600 mb-1">
                              {item.eventDate?.includes('T') ? `${formatDisplayDate(item.eventDate)} ${item.eventDate.split('T')[1].substring(0, 8)}` : formatDisplayDate(item.eventDate)}
                            </div>

                            {/* Reference */}
                            {item.reference && (
                              <div className="text-sm text-gray-700 mb-2">
                                {formatHistoryReference(item)}
                              </div>
                            )}

                            {/* Financial Details */}
                            <div className="flex flex-wrap gap-4 text-xs text-gray-500">
                              {item.unitCost !== undefined && (
                                <div>Cost: {formatCurrency(item.unitCost)}</div>
                              )}
                              {item.unitPrice !== undefined && (
                                <div>Price: {formatCurrency(item.unitPrice)}</div>
                              )}
                              {item.averageCost !== undefined && (
                                <div>Avg Cost: {formatCurrency(item.averageCost)}</div>
                              )}
                              {item.runningValuation !== undefined && (
                                <div>Valuation: {formatCurrency(item.runningValuation)}</div>
                              )}
                            </div>

                            {/* Enhanced Details by Type */}
                            {item.reference && item.type === 'GOODS_RECEIPT' && (() => {
                              const defaultUom = selectedProductWithUom?.productUoms?.find((u: ProductUomRow) => u.isDefault);
                              const fallbackUom = defaultUom?.uomSymbol || defaultUom?.uomName || '';

                              return (
                                <div className="mt-2 grid grid-cols-2 md:grid-cols-4 gap-2 text-xs text-gray-600">
                                  {item.reference.grStatus && (
                                    <div><span className="text-gray-500">GR Status:</span> {item.reference.grStatus}</div>
                                  )}
                                  {item.reference.receivedDate && (
                                    <div><span className="text-gray-500">Received:</span> {formatDisplayDate(item.reference.receivedDate)}</div>
                                  )}
                                  {typeof item.reference.orderedQuantity === 'number' && (
                                    <div><span className="text-gray-500">Ordered:</span> {item.reference.orderedQuantity}</div>
                                  )}
                                  {typeof item.quantityChange === 'number' && (
                                    <div><span className="text-gray-500">Received:</span> {item.quantityChange} {item.uomName || fallbackUom}</div>
                                  )}
                                  {typeof item.reference.poUnitPrice === 'number' && (
                                    <div><span className="text-gray-500">PO Unit:</span> {formatCurrency(item.reference.poUnitPrice)}</div>
                                  )}
                                  {typeof item.unitCost === 'number' && (
                                    <div><span className="text-gray-500">GR Unit:</span> {formatCurrency(item.unitCost)}</div>
                                  )}
                                  {typeof item.reference.qtyVariance === 'number' && item.reference.qtyVariance !== 0 && (
                                    <div className={`${item.reference.qtyVariance > 0 ? 'text-orange-700' : 'text-green-700'}`}>
                                      <span className="text-gray-500">Qty Var:</span> {formatQuantityChange(item.reference.qtyVariance)}
                                    </div>
                                  )}
                                  {typeof item.reference.costVariance === 'number' && item.reference.costVariance !== 0 && (
                                    <div className={`${item.reference.costVariance > 0 ? 'text-orange-700' : 'text-green-700'}`}>
                                      <span className="text-gray-500">Cost Var:</span> {formatCurrency(item.reference.costVariance)}
                                    </div>
                                  )}
                                  {item.batchNumber && (
                                    <div><span className="text-gray-500">Batch #:</span> <span className="font-medium text-purple-700">{item.batchNumber}</span></div>
                                  )}
                                  {item.reference.batchStatus && (
                                    <div><span className="text-gray-500">Batch Status:</span> {item.reference.batchStatus}</div>
                                  )}
                                  {typeof item.reference.batchRemainingQty === 'number' && (
                                    <div><span className="text-gray-500">Batch Remaining:</span> {item.reference.batchRemainingQty} {item.uomName || fallbackUom}</div>
                                  )}
                                </div>
                              );
                            })()}

                            {item.reference && item.type === 'SALE' && (
                              <div className="mt-2 grid grid-cols-2 md:grid-cols-4 gap-2 text-xs text-gray-600">
                                {item.reference.saleStatus && (
                                  <div><span className="text-gray-500">Status:</span> {item.reference.saleStatus}</div>
                                )}
                                {item.reference.paymentMethod && (
                                  <div><span className="text-gray-500">Method:</span> {item.reference.paymentMethod}</div>
                                )}
                                {typeof item.reference.totalAmount === 'number' && (
                                  <div><span className="text-gray-500">Total:</span> {formatCurrency(item.reference.totalAmount)}</div>
                                )}
                                {typeof item.reference.paymentReceived === 'number' && (
                                  <div><span className="text-gray-500">Paid:</span> {formatCurrency(item.reference.paymentReceived)}</div>
                                )}
                                {typeof item.reference.changeAmount === 'number' && (
                                  <div><span className="text-gray-500">Change:</span> {formatCurrency(item.reference.changeAmount)}</div>
                                )}
                                {item.batchNumber && (
                                  <div><span className="text-gray-500">Batch:</span> <span className="font-medium text-purple-700">{item.batchNumber}</span></div>
                                )}
                                {item.expiryDate && (
                                  <div className={isExpiringSoon(item.expiryDate) ? 'text-red-700 font-medium' : ''}>
                                    <span className="text-gray-500">Expiry:</span> {formatDisplayDate(item.expiryDate)}
                                  </div>
                                )}
                                {item.reference.batchStatus && (
                                  <div><span className="text-gray-500">Batch Status:</span> {item.reference.batchStatus}</div>
                                )}
                                {typeof item.reference.batchRemainingQty === 'number' && (
                                  <div><span className="text-gray-500">Batch Remaining:</span> {item.reference.batchRemainingQty}</div>
                                )}
                              </div>
                            )}

                            {/* Stock Movement Details (adjustments, transfers, returns, etc.) */}
                            {item.reference && !['GOODS_RECEIPT', 'SALE'].includes(item.type) && (
                              <div className="mt-2 grid grid-cols-2 md:grid-cols-4 gap-2 text-xs text-gray-600">
                                {item.batchNumber && (
                                  <div><span className="text-gray-500">Batch:</span> <span className="font-medium text-purple-700">{item.batchNumber}</span></div>
                                )}
                                {item.expiryDate && (
                                  <div className={isExpiringSoon(item.expiryDate) ? 'text-red-700 font-medium' : ''}>
                                    <span className="text-gray-500">Expiry:</span> {formatDisplayDate(item.expiryDate)}
                                  </div>
                                )}
                                {item.reference.referenceType && (
                                  <div><span className="text-gray-500">Ref Type:</span> {item.reference.referenceType}</div>
                                )}
                                {item.reference.referenceId && (
                                  <div><span className="text-gray-500">Ref ID:</span> {item.reference.referenceId.slice(0, 8)}…</div>
                                )}
                                {item.reference.notes && (
                                  <div className="col-span-2 md:col-span-4"><span className="text-gray-500">Notes:</span> {item.reference.notes}</div>
                                )}
                              </div>
                            )}
                          </div>

                          {/* Quantity Display */}
                          {(() => {
                            const defaultUom = selectedProductWithUom?.productUoms?.find((u: ProductUomRow) => u.isDefault);
                            const fallbackUom = defaultUom?.uomSymbol || defaultUom?.uomName || '';

                            return (
                              <div className="text-right ml-4">
                                <div className={`text-xl font-bold ${item.quantityChange >= 0 ? 'text-green-600' : 'text-orange-600'
                                  }`}>
                                  {formatQuantityChange(item.quantityChange)} {item.uomName || fallbackUom}
                                </div>
                                {item.runningQuantity !== undefined && (
                                  <div className="text-sm text-gray-500">
                                    Balance: {item.runningQuantity} {item.uomName || fallbackUom}
                                  </div>
                                )}
                              </div>
                            );
                          })()}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Pagination Info */}
              {historyData?.pagination && historyData.pagination.total > 0 && (
                <div className="mt-4 text-center text-sm text-gray-600">
                  Showing {historyData.items.length} of {historyData.pagination.total} events
                  {historyData.pagination.totalPages > 1 && (
                    <span> (Page {historyData.pagination.page} of {historyData.pagination.totalPages})</span>
                  )}
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="sticky bottom-0 bg-gray-50 px-6 py-4 border-t rounded-b-lg">
              <button
                onClick={closeHistoryModal}
                className="w-full px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
              >
                Close
              </button>
            </div>
            </div>
          </div>
        </div>
      )}

      {/* UoM Add/Edit Modal */}
      {showAddUomForm && (
        <div
          className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
          onClick={handleCancelUom}
        >
          <div
            className="bg-white rounded-lg shadow-xl max-w-[95vw] sm:max-w-2xl w-full max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="uom-modal-title"
          >
            {/* Modal Header */}
            <div className="sticky top-0 bg-white border-b px-6 py-4 rounded-t-lg z-10">
              <h3 id="uom-modal-title" className="text-lg font-semibold text-gray-900">
                {editingUomIndex !== null ? 'Edit Unit of Measure' : 'Add Unit of Measure'}
              </h3>
            </div>

            {/* Modal Body */}
            <div className="px-6 py-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Unit <span className="text-red-500">*</span>
                  </label>
                  <select
                    value={uomFormData.uomId}
                    onChange={(e) => setUomFormData({ ...uomFormData, uomId: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                    aria-label="Select unit of measure"
                  >
                    <option value="">Select unit...</option>
                    {masterUoms
                      .filter(m => !productUoms.some((p, i) => p.uomId === m.id && i !== editingUomIndex))
                      .map(m => (
                        <option key={m.id} value={m.id}>
                          {m.name} {m.symbol ? `(${m.symbol})` : ''}
                        </option>
                      ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Conversion Factor <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="number"
                    min="1"
                    step="any"
                    value={uomFormData.conversionFactor}
                    onChange={(e) => setUomFormData({ ...uomFormData, conversionFactor: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                    placeholder="12"
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    How many base units = 1 of this unit
                  </p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Cost Override (optional)
                  </label>
                  <input
                    type="number"
                    step="1"
                    value={uomFormData.costOverride || ''}
                    onChange={(e) => setUomFormData({ ...uomFormData, costOverride: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                    placeholder="Leave blank for auto-calc"
                  />
                  {uomFormData.costOverride && parseFloat(uomFormData.costOverride) > 0 && (
                    <p className="text-xs text-orange-600 font-medium mt-1">
                      ⚠️ Override active - Auto-calculation (below) will be ignored!
                    </p>
                  )}
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Price Override (optional)
                  </label>
                  <input
                    type="number"
                    step="1"
                    value={uomFormData.priceOverride || ''}
                    onChange={(e) => setUomFormData({ ...uomFormData, priceOverride: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                    placeholder="Leave blank for auto-calc"
                  />
                </div>
              </div>

              {/* MUoM auto-calculation preview */}
              {(() => {
                const baseCost = parseFloat(formData.costPrice || '0') || 0;
                const factor = parseFloat(uomFormData.conversionFactor || '0');
                const selling = parseFloat(formData.sellingPrice || '0') || 0;
                const defaultMultiplier = baseCost > 0 && selling > 0
                  ? selling / baseCost
                  : 1.25; // fallback 25% markup
                if (!baseCost || !factor || factor <= 0) return null;

                // Get base UOM name from first productUom or use 'UNIT' fallback
                const baseUomName = productUoms[0]?.uomName || 'UNIT';

                const result = computeUomPrices({
                  baseCost,
                  baseUomName,
                  units: [{ name: 'UNIT', factor }],
                  defaultMultiplier,
                  currencyDecimals: 0,
                });
                const row = result.rows[0];
                const markupPct = Math.round((row.usedMultiplier - 1) * 100);
                return (
                  <div className="mt-4 p-3 bg-blue-50 border border-blue-200 rounded">
                    <div className="text-xs text-gray-600">
                      <span className="font-medium">Conversion:</span> 1 selected unit = {factor} {baseUomName}
                    </div>
                    <div className="text-xs text-gray-600">
                      <span className="font-medium">Auto cost:</span> {formatCurrency(row.unitCost)}
                    </div>
                    <div className="text-xs text-gray-600">
                      <span className="font-medium">Auto price:</span> {formatCurrency(row.sellingPrice)}{' '}
                      <span className="text-gray-500">(markup {markupPct}%)</span>
                    </div>
                    <div className="text-[11px] text-gray-500 mt-1">
                      Uses base {baseUomName} cost × factor ({parseFloat(factor.toString()).toString()}). Override fields above take precedence.
                    </div>
                  </div>
                );
              })()}

              <div className="mt-4 flex items-center gap-2">
                <input
                  id="uom-default"
                  type="checkbox"
                  checked={uomFormData.isDefault}
                  onChange={(e) => setUomFormData({ ...uomFormData, isDefault: e.target.checked })}
                  className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                />
                <label htmlFor="uom-default" className="text-sm text-gray-700">
                  Base stock unit (required before other units)
                </label>
                {!productUoms.some((u) => u.isDefault) && (
                  <p className="text-xs text-amber-700 mt-1">
                    First unit is saved as the base stock UoM (factor 1). Add pack/box units after that.
                  </p>
                )}
              </div>
            </div>

            {/* Modal Footer */}
            <div className="sticky bottom-0 bg-gray-50 px-6 py-4 border-t flex gap-3 rounded-b-lg">
              <button
                type="button"
                onClick={handleCancelUom}
                className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSaveUom}
                className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
              >
                {editingUomIndex !== null ? 'Update' : 'Add'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Master Data Guard — Opening Stock dialog */}
      {openingStockProduct && (
        <OpeningStockDialog
          product={openingStockProduct}
          onClose={() => setOpeningStockProduct(null)}
          onSuccess={() => setOpeningStockProduct(null)}
        />
      )}
    </div>
  );
}


