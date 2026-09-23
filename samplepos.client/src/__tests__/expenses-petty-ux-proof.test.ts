/**
 * Proof: Expenses vs Petty Cash UX fixes (P0/P1).
 * Run: npx vitest run src/__tests__/expenses-petty-ux-proof.test.ts
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');

function readSrc(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

describe('Expenses vs Petty Cash — UX fix proof', () => {
  it('register cash-out renames petty spend away from “expense voucher” language', () => {
    const dialog = readSrc('components/cash-register/CashMovementDialog.tsx');
    expect(dialog).toContain("label: 'Spend from petty float'");
    expect(dialog).toContain('Accounting → Expenses');
    expect(dialog).not.toContain("label: 'Petty Cash Expense'");
  });

  it('Create Expense hides Paid-at-create and forces unpaid', () => {
    const form = readSrc('components/expenses/CreateExpenseForm.tsx');
    expect(form).not.toContain('<SelectItem value="PAID">Paid</SelectItem>');
    expect(form).not.toContain('Pay From Account');
    expect(form).toContain("paymentStatus: 'UNPAID'");
    expect(form).toContain('paymentAccountId: null');
    expect(form).toContain('petty cash float');
    expect(form).toContain('Create expense voucher');
  });

  it('Expenses and Petty pages clarify which path to use', () => {
    const expenses = readSrc('pages/accounting/ExpensesPage.tsx');
    expect(expenses).toContain('expense vouchers for approval');
    expect(expenses).toContain('Banking → Petty cash');

    const petty = readSrc('pages/accounting/PettyCashPage.tsx');
    expect(petty).toContain('Accounting → Expenses');
    expect(petty).toContain('Spend from float (not an Expense voucher)');

    const layout = readSrc('components/AccountingLayout.tsx');
    expect(layout).toContain('Expense vouchers — approve, then pay from bank');
  });

  it('ExpensesPage can reverse posted vouchers via AccountingCore reverse path', () => {
    const expenses = readSrc('pages/accounting/ExpensesPage.tsx');
    expect(expenses).toContain('useReverseExpense');
    expect(expenses).toContain('Confirm Reverse');
    expect(expenses).toContain("selectedExpense.status === 'PAID'");
    const hook = readSrc('hooks/useExpenses.ts');
    expect(hook).toContain('/expenses/${id}/reverse');
  });
});
