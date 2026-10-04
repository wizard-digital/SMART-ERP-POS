/**
 * MASTER INTEGRITY — Sales Targets (guru pack)
 * Structural + precision + flag + embed + SoD. Must stay green.
 *
 * Run:
 *   node --experimental-vm-modules ./node_modules/jest/bin/jest.js \
 *     src/modules/sales-targets/salesTargetIntegrityGuru.evidence.test.ts --no-coverage
 */
import { describe, expect, it } from '@jest/globals';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeNetAchievementFromParts } from './salesTargetAchievementService.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');

type Gate = { id: string; ok: boolean; detail: string };
const gates: Gate[] = [];

function gate(id: string, ok: boolean, detail: string): void {
  gates.push({ id, ok, detail });
  expect({ id, ok, detail }).toEqual({ id, ok: true, detail });
}

function read(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

describe('GURU — Sales Targets integrity + consistency', () => {
  const mig631 = read('shared/sql/631_sales_targets.sql');
  const mig632 = read('shared/sql/632_sales_targets_enabled.sql');
  const service = read('SamplePOS.Server/src/modules/sales-targets/salesTargetService.ts');
  const achievement = read(
    'SamplePOS.Server/src/modules/sales-targets/salesTargetAchievementService.ts',
  );
  const repo = read('SamplePOS.Server/src/modules/sales-targets/salesTargetRepository.ts');
  const routes = read('SamplePOS.Server/src/modules/sales-targets/salesTargetRoutes.ts');
  const settings = read('SamplePOS.Server/src/modules/sales-targets/salesTargetSettings.ts');
  const server = read('SamplePOS.Server/src/server.ts');
  const perms = read('SamplePOS.Server/src/rbac/permissions.ts');
  const zod = read('shared/zod/salesTarget.ts');
  const strip = read(
    'samplepos.client/src/components/sales/SalesTargetProgressStrip.tsx',
  );
  const salesPage = read('samplepos.client/src/pages/SalesPage.tsx');
  const dashboard = read('samplepos.client/src/pages/Dashboard.tsx');
  const layout = read('samplepos.client/src/components/Layout.tsx');
  const app = read('samplepos.client/src/App.tsx');
  const api = read('samplepos.client/src/utils/api.ts');
  const settingsTab = read(
    'samplepos.client/src/pages/settings/tabs/SystemSettingsTab.tsx',
  );
  const sysTypes = read('shared/types/systemSettings.ts');

  it('schema + flag SSOT (opt-in default off)', () => {
    const mig633 = read('shared/sql/633_sales_targets_general_team.sql');
    gate('MIG_631', mig631.includes('CREATE TABLE IF NOT EXISTS sales_targets'), '631 creates sales_targets');
    gate(
      'MIG_631_NO_ACHIEVED_COL',
      !/achieved_amount/i.test(mig631),
      'no stored achievement column (derived SSOT)',
    );
    gate(
      'MIG_632_DEFAULT_OFF',
      /sales_targets_enabled\s+BOOLEAN\s+NOT\s+NULL\s+DEFAULT\s+FALSE/i.test(mig632),
      '632 flag default FALSE',
    );
    gate(
      'MIG_633_SCOPES',
      mig633.includes("'GENERAL'") &&
        mig633.includes("'TEAM'") &&
        mig633.includes('sales_target_teams') &&
        mig633.includes('sales_target_team_members'),
      '633 adds GENERAL + TEAM + team tables',
    );
    gate(
      'SETTINGS_HELPER',
      settings.includes('isSalesTargetsEnabled') && settings.includes('tableHasColumn'),
      'flag helper pre-migration safe',
    );
    gate(
      'SYS_TYPES',
      sysTypes.includes('salesTargetsEnabled') && sysTypes.includes('sales_targets_enabled'),
      'systemSettings maps salesTargetsEnabled',
    );
    gate(
      'SETTINGS_UI',
      settingsTab.includes('id="salesTargetsEnabled"') &&
        settingsTab.includes("['sales-targets', 'enabled']"),
      'Settings toggle + query invalidate',
    );
  });

  it('API mount, route order, feature gate', () => {
    gate(
      'SERVER_MOUNT',
      server.includes("'/api/sales-targets'") &&
        server.includes('salesTargetRoutes') &&
        server.includes("requireFeature('pos')"),
      'mounted under /api/sales-targets + pos plan feature',
    );
    gate(
      'ROUTE_ENABLED',
      routes.includes("'/enabled'") &&
        routes.indexOf("'/enabled'") < routes.indexOf('router.use(requireSalesTargetsEnabled)'),
      '/enabled before requireSalesTargetsEnabled',
    );
    gate(
      'ROUTE_PROGRESS',
      routes.includes("'/progress'") &&
        routes.indexOf("'/progress'") < routes.indexOf("'/:id'"),
      '/progress before /:id',
    );
    gate(
      'ROUTE_DISABLED_CODE',
      routes.includes('ERR_SALES_TARGETS_DISABLED'),
      'disabled tenants get ERR_SALES_TARGETS_DISABLED',
    );
    gate(
      'RBAC_KEYS',
      perms.includes('targets.read') &&
        perms.includes('targets.manage') &&
        perms.includes('targets.approve'),
      'targets.* in permission catalog',
    );
  });

  it('achievement precision + business timezone + no client math', () => {
    gate(
      'ACH_MONEY',
      achievement.includes("from '../../utils/money.js'") && achievement.includes('Money.round'),
      'achievement uses Money.round',
    );
    gate(
      'REPO_MONEY',
      repo.includes("from '../../utils/money.js'") && repo.includes('Money.round'),
      'repository money() uses Money.round',
    );
    gate(
      'REPO_TZ',
      repo.includes('toUtcRange') &&
        repo.includes('BUSINESS_TIMEZONE') &&
        repo.includes('sale_date >= $1::timestamptz') &&
        repo.includes('sale_date < $2::timestamptz') &&
        !repo.includes("sale_date AT TIME ZONE 'UTC'"),
      'achievement bounds sale_date via Kampala UTC range (not UTC::date)',
    );
    gate(
      'PROGRESS_BIZDATE',
      service.includes('getBusinessDate') && service.includes('getProgress'),
      'progress asOf uses getBusinessDate',
    );
    gate(
      'PROGRESS_PRIORITY',
      service.includes("scope: 'self' | 'team' | 'general'") &&
        service.includes('pg_advisory_xact_lock') &&
        service.includes('INDIVIDUAL') &&
        service.includes('GENERAL'),
      'progress priority + advisory lock against duplicate live targets',
    );
    gate(
      'CLIENT_NO_REV_MATH',
      !strip.includes('subtotal') &&
        !strip.includes('discount_amount') &&
        strip.includes('api.salesTargets.progress'),
      'strip fetches server progress — no client revenue math',
    );

    // Behavioral precision matrix (must stay exact)
    const halfUp = computeNetAchievementFromParts({
      sales: [{ subtotal: 10.005, discountAmount: 0, status: 'COMPLETED' }],
      refunds: [],
    });
    gate(
      'PREC_HALF_UP',
      halfUp.achievedAmount === 10.01,
      `Money half-up: 10.005 → ${halfUp.achievedAmount}`,
    );

    const voidNet = computeNetAchievementFromParts({
      sales: [{ subtotal: 200, discountAmount: 0, status: 'VOIDED_BY_RETURN' }],
      refunds: [
        {
          totalAmount: 200,
          lineGross: 200,
          saleSubtotal: 200,
          saleDiscount: 0,
          saleTotalAmount: 200,
          saleTaxAmount: 0,
          refundStatus: 'COMPLETED',
        },
      ],
    });
    gate(
      'PREC_VOIDED_BY_RETURN',
      voidNet.achievedAmount === 0,
      'VOIDED_BY_RETURN + refund nets to zero',
    );

    const voidExcluded = computeNetAchievementFromParts({
      sales: [{ subtotal: 999, discountAmount: 0, status: 'VOID' }],
      refunds: [],
    });
    gate('PREC_VOID_EXCL', voidExcluded.achievedAmount === 0, 'VOID sales excluded');
  });

  it('SoD + admin self-approve + UI embed gates', () => {
    gate(
      'SOD_MANAGER',
      /createdBy === actor\.userId && !isTenantAdmin\(actor\)/.test(service) &&
        service.includes('ERR_TARGETS_SELF_APPROVE'),
      'non-admin creator cannot self-approve',
    );
    gate(
      'SOD_ADMIN_OK',
      service.includes("role === 'ADMIN'") && service.includes("role === 'SUPER_ADMIN'"),
      'ADMIN/SUPER_ADMIN may self-approve',
    );
    const createZod = zod.slice(
      zod.indexOf('export const CreateSalesTargetSchema'),
      zod.indexOf('export const UpdateDraftSalesTargetSchema'),
    );
    gate(
      'ZOD_NO_MASS_ASSIGN',
      createZod.includes('.strict()') &&
        !createZod.includes('achievedAmount') &&
        !/\bstatus\b\s*:/.test(createZod),
      'CreateSalesTargetSchema is .strict() without achievement/status fields',
    );
    gate('EMBED_SALES', salesPage.includes('SalesTargetProgressStrip'), 'Sales embeds strip');
    gate('EMBED_DASH', dashboard.includes('SalesTargetProgressStrip'), 'Dashboard embeds strip');
    gate(
      'NAV_FLAG',
      layout.includes('requiresSalesTargets') && layout.includes('useSalesTargetsEnabled'),
      'nav gated by tenant flag',
    );
    gate(
      'ROUTE_GATE',
      app.includes('SalesTargetsFeatureGate'),
      'routes wrapped in feature gate',
    );
    gate(
      'API_CLIENT',
      api.includes('sales-targets/enabled') && api.includes('sales-targets/progress'),
      'client API: enabled + progress',
    );
    gate(
      'STRIP_FLAG',
      strip.includes('useSalesTargetsEnabled') && strip.includes('featureEnabled'),
      'strip respects feature flag',
    );
  });

  it('writes master PROOF (zero fails required)', () => {
    const failed = gates.filter((g) => !g.ok);
    const evidence = {
      feature: 'SALES_TARGETS_INTEGRITY_GURU',
      provenAt: new Date().toISOString(),
      contract:
        'Opt-in flag default off; Money.round precision; Kampala toUtcRange achievement; progress embed; admin self-approve SoD; no client revenue duplicate math; API/UI gated',
      browserHarness: 'NOT_AVAILABLE — structural + pure achievement matrix',
      gates,
      summary: {
        total: gates.length,
        passed: gates.filter((g) => g.ok).length,
        failed: failed.length,
      },
    };
    writeFileSync(
      path.join(repoRoot, 'PROOF_SALES_TARGETS_INTEGRITY_GURU.json'),
      JSON.stringify(evidence, null, 2),
    );
    writeFileSync(
      path.join(repoRoot, 'PROOF_SALES_TARGETS_INTEGRITY_GURU.md'),
      [
        '# Sales Targets Integrity (Guru)',
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
