import { describe, expect, it } from 'vitest';
import {
  applyAreaOff,
  applyAreaOn,
  applyTypeChannel,
  applyTypeDelivery,
  applyTypeReceive,
  areaIsOn,
  areaPreferenceMode,
  groupPreferenceAreas,
  lastActiveLabel,
  recommendedAreaLabels,
  type NotificationPrefType,
} from './notificationAreas';

function row(partial: Partial<NotificationPrefType> & Pick<NotificationPrefType, 'typeKey' | 'label'>): NotificationPrefType {
  return {
    inAppEnabled: false,
    pushEnabled: false,
    recommendedInApp: false,
    recommendedPush: false,
    ...partial,
  };
}

describe('notification settings areas', () => {
  it('groups types into business areas and hides the device test type', () => {
    const groups = groupPreferenceAreas([
      row({
        typeKey: 'SALE_VOIDED',
        label: 'Sale cancelled',
        uxArea: 'SALES',
        uxAreaLabel: 'Sales',
        operatorBand: 'EXCEPTIONS',
        inAppEnabled: true,
      }),
      row({
        typeKey: 'SALE_COMPLETED',
        label: 'Sale completed',
        uxArea: 'SALES',
        uxAreaLabel: 'Sales',
        operatorBand: 'ACTIVITY',
      }),
      row({
        typeKey: 'NOTIFICATION_TEST',
        label: 'Test notification',
        uxArea: 'DEVICE',
        uxAreaLabel: 'This device',
      }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].area).toBe('SALES');
    expect(groups[0].on).toBe(true);
    expect(groups[0].preview).toContain('Sale cancelled');
    expect(groups[0].items.map((item) => item.typeKey)).toEqual(['SALE_VOIDED', 'SALE_COMPLETED']);
  });

  it('turns an area on with role recommended channels, not every type', () => {
    const sales = [
      row({
        typeKey: 'SALE_VOIDED',
        label: 'Sale cancelled',
        uxArea: 'SALES',
        recommendedInApp: true,
        recommendedPush: true,
      }),
      row({
        typeKey: 'SALE_COMPLETED',
        label: 'Sale completed',
        uxArea: 'SALES',
        recommendedInApp: false,
        recommendedPush: false,
      }),
    ];
    const next = applyAreaOn(sales);
    expect(next[0].inAppEnabled).toBe(true);
    expect(next[0].pushEnabled).toBe(true);
    expect(next[1].inAppEnabled).toBe(false);
    expect(next[1].pushEnabled).toBe(false);
    expect(areaIsOn(next)).toBe(true);
  });

  it('classifies an area as on, off, or custom from the dropdown', () => {
    const recommendedOn = [
      row({
        typeKey: 'SALE_VOIDED',
        label: 'Sale cancelled',
        uxArea: 'SALES',
        recommendedInApp: true,
        recommendedPush: true,
        inAppEnabled: true,
        pushEnabled: true,
      }),
      row({
        typeKey: 'SALE_COMPLETED',
        label: 'Sale completed',
        uxArea: 'SALES',
        recommendedInApp: false,
        inAppEnabled: false,
      }),
    ];
    expect(areaPreferenceMode(recommendedOn)).toBe('on');
    expect(areaPreferenceMode(applyAreaOff(recommendedOn))).toBe('off');
    expect(areaPreferenceMode([
      recommendedOn[0],
      { ...recommendedOn[1], inAppEnabled: true },
    ])).toBe('custom');
    expect(areaPreferenceMode(recommendedOn, true)).toBe('always-on');
  });

  it('maps a type delivery dropdown to channels', () => {
    const sale = row({ typeKey: 'SALE_COMPLETED', label: 'Sale completed' });
    expect(applyTypeDelivery(sale, 'in-app')).toEqual(expect.objectContaining({ inAppEnabled: true, pushEnabled: false }));
    expect(applyTypeDelivery(sale, 'both')).toEqual(expect.objectContaining({ inAppEnabled: true, pushEnabled: true }));
    expect(applyTypeDelivery(sale, 'off')).toEqual(expect.objectContaining({ inAppEnabled: false, pushEnabled: false }));
    const locked = row({
      typeKey: 'SECURITY_PASSWORD_CHANGED',
      label: 'Password changed',
      inAppLocked: true,
      preferenceMode: 'MANDATORY',
      inAppEnabled: true,
    });
    expect(applyTypeDelivery(locked, 'off').inAppEnabled).toBe(true);
    expect(applyTypeDelivery(locked, 'push').inAppEnabled).toBe(true);
    expect(applyTypeDelivery(locked, 'push').pushEnabled).toBe(true);
  });

  it('turns an area off without silencing mandatory in-app types', () => {
    const next = applyAreaOff([
      row({
        typeKey: 'SALE_VOIDED',
        label: 'Sale cancelled',
        inAppEnabled: true,
        pushEnabled: true,
      }),
      row({
        typeKey: 'SECURITY_PASSWORD_CHANGED',
        label: 'Password changed',
        inAppLocked: true,
        preferenceMode: 'MANDATORY',
        inAppEnabled: true,
        pushEnabled: true,
      }),
    ]);
    expect(next[0].inAppEnabled).toBe(false);
    expect(next[0].pushEnabled).toBe(false);
    expect(next[1].inAppEnabled).toBe(true);
    expect(next[1].pushEnabled).toBe(false);
  });

  it('lets a type checkbox opt into recommended channels', () => {
    const opted = applyTypeReceive(
      row({
        typeKey: 'SALE_COMPLETED',
        label: 'Sale completed',
        recommendedInApp: false,
        recommendedPush: false,
      }),
      true,
    );
    expect(opted.inAppEnabled).toBe(true);
    expect(applyTypeChannel(opted, 'push', true).pushEnabled).toBe(true);
    expect(applyTypeReceive(opted, false).inAppEnabled).toBe(false);
  });

  it('lists recommended areas from role defaults, not the full catalog', () => {
    const labels = recommendedAreaLabels([
      row({
        typeKey: 'SALE_VOIDED',
        label: 'Sale cancelled',
        uxArea: 'SALES',
        recommendedInApp: true,
      }),
      row({
        typeKey: 'SALE_COMPLETED',
        label: 'Sale completed',
        uxArea: 'SALES',
        recommendedInApp: false,
      }),
      row({
        typeKey: 'CUSTOMER_PAYMENT_RECEIVED',
        label: 'Payment received',
        uxArea: 'CUSTOMERS',
        recommendedInApp: true,
      }),
      row({
        typeKey: 'INVENTORY_LOW_STOCK',
        label: 'Low stock',
        uxArea: 'INVENTORY',
        recommendedInApp: true,
      }),
      row({
        typeKey: 'APPROVAL_REQUIRED',
        label: 'Approval required',
        uxArea: 'APPROVALS',
        recommendedInApp: true,
      }),
      row({
        typeKey: 'SECURITY_PASSWORD_CHANGED',
        label: 'Password changed',
        uxArea: 'SECURITY',
        uxAreaAlwaysOn: true,
        inAppLocked: true,
      }),
      row({
        typeKey: 'PO_CREATED',
        label: 'Purchase order created',
        uxArea: 'PURCHASING',
        recommendedInApp: false,
      }),
    ]);
    expect(labels).toEqual([
      'Sales exceptions',
      'Customer payments',
      'Stock alerts',
      'Approval requests',
      'Security',
    ]);
  });

  it('calls today today', () => {
    expect(lastActiveLabel(new Date().toISOString())).toBe('Today');
  });
});
