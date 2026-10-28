import { describe, expect, it } from '@jest/globals';
import { aggregatePaymentsByMethod } from './saleBankMirrorPolicy.js';

describe('aggregatePaymentsByMethod — one bank row per (sale, method)', () => {
  it('sums same-method split lines so the second line is not dropped by the idempotency key', () => {
    expect(
      aggregatePaymentsByMethod([
        { amount: 5000, paymentMethod: 'MOBILE_MONEY' },
        { amount: 3000, paymentMethod: 'MOBILE_MONEY' },
        { amount: 2000, paymentMethod: 'CARD' },
      ]),
    ).toEqual([
      { paymentMethod: 'MOBILE_MONEY', amount: 8000 },
      { paymentMethod: 'CARD', amount: 2000 },
    ]);
  });

  it('is float-safe (0.1 + 0.2 style drift cannot create a 1-cent mismatch)', () => {
    const out = aggregatePaymentsByMethod([
      { amount: 0.1, paymentMethod: 'CARD' },
      { amount: 0.2, paymentMethod: 'CARD' },
    ]);
    expect(out).toEqual([{ paymentMethod: 'CARD', amount: 0.3 }]);
  });

  it('keeps distinct methods separate and preserves first-seen order; empty in => empty out', () => {
    expect(aggregatePaymentsByMethod([])).toEqual([]);
    expect(
      aggregatePaymentsByMethod([
        { amount: 1, paymentMethod: 'AIRTEL_MONEY' },
        { amount: 2, paymentMethod: 'CARD' },
        { amount: 3, paymentMethod: 'AIRTEL_MONEY' },
      ]).map((p) => p.paymentMethod),
    ).toEqual(['AIRTEL_MONEY', 'CARD']);
  });

  it('conserves the total across any grouping', () => {
    const lines = Array.from({ length: 20 }, (_, i) => ({ amount: 1234.56 + i, paymentMethod: i % 3 ? 'CARD' : 'MOBILE_MONEY' }));
    const grouped = aggregatePaymentsByMethod(lines);
    const sum = (xs: { amount: number }[]) => Math.round(xs.reduce((a, b) => a + Math.round(b.amount * 100), 0));
    expect(sum(grouped)).toBe(sum(lines));
  });
});
