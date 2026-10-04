/**
 * Single source of truth for system RBAC role → permission grants (SEED DEFAULTS).
 *
 * Used by:
 * - SamplePOS.Server/src/rbac/seed.ts
 * - SamplePOS.Server/src/modules/platform/tenantService.ts (seedDefaultRbac)
 *
 * Runtime authorization uses the role's stored rbac_role_permissions rows.
 * Role Management may add/remove catalog keys; seed is additive (ON CONFLICT DO NOTHING)
 * and must not strip admin customizations. Client lockdowns treat these lists as the
 * "default profile" — any extra catalog key escapes the minimal POS/FOH lockdown.
 */

import { LEGACY_MANAGER_MODULES } from './legacyRoleFallback.js';

/** Modules granted to the system Manager role (full module prefix). */
export const SYSTEM_MANAGER_MODULES = LEGACY_MANAGER_MODULES;

/** Modules granted in full to the system Accountant role. */
export const SYSTEM_ACCOUNTANT_MODULES = [
  'accounting',
  'banking',
  'reports',
  'expenses',
  'orders',
] as const;

/**
 * Extra permission keys for Accountant (beyond full modules).
 * Includes customers.update — required by AR payment routes/UI.
 * Includes distribution.read — dist APIs when orders UI is visible.
 * Restaurant FOH keys — accountants settle and may operate floor when covering.
 */
export const SYSTEM_ACCOUNTANT_EXTRA_KEYS = [
  'pos.read',
  'pos.create',
  'pos.void',
  'sales.read',
  'sales.create',
  'sales.update',
  'sales.void',
  'sales.refund',
  'sales.approve',
  'sales.tax_override',
  'sales.tax_restatement',
  'sales.export',
  'purchasing.read',
  'purchasing.create',
  'customers.read',
  'customers.create',
  'customers.export',
  'customers.update',
  'customers.adjust',
  'suppliers.read',
  'suppliers.create',
  'suppliers.update',
  'corrections.read',
  'corrections.execute',
  'inventory.read',
  'settings.read',
  'quotations.read',
  'distribution.read',
  'restaurant.read',
  'restaurant.order',
  'restaurant.kitchen',
  'restaurant.pay',
] as const;

/**
 * System Cashier grants — POS + FOH settle + inventory browse + customers.
 * Waiters never get restaurant.pay; cashiers always do.
 */
export const SYSTEM_CASHIER_PERMISSION_KEYS = [
  'pos.read',
  'pos.create',
  'sales.read',
  'sales.create',
  'customers.read',
  'customers.create',
  'inventory.read',
  'delivery.read',
  'settings.read',
  'quotations.read',
  'quotations.create',
  'orders.read',
  'orders.pay',
  'orders.cancel',
  'restaurant.read',
  'restaurant.order',
  'restaurant.kitchen',
  'restaurant.pay',
  'restaurant.edit_others',
  'reports.sales_view',
  'expenses.read',
  'expenses.create',
  'targets.read',
] as const;

/**
 * System Waiter grants — floor only. Never restaurant.pay / kitchen / manage.
 */
export const SYSTEM_WAITER_PERMISSION_KEYS = [
  'restaurant.read',
  'restaurant.order',
  'customers.read',
  'customers.create',
] as const;

export type CatalogPermission = { key: string; module: string; action?: string };

export function isSystemManagerPermission(permission: CatalogPermission): boolean {
  // Restaurant payment is cashier / accountant / admin only — not floor managers.
  if (permission.key === 'restaurant.pay') return false;
  return (SYSTEM_MANAGER_MODULES as readonly string[]).includes(permission.module);
}

export function isSystemAccountantPermission(permission: CatalogPermission): boolean {
  return (
    (SYSTEM_ACCOUNTANT_MODULES as readonly string[]).includes(permission.module) ||
    (SYSTEM_ACCOUNTANT_EXTRA_KEYS as readonly string[]).includes(permission.key)
  );
}

export function isSystemCashierPermission(permission: CatalogPermission): boolean {
  return (SYSTEM_CASHIER_PERMISSION_KEYS as readonly string[]).includes(permission.key);
}

export function isSystemWaiterPermission(permission: CatalogPermission): boolean {
  return (SYSTEM_WAITER_PERMISSION_KEYS as readonly string[]).includes(permission.key);
}
