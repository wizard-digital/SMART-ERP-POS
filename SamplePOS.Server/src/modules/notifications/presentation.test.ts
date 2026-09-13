import { describe, expect, it } from '@jest/globals';
import { formatAmountLabel, formatInboxBody, groupingKeyFor, priorityFromType } from './presentation.js';
import { getNotificationType } from './catalog.js';

describe('notification presentation', () => {
  it('builds a concise inbox body with actor, document, location and amount', () => {
    const body = formatInboxBody({
      actorDisplay: 'John',
      actorRole: 'CASHIER',
      documentRef: 'SAL-10482',
      locationLabel: 'Kampala Branch',
      amountLabel: formatAmountLabel(250000, 'UGX'),
      fallback: 'A sale was completed.',
    });
    expect(body).toContain('John — CASHIER');
    expect(body).toContain('SAL-10482');
    expect(body).toContain('Kampala Branch');
    expect(body).toContain('UGX');
    expect(body).not.toMatch(/event id/i);
  });

  it('falls back when actor and document are missing', () => {
    expect(
      formatInboxBody({
        actorDisplay: null,
        actorRole: null,
        documentRef: null,
        locationLabel: null,
        amountLabel: null,
        fallback: 'A sale was voided or cancelled.',
      }),
    ).toBe('A sale was voided or cancelled.');
  });

  it('groups high-volume sales by location hour and leaves voids ungrouped', () => {
    const sale = getNotificationType('SALE_COMPLETED')!;
    const voided = getNotificationType('SALE_VOIDED')!;
    const hour = new Date('2026-09-12T10:15:00.000Z');
    expect(groupingKeyFor(sale, 'kampala', hour)).toBe('SALE_COMPLETED:kampala:2026-09-12T10');
    expect(groupingKeyFor(voided, 'kampala', hour)).toBeNull();
  });

  it('maps security and high-volume types to distinct priorities', () => {
    expect(priorityFromType(getNotificationType('SECURITY_PASSWORD_CHANGED')!)).toBe('CRITICAL');
    expect(priorityFromType(getNotificationType('SALE_VOIDED')!)).toBe('HIGH');
    expect(priorityFromType(getNotificationType('SALE_COMPLETED')!)).toBe('LOW');
    expect(priorityFromType(getNotificationType('PO_CREATED')!)).toBe('NORMAL');
  });
});
