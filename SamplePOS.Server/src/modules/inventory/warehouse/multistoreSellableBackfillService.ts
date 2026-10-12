/**
 * Multistore enable / repair SSOT — ensure ACTIVE batch stock is sellable at POS.
 *
 * Idempotent:
 *  1) Ensure product_lots projection for every ACTIVE sellable batch
 *  2) If SELLING sellable is 0 and MAIN has OH → move MAIN → SELLING
 *  3) If no balances yet → place batch remaining on SELLING
 */
import type { Pool, PoolClient } from 'pg';
import { storeLocationRepository } from './storeLocationRepository.js';
import { warehouseInventoryRepository } from './warehouseInventoryRepository.js';
import {
  assertPosSellableCoverageConsistent,
  POS_SELLABLE_TOLERANCE,
} from './posSellableCoverage.js';
import { healAndAssertWarehouseLayer } from '../../../services/warehouseInventoryCoupling.js';
import logger from '../../../utils/logger.js';

export type DbConn = Pool | PoolClient;

export interface MultistoreSellableBackfillResult {
  lotsCreated: number;
  balancesSeeded: number;
  unitsMovedMainToSelling: number;
  unitsSeededOnSelling: number;
  batchesProcessed: number;
  batchesHealed?: number;
  /**
   * When softAssert is used (multistore enable), residual drift after heal is reported
   * here instead of rolling back the enable toggle.
   */
  warnings?: string[];
}

export type EnsurePosSellableOptions = {
  /**
   * Enable path: do not throw on warehouse/POS coverage asserts.
   * Operational repairs (scripts) keep hard fail (default).
   */
  softAssert?: boolean;
};

export const multistoreSellableBackfillService = {
  /**
   * Make POS catalog stock match sellable inventory_batches for this tenant.
   * Safe to re-run. Requires an open transaction when called from UnitOfWork.
   */
  async ensurePosSellableFromBatches(
    conn: DbConn,
    options: EnsurePosSellableOptions = {},
  ): Promise<MultistoreSellableBackfillResult> {
    await storeLocationRepository.ensureDefaultNetworkStores(conn);

    const selling = await storeLocationRepository.getActivePosSellingStore(conn);
    if (!selling) {
      throw new Error('Multistore sellable backfill requires an active SELLING store');
    }
    const main = await storeLocationRepository.getDefaultReceivingStore(conn);

    const result: MultistoreSellableBackfillResult = {
      lotsCreated: 0,
      balancesSeeded: 0,
      unitsMovedMainToSelling: 0,
      unitsSeededOnSelling: 0,
      batchesProcessed: 0,
      warnings: [],
    };

    const lots = await conn.query<{ id: string }>(
      `INSERT INTO product_lots (
         product_id, lot_number, expiry_date, cost_price, received_date, status,
         goods_receipt_id, inventory_batch_id, is_bonus
       )
       SELECT
         b.product_id,
         COALESCE(NULLIF(TRIM(b.batch_number), ''), 'LOT')
           || '-' || SUBSTRING(REPLACE(b.id::text, '-', '') FROM 1 FOR 10),
         b.expiry_date,
         COALESCE(b.cost_price, 0),
         COALESCE(b.received_date, NOW()),
         'ACTIVE',
         b.goods_receipt_id,
         b.id,
         COALESCE(b.is_bonus, false)
       FROM inventory_batches b
       JOIN products p ON p.id = b.product_id
       WHERE b.status = 'ACTIVE'
         AND b.remaining_quantity > $1
         AND p.is_active = true
         AND COALESCE(p.product_type, 'product') <> 'service'
         AND NOT EXISTS (
           SELECT 1 FROM product_lots pl WHERE pl.inventory_batch_id = b.id
         )
       RETURNING id`,
      [POS_SELLABLE_TOLERANCE],
    );
    result.lotsCreated = lots.rowCount ?? 0;

    const candidates = await conn.query<{
      batch_id: string;
      product_id: string;
      remaining: string;
      lot_id: string;
      sell_oh: string;
      main_oh: string;
      total_oh: string;
    }>(
      `SELECT
         b.id AS batch_id,
         b.product_id,
         b.remaining_quantity::text AS remaining,
         pl.id AS lot_id,
         COALESCE((
           SELECT SUM(ib.quantity_on_hand)
           FROM inventory_balances ib
           WHERE ib.product_lot_id = pl.id AND ib.store_location_id = $1
         ), 0)::text AS sell_oh,
         COALESCE((
           SELECT SUM(ib.quantity_on_hand)
           FROM inventory_balances ib
           WHERE ib.product_lot_id = pl.id AND ib.store_location_id = $2
         ), 0)::text AS main_oh,
         COALESCE((
           SELECT SUM(ib.quantity_on_hand)
           FROM inventory_balances ib
           WHERE ib.product_lot_id = pl.id
         ), 0)::text AS total_oh
       FROM inventory_batches b
       JOIN products p ON p.id = b.product_id
       JOIN product_lots pl ON pl.inventory_batch_id = b.id
       WHERE b.status = 'ACTIVE'
         AND b.remaining_quantity > $3
         AND p.is_active = true
         AND COALESCE(p.product_type, 'product') <> 'service'`,
      [selling.id, main?.id ?? selling.id, POS_SELLABLE_TOLERANCE],
    );

    for (const row of candidates.rows) {
      result.batchesProcessed += 1;
      const remaining = parseFloat(row.remaining);
      const sellOh = parseFloat(row.sell_oh);
      const mainOh = parseFloat(row.main_oh);
      const totalOh = parseFloat(row.total_oh);

      if (sellOh > POS_SELLABLE_TOLERANCE) {
        continue;
      }

      if (main?.id && mainOh > POS_SELLABLE_TOLERANCE) {
        await warehouseInventoryRepository.moveLotQuantityBetweenStores(conn as PoolClient, {
          fromStoreId: main.id,
          toStoreId: selling.id,
          productId: row.product_id,
          productLotId: row.lot_id,
          quantity: mainOh,
          trackTransferMetrics: false,
        });
        result.unitsMovedMainToSelling += mainOh;
        continue;
      }

      if (totalOh <= POS_SELLABLE_TOLERANCE) {
        await warehouseInventoryRepository.incrementBalanceAtStore(conn as PoolClient, {
          storeLocationId: selling.id,
          productId: row.product_id,
          productLotId: row.lot_id,
          quantity: remaining,
        });
        result.balancesSeeded += 1;
        result.unitsSeededOnSelling += remaining;
      }
    }

    try {
      // INV-002: snap store balances to batch economic qty, then assert (+ POS coverage).
      const { healed } = await healAndAssertWarehouseLayer(
        conn as PoolClient,
        'multistore-sellable-backfill',
      );
      result.batchesHealed = healed;
      await assertPosSellableCoverageConsistent(conn, 'multistore-sellable-backfill');
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : String(err);
      const message = raw.replace(/\s*Transaction rolled back\.?/i, '').trim();
      if (!options.softAssert) {
        throw err;
      }
      result.warnings = result.warnings ?? [];
      result.warnings.push(message);
      logger.warn(
        'Multistore sellable backfill soft-assert: enable proceeds after heal attempt',
        {
          warning: message,
          lotsCreated: result.lotsCreated,
          balancesSeeded: result.balancesSeeded,
          unitsMovedMainToSelling: result.unitsMovedMainToSelling,
          unitsSeededOnSelling: result.unitsSeededOnSelling,
          batchesProcessed: result.batchesProcessed,
          batchesHealed: result.batchesHealed,
        },
      );
    }

    logger.info('Multistore POS sellable backfill complete', result);
    return result;
  },
};
