/**
 * Multistore warehouse layer coupling — batch subledger ↔ product_lots ↔ inventory_balances.
 *
 * When is_multistore_enabled:
 *   For each product_lot linked to inventory_batches,
 *   SUM(inventory_balances.quantity_on_hand) across stores MUST equal batch.remaining_quantity.
 *
 * Any workflow that calls syncProductQuantity() after mutating stock will roll back on drift.
 */
import type { PoolClient } from 'pg';
import { BusinessError } from '../middleware/errorHandler.js';
import { isMultistoreEnabled } from '../modules/inventory/warehouse/multistoreSettings.js';
import { assertPosSellableProjectionConsistent } from '../modules/inventory/warehouse/posSellableCoverage.js';
import logger from '../utils/logger.js';

export const WAREHOUSE_LAYER_TOLERANCE = 0.001;

export interface LotLayerMismatch {
    productId: string;
    productLotId: string;
    lotNumber: string;
    inventoryBatchId: string | null;
    balanceTotal: number;
    batchRemaining: number;
    delta: number;
}

export async function findWarehouseLayerMismatches(
    client: PoolClient,
    productId?: string,
): Promise<LotLayerMismatch[]> {
    const params: string[] = [];
    let productFilter = '';
    if (productId) {
        params.push(productId);
        productFilter = `AND pl.product_id = $1`;
    }

    // SSOT is per inventory_batch: SUM(balances across all product_lots for that batch)
    // must equal batch.remaining_quantity. Never compare one orphan projection row alone —
    // heal scripts may have created MAIN-{id} while upsert used batch_number MAIN.
    const result = await client.query<{
        product_id: string;
        product_lot_id: string;
        lot_number: string;
        inventory_batch_id: string | null;
        balance_total: string;
        batch_remaining: string;
    }>(
        `SELECT
           pl.product_id,
           (array_agg(pl.id ORDER BY pl.created_at ASC))[1] AS product_lot_id,
           (array_agg(pl.lot_number ORDER BY pl.created_at ASC))[1] AS lot_number,
           pl.inventory_batch_id,
           COALESCE(SUM(ib.quantity_on_hand), 0)::numeric AS balance_total,
           COALESCE(MAX(b.remaining_quantity), 0)::numeric AS batch_remaining
         FROM product_lots pl
         LEFT JOIN inventory_balances ib ON ib.product_lot_id = pl.id
         LEFT JOIN inventory_batches b ON b.id = pl.inventory_batch_id
         WHERE pl.inventory_batch_id IS NOT NULL
           ${productFilter}
         GROUP BY pl.product_id, pl.inventory_batch_id
         HAVING ABS(
           COALESCE(SUM(ib.quantity_on_hand), 0)::numeric
           - COALESCE(MAX(b.remaining_quantity), 0)::numeric
         ) > ${WAREHOUSE_LAYER_TOLERANCE}`,
        params,
    );

    return result.rows.map((row) => {
        const balanceTotal = parseFloat(row.balance_total);
        const batchRemaining = parseFloat(row.batch_remaining);
        return {
            productId: row.product_id,
            productLotId: row.product_lot_id,
            lotNumber: row.lot_number,
            inventoryBatchId: row.inventory_batch_id,
            balanceTotal,
            batchRemaining,
            delta: balanceTotal - batchRemaining,
        };
    });
}

/**
 * Align batch.remaining_quantity to SUM(inventory_balances) per linked lot.
 * Store balances are operational truth in multistore mode.
 * Returns number of batches updated.
 */
export async function alignBatchSubledgerToStoreBalances(
    client: PoolClient,
    productId: string,
): Promise<number> {
    if (!(await isMultistoreEnabled(client))) {
        return 0;
    }

    const result = await client.query<{ id: string }>(
        `UPDATE inventory_batches b
         SET remaining_quantity = agg.balance_total,
             status = CASE
               WHEN agg.balance_total > 0 THEN 'ACTIVE'::batch_status
               ELSE 'DEPLETED'::batch_status
             END,
             updated_at = CURRENT_TIMESTAMP
         FROM (
           SELECT pl.inventory_batch_id,
                  COALESCE(SUM(ib.quantity_on_hand), 0)::numeric AS balance_total
           FROM product_lots pl
           LEFT JOIN inventory_balances ib ON ib.product_lot_id = pl.id
           WHERE pl.product_id = $1
             AND pl.inventory_batch_id IS NOT NULL
           GROUP BY pl.inventory_batch_id
         ) agg
         WHERE b.id = agg.inventory_batch_id
           AND b.product_id = $1
           AND ABS(b.remaining_quantity - agg.balance_total) > ${WAREHOUSE_LAYER_TOLERANCE}
         RETURNING b.id`,
        [productId],
    );

    return result.rowCount ?? 0;
}

/**
 * Align store balances TO batch.remaining_quantity (economic SSOT from stock_movements).
 * Use to heal INV-002 drift where outbound paths mutated batch without balances (or vice versa).
 * Returns number of batches healed.
 */
export async function alignStoreBalancesToBatchSubledger(
    client: PoolClient,
    productId?: string,
): Promise<number> {
    if (!(await isMultistoreEnabled(client))) {
        return 0;
    }

    const mismatches = await findWarehouseLayerMismatches(client, productId);
    if (mismatches.length === 0) {
        return 0;
    }

    const { storeLocationRepository } = await import(
        '../modules/inventory/warehouse/storeLocationRepository.js'
    );
    const { warehouseInventoryRepository } = await import(
        '../modules/inventory/warehouse/warehouseInventoryRepository.js'
    );

    const selling = await storeLocationRepository.getActivePosSellingStore(client);
    const main = await storeLocationRepository.getDefaultReceivingStore(client);
    const fallbackStoreId = selling?.id ?? main?.id;
    let healed = 0;

    for (const m of mismatches) {
        if (!m.inventoryBatchId) continue;
        const delta = m.batchRemaining - m.balanceTotal; // +need more on balances; -reduce balances
        if (Math.abs(delta) <= WAREHOUSE_LAYER_TOLERANCE) continue;

        const lotRes = await client.query<{ id: string; product_id: string }>(
            `SELECT id, product_id FROM product_lots
             WHERE inventory_batch_id = $1
             ORDER BY created_at ASC
             LIMIT 1`,
            [m.inventoryBatchId],
        );
        const lot = lotRes.rows[0];
        if (!lot) continue;

        if (delta < 0) {
            let left = -delta;
            const bals = await client.query<{
                store_location_id: string;
                quantity_on_hand: string;
            }>(
                `SELECT store_location_id, quantity_on_hand
                 FROM inventory_balances
                 WHERE product_lot_id = $1 AND quantity_on_hand > 0
                 ORDER BY quantity_on_hand DESC
                 FOR UPDATE`,
                [lot.id],
            );
            for (const row of bals.rows) {
                if (left <= WAREHOUSE_LAYER_TOLERANCE) break;
                const oh = parseFloat(row.quantity_on_hand);
                const take = Math.min(left, oh);
                if (take <= WAREHOUSE_LAYER_TOLERANCE) continue;
                await warehouseInventoryRepository.adjustSellableQuantity(client, {
                    storeLocationId: row.store_location_id,
                    productLotId: lot.id,
                    productId: lot.product_id,
                    quantity: take,
                    direction: 'OUT',
                });
                left -= take;
            }
            if (left > WAREHOUSE_LAYER_TOLERANCE) {
                logger.warn('[WAREHOUSE LAYER] Could not fully reduce balances to batch', {
                    batchId: m.inventoryBatchId,
                    lotNumber: m.lotNumber,
                    short: left,
                });
            }
        } else {
            if (!fallbackStoreId) {
                logger.warn('[WAREHOUSE LAYER] No store to seed balance heal', {
                    batchId: m.inventoryBatchId,
                });
                continue;
            }
            await warehouseInventoryRepository.incrementBalanceAtStore(client, {
                storeLocationId: fallbackStoreId,
                productId: lot.product_id,
                productLotId: lot.id,
                quantity: delta,
            });
        }
        healed += 1;
    }

    if (healed > 0) {
        logger.info('[WAREHOUSE LAYER] Aligned store balances to batch subledger', {
            productId: productId ?? 'ALL',
            batchesHealed: healed,
        });
    }
    return healed;
}

/**
 * Heal INV-002 then assert. Used on multistore enable / repair.
 */
export async function healAndAssertWarehouseLayer(
    client: PoolClient,
    context: string,
    productId?: string,
): Promise<{ healed: number }> {
    const healed = await alignStoreBalancesToBatchSubledger(client, productId);
    await assertWarehouseLayerConsistent(client, context, productId);
    return { healed };
}

/**
 * Roll back the transaction if warehouse balances diverged from batch subledger.
 */
export async function assertWarehouseLayerConsistent(
    client: PoolClient,
    context: string,
    productId?: string,
): Promise<void> {
    if (!(await isMultistoreEnabled(client))) {
        return;
    }

    const mismatches = await findWarehouseLayerMismatches(client, productId);
    if (mismatches.length === 0) {
        await assertPosSellableProjectionConsistent(client, context, productId);
        return;
    }

    logger.error('[WAREHOUSE LAYER] Batch subledger diverged from store balances', {
        context,
        productId: productId ?? 'ALL',
        mismatches: mismatches.slice(0, 10),
        count: mismatches.length,
    });

    const sample = mismatches[0];
    throw new BusinessError(
        `Warehouse inventory mismatch (${context}). ` +
            `Lot ${sample.lotNumber}: balances=${sample.balanceTotal}, batch=${sample.batchRemaining}. ` +
            `Transaction rolled back.`,
        'ERR_WAREHOUSE_LAYER_COUPLING',
        {
            context,
            mismatchCount: mismatches.length,
            sample,
        },
    );
}

export async function assertWarehouseLayerConsistentForProducts(
    client: PoolClient,
    context: string,
    productIds: string[],
): Promise<void> {
    const unique = [...new Set(productIds.filter(Boolean))];
    for (const productId of unique) {
        await assertWarehouseLayerConsistent(client, context, productId);
    }
}
