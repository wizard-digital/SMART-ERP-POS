import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import type { Pool } from 'pg';
import { purchaseOrderRepository } from './purchaseOrderRepository.js';

describe('purchaseOrderRepository.listPOs', () => {
  const mockPool = {
    query: jest.fn<(...args: unknown[]) => Promise<{ rows: unknown[] }>>(),
  } as unknown as Pool;

  beforeEach(() => {
    jest.resetAllMocks();
    (mockPool.query as jest.Mock)
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })
      .mockResolvedValueOnce({ rows: [] });
  });

  test('default list excludes CANCELLED purchase orders', async () => {
    await purchaseOrderRepository.listPOs(mockPool, 1, 50);

    const countSql = String((mockPool.query as jest.Mock).mock.calls[0][0]);
    expect(countSql).toContain(`po.status <> 'CANCELLED'`);
  });

  test('status=CANCELLED includes cancelled purchase orders', async () => {
    await purchaseOrderRepository.listPOs(mockPool, 1, 50, { status: 'CANCELLED' });

    const countSql = String((mockPool.query as jest.Mock).mock.calls[0][0]);
    expect(countSql).toContain('po.status = $1');
    expect(countSql).not.toContain(`po.status <> 'CANCELLED'`);
    const params = (mockPool.query as jest.Mock).mock.calls[0][1] as unknown[];
    expect(params).toContain('CANCELLED');
  });

  test('status=PENDING includes POs with open receipt quantity', async () => {
    await purchaseOrderRepository.listPOs(mockPool, 1, 50, { status: 'PENDING' });

    const countSql = String((mockPool.query as jest.Mock).mock.calls[0][0]);
    expect(countSql).toContain('purchase_order_items poi');
    expect(countSql).toContain('ordered_quantity');
    expect(countSql).not.toContain('NOT EXISTS');
    expect(countSql).not.toContain('goods_receipts gr');
  });

  test('search matches PO number, supplier name, and supplier code', async () => {
    await purchaseOrderRepository.listPOs(mockPool, 1, 50, { search: 'ACE' });

    const countSql = String((mockPool.query as jest.Mock).mock.calls[0][0]);
    expect(countSql).toContain('JOIN suppliers s');
    expect(countSql).toContain('po.order_number ILIKE');
    expect(countSql).toContain('CompanyName');
    expect(countSql).toContain('SupplierCode');
    expect(countSql).not.toContain('s_search');
    const params = (mockPool.query as jest.Mock).mock.calls[0][1] as unknown[];
    expect(params).toContain('%ACE%');
  });
});
