import type { Pool, PoolClient } from 'pg';
import { isMultistoreEnabled } from './multistoreSettings.js';
import { productUomsJsonSql } from './inventoryStockSqlFragments.js';

export type DbConn = Pool | PoolClient;

export interface ProductStoreDistributionRow {
    storeLocationId: string;
    storeCode: string;
    storeName: string;
    storeType: string;
    quantityOnHand: number;
    quantityReserved: number;
    quantityCommitted: number;
    availableQuantity: number;
}

/**
 * Per-product stock balances split by store (multistore only).
 */
export const productStoreDistributionService = {
    async getDistribution(
        conn: DbConn,
        productId: string,
    ): Promise<ProductStoreDistributionRow[]> {
        if (!(await isMultistoreEnabled(conn))) {
            return [];
        }

        const result = await conn.query(
            `SELECT
               sl.id AS store_location_id,
               sl.code AS store_code,
               sl.name AS store_name,
               sl.store_type::text AS store_type,
               COALESCE(SUM(ib.quantity_on_hand), 0) AS quantity_on_hand,
               COALESCE(SUM(ib.quantity_reserved), 0) AS quantity_reserved,
               COALESCE(SUM(ib.quantity_committed), 0) AS quantity_committed
             FROM store_locations sl
             LEFT JOIN inventory_balances ib
               ON ib.store_location_id = sl.id AND ib.product_id = $1
             LEFT JOIN product_lots pl ON pl.id = ib.product_lot_id
               AND pl.status = 'ACTIVE'
             WHERE sl.is_active = true
             GROUP BY sl.id, sl.code, sl.name, sl.store_type
             HAVING COALESCE(SUM(ib.quantity_on_hand), 0) > 0
                OR sl.store_type IN ('MAIN', 'SELLING', 'TRANSIT')
             ORDER BY sl.store_type, sl.code`,
            [productId],
        );

        return result.rows.map((r) => {
            const onHand = parseFloat(r.quantity_on_hand);
            const reserved = parseFloat(r.quantity_reserved);
            const committed = parseFloat(r.quantity_committed);
            return {
                storeLocationId: r.store_location_id,
                storeCode: r.store_code,
                storeName: r.store_name,
                storeType: r.store_type,
                quantityOnHand: onHand,
                quantityReserved: reserved,
                quantityCommitted: committed,
                availableQuantity: Math.max(onHand - reserved - committed, 0),
            };
        });
    },

    async listLotsAtStore(
        conn: DbConn,
        storeLocationId: string,
    ): Promise<Array<{
        productLotId: string;
        inventoryBatchId: string | null;
        lotNumber: string;
        productId: string;
        productName: string;
        availableQuantity: number;
        expiryDate: string | null;
    }>> {
        if (!(await isMultistoreEnabled(conn))) {
            return [];
        }

        const result = await conn.query(
            `SELECT
               pl.id AS product_lot_id,
               pl.inventory_batch_id,
               pl.lot_number,
               pl.product_id,
               p.name AS product_name,
               pl.expiry_date,
               GREATEST(
                 ib.quantity_on_hand - ib.quantity_reserved - ib.quantity_committed,
                 0
               ) AS available_qty
             FROM inventory_balances ib
             INNER JOIN product_lots pl ON pl.id = ib.product_lot_id
             INNER JOIN products p ON p.id = pl.product_id
             WHERE ib.store_location_id = $1
               AND pl.status = 'ACTIVE'
               AND NOT ib.blocked
               AND ib.quantity_on_hand > 0
               AND (ib.quantity_on_hand - ib.quantity_reserved - ib.quantity_committed) > 0
             ORDER BY pl.expiry_date ASC NULLS LAST, pl.lot_number ASC`,
            [storeLocationId],
        );

        return result.rows.map((r) => ({
            productLotId: r.product_lot_id,
            inventoryBatchId: r.inventory_batch_id ?? null,
            lotNumber: r.lot_number,
            productId: r.product_id,
            productName: r.product_name,
            expiryDate: r.expiry_date,
            availableQuantity: parseFloat(r.available_qty),
        }));
    },

    async searchLotsAtStore(
        conn: DbConn,
        storeLocationId: string,
        query: string,
        limit = 25,
    ): Promise<
        Array<{
            productLotId: string;
            lotNumber: string;
            productId: string;
            productName: string;
            sku: string | null;
            barcode: string | null;
            availableQuantity: number;
            expiryDate: string | null;
        }>
    > {
        if (!(await isMultistoreEnabled(conn))) {
            return [];
        }

        const trimmed = query.trim();
        if (!trimmed) {
            return [];
        }

        const pattern = `%${trimmed}%`;
        const exact = trimmed;
        const cappedLimit = Math.min(Math.max(limit, 1), 50);

        const result = await conn.query(
            `SELECT
               pl.id AS product_lot_id,
               pl.lot_number,
               pl.product_id,
               p.name AS product_name,
               p.sku,
               p.barcode,
               pl.expiry_date,
               GREATEST(
                 ib.quantity_on_hand - ib.quantity_reserved - ib.quantity_committed,
                 0
               ) AS available_qty,
               CASE
                 WHEN COALESCE(p.barcode, '') = $3 THEN 0
                 WHEN COALESCE(p.sku, '') ILIKE $3 THEN 1
                 ELSE 2
               END AS match_rank
             FROM inventory_balances ib
             INNER JOIN product_lots pl ON pl.id = ib.product_lot_id
             INNER JOIN products p ON p.id = pl.product_id
             WHERE ib.store_location_id = $1
               AND pl.status = 'ACTIVE'
               AND NOT ib.blocked
               AND (ib.quantity_on_hand - ib.quantity_reserved - ib.quantity_committed) > 0
               AND (
                 p.name ILIKE $2
                 OR COALESCE(p.sku, '') ILIKE $2
                 OR COALESCE(p.barcode, '') ILIKE $2
                 OR pl.lot_number ILIKE $2
               )
             ORDER BY match_rank ASC, pl.expiry_date ASC NULLS LAST, pl.lot_number ASC
             LIMIT $4`,
            [storeLocationId, pattern, exact, cappedLimit],
        );

        return result.rows.map((r) => ({
            productLotId: r.product_lot_id,
            lotNumber: r.lot_number,
            productId: r.product_id,
            productName: r.product_name,
            sku: r.sku,
            barcode: r.barcode,
            expiryDate: r.expiry_date,
            availableQuantity: parseFloat(r.available_qty),
        }));
    },

    /**
     * Product-level search at a store (MAIN warehouse transfers).
     * Aggregates sellable qty per product with MUoM ladder — PO-style picker.
     */
    async searchProductsAtStore(
        conn: DbConn,
        storeLocationId: string,
        query: string,
        limit = 20,
    ): Promise<
        Array<{
            productId: string;
            productName: string;
            sku: string | null;
            barcode: string | null;
            category: string | null;
            storeCode: string | null;
            storeName: string | null;
            onHandQuantity: number;
            reservedQuantity: number;
            freeQuantity: number;
            availableQuantity: number;
            nearestExpiry: string | null;
            primaryLotNumber: string | null;
            uoms: unknown;
        }>
    > {
        if (!(await isMultistoreEnabled(conn))) {
            return [];
        }

        const trimmed = query.trim();
        if (trimmed.length < 2) {
            return [];
        }

        const pattern = `%${trimmed}%`;
        const exact = trimmed;
        const cappedLimit = Math.min(Math.max(limit, 1), 50);

        const result = await conn.query(
            `WITH sellable AS (
               SELECT
                 ib.product_id,
                 SUM(ib.quantity_on_hand) AS on_hand_total,
                 SUM(ib.quantity_reserved + ib.quantity_committed) AS reserved_total,
                 SUM(
                   GREATEST(
                     ib.quantity_on_hand - ib.quantity_reserved - ib.quantity_committed,
                     0
                   )
                 ) AS free_total,
                 MIN(pl.expiry_date) FILTER (
                   WHERE ib.quantity_on_hand > 0
                     AND (pl.expiry_date IS NULL OR pl.expiry_date > CURRENT_DATE)
                 ) AS nearest_expiry,
                 (
                   array_agg(pl.lot_number ORDER BY pl.expiry_date ASC NULLS LAST, pl.lot_number ASC)
                   FILTER (WHERE ib.quantity_on_hand > 0)
                 )[1] AS primary_lot_number
               FROM inventory_balances ib
               INNER JOIN product_lots pl ON pl.id = ib.product_lot_id
               INNER JOIN products p2 ON p2.id = ib.product_id
               WHERE ib.store_location_id = $1
                 AND pl.status = 'ACTIVE'
                 AND NOT ib.blocked
                 AND ib.quantity_on_hand > 0
                 AND (pl.expiry_date IS NULL OR pl.expiry_date > CURRENT_DATE)
               GROUP BY ib.product_id
               HAVING SUM(
                 GREATEST(
                   ib.quantity_on_hand - ib.quantity_reserved - ib.quantity_committed,
                   0
                 )
               ) > 0
             )
             SELECT
               p.id AS product_id,
               p.name AS product_name,
               p.sku,
               p.barcode,
               p.category,
               sl.code AS store_code,
               sl.name AS store_name,
               sellable.on_hand_total,
               sellable.reserved_total,
               sellable.free_total,
               sellable.nearest_expiry,
               sellable.primary_lot_number,
               ${productUomsJsonSql('p', 'pv')} AS uoms,
               CASE
                 WHEN COALESCE(p.barcode, '') = $3 THEN 0
                 WHEN COALESCE(p.sku, '') ILIKE $3 THEN 1
                 WHEN sellable.primary_lot_number ILIKE $2 THEN 2
                 ELSE 3
               END AS match_rank
             FROM products p
             INNER JOIN sellable ON sellable.product_id = p.id
             LEFT JOIN product_valuation pv ON pv.product_id = p.id
             CROSS JOIN store_locations sl
             WHERE sl.id = $1
               AND p.is_active = true
               AND p.product_type <> 'service'
               AND (
                 p.name ILIKE $2
                 OR COALESCE(p.sku, '') ILIKE $2
                 OR COALESCE(p.barcode, '') ILIKE $2
                 OR COALESCE(p.category, '') ILIKE $2
                 OR sellable.primary_lot_number ILIKE $2
               )
             ORDER BY match_rank ASC, p.name ASC
             LIMIT $4`,
            [storeLocationId, pattern, exact, cappedLimit],
        );

        return result.rows.map((r) => ({
            productId: r.product_id,
            productName: r.product_name,
            sku: r.sku,
            barcode: r.barcode,
            category: r.category,
            storeCode: r.store_code,
            storeName: r.store_name,
            onHandQuantity: parseFloat(r.on_hand_total),
            reservedQuantity: parseFloat(r.reserved_total),
            freeQuantity: parseFloat(r.free_total),
            availableQuantity: parseFloat(r.free_total),
            nearestExpiry: r.nearest_expiry,
            primaryLotNumber: r.primary_lot_number,
            uoms: r.uoms,
        }));
    },

    /** FEFO-ordered lots for a product at a store (transfer allocation + adjust). */
    async listLotsForProductAtStore(
        conn: DbConn,
        storeLocationId: string,
        productId: string,
    ): Promise<
        Array<{
            productLotId: string;
            inventoryBatchId: string | null;
            lotNumber: string;
            productId: string;
            productName: string;
            sku: string | null;
            barcode: string | null;
            availableQuantity: number;
            expiryDate: string | null;
        }>
    > {
        if (!(await isMultistoreEnabled(conn))) {
            return [];
        }

        const result = await conn.query(
            `SELECT
               pl.id AS product_lot_id,
               pl.inventory_batch_id,
               pl.lot_number,
               pl.product_id,
               p.name AS product_name,
               p.sku,
               p.barcode,
               pl.expiry_date,
               GREATEST(
                 ib.quantity_on_hand - ib.quantity_reserved - ib.quantity_committed,
                 0
               ) AS available_qty
             FROM inventory_balances ib
             INNER JOIN product_lots pl ON pl.id = ib.product_lot_id
             INNER JOIN products p ON p.id = pl.product_id
             WHERE ib.store_location_id = $1
               AND pl.product_id = $2
               AND pl.status = 'ACTIVE'
               AND NOT ib.blocked
               AND (ib.quantity_on_hand - ib.quantity_reserved - ib.quantity_committed) > 0
             ORDER BY pl.expiry_date ASC NULLS LAST, pl.lot_number ASC`,
            [storeLocationId, productId],
        );

        return result.rows.map((r) => ({
            productLotId: r.product_lot_id,
            inventoryBatchId: r.inventory_batch_id ?? null,
            lotNumber: r.lot_number,
            productId: r.product_id,
            productName: r.product_name,
            sku: r.sku,
            barcode: r.barcode,
            expiryDate: r.expiry_date,
            availableQuantity: parseFloat(r.available_qty),
        }));
    },
};
