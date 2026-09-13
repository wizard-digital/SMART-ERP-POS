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

  it('keeps cashiers off completed-sale noise while managers get the phone alert', () => {
    const sale = getNotificationType('SALE_COMPLETED')!;
    expect(sale.highVolume).toBe(true);
    expect(sale.preferenceMode).toBe('ROLE_DEFAULT');
    expect(sale.defaultInApp).toBe(true);
    expect(sale.defaultPush).toBe(true);
    expect(sale.roleDefaults?.CASHIER).toEqual({ inApp: false, push: false });
    expect(DISCOUNT_THRESHOLD_RATIO).toBe(0.2);
  });

  it('puts every type in exactly one operator band and keeps the activity log off', () => {
    const bands = NOTIFICATION_CATALOG.map((t) => t.operatorBand);
    expect(bands).toHaveLength(NOTIFICATION_CATALOG.length);
    expect(new Set(NOTIFICATION_CATALOG.map((t) => t.typeKey)).size).toBe(NOTIFICATION_CATALOG.length);

    const quiet = [
      'DISCOUNT_APPLIED',
      'SALE_PRICE_OVERRIDE',
      'PO_CREATED',
      'PO_SENT',
      'GOODS_RECEIVED',
      'STOCK_TRANSFER_APPROVED',
      'STOCK_TRANSFER_COMPLETED',
      'APPROVAL_COMPLETED',
      'RESTAURANT_KOT_SENT',
    ] as const;
    for (const key of quiet) {
      const type = getNotificationType(key)!;
      expect(type.operatorBand).toBe('ACTIVITY');
      expect(type.preferenceMode).toBe('OPTIONAL');
      expect(type.defaultInApp).toBe(false);
      expect(type.defaultPush).toBe(false);
    }
    expect(getNotificationType('SALE_VOIDED')!.operatorBand).toBe('EXCEPTIONS');
    expect(getNotificationType('PO_SUBMITTED')!.operatorBand).toBe('APPROVALS');
    expect(getNotificationType('CUSTOMER_PAYMENT_RECEIVED')!.operatorBand).toBe('MONEY');
  });

  it('notifies managers of completed sales on the phone by default', () => {
    const sale = getNotificationType('SALE_COMPLETED')!;
    expect(sale.preferenceMode).toBe('ROLE_DEFAULT');
    expect(sale.defaultInApp).toBe(true);
    expect(sale.defaultPush).toBe(true);
    expect(sale.roleDefaults?.CASHIER).toEqual({ inApp: false, push: false });
    expect(getNotificationType('SALE_VOIDED')!.defaultPush).toBe(true);
    expect(getNotificationType('SALE_RETURNED')!.defaultPush).toBe(true);
  });

  it('assigns every type to exactly one settings area without dropping type keys', () => {
    expect(NOTIFICATION_CATALOG.every((t) => Boolean(t.uxArea && t.uxAreaLabel))).toBe(true);
    expect(getNotificationType('SALE_COMPLETED')!.uxArea).toBe('SALES');
    expect(getNotificationType('CUSTOMER_PAYMENT_RECEIVED')!.uxArea).toBe('CUSTOMERS');
    expect(getNotificationType('PERIOD_CLOSE_SIGNOFF')!.uxArea).toBe('FINANCE');
    expect(getNotificationType('FINANCIAL_INTEGRITY_ALERT')!.uxArea).toBe('FINANCE');
    expect(getNotificationType('NOTIFICATION_TEST')!.uxArea).toBe('DEVICE');
    expect(
      NOTIFICATION_CATALOG.filter((t) => t.uxArea === 'DEVICE').map((t) => t.typeKey),
    ).toEqual(['NOTIFICATION_TEST']);
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
