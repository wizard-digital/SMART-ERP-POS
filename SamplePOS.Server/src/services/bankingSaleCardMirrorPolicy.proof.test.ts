import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Pool, QueryResult } from 'pg';

const mockPool = {
  query: jest.fn<(...args: unknown[]) => Promise<QueryResult>>(),
} as unknown as Pool;

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

jest.unstable_mockModule('../db/pool.js', () => ({ pool: mockPool }));
jest.unstable_mockModule('../utils/logger.js', () => ({ default: mockLogger }));
jest.unstable_mockModule('../modules/treasury/ensureDepositLiquidityBook.js', () => ({
  ensureDepositLiquidityBook: jest.fn(async () => ({})),
}));

const { BankingService } = await import('./bankingService.js');
const { ensureDepositLiquidityBook } = await import('../modules/treasury/ensureDepositLiquidityBook.js');
const policy = await import('../modules/treasury/saleBankMirrorPolicy.js');

function qResult(rows: unknown[]): QueryResult {
  return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] } as QueryResult;
}

function sqlCalls(): string[] {
  return (mockPool.query as jest.Mock).mock.calls.map((c) => String((c as unknown[])[0]));
}

/** Pool where the SALE journal debits the liquidity GL; `bankBook` controls bank_accounts lookup. */
function wirePool(opts: { bankBook: Array<{ id: string; gl_code: string }>; alreadyMirrored?: boolean; glDebits?: boolean }) {
  (mockPool.query as jest.Mock).mockImplementation(async (sql: unknown) => {
    const s = String(sql);
    if (s.includes('FROM bank_transactions') && s.includes("source_type = 'SALE'")) {
      return qResult(opts.alreadyMirrored ? [{ id: 'bt-existing' }] : []);
    }
    if (s.includes("'SALE'") && s.includes('ReferenceId')) return qResult([{ Id: 'sale-gl-1' }]);
    if (s.includes('DebitAmount')) return qResult([{ ok: opts.glDebits !== false }]);
    if (s.includes('FROM bank_accounts ba')) return qResult(opts.bankBook);
    return qResult([]);
  });
}

describe('Sale bank mirror policy — CARD is opt-in, explicit, never invents GL or bank rows', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  it('CARD with no 1020 book: returns null, logs reasonCode, issues NO insert and NO journal write', async () => {
    const createTx = jest.spyOn(BankingService, 'createTransaction');
    wirePool({ bankBook: [] });

    const result = await BankingService.createFromSale('sale-c1', 'SALE-2026-0100', 50000, 'CARD', '2026-10-01', mockPool);

    expect(result).toBeNull();
    expect(createTx).not.toHaveBeenCalled();
    const sql = sqlCalls().join('\n');
    expect(sql).not.toMatch(/INSERT INTO bank_transactions/);
    expect(sql).not.toMatch(/INSERT INTO ledger_(transactions|entries)/);
    expect(ensureDepositLiquidityBook).not.toHaveBeenCalled(); // CARD book is never auto-created

    const skip = mockLogger.info.mock.calls.find((c) => c[0] === 'Sale bank mirror skipped');
    expect(skip).toBeTruthy();
    expect(skip?.[1]).toMatchObject({
      saleId: 'sale-c1',
      paymentMethod: 'CARD',
      targetGlCode: '1020',
      reasonCode: 'NO_ACTIVE_BANK_BOOK_ON_GL',
    });
    // not a per-sale warning storm any more
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it('CARD is idempotent: an existing mirror row short-circuits (no duplicate bank transaction)', async () => {
    wirePool({ bankBook: [{ id: 'ba-1020', gl_code: '1020' }], alreadyMirrored: true });

    const result = await BankingService.createFromSale('sale-c2', 'SALE-2026-0101', 50000, 'CARD', '2026-10-01', mockPool);

    expect(result).toBeNull();
    expect(sqlCalls().join('\n')).not.toMatch(/INSERT INTO bank_transactions/);
  });

  it('CARD where the SALE journal does not debit 1020: skipped, no second journal', async () => {
    const createTx = jest.spyOn(BankingService, 'createTransaction');
    wirePool({ bankBook: [{ id: 'ba-1020', gl_code: '1020' }], glDebits: false });

    const result = await BankingService.createFromSale('sale-c3', 'SALE-2026-0102', 50000, 'CARD', '2026-10-01', mockPool);

    expect(result).toBeNull();
    expect(createTx).not.toHaveBeenCalled();
    expect(sqlCalls().join('\n')).not.toMatch(/INSERT INTO (bank_transactions|ledger_)/);
  });

  it('CASH / CREDIT / DEPOSIT never touch the database (not bank tenders)', async () => {
    for (const m of ['CASH', 'CREDIT', 'DEPOSIT']) {
      const r = await BankingService.createFromSale('s', 'SALE-X', 1, m, '2026-10-01', mockPool);
      expect(r).toBeNull();
    }
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('unknown tender: skipped with explicit reasonCode, no queries that write', async () => {
    wirePool({ bankBook: [] });
    const r = await BankingService.createFromSale('s', 'SALE-Y', 1, 'VOUCHER', '2026-10-01', mockPool);
    expect(r).toBeNull();
    expect(mockLogger.warn.mock.calls[0]?.[1]).toMatchObject({ reasonCode: 'NO_LIQUIDITY_GL_MAPPING' });
    expect(sqlCalls().join('\n')).not.toMatch(/INSERT/);
  });

  describe('pure policy', () => {
    it('maps tenders to the same GLs as before (no behavior drift)', () => {
      expect(policy.saleBankMirrorGlCode('CARD')).toBe('1020');
      expect(policy.saleBankMirrorGlCode('MOBILE_MONEY')).toBe('1040');
      expect(policy.saleBankMirrorGlCode('AIRTEL_MONEY')).toBe('1040');
      expect(policy.saleBankMirrorGlCode('BANK_TRANSFER')).toBe('1030');
      expect(policy.saleBankMirrorGlCode('VOUCHER')).toBeNull();
    });
    it('only mobile money auto-ensures its book; CARD never does', () => {
      expect(policy.shouldAutoEnsureBook('MOBILE_MONEY')).toBe(true);
      expect(policy.shouldAutoEnsureBook('AIRTEL_MONEY')).toBe(true);
      expect(policy.shouldAutoEnsureBook('CARD')).toBe(false);
      expect(policy.shouldAutoEnsureBook('BANK_TRANSFER')).toBe(false);
    });
    it('non-bank tenders', () => {
      expect(policy.isNonBankTender('CASH')).toBe(true);
      expect(policy.isNonBankTender('CARD')).toBe(false);
    });
    it('explains the CARD skip', () => {
      expect(policy.describeSaleBankMirrorSkip('NO_ACTIVE_BANK_BOOK_ON_GL', 'CARD', '1020')).toMatch(/settle via Treasury/);
    });
  });
});
