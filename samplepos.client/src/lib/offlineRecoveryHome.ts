import { readCachedRestaurantEnabled } from '../hooks/useRestaurantEnabled';

/**
 * Offline ErrorBoundary recovery target.
 * Restaurant tenants must not bounce to retail `/pos`.
 */
export function resolveOfflineRecoveryHome(
  restaurantEnabled: boolean | null = readCachedRestaurantEnabled(),
): { path: string; label: string } {
  if (restaurantEnabled === true) {
    return { path: '/restaurant', label: 'Go to Restaurant' };
  }
  return { path: '/pos', label: 'Go to POS' };
}
