/**
 * Expense reverse consistency — reports and spend totals must match net-active GL.
 */
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const serverSrc = resolve(here, '..');
const repoRoot = resolve(serverSrc, '../..');

function read(rel: string): string {
  return readFileSync(resolve(rel.startsWith('shared/') ? repoRoot : serverSrc, rel), 'utf8');
}

describe('expense reverse — no mismatch SSOT', () => {
  it('reverse asserts leftover posted GL and net-active residual are empty', () => {
    const svc = read('services/expenseService.ts');
    expect(svc).toContain('ERR_EXPENSE_016');
    expect(svc).toContain('assertExpenseReverseLeavesNoMismatch');
    expect(svc).toContain('LEDGER_NET_ACTIVE_SQL');
    expect(svc).toContain('EXPENSE_LIVE_BANK_GL_SQL');
    expect(svc).toContain('lt."ReferenceType" IN (\'EXPENSE\', \'EXPENSE_PAYMENT\')');
  });

  it('P&L expense queries use LEDGER_NET_ACTIVE not bare POSTED', () => {
    const reports = read('modules/reports/reportsRepository.ts');
    const business = read('repositories/businessReportRepository.ts');
    const reportsExpense = reports.slice(reports.indexOf('Operating expenses from GL'));
    expect(reportsExpense).toContain('LEDGER_NET_ACTIVE_SQL');
    expect(reportsExpense).toContain("lt.\"ReferenceType\" IN ('EXPENSE', 'EXPENSE_PAYMENT')");
    const byAccount = business.slice(business.indexOf('getExpensesByAccount'));
    expect(byAccount).toContain('LEDGER_NET_ACTIVE_SQL');
    expect(byAccount).toContain("lt.\"ReferenceType\" IN ('EXPENSE', 'EXPENSE_PAYMENT')");
    const expenseQuerySlice = business.slice(
      business.indexOf('const expenseQuery'),
      business.indexOf('const stockAdjQuery')
    );
    expect(expenseQuerySlice).toContain('LEDGER_NET_ACTIVE_SQL');
    expect(expenseQuerySlice).not.toContain('lt."Status" = \'POSTED\'');
  });

  it('live spend totals exclude REVERSED while recognized stays APPROVED+PAID', () => {
    const ssot = read('shared/expense/expenseLiveStatusSsot.ts');
    const repo = read('repositories/expenseRepository.ts');
    expect(ssot).toContain("e.status NOT IN ('CANCELLED', 'REVERSED')");
    expect(ssot).toContain("e.status IN ('APPROVED', 'PAID')");
    expect(repo).toContain('EXPENSE_NOT_VOID_SQL');
    expect(repo).toContain('EXPENSE_RECOGNIZED_SQL');
    expect(repo).toContain('payment_account_id = NULL');
    expect(repo).toContain('reversed_count');
  });
});
