/**
 * PROOF (accuracy): Product money spinners step by 1 (not 0.01 / 0.1).
 * Arrows stay; HTML step="1" is the SSOT. Decimals remain typeable.
 *
 * Scenario from Edit Product (Abchlor): cost 200.11, sell 1200.06, rate 8.02.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateProductValues, buildCreateProductInput } from '@/validation/product';
import type { ProductFormValues } from '@/components/products/ProductForm';
import { validateProductPricing } from '@/utils/validation';

const root = resolve(__dirname, '../../..');
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8');

/** Browser spinner: value += step (Chrome/Edge). */
function spin(value: number, step: number, dir: 1 | -1): number {
  return value + dir * step;
}

const masterUoms = [{ id: '11111111-1111-4111-8111-111111111111', name: 'EACH' }];

function inventoryForm(overrides: Partial<ProductFormValues> = {}): ProductFormValues {
  return {
    name: 'Abchlor eye droped',
    sku: 'PRD-MRJ76HE-7L9A',
    barcode: '321450000',
    description: '',
    category: 'ART DRUGS',
    productType: 'inventory',
    genericName: '',
    costPrice: '200.11',
    sellingPrice: '1200.06',
    costingMethod: 'FIFO',
    isTaxable: true,
    taxRate: '8.02',
    pricingFormula: '',
    autoUpdatePrice: false,
    reorderLevel: '10',
    trackExpiry: false,
    minDaysBeforeExpirySale: '0',
    isActive: true,
    availableInRestaurant: false,
    isPreparedFood: false,
    isBuffetCover: false,
    preferredSupplierId: '',
    supplierProductCode: '',
    purchaseUomId: '',
    leadTimeDays: '0',
    reorderQuantity: '0',
    ...overrides,
  };
}

describe('PROOF: ProductForm money spinner step SSOT', () => {
  it('wiring: cost / selling / tax rate keep arrows (type=number) with step="1"', () => {
    const form = read('samplepos.client/src/components/products/ProductForm.tsx');
    expect(form).not.toMatch(/step="0\.01"/);

    for (const id of ['cost-price', 'selling-price', 'tax-rate']) {
      const block = form.match(new RegExp(`id="${id}"[\\s\\S]{0,280}?step="([^"]+)"`));
      expect(block?.[1], `${id} step`).toBe('1');
      expect(form).toMatch(new RegExp(`id="${id}"[\\s\\S]{0,120}?type="number"`));
    }
  });

  it('accuracy: spinner ±1 from Abchlor decimals; typed values still validate', () => {
    const step = 1;
    expect(spin(200.11, step, 1)).toBeCloseTo(201.11, 2);
    expect(spin(1200.06, step, 1)).toBeCloseTo(1201.06, 2);
    expect(spin(8.02, step, 1)).toBeCloseTo(9.02, 2);
    // Old broken step would have been 0.01
    expect(spin(1200.06, 0.01, 1)).toBeCloseTo(1200.07, 2);
    expect(spin(1200.06, 0.01, 1)).not.toBeCloseTo(1201.06, 2);

    const values = inventoryForm();
    const validated = validateProductValues(values, 'update');
    expect(validated.valid, JSON.stringify(validated.errors)).toBe(true);
    if (validated.valid) {
      expect(validated.data.costPrice).toBe(200.11);
      expect(validated.data.sellingPrice).toBe(1200.06);
      expect(validated.data.taxRate).toBe(8.02);
    }

    expect(validateProductPricing(200.11, 1200.06).valid).toBe(true);

    const payload = buildCreateProductInput(values, { masterUoms });
    expect(payload.ok).toBe(true);
    if (payload.ok) {
      expect(payload.data.costPrice).toBe(200.11);
      expect(payload.data.sellingPrice).toBe(1200.06);
      expect(payload.data.taxRate).toBe(8.02);
    }
  });
});
