/**
 * Store issue stock guard — same FEFO selector as consumeLot.
 * Proves the Abchlor 5/5 shortfall is rejected before consume with store + available qty.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';

type MockFn = (...args: unknown[]) => Promise<unknown>;

const loadStoreSelectableLots = jest.fn<MockFn>();
const loadGlobalSelectableLots = jest.fn<MockFn>();
const getById = jest.fn<MockFn>();

jest.unstable_mockModule('../inventory-lot/postgresLotSelector.js', () => ({
  loadStoreSelectableLots,
  loadGlobalSelectableLots,
}));

jest.unstable_mockModule('../inventory/warehouse/storeLocationRepository.js', () => ({
  storeLocationRepository: { getById },
}));

const { assertStoreIssueStock, wrapConsumeStockError, previewStoreIssueAvailability } =
  await import('./storeIssueStock.js');

const conn = {} as never;
const MAIN = '11111111-1111-1111-1111-111111111111';

describe('store issue stock guard', () => {
  beforeEach(() => {
    loadStoreSelectableLots.mockReset();
    loadGlobalSelectableLots.mockReset();
    getById.mockReset();
    getById.mockResolvedValue({ name: 'MAIN', code: 'MAIN' });
  });

  it('rejects issue when the consume store has zero FEFO lots (Abchlor 5/5 case)', async () => {
    loadStoreSelectableLots.mockResolvedValue([]);

    await expect(
      assertStoreIssueStock(conn, {
        productId: '22222222-2222-2222-2222-222222222222',
        productName: 'Abchlor eye droped',
        issuedQty: 5,
        storeLocationId: MAIN,
        multistore: true,
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(
        /Insufficient issuable stock for Abchlor eye droped at MAIN: requested 5\.0000, available 0\.0000/,
      ),
    });

    expect(loadStoreSelectableLots).toHaveBeenCalledWith(
      conn,
      '22222222-2222-2222-2222-222222222222',
      MAIN,
      expect.objectContaining({ forUpdate: true }),
    );
    expect(loadGlobalSelectableLots).not.toHaveBeenCalled();
  });

  it('allows issue when store lots cover requested qty', async () => {
    loadStoreSelectableLots.mockResolvedValue([
      { remainingQuantity: 3 },
      { remainingQuantity: 4 },
    ]);

    await expect(
      assertStoreIssueStock(conn, {
        productId: '22222222-2222-2222-2222-222222222222',
        productName: 'Abchlor eye droped',
        issuedQty: 5,
        storeLocationId: MAIN,
        multistore: true,
      }),
    ).resolves.toEqual({ available: 7, storeLabel: 'MAIN' });
  });

  it('uses global lots when multistore is off, even if a store id is sent', async () => {
    loadGlobalSelectableLots.mockResolvedValue([{ remainingQuantity: 2 }]);
    const preview = await previewStoreIssueAvailability(conn, 'p1', MAIN, false);
    expect(preview).toEqual({ available: 2, storeLabel: 'company stock' });
    expect(loadStoreSelectableLots).not.toHaveBeenCalled();
    expect(loadGlobalSelectableLots).toHaveBeenCalled();
  });

  it('rewrites consumeLot Error into a 400 with store + available', () => {
    try {
      wrapConsumeStockError(
        new Error('Insufficient stock for product Abchlor eye droped: requested 5.0000, short 5.0000'),
        {
          productName: 'Abchlor eye droped',
          requested: 5,
          available: 0,
          storeLabel: 'MAIN',
        },
      );
      throw new Error('expected wrapConsumeStockError to throw');
    } catch (err) {
      expect(err).toMatchObject({
        statusCode: 400,
        message: expect.stringMatching(
          /Insufficient issuable stock for Abchlor eye droped at MAIN: requested 5\.0000, available 0\.0000/,
        ),
      });
    }
  });
});
