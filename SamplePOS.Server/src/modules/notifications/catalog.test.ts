import { describe, expect, it } from '@jest/globals';
import { DISCOUNT_THRESHOLD_RATIO, getNotificationType, isSafeNavigationPath, NOTIFICATION_CATALOG } from './catalog.js';

describe('notification catalog', () => {
  it('defines unique type keys and categories for the implemented events', () => {
    const keys = NOTIFICATION_CATALOG.map((t) => t.typeKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(
      expect.arrayContaining([
        'SALE_COMPLETED',
        'SALE_VOIDED',
        'SALE_RETURNED',
        'CUSTOMER_PAYMENT_RECEIVED',
        'PO_CREATED',
        'GOODS_RECEIVED',
        'INVENTORY_LOW_STOCK',
        'APPROVAL_REQUIRED',
        'SECURITY_PASSWORD_CHANGED',
        'NOTIFICATION_TEST',
      ]),
    );
  });

  it('keeps high-volume sales notifications opt-in', () => {
    const sale = getNotificationType('SALE_COMPLETED')!;
    expect(sale.highVolume).toBe(true);
    expect(sale.defaultInApp).toBe(false);
    expect(sale.defaultPush).toBe(false);
    expect(sale.preferenceMode).toBe('OPTIONAL');
    expect(DISCOUNT_THRESHOLD_RATIO).toBe(0.2);
  });

  it('rejects unsafe navigation paths', () => {
    expect(isSafeNavigationPath('/sales')).toBe(true);
    expect(isSafeNavigationPath('/customers/abc')).toBe(true);
    expect(isSafeNavigationPath('/settings?tab=users')).toBe(true);
    expect(isSafeNavigationPath('https://evil.example')).toBe(false);
    expect(isSafeNavigationPath('//evil.example')).toBe(false);
    expect(isSafeNavigationPath('javascript:alert(1)')).toBe(false);
  });
});
