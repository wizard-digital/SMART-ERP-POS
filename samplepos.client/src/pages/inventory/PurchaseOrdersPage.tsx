import { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import {
  usePurchaseOrders,
  useCreatePurchaseOrder,
  useSubmitPurchaseOrder,
  useCancelPurchaseOrder,
  useDeletePurchaseOrder,
  useSendPOToSupplier,
  useUpdateDraftPO,
} from '../../hooks/usePurchaseOrders';
import { useSuppliers } from '../../hooks/useSuppliers';
import { formatCurrency } from '../../utils/currency';
import { BUSINESS_TIMEZONE, toApiDateOnly } from '../../utils/businessDate';
import { useAuth } from '../../hooks/useAuth';
import { api } from '../../utils/api';
import { handleApiError } from '../../utils/errorHandler';
import { DocumentFlowButton } from '../../components/shared/DocumentFlowButton';
import { ResponsiveTableWrapper } from '../../components/ui/ResponsiveTableWrapper';
import { mobileActionBtnClass } from '../../components/ui/ResponsiveActionBar';
import Decimal from 'decimal.js';
import { useCanAccess } from '../../components/auth/ProtectedRoute';
import SlideDrawer from '../../components/ui/SlideDrawer';
import {
  AdaptivePage,
  AdaptiveToolbar,
  AdaptiveSearch,
  AdaptiveKpiStrip,
  AdaptiveFilterPanel,
  AdaptiveFilterField,
  AdaptiveFilterDoneButton,
  adaptiveFilterControlClass,
} from '../../components/adaptive';
import {
  ADAPTIVE_PAGE_PAD_CLASS,
  ADAPTIVE_TOOLBAR_CARD_CLASS,
  ADAPTIVE_WORKLIST_DENSITY,
  ADAPTIVE_WORKLIST_SEARCH_DEBOUNCE_MS,
  INVENTORY_WORKLIST_TABLE_CLASS,
  INVENTORY_COL_FILL_CLASS,
  INVENTORY_COL_FIT_CLASS,
} from '../../lib/adaptiveDashboard';

import { DatePicker } from '../../components/ui/date-picker';
import { derivePOReceiptStatusBadge } from '../../../../shared/utils/purchaseOrderReceiptDisplay';
import { shouldShowPOReceiptProgressLine } from '../../../../shared/domain/poReceiptWorkflowSsot';
import { downloadFile } from '../../utils/download';
import { SortableTableHeader } from '../../components/ui/SortableTableHeader';
import { MobileSortSelect } from '../../components/ui/MobileSortSelect';
import { useServerTableSort } from '../../hooks/useServerTableSort';
import { InventoryColumnPicker } from '../../components/inventory/InventoryColumnPicker';
import { useInventoryColumnPrefs } from '../../hooks/useInventoryColumnPrefs';
import type { Supplier } from '../../types';
import {
  SupplierSelector,
  NotesField,
  ProcurementProductSearch,
  QuickCreateSupplierModal,
  QuickCreateProductModal,
  BusinessRulesInfo,
  TotalsSummary,
  ModalFooter,
  ModalContainer,
  PURCHASE_ORDER_RULES,
  WorkflowHelpTrigger,
} from '../../components/inventory/shared';
import type { ProcurementProduct } from '../../components/inventory/shared';
import { UomSelector } from '../../components/inventory/UomSelector';
import {
  convertPoLineQuantityForUomChange,
  finalizePoLineForSave,
  hydratePoLineMoney,
  poLineBaseCostFromDisplay,
  poLineDisplayUnitCost,
  poLineTotal,
  resolveUnitCostAfterBlur,
  syncPoLineFromEnteredTotal,
  deriveUnitCostWhileEditingLineTotal,
} from '../../../../shared/utils/po-line-uom';

// Configure Decimal for financial calculations
Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

// PO Status with colors
const PO_STATUSES = {
  DRAFT: { label: 'Draft', color: 'bg-gray-100 text-gray-800', icon: '📝' },
  PENDING: { label: 'Pending', color: 'bg-yellow-100 text-yellow-800', icon: '⏳' },
  APPROVED: { label: 'Approved', color: 'bg-blue-100 text-blue-800', icon: '✓' },
  COMPLETED: { label: 'Completed', color: 'bg-green-100 text-green-800', icon: '✅' },
  CANCELLED: { label: 'Cancelled', color: 'bg-red-100 text-red-800', icon: '❌' },
} as const;

type POStatus = keyof typeof PO_STATUSES;

type POSortField =
  | 'poNumber'
  | 'supplier'
  | 'orderDate'
  | 'expectedDelivery'
  | 'status'
  | 'totalAmount';

interface POLineItem {
  id: string;
  productId: string;
  productName: string;
  quantity: string;
  unitCost: string;
  lineTotal: string; // SAP-style: bi-directional with unitCost
  baseCost: string; // Base unit cost — needed for UOM cost recalculation
  // Selected ordering UoM
  selectedUomId?: string | null;
  selectedUomName?: string;
  conversionFactor?: string;
  // Procurement intelligence (from search result)
  quantityOnHand?: number;
  reorderLevel?: number;
  reorderQuantity?: number;
  costSource?: string;
  /** Set when server flagged purchase_uom_id as not in product_uoms */
  purchaseUomIncomplete?: boolean;
}

/** PO row — supports both snake_case (raw API) and camelCase (mapped) fields */
interface PORow {
  id: string;
  status: string;
  poNumber?: string;
  order_number?: string;
  orderDate?: string;
  order_date?: string;
  expectedDelivery?: string;
  expected_delivery_date?: string;
  totalAmount?: number | string;
  total_amount?: number | string;
  supplierName?: string;
  supplier_name?: string;
  supplierContact?: string;
  supplierId?: string;
  createdBy?: string;
  created_by_id?: string;
  createdAt?: string;
  created_at?: string;
  updatedAt?: string;
  updated_at?: string;
  sentDate?: string;
  sent_date?: string;
  notes?: string;
  items?: POItemRow[];
  orderedQtyTotal?: number | string;
  ordered_qty_total?: number | string;
  netReceivedQtyTotal?: number | string;
  net_received_qty_total?: number | string;
  openQtyTotal?: number | string;
  open_qty_total?: number | string;
  completedGrCount?: number | string;
  completed_gr_count?: number | string;
}

/** Shape of the data returned when sending a PO to supplier */
interface SendToSupplierData {
  goodsReceipt?: {
    receiptNumber?: string;
    [key: string]: unknown;
  };
}

/** Shape of PO detail response */
interface PODetailData {
  po?: PORow;
  items?: POItemRow[];
  [key: string]: unknown;
}

/** PO line item — supports both snake_case and camelCase fields */
interface POItemRow {
  id?: string;
  productName?: string;
  product_name?: string;
  purchaseOrderId?: string;
  purchase_order_id?: string;
  productId?: string;
  product_id?: string;
  quantity?: number | string;
  ordered_quantity?: number | string;
  unitCost?: number | string;
  unit_price?: number | string;
  receivedQuantity?: number | string;
  received_quantity?: number | string;
  gross_received_quantity?: number | string;
  returnedQuantity?: number | string;
  returned_quantity?: number | string;
  netReceivedQuantity?: number | string;
  net_received_quantity?: number | string;
  openQuantity?: number | string;
  open_quantity?: number | string;
  totalPrice?: number | string;
  total_price?: number | string;
  totalCost?: number | string;
  uomId?: string;
  uom_id?: string;
  uomName?: string;
  uom_name?: string;
  conversion_factor?: number | string;
  conversionFactor?: number | string;
  product_cost_price?: number | string;
  productCostPrice?: number | string;
  notes?: string;
}

// Spreadsheet-style Line Item Row with Tab/Enter navigation
function LineItemRow({
  item,
  index,
  onUpdate,
  onUomChange,
  onRemove,
  disabled,
  onQtyRef,
  onCostRef,
  onTab,
}: {
  item: POLineItem;
  index: number;
  onUpdate: (id: string, field: keyof POLineItem, value: string) => void;
  onUomChange: (id: string, uomId: string | null, newCost: string, factor: string, uomName: string) => void;
  onRemove: (id: string) => void;
  disabled: boolean;
  onQtyRef: (el: HTMLInputElement | null) => void;
  onCostRef: (el: HTMLInputElement | null) => void;
  onTab: (fromField: 'qty' | 'cost', index: number) => void;
}) {
  const localCostRef = useRef<HTMLInputElement | null>(null);
  const localTotalRef = useRef<HTMLInputElement | null>(null);

  const needsReorder = item.quantityOnHand !== undefined &&
    item.reorderLevel !== undefined &&
    item.quantityOnHand <= item.reorderLevel;

  const handleKeyDown = (field: 'qty' | 'cost' | 'total') => (e: React.KeyboardEvent) => {
    if (e.key === 'Tab' && !e.shiftKey) {
      if (field === 'qty') {
        e.preventDefault();
        localCostRef.current?.focus();
        localCostRef.current?.select();
      } else if (field === 'cost') {
        // Tab from unit cost → line total (SAP: Net Price → Net Value)
        e.preventDefault();
        localTotalRef.current?.focus();
        localTotalRef.current?.select();
      } else if (field === 'total') {
        // Tab from line total → next row
        e.preventDefault();
        onTab('cost', index);
      }
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (field === 'qty') {
        localCostRef.current?.focus();
        localCostRef.current?.select();
      } else if (field === 'cost') {
        localTotalRef.current?.focus();
        localTotalRef.current?.select();
      } else {
        onTab('cost', index);
      }
    }
  };

  // Show base unit equivalent below the UOM selector
  const factor = parseFloat(item.conversionFactor || '1');
  const showConversion = factor > 1;

  return (
    <tr className={needsReorder ? 'bg-red-50' : ''}>
      <td className="px-3 py-2 text-sm text-gray-900">
        <div className="flex flex-col gap-0.5">
          <div className="font-medium truncate max-w-[200px]" title={item.productName}>
            {item.productName}
          </div>
          <div className="flex items-center gap-2 text-xs text-gray-500">
            {item.quantityOnHand !== undefined && (
              <span className={needsReorder ? 'text-red-600 font-medium' : 'text-green-600'}>
                OH: {Number(item.quantityOnHand).toLocaleString()}
              </span>
            )}
            {item.costSource && (
              <span className="text-blue-500">({item.costSource})</span>
            )}
            {item.purchaseUomIncomplete && (
              <span className="text-amber-700 font-medium" title="Purchase UoM not configured — using base stock UoM">
                Purchase UoM incomplete
              </span>
            )}
          </div>
        </div>
      </td>
      <td className="px-2 py-2 w-20">
        <input
          ref={(el) => { onQtyRef(el); }}
          type="number"
          value={item.quantity}
          onChange={(e) => onUpdate(item.id, 'quantity', e.target.value)}
          onFocus={(e) => e.target.select()}
          onKeyDown={handleKeyDown('qty')}
          step="1"
          min="1"
          className="w-full px-2 py-1 text-right text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          placeholder="0"
          disabled={disabled}
        />
      </td>
      {/* Order Unit selector */}
      <td className="px-2 py-2 w-36">
        <div className="flex flex-col gap-0.5">
          <UomSelector
            productId={item.productId}
            baseCost={item.baseCost || item.unitCost}
            selectedUomId={item.selectedUomId}
            disabled={disabled}
            onChange={({ uomId, newCost, conversionFactor: cf, uomName }) => {
              onUomChange(item.id, uomId, newCost, cf, uomName);
            }}
            className="w-full px-2 py-1 text-xs border border-gray-300 rounded focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
          {showConversion && (
            <span className="text-[10px] text-gray-400 whitespace-nowrap">
              = {new Decimal(item.quantity || 0).times(factor).toFixed(0)} base
            </span>
          )}
        </div>
      </td>
      <td className="px-2 py-2 w-36">
        <input
          ref={(el) => { localCostRef.current = el; onCostRef(el); }}
          type="number"
          value={item.unitCost}
          onChange={(e) => onUpdate(item.id, 'unitCost', e.target.value)}
          onFocus={(e) => e.target.select()}
          onBlur={() => {
            const next = resolveUnitCostAfterBlur(
              item.quantity,
              item.unitCost,
              item.lineTotal,
            );
            if (next != null) onUpdate(item.id, 'unitCost', next);
          }}
          onKeyDown={handleKeyDown('cost')}
          step="1"
          min="0"
          className="w-full px-2 py-1 text-right text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          placeholder="0.00"
          disabled={disabled}
        />
        {showConversion && (
          <div className="text-[10px] text-gray-400 mt-0.5 text-right">
            {formatCurrency(new Decimal(item.unitCost || 0).div(factor).toNumber())}/pc
          </div>
        )}
      </td>
      <td className="px-2 py-2 w-36">
        <input
          ref={(el) => { localTotalRef.current = el; }}
          type="number"
          value={item.lineTotal}
          onChange={(e) => onUpdate(item.id, 'lineTotal', e.target.value)}
          onFocus={(e) => e.target.select()}
          onBlur={() => {
            // Preserve entered total (7000 stays 7000.00); unit gets only the dp needed
            const synced = syncPoLineFromEnteredTotal(item.quantity, item.lineTotal);
            onUpdate(item.id, 'lineTotal', synced.lineTotal);
          }}
          onKeyDown={handleKeyDown('total')}
          step="1"
          min="0"
          className="w-full px-2 py-1 text-right text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          placeholder="0.00"
          disabled={disabled}
        />
      </td>
      <td className="px-2 py-2 text-center">
        <button
          type="button"
          onClick={() => onRemove(item.id)}
          className="text-red-500 hover:text-red-700 text-sm"
          title="Remove item"
          disabled={disabled}
          tabIndex={-1}
        >
          ✕
        </button>
      </td>
    </tr>
  );
}

// Create PO Modal Component
interface ReorderItemState {
  productId: string;
  productName: string;
  suggestedQty: number;
  costPrice: number | null;
  currentStock: number;
  reorderPoint: number;
}

interface CreatePOModalProps {
  onClose: () => void;
  onSuccess: () => void;
  initialReorderItems?: ReorderItemState[];
}

function mapReorderItemsToLineItems(items: ReorderItemState[]): POLineItem[] {
  return items.map((item) => {
    const qtyNum = Math.max(1, Number(item.suggestedQty) || 1);
    const qty = String(qtyNum);
    const cost = item.costPrice ? new Decimal(item.costPrice).toFixed(2) : '0.00';
    const total = new Decimal(qty).times(new Decimal(cost)).toFixed(2);
    return {
      id: `reorder-${item.productId}`,
      productId: item.productId,
      productName: item.productName,
      quantity: qty,
      unitCost: cost,
      lineTotal: total,
      baseCost: cost,
      selectedUomId: null,
      quantityOnHand: item.currentStock,
      reorderLevel: item.reorderPoint,
      reorderQuantity: qtyNum,
      costSource: item.costPrice ? 'Cost' : '',
    };
  });
}

function CreatePOModal({ onClose, onSuccess, initialReorderItems }: CreatePOModalProps) {
  const { user } = useAuth();

  const [supplierId, setSupplierId] = useState('');
  const [expectedDelivery, setExpectedDelivery] = useState('');
  const [notes, setNotes] = useState('');
  const [lineItems, setLineItems] = useState<POLineItem[]>(() =>
    initialReorderItems?.length ? mapReorderItemsToLineItems(initialReorderItems) : []
  );
  const reorderLinesHydratedRef = useRef(false);

  // Parent may mount modal before reorder items state is ready — hydrate when they arrive
  useEffect(() => {
    if (!initialReorderItems?.length) return;
    if (reorderLinesHydratedRef.current) return;
    reorderLinesHydratedRef.current = true;
    setLineItems(mapReorderItemsToLineItems(initialReorderItems));
  }, [initialReorderItems]);

  const [isSubmitting, setIsSubmitting] = useState(false);

  const createPOMutation = useCreatePurchaseOrder();

  // ── Quick-create inline modals ──
  const [showQuickSupplier, setShowQuickSupplier] = useState(false);
  const [showQuickProduct, setShowQuickProduct] = useState(false);

  // ── Refs for spreadsheet keyboard navigation ──
  const searchInputRef = useRef<HTMLInputElement>(null);
  const qtyRefs = useRef<Map<number, HTMLInputElement>>(new Map());
  const costRefs = useRef<Map<number, HTMLInputElement>>(new Map());

  // Focus the search bar after adding a line (keyboard flow: search → qty → cost → search)
  const focusSearch = useCallback(() => {
    setTimeout(() => searchInputRef.current?.focus(), 50);
  }, []);

  // Tab handler: from cost field → back to product search
  const handleTabFromRow = useCallback(() => {
    focusSearch();
  }, [focusSearch]);

  // Calculate totals — line totals PE-synced; avg = weighted unit cost (subtotal ÷ qty)
  const totals = useMemo(() => {
    let subtotal = new Decimal(0);
    let totalQty = new Decimal(0);
    let itemCount = 0;

    lineItems.forEach((item) => {
      try {
        subtotal = subtotal.plus(new Decimal(item.lineTotal || 0));
        totalQty = totalQty.plus(new Decimal(item.quantity || 0));
        itemCount++;
      } catch {
        // Invalid number, skip
      }
    });

    return {
      subtotal: subtotal.toNumber(),
      itemCount,
      avgCost: totalQty.gt(0) ? subtotal.div(totalQty).toNumber() : 0,
    };
  }, [lineItems]);

  // ── Add line item from procurement search result ──
  // Auto unit cost: supplier history → last_cost → cost_price
  // Auto quantity: reorder_quantity when on_hand < reorder_level
  const addLineItem = useCallback((product: ProcurementProduct) => {
    // Resolve best unit cost (priority: supplier → last → cost)
    let initialCost = '0.00';
    let costSource = '';
    if (product.supplierLastPrice && product.supplierLastPrice > 0) {
      initialCost = new Decimal(product.supplierLastPrice).toFixed(2);
      costSource = 'Supplier';
    } else if (product.lastCost > 0) {
      initialCost = new Decimal(product.lastCost).toFixed(2);
      costSource = 'Last';
    } else if (product.costPrice > 0) {
      initialCost = new Decimal(product.costPrice).toFixed(2);
      costSource = 'Cost';
    }

    // Auto-suggest quantity when stock is below reorder level
    let suggestedQty = '1';
    if (product.quantityOnHand <= product.reorderLevel && product.reorderQuantity > 0) {
      suggestedQty = String(product.reorderQuantity);
    }

    const newItem: POLineItem = {
      id: `temp-${Date.now()}-${Math.random()}`,
      productId: product.id,
      productName: product.name,
      quantity: suggestedQty,
      unitCost: initialCost,
      lineTotal: new Decimal(suggestedQty).times(new Decimal(initialCost)).toFixed(2),
      baseCost: initialCost, // Base unit cost for UOM recalculation
      selectedUomId: product.effectivePurchaseUomId ?? null,
      conversionFactor: '1',
      quantityOnHand: product.quantityOnHand,
      reorderLevel: product.reorderLevel,
      reorderQuantity: product.reorderQuantity,
      costSource,
      purchaseUomIncomplete: product.purchaseUomIncomplete ?? false,
    };

    setLineItems((prev) => [...prev, newItem]);

    // Auto-focus the quantity field of the new row
    const newIndex = lineItems.length;
    setTimeout(() => {
      const qtyEl = qtyRefs.current.get(newIndex);
      if (qtyEl) {
        qtyEl.focus();
        qtyEl.select();
      }
    }, 100);
  }, [lineItems.length]);

  // SAP ME21N-style: editing one field auto-recalculates the linked field
  const updateLineItem = useCallback((id: string, field: keyof POLineItem, value: string) => {
    setLineItems((prevItems) =>
      prevItems.map((item) => {
        if (item.id !== id) return item;
        const updated = { ...item, [field]: value };
        try {
          if (field === 'unitCost') {
            // Unit cost changed → recalculate line total and keep baseCost in sync
            updated.lineTotal = poLineTotal(updated.quantity, value);
            updated.baseCost = poLineBaseCostFromDisplay(value, updated.conversionFactor || '1');
          } else if (field === 'lineTotal') {
            // Keep what the user types; refresh unit cost when the total is parseable
            updated.lineTotal = value;
            const derived = deriveUnitCostWhileEditingLineTotal(updated.quantity, value);
            if (derived != null) {
              updated.unitCost = derived;
              updated.baseCost = poLineBaseCostFromDisplay(
                derived,
                updated.conversionFactor || '1',
              );
            }
          } else if (field === 'quantity') {
            // Quantity changed → recalculate line total (keep unit cost)
            updated.lineTotal = poLineTotal(value, updated.unitCost);
          }
        } catch { /* invalid decimal, skip sync */ }
        return updated;
      })
    );
  }, []);

  // UOM change: recalc display cost from baseCost × factor; convert qty to preserve base quantity
  const handleUomChange = useCallback((id: string, uomId: string | null, _newCost: string, factor: string, uomName: string) => {
    setLineItems((prev) =>
      prev.map((item) => {
        if (item.id !== id) return item;
        const oldFactor = item.conversionFactor || '1';
        const quantity = convertPoLineQuantityForUomChange(item.quantity, oldFactor, factor);
        const unitCost = poLineDisplayUnitCost(item.baseCost || item.unitCost, factor);
        const lineTotal = poLineTotal(quantity, unitCost);
        return {
          ...item,
          selectedUomId: uomId,
          quantity,
          unitCost,
          lineTotal,
          conversionFactor: factor,
          selectedUomName: uomName,
        };
      })
    );
  }, []);

  // Remove line item
  const removeLineItem = useCallback((id: string) => {
    setLineItems((prev) => prev.filter((item) => item.id !== id));
    focusSearch();
  }, [focusSearch]);

  // Validate form
  const validateForm = (): string | null => {
    if (!supplierId) {
      return 'BR-PO-001: Please select a supplier';
    }
    if (lineItems.length === 0) {
      return 'BR-PO-002: Purchase order must have at least one line item';
    }
    if (expectedDelivery) {
      const deliveryDate = new Date(expectedDelivery);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      if (deliveryDate <= today) {
        return 'BR-PO-005: Expected delivery date must be in the future';
      }
    }
    for (const item of lineItems) {
      try {
        const qty = new Decimal(item.quantity);
        if (qty.lte(0)) {
          return `BR-INV-002: ${item.productName} - Quantity must be positive`;
        }
      } catch {
        return `${item.productName} - Invalid quantity format`;
      }
      try {
        const cost = new Decimal(item.unitCost);
        if (cost.lt(0)) {
          return `BR-PO-004: ${item.productName} - Unit cost cannot be negative`;
        }
      } catch {
        return `${item.productName} - Invalid unit cost format`;
      }
    }
    return null;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const validationError = validateForm();
    if (validationError) {
      alert(validationError);
      return;
    }

    if (!user?.id) {
      alert('User not authenticated');
      return;
    }

    setIsSubmitting(true);

    try {
      const today = new Date();
      const yyyy = today.getFullYear();
      const mm = String(today.getMonth() + 1).padStart(2, '0');
      const dd = String(today.getDate()).padStart(2, '0');

      const poData = {
        supplierId,
        orderDate: `${yyyy}-${mm}-${dd}`,
        expectedDate: toApiDateOnly(expectedDelivery) || undefined,
        notes: notes || undefined,
        createdBy: user.id,
        items: lineItems.map((item) => {
          const finalized = finalizePoLineForSave(
            item.quantity,
            item.unitCost,
            item.lineTotal,
          );
          return {
            productId: item.productId,
            productName: item.productName,
            quantity: parseFloat(item.quantity),
            unitCost: Number(finalized.unitCost),
            lineTotal: Number(finalized.lineTotal),
            uomId: item.selectedUomId || null,
          };
        }),
      };

      await createPOMutation.mutateAsync(poData);
      alert('Purchase Order created successfully!');
      onSuccess();
      onClose();
    } catch (error: unknown) {
      console.error('PO creation error:', error);
      handleApiError(error, { fallback: 'Failed to create purchase order' });
    } finally {
      setIsSubmitting(false);
    }
  };

  // ── Keyboard shortcut: Ctrl+Enter to submit ──
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === 'Enter' && lineItems.length > 0 && !isSubmitting) {
        e.preventDefault();
        handleSubmit(new Event('submit') as unknown as React.FormEvent);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });

  return (
    <ModalContainer
      onClose={onClose}
      title="Create Purchase Order"
      subtitle="ERP-grade procurement — search, add, Tab through. Ctrl+Enter to submit."
      transactional
      cancellable={false}
      guardLabel="Create purchase order"
      footer={
        <ModalFooter
          onCancel={onClose}
          onSubmit={() =>
            handleSubmit(new Event('submit') as unknown as React.FormEvent<HTMLFormElement>)
          }
          submitLabel="Create Purchase Order"
          isSubmitting={isSubmitting}
          submitDisabled={lineItems.length === 0}
        />
      }
    >
      <form onSubmit={handleSubmit}>
        <div className="flex justify-end mb-4">
          <BusinessRulesInfo rules={PURCHASE_ORDER_RULES} title="Business Rules Applied" />
        </div>
        {/* Header Section */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4 mb-6">
          {/* Supplier Selection */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Supplier <span className="text-red-500">*</span></label>
            <div className="flex items-center gap-2">
              <SupplierSelector value={supplierId} onChange={setSupplierId} disabled={isSubmitting} className="flex-1" showLabel={false} />
              <button
                type="button"
                onClick={() => setShowQuickSupplier(true)}
                disabled={isSubmitting}
                className="px-3 py-2 text-sm font-medium bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 whitespace-nowrap"
                title="Quick-create a new supplier"
              >
                + New
              </button>
            </div>
            <p className="mt-1 text-xs text-gray-500">BR-PO-001: Supplier validation required</p>
          </div>

          {/* Expected Delivery Date */}
          <div>
            <label
              htmlFor="expectedDelivery"
              className="block text-sm font-medium text-gray-700 mb-1"
            >
              Expected Delivery Date
            </label>
            <DatePicker
              value={expectedDelivery}
              onChange={(date) => setExpectedDelivery(toApiDateOnly(date) || '')}
              placeholder="Select expected delivery date"
              minDate={new Date(Date.now() + 86400000)}
              disabled={isSubmitting}
            />
            <p className="mt-1 text-xs text-gray-500">BR-PO-005: Must be future date</p>
          </div>

          {/* Notes — full width */}
          <div className="md:col-span-2">
            <NotesField
              value={notes}
              onChange={setNotes}
              disabled={isSubmitting}
              placeholder="Optional notes about this purchase order..."
            />
          </div>
        </div>

        {/* Line Items Section */}
        <div className="mb-6 border border-gray-300 rounded-lg p-4">
          <div className="flex justify-between items-center mb-3">
            <h4 className="text-sm font-semibold text-gray-900">
              Line Items <span className="text-red-500">*</span>
            </h4>
            <div className="text-xs text-gray-500">
              {lineItems.length} item{lineItems.length !== 1 ? 's' : ''} &middot; Tab through fields &middot; Ctrl+Enter to submit
            </div>
          </div>

          {/* Procurement Product Search */}
          <div className="flex items-end gap-2 mb-3">
            <ProcurementProductSearch
              supplierId={supplierId || undefined}
              onProductSelect={addLineItem}
              disabled={isSubmitting || !supplierId}
              className="flex-1"
              inputRef={searchInputRef}
              placeholder={
                supplierId
                  ? undefined
                  : 'Select a supplier first, then search products…'
              }
            />
            <button
              type="button"
              onClick={() => setShowQuickProduct(true)}
              disabled={isSubmitting || !supplierId}
              className="mb-px px-3 py-2 text-sm font-medium bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 whitespace-nowrap"
              title="Quick-create a new product"
            >
              + New
            </button>
          </div>

          {/* Spreadsheet-style Line Items Table */}
          {lineItems.length > 0 ? (
            <div className="overflow-x-auto border border-gray-200 rounded-lg">
              <ResponsiveTableWrapper>
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                        Product
                      </th>
                      <th className="px-2 py-2 text-right text-xs font-medium text-gray-500 uppercase w-20">
                        Qty
                      </th>
                      <th className="px-2 py-2 text-left text-xs font-medium text-gray-500 uppercase w-36">
                        Order UoM
                      </th>
                      <th className="px-2 py-2 text-right text-xs font-medium text-gray-500 uppercase w-36">
                        Unit Cost
                      </th>
                      <th className="px-2 py-2 text-right text-xs font-medium text-gray-500 uppercase w-36">
                        Line Total
                      </th>
                      <th className="px-2 py-2 text-center text-xs font-medium text-gray-500 uppercase w-10">
                      </th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-100">
                    {lineItems.map((item, idx) => (
                      <LineItemRow
                        key={item.id}
                        item={item}
                        index={idx}
                        onUpdate={updateLineItem}
                        onUomChange={handleUomChange}
                        onRemove={removeLineItem}
                        disabled={isSubmitting}
                        onQtyRef={(el) => { if (el) qtyRefs.current.set(idx, el); else qtyRefs.current.delete(idx); }}
                        onCostRef={(el) => { if (el) costRefs.current.set(idx, el); else costRefs.current.delete(idx); }}
                        onTab={handleTabFromRow}
                      />
                    ))}
                  </tbody>
                </table>
              </ResponsiveTableWrapper>
            </div>
          ) : (
            <div className="text-center py-8 text-gray-500 bg-gray-50 rounded-lg">
              {supplierId
                ? 'Search products above to add line items.'
                : 'Select a supplier first, then search products.'}
            </div>
          )}

          {/* Totals Summary */}
          {lineItems.length > 0 && (
            <TotalsSummary
              itemCount={totals.itemCount}
              subtotal={totals.subtotal}
              avgCost={totals.avgCost}
              className="mt-3 pt-3 border-t border-gray-200"
            />
          )}
        </div>
      </form>

      {/* Quick-create supplier inline modal */}
      {showQuickSupplier && (
        <QuickCreateSupplierModal
          onClose={() => setShowQuickSupplier(false)}
          onCreated={(supplier) => {
            setSupplierId(supplier.id);
            setShowQuickSupplier(false);
          }}
        />
      )}

      {/* Quick-create product inline modal */}
      {showQuickProduct && (
        <QuickCreateProductModal
          onClose={() => setShowQuickProduct(false)}
          preferredSupplierId={supplierId || undefined}
          onCreated={() => {
            setShowQuickProduct(false);
            // Focus the search bar so user can find the newly created product
            focusSearch();
          }}
        />
      )}
    </ModalContainer>
  );
}

function poStatusBadge(po: PORow) {
  return derivePOReceiptStatusBadge(po.status, po);
}

function poCanChangeSupplier(po: PORow): boolean {
  if (po.status !== 'DRAFT' && po.status !== 'PENDING') return false;
  // Net-received SSOT: fully reversed (net 0) can be managed like a fresh draft.
  if (Number(po.netReceivedQtyTotal ?? po.net_received_qty_total ?? 0) > 0.0001) {
    return false;
  }
  const items = po.items || [];
  if (items.some((i) => Number(i.net_received_quantity ?? i.netReceivedQuantity ?? 0) > 0.0001)) {
    return false;
  }
  return true;
}

// ── Edit PO Modal ──
interface EditPOModalProps {
  po: PORow;
  onClose: () => void;
  onSuccess: () => void;
}

function EditPOModal({ po, onClose, onSuccess }: EditPOModalProps) {
  const [supplierId, setSupplierId] = useState(po.supplierId || '');

  const [expectedDelivery, setExpectedDelivery] = useState(
    () => toApiDateOnly(po.expectedDelivery || po.expected_delivery_date) || ''
  );
  const [notes, setNotes] = useState(po.notes || '');
  const [lineItems, setLineItems] = useState<POLineItem[]>(() => {
    if (!po.items || po.items.length === 0) return [];
    return po.items.map((item: POItemRow) => {
      const cost = String(item.unit_price || item.unitCost || 0);
      const qty = String(item.ordered_quantity || item.quantity || 0);
      const factor = Number(item.conversion_factor || item.conversionFactor || 1);
      const productBaseCost = Number(item.product_cost_price || item.productCostPrice || 0);
      const storedTotal = item.total_price ?? item.totalPrice ?? item.lineTotal;
      const money = hydratePoLineMoney(qty, cost, storedTotal);
      const derivedBaseCost = productBaseCost > 0
        ? String(productBaseCost)
        : factor > 1
          ? new Decimal(money.unitCost).dividedBy(factor).toFixed(6).replace(/\.?0+$/, '') || '0'
          : money.unitCost;
      return {
        id: item.id || `existing-${Math.random()}`,
        productId: item.product_id || item.productId || '',
        productName: item.product_name || item.productName || '',
        quantity: qty,
        unitCost: money.unitCost,
        lineTotal: money.lineTotal,
        baseCost: derivedBaseCost,
        selectedUomId: item.uom_id || item.uomId || null,
        selectedUomName: item.uom_name || item.uomName || undefined,
        conversionFactor: String(factor),
        quantityOnHand: undefined,
        reorderLevel: undefined,
        reorderQuantity: undefined,
        costSource: '',
      };
    });
  });
  const [isSubmitting, setIsSubmitting] = useState(false);

  const updatePOMutation = useUpdateDraftPO();

  // Quick-create modals
  const [showQuickProduct, setShowQuickProduct] = useState(false);

  // Refs for spreadsheet navigation
  const searchInputRef = useRef<HTMLInputElement>(null);
  const qtyRefs = useRef<Map<number, HTMLInputElement>>(new Map());
  const costRefs = useRef<Map<number, HTMLInputElement>>(new Map());

  const focusSearch = useCallback(() => {
    setTimeout(() => searchInputRef.current?.focus(), 50);
  }, []);

  const handleTabFromRow = useCallback(() => {
    focusSearch();
  }, [focusSearch]);

  // Calculate totals — line totals PE-synced; avg = weighted unit cost (subtotal ÷ qty)
  const totals = useMemo(() => {
    let subtotal = new Decimal(0);
    let totalQty = new Decimal(0);
    let itemCount = 0;
    lineItems.forEach((item) => {
      try {
        subtotal = subtotal.plus(new Decimal(item.lineTotal || 0));
        totalQty = totalQty.plus(new Decimal(item.quantity || 0));
        itemCount++;
      } catch { /* skip */ }
    });
    return {
      subtotal: subtotal.toNumber(),
      itemCount,
      avgCost: totalQty.gt(0) ? subtotal.div(totalQty).toNumber() : 0,
    };
  }, [lineItems]);

  const addLineItem = useCallback((product: ProcurementProduct) => {
    let initialCost = '0.00';
    let costSource = '';
    if (product.supplierLastPrice && product.supplierLastPrice > 0) {
      initialCost = new Decimal(product.supplierLastPrice).toFixed(2);
      costSource = 'Supplier';
    } else if (product.lastCost > 0) {
      initialCost = new Decimal(product.lastCost).toFixed(2);
      costSource = 'Last';
    } else if (product.costPrice > 0) {
      initialCost = new Decimal(product.costPrice).toFixed(2);
      costSource = 'Cost';
    }

    let suggestedQty = '1';
    if (product.quantityOnHand <= product.reorderLevel && product.reorderQuantity > 0) {
      suggestedQty = String(product.reorderQuantity);
    }

    const newItem: POLineItem = {
      id: `temp-${Date.now()}-${Math.random()}`,
      productId: product.id,
      productName: product.name,
      quantity: suggestedQty,
      unitCost: initialCost,
      lineTotal: new Decimal(suggestedQty).times(new Decimal(initialCost)).toFixed(2),
      baseCost: initialCost,
      selectedUomId: product.effectivePurchaseUomId ?? null,
      conversionFactor: '1',
      quantityOnHand: product.quantityOnHand,
      reorderLevel: product.reorderLevel,
      reorderQuantity: product.reorderQuantity,
      costSource,
      purchaseUomIncomplete: product.purchaseUomIncomplete ?? false,
    };

    setLineItems((prev) => [...prev, newItem]);
    const newIndex = lineItems.length;
    setTimeout(() => {
      const qtyEl = qtyRefs.current.get(newIndex);
      if (qtyEl) { qtyEl.focus(); qtyEl.select(); }
    }, 100);
  }, [lineItems.length]);

  // SAP ME21N-style: editing one field auto-recalculates the linked field
  const updateLineItem = useCallback((id: string, field: keyof POLineItem, value: string) => {
    setLineItems((prev) =>
      prev.map((item) => {
        if (item.id !== id) return item;
        const updated = { ...item, [field]: value };
        try {
          if (field === 'unitCost') {
            updated.lineTotal = poLineTotal(updated.quantity, value);
            updated.baseCost = poLineBaseCostFromDisplay(value, updated.conversionFactor || '1');
          } else if (field === 'lineTotal') {
            updated.lineTotal = value;
            const derived = deriveUnitCostWhileEditingLineTotal(updated.quantity, value);
            if (derived != null) {
              updated.unitCost = derived;
              updated.baseCost = poLineBaseCostFromDisplay(
                derived,
                updated.conversionFactor || '1',
              );
            }
          } else if (field === 'quantity') {
            updated.lineTotal = poLineTotal(value, updated.unitCost);
          }
        } catch { /* invalid decimal, skip sync */ }
        return updated;
      })
    );
  }, []);

  // UOM change: recalc display cost from baseCost × factor; convert qty to preserve base quantity
  const handleUomChange = useCallback((id: string, uomId: string | null, _newCost: string, factor: string, uomName: string) => {
    setLineItems((prev) =>
      prev.map((item) => {
        if (item.id !== id) return item;
        const oldFactor = item.conversionFactor || '1';
        const quantity = convertPoLineQuantityForUomChange(item.quantity, oldFactor, factor);
        const unitCost = poLineDisplayUnitCost(item.baseCost || item.unitCost, factor);
        const lineTotal = poLineTotal(quantity, unitCost);
        return {
          ...item,
          selectedUomId: uomId,
          quantity,
          unitCost,
          lineTotal,
          conversionFactor: factor,
          selectedUomName: uomName,
        };
      })
    );
  }, []);

  const removeLineItem = useCallback((id: string) => {
    setLineItems((prev) => prev.filter((item) => item.id !== id));
    focusSearch();
  }, [focusSearch]);

  const validateForm = (): string | null => {
    if (lineItems.length === 0) return 'BR-PO-002: Purchase order must have at least one line item';
    if (expectedDelivery) {
      const deliveryDate = new Date(expectedDelivery);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      if (deliveryDate <= today) return 'BR-PO-005: Expected delivery date must be in the future';
    }
    for (const item of lineItems) {
      try {
        const qty = new Decimal(item.quantity);
        if (qty.lte(0)) return `BR-INV-002: ${item.productName} - Quantity must be positive`;
      } catch { return `${item.productName} - Invalid quantity format`; }
      try {
        const cost = new Decimal(item.unitCost);
        if (cost.lt(0)) return `BR-PO-004: ${item.productName} - Unit cost cannot be negative`;
      } catch { return `${item.productName} - Invalid unit cost format`; }
    }
    return null;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const validationError = validateForm();
    if (validationError) { alert(validationError); return; }

    setIsSubmitting(true);
    try {
      await updatePOMutation.mutateAsync({
        id: po.id,
        data: {
          supplierId: supplierId || undefined,
          expectedDate: toApiDateOnly(expectedDelivery),
          notes: notes || null,
          items: lineItems.map((item) => {
            const finalized = finalizePoLineForSave(
              item.quantity,
              item.unitCost,
              item.lineTotal,
            );
            return {
              productId: item.productId,
              productName: item.productName,
              quantity: parseFloat(item.quantity),
              unitCost: Number(finalized.unitCost),
              lineTotal: Number(finalized.lineTotal),
              uomId: item.selectedUomId || null,
            };
          }),
        },
      });
      alert('Purchase Order updated successfully!');
      onSuccess();
      onClose();
    } catch (error: unknown) {
      handleApiError(error, { fallback: 'Failed to update purchase order' });
    } finally {
      setIsSubmitting(false);
    }
  };

  // Keyboard shortcut: Ctrl+Enter to submit
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === 'Enter' && lineItems.length > 0 && !isSubmitting) {
        e.preventDefault();
        handleSubmit(new Event('submit') as unknown as React.FormEvent);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });

  return (
    <ModalContainer
      onClose={onClose}
      title={`Edit Purchase Order — ${po.poNumber || po.order_number}`}
      subtitle="Edit draft PO — modify header, add/remove items. Ctrl+Enter to save."
      transactional
      cancellable={false}
      guardLabel="Edit purchase order"
      footer={
        <ModalFooter
          onCancel={onClose}
          onSubmit={() => handleSubmit(new Event('submit') as unknown as React.FormEvent<HTMLFormElement>)}
          submitLabel="Save Changes"
          isSubmitting={isSubmitting}
          submitDisabled={lineItems.length === 0}
        />
      }
    >
      <form onSubmit={handleSubmit}>
        <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 mb-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Supplier</label>
              <SupplierSelector value={supplierId} onChange={setSupplierId} disabled={isSubmitting} showLabel={false} />
            </div>
            <div>
              <span className="block text-xs font-medium text-gray-500 uppercase tracking-wide">PO Number</span>
              <span className="text-sm font-semibold text-gray-900">{po.poNumber || po.order_number}</span>
            </div>
            <div>
              <span className="block text-xs font-medium text-gray-500 uppercase tracking-wide">Order Date</span>
              <span className="text-sm font-semibold text-gray-900">{po.orderDate || po.order_date || '—'}</span>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          <div>
            <label htmlFor="editExpectedDelivery" className="block text-sm font-medium text-gray-700 mb-2">Expected Delivery Date</label>
            <DatePicker value={expectedDelivery} onChange={(date) => setExpectedDelivery(toApiDateOnly(date) || '')} placeholder="Select expected delivery date"
              minDate={new Date(Date.now() + 86400000)} disabled={isSubmitting} />
          </div>
        </div>

        <NotesField value={notes} onChange={setNotes} disabled={isSubmitting} placeholder="Optional notes..." className="mb-4" />

        {/* Line Items */}
        <div className="mb-6 border border-gray-300 rounded-lg p-4">
          <div className="flex justify-between items-center mb-3">
            <h4 className="text-sm font-semibold text-gray-900">Line Items <span className="text-red-500">*</span></h4>
            <div className="text-xs text-gray-500">{lineItems.length} item{lineItems.length !== 1 ? 's' : ''}</div>
          </div>

          <div className="flex items-end gap-2 mb-3">
            <ProcurementProductSearch
              supplierId={supplierId || undefined}
              onProductSelect={addLineItem}
              disabled={isSubmitting || !supplierId}
              className="flex-1"
              inputRef={searchInputRef}
              placeholder={
                supplierId
                  ? undefined
                  : 'Select a supplier first, then search products…'
              }
            />
            <button type="button" onClick={() => setShowQuickProduct(true)} disabled={isSubmitting || !supplierId}
              className="mb-px px-3 py-2 text-sm font-medium bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 whitespace-nowrap">+ New</button>
          </div>

          {lineItems.length > 0 ? (
            <div className="overflow-x-auto border border-gray-200 rounded-lg">
              <ResponsiveTableWrapper>
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Product</th>
                      <th className="px-2 py-2 text-right text-xs font-medium text-gray-500 uppercase w-20">Qty</th>
                      <th className="px-2 py-2 text-left text-xs font-medium text-gray-500 uppercase w-36">Order UoM</th>
                      <th className="px-2 py-2 text-right text-xs font-medium text-gray-500 uppercase w-36">Unit Cost</th>
                      <th className="px-2 py-2 text-right text-xs font-medium text-gray-500 uppercase w-36">Line Total</th>
                      <th className="px-2 py-2 text-center text-xs font-medium text-gray-500 uppercase w-10"></th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-100">
                    {lineItems.map((item, idx) => (
                      <LineItemRow key={item.id} item={item} index={idx} onUpdate={updateLineItem}
                        onUomChange={handleUomChange}
                        onRemove={removeLineItem} disabled={isSubmitting}
                        onQtyRef={(el) => { if (el) qtyRefs.current.set(idx, el); else qtyRefs.current.delete(idx); }}
                        onCostRef={(el) => { if (el) costRefs.current.set(idx, el); else costRefs.current.delete(idx); }}
                        onTab={handleTabFromRow} />
                    ))}
                  </tbody>
                </table>
              </ResponsiveTableWrapper>
            </div>
          ) : (
            <div className="text-center py-8 text-gray-500 bg-gray-50 rounded-lg">
              {supplierId
                ? 'Search products above to add line items.'
                : 'Select a supplier first, then search products.'}
            </div>
          )}

          {lineItems.length > 0 && (
            <TotalsSummary itemCount={totals.itemCount} subtotal={totals.subtotal} avgCost={totals.avgCost} className="mt-3 pt-3 border-t border-gray-200" />
          )}
        </div>

        <div className="flex justify-end mb-4">
          <BusinessRulesInfo rules={PURCHASE_ORDER_RULES} title="Business Rules Applied" />
        </div>
      </form>

      {showQuickProduct && (
        <QuickCreateProductModal onClose={() => setShowQuickProduct(false)}
          preferredSupplierId={supplierId || undefined}
          onCreated={() => { setShowQuickProduct(false); focusSearch(); }} />
      )}
    </ModalContainer>
  );
}

export default function PurchaseOrdersPage() {
  const location = useLocation();
  const columnPrefs = useInventoryColumnPrefs('purchase-orders');
  const { show: showCol } = columnPrefs;
  // State
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [selectedPO, setSelectedPO] = useState<PORow | null>(null);
  const [showDetailsModal, setShowDetailsModal] = useState(false);
  const [editingPO, setEditingPO] = useState<PORow | null>(null);

  const [selectedStatus, setSelectedStatus] = useState<POStatus | 'ALL'>('ALL');
  const [selectedSupplier, setSelectedSupplier] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [page, setPage] = useState(1);
  const limit = 20;
  const {
    sortField,
    sortOrder,
    handleColumnSort,
    setSortOrder,
    serverListParams,
  } = useServerTableSort<POSortField>({
    defaultField: 'orderDate',
    defaultOrder: 'desc',
    onQueryChange: () => setPage(1),
  });

  useEffect(() => {
    const timer = setTimeout(
      () => setDebouncedSearch(searchTerm.trim()),
      ADAPTIVE_WORKLIST_SEARCH_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [searchTerm]);

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, selectedStatus, selectedSupplier]);

  // API queries
  const {
    data: posData,
    isLoading,
    isFetching,
    isPlaceholderData,
    error,
    refetch,
  } = usePurchaseOrders({
    page,
    limit,
    status: selectedStatus !== 'ALL' ? selectedStatus : undefined,
    supplierId: selectedSupplier || undefined,
    search: debouncedSearch || undefined,
    ...serverListParams,
  });

  const { data: suppliersData } = useSuppliers();
  const submitPOMutation = useSubmitPurchaseOrder();
  const sendToSupplierMutation = useSendPOToSupplier();
  const cancelPOMutation = useCancelPurchaseOrder();
  const updatePOMutation = useUpdateDraftPO();
  const [pendingSupplierId, setPendingSupplierId] = useState('');
  const [isChangingSupplier, setIsChangingSupplier] = useState(false);
  const deletePOMutation = useDeletePurchaseOrder();

  // Permission gating
  const canCreatePO = useCanAccess([], ['purchasing.create']);
  const canSubmitPO = useCanAccess([], ['purchasing.approve']);
  const canCancelPO = useCanAccess([], ['purchasing.update']);
  const canDeletePO = useCanAccess([], ['purchasing.delete']);

  // Auto-open create modal when navigated from Reorder Intelligence (or similar)
  const [createModalSeed, setCreateModalSeed] = useState<{
    items: ReorderItemState[];
    nonce: number;
  } | null>(null);

  useEffect(() => {
    const state = location.state as { openCreate?: boolean; reorderItems?: ReorderItemState[] } | null;
    if (!state?.openCreate) return;

    const items = Array.isArray(state.reorderItems) ? [...state.reorderItems] : [];
    setCreateModalSeed({ items, nonce: Date.now() });
    setShowCreateModal(true);
    window.history.replaceState({}, '');
  }, [location.state]);

  // Helper to map snake_case DB columns to camelCase
  const mapPOFromDB = (po: PORow): PORow => ({
    ...po,
    poNumber: po.order_number || po.poNumber,
    orderDate: po.order_date || po.orderDate,
    expectedDelivery: po.expected_delivery_date || po.expectedDelivery,
    totalAmount: po.total_amount || po.totalAmount,
    supplierName: po.supplier_name || po.supplierName,
    supplierId: (po as PORow & { supplier_id?: string }).supplier_id || po.supplierId,
    createdBy: po.created_by_id || po.createdBy,
    createdAt: po.created_at || po.createdAt,
    updatedAt: po.updated_at || po.updatedAt,
    sentDate: po.sent_date || po.sentDate,
    orderedQtyTotal: po.ordered_qty_total ?? po.orderedQtyTotal,
    netReceivedQtyTotal: po.net_received_qty_total ?? po.netReceivedQtyTotal,
    openQtyTotal: po.open_qty_total ?? po.openQtyTotal,
    completedGrCount: po.completed_gr_count ?? po.completedGrCount,
  });

  // Extract data + server pagination (same shape as Goods Receipts worklist)
  const pagination = useMemo(() => {
    if (!posData || typeof posData !== 'object') return null;
    const p = (posData as { pagination?: { page: number; limit: number; total: number; totalPages: number } })
      .pagination;
    if (!p || typeof p.total !== 'number') return null;
    return p;
  }, [posData]);

  const purchaseOrders = useMemo(() => {
    if (!posData) return [];
    const rawData =
      posData.data && Array.isArray(posData.data)
        ? posData.data
        : Array.isArray(posData)
          ? posData
          : [];

    // Map and deduplicate by ID to prevent duplicate display
    const mapped = rawData.map(mapPOFromDB);
    const seen = new Set();
    return mapped.filter((po: PORow) => {
      if (seen.has(po.id)) {
        console.warn(`Duplicate PO detected and filtered: ${po.id}`);
        return false;
      }
      seen.add(po.id);
      return true;
    });
  }, [posData]);

  const listFiltersActive = Boolean(
    debouncedSearch || selectedSupplier || selectedStatus !== 'ALL',
  );
  const matchedTotal = pagination?.total ?? purchaseOrders.length;

  const suppliers = useMemo(() => {
    if (!suppliersData) return [];
    if (suppliersData.data && Array.isArray(suppliersData.data)) return suppliersData.data;
    return Array.isArray(suppliersData) ? suppliersData : [];
  }, [suppliersData]);

  // Calculate statistics from the current result set.
  // Total uses server pagination.total so search/filter counts stay accurate across pages.
  const stats = useMemo(() => {
    const total = matchedTotal;
    const draft = purchaseOrders.filter((po: PORow) => po.status === 'DRAFT').length;
    const pending = purchaseOrders.filter((po: PORow) => po.status === 'PENDING').length;
    const completed = purchaseOrders.filter((po: PORow) => po.status === 'COMPLETED').length;
    const cancelled = purchaseOrders.filter((po: PORow) => po.status === 'CANCELLED').length;

    // Only include non-cancelled POs in total value calculation (this page of results)
    let totalValue = new Decimal(0);
    purchaseOrders.forEach((po: PORow) => {
      if (po.status !== 'CANCELLED') {
        totalValue = totalValue.plus(new Decimal(po.totalAmount || 0));
      }
    });

    return { total, draft, pending, completed, cancelled, totalValue: totalValue.toNumber() };
  }, [purchaseOrders, matchedTotal]);

  // Must stay above loading/error early returns — hooks order SSOT.
  const hasDeliveryDates = purchaseOrders.some((po: PORow) => po.expectedDelivery);
  const tableColSpan = useMemo(() => {
    const ids = [
      'poNumber',
      'supplier',
      'orderDate',
      ...(hasDeliveryDates ? (['expectedDelivery'] as const) : []),
      'status',
      'totalAmount',
      'actions',
    ];
    return ids.filter((id) => showCol(id)).length;
  }, [hasDeliveryDates, showCol]);

  const mobileSortOptions = [
    { value: 'poNumber', label: 'Sort by PO Number' },
    { value: 'supplier', label: 'Sort by Supplier' },
    { value: 'orderDate', label: 'Sort by Order Date' },
    { value: 'expectedDelivery', label: 'Sort by Expected Delivery' },
    { value: 'status', label: 'Sort by Status' },
    { value: 'totalAmount', label: 'Sort by Total Amount' },
  ];

  // Handle submit PO - automatically sends to supplier and creates goods receipt
  const handleSubmitPO = async (id: string) => {
    if (
      !confirm(
        'Submit this purchase order?\n\nThis will:\n• Mark PO as Pending\n• Send to supplier\n• Create a draft goods receipt for receiving'
      )
    )
      return;
    try {
      // First submit the PO
      await submitPOMutation.mutateAsync(id);

      // Then automatically send to supplier (creates goods receipt)
      const result = await sendToSupplierMutation.mutateAsync(id);
      const resultData = result?.data as SendToSupplierData | undefined;
      const grNumber = resultData?.goodsReceipt?.receiptNumber || 'GR-XXXX-XXXX';

      alert(
        `✅ Purchase Order submitted and sent to supplier!\n\nGoods Receipt ${grNumber} created for receiving department.\n\nNext: Receiving department will confirm quantities when delivery arrives.`
      );
      refetch();
    } catch (error: unknown) {
      handleApiError(error, { fallback: 'Failed to submit purchase order' });
    }
  };

  // Handle cancel PO
  const handleCancelPO = async (id: string) => {
    if (
      !confirm(
        'Cancel this purchase order?\n\nAny draft goods receipts linked to this PO will also be cancelled and removed from the receiving queue. Posted receipts cannot be undone from here — use Return to supplier instead.'
      )
    )
      return;
    try {
      await cancelPOMutation.mutateAsync(id);
      alert('Purchase order cancelled. Linked draft goods receipts were cancelled.');
    } catch (error) {
      handleApiError(error, { fallback: 'Failed to cancel purchase order' });
    }
  };

  // Handle delete PO
  const handleDeletePO = async (id: string) => {
    if (
      !confirm(
        'Delete this draft purchase order?\n\nThis cancels the PO. Fully reversed receipt history (if any) is kept for audit.',
      )
    )
      return;
    try {
      await deletePOMutation.mutateAsync(id);
      alert('Purchase order deleted');
    } catch (error: unknown) {
      handleApiError(error, { fallback: 'Failed to delete purchase order' });
    }
  };

  // Handle edit draft PO — loads full PO with items
  const handleEditPO = async (po: PORow) => {
    try {
      const response = await api.purchaseOrders.getById(po.id);
      const apiData = response.data;
      const responseData = (apiData.data || apiData) as PODetailData;
      const poData = responseData.po || responseData;
      const items = responseData.items || [];

      const mappedItems = items.map((item: POItemRow) => ({
        ...item,
        productName: item.product_name || item.productName,
        purchaseOrderId: item.purchase_order_id || item.purchaseOrderId,
        productId: item.product_id || item.productId,
        quantity: item.ordered_quantity || item.quantity,
        unitCost: item.unit_price || item.unitCost,
        receivedQuantity:
          item.gross_received_quantity ?? item.received_quantity ?? item.receivedQuantity,
        returnedQuantity: item.returned_quantity ?? item.returnedQuantity ?? 0,
        netReceivedQuantity: item.net_received_quantity ?? item.netReceivedQuantity ?? 0,
        openQuantity: item.open_quantity ?? item.openQuantity ?? 0,
        totalPrice: item.total_price || item.totalPrice,
      }));

      setEditingPO({
        ...mapPOFromDB(poData as PORow),
        items: mappedItems,
      });
    } catch (error: unknown) {
      handleApiError(error, { fallback: 'Failed to load purchase order for editing' });
    }
  };

  // Handle view details - fetch full PO with items
  const handleViewDetails = async (po: PORow) => {
    try {
      // Fetch full PO details with items
      const response = await api.purchaseOrders.getById(po.id);
      console.log('API Response:', response);

      // Response structure: { data: { success: true, data: { po: {...}, items: [...] } } }
      const apiData = response.data;
      console.log('API Data:', apiData);

      // Extract the nested data object
      const responseData = (apiData.data || apiData) as PODetailData;
      console.log('Response Data:', responseData);

      const poData = responseData.po || responseData;
      const items = responseData.items || [];

      console.log('PO Data:', poData);
      console.log('Items:', items);

      // Map items from snake_case to camelCase
      const mappedItems = items.map((item: POItemRow) => ({
        ...item,
        productName: item.product_name || item.productName,
        purchaseOrderId: item.purchase_order_id || item.purchaseOrderId,
        productId: item.product_id || item.productId,
        quantity: item.ordered_quantity || item.quantity,
        unitCost: item.unit_price || item.unitCost,
        receivedQuantity:
          item.gross_received_quantity ?? item.received_quantity ?? item.receivedQuantity,
        returnedQuantity: item.returned_quantity ?? item.returnedQuantity ?? 0,
        netReceivedQuantity: item.net_received_quantity ?? item.netReceivedQuantity ?? 0,
        openQuantity: item.open_quantity ?? item.openQuantity ?? 0,
        totalPrice: item.total_price || item.totalPrice,
      }));

      const finalPO = {
        ...mapPOFromDB(poData as PORow),
        items: mappedItems,
      };

      console.log('Final PO:', finalPO);

      setSelectedPO(finalPO);
      setPendingSupplierId(finalPO.supplierId || '');
      setShowDetailsModal(true);
    } catch (error: unknown) {
      console.error('Error loading PO details:', error);
      handleApiError(error, { fallback: 'Failed to load purchase order details' });
    }
  };

  // Format date safely
  const formatDate = (dateString: string | null | undefined): string => {
    if (!dateString) return '-';
    try {
      const date = new Date(dateString);
      if (isNaN(date.getTime())) return '-';
      return date.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        timeZone: BUSINESS_TIMEZONE,
      });
    } catch {
      return '-';
    }
  };

  // Export Purchase Order to PDF — direct authenticated download (same pattern as Customer statement)
  const handleExportPDF = (po: PORow | null): void => {
    if (!po) return;
    const poNumber = (po as unknown as Record<string, unknown>).order_number as string || po.poNumber || po.id;
    downloadFile(`/documents/PURCHASE_ORDER/${po.id}`, `po-${poNumber}.pdf`).catch((err: Error) => {
      alert(`PDF export failed: ${err.message}`);
    });
  };

  // Initial load only — never unmount the page while search/filter refetches (focus SSOT).
  if (isLoading && !posData) {
    return (
      <div className="p-6" data-po-initial-loading="true">
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <p className="text-blue-800">Loading purchase orders...</p>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="p-6">
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <p className="text-red-800">Failed to load purchase orders. Please try again.</p>
          <button
            onClick={() => refetch()}
            className="mt-2 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div data-po-page="true">
      <AdaptivePage
        className={ADAPTIVE_PAGE_PAD_CLASS}
        title={
          <span className="inline-flex items-center gap-2">
            Purchase Orders
            <WorkflowHelpTrigger title="Purchase Order Workflow">
              <ul className="space-y-1 text-sm">
                <li>• <strong>Status Flow:</strong> DRAFT → PENDING → COMPLETED (Cancel anytime before goods stay posted)</li>
                <li>• <strong>Goods Receipts:</strong> Create GR when items are received</li>
              </ul>
            </WorkflowHelpTrigger>
          </span>
        }
        description="Manage supplier orders with full workflow tracking"
        densityOverride={ADAPTIVE_WORKLIST_DENSITY}
        toolbarInline
        toolbar={
          <div className={ADAPTIVE_TOOLBAR_CARD_CLASS} data-po-filters="true">
            <AdaptiveToolbar
              modeOverride="compact"
              actionsBeforeLeading
              leading={
                <AdaptiveSearch
                  value={searchTerm}
                  onChange={setSearchTerm}
                  placeholder="Search PO number, supplier name or code…"
                  label="Search purchase orders"
                  presentationOverride="compact"
                  trailing={
                    searchTerm ? (
                      <button
                        type="button"
                        aria-label="Clear search"
                        data-po-search-clear="true"
                        onClick={() => {
                          setSearchTerm('');
                          setDebouncedSearch('');
                          setPage(1);
                        }}
                        className="shrink-0 rounded-md border border-stone-200 bg-white px-2.5 text-sm font-medium text-stone-600 min-h-[var(--layout-touch-target)] hover:bg-stone-50"
                      >
                        Clear
                      </button>
                    ) : null
                  }
                />
              }
              secondaryLabel="Filters"
              secondary={({ close }) => (
                <AdaptiveFilterPanel
                  panelKey="po"
                  data-po-filter-panel="true"
                  footer={
                    <div className="flex flex-col gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedStatus('ALL');
                          setSelectedSupplier('');
                          setSearchTerm('');
                          setPage(1);
                          close();
                        }}
                        className="w-full rounded-md border border-stone-200 bg-white px-3 py-2 text-sm font-medium text-stone-700 min-h-[var(--layout-touch-target)] hover:bg-stone-50"
                      >
                        Clear filters
                      </button>
                      <AdaptiveFilterDoneButton onClick={() => close()}>Done</AdaptiveFilterDoneButton>
                    </div>
                  }
                >
                  <AdaptiveFilterField label="Status" htmlFor="status-filter">
                    <select
                      id="status-filter"
                      value={selectedStatus}
                      onChange={(e) => {
                        setSelectedStatus(e.target.value as POStatus | 'ALL');
                        setPage(1);
                        close();
                      }}
                      className={adaptiveFilterControlClass}
                    >
                      <option value="ALL">All statuses</option>
                      {Object.entries(PO_STATUSES).map(([key, { label, icon }]) => (
                        <option key={key} value={key}>
                          {icon} {label}
                        </option>
                      ))}
                    </select>
                  </AdaptiveFilterField>
                  <AdaptiveFilterField label="Supplier" htmlFor="supplier-filter">
                    <select
                      id="supplier-filter"
                      value={selectedSupplier}
                      onChange={(e) => {
                        setSelectedSupplier(e.target.value);
                        setPage(1);
                        close();
                      }}
                      className={adaptiveFilterControlClass}
                    >
                      <option value="">All suppliers</option>
                      {suppliers.map((supplier: Supplier) => (
                        <option key={supplier.id} value={supplier.id}>
                          {supplier.name}
                        </option>
                      ))}
                    </select>
                  </AdaptiveFilterField>
                </AdaptiveFilterPanel>
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
                    onClick={() => refetch()}
                    data-po-refresh="true"
                  >
                    Refresh
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
              {canCreatePO ? (
                <button
                  type="button"
                  onClick={() => setShowCreateModal(true)}
                  className="inline-flex items-center justify-center rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 min-h-[var(--layout-touch-target)]"
                  data-po-primary-cta="true"
                >
                  Create PO
                </button>
              ) : null}
            </AdaptiveToolbar>
          </div>
        }
      >

      {/* Summary — global AdaptiveKpiStrip (2-up phone, never cols-1 towers) */}
      <AdaptiveKpiStrip
        className="mb-1"
        items={[
          {
            id: 'total',
            label: listFiltersActive ? 'Matching POs' : 'Total POs',
            value: stats.total,
          },
          { id: 'draft', label: 'Draft', value: stats.draft, valueClassName: 'text-gray-600' },
          { id: 'pending', label: 'Pending', value: stats.pending, valueClassName: 'text-yellow-600' },
          { id: 'completed', label: 'Completed', value: stats.completed, valueClassName: 'text-green-600' },
          { id: 'cancelled', label: 'Cancelled', value: stats.cancelled, valueClassName: 'text-red-600' },
          {
            id: 'value',
            label: 'Total Value',
            sub: listFiltersActive ? '(this page, excl. cancelled)' : '(excl. cancelled)',
            value: formatCurrency(stats.totalValue),
            valueClassName: 'text-blue-600',
          },
        ]}
      />

      {listFiltersActive ? (
        <p className="mb-2 text-xs text-stone-500" data-po-search-result-count="true">
          Showing {purchaseOrders.length} of {matchedTotal} matching purchase order
          {matchedTotal === 1 ? '' : 's'}
          {debouncedSearch ? ` for “${debouncedSearch}”` : ''}
          {isFetching && isPlaceholderData ? ' · updating…' : ''}
        </p>
      ) : isFetching ? (
        <p className="mb-2 text-xs text-stone-400" data-po-list-fetching="true">
          Updating…
        </p>
      ) : null}

      {/* Purchase Orders Table */}
      <div className="bg-white rounded-lg shadow overflow-hidden">
        {/* Mobile Card View */}
        <div className="block sm:hidden space-y-3 p-3">
          {purchaseOrders.length === 0 ? (
            <div className="text-center py-8 text-gray-500">
              {listFiltersActive
                ? 'No purchase orders match your filters'
                : 'No purchase orders yet. Create your first PO to get started!'}
            </div>
          ) : (
            purchaseOrders.map((po: PORow) => {
              const statusConfig = poStatusBadge(po);
              const totalAmount = new Decimal(po.totalAmount || 0);
              return (
                <div key={po.id} className="border border-gray-200 rounded-lg p-4" onClick={() => handleViewDetails(po)}>
                  <div className="flex items-start justify-between mb-2">
                    <div>
                      <div className="text-sm font-semibold text-blue-600">{po.poNumber}</div>
                      <div className="text-xs text-gray-600">{po.supplierName}</div>
                    </div>
                    <span
                      className={`inline-flex px-2 py-0.5 text-xs font-semibold rounded-full ${statusConfig.color}`}
                      title={statusConfig.title}
                    >
                      {statusConfig.icon} {statusConfig.label}
                    </span>
                  </div>
                  <div className="flex justify-between items-center mb-2">
                    <div className="text-xs text-gray-500">Ordered: {formatDate(po.orderDate)}</div>
                    <div className="text-base font-bold text-gray-900">{formatCurrency(totalAmount.toNumber())}</div>
                  </div>
                  <div className="text-xs text-gray-500 mb-2">Delivery: {formatDate(po.expectedDelivery)}</div>
                  <div className="flex gap-3 border-t border-gray-100 pt-2">
                    {po.status === 'DRAFT' && (
                      <>
                        {canCreatePO && (
                          <button onClick={(e) => { e.stopPropagation(); handleEditPO(po); }} className="text-xs text-indigo-600 font-medium">Edit</button>
                        )}
                        {canSubmitPO && (
                          <button onClick={(e) => { e.stopPropagation(); handleSubmitPO(po.id); }} className="text-xs text-blue-600 font-medium">Submit</button>
                        )}
                        {canDeletePO && (
                          <button onClick={(e) => { e.stopPropagation(); handleDeletePO(po.id); }} className="text-xs text-red-600 font-medium">Delete</button>
                        )}
                      </>
                    )}
                    {(po.status === 'DRAFT' || po.status === 'PENDING') && canCancelPO && (
                      <button onClick={(e) => { e.stopPropagation(); handleCancelPO(po.id); }} className="text-xs text-orange-600 font-medium">Cancel</button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Desktop Table View */}
        <div className="hidden sm:block overflow-x-auto">
          <ResponsiveTableWrapper>
            <table className={INVENTORY_WORKLIST_TABLE_CLASS} data-inventory-worklist-table="true">
              <thead className="bg-gray-50">
                <tr>
                  {showCol('poNumber') ? (
                    <SortableTableHeader label="PO Number" field="poNumber" activeField={sortField} direction={sortOrder} onSort={handleColumnSort} className={INVENTORY_COL_FILL_CLASS} />
                  ) : null}
                  {showCol('supplier') ? (
                    <SortableTableHeader label="Supplier" field="supplier" activeField={sortField} direction={sortOrder} onSort={handleColumnSort} className={INVENTORY_COL_FIT_CLASS} />
                  ) : null}
                  {showCol('orderDate') ? (
                    <SortableTableHeader label="Order Date" field="orderDate" activeField={sortField} direction={sortOrder} onSort={handleColumnSort} className={INVENTORY_COL_FIT_CLASS} />
                  ) : null}
                  {hasDeliveryDates && showCol('expectedDelivery') ? (
                    <SortableTableHeader label="Expected Delivery" field="expectedDelivery" activeField={sortField} direction={sortOrder} onSort={handleColumnSort} className={INVENTORY_COL_FIT_CLASS} />
                  ) : null}
                  {showCol('status') ? (
                    <SortableTableHeader label="Status" field="status" activeField={sortField} direction={sortOrder} onSort={handleColumnSort} className={INVENTORY_COL_FIT_CLASS} />
                  ) : null}
                  {showCol('totalAmount') ? (
                    <SortableTableHeader label="Total Amount" field="totalAmount" activeField={sortField} direction={sortOrder} onSort={handleColumnSort} align="right" className={INVENTORY_COL_FIT_CLASS} />
                  ) : null}
                  {showCol('actions') ? (
                    <th className={`px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider ${INVENTORY_COL_FIT_CLASS}`}>
                      Actions
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {purchaseOrders.length === 0 ? (
                  <tr>
                    <td colSpan={tableColSpan} className="px-6 py-8 text-center text-gray-500">
                      {listFiltersActive
                        ? 'No purchase orders match your filters'
                        : 'No purchase orders yet. Create your first PO to get started!'}
                    </td>
                  </tr>
                ) : (
                  purchaseOrders.map((po: PORow) => {
                    const statusConfig = poStatusBadge(po);
                    const totalAmount = new Decimal(po.totalAmount || 0);

                    return (
                      <tr key={po.id} className="hover:bg-gray-50">
                        {showCol('poNumber') ? (
                          <td className={`px-4 py-4 ${INVENTORY_COL_FILL_CLASS}`}>
                            <div className="text-sm font-medium text-blue-600 truncate min-w-0">{po.poNumber}</div>
                          </td>
                        ) : null}

                        {showCol('supplier') ? (
                          <td className={`px-4 py-4 ${INVENTORY_COL_FIT_CLASS}`}>
                            <div className="text-sm text-gray-900">{po.supplierName}</div>
                            {po.supplierContact && (
                              <div className="text-xs text-gray-500">{po.supplierContact}</div>
                            )}
                          </td>
                        ) : null}

                        {showCol('orderDate') ? (
                          <td className={`px-4 py-4 ${INVENTORY_COL_FIT_CLASS}`}>
                            <div className="text-sm text-gray-900">{formatDate(po.orderDate)}</div>
                          </td>
                        ) : null}

                        {hasDeliveryDates && showCol('expectedDelivery') ? (
                          <td className={`px-4 py-4 ${INVENTORY_COL_FIT_CLASS}`}>
                            <div className="text-sm text-gray-900">
                              {formatDate(po.expectedDelivery)}
                            </div>
                          </td>
                        ) : null}

                        {showCol('status') ? (
                          <td className={`px-4 py-4 ${INVENTORY_COL_FIT_CLASS}`}>
                            <span
                              className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${statusConfig.color}`}
                              title={statusConfig.title}
                            >
                              {statusConfig.icon} {statusConfig.label}
                            </span>
                            {shouldShowPOReceiptProgressLine(po) && (
                              <div className="text-xs text-gray-500 mt-1">
                                {Number(po.netReceivedQtyTotal ?? 0)} / {Number(po.orderedQtyTotal ?? 0)} net received
                                {Number(po.openQtyTotal ?? 0) > 0
                                  ? ` · ${Number(po.openQtyTotal)} open`
                                  : ''}
                              </div>
                            )}
                          </td>
                        ) : null}

                        {showCol('totalAmount') ? (
                          <td className={`px-4 py-4 text-right ${INVENTORY_COL_FIT_CLASS}`}>
                            <div className="text-sm font-medium text-gray-900">
                              {formatCurrency(totalAmount.toNumber())}
                            </div>
                          </td>
                        ) : null}

                        {showCol('actions') ? (
                          <td className={`px-4 py-4 text-right text-sm font-medium ${INVENTORY_COL_FIT_CLASS}`}>
                            <div className="flex justify-end gap-2">
                              {po.status === 'DRAFT' && (
                                <>
                                  {canCreatePO && (
                                    <button
                                      onClick={() => handleEditPO(po)}
                                      className="text-indigo-600 hover:text-indigo-900"
                                      title="Edit Draft PO"
                                    >
                                      ✏️
                                    </button>
                                  )}
                                  {canSubmitPO && (
                                    <button
                                      onClick={() => handleSubmitPO(po.id)}
                                      className="text-blue-600 hover:text-blue-900"
                                      title="Submit PO & Send to Receiving"
                                    >
                                      📤
                                    </button>
                                  )}
                                  {canDeletePO && (
                                    <button
                                      onClick={() => handleDeletePO(po.id)}
                                      className="text-red-600 hover:text-red-900"
                                      title="Delete"
                                    >
                                      🗑️
                                    </button>
                                  )}
                                </>
                              )}
                              {(po.status === 'DRAFT' || po.status === 'PENDING') && canCancelPO && (
                                <button
                                  onClick={() => handleCancelPO(po.id)}
                                  className="text-orange-600 hover:text-orange-900"
                                  title="Cancel PO"
                                >
                                  ❌
                                </button>
                              )}
                              <button
                                onClick={() => handleViewDetails(po)}
                                className="text-gray-600 hover:text-gray-900"
                                title="View Details"
                              >
                                👁️
                              </button>
                            </div>
                          </td>
                        ) : null}
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </ResponsiveTableWrapper>
        </div>
      </div>

      {/* Pagination — server totalPages SSOT (same contract as Goods Receipts) */}
      {pagination && pagination.totalPages > 1 && (
        <div className="mt-6 flex justify-between items-center" data-po-pagination="true">
          <div className="text-sm text-gray-600">
            Page {pagination.page} of {pagination.totalPages} ({pagination.total} total)
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setPage(Math.max(1, page - 1))}
              disabled={page <= 1}
              className="px-4 py-2 text-sm bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              ← Previous
            </button>
            <button
              type="button"
              onClick={() => setPage(Math.min(pagination.totalPages, page + 1))}
              disabled={page >= pagination.totalPages}
              className="px-4 py-2 text-sm bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Next →
            </button>
          </div>
        </div>
      )}

      </AdaptivePage>

      {/* Create PO Modal */}
      {showCreateModal && (
        <CreatePOModal
          key={
            createModalSeed
              ? `reorder-po-${createModalSeed.nonce}-${createModalSeed.items.map((i) => i.productId).join(',')}`
              : 'po-create-new'
          }
          onClose={() => {
            setShowCreateModal(false);
            setCreateModalSeed(null);
          }}
          onSuccess={() => {
            refetch();
            setShowCreateModal(false);
            setCreateModalSeed(null);
          }}
          initialReorderItems={createModalSeed?.items}
        />
      )}

      {/* Edit PO Modal */}
      {editingPO && (
        <EditPOModal
          po={editingPO}
          onClose={() => setEditingPO(null)}
          onSuccess={() => { refetch(); setEditingPO(null); }}
        />
      )}

      {/* Details workspace */}
      {showDetailsModal && selectedPO && (
        <SlideDrawer
          open
          onClose={() => setShowDetailsModal(false)}
          title="Purchase Order Details"
          subtitle={selectedPO.poNumber}
          width="full"
          footer={
            <div className="flex flex-col gap-2 w-full sm:flex-row sm:flex-wrap sm:justify-between sm:items-center" data-po-detail-chrome="true">
              <div className="flex flex-col gap-2 w-full min-[400px]:flex-row min-[400px]:flex-wrap">
                <button
                  type="button"
                  onClick={() => handleExportPDF(selectedPO)}
                  className={`${mobileActionBtnClass} px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 flex gap-2`}
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className="h-4 w-4 shrink-0"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                    />
                  </svg>
                  Export PDF
                </button>
                <div className="w-full min-[400px]:w-auto [&>button]:w-full min-[400px]:[&>button]:w-auto">
                  <DocumentFlowButton entityType="PURCHASE_ORDER" entityId={selectedPO.id} size="sm" />
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowDetailsModal(false)}
                className={`${mobileActionBtnClass} px-4 py-2 bg-white border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 flex`}
              >
                Close
              </button>
            </div>
          }
        >
            <div className="space-y-6 -mt-2">
              {/* Status Badge */}
              <div className="space-y-2">
                {(() => {
                  const badge = poStatusBadge(selectedPO);
                  return (
                    <span
                      className={`inline-flex px-3 py-1 text-sm font-semibold rounded-full ${badge.color}`}
                      title={badge.title}
                    >
                      {badge.icon} {badge.label}
                    </span>
                  );
                })()}
                {shouldShowPOReceiptProgressLine(selectedPO) && (
                  <p className="text-sm text-gray-600">
                    Receipt progress:{' '}
                    <strong>
                      {Number(selectedPO.netReceivedQtyTotal ?? 0)} /{' '}
                      {Number(selectedPO.orderedQtyTotal ?? 0)}
                    </strong>{' '}
                    units net received
                    {Number(selectedPO.openQtyTotal ?? 0) > 0 ? (
                      <>
                        {' '}
                        — <strong>{Number(selectedPO.openQtyTotal)}</strong> still open (receive again on
                        Goods Receipt or after supplier return).
                      </>
                    ) : null}
                  </p>
                )}
              </div>

              {/* General Information */}
              <div className="grid grid-cols-2 gap-6">
                <div>
                  <h3 className="text-sm font-medium text-gray-500">Supplier</h3>
                  {poCanChangeSupplier(selectedPO) ? (
                    <div className="mt-2 space-y-2">
                      <p className="text-xs text-gray-600">
                        No goods received and no supplier invoice yet — you can change the vendor on this PO.
                      </p>
                      <SupplierSelector
                        value={pendingSupplierId}
                        onChange={setPendingSupplierId}
                        disabled={isChangingSupplier}
                        showLabel={false}
                      />
                      <button
                        type="button"
                        disabled={
                          isChangingSupplier ||
                          !pendingSupplierId ||
                          pendingSupplierId === selectedPO.supplierId
                        }
                        onClick={async () => {
                          setIsChangingSupplier(true);
                          try {
                            await updatePOMutation.mutateAsync({
                              id: selectedPO.id,
                              data: { supplierId: pendingSupplierId },
                            });
                            alert('Supplier updated on purchase order.');
                            refetch();
                            setShowDetailsModal(false);
                          } catch (error: unknown) {
                            handleApiError(error, { fallback: 'Failed to change supplier' });
                          } finally {
                            setIsChangingSupplier(false);
                          }
                        }}
                        className="text-sm px-3 py-1.5 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50"
                      >
                        Save supplier
                      </button>
                    </div>
                  ) : (
                    <>
                      <p className="mt-1 text-base font-medium text-gray-900">
                        {selectedPO.supplierName}
                      </p>
                      {selectedPO.supplierContact && (
                        <p className="text-sm text-gray-600">{selectedPO.supplierContact}</p>
                      )}
                      {selectedPO.status === 'PENDING' && (
                        <p className="text-xs text-gray-500 mt-1">
                          Supplier is locked after receipt or invoicing. Use Return to supplier / credit note, or post-GR reassignment.
                        </p>
                      )}
                    </>
                  )}
                </div>

                <div>
                  <h3 className="text-sm font-medium text-gray-500">Order Date</h3>
                  <p className="mt-1 text-base text-gray-900">{formatDate(selectedPO.orderDate)}</p>
                </div>

                <div>
                  <h3 className="text-sm font-medium text-gray-500">Expected Delivery</h3>
                  <p className="mt-1 text-base text-gray-900">
                    {formatDate(selectedPO.expectedDelivery)}
                  </p>
                </div>

                <div>
                  <h3 className="text-sm font-medium text-gray-500">Total Amount</h3>
                  <p className="mt-1 text-base font-bold text-gray-900">
                    {formatCurrency(
                      (selectedPO.items && selectedPO.items.length > 0
                        ? selectedPO.items.reduce((sum: Decimal, item: POItemRow) => {
                            const q = String(item.quantity ?? item.ordered_quantity ?? 0);
                            const u = String(item.unitCost ?? item.unit_price ?? 0);
                            const stored = item.total_price ?? item.totalPrice ?? item.lineTotal;
                            const money = hydratePoLineMoney(q, u, stored);
                            return sum.plus(new Decimal(money.lineTotal));
                          }, new Decimal(0))
                        : new Decimal(selectedPO.totalAmount || 0)
                      ).toNumber(),
                    )}
                  </p>
                </div>
              </div>

              {/* Notes */}
              {selectedPO.notes && (
                <div>
                  <h3 className="text-sm font-medium text-gray-500">Notes</h3>
                  <p className="mt-1 text-base text-gray-900 whitespace-pre-wrap">
                    {selectedPO.notes}
                  </p>
                </div>
              )}

              {/* Line Items */}
              <div>
                <h3 className="text-base font-semibold text-gray-900 mb-3">Line Items</h3>
                <div className="border rounded-lg overflow-hidden">
                  <ResponsiveTableWrapper>
                    <table className="min-w-full divide-y divide-gray-200">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                            Product
                          </th>
                          <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">
                            Quantity
                          </th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                            UOM
                          </th>
                          <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">
                            Unit Cost
                          </th>
                          <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">
                            Total
                          </th>
                        </tr>
                      </thead>
                      <tbody className="bg-white divide-y divide-gray-200">
                        {selectedPO.items && selectedPO.items.length > 0 ? (
                          selectedPO.items.map((item: POItemRow, index: number) => {
                            const quantity = new Decimal(item.quantity || item.ordered_quantity || 0);
                            const unitRaw = String(item.unitCost || item.unit_price || 0);
                            const stored = item.total_price ?? item.totalPrice ?? item.lineTotal;
                            const money = hydratePoLineMoney(quantity.toString(), unitRaw, stored);
                            const total = Number(money.lineTotal);

                            return (
                              <tr key={index}>
                                <td className="px-4 py-3 text-sm text-gray-900">
                                  {item.productName}
                                </td>
                                <td className="px-4 py-3 text-sm text-gray-900 text-right">
                                  {quantity.toString()}
                                </td>
                                <td className="px-4 py-3 text-sm text-gray-600">
                                  {item.uomName || item.uom_name || 'Base UoM'}
                                </td>
                                <td className="px-4 py-3 text-sm text-gray-900 text-right">
                                  {formatCurrency(money.unitCost, true, 6)}
                                </td>
                                <td className="px-4 py-3 text-sm font-medium text-gray-900 text-right">
                                  {formatCurrency(total)}
                                </td>
                              </tr>
                            );
                          })
                        ) : (
                          <tr>
                            <td colSpan={5} className="px-4 py-3 text-sm text-gray-500 text-center">
                              No line items
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </ResponsiveTableWrapper>
                </div>
              </div>

              {/* Metadata */}
              <div className="border-t pt-4">
                <div className="grid grid-cols-2 gap-4 text-xs text-gray-500">
                  <div>
                    <span className="font-medium">Created:</span> {formatDate(selectedPO.createdAt)}
                  </div>
                  <div>
                    <span className="font-medium">Updated:</span> {formatDate(selectedPO.updatedAt)}
                  </div>
                </div>
              </div>
            </div>
        </SlideDrawer>
      )}

    </div>
  );
}
