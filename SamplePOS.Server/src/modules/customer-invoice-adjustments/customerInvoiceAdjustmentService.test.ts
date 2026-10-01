/**
 * Customer Invoice Adjustment Service — unit tests
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { Pool } from 'pg';

type MockFn = jest.Mock<(...args: unknown[]) => unknown>;

const mockPoolQuery = jest.fn<MockFn>();
const mockPool = { query: mockPoolQuery } as unknown as Pool;

const mockCnRepo = {
    getInvoiceById: jest.fn<MockFn>(),
    getNotesForInvoice: jest.fn<MockFn>(),
    sumPostedCreditNotesForInvoice: jest.fn<MockFn>(),
};

const mockInvoiceRepo = {
    getInvoiceById: jest.fn<MockFn>(),
    getInvoiceSettlement: jest.fn<MockFn>(),
};

const mockSalesRepo = {
    getSaleById: jest.fn<MockFn>(),
};

const mockCnService = {
    createCreditNote: jest.fn<MockFn>(),
    postNote: jest.fn<MockFn>(),
};

const mockGetFinalPrice = jest.fn<MockFn>();
const mockGetPricingMode = jest.fn<MockFn>();

jest.unstable_mockModule('../credit-debit-notes/creditDebitNoteRepository.js', () => ({
    creditDebitNoteRepository: mockCnRepo,
}));

jest.unstable_mockModule('../invoices/invoiceRepository.js', () => ({
    invoiceRepository: mockInvoiceRepo,
}));

jest.unstable_mockModule('../sales/salesRepository.js', () => ({
    salesRepository: mockSalesRepo,
}));

jest.unstable_mockModule('../credit-debit-notes/creditDebitNoteService.js', () => ({
    creditDebitNoteService: mockCnService,
}));

jest.unstable_mockModule('../pricing/pricingEngineService.js', () => ({
    getFinalPrice: mockGetFinalPrice,
}));

jest.unstable_mockModule('../pricing/pricingRepository.js', () => ({
    getCustomerPricingMode: mockGetPricingMode,
}));

const { customerInvoiceAdjustmentService } = await import('./customerInvoiceAdjustmentService.js');

const baseInvoice = {
    id: 'inv-1',
    invoiceNumber: 'INV-2026-0001',
    customerId: 'cust-1',
    customerName: 'BOU',
    subtotal: 100000,
    taxAmount: 0,
    totalAmount: 100000,
    amountPaid: 0,
    outstandingBalance: 100000,
    status: 'UNPAID',
    documentType: 'INVOICE',
    issueDate: '2026-05-01',
};

describe('customerInvoiceAdjustmentService', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockPoolQuery.mockResolvedValue({ rows: [] });
        mockCnRepo.getInvoiceById.mockResolvedValue(baseInvoice);
        mockCnRepo.getNotesForInvoice.mockResolvedValue([]);
        mockCnRepo.sumPostedCreditNotesForInvoice.mockResolvedValue(0);
        mockInvoiceRepo.getInvoiceById.mockResolvedValue({ sale_id: 'sale-1' });
        mockInvoiceRepo.getInvoiceSettlement.mockResolvedValue({
            totalAmount: 100000,
            amountPaid: 0,
            amountDue: 100000,
        });
        mockGetPricingMode.mockResolvedValue('AT_COST');
    });

    describe('getInvoiceContext', () => {
        it('detects overcharged sale lines vs pricing engine', async () => {
            mockSalesRepo.getSaleById.mockResolvedValue({
                sale: { status: 'COMPLETED', sale_number: 'SALE-1' },
                items: [
                    {
                        id: 'si-1',
                        product_id: 'prod-1',
                        product_name: 'Widget',
                        quantity: 2,
                        unit_price: 5000,
                        unit_cost: 3000,
                    },
                ],
            });
            mockGetFinalPrice.mockResolvedValue({
                finalPrice: 3000,
                appliedRule: { scope: 'at_cost' },
            });

            const ctx = await customerInvoiceAdjustmentService.getInvoiceContext(mockPool, 'inv-1');

            expect(ctx.overchargeLines).toHaveLength(1);
            expect(ctx.overchargeLines[0].suggestedCreditPerUnit).toBe(2000);
            expect(ctx.overchargeLines[0].suggestedLineCredit).toBe(4000);
            expect(ctx.maxAdditionalCredit).toBe(4000);
            expect(ctx.suggestedIntent).toBe('PRICE_CORRECTION');
        });

        it('reduces line credit when a prior posted CN already credited that sale item', async () => {
            mockPoolQuery.mockResolvedValue({
                rows: [{ description: 'sale_item:si-1|charged:5000|correct:3000', line_total: 3000 }],
            });
            mockSalesRepo.getSaleById.mockResolvedValue({
                sale: { status: 'COMPLETED', sale_number: 'SALE-1' },
                items: [
                    {
                        id: 'si-1',
                        product_id: 'prod-1',
                        product_name: 'Widget',
                        quantity: 1,
                        unit_price: 5000,
                        unit_cost: 3000,
                    },
                ],
            });
            mockGetFinalPrice.mockResolvedValue({ finalPrice: 3000, appliedRule: { scope: 'at_cost' } });

            const ctx = await customerInvoiceAdjustmentService.getInvoiceContext(mockPool, 'inv-1');

            expect(ctx.overchargeLines).toHaveLength(1);
            expect(ctx.overchargeLines[0].suggestedLineCredit).toBe(2000);
        });

        it('rejects fully settled invoices with no correctable lines', async () => {
            mockInvoiceRepo.getInvoiceSettlement.mockResolvedValue({
                totalAmount: 40000,
                amountPaid: 40000,
                amountDue: 0,
            });
            mockCnRepo.getInvoiceById.mockResolvedValue({
                ...baseInvoice,
                amountPaid: 40000,
                outstandingBalance: 0,
                status: 'PAID',
            });
            mockSalesRepo.getSaleById.mockResolvedValue({
                sale: { status: 'COMPLETED', sale_number: 'SALE-1' },
                items: [],
            });

            await expect(
                customerInvoiceAdjustmentService.getInvoiceContext(mockPool, 'inv-1'),
            ).rejects.toMatchObject({ error_code: 'ADJUST_INVOICE_SETTLED' });
        });

        it('caps line credits when invoice-level prior CN consumed most overcharge headroom', async () => {
            mockCnRepo.getInvoiceById.mockResolvedValue({
                ...baseInvoice,
                totalAmount: 126300,
                outstandingBalance: 126300,
            });
            mockInvoiceRepo.getInvoiceSettlement.mockResolvedValue({
                totalAmount: 126300,
                amountPaid: 0,
                amountDue: 126300,
            });
            mockCnRepo.sumPostedCreditNotesForInvoice.mockResolvedValue(81700);
            mockPoolQuery.mockResolvedValue({ rows: [] });
            mockSalesRepo.getSaleById.mockResolvedValue({
                sale: { status: 'COMPLETED', sale_number: 'SALE-0026' },
                items: [
                    {
                        id: 'si-a',
                        product_id: 'p1',
                        product_name: 'Benzhexol 5mg',
                        quantity: 60,
                        unit_price: 500,
                        unit_cost: 285,
                    },
                    {
                        id: 'si-b',
                        product_id: 'p2',
                        product_name: 'Mediscar silicone gel 15g',
                        quantity: 1,
                        unit_price: 50000,
                        unit_cost: 25000,
                    },
                    {
                        id: 'si-c',
                        product_id: 'p3',
                        product_name: 'Selegiline 5mg tabs',
                        quantity: 60,
                        unit_price: 1000,
                        unit_cost: 250,
                    },
                ],
            });
            mockGetFinalPrice
                .mockResolvedValueOnce({ finalPrice: 285, appliedRule: { scope: 'at_cost' } })
                .mockResolvedValueOnce({ finalPrice: 25000, appliedRule: { scope: 'at_cost' } })
                .mockResolvedValueOnce({ finalPrice: 250, appliedRule: { scope: 'at_cost' } });

            const ctx = await customerInvoiceAdjustmentService.getInvoiceContext(mockPool, 'inv-1');

            const gross = 12900 + 25000 + 45000;
            expect(gross).toBe(82900);
            expect(ctx.existingCreditNoteTotal).toBe(81700);
            expect(ctx.maxAdditionalCredit).toBeCloseTo(1200, 0);
            expect(ctx.totalSuggestedCredit).toBeCloseTo(1200, 0);
            const lineSum = ctx.overchargeLines.reduce((s, l) => s + l.suggestedLineCredit, 0);
            expect(lineSum).toBeCloseTo(1200, 0);
        });

        it('rejects when credit notes already cover full overcharge', async () => {
            mockCnRepo.sumPostedCreditNotesForInvoice.mockResolvedValue(4000);
            mockPoolQuery.mockResolvedValue({
                rows: [{ description: 'sale_item:si-1|charged:5000|correct:3000', line_total: 4000 }],
            });
            mockSalesRepo.getSaleById.mockResolvedValue({
                sale: { status: 'COMPLETED', sale_number: 'SALE-1' },
                items: [
                    {
                        id: 'si-1',
                        product_id: 'prod-1',
                        product_name: 'Widget',
                        quantity: 1,
                        unit_price: 5000,
                        unit_cost: 3000,
                    },
                ],
            });
            mockGetFinalPrice.mockResolvedValue({ finalPrice: 3000, appliedRule: { scope: 'at_cost' } });

            await expect(
                customerInvoiceAdjustmentService.getInvoiceContext(mockPool, 'inv-1'),
            ).rejects.toMatchObject({ error_code: 'ADJUST_ALREADY_CREDITED' });
        });

        it('rejects void linked sales', async () => {
            mockSalesRepo.getSaleById.mockResolvedValue({
                sale: { status: 'VOID', sale_number: 'SALE-VOID' },
                items: [],
            });

            await expect(
                customerInvoiceAdjustmentService.getInvoiceContext(mockPool, 'inv-1'),
            ).rejects.toMatchObject({ error_code: 'ADJUST_SALE_VOID' });
        });
    });

    describe('adjust PRICE_CORRECTION', () => {
        it('creates and posts a credit note for selected lines', async () => {
            mockSalesRepo.getSaleById.mockResolvedValue({
                sale: { status: 'COMPLETED', sale_number: 'SALE-1' },
                items: [
                    {
                        id: 'si-1',
                        product_id: 'prod-1',
                        product_name: 'Widget',
                        quantity: 1,
                        unit_price: 5000,
                        unit_cost: 3000,
                    },
                ],
            });
            mockGetFinalPrice.mockResolvedValue({ finalPrice: 3000, appliedRule: { scope: 'at_cost' } });
            mockCnService.createCreditNote.mockResolvedValue({
                note: { id: 'cn-1', invoiceNumber: 'CN-2026-0001' },
                lineItems: [],
            });
            mockCnService.postNote.mockResolvedValue({
                id: 'cn-1',
                invoiceNumber: 'CN-2026-0001',
            });

            const result = await customerInvoiceAdjustmentService.adjust(
                mockPool,
                {
                    intent: 'PRICE_CORRECTION',
                    invoiceId: 'inv-1',
                    reason: 'AT_COST correction',
                    lines: [{ saleItemId: 'si-1' }],
                },
                'user-1',
            );

            expect(result.creditNoteNumber).toBe('CN-2026-0001');
            expect(result.totalCredit).toBe(2000);
            expect(mockCnService.createCreditNote).toHaveBeenCalledWith(
                mockPool,
                expect.objectContaining({
                    noteType: 'PRICE_CORRECTION',
                    returnsGoods: false,
                    lines: expect.arrayContaining([
                        expect.objectContaining({ unitPrice: 2000, quantity: 1 }),
                    ]),
                }),
            );
            expect(mockCnService.postNote).toHaveBeenCalledWith(mockPool, 'cn-1', 'user-1');
        });
    });
});
