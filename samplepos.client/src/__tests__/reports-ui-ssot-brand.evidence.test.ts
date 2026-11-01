/**
 * EVIDENCE: Reports UI — no competitor-brand copy; SSOT skip gate; no dual-fetch aging.
 *
 * Proves only what the source trees assert. Does NOT claim live GL math accuracy
 * (that requires a separate API/DB proof run with known fixtures).
 *
 * Run: npx vitest run src/__tests__/reports-ui-ssot-brand.evidence.test.ts
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '../../..');
const clientSrc = path.join(repoRoot, 'samplepos.client/src');

type Gate = { id: string; ok: boolean; detail: string; evidence?: string };
const gates: Gate[] = [];

function gate(id: string, ok: boolean, detail: string, evidence?: string): void {
  gates.push({ id, ok, detail, evidence });
  expect({ id, ok, detail }).toEqual({ id, ok: true, detail });
}

function read(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

/** Competitor / style brand tokens — whole-word, case-insensitive. */
const BRAND_RE =
  /\b(?:SAP|Odoo|Tally|QuickBooks|Quickbooks)\b|\bQBO\b|(?<![A-Za-z])QB(?![A-Za-z])/gi;

function collectFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) collectFiles(full, out);
    else if (/\.(tsx|ts)$/.test(name)) out.push(full);
  }
  return out;
}

function brandHits(text: string): Array<{ match: string; line: number }> {
  const hits: Array<{ match: string; line: number }> = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m: RegExpExecArray | null;
    const re = new RegExp(BRAND_RE.source, BRAND_RE.flags);
    while ((m = re.exec(line))) {
      hits.push({ match: m[0], line: i + 1 });
    }
  }
  return hits;
}

const REPORT_UI_GLOBS = [
  'samplepos.client/src/pages/ReportsPage.tsx',
  'samplepos.client/src/components/reports',
  'samplepos.client/src/pages/reports',
  'samplepos.client/src/config/inventoryReportCatalog.ts',
];

describe('EVIDENCE — Reports UI SSOT + brand-free', () => {
  it('G1: zero competitor-brand tokens in report UI source trees', () => {
    const files: string[] = [];
    for (const rel of REPORT_UI_GLOBS) {
      const abs = path.join(repoRoot, rel);
      const st = statSync(abs);
      if (st.isDirectory()) {
        for (const f of collectFiles(abs)) {
          files.push(path.relative(repoRoot, f).replace(/\\/g, '/'));
        }
      } else {
        files.push(rel.replace(/\\/g, '/'));
      }
    }

    const allHits: Array<{ file: string; match: string; line: number }> = [];
    for (const file of files) {
      const text = read(file);
      for (const h of brandHits(text)) {
        allHits.push({ file, ...h });
      }
    }

    gate(
      'BRAND_FREE_REPORT_UI',
      allHits.length === 0,
      `scanned ${files.length} files; brand hits=${allHits.length}`,
      allHits.length ? JSON.stringify(allHits.slice(0, 20)) : undefined,
    );
  });

  it('G2: isSsotReportType is the sole generic summary/table skip gate', () => {
    const page = read('samplepos.client/src/pages/ReportsPage.tsx');

    gate(
      'HAS_IS_SSOT_HELPER',
      /function isSsotReportType\(/.test(page),
      'isSsotReportType defined',
    );

    const summarySkip = page.includes('!isSsotReportType(reportData.reportType) &&\n          reportData.summary');
    const summarySkipAlt = /!isSsotReportType\(reportData\.reportType\)\s*&&\s*[\s\S]{0,80}reportData\.summary/.test(
      page,
    );
    gate('SUMMARY_GATED', summarySkip || summarySkipAlt, 'generic summary gated by isSsotReportType');

    const tableSkip = /Standard Data Table[\s\S]{0,200}!isSsotReportType\(reportData\.reportType\)/.test(
      page,
    );
    gate('TABLE_GATED', tableSkip, 'generic data table gated by isSsotReportType');

    // Legacy multi-OR skip must not remain (duplication risk / drift)
    gate(
      'NO_LEGACY_OR_SKIP',
      !/reportData\.reportType !== 'DAILY_CASH_FLOW' &&\s*\n\s*reportData\.reportType !== 'PROFIT_LOSS'/.test(
        page,
      ),
      'no legacy DAILY_CASH_FLOW||PROFIT_LOSS||… OR-chain skip',
    );
  });

  it('G3: every dedicated reportType renderer is covered by an SSOT set', () => {
    const page = read('samplepos.client/src/pages/ReportsPage.tsx');

    const extractSet = (name: string): string[] => {
      const m = page.match(
        new RegExp(`const ${name} = new Set(?:<[^>]+>)?\\(\\[([\\s\\S]*?)\\]\\)`),
      );
      if (!m) return [];
      return [...m[1].matchAll(/'([A-Z0-9_]+)'/g)].map((x) => x[1]);
    };

    const customer = extractSet('CUSTOMER_SSOT_REPORTS');
    const supplier = extractSet('SUPPLIER_SSOT_REPORTS');
    const financial = extractSet('FINANCIAL_SSOT_REPORTS');
    const covered = new Set([...customer, ...supplier, ...financial]);

    gate('CUSTOMER_SSOT_NONEMPTY', customer.length >= 5, `customer SSOT count=${customer.length}`);
    gate('SUPPLIER_SSOT_HAS_STATEMENT', supplier.includes('SUPPLIER_STATEMENT'), 'SUPPLIER_STATEMENT in set');
    gate('SUPPLIER_SSOT_HAS_AP', supplier.includes('AP_LEDGER'), 'AP_LEDGER in set');
    gate('FINANCIAL_HAS_PAYMENT', financial.includes('PAYMENT_REPORT'), 'PAYMENT_REPORT in set');
    gate('FINANCIAL_HAS_PL', financial.includes('PROFIT_LOSS'), 'PROFIT_LOSS in set');
    gate('FINANCIAL_HAS_CASHFLOW', financial.includes('DAILY_CASH_FLOW'), 'DAILY_CASH_FLOW in set');

    // Dedicated renderers: reportData.reportType === 'X'
    const dedicated = [
      ...page.matchAll(/reportData\.reportType === '([A-Z0-9_]+)'/g),
    ].map((m) => m[1]);
    const uniqueDedicated = [...new Set(dedicated)];

    // Supplemental-only sections (still use generic table for primary rows) — documented exclusions
    const supplementalOnly = new Set([
      'SUPPLIER_PAYMENT_STATUS', // payments nested detail
    ]);

    const missing: string[] = [];
    for (const t of uniqueDedicated) {
      if (supplementalOnly.has(t)) continue;
      if (!covered.has(t)) missing.push(t);
    }

    gate(
      'DEDICATED_COVERED_BY_SSOT',
      missing.length === 0,
      `dedicated=${uniqueDedicated.length}; missing=${missing.length}`,
      missing.length ? missing.join(',') : uniqueDedicated.join(','),
    );
  });

  it('G4: Customer Aging uses stub envelope — no /reports/generate dual-fetch', () => {
    const page = read('samplepos.client/src/pages/ReportsPage.tsx');

    const agingBlock = page.includes("if (selectedReport === 'CUSTOMER_AGING_REPORT')") &&
      page.includes("reportType: 'CUSTOMER_AGING_REPORT'") &&
      page.includes('Customer Aging Report');

    gate('AGING_SHORT_CIRCUIT', agingBlock, 'aging sets local stub before API generate');

    // Ensure generate API is not reached for aging: return precedes api.post in that branch
    const idx = page.indexOf("if (selectedReport === 'CUSTOMER_AGING_REPORT')");
    const slice = page.slice(idx, idx + 800);
    gate(
      'AGING_RETURNS_BEFORE_POST',
      /return;\s*\}/.test(slice) && !slice.includes("api.post('/reports/generate'"),
      'aging branch returns before generate POST',
    );

    gate(
      'AGING_HEADER_SUPPRESSED',
      /reportData\.reportType !== 'CUSTOMER_AGING_REPORT' && \(/.test(page) ||
        /reportData\.reportType !== 'CUSTOMER_AGING_REPORT' && \(/.test(page.replace(/\s+/g, ' ')),
      'blue records header skipped for aging',
    );

    gate(
      'AGING_USES_COMPONENT',
      page.includes('<CustomerAgingReport') || page.includes('<CustomerAgingReport />'),
      'CustomerAgingReport is the SSOT UI',
    );
  });

  it('G5: Supplier Statement uses searchable combobox + partner-ledger renderer', () => {
    const page = read('samplepos.client/src/pages/ReportsPage.tsx');
    const combo = read(
      'samplepos.client/src/components/reports/ReportSupplierCombobox.tsx',
    );

    gate('HAS_SUPPLIER_COMBOBOX', combo.includes('ReportSupplierCombobox'), 'combobox component exists');
    gate(
      'COMBO_WIRED',
      page.includes("import ReportSupplierCombobox") &&
        page.includes('<ReportSupplierCombobox'),
      'ReportsPage imports and renders ReportSupplierCombobox',
    );
    gate(
      'SUPPLIER_NARROWS_NULL',
      page.includes("supportsFilters.includes('supplier') && selectedReport &&"),
      'supplier combobox skipped when selectedReport is null',
    );
    gate(
      'CUSTOMER_NARROWS_NULL',
      page.includes("supportsFilters.includes('customer') && selectedReport &&"),
      'customer combobox skipped when selectedReport is null',
    );
    gate(
      'SUPPLIER_REQUIRED',
      page.includes("SUPPLIER_REQUIRED_REPORTS") &&
        page.includes("'SUPPLIER_STATEMENT'"),
      'supplier required for statement',
    );
    gate(
      'SUPPLIER_STATEMENT_UI',
      page.includes("reportData.reportType === 'SUPPLIER_STATEMENT'"),
      'dedicated supplier statement renderer',
    );
    gate(
      'NO_PLAIN_SELECT_FOR_STATEMENT',
      !/selectedReport === 'SUPPLIER_STATEMENT'[\s\S]{0,400}<select/.test(page),
      'no plain <select> path for supplier statement',
    );
  });

  it('G6: server supplier statement PDF + client reportType alignment for returns', () => {
    const ctrl = read(
      'SamplePOS.Server/src/modules/reports/cnDnReportController.ts',
    );

    gate(
      'SUPPLIER_STMT_PDF',
      ctrl.includes('getSupplierStatement') &&
        ctrl.includes("format === 'pdf'") &&
        ctrl.includes('Supplier Account Statement'),
      'supplier statement PDF branch present',
    );
    gate(
      'SALES_RETURNS_TYPE',
      ctrl.includes("envelope(\n        'SALES_RETURNS_ALLOWANCES'") ||
        ctrl.includes("envelope(\r\n        'SALES_RETURNS_ALLOWANCES'") ||
        /envelope\(\s*'SALES_RETURNS_ALLOWANCES'/.test(ctrl),
      'sales returns envelope uses client ReportType',
    );
    gate(
      'PURCHASE_RETURNS_TYPE',
      /envelope\(\s*'PURCHASE_RETURNS_ALLOWANCES'/.test(ctrl),
      'purchase returns envelope uses client ReportType',
    );
  });

  it('writes PROOF artifacts', () => {
    const failed = gates.filter((g) => !g.ok);
    const evidence = {
      feature: 'REPORTS_UI_SSOT_BRAND_FREE',
      provenAt: new Date().toISOString(),
      scope: {
        in: [
          'Competitor-brand token absence in report UI source',
          'isSsotReportType gates generic summary + table',
          'Dedicated renderers ⊆ SSOT sets (with documented supplemental exclusions)',
          'Customer Aging single-fetch short-circuit',
          'Supplier combobox + statement renderer wiring',
          'Server envelope/PDF structural alignment',
        ],
        out: [
          'Live numeric accuracy of GL balances / P&L totals (requires API+DB fixture proof)',
          'Non-report modules elsewhere in the app',
        ],
      },
      gates,
      summary: {
        total: gates.length,
        passed: gates.filter((g) => g.ok).length,
        failed: failed.length,
        verdict: failed.length === 0 ? 'PASS' : 'FAIL',
      },
    };

    writeFileSync(
      path.join(repoRoot, 'PROOF_REPORTS_UI_SSOT_BRAND.json'),
      JSON.stringify(evidence, null, 2),
      'utf8',
    );

    const md = [
      '# PROOF — Reports UI SSOT + brand-free',
      '',
      `**Verdict:** ${evidence.summary.verdict}`,
      `**Proven at:** ${evidence.provenAt}`,
      `**Gates:** ${evidence.summary.passed}/${evidence.summary.total} passed`,
      '',
      '## What this proves',
      ...evidence.scope.in.map((x) => `- ${x}`),
      '',
      '## Explicitly NOT proven',
      ...evidence.scope.out.map((x) => `- ${x}`),
      '',
      '## Gate results',
      '| ID | OK | Detail |',
      '|----|----|--------|',
      ...gates.map(
        (g) =>
          `| ${g.id} | ${g.ok ? 'PASS' : 'FAIL'} | ${g.detail.replace(/\|/g, '\\|')} |`,
      ),
      '',
      '## How to re-run',
      '```bash',
      'cd samplepos.client && npx vitest run src/__tests__/reports-ui-ssot-brand.evidence.test.ts',
      '```',
      '',
    ].join('\n');

    writeFileSync(path.join(repoRoot, 'PROOF_REPORTS_UI_SSOT_BRAND.md'), md, 'utf8');

    gate('ARTIFACTS_WRITTEN', true, 'PROOF_REPORTS_UI_SSOT_BRAND.json + .md');
    expect(failed).toEqual([]);
  });
});
