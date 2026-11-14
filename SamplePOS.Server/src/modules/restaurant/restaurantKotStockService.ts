/**
 * SambaPOS-style restaurant KOT stock (restaurant channel only).
 *
 * Fire KOT → FEFO deduct inventory/consumable (and AT_SALE recipe ingredients).
 * Void sent qty → restore from those movements.
 * createSale → skip physical deduct when net KOT issue covers the line; attribute COGS from KOT cost.
 *
 * Movements: ADJUSTMENT_OUT / ADJUSTMENT_IN with reference_type RESTAURANT_KOT / RESTAURANT_KOT_VOID
 * (reuse enum; notes identify kitchen issue). reference_id = pos_order_items.id.
 */

import type { Pool, PoolClient } from 'pg';

type DbConn = Pool | PoolClient;
import Decimal from 'decimal.js';
import { BusinessError } from '../../middleware/errorHandler.js';
import { Money } from '../../utils/money.js';
import { getBusinessDate } from '../../utils/dateRange.js';
import { syncProductQuantity } from '../../utils/inventorySync.js';
import { allocateNextMovementNumber } from '../../utils/documentNumberAllocation.js';
import { resolveSaleItemUom } from '../products/uomService.js';
import { explodeActiveRecipe } from '../sales/saleRecipeExplosion.js';
import { planSaleStockDeduction } from '../../../../shared/utils/productTypeRules.js';
import {
  RESTAURANT_KOT_REFERENCE_TYPE,
  RESTAURANT_KOT_VOID_REFERENCE_TYPE,
  shouldDeductStockOnRestaurantKot,
} from '../../../../shared/restaurant/restaurantKotStockPolicy.js';
import { isMultistoreEnabled } from '../inventory/warehouse/multistoreSettings.js';
import { warehouseSaleDeductionService } from '../inventory/warehouse/warehouseSaleDeductionService.js';
import { lotService } from '../inventory-lot/lotService.js';
import { loadGlobalSelectableLots } from '../inventory-lot/postgresLotSelector.js';
import { selectLots } from '@shared/inventory-lot/index.js';
import { getProductMinDaysBeforeExpirySale } from '../products/productExpirySaleDays.js';
import { isRestaurantAllowOversellEnabled } from './restaurantSettings.js';
import logger from '../../utils/logger.js';

export interface KotStockIssueLine {
  orderItemId: string;
  productId: string | null;
  productName: string;
  quantity: number;
  uomId?: string | null;
}

export interface KotStockNetIssue {
  orderItemId: string;
  netQty: number;
  netCost: number;
  issued: boolean;
}

async function insertAdjMovement(
  client: PoolClient,
  params: {
    productId: string;
    batchId: string;
    quantity: Decimal;
    unitCost: number;
    movementType: 'ADJUSTMENT_OUT' | 'ADJUSTMENT_IN';
    referenceType: string;
    referenceId: string;
    notes: string;
    userId: string | null;
    enteredQty?: number;
    baseUomId?: string;
    conversionFactor?: string;
  },
): Promise<void> {
  const movementNumber = await allocateNextMovementNumber(client);
  await client.query(
    `INSERT INTO stock_movements (
       movement_number, product_id, batch_id, movement_type, quantity, unit_cost,
       reference_type, reference_id, notes, created_by_id,
       entered_qty, base_uom_id, conversion_factor
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      movementNumber,
      params.productId,
      params.batchId,
      params.movementType,
      params.quantity.abs().toFixed(4),
      params.unitCost,
      params.referenceType,
      params.referenceId,
      params.notes,
      params.userId,
      params.enteredQty ?? null,
      params.baseUomId ?? null,
      params.conversionFactor ?? null,
    ],
  );
}

async function deductTarget(
  client: PoolClient,
  params: {
    productId: string;
    productName: string;
    baseQty: Decimal;
    enteredQty: number;
    baseUomId: string;
    conversionFactor: Decimal;
    orderItemId: string;
    orderId: string;
    userId: string;
    sellingStoreId: string | null;
    multistore: boolean;
    parentName?: string;
  },
): Promise<Decimal> {
  const notes = params.parentName
    ? `Restaurant KOT ${params.orderId} — recipe ingredient for ${params.parentName}`
    : `Restaurant KOT ${params.orderId} — kitchen issue`;

  if (params.multistore && params.sellingStoreId) {
    const result = await warehouseSaleDeductionService.deductAtStore(client, {
      storeLocationId: params.sellingStoreId,
      productId: params.productId,
      productName: params.productName,
      baseQty: params.baseQty,
      movementType: 'ADJUSTMENT_OUT',
      referenceType: RESTAURANT_KOT_REFERENCE_TYPE,
      referenceId: params.orderItemId,
      notes,
      userId: params.userId,
      enteredQty: params.enteredQty,
      baseUomId: params.baseUomId,
      conversionFactor: params.conversionFactor.toFixed(6),
    });
    return result.actualBatchCost;
  }

  const minDaysBeforeExpiry = await getProductMinDaysBeforeExpirySale(client, params.productId);
  const selectableLots = await loadGlobalSelectableLots(client, params.productId, {
    forUpdate: true,
    minDaysBeforeExpiry,
  });
  const plan = selectLots({
    policy: 'FEFO',
    lots: selectableLots,
    quantity: params.baseQty.toNumber(),
    businessDate: getBusinessDate(),
    minDaysBeforeExpirySale: minDaysBeforeExpiry,
  });

  if (plan.shortfall > 0.001) {
    throw new BusinessError(
      `Not enough stock for "${params.productName}"` +
        (params.parentName ? ` (recipe ingredient for "${params.parentName}")` : '') +
        `. Requested: ${params.baseQty.toFixed(2)}, Available: ${plan.totalAllocated.toFixed(2)}.`,
      'ERR_STOCK_001',
      {
        product: params.productName,
        productId: params.productId,
        requested: Money.toNumber(params.baseQty),
        available: plan.totalAllocated,
        shortBy: plan.shortfall,
      },
    );
  }

  const consumeResult = await lotService.consumeLot(client, {
    productId: params.productId,
    quantity: params.baseQty.toNumber(),
    selectionPolicy: 'FEFO',
    minDaysBeforeExpiry,
    referenceType: RESTAURANT_KOT_REFERENCE_TYPE,
    referenceId: params.orderItemId,
    userId: params.userId,
    productName: params.productName,
    recordMovement: false,
    syncProduct: false,
  });

  for (const layer of consumeResult.layers) {
    await insertAdjMovement(client, {
      productId: params.productId,
      batchId: layer.lotId,
      quantity: new Decimal(layer.quantity),
      unitCost: layer.costPrice,
      movementType: 'ADJUSTMENT_OUT',
      referenceType: RESTAURANT_KOT_REFERENCE_TYPE,
      referenceId: params.orderItemId,
      notes,
      userId: params.userId,
      enteredQty: params.enteredQty,
      baseUomId: params.baseUomId,
      conversionFactor: params.conversionFactor.toFixed(6),
    });
  }

  await syncProductQuantity(client, params.productId);
  return Money.parseDb(consumeResult.totalCost);
}

/**
 * Deduct inventory for newly fired KOT lines. Idempotent per order_item_id:
 * if a RESTAURANT_KOT ADJUSTMENT_OUT already exists, skip.
 * When allow_oversell is ON and stock is short, skip deduct (pay will enforce).
 */
export async function issueStockOnRestaurantKot(
  client: PoolClient,
  params: {
    orderId: string;
    firedBy: string;
    lines: KotStockIssueLine[];
  },
): Promise<{ issuedItemIds: string[]; skippedOversellItemIds: string[] }> {
  const allowOversell = await isRestaurantAllowOversellEnabled(client);
  const multistore = await isMultistoreEnabled(client);
  let sellingStoreId: string | null = null;
  if (multistore) {
    sellingStoreId = await warehouseSaleDeductionService.resolveSellingStoreId(client);
  }

  const issuedItemIds: string[] = [];
  const skippedOversellItemIds: string[] = [];

  for (const line of params.lines) {
    if (!line.productId || line.productId.startsWith('custom_')) continue;
    if (!(line.quantity > 0)) continue;

    const existing = await client.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM stock_movements
       WHERE reference_type = $1 AND reference_id = $2 AND movement_type = 'ADJUSTMENT_OUT'`,
      [RESTAURANT_KOT_REFERENCE_TYPE, line.orderItemId],
    );
    if (Number(existing.rows[0]?.n || 0) > 0) {
      issuedItemIds.push(line.orderItemId);
      continue;
    }

    const typeRes = await client.query<{ product_type: string }>(
      `SELECT COALESCE(product_type, 'inventory') AS product_type FROM products WHERE id = $1`,
      [line.productId],
    );
    const productType = String(typeRes.rows[0]?.product_type || 'inventory');
    if (!shouldDeductStockOnRestaurantKot(productType)) continue;

    const uom = await resolveSaleItemUom(
      line.productId,
      { quantity: line.quantity, uomId: line.uomId },
      client,
    );
    const recipeLines = await explodeActiveRecipe(
      client,
      line.productId,
      new Decimal(uom.baseQuantity),
    );
    const deductPlan = planSaleStockDeduction(productType, Boolean(recipeLines?.length));
    if (deductPlan.kind === 'skip') continue;

    type Target = {
      productId: string;
      productName: string;
      baseQty: Decimal;
      enteredQty: number;
      baseUomId: string;
      conversionFactor: Decimal;
      parentName?: string;
    };
    const targets: Target[] = [];

    if (deductPlan.kind === 'ingredients' && recipeLines?.length) {
      for (const rl of recipeLines) {
        const baseUomRes = await client.query<{ baseUomId: string | null }>(
          `SELECT p.base_uom_id AS "baseUomId" FROM products p WHERE p.id = $1`,
          [rl.componentProductId],
        );
        let baseUomId = baseUomRes.rows[0]?.baseUomId ?? null;
        if (!baseUomId) {
          const snap = await resolveSaleItemUom(rl.componentProductId, { quantity: 1 }, client);
          baseUomId = snap.baseUomId;
        }
        targets.push({
          productId: rl.componentProductId,
          productName: rl.componentName,
          baseQty: rl.baseQty,
          enteredQty: Number(rl.baseQty.toFixed(6)),
          baseUomId,
          conversionFactor: new Decimal(1),
          parentName: line.productName,
        });
      }
    } else {
      targets.push({
        productId: line.productId,
        productName: line.productName,
        baseQty: new Decimal(uom.baseQuantity),
        enteredQty: line.quantity,
        baseUomId: uom.baseUomId,
        conversionFactor: new Decimal(uom.conversionFactor),
      });
    }

    try {
      for (const target of targets) {
        await deductTarget(client, {
          ...target,
          orderItemId: line.orderItemId,
          orderId: params.orderId,
          userId: params.firedBy,
          sellingStoreId,
          multistore,
        });
      }
      issuedItemIds.push(line.orderItemId);
    } catch (err) {
      const isStock =
        err instanceof BusinessError &&
        (err.errorCode === 'ERR_STOCK_001' || err.errorCode === 'ERR_EXPIRY_001');
      if (isStock && allowOversell) {
        logger.warn('Restaurant KOT oversell: skipping stock deduct (pay will enforce)', {
          orderId: params.orderId,
          orderItemId: line.orderItemId,
          productId: line.productId,
          error: err instanceof Error ? err.message : String(err),
        });
        skippedOversellItemIds.push(line.orderItemId);
        continue;
      }
      throw err;
    }
  }

  return { issuedItemIds, skippedOversellItemIds };
}

async function listOpenKotIssueLayers(
  client: PoolClient,
  orderItemId: string,
): Promise<
  Array<{
    id: string;
    productId: string;
    batchId: string;
    quantity: number;
    unitCost: number;
    restored: number;
  }>
> {
  const result = await client.query<{
    id: string;
    product_id: string;
    batch_id: string;
    quantity: string;
    unit_cost: string;
  }>(
    `SELECT id, product_id, batch_id, quantity::text, unit_cost::text
     FROM stock_movements
     WHERE reference_type = $1
       AND reference_id = $2
       AND movement_type = 'ADJUSTMENT_OUT'
       AND batch_id IS NOT NULL
     ORDER BY created_at ASC, id ASC`,
    [RESTAURANT_KOT_REFERENCE_TYPE, orderItemId],
  );

  const restoredByKey = await client.query<{
    batch_id: string;
    product_id: string;
    qty: string;
  }>(
    `SELECT batch_id, product_id, COALESCE(SUM(quantity), 0)::text AS qty
     FROM stock_movements
     WHERE reference_type = $1
       AND reference_id = $2
       AND movement_type = 'ADJUSTMENT_IN'
       AND batch_id IS NOT NULL
     GROUP BY batch_id, product_id`,
    [RESTAURANT_KOT_VOID_REFERENCE_TYPE, orderItemId],
  );
  const restoredMap = new Map<string, number>();
  for (const row of restoredByKey.rows) {
    restoredMap.set(`${row.product_id}:${row.batch_id}`, Number(row.qty));
  }

  // Allocate restores FIFO against issue layers
  const layers: Array<{
    id: string;
    productId: string;
    batchId: string;
    quantity: number;
    unitCost: number;
    restored: number;
  }> = [];
  const remainingRestore = new Map(restoredMap);
  for (const row of result.rows) {
    if (!row.batch_id) continue;
    const key = `${row.product_id}:${row.batch_id}`;
    const qty = Number(row.quantity);
    const availRestore = remainingRestore.get(key) ?? 0;
    const applied = Math.min(qty, availRestore);
    if (availRestore > 0) {
      remainingRestore.set(key, availRestore - applied);
    }
    layers.push({
      id: row.id,
      productId: row.product_id,
      batchId: row.batch_id,
      quantity: qty,
      unitCost: Number(row.unit_cost),
      restored: applied,
    });
  }
  return layers;
}

/**
 * Restore stock for voided kitchen-sent qty (full or partial).
 * voidQuantity is the display/selling qty being removed from the check line.
 */
export async function restoreStockOnRestaurantKotVoid(
  client: PoolClient,
  params: {
    orderId: string;
    orderItemId: string;
    productId: string | null;
    productName: string;
    lineQuantity: number;
    voidQuantity: number;
    voidedBy: string;
    reason: string;
    uomId?: string | null;
  },
): Promise<void> {
  if (!params.productId || params.productId.startsWith('custom_')) return;
  if (!(params.voidQuantity > 0) || !(params.lineQuantity > 0)) return;

  const layers = await listOpenKotIssueLayers(client, params.orderItemId);
  const openQty = layers.reduce((s, l) => s + Math.max(0, l.quantity - l.restored), 0);
  if (openQty <= 1e-9) return;

  // Scale void display qty → fraction of open issued base qty
  const fraction = Math.min(1, params.voidQuantity / params.lineQuantity);
  let toRestore = new Decimal(openQty).times(fraction);
  if (toRestore.lte(0)) return;

  const multistore = await isMultistoreEnabled(client);
  let sellingStoreId: string | null = null;
  if (multistore) {
    try {
      sellingStoreId = await warehouseSaleDeductionService.resolveSellingStoreId(client);
    } catch {
      sellingStoreId = null;
    }
  }

  const touched = new Set<string>();

  // Restore LIFO (latest kitchen issue first)
  for (let i = layers.length - 1; i >= 0 && toRestore.gt(1e-9); i--) {
    const layer = layers[i]!;
    const open = new Decimal(Math.max(0, layer.quantity - layer.restored));
    if (open.lte(0)) continue;
    const qty = Decimal.min(open, toRestore);
    await lotService.returnLot(client, {
      productId: layer.productId,
      batchId: layer.batchId,
      quantity: qty.toNumber(),
      costPrice: layer.unitCost,
      targetStoreLocationId: sellingStoreId,
      referenceType: RESTAURANT_KOT_VOID_REFERENCE_TYPE,
      referenceId: params.orderItemId,
      notes: `Restaurant VOID KOT ${params.orderId}: ${params.reason}`,
      userId: params.voidedBy,
    });
    await insertAdjMovement(client, {
      productId: layer.productId,
      batchId: layer.batchId,
      quantity: qty,
      unitCost: layer.unitCost,
      movementType: 'ADJUSTMENT_IN',
      referenceType: RESTAURANT_KOT_VOID_REFERENCE_TYPE,
      referenceId: params.orderItemId,
      notes: `Restaurant VOID KOT ${params.orderId} — restore ${params.productName}: ${params.reason}`,
      userId: params.voidedBy,
    });
    touched.add(layer.productId);
    toRestore = toRestore.minus(qty);
  }

  for (const productId of touched) {
    await syncProductQuantity(client, productId);
  }
}

/** Net KOT-issued qty/cost still open for an order item (issues − voids). */
export async function getNetRestaurantKotIssue(
  client: PoolClient,
  orderItemId: string,
): Promise<KotStockNetIssue> {
  const result = await client.query<{ issued_qty: string; issued_cost: string; void_qty: string; void_cost: string }>(
    `SELECT
       COALESCE(SUM(CASE WHEN movement_type = 'ADJUSTMENT_OUT' AND reference_type = $2
                         THEN quantity ELSE 0 END), 0)::text AS issued_qty,
       COALESCE(SUM(CASE WHEN movement_type = 'ADJUSTMENT_OUT' AND reference_type = $2
                         THEN quantity * unit_cost ELSE 0 END), 0)::text AS issued_cost,
       COALESCE(SUM(CASE WHEN movement_type = 'ADJUSTMENT_IN' AND reference_type = $3
                         THEN quantity ELSE 0 END), 0)::text AS void_qty,
       COALESCE(SUM(CASE WHEN movement_type = 'ADJUSTMENT_IN' AND reference_type = $3
                         THEN quantity * unit_cost ELSE 0 END), 0)::text AS void_cost
     FROM stock_movements
     WHERE reference_id = $1
       AND reference_type IN ($2, $3)`,
    [orderItemId, RESTAURANT_KOT_REFERENCE_TYPE, RESTAURANT_KOT_VOID_REFERENCE_TYPE],
  );
  const row = result.rows[0];
  const issuedQty = Number(row?.issued_qty || 0);
  const voidQty = Number(row?.void_qty || 0);
  const netQty = Math.max(0, issuedQty - voidQty);
  const netCost = Math.max(0, Number(row?.issued_cost || 0) - Number(row?.void_cost || 0));
  return {
    orderItemId,
    netQty,
    netCost,
    issued: netQty > 1e-9,
  };
}

/** Ordered (kitchen-sent, open check) qty by product for menu paint. */
export async function loadRestaurantOrderedQtyByProduct(
  client: DbConn,
): Promise<Map<string, number>> {
  const result = await client.query<{ product_id: string; ordered_qty: string }>(
    `SELECT oi.product_id, COALESCE(SUM(oi.quantity), 0)::text AS ordered_qty
     FROM pos_order_items oi
     JOIN pos_orders o ON o.id = oi.order_id
     WHERE o.status = 'PENDING'
       AND oi.kitchen_sent_at IS NOT NULL
       AND oi.product_id IS NOT NULL
     GROUP BY oi.product_id`,
  );
  const map = new Map<string, number>();
  for (const row of result.rows) {
    map.set(row.product_id, Number(row.ordered_qty));
  }
  return map;
}
