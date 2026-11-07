/**
 * Unit: cancelLinkedInvoicesForDeadSale mutates subledger only and syncs balance.
 */
import { describe, expect, it, jest } from '@jest/globals';

const syncMock = jest.fn(async () => ({ oldBalance: 100, newBalance: 0 }));

jest.unstable_mockModule('../../utils/customerBalanceSync.js', () => ({
  syncCustomerBalanceFromInvoices: syncMock,
}));

const { cancelLinkedInvoicesForDeadSale } = await import('./cancelLinkedInvoicesForDeadSale.js');

describe('cancelLinkedInvoicesForDeadSale unit', () => {
  it('cancels open linked invoices and syncs each customer once', async () => {
    syncMock.mockClear();
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const client = {
      query: jest.fn(async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        if (sql.includes('FROM invoices') && sql.includes('sale_id')) {
          return {
            rows: [
              { id: 'inv-1', customer_id: 'cust-1', status: 'UNPAID' },
              { id: 'inv-2', customer_id: 'cust-1', status: 'PARTIALLY_PAID' },
            ],
          };
        }
        return { rows: [] };
      }),
    };

    const result = await cancelLinkedInvoicesForDeadSale(
      client as never,
      'sale-1',
      'SALE_VOIDED_BY_RETURN',
    );

    expect(result.cancelledInvoiceIds).toEqual(['inv-1', 'inv-2']);
    expect(result.customerIdsSynced).toEqual(['cust-1']);
    expect(syncMock).toHaveBeenCalledTimes(1);
    expect(syncMock).toHaveBeenCalledWith(client, 'cust-1', 'SALE_VOIDED_BY_RETURN');
    const updates = calls.filter((c) => c.sql.includes("status = 'CANCELLED'"));
    expect(updates).toHaveLength(2);
    expect(calls.some((c) => /ledger_|createJournal|INSERT INTO ledger/i.test(c.sql))).toBe(false);
  });

  it('no-ops when no open invoices', async () => {
    syncMock.mockClear();
    const client = {
      query: jest.fn(async () => ({ rows: [] })),
    };
    const result = await cancelLinkedInvoicesForDeadSale(client as never, 'sale-x', 'SALE_VOID');
    expect(result.cancelledInvoiceIds).toEqual([]);
    expect(syncMock).not.toHaveBeenCalled();
  });
});
