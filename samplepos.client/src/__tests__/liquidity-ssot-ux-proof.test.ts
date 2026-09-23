/**
 * Proof: Liquidity Movements finance report + insufficient-funds UX wiring.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');
function readSrc(rel: string) {
  return readFileSync(resolve(root, rel), 'utf8');
}

describe('Liquidity SSOT / report UX proof', () => {
  it('Reports launcher lists Liquidity Movements under Books', () => {
    const launcher = readSrc('components/financial-workspace/ReportsLauncher.tsx');
    expect(launcher).toContain('Liquidity Movements');
    expect(launcher).toContain('/reports/liquidity-movements');
    expect(launcher).toContain("kind: 'financial'");
  });

  it('report page is a modern register with filters and column chooser', () => {
    const page = readSrc('pages/reports/LiquidityMovementsReportPage.tsx');
    expect(page).toContain('Liquidity Movements');
    expect(page).toContain('selectedColumns');
    expect(page).toContain('Columns');
    expect(page).toContain('treasuryDocumentsOnly');
    expect(page).toContain('api.reports.liquidityMovements');
    expect(page).toContain('Money in');
    expect(page).toContain('Export CSV');
    expect(page).toContain('Export PDF');
    expect(page).toContain('downloadFile');
    expect(page).toContain("params.set('format', format)");
    expect(page).toContain('Search document');
    expect(page).toContain('DateRangeFilter');
    expect(page).toContain('pickersMode="custom"');
    expect(page).not.toContain('Build the register like SAP/Odoo');
    expect(page).not.toContain('meta?.ssot');
    expect(page).not.toMatch(/SSOT as Banking/);
  });

  it('Move money UI blocks when amount exceeds available (client-side)', () => {
    const page = readSrc('pages/accounting/TreasuryTransferPage.tsx');
    expect(page).toContain('insufficient');
    expect(page).toContain('Insufficient funds');
    expect(page).toContain('blockReason');
    expect(page).toContain('QuietHoverHelp');
    expect(page).not.toContain('Move between any liquidity account');
    expect(page).toMatch(/disabled=\{posting \|\| enabled === false \|\| !!blockReason/);
  });

  it('App routes liquidity movements report', () => {
    const app = readSrc('App.tsx');
    expect(app).toContain('/reports/liquidity-movements');
    expect(app).toContain('LiquidityMovementsReportPage');
  });

  it('main Reports module lists Liquidity Movements under Financial', () => {
    const page = readSrc('pages/ReportsPage.tsx');
    expect(page).toContain("value: 'LIQUIDITY_MOVEMENTS'");
    expect(page).toContain('Liquidity Movements');
    expect(page).toContain("category: 'Financial'");
    expect(page).toContain("navigate('/reports/liquidity-movements')");
    expect(page).toContain('to="/reports/liquidity-movements"');
    expect(page).not.toContain('Banking & Liquidity SSOT');
  });
});
