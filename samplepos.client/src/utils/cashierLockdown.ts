/**
 * Cashier lockdown — POS/FOH-first defaults.
 *
 * SSOT: Role Management ticks on the Cashier role expand access.
 * - Default grant set (SYSTEM_CASHIER_PERMISSION_KEYS) → minimal path/nav lockdown
 * - Any catalog key outside that set → lockdown OFF; ProtectedRoute + permission nav apply
 */

import { SYSTEM_CASHIER_PERMISSION_KEYS } from '../../../shared/authorization/systemRoleGrants';
import { isWarehouseRoutePath } from '../../../shared/utils/warehouseRbac';
import {
  isRestaurantWaiterProfile,
  isWaiterAllowedPath,
  WAITER_HOME_PATH,
} from './restaurantWaiterLockdown';
import { shouldHideRetailPos } from './retailPosVisibility';

export const CASHIER_HOME_PATH = '/pos';
export const CASHIER_RESTAURANT_HOME_PATH = '/restaurant';

export function isCashierRole(role?: string | null): boolean {
  return role === 'CASHIER';
}

function permissionSet(permissions?: Iterable<string> | null): Set<string> {
  if (!permissions) return new Set();
  return permissions instanceof Set ? permissions : new Set(permissions);
}

/**
 * True when Cashier should keep the minimal lockdown.
 * False when an admin granted extra catalog keys — then RBAC ticks win.
 */
export function isCashierLockdownActive(input: {
  role?: string | null;
  permissions?: Iterable<string> | null;
}): boolean {
  if (!isCashierRole(input.role)) return false;
  const perms = permissionSet(input.permissions);
  if (perms.size === 0) return true; // login race — keep safe default
  const defaults = new Set<string>(SYSTEM_CASHIER_PERMISSION_KEYS);
  for (const key of perms) {
    if (!defaults.has(key)) return false;
  }
  return true;
}

export function resolveCashierHomePath(restaurantEnabled?: boolean | null): string {
  return shouldHideRetailPos(restaurantEnabled)
    ? CASHIER_RESTAURANT_HOME_PATH
    : CASHIER_HOME_PATH;
}

export type CashierPathOpts = {
  restaurantEnabled?: boolean | null;
  permissions?: Iterable<string> | null;
};

/** Paths a locked-down cashier may open (prefix rules). */
export function isCashierAllowedPath(
  pathname: string,
  opts?: CashierPathOpts,
): boolean {
  if (isWarehouseRoutePath(pathname)) return false;

  const perms = permissionSet(opts?.permissions);
  const restaurantMode = shouldHideRetailPos(opts?.restaurantEnabled);

  if (restaurantMode) {
    if (pathname === '/pos' || pathname.startsWith('/pos/')) return false;
    if (pathname === '/restaurant' || pathname.startsWith('/restaurant?')) return true;
    // Config surfaces only when the matching permission was granted (tick → unlock).
    if (pathname.startsWith('/restaurant/kitchen') && perms.has('restaurant.kitchen')) {
      return true;
    }
    if (
      (pathname.startsWith('/restaurant/stations') ||
        pathname.startsWith('/restaurant/recipes') ||
        pathname.startsWith('/restaurant/order-tags') ||
        pathname.startsWith('/restaurant/printer-diagnostics')) &&
      perms.has('restaurant.manage')
    ) {
      return true;
    }
    if (pathname.startsWith('/restaurant/')) return false;
  } else if (pathname === '/pos' || pathname.startsWith('/pos/')) {
    return true;
  }

  if (pathname === '/customers' || pathname.startsWith('/customers/')) return true;
  if (pathname === '/sales' || pathname.startsWith('/sales/')) return true;
  if (pathname === '/inventory' || pathname.startsWith('/inventory/')) return true;
  if (pathname === '/orders-queue') return true;
  if (/^\/orders\/[^/]+\/pay$/.test(pathname)) return true;
  if (pathname === '/my/quick-login') return true;
  // Own password / 2FA. Not the rest of /settings.
  if (pathname === '/settings/security') return true;

  // Align path allowlist with default Cashier grant set (ticks already in matrix).
  if (
    (perms.has('expenses.read') || perms.has('expenses.create')) &&
    (pathname === '/expenses' || pathname.startsWith('/expenses/'))
  ) {
    return true;
  }
  if (
    (perms.has('reports.sales_view') || perms.has('reports.read')) &&
    (pathname === '/reports' || pathname.startsWith('/reports/'))
  ) {
    return true;
  }
  if (
    perms.has('delivery.read') &&
    (pathname === '/delivery' || pathname.startsWith('/delivery/'))
  ) {
    return true;
  }
  if (
    (perms.has('quotations.read') || perms.has('quotations.create')) &&
    (pathname === '/quotations' || pathname.startsWith('/quotations/'))
  ) {
    return true;
  }
  if (
    perms.has('settings.read') &&
    (pathname === '/settings' || pathname.startsWith('/settings'))
  ) {
    return true;
  }

  return false;
}

export type PostLoginPathInput = {
  role?: string | null;
  permissions?: Iterable<string> | null;
  restaurantEnabled?: boolean;
};

/**
 * Where to land after login.
 * Cashier → POS (or Restaurant when mode on); restaurant waiter → Restaurant FOH; else dashboard / intended.
 */
export function resolvePostLoginPath(
  roleOrOpts: string | undefined | null | PostLoginPathInput,
  intendedPath?: string,
): string {
  const opts: PostLoginPathInput =
    roleOrOpts && typeof roleOrOpts === 'object'
      ? roleOrOpts
      : { role: roleOrOpts ?? undefined };

  if (isCashierLockdownActive(opts)) {
    const home = resolveCashierHomePath(opts.restaurantEnabled);
    if (
      intendedPath &&
      isCashierAllowedPath(intendedPath, {
        restaurantEnabled: opts.restaurantEnabled,
        permissions: opts.permissions,
      })
    ) {
      return intendedPath;
    }
    return home;
  }

  // Elevated Cashier (extra RBAC ticks) — honor intended path when present.
  if (isCashierRole(opts.role) && intendedPath) {
    return intendedPath;
  }
  if (isCashierRole(opts.role)) {
    return resolveCashierHomePath(opts.restaurantEnabled);
  }

  if (isRestaurantWaiterProfile(opts)) {
    if (intendedPath && isWaiterAllowedPath(intendedPath)) {
      return intendedPath;
    }
    return WAITER_HOME_PATH;
  }

  return intendedPath || '/dashboard';
}

export interface CashierNavItem {
  name: string;
  path: string;
  icon: string;
}

/** Minimal navigation for cashiers — POS workflow only (Restaurant when mode on). */
export const CASHIER_NAV_ITEMS: CashierNavItem[] = [
  { name: 'Point of Sale', path: '/pos', icon: '🛒' },
  { name: 'Orders Queue', path: '/orders-queue', icon: '📋' },
  { name: 'My Sales', path: '/sales', icon: '💰' },
  { name: 'Customers', path: '/customers', icon: '👥' },
  { name: 'Inventory', path: '/inventory/stock-levels', icon: '📦' },
];

export function resolveCashierNavItems(
  restaurantEnabled?: boolean | null,
  permissions?: Iterable<string> | null,
): CashierNavItem[] {
  const perms = permissionSet(permissions);
  const base: CashierNavItem[] = !shouldHideRetailPos(restaurantEnabled)
    ? [...CASHIER_NAV_ITEMS]
    : [
        { name: 'Restaurant', path: '/restaurant', icon: '🍽️' },
        { name: 'Orders Queue', path: '/orders-queue', icon: '📋' },
        { name: 'My Sales', path: '/sales', icon: '💰' },
        { name: 'Customers', path: '/customers', icon: '👥' },
        { name: 'Inventory', path: '/inventory/stock-levels', icon: '📦' },
      ];

  const extras: CashierNavItem[] = [];
  if (perms.has('restaurant.kitchen')) {
    extras.push({ name: 'Kitchen Display', path: '/restaurant/kitchen', icon: '👨‍🍳' });
  }
  if (perms.has('expenses.read') || perms.has('expenses.create')) {
    extras.push({ name: 'Expenses', path: '/expenses', icon: '💵' });
  }
  if (perms.has('reports.sales_view') || perms.has('reports.read')) {
    extras.push({ name: 'Reports', path: '/reports', icon: '📈' });
  }
  if (perms.has('delivery.read')) {
    extras.push({ name: 'Dispatch', path: '/delivery', icon: '🚚' });
  }
  if (perms.has('quotations.read') || perms.has('quotations.create')) {
    extras.push({ name: 'Quotations', path: '/quotations', icon: '📄' });
  }
  if (perms.has('settings.read')) {
    extras.push({ name: 'Settings', path: '/settings', icon: '⚙️' });
  }

  const seen = new Set(base.map((i) => i.path));
  for (const item of extras) {
    if (!seen.has(item.path)) {
      base.push(item);
      seen.add(item.path);
    }
  }
  return base;
}
