/**
 * Store Issue to Expense — ADR-005 INGREDIENT_ISSUE.
 * FEFO consume + DR 5150 / CR 1300. No BOM. Not sale COGS. Not loss disposal.
 */

import type { Pool, PoolClient } from 'pg';
import Decimal from 'decimal.js';
import { pool as globalPool } from '../../db/pool.js';
import {
  BusinessError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../middleware/errorHandler.js';
import logger from '../../utils/logger.js';
import { getBusinessDate } from '../../utils/dateRange.js';
import { allocateNextMovementNumber } from '../../utils/documentNumberAllocation.js';
import { syncProductQuantity } from '../../utils/inventorySync.js';
import { Money } from '../../utils/money.js';
import { SYSTEM_USER_ID } from '../../utils/constants.js';
import * as glEntryService from '../../services/glEntryService.js';
import { AccountingCore } from '../../services/accountingCore.js';
import {
  assertInventoryCouplingUnchanged,
  captureInventoryCoupling,
} from '../../services/inventorySubledgerCoupling.js';
import { lotService } from '../inventory-lot/lotService.js';
import { isMultistoreEnabled } from '../inventory/warehouse/multistoreSettings.js';
import { storeLocationRepository } from '../inventory/warehouse/storeLocationRepository.js';
import { isRestaurantModeEnabled } from '../restaurant/restaurantSettings.js';
import {
  STORE_ISSUE_ECONOMIC_EVENT,
  STORE_ISSUE_EXPENSE_ACCOUNT,
  STORE_ISSUE_MOVEMENT_TYPE,
  STORE_ISSUE_REVERSAL_MOVEMENT_TYPE,
  assertExpenseAccountLocked,
  assertStoreIssueReverseGovernance,
  assertStoreIssueReverseMovements,
  canCancelStoreIssue,
  canEditStoreIssue,
  canPostStoreIssue,
  canReverseStoreIssue,
  consumeStoreIdForIssue,
  isSellableIssueStoreType,
  normalizeIssuedTo,
  normalizeStoreIssueLines,
  type StoreIssueDraftInput,
  type StoreIssueDocument,
} from '../../../../shared/store-issue/index.js';
import { storeIssueRepository } from './storeIssueRepository.js';
import {
  assertStoreIssueStock,
  previewStoreIssueAvailability,
  wrapConsumeStockError,
} from './storeIssueStock.js';

async function assertEnabled(conn: Pool | PoolClient): Promise<void> {
  if (!(await isRestaurantModeEnabled(conn))) {
    throw new ForbiddenError(
      'Store Issue to Expense requires Restaurant mode. Enable it in system settings.',
    );
  }
  if (!(await storeIssueRepository.tableExists(conn))) {
    throw new BusinessError(
      'Store issue schema missing. Apply migration 639_store_issue_to_expense.sql',
      'ERR_STORE_ISSUE_SCHEMA',
    );
  }
}

function toValidation(err: unknown): never {
  if (err instanceof ValidationError || err instanceof BusinessError || err instanceof NotFoundError) {
    throw err;
  }
  throw new ValidationError(err instanceof Error ? err.message : 'Invalid store issue');
}

async function validateStockProduct(conn: Pool | PoolClient, productId: string) {
  const r = await conn.query<{ name: string; product_type: string; is_active: boolean }>(
    `SELECT name, product_type, COALESCE(is_active, TRUE) AS is_active
     FROM products WHERE id = $1`,
    [productId],
  );
  if (!r.rows[0]?.is_active) throw new NotFoundError('Product');
  if (String(r.rows[0].product_type || 'inventory').toLowerCase() === 'service') {
    throw new ValidationError(
      `Cannot issue service product "${r.rows[0].name}". Issue inventory/consumable store goods only.`,
    );
  }
  return r.rows[0];
}

async function validateIssueStore(
  conn: Pool | PoolClient,
  storeLocationId: string | null,
  multistore: boolean,
) {
  if (multistore && !storeLocationId) {
    throw new ValidationError('Store location is required when multistore is enabled');
  }
  if (!storeLocationId) return;
  const store = await storeLocationRepository.getById(conn, storeLocationId);
  if (!store?.isActive) throw new ValidationError('Store is not active');
  if (!isSellableIssueStoreType(store.storeType)) {
    throw new ValidationError(
      `Cannot issue from ${store.storeType} store. Use MAIN or SELLING. Quarantine disposal is a different document.`,
    );
  }
}

async function insertIssueMovement(
  client: PoolClient,
  params: {
    productId: string;
    batchId: string;
    quantity: number;
    unitCost: number;
    documentId: string;
    documentNumber: string;
    notes: string;
    userId: string;
    movementType?: string;
    referenceType?: string;
  },
): Promise<void> {
  const movementNumber = await allocateNextMovementNumber(client);
  await client.query(
    `INSERT INTO stock_movements (
       movement_number, product_id, batch_id, movement_type, quantity, unit_cost,
       reference_type, reference_id, notes, created_by_id,
       economic_event, posts_gl
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      movementNumber,
      params.productId,
      params.batchId,
      params.movementType || STORE_ISSUE_MOVEMENT_TYPE,
      Math.abs(params.quantity).toFixed(6),
      params.unitCost,
      params.referenceType || 'STORE_ISSUE',
      params.documentId,
      params.notes,
      params.userId,
      STORE_ISSUE_ECONOMIC_EVENT,
      true,
    ],
  );
}

async function recordStoreIssueToGL(
  client: PoolClient,
  data: {
    documentId: string;
    documentNumber: string;
    issueDate: string;
    issuedTo: string;
    totalCost: number;
  },
): Promise<string | null> {
  if (!(data.totalCost > 0)) return null;
  assertExpenseAccountLocked(STORE_ISSUE_EXPENSE_ACCOUNT);
  const value = Money.round(data.totalCost).toNumber();
  const result = await AccountingCore.createJournalEntry(
    {
      entryDate: data.issueDate,
      description: `Store issue ${data.documentNumber} to ${data.issuedTo}`,
      referenceType: 'STORE_ISSUE',
      referenceId: data.documentId,
      referenceNumber: data.documentNumber,
      lines: [
        {
          accountCode: STORE_ISSUE_EXPENSE_ACCOUNT,
          description: `Internal issue ${data.documentNumber} (${data.issuedTo})`,
          debitAmount: value,
          creditAmount: 0,
        },
        {
          accountCode: glEntryService.AccountCodes.INVENTORY,
          description: `Inventory issue ${data.documentNumber}`,
          debitAmount: 0,
          creditAmount: value,
        },
      ],
      userId: SYSTEM_USER_ID,
      idempotencyKey: `STORE_ISSUE-${data.documentId}`,
      source: 'INVENTORY_MOVE' as const,
    },
    undefined,
    client,
  );
  return result.transactionId;
}

export const storeIssueService = {
  async isEnabled(pool: Pool = globalPool): Promise<boolean> {
    if (!(await isRestaurantModeEnabled(pool))) return false;
    return storeIssueRepository.tableExists(pool);
  },

  async listStockProducts(
    pool: Pool,
    opts?: { search?: string; limit?: number },
  ): Promise<Array<{ id: string; name: string; sku: string | null; productType: string }>> {
    await assertEnabled(pool);
    const limit = Math.min(Math.max(opts?.limit ?? 400, 1), 500);
    const params: unknown[] = [];
    const clauses = [
      `COALESCE(p.is_active, TRUE) = TRUE`,
      `LOWER(COALESCE(p.product_type, 'inventory')) <> 'service'`,
    ];
    if (opts?.search?.trim()) {
      params.push(`%${opts.search.trim()}%`);
      clauses.push(
        `(p.name ILIKE $${params.length} OR COALESCE(p.sku, '') ILIKE $${params.length})`,
      );
    }
    params.push(limit);
    const r = await pool.query(
      `SELECT p.id, p.name, p.sku, COALESCE(p.product_type, 'inventory') AS "productType"
       FROM products p
       WHERE ${clauses.join(' AND ')}
       ORDER BY p.name ASC
       LIMIT $${params.length}`,
      params,
    );
    return r.rows;
  },

  async previewAvailability(
    pool: Pool,
    productId: string,
    storeLocationId?: string | null,
  ): Promise<{
    productId: string;
    productName: string;
    availableQty: number;
    storeLabel: string;
  }> {
    await assertEnabled(pool);
    const product = await validateStockProduct(pool, productId);
    const multistore = await isMultistoreEnabled(pool);
    await validateIssueStore(pool, storeLocationId ?? null, multistore);
    const preview = await previewStoreIssueAvailability(
      pool,
      productId,
      storeLocationId ?? null,
      multistore,
    );
    return {
      productId,
      productName: product.name,
      availableQty: preview.available,
      storeLabel: preview.storeLabel,
    };
  },

  async list(pool: Pool, opts?: { status?: string; limit?: number }): Promise<StoreIssueDocument[]> {
    await assertEnabled(pool);
    return storeIssueRepository.list(pool, opts);
  },

  async getById(pool: Pool, id: string): Promise<StoreIssueDocument> {
    await assertEnabled(pool);
    const doc = await storeIssueRepository.getById(pool, id);
    if (!doc) throw new NotFoundError('Store issue');
    return doc;
  },

  async createDraft(
    pool: Pool,
    input: StoreIssueDraftInput,
    userId: string,
  ): Promise<StoreIssueDocument> {
    await assertEnabled(pool);
    if (!userId) throw new ValidationError('User is required');
    let lines;
    try {
      lines = normalizeStoreIssueLines(input.lines);
    } catch (err) {
      toValidation(err);
    }
    for (const line of lines) {
      await validateStockProduct(pool, line.productId);
    }
    const issuedTo = normalizeIssuedTo(input.issuedTo);
    const multistore = await isMultistoreEnabled(pool);
    await validateIssueStore(pool, input.storeLocationId ?? null, multistore);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const documentNumber = await storeIssueRepository.nextDocumentNumber(client);
      const id = await storeIssueRepository.insertDraft(client, {
        documentNumber,
        issueDate: input.issueDate || getBusinessDate(),
        storeLocationId: input.storeLocationId ?? null,
        issuedTo,
        requestedByName: input.requestedByName?.trim() || null,
        notes: input.notes ?? null,
        createdBy: userId,
        lines,
      });
      await client.query('COMMIT');
      return (await storeIssueRepository.getById(pool, id))!;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  },

  async updateDraft(
    pool: Pool,
    id: string,
    input: Partial<StoreIssueDraftInput>,
  ): Promise<StoreIssueDocument> {
    await assertEnabled(pool);
    const existing = await storeIssueRepository.getById(pool, id);
    if (!existing) throw new NotFoundError('Store issue');
    if (!canEditStoreIssue(existing.status)) {
      throw new BusinessError('Only DRAFT store issues can be edited', 'ERR_SI_STATUS');
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (input.storeLocationId !== undefined) {
        const multistore = await isMultistoreEnabled(client);
        await validateIssueStore(client, input.storeLocationId ?? null, multistore);
      }
      await storeIssueRepository.updateDraft(client, id, {
        issueDate: input.issueDate,
        storeLocationId: input.storeLocationId,
        issuedTo: input.issuedTo ? normalizeIssuedTo(input.issuedTo) : undefined,
        requestedByName: input.requestedByName,
        notes: input.notes,
      });
      if (input.lines) {
        let lines;
        try {
          lines = normalizeStoreIssueLines(input.lines);
        } catch (err) {
          toValidation(err);
        }
        for (const line of lines) {
          await validateStockProduct(client, line.productId);
        }
        await storeIssueRepository.replaceLines(client, id, lines);
      }
      await client.query('COMMIT');
      return (await storeIssueRepository.getById(pool, id))!;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  },

  /**
   * Atomic post: FEFO consume issued qty + GOODS_ISSUE movements + DR 5150 / CR 1300.
   */
  async post(pool: Pool, id: string, userId: string): Promise<StoreIssueDocument> {
    await assertEnabled(pool);
    if (!userId) throw new ValidationError('User is required');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const lock = await client.query(
        `SELECT id FROM store_issue_documents WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!lock.rows[0]) throw new NotFoundError('Store issue');

      const doc = await storeIssueRepository.getById(client, id);
      if (!doc) throw new NotFoundError('Store issue');
      if (!canPostStoreIssue(doc.status)) {
        throw new BusinessError('Only DRAFT store issues can be posted', 'ERR_SI_STATUS');
      }
      if (!doc.lines.length) throw new ValidationError('Store issue has no lines');
      try {
        normalizeStoreIssueLines(
          doc.lines.map((l) => ({
            productId: l.productId,
            requestedQtyBase: l.requestedQtyBase,
            issuedQtyBase: l.issuedQtyBase,
            sortOrder: l.sortOrder,
            notes: l.notes,
          })),
          { requireIssued: true },
        );
      } catch (err) {
        toValidation(err);
      }

      assertExpenseAccountLocked(doc.expenseAccountCode || STORE_ISSUE_EXPENSE_ACCOUNT);

      const multistore = await isMultistoreEnabled(client);
      await validateIssueStore(client, doc.storeLocationId, multistore);

      const couplingBefore = await captureInventoryCoupling(client);
      const lineCosts: Array<{ productId: string; unitCost: number; lineCost: number }> = [];
      let totalCost = new Decimal(0);
      const consumeStoreId = consumeStoreIdForIssue(multistore, doc.storeLocationId);

      for (const line of doc.lines) {
        await validateStockProduct(client, line.productId);
        const productRes = await client.query<{ name: string }>(
          `SELECT name FROM products WHERE id = $1`,
          [line.productId],
        );
        const productName = productRes.rows[0]?.name ?? line.productId;

        const stock = await assertStoreIssueStock(client, {
          productId: line.productId,
          productName,
          issuedQty: line.issuedQtyBase,
          storeLocationId: doc.storeLocationId,
          multistore,
        });

        let consumeResult;
        try {
          consumeResult = await lotService.consumeLot(client, {
            productId: line.productId,
            quantity: line.issuedQtyBase,
            storeLocationId: consumeStoreId,
            selectionPolicy: 'FEFO',
            referenceType: 'STORE_ISSUE',
            referenceId: doc.id,
            userId,
            productName,
            recordMovement: false,
            syncProduct: false,
          });
        } catch (err) {
          return wrapConsumeStockError(err, {
            productName,
            requested: line.issuedQtyBase,
            available: stock.available,
            storeLabel: stock.storeLabel,
          });
        }

        const lineCost = Money.parseDb(consumeResult.totalCost);
        totalCost = totalCost.plus(lineCost);
        const unitCost =
          line.issuedQtyBase > 0 ? Number(lineCost.div(line.issuedQtyBase).toFixed(6)) : 0;
        lineCosts.push({
          productId: line.productId,
          unitCost,
          lineCost: Money.toNumber(lineCost),
        });

        for (const layer of consumeResult.layers) {
          await insertIssueMovement(client, {
            productId: line.productId,
            batchId: layer.lotId,
            quantity: layer.quantity,
            unitCost: layer.costPrice,
            documentId: doc.id,
            documentNumber: doc.documentNumber,
            notes: `Store issue ${doc.documentNumber} → ${doc.issuedTo} — ${productName}`,
            userId,
          });
        }
        await syncProductQuantity(client, line.productId);
      }

      const totalCostNum = Money.toNumber(Money.round(totalCost));
      const journalId = await recordStoreIssueToGL(client, {
        documentId: doc.id,
        documentNumber: doc.documentNumber,
        issueDate: doc.issueDate || getBusinessDate(),
        issuedTo: doc.issuedTo,
        totalCost: totalCostNum,
      });

      await storeIssueRepository.markPosted(client, doc.id, {
        postedBy: userId,
        totalCost: totalCostNum,
        expenseAccountCode: STORE_ISSUE_EXPENSE_ACCOUNT,
        journalEntryId: journalId,
        lineCosts,
      });

      assertInventoryCouplingUnchanged(
        couplingBefore,
        await captureInventoryCoupling(client),
        `store issue ${doc.documentNumber}`,
      );

      await client.query('COMMIT');
      logger.info('Store issue posted', {
        documentId: doc.id,
        documentNumber: doc.documentNumber,
        totalCost: totalCostNum,
        expenseAccountCode: STORE_ISSUE_EXPENSE_ACCOUNT,
      });
      return (await storeIssueRepository.getById(pool, id))!;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  async postNow(
    pool: Pool,
    input: StoreIssueDraftInput,
    userId: string,
  ): Promise<StoreIssueDocument> {
    const draft = await this.createDraft(pool, input, userId);
    return this.post(pool, draft.id, userId);
  },

  async cancelDraft(pool: Pool, id: string): Promise<{ cancelled: true }> {
    await assertEnabled(pool);
    const existing = await storeIssueRepository.getById(pool, id);
    if (!existing) throw new NotFoundError('Store issue');
    if (!canCancelStoreIssue(existing.status)) {
      throw new BusinessError('Only DRAFT store issues can be cancelled', 'ERR_SI_STATUS');
    }
    const ok = await storeIssueRepository.markCancelled(pool, id);
    if (!ok) throw new BusinessError('Cancel failed', 'ERR_SI_CANCEL');
    return { cancelled: true };
  },

  /**
   * SAP GI 202: restore FEFO lots + reverse 5150/1300. Posted document is not edited.
   * Governance: mandatory reason, kitchen.production.reverse, four-eyes unless inventory.approve.
   */
  async reverse(
    pool: Pool,
    id: string,
    userId: string,
    opts: { reason: string; canOverrideFourEyes: boolean },
  ): Promise<StoreIssueDocument> {
    await assertEnabled(pool);
    if (!userId) throw new ValidationError('User is required');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const lock = await client.query(
        `SELECT id FROM store_issue_documents WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!lock.rows[0]) throw new NotFoundError('Store issue');

      const doc = await storeIssueRepository.getById(client, id);
      if (!doc) throw new NotFoundError('Store issue');
      if (!canReverseStoreIssue(doc.status)) {
        throw new BusinessError(
          'Only POSTED store issues can be reversed. Drafts can be edited or cancelled.',
          'ERR_SI_STATUS',
        );
      }

      let reversalReason: string;
      try {
        reversalReason = assertStoreIssueReverseGovernance({
          reason: opts.reason,
          postedBy: doc.postedBy,
          reversingUserId: userId,
          canOverrideFourEyes: opts.canOverrideFourEyes,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Reverse denied';
        if (/cannot reverse a goods issue you posted/i.test(message)) {
          throw new ForbiddenError(message);
        }
        throw new ValidationError(message);
      }

      const multistore = await isMultistoreEnabled(client);
      const returnStoreId = consumeStoreIdForIssue(multistore, doc.storeLocationId);
      const couplingBefore = await captureInventoryCoupling(client);
      const movements = await storeIssueRepository.listIssueMovements(client, doc.id);
      const issuedQty = doc.lines.reduce((sum, line) => sum + Number(line.issuedQtyBase || 0), 0);
      const movementQty = movements.reduce((sum, movement) => sum + Number(movement.quantity || 0), 0);
      try {
        assertStoreIssueReverseMovements(issuedQty, movementQty);
      } catch (err) {
        throw new BusinessError(
          err instanceof Error ? err.message : 'Cannot reverse store issue movements',
          'ERR_SI_REVERSE_MOVEMENTS',
        );
      }
      const restoredProducts = new Set<string>();

      for (const movement of movements) {
        if (!(movement.quantity > 0) || !movement.batchId) continue;
        await lotService.returnLot(client, {
          productId: movement.productId,
          batchId: movement.batchId,
          quantity: movement.quantity,
          costPrice: movement.unitCost,
          targetStoreLocationId: returnStoreId,
          referenceType: 'STORE_ISSUE_REVERSAL',
          referenceId: doc.id,
          notes: `Reversal of ${doc.documentNumber}: ${reversalReason}`,
          userId,
        });
        await insertIssueMovement(client, {
          productId: movement.productId,
          batchId: movement.batchId,
          quantity: movement.quantity,
          unitCost: movement.unitCost,
          documentId: doc.id,
          documentNumber: doc.documentNumber,
          notes: `Reversal of store issue ${doc.documentNumber}: ${reversalReason}`,
          userId,
          movementType: STORE_ISSUE_REVERSAL_MOVEMENT_TYPE,
          referenceType: 'STORE_ISSUE_REVERSAL',
        });
        restoredProducts.add(movement.productId);
      }

      for (const productId of restoredProducts) {
        await syncProductQuantity(client, productId);
      }

      let reversalJournalId: string | null = null;
      if (doc.journalEntryId) {
        const reversal = await AccountingCore.reverseTransaction(
          {
            originalTransactionId: doc.journalEntryId,
            reversalDate: getBusinessDate(),
            reason: `Reverse store issue ${doc.documentNumber}: ${reversalReason}`,
            userId,
            idempotencyKey: `STORE_ISSUE_REVERSAL-${doc.id}`,
          },
          undefined,
          client,
        );
        reversalJournalId = reversal.transactionId;
      }

      const ok = await storeIssueRepository.markReversed(client, doc.id, {
        reversedBy: userId,
        reversalJournalId,
        reversalReason,
      });
      if (!ok) throw new BusinessError('Reverse failed', 'ERR_SI_REVERSE');

      assertInventoryCouplingUnchanged(
        couplingBefore,
        await captureInventoryCoupling(client),
        `store issue reverse ${doc.documentNumber}`,
      );

      await client.query('COMMIT');
      logger.info('Store issue reversed', {
        documentId: doc.id,
        documentNumber: doc.documentNumber,
        reversalJournalId,
      });
      return (await storeIssueRepository.getById(pool, id))!;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },
};
