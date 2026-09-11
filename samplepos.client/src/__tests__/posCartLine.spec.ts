import { describe, expect, it } from 'vitest';
import {
  getPosLineMinUnitPrice,
  isPosLineBlockedByCatalogCost,
  isPosLineRevenueBelowCatalogCost,
  isPosUnitPriceBelowCatalogCost,
  normalizePosUnitPrice,
  recalcPosCartLineFields,
} from '../utils/posCartLine';

describe('posCartLine', () => {
  it('normalizes unit price to 2 decimal places', () => {
    expect(normalizePosUnitPrice(1100.456)).toBe(1100.46);
    expect(normalizePosUnitPrice(-5)).toBe(0);
  });

  it('recalculates subtotal with line discount', () => {
    const r = recalcPosCartLineFields({
      quantity: 2,
      unitPrice: 1000,
      costPrice: 800,
      discount: { type: 'FIXED_AMOUNT', value: 200, amount: 200, reason: 'test' },
    });
    expect(r.subtotal).toBe(1800);
    expect(r.unitPrice).toBe(1000);
  });

  it('caps discount when unit price drops', () => {
    const r = recalcPosCartLineFields({
      quantity: 1,
      unitPrice: 100,
      costPrice: 50,
      discount: { type: 'FIXED_AMOUNT', value: 500, amount: 500, reason: 'test' },
    });
    expect(r.subtotal).toBe(0);
    expect(r.discount?.amount).toBe(100);
  });

  it('AT_COST line ignores stale catalog cost until synced', () => {
    const floor = getPosLineMinUnitPrice(
      { unitPrice: 11000, costPrice: 11632.2, pricingRule: { scope: 'at_cost' } },
      'AT_COST',
    );
    expect(floor).toBe(11000);
    expect(
      isPosLineBlockedByCatalogCost(
        { unitPrice: 11000, costPrice: 11632.2, subtotal: 11000, quantity: 1, pricingRule: { scope: 'at_cost' } },
        'AT_COST',
      ),
    ).toBe(false);
  });

  it('walk-in write-down floor: 3000 and 2999.99 allowed, 2999.98 blocked', () => {
    const floorLine = { unitPrice: 10000, costPrice: 3000, subtotal: 10000, quantity: 1 };
    expect(isPosLineBlockedByCatalogCost(floorLine)).toBe(false);
    expect(
      isPosLineBlockedByCatalogCost({ unitPrice: 3000, costPrice: 3000, subtotal: 3000, quantity: 1 }),
    ).toBe(false);
    expect(
      isPosLineBlockedByCatalogCost({ unitPrice: 2999.99, costPrice: 3000, subtotal: 2999.99, quantity: 1 }),
    ).toBe(false);
    expect(
      isPosLineBlockedByCatalogCost({ unitPrice: 2999.98, costPrice: 3000, subtotal: 2999.98, quantity: 1 }),
    ).toBe(true);
  });

  it('detects below-cost unit and discounted line', () => {
    expect(isPosUnitPriceBelowCatalogCost(500, 1000)).toBe(true);
    expect(isPosLineRevenueBelowCatalogCost(900, 1, 1000)).toBe(true);
    expect(
      isPosLineBlockedByCatalogCost({
        unitPrice: 1200,
        subtotal: 900,
        quantity: 1,
        costPrice: 1000,
      }),
    ).toBe(true);
  });
});
