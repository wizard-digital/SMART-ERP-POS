/**
 * @module InventoryAdjustmentsPage
 * @description Manual inventory adjustment interface - creates ADJUSTMENT_IN/ADJUSTMENT_OUT movements
 * @requires inventory.adjust OR inventory.approve permission
 * @architecture Uses unified StockMovementHandler on backend
 * @note Audit trail view is in StockMovementsPage to avoid duplication
 *
 * REFACTORED: Now uses productId instead of batchId
 * Backend automatically handles batch selection (MAIN batch)
 */

import { useState, useMemo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ResponsiveTableWrapper } from '../../components/ui/ResponsiveTableWrapper';
import {
  AdaptivePage,
  AdaptiveToolbar,
  AdaptiveSearch,
  AdaptiveDataGrid,
  AdaptiveKpiStrip,
  type AdaptiveDataColumn,
} from '../../components/adaptive';
import {
  ADAPTIVE_PAGE_PAD_CLASS,
  ADAPTIVE_TOOLBAR_CARD_CLASS,
  ADAPTIVE_WORKLIST_DENSITY,
} from '../../lib/adaptiveDashboard';
import { AdaptiveRowActions } from '../../components/adaptive';
import { InventoryColumnPicker } from '../../components/inventory/InventoryColumnPicker';
import { useInventoryColumnPrefs } from '../../hooks/useInventoryColumnPrefs';
import { useStockLevels, useAdjustBatch } from '../../hooks/useInventory';
import { useMultistoreEnabled } from '../../hooks/useMultistore';
import { useStoreLocations, useStockLevelsByStore, useStoreLotsAtStore } from '../../hooks/useWarehouse';
import { StoreLocationSelect } from '../../components/inventory/StoreLocationSelect';
import { useProducts } from '../../hooks/useProducts';
import { useStockMovements } from '../../hooks/useStockMovements';
import { BatchAdjustmentSchema } from '@shared/zod/inventory';
import { INVENTORY_STOCK_ADJUST_PERMISSIONS } from '@shared/authorization/inventoryAdjustPermissions';
import { useHasAnyPermission } from '../../authorization/useAuthorization';
import { getBusinessDate } from '../../utils/businessDate';
import { MobileSortSelect } from '../../components/ui/MobileSortSelect';
import { useColumnSort } from '../../hooks/useColumnSort';
import { applyTableSort } from '../../lib/tableSortUtils';
import SlideDrawer from '../../components/ui/SlideDrawer';
import { WorkflowHelpTrigger } from '../../components/inventory/shared';
import {
  AdjustInventoryDrawer,
  resolveAdjustInventoryTarget,
  resolveDefaultAdjustStoreId,
  formatAdjustStoreLabel,
  type AdjustInventoryTarget,
} from '../../components/inventory/AdjustInventoryDrawer';

type AdjustmentBatchSortField =
  | 'product'
  | 'category'
  | 'batchNumber'
  | 'quantity'
  | 'expiryDate'
  | 'status';

const ADJUSTMENT_BATCH_DESC_DEFAULT = new Set<AdjustmentBatchSortField>([
  'quantity',
  'expiryDate',
]);

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

// Batch type from backend response
interface Batch {
  id: string;
  batch_id?: string;
  product_lot_id?: string;
  product_id: string;
  product_name: string;
  batch_number: string;
  remaining_quantity: number;
  expiry_date?: string | null;
  cost_price: number;
  status: string;
  created_at: string;
}

// (types inferred from API; dedicated interfaces removed to avoid unused warnings)

// Product item for physical count (can have zero stock)
interface PhysicalCountItem {
  id: string;
  product_id: string;
  product_name: string;
  sku: string;
  expected_quantity: number;
  has_stock: boolean;
}

// Product row from products hook
interface ProductRow {
  id: string;
  name: string;
  sku?: string;
  status?: string;
  category?: string;
}

// Stock level row from API (snake_case)
interface StockLevelRow {
  product_id: string;
  product_name: string;
  sku?: string;
  total_stock?: string | number;
  total_quantity?: string | number;
  nearest_expiry?: string | null;
  average_cost?: string | number;
}

export default function InventoryAdjustmentsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { isMultistoreEnabled } = useMultistoreEnabled();
  const { data: stores = [] } = useStoreLocations(isMultistoreEnabled);
  // INV-POS SSOT: sellable stock lives on SELLING — never default Adjustments to MAIN warehouse.
  const defaultAdjustmentStoreId = resolveDefaultAdjustStoreId(stores);
  const [adjustmentStoreId, setAdjustmentStoreId] = useState<string>('');
  const adjustmentStoreLabel = formatAdjustStoreLabel(
    stores.find((s) => s.id === (adjustmentStoreId || defaultAdjustmentStoreId)),
  );

  useEffect(() => {
    if (defaultAdjustmentStoreId && !adjustmentStoreId) {
      setAdjustmentStoreId(defaultAdjustmentStoreId);
    }
  }, [defaultAdjustmentStoreId, adjustmentStoreId]);

  const { data: stockLevelsData, isLoading, error } = useStockLevels();
  const { data: storeStockLevels = [] } = useStockLevelsByStore(
    adjustmentStoreId || null,
    isMultistoreEnabled && !!adjustmentStoreId,
  );
  const { data: storeLots = [] } = useStoreLotsAtStore(
    adjustmentStoreId || null,
    isMultistoreEnabled && !!adjustmentStoreId,
  );
  const adjustBatchMutation = useAdjustBatch();
  // Load products for category map (static, for batch search)
  const { data: productsData } = useProducts({ limit: 500 });

  // Get recent adjustment movements for quick reference (today only)
  const todayStr = getBusinessDate();
  const { data: recentAdjustmentsData } = useStockMovements({
    movementType: 'ADJUSTMENT_IN,ADJUSTMENT_OUT',
    startDate: todayStr,
    limit: 10,
  });

  const ITEMS_PER_PAGE = 50;
  const [searchTerm, setSearchTerm] = useState('');
  const columnPrefs = useInventoryColumnPrefs('adjustments');
  const { show: showCol } = columnPrefs;
  const [currentPage, setCurrentPage] = useState(1);
  const [filterQtyOnly, setFilterQtyOnly] = useState(false);
  const { sortField, sortOrder, handleSort, setSortOrder } =
    useColumnSort<AdjustmentBatchSortField>('product', 'asc');
  const [physicalCountPage, setPhysicalCountPage] = useState(1);
  const [adjustTarget, setAdjustTarget] = useState<AdjustInventoryTarget | null>(null);
  const [showAdjustModal, setShowAdjustModal] = useState(false);
  const [adjustInitialCategory, setAdjustInitialCategory] = useState<
    'ADJUSTMENT' | 'DAMAGE' | 'EXPIRY'
  >('ADJUSTMENT');

  // Physical Count modal state
  const [showPhysicalCountModal, setShowPhysicalCountModal] = useState(false);

  const [countedQuantities, setCountedQuantities] = useState<Record<string, string>>({});
  const [physicalCountReason, setPhysicalCountReason] = useState('Physical inventory count - ' + getBusinessDate());
  const [isProcessingCount, setIsProcessingCount] = useState(false);
  const [physicalCountSearchTerm, setPhysicalCountSearchTerm] = useState('');
  const [showOnlyDiscrepancies, setShowOnlyDiscrepancies] = useState(false);
  const [showOnlyUncounted, setShowOnlyUncounted] = useState(false);

  // Physical count: server-side search so all products are reachable (DB has >500 products)
  // When search term ≥2 chars, API filters server-side; otherwise loads first 500.
  const pcSearchParam = physicalCountSearchTerm.trim().length >= 2 ? physicalCountSearchTerm.trim() : undefined;
  const { data: pcProductsData } = useProducts({ search: pcSearchParam, limit: 500 });

  // Get current user from localStorage
  const currentUser = useMemo(() => {
    try {
      const userStr = localStorage.getItem('user');
      return userStr ? JSON.parse(userStr) : null;
    } catch {
      return null;
    }
  }, []);

  // Keyboard shortcuts for physical count modal
  useEffect(() => {
    if (!showPhysicalCountModal) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Enter submits Process Count (only when not in an input/textarea to avoid conflicts)
      if (e.key === 'Enter' && !e.shiftKey) {
        const tag = (e.target as HTMLElement).tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        e.preventDefault();
        const hasCounted = Object.values(countedQuantities).some(v => v !== '');
        const canSubmit = !isProcessingCount && hasCounted && physicalCountReason.trim();
        if (canSubmit) handleSubmitPhysicalCount();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showPhysicalCountModal, isProcessingCount, countedQuantities, physicalCountReason]);

  const canAdjust = useHasAnyPermission([...INVENTORY_STOCK_ADJUST_PERMISSIONS]);

  const adjustmentStores = useMemo(
    () => stores.filter((s) => s.isActive && ['MAIN', 'SELLING', 'DAMAGE', 'EXPIRED', 'RETURN'].includes(s.storeType)),
    [stores],
  );

  // Extract stock levels and create batch list
  const batches = useMemo(() => {
    if (isMultistoreEnabled && storeLots.length > 0) {
      return storeLots.map((lot) => ({
        id: lot.productLotId,
        product_lot_id: lot.productLotId,
        batch_id: lot.inventoryBatchId ?? undefined,
        product_id: lot.productId,
        product_name: lot.productName,
        batch_number: lot.lotNumber,
        // Store-available qty is SSOT for this screen — never overwrite with batch master alone.
        remaining_quantity: lot.availableQuantity,
        expiry_date: lot.expiryDate,
        cost_price: 0,
        status: 'ACTIVE',
        created_at: getBusinessDate(),
      }));
    }

    const levelsSource = isMultistoreEnabled
      ? (Array.isArray(storeStockLevels) ? storeStockLevels : [])
      : (stockLevelsData?.data ? (Array.isArray(stockLevelsData.data) ? stockLevelsData.data : []) : []);

    if (!levelsSource.length && !isMultistoreEnabled) return [];

    return levelsSource.flatMap(
      (level: {
        product_id: string;
        product_name: string;
        sku?: string;
        total_stock?: string;
        total_quantity?: string;
        nearest_expiry?: string | null;
        average_cost?: string;
      }) => {
        // Mock: Assume single batch per product for simplicity
        return [
          {
            id: level.product_id, // Placeholder — stock level rows have no real batch ID; real batches fetched on demand
            batch_id: undefined,
            product_lot_id: undefined,
            product_id: level.product_id,
            product_name: level.product_name,
            batch_number: level.sku || 'MAIN',
            remaining_quantity: parseFloat(
              String(level.total_stock || level.total_quantity || '0')
            ),
            expiry_date: level.nearest_expiry || null,
            cost_price: parseFloat(String(level.average_cost || '0')),
            status: 'ACTIVE',
            created_at: getBusinessDate(),
          },
        ];
      }
    );
  }, [stockLevelsData, isMultistoreEnabled, storeLots, storeStockLevels]);

  // Product category lookup by product_id
  const productCategoryMap = useMemo(() => {
    const map = new Map<string, string>();
    if (productsData) {
      const prods = (productsData as { data?: ProductRow[] }).data || (Array.isArray(productsData) ? productsData as ProductRow[] : []);
      prods.forEach((p: ProductRow) => {
        if (p.category) map.set(p.id, p.category);
      });
    }
    return map;
  }, [productsData]);

  // Filter batches based on search
  const filteredBatches = useMemo(() => {
    if (!searchTerm) return batches;

    const term = searchTerm.toLowerCase();
    return batches.filter(
      (batch: Batch) =>
        batch.product_name.toLowerCase().includes(term) ||
        batch.batch_number.toLowerCase().includes(term) ||
        (productCategoryMap.get(batch.product_id) || '').toLowerCase().includes(term)
    );
  }, [batches, searchTerm, productCategoryMap]);

  const batchSortAccessors = useMemo(
    () => ({
      product: (batch: Batch) => batch.product_name ?? '',
      category: (batch: Batch) => productCategoryMap.get(batch.product_id) ?? '',
      batchNumber: (batch: Batch) => batch.batch_number ?? '',
      quantity: (batch: Batch) => batch.remaining_quantity ?? 0,
      expiryDate: (batch: Batch) => batch.expiry_date ?? '',
      status: (batch: Batch) => batch.status ?? '',
    }),
    [productCategoryMap],
  );

  const handleColumnSort = (field: string) => {
    const f = field as AdjustmentBatchSortField;
    if (f === 'quantity') {
      setFilterQtyOnly(true);
      handleSort(f, { defaultOrder: 'desc' });
      return;
    }
    setFilterQtyOnly(false);
    handleSort(f, {
      defaultOrder: ADJUSTMENT_BATCH_DESC_DEFAULT.has(f) ? 'desc' : 'asc',
    });
  };

  const mobileSortOptions = [
    { value: 'product', label: 'Sort by Product' },
    { value: 'category', label: 'Sort by Category' },
    { value: 'batchNumber', label: 'Sort by Batch Number' },
    { value: 'quantity', label: 'Sort by Quantity' },
    { value: 'expiryDate', label: 'Sort by Expiry Date' },
    { value: 'status', label: 'Sort by Status' },
  ];

  const sortedBatches = useMemo(() => {
    let rows = [...filteredBatches];
    if (filterQtyOnly) {
      rows = rows.filter((batch) => (batch.remaining_quantity ?? 0) > 0);
    }
    return applyTableSort(rows, sortField, sortOrder, batchSortAccessors);
  }, [filteredBatches, filterQtyOnly, sortField, sortOrder, batchSortAccessors]);

  // Pagination for batch table
  const batchTotalPages = Math.max(1, Math.ceil(sortedBatches.length / ITEMS_PER_PAGE));
  const paginatedBatches = useMemo(() => {
    const start = (currentPage - 1) * ITEMS_PER_PAGE;
    return sortedBatches.slice(start, start + ITEMS_PER_PAGE);
  }, [sortedBatches, currentPage]);

  // Reset batch page on search or sort change
  useEffect(() => { setCurrentPage(1); }, [searchTerm, filterQtyOnly, sortField, sortOrder]);

  // Products for physical count (uses pcProductsData — server-side search-aware)
  const products = useMemo(() => {
    if (!pcProductsData) return [];
    if (pcProductsData.data && Array.isArray(pcProductsData.data)) {
      return pcProductsData.data;
    }
    return Array.isArray(pcProductsData) ? pcProductsData : [];
  }, [pcProductsData]);

  // Stock level lookup by product_id
  const stockLevelMap = useMemo(() => {
    const map = new Map<string, number>();
    const levels = isMultistoreEnabled
      ? (Array.isArray(storeStockLevels) ? storeStockLevels : [])
      : (stockLevelsData?.data ? (Array.isArray(stockLevelsData.data) ? stockLevelsData.data : []) : []);
    levels.forEach((level: StockLevelRow) => {
      map.set(level.product_id, parseFloat(String(level.total_stock || level.total_quantity || 0)));
    });
    return map;
  }, [stockLevelsData, isMultistoreEnabled, storeStockLevels]);

  // Product-based list for physical counting
  const physicalCountItems = useMemo((): PhysicalCountItem[] => {
    const activeProducts = products.filter((p: ProductRow) => p.status === 'ACTIVE' || !p.status);
    return activeProducts.map((product: ProductRow) => {
      const currentStock = stockLevelMap.get(product.id) || 0;
      return {
        id: `product-${product.id}`,
        product_id: product.id,
        product_name: product.name,
        sku: product.sku || 'N/A',
        expected_quantity: currentStock,
        has_stock: currentStock > 0,
      };
    });
  }, [products, stockLevelMap]);

  // Physical count statistics
  const physicalCountStats = useMemo(() => {
    const counted = physicalCountItems.filter(item => countedQuantities[item.id] !== undefined && countedQuantities[item.id] !== '').length;
    const discrepancies = physicalCountItems.filter(item => {
      const countedValue = countedQuantities[item.id];
      return countedValue !== undefined && countedValue !== '' && parseFloat(countedValue) !== item.expected_quantity;
    }).length;
    return {
      total: physicalCountItems.length,
      counted,
      remaining: physicalCountItems.length - counted,
      discrepancies,
    };
  }, [physicalCountItems, countedQuantities]);

  // Filter physical count items
  // Text filtering is handled server-side (see pcProductsData / pcSearchParam).
  // Client-side filters only apply to discrepancy/uncounted toggles.
  const physicalCountFilteredItems = useMemo(() => {
    let filtered = [...physicalCountItems];
    if (showOnlyDiscrepancies) {
      filtered = filtered.filter(item => {
        const countedValue = countedQuantities[item.id];
        return countedValue !== undefined && countedValue !== '' && parseFloat(countedValue) !== item.expected_quantity;
      });
    }
    if (showOnlyUncounted) {
      filtered = filtered.filter(item =>
        countedQuantities[item.id] === undefined || countedQuantities[item.id] === ''
      );
    }
    return filtered;
  }, [physicalCountItems, showOnlyDiscrepancies, showOnlyUncounted, countedQuantities]);

  // Pagination for physical count items
  const physicalCountTotalPages = Math.max(1, Math.ceil(physicalCountFilteredItems.length / ITEMS_PER_PAGE));
  const paginatedPhysicalCountItems = useMemo(() => {
    const start = (physicalCountPage - 1) * ITEMS_PER_PAGE;
    return physicalCountFilteredItems.slice(start, start + ITEMS_PER_PAGE);
  }, [physicalCountFilteredItems, physicalCountPage]);

  // Reset physical count page on filter changes
  useEffect(() => { setPhysicalCountPage(1); }, [physicalCountSearchTerm, showOnlyDiscrepancies, showOnlyUncounted]);

  // Handle counted quantity change
  const handleCountedQtyChange = (itemId: string, value: string) => {
    setCountedQuantities(prev => ({ ...prev, [itemId]: value }));
  };

  // Handle Physical Count submission
  const handleSubmitPhysicalCount = async () => {
    if (!currentUser) return;
    setIsProcessingCount(true);

    try {
      // Build enterprise adjustment records — explicit direction, reason = PHYSICAL_COUNT
      const adjustments = physicalCountItems
        .filter(item => {
          const counted = countedQuantities[item.id];
          return counted !== undefined && counted !== '' && parseFloat(counted) !== item.expected_quantity;
        })
        .map(item => {
          const counted = parseFloat(countedQuantities[item.id]);
          const current = item.expected_quantity;
          const diff = counted - current;
          return {
            productId: item.product_id,
            quantity: Math.abs(diff),
            direction: diff > 0 ? 'IN' as const : 'OUT' as const,
            notes: `${physicalCountReason} | SKU: ${item.sku} | Expected: ${current.toFixed(2)}, Counted: ${counted.toFixed(2)}`,
            productName: item.product_name,
          };
        });

      if (adjustments.length === 0) {
        alert('No differences found. All counted quantities match expected quantities.');
        setIsProcessingCount(false);
        return;
      }

      const confirmMsg = `Process physical count?\n\n${adjustments.length} adjustment(s) will be created:\n${adjustments.slice(0, 5).map(a => `• ${a.productName}: ${a.direction === 'IN' ? '+' : '-'}${a.quantity.toFixed(2)}`).join('\n')}${adjustments.length > 5 ? `\n... and ${adjustments.length - 5} more` : ''}`;
      if (!window.confirm(confirmMsg)) {
        setIsProcessingCount(false);
        return;
      }

      let successCount = 0;
      let errorCount = 0;
      const errors: string[] = [];

      for (const adj of adjustments) {
        try {
          const validatedData = BatchAdjustmentSchema.parse({
            productId: adj.productId,
            storeLocationId: isMultistoreEnabled ? adjustmentStoreId || undefined : undefined,
            quantity: adj.quantity,
            direction: adj.direction,
            reason: 'PHYSICAL_COUNT',
            notes: adj.notes,
            userId: currentUser.id,
          });
          await adjustBatchMutation.mutateAsync(validatedData);
          successCount++;
        } catch (err) {
          const apiErr = err as { response?: { data?: { error_code?: string; details?: { remaining?: number; requested?: number } } }; message?: string };
          const errCode = apiErr?.response?.data?.error_code;
          const details = apiErr?.response?.data?.details;
          const msg = errCode === 'INSUFFICIENT_BATCH_QTY'
            ? `Has ${details?.remaining ?? 0} remaining, requested ${details?.requested ?? adj.quantity}`
            : (err instanceof Error ? err.message : String(err));
          errors.push(`${adj.productName}: ${msg}`);
          errorCount++;
        }
      }

      let resultMessage = `Physical count complete!\n✅ ${successCount} PHYSICAL_COUNT adjustment(s) created`;
      if (errorCount > 0) {
        resultMessage += `\n\n❌ ${errorCount} failed:\n${errors.slice(0, 3).join('\n')}${errors.length > 3 ? `\n... and ${errors.length - 3} more` : ''}`;
      }
      alert(resultMessage);

      setShowPhysicalCountModal(false);
      setCountedQuantities({});
      setPhysicalCountReason('Physical inventory count - ' + getBusinessDate());
      queryClient.invalidateQueries({ queryKey: ['stockLevels'] });
      queryClient.invalidateQueries({ queryKey: ['stockMovements'] });
    } catch (err) {
      alert(`Failed to process physical count: ${(err as Error).message}`);
    } finally {
      setIsProcessingCount(false);
    }
  };

  // Recent adjustments for display
  const recentAdjustments = useMemo(() => {
    if (!recentAdjustmentsData?.data) return [];
    return Array.isArray(recentAdjustmentsData.data) ? recentAdjustmentsData.data : [];
  }, [recentAdjustmentsData]);

  // Handle adjustment modal open — shared resolver for batch + store-available qty
  const handleOpenAdjustModal = async (
    batch: Batch,
    initialMovementCategory: 'ADJUSTMENT' | 'DAMAGE' | 'EXPIRY' = 'ADJUSTMENT',
  ) => {
    if (!canAdjust) {
      alert(
        'You do not have permission to adjust inventory. Need inventory.adjust or inventory.approve.',
      );
      return;
    }

    const target = await resolveAdjustInventoryTarget({
      productId: batch.product_id,
      productName: batch.product_name,
      preferredBatchId: batch.batch_id,
      productLotId: batch.product_lot_id,
      batchNumber: batch.batch_number,
      currentQuantity: batch.remaining_quantity,
      storeLocationId: isMultistoreEnabled ? adjustmentStoreId || undefined : undefined,
      storeLabel: isMultistoreEnabled ? adjustmentStoreLabel : undefined,
    });
    setAdjustInitialCategory(initialMovementCategory);
    setAdjustTarget(target);
    setShowAdjustModal(true);
  };

  // View full audit trail in Stock Movements page
  const handleViewAllMovements = () => {
    navigate('/inventory/stock-movements?type=ADJUSTMENT_IN,ADJUSTMENT_OUT,DAMAGE,EXPIRY');
  };

  // Must stay above loading/error/permission early returns — hooks order SSOT.
  const adjustmentBatchColumns: AdaptiveDataColumn<Batch>[] = useMemo(() => {
    const all: AdaptiveDataColumn<Batch>[] = [
    {
      id: 'product',
      header: 'Product',
      priority: 'primary',
      cardRole: 'title',
      cell: (batch) => (
        <span className="text-sm font-medium text-gray-900">{batch.product_name}</span>
      ),
    },
    {
      id: 'category',
      header: 'Category',
      priority: 'secondary',
      cardRole: 'subtitle',
      cell: (batch) => {
        const cat = productCategoryMap.get(batch.product_id);
        return cat ? (
          <span className="inline-flex px-2 py-0.5 text-xs font-medium rounded-full bg-blue-50 text-blue-700">
            {cat}
          </span>
        ) : (
          <span className="text-gray-400">—</span>
        );
      },
    },
    {
      id: 'batchNumber',
      header: 'Batch Number',
      priority: 'secondary',
      cardRole: 'meta',
      cell: (batch) => <span className="text-sm text-gray-900">{batch.batch_number}</span>,
    },
    {
      id: 'quantity',
      header: 'Quantity',
      priority: 'primary',
      cardRole: 'amount',
      align: 'right',
      cell: (batch) => (
        <span className="font-semibold tabular-nums">{batch.remaining_quantity.toFixed(2)}</span>
      ),
    },
    {
      id: 'expiryDate',
      header: 'Expiry Date',
      priority: 'secondary',
      cardRole: 'meta',
      cell: (batch) => (
        <span className="text-sm text-gray-600">
          {batch.expiry_date ? formatDisplayDate(batch.expiry_date) : 'N/A'}
        </span>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      priority: 'secondary',
      cardRole: 'status',
      cell: (batch) => (
        <span
          className={`inline-flex px-2 py-0.5 text-xs font-semibold rounded-full ${
            batch.status === 'ACTIVE' ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'
          }`}
        >
          {batch.status}
        </span>
      ),
    },
  ];
    return all.filter((c) => showCol(c.id));
  }, [productCategoryMap, showCol]);

  if (isLoading) {
    return (
      <div className="p-6">
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <p className="text-blue-800">Loading inventory batches...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <p className="text-red-800">Failed to load inventory. Please try again.</p>
        </div>
      </div>
    );
  }

  if (!canAdjust) {
    return (
      <div className="p-6">
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
          <h3 className="text-lg font-semibold text-yellow-900 mb-2">⚠️ Access Restricted</h3>
          <p className="text-yellow-800">
            You do not have permission to access inventory adjustments.
            <br />
            Required permission: <strong>inventory.adjust</strong> or{' '}
            <strong>inventory.approve</strong>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div data-inventory-adjustments-page="true">
      <AdaptivePage
        className={ADAPTIVE_PAGE_PAD_CLASS}
        title={
          <span className="inline-flex items-center gap-2">
            Adjustments & Stock Count
            <WorkflowHelpTrigger title="About Adjustments & Stock Count">
              <ul className="space-y-1">
                <li>• <strong>Adjustment:</strong> Increase or decrease stock for corrections</li>
                <li>• <strong>Damage:</strong> Record stock lost due to physical damage</li>
                <li>• <strong>Damage / Expiry:</strong> Quarantine first (no P&amp;L) — dispose from Quarantine workqueue</li>
                <li>• <strong>Physical Count:</strong> Compare physical stock vs system, auto-create adjustments for discrepancies</li>
                <li>• All records create immutable stock movement entries for full audit trail</li>
                <li>• View <strong>Movement History</strong> for the complete audit trail</li>
                <li>
                  • <strong>Permission Required:</strong> inventory.adjust or inventory.approve
                </li>
              </ul>
            </WorkflowHelpTrigger>
          </span>
        }
        description="Record stock adjustments, damages, expiry quarantine, and physical counts"
        densityOverride={ADAPTIVE_WORKLIST_DENSITY}
        toolbarInline
        toolbar={
          <div className={`${ADAPTIVE_TOOLBAR_CARD_CLASS} space-y-3`} data-adj-filters="true">
            {isMultistoreEnabled && adjustmentStores.length > 0 ? (
              <div className="max-w-sm">
                <StoreLocationSelect
                  id="adjustment-store"
                  label="Adjust at store"
                  stores={adjustmentStores}
                  value={adjustmentStoreId}
                  onChange={setAdjustmentStoreId}
                />
                <p className="text-xs text-gray-500 mt-1">
                  Stock changes apply to the selected location&apos;s lot balances.
                </p>
              </div>
            ) : null}
            <AdaptiveToolbar
              modeOverride="compact"
              actionsBeforeLeading
              leading={
                <AdaptiveSearch
                  value={searchTerm}
                  onChange={(v) => {
                    setSearchTerm(v);
                    setCurrentPage(1);
                  }}
                  placeholder="Product name or batch number…"
                  label="Search batches"
                  presentationOverride="compact"
                />
              }
              secondaryLabel="Options"
              secondary={({ close }) => (
                <div className="space-y-3 w-full" data-adj-options-panel="true">
                  <label className="flex items-center gap-2 text-sm text-gray-700">
                    <input
                      type="checkbox"
                      checked={filterQtyOnly}
                      onChange={(e) => {
                        setFilterQtyOnly(e.target.checked);
                        setCurrentPage(1);
                        close();
                      }}
                    />
                    Batches with quantity only
                  </label>
                  <button
                    type="button"
                    onClick={() => close()}
                    className="w-full rounded-md bg-stone-900 px-3 py-2 text-sm font-medium text-white min-h-[var(--layout-touch-target)]"
                  >
                    Done
                  </button>
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
                  <button
                    type="button"
                    role="menuitem"
                    onClick={handleViewAllMovements}
                    data-adj-movements-link="true"
                  >
                    Movement History
                  </button>
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
                onClick={() => setShowPhysicalCountModal(true)}
                className="inline-flex items-center justify-center rounded-lg bg-purple-600 px-3 py-2 text-sm font-medium text-white hover:bg-purple-700 min-h-[var(--layout-touch-target)]"
                data-adj-primary-cta="true"
              >
                Physical Count
              </button>
            </AdaptiveToolbar>
          </div>
        }
      >

      {/* Recent Adjustments Summary */}
      {recentAdjustments.length > 0 && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 sm:p-4">
          <div className="flex justify-between items-center mb-3">
            <h3 className="text-sm font-semibold text-blue-900">
              Today&apos;s Adjustments ({recentAdjustments.length})
            </h3>
            <button
              type="button"
              onClick={handleViewAllMovements}
              className="text-sm text-blue-700 hover:text-blue-900 font-medium"
            >
              View All →
            </button>
          </div>
          <div className="space-y-2">
            {recentAdjustments
              .slice(0, 5)
              .map(
                (adj: {
                  id: string;
                  movementType?: string;
                  movement_type?: string;
                  productName?: string;
                  product_name?: string;
                  quantity?: number;
                  createdAt?: string;
                  created_at?: string;
                }) => {
                  const movementType = adj.movementType || adj.movement_type || '';
                  const productName = adj.productName || adj.product_name || 'Unknown';
                  const createdAt = adj.createdAt || adj.created_at || '';
                  return (
                    <div
                      key={adj.id}
                      className="flex items-center justify-between text-sm bg-white rounded px-3 py-2 gap-2"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className={
                            movementType === 'ADJUSTMENT_IN'
                              ? 'text-green-600 font-bold shrink-0'
                              : 'text-red-600 font-bold shrink-0'
                          }
                        >
                          {movementType === 'ADJUSTMENT_IN' ? '+' : '−'}
                        </span>
                        <span className="font-medium text-gray-900 truncate">
                          {productName}
                        </span>
                        <span className="text-gray-600 shrink-0 tabular-nums">
                          {movementType === 'ADJUSTMENT_IN' ? '+' : '-'}
                          {Math.abs(adj.quantity || 0).toFixed(2)}
                        </span>
                      </div>
                      <div className="text-xs text-gray-500 shrink-0">
                        {createdAt?.includes('T')
                          ? `${formatDisplayDate(createdAt)} ${createdAt.split('T')[1].substring(0, 8)}`
                          : formatDisplayDate(createdAt)}
                      </div>
                    </div>
                  );
                }
              )}
          </div>
        </div>
      )}

      {filterQtyOnly && (
        <div className="px-3 py-2 bg-amber-50 border border-amber-100 rounded-lg text-xs text-amber-900 flex items-center justify-between gap-2">
          <span>Showing batches with remaining quantity only ({sortedBatches.length})</span>
          <button
            type="button"
            className="text-amber-800 underline shrink-0"
            onClick={() => {
              setFilterQtyOnly(false);
              handleSort('product', { defaultOrder: 'asc' });
            }}
          >
            Clear filter
          </button>
        </div>
      )}

      {/* Batches — AdaptiveDataGrid cards on phone / table on desktop */}
      <div className="bg-white rounded-lg shadow overflow-hidden border border-gray-100">
        <AdaptiveDataGrid
          rows={paginatedBatches}
          getRowId={(batch) => batch.id}
          emptyMessage={searchTerm ? 'No batches match your search' : 'No inventory batches found'}
          columns={adjustmentBatchColumns}
          renderRowActions={(batch) => (
            <AdaptiveRowActions
              actions={[
                {
                  id: 'adjust',
                  label: 'Adjust',
                  tone: 'primary',
                  onClick: () => handleOpenAdjustModal(batch),
                },
                {
                  id: 'damage',
                  label: 'Damage',
                  tone: 'warning',
                  onClick: () => {
                    void handleOpenAdjustModal(batch, 'DAMAGE');
                  },
                },
                {
                  id: 'history',
                  label: 'History',
                  tone: 'muted',
                  onClick: () =>
                    navigate(`/inventory/stock-movements?product=${batch.product_id}`),
                },
              ]}
            />
          )}
        />
      </div>

      {/* Batch Table Pagination */}
      {sortedBatches.length > ITEMS_PER_PAGE && (
        <div className="mt-4 flex justify-between items-center">
          <div className="text-sm text-gray-600">
            Showing {((currentPage - 1) * ITEMS_PER_PAGE) + 1}–{Math.min(currentPage * ITEMS_PER_PAGE, sortedBatches.length)} of {sortedBatches.length} batches
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
              disabled={currentPage === 1}
              className="px-4 py-2 text-sm bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              ← Previous
            </button>
            <span className="px-3 py-2 text-sm text-gray-700">
              Page {currentPage} of {batchTotalPages}
            </span>
            <button
              onClick={() => setCurrentPage(p => Math.min(batchTotalPages, p + 1))}
              disabled={currentPage === batchTotalPages}
              className="px-4 py-2 text-sm bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Next →
            </button>
          </div>
        </div>
      )}

      </AdaptivePage>

      {/* Adjustment workspace — SSOT AdjustInventoryDrawer (also used from Products Edit) */}
      <AdjustInventoryDrawer
        open={showAdjustModal}
        target={adjustTarget}
        initialMovementCategory={adjustInitialCategory}
        onClose={() => {
          setShowAdjustModal(false);
          setAdjustTarget(null);
          setAdjustInitialCategory('ADJUSTMENT');
        }}
      />

      {/* Physical count workspace */}
      <SlideDrawer
        open={showPhysicalCountModal}
        onClose={() => {
          if (!isProcessingCount) setShowPhysicalCountModal(false);
        }}
        title="Physical Inventory Count"
        subtitle="Enter actual counted quantities for each product"
        width="full"
        transactional
        cancellable={false}
        guardLabel="Physical stock count"
        footer={
          <div className="flex justify-between items-center gap-4 flex-wrap">
            <div className="text-sm text-gray-600">
              {physicalCountStats.discrepancies > 0 ? (
                <span className="text-yellow-600 font-medium">
                  ⚠️ {physicalCountStats.discrepancies} item(s) with discrepancies will be adjusted
                </span>
              ) : physicalCountStats.counted > 0 ? (
                <span className="text-green-600 font-medium">
                  ✅ All counted quantities match expected
                </span>
              ) : (
                <span>Enter counted quantities to see discrepancies</span>
              )}
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => setShowPhysicalCountModal(false)}
                className="px-4 py-2 text-gray-700 bg-white border border-gray-300 hover:bg-gray-50 rounded-lg font-medium"
                disabled={isProcessingCount}
              >
                Cancel
              </button>
              <button
                onClick={handleSubmitPhysicalCount}
                disabled={isProcessingCount || physicalCountStats.counted === 0 || !physicalCountReason.trim()}
                className="px-4 py-2 bg-purple-600 text-white hover:bg-purple-700 rounded-lg font-medium disabled:bg-gray-300 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {isProcessingCount ? (
                  <>
                    <span className="animate-spin">⏳</span>
                    <span>Processing...</span>
                  </>
                ) : (
                  <>
                    <span>✅</span>
                    <span>Process Count ({physicalCountStats.discrepancies} adjustments)</span>
                  </>
                )}
              </button>
            </div>
          </div>
        }
      >
            {/* Statistics Bar — global AdaptiveKpiStrip (2-up phone) */}
            <div className="px-4 sm:px-6 py-3 bg-gray-50 border-b border-gray-200">
              <AdaptiveKpiStrip
                items={[
                  { id: 'pc-total', label: 'Total Items', value: physicalCountStats.total },
                  {
                    id: 'pc-counted',
                    label: 'Counted',
                    value: physicalCountStats.counted,
                    valueClassName: 'text-blue-600',
                  },
                  {
                    id: 'pc-remaining',
                    label: 'Remaining',
                    value: physicalCountStats.remaining,
                    valueClassName: 'text-yellow-600',
                  },
                  {
                    id: 'pc-disc',
                    label: 'Discrepancies',
                    value: physicalCountStats.discrepancies,
                    valueClassName: 'text-red-600',
                  },
                ]}
              />
            </div>

            {/* Count Reason */}
            <div className="px-6 py-3 bg-white border-b border-gray-200">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Count Reference / Reason
              </label>
              <input
                type="text"
                value={physicalCountReason}
                onChange={(e) => setPhysicalCountReason(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500"
                placeholder="e.g., Monthly physical count - March 2026"
              />
            </div>

            {/* Search and Filters */}
            <div className="px-6 py-3 bg-white border-b border-gray-200">
              <div className="mb-3">
                <input
                  type="text"
                  value={physicalCountSearchTerm}
                  onChange={(e) => setPhysicalCountSearchTerm(e.target.value)}
                  placeholder="🔍 Search by product name or SKU..."
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500"
                />
              </div>
              <div className="flex gap-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={showOnlyUncounted}
                    onChange={(e) => setShowOnlyUncounted(e.target.checked)}
                    className="w-4 h-4 text-purple-600 rounded focus:ring-purple-500"
                  />
                  <span className="text-sm text-gray-700">Show only uncounted</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={showOnlyDiscrepancies}
                    onChange={(e) => setShowOnlyDiscrepancies(e.target.checked)}
                    className="w-4 h-4 text-purple-600 rounded focus:ring-purple-500"
                  />
                  <span className="text-sm text-gray-700">Show only discrepancies</span>
                </label>
              </div>
            </div>

            {/* Products Table */}
            <div className="flex-1 overflow-y-auto px-6 py-4">
              {physicalCountItems.length === 0 ? (
                <div className="text-center text-gray-500 py-8">
                  No products found. Please add products first.
                </div>
              ) : physicalCountFilteredItems.length === 0 ? (
                <div className="text-center text-gray-500 py-8">
                  No items match your search or filter criteria.
                </div>
              ) : (
                <ResponsiveTableWrapper>
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50 sticky top-0">
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Product</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">SKU</th>
                        <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Expected Qty</th>
                        <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Counted Qty</th>
                        <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Difference</th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                      {paginatedPhysicalCountItems.map((item) => {
                        const countedValue = countedQuantities[item.id];
                        const counted = countedValue !== undefined && countedValue !== '' ? parseFloat(countedValue) : null;
                        const difference = counted !== null ? counted - item.expected_quantity : null;
                        const hasDifference = difference !== null && Math.abs(difference) > 0.001;

                        return (
                          <tr key={item.id} className={hasDifference ? 'bg-yellow-50' : !item.has_stock ? 'bg-gray-50' : ''}>
                            <td className="px-4 py-3 text-sm">
                              <div className="font-medium text-gray-900">{item.product_name}</div>
                              {!item.has_stock && (
                                <div className="text-xs text-gray-500">No stock on record</div>
                              )}
                            </td>
                            <td className="px-4 py-3 text-sm text-gray-600">{item.sku}</td>
                            <td className="px-4 py-3 text-sm text-right font-medium text-gray-900">
                              {item.expected_quantity.toFixed(2)}
                            </td>
                            <td className="px-4 py-3 text-sm text-right">
                              <input
                                type="number"
                                value={countedValue || ''}
                                onChange={(e) => handleCountedQtyChange(item.id, e.target.value)}
                                step="1"
                                min="0"
                                placeholder="0.00"
                                className="w-32 px-2 py-1 border border-gray-300 rounded text-right focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
                                disabled={isProcessingCount}
                              />
                            </td>
                            <td className="px-4 py-3 text-sm text-right">
                              {difference !== null ? (
                                <span className={`font-medium ${Math.abs(difference) < 0.001 ? 'text-green-600' :
                                  difference > 0 ? 'text-blue-600' : 'text-red-600'
                                  }`}>
                                  {difference > 0 ? '+' : ''}{difference.toFixed(2)}
                                </span>
                              ) : (
                                <span className="text-gray-400">—</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </ResponsiveTableWrapper>
              )}
            </div>

            {/* Physical Count Pagination */}
            {physicalCountFilteredItems.length > ITEMS_PER_PAGE && (
              <div className="px-6 py-3 border-t border-gray-200 flex justify-between items-center">
                <div className="text-sm text-gray-600">
                  Showing {((physicalCountPage - 1) * ITEMS_PER_PAGE) + 1}–{Math.min(physicalCountPage * ITEMS_PER_PAGE, physicalCountFilteredItems.length)} of {physicalCountFilteredItems.length} items
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => setPhysicalCountPage(p => Math.max(1, p - 1))}
                    disabled={physicalCountPage === 1}
                    className="px-3 py-1 text-sm bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    ← Previous
                  </button>
                  <span className="px-2 py-1 text-sm text-gray-700">
                    Page {physicalCountPage} of {physicalCountTotalPages}
                  </span>
                  <button
                    onClick={() => setPhysicalCountPage(p => Math.min(physicalCountTotalPages, p + 1))}
                    disabled={physicalCountPage === physicalCountTotalPages}
                    className="px-3 py-1 text-sm bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Next →
                  </button>
                </div>
              </div>
            )}

            {/* Info */}
            <div className="px-6 py-3 bg-blue-50 border-t border-blue-200">
              <p className="text-sm text-blue-800">
                <strong>💡 How it works:</strong> Enter the actual counted quantity for each product.
                When you submit, adjustments will be created for all items with discrepancies.
              </p>
            </div>

      </SlideDrawer>

    </div>
  );
}
