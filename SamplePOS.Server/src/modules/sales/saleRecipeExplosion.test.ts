/**
 * Phase 3 Recipes/BOM — inventory vs service product matrix + explode scaling.
 * Stock consumption is planned for createSale (pay), never KOT.
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Decimal from 'decimal.js';
import {
  explodeActiveRecipe,
  planSaleStockDeduction,
  resetProductRecipesTableCache,
} from './saleRecipeExplosion.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

function readRepo(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

describe('planSaleStockDeduction — inventory × service matrix', () => {
  it('inventory parent without recipe → deduct parent', () => {
    expect(planSaleStockDeduction('inventory', false)).toEqual({ kind: 'parent' });
  });

  it('inventory parent with AT_SALE recipe → deduct ingredients', () => {
    expect(planSaleStockDeduction('inventory', true)).toEqual({ kind: 'ingredients' });
  });

  it('inventory prepared food with production-only BOM (no at-sale explode) → parent', () => {
    // usage_mode AT_PRODUCTION → explodeActiveRecipe returns null → plan gets false
    expect(planSaleStockDeduction('inventory', false)).toEqual({ kind: 'parent' });
  });

  it('consumable parent without recipe → deduct parent', () => {
    expect(planSaleStockDeduction('consumable', false)).toEqual({ kind: 'parent' });
  });

  it('consumable parent with recipe → deduct ingredients', () => {
    expect(planSaleStockDeduction('consumable', true)).toEqual({ kind: 'ingredients' });
  });

  it('service parent without recipe → skip stock (pure service)', () => {
    expect(planSaleStockDeduction('service', false)).toEqual({ kind: 'skip' });
  });

  it('service parent with recipe → deduct ingredients (menu BOM)', () => {
    expect(planSaleStockDeduction('service', true)).toEqual({ kind: 'ingredients' });
  });

  it('defaults unknown/empty type to parent when no recipe', () => {
    expect(planSaleStockDeduction('', false)).toEqual({ kind: 'parent' });
    expect(planSaleStockDeduction('SERVICE', false)).toEqual({ kind: 'skip' });
  });
});

describe('prepareFoodCatalogDefaults', () => {
  it('recommends inventory prepared food + production recipe mode', async () => {
    const { prepareFoodCatalogDefaults } = await import('../../../../shared/utils/productTypeRules.js');
    expect(prepareFoodCatalogDefaults()).toEqual({
      productType: 'inventory',
      isPreparedFood: true,
      recommendedRecipeUsageMode: 'AT_PRODUCTION',
    });
  });
});

describe('explodeActiveRecipe', () => {
  beforeEach(() => {
    resetProductRecipesTableCache();
  });

  it('returns null when product_recipes table is absent (retail unchanged)', async () => {
    const conn = {
      query: jest.fn<() => Promise<{ rows: unknown[] }>>().mockResolvedValue({ rows: [] }),
    };
    const result = await explodeActiveRecipe(conn as any, 'parent-1', new Decimal(2));
    expect(result).toBeNull();
    expect(conn.query).toHaveBeenCalledTimes(1);
  });

  it('returns null when parent has no active recipe lines', async () => {
    const conn = {
      query: jest
        .fn<() => Promise<{ rows: unknown[] }>>()
        .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
        .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
        .mockResolvedValueOnce({ rows: [] }),
    };
    const result = await explodeActiveRecipe(conn as any, 'parent-1', new Decimal(3));
    expect(result).toBeNull();
  });

  it('scales ingredient base qty by sold parent base qty', async () => {
    const conn = {
      query: jest
        .fn<() => Promise<{ rows: unknown[] }>>()
        .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }) // table exists
        .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }) // usage_mode column
        .mockResolvedValueOnce({
          rows: [
            {
              componentProductId: 'flour-id',
              componentName: 'Flour',
              quantityBase: '0.250000',
            },
            {
              componentProductId: 'oil-id',
              componentName: 'Oil',
              quantityBase: '0.020000',
            },
          ],
        }),
    };

    const result = await explodeActiveRecipe(conn as any, 'burger-id', new Decimal(4));
    expect(result).not.toBeNull();
    expect(result!).toHaveLength(2);
    expect(result![0].componentProductId).toBe('flour-id');
    expect(result![0].baseQty.toFixed(6)).toBe('1.000000'); // 4 × 0.25
    expect(result![1].componentProductId).toBe('oil-id');
    expect(result![1].baseQty.toFixed(6)).toBe('0.080000'); // 4 × 0.02
  });

  it('returns null for production-only recipes (no AT_SALE lines)', async () => {
    const conn = {
      query: jest
        .fn<() => Promise<{ rows: unknown[] }>>()
        .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
        .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
        .mockResolvedValueOnce({ rows: [] }), // filtered by usage_mode
    };
    const result = await explodeActiveRecipe(conn as any, 'curry-id', new Decimal(5));
    expect(result).toBeNull();
  });
});

describe('createSale × KOT contract (source)', () => {
  it('salesService uses planSaleStockDeduction for inventory/service branching', () => {
    const sales = readRepo('SamplePOS.Server/src/modules/sales/salesService.ts');
    expect(sales).toMatch(/planSaleStockDeduction/);
    expect(sales).toMatch(/explodeActiveRecipe/);
    expect(sales).toMatch(/Recipe BOM inventory explosion/);
    expect(sales).toMatch(/Skipping inventory deduction for service item/);
  });

  it('sendKot deducts via restaurantKotStockService (not createSale); void restores', () => {
    const service = readRepo(
      'SamplePOS.Server/src/modules/restaurant/restaurantService.ts',
    );
    const sendKotBlock = service.slice(
      service.indexOf('async sendKot('),
      service.indexOf('async voidCheckItems('),
    );
    expect(sendKotBlock.length).toBeGreaterThan(100);
    expect(sendKotBlock).not.toMatch(/createSale/);
    expect(sendKotBlock).toMatch(/issueStockOnRestaurantKot/);
    const voidBlock = service.slice(
      service.indexOf('async voidCheckItems('),
      service.indexOf('async listKitchenBoard('),
    );
    expect(voidBlock).toMatch(/restoreStockOnRestaurantKotVoid/);
    const kotStock = readRepo(
      'SamplePOS.Server/src/modules/restaurant/restaurantKotStockService.ts',
    );
    expect(kotStock).toMatch(/explodeActiveRecipe/);
    expect(kotStock).toMatch(/planSaleStockDeduction/);
  });

  it('recipe upsert rejects service ingredients; allows inventory/service parents', () => {
    const service = readRepo(
      'SamplePOS.Server/src/modules/restaurant/restaurantService.ts',
    );
    expect(service).toMatch(/cannot be a service product/);
    expect(service).toMatch(/one-level BOM only/);
  });
});
