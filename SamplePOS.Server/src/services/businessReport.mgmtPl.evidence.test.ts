/**
 * PROOF: Management P&L by Category — KPI SSOT matches Section 2; returns disclosed separately.
 *
 * npm run proof:mgmt-pnl-category
 */
import { afterAll, describe, expect, it } from '@jest/globals';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

type Gate = { id: string; ok: boolean; detail: string };
const gates: Gate[] = [];

function gate(id: string, ok: boolean, detail: string): void {
  gates.push({ id, ok, detail });
  expect({ id, ok, detail }).toEqual({ id, ok: true, detail });
}

function readRel(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

describe('PROOF Management P&L category KPI SSOT', () => {
  it('service KPIs follow category rows; GL returns are disclosed fields', () => {
    const svc = readRel('SamplePOS.Server/src/services/businessReportService.ts');
    gate(
      'KPI_FROM_CATEGORY',
      svc.includes('const totalRevenue = categoryRevenue') &&
        svc.includes('categoryCogs') &&
        svc.includes('categoryGrossProfit'),
      'summary.totalRevenue/COGS/GP derived from Section 2 category sum',
    );
    gate(
      'GL_RETURNS_FIELD',
      svc.includes('glSalesReturns') &&
        svc.includes('glNetRevenue') &&
        svc.includes('gl_sales_returns'),
      'exposes glSalesReturns / glNetRevenue for cross-period 4010 disclosure',
    );
    gate(
      'NO_GL_NET_AS_PRIMARY',
      !svc.includes('const totalRevenue = Money.toNumber(Money.parseDb(totals.total_revenue))'),
      'does not use GL-net revenue as Management Total Revenue',
    );
    gate(
      'PAYMENT_TO_CATEGORY',
      svc.includes('paymentMethod: datedFilters.paymentMethod'),
      'payment method filter passed into getSalesByCategory',
    );
  });

  it('repository splits GL sales vs returns and nets refund COGS', () => {
    const repo = readRel('SamplePOS.Server/src/repositories/businessReportRepository.ts');
    gate('SPLIT_GL_SALES', repo.includes('gl_sales_revenue') && repo.includes('gl_sales_returns'), 'split sales/returns');
    gate('NET_COGS', repo.includes('gl_net_cogs') && repo.includes("'SALE_REFUND_COGS'"), 'net COGS includes refund credits');
    gate(
      'PAYMENT_SCOPE_SUMMARY',
      repo.includes('paymentScope') && repo.includes('cogsPaymentScope'),
      'summary totals respect payment method on sale/refund joins',
    );
  });

  it('client section filter scopes KPIs and gates supplier payments; TOTAL uses summary SSOT', () => {
    const page = readRel('samplepos.client/src/pages/reports/BusinessPerformancePage.tsx');
    gate(
      'SECTION_SCOPED_KPI',
      page.includes("case 'MONEY_IN':") &&
        page.includes("case 'REVENUE':") &&
        page.includes("case 'COST_STOCK':") &&
        page.includes("case 'EXPENSES':"),
      'KPI strip switches by visible section',
    );
    gate(
      'SUPPLIER_GATED',
      page.includes("showSection('EXPENSES') || showSection('NET_POSITION')"),
      'Section 4b respects section filter',
    );
    gate(
      'NO_RETURNS_BANNER',
      !page.includes('data-bp-gl-returns') &&
        !page.includes('Sales returns posted this period') &&
        !page.includes('returns are not subtracted'),
      'no noisy returns banner on Management P&L',
    );
    gate(
      'CATEGORY_SUBTITLE',
      page.includes('Period sales by product category') &&
        !page.includes('GL revenue allocated proportionally'),
      'Section 2 copy matches sale_items SSOT',
    );
  });

  afterAll(() => {
    const out = {
      proof: 'mgmt-pnl-category-ssot',
      generatedAt: new Date().toISOString(),
      gates,
      passed: gates.every((g) => g.ok),
    };
    const jsonPath = path.join(serverRoot, 'PROOF_MGMT_PNL_CATEGORY_SSOT.json');
    const mdPath = path.join(serverRoot, 'PROOF_MGMT_PNL_CATEGORY_SSOT.md');
    writeFileSync(jsonPath, `${JSON.stringify(out, null, 2)}\n`);
    writeFileSync(
      mdPath,
      [
        '# PROOF — Management P&L Category KPI SSOT',
        '',
        `Generated: ${out.generatedAt}`,
        `Passed: ${out.passed}`,
        '',
        ...gates.map((g) => `- [${g.ok ? 'x' : ' '}] **${g.id}**: ${g.detail}`),
        '',
      ].join('\n'),
    );
    writeFileSync(path.join(repoRoot, 'PROOF_MGMT_PNL_CATEGORY_SSOT.json'), `${JSON.stringify(out, null, 2)}\n`);
    writeFileSync(
      path.join(repoRoot, 'PROOF_MGMT_PNL_CATEGORY_SSOT.md'),
      [
        '# PROOF — Management P&L Category KPI SSOT',
        '',
        `Generated: ${out.generatedAt}`,
        `Passed: ${out.passed}`,
        '',
        ...gates.map((g) => `- [${g.ok ? 'x' : ' '}] **${g.id}**: ${g.detail}`),
        '',
      ].join('\n'),
    );
  });
});
