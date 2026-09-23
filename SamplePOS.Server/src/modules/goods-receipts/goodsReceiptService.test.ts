/**
 * goodsReceiptService unit tests
 * Tests GR retrieval and listing logic.
 */
import { jest } from '@jest/globals';
import type { Pool } from 'pg';

/** Flexible mock fn type — avoids `any` while allowing mockResolvedValue/mockReturnValue */
type MockFn = (...args: unknown[]) => Promise<unknown>;

const mockGRRepo = {
    createGR: jest.fn<MockFn>(),
    createGRItem: jest.fn<MockFn>(),
    addGRItems: jest.fn<MockFn>().mockResolvedValue([]),
    getGRById: jest.fn<MockFn>(),
    listGRs: jest.fn<MockFn>(),
    updateGRStatus: jest.fn<MockFn>(),
    updateGRItem: jest.fn<MockFn>(),
    getGRItemWithParent: jest.fn<MockFn>(),
    finalizeGR: jest.fn<MockFn>(),
    cancelGR: jest.fn<MockFn>(),
};

const mockCreateManualPO = jest.fn<MockFn>();
const mockResolveCanonicalProductUom = jest.fn<MockFn>();

jest.unstable_mockModule('./goodsReceiptRepository.js', () => ({
    goodsReceiptRepository: mockGRRepo,
    default: mockGRRepo,
}));

jest.unstable_mockModule('../purchase-orders/purchaseOrderRepository.js', () => ({
    purchaseOrderRepository: {
        getPOById: jest.fn<MockFn>(),
        updatePOStatus: jest.fn<MockFn>(),
        createManualPO: mockCreateManualPO,
    },
}));

jest.unstable_mockModule('../inventory-lot/lotService.js', () => ({
    lotService: {
        receiveLot: jest.fn<MockFn>().mockResolvedValue({ id: 'batch1', lotNumber: 'BATCH-1', remainingQuantity: 10, costPrice: 5 }),
        receiveOpeningLot: jest.fn<MockFn>().mockResolvedValue({
            lot: { id: 'batch1', lotNumber: 'BATCH-1', remainingQuantity: 10, costPrice: 5 },
            skipped: false,
        }),
    },
    receiveOpeningLot: jest.fn<MockFn>().mockResolvedValue({
        lot: { id: 'batch1', lotNumber: 'BATCH-1', remainingQuantity: 10, costPrice: 5 },
        skipped: false,
    }),
}));

jest.unstable_mockModule('../inventory/inventoryRepository.js', () => ({
    inventoryRepository: {
        updateProductInventory: jest.fn<MockFn>().mockResolvedValue(undefined),
    },
}));

jest.unstable_mockModule('../supplier-payments/supplierPaymentRepository.js', () => ({
    createSupplierLiability: jest.fn<MockFn>().mockResolvedValue(undefined),
    applyInvoiceLedgerOutstanding: jest.fn<MockFn>().mockResolvedValue({ changed: false, before: 0, after: 0 }),
    linkInvoiceToGRNs: jest.fn<MockFn>().mockResolvedValue(undefined),
}));

jest.unstable_mockModule('../../services/costLayerService.js', () => ({
    addCostLayer: jest.fn<MockFn>().mockResolvedValue(undefined),
}));

jest.unstable_mockModule('../../services/pricingService.js', () => ({
    updateProductCostPrice: jest.fn<MockFn>().mockResolvedValue(undefined),
    checkCostPriceChange: jest.fn<MockFn>().mockResolvedValue(null),
}));

jest.unstable_mockModule('../../services/glEntryService.js', () => ({
    createGoodsReceiptGLEntries: jest.fn<MockFn>().mockResolvedValue(undefined),
    recordGoodsReceiptToGL: jest.fn<MockFn>().mockResolvedValue(undefined),
    recordCustomerCreditNoteToGL: jest.fn<MockFn>().mockResolvedValue(undefined),
    AccountCodes: {
        INVENTORY: '1300',
        GRIR_CLEARING: '2150',
    },
}));

jest.unstable_mockModule('../return-grn/returnGrnService.js', () => ({
    returnGrnService: {
        reverseUninvoicedGrn: jest.fn<MockFn>().mockResolvedValue(undefined),
    },
}));

jest.unstable_mockModule('../return-grn/returnGrnRepository.js', () => ({
    returnGrnRepository: {},
}));

jest.unstable_mockModule('../corrections/correctionEligibilityService.js', () => ({
    correctionEligibilityService: {
        evaluateGoodsReceipt: jest.fn<MockFn>().mockResolvedValue({ eligible: true }),
    },
}));

jest.unstable_mockModule('../document-flow/documentFlowService.js', () => ({
    linkDocuments: jest.fn<MockFn>().mockResolvedValue(undefined),
}));

jest.unstable_mockModule('../../services/inventorySubledgerCoupling.js', () => ({
    assertInventoryCouplingUnchanged: jest.fn<MockFn>(),
    captureInventoryCoupling: jest.fn<MockFn>().mockResolvedValue({}),
    documentTotalDiffersFromSubledger: jest.fn<MockFn>().mockReturnValue(false),
    resolveGl1300FromBatchSubledgerDelta: jest.fn<MockFn>().mockReturnValue(0),
}));

jest.unstable_mockModule('../../utils/inventorySync.js', () => ({
    syncProductQuantity: jest.fn<MockFn>().mockResolvedValue(undefined),
}));

jest.unstable_mockModule('../inventory/warehouse/warehouseGrnService.js', () => ({
    warehouseGrnService: {
        postReceiptSegment: jest.fn<MockFn>().mockResolvedValue(undefined),
    },
}));

// warehouseGrnService retained for legacy imports; finalizeGR uses lotService.receiveLot

jest.unstable_mockModule('../products/uomService.js', () => ({
    resolveCanonicalProductUom: mockResolveCanonicalProductUom,
}));

jest.unstable_mockModule('../suppliers/supplierCreditGuard.js', () => ({
    assertSupplierCreditHeadroom: jest.fn<MockFn>().mockResolvedValue(undefined),
}));

jest.unstable_mockModule('../suppliers/supplierProductPriceRepository.js', () => ({
    upsertSupplierProductPrice: jest.fn<MockFn>().mockResolvedValue(undefined),
}));

jest.unstable_mockModule('../../db/batchFetch.js', () => ({
    batchFetchProducts: jest.fn<MockFn>().mockResolvedValue(new Map()),
}));

jest.unstable_mockModule('../../middleware/businessRules.js', () => {
    class BusinessRuleViolation extends Error {
        constructor(message: string) {
            super(message);
            this.name = 'BusinessRuleViolation';
        }
    }
    return {
        BusinessRuleViolation,
        InventoryBusinessRules: {
            validateGRItemCompleteness: jest.fn<MockFn>(),
            validatePositiveQuantity: jest.fn<MockFn>(),
            validateExpiryDate: jest.fn<MockFn>(),
            validateShortExpiry: jest.fn<MockFn>(),
            validateExpiryWarning: jest.fn<MockFn>(),
            validateBatchExpirySequence: jest.fn<MockFn>().mockResolvedValue(undefined),
            validateMaxStockLevel: jest.fn<MockFn>().mockResolvedValue(undefined),
        },
        PurchaseOrderBusinessRules: {
            validateUnitCost: jest.fn<MockFn>(),
            validateBatchNumber: jest.fn<MockFn>().mockResolvedValue(undefined),
            validateSupplierExists: jest.fn<MockFn>().mockResolvedValue(undefined),
        },
    };
});

jest.unstable_mockModule('../../db/unitOfWork.js', () => ({
    UnitOfWork: {
        run: jest.fn(async (_pool: unknown, fn: (client: unknown) => Promise<unknown>) => {
            const mockClient = { query: jest.fn<MockFn>().mockResolvedValue({ rows: [] }) };
            return fn(mockClient);
        }),
    },
}));

const { goodsReceiptService } = await import('./goodsReceiptService.js');

const mockPool = { query: jest.fn<MockFn>() } as unknown as Pool;

describe('goodsReceiptService', () => {
    beforeEach(() => jest.clearAllMocks());

    describe('getGRById', () => {
        it('should return GR with items', async () => {
            mockGRRepo.getGRById.mockResolvedValue({
                gr: { id: 'gr1', grNumber: 'GR-2025-0001', status: 'PENDING' },
                items: [{ id: 'gri1', productName: 'Widget', receivedQuantity: 10 }],
            });

            const result = await goodsReceiptService.getGRById(mockPool, 'gr1');

            expect(result.gr.grNumber).toBe('GR-2025-0001');
            expect(result.items).toHaveLength(1);
        });

        it('should throw when GR not found', async () => {
            mockGRRepo.getGRById.mockResolvedValue(null);

            await expect(goodsReceiptService.getGRById(mockPool, 'ghost')).rejects.toThrow();
        });
    });

    describe('createGR manual PO UoM propagation', () => {
        it('passes uomId and UoM snapshot fields into createManualPO items', async () => {
            mockResolveCanonicalProductUom.mockResolvedValue({
                baseUomId: 'base-uom-1',
                conversionFactor: 12,
            });
            mockCreateManualPO.mockResolvedValue({
                po: {
                    id: 'po-manual-1',
                    poNumber: 'PO-2025-0001',
                    supplierId: 'sup-1',
                    status: 'PENDING',
                    totalAmount: 120,
                },
                items: [{ id: 'poi-1' }],
            });
            mockGRRepo.createGR.mockResolvedValue({ id: 'gr-1' });
            mockGRRepo.getGRById.mockResolvedValue({
                gr: { id: 'gr-1', grNumber: 'GR-2025-0001', status: 'DRAFT' },
                items: [],
            });

            await goodsReceiptService.createGR(mockPool, {
                supplierId: 'sup-1',
                purchaseOrderId: null,
                receiptDate: '2025-07-02',
                receivedBy: 'user-1',
                notes: null,
                items: [
                    {
                        productId: 'prod-1',
                        productName: 'Widget',
                        orderedQuantity: 2,
                        receivedQuantity: 2,
                        unitCost: 50,
                        uomId: 'uom-box',
                    },
                ],
            });

            expect(mockCreateManualPO).toHaveBeenCalledTimes(1);
            const poPayload = mockCreateManualPO.mock.calls[0][1] as {
                items: Array<{
                    uomId: string | null;
                    baseUomId: string | null;
                    conversionFactor: number;
                    baseQty: number;
                }>;
            };
            expect(poPayload.items[0].uomId).toBe('uom-box');
            expect(poPayload.items[0].baseUomId).toBe('base-uom-1');
            expect(poPayload.items[0].conversionFactor).toBe(12);
            expect(poPayload.items[0].baseQty).toBe(24);
        });
    });

    describe('batchUpdateGRItems UoM persistence', () => {
        it('recomputes UoM snapshot fields when a draft GR line UoM changes', async () => {
            mockGRRepo.getGRById.mockResolvedValue({
                gr: { id: 'gr-1', status: 'DRAFT', purchaseOrderId: null },
                items: [
                    {
                        id: 'gri-1',
                        productId: 'prod-1',
                        receivedQuantity: 2,
                        unitCost: 50,
                        expiryDate: null,
                        batchNumber: null,
                        uomId: 'uom-old',
                    },
                ],
            });
            mockResolveCanonicalProductUom.mockResolvedValue({
                baseUomId: 'base-uom-1',
                conversionFactor: 12,
            });
            mockGRRepo.updateGRItem.mockResolvedValue({
                id: 'gri-1',
                uomId: 'uom-box',
                baseQty: 24,
                baseUomId: 'base-uom-1',
                conversionFactor: 12,
            });

            await goodsReceiptService.batchUpdateGRItems(mockPool, 'gr-1', [
                {
                    itemId: 'gri-1',
                    uomId: 'uom-box',
                    receivedQuantity: 2,
                },
            ]);

            expect(mockGRRepo.updateGRItem).toHaveBeenCalledWith(
                expect.anything(),
                'gri-1',
                expect.objectContaining({
                    uomId: 'uom-box',
                    baseQty: 24,
                    baseUomId: 'base-uom-1',
                    conversionFactor: 12,
                }),
            );
        });
    });

    describe('cancelGR', () => {
        it('cancels a draft goods receipt including PO-originated drafts', async () => {
            mockGRRepo.getGRById.mockResolvedValue({
                gr: { id: 'gr-draft-1', status: 'DRAFT', purchaseOrderId: 'po-1' },
                items: [],
            });
            mockGRRepo.cancelGR.mockResolvedValue({
                id: 'gr-draft-1',
                status: 'CANCELLED',
                purchaseOrderId: 'po-1',
            });

            const result = await goodsReceiptService.cancelGR(mockPool, 'gr-draft-1');

            expect(mockGRRepo.cancelGR).toHaveBeenCalled();
            expect(result.status).toBe('CANCELLED');
        });

        it('rejects cancel when goods receipt is not draft', async () => {
            mockGRRepo.getGRById.mockResolvedValue({
                gr: { id: 'gr-posted-1', status: 'COMPLETED' },
                items: [],
            });

            await expect(goodsReceiptService.cancelGR(mockPool, 'gr-posted-1')).rejects.toThrow(
                'Only draft goods receipts can be cancelled',
            );
            expect(mockGRRepo.cancelGR).not.toHaveBeenCalled();
        });
    });

    describe('listGRs', () => {
        it('should return paginated goods receipts', async () => {
            mockGRRepo.listGRs.mockResolvedValue({
                grs: [{ id: 'gr1', grNumber: 'GR-2025-0001' }],
                total: 1,
            });

            const result = await goodsReceiptService.listGRs(mockPool, 1, 20);
            expect(result.grs).toHaveLength(1);
            expect(result.total).toBe(1);
        });
    });
});
