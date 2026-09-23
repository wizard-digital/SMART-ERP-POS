import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
/**
 * Goods Receipt / GRN (spec: GoodsReceipt.tsx) — route `/inventory/goods-receipts`
 * Nested under Receiving workbench (Receipts tab); returns live on sibling tab.
 * Multistore: per-line Destination Store selector, default MAIN warehouse when flag is on.
 */
import { useOutletContext } from 'react-router-dom';
import { ZINDEX } from '../../hooks/useTransactionGuard';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Decimal from 'decimal.js';
import { downloadFile } from '../../utils/download';
import { getBusinessDate } from '../../utils/businessDate';
import { grBillableLineTotal, splitGRReceiptQuantities } from '../../utils/grReceiptQuantity';
import { grItemTrackExpiry, grLineExpirySatisfied } from '../../utils/grExpiryGate';
import { isGoodsReceiptPosted } from '@shared/domain/pgDomainEnums';
import {
  alignPaperTotalToGrAmount,
  buildGrnBillPromptDefaults,
  GRN_BILL_PROMPT_COPY,
  isLikelyGrnBillDigitShiftTypo,
  listGrnBillUnderVarianceReasons,
  resolveGrnBillDigitShiftGuidance,
  resolveGrnBillOverGuidance,
  resolveGrnBillPromptSupplierLabel,
  resolveGrnBillPromptVariance,
  suggestGrnBillVarianceReason,
} from '@shared/domain/grnBillPromptSsot';
import {
  canCreateSupplierCreditNoteFromReturn,
  supplierReturnActionLabel,
} from '@shared/domain/supplierReturnWorklist';
import { poAllowsGoodsReceiptFinalize } from '@shared/domain/poReceiptWorkflowSsot';
import {
  useGoodsReceipts,
  useFinalizeGoodsReceipt,
  useGoodsReceipt,
  useCreateGoodsReceipt,
  useCancelGoodsReceipt,
  useHydrateGRFromPO,
  useAddGRItem,
  useRemoveGRItem,
} from '../../hooks/useGoodsReceipts';
import {
  useReturnableItems,
  useReturnGrnsByGrn,
  unwrapReturnGrnListPayload,
  useCreateReturnGrn,
  usePostReturnGrn,
  useCreateCreditNoteFromReturn,
} from '../../hooks/useReturnGrn';
import type { ReturnableItem } from '../../hooks/useReturnGrn';
import {
  formatReturnGrnDualQty,
  findReturnUomOption,
  maxReturnableInUom,
  resolveReturnUomOptions,
  returnGrnLineTotal,
} from '../../utils/returnGrnUom';
import { useAuth } from '../../hooks/useAuth';
import { useTenant } from '../../contexts/TenantContext';
import { formatCurrency } from '../../utils/currency';
import { api } from '../../utils/api';
import { handleApiError } from '../../utils/errorHandler';
import toast from 'react-hot-toast';
import { DocumentFlowButton } from '../../components/shared/DocumentFlowButton';
import { SupplierReassignmentModal } from '../../components/inventory/SupplierReassignmentModal';
import { GrBillingStatusBadge } from '../../components/inventory/GrBillingStatusBadge';
import { GrReceiptStatusBadge } from '../../components/inventory/GrReceiptStatusBadge';
import { ResponsiveTableWrapper } from '../../components/ui/ResponsiveTableWrapper';
import { SortableTableHeader } from '../../components/ui/SortableTableHeader';
import { MobileSortSelect } from '../../components/ui/MobileSortSelect';
import { useServerTableSort } from '../../hooks/useServerTableSort';
import { ListSkeleton } from '../../components/ui/ListSkeleton';
import { MobileListCard, ResponsiveActionBar, mobileActionBtnClass } from '../../components/ui/ResponsiveActionBar';
import ManualGRButton from '../../components/inventory/ManualGRButton';
import { InventoryColumnPicker } from '../../components/inventory/InventoryColumnPicker';
import { useInventoryColumnPrefs } from '../../hooks/useInventoryColumnPrefs';
import { getCachedMultistoreEnabled, useMultistoreEnabled } from '../../hooks/useMultistore';
import { useStoreLocations } from '../../hooks/useWarehouse';
import { buildStoreLabelMap, resolveStoreLabel } from '../../components/inventory/storeLocationUtils';
import {
  readGrReceivingStoreId,
  writeGrReceivingStoreId,
} from '../../components/inventory/grReceivingStorePrefs';
import { StoreLocationSelect } from '../../components/inventory/StoreLocationSelect';
import type { StoreLocation } from '../../../../shared/types/warehouseNetwork';
import { ProcurementProductSearch } from '../../components/inventory/shared';
import type { ProcurementProduct } from '../../components/inventory/shared';
import { UomSelector } from '../../components/inventory/UomSelector';
import type { ProductUomDetail } from '../../hooks/useProductWithUoms';
import { useCanAccess } from '../../components/auth/ProtectedRoute';
import { inventoryKeys } from '../../hooks/useInventory';
import { DatePicker } from '../../components/ui/date-picker';
import SlideDrawer from '../../components/ui/SlideDrawer';
import {
  AdaptiveFacetChips,
  AdaptiveFilterDoneButton,
  AdaptiveFilterField,
  AdaptiveFilterPanel,
  AdaptiveMetaGrid,
  AdaptiveMetaItem,
  AdaptivePage,
  AdaptiveRowActions,
  AdaptiveSearch,
  AdaptiveToolbar,
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

// Configure Decimal for financial calculations
Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

// TIMEZONE STRATEGY: Display dates without conversion
// Backend returns DATE as YYYY-MM-DD string (no timezone)
// Frontend displays as-is without parsing to Date object
const formatDisplayDate = (dateString: string | null | undefined): string => {
  if (!dateString) return '-';

  // If it's an ISO string, extract the date part
  if (dateString.includes('T')) {
    return dateString.split('T')[0];
  }

  return dateString;
};

/** Avoid mixing ?? and || — Babel/Vite rejects bare chains in this file. */
function resolveGrLineTargetStoreId(
  item: Pick<GRItemRow, 'targetStoreLocationId' | 'target_store_location_id'>,
  editStoreId: string | null | undefined,
  defaultStoreId: string,
): string | null {
  const resolved =
    editStoreId ??
    item.targetStoreLocationId ??
    item.target_store_location_id ??
    defaultStoreId;
  return resolved || null;
}

interface CostAlert {
  type: string;
  severity: 'HIGH' | 'MEDIUM';
  productId: string;
  productName: string;
  message: string;
  details: {
    previousCost: string;
    newCost: string;
    changeAmount: string;
    changePercentage: string;
    batchNumber: string;
  };
}

interface GRRow {
  id: string;
  receiptNumber?: string;
  receipt_number?: string;
  grNumber?: string;
  gr_number?: string;
  purchaseOrderId?: string;
  purchase_order_id?: string;
  poNumber?: string;
  po_number?: string;
  poStatus?: string;
  po_status?: string;
  /** Linked PO was auto-created by Manual GR (COMPLETED shell until GR posts). */
  poManualReceipt?: boolean;
  po_manual_receipt?: boolean;
  supplierName?: string;
  supplier_name?: string;
  supplierId?: string;
  supplier_id?: string;
  status: string;
  receivedDate?: string;
  received_date?: string;
  receivedByName?: string;
  received_by_name?: string;
  supplierDeliveryNote?: string;
  supplier_delivery_note?: string;
  deliveryNote?: string;
  delivery_note?: string;
  finalizedAt?: string;
  finalized_at?: string;
  notes?: string;
  createdAt?: string;
  created_at?: string;
  items?: GRItemRow[];
  totalValue?: number | string;
  supplierBillNumber?: string | null;
  supplier_bill_number?: string | null;
  billingStatus?: 'DRAFT_GR' | 'TO_INVOICE' | 'INVOICED' | 'REVERSED' | 'CANCELLED' | 'NOT_APPLICABLE';
  billing_status?: 'DRAFT_GR' | 'TO_INVOICE' | 'INVOICED' | 'REVERSED' | 'CANCELLED' | 'NOT_APPLICABLE';
  isReversed?: boolean;
  is_reversed?: boolean;
  reversedByReturnGrnId?: string | null;
  reversed_by_return_grn_id?: string | null;
  reversedByReturnGrnNumber?: string | null;
  reversed_by_return_grn_number?: string | null;
  reversalTimestamp?: string | null;
  reversal_timestamp?: string | null;
  reversalReason?: string | null;
  reversal_reason?: string | null;
  /** Another GR on the same PO already has the supplier bill (top-up receipt). */
  poSiblingBill?: {
    invoiceId: string;
    invoiceNumber: string;
    grnId: string;
    grnNumber: string;
  } | null;
  po_sibling_bill?: {
    invoice_id: string;
    invoice_number: string;
    grn_id: string;
    grn_number: string;
  } | null;
}

type GRSortField =
  | 'grNumber'
  | 'poNumber'
  | 'supplier'
  | 'receivedDate'
  | 'receiptStatus'
  | 'invoiceStatus';

interface GRItemRow {
  id: string;
  productId?: string;
  product_id?: string;
  productName?: string;
  product_name?: string;
  orderedQuantity?: number | string;
  ordered_quantity?: number | string;
  poAlreadyReceived?: number | string;
  po_already_received?: number | string;
  receivedQuantity?: number | string;
  received_quantity?: number | string;
  unitCost?: number | string;
  unit_cost?: number | string;
  batchNumber?: string;
  batch_number?: string;
  expiryDate?: string;
  expiry_date?: string;
  notes?: string;
  totalCost?: number | string;
  isBonus?: boolean;
  is_bonus?: boolean;
  po_unit_price?: number | string;
  poUnitPrice?: number | string;
  product_cost_price?: number | string;
  productCostPrice?: number | string;
  uomSymbol?: string;
  uom_symbol?: string;
  uomName?: string;
  uom_name?: string;
  uomId?: string;
  uom_id?: string;
  conversionFactor?: number | string;
  conversion_factor?: number | string;
  trackExpiry?: boolean;
  track_expiry?: boolean;
  targetStoreLocationId?: string | null;
  target_store_location_id?: string | null;
}

interface PORow {
  id: string;
  order_number?: string;
  poNumber?: string;
  po_number?: string;
  supplier_name?: string;
  supplierName?: string;
  status: string;
  order_date?: string;
  orderDate?: string;
  total_amount?: number | string;
  totalAmount?: number | string;
}

interface POItemData {
  id: string;
  product_id?: string;
  productId?: string;
  product_name?: string;
  productName?: string;
  ordered_quantity?: number | string;
  quantity?: number | string;
  unit_price?: number | string;
  unitCost?: number | string;
  product_cost_price?: number | string;
  productCostPrice?: number | string;
  open_quantity?: number | string;
  openQuantity?: number | string;
  uom_id?: string | null;
  uomId?: string | null;
}

interface POData {
  po: { id: string };
  items: POItemData[];
}

interface EditItemState {
  batchNumber?: string | null;
  expiryDate?: string | null;
  receivedQuantity?: number;
  unitCost?: number;
  isBonus?: boolean;
  selectedUomId?: string;
  receivedUomQty?: number;
  receivedLooseQty?: number;
  targetStoreLocationId?: string | null;
}



interface ProductUomEntry {
  id: string;
  uomId: string;
  uomName: string;
  uomSymbol: string | null;
  conversionFactor: string;
  barcode: string | null;
  isDefault: boolean;
  priceOverride: string | null;
  costOverride: string | null;
}

interface GRDetailData {
  gr?: GRRow;
  items?: GRItemRow[];
  productUomsMap?: Record<string, ProductUomEntry[]>;
}

// ── Date range helpers (same pattern as StockMovementsPage) ───────────────
type DateRangePreset =
  | 'all'
  | 'today'
  | 'yesterday'
  | 'this_week'
  | 'last_week'
  | 'this_month'
  | 'last_month'
  | 'custom';

const formatLocalDate = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const getDateRange = (preset: DateRangePreset): { start: string; end: string } => {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  switch (preset) {
    case 'today':
      return { start: formatLocalDate(today), end: formatLocalDate(today) };
    case 'yesterday': {
      const y = new Date(today); y.setDate(y.getDate() - 1);
      return { start: formatLocalDate(y), end: formatLocalDate(y) };
    }
    case 'this_week': {
      const ws = new Date(today); ws.setDate(today.getDate() - today.getDay());
      const we = new Date(ws); we.setDate(ws.getDate() + 6);
      return { start: formatLocalDate(ws), end: formatLocalDate(we) };
    }
    case 'last_week': {
      const lws = new Date(today); lws.setDate(today.getDate() - today.getDay() - 7);
      const lwe = new Date(lws); lwe.setDate(lws.getDate() + 6);
      return { start: formatLocalDate(lws), end: formatLocalDate(lwe) };
    }
    case 'this_month': {
      const ms = new Date(now.getFullYear(), now.getMonth(), 1);
      const me = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      return { start: formatLocalDate(ms), end: formatLocalDate(me) };
    }
    case 'last_month': {
      const lms = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const lme = new Date(now.getFullYear(), now.getMonth(), 0);
      return { start: formatLocalDate(lms), end: formatLocalDate(lme) };
    }
    case 'custom':
      return { start: '', end: '' };
    case 'all':
    default:
      return { start: '', end: '' };
  }
};

export default function GoodsReceiptsPage() {
  const workbench = useOutletContext<{ embedded?: boolean } | null>();
  const embedded = Boolean(workbench?.embedded);
  const columnPrefs = useInventoryColumnPrefs('goods-receipts');
  const { show: showCol } = columnPrefs;
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [billingFilter, setBillingFilter] = useState<'' | 'TO_INVOICE' | 'INVOICED' | 'REVERSED'>('');
  const [searchTerm, setSearchTerm] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [dateRangePreset, setDateRangePreset] = useState<DateRangePreset>('all');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const {
    sortField,
    sortOrder,
    handleColumnSort: baseColumnSort,
    setSortOrder,
    serverListParams,
  } = useServerTableSort<GRSortField>({
    defaultField: 'receivedDate',
    defaultOrder: 'desc',
    onQueryChange: () => setPage(1),
  });
  const [selectedGR, setSelectedGR] = useState<GRRow | null>(null);
  const [showDetailsModal, setShowDetailsModal] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);

  // Debounce search (worklist SSOT)
  useEffect(() => {
    const timer = setTimeout(
      () => setDebouncedSearch(searchTerm.trim()),
      ADAPTIVE_WORKLIST_SEARCH_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [searchTerm]);

  // Reset page when search/dates change
  useEffect(() => { setPage(1); }, [debouncedSearch, statusFilter, billingFilter, startDate, endDate]);

  const closeCreateGrModal = useCallback(() => {
    setShowCreateModal(false);
    setSelectedPoId('');
    setPoSearch('');
    setPoPage(1);
    setFocusedPoIndex(0);
  }, []);

  // Permission gating
  const canCreateGR = useCanAccess([], ['purchasing.create']);
  const canUpdateGR = useCanAccess([], ['purchasing.update']);
  const canFinalizeGR = useCanAccess([], ['purchasing.post']);
  const canReassignSupplier = useCanAccess([], ['corrections.execute']);
  const { isMultistoreEnabled } = useMultistoreEnabled();
  const showMultistoreGrUi =
    isMultistoreEnabled || getCachedMultistoreEnabled() === true;
  const { data: grStoreLocations = [] } = useStoreLocations(showMultistoreGrUi && showDetailsModal);
  const defaultReceivingStoreId = useMemo(() => {
    // INV-POS: GR without an override must land where POS sells (not MAIN-only).
    const sellingStore =
      grStoreLocations.find((s) => s.storeType === 'SELLING' || s.isPosSelling);
    const defaultReceiving = grStoreLocations.find((s) => s.isDefaultReceiving);
    const mainStore = grStoreLocations.find((s) => s.storeType === 'MAIN');
    return (sellingStore ?? defaultReceiving ?? mainStore)?.id ?? '';
  }, [grStoreLocations]);
  const grDestinationStores = useMemo(
    () =>
      grStoreLocations.filter(
        (s) => s.isActive && (s.storeType === 'MAIN' || s.storeType === 'SELLING'),
      ),
    [grStoreLocations],
  );
  const grStoreLabelMap = useMemo(
    () => buildStoreLabelMap(grStoreLocations),
    [grStoreLocations],
  );
  const [headerReceivingStoreId, setHeaderReceivingStoreId] = useState('');
  const [showPerLineStoreOverride, setShowPerLineStoreOverride] = useState(false);
  const effectiveReceivingStoreId = headerReceivingStoreId || defaultReceivingStoreId;
  const [showAlertsModal, setShowAlertsModal] = useState(false);
  const [costAlerts, setCostAlerts] = useState<CostAlert[]>([]);
  // Post-finalize "Create Bill?" prompt (designed modal, not browser confirm)
  const [billPrompt, setBillPrompt] = useState<{
    grId: string;
    grNumber: string;
    total: number;         // GRN computed total (read-only, authoritative)
    supplierName: string;
    // User-editable fields for the supplier bill
    supplierInvoiceNumber: string;
    invoiceDate: string;
    supplierReportedTotal: string; // empty string = not provided
    varianceReason: '' | 'SUPPLIER_DISCOUNT' | 'ROUNDING_DIFFERENCE' | 'EDIT_LINE_PRICES';
  } | null>(null);
  const [billPromptLoading, setBillPromptLoading] = useState(false);
  /** Optional paper invoice total on draft GR — carry into bill prompt (visibility only). */
  const [draftPaperInvoiceTotal, setDraftPaperInvoiceTotal] = useState('');
  const [baseline, setBaseline] = useState<'PO' | 'PRODUCT'>('PO');
  const [poSearch, setPoSearch] = useState('');
  const [poPage, setPoPage] = useState(1);
  const [selectedPoId, setSelectedPoId] = useState('');
  const [focusedPoIndex, setFocusedPoIndex] = useState(0);
  const poRadioRefs = useRef<HTMLInputElement[]>([]);
  const [poQuickView, setPoQuickView] = useState<Record<string, { itemsCount: number }>>({});
  const [editItems, setEditItems] = useState<Record<string, EditItemState>>({});
  const [batchWarnings, setBatchWarnings] = useState<Record<string, string>>({});
  const validationTimeout = useRef<Record<string, NodeJS.Timeout>>({});
  const [showReturnModal, setShowReturnModal] = useState(false);
  const [showSupplierReassignModal, setShowSupplierReassignModal] = useState(false);
  const [creatingBillForGR, setCreatingBillForGR] = useState<string | null>(null);

  const [returnReason, setReturnReason] = useState('');
  const [returnQuantities, setReturnQuantities] = useState<Record<string, number>>({});
  const [returnUomIds, setReturnUomIds] = useState<Record<string, string>>({});
  const [showAddItemForm, setShowAddItemForm] = useState(false);
  const [returnSubmitting, setReturnSubmitting] = useState(false);
  const [showReverseModal, setShowReverseModal] = useState(false);
  const [reverseReason, setReverseReason] = useState('');
  const [reverseSubmitting, setReverseSubmitting] = useState(false);
  const [receiveAllFlash, setReceiveAllFlash] = useState('');

  const limit = 20;

  // Check for duplicate batch numbers
  const checkBatchDuplicate = async (itemId: string, batchNumber: string) => {
    if (!batchNumber || batchNumber.trim() === '') {
      setBatchWarnings((prev) => {
        const next = { ...prev };
        delete next[itemId];
        return next;
      });
      return;
    }

    try {
      const response = await fetch(
        `/api/inventory/batches/exists?batchNumber=${encodeURIComponent(batchNumber)}`
      );
      const data = await response.json();

      if (data.exists) {
        setBatchWarnings((prev) => ({
          ...prev,
          [itemId]: '⚠️ This batch number already exists in the system',
        }));
      } else {
        // Also check within current GR items
        const currentItems = Object.entries(editItems);
        const duplicateInCurrent =
          currentItems.filter(([id, item]) => id !== itemId && item.batchNumber === batchNumber)
            .length > 0;

        if (duplicateInCurrent) {
          setBatchWarnings((prev) => ({
            ...prev,
            [itemId]: '⚠️ Duplicate batch number in this goods receipt',
          }));
        } else {
          setBatchWarnings((prev) => {
            const next = { ...prev };
            delete next[itemId];
            return next;
          });
        }
      }
    } catch (error) {
      console.error('Failed to check batch duplicate:', error);
    }
  };

  // Fetch goods receipts
  const { data, isLoading, error } = useGoodsReceipts({
    page,
    limit,
    status: statusFilter || undefined,
    billingStatus: billingFilter || undefined,
    search: debouncedSearch || undefined,
    startDate: startDate || undefined,
    endDate: endDate || undefined,
    ...serverListParams,
  });

  const finalizeMutation = useFinalizeGoodsReceipt();
  const cancelGRMutation = useCancelGoodsReceipt();
  const createReturnGrnMutation = useCreateReturnGrn();
  const postReturnGrnMutation = usePostReturnGrn();
  const createCreditNoteMutation = useCreateCreditNoteFromReturn();
  const addGRItemMutation = useAddGRItem();
  const removeGRItemMutation = useRemoveGRItem();

  // Return GRN data for selected GRN
  const selectedGRId = selectedGR?.id || '';
  const isFinalized = isGoodsReceiptPosted(selectedGR?.status);

  const { data: reverseEligibilityData } = useQuery({
    queryKey: ['gr-reverse-eligibility', selectedGRId],
    queryFn: async () => {
      const res = await api.goodsReceipts.getReverseUninvoicedEligibility(selectedGRId);
      return (res.data as { data?: Record<string, unknown> })?.data ?? res.data;
    },
    enabled: showDetailsModal && isFinalized && Boolean(selectedGRId),
  });
  const reverseEligibility = reverseEligibilityData as {
    allowed?: boolean;
    route?: string;
    blockers?: string[];
    suggestedActions?: string[];
  } | undefined;
  const canReverseUninvoiced =
    reverseEligibility?.allowed === true
    && reverseEligibility?.route === 'REVERSE_UNINVOICED_RECEIPT';

  const { data: returnableData, isLoading: returnableLoading } = useReturnableItems(
    (showReturnModal || (showDetailsModal && isFinalized)) && selectedGRId ? selectedGRId : '',
  );
  const { data: returnGrnData } = useReturnGrnsByGrn(isFinalized ? selectedGRId : '');

  const returnableItems: ReturnableItem[] = useMemo(() => {
    const raw = (returnableData as { data?: { data?: ReturnableItem[] } })?.data?.data;
    if (!Array.isArray(raw)) return [];
    // Show lines still on the receipt (returnable or blocked with sold/consumed explanation)
    return raw.filter(
      (i) =>
        i.returnableQuantity > 0 ||
        (i.consumedQuantity ?? 0) > 0 ||
        i.receivedQuantity > i.returnedQuantity,
    );
  }, [returnableData]);

  const existingReturns = useMemo(() => {
    return unwrapReturnGrnListPayload(returnGrnData).rows;
  }, [returnGrnData]);

  // PDF Export for Goods Receipt — direct authenticated download (same pattern as Customer statement)
  const handleExportGRPDF = (gr: GRRow, _grItems: GRItemRow[]): void => {
    void _grItems;
    const grNumber = gr.grNumber || (gr as unknown as Record<string, unknown>).receipt_number as string || gr.receiptNumber || gr.id;
    downloadFile(`/documents/GOODS_RECEIPT/${gr.id}`, `gr-${grNumber}.pdf`).catch((err: Error) => {
      alert(`PDF export failed: ${err.message}`);
    });
  };
  const createGRMutation = useCreateGoodsReceipt();
  const hydrateFromPOMutation = useHydrateGRFromPO();
  const hydrateAttemptRef = useRef<string | null>(null);
  const { user } = useAuth();
  const { config } = useTenant();
  void config;
  const queryClient = useQueryClient();

  // Persist baseline selection
  useEffect(() => {
    const saved = localStorage.getItem('gr_cost_baseline');
    if (saved === 'PO' || saved === 'PRODUCT') setBaseline(saved);
  }, []);
  useEffect(() => {
    localStorage.setItem('gr_cost_baseline', baseline);
  }, [baseline]);

  useEffect(() => {
    if (!showDetailsModal || !showMultistoreGrUi || grDestinationStores.length === 0) return;
    const remembered = readGrReceivingStoreId(user?.id);
    const validRemembered =
      remembered && grDestinationStores.some((s) => s.id === remembered);
    const resolved = validRemembered ? remembered : defaultReceivingStoreId;
    if (resolved) {
      setHeaderReceivingStoreId(resolved);
    }
  }, [
    showDetailsModal,
    showMultistoreGrUi,
    grDestinationStores,
    defaultReceivingStoreId,
    user?.id,
  ]);

  useEffect(() => {
    if (
      !showDetailsModal ||
      !showMultistoreGrUi ||
      !effectiveReceivingStoreId ||
      showPerLineStoreOverride
    ) {
      return;
    }
    setEditItems((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const id of Object.keys(next)) {
        if (next[id].targetStoreLocationId !== effectiveReceivingStoreId) {
          next[id] = { ...next[id], targetStoreLocationId: effectiveReceivingStoreId };
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [
    effectiveReceivingStoreId,
    showPerLineStoreOverride,
    showDetailsModal,
    showMultistoreGrUi,
  ]);

  // Load GR details when modal opens
  const detailsQuery = useGoodsReceipt(selectedGR?.id || '');
  const refetchGRDetail = detailsQuery.refetch;
  const grDetailLoading = detailsQuery.isLoading;
  const grDetailFetching = detailsQuery.isFetching;
  const grDetail = detailsQuery.data?.data?.data as GRDetailData | undefined;
  const grReversalMeta = grDetail?.gr as GRRow | undefined;
  const isGrReversed = Boolean(
    grReversalMeta?.isReversed
    ?? grReversalMeta?.is_reversed
    ?? grReversalMeta?.reversedByReturnGrnId
    ?? grReversalMeta?.reversed_by_return_grn_id,
  );
  const reversedByRgrnNumber =
    grReversalMeta?.reversedByReturnGrnNumber
    ?? grReversalMeta?.reversed_by_return_grn_number
    ?? '';
  const items = useMemo(() => grDetail?.items || [], [grDetail]);
  const productUomsMap = grDetail?.productUomsMap || {};

  // Determine if GR is linked to a PO (strict discipline applies)
  const isFromPO = !!(selectedGR?.purchaseOrderId || selectedGR?.purchase_order_id);

  const linkedPoStatus =
    grDetail?.gr?.poStatus ??
    grDetail?.gr?.po_status ??
    selectedGR?.poStatus ??
    selectedGR?.po_status;

  const linkedPoManualReceipt = Boolean(
    grDetail?.gr?.poManualReceipt
      ?? grDetail?.gr?.po_manual_receipt
      ?? selectedGR?.poManualReceipt
      ?? selectedGR?.po_manual_receipt,
  );

  const finalizePoCtx = { manualReceipt: linkedPoManualReceipt };

  const canReceiveThisGR =
    selectedGR?.status === 'DRAFT' &&
    poAllowsGoodsReceiptFinalize(linkedPoStatus, finalizePoCtx);

  const isGrReceivable = (gr: GRRow) =>
    gr.status === 'DRAFT' &&
    poAllowsGoodsReceiptFinalize(gr.poStatus ?? gr.po_status, {
      manualReceipt: Boolean(gr.poManualReceipt ?? gr.po_manual_receipt),
    });

  // DRAFT GR from PO with no lines — sync from PO (fixes GRs created before PO lines existed)
  useEffect(() => {
    if (!showDetailsModal || !selectedGR?.id) return;
    if (selectedGR.status !== 'DRAFT' || !isFromPO) return;
    if (grDetailLoading || grDetailFetching) return;
    if (items.length > 0) return;
    if (hydrateAttemptRef.current === selectedGR.id) return;
    hydrateAttemptRef.current = selectedGR.id;

    hydrateFromPOMutation
      .mutateAsync(selectedGR.id)
      .then(() => refetchGRDetail())
      .catch((err: unknown) => {
        handleApiError(err, {
          fallback: 'Could not load purchase order lines into this goods receipt',
        });
      });
  }, [
    showDetailsModal,
    selectedGR?.id,
    selectedGR?.status,
    isFromPO,
    items.length,
    grDetailLoading,
    grDetailFetching,
    hydrateFromPOMutation,
    refetchGRDetail,
  ]);

  useEffect(() => {
    if (!showDetailsModal) hydrateAttemptRef.current = null;
  }, [showDetailsModal]);

  // Receive All Remaining: set every line's receivedQuantity = orderedQuantity
  const handleReceiveAllRemaining = () => {
    if (items.length === 0) return;
    let changed = 0;
    const updates = { ...editItems };
    items.forEach((it: GRItemRow) => {
      const ordered = Number(it.orderedQuantity ?? it.ordered_quantity ?? 0);
      const current = Number(updates[it.id]?.receivedQuantity ?? 0);
      if (current !== ordered) changed++;
      updates[it.id] = {
        ...(updates[it.id] || {}),
        receivedQuantity: ordered,
        receivedUomQty: undefined,
        receivedLooseQty: undefined,
      };
    });
    setEditItems(updates);
    const msg = changed > 0
      ? `✓ ${changed} line${changed > 1 ? 's' : ''} set to ordered qty`
      : '✓ All lines already at ordered qty';
    setReceiveAllFlash(msg);
    setTimeout(() => setReceiveAllFlash(''), 2500);
  };

  // Accounting preview: live DR Inventory (1300) / CR GRNI (2200) totals
  const accountingPreview = useMemo(() => {
    let total = 0;
    items.forEach((it: GRItemRow) => {
      const es = editItems[it.id] || {};
      const qty = Number(es.receivedQuantity ?? it.receivedQuantity ?? it.received_quantity ?? 0);
      const cost = Number(es.unitCost ?? it.unitCost ?? it.unit_cost ?? 0);
      const ordered = Number(it.orderedQuantity ?? it.ordered_quantity ?? 0);
      const poAlready = Number(it.poAlreadyReceived ?? it.po_already_received ?? 0);
      const bonus = !!(es.isBonus ?? it.isBonus ?? it.is_bonus ?? false);
      total += grBillableLineTotal(ordered, poAlready, qty, cost, bonus);
    });
    return total;
  }, [items, editItems]);

  useEffect(() => {
    if (!showDetailsModal || items.length === 0) return;

    setEditItems((prev) => {
      const next = { ...prev };
      let changed = false;

      items.forEach((it: GRItemRow) => {
        const ordered = Number(it.orderedQuantity ?? it.ordered_quantity ?? 0);
        const currentReceived = Number(it.receivedQuantity ?? it.received_quantity ?? 0);
        const shouldAutoFill =
          isFromPO && selectedGR?.status === 'DRAFT' && currentReceived === 0 && ordered > 0;
        const resolvedStoreId = resolveGrLineTargetStoreId(
          it,
          undefined,
          effectiveReceivingStoreId,
        );

        if (!next[it.id]) {
          next[it.id] = {
            batchNumber: it.batchNumber ?? it.batch_number ?? '',
            expiryDate:
              it.expiryDate || it.expiry_date
                ? String(it.expiryDate || it.expiry_date).slice(0, 10)
                : '',
            receivedQuantity: shouldAutoFill ? ordered : currentReceived,
            unitCost: Number(it.unitCost ?? it.unit_cost ?? 0),
            isBonus: !!(it.isBonus ?? it.is_bonus ?? false),
            targetStoreLocationId: resolvedStoreId,
          };
          changed = true;
          return;
        }

        if (
          isMultistoreEnabled &&
          effectiveReceivingStoreId &&
          !next[it.id].targetStoreLocationId &&
          !it.targetStoreLocationId &&
          !it.target_store_location_id
        ) {
          next[it.id] = { ...next[it.id], targetStoreLocationId: effectiveReceivingStoreId };
          changed = true;
        }
      });

      return changed ? next : prev;
    });
  }, [showDetailsModal, items, isFromPO, selectedGR?.status, effectiveReceivingStoreId, isMultistoreEnabled]);

  const handleFinalize = async (id: string) => {
    const validationErrors: string[] = [];
    const zeroLines: string[] = [];

    items.forEach((it: GRItemRow) => {
      const es = editItems[it.id] || {};
      const productName = it.productName || it.product_name || 'Unknown';
      const qty = Number(es.receivedQuantity ?? it.receivedQuantity ?? it.received_quantity ?? 0);
      const expiry = es.expiryDate ?? it.expiryDate ?? it.expiry_date ?? '';
      const trackExpiry = grItemTrackExpiry(it);

      if (!(qty > 0)) {
        zeroLines.push(productName);
        return;
      }
      if (!grLineExpirySatisfied(trackExpiry, qty, expiry)) {
        validationErrors.push(`${productName}: Expiry date is required`);
      }
    });

    // Match server finalizeGR: every line must have received qty > 0
    if (zeroLines.length > 0) {
      alert(
        `Cannot finalize: all lines must have received quantity > 0.\n\nFix: ${zeroLines.join(', ')}\n\nFor partial delivery, remove unreceived lines or set qty after the rest arrive.`,
      );
      return;
    }

    if (validationErrors.length > 0) {
      alert(`Cannot finalize. Please fix the following:\n\n${validationErrors.join('\n')}`);
      return;
    }

    if (
      !confirm(
        'Finalize this goods receipt? This will create inventory batches and update stock levels.'
      )
    ) {
      return;
    }

    try {
      // Collect all pending edits into a single batch payload
      const batchItems: Array<{
        itemId: string;
        receivedQuantity?: number;
        unitCost?: number;
        batchNumber?: string | null;
        isBonus?: boolean;
        uomId?: string | null;
        expiryDate?: string | null;
        targetStoreLocationId?: string | null;
      }> = [];

      for (const item of items as GRItemRow[]) {
        const itemId = item.id;
        const edits = editItems[itemId];
        if (!edits) continue;

        const hasChanges =
          (edits.batchNumber !== undefined &&
            edits.batchNumber !== (item.batchNumber || item.batch_number)) ||
          (edits.expiryDate !== undefined &&
            edits.expiryDate !==
            (item.expiryDate ? String(item.expiryDate).slice(0, 10) : '')) ||
          (edits.receivedQuantity !== undefined &&
            edits.receivedQuantity !== (item.receivedQuantity || item.received_quantity)) ||
          (edits.unitCost !== undefined &&
            edits.unitCost !== (item.unitCost || item.unit_cost)) ||
          (edits.isBonus !== undefined && edits.isBonus !== !!(item.isBonus ?? item.is_bonus)) ||
          (edits.selectedUomId !== undefined &&
            edits.selectedUomId !== (item.uomId || item.uom_id || null)) ||
          (edits.targetStoreLocationId !== undefined &&
            edits.targetStoreLocationId !==
              (item.targetStoreLocationId ?? item.target_store_location_id ?? null));

        if (hasChanges) {
          const entry: typeof batchItems[number] = { itemId };
          if (edits.receivedQuantity !== undefined)
            entry.receivedQuantity = Number(edits.receivedQuantity);
          if (edits.unitCost !== undefined) entry.unitCost = Number(edits.unitCost);
          if (edits.batchNumber !== undefined) entry.batchNumber = edits.batchNumber || null;
          if (edits.expiryDate !== undefined)
            entry.expiryDate = edits.expiryDate
              ? String(edits.expiryDate)
              : null;
          if (edits.isBonus !== undefined) entry.isBonus = !!edits.isBonus;
          if (edits.selectedUomId !== undefined) {
            entry.uomId = edits.selectedUomId || null;
          }
          if (isMultistoreEnabled) {
            entry.targetStoreLocationId = resolveGrLineTargetStoreId(
              item,
              edits.targetStoreLocationId,
              effectiveReceivingStoreId,
            );
          } else if (edits.targetStoreLocationId !== undefined) {
            entry.targetStoreLocationId = edits.targetStoreLocationId || null;
          }
          batchItems.push(entry);
        }
      }

      // Single batch request instead of N parallel PUTs.
      // Skip if GR is already finalized — backend rejects item updates on
      // COMPLETED/FINALIZED GRs ("Cannot update items of a finalized goods
      // receipt"), and there is nothing to save anyway.
      // Prefer fresh status from the detail query over the potentially-stale
      // list-row state (selectedGR) so a retry after a failed bill creation
      // does not hit the backend with stale DRAFT status.
      const freshStatus = (grDetail?.gr?.status || selectedGR?.status || '').toUpperCase();
      const grAlreadyFinalized = isGoodsReceiptPosted(freshStatus);
      if (batchItems.length > 0 && !grAlreadyFinalized) {
        await api.goodsReceipts.batchUpdateItems(id, batchItems);
      }

      // Refresh GR details after saving
      await detailsQuery.refetch();

      const response = await finalizeMutation.mutateAsync(id);

      // Mark selectedGR as COMPLETED immediately so the Finalize button
      // disappears and the stale-status guard fires correctly on any retry.
      setSelectedGR(prev => prev ? { ...prev, status: 'COMPLETED' } : prev);

      // Invalidate stock levels once (not per-item)
      queryClient.invalidateQueries({ queryKey: inventoryKeys.stockLevels() });

      // Check for cost alerts (suppress alerts that are likely pure UoM conversions)
      const alerts = (response.data.alerts as CostAlert[]) || [];
      const filtered = alerts.filter((a) => {
        const prev = parseFloat(a.details.previousCost);
        const next = parseFloat(a.details.newCost);
        if (!isFinite(prev) || prev <= 0 || !isFinite(next) || next <= 0) return true;
        const ratio = next / prev;
        const rounded = Math.round(ratio);
        const isIntegerish = Math.abs(ratio - rounded) < 1e-6;
        // Likely UoM conversion if ratio is a small-ish integer (e.g., pack size 2..200)
        if (isIntegerish && rounded >= 2 && rounded <= 200) {
          return false; // suppress
        }
        return true;
      });
      if (filtered.length > 0) {
        setCostAlerts(filtered);
        setShowAlertsModal(true);
      } else {
        alert('Goods receipt finalized successfully!');
      }

      // ── One-click bill prompt ──────────────────────────────────────────
      // Billable total comes from server PricingEngine SSOT — never computed in UI.
      try {
        const previewRes = await api.get(`/supplier-payments/grns/${id}/billable-total`);
        const preview = previewRes.data?.data as { billableTotal?: number } | undefined;
        const grTotal = Number(preview?.billableTotal ?? 0);
        const grNumber = selectedGR?.grNumber || selectedGR?.receiptNumber || selectedGR?.receipt_number || '';
        const alreadyBilled =
          ((grDetail?.gr as { supplierBillNumber?: string } | undefined)?.supplierBillNumber || '').length > 0;
        const resultPayload = response.data as {
          linkedSiblingBill?: { invoiceNumber: string; grnNumber: string };
        } | undefined;
        const linkedSiblingBill = resultPayload?.linkedSiblingBill;
        const grRow = grDetail?.gr as GRRow | undefined;
        const poSiblingBill =
          grRow?.poSiblingBill ??
          (grRow?.po_sibling_bill
            ? {
                invoiceNumber: grRow.po_sibling_bill.invoice_number,
                grnNumber: grRow.po_sibling_bill.grn_number,
              }
            : undefined);
        const skipBillPrompt = alreadyBilled || !!linkedSiblingBill || !!poSiblingBill;
        const supplierName =
          (grDetail?.gr as { supplierName?: string; supplier_name?: string } | undefined)?.supplierName ||
          (grDetail?.gr as { supplierName?: string; supplier_name?: string } | undefined)?.supplier_name ||
          (selectedGR as { supplierName?: string; supplier_name?: string } | undefined)?.supplierName ||
          (selectedGR as { supplierName?: string; supplier_name?: string } | undefined)?.supplier_name ||
          '';
        if (grTotal > 0 && !skipBillPrompt) {
          // Defaults SSOT: supplier from GR; paper total from draft match check when entered.
          setBillPrompt(
            buildGrnBillPromptDefaults({
              grId: id,
              grNumber,
              computedTotal: grTotal,
              supplierName,
              paperTotalOverride: draftPaperInvoiceTotal,
            }),
          );
          setDraftPaperInvoiceTotal('');
        } else if (linkedSiblingBill) {
          toast.success(
            `Received. Linked to existing bill ${linkedSiblingBill.invoiceNumber} from ${linkedSiblingBill.grnNumber} — no new supplier invoice.`,
            { duration: 8000 },
          );
        }
      } catch {
        // Non-fatal: finalize already succeeded, bill prompt is opportunistic.
      }

      setShowDetailsModal(false);
    } catch (err: unknown) {
      handleApiError(err, { fallback: 'Failed to finalize goods receipt' });
    }
  };

  const handleViewDetails = (gr: GRRow) => {
    setEditItems({});
    setShowPerLineStoreOverride(false);
    setHeaderReceivingStoreId('');
    setDraftPaperInvoiceTotal('');
    setSelectedGR(gr);
    setShowDetailsModal(true);
  };

  const returnLineKey = (item: ReturnableItem) =>
    `${item.productId}_${item.batchId || 'no-batch'}`;

  const getReturnLineUomContext = (item: ReturnableItem, selectedUomId?: string) => {
    const receiptUom = {
      uomId: item.uomId,
      uomName: item.uomName,
      uomSymbol: item.uomSymbol || item.uomName,
      conversionFactor: item.conversionFactor,
    };
    const options = resolveReturnUomOptions(item.availableUoms, receiptUom);
    const selected = findReturnUomOption(options, selectedUomId || item.uomId);
    const baseSymbol = item.baseUomSymbol || selected.uomSymbol;
    return { options, selected, receiptUom, baseSymbol };
  };

  useEffect(() => {
    if (!showReturnModal || returnableItems.length === 0) return;
    setReturnUomIds((prev) => {
      const next = { ...prev };
      for (const item of returnableItems) {
        const key = returnLineKey(item);
        if (!next[key] && item.uomId) {
          next[key] = item.uomId;
        }
      }
      return next;
    });
  }, [showReturnModal, returnableItems]);

  const handleOpenReturnModal = () => {
    if (isGrReversed) {
      toast.error('This receipt is already reversed — return is closed.');
      return;
    }
    setReturnReason('');
    setReturnQuantities({});
    setReturnUomIds({});
    setShowReturnModal(true);
  };

  const handleOpenReverseModal = () => {
    if (isGrReversed) {
      toast.error('This receipt is already reversed.');
      return;
    }
    setReverseReason('');
    setShowReverseModal(true);
  };

  const handleCancelDraft = async (grId: string) => {
    if (
      !window.confirm(
        'Cancel this draft goods receipt? No inventory or ledger entries will be posted.',
      )
    ) {
      return;
    }
    try {
      await cancelGRMutation.mutateAsync(grId);
      toast.success('Draft goods receipt cancelled.');
      setShowDetailsModal(false);
      setSelectedGR(null);
      queryClient.invalidateQueries({ queryKey: ['goods-receipts'] });
    } catch (err) {
      handleApiError(err, { fallback: 'Failed to cancel draft goods receipt' });
    }
  };

  const handleSubmitReverseUninvoiced = async () => {
    if (!selectedGRId || !reverseReason.trim()) {
      toast.error('Reversal reason is required');
      return;
    }
    setReverseSubmitting(true);
    try {
      const res = await api.goodsReceipts.reverseUninvoiced(selectedGRId, {
        reason: reverseReason.trim(),
      });
      const payload = (res.data as {
        data?: {
          returnGrn?: { returnGrnNumber?: string };
          cancelledBills?: Array<{ invoiceNumber?: string }>;
        };
      })?.data;
      const rgrnNum = payload?.returnGrn?.returnGrnNumber ?? 'Return GRN';
      const billCount = payload?.cancelledBills?.length ?? 0;
      toast.success(
        billCount > 0
          ? `Receipt reversed via ${rgrnNum}. ${billCount} bill(s) cancelled. PO returned to Draft.`
          : `Receipt reversed via ${rgrnNum}. PO returned to Draft.`,
      );
      setShowReverseModal(false);
      queryClient.invalidateQueries({ queryKey: ['goods-receipts'] });
      queryClient.invalidateQueries({ queryKey: ['gr-reverse-eligibility', selectedGRId] });
      queryClient.invalidateQueries({ queryKey: ['return-grn'] });
      queryClient.invalidateQueries({ queryKey: ['goods-receipt', selectedGRId] });
      queryClient.invalidateQueries({ queryKey: ['purchase-orders'] });
      queryClient.invalidateQueries({ queryKey: ['supplier-invoices'] });
    } catch (err) {
      handleApiError(err, { fallback: 'Failed to reverse receipt' });
    } finally {
      setReverseSubmitting(false);
    }
  };

  const handleSubmitReturn = async () => {
    if (!selectedGR) return;
    const lines = returnableItems
      .filter((item) => {
        const key = returnLineKey(item);
        return (returnQuantities[key] || 0) > 0;
      })
      .map((item) => {
        const key = returnLineKey(item);
        const { selected } = getReturnLineUomContext(item, returnUomIds[key]);
        return {
          productId: item.productId,
          batchId: item.batchId || undefined,
          uomId: selected.uomId || item.uomId || undefined,
          quantity: returnQuantities[key],
          unitCost: Number(item.unitCost) || 0,
        };
      });

    if (lines.length === 0) {
      toast.error('Please enter quantities for at least one item to return.');
      return;
    }

    if (!returnReason.trim()) {
      toast.error('Please provide a reason for the return.');
      return;
    }

    setReturnSubmitting(true);
    try {
      // Create the return GRN (DRAFT)
      const createResp = await createReturnGrnMutation.mutateAsync({
        grnId: selectedGR.id,
        reason: returnReason.trim(),
        lines,
      });

      const respData = (createResp as { data?: { success?: boolean; data?: { returnGrn?: { id: string } } } })?.data;
      const rgrnId = respData?.data?.returnGrn?.id;
      if (!rgrnId) throw new Error('Failed to create Return GRN');

      // Post it immediately (stock reduction)
      await postReturnGrnMutation.mutateAsync(rgrnId);

      const billNum =
        (grDetail?.gr as { supplierBillNumber?: string } | undefined)?.supplierBillNumber || '';
      if (billNum) {
        toast.success(
          `Return posted. Next: Create Credit Note on the return badge (bill ${billNum}).`,
          { duration: 7000 },
        );
      } else {
        // Uninvoiced return SSOT: no AP → no SCN. Never tell operators to bill first.
        toast.success(
          'Return posted. No supplier bill on this receipt — credit note not required (stock + GR/IR cleared).',
          { duration: 7000 },
        );
      }
      setShowReturnModal(false);
      setShowDetailsModal(false);
    } catch (err: unknown) {
      handleApiError(err, { fallback: 'Failed to process return to supplier' });
    } finally {
      setReturnSubmitting(false);
    }
  };

  const handleItemFieldChange = (
    itemId: string,
    field: string,
    value: string | number | boolean | undefined
  ) => {
    setEditItems((prev) => ({
      ...prev,
      [itemId]: {
        ...(prev[itemId] || {}),
        [field]: value,
      } as EditItemState,
    }));
  };

  const openCreateModal = () => {
    setPoSearch('');
    setSelectedPoId('');
    setPoPage(1);
    setShowCreateModal(true);
    // Refetch pending POs to ensure fresh data
    pendingPOsQuery.refetch();
  };

  const handleCreateGR = async () => {
    if (!user?.id) {
      alert('You must be logged in to create a goods receipt.');
      return;
    }
    const poId = selectedPoId.trim();
    if (!poId) {
      alert('Select a Purchase Order');
      return;
    }
    try {
      // Fetch PO to build items
      const poRes = await api.purchaseOrders.getById(poId);
      const poData = poRes.data?.data as POData | undefined;
      if (!poData?.po || !poData?.items) {
        throw new Error('Purchase order not found');
      }
      const lines = poData.items
        .flatMap((it: POItemData) => {
          const rawUnit = Number(it.unit_price ?? it.unitCost ?? 0);
          const openQty = Number(
            it.open_quantity ?? it.openQuantity ?? it.ordered_quantity ?? it.quantity ?? 0,
          );
          if (openQty <= 0) return [];
          return [{
            poItemId: it.id,
            productId: it.product_id || it.productId || '',
            productName: it.product_name || it.productName,
            orderedQuantity: Number(it.ordered_quantity ?? it.quantity ?? 0),
            receivedQuantity: 0,
            unitCost: rawUnit,
            batchNumber: null,
            expiryDate: null,
            uomId: it.uom_id || it.uomId || null,
          }];
        });

      if (lines.length === 0) {
        throw new Error('This purchase order has no open quantity left to receive.');
      }

      const payload = {
        purchaseOrderId: poData.po.id,
        receiptDate: getBusinessDate(),
        notes: null,
        receivedBy: user.id,
        items: lines,
      };
      console.log(
        '🚀 [Frontend] Creating GR from PO with payload:',
        JSON.stringify(payload, null, 2)
      );
      console.log('🔍 [Frontend] User object:', user);
      console.log('🔍 [Frontend] PO Data:', poData);
      await createGRMutation.mutateAsync(payload);

      // Reset modal state after successful creation
      setShowCreateModal(false);
      setSelectedPoId('');
      setPoSearch('');
      setPoPage(1);
      setFocusedPoIndex(0);
    } catch (e: unknown) {
      handleApiError(e, { fallback: 'Failed to create goods receipt' });
    }
  };

  // Pending POs query and client-side filter
  const pendingPOsQuery = useQuery({
    queryKey: ['purchase-orders', 'pending', poPage],
    queryFn: () => api.purchaseOrders.list({ status: 'PENDING', page: poPage, limit: 20 }),
  });
  const pendingPOs = (pendingPOsQuery.data?.data?.data || []) as PORow[];
  const poPagination = pendingPOsQuery.data?.data?.pagination;
  const filteredPOs = useMemo(() => {
    const q = poSearch.trim().toLowerCase();
    if (!q) return pendingPOs;
    return pendingPOs.filter((po: PORow) => {
      const num = (po.order_number || po.poNumber || '').toString().toLowerCase();
      const supplier = (po.supplier_name || po.supplierName || '').toString().toLowerCase();
      return num.includes(q) || supplier.includes(q);
    });
  }, [poSearch, pendingPOs]);

  // Ensure refs length matches list length
  useEffect(() => {
    poRadioRefs.current = poRadioRefs.current.slice(0, filteredPOs.length);
  }, [filteredPOs.length]);

  // Fetch quick-view details (items count) lazily and cache per PO id
  const ensurePoQuickView = async (poId: string) => {
    if (!poId || poQuickView[poId]) return;
    try {
      const res = await api.purchaseOrders.getById(poId);
      const poDetail = res.data?.data as { items?: unknown[] } | undefined;
      const items = poDetail?.items || [];
      setPoQuickView((prev) => ({ ...prev, [poId]: { itemsCount: items.length } }));
    } catch {
      // ignore failures for quick-view
    }
  };

  const goodsReceipts = (data?.data?.data || []) as GRRow[];
  const pagination = data?.data?.pagination;

  const handleColumnSort = (field: string) => {
    const f = field as GRSortField;
    if (f === 'invoiceStatus') {
      setBillingFilter('TO_INVOICE');
      setPage(1);
    }
    baseColumnSort(field);
  };

  const mobileSortOptions = [
    { value: 'grNumber', label: 'Sort by GR Number' },
    { value: 'poNumber', label: 'Sort by PO Number' },
    { value: 'supplier', label: 'Sort by Supplier' },
    { value: 'receivedDate', label: 'Sort by Received Date' },
    { value: 'receiptStatus', label: 'Sort by Receipt Status' },
    { value: 'invoiceStatus', label: 'Sort by Invoice Status' },
  ];

  // Server returns sorted/filtered slice — no client-side re-sort on current page
  const displayGoodsReceipts = goodsReceipts;

  /** Only show count when that lane filter is active (server total) — never page-slice fake totals. */
  const activeBillingTotal =
    billingFilter && pagination?.total != null ? Number(pagination.total) : null;

  const renderGrActions = (gr: GRRow, layout: 'row' | 'stack' = 'row') => {
    const canFinalize = isGrReceivable(gr) && canFinalizeGR;

    if (layout === 'stack') {
      // Phone card: tap opens detail — never a boxed View chip.
      // Only surface Finalize (text link) when the GR is receivable.
      if (!canFinalize) return null;
      return (
        <div data-gr-card-actions="true">
          <AdaptiveRowActions
            presentationOverride="inline"
            actions={[
              {
                id: 'finalize',
                label: 'Finalize',
                onClick: () => handleFinalize(gr.id),
                tone: 'warning',
                appearance: 'link',
              },
            ]}
          />
        </div>
      );
    }

    return (
      <div className="flex flex-row flex-wrap gap-2">
        <AdaptiveRowActions
          presentationOverride="inline"
          actions={[
            {
              id: 'view',
              label: 'View details',
              onClick: () => handleViewDetails(gr),
              tone: 'primary',
              appearance: 'link',
            },
            ...(canFinalize
              ? [
                  {
                    id: 'finalize',
                    label: 'Finalize',
                    onClick: () => handleFinalize(gr.id),
                    tone: 'warning' as const,
                    appearance: 'link' as const,
                  },
                ]
              : []),
          ]}
        />
      </div>
    );
  };

  return (
    <div data-gr-receiving-page="true">
      <AdaptivePage
        className={ADAPTIVE_PAGE_PAD_CLASS}
        hideTitle={embedded}
        title={embedded ? undefined : 'Goods Receipts'}
        description={
          embedded
            ? undefined
            : 'Receiving workflow with batch creation and cost change alerts'
        }
        densityOverride={ADAPTIVE_WORKLIST_DENSITY}
        toolbarInline={!embedded}
        toolbar={
          <div className={ADAPTIVE_TOOLBAR_CARD_CLASS} data-gr-filters="true">
            <AdaptiveToolbar
              modeOverride="compact"
              actionsBeforeLeading
              leading={
                <AdaptiveSearch
                  value={searchTerm}
                  onChange={setSearchTerm}
                  placeholder="GRN, PO number, supplier..."
                  label="Search goods receipts"
                  presentationOverride="compact"
                />
              }
              facets={
                <AdaptiveFacetChips
                  aria-label="Billing status"
                  items={[
                    {
                      id: 'all',
                      label: 'All billing',
                      tone: 'neutral',
                      active: billingFilter === '',
                      onSelect: () => {
                        setBillingFilter('');
                        setPage(1);
                      },
                    },
                    {
                      id: 'to-invoice',
                      label:
                        billingFilter === 'TO_INVOICE' && activeBillingTotal != null
                          ? `To invoice (${activeBillingTotal})`
                          : 'To invoice',
                      tone: 'amber',
                      active: billingFilter === 'TO_INVOICE',
                      onSelect: () => {
                        setBillingFilter('TO_INVOICE');
                        setPage(1);
                      },
                    },
                    {
                      id: 'invoiced',
                      label:
                        billingFilter === 'INVOICED' && activeBillingTotal != null
                          ? `Invoiced (${activeBillingTotal})`
                          : 'Invoiced',
                      tone: 'emerald',
                      active: billingFilter === 'INVOICED',
                      onSelect: () => {
                        setBillingFilter('INVOICED');
                        setPage(1);
                      },
                    },
                    {
                      id: 'reversed',
                      label:
                        billingFilter === 'REVERSED' && activeBillingTotal != null
                          ? `Reversed (${activeBillingTotal})`
                          : 'Reversed',
                      tone: 'slate',
                      active: billingFilter === 'REVERSED',
                      onSelect: () => {
                        setBillingFilter('REVERSED');
                        setPage(1);
                      },
                    },
                  ]}
                />
              }
              secondaryLabel="Filters"
              secondary={({ close }) => (
                <AdaptiveFilterPanel
                  panelKey="gr"
                  data-gr-filter-panel="true"
                  footer={
                    <AdaptiveFilterDoneButton
                      onClick={() => close()}
                      data-gr-filters-done="true"
                    >
                      Done
                    </AdaptiveFilterDoneButton>
                  }
                >
                  <AdaptiveFilterField label="Date range" htmlFor="grn-date-preset">
                    <select
                      id="grn-date-preset"
                      value={dateRangePreset}
                      onChange={(e) => {
                        const preset = e.target.value as DateRangePreset;
                        setDateRangePreset(preset);
                        const range = getDateRange(preset);
                        setStartDate(range.start);
                        setEndDate(range.end);
                        setPage(1);
                        if (preset !== 'custom') close();
                      }}
                      className={adaptiveFilterControlClass}
                    >
                      <option value="all">All dates</option>
                      <option value="today">Today</option>
                      <option value="yesterday">Yesterday</option>
                      <option value="this_week">This week</option>
                      <option value="last_week">Last week</option>
                      <option value="this_month">This month</option>
                      <option value="last_month">Last month</option>
                      <option value="custom">Custom range</option>
                    </select>
                  </AdaptiveFilterField>
                  <AdaptiveFilterField label="Status" htmlFor="status-filter">
                    <select
                      id="status-filter"
                      value={statusFilter}
                      onChange={(e) => {
                        setStatusFilter(e.target.value);
                        setPage(1);
                        close();
                      }}
                      className={adaptiveFilterControlClass}
                    >
                      <option value="">All statuses</option>
                      <option value="DRAFT">Draft</option>
                      <option value="COMPLETED">Completed</option>
                      <option value="CANCELLED">Cancelled</option>
                    </select>
                  </AdaptiveFilterField>
                  {dateRangePreset === 'custom' ? (
                    <>
                      <AdaptiveFilterField label="Start">
                        <DatePicker
                          value={startDate}
                          onChange={(date) => {
                            setStartDate(date);
                            setDateRangePreset('custom');
                            setPage(1);
                          }}
                          placeholder="Start date"
                          maxDate={endDate ? new Date(endDate) : undefined}
                        />
                      </AdaptiveFilterField>
                      <AdaptiveFilterField label="End">
                        <DatePicker
                          value={endDate}
                          onChange={(date) => {
                            setEndDate(date);
                            setDateRangePreset('custom');
                            setPage(1);
                          }}
                          placeholder="End date"
                          minDate={startDate ? new Date(startDate) : undefined}
                        />
                      </AdaptiveFilterField>
                    </>
                  ) : null}
                  <AdaptiveFilterField label="Cost baseline" htmlFor="gr-cost-baseline" span={2}>
                    <div data-gr-cost-baseline="true">
                      <select
                        id="gr-cost-baseline"
                        aria-label="Cost variance baseline"
                        title="Cost variance baseline"
                        className={adaptiveFilterControlClass}
                        value={baseline}
                        onChange={(e) => setBaseline(e.target.value as 'PO' | 'PRODUCT')}
                      >
                        <option value="PO">PO cost</option>
                        <option value="PRODUCT">Product cost</option>
                      </select>
                    </div>
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
              {canCreateGR ? (
                <>
                  <div className="shrink-0" data-gr-manual-cta="true">
                    <ManualGRButton />
                  </div>
                  <button
                    type="button"
                    onClick={openCreateModal}
                    aria-label="Create goods receipt from purchase order"
                    className="inline-flex shrink-0 items-center justify-center rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 min-h-[var(--layout-touch-target)]"
                    data-gr-create-from-po="true"
                  >
                    <span className="hidden md:inline">+ From PO</span>
                    <span className="inline md:hidden">+ PO</span>
                  </button>
                </>
              ) : null}
            </AdaptiveToolbar>
          </div>
        }
      >
      {/* Filters + billing facets live in AdaptiveToolbar */}

      {/* Loading State */}
      {isLoading && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-100">
          <ListSkeleton rows={6} />
        </div>
      )}

      {/* Error State */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
          <p className="text-red-800">Failed to load goods receipts</p>
        </div>
      )}

      {/* Goods Receipts Table */}
      {!isLoading && !error && (
        <div className="bg-white rounded-lg shadow-sm overflow-hidden border border-gray-100">
          <p className="hidden lg:block px-4 lg:px-6 pt-3 text-xs text-gray-500 leading-relaxed">
            <span className="font-medium text-gray-600">Receipt status</span> = physical receipt.
            {' '}<span className="font-medium text-gray-600">Supplier invoice</span> = billed in AP.
          </p>
          {/* Mobile card list */}
          <div className="md:hidden divide-y divide-gray-100">
            {displayGoodsReceipts.length === 0 ? (
              <p className="px-4 py-12 text-center text-gray-500 text-sm">No goods receipts found</p>
            ) : (
              displayGoodsReceipts.map((gr: GRRow) => {
                const cardActions = renderGrActions(gr, 'stack');
                return (
                <MobileListCard key={gr.id} className="gap-1.5">
                  <div
                    role="button"
                    tabIndex={0}
                    data-gr-card-open="true"
                    className="min-w-0 cursor-pointer rounded-md outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                    onClick={() => handleViewDetails(gr)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        handleViewDetails(gr);
                      }
                    }}
                  >
                    <div className="flex items-start justify-between gap-2 min-w-0">
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold text-gray-900 truncate">
                          {gr.grNumber || gr.receiptNumber || gr.receipt_number}
                        </p>
                        <p className="text-sm text-gray-600 truncate">{gr.supplierName || gr.supplier_name || '—'}</p>
                        <p className="text-xs text-gray-500 mt-0.5">
                          PO {gr.poNumber || gr.po_number || '—'} · {formatDisplayDate(gr.receivedDate || gr.received_date)}
                        </p>
                      </div>
                      <div className="shrink-0 flex flex-col items-end gap-1">
                        <GrReceiptStatusBadge
                          status={gr.status}
                          isReversed={gr.isReversed ?? gr.is_reversed}
                        />
                      </div>
                    </div>
                    <div className="mt-1.5 min-w-0">
                      <GrBillingStatusBadge
                        variant="card"
                        receiptStatus={gr.status}
                        billingStatus={gr.billingStatus || gr.billing_status}
                        supplierBillNumber={gr.supplierBillNumber || gr.supplier_bill_number}
                        isReversed={gr.isReversed ?? gr.is_reversed}
                      />
                    </div>
                  </div>
                  {cardActions ? (
                    <div className="flex justify-end">{cardActions}</div>
                  ) : null}
                </MobileListCard>
                );
              })
            )}
          </div>

          {/* Desktop table */}
          <div className="hidden md:block">
          {billingFilter === 'TO_INVOICE' && sortField === 'invoiceStatus' && (
            <div className="px-4 lg:px-6 py-2 bg-amber-50 border-b border-amber-100 text-xs text-amber-900 flex items-center justify-between">
              <span>Showing receipts to invoice ({pagination?.total ?? displayGoodsReceipts.length} total)</span>
              <button
                type="button"
                className="text-amber-800 underline"
                onClick={() => {
                  setBillingFilter('');
                  setPage(1);
                  baseColumnSort('receivedDate');
                }}
              >
                Clear filter
              </button>
            </div>
          )}
          <ResponsiveTableWrapper>
            <table className={INVENTORY_WORKLIST_TABLE_CLASS} data-inventory-worklist-table="true">
              <thead className="bg-gray-50">
                <tr>
                  {showCol('grNumber') ? (
                    <SortableTableHeader label="GR Number" field="grNumber" activeField={sortField} direction={sortOrder} onSort={handleColumnSort} className={`px-4 lg:px-6 ${INVENTORY_COL_FILL_CLASS}`} />
                  ) : null}
                  {showCol('poNumber') ? (
                    <SortableTableHeader label="PO Number" field="poNumber" activeField={sortField} direction={sortOrder} onSort={handleColumnSort} className={`px-4 lg:px-6 ${INVENTORY_COL_FIT_CLASS}`} />
                  ) : null}
                  {showCol('supplier') ? (
                    <SortableTableHeader label="Supplier" field="supplier" activeField={sortField} direction={sortOrder} onSort={handleColumnSort} className={`px-4 lg:px-6 ${INVENTORY_COL_FIT_CLASS}`} />
                  ) : null}
                  {showCol('receivedDate') ? (
                    <SortableTableHeader label="Received Date" field="receivedDate" activeField={sortField} direction={sortOrder} onSort={handleColumnSort} className={`px-4 lg:px-6 ${INVENTORY_COL_FIT_CLASS}`} />
                  ) : null}
                  {showCol('receiptStatus') ? (
                    <SortableTableHeader label="Receipt" field="receiptStatus" activeField={sortField} direction={sortOrder} onSort={handleColumnSort} className={`px-4 lg:px-6 ${INVENTORY_COL_FIT_CLASS}`} />
                  ) : null}
                  {showCol('invoiceStatus') ? (
                    <SortableTableHeader label="Invoice" field="invoiceStatus" activeField={sortField} direction={sortOrder} onSort={handleColumnSort} className={`px-4 lg:px-6 ${INVENTORY_COL_FIT_CLASS}`} filtered={billingFilter === 'TO_INVOICE' && sortField === 'invoiceStatus'} />
                  ) : null}
                  {showCol('actions') ? (
                    <th className={`px-4 lg:px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider ${INVENTORY_COL_FIT_CLASS}`}>
                      Actions
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {displayGoodsReceipts.length === 0 ? (
                  <tr>
                    <td colSpan={columnPrefs.visibleCount} className="px-6 py-12 text-center text-gray-500">
                      No goods receipts found
                    </td>
                  </tr>
                ) : (
                  displayGoodsReceipts.map((gr: GRRow) => (
                    <tr key={gr.id} className="hover:bg-gray-50/80 transition-colors">
                      {showCol('grNumber') ? (
                        <td className={`px-4 lg:px-6 py-3 text-sm font-medium text-gray-900 ${INVENTORY_COL_FILL_CLASS}`}>
                          <div className="truncate min-w-0">
                            {gr.grNumber || gr.receiptNumber || gr.receipt_number}
                          </div>
                        </td>
                      ) : null}
                      {showCol('poNumber') ? (
                        <td className={`px-4 lg:px-6 py-3 text-sm text-gray-900 ${INVENTORY_COL_FIT_CLASS}`}>
                          {gr.poNumber || gr.po_number || '-'}
                        </td>
                      ) : null}
                      {showCol('supplier') ? (
                        <td className={`px-4 lg:px-6 py-3 text-sm text-gray-900 ${INVENTORY_COL_FIT_CLASS}`}>
                          {gr.supplierName || gr.supplier_name || '-'}
                        </td>
                      ) : null}
                      {showCol('receivedDate') ? (
                        <td className={`px-4 lg:px-6 py-3 text-sm text-gray-500 ${INVENTORY_COL_FIT_CLASS}`}>
                          {formatDisplayDate(gr.receivedDate || gr.received_date)}
                        </td>
                      ) : null}
                      {showCol('receiptStatus') ? (
                        <td className={`px-4 lg:px-6 py-3 ${INVENTORY_COL_FIT_CLASS}`}>
                          <GrReceiptStatusBadge
                            status={gr.status}
                            isReversed={gr.isReversed ?? gr.is_reversed}
                          />
                        </td>
                      ) : null}
                      {showCol('invoiceStatus') ? (
                        <td className={`px-4 lg:px-6 py-3 ${INVENTORY_COL_FIT_CLASS}`}>
                          <GrBillingStatusBadge
                            receiptStatus={gr.status}
                            billingStatus={gr.billingStatus || gr.billing_status}
                            supplierBillNumber={gr.supplierBillNumber || gr.supplier_bill_number}
                            isReversed={gr.isReversed ?? gr.is_reversed}
                          />
                        </td>
                      ) : null}
                      {showCol('actions') ? (
                        <td className={`px-4 lg:px-6 py-3 text-sm ${INVENTORY_COL_FIT_CLASS}`}>
                          {renderGrActions(gr)}
                        </td>
                      ) : null}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </ResponsiveTableWrapper>
          </div>

          {/* Pagination */}
          {pagination && pagination.totalPages > 1 && (
            <div className="bg-gray-50 px-4 sm:px-6 py-4 flex flex-col sm:flex-row items-center justify-between gap-3 border-t border-gray-200">
              <div className="text-sm text-gray-700">
                Page {pagination.page} of {pagination.totalPages} ({pagination.total} total)
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setPage(Math.max(1, page - 1))}
                  disabled={page === 1}
                  className="px-4 py-2 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Previous
                </button>
                <button
                  onClick={() => setPage(Math.min(pagination.totalPages, page + 1))}
                  disabled={page === pagination.totalPages}
                  className="px-4 py-2 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      </AdaptivePage>

      {/* Details workspace */}
      {showDetailsModal && selectedGR && (
        <SlideDrawer
          open
          onClose={() => setShowDetailsModal(false)}
          title={selectedGR.grNumber || selectedGR.receiptNumber || selectedGR.receipt_number || 'Goods Receipt'}
          subtitle={`PO: ${selectedGR.poNumber || selectedGR.po_number} · ${selectedGR.supplierName || selectedGR.supplier_name}`}
          width="full"
          transactional
          guardLabel="Goods receipt details"
        >
              <div data-gr-detail-meta="true">
                <AdaptiveMetaGrid className="mb-4">
                  <AdaptiveMetaItem label="Received Date">
                    {formatDisplayDate(selectedGR.receivedDate || selectedGR.received_date)}
                  </AdaptiveMetaItem>
                  <AdaptiveMetaItem label="Status">
                    <GrReceiptStatusBadge status={selectedGR.status} isReversed={isGrReversed} />
                  </AdaptiveMetaItem>
                  <AdaptiveMetaItem label="Received By">
                    {selectedGR.receivedByName || selectedGR.received_by_name || '-'}
                  </AdaptiveMetaItem>
                  <AdaptiveMetaItem label="Delivery Note">
                    {selectedGR.supplierDeliveryNote || selectedGR.supplier_delivery_note || '-'}
                  </AdaptiveMetaItem>
                </AdaptiveMetaGrid>
              </div>

              {selectedGR.notes && (
                <div className="mb-6">
                  <label className="text-sm font-medium text-gray-700">Notes</label>
                  <p className="text-gray-900 mt-1">{selectedGR.notes}</p>
                </div>
              )}

              {showMultistoreGrUi && (
                <div className="mb-6 p-4 bg-blue-50 border border-blue-200 rounded-lg">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="flex-1 min-w-[240px]">
                      <label
                        htmlFor="gr-destination-store"
                        className="text-sm font-semibold text-gray-900"
                      >
                        Destination store
                      </label>
                      <p className="text-xs text-gray-600 mt-0.5 mb-2">
                        Choose where received stock is posted when you finalize. Defaults to your
                        main receiving warehouse.
                      </p>
                      {selectedGR.status === 'DRAFT' ? (
                        <StoreLocationSelect
                          id="gr-destination-store"
                          stores={grDestinationStores}
                          value={effectiveReceivingStoreId}
                          onChange={(storeId) => {
                            setHeaderReceivingStoreId(storeId);
                            writeGrReceivingStoreId(user?.id, storeId);
                          }}
                          disabled={grDestinationStores.length === 0}
                          triggerClassName="h-10 min-w-[220px] text-sm bg-white"
                        />
                      ) : (
                        <p className="text-gray-900 font-semibold">
                          {resolveStoreLabel(grStoreLabelMap, effectiveReceivingStoreId)}
                        </p>
                      )}
                    </div>
                    {selectedGR.status === 'DRAFT' && (
                      <label className="flex items-center gap-2 text-xs text-gray-700 cursor-pointer pt-1">
                        <input
                          type="checkbox"
                          checked={showPerLineStoreOverride}
                          onChange={(e) => setShowPerLineStoreOverride(e.target.checked)}
                          className="rounded border-gray-300"
                        />
                        Different destination per line
                      </label>
                    )}
                  </div>
                </div>
              )}

              {/* Items Table */}
              <div className="mb-6">
                <div className="flex flex-col gap-2 mb-2 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <h4 className="text-lg font-semibold text-gray-900">Items</h4>
                    {selectedGR.status === 'DRAFT' && (
                      <p className="text-xs text-gray-500 mt-0.5">
                        <kbd className="px-1 py-0.5 bg-gray-100 border rounded text-[10px] font-mono">Enter</kbd> moves: Received → Batch → Expiry → next row
                        {isFromPO && <span className="ml-2 text-green-600">● green = complete</span>}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-col gap-2 w-full sm:w-auto sm:flex-row sm:flex-wrap sm:items-center sm:justify-end">
                    {selectedGR.status === 'DRAFT' && isFromPO && (
                      <div className="flex items-center gap-2">
                        <button
                          onClick={handleReceiveAllRemaining}
                          disabled={items.length === 0}
                          className="px-3 py-1.5 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 text-sm font-medium flex items-center gap-1.5"
                          title="Set all lines to ordered quantity"
                        >
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                          Receive All Remaining
                        </button>
                        {receiveAllFlash && (
                          <span className="text-xs font-medium text-green-600 animate-pulse">{receiveAllFlash}</span>
                        )}
                      </div>
                    )}
                    {(detailsQuery.isLoading || hydrateFromPOMutation.isPending) && (
                      <span className="text-sm text-gray-500">
                        {hydrateFromPOMutation.isPending ? 'Loading lines from purchase order…' : 'Loading items…'}
                      </span>
                    )}
                    {selectedGR.status === 'DRAFT' && isFromPO && items.length === 0 && !detailsQuery.isLoading && !hydrateFromPOMutation.isPending && (
                      <button
                        type="button"
                        onClick={() => {
                          if (!selectedGR?.id) return;
                          hydrateFromPOMutation.mutate(selectedGR.id, {
                            onSuccess: () => detailsQuery.refetch(),
                            onError: (err: Error) =>
                              handleApiError(err, {
                                fallback: 'Could not load purchase order lines into this goods receipt',
                              }),
                          });
                        }}
                        className="px-3 py-1.5 text-sm border border-indigo-300 text-indigo-800 rounded-lg hover:bg-indigo-50"
                      >
                        Load from PO
                      </button>
                    )}
                    {selectedGR.status === 'DRAFT' && !isFromPO && (
                      <button
                        onClick={() => setShowAddItemForm(true)}
                        className="px-3 py-1.5 bg-green-600 text-white rounded-lg hover:bg-green-700 text-sm font-medium flex items-center gap-1.5"
                        title="Add a new item to this goods receipt"
                      >
                        + Add Item
                      </button>
                    )}
                  </div>
                </div>

                {/* Inline Add Item Form */}
                {showAddItemForm && selectedGR.status === 'DRAFT' && (
                  <AddGRItemForm
                    grId={selectedGR.id}
                    supplierId={
                      (grDetail?.gr?.supplierId as string) ||
                      selectedGR.supplierId ||
                      selectedGR.supplier_id ||
                      ''
                    }
                    addMutation={addGRItemMutation}
                    onClose={() => setShowAddItemForm(false)}
                    onSuccess={() => {
                      setShowAddItemForm(false);
                      detailsQuery.refetch();
                    }}
                  />
                )}

                <div className="overflow-x-auto border rounded-lg">
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Product
                        </th>
                        <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          UoM
                        </th>
                        <th className="px-4 py-2 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Ordered
                        </th>
                        <th className="px-4 py-2 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Received
                        </th>
                        <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Unit Cost
                        </th>
                        <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Batch # / Expiry
                        </th>
                        {showMultistoreGrUi && showPerLineStoreOverride && (
                          <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Destination Store
                          </th>
                        )}
                        <th
                          className="px-4 py-2 text-center text-xs font-medium text-gray-500 uppercase tracking-wider"
                          title="Bonus stock from supplier (zero cost)"
                        >
                          Bonus
                        </th>
                        <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Variance
                        </th>
                        {selectedGR.status === 'DRAFT' && !isFromPO && (
                          <th className="px-2 py-2 text-center text-xs font-medium text-gray-500 uppercase tracking-wider w-12">
                          </th>
                        )}
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                      {items.length === 0 ? (
                        <tr>
                          <td className="px-4 py-6 text-center text-gray-500" colSpan={showMultistoreGrUi && showPerLineStoreOverride ? 9 : 8}>
                            No items
                          </td>
                        </tr>
                      ) : (
                        items.map((it: GRItemRow, idx: number) => (
                          <GRItemRow
                            key={it.id}
                            item={it}
                            baseline={baseline}
                            selectedGR={selectedGR}
                            editState={editItems[it.id] || {}}
                            onFieldChange={handleItemFieldChange}
                            batchWarnings={batchWarnings}
                            validationTimeout={validationTimeout}
                            checkBatchDuplicate={checkBatchDuplicate}
                            isFromPO={isFromPO}
                            itemIndex={idx}
                            totalItems={items.length}
                            bundledUoms={productUomsMap[it.productId || it.product_id || ''] || []}
                            destinationStores={grDestinationStores}
                            storeLabelMap={grStoreLabelMap}
                            defaultStoreId={effectiveReceivingStoreId}
                            showStoreColumn={showMultistoreGrUi && showPerLineStoreOverride}
                            onRemove={selectedGR.status === 'DRAFT' && !isFromPO && items.length > 1 ? (itemId: string) => {
                              if (!confirm('Remove this item from the goods receipt?')) return;
                              removeGRItemMutation.mutate({ grId: selectedGR.id, itemId }, {
                                onSuccess: () => detailsQuery.refetch(),
                                onError: (err: Error) => alert(err.message || 'Failed to remove item'),
                              });
                            } : undefined}
                          />
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Accounting Preview Panel */}
              {isFromPO && items.length > 0 && (
                <div className="mb-6 bg-slate-50 border border-slate-200 rounded-lg p-4">
                  <h5 className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-2">
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z" /></svg>
                    {isGrReversed
                      ? 'Originally posted (now reversed — net zero)'
                      : isGoodsReceiptPosted(selectedGR.status)
                        ? 'This receipt posted'
                        : 'This receipt will post'}
                  </h5>
                  {isGrReversed ? (
                    <p className="text-sm text-slate-600 mb-3">
                      Inventory and GR/IR were unwound by the counter-document
                      {reversedByRgrnNumber ? ` (${reversedByRgrnNumber})` : ''}. Amounts below are historical only.
                    </p>
                  ) : null}
                  <div
                    className={`grid grid-cols-1 min-[480px]:grid-cols-2 gap-2 ${isGrReversed ? 'opacity-60' : ''}`}
                    data-gr-gl-preview="true"
                  >
                    <div className="flex flex-col gap-1 bg-white rounded-md px-3 py-2.5 border min-w-0">
                      <div className="text-xs text-slate-500 truncate">
                        <span className="font-semibold text-slate-600">DR</span>
                        {' '}Inventory (1300)
                      </div>
                      <span className="text-base sm:text-sm font-bold text-green-700 tabular-nums">
                        {formatCurrency(accountingPreview)}
                      </span>
                    </div>
                    <div className="flex flex-col gap-1 bg-white rounded-md px-3 py-2.5 border min-w-0">
                      <div className="text-xs text-slate-500 truncate" title="Goods Received Not Invoiced (2200)">
                        <span className="font-semibold text-slate-600">CR</span>
                        {' '}GRNI (2200)
                      </div>
                      <span className="text-base sm:text-sm font-bold text-red-700 tabular-nums">
                        {formatCurrency(accountingPreview)}
                      </span>
                    </div>
                  </div>

                  {/* Paper vs GR match — visibility only; does not change stock posting */}
                  {selectedGR.status === 'DRAFT' && accountingPreview > 0 && (() => {
                    const match = resolveGrnBillPromptVariance(
                      accountingPreview,
                      draftPaperInvoiceTotal,
                    );
                    return (
                      <div className="mt-3 pt-3 border-t border-slate-200 space-y-2">
                        <div className="flex flex-wrap items-end gap-3">
                          <div className="flex-1 min-w-[10rem]">
                            <label className="block text-xs font-medium text-slate-600 mb-1">
                              Supplier invoice (paper)
                            </label>
                            <input
                              type="number"
                              step="1"
                              min="0"
                              className="w-full px-2.5 py-1.5 border border-slate-300 rounded-lg text-sm bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                              value={draftPaperInvoiceTotal}
                              onChange={(e) => setDraftPaperInvoiceTotal(e.target.value)}
                              placeholder={formatCurrency(accountingPreview)}
                            />
                          </div>
                          <div className="text-right pb-1.5">
                            <div className="text-xs text-slate-500">GR amount</div>
                            <div className="text-sm font-bold text-slate-900 tabular-nums">
                              {formatCurrency(accountingPreview)}
                            </div>
                          </div>
                        </div>
                        {match.hasPaperTotal && (
                          <div
                            className={`rounded-md border px-3 py-2 text-sm flex flex-wrap items-center justify-between gap-2 ${
                              match.direction === 'match'
                                ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                                : match.direction === 'over'
                                  ? 'bg-amber-50 border-amber-300 text-amber-950'
                                  : 'bg-sky-50 border-sky-200 text-sky-950'
                            }`}
                          >
                            <span className="font-medium">{GRN_BILL_PROMPT_COPY.variancePanelTitle}</span>
                            <span className="font-mono font-bold tabular-nums">
                              {match.direction === 'match'
                                ? formatCurrency(0)
                                : `${match.direction === 'under' ? '−' : '+'}${formatCurrency(match.absVariance)}`}
                            </span>
                            <span className="w-full text-xs opacity-90">
                              Paper {formatCurrency(match.paperTotal)} · GR{' '}
                              {formatCurrency(match.computedTotal)}
                              {match.direction === 'over'
                                ? ` — ${resolveGrnBillOverGuidance(match.absVariance)}`
                                : match.direction === 'under'
                                  ? ' — under-bill; pick a reason when creating the bill'
                                  : ' — ready to bill'}
                            </span>
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </div>
              )}

              <div className="flex flex-col gap-3 w-full" data-gr-detail-chrome="true">
                <div className="flex flex-col gap-2 w-full min-[400px]:flex-row min-[400px]:flex-wrap min-[400px]:items-center">
                  <button
                    type="button"
                    onClick={() => handleExportGRPDF(selectedGR, items)}
                    className={`${mobileActionBtnClass} px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 flex gap-2`}
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
                        d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                      />
                    </svg>
                    Export PDF
                  </button>
                  <div className="w-full min-[400px]:w-auto [&>button]:w-full min-[400px]:[&>button]:w-auto">
                    <DocumentFlowButton entityType="GOODS_RECEIPT" entityId={selectedGR.id} size="sm" />
                  </div>
                </div>
                {selectedGR.status === 'CANCELLED' && (
                  <p className="text-sm text-gray-600">
                    This goods receipt was cancelled and cannot be posted to inventory.
                  </p>
                )}
                {selectedGR.status === 'DRAFT' && linkedPoStatus === 'CANCELLED' && (
                  <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                    The linked purchase order is cancelled. Receiving is blocked (open receipt cancelled with the PO).
                  </p>
                )}
                {selectedGR.status === 'DRAFT' &&
                  linkedPoStatus &&
                  linkedPoStatus !== 'CANCELLED' &&
                  !poAllowsGoodsReceiptFinalize(linkedPoStatus, finalizePoCtx) && (
                  <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                    Purchase order is <strong>{linkedPoStatus}</strong> — submit and send it to the supplier before receiving.
                    After a full reverse the PO returns to Draft; Finalize stays blocked until that cycle is open again.
                  </p>
                )}
                {selectedGR.status === 'DRAFT' &&
                  linkedPoManualReceipt &&
                  canReceiveThisGR && (
                  <p className="text-sm text-slate-700 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                    Manual receipt — the linked PO is a tracking document (shown as Completed). Finalize this draft to post stock.
                  </p>
                )}
                {selectedGR.status === 'DRAFT' && (
                  <ResponsiveActionBar divider={false} adaptiveCollapse={false} className="sm:flex-row-reverse">
                    {canFinalizeGR && canReceiveThisGR && (
                      <button
                        onClick={() => handleFinalize(selectedGR.id)}
                        className="text-sm font-medium bg-green-600 text-white rounded-lg hover:bg-green-700 px-4"
                      >
                        ✓ Finalize Goods Receipt
                      </button>
                    )}
                    {canUpdateGR && selectedGR.status === 'DRAFT' && (
                      <button
                        type="button"
                        onClick={() => handleCancelDraft(selectedGR.id)}
                        disabled={cancelGRMutation.isPending}
                        className="text-sm font-medium border border-red-300 text-red-700 rounded-lg hover:bg-red-50 px-4 disabled:opacity-50"
                      >
                        {cancelGRMutation.isPending ? 'Cancelling…' : 'Cancel Draft'}
                      </button>
                    )}
                    <button
                      onClick={() => setShowDetailsModal(false)}
                      className="text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50 px-4"
                    >
                      Close
                    </button>
                  </ResponsiveActionBar>
                )}
                {isGoodsReceiptPosted(selectedGR.status) && (
                  <div className="flex flex-col gap-2 w-full min-w-0">
                    {isGrReversed && (
                      <div className="text-sm rounded-lg border border-rose-300 bg-rose-50 text-rose-900 px-3 py-2 leading-snug">
                        <span className="font-semibold">Reversed (counter-document).</span>
                        {' '}Receipt status stays <strong>Completed</strong> for audit
                        {reversedByRgrnNumber ? (
                          <> — reversed by <strong>{reversedByRgrnNumber}</strong></>
                        ) : null}
                        . Not billable; return and supplier reassign are closed.
                        {(grReversalMeta?.reversalReason ?? grReversalMeta?.reversal_reason) && (
                          <span className="block mt-1 text-rose-800">
                            Reason: {grReversalMeta?.reversalReason ?? grReversalMeta?.reversal_reason}
                          </span>
                        )}
                      </div>
                    )}
                    {(() => {
                      const supplierBillNum =
                        (grDetail?.gr as { supplierBillNumber?: string } | undefined)?.supplierBillNumber || '';
                      const postedReturns = existingReturns.filter(
                        (r) => String(r.status || '').toUpperCase() === 'POSTED',
                      );
                      const uninvoicedPosted = postedReturns.filter((r) => {
                        const hasBill = supplierBillNum.length > 0 || !!r.hasSupplierBill;
                        return !r.hasCreditNote && !hasBill;
                      });
                      if (isGrReversed && postedReturns.length > 0) {
                        return (
                          <div className="text-sm rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-900 px-3 py-2 leading-snug">
                            <span className="font-semibold">Reversal complete — no credit note needed.</span>
                            {' '}
                            Stock and GR/IR were cleared when{' '}
                            <strong>{reversedByRgrnNumber || postedReturns[0]?.returnGrnNumber || 'the return'}</strong>
                            {' '}posted. Supplier credit notes apply only to partial invoiced returns, not a full receipt reverse.
                          </div>
                        );
                      }
                      if (uninvoicedPosted.length > 0) {
                        return (
                          <div className="text-sm rounded-lg border border-slate-200 bg-slate-50 text-slate-800 px-3 py-2 leading-snug">
                            <span className="font-semibold">No credit note needed.</span>
                            {' '}
                            {supplierReturnActionLabel({
                              status: 'POSTED',
                              hasCreditNote: false,
                              hasSupplierBill: false,
                              reason: uninvoicedPosted[0]?.reason,
                            })}
                            {' — '}stock and GR/IR cleared on post; do not create a bill just to unlock SCN.
                          </div>
                        );
                      }
                      return null;
                    })()}
                  <div className="flex flex-col gap-3 w-full">
                    {existingReturns.length > 0 && (
                      <div className="flex flex-col gap-2 w-full">
                        <div className="flex flex-wrap gap-1.5 items-center">
                        {existingReturns.map((r) => (
                          <span
                            key={r.id}
                            className={`text-xs px-2 py-1 rounded-full ${r.status === 'POSTED'
                              ? 'bg-orange-100 text-orange-800'
                              : 'bg-gray-100 text-gray-600'
                              }`}
                          >
                            {r.returnGrnNumber} ({r.status})
                          </span>
                        ))}
                        </div>
                        <div className="flex flex-col gap-2 w-full sm:flex-row sm:flex-wrap">
                        {existingReturns
                          .filter((r) => {
                            if (isGrReversed) return false;
                            const supplierBillNum =
                              (grDetail?.gr as { supplierBillNumber?: string } | undefined)
                                ?.supplierBillNumber || '';
                            return canCreateSupplierCreditNoteFromReturn({
                              status: r.status,
                              hasCreditNote: r.hasCreditNote,
                              hasSupplierBill: !!r.hasSupplierBill || supplierBillNum.length > 0,
                              reason: r.reason,
                              sourceGrIsReversed: isGrReversed || r.sourceGrIsReversed,
                            });
                          })
                          .map((r) => (
                          <button
                            key={`cn-${r.id}`}
                            onClick={() =>
                              createCreditNoteMutation.mutate(r.id, {
                                onSuccess: (res) => {
                                  const num = (res as { data?: { data?: { creditNoteNumber?: string } } })?.data?.data?.creditNoteNumber;
                                  toast.success(
                                    `Supplier Credit Note ${num ?? ''} created. Apply it to the bill in Credit Notes.`,
                                    { duration: 6000 },
                                  );
                                },
                                onError: (err) =>
                                  handleApiError(err, {
                                    fallback: 'Failed to create credit note',
                                  }),
                              })
                            }
                            disabled={createCreditNoteMutation.isPending}
                            title={`Create Credit Note for ${r.returnGrnNumber} — then apply to the supplier bill in Credit Notes`}
                            className={`${mobileActionBtnClass} text-sm px-4 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 flex`}
                          >
                            {createCreditNoteMutation.isPending ? 'Creating…' : 'Create Credit Note'}
                          </button>
                          ))}
                        </div>
                      </div>
                    )}
                    <ResponsiveActionBar divider={false} adaptiveCollapse={false}>
                    {canReverseUninvoiced && !isGrReversed && (
                      <button
                        type="button"
                        onClick={handleOpenReverseModal}
                        className="text-sm font-medium px-4 bg-rose-700 text-white rounded-lg hover:bg-rose-800 flex gap-2"
                        title="Full reverse: auto-cancel unpaid linked bills (AP), reverse stock, return PO to Draft. Blocked if paid or stock consumed."
                      >
                        <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                        Reverse Receipt
                      </button>
                    )}
                    {!isGrReversed && (
                      <button
                        onClick={handleOpenReturnModal}
                        className="text-sm font-medium px-4 bg-orange-600 text-white rounded-lg hover:bg-orange-700 flex gap-2"
                      >
                        <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
                        </svg>
                        Return to Supplier
                      </button>
                    )}
                    {!isGrReversed && canReassignSupplier && (grDetail?.gr?.supplierId || selectedGR.supplierId || selectedGR.supplier_id) && (
                      <button
                        type="button"
                        onClick={() => setShowSupplierReassignModal(true)}
                        className="text-sm font-medium px-4 bg-violet-600 text-white rounded-lg hover:bg-violet-700 flex gap-2"
                        title="Move GR/IR liability to another supplier (no stock change)"
                      >
                        Reassign supplier
                      </button>
                    )}
                    {(grDetail?.gr?.supplierId || selectedGR.supplierId) && (() => {
                      const grId = selectedGR.id || (selectedGR as { gr_id?: string }).gr_id || '';
                      const grNumber = selectedGR.grNumber || selectedGR.receiptNumber || selectedGR.receipt_number || '';
                      const existingBillNum = (grDetail?.gr as { supplierBillNumber?: string } | undefined)?.supplierBillNumber || '';
                      const grRow = grDetail?.gr as GRRow | undefined;
                      const poSiblingBill =
                        grRow?.poSiblingBill ??
                        (grRow?.po_sibling_bill
                          ? {
                              invoiceId: grRow.po_sibling_bill.invoice_id,
                              invoiceNumber: grRow.po_sibling_bill.invoice_number,
                              grnId: grRow.po_sibling_bill.grn_id,
                              grnNumber: grRow.po_sibling_bill.grn_number,
                            }
                          : null);
                      const totalVal = items.reduce((sum, it) => {
                        const qty = Number(it.receivedQuantity ?? it.received_quantity ?? 0);
                        const cost = Number(it.unitCost ?? it.unit_cost ?? 0);
                        return sum + qty * cost;
                      }, 0);
                      const isCreating = creatingBillForGR === grId;
                      // Fully reversed uninvoiced receipt — no AP to create
                      if (isGrReversed) {
                        return (
                          <div
                            className={`${mobileActionBtnClass} px-4 bg-rose-50 border border-rose-300 text-rose-900 rounded-lg flex gap-2 text-sm font-semibold`}
                            title={
                              reversedByRgrnNumber
                                ? `Reversed by ${reversedByRgrnNumber} — cannot create supplier bill`
                                : 'Receipt fully reversed — cannot create supplier bill'
                            }
                          >
                            <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                            {reversedByRgrnNumber
                              ? `Reversed (${reversedByRgrnNumber}) — not billable`
                              : 'Reversed — not billable'}
                          </div>
                        );
                      }
                      // Already billed → show a passive badge instead of the action button
                      if (existingBillNum) {
                        return (
                          <div
                            className={`${mobileActionBtnClass} px-4 bg-green-50 border border-green-300 text-green-800 rounded-lg flex gap-2 text-sm font-semibold`}
                            title={`Bill ${existingBillNum} already exists for ${grNumber}`}
                          >
                            <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                            </svg>
                            Billed: {existingBillNum}
                          </div>
                        );
                      }
                      if (poSiblingBill) {
                        return (
                          <div
                            className={`${mobileActionBtnClass} px-4 bg-sky-50 border border-sky-300 text-sky-900 rounded-lg flex flex-col gap-1 text-sm`}
                            title="Top-up on same PO — covered by the original receipt's supplier bill"
                          >
                            <span className="font-semibold flex gap-2 items-center">
                              <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                              </svg>
                              Covered by {poSiblingBill.invoiceNumber}
                            </span>
                            <span className="text-xs text-sky-800">
                              From {poSiblingBill.grnNumber} — finalize links this receipt; no separate supplier invoice.
                            </span>
                          </div>
                        );
                      }
                      const handleOneClickBill = async () => {
                        const ok = window.confirm(
                          `Create supplier bill from ${grNumber} for ${formatCurrency(totalVal)}?\n\n` +
                          `This will:\n` +
                          `  • Clear GR/IR Clearing (2150)\n` +
                          `  • Post Accounts Payable (2100)\n\n` +
                          `Bill number, line items, costs and supplier will be filled from this Goods Receipt automatically.`
                        );
                        if (!ok) return;
                        setCreatingBillForGR(grId);
                        try {
                          // One-click uses GRN-computed total only (no variance input from this button)
                          const { data } = await api.post('/supplier-payments/invoices/from-grn', { grnId: grId });
                          if (!data.success) throw new Error(data.error || 'Failed to create bill');
                          const dataObj = data.data as { invoice?: Record<string, unknown>; invoiceNumber?: string; SupplierInvoiceNumber?: string } | undefined;
                          const inv = dataObj?.invoice ?? dataObj;
                          const invNum = (inv?.invoiceNumber as string | undefined) || (inv?.SupplierInvoiceNumber as string | undefined) || '';
                          toast.success(`Supplier bill ${invNum} created from ${grNumber}.`, { duration: 6000 });
                          await detailsQuery.refetch();
                        } catch (err: unknown) {
                          handleApiError(err);
                        } finally {
                          setCreatingBillForGR(null);
                        }
                      };
                      return (
                        <button
                          onClick={handleOneClickBill}
                          disabled={isCreating || !grId}
                          className={`${mobileActionBtnClass} text-sm px-4 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-400 flex gap-2`}
                          title={`One-click create supplier bill for ${grNumber} — ${formatCurrency(totalVal)}`}
                        >
                          <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                          </svg>
                          {isCreating ? 'Creating Bill…' : `Create Supplier Bill (${formatCurrency(totalVal)})`}
                        </button>
                      );
                    })()}
                    </ResponsiveActionBar>
                  </div>
                  </div>
                )}
              </div>
        </SlideDrawer>
      )}

      {showSupplierReassignModal && selectedGR && isFinalized && (
        <SupplierReassignmentModal
          grnId={selectedGR.id}
          grNumber={
            selectedGR.grNumber ||
            selectedGR.receiptNumber ||
            selectedGR.receipt_number ||
            selectedGR.gr_number ||
            selectedGR.id
          }
          fromSupplierId={
            (grDetail?.gr?.supplierId as string) ||
            selectedGR.supplierId ||
            selectedGR.supplier_id ||
            ''
          }
          fromSupplierName={selectedGR.supplierName || selectedGR.supplier_name}
          onClose={() => setShowSupplierReassignModal(false)}
          onSuccess={() => {
            void detailsQuery.refetch();
            toast.success(
              'Supplier correction complete. Create a new supplier bill for the correct vendor when ready.',
              { duration: 7000 },
            );
          }}
        />
      )}

      {/* Reverse uninvoiced receipt workspace */}
      {showReverseModal && selectedGR && (
        <SlideDrawer
          open
          onClose={() => {
            if (!reverseSubmitting) setShowReverseModal(false);
          }}
          title="Reverse Receipt"
          subtitle={`Cancels unpaid linked bills, reverses on-hand stock/GR-IR, marks ${selectedGR.grNumber || selectedGR.receipt_number} reversed, returns PO to Draft. Blocked if paid or goods consumed.`}
          width="lg"
          transactional
          cancellable={!reverseSubmitting}
          guardLabel="Reverse goods receipt"
          footer={
            <ResponsiveActionBar divider={false} adaptiveCollapse={false} className="sm:flex-row-reverse">
              <button
                type="button"
                onClick={handleSubmitReverseUninvoiced}
                disabled={reverseSubmitting || !reverseReason.trim()}
                className="text-sm font-medium px-4 py-2 bg-rose-700 text-white rounded-lg hover:bg-rose-800 disabled:opacity-50"
              >
                {reverseSubmitting ? 'Reversing…' : 'Confirm reversal'}
              </button>
              <button
                type="button"
                onClick={() => !reverseSubmitting && setShowReverseModal(false)}
                className="text-sm font-medium px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
                disabled={reverseSubmitting}
              >
                Cancel
              </button>
            </ResponsiveActionBar>
          }
        >
            <div className="-mt-2 space-y-4">
            {reverseEligibility?.blockers && reverseEligibility.blockers.length > 0 && (
              <ul className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-4 list-disc pl-5">
                {reverseEligibility.blockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            )}
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Reversal reason <span className="text-red-500">*</span>
            </label>
            <textarea
              value={reverseReason}
              onChange={(e) => setReverseReason(e.target.value)}
              rows={3}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-4"
              placeholder="e.g. Wrong delivery — full return before supplier invoice"
              disabled={reverseSubmitting}
            />
            </div>
        </SlideDrawer>
      )}

      {/* Return to supplier workspace */}
      {showReturnModal && selectedGR && (
        <SlideDrawer
          open
          onClose={() => {
            if (!returnSubmitting) setShowReturnModal(false);
          }}
          title="Return to Supplier"
          subtitle={`${selectedGR.grNumber || selectedGR.receiptNumber || selectedGR.receipt_number || selectedGR.gr_number} — ${selectedGR.supplierName || selectedGR.supplier_name}`}
          width="full"
          transactional
          cancellable={false}
          guardLabel="Return goods to supplier"
          footer={
            <ResponsiveActionBar divider={false} adaptiveCollapse={false} className="sm:flex-row-reverse">
              <button
                onClick={handleSubmitReturn}
                disabled={
                  returnSubmitting ||
                  returnableItems.every((i) => i.returnableQuantity <= 0)
                }
                className="text-sm font-medium bg-orange-600 text-white rounded-lg hover:bg-orange-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 px-4"
              >
                {returnSubmitting ? (
                  <>
                    <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Posting return…
                  </>
                ) : (
                  'Create & Post Return'
                )}
              </button>
              <button
                onClick={() => setShowReturnModal(false)}
                className="text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50 px-4"
                disabled={returnSubmitting}
              >
                Cancel
              </button>
            </ResponsiveActionBar>
          }
        >
            <p className="text-xs sm:text-sm text-gray-500 -mt-2 mb-4">
              Wrong product or quantity? Return it here (stock and GR/IR adjust). Receive the correct item on a{' '}
              <strong>new Goods Receipt</strong> from the same PO. If you already created a supplier bill, post the
              return then click <strong>Create Credit Note</strong> on the return badge.
            </p>
              {/* Reason */}
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Return Reason <span className="text-red-500">*</span>
                </label>
                <textarea
                  value={returnReason}
                  onChange={(e) => setReturnReason(e.target.value)}
                  className="w-full border rounded-lg px-3 py-2 text-sm"
                  rows={2}
                  placeholder="e.g., Damaged goods, Wrong items received, Quality issues..."
                  disabled={returnSubmitting}
                />
              </div>

              {/* Returnable Items Table */}
              {returnableLoading ? (
                <ListSkeleton rows={4} />
              ) : returnableItems.length === 0 ? (
                <div className="text-center py-8 text-gray-500">
                  No items available to return. Stock may be fully sold, consumed, or already returned to the supplier.
                </div>
              ) : (
                <>
                  <p className="text-xs text-gray-600 mb-3 px-1">
                    Only on-hand quantity from this receipt can be returned. Sold or consumed units cannot be sent back to the supplier.
                  </p>

                  {/* Mobile card list */}
                  <div className="sm:hidden space-y-3 mb-4">
                    {returnableItems.map((item) => {
                      const key = returnLineKey(item);
                      const qty = returnQuantities[key] || 0;
                      const { options, selected, receiptUom, baseSymbol } = getReturnLineUomContext(
                        item,
                        returnUomIds[key],
                      );
                      const maxReturn = maxReturnableInUom(
                        item.returnableQuantity,
                        selected.conversionFactor,
                      );
                      const consumed = item.consumedQuantity ?? 0;
                      const canReturn = item.returnableQuantity > 0;
                      return (
                        <article
                          key={key}
                          className={`rounded-lg border p-3 space-y-2 ${!canReturn ? 'border-amber-200 bg-amber-50/50' : 'border-gray-200'}`}
                        >
                          <div>
                            <p className="font-medium text-sm text-gray-900">{item.productName}</p>
                            {item.batchNumber && (
                              <p className="text-xs text-gray-500 mt-0.5">Batch: {item.batchNumber}</p>
                            )}
                            {!canReturn && (item.returnBlockReason || consumed > 0) && (
                              <p className="text-xs text-amber-700 mt-1">
                                {item.returnBlockReason || `${consumed} sold or consumed — cannot return.`}
                              </p>
                            )}
                          </div>
                          <div className="grid grid-cols-2 gap-2 text-xs text-gray-600">
                            <span>
                              On hand:{' '}
                              <strong>
                                {formatReturnGrnDualQty(
                                  item.onHandQuantity ?? 0,
                                  receiptUom,
                                  baseSymbol,
                                )}
                              </strong>
                            </span>
                            <span>
                              Max return:{' '}
                              <strong>
                                {formatReturnGrnDualQty(
                                  item.returnableQuantity,
                                  receiptUom,
                                  baseSymbol,
                                )}
                              </strong>
                            </span>
                            <span>Unit cost: {formatCurrency(item.unitCost)}</span>
                            <span>
                              Received:{' '}
                              {formatReturnGrnDualQty(
                                item.receivedQuantity,
                                receiptUom,
                                baseSymbol,
                              )}
                            </span>
                          </div>
                          <div className="flex items-center justify-between gap-2 pt-1">
                            <label className="text-sm font-medium text-gray-700">Return</label>
                            <div className="flex items-center gap-2">
                              <input
                                type="number"
                                min={0}
                                max={maxReturn}
                                step={0.001}
                                value={qty || ''}
                                onChange={(e) => {
                                  const val = e.target.value === '' ? 0 : Number(e.target.value);
                                  setReturnQuantities((prev) => ({
                                    ...prev,
                                    [key]: Math.min(Math.max(0, val), maxReturn),
                                  }));
                                }}
                                className="w-20 border rounded-lg px-2 py-2 text-right disabled:bg-gray-100"
                                disabled={returnSubmitting || !canReturn}
                                aria-label={`Return quantity for ${item.productName}`}
                              />
                              <select
                                value={selected.uomId}
                                onChange={(e) => {
                                  const nextUomId = e.target.value;
                                  const next = findReturnUomOption(options, nextUomId);
                                  const nextMax = maxReturnableInUom(
                                    item.returnableQuantity,
                                    next.conversionFactor,
                                  );
                                  setReturnUomIds((prev) => ({ ...prev, [key]: nextUomId }));
                                  setReturnQuantities((prev) => ({
                                    ...prev,
                                    [key]: Math.min(prev[key] || 0, nextMax),
                                  }));
                                }}
                                className="border rounded-lg px-2 py-2 text-sm disabled:bg-gray-100"
                                disabled={returnSubmitting || !canReturn}
                                aria-label={`Return unit for ${item.productName}`}
                              >
                                {options.map((opt) => (
                                  <option key={opt.uomId} value={opt.uomId}>
                                    {opt.uomSymbol || opt.uomName}
                                  </option>
                                ))}
                              </select>
                            </div>
                          </div>
                        </article>
                      );
                    })}
                    <div className="rounded-lg bg-gray-50 px-3 py-2 text-sm font-medium text-right">
                      Total return value:{' '}
                      {formatCurrency(
                        returnableItems.reduce((sum, item) => {
                          const key = returnLineKey(item);
                          const entered = returnQuantities[key] || 0;
                          if (entered <= 0) return sum;
                          const { selected, receiptUom } = getReturnLineUomContext(
                            item,
                            returnUomIds[key],
                          );
                          return (
                            sum +
                            returnGrnLineTotal(
                              entered,
                              selected.conversionFactor,
                              receiptUom.conversionFactor,
                              Number(item.unitCost) || 0,
                            )
                          );
                        }, 0),
                      )}
                    </div>
                  </div>

                  <div className="hidden sm:block overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-gray-50 border-b">
                        <th className="text-left px-3 py-2">Product</th>
                        <th className="text-left px-3 py-2">Batch</th>
                        <th className="text-right px-3 py-2">Received</th>
                        <th className="text-right px-3 py-2">Sold / Used</th>
                        <th className="text-right px-3 py-2">On Hand</th>
                        <th className="text-right px-3 py-2">Max Returnable</th>
                        <th className="text-right px-3 py-2">Unit Cost</th>
                        <th className="text-center px-3 py-2">Return Qty</th>
                        <th className="text-center px-3 py-2">UoM</th>
                      </tr>
                    </thead>
                    <tbody>
                      {returnableItems.map((item) => {
                        const key = returnLineKey(item);
                        const qty = returnQuantities[key] || 0;
                        const { options, selected, receiptUom, baseSymbol } = getReturnLineUomContext(
                          item,
                          returnUomIds[key],
                        );
                        const maxReturn = maxReturnableInUom(
                          item.returnableQuantity,
                          selected.conversionFactor,
                        );
                        const consumed = item.consumedQuantity ?? 0;
                        const canReturn = item.returnableQuantity > 0;
                        return (
                          <tr key={key} className={`border-b hover:bg-gray-50 ${!canReturn ? 'bg-amber-50/40' : ''}`}>
                            <td className="px-3 py-2">
                              <div>{item.productName}</div>
                              {!canReturn && (item.returnBlockReason || consumed > 0) && (
                                <div className="text-xs text-amber-700 mt-0.5 max-w-xs">
                                  {item.returnBlockReason ||
                                    `${consumed} sold or consumed — cannot return to supplier.`}
                                </div>
                              )}
                            </td>
                            <td className="px-3 py-2 text-xs text-gray-500">
                              {item.batchNumber || '-'}
                              {item.expiryDate && (
                                <span className="ml-1 text-orange-600">
                                  (exp: {formatDisplayDate(item.expiryDate)})
                                </span>
                              )}
                            </td>
                            <td className="px-3 py-2 text-right text-xs">
                              {formatReturnGrnDualQty(item.receivedQuantity, receiptUom, baseSymbol)}
                            </td>
                            <td className="px-3 py-2 text-right text-amber-700 text-xs">
                              {consumed > 0
                                ? formatReturnGrnDualQty(consumed, receiptUom, baseSymbol)
                                : '—'}
                            </td>
                            <td className="px-3 py-2 text-right text-xs">
                              {item.onHandQuantity != null
                                ? formatReturnGrnDualQty(item.onHandQuantity, receiptUom, baseSymbol)
                                : '—'}
                            </td>
                            <td className="px-3 py-2 text-right font-medium text-xs">
                              {formatReturnGrnDualQty(
                                item.returnableQuantity,
                                receiptUom,
                                baseSymbol,
                              )}
                            </td>
                            <td className="px-3 py-2 text-right">{formatCurrency(item.unitCost)}</td>
                            <td className="px-3 py-2 text-center">
                              <input
                                type="number"
                                min={0}
                                max={maxReturn}
                                step={0.001}
                                value={qty || ''}
                                onChange={(e) => {
                                  const val = e.target.value === '' ? 0 : Number(e.target.value);
                                  setReturnQuantities((prev) => ({
                                    ...prev,
                                    [key]: Math.min(Math.max(0, val), maxReturn),
                                  }));
                                }}
                                className="w-20 border rounded px-2 py-1 text-right disabled:bg-gray-100"
                                disabled={returnSubmitting || !canReturn}
                                aria-label={`Return quantity for ${item.productName}`}
                              />
                            </td>
                            <td className="px-3 py-2 text-center">
                              <select
                                value={selected.uomId}
                                onChange={(e) => {
                                  const nextUomId = e.target.value;
                                  const next = findReturnUomOption(options, nextUomId);
                                  const nextMax = maxReturnableInUom(
                                    item.returnableQuantity,
                                    next.conversionFactor,
                                  );
                                  setReturnUomIds((prev) => ({ ...prev, [key]: nextUomId }));
                                  setReturnQuantities((prev) => ({
                                    ...prev,
                                    [key]: Math.min(prev[key] || 0, nextMax),
                                  }));
                                }}
                                className="border rounded px-2 py-1 text-sm disabled:bg-gray-100 max-w-[5rem]"
                                disabled={returnSubmitting || !canReturn}
                                aria-label={`Return unit for ${item.productName}`}
                              >
                                {options.map((opt) => (
                                  <option key={opt.uomId} value={opt.uomId}>
                                    {opt.uomSymbol || opt.uomName}
                                  </option>
                                ))}
                              </select>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr className="bg-gray-50 font-medium">
                        <td colSpan={7} className="px-3 py-2 text-right">
                          Total Return Value:
                        </td>
                        <td colSpan={2} className="px-3 py-2 text-center">
                          {formatCurrency(
                            returnableItems.reduce((sum, item) => {
                              const key = returnLineKey(item);
                              const entered = returnQuantities[key] || 0;
                              if (entered <= 0) return sum;
                              const { selected, receiptUom } = getReturnLineUomContext(
                                item,
                                returnUomIds[key],
                              );
                              return (
                                sum +
                                returnGrnLineTotal(
                                  entered,
                                  selected.conversionFactor,
                                  receiptUom.conversionFactor,
                                  Number(item.unitCost) || 0,
                                )
                              );
                            }, 0),
                          )}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                  </div>
                </>
              )}
        </SlideDrawer>
      )}

      {/* Post-Finalize: Create Supplier Bill — compact, sticky actions */}
      {billPrompt && (() => {
        const variance = resolveGrnBillPromptVariance(
          billPrompt.total,
          billPrompt.supplierReportedTotal,
        );
        const supplierTotalNum = variance.paperTotal;
        const hasSupplierTotal = variance.hasPaperTotal;
        const billExceedsReceived = variance.direction === 'over';
        const digitShiftTypo =
          variance.hasPaperTotal &&
          isLikelyGrnBillDigitShiftTypo(variance.computedTotal, variance.paperTotal);
        const underReasons =
          variance.direction === 'under'
            ? listGrnBillUnderVarianceReasons(variance.absVariance)
            : [];
        const reasonAllowed =
          !billPrompt.varianceReason ||
          underReasons.some((r) => r.value === billPrompt.varianceReason);
        const effectiveReason =
          reasonAllowed && billPrompt.varianceReason
            ? billPrompt.varianceReason
            : suggestGrnBillVarianceReason(variance.direction, variance.absVariance);
        const needsVarianceReason =
          variance.direction === 'under' && !effectiveReason;
        const isEditLinePrices = effectiveReason === 'EDIT_LINE_PRICES';
        const canSubmit =
          hasSupplierTotal &&
          !billExceedsReceived &&
          !digitShiftTypo &&
          !needsVarianceReason &&
          !isEditLinePrices;

        const applyPaperTotal = (raw: string) => {
          const next = resolveGrnBillPromptVariance(billPrompt.total, raw);
          const suggested = suggestGrnBillVarianceReason(next.direction, next.absVariance);
          const allowed =
            next.direction === 'under'
              ? listGrnBillUnderVarianceReasons(next.absVariance).map((r) => r.value)
              : [];
          setBillPrompt((prev) => {
            if (!prev) return prev;
            const keep =
              prev.varianceReason &&
              allowed.includes(prev.varianceReason as (typeof allowed)[number])
                ? prev.varianceReason
                : suggested;
            return {
              ...prev,
              supplierReportedTotal: raw,
              varianceReason: keep as typeof prev.varianceReason,
            };
          });
        };

        const billAtGrAmount = () => {
          applyPaperTotal(alignPaperTotalToGrAmount(billPrompt.total));
        };

        return (
          <div
            className="fixed inset-0 flex items-center justify-center bg-black/40 backdrop-blur-sm p-3 sm:p-4"
            style={{ zIndex: ZINDEX.NESTED_PANEL + 1 }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="bill-prompt-title"
          >
            <div
              className="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-auto max-h-[min(92vh,640px)] flex flex-col overflow-hidden"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="shrink-0 bg-emerald-600 px-4 py-3 text-white">
                <h3 id="bill-prompt-title" className="text-base font-bold leading-tight">
                  Create supplier bill
                </h3>
                <p className="text-emerald-100 text-xs mt-0.5">
                  {billPrompt.grNumber} · {resolveGrnBillPromptSupplierLabel(billPrompt.supplierName)}
                </p>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-3">
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="text-gray-500">GR amount</span>
                  <span className="font-bold text-emerald-700 tabular-nums">
                    {formatCurrency(billPrompt.total)}
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">
                      Invoice #
                    </label>
                    <input
                      type="text"
                      className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                      value={billPrompt.supplierInvoiceNumber}
                      onChange={(e) =>
                        setBillPrompt((prev) =>
                          prev ? { ...prev, supplierInvoiceNumber: e.target.value } : prev,
                        )
                      }
                      placeholder={billPrompt.grNumber}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">
                      Invoice date
                    </label>
                    <DatePicker
                      value={billPrompt.invoiceDate}
                      onChange={(v) =>
                        setBillPrompt((prev) => (prev ? { ...prev, invoiceDate: v } : prev))
                      }
                      placeholder="Invoice date"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    Paper invoice total
                  </label>
                  <input
                    type="number"
                    step="1"
                    className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    value={billPrompt.supplierReportedTotal}
                    onChange={(e) => applyPaperTotal(e.target.value)}
                    placeholder={formatCurrency(billPrompt.total)}
                  />
                  <p className="text-[11px] text-gray-400 mt-1">{GRN_BILL_PROMPT_COPY.supplierTotalHint}</p>
                </div>

                {variance.hasPaperTotal && (
                  <div
                    className={`rounded-lg border px-3 py-2.5 text-sm space-y-2 ${
                      variance.direction === 'match'
                        ? 'bg-emerald-50 border-emerald-200'
                        : variance.direction === 'over'
                          ? 'bg-amber-50 border-amber-300'
                          : 'bg-amber-50 border-amber-300'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold uppercase tracking-wide text-gray-600">
                        {GRN_BILL_PROMPT_COPY.variancePanelTitle}
                      </span>
                      <span
                        className={`font-mono font-bold tabular-nums ${
                          variance.direction === 'match'
                            ? 'text-emerald-700'
                            : variance.direction === 'over'
                              ? 'text-amber-900'
                              : 'text-amber-900'
                        }`}
                      >
                        {variance.direction === 'match'
                          ? formatCurrency(0)
                          : `${variance.direction === 'under' ? '−' : '+'}${formatCurrency(variance.absVariance)}`}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-gray-700">
                      <span>GR (stock / AP max)</span>
                      <span className="text-right font-mono tabular-nums">
                        {formatCurrency(variance.computedTotal)}
                      </span>
                      <span>Paper (supplier)</span>
                      <span className="text-right font-mono tabular-nums">
                        {formatCurrency(variance.paperTotal)}
                      </span>
                    </div>

                    {digitShiftTypo && (
                      <div className="space-y-2">
                        <p className="text-xs text-amber-950">
                          {resolveGrnBillDigitShiftGuidance(
                            variance.computedTotal,
                            variance.paperTotal,
                          )}
                        </p>
                        <button
                          type="button"
                          onClick={billAtGrAmount}
                          className="w-full px-3 py-1.5 text-sm font-semibold text-emerald-800 bg-white border border-emerald-300 rounded-lg hover:bg-emerald-50"
                        >
                          {GRN_BILL_PROMPT_COPY.billAtGrLabel} (
                          {formatCurrency(variance.computedTotal)})
                        </button>
                      </div>
                    )}

                    {variance.direction === 'over' && !digitShiftTypo && (
                      <div className="space-y-2">
                        <p className="text-xs text-amber-950">
                          {resolveGrnBillOverGuidance(variance.absVariance)}
                        </p>
                        <button
                          type="button"
                          onClick={billAtGrAmount}
                          className="w-full px-3 py-1.5 text-sm font-semibold text-emerald-800 bg-white border border-emerald-300 rounded-lg hover:bg-emerald-50"
                        >
                          {GRN_BILL_PROMPT_COPY.billAtGrLabel} (
                          {formatCurrency(variance.computedTotal)})
                        </button>
                      </div>
                    )}

                    {variance.direction === 'under' && !digitShiftTypo && (
                      <>
                        <div>
                          <label className="block text-xs font-medium text-amber-900 mb-1">
                            Reason
                          </label>
                          <select
                            className="w-full px-2.5 py-1.5 border border-amber-300 rounded-lg text-sm bg-white focus:ring-2 focus:ring-amber-500"
                            value={effectiveReason}
                            onChange={(e) =>
                              setBillPrompt((prev) =>
                                prev
                                  ? {
                                      ...prev,
                                      varianceReason: e.target
                                        .value as typeof billPrompt.varianceReason,
                                    }
                                  : prev,
                              )
                            }
                          >
                            {!effectiveReason && <option value="">— Select —</option>}
                            {underReasons.map((r) => (
                              <option key={r.value} value={r.value}>
                                {r.label}
                              </option>
                            ))}
                          </select>
                        </div>
                        {isEditLinePrices && (
                          <p className="text-xs text-red-700">
                            Fix unit costs on {billPrompt.grNumber}, then create the bill again.
                          </p>
                        )}
                        {!isEditLinePrices && effectiveReason && (
                          <p className="text-[11px] text-amber-800/90 leading-snug">
                            GL: DR 2150 {formatCurrency(billPrompt.total)} · CR 2100{' '}
                            {formatCurrency(supplierTotalNum)} · CR 5020{' '}
                            {formatCurrency(variance.absVariance)}
                          </p>
                        )}
                      </>
                    )}

                    {variance.direction === 'match' && (
                      <p className="text-[11px] text-emerald-800">
                        GL: DR 2150 / CR 2100 — no variance
                      </p>
                    )}
                  </div>
                )}
              </div>

              <div className="shrink-0 px-4 py-3 bg-gray-50 border-t border-gray-200 flex gap-2 justify-end">
                <button
                  type="button"
                  disabled={billPromptLoading}
                  onClick={() => setBillPrompt(null)}
                  className="px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
                >
                  Skip
                </button>
                <button
                  type="button"
                  disabled={billPromptLoading || !canSubmit}
                  title={
                    !canSubmit
                      ? needsVarianceReason
                        ? 'Select a variance reason'
                        : billExceedsReceived
                          ? 'Paper total cannot exceed GR'
                          : isEditLinePrices
                            ? 'Fix GR costs first'
                            : 'Enter paper invoice total'
                      : undefined
                  }
                  onClick={async () => {
                    if (!billPrompt) return;
                    setBillPromptLoading(true);
                    setCreatingBillForGR(billPrompt.grId);
                    try {
                      const body: Record<string, unknown> = {
                        grnId: billPrompt.grId,
                        supplierInvoiceNumber: billPrompt.supplierInvoiceNumber || undefined,
                        invoiceDate: billPrompt.invoiceDate || undefined,
                      };
                      if (hasSupplierTotal) {
                        body.supplierReportedTotal = supplierTotalNum;
                        if (effectiveReason) {
                          body.varianceReason = effectiveReason;
                        }
                      }
                      const { data } = await api.post('/supplier-payments/invoices/from-grn', body);
                      if (!data.success) throw new Error(data.error || 'Failed to create bill');
                      const dataObj = data.data as
                        | {
                            invoice?: Record<string, unknown>;
                            invoiceNumber?: string;
                            SupplierInvoiceNumber?: string;
                          }
                        | undefined;
                      const inv = dataObj?.invoice ?? dataObj;
                      const invNum =
                        (inv?.invoiceNumber as string | undefined) ||
                        (inv?.SupplierInvoiceNumber as string | undefined) ||
                        '';
                      setBillPrompt(null);
                      await detailsQuery.refetch();
                      alert(`✅ Supplier bill ${invNum} created from ${billPrompt.grNumber}.`);
                    } catch (billErr: unknown) {
                      handleApiError(billErr, { fallback: 'Failed to create supplier bill' });
                    } finally {
                      setBillPromptLoading(false);
                      setCreatingBillForGR(null);
                    }
                  }}
                  className="px-3 py-2 text-sm font-semibold text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 disabled:bg-gray-400 disabled:cursor-not-allowed flex items-center gap-2"
                >
                  {billPromptLoading ? (
                    <>
                      <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                        <circle
                          className="opacity-25"
                          cx="12"
                          cy="12"
                          r="10"
                          stroke="currentColor"
                          strokeWidth="4"
                        />
                        <path
                          className="opacity-75"
                          fill="currentColor"
                          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                        />
                      </svg>
                      Creating…
                    </>
                  ) : (
                    'Create bill'
                  )}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Cost alerts workspace */}
      {showAlertsModal && costAlerts.length > 0 && (
        <SlideDrawer
          open
          onClose={() => setShowAlertsModal(false)}
          title="Cost Price Change Alerts"
          subtitle={`${costAlerts.length} product(s) with cost changes`}
          width="2xl"
          footer={
            <div className="flex justify-end">
              <button
                onClick={() => setShowAlertsModal(false)}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
              >
                Acknowledge
              </button>
            </div>
          }
        >
            <div className="space-y-4 -mt-2">
              {costAlerts.map((alert, index) => (
                <div
                  key={index}
                  className={`rounded-lg p-4 border-2 ${alert.severity === 'HIGH'
                    ? 'bg-red-50 border-red-200'
                    : 'bg-yellow-50 border-yellow-200'
                    }`}
                >
                  <div className="flex items-start gap-3">
                    <div className="flex-shrink-0 text-2xl">
                      {alert.severity === 'HIGH' ? '🔴' : '🟡'}
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-2">
                        <span
                          className={`px-2 py-1 text-xs font-bold rounded ${alert.severity === 'HIGH'
                            ? 'bg-red-600 text-white'
                            : 'bg-yellow-600 text-white'
                            }`}
                        >
                          {alert.severity} SEVERITY
                        </span>
                        <span className="font-semibold text-gray-900">{alert.productName}</span>
                      </div>
                      <p className="text-sm text-gray-700 mb-3">{alert.message}</p>
                      <div className="grid grid-cols-2 gap-4 text-sm">
                        <div>
                          <span className="text-gray-600">Previous Cost:</span>
                          <span className="ml-2 font-semibold text-gray-900">
                            {formatCurrency(parseFloat(alert.details.previousCost))}
                          </span>
                        </div>
                        <div>
                          <span className="text-gray-600">New Cost:</span>
                          <span className="ml-2 font-semibold text-gray-900">
                            {formatCurrency(parseFloat(alert.details.newCost))}
                          </span>
                        </div>
                        <div>
                          <span className="text-gray-600">Change:</span>
                          <span className="ml-2 font-semibold text-gray-900">
                            {parseFloat(alert.details.changeAmount) > 0 ? '+' : ''}
                            {formatCurrency(parseFloat(alert.details.changeAmount))}
                          </span>
                        </div>
                        <div>
                          <span className="text-gray-600">Percentage:</span>
                          <span className="ml-2 font-semibold text-gray-900">
                            {parseFloat(alert.details.changePercentage) > 0 ? '+' : ''}
                            {parseFloat(alert.details.changePercentage).toFixed(2)}%
                          </span>
                        </div>
                        {alert.details.batchNumber && (
                          <div className="col-span-2">
                            <span className="text-gray-600">Batch:</span>
                            <span className="ml-2 font-mono text-sm text-gray-900">
                              {alert.details.batchNumber}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ))}

              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mt-6">
                <p className="text-sm text-blue-800">
                  ℹ️ Cost changes have been applied. Pricing formulas will be recalculated
                  automatically.
                </p>
              </div>
            </div>
        </SlideDrawer>
      )}

      {/* Create GR workspace */}
      <SlideDrawer
        open={showCreateModal}
        onClose={closeCreateGrModal}
        title="Create Goods Receipt from PO"
        subtitle="Select an open purchase order to receive against"
        width="xl"
        transactional
        guardLabel="Create goods receipt"
        footer={
          <div className="flex justify-end gap-3">
            <button onClick={closeCreateGrModal} className="px-4 py-2 border rounded-lg">
              Cancel
            </button>
            <button
              onClick={handleCreateGR}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
              disabled={createGRMutation.isPending || !selectedPoId}
            >
              {createGRMutation.isPending ? 'Creating…' : 'Create GR'}
            </button>
          </div>
        }
      >
            <div className="space-y-4 -mt-2">
              <div>
                <label htmlFor="po-search" className="block text-sm font-medium text-gray-700 mb-1">
                  Search POs (open for receipt)
                </label>
                <input
                  id="po-search"
                  className="w-full border rounded-lg px-3 py-2"
                  placeholder="Search by PO number or supplier"
                  value={poSearch}
                  onChange={(e) => setPoSearch(e.target.value)}
                />
              </div>
              <div
                className="border rounded-lg max-h-64 overflow-y-auto"
                role="radiogroup"
                aria-label="Pending purchase orders"
                onKeyDown={(e) => {
                  if (filteredPOs.length === 0) return;
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    const next = Math.min(filteredPOs.length - 1, focusedPoIndex + 1);
                    setFocusedPoIndex(next);
                    const el = poRadioRefs.current[next];
                    el?.focus();
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    const prev = Math.max(0, focusedPoIndex - 1);
                    setFocusedPoIndex(prev);
                    const el = poRadioRefs.current[prev];
                    el?.focus();
                  } else if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    const current = poRadioRefs.current[focusedPoIndex];
                    if (current) {
                      current.checked = true;
                      const val = current.value;
                      setSelectedPoId(val);
                      ensurePoQuickView(val);
                    }
                  }
                }}
              >
                {pendingPOsQuery.isLoading ? (
                  <div className="p-3 text-sm text-gray-500">Loading pending POs…</div>
                ) : filteredPOs.length === 0 ? (
                  <div className="p-3 text-sm text-gray-500">No pending POs found</div>
                ) : (
                  <ul>
                    {filteredPOs.map((po: PORow, idx: number) => {
                      const orderNumber = po.order_number || po.poNumber;
                      const supplierName = po.supplier_name || po.supplierName;
                      const orderDate = formatDisplayDate(po.order_date || po.orderDate);
                      const totalAmount = po.total_amount ?? po.totalAmount ?? 0;
                      const qv = poQuickView[po.id];
                      return (
                        <li key={po.id} className="border-b last:border-b-0">
                          <label
                            className="flex items-center gap-3 p-3 cursor-pointer hover:bg-gray-50"
                            onMouseEnter={() => ensurePoQuickView(po.id)}
                            onFocus={() => ensurePoQuickView(po.id)}
                          >
                            <input
                              ref={(el) => {
                                if (el) poRadioRefs.current[idx] = el;
                              }}
                              type="radio"
                              name="selected-po"
                              value={po.id}
                              checked={selectedPoId === po.id}
                              onChange={() => {
                                setSelectedPoId(po.id);
                                ensurePoQuickView(po.id);
                              }}
                              aria-label={`Select ${orderNumber} from ${supplierName}`}
                            />
                            <div className="flex-1">
                              <div className="text-sm font-medium text-gray-900">{orderNumber}</div>
                              <div className="text-xs text-gray-600">{supplierName}</div>
                              <div className="text-xs text-gray-500 mt-1">
                                {qv
                                  ? `${qv.itemsCount} item${qv.itemsCount === 1 ? '' : 's'}`
                                  : 'items: —'}{' '}
                                • Total {formatCurrency(totalAmount)}
                              </div>
                            </div>
                            <div className="text-xs text-gray-500">{orderDate}</div>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
              {poPagination && (
                <div className="flex items-center justify-between text-xs text-gray-600">
                  <div>
                    Page {poPagination.page} of {poPagination.totalPages}
                  </div>
                  <div className="flex gap-2">
                    <button
                      className="px-2 py-1 border rounded"
                      disabled={poPage === 1}
                      onClick={() => setPoPage(Math.max(1, poPage - 1))}
                    >
                      Prev
                    </button>
                    <button
                      className="px-2 py-1 border rounded"
                      disabled={poPage === poPagination.totalPages}
                      onClick={() => setPoPage(Math.min(poPagination.totalPages, poPage + 1))}
                    >
                      Next
                    </button>
                  </div>
                </div>
              )}
            </div>
      </SlideDrawer>

    </div>
  );
}

// ── Inline Add Item Form for DRAFT GRs ──
function AddGRItemForm({
  grId,
  supplierId,
  addMutation,
  onClose,
  onSuccess,
}: {
  grId: string;
  supplierId?: string;
  addMutation: ReturnType<typeof useAddGRItem>;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [selectedProduct, setSelectedProduct] = useState<ProcurementProduct | null>(null);
  const [quantity, setQuantity] = useState('1');
  const [unitCost, setUnitCost] = useState('0');
  const [batchNumber, setBatchNumber] = useState('');
  const [expiryDate, setExpiryDate] = useState('');

  const handleProductSelect = (product: ProcurementProduct) => {
    setSelectedProduct(product);
    // Auto-fill cost from product
    if (product.costPrice > 0) {
      setUnitCost(new Decimal(product.costPrice).toFixed(2));
    } else if (product.lastCost > 0) {
      setUnitCost(new Decimal(product.lastCost).toFixed(2));
    }
  };

  const handleAdd = () => {
    if (!selectedProduct) { alert('Please select a product'); return; }
    const qty = parseFloat(quantity);
    const cost = parseFloat(unitCost);
    if (!qty || qty <= 0) { alert('Quantity must be positive'); return; }
    if (cost < 0) { alert('Unit cost cannot be negative'); return; }
    if (selectedProduct.trackExpiry && (!expiryDate || !expiryDate.trim())) {
      alert('Expiry date is required for this product');
      return;
    }

    addMutation.mutate({
      grId,
      data: {
        productId: selectedProduct.id,
        productName: selectedProduct.name,
        receivedQuantity: qty,
        unitCost: cost,
        batchNumber: batchNumber || null,
        expiryDate: expiryDate || null,
      },
    }, {
      onSuccess: () => onSuccess(),
      onError: (err: Error) => alert(err.message || 'Failed to add item'),
    });
  };

  return (
    <div className="mb-4 p-4 bg-green-50 border border-green-200 rounded-lg">
      <div className="flex items-center justify-between mb-3">
        <h5 className="text-sm font-semibold text-green-800">Add New Item</h5>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-sm">✕</button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
        <div className="md:col-span-2">
          <label className="block text-xs font-medium text-gray-700 mb-1">Product</label>
          {selectedProduct ? (
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-gray-900 truncate">{selectedProduct.name}</span>
              <button onClick={() => setSelectedProduct(null)} className="text-xs text-red-500 hover:text-red-700">change</button>
            </div>
          ) : (
            <ProcurementProductSearch
              supplierId={supplierId || undefined}
              onProductSelect={handleProductSelect}
              disabled={addMutation.isPending}
              className="w-full"
              placeholder={
                supplierId
                  ? undefined
                  : 'Search products by name, SKU, or barcode...'
              }
            />
          )}
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Qty Received</label>
          <input type="number" value={quantity} onChange={(e) => setQuantity(e.target.value)} min="1" step="1"
            className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-green-500" />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Unit Cost</label>
          <input type="number" value={unitCost} onChange={(e) => setUnitCost(e.target.value)} step="1"
            className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-green-500" />
        </div>
        <div className="flex items-end">
          <button onClick={handleAdd} disabled={addMutation.isPending || !selectedProduct}
            className="w-full px-3 py-1.5 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700 disabled:opacity-50">
            {addMutation.isPending ? 'Adding…' : 'Add'}
          </button>
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-2">
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Batch # (optional)</label>
          <input type="text" value={batchNumber} onChange={(e) => setBatchNumber(e.target.value)} placeholder="BATCH-YYYYMMDD-001"
            className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-green-500" />
        </div>
        <div>
          {selectedProduct?.trackExpiry ? (
            <>
              <label className="block text-xs font-medium text-gray-700 mb-1">Expiry Date</label>
              <DatePicker
                value={expiryDate}
                onChange={setExpiryDate}
                minDate={new Date(getBusinessDate())}
                placeholder="Expiry date"
              />
            </>
          ) : (
            <>
              <label className="block text-xs font-medium text-gray-700 mb-1">Expiry Date</label>
              <span className="text-xs text-gray-400 italic">Not tracked for this product</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// Child row component to satisfy React Hook rules
function GRItemRow({
  item,
  baseline,
  selectedGR,
  editState,
  onFieldChange,
  batchWarnings,
  validationTimeout,
  checkBatchDuplicate,
  isFromPO,
  itemIndex,
  totalItems: _totalItems,
  bundledUoms,
  destinationStores,
  storeLabelMap,
  defaultStoreId,
  showStoreColumn,
  onRemove,
}: {
  item: GRItemRow;
  baseline: 'PO' | 'PRODUCT';
  selectedGR: GRRow;
  editState: EditItemState;
  onFieldChange: (
    itemId: string,
    field: string,
    value: string | number | boolean | undefined
  ) => void;
  batchWarnings: Record<string, string>;
  validationTimeout: React.MutableRefObject<Record<string, NodeJS.Timeout>>;
  checkBatchDuplicate: (itemId: string, batchNumber: string) => Promise<void>;
  isFromPO: boolean;
  itemIndex: number;
  totalItems: number;
  bundledUoms: ProductUomEntry[];
  destinationStores: StoreLocation[];
  storeLabelMap: ReadonlyMap<string, string>;
  defaultStoreId: string;
  showStoreColumn: boolean;
  onRemove?: (itemId: string) => void;
}) {
  const es = editState || {};
  const trackExpiry = grItemTrackExpiry(item);
  const ordered = Number(item.orderedQuantity ?? item.ordered_quantity ?? 0);
  // PO and GR persist qty/cost in the PO's order UoM (display units), same as PurchaseOrdersPage.
  const receivedQty = Number(
    es.receivedQuantity ??
    item.receivedQuantity ??
    item.received_quantity ??
    (selectedGR.status === 'DRAFT' ? ordered : 0)
  );
  const disabled = selectedGR.status !== 'DRAFT';
  const displayUnitCost = Number(es.unitCost ?? item.unitCost ?? item.unit_cost ?? 0);
  const poUnitPrice = Number(item.po_unit_price ?? item.poUnitPrice ?? 0);
  const prodUnitPrice = Number(item.product_cost_price ?? item.productCostPrice ?? 0);
  const costBaseline = baseline === 'PO' ? poUnitPrice : prodUnitPrice;

  // Use bundled UoM data from GR detail response (no per-item fetch)
  const uomList = bundledUoms;
  // When receiving from PO, match the PO's UoM; otherwise use product default
  const itemUomId = item.uomId || item.uom_id;
  const poUom = itemUomId
    ? uomList.find(u => u.uomId === itemUomId || u.id === itemUomId)
    : undefined;
  const defaultUom = poUom || uomList.find(u => u.isDefault) || uomList[0];
  // UomSelector option values use master uoms.id (uomId), not product_uoms.id
  const selectedUomId = es.selectedUomId || defaultUom?.uomId || itemUomId;

  const displayedOrdered = ordered;
  const displayedReceived = receivedQty;
  const displayedUnitCost = displayUnitCost;

  const qtyVariancePct =
    ordered > 0
      ? new Decimal(receivedQty || 0).minus(ordered).div(ordered).mul(100).toNumber()
      : 0;
  let costVarPct: number | null = null;
  let costVarAbs: number | null = null;
  if (costBaseline > 0) {
    const dAbs = new Decimal(displayUnitCost).minus(costBaseline);
    costVarAbs = dAbs.toNumber();
    const dPct = dAbs.div(costBaseline).mul(100);
    costVarPct = dPct.toNumber();
  }

  const poAlready = Number(item.poAlreadyReceived ?? item.po_already_received ?? 0);
  const openQty = Math.max(0, Number(ordered) - poAlready);
  const isFullLineBonus = !!(es.isBonus ?? item.isBonus ?? item.is_bonus ?? false);
  const receivedVal = Number(es.receivedQuantity ?? receivedQty);
  const receiptSplit = isFromPO
    ? splitGRReceiptQuantities(Number(ordered), poAlready, receivedVal, isFullLineBonus)
    : { billableQty: receivedVal, bonusQty: 0, openQty };

  const receivedError = ((): string | null => {
    if (es.receivedQuantity == null) return null;
    if (Number(es.receivedQuantity) < 0) return 'Must be ≥ 0';
    return null;
  })();
  const receivedHint =
    isFromPO && receiptSplit.bonusQty > 0 && !isFullLineBonus
      ? `${receiptSplit.bonusQty} unit(s) over open PO qty will post as bonus (free)`
      : isFromPO && isFullLineBonus && receivedVal > 0
        ? 'Full line posts as bonus stock (zero cost)'
        : null;
  const unitCostError = ((): string | null => {
    if (es.unitCost == null) return null;
    return Number(es.unitCost) < 0 ? 'Must be ≥ 0' : null;
  })();
  const hasQty = receivedQty > 0;
  const expiryError = ((): string | null => {
    const v = es.expiryDate ?? item.expiryDate ?? item.expiry_date;
    if (trackExpiry && hasQty && (!v || !String(v).trim())) return 'Required';
    if (!v) return null;
    const d = new Date(v);
    if (isNaN(d.getTime())) return 'Invalid date';
    const todayStr = getBusinessDate();
    return v <= todayStr ? 'Must be a future date' : null;
  })();

  // Line completeness — expiry only when product tracks expiry
  const hasBatch = !!(es.batchNumber ?? '').trim();
  const hasExpiry = !!(es.expiryDate ?? item.expiryDate ?? item.expiry_date ?? '').trim();
  const isComplete = hasQty && grLineExpirySatisfied(trackExpiry, receivedQty, es.expiryDate ?? item.expiryDate ?? item.expiry_date);
  const isPartial = hasQty && trackExpiry && !hasExpiry;
  const rowBorderColor = disabled
    ? ''
    : isComplete
      ? 'border-l-4 border-l-green-500 bg-green-50/30'
      : isPartial
        ? 'border-l-4 border-l-yellow-500 bg-yellow-50/30'
        : 'border-l-4 border-l-red-300';

  return (
    <tr className={`hover:bg-gray-50 ${rowBorderColor}`}>
      {/* Product name */}
      <td className="px-4 py-2 text-sm font-medium text-gray-900">
        {item.productName || item.product_name}
        {isComplete && !disabled && <span className="ml-1 text-green-600">✓</span>}
        {isComplete && !hasBatch && !disabled && <span className="ml-1 text-xs text-gray-400">(auto-batch)</span>}
      </td>
      {/* UoM */}
      <td className="px-4 py-2 text-sm">
        {uomList.length === 0 ? (
          <span className="text-gray-400">—</span>
        ) : (
          <UomSelector
            productId={item.productId || item.product_id || ''}
            baseCost={costBaseline > 0 ? costBaseline : displayUnitCost}
            selectedUomId={selectedUomId}
            disabled={disabled || isFromPO}
            prefetchedUoms={uomList as ProductUomDetail[]}
            className="text-sm"
            onChange={(params) => {
              onFieldChange(item.id, 'selectedUomId', params.uomId || '');
              if (!isFromPO) {
                onFieldChange(item.id, 'unitCost', parseFloat(params.newCost));
              }
            }}
          />
        )}
        {isFromPO && !disabled && (
          <p className="text-[10px] text-gray-500 mt-0.5">Locked to PO UoM</p>
        )}
      </td>
      {/* Ordered / open */}
      <td className="px-4 py-2 text-sm text-center text-gray-700 font-medium">
        <div>{displayedOrdered}</div>
        {isFromPO && openQty < Number(ordered) && (
          <div className="text-xs text-amber-700">Open: {openQty}</div>
        )}
      </td>
      {/* Received — single input (Problem 3) */}
      <td className="px-4 py-2 text-sm">
        <input
          type="number"
          min={0}
          data-gr-received-idx={itemIndex}
          className={`w-20 border rounded px-2 py-1 text-center font-medium ${receivedError ? 'border-red-500 bg-red-50' : 'focus:ring-2 focus:ring-blue-400 focus:border-blue-400'}`}
          value={displayedReceived}
          disabled={disabled}
          aria-label={`Received quantity for ${item.productName || item.product_name}`}
          onChange={(e) => {
            const uomQty = e.target.value === '' ? 0 : Number(e.target.value);
            onFieldChange(item.id, 'receivedQuantity', uomQty);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              const batchInput = document.querySelector(`[data-gr-batch-idx="${itemIndex}"]`) as HTMLInputElement;
              batchInput?.focus();
            }
          }}
          autoFocus={itemIndex === 0 && !disabled}
        />
        {receivedError && <div className="text-xs text-red-600 mt-0.5">{receivedError}</div>}
        {receivedHint && !receivedError && (
          <div className="text-xs text-green-700 mt-0.5 max-w-[140px]">{receivedHint}</div>
        )}
      </td>
      {/* Unit Cost */}
      <td className="px-4 py-2 text-sm">
        {isFromPO ? (
          <div>
            <div className="text-sm font-medium text-gray-900">
              {formatCurrency(displayedUnitCost)}
            </div>
            <div className="text-xs text-blue-600 mt-0.5">PO Agreed</div>
          </div>
        ) : (
          <>
            <input
              type="number"
              step="1"
              className={`w-28 border rounded px-2 py-1 ${unitCostError ? 'border-red-500' : ''}`}
              value={Number.isFinite(displayedUnitCost) ? displayedUnitCost : ''}
              disabled={disabled}
              aria-label={`Unit cost for ${item.productName || item.product_name}`}
              onChange={(e) => {
                const v = e.target.value === '' ? undefined : Number(e.target.value);
                onFieldChange(item.id, 'unitCost', v);
              }}
            />
            {unitCostError && <div className="text-xs text-red-600 mt-1">{unitCostError}</div>}
          </>
        )}
      </td>
      {/* Batch + Expiry — horizontal same cell (Problem 5) */}
      <td className="px-4 py-2 text-sm">
        <div className="flex items-start gap-2">
          <div className="flex-1">
            <input
              type="text"
              data-gr-batch-idx={itemIndex}
              className={`w-full border rounded px-2 py-1 text-sm ${batchWarnings[item.id] ? 'border-red-500' : 'focus:ring-2 focus:ring-blue-400 focus:border-blue-400'}`}
              value={es.batchNumber ?? ''}
              disabled={disabled}
              onChange={(e) => {
                const value = e.target.value;
                onFieldChange(item.id, 'batchNumber', value);
                if (validationTimeout.current[item.id]) {
                  clearTimeout(validationTimeout.current[item.id]);
                }
                validationTimeout.current[item.id] = setTimeout(() => {
                  checkBatchDuplicate(item.id, value);
                }, 500);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  const expiryInput = document.getElementById(`gr-expiry-${itemIndex}`);
                  expiryInput?.focus();
                }
              }}
              placeholder="Auto if blank"
            />
            {batchWarnings[item.id] && (
              <div className="text-xs text-red-600 mt-0.5 truncate max-w-[120px]" title={batchWarnings[item.id]}>{batchWarnings[item.id]}</div>
            )}
          </div>
          <div className={trackExpiry ? 'flex-1' : 'hidden'}>
            <DatePicker
              id={`gr-expiry-${itemIndex}`}
              className={expiryError ? 'border-red-500' : undefined}
              value={es.expiryDate ?? (item.expiryDate ? String(item.expiryDate).slice(0, 10) : '') ?? ''}
              disabled={disabled}
              minDate={new Date(getBusinessDate())}
              onChange={(v) => onFieldChange(item.id, 'expiryDate', v || undefined)}
              placeholder="Expiry date"
            />
            {expiryError && <div className="text-xs text-red-600 mt-0.5">{expiryError}</div>}
          </div>
          {!trackExpiry && (
            <div className="flex-1 text-xs text-gray-400 italic py-1">N/A</div>
          )}
        </div>
      </td>
      {showStoreColumn && (
        <td className="px-4 py-2 text-sm">
          {disabled ? (
            <span className="text-gray-700">
              {resolveStoreLabel(
                storeLabelMap,
                es.targetStoreLocationId ??
                  item.targetStoreLocationId ??
                  item.target_store_location_id ??
                  defaultStoreId,
              )}
            </span>
          ) : (
            <StoreLocationSelect
              stores={destinationStores}
              value={
                es.targetStoreLocationId ??
                item.targetStoreLocationId ??
                item.target_store_location_id ??
                defaultStoreId
              }
              onChange={(storeId) => onFieldChange(item.id, 'targetStoreLocationId', storeId)}
              disabled={disabled || destinationStores.length === 0}
              triggerClassName="h-9 min-w-[140px] text-sm"
            />
          )}
        </td>
      )}
      {/* Bonus */}
      <td className="px-4 py-2 text-sm text-center">
        <label
          className="inline-flex items-center gap-1 cursor-pointer"
          title="All units on this line are free (bonus). To receive extra units above the PO, enter the full qty — excess over open PO qty posts as bonus automatically."
        >
          <input
            type="checkbox"
            checked={!!(es.isBonus ?? item.isBonus ?? item.is_bonus ?? false)}
            disabled={disabled}
            onChange={(e) => onFieldChange(item.id, 'isBonus', e.target.checked)}
            className="rounded border-gray-300 text-green-600 focus:ring-green-500"
            aria-label={`Bonus stock for ${item.productName || item.product_name}`}
          />
          {!!(es.isBonus ?? item.isBonus ?? item.is_bonus) && (
            <span className="text-xs text-green-700 font-medium">FREE</span>
          )}
        </label>
      </td>
      {/* Combined Variance column */}
      <td className="px-4 py-2 text-sm">
        <div className="flex flex-col gap-1">
          {displayedOrdered > 0 && (
            <span
              className={`inline-block px-1.5 py-0.5 rounded text-xs font-semibold ${qtyVariancePct > 0 ? 'bg-yellow-100 text-yellow-800' : qtyVariancePct < 0 ? 'bg-red-100 text-red-800' : 'bg-gray-100 text-gray-800'}`}
              title="Quantity variance"
            >
              Qty {qtyVariancePct > 0 ? '+' : ''}{qtyVariancePct.toFixed(1)}%
            </span>
          )}
          {costVarPct !== null && (
            <span
              className={`inline-block px-1.5 py-0.5 rounded text-xs font-semibold ${costVarPct > 0 ? 'bg-red-100 text-red-800' : costVarPct < 0 ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'}`}
              title={`Cost variance vs ${baseline === 'PO' ? 'PO' : 'product'}: ${costVarAbs !== null ? formatCurrency(Math.abs(costVarAbs)) : ''}`}
            >
              Cost {costVarPct > 0 ? '+' : ''}{costVarPct.toFixed(1)}%
            </span>
          )}
        </div>
      </td>
      {onRemove && !disabled && (
        <td className="px-2 py-2 text-center">
          <button
            type="button"
            onClick={() => onRemove(item.id)}
            className="text-red-500 hover:text-red-700 text-sm"
            title="Remove item"
          >
            ✕
          </button>
        </td>
      )}
    </tr>
  );
}