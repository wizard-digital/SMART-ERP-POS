/**
 * PROOF: typed line total is preserved (7000 stays 7000 — never becomes 7000.08).
 *
 * Emits: PROOF_PO_TOTAL_SSOT.json / .md
 * Run: npm run proof:po-total-ssot
 */
import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Decimal from 'decimal.js';
import { PricingEngine } from '@shared/utils/pricingEngine';
import {
  finalizePoLineForSave,
  hydratePoLineMoney,
  isPoLineMoneyConsistent,
  poLineTotal,
  resolveUnitCostAfterBlur,
  resolveUnitCostForLineTotal,
  syncPoLineFromEnteredTotal,
} from '@shared/utils/po-line-uom';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

type Gate = { id: string; ok: boolean; detail: string };
const gates: Gate[] = [];

function gate(id: string, ok: boolean, detail: string): void {
  gates.push({ id, ok, detail });
  expect({ id, ok, detail }).toEqual({ id, ok: true, detail });
}

function read(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

describe('PROOF: PO line total preservation', () => {
  it('user-entered line total is never rewritten by 2dp unit rounding', () => {
    // The bug was: 7000/24 → unit 291.67 (2dp) → line forced to 7000.08
    gate(
      'BUG_2DP_WOULD_BREAK',
      poLineTotal(24, '291.67') === '7000.08',
      'documents the bad path: 24×291.67 = 7000.08',
    );

    const synced = syncPoLineFromEnteredTotal(24, '7000');
    gate(
      'PRESERVE_7000',
      synced.lineTotal === '7000.00' &&
        synced.lineTotal !== '7000.08' &&
        isPoLineMoneyConsistent(24, synced.unitCost, '7000.00') &&
        poLineTotal(24, synced.unitCost) === '7000.00',
      'typed 7000 stays 7000.00; unit precision only as needed',
    );

    const fin = finalizePoLineForSave(24, '291.67', '7000');
    gate(
      'SAVE_PRESERVES_TOTAL',
      fin.lineTotal === '7000.00' &&
        poLineTotal(24, fin.unitCost) === '7000.00' &&
        fin.lineTotal !== '7000.08',
      'save finalize keeps 7000 when line total was entered',
    );

    const easy = syncPoLineFromEnteredTotal(1, '350');
    gate(
      'PREFER_2DP_WHEN_CLEAN',
      easy.unitCost === '350.00' && easy.lineTotal === '350.00',
      'clean totals still use 2dp unit cost',
    );

    const unitLed = finalizePoLineForSave(24, '291.67', '7000.08');
    gate(
      'UNIT_LED_OK',
      unitLed.unitCost === '291.67' && unitLed.lineTotal === '7000.08',
      'unit-cost lead still PE(qty×2dp unit)',
    );

    const precise = resolveUnitCostForLineTotal(24, '7000');
    gate(
      'UNIT_BLUR_KEEPS_PRECISE',
      resolveUnitCostAfterBlur(24, precise, '7000.00') === null &&
        poLineTotal(24, precise) === '7000.00',
      'blur must not 2dp-snap a total-led unit (would create 7000.08)',
    );

    gate(
      'UNIT_BLUR_TRUE_EDIT',
      resolveUnitCostAfterBlur(24, '300', '7000.00') === '300.00',
      'blur snaps a true unit edit that no longer matches the line total',
    );

    gate(
      'RESOLVE_MIN_DP',
      resolveUnitCostForLineTotal(24, '7000') !== '291.67' &&
        poLineTotal(24, resolveUnitCostForLineTotal(24, '7000')) === '7000.00',
      'resolver does not stop at 2dp when that breaks the total',
    );

    gate(
      'PE_ENGINE',
      PricingEngine.calculateLineTotal(24, synced.unitCost)
        .toDecimalPlaces(2)
        .toFixed(2) === '7000.00',
      'PricingEngine agrees with preserved total',
    );

    // Edit-load used to do qty×unit and ignore stored total_price → always 7000.08 for 291.67
    gate(
      'EDIT_LOAD_BARE_QTY_UNIT_BUG',
      new Decimal(24).times(291.67).toFixed(2) === '7000.08',
      'bare qty×unit (old Edit load) produces 7000.08',
    );
    const hydratedMismatch = hydratePoLineMoney(24, '291.67', '7000');
    gate(
      'HYDRATE_PREFERS_STORED_TOTAL',
      hydratedMismatch.lineTotal === '7000.00' &&
        hydratedMismatch.lineTotal !== '7000.08' &&
        poLineTotal(24, hydratedMismatch.unitCost) === '7000.00',
      'hydrate prefers stored 7000 over 2dp unit that would yield 7000.08',
    );
    const hydratedLegacy = hydratePoLineMoney(24, '291.67', '7000.08');
    gate(
      'HYDRATE_KEEPS_LEGACY_PAIR',
      hydratedLegacy.lineTotal === '7000.08' && hydratedLegacy.unitCost === '291.67',
      'legacy consistent 291.67/7000.08 rows stay honest until re-edited',
    );
  });

  it('root cause: DB unit_price scale 2 truncates 7000/24 → 291.67 → 7000.08', () => {
    const mig = read('shared/sql/610_po_unit_price_precision_6dp.sql');
    const post = read('SamplePOS.Server/src/modules/system/migrationPostconditions.ts');
    const page = read('samplepos.client/src/pages/inventory/PurchaseOrdersPage.tsx');

    gate(
      'DB_TRUNCATE_MATH',
      poLineTotal(24, '291.666667') === '7000.00' &&
        poLineTotal(24, '291.67') === '7000.08',
      '6dp unit keeps 7000; 2dp truncate forces 7000.08',
    );
    gate(
      'MIGRATION_610_UNIT_6DP',
      mig.includes('NUMERIC(18, 6)') &&
        mig.includes('purchase_order_items') &&
        mig.includes('unit_price'),
      'migration widens purchase_order_items.unit_price to 6dp',
    );
    gate(
      'POSTCONDITION_610',
      post.includes('610_po_unit_price_precision_6dp.sql') &&
        post.includes('numeric_scale >= 6'),
      'migration postcondition requires unit_price scale >= 6',
    );
    gate(
      'UI_HYDRATE_WIRING',
      page.includes('hydratePoLineMoney') &&
        !page.includes('new Decimal(qty || 0).times(new Decimal(cost || 0)).toFixed(2)'),
      'Edit/details hydrate from stored total — no bare qty×unit reload',
    );
  });

  it('wiring: blur/save use preserve-total sync; server keeps up to 6dp unit', () => {
    const page = read('samplepos.client/src/pages/inventory/PurchaseOrdersPage.tsx');
    const ssot = read('shared/utils/po-line-uom.ts');
    const svc = read('SamplePOS.Server/src/modules/purchase-orders/purchaseOrderService.ts');

    gate(
      'SSOT_PRESERVE_LAW',
      ssot.includes('Never rewrite 7000.00 → 7000.08') &&
        ssot.includes('resolveUnitCostForLineTotal') &&
        ssot.includes('hydratePoLineMoney'),
      'SSOT documents preserve-total law',
    );
    gate(
      'UI_SYNC_PRESERVE',
      page.includes('syncPoLineFromEnteredTotal') &&
        page.includes('finalizePoLineForSave') &&
        page.includes('resolveUnitCostAfterBlur') &&
        page.includes('hydratePoLineMoney'),
      'UI blur/save/load use preserve-total helpers',
    );
    gate(
      'SERVER_UNIT_6DP',
      svc.includes('toDecimalPlaces(6') && svc.includes('PricingEngine.calculateLineTotal'),
      'server stores precise unit so PE line can equal entered total',
    );
    gate(
      'SSOT_FILES',
      existsSync(path.join(repoRoot, 'shared/utils/po-line-uom.ts')) &&
        existsSync(path.join(repoRoot, 'shared/sql/610_po_unit_price_precision_6dp.sql')),
      'po-line-uom SSOT + 610 migration present',
    );
  });
});

afterAll(() => {
  const pass = gates.filter((g) => g.ok).length;
  const fail = gates.filter((g) => !g.ok).length;
  const verdict = fail === 0 ? 'PASS' : 'FAIL';
  const at = new Date().toISOString();
  const evidence = {
    at,
    feature: 'PO_TOTAL_SSOT',
    summary: { pass, fail, total: gates.length, verdict },
    scope:
      'Typed line total is preserved (7000 stays 7000). Root cause of residual 24×291.67=7000.08: DB unit_price NUMERIC(*,2) truncated precise units; migration 610 widens to 6dp; Edit load hydrates from stored total.',
    gates,
    liveMath: {
      qty: 24,
      unit2dp: '291.67',
      pe2dp: '7000.08',
      unit6dp: '291.666667',
      pe6dp: '7000.00',
    },
  };
  writeFileSync(path.join(repoRoot, 'PROOF_PO_TOTAL_SSOT.json'), JSON.stringify(evidence, null, 2));
  writeFileSync(
    path.join(repoRoot, 'PROOF_PO_TOTAL_SSOT.md'),
    `# PROOF — PO line total preservation

**Generated:** ${at}  
**Verdict:** **${verdict}** (${pass}/${gates.length})  
**Scope:** ${evidence.scope}

## Live math (why some lines still show 7000.08)

| Path | Unit | Line total |
|------|------|------------|
| Entered total 7000 ÷ 24 (needed) | 291.666667 | **7000.00** |
| DB \`unit_price NUMERIC(15,2)\` truncate | 291.67 | **7000.08** |

## Gates

| Gate | Result | Detail |
|------|--------|--------|
${gates.map((g) => `| \`${g.id}\` | ${g.ok ? 'PASS' : 'FAIL'} | ${g.detail.replace(/\|/g, '\\|')} |`).join('\n')}
`,
  );
  expect(fail).toBe(0);
});
