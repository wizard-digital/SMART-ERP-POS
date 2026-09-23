import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { PoolClient } from 'pg';

type MockFn = jest.Mock<(...args: unknown[]) => unknown>;

const mockUnitOfWork = {
  runOrJoin: jest.fn<MockFn>(),
  isPool: jest.fn<MockFn>(),
};

const mockMultistore = {
  isMultistoreEnabled: jest.fn<MockFn>(),
};

const mockStoreRepo = {
  getById: jest.fn<MockFn>(),
  getDefaultReceivingStore: jest.fn<MockFn>(),
  getActivePosSellingStore: jest.fn<MockFn>(),
  getStoreByType: jest.fn<MockFn>(),
  upsertByCode: jest.fn<MockFn>(),
};

const mockLotServiceModule = {
  ensureProjectionFromMaster: jest.fn<MockFn>(),
  lotService: {
    receiveLot: jest.fn<MockFn>(),
  },
};

const mockProductLotRepository = {
  getById: jest.fn<MockFn>(),
};

const mockWarehouseInventoryRepository = {
  adjustSellableQuantity: jest.fn<MockFn>(),
  moveLotQuantityBetweenStores: jest.fn<MockFn>(),
};

const mockCoupling = {
  alignBatchSubledgerToStoreBalances: jest.fn<MockFn>(),
  assertWarehouseLayerConsistent: jest.fn<MockFn>(),
};

const mockRecordMovement = jest.fn<MockFn>();
const mockResolveBatchUnitCost = { pool: {} };
const mockProcessMovement = jest
  .fn<MockFn>()
  .mockResolvedValue({ movementId: 'm1', movementNumber: 'MOV-1' });
const mockHandlerCtor = jest.fn(() => ({
  processMovement: mockProcessMovement,
}));

jest.unstable_mockModule('../../../db/unitOfWork.js', () => ({
  UnitOfWork: mockUnitOfWork,
}));
jest.unstable_mockModule('./multistoreSettings.js', () => mockMultistore);
jest.unstable_mockModule('./storeLocationRepository.js', () => ({
  storeLocationRepository: mockStoreRepo,
}));
jest.unstable_mockModule('../../inventory-lot/lotService.js', () => mockLotServiceModule);
jest.unstable_mockModule('./productLotRepository.js', () => ({
  productLotRepository: mockProductLotRepository,
}));
jest.unstable_mockModule('./warehouseInventoryRepository.js', () => ({
  warehouseInventoryRepository: mockWarehouseInventoryRepository,
}));
jest.unstable_mockModule('../../../db/pool.js', () => mockResolveBatchUnitCost);
jest.unstable_mockModule('../../../services/warehouseInventoryCoupling.js', () => mockCoupling);
jest.unstable_mockModule('../../stock-movements/stockMovementRepository.js', () => ({
  recordMovement: mockRecordMovement,
}));
jest.unstable_mockModule('../stockMovementHandler.js', () => ({
  StockMovementHandler: mockHandlerCtor,
}));

const { warehouseAdjustmentService } = await import('./warehouseAdjustmentService.js');

function makeClient(): PoolClient {
  let queryCount = 0;
  return {
    query: jest.fn(async (sql: string) => {
      queryCount += 1;

      if (sql.includes('INSERT INTO inventory_adjustment_documents')) {
        return { rows: [{ id: 'doc-1' }] };
      }
      if (sql.includes(`SELECT nextval('adj_doc_seq')`)) {
        return { rows: [{ seq: 1 }] };
      }
      if (sql.includes('FROM inventory_balances ib')) {
        return { rows: [] };
      }
      if (sql.includes('FROM inventory_batches') && sql.includes('WHERE product_id = $1 AND status = \'ACTIVE\'')) {
        return { rows: [] };
      }
      if (sql.includes('SELECT cost_price FROM product_valuation')) {
        return { rows: [{ cost_price: '12.50' }] };
      }
      return { rows: [] };
    }),
  } as unknown as PoolClient;
}

describe('warehouseAdjustmentService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMultistore.isMultistoreEnabled.mockResolvedValue(true);
    mockUnitOfWork.runOrJoin.mockImplementation(async (_conn, fn) => fn(makeClient()));
    mockUnitOfWork.isPool.mockReturnValue(false);
    mockStoreRepo.getById.mockResolvedValue({ id: 'store-1', code: 'MAIN', isActive: true });
    mockStoreRepo.getActivePosSellingStore.mockResolvedValue({ id: 'sell-1', code: 'SELLING' });
    mockStoreRepo.getDefaultReceivingStore.mockResolvedValue({ id: 'store-1' });
    mockCoupling.alignBatchSubledgerToStoreBalances.mockResolvedValue(undefined);
    mockProductLotRepository.getById.mockResolvedValue({
      id: 'lot-1',
      productId: 'prod-1',
      inventoryBatchId: 'batch-new',
    });
    mockLotServiceModule.lotService.receiveLot.mockResolvedValue({ id: 'batch-new' });
    mockLotServiceModule.ensureProjectionFromMaster.mockResolvedValue('lot-1');
    mockWarehouseInventoryRepository.adjustSellableQuantity.mockResolvedValue(undefined);
  });

  it('creates a lot master/projection for IN adjustment when no batch exists', async () => {
    const result = await warehouseAdjustmentService.adjustAtStore({} as never, {
      storeLocationId: 'store-1',
      productId: 'prod-1',
      quantity: 5,
      direction: 'IN',
      reason: 'PHYSICAL_COUNT',
      notes: 'count correction',
      userId: 'user-1',
    });

    expect(mockLotServiceModule.lotService.receiveLot).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        productId: 'prod-1',
        quantity: 0,
        sourceType: 'ADJUSTMENT',
        targetStoreLocationId: 'store-1',
        userId: 'user-1',
      }),
    );
    expect(mockLotServiceModule.ensureProjectionFromMaster).toHaveBeenCalledWith(
      expect.anything(),
      'batch-new',
    );
    expect(mockWarehouseInventoryRepository.adjustSellableQuantity).not.toHaveBeenCalled();
    expect(mockProcessMovement).toHaveBeenCalledWith(
      expect.objectContaining({
        movementType: 'ADJUSTMENT_IN',
        targetStoreLocationId: 'store-1',
      }),
      expect.anything(),
    );
    expect(result).toMatchObject({ documentId: 'doc-1' });
  });
});
