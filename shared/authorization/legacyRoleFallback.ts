/**
 * Single source of truth for legacy users.role → permission fallback.
 *
 * Used ONLY during RBAC transition when a user has no rbac_user_roles assignments.
 * Once RBAC is fully adopted, this module can be removed.
 *
 * Server middleware, client ProtectedRoute, transfer utils, and nav config
 * MUST import from here — never duplicate this map.
 */

import type { LegacyUserRole } from './types.js';

/** Modules a legacy MANAGER role may access (module-prefix match). */
export const LEGACY_MANAGER_MODULES = [
  'sales',
  'inventory',
  'purchasing',
  'customers',
  'suppliers',
  'reports',
  'pos',
  'accounting',
  'banking',
  'delivery',
  'settings',
  'hr',
  'expenses',
  'quotations',
  'crm',
  'orders',
  'restaurant',
  'distribution',
  'targets',
] as const;

/** Explicit permission keys granted to legacy CASHIER role. */
export const LEGACY_CASHIER_PERMISSIONS = [
  'pos.read',
  'pos.create',
  'sales.read',
  'sales.create',
  'customers.read',
  'customers.create',
  'inventory.read',
  'suppliers.read',
  'delivery.read',
  'settings.read',
  'quotations.read',
  'quotations.create',
  'orders.read',
  'orders.create',
  'orders.pay',
  'orders.cancel',
  'restaurant.read',
  'restaurant.order',
  'restaurant.kitchen',
  'restaurant.pay',
  'restaurant.edit_others',
  'sales.reprint',
  'distribution.read',
  'distribution.create',
  'targets.read',
] as const;

/** Explicit permission keys granted to legacy STAFF role (beyond *.read). */
export const LEGACY_STAFF_EXTRA_PERMISSIONS = [
  'orders.create',
  'pos.create',
  'restaurant.order',
  'restaurant.read',
] as const;

type LegacyChecker = (permissionKey: string) => boolean;

const LEGACY_ROLE_PERMISSIONS: Record<string, LegacyChecker> = {
  ADMIN: () => true,
  MANAGER: (key) =>
    key !== 'restaurant.pay' &&
    LEGACY_MANAGER_MODULES.includes(key.split('.')[0] as (typeof LEGACY_MANAGER_MODULES)[number]),
  CASHIER: (key) => (LEGACY_CASHIER_PERMISSIONS as readonly string[]).includes(key),
  STAFF: (key) =>
    key.endsWith('.read') ||
    (LEGACY_STAFF_EXTRA_PERMISSIONS as readonly string[]).includes(key),
};

/**
 * Transition-period fallback: does the legacy users.role column grant this permission?
 * Returns false when role is unknown or missing.
 */
export function legacyRoleGrantsPermission(
  role: string | undefined | null,
  permissionKey: string
): boolean {
  if (!role) return false;
  const checker = LEGACY_ROLE_PERMISSIONS[role.toUpperCase()];
  return checker ? checker(permissionKey) : false;
}

export function isKnownLegacyRole(role: string | undefined | null): role is LegacyUserRole {
  if (!role) return false;
  return role.toUpperCase() in LEGACY_ROLE_PERMISSIONS;
}
