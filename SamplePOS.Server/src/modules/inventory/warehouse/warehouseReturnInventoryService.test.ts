import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { PoolClient } from 'pg';

type MockFn = jest.Mock<(...args: unknown[]) => unknown>;

const mockMultistore = {
  isMultistoreEnabled: jest.fn<MockFn>(),
};
const mockLotService = {
  returnLot: jest.fn<MockFn>(),
};
const mockInventorySync = {
  syncProductQuantity: jest.fn<MockFn>(),
};
const mockStores = {
  storeLocationRepository: {
    getById: jest.fn<MockFn>(),
    getActivePosSellingStore: jest.fn<MockFn>(),
    getStoreByType: jest.fn<MockFn>(),
  },
};
const mockLots = {
  getProductLotIdByBatchId: jest.fn<MockFn>(),
};
const mockMovements = {
  recordMovement: jest.fn<MockFn>(),
};

jest.unstable_mockModule('./multistoreSettings.js', () => mockMultistore);
jest.unstable_mockModule('../../inventory-lot/lotService.js', () => ({
  lotService: mockLotService,
}));
jest.unstable_mockModule('../../../utils/inventorySync.js', () => mockInventorySync);
jest.unstable_mockModule('./storeLocationRepository.js', () => mockStores);
jest.unstable_mockModule('../../inventory-lot/postgresLotRepository.js', () => mockLots);
jest.unstable_mockModule('../../stock-movements/stockMovementRepository.js', () => mockMovements);

const { warehouseReturnInventoryService } = await import('./warehouseReturnInventoryService.js');

const client = {} as PoolClient;

describe('warehouseReturnInventoryService.restoreCustomerReturn', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLotService.returnLot.mockResolvedValue({ id: 'batch-1' });
    mockLots.getProductLotIdByBatchId.mockResolvedValue('lot-1');
    mockStores.storeLocationRepository.getActivePosSellingStore.mockResolvedValue({
      id: 'selling-1',
      code: 'SELLING',
      storeType: 'SELLING',
    });
    mockStores.storeLocationRepository.getById.mockResolvedValue({
      id: 'selling-1',
      code: 'SELLING',
      storeType: 'SELLING',
    });
  });

  it('returns null when multistore is off (legacy path)', async () => {
    mockMultistore.isMultistoreEnabled.mockResolvedValue(false);
    const handled = await warehouseReturnInventoryService.restoreCustomerReturn(client, {
      productId: 'p1',
      quantity: 1,
      unitCost: 10,
      referenceType: 'SALE_REFUND',
      referenceId: 'r1',
      notes: 'refund',
    });
    expect(handled).toBeNull();
    expect(mockLotService.returnLot).not.toHaveBeenCalled();
    expect(mockStores.storeLocationRepository.getStoreByType).not.toHaveBeenCalled();
  });

  it('restores to the sale line selling store, never RETURN quarantine', async () => {
    mockMultistore.isMultistoreEnabled.mockResolvedValue(true);
    const outcome = await warehouseReturnInventoryService.restoreCustomerReturn(client, {
      productId: 'p1',
      quantity: 9,
      unitCost: 12,
      batchId: 'batch-1',
      storeLocationId: 'selling-1',
      referenceType: 'SALE_REFUND',
      referenceId: 'r1',
      notes: 'Refund REF-1',
    });
    expect(outcome?.storeLocationId).toBe('selling-1');
    expect(mockLotService.returnLot).toHaveBeenCalledWith(
      client,
      expect.objectContaining({
        productId: 'p1',
        batchId: 'batch-1',
        quantity: 9,
        targetStoreLocationId: 'selling-1',
        referenceType: 'SALE_REFUND',
      }),
    );
    expect(mockStores.storeLocationRepository.getStoreByType).not.toHaveBeenCalled();
    expect(mockMovements.recordMovement).toHaveBeenCalledWith(
      client,
      expect.objectContaining({
        notes: expect.stringContaining('[store:SELLING]'),
      }),
    );
  });

  it('falls back to POS selling store when the line store is RETURN quarantine', async () => {
    mockMultistore.isMultistoreEnabled.mockResolvedValue(true);
    mockStores.storeLocationRepository.getById.mockResolvedValue({
      id: 'return-1',
      code: 'RETURN',
      storeType: 'RETURN',
    });
    await warehouseReturnInventoryService.restoreCustomerReturn(client, {
      productId: 'p1',
      quantity: 1,
      unitCost: 10,
      storeLocationId: 'return-1',
      referenceType: 'SALE_REFUND',
      referenceId: 'r1',
      notes: 'refund',
    });
    expect(mockStores.storeLocationRepository.getActivePosSellingStore).toHaveBeenCalled();
    expect(mockLotService.returnLot).toHaveBeenCalledWith(
      client,
      expect.objectContaining({ targetStoreLocationId: 'selling-1' }),
    );
  });

  it('falls back to active POS selling store when the sale line has no store trace', async () => {
    mockMultistore.isMultistoreEnabled.mockResolvedValue(true);
    mockStores.storeLocationRepository.getById.mockResolvedValue(null);
    await warehouseReturnInventoryService.restoreCustomerReturn(client, {
      productId: 'p1',
      quantity: 1,
      unitCost: 10,
      referenceType: 'SALE_REFUND',
      referenceId: 'r1',
      notes: 'refund',
    });
    expect(mockStores.storeLocationRepository.getActivePosSellingStore).toHaveBeenCalled();
    expect(mockLotService.returnLot).toHaveBeenCalledWith(
      client,
      expect.objectContaining({ targetStoreLocationId: 'selling-1' }),
    );
  });
});
