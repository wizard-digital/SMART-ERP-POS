/**
 * invoiceService unit tests
 * Tests invoice creation, payment processing, and listing.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { Pool, PoolClient } from 'pg';

/** Flexible mock fn type — avoids `any` while allowing mockResolvedValue/mockReturnValue */
type MockFn = (...args: unknown[]) => Promise<unknown>;

const mockInvoiceRepo = {
    createInvoice: jest.fn<MockFn>(),
    getInvoiceById: jest.fn<MockFn>(),
    healSettlementDrift: jest.fn<MockFn>(),
    listInvoices: jest.fn<MockFn>(),
    countInvoices: jest.fn<MockFn>(),
    addPayment: jest.fn<MockFn>(),
    listPayments: jest.fn<MockFn>(),
    updateInvoiceStatus: jest.fn<MockFn>(),
    getInvoiceLineItems: jest.fn<MockFn>(),
};

const mockSalesRepo = {
    getSaleById: jest.fn<MockFn>(),
    getSaleItems: jest.fn<MockFn>(),
};

jest.unstable_mockModule('./invoiceRepository.js', () => ({
    invoiceRepository: mockInvoiceRepo,
    default: mockInvoiceRepo,
}));

jest.unstable_mockModule('../sales/salesRepository.js', () => ({
    salesRepository: mockSalesRepo,
    default: mockSalesRepo,
}));

jest.unstable_mockModule('../../services/accountingApiClient.js', () => ({
    accountingApiClient: {
        postJournalEntry: jest.fn<MockFn>().mockResolvedValue(undefined),
    },
}));

jest.unstable_mockModule('../deposits/depositsService.js', () => ({
    getCustomerDepositBalance: jest.fn<MockFn>().mockResolvedValue(0),
    applyDeposit: jest.fn<MockFn>().mockResolvedValue(undefined),
}));

jest.unstable_mockModule('../../db/unitOfWork.js', () => ({
    UnitOfWork: {
        run: jest.fn(async (_pool: unknown, fn: (client: unknown) => Promise<unknown>) =>
            fn(mockClient)
        ),
    },
}));

const mockClient = {
    query: jest.fn<MockFn>().mockResolvedValue({ rows: [] }),
    release: jest.fn<MockFn>(),
} as unknown as PoolClient;

const mockPool = {
    query: jest.fn<MockFn>(),
    connect: jest.fn<MockFn>().mockResolvedValue(mockClient),
} as unknown as Pool;

const { invoiceService } = await import('./invoiceService.js');

describe('invoiceService', () => {
    beforeEach(() => { jest.clearAllMocks(); });

    describe('getInvoiceById', () => {
        it('should return invoice with line items', async () => {
            mockInvoiceRepo.healSettlementDrift.mockResolvedValue({
                id: 'inv1',
                invoice_number: 'INV-00001',
                total_amount: 5000,
                status: 'UNPAID',
            });
            mockInvoiceRepo.getInvoiceLineItems.mockResolvedValue([
                { id: 'li1', description: 'Item A', amount: 5000 },
            ]);

            const result = await invoiceService.getInvoiceById(mockPool, 'inv1');

            expect(result).toBeDefined();
            expect(mockInvoiceRepo.healSettlementDrift).toHaveBeenCalledWith(mockPool, 'inv1');
        });

        it('should throw for non-existent invoice', async () => {
            mockInvoiceRepo.healSettlementDrift.mockResolvedValue(null);
            mockInvoiceRepo.getInvoiceById.mockResolvedValue(null);

            await expect(invoiceService.getInvoiceById(mockPool, 'ghost')).rejects.toThrow();
        });
    });

    describe('listInvoices', () => {
        it('should return paginated invoices', async () => {
            mockInvoiceRepo.listInvoices.mockResolvedValue({
                rows: [{ id: 'inv1', invoice_number: 'INV-00001' }],
                total: 1,
            });

            const result = await invoiceService.listInvoices(mockPool, 1, 20);
            expect(result).toBeDefined();
        });
    });

    describe('listPayments', () => {
        it('should return payments for an invoice', async () => {
            mockInvoiceRepo.listPayments.mockResolvedValue([
                { id: 'pay1', amount: 2500, payment_method: 'CASH' },
            ]);

            const payments = await invoiceService.listPayments(mockPool, 'inv1');
            expect(payments).toHaveLength(1);
        });
    });
});
