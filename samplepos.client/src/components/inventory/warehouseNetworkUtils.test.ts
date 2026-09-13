import { describe, it, expect } from 'vitest';
import {
  filterSpecialStoresWithStock,
  operationalNetworkStores,
  resolveDefaultStockViewStore,
  retainOrDefaultStockViewStoreId,
  unwrapStockLevelRows,
} from './warehouseNetworkUtils';
import type { StoreLocation } from '../../../../shared/types/warehouseNetwork';

function store(id: string, storeType: StoreLocation['storeType']): StoreLocation {
  return {
    id,
    code: storeType,
    name: storeType,
    storeType,
    isActive: true,
    isDefaultReceiving: false,
    isPosSelling: false,
    parentStoreId: null,
    notes: null,
    createdAt: '',
    updatedAt: '',
  };
}

describe('filterSpecialStoresWithStock', () => {
  it('hides special stores with zero qty', () => {
    const returnStore = store('r1', 'RETURN');
    const damageStore = store('d1', 'DAMAGE');
    const qty = new Map([
      ['r1', 3],
      ['d1', 0],
    ]);
    const visible = filterSpecialStoresWithStock([returnStore, damageStore], qty);
    expect(visible.map((s) => s.id)).toEqual(['r1']);
  });

  it('shows none when all special stores are empty', () => {
    const transit = store('t1', 'TRANSIT');
    expect(filterSpecialStoresWithStock([transit], new Map())).toEqual([]);
  });
});

describe('resolveDefaultStockViewStore', () => {
  it('prefers the receiving warehouse when several MAIN stores exist', () => {
    const extra = { ...store('main2', 'MAIN'), name: 'Zed warehouse' };
    const receiving = { ...store('main1', 'MAIN'), name: 'Alpha warehouse', isDefaultReceiving: true };
    const selling = { ...store('sell', 'SELLING'), isPosSelling: true };
    expect(resolveDefaultStockViewStore([extra, selling, receiving])?.id).toBe('main1');
    expect(operationalNetworkStores([selling, extra, receiving]).map((s) => s.id)).toEqual([
      'main1',
      'main2',
      'sell',
    ]);
    expect(retainOrDefaultStockViewStoreId('sell', [extra, selling, receiving])).toBe('sell');
    expect(retainOrDefaultStockViewStoreId('', [extra, selling, receiving])).toBe('main1');
  });

  it('unwraps stock-level envelopes the same way the worklists do', () => {
    expect(unwrapStockLevelRows({ success: true, data: [{ product_id: 'p1', total_stock: 4 }] })).toEqual([
      { product_id: 'p1', total_stock: 4 },
    ]);
  });
});
