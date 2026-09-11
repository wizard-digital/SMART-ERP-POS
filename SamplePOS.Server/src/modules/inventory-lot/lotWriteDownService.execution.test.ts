/**
 * EXECUTED proof: writeDownNearExpiryLot against a fake PG client (real service, no greps).
 * Rejects must throw BusinessError. Unexpected errors are rethrown (no swallow).
 */
import { afterAll, describe, expect, it, jest } from '@jest/globals';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSaleLineNotBelowAllocatedCost } from '../sales/saleBelowCostGuard.js';
import { addDaysToDateString, getBusinessDate } from '../../utils/dateRange.js';
import {
  assertWriteDownCouplesSubledger,
  LOT_WRITE_DOWN_EXPENSE_ACCOUNT,
} from '@shared/inventory-lot/lotWriteDown.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

type Gate = { id: string; ok: boolean; detail: string; measured?: unknown };
const gates: Gate[] = [];

function gate(id: string, ok: boolean, detail: string, measured?: unknown): void {
  gates.push({ id, ok, detail, ...(measured !== undefined ? { measured } : {}) });
  expect({ id, ok, detail }).toEqual({ id, ok: true, detail });
}

function businessCode(e: unknown): string | null {
  if (!e || typeof e !== 'object') return null;
  const code = (e as { errorCode?: unknown }).errorCode;
  return typeof code === 'string' ? code : null;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

type JournalReq = {
  source?: string;
  referenceType?: string;
  lines: Array<{ accountCode: string; debitAmount: number; creditAmount: number }>;
  userId?: string;
};

type MockFn = (...args: unknown[]) => Promise<unknown>;

const capturedJournals: JournalReq[] = [];
const createJournalEntryMock = jest.fn<MockFn>(async (request: unknown) => {
  capturedJournals.push(request as JournalReq);
  return {
    transactionId: '11111111-1111-1111-1111-111111111111',
    transactionNumber: 'TXN-LWD',
    status: 'POSTED',
    totalDebits: 40000,
    totalCredits: 40000,
  };
});

jest.unstable_mockModule('../../services/accountingCore.js', () => ({
  AccountingCore: {
    createJournalEntry: createJournalEntryMock,
  },
  AccountingError: class AccountingError extends Error {},
}));

jest.unstable_mockModule('../../services/glEntryService.js', () => ({
  AccountCodes: {
    CLEARANCE_MARKDOWN: '5140',
    INVENTORY: '1300',
  },
}));

jest.unstable_mockModule('../../db/pool.js', () => ({
  pool: {
    query: jest.fn(),
    connect: jest.fn(),
    on: jest.fn(),
    end: jest.fn(),
  },
}));

jest.unstable_mockModule('../../utils/logger.js', () => ({
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

const { writeDownNearExpiryLot } = await import('./lotWriteDownService.js');

const PRODUCT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const BATCH_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const DOC_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const USER_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const CARRYING = 10000;
const ORIGINAL = 10000;
const NEW_COST = 6000;
const QTY = 10;

function makeBatch(over: Record<string, string | number | null> = {}) {
  const biz = getBusinessDate();
  return {
    id: BATCH_ID,
    product_id: PRODUCT_ID,
    batch_number: 'LWD-EXEC-1',
    expiry_date: addDaysToDateString(biz, 5),
    remaining_quantity: String(QTY),
    cost_price: String(CARRYING),
    original_cost_price: String(ORIGINAL),
    status: 'ACTIVE',
    min_days: 0,
    ...over,
  };
}

function makePool(batch: ReturnType<typeof makeBatch>) {
  const sqlLog: string[] = [];
  const live = { ...batch };
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      const s = sql.replace(/\s+/g, ' ').trim();
      sqlLog.push(s);
      if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }
      if (s.includes('FOR UPDATE OF b')) {
        return { rows: [live], rowCount: 1 };
      }
      if (s.includes('nextval')) {
        return { rows: [{ seq: 7 }] };
      }
      if (s.includes('INSERT INTO lot_write_down_documents')) {
        return { rows: [{ id: DOC_ID }], rowCount: 1 };
      }
      if (s.includes('UPDATE inventory_batches') && s.includes('SET cost_price')) {
        live.cost_price = String(params?.[1]);
        return { rows: [{ remaining_quantity: live.remaining_quantity }], rowCount: 1 };
      }
      if (s.includes('UPDATE product_lots') || s.includes('UPDATE cost_layers')) {
        return { rows: [], rowCount: 0 };
      }
      if (s.includes('UPDATE lot_write_down_documents')) {
        return { rows: [], rowCount: 1 };
      }
      if (s.includes('SELECT remaining_quantity FROM inventory_batches')) {
        return { rows: [{ remaining_quantity: live.remaining_quantity }], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL in execution proof: ${s}`);
    },
    release: () => undefined,
  };
  const pool = {
    connect: async () => client,
    totalCount: 1,
    query: client.query,
  };
  return { pool, sqlLog, live };
}

async function expectCode(
  batchOver: Record<string, string | number | null>,
  code: string,
): Promise<{ threw: true; errorCode: string } | { threw: false; errorCode: '' }> {
  const { pool } = makePool(makeBatch(batchOver));
  try {
    await writeDownNearExpiryLot(pool as never, {
      inventoryBatchId: BATCH_ID,
      newUnitCost: NEW_COST,
      userId: USER_ID,
    });
    return { threw: false, errorCode: '' };
  } catch (e) {
    const code = businessCode(e);
    if (code) return { threw: true, errorCode: code };
    throw e;
  }
}

describe('EXECUTED lot write-down service', () => {
  it('requires userId (no SYSTEM_USER_ID fallback)', async () => {
    const { pool } = makePool(makeBatch());
    try {
      await writeDownNearExpiryLot(pool as never, {
        inventoryBatchId: BATCH_ID,
        newUnitCost: NEW_COST,
        userId: '',
      });
      gate('EXEC_REQUIRE_USER', false, 'empty userId should throw');
    } catch (e) {
      const msg = errorMessage(e);
      if (!msg.includes('userId is required')) throw e;
      gate('EXEC_REQUIRE_USER', true, msg);
    }
  });

  it('happy path: qty unchanged, original preserved, GL 5140/1300, then POS floor = new carrying', async () => {
    capturedJournals.length = 0;
    createJournalEntryMock.mockClear();
    const { pool, sqlLog, live } = makePool(makeBatch());
    const result = await writeDownNearExpiryLot(pool as never, {
      inventoryBatchId: BATCH_ID,
      newUnitCost: NEW_COST,
      userId: USER_ID,
      memo: 'execution proof',
    });

    gate('EXEC_DOC', result.documentNumber.startsWith('LWD-'), `documentNumber=${result.documentNumber}`);
    gate('EXEC_QTY_UNCHANGED', result.remainingQuantity === QTY, `remaining=${result.remainingQuantity}`);
    gate(
      'EXEC_ORIGINAL_KEPT',
      result.originalUnitCost === ORIGINAL && Number(live.cost_price) === NEW_COST,
      `original=${result.originalUnitCost} carryingNow=${live.cost_price}`,
    );
    gate('EXEC_AMOUNT', result.totalAmount === 40000, `amount=${result.totalAmount}`);
    gate('EXEC_ACCOUNT', result.expenseAccountCode === '5140', `account=${result.expenseAccountCode}`);

    const je = capturedJournals[0];
    gate('EXEC_GL_CALLED', capturedJournals.length === 1, `journals=${capturedJournals.length}`);
    gate('EXEC_GL_SOURCE', je?.source === 'INVENTORY_MOVE', `source=${je?.source}`);
    gate('EXEC_GL_REF', je?.referenceType === 'LOT_WRITE_DOWN', `ref=${je?.referenceType}`);
    gate('EXEC_GL_USER', je?.userId === USER_ID, 'actor not replaced with system user');
    const dr = je?.lines.find((l) => l.debitAmount > 0);
    const cr = je?.lines.find((l) => l.creditAmount > 0);
    gate(
      'EXEC_GL_SHAPE',
      dr?.accountCode === LOT_WRITE_DOWN_EXPENSE_ACCOUNT &&
        dr.debitAmount === 40000 &&
        cr?.accountCode === '1300' &&
        cr.creditAmount === 40000,
      `DR ${dr?.accountCode}=${dr?.debitAmount} CR ${cr?.accountCode}=${cr?.creditAmount}`,
      je,
    );
    assertWriteDownCouplesSubledger({
      quantity: QTY,
      previousCarrying: CARRYING,
      newCarrying: NEW_COST,
      glAmount: 40000,
    });
    gate('EXEC_COUPLING', true, 'qty × (old−new) = GL 40000');

    gate(
      'EXEC_NO_QTY_DECREMENT_SQL',
      !sqlLog.some((s) => s.includes('remaining_quantity = remaining_quantity -')),
      'no qty decrement SQL',
    );

    expect(() =>
      assertSaleLineNotBelowAllocatedCost({
        productId: PRODUCT_ID,
        quantity: 1,
        lineRevenue: NEW_COST,
        totalAllocatedCost: NEW_COST,
        costPerSellingUnit: NEW_COST,
        unitPrice: NEW_COST,
      }),
    ).not.toThrow();
    try {
      assertSaleLineNotBelowAllocatedCost({
        productId: PRODUCT_ID,
        quantity: 1,
        lineRevenue: NEW_COST - 1,
        totalAllocatedCost: NEW_COST,
        costPerSellingUnit: NEW_COST,
        unitPrice: NEW_COST - 1,
      });
      gate('EXEC_POS_BELOW_NEW_COST', false, 'below new carrying should throw');
    } catch (e) {
      const code = businessCode(e);
      if (code !== 'BELOW_ALLOCATED_COST') throw e;
      gate('EXEC_POS_BELOW_NEW_COST', true, code);
    }
  });

  it('rejects quarantined, expired, no-expiry, and >60-day lots with thrown codes (no swallow)', async () => {
    capturedJournals.length = 0;
    const q = await expectCode({ status: 'QUARANTINED' }, 'LOT_WRITE_DOWN_NOT_ACTIVE');
    gate('EXEC_REJECT_QUARANTINE', q.threw && q.errorCode === 'LOT_WRITE_DOWN_NOT_ACTIVE', q.errorCode);

    const biz = getBusinessDate();
    const exp = await expectCode({ expiry_date: biz }, 'LOT_WRITE_DOWN_EXPIRED');
    gate('EXEC_REJECT_EXPIRED', exp.threw && exp.errorCode === 'LOT_WRITE_DOWN_EXPIRED', exp.errorCode);

    const none = await expectCode({ expiry_date: null }, 'LOT_WRITE_DOWN_NO_EXPIRY');
    gate('EXEC_REJECT_NO_EXPIRY', none.threw && none.errorCode === 'LOT_WRITE_DOWN_NO_EXPIRY', none.errorCode);

    const beyond = await expectCode({ expiry_date: addDaysToDateString(biz, 61) }, 'LOT_WRITE_DOWN_NOT_CRITICAL');
    gate(
      'EXEC_REJECT_BEYOND_60',
      beyond.threw && beyond.errorCode === 'LOT_WRITE_DOWN_NOT_CRITICAL',
      beyond.errorCode,
    );

    const { pool } = makePool(makeBatch());
    try {
      await writeDownNearExpiryLot(pool as never, {
        inventoryBatchId: BATCH_ID,
        newUnitCost: 0.001,
        userId: USER_ID,
      });
      gate('EXEC_REJECT_FLOOR', false, 'below floor should throw');
    } catch (e) {
      const code = businessCode(e);
      if (code !== 'LOT_WRITE_DOWN_BELOW_FLOOR') throw e;
      gate('EXEC_REJECT_FLOOR', true, code);
    }

    gate('EXEC_REJECT_NO_GL', capturedJournals.length === 0, `journalsAfterRejects=${capturedJournals.length}`);
  });

  it('accepts 20-day and 60-day still-sellable lots', async () => {
    const biz = getBusinessDate();
    const d20 = await expectCode({ expiry_date: addDaysToDateString(biz, 20) }, 'LOT_WRITE_DOWN_NOT_CRITICAL');
    gate('EXEC_ACCEPT_20', !d20.threw, d20.errorCode || 'posted');
    const d60 = await expectCode({ expiry_date: addDaysToDateString(biz, 60) }, 'LOT_WRITE_DOWN_NOT_CRITICAL');
    gate('EXEC_ACCEPT_60', !d60.threw, d60.errorCode || 'posted');
  });
});

afterAll(() => {
  const passed = gates.every((g) => g.ok);
  const payload = {
    proof: 'LOT_WRITE_DOWN_EXECUTED',
    passed,
    asOf: new Date().toISOString(),
    mode: 'service-execution-mock-pg',
    gates,
  };
  writeFileSync(
    path.join(repoRoot, 'PROOF_LOT_WRITE_DOWN_EXECUTED.json'),
    JSON.stringify(payload, null, 2),
  );
  expect(passed).toBe(true);
});
