/**
 * Banking retry worker guarantees without Redis/Bull:
 *  - unresolvable tenant pool THROWS (job stays retryable / failed) — never silent success
 *  - invalid payload is discarded and rejected
 *  - tenantId never falls back to a default pool
 *
 * Redis/Bull delivery is covered by redisResilience.proof.test.ts.
 * DB idempotency of createFromSale is covered by saleBankMirror.idempotency.realpg.test.ts.
 */
import { describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';
import {
  BankingJobRejectedError,
  processBankingJob,
} from './bankingRetryWorker.js';

const SALE = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function job(payload: unknown) {
  return {
    id: 'job-1',
    attemptsMade: 0,
    discard: jest.fn(),
    data: { payload },
  };
}

function validPayload(over: Record<string, unknown> = {}) {
  return {
    saleId: SALE,
    saleNumber: 'SALE-1',
    saleDate: '2026-10-30',
    payments: [{ amount: 1000, paymentMethod: 'CASH' }],
    ...over,
  };
}

describe('processBankingJob', () => {
  it('throws and discards an invalid payload (no DB write, no retries that can succeed)', async () => {
    const j = job({ saleId: 'not-a-uuid', saleNumber: 'SALE-1', saleDate: '2026-10-30', payments: [] });
    const createFromSale = jest.fn(async () => null);
    await expect(
      processBankingJob(j, {
        resolveTenantPool: async () => ({ } as pg.Pool),
        createFromSale,
      }),
    ).rejects.toBeInstanceOf(BankingJobRejectedError);
    expect(j.discard).toHaveBeenCalled();
    expect(createFromSale).not.toHaveBeenCalled();
  });

  it('throws when tenantId is present but the pool cannot be resolved (does not complete the job)', async () => {
    const j = job(validPayload({ tenantId: TENANT }));
    const createFromSale = jest.fn(async () => null);
    await expect(
      processBankingJob(j, {
        resolveTenantPool: async () => null,
        createFromSale,
      }),
    ).rejects.toThrow(/tenant pool/);
    expect(createFromSale).not.toHaveBeenCalled();
    expect(j.discard).not.toHaveBeenCalled();
  });

  it('does not resolve a pool when tenantId is omitted', async () => {
    const resolveTenantPool = jest.fn(async () => ({ } as pg.Pool));
    const createFromSale = jest.fn(async () => ({ id: 'bt-1' }));
    const out = await processBankingJob(job(validPayload()), {
      resolveTenantPool,
      createFromSale,
    });
    expect(resolveTenantPool).not.toHaveBeenCalled();
    expect(createFromSale).toHaveBeenCalledWith(SALE, 'SALE-1', 1000, 'CASH', '2026-10-30', undefined);
    expect(out).toEqual({ mirrored: 1, saleId: SALE });
  });

  it('passes the resolved tenant pool into createFromSale and never a default pool', async () => {
    const tenantPool = { tag: 'tenant' } as unknown as pg.Pool;
    const resolveTenantPool = jest.fn(async (id: string) => {
      expect(id).toBe(TENANT);
      return tenantPool;
    });
    const createFromSale = jest.fn(async () => ({ id: 'bt-1' }));
    await processBankingJob(job(validPayload({ tenantId: TENANT })), {
      resolveTenantPool,
      createFromSale,
    });
    expect(createFromSale).toHaveBeenCalledWith(SALE, 'SALE-1', 1000, 'CASH', '2026-10-30', tenantPool);
  });

  it('aggregates same-method lines before mirroring', async () => {
    const createFromSale = jest.fn(async () => ({ id: 'bt-1' }));
    await processBankingJob(
      job(
        validPayload({
          payments: [
            { amount: 400, paymentMethod: 'CASH' },
            { amount: 600, paymentMethod: 'CASH' },
            { amount: 200, paymentMethod: 'CARD' },
          ],
        }),
      ),
      { resolveTenantPool: async () => null, createFromSale },
    );
    expect(createFromSale).toHaveBeenCalledTimes(2);
    expect(createFromSale).toHaveBeenCalledWith(SALE, 'SALE-1', 1000, 'CASH', '2026-10-30', undefined);
    expect(createFromSale).toHaveBeenCalledWith(SALE, 'SALE-1', 200, 'CARD', '2026-10-30', undefined);
  });
});
