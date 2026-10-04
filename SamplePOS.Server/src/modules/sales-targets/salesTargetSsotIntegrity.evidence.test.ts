/**
 * SSOT / anti-duplicate integrity for Sales Targets (INDIVIDUAL | GENERAL | TEAM).
 * Zero fails required.
 */
import { describe, expect, it } from '@jest/globals';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeNetAchievementFromParts,
  resolveCashierFilter,
} from './salesTargetAchievementService.js';
import type { SalesTargetRow } from './salesTargetTypes.js';

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

function stubTarget(partial: Partial<SalesTargetRow>): SalesTargetRow {
  return {
    id: 't1',
    scope: 'INDIVIDUAL',
    salespersonId: 'u1',
    salespersonName: 'A',
    teamId: null,
    teamName: null,
    periodType: 'MONTHLY',
    periodStart: '2026-10-01',
    periodEnd: '2026-10-31',
    targetAmount: 1000,
    status: 'ACTIVE',
    createdBy: 'c1',
    createdByName: null,
    approvedBy: null,
    approvedByName: null,
    approvedAt: null,
    closedBy: null,
    closedAt: null,
    cancelledBy: null,
    cancelledAt: null,
    amendmentReason: null,
    cancelReason: null,
    notes: null,
    rowVersion: 1,
    createdAt: '',
    updatedAt: '',
    ...partial,
  };
}

describe('GURU — Sales Targets SSOT / no-duplicate integrity', () => {
  const mig631 = read('shared/sql/631_sales_targets.sql');
  const mig633 = read('shared/sql/633_sales_targets_general_team.sql');
  const mig634 = read('shared/sql/634_sales_targets_no_duplicate_ssot.sql');
  const service = read('SamplePOS.Server/src/modules/sales-targets/salesTargetService.ts');
  const achievement = read(
    'SamplePOS.Server/src/modules/sales-targets/salesTargetAchievementService.ts',
  );
  const repo = read('SamplePOS.Server/src/modules/sales-targets/salesTargetRepository.ts');
  const zod = read('shared/zod/salesTarget.ts');
  const strip = read('samplepos.client/src/components/sales/SalesTargetProgressStrip.tsx');

  it('schema forbids stored achievement + enforces scope shape + team uniqueness', () => {
    gate('NO_STORED_ACHIEVED', !/achieved_amount/i.test(mig631), 'no achieved_amount column');
    gate(
      'SCOPE_SHAPE',
      mig633.includes('chk_sales_targets_scope_shape') &&
        mig633.includes("'GENERAL'") &&
        mig633.includes("'TEAM'"),
      'DB CHECK scope shape',
    );
    gate(
      'TEAM_NAME_CI',
      mig634.includes('uq_sales_target_teams_name_ci') &&
        mig634.includes('lower(btrim(name))'),
      'case-insensitive unique team names',
    );
    gate(
      'MEMBER_PK',
      mig633.includes('PRIMARY KEY (team_id, user_id)'),
      'team membership PK blocks duplicate members',
    );
  });

  it('service locks + dedupes; client never recomputes revenue', () => {
    gate(
      'ADVISORY_LOCK',
      service.includes('pg_advisory_xact_lock') && service.includes('lockScopeKey'),
      'overlap checks take advisory xact lock',
    );
    gate(
      'OVERLAP_ALL_SCOPES',
      service.includes("scope === 'GENERAL'") &&
        service.includes('ERR_TARGETS_OVERLAP') &&
        service.includes('findOverlappingLive'),
      'live overlap enforced for all scopes',
    );
    gate(
      'TEAM_DEDUP',
      service.includes('dedupeIds') && service.includes('ERR_TARGETS_TEAM_DUP'),
      'team members deduped; duplicate names mapped',
    );
    gate(
      'GENERAL_SHAPE_GUARD',
      service.includes('ERR_TARGETS_SCOPE_SHAPE') &&
        zod.includes('GENERAL scope must not set salespersonId'),
      'GENERAL rejects salesperson/team mass-shape',
    );
    gate(
      'ACH_SSOT_SINGLE',
      achievement.includes('resolveCashierFilter') &&
        achievement.includes('computeAchievementTotals') &&
        service.includes('calculateTargetAchievement') &&
        !strip.includes('subtotal'),
      'achievement SSOT server-only; strip no revenue math',
    );
    gate(
      'PROGRESS_USES_SSOT',
      service.includes('getProgress') &&
        /getProgress[\s\S]*calculateTargetAchievement/.test(service),
      'progress uses same calculateTargetAchievement as detail',
    );
    gate(
      'REPO_FILTER_MODES',
      repo.includes("cashierFilter === 'ALL'") && repo.includes('ANY($3::uuid[])'),
      'GENERAL=all cashiers; TEAM/INDIVIDUAL=explicit ids',
    );
  });

  it('behavioral: contributor filter + single-sale net (no double count in one target)', async () => {
    const individual = await resolveCashierFilter(
      { query: async () => ({ rows: [] }) } as never,
      stubTarget({ scope: 'INDIVIDUAL', salespersonId: 'u-a' }),
    );
    gate(
      'FILTER_INDIVIDUAL',
      Array.isArray(individual) && individual.length === 1 && individual[0] === 'u-a',
      'INDIVIDUAL filter is single id',
    );

    const general = await resolveCashierFilter(
      { query: async () => ({ rows: [] }) } as never,
      stubTarget({ scope: 'GENERAL', salespersonId: null }),
    );
    gate('FILTER_GENERAL', general === 'ALL', 'GENERAL filter is ALL cashiers');

    // One sale appears once in net — refund nets correctly (no double penalty)
    const once = computeNetAchievementFromParts({
      sales: [{ subtotal: 100, discountAmount: 0, status: 'COMPLETED' }],
      refunds: [],
    });
    gate('NET_ONCE', once.achievedAmount === 100, `single sale nets ${once.achievedAmount}`);

    const returned = computeNetAchievementFromParts({
      sales: [{ subtotal: 100, discountAmount: 0, status: 'VOIDED_BY_RETURN' }],
      refunds: [
        {
          totalAmount: 100,
          lineGross: 100,
          saleSubtotal: 100,
          saleDiscount: 0,
          saleTotalAmount: 100,
          saleTaxAmount: 0,
          refundStatus: 'COMPLETED',
        },
      ],
    });
    gate(
      'NET_NO_DOUBLE_PENALTY',
      returned.achievedAmount === 0,
      'VOIDED_BY_RETURN + refund = 0 (not -100)',
    );

    const voided = computeNetAchievementFromParts({
      sales: [{ subtotal: 100, discountAmount: 0, status: 'VOID' }],
      refunds: [],
    });
    gate('VOID_EXCLUDED', voided.achievedAmount === 0, 'VOID excluded from achievement');
  });

  it('writes PROOF artifact', () => {
    const failed = gates.filter((g) => !g.ok);
    const evidence = {
      feature: 'SALES_TARGETS_SSOT_NO_DUPLICATE',
      provenAt: new Date().toISOString(),
      contract:
        'No stored achievement; scope shape CHECK; CI unique teams; membership PK; advisory-locked live overlap; GENERAL/TEAM/INDIVIDUAL cashier filters; progress=detail SSOT; no client revenue math; no double-penalty returns',
      gates,
      summary: {
        total: gates.length,
        passed: gates.filter((g) => g.ok).length,
        failed: failed.length,
      },
    };
    writeFileSync(
      path.join(repoRoot, 'PROOF_SALES_TARGETS_SSOT_NO_DUPLICATE.json'),
      JSON.stringify(evidence, null, 2),
    );
    writeFileSync(
      path.join(repoRoot, 'PROOF_SALES_TARGETS_SSOT_NO_DUPLICATE.md'),
      [
        '# Sales Targets SSOT / No Duplicate',
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
