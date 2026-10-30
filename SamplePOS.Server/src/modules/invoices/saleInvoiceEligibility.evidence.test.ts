/**
 * PROOF: sale → invoice eligibility — same rule on every tenant.
 *
 * Run: node --experimental-vm-modules ./node_modules/jest/bin/jest.js src/modules/invoices/saleInvoiceEligibility.evidence.test.ts --no-coverage
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from '@jest/globals';
import {
  invoicePaymentsFromSaleHeader,
  saleIsInvoiceEligible,
  saleRowIsInvoiceEligible,
} from '../../../../shared/domain/saleInvoiceEligibility.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

const evidence: Array<{ name: string; ok: true; detail: Record<string, unknown> }> = [];

function prove(name: string, detail: Record<string, unknown>): void {
  evidence.push({ name, ok: true, detail });
}

describe('Sale invoice eligibility SSOT (executed)', () => {
  it('Henber CREDIT sale is eligible (existing path unchanged)', () => {
    const result = saleIsInvoiceEligible({
      status: 'COMPLETED',
      paymentMethod: 'CREDIT',
      amountPaid: 0,
      totalAmount: 100_000,
      hasCreditTender: true,
    });
    expect(result).toEqual({ ok: true, reason: 'credit' });
    prove('credit-sale-eligible', result);
  });

  it('quote conversion is eligible even when cash is complete', () => {
    const result = saleIsInvoiceEligible({
      status: 'COMPLETED',
      quoteId: 'quote-1',
      paymentMethod: 'CASH',
      amountPaid: 50_000,
      totalAmount: 50_000,
    });
    expect(result).toEqual({ ok: true, reason: 'quote' });
    prove('quote-eligible', result);
  });

  it('CASH underpay (no CREDIT tender) is eligible — same on every tenant', () => {
    const result = saleIsInvoiceEligible({
      status: 'COMPLETED',
      paymentMethod: 'CASH',
      amountPaid: 1_000_000,
      totalAmount: 3_200_000,
      hasCreditTender: false,
    });
    expect(result).toEqual({ ok: true, reason: 'outstanding' });
    prove('cash-underpay-eligible', result);
  });

  it('fully paid CASH is not invoiced', () => {
    const result = saleIsInvoiceEligible({
      status: 'COMPLETED',
      paymentMethod: 'CASH',
      amountPaid: 80_000,
      totalAmount: 80_000,
    });
    expect(result).toEqual({ ok: false, reason: 'fully_paid_cash' });
    prove('fully-paid-cash-blocked', result);
  });

  it('voided / fully returned sale is not invoiced', () => {
    const result = saleIsInvoiceEligible({
      status: 'VOIDED_BY_RETURN',
      paymentMethod: 'CASH',
      amountPaid: 0,
      totalAmount: 3_200_000,
    });
    expect(result).toEqual({ ok: false, reason: 'sale_not_live' });
    prove('voided-by-return-blocked', result);
  });

  it('header amount_paid copies onto invoice when sale_payments is empty', () => {
    const fallback = invoicePaymentsFromSaleHeader({
      amountPaid: 1_000_000,
      paymentMethod: 'CASH',
      hasPaymentLines: false,
    });
    expect(fallback).toEqual({ amount: 1_000_000, method: 'CASH' });
    expect(
      invoicePaymentsFromSaleHeader({
        amountPaid: 1_000_000,
        paymentMethod: 'CASH',
        hasPaymentLines: true,
      }),
    ).toBeNull();
    prove('header-paid-fallback', { fallback, skippedWhenLinesPresent: true });
  });

  it('customer sales picker rows use the same eligibility as the handler', () => {
    const underpay = saleRowIsInvoiceEligible({
      status: 'COMPLETED',
      paymentMethod: 'CASH',
      amountPaid: '1000000',
      totalAmount: '3200000',
    });
    expect(underpay).toEqual({ ok: true, reason: 'outstanding' });
    const credit = saleRowIsInvoiceEligible({
      status: 'COMPLETED',
      payment_method: 'CREDIT',
      amount_paid: 0,
      total_amount: 100000,
    });
    expect(credit.ok).toBe(true);
    prove('picker-rows-same-eligibility', { underpay, credit });
  });

  it('writes evidence artifact', () => {
    expect(evidence.length).toBeGreaterThanOrEqual(6);
    const payload = {
      title: 'PROOF_SALE_INVOICE_ELIGIBILITY_SSOT',
      runAt: new Date().toISOString(),
      verdict: 'PASS',
      identity: {
        quote: 'always',
        credit: 'header or CREDIT tender',
        outstanding: 'amount_paid < charged total',
        blocked: 'fully paid non-credit; voided/returned',
        tenants: 'one rule, every database',
      },
      checks: evidence,
    };
    const json = JSON.stringify(payload, null, 2);
    writeFileSync(path.join(repoRoot, 'PROOF_SALE_INVOICE_ELIGIBILITY_SSOT.json'), json);
    writeFileSync(
      path.join(repoRoot, 'SamplePOS.Server/PROOF_SALE_INVOICE_ELIGIBILITY_SSOT.json'),
      json,
    );
    const md = [
      '# Sale invoice eligibility SSOT',
      '',
      `Run: ${payload.runAt}`,
      '',
      'Verdict: **PASS** — executed eligibility numbers, not tenant-specific branches.',
      '',
      '| Check | Result |',
      '|---|---|',
      ...evidence.map((row) => `| ${row.name} | PASS |`),
      '',
      'CREDIT, quote, and outstanding CASH are eligible on every tenant. Fully paid CASH and voided sales are not.',
      '',
    ].join('\n');
    writeFileSync(path.join(repoRoot, 'PROOF_SALE_INVOICE_ELIGIBILITY_SSOT.md'), md);
    writeFileSync(
      path.join(repoRoot, 'SamplePOS.Server/PROOF_SALE_INVOICE_ELIGIBILITY_SSOT.md'),
      md,
    );
  });
});
