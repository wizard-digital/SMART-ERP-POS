/**
 * Phase 5.1–5.5 — Restaurant offline write helpers (append-only journal).
 */

import {
  appendEvent,
  appendSyncedEvent,
  generateEventKey,
  getAllEvents,
  getAllSyncState,
  type EventLine,
  type EventPayment,
  type RestaurantOrderChannel,
} from './offlineEventJournal';
import {
  deriveRestaurantCheckForTable,
  deriveRestaurantFloorOccupancy,
  deriveRestaurantKitchenBoard,
  deriveRestaurantOpenChecks,
  nextKotStatus,
  type DerivedOrder,
  type DerivedKotStatus,
} from './offlineEventSelectors';
import { isServiceProductType } from '@shared/utils/productTypeRules';
import { consolidateKotLines } from '@shared/utils/consolidateKotLines';
import {
  totalLineQuantity,
  type ReconcileDesiredLine,
} from '@shared/utils/reconcileOrderLineVoids';
import {
  normalizePrinterName,
  normalizeStationCode,
  stationCodesEquivalent,
} from '@shared/restaurant/stationCode';
import { decrementLocalStock, getCachedCatalog, restoreLocalStock } from '../services/offlineCatalogService';
import { getCachedRestaurantMenu, getCachedRestaurantStations, paintRestaurantTableFreeOffline } from './restaurantOfflineCache';
import { publishLanKdsBoardChanged } from './restaurantLanKds';

/** Resolve product type for offline stock rules (menu/catalog beat a stale line stamp). */
export function resolveOfflineProductType(
  productId: string,
  lineProductType?: string | null,
): string {
  const menuHit = getCachedRestaurantMenu().find((p) => p.id === productId);
  const catalogHit = getCachedCatalog().find((p) => p.id === productId);
  const fromCaches = menuHit?.productType || catalogHit?.productType;
  // Service dishes never consume parent stock — trust live menu/catalog over a stale journal line.
  if (isServiceProductType(fromCaches)) return 'service';
  if (lineProductType) return String(lineProductType);
  if (fromCaches) return String(fromCaches);
  return 'inventory';
}

export type { DerivedKotStatus };

export function newOfflineOrderId(): string {
  return `ofl_ord_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function newOfflineLineId(): string {
  return `ofl_line_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function newKotOfflineId(): string {
  return `KOT-OFF-${Date.now().toString(36).toUpperCase()}`;
}

/** Local journal order ids are not on the server — never call restaurant checks APIs with ofl_ord_ ids. */
export function isJournalLocalOrderId(id: string | null | undefined): boolean {
  return !!id && id.startsWith('ofl_ord_');
}

/**
 * KOT / Bill for journal-local checks must stay offline-first even when the
 * browser reports online (server has no ofl_ord_* row).
 */
export function shouldUseLocalRestaurantMutation(
  isOnline: boolean,
  orderId: string | null | undefined,
): boolean {
  return !isOnline || isJournalLocalOrderId(orderId);
}

/**
 * Hydrate a server-open check into the local journal (SYNCED) so this device can
 * keep ordering / cash-paying if the network drops mid-service.
 * Returns true when a seed was written (or already present).
 */
export function seedRestaurantCheckFromServer(input: {
  orderId: string;
  orderNumber: string;
  tableId: string;
  tableCode?: string | null;
  tableName?: string | null;
  channel?: RestaurantOrderChannel | null;
  waiterId?: string | null;
  waiterName?: string | null;
  guestName?: string | null;
  guestPhone?: string | null;
  deliveryAddress?: string | null;
  pickupLabel?: string | null;
  items: Array<{
    id: string;
    productId?: string | null;
    productName: string;
    quantity: number | string;
    unitPrice: number | string;
    lineNotes?: string | null;
    kitchenSentAt?: string | null;
    addedBy?: string | null;
    addedByName?: string | null;
    addedAt?: string | null;
    productType?: string;
  }>;
}): boolean {
  if (!input.orderId || !input.tableId) return false;
  const items = input.items ?? [];
  // Multi-ticket: only skip when THIS orderId is already in the journal — never treat
  // a sibling on the same table as a duplicate seed.
  const existing = deriveRestaurantCheckForTable(
    input.tableId,
    getAllEvents(),
    getAllSyncState(),
    input.orderId,
  );
  if (existing?.orderId === input.orderId) return true;

  const lines: EventLine[] = items.map((it) => {
    const qty = Number(it.quantity) || 0;
    const unitPrice = Number(it.unitPrice) || 0;
    const productId = it.productId || `custom_${it.id}`;
    return toEventLine({
      lineId: it.id,
      productId,
      productName: it.productName,
      quantity: qty,
      unitPrice,
      lineNotes: it.lineNotes,
      kitchenSentAt: it.kitchenSentAt,
      addedBy: it.addedBy,
      addedByName: it.addedByName,
      addedAt: it.addedAt,
      productType: it.productType || resolveOfflineProductType(productId),
    });
  });

  appendSyncedEvent({
    eventType: 'ORDER_CREATED',
    key: `seed_${input.orderId}`,
    orderId: input.orderId,
    offlineId: input.orderNumber || input.orderId,
    lines,
    notes: `Hydrated ${input.tableCode || input.tableId}`,
    ts: Date.now(),
    channel: input.channel || 'DINE_IN',
    tableId: input.tableId,
    tableCode: input.tableCode || undefined,
    tableName: input.tableName || undefined,
    waiterId: input.waiterId || undefined,
    waiterName: input.waiterName || undefined,
    guestName: input.guestName,
    guestPhone: input.guestPhone,
    deliveryAddress: input.deliveryAddress,
    pickupLabel: input.pickupLabel,
  });
  return true;
}

/** True when this check has unsynced journal mutations (void/add/cancel/pay/KOT). */
export function hasPendingRestaurantMutations(orderId: string): boolean {
  if (!orderId) return false;
  const sync = getAllSyncState();
  return getAllEvents().some((e) => {
    const st = sync[e.key]?.status;
    if (st === 'SYNCED' || st === 'CANCELLED') return false;
    if (!('orderId' in e) || e.orderId !== orderId) return false;
    return (
      e.eventType === 'ORDER_UPDATED' ||
      e.eventType === 'ORDER_CANCELLED' ||
      e.eventType === 'SALE_COMPLETED' ||
      e.eventType === 'RESTAURANT_KOT_FIRED' ||
      e.eventType === 'ORDER_CREATED'
    );
  });
}

/**
 * Last non-seed ORDER_UPDATED line snapshot for a check.
 * Survives ACK'd offline voids that never deleted server rows (pre-fix sync).
 */
export function getLastNonSeedRestaurantLineSnapshot(
  orderId: string,
): ReconcileDesiredLine[] | null {
  if (!orderId) return null;
  let last: ReconcileDesiredLine[] | null = null;
  for (const e of getAllEvents()) {
    if (e.eventType !== 'ORDER_UPDATED') continue;
    if (e.orderId !== orderId) continue;
    if (e.key.startsWith('seed_')) continue;
    if (!Array.isArray(e.lines)) continue;
    last = e.lines.map((l) => ({
      lineId: l.lineId,
      productId: l.productId,
      quantity: Number(l.quantity) || 0,
    }));
  }
  return last;
}

/**
 * Ticket truth for Complete Sale: prefer the stricter of FOH lines vs last journal void snapshot.
 * Heals orders whose offline voids were ACK'd before server reconcile existed.
 */
export function resolveDesiredLinesBeforePay(
  orderId: string,
  fohItems: Array<{
    id: string;
    productId?: string | null;
    quantity: string | number;
  }>,
): ReconcileDesiredLine[] {
  const foh: ReconcileDesiredLine[] = fohItems.map((it) => ({
    lineId: it.id,
    productId: it.productId || undefined,
    quantity: Number(it.quantity) || 0,
  }));
  const snap = getLastNonSeedRestaurantLineSnapshot(orderId);
  if (!snap || snap.length === 0) return foh;
  if (foh.length === 0) return snap;
  return totalLineQuantity(snap) < totalLineQuantity(foh) - 1e-9 ? snap : foh;
}

const PAY_DESIRED_KEY = (orderId: string) => `restaurant_pay_desired_${orderId}`;

/** Memory fallback when sessionStorage is missing (tests) or blocked (private mode). */
const payDesiredMemory = new Map<string, { ts: number; lines: ReconcileDesiredLine[] }>();

function normalizePayDesiredLines(lines: ReconcileDesiredLine[]): ReconcileDesiredLine[] {
  return lines.map((l) => ({
    lineId: typeof l.lineId === 'string' ? l.lineId : undefined,
    productId: typeof l.productId === 'string' ? l.productId : undefined,
    quantity: Number(l.quantity) || 0,
  }));
}

/** Persist ticket lines before navigating to Order Payment (survives journal-less payment page). */
export function storePayDesiredLines(
  orderId: string,
  lines: ReconcileDesiredLine[],
): void {
  if (!orderId) return;
  const payload = {
    ts: Date.now(),
    lines: normalizePayDesiredLines(lines),
  };
  payDesiredMemory.set(orderId, payload);
  if (typeof sessionStorage === 'undefined') return;
  try {
    sessionStorage.setItem(PAY_DESIRED_KEY(orderId), JSON.stringify(payload));
  } catch {
    /* private mode / quota — memory map still holds ticket truth for this tab */
  }
}

export function loadPayDesiredLines(orderId: string): ReconcileDesiredLine[] | null {
  if (!orderId) return null;
  const fromMemory = (): ReconcileDesiredLine[] | null => {
    const mem = payDesiredMemory.get(orderId);
    if (!mem?.lines?.length) return null;
    if (Date.now() - mem.ts > 2 * 60 * 60 * 1000) {
      payDesiredMemory.delete(orderId);
      return null;
    }
    return normalizePayDesiredLines(mem.lines);
  };
  if (typeof sessionStorage !== 'undefined') {
    try {
      const raw = sessionStorage.getItem(PAY_DESIRED_KEY(orderId));
      if (raw) {
        const parsed = JSON.parse(raw) as { lines?: ReconcileDesiredLine[]; ts?: number };
        if (Array.isArray(parsed.lines) && parsed.lines.length > 0) {
          // Stale after 2h — do not void against ancient snapshots
          if (parsed.ts && Date.now() - parsed.ts > 2 * 60 * 60 * 1000) {
            sessionStorage.removeItem(PAY_DESIRED_KEY(orderId));
            payDesiredMemory.delete(orderId);
            return null;
          }
          const lines = normalizePayDesiredLines(parsed.lines);
          payDesiredMemory.set(orderId, { ts: parsed.ts || Date.now(), lines });
          return lines;
        }
      }
    } catch {
      /* fall through to memory */
    }
  }
  return fromMemory();
}

export function clearPayDesiredLines(orderId: string): void {
  if (!orderId) return;
  payDesiredMemory.delete(orderId);
  if (typeof sessionStorage === 'undefined') return;
  try {
    sessionStorage.removeItem(PAY_DESIRED_KEY(orderId));
  } catch {
    /* ignore */
  }
}

/**
 * Complete-Sale desired lines — ticket snapshot > journal void snap > FOH/server.
 * NEVER treat raw server lines alone as ticket truth when a stricter snapshot exists.
 */
export function resolveDesiredLinesForPaymentPage(
  orderId: string,
  serverOrFohItems: Array<{
    id: string;
    productId?: string | null;
    quantity: string | number;
  }>,
): ReconcileDesiredLine[] {
  const stored = loadPayDesiredLines(orderId);
  if (stored && stored.length > 0) {
    const fohQty = totalLineQuantity(
      serverOrFohItems.map((it) => ({
        lineId: it.id,
        productId: it.productId || undefined,
        quantity: Number(it.quantity) || 0,
      })),
    );
    if (totalLineQuantity(stored) <= fohQty + 1e-9) return stored;
  }
  return resolveDesiredLinesBeforePay(orderId, serverOrFohItems);
}

/**
 * Replace journal snapshot for a server check with fresh API lines (avoids stale void IDs).
 * Keeps pending local ofl_line_* adds that have not synced yet.
 * Skips overwrite when unsynced voids/edits exist — otherwise Complete Sale would charge voided lines.
 * Also clamps to last non-seed void snapshot so ACK'd offline voids are not resurrected on FOH.
 */
export function refreshRestaurantCheckSeedFromServer(
  input: Parameters<typeof seedRestaurantCheckFromServer>[0],
): void {
  if (!input.orderId || !input.tableId) return;
  if (hasPendingRestaurantMutations(input.orderId)) return;
  let serverLines: EventLine[] = (input.items || []).map((it) => {
    const qty = Number(it.quantity) || 0;
    const unitPrice = Number(it.unitPrice) || 0;
    const productId = it.productId || `custom_${it.id}`;
    return toEventLine({
      lineId: it.id,
      productId,
      productName: it.productName,
      quantity: qty,
      unitPrice,
      lineNotes: it.lineNotes,
      kitchenSentAt: it.kitchenSentAt,
      addedBy: it.addedBy,
      addedByName: it.addedByName,
      addedAt: it.addedAt,
      productType: it.productType || resolveOfflineProductType(productId),
    });
  });
  const voidSnap = getLastNonSeedRestaurantLineSnapshot(input.orderId);
  if (voidSnap && totalLineQuantity(voidSnap) < totalLineQuantity(
    serverLines.map((l) => ({ lineId: l.lineId, productId: l.productId, quantity: l.quantity })),
  ) - 1e-9) {
    const wantById = new Map(
      voidSnap.filter((l) => l.lineId).map((l) => [l.lineId!, Number(l.quantity) || 0]),
    );
    serverLines = serverLines
      .map((l) => {
        if (!l.lineId || !wantById.has(l.lineId)) return null;
        const want = wantById.get(l.lineId)!;
        if (!(want > 0)) return null;
        return {
          ...l,
          quantity: want,
          subtotal: want * l.unitPrice,
        };
      })
      .filter((l): l is EventLine => !!l);
  }
  const existing = deriveRestaurantCheckForTable(
    input.tableId,
    getAllEvents(),
    getAllSyncState(),
    input.orderId,
  );
  if (!existing) {
    seedRestaurantCheckFromServer({ ...input, items: serverLines.map((l) => ({
      id: l.lineId || `custom_${l.productId}`,
      productId: l.productId,
      productName: l.productName,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      lineNotes: l.lineNotes,
      kitchenSentAt: l.kitchenSentAt,
      addedBy: l.addedBy,
      addedByName: l.addedByName,
      addedAt: l.addedAt,
      productType: l.productType,
    })) });
    return;
  }
  // Preserve unsynced journal-only lines (ofl_line_*) until they sync.
  const pendingLocal = existing.lines.filter(
    (l) => !!l.lineId && l.lineId.startsWith('ofl_line_'),
  );
  const serverIds = new Set(serverLines.map((l) => l.lineId).filter(Boolean));
  const merged = [
    ...serverLines,
    ...pendingLocal.filter((l) => l.lineId && !serverIds.has(l.lineId)),
  ];
  const lineFp = (rows: EventLine[]) =>
    rows
      .map((l) => `${l.lineId || ''}|${l.productId}|${l.quantity}|${l.lineNotes || ''}`)
      .sort()
      .join(';');
  if (lineFp(existing.lines) === lineFp(merged)) return;
  appendSyncedEvent({
    eventType: 'ORDER_UPDATED',
    key: `seed_refresh_${input.orderId}_${Date.now()}`,
    orderId: input.orderId,
    offlineId: input.orderNumber || existing.offlineId,
    lines: merged,
    ts: Date.now(),
    channel: input.channel || existing.channel || 'DINE_IN',
    tableId: input.tableId,
    tableCode: input.tableCode || existing.tableCode,
    tableName: input.tableName || existing.tableName,
    waiterId: input.waiterId || existing.waiterId,
    waiterName: input.waiterName || existing.waiterName,
    guestName: input.guestName ?? existing.guestName,
    guestPhone: input.guestPhone ?? existing.guestPhone,
    deliveryAddress: input.deliveryAddress ?? existing.deliveryAddress,
    pickupLabel: input.pickupLabel ?? existing.pickupLabel,
  });
}

function toEventLine(input: {
  lineId: string;
  productId: string;
  productName: string;
  quantity: number;
  unitPrice: number;
  productType?: string;
  lineNotes?: string | null;
  kitchenSentAt?: string | null;
  addedBy?: string | null;
  addedByName?: string | null;
  addedAt?: string | null;
}): EventLine {
  const subtotal = input.quantity * input.unitPrice;
  return {
    lineId: input.lineId,
    productId: input.productId,
    productName: input.productName,
    sku: '',
    uom: '',
    quantity: input.quantity,
    unitPrice: input.unitPrice,
    costPrice: 0,
    subtotal,
    taxAmount: 0,
    productType: input.productType,
    lineNotes: input.lineNotes ?? null,
    kitchenSentAt: input.kitchenSentAt ?? null,
    addedBy: input.addedBy ?? null,
    addedByName: input.addedByName ?? null,
    addedAt: input.addedAt ?? null,
  };
}

export interface OpenOrAddRestaurantItemInput {
  tableId: string;
  tableCode: string;
  tableName: string;
  channel: RestaurantOrderChannel;
  /** Multi-ticket: append to this check (not whichever derive picks by table). */
  orderId?: string | null;
  /**
   * Always open a new local ticket (party-list menu add).
   * Ignores orderId and any existing open check on the table.
   */
  forceNewTicket?: boolean;
  customerId?: string | null;
  waiterId?: string;
  waiterName?: string;
  /** Login user who rang this line (Toast attribution). */
  addedBy?: string | null;
  addedByName?: string | null;
  addedAt?: string | null;
  guestName?: string | null;
  guestPhone?: string | null;
  deliveryAddress?: string | null;
  pickupLabel?: string | null;
  productId: string;
  productName: string;
  unitPrice: number;
  quantity?: number;
  productType?: string;
  lineNotes?: string | null;
}

/**
 * Open a local restaurant check or append a line. Returns derived order after write.
 */
export function appendRestaurantItemOffline(input: OpenOrAddRestaurantItemInput): DerivedOrder {
  const events = getAllEvents();
  const syncState = getAllSyncState();
  const existing = input.forceNewTicket
    ? null
    : deriveRestaurantCheckForTable(
        input.tableId,
        events,
        syncState,
        input.orderId || undefined,
      );
  const qty = input.quantity ?? 1;
  const line = toEventLine({
    lineId: newOfflineLineId(),
    productId: input.productId,
    productName: input.productName,
    quantity: qty,
    unitPrice: input.unitPrice,
    productType: input.productType ?? resolveOfflineProductType(input.productId),
    lineNotes: input.lineNotes ?? null,
    addedBy: input.addedBy ?? null,
    addedByName: input.addedByName ?? input.waiterName ?? null,
    addedAt: input.addedAt ?? new Date().toISOString(),
  });

  if (!existing) {
    const orderId = newOfflineOrderId();
    const offlineId = `OFF-R-${Date.now().toString(36).toUpperCase()}`;
    appendEvent({
      eventType: 'ORDER_CREATED',
      key: generateEventKey(),
      orderId,
      offlineId,
      lines: [line],
      notes: `Restaurant ${input.tableCode}`,
      ts: Date.now(),
      customerId: input.customerId || undefined,
      channel: input.channel,
      tableId: input.tableId,
      tableCode: input.tableCode,
      tableName: input.tableName,
      waiterId: input.waiterId,
      waiterName: input.waiterName,
      guestName: input.guestName,
      guestPhone: input.guestPhone,
      deliveryAddress: input.deliveryAddress,
      pickupLabel: input.pickupLabel,
    });
    const next = deriveRestaurantCheckForTable(
      input.tableId,
      getAllEvents(),
      getAllSyncState(),
      orderId,
    );
    if (!next) throw new Error('Failed to derive offline restaurant check');
    return next;
  }

  appendEvent({
    eventType: 'ORDER_UPDATED',
    key: generateEventKey(),
    orderId: existing.orderId,
    offlineId: existing.offlineId,
    lines: [...existing.lines, line],
    ts: Date.now(),
    customerId: existing.customerId ?? input.customerId ?? undefined,
    channel: existing.channel ?? input.channel,
    tableId: existing.tableId ?? input.tableId,
    tableCode: existing.tableCode ?? input.tableCode,
    tableName: existing.tableName ?? input.tableName,
    waiterId: existing.waiterId ?? input.waiterId,
    waiterName: existing.waiterName ?? input.waiterName,
    guestName: existing.guestName ?? input.guestName,
    guestPhone: existing.guestPhone ?? input.guestPhone,
    deliveryAddress: existing.deliveryAddress ?? input.deliveryAddress,
    pickupLabel: existing.pickupLabel ?? input.pickupLabel,
  });

  const next = deriveRestaurantCheckForTable(
    input.tableId,
    getAllEvents(),
    getAllSyncState(),
    existing.orderId,
  );
  if (!next) throw new Error('Failed to derive offline restaurant check');
  return next;
}

/**
 * Update guest / customer on an open local check (customers SSOT link).
 */
export function updateRestaurantGuestOffline(
  order: DerivedOrder,
  guest: {
    customerId?: string | null;
    guestName?: string | null;
    guestPhone?: string | null;
    deliveryAddress?: string | null;
    pickupLabel?: string | null;
  },
): DerivedOrder {
  if (!order.tableId) throw new Error('Restaurant check missing table');
  appendEvent({
    eventType: 'ORDER_UPDATED',
    key: generateEventKey(),
    orderId: order.orderId,
    offlineId: order.offlineId,
    lines: order.lines,
    ts: Date.now(),
    customerId: guest.customerId ?? order.customerId ?? undefined,
    channel: order.channel,
    tableId: order.tableId,
    tableCode: order.tableCode,
    tableName: order.tableName,
    waiterId: order.waiterId,
    waiterName: order.waiterName,
    guestName: guest.guestName !== undefined ? guest.guestName : order.guestName,
    guestPhone: guest.guestPhone !== undefined ? guest.guestPhone : order.guestPhone,
    deliveryAddress:
      guest.deliveryAddress !== undefined ? guest.deliveryAddress : order.deliveryAddress,
    pickupLabel: guest.pickupLabel !== undefined ? guest.pickupLabel : order.pickupLabel,
  });
  const next = deriveRestaurantCheckForTable(
    order.tableId,
    getAllEvents(),
    getAllSyncState(),
    order.orderId,
  );
  if (!next) throw new Error('Failed to derive check after guest update');
  return next;
}

/**
 * Per-ticket FOA note (journal). Lines/totals unchanged.
 * Empty string clears the user note; later seed_refresh omits notes so this sticks.
 */
export function updateRestaurantCheckNotesOffline(
  order: DerivedOrder,
  notes: string | null,
): DerivedOrder {
  if (!order.tableId) throw new Error('Restaurant check missing table');
  appendEvent({
    eventType: 'ORDER_UPDATED',
    key: generateEventKey(),
    orderId: order.orderId,
    offlineId: order.offlineId,
    lines: order.lines,
    notes: notes || '',
    ts: Date.now(),
    customerId: order.customerId ?? undefined,
    channel: order.channel,
    tableId: order.tableId,
    tableCode: order.tableCode,
    tableName: order.tableName,
    waiterId: order.waiterId,
    waiterName: order.waiterName,
    guestName: order.guestName,
    guestPhone: order.guestPhone,
    deliveryAddress: order.deliveryAddress,
    pickupLabel: order.pickupLabel,
  });
  const next = deriveRestaurantCheckForTable(
    order.tableId,
    getAllEvents(),
    getAllSyncState(),
    order.orderId,
  );
  if (!next) throw new Error('Failed to derive check after note update');
  return next;
}

/**
 * Mark unsent lines as KOT-fired: one RESTAURANT_KOT_FIRED per station (same as online sendKot),
 * then ORDER_UPDATED with kitchenSentAt. Menu kitchenStation + station registry printers.
 */
export type OfflineKotTicket = {
  kotOfflineId: string;
  /** Human station name for printed documents. */
  station: string;
  /** Station code for printer routing. */
  stationCode: string;
  printerName: string | null;
  lines: Array<{ lineId: string; productName: string; quantity: number; lineNotes?: string | null }>;
};

function resolveOfflineKotStation(productId: string): {
  code: string;
  name: string;
  printerName: string | null;
} {
  const menu = getCachedRestaurantMenu();
  const stations = getCachedRestaurantStations().filter((s) => s.isActive);
  const product = menu.find((p) => p.id === productId);
  const code = normalizeStationCode(product?.kitchenStation);
  const match = code
    ? stations.find((s) => normalizeStationCode(s.code) === code) ||
      stations.find((s) => stationCodesEquivalent(s.code, code))
    : undefined;
  if (match) {
    const stationCode = normalizeStationCode(match.code);
    const name = String(match.name ?? '').trim() || stationCode;
    return {
      code: stationCode,
      name,
      printerName: normalizePrinterName(match.printerName),
    };
  }
  const def = stations.find((s) => s.isDefault) || stations[0];
  if (def) {
    const stationCode = normalizeStationCode(def.code);
    const name = String(def.name ?? '').trim() || stationCode;
    return {
      code: stationCode,
      name,
      printerName: normalizePrinterName(def.printerName),
    };
  }
  return { code: 'KITCHEN', name: 'KITCHEN', printerName: null };
}

export function fireRestaurantKotOffline(order: DerivedOrder): { tickets: OfflineKotTicket[] } {
  const unsent = order.lines.filter((l) => l.lineId && !l.kitchenSentAt);
  if (unsent.length === 0) {
    throw new Error('No new lines to send to kitchen');
  }

  const firedAt = new Date().toISOString();
  const byStation = new Map<
    string,
    { station: string; stationName: string; printerName: string | null; items: typeof unsent }
  >();
  for (const line of unsent) {
    const resolved = resolveOfflineKotStation(line.productId);
    const key = resolved.code;
    const bucket = byStation.get(key) || {
      station: key,
      stationName: resolved.name,
      printerName: resolved.printerName,
      items: [],
    };
    bucket.items.push(line);
    byStation.set(key, bucket);
  }

  const tickets: OfflineKotTicket[] = [];
  for (const bucket of byStation.values()) {
    const kotOfflineId = newKotOfflineId();
    const kotLines = bucket.items.map((l) => ({
      lineId: l.lineId!,
      productName: l.productName,
      quantity: l.quantity,
      lineNotes: l.lineNotes ?? null,
    }));

    appendEvent({
      eventType: 'RESTAURANT_KOT_FIRED',
      key: generateEventKey(),
      orderId: order.orderId,
      kotOfflineId,
      tableId: order.tableId,
      tableCode: order.tableCode,
      tableName: order.tableName,
      waiterName: order.waiterName,
      station: bucket.station,
      orderChannel: order.channel,
      guestName: order.guestName,
      lines: kotLines,
      ts: Date.now(),
    });

    const printLines = consolidateKotLines(
      kotLines.map((l) => ({
        productId: bucket.items.find((u) => u.lineId === l.lineId)?.productId ?? null,
        productName: l.productName,
        quantity: l.quantity,
        lineNotes: l.lineNotes,
        lineId: l.lineId,
      })),
    ).map((c) => ({
      lineId: c.lineId || c.sourceIds[0] || kotLines[0]!.lineId,
      productName: c.productName,
      quantity: c.quantity,
      lineNotes: c.lineNotes,
    }));

    tickets.push({
      kotOfflineId,
      station: bucket.stationName,
      stationCode: bucket.station,
      printerName: bucket.printerName,
      lines: printLines,
    });
  }

  appendEvent({
    eventType: 'ORDER_UPDATED',
    key: generateEventKey(),
    orderId: order.orderId,
    offlineId: order.offlineId,
    lines: order.lines.map((l) =>
      l.lineId && unsent.some((u) => u.lineId === l.lineId)
        ? { ...l, kitchenSentAt: firedAt }
        : l,
    ),
    ts: Date.now(),
    channel: order.channel,
    tableId: order.tableId,
    tableCode: order.tableCode,
    tableName: order.tableName,
    waiterId: order.waiterId,
    waiterName: order.waiterName,
    guestName: order.guestName,
    guestPhone: order.guestPhone,
    deliveryAddress: order.deliveryAddress,
    pickupLabel: order.pickupLabel,
  });

  publishLanKdsBoardChanged('KOT_FIRED');
  return { tickets };
}

/**
 * Phase 5.5 — Advance local KDS ticket (SENT → PREPARING → READY → BUMPED).
 */
export function advanceRestaurantKotOffline(kotOfflineId: string): DerivedKotStatus {
  const events = getAllEvents();
  const syncState = getAllSyncState();
  const board = deriveRestaurantKitchenBoard(events, syncState);
  const ticket = board.find((t) => t.id === kotOfflineId || t.kotNumber === kotOfflineId);
  if (!ticket) throw new Error('Kitchen ticket not found in local journal');
  const next = nextKotStatus(ticket.status);
  if (!next) throw new Error('Kitchen ticket already cleared');

  appendEvent({
    eventType: 'RESTAURANT_KOT_STATUS',
    key: generateEventKey(),
    orderId: ticket.orderId,
    kotOfflineId: ticket.kotNumber,
    status: next,
    ts: Date.now(),
  });

  publishLanKdsBoardChanged('KOT_STATUS');
  return next;
}

/**
 * Phase 5.2 — Offline cash pay: append SALE_COMPLETED (same orderId), optimistic parent stock.
 * Service parents never consume parent stock (ingredients FEFO runs on server replay).
 * Recipe/BOM FEFO still runs on server replay via createSale — not locally.
 */
export function payRestaurantCheckOffline(
  order: DerivedOrder,
  opts?: { tenderedAmount?: number },
): {
  offlineId: string;
  totalAmount: number;
  tenderedAmount: number;
  changeAmount: number;
  payments: EventPayment[];
  lines: EventLine[];
  subtotal: number;
  taxAmount: number;
  discountAmount: number;
  tableLabel: string;
} {
  if (!order.tableId) throw new Error('Restaurant check missing table');
  if (!order.lines.length) throw new Error('Cannot pay an empty check');

  const totals = totalsFromLines(order.lines);
  const totalAmount = totals.totalAmount;
  const tenderedAmount = opts?.tenderedAmount ?? totalAmount;
  if (tenderedAmount < totalAmount) {
    throw new Error('Cash tendered is less than check total');
  }

  const stockDeductions: Array<{ productId: string; quantity: number }> = [];
  for (const line of order.lines) {
    if (!line.productId || line.productId.startsWith('custom_')) continue;
    const productType = resolveOfflineProductType(line.productId, line.productType);
    // Service dishes: no parent stock. Ingredients deducted on sync/createSale.
    if (isServiceProductType(productType)) continue;
    const ok = decrementLocalStock(line.productId, line.quantity);
    if (!ok) {
      for (const d of stockDeductions) restoreLocalStock(d.productId, d.quantity);
      throw new Error(`Insufficient offline stock for "${line.productName}"`);
    }
    stockDeductions.push({ productId: line.productId, quantity: line.quantity });
  }

  const offlineId = `OFF-R-PAY-${Date.now().toString(36).toUpperCase()}`;
  const payments: EventPayment[] = [{ paymentMethod: 'CASH', amount: totalAmount }];

  appendEvent({
    eventType: 'SALE_COMPLETED',
    key: generateEventKey(),
    orderId: order.orderId,
    offlineId,
    lines: order.lines,
    payments,
    subtotal: totals.subtotal,
    discountAmount: 0,
    taxAmount: totals.taxAmount,
    totalAmount,
    stockDeductions,
    ts: Date.now(),
    customerId: order.customerId,
    tableId: order.tableId,
    channel: order.channel,
    tableCode: order.tableCode,
  });

  publishLanKdsBoardChanged('SALE_COMPLETED');
  return {
    offlineId,
    totalAmount,
    tenderedAmount,
    changeAmount: tenderedAmount - totalAmount,
    payments,
    lines: order.lines,
    subtotal: totals.subtotal,
    taxAmount: totals.taxAmount,
    discountAmount: 0,
    tableLabel: order.tableName || order.tableCode || 'Table',
  };
}

/**
 * Phase 5.3 — Cancel open restaurant check locally (no stock restore — stock only deducted on pay).
 */
export function cancelRestaurantCheckOffline(
  order: DerivedOrder,
  reason = 'Cancelled from restaurant POS (offline)',
  opts?: { emitVoidTickets?: boolean },
): { voidTickets: OfflineKotTicket[] } {
  if (!order.tableId) throw new Error('Restaurant check missing table');
  // Default: VOID each station that had a FIRE ticket (same as online cancelCheck).
  // Callers that already emitted voids (e.g. void-last-line) pass emitVoidTickets: false.
  const voidTickets =
    opts?.emitVoidTickets === false
      ? []
      : emitVoidKotTicketsOffline(
          order,
          order.lines.filter((l) => l.lineId && l.kitchenSentAt),
          undefined,
          reason,
        );
  appendEvent({
    eventType: 'ORDER_CANCELLED',
    key: generateEventKey(),
    orderId: order.orderId,
    offlineId: order.offlineId,
    reason,
    tableId: order.tableId,
    tableCode: order.tableCode,
    ts: Date.now(),
  });
  publishLanKdsBoardChanged('ORDER_CANCELLED');
  return { voidTickets };
}

/**
 * Close a journal-seeded server check after online pay/cancel so local KDS + floor clear.
 * Uses SYNCED terminal events (will not re-post a second sale/cancel to the server).
 */
export function markRestaurantCheckSettledInJournal(
  orderId: string,
  kind: 'PAID' | 'CANCELLED',
  opts?: { reason?: string },
): boolean {
  if (!orderId) return false;
  const events = getAllEvents();
  const syncState = getAllSyncState();
  const open = deriveRestaurantOpenChecks(events, syncState).find((o) => o.orderId === orderId);
  if (!open?.tableId) return false;

  if (kind === 'PAID') {
    appendSyncedEvent({
      eventType: 'SALE_COMPLETED',
      key: `settled_pay_${orderId}`,
      orderId,
      offlineId: open.offlineId || orderId,
      lines: open.lines,
      payments: [{ paymentMethod: 'CASH', amount: totalsFromLines(open.lines).totalAmount }],
      subtotal: totalsFromLines(open.lines).subtotal,
      discountAmount: 0,
      taxAmount: totalsFromLines(open.lines).taxAmount,
      totalAmount: totalsFromLines(open.lines).totalAmount,
      stockDeductions: [],
      ts: Date.now(),
      customerId: open.customerId,
      tableId: open.tableId,
      channel: open.channel,
      tableCode: open.tableCode,
    });
    publishLanKdsBoardChanged('SALE_COMPLETED');
  } else {
    appendSyncedEvent({
      eventType: 'ORDER_CANCELLED',
      key: `settled_cancel_${orderId}`,
      orderId,
      offlineId: open.offlineId || orderId,
      reason: opts?.reason || 'Cancelled / voided (online)',
      tableId: open.tableId,
      tableCode: open.tableCode,
      ts: Date.now(),
    });
    publishLanKdsBoardChanged('ORDER_CANCELLED');
  }
  return true;
}

/**
 * On FOH open (online): drop journal ghosts for tables the server says are FREE.
 * Keeps ofl_ord_* local-only checks. Fixes "all tables busy" after void/pay without journal close.
 */
export function reconcileRestaurantJournalWithServerTables(
  serverTables: Array<{
    id: string;
    status: string;
    currentOrderId?: string | null;
    /** When known (multi-ticket), open server check ids for this table. */
    openOrderIds?: string[] | null;
  }>,
): { closed: number; keptLocal: number } {
  const byId = new Map(serverTables.map((t) => [t.id, t]));
  const open = deriveRestaurantOpenChecks(getAllEvents(), getAllSyncState());
  let closed = 0;
  let keptLocal = 0;
  for (const check of open) {
    if (!check.tableId) continue;
    if (isJournalLocalOrderId(check.orderId)) {
      keptLocal += 1;
      continue;
    }
    const server = byId.get(check.tableId);
    // Multi-ticket: current_order_id is only one pointer — never treat sibling mismatch as settled.
    const openIds = (server?.openOrderIds || []).filter(Boolean);
    const stale =
      !server ||
      server.status === 'FREE' ||
      !server.currentOrderId ||
      (openIds.length > 0
        ? !openIds.includes(check.orderId)
        : // Occupied without an open-id list: only clear when pointer matches this check
          // and still FREE/null would have already matched above — keep siblings.
          false);
    if (!stale) continue;
    if (markRestaurantCheckSettledInJournal(check.orderId, 'CANCELLED', {
      reason: 'Reconciled — table free / check settled on server',
    })) {
      closed += 1;
      const still = deriveRestaurantOpenChecks(getAllEvents(), getAllSyncState()).some(
        (c) => c.tableId === check.tableId,
      );
      if (!still) paintRestaurantTableFreeOffline(check.tableId);
    }
  }
  if (closed > 0) publishLanKdsBoardChanged('JOURNAL_RECONCILE');
  return { closed, keptLocal };
}

/**
 * VOID tickets must follow the same station→printer split as FIRE KOT
 * (kitchen items → kitchen printer, bar → bar). Never collapse to KITCHEN.
 */
function emitVoidKotTicketsOffline(
  order: DerivedOrder,
  sentLines: DerivedOrder['lines'],
  quantityByLineId: Record<string, number> | undefined,
  reason: string,
): OfflineKotTicket[] {
  const byStation = new Map<
    string,
    { station: string; stationName: string; printerName: string | null; items: typeof sentLines }
  >();
  for (const line of sentLines) {
    if (!line.lineId) continue;
    const voidQty = quantityByLineId?.[line.lineId] ?? line.quantity;
    const qty = Math.min(line.quantity, Math.max(0, voidQty));
    if (qty <= 0) continue;
    const resolved = resolveOfflineKotStation(line.productId);
    const key = resolved.code;
    const bucket = byStation.get(key) || {
      station: key,
      stationName: resolved.name,
      printerName: resolved.printerName,
      items: [],
    };
    bucket.items.push({ ...line, quantity: qty });
    byStation.set(key, bucket);
  }

  const tickets: OfflineKotTicket[] = [];
  for (const bucket of byStation.values()) {
    const kotOfflineId = newKotOfflineId();
    const kotLines = bucket.items.map((l) => ({
      lineId: l.lineId!,
      productName: l.productName,
      quantity: l.quantity,
      lineNotes: l.lineNotes ?? null,
    }));
    appendEvent({
      eventType: 'RESTAURANT_KOT_FIRED',
      key: generateEventKey(),
      orderId: order.orderId,
      kotOfflineId,
      tableCode: order.tableCode,
      tableName: order.tableName,
      waiterName: order.waiterName,
      station: bucket.station,
      orderChannel: order.channel,
      guestName: order.guestName,
      ticketKind: 'VOID',
      voidReason: reason,
      lines: kotLines,
      ts: Date.now(),
    });
    tickets.push({
      kotOfflineId,
      station: bucket.stationName,
      stationCode: bucket.station,
      printerName: bucket.printerName,
      lines: kotLines,
    });
  }
  if (tickets.length > 0) publishLanKdsBoardChanged('KOT_VOIDED');
  return tickets;
}

/**
 * Remove or reduce lines locally.
 * - Unsent: quiet remove (no VOID ticket).
 * - Kitchen-sent: one VOID KOT per station (same printers as FIRE), then remove/reduce.
 * `quantityByLineId` voids/reduces only that many units (Toast/Samba −1).
 */
export function removeRestaurantLinesOffline(
  order: DerivedOrder,
  lineIds: string[],
  quantityByLineId?: Record<string, number>,
  opts?: { reason?: string; allowKitchenSent?: boolean },
): { order: DerivedOrder; voidTickets: OfflineKotTicket[] } {
  if (!order.tableId) throw new Error('Restaurant check missing table');
  const idSet = new Set(lineIds);
  const touching = order.lines.filter((l) => l.lineId && idSet.has(l.lineId));
  if (touching.length === 0) throw new Error('No matching lines to remove');
  const hasKot = touching.some((l) => !!l.kitchenSentAt);
  if (hasKot && !opts?.allowKitchenSent) {
    throw new Error('Kitchen-sent lines require Void (VOID ticket)');
  }

  const reason = opts?.reason?.trim() || 'Voided from restaurant POS';
  const voidTickets = hasKot
    ? emitVoidKotTicketsOffline(
        order,
        touching.filter((l) => !!l.kitchenSentAt),
        quantityByLineId,
        reason,
      )
    : [];

  const nextLines: typeof order.lines = [];
  for (const line of order.lines) {
    if (!line.lineId || !idSet.has(line.lineId)) {
      nextLines.push(line);
      continue;
    }
    const voidQty = quantityByLineId?.[line.lineId];
    if (voidQty === undefined || voidQty >= line.quantity) {
      continue; // drop entire line
    }
    if (voidQty > 0) {
      const qty = line.quantity - voidQty;
      nextLines.push({
        ...line,
        quantity: qty,
        subtotal: qty * line.unitPrice,
      });
    }
  }

  if (nextLines.length === 0) {
    // Voids already emitted above — do not emit a second set on cancel.
    cancelRestaurantCheckOffline(order, opts?.reason || 'Removed last lines', {
      emitVoidTickets: false,
    });
    const gone = deriveRestaurantCheckForTable(
      order.tableId,
      getAllEvents(),
      getAllSyncState(),
      order.orderId,
    );
    if (gone) throw new Error('Failed to cancel check after removing all lines');
    return { order: { ...order, lines: [] }, voidTickets };
  }

  appendEvent({
    eventType: 'ORDER_UPDATED',
    key: generateEventKey(),
    orderId: order.orderId,
    offlineId: order.offlineId,
    lines: nextLines,
    ts: Date.now(),
    channel: order.channel,
    tableId: order.tableId,
    tableCode: order.tableCode,
    tableName: order.tableName,
    waiterId: order.waiterId,
    waiterName: order.waiterName,
    guestName: order.guestName,
    guestPhone: order.guestPhone,
    deliveryAddress: order.deliveryAddress,
    pickupLabel: order.pickupLabel,
    /** Server ORDER_UPDATED replay uses this when applying voidCheckItems. */
    voidReason: opts?.reason?.trim() || (hasKot ? 'Offline void' : 'Removed before kitchen send'),
  });

  const next = deriveRestaurantCheckForTable(
    order.tableId,
    getAllEvents(),
    getAllSyncState(),
    order.orderId,
  );
  if (!next) throw new Error('Failed to derive check after line remove');
  return { order: next, voidTickets };
}

/**
 * Phase 5.3 — Assign waiter on open check via ORDER_UPDATED (same journal; no parallel event bus).
 */
export function assignRestaurantWaiterOffline(
  order: DerivedOrder,
  waiter: { id: string; fullName: string },
): DerivedOrder {
  appendEvent({
    eventType: 'ORDER_UPDATED',
    key: generateEventKey(),
    orderId: order.orderId,
    offlineId: order.offlineId,
    lines: order.lines,
    ts: Date.now(),
    channel: order.channel,
    tableId: order.tableId,
    tableCode: order.tableCode,
    tableName: order.tableName,
    waiterId: waiter.id,
    waiterName: waiter.fullName,
    guestName: order.guestName,
    guestPhone: order.guestPhone,
    deliveryAddress: order.deliveryAddress,
    pickupLabel: order.pickupLabel,
  });

  const next = order.tableId
    ? deriveRestaurantCheckForTable(order.tableId, getAllEvents(), getAllSyncState())
    : null;
  if (!next) throw new Error('Failed to derive check after waiter assign');
  return next;
}

/**
 * Phase 5.4 — Transfer open check to another free table (local projection).
 */
export function transferRestaurantCheckOffline(
  order: DerivedOrder,
  to: { tableId: string; tableCode: string; tableName: string; channel?: RestaurantOrderChannel },
): DerivedOrder {
  if (!order.tableId) throw new Error('Check has no table');
  if (order.tableId === to.tableId) throw new Error('Check is already on that table');

  const occupancy = deriveRestaurantFloorOccupancy(getAllEvents(), getAllSyncState());
  if (occupancy.has(to.tableId)) {
    throw new Error('Target table must be free');
  }

  appendEvent({
    eventType: 'RESTAURANT_CHECK_TRANSFERRED',
    key: generateEventKey(),
    orderId: order.orderId,
    offlineId: order.offlineId,
    fromTableId: order.tableId,
    toTableId: to.tableId,
    toTableCode: to.tableCode,
    toTableName: to.tableName,
    channel: to.channel ?? order.channel,
    ts: Date.now(),
  });

  const next = deriveRestaurantCheckForTable(to.tableId, getAllEvents(), getAllSyncState(), order.orderId);
  if (!next) throw new Error('Failed to derive check after transfer');
  return next;
}

/**
 * Phase 5.4 — Merge secondary check into primary (all lines).
 */
export function mergeRestaurantChecksOffline(
  primary: DerivedOrder,
  secondary: DerivedOrder,
): DerivedOrder {
  if (primary.orderId === secondary.orderId) throw new Error('Cannot merge a check into itself');
  if (!secondary.lines.length) throw new Error('Secondary check has no items');
  if (!primary.tableId || primary.tableId !== secondary.tableId) {
    throw new Error('Merge only works for tickets on the same table');
  }

  appendEvent({
    eventType: 'RESTAURANT_CHECK_MERGED',
    key: generateEventKey(),
    primaryOrderId: primary.orderId,
    secondaryOrderId: secondary.orderId,
    primaryOfflineId: primary.offlineId,
    secondaryOfflineId: secondary.offlineId,
    primaryTableId: primary.tableId,
    secondaryTableId: secondary.tableId,
    ts: Date.now(),
  });

  const next = primary.tableId
    ? deriveRestaurantCheckForTable(primary.tableId, getAllEvents(), getAllSyncState(), primary.orderId)
    : null;
  if (!next) throw new Error('Failed to derive check after merge');
  return next;
}

/**
 * Phase 5.4 — Split selected lines onto a new check (same table or free target).
 */
export function splitRestaurantCheckOffline(
  source: DerivedOrder,
  input: {
    lineIds: string[];
    /** Samba Move N of M — omit or full qty means move the whole line. */
    quantityByLineId?: Record<string, number>;
    targetTableId: string;
    targetTableCode: string;
    targetTableName: string;
    sameTable: boolean;
    channel?: RestaurantOrderChannel;
  },
): { source: DerivedOrder; split: DerivedOrder } {
  if (!source.tableId) throw new Error('Source check has no table');
  if (!input.lineIds.length) throw new Error('Select at least one line to split');

  const moveSet = new Set(input.lineIds);
  const qtyBy = input.quantityByLineId || {};
  const touching = source.lines.filter((l) => l.lineId && moveSet.has(l.lineId));
  if (touching.length !== input.lineIds.length) {
    throw new Error('One or more lines are not on this check');
  }

  const movedLines: EventLine[] = [];
  let remainingUnits = source.lines.reduce((s, l) => s + l.quantity, 0);
  for (const line of touching) {
    const lineId = line.lineId!;
    const moveQty = Math.min(line.quantity, Math.max(0, qtyBy[lineId] ?? line.quantity));
    if (!(moveQty > 0)) {
      throw new Error('Move quantity must be positive');
    }
    if (moveQty > line.quantity + 1e-9) {
      throw new Error(`Cannot move ${moveQty} — only ${line.quantity} on the line`);
    }
    remainingUnits -= moveQty;
    const discount =
      line.discountAmount != null && line.quantity > 0
        ? (line.discountAmount * moveQty) / line.quantity
        : line.discountAmount;
    movedLines.push({
      ...line,
      lineId: moveQty >= line.quantity - 1e-9 ? lineId : newOfflineLineId(),
      quantity: moveQty,
      subtotal: moveQty * line.unitPrice,
      discountAmount: discount,
    });
  }
  if (remainingUnits <= 1e-9) {
    throw new Error('Cannot split all lines — leave at least one on the source check');
  }

  const sameTable = input.sameTable || input.targetTableId === source.tableId;
  if (!sameTable) {
    const occupancy = deriveRestaurantFloorOccupancy(getAllEvents(), getAllSyncState());
    if (occupancy.has(input.targetTableId)) {
      throw new Error('Target table must be free');
    }
  }

  const newOrderId = newOfflineOrderId();
  const newOfflineId = `OFF-R-SPLIT-${Date.now().toString(36).toUpperCase()}`;
  const destTableId = sameTable ? source.tableId : input.targetTableId;
  const quantityByLineId: Record<string, number> = {};
  for (const line of touching) {
    const lineId = line.lineId!;
    quantityByLineId[lineId] = Math.min(line.quantity, qtyBy[lineId] ?? line.quantity);
  }

  appendEvent({
    eventType: 'RESTAURANT_CHECK_SPLIT',
    key: generateEventKey(),
    sourceOrderId: source.orderId,
    sourceOfflineId: source.offlineId,
    newOrderId,
    newOfflineId,
    lineIds: input.lineIds,
    quantityByLineId,
    movedLines,
    sourceTableId: source.tableId,
    targetTableId: destTableId,
    targetTableCode: sameTable ? source.tableCode : input.targetTableCode,
    targetTableName: sameTable ? source.tableName : input.targetTableName,
    sameTable,
    channel: input.channel ?? source.channel,
    waiterId: source.waiterId,
    waiterName: source.waiterName,
    guestName: source.guestName,
    guestPhone: source.guestPhone,
    deliveryAddress: source.deliveryAddress,
    pickupLabel: source.pickupLabel,
    ts: Date.now(),
  });

  const events = getAllEvents();
  const syncState = getAllSyncState();
  const nextSource = deriveRestaurantCheckForTable(source.tableId, events, syncState, source.orderId);
  const nextSplit = deriveRestaurantCheckForTable(destTableId, events, syncState, newOrderId);
  if (!nextSource || !nextSplit) throw new Error('Failed to derive checks after split');
  return { source: nextSource, split: nextSplit };
}

export function totalsFromLines(lines: EventLine[]): {
  subtotal: number;
  taxAmount: number;
  totalAmount: number;
} {
  const subtotal = lines.reduce((s, l) => s + l.subtotal, 0);
  return { subtotal, taxAmount: 0, totalAmount: subtotal };
}
