import { describe, expect, it } from 'vitest';
import {
  restaurantFohStockWarnForLines,
  restaurantFohStockWarnMessage,
  restaurantStockIsShort,
  showRestaurantMenuRemainingQty,
} from '@shared/restaurant/restaurantStockPolicy';

describe('restaurantStockPolicy', () => {
  it('shows remaining only for inventory/consumable, not service', () => {
    expect(showRestaurantMenuRemainingQty('inventory')).toBe(true);
    expect(showRestaurantMenuRemainingQty('consumable')).toBe(true);
    expect(showRestaurantMenuRemainingQty('service')).toBe(false);
    expect(showRestaurantMenuRemainingQty(null)).toBe(true);
  });

  it('detects short stock', () => {
    expect(restaurantStockIsShort(18, 2)).toBe(false);
    expect(restaurantStockIsShort(1, 2)).toBe(true);
    expect(restaurantStockIsShort(null, 2)).toBe(false);
  });

  it('service never warns; oversell suppresses warn', () => {
    expect(
      restaurantFohStockWarnMessage({
        allowOversell: false,
        productType: 'service',
        productName: 'Cover charge',
        remainingQty: 0,
        requestedQty: 5,
        stage: 'kot',
      }),
    ).toBeNull();

    expect(
      restaurantFohStockWarnMessage({
        allowOversell: true,
        productType: 'inventory',
        productName: 'AMSTEL 330ML',
        remainingQty: 0,
        requestedQty: 2,
        stage: 'kot',
      }),
    ).toBeNull();
  });

  it('warns on KOT when oversell off and short', () => {
    const msg = restaurantFohStockWarnMessage({
      allowOversell: false,
      productType: 'inventory',
      productName: 'AMSTEL 330ML',
      remainingQty: 1,
      requestedQty: 2,
      stage: 'kot',
    });
    expect(msg).toMatch(/Avoid printing/);
    expect(msg).toMatch(/AMSTEL/);
  });

  it('aggregates lines for KOT warn', () => {
    const msgs = restaurantFohStockWarnForLines({
      allowOversell: false,
      stage: 'kot',
      lines: [
        { productId: 'a', productName: 'AMSTEL', productType: 'inventory', quantity: 2 },
        { productId: 'a', productName: 'AMSTEL', productType: 'inventory', quantity: 2 },
        { productId: 's', productName: 'Fee', productType: 'service', quantity: 1 },
      ],
      remainingByProductId: { a: 3, s: 0 },
    });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatch(/needs 4, remaining 3/);
  });
});
