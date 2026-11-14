import { useQuery } from '@tanstack/react-query';
import { api } from '../utils/api';

export const restaurantEnabledQueryKey = ['restaurant', 'enabled'] as const;

/** Last known restaurant_mode_enabled — avoids retail POS flash before the API resolves. */
export const RESTAURANT_ENABLED_CACHE_KEY = 'restaurant_mode_enabled_v1';
/** Last known restaurant_allow_oversell — FOH soft stock policy. */
export const RESTAURANT_ALLOW_OVERSELL_CACHE_KEY = 'restaurant_allow_oversell_v1';

export function readCachedRestaurantEnabled(): boolean | null {
  try {
    const v = localStorage.getItem(RESTAURANT_ENABLED_CACHE_KEY);
    if (v === '1') return true;
    if (v === '0') return false;
  } catch {
    /* private mode / blocked storage */
  }
  return null;
}

export function writeCachedRestaurantEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(RESTAURANT_ENABLED_CACHE_KEY, enabled ? '1' : '0');
  } catch {
    /* private mode / blocked storage */
  }
}

export function readCachedRestaurantAllowOversell(): boolean {
  try {
    return localStorage.getItem(RESTAURANT_ALLOW_OVERSELL_CACHE_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeCachedRestaurantAllowOversell(allow: boolean): void {
  try {
    localStorage.setItem(RESTAURANT_ALLOW_OVERSELL_CACHE_KEY, allow ? '1' : '0');
  } catch {
    /* private mode / blocked storage */
  }
}

/**
 * Fetch tenant restaurant flag and persist on success.
 * On failure, keep the last known cache (do not poison restaurant tenants with false).
 */
export async function fetchRestaurantEnabled(): Promise<boolean> {
  try {
    const res = await api.restaurant.getEnabled();
    const enabled = Boolean(res.data?.data?.enabled);
    writeCachedRestaurantEnabled(enabled);
    if (typeof res.data?.data?.allowOversell === 'boolean') {
      writeCachedRestaurantAllowOversell(res.data.data.allowOversell);
    }
    return enabled;
  } catch (err) {
    // Fail loud in console — never hide 401/network as "flag off"
    console.error(
      '[restaurant.enabled] fetch failed; using last-known cache',
      err instanceof Error ? err.message : err,
    );
    const cached = readCachedRestaurantEnabled();
    if (cached !== null) return cached;
    // Pre-migration / flag-off / unauthenticated — Layout must not break
    return false;
  }
}

/** FOH oversell soft-policy from /restaurant/enabled (cached). */
export async function fetchRestaurantFohFlags(): Promise<{
  enabled: boolean;
  allowOversell: boolean;
}> {
  try {
    const res = await api.restaurant.getEnabled();
    const enabled = Boolean(res.data?.data?.enabled);
    const allowOversell = Boolean(res.data?.data?.allowOversell);
    writeCachedRestaurantEnabled(enabled);
    writeCachedRestaurantAllowOversell(allowOversell);
    return { enabled, allowOversell };
  } catch {
    return {
      enabled: readCachedRestaurantEnabled() ?? false,
      allowOversell: readCachedRestaurantAllowOversell(),
    };
  }
}

/**
 * True when /pos vs /restaurant can be chosen without treating "still loading" as retail.
 */
export function isRestaurantEnabledSettled(
  isFetched: boolean,
  data: boolean | undefined,
  cached: boolean | null = readCachedRestaurantEnabled(),
): boolean {
  if (cached !== null) return true;
  if (isFetched) return true;
  if (data !== undefined) return true;
  return false;
}

/**
 * Tenant flag: restaurant_mode_enabled via GET /api/restaurant/enabled
 * Uses localStorage initialData so restaurant tenants never briefly route to retail POS.
 */
export function useRestaurantEnabled() {
  const cached = readCachedRestaurantEnabled();
  return useQuery({
    queryKey: restaurantEnabledQueryKey,
    queryFn: fetchRestaurantEnabled,
    staleTime: 30_000,
    retry: false,
    ...(cached !== null ? { initialData: cached } : {}),
  });
}

/** Resolved flag + readiness for home/login redirects. */
export function useRestaurantModeForRouting() {
  const query = useRestaurantEnabled();
  const cached = readCachedRestaurantEnabled();
  const restaurantEnabled = query.data ?? cached ?? false;
  const isReady = isRestaurantEnabledSettled(query.isFetched, query.data, cached);
  return { ...query, restaurantEnabled, isReady };
}
