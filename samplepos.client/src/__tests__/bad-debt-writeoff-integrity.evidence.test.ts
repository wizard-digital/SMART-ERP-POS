/**
 * Evidence: bad-debt operator wiring (toggle not on Save Tax Settings).
 * Runtime GL/AR/P&L is proven by SamplePOS.Server badDebtWriteoff.realpg.test.ts.
 * Click isolation is proven by scripts/proof-bad-debt-settings-toggle-click.mjs.
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

describe('EVIDENCE — Bad debt write-off flag + surfaces', () => {
  const settingsTab = read('samplepos.client/src/pages/settings/tabs/SystemSettingsTab.tsx');
  const page = read('samplepos.client/src/pages/accounting/BadDebtWriteoffPage.tsx');
  const repo = read('SamplePOS.Server/src/modules/system-settings/systemSettingsRepository.ts');
  const types = read('shared/types/systemSettings.ts');
  const pnl = read('SamplePOS.Server/src/modules/reports/reportsRepository.ts');
  const pnlInv = read('shared/reporting/reportingInvariants.ts');
  const pnlSql = read('shared/sql/644_pnl_bad_debt_opex.sql');
  const sql = read('shared/sql/550_bad_debt_foundation.sql');
  const taxForm = settingsTab.slice(
    settingsTab.indexOf('data-tax-settings-form'),
    settingsTab.indexOf('Save Tax Settings'),
  );

  it('flag default off + instant toggle + PATCH + P&L include AR_WRITEOFF', () => {
    gate(
      'SQL_DEFAULT_OFF',
      /bad_debt_writeoff_enabled BOOLEAN NOT NULL DEFAULT FALSE/.test(sql),
      'migration default FALSE',
    );
    gate(
      'TYPES_AND_PATCH',
      types.includes('badDebtWriteoffEnabled') &&
        types.includes('bad_debt_writeoff_enabled') &&
        /bad_debt_writeoff_enabled = \$/.test(repo),
      'DTO + repository PATCH column',
    );
    gate(
      'TOGGLE_INSTANT_SAVE',
      settingsTab.includes('id="badDebtWriteoffEnabled"') &&
        settingsTab.includes('data-bad-debt-writeoff-enabled-toggle') &&
        settingsTab.includes('onSave({ badDebtWriteoffEnabled: e.target.checked })') &&
        settingsTab.includes('data-settings-optional-modules'),
      'checkbox saves immediately, not via tax form',
    );
    gate(
      'NOT_INSIDE_TAX_SAVE',
      !taxForm.includes('id="badDebtWriteoffEnabled"') &&
        !taxForm.includes('badDebtWriteoffEnabled'),
      'Save Tax Settings payload cannot include the flag',
    );
    gate(
      'INVALIDATE_QUERY',
      settingsTab.includes("['bad-debt']"),
      'saving flag invalidates bad-debt queries',
    );
    gate(
      'BANNER_DEEP_LINK',
      page.includes('to="/settings?tab=system&section=tax"') &&
        page.includes('useBadDebtEnabled'),
      'disabled banner opens System → Tax',
    );
    gate(
      'WORKQUEUE_AGE_HINT',
      /Lower Min overdue days/.test(page),
      'empty workqueue explains the 30-day filter',
    );
    gate(
      'REPORTS_PNL_AR_WRITEOFF',
      pnl.includes('PNL_GL_EXPENSE_REFERENCE_TYPES_SQL') &&
        pnlInv.includes('AR_WRITEOFF') &&
        pnlInv.includes("code === '5210'") &&
        pnlSql.includes("WHEN at.account_code = '5210' THEN 'OPERATING_EXPENSES'"),
      'reports + ERP P&L put 5210 write-offs in operating expenses',
    );
  });

  it('writes PROOF artifact', () => {
    const failed = gates.filter((g) => !g.ok);
    const evidence = {
      feature: 'BAD_DEBT_SETTINGS_TOGGLE',
      provenAt: new Date().toISOString(),
      contract:
        'Flag default off. Enable Bad Debt Write-off is outside Save Tax Settings and PATCHes immediately. Reports P&L includes AR_WRITEOFF.',
      gates,
      summary: {
        total: gates.length,
        passed: gates.filter((g) => g.ok).length,
        failed: failed.length,
      },
    };
    writeFileSync(
      path.join(repoRoot, 'PROOF_BAD_DEBT_SETTINGS_TOGGLE.json'),
      JSON.stringify(evidence, null, 2),
    );
    writeFileSync(
      path.join(repoRoot, 'PROOF_BAD_DEBT_SETTINGS_TOGGLE.md'),
      [
        '# Bad Debt Settings Toggle',
        '',
        `Proven: ${evidence.provenAt}`,
        `Gates: ${evidence.summary.passed}/${evidence.summary.total}`,
        '',
        evidence.contract,
        '',
        ...gates.map((g) => `- ${g.ok ? 'PASS' : 'FAIL'} ${g.id}: ${g.detail}`),
        '',
      ].join('\n'),
    );
    gate('PROOF_WRITTEN', failed.length === 0, `failed=${failed.length}`);
  });
});
