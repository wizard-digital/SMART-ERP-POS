/**
 * salesService.createSale — POS strict-reject contract for stale quoteId.
 *
 * Proves the wired-up pre-check (not just the helper guard) rejects a sale
 * BEFORE any inventory mutation or sale insert. Uses the same
 * jest.unstable_mockModule pattern as salesService.test.ts so the heavy
 * salesService graph loads with all side-effect imports neutralised.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { Pool, PoolClient, QueryResult } from 'pg';

type MockFn = (...args: unknown[]) => Promise<unknown>;
type QueryRow = Record<string, unknown>;

// ──────────────────────────────────────────────────────────────────────────
// Mocks (must run before the dynamic `await import('./salesService.js')`)
// ──────────────────────────────────────────────────────────────────────────

const mockSalesRepo = {
  createSale: jest.fn<MockFn>(),
  addSaleItems: jest.fn<MockFn>(),
  getSaleById: jest.fn<MockFn>(),
  listSales: jest.fn<MockFn>(),
  getSalesSummary: jest.fn<MockFn>(),
  updateSaleStatus: jest.fn<MockFn>(),
  generateSaleNumber: jest.fn<MockFn>().mockResolvedValue('SALE-2026-TEST'),
  getFIFOCostLayers: jest.fn<MockFn>(),
  updateCostLayerQuantity: jest.fn<MockFn>(),
  createCostLayer: jest.fn<MockFn>(),
  getProductSalesSummary: jest.fn<MockFn>(),
  getTopSellingProducts: jest.fn<MockFn>(),
  getSalesSummaryByDate: jest.fn<MockFn>(),
  getSalesDetailsReport: jest.fn<MockFn>(),
  getSalesByCashierSummary: jest.fn<MockFn>(),
  getSalesByCashierDetail: jest.fn<MockFn>(),
  getSalesSummaryFromRollup: jest.fn<MockFn>(),
};

jest.unstable_mockModule('./salesRepository.js', () => ({
  salesRepository: mockSalesRepo,
  default: mockSalesRepo,
}));

jest.unstable_mockModule('../../services/costLayerService.js', () => ({
  getCostLayers: jest.fn<MockFn>().mockResolvedValue([]),
  consumeLayers: jest.fn<MockFn>().mockResolvedValue(undefined),
  calculateFIFOCost: jest.fn<MockFn>().mockResolvedValue(0),
}));

jest.unstable_mockModule('../../services/bankingService.js', () => ({
  BankingService: jest.fn(() => ({
    recordCashSale: jest.fn<MockFn>().mockResolvedValue(undefined),
  })),
}));

jest.unstable_mockModule('../cash-register/index.js', () => ({
  cashRegisterService: {
    recordSaleMovement: jest.fn<MockFn>().mockResolvedValue(undefined),
    getCurrentSessionForUser: jest.fn<MockFn>().mockResolvedValue({
      session: null,
      posSessionPolicy: 'DISABLED',
    }),
  },
  cashRegisterRepository: {
    getSessionById: jest.fn<MockFn>().mockResolvedValue(null),
    getUserOpenSession: jest.fn<MockFn>().mockResolvedValue(null),
    getPosSessionPolicy: jest.fn<MockFn>().mockResolvedValue('DISABLED'),
    isSessionParticipant: jest.fn<MockFn>().mockResolvedValue(null),
  },
}));

jest.unstable_mockModule('../../middleware/errorHandler.js', () => ({
  ValidationError: class extends Error {
    constructor(msg: string) { super(msg); this.name = 'ValidationError'; }
  },
  BusinessError: class extends Error {
    errorCode: string;
    details: Record<string, unknown>;
    constructor(msg: string, code: string, details: Record<string, unknown> = {}) {
      super(msg);
      this.name = 'BusinessError';
      this.errorCode = code;
      this.details = details;
    }
  },
  NotFoundError: class extends Error {
    constructor(resource: string) { super(`${resource} not found`); this.name = 'NotFoundError'; }
  },
  ForbiddenError: class extends Error {
    constructor(msg: string = 'Forbidden') { super(msg); this.name = 'ForbiddenError'; }
  },
  ConflictError: class extends Error {
    constructor(msg: string) { super(msg); this.name = 'ConflictError'; }
  },
}));

jest.unstable_mockModule('../../middleware/businessRules.js', () => ({
  SalesBusinessRules: {
    MAX_ITEMS_PER_SALE: 100,
    MIN_SALE_AMOUNT: 0,
    validateSaleItems: jest.fn(),
    validateCreditSale: jest.fn<MockFn>().mockResolvedValue(undefined),
  },
  InventoryBusinessRules: { ALLOW_NEGATIVE_STOCK: false },
}));

jest.unstable_mockModule('../../services/accountingApiClient.js', () => ({
  accountingApiClient: { postJournalEntry: jest.fn<MockFn>().mockResolvedValue(undefined) },
}));

jest.unstable_mockModule('../../services/glEntryService.js', () => ({
  createSaleGLEntries: jest.fn<MockFn>().mockResolvedValue(undefined),
  reverseSaleGLEntries: jest.fn<MockFn>().mockResolvedValue(undefined),
}));

jest.unstable_mockModule('../../db/batchFetch.js', () => ({
  batchFetchProducts: jest.fn<MockFn>().mockResolvedValue(new Map()),
  batchFetchProductUoms: jest.fn<MockFn>().mockResolvedValue(new Map()),
}));

jest.unstable_mockModule('../../utils/maintenanceGuard.js', () => ({
  checkMaintenanceMode: jest.fn<MockFn>().mockResolvedValue(undefined),
}));

const { salesService } = await import('./salesService.js');
const { BusinessError, NotFoundError } = await import('../../middleware/errorHandler.js');

// ──────────────────────────────────────────────────────────────────────────
// Query router — replays SQL responses based on the statement text. Keeps
// every transactional verb (BEGIN, SAVEPOINT, SET LOCAL …) silent so we can
// drive the createSale entry path purely through `quotations` row state.
// ──────────────────────────────────────────────────────────────────────────

interface RouterState {
  quoteRow: { status: string; quote_number: string | null } | null; // null = not found
  recordedQueries: string[];
}

function buildRouter(state: RouterState) {
  return async (sql: unknown, _params?: unknown): Promise<QueryResult<QueryRow>> => {
    const text = String(sql);
    state.recordedQueries.push(text);

    // Transaction control / savepoints / session vars — silent.
    if (/^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|SET LOCAL)/i.test(text)) {
      return { rows: [], rowCount: 0, command: 'BEGIN', oid: 0, fields: [] };
    }

    // Session policy lookup — force DISABLED so we skip cash-register checks.
    if (/system_settings/i.test(text) && /pos_session_policy/i.test(text)) {
      return {
        rows: [{ pos_session_policy: 'DISABLED' }],
        rowCount: 1, command: 'SELECT', oid: 0, fields: [],
      };
    }

    // The pre-check itself.
    if (/FROM\s+quotations\s+WHERE\s+id\s*=\s*\$1\s+FOR\s+UPDATE/i.test(text)) {
      const rows = state.quoteRow ? [state.quoteRow] : [];
      return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
    }

    // Anything else should NOT be reached on the strict-reject path.
    return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] };
  };
}

const mockClient = {
  query: jest.fn<MockFn>(),
  release: jest.fn<MockFn>(),
} as unknown as PoolClient;

const mockPool = {
  query: jest.fn<MockFn>(),
  connect: jest.fn<MockFn>().mockResolvedValue(mockClient),
} as unknown as Pool;

// Minimal valid input — the only field that matters for this contract is
// `quoteId`. Everything else is set so input validation does not fail
// independently and confuse the assertion.
function baseInput(quoteId: string) {
  return {
    customerId: null,
    quoteId,
    items: [{
      productId: 'p1',
      productName: 'Widget',
      quantity: 1,
      unitPrice: 100,
    }],
    paymentMethod: 'CASH' as const,
    paymentReceived: 100,
    soldBy: 'user-1',
  };
}

describe('salesService.createSale — POS strict-reject for stale quoteId (ERR_SALE_005)', () => {
  let routerState: RouterState;

  beforeEach(() => {
    jest.clearAllMocks();
    routerState = { quoteRow: null, recordedQueries: [] };
    (mockClient.query as jest.Mock<MockFn>).mockImplementation(buildRouter(routerState) as MockFn);
  });

  it.each(['CONVERTED', 'CANCELLED', 'REJECTED', 'EXPIRED'])(
    'rejects with ERR_SALE_005 when quote status is %s — and never reaches the sale insert',
    async (status) => {
      routerState.quoteRow = { status, quote_number: `Q-2026-${status}` };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const promise = salesService.createSale(mockPool, baseInput('quote-uuid-1') as any);
      await expect(promise).rejects.toBeInstanceOf(BusinessError as unknown as new () => Error);

      let caught: unknown;
      try { await promise; } catch (e) { caught = e; }
      const err = caught as { errorCode: string; message: string; details: Record<string, unknown> };
      expect(err.errorCode).toBe('ERR_SALE_005');
      expect(err.message).toContain(`Q-2026-${status}`);
      expect(err.message).toContain(status);

      // CONTRACT: pre-check ran AND no inventory/sale write happened.
      const ranPreCheck = routerState.recordedQueries.some((q) =>
        /FROM\s+quotations\s+WHERE\s+id\s*=\s*\$1\s+FOR\s+UPDATE/i.test(q),
      );
      expect(ranPreCheck).toBe(true);
      expect(mockSalesRepo.createSale).not.toHaveBeenCalled();
      expect(mockSalesRepo.addSaleItems).not.toHaveBeenCalled();
    },
  );

  it('rejects with NotFoundError when the quoteId does not exist — no sale insert', async () => {
    routerState.quoteRow = null;

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      salesService.createSale(mockPool, baseInput('ghost-quote-id') as any),
    ).rejects.toBeInstanceOf(NotFoundError as unknown as new () => Error);

    expect(mockSalesRepo.createSale).not.toHaveBeenCalled();
    expect(mockSalesRepo.addSaleItems).not.toHaveBeenCalled();
  });

  it('skips the quote pre-check entirely when no quoteId is supplied', async () => {
    // No quoteId → the pre-check block is not entered at all.
    // We do not assert the sale succeeds (other downstream pieces are not
    // wired) — just that the pre-check SELECT is NEVER issued.
    routerState.quoteRow = { status: 'CONVERTED', quote_number: 'Q-SHOULD-NOT-LOAD' };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const promise = salesService.createSale(mockPool, { ...baseInput(''), quoteId: null } as any);
    await promise.catch(() => { /* downstream may throw; we only care about the pre-check */ });

    const ranPreCheck = routerState.recordedQueries.some((q) =>
      /FROM\s+quotations\s+WHERE\s+id\s*=\s*\$1\s+FOR\s+UPDATE/i.test(q),
    );
    expect(ranPreCheck).toBe(false);
  });
});
