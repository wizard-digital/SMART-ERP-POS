/**
 * Sales authorization policies — permission + legacy fallback (no role-name gates).
 */

import { legacyRoleGrantsPermission } from './legacyRoleFallback.js';

const SALE_FINANCIAL_FIELDS = ['totalCost', 'profit', 'profitMargin', 'totalProfit'] as const;

/** Permissions that grant visibility of cost/margin on sale records */
const FINANCIAL_VIEW_PERMISSIONS = [
  'reports.financial_view',
  'sales.approve',
  'accounting.read',
] as const;

export function canViewSaleFinancials(
  permissions: Iterable<string>,
  legacyRole?: string | null
): boolean {
  const keys = new Set(permissions);
  if (FINANCIAL_VIEW_PERMISSIONS.some((p) => keys.has(p))) {
    return true;
  }
  // Legacy transition when RBAC permissions not yet loaded
  if (keys.size === 0 && legacyRole) {
    const r = legacyRole.toUpperCase();
    return r === 'ADMIN' || r === 'MANAGER';
  }
  return false;
}

/** Strip cost/margin fields when viewer lacks financial visibility permission */
export function sanitizeSaleFinancialFields<T extends Record<string, unknown>>(
  data: T,
  permissions: Iterable<string>,
  legacyRole?: string | null
): Record<string, unknown> {
  if (canViewSaleFinancials(permissions, legacyRole)) {
    return data;
  }
  const sanitized: Record<string, unknown> = { ...data };
  for (const field of SALE_FINANCIAL_FIELDS) {
    delete sanitized[field];
  }
  return sanitized;
}

/**
 * Scope sales list/detail to own records when user can transact but not read all sales.
 * Requires sales.read for org-wide visibility.
 */
export function shouldRestrictSalesToOwnUser(
  permissions: Iterable<string>,
  legacyRole?: string | null
): boolean {
  const keys = new Set(permissions);
  if (keys.has('sales.read')) {
    return false;
  }
  if (keys.size > 0) {
    return (
      keys.has('sales.create') ||
      keys.has('pos.create') ||
      keys.has('sales.reprint')
    );
  }
  // Legacy transition: cashiers without RBAC assignments see own sales only
  return legacyRole?.toUpperCase() === 'CASHIER';
}

/**
 * Cashiers may browse today's sales only — not change the date range to another day.
 * Managers/admins/accountants keep full date filters.
 */
export function shouldLockSalesToBusinessDay(
  permissions: Iterable<string>,
  legacyRole?: string | null
): boolean {
  const role = (legacyRole || '').toUpperCase();
  if (role === 'CASHIER') return true;
  const keys = new Set(permissions);
  // Explicit cashier profile: can sell + read sales, lacks org-wide financial approve
  if (
    keys.has('sales.read') &&
    (keys.has('pos.create') || keys.has('sales.create')) &&
    keys.has('restaurant.pay') &&
    !keys.has('accounting.read') &&
    !keys.has('sales.approve') &&
    !keys.has('admin.update')
  ) {
    return true;
  }
  return false;
}

/** Complimentary FOC sale — Administrator only (sales.gift + admin.update). */
export function canIssueGiftSale(
  permissions: Iterable<string>,
  legacyRole?: string | null
): boolean {
  const role = (legacyRole || '').toUpperCase();
  if (role === 'ADMIN') return true;
  const keys = new Set(permissions);
  return keys.has('sales.gift') && keys.has('admin.update');
}

export function canProcessRefundType(
  refundType: 'REFUND' | 'EXCHANGE',
  permissions: Iterable<string>,
  legacyRole?: string | null
): boolean {
  const keys = new Set(permissions);

  if (keys.size > 0) {
    if (refundType === 'EXCHANGE') {
      return keys.has('sales.exchange') || keys.has('sales.refund');
    }
    return keys.has('sales.refund');
  }

  if (refundType === 'EXCHANGE') {
    return (
      legacyRoleGrantsPermission(legacyRole, 'sales.exchange') ||
      legacyRoleGrantsPermission(legacyRole, 'sales.refund')
    );
  }

  return legacyRoleGrantsPermission(legacyRole, 'sales.refund');
}
