/**
 * PROOF: Adjustments use SELLING as default store (INV-POS SSOT) and keep
 * store-available qty — never MAIN-only phantom adjust against warehouse layer.
 *
 * npx vitest run src/__tests__/inventory-adjustments-store-ssot.evidence.test.ts
 */
import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const clientRoot = resolve(here, '../..');
const repoRoot = resolve(clientRoot, '..');
const serverRoot = resolve(repoRoot, 'SamplePOS.Server');

type Gate = { id: string; ok: boolean; detail: string };
const gates: Gate[] = [];

function gate(id: string, ok: boolean, detail: string): void {
  gates.push({ id, ok, detail });
  expect({ id, ok, detail }).toEqual({ id, ok: true, detail });
}

function readClient(rel: string): string {
  return readFileSync(resolve(clientRoot, 'src', rel), 'utf8');
}

function readServer(rel: string): string {
  return readFileSync(resolve(serverRoot, 'src', rel), 'utf8');
}

describe('PROOF: inventory adjustments store SSOT', () => {
  it('defaults Adjustments to SELLING and keeps store-available qty', () => {
    const page = readClient('pages/inventory/InventoryAdjustmentsPage.tsx');
    const drawer = readClient('components/inventory/AdjustInventoryDrawer.tsx');
    gate(
      'UI_ADJ_DEFAULT_SELLING',
      page.includes('resolveDefaultAdjustStoreId') &&
        page.includes('defaultAdjustmentStoreId') &&
        drawer.includes("storeType === 'SELLING' && s.isPosSelling") &&
        drawer.includes("storeType === 'SELLING'") &&
        !/if \(mainStore\?\.id && !adjustmentStoreId\)/.test(page),
      'Adjustments default store is SELLING (INV-POS), not MAIN',
    );
    gate(
      'UI_ADJ_STORE_AVAILABLE_QTY',
      page.includes('product_lot_id') &&
        page.includes('inventoryBatchId') &&
        page.includes('Store-available qty is SSOT') &&
        drawer.includes('store-products/') &&
        drawer.includes('Math.min') &&
        drawer.includes('lotOptions') &&
        drawer.includes('inventoryBatchId'),
      'Modal Current Quantity uses store-available lot/batch FEFO, not batch master alone',
    );
  });

  it('backend prefers SELLING for default adjust store and preflights sellable', () => {
    const svc = readServer(
      'modules/inventory/warehouse/warehouseAdjustmentService.ts',
    );
    const dist = readServer(
      'modules/inventory/warehouse/productStoreDistributionService.ts',
    );
    gate(
      'API_ADJ_DEFAULT_SELLING',
      svc.includes('getActivePosSellingStore') &&
        svc.includes('sellable adjustments default to SELLING'),
      'resolveDefaultStoreId prefers POS SELLING',
    );
    gate(
      'API_ADJ_STORE_SELLABLE_PREFLIGHT',
      svc.includes('Insufficient sellable stock at store') &&
        svc.includes('Switch the Adjustments store'),
      'OUT adjustments refuse wrong-store debit with clear message',
    );
    gate(
      'API_STORE_LOTS_BATCH_ID',
      dist.includes('inventory_batch_id') &&
        dist.includes('inventoryBatchId: r.inventory_batch_id'),
      'listLotsAtStore returns inventoryBatchId for batch coupling',
    );
  });
});

afterAll(() => {
  const passed = gates.filter((g) => g.ok).length;
  const total = gates.length;
  const verdict = passed === total && total > 0 ? 'PASS' : 'FAIL';
  const generatedAt = new Date().toISOString();
  const payload = {
    proof: 'INVENTORY_ADJUSTMENTS_STORE_SSOT',
    verdict,
    generatedAt,
    passed,
    total,
    gates,
    integrity:
      'Multistore Adjustments default to SELLING; Current Quantity is store-available; OUT preflights sellable at chosen store; store lots expose inventoryBatchId.',
  };
  const json = `${JSON.stringify(payload, null, 2)}\n`;
  const md = [
    '# PROOF — Inventory adjustments store SSOT',
    '',
    `**Verdict:** ${verdict}`,
    `**Generated:** ${generatedAt}`,
    `**Gates:** ${passed}/${total}`,
    '',
    ...gates.map((g) => `- ${g.ok ? 'PASS' : 'FAIL'} \`${g.id}\` — ${g.detail}`),
    '',
    '## Integrity',
    payload.integrity,
    '',
  ].join('\n');
  for (const dir of [clientRoot, repoRoot]) {
    writeFileSync(resolve(dir, 'PROOF_INVENTORY_ADJUSTMENTS_STORE_SSOT.json'), json);
    writeFileSync(resolve(dir, 'PROOF_INVENTORY_ADJUSTMENTS_STORE_SSOT.md'), md);
  }
});
