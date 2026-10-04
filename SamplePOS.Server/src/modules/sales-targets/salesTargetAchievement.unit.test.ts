import { describe, expect, it } from '@jest/globals';
import { computeNetAchievementFromParts } from './salesTargetAchievementService.js';

describe('sales target achievement (excl VAT)', () => {
  it('uses subtotal − discount and excludes VOID', () => {
    const result = computeNetAchievementFromParts({
      sales: [
        { subtotal: 1000, discountAmount: 100, status: 'COMPLETED' },
        { subtotal: 500, discountAmount: 0, status: 'VOID' },
        { subtotal: 200, discountAmount: 0, status: 'PARTIALLY_RETURNED' },
      ],
      refunds: [],
    });
    expect(result.eligibleSalesRevenue).toBe(1100);
    expect(result.achievedAmount).toBe(1100);
  });

  it('deducts refunds scaled to pretax sale revenue (inclusive shelf case)', () => {
    // Sale: line gross 118, pretax 100, tax 18, inclusive refund 59 (half)
    const result = computeNetAchievementFromParts({
      sales: [{ subtotal: 100, discountAmount: 0, status: 'PARTIALLY_RETURNED' }],
      refunds: [
        {
          totalAmount: 59,
          lineGross: 118,
          saleSubtotal: 100,
          saleDiscount: 0,
          saleTotalAmount: 118,
          saleTaxAmount: 18,
          refundStatus: 'COMPLETED',
        },
      ],
    });
    expect(result.eligibleSalesRevenue).toBe(100);
    expect(result.refundsExclVat).toBe(50);
    expect(result.achievedAmount).toBe(50);
  });

  it('exclusive tax: refund already pretax; scale only allocates document discount', () => {
    const result = computeNetAchievementFromParts({
      sales: [{ subtotal: 100, discountAmount: 10, status: 'COMPLETED' }],
      refunds: [
        {
          totalAmount: 50,
          lineGross: 100,
          saleSubtotal: 100,
          saleDiscount: 10,
          saleTotalAmount: 108, // 90 pretax + 18 tax
          saleTaxAmount: 18,
          refundStatus: 'COMPLETED',
        },
      ],
    });
    expect(result.eligibleSalesRevenue).toBe(90);
    expect(result.refundsExclVat).toBe(45);
    expect(result.achievedAmount).toBe(45);
  });

  it('includes VOIDED_BY_RETURN sale revenue so refunds do not double-penalize', () => {
    const result = computeNetAchievementFromParts({
      sales: [{ subtotal: 200, discountAmount: 0, status: 'VOIDED_BY_RETURN' }],
      refunds: [
        {
          totalAmount: 200,
          lineGross: 200,
          saleSubtotal: 200,
          saleDiscount: 0,
          saleTotalAmount: 200,
          saleTaxAmount: 0,
          refundStatus: 'COMPLETED',
        },
      ],
    });
    expect(result.eligibleSalesRevenue).toBe(200);
    expect(result.refundsExclVat).toBe(200);
    expect(result.achievedAmount).toBe(0);
  });

  it('ignores cancelled refunds and REFUNDED legacy status sales', () => {
    const result = computeNetAchievementFromParts({
      sales: [
        { subtotal: 80, discountAmount: 0, status: 'COMPLETED' },
        { subtotal: 999, discountAmount: 0, status: 'REFUNDED' },
      ],
      refunds: [
        {
          totalAmount: 20,
          lineGross: 80,
          saleSubtotal: 80,
          saleDiscount: 0,
          saleTotalAmount: 80,
          saleTaxAmount: 0,
          refundStatus: 'CANCELLED',
        },
      ],
    });
    expect(result.eligibleSalesRevenue).toBe(80);
    expect(result.refundsExclVat).toBe(0);
    expect(result.achievedAmount).toBe(80);
  });
});
