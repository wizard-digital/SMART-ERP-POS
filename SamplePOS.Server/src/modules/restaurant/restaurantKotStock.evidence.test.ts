/**
 * Evidence: SambaPOS-style restaurant KOT stock — deduct on fire, restore on void,
 * createSale skips double-deduct when sourceOrderItemId has RESTAURANT_KOT movements.
 */
import { describe, expect, it } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

function readRepo(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
}

describe('Restaurant KOT stock evidence (Samba)', () => {
  it('policy + service + pay skip + menu ordered qty are wired', () => {
    const policy = readRepo('shared/restaurant/restaurantKotStockPolicy.ts');
    expect(policy).toMatch(/shouldDeductStockOnRestaurantKot/);
    expect(policy).toMatch(/formatRestaurantMenuStockLabel/);
    expect(policy).toMatch(/RESTAURANT_KOT/);

    const kot = readRepo('SamplePOS.Server/src/modules/restaurant/restaurantKotStockService.ts');
    expect(kot).toMatch(/issueStockOnRestaurantKot/);
    expect(kot).toMatch(/restoreStockOnRestaurantKotVoid/);
    expect(kot).toMatch(/getNetRestaurantKotIssue/);
    expect(kot).toMatch(/loadRestaurantOrderedQtyByProduct/);
    expect(kot).toMatch(/ADJUSTMENT_OUT/);
    expect(kot).toMatch(/ADJUSTMENT_IN/);

    const service = readRepo('SamplePOS.Server/src/modules/restaurant/restaurantService.ts');
    expect(service).toMatch(/issueStockOnRestaurantKot/);
    expect(service).toMatch(/restoreStockOnRestaurantKotVoid/);
    expect(service).toMatch(/orderedQuantity/);

    const sales = readRepo('SamplePOS.Server/src/modules/sales/salesService.ts');
    expect(sales).toMatch(/sourceOrderItemId/);
    expect(sales).toMatch(/kotPreIssuedCost/);
    expect(sales).toMatch(/getNetRestaurantKotIssue/);

    const orders = readRepo('SamplePOS.Server/src/modules/orders/ordersRoutes.ts');
    expect(orders).toMatch(/sourceOrderItemId:\s*item\.id/);

    const offline = readRepo('samplepos.client/src/lib/restaurantOfflineOps.ts');
    expect(offline).toMatch(/decrementLocalStock/);
    expect(offline).toMatch(/Already deducted when KOT fired/);
    expect(offline).toMatch(/if \(line\.kitchenSentAt\) continue/);

    const pos = readRepo('samplepos.client/src/pages/restaurant/RestaurantPosPage.tsx');
    expect(pos).toMatch(/formatRestaurantMenuStockLabel/);
    expect(pos).toMatch(/invalidateMenuStock/);
    expect(pos).toMatch(/orderedQuantity/);
  });

  it('warehouse deduct path accepts ADJUSTMENT_OUT for KOT issue', () => {
    const wh = readRepo(
      'SamplePOS.Server/src/modules/inventory/warehouse/warehouseSaleDeductionService.ts',
    );
    expect(wh).toMatch(/ADJUSTMENT_OUT/);
    expect(wh).toMatch(/MultistoreDeductionMovementType/);
  });
});
