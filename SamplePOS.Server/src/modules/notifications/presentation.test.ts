import { describe, expect, it } from '@jest/globals';
import { formatAmountLabel, formatInboxBody, groupingKeyFor, inboxMatchesFilter, priorityFromType, summarizeSoldProducts } from './presentation.js';
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

  it('leads with sold products for completed sales', () => {
    expect(summarizeSoldProducts([
      { productName: 'Paracetamol 500mg', quantity: 2 },
      { productName: 'Amoxil', quantity: 1 },
    ])).toBe('Paracetamol 500mg ×2, Amoxil');
    const body = formatInboxBody({
      actorDisplay: 'Mary',
      actorRole: 'CASHIER',
      documentRef: 'SALE-2026-14467',
      locationLabel: null,
      amountLabel: formatAmountLabel(18500),
      productSummary: 'Paracetamol 500mg ×2, Amoxil',
      businessSummary: 'Sold Paracetamol 500mg ×2, Amoxil',
      fallback: 'A sale was completed.',
    });
    expect(body.split('\n')[0]).toBe('Paracetamol 500mg ×2, Amoxil');
    expect(body).toContain('SALE-2026-14467');
    expect(body).toContain('18,500');
    expect(body).not.toMatch(/supervise|permission|why you/i);
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
    expect(priorityFromType(getNotificationType('PO_CREATED')!)).toBe('LOW');
    expect(priorityFromType(getNotificationType('PO_SUBMITTED')!)).toBe('HIGH');
  });

  it('filters the inbox to exceptions first', () => {
    expect(inboxMatchesFilter('EXCEPTIONS', 'attention')).toBe(true);
    expect(inboxMatchesFilter('SECURITY', 'attention')).toBe(true);
    expect(inboxMatchesFilter('ACTIVITY', 'attention')).toBe(false);
    expect(inboxMatchesFilter('MONEY', 'attention')).toBe(false);
    expect(inboxMatchesFilter('MONEY', 'cash')).toBe(true);
    expect(inboxMatchesFilter('APPROVALS', 'waiting')).toBe(true);
    expect(inboxMatchesFilter('ACTIVITY', 'all')).toBe(true);
  });
});
