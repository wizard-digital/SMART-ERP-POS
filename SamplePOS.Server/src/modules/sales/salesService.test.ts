/**
 * salesService unit tests
 * Tests sale retrieval, listing, and summary logic.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { Pool, PoolClient } from 'pg';

/** Flexible mock fn type — avoids `any` while allowing mockResolvedValue/mockReturnValue */
type MockFn = (...args: unknown[]) => Promise<unknown>;

const mockSalesRepo = {
    createSale: jest.fn<MockFn>(),
    addSaleItems: jest.fn<MockFn>(),
    getSaleById: jest.fn<MockFn>(),
    listSales: jest.fn<MockFn>(),
    getSalesSummary: jest.fn<MockFn>(),
    updateSaleStatus: jest.fn<MockFn>(),
    generateSaleNumber: jest.fn<MockFn>(),
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
        constructor(msg: string) {
            super(msg);
            this.name = 'ValidationError';
        }
    },
    BusinessError: class extends Error {
        errorCode: string;
        constructor(msg: string, code: string) {
            super(msg);
            this.name = 'BusinessError';
            this.errorCode = code;
        }
    },
    NotFoundError: class extends Error {
        constructor(msg: string) {
            super(`${msg} not found`);
            this.name = 'NotFoundError';
        }
    },
    ForbiddenError: class extends Error {
        constructor(msg: string = 'Forbidden') {
            super(msg);
            this.name = 'ForbiddenError';
        }
    },
    ConflictError: class extends Error {
        constructor(msg: string) {
            super(msg);
            this.name = 'ConflictError';
        }
    },
}));

jest.unstable_mockModule('../../middleware/businessRules.js', () => ({
    SalesBusinessRules: { MAX_ITEMS_PER_SALE: 100, MIN_SALE_AMOUNT: 0 },
    InventoryBusinessRules: { ALLOW_NEGATIVE_STOCK: false },
}));

jest.unstable_mockModule('../../services/accountingApiClient.js', () => ({
    accountingApiClient: {
        postJournalEntry: jest.fn<MockFn>().mockResolvedValue(undefined),
    },
}));

jest.unstable_mockModule('../../services/glEntryService.js', () => ({
    createSaleGLEntries: jest.fn<MockFn>().mockResolvedValue(undefined),
    reverseSaleGLEntries: jest.fn<MockFn>().mockResolvedValue(undefined),
}));

jest.unstable_mockModule('../../db/batchFetch.js', () => ({
    batchFetchProducts: jest.fn<MockFn>().mockResolvedValue(new Map()),
    batchFetchProductUoms: jest.fn<MockFn>().mockResolvedValue(new Map()),
}));

const { salesService } = await import('./salesService.js');

// Create mock pool that returns a mock client
const mockClient = {
    query: jest.fn<MockFn>(),
    release: jest.fn<MockFn>(),
} as unknown as PoolClient;

const mockPool = {
    query: jest.fn<MockFn>(),
    connect: jest.fn<MockFn>().mockResolvedValue(mockClient),
} as unknown as Pool;

describe('salesService', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        (mockClient.query as jest.Mock<MockFn>).mockResolvedValue({ rows: [] });
    });

    describe('getSaleById', () => {
        it('should return sale with items and payment lines', async () => {
            mockSalesRepo.getSaleById.mockResolvedValue({
                sale: { id: 's1', saleNumber: 'SALE-2025-0001', totalAmount: '100' },
                items: [{ id: 'i1', productName: 'Widget', quantity: 2 }],
                paymentLines: [{ id: 'pl1', method: 'CASH', amount: 100 }],
            });

            const result = await salesService.getSaleById(mockPool, 's1');

            expect(result.sale.id).toBe('s1');
            expect(result.items).toHaveLength(1);
        });

        it('should throw NotFoundError for missing sale', async () => {
            mockSalesRepo.getSaleById.mockResolvedValue(null);

            await expect(salesService.getSaleById(mockPool, 'ghost')).rejects.toThrow();
        });
    });

    describe('listSales', () => {
        it('should return paginated sales', async () => {
            mockSalesRepo.listSales.mockResolvedValue({
                sales: [{ id: 's1', saleNumber: 'SALE-2025-0001' }],
                total: 1,
            });

            const result = await salesService.listSales(mockPool, 1, 20);

            expect(result.sales).toHaveLength(1);
            expect(result.total).toBe(1);
        });
    });

    describe('getSalesSummary', () => {
        it('should return summary data', async () => {
            mockSalesRepo.getSalesSummaryFromRollup.mockResolvedValue({
                totalSales: 10,
                totalRevenue: '50000',
            });

            const summary = await salesService.getSalesSummary(mockPool);
            expect(summary).toBeDefined();
        });
    });
});
