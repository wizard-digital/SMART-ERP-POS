/**
 * Offline Mode Hook (v2)
 *
 * Manages network detection, offline sales queue with idempotency keys,
 * local stock tracking, and auto-sync on reconnect.
 *
 * Storage key: 'pos_offline_sales'
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useOfflineContext } from '../contexts/OfflineContext';
import { decrementLocalStock, getCachedCatalog, restoreLocalStock } from '../services/offlineCatalogService';
import { syncOfflineCustomers, acquireSyncLock, releaseSyncLock } from '../services/offlineSyncEngine';
import { decideSyncPost, isSyncPausedForAuth, pauseSyncForAuth, readThrownSync } from '../lib/syncAuthGate';
import { isServiceProductType } from '@shared/utils/productTypeRules';
import {
  appendEvent,
  getAllEvents,
  getAllSyncState,
  markSynced,
  markReview,
  markFailed,
  markCancelled,
  resetToPending,
  generateEventKey,
  clearEventJournal,
  migrateLegacyOfflineSales,
  migrateLegacyOfflineOrders,
  type PosOfflineEvent,
  type EventLine,
  type EventPayment,
  type SyncStateMap,
} from '../lib/offlineEventJournal';
import {
  deriveCompletedSales,
  deriveOpenOrders,
  type DerivedSale,
  type DerivedOrder,
} from '../lib/offlineEventSelectors';
import type { AxiosInstance } from 'axios';

// ── Re-export derived types for consumers ─────────────────────
export type { DerivedSale, DerivedOrder };

// ── Types ─────────────────────────────────────────────────────
export interface OfflineSaleLineItem {
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
  productType?: string;
}

export interface OfflineSalePaymentLine {
  paymentMethod: 'CASH' | 'CARD' | 'MOBILE_MONEY' | 'CREDIT';
  amount: number;
  reference?: string;
}

export interface OfflineSaleData {
  customerId?: string;
  cashRegisterSessionId?: string | null;
  lineItems: OfflineSaleLineItem[];
  subtotal: number;
  discountAmount: number;
  taxAmount: number;
  totalAmount: number;
  paymentLines: OfflineSalePaymentLine[];
  saleDate?: string;
}

export interface OfflineSale {
  /** Unique idempotency key – prevents double-posting on sync */
  idempotencyKey: string;
  /** Human-readable offline ID shown in UI */
  offlineId: string;
  timestamp: number;
  data: OfflineSaleData;
  status: 'PENDING_SYNC' | 'SYNCED' | 'REQUIRES_REVIEW' | 'FAILED';
  syncError?: string;
  /** Tracks which products/quantities to restore if sale is cancelled */
  stockDeductions: Array<{ productId: string; quantity: number }>;
}

// ── Offline Order Types ───────────────────────────────────────
export interface OfflineOrderItem {
  productId: string;
  productName: string;
  quantity: number;
  unitPrice: number;
  discountAmount: number;
  uomId?: string;
  baseQty?: number;
  baseUomId?: string;
  conversionFactor?: number;
}

export interface OfflineOrderData {
  customerId?: string;
  items: OfflineOrderItem[];
  notes?: string;
}

export interface OfflineOrder {
  /** Unique idempotency key – prevents double-posting on sync */
  idempotencyKey: string;
  /** Human-readable offline ID shown in UI */
  offlineId: string;
  timestamp: number;
  data: OfflineOrderData;
  status: 'PENDING_SYNC' | 'SYNCED' | 'FAILED';
  syncError?: string;
}

// ── Internal snapshot helper ──────────────────────────────────
function readJournalSnapshot(): { events: PosOfflineEvent[]; syncState: SyncStateMap } {
  return { events: getAllEvents(), syncState: getAllSyncState() };
}

// ── Hook ──────────────────────────────────────────────────────
export function useOfflineMode() {
  const { isOnline } = useOfflineContext();
  const isSyncingRef = useRef(false);

  // Run legacy migration once on first mount
  useEffect(() => {
    migrateLegacyOfflineSales();
    migrateLegacyOfflineOrders();
  }, []);

  // ── Journal state: re-derive on every journal change ─────
  const [snapshot, setSnapshot] = useState<{ events: PosOfflineEvent[]; syncState: SyncStateMap }>(
    () => readJournalSnapshot()
  );

  const refreshSnapshot = useCallback(() => {
    setSnapshot(readJournalSnapshot());
  }, []);

  useEffect(() => {
    window.addEventListener('offline-queue-updated', refreshSnapshot);
    return () => window.removeEventListener('offline-queue-updated', refreshSnapshot);
  }, [refreshSnapshot]);

  // ── Derived state ─────────────────────────────────────────
  const syncQueue: DerivedSale[] = useMemo(
    () => deriveCompletedSales(snapshot.events, snapshot.syncState),
    [snapshot]
  );

  const orderQueue: DerivedOrder[] = useMemo(
    () => deriveOpenOrders(snapshot.events, snapshot.syncState),
    [snapshot]
  );

  const pendingCount = useMemo(
    () => syncQueue.filter((s) => s.syncStatus === 'PENDING').length,
    [syncQueue]
  );

  const reviewCount = useMemo(
    () => syncQueue.filter((s) => s.syncStatus === 'REVIEW').length,
    [syncQueue]
  );

  const failedCount = useMemo(
    () => syncQueue.filter((s) => s.syncStatus === 'FAILED').length,
    [syncQueue]
  );

  const pendingOrderCount = useMemo(
    () => orderQueue.filter((o) => o.syncStatus === 'PENDING').length,
    [orderQueue]
  );

  /**
   * Save a pending order for offline sync (Dispenser → Cashier mode).
   * Appends ORDER_CREATED event — no stock deduction.
   */
  const saveOrderOffline = useCallback(
    (orderData: OfflineOrderData): string => {
      const key = generateEventKey();
      const orderId = `ofl_ord_${Date.now().toString(36)}`;
      const offlineId = `OFFLINE-ORD-${Date.now().toString(36).toUpperCase()}`;

      appendEvent({
        eventType: 'ORDER_CREATED',
        key,
        orderId,
        offlineId,
        customerId: orderData.customerId,
        notes: orderData.notes,
        lines: orderData.items.map(
          (item): EventLine => ({
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
          })
        ),
        ts: Date.now(),
      });

      refreshSnapshot();
      return offlineId;
    },
    [refreshSnapshot]
  );

  /**
   * Save a completed sale for offline sync (Direct Sale mode).
   * Deducts local stock and appends SALE_COMPLETED event.
   */
  const saveSaleOffline = useCallback(
    (saleData: OfflineSaleData): string => {
      const key = generateEventKey();
      const orderId = `ofl_ord_${Date.now().toString(36)}`;
      const offlineId = `OFFLINE-${Date.now().toString(36).toUpperCase()}`;

      // Decrement local stock for inventory items (never for service parents)
      const stockDeductions: Array<{ productId: string; quantity: number }> = [];
      for (const item of saleData.lineItems) {
        if (item.productId.startsWith('custom_')) continue;
        const catalogType = getCachedCatalog().find((p) => p.id === item.productId)?.productType;
        const productType = item.productType || catalogType || 'inventory';
        if (isServiceProductType(productType)) continue;
        const ok = decrementLocalStock(item.productId, item.quantity);
        if (!ok) {
          for (const d of stockDeductions) restoreLocalStock(d.productId, d.quantity);
          throw new Error(`Insufficient offline stock for "${item.productName}"`);
        }
        stockDeductions.push({ productId: item.productId, quantity: item.quantity });
      }

      // Strip disallowed payment methods (DEPOSIT requires server)
      const hasCustomer = !!saleData.customerId;
      const cleanedPayments: EventPayment[] = saleData.paymentLines
        .filter(
          (pl) =>
            pl.paymentMethod === 'CASH' ||
            pl.paymentMethod === 'CARD' ||
            pl.paymentMethod === 'MOBILE_MONEY' ||
            (pl.paymentMethod === 'CREDIT' && hasCustomer)
        )
        .map((pl) => ({
          paymentMethod: pl.paymentMethod,
          amount: pl.amount,
          reference: pl.reference,
        }));

      if (cleanedPayments.length === 0) {
        cleanedPayments.push({ paymentMethod: 'CASH', amount: saleData.totalAmount });
      }

      appendEvent({
        eventType: 'SALE_COMPLETED',
        key,
        orderId,
        offlineId,
        customerId: saleData.customerId,
        lines: saleData.lineItems.map(
          (item): EventLine => ({
            productId: item.productId,
            productName: item.productName,
            sku: item.sku,
            uom: item.uom,
            uomId: item.uomId,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            costPrice: item.costPrice,
            subtotal: item.subtotal,
            taxAmount: item.taxAmount,
          })
        ),
        payments: cleanedPayments,
        subtotal: saleData.subtotal,
        discountAmount: saleData.discountAmount,
        taxAmount: saleData.taxAmount,
        totalAmount: saleData.totalAmount,
        stockDeductions,
        ts: Date.now(),
      });

      refreshSnapshot();
      return offlineId;
    },
    [refreshSnapshot]
  );

  /**
   * Sync all PENDING / FAILED events to the backend via POST /api/pos/sync-events.
   * Returns a results array for toast notifications.
   */
  const syncPendingSales = useCallback(
    async (
      apiClient: AxiosInstance
    ): Promise<Array<{ offlineId: string; success: boolean; error?: string }>> => {
      if (isSyncPausedForAuth()) return [];
      if (!navigator.onLine || isSyncingRef.current) return [];
      if (!acquireSyncLock()) return [];

      isSyncingRef.current = true;
      const results: Array<{ offlineId: string; success: boolean; error?: string }> = [];

      try {
        // Sync offline customers first so we can resolve temp IDs
        let customerIdMap = new Map<string, string>();
        try {
          customerIdMap = await syncOfflineCustomers();
        } catch {
          // Non-fatal — sales without offline customers still sync
        }

        const { events, syncState } = readJournalSnapshot();
        const unsyncedEvents = events.filter((e) => {
          const s = syncState[e.key]?.status ?? 'PENDING';
          return s === 'PENDING' || s === 'FAILED';
        });

        if (unsyncedEvents.length === 0) return [];

        for (const event of unsyncedEvents) {
          // Resolve offline customer IDs in events that carry customerId
          let resolvedCustomerId =
            'customerId' in event ? event.customerId : undefined;
          if (resolvedCustomerId?.startsWith('offline_cust_')) {
            let realId = customerIdMap.get(resolvedCustomerId);
            if (!realId) {
              try {
                const offlineCusts = JSON.parse(
                  localStorage.getItem('pos_offline_customers') || '[]'
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
                // Search failed — will fall through
              }
            }
            resolvedCustomerId = realId ?? undefined;
          }

          // Build resolved event copy (avoid mutating journal)
          const resolvedEvent =
            resolvedCustomerId !== ('customerId' in event ? event.customerId : undefined)
              ? { ...event, customerId: resolvedCustomerId }
              : event;

          try {
            const response = await apiClient.post('/pos/sync-events', {
              event: resolvedEvent,
            });

            if (response.data?.success || response.status === 409) {
              markSynced(event.key);
              if (event.eventType === 'SALE_COMPLETED') {
                results.push({ offlineId: event.offlineId, success: true });
              }
            } else if (response.data?.requiresReview) {
              markReview(event.key, response.data.error);
              if (event.eventType === 'SALE_COMPLETED') {
                results.push({
                  offlineId: event.offlineId,
                  success: false,
                  error: response.data.error ?? 'Requires review',
                });
              }
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
                if (event.eventType === 'SALE_COMPLETED') {
                  results.push({
                    offlineId: event.offlineId,
                    success: false,
                    error: decision.message,
                  });
                }
              } else if (decision.kind === 'retry') {
                markFailed(event.key, decision.message);
                if (event.eventType === 'SALE_COMPLETED') {
                  results.push({
                    offlineId: event.offlineId,
                    success: false,
                    error: decision.message,
                  });
                }
              }
            }
          } catch (error: unknown) {
            const thrown = readThrownSync(error);
            const decision = decideSyncPost({
              network: thrown.network,
              online: navigator.onLine,
              status: thrown.status,
              message: thrown.message,
            });
            if (decision.kind === 'offline-stop') {
              if (event.eventType === 'SALE_COMPLETED') {
                results.push({ offlineId: event.offlineId, success: false, error: 'Still offline' });
              }
              break;
            }
            if (decision.kind === 'synced') {
              markSynced(event.key);
              if (event.eventType === 'SALE_COMPLETED') {
                results.push({ offlineId: event.offlineId, success: true });
              }
              continue;
            }
            if (decision.kind === 'auth-stop') {
              pauseSyncForAuth();
              break;
            }
            if (decision.kind === 'review') {
              markReview(event.key, decision.message);
              if (event.eventType === 'SALE_COMPLETED') {
                results.push({
                  offlineId: event.offlineId,
                  success: false,
                  error: decision.message,
                });
              }
              continue;
            }
            markFailed(event.key, decision.message);
            if (event.eventType === 'SALE_COMPLETED') {
              results.push({ offlineId: event.offlineId, success: false, error: decision.message });
            }
          }
        }

        window.dispatchEvent(new CustomEvent('offline-queue-updated'));
      } finally {
        isSyncingRef.current = false;
        releaseSyncLock();
      }

      refreshSnapshot();
      return results;
    },
    [refreshSnapshot]
  );

  /**
   * Cancel an unsynced sale: restore stock and mark the event CANCELLED.
   * The event is NOT removed from the journal (immutable).
   */
  const cancelOfflineSale = useCallback(
    (key: string) => {
      const events = getAllEvents();
      const event = events.find((e) => e.key === key && e.eventType === 'SALE_COMPLETED');
      if (event && event.eventType === 'SALE_COMPLETED') {
        for (const d of event.stockDeductions) {
          restoreLocalStock(d.productId, d.quantity);
        }
      }
      markCancelled(key);
      refreshSnapshot();
    },
    [refreshSnapshot]
  );

  /** Clear the entire journal (dev reset / "Clear All Data"). */
  const clearSyncQueue = useCallback(() => {
    clearEventJournal();
    refreshSnapshot();
  }, [refreshSnapshot]);

  /** Retry a single FAILED or REVIEW sale by resetting it to PENDING. */
  const retryFailedSale = useCallback(
    (key: string) => {
      resetToPending([key]);
      refreshSnapshot();
    },
    [refreshSnapshot]
  );

  /** Retry all FAILED and REVIEW sales at once. */
  const retryAllFailed = useCallback(() => {
    resetToPending();
    refreshSnapshot();
  }, [refreshSnapshot]);

  return {
    isOnline,
    syncQueue,
    orderQueue,
    saveSaleOffline,
    saveOrderOffline,
    syncPendingSales,
    cancelOfflineSale,
    clearSyncQueue,
    retryFailedSale,
    retryAllFailed,
    pendingCount,
    pendingOrderCount,
    reviewCount,
    failedCount,
  };
}

