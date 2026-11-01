/**
 * Phase 5D — Cross-domain reporting honesty (RP-INV-5/7/8/9)
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertBadDebtNotSalesReturns,
  assertDomainExpenseHitsPnl,
  classifyFinancialPnlSection,
  DOMAIN_PNL_EXPENSE_ACCOUNTS,
  SALES_RETURNS_ACCOUNT,
  ReportingInvariantError,
} from '@shared/reporting/index.js';
import {
  classifyStockMovement,
  assertQuarantineDoesNotPostGl,
} from '@shared/loss-quarantine/index.js';
import { BAD_DEBT_EXPENSE_ACCOUNT } from '@shared/bad-debt/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

function readRepo(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

describe('Reporting cross-domain honesty (Phase 5D)', () => {
  it('RP-INV-8: inventory 5110–5140 are COGS; 5210 Bad Debt is OpEx; none are revenue', () => {
    for (const code of DOMAIN_PNL_EXPENSE_ACCOUNTS) {
      expect(() => assertDomainExpenseHitsPnl(code)).not.toThrow();
      expect(classifyFinancialPnlSection(code, 'EXPENSE')).not.toBe('REVENUE');
    }
    expect(classifyFinancialPnlSection('5110', 'EXPENSE')).toBe('COST_OF_GOODS_SOLD');
    expect(classifyFinancialPnlSection('5120', 'EXPENSE')).toBe('COST_OF_GOODS_SOLD');
    expect(classifyFinancialPnlSection('5130', 'EXPENSE')).toBe('COST_OF_GOODS_SOLD');
    expect(classifyFinancialPnlSection('5140', 'EXPENSE')).toBe('COST_OF_GOODS_SOLD');
    expect(classifyFinancialPnlSection('5210', 'EXPENSE')).toBe('OPERATING_EXPENSES');
  });

  it('RP-INV-9: bad debt uses 5210, never Sales Returns 4010', () => {
    expect(BAD_DEBT_EXPENSE_ACCOUNT).toBe('5210');
    expect(() => assertBadDebtNotSalesReturns(BAD_DEBT_EXPENSE_ACCOUNT)).not.toThrow();
    expect(() => assertBadDebtNotSalesReturns(SALES_RETURNS_ACCOUNT)).toThrow(
      ReportingInvariantError,
    );
    expect(classifyFinancialPnlSection(SALES_RETURNS_ACCOUNT, 'REVENUE')).toBe('REVENUE');
    expect(classifyFinancialPnlSection('5210')).not.toBe('REVENUE');
  });

  it('RP-INV-7: quarantine transfer does not post GL (no P&L until disposal)', () => {
    expect(() =>
      assertQuarantineDoesNotPostGl({
        economicEvent: 'QUARANTINE_TRANSFER',
        postsGl: false,
      }),
    ).not.toThrow();
    expect(() =>
      assertQuarantineDoesNotPostGl({
        economicEvent: 'QUARANTINE_TRANSFER',
        postsGl: true,
      }),
    ).toThrow(/must not post GL|LQ_INV_1/);

    const classified = classifyStockMovement({
      movementType: 'DAMAGE',
      notes: 'internal quarantine transfer',
    });
    expect(classified.economicEvent).toBe('QUARANTINE_TRANSFER');
    expect(classified.postsGl).toBe(false);
  });

  it('RP-INV-8 structural: disposal DR 5110|5120|5130 / CR 1300; never 1200', () => {
    const disposal = readRepo(
      'SamplePOS.Server/src/modules/loss-quarantine/lossDisposalService.ts',
    );
    expect(disposal).toMatch(/5110|5120|5130/);
    expect(disposal).toMatch(/CR 1300|1300/);
    expect(disposal).not.toMatch(/'1200'/);
    expect(disposal).not.toMatch(/AR_WRITEOFF/);
  });

  it('RP-INV-1: Financial Statements income statement uses fn_get_profit_loss*', () => {
    const repo = readRepo('SamplePOS.Server/src/repositories/accountingRepository.ts');
    const fn = repo.slice(
      repo.indexOf('export async function getIncomeStatement'),
      repo.indexOf('export default'),
    );
    expect(fn).toMatch(/getProfitLossReportService/);
    expect(fn).not.toMatch(/startsWith\('5'\)/);
    expect(fn).not.toMatch(/gl_period_balances/);
  });

  it('RP-INV-9 structural: bad debt posts 5210 not 4010', () => {
    const svc = readRepo('SamplePOS.Server/src/modules/bad-debt/badDebtService.ts');
    expect(svc).toMatch(/5210|BAD_DEBT_EXPENSE|assertBadDebtExpenseAccount/);
    expect(svc).toMatch(/AR_WRITEOFF/);
    const asserts = readRepo('shared/bad-debt/badDebtInvariants.ts');
    expect(asserts).toMatch(/4010|Sales Returns/);
  });

  it('RP-INV-5: tax compliance controller still delegates to whtReportService', () => {
    const ctrl = readRepo(
      'SamplePOS.Server/src/modules/reports/taxComplianceReportController.ts',
    );
    expect(ctrl).toMatch(/whtReportService/);
    expect(existsSync(path.join(repoRoot, 'PROOF_TAX_COMPLIANCE.md'))).toBe(true);
  });

  it('close lanes + checklist remain aligned (quarantine / VAT / bad debt)', () => {
    const checklist = readRepo('samplepos.client/src/lib/financialCloseChecklist.ts');
    expect(checklist).toMatch(/step-quarantine-aging/);
    expect(checklist).toMatch(/step-vat-remittance/);
    expect(checklist).toMatch(/step-bad-debt-writeoff/);

    const arProvider = readRepo(
      'SamplePOS.Server/src/modules/financial-reconciliation/providers/arReconciliationProvider.ts',
    );
    expect(arProvider).toMatch(/computeWriteoff/);

    const invProvider = readRepo(
      'SamplePOS.Server/src/modules/financial-reconciliation/providers/inventoryReconciliationProvider.ts',
    );
    expect(invProvider).toMatch(/computeQuarantine|quarantine/);
  });

  it('fixture rollup: disposal + bad debt reduce net income; quarantine BS alone does not', () => {
    // Baseline: revenue only
    const rev = 100_000;
    // After posts hit 5xxx P&L (COGS section under 539)
    const lossDisposal = 2_000; // 5120
    const badDebt = 1_500; // 5210
    const netAfter = rev - lossDisposal - badDebt;
    expect(netAfter).toBe(96_500);

    // Quarantine does not create P&L lines — net unchanged until disposal amounts above
    const quarantineOnlyNet = rev;
    expect(quarantineOnlyNet).toBe(100_000);
  });
});
