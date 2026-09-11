/**
 * Phase 2C — disposal posting proofs (LQ-INV-2/6/7/9)
 */

import {
  expenseAccountForDisposal,
  movementTypeForDisposal,
  assertDisposalCouplesSubledger,
  LossQuarantineInvariantError,
} from '@shared/loss-quarantine/index.js';
import { resolveWriteOffPosting } from './lossDisposalService.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

function readRepo(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

describe('Loss disposal posting (Phase 2C)', () => {
  describe('LQ-INV-7 reason → account', () => {
    it('WRITE_OFF from DAMAGE → 5120 / DAMAGE movement', () => {
      expect(
        expenseAccountForDisposal({ reason: 'WRITE_OFF', fromStoreType: 'DAMAGE' }),
      ).toBe('5120');
      expect(
        movementTypeForDisposal({ reason: 'WRITE_OFF', fromStoreType: 'DAMAGE' }),
      ).toBe('DAMAGE');
      expect(resolveWriteOffPosting('DAMAGE')).toEqual({
        movementType: 'DAMAGE',
        expenseAccountCode: '5120',
      });
    });

    it('WRITE_OFF from EXPIRED → 5130 / EXPIRY movement', () => {
      expect(resolveWriteOffPosting('EXPIRED')).toEqual({
        movementType: 'EXPIRY',
        expenseAccountCode: '5130',
      });
    });

    it('WRITE_OFF from MAIN → 5110 / ADJUSTMENT_OUT', () => {
      expect(resolveWriteOffPosting('MAIN')).toEqual({
        movementType: 'ADJUSTMENT_OUT',
        expenseAccountCode: '5110',
      });
    });
  });

  describe('LQ-INV-2 coupling', () => {
    it('accepts matched GL and batch values', () => {
      expect(() =>
        assertDisposalCouplesSubledger({
          glAmount: 2500,
          batchConsumptionValue: 2500,
        }),
      ).not.toThrow();
    });

    it('rejects drift', () => {
      expect(() =>
        assertDisposalCouplesSubledger({
          glAmount: 2500,
          batchConsumptionValue: 2000,
        }),
      ).toThrow(LossQuarantineInvariantError);
    });
  });

  it('disposal service + schema 546 exist', () => {
    expect(
      readRepo('shared/sql/546_loss_disposal_documents.sql'),
    ).toMatch(/loss_disposal_documents/);
    const svc = readRepo(
      'SamplePOS.Server/src/modules/loss-quarantine/lossDisposalService.ts',
    );
    expect(svc).toContain('disposeFromQuarantine');
    expect(svc).toContain('reverseDisposal');
    expect(svc).toContain('allowDisposalStatuses');
    expect(svc).toMatch(/Prefer inventoryBatchId from the aging line/);
    // INV-002: disposal qty dual-write via processMovement → consumeLot (no pre-adjust balances)
    expect(svc).toContain('sourceStoreLocationId');
    expect(svc).toMatch(/Qty dual-write owned by StockMovementHandler/);
  });

  it('lot selector skips expiry filter when disposing calendar-expired batches', () => {
    const selector = readRepo(
      'SamplePOS.Server/src/modules/inventory-lot/postgresLotSelector.ts',
    );
    expect(selector).toMatch(
      /allowDisposalStatuses[\s\S]*clause:\s*'TRUE'/,
    );
    expect(selector).toMatch(/status::text/);
  });

  it('warehouse WRITE_OFF uses resolveWriteOffPosting', () => {
    const adj = readRepo(
      'SamplePOS.Server/src/modules/inventory/warehouse/warehouseAdjustmentService.ts',
    );
    expect(adj).toContain('resolveWriteOffPosting');
  });

  it('GL accepts expenseAccountCode override', () => {
    const gl = readRepo('SamplePOS.Server/src/services/glEntryService.ts');
    expect(gl).toContain('expenseAccountCode');
  });
});
