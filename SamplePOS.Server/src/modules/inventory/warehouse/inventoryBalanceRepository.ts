import type { Pool, PoolClient } from 'pg';
import {
    normalizeInventoryBalance,
    type InventoryBalance,
    type InventoryBalanceDbRow,
} from '../../../../../shared/types/warehouseNetwork.js';
import {
    openPurchaseOrdersJoinSql,
    OPERATIONAL_NETWORK_STORE_FILTER_SQL,
    POS_SELLING_STORE_FALLBACK_FILTER_SQL,
    posSellingStoreFilterSql,
    productUomsJsonSql,
    SELLABLE_LOT_PREDICATE_SQL,
} from './inventoryStockSqlFragments.js';
import { storeLocationRepository } from './storeLocationRepository.js';

export type DbConn = Pool | PoolClient;

export type StockLevelRow = Record<string, unknown>;

function buildMultistoreStockAggregateSql(storeFilter: string): string {
    return `(
      SELECT
        ib.product_id,
        SUM(
          GREATEST(
            ib.quantity_on_hand - ib.quantity_reserved - ib.quantity_committed,
            0
          )
        ) AS total_stock,
        MIN(pl.expiry_date) FILTER (WHERE ib.quantity_on_hand > 0) AS nearest_expiry,
        SUM(ib.quantity_reserved) AS qty_reserved,
        SUM(ib.quantity_damaged) AS qty_damaged,
        SUM(ib.quantity_expired) AS qty_expired,
        SUM(ib.quantity_incoming) AS qty_incoming,
        SUM(ib.quantity_transfer_in) AS qty_transfer_in,
        SUM(ib.quantity_transfer_out) AS qty_transfer_out,
        SUM(ib.quantity_committed) AS qty_committed
      FROM inventory_balances ib
      INNER JOIN product_lots pl ON pl.id = ib.product_lot_id
      INNER JOIN store_locations sl ON sl.id = ib.store_location_id
      INNER JOIN products p2 ON p2.id = ib.product_id
      WHERE ${storeFilter}
        AND ${SELLABLE_LOT_PREDICATE_SQL}
      GROUP BY ib.product_id
    ) ms_stock`;
}

export const inventoryBalanceRepository = {
    async getBalanceById(conn: DbConn, id: string): Promise<InventoryBalance | null> {
        const result = await conn.query<InventoryBalanceDbRow>(
            `SELECT * FROM inventory_balances WHERE id = $1`,
            [id],
        );
        return result.rows[0] ? normalizeInventoryBalance(result.rows[0]) : null;
    },

    async getBalanceForUpdate(
        conn: PoolClient,
        storeLocationId: string,
        productLotId: string,
    ): Promise<InventoryBalance | null> {
        const result = await conn.query<InventoryBalanceDbRow>(
            `SELECT *
             FROM inventory_balances
             WHERE store_location_id = $1 AND product_lot_id = $2
             FOR UPDATE`,
            [storeLocationId, productLotId],
        );
        return result.rows[0] ? normalizeInventoryBalance(result.rows[0]) : null;
    },

    async getStockLevels(conn: DbConn): Promise<StockLevelRow[]> {
        const msStock = buildMultistoreStockAggregateSql(OPERATIONAL_NETWORK_STORE_FILTER_SQL);

        const result = await conn.query(
            `SELECT
               p.id as product_id,
               p.name as product_name,
               p.sku,
               p.barcode,
               p.generic_name,
               p.category,
               pv.selling_price,
               p.is_taxable,
               p.tax_rate,
               p.min_days_before_expiry_sale,
               p.product_type,
               COALESCE(NULLIF(pv.average_cost, 0), pv.cost_price) as average_cost,
               COALESCE(ms_stock.total_stock, 0) as total_stock,
               ms_stock.nearest_expiry,
               pi.reorder_level,
               CASE WHEN COALESCE(ms_stock.total_stock, 0) <= pi.reorder_level THEN true ELSE false END as needs_reorder,
               COALESCE(po_agg.qty_on_order, 0) as qty_on_order,
               COALESCE(ms_stock.qty_reserved, 0) as qty_reserved,
               COALESCE(ms_stock.qty_damaged, 0) as qty_damaged,
               COALESCE(ms_stock.qty_expired, 0) as qty_expired,
               COALESCE(ms_stock.qty_incoming, 0) as qty_incoming,
               COALESCE(ms_stock.qty_transfer_in, 0) as qty_transfer_in,
               COALESCE(ms_stock.qty_transfer_out, 0) as qty_transfer_out,
               COALESCE(ms_stock.qty_committed, 0) as qty_committed,
               ${productUomsJsonSql('p', 'pv')} as uoms
             FROM products p
             LEFT JOIN product_inventory pi ON pi.product_id = p.id
             LEFT JOIN product_valuation pv ON pv.product_id = p.id
             LEFT JOIN ${msStock} ON ms_stock.product_id = p.id
             ${openPurchaseOrdersJoinSql()}
             WHERE p.is_active = true
             ORDER BY needs_reorder DESC, p.name ASC`,
        );

        return result.rows;
    },

    async getStockLevelsForStore(conn: DbConn, storeLocationId: string): Promise<StockLevelRow[]> {
        const params: unknown[] = [storeLocationId];
        const msStock = buildMultistoreStockAggregateSql(posSellingStoreFilterSql('$1'));

        const result = await conn.query(
            `SELECT
               p.id as product_id,
               p.name as product_name,
               p.sku,
               p.barcode,
               p.generic_name,
               p.category,
               pv.selling_price,
               p.is_taxable,
               p.tax_rate,
               p.min_days_before_expiry_sale,
               p.product_type,
               COALESCE(NULLIF(pv.average_cost, 0), pv.cost_price) as average_cost,
               COALESCE(ms_stock.total_stock, 0) as total_stock,
               ms_stock.nearest_expiry,
               pi.reorder_level,
               CASE WHEN COALESCE(ms_stock.total_stock, 0) <= pi.reorder_level THEN true ELSE false END as needs_reorder,
               COALESCE(po_agg.qty_on_order, 0) as qty_on_order,
               COALESCE(ms_stock.qty_reserved, 0) as qty_reserved,
               sl.name as store_location_name,
               sl.code as store_location_code,
               sl.id as store_location_id,
               ${productUomsJsonSql('p', 'pv')} as uoms
             FROM products p
             LEFT JOIN product_inventory pi ON pi.product_id = p.id
             LEFT JOIN product_valuation pv ON pv.product_id = p.id
             LEFT JOIN ${msStock} ON ms_stock.product_id = p.id
             LEFT JOIN store_locations sl ON sl.id = $1
             ${openPurchaseOrdersJoinSql()}
             WHERE p.is_active = true
             ORDER BY needs_reorder DESC, p.name ASC`,
            params,
        );

        return result.rows;
    },

    async getStockLevelByProduct(conn: DbConn, productId: string): Promise<StockLevelRow | null> {
        const sellingStore = await storeLocationRepository.getActivePosSellingStore(conn);
        const params: unknown[] = [productId];
        let storeFilter = POS_SELLING_STORE_FALLBACK_FILTER_SQL;
        if (sellingStore?.id) {
            params.push(sellingStore.id);
            storeFilter = posSellingStoreFilterSql('$2');
        }

        const result = await conn.query(
            `SELECT
               p.id as product_id,
               p.name as product_name,
               COALESCE(ms.total_stock, 0) as total_quantity,
               pi.reorder_level,
               CASE WHEN COALESCE(ms.total_stock, 0) <= pi.reorder_level THEN true ELSE false END as needs_reorder
             FROM products p
             LEFT JOIN product_inventory pi ON pi.product_id = p.id
             LEFT JOIN LATERAL (
               SELECT SUM(
                 GREATEST(
                   ib.quantity_on_hand - ib.quantity_reserved - ib.quantity_committed,
                   0
                 )
               ) AS total_stock
               FROM inventory_balances ib
               INNER JOIN product_lots pl ON pl.id = ib.product_lot_id
               INNER JOIN store_locations sl ON sl.id = ib.store_location_id
               WHERE ib.product_id = p.id
                 AND ${storeFilter}
                 AND pl.status = 'ACTIVE'
                 AND NOT ib.blocked
                 AND ib.quantity_on_hand > 0
                 AND (pl.expiry_date IS NULL OR pl.expiry_date > CURRENT_DATE)
                 AND (
                   pl.expiry_date IS NULL
                   OR pl.expiry_date > CURRENT_DATE + COALESCE(p.min_days_before_expiry_sale, 0) * INTERVAL '1 day'
                 )
             ) ms ON true
             WHERE p.id = $1 AND p.is_active = true`,
            params,
        );

        return result.rows.length > 0 ? result.rows[0] : null;
    },
};
