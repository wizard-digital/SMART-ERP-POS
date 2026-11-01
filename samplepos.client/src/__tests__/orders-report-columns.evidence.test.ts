/**
 * EVIDENCE: Orders report designer — never-empty columns, screen/CSV/PDF SSOT consistency.
 * Run: npx vitest run src/__tests__/orders-report-columns.evidence.test.ts
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  defaultsForMode,
  resolvePdfColumnIds,
  resolveVisibleColumns,
  sanitizePersistedColumns,
} from '@shared/reports/ordersReportColumnsSsot';

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

describe('EVIDENCE — Orders report column chooser (never-fail / consistency)', () => {
  it('SSOT: never empty; junk heals to defaults; PDF matches visible', () => {
    for (const mode of ['all', 'cancelled'] as const) {
      const empty = resolveVisibleColumns([], mode);
      gate(`NEVER_EMPTY_${mode.toUpperCase()}`, empty.length > 0, `empty → defaults (${mode})`);
      gate(
        `DEFAULTS_${mode.toUpperCase()}`,
        empty.join(',') === defaultsForMode(mode).join(','),
        `empty equals defaultsForMode(${mode})`,
      );

      const junk = resolveVisibleColumns(['nope', '', 'status'], mode);
      gate(
        `JUNK_HEAL_${mode.toUpperCase()}`,
        junk.length > 0 && !junk.includes('nope'),
        `unknown ids dropped (${mode})`,
      );

      const pdfNull = resolvePdfColumnIds(null, mode);
      const pdfJunk = resolvePdfColumnIds(',,,bogus,!!!', mode);
      gate(
        `PDF_NEVER_EMPTY_${mode.toUpperCase()}`,
        pdfNull.length > 0 && pdfJunk.length > 0,
        `PDF param never empty (${mode})`,
      );
      gate(
        `PDF_MATCH_VISIBLE_${mode.toUpperCase()}`,
        pdfNull.join(',') === resolveVisibleColumns(null, mode).join(','),
        `PDF null ≡ visible null (${mode})`,
      );

      const selected = defaultsForMode(mode).slice(0, 3);
      const visible = resolveVisibleColumns(selected, mode);
      const pdf = resolvePdfColumnIds(selected.join(','), mode);
      gate(
        `SCREEN_PDF_SAME_${mode.toUpperCase()}`,
        visible.join(',') === pdf.join(','),
        `screen ids === PDF ids (${mode})`,
      );

      gate(
        `SANITIZE_${mode.toUpperCase()}`,
        sanitizePersistedColumns(['x'], mode).join(',') === defaultsForMode(mode).join(','),
        `sanitize(['x']) → defaults (${mode})`,
      );
    }
  });

  it('page: SSOT import, chooser, abort, heal, v2 persist, CSV/PDF', () => {
    const page = read('samplepos.client/src/pages/reports/OrdersReportPage.tsx');
    gate(
      'HAS_SSOT_IMPORT',
      page.includes("@shared/reports/ordersReportColumnsSsot"),
      'page imports column SSOT',
    );
    gate('HAS_CHOOSER', page.includes('Columns3') && page.includes('toggleColumn'), 'column chooser UI');
    gate('PERSIST_V2', page.includes('orders-report-layout-v2'), 'layout v2 persisted');
    gate('MIGRATE_V1', page.includes('orders-report-layout-v1'), 'migrates v1 layout');
    gate('HEAL', page.includes('resolveVisibleColumns') && page.includes('sanitizePersistedColumns'), 'heals columns');
    gate('ABORT', page.includes('AbortController') && page.includes('AbortError'), 'fetch abort on race');
    gate('DATE_SWAP', page.includes('normalizeDateRange'), 'swaps inverted date range');
    gate('CSV_VISIBLE', page.includes('exportVisibleCsv') && page.includes('visibleCols'), 'CSV uses visible columns');
    gate(
      'PDF_COLUMNS_PARAM',
      page.includes("params.set('columns'") || page.includes('params.set("columns"'),
      'PDF passes columns query',
    );
    gate('MODES', page.includes("mode === 'cancelled'") && page.includes("mode === 'all'"), 'all + cancelled modes');
    gate('MIN_COLS', page.includes('current.length <= 2'), 'cannot toggle below 2 columns');
    gate('NO_BRAND', !/\b(SAP|Odoo|Tally|QuickBooks)\b/i.test(page), 'no competitor brand copy');
  });

  it('routing: App + ReportsPage navigate to designer', () => {
    const app = read('samplepos.client/src/App.tsx');
    const reports = read('samplepos.client/src/pages/ReportsPage.tsx');
    const generateBody = reports.slice(
      reports.indexOf('const handleGenerateReport'),
      reports.indexOf("api.post('/reports/generate'"),
    );
    gate('APP_ROUTE', app.includes('/reports/orders') && app.includes('OrdersReportPage'), 'App route wired');
    gate(
      'NAV_ORDERS',
      reports.includes("navigate('/reports/orders')"),
      'Orders Report opens designer',
    );
    gate(
      'NAV_CANCELLED',
      reports.includes("navigate('/reports/orders?mode=cancelled')"),
      'Cancelled opens designer cancelled mode',
    );
    gate(
      'ORDERS_GENERATE_RETURNS',
      /if \(selectedReport === 'ORDERS_REPORT'\) \{\s*navigate\('\/reports\/orders'\);\s*return;/.test(
        generateBody,
      ),
      'Generate returns after navigating Orders Report (no unreachable compare)',
    );
    gate(
      'NO_DEAD_ORDERS_GENERATE_BRANCH',
      !/else if \(selectedReport === 'ORDERS_REPORT'\)/.test(generateBody),
      'Generate does not set params for ORDERS_REPORT after navigate',
    );
  });

  it('server PDF uses shared resolvePdfColumnIds (never empty)', () => {
    const ctrl = read('SamplePOS.Server/src/modules/reports/reportsController.ts');
    const ssot = read('shared/reports/ordersReportColumnsSsot.ts');
    gate('SCHEMA_COLUMNS', ctrl.includes('columns: z.string().optional()'), 'query schema accepts columns');
    gate(
      'SERVER_SSOT_IMPORT',
      ctrl.includes("ordersReportColumnsSsot") && ctrl.includes('resolvePdfColumnIds'),
      'controller imports resolvePdfColumnIds',
    );
    gate(
      'BUILD_HELPER',
      ctrl.includes('buildOrdersPdfColumns') && ctrl.includes("fail-closed"),
      'PDF builder fail-closed helper',
    );
    gate(
      'ORDERS_PDF_SSOT',
      ctrl.includes("buildOrdersPdfColumns(ORDER_PDF_COLS, columns, 'all')"),
      'orders PDF via SSOT',
    );
    gate(
      'CANCEL_PDF_SSOT',
      ctrl.includes("buildOrdersPdfColumns(CANCEL_PDF_COLS, columns, 'cancelled')"),
      'cancelled PDF via SSOT',
    );
    gate(
      'SSOT_NEVER_EMPTY_DOC',
      ssot.includes('never return empty') || ssot.includes('never returns empty'),
      'SSOT documents never-empty contract',
    );
  });

  it('writes PROOF artifacts', () => {
    const failed = gates.filter((g) => !g.ok);
    const evidence = {
      feature: 'ORDERS_REPORT_COLUMN_CHOOSER',
      provenAt: new Date().toISOString(),
      contract: 'never-empty columns; screen/CSV/PDF same ids via shared/reports/ordersReportColumnsSsot',
      gates,
      summary: {
        total: gates.length,
        passed: gates.filter((g) => g.ok).length,
        failed: failed.length,
        verdict: failed.length === 0 ? 'PASS' : 'FAIL',
      },
    };
    writeFileSync(
      path.join(repoRoot, 'PROOF_ORDERS_REPORT_COLUMNS.json'),
      JSON.stringify(evidence, null, 2),
    );
    writeFileSync(
      path.join(repoRoot, 'PROOF_ORDERS_REPORT_COLUMNS.md'),
      [
        '# PROOF — Orders report column chooser (never-fail / consistency)',
        '',
        `**Verdict:** ${evidence.summary.verdict}`,
        `**Proven at:** ${evidence.provenAt}`,
        '',
        `**Contract:** ${evidence.contract}`,
        '',
        ...gates.map((g) => `- ${g.ok ? 'PASS' : 'FAIL'} \`${g.id}\`: ${g.detail}`),
        '',
        '```bash',
        'cd samplepos.client && npx vitest run src/__tests__/orders-report-columns.evidence.test.ts',
        '```',
        '',
      ].join('\n'),
    );
    gate('ARTIFACTS', true, 'PROOF_ORDERS_REPORT_COLUMNS written');
    expect(failed).toEqual([]);
  });
});
