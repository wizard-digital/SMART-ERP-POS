/**
 * HANDLER PROOF: storeIssueService.reverse is invoked — not a grep.
 *
 * Short reason, four-eyes, missing movements, and the happy path that restores
 * FEFO lots, writes GOODS_ISSUE_REVERSAL, and calls AccountingCore.reverseTransaction.
 *
 * Run: node --experimental-vm-modules ./node_modules/jest/bin/jest.js src/modules/kitchen-production/storeIssueService.reverse.harness.test.ts --no-coverage --forceExit
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';

type MockFn = (...args: unknown[]) => Promise<unknown>;

const DOC_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const POSTER = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const REVERSER = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const PRODUCT = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const BATCH = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const JOURNAL = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
const REASON = 'Entered wrong quantity';

const mockRepo = {
  tableExists: jest.fn<MockFn>().mockResolvedValue(true),
  getById: jest.fn<MockFn>(),
  listIssueMovements: jest.fn<MockFn>(),
  markReversed: jest.fn<MockFn>().mockResolvedValue(true),
};

const mockReturnLot = jest.fn<MockFn>().mockResolvedValue(undefined);
const mockReverseTransaction = jest.fn<MockFn>().mockResolvedValue({ transactionId: 'rev-jnl-1' });
const mockIsRestaurant = jest.fn<MockFn>().mockResolvedValue(true);
const mockIsMultistore = jest.fn<MockFn>().mockResolvedValue(false);
const mockAllocate = jest.fn<MockFn>().mockResolvedValue('MOV-2026-00099');
const mockSyncQty = jest.fn<MockFn>().mockResolvedValue(undefined);

const mockQuery = jest.fn<MockFn>();
const mockClient = {
  query: mockQuery,
  release: jest.fn(),
} as unknown as PoolClient;

const mockPool = {
  connect: async () => mockClient,
  query: jest.fn<MockFn>(),
} as unknown as Pool;

jest.unstable_mockModule('../../db/pool.js', () => ({ pool: mockPool }));

jest.unstable_mockModule('./storeIssueRepository.js', () => ({
  storeIssueRepository: mockRepo,
}));

jest.unstable_mockModule('../restaurant/restaurantSettings.js', () => ({
  isRestaurantModeEnabled: mockIsRestaurant,
}));

jest.unstable_mockModule('../inventory/warehouse/multistoreSettings.js', () => ({
  isMultistoreEnabled: mockIsMultistore,
}));

jest.unstable_mockModule('../inventory-lot/lotService.js', () => ({
  lotService: {
    returnLot: mockReturnLot,
    consumeLot: jest.fn<MockFn>(),
  },
}));

jest.unstable_mockModule('../../services/accountingCore.js', () => ({
  AccountingCore: {
    reverseTransaction: mockReverseTransaction,
    createJournalEntry: jest.fn<MockFn>(),
  },
}));

jest.unstable_mockModule('../../services/glEntryService.js', () => ({
  AccountCodes: { INVENTORY: '1300' },
}));

jest.unstable_mockModule('../../services/inventorySubledgerCoupling.js', () => ({
  captureInventoryCoupling: jest.fn<MockFn>().mockResolvedValue({
    glNet1300: 0,
    batchValuation: 0,
    gap: 0,
  }),
  assertInventoryCouplingUnchanged: jest.fn(),
}));

jest.unstable_mockModule('../../utils/documentNumberAllocation.js', () => ({
  allocateNextMovementNumber: mockAllocate,
}));

jest.unstable_mockModule('../../utils/inventorySync.js', () => ({
  syncProductQuantity: mockSyncQty,
}));

jest.unstable_mockModule('../../utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { storeIssueService } = await import('./storeIssueService.js');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

const evidence: Array<{ name: string; ok: true; detail: Record<string, unknown> }> = [];

function prove(name: string, detail: Record<string, unknown>): void {
  evidence.push({ name, ok: true, detail });
}

function postedDoc(over: Record<string, unknown> = {}) {
  return {
    id: DOC_ID,
    documentNumber: 'GI-2026-00009',
    status: 'POSTED',
    postedBy: POSTER,
    journalEntryId: JOURNAL,
    storeLocationId: null,
    issuedTo: 'KITCHEN',
    expenseAccountCode: '5150',
    lines: [{ productId: PRODUCT, issuedQtyBase: 5, requestedQtyBase: 5 }],
    ...over,
  };
}

describe('storeIssueService.reverse handler (executed)', () => {
  const inserts: Array<{ sql: string; params: unknown[] }> = [];

  beforeEach(() => {
    jest.clearAllMocks();
    inserts.length = 0;
    mockIsRestaurant.mockResolvedValue(true);
    mockRepo.tableExists.mockResolvedValue(true);
    mockRepo.markReversed.mockResolvedValue(true);
    mockIsMultistore.mockResolvedValue(false);
    mockAllocate.mockResolvedValue('MOV-2026-00099');
    mockReverseTransaction.mockResolvedValue({ transactionId: 'rev-jnl-1' });
    mockReturnLot.mockResolvedValue(undefined);
    mockQuery.mockImplementation(async (...args: unknown[]) => {
      const sql = String(args[0] ?? '');
      if (sql.includes('FOR UPDATE')) return { rows: [{ id: DOC_ID }] };
      if (sql.includes('INSERT INTO stock_movements')) {
        inserts.push({ sql, params: Array.isArray(args[1]) ? (args[1] as unknown[]) : [] });
        return { rows: [] };
      }
      return { rows: [] };
    });
  });

  it('refuses reverse when restaurant mode is off', async () => {
    mockIsRestaurant.mockResolvedValue(false);
    mockRepo.getById.mockResolvedValue(postedDoc());
    await expect(
      storeIssueService.reverse(mockPool, DOC_ID, REVERSER, {
        reason: REASON,
        canOverrideFourEyes: false,
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      message: expect.stringMatching(/restaurant mode/i),
    });
    expect(mockReturnLot).not.toHaveBeenCalled();
    expect(mockReverseTransaction).not.toHaveBeenCalled();
    prove('restaurant-off-reverse-forbidden', { statusCode: 403, glCalled: false });
  });

  it('refuses a short reversal reason and does not touch stock or GL', async () => {
    mockRepo.getById.mockResolvedValue(postedDoc());
    mockRepo.listIssueMovements.mockResolvedValue([
      { productId: PRODUCT, batchId: BATCH, quantity: 5, unitCost: 100 },
    ]);
    await expect(
      storeIssueService.reverse(mockPool, DOC_ID, REVERSER, {
        reason: 'no',
        canOverrideFourEyes: false,
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/reversal reason is required/i),
    });
    expect(mockReturnLot).not.toHaveBeenCalled();
    expect(mockReverseTransaction).not.toHaveBeenCalled();
    expect(mockRepo.markReversed).not.toHaveBeenCalled();
    expect(mockQuery.mock.calls.some((c) => String(c[0]).includes('ROLLBACK'))).toBe(true);
    prove('short-reason-refused', { rollback: true, glCalled: false, returnLot: false });
  });

  it('four-eyes: poster cannot reverse without inventory.approve override', async () => {
    mockRepo.getById.mockResolvedValue(postedDoc());
    mockRepo.listIssueMovements.mockResolvedValue([
      { productId: PRODUCT, batchId: BATCH, quantity: 5, unitCost: 100 },
    ]);
    await expect(
      storeIssueService.reverse(mockPool, DOC_ID, POSTER, {
        reason: REASON,
        canOverrideFourEyes: false,
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      message: expect.stringMatching(/cannot reverse a goods issue you posted/i),
    });
    expect(mockReturnLot).not.toHaveBeenCalled();
    expect(mockReverseTransaction).not.toHaveBeenCalled();
    prove('four-eyes-poster-forbidden', { statusCode: 403, glCalled: false });
  });

  it('refuses reverse when GOODS_ISSUE movements are missing (no GL reverse)', async () => {
    mockRepo.getById.mockResolvedValue(postedDoc());
    mockRepo.listIssueMovements.mockResolvedValue([]);
    await expect(
      storeIssueService.reverse(mockPool, DOC_ID, REVERSER, {
        reason: REASON,
        canOverrideFourEyes: false,
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      errorCode: 'ERR_SI_REVERSE_MOVEMENTS',
    });
    expect(mockReverseTransaction).not.toHaveBeenCalled();
    expect(mockReturnLot).not.toHaveBeenCalled();
    prove('missing-movements-no-gl', { errorCode: 'ERR_SI_REVERSE_MOVEMENTS', glCalled: false });
  });

  it('happy path: returnLot + GOODS_ISSUE_REVERSAL + AccountingCore.reverseTransaction', async () => {
    mockRepo.getById
      .mockResolvedValueOnce(postedDoc())
      .mockResolvedValueOnce({ ...postedDoc(), status: 'REVERSED', reversalReason: REASON });
    mockRepo.listIssueMovements.mockResolvedValue([
      { productId: PRODUCT, batchId: BATCH, quantity: 5, unitCost: 100 },
    ]);

    const result = await storeIssueService.reverse(mockPool, DOC_ID, REVERSER, {
      reason: REASON,
      canOverrideFourEyes: false,
    });

    expect(result.status).toBe('REVERSED');
    expect(mockReturnLot).toHaveBeenCalledTimes(1);
    const returned = mockReturnLot.mock.calls[0][1] as {
      quantity: number;
      referenceType: string;
      batchId: string;
    };
    expect(returned.quantity).toBe(5);
    expect(returned.referenceType).toBe('STORE_ISSUE_REVERSAL');
    expect(returned.batchId).toBe(BATCH);

    expect(inserts).toHaveLength(1);
    expect(inserts[0].params[3]).toBe('GOODS_ISSUE_REVERSAL');
    expect(inserts[0].params[6]).toBe('STORE_ISSUE_REVERSAL');

    expect(mockReverseTransaction).toHaveBeenCalledTimes(1);
    const gl = mockReverseTransaction.mock.calls[0][0] as {
      originalTransactionId: string;
      idempotencyKey: string;
      reason: string;
    };
    expect(gl.originalTransactionId).toBe(JOURNAL);
    expect(gl.idempotencyKey).toBe(`STORE_ISSUE_REVERSAL-${DOC_ID}`);
    expect(gl.reason).toContain(REASON);

    expect(mockRepo.markReversed).toHaveBeenCalledTimes(1);
    const marked = mockRepo.markReversed.mock.calls[0][2] as {
      reversedBy: string;
      reversalJournalId: string;
      reversalReason: string;
    };
    expect(marked.reversedBy).toBe(REVERSER);
    expect(marked.reversalJournalId).toBe('rev-jnl-1');
    expect(marked.reversalReason).toBe(REASON);
    expect(mockQuery.mock.calls.some((c) => String(c[0]).includes('COMMIT'))).toBe(true);

    prove('happy-path-reverse-posted', {
      status: result.status,
      returnLotQty: returned.quantity,
      movementType: inserts[0].params[3],
      referenceType: inserts[0].params[6],
      originalJournalId: gl.originalTransactionId,
      idempotencyKey: gl.idempotencyKey,
      reversalReason: marked.reversalReason,
    });
  });

  it('writes executed handler evidence', () => {
    expect(evidence.length).toBe(5);
    const payload = {
      title: 'PROOF_STORE_ISSUE_REVERSE_HANDLER',
      runAt: new Date().toISOString(),
      verdict: 'PASS',
      exercised: 'storeIssueService.reverse',
      checks: evidence,
    };
    const json = JSON.stringify(payload, null, 2);
    writeFileSync(path.join(repoRoot, 'PROOF_STORE_ISSUE_REVERSE_HANDLER.json'), json);
    writeFileSync(
      path.join(repoRoot, 'SamplePOS.Server/PROOF_STORE_ISSUE_REVERSE_HANDLER.json'),
      json,
    );
  });
});
