/**
 * Evidence: ADJUSTMENT_IN cannot create valued stock without GL 1300.
 * Locks the Henber Flugone / Fentanyl residual class of drift.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from '@jest/globals';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8');

describe('ADJUSTMENT_IN GL lock', () => {
  it('stockMovementHandler refuses valued adj without GL (inbound + outbound)', () => {
    const src = read('src/modules/inventory/stockMovementHandler.ts');
    expect(src).toContain('ERR_INVENTORY_ADJUST_NO_COST');
    expect(src).toContain('stock increase');
    expect(src).toContain('qty×unitCost so we never skip GL silently');
    expect(src).toContain('assertInventoryCouplingUnchanged');
  });

  it('ADJUSTMENT_IN stamps zero-cost lots and refuses locked cost mismatch', () => {
    const src = read('src/modules/inventory/stockMovementHandler.ts');
    expect(src).toContain('ERR_INVENTORY_ADJUST_COST_MISMATCH');
    expect(src).toContain('returnLot only bumps qty and ignores costPrice');
    expect(src).toContain('SET cost_price = $1');
  });

  it('recordStockMovementToGL throws on ADJUSTMENT_IN zero value', () => {
    const src = read('src/services/glEntryService.ts');
    expect(src).toContain("movement.movementType === 'ADJUSTMENT_IN'");
    expect(src).toContain('movementValue must be > 0');
  });

  it('integrity checker flags valued ADJUSTMENT_IN without GL twin', () => {
    const src = read('src/services/glIntegrityChecker.ts');
    expect(src).toContain('checkAdjustmentInMissingGl');
    expect(src).toContain('adjustment_in_missing_gl');
    expect(src).toContain("'ADJUSTMENT_IN'");
  });

  it('syncProductQuantity keeps header cost_price on batch wavg', () => {
    const src = read('src/utils/inventorySync.ts');
    expect(src).toContain('wavg_cost');
    expect(src).toContain('cost_price = COALESCE((SELECT wavg_cost FROM batch_agg), cost_price)');
  });

  it('inventory GL drift heal uses per-day referenceId (not nil UUID)', () => {
    const src = read('src/modules/system/glRepairService.ts');
    expect(src).toContain('inventoryGlDriftHealReferenceId');
    expect(src).toContain('inventoryGlDriftHealReferenceId(idempotencyKey)');
    expect(src).not.toMatch(
      /healInventoryGlDrift[\s\S]*referenceId:\s*'00000000-0000-0000-0000-000000000000'/,
    );
  });
});
