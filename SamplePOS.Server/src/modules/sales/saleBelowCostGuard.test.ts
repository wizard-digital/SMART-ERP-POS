import { describe, it, expect } from '@jest/globals';
import { assertSaleLineNotBelowAllocatedCost } from './saleBelowCostGuard.js';
import { BusinessError } from '../../middleware/errorHandler.js';

describe('assertSaleLineNotBelowAllocatedCost', () => {
  it('allows selling at exact allocated cost', () => {
    expect(() =>
      assertSaleLineNotBelowAllocatedCost({
        productId: 'p1',
        quantity: 3,
        lineRevenue: 3_900_000,
        totalAllocatedCost: 3_900_000,
        costPerSellingUnit: 1_300_000,
        unitPrice: 1_300_000,
      }),
    ).not.toThrow();
  });

  it('allows selling above allocated cost', () => {
    expect(() =>
      assertSaleLineNotBelowAllocatedCost({
        productId: 'p1',
        quantity: 1,
        lineRevenue: 2_000_000,
        totalAllocatedCost: 1_500_000,
        costPerSellingUnit: 1_500_000,
        unitPrice: 2_000_000,
      }),
    ).not.toThrow();
  });

  it('blocks selling below allocated cost', () => {
    expect(() =>
      assertSaleLineNotBelowAllocatedCost({
        productId: 'p1',
        productName: 'OZEMPIC',
        quantity: 3,
        lineRevenue: 3_000_000,
        totalAllocatedCost: 3_900_000,
        costPerSellingUnit: 1_300_000,
        unitPrice: 1_000_000,
      }),
    ).toThrow(BusinessError);

    try {
      assertSaleLineNotBelowAllocatedCost({
        productId: 'p1',
        quantity: 1,
        lineRevenue: 1,
        totalAllocatedCost: 100,
        costPerSellingUnit: 100,
        unitPrice: 1,
      });
    } catch (e) {
      expect((e as BusinessError).errorCode).toBe('BELOW_ALLOCATED_COST');
      expect((e as BusinessError).message).toContain('below actual inventory cost');
    }
  });

  it('allows 0.01 tolerance at carrying 6000 (5999.99) and rejects 5999.98', () => {
    expect(() =>
      assertSaleLineNotBelowAllocatedCost({
        productId: 'p1',
        quantity: 1,
        lineRevenue: 6000.01,
        totalAllocatedCost: 6000,
        costPerSellingUnit: 6000,
        unitPrice: 6000.01,
      }),
    ).not.toThrow();
    expect(() =>
      assertSaleLineNotBelowAllocatedCost({
        productId: 'p1',
        quantity: 1,
        lineRevenue: 6000,
        totalAllocatedCost: 6000,
        costPerSellingUnit: 6000,
        unitPrice: 6000,
      }),
    ).not.toThrow();
    expect(() =>
      assertSaleLineNotBelowAllocatedCost({
        productId: 'p1',
        quantity: 1,
        lineRevenue: 5999.99,
        totalAllocatedCost: 6000,
        costPerSellingUnit: 6000,
        unitPrice: 5999.99,
      }),
    ).not.toThrow();
    expect(() =>
      assertSaleLineNotBelowAllocatedCost({
        productId: 'p1',
        quantity: 1,
        lineRevenue: 5999.98,
        totalAllocatedCost: 6000,
        costPerSellingUnit: 6000,
        unitPrice: 5999.98,
      }),
    ).toThrow(BusinessError);
  });
});
