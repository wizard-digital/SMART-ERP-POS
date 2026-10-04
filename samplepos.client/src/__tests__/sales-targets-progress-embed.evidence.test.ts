/**
 * EVIDENCE: Sales Targets progress is embedded on Sales/Dashboard (not a cashier silo),
 * reuses formatCurrency + KPI_ACCENT, and never recomputes revenue on the client.
 * Run: npx vitest run src/__tests__/sales-targets-progress-embed.evidence.test.ts
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '../../..');

type Gate = { id: string; ok: boolean; detail: string };
const gates: Gate[] = [];

function gate(id: string, ok: boolean, detail: string): void {
  gates.push({ id, ok, detail });
  expect({ id, ok, detail }).toEqual({ id, ok: true, detail });
}

function read(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

describe('EVIDENCE — Sales Targets progress embed + reuse SSOT', () => {
  const strip = read('samplepos.client/src/components/sales/SalesTargetProgressStrip.tsx');
  const sales = read('samplepos.client/src/pages/SalesPage.tsx');
  const dashboard = read('samplepos.client/src/pages/Dashboard.tsx');
  const layout = read('samplepos.client/src/components/Layout.tsx');
  const api = read('samplepos.client/src/utils/api.ts');
  const routes = read('SamplePOS.Server/src/modules/sales-targets/salesTargetRoutes.ts');
  const service = read('SamplePOS.Server/src/modules/sales-targets/salesTargetService.ts');
  const achievement = read(
    'SamplePOS.Server/src/modules/sales-targets/salesTargetAchievementService.ts',
  );

  it('progress API is server SSOT before /:id', () => {
    const progressIdx = routes.indexOf("'/progress'");
    const idIdx = routes.indexOf("'/:id'");
    gate('API_PROGRESS_ROUTE', progressIdx > 0, 'GET /progress registered');
    gate('API_PROGRESS_BEFORE_ID', progressIdx < idIdx, '/progress before /:id');
    gate(
      'SERVICE_GET_PROGRESS',
      service.includes('async getProgress(') && service.includes('calculateTargetAchievement'),
      'getProgress reuses calculateTargetAchievement',
    );
    gate(
      'SERVICE_TEAM_FALLBACK',
      service.includes("scope: 'self' | 'team'") && service.includes('getBusinessDate'),
      'managers fall back to team ACTIVE targets; business date SSOT',
    );
    gate(
      'MONEY_ROUND',
      achievement.includes("from '../../utils/money.js'") &&
        achievement.includes('Money.round'),
      'achievement precision uses Money.round SSOT',
    );
  });

  it('client strip fetches progress — no client revenue math', () => {
    gate(
      'API_CLIENT_PROGRESS',
      api.includes("sales-targets/progress") && api.includes('progress:'),
      'api.salesTargets.progress wired',
    );
    gate(
      'STRIP_FETCH',
      strip.includes('api.salesTargets.progress') &&
        strip.includes('data-sales-target-progress-strip'),
      'strip loads /progress',
    );
    gate(
      'STRIP_NO_REVENUE_MATH',
      !strip.includes('subtotal') &&
        !strip.includes('discount_amount') &&
        !strip.includes('eligibleSales') &&
        !/achievedAmount\s*[+\-*/]/.test(strip) &&
        !/remainingAmount\s*[+\-*/]/.test(strip),
      'strip does not recompute achievement from sales lines',
    );
    gate(
      'STRIP_CURRENCY_SSOT',
      strip.includes('formatCurrency') && !strip.includes('formatMoney'),
      'strip uses formatCurrency',
    );
    gate(
      'STRIP_KPI_SSOT',
      strip.includes('KPI_ACCENT_GRID_CLASS') && strip.includes('kpiAccentCardClass'),
      'strip reuses adaptive KPI_ACCENT',
    );
    gate(
      'STRIP_FIELDS',
      strip.includes('Target') &&
        strip.includes('Achieved') &&
        strip.includes('Remaining') &&
        strip.includes('Progress'),
      'strip surfaces Target / Achieved / Remaining / %',
    );
    gate(
      'STRIP_EMPTY_HINT',
      strip.includes('data-sales-target-progress-empty') &&
        strip.includes('ACTIVE'),
      'managers see empty hint on Sales when no ACTIVE target',
    );
  });

  it('embedded on Sales + Dashboard; nav demoted for cashiers', () => {
    gate(
      'SALES_EMBED',
      sales.includes('SalesTargetProgressStrip'),
      'SalesPage embeds progress strip',
    );
    gate(
      'DASHBOARD_EMBED',
      dashboard.includes('SalesTargetProgressStrip'),
      'Dashboard embeds progress strip',
    );
    const navBlockStart = layout.indexOf("path: '/sales/targets'");
    const navBlock = navBlockStart >= 0 ? layout.slice(navBlockStart, navBlockStart + 280) : '';
    gate(
      'NAV_MANAGE_ONLY',
      navBlock.includes('targets.manage') &&
        navBlock.includes('targets.approve') &&
        !navBlock.includes('targets.read') &&
        navBlock.includes('requiresSalesTargets'),
      'Layout Sales Targets nav is manage/approve + tenant flag (cashiers use Sales strip)',
    );
  });

  it('writes PROOF artifact', () => {
    const failed = gates.filter((g) => !g.ok);
    const evidence = {
      feature: 'SALES_TARGETS_PROGRESS_EMBED',
      provenAt: new Date().toISOString(),
      contract:
        'Cashiers see Target/Achieved/Remaining on Sales (and managers on Dashboard) via shared strip; achievement from GET /sales-targets/progress + Money.round; no client revenue duplicate math; manage nav only for targets.manage|approve',
      browserHarness: 'NOT_AVAILABLE — source/contract evidence only',
      gates,
      summary: {
        total: gates.length,
        passed: gates.filter((g) => g.ok).length,
        failed: failed.length,
      },
    };
    writeFileSync(
      path.join(repoRoot, 'PROOF_SALES_TARGETS_PROGRESS_EMBED.json'),
      JSON.stringify(evidence, null, 2),
    );
    writeFileSync(
      path.join(repoRoot, 'PROOF_SALES_TARGETS_PROGRESS_EMBED.md'),
      [
        '# Sales Targets Progress Embed',
        '',
        `Proven: ${evidence.provenAt}`,
        `Gates: ${evidence.summary.passed}/${evidence.summary.total}`,
        '',
        evidence.contract,
        '',
        ...gates.map((g) => `- ${g.ok ? 'PASS' : 'FAIL'} ${g.id}: ${g.detail}`),
        '',
      ].join('\n'),
    );
    gate('PROOF_WRITTEN', failed.length === 0, `failed=${failed.length}`);
  });
});
