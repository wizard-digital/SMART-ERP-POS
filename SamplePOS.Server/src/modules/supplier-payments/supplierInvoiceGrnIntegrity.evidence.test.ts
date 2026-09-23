/**
 * EVIDENCE: Supplier invoice must not exceed GRN received value.
 * Under-billing allowed only with SUPPLIER_DISCOUNT or ROUNDING_DIFFERENCE.
 *
 * Run: npx vitest run src/modules/supplier-payments/supplierInvoiceGrnIntegrity.evidence.test.ts
 */
import { afterAll, describe, expect, it } from '@jest/globals';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSupplierInvoiceGrnVariance } from './supplierInvoiceGrnValidation.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

type Gate = { id: string; ok: boolean; detail: string };
const gates: Gate[] = [];

function gate(id: string, ok: boolean, detail: string): void {
  gates.push({ id, ok, detail });
  expect({ id, ok, detail }).toEqual({ id, ok: true, detail });
}

function read(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

describe('EVIDENCE — Supplier invoice ≤ GRN integrity', () => {
  it('SSOT validator: over-bill always rejected; under-bill allows discount/rounding only', () => {
    expect(() =>
      validateSupplierInvoiceGrnVariance({
        grnComputedTotal: 50_000,
        invoiceTotal: 60_000,
      }),
    ).toThrow(/cannot exceed goods received/i);

    expect(() =>
      validateSupplierInvoiceGrnVariance({
        grnComputedTotal: 50_000,
        invoiceTotal: 60_000,
        varianceReason: 'PRICE_VARIANCE' as unknown as 'EDIT_LINE_PRICES',
      }),
    ).toThrow(/cannot exceed goods received/i);
    gate('OVER_NO_PV', true, 'over-GRN rejects even with obsolete PRICE_VARIANCE reason');

    expect(() =>
      validateSupplierInvoiceGrnVariance({
        grnComputedTotal: 50_000,
        invoiceTotal: 60_000,
        varianceReason: 'SUPPLIER_DISCOUNT',
      }),
    ).toThrow(/cannot exceed goods received/i);
    gate('OVER_NO_DISCOUNT', true, 'over-GRN rejects SUPPLIER_DISCOUNT');

    expect(() =>
      validateSupplierInvoiceGrnVariance({
        grnComputedTotal: 50_000,
        invoiceTotal: 40_000,
        varianceReason: 'PRICE_VARIANCE' as unknown as 'EDIT_LINE_PRICES',
      }),
    ).toThrow(/Unrecognized variance reason/i);
    gate('UNDER_NO_PV', true, 'under-GRN rejects obsolete PRICE_VARIANCE reason');

    expect(() =>
      validateSupplierInvoiceGrnVariance({
        grnComputedTotal: 136_000.04,
        invoiceTotal: 1_360_000,
        varianceReason: 'ROUNDING_DIFFERENCE',
      }),
    ).toThrow(/digit|zero typo|10×/i);
    gate('DIGIT_SHIFT_10X', true, '≈10× paper rejected as digit typo (Touren-class)');

    expect(() =>
      validateSupplierInvoiceGrnVariance({
        grnComputedTotal: 136_000.04,
        invoiceTotal: 13_600,
        varianceReason: 'SUPPLIER_DISCOUNT',
      }),
    ).toThrow(/digit|zero typo|0\.1×/i);
    gate('DIGIT_SHIFT_01X', true, '≈0.1× paper rejected as digit typo');

    const okDiscount = validateSupplierInvoiceGrnVariance({
      grnComputedTotal: 100_000,
      invoiceTotal: 92_000,
      varianceReason: 'SUPPLIER_DISCOUNT',
    });
    gate(
      'ORDINARY_DISCOUNT_OK',
      okDiscount.hasVariance === true && Math.abs(okDiscount.varianceAmount - 8_000) < 0.01,
      'ordinary under-bill discount still allowed',
    );
  });

  it('Wiring: create / from-grn / post / routes / UI use validator', () => {
    const validation = read(
      'SamplePOS.Server/src/modules/supplier-payments/supplierInvoiceGrnValidation.ts',
    );
    const svc = read('SamplePOS.Server/src/modules/supplier-payments/supplierPaymentService.ts');
    const routes = read('SamplePOS.Server/src/modules/supplier-payments/supplierPaymentRoutes.ts');
    const ui = read('samplepos.client/src/pages/accounting/SupplierPaymentsPage.tsx');
    const grUi = read('samplepos.client/src/pages/inventory/GoodsReceiptsPage.tsx');

    gate(
      'MODULE',
      validation.includes('assertLinkedGrnsReadyForBilling') &&
        validation.includes('validateSupplierInvoiceGrnVariance') &&
        validation.includes('computeGrnBillableTotalFromLines') &&
        validation.includes('cannot exceed goods received value') &&
        validation.includes('isLikelyGrnBillDigitShiftTypo'),
      'validation module enforces GR ready + PricingEngine SSOT + no over-billing AP + digit-shift guard',
    );
    gate(
      'CREATE_WIRE',
      svc.includes('assertLinkedGrnsReadyForBilling') &&
        svc.includes('validateSupplierInvoiceGrnVariance') &&
        /createSupplierInvoice[\s\S]*assertLinkedGrnsReadyForBilling/.test(svc),
      'createSupplierInvoice asserts linked GRs then validates variance',
    );
    gate(
      'FROM_GRN_WIRE',
      svc.includes('createInvoiceFromGRN') &&
        /createInvoiceFromGRN[\s\S]*validateSupplierInvoiceGrnVariance/.test(svc),
      'createInvoiceFromGRN validates supplierReportedTotal',
    );
    gate(
      'POST_WIRE',
      /postInvoiceToGL[\s\S]*validateSupplierInvoiceGrnVariance/.test(svc),
      'postInvoiceToGL re-validates before GL',
    );
    gate(
      'ROUTES',
      routes.includes('/invoices/from-grn') &&
        routes.includes('/grns/:grnId/billable-total') &&
        routes.includes('varianceReason'),
      'API: from-grn + billable-total preview + varianceReason',
    );
    gate(
      'ROUTES_CANCEL',
      routes.includes('/invoices/:id/cancel') &&
        routes.includes("requirePermission('purchasing.cancel_bill')") &&
        svc.includes('cancelSupplierInvoice'),
      'cancel unpaid bill route + service wired',
    );
    gate(
      'BLOCK_BILL_REVERSED_GR',
      svc.includes('receipt was fully reversed') &&
        svc.includes('isReversed') &&
        grUi.includes('Reversed') &&
        grUi.includes('not billable') &&
        grUi.includes('isGrReversed'),
      'UI + from-grn block Create Supplier Bill after reverse',
    );
    gate(
      'FULL_REVERSE_AUTO_CANCEL_BILLS',
      read('SamplePOS.Server/src/modules/goods-receipts/goodsReceiptService.ts').includes(
        'cancelSupplierInvoiceForCorrection',
      ) &&
        read('SamplePOS.Server/src/modules/corrections/correctionEligibilityService.ts').includes(
          'planSupplierBillsForGrFullReverse',
        ) &&
        read('shared/domain/grFullReverseSsot.ts').includes('planSupplierBillsForGrFullReverse') &&
        read('shared/domain/grFullReverseSsot.ts').includes('payments applied') &&
        read('SamplePOS.Server/src/modules/corrections/correctionEligibilityService.ts').includes(
          'getConsumedBatchesForGrn',
        ) &&
        grUi.includes('Reverse Receipt'),
      'Full reverse: unpaid cancel OK; paid + consumed blocked',
    );
    gate(
      'UI_CANCEL_BILL',
      ui.includes('purchasing.cancel_bill') &&
        ui.includes('Cancel bill') &&
        ui.includes('cancelSupplierInvoice'),
      'Supplier Payments cancel bill button gated',
    );
    gate(
      'CANCEL_SSOT',
      svc.includes('supplierBillCancelBlockReason') &&
        svc.includes('findInvoiceCancelContext') &&
        read('shared/utils/supplierBillCancelEligibility.ts').includes('creditsApplied'),
      'Cancel eligibility shared SSOT + server pre-checks',
    );
    gate(
      'UI_BLOCK_MANUAL_GR',
      ui.includes('looks like a goods receipt bill') &&
        ui.includes('Goods Receipts → Create Supplier Bill'),
      'manual bill UI blocks GR-referenced notes',
    );
    gate(
      'UI_FROM_GRN',
      grUi.includes('/supplier-payments/invoices/from-grn') &&
        grUi.includes('/supplier-payments/grns/') &&
        grUi.includes('billable-total') &&
        grUi.includes('supplierReportedTotal') &&
        grUi.includes('billExceedsReceived') &&
        grUi.includes('digitShiftTypo') &&
        grUi.includes('isLikelyGrnBillDigitShiftTypo'),
      'GR billing UI uses server billable total + blocks over-bill + digit-shift typos',
    );
  });

  it('writes PROOF artifacts', () => {
    const failed = gates.filter((g) => !g.ok);
    const evidence = {
      feature: 'SUPPLIER_INVOICE_GRN_BOUNDS',
      provenAt: new Date().toISOString(),
      contract:
        'GR-linked supplier invoices cannot exceed PricingEngine billable total; one SSOT path for validation, billing, GL, and UI preview; linked GRs must be COMPLETED with billable qty',
      gates,
      summary: {
        total: gates.length,
        passed: gates.filter((g) => g.ok).length,
        failed: failed.length,
        verdict: failed.length === 0 ? 'PASS' : 'FAIL',
      },
    };

    const jsonPath = path.join(repoRoot, 'PROOF_SUPPLIER_INVOICE_GRN_BOUNDS.json');
    const mdPath = path.join(repoRoot, 'PROOF_SUPPLIER_INVOICE_GRN_BOUNDS.md');
    writeFileSync(jsonPath, JSON.stringify(evidence, null, 2));
    writeFileSync(
      mdPath,
      [
        '# PROOF — Supplier invoice ≤ GRN received value',
        '',
        `**Verdict:** ${evidence.summary.verdict}`,
        `**Proven at:** ${evidence.provenAt}`,
        '',
        `**Contract:** ${evidence.contract}`,
        '',
        '## Gates',
        '',
        ...gates.map((g) => `- ${g.ok ? 'PASS' : 'FAIL'} \`${g.id}\`: ${g.detail}`),
        '',
        '## Reproduce',
        '',
        '```bash',
        'cd SamplePOS.Server && npm run proof:supplier-invoice-grn-bounds',
        'cd SamplePOS.Server && npx tsx scripts/proof-digit-shift-bill-guard.ts',
        '```',
        '',
      ].join('\n'),
    );

    gate('ARTIFACTS', existsSync(jsonPath) && existsSync(mdPath), 'PROOF json+md written');
    expect(failed).toEqual([]);
  });
});
