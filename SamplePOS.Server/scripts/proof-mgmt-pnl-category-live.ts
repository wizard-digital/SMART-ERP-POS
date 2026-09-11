/**
 * Live proof: Sep 2026 Management P&L — category KPI vs GL net vs prior bug shape.
 *
 * npx tsx scripts/proof-mgmt-pnl-category-live.ts
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../src/db/pool.js';
import { getBusinessPerformanceReport } from '../src/services/businessReportService.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');
const repoRoot = path.resolve(serverRoot, '..');

type Gate = { id: string; ok: boolean; detail: string };
const gates: Gate[] = [];

function gate(id: string, ok: boolean, detail: string): void {
  gates.push({ id, ok, detail });
  if (!ok) console.error(`FAIL ${id}: ${detail}`);
  else console.log(`OK   ${id}: ${detail}`);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

async function main(): Promise<void> {
  const startDate = '2026-09-01';
  const endDate = '2026-09-30';

  const report = await getBusinessPerformanceReport({
    startDate,
    endDate,
    includeStockAdjustments: true,
    includeExpenses: true,
  });

  const catRev = round2(report.revenueByCategory.reduce((s, r) => s + r.totalRevenue, 0));
  const catCogs = round2(report.revenueByCategory.reduce((s, r) => s + r.totalCogs, 0));
  const catGp = round2(report.revenueByCategory.reduce((s, r) => s + r.grossProfit, 0));
  const moneyIn = round2(report.moneyIn.reduce((s, r) => s + r.totalAmount, 0));

  gate(
    'KPI_EQ_CATEGORY_REVENUE',
    round2(report.summary.totalRevenue) === catRev,
    `summary.totalRevenue ${report.summary.totalRevenue} === category sum ${catRev}`,
  );
  gate(
    'KPI_EQ_CATEGORY_COGS',
    round2(report.summary.totalCogs) === catCogs,
    `summary.totalCogs ${report.summary.totalCogs} === category sum ${catCogs}`,
  );
  gate(
    'KPI_EQ_CATEGORY_GP',
    round2(report.summary.grossProfit) === catGp,
    `summary.grossProfit ${report.summary.grossProfit} === category sum ${catGp}`,
  );
  gate(
    'REVENUE_POSITIVE_WHEN_SALES',
    report.summary.saleCount === 0 || report.summary.totalRevenue >= 0,
    `period sales revenue ${report.summary.totalRevenue} (sales ${report.summary.saleCount})`,
  );
  gate(
    'RETURNS_DISCLOSED',
    typeof report.summary.glSalesReturns === 'number' && report.summary.glSalesReturns >= 0,
    `glSalesReturns=${report.summary.glSalesReturns} glNetRevenue=${report.summary.glNetRevenue}`,
  );
  gate(
    'PRIOR_BUG_SHAPE_FIXED',
    !(report.summary.totalRevenue < 0 && catRev > 0),
    'Management Total Revenue is not negative while category rows are positive',
  );
  gate(
    'MONEY_IN_NEAR_SALES',
    moneyIn > 0 && Math.abs(moneyIn - report.summary.glSalesRevenue) < 5000,
    `Money In ${moneyIn} ≈ GL sales revenue ${report.summary.glSalesRevenue}`,
  );

  // Payment method consistency: CASH categories ⊆ all
  const cash = await getBusinessPerformanceReport({
    startDate,
    endDate,
    paymentMethod: 'CASH',
    includeStockAdjustments: true,
    includeExpenses: true,
  });
  gate(
    'PAYMENT_FILTER_SHRINKS_OR_EQ',
    cash.summary.totalRevenue <= report.summary.totalRevenue + 0.001 &&
      cash.summary.saleCount <= report.summary.saleCount,
    `CASH rev ${cash.summary.totalRevenue} / sales ${cash.summary.saleCount} ≤ ALL ${report.summary.totalRevenue} / ${report.summary.saleCount}`,
  );

  const out = {
    proof: 'mgmt-pnl-category-live',
    range: { startDate, endDate },
    generatedAt: new Date().toISOString(),
    summary: report.summary,
    categoryTotals: { revenue: catRev, cogs: catCogs, grossProfit: catGp },
    moneyIn,
    categories: report.revenueByCategory,
    cashFilter: {
      totalRevenue: cash.summary.totalRevenue,
      saleCount: cash.summary.saleCount,
    },
    gates,
    passed: gates.every((g) => g.ok),
  };

  const jsonName = 'PROOF_MGMT_PNL_CATEGORY_LIVE.json';
  const mdName = 'PROOF_MGMT_PNL_CATEGORY_LIVE.md';
  const md = [
    '# PROOF — Management P&L Category Live (Sep 2026)',
    '',
    `Generated: ${out.generatedAt}`,
    `Passed: ${out.passed}`,
    '',
    `Total Revenue (KPI): ${report.summary.totalRevenue}`,
    `Category sum: ${catRev}`,
    `GL sales / returns / net: ${report.summary.glSalesRevenue} / ${report.summary.glSalesReturns} / ${report.summary.glNetRevenue}`,
    `Gross Profit: ${report.summary.grossProfit}`,
    `Money In: ${moneyIn}`,
    '',
    ...gates.map((g) => `- [${g.ok ? 'x' : ' '}] **${g.id}**: ${g.detail}`),
    '',
  ].join('\n');

  for (const root of [serverRoot, repoRoot]) {
    writeFileSync(path.join(root, jsonName), `${JSON.stringify(out, null, 2)}\n`);
    writeFileSync(path.join(root, mdName), md);
  }

  if (!out.passed) {
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => undefined);
  });
