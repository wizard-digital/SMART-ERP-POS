/**
 * Lot Carrying-Value Write-Down / Inventory Clearance Markdown —
 * revalue carrying cost, preserve original, post DR 5140 / CR 1300.
 * Quantity is unchanged. Disposal and stock-movement consume paths are not used.
 */

import type { Pool, PoolClient } from 'pg';
import { UnitOfWork } from '../../db/unitOfWork.js';
import { BusinessError, NotFoundError, ValidationError } from '../../middleware/errorHandler.js';
import { getBusinessDate, getBusinessYear } from '../../utils/dateRange.js';
import { AccountingCore } from '../../services/accountingCore.js';
import { AccountCodes } from '../../services/glEntryService.js';
import {
  assertWriteDownCouplesSubledger,
  evaluateLotWriteDownGate,
  lotWriteDownErrorCode,
  LOT_WRITE_DOWN_EXPENSE_ACCOUNT,
  LOT_WRITE_DOWN_REASON,
  LOT_WRITE_DOWN_REFERENCE_TYPE,
  roundWriteDownMoney,
} from '@shared/inventory-lot/lotWriteDown.js';

export interface WriteDownInput {
  inventoryBatchId: string;
  newUnitCost: number;
  memo?: string;
  userId: string;
}

export interface WriteDownResult {
  documentId: string;
  documentNumber: string;
  inventoryBatchId: string;
  productId: string;
  quantity: number;
  originalUnitCost: number;
  previousCarryingUnitCost: number;
  newCarryingUnitCost: number;
  totalAmount: number;
  expenseAccountCode: string;
  journalEntryId: string;
  remainingQuantity: number;
}

function reject(reason: Parameters<typeof lotWriteDownErrorCode>[0], message: string): never {
  throw new BusinessError(message, lotWriteDownErrorCode(reason));
}

async function nextDocumentNumber(client: PoolClient): Promise<string> {
  const year = getBusinessYear();
  const seq = await client.query(`SELECT nextval('lot_write_down_document_seq') AS seq`);
  const n = String(seq.rows[0].seq).padStart(5, '0');
  return `LWD-${year}-${n}`;
}

export async function writeDownNearExpiryLot(
  pool: Pool,
  input: WriteDownInput,
): Promise<WriteDownResult> {
  if (!input.inventoryBatchId) {
    throw new ValidationError('inventoryBatchId is required');
  }
  if (!input.userId) {
    throw new ValidationError('userId is required for lot write-down');
  }
  const newUnitCost = Number(input.newUnitCost);
  const businessDate = getBusinessDate();

  return UnitOfWork.run(pool, async (client) => {
    const batchRes = await client.query<{
      id: string;
      product_id: string;
      batch_number: string;
      expiry_date: string | null;
      remaining_quantity: string;
      cost_price: string;
      original_cost_price: string | null;
      status: string;
      min_days: string | number | null;
    }>(
      `SELECT b.id, b.product_id, b.batch_number, b.expiry_date::text AS expiry_date,
              b.remaining_quantity, b.cost_price, b.original_cost_price,
              COALESCE(b.status::text, 'ACTIVE') AS status,
              COALESCE(p.min_days_before_expiry_sale, 0) AS min_days
       FROM inventory_batches b
       JOIN products p ON p.id = b.product_id
       WHERE b.id = $1
       FOR UPDATE OF b`,
      [input.inventoryBatchId],
    );
    const row = batchRes.rows[0];
    if (!row) {
      throw new NotFoundError('Inventory batch not found');
    }

    const carrying = Number(row.cost_price);
    if (row.original_cost_price == null || !Number.isFinite(Number(row.original_cost_price))) {
      throw new BusinessError(
        'Lot original acquisition cost is missing; refusing write-down.',
        'LOT_WRITE_DOWN_ORIGINAL_MISSING',
      );
    }
    const original = Number(row.original_cost_price);
    const gate = evaluateLotWriteDownGate({
      status: row.status,
      expiryDate: row.expiry_date,
      remainingQuantity: Number(row.remaining_quantity),
      carryingUnitCost: carrying,
      originalUnitCost: original,
      newUnitCost,
      minDaysBeforeExpirySale: Number(row.min_days ?? 0),
      businessDate,
    });
    if (!gate.ok) {
      reject(gate.reason, gate.message);
    }

    const remainingBefore = Number(row.remaining_quantity);
    const documentNumber = await nextDocumentNumber(client);
    const expenseAccountCode = AccountCodes.CLEARANCE_MARKDOWN;
    if (expenseAccountCode !== LOT_WRITE_DOWN_EXPENSE_ACCOUNT) {
      throw new BusinessError(
        `Clearance markdown account must be ${LOT_WRITE_DOWN_EXPENSE_ACCOUNT}`,
        'LOT_WRITE_DOWN_ACCOUNT',
      );
    }
    const newCarrying = roundWriteDownMoney(newUnitCost);
    assertWriteDownCouplesSubledger({
      quantity: gate.quantity,
      previousCarrying: carrying,
      newCarrying,
      glAmount: gate.writeDownAmount,
    });

    const docIns = await client.query<{ id: string }>(
      `INSERT INTO lot_write_down_documents (
         document_number, status, reason, product_id, inventory_batch_id, quantity,
         original_unit_cost, previous_carrying_unit_cost, new_carrying_unit_cost,
         total_amount, expense_account_code, days_until_expiry, memo, created_by, posted_at
       ) VALUES (
         $1, 'POSTED', $2, $3, $4, $5,
         $6, $7, $8,
         $9, $10, $11, $12, $13, NOW()
       ) RETURNING id`,
      [
        documentNumber,
        LOT_WRITE_DOWN_REASON,
        row.product_id,
        row.id,
        gate.quantity,
        roundWriteDownMoney(original),
        roundWriteDownMoney(carrying),
        newCarrying,
        gate.writeDownAmount,
        expenseAccountCode,
        gate.daysUntilExpiry,
        input.memo ?? 'Near-expiry clearance write-down',
        input.userId,
      ],
    );
    const documentId = docIns.rows[0].id;

    const batchUpd = await client.query(
      `UPDATE inventory_batches
       SET cost_price = $2
       WHERE id = $1 AND remaining_quantity = $3 AND cost_price = $4
       RETURNING remaining_quantity`,
      [row.id, newCarrying, remainingBefore, carrying],
    );
    if (batchUpd.rowCount !== 1) {
      throw new BusinessError(
        'Batch quantity or carrying cost changed during write-down. Retry.',
        'LOT_WRITE_DOWN_CONCURRENT',
      );
    }

    await client.query(
      `UPDATE product_lots SET cost_price = $2 WHERE inventory_batch_id = $1`,
      [row.id, newCarrying],
    );

    if (row.batch_number) {
      await client.query(
        `UPDATE cost_layers
         SET unit_cost = $1
         WHERE product_id = $2 AND batch_number = $3 AND remaining_quantity > 0`,
        [newCarrying, row.product_id, row.batch_number],
      );
    }

    const journal = await AccountingCore.createJournalEntry(
      {
        entryDate: businessDate,
        description: `Lot write-down ${documentNumber} — near-expiry NRV`,
        referenceType: LOT_WRITE_DOWN_REFERENCE_TYPE,
        referenceId: documentId,
        referenceNumber: documentNumber,
        lines: [
          {
            accountCode: expenseAccountCode,
            description: `Clearance markdown ${documentNumber}`,
            debitAmount: gate.writeDownAmount,
            creditAmount: 0,
          },
          {
            accountCode: AccountCodes.INVENTORY,
            description: `Clearance markdown ${documentNumber} batch ${row.batch_number}`,
            debitAmount: 0,
            creditAmount: gate.writeDownAmount,
          },
        ],
        userId: input.userId,
        idempotencyKey: `LOT_WRITE_DOWN-${documentId}`,
        source: 'INVENTORY_MOVE',
      },
      pool,
      client,
    );

    await client.query(
      `UPDATE lot_write_down_documents
       SET journal_entry_id = $2::uuid, row_version = row_version + 1
       WHERE id = $1`,
      [documentId, journal.transactionId],
    );

    const remainingAfter = await client.query<{ remaining_quantity: string }>(
      `SELECT remaining_quantity FROM inventory_batches WHERE id = $1`,
      [row.id],
    );
    if (!remainingAfter.rows[0]) {
      throw new BusinessError(
        'Batch missing after write-down; refusing to continue.',
        'LOT_WRITE_DOWN_BATCH_MISSING',
      );
    }
    const remainingQuantity = Number(remainingAfter.rows[0].remaining_quantity);
    if (Math.abs(remainingQuantity - remainingBefore) > 0.0001) {
      throw new BusinessError(
        'Write-down must not change remaining quantity.',
        'LOT_WRITE_DOWN_QTY_CHANGED',
      );
    }

    return {
      documentId,
      documentNumber,
      inventoryBatchId: row.id,
      productId: row.product_id,
      quantity: gate.quantity,
      originalUnitCost: roundWriteDownMoney(original),
      previousCarryingUnitCost: roundWriteDownMoney(carrying),
      newCarryingUnitCost: newCarrying,
      totalAmount: gate.writeDownAmount,
      expenseAccountCode,
      journalEntryId: journal.transactionId,
      remainingQuantity,
    };
  });
}
