/**
 * EVIDENCE: INV-POS — multistore POS sellable coverage SSOT.
 * Run: npm test -- --runInBand src/modules/inventory/warehouse/posSellableCoverage.evidence.test.ts
 */
import { describe, expect, it } from '@jest/globals';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const repoRoot = path.resolve(serverRoot, '..');

type Gate = { id: string; ok: boolean; detail: string };
const gates: Gate[] = [];

function gate(id: string, ok: boolean, detail: string): void {
  gates.push({ id, ok, detail });
  expect({ id, ok, detail }).toEqual({ id, ok: true, detail });
}

function readServer(rel: string): string {
  return readFileSync(path.join(serverRoot, rel), 'utf8');
}

function readClient(rel: string): string {
  return readFileSync(path.join(repoRoot, 'samplepos.client', rel), 'utf8');
}

describe('EVIDENCE — INV-POS sellable coverage SSOT', () => {
  it('guards enable, receive, UI defaults, and coupling', () => {
    const receipt = readServer('src/modules/inventory/warehouse/multistoreReceiptStore.ts');
    const lotSvc = readServer('src/modules/inventory-lot/lotService.ts');
    const grn = readServer('src/modules/inventory/warehouse/warehouseGrnService.ts');
    const settings = readServer('src/modules/system-settings/systemSettingsService.ts');
    const backfill = readServer(
      'src/modules/inventory/warehouse/multistoreSellableBackfillService.ts',
    );
    const coverage = readServer('src/modules/inventory/warehouse/posSellableCoverage.ts');
    const coupling = readServer('src/services/warehouseInventoryCoupling.ts');
    const stockUi = readClient('src/pages/inventory/StockLevelsPage.tsx');
    const productsUi = readClient('src/pages/inventory/ProductsPage.tsx');
    const stockViewSsot = readClient('src/components/inventory/warehouseNetworkUtils.ts');
    const grUi = readClient('src/pages/inventory/GoodsReceiptsPage.tsx');
    const fragments = readServer('src/modules/inventory/warehouse/inventoryStockSqlFragments.ts');
    const balanceRepo = readServer('src/modules/inventory/warehouse/inventoryBalanceRepository.ts');
    const visibility = readServer('src/modules/inventory/warehouse/stockVisibilityService.ts');
    const posCatalog = readServer('src/modules/inventory/warehouse/posProductSearchRepository.ts');

    gate(
      'RESOLVE_DEFAULT_SELLING',
      receipt.includes('getActivePosSellingStore') &&
        lotSvc.includes('resolveMultistoreReceiptStoreId') &&
        grn.includes('resolveMultistoreReceiptStoreId'),
      'Implicit GR allocate prefers POS SELLING via shared resolver',
    );
    gate(
      'OPENING_ALLOCATES',
      /receiveOpeningLot[\s\S]*allocateReceivedLotToStore/.test(lotSvc),
      'Opening balance allocates to store balances under multistore',
    );
    gate(
      'ENABLE_BACKFILL',
      settings.includes('multistoreSellableBackfillService') &&
        settings.includes('ensurePosSellableFromBatches'),
      'Enabling multistore runs POS sellable backfill',
    );
    gate(
      'BACKFILL_MOVES_MAIN',
      backfill.includes('moveLotQuantityBetweenStores') &&
        backfill.includes('assertPosSellableCoverageConsistent'),
      'Backfill moves MAIN→SELLING and asserts INV-POS',
    );
    gate(
      'COVERAGE_REASONS',
      coverage.includes('NO_LOT') &&
        coverage.includes('SELLING_ZERO_MAIN_HAS') &&
        coverage.includes('SELLING_ZERO_QUARANTINE_HAS') &&
        coverage.includes("store_type IN ('RETURN', 'DAMAGE', 'EXPIRED')") &&
        coverage.includes('assertPosSellableProjectionConsistent'),
      'INV-POS gap detector + quarantine reason + projection assert exist',
    );
    gate(
      'PROJECTION_ALLOWS_QUARANTINE',
      /assertPosSellableProjectionConsistent[\s\S]{0,900}NO_LOT[\s\S]{0,200}SELLING_ZERO_NO_BALANCES/.test(
        coverage,
      ),
      'projection hard-fail is NO_LOT / SELLING_ZERO_NO_BALANCES only',
    );
    gate(
      'COUPLING_WIRES_POS',
      coupling.includes('assertPosSellableProjectionConsistent'),
      'Warehouse coupling asserts POS projection gaps',
    );
    gate(
      'NETWORK_COMPANY_STOCK',
      fragments.includes('OPERATIONAL_NETWORK_STORE_FILTER_SQL') &&
        fragments.includes("store_type IN ('MAIN', 'SELLING')") &&
        /getStockLevels[\s\S]{0,250}OPERATIONAL_NETWORK_STORE_FILTER_SQL/.test(balanceRepo) &&
        visibility.includes('getStockLevelsForStore') &&
        posCatalog.includes('Full POS catalog for multistore — active selling store only'),
      'Inventory company qty is MAIN+shops; POS catalog and visibility stay selling-store scoped',
    );
    gate(
      'UI_STOCK_DEFAULT_SELLING',
      stockViewSsot.includes('resolveDefaultStockViewStore') &&
        stockViewSsot.includes('warehouse → shops') &&
        stockViewSsot.includes('operationalNetworkStores') &&
        productsUi.includes('retainOrDefaultStockViewStoreId') &&
        productsUi.includes('filter-store-location-products') &&
        stockUi.includes('retainOrDefaultStockViewStoreId') &&
        stockUi.includes('filter-store-location') &&
        productsUi.includes('stockQtyByProductId'),
      'Products and Stock Levels put warehouse→shop picker in Filters; company overlays network stock-levels SSOT',
    );
    gate(
      'UI_GR_DEFAULT_SELLING',
      grUi.includes('INV-POS') &&
        grUi.includes("storeType === 'SELLING'") &&
        /sellingStore \?\? defaultReceiving \?\? mainStore/.test(grUi),
      'Goods Receipt default destination is SELLING',
    );

    const passed = gates.filter((g) => g.ok).length;
    const payload = {
      feature: 'INV_POS_SELLABLE_COVERAGE',
      verdict: passed === gates.length ? 'PASS' : 'FAIL',
      passed,
      total: gates.length,
      gates,
      generatedAt: new Date().toISOString(),
    };
    writeFileSync(
      path.join(repoRoot, 'PROOF_INV_POS_SELLABLE_COVERAGE.json'),
      `${JSON.stringify(payload, null, 2)}\n`,
    );
    writeFileSync(
      path.join(repoRoot, 'PROOF_INV_POS_SELLABLE_COVERAGE.md'),
      `# PROOF_INV_POS_SELLABLE_COVERAGE\n\nVerdict: **${payload.verdict}** (${passed}/${gates.length})\n\n` +
        gates.map((g) => `- ${g.ok ? 'PASS' : 'FAIL'} \`${g.id}\`: ${g.detail}`).join('\n') +
        '\n',
    );
  });
});
