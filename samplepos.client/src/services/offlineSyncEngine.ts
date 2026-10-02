/**
 * Offline Sync Engine
 *
 * App-level sync logic that runs independently of page components.
 * Reads the immutable event journal from localStorage, attempts to POST
 * each PENDING/FAILED event to /api/pos/sync-events, and updates sync state.
 *
 * Uses a module-level lock (`syncing`) to prevent concurrent syncs
 * across all callers in the same tab.
 *
 * Dispatches a `offline-queue-updated` CustomEvent after every run
 * so that page-level hooks (useOfflineMode) can refresh their state.
 */

import apiClient from '../utils/api';
import type { AxiosError } from 'axios';
import {
    getUnsyncedEvents,
    markSynced,
    markReview,
    markFailed,
    getAllSyncState,
} from '../lib/offlineEventJournal';
import {
    decideSyncPost,
    isSyncPausedForAuth,
    pauseSyncForAuth,
    readThrownSync,
} from '../lib/syncAuthGate';

const OFFLINE_CUSTOMERS_KEY = 'pos_offline_customers';

/** Module-level lock — only one sync at a time per tab */
let syncing = false;

/**
 * Shared sync lock — prevents concurrent syncs across hook and engine.
 * Returns true if lock was acquired, false if already locked.
 */
export function acquireSyncLock(): boolean {
    if (syncing) return false;
    syncing = true;
    return true;
}

/** Release the shared sync lock. */
export function releaseSyncLock(): void {
    syncing = false;
}

// ── Public API ────────────────────────────────────────────────

export interface SyncResult {
    synced: number;
    failed: number;
    review: number;
}

/**
 * Returns true if there are PENDING or FAILED events in the journal.
 */
export function hasPendingSales(): boolean {
    try {
        return getUnsyncedEvents().length > 0;
    } catch {
        return false;
    }
}

/**
 * Returns true if there are PENDING ORDER_CREATED events in the journal.
 */
export function hasPendingOrders(): boolean {
    try {
        const syncState = getAllSyncState();
        return getUnsyncedEvents().some(
            (e) =>
                e.eventType === 'ORDER_CREATED' &&
                (syncState[e.key]?.status === 'PENDING' || syncState[e.key]?.status === 'FAILED')
        );
    } catch {
        return false;
    }
}

/**
 * Sync offline-created customers to the server.
 * Returns a map of temp offline IDs → real server UUIDs so that
 * pending events can update their customerId before syncing.
 */
export async function syncOfflineCustomers(): Promise<Map<string, string>> {
    const idMap = new Map<string, string>();
    if (!navigator.onLine) return idMap;

    try {
        const raw = localStorage.getItem(OFFLINE_CUSTOMERS_KEY);
        if (!raw) return idMap;
        const queue: Array<{
            id: string;
            name: string;
            email?: string;
            phone?: string;
            address?: string;
            creditLimit?: number;
            unlimitedCredit?: boolean;
            whtLiable?: boolean;
            defaultWhtTypeId?: string | null;
        }> = JSON.parse(raw);
        if (queue.length === 0) return idMap;

        const remaining: typeof queue = [];

        for (const cust of queue) {
            try {
                const payload: Record<string, unknown> = {
                    name: cust.name,
                    creditLimit: cust.creditLimit ?? 0,
                    unlimitedCredit: cust.unlimitedCredit === true,
                    whtLiable: cust.whtLiable === true,
                    defaultWhtTypeId: cust.whtLiable === true ? cust.defaultWhtTypeId || null : null,
                };
                if (cust.email) payload.email = cust.email;
                if (cust.phone) payload.phone = cust.phone;
                if (cust.address) payload.address = cust.address;

                const response = await apiClient.post('customers', payload);
                if (response.data?.success && response.data?.data?.id) {
                    idMap.set(cust.id, response.data.data.id as string);
                } else {
                    remaining.push(cust);
                }
            } catch (err: unknown) {
                const axErr = err as AxiosError;
                if (axErr.code === 'ERR_NETWORK' || !navigator.onLine) break;

                const status = axErr.response?.status;
                const errMsg = (axErr.response?.data as Record<string, unknown>)?.error;
                const isDuplicate = status === 409 ||
                    (typeof errMsg === 'string' && (errMsg.includes('already exists') || errMsg.includes('duplicate')));

                if (isDuplicate) {
                    const idMatch = typeof errMsg === 'string' && errMsg.match(/id:\s*([0-9a-f-]{36})/);
                    if (idMatch) {
                        idMap.set(cust.id, idMatch[1]);
                    } else {
                        try {
                            const searchResp = await apiClient.get('customers/search', { params: { q: cust.name, limit: 1 } });
                            const found = (searchResp.data?.data as Array<{ id: string }>)?.[0];
                            if (found?.id) {
                                idMap.set(cust.id, found.id);
                            }
                        } catch {
                            // Search failed — still remove from queue
                        }
                    }
                } else {
                    remaining.push(cust);
                }
            }
        }

        localStorage.setItem(OFFLINE_CUSTOMERS_KEY, JSON.stringify(remaining));
        return idMap;
    } catch {
        return idMap;
    }
}

/**
 * Attempt to sync all PENDING/FAILED events from the immutable journal.
 * POSTs each event to /api/pos/sync-events (idempotency-protected).
 * Dispatches `offline-queue-updated` event when done.
 */
export async function syncOfflineSales(): Promise<SyncResult> {
    if (isSyncPausedForAuth()) return { synced: 0, failed: 0, review: 0 };
    if (!navigator.onLine || !acquireSyncLock()) return { synced: 0, failed: 0, review: 0 };

    let syncedCount = 0;
    let failedCount = 0;
    let reviewCount = 0;

    try {
        let customerIdMap = new Map<string, string>();
        try {
            customerIdMap = await syncOfflineCustomers();
        } catch {
            // Non-fatal
        }

        const unsyncedEvents = getUnsyncedEvents();
        if (unsyncedEvents.length === 0) return { synced: 0, failed: 0, review: 0 };

        for (const event of unsyncedEvents) {
            // Resolve offline customer IDs
            let resolvedCustomerId =
                'customerId' in event ? event.customerId : undefined;
            if (resolvedCustomerId?.startsWith('offline_cust_')) {
                let realId = customerIdMap.get(resolvedCustomerId);
                if (!realId) {
                    try {
                        const offlineCusts = JSON.parse(
                            localStorage.getItem(OFFLINE_CUSTOMERS_KEY) || '[]'
                        ) as Array<{ id: string; name: string }>;
                        const custEntry = offlineCusts.find((c) => c.id === resolvedCustomerId);
                        if (custEntry?.name) {
                            const searchResp = await apiClient.get('/customers/search', {
                                params: { q: custEntry.name, limit: 1 },
                            });
                            const found = (searchResp.data?.data as Array<{ id: string }>)?.[0];
                            if (found?.id) realId = found.id;
                        }
                    } catch {
                        // Fall through
                    }
                }
                resolvedCustomerId = realId ?? undefined;
            }

            const resolvedEvent =
                resolvedCustomerId !== ('customerId' in event ? event.customerId : undefined)
                    ? { ...event, customerId: resolvedCustomerId }
                    : event;

            try {
                const response = await apiClient.post('/pos/sync-events', { event: resolvedEvent });

                if (response.data?.success || response.status === 409) {
                    markSynced(event.key);
                    syncedCount++;
                } else if (response.data?.requiresReview) {
                    markReview(event.key, response.data.error);
                    reviewCount++;
                } else {
                    const serverMsg = response.data?.error;
                    const decision = decideSyncPost({
                        network: false,
                        online: navigator.onLine,
                        status: response.status,
                        message: typeof serverMsg === 'string' ? serverMsg : 'Sync rejected',
                    });
                    if (decision.kind === 'auth-stop') {
                        pauseSyncForAuth();
                        break;
                    }
                    if (decision.kind === 'review') {
                        markReview(event.key, decision.message);
                        reviewCount++;
                    } else if (decision.kind === 'retry') {
                        markFailed(event.key, decision.message);
                        failedCount++;
                    }
                }
            } catch (err: unknown) {
                const thrown = readThrownSync(err);
                const decision = decideSyncPost({
                    network: thrown.network,
                    online: navigator.onLine,
                    status: thrown.status,
                    message: thrown.message,
                });
                if (decision.kind === 'offline-stop') break;
                if (decision.kind === 'synced') {
                    markSynced(event.key);
                    syncedCount++;
                    continue;
                }
                if (decision.kind === 'auth-stop') {
                    pauseSyncForAuth();
                    break;
                }
                if (decision.kind === 'review') {
                    markReview(event.key, decision.message);
                    reviewCount++;
                    continue;
                }
                markFailed(event.key, decision.message);
                failedCount++;
            }
        }

        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('offline-queue-updated'));
        }

        return { synced: syncedCount, failed: failedCount, review: reviewCount };
    } finally {
        releaseSyncLock();
    }
}

/**
 * Sync all PENDING ORDER_CREATED events from the journal.
 * Delegates to syncOfflineSales — the event journal handles all event types.
 */
export async function syncOfflineOrders(): Promise<SyncResult> {
    return syncOfflineSales();
}

/**
 * Register a Background Sync tag so the browser can retry sync
 * even after the tab is closed (Progressive Enhancement — no-op
 * in browsers that don't support SyncManager).
 */
export async function registerBackgroundSync(): Promise<void> {
    if (!('serviceWorker' in navigator)) return;
    try {
        const reg = await navigator.serviceWorker.ready;
        if ('sync' in reg) {
            await (reg.sync as { register: (tag: string) => Promise<void> }).register('sync-offline-sales');
        }
    } catch {
        // Background Sync not available — app-level retry is the fallback
    }
}

