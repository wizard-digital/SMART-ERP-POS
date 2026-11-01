/**
 * Evidence: financial P&L + AR aging + linked-sale method stay on one SSOT.
 */
import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function read(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

describe('Financial P&L / AR aging SSOT', () => {
  it('income statement delegates to fn_get_profit_loss (644), not period-balance 5xxx=COGS', () => {
    const src = read('SamplePOS.Server/src/repositories/accountingRepository.ts');
    const fn = src.slice(
      src.indexOf('export async function getIncomeStatement'),
      src.indexOf('export default'),
    );
    expect(src).toContain('Income Statement SSOT = ERP P&L');
    expect(fn).toContain('getProfitLossReportService');
    expect(fn).not.toContain("startsWith('5')");
    expect(fn).not.toMatch(/gl_period_balances/);
  });

  it('aged receivables uses invoice amount_due and AR open document types', () => {
    const src = read('SamplePOS.Server/src/services/agedBalanceService.ts');
    expect(src).toContain('AR_OPEN_DOCUMENT_TYPE_IN_SQL');
    expect(src).toContain('i.amount_due as outstanding_amount');
    expect(src).toContain('applyUnallocatedCredits');
    expect(src).not.toContain('FROM sales s');
  });

  it('write-off workqueue and posting use the same AR open document types', () => {
    const repo = read('SamplePOS.Server/src/modules/bad-debt/badDebtRepository.ts');
    const svc = read('SamplePOS.Server/src/modules/bad-debt/badDebtService.ts');
    expect(repo).toContain('AR_OPEN_DOCUMENT_TYPE_IN_SQL');
    expect(svc).toContain('AR_OPEN_DOCUMENT_TYPES');
    expect(svc).not.toContain("!== 'INVOICE'");
  });

  it('linked sale amount_paid sync never rewrites CREDIT to CASH', () => {
    const src = read('SamplePOS.Server/src/modules/invoices/invoiceRepository.ts');
    expect(src).toContain('Never rewrite CREDIT → CASH');
    expect(src).not.toMatch(/currentMethod === 'CREDIT' \? 'CASH'/);
  });
});
