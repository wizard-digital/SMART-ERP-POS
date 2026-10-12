import { describe, expect, it } from 'vitest';
import { resolvePostLoginPath } from './cashierLockdown';
import {
  isRestaurantWaiterProfile,
  isWaiterAllowedPath,
  WAITER_HOME_PATH,
  WAITER_NAV_ITEMS,
} from './restaurantWaiterLockdown';

const waiterPerms = [
  'restaurant.read',
  'restaurant.order',
  'customers.read',
  'customers.create',
];

describe('restaurantWaiterLockdown', () => {
  it('detects waiter permission profile (order without elevated ticks)', () => {
    expect(
      isRestaurantWaiterProfile({
        role: 'STAFF',
        permissions: waiterPerms,
        restaurantEnabled: true,
      }),
    ).toBe(true);
    expect(
      isRestaurantWaiterProfile({
        role: 'STAFF',
        permissions: [...waiterPerms, 'restaurant.kitchen'],
        restaurantEnabled: true,
      }),
    ).toBe(false);
  });

  it('does not treat cashiers/managers/admins as waiters', () => {
    expect(
      isRestaurantWaiterProfile({
        role: 'CASHIER',
        permissions: [...waiterPerms, 'restaurant.kitchen', 'restaurant.pay'],
        restaurantEnabled: true,
      }),
    ).toBe(false);
    expect(
      isRestaurantWaiterProfile({
        role: 'MANAGER',
        permissions: [...waiterPerms, 'restaurant.kitchen', 'restaurant.manage'],
        restaurantEnabled: true,
      }),
    ).toBe(false);
  });

  it('hides kitchen / stations / recipes paths from waiters', () => {
    expect(isWaiterAllowedPath('/restaurant')).toBe(true);
    expect(isWaiterAllowedPath('/customers')).toBe(true);
    expect(isWaiterAllowedPath('/restaurant/kitchen')).toBe(false);
    expect(isWaiterAllowedPath('/restaurant/stations')).toBe(false);
    expect(isWaiterAllowedPath('/restaurant/recipes')).toBe(false);
    expect(isWaiterAllowedPath('/restaurant/order-tags')).toBe(false);
    expect(isWaiterAllowedPath('/dashboard')).toBe(false);
    expect(isWaiterAllowedPath('/settings/security')).toBe(true);
    expect(isWaiterAllowedPath('/settings')).toBe(false);
  });

  it('waiter nav is FOH only — no kitchen/config', () => {
    expect(WAITER_NAV_ITEMS.map((i) => i.path)).toEqual(['/restaurant', '/customers']);
    expect(WAITER_NAV_ITEMS.some((i) => i.path.includes('kitchen'))).toBe(false);
  });

  it('post-login sends waiters to Restaurant FOH', () => {
    expect(
      resolvePostLoginPath({ role: 'STAFF', permissions: waiterPerms }, undefined),
    ).toBe(WAITER_HOME_PATH);
    expect(resolvePostLoginPath({ role: 'CASHIER' }, undefined)).toBe('/pos');
    expect(
      resolvePostLoginPath({ role: 'CASHIER', restaurantEnabled: true }, undefined),
    ).toBe('/restaurant');
  });
});
