/**
 * Gift / FOC end-to-end on real Postgres: GL (no cash, no AR, no revenue; COGS posts)
 * and reports (billed revenue excludes GIFT; COGS includes gift cost).
 *
 * Skips LOUDLY if the local template copy is unavailable.
 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createScratchFromTemplate, journalByAccount, type TemplateScratch } from '../../test/realPgTemplate.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

let db: TemplateScratch | null = null;
let recordSaleToGL: typeof import('../../services/glEntryService.js').recordSaleToGL;
let salesRepository: typeof import('./salesRepository.js').salesRepository;
let reportsRepository: typeof import('../reports/reportsRepository.js').reportsRepository;

const here = path.dirname(fileURLToPath(import.meta.url));
const giftSqlPath = path.resolve(here, '../../../../shared/sql/643_sale_gift_foc.sql');

beforeAll(async () => {
  db = await createScratchFromTemplate();
  if (!db) {
    // eslint-disable-next-line no-console
    console.warn('\n*** saleGiftFoc.realpg: SKIPPED — local Postgres or sp_template_local missing. NOT verified. ***\n');
    return;
  }
  await db.pool.query(fs.readFileSync(giftSqlPath, 'utf8'));
  ({ recordSaleToGL } = await import('../../services/glEntryService.js'));
  ({ salesRepository } = await import('./salesRepository.js'));
  ({ reportsRepository } = await import('../reports/reportsRepository.js'));
});

afterAll(async () => {
  await db?.drop();
});

const maybe = (name: string, fn: () => Promise<void>) =>
  it(name, async () => {
    if (!db) return;
    await fn();
  });

async function insertSale(o: {
  method: string;
  total: number;
  cost: number;
  paid: number;
  gift?: number;
}): Promise<{ id: string; saleNumber: string }> {
  const id = randomUUID();
  const saleNumber = `SALE-GIFT-${o.method}-${id.slice(0, 6)}`;
  await db!.pool.query(
    `INSERT INTO sales (
       id, sale_number, subtotal, total_amount, total_cost, profit,
       payment_method, amount_paid, status, sale_date, gift_reason, gift_amount
     ) VALUES (
       $1, $2, $3, $3, $4, $7,
       $5::payment_method, $6, 'COMPLETED', '2026-10-28', $8, $9
     )`,
    [
      id,
      saleNumber,
      o.total,
      o.cost,
      o.method,
      o.paid,
      o.total - o.cost,
      o.gift || o.method === 'GIFT' ? 'Staff complimentary issue — E2E' : null,
      o.gift ?? (o.method === 'GIFT' ? o.total : 0),
    ],
  );
  return { id, saleNumber };
}

describe('SAP FD / FOC gift — real Postgres GL + reports', () => {
  maybe('GIFT posts COGS only: no 1010 cash, no 1200 AR, no 4000 revenue', async () => {
    const id = randomUUID();
    const saleNumber = `SALE-GIFT-GL-${id.slice(0, 6)}`;
    await recordSaleToGL(
      {
        saleId: id,
        saleNumber,
        saleDate: '2026-10-28',
        totalAmount: 40000,
        costAmount: 12000,
        actualInventoryCost: 12000,
        paymentMethod: 'GIFT',
        amountPaid: 0,
        taxAmount: 0,
        saleItems: [{ productType: 'inventory', totalPrice: 40000, unitCost: 12000, quantity: 1 }],
        paymentLines: [{ paymentMethod: 'GIFT', amount: 40000 }],
      } as unknown as Parameters<typeof recordSaleToGL>[0],
      db!.pool,
    );
    const revenue = await journalByAccount(db!.pool, { referenceType: 'SALE', referenceId: id });
    const cogs = await journalByAccount(db!.pool, { referenceType: 'SALE_COGS', referenceId: id });
    expect(revenue).toEqual([]);
    const byCode = Object.fromEntries(cogs.map((r) => [r.code, r]));
    expect(byCode['5000']?.debit).toBe(12000);
    expect(byCode['1300']?.credit).toBe(12000);
    expect(byCode['1010']).toBeUndefined();
    expect(byCode['1200']).toBeUndefined();
    expect(byCode['4000']).toBeUndefined();
  });

  maybe('sales summary and P&L exclude gift merchandise from billed revenue; COGS keeps gift cost', async () => {
    await insertSale({ method: 'CASH', total: 100000, cost: 40000, paid: 100000 });
    await insertSale({ method: 'GIFT', total: 25000, cost: 8000, paid: 0 });
    await insertSale({ method: 'CASH', total: 50000, cost: 10000, paid: 20000, gift: 30000 });

    const summary = await salesRepository.getSalesSummary(db!.pool, {
      startDate: '2026-10-20',
      endDate: '2026-10-30',
    });
    expect(summary.totalAmount).toBe(120000);
    expect(summary.totalSales).toBe(2);
    expect(summary.totalCost).toBe(58000);
    expect(summary.totalProfit).toBe(62000);
    expect(summary.giftAmount).toBe(55000);
    expect(summary.giftCount).toBe(2);

    const pnl = await reportsRepository.getProfitLossReport(db!.pool, {
      startDate: '2026-10-20',
      endDate: '2026-10-30',
      groupBy: 'day',
    });
    expect(pnl.summary.totalRevenue).toBe(120000);
    expect(pnl.summary.totalCOGS).toBe(58000);
    expect(pnl.summary.grossProfit).toBe(62000);

    const payments = await reportsRepository.getPaymentReport(db!.pool, {
      startDate: '2026-10-20',
      endDate: '2026-10-30',
    });
    expect(payments.some((r) => String(r.paymentMethod).toUpperCase() === 'GIFT')).toBe(false);
    const cashPay = payments.find((r) => String(r.paymentMethod).toUpperCase() === 'CASH');
    expect(cashPay?.totalAmount).toBe(120000);

    await salesRepository.rebuildDailySummary(db!.pool);
    const dashboard = await salesRepository.getSalesSummaryFromRollup(db!.pool, {
      startDate: '2026-10-20',
      endDate: '2026-10-30',
    });
    const live = await salesRepository.getSalesSummary(db!.pool, {
      startDate: '2026-10-20',
      endDate: '2026-10-30',
    });
    const salesReport = await reportsRepository.getSalesReport(db!.pool, {
      startDate: '2026-10-20',
      endDate: '2026-10-30',
      groupBy: 'day',
    });
    const payReport = await reportsRepository.getSalesReport(db!.pool, {
      startDate: '2026-10-20',
      endDate: '2026-10-30',
      groupBy: 'payment_method',
    });

    expect(dashboard.totalAmount).toBe(live.totalAmount);
    expect(dashboard.totalAmount).toBe(pnl.summary.totalRevenue);
    expect(dashboard.totalAmount).toBe(salesReport.summary.netRevenue);
    expect(dashboard.totalAmount).toBe(salesReport.summary.totalSales);
    expect(dashboard.totalCost).toBe(live.totalCost);
    expect(dashboard.totalCost).toBe(pnl.summary.totalCOGS);
    expect(dashboard.totalCost).toBe(salesReport.summary.totalCost);
    expect(dashboard.totalProfit).toBe(live.totalProfit);
    expect(dashboard.totalProfit).toBe(pnl.summary.grossProfit);
    expect(dashboard.totalProfit).toBe(salesReport.summary.grossProfit);
    expect(dashboard.totalSales).toBe(live.totalSales);
    expect(dashboard.totalSales).toBe(salesReport.summary.totalTransactions);
    expect(dashboard.giftAmount).toBe(live.giftAmount);
    expect(dashboard.giftAmount).toBe(55000);
    expect(dashboard.totalAmount).toBe(120000);

    const dashCash = (dashboard.byPaymentMethod as Array<{ paymentMethod: string; totalAmount: number }>).find(
      (r) => String(r.paymentMethod).toUpperCase() === 'CASH',
    );
    const dashGift = (dashboard.byPaymentMethod as Array<{ paymentMethod: string; totalAmount: number }>).find(
      (r) => String(r.paymentMethod).toUpperCase() === 'GIFT',
    );
    const reportCash = payReport.rows.find((r) => String(r.period).toUpperCase() === 'CASH');
    const reportGift = payReport.rows.find((r) => String(r.period).toUpperCase() === 'GIFT');
    expect(dashCash?.totalAmount).toBe(120000);
    expect(dashGift?.totalAmount).toBe(55000);
    expect(reportCash?.netRevenue).toBe(120000);
    expect(reportGift?.totalSales).toBe(55000);

    const proof = {
      title: 'PROOF_GIFT_DASHBOARD_REPORT_SSOT',
      runAt: new Date().toISOString(),
      verdict: 'PASS',
      identity: {
        dashboard: 'sales_daily_summary via getSalesSummaryFromRollup',
        liveSales: 'getSalesSummary billedRevenueSql',
        pnl: 'getProfitLossReport billedRevenueSql',
        salesReport: 'getSalesReport billedRevenueSql (header, not line prices)',
      },
      billedRevenue: 120000,
      giftMerchandise: 55000,
      cogsIncludingGift: 58000,
      dashboard,
      live,
      pnl: pnl.summary,
      salesReport: salesReport.summary,
    };
    const json = JSON.stringify(proof, null, 2);
    fs.writeFileSync(path.join(repoRoot, 'PROOF_GIFT_DASHBOARD_REPORT_SSOT.json'), json);
    fs.writeFileSync(path.join(repoRoot, 'SamplePOS.Server/PROOF_GIFT_DASHBOARD_REPORT_SSOT.json'), json);
    fs.writeFileSync(
      path.join(repoRoot, 'PROOF_GIFT_DASHBOARD_REPORT_SSOT.md'),
      [
        '# Gift FOC — dashboard KPI equals sales report',
        '',
        `Run: ${proof.runAt}`,
        '',
        'Dashboard (`sales_daily_summary`) billed revenue, gift merchandise, and COGS match live sales summary, P&L, and the sales report after rebuild. Mixed pay+gift does not inflate CASH on the dashboard or the report.',
        '',
        `- Billed revenue: ${proof.billedRevenue}`,
        `- Gift merchandise: ${proof.giftMerchandise}`,
        `- COGS (includes FOC): ${proof.cogsIncludingGift}`,
        '',
      ].join('\n'),
    );
  });
});
