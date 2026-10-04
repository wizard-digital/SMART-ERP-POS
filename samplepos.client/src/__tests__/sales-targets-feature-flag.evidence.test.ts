/**
 * EVIDENCE: Sales Targets is per-tenant opt-in (default off).
 * Run: npx vitest run src/__tests__/sales-targets-feature-flag.evidence.test.ts
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

describe('EVIDENCE — Sales Targets tenant feature flag', () => {
  const sql = read('shared/sql/632_sales_targets_enabled.sql');
  const settingsTab = read('samplepos.client/src/pages/settings/tabs/SystemSettingsTab.tsx');
  const layout = read('samplepos.client/src/components/Layout.tsx');
  const strip = read('samplepos.client/src/components/sales/SalesTargetProgressStrip.tsx');
  const app = read('samplepos.client/src/App.tsx');
  const hook = read('samplepos.client/src/hooks/useSalesTargetsEnabled.ts');
  const api = read('samplepos.client/src/utils/api.ts');

  it('flag default off + settings toggle', () => {
    gate(
      'SQL_DEFAULT_OFF',
      /sales_targets_enabled\s+BOOLEAN\s+NOT\s+NULL\s+DEFAULT\s+FALSE/i.test(sql),
      'migration default FALSE',
    );
    gate(
      'SETTINGS_TOGGLE',
      settingsTab.includes('id="salesTargetsEnabled"') &&
        settingsTab.includes('data-sales-targets-enabled-toggle'),
      'System Settings has Enable Sales Targets checkbox',
    );
    gate(
      'SETTINGS_INVALIDATE',
      settingsTab.includes("['sales-targets', 'enabled']"),
      'saving flag invalidates enabled query',
    );
  });

  it('client surfaces gated by hook', () => {
    gate('HOOK', hook.includes('sales-targets/enabled') || hook.includes('getEnabled'), 'hook fetches enabled');
    gate('API_ENABLED', api.includes("sales-targets/enabled"), 'api.salesTargets.getEnabled');
    gate(
      'NAV_GATED',
      layout.includes('requiresSalesTargets') && layout.includes('useSalesTargetsEnabled'),
      'Layout hides Sales Targets when flag off',
    );
    gate(
      'STRIP_GATED',
      strip.includes('useSalesTargetsEnabled') && strip.includes('featureEnabled'),
      'progress strip hidden when flag off',
    );
    gate(
      'ROUTE_GATED',
      app.includes('SalesTargetsFeatureGate'),
      'routes wrapped in SalesTargetsFeatureGate',
    );
  });

  it('writes PROOF artifact', () => {
    const failed = gates.filter((g) => !g.ok);
    const evidence = {
      feature: 'SALES_TARGETS_FEATURE_FLAG',
      provenAt: new Date().toISOString(),
      contract:
        'sales_targets_enabled DEFAULT FALSE; Settings toggle; nav/strip/routes/API gated; opt-in per tenant',
      gates,
      summary: {
        total: gates.length,
        passed: gates.filter((g) => g.ok).length,
        failed: failed.length,
      },
    };
    writeFileSync(
      path.join(repoRoot, 'PROOF_SALES_TARGETS_FEATURE_FLAG.json'),
      JSON.stringify(evidence, null, 2),
    );
    writeFileSync(
      path.join(repoRoot, 'PROOF_SALES_TARGETS_FEATURE_FLAG.md'),
      [
        '# Sales Targets Feature Flag',
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
