/**
 * E2E on REAL Postgres: full return reverses charged amount AND cart discount
 * in sales_daily_summary — the table Sales Analytics reads.
 *
 * Same functions salesService void/refund call: projectSaleRollupDecrement
 * + incrementDailySummary + decrementDailySummary + getSalesSummaryFromRollup.
 *
 * Fails closed if local template is missing (never skip-pass).
 *
 * Run: node --experimental-vm-modules ./node_modules/jest/bin/jest.js src/modules/sales/saleDailySummaryReturn.realpg.test.ts --no-coverage --forceExit
 */
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectSaleRollupDecrement } from '../../../../shared/domain/saleDiscountSsot.js';
import { createScratchFromTemplate, type TemplateScratch } from '../../test/realPgTemplate.js';
import { salesRepository } from './salesRepository.js';

let db: TemplateScratch | null = null;
const evidence: Array<{ name: string; ok: true; detail: Record<string, unknown> }> = [];

beforeAll(async () => {
  db = await createScratchFromTemplate();
  if (!db) {
    throw new Error(
      'saleDailySummaryReturn.realpg: sp_template_local required. Run node scripts/ops/clone-template-local.mjs',
    );
  }
});

afterAll(async () => {
  await db?.drop();
});

function prove(name: string, detail: Record<string, unknown>): void {
  evidence.push({ name, ok: true, detail });
}

async function withTx(fn: (client: import('pg').PoolClient) => Promise<void>): Promise<void> {
  const client = await db!.pool.connect();
  try {
    await client.query('BEGIN');
    await fn(client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function dashboard(date: string): Promise<{
  totalSales: number;
  totalAmount: number;
  totalDiscounts: number;
  byPaymentMethod: Array<{ paymentMethod: string; count: number; totalAmount: number }>;
}> {
  const raw = await salesRepository.getSalesSummaryFromRollup(db!.pool, {
    startDate: date,
    endDate: date,
  });
  return {
    totalSales: Number(raw.totalSales),
    totalAmount: Number(raw.totalAmount),
    totalDiscounts: Number(raw.totalDiscounts),
    byPaymentMethod: (raw.byPaymentMethod as Array<Record<string, unknown>>).map((row) => ({
      paymentMethod: String(row.paymentMethod),
      count: Number(row.count),
      totalAmount: Number(row.totalAmount),
    })),
  };
}

async function rawRow(date: string, method: string) {
  const { rows } = await db!.pool.query(
    `SELECT transaction_count, total_amount, total_discounts, total_profit
       FROM sales_daily_summary
      WHERE sale_date = $1::date AND payment_method = $2`,
    [date, method],
  );
  return rows[0] as
    | {
        transaction_count: string | number;
        total_amount: string;
        total_discounts: string;
        total_profit: string;
      }
    | undefined;
}

async function fullReturn(
  date: string,
  sale: {
    paymentMethod: string;
    headerTotal: number;
    headerDiscount: number;
    amountPaid: number;
    cost: number;
  },
): Promise<void> {
  const reverse = projectSaleRollupDecrement(sale);
  await withTx(async (client) => {
    await salesRepository.decrementDailySummary(
      client,
      date,
      sale.paymentMethod,
      reverse.reverseAmount,
      sale.cost,
      reverse.reverseDiscount,
      sale.paymentMethod === 'CREDIT',
      false,
    );
  });
}

describe('Full return zeros daily-summary charged + discount (real Postgres E2E)', () => {
  it('old list decrement leaves CASH -35000 (the Bliss dashboard defect)', async () => {
    const date = '2026-10-01';
    await withTx(async (client) => {
      await salesRepository.incrementDailySummary(
        client,
        date,
        'CASH',
        3_200_000,
        0,
        35_000,
        false,
        false,
      );
      await salesRepository.decrementDailySummary(
        client,
        date,
        'CASH',
        3_235_000,
        0,
        0,
        false,
        false,
      );
    });
    const row = await rawRow(date, 'CASH');
    const dash = await dashboard(date);
    expect(Number(row?.total_amount)).toBe(-35_000);
    expect(Number(row?.total_discounts)).toBe(35_000);
    expect(Number(row?.transaction_count)).toBe(0);
    expect(dash.totalAmount).toBe(-35_000);
    expect(dash.totalDiscounts).toBe(35_000);
    prove('old-list-decrement-leaves-minus-35000', { row, dash });
  });

  it('SSOT full return of wiped 0031 zeros CASH and deletes the rollup row', async () => {
    const date = '2026-10-02';
    await withTx(async (client) => {
      await salesRepository.incrementDailySummary(
        client,
        date,
        'CASH',
        3_200_000,
        0,
        35_000,
        false,
        false,
      );
    });
    await fullReturn(date, {
      paymentMethod: 'CASH',
      headerTotal: 3_235_000,
      headerDiscount: 0,
      amountPaid: 3_200_000,
      cost: 0,
    });
    expect(await rawRow(date, 'CASH')).toBeUndefined();
    const dash = await dashboard(date);
    expect(dash.totalSales).toBe(0);
    expect(dash.totalAmount).toBe(0);
    expect(dash.totalDiscounts).toBe(0);
    expect(dash.byPaymentMethod).toEqual([]);
    prove('ssot-0031-full-return-deletes-cash-row', { dash });
  });

  it('CARD 430000 stays; returned CASH leftover does not paint on the dashboard', async () => {
    const date = '2026-10-30';
    await withTx(async (client) => {
      await salesRepository.incrementDailySummary(client, date, 'CARD', 430_000, 45_000, 0, false, false);
      await salesRepository.incrementDailySummary(
        client,
        date,
        'CASH',
        3_200_000,
        0,
        35_000,
        false,
        false,
      );
    });
    await fullReturn(date, {
      paymentMethod: 'CASH',
      headerTotal: 3_235_000,
      headerDiscount: 0,
      amountPaid: 3_200_000,
      cost: 0,
    });
    const dash = await dashboard(date);
    expect(dash.byPaymentMethod).toEqual([{ paymentMethod: 'CARD', count: 1, totalAmount: 430_000 }]);
    expect(dash.totalAmount).toBe(430_000);
    expect(dash.totalDiscounts).toBe(0);
    expect(dash.totalSales).toBe(1);
    expect(await rawRow(date, 'CASH')).toBeUndefined();
    prove('dashboard-only-card-430000-after-cash-return', { dash });
  });

  it('healthy discounted CARD return reverses 395000 charged and 35000 discount', async () => {
    const date = '2026-10-04';
    await withTx(async (client) => {
      await salesRepository.incrementDailySummary(client, date, 'CARD', 395_000, 45_000, 35_000, false, false);
    });
    await fullReturn(date, {
      paymentMethod: 'CARD',
      headerTotal: 395_000,
      headerDiscount: 35_000,
      amountPaid: 395_000,
      cost: 45_000,
    });
    expect(await rawRow(date, 'CARD')).toBeUndefined();
    const dash = await dashboard(date);
    expect(dash.totalAmount).toBe(0);
    expect(dash.totalDiscounts).toBe(0);
    prove('healthy-discount-return-zeros-rollup', { dash });
  });

  it('Henber-class no-discount return stays qty×unit and leaves no leftover', async () => {
    const date = '2026-10-05';
    await withTx(async (client) => {
      await salesRepository.incrementDailySummary(client, date, 'CASH', 80_000, 50_000, 0, false, false);
    });
    await fullReturn(date, {
      paymentMethod: 'CASH',
      headerTotal: 80_000,
      headerDiscount: 0,
      amountPaid: 80_000,
      cost: 50_000,
    });
    expect(await rawRow(date, 'CASH')).toBeUndefined();
    prove('henber-no-discount-return-no-leftover', { dash: await dashboard(date) });
  });

  it('CREDIT underpay is not treated as a cart discount', async () => {
    const date = '2026-10-06';
    await withTx(async (client) => {
      await salesRepository.incrementDailySummary(client, date, 'CREDIT', 500_000, 0, 0, true, true);
    });
    const reverse = projectSaleRollupDecrement({
      paymentMethod: 'CREDIT',
      headerTotal: 500_000,
      headerDiscount: 0,
      amountPaid: 100_000,
    });
    expect(reverse.reverseAmount).toBe(500_000);
    expect(reverse.reverseDiscount).toBe(0);
    await withTx(async (client) => {
      await salesRepository.decrementDailySummary(
        client,
        date,
        'CREDIT',
        reverse.reverseAmount,
        0,
        reverse.reverseDiscount,
        true,
        true,
      );
    });
    expect(await rawRow(date, 'CREDIT')).toBeUndefined();
    prove('credit-underpay-not-wiped-discount', { reverse });
  });

  it('two CASH sales same day: returning the wiped one leaves the other intact', async () => {
    const date = '2026-10-08';
    await withTx(async (client) => {
      await salesRepository.incrementDailySummary(
        client,
        date,
        'CASH',
        3_200_000,
        100_000,
        35_000,
        false,
        false,
      );
      await salesRepository.incrementDailySummary(client, date, 'CASH', 100_000, 40_000, 0, false, false);
    });
    await fullReturn(date, {
      paymentMethod: 'CASH',
      headerTotal: 3_235_000,
      headerDiscount: 0,
      amountPaid: 3_200_000,
      cost: 100_000,
    });
    const row = await rawRow(date, 'CASH');
    const dash = await dashboard(date);
    expect(Number(row?.transaction_count)).toBe(1);
    expect(Number(row?.total_amount)).toBe(100_000);
    expect(Number(row?.total_discounts)).toBe(0);
    expect(dash.byPaymentMethod).toEqual([{ paymentMethod: 'CASH', count: 1, totalAmount: 100_000 }]);
    expect(dash.totalDiscounts).toBe(0);
    prove('same-day-remaining-cash-untouched', { row, dash });
  });

  it('empty 0-count 0-amount rows do not paint; leftover -35000 still would', async () => {
    const emptyDate = '2026-10-09';
    const leftoverDate = '2026-10-10';
    await db!.pool.query(
      `INSERT INTO sales_daily_summary (
          sale_date, payment_method, transaction_count, total_amount, total_cost,
          total_profit, total_discounts, credit_count, partial_payment_count, updated_at
       ) VALUES
         ($1, 'CASH', 0, 0, 0, 0, 0, 0, 0, NOW()),
         ($2, 'CASH', 0, -35000, 0, -35000, 35000, 0, 0, NOW())`,
      [emptyDate, leftoverDate],
    );
    const emptyDash = await dashboard(emptyDate);
    expect(emptyDash.byPaymentMethod).toEqual([]);
    const leftoverDash = await dashboard(leftoverDate);
    expect(leftoverDash.byPaymentMethod).toEqual([
      { paymentMethod: 'CASH', count: 0, totalAmount: -35_000 },
    ]);
    expect(leftoverDash.totalDiscounts).toBe(35_000);
    prove('empty-zero-row-hidden-leftover-visible', { emptyDash, leftoverDash });
  });

  it('rebuildDailySummary deletes orphan leftover rows with no COMPLETED sale', async () => {
    const date = '2026-10-07';
    await db!.pool.query(
      `INSERT INTO sales_daily_summary (
          sale_date, payment_method, transaction_count, total_amount, total_cost,
          total_profit, total_discounts, credit_count, partial_payment_count, updated_at
       ) VALUES ($1, 'CASH', 0, -35000, 0, -35000, 35000, 0, 0, NOW())`,
      [date],
    );
    expect(Number((await rawRow(date, 'CASH'))?.total_amount)).toBe(-35_000);
    await salesRepository.rebuildDailySummary(db!.pool);
    expect(await rawRow(date, 'CASH')).toBeUndefined();
    prove('rebuild-deletes-orphan-minus-35000', { date });
  });

  it('writes executed proof', () => {
    expect(evidence.length).toBe(9);
    const payload = {
      title: 'PROOF_SALE_RETURN_ROLLUP_SSOT',
      runAt: new Date().toISOString(),
      verdict: 'PASS',
      identity: {
        dashboard: 'sales_daily_summary via getSalesSummaryFromRollup',
        fullReturn: 'projectSaleRollupDecrement then decrementDailySummary',
        leftover: 'full return must leave 0 amount and 0 discount',
      },
      checks: evidence,
    };
    const json = JSON.stringify(payload, null, 2);
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
    writeFileSync(path.join(repoRoot, 'PROOF_SALE_RETURN_ROLLUP_SSOT.json'), json);
    writeFileSync(path.join(repoRoot, 'SamplePOS.Server/PROOF_SALE_RETURN_ROLLUP_SSOT.json'), json);
    writeFileSync(
      path.join(repoRoot, 'PROOF_SALE_RETURN_ROLLUP_SSOT.md'),
      [
        '# Full return daily-summary SSOT',
        '',
        `Run: ${payload.runAt}`,
        '',
        'Verdict: **PASS** — executed increment/decrement/dashboard on real Postgres.',
        '',
        '| Check | Result |',
        '|---|---|',
        ...evidence.map((row) => `| ${row.name} | PASS |`),
        '',
      ].join('\n'),
    );
  });
});
