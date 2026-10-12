/**
 * Restaurant Waiter lockdown — FOH-first defaults.
 *
 * Detection (permission profile SSOT):
 * - Has restaurant.order (floor service)
 * - Permissions stay within SYSTEM_WAITER_PERMISSION_KEYS (or empty during login)
 * - Not ADMIN / MANAGER / CASHIER legacy roles
 *
 * Tick any catalog key outside the waiter default set → lockdown OFF
 * (Role Management grants expand access).
 */

import { SYSTEM_WAITER_PERMISSION_KEYS } from '../../../shared/authorization/systemRoleGrants';

export const WAITER_HOME_PATH = '/restaurant';

const WAITER_BLOCKED_PREFIXES = [
  '/restaurant/kitchen',
  '/restaurant/stations',
  '/restaurant/printer-diagnostics',
  '/restaurant/recipes',
  '/restaurant/order-tags',
] as const;

export interface WaiterProfileInput {
  role?: string | null;
  permissions?: Iterable<string> | null;
  /** When false, never treat as waiter lockdown (module off). Default true for login. */
  restaurantEnabled?: boolean;
}

function permissionSet(permissions?: Iterable<string> | null): Set<string> {
  if (!permissions) return new Set();
  return permissions instanceof Set ? permissions : new Set(permissions);
}

/**
 * True when this user is a floor waiter — Restaurant FOH only.
 */
export function isRestaurantWaiterProfile(input: WaiterProfileInput): boolean {
  if (input.restaurantEnabled === false) return false;
  const role = (input.role || '').toUpperCase();
  if (role === 'ADMIN' || role === 'MANAGER' || role === 'CASHIER') return false;

  const perms = permissionSet(input.permissions);
  // Explicit WAITER legacy without a permission cache yet (login race)
  if (perms.size === 0) {
    return role === 'WAITER' || role === 'STAFF';
  }

  if (!perms.has('restaurant.order')) return false;

  // Elevated RBAC ticks (kitchen, pay, manage, accounting, …) escape FOH lockdown.
  const defaults = new Set<string>(SYSTEM_WAITER_PERMISSION_KEYS);
  for (const key of perms) {
    if (!defaults.has(key)) return false;
  }

  return true;
}

/** Paths a waiter may open. Everything else redirects to Restaurant FOH. */
export function isWaiterAllowedPath(pathname: string): boolean {
  if (WAITER_BLOCKED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return false;
  }
  if (pathname === '/restaurant' || pathname.startsWith('/restaurant?')) return true;
  if (pathname.startsWith('/restaurant/')) {
    // Only the FOH root is allowed under /restaurant/*
    return false;
  }
  if (pathname === '/customers' || pathname.startsWith('/customers/')) return true;
  if (pathname === '/my/quick-login') return true;
  if (pathname === '/settings/security') return true;
  if (pathname === '/login') return true;
  return false;
}

export function isRestaurantConfigPath(pathname: string): boolean {
  return WAITER_BLOCKED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export interface WaiterNavItem {
  name: string;
  path: string;
  icon: string;
}

/** Minimal navigation for waiters — table service only. */
export const WAITER_NAV_ITEMS: WaiterNavItem[] = [
  { name: 'Restaurant', path: '/restaurant', icon: '🍽️' },
  { name: 'Customers', path: '/customers', icon: '👥' },
];
