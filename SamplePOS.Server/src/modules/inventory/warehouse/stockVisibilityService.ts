import type { Pool, PoolClient } from 'pg';
import { inventoryRepository } from '../inventoryRepository.js';
import { isMultistoreEnabled } from './multistoreSettings.js';
import { storeLocationRepository } from './storeLocationRepository.js';
import { inventoryBalanceRepository } from './inventoryBalanceRepository.js';

export type DbConn = Pool | PoolClient;

export type StockVisibilityRow = Record<string, unknown>;

/**
 * Phase 6 — stock visibility with store context when multistore enabled.
 * Legacy tenants receive existing stock-levels shape (global pool).
 */
export const stockVisibilityService = {
    async getStockVisibility(conn: DbConn): Promise<{
        multistore: boolean;
        storeLocationId: string | null;
        storeName: string | null;
        products: StockVisibilityRow[];
    }> {
        const multistore = await isMultistoreEnabled(conn);

        if (!multistore) {
            const products = await inventoryRepository.getStockLevels(conn as Pool);
            return {
                multistore: false,
                storeLocationId: null,
                storeName: null,
                products: products as unknown as StockVisibilityRow[],
            };
        }

        const store = await storeLocationRepository.getActivePosSellingStore(conn);
        const products = store
            ? await inventoryBalanceRepository.getStockLevelsForStore(conn, store.id)
            : [];

        return {
            multistore: true,
            storeLocationId: store?.id ?? null,
            storeName: store?.name ?? null,
            products,
        };
    },
};
