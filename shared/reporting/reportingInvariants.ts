/**
 * Reporting invariants (ADR-007) — contractual rules for Phase 5A+.
 */

import { FINANCIAL_PNL_FUNCTIONS } from './reportingTypes.js';

export class ReportingInvariantError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'ReportingInvariantError';
  }
}

/** RP-INV-1: SQL/text must reference a financial P&L function. */
export function assertUsesFinancialPnlFunction(sourceText: string): void {
  const hit = FINANCIAL_PNL_FUNCTIONS.some((fn) => sourceText.includes(fn));
  if (!hit) {
    throw new ReportingInvariantError(
      'Financial P&L consumer must call fn_get_profit_loss* (RP-INV-1)',
      'RP_INV_1_PNL_SSOT',
    );
  }
}

/** RP-INV-4: flag gl_period_balances P&L as legacy dual path. */
export function isLegacyPeriodBalancePnl(sourceText: string): boolean {
  return (
    sourceText.includes('gl_period_balances') &&
    (sourceText.includes('getProfitLossReport') || sourceText.includes('Profit & Loss'))
  );
}

/**
 * P&L section (same precedence as fn_get_profit_loss after 644).
 * 4xxx/REVENUE → REVENUE; 5210 Bad Debt → OpEx; other 5xxx → COGS; else OpEx.
 */
export function classifyFinancialPnlSection(
  accountCode: string,
  accountType?: string,
): 'REVENUE' | 'COST_OF_GOODS_SOLD' | 'OPERATING_EXPENSES' {
  const code = (accountCode ?? '').trim();
  const type = (accountType ?? '').trim().toUpperCase();
  if (code.startsWith('4') || type === 'REVENUE') return 'REVENUE';
  if (code === '5210') return 'OPERATING_EXPENSES';
  if (code.startsWith('5')) return 'COST_OF_GOODS_SOLD';
  return 'OPERATING_EXPENSES';
}

/** RP-INV-8: inventory loss (COGS) + bad debt (OpEx) must still hit P&L, never revenue. */
export const DOMAIN_PNL_EXPENSE_ACCOUNTS = ['5110', '5120', '5130', '5140', '5210'] as const;

/** GL reference types that feed operating-expense lines on reports P&L / expenses-by-account. */
export const PNL_GL_EXPENSE_REFERENCE_TYPES_SQL =
  `'EXPENSE', 'EXPENSE_PAYMENT', 'AR_WRITEOFF', 'AR_WRITEOFF_REVERSAL'` as const;

/** RP-INV-9: commercial CN contra-revenue — never the uncollectible recognition account. */
export const SALES_RETURNS_ACCOUNT = '4010' as const;

export function assertDomainExpenseHitsPnl(accountCode: string): void {
  const section = classifyFinancialPnlSection(accountCode, 'EXPENSE');
  if (section === 'REVENUE') {
    throw new ReportingInvariantError(
      `Domain expense ${accountCode} must not classify as REVENUE (RP-INV-8/9)`,
      'RP_INV_8_DOMAIN_EXPENSE',
    );
  }
  if (!(DOMAIN_PNL_EXPENSE_ACCOUNTS as readonly string[]).includes(accountCode)) {
    throw new ReportingInvariantError(
      `Unknown domain expense account ${accountCode} (RP-INV-8)`,
      'RP_INV_8_DOMAIN_EXPENSE',
    );
  }
}

export function assertBadDebtNotSalesReturns(expenseAccountCode: string): void {
  if (expenseAccountCode === SALES_RETURNS_ACCOUNT) {
    throw new ReportingInvariantError(
      'Bad debt must not use Sales Returns 4010 (RP-INV-9)',
      'RP_INV_9_BAD_DEBT_VS_CN',
    );
  }
}
