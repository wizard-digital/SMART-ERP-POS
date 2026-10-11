/**
 * PROOF: Distribution payment posts via customer invoice AR SSOT.
 * No parallel dist_receipts / recordInvoicePaymentToGL cash lane.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '../../..');
const repoRoot = path.resolve(serverRoot, '..');

const gates: Array<{ id: string; ok: boolean; detail: string }> = [];

function gate(id: string, ok: boolean, detail: string) {
  gates.push({ id, ok, detail });
  expect(ok).toBe(true);
}

describe('PROOF: dist payment AR SSOT', () => {
  beforeAll(() => {
    process.env.DOTENV_CONFIG_PATH = path.join(serverRoot, '.env.test');
  });

  it('processClearing routes through invoiceService.addPayment', () => {
    const svc = readFileSync(
      path.join(serverRoot, 'src/modules/distribution/distService.ts'),
      'utf8',
    );
    const fn = svc.slice(
      svc.indexOf('export async function processClearing'),
      svc.indexOf('export async function getSalesOrder'),
    );
    gate(
      'CLEARING_USES_INVOICE_ADD_PAYMENT',
      fn.includes("import('../invoices/invoiceService.js')") &&
        fn.includes('invoiceService.addPayment') &&
        fn.includes("paymentMethod: 'DEPOSIT'"),
      'deposit + cash via invoiceService.addPayment',
    );
    gate(
      'CLEARING_NO_DIST_RECEIPT_WRITE',
      !fn.includes('createReceipt') &&
        !fn.includes('createDistClearing') &&
        !fn.includes('recordInvoicePaymentToGL') &&
        !fn.includes('recordDownPaymentClearingToGL'),
      'no parallel dist_receipts / dist GL payment helpers',
    );
    gate(
      'CLEARING_HEALS_SETTLEMENT',
      fn.includes('healSettlementDrift') && fn.includes('getInvoiceSettlement'),
      'settlement SSOT before accepting payment',
    );
    gate(
      'CLEARING_POS_TENDER_CHANGE',
      fn.includes('computeInvoiceTender') &&
        fn.includes('changeGiven') &&
        fn.includes('cashApplied'),
      'cash overage capped to due; change returned',
    );
  });

  it('invoice tender helper caps cash like POS', async () => {
    const tenderSrc = readFileSync(
      path.join(serverRoot, 'src/modules/distribution/invoiceTenderChange.ts'),
      'utf8',
    );
    gate(
      'TENDER_HELPER_EXISTS',
      tenderSrc.includes('export function computeInvoiceTender') &&
        tenderSrc.includes("=== 'CASH'"),
      'shared tender math for change',
    );

    const { computeInvoiceTender } = await import('./invoiceTenderChange.js');
    const cashBig = computeInvoiceTender({
      invoiceDue: 2200,
      depositRequested: 0,
      cashTendered: 50000,
      paymentMethod: 'CASH',
    });
    gate(
      'TENDER_CASH_CHANGE',
      cashBig.cashApplied === 2200 && cashBig.changeGiven === 47800 && cashBig.remainingDue === 0,
      '50k cash on 2200 due → take 2200 change 47800',
    );
    const cardBig = computeInvoiceTender({
      invoiceDue: 2200,
      depositRequested: 0,
      cashTendered: 50000,
      paymentMethod: 'CARD',
    });
    gate(
      'TENDER_CARD_NO_CHANGE',
      cardBig.cashApplied === 2200 && cardBig.changeGiven === 0,
      'card over due posts due only, no change',
    );
    const withDep = computeInvoiceTender({
      invoiceDue: 4200,
      depositRequested: 2000,
      cashTendered: 10000,
      paymentMethod: 'CASH',
    });
    gate(
      'TENDER_DEPOSIT_THEN_CASH',
      withDep.depositApplied === 2000 &&
        withDep.cashApplied === 2200 &&
        withDep.changeGiven === 7800,
      'deposit then cash caps at due',
    );

    const svc = readFileSync(
      path.join(serverRoot, 'src/modules/distribution/distService.ts'),
      'utf8',
    );
    const clearing = svc.slice(
      svc.indexOf('export async function processClearing'),
      svc.indexOf('// ─── Read Operations'),
    );
    gate(
      'CLEARING_PARTIAL_CASH_FAIL_SAFE',
      clearing.includes('ERR_DIST_CLR_005') &&
        clearing.includes('Deposit of') &&
        clearing.includes('Retry the cash/card payment only'),
      'deposit+cash: cash failure after deposit is explicit/recoverable',
    );
  });

  it('invoice settlement includes legacy dist rows + invoice_payments', () => {
    const repo = readFileSync(
      path.join(serverRoot, 'src/modules/invoices/invoiceRepository.ts'),
      'utf8',
    );
    const settle = repo.slice(
      repo.indexOf('async getInvoiceSettlement'),
      repo.indexOf('async healSettlementDrift'),
    );
    gate(
      'SETTLEMENT_INVOICE_PAYMENTS',
      settle.includes('invoice_payments') && settle.includes('cash_paid'),
      'cash from invoice_payments',
    );
    gate(
      'SETTLEMENT_LEGACY_DIST',
      settle.includes('dist_receipts') &&
        settle.includes('dist_down_payment_clearings') &&
        settle.includes('legacy_paid'),
      'historical DIN receipts still settle',
    );
  });

  it('DIST_INVOICE is an open AR document type', () => {
    const eng = readFileSync(
      path.join(serverRoot, 'src/modules/customer-payments/arReconciliationEngine.ts'),
      'utf8',
    );
    gate(
      'AR_OPEN_INCLUDES_DIST',
      eng.includes("AR_OPEN_DOCUMENT_TYPES") &&
        eng.includes("'DIST_INVOICE'") &&
        eng.includes('AR_OPEN_DOCUMENT_TYPE_IN_SQL'),
      'open AR includes DIST_INVOICE',
    );
    const invRepo = readFileSync(
      path.join(serverRoot, 'src/modules/invoices/invoiceRepository.ts'),
      'utf8',
    );
    gate(
      'CUSTOMER_LIST_INCLUDES_DIST',
      invRepo.includes('AR_OPEN_DOCUMENT_TYPE_IN_SQL'),
      'customer invoice list uses open AR types',
    );
  });

  it('writes proof artifact', () => {
    const passed = gates.filter((g) => g.ok).length;
    const payload = {
      feature: 'DIST_PAYMENT_AR_SSOT',
      verdict: passed === gates.length ? 'PASS' : 'FAIL',
      passed,
      total: gates.length,
      gates,
      at: new Date().toISOString(),
    };
    for (const dest of [
      path.join(repoRoot, 'PROOF_DIST_PAYMENT_AR_SSOT.json'),
      path.join(serverRoot, 'PROOF_DIST_PAYMENT_AR_SSOT.json'),
    ]) {
      writeFileSync(dest, JSON.stringify(payload, null, 2));
    }
    expect(payload.verdict).toBe('PASS');
  });
});
