/**
 * PROOF: Adaptive reports responsive integrity + consumer consistency.
 *
 * Proves SSOT policy, Management P&L / hub wiring, and that no AdaptiveReportShell
 * consumer reintroduces "totals-only" / buried-primary-filter antipatterns.
 *
 * Reproduce:
 *   npm run proof:adaptive-reports-responsive
 *   (repo root) OR from samplepos.client:
 *   npx vitest run src/__tests__/adaptive-reports-responsive.evidence.test.ts
 */
import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REPORT_FILTER_PRIMARY_CLASS,
  REPORT_KPI_VALUE_CLASS,
  REPORT_PAGE_FRAME_CLASS,
  resolveReportDatePickersMode,
  resolveReportDetailCollapsedDefault,
  resolveReportDetailMode,
  resolveReportFiltersCollapsedDefault,
  resolveReportSecondaryFiltersCollapsedDefault,
  resolveReportSummaryColumns,
  selectReportMetrics,
} from '../lib/adaptiveReports';

const here = dirname(fileURLToPath(import.meta.url));
const clientRoot = resolve(here, '../..');
const repoRoot = resolve(clientRoot, '..');

type Gate = { id: string; ok: boolean; detail: string };
const gates: Gate[] = [];

function gate(id: string, ok: boolean, detail: string): void {
  gates.push({ id, ok, detail });
  expect({ id, ok, detail }).toEqual({ id, ok: true, detail });
}

function read(rel: string): string {
  return readFileSync(resolve(clientRoot, 'src', rel), 'utf8');
}

const SHELL_CONSUMERS = [
  'pages/reports/BusinessPerformancePage.tsx',
  'pages/reports/ExpenseReportsPage.tsx',
  'pages/reports/SalesAnalysisReportPage.tsx',
  'pages/reports/OrdersReportPage.tsx',
  'pages/accounting/AgedBalancePage.tsx',
  'pages/accounting/TrialBalancePage.tsx',
  'pages/reports/inventory/StoreIssueAuditReportPage.tsx',
] as const;

describe('PROOF: adaptive report SSOT integrity', () => {
  it('tier matrix: columns / modes / collapse / date pickers', () => {
    const colMatrix = {
      mobile: resolveReportSummaryColumns('mobile'),
      compact: resolveReportSummaryColumns('compact'),
      desktop: resolveReportSummaryColumns('desktop'),
      wide: resolveReportSummaryColumns('wide'),
    };
    gate('KPI_COLS_MATRIX', JSON.stringify(colMatrix) === '{"mobile":1,"compact":2,"desktop":4,"wide":6}', JSON.stringify(colMatrix));

    const modeMatrix = {
      mobile: resolveReportDetailMode('mobile'),
      compact: resolveReportDetailMode('compact'),
      desktop: resolveReportDetailMode('desktop'),
    };
    gate(
      'DETAIL_MODE_MATRIX',
      JSON.stringify(modeMatrix) === '{"mobile":"cards","compact":"reduced","desktop":"table"}',
      JSON.stringify(modeMatrix),
    );

    for (const tier of ['mobile', 'compact', 'desktop', 'wide'] as const) {
      gate(
        `BODY_OPEN_${tier.toUpperCase()}`,
        resolveReportDetailCollapsedDefault(tier) === false,
        `${tier}: body never collapsed`,
      );
      gate(
        `PRIMARY_OPEN_${tier.toUpperCase()}`,
        resolveReportFiltersCollapsedDefault(tier) === false,
        `${tier}: primary filters never collapsed`,
      );
    }

    gate(
      'SECONDARY_ONLY_MOBILE',
      resolveReportSecondaryFiltersCollapsedDefault('mobile') === true &&
        resolveReportSecondaryFiltersCollapsedDefault('compact') === false &&
        resolveReportSecondaryFiltersCollapsedDefault('desktop') === false,
      'More options collapses on mobile only',
    );

    gate(
      'DATE_PICKERS_MATRIX',
      resolveReportDatePickersMode('mobile') === 'custom' &&
        resolveReportDatePickersMode('compact') === 'custom' &&
        resolveReportDatePickersMode('desktop') === 'always' &&
        resolveReportDatePickersMode('wide') === 'always',
      'custom pickers on phone/compact; always on desk',
    );

    gate(
      'FRAME_TIGHT_GUTTERS',
      REPORT_PAGE_FRAME_CLASS.includes('p-3') &&
        REPORT_PAGE_FRAME_CLASS.includes('sm:p-4') &&
        REPORT_PAGE_FRAME_CLASS.includes('md:p-6'),
      REPORT_PAGE_FRAME_CLASS,
    );
    gate(
      'PRIMARY_GRID',
      REPORT_FILTER_PRIMARY_CLASS.includes('grid-cols-1') &&
        REPORT_FILTER_PRIMARY_CLASS.includes('sm:grid-cols-2'),
      REPORT_FILTER_PRIMARY_CLASS,
    );
    gate(
      'KPI_VALUE_READABLE',
      REPORT_KPI_VALUE_CLASS.includes('text-base') &&
        REPORT_KPI_VALUE_CLASS.includes('break-words'),
      REPORT_KPI_VALUE_CLASS,
    );
  });

  it('metric selection is consistent (primary-only on mobile)', () => {
    const metrics = [
      { id: 'a', priority: 'primary' as const },
      { id: 'b', priority: 'secondary' as const },
      { id: 'c', priority: 'primary' as const },
    ];
    gate(
      'SELECT_MOBILE_PRIMARY',
      selectReportMetrics(metrics, 'mobile').map((m) => m.id).join(',') === 'a,c',
      'mobile keeps primary metrics only',
    );
    gate(
      'SELECT_DESK_ALL',
      selectReportMetrics(metrics, 'desktop').map((m) => m.id).join(',') === 'a,b,c',
      'desktop keeps all metrics',
    );
  });

  it('SSOT forbids brand/UA forks', () => {
    const src = read('lib/adaptiveReports.ts');
    gate('NO_BRAND_FORK', src.includes('never UA / Sunmi brand'), 'doc forbids brand layout forks');
    gate('NO_UA_FORK', !/userAgent|navigator\.platform/i.test(src), 'no UA/platform runtime forks');
    gate(
      'ENTERPRISE_BODY_RULE',
      src.includes('ALWAYS visible after load') && src.includes('Primary filters'),
      'SSOT documents primary filters + always-visible body',
    );
  });
});

describe('PROOF: shell + filter components', () => {
  it('AdaptiveReportShell always renders body; falls back cards→table', () => {
    const shell = read('components/adaptive/AdaptiveReportShell.tsx');
    gate(
      'SHELL_BODY_VISIBLE',
      shell.includes('data-report-body-visible="true"') &&
        shell.includes('data-report-detail-body') &&
        shell.includes('cards ?? reducedTable ?? table'),
      'body always mounted; cards fall back to table',
    );
    gate(
      'SHELL_NO_ACCORDION',
      !shell.includes('ChevronRight') &&
        !shell.includes('resolveReportDetailCollapsedDefault') &&
        !shell.includes('aria-expanded'),
      'Details accordion removed from shell',
    );
  });

  it('AdaptiveReportFilters: primary always, secondary progressive', () => {
    const filters = read('components/adaptive/AdaptiveReportFilters.tsx');
    gate(
      'FILTERS_PRIMARY_PROP',
      filters.includes('primary: ReactNode') && filters.includes('data-report-filters-primary'),
      'primary slot required',
    );
    gate(
      'FILTERS_SECONDARY_PROP',
      filters.includes('secondary?: ReactNode') &&
        filters.includes('resolveReportSecondaryFiltersCollapsedDefault'),
      'secondary uses More options only',
    );
    gate(
      'FILTERS_PRIMARY_FORCED_OPEN',
      filters.includes('data-report-filters-collapsed="false"'),
      'primary bar never marks collapsed',
    );
  });
});

describe('PROOF: consumer consistency matrix', () => {
  it('every AdaptiveReportShell consumer stays on shell; no totals-only stub copy', () => {
    for (const rel of SHELL_CONSUMERS) {
      const src = read(rel);
      const id = rel.split('/').pop()!.replace(/\.tsx$/, '').toUpperCase();
      gate(`CONSUMER_${id}_SHELL`, src.includes('AdaptiveReportShell'), `${rel} uses AdaptiveReportShell`);
      gate(
        `CONSUMER_${id}_NO_DESKTOP_ONLY_STUB`,
        !src.includes('Expand Details on larger screens'),
        `${rel} does not tell users to switch to desktop for the report body`,
      );
    }
  });

  it('Management P&L: primary filters + real sections + frame SSOT', () => {
    const src = read('pages/reports/BusinessPerformancePage.tsx');
    gate(
      'BP_PRIMARY_SECTION',
      src.includes('primary={') && src.includes('data-bp-section') && src.includes('htmlFor="bp-section"'),
      'Section always in primary',
    );
    gate('BP_PRIMARY_PAYMENT', src.includes('data-bp-payment="true"'), 'Payment Method primary');
    gate(
      'BP_SECONDARY_TOGGLES',
      src.includes('secondary={') &&
        src.includes('Include Stock Adjustments') &&
        src.includes('Include Expenses'),
      'include toggles secondary',
    );
    gate('BP_NO_BURIED_LABEL', !src.includes('Date & filters'), 'no buried Date & filters chip');
    gate('BP_FRAME', src.includes('REPORT_PAGE_FRAME_CLASS'), 'REPORT_PAGE_FRAME_CLASS');
    gate(
      'BP_PICKERS',
      src.includes('resolveReportDatePickersMode') && src.includes('pickersMode={datePickersMode}'),
      'tier-driven date pickers',
    );
    gate(
      'BP_SECTIONS_BODY',
      src.includes('data-bp-detail="sections"') && !src.includes('cards={'),
      'mobile falls through to real P&L sections (no KPI-only cards prop)',
    );
    gate(
      'BP_HAS_MONEY_IN',
      src.includes("showSection('MONEY_IN')") && src.includes('Section 1 — Money In'),
      'Money In section present in body',
    );
  });

  it('Reports hub title stacks above shortcuts on small screens', () => {
    const src = read('pages/ReportsPage.tsx');
    const headerSlice = src.slice(
      src.indexOf('Reports & Analytics') - 400,
      src.indexOf('Reports & Analytics') + 1400,
    );
    gate(
      'HUB_TITLE_STACK',
      headerSlice.includes('flex-col') &&
        headerSlice.includes('lg:flex-row') &&
        headerSlice.includes('w-full') &&
        !/className="[^"]*flex items-center justify-between/.test(headerSlice),
      'title is column-first — not crushed beside chips',
    );
    gate(
      'HUB_SHORTCUTS_WRAP',
      headerSlice.includes('data-reports-shortcuts') && headerSlice.includes('flex-wrap'),
      'shortcut chips wrap under title',
    );
  });

  it('Expense + Aged use tight frame; Expense tabular path has real rows cards', () => {
    const expense = read('pages/reports/ExpenseReportsPage.tsx');
    const aged = read('pages/accounting/AgedBalancePage.tsx');
    gate(
      'EXPENSE_FRAME',
      expense.includes('REPORT_PAGE_FRAME_CLASS') && expense.includes('pickersMode="custom"'),
      'Expense frame + custom date pickers',
    );
    gate(
      'EXPENSE_ROWS_CARDS',
      expense.includes('data-expense-report-detail="cards"') ||
        expense.includes('data-expense-report-detail="table"'),
      'Expense report has detail markers',
    );
    gate('AGED_FRAME', aged.includes('REPORT_PAGE_FRAME_CLASS'), 'Aged balances frame');
    gate(
      'AGED_ENTITY_CARDS',
      aged.includes('data-aged-detail="cards"') && aged.includes('entities.map'),
      'Aged mobile cards are entity rows, not KPI clones',
    );
  });
});

afterAll(() => {
  const passed = gates.filter((g) => g.ok).length;
  const payload = {
    feature: 'ADAPTIVE_REPORTS_RESPONSIVE',
    verdict: passed === gates.length ? 'PASS' : 'FAIL',
    passed,
    total: gates.length,
    integrity: {
      ssot: 'samplepos.client/src/lib/adaptiveReports.ts',
      shell: 'samplepos.client/src/components/adaptive/AdaptiveReportShell.tsx',
      filters: 'samplepos.client/src/components/adaptive/AdaptiveReportFilters.tsx',
      consumers: [...SHELL_CONSUMERS],
      invariants: [
        'Primary filters always visible',
        'Report body always visible (no Details accordion)',
        'No brand/UA layout forks',
        'Hub title stacks above shortcuts on narrow viewports',
        'P&L mobile shows real sections via table fallback',
      ],
    },
    gates,
    generatedAt: new Date().toISOString(),
  };
  const md =
    `# PROOF_ADAPTIVE_REPORTS_RESPONSIVE\n\nVerdict: **${payload.verdict}** (${passed}/${gates.length})\n\n` +
    `## Integrity invariants\n\n` +
    payload.integrity.invariants.map((i) => `- ${i}`).join('\n') +
    `\n\n## Consumers\n\n` +
    payload.integrity.consumers.map((c) => `- \`${c}\``).join('\n') +
    `\n\n## Gates\n\n` +
    gates.map((g) => `- ${g.ok ? 'PASS' : 'FAIL'} \`${g.id}\`: ${g.detail}`).join('\n') +
    `\n\n## Reproduce\n\n\`\`\`bash\nnpm run proof:adaptive-reports-responsive\n\`\`\`\n`;
  for (const root of [repoRoot, clientRoot]) {
    writeFileSync(
      resolve(root, 'PROOF_ADAPTIVE_REPORTS_RESPONSIVE.json'),
      `${JSON.stringify(payload, null, 2)}\n`,
    );
    writeFileSync(resolve(root, 'PROOF_ADAPTIVE_REPORTS_RESPONSIVE.md'), md);
  }
});
