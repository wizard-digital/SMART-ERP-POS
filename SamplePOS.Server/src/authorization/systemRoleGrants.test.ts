import {
  SYSTEM_ACCOUNTANT_EXTRA_KEYS,
  SYSTEM_ACCOUNTANT_MODULES,
  SYSTEM_CASHIER_PERMISSION_KEYS,
  SYSTEM_MANAGER_MODULES,
  SYSTEM_WAITER_PERMISSION_KEYS,
  isSystemAccountantPermission,
  isSystemCashierPermission,
  isSystemManagerPermission,
  isSystemWaiterPermission,
} from '@shared/authorization/systemRoleGrants.js';
import { LEGACY_MANAGER_MODULES } from '@shared/authorization/legacyRoleFallback.js';

describe('systemRoleGrants SSOT', () => {
  it('Manager modules match legacy Manager modules', () => {
    expect([...SYSTEM_MANAGER_MODULES]).toEqual([...LEGACY_MANAGER_MODULES]);
    expect(SYSTEM_MANAGER_MODULES).toContain('accounting');
    expect(SYSTEM_MANAGER_MODULES).toContain('quotations');
    expect(SYSTEM_MANAGER_MODULES).toContain('distribution');
    expect(SYSTEM_MANAGER_MODULES).toContain('targets');
    expect(isSystemManagerPermission({ key: 'targets.manage', module: 'targets' })).toBe(true);
    expect(SYSTEM_CASHIER_PERMISSION_KEYS).toContain('targets.read');
    expect(isSystemCashierPermission({ key: 'targets.manage', module: 'targets' })).toBe(false);
  });

  it('isSystemManagerPermission grants accounting.read', () => {
    expect(isSystemManagerPermission({ key: 'accounting.read', module: 'accounting' })).toBe(true);
    expect(isSystemManagerPermission({ key: 'system.update', module: 'system' })).toBe(false);
  });

  it('Manager modules include banking for Banking & Liquidity', () => {
    expect(SYSTEM_MANAGER_MODULES).toContain('banking');
    expect(isSystemManagerPermission({ key: 'banking.read', module: 'banking' })).toBe(true);
    expect(isSystemManagerPermission({ key: 'banking.reconcile', module: 'banking' })).toBe(true);
  });

  it('Accountant includes full banking module for Banking & Liquidity', () => {
    expect(SYSTEM_ACCOUNTANT_MODULES).toContain('banking');
    expect(isSystemAccountantPermission({ key: 'banking.read', module: 'banking' })).toBe(true);
    expect(isSystemAccountantPermission({ key: 'banking.create', module: 'banking' })).toBe(true);
    expect(isSystemAccountantPermission({ key: 'banking.update', module: 'banking' })).toBe(true);
    expect(isSystemAccountantPermission({ key: 'banking.reconcile', module: 'banking' })).toBe(true);
    expect(isSystemAccountantPermission({ key: 'accounting.manage', module: 'accounting' })).toBe(true);
  });

  it('Accountant includes customers.update for AR payments', () => {
    expect(SYSTEM_ACCOUNTANT_EXTRA_KEYS).toContain('customers.update');
    expect(
      isSystemAccountantPermission({ key: 'customers.update', module: 'customers' })
    ).toBe(true);
    expect(
      isSystemAccountantPermission({ key: 'distribution.read', module: 'distribution' })
    ).toBe(true);
    expect(
      isSystemAccountantPermission({ key: 'accounting.read', module: 'accounting' })
    ).toBe(true);
  });

  it('Manager + Accountant may apply omitted VAT (sales.tax_restatement)', () => {
    expect(SYSTEM_ACCOUNTANT_EXTRA_KEYS).toContain('sales.tax_restatement');
    expect(
      isSystemAccountantPermission({ key: 'sales.tax_restatement', module: 'sales' }),
    ).toBe(true);
    expect(
      isSystemManagerPermission({ key: 'sales.tax_restatement', module: 'sales' }),
    ).toBe(true);
    expect(
      isSystemCashierPermission({ key: 'sales.tax_restatement', module: 'sales' }),
    ).toBe(false);
    expect(
      isSystemWaiterPermission({ key: 'sales.tax_restatement', module: 'sales' }),
    ).toBe(false);
  });

  it('restaurant.pay is accountant/cashier/admin — not Manager', () => {
    expect(SYSTEM_ACCOUNTANT_EXTRA_KEYS).toContain('restaurant.pay');
    expect(
      isSystemAccountantPermission({ key: 'restaurant.pay', module: 'restaurant' }),
    ).toBe(true);
    expect(
      isSystemManagerPermission({ key: 'restaurant.pay', module: 'restaurant' }),
    ).toBe(false);
    expect(
      isSystemManagerPermission({ key: 'restaurant.order', module: 'restaurant' }),
    ).toBe(true);
  });

  it('Cashier gets inventory.read + restaurant.pay + edit_others; Waiter never gets pay', () => {
    expect(SYSTEM_CASHIER_PERMISSION_KEYS).toContain('inventory.read');
    expect(SYSTEM_CASHIER_PERMISSION_KEYS).toContain('restaurant.pay');
    expect(SYSTEM_CASHIER_PERMISSION_KEYS).toContain('restaurant.edit_others');
    expect(isSystemCashierPermission({ key: 'inventory.read', module: 'inventory' })).toBe(true);
    expect(SYSTEM_WAITER_PERMISSION_KEYS).not.toContain('restaurant.pay');
    expect(SYSTEM_WAITER_PERMISSION_KEYS).not.toContain('restaurant.kitchen');
    expect(SYSTEM_WAITER_PERMISSION_KEYS).not.toContain('restaurant.edit_others');
    expect(isSystemWaiterPermission({ key: 'restaurant.pay', module: 'restaurant' })).toBe(false);
    expect(isSystemWaiterPermission({ key: 'restaurant.order', module: 'restaurant' })).toBe(true);
    expect(
      isSystemManagerPermission({ key: 'restaurant.edit_others', module: 'restaurant' }),
    ).toBe(true);
  });

  it('Accountant gets full restaurant operate keys (order + kitchen + pay)', () => {
    expect(SYSTEM_ACCOUNTANT_EXTRA_KEYS).toContain('restaurant.order');
    expect(SYSTEM_ACCOUNTANT_EXTRA_KEYS).toContain('restaurant.kitchen');
    expect(SYSTEM_ACCOUNTANT_EXTRA_KEYS).toContain('restaurant.pay');
    expect(
      isSystemAccountantPermission({ key: 'restaurant.order', module: 'restaurant' }),
    ).toBe(true);
  });
});
