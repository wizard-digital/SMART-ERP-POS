/**
 * Offline Event Journal
 *
 * Implements an append-only immutable event log for offline POS operations.
 * Events are NEVER deleted or modified — only appended.
 * Sync status is stored separately in pos_sync_state.
 *
 * Storage layout:
 *   localStorage['pos_offline_events']   — append-only event journal
 *   localStorage['pos_sync_state']       — { [key]: SyncStateEntry }
 *
 * Design principles:
 * - Immutable journal prevents data loss during crashes or SW/FG sync races
 * - Separate sync state means journal replay is always deterministic
 * - Each event carries its own idempotency key for server-side deduplication
 * - Quota reclaim may drop SYNCED/CANCELLED history for closed tickets only
 *   (PENDING/FAILED/REVIEW + open checks stay — Toast/Square cache eviction)
 */

import { deriveOpenOrders } from './offlineEventSelectors';
import {
  isQuotaExceededError,
  reclaimOriginStorage,
  registerOriginStorageReclaim,
} from './originStorageQuota';

// ── Storage Keys ──────────────────────────────────────────────
export const JOURNAL_KEY = 'pos_offline_events';
export const SYNC_STATE_KEY = 'pos_sync_state';

// ── Status Types ──────────────────────────────────────────────
export type SyncStatus = 'PENDING' | 'SYNCED' | 'REVIEW' | 'FAILED' | 'CANCELLED';

export interface SyncStateEntry {
    status: SyncStatus;
    /** Error message for FAILED or REVIEW statuses */
    error?: string;
}

export type SyncStateMap = Record<string, SyncStateEntry>;

// ── Event Shape Types ─────────────────────────────────────────

export interface EventLine {
    productId: string;
    productName: string;
    sku: string;
    uom: string;
    uomId?: string;
    quantity: number;
    unitPrice: number;
    costPrice: number;
    subtotal: number;
    taxAmount: number;
    discountAmount?: number;
    /** inventory | consumable | service — drives offline stock skip for services */
    productType?: string;
    /** Stable client line id (restaurant offline KOT tracking) */
    lineId?: string;
    lineNotes?: string | null;
    /** ISO timestamp when KOT fired for this line */
    kitchenSentAt?: string | null;
    /** Who rang this line (login actor) — not check owner. */
    addedBy?: string | null;
    addedByName?: string | null;
    /** When the line was rung. */
    addedAt?: string | null;
}

/** Optional restaurant fields on ORDER_* events (Phase 5.1) */
export type RestaurantOrderChannel = 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY';

export interface EventPayment {
    paymentMethod: 'CASH' | 'CARD' | 'MOBILE_MONEY' | 'AIRTEL_MONEY' | 'CREDIT' | 'GIFT';
    amount: number;
    reference?: string;
}

// ── Discriminated Union Event Type ────────────────────────────

export type PosOfflineEvent =
    | {
        eventType: 'ORDER_CREATED';
        /** Idempotency key — unique per event */
        key: string;
        /** Stable order ID shared across ORDER_* and SALE_COMPLETED events */
        orderId: string;
        /** Human-readable ID shown in UI */
        offlineId: string;
        lines: EventLine[];
        customerId?: string;
        notes?: string;
        ts: number;
        /** Phase 5.1 restaurant */
        channel?: RestaurantOrderChannel;
        tableId?: string;
        tableCode?: string;
        tableName?: string;
        waiterId?: string;
        waiterName?: string;
        guestName?: string | null;
        guestPhone?: string | null;
        deliveryAddress?: string | null;
        pickupLabel?: string | null;
    }
    | {
        eventType: 'ORDER_UPDATED';
        key: string;
        orderId: string;
        /** Present for restaurant checks so sync schema can validate */
        offlineId?: string;
        lines: EventLine[];
        customerId?: string;
        notes?: string;
        ts: number;
        channel?: RestaurantOrderChannel;
        tableId?: string;
        tableCode?: string;
        tableName?: string;
        waiterId?: string;
        waiterName?: string;
        guestName?: string | null;
        guestPhone?: string | null;
        deliveryAddress?: string | null;
        pickupLabel?: string | null;
        /** When lines were removed offline — replay uses voidCheckItems with this reason. */
        voidReason?: string;
    }
    | {
        eventType: 'ORDER_CANCELLED';
        key: string;
        orderId: string;
        /** Human-readable check id (OFF-R-…) for sync / UI */
        offlineId?: string;
        reason?: string;
        ts: number;
        /** Phase 5.3 — free floor on replay */
        tableId?: string;
        tableCode?: string;
    }
    | {
        eventType: 'PAYMENT_ADDED';
        key: string;
        orderId: string;
        payments: EventPayment[];
        subtotal: number;
        discountAmount: number;
        taxAmount: number;
        totalAmount: number;
        stockDeductions: Array<{ productId: string; quantity: number }>;
        ts: number;
    }
    | {
        eventType: 'SALE_COMPLETED';
        key: string;
        orderId: string;
        /** Human-readable ID shown in UI */
        offlineId: string;
        // Fully denormalized sale data for deterministic sync (no event replay required)
        customerId?: string;
        lines: EventLine[];
        payments: EventPayment[];
        subtotal: number;
        discountAmount: number;
        taxAmount: number;
        totalAmount: number;
        giftReason?: string;
        /** Track which products/quantities to restore if the sale is cancelled */
        stockDeductions: Array<{ productId: string; quantity: number }>;
        ts: number;
        /** Phase 5.2 — restaurant table link for order complete + floor release on replay */
        tableId?: string;
        channel?: RestaurantOrderChannel;
        tableCode?: string;
    }
    | {
        eventType: 'SALE_VOIDED';
        key: string;
        saleId: string;
        reason: string;
        ts: number;
    }
    | {
        /** Phase 5.1 — KOT printed locally; server kot insert deferred to sync handler */
        eventType: 'RESTAURANT_KOT_FIRED';
        key: string;
        orderId: string;
        kotOfflineId: string;
        /** Floor table id — used by sync replayer when orderId is still ofl_ord_*. */
        tableId?: string;
        tableCode?: string;
        tableName?: string;
        waiterName?: string;
        station?: string;
        orderChannel?: string;
        guestName?: string | null;
        /** FIRE (default) or VOID stop ticket for kitchen-sent lines */
        ticketKind?: 'FIRE' | 'VOID';
        voidReason?: string;
        lines: Array<{
            lineId: string;
            productName: string;
            quantity: number;
            lineNotes?: string | null;
        }>;
        ts: number;
    }
    | {
        /** Phase 5.4 — move entire check to another table */
        eventType: 'RESTAURANT_CHECK_TRANSFERRED';
        key: string;
        orderId: string;
        offlineId?: string;
        fromTableId: string;
        toTableId: string;
        toTableCode?: string;
        toTableName?: string;
        channel?: RestaurantOrderChannel;
        ts: number;
    }
    | {
        /** Phase 5.4 — merge secondary check into primary (all lines) */
        eventType: 'RESTAURANT_CHECK_MERGED';
        key: string;
        primaryOrderId: string;
        secondaryOrderId: string;
        primaryOfflineId?: string;
        secondaryOfflineId?: string;
        primaryTableId?: string;
        secondaryTableId?: string;
        ts: number;
    }
    | {
        /** Phase 5.4 — split selected lines onto new check */
        eventType: 'RESTAURANT_CHECK_SPLIT';
        key: string;
        sourceOrderId: string;
        sourceOfflineId?: string;
        newOrderId: string;
        newOfflineId: string;
        lineIds: string[];
        /** Samba Move N of M — when set, only that many units leave each source line. */
        quantityByLineId?: Record<string, number>;
        movedLines: EventLine[];
        sourceTableId: string;
        targetTableId: string;
        targetTableCode?: string;
        targetTableName?: string;
        sameTable: boolean;
        channel?: RestaurantOrderChannel;
        waiterId?: string;
        waiterName?: string;
        guestName?: string | null;
        guestPhone?: string | null;
        deliveryAddress?: string | null;
        pickupLabel?: string | null;
        ts: number;
    }
    | {
        /** Phase 5.5 — KDS ticket status on LAN / same-device journal board */
        eventType: 'RESTAURANT_KOT_STATUS';
        key: string;
        orderId: string;
        kotOfflineId: string;
        status: 'SENT' | 'PREPARING' | 'READY' | 'BUMPED';
        ts: number;
    };

// ── Internal Helpers ──────────────────────────────────────────
/** In-memory mirrors so FOH taps don't JSON.parse localStorage on every derive. */
let journalCache: PosOfflineEvent[] | null = null;
let syncStateCache: SyncStateMap | null = null;

function readJournal(): PosOfflineEvent[] {
    if (journalCache) return journalCache;
    try {
        const raw = localStorage.getItem(JOURNAL_KEY);
        if (!raw) {
            journalCache = [];
            return journalCache;
        }
        const parsed = JSON.parse(raw);
        journalCache = Array.isArray(parsed) ? (parsed as PosOfflineEvent[]) : [];
        return journalCache;
    } catch {
        journalCache = [];
        return journalCache;
    }
}

function writeJournalUnchecked(events: PosOfflineEvent[]): void {
    journalCache = events;
    localStorage.setItem(JOURNAL_KEY, JSON.stringify(events));
}

function writeJournal(events: PosOfflineEvent[]): void {
    journalCache = events;
    try {
        localStorage.setItem(JOURNAL_KEY, JSON.stringify(events));
    } catch (err) {
        if (!isQuotaExceededError(err)) throw err;
        reclaimOriginStorage();
        localStorage.setItem(JOURNAL_KEY, JSON.stringify(journalCache ?? events));
    }
}

function readSyncState(): SyncStateMap {
    if (syncStateCache) return syncStateCache;
    try {
        const raw = localStorage.getItem(SYNC_STATE_KEY);
        if (!raw) {
            syncStateCache = {};
            return syncStateCache;
        }
        const parsed = JSON.parse(raw);
        syncStateCache =
            typeof parsed === 'object' && parsed !== null ? (parsed as SyncStateMap) : {};
        return syncStateCache;
    } catch {
        syncStateCache = {};
        return syncStateCache;
    }
}

function writeSyncStateUnchecked(state: SyncStateMap): void {
    syncStateCache = state;
    localStorage.setItem(SYNC_STATE_KEY, JSON.stringify(state));
}

function writeSyncState(state: SyncStateMap): void {
    syncStateCache = state;
    try {
        localStorage.setItem(SYNC_STATE_KEY, JSON.stringify(state));
    } catch (err) {
        if (!isQuotaExceededError(err)) throw err;
        reclaimOriginStorage();
        localStorage.setItem(SYNC_STATE_KEY, JSON.stringify(syncStateCache ?? state));
    }
}

/** Drop in-memory mirrors so other tabs / devices re-read localStorage. */
export function invalidateJournalMemoryCache(): void {
    journalCache = null;
    syncStateCache = null;
}

// Cross-tab: Tab A writes journal → Tab B storage event clears stale memory cache.
if (typeof window !== 'undefined') {
    window.addEventListener('storage', (e) => {
        if (e.key === JOURNAL_KEY || e.key === SYNC_STATE_KEY || e.key === null) {
            invalidateJournalMemoryCache();
        }
    });
}

function orderIdsOnEvent(event: PosOfflineEvent): string[] {
    const ids: string[] = [];
    if ('orderId' in event && event.orderId) ids.push(event.orderId);
    if ('primaryOrderId' in event && event.primaryOrderId) ids.push(event.primaryOrderId);
    if ('secondaryOrderId' in event && event.secondaryOrderId) ids.push(event.secondaryOrderId);
    if ('sourceOrderId' in event && event.sourceOrderId) ids.push(event.sourceOrderId);
    if ('newOrderId' in event && event.newOrderId) ids.push(event.newOrderId);
    return ids;
}

function isUnsyncedStatus(status: SyncStatus | undefined): boolean {
    const st = status ?? 'PENDING';
    return st === 'PENDING' || st === 'FAILED' || st === 'REVIEW';
}

/**
 * Drop SYNCED/CANCELLED history for tickets already closed and fully synced.
 * Never drops:
 *  - PENDING/FAILED/REVIEW events
 *  - any event for an order that still has an unsynced sibling (avoids resurrecting a closed check)
 *  - events that still reconstruct an OPEN check
 * Returns number of events removed.
 */
export function compactSyncedClosedJournal(): number {
    const events = readJournal();
    const state = readSyncState();
    if (events.length === 0) return 0;
    const openIds = new Set(deriveOpenOrders(events, state).map((o) => o.orderId));
    const unsyncedOrderIds = new Set<string>();
    for (const e of events) {
        if (!isUnsyncedStatus(state[e.key]?.status)) continue;
        for (const id of orderIdsOnEvent(e)) unsyncedOrderIds.add(id);
    }
    const keep = events.filter((e) => {
        if (isUnsyncedStatus(state[e.key]?.status)) return true;
        const ids = orderIdsOnEvent(e);
        if (ids.length === 0) return false;
        return ids.some((id) => openIds.has(id) || unsyncedOrderIds.has(id));
    });
    const dropped = events.length - keep.length;
    if (dropped === 0) return 0;
    const keepKeys = new Set(keep.map((e) => e.key));
    const nextState: SyncStateMap = {};
    for (const [key, entry] of Object.entries(state)) {
        if (keepKeys.has(key)) nextState[key] = entry;
    }
    writeJournalUnchecked(keep);
    writeSyncStateUnchecked(nextState);
    return dropped;
}

registerOriginStorageReclaim(compactSyncedClosedJournal);

// ── Public API ────────────────────────────────────────────────

/**
 * Append an event to the immutable journal.
 * - Idempotent: calling with the same key twice is a no-op
 * - Initialises sync state entry as PENDING on first append
 */
export function appendEvent(event: PosOfflineEvent): void {
    const journal = readJournal();
    // Guard: never append the same event key twice
    if (journal.some((e) => e.key === event.key)) return;
    writeJournal([...journal, event]);

    const state = readSyncState();
    if (!(event.key in state)) {
        state[event.key] = { status: 'PENDING' };
        writeSyncState(state);
    }
}

/** Return all events in the journal (read-only snapshot). */
export function getAllEvents(): PosOfflineEvent[] {
    return readJournal();
}

/**
 * Return all events whose sync state is PENDING or FAILED.
 * Events with no state entry are treated as PENDING.
 */
export function getUnsyncedEvents(): PosOfflineEvent[] {
    const journal = readJournal();
    const state = readSyncState();
    return journal.filter((e) => {
        const entry = state[e.key];
        const s = entry?.status ?? 'PENDING';
        return s === 'PENDING' || s === 'FAILED';
    });
}

/** Mark an event as successfully synced (idempotent). */
export function markSynced(key: string): void {
    const state = readSyncState();
    state[key] = { status: 'SYNCED' };
    writeSyncState(state);
}

/**
 * Append an event already known to the server (hydration) — marked SYNCED so
 * OfflineAutoSync will not re-POST it. Idempotent on event.key.
 */
export function appendSyncedEvent(event: PosOfflineEvent): void {
    const journal = readJournal();
    if (journal.some((e) => e.key === event.key)) {
        markSynced(event.key);
        return;
    }
    // Also skip if this orderId already has an ORDER_CREATED (avoid duplicates).
    if (
        event.eventType === 'ORDER_CREATED' &&
        journal.some(
            (e) =>
                e.eventType === 'ORDER_CREATED' &&
                'orderId' in e &&
                e.orderId === event.orderId,
        )
    ) {
        return;
    }
    writeJournal([...journal, event]);
    markSynced(event.key);
}

/** Mark an event as requiring manual review (e.g. stock conflict). */
export function markReview(key: string, error?: string): void {
    const state = readSyncState();
    state[key] = { status: 'REVIEW', error };
    writeSyncState(state);
}

/** Mark an event as permanently failed. */
export function markFailed(key: string, error?: string): void {
    const state = readSyncState();
    state[key] = { status: 'FAILED', error };
    writeSyncState(state);
}

/** Cancel an unsynced event (prevents it from ever being synced). */
export function markCancelled(key: string): void {
    const state = readSyncState();
    state[key] = { status: 'CANCELLED' };
    writeSyncState(state);
}

/**
 * Reset FAILED or REVIEW events back to PENDING for retry.
 * Optionally pass specific keys; if omitted, resets all.
 */
export function resetToPending(keys?: string[]): void {
    const state = readSyncState();
    const targets = keys ?? Object.keys(state);
    for (const key of targets) {
        const entry = state[key];
        if (entry?.status === 'FAILED' || entry?.status === 'REVIEW') {
            state[key] = { status: 'PENDING' };
        }
    }
    writeSyncState(state);
}

/** Get sync status for a single event key. */
export function getSyncStatus(key: string): SyncStatus {
    const state = readSyncState();
    return state[key]?.status ?? 'PENDING';
}

/** Get sync state entry (status + optional error) for a single key. */
export function getSyncEntry(key: string): SyncStateEntry {
    const state = readSyncState();
    return state[key] ?? { status: 'PENDING' };
}

/** Return the full sync state map. */
export function getAllSyncState(): SyncStateMap {
    return readSyncState();
}

/**
 * Clear the entire journal and sync state.
 * USE WITH CAUTION — this permanently discards all offline events.
 * Intended for "Clear All Data" / dev reset flows only.
 */
export function clearEventJournal(): void {
    localStorage.removeItem(JOURNAL_KEY);
    localStorage.removeItem(SYNC_STATE_KEY);
}

/** Generate a unique idempotency key for a new event. */
export function generateEventKey(): string {
    return `ofl_${Date.now()}_${Math.random().toString(36).substr(2, 12)}`;
}

// ── Migration: Old pos_offline_sales → Event Journal ─────────

/**
 * One-time migration: converts any PENDING_SYNC entries from the legacy
 * pos_offline_sales array into SALE_COMPLETED events in the new journal.
 *
 * Safe to call repeatedly — already-migrated keys are skipped via the
 * idempotent appendEvent guard. Does NOT remove the old queue.
 */
export function migrateLegacyOfflineSales(): void {
    try {
        const raw = localStorage.getItem('pos_offline_sales');
        if (!raw) return;
        const sales: Array<{
            idempotencyKey: string;
            offlineId: string;
            timestamp: number;
            status: string;
            data: {
                customerId?: string;
                lineItems: Array<{
                    productId: string;
                    productName: string;
                    sku?: string;
                    uom?: string;
                    uomId?: string;
                    quantity: number;
                    unitPrice: number;
                    costPrice: number;
                    subtotal: number;
                    taxAmount: number;
                    discountAmount?: number;
                }>;
                paymentLines: EventPayment[];
                subtotal: number;
                discountAmount?: number;
                taxAmount: number;
                totalAmount: number;
            };
            stockDeductions?: Array<{ productId: string; quantity: number }>;
        }> = JSON.parse(raw);

        if (!Array.isArray(sales)) return;

        for (const sale of sales) {
            if (sale.status !== 'PENDING_SYNC') continue;
            if (!sale.idempotencyKey || !sale.offlineId) continue;

            const event: PosOfflineEvent = {
                eventType: 'SALE_COMPLETED',
                key: sale.idempotencyKey,
                orderId: sale.offlineId,
                offlineId: sale.offlineId,
                customerId: sale.data.customerId,
                lines: sale.data.lineItems.map((item) => ({
                    productId: item.productId,
                    productName: item.productName,
                    sku: item.sku ?? '',
                    uom: item.uom ?? 'PIECE',
                    uomId: item.uomId,
                    quantity: item.quantity,
                    unitPrice: item.unitPrice,
                    costPrice: item.costPrice,
                    subtotal: item.subtotal,
                    taxAmount: item.taxAmount,
                    discountAmount: item.discountAmount,
                })),
                payments: sale.data.paymentLines,
                subtotal: sale.data.subtotal,
                discountAmount: sale.data.discountAmount ?? 0,
                taxAmount: sale.data.taxAmount,
                totalAmount: sale.data.totalAmount,
                stockDeductions: sale.stockDeductions ?? [],
                ts: sale.timestamp,
            };

            appendEvent(event);
        }
    } catch {
        // Migration is best-effort — never throw
    }
}

/**
 * One-time migration: converts any PENDING_SYNC entries from the legacy
 * pos_offline_orders array into ORDER_CREATED events in the new journal.
 */
export function migrateLegacyOfflineOrders(): void {
    try {
        const raw = localStorage.getItem('pos_offline_orders');
        if (!raw) return;
        const orders: Array<{
            idempotencyKey: string;
            offlineId: string;
            timestamp: number;
            status: string;
            data: {
                customerId?: string;
                items: Array<{
                    productId: string;
                    productName: string;
                    quantity: number;
                    unitPrice: number;
                    discountAmount?: number;
                    uomId?: string;
                }>;
                notes?: string;
            };
        }> = JSON.parse(raw);

        if (!Array.isArray(orders)) return;

        for (const order of orders) {
            if (order.status !== 'PENDING_SYNC') continue;
            if (!order.idempotencyKey || !order.offlineId) continue;

            const event: PosOfflineEvent = {
                eventType: 'ORDER_CREATED',
                key: order.idempotencyKey,
                orderId: order.offlineId,
                offlineId: order.offlineId,
                lines: order.data.items.map((item) => ({
                    productId: item.productId,
                    productName: item.productName,
                    sku: '',
                    uom: 'PIECE',
                    uomId: item.uomId,
                    quantity: item.quantity,
                    unitPrice: item.unitPrice,
                    costPrice: 0,
                    subtotal: item.quantity * item.unitPrice - (item.discountAmount ?? 0),
                    taxAmount: 0,
                    discountAmount: item.discountAmount,
                })),
                customerId: order.data.customerId,
                notes: order.data.notes,
                ts: order.timestamp,
            };

            appendEvent(event);
        }
    } catch {
        // Migration is best-effort — never throw
    }
}
