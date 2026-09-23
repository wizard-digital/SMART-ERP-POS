/**
 * Till AR collection SSOT — one event, one GL, till cash only.
 *
 * Run: npx jest src/modules/cash-register/tillArReceiptSsot.evidence.test.ts --runInBand
 */
import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

describe('Till AR receipt SSOT', () => {
  const svc = read('src/modules/cash-register/cashRegisterService.ts');
  const repo = read('src/modules/cash-register/cashRegisterRepository.ts');
  const routes = read('src/modules/cash-register/cashRegisterRoutes.ts');
  const gl = read('src/services/glEntryService.ts');
  const gov = read('src/services/postingGovernanceService.ts');
  const settle = read('src/modules/treasury/receiptSettlementRepository.ts');
  const sales = read('src/modules/sales/salesService.ts');

  it('CASH_IN_PAYMENT posts AR + 1010 in one path and never a second movement GL', () => {
    expect(svc).toMatch(/recordTillArPayment/);
    expect(svc).toMatch(/fundsAccountCode:\s*'1010'/);
    expect(svc).toMatch(/referenceType:\s*'AR_PAYMENT'/);
    expect(svc).toMatch(/movementType === 'CASH_IN_PAYMENT'/);
    const tillFn = svc.slice(svc.indexOf('async recordTillArPayment'), svc.indexOf('async recordSaleMovement'));
    expect(tillFn).not.toMatch(/createMovementGLEntry/);
    expect(tillFn).toMatch(/createCustomerPayment/);
  });

  it('office receipts stay 1015; till receipts use TILL_RECEIPT / 1010', () => {
    expect(gl).toMatch(/fundsAccountCode\?: '1010' \| '1015'/);
    expect(gl).toMatch(/tillCash \? \(\s*'TILL_RECEIPT'/);
    expect(gl).toMatch(/tillCash \? AccountCodes\.CASH : AccountCodes\.UNDEPOSITED_FUNDS/);
    expect(gov).toMatch(/\| 'TILL_RECEIPT'/);
    expect(gov).toMatch(/GOV_RULE_E_TILL_RECEIPT_STRUCTURE/);
    expect(gov).toMatch(/source === 'TILL_RECEIPT'/);
  });

  it('CASH_IN_PAYMENT requires customerId and invoiceId at the API', () => {
    expect(routes).toMatch(/movementType === 'CASH_IN_PAYMENT'/);
    expect(routes).toMatch(/Customer Payment requires customerId/);
    expect(routes).toMatch(/Customer Payment requires invoiceId/);
  });

  it('petty CASH_OUT_EXPENSE is excluded from till expected and credits 1012 not 1010', () => {
    const expectedFn = repo.slice(
      repo.indexOf('async calculateExpectedClosing'),
      repo.indexOf('async closeSession'),
    );
    expect(expectedFn).toMatch(/CASH_OUT_BANK/);
    expect(expectedFn).not.toMatch(/CASH_OUT_EXPENSE/);
    expect(svc).toMatch(/accountCode: ACCOUNT_CODES\.PETTY_CASH/);
    const expenseCase = svc.slice(svc.indexOf("case 'CASH_OUT_EXPENSE'"), svc.indexOf("case 'CASH_OUT_OTHER'"));
    expect(expenseCase).not.toMatch(/ACCOUNT_CODES\.CASH,/);
  });

  it('only CASH refunds decrement the till drawer', () => {
    expect(sales).toMatch(/refundType === 'REFUND'\s*&& isCashPayment/);
    expect(sales).not.toMatch(/isCashPayment \|\| isMobilePayment/);
    expect(sales).toMatch(/payoutMethod === 'CASH'/);
  });

  it('deposit worksheet does not pick till receipts that never debited 1015', () => {
    expect(settle).toMatch(/a\."AccountCode" = '1015'/);
    expect(settle).toMatch(/lt\."ReferenceType" = 'CUSTOMER_PAYMENT'/);
  });
});
