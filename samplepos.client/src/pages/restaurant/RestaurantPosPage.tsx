/**
 * SambaPOS-style Restaurant POS — tables → categories → products → order → KOT / Bill / Pay.
 * Payment reuses existing Order Payment page → createSale SSOT.
 */

import {
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, X } from 'lucide-react';
import { requestSoftKeyboard } from '../../lib/softKeyboard';
import { SearchSoftKeyboardInput } from '../../components/keyboard/SearchSoftKeyboardInput';
import Layout from '../../components/Layout';
import { AdaptiveDialog } from '../../components/adaptive';
import { api, getStructuredError } from '../../utils/api';
import { getStructuredErrorMessage, toastApiError } from '../../utils/errorHandler';
import { isBackendUnavailableError } from '../../lib/isBackendUnavailableError';
import { formatCurrency } from '../../utils/currency';
import {
  fetchRestaurantFohFlags,
  readCachedRestaurantAllowOversell,
  useRestaurantEnabled,
} from '../../hooks/useRestaurantEnabled';
import {
  restaurantFohStockWarnForLines,
  restaurantFohStockWarnMessage,
} from '@shared/restaurant/restaurantStockPolicy';
import { formatRestaurantMenuStockLabel } from '@shared/restaurant/restaurantKotStockPolicy';
import { useLayoutTier } from '../../hooks/useLayoutTier';
import {
  inlineRowEditorsOnSameLine,
  isAdaptiveDenseSurface,
  isAdaptiveUltraSurface,
  resolveNewTicketLabel,
  resolvePayButtonLabel,
  shouldShowCoach,
  showInlineRowEditors,
  showInlineTicketNote,
} from '../../lib/adaptiveChrome';
import {
  allocateVoidQuantity,
  isServerOrderItemId,
} from '../../lib/restaurantVoidQuantity';
import {
  fohMenuAddBlockedMessage,
  resolveFohMenuAddTarget,
  resolveKotFireOrderId,
  resolveKotSessionFinish,
  resolveKotSessionLeave,
  resolvePaintedOrder,
  resolveTableOpenLand,
  resolveTablePickView,
} from '../../lib/fohMenuAddTarget';
import { kotLineNotesMergeKey } from '@shared/utils/consolidateKotLines';
import { computeVoidItemsFromUpdatedLines } from '@shared/utils/reconcileOrderLineVoids';
import { printKitchenTicket, printRestaurantBill, resolveStationPrinterName } from '../../lib/printRestaurant';
import { kotPrintPartialSuccessMessage } from '../../lib/restaurantPrintPolicy';
import {
  dispatchPrintJobs,
  enqueueOfflinePrintJob,
  flushPendingPrintJobs,
  type ClientPrintJob,
} from '../../lib/printJobDispatcher';
import { printRestaurantSettlementReceipt } from '../../lib/restaurantSettlementReceipt';
import PrinterServiceStatusChip from '../../components/restaurant/PrinterServiceStatusChip';
import {
  readCachedGuestBillPrinter,
  writeCachedGuestBillPrinter,
} from '../../lib/guestBillPrinter';
import { brandingFromTenant, mergeDocumentCompanyBranding } from '../../lib/documentCompanyBranding';
import {
  fetchInvoiceSettingsForReceipt,
  invoiceSettingsToReceiptBranding,
} from '../../lib/receiptFromSale';
import { toast } from 'react-hot-toast';
import { useTenant } from '../../contexts/TenantContext';
import { useAuth } from '../../contexts/AuthContext';
import { useOfflineContext } from '../../contexts/OfflineContext';
import { useCanAccess } from '../../authorization/useAuthorization';
import {
  decideRestaurantFohAutoLogout,
  performRestaurantFohAutoLogout,
} from '../../utils/restaurantFohAutoLogout';
import { isRestaurantWaiterProfile } from '../../utils/restaurantWaiterLockdown';
import {
  canCancelRestaurantCheck,
  canEditOtherWaitersChecks,
  canVoidKitchenSentRestaurantItems,
  formatCheckOpenDuration,
  formatLineAddedClock,
  formatOrderedByLabels,
  RESTAURANT_CANCEL_CHECK_RESTRICTED_MESSAGE,
  RESTAURANT_VOID_SENT_RESTRICTED_MESSAGE,
  restaurantTicketLineMergeKey,
  shortWaiterLabel,
} from '@shared/utils/restaurantCheckOwnership';
import {
  getAllEvents,
  getAllSyncState,
  invalidateJournalMemoryCache,
} from '../../lib/offlineEventJournal';
import {
  deriveRestaurantCheckForTable,
  deriveRestaurantFloorOccupancy,
  deriveRestaurantOpenChecks,
  deriveRestaurantSiblingChecks,
  type DerivedOrder,
} from '../../lib/offlineEventSelectors';
import {
  appendRestaurantItemOffline,
  assignRestaurantWaiterOffline,
  cancelRestaurantCheckOffline,
  fireRestaurantKotOffline,
  markRestaurantCheckSettledInJournal,
  mergeRestaurantChecksOffline,
  payRestaurantCheckOffline,
  reconcileRestaurantJournalWithServerTables,
  removeRestaurantLinesOffline,
  refreshRestaurantCheckSeedFromServer,
  hasPendingRestaurantMutations,
  resolveDesiredLinesBeforePay,
  storePayDesiredLines,
  shouldUseLocalRestaurantMutation,
  isJournalLocalOrderId,
  splitRestaurantCheckOffline,
  transferRestaurantCheckOffline,
  updateRestaurantCheckNotesOffline,
  updateRestaurantGuestOffline,
  totalsFromLines,
} from '../../lib/restaurantOfflineOps';
import { hasPendingSales, syncOfflineSales } from '../../services/offlineSyncEngine';
import {
  appendOptimisticMenuItem,
  applyTicketNoteToCheck,
  applyTicketNoteToTabs,
  displayTicketNote,
  preferUserTicketNote,
  resolveTicketNoteOnCheckPaint,
  sanitizeCheckTicketNotes,
  dropOptimisticCheckLines,
  isTempRestaurantId,
  mergeInFlightOptimisticLines,
  mergeRestaurantSiblingTabs,
  newTempLineId,
  readRestaurantAddItemsPayload,
  restaurantCheckQueryPaintIds,
  coalesceRestaurantCheckFetch,
  scrubRestaurantTicketTabs,
  toServerRestaurantOrderId,
  type InFlightOptimisticLine,
  type OptimisticCheckPayload,
} from '../../lib/restaurantCheckOptimistic';
import {
  assertSplitMovePaintShowsMovedLines,
  buildPartyTabsAfterSplitMove,
  canMoveSelectedUnits,
  createSplitMovePartyPin,
  maxMoveUnitsForGroup,
  resolveActiveOrderIdAfterSplitMove,
  resolveSplitMovePartyPinAfterOpenIds,
  retainOpenTicketIdsWithPartyPin,
  type SplitMovePartyPin,
} from '../../lib/restaurantSplitMovePaint';
import { RestaurantOrderTagPad } from '../../components/restaurant/RestaurantOrderTagPad';
import type { OrderTagGroupOption } from '../../components/restaurant/RestaurantOrderTagPad';
import {
  formatOrderTagsAsLineNotes,
  type RestaurantOrderTagSelection,
} from '@shared/utils/restaurantOrderTags';
import {
  appendQtyDigit,
  clampOrderQty,
  parsePendingOrderQty,
} from '../../lib/restaurantPendingQty';
import { publishLanKdsBoardChanged, subscribeLanKds } from '../../lib/restaurantLanKds';
import CustomerSelector from '../../components/pos/CustomerSelector';
import type { Customer } from '@shared/zod/customer';
import {
  getCachedRestaurantTables,
  cacheRestaurantTables,
  getCachedRestaurantMenu,
  getCachedRestaurantCategories,
  getCachedRestaurantWaiters,
  cacheRestaurantMenu,
  refreshRestaurantOfflineCache,
  markRestaurantBillRequestedOffline,
  clearRestaurantBillRequestedOffline,
  getRestaurantBillRequestedOffline,
  isRestaurantOrderBillRequestedOffline,
  paintRestaurantTableFreeOffline,
} from '../../lib/restaurantOfflineCache';
import {
  buildRestaurantTablesQueryOptions,
  floorFiguresFromTicketTabs,
  patchTableRowFloorFigures,
  resolveDiningFloorEmptyState,
  restaurantTablesQueryKey,
  restaurantWaitersQueryKey,
  shouldPaintJournalOccupancyOnServerFree,
} from '../../lib/restaurantFloorSession';
import OfflineSyncStatusPanel from '../../components/offline/OfflineSyncStatusPanel';
import axios from 'axios';

interface RestaurantTable {
  id: string;
  code: string;
  name: string;
  zone: string;
  seats: number;
  status: 'FREE' | 'OCCUPIED' | 'BILLING';
  currentOrderId: string | null;
  orderNumber?: string | null;
  orderTotal?: string | null;
  guestName?: string | null;
  orderChannel?: string | null;
  waiterId?: string | null;
  waiterName?: string | null;
  /** Open check created_at — floor timer. */
  checkOpenedAt?: string | null;
  /** Open PENDING checks on table (party multi-ticket). */
  openCheckCount?: number;
  openChecksTotal?: string | null;
}

interface RestaurantWaiter {
  id: string;
  fullName: string;
  email: string;
  role: string;
}

/** Stable empty list — `data || []` was a new array every render while loading. */
const EMPTY_RESTAURANT_WAITERS: RestaurantWaiter[] = [];

interface MenuCategory {
  id: string;
  name: string;
  productCount: number;
}

interface MenuProduct {
  id: string;
  name: string;
  sellingPrice: string;
  categoryId: string | null;
  categoryName: string | null;
  kitchenStation: string | null;
  productType?: 'inventory' | 'consumable' | 'service' | string;
  /** Inventory/consumable remaining; null/omit for service. After KOT, already net of kitchen issue. */
  remainingQuantity?: number | null;
  /** Open PENDING kitchen-sent qty (Samba "ordered"). */
  orderedQuantity?: number | null;
}

interface OrderItem {
  id: string;
  productId: string | null;
  productName: string;
  quantity: string;
  unitPrice: string;
  lineTotal: string;
  discountAmount: string;
  kitchenSentAt?: string | null;
  lineNotes?: string | null;
  /** Who rang this line (may differ from check owner). */
  addedBy?: string | null;
  addedByName?: string | null;
  /** When this line was rung. */
  addedAt?: string | null;
  orderTags?: Array<{
    id?: string | null;
    label: string;
    prefix?: string | null;
    price?: number;
  }> | null;
}

/** Toast/Samba-style: identical lines collapse to one row on the ticket. */
interface TicketLineGroup {
  key: string;
  productId: string | null;
  productName: string;
  unitPrice: number;
  quantity: number;
  lineTotal: number;
  kitchenSent: boolean;
  lineNotes: string | null;
  /** Login user(s) who rang units on this row — not masked by check owner. */
  orderedByLabel: string | null;
  /** Clock time when first unit on this row was rung. */
  addedAtLabel: string | null;
  itemIds: string[];
  lines: OrderItem[];
}

function consolidateTicketLines(
  items: OrderItem[],
  fallbackWaiterName?: string | null,
): TicketLineGroup[] {
  const map = new Map<string, TicketLineGroup>();
  for (const it of items) {
    const kitchenSent = !!it.kitchenSentAt;
    const unitPrice = Number(it.unitPrice) || 0;
    const notes = (it.lineNotes || '').trim();
    // Same product merges regardless of who added — attribution lists all rangers on the row.
    const key = restaurantTicketLineMergeKey({
      productId: it.productId,
      productName: it.productName,
      unitPrice,
      kitchenSent,
      lineNotes: notes,
      notesMergeKey: kotLineNotesMergeKey,
    });
    const qty = Number(it.quantity) || 0;
    const lineTotal = Number(it.lineTotal) || 0;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, {
        key,
        productId: it.productId,
        productName: it.productName,
        unitPrice,
        quantity: qty,
        lineTotal,
        kitchenSent,
        lineNotes: notes || null,
        // Use stamped names only; fallback only when every unit lacks a stamp (legacy).
        orderedByLabel: formatOrderedByLabels([it.addedByName], fallbackWaiterName),
        addedAtLabel: formatLineAddedClock(it.addedAt),
        itemIds: [it.id],
        lines: [it],
      });
    } else {
      existing.quantity += qty;
      existing.lineTotal += lineTotal;
      existing.itemIds.push(it.id);
      existing.lines.push(it);
      existing.orderedByLabel = formatOrderedByLabels(
        existing.lines.map((l) => l.addedByName),
        fallbackWaiterName,
      );
      const times = existing.lines
        .map((l) => (l.addedAt ? new Date(l.addedAt).getTime() : NaN))
        .filter((t) => Number.isFinite(t));
      const earliest = times.length ? Math.min(...times) : NaN;
      existing.addedAtLabel = Number.isFinite(earliest)
        ? formatLineAddedClock(new Date(earliest).toISOString())
        : existing.addedAtLabel;
    }
  }
  return Array.from(map.values());
}

interface OrderDetail {
  id: string;
  orderNumber: string;
  subtotal: string;
  discountAmount: string;
  taxAmount: string;
  totalAmount: string;
  status: string;
  items: OrderItem[];
  notes?: string | null;
  customerId?: string | null;
}

interface CheckMeta {
  tableCode: string | null;
  tableName: string | null;
  waiterId: string | null;
  waiterName: string | null;
  kitchenStatus: string;
  orderChannel: string;
  guestName?: string | null;
  guestPhone?: string | null;
  deliveryAddress?: string | null;
  pickupLabel?: string | null;
}

/** Touch-first POS controls — 44–48px targets, no 300ms delay, press feedback. */
const TOUCH =
  'touch-manipulation select-none [-webkit-tap-highlight-color:transparent] transition-[transform,background-color,border-color,box-shadow] duration-100 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40 disabled:active:scale-100';
const touchBtn = `${TOUCH} min-h-12 px-4 inline-flex items-center justify-center gap-1 rounded-xl type-cta font-semibold`;
const touchBtnGhost = `${touchBtn} border border-stone-300 bg-white text-stone-800 active:bg-stone-100`;
const touchBtnDark = `${touchBtn} bg-stone-900 text-white active:bg-stone-800`;
const touchBtnDanger = `${touchBtn} border border-red-300 text-red-700 bg-white active:bg-red-50`;
const touchChip = `${TOUCH} min-h-11 px-4 py-2.5 rounded-xl type-cta font-semibold whitespace-nowrap`;

function TicketNotePreview({
  note,
  dense,
  clamp,
  canOrder,
  onEdit,
  preview,
}: {
  note: string;
  dense: boolean;
  clamp: '1' | '2';
  canOrder: boolean;
  onEdit: () => void;
  preview: 'empty' | 'true';
}) {
  const text = (note || '').trim();
  return (
    <button
      type="button"
      onClick={onEdit}
      disabled={!canOrder}
      className={`w-full text-left rounded-lg border border-amber-200 bg-amber-50/90 leading-snug active:bg-amber-100 disabled:opacity-80 ${
        dense
          ? `px-2 py-1 text-[11px] ${clamp === '1' ? 'line-clamp-1' : 'line-clamp-2'}`
          : preview === 'empty'
            ? 'px-2.5 py-1.5 text-sm'
            : 'px-2.5 py-1.5 text-[11px]'
      }`}
      data-pos-coach={preview === 'true' ? 'ticket' : undefined}
      data-ticket-note-preview={preview}
      data-ticket-note-empty={text ? '0' : '1'}
      data-ticket-note-on-check="true"
      title="Ticket note — tap to edit"
    >
      <span className="font-bold text-amber-900">Note · </span>
      <span className={text ? 'text-stone-800' : 'text-stone-500'}>
        {text || 'Add note'}
      </span>
    </button>
  );
}
/** Thick Samba-style category targets — finger-friendly on phone + rail. */
const touchCat =
  `${TOUCH} min-h-14 px-5 rounded-xl type-title font-bold whitespace-nowrap shrink-0`;
const touchCatRail =
  `${TOUCH} min-h-16 w-full px-3 text-left type-title font-bold border-b border-stone-200 type-ellipsis`;
const touchField =
  'touch-manipulation min-h-12 w-full border border-stone-300 rounded-xl px-3 py-2.5 type-body bg-white';
const touchTile = `${TOUCH} active:brightness-[0.97]`;

function isServiceLaneCode(code: string | null | undefined): boolean {
  const c = (code || '').toUpperCase();
  return c === 'TA' || c === 'DL' || c === 'QK';
}

/** Virtual service lanes (TA/DL/QK) — not dining floor tables. */
function isServiceChannelTable(table: RestaurantTable | null | undefined): boolean {
  if (!table) return false;
  if (isServiceLaneCode(table.code)) return true;
  return (table.zone || '').toUpperCase() === 'SERVICE';
}

/** Must match server channelForTable — wrong channel blocks / mis-requires customer. */
function channelHint(table: RestaurantTable | null | undefined): 'TAKEAWAY' | 'DELIVERY' | 'DINE_IN' {
  if (!table) return 'DINE_IN';
  const code = table.code.toUpperCase();
  if (code === 'DL') return 'DELIVERY';
  if (code === 'TA') return 'TAKEAWAY';
  // QK is a service lane UI-wise but dine-in channel (walk-in, no guest required).
  if (code === 'QK') return 'DINE_IN';
  if (/delivery/i.test(table.name)) return 'DELIVERY';
  if (table.zone === 'SERVICE' && /take\s*away/i.test(table.name)) return 'TAKEAWAY';
  return 'DINE_IN';
}

/** SambaPOS numberpad qty before product tap — see restaurantPendingQty.ts */

type ServiceLaneKind = 'TAKEAWAY' | 'DELIVERY' | 'QUICK';

type QtyPadSheetState =
  | {
      purpose: 'set-line-qty';
      group: TicketLineGroup;
      digits: string;
    }
  | {
      purpose: 'void-qty';
      itemIds: string[];
      lines: OrderItem[];
      productName: string;
      kitchenSent: boolean;
      max: number;
      digits: string;
    }
  | {
      purpose: 'move-qty';
      itemIds: string[];
      lines: OrderItem[];
      productName: string;
      max: number;
      digits: string;
      sameTable: boolean;
      targetTableId?: string;
    };

type VoidReasonSheetState = {
  itemIds: string[];
  lines: OrderItem[];
  voidQuantity: number;
};

const KITCHEN_VOID_REASON_CHOICES = [
  'Customer changed mind',
  'Wrong item',
  '86 / unavailable',
  'Duplicate ring',
] as const;

const SERVICE_LANE_DEFS: Record<
  ServiceLaneKind,
  { code: string; name: string; zone: string; channel: 'TAKEAWAY' | 'DELIVERY' }
> = {
  TAKEAWAY: { code: 'TA', name: 'Takeaway', zone: 'SERVICE', channel: 'TAKEAWAY' },
  DELIVERY: { code: 'DL', name: 'Delivery', zone: 'SERVICE', channel: 'DELIVERY' },
  QUICK: { code: 'QK', name: 'Quick order', zone: 'SERVICE', channel: 'TAKEAWAY' },
};

/** Distinct colours per party-list row (Samba-style multi-ticket identity). */
const PARTY_TICKET_COLORS = [
  {
    idle: 'bg-sky-50 border-l-4 border-sky-500 text-sky-950',
    active: 'bg-sky-500 text-white border-l-4 border-sky-700 ring-2 ring-sky-300',
  },
  {
    idle: 'bg-violet-50 border-l-4 border-violet-500 text-violet-950',
    active: 'bg-violet-500 text-white border-l-4 border-violet-700 ring-2 ring-violet-300',
  },
  {
    idle: 'bg-amber-50 border-l-4 border-amber-500 text-amber-950',
    active: 'bg-amber-500 text-white border-l-4 border-amber-700 ring-2 ring-amber-300',
  },
  {
    idle: 'bg-emerald-50 border-l-4 border-emerald-500 text-emerald-950',
    active: 'bg-emerald-600 text-white border-l-4 border-emerald-800 ring-2 ring-emerald-300',
  },
  {
    idle: 'bg-rose-50 border-l-4 border-rose-500 text-rose-950',
    active: 'bg-rose-500 text-white border-l-4 border-rose-700 ring-2 ring-rose-300',
  },
  {
    idle: 'bg-teal-50 border-l-4 border-teal-500 text-teal-950',
    active: 'bg-teal-600 text-white border-l-4 border-teal-800 ring-2 ring-teal-300',
  },
  {
    idle: 'bg-orange-50 border-l-4 border-orange-500 text-orange-950',
    active: 'bg-orange-500 text-white border-l-4 border-orange-700 ring-2 ring-orange-300',
  },
  {
    idle: 'bg-indigo-50 border-l-4 border-indigo-500 text-indigo-950',
    active: 'bg-indigo-500 text-white border-l-4 border-indigo-700 ring-2 ring-indigo-300',
  },
] as const;

function partyTicketColor(index: number) {
  return PARTY_TICKET_COLORS[index % PARTY_TICKET_COLORS.length]!;
}

function apiErr(err: unknown, fallback: string): string {
  // Message-only — interceptor may already have toasted (HandledApiError).
  return getStructuredErrorMessage(err, fallback);
}

/** Closed/paid check still painted on FOH — retry add without orderId. */
function isRestaurantCheckClosedError(err: unknown): boolean {
  if (!axios.isAxiosError(err)) return false;
  const data = err.response?.data as { error?: string; error_code?: string; message?: string } | undefined;
  if (data?.error_code === 'ERR_RESTAURANT_CHECK_CLOSED') return true;
  const msg = (data?.error || data?.message || '').toLowerCase();
  return msg.includes('check is not open') || msg.includes('table check is not open');
}

/** Map journal-derived check → UI shape (offline + crash restore). */
function uiFromDerivedCheck(
  derived: DerivedOrder,
  table: RestaurantTable | { id: string },
): {
  table: RestaurantTable;
  order: OrderDetail;
  meta: CheckMeta;
  siblingChecks: [];
} {
  const totals = totalsFromLines(derived.lines);
  const tableId = (table as RestaurantTable).id;
  const billed = isRestaurantOrderBillRequestedOffline(tableId, derived.orderId);
  return {
    table: {
      ...(table as RestaurantTable),
      status: billed ? 'BILLING' : 'OCCUPIED',
      currentOrderId: derived.orderId,
      orderNumber: derived.offlineId,
      orderTotal: String(totals.totalAmount),
      waiterId: derived.waiterId,
      waiterName: derived.waiterName,
      guestName: derived.guestName,
      orderChannel: derived.channel,
    },
    order: {
      id: derived.orderId,
      orderNumber: derived.offlineId,
      subtotal: String(totals.subtotal),
      discountAmount: '0',
      taxAmount: String(totals.taxAmount),
      totalAmount: String(totals.totalAmount),
      status: 'PENDING',
      notes: derived.notes ?? null,
      items: derived.lines.map((l) => ({
        id: l.lineId || `${derived.orderId}-${l.productId}`,
        productId: l.productId,
        productName: l.productName,
        quantity: String(l.quantity),
        unitPrice: String(l.unitPrice),
        lineTotal: String(l.subtotal),
        discountAmount: String(l.discountAmount || 0),
        kitchenSentAt: l.kitchenSentAt,
        lineNotes: l.lineNotes ?? null,
        // Per-line stamp — never mask with check owner when the ranger is known.
        addedBy: l.addedBy ?? null,
        addedByName: l.addedByName ?? null,
        addedAt: l.addedAt ?? null,
      })),
    } as OrderDetail,
    meta: {
      tableCode: derived.tableCode || null,
      tableName: derived.tableName || null,
      waiterId: derived.waiterId || null,
      waiterName: derived.waiterName || null,
      kitchenStatus: derived.kotPrinted ? 'SENT' : 'NONE',
      orderChannel: derived.channel || 'DINE_IN',
      guestName: derived.guestName,
      guestPhone: derived.guestPhone,
      deliveryAddress: derived.deliveryAddress,
      pickupLabel: derived.pickupLabel,
    },
    siblingChecks: [],
  };
}

/**
 * Line badges are kitchen state — not bill state.
 * "New" was confusing next to "Billed" (guest check printed).
 * Billed + unsent → "On bill" (on guest check, not fired to kitchen).
 */
function ticketLineStatus(kitchenSent: boolean, checkBilled: boolean): {
  label: string;
  className: string;
} {
  if (kitchenSent) {
    return { label: 'KOT', className: 'text-emerald-700' };
  }
  if (checkBilled) {
    return { label: 'On bill', className: 'text-rose-800' };
  }
  return { label: 'Unsent', className: 'text-amber-700' };
}

type CheckUiPayload = {
  table: RestaurantTable;
  order: OrderDetail | null;
  meta: CheckMeta | null;
  siblingChecks: Array<{
    id: string;
    orderNumber: string;
    totalAmount: string;
    createdAt: string;
    notes?: string | null;
  }>;
  voids?: Array<{
    kotNumber: string;
    voidedByName: string | null;
    reason: string | null;
    firedAt: string;
    items: Array<{ productName: string; quantity: string }>;
  }>;
};

function buildCheckUiFromJournal(
  tableId: string,
  orderId: string | null | undefined,
  cachedTable: RestaurantTable | { id: string } | undefined,
): CheckUiPayload {
  const events = getAllEvents();
  const syncState = getAllSyncState();
  const derived = deriveRestaurantCheckForTable(tableId, events, syncState, orderId);
  const siblings = deriveRestaurantSiblingChecks(tableId, events, syncState, derived?.orderId);
  const table = (cachedTable || { id: tableId }) as RestaurantTable;
  if (!derived) {
    return { table, order: null, meta: null, siblingChecks: [] };
  }
  const base = uiFromDerivedCheck(derived, table);
  return sanitizeCheckTicketNotes({
    ...base,
    siblingChecks: siblings.map((s) => {
      const tot = totalsFromLines(s.lines);
      return {
        id: s.orderId,
        orderNumber: s.offlineId,
        totalAmount: String(tot.totalAmount),
        createdAt: new Date(s.createdTs).toISOString(),
        notes: s.notes ?? null,
      };
    }),
  });
}

type TicketTab = {
  id: string;
  orderNumber: string;
  totalAmount: string;
  /** User-facing ticket note (empty/hidden system notes stripped). */
  note?: string | null;
};

const SERVER_ORDER_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isServerOrderUuid(id: string | null | undefined): boolean {
  return !!id && SERVER_ORDER_UUID_RE.test(id);
}

/**
 * Open check ids eligible for the multi-ticket strip.
 * When the payload already has server UUID tickets, do NOT expand with every
 * journal UUID (ghost transfers / wrong-table seeds caused activate-check 400).
 * Journal-local ofl_* ids still expand for offline multi-ticket.
 */
function openTicketIdsForTable(
  tableId: string | null | undefined,
  data?: CheckUiPayload | null,
): Set<string> {
  const ids = new Set<string>();
  if (data?.order?.id) ids.add(data.order.id);
  for (const s of data?.siblingChecks || []) {
    if (s?.id) ids.add(s.id);
  }
  if (!tableId) return ids;

  const hasServerStrip = [...ids].some((id) => isServerOrderUuid(id));
  for (const c of deriveRestaurantOpenChecks(getAllEvents(), getAllSyncState())) {
    if (c.tableId !== tableId) continue;
    if (hasServerStrip) {
      // Online table session: only journal-local tabs may extend past server SSOT.
      if (isJournalLocalOrderId(c.orderId)) ids.add(c.orderId);
      continue;
    }
    ids.add(c.orderId);
  }
  return ids;
}

/** Tabs from a check payload only (order + siblings) — never reintroduce stale UUIDs. */
function ticketTabsFromPayload(data: CheckUiPayload | null | undefined): TicketTab[] {
  if (!data) return [];
  const tabs: TicketTab[] = [];
  const push = (id: string, orderNumber: string, totalAmount: string, note?: string | null) => {
    if (!id || isTempRestaurantId(id) || tabs.some((t) => t.id === id)) return;
    tabs.push({
      id,
      orderNumber,
      totalAmount: String(totalAmount ?? 0),
      note: preferUserTicketNote(note),
    });
  };
  if (data.order?.id) {
    push(
      data.order.id,
      data.order.orderNumber,
      data.order.totalAmount,
      data.order.notes,
    );
  }
  for (const s of data.siblingChecks || []) {
    if (s?.id) push(s.id, s.orderNumber, s.totalAmount, s.notes);
  }
  return scrubRestaurantTicketTabs(tabs);
}

/** Keep multi-ticket strip complete without resurrecting paid/cancelled checks. */
function attachSiblingTabs(
  data: CheckUiPayload,
  knownTabs: TicketTab[],
  tableId?: string | null,
  partyPin?: SplitMovePartyPin | null,
): CheckUiPayload {
  return mergeRestaurantSiblingTabs(
    data as OptimisticCheckPayload,
    knownTabs,
    retainOpenTicketIdsWithPartyPin(
      openTicketIdsForTable(tableId ?? data.table?.id, data),
      partyPin,
      tableId ?? data.table?.id,
    ),
  ) as CheckUiPayload;
}

function seedCheckPayloadIntoJournal(tableId: string, data: CheckUiPayload): void {
  const tableCode = data.meta?.tableCode || data.table?.code;
  const tableName = data.meta?.tableName || data.table?.name;
  const channel =
    (data.meta?.orderChannel as 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY' | null | undefined) || null;
  if (data.order?.id) {
    refreshRestaurantCheckSeedFromServer({
      orderId: data.order.id,
      orderNumber: data.order.orderNumber,
      tableId,
      tableCode,
      tableName,
      channel,
      waiterId: data.meta?.waiterId,
      waiterName: data.meta?.waiterName,
      guestName: data.meta?.guestName,
      guestPhone: data.meta?.guestPhone,
      deliveryAddress: data.meta?.deliveryAddress,
      pickupLabel: data.meta?.pickupLabel,
      items: data.order.items || [],
    });
  }
  for (const sibling of data.siblingChecks || []) {
    if (!sibling.id || sibling.id === data.order?.id) continue;
    // Never seed siblings with empty items — that ghosts an empty journal check
    // and can wipe a real ticket after Move/refetch races. Tabs use metadata only.
    const existing = deriveRestaurantCheckForTable(
      tableId,
      getAllEvents(),
      getAllSyncState(),
      sibling.id,
    );
    if (existing?.orderId === sibling.id) continue;
  }
}

/** Clamp server check UI to one ticket (void-safe journal when mutations pending).
 * Multi-ticket: never adopt another open check's lines when orderId is known.
 */
function checkUiAfterServerSeed(tableId: string, data: CheckUiPayload): CheckUiPayload {
  if (!data.order?.id) return sanitizeCheckTicketNotes(data);
  seedCheckPayloadIntoJournal(tableId, data);
  const local = buildCheckUiFromJournal(tableId, data.order.id, data.table);
  const siblings =
    data.siblingChecks?.length
      ? data.siblingChecks
      : local?.siblingChecks || data.siblingChecks || [];
  const withNotes = (payload: CheckUiPayload): CheckUiPayload =>
    applyTicketNoteToCheck(
      { ...payload, siblingChecks: siblings },
      data.order!.id,
      preferUserTicketNote(data.order?.notes, local?.order?.notes, payload.order?.notes),
    ) as CheckUiPayload;

  // No journal (or wrong id): server is the only SSOT for that check.
  if (!local?.order || local.order.id !== data.order.id) {
    return withNotes(data);
  }

  const byId = new Map((data.order.items || []).map((it) => [it.id, it] as const));
  // Pending voids/edits: journal items first so FOH never resurrects voided lines.
  if (hasPendingRestaurantMutations(data.order.id)) {
    const items = local.order.items.map((it) => {
      const server = byId.get(it.id);
      if (!server) return it;
      return {
        ...it,
        addedBy: server.addedBy ?? it.addedBy ?? null,
        addedByName: server.addedByName ?? it.addedByName ?? null,
        addedAt: server.addedAt ?? it.addedAt ?? null,
      };
    });
    return withNotes({
      ...local,
      order: { ...local.order, items },
      table: data.table || local.table,
    });
  }

  // Synced ticket: start from this check's server lines only + unsynced local adds.
  const journalById = new Map((local.order.items || []).map((it) => [it.id, it] as const));
  const itemsFromServer = (data.order.items || []).map((it) => {
    const j = journalById.get(it.id);
    if (!j) return it;
    const jQty = Number(j.quantity) || 0;
    const sQty = Number(it.quantity) || 0;
    // Prefer lower qty (partial void snap) without inventing foreign lines.
    const quantity = jQty > 0 && jQty < sQty - 1e-9 ? jQty : sQty;
    return {
      ...it,
      quantity: String(quantity),
      lineTotal: String(quantity * (Number(it.unitPrice) || 0)),
      kitchenSentAt: j.kitchenSentAt ?? it.kitchenSentAt,
      lineNotes: j.lineNotes ?? it.lineNotes,
      addedBy: it.addedBy ?? j.addedBy ?? null,
      addedByName: it.addedByName ?? j.addedByName ?? null,
      addedAt: it.addedAt ?? j.addedAt ?? null,
    };
  });
  const serverIds = new Set(itemsFromServer.map((it) => it.id));
  const pendingLocal = (local.order.items || []).filter(
    (it) =>
      !!it.id &&
      !serverIds.has(it.id) &&
      (String(it.id).startsWith('ofl_line_') || String(it.id).startsWith('tmp_line_')),
  );
  return withNotes({
    ...data,
    order: {
      ...data.order,
      items: [...itemsFromServer, ...pendingLocal],
    },
    table: data.table || local.table,
    meta: data.meta || local.meta,
  });
}

export default function RestaurantPosPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { config } = useTenant();
  /** Invoice Settings (DB) preferred — same company SSOT as POS receipts; tenant branding fallback. */
  const { data: invoiceBranding } = useQuery({
    queryKey: ['settings', 'invoice', 'restaurant-doc-branding'],
    queryFn: async () => {
      const settings = await fetchInvoiceSettingsForReceipt();
      return invoiceSettingsToReceiptBranding(settings);
    },
    staleTime: 60_000,
  });
  const companyBranding = useMemo(
    () =>
      mergeDocumentCompanyBranding(
        {
          companyName: invoiceBranding?.companyName,
          companyAddress: invoiceBranding?.companyAddress,
          companyPhone: invoiceBranding?.companyPhone,
          companyTin: invoiceBranding?.companyTin,
        },
        brandingFromTenant(config.branding),
      ),
    [invoiceBranding, config.branding],
  );
  /** Invoice footer / payment accounts / note — guest bills must match Receipt branding. */
  const guestBillInvoiceFields = useMemo(
    () => ({
      companyTin: companyBranding.companyTin || invoiceBranding?.companyTin || undefined,
      paymentAccounts: invoiceBranding?.paymentAccounts,
      customReceiptNote: invoiceBranding?.customReceiptNote || undefined,
      footerText: invoiceBranding?.footerText || undefined,
    }),
    [companyBranding.companyTin, invoiceBranding],
  );
  const guestBillDispatchBranding = useMemo(
    () => ({
      ...companyBranding,
      ...guestBillInvoiceFields,
    }),
    [companyBranding, guestBillInvoiceFields],
  );
  const taxName = config.tax?.name || 'VAT';
  const { user, permissions, rbacRoleNames, logout } = useAuth();
  const { isOnline } = useOfflineContext();
  const { tier, chrome, height, width, touchFirst, tokens } = useLayoutTier();
  // dense/ultra from SSOT (tier + height + touch) — Sunmi short landscape packs ultra.
  const { data: restaurantEnabled, isLoading: flagLoading } = useRestaurantEnabled();
  const fohFlagsQuery = useQuery({
    queryKey: ['restaurant', 'foh-flags', isOnline],
    queryFn: fetchRestaurantFohFlags,
    enabled: !!restaurantEnabled,
    staleTime: 30_000,
    initialData: {
      enabled: Boolean(restaurantEnabled),
      allowOversell: readCachedRestaurantAllowOversell(),
    },
  });
  const allowOversell = Boolean(fohFlagsQuery.data?.allowOversell);
  const canManage = useCanAccess(undefined, ['restaurant.manage']);
  /** Floor service (add/void/KOT/bill/transfer) — waiters/cashiers/managers with restaurant.order. */
  const canOrder = useCanAccess(undefined, ['restaurant.order']);
  const canReadFloor = useCanAccess(undefined, ['restaurant.read', 'restaurant.order', 'restaurant.manage']);
  /** Pay is cashier / accountant / admin only — waiters and managers order but do not settle. */
  const canRestaurantPay = useCanAccess(undefined, ['restaurant.pay']);
  /**
   * Service lanes (Takeaway / Delivery / Quick) — counter & manager only.
   * Floor waiters work dining tables and do not start TA/DL/QK orders.
   */
  const canAccessServiceLanes = canManage || canRestaurantPay;
  /** Cancel entire check — managers only (hidden from waiters and cashiers). */
  const canCancelCheck = canCancelRestaurantCheck({
    userId: user?.id || '',
    role: user?.role,
    permissions,
  });
  /** Kitchen-sent void — managers, cashiers, and accountants. Waiters remove unsent only. */
  const canVoidSent = canVoidKitchenSentRestaurantItems({
    userId: user?.id || '',
    role: user?.role,
    permissions,
  });
  /** Toast: Edit other employees' orders — managers/cashiers see every table. */
  const canEditOthers = canEditOtherWaitersChecks({
    userId: user?.id || '',
    role: user?.role,
    permissions,
    rbacRoleNames,
  });
  const isWaiterProfile = isRestaurantWaiterProfile({
    role: user?.role,
    permissions,
    restaurantEnabled: !!restaurantEnabled,
  });

  /** After KOT/bill print — rotate shared FOH terminal via hard redirect (no Router race). */
  const maybeAutoLogoutAfterPrint = (kind: 'kot' | 'bill'): boolean => {
    const did = performRestaurantFohAutoLogout(
      {
        kind,
        role: user?.role,
        permissions,
      },
      {
        logout,
        returnPath: '/restaurant',
      },
    );
    if (did) {
      toast.success(
        kind === 'kot'
          ? 'KOT done — sign in again for the next order'
          : 'Bill printed — sign in again for the next order',
        { id: 'restaurant-foh-auto-logout', duration: 2500 },
      );
    }
    return did;
  };
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null);
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  const [menuSearch, setMenuSearch] = useState('');
  const deferredMenuSearch = useDeferredValue(menuSearch);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [showAddTable, setShowAddTable] = useState(false);
  const [newTable, setNewTable] = useState({ code: '', name: '', zone: 'MAIN', seats: 4 });
  const [guestDraft, setGuestDraft] = useState({
    guestName: '',
    guestPhone: '',
    deliveryAddress: '',
    pickupLabel: '',
  });
  /** Customers SSOT — search/add only; guest fields come from the selected customer. */
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [selectedWaiterId, setSelectedWaiterId] = useState<string>('');
  /** Cashiers/accountants (restaurant.pay) see all tables by default; waiters start on My tables. */
  const [myTablesOnly, setMyTablesOnly] = useState(() => !canEditOthers);
  useEffect(() => {
    if (canEditOthers) setMyTablesOnly(false);
    else if (isWaiterProfile) setMyTablesOnly(true);
  }, [canEditOthers, isWaiterProfile]);
  /** Tick so open-table duration stays fresh (Toast table timer). */
  const [floorClockMs, setFloorClockMs] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setFloorClockMs(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  const [activeOrderId, setActiveOrderId] = useState<string | null>(null);
  /** Latest selected ticket id (stale-response guard while activateCheck in flight). */
  const activeOrderIdRef = useRef<string | null>(null);
  useEffect(() => {
    activeOrderIdRef.current = activeOrderId;
  }, [activeOrderId]);
  /**
   * Samba multi-ticket cart:
   * - list: ticket #s + totals in the order list (like Samba "D01" party screen)
   * - detail: one ticket's lines for ordering / KOT / bill
   */
  const [sambaTicketView, setSambaTicketView] = useState<'list' | 'detail'>('detail');
  const [selectedLineIds, setSelectedLineIds] = useState<string[]>([]);
  const [opsMode, setOpsMode] = useState<null | 'transfer' | 'merge'>(null);
  const [opsTargetTableId, setOpsTargetTableId] = useState('');
  const [opsSecondaryOrderId, setOpsSecondaryOrderId] = useState('');
  /**
   * Phones: menu is the only always-on view. Order / details / more open as
   * full-screen sheets when the user presses those buttons (not stacked).
   */
  const [mobileSheet, setMobileSheet] = useState<
    null | 'order' | 'details' | 'more' | 'note'
  >(null);
  /** Draft for ticket-level note dialog. */
  const [noteDraft, setNoteDraft] = useState('');
  const [noteSaving, setNoteSaving] = useState(false);
  /** Which ticket is mid-fetch after strip tap (UI spinner, never flash wrong order). */
  const [loadingTicketId, setLoadingTicketId] = useState<string | null>(null);
  /** Scroll target after ticket switch. */
  const ticketLinesRef = useRef<HTMLDivElement | null>(null);
  /** SambaPOS-style: ··· opens line actions (qty / void one line) */
  const [lineSheet, setLineSheet] = useState<TicketLineGroup | null>(null);
  const [tagPad, setTagPad] = useState<{
    orderId: string;
    itemId: string;
    productId: string;
    productName: string;
    groups: OrderTagGroupOption[];
    selected: RestaurantOrderTagSelection[];
    freeText: string;
  } | null>(null);
  const [tagPadBusy, setTagPadBusy] = useState(false);
  /** SambaPOS numberpad: type 50 then tap product once. Cleared after each add. */
  const [pendingQtyDigits, setPendingQtyDigits] = useState('');
  /** Phone: full dialer sheet for multi-digit qty (compact bar stays in the split). */
  const [menuQtyPadOpen, setMenuQtyPadOpen] = useState(false);
  /** Touch qty sheet — Set qty / void qty (never window.prompt). */
  const [qtyPadSheet, setQtyPadSheet] = useState<QtyPadSheetState | null>(null);
  const [voidReasonSheet, setVoidReasonSheet] = useState<VoidReasonSheetState | null>(null);
  const [voidReasonDraft, setVoidReasonDraft] = useState('');
  /** Survive selectedTableId effect when opening a service lane on phone. */
  const pendingMobileSheetRef = useRef<null | 'details'>(null);
  /** Bump to re-read journal-derived offline checks */
  const [journalTick, setJournalTick] = useState(0);
  const bumpJournal = () => setJournalTick((n) => n + 1);
  /** Last known multi-ticket strip for this table — survives switch loading gaps. */
  const tableTicketsRef = useRef<{ tableId: string | null; tabs: TicketTab[] }>({
    tableId: null,
    tabs: [],
  });
  /**
   * After Samba Move: retain source+split ids until server sibling list catches up.
   * Prevents intermittent strip scrub that made Move look broken the next day.
   */
  const splitMovePartyPinRef = useRef<SplitMovePartyPin | null>(null);
  /**
   * Party list auto-open is one-shot per table pick. Do not keep forcing `list`
   * while ticketTabs.length > 1 — that fights ticket drill-in and + Ticket.
   */
  const partyListLandedForTableRef = useRef<string | null>(null);
  /** Online add: keep temp lines until their mutation soft-refresh finishes. */
  const inFlightOptimisticLinesRef = useRef<Map<string, InFlightOptimisticLine>>(new Map());
  /** Increments on ticket paint so an older table GET cannot wipe a newer add. */
  const checkPaintGenRef = useRef(0);

  const paintServerCheckWithInFlight = (
    tableId: string,
    data: CheckUiPayload,
    preferredKeyOrderId?: string | null,
  ) => {
    // Clamp to journal (voids) first, then overlay in-flight optimistic adds.
    const clamped = checkUiAfterServerSeed(tableId, data);
    const merged = mergeInFlightOptimisticLines(
      clamped as OptimisticCheckPayload,
      inFlightOptimisticLinesRef.current.values(),
    ) as CheckUiPayload;
    // Drop optimistic tmp_ord_* ghosts before they reappear as fake sibling tickets.
    // After server SSOT, reset strip to order + siblings only (no stale UUID accumulation).
    // Thin payloads (openCheck without siblings) must NOT wipe an existing party strip.
    const fromServer = ticketTabsFromPayload(data);
    const prevTabs =
      tableTicketsRef.current.tableId === tableId ? tableTicketsRef.current.tabs : [];
    const serverHasParty =
      fromServer.length > 1 || (data.siblingChecks && data.siblingChecks.length > 0);
    tableTicketsRef.current = {
      tableId,
      tabs: fromServer.length
        ? scrubRestaurantTicketTabs(
            serverHasParty || fromServer.length >= prevTabs.length
              ? fromServer
              : [...prevTabs, ...fromServer],
          )
        : scrubRestaurantTicketTabs([
            ...prevTabs.filter((t) => t.id !== preferredKeyOrderId),
            ...(data.order
              ? [
                  {
                    id: data.order.id,
                    orderNumber: data.order.orderNumber,
                    totalAmount: data.order.totalAmount,
                  },
                ]
              : []),
            ...(data.siblingChecks || []).map((s) => ({
              id: s.id,
              orderNumber: s.orderNumber,
              totalAmount: s.totalAmount,
            })),
          ]),
    };
    const painted = attachSiblingTabs(merged, tableTicketsRef.current.tabs);
    const nextOrderId = data.order?.id ?? preferredKeyOrderId ?? null;
    checkPaintGenRef.current += 1;
    for (const id of restaurantCheckQueryPaintIds({
      paintedOrderId: nextOrderId,
      targetOrderId: preferredKeyOrderId,
      displayedOrderId: activeOrderId,
    })) {
      queryClient.setQueryData(['restaurant', 'check', tableId, id, isOnline], painted);
    }
    // Floor tile figures stay accurate without waiting for tables refetch.
    queryClient.setQueryData(
      restaurantTablesQueryKey(user?.id, isOnline),
      (prev: RestaurantTable[] | undefined) =>
        patchTableRowFloorFigures(
          prev,
          tableId,
          floorFiguresFromTicketTabs(tableTicketsRef.current.tabs),
        ),
    );
    return painted;
  };

  useEffect(() => {
    if (!restaurantEnabled || !isOnline) return;
    void refreshRestaurantOfflineCache(api.restaurant).catch((err: unknown) => {
      console.warn(
        '[RestaurantPOS] Offline cache warm failed',
        err instanceof Error ? err.message : err,
      );
    });
  }, [restaurantEnabled, isOnline]);

  // Retry undelivered jobs once per online session (not on every branding reload —
  // that re-fired flush and could re-paper after FOH re-login).
  const printFlushOnceRef = useRef(false);
  const companyBrandingRef = useRef(guestBillDispatchBranding);
  companyBrandingRef.current = guestBillDispatchBranding;
  useEffect(() => {
    if (!isOnline) {
      printFlushOnceRef.current = false;
      return;
    }
    if (!restaurantEnabled || printFlushOnceRef.current) return;
    printFlushOnceRef.current = true;
    void flushPendingPrintJobs({ branding: companyBrandingRef.current, online: true }).then((r) => {
      if (r.delivered > 0) {
        toast.success(`Printed ${r.delivered} queued ticket(s)`, {
          id: 'print-jobs-flush',
        });
      }
    });
  }, [restaurantEnabled, isOnline]);

  // Same-origin tabs (POS + KDS): refresh floor when journal changes elsewhere.
  useEffect(() => {
    if (!restaurantEnabled) return;
    return subscribeLanKds((msg) => {
      if (msg.type === 'JOURNAL_CHANGED' || msg.type === 'BOARD_CHANGED') {
        invalidateJournalMemoryCache();
        bumpJournal();
      }
    });
  }, [restaurantEnabled]);

  // Phase 5.3 — crash restore: only announce true local-only (ofl_ord_*) checks.
  useEffect(() => {
    if (!restaurantEnabled) return;
    const open = deriveRestaurantOpenChecks(getAllEvents(), getAllSyncState()).filter((c) =>
      isJournalLocalOrderId(c.orderId),
    );
    if (open.length > 0) {
      toast.success(`Restored ${open.length} open check(s) from local journal`, {
        id: 'restaurant-journal-restore',
      });
    }
  }, [restaurantEnabled]);

  const tablesQuery = useQuery(
    buildRestaurantTablesQueryOptions<RestaurantTable>({
      userId: user?.id,
      isOnline,
      enabled: !!restaurantEnabled && !!user?.id && canReadFloor,
      // silentForbidden: RBAC deny must not spam Access denied + look like logout
      fetchOnline: async () => {
        const res = await api.restaurant.listTables(undefined, { silentForbidden: true });
        return (res.data.data || []) as RestaurantTable[];
      },
      getCached: () => getCachedRestaurantTables() as RestaurantTable[],
      persistCache: (rows) => cacheRestaurantTables(rows),
      isBackendUnavailable: isBackendUnavailableError,
    }),
  );

  // Reconcile journal ghosts against live server floor (FREE tables must not look busy).
  useEffect(() => {
    if (!restaurantEnabled || !isOnline || !tablesQuery.data?.length) return;
    const { closed } = reconcileRestaurantJournalWithServerTables(tablesQuery.data);
    if (closed > 0) {
      invalidateJournalMemoryCache();
      bumpJournal();
      void queryClient.invalidateQueries({ queryKey: ['restaurant', 'kitchen'] });
      toast.success(`Cleared ${closed} settled check(s) from floor / kitchen`, {
        id: 'restaurant-journal-reconcile',
      });
    }
  }, [restaurantEnabled, isOnline, tablesQuery.data, queryClient]);

  const waitersQuery = useQuery({
    queryKey: restaurantWaitersQueryKey(user?.id, isOnline),
    queryFn: async () => {
      if (!isOnline) return getCachedRestaurantWaiters() as RestaurantWaiter[];
      const res = await api.restaurant.listWaiters({ silentForbidden: true });
      const waiters = (res.data.data || []) as RestaurantWaiter[];
      const { cacheRestaurantWaiters } = await import('../../lib/restaurantOfflineCache');
      cacheRestaurantWaiters(waiters);
      return waiters;
    },
    enabled: !!restaurantEnabled && !!user?.id && canReadFloor,
    staleTime: 60_000,
    refetchOnMount: false,
  });

  const checkQuery = useQuery({
    // journalTick is NOT in the key — local writes paint via setQueryData for instant FOH.
    queryKey: ['restaurant', 'check', selectedTableId, activeOrderId, isOnline],
    queryFn: async () => {
      const fetchGen = checkPaintGenRef.current;
      const keepIfStale = (payload: CheckUiPayload) =>
        coalesceRestaurantCheckFetch({
          startedGen: fetchGen,
          paintGen: checkPaintGenRef.current,
          cached: queryClient.getQueryData([
            'restaurant',
            'check',
            selectedTableId,
            activeOrderId,
            isOnline,
          ]) as CheckUiPayload | undefined,
          incoming: payload,
        });
      const cachedTable =
        getCachedRestaurantTables().find((t) => t.id === selectedTableId) ||
        tablesQuery.data?.find((t) => t.id === selectedTableId);

      const local = selectedTableId
        ? buildCheckUiFromJournal(selectedTableId, activeOrderId, cachedTable)
        : null;

      // Journal-local ofl_ord_* checks: always journal-first (server has no row).
      if (local?.order && isJournalLocalOrderId(local.order.id)) {
        return attachSiblingTabs(local, tableTicketsRef.current.tabs);
      }
      // Optimistic tmp_ord_* painted before first addItems returns — never GET ?orderId=tmp_*.
      if (local?.order && isTempRestaurantId(local.order.id)) {
        return attachSiblingTabs(local, tableTicketsRef.current.tabs);
      }
      if (isTempRestaurantId(activeOrderId)) {
        const optimistic =
          (queryClient.getQueryData([
            'restaurant',
            'check',
            selectedTableId,
            null,
            isOnline,
          ]) as CheckUiPayload | undefined) || local;
        if (optimistic?.order) {
          return attachSiblingTabs(optimistic, tableTicketsRef.current.tabs);
        }
      }
      // Offline with a seeded server check: serve from journal.
      if (!isOnline) {
        return attachSiblingTabs(
          local || {
            table: (cachedTable || { id: selectedTableId! }) as RestaurantTable,
            order: null,
            meta: null,
            siblingChecks: [],
          },
          tableTicketsRef.current.tabs,
        );
      }

      if (!selectedTableId) {
        return {
          table: { id: selectedTableId! } as RestaurantTable,
          order: null,
          meta: null,
          siblingChecks: [],
        };
      }

      const serverOrderId = toServerRestaurantOrderId(activeOrderId);
      try {
        const res = await api.restaurant.getTableCheck(
          selectedTableId,
          serverOrderId ? { orderId: serverOrderId } : undefined,
          // Expected peer-table deny — don't toast as generic "Server error".
          { silentForbidden: true },
        );
        const data = res.data.data as CheckUiPayload;
        return keepIfStale(
          attachSiblingTabs(
            checkUiAfterServerSeed(selectedTableId, data),
            tableTicketsRef.current.tabs,
          ),
        );
      } catch (err: unknown) {
        const structured = getStructuredError(err);
        const msg =
          structured.message ||
          (err instanceof Error ? err.message : '') ||
          '';
        const status =
          structured.status ??
          (err as { response?: { status?: number } })?.response?.status;
        // silentForbidden → HandledApiError (no .response); match ownership copy.
        if (
          status === 403 ||
          /belongs to another waiter|another waiter|edit others|reassign/i.test(msg)
        ) {
          toast.error(
            /another waiter|edit others|reassign/i.test(msg)
              ? msg
              : 'This table belongs to another waiter. Ask a cashier or manager to open it.',
            { id: 'restaurant-check-owned', duration: 4500 },
          );
          return attachSiblingTabs(
            {
              table: (cachedTable || { id: selectedTableId }) as RestaurantTable,
              order: null,
              meta: null,
              siblingChecks: [],
            },
            tableTicketsRef.current.tabs,
          );
        }
        throw err;
      }
    },
    // Instant ticket switch: show journal/cache/shell for THIS orderId only —
    // never reuse previous ticket's lines (wrong party / wrong bill).
    placeholderData: () => {
      if (!selectedTableId || !activeOrderId) return undefined;
      const cachedTable =
        getCachedRestaurantTables().find((t) => t.id === selectedTableId) ||
        tablesQuery.data?.find((t) => t.id === selectedTableId);
      const local = buildCheckUiFromJournal(selectedTableId, activeOrderId, cachedTable);
      if (local?.order?.id === activeOrderId) {
        return attachSiblingTabs(local, tableTicketsRef.current.tabs);
      }
      const cached = queryClient.getQueryData([
        'restaurant',
        'check',
        selectedTableId,
        activeOrderId,
        isOnline,
      ]) as CheckUiPayload | undefined;
      if (cached?.order?.id === activeOrderId) {
        return attachSiblingTabs(cached, tableTicketsRef.current.tabs);
      }
      const tabMeta =
        tableTicketsRef.current.tableId === selectedTableId
          ? tableTicketsRef.current.tabs.find((t) => t.id === activeOrderId)
          : undefined;
      // Matching empty shell — never undefined (blank Close/KOT) and never
      // keepPreviousData (wrong ticket lines).
      return attachSiblingTabs(
        {
          table: (cachedTable || { id: selectedTableId }) as RestaurantTable,
          order: {
            id: activeOrderId,
            orderNumber: tabMeta?.orderNumber || '…',
            status: 'PENDING',
            items: [],
            subtotal: '0',
            discountAmount: '0',
            taxAmount: '0',
            totalAmount: String(tabMeta?.totalAmount ?? 0),
            notes: tabMeta?.note ?? null,
            customerId: null,
          },
          meta: null,
          siblingChecks: [],
        },
        tableTicketsRef.current.tabs,
      );
    },
    enabled: !!restaurantEnabled && !!selectedTableId,
    // Seed null→orderId must not immediately re-GET the same check (table-pick lag).
    staleTime: 20_000,
  });

  const categoriesQuery = useQuery({
    queryKey: ['restaurant', 'menu', 'categories', isOnline],
    queryFn: async () => {
      if (!isOnline) return getCachedRestaurantCategories() as MenuCategory[];
      const res = await api.restaurant.menuCategories();
      const cats = (res.data.data || []) as MenuCategory[];
      const { cacheRestaurantCategories } = await import('../../lib/restaurantOfflineCache');
      cacheRestaurantCategories(cats);
      return cats;
    },
    // Warm on floor — do not wait for first table tap / re-fetch every open.
    enabled: !!restaurantEnabled && !!user?.id,
    staleTime: 5 * 60_000,
    refetchOnMount: false,
  });

  // Load full menu once; category + search filter client-side (SambaPOS-style type-to-find).
  const productsQuery = useQuery({
    queryKey: ['restaurant', 'menu', 'products', 'all', isOnline],
    queryFn: async () => {
      if (!isOnline) return getCachedRestaurantMenu() as MenuProduct[];
      const res = await api.restaurant.menuProducts();
      const products = (res.data.data || []) as MenuProduct[];
      cacheRestaurantMenu(products);
      return products;
    },
    enabled: !!restaurantEnabled && !!user?.id,
    staleTime: 5 * 60_000,
    refetchOnMount: false,
  });

  const visibleProducts = useMemo(() => {
    const all = productsQuery.data || [];
    const q = deferredMenuSearch.trim().toLowerCase();
    if (q) {
      return all.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          (p.categoryName || '').toLowerCase().includes(q) ||
          (p.kitchenStation || '').toLowerCase().includes(q),
      );
    }
    if (selectedCategoryId) {
      return all.filter((p) => p.categoryId === selectedCategoryId);
    }
    return all;
  }, [productsQuery.data, deferredMenuSearch, selectedCategoryId]);

  /** Enter / quick-add: unique result, or exact name match when several remain. */
  const quickAddProduct = useMemo(() => {
    const q = deferredMenuSearch.trim().toLowerCase();
    if (!q || visibleProducts.length === 0) return null;
    if (visibleProducts.length === 1) return visibleProducts[0];
    const exact = visibleProducts.find((p) => p.name.toLowerCase() === q);
    return exact ?? null;
  }, [deferredMenuSearch, visibleProducts]);

  useEffect(() => {
    if (!selectedTableId) {
      setSelectedCategoryId(null);
      setMenuSearch('');
      setMobileSheet(null);
      setOpsMode(null);
      setSelectedLineIds([]);
      setPendingQtyDigits('');
      setMenuQtyPadOpen(false);
      setQtyPadSheet(null);
      pendingMobileSheetRef.current = null;
      return;
    }
    setPendingQtyDigits('');
    setMenuQtyPadOpen(false);
    const pending = pendingMobileSheetRef.current;
    pendingMobileSheetRef.current = null;
    // Phone only: TA/DL open customer sheet; menu stays usable after Done (never cover menu with Order).
    const phone =
      typeof window !== 'undefined' && !window.matchMedia('(min-width: 1024px)').matches;
    setMobileSheet(phone && pending === 'details' ? 'details' : null);
  }, [selectedTableId]);

  // Hardware keyboard: type anywhere on the order screen → focus search (Toast / Square / SambaPOS).
  useEffect(() => {
    if (!selectedTableId || opsMode) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) {
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Escape') {
        const q = searchInputRef.current?.value?.trim() || '';
        if (q) {
          setMenuSearch('');
          searchInputRef.current?.blur();
          return;
        }
        // Leave table without ordering (or leave open check on floor) — back to main.
        setSelectedTableId(null);
        setMenuSearch('');
        setSelectedCategoryId(null);
        setMobileSheet(null);
        setOpsMode(null);
        setSelectedLineIds([]);
        setBusy(false);
        return;
      }
      if (e.key === 'F3') {
        e.preventDefault();
        requestSoftKeyboard(searchInputRef.current);
        searchInputRef.current?.select();
        return;
      }
      if (e.key.length === 1 && /[\w\-./+]/.test(e.key)) {
        e.preventDefault();
        setMenuSearch((prev) => prev + e.key);
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedTableId, opsMode]);

  /** Instant FOH paint from journal — no React Query refetch / no network. */
  const paintJournalCheck = (tableId: string | null, orderId?: string | null) => {
    bumpJournal();
    if (!tableId) return;
    const oid = orderId === undefined ? activeOrderId : orderId;
    const cachedTable =
      getCachedRestaurantTables().find((t) => t.id === tableId) ||
      tablesQuery.data?.find((t) => t.id === tableId);
    const data = buildCheckUiFromJournal(tableId, oid, cachedTable);
    queryClient.setQueryData(['restaurant', 'check', tableId, oid, isOnline], data);
    if (oid) {
      queryClient.setQueryData(['restaurant', 'check', tableId, null, isOnline], data);
    }
  };

  /** Always journal-first for ofl_ord_*; server UUID checks use API while online. */
  const preferLocalRestaurantWrites = (orderId?: string | null) =>
    shouldUseLocalRestaurantMutation(isOnline, orderId);

  const openOrderTagPad = async (args: {
    orderId: string;
    itemId: string;
    productId: string;
    productName: string;
    existingNotes?: string | null;
    existingTags?: RestaurantOrderTagSelection[] | null;
  }) => {
    if (isTempRestaurantId(args.itemId) || isTempRestaurantId(args.orderId)) return;
    try {
      // Cache per product — every menu tap used to hit the network (ticket lag).
      const groups = await queryClient.fetchQuery({
        queryKey: ['restaurant', 'order-tags', args.productId],
        staleTime: 10 * 60_000,
        queryFn: async () => {
          const res = await api.restaurant.listOrderTagsForProduct(args.productId);
          return (res.data.data || []) as OrderTagGroupOption[];
        },
      });
      if (groups.length === 0) return;
      const shouldPrompt = groups.some((g) => g.autoPrompt) || groups.length > 0;
      if (!shouldPrompt) return;
      setTagPad({
        orderId: args.orderId,
        itemId: args.itemId,
        productId: args.productId,
        productName: args.productName,
        groups,
        selected: args.existingTags || [],
        freeText: args.existingNotes || '',
      });
    } catch {
      // Tag catalog optional — never block add.
    }
  };

  const saveOrderTagPad = async () => {
    if (!tagPad || !selectedTableId) return;
    setTagPadBusy(true);
    try {
      if (preferLocalRestaurantWrites(tagPad.orderId)) {
        // Offline: fold tags into journal line notes via seed refresh path after local edit.
        const notes = formatOrderTagsAsLineNotes(tagPad.selected, tagPad.freeText);
        queryClient.setQueryData(
          ['restaurant', 'check', selectedTableId, activeOrderId, isOnline],
          (prev: CheckUiPayload | undefined) => {
            if (!prev?.order) return prev;
            return {
              ...prev,
              order: {
                ...prev.order,
                items: prev.order.items.map((it) =>
                  it.id === tagPad.itemId
                    ? { ...it, lineNotes: notes, orderTags: tagPad.selected }
                    : it,
                ),
              },
            };
          },
        );
        setTagPad(null);
        toast.success(notes ? 'Tags saved on ticket' : 'Tags cleared');
        return;
      }
      const res = await api.restaurant.setItemOrderTags(tagPad.orderId, {
        itemId: tagPad.itemId,
        orderTags: tagPad.selected,
        freeText: tagPad.freeText.trim() || null,
      });
      const payload = res.data.data as { order?: OrderDetail; meta?: CheckMeta };
      if (payload?.order) {
        paintServerCheckWithInFlight(
          selectedTableId,
          {
            table: checkQuery.data?.table || ({ id: selectedTableId } as RestaurantTable),
            order: payload.order,
            meta: payload.meta || checkQuery.data?.meta || null,
            siblingChecks: checkQuery.data?.siblingChecks || [],
          },
          tagPad.orderId,
        );
      } else {
        invalidateCheck();
      }
      setTagPad(null);
      toast.success('Order tags applied');
    } catch (err) {
      toastApiError(err, 'Failed to apply tags');
    } finally {
      setTagPadBusy(false);
    }
  };

  const addItemMutation = useMutation({
    mutationFn: async (input: MenuProduct | { product: MenuProduct; quantity?: number }) => {
      if (!canOrder) throw new Error('You need restaurant.order permission to add items');
      const product = 'product' in input ? input.product : input;
      const quantity =
        'product' in input && input.quantity != null
          ? Math.max(1, Math.min(9999, Math.floor(input.quantity)))
          : parsePendingOrderQty(pendingQtyDigits);

      const addStockWarn = restaurantFohStockWarnMessage({
        allowOversell,
        productType: product.productType,
        productName: product.name,
        remainingQty: product.remainingQuantity,
        requestedQty: quantity,
        stage: 'add',
      });
      if (addStockWarn) {
        toast(addStockWarn, { id: `foh-stock-warn-${product.id}`, duration: 5000, icon: '⚠️' });
      }

      if (!selectedTableId) throw new Error('Select a table or service lane first');
      if (!selectedWaiterId) throw new Error('Select a waiter first');
      const table =
        tablesQuery.data?.find((t) => t.id === selectedTableId) ?? checkQuery.data?.table;
      const channel = channelHint(table);
      const isQuickLane = (table?.code || '').toUpperCase() === 'QK';
      // Takeaway / Delivery / Quick: customer + address are optional (walk-up / unnamed).

      if (!table) throw new Error('Table not in offline cache — connect once to sync floor/menu');
      const waiter = waiters.find((w) => w.id === selectedWaiterId);
      const guestName =
        selectedCustomer?.name?.trim() ||
        guestDraft.guestName.trim() ||
        (isQuickLane || channel === 'TAKEAWAY' || channel === 'DELIVERY' ? 'Walk-in' : null);
      const guestPhone =
        selectedCustomer?.phone?.trim() || guestDraft.guestPhone.trim() || null;
      const deliveryAddress =
        selectedCustomer?.address?.trim() || guestDraft.deliveryAddress.trim() || null;

      /**
       * Toast/Samba: "Select a ticket" ONLY when 2+ tickets and party list is up.
       * Sheet FOH clears activeOrderId on table pick — first tap must still add.
       */
      const floorOpenCount = Number(table.openCheckCount || 0);
      const tableOccupied =
        floorOpenCount > 0 ||
        (table.status != null && String(table.status) !== 'FREE');
      let addDecision = resolveFohMenuAddTarget({
        partyListVisible: showSambaTicketList,
        ticketCount: ticketTabs.length,
        soleTicketId: ticketTabs.length === 1 ? ticketTabs[0]?.id ?? null : null,
        activeOrderId,
        currentOrderId: order?.id ?? null,
        checkSettled: checkQuery.isFetched && !checkQuery.isLoading,
        tableOccupied,
        floorOpenCount,
      });
      if (addDecision.action === 'wait-check' && isOnline) {
        try {
          const res = await api.restaurant.getTableCheck(
            selectedTableId,
            undefined,
            { silentForbidden: true },
          );
          const data = res.data.data as CheckUiPayload;
          seedCheckPayloadIntoJournal(selectedTableId, data);
          const openIds = [
            data.order?.id,
            ...(data.siblingChecks || []).map((s) => s.id),
          ].filter((id): id is string => !!id && !isTempRestaurantId(id));
          const unique = [...new Set(openIds)];
          addDecision = resolveFohMenuAddTarget({
            partyListVisible: unique.length > 1,
            ticketCount: unique.length,
            soleTicketId: unique.length === 1 ? unique[0] : null,
            activeOrderId: unique.length === 1 ? unique[0] : null,
            currentOrderId: data.order?.id ?? null,
            checkSettled: true,
            tableOccupied: unique.length > 0,
            floorOpenCount: unique.length,
          });
          if (addDecision.action === 'select-ticket') {
            setSambaTicketView('list');
            if (chrome.fohTicketPane === 'sheet') setMobileSheet('order');
          }
          if (addDecision.action === 'bind') {
            setActiveOrderId(addDecision.orderId);
          }
        } catch {
          // Keep wait-check → "Loading ticket…" not "Select a ticket".
        }
      }
      const blocked = fohMenuAddBlockedMessage(addDecision);
      if (blocked) throw new Error(blocked);
      const targetOrderId =
        addDecision.action === 'bind' ? addDecision.orderId : null;

      if (preferLocalRestaurantWrites(targetOrderId)) {
        const derived = appendRestaurantItemOffline({
          tableId: selectedTableId,
          tableCode: table.code,
          tableName: table.name,
          channel,
          orderId: targetOrderId,
          customerId: selectedCustomer?.id || null,
          waiterId: selectedWaiterId,
          waiterName: waiter?.fullName,
          addedBy: user?.id ?? null,
          addedByName: user?.fullName || user?.email || null,
          addedAt: new Date().toISOString(),
          guestName,
          guestPhone,
          deliveryAddress,
          pickupLabel: guestDraft.pickupLabel.trim() || null,
          productId: product.id,
          productName: product.name,
          unitPrice: Number(product.sellingPrice) || 0,
          quantity,
          productType: product.productType,
        });
        if (selectedTableId) {
          clearRestaurantBillRequestedOffline(selectedTableId, derived.orderId);
        }
        paintJournalCheck(selectedTableId, derived.orderId);
        if (derived.orderId) setActiveOrderId(derived.orderId);
        return { offline: true as const, orderId: derived.orderId, quantity };
      }

      // Online: paint the on-screen query key (activeOrderId, often null after table pick)
      // AND the target ticket key. Writing only the target left the ticket stale until KOT.
      const displayKey = ['restaurant', 'check', selectedTableId, activeOrderId, isOnline] as const;
      const checkKey = ['restaurant', 'check', selectedTableId, targetOrderId, isOnline] as const;
      const prevSnapshot =
        (queryClient.getQueryData(checkKey) as CheckUiPayload | undefined) ||
        (queryClient.getQueryData(displayKey) as CheckUiPayload | undefined);
      const tempLineId = newTempLineId();
      const unitPrice = Number(product.sellingPrice) || 0;
      inFlightOptimisticLinesRef.current.set(tempLineId, {
        tempLineId,
        productId: product.id,
        productName: product.name,
        quantity,
        unitPrice,
      });
      const optimistic = appendOptimisticMenuItem(
        prevSnapshot as OptimisticCheckPayload | undefined,
        {
          table,
          product,
          quantity,
          tempLineId,
          channel,
          waiterId: selectedWaiterId,
          waiterName: waiter?.fullName ?? null,
          addedBy: user?.id ?? null,
          addedByName: user?.fullName || user?.email || null,
          addedAt: new Date().toISOString(),
          guestName,
          guestPhone,
          deliveryAddress,
          pickupLabel: guestDraft.pickupLabel.trim() || null,
          knownTabs: tableTicketsRef.current.tabs,
        },
      ) as CheckUiPayload;
      for (const id of restaurantCheckQueryPaintIds({
        paintedOrderId: optimistic.order?.id,
        targetOrderId,
        displayedOrderId: activeOrderId,
      })) {
        queryClient.setQueryData(['restaurant', 'check', selectedTableId, id, isOnline], optimistic);
      }
      checkPaintGenRef.current += 1;
      setPendingQtyDigits('');
      setMenuQtyPadOpen(false);

      const apiOrderId = toServerRestaurantOrderId(targetOrderId);

      try {
        const postItems = async (orderIdForApi: string | null | undefined) => {
          const res = await api.restaurant.addItems({
            tableId: selectedTableId,
            orderId: orderIdForApi ?? undefined,
            waiterId: selectedWaiterId,
            customerId: selectedCustomer?.id || null,
            guestName,
            guestPhone,
            deliveryAddress,
            pickupLabel: guestDraft.pickupLabel.trim() || null,
            items: [{ productId: product.id, quantity }],
          });
          return readRestaurantAddItemsPayload(res.data.data) || readRestaurantAddItemsPayload(res.data);
        };
        let added = await postItems(apiOrderId).catch(async (firstErr) => {
          if (!apiOrderId || !isRestaurantCheckClosedError(firstErr)) throw firstErr;
          // Paid/cancelled ticket still in cache — clear paint and retry only when
          // the table has no other open check (siblings → refresh UI, don't open a 3rd).
          setActiveOrderId(null);
          void queryClient.invalidateQueries({
            queryKey: ['restaurant', 'check', selectedTableId],
          });
          const details = axios.isAxiosError(firstErr)
            ? (firstErr.response?.data as { details?: { openOrderIds?: string[] } } | undefined)
                ?.details
            : undefined;
          const openIds = details?.openOrderIds;
          if (Array.isArray(openIds) && openIds.length > 0) throw firstErr;
          return postItems(undefined);
        });
        if (selectedTableId) {
          const billOrderId = toServerRestaurantOrderId(added?.order?.id) || targetOrderId || order?.id;
          if (billOrderId) clearRestaurantBillRequestedOffline(selectedTableId, billOrderId);
        }
        inFlightOptimisticLinesRef.current.delete(tempLineId);
        if (!added) {
          const res = await api.restaurant.getTableCheck(
            selectedTableId,
            apiOrderId ? { orderId: apiOrderId } : undefined,
          );
          const data = res.data.data as CheckUiPayload;
          const stayOn =
            toServerRestaurantOrderId(data.order?.id) ||
            toServerRestaurantOrderId(targetOrderId) ||
            null;
          await queryClient.cancelQueries({ queryKey: ['restaurant', 'check', selectedTableId] });
          paintServerCheckWithInFlight(selectedTableId, data, stayOn);
          if (stayOn) setActiveOrderId(stayOn);
          return { offline: false as const, refreshed: true as const, quantity };
        }
        await queryClient.cancelQueries({ queryKey: ['restaurant', 'check', selectedTableId] });
        const prev =
          (queryClient.getQueryData(displayKey) as CheckUiPayload | undefined) ||
          (queryClient.getQueryData(checkKey) as CheckUiPayload | undefined);
        const data: CheckUiPayload = {
          table: added.table as CheckUiPayload['table'],
          order: added.order as CheckUiPayload['order'],
          meta: (added.meta as CheckUiPayload['meta']) || null,
          siblingChecks: prev?.siblingChecks || [],
        };
        const stayOn = added.order.id;
        paintServerCheckWithInFlight(selectedTableId, data, stayOn);
        setActiveOrderId(stayOn);
        const newest = [...(added.order.items || [])]
          .reverse()
          .find((it) => it.productId === product.id) as OrderItem | undefined;
        if (stayOn && newest?.id && product.id) {
          void openOrderTagPad({
            orderId: stayOn,
            itemId: newest.id,
            productId: product.id,
            productName: product.name,
            existingNotes: newest.lineNotes,
            existingTags: newest.orderTags,
          });
        }
        return { offline: false as const, refreshed: true as const, quantity };
      } catch (err) {
        inFlightOptimisticLinesRef.current.delete(tempLineId);
        try {
          const res = await api.restaurant.getTableCheck(
            selectedTableId,
            apiOrderId ? { orderId: apiOrderId } : undefined,
          );
          const data = res.data.data as CheckUiPayload;
          const stayOn =
            toServerRestaurantOrderId(data.order?.id) ||
            toServerRestaurantOrderId(targetOrderId) ||
            null;
          paintServerCheckWithInFlight(selectedTableId, data, stayOn);
          if (stayOn) setActiveOrderId(stayOn);
          else setActiveOrderId(null);
        } catch {
          queryClient.setQueryData(checkKey, prevSnapshot);
        }
        throw err;
      }
    },
    onSuccess: (data) => {
      setPendingQtyDigits('');
      setMenuQtyPadOpen(false);
      // Offline journal + online optimistic paths already painted the ticket.
      if (data && typeof data === 'object' && ('offline' in data || 'refreshed' in data)) return;
      invalidateCheck();
    },
    onError: (err: unknown) => toastApiError(err, 'Failed to add item'),
  });

  const openServiceLane = async (kind: ServiceLaneKind) => {
    if (!canAccessServiceLanes) {
      toast.error(
        'Takeaway, Delivery, and Quick orders are for cashiers and managers only. Waiters use dining tables.',
      );
      return;
    }
    const def = SERVICE_LANE_DEFS[kind];
    // Phone: TA/DL open customer sheet first; Quick goes straight to menu (add items).
    // Never open Order sheet on lane select — it covers the menu and blocks adds.
    const sheetAfterSelect: 'details' | null = kind === 'QUICK' ? null : 'details';
    const existing = (tablesQuery.data || getCachedRestaurantTables()).find(
      (t) => t.code.toUpperCase() === def.code,
    );
    if (existing) {
      pendingMobileSheetRef.current = sheetAfterSelect;
      setSelectedTableId(existing.id);
      setActiveOrderId(null);
      toast.success(
        kind === 'QUICK'
          ? `${def.name} — add items`
          : `${def.name} — select customer, then add items`,
      );
      return;
    }
    if (!canOrder) {
      toast.error('You need restaurant.order permission for takeaway / delivery');
      return;
    }
    if (!isOnline) {
      toast.error(`Connect once to create the ${def.name} lane (${def.code})`);
      return;
    }
    try {
      const res = await api.restaurant.ensureServiceLanes();
      const tables = (res.data.data || []) as RestaurantTable[];
      await queryClient.invalidateQueries({ queryKey: ['restaurant', 'tables'] });
      const refreshed = await api.restaurant.listTables();
      const listed = (refreshed.data.data || []) as RestaurantTable[];
      const { cacheRestaurantTables } = await import('../../lib/restaurantOfflineCache');
      cacheRestaurantTables(listed.length ? listed : tables);
      const opened =
        listed.find((t) => t.code.toUpperCase() === def.code) ||
        tables.find((t) => t.code.toUpperCase() === def.code);
      if (!opened) {
        toast.error(`${def.name} lane could not be created`);
        return;
      }
      pendingMobileSheetRef.current = sheetAfterSelect;
      setSelectedTableId(opened.id);
      setActiveOrderId(null);
      toast.success(
        kind === 'QUICK'
          ? `${def.name} — add items`
          : `${def.name} — select customer, then add items`,
      );
    } catch (err) {
      toastApiError(err, `Failed to open ${def.name}`);
    }
  };

  const saveGuestMutation = useMutation({
    mutationFn: async (customerOverride?: Customer | null) => {
      if (!order) throw new Error('No open check');
      const c = customerOverride === undefined ? selectedCustomer : customerOverride;
      const guestName = c?.name?.trim() || guestDraft.guestName.trim() || null;
      const guestPhone = c?.phone?.trim() || guestDraft.guestPhone.trim() || null;
      const deliveryAddress = c?.address?.trim() || guestDraft.deliveryAddress.trim() || null;
      const pickupLabel = guestDraft.pickupLabel.trim() || null;

      if (shouldUseLocalRestaurantMutation(isOnline, order.id)) {
        const events = getAllEvents();
        const syncState = getAllSyncState();
        const derived = selectedTableId
          ? deriveRestaurantCheckForTable(selectedTableId, events, syncState, order.id)
          : null;
        if (!derived) throw new Error('Local check not found in journal');
        const next = updateRestaurantGuestOffline(derived, {
          customerId: c?.id || null,
          guestName,
          guestPhone,
          deliveryAddress,
          pickupLabel,
        });
        paintJournalCheck(selectedTableId, next.orderId);
        return { offline: true as const };
      }

      const res = await api.restaurant.updateGuest(order.id, {
        guestName,
        guestPhone,
        deliveryAddress,
        pickupLabel,
      });
      return res.data.data;
    },
    onSuccess: (data) => {
      toast.success('Customer saved on check');
      if (data && typeof data === 'object' && 'offline' in data) return;
      invalidateCheck();
    },
    onError: (err: unknown) => toastApiError(err, 'Failed to save customer'),
  });

  /** Search/add customer → stamp name/phone/address on the check (no duplicate guest form). */
  const handleSelectServiceCustomer = (c: Customer | null) => {
    setSelectedCustomer(c);
    if (c) {
      setGuestDraft({
        guestName: c.name || '',
        guestPhone: c.phone || '',
        deliveryAddress: c.address || '',
        pickupLabel: '',
      });
      if (order) saveGuestMutation.mutate(c);
      // Phone: close sheet so menu is free for adding items.
      const phone =
        typeof window !== 'undefined' && !window.matchMedia('(min-width: 1024px)').matches;
      if (phone) setMobileSheet(null);
    } else {
      setGuestDraft({ guestName: '', guestPhone: '', deliveryAddress: '', pickupLabel: '' });
    }
  };

  const assignWaiterMutation = useMutation({
    mutationFn: async (waiterId: string) => {
      if (!order) throw new Error('No open check');
      const res = await api.restaurant.assignWaiter(order.id, { waiterId });
      return res.data.data;
    },
    onSuccess: () => {
      toast.success('Waiter assigned');
      invalidateCheck();
    },
    onError: (err: unknown) => toastApiError(err, 'Failed to assign waiter'),
  });

  const createTableMutation = useMutation({
    mutationFn: async () => {
      const res = await api.restaurant.createTable({
        code: newTable.code.trim(),
        name: newTable.name.trim() || newTable.code.trim(),
        zone: newTable.zone.trim() || 'MAIN',
        seats: Number(newTable.seats) || 0,
      });
      return res.data.data;
    },
    onSuccess: () => {
      toast.success('Table created');
      setShowAddTable(false);
      setNewTable({ code: '', name: '', zone: 'MAIN', seats: 4 });
      void queryClient.invalidateQueries({ queryKey: ['restaurant', 'tables'] });
    },
    onError: (err: unknown) => toastApiError(err, 'Failed to create table'),
  });

  // Multi-ticket: strip selection wins — never show another check's shell/lines.
  const order = useMemo(
    () => resolvePaintedOrder(checkQuery.data?.order ?? null, activeOrderId),
    [checkQuery.data?.order, activeOrderId],
  );
  const ticketNote = displayTicketNote(order?.notes);
  const meta =
    order && checkQuery.data?.order?.id === order.id ? checkQuery.data?.meta ?? null : null;
  const siblingChecks = checkQuery.data?.siblingChecks ?? [];
  const ticketVoids = checkQuery.data?.voids ?? [];
  const selectedTable =
    tablesQuery.data?.find((t) => t.id === selectedTableId) ?? checkQuery.data?.table;

  const orderLines = useMemo(() => order?.items ?? [], [order]);
  const totalOrderUnits = useMemo(
    () => orderLines.reduce((s, l) => s + (Number(l.quantity) || 0), 0),
    [orderLines],
  );
  const selectedMoveUnits = useMemo(() => {
    const idSet = new Set(selectedLineIds);
    return orderLines.reduce(
      (s, l) => s + (idSet.has(l.id) ? Number(l.quantity) || 0 : 0),
      0,
    );
  }, [selectedLineIds, orderLines]);
  const ticketGroups = useMemo(
    () =>
      consolidateTicketLines(
        orderLines,
        meta?.waiterName || user?.fullName || user?.email || null,
      ),
    [orderLines, meta?.waiterName, user?.fullName, user?.email],
  );
  const serviceChannel = isServiceChannelTable(selectedTable);
  const isQuickLane = (selectedTable?.code || '').toUpperCase() === 'QK';
  const channel = meta?.orderChannel || channelHint(selectedTable);
  /**
   * Guest check printed for the *selected* ticket only.
   * Multi-ticket tables must not treat table BILLING as “all checks billed”.
   */
  const isCheckBilled = useMemo(() => {
    if (!selectedTableId || !order?.id) return false;
    if (isRestaurantOrderBillRequestedOffline(selectedTableId, order.id)) return true;
    const hasOtherOpenTickets = siblingChecks.some((s) => s.id !== order.id);
    // Sole open ticket: server table BILLING still means this check.
    if (!hasOtherOpenTickets && selectedTable?.status === 'BILLING') return true;
    return false;
  }, [selectedTable?.status, selectedTableId, order?.id, journalTick, siblingChecks]);

  const waiters = waitersQuery.data ?? EMPTY_RESTAURANT_WAITERS;
  const floorOccupancy = useMemo(
    () => deriveRestaurantFloorOccupancy(getAllEvents(), getAllSyncState()),
    [journalTick],
  );

  const floorTables = useMemo(() => {
    const billRequested = getRestaurantBillRequestedOffline();
    const cachedById = new Map(getCachedRestaurantTables().map((t) => [t.id, t]));
    const all = (tablesQuery.data || []).map((t) => {
      const check = floorOccupancy.get(t.id);
      if (check) {
        const localOnly = isJournalLocalOrderId(check.orderId);
        const paintJournal = shouldPaintJournalOccupancyOnServerFree({
          isOnline,
          serverStatus: t.status,
          journalOrderId: check.orderId,
          isJournalLocalOrderId: localOnly,
          journalWaiterId: check.waiterId,
          actorUserId: user?.id,
        });
        // Online + server FREE: never paint busy from a stale peer journal seed.
        if (!paintJournal) {
          return {
            ...t,
            status: 'FREE' as const,
            currentOrderId: null,
            orderNumber: null,
            orderTotal: null,
            guestName: null,
            waiterId: null,
            waiterName: null,
          };
        }
        const totals = totalsFromLines(check.lines);
        const billed =
          !!check.orderId && (billRequested[t.id] || []).includes(check.orderId);
        // Multi-ticket: keep patched openCheckCount / openChecksTotal (exact party sum).
        // Single journal seed must not replace party floor figures with one check's lines.
        const partyCount = Number(t.openCheckCount || 0);
        const partyTotal =
          partyCount > 1 && t.openChecksTotal != null && t.openChecksTotal !== ''
            ? t.openChecksTotal
            : String(totals.totalAmount);
        return {
          ...t,
          status: (billed ? 'BILLING' : 'OCCUPIED') as RestaurantTable['status'],
          currentOrderId: check.orderId,
          orderNumber: check.offlineId,
          orderTotal: String(partyTotal),
          waiterId: check.waiterId,
          waiterName: check.waiterName,
          guestName: check.guestName,
          orderChannel: check.channel,
        };
      }
      // No open journal check.
      // Online: trust server occupancy — cached FREE must not hide a live peer check
      // (waiters would open it and hit "belongs to another waiter").
      if (isOnline) {
        if (t.status === 'FREE') {
          return {
            ...t,
            status: 'FREE' as const,
            currentOrderId: null,
            orderNumber: null,
            orderTotal: null,
            guestName: null,
            waiterId: null,
            waiterName: null,
          };
        }
        return t;
      }
      // Offline: prefer cached FREE after local pay/cancel/void.
      const cached = cachedById.get(t.id);
      if (cached?.status === 'FREE' || t.status === 'FREE') {
        return {
          ...t,
          status: 'FREE' as const,
          currentOrderId: null,
          orderNumber: null,
          orderTotal: null,
          guestName: null,
          waiterId: null,
          waiterName: null,
        };
      }
      return t;
    });
    if (!myTablesOnly || !user?.id) return all;
    // Dining only for "my tables" filter — service counters are not waiter tables.
    return all.filter(
      (t) =>
        !isServiceChannelTable(t) &&
        (t.status === 'FREE' || t.waiterId === user.id),
    );
  }, [tablesQuery.data, myTablesOnly, user?.id, isOnline, floorOccupancy, journalTick]);

  const diningFloorTables = useMemo(
    () => floorTables.filter((t) => !isServiceChannelTable(t)),
    [floorTables],
  );

  const diningFloorEmpty = useMemo(
    () =>
      resolveDiningFloorEmptyState({
        isLoading: tablesQuery.isLoading,
        isError: tablesQuery.isError,
        isOnline,
        serverTableCount: (tablesQuery.data || []).length,
        diningVisibleCount: diningFloorTables.length,
        myTablesOnly,
        canEditOthers,
      }),
    [
      tablesQuery.isLoading,
      tablesQuery.isError,
      tablesQuery.data,
      isOnline,
      diningFloorTables.length,
      myTablesOnly,
      canEditOthers,
    ],
  );

  const freeTables = useMemo(() => {
    return (tablesQuery.data || []).filter((t) => {
      if (t.id === selectedTableId) return false;
      if (floorOccupancy.has(t.id)) return false;
      return t.status === 'FREE';
    });
  }, [tablesQuery.data, selectedTableId, floorOccupancy]);

  /** Samba: every open ticket on this table (active + siblings) for switching. */
  const ticketTabs = useMemo(() => {
    const tabs: TicketTab[] = [];
    const pushTab = (
      id: string,
      orderNumber: string,
      totalAmount: string,
      note?: string | null,
    ) => {
      // Never surface optimistic tmp_ord_* as a switchable ticket (activate-check 400).
      if (!id || isTempRestaurantId(id)) return;
      const noteText = preferUserTicketNote(note);
      const existing = tabs.find((t) => t.id === id);
      if (existing) {
        // Live painted check is SSOT (including clear). Siblings fill/update when they have a note.
        if (id === order?.id) existing.note = noteText;
        else if (noteText) existing.note = noteText;
        if (totalAmount != null && totalAmount !== '') existing.totalAmount = String(totalAmount);
        if (orderNumber) existing.orderNumber = orderNumber;
        return;
      }
      tabs.push({
        id,
        orderNumber,
        totalAmount: String(totalAmount ?? 0),
        note: noteText,
      });
    };
    if (order && !isTempRestaurantId(order.id)) {
      pushTab(order.id, order.orderNumber, order.totalAmount, order.notes);
    }
    for (const s of siblingChecks) {
      pushTab(s.id, s.orderNumber, s.totalAmount, s.notes);
    }
    // Server payload present: only journal-local ofl ids may extend the strip.
    // Stale UUID ghosts (wrong table after transfer/seed) caused activate-check 400.
    const hasServerStrip = !!(order || siblingChecks.length > 0);
    const serverIds = new Set<string>();
    if (order?.id) serverIds.add(order.id);
    for (const s of siblingChecks) if (s?.id) serverIds.add(s.id);

    // Journal may already know sibling checks the current payload omitted mid-switch.
    if (selectedTableId) {
      const open = deriveRestaurantOpenChecks(getAllEvents(), getAllSyncState()).filter(
        (c) => c.tableId === selectedTableId,
      );
      for (const c of open) {
        if (
          hasServerStrip &&
          !isJournalLocalOrderId(c.orderId) &&
          !serverIds.has(c.orderId)
        ) {
          continue;
        }
        pushTab(
          c.orderId,
          c.offlineId,
          String(totalsFromLines(c.lines).totalAmount),
          c.notes,
        );
      }
    }
    // Keep user FOA note from cached strip when payload omitted it (mid-switch).
    // Never copy journal "Hydrated …" back onto the list.
    for (const prev of tableTicketsRef.current.tabs) {
      const prevNote = preferUserTicketNote(prev.note);
      if (!prevNote) continue;
      const hit = tabs.find((t) => t.id === prev.id);
      if (hit && !hit.note) hit.note = prevNote;
    }
    const openIds = retainOpenTicketIdsWithPartyPin(
      openTicketIdsForTable(selectedTableId, checkQuery.data),
      splitMovePartyPinRef.current,
      selectedTableId,
    );
    splitMovePartyPinRef.current = resolveSplitMovePartyPinAfterOpenIds({
      pin: splitMovePartyPinRef.current,
      tableId: selectedTableId,
      openIds,
    });
    const cleaned = scrubRestaurantTicketTabs(tabs).filter((t) => {
      if (isJournalLocalOrderId(t.id) || isTempRestaurantId(t.id)) return true;
      // No open-id evidence yet (cold load) — keep strip; do not wipe.
      if (openIds.size === 0) return true;
      return openIds.has(t.id);
    });
    if (selectedTableId) {
      tableTicketsRef.current = { tableId: selectedTableId, tabs: cleaned };
    }
    return cleaned;
  }, [order, siblingChecks, selectedTableId, journalTick, checkQuery.data]);

  const isMultiTicketTable = ticketTabs.length > 1;
  const showSambaTicketList = isMultiTicketTable && sambaTicketView === 'list';
  const ticketNoteOnCheck = resolveTicketNoteOnCheckPaint({
    partyListVisible: showSambaTicketList,
    loadingEmptyTicket:
      !!loadingTicketId &&
      loadingTicketId === (order?.id || activeOrderId) &&
      orderLines.length === 0,
    hasOrder: !!order,
    notes: order?.notes,
  });
  /** Compact packing from adaptive SSOT (not hard-coded brand/tier checks). */
  const isTouchDense = isAdaptiveDenseSurface(chrome);
  const isUltraDense = isAdaptiveUltraSurface(chrome);
  /**
   * Dense FOH: menu owns the viewport; ticket board is a dock + full sheet.
   * Comfortable: side-by-side column (never stack-split to an unusable menu strip).
   */
  const useSheetTicket = chrome.fohTicketPane === 'sheet';
  const ctaMinH = chrome.primaryCtaMinHeightPx;
  const newTicketLabel = resolveNewTicketLabel(chrome);
  const inlineTicketNote = showInlineTicketNote(chrome);
  const partyTicketsTotal = useMemo(
    () => ticketTabs.reduce((sum, t) => sum + (Number(t.totalAmount) || 0), 0),
    [ticketTabs],
  );

  // After a table pick: empty/single → detail (menu adds immediately).
  // 2+ → party list once. Layout effect: no detail→list flash. Do not keep driving view.
  useLayoutEffect(() => {
    if (!selectedTableId) {
      partyListLandedForTableRef.current = null;
      return;
    }
    const land = resolveTableOpenLand({
      alreadyLanded: partyListLandedForTableRef.current === selectedTableId,
      ticketCount: ticketTabs.length,
      siblingCount: siblingChecks.length,
      floorOpenCount: Number(selectedTable?.openCheckCount || 0),
      settled: checkQuery.isFetched && !checkQuery.isLoading,
    });
    if (land === 'hold') return;
    setSambaTicketView((prev) => (prev === land ? prev : land));
    partyListLandedForTableRef.current = selectedTableId;
  }, [
    selectedTableId,
    ticketTabs.length,
    siblingChecks.length,
    selectedTable?.openCheckCount,
    checkQuery.isFetched,
    checkQuery.isLoading,
  ]);

  /**
   * Toast/Samba: opening a multi-ticket table lands on the party list first.
   * Sheet FOH must surface that list immediately (ticket pane is otherwise hidden).
   */
  useEffect(() => {
    if (!selectedTableId) return;
    if (!isMultiTicketTable || sambaTicketView !== 'list') return;
    if (chrome.fohTicketPane === 'sheet') {
      setMobileSheet((sheet) => (sheet === 'order' ? sheet : 'order'));
    }
  }, [selectedTableId, isMultiTicketTable, sambaTicketView, chrome.fohTicketPane]);

  /** Prefetch sibling checks so switching tickets is cache-instant. */
  const ticketTabIdsKey = ticketTabs.map((t) => t.id).join(',');
  useEffect(() => {
    if (!isOnline || !selectedTableId || ticketTabs.length < 2) return;
    for (const t of ticketTabs) {
      if (t.id === activeOrderId || t.id === order?.id) continue;
      if (isJournalLocalOrderId(t.id) || isTempRestaurantId(t.id)) continue;
      const serverOrderId = toServerRestaurantOrderId(t.id);
      if (!serverOrderId) continue;
      const key = ['restaurant', 'check', selectedTableId, t.id, isOnline] as const;
      if (queryClient.getQueryData(key)) continue;
      void queryClient.prefetchQuery({
        queryKey: key,
        staleTime: 60_000,
        queryFn: async () => {
          const res = await api.restaurant.getTableCheck(
            selectedTableId,
            { orderId: serverOrderId },
            { silentForbidden: true },
          );
          const data = res.data.data as CheckUiPayload;
          return attachSiblingTabs(
            checkUiAfterServerSeed(selectedTableId, data),
            tableTicketsRef.current.tabs,
          );
        },
      });
    }
  }, [
    ticketTabIdsKey,
    selectedTableId,
    activeOrderId,
    order?.id,
    isOnline,
    queryClient,
  ]);

  /** Samba: merge only other tickets on the same table (never cross-table). */
  const mergeCandidates = useMemo(() => {
    return ticketTabs
      .filter((t) => !order || t.id !== order.id)
      .map((t) => ({
        orderId: t.id,
        label: `${t.orderNumber} · ${formatCurrency(Number(t.totalAmount))}`,
      }));
  }, [ticketTabs, order]);

  useEffect(() => {
    if (!user?.id) return;
    if (waiters.length === 0) {
      setSelectedWaiterId(user.id);
      return;
    }
    if (!selectedWaiterId || !waiters.some((w) => w.id === selectedWaiterId)) {
      const mine = waiters.find((w) => w.id === user.id);
      // Prefer the signed-in user — never steal waiters[0] identity (wrong ownership).
      setSelectedWaiterId(mine?.id || user.id);
    }
  }, [user?.id, waiters, selectedWaiterId]);

  useLayoutEffect(() => {
    if (!selectedTableId) {
      setGuestDraft({ guestName: '', guestPhone: '', deliveryAddress: '', pickupLabel: '' });
      setSelectedCustomer(null);
    setActiveOrderId(null);
    setSelectedLineIds([]);
    setOpsMode(null);
    setSambaTicketView('detail');
    partyListLandedForTableRef.current = null;
    tableTicketsRef.current = { tableId: null, tabs: [] };
    splitMovePartyPinRef.current = null;
    return;
    }
    // Fresh table: 2+ or occupied-without-sole-count → party list (no last-ticket flash).
    setGuestDraft({ guestName: '', guestPhone: '', deliveryAddress: '', pickupLabel: '' });
    setSelectedCustomer(null);
    setActiveOrderId(null);
    setSelectedLineIds([]);
    setOpsMode(null);
    const row = ((tablesQuery.data || getCachedRestaurantTables()) as RestaurantTable[]).find(
      (t) => t.id === selectedTableId,
    );
    const floorOpenCount = Number(row?.openCheckCount || 0);
    const occupied = !!row?.status && String(row.status) !== 'FREE';
    const pickView = resolveTablePickView({ floorOpenCount, occupied });
    setSambaTicketView(pickView);
    // Known 2+: lock list so a later 1-count hydrate cannot flash last-touched detail.
    // Occupied with unknown count stays unlocked so 1-ticket tables can still land detail.
    partyListLandedForTableRef.current =
      pickView === 'list' && floorOpenCount > 1 ? selectedTableId : null;
    const journalTabs = deriveRestaurantOpenChecks(getAllEvents(), getAllSyncState())
      .filter((c) => c.tableId === selectedTableId)
      .map((c) => ({
        id: c.orderId,
        orderNumber: c.offlineId,
        totalAmount: String(totalsFromLines(c.lines).totalAmount),
        note: preferUserTicketNote(c.notes),
      }));
    tableTicketsRef.current = {
      tableId: selectedTableId,
      tabs: scrubRestaurantTicketTabs(journalTabs),
    };
  }, [selectedTableId]);

  useEffect(() => {
    if (!selectedTableId || !meta) return;
    setGuestDraft({
      guestName: meta.guestName || '',
      guestPhone: meta.guestPhone || '',
      deliveryAddress: meta.deliveryAddress || '',
      pickupLabel: meta.pickupLabel || '',
    });
    if (meta.waiterId) setSelectedWaiterId(meta.waiterId);
  }, [
    selectedTableId,
    meta?.guestName,
    meta?.guestPhone,
    meta?.deliveryAddress,
    meta?.pickupLabel,
    meta?.waiterId,
    order?.id,
  ]);

  // Sole ticket: bind GET check so menu adds have a target.
  // 2+: do not seed last-touched as the chosen ticket (list is the surface).
  useEffect(() => {
    if (!selectedTableId || activeOrderId || !order?.id) return;
    if (isTempRestaurantId(order.id)) return;
    if (
      ticketTabs.length > 1 ||
      siblingChecks.length > 1 ||
      Number(selectedTable?.openCheckCount || 0) > 1
    ) {
      return;
    }
    const fromKey = ['restaurant', 'check', selectedTableId, null, isOnline] as const;
    const toKey = ['restaurant', 'check', selectedTableId, order.id, isOnline] as const;
    const cached = queryClient.getQueryData(fromKey) as CheckUiPayload | undefined;
    if (cached) {
      queryClient.setQueryData(toKey, cached);
    }
    setActiveOrderId(order.id);
  }, [
    selectedTableId,
    activeOrderId,
    order?.id,
    isOnline,
    queryClient,
    ticketTabs.length,
    siblingChecks.length,
    selectedTable?.openCheckCount,
  ]);

  useEffect(() => {
    setSelectedLineIds([]);
  }, [order?.id]);

  const invalidateCheck = () => {
    void queryClient.invalidateQueries({ queryKey: ['restaurant', 'check', selectedTableId] });
    void queryClient.invalidateQueries({ queryKey: ['restaurant', 'tables'] });
  };

  const invalidateMenuStock = () => {
    void queryClient.invalidateQueries({ queryKey: ['restaurant', 'menu', 'products'] });
  };

  const handleWaiterChange = (waiterId: string) => {
    setSelectedWaiterId(waiterId);
    if (!order) return;

    if (preferLocalRestaurantWrites(order.id)) {
      const events = getAllEvents();
      const syncState = getAllSyncState();
      const derived = selectedTableId
        ? deriveRestaurantCheckForTable(selectedTableId, events, syncState, order.id)
        : null;
      if (!derived) {
        toast.error('Open a check offline before assigning a waiter');
        return;
      }
      const waiter = waiters.find((w) => w.id === waiterId);
      if (!waiterId || !waiter) {
        toast.error('Select a waiter');
        return;
      }
      try {
        assignRestaurantWaiterOffline(derived, { id: waiter.id, fullName: waiter.fullName });
        paintJournalCheck(selectedTableId, order.id);
        toast.success(
          isOnline ? 'Waiter assigned (will sync)' : 'Waiter assigned (offline — will sync)',
        );
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Waiter assign failed');
      }
      return;
    }

    if (waiterId && waiterId !== meta?.waiterId) {
      assignWaiterMutation.mutate(waiterId);
    }
  };

  const returnToFloor = () => {
    setSelectedTableId(null);
    setMenuSearch('');
    setSelectedCategoryId(null);
    setMobileSheet(null);
    setOpsMode(null);
    setSelectedLineIds([]);
    setBusy(false);
  };

  /** After pay/cancel/void: close journal seed, free floor cache, refresh KDS/tables. */
  const settleCheckOnFloor = (
    orderId: string,
    tableId: string | null,
    kind: 'PAID' | 'CANCELLED',
    opts?: { reason?: string },
  ) => {
    markRestaurantCheckSettledInJournal(orderId, kind, opts);
    if (tableId) {
      clearRestaurantBillRequestedOffline(tableId, orderId);
      if (tableTicketsRef.current.tableId === tableId) {
        tableTicketsRef.current = {
          tableId,
          tabs: scrubRestaurantTicketTabs(tableTicketsRef.current.tabs).filter(
            (t) => t.id !== orderId,
          ),
        };
      }
      // Only free the floor tile when no other open journal check remains on that table.
      const stillOpen = deriveRestaurantOpenChecks(getAllEvents(), getAllSyncState()).some(
        (c) => c.tableId === tableId && c.orderId !== orderId,
      );
      if (!stillOpen) {
        paintRestaurantTableFreeOffline(tableId);
        queryClient.setQueryData(
          restaurantTablesQueryKey(user?.id, isOnline),
          (prev: RestaurantTable[] | undefined) =>
            (prev || []).map((t) =>
              t.id === tableId
                ? {
                    ...t,
                    status: 'FREE' as const,
                    currentOrderId: null,
                    orderNumber: null,
                    orderTotal: null,
                    openCheckCount: 0,
                    openChecksTotal: null,
                    guestName: null,
                  }
                : t,
            ),
        );
      }
    }
    bumpJournal();
    void queryClient.invalidateQueries({ queryKey: ['restaurant', 'tables'] });
    void queryClient.invalidateQueries({ queryKey: ['restaurant', 'kitchen'] });
    void queryClient.invalidateQueries({ queryKey: ['restaurant', 'check'] });
  };

  /**
   * Fire unsent lines to kitchen + best-effort KOT print.
   * Kitchen commit is awaited (SSOT). Print delivery is background by default so
   * the steward is never blocked on Get-Printer / PDF / spooler.
   * Does not return to floor. Returns how many tickets were produced.
   */
  const fireUnsentKotTickets = async (opts?: {
    /** When false (default), POST /print accept runs in background after kitchen commit. */
    awaitPrint?: boolean;
  }): Promise<{ kotCount: number; printFailures: number }> => {
    if (!order) return { kotCount: 0, printFailures: 0 };
    const unsentLines = orderLines.filter((l) => !l.kitchenSentAt);
    const unsentCount = unsentLines.length;
    if (unsentCount === 0) return { kotCount: 0, printFailures: 0 };

    const remainingByProductId = new Map<string, number | null | undefined>();
    for (const p of productsQuery.data || []) {
      remainingByProductId.set(p.id, p.remainingQuantity);
    }
    const kotWarns = restaurantFohStockWarnForLines({
      allowOversell,
      stage: 'kot',
      lines: unsentLines.map((l) => {
        const menu = (productsQuery.data || []).find((p) => p.id === l.productId);
        return {
          productId: l.productId || '',
          productName: l.productName,
          productType: menu?.productType,
          quantity: Number(l.quantity) || 0,
        };
      }),
      remainingByProductId,
    });
    if (kotWarns.length > 0) {
      toast(kotWarns[0], { id: 'foh-stock-warn-kot', duration: 7000, icon: '⚠️' });
    }

    // Integrity: await spool confirm (ESC/POS is near-instant) so toast matches paper.
    const awaitPrint = opts?.awaitPrint !== false;

    const deliverJobs = async (
      jobs: ClientPrintJob[],
      deliverOpts?: { awaitStatusSync?: boolean },
    ): Promise<number> => {
      const dispatched = await dispatchPrintJobs(jobs, {
        branding: guestBillDispatchBranding,
        awaitStatusSync: deliverOpts?.awaitStatusSync,
      });
      return dispatched.failures;
    };

    const useLocalKot = shouldUseLocalRestaurantMutation(isOnline, order.id);
    if (useLocalKot) {
      const events = getAllEvents();
      const syncState = getAllSyncState();
      const derived = selectedTableId
        ? deriveRestaurantCheckForTable(selectedTableId, events, syncState, order.id)
        : null;
      if (!derived) throw new Error('Offline check not found');
      const { tickets } = fireRestaurantKotOffline(derived);
      paintJournalCheck(selectedTableId, derived.orderId);
      invalidateMenuStock();

      const offlineJobs: ClientPrintJob[] = tickets.map((kot) =>
        enqueueOfflinePrintJob({
          documentType: 'KOT',
          targetPrinter: kot.printerName,
          stationCode: kot.stationCode,
          payloadJson: {
            kotNumber: kot.kotOfflineId,
            station: kot.station,
            stationCode: kot.stationCode,
            tableLabel: derived.tableName || derived.tableCode || selectedTable?.name || 'Table',
            sentByName: user?.fullName || user?.email || null,
            stewardName: user?.fullName || user?.email || derived.waiterName || null,
            serverName:
              derived.waiterName &&
              derived.waiterName !== (user?.fullName || user?.email)
                ? derived.waiterName
                : null,
            waiterName: user?.fullName || user?.email || derived.waiterName || null,
            firedAt: new Date().toISOString(),
            ticketKind: 'FIRE',
            orderChannel: derived.channel,
            guestName: derived.guestName,
            guestPhone: derived.guestPhone,
            deliveryAddress: derived.deliveryAddress,
            pickupLabel: derived.pickupLabel,
            items: kot.lines.map((it) => ({
              productName: it.productName,
              quantity: it.quantity,
              lineNotes: it.lineNotes ?? null,
            })),
          },
        }),
      );

      if (awaitPrint) {
        const printFailures = await deliverJobs(offlineJobs, { awaitStatusSync: true });
        publishLanKdsBoardChanged('KOT_FIRED_OFFLINE');
        return { kotCount: tickets.length, printFailures };
      }

      void deliverJobs(offlineJobs).then((printFailures) => {
        if (printFailures > 0) {
          toast.error(kotPrintPartialSuccessMessage(tickets.length, printFailures), {
            duration: 7000,
            id: 'kot-print-bg-fail',
          });
        }
      });
      publishLanKdsBoardChanged('KOT_FIRED_OFFLINE');
      return { kotCount: tickets.length, printFailures: 0 };
    }

    const serverKotOrderId = toServerRestaurantOrderId(
      resolveKotFireOrderId({
        activeOrderId,
        paintedOrderId: order.id,
      }),
    );
    if (!serverKotOrderId) {
      throw new Error('Ticket is still saving — try KOT again');
    }
    const leavingAfterKot = resolveKotSessionLeave({
      ticketCount: ticketTabs.length,
      partyListVisible: showSambaTicketList,
    });
    const refreshSelectedTicketAfterKot = async () => {
      if (!selectedTableId || leavingAfterKot) return;
      try {
        await queryClient.cancelQueries({ queryKey: ['restaurant', 'check', selectedTableId] });
        const checkRes = await api.restaurant.getTableCheck(selectedTableId, {
          orderId: serverKotOrderId,
        });
        paintServerCheckWithInFlight(
          selectedTableId,
          checkRes.data.data as CheckUiPayload,
          serverKotOrderId,
        );
        setActiveOrderId(serverKotOrderId);
      } catch {
        /* kitchen already committed — do not fail Close/KOT */
      }
    };
    const res = await api.restaurant.sendKot(serverKotOrderId);
    invalidateMenuStock();
    const payload = res.data.data as
      | { kots?: unknown[]; printJobs?: ClientPrintJob[] }
      | unknown[];
    // Backward-compatible: older servers returned a bare KOT array.
    const legacyArray = Array.isArray(payload);
    const kots = (legacyArray ? payload : payload?.kots || []) as Array<{
      kotNumber: string;
      station: string;
      printerName?: string | null;
      tableCode: string | null;
      tableName: string | null;
      waiterName: string | null;
      firedByName?: string | null;
      serverName?: string | null;
      firedAt: string;
      orderChannel?: string | null;
      guestName?: string | null;
      guestPhone?: string | null;
      deliveryAddress?: string | null;
      pickupLabel?: string | null;
      items: Array<{ productName: string; quantity: string; lineNotes: string | null }>;
    }>;
    const printJobs = (!legacyArray ? payload?.printJobs : undefined) as
      | ClientPrintJob[]
      | undefined;

    if (kots.length === 0 && !(printJobs?.length)) {
      await refreshSelectedTicketAfterKot();
      return { kotCount: 0, printFailures: 0 };
    }

    const kotCount = Math.max(kots.length, printJobs?.length || 0);

    const runLegacyPrint = async (): Promise<number> => {
      let printFailures = 0;
      await Promise.all(
        kots.map(async (kot) => {
          try {
            await printKitchenTicket({
              kotNumber: kot.kotNumber,
              station: kot.station,
              printerName: kot.printerName,
              tableLabel: kot.tableName || kot.tableCode || selectedTable?.name || 'Table',
              sentByName: kot.firedByName || kot.waiterName || user?.fullName || user?.email || null,
              serverName: kot.serverName || null,
              waiterName: kot.firedByName || kot.waiterName,
              firedAt: new Date(kot.firedAt).toLocaleString(),
              orderChannel: meta?.orderChannel || kot.orderChannel,
              guestName: meta?.guestName || kot.guestName,
              guestPhone: meta?.guestPhone || kot.guestPhone,
              deliveryAddress: meta?.deliveryAddress || kot.deliveryAddress,
              pickupLabel: meta?.pickupLabel || kot.pickupLabel,
              companyName: companyBranding.companyName,
              companyAddress: companyBranding.companyAddress,
              companyPhone: companyBranding.companyPhone,
              items: kot.items.map((it) => ({
                productName: it.productName,
                quantity: Number(it.quantity),
                lineNotes: it.lineNotes,
              })),
            });
          } catch {
            printFailures += 1;
          }
        }),
      );
      return printFailures;
    };

    if (awaitPrint) {
      let printFailures = 0;
      if (printJobs && printJobs.length > 0) {
        printFailures = await deliverJobs(printJobs, { awaitStatusSync: true });
      } else {
        printFailures = await runLegacyPrint();
      }
      publishLanKdsBoardChanged('KOT_FIRED_ONLINE');
      await refreshSelectedTicketAfterKot();
      void queryClient.invalidateQueries({ queryKey: ['restaurant', 'tables'] });
      void queryClient.invalidateQueries({ queryKey: ['restaurant', 'kitchen'] });
      return { kotCount, printFailures };
    }

    // Explicit awaitPrint:false — rare; background delivery with honest failure toast.
    void (printJobs && printJobs.length > 0 ? deliverJobs(printJobs) : runLegacyPrint()).then(
      (printFailures) => {
        if (printFailures > 0) {
          toast.error(kotPrintPartialSuccessMessage(kotCount, printFailures), {
            duration: 7000,
            id: 'kot-print-bg-fail',
          });
        }
      },
    );
    publishLanKdsBoardChanged('KOT_FIRED_ONLINE');
    await refreshSelectedTicketAfterKot();
    void queryClient.invalidateQueries({ queryKey: ['restaurant', 'tables'] });
    void queryClient.invalidateQueries({ queryKey: ['restaurant', 'kitchen'] });
    return { kotCount, printFailures: 0 };
  };

  /**
   * KOT / party-list Close: fire unsent lines for the selected ticket.
   * Multi-ticket: waiter logout (shared FOH) then back to tables — same as before.
   * Sole ticket: stay on the ticket with sent lines (unless waiter auto-logout).
   */
  const handleSendKot = async () => {
    if (!order) return;
    if (!canOrder) {
      toast.error('You need restaurant.order permission to send KOT');
      return;
    }
    const fireOrderId = resolveKotFireOrderId({
      activeOrderId,
      paintedOrderId: order.id,
    });
    if (!fireOrderId) return;
    const leaveAfterKot = resolveKotSessionLeave({
      ticketCount: ticketTabs.length,
      partyListVisible: showSambaTicketList,
    });
    const kotFinish = resolveKotSessionFinish({
      ticketCount: ticketTabs.length,
      partyListVisible: showSambaTicketList,
      waiterShouldLogout: decideRestaurantFohAutoLogout({
        kind: 'kot',
        role: user?.role,
        permissions,
      }),
    });
    const finishKotSession = () => {
      if (kotFinish === 'logout' && maybeAutoLogoutAfterPrint('kot')) return;
      if (kotFinish === 'floor' || leaveAfterKot) returnToFloor();
    };
    setBusy(true);
    try {
      const unsentCount = orderLines.filter((l) => !l.kitchenSentAt).length;
      if (unsentCount === 0) {
        toast.success(
          leaveAfterKot ? 'Already sent to kitchen — back to tables' : 'Already sent to kitchen',
        );
        finishKotSession();
        return;
      }

      const { kotCount, printFailures } = await fireUnsentKotTickets({
        awaitPrint: true,
      });
      if (kotCount === 0) {
        toast.success(
          leaveAfterKot ? 'Already sent to kitchen — back to tables' : 'Already sent to kitchen',
        );
        finishKotSession();
        return;
      }

      if (printFailures === 0) {
        toast.success(
          shouldUseLocalRestaurantMutation(isOnline, order.id)
            ? isOnline
              ? 'KOT sent (local — will sync)'
              : 'KOT sent (offline — will sync)'
            : `Sent ${kotCount} KOT ticket(s)`,
        );
      } else {
        toast.error(kotPrintPartialSuccessMessage(kotCount, printFailures), {
          duration: 7000,
        });
      }
      finishKotSession();
    } catch (err) {
      toastApiError(err, 'KOT failed');
    } finally {
      setBusy(false);
    }
  };

  /**
   * Bill = send any unsent KOT first, then mark this *selected* check billed + print.
   * Multi-ticket tables: only the active ticket is billed; stay on table if siblings remain.
   */
  const handleBill = async () => {
    if (!order) return;
    if (!canOrder) {
      toast.error('You need restaurant.order permission to print a bill');
      return;
    }
    if (orderLines.length === 0) {
      toast.error('Cannot bill an empty check');
      return;
    }
    const billedOrderId = order.id;
    const billedOrderNumber = order.orderNumber;
    const openIds = openTicketIdsForTable(selectedTableId, checkQuery.data);
    const remainingTickets = ticketTabs.filter(
      (t) =>
        t.id !== billedOrderId &&
        (openIds.size === 0 || openIds.has(t.id) || isJournalLocalOrderId(t.id)),
    );
    setBusy(true);
    try {
      const unsentCount = orderLines.filter((l) => !l.kitchenSentAt).length;
      let kotFired = 0;
      let kotPrintFailures = 0;
      if (unsentCount > 0) {
        // Decide logout before fire so KOT print awaits PRINTED (same race fix as KOT-only path).
        const willAwaitKotPrint =
          decideRestaurantFohAutoLogout({
            kind: 'bill',
            role: user?.role,
            permissions,
          }) ||
          decideRestaurantFohAutoLogout({
            kind: 'kot',
            role: user?.role,
            permissions,
          });
        const kotResult = await fireUnsentKotTickets({
          awaitPrint: willAwaitKotPrint,
        });
        kotFired = kotResult.kotCount;
        kotPrintFailures = kotResult.printFailures;
      }

      // Refresh line totals for bill print after KOT (journal may have updated).
      const events = getAllEvents();
      const syncState = getAllSyncState();
      const derivedAfterKot =
        selectedTableId && shouldUseLocalRestaurantMutation(isOnline, order.id)
          ? deriveRestaurantCheckForTable(selectedTableId, events, syncState, order.id)
          : null;
      const billLines = derivedAfterKot
        ? derivedAfterKot.lines.map((it) => ({
            productId: it.productId,
            productName: it.productName,
            quantity: Number(it.quantity),
            unitPrice: Number(it.unitPrice),
            lineTotal: Number(it.subtotal),
            lineNotes: it.lineNotes ?? null,
          }))
        : orderLines.map((it) => ({
            productId: it.productId,
            productName: it.productName,
            quantity: Number(it.quantity),
            unitPrice: Number(it.unitPrice),
            lineTotal: Number(it.lineTotal),
            lineNotes: it.lineNotes ?? null,
          }));
      const billTotals = derivedAfterKot
        ? totalsFromLines(derivedAfterKot.lines)
        : {
            subtotal: Number(order.subtotal),
            discountAmount: Number(order.discountAmount),
            taxAmount: Number(order.taxAmount),
            totalAmount: Number(order.totalAmount),
          };

      let guestBillPrinterName: string | null = readCachedGuestBillPrinter();
      try {
        const printerRes = await api.restaurant.getGuestBillPrinter();
        const data = printerRes.data.data as
          | { printerName?: string | null; resolvedPrinterName?: string | null }
          | undefined;
        guestBillPrinterName =
          data?.resolvedPrinterName?.trim() ||
          data?.printerName?.trim() ||
          guestBillPrinterName;
        writeCachedGuestBillPrinter(guestBillPrinterName);
      } catch {
        // offline — use last known guest bill printer
      }

      const billPayload = {
        orderNumber: derivedAfterKot?.offlineId || order.orderNumber,
        tableLabel: meta?.tableName || meta?.tableCode || selectedTable?.name || 'Table',
        waiterName: meta?.waiterName || derivedAfterKot?.waiterName || null,
        printedAt: new Date().toLocaleString(undefined, {
          year: 'numeric',
          month: 'short',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        }),
        currencySymbol: config.currency?.symbol,
        orderChannel: meta?.orderChannel || derivedAfterKot?.channel,
        guestName: meta?.guestName || derivedAfterKot?.guestName,
        guestPhone: meta?.guestPhone || derivedAfterKot?.guestPhone,
        deliveryAddress: meta?.deliveryAddress || derivedAfterKot?.deliveryAddress,
        pickupLabel: meta?.pickupLabel || derivedAfterKot?.pickupLabel,
        companyName: companyBranding.companyName,
        companyAddress: companyBranding.companyAddress,
        companyPhone: companyBranding.companyPhone,
        ...guestBillInvoiceFields,
        printerName: guestBillPrinterName,
        items: billLines,
        subtotal: Number(billTotals.subtotal),
        discountAmount: Number(
          'discountAmount' in billTotals ? billTotals.discountAmount : order.discountAmount,
        ),
        taxAmount: Number(billTotals.taxAmount),
        taxName,
        totalAmount: Number(billTotals.totalAmount),
      };

      const kotPart =
        kotFired > 0
          ? kotPrintFailures === 0
            ? 'KOT sent · '
            : 'KOT sent (print issue) · '
          : '';
      const billLabel =
        remainingTickets.length > 0
          ? `Bill printed for ${billedOrderNumber}`
          : 'Bill printed — table marked billed';

      const finishAfterBill = async (printOk: boolean) => {
        if (selectedTableId) {
          markRestaurantBillRequestedOffline(selectedTableId, billedOrderId);
          paintJournalCheck(selectedTableId, billedOrderId);
        }
        toast.success(
          printOk
            ? `${kotPart}${billLabel}`
            : `${kotPart}Bill marked for ${billedOrderNumber} (print unavailable)`,
          { duration: printOk ? 3000 : 5000 },
        );
        clearLineSelection();

        // Bill commanded (server/offline mark): rotate waiter even if local printer failed.
        if (maybeAutoLogoutAfterPrint('bill')) return;

        // If bill also fired KOT and user isn't a waiter, still apply KOT logout rule.
        if (kotFired > 0 && maybeAutoLogoutAfterPrint('kot')) return;

        // Multi-ticket: stay on table and switch to another open order.
        if (remainingTickets.length > 0) {
          await activateSibling(remainingTickets[0].id);
          setBusy(false);
          return;
        }
        returnToFloor();
      };

      if (shouldUseLocalRestaurantMutation(isOnline, order.id)) {
        // Bill commit (offline mark) unlocks steward; paper is best-effort background.
        void printRestaurantBill(billPayload).catch(() => {
          toast.error('Bill marked (print unavailable)', {
            duration: 5000,
            id: 'bill-print-bg-fail',
          });
        });
        await finishAfterBill(true);
        return;
      }

      const res = await api.restaurant.requestBill(order.id);
      const bill = res.data.data as {
        order: OrderDetail;
        meta: CheckMeta;
        printJobs?: ClientPrintJob[];
      };
      void queryClient.invalidateQueries({ queryKey: ['restaurant', 'tables'] });
      invalidateCheck();

      // When FOH auto-logout will navigate away, await PRINTED so re-login cannot re-paper.
      const willAutoLogoutBill =
        decideRestaurantFohAutoLogout({
          kind: 'bill',
          role: user?.role,
          permissions,
        }) ||
        (kotFired > 0 &&
          decideRestaurantFohAutoLogout({
            kind: 'kot',
            role: user?.role,
            permissions,
          }));

      if (bill.printJobs && bill.printJobs.length > 0) {
        const jobs = bill.printJobs.map((j) => ({
          ...j,
          targetPrinter: j.targetPrinter || guestBillPrinterName,
          payloadJson: {
            ...j.payloadJson,
            taxName,
            printedAt: new Date().toLocaleString(undefined, {
              year: 'numeric',
              month: 'short',
              day: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
            }),
            currencySymbol: config.currency?.symbol,
          },
        }));
        // Await spool confirm (ESC/POS is fast) so toast matches paper.
        const dispatched = await dispatchPrintJobs(jobs, {
          branding: guestBillDispatchBranding,
          awaitStatusSync: willAutoLogoutBill,
        });
        if (dispatched.failures > 0) {
          toast.error('Bill marked (print unavailable — check guest-bill printer)', {
            duration: 7000,
            id: 'bill-print-bg-fail',
          });
        } else if (dispatched.delivered > 0) {
          toast.success('Bill printed', { id: 'bill-print-ok' });
        }
      } else if (willAutoLogoutBill) {
        try {
          await printRestaurantBill({
            orderNumber: bill.order.orderNumber,
            tableLabel: selectedTable?.name || selectedTable?.code || 'Table',
            waiterName: user?.fullName || user?.email || null,
            printedAt: new Date().toLocaleString(),
            taxName,
            currencySymbol: config.currency?.symbol,
            printerName: guestBillPrinterName,
            companyName: companyBranding.companyName,
            companyAddress: companyBranding.companyAddress,
            companyPhone: companyBranding.companyPhone,
            ...guestBillInvoiceFields,
            items: billLines,
            subtotal: Number(billTotals.subtotal),
            discountAmount: Number(
              'discountAmount' in billTotals ? billTotals.discountAmount : order.discountAmount,
            ),
            taxAmount: Number(billTotals.taxAmount),
            totalAmount: Number(billTotals.totalAmount),
          });
        } catch {
          toast.error('Bill marked (print unavailable)', {
            duration: 5000,
            id: 'bill-print-bg-fail',
          });
        }
      } else {
        void printRestaurantBill({
          orderNumber: bill.order.orderNumber,
          tableLabel: bill.meta.tableName || bill.meta.tableCode || selectedTable?.name || 'Table',
          waiterName: bill.meta.waiterName,
          printedAt: new Date().toLocaleString(undefined, {
            year: 'numeric',
            month: 'short',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          }),
          currencySymbol: config.currency?.symbol,
          orderChannel: bill.meta.orderChannel,
          guestName: bill.meta.guestName,
          guestPhone: bill.meta.guestPhone,
          deliveryAddress: bill.meta.deliveryAddress,
          pickupLabel: bill.meta.pickupLabel,
          companyName: companyBranding.companyName,
          companyAddress: companyBranding.companyAddress,
          companyPhone: companyBranding.companyPhone,
          ...guestBillInvoiceFields,
          printerName: guestBillPrinterName,
          items: (bill.order.items || []).map((it) => ({
            productId: it.productId,
            productName: it.productName,
            quantity: Number(it.quantity),
            unitPrice: Number(it.unitPrice),
            lineTotal: Number(it.lineTotal),
            lineNotes: it.lineNotes ?? null,
          })),
          subtotal: Number(bill.order.subtotal),
          discountAmount: Number(bill.order.discountAmount),
          taxAmount: Number(bill.order.taxAmount),
          taxName,
          totalAmount: Number(bill.order.totalAmount),
        }).catch(() => {
          toast.error('Bill marked (print unavailable)', {
            duration: 5000,
            id: 'bill-print-bg-fail',
          });
        });
      }

      await finishAfterBill(true);
    } catch (err) {
      toastApiError(err, 'Bill failed');
      setBusy(false);
    }
  };

  /**
   * Samba/Toast: pick a ticket from the party list → order on that ticket.
   * Always returns to the menu for adding (sheet); ticket board opens from dock when needed.
   */
  const openTicketFromList = (orderId: string) => {
    if (!selectedTableId || isTempRestaurantId(orderId)) return;
    setSelectedLineIds([]);
    setLoadingTicketId(orderId);
    // Paint this ticket into cache first, then flip to detail — one render, no
    // last-touched flash and no blank board while the query key changes.
    if (chrome.fohTicketPane === 'sheet') setMobileSheet(null);
    activateSibling(orderId, { fromPartyList: true });
    setSambaTicketView('detail');
  };

  /** Return to party list (multi-ticket) so user can switch tickets. */
  const backToPartyTicketList = () => {
    setSambaTicketView('list');
    setSelectedLineIds([]);
    if (chrome.fohTicketPane === 'sheet') setMobileSheet('order');
  };

  /**
   * Select a ticket on this table — load its lines via GET (floor pointer best-effort).
   * Menu adds always target the selected ticket (activeOrderId + addItems orderId).
   */
  const activateSibling = (
    orderId: string,
    opts?: { fromPartyList?: boolean },
  ) => {
    if (!selectedTableId) return;
    if (orderId === order?.id && orderId === activeOrderId && !loadingTicketId) {
      // Re-tap active ticket: refocus list + load authority.
      ticketLinesRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    }
    if (isTempRestaurantId(orderId)) return;

    const openIds = openTicketIdsForTable(selectedTableId, checkQuery.data);
    // Party strip is SSOT for multi-ticket open — do not treat strip tickets as ghosts.
    const onPartyStrip =
      opts?.fromPartyList ||
      ticketTabs.some((t) => t.id === orderId) ||
      tableTicketsRef.current.tabs.some((t) => t.id === orderId);
    if (
      !opts?.fromPartyList &&
      !onPartyStrip &&
      !isJournalLocalOrderId(orderId) &&
      openIds.size > 0 &&
      !openIds.has(orderId)
    ) {
      tableTicketsRef.current = {
        tableId: selectedTableId,
        tabs: scrubRestaurantTicketTabs(tableTicketsRef.current.tabs).filter(
          (t) => t.id !== orderId,
        ),
      };
      bumpJournal();
      return;
    }

    setSelectedLineIds([]);
    setLoadingTicketId(orderId);

    const cachedTable =
      getCachedRestaurantTables().find((t) => t.id === selectedTableId) ||
      tablesQuery.data?.find((t) => t.id === selectedTableId);
    // Only keep tabs the last payload still considers open (+ the one just tapped).
    let knownTabs = scrubRestaurantTicketTabs(tableTicketsRef.current.tabs).filter(
      (t) =>
        t.id === orderId ||
        isJournalLocalOrderId(t.id) ||
        openIds.size === 0 ||
        openIds.has(t.id) ||
        (opts?.fromPartyList && ticketTabs.some((x) => x.id === t.id)),
    );
    // Always include the ticket being opened (party list SSOT).
    if (!knownTabs.some((t) => t.id === orderId)) {
      const fromStrip = ticketTabs.find((t) => t.id === orderId);
      if (fromStrip) knownTabs = [...knownTabs, fromStrip];
      else
        knownTabs = [
          ...knownTabs,
          { id: orderId, orderNumber: '…', totalAmount: '0' },
        ];
    }
    tableTicketsRef.current = { tableId: selectedTableId, tabs: knownTabs };
    const tabMeta =
      knownTabs.find((t) => t.id === orderId) ||
      ticketTabs.find((t) => t.id === orderId);
    const fromJournal = buildCheckUiFromJournal(selectedTableId, orderId, cachedTable);
    // Never paint another ticket's lines under this selection (journal preferred miss).
    const journalOk =
      !!fromJournal.order && fromJournal.order.id === orderId ? fromJournal : null;
    const fromCache = queryClient.getQueryData([
      'restaurant',
      'check',
      selectedTableId,
      orderId,
      isOnline,
    ]) as CheckUiPayload | undefined;
    const cacheOk =
      !!fromCache?.order && fromCache.order.id === orderId ? fromCache : null;

    const shell: CheckUiPayload = {
      table: (cachedTable ||
        checkQuery.data?.table || { id: selectedTableId }) as RestaurantTable,
      order: {
        id: orderId,
        orderNumber: tabMeta?.orderNumber || cacheOk?.order?.orderNumber || '…',
        status: 'PENDING',
        // Empty until authority arrives — do not copy previous ticket's lines.
        items: cacheOk?.order?.items || journalOk?.order?.items || [],
        subtotal: String(cacheOk?.order?.subtotal ?? 0),
        discountAmount: String(cacheOk?.order?.discountAmount ?? 0),
        taxAmount: String(cacheOk?.order?.taxAmount ?? 0),
        totalAmount: String(
          cacheOk?.order?.totalAmount ?? tabMeta?.totalAmount ?? 0,
        ),
        notes: cacheOk?.order?.notes ?? journalOk?.order?.notes ?? null,
        customerId: cacheOk?.order?.customerId ?? null,
      },
      meta: cacheOk?.meta || journalOk?.meta || null,
      siblingChecks: knownTabs.map((t) => ({
        id: t.id,
        orderNumber: t.orderNumber,
        totalAmount: t.totalAmount,
        createdAt: new Date().toISOString(),
        notes: t.note ?? null,
      })),
    };

    const instant = attachSiblingTabs(
      journalOk || cacheOk || shell,
      knownTabs,
      selectedTableId,
    );
    // Final belt: if painted order id drifted, force shell for this orderId.
    const paint =
      instant.order?.id === orderId
        ? instant
        : attachSiblingTabs(shell, knownTabs, selectedTableId);

    queryClient.setQueryData(
      ['restaurant', 'check', selectedTableId, orderId, isOnline],
      paint,
    );
    setActiveOrderId(orderId);
    activeOrderIdRef.current = orderId;
    requestAnimationFrame(() => {
      ticketLinesRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    });

    if (!isOnline || isJournalLocalOrderId(orderId)) {
      setLoadingTicketId(null);
      bumpJournal();
      return;
    }

    const serverOrderId = toServerRestaurantOrderId(orderId);
    if (!serverOrderId) {
      setLoadingTicketId(null);
      bumpJournal();
      return;
    }

    void (async () => {
      const silentCfg = { silentErrorToast: true, silentForbidden: true } as const;
      try {
        // Load selected ticket lines first (GET). Pointer update is best-effort —
        // never toast "wrong table" / Invalid request on a switch (Toast/Samba pattern).
        let data: CheckUiPayload | null = null;
        try {
          const getRes = await api.restaurant.getTableCheck(
            selectedTableId,
            { orderId: serverOrderId },
            silentCfg,
          );
          const got = getRes.data.data as CheckUiPayload;
          if (got.order?.id === serverOrderId || got.order?.id === orderId) {
            data = got;
          } else {
            // Authority said this id is not an open check here — use returned party strip.
            const alive = ticketTabsFromPayload(got);
            tableTicketsRef.current = { tableId: selectedTableId, tabs: alive };
            if (got.order?.id) {
              data = got;
              setActiveOrderId(got.order.id);
              activeOrderIdRef.current = got.order.id;
            } else if (alive[0]) {
              setActiveOrderId(alive[0].id);
              activeOrderIdRef.current = alive[0].id;
              try {
                const r2 = await api.restaurant.getTableCheck(
                  selectedTableId,
                  { orderId: alive[0].id },
                  silentCfg,
                );
                data = r2.data.data as CheckUiPayload;
              } catch {
                data = got;
              }
            } else {
              data = got;
            }
          }
        } catch {
          data = null;
        }

        // Best-effort floor pointer; ignore membership errors (GET is SSOT for display).
        if (data?.order?.id && isServerOrderUuid(data.order.id)) {
          void api.restaurant
            .activateCheck(
              selectedTableId,
              { orderId: data.order.id },
              silentCfg,
            )
            .catch(() => undefined);
        }

        if (!data) {
          tableTicketsRef.current = {
            tableId: selectedTableId,
            tabs: scrubRestaurantTicketTabs(tableTicketsRef.current.tabs).filter(
              (t) => t.id !== orderId,
            ),
          };
          bumpJournal();
          void queryClient.invalidateQueries({
            queryKey: ['restaurant', 'check', selectedTableId],
          });
          return;
        }

        const paintOrderId = data.order?.id || orderId;
        const clamped = checkUiAfterServerSeed(selectedTableId, data);
        if (tableTicketsRef.current.tableId !== selectedTableId) return;
        // Drop result if user already switched away from this request target
        // (or from an id we auto-selected after fallthrough).
        if (
          activeOrderIdRef.current !== orderId &&
          activeOrderIdRef.current !== paintOrderId
        ) {
          return;
        }
        const liveTabs = ticketTabsFromPayload(clamped);
        tableTicketsRef.current = {
          tableId: selectedTableId,
          tabs: liveTabs.length
            ? liveTabs
            : scrubRestaurantTicketTabs(tableTicketsRef.current.tabs).filter(
                (t) => t.id !== orderId || t.id === paintOrderId,
              ),
        };
        queryClient.setQueryData(
          ['restaurant', 'check', selectedTableId, paintOrderId, isOnline],
          attachSiblingTabs(
            clamped,
            tableTicketsRef.current.tabs,
            selectedTableId,
          ),
        );
        if (paintOrderId !== activeOrderIdRef.current) {
          setActiveOrderId(paintOrderId);
          activeOrderIdRef.current = paintOrderId;
        }
        bumpJournal();
      } catch (err) {
        if (activeOrderIdRef.current !== orderId) return;
        // Only unexpected errors (GET already silent for membership).
        toastApiError(err, 'Failed to open ticket');
      } finally {
        setLoadingTicketId((cur) => (cur === orderId ? null : cur));
      }
    })();
  };

  const openTicketNoteEditor = () => {
    if (!order?.id) {
      toast.error('Open or select a ticket first');
      return;
    }
    setNoteDraft(ticketNote);
    setMobileSheet('note');
  };

  const returnToTicketSheet = () => {
    setMobileSheet(useSheetTicket ? 'order' : null);
  };

  const paintTicketNoteNow = (orderId: string, notes: string | null) => {
    if (!selectedTableId) return;
    const cached = queryClient.getQueryData([
      'restaurant',
      'check',
      selectedTableId,
      orderId,
      isOnline,
    ]) as CheckUiPayload | undefined;
    const base = cached || checkQuery.data;
    if (!base) return;
    const painted = applyTicketNoteToCheck(base, orderId, notes);
    if (!painted) return;
    const tabs = applyTicketNoteToTabs(
      tableTicketsRef.current.tableId === selectedTableId
        ? tableTicketsRef.current.tabs
        : ticketTabs,
      orderId,
      notes,
    );
    tableTicketsRef.current = { tableId: selectedTableId, tabs };
    const withTabs = attachSiblingTabs(painted, tabs, selectedTableId);
    checkPaintGenRef.current += 1;
    void queryClient.cancelQueries({ queryKey: ['restaurant', 'check', selectedTableId] });
    for (const id of restaurantCheckQueryPaintIds({
      paintedOrderId: orderId,
      targetOrderId: orderId,
      displayedOrderId: activeOrderId,
    })) {
      queryClient.setQueryData(['restaurant', 'check', selectedTableId, id, isOnline], withTabs);
    }
  };

  const saveTicketNote = async () => {
    if (!order?.id || !selectedTableId) return;
    if (!canOrder) {
      toast.error('You need restaurant.order permission to edit notes');
      return;
    }
    const orderId = order.id;
    const next = noteDraft.trim().slice(0, 2000) || null;
    paintTicketNoteNow(orderId, next);
    returnToTicketSheet();
    toast.success(next ? 'Note saved on ticket' : 'Note cleared');
    setNoteSaving(true);
    try {
      if (preferLocalRestaurantWrites(orderId) || !isOnline) {
        const derived = deriveRestaurantCheckForTable(
          selectedTableId,
          getAllEvents(),
          getAllSyncState(),
          orderId,
        );
        if (derived) updateRestaurantCheckNotesOffline(derived, next);
        bumpJournal();
        return;
      }
      const res = await api.restaurant.updateCheckNotes(orderId, {
        notes: next,
      });
      const payload = res.data.data as {
        order?: CheckUiPayload['order'];
        meta?: CheckUiPayload['meta'];
      };
      const confirmed = next === null ? null : preferUserTicketNote(payload.order?.notes, next);
      paintTicketNoteNow(orderId, confirmed);
    } catch (err) {
      toastApiError(err, 'Could not save ticket note');
    } finally {
      setNoteSaving(false);
    }
  };

  /**
   * Samba multi-tab: open empty ticket on this table. Online only.
   * Leaves detail + menu ready immediately — never trap user in party-list
   * or invalidate the check just painted (that forced back/forth).
   */
  const openNewTicketOnTable = async () => {
    if (!selectedTableId || !isOnline) {
      toast.error('New ticket needs online connection', { id: 'open-empty-check-offline' });
      return;
    }
    if (!canOrder) {
      toast.error('You need restaurant.order permission');
      return;
    }
    if (busy) return;
    // Instant: detail mode + MENU on screen (empty ticket must not cover the catalog).
    setSambaTicketView('detail');
    setSelectedLineIds([]);
    if (chrome.fohTicketPane === 'sheet') setMobileSheet(null);
    setBusy(true);
    try {
      const res = await api.restaurant.openCheck(selectedTableId, {
        waiterId: selectedWaiterId || user?.id,
        guestName: guestDraft.guestName || null,
        guestPhone: guestDraft.guestPhone || null,
        deliveryAddress: guestDraft.deliveryAddress || null,
        pickupLabel: guestDraft.pickupLabel || null,
      });
      const data = res.data.data as CheckUiPayload;
      const newId = data.order?.id as string | undefined;
      if (!newId) {
        toast.error('Ticket opened but no order id returned');
        return;
      }
      // Keep prior party tabs — openCheck payload may omit siblings (must not wipe strip).
      const knownTabs = scrubRestaurantTicketTabs([
        ...tableTicketsRef.current.tabs,
        ...(data.siblingChecks || []).map((s) => ({
          id: s.id,
          orderNumber: s.orderNumber,
          totalAmount: s.totalAmount,
        })),
        {
          id: newId,
          orderNumber: data.order?.orderNumber || 'NEW',
          totalAmount: String(data.order?.totalAmount ?? 0),
        },
      ]);
      tableTicketsRef.current = { tableId: selectedTableId, tabs: knownTabs };
      const painted = attachSiblingTabs(
        checkUiAfterServerSeed(selectedTableId, data),
        knownTabs,
        selectedTableId,
      );
      // Paint under new ticket key only — do NOT invalidate check (menu target stays live).
      queryClient.setQueryData(
        ['restaurant', 'check', selectedTableId, newId, isOnline],
        painted,
      );
      queryClient.setQueryData(
        ['restaurant', 'check', selectedTableId, null, isOnline],
        painted,
      );
      setActiveOrderId(newId);
      activeOrderIdRef.current = newId;
      queryClient.setQueryData(
        restaurantTablesQueryKey(user?.id, isOnline),
        (prev: RestaurantTable[] | undefined) =>
          patchTableRowFloorFigures(
            prev,
            selectedTableId,
            floorFiguresFromTicketTabs(knownTabs),
          ),
      );
      bumpJournal();
      // Soft reconcile floor from server; figures already patched for precision.
      void queryClient.invalidateQueries({ queryKey: ['restaurant', 'tables'] });
      toast.success(
        `New ticket ${data.order?.orderNumber ? data.order.orderNumber : ''}`.trim() ||
          'New ticket open',
        { id: 'open-empty-check-ok', duration: 2000 },
      );
    } catch (err) {
      toastApiError(err, 'Could not open new ticket');
    } finally {
      setBusy(false);
    }
  };

  const runTransfer = async () => {
    if (!order || !opsTargetTableId) return;
    if (!canOrder) {
      toast.error('You need restaurant.order permission to transfer');
      return;
    }
    setBusy(true);
    try {
      if (preferLocalRestaurantWrites(order.id)) {
        const events = getAllEvents();
        const syncState = getAllSyncState();
        const derived = selectedTableId
          ? deriveRestaurantCheckForTable(selectedTableId, events, syncState, order.id)
          : null;
        if (!derived) throw new Error('Offline check not found');
        const target = (tablesQuery.data || []).find((t) => t.id === opsTargetTableId);
        if (!target) throw new Error('Target table not found');
        transferRestaurantCheckOffline(derived, {
          tableId: target.id,
          tableCode: target.code,
          tableName: target.name,
          channel: channelHint(target),
        });
        toast.success(
          isOnline
            ? 'Check transferred (will sync)'
            : 'Check transferred (offline — will sync)',
        );
        setOpsMode(null);
        setSelectedTableId(opsTargetTableId);
        setActiveOrderId(order.id);
        bumpJournal();
        invalidateCheck();
        return;
      }
      await api.restaurant.transferCheck(order.id, { toTableId: opsTargetTableId });
      toast.success('Check transferred');
      setOpsMode(null);
      setSelectedTableId(opsTargetTableId);
      setActiveOrderId(order.id);
      invalidateCheck();
    } catch (err) {
      if (isOnline) toastApiError(err, 'Transfer failed'); else toast.error(err instanceof Error ? err.message : 'Transfer failed');
    } finally {
      setBusy(false);
    }
  };

  const runMerge = async () => {
    if (!canOrder) {
      toast.error('You need restaurant.order permission to merge');
      return;
    }
    if (!order || !opsSecondaryOrderId) return;
    setBusy(true);
    try {
      if (
        preferLocalRestaurantWrites(order.id) ||
        preferLocalRestaurantWrites(opsSecondaryOrderId)
      ) {
        const events = getAllEvents();
        const syncState = getAllSyncState();
        const primary = selectedTableId
          ? deriveRestaurantCheckForTable(selectedTableId, events, syncState, order.id)
          : null;
        const open = deriveRestaurantOpenChecks(events, syncState);
        const secondary = open.find((o) => o.orderId === opsSecondaryOrderId) ?? null;
        if (!primary || !secondary) throw new Error('Both checks must be open offline');
        mergeRestaurantChecksOffline(primary, secondary);
        toast.success(
          isOnline ? 'Checks merged (will sync)' : 'Checks merged (offline — will sync)',
        );
        setOpsMode(null);
        setOpsSecondaryOrderId('');
        bumpJournal();
        invalidateCheck();
        return;
      }
      await api.restaurant.mergeChecks(order.id, { secondaryOrderId: opsSecondaryOrderId });
      toast.success('Checks merged');
      setOpsMode(null);
      setOpsSecondaryOrderId('');
      invalidateCheck();
    } catch (err) {
      if (isOnline) toastApiError(err, 'Merge failed'); else toast.error(err instanceof Error ? err.message : 'Merge failed');
    } finally {
      setBusy(false);
    }
  };

  /** After Move/split: show the new ticket with moved lines (Samba expectation). */
  const paintAfterSplitMove = (
    splitOrderId: string,
    opts?: {
      knownTabs?: TicketTab[];
      checkPayload?: CheckUiPayload;
      sourceOrderId?: string;
      splitLineUnitCount?: number;
    },
  ) => {
    if (!selectedTableId) return;
    const activeId = resolveActiveOrderIdAfterSplitMove(splitOrderId);
    if (
      !assertSplitMovePaintShowsMovedLines({
        activeOrderId: activeId,
        splitOrderId,
        splitLineUnitCount: opts?.splitLineUnitCount ?? 1,
      })
    ) {
      toast.error('Move completed but new ticket could not be shown — reopen the table');
      return;
    }
    setSambaTicketView('detail');
    if (chrome.fohTicketPane === 'sheet') setMobileSheet(null);
    const knownTabs =
      opts?.knownTabs ||
      scrubRestaurantTicketTabs([
        ...tableTicketsRef.current.tabs,
        { id: splitOrderId, orderNumber: '…', totalAmount: '0' },
      ]);
    tableTicketsRef.current = { tableId: selectedTableId, tabs: knownTabs };
    if (opts?.sourceOrderId) {
      splitMovePartyPinRef.current = createSplitMovePartyPin(
        selectedTableId,
        opts.sourceOrderId,
        splitOrderId,
      );
    }
    // Invalidate any in-flight GET for the source ticket so it cannot wipe this paint.
    checkPaintGenRef.current += 1;

    if (opts?.checkPayload?.order?.id) {
      const painted = attachSiblingTabs(
        checkUiAfterServerSeed(selectedTableId, opts.checkPayload),
        knownTabs,
        selectedTableId,
        splitMovePartyPinRef.current,
      );
      for (const id of restaurantCheckQueryPaintIds({
        paintedOrderId: splitOrderId,
        targetOrderId: splitOrderId,
        displayedOrderId: activeOrderId,
      })) {
        queryClient.setQueryData(['restaurant', 'check', selectedTableId, id, isOnline], painted);
      }
    } else {
      paintJournalCheck(selectedTableId, splitOrderId);
    }

    setActiveOrderId(activeId);
    activeOrderIdRef.current = activeId;
    queryClient.setQueryData(
      restaurantTablesQueryKey(user?.id, isOnline),
      (prev: RestaurantTable[] | undefined) =>
        patchTableRowFloorFigures(
          prev,
          selectedTableId,
          floorFiguresFromTicketTabs(knownTabs),
        ),
    );
    void queryClient.invalidateQueries({ queryKey: ['restaurant', 'tables'] });
  };

  const runSplit = async (opts?: {
    sameTable?: boolean;
    targetTableId?: string;
    /** Samba Move N of M — when set, only these quantities leave the source. */
    items?: Array<{ itemId: string; quantity?: number }>;
  }) => {
    if (!order) return;
    const sameTable = opts?.sameTable !== false;
    const targetTableId = sameTable
      ? selectedTableId!
      : opts?.targetTableId || opsTargetTableId;
    if (!targetTableId) {
      toast.error('Pick a target table');
      return;
    }

    const moveItems: Array<{ itemId: string; quantity?: number }> =
      opts?.items?.length
        ? opts.items
        : selectedLineIds.map((itemId) => ({ itemId }));
    if (moveItems.length === 0) return;

    const moveIdSet = new Set(moveItems.map((i) => i.itemId));
    const qtyBy: Record<string, number> = {};
    for (const row of moveItems) {
      const onHand = Number(orderLines.find((l) => l.id === row.itemId)?.quantity) || 0;
      const requestedQty = typeof row.quantity === 'number' ? row.quantity : onHand;
      qtyBy[row.itemId] = requestedQty;
    }
    const movingUnits = Object.values(qtyBy).reduce((s, n) => s + n, 0);
    if (!canMoveSelectedUnits(movingUnits, totalOrderUnits)) {
      toast.error('Select some items to move — not the whole ticket (use Change table)');
      return;
    }

    const sourceOrderIdBefore = order.id;
    setBusy(true);
    try {
      if (preferLocalRestaurantWrites(order.id)) {
        const events = getAllEvents();
        const syncState = getAllSyncState();
        const derived = selectedTableId
          ? deriveRestaurantCheckForTable(selectedTableId, events, syncState, order.id)
          : null;
        if (!derived) throw new Error('Offline check not found');
        const target = (tablesQuery.data || []).find((t) => t.id === targetTableId);
        if (!target) throw new Error('Target table not found');
        const { source: nextSource, split } = splitRestaurantCheckOffline(derived, {
          lineIds: [...moveIdSet],
          quantityByLineId: qtyBy,
          targetTableId: target.id,
          targetTableCode: target.code,
          targetTableName: target.name,
          sameTable,
          channel: channelHint(target),
        });
        const splitUnits = split.lines.reduce((s, l) => s + (Number(l.quantity) || 0), 0);
        const knownTabs = scrubRestaurantTicketTabs(
          buildPartyTabsAfterSplitMove({
            priorTabs: tableTicketsRef.current.tabs,
            source: {
              id: nextSource.orderId,
              orderNumber: nextSource.offlineId,
              totalAmount: totalsFromLines(nextSource.lines).totalAmount,
            },
            split: {
              id: split.orderId,
              orderNumber: split.offlineId,
              totalAmount: totalsFromLines(split.lines).totalAmount,
            },
          }),
        );
        toast.success(
          sameTable
            ? isOnline
              ? 'Moved to new ticket on this table (will sync)'
              : 'Moved to new ticket on this table (offline — will sync)'
            : isOnline
              ? 'Items moved to other table (will sync)'
              : 'Items moved to other table (offline — will sync)',
        );
        setOpsMode(null);
        setSelectedLineIds([]);
        if (!sameTable) {
          setSelectedTableId(targetTableId);
        }
        bumpJournal();
        // Paint source cache too so switching back never shows pre-move lines.
        paintJournalCheck(selectedTableId, nextSource.orderId);
        paintAfterSplitMove(split.orderId, {
          knownTabs,
          sourceOrderId: nextSource.orderId,
          splitLineUnitCount: splitUnits,
        });
        return;
      }

      const res = await api.restaurant.splitCheck(order.id, {
        items: moveItems,
        targetTableId,
        sameTable,
      });
      const splitPayload = res.data.data as {
        split: { order: OrderDetail; meta?: CheckMeta | null };
        source: { order: OrderDetail; meta?: CheckMeta | null };
      };
      const splitId = splitPayload.split.order.id;
      const sourceId = splitPayload.source.order.id;
      if (!splitId) throw new Error('Split succeeded but no new ticket id returned');

      const tableCode = meta?.tableCode || selectedTable?.code;
      const tableName = meta?.tableName || selectedTable?.name;
      const channel =
        (meta?.orderChannel as 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY' | null | undefined) ||
        channelHint(selectedTable);

      // Seed BOTH checks from split response BEFORE paint — never wait on a lagging GET.
      refreshRestaurantCheckSeedFromServer({
        orderId: sourceId,
        orderNumber: splitPayload.source.order.orderNumber,
        tableId: selectedTableId!,
        tableCode,
        tableName,
        channel,
        waiterId: splitPayload.source.meta?.waiterId ?? meta?.waiterId,
        waiterName: splitPayload.source.meta?.waiterName ?? meta?.waiterName,
        items: (splitPayload.source.order.items || []).map((it) => ({
          id: it.id,
          productId: it.productId,
          productName: it.productName,
          quantity: it.quantity,
          unitPrice: it.unitPrice,
          lineNotes: it.lineNotes,
          kitchenSentAt: it.kitchenSentAt,
          addedBy: it.addedBy,
          addedByName: it.addedByName,
          addedAt: it.addedAt,
        })),
      });
      refreshRestaurantCheckSeedFromServer({
        orderId: splitId,
        orderNumber: splitPayload.split.order.orderNumber,
        tableId: selectedTableId!,
        tableCode,
        tableName,
        channel,
        waiterId: splitPayload.split.meta?.waiterId ?? meta?.waiterId,
        waiterName: splitPayload.split.meta?.waiterName ?? meta?.waiterName,
        items: (splitPayload.split.order.items || []).map((it) => ({
          id: it.id,
          productId: it.productId,
          productName: it.productName,
          quantity: it.quantity,
          unitPrice: it.unitPrice,
          lineNotes: it.lineNotes,
          kitchenSentAt: it.kitchenSentAt,
          addedBy: it.addedBy,
          addedByName: it.addedByName,
          addedAt: it.addedAt,
        })),
      });

      let checkPayload: CheckUiPayload;
      try {
        const getRes = await api.restaurant.getTableCheck(selectedTableId!, { orderId: splitId });
        checkPayload = getRes.data.data as CheckUiPayload;
        // Prefer split response items if GET somehow returns empty (race).
        if (
          (!checkPayload.order?.items || checkPayload.order.items.length === 0) &&
          (splitPayload.split.order.items?.length || 0) > 0
        ) {
          checkPayload = {
            ...checkPayload,
            order: splitPayload.split.order,
            meta: splitPayload.split.meta ?? checkPayload.meta,
          };
        }
      } catch {
        const cachedTable =
          getCachedRestaurantTables().find((t) => t.id === selectedTableId) ||
          tablesQuery.data?.find((t) => t.id === selectedTableId) ||
          checkQuery.data?.table;
        checkPayload = {
          table: (cachedTable || { id: selectedTableId! }) as RestaurantTable,
          order: splitPayload.split.order,
          meta: splitPayload.split.meta ?? null,
          siblingChecks: [
            {
              id: sourceId,
              orderNumber: splitPayload.source.order.orderNumber,
              totalAmount: splitPayload.source.order.totalAmount,
              createdAt: new Date().toISOString(),
            },
          ],
        };
      }

      const knownTabs = scrubRestaurantTicketTabs(
        buildPartyTabsAfterSplitMove({
          priorTabs: [
            ...tableTicketsRef.current.tabs,
            ...(checkPayload.siblingChecks || []).map((s) => ({
              id: s.id,
              orderNumber: s.orderNumber,
              totalAmount: s.totalAmount,
            })),
          ],
          source: {
            id: sourceId,
            orderNumber: splitPayload.source.order.orderNumber,
            totalAmount: splitPayload.source.order.totalAmount,
          },
          split: {
            id: splitId,
            orderNumber:
              checkPayload.order?.orderNumber || splitPayload.split.order.orderNumber,
            totalAmount:
              checkPayload.order?.totalAmount ?? splitPayload.split.order.totalAmount,
          },
        }),
      );

      const splitUnits = (splitPayload.split.order.items || []).reduce(
        (s, it) => s + (Number(it.quantity) || 0),
        0,
      );

      toast.success(
        sameTable ? 'Moved to new ticket on this table' : 'Items moved to other table',
      );
      setOpsMode(null);
      setSelectedLineIds([]);
      if (!sameTable) {
        setSelectedTableId(targetTableId);
      }
      paintAfterSplitMove(splitId, {
        knownTabs,
        checkPayload,
        sourceOrderId: sourceId || sourceOrderIdBefore,
        splitLineUnitCount: splitUnits,
      });

      // Keep source ticket cache fresh when user switches back.
      if (sourceId && sourceId !== splitId) {
        try {
          const sourceRes = await api.restaurant.getTableCheck(selectedTableId!, {
            orderId: sourceId,
          });
          let sourcePayload = sourceRes.data.data as CheckUiPayload;
          if (
            (!sourcePayload.order?.items || sourcePayload.order.items.length === 0) &&
            (splitPayload.source.order.items?.length || 0) > 0
          ) {
            sourcePayload = {
              ...sourcePayload,
              order: splitPayload.source.order,
              meta: splitPayload.source.meta ?? sourcePayload.meta,
            };
          }
          const sourcePainted = attachSiblingTabs(
            checkUiAfterServerSeed(selectedTableId!, sourcePayload),
            knownTabs,
            selectedTableId,
          );
          queryClient.setQueryData(
            ['restaurant', 'check', selectedTableId, sourceId, isOnline],
            sourcePainted,
          );
        } catch {
          void queryClient.invalidateQueries({
            queryKey: ['restaurant', 'check', selectedTableId, sourceId],
          });
        }
      }
    } catch (err) {
      if (isOnline) toastApiError(err, 'Move failed');
      else toast.error(err instanceof Error ? err.message : 'Move failed');
    } finally {
      setBusy(false);
    }
  };

  const toggleGroupSelection = (group: TicketLineGroup) => {
    setOpsMode(null);
    const allOn = group.itemIds.every((id) => selectedLineIds.includes(id));
    if (allOn) {
      setSelectedLineIds((prev) => prev.filter((id) => !group.itemIds.includes(id)));
    } else {
      setSelectedLineIds((prev) => [...new Set([...prev, ...group.itemIds])]);
    }
  };

  const clearLineSelection = () => setSelectedLineIds([]);

  /**
   * Samba Move: selected lines → new ticket on same table.
   * If one product group with qty > 1 is selected, ask how many to move.
   */
  const handleMoveSelected = () => {
    if (!order || selectedLineIds.length === 0) return;
    const selectedGroups = ticketGroups.filter((g) =>
      g.itemIds.every((id) => selectedLineIds.includes(id)),
    );
    const singleGroup =
      selectedGroups.length === 1 &&
      selectedLineIds.every((id) => selectedGroups[0]!.itemIds.includes(id))
        ? selectedGroups[0]!
        : null;

    if (singleGroup && singleGroup.quantity > 1) {
      const maxMove = maxMoveUnitsForGroup(singleGroup.quantity, totalOrderUnits);
      if (maxMove < 1) {
        toast.error('Select some items to move — not the whole ticket (use Change table)');
        return;
      }
      setQtyPadSheet({
        purpose: 'move-qty',
        itemIds: singleGroup.itemIds,
        lines: singleGroup.lines,
        productName: singleGroup.productName,
        max: maxMove,
        digits: String(Math.min(1, maxMove)),
        sameTable: true,
      });
      return;
    }

    void runSplit({ sameTable: true });
  };

  type VoidKotPrint = {
    kotNumber: string;
    station: string;
    printerName?: string | null;
    tableCode: string | null;
    tableName: string | null;
    waiterName: string | null;
    firedByName?: string | null;
    serverName?: string | null;
    firedAt: string;
    ticketKind?: 'FIRE' | 'VOID';
    orderChannel?: string | null;
    guestName?: string | null;
    guestPhone?: string | null;
    deliveryAddress?: string | null;
    pickupLabel?: string | null;
    items: Array<{ productName: string; quantity: string; lineNotes: string | null }>;
  };

  const printVoidTickets = async (
    voidKots: VoidKotPrint[],
    reason?: string,
    printJobs?: ClientPrintJob[],
  ) => {
    // VOID paper is best-effort — never block void UX on HTML→PDF.
    // Preserve per-station targetPrinter (kitchen vs bar) — never collapse to one printer.
    if (printJobs && printJobs.length > 0) {
      void dispatchPrintJobs(
        printJobs.map((j) => ({
          ...j,
          targetPrinter:
            j.targetPrinter ||
            resolveStationPrinterName(
              j.stationCode ||
                (typeof j.payloadJson?.station === 'string' ? j.payloadJson.station : null),
            ),
        })),
        { branding: guestBillDispatchBranding },
      );
      return;
    }
    const jobs = voidKots.map((kot) =>
      enqueueOfflinePrintJob({
        documentType: 'VOID_KOT',
        targetPrinter: kot.printerName || resolveStationPrinterName(kot.station),
        stationCode: kot.station,
        payloadJson: {
          kotNumber: kot.kotNumber,
          station: kot.station,
          stationCode: kot.station,
          tableLabel: kot.tableName || kot.tableCode || selectedTable?.name || 'Table',
          sentByName:
            kot.firedByName || kot.waiterName || user?.fullName || user?.email || null,
          stewardName:
            kot.firedByName || kot.waiterName || user?.fullName || user?.email || null,
          serverName: kot.serverName || null,
          waiterName: kot.firedByName || kot.waiterName,
          firedAt: kot.firedAt,
          ticketKind: 'VOID',
          voidReason: reason || null,
          orderChannel: meta?.orderChannel || kot.orderChannel,
          guestName: meta?.guestName || kot.guestName,
          guestPhone: meta?.guestPhone || kot.guestPhone,
          deliveryAddress: meta?.deliveryAddress || kot.deliveryAddress,
          pickupLabel: meta?.pickupLabel || kot.pickupLabel,
          items: kot.items.map((it) => ({
            productName: it.productName,
            quantity: Number(it.quantity),
            lineNotes: it.lineNotes,
          })),
        },
      }),
    );
    void dispatchPrintJobs(jobs, { branding: guestBillDispatchBranding });
  };

  const handleVoidLines = async (
    itemIds: string[],
    opts?: {
      reason?: string;
      skipConfirm?: boolean;
      /** Toast/Samba: void this many units across the selected lines (default = all). */
      voidQuantity?: number;
      lines?: OrderItem[];
    },
  ) => {
    if (!order || itemIds.length === 0) return;
    if (!canOrder) {
      toast.error('You need restaurant.order permission to void lines');
      return;
    }
    const targetLines = (opts?.lines || orderLines).filter((l) => itemIds.includes(l.id));
    if (targetLines.length === 0) {
      toast.error('Line not found on this check — refresh and try again');
      invalidateCheck();
      return;
    }

    const totalQty = targetLines.reduce((s, l) => s + (Number(l.quantity) || 0), 0);
    const wouldVoidSent = targetLines.some((l) => !!l.kitchenSentAt);
    if (wouldVoidSent && !canVoidSent) {
      toast.error(RESTAURANT_VOID_SENT_RESTRICTED_MESSAGE);
      return;
    }
    let voidQty = opts?.voidQuantity;
    if (voidQty === undefined) {
      if (totalQty > 1 && !opts?.skipConfirm) {
        // Touch qty pad (never window.prompt) — Toast/Samba partial void.
        setLineSheet(null);
        setQtyPadSheet({
          purpose: 'void-qty',
          itemIds,
          lines: targetLines,
          productName: targetLines[0]?.productName || 'items',
          kitchenSent: targetLines.some((l) => !!l.kitchenSentAt),
          max: totalQty,
          digits: '1',
        });
        return;
      }
      voidQty = totalQty;
    }
    if (!(voidQty > 0) || voidQty > totalQty) {
      toast.error(`Cannot void ${voidQty} — only ${totalQty} on the check`);
      return;
    }

    let voidItems: Array<{ itemId: string; quantity: number }>;
    try {
      voidItems = allocateVoidQuantity(
        targetLines.map((l) => ({ id: l.id, quantity: Number(l.quantity) || 0 })),
        voidQty,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Invalid void quantity');
      return;
    }

    const hasKot = targetLines.some(
      (l) => voidItems.some((v) => v.itemId === l.id) && l.kitchenSentAt,
    );
    if (hasKot && !canVoidSent) {
      toast.error(RESTAURANT_VOID_SENT_RESTRICTED_MESSAGE);
      return;
    }
    const voidLineIds = voidItems.map((v) => v.itemId);
    const qtyMap = Object.fromEntries(voidItems.map((v) => [v.itemId, v.quantity]));
    if (hasKot && !opts?.reason?.trim()) {
      setLineSheet(null);
      setQtyPadSheet(null);
      setVoidReasonDraft('');
      setVoidReasonSheet({
        itemIds: voidLineIds,
        lines: targetLines,
        voidQuantity: voidQty,
      });
      return;
    }

    // Journal-local checks: never POST ofl_ord_*/ofl_line_* to UUID APIs (online or offline).
    if (preferLocalRestaurantWrites(order.id)) {
      const reason =
        opts?.reason?.trim() ||
        (hasKot ? 'Customer changed mind' : 'Removed before kitchen send');

      const events = getAllEvents();
      const syncState = getAllSyncState();
      const derived = selectedTableId
        ? deriveRestaurantCheckForTable(selectedTableId, events, syncState, order.id)
        : null;
      if (!derived) {
        toast.error('Local check not found in journal');
        return;
      }
      try {
        const { order: next, voidTickets } = removeRestaurantLinesOffline(
          derived,
          voidLineIds,
          qtyMap,
          {
            reason,
            allowKitchenSent: hasKot,
          },
        );
        if (voidTickets.length > 0) {
          const jobs = voidTickets.map((kot) =>
            enqueueOfflinePrintJob({
              documentType: 'VOID_KOT',
              targetPrinter: kot.printerName,
              stationCode: kot.stationCode,
              payloadJson: {
                kotNumber: kot.kotOfflineId,
                station: kot.station,
                stationCode: kot.stationCode,
                tableLabel: derived.tableName || derived.tableCode || selectedTable?.name || 'Table',
                sentByName: user?.fullName || user?.email || null,
                stewardName: user?.fullName || user?.email || derived.waiterName || null,
                waiterName: user?.fullName || user?.email || derived.waiterName || null,
                firedAt: new Date().toISOString(),
                ticketKind: 'VOID',
                voidReason: reason,
                orderChannel: derived.channel,
                guestName: derived.guestName,
                guestPhone: derived.guestPhone,
                deliveryAddress: derived.deliveryAddress,
                pickupLabel: derived.pickupLabel,
                items: kot.lines.map((it) => ({
                  productName: it.productName,
                  quantity: it.quantity,
                  lineNotes: it.lineNotes ?? null,
                })),
              },
            }),
          );
          void dispatchPrintJobs(jobs, { branding: guestBillDispatchBranding });
        }
        setLineSheet(null);
        setQtyPadSheet(null);
        setVoidReasonSheet(null);
        setSelectedLineIds([]);
        if (hasKot) invalidateMenuStock();
        if (next.lines.length === 0) {
          settleCheckOnFloor(order.id, selectedTableId, 'CANCELLED', {
            reason: reason || 'Removed last lines',
          });
          setActiveOrderId(null);
          returnToFloor();
          toast.success(
            hasKot ? 'Check voided — table freed' : 'Check cancelled — table freed',
          );
        } else {
          if (selectedTableId) clearRestaurantBillRequestedOffline(selectedTableId, order.id);
          paintJournalCheck(selectedTableId, next.orderId);
          toast.success(
            hasKot
              ? voidTickets.length > 0
                ? `Voided ${voidQty} — ${voidTickets.length} VOID ticket(s)`
                : voidQty < totalQty
                  ? `Voided ${voidQty} (will sync)`
                  : 'Voided — kitchen notified (will sync)'
              : voidQty < totalQty
                ? `Removed ${voidQty}`
                : 'Line(s) removed',
          );
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : hasKot ? 'Void failed' : 'Remove failed');
      }
      return;
    }

    if (!isOnline) {
      toast.error(
        hasKot
          ? 'Void requires online connection (kitchen must be notified)'
          : 'Cannot remove lines offline — open check missing from journal',
      );
      return;
    }

    const serverVoidOrderId =
      toServerRestaurantOrderId(order.id) || toServerRestaurantOrderId(activeOrderId);
    const liveVoidItems = voidItems.filter(
      (v) =>
        isServerOrderItemId(v.itemId) &&
        targetLines.some((l) => l.id === v.itemId),
    );
    const tempVoidIds = voidItems
      .map((v) => v.itemId)
      .filter((id) => isTempRestaurantId(id) || !isServerOrderItemId(id));

    const paintDroppedTemps = () => {
      if (!selectedTableId || tempVoidIds.length === 0) return false;
      const displayKey = ['restaurant', 'check', selectedTableId, activeOrderId, isOnline] as const;
      const prev = queryClient.getQueryData(displayKey) as CheckUiPayload | undefined;
      const next = dropOptimisticCheckLines(prev as OptimisticCheckPayload | undefined, tempVoidIds);
      if (!next) return false;
      checkPaintGenRef.current += 1;
      queryClient.setQueryData(displayKey, next);
      if (next.order?.id) {
        queryClient.setQueryData(
          ['restaurant', 'check', selectedTableId, next.order.id, isOnline],
          next,
        );
      }
      for (const id of tempVoidIds) inFlightOptimisticLinesRef.current.delete(id);
      return true;
    };

    if (liveVoidItems.length === 0) {
      if (paintDroppedTemps()) {
        setLineSheet(null);
        setQtyPadSheet(null);
        setVoidReasonSheet(null);
        setSelectedLineIds([]);
        toast.success(voidQty < totalQty ? `Removed ${voidQty}` : 'Line(s) removed');
        return;
      }
      toast.error('Ticket lines out of date — refreshing…');
      setSelectedLineIds([]);
      invalidateCheck();
      return;
    }

    if (!serverVoidOrderId) {
      toast.error('Ticket is still saving — try minus again');
      return;
    }

    const reason =
      opts?.reason?.trim() ||
      (hasKot ? 'Customer changed mind' : 'Removed before kitchen send');

    setBusy(true);
    try {
      const res = await api.restaurant.voidItems(
        serverVoidOrderId,
        {
          items: liveVoidItems,
          reason,
        },
        { silentErrorToast: true },
      );
      const data = res.data.data as {
        voidKots?: VoidKotPrint[];
        printJobs?: ClientPrintJob[];
        checkCancelled?: boolean;
      };
      if (hasKot && (data.voidKots?.length || 0) > 0) {
        await printVoidTickets(data.voidKots || [], reason, data.printJobs);
        publishLanKdsBoardChanged('KOT_VOIDED');
      }
      setLineSheet(null);
      setQtyPadSheet(null);
      setVoidReasonSheet(null);
      if (data.checkCancelled) {
        settleCheckOnFloor(serverVoidOrderId, selectedTableId, 'CANCELLED', { reason });
        toast.success(hasKot ? 'Check voided — table freed' : 'Check cancelled — table freed');
        setActiveOrderId(null);
        returnToFloor();
      } else {
        toast.success(
          hasKot && (data.voidKots?.length || 0) > 0
            ? `Voided ${voidQty} — ${data.voidKots!.length} VOID ticket(s)`
            : hasKot
              ? `Voided ${voidQty}`
              : `Removed ${voidQty}`,
        );
      }
      setSelectedLineIds([]);
      invalidateCheck();
      if (hasKot) invalidateMenuStock();
    } catch (err) {
      const msg = apiErr(err, hasKot ? 'Void failed' : 'Remove failed');
      const alreadyClosed =
        /Open restaurant check required to void/i.test(msg) ||
        (axios.isAxiosError(err) &&
          (err.response?.data as { error_code?: string } | undefined)?.error_code ===
            'ERR_RESTAURANT_VOID' &&
          /Open restaurant check/i.test(msg));
      const linesMissing =
        /no longer on this check|different check|lines are missing from this check/i.test(msg);
      if (alreadyClosed && selectedTableId) {
        try {
          const res = await api.restaurant.getTableCheck(
            selectedTableId,
            { orderId: serverVoidOrderId },
            { silentErrorToast: true, silentForbidden: true },
          );
          const live = res.data.data as CheckUiPayload;
          if (
            live.order?.id &&
            toServerRestaurantOrderId(live.order.id) &&
            live.order.status === 'PENDING'
          ) {
            paintServerCheckWithInFlight(selectedTableId, live, live.order.id);
            setActiveOrderId(live.order.id);
            toast.error('Ticket was out of date — refreshed. Try void again.');
            setSelectedLineIds([]);
            setLineSheet(null);
            return;
          }
        } catch {
          // GET miss → treat as closed below.
        }
        settleCheckOnFloor(serverVoidOrderId, selectedTableId, 'CANCELLED', {
          reason: reason || 'Check already closed',
        });
        setActiveOrderId(null);
        returnToFloor();
        toast.success('Check was already closed — table freed');
      } else if (linesMissing) {
        toast.error(msg.includes('different check')
          ? 'Those lines belong to another open ticket — switch tabs and try again'
          : 'Ticket was out of date — refreshed. Try void again.');
        setSelectedLineIds([]);
        setLineSheet(null);
        invalidateCheck();
      } else {
        toastApiError(err, hasKot ? 'Void failed' : 'Remove failed');
      }
      if (!linesMissing) invalidateCheck();
    } finally {
      setBusy(false);
    }
  };

  /** Samba Void: highlight lines first, then void (qty pad asks how many when needed). */
  const handleVoidSelected = () => {
    if (selectedLineIds.length === 0) return;
    const lines = orderLines.filter((l) => selectedLineIds.includes(l.id));
    void handleVoidLines(selectedLineIds, { lines });
  };

  /** +1 same product (always adds as New / unsent). */
  const handleLinePlusOne = async (group: TicketLineGroup) => {
    if (!selectedTableId || !selectedWaiterId) return;
    const productId = group.productId;
    if (!productId) {
      toast.error('Cannot change quantity for this line');
      return;
    }
    // +1 is on a visible line — always that ticket (Toast/Samba). Never re-gate.
    const plusTargetOrderId = order?.id || activeOrderId || null;
    if (!plusTargetOrderId) {
      toast.error('Select a ticket to add items', {
        duration: 3500,
        id: 'foh-select-ticket',
      });
      return;
    }
    if (preferLocalRestaurantWrites(plusTargetOrderId)) {
      try {
        const table =
          tablesQuery.data?.find((t) => t.id === selectedTableId) ?? checkQuery.data?.table;
        if (!table) throw new Error('Table not available offline');
        const waiter = waiters.find((w) => w.id === selectedWaiterId);
        const derived = appendRestaurantItemOffline({
          tableId: selectedTableId,
          tableCode: table.code,
          tableName: table.name,
          channel: channelHint(table),
          orderId: plusTargetOrderId,
          customerId: selectedCustomer?.id || null,
          waiterId: selectedWaiterId,
          waiterName: waiter?.fullName,
          addedBy: user?.id ?? null,
          addedByName: user?.fullName || user?.email || null,
          addedAt: new Date().toISOString(),
          guestName: selectedCustomer?.name || guestDraft.guestName.trim() || null,
          guestPhone: selectedCustomer?.phone || guestDraft.guestPhone.trim() || null,
          deliveryAddress:
            selectedCustomer?.address || guestDraft.deliveryAddress.trim() || null,
          pickupLabel: guestDraft.pickupLabel.trim() || null,
          productId,
          productName: group.productName,
          unitPrice: group.unitPrice,
          quantity: 1,
        });
        if (selectedTableId) clearRestaurantBillRequestedOffline(selectedTableId, derived.orderId);
        paintJournalCheck(selectedTableId, derived.orderId);
        if (derived.orderId) setActiveOrderId(derived.orderId);
        setLineSheet(null);
        toast.success('+1 added');
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to add');
      }
      return;
    }

    const table =
      tablesQuery.data?.find((t) => t.id === selectedTableId) ?? checkQuery.data?.table;
    if (!table) {
      toast.error('Table not available');
      return;
    }
    const targetOrderId = plusTargetOrderId;
    const displayKey = ['restaurant', 'check', selectedTableId, activeOrderId, isOnline] as const;
    const checkKey = ['restaurant', 'check', selectedTableId, targetOrderId, isOnline] as const;
    const prevSnapshot =
      (queryClient.getQueryData(checkKey) as CheckUiPayload | undefined) ||
      (queryClient.getQueryData(displayKey) as CheckUiPayload | undefined);
    const tempLineId = newTempLineId();
    inFlightOptimisticLinesRef.current.set(tempLineId, {
      tempLineId,
      productId,
      productName: group.productName,
      quantity: 1,
      unitPrice: group.unitPrice,
    });
    const optimistic = appendOptimisticMenuItem(
      prevSnapshot as OptimisticCheckPayload | undefined,
      {
        table,
        product: {
          id: productId,
          name: group.productName,
          sellingPrice: group.unitPrice,
        },
        quantity: 1,
        tempLineId,
        channel: channelHint(table),
        waiterId: selectedWaiterId,
        waiterName: waiters.find((w) => w.id === selectedWaiterId)?.fullName ?? null,
        addedBy: user?.id ?? null,
        addedByName: user?.fullName || user?.email || null,
        addedAt: new Date().toISOString(),
        guestName: selectedCustomer?.name || guestDraft.guestName.trim() || null,
        guestPhone: selectedCustomer?.phone || guestDraft.guestPhone.trim() || null,
        deliveryAddress:
          selectedCustomer?.address || guestDraft.deliveryAddress.trim() || null,
        pickupLabel: guestDraft.pickupLabel.trim() || null,
        knownTabs: tableTicketsRef.current.tabs,
      },
    ) as CheckUiPayload;
    for (const id of restaurantCheckQueryPaintIds({
      paintedOrderId: optimistic.order?.id,
      targetOrderId,
      displayedOrderId: activeOrderId,
    })) {
      queryClient.setQueryData(['restaurant', 'check', selectedTableId, id, isOnline], optimistic);
    }
    setLineSheet(null);
    const apiOrderId = toServerRestaurantOrderId(targetOrderId);
    try {
      const postItems = async (orderIdForApi: string | null | undefined) => {
        const res = await api.restaurant.addItems({
          tableId: selectedTableId,
          orderId: orderIdForApi ?? undefined,
          waiterId: selectedWaiterId,
          items: [{ productId, quantity: 1 }],
        });
        return readRestaurantAddItemsPayload(res.data.data) || readRestaurantAddItemsPayload(res.data);
      };
      let added = await postItems(apiOrderId).catch(async (firstErr) => {
        if (!apiOrderId || !isRestaurantCheckClosedError(firstErr)) throw firstErr;
        setActiveOrderId(null);
        void queryClient.invalidateQueries({
          queryKey: ['restaurant', 'check', selectedTableId],
        });
        const details = axios.isAxiosError(firstErr)
          ? (firstErr.response?.data as { details?: { openOrderIds?: string[] } } | undefined)
              ?.details
          : undefined;
        const openIds = details?.openOrderIds;
        if (Array.isArray(openIds) && openIds.length > 0) throw firstErr;
        return postItems(undefined);
      });
      if (selectedTableId && plusTargetOrderId) {
        clearRestaurantBillRequestedOffline(selectedTableId, plusTargetOrderId);
      }
      inFlightOptimisticLinesRef.current.delete(tempLineId);
      if (!added) {
        const plusRefreshId = toServerRestaurantOrderId(plusTargetOrderId) || undefined;
        const res = await api.restaurant.getTableCheck(
          selectedTableId,
          plusRefreshId ? { orderId: plusRefreshId } : undefined,
        );
        const data = res.data.data as CheckUiPayload;
        const stayOn =
          toServerRestaurantOrderId(data.order?.id) ||
          toServerRestaurantOrderId(plusTargetOrderId) ||
          null;
        await queryClient.cancelQueries({ queryKey: ['restaurant', 'check', selectedTableId] });
        paintServerCheckWithInFlight(selectedTableId, data, stayOn);
        if (stayOn) setActiveOrderId(stayOn);
        toast.success('+1 added');
        return;
      }
      await queryClient.cancelQueries({ queryKey: ['restaurant', 'check', selectedTableId] });
      const prev =
        (queryClient.getQueryData(displayKey) as CheckUiPayload | undefined) ||
        (queryClient.getQueryData(checkKey) as CheckUiPayload | undefined);
      const data: CheckUiPayload = {
        table: added.table as CheckUiPayload['table'],
        order: added.order as CheckUiPayload['order'],
        meta: (added.meta as CheckUiPayload['meta']) || null,
        siblingChecks: prev?.siblingChecks || [],
      };
      paintServerCheckWithInFlight(selectedTableId, data, added.order.id);
      setActiveOrderId(added.order.id);
      toast.success('+1 added');
    } catch (err) {
      inFlightOptimisticLinesRef.current.delete(tempLineId);
      try {
        const plusRefreshId = toServerRestaurantOrderId(plusTargetOrderId) || undefined;
        const res = await api.restaurant.getTableCheck(
          selectedTableId,
          plusRefreshId ? { orderId: plusRefreshId } : undefined,
        );
        const data = res.data.data as CheckUiPayload;
        const stayOn =
          toServerRestaurantOrderId(data.order?.id) ||
          toServerRestaurantOrderId(plusTargetOrderId) ||
          null;
        paintServerCheckWithInFlight(selectedTableId, data, stayOn);
        if (stayOn) setActiveOrderId(stayOn);
      } catch {
        queryClient.setQueryData(checkKey, prevSnapshot);
      }
      toastApiError(err, 'Failed to add');
    }
  };

  /**
   * SambaPOS/Toast: −1 voids or removes one unit (works on New and kitchen-sent).
   * Sent lines require void reason + VOID ticket for that one unit.
   */
  const handleLineMinusOne = async (group: TicketLineGroup) => {
    await handleVoidLines(group.itemIds, {
      voidQuantity: 1,
      lines: group.lines,
      reason: group.kitchenSent ? undefined : 'Quantity decreased',
      skipConfirm: !group.kitchenSent,
    });
  };

  /** Apply absolute qty on New/unsent lines (qty pad confirm). */
  const applySetLineQty = async (group: TicketLineGroup, nextQty: number) => {
    if (group.kitchenSent) {
      toast.error('Kitchen-sent lines: void qty then add new — do not edit sent quantity');
      return;
    }
    if (!group.productId) {
      toast.error('Cannot set quantity for this line');
      return;
    }
    if (nextQty === group.quantity) {
      setQtyPadSheet(null);
      setLineSheet(null);
      return;
    }
    if (nextQty === 0) {
      setQtyPadSheet(null);
      await handleVoidLines(group.itemIds, {
        voidQuantity: group.quantity,
        lines: group.lines,
        reason: 'Quantity cleared',
        skipConfirm: true,
      });
      return;
    }
    if (nextQty < group.quantity) {
      setQtyPadSheet(null);
      await handleVoidLines(group.itemIds, {
        voidQuantity: group.quantity - nextQty,
        lines: group.lines,
        reason: 'Quantity decreased',
        skipConfirm: true,
      });
      return;
    }
    const addQty = nextQty - group.quantity;
    const menuProduct =
      productsQuery.data?.find((p) => p.id === group.productId) || null;
    addItemMutation.mutate(
      {
        product: {
          id: group.productId,
          name: group.productName,
          sellingPrice: String(group.unitPrice),
          categoryId: menuProduct?.categoryId ?? null,
          categoryName: menuProduct?.categoryName ?? null,
          kitchenStation: menuProduct?.kitchenStation ?? null,
          productType: menuProduct?.productType,
        },
        quantity: addQty,
      },
      {
        onSuccess: () => {
          setQtyPadSheet(null);
          setLineSheet(null);
        },
      },
    );
  };

  /** SambaPOS: open touch qty pad for absolute qty (never window.prompt). */
  const handleLineSetQty = (group: TicketLineGroup) => {
    if (group.kitchenSent) {
      toast.error('Kitchen-sent lines: void qty then add new — do not edit sent quantity');
      return;
    }
    if (!group.productId) {
      toast.error('Cannot set quantity for this line');
      return;
    }
    setLineSheet(null);
    setQtyPadSheet({
      purpose: 'set-line-qty',
      group,
      digits: String(group.quantity),
    });
  };

  const confirmQtyPadSheet = () => {
    if (!qtyPadSheet) return;
    if (qtyPadSheet.purpose === 'set-line-qty') {
      const raw = qtyPadSheet.digits.replace(/\D/g, '');
      if (!raw) {
        toast.error('Enter a quantity from 0 to 9999');
        return;
      }
      const nextQty = clampOrderQty(Number.parseInt(raw, 10));
      if (nextQty == null) {
        toast.error('Enter a quantity from 0 to 9999');
        return;
      }
      void applySetLineQty(qtyPadSheet.group, nextQty);
      return;
    }
    if (qtyPadSheet.purpose === 'move-qty') {
      const raw = qtyPadSheet.digits.replace(/\D/g, '');
      const n = clampOrderQty(Number.parseInt(raw || '0', 10), qtyPadSheet.max);
      if (n == null || n < 1) {
        toast.error(`Enter a quantity between 1 and ${qtyPadSheet.max}`);
        return;
      }
      const sheet = qtyPadSheet;
      setQtyPadSheet(null);
      try {
        const allocated = allocateVoidQuantity(
          sheet.lines.map((l) => ({ id: l.id, quantity: Number(l.quantity) || 0 })),
          n,
        );
        void runSplit({
          sameTable: sheet.sameTable,
          targetTableId: sheet.targetTableId,
          items: allocated.map((a) => ({ itemId: a.itemId, quantity: a.quantity })),
        });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Invalid move quantity');
      }
      return;
    }
    const raw = qtyPadSheet.digits.replace(/\D/g, '');
    const n = clampOrderQty(Number.parseInt(raw || '0', 10), qtyPadSheet.max);
    if (n == null || n < 1) {
      toast.error(`Enter a quantity between 1 and ${qtyPadSheet.max}`);
      return;
    }
    const sheet = qtyPadSheet;
    setQtyPadSheet(null);
    void handleVoidLines(sheet.itemIds, {
      voidQuantity: n,
      lines: sheet.lines,
    });
  };

  const handleCancelCheck = async () => {
    if (!order) return;
    if (!canCancelCheck) {
      toast.error(RESTAURANT_CANCEL_CHECK_RESTRICTED_MESSAGE);
      return;
    }
    // New/unsent checks: cancel with confirm only (no reason, no VOID print).
    // Sent/printed lines: void reason + VOID tickets to kitchen.
    const hasKot = orderLines.some((l) => l.kitchenSentAt);
    let reason = 'Cancelled from restaurant POS';
    if (hasKot) {
      const prompted = window.prompt(
        'Cancel reason (kitchen will get VOID tickets for fired items):',
        reason,
      );
      if (prompted == null) return;
      if (!prompted.trim()) {
        toast.error('Cancel reason is required when kitchen has been notified');
        return;
      }
      reason = prompted.trim();
    }
    if (
      !window.confirm(
        hasKot
          ? `Cancel check ${order.orderNumber}? Kitchen will get VOID tickets. Table will be freed.`
          : `Cancel check ${order.orderNumber}? The table will be freed.`,
      )
    ) {
      return;
    }

    // Local journal checks: cancel instantly (no busy spinner, no API round-trip).
    if (preferLocalRestaurantWrites(order.id) || !isOnline) {
      const events = getAllEvents();
      const syncState = getAllSyncState();
      const derived = selectedTableId
        ? deriveRestaurantCheckForTable(selectedTableId, events, syncState, order.id)
        : null;
      if (!derived) {
        if (!isOnline) {
          toast.error('Offline check not found in journal');
          return;
        }
        // Fall through to online cancel for server-backed checks
      } else {
        try {
          const { voidTickets } = cancelRestaurantCheckOffline(derived, reason);
          if (voidTickets.length > 0) {
            const jobs = voidTickets.map((kot) =>
              enqueueOfflinePrintJob({
                documentType: 'VOID_KOT',
                targetPrinter: kot.printerName,
                stationCode: kot.stationCode,
                payloadJson: {
                  kotNumber: kot.kotOfflineId,
                  station: kot.station,
                  stationCode: kot.stationCode,
                  tableLabel: derived.tableName || derived.tableCode || selectedTable?.name || 'Table',
                  sentByName: user?.fullName || user?.email || null,
                  stewardName: user?.fullName || user?.email || derived.waiterName || null,
                  waiterName: user?.fullName || user?.email || derived.waiterName || null,
                  firedAt: new Date().toISOString(),
                  ticketKind: 'VOID',
                  voidReason: reason,
                  orderChannel: derived.channel,
                  guestName: derived.guestName,
                  guestPhone: derived.guestPhone,
                  deliveryAddress: derived.deliveryAddress,
                  pickupLabel: derived.pickupLabel,
                  items: kot.lines.map((it) => ({
                    productName: it.productName,
                    quantity: it.quantity,
                    lineNotes: it.lineNotes ?? null,
                  })),
                },
              }),
            );
            void dispatchPrintJobs(jobs, { branding: guestBillDispatchBranding });
          }
          settleCheckOnFloor(order.id, selectedTableId, 'CANCELLED', { reason });
          setSelectedTableId(null);
          setActiveOrderId(null);
          toast.success(
            voidTickets.length > 0
              ? `Check cancelled — ${voidTickets.length} VOID ticket(s)`
              : isOnline
                ? 'Check cancelled (will sync)'
                : 'Check cancelled (offline — will sync)',
          );
        } catch (err) {
          toast.error(err instanceof Error ? err.message : 'Cancel failed');
        }
        return;
      }
    }

    if (!isOnline) {
      toast.error('Offline check not found in journal');
      return;
    }

    setBusy(true);
    try {
      const res = await api.restaurant.cancelCheck(order.id, { reason });
      const data = res.data.data as { voidKots?: VoidKotPrint[]; printJobs?: ClientPrintJob[] };
      if (hasKot && (data.voidKots?.length || 0) > 0) {
        await printVoidTickets(data.voidKots || [], reason, data.printJobs);
        publishLanKdsBoardChanged('KOT_VOIDED');
      }
      settleCheckOnFloor(order.id, selectedTableId, 'CANCELLED', { reason });
      toast.success(
        hasKot && (data.voidKots?.length || 0) > 0
          ? `Check cancelled — ${data.voidKots!.length} VOID ticket(s) sent`
          : 'Check cancelled',
      );
      setSelectedTableId(null);
      setActiveOrderId(null);
      invalidateCheck();
      if (hasKot) invalidateMenuStock();
    } catch (err) {
      toastApiError(err, 'Cancel failed');
    } finally {
      setBusy(false);
    }
  };

  /**
   * Pay = settle the *selected* ticket only (same rule as Bill).
   * Multi-ticket tables: other order numbers stay open; stay on table when siblings remain.
   *
   * Online + server-backed check → Order Payment screen (multi-tender).
   * Offline / ofl_ord_* → journal cash pay (no payment screen).
   */
  const handlePay = async () => {
    if (!order) return;
    if (!canRestaurantPay) {
      toast.error('Only cashiers, accountants, or admins can take payment');
      return;
    }
    if (orderLines.length === 0) {
      toast.error('Cannot pay an empty check');
      return;
    }

    const paidOrderId = order.id;
    const paidOrderNumber = order.orderNumber;
    const remainingTickets = ticketTabs.filter((t) => t.id !== paidOrderId);

    // Online server checks open the tender screen — do not force offline cash.
    // After pay, always land on the restaurant floor (tables), never re-open the ticket.
    const forceLocalCash = shouldUseLocalRestaurantMutation(isOnline, paidOrderId);
    if (isOnline && !forceLocalCash) {
      setBusy(true);
      try {
        // Flush pending journal events (new voids).
        if (hasPendingRestaurantMutations(paidOrderId) || hasPendingSales()) {
          const result = await syncOfflineSales();
          if (result.failed > 0 || result.review > 0) {
            toast.error(
              'Offline voids/edits did not sync — open Sync panel and retry before paying',
            );
            return;
          }
        }
        // Heal ACK'd offline voids that never deleted server rows (existing open checks).
        const desired = resolveDesiredLinesBeforePay(
          paidOrderId,
          orderLines.map((l) => ({
            id: l.id,
            productId: l.productId,
            quantity: l.quantity,
          })),
        );
        // Ticket truth must travel with Pay — payment page must not trust server-as-FOH.
        storePayDesiredLines(paidOrderId, desired);
        const serverRes = await api.orders.getById(paidOrderId);
        const serverOrder = serverRes.data.data as {
          items?: Array<{ id: string; quantity: string; productId?: string | null }>;
        };
        const voids = computeVoidItemsFromUpdatedLines(serverOrder.items || [], desired);
        if (voids.length > 0) {
          await api.restaurant.voidItems(paidOrderId, {
            items: voids,
            reason: 'Reconcile voided lines before pay',
          });
          toast.success(`Removed ${voids.length} voided line(s) before payment`);
        }
        invalidateCheck();
      } catch (err) {
        toastApiError(err, 'Could not sync voided lines — retry before paying');
        return;
      } finally {
        setBusy(false);
      }
      navigate(`/orders/${paidOrderId}/pay?returnTo=${encodeURIComponent('/restaurant')}`);
      return;
    }

    // Journal-first cash pay (offline or ofl_ord_* local checks).
    const events = getAllEvents();
    const syncState = getAllSyncState();
    const derived = selectedTableId
      ? deriveRestaurantCheckForTable(selectedTableId, events, syncState, paidOrderId)
      : null;

    if (derived) {
      const totalLabel = formatCurrency(Number(order.totalAmount));
      const tableLabel = derived.tableName || derived.tableCode || 'table';
      const confirmMsg =
        remainingTickets.length > 0
          ? `Cash pay ${totalLabel} for ${paidOrderNumber} on ${tableLabel}?\n\nOther tickets on this table stay open.\n\nReceipt prints now; sale syncs when online.`
          : `Cash pay ${totalLabel} for ${paidOrderNumber} (${tableLabel})?\n\nReceipt prints now; sale syncs when online.`;
      if (!window.confirm(confirmMsg)) {
        return;
      }
      try {
        const paid = payRestaurantCheckOffline(derived);
        settleCheckOnFloor(paidOrderId, selectedTableId, 'PAID');
        clearLineSelection();
        invalidateMenuStock();
        toast.success(
          remainingTickets.length > 0
            ? `Paid ${paidOrderNumber} (${paid.offlineId}) — ${remainingTickets.length} ticket(s) still open on table`
            : `Paid ${paidOrderNumber} (${paid.offlineId}) — syncs when online`,
        );
        // Sale receipt: never silent — toast disabled / sent / preview / error.
        // Prefer guest-bill printer (same target as working bills).
        void (async () => {
          await printRestaurantSettlementReceipt({
            saleNumber: paid.offlineId,
            saleDate: new Date().toLocaleString(),
            subtotal: paid.subtotal,
            discountAmount: paid.discountAmount,
            taxAmount: paid.taxAmount,
            totalAmount: paid.totalAmount,
            paymentMethod: 'CASH',
            amountPaid: paid.tenderedAmount,
            changeAmount: paid.changeAmount,
            changeGiven: paid.changeAmount,
            payments: paid.payments.map((p) => ({ method: p.paymentMethod, amount: p.amount })),
            cashierName: user?.fullName || user?.email || undefined,
            customerName:
              tableLabel !== 'table' ? `Table ${tableLabel} · ${paidOrderNumber}` : paidOrderNumber,
            companyName: companyBranding.companyName || invoiceBranding?.companyName || undefined,
            companyAddress:
              companyBranding.companyAddress || invoiceBranding?.companyAddress || undefined,
            companyPhone: companyBranding.companyPhone || invoiceBranding?.companyPhone || undefined,
            companyTin: invoiceBranding?.companyTin,
            paymentAccounts: invoiceBranding?.paymentAccounts,
            customReceiptNote: invoiceBranding?.customReceiptNote,
            footerText: invoiceBranding?.footerText,
            items: paid.lines.map((l) => ({
              name: l.productName,
              quantity: l.quantity,
              unitPrice: l.unitPrice,
              subtotal: l.subtotal,
              uom: l.uom,
            })),
          });
        })();

        setActiveOrderId(null);
        returnToFloor();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Pay failed');
      }
      return;
    }

    toast.error('Check not in local journal — open it once while online, then pay offline');
  };

  if (flagLoading) {
    return (
      <Layout>
        <div className="p-6 text-gray-600">Loading restaurant module…</div>
      </Layout>
    );
  }

  if (!restaurantEnabled) {
    return (
      <Layout>
        <div className="p-6 max-w-xl">
          <h1 className="text-xl font-semibold text-gray-900 mb-2">Restaurant Module</h1>
          <p className="text-gray-600 mb-4">
            Restaurant mode is off. Enable it under Settings → Tax &amp; Modules → Enable Restaurant
            Module. Retail POS is unchanged.
          </p>
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div
        data-fill-viewport="true"
        data-pos-tier={tier}
        data-pos-density={chrome.density}
        data-foh-ticket-pane={chrome.fohTicketPane}
        data-pos-height={height}
        data-pos-width={width}
        data-touch-first={touchFirst ? '1' : '0'}
        data-qty-pad={chrome.numericPad}
        data-secondary-ops={chrome.secondaryActions}
        data-list-row={chrome.listRow}
        data-ticket-lines-primary="true"
        style={
          {
            '--pos-cta-min-h': `${ctaMinH}px`,
            '--pos-touch-target': `${tokens.touchTargetPx}px`,
            '--type-caption': `${chrome.typeScale.captionPx}px`,
            '--type-body': `${chrome.typeScale.bodyPx}px`,
            '--type-title': `${chrome.typeScale.titlePx}px`,
            '--type-amount': `${chrome.typeScale.amountPx}px`,
            '--type-cta': `${chrome.typeScale.ctaPx}px`,
          } as CSSProperties
        }
        className="flex-1 min-h-0 flex flex-col bg-stone-100 overflow-hidden"
      >
        <div
          className={`bg-white border-b border-stone-200 flex items-center justify-between gap-2 shrink-0 ${
            isUltraDense
              ? 'px-2 py-1'
              : isTouchDense
                ? 'px-2.5 py-1.5'
                : 'px-3 sm:px-4 py-2.5 sm:py-3'
          }`}
        >
          <div className="min-w-0">
            <h1
              className={`font-semibold text-stone-900 truncate ${
                isTouchDense ? 'text-base' : 'text-lg'
              }`}
            >
              Restaurant POS
            </h1>
            {!isUltraDense ? (
              <p className="text-xs text-stone-500 truncate">
                {selectedTable
                  ? `${selectedTable.name} (${selectedTable.status})`
                  : 'Select a table to begin'}
                {order ? ` · ${order.orderNumber}` : ''}
                {!isTouchDense && meta?.kitchenStatus && meta.kitchenStatus !== 'NONE'
                  ? ` · Kitchen: ${
                      meta.kitchenStatus === 'SENT'
                        ? 'Sent'
                        : meta.kitchenStatus === 'PREPARING'
                          ? 'Preparing'
                          : meta.kitchenStatus === 'READY'
                            ? 'Ready'
                            : meta.kitchenStatus === 'SERVED'
                              ? 'Served'
                              : meta.kitchenStatus
                    }`
                  : ''}
                {isCheckBilled ? ' · Bill printed' : ''}
              </p>
            ) : null}
          </div>
          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
            {!isUltraDense ? (
              <PrinterServiceStatusChip compact showDiagnosticsLink={canManage} />
            ) : null}
            {!selectedTableId && canManage && (
              <button
                type="button"
                onClick={() => setShowAddTable((v) => !v)}
                className={touchBtnGhost}
              >
                {showAddTable ? 'Close' : isTouchDense ? 'Add' : 'Add table'}
              </button>
            )}
            {selectedTableId && (
              <>
                {!isUltraDense ? (
                  <span
                    className={`text-xs px-2 py-1 rounded shrink-0 ${
                      isOnline ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-900'
                    }`}
                  >
                    {isOnline ? 'On' : 'Off'}
                  </span>
                ) : null}
                <button
                  type="button"
                  onClick={() => returnToFloor()}
                  className={`${touchBtnGhost} ${isTouchDense ? 'min-h-9 px-2 text-xs' : ''}`}
                  aria-label="Back to tables"
                >
                  {isTouchDense ? '←' : '← Tables'}
                </button>
              </>
            )}
          </div>
        </div>

        {/* Floor chrome: slim strip (not a card) so dining grid starts immediately below. */}
        {!selectedTableId && (
          <div
            className="px-3 sm:px-4 py-1.5 bg-white border-b border-stone-200 shrink-0"
            data-floor-offline-chrome="true"
          >
            <OfflineSyncStatusPanel compact />
          </div>
        )}

        {!selectedTableId ? (
          <div className="flex-1 overflow-auto p-3 sm:p-4 space-y-3">
            {showAddTable && canManage && (
              <div className="bg-white border border-stone-200 rounded-lg p-4 max-w-xl space-y-3">
                <h2 className="text-sm font-semibold text-stone-800">New table</h2>
                <div className="grid grid-cols-2 gap-3">
                  <input
                    className={touchField}
                    placeholder="Code (e.g. T5)"
                    value={newTable.code}
                    onChange={(e) => setNewTable({ ...newTable, code: e.target.value })}
                  />
                  <input
                    className={touchField}
                    placeholder="Name"
                    value={newTable.name}
                    onChange={(e) => setNewTable({ ...newTable, name: e.target.value })}
                  />
                  <input
                    className={touchField}
                    placeholder="Zone"
                    value={newTable.zone}
                    onChange={(e) => setNewTable({ ...newTable, zone: e.target.value })}
                  />
                  <input
                    type="number"
                    min={0}
                    className={touchField}
                    placeholder="Seats"
                    value={newTable.seats}
                    onChange={(e) =>
                      setNewTable({ ...newTable, seats: Number(e.target.value) || 0 })
                    }
                  />
                </div>
                <button
                  type="button"
                  disabled={!newTable.code.trim() || createTableMutation.isPending}
                  onClick={() => createTableMutation.mutate()}
                  className={touchBtnDark}
                >
                  Save table
                </button>
              </div>
            )}

            {canAccessServiceLanes && (
              <>
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <h2 className="text-sm font-medium text-stone-700 uppercase tracking-wide">
                Service
              </h2>
              <label className={`${TOUCH} min-h-11 px-3 inline-flex items-center gap-3 text-sm text-stone-700 rounded-xl active:bg-stone-200/60`}>
                <input
                  type="checkbox"
                  checked={myTablesOnly}
                  onChange={(e) => setMyTablesOnly(e.target.checked)}
                  disabled={!canEditOthers}
                  className="h-5 w-5 rounded border-stone-300"
                />
                {canEditOthers ? 'My tables only' : 'My tables'}
              </label>
            </div>
            {/* One tile per lane (TA / DL / QK) — no duplicate "Delivery" button + DL table. */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
              {(
                [
                  ['TAKEAWAY', 'Counter / pickup'],
                  ['DELIVERY', 'Customer + address'],
                  ['QUICK', 'Walk-in — no customer'],
                ] as const
              ).map(([kind, blurb]) => {
                const def = SERVICE_LANE_DEFS[kind];
                const table = floorTables.find((t) => t.code.toUpperCase() === def.code);
                const occupied = !!table && table.status !== 'FREE';
                const billing = table?.status === 'BILLING';
                return (
                  <button
                    key={kind}
                    type="button"
                    onClick={() => void openServiceLane(kind)}
                    className={`${touchTile} min-h-[76px] rounded-xl border-2 px-4 py-3 text-left ${
                      billing
                        ? 'border-rose-700 bg-rose-100'
                        : occupied
                          ? 'border-violet-600 bg-violet-100'
                          : 'border-violet-300 bg-violet-50 active:border-violet-600'
                    }`}
                  >
                    <div className="text-base font-bold text-stone-900">{def.name}</div>
                    <div className="text-xs text-stone-600 mt-0.5">
                      {billing
                        ? 'Bill requested'
                        : occupied
                          ? table?.guestName
                            ? table.guestName
                            : table?.orderTotal
                              ? formatCurrency(Number(table.orderTotal))
                              : 'Open ticket'
                          : blurb}
                    </div>
                  </button>
                );
              })}
            </div>
              </>
            )}
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <h2 className="text-sm font-medium text-stone-700 uppercase tracking-wide">
                Dining tables
              </h2>
              {!canAccessServiceLanes && (
                <label
                  className={`${TOUCH} min-h-11 px-3 inline-flex items-center gap-3 text-sm text-stone-700 rounded-xl active:bg-stone-200/60`}
                >
                  <input
                    type="checkbox"
                    checked={myTablesOnly}
                    onChange={(e) => setMyTablesOnly(e.target.checked)}
                    disabled={!canEditOthers}
                    className="h-5 w-5 rounded border-stone-300"
                  />
                  {canEditOthers ? 'My tables only' : 'My tables'}
                </label>
              )}
            </div>
            <div
              className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2.5 sm:gap-3 pb-[env(safe-area-inset-bottom)]"
              data-dining-floor-empty={diningFloorEmpty.isEmpty ? diningFloorEmpty.reason : 'none'}
            >
              {diningFloorTables.map((table) => {
                const occupied = table.status !== 'FREE';
                const billing = table.status === 'BILLING';
                return (
                  <button
                    key={table.id}
                    type="button"
                    onClick={() => setSelectedTableId(table.id)}
                    className={`${touchTile} min-h-[88px] sm:min-h-[96px] rounded-xl border-2 px-3 py-3 text-left shadow-sm ${
                      billing
                        ? 'border-rose-700 bg-rose-100'
                        : occupied
                          ? 'border-amber-500 bg-amber-50'
                          : 'border-stone-300 bg-white active:border-emerald-500'
                    }`}
                  >
                    <div className="text-lg font-bold text-stone-900">{table.code}</div>
                    <div className="text-sm text-stone-600 truncate">{table.name}</div>
                    <div className="text-xs mt-1 text-stone-500">
                      {billing
                        ? 'Bill requested'
                        : occupied
                          ? table.guestName
                            ? table.guestName
                            : Number(table.openCheckCount || 0) > 1
                              ? `${table.openCheckCount} tickets · ${formatCurrency(
                                  Number(table.openChecksTotal ?? table.orderTotal ?? 0),
                                )}`
                              : table.orderTotal
                                ? formatCurrency(Number(table.orderTotal))
                              : table.status
                          : 'Free'}
                    </div>
                    {occupied && Number(table.openCheckCount || 0) > 1 ? (
                      <div className="text-[10px] mt-0.5 font-bold uppercase tracking-wide text-amber-900">
                        {table.openCheckCount} open tickets
                      </div>
                    ) : null}
                    {occupied && table.waiterName ? (
                      <div
                        className={`text-[11px] mt-0.5 truncate font-medium ${
                          table.waiterId && user?.id && table.waiterId !== user.id
                            ? 'text-violet-700'
                            : 'text-stone-600'
                        }`}
                      >
                        {table.waiterId === user?.id
                          ? 'Yours'
                          : shortWaiterLabel(table.waiterName)}
                      </div>
                    ) : null}
                    {occupied
                      ? (() => {
                          const openFor = formatCheckOpenDuration(
                            table.checkOpenedAt,
                            floorClockMs,
                          );
                          return openFor ? (
                            <div className="text-[11px] mt-0.5 font-semibold text-amber-800 tabular-nums">
                              Open {openFor}
                            </div>
                          ) : null;
                        })()
                      : null}
                  </button>
                );
              })}
            </div>
            {diningFloorEmpty.isEmpty && diningFloorEmpty.message && (
              <p
                className={
                  diningFloorEmpty.reason === 'error'
                    ? 'text-red-600 text-sm mt-4'
                    : 'text-stone-600 text-sm mt-4'
                }
                data-dining-floor-empty-message={diningFloorEmpty.reason}
              >
                {diningFloorEmpty.reason === 'error'
                  ? apiErr(
                      tablesQuery.error,
                      diningFloorEmpty.message,
                    )
                  : diningFloorEmpty.message}
              </p>
            )}
          </div>
        ) : (
          <div
            // Column mode: minmax ticket track so 10"/1366 laptops never crush KOT/Bill.
            className={`relative flex-1 min-h-0 flex flex-col overflow-hidden ${
              useSheetTicket
                ? ''
                : 'lg:grid lg:grid-rows-1 lg:grid-cols-[minmax(0,1fr)_minmax(19rem,24rem)] xl:grid-cols-[minmax(0,1fr)_minmax(22rem,28rem)]'
            }`}
          >
            {/* Menu — sheet mode: full remaining height; column mode: fluid left track */}
            <div
              className={`flex flex-col min-h-0 min-w-0 flex-1 lg:h-full border-b lg:border-b-0 lg:border-r border-stone-200 bg-white ${
                useSheetTicket ? 'max-h-none' : 'max-h-[42%] lg:max-h-none'
              }`}
              data-foh-menu-surface="true"
              data-foh-menu-full={useSheetTicket ? '1' : '0'}
            >
              <div className="shrink-0 z-10 bg-white border-b border-stone-100 shadow-sm">
                <div className="p-3 pb-2">
                  <label className="relative block">
                    <span className="sr-only">Search products</span>
                    <Search
                      className="pointer-events-none absolute left-3 top-1/2 z-[1] -translate-y-1/2 h-5 w-5 text-stone-400"
                      aria-hidden
                    />
                    <SearchSoftKeyboardInput
                      inputRef={searchInputRef}
                      value={menuSearch}
                      onChange={setMenuSearch}
                      selectOnFocus
                      enterLabel="Add"
                      onEnter={() => {
                        if (quickAddProduct) {
                          addItemMutation.mutate(quickAddProduct, {
                            onSuccess: () => setMenuSearch(''),
                          });
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') {
                          e.preventDefault();
                          setMenuSearch('');
                          (e.target as HTMLInputElement).blur();
                        }
                      }}
                      placeholder="Search menu — name, category, station"
                      aria-label="Search products"
                      wrapClassName="w-full"
                      toggleClassName="right-1.5 h-10 w-10 rounded-xl"
                      className="w-full min-h-12 h-12 pl-11 pr-24 rounded-xl border border-stone-300 bg-stone-50 text-base text-stone-900 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 focus:bg-white touch-manipulation"
                    />
                    {menuSearch ? (
                      <button
                        type="button"
                        aria-label="Clear search"
                        onClick={() => {
                          setMenuSearch('');
                          requestSoftKeyboard(searchInputRef.current);
                        }}
                        className={`${TOUCH} absolute right-12 top-1/2 z-[2] -translate-y-1/2 h-10 w-10 inline-flex items-center justify-center rounded-xl text-stone-500 active:bg-stone-200`}
                      >
                        <X className="h-5 w-5" />
                      </button>
                    ) : null}
                  </label>
                  {deferredMenuSearch.trim() ? (
                    <p className="mt-1.5 text-xs text-stone-500">
                      {visibleProducts.length === 0
                        ? 'No matches'
                        : `${visibleProducts.length} match${visibleProducts.length === 1 ? '' : 'es'}`}
                      {quickAddProduct ? ' · Enter to add' : ''}
                      {selectedCategoryId ? ' · across all categories' : ''}
                    </p>
                  ) : shouldShowCoach(chrome, 'coach') ? (
                    <p className="mt-1.5 text-xs text-stone-400" data-pos-coach="menu">
                      {chrome.coach === 'full'
                        ? 'Qty pad → product (e.g. 50 → Matooke)'
                        : 'Qty then product'}
                    </p>
                  ) : null}
                </div>
                {/* Touch tiers: horizontal category chips (Toast/Samba) */}
                {chrome.categoryNav === 'chips' ? (
                <div className="px-3 pb-3 overflow-x-auto">
                  <div className="flex gap-2 min-w-max">
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedCategoryId(null);
                        setMenuSearch('');
                      }}
                      className={`${touchCat} ${
                        !selectedCategoryId && !deferredMenuSearch.trim()
                          ? 'bg-orange-600 text-white'
                          : 'bg-stone-200 text-stone-900 active:bg-stone-300'
                      }`}
                    >
                      All
                    </button>
                    {(categoriesQuery.data || []).map((cat) => (
                      <button
                        key={cat.id}
                        type="button"
                        onClick={() => {
                          setSelectedCategoryId(cat.id);
                          setMenuSearch('');
                        }}
                        className={`${touchCat} ${
                          selectedCategoryId === cat.id && !deferredMenuSearch.trim()
                            ? 'bg-orange-600 text-white'
                            : 'bg-stone-200 text-stone-900 active:bg-stone-300'
                        }`}
                      >
                        {cat.name}
                      </button>
                    ))}
                  </div>
                </div>
                ) : null}
              </div>

              <div className="flex flex-1 min-h-0">
                {/* Desktop/wide: vertical category rail */}
                {chrome.categoryNav === 'rail' ? (
                <div className="flex w-40 shrink-0 flex-col border-r border-stone-200 bg-stone-100 overflow-y-auto">
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedCategoryId(null);
                      setMenuSearch('');
                    }}
                    className={`${touchCatRail} ${
                      !selectedCategoryId && !deferredMenuSearch.trim()
                        ? 'bg-orange-600 text-white'
                        : 'text-stone-900 active:bg-stone-200'
                    }`}
                  >
                    All
                  </button>
                  {(categoriesQuery.data || []).map((cat) => (
                    <button
                      key={cat.id}
                      type="button"
                      onClick={() => {
                        setSelectedCategoryId(cat.id);
                        setMenuSearch('');
                      }}
                      className={`${touchCatRail} ${
                        selectedCategoryId === cat.id && !deferredMenuSearch.trim()
                          ? 'bg-orange-600 text-white'
                          : 'text-stone-900 active:bg-stone-200'
                      }`}
                    >
                      {cat.name}
                    </button>
                  ))}
                </div>
                ) : null}

                <div className="flex-1 flex flex-col min-h-0 min-w-0">
                  {showSambaTicketList ? (
                    <div
                      className="shrink-0 px-3 py-2 bg-amber-50 border-b border-amber-200 text-amber-950 type-caption font-semibold"
                      data-menu-party-gate="true"
                    >
                      Select a ticket on the right to add items — or use + for a new ticket
                    </div>
                  ) : null}
                  <div className="flex-1 overflow-auto p-3 pb-3">
                    <div
                      className={`grid gap-2.5 ${
                        useSheetTicket
                          ? 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4'
                          : 'grid-cols-2 sm:grid-cols-3 xl:grid-cols-4'
                      }`}
                    >
                      {visibleProducts.map((product) => (
                        <button
                          key={product.id}
                          type="button"
                          disabled={showSambaTicketList}
                          onClick={() => {
                            if (showSambaTicketList) {
                              toast.error('Select a ticket to add items', {
                                id: 'select-ticket-first',
                              });
                              if (useSheetTicket) setMobileSheet('order');
                              return;
                            }
                            addItemMutation.mutate(product, {
                              onSuccess: () => {
                                if (menuSearch.trim()) setMenuSearch('');
                              },
                            });
                          }}
                          className={`${touchTile} min-h-[72px] sm:min-h-[84px] min-w-0 rounded-xl border border-emerald-700/40 bg-emerald-50/80 px-3 py-2.5 sm:py-3 text-left active:bg-emerald-100 active:border-emerald-600 disabled:opacity-50 disabled:active:bg-emerald-50/80`}
                          title={
                            showSambaTicketList
                              ? 'Select a ticket first'
                              : undefined
                          }
                          data-menu-add-gated={showSambaTicketList ? 'party-list' : 'ready'}
                        >
                          <div className="type-body type-ellipsis font-semibold text-stone-900">
                            {product.name}
                          </div>
                          {deferredMenuSearch.trim() && product.categoryName ? (
                            <div className="type-caption type-ellipsis text-stone-500 mt-0.5">
                              {product.categoryName}
                            </div>
                          ) : null}
                          <div className="flex items-baseline justify-between gap-2 mt-1 min-w-0">
                            <div className="type-amount type-ellipsis text-stone-600 font-medium">
                              {formatCurrency(Number(product.sellingPrice))}
                            </div>
                            {(() => {
                              const stockLabel = formatRestaurantMenuStockLabel({
                                productType: product.productType,
                                availableQty: product.remainingQuantity,
                                orderedQty: product.orderedQuantity,
                              });
                              if (!stockLabel.show) return null;
                              return (
                              <div
                                className={`shrink-0 type-caption tabular-nums font-semibold ${
                                  Number(stockLabel.available) <= 0
                                    ? 'text-red-700'
                                    : Number(stockLabel.available) <= 5
                                      ? 'text-amber-700'
                                      : 'text-stone-500'
                                }`}
                                data-menu-remaining-qty={product.id}
                                data-menu-ordered-qty={product.orderedQuantity ?? 0}
                                title="Available after kitchen issues · ordered on open checks"
                              >
                                {stockLabel.label}
                              </div>
                              );
                            })()}
                          </div>
                        </button>
                      ))}
                    </div>
                    {!productsQuery.isLoading && visibleProducts.length === 0 && (
                      <p className="text-sm text-stone-500 p-4">
                        {deferredMenuSearch.trim()
                          ? 'No products match that search.'
                          : 'No menu products. Ensure active products exist (all show until any are flagged Available in Restaurant).'}
                      </p>
                    )}
                  </div>

                  {/* Qty pad — icon-sheet on touch tiers; docked calculator on desktop/wide */}
                  <div className="shrink-0 border-t border-stone-200 bg-stone-100/80">
                    {chrome.numericPad === 'icon-sheet' ? (
                    <div className="flex items-stretch gap-1 p-1.5" data-qty-pad-surface="icon-sheet">
                      <button
                        type="button"
                        aria-label="Open quantity pad"
                        onClick={() => setMenuQtyPadOpen(true)}
                        className={`${TOUCH} flex min-w-[4.25rem] flex-col items-center justify-center rounded-xl border-2 border-emerald-600 bg-emerald-50 px-2 py-1`}
                      >
                        <span className="type-caption font-bold uppercase tracking-wider text-emerald-800">
                          Qty
                        </span>
                        <span className="type-title font-bold tabular-nums leading-none text-stone-900">
                          {parsePendingOrderQty(pendingQtyDigits)}
                        </span>
                      </button>
                      {[1, 2, 3, 5, 10].map((n) => {
                        const active = pendingQtyDigits === String(n);
                        return (
                          <button
                            key={n}
                            type="button"
                            aria-label={`Quantity ${n}`}
                            aria-pressed={active}
                            onClick={() => setPendingQtyDigits(String(n))}
                            className={`${TOUCH} min-h-11 flex-1 rounded-xl text-sm font-bold ${
                              active
                                ? 'border-2 border-emerald-600 bg-emerald-600 text-white'
                                : 'border border-stone-300 bg-white text-stone-900 active:bg-emerald-50'
                            }`}
                          >
                            {n}
                          </button>
                        );
                      })}
                      <button
                        type="button"
                        aria-label="Clear quantity"
                        onClick={() => setPendingQtyDigits('')}
                        className={`${TOUCH} min-h-11 min-w-11 rounded-xl border border-stone-300 bg-white text-xs font-bold text-stone-600`}
                      >
                        C
                      </button>
                      <button
                        type="button"
                        aria-label="Number pad"
                        onClick={() => setMenuQtyPadOpen(true)}
                        className={`${TOUCH} min-h-11 min-w-11 rounded-xl border border-stone-800 bg-stone-900 text-[11px] font-bold text-white`}
                      >
                        123
                      </button>
                    </div>
                    ) : (
                    <div className="flex items-stretch gap-2 p-2" data-qty-pad-surface="docked">
                      <div className="w-[5.5rem] rounded-xl border-2 border-emerald-600 bg-emerald-50 flex flex-col items-center justify-center px-2">
                        <span className="type-caption font-bold uppercase tracking-wide text-emerald-800">
                          Qty
                        </span>
                        <span className="type-title font-bold tabular-nums leading-none text-stone-900">
                          {parsePendingOrderQty(pendingQtyDigits)}
                        </span>
                      </div>
                      <div className="flex-1 grid grid-cols-3 gap-1.5 max-w-xs">
                        {['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫'].map((key) => (
                          <button
                            key={key}
                            type="button"
                            className={`${TOUCH} min-h-12 rounded-xl border border-stone-300 bg-white text-lg font-bold text-stone-900 active:bg-emerald-100 ${
                              key === 'C' || key === '⌫' ? 'text-sm text-stone-600' : ''
                            }`}
                            onClick={() => {
                              if (key === 'C') {
                                setPendingQtyDigits('');
                                return;
                              }
                              if (key === '⌫') {
                                setPendingQtyDigits((p) => p.slice(0, -1));
                                return;
                              }
                              setPendingQtyDigits((prev) => appendQtyDigit(prev, key));
                            }}
                          >
                            {key}
                          </button>
                        ))}
                      </div>
                      <div className="flex flex-col gap-1.5 justify-stretch">
                        {[5, 10, 20].map((n) => (
                          <button
                            key={n}
                            type="button"
                            onClick={() => setPendingQtyDigits(String(n))}
                            className={`${TOUCH} min-h-12 min-w-14 rounded-xl border border-stone-300 bg-stone-50 text-sm font-bold text-stone-800 active:bg-emerald-100 ${
                              pendingQtyDigits === String(n)
                                ? 'border-emerald-600 bg-emerald-600 text-white'
                                : ''
                            }`}
                          >
                            {n}
                          </button>
                        ))}
                      </div>
                    </div>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* On-demand qty dialer — only when chrome is icon-sheet */}
            {menuQtyPadOpen && chrome.numericPad === 'icon-sheet' && (
              <div className="fixed inset-0 z-[55] flex flex-col justify-end bg-black/40">
                <button
                  type="button"
                  className="flex-1 w-full cursor-default"
                  aria-label="Dismiss quantity pad"
                  onClick={() => setMenuQtyPadOpen(false)}
                />
                <div className="relative w-full bg-white rounded-t-2xl p-4 space-y-3 shadow-xl pb-[max(1rem,env(safe-area-inset-bottom))]">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-xs font-bold uppercase tracking-wide text-stone-500">
                        Quantity
                      </p>
                      <p className="text-sm text-stone-600">Then tap a product on the menu</p>
                    </div>
                    <button
                      type="button"
                      className={`${touchBtnGhost} min-h-10 px-3`}
                      onClick={() => setMenuQtyPadOpen(false)}
                    >
                      <X className="h-5 w-5" />
                    </button>
                  </div>
                  <div className="rounded-xl border-2 border-emerald-600 bg-emerald-50 py-4 text-center">
                    <span className="text-5xl font-bold tabular-nums text-stone-900">
                      {pendingQtyDigits || '1'}
                    </span>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫'].map((key) => (
                      <button
                        key={key}
                        type="button"
                        className={`${TOUCH} min-h-14 rounded-xl border border-stone-300 bg-stone-50 text-2xl font-bold text-stone-900 active:bg-emerald-100`}
                        onClick={() => {
                          if (key === 'C') {
                            setPendingQtyDigits('');
                            return;
                          }
                          if (key === '⌫') {
                            setPendingQtyDigits((p) => p.slice(0, -1));
                            return;
                          }
                          setPendingQtyDigits((prev) => appendQtyDigit(prev, key));
                        }}
                      >
                        {key}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    className={`${touchBtnDark} w-full min-h-14`}
                    onClick={() => setMenuQtyPadOpen(false)}
                  >
                    Done — tap a product
                  </button>
                </div>
              </div>
            )}

            {/* Order ticket — sheet mode: full overlay on demand; else minmax side column */}
            <div
              className={
                useSheetTicket
                  ? mobileSheet === 'order'
                    ? 'fixed inset-0 z-[45] flex flex-col min-h-0 overflow-hidden bg-stone-50'
                    : 'hidden'
                  : 'flex flex-col min-h-0 min-w-0 w-full lg:w-auto lg:h-full overflow-hidden bg-stone-50 relative'
              }
              data-samba-ticket-view={showSambaTicketList ? 'list' : 'detail'}
              data-multi-ticket={isMultiTicketTable ? '1' : '0'}
              data-foh-ticket-surface={useSheetTicket ? 'sheet' : 'column'}
              data-foh-ticket-open={
                useSheetTicket ? (mobileSheet === 'order' ? '1' : '0') : '1'
              }
              aria-hidden={useSheetTicket && mobileSheet !== 'order' ? true : undefined}
            >
              <div
                className={`border-b border-stone-200 bg-white shrink-0 ${
                  isTouchDense ? 'px-2.5 py-1.5' : 'px-3 sm:px-4 py-2'
                }`}
              >
                {useSheetTicket ? (
                  <div className="flex items-center gap-2 mb-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        if (showSambaTicketList) {
                          returnToFloor();
                          return;
                        }
                        setMobileSheet(null);
                      }}
                      className={`${touchBtnGhost} min-h-10 px-3 text-sm font-bold shrink-0`}
                      data-foh-menu-return="true"
                      data-foh-party-exit={showSambaTicketList ? 'tables' : 'menu'}
                      aria-label={showSambaTicketList ? 'Back to tables' : 'Back to menu'}
                    >
                      {showSambaTicketList ? '← Tables' : '← Menu'}
                    </button>
                    <p className="text-xs text-stone-500 min-w-0 truncate">
                      {selectedTable?.code || selectedTable?.name || 'Table'}
                      {isMultiTicketTable ? ` · ${ticketTabs.length} tickets` : ''}
                    </p>
                  </div>
                ) : null}
                {showSambaTicketList ? (
                  /* Samba party header: pick a ticket before ordering */
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <h2
                        className={`font-bold tracking-tight text-stone-900 truncate ${
                          isTouchDense ? 'text-xl' : 'text-2xl sm:text-3xl'
                        }`}
                        data-samba-party-title="true"
                      >
                        {selectedTable?.code || selectedTable?.name || 'Table'}
                        {isTouchDense ? (
                          <span className="ml-1.5 text-xs font-semibold text-stone-500 tabular-nums">
                            · {ticketTabs.length}
                          </span>
                        ) : null}
                      </h2>
                      <p
                        className={`text-stone-600 mt-0.5 ${isTouchDense ? 'type-caption' : 'text-xs'}`}
                        data-samba-party-coach="true"
                      >
                        Select a ticket to add items
                        {!isTouchDense ? ` · ${ticketTabs.length} open` : ''}
                      </p>
                    </div>
                    <div className="text-right shrink-0 flex items-center gap-1.5">
                      <p
                        className={`font-bold tabular-nums text-stone-900 leading-none ${
                          isTouchDense ? 'text-lg' : 'text-2xl sm:text-3xl'
                        }`}
                      >
                        {formatCurrency(partyTicketsTotal)}
                      </p>
                      {canOrder && isOnline ? (
                        <button
                          type="button"
                          onClick={() => void openNewTicketOnTable()}
                          disabled={busy}
                          className={`${touchChip} border-2 border-dashed border-emerald-500/70 bg-emerald-50 text-emerald-900 type-cta font-bold disabled:opacity-50 ${
                            chrome.actionLabels === 'short' ? 'min-h-9 min-w-9 px-1.5' : 'min-h-9 px-2'
                          }`}
                          title="New independent ticket on this table"
                          aria-label="New ticket on this table"
                        >
                          {newTicketLabel}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => setMobileSheet('more')}
                        className={`${touchBtnGhost} min-h-9 min-w-9 px-2 text-xs`}
                        aria-label="More table actions"
                        title="More"
                      >
                        ⋯
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                <div className="flex items-center justify-between gap-2 min-w-0">
                  <div className="flex items-center gap-1.5 min-w-0 flex-1 overflow-hidden">
                    {isMultiTicketTable ? (
                      <button
                        type="button"
                        onClick={backToPartyTicketList}
                        className={`${touchBtnGhost} type-caption font-bold shrink-0 ${
                          isTouchDense ? 'min-h-9 px-2' : 'min-h-10 px-2.5'
                        }`}
                        aria-label="Back to all tickets on this table"
                        title="All tickets"
                        data-samba-tickets-back="true"
                      >
                        {chrome.actionLabels === 'short' ? '←' : '← Tickets'}
                      </button>
                    ) : null}
                    <div className="min-w-0 flex-1 overflow-hidden" data-ticket-title="true">
                      <h2 className="type-title font-semibold text-stone-900 type-ellipsis whitespace-nowrap">
                        {order?.orderNumber ? (
                          <>
                            <span className="font-medium text-stone-600">Ticket </span>
                            <span className="font-bold tabular-nums">{order.orderNumber}</span>
                          </>
                        ) : (
                          'Ticket'
                        )}
                        {loadingTicketId && loadingTicketId === order?.id ? (
                          <span className="ml-2 type-caption font-semibold uppercase tracking-wide text-sky-700">
                            Loading…
                          </span>
                        ) : null}
                      </h2>
                      {isCheckBilled ? (
                        <p className="type-caption text-rose-800 type-ellipsis">Guest bill printed</p>
                      ) : order ? (
                        <p className="type-caption text-stone-500 type-ellipsis">
                          {orderLines.length} line{orderLines.length === 1 ? '' : 's'} ·{' '}
                          {formatCurrency(Number(order.totalAmount || 0))}
                          {chrome.coach !== 'hidden' && !isTouchDense ? ' · tap menu to add' : ''}
                        </p>
                      ) : (
                        <p className="type-caption text-stone-500 type-ellipsis">
                          {showSambaTicketList
                            ? 'Select a ticket or start a new one'
                            : loadingTicketId
                              ? 'Loading ticket…'
                              : 'Tap the menu to start the first ticket'}
                        </p>
                      )}
                      {(selectedCustomer?.name || guestDraft.guestName) ? (
                        <p className="type-caption font-semibold text-emerald-800 type-ellipsis">
                          {selectedCustomer?.name || guestDraft.guestName}
                        </p>
                      ) : null}
                    </div>
                  </div>
                  {/* Adaptive: order # owns space; Note lives in ··· when secondaryActions=sheet */}
                  <div
                    className="flex items-center gap-1 shrink-0"
                    data-ticket-header-actions="true"
                    data-secondary-ops={chrome.secondaryActions}
                  >
                      {isCheckBilled ? (
                        <span className="type-caption uppercase tracking-wide font-bold text-rose-800 bg-rose-100 px-1.5 py-1 rounded-md">
                          Bill
                        </span>
                      ) : null}
                      {!isMultiTicketTable && canOrder && isOnline ? (
                        <button
                          type="button"
                          onClick={() => void openNewTicketOnTable()}
                          disabled={busy}
                          className={`${touchChip} border-2 border-dashed border-emerald-500/70 bg-emerald-50 text-emerald-900 type-cta font-bold disabled:opacity-50 ${
                            chrome.actionLabels === 'short'
                              ? 'min-h-9 min-w-9 px-1.5'
                              : 'min-h-9 px-2'
                          }`}
                          title="Open another ticket for this table"
                          aria-label="New ticket on this table"
                          data-ticket-new="header"
                        >
                          {newTicketLabel}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => setMobileSheet('details')}
                        className={`${touchBtnGhost} min-h-10 inline-flex items-center gap-1 ${
                          chrome.actionLabels === 'short'
                            ? 'min-w-10 px-2'
                            : 'px-2.5 max-w-[7.5rem]'
                        }`}
                        aria-label="Waiter and customer"
                        title="Waiter / Customer"
                        data-restaurant-party="open"
                      >
                        <span aria-hidden>👤</span>
                        {chrome.actionLabels === 'short' ? null : (
                          <span className="type-ellipsis type-caption font-semibold text-stone-800">
                            {selectedCustomer?.name || guestDraft.guestName
                              ? (selectedCustomer?.name || guestDraft.guestName)
                              : shortWaiterLabel(
                                  waiters.find((w) => w.id === selectedWaiterId)?.fullName ||
                                    user?.fullName ||
                                    'Waiter',
                                ) || 'Guest'}
                          </span>
                        )}
                      </button>
                      {order ? (
                        <button
                          type="button"
                          onClick={openTicketNoteEditor}
                          disabled={!canOrder && !ticketNote}
                          className={`${touchBtnGhost} min-h-10 px-2 type-caption font-bold ${
                            ticketNote
                              ? 'border-amber-400 bg-amber-50 text-amber-950'
                              : inlineTicketNote
                                ? ''
                                : 'shrink-0'
                          }`}
                          aria-label="Ticket note"
                          title="Note on this ticket only"
                          data-ticket-note="open"
                        >
                          Note
                          {ticketNote ? (
                            <span className="ml-0.5 text-amber-700" aria-hidden>
                              ●
                            </span>
                          ) : null}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => setMobileSheet('more')}
                        className={`${touchBtnGhost} min-h-10 min-w-10 px-2 type-cta`}
                        aria-label="Change table, note, merge, and more"
                        title="Table / Note / Merge / More"
                        data-ticket-more="open"
                      >
                        ⋯
                      </button>
                    </div>
                </div>
                  </>
                )}
              </div>

              {/* Cart body: Samba multi-ticket list OR single-ticket lines */}
              <div
                ref={ticketLinesRef}
                className={`flex-1 basis-0 min-h-0 overflow-y-auto overscroll-contain block bg-white ${
                  isTouchDense ? 'px-2 py-1' : 'px-3 sm:px-4 py-2'
                }`}
                data-ticket-lines="true"
                data-active-ticket={order?.id || ''}
                data-ticket-body={showSambaTicketList ? 'party-list' : 'lines'}
              >
                {showSambaTicketList ? (
                  <ul
                    className={isTouchDense ? 'space-y-1' : 'divide-y divide-stone-200'}
                    role="listbox"
                    aria-label="Open tickets on this table"
                    data-samba-ticket-list="true"
                    data-list-dense={isTouchDense ? '1' : '0'}
                  >
                    {ticketTabs.map((s, idx) => {
                      const active = s.id === order?.id || s.id === activeOrderId;
                      const loading = loadingTicketId === s.id;
                      const colors = partyTicketColor(idx);
                      const billed = isRestaurantOrderBillRequestedOffline(
                        selectedTableId,
                        s.id,
                      );
                      const noteText = s.note || '';
                      return (
                        <li key={s.id} role="none" className={isTouchDense ? '' : 'py-1'}>
                          <button
                            type="button"
                            role="option"
                            aria-selected={active}
                            aria-label={
                              noteText
                                ? `Open ticket ${s.orderNumber}, note ${noteText}`
                                : `Open ticket ${s.orderNumber}`
                            }
                            onClick={() => openTicketFromList(s.id)}
                            className={`${TOUCH} w-full flex flex-col text-left rounded-lg transition-colors ${
                              isTouchDense
                                ? 'gap-0.5 min-h-11 px-2.5 py-1.5'
                                : 'gap-1 min-h-[3.75rem] px-3 py-2.5'
                            } ${active ? colors.active : colors.idle}`}
                          >
                            <div className="w-full flex items-center justify-between gap-2">
                              <span
                                className={`font-bold tabular-nums tracking-tight inline-flex items-center gap-1.5 min-w-0 ${
                                  isTouchDense ? 'text-base' : 'text-xl sm:text-2xl'
                                }`}
                              >
                                <span className="truncate">{s.orderNumber}</span>
                                {loading ? (
                                  <span className="text-sm font-semibold opacity-80">…</span>
                                ) : null}
                                {billed ? (
                                  <span
                                    className={`shrink-0 text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded ${
                                      active
                                        ? 'bg-white/20 text-white'
                                        : 'bg-rose-600 text-white'
                                    }`}
                                  >
                                    Bill
                                  </span>
                                ) : null}
                              </span>
                              <span
                                className={`font-bold tabular-nums tracking-tight shrink-0 ${
                                  isTouchDense ? 'text-base' : 'text-xl sm:text-2xl'
                                }`}
                              >
                                {formatCurrency(Number(s.totalAmount))}
                              </span>
                            </div>
                            {noteText ? (
                              <span
                                className={`block leading-snug w-full ${
                                  isTouchDense ? 'text-xs line-clamp-1' : 'text-sm line-clamp-2'
                                } ${active ? 'text-white/95' : 'text-stone-800'}`}
                                data-ticket-list-note="true"
                              >
                                {noteText}
                              </span>
                            ) : null}
                          </button>
                        </li>
                      );
                    })}
                    {ticketTabs.length === 0 ? (
                      <li className="py-8 text-center text-sm text-stone-500">
                        No open tickets — use + Ticket
                      </li>
                    ) : null}
                  </ul>
                ) : loadingTicketId && loadingTicketId === (order?.id || activeOrderId) && orderLines.length === 0 ? (
                  <div className="py-8 text-center space-y-2">
                    <p className="text-sm font-semibold text-stone-700">Loading ticket…</p>
                    <p className="text-xs text-stone-500">
                      Items for this ticket will appear here
                    </p>
                  </div>
                ) : (
                  <>
                    {ticketNoteOnCheck.paint === 'on-check' ? (
                      <TicketNotePreview
                        note={ticketNoteOnCheck.visibleText}
                        dense={isTouchDense}
                        clamp="2"
                        canOrder={!!canOrder}
                        onEdit={openTicketNoteEditor}
                        preview={orderLines.length === 0 ? 'empty' : 'true'}
                      />
                    ) : null}
                {orderLines.length === 0 ? (
                  <div
                    className="py-4 lg:py-8 text-center space-y-3 px-3"
                    data-ticket-empty="true"
                  >
                    <p className="text-sm text-stone-500">
                      {order
                        ? 'This ticket is empty — add items from the menu'
                        : 'Tap the menu to start the first ticket'}
                    </p>
                    {useSheetTicket ? (
                      <button
                        type="button"
                        onClick={() => setMobileSheet(null)}
                        className={`${touchBtn} bg-emerald-600 text-white min-h-12 px-4 w-full max-w-xs mx-auto`}
                        data-foh-empty-browse-menu="true"
                        aria-label="Browse menu to add items"
                      >
                        Browse menu
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => returnToFloor()}
                      className={`${touchBtnGhost} min-h-12 px-4`}
                      data-ticket-empty-back-floor="true"
                    >
                      ← Back to tables
                    </button>
                  </div>
                ) : ticketGroups.length === 0 ? (
                  <div className="py-4 text-center text-sm text-stone-500">
                    {orderLines.length} line{orderLines.length === 1 ? '' : 's'} on check — refresh if
                    names do not appear.
                  </div>
                ) : (
                  <ul
                    className={chrome.listRow === 'dense' ? 'space-y-1' : 'space-y-2'}
                    role="listbox"
                    aria-label="Ticket lines"
                    aria-multiselectable="true"
                    data-list-row={chrome.listRow}
                  >
                    {ticketGroups.map((group) => {
                      const selected = group.itemIds.every((id) => selectedLineIds.includes(id));
                      const partially =
                        !selected && group.itemIds.some((id) => selectedLineIds.includes(id));
                      const dense = chrome.listRow === 'dense';
                      const sameLineEditors = inlineRowEditorsOnSameLine(chrome);
                      const st = ticketLineStatus(group.kitchenSent, isCheckBilled);
                      const showQtyEditors =
                        showInlineRowEditors(chrome) && !group.kitchenSent && !!group.productId;
                      const qtyEditors = showQtyEditors ? (
                        <div
                          className={`inline-flex items-center gap-0.5 shrink-0 ${
                            sameLineEditors ? '' : 'mt-2'
                          }`}
                          onClick={(e) => e.stopPropagation()}
                          data-foh-line-qty-editors="true"
                          data-row-editors={sameLineEditors ? 'same-line' : 'stacked'}
                        >
                          <button
                            type="button"
                            aria-label="Decrease quantity"
                            disabled={busy}
                            onClick={() => void handleLineMinusOne(group)}
                            className={`${TOUCH} ${
                              sameLineEditors ? 'min-h-9 min-w-9 text-base' : 'min-h-10 min-w-10 text-lg'
                            } rounded-lg border border-stone-300 bg-stone-50 font-bold text-stone-800`}
                            data-foh-qty-dec="true"
                          >
                            −
                          </button>
                          {!sameLineEditors ? (
                            <button
                              type="button"
                              aria-label="Set quantity"
                              disabled={busy}
                              onClick={() => handleLineSetQty(group)}
                              className={`${TOUCH} min-h-10 min-w-12 rounded-lg border border-stone-300 bg-white text-sm font-bold text-stone-900`}
                            >
                              {group.quantity}
                            </button>
                          ) : (
                            <button
                              type="button"
                              aria-label="Set quantity"
                              disabled={busy}
                              onClick={() => handleLineSetQty(group)}
                              className={`${TOUCH} min-h-9 min-w-9 rounded-lg border border-stone-300 bg-white text-xs font-bold tabular-nums text-stone-900`}
                            >
                              {group.quantity}
                            </button>
                          )}
                          <button
                            type="button"
                            aria-label="Increase quantity"
                            disabled={busy}
                            onClick={() => void handleLinePlusOne(group)}
                            className={`${TOUCH} ${
                              sameLineEditors ? 'min-h-9 min-w-9 text-base' : 'min-h-10 min-w-10 text-lg'
                            } rounded-lg border border-stone-300 bg-stone-50 font-bold text-stone-800`}
                            data-foh-qty-inc="true"
                          >
                            +
                          </button>
                        </div>
                      ) : null;
                      return (
                        <li
                          key={group.key}
                          role="option"
                          aria-selected={selected}
                          className={`flex justify-between gap-1.5 border-2 rounded-xl cursor-pointer ${
                            dense
                              ? 'text-sm px-2 py-1.5 items-center min-h-[44px]'
                              : 'text-sm px-3 py-3 items-start'
                          } ${
                            selected
                              ? 'border-amber-500 bg-amber-100 shadow-[inset_0_0_0_1px_rgba(245,158,11,0.45)] ring-2 ring-amber-400/50'
                              : partially
                                ? 'border-amber-300 bg-amber-50'
                                : 'border-stone-200 bg-white active:bg-stone-50'
                          }`}
                          onClick={() => toggleGroupSelection(group)}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            setLineSheet(group);
                          }}
                        >
                          <div
                            className={`min-w-0 flex-1 flex gap-2 ${
                              dense ? 'items-center' : 'items-start'
                            }`}
                          >
                            <span
                              className={`${TOUCH} ${dense ? '' : 'mt-0.5'} inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border-2 text-xs font-bold ${
                                selected
                                  ? 'border-amber-600 bg-amber-600 text-white'
                                  : partially
                                    ? 'border-amber-400 bg-amber-200 text-amber-900'
                                    : 'border-stone-300 bg-white text-transparent'
                              }`}
                              aria-hidden
                            >
                              {partially && !selected ? '–' : '✓'}
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5 min-w-0">
                                <div
                                  className={`font-medium min-w-0 type-body ${
                                    dense ? 'type-ellipsis' : 'type-clamp-2'
                                  } ${selected ? 'text-amber-950' : 'text-stone-900'}`}
                                >
                                  <span className="type-amount">{group.quantity}</span>
                                  <span className="text-stone-400 font-normal"> × </span>
                                  {group.productName}
                                </div>
                                {dense ? (
                                  <span
                                    className={`shrink-0 type-caption uppercase tracking-wide font-semibold ${st.className}`}
                                  >
                                    {st.label}
                                  </span>
                                ) : null}
                              </div>
                              {group.lineNotes ? (
                                <div className="type-caption font-medium text-amber-800 mt-0.5 type-ellipsis">
                                  * {group.lineNotes}
                                </div>
                              ) : null}
                              {group.orderedByLabel || group.addedAtLabel ? (
                                <div className="text-[11px] font-semibold text-violet-800 mt-0.5 truncate">
                                  {group.orderedByLabel
                                    ? `Ordered by ${group.orderedByLabel}`
                                    : null}
                                  {group.orderedByLabel && group.addedAtLabel ? ' · ' : null}
                                  {group.addedAtLabel ? group.addedAtLabel : null}
                                </div>
                              ) : null}
                              {!dense ? (
                                <div className="mt-0.5 flex flex-wrap items-center gap-2">
                                  <span
                                    className={`text-[10px] uppercase tracking-wide font-semibold ${st.className}`}
                                  >
                                    {st.label}
                                  </span>
                                  {selected ? (
                                    <span className="text-[11px] font-bold uppercase tracking-wide text-amber-800">
                                      Selected
                                    </span>
                                  ) : chrome.selectHints ? (
                                    <span className="text-[11px] text-stone-400">Tap to select</span>
                                  ) : null}
                                </div>
                              ) : null}
                              {/* Comfortable: ± stacked under name */}
                              {!sameLineEditors ? qtyEditors : null}
                            </div>
                          </div>
                          <div
                            className={`flex shrink-0 items-center gap-1 ${
                              dense ? '' : 'flex-col items-end gap-1'
                            }`}
                          >
                            {/* Dense: ± relocated onto the same row as name / total */}
                            {sameLineEditors ? qtyEditors : null}
                            <div
                              className={`type-amount type-ellipsis font-medium ${
                                selected ? 'text-amber-950' : 'text-stone-700'
                              }`}
                            >
                              {formatCurrency(group.lineTotal)}
                            </div>
                            <button
                              type="button"
                              aria-label="Line actions"
                              disabled={busy}
                              onClick={(e) => {
                                e.stopPropagation();
                                setLineSheet(group);
                              }}
                              className={`${TOUCH} min-h-9 min-w-9 px-2 rounded-lg text-sm font-bold border border-stone-300 bg-stone-50 text-stone-700`}
                            >
                              ···
                            </button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
                  </>
                )}
                {ticketVoids.length > 0 && !showSambaTicketList ? (
                  <div
                    className="mt-3 space-y-2 rounded-lg border border-red-200 bg-red-50 px-2.5 py-2"
                    data-ticket-voids="true"
                  >
                    <p className="text-[10px] font-bold uppercase tracking-wide text-red-800">
                      Voided on this ticket
                    </p>
                    {ticketVoids.map((v) => (
                      <div key={v.kotNumber} className="text-xs text-red-950">
                        <p className="font-semibold">
                          Voided by {v.voidedByName || 'staff'}
                          {v.reason ? ` · ${v.reason}` : ''}
                        </p>
                        <ul className="mt-0.5 space-y-0.5">
                          {v.items.map((it, idx) => (
                            <li key={`${v.kotNumber}-${idx}`}>
                              {it.quantity} × {it.productName}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>

              {/* Samba: select lines → Void / Move (split to new ticket) */}
              {selectedLineIds.length > 0 && order && (
                  <div className="px-3 py-2.5 border-t-2 border-amber-400 bg-amber-100 space-y-2 shrink-0">
                    <p className="text-xs font-bold uppercase tracking-wide text-amber-950">
                      {selectedLineIds.length} selected — Void or Move
                    </p>
                    <div className="grid grid-cols-3 gap-2">
                      <button
                        type="button"
                        disabled={
                          busy ||
                          (orderLines.some(
                            (l) => selectedLineIds.includes(l.id) && l.kitchenSentAt,
                          ) &&
                            !canVoidSent)
                        }
                        onClick={() => handleVoidSelected()}
                        className={`${touchBtnDanger} min-h-12 text-xs`}
                        title={
                          orderLines.some(
                            (l) => selectedLineIds.includes(l.id) && l.kitchenSentAt,
                          ) && !canVoidSent
                            ? RESTAURANT_VOID_SENT_RESTRICTED_MESSAGE
                            : 'Void selected lines'
                        }
                      >
                        Void
                      </button>
                      <button
                        type="button"
                        disabled={
                          busy ||
                          selectedLineIds.length === 0 ||
                          !canMoveSelectedUnits(selectedMoveUnits, totalOrderUnits)
                        }
                        onClick={() => handleMoveSelected()}
                        className={`${touchBtnDark} min-h-12 text-xs`}
                      >
                        Move
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => clearLineSelection()}
                        className={`${touchBtnGhost} min-h-12 text-xs border-amber-400 bg-white`}
                      >
                        Clear
                      </button>
                    </div>
                  </div>
                )}

              {/* Line action sheet (SambaPOS long-press / Toast edit line) */}
              {lineSheet && (
                <div className="fixed inset-0 z-50 flex flex-col justify-end lg:justify-center lg:items-center bg-black/40">
                  <button
                    type="button"
                    className="flex-1 w-full lg:absolute lg:inset-0 cursor-default"
                    aria-label="Dismiss"
                    onClick={() => setLineSheet(null)}
                  />
                  <div className="relative w-full lg:max-w-md bg-white rounded-t-2xl lg:rounded-2xl p-4 space-y-3 shadow-xl pb-[max(1rem,env(safe-area-inset-bottom))]">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-semibold text-stone-900 truncate">
                          {lineSheet.quantity} × {lineSheet.productName}
                        </p>
                        {lineSheet.lineNotes ? (
                          <p className="text-xs font-medium text-amber-800 mt-0.5">
                            * {lineSheet.lineNotes}
                          </p>
                        ) : null}
                        {lineSheet.orderedByLabel || lineSheet.addedAtLabel ? (
                          <p className="text-xs font-semibold text-violet-800 mt-0.5">
                            {lineSheet.orderedByLabel
                              ? `Ordered by ${lineSheet.orderedByLabel}`
                              : null}
                            {lineSheet.orderedByLabel && lineSheet.addedAtLabel ? ' · ' : null}
                            {lineSheet.addedAtLabel ? lineSheet.addedAtLabel : null}
                          </p>
                        ) : null}
                        <p className="text-sm text-stone-500">
                          {formatCurrency(lineSheet.lineTotal)}
                          {lineSheet.kitchenSent
                            ? ' · Sent to kitchen (KOT)'
                            : isCheckBilled
                              ? ' · On guest bill · not sent to kitchen'
                              : ' · Not sent to kitchen'}
                        </p>
                      </div>
                      <button
                        type="button"
                        className={`${touchBtnGhost} min-h-10 px-3`}
                        onClick={() => setLineSheet(null)}
                      >
                        <X className="h-5 w-5" />
                      </button>
                    </div>
                    {lineSheet.productId && !lineSheet.kitchenSent ? (
                      <button
                        type="button"
                        disabled={busy || !order?.id}
                        onClick={() => {
                          const line = lineSheet.lines[0];
                          if (!order?.id || !lineSheet.productId || !line) return;
                          setLineSheet(null);
                          void openOrderTagPad({
                            orderId: order.id,
                            itemId: line.id,
                            productId: lineSheet.productId,
                            productName: lineSheet.productName,
                            existingNotes: line.lineNotes || lineSheet.lineNotes,
                            existingTags: line.orderTags,
                          });
                        }}
                        className={`${touchBtnDark} w-full min-h-12 text-sm`}
                      >
                        Order tags…
                      </button>
                    ) : null}
                    {lineSheet.productId ? (
                      <div className="space-y-2">
                        <div className="grid grid-cols-2 gap-2">
                          <button
                            type="button"
                            disabled={busy || (lineSheet.kitchenSent && !canVoidSent)}
                            onClick={() => void handleLineMinusOne(lineSheet)}
                            className={`${touchBtnGhost} min-h-14 text-lg font-bold`}
                            title={
                              lineSheet.kitchenSent && !canVoidSent
                                ? RESTAURANT_VOID_SENT_RESTRICTED_MESSAGE
                                : undefined
                            }
                          >
                            −1
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void handleLinePlusOne(lineSheet)}
                            className={`${touchBtnGhost} min-h-14 text-lg font-bold`}
                          >
                            +1
                          </button>
                        </div>
                        {!lineSheet.kitchenSent ? (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => handleLineSetQty(lineSheet)}
                            className={`${touchBtnGhost} w-full min-h-12`}
                          >
                            Set qty…
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                    <button
                      type="button"
                      disabled={
                        busy || (lineSheet.kitchenSent && !canVoidSent)
                      }
                      onClick={() =>
                        void handleVoidLines(lineSheet.itemIds, { lines: lineSheet.lines })
                      }
                      className={`${touchBtnDanger} w-full min-h-14`}
                      title={
                        lineSheet.kitchenSent && !canVoidSent
                          ? RESTAURANT_VOID_SENT_RESTRICTED_MESSAGE
                          : undefined
                      }
                    >
                      {lineSheet.kitchenSent
                        ? !canVoidSent
                          ? 'Ask manager to void'
                          : lineSheet.quantity > 1
                            ? 'Void qty… (kitchen VOID ticket)'
                            : 'Void (kitchen VOID ticket)'
                        : 'Remove (unsent)'}
                    </button>
                  </div>
                </div>
              )}

              {/* Touch qty pad — Set qty / void qty (replaces window.prompt) */}
              {qtyPadSheet && (
                <div className="fixed inset-0 z-[60] flex flex-col justify-end lg:justify-center lg:items-center bg-black/40">
                  <button
                    type="button"
                    className="flex-1 w-full lg:absolute lg:inset-0 cursor-default"
                    aria-label="Dismiss qty pad"
                    onClick={() => setQtyPadSheet(null)}
                  />
                  <div className="relative w-full lg:max-w-sm bg-white rounded-t-2xl lg:rounded-2xl p-4 space-y-3 shadow-xl pb-[max(1rem,env(safe-area-inset-bottom))]">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-xs uppercase tracking-wide font-semibold text-stone-500">
                          {qtyPadSheet.purpose === 'void-qty'
                            ? 'Void quantity'
                            : qtyPadSheet.purpose === 'move-qty'
                              ? 'Move quantity'
                              : 'Set quantity'}
                        </p>
                        <p className="font-semibold text-stone-900 truncate">
                          {qtyPadSheet.purpose === 'set-line-qty'
                            ? qtyPadSheet.group.productName
                            : qtyPadSheet.productName}
                        </p>
                        <p className="text-sm text-stone-500">
                          {qtyPadSheet.purpose === 'void-qty'
                            ? `1–${qtyPadSheet.max}${qtyPadSheet.kitchenSent ? ' · kitchen VOID' : ''}`
                            : qtyPadSheet.purpose === 'move-qty'
                              ? `Move 1–${qtyPadSheet.max} to a new ticket`
                              : `Current ${qtyPadSheet.group.quantity} · 0 clears line`}
                        </p>
                      </div>
                      <button
                        type="button"
                        className={`${touchBtnGhost} min-h-10 px-3`}
                        onClick={() => setQtyPadSheet(null)}
                      >
                        <X className="h-5 w-5" />
                      </button>
                    </div>
                    <div className="rounded-xl border-2 border-emerald-500 bg-emerald-50 py-3 text-center">
                      <span className="text-4xl font-bold tabular-nums text-stone-900">
                        {qtyPadSheet.digits || '0'}
                      </span>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      {['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫'].map((key) => (
                        <button
                          key={key}
                          type="button"
                          className={`${TOUCH} min-h-14 rounded-xl border border-stone-300 bg-stone-50 text-xl font-bold text-stone-900 active:bg-emerald-100`}
                          onClick={() => {
                            if (key === 'C') {
                              setQtyPadSheet((s) => (s ? { ...s, digits: '' } : s));
                              return;
                            }
                            if (key === '⌫') {
                              setQtyPadSheet((s) =>
                                s ? { ...s, digits: s.digits.slice(0, -1) } : s,
                              );
                              return;
                            }
                            setQtyPadSheet((s) =>
                              s ? { ...s, digits: appendQtyDigit(s.digits, key) } : s,
                            );
                          }}
                        >
                          {key}
                        </button>
                      ))}
                    </div>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => confirmQtyPadSheet()}
                      className={`${touchBtnDark} w-full min-h-14`}
                    >
                      {qtyPadSheet.purpose === 'void-qty'
                        ? 'Void'
                        : qtyPadSheet.purpose === 'move-qty'
                          ? 'Move'
                          : 'Set qty'}
                    </button>
                  </div>
                </div>
              )}

              {voidReasonSheet ? (
                <div className="fixed inset-0 z-[60] flex flex-col justify-end lg:justify-center lg:items-center bg-black/40">
                  <button
                    type="button"
                    className="flex-1 w-full lg:absolute lg:inset-0 cursor-default"
                    aria-label="Dismiss void reason"
                    onClick={() => setVoidReasonSheet(null)}
                  />
                  <div
                    className="relative w-full lg:max-w-sm bg-white rounded-t-2xl lg:rounded-2xl p-4 space-y-3 shadow-xl pb-[max(1rem,env(safe-area-inset-bottom))]"
                    data-ticket-void-reason="true"
                  >
                    <p className="text-xs uppercase tracking-wide font-semibold text-stone-500">
                      Void reason
                    </p>
                    <p className="text-sm text-stone-700">
                      Kitchen gets a VOID ticket with your name and this reason.
                    </p>
                    <div className="grid grid-cols-1 gap-2">
                      {KITCHEN_VOID_REASON_CHOICES.map((choice) => (
                        <button
                          key={choice}
                          type="button"
                          disabled={busy}
                          className={`${touchBtnGhost} w-full min-h-12 justify-start`}
                          onClick={() => {
                            const sheet = voidReasonSheet;
                            setVoidReasonSheet(null);
                            void handleVoidLines(sheet.itemIds, {
                              lines: sheet.lines,
                              voidQuantity: sheet.voidQuantity,
                              skipConfirm: true,
                              reason: choice,
                            });
                          }}
                        >
                          {choice}
                        </button>
                      ))}
                    </div>
                    <textarea
                      className={`${touchField} min-h-[4.5rem] resize-y text-sm`}
                      value={voidReasonDraft}
                      onChange={(e) => setVoidReasonDraft(e.target.value.slice(0, 500))}
                      placeholder="Other reason…"
                      maxLength={500}
                      aria-label="Other void reason"
                    />
                    <button
                      type="button"
                      disabled={busy || !voidReasonDraft.trim()}
                      className={`${touchBtnDanger} w-full min-h-12`}
                      onClick={() => {
                        const reason = voidReasonDraft.trim();
                        if (!reason) return;
                        const sheet = voidReasonSheet;
                        setVoidReasonSheet(null);
                        void handleVoidLines(sheet.itemIds, {
                          lines: sheet.lines,
                          voidQuantity: sheet.voidQuantity,
                          skipConfirm: true,
                          reason,
                        });
                      }}
                    >
                      Void with this reason
                    </button>
                  </div>
                </div>
              ) : null}

              {opsMode &&
                order &&
                (opsMode === 'transfer' || opsMode === 'merge') && (
                <div className="px-3 py-3 border-t border-stone-200 bg-amber-50 space-y-2.5 shrink-0">
                  {opsMode === 'transfer' && (
                    <>
                      <p className="text-xs font-medium text-stone-700">
                        Change table (whole ticket)
                      </p>
                      <select
                        className={touchField}
                        value={opsTargetTableId}
                        onChange={(e) => setOpsTargetTableId(e.target.value)}
                      >
                        <option value="">Select table…</option>
                        {freeTables.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.code} · {t.name}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        disabled={busy || !opsTargetTableId}
                        onClick={() => void runTransfer()}
                        className={`${touchBtnDark} w-full`}
                      >
                        Confirm change table
                      </button>
                    </>
                  )}
                  {opsMode === 'merge' && (
                    <>
                      <p className="text-xs font-medium text-stone-700">
                        Merge another ticket on this table into this one
                      </p>
                      <select
                        className={touchField}
                        value={opsSecondaryOrderId}
                        onChange={(e) => setOpsSecondaryOrderId(e.target.value)}
                      >
                        <option value="">Select ticket…</option>
                        {mergeCandidates.map((c) => (
                          <option key={c.orderId} value={c.orderId}>
                            {c.label}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        disabled={busy || !opsSecondaryOrderId}
                        onClick={() => void runMerge()}
                        className={`${touchBtnDark} w-full`}
                      >
                        Confirm merge
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    className={`${touchBtnGhost} w-full text-stone-600`}
                    onClick={() => setOpsMode(null)}
                  >
                    Cancel
                  </button>
                </div>
              )}

              <div
                className={`border-t border-stone-200 bg-white shrink-0 sticky bottom-0 z-20 pb-[max(0.5rem,env(safe-area-inset-bottom))] flex flex-col ${
                  isTouchDense ? 'p-2 space-y-1.5' : 'p-3 space-y-2'
                }`}
                data-ticket-primary-actions="true"
                data-footer-mode={showSambaTicketList ? 'party' : 'ticket'}
                data-footer-dense={isTouchDense ? '1' : '0'}
              >
                {showSambaTicketList ? (
                  /* Party list: no coach copy; compact CTAs so list stays readable on Sunmi/phone */
                  <div
                    className={
                      isTouchDense
                        ? 'flex items-stretch gap-1.5'
                        : 'grid grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] gap-2'
                    }
                  >
                    <button
                      type="button"
                      disabled={busy || mergeCandidates.length === 0 || !order}
                      onClick={() => setOpsMode('merge')}
                      className={`${touchBtnGhost} font-bold ${
                        isTouchDense
                          ? 'min-w-[4.5rem] px-2 text-xs shrink-0'
                          : 'text-sm'
                      }`}
                      style={{ minHeight: ctaMinH }}
                      data-pos-primary="merge-tickets"
                      title="Merge Tickets"
                    >
                      {isTouchDense ? 'Merge' : 'Merge Tickets'}
                    </button>
                    <button
                      type="button"
                      disabled={!order || busy || !canOrder}
                      onClick={() => void handleSendKot()}
                      className={`${TOUCH} rounded-xl bg-red-600 text-white font-bold active:bg-red-700 disabled:opacity-50 ${
                        isTouchDense ? 'flex-1 text-sm' : 'text-base'
                      }`}
                      style={{ minHeight: ctaMinH }}
                      data-pos-primary="kot"
                      title="Close (KOT) — kitchen fire for selected ticket"
                    >
                      Close
                    </button>
                  </div>
                ) : (
                  <>
                <div className="flex justify-between items-baseline gap-2 min-w-0">
                  <span
                    className={`text-stone-600 min-w-0 type-ellipsis type-caption`}
                  >
                    {orderLines.length} item{orderLines.length === 1 ? '' : 's'}
                    {Number(order?.taxAmount || 0) > 0
                      ? ` · Tax ${formatCurrency(Number(order?.taxAmount || 0))}`
                      : ''}
                  </span>
                  <span className="font-bold text-stone-900 shrink-0 type-amount">
                    {formatCurrency(Number(order?.totalAmount || 0))}
                  </span>
                </div>
                {!order && shouldShowCoach(chrome, 'coach') && !isTouchDense ? (
                    <p className="text-[11px] text-stone-500" data-pos-coach="ticket">
                      {chrome.coach === 'full'
                        ? isMultiTicketTable
                          ? 'Select lines → Void or Move. ← Tickets returns to the party list.'
                          : 'Select lines → Void or Move. + Ticket for another check on this table.'
                        : 'Select lines → Void or Move'}
                    </p>
                  ) : null}
                <div
                  className={`grid min-w-0 grid-cols-2 ${isTouchDense ? 'gap-1.5' : 'gap-2'}`}
                  data-ticket-cta-grid="true"
                >
                  <button
                    type="button"
                    disabled={!order || busy || !canOrder}
                    onClick={() => void handleSendKot()}
                    className={`${TOUCH} col-span-1 min-w-0 type-ellipsis type-cta rounded-xl bg-orange-600 px-2 text-white font-bold active:bg-orange-700 disabled:opacity-50`}
                    style={{ minHeight: ctaMinH }}
                    data-pos-primary="kot"
                  >
                    KOT
                  </button>
                  <button
                    type="button"
                    disabled={!order || busy || orderLines.length === 0 || !canOrder}
                    onClick={() => void handleBill()}
                    className={`${TOUCH} col-span-1 min-w-0 type-ellipsis type-cta rounded-xl bg-rose-800 px-2 text-white font-bold active:bg-rose-950 disabled:opacity-50`}
                    style={{ minHeight: ctaMinH }}
                    data-pos-primary="bill"
                  >
                    Bill
                    {ticketTabs.length > 1 && order && !isTouchDense ? (
                      <span className="block type-caption font-semibold opacity-90 type-ellipsis max-w-full">
                        {order.orderNumber}
                      </span>
                    ) : null}
                  </button>
                  {canRestaurantPay ? (
                    <button
                      type="button"
                      disabled={!order || busy || orderLines.length === 0}
                      onClick={() => void handlePay()}
                      className={`${TOUCH} col-span-2 min-w-0 type-ellipsis type-cta rounded-xl bg-emerald-600 px-2 text-white font-bold active:bg-emerald-700`}
                      style={{ minHeight: ctaMinH }}
                      data-pos-primary="pay"
                    >
                      {resolvePayButtonLabel(chrome, {
                        multiTicket: ticketTabs.length > 1,
                        orderNumber: order?.orderNumber,
                      })}
                      {ticketTabs.length > 1 && order && chrome.actionLabels === 'verbose' && !isTouchDense ? (
                        <span className="block type-caption font-semibold opacity-90 type-ellipsis max-w-full">
                          {order.orderNumber}
                        </span>
                      ) : null}
                    </button>
                  ) : null}
                </div>
                  </>
                )}
              </div>
            </div>

            {/* Dense FOH: see ticket items + KOT/Bill/Pay without hunting */}
            {useSheetTicket && mobileSheet !== 'order' ? (
              <div
                className="shrink-0 border-t border-stone-200 bg-white px-2 py-1.5 flex flex-col gap-1.5 pb-[max(0.5rem,env(safe-area-inset-bottom))]"
                data-foh-order-dock="true"
              >
                <div className="flex items-stretch gap-1.5 min-w-0">
                  <button
                    type="button"
                    onClick={() => {
                      // Always open the ticket board so user can SEE lines (Toast cart).
                      if (sambaTicketView !== 'detail' && isMultiTicketTable) {
                        setSambaTicketView('list');
                      }
                      setMobileSheet('order');
                    }}
                    className={`${TOUCH} flex-1 min-w-0 rounded-xl border-2 border-emerald-600/50 bg-emerald-50 px-3 flex items-center justify-between gap-2 active:bg-emerald-100`}
                    style={{ minHeight: Math.max(48, ctaMinH - 2) }}
                    data-foh-order-dock-open="true"
                    data-foh-view-ticket="true"
                    aria-label="View items on this ticket"
                  >
                    <span className="min-w-0 text-left">
                      <span className="block type-body font-bold text-stone-900 type-ellipsis">
                        {sambaTicketView === 'detail' && order?.orderNumber
                          ? order.orderNumber
                          : isMultiTicketTable
                            ? `${ticketTabs.length} tickets`
                            : order?.orderNumber || 'Ticket'}
                      </span>
                      <span className="block type-caption font-semibold text-emerald-900 type-ellipsis">
                        {ticketNote && sambaTicketView === 'detail'
                          ? ticketNote
                          : sambaTicketView !== 'detail' && isMultiTicketTable
                            ? 'Tap to select a ticket'
                            : orderLines.length > 0
                              ? `Tap to see ${orderLines.length} item${orderLines.length === 1 ? '' : 's'}`
                              : 'Tap to view ticket'}
                      </span>
                    </span>
                    <span className="shrink-0 type-amount font-bold text-stone-900 tabular-nums">
                      {formatCurrency(
                        sambaTicketView !== 'detail' && isMultiTicketTable
                          ? partyTicketsTotal
                          : Number(order?.totalAmount ?? 0),
                      )}
                    </span>
                  </button>
                  {order && sambaTicketView === 'detail' && !showSambaTicketList ? (
                    <button
                      type="button"
                      onClick={openTicketNoteEditor}
                      disabled={!canOrder && !ticketNote}
                      className={`${touchBtnGhost} shrink-0 min-w-[3.25rem] px-2 type-caption font-bold ${
                        ticketNote ? 'border-amber-400 bg-amber-50 text-amber-950' : ''
                      }`}
                      style={{ minHeight: Math.max(48, ctaMinH - 2) }}
                      data-ticket-note="dock"
                      aria-label="Ticket note"
                      title="Note on this ticket only"
                    >
                      Note
                      {ticketNote ? (
                        <span className="ml-0.5 text-amber-700" aria-hidden>
                          ●
                        </span>
                      ) : null}
                    </button>
                  ) : null}
                  {/* Compact KOT beside total — appears once this ticket has items */}
                  {canOrder &&
                  order &&
                  orderLines.length > 0 &&
                  sambaTicketView === 'detail' &&
                  !showSambaTicketList ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleSendKot()}
                      className={`${TOUCH} shrink-0 min-w-[3.25rem] rounded-xl bg-orange-600 px-2.5 text-white type-cta font-bold active:bg-orange-700 disabled:opacity-50`}
                      style={{ minHeight: Math.max(48, ctaMinH - 2) }}
                      data-foh-order-dock-kot="true"
                      data-pos-primary="kot"
                      aria-label="Send KOT to kitchen"
                      title="Send KOT"
                    >
                      KOT
                    </button>
                  ) : null}
                  {isMultiTicketTable && sambaTicketView === 'detail' ? (
                    <button
                      type="button"
                      onClick={backToPartyTicketList}
                      className={`${touchBtnGhost} shrink-0 min-w-[3.5rem] px-1.5 type-caption font-bold`}
                      style={{ minHeight: Math.max(48, ctaMinH - 2) }}
                      data-foh-order-dock-tickets="true"
                      aria-label="All tickets on this table"
                      title="All tickets"
                    >
                      Tickets
                    </button>
                  ) : null}
                </div>

                {order &&
                orderLines.length > 0 &&
                !showSambaTicketList &&
                sambaTicketView === 'detail' ? (
                  <div
                    className="grid min-w-0 grid-cols-2 gap-1.5"
                    data-foh-order-dock-cta="true"
                    data-ticket-cta-grid="true"
                  >
                    {canOrder ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void handleBill()}
                        className={`${TOUCH} col-span-1 min-w-0 type-ellipsis type-cta rounded-xl bg-rose-800 px-2 text-white font-bold active:bg-rose-950 disabled:opacity-50`}
                        style={{ minHeight: ctaMinH }}
                        data-foh-order-dock-bill="true"
                        data-pos-primary="bill"
                      >
                        Bill
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => setMobileSheet('order')}
                      className={`${TOUCH} ${canRestaurantPay ? 'col-span-1' : canOrder ? 'col-span-1' : 'col-span-2'} min-w-0 type-ellipsis type-cta rounded-xl border-2 border-stone-800 bg-white px-2 text-stone-900 font-bold active:bg-stone-100`}
                      style={{ minHeight: ctaMinH }}
                      data-foh-order-dock-review="true"
                      aria-label="View ticket items"
                    >
                      Order
                    </button>
                    {canRestaurantPay ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void handlePay()}
                        className={`${TOUCH} col-span-2 min-w-0 type-ellipsis type-cta rounded-xl bg-emerald-600 px-2 text-white font-bold active:bg-emerald-700 disabled:opacity-50`}
                        style={{ minHeight: ctaMinH }}
                        data-foh-order-dock-pay="true"
                        data-pos-primary="pay"
                      >
                        {resolvePayButtonLabel(chrome, {
                          multiTicket: ticketTabs.length > 1,
                          orderNumber: order?.orderNumber,
                        })}
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </div>

      <AdaptiveDialog
        open={mobileSheet === 'details'}
        onOpenChange={(open) => {
          if (!open) setMobileSheet(null);
        }}
        title="Waiter / Customer"
        size="sm"
        presentationOverride="modal"
        footer={
          <button
            type="button"
            className={`${touchBtnDark} w-full`}
            onClick={() => setMobileSheet(null)}
          >
            Done
          </button>
        }
      >
        <div className="space-y-3" data-ticket-dialog="details" data-restaurant-customer="dialog">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-stone-600 uppercase tracking-wide">
              Waiter
            </label>
            <select
              className={touchField}
              value={selectedWaiterId}
              disabled={assignWaiterMutation.isPending || !canEditOthers}
              onChange={(e) => handleWaiterChange(e.target.value)}
            >
              {waiters.length === 0 && user ? (
                <option value={user.id}>{user.fullName || user.email}</option>
              ) : (
                waiters.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.fullName || w.email}
                  </option>
                ))
              )}
            </select>
          </div>
          <div className="space-y-2">
              {selectedCustomer || !guestDraft.guestName ? (
                <CustomerSelector
                  compact
                  required={
                    serviceChannel &&
                    !isQuickLane &&
                    (channel === 'TAKEAWAY' || channel === 'DELIVERY')
                  }
                  label={
                    channel === 'DELIVERY'
                      ? 'Delivery customer'
                      : channel === 'TAKEAWAY' && !isQuickLane
                        ? 'Takeaway customer'
                        : 'Customer (optional)'
                  }
                  selectedCustomer={selectedCustomer}
                  saleTotal={Number(order?.totalAmount || 0)}
                  onSelectCustomer={handleSelectServiceCustomer}
                />
              ) : (
                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold uppercase tracking-wide text-stone-500">
                    Customer
                  </label>
                  <div className="flex items-center gap-2 rounded-xl border-2 border-emerald-600 bg-emerald-50 px-3 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="font-bold text-base text-stone-900 truncate">
                        {guestDraft.guestName}
                      </div>
                      {guestDraft.guestPhone ? (
                        <div className="text-sm text-stone-600">{guestDraft.guestPhone}</div>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      className={`${touchBtnGhost} min-h-11 px-3 shrink-0`}
                      onClick={() =>
                        setGuestDraft({
                          guestName: '',
                          guestPhone: '',
                          deliveryAddress: '',
                          pickupLabel: '',
                        })
                      }
                    >
                      Change
                    </button>
                  </div>
                </div>
              )}
            </div>
        </div>
      </AdaptiveDialog>

      <AdaptiveDialog
        open={mobileSheet === 'more'}
        onOpenChange={(open) => {
          if (!open) {
            setMobileSheet((cur) => {
              if (cur !== 'more') return cur;
              return useSheetTicket ? 'order' : null;
            });
          }
        }}
        title="Ticket actions"
        size="sm"
        presentationOverride="modal"
        footer={
          <button
            type="button"
            className={`${touchBtnGhost} w-full`}
            onClick={() => returnToTicketSheet()}
          >
            Close
          </button>
        }
      >
        <div className="space-y-2" data-ticket-dialog="more" data-secondary-ops-surface="dialog">
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setMobileSheet(null);
              returnToFloor();
            }}
            className={`${touchBtnDark} w-full`}
          >
            ← Tables
          </button>
          <button
            type="button"
            disabled={!order || (!canOrder && !ticketNote)}
            onClick={() => openTicketNoteEditor()}
            className={`${touchBtnGhost} w-full`}
            data-ticket-note="menu"
          >
            Ticket note
            {ticketNote ? ' · set' : ''}
          </button>
          <button
            type="button"
            disabled={!order || busy || freeTables.length === 0}
            onClick={() => {
              setOpsMode('transfer');
              setOpsTargetTableId('');
              setMobileSheet(null);
            }}
            className={`${touchBtnGhost} w-full`}
          >
            Change table
          </button>
          <button
            type="button"
            disabled={!order || busy || mergeCandidates.length === 0}
            onClick={() => {
              setOpsMode('merge');
              setMobileSheet(null);
            }}
            className={`${touchBtnGhost} w-full`}
          >
            Merge tickets
          </button>
          {canCancelCheck ? (
            <button
              type="button"
              disabled={!order || busy}
              onClick={() => {
                setMobileSheet(null);
                void handleCancelCheck();
              }}
              className={`${touchBtnDanger} w-full`}
              data-secondary-ops-surface="cancel"
            >
              Cancel check
            </button>
          ) : null}
        </div>
      </AdaptiveDialog>

      <AdaptiveDialog
        open={mobileSheet === 'note'}
        onOpenChange={(open) => {
          if (!open) returnToTicketSheet();
        }}
        title={
          order?.orderNumber
            ? `Note · ${order.orderNumber}`
            : 'Ticket note'
        }
        size="sm"
        presentationOverride="modal"
        footer={
          <div className="grid grid-cols-2 gap-2 w-full">
            <button
              type="button"
              className={`${touchBtnGhost} w-full`}
              disabled={noteSaving}
              onClick={() => returnToTicketSheet()}
            >
              Cancel
            </button>
            <button
              type="button"
              className={`${touchBtnDark} w-full`}
              disabled={noteSaving || !order || !canOrder}
              onClick={() => void saveTicketNote()}
            >
              {noteSaving ? 'Saving…' : 'Save note'}
            </button>
          </div>
        }
      >
        <div className="space-y-3" data-ticket-dialog="note">
          <p className="text-xs text-stone-500">
            Applies only to this ticket ({order?.orderNumber || 'selected'}). Other tickets on the
            table keep their own notes, items, and bills.
          </p>
          <textarea
            className={`${touchField} min-h-[7.5rem] resize-y text-base leading-relaxed`}
            value={noteDraft}
            onChange={(e) => setNoteDraft(e.target.value.slice(0, 2000))}
            placeholder="e.g. Birthday party · window seat · no ice"
            maxLength={2000}
            autoFocus
            aria-label="Ticket note text"
          />
          <div className="flex items-center justify-between text-[11px] text-stone-400">
            <button
              type="button"
              className="underline-offset-2 hover:underline disabled:opacity-40"
              disabled={!noteDraft.trim() || noteSaving}
              onClick={() => setNoteDraft('')}
            >
              Clear
            </button>
            <span>{noteDraft.length}/2000</span>
          </div>
        </div>
      </AdaptiveDialog>

      {tagPad ? (
        <RestaurantOrderTagPad
          productName={tagPad.productName}
          groups={tagPad.groups}
          selected={tagPad.selected}
          freeText={tagPad.freeText}
          busy={tagPadBusy}
          onChangeSelected={(selected) => setTagPad((p) => (p ? { ...p, selected } : p))}
          onChangeFreeText={(freeText) => setTagPad((p) => (p ? { ...p, freeText } : p))}
          onSkip={() => setTagPad(null)}
          onSave={() => void saveOrderTagPad()}
        />
      ) : null}
    </Layout>
  );
}
