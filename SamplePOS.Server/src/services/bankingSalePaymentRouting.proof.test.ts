import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Pool, QueryResult } from 'pg';

const mockPool = {
  query: jest.fn<(...args: unknown[]) => Promise<QueryResult>>(),
} as unknown as Pool;

jest.unstable_mockModule('../db/pool.js', () => ({
  pool: mockPool,
}));

jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('../modules/treasury/ensureDepositLiquidityBook.js', () => ({
  ensureDepositLiquidityBook: jest.fn(async () => ({
    bankAccountId: 'bank-account-1040',
    glAccountId: 'gl-1040',
    glAccountCode: '1040',
    glAccountName: 'Mobile Money',
    name: 'Mobile Money',
    kind: 'MOBILE_MONEY',
  })),
}));

const { BankingService } = await import('./bankingService.js');
const { ensureDepositLiquidityBook } = await import(
  '../modules/treasury/ensureDepositLiquidityBook.js'
);

function qResult(rows: unknown[]): QueryResult {
  return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] } as QueryResult;
}

describe('BankingService.createFromSale — mirror only (no duplicate GL)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('routes AIRTEL_MONEY to 1040 bank book linked to SALE GL — never createTransaction', async () => {
    const createTransactionSpy = jest.spyOn(BankingService, 'createTransaction');
    jest.spyOn(BankingService, 'getTransactionById').mockResolvedValue({
      id: 'bt-1',
      transactionNumber: 'BT-1',
    } as never);

    (mockPool.query as jest.Mock).mockImplementation(async (sql: unknown) => {
      const s = String(sql);
      if (s.includes('FROM bank_transactions') && s.includes('source_type = \'SALE\'')) {
        return qResult([]);
      }
      if (s.includes('ReferenceType') && s.includes("'SALE'")) {
        return qResult([{ Id: 'sale-gl-1' }]);
      }
      if (s.includes('ledger_entries') && s.includes('DebitAmount')) {
        return qResult([{ ok: true }]);
      }
      if (s.includes('FROM bank_accounts ba') && s.includes('AccountCode')) {
        return qResult([{ id: 'bank-account-1040', gl_code: '1040' }]);
      }
      if (s.includes('SALES_DEPOSIT')) {
        return qResult([{ id: 'cat-sales' }]);
      }
      if (s.includes('INSERT INTO bank_transactions')) {
        return qResult([]);
      }
      return qResult([{ n: 1 }]);
    });

    await BankingService.createFromSale(
      'sale-1',
      'SALE-2026-0001',
      25000,
      'AIRTEL_MONEY',
      '2026-07-29T09:00:00.000Z',
      mockPool,
    );

    expect(ensureDepositLiquidityBook).toHaveBeenCalledWith(mockPool, 'MOBILE_MONEY');
    expect(createTransactionSpy).not.toHaveBeenCalled();
    const insert = (mockPool.query as jest.Mock).mock.calls.find(
      (c) => typeof c[0] === 'string' && String(c[0]).includes('INSERT INTO bank_transactions'),
    );
    expect(insert?.[1]).toEqual(expect.arrayContaining(['sale-gl-1', 'sale-1', 'bank-account-1040', 25000]));
  });

  it('routes MOBILE_MONEY (MTN) the same as AIRTEL — no tenant-special path, no second GL', async () => {
    jest.spyOn(BankingService, 'createTransaction');
    jest.spyOn(BankingService, 'getTransactionById').mockResolvedValue({
      id: 'bt-2',
      transactionNumber: 'BT-2',
    } as never);

    (mockPool.query as jest.Mock).mockImplementation(async (sql: unknown) => {
      const s = String(sql);
      if (s.includes('FROM bank_transactions') && s.includes("'SALE'")) return qResult([]);
      if (s.includes("'SALE'") && s.includes('ReferenceId')) return qResult([{ Id: 'sale-gl-2' }]);
      if (s.includes('DebitAmount')) return qResult([{ ok: true }]);
      if (s.includes('bank_accounts ba')) return qResult([{ id: 'bank-account-1040', gl_code: '1040' }]);
      if (s.includes('SALES_DEPOSIT')) return qResult([{ id: 'cat-sales' }]);
      if (s.includes('INSERT INTO bank_transactions')) return qResult([]);
      return qResult([{ n: 1 }]);
    });

    await BankingService.createFromSale(
      'sale-2',
      'SALE-2026-0002',
      10000,
      'MOBILE_MONEY',
      '2026-07-29T09:00:00.000Z',
      mockPool,
    );

    expect(ensureDepositLiquidityBook).toHaveBeenCalledWith(mockPool, 'MOBILE_MONEY');
    expect(BankingService.createTransaction).not.toHaveBeenCalled();
  });

  it('refuses mismatch: skips mirror when SALE GL does not debit 1040', async () => {
    const createTransactionSpy = jest.spyOn(BankingService, 'createTransaction');
    (mockPool.query as jest.Mock).mockImplementation(async (sql: unknown) => {
      const s = String(sql);
      if (s.includes('FROM bank_transactions')) return qResult([]);
      if (s.includes("'SALE'") && s.includes('ReferenceId')) return qResult([{ Id: 'sale-gl-x' }]);
      if (s.includes('DebitAmount')) return qResult([{ ok: false }]);
      return qResult([]);
    });

    const result = await BankingService.createFromSale(
      'sale-3',
      'SALE-2026-0003',
      10000,
      'MOBILE_MONEY',
      '2026-07-29',
      mockPool,
    );

    expect(result).toBeNull();
    expect(createTransactionSpy).not.toHaveBeenCalled();
  });
});
