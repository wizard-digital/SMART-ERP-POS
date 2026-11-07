/**
 * @module inventorySync
 * @description SINGLE SOURCE OF TRUTH for product quantity synchronization.
 *
 * Every code path that modifies inventory_batches.remaining_quantity MUST call
 * syncProductQuantity() afterward to keep quantity sources consistent:
 *   1. inventory_batches  (individual batch remaining_quantity + status)
 *   2. product_inventory  (aggregate quantity_on_hand — used by most API reads)
 *   3. products           (aggregate quantity_on_hand — legacy / POS reads)
 *
 * When multistore is enabled, syncProductQuantity() also asserts:
 *   SUM(inventory_balances.quantity_on_hand) per lot = batch.remaining_quantity
 * and rolls back the transaction on mismatch (ERR_WAREHOUSE_LAYER_COUPLING).
 *
 * DO NOT inline the sync SQL elsewhere. Import this function instead.
 */

import { PoolClient } from 'pg';
import { assertWarehouseLayerConsistent } from '../services/warehouseInventoryCoupling.js';

/**
 * Synchronize product quantity across all tables after batch changes.
 *
 * Steps (atomic, must run inside a transaction):
 *   1. Normalize batch statuses (DEPLETED ↔ ACTIVE) based on remaining_quantity
 *   2. Aggregate ACTIVE batch quantities
 *   3. Update product_inventory.quantity_on_hand
 *   4. Update products.quantity_on_hand
 *
 * @param client - Active transaction PoolClient
 * @param productId - UUID of the product to sync
 */
export async function syncProductQuantity(client: PoolClient, productId: string): Promise<void> {
    // Ensure aggregate row exists (legacy products may lack product_inventory)
    await client.query(
        `INSERT INTO product_inventory (product_id, quantity_on_hand, updated_at)
         VALUES ($1, 0, CURRENT_TIMESTAMP)
         ON CONFLICT (product_id) DO NOTHING`,
        [productId],
    );

    // Step 1: Fix batch statuses before aggregating — prevents the DEPLETED-with-stock bug
    await client.query(
        `UPDATE inventory_batches
     SET status = CASE
       WHEN remaining_quantity > 0 THEN 'ACTIVE'::batch_status
       ELSE 'DEPLETED'::batch_status
     END,
     updated_at = CURRENT_TIMESTAMP
     WHERE product_id = $1
       AND (
         (remaining_quantity > 0 AND status != 'ACTIVE') OR
         (remaining_quantity <= 0 AND status = 'ACTIVE')
       )`,
        [productId]
    );

    // Step 2-4: Aggregate ACTIVE batches → update product_inventory + products atomically.
    // Also sync products.cost_price to batch weighted-average so header valuation
    // cannot drift from FEFO subledger (Henber Ozempic/Septrin cache-lane noise).
    await client.query(
        `WITH batch_agg AS (
       SELECT
         COALESCE(SUM(remaining_quantity), 0) AS qty,
         CASE
           WHEN COALESCE(SUM(remaining_quantity), 0) > 0
             THEN SUM(remaining_quantity * cost_price) / SUM(remaining_quantity)
           ELSE NULL
         END AS wavg_cost
       FROM inventory_batches
       WHERE product_id = $1 AND status = 'ACTIVE'
     ), upd_pi AS (
       UPDATE product_inventory
       SET quantity_on_hand = (SELECT qty FROM batch_agg),
           updated_at = CURRENT_TIMESTAMP
       WHERE product_id = $1
     )
     UPDATE products
     SET quantity_on_hand = (SELECT qty FROM batch_agg),
         cost_price = COALESCE((SELECT wavg_cost FROM batch_agg), cost_price),
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
        [productId]
    );

    await assertWarehouseLayerConsistent(client, `syncProductQuantity ${productId}`, productId);
}
