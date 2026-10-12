import { describe, expect, it } from 'vitest';
import { SYSTEM_CASHIER_PERMISSION_KEYS } from '../../../shared/authorization/systemRoleGrants';
import {
  CASHIER_NAV_ITEMS,
  isCashierAllowedPath,
  isCashierLockdownActive,
  resolveCashierHomePath,
  resolveCashierNavItems,
} from './cashierLockdown';

describe('cashierLockdown', () => {
  it('allows the orders queue path for cashier workflow', () => {
    expect(isCashierAllowedPath('/orders-queue')).toBe(true);
  });

  it('allows cashier payment routes', () => {
    expect(isCashierAllowedPath('/orders/123/pay')).toBe(true);
  });

  it('allows own password page without opening the rest of settings', () => {
    expect(isCashierAllowedPath('/settings/security')).toBe(true);
    expect(isCashierAllowedPath('/settings')).toBe(false);
    expect(isCashierAllowedPath('/settings/security', { restaurantEnabled: true })).toBe(true);
  });

  it('allows inventory browse but keeps warehouse routes blocked', () => {
    expect(isCashierAllowedPath('/inventory')).toBe(true);
    expect(isCashierAllowedPath('/inventory/stock-levels')).toBe(true);
    expect(isCashierAllowedPath('/inventory/store-network')).toBe(false);
    expect(isCashierAllowedPath('/inventory/store-transfers')).toBe(false);
  });

  it('includes orders queue and inventory in cashier navigation', () => {
    expect(CASHIER_NAV_ITEMS.some((item) => item.path === '/orders-queue')).toBe(true);
    expect(CASHIER_NAV_ITEMS.some((item) => item.path.includes('/inventory'))).toBe(true);
    expect(resolveCashierNavItems(true).some((item) => item.path.includes('/inventory'))).toBe(
      true,
    );
  });

  it('restaurant mode: cashier uses Restaurant FOH instead of retail POS', () => {
    expect(resolveCashierHomePath(true)).toBe('/restaurant');
    expect(resolveCashierNavItems(true)[0]?.path).toBe('/restaurant');
    expect(isCashierAllowedPath('/pos', { restaurantEnabled: true })).toBe(false);
    expect(isCashierAllowedPath('/restaurant', { restaurantEnabled: true })).toBe(true);
  });

  it('lockdown active only for default cashier grant set', () => {
    expect(
      isCashierLockdownActive({
        role: 'CASHIER',
        permissions: SYSTEM_CASHIER_PERMISSION_KEYS,
      }),
    ).toBe(true);
    expect(
      isCashierLockdownActive({
        role: 'CASHIER',
        permissions: [...SYSTEM_CASHIER_PERMISSION_KEYS, 'banking.read'],
      }),
    ).toBe(false);
  });
});
