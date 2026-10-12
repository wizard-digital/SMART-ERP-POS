/**
 * Phase 6 — structural cleanup + permission parity proofs (L01–L04).
 */
import { describe, it, expect } from '@jest/globals';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function src(rel: string): string {
  return readFileSync(resolve(serverRoot, rel), 'utf8');
}

describe('Phase 6 dead module cleanup (L01)', () => {
  it('supplierModule.ts removed; supplierRoutes is the mount', () => {
    expect(existsSync(resolve(serverRoot, 'src/modules/suppliers/supplierModule.ts'))).toBe(false);
    expect(src('src/server.ts')).toContain('supplierRoutes');
  });
});

describe('Phase 6 GR inventory SSOT documentation (L02)', () => {
  it('handler documents LotService path for lot-based GRN', () => {
    const handler = src('src/modules/inventory/stockMovementHandler.ts');
    expect(handler).toContain('LotService.receiveLot');
    expect(handler).toContain('finalizeGR');
  });

  it('finalizeGR uses LotService.receiveLot for lot-based GRN', () => {
    const gr = src('src/modules/goods-receipts/goodsReceiptService.ts');
    const finalize = gr.slice(gr.indexOf('async finalizeGR('), gr.indexOf('async updateGRItem('));
    expect(finalize).toContain('lotService.receiveLot');
    expect(finalize).toContain('lot-based GRN');
    expect(finalize).not.toContain('inventoryRepository.createBatch');
    expect(finalize).not.toContain('warehouseGrnService.postReceiptSegment');
  });

  it('createOpeningBalanceGRN uses receiveOpeningLot', () => {
    const gr = src('src/modules/goods-receipts/goodsReceiptService.ts');
    const opening = gr.slice(gr.indexOf('async createOpeningBalanceGRN('));
    expect(opening).toContain('receiveOpeningLot');
    expect(opening).not.toContain('INSERT INTO inventory_batches');
  });
});

describe('Phase 6 supplier invoice read permission (L03)', () => {
  it('GET /invoices requires suppliers.read', () => {
    const routes = src('src/modules/supplier-payments/supplierPaymentRoutes.ts');
    const listBlock = routes.slice(
      routes.indexOf("'/invoices'"),
      routes.indexOf("'/invoices/unbilled-grns'"),
    );
    expect(listBlock).toContain("requirePermission('suppliers.read')");
  });
});

describe('Phase 6 GR permission parity (L04)', () => {
  it('finalize and reverse-uninvoiced both require purchasing.post', () => {
    const routes = src('src/modules/goods-receipts/goodsReceiptRoutes.ts');
    const finalizeBlock = routes.slice(
      routes.indexOf("'/:id/finalize'"),
      routes.indexOf("'/:id/items/:itemId'"),
    );
    expect(finalizeBlock).toContain("requirePermission('purchasing.post')");
    expect(routes).toMatch(
      /goodsReceiptRoutes\.post\(\s*'\/:id\/reverse-uninvoiced'[\s\S]*?requirePermission\('purchasing\.post'\)/,
    );
  });
});

describe('Inventory lot domain Step 6 write-path migration', () => {
  it('warehouse returns route through LotService.returnLot', () => {
    const svc = src('src/modules/inventory/warehouse/warehouseReturnInventoryService.ts');
    expect(svc).toContain('lotService.returnLot');
    expect(svc).not.toContain('productLotRepository.upsertLot');
    expect(svc).not.toContain('INSERT INTO inventory_batches');
  });

  it('warehouse adjustment lot link uses ensureProjectionFromMaster', () => {
    const svc = src('src/modules/inventory/warehouse/warehouseAdjustmentService.ts');
    const fn = svc.slice(
      svc.indexOf('async function resolveOrCreateLotForIncrease'),
      svc.indexOf('function mapMovementType'),
    );
    expect(fn).toContain('ensureProjectionFromMaster');
    expect(fn).not.toContain('productLotRepository.upsertLot');
  });

  it('expiry automation syncs lot status via quarantine helper (LQ-INV-4)', () => {
    const svc = src('src/modules/inventory/warehouse/expiryAutomationService.ts');
    expect(svc).toContain('syncLotStatusAfterQuarantine');
    expect(svc).toContain("quarantineKind: 'EXPIRED'");
  });
});

describe('Inventory lot domain Step 7 write-path migration', () => {
  it('legacy customer return uses LotService.returnLot not direct batch SQL', () => {
    const util = src('src/utils/customerReturnInventory.ts');
    expect(util).toContain('lotService.returnLot');
    expect(util).not.toContain('INSERT INTO inventory_batches');
    expect(util).not.toMatch(/UPDATE inventory_batches[\s\S]*remaining_quantity/);
  });

  it('warehouse GRN segment projection reads expiry from batch master', () => {
    const repo = src('src/modules/inventory/warehouse/warehouseInventoryRepository.ts');
    const fn = repo.slice(
      repo.indexOf('async upsertLotAndIncrementBalance'),
      repo.indexOf('async moveLotQuantityBetweenStores'),
    );
    expect(fn).toContain('postgresLotRepository.upsertProjection');
    expect(fn).toContain('master.attributes.expiryDate');
    expect(fn).not.toContain('productLotRepository.upsertLot');
  });

  it('inventoryRepository no longer writes batch expiry directly', () => {
    const repo = src('src/modules/inventory/inventoryRepository.ts');
    expect(repo).not.toContain('updateBatchExpiry');
    expect(repo).not.toMatch(/UPDATE inventory_batches SET expiry_date/);
  });
});

describe('Inventory lot domain Step 8+ consumption gateway', () => {
  it('fefoDeduction routes through LotService.consumeLot', () => {
    const util = src('src/utils/fefoDeduction.ts');
    expect(util).toContain('lotService.consumeLot');
    expect(util).not.toMatch(/UPDATE inventory_batches[\s\S]*remaining_quantity/);
  });

  it('lotService implements consumeLot with LotSelector', () => {
    const svc = src('src/modules/inventory-lot/lotService.ts');
    expect(svc).toContain('async consumeLot(');
    expect(svc).toContain('selectLots');
    expect(svc).toContain('loadGlobalSelectableLots');
    expect(svc).toContain('decrementMasterRemainingQuantity');
  });

  it('atCostIssuePrice FEFO load uses postgresLotSelector + selectLots', () => {
    const pricing = src('src/modules/pricing/atCostIssuePrice.ts');
    expect(pricing).toContain('loadGlobalSelectableLots');
    expect(pricing).toContain("policy: 'FEFO'");
    expect(pricing).toContain('selectLots');
    expect(pricing).not.toContain('FEFO_BATCH_QUERY');
    const fn = pricing.slice(
      pricing.indexOf('async function loadSelectableLotsForIssuePreview'),
      pricing.indexOf('function allocateFefoIssue'),
    );
    expect(fn).toContain('loadGlobalSelectableLots');
    expect(fn).not.toMatch(/FROM inventory_batches[\s\S]*ORDER BY expiry_date/);
  });

  it('warehouse sale deduction routes through LotService.consumeLot', () => {
    const svc = src('src/modules/inventory/warehouse/warehouseSaleDeductionService.ts');
    expect(svc).toContain('lotService.consumeLot');
    expect(svc).not.toMatch(/UPDATE inventory_batches[\s\S]*remaining_quantity -/);
  });
});

describe('Inventory lot domain Step 9 salesService migration', () => {
  it('legacy sale FEFO deduction uses LotService.consumeLot', () => {
    const svc = src('src/modules/sales/salesService.ts');
    const block = svc.slice(
      svc.indexOf('// Map to accumulate actual FEFO batch deduction costs'),
      svc.indexOf('const trace = warehouseTraces.get(lineIdx)'),
    );
    expect(block.length).toBeGreaterThan(100);
    expect(block).toContain('lotService.consumeLot');
    expect(block).toContain('loadGlobalSelectableLots');
    expect(block).toContain("policy: 'FEFO'");
    expect(block).not.toMatch(/UPDATE inventory_batches[\s\S]*remaining_quantity -/);
    expect(block).not.toContain('loadSaleFefoBatchesForIssue');
  });

  it('legacy refund and void restore use LotService.returnLot', () => {
    const svc = src('src/modules/sales/salesService.ts');
    expect(svc).toContain('REFUND-RESTORE-');
    expect(svc).toContain('VOID-RESTORE-');
    const refundBlock = svc.slice(
      svc.indexOf('// 5b. Restore inventory batch (legacy single-store via LotService)'),
      svc.indexOf('// 5c. Sync product_inventory'),
    );
    expect(refundBlock).toContain('lotService.returnLot');
    expect(refundBlock).not.toMatch(/UPDATE inventory_batches[\s\S]*remaining_quantity \+/);
  });
});

describe('Inventory lot domain Step 10+ consolidation', () => {
  it('multistore sale deduction uses LotService.consumeLot', () => {
    const svc = src('src/modules/inventory/warehouse/warehouseSaleDeductionService.ts');
    const fn = svc.slice(
      svc.indexOf('async deductAtStore'),
      svc.indexOf('async deductForSaleLine'),
    );
    expect(fn).toContain('lotService.consumeLot');
    expect(fn).toContain('loadStoreSelectableLots');
    expect(fn).not.toContain('lockMultistoreBalancesForAllocation');
    expect(fn).not.toContain('adjustSellableQuantity');
  });

  it('pos allocation reads expiry from batch master', () => {
    const repo = src('src/modules/inventory/warehouse/posAllocationLockRepository.ts');
    expect(repo).toContain('INNER JOIN inventory_batches bat');
    expect(repo).toContain('bat.expiry_date');
    expect(repo).not.toMatch(/ORDER BY pl\.expiry_date/);
  });

  it('reports use LotCalculator days helper not SQL days_until_expiry', () => {
    const repo = src('src/modules/reports/reportsRepository.ts');
    expect(repo).toContain('computeDaysUntilExpiry');
    expect(repo).not.toMatch(/as days_until_expiry/i);
  });

  it('client grExpiryGate delegates to shared inventory-lot rules', () => {
    const gate = readFileSync(
      resolve(serverRoot, '..', 'samplepos.client', 'src', 'utils', 'grExpiryGate.ts'),
      'utf8',
    );
    expect(gate).toContain('@shared/inventory-lot/lotRules');
    expect(gate).toContain('requiresExpiryOnReceipt');
    expect(gate).toContain('receiptExpirySatisfied');
  });

  it('productLotRepository.upsertLot is retired', () => {
    const repo = src('src/modules/inventory/warehouse/productLotRepository.ts');
    expect(repo).toContain('upsertLot is retired');
    expect(repo).not.toMatch(/INSERT INTO product_lots/);
  });
});
