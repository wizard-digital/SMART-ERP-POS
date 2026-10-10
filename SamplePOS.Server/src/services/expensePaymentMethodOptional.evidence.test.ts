/**
 * PROOF: Expense prepare must not require payment method.
 * Method is settlement metadata derived at mark-paid from pay-from account.
 */
import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CreateExpenseSchema } from '../../../shared/zod/expense.js';
import { paymentMethodFromLiquidityAccount } from './expenseService.js';

const root = join(process.cwd(), '..');

describe('Expense payment method optional at prepare', () => {
  it('CreateExpenseSchema accepts unpaid voucher without paymentMethod', () => {
    const parsed = CreateExpenseSchema.parse({
      title: 'Office stationery',
      amount: 25000,
      expenseDate: '2026-10-10',
      category: 'OFFICE',
    });
    expect(parsed.paymentMethod).toBeUndefined();
    expect(parsed.paymentStatus).toBe('UNPAID');
  });

  it('create form does not collect payment method', () => {
    const form = readFileSync(
      join(root, 'samplepos.client/src/components/expenses/CreateExpenseForm.tsx'),
      'utf8'
    );
    expect(form).not.toMatch(/Payment Method \*/);
    expect(form).not.toMatch(/name="paymentMethod"/);
    expect(form).not.toMatch(/PAYMENT_METHODS/);
  });

  it('migration 635 drops NOT NULL on expenses.payment_method', () => {
    const sql = readFileSync(
      join(root, 'shared/sql/635_expense_payment_method_optional.sql'),
      'utf8'
    );
    expect(sql).toMatch(/ALTER COLUMN payment_method DROP NOT NULL/);
  });

  it('mark-paid derives and stores payment_method from liquidity account', () => {
    const svc = readFileSync(join(process.cwd(), 'src/services/expenseService.ts'), 'utf8');
    const markPaid = svc.slice(
      svc.indexOf('export const markExpensePaid'),
      svc.indexOf('const EXPENSE_LIVE_JOURNAL_SQL')
    );
    expect(markPaid).toContain('paymentMethodFromLiquidityAccount');
    expect(markPaid).toContain('payment_method: resolvedPaymentMethod');
    expect(markPaid).toContain('resolvedPaymentMethod');
  });

  it('paymentMethodFromLiquidityAccount maps cash / momo / bank', () => {
    expect(paymentMethodFromLiquidityAccount('1010', 'CASH')).toBe('CASH');
    expect(paymentMethodFromLiquidityAccount('1012', 'PETTY_CASH')).toBe('CASH');
    expect(paymentMethodFromLiquidityAccount('1040', 'MOBILE_MONEY')).toBe('MOBILE_MONEY');
    expect(paymentMethodFromLiquidityAccount('1030', null)).toBe('BANK_TRANSFER');
    expect(paymentMethodFromLiquidityAccount('1020', 'CARD')).toBe('CARD');
  });
});
