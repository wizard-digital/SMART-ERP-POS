/**
 * Soft quarantine — single-store mode adapter (LQ13).
 * Status + audit only; never changes batch remaining or posts GL.
 */

import type { PoolClient } from 'pg';
import { UnitOfWork, type DbConnection } from '../../db/unitOfWork.js';
import { ValidationError, NotFoundError } from '../../middleware/errorHandler.js';
import { isMultistoreEnabled } from '../inventory/warehouse/multistoreSettings.js';
import { recordMovement } from '../stock-movements/stockMovementRepository.js';
import { lotService } from '../inventory-lot/lotService.js';
import {
  SOFT_QUARANTINE_REFERENCE_TYPE,
  LOT_SPLIT_REFERENCE_TYPE,
  softQuarantineStatusForReason,
  type SoftQuarantineReason,
} from '@shared/loss-quarantine/index.js';
import { publishNotificationEvent } from '../notifications/notificationPublisher.js';

export interface SoftQuarantineInput {
  inventoryBatchId: string;
  reason: SoftQuarantineReason;
  userId: string;
  memo?: string;
  /** Default SOFT_QUARANTINE; expiry job uses EXPIRY_AUTOMATION for repair/audit parity. */
  referenceType?: string;
  /** Optional audit link (e.g. ADJ_DOC document id). */
  referenceId?: string;
  /**
   * Partial qty (SAP/Odoo-style). When less than batch remaining, splits a child lot
   * then soft-quarantines only the child; parent stays ACTIVE/sellable.
   * Omit or equal remaining → full-batch soft quarantine (no split).
   */
  quantity?: number;
}

export interface SoftQuarantineResult {
  inventoryBatchId: string;
  productLotId: string | null;
  productId: string;
  statusApplied: string;
  quantityHeld: number;
  remainingUnchanged: number;
  movementId: string;
  movementNumber: string;
  quarantineMode: 'SOFT';
  /** Set when a partial split created the quarantined child */
  splitFromBatchId?: string | null;
  sellableRemainingOnParent?: number | null;
}

export async function applySoftQuarantine(
  conn: DbConnection,
  input: SoftQuarantineInput,
): Promise<SoftQuarantineResult> {
  if (await isMultistoreEnabled(conn)) {
    throw new ValidationError(
      'Soft quarantine is for single-store mode. Use expiry automation or DAMAGE transfer for multistore.',
    );
  }

  const quarantined = await UnitOfWork.runOrJoin(conn, async (client) => {
    let targetBatchId = input.inventoryBatchId;
    let splitFromBatchId: string | null = null;
    let sellableRemainingOnParent: number | null = null;

    const parentProbe = await client.query<{
      id: string;
      remaining_quantity: string;
      status: string;
    }>(
      `SELECT id, remaining_quantity::text, COALESCE(status::text, 'ACTIVE') AS status
       FROM inventory_batches
       WHERE id = $1
       FOR UPDATE`,
      [input.inventoryBatchId],
    );
    const parentRow = parentProbe.rows[0];
    if (!parentRow) throw new NotFoundError('Inventory batch not found');

    const parentRemaining = Number(parentRow.remaining_quantity);
    if (parentRemaining <= 0.0001) {
      throw new ValidationError('Batch has no remaining quantity to quarantine');
    }

    const requested =
      input.quantity != null && Number.isFinite(Number(input.quantity))
        ? Number(input.quantity)
        : parentRemaining;

    if (requested <= 0.0001) {
      throw new ValidationError('Quarantine quantity must be greater than zero');
    }
    if (requested - parentRemaining > 0.0001) {
      throw new ValidationError(
        `Cannot quarantine ${requested}: only ${parentRemaining} remaining on batch`,
      );
    }

    // Partial → split child (sellable parent stays ACTIVE), then quarantine child only.
    if (Math.abs(requested - parentRemaining) > 0.0001) {
      const split = await lotService.splitLot(client, {
        lotId: input.inventoryBatchId,
        quantity: requested,
        userId: input.userId,
        reason:
          input.memo?.trim() ||
          `Partial ${input.reason} soft quarantine (${requested} of ${parentRemaining})`,
        referenceType: LOT_SPLIT_REFERENCE_TYPE,
        referenceId: input.referenceId ?? input.inventoryBatchId,
      });
      targetBatchId = split.child.id;
      splitFromBatchId = split.parent.id;
      sellableRemainingOnParent = split.parent.remainingQuantity;
    }

    const batch = await client.query<{
      id: string;
      product_id: string;
      remaining_quantity: string;
      status: string;
      batch_number: string;
    }>(
      `SELECT id, product_id, remaining_quantity::text, COALESCE(status::text, 'ACTIVE') AS status, batch_number
       FROM inventory_batches
       WHERE id = $1
       FOR UPDATE`,
      [targetBatchId],
    );
    const row = batch.rows[0];
    if (!row) throw new NotFoundError('Inventory batch not found');

    const remaining = Number(row.remaining_quantity);
    if (remaining <= 0.0001) {
      throw new ValidationError('Batch has no remaining quantity to quarantine');
    }

    const current = String(row.status || 'ACTIVE').toUpperCase();
    const target = softQuarantineStatusForReason(input.reason);
    if (current === 'EXPIRED' || current === 'QUARANTINED') {
      throw new ValidationError(`Batch is already soft-quarantined (${current})`);
    }
    if (current !== 'ACTIVE' && current !== 'BLOCKED') {
      throw new ValidationError(`Cannot soft-quarantine batch in status ${current}`);
    }

    const lotRow = await client.query<{ id: string }>(
      `SELECT id FROM product_lots WHERE inventory_batch_id = $1 ORDER BY created_at ASC NULLS LAST LIMIT 1`,
      [targetBatchId],
    );
    const productLotId = lotRow.rows[0]?.id ?? null;

    await lotService.transitionLotStatus(client, {
      lotId: targetBatchId,
      newStatus: target,
      reason:
        input.memo?.trim() ||
        (input.reason === 'EXPIRED'
          ? 'Soft quarantine — expired (single-store)'
          : 'Soft quarantine — damage (single-store)'),
      userId: input.userId,
    });

    const movement = await recordMovement(client, {
      productId: row.product_id,
      batchId: targetBatchId,
      movementType: input.reason === 'EXPIRED' ? 'EXPIRY' : 'DAMAGE',
      quantity: remaining,
      referenceType: input.referenceType || SOFT_QUARANTINE_REFERENCE_TYPE,
      referenceId: input.referenceId ?? targetBatchId,
      notes:
        input.memo?.trim() ||
        `Soft quarantine → ${target} (no GL; batch remaining unchanged)`,
      createdBy: input.userId,
      economicEvent: 'QUARANTINE_TRANSFER',
      postsGl: false,
    });

    const after = await client.query<{ remaining_quantity: string }>(
      `SELECT remaining_quantity::text FROM inventory_batches WHERE id = $1`,
      [targetBatchId],
    );
    const remainingAfter = Number(after.rows[0]?.remaining_quantity ?? 0);
    if (Math.abs(remainingAfter - remaining) > 0.0001) {
      throw new ValidationError(
        'LQ-INV-1 violation: soft quarantine must not change batch remaining quantity',
      );
    }

    return {
      inventoryBatchId: targetBatchId,
      productLotId,
      productId: row.product_id,
      statusApplied: target,
      quantityHeld: remaining,
      remainingUnchanged: remainingAfter,
      movementId: movement.id,
      movementNumber: movement.movementNumber,
      quarantineMode: 'SOFT' as const,
      splitFromBatchId,
      sellableRemainingOnParent,
    };
  });
  if (UnitOfWork.isPool(conn)) {
    publishNotificationEvent({
      pool: conn,
      typeKey: 'STOCK_QUARANTINED',
      entityType: 'inventory_batch',
      entityId: quarantined.inventoryBatchId,
      idempotencyKey: `STOCK_QUARANTINED:inventory_batch:${quarantined.inventoryBatchId}:${quarantined.movementId}`,
      payload: {
        summary: `Stock quarantined (${quarantined.movementNumber})`,
        documentRef: quarantined.movementNumber,
      },
      actorUserId: input.userId,
    });
  }
  return quarantined;
}

/**
 * Calendar-expired ACTIVE batches still on hand (single-store soft candidates).
 */
export async function findSoftExpiryCandidates(client: PoolClient): Promise<
  Array<{
    inventoryBatchId: string;
    productLotId: string | null;
    productId: string;
    productName: string;
    productSku: string | null;
    lotNumber: string;
    expiryDate: string;
    quantity: number;
    unitCost: number;
    inventoryValue: number;
  }>
> {
  const result = await client.query<{
    inventory_batch_id: string;
    product_lot_id: string | null;
    product_id: string;
    product_name: string;
    product_sku: string | null;
    lot_number: string;
    expiry_date: string;
    quantity: string;
    unit_cost: string;
  }>(
    `SELECT
       ib.id AS inventory_batch_id,
       pl.id AS product_lot_id,
       ib.product_id,
       p.name AS product_name,
       p.sku AS product_sku,
       COALESCE(pl.lot_number, ib.batch_number, ib.id::text) AS lot_number,
       ib.expiry_date::text AS expiry_date,
       ib.remaining_quantity::text AS quantity,
       COALESCE(ib.cost_price, 0)::text AS unit_cost
     FROM inventory_batches ib
     INNER JOIN products p ON p.id = ib.product_id
     LEFT JOIN LATERAL (
       SELECT id, lot_number
       FROM product_lots
       WHERE inventory_batch_id = ib.id
       ORDER BY created_at ASC NULLS LAST
       LIMIT 1
     ) pl ON true
     WHERE ib.expiry_date IS NOT NULL
       AND ib.expiry_date::date <= CURRENT_DATE
       AND COALESCE(ib.status::text, 'ACTIVE') = 'ACTIVE'
       AND ib.remaining_quantity > 0.0001
     ORDER BY ib.expiry_date ASC, p.name ASC
     LIMIT 500`,
  );

  return result.rows.map((r) => {
    const quantity = Number(r.quantity);
    const unitCost = Number(r.unit_cost);
    return {
      inventoryBatchId: r.inventory_batch_id,
      productLotId: r.product_lot_id,
      productId: r.product_id,
      productName: r.product_name,
      productSku: r.product_sku,
      lotNumber: r.lot_number,
      expiryDate: r.expiry_date,
      quantity,
      unitCost,
      inventoryValue: quantity * unitCost,
    };
  });
}

export interface QuarantineFromExpiringReportResult {
  quarantineMode: 'HARD' | 'SOFT';
  inventoryBatchId: string;
  productId: string;
  quantityMoved: number;
  movementId?: string;
  movementNumber?: string;
  statusApplied?: string | null;
}

/**
 * P3 bridge: Expiring Items register → quarantine (soft or hard).
 * Only for calendar-expired ACTIVE stock; no P&L.
 */
async function assertCalendarExpiredForReportBridge(
  conn: DbConnection,
  inventoryBatchId: string,
): Promise<void> {
  const pastDue = await conn.query<{ ok: boolean }>(
    `SELECT (
       EXISTS (
         SELECT 1 FROM inventory_batches b
         WHERE b.id = $1
           AND b.expiry_date IS NOT NULL
           AND b.expiry_date::date <= CURRENT_DATE
       )
     ) AS ok`,
    [inventoryBatchId],
  );
  if (!pastDue.rows[0]?.ok) {
    throw new ValidationError('Only calendar-expired batches can be quarantined from this report');
  }
}

export async function quarantineFromExpiringReport(
  conn: DbConnection,
  input: { inventoryBatchId: string; userId: string; memo?: string },
): Promise<QuarantineFromExpiringReportResult> {
  const multistore = await isMultistoreEnabled(conn);

  if (!multistore) {
    await assertCalendarExpiredForReportBridge(conn, input.inventoryBatchId);
    const soft = await applySoftQuarantine(conn, {
      inventoryBatchId: input.inventoryBatchId,
      reason: 'EXPIRED',
      userId: input.userId,
      memo: input.memo?.trim() || 'Quarantine from Expiring Items report',
      referenceType: SOFT_QUARANTINE_REFERENCE_TYPE,
    });
    return {
      quarantineMode: 'SOFT',
      inventoryBatchId: soft.inventoryBatchId,
      productId: soft.productId,
      quantityMoved: soft.quantityHeld,
      movementId: soft.movementId,
      movementNumber: soft.movementNumber,
      statusApplied: soft.statusApplied,
    };
  }

  return UnitOfWork.runOrJoin(conn, async (client) => {
    const { storeLocationRepository } = await import(
      '../inventory/warehouse/storeLocationRepository.js'
    );
    const { warehouseInventoryRepository } = await import(
      '../inventory/warehouse/warehouseInventoryRepository.js'
    );
    const { syncProductQuantity } = await import('../../utils/inventorySync.js');
    const { syncLotStatusAfterQuarantine } = await import('./quarantineLotStatus.js');

    let expiredStore = await storeLocationRepository.getStoreByType(client, 'EXPIRED');
    if (!expiredStore) {
      expiredStore = await storeLocationRepository.upsertByCode(client, {
        code: 'EXPIRED',
        name: 'Expired Quarantine',
        storeType: 'EXPIRED',
      });
    }

    const batch = await client.query<{
      id: string;
      product_id: string;
      remaining_quantity: string;
      status: string;
      expiry_date: string | null;
    }>(
      `SELECT id, product_id, remaining_quantity::text,
              COALESCE(status::text, 'ACTIVE') AS status,
              expiry_date::text AS expiry_date
       FROM inventory_batches WHERE id = $1 FOR UPDATE`,
      [input.inventoryBatchId],
    );
    const row = batch.rows[0];
    if (!row) throw new NotFoundError('Inventory batch not found');
    if (String(row.status).toUpperCase() !== 'ACTIVE') {
      throw new ValidationError(`Batch is not ACTIVE (status ${row.status}); already quarantined or closed`);
    }
    await assertCalendarExpiredForReportBridge(client, input.inventoryBatchId);

    const lotRow = await client.query<{ id: string }>(
      `SELECT id FROM product_lots WHERE inventory_batch_id = $1 ORDER BY created_at ASC NULLS LAST LIMIT 1`,
      [input.inventoryBatchId],
    );
    const productLotId = lotRow.rows[0]?.id;
    if (!productLotId) {
      throw new ValidationError('Product lot projection missing for batch (INV-001)');
    }

    const bals = await client.query<{
      store_location_id: string;
      store_code: string;
      qty: string;
    }>(
      `SELECT ib.store_location_id, sl.code AS store_code,
              GREATEST(ib.quantity_on_hand - ib.quantity_reserved - ib.quantity_committed, 0)::text AS qty
       FROM inventory_balances ib
       INNER JOIN store_locations sl ON sl.id = ib.store_location_id
       WHERE ib.product_lot_id = $1
         AND sl.store_type IN ('MAIN', 'SELLING')
         AND sl.is_active = true
         AND NOT ib.blocked
       FOR UPDATE OF ib`,
      [productLotId],
    );

    let totalMoved = 0;
    let movementId: string | undefined;
    let movementNumber: string | undefined;

    for (const b of bals.rows) {
      const qty = Number(b.qty);
      if (qty <= 0.0001) continue;
      await warehouseInventoryRepository.moveLotQuantityBetweenStores(client, {
        fromStoreId: b.store_location_id,
        toStoreId: expiredStore.id,
        productId: row.product_id,
        productLotId,
        quantity: qty,
      });
      totalMoved += qty;
    }

    if (totalMoved <= 0.0001) {
      throw new ValidationError(
        'No sellable MAIN/SELLING quantity to quarantine for this batch (already moved or zero)',
      );
    }

    const movement = await recordMovement(client, {
      productId: row.product_id,
      batchId: input.inventoryBatchId,
      movementType: 'EXPIRY',
      quantity: totalMoved,
      referenceType: 'EXPIRY_AUTOMATION',
      referenceId: productLotId,
      notes:
        input.memo?.trim() ||
        `Quarantine from Expiring Items report — moved to ${expiredStore.code}`,
      createdBy: input.userId,
      economicEvent: 'QUARANTINE_TRANSFER',
      postsGl: false,
    });
    movementId = movement.id;
    movementNumber = movement.movementNumber;
    await syncProductQuantity(client, row.product_id);

    const status = await syncLotStatusAfterQuarantine(client, {
      inventoryBatchId: input.inventoryBatchId,
      productLotId,
      quarantineKind: 'EXPIRED',
      userId: input.userId,
    });

    const after = await client.query<{ remaining_quantity: string }>(
      `SELECT remaining_quantity::text FROM inventory_batches WHERE id = $1`,
      [input.inventoryBatchId],
    );
    const remainingAfter = Number(after.rows[0]?.remaining_quantity ?? 0);
    const remainingBefore = Number(row.remaining_quantity);
    if (Math.abs(remainingAfter - remainingBefore) > 0.0001) {
      throw new ValidationError(
        'LQ-INV-1 violation: report quarantine must not change batch remaining quantity',
      );
    }

    return {
      quarantineMode: 'HARD',
      inventoryBatchId: input.inventoryBatchId,
      productId: row.product_id,
      quantityMoved: totalMoved,
      movementId,
      movementNumber,
      statusApplied: status.statusApplied,
    };
  });
}
