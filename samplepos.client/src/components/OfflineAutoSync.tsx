/**
 * OfflineAutoSync
 *
 * Invisible app-level component that ensures offline sales sync
 * regardless of which page the user is on.
 *
 * Responsibilities:
 * 1. Trigger sync when connectivity transitions offline → online
 * 2. Retry pending syncs every 30 seconds while online
 * 3. Register Background Sync so the browser can retry after tab close
 *
 * Renders nothing — mount once at the app root.
 */

import { useEffect, useRef } from 'react';
import toast from 'react-hot-toast';
import { useOfflineContext } from '../contexts/OfflineContext';
import {
    syncOfflineSales,
    syncOfflineOrders,
    hasPendingSales,
    hasPendingOrders,
    registerBackgroundSync,
} from '../services/offlineSyncEngine';
import { isSyncPausedForAuth } from '../lib/syncAuthGate';

const RETRY_INTERVAL_MS = 30_000; // 30 seconds

export default function OfflineAutoSync() {
    const { isOnline } = useOfflineContext();
    const wasOfflineRef = useRef(!navigator.onLine);

    // ── Auto-sync on reconnect ──────────────────────────────────
    useEffect(() => {
        if (isOnline && wasOfflineRef.current) {
            // We just transitioned offline → online
            // CRITICAL: Chain sequentially — both use the same sync lock.
            // Firing them concurrently causes the second to silently skip.
            syncOfflineSales()
                .then(({ synced, failed, review }) => {
                    if (synced > 0) toast.success(`Synced ${synced} offline sale(s)`);
                    if (failed > 0) toast.error(`${failed} sale(s) failed — go to Settings › Offline & Sync to see details`, { duration: 6000 });
                    if (review > 0) toast(`${review} sale(s) need review — go to Settings › Offline & Sync`, { icon: '⚠️', duration: 6000 });
                })
                .then(() => syncOfflineOrders())
                .then(({ synced, failed }) => {
                    if (synced > 0) toast.success(`Synced ${synced} offline order(s) to queue`);
                    if (failed > 0) toast.error(`${failed} order(s) failed to sync`, { duration: 6000 });
                })
                .catch((err) => {
                    console.error('[OfflineAutoSync] Reconnect sync failed:', err);
                });
        }
        wasOfflineRef.current = !isOnline;
    }, [isOnline]);

    // ── Periodic retry while online ─────────────────────────────
    useEffect(() => {
        if (!isOnline) return;

        const id = setInterval(() => {
            if (isSyncPausedForAuth()) return;
            const hasSales = hasPendingSales();
            const hasOrders = hasPendingOrders();
            if (!hasSales && !hasOrders) return;

            // Chain sequentially — shared sync lock prevents concurrent runs
            const chain = hasSales
                ? syncOfflineSales().then(({ synced }) => {
                    if (synced > 0) toast.success(`Background sync: ${synced} sale(s) synced`);
                })
                : Promise.resolve();

            chain
                .then(() => hasOrders ? syncOfflineOrders() : { synced: 0 })
                .then(({ synced }) => {
                    if (synced > 0) toast.success(`Background sync: ${synced} order(s) synced`);
                })
                .catch((err) => {
                    console.error('[OfflineAutoSync] Periodic sync failed:', err);
                });
        }, RETRY_INTERVAL_MS);

        return () => clearInterval(id);
    }, [isOnline]);

    // ── Register Background Sync (one-time) ─────────────────────
    useEffect(() => {
        registerBackgroundSync();
    }, []);

    return null;
}
