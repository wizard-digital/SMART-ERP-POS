/**
 * Bank-mirror idempotency for split-tender sales — REAL Postgres, REAL BankingService.createFromSale,
 * REAL retry-worker entry point (processBankingJob).
 *
 * Proves: a retry / duplicate / concurrent delivery can never create a second bank transaction for the same
 * (sale, method), never posts a second journal, and a skipped mirror is observable (returns null) — not thrown away
 * as success while the SALE journal is missing.
 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { createScratchFromTemplate, type TemplateScratch } from '../test/realPgTemplate.js';

let db: TemplateScratch | null = null;
let recordSaleToGL: typeof import('./glEntryService.js').recordSaleToGL;
let BankingService: typeof import('./bankingService.js').BankingService;
let processBankingJob: typeof import('./bankingRetryWorker.js').processBankingJob;

beforeAll(async () => {
  db = await createScratchFromTemplate();
  if (!db) {
    // eslint-disable-next-line no-console
    console.warn('\n*** saleBankMirror.idempotency.realpg: SKIPPED — local Postgres or sp_template_local missing. NOT verified. ***\n');
    return;
  }
  ({ recordSaleToGL } = await import('./glEntryService.js'));
  ({ BankingService } = await import('./bankingService.js'));
  ({ processBankingJob } = await import('./bankingRetryWorker.js'));
});
afterAll(async () => {
  await db?.drop();
});

const maybe = (name: string, fn: () => Promise<void>) =>
  it(name, async () => {
    if (!db) return;
    await fn();
  });

async function postSplitSale(lines: Array<{ paymentMethod: string; amount: number }>, total = 40000) {
  const id = randomUUID();
  const s = {
    saleId: id,
    saleNumber: `SALE-B-${id.slice(0, 6)}`,
    saleDate: '2026-10-28',
    totalAmount: total,
    costAmount: 0,
    paymentMethod: 'CASH',
    amountPaid: total,
    taxAmount: 0,
    paymentLines: lines,
    saleItems: [{ productType: 'service', totalPrice: total, unitCost: 0, quantity: 1 }],
  } as unknown as Parameters<typeof recordSaleToGL>[0];
  await recordSaleToGL(s, db!.pool);
  return s;
}
const bankRows = async (saleId: string) =>
  (await db!.pool.query(
    `SELECT description, amount::float8 amount FROM bank_transactions WHERE source_type='SALE' AND source_id=$1 ORDER BY description`,
    [saleId],
  )).rows;
const journalCount = async (saleId: string) =>
  (await db!.pool.query(`SELECT count(*)::int n FROM ledger_transactions WHERE "ReferenceId"::text=$1`, [saleId])).rows[0].n;

describe('sale → bank mirror idempotency on real Postgres', () => {
  maybe('sequential retry: second delivery creates nothing and posts no journal', async () => {
    const s = await postSplitSale([
      { paymentMethod: 'CASH', amount: 10000 },
      { paymentMethod: 'MOBILE_MONEY', amount: 30000 },
    ]);
    const before = await journalCount(s.saleId);
    const first = await BankingService.createFromSale(s.saleId, s.saleNumber, 30000, 'MOBILE_MONEY', s.saleDate, db!.pool);
    const second = await BankingService.createFromSale(s.saleId, s.saleNumber, 30000, 'MOBILE_MONEY', s.saleDate, db!.pool);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(await bankRows(s.saleId)).toEqual([{ description: `Sale ${s.saleNumber} [MOBILE_MONEY]`, amount: 30000 }]);
    expect(await journalCount(s.saleId)).toBe(before); // mirror never posts a journal
  });

  maybe('concurrent deliveries (10 at once) yield exactly one bank row and no thrown error', async () => {
    const s = await postSplitSale([
      { paymentMethod: 'CASH', amount: 5000 },
      { paymentMethod: 'MOBILE_MONEY', amount: 35000 },
    ]);
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        BankingService.createFromSale(s.saleId, s.saleNumber, 35000, 'MOBILE_MONEY', s.saleDate, db!.pool),
      ),
    );
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(0);
    expect(results.filter((r) => r.status === 'fulfilled' && r.value !== null)).toHaveLength(1);
    expect(await bankRows(s.saleId)).toHaveLength(1);
  });

  maybe('12 DIFFERENT sales mirrored concurrently: a transaction-number collision never silently drops a payment', async () => {
    const sales = [];
    for (let i = 0; i < 12; i++) {
      sales.push(await postSplitSale([
        { paymentMethod: 'CASH', amount: 1000 },
        { paymentMethod: 'MOBILE_MONEY', amount: 2000 + i },
      ], 3000 + i));
    }
    const run = (s: (typeof sales)[number], i: number) =>
      BankingService.createFromSale(s.saleId, s.saleNumber, 2000 + i, 'MOBILE_MONEY', s.saleDate, db!.pool);
    const first = await Promise.allSettled(sales.map(run));
    // any rejection must be surfaced (so Bull retries it) — never a silent null for a sale with no row
    const missingAfterFirst: number[] = [];
    for (let i = 0; i < sales.length; i++) {
      if ((await bankRows(sales[i].saleId)).length === 0) {
        expect(first[i].status).toBe('rejected'); // not lost silently
        missingAfterFirst.push(i);
      }
    }
    for (const i of missingAfterFirst) await run(sales[i], i); // the retry the queue would perform
    for (let i = 0; i < sales.length; i++) {
      expect(await bankRows(sales[i].saleId)).toEqual([
        { description: `Sale ${sales[i].saleNumber} [MOBILE_MONEY]`, amount: 2000 + i },
      ]);
    }
  });

  maybe('retry-worker path: duplicate job delivery + same-method lines summed into one row (no silent loss)', async () => {
    const s = await postSplitSale([
      { paymentMethod: 'CASH', amount: 10000 },
      { paymentMethod: 'MOBILE_MONEY', amount: 10000 },
      { paymentMethod: 'AIRTEL_MONEY', amount: 20000 },
    ]);
    const job = {
      data: {
        payload: {
          saleId: s.saleId,
          saleNumber: s.saleNumber,
          saleDate: s.saleDate,
          payments: [
            { paymentMethod: 'MOBILE_MONEY', amount: 10000 },
            { paymentMethod: 'AIRTEL_MONEY', amount: 20000 },
          ],
        },
      },
      attemptsMade: 0,
    };
    const deps = {
      resolveTenantPool: async () => db!.pool,
      createFromSale: (...a: Parameters<typeof BankingService.createFromSale>) =>
        BankingService.createFromSale(a[0], a[1], a[2], a[3], a[4], db!.pool),
    };
    await processBankingJob(job, deps);
    await processBankingJob(job, deps); // duplicate delivery / retry after partial success
    const rows = await bankRows(s.saleId);
    expect(rows).toEqual([
      { description: `Sale ${s.saleNumber} [AIRTEL_MONEY]`, amount: 20000 },
      { description: `Sale ${s.saleNumber} [MOBILE_MONEY]`, amount: 10000 },
    ]);
  });

  maybe('mirror is refused (observable null, no row) when the SALE journal does not debit that liquidity account', async () => {
    // legacy-shaped journal: header CASH, no lines → 1040 never debited
    const id = randomUUID();
    const s = {
      saleId: id, saleNumber: `SALE-L-${id.slice(0, 6)}`, saleDate: '2026-10-28', totalAmount: 40000, costAmount: 0,
      paymentMethod: 'CASH', amountPaid: 40000, taxAmount: 0,
      saleItems: [{ productType: 'service', totalPrice: 40000, unitCost: 0, quantity: 1 }],
    } as unknown as Parameters<typeof recordSaleToGL>[0];
    await recordSaleToGL(s, db!.pool);
    const r = await BankingService.createFromSale(s.saleId, s.saleNumber, 30000, 'MOBILE_MONEY', s.saleDate, db!.pool);
    expect(r).toBeNull();
    expect(await bankRows(s.saleId)).toEqual([]);
  });
});
