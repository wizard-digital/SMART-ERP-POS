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

  it('linked sale sync: tender-only amount_paid; liquidity full settle leaves CREDIT', () => {
    const src = read('SamplePOS.Server/src/modules/invoices/invoiceRepository.ts');
    expect(src).toContain('chk_sales_credit_has_debt');
    expect(src).toContain('tender collected only');
    expect(src).toContain('Liquidity full settle on a CREDIT sale leaves CREDIT');
    expect(src).toContain('tender_paid');
    expect(src).toMatch(/s\.payment_method = 'CREDIT'::payment_method/);
    expect(src).not.toMatch(/currentMethod === 'CREDIT' \? 'CASH'/);
    // Must not sync invoice settlement amount_paid (WO/CN) onto CREDIT sales.
    expect(src).not.toMatch(
      /SELECT sale_id, total_amount, amount_paid, amount_due\s+FROM invoices WHERE id = \$1/,
    );
  });

  it('invoice payment sync delegates linked-sale update to tender SSOT', () => {
    const svc = read('SamplePOS.Server/src/modules/invoices/invoiceService.ts');
    expect(svc).toContain('syncLinkedSaleFromInvoice');
    expect(svc).toContain('preferredClearingMethod');
    expect(svc).toContain('liquidity full settle on CREDIT leaves CREDIT');
    expect(svc).not.toMatch(/currentPaymentMethod === 'CREDIT' \? paymentMethod/);
    expect(svc).not.toMatch(/currentPaymentMethod === 'CREDIT'[\s\S]{0,80}input\.paymentMethod/);
    // Must not amount_paid-only UPDATE sales (that hits chk_sales_credit_has_debt on full settle).
    expect(svc).not.toMatch(/SET amount_paid = \$1::numeric\s+WHERE id = \$2/);
  });
});
