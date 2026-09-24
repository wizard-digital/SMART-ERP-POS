import { useState, useEffect, useRef, useCallback, useMemo, type ReactNode } from 'react';
import { useNavigate, Link, useLocation } from 'react-router-dom';
import Decimal from 'decimal.js';
import { ResponsiveTableWrapper } from '../../components/ui/ResponsiveTableWrapper';
import POSProductSearch, { POSProductSearchHandle } from './POSProductSearch';
import POSButton from '../../components/pos/POSButton';
import POSModal from '../../components/pos/POSModal';
import { AdaptiveAppShell, AdaptiveScanner, useAdaptiveWorkspaceOptional } from '../../components/adaptive';
import { useLayoutTier } from '../../hooks/useLayoutTier';
import { shouldShowCoach } from '../../lib/adaptiveChrome';
import { registerSessionResume } from '../../lib/sessionResumeCoordinator';
import { POS_ADAPTIVE_CLASSES, POS_CART_COL_WIDTHS_COMPACT, POS_CART_COL_WIDTHS_FULL } from '../../lib/posAdaptiveLayout';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { PosCartCompactLine } from '../../components/pos/PosCartCompactLine';
import PrintReceiptDialog from '../../components/pos/PrintReceiptDialog';
import CustomerSelector from '../../components/pos/CustomerSelector';
import { SearchSoftKeyboardInput } from '../../components/keyboard/SearchSoftKeyboardInput';
import { NumericSoftKeyboardInput } from '../../components/keyboard/NumericSoftKeyboardInput';
import {
  fetchReceiptPrintConfig,
  shouldAutoPrintAfterSale,
  applyReceiptPrintPresentation,
  DEFAULT_RECEIPT_PRINT_CONFIG,
  type ReceiptPrintConfig,
} from '../../lib/receiptPrintConfig';
import { computeUomPrices } from '@shared/utils/uom-pricing';
import { previewPosCartTax, saleChargeTotal, previewDocumentTax } from '@shared/utils/documentTaxPreview';
import {
  getCachedTaxSnapshot,
  getTaxCatalogForPreview,
  getProductTaxMappingsForPreview,
  getCachedCustomerTaxProfile,
  isCustomerTaxExemptCached,
  refreshTaxSnapshot,
} from '../../services/offlineCatalogService';
import { ProductCreateSchema } from '@shared/zod/product';
import { POSSaleSchema } from '@shared/zod/pos-sale';
import type { Customer } from '@shared/zod/customer';
import { formatCurrency } from '../../utils/currency';
import { resolvePosCustomerForSale, isPersistedCustomerId } from '../../utils/resolvePosCustomerId';
import {
  getPosLineBaseQuantity,
  getPosLineConversionFactor,
  getPosLineStockAvailability,
  getPosQuantityAfterUomChange,
  getStockInSellingUom,
  isPosQtyOverStockInSellingUom,
  sanitizePosSellingQuantity,
  scaleEngineBasePriceToSellingUom,
} from '../../utils/posCartUom';
import {
  getPosLineMinUnitPrice,
  isPosLineBlockedByCatalogCost,
  recalcPosCartLineFields,
} from '../../utils/posCartLine';
import { buildPosOrderLinePayload } from '../../utils/posOrderLinePayload';
import {
  atCostCartGroupNeedsUpdate,
  applyAllocatedCarryingToCartLine,
  buildAtCostBlendedCartLine,
  buildAtCostSplitCartLines,
  canSplitAtCostLayersToSellingUom,
  layerBaseToSellingQuantity,
  mustSplitAtCostFifoLayers,
  posCartGroupKey,
  type AtCostLayerSegment,
} from '../../utils/posCartAtCost';
import PosUnitPriceInput from '../../components/pos/PosUnitPriceInput';
import { FohLineQtyEditors } from '../../components/foh/FohLineQtyEditors';
import { useCreatePOSSale } from '../../hooks/usePOSSales';
import { useOfflineMode } from '../../hooks/useOfflineMode';
import { useCreateInvoice } from '../../hooks/useApi';
import { api } from '../../utils/api';
import type { ReceiptData } from '../../lib/print';
import {
  buildReceiptDataFromCheckout,
  type CheckoutReceiptInput,
} from '../../lib/receiptFromSale';
import {
  findProductByBarcode,
  preWarmProductCache,
  getProductCatalog,
} from '../../services/barcodeService';
import {
  syncProductCatalog,
  getPersistedCart,
  persistCart,
  clearPersistedCart,
} from '../../services/offlineCatalogService';
import apiClient from '../../utils/api';
import { toast } from 'react-hot-toast';
import { pricingApi } from '../../api/pricing';
import DiscountDialog from '../../components/pos/DiscountDialog';
import TaxOverrideDialog from '../../components/pos/TaxOverrideDialog';
import ManagerApprovalDialog from '../../components/pos/ManagerApprovalDialog';
import type { DocumentTaxOverride } from '@shared/zod/taxOverride';
import { ResumeHoldDialog } from '../../components/pos/ResumeHoldDialog';
import { ServiceInfoBanner } from '../../components/pos/ServiceInfoBanner';
import { ServiceBadge } from '../../components/pos/ServiceBadge';
import AddServiceItemDialog from '../../components/pos/AddServiceItemDialog';
import { RegisterStatusIndicator, OpenRegisterDialog } from '../../components/cash-register';
import ServerClock from '../../components/ServerClock';
import { DatePicker } from '../../components/ui/date-picker';
import { useCurrentSession } from '../../hooks/useCashRegister';
import {
  getPosSessionPolicyDefinition,
  parsePosSessionPolicy,
  posSessionRequiresOpenSession,
} from '@shared/pos/posSessionPolicySsot';
import type { DiscountType, DiscountScope } from '@shared/zod/discount';
import quotationApi from '../../api/quotations';
import type {
  QuickQuoteItemInput,
  Quotation,
  QuotationDetail,
  QuotationItem,
} from '@shared/types/quotation';
import { getQuoteStatusBadge, isQuoteConvertibleFrom } from '@shared/types/quotation';
import type { OfflineSaleData } from '../../hooks/useOfflineMode';
import type { CreateSaleInput } from '../../types/inputs';
import { syncOfflineCustomers } from '../../services/offlineSyncEngine';
import { useAuth } from '../../hooks/useAuth';
import { useDiscountLimitPercent } from '../../authorization/useDiscountLimitPercent';
import { useHasPermission } from '../../authorization/useAuthorization';
import { getBusinessDate, formatTimestampDate, formatTimestampTime } from '../../utils/businessDate';
import {
  isCashierLockdownActive,
  resolveCashierNavItems,
} from '../../utils/cashierLockdown';
import { useRestaurantEnabled } from '../../hooks/useRestaurantEnabled';
import { usePosAssignedStore } from '../../hooks/usePosAssignedStore';

// ── Discount applied from DiscountDialog (before manager approval extension) ──
interface AppliedDiscount {
  type: DiscountType;
  scope: DiscountScope;
  value: number;
  reason: string;
  lineItemIndex?: number;
}

/** Pending discount stored while awaiting manager approval */
interface PendingDiscount extends AppliedDiscount {
  amount: number;
  originalAmount: number;
  discountPercentage: number;
}

/** Shape of a hold-order line item returned by the API */
interface HoldLineItem {
  productId: string | null;
  productName: string;
  productSku: string;
  uomName: string;
  uomId?: string;
  quantity: number;
  unitPrice: number;
  costPrice: number;
  subtotal: number;
  isTaxable: boolean;
  taxRate: number;
  discountAmount?: number;
  productType?: 'inventory' | 'consumable' | 'service';
}

/** Shape of a hold order returned by the API */
interface HoldOrder {
  id: string;
  holdNumber: string;
  customerName?: string;
  discountAmount?: number;
  items: HoldLineItem[];
}

/** Sale record returned from the create-sale API */
interface SaleRecord {
  id: string;
  saleNumber: string;
  sale_number?: string;
  saleDate?: string;
  sale_date?: string;
  createdAt?: string;
  created_at?: string;
  totalAmount?: number;
  total_amount?: number;
  /**
   * Only true for completed `sales` rows — never for hold-orders / offline journal ids.
   * Gates POST /sales/:id/reprint audit (orders are not sales → 404 without this).
   */
  isPersistedSale?: boolean;
}

/** UUID v1–v5 shape — avoids posting offline tokens or sale numbers as path ids. */
function isSaleIdUuid(id: string | null | undefined): boolean {
  if (!id) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(id).trim(),
  );
}

/** Best-effort audit only — never toast on 404/network (print already succeeded). */
function logSaleReceiptPrintAudit(saleId: string | null | undefined, isPersistedSale?: boolean): void {
  if (!isPersistedSale || !isSaleIdUuid(saleId)) return;
  void api
    .post(`/sales/${saleId}/reprint`, undefined, { silentErrorToast: true })
    .catch((err: unknown) => {
      // Dev visibility only — production should not surface failed audit after a good print
      if (import.meta.env.DEV) {
        console.warn('[POS] Receipt print audit skipped/failed', err);
      }
    });
}

/** Format a Date into a receipt-friendly date+time string: DD/MM/YYYY h:mm AM/PM
 *  Always uses business timezone (Africa/Kampala) regardless of browser settings.
 */
function formatReceiptDateTime(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Kampala',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(date);

  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  return `${get('day')}/${get('month')}/${get('year')} ${get('hour')}:${get('minute')} ${get('dayPeriod').toUpperCase()}`;
}

/** Product search result (mirrors POSProductSearch's ProductSearchResult) */
interface POSProductInput {
  id: string;
  name: string;
  sku: string;
  barcode?: string;
  unitOfMeasure?: string;
  costPrice?: number;
  averageCost?: number;
  average_cost?: number;
  costingMethod?: string;
  pricingFormula?: string;
  isTaxable?: boolean;
  taxRate?: number;
  uoms?: Array<{
    uomId: string;
    name: string;
    symbol?: string;
    conversionFactor: number;
    price: number;
    cost: number;
    isDefault: boolean;
  }>;
  selectedUom?: {
    uomId: string;
    name: string;
    symbol?: string;
    conversionFactor: number;
    price: number;
    cost: number;
    isDefault: boolean;
  };
  selectedUomId?: string;
  quantity?: number;
  autoUpdatePrice?: boolean;
  reorderLevel?: number;
  trackExpiry?: boolean;
  stockOnHand?: number;
  productType?: 'inventory' | 'consumable' | 'service';
}

/** Axios-like error shape for typed catch blocks */
interface AxiosLikeError {
  response?: {
    data?: {
      error?: string;
      message?: string;
      success?: boolean;
      error_code?: string;
      details?: Record<string, unknown>;
    };
    status?: number;
  };
  message?: string;
  code?: string;
}

/** Extract error message from unknown catch value */
function getAxiosErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message;
  const axErr = error as AxiosLikeError;
  return axErr?.response?.data?.error || axErr?.message || fallback;
}

/** Shape of invoice settings data from API */
interface InvoiceSettingsData {
  companyName?: string;
  companyAddress?: string | null;
  companyPhone?: string | null;
  companyTin?: string | null;
  footerText?: string | null;
  customReceiptNote?: string | null;
  paymentAccounts?: Array<{
    type: string;
    provider: string;
    accountName: string;
    accountNumber: string;
    branchOrCode?: string;
    isActive: boolean;
    showOnReceipt: boolean;
    showOnInvoice: boolean;
    sortOrder?: number;
  }>;
}

/** Shape of deposit balance data from API */
interface DepositBalanceData {
  availableBalance: number;
}

/** Shape of hold create response data from API */
interface HoldCreateResponseData {
  holdNumber: string;
  id: string;
}

/** Shape of sale creation response from API */
interface SaleCreateResponseData {
  sale: SaleRecord;
  items: unknown[];
  paymentLines: unknown[];
}

// Line item type
interface LineItem {
  id: string;
  name: string;
  sku: string;
  uom: string;
  quantity: number;
  unitPrice: number;
  costPrice: number;
  marginPct: number;
  subtotal: number;
  productType?: 'inventory' | 'consumable' | 'service'; // NEW: Product type
  stockOnHand?: number;
  // Tax support
  isTaxable: boolean;
  taxRate: number;
  // UoM support
  availableUoms?: Array<{
    uomId: string;
    name: string;
    symbol?: string;
    conversionFactor: number;
    price: number;
    cost: number;
    isDefault: boolean;
    /** True when price comes from product_uoms.price_override rather than selling_price × factor */
    priceIsOverridden?: boolean;
    /** The formula-computed price (selling_price × conversionFactor) for invariant checks */
    computedPrice?: number;
  }>;
  selectedUomId?: string;
  baseCost?: number;
  // Discount support
  discount?: {
    type: DiscountType;
    value: number;
    amount: number;
    reason: string;
  };
  /** Cashier overrode unit price; skip automatic repricing until UoM changes. */
  unitPriceManuallySet?: boolean;
  // Pricing engine metadata (shows when customer-group pricing is applied)
  pricingRule?: {
    scope: string;
    ruleName: string | null;
    basePrice: number;
    discount: number;
  };
  /** FIFO batch segment label when AT_COST splits or shows layers. */
  atCostLayerIndex?: number;
  atCostLayerLabel?: string;
  /** Layer breakdown when shown on one blended line (multi-batch, non-splittable UoM). */
  atCostLayers?: AtCostLayerSegment[];
}

function AtCostFifoHint({ item }: { item: LineItem }) {
  const factor = getPosLineConversionFactor(item.availableUoms, item.selectedUomId);

  if (item.atCostLayerIndex !== undefined && item.atCostLayerLabel) {
    return (
      <p className="text-[10px] text-amber-800 font-medium mt-0.5">{item.atCostLayerLabel}</p>
    );
  }

  if (item.atCostLayers && item.atCostLayers.length > 1) {
    return (
      <div className="text-[10px] text-amber-800 mt-0.5 space-y-0.5">
        {item.atCostLayers.map((layer, i) => {
          const sellingQty = layerBaseToSellingQuantity(layer.baseQuantity, factor);
          const qtyLabel = sellingQty != null ? `${sellingQty} ${item.uom}` : `${layer.baseQuantity} base`;
          const unit = new Decimal(layer.unitCostPerBase).times(factor).toNumber();
          const lineTotal = layer.totalCost ?? unit * (sellingQty ?? layer.baseQuantity);
          return (
            <p key={i}>
              FIFO: {qtyLabel} × {formatCurrency(unit)} = {formatCurrency(lineTotal)}
            </p>
          );
        })}
      </div>
    );
  }

  return null;
}

/** Stamps workspace / POS panel attrs inside AdaptiveAppShell (Phase 3). */
function PosWorkspaceSurface({
  tier,
  chrome,
  children,
}: {
  tier: string;
  chrome: { coach: string; numericPad: string; secondaryActions: string; actionLabels: string };
  children: ReactNode;
}) {
  const workspace = useAdaptiveWorkspaceOptional();
  return (
    <div
      className="flex flex-col h-screen bg-gray-50"
      data-pos-tier={tier}
      data-pos-panel={workspace?.posPanelMode ?? undefined}
      data-workspace={workspace?.id}
      data-workspace-nav={workspace?.navPattern}
      data-shell-nav="minimal"
      data-adaptive-coach={chrome.coach}
      data-adaptive-pad={chrome.numericPad}
      data-adaptive-secondary={chrome.secondaryActions}
      data-adaptive-labels={chrome.actionLabels}
    >
      {children}
    </div>
  );
}

export default function POSPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout, permissions } = useAuth();
  const { data: restaurantEnabled = false } = useRestaurantEnabled();
  const { tier, chrome } = useLayoutTier();
  const isWideViewport = useMediaQuery('(min-width: 1600px)');
  const cartColWidths = isWideViewport ? POS_CART_COL_WIDTHS_FULL : POS_CART_COL_WIDTHS_COMPACT;
  const discountLimitPercent = useDiscountLimitPercent();
  const canAccessImport = useHasPermission('admin.create');
  const canAccessSettings = useHasPermission('system.read');
  const canAccessRolesUpdate = useHasPermission('system.roles_update');
  const canAccessRolesAdmin = useHasPermission('admin.update');
  const canAccessRoles = canAccessRolesUpdate || canAccessRolesAdmin;
  const canTaxOverride = useHasPermission('sales.tax_override');
  const canApproveSales = useHasPermission('sales.approve');
  const { data: assignedStore } = usePosAssignedStore();
  const [showNavDrawer, setShowNavDrawer] = useState(false);
  const [items, setItems] = useState<LineItem[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<
    'CASH' | 'CARD' | 'MOBILE_MONEY' | 'AIRTEL_MONEY' | 'CREDIT' | 'DEPOSIT'
  >('CASH');

  // Cash register session + policy + transaction mode (single API call, no dual queries)
  const { data: currentSession, posSessionPolicy, posTransactionMode, isLoading: isLoadingSession, isError: isSessionError, refetch: refetchSession } = useCurrentSession();
  const sessionPolicy = parsePosSessionPolicy(posSessionPolicy);
  const sessionPolicyDef = getPosSessionPolicyDefinition(sessionPolicy);
  const sessionEnforced = posSessionRequiresOpenSession(sessionPolicy);
  const isOrderMode = posTransactionMode === 'OrderToPayment';

  // State for showing open register dialog when required
  const [showOpenRegisterDialog, setShowOpenRegisterDialog] = useState(false);

  // Service item dialog state
  const [showServiceItemDialog, setShowServiceItemDialog] = useState(false);

  // Check if register is open - sales blocked without this
  const hasOpenRegister = !!currentSession;

  // Customer deposit balance state
  const [customerDepositBalance, setCustomerDepositBalance] = useState<number>(0);
  const [isLoadingDeposits, setIsLoadingDeposits] = useState(false);

  // Split payment state
  const [paymentLines, setPaymentLines] = useState<
    Array<{
      id: string;
      paymentMethodId: string;
      paymentMethod: 'CASH' | 'CARD' | 'MOBILE_MONEY' | 'AIRTEL_MONEY' | 'CREDIT' | 'DEPOSIT';
      amount: number;
      reference?: string;
      createdAt: string;
    }>
  >([]);

  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentReference, setPaymentReference] = useState('');
  const [isProcessingSale, setIsProcessingSale] = useState(false);
  /** Tenant tax_inclusive from /system-settings (SSOT beyond offline snapshot). */
  const [tenantTaxInclusive, setTenantTaxInclusive] = useState<boolean | null>(null);
  /** Bumps after tax snapshot sync so taxInclusive charge re-renders. */
  const [taxSnapshotRev, setTaxSnapshotRev] = useState(0);
  const [focusedCartIndex, setFocusedCartIndex] = useState<number>(-1);
  const [showUomModal, setShowUomModal] = useState(false);
  const [uomModalItemIndex, setUomModalItemIndex] = useState<number>(-1);
  const [selectedUomIndex, setSelectedUomIndex] = useState<number>(0);
  const cartRowRefs = useRef<(HTMLElement | null)[]>([]);
  const uomButtonRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const productSearchRef = useRef<POSProductSearchHandle>(null);
  const isSubmittingRef = useRef(false); // Immediate duplicate check
  const createSale = useCreatePOSSale();
  // createInvoice kept for future manual invoice creation
  useCreateInvoice();

  // Order mode state
  const [isCreatingOrder, setIsCreatingOrder] = useState(false);
  const { isOnline, saveSaleOffline, saveOrderOffline, syncPendingSales, syncQueue, retryFailedSale, retryAllFailed, cancelOfflineSale, pendingCount, reviewCount, failedCount } =
    useOfflineMode();
  const [showSyncPanel, setShowSyncPanel] = useState(false);
  const [showReceiptModal, setShowReceiptModal] = useState(false);
  const [showPrintDialog, setShowPrintDialog] = useState(false);
  const [receiptAutoPrint, setReceiptAutoPrint] = useState(false);
  const [receiptPrintEnabled, setReceiptPrintEnabled] = useState(true);
  const [receiptPrinterName, setReceiptPrinterName] = useState<string | null>(null);
  const receiptPrintConfigRef = useRef<ReceiptPrintConfig | null>(null);
  const [receiptData, setReceiptData] = useState<ReceiptData | null>(null);
  const [lastSale, setLastSale] = useState<SaleRecord | null>(null);
  const [autoCreateInvoice, setAutoCreateInvoice] = useState(true); // Toggle for auto-invoice on credit sales
  const [invoiceCreated, setInvoiceCreated] = useState(false);
  const [saleDate, setSaleDate] = useState<string>(''); // For backdated sales (empty = current date)
  const [showDatePicker, setShowDatePicker] = useState(false); // Toggle date picker visibility

  // Phase 5 — privileged DocumentTax override
  const [showTaxOverrideDialog, setShowTaxOverrideDialog] = useState(false);
  const [taxOverride, setTaxOverride] = useState<DocumentTaxOverride | null>(null);

  // Discount state
  const [showDiscountDialog, setShowDiscountDialog] = useState(false);
  const [discountTarget, setDiscountTarget] = useState<{
    type: 'cart' | 'item';
    itemIndex?: number;
  } | null>(null);
  const [cartDiscount, setCartDiscount] = useState<{
    type: DiscountType;
    value: number;
    amount: number;
    reason: string;
  } | null>(null);
  /** Store credit from Sales → Exchange (applied as cart discount on replacement sale) */
  const [exchangeCredit, setExchangeCredit] = useState<{
    refundId: string;
    refundNumber: string;
    saleNumber: string;
    amount: number;
    customerId?: string | null;
    customerName?: string | null;
  } | null>(null);
  /** Leftover after cheaper replacement: pay out vs keep voucher */
  const [exchangeResidualAction, setExchangeResidualAction] = useState<
    'REFUND_ORIGINAL_TENDER' | 'KEEP_VOUCHER'
  >('REFUND_ORIGINAL_TENDER');
  const [showManagerApprovalDialog, setShowManagerApprovalDialog] = useState(false);
  const [pendingDiscount, setPendingDiscount] = useState<PendingDiscount | null>(null);

  // Below-cost sale block state
  const [showBelowCostOverrideDialog, setShowBelowCostOverrideDialog] = useState(false);
  const [belowCostItems, setBelowCostItems] = useState<Array<{ name: string; unitPrice: number; costPrice: number }>>([]);

  // Hold/Resume Cart state
  const [showResumeDialog, setShowResumeDialog] = useState(false);
  const [heldOrdersCount, setHeldOrdersCount] = useState(0);

  // Invoice settings for receipt branding
  const [invoiceSettings, setInvoiceSettings] = useState<{
    companyName?: string;
    companyAddress?: string | null;
    companyPhone?: string | null;
    companyTin?: string | null;
    footerText?: string | null;
    customReceiptNote?: string | null;
    paymentAccounts?: InvoiceSettingsData['paymentAccounts'];
  } | null>(null);

  // Quote state
  const [showSaveQuoteDialog, setShowSaveQuoteDialog] = useState(false);
  const [showLoadQuoteDialog, setShowLoadQuoteDialog] = useState(false);
  const [showQuoteSuccessDialog, setShowQuoteSuccessDialog] = useState(false);
  const [savedQuoteData, setSavedQuoteData] = useState<QuotationDetail | null>(null);
  const [loadedQuoteId, setLoadedQuoteId] = useState<string | null>(null); // Track loaded quote for auto-conversion
  const [quoteCustomerName, setQuoteCustomerName] = useState('');
  const [quoteCustomerPhone, setQuoteCustomerPhone] = useState('');
  const [quoteNotes, setQuoteNotes] = useState('');
  const [quoteValidityDays, setQuoteValidityDays] = useState(30);
  const [isSavingQuote, setIsSavingQuote] = useState(false);
  const [quotesCount, setQuotesCount] = useState(0);
  const [quoteSearchTerm, setQuoteSearchTerm] = useState('');
  const [availableQuotes, setAvailableQuotes] = useState<Quotation[]>([]);
  const [isLoadingQuotes, setIsLoadingQuotes] = useState(false);

  // Get current user from localStorage (recompute when localStorage changes)
  const currentUser = useMemo(() => {
    try {
      const userStr = localStorage.getItem('user');
      const token = localStorage.getItem('auth_token');
      const user = userStr ? JSON.parse(userStr) : null;
      return user && token ? { ...user, token } : null;
    } catch {
      return null;
    }
  }, []);

  const makePosReceiptData = useCallback(
    (input: Omit<CheckoutReceiptInput, 'cashierName' | 'customer' | 'invoiceSettings'>) => {
      const itemsWithTax = (input.items || []).map((item) => {
        const rate = Number(item.taxRate || 0);
        const estimated =
          item.taxAmount != null
            ? Number(item.taxAmount)
            : item.isTaxable && rate > 0
              ? new Decimal(item.subtotal || 0).mul(rate).div(100).toNumber()
              : undefined;
        return {
          ...item,
          taxRate: rate > 0 ? rate : item.taxRate,
          taxAmount: estimated,
          isTaxable: item.isTaxable === true || (rate > 0 && Number(estimated || 0) > 0),
        };
      });
      const base = buildReceiptDataFromCheckout({
        ...input,
        items: itemsWithTax,
        cashierName: currentUser?.fullName,
        customer: selectedCustomer
          ? {
              name: selectedCustomer.name,
              phone: selectedCustomer.phone,
              email: selectedCustomer.email,
            }
          : undefined,
        invoiceSettings,
      });
      return applyReceiptPrintPresentation(base, receiptPrintConfigRef.current, {
        taxName: undefined,
      });
    },
    [currentUser?.fullName, selectedCustomer, invoiceSettings]
  );

  /** After payment: show sale complete; auto-open print dialog when auto-print is on. */
  const presentSaleReceipt = useCallback(
    (opts?: { preferAutoPrint?: boolean }) => {
      const auto =
        opts?.preferAutoPrint !== false &&
        shouldAutoPrintAfterSale(receiptPrintConfigRef.current ?? {
          ...DEFAULT_RECEIPT_PRINT_CONFIG,
          autoPrint: receiptAutoPrint,
        });
      setShowReceiptModal(true);
      if (auto) {
        setShowPrintDialog(true);
      }
    },
    [receiptAutoPrint],
  );

  // ── Fullscreen: enter fullscreen when not already in standalone/fullscreen mode ──
  useEffect(() => {
    const isStandalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      ('standalone' in window.navigator &&
        (window.navigator as { standalone?: boolean }).standalone === true);
    if (!isStandalone && document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(() => {
        // requestFullscreen requires a user gesture in some browsers; silently ignore
      });
    }
  }, []);

  // Watch for storage changes (login/logout events)
  const [storageVersion, setStorageVersion] = useState(0);

  useEffect(() => {
    const handleStorageChange = () => {
      setStorageVersion((prev) => prev + 1);
    };

    window.addEventListener('storage', handleStorageChange);
    // Also listen for custom events from same window
    window.addEventListener('auth-changed', handleStorageChange);

    return () => {
      window.removeEventListener('storage', handleStorageChange);
      window.removeEventListener('auth-changed', handleStorageChange);
    };
  }, []);

  // Recompute current user when storage changes
  const activeUser = useMemo(() => {
    try {
      const userStr = localStorage.getItem('user');
      const token = localStorage.getItem('auth_token');
      const user = userStr ? JSON.parse(userStr) : null;
      return user && token ? { ...user, token } : null;
    } catch {
      return null;
    }
  }, [storageVersion]);

  // Fetch invoice settings for receipt branding (note, footer, payment accounts, company)
  useEffect(() => {
    const applyInvoiceSettings = (settingsData: InvoiceSettingsData) => {
      setInvoiceSettings({
        companyName: settingsData.companyName,
        companyAddress: settingsData.companyAddress,
        companyPhone: settingsData.companyPhone,
        companyTin: settingsData.companyTin,
        footerText: settingsData.footerText,
        customReceiptNote: settingsData.customReceiptNote,
        paymentAccounts: settingsData.paymentAccounts,
      });
    };

    const fetchInvoiceSettings = async () => {
      try {
        const response = await api.settings.getInvoiceSettings();
        if (response.data?.success && response.data?.data) {
          applyInvoiceSettings(response.data.data as InvoiceSettingsData);
        }
      } catch (error) {
        console.error('Failed to fetch invoice settings:', error);
      }
    };

    const loadPrintConfig = async () => {
      const cfg = await fetchReceiptPrintConfig();
      receiptPrintConfigRef.current = cfg;
      setReceiptAutoPrint(cfg.autoPrint);
      setReceiptPrintEnabled(cfg.enabled !== false);
      setReceiptPrinterName(cfg.printerName ?? null);
    };

    fetchInvoiceSettings();
    loadPrintConfig();
    void refreshTaxSnapshot()
      .then(() => setTaxSnapshotRev((n) => n + 1))
      .catch((err) => {
        console.warn('[POSPage] Tax snapshot refresh failed', err);
      });

    void apiClient
      .get<{ success?: boolean; data?: { taxInclusive?: boolean } }>('system-settings')
      .then((res) => {
        const row = res.data?.data;
        if (row && typeof row.taxInclusive === 'boolean') {
          setTenantTaxInclusive(row.taxInclusive);
        }
      })
      .catch((err) => {
        console.warn('[POSPage] system-settings taxInclusive load failed', err);
      });

    // Refresh when returning to POS — deferred via resume coordinator (after auth refresh).
    const unregisterResume = registerSessionResume(
      () => {
        fetchInvoiceSettings();
        loadPrintConfig();
        void refreshTaxSnapshot().then(() => setTaxSnapshotRev((n) => n + 1));
        void apiClient
          .get<{ success?: boolean; data?: { taxInclusive?: boolean } }>('system-settings')
          .then((res) => {
            const row = res.data?.data;
            if (row && typeof row.taxInclusive === 'boolean') {
              setTenantTaxInclusive(row.taxInclusive);
            }
          })
          .catch(() => undefined);
      },
      { phase: 'after', delayMs: 900 },
    );
    return () => unregisterResume();
  }, []);

  // Re-sync catalog when coming back online
  // NOTE: Sale syncing is handled exclusively by OfflineAutoSync to prevent
  // duplicate sync races between this useEffect and the auto-sync timer.
  useEffect(() => {
    if (isOnline) {
      syncProductCatalog().catch((err) => {
        console.error('[POSPage] Failed to sync product catalog:', err);
      });
    }
  }, [isOnline]);

  // Product exchange credit from Sales → Exchange flow
  useEffect(() => {
    const raw = sessionStorage.getItem('pos_exchange_credit');
    if (!raw) return;
    sessionStorage.removeItem('pos_exchange_credit');
    try {
      const credit = JSON.parse(raw) as {
        refundId?: string;
        amount?: number;
        saleNumber?: string;
        refundNumber?: string;
        customerId?: string | null;
        customerName?: string | null;
      };
      if (credit.amount && credit.amount > 0 && credit.refundId) {
        setExchangeCredit({
          refundId: credit.refundId,
          refundNumber: credit.refundNumber || '',
          saleNumber: credit.saleNumber || 'prior sale',
          amount: credit.amount,
          customerId: credit.customerId,
          customerName: credit.customerName,
        });
        toast.success(
          `Exchange credit ${formatCurrency(credit.amount)} from ${credit.saleNumber || 'prior sale'}. It will apply when you add replacement items.`,
          { duration: 8000 }
        );
      }
    } catch {
      /* ignore corrupt session payload */
    }
  }, []);

  // Auto-apply exchange credit as cart discount (capped at subtotal)
  useEffect(() => {
    if (!exchangeCredit || items.length === 0) return;
    const lineSubtotal = items.reduce((sum, i) => new Decimal(sum).plus(i.subtotal).toNumber(), 0);
    if (lineSubtotal <= 0) return;
    const creditToApply = Math.min(exchangeCredit.amount, lineSubtotal);
    setCartDiscount({
      type: 'FIXED_AMOUNT',
      value: creditToApply,
      amount: creditToApply,
      reason: `Exchange credit ${exchangeCredit.refundNumber} (${exchangeCredit.saleNumber})`,
    });
  }, [exchangeCredit, items]);

  // Check for quote to load on mount (from quotations page) and restore customer
  useEffect(() => {
    const loadQuoteNumber = localStorage.getItem('loadQuoteNumber');
    if (loadQuoteNumber) {
      localStorage.removeItem('loadQuoteNumber');
      // Delay to allow component to fully mount
      setTimeout(async () => {
        try {
          const response = await quotationApi.getQuotationByNumber(loadQuoteNumber);
          const quote = response.quotation;
          if (!quote || !isQuoteConvertibleFrom(quote)) {
            toast.error(`Quote ${loadQuoteNumber} is no longer available for conversion`);
            return;
          }
          await handleLoadQuoteToCart(response);
          toast.success(`Quote ${loadQuoteNumber} loaded!`, { duration: 3000 });
        } catch (error) {
          console.error('Failed to load quote:', error);
          toast.error(`Failed to load quote ${loadQuoteNumber}`);
        }
      }, 500);
    } else {
      // Check if we have a previously loaded quote customer to restore
      const savedCustomer = localStorage.getItem('pos_loaded_quote_customer');
      if (savedCustomer && !selectedCustomer) {
        try {
          const customerData = JSON.parse(savedCustomer);
          // Only restore if there's also a persisted cart (quote items) to go with it
          const savedCart = localStorage.getItem('pos_persisted_cart_v1');
          if (savedCart) {
            const cartData = JSON.parse(savedCart);
            if (cartData?.items?.length > 0) {
              if (isPersistedCustomerId(customerData?.id)) {
                console.log('📋 Restoring previously loaded quote customer:', customerData);
                setSelectedCustomer(customerData);
              } else {
                console.warn('📋 Skipping temp/offline quote customer restore:', customerData?.id);
                localStorage.removeItem('pos_loaded_quote_customer');
              }
            } else {
              localStorage.removeItem('pos_loaded_quote_customer');
            }
          } else {
            localStorage.removeItem('pos_loaded_quote_customer');
          }
        } catch (error) {
          console.error('Failed to restore quote customer:', error);
          localStorage.removeItem('pos_loaded_quote_customer');
        }
      }
    }
  }, []);

  // Fetch held orders count on mount and after relevant actions (no polling)
  useEffect(() => {
    const fetchHeldOrdersCount = async () => {
      if (activeUser?.id && activeUser?.token) {
        try {
          const response = await api.hold.list();
          if (response.data.success) {
            const holdList = response.data.data as HoldOrder[] | undefined;
            const count = holdList?.length || 0;
            setHeldOrdersCount(count);
          }
        } catch (error) {
          console.error('Failed to fetch held orders count:', error);
        }
      } else {
        setHeldOrdersCount(0);
      }
    };

    if (activeUser?.token) {
      fetchHeldOrdersCount();
    } else {
      setHeldOrdersCount(0);
    }
  }, [activeUser?.id, activeUser?.token, storageVersion]);

  // Helper function to refresh held orders count manually
  const refreshHeldOrdersCount = useCallback(async () => {
    if (activeUser?.id && activeUser?.token) {
      try {
        const response = await api.hold.list();
        if (response.data.success) {
          const holdList = response.data.data as HoldOrder[] | undefined;
          setHeldOrdersCount(holdList?.length || 0);
        }
      } catch (error) {
        console.error('Failed to refresh held orders count:', error);
      }
    }
  }, [activeUser?.id, activeUser?.token]);

  // Fetch customer deposit balance when a persisted customer is selected
  useEffect(() => {
    const fetchCustomerDepositBalance = async () => {
      if (!selectedCustomer?.id || !isPersistedCustomerId(selectedCustomer.id)) {
        setCustomerDepositBalance(0);
        return;
      }

      const customerId = selectedCustomer.id;
      console.log(
        '🔍 Fetching deposit balance for customer:',
        customerId,
        selectedCustomer.name
      );
      setIsLoadingDeposits(true);
      try {
        const response = await api.deposits.getCustomerBalance(customerId);
        console.log('📦 Deposit balance response:', response.data);
        if (response.data?.success && response.data?.data) {
          const depositData = response.data.data as DepositBalanceData;
          setCustomerDepositBalance(depositData.availableBalance || 0);
          console.log('💰 Customer deposit balance:', depositData.availableBalance);
        } else {
          console.warn('⚠️ Deposit balance response was not successful:', response.data);
          setCustomerDepositBalance(0);
        }
      } catch (error: unknown) {
        console.error(
          '❌ Failed to fetch customer deposit balance:',
          getAxiosErrorMessage(error, 'Unknown error')
        );
        setCustomerDepositBalance(0);
      } finally {
        setIsLoadingDeposits(false);
      }
    };

    fetchCustomerDepositBalance();
  }, [selectedCustomer?.id]);

  // Stable key of cart — aggregate qty per product+UoM for AT_COST FIFO repricing
  const itemsPricingKey = useMemo(() => {
    const groups = new Map<string, number>();
    for (const it of items) {
      if (it.id.startsWith('custom_')) continue;
      const k = posCartGroupKey(it.id, it.selectedUomId);
      groups.set(k, (groups.get(k) ?? 0) + it.quantity);
    }
    return [...groups.entries()].map(([k, q]) => `${k}:${q}`).join(',');
  }, [items]);

  // ========== PRICING ENGINE: Reprice cart when customer or lines change ==========
  // Walk-in included: allocatedCostPerBase is the FEFO carrying floor after lot write-down.
  // Manual unit prices are kept; cost floor still syncs.
  useEffect(() => {
    if (items.length === 0) return;

    const repriceCart = async () => {
      const regularItems = items.filter((it) => !it.id.startsWith('custom_'));
      if (regularItems.length === 0) return;

      type PricingGroup = {
        key: string;
        productId: string;
        selectedUomId?: string;
        totalQty: number;
        template: LineItem;
        hasManualUnitPrice: boolean;
      };

      const groups = new Map<string, PricingGroup>();
      for (const item of regularItems) {
        const key = posCartGroupKey(item.id, item.selectedUomId);
        const existing = groups.get(key);
        if (existing) {
          existing.totalQty += item.quantity;
          existing.hasManualUnitPrice = existing.hasManualUnitPrice || !!item.unitPriceManuallySet;
        } else {
          groups.set(key, {
            key,
            productId: item.id,
            selectedUomId: item.selectedUomId,
            totalQty: item.quantity,
            template: item,
            hasManualUnitPrice: !!item.unitPriceManuallySet,
          });
        }
      }

      if (groups.size === 0) return;

      try {
        const bulkInput = [...groups.values()].map((g) => ({
          productId: g.productId,
          quantity: g.totalQty,
          baseQuantity: getPosLineBaseQuantity(
            g.totalQty,
            g.template.availableUoms,
            g.selectedUomId,
          ),
        }));

        const resolved = await pricingApi.calculateBulkPrices(
          bulkInput,
          isPersistedCustomerId(selectedCustomer?.id) ? selectedCustomer?.id : undefined,
        );

        setItems((prev) => {
          let changed = false;
          const customOnly = prev.filter((i) => i.id.startsWith('custom_'));
          const repriced: LineItem[] = [];

          const groupList = [...groups.values()];
          groupList.forEach((group, groupIndex) => {
            const price = resolved[groupIndex];
            if (!price) {
              prev
                .filter(
                  (i) =>
                    !i.id.startsWith('custom_') &&
                    posCartGroupKey(i.id, i.selectedUomId) === group.key,
                )
                .forEach((i) => repriced.push(i));
              return;
            }

            const factor = getPosLineConversionFactor(
              group.template.availableUoms,
              group.selectedUomId,
            );
            const scaledFinalPrice = scaleEngineBasePriceToSellingUom(
              price.finalPrice,
              group.template.availableUoms,
              group.selectedUomId,
            );
            const scaledBasePrice = scaleEngineBasePriceToSellingUom(
              price.basePrice,
              group.template.availableUoms,
              group.selectedUomId,
            );
            const allocatedSelling =
              price.allocatedCostPerBase != null && price.allocatedCostPerBase > 0
                ? scaleEngineBasePriceToSellingUom(
                    price.allocatedCostPerBase,
                    group.template.availableUoms,
                    group.selectedUomId,
                  )
                : null;
            const isAtCostRule = price.appliedRule.scope === 'at_cost';
            const isAtCostIssuePrice =
              isAtCostRule || selectedCustomer?.pricingMode === 'AT_COST';
            const layers = (price.atCostLayers ?? price.allocatedLayers ?? []) as AtCostLayerSegment[];
            const pricingRule =
              price.appliedRule.scope !== 'base'
                ? {
                    scope: price.appliedRule.scope,
                    ruleName: price.appliedRule.ruleName,
                    basePrice: scaledBasePrice,
                    discount: price.discount,
                  }
                : undefined;

            const oldLines = prev.filter(
              (i) =>
                !i.id.startsWith('custom_') &&
                posCartGroupKey(i.id, i.selectedUomId) === group.key,
            );

            const sellingUnitPrice =
              isAtCostIssuePrice
                ? scaledFinalPrice
                : group.hasManualUnitPrice
                  ? group.template.unitPrice
                  : scaledFinalPrice;

            if (
              isAtCostRule &&
              !group.hasManualUnitPrice &&
              mustSplitAtCostFifoLayers(layers, group.totalQty, scaledFinalPrice) &&
              canSplitAtCostLayersToSellingUom(layers, factor)
            ) {
              const splitLines = buildAtCostSplitCartLines(
                { ...group.template, discount: undefined },
                layers,
                pricingRule,
              ) as LineItem[];
              if (atCostCartGroupNeedsUpdate(oldLines, splitLines, true)) changed = true;
              repriced.push(...splitLines);
              return;
            }

            const blended = buildAtCostBlendedCartLine(
              group.template,
              group.totalQty,
              sellingUnitPrice,
              layers,
              pricingRule,
              isAtCostIssuePrice,
            ) as LineItem;
            const withCost = applyAllocatedCarryingToCartLine(blended, allocatedSelling);
            const withLayers: LineItem = {
              ...withCost,
              atCostLayers:
                isAtCostRule && layers.length > 1 ? layers : undefined,
              unitPriceManuallySet: group.hasManualUnitPrice,
            };
            if (atCostCartGroupNeedsUpdate(oldLines, [withLayers], isAtCostRule)) changed = true;
            if (Math.abs(withLayers.costPrice - (oldLines[0]?.costPrice ?? -1)) > 0.009) changed = true;
            repriced.push(withLayers);
          });

          if (!changed) return prev;
          return [...customOnly, ...repriced];
        });
      } catch (err) {
        console.warn('Pricing engine bulk resolution failed, keeping current prices', err);
      }
    };

    repriceCart();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCustomer?.id, itemsPricingKey]);

  // ========== PRICING ENGINE: Revert prices when customer is cleared ==========
  // When the customer is deselected, revert any engine-adjusted prices back to base.
  const prevCustomerRef = useRef<string | null>(null);
  useEffect(() => {
    const prevId = prevCustomerRef.current;
    prevCustomerRef.current = selectedCustomer?.id ?? null;

    // Only revert when customer was removed (had a customer, now don't)
    if (prevId && !selectedCustomer?.id && items.length > 0) {
      setItems((prev) => {
        let changed = false;
        const reverted = prev.map((item) => {
          if (!item.pricingRule) return item;
          changed = true;
          const basePrice = item.pricingRule.basePrice;
          return {
            ...item,
            ...recalcPosCartLineFields({
              quantity: item.quantity,
              unitPrice: basePrice,
              costPrice: item.costPrice,
              discount: item.discount,
            }),
            pricingRule: undefined,
          };
        });
        return changed ? reverted : prev;
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCustomer?.id]);

  // Pre-warm product cache AND sync full catalog on mount
  useEffect(() => {
    if (activeUser?.token) {
      const timer = setTimeout(() => {
        // Pre-warm barcode cache
        preWarmProductCache().catch((err) => {
          console.error('Failed to pre-warm product cache:', err);
        });
        // Sync full POS product catalog for offline search
        if (navigator.onLine) {
          syncProductCatalog()
            .then((products) => {
              console.log(`[OfflineCatalog] Synced ${products.length} products for offline use`);
            })
            .catch((err) => {
              console.error('[OfflineCatalog] Failed to sync catalog:', err);
            });
        }
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [activeUser?.token]);

  // ── Cart persistence: restore on mount (sanitize legacy MUoM float qty) ──
  useEffect(() => {
    const saved = getPersistedCart<LineItem[]>();
    if (saved && saved.length > 0 && items.length === 0) {
      const sanitized = saved.map((item) => {
        const quantity = sanitizePosSellingQuantity(
          item.quantity,
          item.availableUoms,
          item.selectedUomId,
        );
        if (quantity === item.quantity) return item;
        return {
          ...item,
          ...recalcPosCartLineFields({
            quantity,
            unitPrice: item.unitPrice,
            costPrice: item.costPrice,
            discount: item.discount,
          }),
        };
      });
      setItems(sanitized);
      console.log('[CartPersist] Restored', sanitized.length, 'items from localStorage');
    }
  }, []);

  // ── Cart persistence: save on every change ──
  useEffect(() => {
    if (items.length > 0) {
      persistCart(items);
    } else {
      clearPersistedCart();
    }
  }, [items]);

  // Barcode scanner support with UoM detection
  const handleBarcodeScanned = useCallback(async (barcode: string) => {
    try {
      // Get cached product catalog for offline support
      const products = await getProductCatalog();

      // Find product by barcode (checks product + UoM barcodes)
      const match = findProductByBarcode(barcode, products);

      if (!match) {
        toast.error(`Product not found: ${barcode}`);
        // Play error beep
        const errorBeep = new Audio(
          'data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgA'
        );
        errorBeep.play().catch(() => { });
        return;
      }

      // Check stock availability before adding to cart
      let stockOnHand: number | undefined;
      try {
        const stockRes = await api.inventory.stockLevelByProduct(match.product.id);
        const stockData = stockRes.data?.data as Record<string, unknown> | undefined;
        stockOnHand = stockData ? parseFloat(String(stockData.total_stock ?? stockData.quantity_on_hand ?? 0)) : undefined;
      } catch {
        // If stock check fails, let backend validate at checkout
        stockOnHand = undefined;
      }

      // Add product to cart with correct UoM
      const productWithUom: POSProductInput = {
        id: match.product.id,
        name: match.product.name,
        sku: '',
        barcode: match.product.barcode || undefined,
        selectedUomId: match.uom.id,
        quantity: match.defaultQuantity,
        stockOnHand,
      };

      handleAddProduct(productWithUom);

      // Success feedback
      toast.success(`Added: ${match.product.name} (${match.uom.name})`);
      const successBeep = new Audio(
        'data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgodDbq2EcBj+a2/LDciUFLIHO8tiJNwgZaLvt559NEAxQp+PwtmMcBjiR1/LMeSwFJHfH8N2QQAoUXrTp66hVFApGn+DyvmwhBztH1/LJfiwE'
      );
      successBeep.play().catch(() => { });
    } catch (error) {
      console.error('Barcode scan error:', error);
      toast.error('Barcode scanning failed');
    }
  }, []);

  // Barcode scanning: AdaptiveScanner (HID + optional camera) → same handleBarcodeScanned
  // (presentation only — product lookup stays in handleBarcodeScanned)

  // Auto-clear discounts when cart becomes empty
  useEffect(() => {
    if (items.length === 0) {
      setCartDiscount(null);
      // Also clear any line-item discounts (already cleared since items array is empty)
    }
  }, [items.length]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Shift+Enter: Open payment modal (DirectSale) or Save Order (OrderToPayment)
      if (e.shiftKey && e.key === 'Enter' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        if (items.length > 0) {
          if (isOrderMode) {
            handleCreateOrder();
          } else if (!showPaymentModal) {
            setShowPaymentModal(true);
          }
        }
        return;
      }

      // Ctrl+D: Open discount dialog for cart
      if (e.ctrlKey && e.key === 'd') {
        e.preventDefault();
        if (items.length > 0) handleOpenDiscountDialog('cart');
        return;
      }

      // Ctrl+H: Hold cart or Retrieve holds
      if (e.ctrlKey && e.key.toLowerCase() === 'h') {
        e.preventDefault();
        handleHoldRetrieveToggle();
        return;
      }

      // Ctrl+Q: Smart Quote Toggle (Save if cart has items, Load if cart empty)
      if (e.ctrlKey && e.key.toLowerCase() === 'q') {
        e.preventDefault();
        handleQuoteToggle();
        return;
      }

      // Ctrl+J: Add Service / Non-Inventory Item
      if (e.ctrlKey && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        setShowServiceItemDialog(true);
        return;
      }

      // Ctrl+Enter: Finalize sale (when payment modal open)
      if (e.ctrlKey && e.key === 'Enter') {
        e.preventDefault();
        if (items.length > 0 && showPaymentModal) handleFinalizeSale();
        return;
      }

      // Cart navigation: Only when cart has items and not in modals
      if (items.length > 0 && !showPaymentModal && !showUomModal) {
        // Arrow Down: Move to next cart item
        if (e.key === 'ArrowDown' && e.ctrlKey) {
          e.preventDefault();
          setFocusedCartIndex((prev) => {
            const newIndex = Math.min(prev + 1, items.length - 1);
            // Focus the row
            setTimeout(() => {
              const row = cartRowRefs.current[newIndex];
              if (row) {
                const firstInput = row.querySelector('input, select') as HTMLElement;
                if (firstInput) firstInput.focus();
              }
            }, 0);
            return newIndex;
          });
          return;
        }

        // Arrow Up: Move to previous cart item
        if (e.key === 'ArrowUp' && e.ctrlKey) {
          e.preventDefault();
          setFocusedCartIndex((prev) => {
            const newIndex = Math.max(prev - 1, 0);
            // Focus the row
            setTimeout(() => {
              const row = cartRowRefs.current[newIndex];
              if (row) {
                const firstInput = row.querySelector('input, select') as HTMLElement;
                if (firstInput) firstInput.focus();
              }
            }, 0);
            return newIndex;
          });
          return;
        }

        // Ctrl+U: Open UoM selector for focused item
        if (e.ctrlKey && e.key === 'u' && focusedCartIndex >= 0) {
          e.preventDefault();
          const item = items[focusedCartIndex];
          if (item.availableUoms && item.availableUoms.length > 1) {
            setUomModalItemIndex(focusedCartIndex);
            setShowUomModal(true);
            // Focus will be set by useEffect after modal opens
          }
          return;
        }

        // Delete: Remove focused cart item
        if (e.key === 'Delete' && focusedCartIndex >= 0) {
          e.preventDefault();
          setItems((prev) => prev.filter((_, i) => i !== focusedCartIndex));
          setFocusedCartIndex(-1);
          return;
        }
      }

      // Escape: Close modals (only if not handled above)
      if (e.key === 'Escape') {
        if (showPaymentModal) {
          setShowPaymentModal(false);
        }
        return;
      }

      // Ctrl+Shift+C: Clear ALL data (cart + localStorage)
      if (e.ctrlKey && e.shiftKey && e.key === 'C') {
        e.preventDefault();
        handleClearAllData();
        return;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [items, showPaymentModal, showUomModal, focusedCartIndex, uomModalItemIndex, isOrderMode]);

  // Clear all data (cart + localStorage offline data)
  const handleClearAllData = () => {
    const confirmed = window.confirm(
      '⚠️ Clear ALL Data?\n\n' +
      'This will clear:\n' +
      '• Current cart items\n' +
      '• Customer selection\n' +
      '• All discounts\n' +
      '• Offline sales queue\n' +
      '• Persisted cart backup\n\n' +
      'This action cannot be undone!'
    );

    if (!confirmed) return;

    try {
      // Clear in-memory state
      setItems([]);
      setSelectedCustomer(null);
      setCartDiscount(null);
      setTaxOverride(null);
      setPaymentLines([]);
      setPaymentAmount('');
      setPaymentReference('');
      setSaleDate('');
      setShowDatePicker(false);

      // Clear localStorage offline data
      localStorage.removeItem('pos_persisted_cart_v1');
      localStorage.removeItem('pos_offline_sales');
      localStorage.removeItem('pos_offline_orders');
      localStorage.removeItem('pos_offline_events');
      localStorage.removeItem('pos_sync_state');
      localStorage.removeItem('pos_product_catalog');
      localStorage.removeItem('pos_local_stock');
      localStorage.removeItem('pos_catalog_last_sync');
      localStorage.removeItem('inventory_items');
      localStorage.removeItem('pos_loaded_quote_customer');

      toast.success('✅ All data cleared successfully');
      console.log('🗑️ All POS data cleared (cart + localStorage)');
    } catch (error) {
      console.error('Error clearing data:', error);
      toast.error('Failed to clear some data');
    }
  };

  // Reset and auto-focus UoM modal when it opens
  useEffect(() => {
    if (showUomModal && uomModalItemIndex >= 0) {
      setSelectedUomIndex(0);
      // Auto-focus first UoM button after modal renders
      const timer = setTimeout(() => {
        const firstButton = uomButtonRefs.current[0];
        if (firstButton) {
          firstButton.focus();
        }
      }, 150); // Slightly longer delay to ensure modal is fully rendered

      return () => clearTimeout(timer);
    }
  }, [showUomModal, uomModalItemIndex]);

  // Add product handler
  const handleAddProduct = useCallback(
    (product: POSProductInput) => {
      // Block 0-stock inventory products (services/consumables are exempt)
      const isService = product.productType === 'service' || product.productType === 'consumable';
      if (!isService && product.stockOnHand !== undefined && product.stockOnHand <= 0) {
        toast.error(`"${product.name}" is out of stock`);
        return;
      }

      // Use computeUomPrices to get correct price/cost for selected UoM
      type UomEntry = NonNullable<POSProductInput['uoms']>[number];
      const uom: UomEntry | undefined =
        product.selectedUom ||
        product.uoms?.find((u: UomEntry) => u.isDefault) ||
        product.uoms?.[0];

      // Handle case where UoM already has price/cost (from inventory API)
      if (uom && uom.price && uom.cost) {
        // For AT_COST customers, always start at the UoM's cost price — no async reprice flash.
        // The pricing engine will confirm the same value on the next repriceCart run.
        const isAtCost = selectedCustomer?.pricingMode === 'AT_COST';
        // Catalog uom.cost ≠ FEFO carrying after write-down. Walk-in keeps catalog selling
        // price; repriceCart sets costPrice from allocatedCostPerBase. AT_COST also reprices selling.
        const effectiveUnitPrice = uom.price;
        const lineCost = isAtCost ? uom.price : uom.cost;

        // Use pre-calculated prices from inventory API
        const newItem: LineItem = {
          id: product.id,
          name: product.name,
          sku: product.sku,
          uom: uom.symbol || uom.name || product.unitOfMeasure || 'PIECE',
          quantity: 1,
          unitPrice: effectiveUnitPrice,
          costPrice: lineCost,
          marginPct:
            effectiveUnitPrice > 0
              ? new Decimal(effectiveUnitPrice).minus(lineCost).dividedBy(effectiveUnitPrice).times(100).toNumber()
              : 0,
          subtotal: effectiveUnitPrice,
          productType: product.productType,
          stockOnHand: product.stockOnHand,
          isTaxable: product.isTaxable ?? false,
          taxRate: product.taxRate || 0,
          availableUoms: product.uoms || [],
          selectedUomId: uom.uomId,
          baseCost: product.costPrice || product.averageCost || product.average_cost || 0,
        };
        setItems((prev) => {
          // If already exists with same product + UoM, increment quantity
          const idx = prev.findIndex(
            (i) => i.id === newItem.id && i.selectedUomId === newItem.selectedUomId
          );
          if (idx >= 0) {
            const updated = [...prev];
            const existing = updated[idx];
            const qty = existing.quantity + 1;
            updated[idx] = {
              ...existing,
              quantity: qty,
              subtotal: new Decimal(qty).times(existing.unitPrice).toNumber(),
            };
            return updated;
          }
          return [...prev, newItem];
        });
        return;
      }

      // Fallback: compute prices if not provided
      const baseCost = product.costPrice || product.averageCost || product.average_cost || 0;
      if (baseCost === 0) {
        alert('Product cost is not available. Please set product cost first.');
        return;
      }

      const pricing = computeUomPrices({
        baseCost: baseCost,
        units: [
          uom
            ? { factor: uom.conversionFactor, name: uom.name, uomId: uom.uomId }
            : { factor: 1, name: product.unitOfMeasure || 'PIECE' },
        ],
        defaultMultiplier: 1.2,
        currencyDecimals: 0,
        roundingMode: 'ROUND_HALF_UP',
      });
      const row = pricing.rows[0];
      const newItem: LineItem = {
        id: product.id,
        name: product.name,
        sku: product.sku,
        uom: uom?.symbol || uom?.name || product.unitOfMeasure || 'PIECE',
        quantity: 1,
        unitPrice: row.sellingPrice,
        costPrice: row.unitCost,
        marginPct:
          row.unitCost > 0 && row.sellingPrice > 0
            ? new Decimal(row.sellingPrice)
              .minus(row.unitCost)
              .dividedBy(row.sellingPrice)
              .times(100)
              .toNumber()
            : 0,
        subtotal: row.sellingPrice,
        productType: product.productType,
        stockOnHand: product.stockOnHand,
        isTaxable: product.isTaxable ?? false,
        taxRate: product.taxRate || 0,
        availableUoms: product.uoms || [],
        selectedUomId: uom?.uomId,
        baseCost: baseCost,
      };
      // Validate with Zod
      const validation = ProductCreateSchema.safeParse({
        name: newItem.name,
        sku: newItem.sku,
        barcode: product.barcode,
        unitOfMeasure: newItem.uom,
        conversionFactor: uom?.conversionFactor || 1,
        costPrice: newItem.costPrice,
        sellingPrice: newItem.unitPrice,
        costingMethod: product.costingMethod || 'FIFO',
        taxRate: product.taxRate || 0,
        pricingFormula: product.pricingFormula || '',
        autoUpdatePrice: product.autoUpdatePrice ?? false,
        reorderLevel: product.reorderLevel || 0,
        trackExpiry: product.trackExpiry ?? false,
        isActive: true,
      });
      if (!validation.success) {
        console.error('Product validation failed:', validation.error.errors);
        console.error('Product data:', newItem);
        const errorDetails =
          validation.error?.errors?.map((e) => `• ${e.path.join('.')}: ${e.message}`).join('\n') ||
          'Validation failed';
        alert(
          `⚠️ Product Validation Error\n\nCannot add "${product.name}" to cart\n\nIssues found:\n${errorDetails}\n\n🔧 This product may have incomplete data.\nPlease check Inventory Management.`
        );
        return;
      }
      setItems((prev) => {
        // If already exists with same UoM, increment quantity
        const idx = prev.findIndex(
          (i) => i.id === newItem.id && i.selectedUomId === newItem.selectedUomId
        );
        if (idx >= 0) {
          const updated = [...prev];
          const item = updated[idx];
          const qty = item.quantity + 1;
          updated[idx] = {
            ...item,
            quantity: qty,
            subtotal: new Decimal(qty).times(item.unitPrice).toNumber(),
          };
          return updated;
        }
        return [...prev, newItem];
      });

      // CRITICAL: Reset and refocus search immediately to prevent double entries
      // This ensures pressing Enter again won't add the same product twice
      setTimeout(() => {
        productSearchRef.current?.clearSearch();
        productSearchRef.current?.focusSearch();
      }, 50);
    },
    [] // no stale-closure dependency on items — all setItems calls use functional updaters
  ); // Handle UoM change for existing cart item
  const handleUomChange = (itemIndex: number, newUomId: string) => {
    setItems((prev) => {
      const updated = [...prev];
      const item = updated[itemIndex];

      if (!item.availableUoms || item.availableUoms.length === 0) return prev;

      const newUom = item.availableUoms.find((u) => u.uomId === newUomId);
      if (!newUom) return prev;

      const convertedQty = getPosQuantityAfterUomChange();

      // Update item with new UoM pricing
      const newUnitPrice = newUom.price;
      const newCostPrice = newUom.cost;

      const recalc = recalcPosCartLineFields({
        quantity: convertedQty,
        unitPrice: newUnitPrice,
        costPrice: newCostPrice,
        discount: item.discount,
      });
      updated[itemIndex] = {
        ...item,
        uom: newUom.symbol || newUom.name || item.uom,
        selectedUomId: newUomId,
        costPrice: newCostPrice,
        unitPriceManuallySet: false,
        ...recalc,
      };

      return updated;
    });

    // Close UoM modal if open
    if (showUomModal) {
      setShowUomModal(false);
      setUomModalItemIndex(-1);
      setSelectedUomIndex(0);

      // Restore focus to cart row
      setTimeout(() => {
        if (itemIndex >= 0) {
          const row = cartRowRefs.current[itemIndex];
          if (row) {
            const firstInput = row.querySelector('input, select') as HTMLElement;
            if (firstInput) firstInput.focus();
          }
        }
      }, 100);
    }
  };

  // Discount handlers
  const handleOpenDiscountDialog = (type: 'cart' | 'item', itemIndex?: number) => {
    setDiscountTarget({ type, itemIndex });
    setShowDiscountDialog(true);
  };

  const handleApplyDiscount = (discount: {
    type: DiscountType;
    scope: DiscountScope;
    value: number;
    reason: string;
    lineItemIndex?: number;
  }) => {
    const userLimit = discountLimitPercent;

    // Calculate discount amount and percentage
    let originalAmount = 0;
    if (discount.scope === 'CART') {
      originalAmount = subtotal;
    } else if (discount.lineItemIndex !== undefined) {
      const item = items[discount.lineItemIndex];
      originalAmount = item.subtotal;
    }

    const discountAmount =
      discount.type === 'PERCENTAGE'
        ? new Decimal(originalAmount).times(discount.value).dividedBy(100).toNumber()
        : discount.value;

    const discountPercentage = originalAmount > 0
      ? new Decimal(discountAmount)
        .dividedBy(originalAmount)
        .times(100)
        .toNumber()
      : 0;

    // Check if requires manager approval
    if (discountPercentage > userLimit) {
      // Store discount for manager approval
      setPendingDiscount({
        ...discount,
        amount: discountAmount,
        originalAmount,
        discountPercentage,
      });
      setShowManagerApprovalDialog(true);
      return;
    }

    // Apply discount immediately
    applyDiscountToCart(discount, discountAmount);
  };

  const applyDiscountToCart = (discount: AppliedDiscount, discountAmount: number) => {
    if (discount.scope === 'CART') {
      // Validate discount doesn't exceed subtotal
      if (discountAmount > subtotal) {
        toast.error(
          `Discount amount (${formatCurrency(discountAmount)}) cannot exceed subtotal (${formatCurrency(subtotal)})`
        );
        return;
      }

      // Apply cart-level discount
      setCartDiscount({
        type: discount.type,
        value: discount.value,
        amount: discountAmount,
        reason: discount.reason,
      });
      toast.success(`Cart discount applied: ${discountAmount.toLocaleString()} UGX`);
    } else if (discount.lineItemIndex !== undefined) {
      // Apply line-item discount
      const lineIdx = discount.lineItemIndex;
      setItems((prev) => {
        const updated = [...prev];
        const item = updated[lineIdx];

        // Validate discount doesn't exceed line item subtotal
        if (discountAmount > item.subtotal) {
          toast.error(
            `Discount amount (${formatCurrency(discountAmount)}) cannot exceed item subtotal (${formatCurrency(item.subtotal)})`
          );
          return prev;
        }

        updated[lineIdx] = {
          ...item,
          discount: {
            type: discount.type,
            value: discount.value,
            amount: discountAmount,
            reason: discount.reason,
          },
          subtotal: new Decimal(item.subtotal).minus(discountAmount).toNumber(),
        };
        return updated;
      });
      toast.success(`Line discount applied: ${discountAmount.toLocaleString()} UGX`);
    }
  };

  const handleManagerApproval = async (pin: string) => {
    void pin;
    if (!pendingDiscount) return;

    try {
      // In production, verify PIN with backend
      // For now, just apply the discount
      applyDiscountToCart(pendingDiscount, pendingDiscount.amount);
      setShowManagerApprovalDialog(false);
      setPendingDiscount(null);
      toast.success('Manager approval granted');
    } catch {
      toast.error('Manager approval failed');
    }
  };

  // Remove below-cost items from cart
  const handleRemoveBelowCostItems = () => {
    setItems((prev) =>
      prev.filter((item) => !isPosLineBlockedByCatalogCost(item, selectedCustomer?.pricingMode)),
    );
    setShowBelowCostOverrideDialog(false);
    setBelowCostItems([]);
    toast('Below-cost items removed from cart. Please re-check prices before continuing.');
  };

  const handleRemoveDiscount = (type: 'cart' | 'item', itemIndex?: number) => {
    if (type === 'cart') {
      setCartDiscount(null);
      toast.success('Cart discount removed');
    } else if (itemIndex !== undefined) {
      setItems((prev) => {
        const updated = [...prev];
        const item = updated[itemIndex];
        if (item.discount) {
          // Restore original subtotal
          const originalSubtotal = new Decimal(item.quantity).times(item.unitPrice).toNumber();
          updated[itemIndex] = {
            ...item,
            discount: undefined,
            subtotal: originalSubtotal,
          };
        }
        return updated;
      });
      toast.success('Line discount removed');
    }
  };

  // Hold cart handler - instant one-click action
  const handleHoldCart = async () => {
    if (items.length === 0) {
      toast.error('Cannot hold empty cart');
      return;
    }

    try {
      // CRITICAL: Always check response.data.success (not response.success)
      // Axios wraps backend response: { data: { success, data, message } }
       
      const response = await (
        api.hold.create as unknown as (
          data: Record<string, unknown>
        ) => ReturnType<typeof api.hold.create>
      )({
        userId: activeUser.id,
        terminalId: 'TERMINAL-001',
        customerName: selectedCustomer?.name,
        subtotal,
        discountAmount: cartDiscountAmount,
        taxAmount: tax,
        totalAmount: grandTotal,
        holdReason: undefined,
        notes: undefined,
        items: items.map((item, index) => {
          // Service/custom items have no real product in DB — send null productId
          const isServiceOrCustom = item.productType === 'service' || item.id.startsWith('custom_');
          return {
            productId: isServiceOrCustom ? null : item.id,
            productName: item.name,
            productSku: item.sku,
            uomId: item.selectedUomId,
            uomName: item.uom,
            uomConversionFactor: getPosLineConversionFactor(item.availableUoms, item.selectedUomId),
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            costPrice: item.costPrice,
            subtotal: item.subtotal,
            productType: item.productType || 'inventory',
            discountAmount: item.discount || 0,
            taxAmount: 0,
            isTaxable: false,
            lineOrder: index,
          };
        }),
      });

      if (response.data.success) {
        const holdData = response.data.data as HoldCreateResponseData;
        toast.success(`Cart held: ${holdData.holdNumber}`);

        // Clear cart immediately - ready for next transaction
        setItems([]);
        setSelectedCustomer(null);
        setCartDiscount(null);
        setTaxOverride(null);
        setPaymentLines([]);
        setPaymentAmount('');
        setPaymentReference('');
        setSaleDate('');
        setShowDatePicker(false);

        // Update held orders count
        setHeldOrdersCount((prev) => prev + 1);

        // Focus back on search for next transaction
        setTimeout(() => productSearchRef.current?.focusSearch(), 100);
      }
    } catch (error: unknown) {
      console.error('Hold cart error:', error);
      toast.error(getAxiosErrorMessage(error, 'Failed to hold cart'));
    }
  };

  // Resume hold handler
  const handleResumeHold = async (holdId: string) => {
    try {
      // Fetch full hold details with items
      const response = await api.hold.getById(holdId);

      if (!response.data.success) {
        toast.error('Failed to load hold details');
        return;
      }

      const hold = response.data.data as HoldOrder;

      // Restore cart from hold
      setItems(
        hold.items.map((item: HoldLineItem) => {
          // Service/custom items have null productId — generate a unique custom ID
          const isServiceItem = !item.productId || item.productType === 'service';
          const itemId = isServiceItem
            ? `custom_svc_${item.productName?.replace(/\s+/g, '_').toLowerCase() || 'item'}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
            : item.productId!;

          return {
            id: itemId,
            name: item.productName,
            sku: item.productSku,
            uom: item.uomName,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            costPrice: item.costPrice,
            marginPct:
              item.unitPrice > 0
                ? new Decimal(item.unitPrice)
                  .minus(item.costPrice)
                  .dividedBy(item.unitPrice)
                  .times(100)
                  .toNumber()
                : 0,
            subtotal: item.subtotal,
            isTaxable: item.isTaxable,
            taxRate: item.taxRate,
            selectedUomId: item.uomId,
            discount:
              typeof item.discountAmount === 'number' && item.discountAmount > 0
                ? {
                  type: 'FIXED_AMOUNT' as DiscountType,
                  value: item.discountAmount,
                  amount: item.discountAmount,
                  reason: '',
                }
                : undefined,
            productType: (item.productType || 'inventory') as
              | 'inventory'
              | 'consumable'
              | 'service',
          };
        })
      );

      // Restore cart-level discount if the dispenser applied one
      if (hold.discountAmount && hold.discountAmount > 0) {
        setCartDiscount({
          type: 'FIXED_AMOUNT' as DiscountType,
          value: hold.discountAmount,
          amount: hold.discountAmount,
          reason: '',
        });
      } else {
        setCartDiscount(null);
      }

      if (hold.customerName) {
        toast(`Customer: ${hold.customerName}`, {
          icon: 'ℹ️',
        });
      }

      // CRITICAL: Delete hold after resuming (DO NOT skip this step)
      // Holds are temporary - they must be deleted once loaded into cart
      await api.hold.delete(hold.id);

      // Update held orders count
      setHeldOrdersCount((prev) => Math.max(0, prev - 1));

      toast.success(`Resumed hold: ${hold.holdNumber}`);
      setShowResumeDialog(false);
    } catch (error: unknown) {
      console.error('Resume hold error:', error);
      toast.error(getAxiosErrorMessage(error, 'Failed to resume hold'));
    }
  };

  // Smart toggle button handler (QuickBooks POS style)
  const handleHoldRetrieveToggle = () => {
    // If cart has items, hold it
    if (items.length > 0) {
      handleHoldCart();
    }
    // If cart is empty and there are held orders, show retrieve dialog
    else if (heldOrdersCount > 0) {
      setShowResumeDialog(true);
    }
    // If cart is empty and no holds, show message
    else {
      toast('No held orders to retrieve', {
        icon: 'ℹ️',
      });
    }
  };

  // Smart quote toggle handler
  const handleQuoteToggle = () => {
    // If cart has items, save as quote
    if (items.length > 0) {
      // Pre-fill customer info if selected
      if (selectedCustomer) {
        setQuoteCustomerName(selectedCustomer.name);
        setQuoteCustomerPhone(selectedCustomer.phone || '');
      }
      setShowSaveQuoteDialog(true);
    }
    // If cart is empty, show load dialog
    else {
      fetchRecentQuotes();
      setShowLoadQuoteDialog(true);
    }
  };

  // Save cart as quote handler
  const handleSaveAsQuote = async () => {
    if (items.length === 0) {
      toast.error('Cart is empty');
      return;
    }

    try {
      setIsSavingQuote(true);

      // Same customer resolve as sale — never save temp_/offline IDs as customerId
      let quoteCustomer = selectedCustomer;
      let quoteCustomerId = selectedCustomer?.id;
      if (selectedCustomer) {
        const resolved = await resolvePosCustomerForSale(selectedCustomer);
        if (resolved.error || !resolved.customerId) {
          toast.error(resolved.error || 'Select a saved customer before creating a quote');
          setIsSavingQuote(false);
          return;
        }
        quoteCustomer = resolved.customer;
        quoteCustomerId = resolved.customerId;
        if (resolved.customer && resolved.customer.id !== selectedCustomer.id) {
          setSelectedCustomer(resolved.customer);
        }
      }

      // Line discounts + proportional share of cart discount
      const lineBases = items.map((item) => {
        const gross = new Decimal(item.unitPrice).times(item.quantity);
        const lineDisc = new Decimal(item.discount?.amount || 0);
        return Math.max(0, gross.minus(lineDisc).toNumber());
      });
      const basesSum = lineBases.reduce((s, n) => s + n, 0);
      let cartDiscLeft = cartDiscountAmount > 0 ? cartDiscountAmount : 0;

      // Convert cart items to quote items (include discounts — previously dropped)
      const quoteItems: QuickQuoteItemInput[] = items.map((item, idx) => {
        const isServiceOrCustom = item.productType === 'service' || item.id.startsWith('custom_');
        const lineDisc = item.discount?.amount || 0;
        let allocatedCart = 0;
        if (cartDiscLeft > 0 && basesSum > 0 && lineBases[idx] > 0) {
          if (idx === items.length - 1) {
            allocatedCart = cartDiscLeft;
          } else {
            allocatedCart = Math.round((cartDiscLeft * lineBases[idx]) / basesSum);
            cartDiscLeft -= allocatedCart;
          }
        }
        return {
          productId: isServiceOrCustom ? null : item.id,
          itemType: isServiceOrCustom ? ('service' as const) : ('product' as const),
          sku: item.sku,
          description: item.name,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          discountAmount: lineDisc + allocatedCart,
          isTaxable: item.isTaxable,
          taxRate: item.taxRate,
          uomId: item.selectedUomId && !item.selectedUomId.startsWith('default-') ? item.selectedUomId : undefined,
          uomName: item.uom,
          unitCost: item.costPrice,
          productType: item.productType || 'inventory',
        };
      });

      // Create quick quote
      const response = await quotationApi.createQuickQuote({
        customerId: quoteCustomerId,
        customerName: quoteCustomerName || quoteCustomer?.name || selectedCustomer?.name || 'Walk-in Customer',
        customerPhone: quoteCustomerPhone || quoteCustomer?.phone || selectedCustomer?.phone || undefined,
        items: quoteItems,
        validityDays: quoteValidityDays,
        notes: quoteNotes,
      });

      // Store quote data for success dialog
      setSavedQuoteData(response);

      // Close save dialog and show success dialog
      setShowSaveQuoteDialog(false);
      setShowQuoteSuccessDialog(true);

      // Update quotes count
      setQuotesCount((prev) => prev + 1);
    } catch (error: unknown) {
      console.error('Save quote error:', error);
      toast.error(getAxiosErrorMessage(error, 'Failed to save quote'));
    } finally {
      setIsSavingQuote(false);
    }
  };

  // Handle quote success actions
  const handleClearCartAfterQuote = () => {
    setItems([]);
    setSelectedCustomer(null);
    setCartDiscount(null);
    setQuoteCustomerName('');
    setQuoteCustomerPhone('');
    setQuoteNotes('');
    setQuoteValidityDays(30);
    setShowQuoteSuccessDialog(false);
    setSavedQuoteData(null);

    // Clear quote customer persistence data when cart is cleared
    localStorage.removeItem('pos_loaded_quote_customer');

    toast.success('Cart cleared successfully');
    setTimeout(() => productSearchRef.current?.focusSearch(), 100);
  };

  const handleViewQuote = () => {
    if (savedQuoteData) {
      window.open(`/quotations/${savedQuoteData.quotation.quoteNumber}`, '_blank');
      setShowQuoteSuccessDialog(false);
    }
  };

  const handleKeepWorking = () => {
    setShowQuoteSuccessDialog(false);
    setSavedQuoteData(null);
    setQuoteCustomerName('');
    setQuoteCustomerPhone('');
    setQuoteNotes('');
    setQuoteValidityDays(30);
  };

  // Load quote to cart
  const handleLoadQuoteToCart = async (quoteData: QuotationDetail) => {
    try {
      const quote = quoteData.quotation || quoteData;

      // Guard: prevent loading locked quotes
      if (!isQuoteConvertibleFrom(quote)) {
        toast.error(`Cannot load quote ${quote.quoteNumber} — it is no longer available for conversion`);
        return;
      }

      if (items.length > 0) {
        const confirmed = window.confirm('This will replace current cart items. Continue?');
        if (!confirmed) return;
      }

      const quoteItems = quoteData.items || [];

      // If we have the quote number but need full data
      let fullQuoteData = quoteData;
      if (!quoteItems || quoteItems.length === 0) {
        const response = await quotationApi.getQuotationByNumber(quote.quoteNumber);
        fullQuoteData = response;
      }

      const itemsToLoad = fullQuoteData.items || [];

      // Clear existing cart
      setItems([]);
      setCartDiscount(null);

      // Load quote items into cart
      const cartItems: LineItem[] = itemsToLoad.map((item: QuotationItem) => {
        // Service/custom items have null productId — generate a unique custom ID
        const isServiceItem =
          !item.productId || item.itemType === 'service' || item.itemType === 'custom';
        const itemId = isServiceItem
          ? `custom_svc_${item.description?.replace(/\s+/g, '_').toLowerCase() || 'item'}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
          : item.productId!;
        const productType = isServiceItem ? 'service' : item.productType || 'inventory';

        return {
          id: itemId,
          name: item.description,
          sku: item.sku || '',
          unitPrice: Number(item.unitPrice),
          costPrice: item.unitCost ? Number(item.unitCost) : 0,
          quantity: Number(item.quantity),
          // Pre-tax line amount (NOT lineTotal — that includes tax and would double-count)
          subtotal: Number(
            item.subtotal != null
              ? item.subtotal
              : new Decimal(item.quantity)
                  .times(item.unitPrice)
                  .minus(item.discountAmount || 0)
                  .toNumber(),
          ),
          isTaxable: item.isTaxable,
          taxRate: item.taxRate ?? 0,
          uom: item.uomName || 'unit',
          selectedUomId: item.uomId || undefined, // Convert null to undefined for Zod validation
          productType: productType as LineItem['productType'],
          marginPct: 0,
          discount:
            item.discountAmount && Number(item.discountAmount) > 0
              ? {
                  type: 'FIXED_AMOUNT' as DiscountType,
                  value: Number(item.discountAmount),
                  amount: Number(item.discountAmount),
                  reason: 'From quotation',
                }
              : undefined,
        };
      });

      setItems(cartItems);

      // CRITICAL: Track loaded quote ID for auto-conversion when sale is completed
      const quotation = fullQuoteData.quotation || fullQuoteData;
      setLoadedQuoteId(quotation.id);
      console.log('📋 Quote loaded to POS cart:', {
        quoteId: quotation.id,
        quoteNumber: quotation.quoteNumber,
        itemCount: cartItems.length,
        willAutoConvert: true,
      });

      // Set customer if available - ENHANCED with better error handling and logging
      if (quotation.customerId) {
        console.log('📋 Loading customer for quote:', {
          customerId: quotation.customerId,
          customerName: quotation.customerName,
        });
        // Fetch customer details using shared api client
        try {
          const customerResponse = await api.customers.getById(quotation.customerId);
          const customerData = customerResponse.data;
          if (customerData.success && customerData.data) {
            console.log('✅ Customer data loaded successfully:', customerData.data);
            setSelectedCustomer(customerData.data as Customer);
            // Also store in localStorage for persistence across refreshes
            localStorage.setItem('pos_loaded_quote_customer', JSON.stringify(customerData.data));
          } else {
            console.warn('❌ Invalid customer data response:', customerData);
            toast.error('Failed to load customer data for quote');
          }
        } catch (err) {
          console.error('❌ Exception loading customer:', err);
          toast.error('Error loading customer for quote');
        }
      } else if (quotation.customerName) {
        // If we have customer name but no ID, try to find the customer in DB by name
        console.log('📋 Searching DB for customer by name:', quotation.customerName);
        try {
          const listRes = await api.customers.search(quotation.customerName, 20);
          const allCustomers = (listRes.data?.data || []) as Customer[];
          const matchedCustomer = allCustomers.find(
            (c: Customer) => c.name.toLowerCase() === quotation.customerName!.toLowerCase()
          );
          if (matchedCustomer) {
            console.log('✅ Found matching customer in DB:', matchedCustomer.id, matchedCustomer.name);
            setSelectedCustomer(matchedCustomer);
            localStorage.setItem('pos_loaded_quote_customer', JSON.stringify(matchedCustomer));
          } else {
            // No match — do not use temp_ id (breaks deposit/pricing UUID APIs)
            console.warn('📋 No DB match for quote customer:', quotation.customerName);
            setSelectedCustomer(null);
            localStorage.removeItem('pos_loaded_quote_customer');
            toast(
              `Quote customer "${quotation.customerName}" was not found. Search and select the customer in POS.`,
              { icon: '⚠️' }
            );
          }
        } catch (err) {
          console.error('❌ Failed to search customers by name:', err);
          setSelectedCustomer(null);
          localStorage.removeItem('pos_loaded_quote_customer');
          toast.error('Could not resolve quote customer — select customer manually in POS');
        }
      }

      setShowLoadQuoteDialog(false);
      toast.success(`Quote ${quotation.quoteNumber} loaded to cart`);
      setTimeout(() => productSearchRef.current?.focusSearch(), 100);
    } catch (error) {
      console.error('Load quote error:', error);
      toast.error('Failed to load quote to cart');
    }
  };

  // Fetch recent quotes when opening load dialog
  const fetchRecentQuotes = async () => {
    try {
      setIsLoadingQuotes(true);
      // Server enforces "open" — never trust client filtering, otherwise
      // a CONVERTED quote could appear on later pages once the page size
      // grows past 20.
      const response = await quotationApi.listQuotations({
        page: 1,
        limit: 20,
        openOnly: true,
      });
      setAvailableQuotes(response.quotations || []);
    } catch (error) {
      console.error('Failed to fetch quotes:', error);
      toast.error('Failed to load quotes');
    } finally {
      setIsLoadingQuotes(false);
    }
  };

  // Load quote to cart handler
  // Update quantity handler
  const handleQuantityChange = (itemIndex: number, newQuantity: number) => {
    if (newQuantity <= 0) {
      // Remove item
      setItems((prev) => prev.filter((_, idx) => idx !== itemIndex));
      return;
    }

    setItems((prev) => {
      const updated = [...prev];
      const item = updated[itemIndex];
      const quantity = sanitizePosSellingQuantity(
        newQuantity,
        item.availableUoms,
        item.selectedUomId,
      );
      updated[itemIndex] = {
        ...item,
        ...recalcPosCartLineFields({
          quantity,
          unitPrice: item.unitPrice,
          costPrice: item.costPrice,
          discount: item.discount,
        }),
      };
      return updated;
    });
  };

  const handleUnitPriceChange = (itemIndex: number, newUnitPrice: number, options?: { silent?: boolean }) => {
    let belowCost = false;
    let productName = '';

    setItems((prev) => {
      const updated = [...prev];
      const item = updated[itemIndex];
      if (!item) return prev;

      productName = item.name;
      const recalc = recalcPosCartLineFields({
        quantity: item.quantity,
        unitPrice: newUnitPrice,
        costPrice: item.costPrice,
        discount: item.discount,
      });
      belowCost = isPosLineBlockedByCatalogCost(
        { ...item, ...recalc },
        selectedCustomer?.pricingMode,
      );

      updated[itemIndex] = {
        ...item,
        ...recalc,
        unitPriceManuallySet: options?.silent ? item.unitPriceManuallySet : true,
      };
      return updated;
    });

    if (!options?.silent && belowCost) {
      toast.error(
        `"${productName}": price is below allocated batch cost. Sale will be blocked.`,
        { duration: 6000 },
      );
    }
  };

  // Reactive totals
  const subtotal = items.reduce((sum, i) => new Decimal(sum).plus(i.subtotal).toNumber(), 0);

  // Apply cart-level discount
  const cartDiscountAmount = cartDiscount ? cartDiscount.amount : 0;
  const subtotalAfterDiscount = new Decimal(subtotal).minus(cartDiscountAmount).toNumber();

  // DocumentTax preview SSOT (matches server DocumentTaxService / TaxEngine.compute)
  const taxSnapshot = useMemo(() => getCachedTaxSnapshot(), [taxSnapshotRev]);
  const cachedProfile = getCachedCustomerTaxProfile(selectedCustomer?.id);
  const customerProfile = {
    vatRegistered:
      selectedCustomer?.vatRegistered === true || cachedProfile?.vatRegistered === true,
    taxExempt: selectedCustomer?.taxExempt === true || cachedProfile?.taxExempt === true,
    taxProfile: selectedCustomer?.taxProfile || cachedProfile?.taxProfile,
    defaultVatRate:
      selectedCustomer?.defaultVatRate ?? cachedProfile?.defaultVatRate ?? null,
    taxEffectiveFrom: selectedCustomer?.taxEffectiveFrom ?? null,
    vatRegistrationDate: selectedCustomer?.vatRegistrationDate ?? null,
  };
  const customerAllowsTaxOverride =
    !selectedCustomer?.id ||
    selectedCustomer?.allowTaxOverride === true ||
    cachedProfile?.allowTaxOverride === true ||
    canApproveSales;
  const canOfferTaxOverride = canTaxOverride && customerAllowsTaxOverride;

  const taxPreviewCtx = {
    customerExempt: isCustomerTaxExemptCached(selectedCustomer?.id) || customerProfile.taxExempt,
    customerProfile,
    vatOutputRequiresRegisteredCustomer:
      taxSnapshot?.vatOutputRequiresRegisteredCustomer === true,
    taxCatalog: getTaxCatalogForPreview(),
    productMappings: getProductTaxMappingsForPreview(),
    taxEnabled: taxSnapshot?.taxEnabled,
    // Live system-settings wins over stale POS tax snapshot cache.
    taxInclusive:
      tenantTaxInclusive !== null
        ? tenantTaxInclusive
        : taxSnapshot?.taxInclusive === true,
    defaultTaxRate: taxSnapshot?.defaultTaxRate,
    customerDefaultVatRate: customerProfile.defaultVatRate,
    taxOverride: taxOverride ?? undefined,
  };
  const taxPreviewDoc = previewDocumentTax(
    items.map((item) => ({
      productId: item.id,
      lineNetAmount: item.subtotal,
      quantity: item.quantity,
      isTaxable: item.isTaxable,
      taxRate: item.taxRate,
    })),
    {
      ...taxPreviewCtx,
      preferLineTaxOverrides: false,
      applyTenantDefaultWhenUnresolved: false,
    },
  );
  const tax = taxPreviewDoc.totalTax;
  // Price-mode SSOT = system_settings.tax_inclusive only (never infer from tax defs).
  const taxInclusivePricing = taxPreviewCtx.taxInclusive === true;
  const grandTotal = saleChargeTotal(subtotalAfterDiscount, tax, taxInclusivePricing);
  const avgMargin = items.length
    ? items.reduce((sum, i) => new Decimal(sum).plus(i.marginPct).toNumber(), 0) / items.length
    : 0;

  // Handler to add a service/non-inventory item to the cart
  const handleAddServiceItem = useCallback((serviceItem: LineItem) => {
    setItems((prev) => [...prev, serviceItem]);
    toast.success(`Added: ${serviceItem.name}`);
  }, []);

  // Service items detection and revenue calculation
  const serviceItemsCount = useMemo(() => {
    return items.filter((item) => item.productType === 'service').length;
  }, [items]);

  const serviceRevenue = useMemo(() => {
    if (serviceItemsCount === 0) return 0;
    return items
      .filter((item) => item.productType === 'service')
      .reduce((sum, item) => new Decimal(sum).plus(item.subtotal).toNumber(), 0);
  }, [items, serviceItemsCount]);

  // Split payment calculations
  const totalPaid = useMemo(() => {
    return paymentLines.reduce((sum, line) => new Decimal(sum).plus(line.amount).toNumber(), 0);
  }, [paymentLines]);

  const remainingBalance = useMemo(() => {
    return new Decimal(grandTotal).minus(totalPaid).toNumber();
  }, [grandTotal, totalPaid]);

  // Calculate change for cash overpayment
  const changeAmount = useMemo(() => {
    if (remainingBalance < 0) {
      return Math.abs(remainingBalance); // Overpaid, return change
    }
    return 0;
  }, [remainingBalance]);

  // Check if all payments are cash (for overpayment allowance)
  const hasCashPayment = useMemo(() => {
    return paymentLines.some((line) => line.paymentMethod === 'CASH');
  }, [paymentLines]);

  // Can complete if: paid exact amount OR overpaid with cash OR credit with remaining balance
  const canCompleteSale = useMemo(() => {
    // Allow full credit sale (0 payment) when customer is selected
    // handleFinalizeSale will auto-add CREDIT line for the full amount
    if (paymentLines.length === 0 && !selectedCustomer) return false;

    // Check if any payment is CREDIT
    const hasCreditPayment = paymentLines.some((line) => line.paymentMethod === 'CREDIT');

    console.log('🔍 canCompleteSale check:', {
      paymentLinesCount: paymentLines.length,
      hasCreditPayment,
      selectedCustomerId: selectedCustomer?.id,
      selectedCustomerName: selectedCustomer?.name,
      remainingBalance,
      hasCashPayment,
    });

    // Exact payment (balance = 0)
    if (Math.abs(remainingBalance) < 0.01) return true;

    // Overpayment (negative balance) - only allowed if cash payment exists
    if (remainingBalance < -0.01 && hasCashPayment) return true;

    // Underpayment (positive balance) - NEW LOGIC: allowed if customer is selected
    // System will auto-create CREDIT payment for remaining balance
    if (remainingBalance > 0.01 && selectedCustomer) {
      console.log('✅ Customer selected with remaining balance - will auto-create credit/invoice');
      return true;
    }

    console.log('❌ No completion condition met');
    return false;
  }, [paymentLines, remainingBalance, hasCashPayment, selectedCustomer]);

  // Debug logging
  useEffect(() => {
    if (showPaymentModal) {
      console.log('💳 Payment Modal Opened:', {
        itemsCount: items.length,
        items: items.map((i) => ({
          name: i.name,
          qty: i.quantity,
          price: i.unitPrice,
          subtotal: i.subtotal,
        })),
        subtotal,
        cartDiscountAmount,
        tax,
        grandTotal,
        paymentLines: paymentLines.length,
        totalPaid,
        remainingBalance,
        canCompleteSale,
      });
    }
  }, [
    showPaymentModal,
    items.length,
    grandTotal,
    paymentLines.length,
    totalPaid,
    remainingBalance,
    canCompleteSale,
  ]);

  // Add payment line handler
  const handleAddPayment = () => {
    const amount = parseFloat(paymentAmount);

    // Validation - allow zero amount for CREDIT with customer (full credit sale)
    if (!paymentAmount || isNaN(amount)) {
      alert(
        '⚠️ Invalid Payment Amount\n\nPlease enter a valid number.\n\nExamples:\n• 50000 (for UGX 50,000)\n• 125000 (for UGX 125,000)\n• 1000.50 (for UGX 1,000.50)\n\nTip: Enter numbers only, no currency symbols.'
      );
      return;
    }

    if (amount < 0) {
      alert(
        '⚠️ Negative Amount Not Allowed\n\nPayment amount cannot be negative.\n\nPlease enter a positive number.'
      );
      return;
    }

    // For CREDIT with customer, allow zero amount (full credit sale/invoice)
    if (amount === 0 && paymentMethod === 'CREDIT' && selectedCustomer) {
      // Valid - full credit sale
    } else if (amount <= 0) {
      alert(
        '⚠️ Zero Amount Not Allowed\n\nPayment amount must be greater than zero.\n\nCurrent remaining balance: ' +
        formatCurrency(remainingBalance)
      );
      return;
    }

    // Allow overpayment ONLY for CASH (to give change)
    // For other payment methods, amount must not exceed remaining balance
    if (
      paymentMethod !== 'CASH' &&
      paymentMethod !== 'CREDIT' &&
      paymentMethod !== 'DEPOSIT' &&
      amount > remainingBalance + 0.01
    ) {
      alert(
        `⚠️ Payment Exceeds Balance\n\n${paymentMethod} Payment: ${formatCurrency(amount)}\nRemaining Balance: ${formatCurrency(remainingBalance)}\nOverpayment: ${formatCurrency(amount - remainingBalance)}\n\n❌ Overpayment is only allowed with CASH\n(to give change to customer)\n\n💡 Options:\n1. Enter ${formatCurrency(remainingBalance)} to pay exact amount\n2. Switch to CASH if customer is paying more\n3. Split payment: pay ${formatCurrency(remainingBalance)} now`
      );
      return;
    }

    if (paymentMethod === 'CREDIT' && !selectedCustomer) {
      alert(
        '⚠️ Customer Required for Credit\n\nCredit payments require a customer to be selected.\n\n📋 How to add customer:\n1. Use customer search at top of screen\n2. Type customer name\n3. Select from dropdown\n4. Then add credit payment\n\n💡 Tip: Credit payments create invoices for later payment.'
      );
      return;
    }

    // DEPOSIT validation - must have customer with available deposit balance
    if (paymentMethod === 'DEPOSIT') {
      if (!selectedCustomer) {
        alert(
          '⚠️ Customer Required for Deposit\n\nDeposit payments require a customer to be selected.'
        );
        return;
      }
      if (customerDepositBalance <= 0) {
        alert('⚠️ No Deposit Available\n\nThis customer has no available deposit balance.');
        return;
      }
      // Calculate already applied deposits in this transaction
      const appliedDeposits = paymentLines
        .filter((line) => line.paymentMethod === 'DEPOSIT')
        .reduce((sum, line) => new Decimal(sum).plus(line.amount).toNumber(), 0);
      const availableDeposit = new Decimal(customerDepositBalance)
        .minus(appliedDeposits)
        .toNumber();

      if (amount > availableDeposit + 0.01) {
        alert(
          `⚠️ Insufficient Deposit Balance\n\nRequested: ${formatCurrency(amount)}\nAvailable: ${formatCurrency(availableDeposit)}\n\n💡 Tip: Enter ${formatCurrency(Math.min(availableDeposit, remainingBalance))} to use maximum available deposit.`
        );
        return;
      }
    }

    // Optional: Warn about missing reference for card/mobile money
    if (
      (paymentMethod === 'CARD' || paymentMethod === 'MOBILE_MONEY' || paymentMethod === 'AIRTEL_MONEY') &&
      !paymentReference.trim()
    ) {
      const proceed = confirm(
        `ℹ️ Reference Number Recommended\n\nYou haven't entered a reference number for this ${paymentMethod} payment.\n\n💡 Why reference numbers matter:\n• Helps reconcile payments\n• Resolves disputes\n• Required for audits\n• Tracks transactions\n\nDo you want to continue without a reference?`
      );
      if (!proceed) {
        // Focus on reference input
        setTimeout(() => {
          const refInput = document.querySelector(
            'input[placeholder="Transaction reference"]'
          ) as HTMLInputElement;
          refInput?.focus();
        }, 100);
        return;
      }
    }

    // Add payment line
    const newLine = {
      id: `payment_${Date.now()}_${Math.random()}`,
      paymentMethodId: paymentMethod,
      paymentMethod: paymentMethod,
      amount: amount,
      reference: paymentReference.trim() || undefined,
      createdAt: new Date().toISOString(),
    };

    setPaymentLines([...paymentLines, newLine]);
    setPaymentAmount('');
    setPaymentReference('');

    // Show success feedback
    const remainingAfter = new Decimal(remainingBalance).minus(amount).toNumber();
    if (remainingAfter <= 0.01) {
      // Payment complete or overpaid
      if (remainingAfter < -0.01 && paymentMethod === 'CASH') {
        console.log(
          `✅ Payment added! Change to give: ${formatCurrency(Math.abs(remainingAfter))}`
        );
      } else {
        console.log('✅ Payment complete! Ready to finalize sale.');
      }
    } else {
      console.log(`✅ Payment added! Remaining: ${formatCurrency(remainingAfter)}`);
    }
  };

  // Remove payment line handler
  const handleRemovePaymentLine = (id: string) => {
    setPaymentLines(paymentLines.filter((line) => line.id !== id));
  };

  // Quick fill remaining balance
  const handleQuickFill = () => {
    if (remainingBalance > 0) {
      setPaymentAmount(remainingBalance.toFixed(2));
    }
  };

  // Auto-fill amount when payment method changes to CASH (if no payment lines yet)
  useEffect(() => {
    if (paymentMethod === 'CASH' && paymentLines.length === 0 && remainingBalance > 0) {
      setPaymentAmount(remainingBalance.toFixed(2));
    }
  }, [paymentMethod, paymentLines.length, remainingBalance]);

  // Handle Enter key in payment amount field - triggers complete payment button
  const handlePaymentAmountKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();

      // If balance remaining, add payment
      if (remainingBalance > 0.01) {
        // Credit payment with customer - auto-complete credit sale
        if (paymentMethod === 'CREDIT' && selectedCustomer) {
          const amount = remainingBalance;
          const newLine = {
            id: `payment_${Date.now()}_${Math.random()}`,
            paymentMethodId: 'CREDIT',
            paymentMethod: 'CREDIT' as const,
            amount: amount,
            reference: undefined,
            createdAt: new Date().toISOString(),
          };
          setPaymentLines([newLine]);
          setTimeout(() => handleFinalizeSale(), 100);
        }
        // Regular payment - add payment line
        else if (paymentAmount && parseFloat(paymentAmount) > 0) {
          handleAddPayment();
        }
      }
      // No balance remaining - complete sale
      else if (canCompleteSale) {
        handleFinalizeSale();
      }
    }
  };

  // ----- Order Mode: Save Order (no payment) -----
  const handleCreateOrder = async () => {
    if (isCreatingOrder) return;
    if (items.length === 0) {
      toast.error('Cart is empty. Add items before saving an order.');
      return;
    }
    if (grandTotal < 0) {
      toast.error('Total amount cannot be negative. Adjust your discounts.');
      return;
    }
    const itemsBelowCost = items.filter((item) =>
      isPosLineBlockedByCatalogCost(item, selectedCustomer?.pricingMode),
    );
    if (itemsBelowCost.length > 0) {
      setBelowCostItems(
        itemsBelowCost.map((i) => ({
          name: i.name,
          unitPrice: i.unitPrice,
          costPrice: i.costPrice,
        })),
      );
      setShowBelowCostOverrideDialog(true);
      return;
    }

    setIsCreatingOrder(true);
    try {
      const orderItems = items.map((item) => buildPosOrderLinePayload(item));

      // ── Offline: save order locally, sync when internet is restored ──
      if (!isOnline) {
        const offlineId = saveOrderOffline({
          customerId: selectedCustomer?.id,
          items: orderItems,
          notes: '',
        });
        toast.success(`Order saved offline (${offlineId}). Will sync when online.`);

        // Build order receipt data BEFORE clearing cart
        const today = new Date();
        setReceiptData(
          makePosReceiptData({
            saleNumber: `ORDER: ${offlineId}`,
            saleDate: formatReceiptDateTime(today),
            subtotal,
            discountAmount: items.reduce((sum, item) => sum + (item.discount?.amount || 0), 0),
            taxAmount: tax,
            totalAmount: grandTotal,
            items: items.map((item) => ({
              name: item.name,
              quantity: item.quantity,
              unitPrice: item.unitPrice,
              subtotal: item.subtotal,
              uom: item.uom,
              discountAmount: item.discount?.amount,
              taxRate: item.taxRate,
              isTaxable: item.isTaxable,
            })),
          })
        );
        setLastSale({
          id: offlineId,
          saleNumber: offlineId,
          saleDate: getBusinessDate(),
          totalAmount: grandTotal,
          isPersistedSale: false,
        });

        // Clear cart
        setItems([]);
        setSelectedCustomer(null);
        setPaymentLines([]);
        setPaymentAmount('');
        clearPersistedCart();

        // Show receipt/print modal
        setShowReceiptModal(true);
        return;
      }

      // ── Online: send order to server immediately ──
      const orderData = {
        customerId: selectedCustomer?.id,
        notes: '',
        items: orderItems,
        quoteId: loadedQuoteId || undefined,
        // Cart-level discount applied by dispenser (passed so backend stores correct total)
        discountAmount: cartDiscountAmount > 0 ? cartDiscountAmount : undefined,
      };
      const response = await api.orders.create(orderData);
      if (response.data?.success) {
        const order = response.data.data as {
          id?: string;
          orderNumber?: string;
          order_number?: string;
          totalAmount?: string | number;
          items?: Array<{
            productName?: string;
            product_name?: string;
            quantity?: string | number;
            unitPrice?: string | number;
            unit_price?: string | number;
            lineTotal?: string | number;
            line_total?: string | number;
            discountAmount?: string | number;
            discount_amount?: string | number;
          }>;
        };
        const orderNum = order.orderNumber || order.order_number || '';
        toast.success(`Order ${orderNum} saved! Sent to cashier queue.`);

        // Build order receipt data BEFORE clearing cart
        const today = new Date();
        setReceiptData(
          makePosReceiptData({
            saleNumber: `ORDER: ${orderNum}`,
            saleDate: formatReceiptDateTime(today),
            subtotal,
            discountAmount: items.reduce(
              (sum, item) => sum + (item.discount?.amount || 0),
              0
            ),
            taxAmount: tax,
            totalAmount: grandTotal,
            items: items.map((item) => ({
              name: item.name,
              quantity: item.quantity,
              unitPrice: item.unitPrice,
              subtotal: item.subtotal,
              uom: item.uom,
              discountAmount: item.discount?.amount,
              taxRate: item.taxRate,
              isTaxable: item.isTaxable,
            })),
          })
        );
        setLastSale({
          id: order.id || orderNum,
          saleNumber: orderNum,
          saleDate: getBusinessDate(),
          totalAmount: grandTotal,
          isPersistedSale: false,
        });

        // Clear cart
        setItems([]);
        setSelectedCustomer(null);
        setLoadedQuoteId(null);
        setPaymentLines([]);
        setPaymentAmount('');
        clearPersistedCart();

        // Show receipt/print modal
        setShowReceiptModal(true);
      } else {
        toast.error(response.data?.error || 'Failed to create order');
      }
    } catch (err: unknown) {
      // CRITICAL: If network failed mid-request, save offline instead of losing the order
      const isNetworkError =
        (err instanceof Error && ('code' in err && (err as Record<string, unknown>).code === 'ERR_NETWORK')) ||
        !navigator.onLine;
      if (isNetworkError) {
        const orderItems = items.map((item) => buildPosOrderLinePayload(item));
        const offlineId = saveOrderOffline({
          customerId: selectedCustomer?.id,
          items: orderItems,
          notes: '',
        });
        toast.success(`Network failed — order saved offline (${offlineId}). Will sync when online.`);

        const today = new Date();
        setReceiptData(
          makePosReceiptData({
            saleNumber: `ORDER: ${offlineId}`,
            saleDate: formatReceiptDateTime(today),
            subtotal,
            discountAmount: items.reduce((sum, item) => sum + (item.discount?.amount || 0), 0),
            taxAmount: tax,
            totalAmount: grandTotal,
            items: items.map((item) => ({
              name: item.name,
              quantity: item.quantity,
              unitPrice: item.unitPrice,
              subtotal: item.subtotal,
              uom: item.uom,
              discountAmount: item.discount?.amount,
              taxRate: item.taxRate,
              isTaxable: item.isTaxable,
            })),
          })
        );
        setLastSale({
          id: offlineId,
          saleNumber: offlineId,
          saleDate: getBusinessDate(),
          totalAmount: grandTotal,
          isPersistedSale: false,
        });
        setItems([]);
        setSelectedCustomer(null);
        setPaymentLines([]);
        setPaymentAmount('');
        clearPersistedCart();
        setShowReceiptModal(true);
      } else {
        const errorMessage = err instanceof Error ? err.message : 'Failed to create order';
        toast.error(errorMessage);
      }
    } finally {
      setIsCreatingOrder(false);
    }
  };

  // Finalize sale handler
  const handleFinalizeSale = async () => {
    console.log('🔵 handleFinalizeSale called');

    // CRITICAL: Block sales if no cash register session, or if session could not be verified.
    // Only enforce when session policy is enabled (not DISABLED).
    // Offline sales bypass register check – tagged for reconciliation on sync.
    if (sessionEnforced && isOnline && (isSessionError || !hasOpenRegister)) {
      console.log('⚠️ BLOCKED: Register session missing or unverified');
      toast.error(
        isSessionError
          ? 'Could not verify cash register session. Sale was not posted.'
          : 'Please open a cash register before making sales'
      );
      if (!isSessionError) setShowOpenRegisterDialog(true);
      return;
    }

    // IMMEDIATE duplicate check using ref (faster than state)
    if (isSubmittingRef.current) {
      console.log('⚠️ BLOCKED: Already submitting (ref check)');
      return;
    }

    // Prevent duplicate submissions
    if (isProcessingSale || createSale.isPending) {
      console.log('⚠️ BLOCKED: Sale already processing');
      return;
    }

    // SAP MUoM STEP 6 — Price invariant check: displayPrice must equal basePrice × conversionFactor.
    // Detects price_override corruption early (e.g., PACKET stored at tablet price instead of 30× tablet price).
    // This is advisory-only on the frontend — the backend pricing engine will correct the price at commit.
    // A toast warning is shown so managers can investigate the product_uoms table.
    for (const item of items) {
      if (!item.availableUoms || item.availableUoms.length === 0) continue;
      const selectedUom = item.availableUoms.find((u) => u.uomId === item.selectedUomId);
      if (!selectedUom || selectedUom.isDefault || selectedUom.conversionFactor <= 1) continue;
      // Use backend-supplied computedPrice if available; fall back to frontend recalculation
      const baseUom = item.availableUoms.find((u) => u.isDefault);
      const expectedPrice = selectedUom.computedPrice != null
        ? selectedUom.computedPrice
        : baseUom
          ? new Decimal(baseUom.price).times(selectedUom.conversionFactor).toNumber()
          : null;
      if (expectedPrice == null) continue;
      // Allow 1% or 1-unit tolerance (whichever is larger) for intentional rounding
      const tolerance = Math.max(1, expectedPrice * 0.01);
      if (selectedUom.priceIsOverridden && Math.abs(selectedUom.price - expectedPrice) > tolerance) {
        toast.error(
          `⚠️ MUoM price anomaly: "${item.name}" (${selectedUom.name || selectedUom.symbol}) — price_override ${formatCurrency(selectedUom.price)} ≠ expected ${formatCurrency(expectedPrice)}. Backend will auto-correct. Please fix product_uoms.price_override.`,
          { duration: 8000 }
        );
      }
    }

    // Hard block: no sale below inventory cost (server enforces FEFO-allocated cost; this is UX pre-check).
    const itemsBelowCost = items.filter((item) =>
      isPosLineBlockedByCatalogCost(item, selectedCustomer?.pricingMode),
    );
    if (itemsBelowCost.length > 0) {
      setBelowCostItems(
        itemsBelowCost.map((i) => ({
          name: i.name,
          unitPrice: i.unitPrice,
          costPrice: i.costPrice,
        })),
      );
      setShowBelowCostOverrideDialog(true);
      return;
    }

    // Set both ref and state
    isSubmittingRef.current = true;
    setIsProcessingSale(true);

    console.log('Payment lines:', paymentLines);
    console.log('Remaining balance:', remainingBalance);
    console.log('Can complete sale:', canCompleteSale);

    // Validate cart is not empty
    if (items.length === 0) {
      isSubmittingRef.current = false;
      setIsProcessingSale(false);
      alert(
        '❌ Cannot complete sale\n\nCart is empty. Please add items before completing the sale.'
      );
      return;
    }

    // Validate total is not negative
    if (grandTotal < 0) {
      isSubmittingRef.current = false;
      setIsProcessingSale(false);
      alert(
        `❌ Cannot Complete Sale\n\n💰 Total Amount is Negative\nCurrent total: ${formatCurrency(grandTotal)}\n\n⚠️ The discount amount is too large!\n\nTo fix this:\n1. Reduce the discount amount\n2. Current subtotal: ${formatCurrency(subtotal)}\n3. Current discount: ${formatCurrency(cartDiscountAmount)}\n4. Discount should be less than subtotal\n\nTip: Close payment modal and adjust discount in cart.`
      );
      return;
    }

    // DEPOSIT payment requires a customer (deposits are tied to customer accounts)
    const hasDepositPayment = paymentLines.some(line => line.paymentMethod === 'DEPOSIT');
    if (hasDepositPayment && !selectedCustomer) {
      isSubmittingRef.current = false;
      setIsProcessingSale(false);
      alert(
        '❌ Cannot Complete Sale\n\n💰 Customer Required for Deposit Payment\n\nDeposit payments are tied to customer accounts.\nPlease select a customer before using deposit payment.'
      );
      return;
    }

    // Validate payment lines
    // Allow 0 payment (full credit / "pay later") when customer is selected
    // The auto-credit logic below will create a CREDIT line for the full amount
    if (paymentLines.length === 0 && !selectedCustomer) {
      isSubmittingRef.current = false;
      setIsProcessingSale(false);
      alert(
        `❌ Cannot Complete Sale\n\n💳 No Payment Added\n\nTotal to pay: ${formatCurrency(grandTotal)}\n\nPlease add payment:\n\n1. Select payment method (Cash/Card/Mobile Money)\n2. Enter amount\n3. Click "Add Payment"\n4. Then click "Complete Sale"\n\n💡 Tip: Select a customer to allow "Pay Later" (full credit sale).`
      );
      return;
    }

    // BUSINESS LOGIC: Auto-calculate credit for unpaid balance when customer is selected
    // If customer selected and there's remaining balance, automatically create CREDIT payment line
    const hasCashPayment = paymentLines.some((line) => line.paymentMethod === 'CASH');
    const finalPaymentLines = [...paymentLines];
    let finalRemainingBalance = remainingBalance; // Track updated balance

    if (selectedCustomer && remainingBalance > 0.01) {
      // Customer owes remaining balance - automatically add as CREDIT
      const creditLine = {
        id: `payment_${Date.now()}_${Math.random()}`,
        paymentMethodId: 'CREDIT',
        paymentMethod: 'CREDIT' as const,
        amount: remainingBalance,
        reference: undefined,
        createdAt: new Date().toISOString(),
      };
      finalPaymentLines.push(creditLine);
      finalRemainingBalance = 0; // Balance is now 0 after adding credit
      console.log('🏦 Auto-added CREDIT payment for remaining balance:', {
        originalRemainingBalance: remainingBalance,
        creditAmount: remainingBalance,
        customerName: selectedCustomer.name,
        creditLine,
        finalRemainingBalance,
      });
    } else if (!selectedCustomer && remainingBalance > 0.01) {
      // No customer and unpaid balance = cannot complete sale
      isSubmittingRef.current = false;
      setIsProcessingSale(false);
      alert(
        `❌ Cannot Complete Sale\n\n💰 Unpaid Balance Remaining\n\nTotal: ${formatCurrency(grandTotal)}\nPaid: ${formatCurrency(new Decimal(grandTotal).minus(remainingBalance).toNumber())}\nBalance: ${formatCurrency(remainingBalance)}\n\n📋 To complete this sale:\n\nOption 1: Add More Payments\n• Click payment method button\n• Enter ${formatCurrency(remainingBalance)}\n• Add to payments\n\nOption 2: Create Invoice (Recommended)\n• Select a customer from dropdown\n• System will automatically:\n  - Create invoice for balance\n  - Complete the sale\n  - Customer pays later\n\n💡 Tip: Use customer search at top of screen`
      );
      return;
    }

    // Check overpayment using FINAL balance (after auto-credit)
    if (finalRemainingBalance < -0.01 && !hasCashPayment) {
      isSubmittingRef.current = false;
      setIsProcessingSale(false);
      alert('❌ Cannot complete sale\n\nOverpayment is only allowed with cash payments.');
      return;
    }

    // TIMEZONE STRATEGY: Send YYYY-MM-DD string as-is (DATE column, no conversion)
    const formattedSaleDate: string | undefined = saleDate || undefined;

    // Log calculation breakdown for debugging
    console.log('💰 Sale Calculation Breakdown:', {
      subtotal,
      cartDiscountAmount,
      subtotalAfterDiscount,
      tax,
      grandTotal,
      calculation: `${subtotalAfterDiscount} + ${tax} = ${grandTotal}`,
    });

    // Resolve customer to a real UUID (never post walk-in when UI shows a named customer).
    let resolvedCustomerId: string | undefined;
    let customerForSale: Customer | null = selectedCustomer;
    const hasOfflineCustomer = selectedCustomer?.id?.startsWith('offline_cust_') ?? false;

    if (hasOfflineCustomer && !isOnline) {
      resolvedCustomerId = undefined;
    } else if (hasOfflineCustomer && isOnline) {
      try {
        const idMap = await syncOfflineCustomers();
        const syncedId = idMap.get(selectedCustomer!.id);
        if (syncedId) {
          resolvedCustomerId = syncedId;
          const refreshed = await api.customers.getById(syncedId);
          if (refreshed.data?.success && refreshed.data.data) {
            customerForSale = refreshed.data.data as Customer;
            setSelectedCustomer(customerForSale);
          }
        }
      } catch {
        resolvedCustomerId = undefined;
      }
    } else {
      const resolved = await resolvePosCustomerForSale(selectedCustomer);
      if (resolved.error && selectedCustomer) {
        isSubmittingRef.current = false;
        setIsProcessingSale(false);
        alert(`❌ Cannot Complete Sale\n\n${resolved.error}`);
        return;
      }
      resolvedCustomerId = resolved.customerId;
      if (resolved.customer && resolved.customer.id !== selectedCustomer?.id) {
        customerForSale = resolved.customer;
        setSelectedCustomer(resolved.customer);
      }
    }

    if (selectedCustomer && !resolvedCustomerId && !(hasOfflineCustomer && !isOnline)) {
      isSubmittingRef.current = false;
      setIsProcessingSale(false);
      alert(
        `❌ Cannot Complete Sale\n\nCustomer "${selectedCustomer.name}" is on screen but was not saved on the sale.\n\nRemove the customer, search "${selectedCustomer.name}" in the customer list, select it (look for the "At cost" badge for BOU), then complete the sale again.`,
      );
      return;
    }

    // Validate: CREDIT payments require a real customer (or an offline customer when offline)
    const hasCreditPayment = finalPaymentLines.some((line) => line.paymentMethod === 'CREDIT');
    if (hasCreditPayment && !resolvedCustomerId && !(hasOfflineCustomer && !isOnline)) {
      isSubmittingRef.current = false;
      setIsProcessingSale(false);
      alert(
        `❌ Cannot Complete Sale\n\n💳 Credit Payment Requires a Customer\n\nThe selected customer "${selectedCustomer?.name || 'Unknown'}" is not linked to a database record.\n\n📋 To fix this:\n1. Remove the current customer (click ✕)\n2. Search and select "${selectedCustomer?.name || 'the customer'}" from the customer dropdown\n3. Try completing the payment again\n\n💡 Tip: The customer must exist in the system for credit/invoice sales.`
      );
      return;
    }

    // Cart/pricing integrity — block header vs line drift (e.g. at-cost subtotal with retail unit price).
    const lineSum = items.reduce((sum, i) => new Decimal(sum).plus(i.subtotal).toNumber(), 0);
    const expectedGrand = saleChargeTotal(
      new Decimal(lineSum).minus(cartDiscountAmount).toNumber(),
      tax,
      taxInclusivePricing,
    );
    if (Math.abs(expectedGrand - grandTotal) > 0.02) {
      isSubmittingRef.current = false;
      setIsProcessingSale(false);
      alert(
        `❌ Cart total mismatch\n\nLines: ${formatCurrency(lineSum)}\nTotal shown: ${formatCurrency(grandTotal)}\n\nReselect the customer (BOU for at-cost) and refresh prices before completing.`,
      );
      return;
    }
    for (const item of items) {
      const implied = new Decimal(item.quantity).times(item.unitPrice).toNumber();
      if (Math.abs(implied - item.subtotal) > 0.02) {
        isSubmittingRef.current = false;
        setIsProcessingSale(false);
        alert(
          `❌ Line price mismatch on "${item.name}"\n\nUnit × qty: ${formatCurrency(implied)}\nLine subtotal: ${formatCurrency(item.subtotal)}\n\nRemove the line and re-add it, or reselect the customer.`,
        );
        return;
      }
    }
    if (customerForSale?.pricingMode === 'AT_COST' && !resolvedCustomerId) {
      isSubmittingRef.current = false;
      setIsProcessingSale(false);
      alert(
        '❌ At-cost customer not linked\n\nSelect BOU (or the at-cost customer) from the customer search so the sale posts with correct pricing.',
      );
      return;
    }

    // Generate idempotency key to prevent duplicate sale creation
    // This key is unique per sale attempt — used by both online and offline paths
    const saleIdempotencyKey = `pos_${Date.now()}_${Math.random().toString(36).substr(2, 12)}`;

    // Charge SSOT = saleChargeTotal(settings.tax_inclusive). Product only decides liability.
    const afterDisc = new Decimal(subtotal).minus(cartDiscountAmount).toNumber();
    const chargedTotal = saleChargeTotal(afterDisc, tax, taxInclusivePricing);
    const exclusiveCharge = saleChargeTotal(afterDisc, tax, false);
    // If cart payment still holds exclusive total while mode is inclusive, clamp to shelf.
    let submitPaymentLines = finalPaymentLines;
    if (taxInclusivePricing && tax > 0.01) {
      const paySum = finalPaymentLines.reduce(
        (s, l) => new Decimal(s).plus(l.amount).toNumber(),
        0,
      );
      if (Math.abs(paySum - exclusiveCharge) < 0.02) {
        if (finalPaymentLines.length === 1) {
          submitPaymentLines = [{ ...finalPaymentLines[0], amount: chargedTotal }];
        } else {
          const cashIdx = finalPaymentLines.findIndex((l) => l.paymentMethod === 'CASH');
          if (cashIdx >= 0) {
            const delta = new Decimal(paySum).minus(chargedTotal).toNumber();
            submitPaymentLines = finalPaymentLines.map((l, i) =>
              i === cashIdx
                ? { ...l, amount: Math.max(0, new Decimal(l.amount).minus(delta).toNumber()) }
                : l,
            );
          }
        }
      }
    }

    const saleData = {
      customerId: resolvedCustomerId,
      quoteId: loadedQuoteId || undefined, // Pass quote ID for auto-conversion
      cashRegisterSessionId: currentSession?.id, // Link to cash register for drawer tracking
      idempotencyKey: saleIdempotencyKey,
      lineItems: items.map((item) => {
        const linePreview = previewPosCartTax(
          [
            {
              productId: item.id,
              subtotal: item.subtotal,
              quantity: item.quantity,
              isTaxable: item.isTaxable,
              taxRate: item.taxRate,
            },
          ],
          {
            ...taxPreviewCtx,
            taxInclusive: taxInclusivePricing,
          },
        );

        return {
          productId: item.id,
          productName: item.name,
          sku: item.sku || '',
          uom: item.uom,
          uomId: item.selectedUomId && !item.selectedUomId.startsWith('default-') ? item.selectedUomId : undefined,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          costPrice: item.costPrice,
          subtotal: item.subtotal,
          discountAmount: item.discount?.amount || undefined, // Per-item discount
          taxAmount: linePreview,
          productType: item.productType || 'inventory',
          isTaxable: item.isTaxable,
          taxRate: item.taxRate,
        };
      }),
      subtotal,
      discountAmount: cartDiscountAmount,
      taxAmount: tax,
      totalAmount: chargedTotal,
      saleDate: formattedSaleDate,
      exchangeRefundId: exchangeCredit?.refundId,
      exchangeResidualAction: exchangeCredit ? exchangeResidualAction : undefined,
      taxOverride: taxOverride ?? undefined,
      paymentLines: submitPaymentLines.map((line) => ({
        paymentMethod: line.paymentMethod,
        amount: line.amount,
        reference: line.reference,
      })),
    };

    // Validate with Zod
    console.log('🔍 Validating sale data:', JSON.stringify(saleData, null, 2));
    const validation = POSSaleSchema.safeParse(saleData);
    if (!validation.success) {
      console.error('❌ Sale validation failed:', validation.error);
      const zodIssues =
        validation.error && 'issues' in validation.error
          ? (validation.error as { issues: Array<{ path: (string | number)[]; message: string }> }).issues
          : 'errors' in validation.error
            ? (validation.error as { errors: Array<{ path: (string | number)[]; message: string }> }).errors
            : [];
      console.error('Validation errors:', JSON.stringify(zodIssues, null, 2));
      console.error('Sale data:', saleData);

      // Extract error messages safely
      let errorMessages = 'Validation failed';
      if (zodIssues.length > 0) {
        errorMessages = zodIssues
          .map((e) => {
            const field = e.path.join('.');
            const msg = e.message;
            // Add helpful context for common errors
            if (field.includes('paymentLines') || field.includes('paymentMethod'))
              return `💳 Payment issue: ${msg}`;
            if (field.includes('lineItems')) return `📦 Product issue: ${msg}`;
            if (field.includes('totalAmount')) return `💰 Amount issue: ${msg}`;
            return `${field}: ${msg}`;
          })
          .join('\n\n');
      } else if (validation.error && 'message' in validation.error) {
        errorMessages = (validation.error as { message: string }).message;
      }

      alert(
        `❌ Sale Validation Failed\n\nCannot complete this sale due to data issues:\n\n${errorMessages}\n\n🔧 Please check:\n• All products have valid prices\n• Payment amounts are positive\n• No negative quantities\n\nIf error persists, contact support.`
      );
      console.error('🛑 VALIDATION STOPPED SALE');
      isSubmittingRef.current = false;
      setIsProcessingSale(false);
      return;
    }

    console.log('✅ Validation passed! Sending to API...');

    // If offline, save to queue with local stock validation
    if (!isOnline) {
      try {
        // Preserve offline_cust_ ID so sync engine can resolve it later
        const offlineSaleData = {
          ...saleData,
          customerId: selectedCustomer?.id || saleData.customerId,
        };
        const offlineId = saveSaleOffline(offlineSaleData as unknown as OfflineSaleData);
        toast.success(`Sale saved offline (${offlineId}). Will sync when online.`);

        // Build receipt data BEFORE clearing state so user gets a receipt
        const itemDiscountTotalOffline = items.reduce(
          (sum, item) => new Decimal(sum).plus(item.discount?.amount || 0).toNumber(),
          0
        );
        const today = new Date();
        const offlineSaleDate = getBusinessDate();

        setReceiptData(
          makePosReceiptData({
            saleNumber: offlineId,
            saleDate: formatReceiptDateTime(today),
            subtotal,
            discountAmount: cartDiscountAmount + itemDiscountTotalOffline,
            taxAmount: tax,
            totalAmount: grandTotal,
            items: items.map((item) => ({
              name: item.name,
              quantity: item.quantity,
              unitPrice: item.unitPrice,
              subtotal: item.subtotal,
              uom: item.uom,
              discountAmount: item.discount?.amount,
              taxRate: item.taxRate,
              isTaxable: item.isTaxable,
            })),
            payments: finalPaymentLines.map((line) => ({
              method: line.paymentMethod,
              amount: line.amount,
              reference: line.reference,
            })),
            changeGiven: changeAmount,
          })
        );
        setLastSale({
          id: offlineId,
          saleNumber: offlineId,
          saleDate: offlineSaleDate,
          totalAmount: grandTotal,
          isPersistedSale: false,
        });
      } catch (stockErr: unknown) {
        toast.error(
          stockErr instanceof Error ? stockErr.message : 'Insufficient stock for offline sale'
        );
        isSubmittingRef.current = false;
        setIsProcessingSale(false);
        return;
      }

      // Clear cart and payment lines
      setItems([]);
      setSelectedCustomer(null);
      setCartDiscount(null);
      setTaxOverride(null);
      setExchangeCredit(null);
      setShowPaymentModal(false);
      setPaymentLines([]);
      setPaymentAmount('');
      setPaymentReference('');
      setSaleDate('');
      setShowDatePicker(false);
      presentSaleReceipt();
      clearPersistedCart();
      isSubmittingRef.current = false;
      setIsProcessingSale(false);
      return;
    }

    // API call
    try {
      const response = await createSale.mutateAsync(saleData as unknown as CreateSaleInput);
      console.log('✅ Sale creation successful:', response);

      // Response structure: response.data = {success, data, message}
      // The actual result is in response.data.data = { sale, items, paymentLines }
      if (response.data?.success && response.data?.data) {
        console.log('✅ Inside success block');
        const result = response.data.data as SaleCreateResponseData; // { sale, items, paymentLines }
        const sale = result.sale; // Extract the sale object
        console.log('Sale data:', sale);
        console.log('Full result:', result);

        // Capture customer for invoice creation BEFORE clearing state
        const customerForInvoice = selectedCustomer;
        // Use finalPaymentLines (not paymentLines) to check for credit payment
        // finalPaymentLines is the actual payments sent to backend (includes auto-credit)
        const hasCreditForInvoice = finalPaymentLines.some(
          (line) => line.paymentMethod === 'CREDIT'
        );

        // Prepare receipt data with payment lines (use finalPaymentLines which includes auto-credit)
        const itemDiscountTotal = items.reduce(
          (sum, item) => new Decimal(sum).plus(item.discount?.amount || 0).toNumber(),
          0
        );
        setReceiptData(
          makePosReceiptData({
            saleNumber: sale.saleNumber || sale.sale_number || '',
            saleDate: formatReceiptDateTime(
              (sale.createdAt || sale.created_at) ? new Date(sale.createdAt || sale.created_at || '') : new Date()
            ),
            subtotal,
            discountAmount: cartDiscountAmount + itemDiscountTotal,
            taxAmount: tax,
            totalAmount: sale.totalAmount || sale.total_amount || grandTotal,
            items: items.map((item) => ({
              name: item.name,
              quantity: item.quantity,
              unitPrice: item.unitPrice,
              subtotal: item.subtotal,
              uom: item.uom,
              discountAmount: item.discount?.amount,
              taxRate: item.taxRate,
              isTaxable: item.isTaxable,
            })),
            payments: finalPaymentLines.map((line) => ({
              method: line.paymentMethod,
              amount: line.amount,
              reference: line.reference,
            })),
            changeGiven: changeAmount,
          })
        );

        // Clear cart and payment lines
        console.log('🧹 Clearing cart and closing modals...');
        setItems([]);
        setSelectedCustomer(null);
        setCartDiscount(null);
        setTaxOverride(null);
        setExchangeCredit(null);
        setLoadedQuoteId(null); // Clear quote reference after successful sale

        // Clear quote customer persistence data after successful sale
        localStorage.removeItem('pos_loaded_quote_customer');
        console.log('🧹 Cleared quote customer persistence data');

        setShowPaymentModal(false);
        setPaymentLines([]);
        setPaymentAmount('');
        setPaymentReference('');
        setSaleDate('');
        setShowDatePicker(false);
        setLastSale({ ...sale, isPersistedSale: true });
        presentSaleReceipt();
        console.log('✅ Modals updated: payment=false, receipt presented (auto-print if enabled)');

        // MANDATORY: Create invoice for any credit payment (business rule)
        // Credit sales MUST have invoices to track accounts receivable
        console.log('🔍 Checking invoice creation conditions:', {
          customerForInvoice: customerForInvoice?.name,
          hasCreditForInvoice,
          finalPaymentLines: finalPaymentLines.map((p) => ({
            method: p.paymentMethod,
            amount: p.amount,
          })),
        });

        // NOTE: Backend automatically creates invoices for credit sales inside the sale transaction
        // (see salesService.ts ~line 769-843). We don't need to create them again here.
        // The backend handles: quote conversions → invoice, credit sales → invoice
        if (customerForInvoice && hasCreditForInvoice) {
          console.log('ℹ️ Credit sale detected - invoice created by backend automatically', {
            saleId: sale.id,
            saleNumber: sale.saleNumber || sale.sale_number,
            customerId: customerForInvoice.id,
            customerName: customerForInvoice.name,
          });
          setInvoiceCreated(true);
          toast.success('Credit sale with invoice created successfully!');
        } else {
          console.log('ℹ️ No invoice creation needed:', {
            reason: !customerForInvoice ? 'No customer selected' : 'No credit payment',
            customerForInvoice: customerForInvoice?.name,
            hasCreditForInvoice,
          });
        }

        toast.success('Sale completed successfully!');

        // Refresh held orders count in case any were affected
        refreshHeldOrdersCount();
      }
    } catch (error: unknown) {
      console.error('Sale creation error:', error);
      const axErr = error as AxiosLikeError;
      console.error('Error response:', axErr.response?.data);

      const respData = axErr.response?.data;
      const errorMsg = respData?.error || axErr.message || 'Unknown error';
      const errorCode = respData?.error_code;
      const details = respData?.details as Record<string, unknown> | undefined;
      const statusCode = axErr.response?.status;

      let userMessage = '❌ Sale Creation Failed\n\n';

      if (statusCode === 400) {
        if (errorCode === 'ERR_STOCK_001' || errorCode === 'ERR_EXPIRY_001') {
          const product = String(details?.product ?? 'Unknown');
          const requested = Number(details?.requested ?? 0);
          const available = Number(details?.available ?? 0);
          const shortBy = Number(details?.shortBy ?? 0);
          const expiryDate = details?.expiryDate ? String(details.expiryDate) : null;
          const minDays = details?.minDaysBeforeExpiry ? Number(details.minDaysBeforeExpiry) : null;

          userMessage += `📦 Insufficient Stock\n\n`;
          userMessage += `Product:  ${product}\n`;
          userMessage += `Requested:  ${requested} units\n`;
          userMessage += `Available:  ${available} units\n`;
          userMessage += `Short by:  ${shortBy} units\n`;

          if (expiryDate && minDays) {
            userMessage += `\n⚠️ Expiry Rule Active\n`;
            userMessage += `Nearest batch expires: ${expiryDate}\n`;
            userMessage += `Minimum ${minDays} days before expiry required to sell.\n`;
          } else if (expiryDate) {
            userMessage += `\nNearest batch expires: ${expiryDate}\n`;
          }

          userMessage += `\n💡 What you can do:\n`;
          if (minDays) {
            userMessage += `• Go to Inventory → Batch Management to check batch expiry dates\n`;
            userMessage += `• Lower the "Min Days Before Expiry" setting on this product\n`;
          }
          userMessage += `• Reduce the quantity in the cart\n`;
          userMessage += `• Receive new stock via Purchase Order → Goods Receipt`;
        } else if (errorCode === 'ERR_PAYMENT_001') {
          const total = Number(details?.totalAmount ?? 0);
          const received = Number(details?.amountReceived ?? 0);
          const shortfall = Number(details?.shortfall ?? 0);

          userMessage += `💰 Insufficient Payment\n\n`;
          userMessage += `Sale Total:  ${total.toFixed(2)}\n`;
          userMessage += `Amount Received:  ${received.toFixed(2)}\n`;
          userMessage += `Short by:  ${shortfall.toFixed(2)}\n`;
          userMessage += `\n💡 What you can do:\n`;
          userMessage += `• Increase the payment amount\n`;
          userMessage += `• Add another payment method (split payment)\n`;
          userMessage += `• Change to Credit sale if customer has credit terms`;
        } else if (errorCode === 'ERR_SALE_002' || errorCode === 'ERR_SALE_003') {
          userMessage += `👤 Customer Required\n\n${errorMsg}\n\n💡 What you can do:\n• Select a customer before completing the sale\n• Search for an existing customer or create a new one`;
        } else if (errorCode === 'ERR_PAYMENT_002') {
          userMessage += `💰 Invalid Payment Amount\n\n${errorMsg}\n\n💡 Enter a valid positive payment amount.`;
        } else if (errorCode === 'ERR_PAYMENT_003') {
          userMessage += `💰 Overpayment Not Allowed\n\n${errorMsg}\n\n💡 For credit sales, payment cannot exceed the total. Reduce the payment amount.`;
        } else if (errorCode?.startsWith('ERR_SESSION_')) {
          // Session enforcement errors — prompt cashier to open/reopen register
          userMessage += `🖥️ Cash Register Session Issue\n\n${errorMsg}\n\n`;
          if (errorCode === 'ERR_SESSION_001') {
            userMessage += `💡 You need to open a cash register session before making sales.`;
          } else if (errorCode === 'ERR_SESSION_002') {
            userMessage += `💡 Your session has expired or is invalid. Please close and reopen your register.`;
          } else if (errorCode === 'ERR_SESSION_003') {
            userMessage += `💡 Your register session was closed. Please open a new session to continue.`;
          } else if (errorCode === 'ERR_SESSION_004') {
            userMessage += `💡 This register is assigned to another cashier, or you have not joined this counter.`;
          } else if (errorCode === 'ERR_SESSION_005') {
            userMessage += `💡 Register session could not be verified. Retry — the sale was not saved.`;
          }
          // Auto-trigger open register dialog so the user can fix it immediately
          setShowOpenRegisterDialog(true);
        } else if (errorCode === 'BELOW_ALLOCATED_COST') {
          userMessage += `🚫 ${errorMsg}\n\n💡 Unit price must be at or above actual inventory cost (per selected UoM). No manager override.`;
        } else if (errorCode?.startsWith('ERR_SALE_') || errorCode?.startsWith('ERR_PAYMENT_')) {
          userMessage += `⚠️ Sale Error [${errorCode}]\n\n${errorMsg}`;
        } else if (
          errorCode === 'ERR_VALIDATION' ||
          errorCode === 'ERR_BUSINESS' ||
          errorCode === 'ERR_CONSTRAINT' ||
          errorCode === 'ERR_NOT_FOUND'
        ) {
          userMessage += `⚠️ ${errorMsg}\n\n💡 Check:\n• All payment amounts are valid\n• Products have correct prices\n• Customer information is complete`;
        } else {
          // Fallback for other 400 errors without a known error_code
          userMessage += `🔍 Invalid Data\n${errorMsg}\n\n💡 Check:\n• All payment amounts are valid\n• Products have correct prices\n• Customer information is complete`;
        }
      } else if (statusCode === 401 || statusCode === 403) {
        userMessage += `🔐 Authentication Error\n${errorMsg}\n\n💡 Please:\n• Log out and log back in\n• Check your permissions\n• Contact administrator if issue persists`;
      } else if (statusCode === 404) {
        userMessage += `🔍 Not Found\n${errorMsg}\n\n💡 This may indicate:\n• Product was deleted\n• Customer was deleted\n• Database connection issue`;
      } else if (statusCode === 409) {
        userMessage += `⚠️ Conflict\n${errorMsg}\n\n💡 This may indicate:\n• Duplicate sale number\n• Inventory already sold\n• Please try again`;
      } else if (statusCode && statusCode >= 500) {
        userMessage += `🔧 Server Error [${errorCode || statusCode}]\n${errorMsg}\n\n💡 Server is having issues:\n• Sale was NOT saved\n• Please try again\n• If offline, sale will sync when online\n• Contact support if persists`;
      } else if (axErr.code === 'ERR_NETWORK' || !navigator.onLine) {
        userMessage += `📡 Network Error\n\nNo internet connection detected.\n\n💡 Options:\n• Check your internet connection\n• Sale will be saved offline\n• It will sync when connection restored\n\nDon't worry - no data is lost!`;
      } else {
        userMessage += `${errorMsg}\n\n💡 What to do:\n• Try the sale again\n• Check all entered information\n• Contact support if error repeats`;
      }

      alert(userMessage);
    } finally {
      isSubmittingRef.current = false; // Reset ref
      setIsProcessingSale(false);
    }
  };

  const posNavItems = useMemo(() => {
    if (isCashierLockdownActive({ role: user?.role, permissions })) {
      return resolveCashierNavItems(restaurantEnabled, permissions);
    }
    return [
      { name: 'Dashboard', path: '/dashboard', icon: '📊' },
      ...(restaurantEnabled
        ? [{ name: 'Restaurant', path: '/restaurant', icon: '🍽️' }]
        : [{ name: 'Point of Sale', path: '/pos', icon: '🛒' }]),
      { name: 'Inventory', path: '/inventory', icon: '📦' },
      { name: 'Customers', path: '/customers', icon: '👥' },
      { name: 'Suppliers', path: '/suppliers', icon: '🏢' },
      { name: 'Sales', path: '/sales', icon: '💰' },
      { name: 'Quotations', path: '/quotations', icon: '💼' },
      { name: 'Delivery', path: '/delivery', icon: '🚚' },
      { name: 'Accounting', path: '/accounting', icon: '🧾' },
      { name: 'Reports', path: '/reports', icon: '📈' },
      ...(canAccessImport || canAccessSettings || canAccessRoles
        ? [
            ...(canAccessImport ? [{ name: 'Import', path: '/import', icon: '📥' }] : []),
            ...(canAccessSettings ? [{ name: 'Settings', path: '/settings', icon: '⚙️' }] : []),
            ...(canAccessRoles ? [{ name: 'Roles', path: '/admin/roles', icon: '🔐' }] : []),
          ]
        : []),
    ];
  }, [
    canAccessImport,
    canAccessSettings,
    canAccessRoles,
    user?.role,
    permissions,
    restaurantEnabled,
  ]);

  return (
    <AdaptiveAppShell className="h-screen" pathname={location.pathname}>
    <PosWorkspaceSurface tier={tier} chrome={chrome}>
      {/* Navigation Drawer */}
      {showNavDrawer && (
        <>
          <div
            className="fixed inset-0 bg-black bg-opacity-50 z-50"
            onClick={() => setShowNavDrawer(false)}
          />
          <aside className="fixed inset-y-0 left-0 w-64 bg-white shadow-2xl z-50 flex flex-col animate-in slide-in-from-left duration-200">
            <div className="h-14 flex items-center justify-between px-4 border-b">
              <span className="text-lg font-bold text-gray-900">{invoiceSettings?.companyName || 'SMART ERP'}</span>
              <button
                onClick={() => setShowNavDrawer(false)}
                className="p-1.5 rounded-lg hover:bg-gray-100"
                aria-label="Close menu"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <nav className="flex-1 overflow-y-auto py-2">
              <ul className="space-y-0.5 px-2">
                {posNavItems.map((item) => (
                  <li key={item.path}>
                    <Link
                      to={item.path}
                      onClick={() => setShowNavDrawer(false)}
                      className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors ${location.pathname === item.path || location.pathname.startsWith(item.path + '/')
                        ? 'bg-blue-50 text-blue-700 font-medium'
                        : 'text-gray-700 hover:bg-gray-100'
                        }`}
                    >
                      <span className="text-xl">{item.icon}</span>
                      <span>{item.name}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
            <div className="border-t p-3">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-9 h-9 rounded-full bg-blue-600 flex items-center justify-center text-white font-bold text-sm">
                  {user?.fullName?.charAt(0).toUpperCase() || 'U'}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">{user?.fullName || 'User'}</p>
                  <p className="text-xs text-gray-500">{user?.role || 'Staff'}</p>
                </div>
              </div>
              <button
                onClick={() => { setShowNavDrawer(false); logout(); navigate('/quick-login'); }}
                className="w-full px-3 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 transition-colors"
              >
                Switch User
              </button>
            </div>
          </aside>
        </>
      )}

      {/* Header / Title */}
      <header className="px-3 sm:px-6 py-3 sm:py-4 border-b bg-white flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowNavDrawer(true)}
            className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors"
            aria-label="Open navigation menu"
          >
            <svg className="w-6 h-6 text-gray-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <h1 className="text-lg sm:text-2xl font-bold text-gray-900">Point of Sale</h1>
          {assignedStore?.storeName && (
            <span
              className="text-xs px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-800 font-medium"
              title="Stock and search are scoped to this location"
            >
              {assignedStore.storeName}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 sm:gap-4">
          {/* Cash Register Status */}
          <RegisterStatusIndicator compact />
          <span
            className={`text-xs px-2 py-1 rounded ${isOnline ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}
          >
            {isOnline ? 'Online' : 'Offline'}
          </span>
          {pendingCount > 0 && (
            <span className="text-xs px-2 py-1 rounded bg-yellow-100 text-yellow-800">
              {pendingCount} pending
            </span>
          )}
          {reviewCount > 0 && (
            <button
              onClick={() => setShowSyncPanel((p) => !p)}
              className="text-xs px-2 py-1 rounded bg-orange-100 text-orange-800 hover:bg-orange-200 cursor-pointer"
              title="View & retry offline sales"
            >
              {reviewCount} review
            </button>
          )}
          {failedCount > 0 && (
            <button
              onClick={() => setShowSyncPanel((p) => !p)}
              className="text-xs px-2 py-1 rounded bg-red-100 text-red-800 hover:bg-red-200 cursor-pointer"
              title="View & retry offline sales"
            >
              {failedCount} failed
            </button>
          )}
          {shouldShowCoach(chrome, 'coach') ? (
            <span className="text-xs text-gray-500" data-pos-coach="precision">
              Bank-grade precision
            </span>
          ) : null}
          <ServerClock />
        </div>
      </header>
      {/* Inline Offline Sync Panel — accessible to cashiers */}
      {showSyncPanel && (failedCount > 0 || reviewCount > 0 || pendingCount > 0) && (
        <div className="border-b bg-white px-4 py-3 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold text-gray-900">Offline Sales Queue</h3>
            <div className="flex items-center gap-2">
              {(failedCount > 0 || reviewCount > 0) && isOnline && (
                <button
                  onClick={() => {
                    retryAllFailed();
                    toast.success(`Moved ${failedCount + reviewCount} sale(s) back to pending`);
                  }}
                  className="text-xs px-3 py-1.5 bg-orange-600 hover:bg-orange-700 text-white rounded font-medium transition-colors"
                >
                  🔄 Retry All ({failedCount + reviewCount})
                </button>
              )}
              {pendingCount > 0 && isOnline && (
                <button
                  onClick={async () => {
                    const results = await syncPendingSales(apiClient);
                    const synced = results.filter((r: { success: boolean }) => r.success).length;
                    if (synced > 0) toast.success(`Synced ${synced} sale(s)`);
                  }}
                  className="text-xs px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white rounded font-medium transition-colors"
                >
                  ⬆️ Sync Pending ({pendingCount})
                </button>
              )}
              <button
                onClick={() => setShowSyncPanel(false)}
                className="text-gray-400 hover:text-gray-600 text-lg leading-none"
              >
                ✕
              </button>
            </div>
          </div>
          <div className="max-h-48 overflow-y-auto border rounded divide-y divide-gray-100">
            {syncQueue
              .filter((s) => s.syncStatus !== 'SYNCED')
              .map((sale) => (
                <div key={sale.key} className="px-3 py-2 flex items-center justify-between">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-gray-900">{sale.offlineId}</p>
                    <div className="flex items-center gap-2 text-xs text-gray-500">
                      <span>{sale.lineCount} items</span>
                      <span>•</span>
                      <span>{formatTimestampTime(String(sale.ts))}</span>
                    </div>
                    {sale.syncError && (
                      <p className="text-xs text-red-500 mt-0.5 break-words">{sale.syncError}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 ml-3">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${sale.syncStatus === 'PENDING' ? 'bg-yellow-100 text-yellow-700' :
                      sale.syncStatus === 'REVIEW' ? 'bg-orange-100 text-orange-700' :
                        'bg-red-100 text-red-700'
                      }`}>
                      {sale.syncStatus.replace('_', ' ')}
                    </span>
                    {(sale.syncStatus === 'FAILED' || sale.syncStatus === 'REVIEW') && (
                      <button
                        onClick={() => {
                          retryFailedSale(sale.key);
                          toast.success(`${sale.offlineId} moved to pending`);
                        }}
                        className="text-blue-500 hover:text-blue-700 text-xs font-medium"
                      >
                        ↻ Retry
                      </button>
                    )}
                    <button
                      onClick={() => {
                        if (confirm(`Cancel offline sale ${sale.offlineId}? Stock will be restored.`)) {
                          cancelOfflineSale(sale.key);
                          toast.success(`Cancelled ${sale.offlineId}`);
                        }
                      }}
                      className="text-red-400 hover:text-red-600 text-xs"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ))}
          </div>
        </div>
      )}
      {/* Offline Mode Banner */}
      {!isOnline && (
        <div className="px-3 sm:px-4 py-2 bg-amber-500 text-white text-sm font-medium flex flex-col sm:flex-row items-start sm:items-center justify-between gap-1 sm:gap-0">
          <div className="flex items-center gap-2">
            <span className="text-lg">⚠️</span>
            <span className="text-xs sm:text-sm">Offline Mode — Cash sales only. Sales sync when online.</span>
          </div>
          <div className="flex items-center gap-3 text-xs">
            {pendingCount > 0 && (
              <span className="bg-amber-600 px-2 py-0.5 rounded">
                {pendingCount} sale(s) queued
              </span>
            )}
            <span className="opacity-75">Credit, deposit &amp; discount approval disabled</span>
          </div>
        </div>
      )}
      {/* Order Mode Banner */}
      {isOrderMode && (
        <div className="flex items-center justify-end gap-2 border-b border-orange-200 bg-orange-50 px-3 py-1.5 sm:px-4">
          <div className={`${POS_ADAPTIVE_CLASSES.orderModeText} min-w-0 flex-1 items-center gap-2 text-sm font-medium text-orange-800`}>
            <span aria-hidden>📋</span>
            <span>Order Mode — Items will be saved as an order for cashier payment</span>
          </div>
          <Link
            to="/orders-queue"
            className="inline-flex shrink-0 items-center rounded-md border border-orange-300 bg-white px-3 py-1.5 text-sm font-semibold text-orange-700 shadow-sm hover:bg-orange-100"
          >
            View Queue →
          </Link>
        </div>
      )}
      <main
        className={POS_ADAPTIVE_CLASSES.mainLayout}
        inert={showPaymentModal || showReceiptModal ? true : undefined}
      >
        <section className={POS_ADAPTIVE_CLASSES.searchPanel} data-pos-search-panel="true">
          <div className="mb-2" data-pos-adaptive-scanner="true">
            <AdaptiveScanner
              onScan={handleBarcodeScanned}
              enabled
              minLength={3}
              maxLength={50}
              timeout={100}
            />
          </div>
          <POSProductSearch
            ref={productSearchRef}
            onSelect={handleAddProduct}
            isOnline={isOnline}
          />
        </section>

        <div className={POS_ADAPTIVE_CLASSES.workArea}>
        {/* Center: Line items - Scrollable cart */}
        <section className="flex-1 min-w-0 p-2 sm:p-4 overflow-y-auto overscroll-contain touch-pan-y">
          {exchangeCredit && (
            <div className="mb-3 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-950">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-semibold">Exchange store credit active</p>
                  <p className="text-xs mt-0.5">
                    {formatCurrency(exchangeCredit.amount)} from {exchangeCredit.refundNumber}
                    {exchangeCredit.saleNumber ? ` (${exchangeCredit.saleNumber})` : ''}.
                    Applied as cart discount when you add replacement items.
                  </p>
                </div>
                <button
                  type="button"
                  className="text-xs underline text-blue-800"
                  onClick={() => {
                    setExchangeCredit(null);
                    setCartDiscount(null);
                  }}
                >
                  Clear credit
                </button>
              </div>
              <div className="mt-2 grid sm:grid-cols-2 gap-2 text-xs">
                <label className="flex gap-2 items-start border border-blue-100 bg-white rounded p-2 cursor-pointer">
                  <input
                    type="radio"
                    name="pos-exchange-residual"
                    checked={exchangeResidualAction === 'REFUND_ORIGINAL_TENDER'}
                    onChange={() => setExchangeResidualAction('REFUND_ORIGINAL_TENDER')}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="font-medium">Pay leftover cash now</span>
                    <span className="block text-blue-700/80">If replacement is cheaper</span>
                  </span>
                </label>
                <label className="flex gap-2 items-start border border-blue-100 bg-white rounded p-2 cursor-pointer">
                  <input
                    type="radio"
                    name="pos-exchange-residual"
                    checked={exchangeResidualAction === 'KEEP_VOUCHER'}
                    onChange={() => setExchangeResidualAction('KEEP_VOUCHER')}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="font-medium">Keep voucher {exchangeCredit.refundNumber}</span>
                    <span className="block text-blue-700/80">Leftover stays as numbered store credit</span>
                  </span>
                </label>
              </div>
            </div>
          )}
          {/* Card cart — mobile + compact (< lg / 1024px) */}
          <div className={POS_ADAPTIVE_CLASSES.cartCards}>
            {items.length === 0 ? (
              <div className="text-center py-8 text-gray-400 bg-white rounded shadow">
                No items in cart
              </div>
            ) : (
              <div className={POS_ADAPTIVE_CLASSES.cartCardList}>
                {items.map((item, idx) => {
                  const stockUom = getPosLineStockAvailability(
                    item.stockOnHand,
                    item.availableUoms,
                    item.selectedUomId,
                    item.uom,
                  );
                  const lineQtyOverStock = isPosQtyOverStockInSellingUom(
                    item.quantity,
                    item.stockOnHand,
                    item.availableUoms,
                    item.selectedUomId,
                  );
                  return (
                    <PosCartCompactLine
                      key={`mobile-${item.id}-${item.selectedUomId}-${idx}`}
                      item={item}
                      index={idx}
                      focused={idx === focusedCartIndex}
                      stockUom={stockUom}
                      lineQtyOverStock={lineQtyOverStock}
                      pricingMode={selectedCustomer?.pricingMode}
                      atCostHint={item.atCostLayerLabel ?? null}
                      onFocus={() => setFocusedCartIndex(idx)}
                      onRemove={() => setItems((prev) => prev.filter((_, i) => i !== idx))}
                      onQuantityChange={(qty) => handleQuantityChange(idx, qty)}
                      onUnitPriceChange={(price, opts) => handleUnitPriceChange(idx, price, opts)}
                      onUnitPriceCommit={(price) => handleUnitPriceChange(idx, price)}
                      onUomChange={(uomId) => handleUomChange(idx, uomId)}
                      onOpenDiscount={() => handleOpenDiscountDialog('item', idx)}
                      onRemoveDiscount={() => handleRemoveDiscount('item', idx)}
                      ref={(el) => {
                        cartRowRefs.current[idx] = el;
                      }}
                    />
                  );
                })}
              </div>
            )}
          </div>

          {/* Table cart — desktop + wide (lg+) */}
          <div className={POS_ADAPTIVE_CLASSES.cartTable}>
            <ResponsiveTableWrapper>
              <table className={`${POS_ADAPTIVE_CLASSES.cartTableFixed} text-xs sm:text-sm border rounded shadow bg-white`}>
                <colgroup>
                  {cartColWidths.map((width, i) => (
                    <col key={`${width}-${i}`} style={{ width }} />
                  ))}
                </colgroup>
                <thead className="bg-gray-100">
                  <tr>
                    <th className="px-2 py-2 text-left">Product</th>
                    <th className="px-2 py-2 text-left">UoM</th>
                    <th className="px-2 py-2 text-right whitespace-nowrap">Qty</th>
                    <th className="px-2 py-2 text-right whitespace-nowrap">Unit Price</th>
                    <th className="px-2 py-2 text-right whitespace-nowrap">Subtotal</th>
                    <th className={`px-2 py-2 text-right whitespace-nowrap ${POS_ADAPTIVE_CLASSES.cartMarginCol}`}>Margin</th>
                    <th className="px-2 py-2 text-center whitespace-nowrap">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {items.length === 0 ? (
                    <tr>
                      <td colSpan={isWideViewport ? 7 : 6} className="text-center py-8 text-gray-400">
                        No items in cart
                      </td>
                    </tr>
                  ) : (
                    items.map((item, idx) => {
                      const stockUom = getPosLineStockAvailability(
                        item.stockOnHand,
                        item.availableUoms,
                        item.selectedUomId,
                        item.uom,
                      );
                      const lineQtyOverStock = isPosQtyOverStockInSellingUom(
                        item.quantity,
                        item.stockOnHand,
                        item.availableUoms,
                        item.selectedUomId,
                      );
                      return (
                      <tr
                        key={`${item.id}-${item.selectedUomId}-${idx}`}
                        ref={(el) => {
                          cartRowRefs.current[idx] = el;
                        }}
                        className={`border-b hover:bg-gray-50 transition-colors ${idx === focusedCartIndex ? 'bg-blue-100 dark:bg-blue-800' : ''
                          }`}
                        onClick={() => setFocusedCartIndex(idx)}
                      >
                        <td className={POS_ADAPTIVE_CLASSES.cartProductCell}>
                          <div className="flex items-start gap-2 min-w-0">
                            <div className="min-w-0 flex-1">
                              <div className={POS_ADAPTIVE_CLASSES.cartProductName}>{item.name}</div>
                              <div className={`text-xs text-gray-500 truncate ${POS_ADAPTIVE_CLASSES.cartSku}`}>
                                SKU: {item.sku}
                              </div>
                              <AtCostFifoHint item={item} />
                              <div className={`text-xs text-gray-500 ${POS_ADAPTIVE_CLASSES.cartMarginInline}`}>
                                Margin: {item.marginPct.toFixed(1)}%
                              </div>
                            </div>
                            {item.productType === 'service' && <ServiceBadge />}
                          </div>
                        </td>
                        <td className="px-2 py-2">
                          {item.availableUoms && item.availableUoms.length > 1 ? (
                            <select
                              value={item.selectedUomId || ''}
                              onChange={(e) => handleUomChange(idx, e.target.value)}
                              onFocus={() => setFocusedCartIndex(idx)}
                              className="border rounded px-1 sm:px-2 py-1 text-xs sm:text-sm focus:ring-2 focus:ring-blue-500 w-full"
                              aria-label={`Unit of measure for ${item.name}`}
                            >
                              {item.availableUoms.map((u) => (
                                <option key={u.uomId} value={u.uomId}>
                                  {u.symbol || u.name}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <span className="text-gray-700 text-xs sm:text-sm">{item.uom}</span>
                          )}
                        </td>
                        <td className={POS_ADAPTIVE_CLASSES.cartColQty}>
                          <div className="ml-auto w-fit max-w-full">
                            <FohLineQtyEditors
                              value={item.quantity}
                              overStock={lineQtyOverStock}
                              uomLabel={stockUom.uomLabel}
                              productName={item.name}
                              onFocus={() => setFocusedCartIndex(idx)}
                              onChange={(qty) => handleQuantityChange(idx, qty)}
                            />
                          </div>
                          {(lineQtyOverStock || stockUom.stockHint) && (
                            <div className="text-red-600 text-[10px] mt-0.5 whitespace-nowrap">
                              {stockUom.stockHint ??
                                `Only ${stockUom.stockInSellingUom} ${stockUom.uomLabel} in stock`}
                            </div>
                          )}
                        </td>
                        <td className={POS_ADAPTIVE_CLASSES.cartColUnitPrice}>
                          <div className="ml-auto max-w-[6.5rem]">
                          <PosUnitPriceInput
                            value={item.unitPrice}
                            minUnitPrice={getPosLineMinUnitPrice(item, selectedCustomer?.pricingMode)}
                            atCostLine={
                              selectedCustomer?.pricingMode === 'AT_COST' ||
                              item.pricingRule?.scope === 'at_cost'
                            }
                            uomLabel={stockUom.uomLabel}
                            productName={item.name}
                            onFocus={() => setFocusedCartIndex(idx)}
                            onChange={(price) =>
                              handleUnitPriceChange(idx, price, { silent: true })
                            }
                            onCommit={(price) => handleUnitPriceChange(idx, price)}
                            manualOverride={!!item.unitPriceManuallySet}
                          />
                          </div>
                        </td>
                        <td className={POS_ADAPTIVE_CLASSES.cartColSubtotal}>
                          {item.discount ? (
                            <div>
                              <span className="line-through text-gray-400 text-[10px]">
                                {formatCurrency(item.quantity * item.unitPrice)}
                              </span>
                              <br />
                              <span>{formatCurrency(item.subtotal)}</span>
                              <span className="text-red-500 text-[10px] ml-1">
                                (-{formatCurrency(item.discount.amount)})
                              </span>
                            </div>
                          ) : (
                            formatCurrency(item.subtotal)
                          )}
                        </td>
                        <td
                          className={
                            `px-2 py-2 text-right align-top whitespace-nowrap tabular-nums text-xs sm:text-sm ${POS_ADAPTIVE_CLASSES.cartMarginCol} ` +
                            (isPosLineBlockedByCatalogCost(item, selectedCustomer?.pricingMode)
                              ? 'text-red-700 font-bold'
                              : item.marginPct < 10
                                ? 'text-red-600'
                                : item.marginPct < 20
                                  ? 'text-yellow-600'
                                  : 'text-green-600')
                          }
                        >
                          {isPosLineBlockedByCatalogCost(item, selectedCustomer?.pricingMode) ? (
                            <span title={`Unit ${formatCurrency(item.unitPrice)} / line ${formatCurrency(item.subtotal)} below min (${formatCurrency(getPosLineMinUnitPrice(item, selectedCustomer?.pricingMode))} per ${stockUom.uomLabel})`}>
                              ⚠ BELOW COST
                            </span>
                          ) : (
                            `${item.marginPct.toFixed(1)}%`
                          )}
                        </td>
                        <td className={POS_ADAPTIVE_CLASSES.cartColActions}>
                          <div className="flex flex-col items-center justify-center gap-0.5">
                            {item.discount ? (
                              <button
                                onClick={() => handleRemoveDiscount('item', idx)}
                                onFocus={() => setFocusedCartIndex(idx)}
                                className="text-red-500 hover:text-red-700 text-xs px-1 py-0.5 rounded border border-red-200 hover:border-red-400"
                                aria-label={`Remove discount from ${item.name}`}
                                title="Remove item discount"
                              >
                                ✕%
                              </button>
                            ) : item.pricingRule?.scope !== 'at_cost' && (
                              <button
                                onClick={() => handleOpenDiscountDialog('item', idx)}
                                onFocus={() => setFocusedCartIndex(idx)}
                                className="text-amber-600 hover:text-amber-800 text-xs px-1 py-0.5 rounded border border-amber-200 hover:border-amber-400"
                                aria-label={`Add discount to ${item.name}`}
                                title="Item discount"
                              >
                                %
                              </button>
                            )}
                            <button
                              onClick={() => setItems((prev) => prev.filter((_, i) => i !== idx))}
                              onFocus={() => setFocusedCartIndex(idx)}
                              className="text-red-600 hover:text-red-800 font-bold text-lg leading-none px-1.5 py-0.5 shrink-0"
                              aria-label={`Remove ${item.name}`}
                              title="Remove item"
                            >
                              ×
                            </button>
                          </div>
                        </td>
                      </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </ResponsiveTableWrapper>
          </div>
        </section>

        {/* Right: Totals + Payment - Full width on mobile, 1/4 on desktop */}
        <section className="w-full lg:w-[min(100%,22rem)] xl:min-w-[260px] shrink-0 bg-white border-t lg:border-t-0 lg:border-l p-3 sm:p-4 flex flex-col overflow-y-auto overscroll-contain touch-pan-y">
          <CustomerSelector
            selectedCustomer={selectedCustomer}
            onSelectCustomer={setSelectedCustomer}
            saleTotal={grandTotal}
            retailAdaptive
          />
          <div className="mb-4">
            <div className="font-semibold text-base sm:text-lg text-gray-900">Totals</div>
            <div className="flex flex-col gap-1 sm:gap-2 mt-2 text-sm sm:text-base">
              <div className="flex justify-between">
                <span>Subtotal:</span>
                <span className="font-medium">{formatCurrency(subtotal)}</span>
              </div>
              {cartDiscount && (
                <div className="flex justify-between items-center text-red-600">
                  <span className="flex items-center gap-1">
                    Discount (
                    {cartDiscount.type === 'PERCENTAGE' ? `${cartDiscount.value}%` : 'Fixed'}):
                    <button
                      onClick={() => handleRemoveDiscount('cart')}
                      className="text-xs text-red-500 hover:text-red-700 underline"
                      title="Remove discount"
                    >
                      Remove
                    </button>
                  </span>
                  <span className="font-medium">-{formatCurrency(cartDiscount.amount)}</span>
                </div>
              )}
              <div className="flex justify-between items-center">
                <span className="flex items-center gap-1 flex-wrap">
                  Tax
                  {taxInclusivePricing ? (
                    <span className="text-xs text-gray-500">(included)</span>
                  ) : null}
                  {taxOverride ? (
                    <span className="text-xs text-amber-700" data-tax-override-active="true">
                      ({taxOverride.mode === 'FORCE_EXEMPT' ? 'exempt' : `${taxOverride.rate}%`})
                      <button
                        type="button"
                        onClick={() => setTaxOverride(null)}
                        className="ml-1 text-xs text-amber-700 underline"
                      >
                        Clear
                      </button>
                    </span>
                  ) : canOfferTaxOverride ? (
                    <button
                      type="button"
                      onClick={() => setShowTaxOverrideDialog(true)}
                      className="text-xs text-amber-700 underline"
                      data-tax-override-open="true"
                      title="Override tax determination"
                    >
                      Override
                    </button>
                  ) : null}
                  :
                </span>
                <span className="font-medium">{formatCurrency(tax)}</span>
              </div>
              <div className="flex justify-between font-bold text-base sm:text-lg">
                <span>Grand Total:</span>
                <span>{formatCurrency(grandTotal)}</span>
              </div>
              <div className="flex justify-between text-xs sm:text-sm">
                <span>Avg Margin:</span>
                <span
                  className={
                    avgMargin < 10
                      ? 'text-red-600'
                      : avgMargin < 20
                        ? 'text-yellow-600'
                        : 'text-green-600'
                  }
                >
                  {avgMargin.toFixed(1)}%
                </span>
              </div>
            </div>
          </div>

          {/* Service Items Banner */}
          {serviceItemsCount > 0 && (
            <ServiceInfoBanner
              serviceCount={serviceItemsCount}
              totalRevenue={serviceRevenue}
              className="mb-3"
            />
          )}

          {/* Primary Action — Payment or Save Order */}
          {isOrderMode ? (
            <button
              onClick={handleCreateOrder}
              disabled={items.length === 0 || isCreatingOrder}
              className="w-full py-3 sm:py-3.5 mb-2 sm:mb-3 rounded-xl font-bold text-sm sm:text-base bg-gradient-to-r from-orange-500 to-orange-600 text-white hover:from-orange-600 hover:to-orange-700 active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed transition-all shadow-md shadow-orange-200 border border-orange-400"
            >
              {isCreatingOrder ? '⏳ Saving...' : `📋 Save Order ${items.length > 0 ? formatCurrency(grandTotal) : ''}`}
              <span className="hidden sm:block text-[10px] font-normal opacity-70 mt-0.5">Shift + Enter</span>
            </button>
          ) : (
            <button
              onClick={() => items.length > 0 && setShowPaymentModal(true)}
              disabled={items.length === 0}
              className="w-full py-3 sm:py-3.5 mb-2 sm:mb-3 rounded-xl font-bold text-sm sm:text-base bg-gradient-to-r from-emerald-500 to-emerald-600 text-white hover:from-emerald-600 hover:to-emerald-700 active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed transition-all shadow-md shadow-emerald-200 border border-emerald-400"
            >
              💳 Charge {items.length > 0 && formatCurrency(grandTotal)}
              <span className="hidden sm:block text-[10px] font-normal opacity-70 mt-0.5">Shift + Enter</span>
            </button>
          )}

          {/* Quick Actions — 2×2 colored grid */}
          <div className="grid grid-cols-4 gap-1 sm:gap-2.5 mb-2 sm:mb-3">
            {/* Discount */}
            <button
              onClick={() => handleOpenDiscountDialog('cart')}
              disabled={items.length === 0}
              className="flex flex-col items-center justify-center gap-0.5 sm:gap-1 px-1 sm:px-2 py-1.5 sm:py-3 rounded-lg sm:rounded-xl bg-gradient-to-b from-amber-50 to-amber-100 border border-amber-200 text-amber-800 text-[10px] sm:text-sm font-semibold hover:from-amber-100 hover:to-amber-200 active:scale-[0.97] disabled:opacity-40 disabled:cursor-not-allowed transition-all shadow-sm"
              title="Apply Discount (Ctrl+D)"
            >
              <span className="text-base sm:text-lg">🏷️</span>
              <span>Discount</span>
              <span className="hidden sm:block text-[9px] font-normal text-amber-500">Ctrl+D</span>
            </button>

            {/* Service Item */}
            <button
              onClick={() => setShowServiceItemDialog(true)}
              className="flex flex-col items-center justify-center gap-0.5 sm:gap-1 px-1 sm:px-2 py-1.5 sm:py-3 rounded-lg sm:rounded-xl bg-gradient-to-b from-violet-50 to-violet-100 border border-violet-200 text-violet-800 text-[10px] sm:text-sm font-semibold hover:from-violet-100 hover:to-violet-200 active:scale-[0.97] transition-all shadow-sm"
              title="Add Service / Non-Inventory Item (Ctrl+J)"
            >
              <span className="text-base sm:text-lg">🛠️</span>
              <span>Service</span>
              <span className="hidden sm:block text-[9px] font-normal text-violet-500">Ctrl+J</span>
            </button>

            {/* Hold / Retrieve */}
            <button
              onClick={handleHoldRetrieveToggle}
              disabled={items.length === 0 && heldOrdersCount === 0}
              className="relative flex flex-col items-center justify-center gap-0.5 sm:gap-1 px-1 sm:px-2 py-1.5 sm:py-3 rounded-lg sm:rounded-xl bg-gradient-to-b from-orange-50 to-orange-100 border border-orange-200 text-orange-800 text-[10px] sm:text-sm font-semibold hover:from-orange-100 hover:to-orange-200 active:scale-[0.97] disabled:opacity-40 disabled:cursor-not-allowed transition-all shadow-sm"
              title={items.length > 0 ? 'Hold Cart (Ctrl+H)' : `Retrieve Holds (Ctrl+H)`}
            >
              <span className="text-base sm:text-lg">{items.length > 0 ? '💾' : '📦'}</span>
              <span>{items.length > 0 ? 'Hold' : 'Retrieve'}</span>
              <span className="hidden sm:block text-[9px] font-normal text-orange-500">Ctrl+H</span>
              {heldOrdersCount > 0 && (
                <span className="absolute -top-1.5 -right-1.5 min-w-5 h-5 px-1 bg-orange-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center shadow">
                  {heldOrdersCount}
                </span>
              )}
            </button>

            {/* Quote */}
            <button
              onClick={handleQuoteToggle}
              disabled={items.length === 0 && quotesCount === 0}
              className="relative flex flex-col items-center justify-center gap-0.5 sm:gap-1 px-1 sm:px-2 py-1.5 sm:py-3 rounded-lg sm:rounded-xl bg-gradient-to-b from-sky-50 to-sky-100 border border-sky-200 text-sky-800 text-[10px] sm:text-sm font-semibold hover:from-sky-100 hover:to-sky-200 active:scale-[0.97] disabled:opacity-40 disabled:cursor-not-allowed transition-all shadow-sm"
              title={items.length > 0 ? 'Save Quote (Ctrl+Q)' : 'Load Quote (Ctrl+Q)'}
            >
              <span className="text-base sm:text-lg">{items.length > 0 ? '📝' : '📋'}</span>
              <span>{items.length > 0 ? 'Quote' : 'Load Quote'}</span>
              <span className="hidden sm:block text-[9px] font-normal text-sky-500">Ctrl+Q</span>
              {quotesCount > 0 && items.length === 0 && (
                <span className="absolute -top-1.5 -right-1.5 min-w-5 h-5 px-1 bg-sky-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center shadow">
                  {quotesCount}
                </span>
              )}
            </button>
          </div>

          {/* Clear — subtle danger button */}
          <button
            onClick={handleClearAllData}
            className="w-full py-2 text-xs font-medium text-red-400 hover:text-white hover:bg-red-500 rounded-lg border border-transparent hover:border-red-500 transition-all"
            title="Clear cart and all offline data (Ctrl+Shift+C)"
          >
            🗑️ Clear All
          </button>
        </section>
        </div>
      </main>
      {/* Receipt Modal */}
      {showReceiptModal && lastSale && (
        <POSModal
          open={showReceiptModal}
          onOpenChange={(open) => {
            setShowReceiptModal(open);
            // When modal closes (by any means), refocus search
            if (!open) {
              setTimeout(() => productSearchRef.current?.focusSearch(), 150);
            }
          }}
          title="Sale Complete"
          description={`Sale ${lastSale.saleNumber || ''} completed`}
          ariaLabel="Sale Receipt"
        >
          <div
            className="space-y-3"
            onKeyDown={(e) => {
              // Enter key: Print receipt
              if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
                e.preventDefault();
                setShowPrintDialog(true);
              }
              // Escape key: Close modal
              if (e.key === 'Escape') {
                e.preventDefault();
                setShowReceiptModal(false);
                // Focus back on search after transaction completes
                setTimeout(() => productSearchRef.current?.focusSearch(), 100);
              }
            }}
          >
            <div className="flex justify-between text-sm text-gray-600">
              <span>Sale Number</span>
              <span className="font-medium text-gray-900">{lastSale.saleNumber || '-'}</span>
            </div>
            <div className="flex justify-between text-sm text-gray-600">
              <span>Date</span>
              <span className="font-medium text-gray-900">{lastSale.saleDate || 'N/A'}</span>
            </div>
            <div className="flex justify-between text-sm text-gray-600">
              <span>Total</span>
              <span className="font-semibold">{formatCurrency(lastSale.totalAmount ?? 0)}</span>
            </div>
            {paymentMethod === 'CREDIT' && selectedCustomer && (
              <>
                {invoiceCreated && (
                  <div className="mt-3 bg-green-50 border border-green-200 rounded p-3">
                    <div className="flex items-center gap-2 text-sm text-green-800">
                      <span className="font-semibold">✓</span>
                      <span>Invoice created automatically</span>
                    </div>
                  </div>
                )}
                <div className="mt-4 space-y-2">
                  <button
                    className="w-full px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
                    onClick={() => {
                      setShowReceiptModal(false);
                      navigate(`/customers/${selectedCustomer.id}?tab=invoices`);
                    }}
                  >
                    View Customer Invoices
                  </button>
                  {!invoiceCreated && (
                    <button
                      className="w-full px-4 py-2 border border-gray-300 rounded bg-white hover:bg-gray-50"
                      onClick={() => {
                        setShowReceiptModal(false);
                        navigate(
                          `/customers/${selectedCustomer.id}?tab=invoices&createInvoice=1&saleId=${encodeURIComponent(lastSale.id || '')}`
                        );
                      }}
                    >
                      Create Invoice Manually
                    </button>
                  )}
                </div>
              </>
            )}
            <div className="flex gap-2 mt-6">
              <POSButton
                variant="primary"
                onClick={() => setShowPrintDialog(true)}
                className="flex-1"
                title="Print receipt (or press Enter)"
              >
                Print Receipt (Enter)
              </POSButton>
              <POSButton
                variant="secondary"
                onClick={() => {
                  setShowReceiptModal(false);
                  // Focus back on search after transaction completes
                  setTimeout(() => productSearchRef.current?.focusSearch(), 100);
                }}
                className="flex-1"
                title="Close without printing (or press Escape)"
              >
                Close (Esc)
              </POSButton>
            </div>
          </div>
        </POSModal>
      )}

      {/* Print Receipt Dialog — autoPrint when Settings → Auto-print receipt is on */}
      <PrintReceiptDialog
        open={showPrintDialog}
        autoPrint={shouldAutoPrintAfterSale({
          ...DEFAULT_RECEIPT_PRINT_CONFIG,
          enabled: receiptPrintEnabled,
          autoPrint: receiptAutoPrint,
        })}
        printerName={receiptPrinterName}
        onOpenChange={(open) => {
          setShowPrintDialog(open);
          // When print dialog closes, refocus search
          if (!open) {
            setTimeout(() => productSearchRef.current?.focusSearch(), 150);
          }
        }}
        receiptData={receiptData}
        onAfterPrint={() => {
          // Audit only real sales rows — hold-order UUIDs must not hit /sales/:id/reprint (404 toast).
          logSaleReceiptPrintAudit(lastSale?.id, lastSale?.isPersistedSale);
          // Close the receipt modal after printing
          setShowReceiptModal(false);
          // Refocus search after printing completes
          setTimeout(() => productSearchRef.current?.focusSearch(), 200);
        }}
      />

      {/* Payment Modal */}
      {showPaymentModal && (
        <POSModal
          open={showPaymentModal}
          onOpenChange={setShowPaymentModal}
          title="Payment"
          description={`Complete payment for ${items.length} item${items.length !== 1 ? 's' : ''} totaling ${formatCurrency(grandTotal)}`}
          ariaLabel="Payment"
        >
          <div
            onKeyDown={(e) => {
              // Global Enter key handler for payment modal
              if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
                // Don't trigger if user is typing in a text input (except number inputs)
                const target = e.target as HTMLElement;
                if (target.tagName === 'INPUT' && (target as HTMLInputElement).type === 'number') {
                  // Already handled by handlePaymentAmountKeyDown
                  return;
                }
                if (
                  target.tagName === 'TEXTAREA' ||
                  (target.tagName === 'INPUT' && (target as HTMLInputElement).type === 'text')
                ) {
                  // Don't trigger in text fields
                  return;
                }

                e.preventDefault();

                // Trigger appropriate button action
                if (remainingBalance > 0.01) {
                  // Add payment button
                  if (paymentMethod === 'CREDIT' && selectedCustomer) {
                    const amount = remainingBalance;
                    const newLine = {
                      id: `payment_${Date.now()}_${Math.random()}`,
                      paymentMethodId: 'CREDIT',
                      paymentMethod: 'CREDIT' as const,
                      amount: amount,
                      reference: undefined,
                      createdAt: new Date().toISOString(),
                    };
                    setPaymentLines([newLine]);
                    setTimeout(() => handleFinalizeSale(), 100);
                  } else if (paymentAmount && parseFloat(paymentAmount) > 0) {
                    handleAddPayment();
                  }
                } else if (canCompleteSale) {
                  // Complete sale button
                  handleFinalizeSale();
                }
              }
            }}
            className="max-h-[85vh] overflow-y-auto"
          >
            <div className="mb-3 sm:mb-4 font-semibold text-base sm:text-lg text-gray-900">
              Payment
            </div>
            <div className="mb-3 sm:mb-4">
              {cartDiscountAmount > 0 && (
                <>
                  <div className="flex justify-between mb-1 text-gray-600">
                    <span className="text-sm sm:text-base">Subtotal:</span>
                    <span className="text-sm sm:text-base">{formatCurrency(subtotal)}</span>
                  </div>
                  <div className="flex justify-between mb-2 text-green-700 font-medium">
                    <span className="text-sm sm:text-base">Discount:</span>
                    <span className="text-sm sm:text-base">-{formatCurrency(cartDiscountAmount)}</span>
                  </div>
                </>
              )}
              <div className="flex justify-between mb-1">
                <span className="font-medium text-sm sm:text-base">Total Amount:</span>
                <span className="font-bold text-lg sm:text-xl">{formatCurrency(grandTotal)}</span>
              </div>
              {isOnline && (
                <button
                  onClick={() => handleOpenDiscountDialog('cart')}
                  className="text-xs text-blue-600 hover:text-blue-800 underline mt-1"
                  type="button"
                >
                  {cartDiscountAmount > 0
                    ? `Edit Discount (-${formatCurrency(cartDiscountAmount)})`
                    : '+ Add Discount'}
                </button>
              )}
            </div>
            <div className="mb-4 sm:mb-6">
              <label className="block text-sm sm:text-base font-semibold text-gray-800 mb-2">
                Payment Method
              </label>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3">
                <button
                  onClick={() => setPaymentMethod('CASH')}
                  className={`py-3 sm:py-4 px-3 sm:px-4 rounded-lg font-semibold text-sm sm:text-base transition-all ${paymentMethod === 'CASH'
                    ? 'bg-green-600 text-white ring-2 sm:ring-4 ring-green-300 shadow-lg transform scale-105'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200 border-2 border-gray-300'
                    }`}
                >
                  <span className="hidden sm:inline">💵 </span>Cash
                </button>
                <button
                  onClick={() => setPaymentMethod('CARD')}
                  className={`py-3 sm:py-4 px-3 sm:px-4 rounded-lg font-semibold text-sm sm:text-base transition-all ${paymentMethod === 'CARD'
                    ? 'bg-blue-600 text-white ring-2 sm:ring-4 ring-blue-300 shadow-lg transform scale-105'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200 border-2 border-gray-300'
                    }`}
                >
                  <span className="hidden sm:inline">💳 </span>Card
                </button>
                <button
                  onClick={() => setPaymentMethod('MOBILE_MONEY')}
                  className={`py-3 sm:py-4 px-3 sm:px-4 rounded-lg font-semibold text-sm sm:text-base transition-all ${paymentMethod === 'MOBILE_MONEY'
                    ? 'bg-yellow-600 text-white ring-2 sm:ring-4 ring-yellow-300 shadow-lg transform scale-105'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200 border-2 border-gray-300'
                    }`}
                >
                  <span className="hidden sm:inline">📱 </span>MTN MoMo
                </button>
                <button
                  onClick={() => setPaymentMethod('AIRTEL_MONEY')}
                  className={`py-3 sm:py-4 px-3 sm:px-4 rounded-lg font-semibold text-sm sm:text-base transition-all ${paymentMethod === 'AIRTEL_MONEY'
                    ? 'bg-red-600 text-white ring-2 sm:ring-4 ring-red-300 shadow-lg transform scale-105'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200 border-2 border-gray-300'
                    }`}
                >
                  <span className="hidden sm:inline">📱 </span>Airtel Money
                </button>
              </div>
              {/* Deposit Payment Option - Shows when customer is selected */}
              {selectedCustomer && (
                <div className="mt-3">
                  <button
                    onClick={() => customerDepositBalance > 0 && setPaymentMethod('DEPOSIT')}
                    disabled={customerDepositBalance <= 0 || isLoadingDeposits}
                    className={`w-full py-3 sm:py-4 px-3 sm:px-4 rounded-lg font-semibold text-sm sm:text-base transition-all ${customerDepositBalance <= 0 || isLoadingDeposits
                      ? 'bg-gray-100 text-gray-400 border-2 border-gray-200 cursor-not-allowed'
                      : paymentMethod === 'DEPOSIT'
                        ? 'bg-amber-600 text-white ring-2 sm:ring-4 ring-amber-300 shadow-lg transform scale-105'
                        : 'bg-amber-50 text-amber-800 hover:bg-amber-100 border-2 border-amber-400'
                      }`}
                  >
                    <span className="flex items-center justify-center gap-2">
                      <span>🏦 Use Customer Deposit</span>
                      {isLoadingDeposits ? (
                        <span className="px-2 py-1 bg-gray-200 text-gray-600 rounded-md text-sm">
                          Loading...
                        </span>
                      ) : customerDepositBalance > 0 ? (
                        <span className="px-2 py-1 bg-amber-200 text-amber-900 rounded-md text-sm font-bold">
                          Available: {formatCurrency(customerDepositBalance)}
                        </span>
                      ) : (
                        <span className="px-2 py-1 bg-gray-200 text-gray-600 rounded-md text-sm">
                          No deposits
                        </span>
                      )}
                    </span>
                  </button>
                </div>
              )}
              {/* Info message when customer is selected */}
              {selectedCustomer && (
                <div className="mt-3 p-3 bg-blue-50 border border-blue-200 rounded-lg">
                  <p className="text-xs sm:text-sm text-blue-800">
                    <span className="font-semibold">ℹ️ Customer Selected:</span> Any unpaid balance
                    will automatically be added to {selectedCustomer.name}'s invoice.
                  </p>
                </div>
              )}
            </div>
            {/* Quick Denomination Buttons (when no payments yet) */}
            {paymentLines.length === 0 && paymentMethod === 'CASH' && (
              <div className="mb-6 bg-gradient-to-br from-green-50 to-emerald-50 border-2 border-green-300 rounded-xl p-4">
                <label className="block text-base font-bold text-green-900 mb-3 flex items-center gap-2">
                  ⚡ Quick Pay (One-Click)
                </label>
                <div className="grid grid-cols-3 gap-3 mb-3">
                  <button
                    onClick={() => {
                      setPaymentAmount(grandTotal.toFixed(2));
                      setTimeout(() => {
                        const newLine = {
                          id: `payment_${Date.now()}_${Math.random()}`,
                          paymentMethodId: 'CASH',
                          paymentMethod: 'CASH' as const,
                          amount: grandTotal,
                          reference: undefined,
                          createdAt: new Date().toISOString(),
                        };
                        setPaymentLines([newLine]);
                      }, 50);
                    }}
                    className="py-4 px-3 bg-gradient-to-br from-green-500 to-green-600 hover:from-green-600 hover:to-green-700 text-white rounded-lg font-bold text-base shadow-lg hover:shadow-xl transform hover:scale-105 transition-all"
                    title="Pay exact amount and complete"
                  >
                    ✓ Exact
                    <br />
                    <span className="text-sm font-normal">{formatCurrency(grandTotal)}</span>
                  </button>
                  {[1000, 2000, 5000, 10000, 20000, 50000, 100000]
                    .filter((amount) => amount >= grandTotal)
                    .slice(0, 5)
                    .map((amount) => (
                      <button
                        key={amount}
                        onClick={() => {
                          setPaymentAmount(amount.toString());
                          setTimeout(() => {
                            const newLine = {
                              id: `payment_${Date.now()}_${Math.random()}`,
                              paymentMethodId: 'CASH',
                              paymentMethod: 'CASH' as const,
                              amount: amount,
                              reference: undefined,
                              createdAt: new Date().toISOString(),
                            };
                            setPaymentLines([newLine]);
                          }, 50);
                        }}
                        className="py-3 sm:py-4 px-2 sm:px-3 bg-gradient-to-br from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 text-white rounded-lg font-bold text-base sm:text-lg shadow-lg hover:shadow-xl transform hover:scale-105 transition-all"
                        title={`Pay ${formatCurrency(amount)} (change: ${formatCurrency(new Decimal(amount).minus(grandTotal).toNumber())})`}
                      >
                        <span className="block">
                          {amount >= 1000 ? `${(amount / 1000).toFixed(0)}k` : amount}
                        </span>
                        <span className="text-xs font-normal hidden sm:block">
                          -{formatCurrency(new Decimal(amount).minus(grandTotal).toNumber())}
                        </span>
                      </button>
                    ))}
                </div>
                <p className="text-xs text-green-800 text-center font-medium">
                  💡 Click to add payment instantly
                </p>
              </div>
            )}

            {/* Payment Amount Input */}
            <div className="mb-4 sm:mb-6">
              <label className="block text-sm sm:text-base font-semibold text-gray-800 mb-2">
                Payment Amount
              </label>
              <div className="flex gap-2 sm:gap-3">
                <NumericSoftKeyboardInput
                  mode="decimal"
                  value={paymentAmount}
                  onChange={setPaymentAmount}
                  onKeyDown={handlePaymentAmountKeyDown}
                  autoFocus
                  className="flex-1 px-3 sm:px-4 py-3 sm:py-4 border-2 border-gray-300 rounded-lg focus:ring-2 sm:focus:ring-4 focus:ring-blue-300 focus:border-blue-500 text-lg sm:text-xl font-bold text-gray-900"
                  placeholder="0.00"
                  aria-label="Payment amount"
                />
                <button
                  onClick={handleQuickFill}
                  className="px-4 sm:px-6 py-3 sm:py-4 bg-gradient-to-br from-indigo-500 to-indigo-600 hover:from-indigo-600 hover:to-indigo-700 text-white rounded-lg text-sm sm:text-base font-bold shadow-lg hover:shadow-xl transform hover:scale-105 transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none"
                  disabled={remainingBalance <= 0}
                  title="Fill exact remaining amount"
                >
                  Fill
                </button>
              </div>
              <div className="grid grid-cols-4 gap-1.5 sm:gap-2 mt-2 sm:mt-3">
                {[1000, 5000, 10000, 20000].map((amount) => (
                  <button
                    key={amount}
                    onClick={() => setPaymentAmount(amount.toString())}
                    className="py-1.5 sm:py-2 px-1.5 sm:px-2 bg-gray-100 hover:bg-gray-200 border border-gray-300 rounded text-xs sm:text-sm font-semibold text-gray-700"
                  >
                    +{amount >= 1000 ? `${(amount / 1000).toFixed(0)}k` : amount}
                  </button>
                ))}
              </div>
            </div>

            {/* Reference Input (for Card/Mobile Money) */}
            {(paymentMethod === 'CARD' || paymentMethod === 'MOBILE_MONEY' || paymentMethod === 'AIRTEL_MONEY') && (
              <div className="mb-3 sm:mb-4">
                <label className="block text-xs sm:text-sm font-medium text-gray-700 mb-1">
                  Reference Number <span className="text-gray-500">(Optional)</span>
                </label>
                <input
                  type="text"
                  value={paymentReference}
                  onChange={(e) => setPaymentReference(e.target.value)}
                  className="w-full px-3 py-2 sm:py-3 text-sm sm:text-base border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                  placeholder="Enter reference number (optional)"
                />
              </div>
            )}

            {/* Payment Lines List */}
            {paymentLines.length > 0 && (
              <div className="mb-3 sm:mb-4 border rounded-lg p-2 sm:p-3 bg-gray-50">
                <h4 className="text-xs sm:text-sm font-semibold text-gray-700 mb-1.5 sm:mb-2">
                  Payment Lines
                </h4>
                <div className="space-y-1.5 sm:space-y-2">
                  {paymentLines.map((line) => (
                    <div
                      key={line.id}
                      className="flex items-center justify-between bg-white p-1.5 sm:p-2 rounded border"
                    >
                      <div className="flex-1">
                        <div className="font-medium text-xs sm:text-sm">{line.paymentMethod}</div>
                        {line.reference && (
                          <div className="text-xs text-gray-500">Ref: {line.reference}</div>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 sm:gap-2">
                        <span className="font-semibold text-sm sm:text-base">
                          {formatCurrency(line.amount)}
                        </span>
                        <button
                          onClick={() => handleRemovePaymentLine(line.id)}
                          className="text-red-600 hover:text-red-800 font-bold px-1.5 sm:px-2 text-lg"
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

            {/* Running Totals - Large & Prominent */}
            <div className="mb-4 sm:mb-6 border-t-2 sm:border-t-4 border-gray-200 pt-3 sm:pt-4">
              <div className="space-y-2 sm:space-y-3">
                {cartDiscountAmount > 0 && (
                  <div className="flex justify-between items-center bg-green-50 p-2 sm:p-3 rounded-lg">
                    <span className="font-semibold text-sm sm:text-lg text-green-700">
                      Discount:
                    </span>
                    <span className="font-bold text-lg sm:text-2xl text-green-600">
                      -{formatCurrency(cartDiscountAmount)}
                    </span>
                  </div>
                )}
                <div className="flex justify-between items-center bg-gray-100 p-2 sm:p-3 rounded-lg">
                  <span className="font-semibold text-sm sm:text-lg text-gray-700">
                    Sale Total:
                  </span>
                  <span className="font-bold text-lg sm:text-2xl text-gray-900">
                    {formatCurrency(grandTotal)}
                  </span>
                </div>
                {paymentLines.length > 0 && (
                  <div className="flex justify-between items-center bg-green-50 p-2 sm:p-3 rounded-lg">
                    <span className="font-semibold text-sm sm:text-lg text-green-700">Paid:</span>
                    <span className="font-bold text-lg sm:text-2xl text-green-600">
                      {formatCurrency(totalPaid)}
                    </span>
                  </div>
                )}
                {remainingBalance > 0.01 ? (
                  <div className="flex justify-between items-center bg-red-50 p-3 sm:p-4 rounded-lg border-2 border-red-300">
                    <span className="font-bold text-base sm:text-xl text-red-700">
                      <span className="hidden sm:inline">⚠️ </span>Remaining:
                    </span>
                    <span className="font-bold text-2xl sm:text-3xl text-red-600">
                      {formatCurrency(remainingBalance)}
                    </span>
                  </div>
                ) : remainingBalance < -0.01 ? (
                  <div className="flex justify-between items-center bg-blue-50 p-3 sm:p-4 rounded-lg border-2 border-blue-300 animate-pulse">
                    <span className="font-bold text-base sm:text-xl text-blue-700">
                      <span className="hidden sm:inline">💰 </span>Change Due:
                    </span>
                    <span className="font-bold text-2xl sm:text-3xl text-blue-600">
                      {formatCurrency(changeAmount)}
                    </span>
                  </div>
                ) : (
                  <div className="flex justify-between items-center bg-green-50 p-3 sm:p-4 rounded-lg border-2 border-green-300">
                    <span className="font-bold text-base sm:text-xl text-green-700">
                      <span className="hidden sm:inline">✓ </span>Status:
                    </span>
                    <span className="font-bold text-lg sm:text-2xl text-green-600">
                      Exact Payment
                    </span>
                  </div>
                )}
              </div>
            </div>

            {/* Invoice Creation Indicator - Show when customer selected and has remaining balance */}
            {selectedCustomer && remainingBalance > 0.01 && (
              <div className="mb-4 sm:mb-6 bg-gradient-to-r from-orange-50 to-yellow-50 border-2 border-orange-300 rounded-lg p-3 sm:p-4 shadow-md">
                <div className="flex items-start gap-2 sm:gap-3">
                  <div className="text-2xl sm:text-3xl">📋</div>
                  <div className="flex-1">
                    <h3 className="font-bold text-sm sm:text-base text-orange-900 mb-1">
                      Invoice Will Be Created
                    </h3>
                    <p className="text-xs sm:text-sm text-orange-800 mb-2">
                      <span className="font-semibold">{selectedCustomer.name}</span> will be
                      invoiced for the unpaid balance:
                    </p>
                    <div className="bg-white rounded-lg p-2 sm:p-3 border border-orange-200">
                      <div className="flex justify-between items-center">
                        <span className="text-xs sm:text-sm font-medium text-gray-700">
                          Credit Amount:
                        </span>
                        <span className="text-lg sm:text-xl font-bold text-orange-600">
                          {formatCurrency(remainingBalance)}
                        </span>
                      </div>
                      <div className="text-xs text-gray-600 mt-1">
                        Due in 30 days • Customer can pay later
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {paymentMethod === 'CREDIT' && selectedCustomer && (
              <div className="mb-3 sm:mb-4 bg-blue-50 border border-blue-200 rounded p-2 sm:p-3">
                <label className="flex items-center gap-2 text-xs sm:text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={autoCreateInvoice}
                    onChange={(e) => setAutoCreateInvoice(e.target.checked)}
                    className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-2 focus:ring-blue-500"
                  />
                  <span className="font-medium text-gray-700">
                    Auto-create invoice for this credit sale
                  </span>
                </label>
                <p className="text-xs text-gray-600 mt-1 ml-5 sm:ml-6">
                  Invoice will be created automatically after sale completes
                </p>
              </div>
            )}

            {/* Backdated Sale Option */}
            <div className="mb-3 sm:mb-4 border-t pt-3 sm:pt-4">
              <label className="flex items-center gap-2 text-xs sm:text-sm cursor-pointer mb-1.5 sm:mb-2">
                <input
                  type="checkbox"
                  checked={showDatePicker}
                  onChange={(e) => {
                    setShowDatePicker(e.target.checked);
                    if (!e.target.checked) setSaleDate(''); // Clear date when unchecked
                  }}
                  className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-2 focus:ring-blue-500"
                />
                <span className="font-medium text-gray-700">Backdate this sale</span>
              </label>
              {showDatePicker && (
                <div>
                  <label className="block text-xs sm:text-sm font-medium text-gray-700 mb-1">
                    Sale Date
                  </label>
                  <DatePicker
                    value={saleDate}
                    onChange={setSaleDate}
                    maxDate={new Date()}
                    placeholder="Sale date"
                    aria-label="Sale date"
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    {saleDate
                      ? `Sale will be recorded as: ${saleDate}`
                      : 'Leave empty for current date/time'}
                  </p>
                </div>
              )}
            </div>

            <div className="flex gap-2">
              <POSButton
                variant="secondary"
                onClick={() => {
                  setShowPaymentModal(false);
                  setSaleDate('');
                  setShowDatePicker(false);
                  setPaymentLines([]);
                  setPaymentAmount('');
                  setPaymentReference('');
                }}
                className="flex-1 text-sm sm:text-base py-3 sm:py-4"
              >
                Cancel
              </POSButton>

              {/* Dynamic Action Button: Add Payment or Complete Sale */}
              {remainingBalance > 0.01 ? (
                // When user has entered an amount, ALWAYS show "Add Payment" button
                // This fixes the bug where deposit/card/mobile payments couldn't be added
                // when a customer was selected (the button showed disabled "Complete & Invoice" instead)
                paymentAmount && parseFloat(paymentAmount) > 0 ? (
                  <POSButton
                    variant="primary"
                    onClick={handleAddPayment}
                    disabled={!paymentAmount || parseFloat(paymentAmount) <= 0}
                    className="flex-1 text-sm sm:text-base py-3 sm:py-4"
                    title="Add payment to reduce remaining balance (or press Enter)"
                  >
                    <span className="block sm:hidden">
                      Add {formatCurrency(parseFloat(paymentAmount) || 0)}
                    </span>
                    <span className="hidden sm:block">
                      Add Payment ({formatCurrency(remainingBalance)} remaining)
                    </span>
                  </POSButton>
                ) : selectedCustomer ? (
                  // No amount entered, customer selected — show "Complete Sale & Create Invoice"
                  // This allows completing a sale with remaining balance as credit/invoice
                  <POSButton
                    variant="primary"
                    onClick={() => {
                      console.log('🟢 Complete Sale with Invoice clicked');
                      console.log('Will auto-create credit for:', formatCurrency(remainingBalance));
                      handleFinalizeSale();
                    }}
                    disabled={!canCompleteSale || isProcessingSale || createSale.isPending}
                    className="flex-1 text-sm sm:text-base py-3 sm:py-4 bg-gradient-to-r from-orange-500 to-orange-600 hover:from-orange-600 hover:to-orange-700"
                    title={`Complete sale and create invoice for ${formatCurrency(remainingBalance)} (or press Enter)`}
                  >
                    {isProcessingSale || createSale.isPending ? (
                      'Processing...'
                    ) : (
                      <>
                        <span className="block sm:hidden">Complete & Invoice</span>
                        <span className="hidden sm:block">
                          Complete Sale & Create Invoice ({formatCurrency(remainingBalance)})
                        </span>
                      </>
                    )}
                  </POSButton>
                ) : (
                  // No amount entered, no customer — show disabled "Add Payment"
                  <POSButton
                    variant="primary"
                    onClick={handleAddPayment}
                    disabled={!paymentAmount || parseFloat(paymentAmount) <= 0}
                    className="flex-1 text-sm sm:text-base py-3 sm:py-4"
                    title="Enter a payment amount first"
                  >
                    <span className="block sm:hidden">Add Payment</span>
                    <span className="hidden sm:block">
                      Add Payment ({formatCurrency(remainingBalance)} remaining)
                    </span>
                  </POSButton>
                )
              ) : (
                <POSButton
                  variant="primary"
                  onClick={() => {
                    console.log('🟢 Complete Sale clicked');
                    console.log('canCompleteSale:', canCompleteSale);
                    console.log('paymentLines:', paymentLines);
                    console.log('selectedCustomer:', selectedCustomer?.name);
                    console.log('remainingBalance:', remainingBalance);
                    console.log('isProcessingSale:', isProcessingSale);
                    console.log('createSale.isPending:', createSale.isPending);
                    handleFinalizeSale();
                  }}
                  disabled={!canCompleteSale || isProcessingSale || createSale.isPending}
                  className="flex-1 text-sm sm:text-base py-3 sm:py-4"
                  title={
                    !canCompleteSale
                      ? 'Add at least one payment to complete sale'
                      : isProcessingSale || createSale.isPending
                        ? 'Processing...'
                        : 'Complete sale (press Enter)'
                  }
                >
                  {isProcessingSale || createSale.isPending ? (
                    'Processing...'
                  ) : (
                    <>
                      <span className="block sm:hidden">Complete ✓</span>
                      <span className="hidden sm:block">Complete Sale ✓</span>
                    </>
                  )}
                </POSButton>
              )}
            </div>
          </div>
        </POSModal>
      )}

      {/* UoM Selection Modal */}
      {showUomModal && uomModalItemIndex >= 0 && items[uomModalItemIndex] && (
        <POSModal
          open={showUomModal}
          onOpenChange={(open) => {
            setShowUomModal(open);
            if (!open) {
              setUomModalItemIndex(-1);
              setSelectedUomIndex(0);
              // Restore focus to cart row
              setTimeout(() => {
                if (focusedCartIndex >= 0) {
                  const row = cartRowRefs.current[focusedCartIndex];
                  if (row) {
                    const firstInput = row.querySelector('input, select') as HTMLElement;
                    if (firstInput) firstInput.focus();
                  }
                }
              }, 100);
            }
          }}
          title="Select Unit of Measure"
          description={`Choose the unit of measure for ${items[uomModalItemIndex].name}`}
          ariaLabel="Select Unit of Measure"
        >
          <div>
            <div className="mb-3 font-semibold text-lg text-gray-900">
              {items[uomModalItemIndex].name}
            </div>
            <div className="mb-4">
              <div className="font-medium text-gray-700 mb-2">Available Units:</div>
              <div className="flex flex-col gap-2">
                {items[uomModalItemIndex].availableUoms?.map((uom, idx) => (
                  <POSButton
                    key={uom.uomId}
                    ref={(el) => {
                      uomButtonRefs.current[idx] = el;
                    }}
                    variant={
                      uom.uomId === items[uomModalItemIndex].selectedUomId ? 'primary' : 'secondary'
                    }
                    onClick={() => {
                      handleUomChange(uomModalItemIndex, uom.uomId);
                    }}
                    onFocus={() => setSelectedUomIndex(idx)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleUomChange(uomModalItemIndex, uom.uomId);
                      }
                    }}
                    className={`w-full justify-between transition-all ${idx === selectedUomIndex ? 'ring-4 ring-blue-400 scale-105' : ''
                      }`}
                    aria-label={`Select ${uom.symbol || uom.name} at ${formatCurrency(uom.price)}`}
                    tabIndex={0}
                    autoFocus={idx === 0}
                  >
                    <span className="font-semibold">{uom.symbol || uom.name}</span>
                    <span className="text-xs text-gray-500">
                      {getStockInSellingUom(
                        items[uomModalItemIndex].stockOnHand ?? 0,
                        uom.conversionFactor,
                      )}{' '}
                      avail.
                    </span>
                    <span className="font-bold">{formatCurrency(uom.price)}</span>
                  </POSButton>
                ))}
              </div>
            </div>
            <div className="text-xs text-gray-500 mt-2 bg-blue-50 p-2 rounded">
              <strong>Keyboard:</strong> Tab to navigate • Enter to select • Esc to cancel
            </div>
          </div>
        </POSModal>
      )}

      {/* Discount Dialog */}
      <DiscountDialog
        isOpen={showDiscountDialog}
        onClose={() => {
          setShowDiscountDialog(false);
          setDiscountTarget(null);
        }}
        onApply={handleApplyDiscount}
        originalAmount={
          discountTarget?.type === 'cart'
            ? subtotal
            : discountTarget?.itemIndex !== undefined
              ? items[discountTarget.itemIndex]?.subtotal || 0
              : 0
        }
        lineItemIndex={discountTarget?.itemIndex}
        maxDiscountPercent={discountLimitPercent}
      />

      <TaxOverrideDialog
        isOpen={showTaxOverrideDialog}
        onClose={() => setShowTaxOverrideDialog(false)}
        onApply={(ov) => setTaxOverride(ov)}
        currentTax={tax}
        defaultRate={taxSnapshot?.defaultTaxRate || 18}
      />

      {/* Manager Approval Dialog */}
      <ManagerApprovalDialog
        isOpen={showManagerApprovalDialog}
        onClose={() => {
          setShowManagerApprovalDialog(false);
          setPendingDiscount(null);
        }}
        onApprove={handleManagerApproval}
        discountAmount={pendingDiscount?.amount || 0}
        discountPercentage={pendingDiscount?.discountPercentage || 0}
        reason={pendingDiscount?.reason || ''}
      />

      {/* Below-Cost Sale BLOCK Dialog — no override allowed */}
      {showBelowCostOverrideDialog && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="below-cost-dialog-title"
          aria-describedby="below-cost-dialog-desc"
        >
          <div className="bg-white rounded-xl shadow-2xl p-6 w-full max-w-md mx-4">
            <div className="flex items-center gap-3 mb-3">
              <span className="text-3xl" aria-hidden="true">🚫</span>
              <h2 id="below-cost-dialog-title" className="text-xl font-bold text-red-700">
                Sale Blocked — Items Below Cost
              </h2>
            </div>
            <p id="below-cost-dialog-desc" className="text-sm text-gray-700 mb-3">
              The following item{belowCostItems.length > 1 ? 's are' : ' is'} priced{' '}
              <strong className="text-red-700">below catalog / inventory cost</strong> (unit price
              and/or discount). This sale is <strong>blocked with no override</strong>. Edit the{' '}
              <strong>Unit Price</strong> column to at least the cost shown (per selected UoM),
              reduce discounts, or remove the line.
            </p>
            <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-4 space-y-2 max-h-48 overflow-y-auto">
              {belowCostItems.map((item, i) => (
                <div key={i} className="text-xs">
                  <div className="font-semibold text-gray-900 truncate">{item.name}</div>
                  <div className="flex justify-between mt-0.5">
                    <span className="text-red-700">
                      Selling price: <strong>{formatCurrency(item.unitPrice)}</strong>
                    </span>
                    <span className="text-gray-600">
                      Cost price: <strong>{formatCurrency(item.costPrice)}</strong>
                    </span>
                  </div>
                  <div className="text-red-600 font-medium">
                    Loss per unit: {formatCurrency(item.costPrice - item.unitPrice)}
                  </div>
                </div>
              ))}
            </div>
            <div className="bg-amber-50 border border-amber-300 rounded-lg p-3 text-xs text-amber-800 mb-4">
              <strong>Action required:</strong> Go back and correct the selling price of each
              blocked item to at least its cost price, or remove those items from the cart.
            </div>
            <div className="flex gap-3">
              <button
                autoFocus
                onClick={() => {
                  setShowBelowCostOverrideDialog(false);
                  setBelowCostItems([]);
                }}
                className="flex-1 py-2.5 rounded-lg border border-gray-300 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
              >
                Go Back &amp; Fix Prices
              </button>
              <button
                onClick={handleRemoveBelowCostItems}
                className="flex-1 py-2.5 rounded-lg bg-red-600 text-white text-sm font-bold hover:bg-red-700 transition-colors"
              >
                Remove Blocked Items
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Hold Cart Dialog - Removed: Now instant one-click action */}

      {/* Resume Hold Dialog */}
      <ResumeHoldDialog
        isOpen={showResumeDialog}
        onClose={() => setShowResumeDialog(false)}
        onResume={handleResumeHold}
      />

      {/* Save as Quote Dialog */}
      {showSaveQuoteDialog && (
        <POSModal
          open={showSaveQuoteDialog}
          onOpenChange={(open) => {
            setShowSaveQuoteDialog(open);
            if (!open) {
              setQuoteCustomerName('');
              setQuoteCustomerPhone('');
              setQuoteNotes('');
              setQuoteValidityDays(30);
            }
          }}
          title="Save as Quotation"
          description="Save current cart as a quotation for later"
          ariaLabel="Save as Quotation Dialog"
        >
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Customer Name {!selectedCustomer && <span className="text-red-500">*</span>}
              </label>
              <input
                type="text"
                value={quoteCustomerName}
                onChange={(e) => setQuoteCustomerName(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                placeholder="Enter customer name"
                disabled={!!selectedCustomer}
                autoFocus
              />
              {selectedCustomer && (
                <p className="text-xs text-blue-600 mt-1">
                  Using selected customer: {selectedCustomer.name}
                </p>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Customer Phone</label>
              <input
                type="tel"
                value={quoteCustomerPhone}
                onChange={(e) => setQuoteCustomerPhone(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                placeholder="0700000000"
                disabled={!!selectedCustomer}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Validity (Days)
              </label>
              <NumericSoftKeyboardInput
                mode="integer"
                value={String(quoteValidityDays)}
                onChange={(raw) => setQuoteValidityDays(parseInt(raw, 10) || 30)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                min={1}
                max={365}
                aria-label="Quote validity in days"
              />
              <p className="text-xs text-gray-500 mt-1">
                Quote will be valid for {quoteValidityDays} days (until{' '}
                {new Date(
                  Date.now() + quoteValidityDays * 24 * 60 * 60 * 1000
                ).toLocaleDateString()}
                )
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Notes (Optional)
              </label>
              <textarea
                value={quoteNotes}
                onChange={(e) => setQuoteNotes(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                rows={3}
                placeholder="Add any notes or special conditions..."
              />
            </div>

            <div className="bg-gray-50 p-3 rounded-lg">
              <p className="text-sm text-gray-700 mb-1">
                <span className="font-semibold">Items:</span> {items.length}
              </p>
              <p className="text-lg font-bold text-gray-900">Total: {formatCurrency(grandTotal)}</p>
            </div>

            <div className="flex gap-3">
              <POSButton
                variant="secondary"
                onClick={() => {
                  setShowSaveQuoteDialog(false);
                  setQuoteCustomerName('');
                  setQuoteCustomerPhone('');
                  setQuoteNotes('');
                  setQuoteValidityDays(30);
                }}
                disabled={isSavingQuote}
                className="flex-1"
              >
                Cancel
              </POSButton>
              <POSButton
                variant="primary"
                onClick={handleSaveAsQuote}
                disabled={isSavingQuote || (!selectedCustomer && !quoteCustomerName.trim())}
                className="flex-1"
              >
                {isSavingQuote ? 'Saving...' : 'Save Quote'}
              </POSButton>
            </div>
          </div>
        </POSModal>
      )}

      {/* Load Quote Dialog */}
      {showLoadQuoteDialog && (
        <POSModal
          open={showLoadQuoteDialog}
          onOpenChange={setShowLoadQuoteDialog}
          title="Load Quotation to Cart"
          description="Select a quote to load items into your cart"
          ariaLabel="Load Quotation Dialog"
        >
          <div className="space-y-4">
            {/* Search Box */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Search Quotes</label>
              <SearchSoftKeyboardInput
                value={quoteSearchTerm}
                onChange={setQuoteSearchTerm}
                autoFocus
                className="w-full px-3 py-2 pr-11 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                placeholder="Search by quote number or customer name..."
                aria-label="Search quotes"
              />
            </div>

            {/* Quotes List */}
            <div className="max-h-96 overflow-y-auto border border-gray-200 rounded-lg">
              {isLoadingQuotes ? (
                <div className="p-8 text-center">
                  <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
                  <p className="text-gray-600 mt-2">Loading quotes...</p>
                </div>
              ) : availableQuotes.length === 0 ? (
                <div className="p-8 text-center">
                  <p className="text-gray-600">No quotes found</p>
                  <p className="text-sm text-gray-500 mt-1">
                    Create a quote first by adding items to cart and pressing Ctrl+Q
                  </p>
                </div>
              ) : (
                <div className="divide-y">
                  {availableQuotes
                    .filter(
                      (q) =>
                        !quoteSearchTerm ||
                        String(q.quoteNumber ?? '')
                          .toLowerCase()
                          .includes(quoteSearchTerm.toLowerCase()) ||
                        (q.customerName &&
                          String(q.customerName)
                            .toLowerCase()
                            .includes(quoteSearchTerm.toLowerCase()))
                    )
                    .map((quote: Quotation) => (
                      <button
                        key={quote.id}
                        onClick={() =>
                          handleLoadQuoteToCart({
                            quotation: quote,
                            items: (quote as Quotation & { items?: QuotationItem[] }).items || [],
                          })
                        }
                        className="w-full p-4 text-left hover:bg-gray-50 transition-colors"
                      >
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            <div className="flex items-center gap-2">
                              <p className="font-semibold text-blue-600">{quote.quoteNumber}</p>
                              <span
                                className={`px-2 py-0.5 rounded-full text-xs font-medium ${{
                                  gray: 'bg-gray-100 text-gray-800',
                                  blue: 'bg-blue-100 text-blue-800',
                                  green: 'bg-green-100 text-green-800',
                                  yellow: 'bg-yellow-100 text-yellow-800',
                                  red: 'bg-red-100 text-red-800',
                                  purple: 'bg-purple-100 text-purple-800',
                                }[getQuoteStatusBadge(quote.status).color]}`}
                              >
                                {getQuoteStatusBadge(quote.status).label}
                              </span>
                            </div>
                            <p className="text-gray-900 mt-1">
                              {quote.customerName || 'Walk-in Customer'}
                            </p>
                            <p className="text-sm text-gray-600 mt-1">
                              {formatTimestampDate(String(quote.createdAt))} · Valid until{' '}
                              {formatTimestampDate(String(quote.validUntil))}
                            </p>
                          </div>
                          <div className="text-right">
                            <p className="font-bold text-gray-900">
                              {formatCurrency(quote.totalAmount)}
                            </p>
                            <p className="text-xs text-gray-600 mt-1">
                              {(quote as Quotation & { items?: QuotationItem[] }).items?.length ||
                                0}{' '}
                              items
                            </p>
                          </div>
                        </div>
                      </button>
                    ))}
                </div>
              )}
            </div>

            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3">
              <p className="text-sm text-yellow-800">
                <span className="font-semibold">⚠️ Note:</span> Loading a quote will replace your
                current cart items.
              </p>
            </div>

            <div className="flex gap-3">
              <POSButton
                variant="secondary"
                onClick={() => setShowLoadQuoteDialog(false)}
                className="flex-1"
              >
                Cancel
              </POSButton>
            </div>
          </div>
        </POSModal>
      )}

      {/* Quote Success Dialog */}
      {showQuoteSuccessDialog && savedQuoteData && (
        <POSModal
          open={showQuoteSuccessDialog}
          onOpenChange={setShowQuoteSuccessDialog}
          title="✅ Quote Saved Successfully!"
          description="Your quotation has been created"
          ariaLabel="Quote Success Dialog"
        >
          <div className="space-y-4">
            <div className="bg-green-50 border border-green-200 rounded-lg p-4">
              <div className="text-center">
                <p className="text-2xl font-bold text-green-800 mb-2">
                  {savedQuoteData.quotation.quoteNumber}
                </p>
                <p className="text-sm text-gray-700 mb-1">
                  Customer: {savedQuoteData.quotation.customerName}
                </p>
                <p className="text-lg font-semibold text-gray-900">
                  {formatCurrency(savedQuoteData.quotation.totalAmount)}
                </p>
                <p className="text-xs text-gray-600 mt-2">
                  Valid until: {formatTimestampDate(savedQuoteData.quotation.validUntil)}
                </p>
              </div>
            </div>

            <div className="space-y-2">
              <p className="text-sm font-medium text-gray-700">What would you like to do?</p>

              <POSButton variant="primary" onClick={handleViewQuote} className="w-full">
                👁️ View Quote Details
              </POSButton>

              <POSButton variant="secondary" onClick={handleClearCartAfterQuote} className="w-full">
                🗑️ Clear Cart
              </POSButton>

              <POSButton variant="secondary" onClick={handleKeepWorking} className="w-full">
                ➡️ Keep Working with Current Cart
              </POSButton>
            </div>

            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
              <p className="text-xs text-blue-800">
                💡 <span className="font-semibold">Tip:</span> You can find all your quotes in the
                Quotations menu
              </p>
            </div>
          </div>
        </POSModal>
      )}

      {/* Keyboard shortcuts — wide screens only (1600px+) */}
      <footer className={`${POS_ADAPTIVE_CLASSES.keyboardFooter} flex-wrap px-4 xl:px-6 py-2 bg-gray-100 border-t text-xs text-gray-500 gap-x-4 gap-y-1 items-center`}>
        <span>/: Focus Search</span>
        <span>↑↓: Navigate</span>
        <span>→/Enter: Select/Add</span>
        <span>Ctrl+↑↓: Cart Navigation</span>
        <span>Ctrl+U: Change UoM</span>
        <span>Ctrl+D: Discount</span>
        <span>Ctrl+H: Hold/Resume</span>
        <span>Ctrl+Q: Quote (Save/Load)</span>
        <span>Ctrl+Shift+C: Clear All</span>
        <span>Del: Remove</span>
        <span>Esc: Close/Clear</span>
        <span>Shift+Enter: Payment</span>
        <span className="ml-auto flex items-center gap-1">
          <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></span>
          Barcode Scanner Ready
        </span>
      </footer>

      {/* Add Service Item Dialog */}
      <AddServiceItemDialog
        open={showServiceItemDialog}
        onOpenChange={setShowServiceItemDialog}
        onAdd={handleAddServiceItem}
      />

      {/* Open Register Dialog - shown when user tries to make sale without session */}
      <OpenRegisterDialog
        open={showOpenRegisterDialog}
        onOpenChange={setShowOpenRegisterDialog}
        onSuccess={() => {
          setShowOpenRegisterDialog(false);
          toast.success('Register session ready');
        }}
      />

      {/* Blocking overlay: missing session OR session could not be verified */}
      {sessionEnforced && !isLoadingSession && isOnline && (!hasOpenRegister || isSessionError) && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center backdrop-blur-sm">
          <div className="bg-white rounded-xl shadow-2xl p-8 max-w-md mx-4 text-center">
            <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-yellow-100 flex items-center justify-center">
              <svg
                className="w-8 h-8 text-yellow-600"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z"
                />
              </svg>
            </div>
            {isSessionError ? (
              <>
                <h2 className="text-xl font-bold text-gray-900 mb-2">Could not verify register session</h2>
                <p className="text-gray-600 mb-6">
                  Sales are blocked until the cash register session can be confirmed. The sale was not posted.
                </p>
                <button
                  onClick={() => { void refetchSession(); }}
                  className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 px-6 rounded-lg transition-colors"
                >
                  Retry
                </button>
              </>
            ) : (
              <>
                <h2 className="text-xl font-bold text-gray-900 mb-2">{sessionPolicyDef.cashierPromptTitle}</h2>
                <p className="text-gray-600 mb-6">
                  {sessionPolicyDef.cashierPromptBody}
                </p>
                <button
                  onClick={() => setShowOpenRegisterDialog(true)}
                  className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 px-6 rounded-lg transition-colors"
                >
                  {sessionPolicyDef.cashierPromptAction}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </PosWorkspaceSurface>
    </AdaptiveAppShell>
  );
}
