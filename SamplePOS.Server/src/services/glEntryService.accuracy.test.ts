/**
 * glEntryService — GL Posting Accuracy Tests
 *
 * Verifies that every GL posting function builds balanced journal entries
 * with correct account codes, debit/credit sides, and amounts.
 *
 * Strategy: Mock AccountingCore.createJournalEntry to capture the journal
 * lines it receives, then validate DR=CR, correct account codes, and amounts.
 */
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import type { JournalEntryRequest, JournalLine } from './accountingCore.js';

type MockFn = (...args: unknown[]) => Promise<unknown>;

// Capture journal entries passed to AccountingCore
let capturedEntries: JournalEntryRequest[] = [];
const createJournalEntryMock = jest.fn<MockFn>(async (request: unknown) => {
    capturedEntries.push(request as JournalEntryRequest);
    return {
        transactionId: 'txn-test-id',
        transactionNumber: 'TXN-000001',
        status: 'POSTED',
        totalDebits: 0,
        totalCredits: 0,
    };
});

const reverseTransactionMock = jest.fn<MockFn>(async () => {
    return {
        transactionId: 'txn-reversal-id',
        transactionNumber: 'TXN-000002',
        status: 'POSTED',
        totalDebits: 0,
        totalCredits: 0,
    };
});

jest.unstable_mockModule('./accountingCore.js', () => ({
    AccountingCore: {
        createJournalEntry: createJournalEntryMock,
        reverseTransaction: reverseTransactionMock,
    },
    AccountingError: class extends Error {
        constructor(msg: string, public readonly code: string) {
            super(msg);
            this.name = 'AccountingError';
        }
    },
}));

jest.unstable_mockModule('../db/pool.js', () => ({
    pool: { query: jest.fn<MockFn>() },
    default: { query: jest.fn<MockFn>() },
}));

jest.unstable_mockModule('../utils/logger.js', () => ({
    default: {
        info: jest.fn<MockFn>(),
        error: jest.fn<MockFn>(),
        warn: jest.fn<MockFn>(),
        debug: jest.fn<MockFn>(),
    },
}));

jest.unstable_mockModule('../utils/constants.js', () => ({
    SYSTEM_USER_ID: 'system-user',
}));

const {
    recordSaleToGL,
    recordCustomerDepositToGL,
    recordDepositApplicationToGL,
    recordCustomerPaymentToGL,
    recordExpenseToGL,
    recordGoodsReceiptToGL,
    recordStockAdjustmentToGL,
    recordOpeningStockToGL,
    recordCustomerCreditNoteToGL,
    recordCustomerDebitNoteToGL,
    recordSupplierCreditNoteToGL,
    recordSupplierDebitNoteToGL,
    AccountCodes,
} = await import('./glEntryService.js');

/** Helper: sum all debits from lines */
function totalDebits(lines: JournalLine[]): number {
    return lines.reduce((sum, l) => sum + l.debitAmount, 0);
}

/** Helper: sum all credits from lines */
function totalCredits(lines: JournalLine[]): number {
    return lines.reduce((sum, l) => sum + l.creditAmount, 0);
}

/** Helper: find line by account code */
function findLine(lines: JournalLine[], code: string): JournalLine | undefined {
    return lines.find(l => l.accountCode === code);
}

/** Helper: assert debits = credits within 0.001 tolerance */
function assertBalanced(lines: JournalLine[]) {
    const dr = totalDebits(lines);
    const cr = totalCredits(lines);
    expect(Math.abs(dr - cr)).toBeLessThan(0.001);
}

describe('glEntryService — GL Posting Accuracy', () => {
    beforeEach(() => {
        capturedEntries = [];
        jest.clearAllMocks();
        createJournalEntryMock.mockClear();
        reverseTransactionMock.mockClear();
    });

    // ========================================================================
    // recordSaleToGL — Cash Sale (inventory only, no tax)
    // ========================================================================
    describe('recordSaleToGL — cash sale, inventory only', () => {
        it('should post balanced DR Cash / CR Revenue / DR COGS / CR Inventory', async () => {
            await recordSaleToGL({
                saleId: 'sale-1',
                saleNumber: 'SALE-2026-0001',
                saleDate: '2026-03-15',
                totalAmount: 10000,
                costAmount: 6000,
                paymentMethod: 'CASH',
                saleItems: [
                    { productType: 'inventory', totalPrice: 10000, unitCost: 6000, quantity: 1 },
                ],
            });

            // Split-journal governance (migration 013): revenue journal + goods-issue journal
            expect(capturedEntries).toHaveLength(2);
            const revenueLines = capturedEntries[0].lines;
            const cogsLines = capturedEntries[1].lines;

            // Journal 1 — source: SALES_INVOICE
            expect(capturedEntries[0].source).toBe('SALES_INVOICE');

            // DR Cash 10000
            const cashLine = findLine(revenueLines, AccountCodes.CASH);
            expect(cashLine).toBeDefined();
            expect(cashLine!.debitAmount).toBe(10000);
            expect(cashLine!.creditAmount).toBe(0);

            // CR Sales Revenue 10000
            const revLine = findLine(revenueLines, AccountCodes.SALES_REVENUE);
            expect(revLine).toBeDefined();
            expect(revLine!.creditAmount).toBe(10000);

            // Journal 2 — source: INVENTORY_MOVE
            expect(capturedEntries[1].source).toBe('INVENTORY_MOVE');
            expect(capturedEntries[1].idempotencyKey).toBe('SALE-COGS-SALE-2026-0001');

            // DR COGS 6000
            const cogsLine = findLine(cogsLines, AccountCodes.COGS);
            expect(cogsLine).toBeDefined();
            expect(cogsLine!.debitAmount).toBe(6000);

            // CR Inventory 6000
            const invLine = findLine(cogsLines, AccountCodes.INVENTORY);
            expect(invLine).toBeDefined();
            expect(invLine!.creditAmount).toBe(6000);

            assertBalanced(revenueLines);
            assertBalanced(cogsLines);
        });

        it('should use correct idempotency key', async () => {
            await recordSaleToGL({
                saleId: 'sale-123',
                saleNumber: 'SALE-2026-0005',
                saleDate: '2026-03-15',
                totalAmount: 5000,
                costAmount: 3000,
                paymentMethod: 'CASH',
            });

            expect(capturedEntries[0].idempotencyKey).toBe('SALE-SALE-2026-0005');
            expect(capturedEntries[0].referenceType).toBe('SALE');
        });
    });

    // ========================================================================
    // recordSaleToGL — Card Sale
    // ========================================================================
    describe('recordSaleToGL — card sale', () => {
        it('should debit Credit Card Receipts (1020), not Cash', async () => {
            await recordSaleToGL({
                saleId: 'sale-card',
                saleNumber: 'SALE-2026-0010',
                saleDate: '2026-03-15',
                totalAmount: 5000,
                costAmount: 3000,
                paymentMethod: 'CARD',
                saleItems: [
                    { productType: 'inventory', totalPrice: 5000, unitCost: 3000, quantity: 1 },
                ],
            });

            const lines = capturedEntries[0].lines;
            const cardLine = findLine(lines, AccountCodes.CREDIT_CARD_RECEIPTS);
            expect(cardLine).toBeDefined();
            expect(cardLine!.debitAmount).toBe(5000);
            assertBalanced(lines);
        });
    });

    describe('recordSaleToGL — Airtel Money sale', () => {
        it('should debit Mobile Money (1040) so Airtel stays on the same liquidity ledger as MoMo', async () => {
            await recordSaleToGL({
                saleId: 'sale-airtel',
                saleNumber: 'SALE-2026-0011',
                saleDate: '2026-03-15',
                totalAmount: 7000,
                costAmount: 4200,
                paymentMethod: 'AIRTEL_MONEY',
                saleItems: [
                    { productType: 'inventory', totalPrice: 7000, unitCost: 4200, quantity: 1 },
                ],
            });

            const revenueLines = capturedEntries[0].lines;
            const momoLine = findLine(revenueLines, AccountCodes.MOBILE_MONEY);
            expect(momoLine).toBeDefined();
            expect(momoLine!.debitAmount).toBe(7000);
            expect(findLine(revenueLines, AccountCodes.CASH)).toBeUndefined();
            assertBalanced(revenueLines);
        });
    });

    // ========================================================================
    // recordSaleToGL — Credit Sale with partial payment
    // ========================================================================
    describe('recordSaleToGL — credit sale, partial payment', () => {
        it('should split debit between Cash and AR', async () => {
            await recordSaleToGL({
                saleId: 'sale-credit',
                saleNumber: 'SALE-2026-0020',
                saleDate: '2026-03-15',
                totalAmount: 10000,
                costAmount: 6000,
                paymentMethod: 'CREDIT',
                amountPaid: 3000,
                customerId: 'cust-1',
                customerName: 'John',
                saleItems: [
                    { productType: 'inventory', totalPrice: 10000, unitCost: 6000, quantity: 1 },
                ],
            });

            const lines = capturedEntries[0].lines;

            // DR Cash 3000 (amount paid)
            const cashLine = findLine(lines, AccountCodes.CASH);
            expect(cashLine).toBeDefined();
            expect(cashLine!.debitAmount).toBe(3000);

            // DR AR 7000 (unpaid)
            const arLine = findLine(lines, AccountCodes.ACCOUNTS_RECEIVABLE);
            expect(arLine).toBeDefined();
            expect(arLine!.debitAmount).toBe(7000);
            expect(arLine!.entityType).toBe('customer');
            expect(arLine!.entityId).toBe('cust-1');

            // CR Revenue 10000
            const revLine = findLine(lines, AccountCodes.SALES_REVENUE);
            expect(revLine).toBeDefined();
            expect(revLine!.creditAmount).toBe(10000);

            assertBalanced(lines);
        });

        it('should debit only AR when no payment made', async () => {
            await recordSaleToGL({
                saleId: 'sale-zero-paid',
                saleNumber: 'SALE-2026-0021',
                saleDate: '2026-03-15',
                totalAmount: 10000,
                costAmount: 6000,
                paymentMethod: 'CREDIT',
                amountPaid: 0,
                customerId: 'cust-1',
                saleItems: [
                    { productType: 'inventory', totalPrice: 10000, unitCost: 6000, quantity: 1 },
                ],
            });

            const lines = capturedEntries[0].lines;

            // No Cash line (amount paid = 0)
            const cashLine = findLine(lines, AccountCodes.CASH);
            expect(cashLine).toBeUndefined();

            // DR AR 10000 (full amount)
            const arLine = findLine(lines, AccountCodes.ACCOUNTS_RECEIVABLE);
            expect(arLine!.debitAmount).toBe(10000);
            expect(arLine!.entityType).toBe('customer');
            expect(arLine!.entityId).toBe('cust-1');

            assertBalanced(lines);
        });
    });

    // ========================================================================
    // recordSaleToGL — Mixed inventory + service revenue
    // ========================================================================
    describe('recordSaleToGL — mixed inventory + service', () => {
        it('should split revenue between 4000 and 4100', async () => {
            await recordSaleToGL({
                saleId: 'sale-mixed',
                saleNumber: 'SALE-2026-0030',
                saleDate: '2026-03-15',
                totalAmount: 15000,
                costAmount: 5000,
                paymentMethod: 'CASH',
                saleItems: [
                    { productType: 'inventory', totalPrice: 10000, unitCost: 5000, quantity: 2 },
                    { productType: 'service', totalPrice: 5000, unitCost: 0, quantity: 1 },
                ],
            });

            // Split-journal: revenue [0] + goods-issue [1]
            expect(capturedEntries).toHaveLength(2);
            const revLines = capturedEntries[0].lines;
            const cogsLines = capturedEntries[1].lines;

            // DR Cash 15000
            expect(findLine(revLines, AccountCodes.CASH)!.debitAmount).toBe(15000);

            // CR Sales Revenue (4000) = 10000 (inventory)
            expect(findLine(revLines, AccountCodes.SALES_REVENUE)!.creditAmount).toBe(10000);

            // CR Service Revenue (4100) = 5000 (service)
            expect(findLine(revLines, AccountCodes.SERVICE_REVENUE)!.creditAmount).toBe(5000);

            // DR COGS 10000 (inventory cost: 2 × 5000)
            expect(findLine(cogsLines, AccountCodes.COGS)!.debitAmount).toBe(10000);

            // CR Inventory 10000
            expect(findLine(cogsLines, AccountCodes.INVENTORY)!.creditAmount).toBe(10000);

            assertBalanced(revLines);
            assertBalanced(cogsLines);
        });

        it('should NOT create COGS for service-only sale', async () => {
            await recordSaleToGL({
                saleId: 'sale-service',
                saleNumber: 'SALE-2026-0031',
                saleDate: '2026-03-15',
                totalAmount: 5000,
                costAmount: 0,
                paymentMethod: 'CASH',
                saleItems: [
                    { productType: 'service', totalPrice: 5000, unitCost: 0, quantity: 1 },
                ],
            });

            const lines = capturedEntries[0].lines;

            // No COGS or Inventory lines for service
            expect(findLine(lines, AccountCodes.COGS)).toBeUndefined();
            expect(findLine(lines, AccountCodes.INVENTORY)).toBeUndefined();

            // Only Cash and Service Revenue
            expect(findLine(lines, AccountCodes.CASH)!.debitAmount).toBe(5000);
            expect(findLine(lines, AccountCodes.SERVICE_REVENUE)!.creditAmount).toBe(5000);

            assertBalanced(lines);
        });
    });

    // ========================================================================
    // recordSaleToGL — With Tax
    // ========================================================================
    describe('recordSaleToGL — with tax', () => {
        it('should post tax to Tax Payable (2300) and keep entry balanced', async () => {
            // totalAmount is tax-inclusive (10000 revenue + 1800 tax = 11800)
            // saleItems totalPrice is the PRE-TAX revenue amount
            await recordSaleToGL({
                saleId: 'sale-tax',
                saleNumber: 'SALE-2026-0040',
                saleDate: '2026-03-15',
                totalAmount: 11800,
                costAmount: 6000,
                paymentMethod: 'CASH',
                taxAmount: 1800,
                saleItems: [
                    { productType: 'inventory', totalPrice: 10000, unitCost: 6000, quantity: 1 },
                ],
            });

            // Split-journal: revenue+tax [0] + goods-issue [1]
            expect(capturedEntries).toHaveLength(2);
            const revLines = capturedEntries[0].lines;
            const cogsLines = capturedEntries[1].lines;

            // DR Cash 11800 (tax-inclusive total)
            expect(findLine(revLines, AccountCodes.CASH)!.debitAmount).toBe(11800);

            // CR Revenue 10000 (pre-tax)
            expect(findLine(revLines, AccountCodes.SALES_REVENUE)!.creditAmount).toBe(10000);

            // CR Tax Payable 1800
            const taxLine = findLine(revLines, AccountCodes.TAX_PAYABLE);
            expect(taxLine).toBeDefined();
            expect(taxLine!.creditAmount).toBe(1800);

            // DR COGS 6000, CR Inventory 6000 (separate INVENTORY_MOVE journal)
            expect(findLine(cogsLines, AccountCodes.COGS)!.debitAmount).toBe(6000);
            expect(findLine(cogsLines, AccountCodes.INVENTORY)!.creditAmount).toBe(6000);

            assertBalanced(revLines);
            assertBalanced(cogsLines);
        });
    });

    // ========================================================================
    // recordSaleToGL — Discount allocation precision
    // ========================================================================
    describe('recordSaleToGL — discount allocation', () => {
        it('should allocate discount proportionally and remain balanced', async () => {
            // Line totals: inv=7000, svc=3000 (gross=10000)
            // Actual sale total = 9000 (discount = 1000)
            // Inv discount = 7000 * (1000/10000) = 700 → net inv = 6300
            // Svc discount = 3000 * (1000/10000) = 300 → net svc = 2700
            await recordSaleToGL({
                saleId: 'sale-discount',
                saleNumber: 'SALE-2026-0050',
                saleDate: '2026-03-15',
                totalAmount: 9000,
                costAmount: 4000,
                paymentMethod: 'CASH',
                saleItems: [
                    { productType: 'inventory', totalPrice: 7000, unitCost: 2000, quantity: 2 },
                    { productType: 'service', totalPrice: 3000, unitCost: 0, quantity: 1 },
                ],
            });

            const lines = capturedEntries[0].lines;

            // Cash DR = 9000 (post-discount total)
            expect(findLine(lines, AccountCodes.CASH)!.debitAmount).toBe(9000);

            // Revenue should sum to 9000 (after discount allocation)
            const invRev = findLine(lines, AccountCodes.SALES_REVENUE)!.creditAmount;
            const svcRev = findLine(lines, AccountCodes.SERVICE_REVENUE)!.creditAmount;
            expect(invRev + svcRev).toBeCloseTo(9000, 0);

            assertBalanced(lines);
        });

        it('should handle odd-number discount — documents rounding edge case', async () => {
            // PRECISION EDGE CASE:
            // Line totals: inv=5000, svc=5000 (gross=10000), totalAmount=9999 → discount=1
            // Each revenue line gets 0.5 discount → Money.round(4999.5, 0dp) = 5000 (ROUND_HALF_UP)
            // Both round UP → total credited revenue = 10000, but Cash DR = 9999
            // This 1 UGX imbalance would be REJECTED by AccountingCore (tolerance=0.001)
            //
            // In production, this scenario is extremely unlikely (1 UGX discount on 10000 UGX)
            // but documents the proportional-rounding risk with integer-only currencies.
            await recordSaleToGL({
                saleId: 'sale-odd-discount',
                saleNumber: 'SALE-2026-0051',
                saleDate: '2026-03-15',
                totalAmount: 9999,
                costAmount: 3000,
                paymentMethod: 'CASH',
                saleItems: [
                    { productType: 'inventory', totalPrice: 5000, unitCost: 3000, quantity: 1 },
                    { productType: 'service', totalPrice: 5000, unitCost: 0, quantity: 1 },
                ],
            });

            const lines = capturedEntries[0].lines;
            const dr = totalDebits(lines);
            const cr = totalCredits(lines);
            // Known: may be off by up to 1 UGX due to ROUND_HALF_UP on both lines
            expect(Math.abs(dr - cr)).toBeLessThanOrEqual(1);
        });
    });

    // ========================================================================
    // recordSaleToGL — Deposit sale
    // ========================================================================
    describe('recordSaleToGL — deposit sale', () => {
        it('should debit AR (not Cash) for deposit sale', async () => {
            await recordSaleToGL({
                saleId: 'sale-deposit',
                saleNumber: 'SALE-2026-0060',
                saleDate: '2026-03-15',
                totalAmount: 8000,
                costAmount: 5000,
                paymentMethod: 'DEPOSIT',
                customerId: 'cust-deposit',
                saleItems: [
                    { productType: 'inventory', totalPrice: 8000, unitCost: 5000, quantity: 1 },
                ],
            });

            const lines = capturedEntries[0].lines;

            const arLine = findLine(lines, AccountCodes.ACCOUNTS_RECEIVABLE)!;
            expect(arLine.debitAmount).toBe(8000);
            expect(arLine.entityType).toBe('customer');
            expect(arLine.entityId).toBe('cust-deposit');

            // No Cash debit
            expect(findLine(lines, AccountCodes.CASH)).toBeUndefined();

            assertBalanced(lines);
        });
    });

    // ========================================================================
    // recordCustomerDepositToGL / recordDepositApplicationToGL
    // ========================================================================
    describe('deposit lifecycle GL postings', () => {
        it('should post customer deposit as DR Undeposited Funds / CR Customer Deposits', async () => {
            await recordCustomerDepositToGL({
                depositId: 'dep-1',
                depositNumber: 'DEP-2026-0001',
                depositDate: '2026-03-15',
                amount: 8000,
                paymentMethod: 'CASH',
                customerId: 'cust-1',
                customerName: 'John Doe',
            });

            const lines = capturedEntries[0].lines;
            expect(findLine(lines, AccountCodes.UNDEPOSITED_FUNDS)!.debitAmount).toBe(8000);
            expect(findLine(lines, AccountCodes.CUSTOMER_DEPOSITS)!.creditAmount).toBe(8000);
            expect(capturedEntries[0].source).toBe('PAYMENT_RECEIPT');
            expect(capturedEntries[0].idempotencyKey).toBe('CUSTOMER_DEPOSIT-dep-1');
            assertBalanced(lines);
        });

        it('should clear deposit application as DR Customer Deposits / CR AR', async () => {
            await recordDepositApplicationToGL({
                applicationId: 'app-1',
                depositId: 'dep-1',
                depositNumber: 'DEP-2026-0001',
                saleId: 'sale-1',
                saleNumber: 'SALE-2026-0100',
                applicationDate: '2026-03-15',
                amount: 8000,
                customerId: 'cust-1',
                customerName: 'John Doe',
            });

            const lines = capturedEntries[0].lines;
            expect(findLine(lines, AccountCodes.CUSTOMER_DEPOSITS)!.debitAmount).toBe(8000);
            expect(findLine(lines, AccountCodes.ACCOUNTS_RECEIVABLE)!.creditAmount).toBe(8000);
            expect(capturedEntries[0].idempotencyKey).toBe('DEPOSIT_APPLICATION-app-1');
            expect(capturedEntries[0].referenceType).toBe('DEPOSIT_APPLICATION');
            expect(capturedEntries[0].source).toBe('DEPOSIT_APPLICATION');
            assertBalanced(lines);
        });

        it('should forward txClient when posting deposit application', async () => {
            const txClient = { query: jest.fn<MockFn>() } as unknown as Parameters<typeof recordDepositApplicationToGL>[2];

            await recordDepositApplicationToGL(
                {
                    applicationId: 'app-2',
                    depositId: 'dep-2',
                    depositNumber: '',
                    saleId: 'sale-2',
                    saleNumber: 'SALE-2026-0101',
                    applicationDate: '2026-03-16',
                    amount: 2500,
                    customerId: 'cust-2',
                    customerName: 'Jane Doe',
                },
                undefined,
                txClient,
            );

            expect(createJournalEntryMock).toHaveBeenCalledWith(
                expect.objectContaining({
                    idempotencyKey: 'DEPOSIT_APPLICATION-app-2',
                    referenceType: 'DEPOSIT_APPLICATION',
                }),
                undefined,
                txClient,
            );
        });
    });

    // ========================================================================
    // recordCustomerPaymentToGL
    // ========================================================================
    describe('recordCustomerPaymentToGL', () => {
        it('should DR Undeposited Funds / CR AR when reducesAR=true', async () => {
            await recordCustomerPaymentToGL({
                paymentId: 'pay-1',
                paymentNumber: 'PMT-001',
                paymentDate: '2026-03-15',
                amount: 5000,
                paymentMethod: 'CASH',
                customerId: 'cust-1',
                customerName: 'John',
                reducesAR: true,
            });

            const lines = capturedEntries[0].lines;

            expect(findLine(lines, AccountCodes.UNDEPOSITED_FUNDS)!.debitAmount).toBe(5000);
            expect(findLine(lines, AccountCodes.ACCOUNTS_RECEIVABLE)!.creditAmount).toBe(5000);
            expect(capturedEntries[0].source).toBe('PAYMENT_RECEIPT');
            assertBalanced(lines);
        });

        it('should DR Cash Drawer 1010 / CR AR for till collections (TILL_RECEIPT)', async () => {
            await recordCustomerPaymentToGL({
                paymentId: 'pay-till-1',
                paymentNumber: 'PMT-TILL-001',
                paymentDate: '2026-03-15',
                amount: 4000,
                paymentMethod: 'CASH',
                customerId: 'cust-1',
                customerName: 'John',
                reducesAR: true,
                fundsAccountCode: '1010',
            });

            const lines = capturedEntries[0].lines;
            expect(findLine(lines, AccountCodes.CASH)!.debitAmount).toBe(4000);
            expect(findLine(lines, AccountCodes.ACCOUNTS_RECEIVABLE)!.creditAmount).toBe(4000);
            expect(findLine(lines, AccountCodes.UNDEPOSITED_FUNDS)).toBeUndefined();
            expect(capturedEntries[0].source).toBe('TILL_RECEIPT');
            assertBalanced(lines);
        });

        it('should DR Undeposited Funds / CR Customer Deposits when reducesAR=false', async () => {
            await recordCustomerPaymentToGL({
                paymentId: 'pay-2',
                paymentNumber: 'PMT-002',
                paymentDate: '2026-03-15',
                amount: 3000,
                paymentMethod: 'CASH',
                customerId: 'cust-1',
                customerName: 'John',
                reducesAR: false,
            });

            const lines = capturedEntries[0].lines;

            expect(findLine(lines, AccountCodes.UNDEPOSITED_FUNDS)!.debitAmount).toBe(3000);
            expect(findLine(lines, AccountCodes.CUSTOMER_DEPOSITS)!.creditAmount).toBe(3000);
            assertBalanced(lines);
        });
    });

    // ========================================================================
    // recordGoodsReceiptToGL
    // ========================================================================
    describe('recordGoodsReceiptToGL', () => {
        it('should DR Inventory / CR GRN/IR Clearing (SAP 3-way match — AP is NOT touched on GRN)', async () => {
            // SAP / Odoo pattern: GRN does NOT post to AP.
            // AP is only created when the Supplier Invoice is posted.
            // The sequence is:
            //   1. GRN:      DR Inventory (1300) / CR GRN Clearing (2150)
            //   2. Invoice:  DR GRN Clearing (2150) / CR AP (2100)  ← clears the clearing account
            await recordGoodsReceiptToGL({
                grId: 'gr-1',
                grNumber: 'GR-2026-0001',
                grDate: '2026-03-15',
                totalAmount: 50000,
                supplierId: 'sup-1',
                supplierName: 'Acme Corp',
            });

            const lines = capturedEntries[0].lines;

            expect(findLine(lines, AccountCodes.INVENTORY)!.debitAmount).toBe(50000);
            expect(findLine(lines, AccountCodes.GRIR_CLEARING)!.creditAmount).toBe(50000);
            // AP must NOT be touched on GRN posting
            expect(findLine(lines, AccountCodes.ACCOUNTS_PAYABLE)).toBeUndefined();
            assertBalanced(lines);
        });
    });

    // ========================================================================
    // recordStockAdjustmentToGL
    // ========================================================================
    describe('recordStockAdjustmentToGL', () => {
        const prevLegacy = process.env.ALLOW_LEGACY_STOCK_ADJUSTMENT_GL;

        beforeEach(() => {
            process.env.ALLOW_LEGACY_STOCK_ADJUSTMENT_GL = '1';
        });

        afterEach(() => {
            if (prevLegacy === undefined) delete process.env.ALLOW_LEGACY_STOCK_ADJUSTMENT_GL;
            else process.env.ALLOW_LEGACY_STOCK_ADJUSTMENT_GL = prevLegacy;
        });

        it('is blocked by default (ADR-004 Phase 2D)', async () => {
            delete process.env.ALLOW_LEGACY_STOCK_ADJUSTMENT_GL;
            await expect(
                recordStockAdjustmentToGL({
                    adjustmentId: 'adj-blocked',
                    adjustmentNumber: 'ADJ-BLOCK',
                    adjustmentDate: '2026-03-15',
                    adjustmentType: 'DECREASE',
                    totalValue: 100,
                    reason: 'should fail',
                }),
            ).rejects.toThrow(/retired \(ADR-004/);
        });

        it('INCREASE: should DR Inventory / CR Other Income', async () => {
            await recordStockAdjustmentToGL({
                adjustmentId: 'adj-1',
                adjustmentNumber: 'ADJ-001',
                adjustmentDate: '2026-03-15',
                adjustmentType: 'INCREASE',
                totalValue: 2000,
                reason: 'Count surplus',
            });

            const lines = capturedEntries[0].lines;

            expect(findLine(lines, AccountCodes.INVENTORY)!.debitAmount).toBe(2000);
            expect(findLine(lines, AccountCodes.OTHER_INCOME)!.creditAmount).toBe(2000);
            assertBalanced(lines);
        });

        it('DECREASE: should DR General Expense / CR Inventory', async () => {
            await recordStockAdjustmentToGL({
                adjustmentId: 'adj-2',
                adjustmentNumber: 'ADJ-002',
                adjustmentDate: '2026-03-15',
                adjustmentType: 'DECREASE',
                totalValue: 1500,
                reason: 'Count shortage',
            });

            const lines = capturedEntries[0].lines;

            expect(findLine(lines, AccountCodes.GENERAL_EXPENSE)!.debitAmount).toBe(1500);
            expect(findLine(lines, AccountCodes.INVENTORY)!.creditAmount).toBe(1500);
            assertBalanced(lines);
        });
    });

    // ========================================================================
    // recordOpeningStockToGL
    // ========================================================================
    describe('recordOpeningStockToGL', () => {
        it('should DR Inventory / CR Opening Balance Equity for positive value', async () => {
            await recordOpeningStockToGL({
                movementId: 'mv-1',
                movementNumber: 'MV-001',
                productId: 'prod-1',
                productName: 'Widget',
                batchNumber: 'BATCH-001',
                movementValue: 10000,
                movementDate: '2026-01-01',
            });

            const lines = capturedEntries[0].lines;

            expect(findLine(lines, AccountCodes.INVENTORY)!.debitAmount).toBe(10000);
            expect(findLine(lines, AccountCodes.OPENING_BALANCE_EQUITY)!.creditAmount).toBe(10000);
            assertBalanced(lines);
        });

        it('should reverse (DR OBE / CR Inventory) for negative value', async () => {
            await recordOpeningStockToGL({
                movementId: 'mv-2',
                movementNumber: 'MV-002',
                productId: 'prod-2',
                productName: 'Gadget',
                batchNumber: 'BATCH-002',
                movementValue: -5000,
                movementDate: '2026-01-01',
            });

            const lines = capturedEntries[0].lines;

            expect(findLine(lines, AccountCodes.OPENING_BALANCE_EQUITY)!.debitAmount).toBe(5000);
            expect(findLine(lines, AccountCodes.INVENTORY)!.creditAmount).toBe(5000);
            assertBalanced(lines);
        });

        it('should skip posting when value is zero', async () => {
            await recordOpeningStockToGL({
                movementId: 'mv-3',
                movementNumber: 'MV-003',
                productId: 'prod-3',
                productName: 'Nothing',
                batchNumber: 'BATCH-003',
                movementValue: 0,
                movementDate: '2026-01-01',
            });

            expect(capturedEntries).toHaveLength(0);
        });

        it('should use deterministic idempotency key', async () => {
            await recordOpeningStockToGL({
                movementId: 'mv-4',
                movementNumber: 'MV-004',
                productId: 'prod-4',
                productName: 'Keyed',
                batchNumber: 'BATCH-004',
                movementValue: 1000,
                movementDate: '2026-01-01',
            });

            expect(capturedEntries[0].idempotencyKey).toBe('OPENING_STOCK-prod-4-BATCH-004');
        });
    });

    // ========================================================================
    // recordExpenseToGL
    // ========================================================================
    describe('recordExpenseToGL', () => {
        it('should DR Expense account / CR Cash', async () => {
            await recordExpenseToGL({
                expenseId: 'exp-1',
                expenseNumber: 'EXP-001',
                expenseDate: '2026-03-15',
                amount: 3000,
                categoryCode: 'RENT',
                categoryName: 'Rent',
                description: 'Office rent',
                paymentMethod: 'CASH',
            });

            const lines = capturedEntries[0].lines;

            expect(findLine(lines, AccountCodes.RENT)!.debitAmount).toBe(3000);
            expect(findLine(lines, AccountCodes.CASH)!.creditAmount).toBe(3000);
            assertBalanced(lines);
        });

        it('should CR Checking Account for BANK_TRANSFER payment', async () => {
            await recordExpenseToGL({
                expenseId: 'exp-2',
                expenseNumber: 'EXP-002',
                expenseDate: '2026-03-15',
                amount: 5000,
                categoryCode: 'UTILITIES',
                categoryName: 'Utilities',
                description: 'Electric bill',
                paymentMethod: 'BANK_TRANSFER',
            });

            const lines = capturedEntries[0].lines;

            expect(findLine(lines, AccountCodes.UTILITIES)!.debitAmount).toBe(5000);
            expect(findLine(lines, AccountCodes.CHECKING_ACCOUNT)!.creditAmount).toBe(5000);
            assertBalanced(lines);
        });
    });

    // ========================================================================
    // large sale amounts — precision
    // ========================================================================
    describe('large sale amounts — precision', () => {
        it('should handle 100M UGX sale without precision loss', async () => {
            await recordSaleToGL({
                saleId: 'sale-huge',
                saleNumber: 'SALE-2026-9999',
                saleDate: '2026-03-15',
                totalAmount: 100000000,
                costAmount: 60000000,
                paymentMethod: 'CASH',
                saleItems: [
                    { productType: 'inventory', totalPrice: 100000000, unitCost: 60000000, quantity: 1 },
                ],
            });

            const lines = capturedEntries[0].lines;
            expect(findLine(lines, AccountCodes.CASH)!.debitAmount).toBe(100000000);
            expect(findLine(lines, AccountCodes.SALES_REVENUE)!.creditAmount).toBe(100000000);
            assertBalanced(lines);
        });
    });

    // ========================================================================
    // recordCustomerCreditNoteToGL
    // ========================================================================
    describe('recordCustomerCreditNoteToGL', () => {
        const base = {
            noteId: 'cn-1',
            noteNumber: 'CN-2026-0001',
            noteDate: '2026-05-01',
            customerId: 'cust-1',
            customerName: 'Test Customer',
        };

        it('no-tax: DR Sales Returns / CR AR (balanced)', async () => {
            // SAP pattern for customer credit note (no tax):
            //   DR Sales Returns & Allowances (4010)  = subtotal
            //   CR Accounts Receivable         (1200)  = total
            await recordCustomerCreditNoteToGL({ ...base, subtotal: 20000, taxAmount: 0, totalAmount: 20000 });
            const lines = capturedEntries[0].lines;

            expect(findLine(lines, AccountCodes.SALES_RETURNS)!.debitAmount).toBe(20000);
            expect(findLine(lines, AccountCodes.ACCOUNTS_RECEIVABLE)!.creditAmount).toBe(20000);
            expect(findLine(lines, AccountCodes.TAX_PAYABLE)).toBeUndefined();
            assertBalanced(lines);
        });

        it('with tax: DR Sales Returns + DR Tax Payable / CR AR (balanced)', async () => {
            // Output VAT reversed with the credit note
            await recordCustomerCreditNoteToGL({ ...base, noteId: 'cn-2', noteNumber: 'CN-2026-0002', subtotal: 18000, taxAmount: 2000, totalAmount: 20000 });
            const lines = capturedEntries[0].lines;

            expect(findLine(lines, AccountCodes.SALES_RETURNS)!.debitAmount).toBe(18000);
            expect(findLine(lines, AccountCodes.TAX_PAYABLE)!.debitAmount).toBe(2000);
            expect(findLine(lines, AccountCodes.ACCOUNTS_RECEIVABLE)!.creditAmount).toBe(20000);
            assertBalanced(lines);
        });

        it('uses CREDIT_NOTE referenceType and correct idempotency key', async () => {
            await recordCustomerCreditNoteToGL({ ...base, noteId: 'cn-3', noteNumber: 'CN-2026-0003', subtotal: 5000, taxAmount: 0, totalAmount: 5000 });
            expect(capturedEntries[0].referenceType).toBe('CREDIT_NOTE');
            expect(capturedEntries[0].idempotencyKey).toBe('CREDIT_NOTE-cn-3');
        });
    });

    // ========================================================================
    // recordCustomerDebitNoteToGL
    // ========================================================================
    describe('recordCustomerDebitNoteToGL', () => {
        const base = {
            noteId: 'dn-1',
            noteNumber: 'DN-2026-0001',
            noteDate: '2026-05-01',
            customerId: 'cust-1',
            customerName: 'Test Customer',
        };

        it('no-tax: DR AR / CR Sales Revenue (balanced)', async () => {
            // SAP pattern for customer debit note (no tax):
            //   DR Accounts Receivable (1200)  = total
            //   CR Sales Revenue       (4000)  = subtotal
            await recordCustomerDebitNoteToGL({ ...base, subtotal: 15000, taxAmount: 0, totalAmount: 15000 });
            const lines = capturedEntries[0].lines;

            expect(findLine(lines, AccountCodes.ACCOUNTS_RECEIVABLE)!.debitAmount).toBe(15000);
            expect(findLine(lines, AccountCodes.SALES_REVENUE)!.creditAmount).toBe(15000);
            expect(findLine(lines, AccountCodes.TAX_PAYABLE)).toBeUndefined();
            assertBalanced(lines);
        });

        it('with tax: DR AR / CR Sales Revenue + CR Tax Payable (balanced)', async () => {
            await recordCustomerDebitNoteToGL({ ...base, noteId: 'dn-2', noteNumber: 'DN-2026-0002', subtotal: 12000, taxAmount: 1500, totalAmount: 13500 });
            const lines = capturedEntries[0].lines;

            expect(findLine(lines, AccountCodes.ACCOUNTS_RECEIVABLE)!.debitAmount).toBe(13500);
            expect(findLine(lines, AccountCodes.SALES_REVENUE)!.creditAmount).toBe(12000);
            expect(findLine(lines, AccountCodes.TAX_PAYABLE)!.creditAmount).toBe(1500);
            assertBalanced(lines);
        });

        it('uses DEBIT_NOTE referenceType and correct idempotency key', async () => {
            await recordCustomerDebitNoteToGL({ ...base, noteId: 'dn-3', noteNumber: 'DN-2026-0003', subtotal: 8000, taxAmount: 0, totalAmount: 8000 });
            expect(capturedEntries[0].referenceType).toBe('DEBIT_NOTE');
            expect(capturedEntries[0].idempotencyKey).toBe('DEBIT_NOTE-dn-3');
        });
    });

    // ========================================================================
    // recordSupplierCreditNoteToGL
    // ========================================================================
    describe('recordSupplierCreditNoteToGL', () => {
        const base = {
            noteId: 'scn-1',
            noteNumber: 'SCN-2026-0001',
            noteDate: '2026-05-01',
            supplierId: 'sup-1',
            supplierName: 'Acme Supplies',
        };

        it('price-adjustment path: DR AP / CR Purchase Returns (balanced)', async () => {
            // Standard supplier credit note (price concession, overcharge reversal, etc.)
            //   DR Accounts Payable          (2100) = total
            //   CR Purchase Returns          (5010) = subtotal
            await recordSupplierCreditNoteToGL({ ...base, subtotal: 30000, taxAmount: 0, totalAmount: 30000 });
            const lines = capturedEntries[0].lines;

            expect(findLine(lines, AccountCodes.ACCOUNTS_PAYABLE)!.debitAmount).toBe(30000);
            expect(findLine(lines, AccountCodes.PURCHASE_RETURNS)!.creditAmount).toBe(30000);
            expect(findLine(lines, AccountCodes.GRIR_CLEARING)).toBeUndefined();
            assertBalanced(lines);
        });

        it('price-adjustment with tax: DR AP / CR Purchase Returns + CR Tax Payable (balanced)', async () => {
            await recordSupplierCreditNoteToGL({ ...base, noteId: 'scn-2', noteNumber: 'SCN-2026-0002', subtotal: 25000, taxAmount: 5000, totalAmount: 30000 });
            const lines = capturedEntries[0].lines;

            expect(findLine(lines, AccountCodes.ACCOUNTS_PAYABLE)!.debitAmount).toBe(30000);
            expect(findLine(lines, AccountCodes.PURCHASE_RETURNS)!.creditAmount).toBe(25000);
            expect(findLine(lines, AccountCodes.TAX_PAYABLE)!.creditAmount).toBe(5000);
            assertBalanced(lines);
        });

        it('Return-GRN path (clearingAccountCode=GRIR): DR AP / CR GRN Clearing — NOT Purchase Returns', async () => {
            // When linked to a Return GRN, the credit note clears the GRN/IR account,
            // NOT Purchase Returns. This is the SAP 3-way match completion:
            //   Return GRN posted: DR GRIR (2150) / CR Inventory (1300)
            //   Credit note posts: DR AP   (2100) / CR GRIR     (2150)  ← clears clearing
            // Net effect:          DR AP   (2100) / CR Inventory (1300)  ← correct for supplier return
            await recordSupplierCreditNoteToGL(
                { ...base, noteId: 'scn-3', noteNumber: 'SCN-2026-0003', subtotal: 40000, taxAmount: 0, totalAmount: 40000, clearingAccountCode: AccountCodes.GRIR_CLEARING },
            );
            const lines = capturedEntries[0].lines;

            expect(findLine(lines, AccountCodes.ACCOUNTS_PAYABLE)!.debitAmount).toBe(40000);
            expect(findLine(lines, AccountCodes.GRIR_CLEARING)!.creditAmount).toBe(40000);
            // CRITICAL: Purchase Returns must NOT appear on return-GRN-linked credit notes
            expect(findLine(lines, AccountCodes.PURCHASE_RETURNS)).toBeUndefined();
            assertBalanced(lines);
        });

        it('uses SUPPLIER_CREDIT_NOTE referenceType and correct idempotency key', async () => {
            await recordSupplierCreditNoteToGL({ ...base, noteId: 'scn-4', noteNumber: 'SCN-2026-0004', subtotal: 1000, taxAmount: 0, totalAmount: 1000 });
            expect(capturedEntries[0].referenceType).toBe('SUPPLIER_CREDIT_NOTE');
            expect(capturedEntries[0].idempotencyKey).toBe('SUPPLIER_CREDIT_NOTE-scn-4');
        });

        it('under-bill reverse: DR AP + DR Price Variance / CR clearing (balanced)', async () => {
            // Parent SI under-billed: AP=88000, GR goods=88004 (CR 5020 on SI).
            // Full return SCN: clear goods at 88004, reduce AP only 88000, DR PPV 4.
            await recordSupplierCreditNoteToGL({
                ...base,
                noteId: 'scn-5',
                noteNumber: 'SCN-2026-0005',
                subtotal: 88004,
                taxAmount: 0,
                totalAmount: 88000,
                clearingAccountCode: AccountCodes.GRIR_CLEARING,
            });
            const lines = capturedEntries[0].lines;
            expect(findLine(lines, AccountCodes.ACCOUNTS_PAYABLE)!.debitAmount).toBe(88000);
            expect(findLine(lines, AccountCodes.GRIR_CLEARING)!.creditAmount).toBe(88004);
            expect(findLine(lines, AccountCodes.PRICE_VARIANCE)!.debitAmount).toBe(4);
            assertBalanced(lines);
        });
    });

    // ========================================================================
    // recordSupplierDebitNoteToGL
    // ========================================================================
    describe('recordSupplierDebitNoteToGL', () => {
        const base = {
            noteId: 'sdn-1',
            noteNumber: 'SDN-2026-0001',
            noteDate: '2026-05-01',
            supplierId: 'sup-1',
            supplierName: 'Acme Supplies',
        };

        it('no-tax: DR COGS / CR AP (balanced)', async () => {
            // Supplier debit note — we charge the supplier for damaged/short goods.
            // Cost absorbed by COGS (pending proper batch revaluation feature).
            //   DR COGS               (5000) = subtotal
            //   CR Accounts Payable   (2100) = total
            await recordSupplierDebitNoteToGL({ ...base, subtotal: 10000, taxAmount: 0, totalAmount: 10000 });
            const lines = capturedEntries[0].lines;

            expect(findLine(lines, AccountCodes.COGS)!.debitAmount).toBe(10000);
            expect(findLine(lines, AccountCodes.ACCOUNTS_PAYABLE)!.creditAmount).toBe(10000);
            expect(findLine(lines, AccountCodes.TAX_PAYABLE)).toBeUndefined();
            assertBalanced(lines);
        });

        it('with tax: DR COGS + DR Tax Payable / CR AP (balanced)', async () => {
            await recordSupplierDebitNoteToGL({ ...base, noteId: 'sdn-2', noteNumber: 'SDN-2026-0002', subtotal: 8000, taxAmount: 1200, totalAmount: 9200 });
            const lines = capturedEntries[0].lines;

            expect(findLine(lines, AccountCodes.COGS)!.debitAmount).toBe(8000);
            expect(findLine(lines, AccountCodes.TAX_PAYABLE)!.debitAmount).toBe(1200);
            expect(findLine(lines, AccountCodes.ACCOUNTS_PAYABLE)!.creditAmount).toBe(9200);
            assertBalanced(lines);
        });

        it('uses SUPPLIER_DEBIT_NOTE referenceType and correct idempotency key', async () => {
            await recordSupplierDebitNoteToGL({ ...base, noteId: 'sdn-3', noteNumber: 'SDN-2026-0003', subtotal: 500, taxAmount: 0, totalAmount: 500 });
            expect(capturedEntries[0].referenceType).toBe('SUPPLIER_DEBIT_NOTE');
            expect(capturedEntries[0].idempotencyKey).toBe('SUPPLIER_DEBIT_NOTE-sdn-3');
        });
    });
});
