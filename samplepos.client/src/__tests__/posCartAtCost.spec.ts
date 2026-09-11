import { describe, expect, it } from 'vitest';
import {
  atCostCartGroupNeedsUpdate,
  applyAllocatedCarryingToCartLine,
  buildAtCostBlendedCartLine,
  buildAtCostSplitCartLines,
  canSplitAtCostLayersToSellingUom,
  mustSplitAtCostFifoLayers,
  shouldSplitAtCostFifoLayers,
} from '../utils/posCartAtCost';
import { recalcPosCartLineFields, isPosLineBlockedByCatalogCost } from '../utils/posCartLine';

describe('posCartAtCost FIFO split', () => {
  const template = {
    id: 'p1',
    name: 'Test Product',
    sku: 'SKU1',
    uom: 'tb',
    costPrice: 0,
    marginPct: 0,
    isTaxable: false,
    taxRate: 0,
    availableUoms: [
      { uomId: 'base', name: 'Tablet', symbol: 'tb', conversionFactor: 1, price: 25000, cost: 19000, isDefault: true },
    ],
    selectedUomId: 'base',
  };

  it('does not require split when blended line matches FIFO total (20k + 18k → 19k)', () => {
    const layers = [
      { baseQuantity: 1, unitCostPerBase: 20000, totalCost: 20000 },
      { baseQuantity: 1, unitCostPerBase: 18000, totalCost: 18000 },
    ];
    expect(shouldSplitAtCostFifoLayers(layers)).toBe(true);
    expect(mustSplitAtCostFifoLayers(layers, 2, 19000)).toBe(false);
    const line = buildAtCostBlendedCartLine(template, 2, 19000, layers, undefined, true);
    expect(line.unitPrice).toBe(19000);
    expect(line.costPrice).toBe(19000);
    expect(line.marginPct).toBe(0);
    expect(line.subtotal).toBe(38000);
  });

  it('requires split when blended unit cannot match FIFO total (rounding)', () => {
    const layers = [
      { baseQuantity: 1, unitCostPerBase: 20000, totalCost: 20000 },
      { baseQuantity: 1, unitCostPerBase: 18001, totalCost: 18001 },
    ];
    expect(mustSplitAtCostFifoLayers(layers, 2, 19000)).toBe(true);
    expect(mustSplitAtCostFifoLayers(layers, 2, 19001)).toBe(true);
    const lines = buildAtCostSplitCartLines(template, layers);
    expect(lines).toHaveLength(2);
    expect(lines[0].subtotal + lines[1].subtotal).toBe(38001);
  });

  it('does not split when all layers share the same unit cost', () => {
    const layers = [
      { baseQuantity: 1, unitCostPerBase: 20000, totalCost: 20000 },
      { baseQuantity: 1, unitCostPerBase: 20000, totalCost: 20000 },
    ];
    expect(shouldSplitAtCostFifoLayers(layers)).toBe(false);
    expect(mustSplitAtCostFifoLayers(layers, 2, 20000)).toBe(false);
  });

  it('scales layer costs for multi-UoM (strip ×10)', () => {
    const stripTemplate = {
      ...template,
      uom: 'st',
      availableUoms: [
        { uomId: 'base', name: 'Tablet', symbol: 'tb', conversionFactor: 1, price: 4000, cost: 1100, isDefault: true },
        { uomId: 'strip', name: 'Strip', symbol: 'st', conversionFactor: 10, price: 40000, cost: 11000, isDefault: false },
      ],
      selectedUomId: 'strip',
    };
    const layers = [{ baseQuantity: 10, unitCostPerBase: 1100, totalCost: 11000 }];
    expect(canSplitAtCostLayersToSellingUom(layers, 10)).toBe(true);
    const lines = buildAtCostSplitCartLines(stripTemplate, layers);
    expect(lines[0].unitPrice).toBe(11000);
    expect(lines[0].quantity).toBe(1);
  });

  it('does not split UoM when layer yields fractional selling qty', () => {
    const layers = [
      { baseQuantity: 5, unitCostPerBase: 20000, totalCost: 100000 },
      { baseQuantity: 5, unitCostPerBase: 18000, totalCost: 90000 },
    ];
    expect(canSplitAtCostLayersToSellingUom(layers, 10)).toBe(false);
  });

  it('atCostCartGroupNeedsUpdate detects stale costPrice', () => {
    const oldLines = [{ quantity: 1, unitPrice: 11000, costPrice: 11632, pricingRule: { scope: 'at_cost' } }];
    const newLines = [{ quantity: 1, unitPrice: 11000, costPrice: 11000, pricingRule: { scope: 'at_cost' } }];
    expect(atCostCartGroupNeedsUpdate(oldLines, newLines, true)).toBe(true);
  });

  it('keeps one blended line for Ozempic-style strip FIFO (1@1.6M + 2@1.15M)', () => {
    const layers = [
      { baseQuantity: 10, unitCostPerBase: 160000, totalCost: 1600000 },
      { baseQuantity: 20, unitCostPerBase: 115000, totalCost: 2300000 },
    ];
    expect(shouldSplitAtCostFifoLayers(layers)).toBe(true);
    expect(mustSplitAtCostFifoLayers(layers, 3, 1300000)).toBe(false);
    expect(canSplitAtCostLayersToSellingUom(layers, 10)).toBe(true);
  });
});

describe('posCartAtCost — customer reprice preserves inventory cost (SSoT)', () => {
  const catalogTemplate = {
    id: 'p1',
    name: 'Acetazolamide',
    sku: 'PRD-MQ5FHGOG-V1PH',
    uom: 'tb',
    costPrice: 633,
    marginPct: 89.45,
    isTaxable: false,
    taxRate: 0,
    availableUoms: [
      { uomId: 'base', name: 'Tablet', symbol: 'tb', conversionFactor: 1, price: 6000, cost: 633, isDefault: true },
    ],
    selectedUomId: 'base',
  };

  it('credit customer reprice: selling price updates, inventory cost unchanged, margin correct', () => {
    const line = buildAtCostBlendedCartLine(catalogTemplate, 1, 6000, [], undefined, false);
    expect(line.unitPrice).toBe(6000);
    expect(line.costPrice).toBe(633);
    expect(line.marginPct).toBeCloseTo(89.45, 1);
  });

  it('credit customer with engine price override: cost still catalog', () => {
    const line = buildAtCostBlendedCartLine(catalogTemplate, 1, 900, [], undefined, false);
    expect(line.unitPrice).toBe(900);
    expect(line.costPrice).toBe(633);
    expect(line.marginPct).toBeCloseTo(29.67, 1);
  });

  it('AT_COST issue price: cost syncs to FEFO issue price, margin 0%', () => {
    const line = buildAtCostBlendedCartLine(catalogTemplate, 1, 633, [], { scope: 'at_cost', ruleName: null, basePrice: 6000, discount: 0 }, true);
    expect(line.unitPrice).toBe(633);
    expect(line.costPrice).toBe(633);
    expect(line.marginPct).toBe(0);
  });

  it('walk-in add path unchanged: recalc with catalog cost only', () => {
    const walkIn = recalcPosCartLineFields({ quantity: 1, unitPrice: 6000, costPrice: 633 });
    expect(walkIn.marginPct).toBeCloseTo(89.45, 1);
  });

  it('manual price edit after customer select uses preserved inventory cost', () => {
    const afterReprice = buildAtCostBlendedCartLine(catalogTemplate, 1, 6000, [], undefined, false);
    const edited = recalcPosCartLineFields({
      quantity: 1,
      unitPrice: 800,
      costPrice: afterReprice.costPrice,
    });
    expect(edited.unitPrice).toBe(800);
    expect(afterReprice.costPrice).toBe(633);
    expect(edited.marginPct).toBeCloseTo(20.88, 1);
  });

  it('below-cost edit shows negative margin (not forced to 0%)', () => {
    const edited = recalcPosCartLineFields({ quantity: 1, unitPrice: 500, costPrice: 633 });
    expect(edited.marginPct).toBeLessThan(0);
  });

  it('walk-in after write-down: catalog 10000, floor 3000, edit to 3000 allowed, 2999.98 blocked', () => {
    const synced = applyAllocatedCarryingToCartLine(
      { unitPrice: 10000, costPrice: 5000, quantity: 1, subtotal: 10000 },
      3000,
    );
    expect(synced.unitPrice).toBe(10000);
    expect(synced.costPrice).toBe(3000);
    expect(synced.subtotal).toBe(10000);
    expect(
      isPosLineBlockedByCatalogCost({
        unitPrice: synced.unitPrice,
        costPrice: synced.costPrice,
        subtotal: synced.subtotal,
        quantity: 1,
      }),
    ).toBe(false);
    expect(
      isPosLineBlockedByCatalogCost({
        unitPrice: 3000,
        costPrice: 3000,
        subtotal: 3000,
        quantity: 1,
      }),
    ).toBe(false);
    expect(
      isPosLineBlockedByCatalogCost({
        unitPrice: 2999.98,
        costPrice: 3000,
        subtotal: 2999.98,
        quantity: 1,
      }),
    ).toBe(true);
  });
});

