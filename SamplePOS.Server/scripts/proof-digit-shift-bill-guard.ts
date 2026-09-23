#!/usr/bin/env npx tsx
import { validateSupplierInvoiceGrnVariance } from '../src/modules/supplier-payments/supplierInvoiceGrnValidation.ts';
import { isLikelyGrnBillDigitShiftTypo } from '../../shared/domain/grnBillPromptSsot.ts';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL ${msg}`);
  console.log(`PASS ${msg}`);
}

assert(isLikelyGrnBillDigitShiftTypo(136_000.04, 1_360_000), '10x digit shift detected');
assert(isLikelyGrnBillDigitShiftTypo(136_000.04, 13_600), '0.1x digit shift detected');
assert(!isLikelyGrnBillDigitShiftTypo(100_000, 85_000), 'ordinary 15% discount not flagged');

let threw = false;
try {
  validateSupplierInvoiceGrnVariance({
    grnComputedTotal: 136_000.04,
    invoiceTotal: 1_360_000,
    varianceReason: 'ROUNDING_DIFFERENCE',
  });
} catch (e) {
  threw = /digit|zero typo|10×/i.test((e as Error).message);
}
assert(threw, 'validator rejects Touren-class 10x paper');

threw = false;
try {
  validateSupplierInvoiceGrnVariance({
    grnComputedTotal: 136_000.04,
    invoiceTotal: 13_600,
    varianceReason: 'SUPPLIER_DISCOUNT',
  });
} catch (e) {
  threw = /digit|zero typo|0\.1×/i.test((e as Error).message);
}
assert(threw, 'validator rejects 0.1x under-bill disguise');

const r = validateSupplierInvoiceGrnVariance({
  grnComputedTotal: 100_000,
  invoiceTotal: 92_000,
  varianceReason: 'SUPPLIER_DISCOUNT',
});
assert(r.hasVariance && Math.abs(r.varianceAmount - 8_000) < 0.01, 'ordinary discount still allowed');

console.log('ALL OK');
