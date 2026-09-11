/**
 * Loss Disposal Service — ADR-004 Phase 2C
 *
 * Recognizes inventory P&L loss: DR 5110|5120|5130 / CR 1300 while consuming
 * batch subledger + store balance (including quarantine stores).
 */

import type { Pool, PoolClient } from 'pg';
import { UnitOfWork, type DbConnection } from '../../db/unitOfWork.js';
import { ValidationError, NotFoundError } from '../../middleware/errorHandler.js';
import { getBusinessYear, getBusinessDate } from '../../utils/dateRange.js';
import { StockMovementHandler } from '../inventory/stockMovementHandler.js';
import { storeLocationRepository } from '../inventory/warehouse/storeLocationRepository.js';
import { productLotRepository } from '../inventory/warehouse/productLotRepository.js';
import { isMultistoreEnabled } from '../inventory/warehouse/multistoreSettings.js';
import { alignBatchSubledgerToStoreBalances } from '../../services/warehouseInventoryCoupling.js';
import { AccountingCore } from '../../services/accountingCore.js';
import { pool as defaultPool } from '../../db/pool.js';
import {
  assertDisposalCouplesSubledger,
  expenseAccountForDisposal,
  movementTypeForDisposal,
  roundMoney,
  type LossExpenseReason,
  LossQuarantineInvariantError,
} from '@shared/loss-quarantine/index.js';
import { isQuarantineStoreType } from './quarantineLotStatus.js';

export interface DisposeInput {
  storeLocationId?: string | null;
  productId: string;
  productLotId?: string | null;
  inventoryBatchId?: string | null;
  quantity: number;
  reason?: LossExpenseReason;
  memo?: string;
  unitCost?: number;
  userId: string;
  /** Soft quarantine dispose (single-store). Inferred when storeLocationId is absent. */
  quarantineMode?: 'HARD' | 'SOFT';
}

export interface DisposeResult {
  documentId: string;
  documentNumber: string;
  expenseAccountCode: string;
  movementId: string;
  movementNumber: string;
  batchId: string;
  quantity: number;
  totalAmount: number;
  journalEntryId: string | null;
}

function rethrowInvariant(err: unknown): never {
  if (err instanceof LossQuarantineInvariantError) {
    throw new ValidationError(err.message);
  }
  throw err;
}

function resolveDisposalCarryingUnitCost(batchCarrying: number, supplied?: number): number {
  const carrying = Number(batchCarrying);
  if (!Number.isFinite(carrying) || carrying <= 0) {
    throw new ValidationError('Disposal requires a positive batch carrying cost');
  }
  if (supplied != null && supplied > 0 && Math.abs(supplied - carrying) > 0.01) {
    throw new ValidationError(
      `Disposal must use remaining carrying cost ${carrying}; caller supplied ${supplied}. Original acquisition cost is not used after a write-down.`,
    );
  }
  return carrying;
}

async function nextDocumentNumber(client: PoolClient): Promise<string> {
  const year = getBusinessYear();
  const seq = await client.query(`SELECT nextval('loss_disposal_document_seq') AS seq`);
  const n = String(seq.rows[0].seq).padStart(5, '0');
  return `LDISP-${year}-${n}`;
}

export async function disposeFromQuarantine(
  conn: DbConnection,
  input: DisposeInput,
): Promise<DisposeResult> {
  if (input.quantity <= 0) {
    throw new ValidationError('Disposal quantity must be greater than zero');
  }

  const multistore = await isMultistoreEnabled(conn);
  const softMode =
    input.quarantineMode === 'SOFT' ||
    (!input.storeLocationId && !multistore);

  if (softMode && multistore) {
    throw new ValidationError(
      'Soft dispose is for single-store mode. Dispose from DAMAGE/EXPIRED/RETURN stores in multistore.',
    );
  }
  if (!softMode && !multistore) {
    throw new ValidationError(
      'Hard dispose requires multi-store quarantine stores. Use soft dispose (no storeLocationId) in single-store mode.',
    );
  }
  if (!softMode && !input.storeLocationId) {
    throw new ValidationError('storeLocationId is required for multistore quarantine disposal');
  }

  const pool = UnitOfWork.isPool(conn) ? conn : defaultPool;

  if (softMode) {
    return disposeSoftQuarantine(pool, conn, input);
  }

  return UnitOfWork.runOrJoin(conn, async (client) => {
    const store = await storeLocationRepository.getById(client, input.storeLocationId!);
    if (!store?.isActive) {
      throw new ValidationError('Store is not active');
    }
    if (!isQuarantineStoreType(store.storeType)) {
      throw new ValidationError(
        `Dispose-from-quarantine requires DAMAGE/EXPIRED/RETURN store; got ${store.storeType}. ` +
          `Use inventory adjustments for sellable-store write-offs.`,
      );
    }

    if (!input.productLotId) {
      throw new ValidationError('productLotId is required for multistore quarantine disposal');
    }

    const lot = await productLotRepository.getById(client, input.productLotId);
    if (!lot || lot.productId !== input.productId) {
      throw new NotFoundError('Product lot not found for this product');
    }

    const batchId = lot.inventoryBatchId;
    if (!batchId) {
      throw new ValidationError('Product lot has no inventory batch (INV-001)');
    }

    const bal = await client.query<{ qty: string }>(
      `SELECT GREATEST(
         quantity_on_hand - quantity_reserved - quantity_committed, 0
       )::text AS qty
       FROM inventory_balances
       WHERE store_location_id = $1 AND product_lot_id = $2
       FOR UPDATE`,
      [input.storeLocationId, input.productLotId],
    );
    const available = Number(bal.rows[0]?.qty ?? 0);
    if (input.quantity - available > 0.0001) {
      throw new ValidationError(
        `Cannot dispose ${input.quantity}: only ${available} available in quarantine store`,
      );
    }

    const reason: LossExpenseReason =
      input.reason ??
      (store.storeType === 'DAMAGE'
        ? 'DAMAGE'
        : store.storeType === 'EXPIRED'
          ? 'EXPIRY'
          : 'WRITE_OFF');

    const expenseAccountCode = expenseAccountForDisposal({
      reason,
      fromStoreType: store.storeType,
    });
    const movementType = movementTypeForDisposal({
      reason,
      fromStoreType: store.storeType,
    });

    const costRow = await client.query<{ cost_price: string }>(
      `SELECT cost_price FROM inventory_batches WHERE id = $1`,
      [batchId],
    );
    const unitCost = resolveDisposalCarryingUnitCost(
      Number(costRow.rows[0]?.cost_price),
      input.unitCost,
    );

    await alignBatchSubledgerToStoreBalances(client, input.productId);

    // Qty dual-write owned by StockMovementHandler → consumeLot(sourceStore).
    // Do not pre-adjust balances (double-decrement / silent INV-002 risk).

    const documentNumber = await nextDocumentNumber(client);
    const docIns = await client.query<{ id: string }>(
      `INSERT INTO loss_disposal_documents (
         document_number, status, reason, store_location_id, store_type,
         expense_account_code, product_id, product_lot_id, inventory_batch_id,
         quantity, unit_cost, total_amount, memo, created_by, posted_at
       ) VALUES (
         $1, 'POSTED', $2, $3, $4, $5, $6, $7, $8, $9, $10, 0, $11, $12, NOW()
       ) RETURNING id`,
      [
        documentNumber,
        reason,
        input.storeLocationId,
        store.storeType,
        expenseAccountCode,
        input.productId,
        input.productLotId,
        batchId,
        input.quantity,
        unitCost,
        input.memo ?? `Dispose from ${store.code}`,
        input.userId,
      ],
    );
    const documentId = docIns.rows[0].id;

    const handler = new StockMovementHandler(pool);
    const result = await handler.processMovement(
      {
        productId: input.productId,
        batchId,
        movementType,
        quantity: input.quantity,
        unitCost,
        sourceStoreLocationId: input.storeLocationId!,
        referenceType: 'LOSS_DISPOSAL',
        referenceId: documentId,
        reason: `${reason}: ${input.memo ?? 'quarantine disposal'} [${store.code}]`,
        userId: input.userId,
        expenseAccountCode,
        allowDisposalStatuses: true,
      },
      client,
    );

    const totalAmount = roundMoney(Number(unitCost) * input.quantity);
    try {
      assertDisposalCouplesSubledger({
        glAmount: totalAmount,
        batchConsumptionValue: totalAmount,
      });
    } catch (err) {
      rethrowInvariant(err);
    }

    // Resolve journal id from ledger_transactions by reference
    const journal = await client.query<{ id: string }>(
      `SELECT "Id"::text AS id FROM ledger_transactions
       WHERE "ReferenceType" = 'STOCK_MOVEMENT'
         AND "ReferenceId"::text = $1
       ORDER BY "CreatedAt" DESC
       LIMIT 1`,
      [result.movementId],
    );
    const journalEntryId = journal.rows[0]?.id ?? null;

    await client.query(
      `UPDATE loss_disposal_documents
       SET total_amount = $2,
           stock_movement_id = $3,
           journal_entry_id = $4::uuid,
           row_version = row_version + 1
       WHERE id = $1`,
      [documentId, totalAmount, result.movementId, journalEntryId],
    );

    return {
      documentId,
      documentNumber,
      expenseAccountCode,
      movementId: result.movementId,
      movementNumber: result.movementNumber,
      batchId: result.batchId,
      quantity: input.quantity,
      totalAmount,
      journalEntryId,
    };
  });
}

/** Single-store soft quarantine dispose — same GL map, no quarantine store required. */
async function disposeSoftQuarantine(
  pool: Pool,
  conn: DbConnection,
  input: DisposeInput,
): Promise<DisposeResult> {
  return UnitOfWork.runOrJoin(conn, async (client) => {
    // Prefer inventoryBatchId from the aging line — productLotId may be a sibling lot after split.
    let batchId = input.inventoryBatchId ?? null;
    let productLotId: string | null = null;

    if (!batchId && input.productLotId) {
      const lot = await productLotRepository.getById(client, input.productLotId);
      if (!lot || lot.productId !== input.productId) {
        throw new NotFoundError('Product lot not found for this product');
      }
      batchId = lot.inventoryBatchId ?? null;
    }

    if (!batchId) {
      throw new ValidationError('inventoryBatchId or productLotId is required for soft dispose');
    }

    const batch = await client.query<{
      id: string;
      product_id: string;
      remaining_quantity: string;
      status: string;
      cost_price: string;
    }>(
      `SELECT id, product_id, remaining_quantity::text,
              COALESCE(status::text, 'ACTIVE') AS status,
              COALESCE(cost_price, 0)::text AS cost_price
       FROM inventory_batches WHERE id = $1 FOR UPDATE`,
      [batchId],
    );
    const row = batch.rows[0];
    if (!row || row.product_id !== input.productId) {
      throw new NotFoundError('Inventory batch not found for this product');
    }

    const status = String(row.status || '').toUpperCase();
    if (status !== 'EXPIRED' && status !== 'QUARANTINED') {
      throw new ValidationError(
        `Soft dispose requires EXPIRED or QUARANTINED lot status; got ${status}. Soft-quarantine first.`,
      );
    }

    const available = Number(row.remaining_quantity);
    if (input.quantity - available > 0.0001) {
      throw new ValidationError(
        `Cannot dispose ${input.quantity}: only ${available} remaining on soft-quarantined batch`,
      );
    }

    // Always resolve productLot from the dispose batch (ignore stale sibling productLotId).
    const lotLookup = await client.query<{ id: string }>(
      `SELECT id FROM product_lots WHERE inventory_batch_id = $1 ORDER BY created_at ASC NULLS LAST LIMIT 1`,
      [batchId],
    );
    productLotId = lotLookup.rows[0]?.id ?? null;

    const fromStoreType = status === 'EXPIRED' ? 'EXPIRED' : 'DAMAGE';
    const reason: LossExpenseReason =
      input.reason ?? (fromStoreType === 'EXPIRED' ? 'EXPIRY' : 'DAMAGE');
    const expenseAccountCode = expenseAccountForDisposal({ reason, fromStoreType });
    const movementType = movementTypeForDisposal({ reason, fromStoreType });

    const unitCost = resolveDisposalCarryingUnitCost(Number(row.cost_price), input.unitCost);

    // Qty dual-write owned by StockMovementHandler → consumeLot (cross-store deduct).
    // Do not pre-adjust balances (double-decrement / silent INV-002 risk).

    const documentNumber = await nextDocumentNumber(client);
    const docIns = await client.query<{ id: string }>(
      `INSERT INTO loss_disposal_documents (
         document_number, status, reason, store_location_id, store_type,
         expense_account_code, product_id, product_lot_id, inventory_batch_id,
         quantity, unit_cost, total_amount, memo, created_by, posted_at
       ) VALUES (
         $1, 'POSTED', $2, NULL, $3, $4, $5, $6, $7, $8, $9, 0, $10, $11, NOW()
       ) RETURNING id`,
      [
        documentNumber,
        reason,
        fromStoreType,
        expenseAccountCode,
        input.productId,
        productLotId,
        batchId,
        input.quantity,
        unitCost,
        input.memo ?? `Soft quarantine dispose (${fromStoreType})`,
        input.userId,
      ],
    );
    const documentId = docIns.rows[0].id;

    const handler = new StockMovementHandler(pool);
    const result = await handler.processMovement(
      {
        productId: input.productId,
        batchId,
        movementType,
        quantity: input.quantity,
        unitCost,
        referenceType: 'LOSS_DISPOSAL',
        referenceId: documentId,
        reason: `${reason}: ${input.memo ?? 'soft quarantine disposal'} [SOFT/${fromStoreType}]`,
        userId: input.userId,
        expenseAccountCode,
        allowDisposalStatuses: true,
      },
      client,
    );

    const totalAmount = roundMoney(Number(unitCost) * input.quantity);
    try {
      assertDisposalCouplesSubledger({
        glAmount: totalAmount,
        batchConsumptionValue: totalAmount,
      });
    } catch (err) {
      rethrowInvariant(err);
    }

    const journal = await client.query<{ id: string }>(
      `SELECT "Id"::text AS id FROM ledger_transactions
       WHERE "ReferenceType" = 'STOCK_MOVEMENT'
         AND "ReferenceId"::text = $1
       ORDER BY "CreatedAt" DESC
       LIMIT 1`,
      [result.movementId],
    );
    const journalEntryId = journal.rows[0]?.id ?? null;

    await client.query(
      `UPDATE loss_disposal_documents
       SET total_amount = $2,
           stock_movement_id = $3,
           journal_entry_id = $4::uuid,
           row_version = row_version + 1
       WHERE id = $1`,
      [documentId, totalAmount, result.movementId, journalEntryId],
    );

    return {
      documentId,
      documentNumber,
      expenseAccountCode,
      movementId: result.movementId,
      movementNumber: result.movementNumber,
      batchId: result.batchId,
      quantity: input.quantity,
      totalAmount,
      journalEntryId,
    };
  });
}

/**
 * LQ-INV-10: reverse a posted disposal — restore store qty + reverse GL.
 */
export async function reverseDisposal(
  conn: DbConnection,
  input: { documentId: string; userId: string; reason?: string },
): Promise<{ reversalDocumentId: string; reversalDocumentNumber: string }> {
  const pool = UnitOfWork.isPool(conn) ? conn : defaultPool;

  return UnitOfWork.runOrJoin(conn, async (client) => {
    const doc = await client.query<{
      id: string;
      status: string;
      reason: string;
      store_location_id: string;
      store_type: string;
      expense_account_code: string;
      product_id: string;
      product_lot_id: string;
      inventory_batch_id: string;
      quantity: string;
      unit_cost: string;
      total_amount: string;
      journal_entry_id: string | null;
      reversed_by_document_id: string | null;
      document_number: string;
    }>(
      `SELECT * FROM loss_disposal_documents WHERE id = $1 FOR UPDATE`,
      [input.documentId],
    );
    const original = doc.rows[0];
    if (!original) throw new NotFoundError('Disposal document not found');
    if (original.status !== 'POSTED') {
      throw new ValidationError(`Cannot reverse disposal in status ${original.status}`);
    }
    if (original.reversed_by_document_id) {
      throw new ValidationError('Disposal already reversed');
    }

    const qty = Number(original.quantity);
    const unitCost = Number(original.unit_cost ?? 0);
    if (unitCost <= 0) {
      throw new ValidationError('Cannot reverse disposal without unit cost');
    }

    if (original.journal_entry_id) {
      await AccountingCore.reverseTransaction(
        {
          originalTransactionId: original.journal_entry_id,
          reversalDate: getBusinessDate(),
          reason: input.reason ?? `Reverse loss disposal ${original.document_number}`,
          userId: input.userId,
          idempotencyKey: `LOSS_REVERSAL-${original.id}`,
        },
        pool,
        client,
      );
    }

    const { lotService } = await import('../inventory-lot/lotService.js');
    await lotService.returnLot(client, {
      productId: original.product_id,
      batchId: original.inventory_batch_id,
      quantity: qty,
      costPrice: unitCost,
      targetStoreLocationId: original.store_location_id,
      referenceType: 'LOSS_REVERSAL',
      referenceId: original.id,
      notes: input.reason ?? `Reversal of ${original.document_number}`,
      userId: input.userId,
    });

    const { recordMovement } = await import('../stock-movements/stockMovementRepository.js');
    const movement = await recordMovement(client, {
      productId: original.product_id,
      batchId: original.inventory_batch_id,
      movementType: 'ADJUSTMENT_IN',
      quantity: qty,
      unitCost,
      referenceType: 'LOSS_REVERSAL',
      referenceId: original.id,
      notes: input.reason ?? `Reversal of ${original.document_number}`,
      createdBy: input.userId,
      economicEvent: 'LOSS_REVERSAL',
      postsGl: true,
    });

    const reversalNumber = await nextDocumentNumber(client);
    const rev = await client.query<{ id: string }>(
      `INSERT INTO loss_disposal_documents (
         document_number, status, reason, store_location_id, store_type,
         expense_account_code, product_id, product_lot_id, inventory_batch_id,
         quantity, unit_cost, total_amount, memo, created_by, posted_at,
         reverses_document_id, stock_movement_id, journal_entry_id
       ) VALUES (
         $1, 'POSTED', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW(), $14, $15, $16::uuid
       ) RETURNING id`,
      [
        reversalNumber,
        original.reason,
        original.store_location_id,
        original.store_type,
        original.expense_account_code,
        original.product_id,
        original.product_lot_id,
        original.inventory_batch_id,
        qty,
        unitCost,
        roundMoney(Number(original.total_amount)),
        input.reason ?? `Reversal of ${original.document_number}`,
        input.userId,
        original.id,
        movement.id,
        original.journal_entry_id,
      ],
    );

    await client.query(
      `UPDATE loss_disposal_documents
       SET status = 'REVERSED',
           reversed_by_document_id = $2,
           row_version = row_version + 1
       WHERE id = $1`,
      [original.id, rev.rows[0].id],
    );

    return {
      reversalDocumentId: rev.rows[0].id,
      reversalDocumentNumber: reversalNumber,
    };
  });
}

/** Map adjustment WRITE_OFF at a store to the correct movement type + expense (LQ-INV-7). */
export function resolveWriteOffPosting(storeType: string | null | undefined): {
  movementType: 'DAMAGE' | 'EXPIRY' | 'ADJUSTMENT_OUT';
  expenseAccountCode: string;
} {
  const expenseAccountCode = expenseAccountForDisposal({
    reason: 'WRITE_OFF',
    fromStoreType: storeType,
  });
  return {
    movementType: movementTypeForDisposal({
      reason: 'WRITE_OFF',
      fromStoreType: storeType,
    }),
    expenseAccountCode,
  };
}
