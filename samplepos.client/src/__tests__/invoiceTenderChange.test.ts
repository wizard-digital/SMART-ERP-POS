import { describe, expect, it } from 'vitest';
import { computeInvoiceTender } from '../utils/invoiceTenderChange';

describe('computeInvoiceTender (POS-style AR)', () => {
  it('50k cash on 2200 due → take 2200, change 47800', () => {
    const r = computeInvoiceTender({
      invoiceDue: 2200,
      depositRequested: 0,
      cashTendered: 50000,
      paymentMethod: 'CASH',
    });
    expect(r.cashApplied).toBe(2200);
    expect(r.totalApplied).toBe(2200);
    expect(r.changeGiven).toBe(47800);
    expect(r.remainingDue).toBe(0);
  });

  it('card over due applies due with no change', () => {
    const r = computeInvoiceTender({
      invoiceDue: 2200,
      depositRequested: 0,
      cashTendered: 50000,
      paymentMethod: 'CARD',
    });
    expect(r.cashApplied).toBe(2200);
    expect(r.changeGiven).toBe(0);
  });

  it('deposit then cash caps at due', () => {
    const r = computeInvoiceTender({
      invoiceDue: 4200,
      depositRequested: 2000,
      cashTendered: 10000,
      paymentMethod: 'CASH',
    });
    expect(r.depositApplied).toBe(2000);
    expect(r.cashApplied).toBe(2200);
    expect(r.changeGiven).toBe(7800);
  });

  it('deposit request above due is capped (no over-apply)', () => {
    const r = computeInvoiceTender({
      invoiceDue: 1000,
      depositRequested: 5000,
      cashTendered: 0,
      paymentMethod: 'CASH',
    });
    expect(r.depositApplied).toBe(1000);
    expect(r.totalApplied).toBe(1000);
    expect(r.remainingDue).toBe(0);
  });
});
