/**
 * Client proof: Sales Analysis designer + Treasury reverse UI contract.
 * Run: npx vitest run src/__tests__/sales-analysis-transfer-proof.test.ts
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');

function readSrc(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

describe('Sales Analysis + transfer reverse — UI contract', () => {
  it('Sales Analysis page has dimensions, columns, quantity, clean KPIs', () => {
    const page = readSrc('pages/reports/SalesAnalysisReportPage.tsx');
    expect(page).toContain('Sales Analysis');
    expect(page).toContain('By item category');
    expect(page).toContain("id: 'category'");
    expect(page).toContain('By user / cashier');
    expect(page).toContain('By payment type');
    expect(page).toContain('totalQuantitySold');
    expect(page).toContain('Columns');
    expect(page).toContain('shareOfNet');
    expect(page).toContain('Smart views');
    expect(page).toContain('sales-analyse-by');
    expect(page).toContain('optgroup');
    expect(page).toContain("group_by: groupBy");
    expect(page).not.toMatch(/Formatted/);
    expect(page).toContain('reports/sales');
    expect(page).toContain('Export PDF');
    expect(page).toContain('Export CSV');
    expect(page).toContain('downloadFile');
  });

  it('Reports gallery routes SALES_REPORT to sales-analysis', () => {
    const reports = readSrc('pages/ReportsPage.tsx');
    expect(reports).toContain("navigate('/reports/sales-analysis')");
    expect(reports).toContain('Sales Analysis');
  });

  it('App wires /reports/sales-analysis', () => {
    const app = readSrc('App.tsx');
    expect(app).toContain('/reports/sales-analysis');
    expect(app).toContain('SalesAnalysisReportPage');
  });

  it('Liquidity Documents expose Reverse with reason', () => {
    const docs = readSrc('pages/accounting/TreasuryDocumentsPage.tsx');
    expect(docs).toContain('Reverse document');
    expect(docs).toContain('Confirm reverse');
    expect(docs).toMatch(/treasury\.reverse|\.reverse\(/);
    expect(docs).toContain('reason');
  });

  it('Move money points operators to Transactions or Liquidity Documents for reverse', () => {
    const transfer = readSrc('pages/accounting/TreasuryTransferPage.tsx');
    // Quiet UX: guidance lives in QuietHoverHelp (no always-on essay / no hard-coded tab URLs).
    expect(transfer).toContain('QuietHoverHelp');
    expect(transfer).toContain('Transactions');
    expect(transfer).toContain('Liquidity Documents');
    expect(transfer).toContain('Reverse document');
  });
});
