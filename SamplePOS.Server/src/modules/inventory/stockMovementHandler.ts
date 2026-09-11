/**
 * @module StockMovementHandler
 * @description Centralized handler for stock modifications (adjustments, issues, simple inbound).
 * @architecture
 *   - ADJUSTMENT_*, DAMAGE, EXPIRY, SALE, TRANSFER_* → this handler (batch + audit + GL where applicable)
 *   - Lot-based goods receipt (GRN finalize) → goodsReceiptService.finalizeGR + LotService.receiveLot
 *     (creates per-lot batches, expiry, bonus splits, and multistore inventory_balances)
 * @rules
 *   - ALL stock changes must go through this handler
 *   - Enforces business rules consistently
 *   - Creates complete audit trail
 *   - Handles batch selection (FEFO)
 *   - Validates quantities and prevents negative stock
 *   - Recalculates inventory values
 */

import { Pool, PoolClient } from 'pg';
import Decimal from 'decimal.js';
import { InventoryBusinessRules } from '../../middleware/businessRules.js';
import { ValidationError, BusinessError } from '../../middleware/errorHandler.js';
import * as glEntryService from '../../services/glEntryService.js';
import * as costLayerService from '../../services/costLayerService.js';
import * as masterDataGuard from '../../services/masterDataGuard.js';
import logger from '../../utils/logger.js';
import { getBusinessDate } from '../../utils/dateRange.js';
import { allocateNextMovementNumber } from '../../utils/documentNumberAllocation.js';
import { syncProductQuantity } from '../../utils/inventorySync.js';
import {
  assertInventoryCouplingUnchanged,
  captureInventoryCoupling,
  INVENTORY_COUPLING_TOLERANCE,
  resolveGl1300FromBatchSubledgerDelta,
} from '../../services/inventorySubledgerCoupling.js';
import { Money } from '../../utils/money.js';
import { lotService } from '../inventory-lot/lotService.js';
import { postgresLotRepository } from '../inventory-lot/postgresLotRepository.js';
import { loadGlobalSelectableLots } from '../inventory-lot/postgresLotSelector.js';

export type StockMovementType =
  | 'GOODS_RECEIPT'
  | 'SALE'
  | 'ADJUSTMENT_IN'
  | 'ADJUSTMENT_OUT'
  | 'TRANSFER_IN'
  | 'TRANSFER_OUT'
  | 'RETURN'
  | 'DAMAGE'
  | 'EXPIRY'
  | 'PHYSICAL_COUNT';

/** Movement types that require GL journal entries (SAP/Odoo pattern) */
const GL_MOVEMENT_TYPES: ReadonlySet<StockMovementType> = new Set([
  'ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'DAMAGE', 'EXPIRY',
]);

export interface StockMovementParams {
  productId: string;
  batchId?: string | null;
  movementType: StockMovementType;
  quantity: number; // Always positive - direction determined by movementType
  unitCost?: number;
  referenceType?: string | null;
  referenceId?: string | null;
  reason?: string | null;
  notes?: string | null;
  userId: string;
  // Optional: for multi-warehouse support (future)
  warehouseId?: string | null;
  // Optional: explicit multistore destination for inbound lot returns/adjustments
  targetStoreLocationId?: string | null;
  /** Multistore: source store for outbound consume (ADJUSTMENT_OUT / WRITE_OFF / disposal) */
  sourceStoreLocationId?: string | null;
  /**
   * Legacy: caller already decremented inventory_balances.
   * Prefer sourceStoreLocationId / default cross-store deduct instead.
   */
  balancesAlreadyAdjusted?: boolean;
  // Optional: for UOM conversions (future)
  uomId?: string | null;
  conversionFactor?: number;
  /** ADR-004: override expense account (5110/5120/5130) for LOSS_DISPOSAL */
  expenseAccountCode?: string | null;
  /** ADR-004 Phase 2C: allow QUARANTINED/EXPIRED batch consume */
  allowDisposalStatuses?: boolean;
}

export interface StockMovementResult {
  movementId: string;
  movementNumber: string;
  batchId: string;
  previousQuantity: number;
  newQuantity: number;
  actualQuantityChanged: number;
  valueBefore: number;
  valueAfter: number;
}

/**
 * Unified Stock Movement Handler
 * All inventory changes MUST go through this service
 */
export class StockMovementHandler {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * Process a stock movement transaction
   * This is the SINGLE authoritative entry point for stock changes
   *
   * @param params Movement parameters
   * @param txClient Optional external PoolClient for joining an existing transaction.
   *                 When provided, the handler skips BEGIN/COMMIT/ROLLBACK and
   *                 participates in the caller's transaction boundary.
   */
  async processMovement(params: StockMovementParams, txClient?: PoolClient): Promise<StockMovementResult> {
    const ownConnection = !txClient;
    const client = txClient ?? await this.pool.connect();

    try {
      if (ownConnection) {
        await client.query('BEGIN');
      }

      // Suppress the inventory_batches trigger that auto-creates SM- stock_movements
      // This handler already creates proper MOV- movements in Step 9
      await client.query("SET LOCAL app.skip_stock_movement_trigger = 'true'");

      // Step 1: Validate parameters
      this.validateMovementParams(params);

      // MASTER DATA GUARD (Rule 1): Block movements when item has no cost configured
      // Exempt: GOODS_RECEIPT (establishes cost), SALE (validated via cost layers),
      //         TRANSFER_IN/OUT, RETURN (batch already carries cost)
      const COST_GUARD_MOVEMENT_TYPES: ReadonlySet<StockMovementType> = new Set([
        'ADJUSTMENT_OUT', 'DAMAGE', 'EXPIRY', 'PHYSICAL_COUNT',
      ]);
      if (COST_GUARD_MOVEMENT_TYPES.has(params.movementType)) {
        await masterDataGuard.assertItemHasCost(client, params.productId);
      }
      // ADJUSTMENT_IN specifically: require caller-supplied unitCost > 0 to prevent
      // zero-cost stock from being created via manual adjustments.
      if (params.movementType === 'ADJUSTMENT_IN' && (!params.unitCost || params.unitCost <= 0)) {
        throw new ValidationError(
          '[MDG-001b] unitCost is required for ADJUSTMENT_IN. ' +
          'Provide a cost > 0 to prevent introducing zero-cost stock. ' +
          'If this is opening stock, use the Opening Stock with Valuation feature instead.',
        );
      }

      // Step 2: Determine if this is an IN or OUT movement
      const isInbound = this.isInboundMovement(params.movementType);
      const quantityChange = isInbound ? params.quantity : -params.quantity;

      const inventoryCouplingBefore =
        GL_MOVEMENT_TYPES.has(params.movementType)
          ? await captureInventoryCoupling(client)
          : null;

      // Step 3: Get or select batch
      const batch = await this.resolveBatch(client, params);

      // Step 4: Calculate new quantity
      const previousQty = new Decimal(batch.remaining_quantity);
      const changeQty = new Decimal(quantityChange);
      const newQty = previousQty.plus(changeQty);

      // Step 5: Validate resulting quantity
      await this.validateResultingQuantity(client, newQty, batch.product_id, previousQty, params.quantity);

      const absQtyDec = Money.parseDb(Math.abs(quantityChange));
      const unitCostDec = Money.parseDb(params.unitCost ?? batch.cost_price ?? 0);

      // Step 6: Mutate lot quantity through LotService gateway
      if (changeQty.gt(0)) {
        await lotService.returnLot(client, {
          productId: params.productId,
          batchId: batch.id,
          quantity: absQtyDec.toNumber(),
          costPrice: Money.toNumber(unitCostDec),
          referenceType: params.referenceType || params.movementType,
          referenceId: params.referenceId || batch.id,
          notes: params.reason || params.notes || undefined,
          targetStoreLocationId: params.targetStoreLocationId ?? undefined,
          userId: params.userId,
        });
      } else if (changeQty.lt(0)) {
        // INV-002 dual-write: pass source store, or let consumeLot deduct across all stores.
        await lotService.consumeLot(client, {
          productId: params.productId,
          quantity: absQtyDec.toNumber(),
          specificLotId: batch.id,
          selectionPolicy: 'MANUAL',
          storeLocationId: params.sourceStoreLocationId ?? undefined,
          skipStoreBalanceDeduction: params.balancesAlreadyAdjusted === true,
          recordMovement: false,
          syncProduct: false,
          referenceType: params.referenceType || params.movementType,
          referenceId: params.referenceId || batch.id,
          userId: params.userId,
          allowDisposalStatuses: params.allowDisposalStatuses === true,
        });
      }

      // Step 7: GL amount from batch subledger delta (SAP MM-FI — same SQL as coupling guard)
      let movementValueDec = Money.multiply(unitCostDec, absQtyDec);
      if (inventoryCouplingBefore) {
        const couplingAfterBatch = await captureInventoryCoupling(client);
        const subledgerAmount = resolveGl1300FromBatchSubledgerDelta(
          inventoryCouplingBefore,
          couplingAfterBatch,
          isInbound ? 'receipt' : 'issue',
        );
        if (subledgerAmount > 0) {
          movementValueDec = Money.parseDb(subledgerAmount);
        }
      }

      if (
        !isInbound &&
        GL_MOVEMENT_TYPES.has(params.movementType) &&
        unitCostDec.lte(INVENTORY_COUPLING_TOLERANCE)
      ) {
        const pvRow = await client.query(
          `SELECT cost_price FROM product_valuation WHERE product_id = $1`,
          [params.productId],
        );
        const pvCost = Money.parseDb(pvRow.rows[0]?.cost_price ?? 0);
        throw new BusinessError(
          `Batch ${batch.batch_number} has no unit cost; cannot post a valued stock reduction. ` +
            (pvCost.gt(INVENTORY_COUPLING_TOLERANCE)
              ? `Product valuation is ${Money.format(pvCost)} — use Repair Valuation on the batch or select a batch with cost.`
              : 'Set product cost via goods receipt or opening stock first.'),
          'ERR_INVENTORY_BATCH_NO_COST',
          {
            batchId: batch.id,
            batchNumber: batch.batch_number,
            productValuationCost: Money.toNumber(pvCost),
          },
        );
      }

      const unitCost = Money.toNumber(unitCostDec);
      let movementValue = Money.toNumber(movementValueDec);

      // Step 8: Generate movement number
      const movementNumber = await this.generateMovementNumber(client);

      // Step 9: Record stock movement in audit trail
      // ADR-004: GL-bearing adjustment types are LOSS_DISPOSAL (or OTHER for IN)
      const economicEvent =
        params.movementType === 'ADJUSTMENT_IN'
          ? 'OTHER'
          : GL_MOVEMENT_TYPES.has(params.movementType)
            ? 'LOSS_DISPOSAL'
            : 'OTHER';
      const postsGl = GL_MOVEMENT_TYPES.has(params.movementType);
      const movementResult = await client.query(
        `INSERT INTO stock_movements (
          movement_number, product_id, batch_id, movement_type, quantity,
          unit_cost, reference_type, reference_id, notes, created_by_id,
          economic_event, posts_gl
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING id, movement_number`,
        [
          movementNumber,
          params.productId,
          batch.id,
          params.movementType,
          Math.abs(quantityChange),
          unitCost,
          params.referenceType || null,
          params.referenceId || null,
          params.reason || params.notes || null,
          params.userId,
          economicEvent,
          postsGl,
        ]
      );

      // Step 10: Sync cost_layers to match batch/GL changes
      // ADJUSTMENT_IN → create a new cost layer
      // ADJUSTMENT_OUT/DAMAGE/EXPIRY → consume cost layers FIFO
      if (GL_MOVEMENT_TYPES.has(params.movementType)) {
        const absQty = Money.toNumber(absQtyDec);
        if (isInbound) {
          // Create a cost layer for the incoming stock
          await costLayerService.createCostLayer(
            {
              productId: params.productId,
              quantity: absQty,
              unitCost: unitCost,
              batchNumber: batch.batch_number || undefined,
            },
            undefined,
            client
          );
          logger.info('Cost layer created for stock adjustment', {
            productId: params.productId,
            quantity: absQty,
            unitCost,
            movementType: params.movementType,
          });
        } else {
          // Consume cost layers FIFO (economic layers); GL amount stays on batch cost for coupling.
          const fifoConsumed = await this.consumeCostLayersFIFO(client, params.productId, absQty);
          if (
            fifoConsumed.gt(0) &&
            Money.abs(fifoConsumed.minus(movementValueDec)).gt(INVENTORY_COUPLING_TOLERANCE)
          ) {
            logger.warn('[StockMovement] FIFO layer cost differs from batch cost — using batch cost for GL', {
              productId: params.productId,
              batchId: batch.id,
              batchCostTotal: Money.toNumber(movementValueDec),
              fifoConsumed: Money.toNumber(fifoConsumed),
              movementType: params.movementType,
            });
          }
        }
      }

      // Step 11: Update product quantity_on_hand (aggregate from batches)
      await this.updateProductQuantity(client, params.productId);

      // Step 12: Post GL journal entry for adjustment/damage/expiry movements
      // INSIDE transaction (SAP LUW pattern — same as GRN).
      // Inventory batch update + GL entry commit atomically.
      // If GL fails → full rollback → no phantom inventory without GL backing.
      if (GL_MOVEMENT_TYPES.has(params.movementType)) {
        movementValue = Money.toNumber(movementValueDec);
        if (movementValueDec.gt(INVENTORY_COUPLING_TOLERANCE)) {
          const prodRes = await client.query('SELECT name FROM products WHERE id = $1', [params.productId]);
          const productName = prodRes.rows[0]?.name || 'Unknown';

          await glEntryService.recordStockMovementToGL({
            movementId: movementResult.rows[0].id,
            movementNumber: movementResult.rows[0].movement_number,
            movementDate: getBusinessDate(),
            movementType: params.movementType as 'ADJUSTMENT_IN' | 'ADJUSTMENT_OUT' | 'DAMAGE' | 'EXPIRY',
            movementValue,
            productName,
            expenseAccountCode: params.expenseAccountCode ?? undefined,
          }, undefined, client);  // pass client → atomic with inventory
        } else if (
          !isInbound &&
          absQtyDec.gt(0) &&
          unitCostDec.gt(INVENTORY_COUPLING_TOLERANCE)
        ) {
          throw new BusinessError(
            'Inventory GL entry was not created for this stock reduction. Transaction rolled back.',
            'ERR_INVENTORY_ADJUST_NO_COST',
            {
              batchId: batch.id,
              unitCost,
              quantity: Money.toNumber(absQtyDec),
              movementValue,
            },
          );
        }

        if (inventoryCouplingBefore) {
          assertInventoryCouplingUnchanged(
            inventoryCouplingBefore,
            await captureInventoryCoupling(client),
            `stock movement ${movementResult.rows[0].movement_number}`,
          );
        }
      }

      if (ownConnection) {
        await client.query('COMMIT');
      }

      logger.info('Stock movement processed successfully', {
        movementId: movementResult.rows[0].id,
        movementNumber: movementResult.rows[0].movement_number,
        productId: params.productId,
        batchId: batch.id,
        movementType: params.movementType,
        quantityChange: changeQty.toString(),
        previousQty: previousQty.toString(),
        newQty: newQty.toString(),
      });

      return {
        movementId: movementResult.rows[0].id,
        movementNumber: movementResult.rows[0].movement_number,
        batchId: batch.id,
        previousQuantity: previousQty.toNumber(),
        newQuantity: newQty.toNumber(),
        actualQuantityChanged: changeQty.toNumber(),
        valueBefore: previousQty.times(unitCost).toNumber(),
        valueAfter: newQty.times(unitCost).toNumber(),
      };
    } catch (error) {
      if (ownConnection) {
        await client.query('ROLLBACK');
      }
      logger.error('Stock movement failed', {
        productId: params.productId,
        movementType: params.movementType,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      if (ownConnection) {
        client.release();
      }
    }
  }

  /**
   * Validate movement parameters
   */
  private validateMovementParams(params: StockMovementParams): void {
    // Quantity must be positive (direction is determined by movementType)
    if (params.quantity <= 0) {
      throw new Error('Quantity must be greater than zero');
    }

    // Reason required for adjustments and corrections
    if (
      ['ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'DAMAGE', 'EXPIRY', 'PHYSICAL_COUNT'].includes(
        params.movementType
      )
    ) {
      if (!params.reason || params.reason.trim().length < 5) {
        throw new Error('Reason must be at least 5 characters for this movement type');
      }
    }

    // User ID required for audit trail
    if (!params.userId) {
      throw new Error('User ID is required for stock movements');
    }
  }

  /**
   * Determine if movement type is inbound (increases stock)
   */
  private isInboundMovement(type: StockMovementType): boolean {
    return ['GOODS_RECEIPT', 'ADJUSTMENT_IN', 'TRANSFER_IN', 'RETURN'].includes(type);
  }

  /**
   * Resolve batch for the movement
   * - If batchId provided, validate and use it
   * - If not provided, find or create default MAIN batch
   * - For FEFO movements (sales), select appropriate batch
   */
  private async resolveBatch(
    client: PoolClient,
    params: StockMovementParams
  ): Promise<{
    id: string;
    product_id: string;
    batch_number: string;
    remaining_quantity: number;
    cost_price: number | null;
  }> {
    if (params.batchId) {
      // Validate provided batch exists — lock row to prevent concurrent modification
      // Cast status to text so DB enums without BLOCKED still accept disposal statuses.
      const statusClause = params.allowDisposalStatuses
        ? `COALESCE(status::text, 'ACTIVE') IN ('ACTIVE', 'QUARANTINED', 'EXPIRED', 'BLOCKED')`
        : `COALESCE(status::text, 'ACTIVE') = 'ACTIVE'`;
      const result = await client.query(
        `SELECT id, product_id, batch_number, remaining_quantity, cost_price 
         FROM inventory_batches 
         WHERE id = $1 AND ${statusClause}
         FOR UPDATE`,
        [params.batchId]
      );

      if (result.rows.length === 0) {
        throw new Error(`Batch ${params.batchId} not found or inactive`);
      }

      // Verify batch belongs to the product
      if (result.rows[0].product_id !== params.productId) {
        throw new Error(`Batch ${params.batchId} does not belong to product ${params.productId}`);
      }

      return result.rows[0];
    }

    // No batchId provided
    const isOutbound = ['ADJUSTMENT_OUT', 'DAMAGE', 'EXPIRY', 'SALE', 'TRANSFER_OUT'].includes(params.movementType);
    const isInbound = !isOutbound;

    if (isOutbound) {
      const lots = await loadGlobalSelectableLots(client, params.productId, { forUpdate: true });
      if (lots.length > 0) {
        const first = lots[0];
        return {
          id: first.lotId,
          product_id: params.productId,
          batch_number: first.lotNumber,
          remaining_quantity: first.remainingQuantity,
          cost_price: first.costPrice,
        };
      }
    }

    // For inbound movements (or outbound with zero stock), find or create MAIN batch
    // Look for MAIN batch regardless of status — reactivate DEPLETED batches for inbound
    let result = await client.query(
      `SELECT id, product_id, batch_number, remaining_quantity, cost_price, status 
       FROM inventory_batches 
       WHERE product_id = $1 AND batch_number = 'MAIN'
       ORDER BY received_date DESC 
       LIMIT 1
       FOR UPDATE`,
      [params.productId]
    );

    if (result.rows.length > 0) {
      const batch = result.rows[0];
      if (batch.status !== 'ACTIVE' && isInbound) {
        await postgresLotRepository.reactivateMasterBatch(client, batch.id);
        logger.info('Reactivated DEPLETED MAIN batch for inbound movement', {
          productId: params.productId,
          batchId: batch.id,
        });
        return {
          id: batch.id,
          product_id: batch.product_id,
          batch_number: batch.batch_number,
          remaining_quantity: batch.remaining_quantity,
          cost_price: batch.cost_price,
        };
      } else if (batch.status === 'ACTIVE') {
        return {
          id: batch.id,
          product_id: batch.product_id,
          batch_number: batch.batch_number,
          remaining_quantity: batch.remaining_quantity,
          cost_price: batch.cost_price,
        };
      }
    }

    const product = await client.query(
      'SELECT p.name, pv.cost_price FROM products p LEFT JOIN product_valuation pv ON pv.product_id = p.id WHERE p.id = $1',
      [params.productId]
    );

    if (product.rows.length === 0) {
      throw new Error(`Product ${params.productId} not found`);
    }

    const costPrice = product.rows[0].cost_price || 0;
    const mainLot = await postgresLotRepository.ensureMainBatch(client, params.productId, costPrice);

    logger.info('Created/reactivated MAIN batch for product', {
      productId: params.productId,
      batchId: mainLot.id,
    });

    return {
      id: mainLot.id,
      product_id: mainLot.productId,
      batch_number: mainLot.lotNumber,
      remaining_quantity: mainLot.remainingQuantity,
      cost_price: mainLot.costPrice,
    };
  }

  /**
   * Validate resulting quantity after movement
   * Prevents negative stock unless system config allows it
   */
  private async validateResultingQuantity(
    client: PoolClient,
    newQuantity: Decimal,
    productId: string,
    previousQuantity?: Decimal,
    requestedQty?: number
  ): Promise<void> {
    if (newQuantity.lessThan(0)) {
      const remaining = previousQuantity?.toNumber() ?? 0;
      const requested = requestedQty ?? 0;
      throw new BusinessError(
        `Insufficient stock. Batch has ${remaining} unit(s) remaining but ${requested} unit(s) were requested.`,
        'INSUFFICIENT_BATCH_QTY',
        { productId, remaining, requested }
      );
    }

    // BR-INV-002: Log positive quantity validation
    if (newQuantity.greaterThanOrEqualTo(0)) {
      logger.info('BR-INV-002: Positive quantity validation passed', {
        productId,
        resultingQuantity: newQuantity.toString(),
      });
    }
  }

  /**
   * Generate sequential movement number — doc_movement_number_seq SSOT.
   * Format: MOV-YYYY-####
   */
  private async generateMovementNumber(client: PoolClient): Promise<string> {
    return allocateNextMovementNumber(client);
  }

  /**
   * Consume cost layers in FIFO order for outbound stock adjustments.
   * Decrements remaining_quantity and deactivates fully depleted layers.
   * Tolerates insufficient layers (logs warning, consumes what exists).
   */
  private async consumeCostLayersFIFO(
    client: PoolClient,
    productId: string,
    quantity: number
  ): Promise<Decimal> {
    const result = await client.query(
      `SELECT id, remaining_quantity, unit_cost
       FROM cost_layers
       WHERE product_id = $1 AND is_active = TRUE AND remaining_quantity > 0
       ORDER BY received_date ASC, created_at ASC
       FOR UPDATE`,
      [productId]
    );

    let remaining = new Decimal(quantity);
    let consumedValue = new Decimal(0);

    for (const layer of result.rows) {
      if (remaining.lte(0)) break;

      const available = new Decimal(layer.remaining_quantity);
      const consume = Decimal.min(remaining, available);
      const layerUnitCost = new Decimal(layer.unit_cost);
      consumedValue = consumedValue.plus(consume.times(layerUnitCost));
      const newQty = available.minus(consume);

      await client.query(
        `UPDATE cost_layers
         SET remaining_quantity = $1::numeric,
             is_active = CASE WHEN $1::numeric <= 0 THEN false ELSE is_active END,
             updated_at = NOW()
         WHERE id = $2`,
        [newQty.toFixed(4), layer.id]
      );

      remaining = remaining.minus(consume);
    }

    if (remaining.gt(0)) {
      logger.warn('Insufficient cost layers for FIFO consumption (stock adjustment)', {
        productId,
        requested: quantity,
        shortfall: remaining.toNumber(),
      });
    }

    // Recalculate average cost after consumption
    await costLayerService.updateAverageCost(productId, client);
    return consumedValue;
  }

  /**
   * Update product quantity_on_hand from batch aggregation.
   * Delegates to the shared syncProductQuantity() — single source of truth.
   */
  private async updateProductQuantity(client: PoolClient, productId: string): Promise<void> {
    await syncProductQuantity(client, productId);
  }
}
