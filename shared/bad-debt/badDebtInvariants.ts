/**
 * Bad Debt (AR Write-off) invariants (ADR-006) — contractual domain rules.
 */

import {
  roundMoney,
  AR_CONTROL_ACCOUNT,
  BAD_DEBT_EXPENSE_ACCOUNT,
  isInventoryLossAccount,
  isSalesReturnsAccount,
  AR_WRITEOFF_POSTING_SOURCE,
  AR_WRITEOFF_REVERSAL_POSTING_SOURCE,
} from './badDebtTypes.js';

export class BadDebtInvariantError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'BadDebtInvariantError';
  }
}

/** BD-INV-2: write-off cannot exceed open residual. */
export function assertWriteoffCeiling(input: {
  writeoffAmount: number;
  openResidual: number;
  epsilon?: number;
}): void {
  const eps = input.epsilon ?? 0.01;
  const amount = roundMoney(input.writeoffAmount);
  const residual = roundMoney(input.openResidual);
  if (amount <= 0) {
    throw new BadDebtInvariantError(
      'Bad debt write-off amount must be positive (BD-INV-2)',
      'BD_INV_2_CEILING',
    );
  }
  if (amount - residual > eps) {
    throw new BadDebtInvariantError(
      `Write-off ${amount} exceeds open residual ${residual} (BD-INV-2)`,
      'BD_INV_2_CEILING',
    );
  }
}

/** BD-INV-9 / BD-INV-5: expense must be Bad Debt; never 4010 or inventory loss. */
export function assertBadDebtExpenseAccount(input: { expenseAccountCode: string }): void {
  const code = input.expenseAccountCode?.trim();
  if (!code) {
    throw new BadDebtInvariantError(
      'Bad debt expense account is required (BD-INV-9)',
      'BD_INV_9_EXPENSE_ACCOUNT',
    );
  }
  if (isSalesReturnsAccount(code)) {
    throw new BadDebtInvariantError(
      `Bad debt must not post to Sales Returns ${code} — use credit notes for commercial corrections (BD-INV-4/9)`,
      'BD_INV_9_EXPENSE_ACCOUNT',
    );
  }
  if (isInventoryLossAccount(code)) {
    throw new BadDebtInvariantError(
      `Bad debt must not post to inventory loss account ${code} (BD-INV-5)`,
      'BD_INV_5_INVENTORY_LOSS',
    );
  }
  if (code === '6900') {
    throw new BadDebtInvariantError(
      'Bad debt must not default to General Expense 6900 — use 5210 (BD-INV-9)',
      'BD_INV_9_EXPENSE_ACCOUNT',
    );
  }
}

/** BD-INV-1 shape: net CR 1200 and net DR expense. */
export function assertWriteoffJournalShape(input: {
  lines: Array<{ accountCode: string; debitAmount: number; creditAmount: number }>;
  expenseAccountCode?: string;
}): void {
  const expense = input.expenseAccountCode?.trim() || BAD_DEBT_EXPENSE_ACCOUNT;
  const creditAr = input.lines
    .filter((l) => l.accountCode === AR_CONTROL_ACCOUNT)
    .reduce((s, l) => s + Number(l.creditAmount || 0) - Number(l.debitAmount || 0), 0);
  const debitExpense = input.lines
    .filter((l) => l.accountCode === expense)
    .reduce((s, l) => s + Number(l.debitAmount || 0) - Number(l.creditAmount || 0), 0);

  if (roundMoney(creditAr) <= 0) {
    throw new BadDebtInvariantError(
      `AR write-off must credit Accounts Receivable ${AR_CONTROL_ACCOUNT} (BD-INV-1)`,
      'BD_INV_1_NO_AR_CREDIT',
    );
  }
  if (roundMoney(debitExpense) <= 0) {
    throw new BadDebtInvariantError(
      `AR write-off must debit Bad Debt Expense ${expense} (BD-INV-1)`,
      'BD_INV_1_NO_EXPENSE_DEBIT',
    );
  }
  if (Math.abs(roundMoney(creditAr) - roundMoney(debitExpense)) > 0.01) {
    throw new BadDebtInvariantError(
      `AR write-off AR credit ${creditAr} must equal expense debit ${debitExpense} (BD-INV-1)`,
      'BD_INV_1_UNBALANCED_SHAPE',
    );
  }

  for (const line of input.lines) {
    if (isInventoryLossAccount(line.accountCode) || isSalesReturnsAccount(line.accountCode)) {
      throw new BadDebtInvariantError(
        `AR write-off must not touch account ${line.accountCode} (BD-INV-4/5)`,
        'BD_INV_4_5_FORBIDDEN_ACCOUNT',
      );
    }
  }
}

/** BD-INV-4: posting source must be AR write-off family, not SALES_REFUND / etc. */
export function assertArWriteoffPostingSource(source: string): void {
  if (
    source !== AR_WRITEOFF_POSTING_SOURCE &&
    source !== AR_WRITEOFF_REVERSAL_POSTING_SOURCE
  ) {
    throw new BadDebtInvariantError(
      `AR write-off journals must use ${AR_WRITEOFF_POSTING_SOURCE} (or reversal), not ${source} (BD-INV-4)`,
      'BD_INV_4_POSTING_SOURCE',
    );
  }
}

/**
 * Phrases that map a commercial credit note onto uncollectible write-off intent (BD-INV-4).
 * Operators must use Bad Debt Write-off (5210), not Sales Returns (4010).
 */
export const CREDIT_NOTE_BAD_DEBT_REASON_PATTERN =
  /\b(bad[\s_-]*debt|uncollectible|write[\s_-]*off|writeoff|bankrupt(cy)?|cannot\s+collect|could\s+not\s+collect|refused\s+to\s+pay|unrecoverable)\b/i;

/** BD-INV-4: reject CN/DN reasons that attempt uncollectible recognition via 4010. */
export function assertCreditNoteReasonNotBadDebt(reason: string | null | undefined): void {
  const text = (reason ?? '').trim();
  if (!text) return;
  if (CREDIT_NOTE_BAD_DEBT_REASON_PATTERN.test(text)) {
    throw new BadDebtInvariantError(
      'Credit notes cannot record uncollectible / bad debt / write-off — use Bad Debt Write-off (DR 5210 / CR 1200) instead (BD-INV-4)',
      'BD_INV_4_CN_REASON',
    );
  }
}
