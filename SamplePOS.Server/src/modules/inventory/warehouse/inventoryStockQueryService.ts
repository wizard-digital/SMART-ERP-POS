import type { Pool, PoolClient } from 'pg';
import { inventoryRepository, type StockLevel } from '../inventoryRepository.js';
import { isMultistoreEnabled } from './multistoreSettings.js';
import { inventoryBalanceRepository, type StockLevelRow } from './inventoryBalanceRepository.js';

export type DbConn = Pool | PoolClient;

export type RoutedStockLevel = StockLevel | StockLevelRow;

/**
 * Service-layer stock query router.
 * When is_multistore_enabled is FALSE (default), delegates to legacy inventory_batches path unchanged.
 * When TRUE, company totals are MAIN warehouse + selling shops.
 * Pass storeLocationId to scope one location (warehouse or a shop). POS catalog stays SELLING-only.
 */
export const inventoryStockQueryService = {
    async isMultistoreEnabled(conn: DbConn): Promise<boolean> {
        return isMultistoreEnabled(conn);
    },

    async getStockLevels(conn: DbConn, storeLocationId?: string): Promise<RoutedStockLevel[]> {
        if (!(await isMultistoreEnabled(conn))) {
            return inventoryRepository.getStockLevels(conn as Pool);
        }
        if (storeLocationId) {
            return inventoryBalanceRepository.getStockLevelsForStore(conn, storeLocationId);
        }
        return inventoryBalanceRepository.getStockLevels(conn);
    },

    async getStockLevelByProduct(
        conn: DbConn,
        productId: string,
    ): Promise<RoutedStockLevel | null> {
        if (!(await isMultistoreEnabled(conn))) {
            return inventoryRepository.getStockLevelByProduct(conn as Pool, productId);
        }
        return inventoryBalanceRepository.getStockLevelByProduct(conn, productId);
    },
};
