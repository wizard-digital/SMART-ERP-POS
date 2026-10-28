/**
 * Split-tender sale posting — REAL Postgres (clone of the production template schema + chart of accounts),
 * REAL AccountingCore (posting governance, open-period check, idempotency, double-entry), REAL recordSaleToGL.
 *
 * Skips LOUDLY if the local template copy is unavailable (node scripts/ops/clone-template-local.mjs).
 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { createScratchFromTemplate, insertCustomer, journalByAccount, type TemplateScratch } from '../test/realPgTemplate.js';

let db: TemplateScratch | null = null;
let recordSaleToGL: typeof import('./glEntryService.js').recordSaleToGL;

beforeAll(async () => {
  db = await createScratchFromTemplate();
  if (!db) {
    // eslint-disable-next-line no-console
    console.warn('\n*** saleTenderGl.realpg: SKIPPED — local Postgres or sp_template_local missing. NOT verified. ***\n');
    return;
  }
  ({ recordSaleToGL } = await import('./glEntryService.js'));
});
afterAll(async () => {
  await db?.drop();
});

const maybe = (name: string, fn: () => Promise<void>) =>
  it(name, async () => {
    if (!db) return;
    await fn();
  });

function sale(over: Record<string, unknown>) {
  const id = randomUUID();
  return {
    saleId: id,
    saleNumber: `SALE-T-${id.slice(0, 6)}`,
    saleDate: '2026-10-28',
    totalAmount: 40000,
    costAmount: 0,
    paymentMethod: 'CASH',
    amountPaid: 40000,
    taxAmount: 0,
    saleItems: [{ productType: 'service', totalPrice: 40000, unitCost: 0, quantity: 1 }],
    ...over,
  } as unknown as Parameters<typeof recordSaleToGL>[0];
}
const liquid = (rows: Array<{ code: string; debit: number; credit: number }>) =>
  Object.fromEntries(rows.filter((r) => ['1010', '1020', '1030', '1040', '1200'].includes(r.code)).map((r) => [r.code, r.debit]));
const totals = (rows: Array<{ debit: number; credit: number }>) => ({
  dr: Math.round(rows.reduce((s, r) => s + r.debit, 0) * 100) / 100,
  cr: Math.round(rows.reduce((s, r) => s + r.credit, 0) * 100) / 100,
});

describe('split-tender GL posting on real Postgres', () => {
  maybe('LEGACY SHAPE (no payment lines) = the production defect: whole total lands on the header account', async () => {
    const s = sale({ paymentMethod: 'CASH' }); // header says CASH, tender was really mixed — lines not supplied
    await recordSaleToGL(s, db!.pool);
    const rows = await journalByAccount(db!.pool, { referenceType: 'SALE', referenceId: s.saleId });
    expect(liquid(rows)).toEqual({ '1010': 40000 }); // 1040/1020 never debited
  });

  maybe('CASH + MOBILE_MONEY + CARD: one debit per liquidity account, DR == CR == total', async () => {
    const s = sale({
      paymentMethod: 'CASH',
      paymentLines: [
        { paymentMethod: 'CASH', amount: 20000 },
        { paymentMethod: 'MOBILE_MONEY', amount: 15000 },
        { paymentMethod: 'CARD', amount: 5000 },
      ],
    });
    await recordSaleToGL(s, db!.pool);
    const rows = await journalByAccount(db!.pool, { referenceType: 'SALE', referenceId: s.saleId });
    expect(liquid(rows)).toEqual({ '1010': 20000, '1020': 5000, '1040': 15000 });
    expect(totals(rows)).toEqual({ dr: 40000, cr: 40000 });
  });

  maybe('cash change is clipped to what is due; non-cash tenders are exact', async () => {
    const s = sale({
      paymentMethod: 'CASH',
      paymentLines: [
        { paymentMethod: 'MOBILE_MONEY', amount: 15000 },
        { paymentMethod: 'CASH', amount: 50000 }, // tendered 50,000, 25,000 due in cash → change 25,000
      ],
    });
    await recordSaleToGL(s, db!.pool);
    const rows = await journalByAccount(db!.pool, { referenceType: 'SALE', referenceId: s.saleId });
    expect(liquid(rows)).toEqual({ '1010': 25000, '1040': 15000 });
    expect(totals(rows)).toEqual({ dr: 40000, cr: 40000 });
  });

  maybe('two lines of the SAME method merge into one debit; BANK_TRANSFER goes to 1030 (not cash)', async () => {
    const s = sale({
      paymentMethod: 'BANK_TRANSFER',
      paymentLines: [
        { paymentMethod: 'BANK_TRANSFER', amount: 10000 },
        { paymentMethod: 'BANK_TRANSFER', amount: 10000 },
        { paymentMethod: 'AIRTEL_MONEY', amount: 20000 },
      ],
    });
    await recordSaleToGL(s, db!.pool);
    const rows = await journalByAccount(db!.pool, { referenceType: 'SALE', referenceId: s.saleId });
    expect(liquid(rows)).toEqual({ '1030': 20000, '1040': 20000 });
    expect(totals(rows)).toEqual({ dr: 40000, cr: 40000 });
  });

  maybe('single-method BANK_TRANSFER sale (no lines) debits 1030, not cash', async () => {
    const s = sale({ paymentMethod: 'BANK_TRANSFER' });
    await recordSaleToGL(s, db!.pool);
    const rows = await journalByAccount(db!.pool, { referenceType: 'SALE', referenceId: s.saleId });
    expect(liquid(rows)).toEqual({ '1030': 40000 });
  });

  maybe('part-paid CREDIT sale: each tender to its own account, balance to A/R', async () => {
    const customerId = await insertCustomer(db!.pool, 'Split Tender Co');
    const s = sale({
      paymentMethod: 'CREDIT',
      amountPaid: 25000,
      customerId,
      paymentLines: [
        { paymentMethod: 'MOBILE_MONEY', amount: 10000 },
        { paymentMethod: 'CASH', amount: 15000 },
        { paymentMethod: 'CREDIT', amount: 15000 },
      ],
    });
    await recordSaleToGL(s, db!.pool);
    const rows = await journalByAccount(db!.pool, { referenceType: 'SALE', referenceId: s.saleId });
    expect(liquid(rows)).toEqual({ '1010': 15000, '1040': 10000, '1200': 15000 });
    expect(totals(rows)).toEqual({ dr: 40000, cr: 40000 });
  });

  maybe('DEPOSIT in the tender mix keeps the legacy single-account path (deposit application is separate)', async () => {
    const customerId = await insertCustomer(db!.pool, 'Dep Co');
    const s = sale({
      paymentMethod: 'DEPOSIT',
      customerId,
      paymentLines: [
        { paymentMethod: 'DEPOSIT', amount: 30000 },
        { paymentMethod: 'CASH', amount: 10000 },
      ],
    });
    await recordSaleToGL(s, db!.pool);
    const rows = await journalByAccount(db!.pool, { referenceType: 'SALE', referenceId: s.saleId });
    expect(liquid(rows)).toEqual({ '1200': 40000 }); // unchanged legacy behaviour
  });

  maybe('replay is idempotent: same sale posted twice yields ONE journal', async () => {
    const s = sale({
      paymentMethod: 'CASH',
      paymentLines: [
        { paymentMethod: 'CASH', amount: 10000 },
        { paymentMethod: 'MOBILE_MONEY', amount: 30000 },
      ],
    });
    await recordSaleToGL(s, db!.pool);
    await recordSaleToGL(s, db!.pool);
    const n = await db!.pool.query(
      `SELECT count(*)::int n FROM ledger_transactions WHERE "ReferenceType"='SALE' AND "ReferenceId"::text=$1`,
      [s.saleId],
    );
    expect(n.rows[0].n).toBe(1);
  });
});
