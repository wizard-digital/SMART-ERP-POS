import { describe, it, expect } from '@jest/globals';
import Decimal from 'decimal.js';
import {
  assertAtCostMargin,
  assertSaleHeaderMatchesCalculatedTotal,
  assertSaleLineEconomicsConsistent,
  deriveUnitPriceFromLineTotal,
  resolveSaleHeaderTotal,
} from './saleIntegrity.js';
import { BusinessError } from '../../middleware/errorHandler.js';

describe('saleIntegrity', () => {
  it('deriveUnitPriceFromLineTotal divides line by qty', () => {
    expect(deriveUnitPriceFromLineTotal(3900000, 3)).toBe(1300000);
  });

  it('assertSaleHeaderMatchesCalculatedTotal rejects drift', () => {
    expect(() =>
      assertSaleHeaderMatchesCalculatedTotal(4800000, new Decimal(5100000)),
    ).toThrow(BusinessError);
  });

  it('assertSaleHeaderMatchesCalculatedTotal allows match within tolerance', () => {
    expect(() =>
      assertSaleHeaderMatchesCalculatedTotal(4800000, new Decimal(4800000)),
    ).not.toThrow();
  });

  it('assertSaleLineEconomicsConsistent catches 4063-style mismatch', () => {
    expect(
      assertSaleLineEconomicsConsistent({
        quantity: 3,
        unitPrice: 1700000,
        totalPrice: 5100000,
      }).ok,
    ).toBe(true);
    expect(
      assertSaleLineEconomicsConsistent({
        quantity: 3,
        unitPrice: 1700000,
        totalPrice: 4800000,
      }).ok,
    ).toBe(false);
  });

  it('assertSaleLineEconomicsConsistent accepts rung unit minus line markdown', () => {
    expect(
      assertSaleLineEconomicsConsistent({
        quantity: 1,
        unitPrice: 312000,
        totalPrice: 306000,
        discountAmount: 6000,
      }).ok,
    ).toBe(true);
  });

  it('assertAtCostMargin rejects 4063 profit profile', () => {
    expect(
      assertAtCostMargin({ totalAmount: 4800000, totalCost: 3900000, maxMarginPct: 2 }).ok,
    ).toBe(false);
  });

  it('assertAtCostMargin accepts near-zero margin', () => {
    expect(
      assertAtCostMargin({ totalAmount: 3900000, totalCost: 3900000, maxMarginPct: 2 }).ok,
    ).toBe(true);
  });

  it('resolveSaleHeaderTotal coerces exclusive-add trap under inclusive', () => {
    const r = resolveSaleHeaderTotal({
      providedTotal: 4840.68,
      pricedLinesAfterDiscount: new Decimal(4200),
      taxAmount: new Decimal(640.68),
      taxInclusive: true,
    });
    expect(r.finalTotal.toNumber()).toBe(4200);
    expect(r.coercedFromExclusiveTrap).toBe(true);
  });

  it('resolveSaleHeaderTotal rejects real drift under exclusive', () => {
    expect(() =>
      resolveSaleHeaderTotal({
        providedTotal: 4840.68,
        pricedLinesAfterDiscount: new Decimal(4200),
        taxAmount: new Decimal(756),
        taxInclusive: false,
      }),
    ).toThrow(BusinessError);
  });

  it('resolveSaleHeaderTotal accepts matching inclusive total', () => {
    const r = resolveSaleHeaderTotal({
      providedTotal: 4200,
      pricedLinesAfterDiscount: new Decimal(4200),
      taxAmount: new Decimal(640.68),
      taxInclusive: true,
    });
    expect(r.finalTotal.toNumber()).toBe(4200);
    expect(r.coercedFromExclusiveTrap).toBe(false);
  });

  it('resolveSaleHeaderTotal under inclusive never throws on arbitrary client total', () => {
    const r = resolveSaleHeaderTotal({
      providedTotal: 9999.99,
      pricedLinesAfterDiscount: new Decimal(4200),
      taxAmount: new Decimal(640.68),
      taxInclusive: true,
    });
    expect(r.finalTotal.toNumber()).toBe(4200);
    expect(r.coercedFromExclusiveTrap).toBe(false);
  });
});
