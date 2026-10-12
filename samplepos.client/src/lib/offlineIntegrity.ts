/**
 * Offline integrity — explicit failures, never swallowed.
 *
 * Enterprise rule: offline must degrade to a known capability set (POS / login /
 * cached reads). Missing cache or chunk load is a typed integrity event, not a
 * silent empty response or a black Vite overlay.
 */

export const OfflineIntegrityCode = {
  CHUNK_LOAD_OFFLINE: 'OFFLINE_INTEGRITY_CHUNK_LOAD',
  CHUNK_LOAD_DEV: 'OFFLINE_INTEGRITY_CHUNK_LOAD_DEV',
  CHUNK_LOAD_STALE_AFTER_RELOAD: 'OFFLINE_INTEGRITY_CHUNK_STALE',
  WARMUP_FAILED: 'OFFLINE_INTEGRITY_WARMUP_FAILED',
  SW_STATIC_MISS: 'OFFLINE_INTEGRITY_SW_STATIC_MISS',
  SW_API_MISS: 'OFFLINE_INTEGRITY_SW_API_MISS',
  SW_NAV_FALLBACK: 'OFFLINE_INTEGRITY_SW_NAV_FALLBACK',
} as const;

export type OfflineIntegrityCode =
  (typeof OfflineIntegrityCode)[keyof typeof OfflineIntegrityCode];

export type OfflineIntegrityEvent = {
  code: OfflineIntegrityCode;
  message: string;
  cause?: unknown;
  context?: Record<string, unknown>;
  at: string;
};

const RECENT_KEY = 'offline_integrity_recent';
const MEMORY_CAP = 40;

/** Process-local ring — primary so tests / private mode never lose events. */
const memoryEvents: OfflineIntegrityEvent[] = [];

/** Persist last integrity events (bounded) for support / proof — never deletes causes. */
export function reportOfflineIntegrityEvent(
  code: OfflineIntegrityCode,
  message: string,
  cause?: unknown,
  context?: Record<string, unknown>,
): OfflineIntegrityEvent {
  const event: OfflineIntegrityEvent = {
    code,
    message,
    cause,
    context,
    at: new Date().toISOString(),
  };

  // Always visible in console — never swallow.
  console.error(`[${code}] ${message}`, {
    cause: cause instanceof Error ? { name: cause.name, message: cause.message, stack: cause.stack } : cause,
    context,
  });

  memoryEvents.unshift(event);
  if (memoryEvents.length > MEMORY_CAP) memoryEvents.length = MEMORY_CAP;

  try {
    if (typeof sessionStorage === 'undefined') return event;
    const serializable = {
      ...event,
      cause:
        cause instanceof Error
          ? { name: cause.name, message: cause.message }
          : cause != null
            ? String(cause)
            : undefined,
    };
    const raw = sessionStorage.getItem(RECENT_KEY);
    const list: OfflineIntegrityEvent[] = raw ? (JSON.parse(raw) as OfflineIntegrityEvent[]) : [];
    list.unshift(serializable);
    sessionStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 20)));
  } catch (persistErr) {
    // Memory + console already hold the event — log persist failure without dropping the original.
    console.error(`[${OfflineIntegrityCode.WARMUP_FAILED}] session persist failed`, persistErr);
  }

  return event;
}

export function readRecentOfflineIntegrityEvents(): OfflineIntegrityEvent[] {
  if (memoryEvents.length > 0) return [...memoryEvents];
  try {
    if (typeof sessionStorage === 'undefined') return [];
    const raw = sessionStorage.getItem(RECENT_KEY);
    return raw ? (JSON.parse(raw) as OfflineIntegrityEvent[]) : [];
  } catch {
    return [];
  }
}

/** Test helper — clear memory ring only. */
export function clearOfflineIntegrityMemoryForTests(): void {
  memoryEvents.length = 0;
}

/**
 * Critical offline modules — warm while online so navigation does not fail offline.
 * Failures are reported; callers must not ignore Promise rejection silently.
 */
export async function warmCriticalOfflineModules(): Promise<{
  ok: string[];
  failed: Array<{ id: string; error: string }>;
}> {
  const loaders: Array<{ id: string; load: () => Promise<unknown> }> = [
    { id: 'orders-queue', load: () => import('../pages/orders/OrdersQueuePage') },
    { id: 'customers', load: () => import('../pages/CustomersPage') },
    { id: 'products', load: () => import('../pages/inventory/ProductsPage') },
    { id: 'stock-levels', load: () => import('../pages/inventory/StockLevelsPage') },
    { id: 'sales', load: () => import('../pages/SalesPage') },
    // Restaurant FOH + password/2FA recovery — must not hard-fail offline after first online session
    { id: 'restaurant-pos', load: () => import('../pages/restaurant/RestaurantPosPage') },
    { id: 'security-settings', load: () => import('../pages/settings/SecuritySettingsPage') },
  ];

  const ok: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];

  for (const item of loaders) {
    try {
      await item.load();
      ok.push(item.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failed.push({ id: item.id, error: msg });
      reportOfflineIntegrityEvent(
        OfflineIntegrityCode.WARMUP_FAILED,
        `Failed to warm offline module: ${item.id}`,
        err,
        { moduleId: item.id },
      );
    }
  }

  return { ok, failed };
}
