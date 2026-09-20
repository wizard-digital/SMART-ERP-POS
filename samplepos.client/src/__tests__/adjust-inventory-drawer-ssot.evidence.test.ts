/**
 * PROOF: Adjust Inventory drawer is shared SSOT — Adjustments + Edit Product
 * reuse one component / one BatchAdjustmentSchema submit path (no fork).
 *
 * npx vitest run src/__tests__/adjust-inventory-drawer-ssot.evidence.test.ts
 */
import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const clientRoot = resolve(here, '../..');
const repoRoot = resolve(clientRoot, '..');

type Gate = { id: string; ok: boolean; detail: string };
const gates: Gate[] = [];

function gate(id: string, ok: boolean, detail: string): void {
  gates.push({ id, ok, detail });
  expect({ id, ok, detail }).toEqual({ id, ok: true, detail });
}

function readClient(rel: string): string {
  return readFileSync(resolve(clientRoot, 'src', rel), 'utf8');
}

describe('PROOF: AdjustInventoryDrawer SSOT (Adjustments + Edit Product)', () => {
  it('shares one drawer + one submit path; Edit Product mounts Adjust beside QOH', () => {
    const drawer = readClient('components/inventory/AdjustInventoryDrawer.tsx');
    const adjPage = readClient('pages/inventory/InventoryAdjustmentsPage.tsx');
    const products = readClient('pages/inventory/ProductsPage.tsx');

    gate(
      'DRAWER_SSOT_FILE',
      drawer.includes('BatchAdjustmentSchema.parse') &&
        drawer.includes('useAdjustBatch') &&
        drawer.includes('data-adjust-inventory-drawer="true"') &&
        drawer.includes('data-adjust-inventory-submit="true"') &&
        drawer.includes('resolveAdjustInventoryTarget'),
      'Shared drawer owns BatchAdjustmentSchema + useAdjustBatch submit',
    );

    gate(
      'ADJ_PAGE_USES_SHARED_DRAWER',
      adjPage.includes("from '../../components/inventory/AdjustInventoryDrawer'") &&
        adjPage.includes('<AdjustInventoryDrawer') &&
        adjPage.includes('resolveAdjustInventoryTarget') &&
        !adjPage.includes('handleSubmitAdjustment') &&
        !adjPage.includes('selectedBatch') &&
        !/showAdjustModal && selectedBatch/.test(adjPage),
      'Adjustments page mounts shared drawer only (no inline adjust form)',
    );

    gate(
      'PRODUCTS_EDIT_ADJUST_BUTTON',
      products.includes("from '../../components/inventory/AdjustInventoryDrawer'") &&
        products.includes('<AdjustInventoryDrawer') &&
        products.includes('data-product-adjust-inventory="true"') &&
        products.includes('handleOpenAdjustFromProduct') &&
        products.includes('Qty on hand') &&
        products.includes('resolveAdjustInventoryTarget') &&
        products.includes('resolveDefaultAdjustStoreId'),
      'Edit Product has Adjust button beside QOH opening shared drawer',
    );

    gate(
      'PRODUCTS_ADJUST_QTY_STORE_SSOT',
      products.includes('resolveDefaultAdjustStoreId(storeLocations)') &&
        products.includes('formatAdjustStoreLabel') &&
        products.includes('data-product-adjust-store="true"') &&
        products.includes('productAdjustStoreId') &&
        drawer.includes('store-products/') &&
        drawer.includes('inventoryBatchId') &&
        drawer.includes('data-adjust-lot-select="true"') &&
        drawer.includes('lotOptions') &&
        drawer.includes('★ FEFO'),
      'Edit Product: store picker + FEFO lot/batch select; store lots carry inventoryBatchId',
    );

    gate(
      'API_STORE_PRODUCT_LOTS_BATCH_ID',
      (() => {
        try {
          const svc = readFileSync(
            resolve(clientRoot, '../SamplePOS.Server/src/modules/inventory/warehouse/productStoreDistributionService.ts'),
            'utf8',
          );
          return (
            svc.includes('listLotsForProductAtStore') &&
            svc.includes('pl.inventory_batch_id') &&
            svc.includes('inventoryBatchId: r.inventory_batch_id')
          );
        } catch {
          return false;
        }
      })(),
      'listLotsForProductAtStore returns inventoryBatchId for lot↔batch coupling',
    );

    gate(
      'NO_DUPLICATE_ADJUST_SUBMIT_UI',
      (adjPage.match(/BatchAdjustmentSchema\.parse/g) || []).length === 1 &&
        !products.includes('BatchAdjustmentSchema') &&
        drawer.includes('BatchAdjustmentSchema.parse') &&
        // Physical count on Adjustments still uses schema once; drawer is the single-adjust UI
        adjPage.includes('PHYSICAL_COUNT'),
      'Products has no forked adjust schema; Adjustments keeps PHYSICAL_COUNT only',
    );

    gate(
      'DRAWER_INITIAL_CATEGORY',
      drawer.includes('initialMovementCategory') &&
        adjPage.includes("handleOpenAdjustModal(batch, 'DAMAGE')") &&
        adjPage.includes('adjustInitialCategory'),
      'Damage row action prefills shared drawer category (no local form state)',
    );
  });
});

afterAll(() => {
  const passed = gates.filter((g) => g.ok).length;
  const total = gates.length;
  const verdict = passed === total && total > 0 ? 'PASS' : 'FAIL';
  const generatedAt = new Date().toISOString();
  const payload = {
    proof: 'ADJUST_INVENTORY_DRAWER_SSOT',
    verdict,
    generatedAt,
    passed,
    total,
    gates,
    integrity:
      'Adjust Inventory UI+submit is one AdjustInventoryDrawer; Inventory Adjustments and Products Edit Product both mount it; no duplicated single-adjust form.',
  };
  const json = `${JSON.stringify(payload, null, 2)}\n`;
  const md = [
    '# PROOF — Adjust Inventory drawer SSOT',
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
    writeFileSync(resolve(dir, 'PROOF_ADJUST_INVENTORY_DRAWER_SSOT.json'), json);
    writeFileSync(resolve(dir, 'PROOF_ADJUST_INVENTORY_DRAWER_SSOT.md'), md);
  }
});
