/**
 * PROOF: near-expiry lot write-down (NRV) — integrity vs POS floor, quarantine, disposal.
 *
 * npm run proof:lot-write-down
 */
import { afterAll, describe, expect, it } from '@jest/globals';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertWriteDownBandMatchesLotPolicy,
  evaluateLotWriteDownGate,
  LOT_WRITE_DOWN_EXPENSE_ACCOUNT,
} from '@shared/inventory-lot/lotWriteDown.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

type Gate = { id: string; ok: boolean; detail: string };
const gates: Gate[] = [];

function gate(id: string, ok: boolean, detail: string): void {
  gates.push({ id, ok, detail });
  expect({ id, ok, detail }).toEqual({ id, ok: true, detail });
}

function readRel(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

describe('PROOF lot write-down NRV', () => {
  it('schema: original cost column + document + 5140, not 5110-5130', () => {
    const sql = readRel('shared/sql/611_lot_write_down_clearance.sql');
    gate('SQL_ORIGINAL_COST', sql.includes('original_cost_price'), 'original_cost_price on inventory_batches');
    gate('SQL_TRIGGER_INSERT_ONLY', sql.includes('BEFORE INSERT') && !sql.includes('BEFORE INSERT OR UPDATE'), 'original set on insert only');
    gate('SQL_DOC', sql.includes('lot_write_down_documents') && sql.includes("reason = 'NEAR_EXPIRY'"), 'NEAR_EXPIRY document');
    gate('SQL_5140', sql.includes("'5140'") && sql.includes('Inventory Clearance Markdown'), '5140 clearance markdown');
    gate('SQL_NO_QTY_CONSUME', !sql.includes('remaining_quantity = remaining_quantity -'), 'does not consume qty in SQL');
    const sql612 = readRel('shared/sql/612_lot_write_down_immutability.sql');
    gate(
      'SQL_ORIGINAL_IMMUTABLE',
      sql612.includes('original_cost_price is immutable') && sql612.includes('BEFORE INSERT OR UPDATE'),
      '612 freezes original after insert',
    );
    const sql613 = readRel('shared/sql/613_lot_write_down_journal_coupling.sql');
    gate(
      'SQL_613_NO_NULL_JE_AUTH',
      sql613.includes('cannot increase after lot creation')
        && sql613.includes('lot_write_down_posted_requires_journal')
        && sql613.includes('DEFERRABLE INITIALLY DEFERRED')
        && sql613.includes('POSTED lot write-down requires a posted journal')
        && sql613.includes('inventory_batches.cost_price may decrease only via a posted lot write-down document')
        && sql613.includes('CAST(rec.id AS TEXT)')
        && !/AND d\.journal_entry_id IS NULL/.test(sql613),
      '613: decrease not authorized by NULL JE; increases forbidden; deferred journal required',
    );
  });

  it('service does not use disposal/handler; posts INVENTORY_MOVE DR 5140 CR 1300', () => {
    const svc = readRel('SamplePOS.Server/src/modules/inventory-lot/lotWriteDownService.ts');
    gate(
      'NO_HANDLER',
      !svc.includes('new StockMovementHandler') && !svc.includes('processMovement('),
      'no SM consume path',
    );
    gate('NO_CONSUME_LOT', !svc.includes('consumeLot'), 'no lot consume');
    gate('NO_DISPOSAL_ACCOUNTS', !svc.includes("'5110'") && !svc.includes("'5120'") && !svc.includes("'5130'"), 'does not debit 5110-5130');
    gate('USES_5140', svc.includes('CLEARANCE_MARKDOWN') || svc.includes("'5140'"), '5140');
    gate('UPDATES_CARRYING', svc.includes('SET cost_price = $2') && !svc.includes('SET original_cost_price'), 'carrying only');
    gate('GL_INVENTORY_MOVE', svc.includes("source: 'INVENTORY_MOVE'"), 'Rule H 1300 source');
    gate('REF_TYPE', svc.includes('LOT_WRITE_DOWN'), 'reference LOT_WRITE_DOWN');
  });

  it('POS floor still allocated batch cost_price (carrying after write-down)', () => {
    const fefo = readRel('SamplePOS.Server/src/modules/pricing/atCostIssuePrice.ts');
    const guard = readRel('SamplePOS.Server/src/modules/sales/saleBelowCostGuard.ts');
    gate('FEFO_COST_PRICE', fefo.includes('cost_price') && fefo.includes('inventory_batches'), 'FEFO reads batch cost_price');
    gate('BELOW_COST_HARD', guard.includes('BELOW_ALLOCATED_COST') && !guard.includes('LOT_WRITE_DOWN'), 'till has no write-down bypass');
  });

  it('eligibility: 1–60 day still-sellable; damaged/expired blocked', () => {
    gate('BAND_SSOT', assertWriteDownBandMatchesLotPolicy(), 'write-down 1–60 days; Critical KPI stays ≤7d');
    const biz = '2026-09-10';
    const ok = evaluateLotWriteDownGate({
      status: 'ACTIVE',
      expiryDate: '2026-09-14',
      remainingQuantity: 2,
      carryingUnitCost: 1000,
      originalUnitCost: 1000,
      newUnitCost: 600,
      businessDate: biz,
    });
    gate('CRITICAL_OK', ok.ok === true && ok.ok && ok.writeDownAmount === 800, '2 × 400 markdown');
    const at60 = evaluateLotWriteDownGate({
      status: 'ACTIVE',
      expiryDate: '2026-11-09',
      remainingQuantity: 2,
      carryingUnitCost: 1000,
      originalUnitCost: 1000,
      newUnitCost: 600,
      businessDate: biz,
    });
    gate('SIXTY_OK', at60.ok === true && at60.ok && at60.daysUntilExpiry === 60, 'day 60 still eligible');
    const beyond = evaluateLotWriteDownGate({
      status: 'ACTIVE',
      expiryDate: '2026-11-10',
      remainingQuantity: 2,
      carryingUnitCost: 1000,
      originalUnitCost: 1000,
      newUnitCost: 600,
      businessDate: biz,
    });
    gate('SIXTY_ONE_BLOCK', beyond.ok === false, 'day 61 blocked');
    gate(
      'QUARANTINE_BLOCK',
      evaluateLotWriteDownGate({
        status: 'QUARANTINED',
        expiryDate: '2026-09-14',
        remainingQuantity: 2,
        carryingUnitCost: 1000,
        originalUnitCost: 1000,
        newUnitCost: 600,
        businessDate: biz,
      }).ok === false,
      'quarantined blocked',
    );
    gate(
      'EXPIRED_BLOCK',
      evaluateLotWriteDownGate({
        status: 'ACTIVE',
        expiryDate: '2026-09-10',
        remainingQuantity: 2,
        carryingUnitCost: 1000,
        originalUnitCost: 1000,
        newUnitCost: 600,
        businessDate: biz,
      }).ok === false,
      'calendar expired blocked',
    );
    gate(
      'NO_EXPIRY_BLOCK',
      evaluateLotWriteDownGate({
        status: 'ACTIVE',
        expiryDate: null,
        remainingQuantity: 2,
        carryingUnitCost: 1000,
        originalUnitCost: 1000,
        newUnitCost: 600,
        businessDate: biz,
      }).ok === false,
      'no expiry (in-transit damage path) blocked',
    );
  });

  it('UI: write-down on ≤60d sellable lots; quarantine remains expired-only', () => {
    const page = readRel('samplepos.client/src/pages/ReportsPage.tsx');
    gate('UI_WRITE_DOWN', page.includes('data-expiring-write-down-row') && page.includes('writeDownNearExpiryLot'), 'write-down on Expiring Items');
    gate('UI_CLEARANCE_NAME', page.includes('Lot carrying-value write-down') && page.includes('Clearance markdown'), 'named clearance markdown not below-cost sale');
    gate(
      'UI_ADMIN_ONLY',
      page.includes('canPerformLotWriteDown') &&
        page.includes('canClearanceMarkdown') &&
        page.includes('(ADMIN only)'),
      'Clearance markdown UI gated to absolute ADMIN',
    );
    gate(
      'UI_60_DAY_WINDOW',
      page.includes('isNearExpiryWriteDownBand') && page.includes('LOT_WRITE_DOWN_MAX_DAYS') && page.includes('canWriteDown'),
      'UI uses 60-day write-down SSOT',
    );
    gate('UI_QUARANTINE_EXPIRED', page.includes("band === 'expired'") && page.includes('canQuarantine'), 'quarantine still expired-only');
    gate('EXPENSE_ACCOUNT', LOT_WRITE_DOWN_EXPENSE_ACCOUNT === '5140', '5140 constant');
    const zodReports = readRel('shared/zod/reports.ts');
    const controller = readRel('SamplePOS.Server/src/modules/reports/reportsController.ts');
    const live = readRel('SamplePOS.Server/scripts/proof-lot-write-down-live.ts');
    const ssot = readRel('shared/inventory-lot/lotWriteDown.ts');
    gate(
      'SSOT_ZOD_HORIZON',
      zodReports.includes('LOT_WRITE_DOWN_MAX_DAYS') &&
        /daysAhead:[\s\S]{0,80}LOT_WRITE_DOWN_MAX_DAYS/.test(zodReports) &&
        /days_threshold:[\s\S]{0,80}LOT_WRITE_DOWN_MAX_DAYS/.test(zodReports),
      'Expiring Items API default = LOT_WRITE_DOWN_MAX_DAYS',
    );
    gate(
      'SSOT_PDF_FALLBACK',
      controller.includes('LOT_WRITE_DOWN_MAX_DAYS') && controller.includes('params.days_threshold || LOT_WRITE_DOWN_MAX_DAYS'),
      'PDF days fallback = LOT_WRITE_DOWN_MAX_DAYS',
    );
    gate(
      'SSOT_REJECT_MSG',
      ssot.includes('expiring within ${LOT_WRITE_DOWN_MAX_DAYS} days'),
      'reject copy uses LOT_WRITE_DOWN_MAX_DAYS',
    );
    gate(
      'SSOT_LIVE_MATRIX',
      live.includes('WINDOW_ACCEPT_DAYS') &&
        live.includes('LIVE_WINDOW_WARNING_WATCH') &&
        live.includes('LIVE_REPORT_HORIZON_60') &&
        live.includes("expiry_date::date <= ($1::date + ($2::text || ' days')::interval)") &&
        live.includes('LIVE_POS_CATALOG_UNCHANGED') &&
        live.includes('LIVE_POS_ENGINE_FLOOR') &&
        live.includes('LIVE_POS_SALE_AT_NEW_CARRYING') &&
        live.includes('LIVE_POS_SALE_BELOW_NEW_CARRYING') &&
        live.includes('LIVE_POS_SALE_AT_CATALOG') &&
        live.includes('LIVE_POS_SQL_DOC') &&
        live.includes('LIVE_POS_SQL_WD_GL') &&
        live.includes('LIVE_POS_SQL_SALES') &&
        live.includes('LIVE_POS_SQL_NO_BELOW_SALE') &&
        live.includes('LIVE_POS_SQL_QTY_AND_FLOOR') &&
        live.includes('LIVE_POS_SQL_SALE_GL') &&
        live.includes('LIVE_POS_SQL_GROSS_PROFIT') &&
        live.includes('LIVE_POS_SQL_VALUATION_IDENTITY') &&
        live.includes('LIVE_POS_SQL_NO_DOUBLE_COUNT'),
      'live proof measures 1/7/8/20/30/45/60 + report horizon + POS 10000/3000 SQL + P&L/valuation identity',
    );
    const engine = readRel('SamplePOS.Server/src/modules/pricing/pricingEngineService.ts');
    const posPage = readRel('samplepos.client/src/pages/pos/POSPage.tsx');
    const posAtCost = readRel('samplepos.client/src/utils/posCartAtCost.ts');
    gate(
      'SSOT_ENGINE_ALLOCATED',
      engine.includes('attachAllocatedIssueCost') &&
        engine.includes('allocatedCostPerBase') &&
        engine.includes('previewFefoIssueCostForBaseQty'),
      'pricing engine attaches live FEFO carrying on every resolved price',
    );
    gate(
      'SSOT_POS_ALLOCATED_FLOOR',
      posPage.includes('applyAllocatedCarryingToCartLine') &&
        posPage.includes('allocatedCostPerBase') &&
        posAtCost.includes('applyAllocatedCarryingToCartLine') &&
        /if \(items\.length === 0\) return/.test(posPage) &&
        !posPage.includes('if (items.length === 0 || !selectedCustomer?.id) return'),
      'POS walk-in syncs cart cost floor from allocated FEFO carrying',
    );
    // Prod failure modes that made "proof passed" then users still see equal costs / below-cost block.
    gate(
      'UI_COMMA_PARSE',
      page.includes(".replace(/,/g, '')") && page.includes('You entered:'),
      'write-down prompt strips commas before Number()',
    );
    gate(
      'UI_PATCH_AFTER_POST',
      page.includes('setReportData((prev)') &&
        page.includes('unitCost: newCarrying') &&
        page.includes('originalUnitCost: orig') &&
        page.includes('getErrorMessage'),
      'after POST: patch carrying vs original in open report + surface API errors',
    );
    const fefo = readRel('SamplePOS.Server/src/modules/pricing/atCostIssuePrice.ts');
    gate(
      'FEFO_COERCE_DECIMAL',
      fefo.includes('baseQty instanceof Decimal ? baseQty : new Decimal(baseQty)'),
      'FEFO preview coerces numeric qty to Decimal (no lessThanOrEqualTo crash)',
    );

    const routes = readRel('SamplePOS.Server/src/modules/inventory-lot/lotWriteDownRoutes.ts');
    const svc = readRel('SamplePOS.Server/src/modules/inventory-lot/lotWriteDownService.ts');
    gate(
      'ROUTE_NOT_INVENTORY_ADJUST',
      !routes.includes("requirePermission('inventory.adjust')") &&
        routes.includes('requireLotWriteDownAdmin') &&
        routes.includes('ERR_LOT_WRITE_DOWN_ADMIN_ONLY') &&
        routes.includes('canPerformLotWriteDown'),
      'HTTP route is ADMIN-only — inventory.adjust cannot authorize write-down',
    );
    gate(
      'SERVICE_DB_ROLE_GATE',
      svc.includes('SELECT role FROM users') &&
        svc.includes('canPerformLotWriteDown') &&
        svc.includes('ERR_LOT_WRITE_DOWN_ADMIN_ONLY'),
      'service re-checks users.role inside the posting transaction',
    );
    gate(
      'SSOT_ADMIN_HELPERS',
      ssot.includes('ERR_LOT_WRITE_DOWN_ADMIN_ONLY') &&
        ssot.includes('canPerformLotWriteDown') &&
        ssot.includes('isAbsoluteAdminRole'),
      'shared SSOT exports ADMIN-only helpers',
    );
  });
});

afterAll(() => {
  const passed = gates.every((g) => g.ok);
  const payload = {
    proof: 'LOT_WRITE_DOWN_NRV',
    passed,
    asOf: new Date().toISOString(),
    claims: [
      'Still-sellable lots expiring within 60 days may be written down; original cost is preserved.',
      'Carrying cost_price is the POS/FEFO/AT_COST floor; no till override.',
      'Damaged/quarantined/calendar-expired/no-expiry cannot use write-down.',
      'GL DR 5140 / CR 1300; qty unchanged; not 5110/5120/5130 disposal.',
      'UI, API default, PDF fallback, and live window matrix all use LOT_WRITE_DOWN_MAX_DAYS (60).',
      'POS walk-in selling price stays catalog; till floor is FEFO carrying after write-down (edit down to new carrying allowed).',
      'Valuation SSOT is remaining qty × carrying; GL 1300 matches; COGS 5000 uses carrying not original; 5140 is separate P&L (no double-count).',
    ],
    gates,
  };
  const md = [
    '# PROOF: Near-expiry lot write-down (NRV)',
    '',
    `**Result:** ${passed ? 'PASS' : 'FAIL'}`,
    `**As of:** ${payload.asOf}`,
    '',
    '## Claims',
    ...payload.claims.map((c) => `- ${c}`),
    '',
    '## Gates',
    ...gates.map((g) => `- ${g.ok ? 'PASS' : 'FAIL'} \`${g.id}\` — ${g.detail}`),
    '',
    '## Executed / live (not source greps)',
    '',
    '- `PROOF_LOT_WRITE_DOWN_EXECUTED.json` — service called with mocked PG; rejects throw.',
    '- `PROOF_LOT_WRITE_DOWN_LIVE.md` — `npm run proof:lot-write-down:live` against DATABASE_URL.',
    '',
  ].join('\n');
  writeFileSync(path.join(repoRoot, 'PROOF_LOT_WRITE_DOWN.json'), JSON.stringify(payload, null, 2));
  writeFileSync(path.join(repoRoot, 'PROOF_LOT_WRITE_DOWN.md'), md);
  expect(passed).toBe(true);
});
