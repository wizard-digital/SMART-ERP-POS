/**
 * Expense voucher statuses that still hit P&L / AP / cash.
 * REVERSED and CANCELLED are off-books — they must not inflate spend totals.
 */
export const EXPENSE_RECOGNIZED_STATUSES = ['APPROVED', 'PAID'] as const;

export const EXPENSE_VOID_STATUSES = ['CANCELLED', 'REVERSED'] as const;

/** SQL: recognized spend (table alias `e`). */
export const EXPENSE_RECOGNIZED_SQL = `e.status IN ('APPROVED', 'PAID')`;

/** SQL: live voucher money set — cancelled and reversed excluded. */
export const EXPENSE_NOT_VOID_SQL = `e.status NOT IN ('CANCELLED', 'REVERSED')`;

export const expenseNotVoidSql = (alias = 'e'): string =>
  `${alias}.status NOT IN ('CANCELLED', 'REVERSED')`;
