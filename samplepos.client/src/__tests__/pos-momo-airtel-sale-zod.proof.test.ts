/**
 * PROOF: POS sale Zod accepts MTN MoMo (MOBILE_MONEY) and Airtel Money (AIRTEL_MONEY).
 * UI sends those codes; client Zod must not block before the API (Bliss/Dynamics regression).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { POSSaleSchema } from '@shared/zod/pos-sale';

const root = resolve(__dirname, '../..');

function baseSale(paymentMethod: 'MOBILE_MONEY' | 'AIRTEL_MONEY') {
  return {
    lineItems: [
      {
        productId: '11111111-1111-4111-8111-111111111111',
        productName: 'Test SKU',
        sku: 'T1',
        uom: 'EACH',
        quantity: 1,
        unitPrice: 570000,
        costPrice: 100000,
        subtotal: 570000,
      },
    ],
    subtotal: 570000,
    taxAmount: 0,
    totalAmount: 570000,
    paymentLines: [{ paymentMethod, amount: 570000, reference: 'REF-1' }],
    idempotencyKey: 'pos_test_momo_1',
  };
}

describe('PROOF: POS MoMo / Airtel payment method Zod SSOT', () => {
  it('POSSaleSchema accepts MOBILE_MONEY (MTN MoMo)', () => {
    const r = POSSaleSchema.safeParse(baseSale('MOBILE_MONEY'));
    expect(r.success, JSON.stringify(r.success ? null : r.error)).toBe(true);
  });

  it('POSSaleSchema accepts AIRTEL_MONEY (was Invalid input / VALIDATION STOPPED SALE)', () => {
    const r = POSSaleSchema.safeParse(baseSale('AIRTEL_MONEY'));
    expect(r.success, JSON.stringify(r.success ? null : r.error)).toBe(true);
  });

  it('POS UI buttons emit MOBILE_MONEY and AIRTEL_MONEY', () => {
    const page = readFileSync(resolve(root, 'src/pages/pos/POSPage.tsx'), 'utf8');
    expect(page).toContain("setPaymentMethod('MOBILE_MONEY')");
    expect(page).toContain("setPaymentMethod('AIRTEL_MONEY')");
    expect(page).toContain('MTN MoMo');
    expect(page).toContain('Airtel Money');
  });

  it('shared Zod SSOT lists AIRTEL_MONEY next to MOBILE_MONEY', () => {
    const zod = readFileSync(resolve(root, '../shared/zod/pos-sale.ts'), 'utf8');
    expect(zod).toMatch(/paymentMethod:\s*z\.enum\(\[[^\]]*AIRTEL_MONEY/);
    expect(zod).toMatch(/MOBILE_MONEY/);
  });
});
