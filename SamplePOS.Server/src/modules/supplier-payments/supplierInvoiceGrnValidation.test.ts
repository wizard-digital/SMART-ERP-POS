import { describe, expect, it } from '@jest/globals';
import {
  computeGrnBillableTotalFromLines,
  validateSupplierInvoiceGrnVariance,
} from './supplierInvoiceGrnValidation.js';

describe('computeGrnBillableTotalFromLines (PricingEngine SSOT)', () => {
  it('rounds each line to 4dp then document total to 2dp', () => {
    const total = computeGrnBillableTotalFromLines([
      { quantity: 1, unitCost: 33.3333 },
      { quantity: 1, unitCost: 33.3333 },
      { quantity: 1, unitCost: 33.3334 },
    ]);
    expect(total.toNumber()).toBe(100);
  });

  it('excludes bonus lines from billable total', () => {
    const total = computeGrnBillableTotalFromLines([
      { quantity: 10, unitCost: 5000, isBonus: false },
      { quantity: 2, unitCost: 5000, isBonus: true },
    ]);
    expect(total.toNumber()).toBe(50_000);
  });
});

describe('validateSupplierInvoiceGrnVariance', () => {
  it('allows exact match without variance reason', () => {
    const r = validateSupplierInvoiceGrnVariance({
      grnComputedTotal: 100_000,
      invoiceTotal: 100_000,
    });
    expect(r.hasVariance).toBe(false);
  });

  it('allows half-cent noise within tolerance', () => {
    const r = validateSupplierInvoiceGrnVariance({
      grnComputedTotal: 100_000,
      invoiceTotal: 100_000.004,
    });
    expect(r.hasVariance).toBe(false);
  });

  it('hard-rejects over-GRN bill even with obsolete PRICE_VARIANCE reason', () => {
    expect(() =>
      validateSupplierInvoiceGrnVariance({
        grnComputedTotal: 100_000,
        invoiceTotal: 120_000,
        varianceReason: 'PRICE_VARIANCE' as unknown as 'EDIT_LINE_PRICES',
      }),
    ).toThrow(/cannot exceed goods received value/i);
  });

  it('hard-rejects over-GRN bill without variance reason', () => {
    expect(() =>
      validateSupplierInvoiceGrnVariance({
        grnComputedTotal: 200_000,
        invoiceTotal: 250_000,
      }),
    ).toThrow(/cannot exceed goods received value/i);
  });

  it('rejects SUPPLIER_DISCOUNT when bill exceeds GRN', () => {
    expect(() =>
      validateSupplierInvoiceGrnVariance({
        grnComputedTotal: 100_000,
        invoiceTotal: 120_000,
        varianceReason: 'SUPPLIER_DISCOUNT',
      }),
    ).toThrow(/cannot exceed goods received value/i);
  });

  it('rejects ROUNDING_DIFFERENCE when bill exceeds GRN', () => {
    expect(() =>
      validateSupplierInvoiceGrnVariance({
        grnComputedTotal: 100_000,
        invoiceTotal: 100_050,
        varianceReason: 'ROUNDING_DIFFERENCE',
      }),
    ).toThrow(/cannot exceed goods received value/i);
  });

  it('allows under-GRN bill with SUPPLIER_DISCOUNT', () => {
    const r = validateSupplierInvoiceGrnVariance({
      grnComputedTotal: 100_000,
      invoiceTotal: 95_000,
      varianceReason: 'SUPPLIER_DISCOUNT',
    });
    expect(r.hasVariance).toBe(true);
    expect(r.varianceAmount).toBe(5_000);
  });

  it('allows under-GRN bill with ROUNDING_DIFFERENCE when |diff| ≤ 1', () => {
    const r = validateSupplierInvoiceGrnVariance({
      grnComputedTotal: 100_000,
      invoiceTotal: 99_999,
      varianceReason: 'ROUNDING_DIFFERENCE',
    });
    expect(r.hasVariance).toBe(true);
    expect(r.normalizedReason).toBe('ROUNDING_DIFFERENCE');
  });

  it('rejects ROUNDING_DIFFERENCE when |diff| > 1', () => {
    expect(() =>
      validateSupplierInvoiceGrnVariance({
        grnComputedTotal: 100_000,
        invoiceTotal: 99_980,
        varianceReason: 'ROUNDING_DIFFERENCE',
      }),
    ).toThrow(/ROUNDING_DIFFERENCE only allowed/i);
  });

  it('rejects EDIT_LINE_PRICES when bill exceeds GRN', () => {
    expect(() =>
      validateSupplierInvoiceGrnVariance({
        grnComputedTotal: 100_000,
        invoiceTotal: 120_000,
        varianceReason: 'EDIT_LINE_PRICES',
      }),
    ).toThrow(/cannot exceed goods received value/i);
  });

  it('blocks under-GRN bill without reason', () => {
    expect(() =>
      validateSupplierInvoiceGrnVariance({
        grnComputedTotal: 100_000,
        invoiceTotal: 90_000,
      }),
    ).toThrow(/differs from goods received value/i);
  });

  it('rejects ~10× paper total as digit-shift typo (even with SUPPLIER_DISCOUNT)', () => {
    expect(() =>
      validateSupplierInvoiceGrnVariance({
        grnComputedTotal: 136_000.04,
        invoiceTotal: 1_360_000,
        varianceReason: 'SUPPLIER_DISCOUNT',
      }),
    ).toThrow(/digit|zero typo|10×/i);
  });

  it('rejects ~0.1× paper total as digit-shift typo (even with SUPPLIER_DISCOUNT)', () => {
    expect(() =>
      validateSupplierInvoiceGrnVariance({
        grnComputedTotal: 136_000.04,
        invoiceTotal: 13_600,
        varianceReason: 'SUPPLIER_DISCOUNT',
      }),
    ).toThrow(/digit|zero typo|0\.1×/i);
  });

  it('still allows ordinary supplier discounts (not near 10× / 0.1×)', () => {
    const r = validateSupplierInvoiceGrnVariance({
      grnComputedTotal: 100_000,
      invoiceTotal: 85_000,
      varianceReason: 'SUPPLIER_DISCOUNT',
    });
    expect(r.hasVariance).toBe(true);
    expect(r.varianceAmount).toBe(15_000);
  });
});
