/**
 * EVIDENCE: Sales Targets UI matches ERP adaptive / Expenses design SSOT.
 * Run: npx vitest run src/__tests__/sales-targets-ui-ssot.evidence.test.ts
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

describe('EVIDENCE — Sales Targets UI design integrity SSOT', () => {
  const list = read('samplepos.client/src/pages/sales/SalesTargetsPage.tsx');
  const detail = read('samplepos.client/src/pages/sales/SalesTargetDetailPage.tsx');
  const app = read('samplepos.client/src/App.tsx');
  const layout = read('samplepos.client/src/components/Layout.tsx');
  const expenses = read('samplepos.client/src/pages/accounting/ExpensesPage.tsx');

  it('routes + nav wired with targets permissions', () => {
    gate('ROUTE_LIST', app.includes('path="/sales/targets"'), 'list route registered');
    gate('ROUTE_DETAIL', app.includes('path="/sales/targets/:id"'), 'detail route registered');
    gate(
      'ROUTE_PERMS',
      app.includes("requiredPermissions={['targets.read', 'targets.manage', 'targets.approve']}"),
      'ProtectedRoute uses targets.* permissions (any-of)',
    );
    gate(
      'NAV_ITEM',
      layout.includes("path: '/sales/targets'") &&
        layout.includes('targets.manage') &&
        layout.includes('targets.approve') &&
        layout.includes('requiresSalesTargets'),
      'Layout nav Sales Targets present (manage/approve + tenant flag)',
    );
  });

  it('list page uses AdaptivePage floorplan like Expenses', () => {
    gate('LIST_ADAPTIVE', list.includes('AdaptivePage'), 'SalesTargetsPage uses AdaptivePage');
    gate('LIST_TOOLBAR', list.includes('AdaptiveToolbar'), 'list uses AdaptiveToolbar');
    gate(
      'LIST_BACK',
      list.includes('ReportBackLink') && list.includes('Back to Sales'),
      'list uses ReportBackLink → /sales',
    );
    gate('LIST_BUTTON', list.includes("from '@/components/ui/button'"), 'list uses Button SSOT');
    gate('LIST_BADGE', list.includes("from '@/components/ui/badge'"), 'list uses Badge for status');
    gate(
      'LIST_CURRENCY',
      list.includes('formatCurrency') && !list.includes('formatMoney'),
      'list uses formatCurrency (not ad-hoc formatMoney)',
    );
    gate(
      'LIST_KPI_SSOT',
      list.includes('DASHBOARD_KPI_GRID_CLASS') && list.includes('data-sales-targets-kpis'),
      'list KPI strip uses adaptiveDashboard SSOT',
    );
    gate(
      'LIST_TOUCH',
      list.includes('min-h-[var(--layout-touch-target)]'),
      'list primary controls use touch-target token',
    );
    gate(
      'LIST_NO_WINDOW_PROMPT',
      !list.includes('window.prompt'),
      'list has no window.prompt',
    );
    // Expenses baseline contract
    gate('EXPENSES_BASELINE', expenses.includes('AdaptivePage') && expenses.includes('Badge'), 'Expenses SSOT still AdaptivePage+Badge');
  });

  it('detail page uses AdaptivePage + dialog cancel (no window.prompt)', () => {
    gate('DETAIL_ADAPTIVE', detail.includes('AdaptivePage'), 'detail uses AdaptivePage');
    gate(
      'DETAIL_BACK',
      detail.includes('ReportBackLink') && detail.includes('/sales/targets'),
      'detail back → Sales Targets',
    );
    gate('DETAIL_BUTTON', detail.includes("from '@/components/ui/button'"), 'detail uses Button');
    gate('DETAIL_BADGE', detail.includes('Badge'), 'detail status Badge');
    gate(
      'DETAIL_CURRENCY',
      detail.includes('formatCurrency') && !detail.includes('formatMoney'),
      'detail uses formatCurrency',
    );
    gate(
      'DETAIL_KPI',
      detail.includes('DASHBOARD_KPI_GRID_CLASS') && detail.includes('data-sales-targets-detail-kpis'),
      'detail KPI strip SSOT',
    );
    gate(
      'DETAIL_CANCEL_DIALOG',
      detail.includes('Dialog') &&
        detail.includes('data-sales-targets-cancel-dialog') &&
        !detail.includes('window.prompt'),
      'cancel uses Dialog (not window.prompt)',
    );
    gate(
      'DETAIL_ACTIONS',
      detail.includes('data-sales-targets-approve-action') &&
        detail.includes('data-sales-targets-submit-action'),
      'approve/submit action hooks present',
    );
    gate(
      'DETAIL_TOUCH',
      detail.includes('min-h-[var(--layout-touch-target)]'),
      'detail actions use touch-target token',
    );
  });

  it('role gating remains on create / approve surfaces', () => {
    gate(
      'LIST_MANAGE_GATE',
      list.includes("useCanAccess([], ['targets.manage'])"),
      'create gated on targets.manage',
    );
    gate(
      'DETAIL_APPROVE_GATE',
      detail.includes("useCanAccess([], ['targets.approve'])"),
      'approve gated on targets.approve',
    );
  });

  it('writes PROOF artifact', () => {
    const failed = gates.filter((g) => !g.ok);
    const evidence = {
      feature: 'SALES_TARGETS_UI_SSOT',
      provenAt: new Date().toISOString(),
      contract:
        'Sales Targets list/detail match AdaptivePage + Expenses patterns (Button, Badge, formatCurrency, ReportBackLink, touch targets, Dialog cancel)',
      browserHarness: 'NOT_AVAILABLE — no Playwright/Cypress in client package; this is source+contract evidence',
      gates,
      summary: {
        total: gates.length,
        passed: gates.filter((g) => g.ok).length,
        failed: failed.length,
      },
    };
    writeFileSync(
      path.join(repoRoot, 'PROOF_SALES_TARGETS_UI_SSOT.json'),
      JSON.stringify(evidence, null, 2),
    );
    writeFileSync(
      path.join(repoRoot, 'PROOF_SALES_TARGETS_UI_SSOT.md'),
      [
        '# Sales Targets UI SSOT',
        '',
        `Proven: ${evidence.provenAt}`,
        `Gates: ${evidence.summary.passed}/${evidence.summary.total}`,
        '',
        evidence.contract,
        '',
        `Browser: ${evidence.browserHarness}`,
        '',
        ...gates.map((g) => `- ${g.ok ? 'PASS' : 'FAIL'} ${g.id}: ${g.detail}`),
        '',
      ].join('\n'),
    );
    gate('PROOF_WRITTEN', failed.length === 0, `failed=${failed.length}`);
  });
});
