import { describe, expect, it } from 'vitest';
import {
  formatRestaurantMenuStockLabel,
  shouldDeductStockOnRestaurantKot,
  RESTAURANT_KOT_REFERENCE_TYPE,
  RESTAURANT_KOT_VOID_REFERENCE_TYPE,
} from './restaurantKotStockPolicy.js';

describe('restaurantKotStockPolicy', () => {
  it('service never deducts on KOT; inventory/consumable do', () => {
    expect(shouldDeductStockOnRestaurantKot('service')).toBe(false);
    expect(shouldDeductStockOnRestaurantKot('inventory')).toBe(true);
    expect(shouldDeductStockOnRestaurantKot('consumable')).toBe(true);
  });

  it('menu label shows available and ordered', () => {
    expect(
      formatRestaurantMenuStockLabel({
        productType: 'service',
        availableQty: 10,
        orderedQty: 2,
      }).show,
    ).toBe(false);

    const plain = formatRestaurantMenuStockLabel({
      productType: 'inventory',
      availableQty: 12,
      orderedQty: 0,
    });
    expect(plain.show).toBe(true);
    expect(plain.label).toMatch(/12.*left/);

    const withOrdered = formatRestaurantMenuStockLabel({
      productType: 'inventory',
      availableQty: 5,
      orderedQty: 3,
    });
    expect(withOrdered.label).toMatch(/5.*left/);
    expect(withOrdered.label).toMatch(/3.*ordered/);
  });

  it('reference types are stable SSOT strings', () => {
    expect(RESTAURANT_KOT_REFERENCE_TYPE).toBe('RESTAURANT_KOT');
    expect(RESTAURANT_KOT_VOID_REFERENCE_TYPE).toBe('RESTAURANT_KOT_VOID');
  });
});
