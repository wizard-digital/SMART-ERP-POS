/**
 * EVIDENCE: Expiring items — shelf-life register SSOT + KPI card ↔ filtered list accuracy.
 * Run: npx vitest run src/__tests__/expiring-items-ssot.evidence.test.ts
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  assertExpiringKpiFilterConsistency,
  classifyExpiryUrgency,
  expiringPdfFilterSubtitle,
  filterExpiringRegisterRows,
  filterExpiringRowsByBand,
  filterExpiringRowsBySearch,
  matchesExpiringItemSearch,
  resolveExpiryRowBand,
  summarizeExpiringItems,
  type ExpiringItemLike,
} from '@shared/reports/expiringItemsSsot';

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

/** Fixture shaped like live KPIs: 25 at risk, 8 expired, 15 critical, 2 warning. */
function buildLiveShapedFixture(): ExpiringItemLike[] {
  const rows: ExpiringItemLike[] = [];
  // 8 expired — values sum to 265597.00
  const expiredUnit = 265597 / 8;
  for (let i = 0; i < 8; i++) {
    rows.push({
      daysUntilExpiry: -1 - (i % 3),
      quantityRemaining: 10,
      potentialLoss: Math.round(expiredUnit * 100) / 100,
      urgency: 'expired',
    });
  }
  // Fix last expired so sum is exact
  const expiredSumSoFar = rows.reduce((s, r) => s + r.potentialLoss, 0);
  rows[7].potentialLoss = Math.round((265597 - (expiredSumSoFar - rows[7].potentialLoss)) * 100) / 100;

  // 15 critical — values sum to 203788.00
  const criticalStart = rows.length;
  const criticalUnit = 203788 / 15;
  for (let i = 0; i < 15; i++) {
    rows.push({
      daysUntilExpiry: 1 + (i % 7),
      quantityRemaining: 5,
      potentialLoss: Math.round(criticalUnit * 100) / 100,
      urgency: 'critical',
    });
  }
  const critSlice = rows.slice(criticalStart);
  const critSum = critSlice.reduce((s, r) => s + r.potentialLoss, 0);
  rows[criticalStart + 14].potentialLoss =
    Math.round((203788 - (critSum - rows[criticalStart + 14].potentialLoss)) * 100) / 100;

  // 2 warning (remainder of 25)
  rows.push({ daysUntilExpiry: 14, quantityRemaining: 2, potentialLoss: 1000, urgency: 'warning' });
  rows.push({ daysUntilExpiry: 28, quantityRemaining: 5, potentialLoss: 500, urgency: 'warning' });

  return rows;
}

describe('EVIDENCE — Expiring items shelf-life SSOT', () => {
  it('SSOT: urgency bands + summary', () => {
    gate('EXPIRED', classifyExpiryUrgency(0) === 'expired', '0 days → expired');
    gate('CRITICAL', classifyExpiryUrgency(5) === 'critical', '5 days → critical');
    gate('WARNING', classifyExpiryUrgency(20) === 'warning', '20 days → warning');
    gate('WATCH', classifyExpiryUrgency(45) === 'watch', '45 days → watch');

    gate(
      'SEARCH_NAME',
      matchesExpiringItemSearch({ productName: 'France Liat', sku: 'SKU-1', batchNumber: 'B1' }, 'liat'),
      'search matches product name',
    );
    gate(
      'SEARCH_SKU',
      matchesExpiringItemSearch({ productName: 'X', sku: 'IMP-INIT-SKU-3901', batchNumber: 'B1' }, '3901'),
      'search matches SKU',
    );
    gate(
      'SEARCH_DAY0_FINDABLE',
      filterExpiringRegisterRows(
        [
          {
            productName: 'Zero Day Lot',
            sku: 'ZD-1',
            batchNumber: 'LOT-0',
            daysUntilExpiry: 0,
            urgency: 'expired',
          },
          {
            productName: 'Other',
            sku: 'ZZ',
            batchNumber: 'LOT-9',
            daysUntilExpiry: 9,
            urgency: 'critical',
          },
        ],
        'all',
        'Zero Day',
      ).length === 1,
      'day-0 (expires today) remains findable via search',
    );
    gate(
      'SEARCH_EMPTY_PASSTHROUGH',
      filterExpiringRowsBySearch(
        [{ productName: 'A', sku: '1', batchNumber: 'B' }],
        '   ',
      ).length === 1,
      'blank search keeps all rows',
    );

    const sum = summarizeExpiringItems([
      { daysUntilExpiry: -2, quantityRemaining: 1, potentialLoss: 100 },
      { daysUntilExpiry: 3, quantityRemaining: 2, potentialLoss: 50 },
      { daysUntilExpiry: 15, quantityRemaining: 1, potentialLoss: 25 },
    ]);
    gate('SUM_EXPIRED', sum.expiredCount === 1 && sum.expiredValue === 100, 'expired band totals');
    gate('SUM_CRITICAL', sum.criticalCount === 1 && sum.criticalValue === 50, 'critical band totals');
    gate('SUM_ITEMS', sum.totalItems === 3 && sum.totalPotentialLoss === 175, 'overall totals');
  });

  it('ACCURACY: KPI card counts/values === filtered register (days authoritative)', () => {
    // Stale urgency must NOT override days (consistency with summary).
    gate(
      'DAYS_BEAT_STALE_URGENCY',
      resolveExpiryRowBand({ urgency: 'warning', daysUntilExpiry: 3 }) === 'critical',
      'daysUntilExpiry wins over stale urgency',
    );

    const fixture = buildLiveShapedFixture();
    gate('FIXTURE_SIZE', fixture.length === 25, '25 batches at risk (live-shaped)');

    const check = assertExpiringKpiFilterConsistency(fixture);
    gate('KPI_LIST_CONSISTENCY', check.ok, check.detail);

    gate(
      'KPI_EXPIRED_COUNT',
      check.summary.expiredCount === 8 && check.filtered.expired === 8,
      'Expired card 8 === filtered list 8',
    );
    gate(
      'KPI_CRITICAL_COUNT',
      check.summary.criticalCount === 15 && check.filtered.critical === 15,
      'Critical card 15 === filtered list 15',
    );
    gate(
      'KPI_EXPIRED_VALUE',
      check.summary.expiredValue === 265597 && check.valueCheck.expired === 265597,
      'Expired value UGX 265597 matches filtered sum',
    );
    gate(
      'KPI_CRITICAL_VALUE',
      check.summary.criticalValue === 203788 && check.valueCheck.critical === 203788,
      'Critical value UGX 203788 matches filtered sum',
    );
    gate(
      'PARTITION',
      check.filtered.expired + check.filtered.critical + check.filtered.warning + check.filtered.watch ===
        25,
      'bands partition all 25 rows with no overlap',
    );

    // Wrong-urgency rows still filter by days
    const mixed = [
      { daysUntilExpiry: -5, quantityRemaining: 1, potentialLoss: 10, urgency: 'watch' },
      { daysUntilExpiry: 2, quantityRemaining: 1, potentialLoss: 20, urgency: 'expired' },
    ];
    const mixedCheck = assertExpiringKpiFilterConsistency(mixed);
    gate('STALE_URGENCY_CONSISTENCY', mixedCheck.ok, mixedCheck.detail);
    gate(
      'FILTER_USES_DAYS',
      filterExpiringRowsByBand(mixed, 'expired').length === 1 &&
        filterExpiringRowsByBand(mixed, 'critical').length === 1,
      'filter follows days, not stale urgency labels',
    );

    // PDF export path: service filters before summarize (same as UI)
    const expiredOnly = filterExpiringRowsByBand(fixture, 'expired');
    const expiredSummary = summarizeExpiringItems(expiredOnly);
    gate(
      'PDF_FILTER_EXPIRED_ROWS',
      expiredOnly.length === 8 && expiredSummary.totalItems === 8,
      'PDF expired band → 8 rows, summary.totalItems=8',
    );
    gate(
      'PDF_FILTER_EXPIRED_VALUE',
      expiredSummary.totalPotentialLoss === 265597,
      'PDF expired band value matches KPI card',
    );
    gate(
      'PDF_SUBTITLE',
      expiringPdfFilterSubtitle('expired', 30).includes('Expired only'),
      'PDF subtitle names active band filter',
    );
  });

  it('SQL: includes past expiry; ACTIVE batches; business as-of date', () => {
    const repo = read('SamplePOS.Server/src/modules/reports/reportsRepository.ts');
    const start = repo.indexOf('async getExpiringItems');
    const slice = repo.slice(start, start + 2800);
    gate('NO_BETWEEN_ONLY_FUTURE', !slice.includes('BETWEEN CURRENT_DATE AND'), 'does not exclude already-expired');
    gate('INCLUDES_PAST_DUE', slice.includes('expiry_date::date <=') || slice.includes('expiry_date <='), 'horizon includes past due');
    gate('ACTIVE_ONLY', slice.includes("status, 'ACTIVE'") || slice.includes("status = 'ACTIVE'"), 'ACTIVE batches only');
    gate('AS_OF_BIZ', slice.includes('getBusinessDate') || slice.includes('asOf'), 'business as-of date');
    gate('HAS_SKU', slice.includes('p.sku'), 'selects SKU');
    gate(
      'REPO_SETS_URGENCY',
      slice.includes('classifyExpiryUrgency(daysUntilExpiry)'),
      'repository stamps urgency from same classifier',
    );

    const catStart = repo.indexOf('async getCategoryExpiryExposure');
    const cat = repo.slice(catStart, catStart + 2200);
    gate(
      'AI_EXPIRY_BIZ_DATE',
      cat.includes('getBusinessDate') && cat.includes('expiry_date::date <=') && !cat.includes('CURRENT_DATE'),
      'Category AI expiry uses business as-of (not CURRENT_DATE)',
    );
    gate(
      'AI_EXPIRY_QTY_ON_HAND',
      cat.includes('remaining_quantity > 0'),
      'Category AI expiry same on-hand rule as Expiring Items',
    );
  });

  it('UI wires KPI click → filterExpiringRowsByBand; reset on regenerate', () => {
    const page = read('samplepos.client/src/pages/ReportsPage.tsx');
    const ctrl = read('SamplePOS.Server/src/modules/reports/reportsController.ts');
    const svc = read('SamplePOS.Server/src/modules/reports/reportsService.ts');
    const ssot = read('shared/reports/expiringItemsSsot.ts');

    gate(
      'IN_SSOT',
      /FINANCIAL_SSOT_REPORTS[\s\S]*?'EXPIRING_ITEMS'/.test(page),
      'EXPIRING_ITEMS in FINANCIAL_SSOT_REPORTS',
    );
    gate('SHELF_COPY', page.includes('Shelf-life register'), 'dedicated shelf-life UI');
    gate(
      'KPI_CLICK',
      page.includes('data-expiring-kpi-cards') &&
        page.includes('filterExpiringRowsByBand') &&
        page.includes("selectBand('expired')") &&
        page.includes("selectBand('critical')") &&
        page.includes("selectBand('all')"),
      'KPI cards click-filter register',
    );
    gate(
      'P3_QUARANTINE_BRIDGE',
      page.includes('data-expiring-quarantine-row') &&
        page.includes('/inventory/quarantine') &&
        page.includes('quarantineFromExpiringReport'),
      'Expiring Items quarantine action + workqueue link',
    );
    gate(
      'UI_MAPS_FILTERED',
      page.includes('filteredRows.map') && page.includes('expiringBandFilter'),
      'table maps filteredRows only',
    );
    gate(
      'UI_RESET_ON_GENERATE',
      page.includes("setExpiringBandFilter('all')") &&
        page.includes("setExpiringSearch('')") &&
        /setExpiringBandFilter\('all'\);[\s\S]{0,80}setReportData\(result\.data\)/.test(page),
      'regenerate resets band filter + search to all',
    );
    gate(
      'UI_SMART_SEARCH',
      page.includes('data-expiring-search') &&
        page.includes('filterExpiringRowsBySearch') &&
        page.includes('Find product, SKU, or batch'),
      'Expiring Items has smart product/SKU/batch search',
    );
    gate(
      'CSV_RESPECTS_SEARCH',
      page.includes('filterExpiringRegisterRows(reportData.data, expiringBandFilter, expiringSearch)'),
      'CSV export uses band + search (same as on-screen register)',
    );
    gate(
      'PDF_PASSES_BAND',
      /EXPIRING_ITEMS[\s\S]{0,400}urgency_band/.test(page) &&
        page.includes("params.append('urgency_band', expiringBandFilter)"),
      'PDF export passes active KPI band filter',
    );
    gate(
      'CSV_RESPECTS_FILTER',
      page.includes('filterExpiringRegisterRows') ||
        page.includes('filterExpiringRowsByBand(reportData.data, expiringBandFilter)'),
      'CSV export uses same filtered rows as on-screen register',
    );
    gate(
      'SVC_FILTER_BAND',
      svc.includes('filterExpiringRowsByBand(rawData, urgencyBand)'),
      'service filters before summarize for PDF/JSON',
    );
    gate(
      'CTRL_PDF_FILTER',
      ctrl.includes('expiringPdfFilterSubtitle(urgencyBand, days)') &&
        ctrl.includes('expiring-items-${fileSuffix}.pdf'),
      'PDF controller subtitle + filename reflect band filter',
    );
    gate(
      'ZOD_URGENCY_BAND',
      read('shared/zod/reports.ts').includes("urgency_band: z.enum(['all', 'expired'"),
      'API schema accepts urgency_band query param',
    );
    gate(
      'SSOT_ASSERT_HELPER',
      ssot.includes('assertExpiringKpiFilterConsistency'),
      'shared assertExpiringKpiFilterConsistency exists',
    );
    gate(
      'SSOT_DAYS_AUTHORITATIVE',
      ssot.includes('Days until expiry are authoritative') ||
        ssot.includes('daysUntilExpiry wins') ||
        /daysUntilExpiry[\s\S]{0,200}classifyExpiryUrgency/.test(ssot),
      'resolveExpiryRowBand prefers days',
    );
    gate('SVC_SUMMARIZE', svc.includes('summarizeExpiringItems'), 'service uses shared summarize');
    const pdfStart = ctrl.indexOf('async getExpiringItems');
    const pdf = ctrl.slice(pdfStart, pdfStart + 4500);
    gate('PDF_QTY_KEY', pdf.includes("key: 'quantityRemaining'"), 'PDF uses quantityRemaining');
    gate('PDF_LOSS_KEY', pdf.includes("key: 'potentialLoss'"), 'PDF uses potentialLoss');
    gate('NO_BRAND', !/\b(SAP|Odoo|Tally|QuickBooks)\b/i.test(page), 'no competitor brand in ReportsPage');

    const catUi = read('samplepos.client/src/pages/reports/CategoryIntelligencePage.tsx');
    gate(
      'AI_EXPIRY_SEARCH',
      catUi.includes('data-category-expiry-search') &&
        catUi.includes('filterExpiringRowsBySearch') &&
        catUi.includes('classifyExpiryUrgency'),
      'Category Intelligence expiry uses same search + urgency SSOT',
    );
    gate(
      'AI_EXPIRY_DAY0_KPI',
      catUi.includes('Expired (≤0 days)') && catUi.includes('expirySummary.expiredCount'),
      'Category AI surfaces expired/day-0 count like Expiring Items',
    );

    const reorderUi = read('samplepos.client/src/pages/reports/ReorderDashboardPage.tsx');
    gate(
      'AI_REORDER_SEARCH',
      reorderUi.includes('data-reorder-search') &&
        reorderUi.includes('itemSearch') &&
        reorderUi.includes('stock 0'),
      'Smart Reorder AI has product/SKU search including stock-0 lines',
    );
  });

  it('writes PROOF artifacts', () => {
    const failed = gates.filter((g) => !g.ok);
    const evidence = {
      feature: 'EXPIRING_ITEMS_SSOT',
      provenAt: new Date().toISOString(),
      contract:
        'shelf-life register; smart product/SKU/batch search; KPI↔list; PDF/CSV band(+search CSV); day-0=expired; Category AI expiry same business-date SSOT; Reorder AI searchable',
      gates,
      summary: {
        total: gates.length,
        passed: gates.filter((g) => g.ok).length,
        failed: failed.length,
        verdict: failed.length === 0 ? 'PASS' : 'FAIL',
      },
    };
    writeFileSync(
      path.join(repoRoot, 'PROOF_EXPIRING_ITEMS_SSOT.json'),
      JSON.stringify(evidence, null, 2),
    );
    writeFileSync(
      path.join(repoRoot, 'PROOF_EXPIRING_ITEMS_SSOT.md'),
      [
        '# PROOF — Expiring items shelf-life SSOT',
        '',
        `**Verdict:** ${evidence.summary.verdict}`,
        `**Proven at:** ${evidence.provenAt}`,
        '',
        `**Contract:** ${evidence.contract}`,
        '',
        ...gates.map((g) => `- ${g.ok ? 'PASS' : 'FAIL'} \`${g.id}\`: ${g.detail}`),
        '',
        '```bash',
        'cd samplepos.client && npx vitest run src/__tests__/expiring-items-ssot.evidence.test.ts',
        '```',
        '',
      ].join('\n'),
    );
    gate('ARTIFACTS', true, 'PROOF_EXPIRING_ITEMS_SSOT written');
    expect(failed).toEqual([]);
  });
});
