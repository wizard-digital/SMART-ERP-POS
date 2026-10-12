/**
 * SSOT: allocated cost preview — store vs legacy FEFO shortfall rules (one pad).
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import Decimal from 'decimal.js';

const previewSaleCostAtStore = jest.fn();
const previewFefoIssueCostForBaseQty = jest.fn();

jest.unstable_mockModule('../inventory/warehouse/warehouseSaleDeductionService.js', () => ({
  warehouseSaleDeductionService: { previewSaleCostAtStore },
}));

jest.unstable_mockModule('../pricing/atCostIssuePrice.js', () => ({
  previewFefoIssueCostForBaseQty,
}));

const { previewProductLineAllocatedCost, allocatedCostPerSellingUnit } = await import(
  './saleAllocatedCostPreview.js'
);

describe('previewProductLineAllocatedCost', () => {
  const client = {} as import('pg').PoolClient;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('pads store FEFO shortfall at average (same rule as legacy)', async () => {
    previewSaleCostAtStore.mockResolvedValue({
      totalCost: new Decimal(80),
      shortfall: new Decimal(2),
      coveredQty: new Decimal(8),
    });
    const r = await previewProductLineAllocatedCost(client, {
      productId: 'p1',
      baseQty: new Decimal(10),
      masterCost: new Decimal(10),
      averageCost: new Decimal(15),
      minDaysBeforeExpiry: 0,
      sellingStoreId: 'store-1',
    });
    // 80 + 2*15 = 110
    expect(r.totalCost.toNumber()).toBe(110);
    expect(previewFefoIssueCostForBaseQty).not.toHaveBeenCalled();
  });

  it('pads legacy FEFO shortfall at average when average > 0', async () => {
    previewFefoIssueCostForBaseQty.mockResolvedValue({
      totalCost: new Decimal(80),
      shortfall: new Decimal(2),
      coveredQty: new Decimal(8),
    });
    const r = await previewProductLineAllocatedCost(client, {
      productId: 'p1',
      baseQty: new Decimal(10),
      masterCost: new Decimal(10),
      averageCost: new Decimal(15),
      minDaysBeforeExpiry: 0,
      sellingStoreId: null,
    });
    expect(r.totalCost.toNumber()).toBe(110);
    expect(previewSaleCostAtStore).not.toHaveBeenCalled();
  });

  it('pads shortfall at master when average is 0 (store and legacy)', async () => {
    previewSaleCostAtStore.mockResolvedValue({
      totalCost: new Decimal(80),
      shortfall: new Decimal(2),
      coveredQty: new Decimal(8),
    });
    const store = await previewProductLineAllocatedCost(client, {
      productId: 'p1',
      baseQty: new Decimal(10),
      masterCost: new Decimal(10),
      averageCost: new Decimal(0),
      minDaysBeforeExpiry: 0,
      sellingStoreId: 'store-1',
    });
    expect(store.totalCost.toNumber()).toBe(100);

    previewFefoIssueCostForBaseQty.mockResolvedValue({
      totalCost: new Decimal(80),
      shortfall: new Decimal(2),
      coveredQty: new Decimal(8),
    });
    const legacy = await previewProductLineAllocatedCost(client, {
      productId: 'p1',
      baseQty: new Decimal(10),
      masterCost: new Decimal(10),
      averageCost: new Decimal(0),
      minDaysBeforeExpiry: 0,
      sellingStoreId: null,
    });
    expect(legacy.totalCost.toNumber()).toBe(100);
  });

  it('allocatedCostPerSellingUnit rounds like createSale', () => {
    expect(allocatedCostPerSellingUnit(new Decimal(100), 3)).toBe(33.33);
    expect(allocatedCostPerSellingUnit(new Decimal(100), 0)).toBe(0);
  });
});
