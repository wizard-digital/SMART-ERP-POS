/**
 * PROOF: Mark expense paid from Mobile Money must not pass categoryId as contraAccountId.
 * Screenshot: "Contra account <category-uuid> not found" when paying from MoMo.
 */
import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool, QueryResult } from 'pg';

const root = process.cwd();

function qResult(rows: unknown[]): QueryResult {
  return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] } as QueryResult;
}

describe('Expense mark-paid MoMo — no categoryId as contra', () => {
  it('markExpensePaid links bank mirror to EXPENSE_PAYMENT GL with paymentAccountCode', () => {
    const svc = readFileSync(join(root, 'src/services/expenseService.ts'), 'utf8');
    const markPaid = svc.slice(
      svc.indexOf('export const markExpensePaid'),
      svc.indexOf('const EXPENSE_LIVE_JOURNAL_SQL'),
    );
    expect(markPaid).toContain('existingGlTransactionId');
    expect(markPaid).toContain('paymentAccountCode');
    expect(markPaid).toContain("ReferenceType\" = 'EXPENSE_PAYMENT'");
    expect(markPaid).not.toContain('existingExpense.categoryId || undefined');
  });

  it('createFromExpense never uses expenseAccountId/categoryId as contra', () => {
    const banking = readFileSync(join(root, 'src/services/bankingService.ts'), 'utf8');
    const createFromExpense = banking.slice(
      banking.indexOf('static async createFromExpense'),
      banking.indexOf('// ---------------------------------------------------------------------------\n    // STATEMENT IMPORT'),
    );
    expect(createFromExpense).toContain('existingGlTransactionId');
    expect(createFromExpense).toContain('paymentAccountCode');
    expect(createFromExpense).toContain("ensureDepositLiquidityBook(pool, 'MOBILE_MONEY')");
    expect(createFromExpense).toContain("'1040'");
    expect(createFromExpense).not.toContain('contraAccountId: expenseAccountId');
    expect(createFromExpense).toContain('skipping to avoid double GL');
  });

  it('schema 625 ensures EXPENSE_PAYMENT on MoMo liquidity (1040)', () => {
    const sql = readFileSync(join(root, '..', 'shared', 'sql', '625_momo_airtel_payment_ssot.sql'), 'utf8');
    expect(sql).toContain('EXPENSE_PAYMENT');
    expect(sql).toContain("'1040'");
  });
});

describe('BankingService.createFromExpense MoMo mirror (executed)', () => {
  const mockQuery = jest.fn<(...args: unknown[]) => Promise<QueryResult>>();

  beforeEach(() => {
    jest.resetModules();
    mockQuery.mockReset();
  });

  it('inserts WITHDRAWAL linked to existing GL for 1040 without createTransaction', async () => {
    const mockPool = { query: mockQuery } as unknown as Pool;

    jest.unstable_mockModule('../db/pool.js', () => ({ pool: mockPool }));
    jest.unstable_mockModule('../utils/logger.js', () => ({
      default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    }));
    const ensure = jest.fn(async () => ({
      bankAccountId: 'ba-1040',
      glAccountId: 'gl-1040',
      glAccountCode: '1040',
      glAccountName: 'Mobile Money',
      name: 'Mobile Money',
      kind: 'MOBILE_MONEY',
    }));
    jest.unstable_mockModule('../modules/treasury/ensureDepositLiquidityBook.js', () => ({
      ensureDepositLiquidityBook: ensure,
    }));

    const { BankingService } = await import('./bankingService.js');
    const createTxnSpy = jest.spyOn(BankingService, 'createTransaction');
    jest.spyOn(BankingService, 'getTransactionById').mockResolvedValue({
      id: 'bt-1',
      transactionNumber: 'BT-PROOF-1',
    } as never);

    // Query sequence inside createFromExpense with existingGlTransactionId:
    // 1) existing bank txn? 2) ensure MoMo (mocked) 3) find bank account 4) category
    // 5) generateBankTxnNumber (SELECT ...) 6) INSERT
    mockQuery.mockImplementation(async (sql: unknown) => {
      const s = String(sql);
      if (s.includes('FROM bank_transactions') && s.includes('source_type = \'EXPENSE\'')) {
        return qResult([]);
      }
      if (s.includes('CreditAmount')) {
        return qResult([{ ok: true }]);
      }
      if (s.includes('FROM bank_accounts ba') && s.includes('AccountCode')) {
        return qResult([{ id: 'ba-1040', gl_code: '1040' }]);
      }
      if (s.includes('bank_categories') && s.includes('EXPENSE_PAYMENT')) {
        return qResult([{ id: 'cat-exp' }]);
      }
      if (s.includes('INSERT INTO bank_transactions')) {
        return qResult([]);
      }
      if (s.includes('bank_txn') || s.includes('nextval') || s.includes('transaction_number') || s.includes('RETURNING')) {
        return qResult([{ n: 1, num: 1, next: 1 }]);
      }
      return qResult([{ n: 1 }]);
    });

    const result = await BankingService.createFromExpense(
      'exp-1',
      'EXP-2026-0001',
      50000,
      'MOBILE_MONEY',
      '2026-09-23',
      {
        paymentAccountCode: '1040',
        existingGlTransactionId: 'gl-pay-1',
      },
      mockPool,
    );

    expect(ensure).toHaveBeenCalledWith(mockPool, 'MOBILE_MONEY');
    expect(createTxnSpy).not.toHaveBeenCalled();
    expect(result?.id).toBe('bt-1');

    const insertCall = mockQuery.mock.calls.find(
      (c) => typeof c[0] === 'string' && String(c[0]).includes('INSERT INTO bank_transactions'),
    );
    expect(insertCall).toBeTruthy();
    expect(insertCall?.[1]).toEqual(expect.arrayContaining(['gl-pay-1', 'exp-1', 'ba-1040', 50000]));
  });
});
