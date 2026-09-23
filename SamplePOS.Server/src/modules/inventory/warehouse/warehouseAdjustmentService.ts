import type { Pool, PoolClient } from 'pg';
import { UnitOfWork, type DbConnection } from '../../../db/unitOfWork.js';
import { ValidationError } from '../../../middleware/errorHandler.js';
import { StockMovementHandler } from '../stockMovementHandler.js';
import type { StockMovementType } from '../stockMovementHandler.js';
import { getBusinessYear } from '../../../utils/dateRange.js';
import { isMultistoreEnabled } from './multistoreSettings.js';
import { storeLocationRepository } from './storeLocationRepository.js';
import { ensureProjectionFromMaster, lotService } from '../../inventory-lot/lotService.js';
import { productLotRepository } from './productLotRepository.js';
import { warehouseInventoryRepository } from './warehouseInventoryRepository.js';
import { pool as defaultPool } from '../../../db/pool.js';
import { publishNotificationEvent } from '../../notifications/notificationPublisher.js';
import { alignBatchSubledgerToStoreBalances, assertWarehouseLayerConsistent } from '../../../services/warehouseInventoryCoupling.js';
import { recordMovement } from '../../stock-movements/stockMovementRepository.js';
import { syncLotStatusAfterQuarantine } from '../../loss-quarantine/quarantineLotStatus.js';

export type AdjustmentDirection = 'IN' | 'OUT';
export type AdjustmentReason =
    | 'ADJUSTMENT'
    | 'DAMAGE'
    | 'EXPIRY'
    | 'PHYSICAL_COUNT'
    | 'WRITE_OFF';

export interface StoreAdjustmentParams {
    storeLocationId: string;
    productId: string;
    productLotId?: string;
    batchId?: string;
    quantity: number;
    direction: AdjustmentDirection;
    reason: AdjustmentReason;
    notes: string;
    userId: string;
    documentId?: string;
    unitCost?: number;
}

async function resolveBatchUnitCost(
    client: PoolClient,
    batchId: string | undefined,
): Promise<number | undefined> {
    if (!batchId) return undefined;
    const costRow = await client.query(
        'SELECT cost_price FROM inventory_batches WHERE id = $1',
        [batchId],
    );
    const dbCost = costRow.rows[0]?.cost_price;
    if (dbCost && parseFloat(String(dbCost)) > 0) {
        return parseFloat(String(dbCost));
    }
    return undefined;
}

async function ensureDamageStore(client: PoolClient) {
    let store = await storeLocationRepository.getStoreByType(client, 'DAMAGE');
    if (!store) {
        store = await storeLocationRepository.upsertByCode(client, {
            code: 'DAMAGE',
            name: 'Damaged Quarantine',
            storeType: 'DAMAGE',
        });
    }
    return store;
}

async function ensureExpiredStore(client: PoolClient) {
    let store = await storeLocationRepository.getStoreByType(client, 'EXPIRED');
    if (!store) {
        store = await storeLocationRepository.upsertByCode(client, {
            code: 'EXPIRED',
            name: 'Expired Quarantine',
            storeType: 'EXPIRED',
        });
    }
    return store;
}

async function resolveDefaultStoreId(conn: PoolClient): Promise<string> {
    // INV-POS SSOT: sellable adjustments default to SELLING (same as GR/POS), not MAIN warehouse.
    const selling = await storeLocationRepository.getActivePosSellingStore(conn);
    if (selling) {
        return selling.id;
    }
    const main = await storeLocationRepository.getDefaultReceivingStore(conn);
    if (!main) {
        throw new ValidationError(
            'No SELLING or MAIN store configured for adjustments. Run store network setup.',
        );
    }
    return main.id;
}

async function resolveProductLotForAdjustment(
    client: PoolClient,
    params: StoreAdjustmentParams,
    documentId?: string,
    resolvedUnitCost?: number,
): Promise<string> {
    if (params.productLotId) {
        return params.productLotId;
    }

    if (params.batchId) {
        const byBatch = await client.query<{ id: string }>(
            `SELECT id FROM product_lots
             WHERE inventory_batch_id = $1 AND product_id = $2
             ORDER BY created_at ASC
             LIMIT 1`,
            [params.batchId, params.productId],
        );
        if (byBatch.rows[0]?.id) {
            return byBatch.rows[0].id;
        }
    }

    if (params.direction === 'OUT') {
        return selectFefoLotAtStore(client, params.storeLocationId, params.productId);
    }

    return resolveOrCreateLotForIncrease(
        client,
        params.storeLocationId,
        params.productId,
        params.batchId,
        params.userId,
        documentId,
        resolvedUnitCost,
    );
}

async function selectFefoLotAtStore(
    client: PoolClient,
    storeLocationId: string,
    productId: string,
): Promise<string> {
    const result = await client.query<{ product_lot_id: string }>(
        `SELECT ib.product_lot_id
         FROM inventory_balances ib
         INNER JOIN product_lots pl ON pl.id = ib.product_lot_id
         WHERE ib.store_location_id = $1
           AND ib.product_id = $2
           AND pl.status = 'ACTIVE'
           AND NOT ib.blocked
           AND (ib.quantity_on_hand - ib.quantity_reserved - ib.quantity_committed) > 0
         ORDER BY pl.expiry_date ASC NULLS LAST, pl.lot_number ASC
         LIMIT 1
         FOR UPDATE OF ib`,
        [storeLocationId, productId],
    );

    if (result.rows.length === 0) {
        throw new ValidationError('No sellable lot found at the selected store for this product');
    }

    return result.rows[0].product_lot_id;
}

async function resolveOrCreateLotForIncrease(
    client: PoolClient,
    storeLocationId: string,
    productId: string,
    batchId?: string,
    userId?: string,
    documentId?: string,
    resolvedUnitCost?: number,
): Promise<string> {
    const existingAtStore = await client.query<{ product_lot_id: string }>(
        `SELECT ib.product_lot_id
         FROM inventory_balances ib
         INNER JOIN product_lots pl ON pl.id = ib.product_lot_id
         WHERE ib.store_location_id = $1
           AND ib.product_id = $2
           AND pl.status = 'ACTIVE'
         ORDER BY pl.expiry_date ASC NULLS LAST, pl.lot_number ASC
         LIMIT 1`,
        [storeLocationId, productId],
    );
    if (existingAtStore.rows.length > 0) {
        return existingAtStore.rows[0].product_lot_id;
    }

    const batchResult = await client.query<{ id: string; batch_number: string; cost_price: string }>(
        batchId
            ? `SELECT id, batch_number, cost_price FROM inventory_batches WHERE id = $1`
            : `SELECT id, batch_number, cost_price
               FROM inventory_batches
               WHERE product_id = $1 AND status = 'ACTIVE'
               ORDER BY received_date ASC NULLS LAST
               LIMIT 1`,
        batchId ? [batchId] : [productId],
    );

    const batch = batchResult.rows[0];
    if (!batch) {
        if (!userId) {
            throw new ValidationError('No inventory batch found to link adjustment lot');
        }

        const created = await lotService.receiveLot(client, {
            productId,
            lotNumber: `ADJ-${(documentId ?? Date.now().toString()).slice(0, 12)}`,
            quantity: 0,
            costPrice: resolvedUnitCost && resolvedUnitCost > 0 ? resolvedUnitCost : 0,
            attributes: {
                receivedDate: new Date().toISOString().slice(0, 10),
                expiryDate: null,
            },
            sourceType: 'ADJUSTMENT',
            targetStoreLocationId: storeLocationId,
            userId,
        });

        const createdProjectionId = await ensureProjectionFromMaster(client, created.id);
        if (!createdProjectionId) {
            throw new ValidationError('Failed to create lot projection for adjustment');
        }
        return createdProjectionId;
    }

    const productLotId = await ensureProjectionFromMaster(client, batch.id);
    if (!productLotId) {
        throw new ValidationError('Failed to sync lot projection from batch master');
    }

    return productLotId;
}

async function resolveIncreaseUnitCost(
    client: PoolClient,
    productId: string,
    explicitUnitCost?: number,
): Promise<number | undefined> {
    if (explicitUnitCost && explicitUnitCost > 0) {
        return explicitUnitCost;
    }

    const costRow = await client.query(
        'SELECT cost_price FROM product_valuation WHERE product_id = $1',
        [productId],
    );
    const dbCost = costRow.rows[0]?.cost_price;
    if (dbCost && parseFloat(String(dbCost)) > 0) {
        return parseFloat(String(dbCost));
    }
    return undefined;
}

function mapMovementType(
    reason: AdjustmentReason,
    direction: AdjustmentDirection,
): StockMovementType {
    switch (reason) {
        case 'DAMAGE':
            return 'DAMAGE';
        case 'EXPIRY':
            return 'EXPIRY';
        case 'PHYSICAL_COUNT':
            return direction === 'IN' ? 'ADJUSTMENT_IN' : 'ADJUSTMENT_OUT';
        case 'WRITE_OFF':
            return 'ADJUSTMENT_OUT';
        case 'ADJUSTMENT':
        default:
            return direction === 'IN' ? 'ADJUSTMENT_IN' : 'ADJUSTMENT_OUT';
    }
}

export const warehouseAdjustmentService = {
    async resolveStoreLocationId(conn: Pool | PoolClient, storeLocationId?: string): Promise<string> {
        if (storeLocationId) {
            const store = await storeLocationRepository.getById(conn, storeLocationId);
            if (!store?.isActive) {
                throw new ValidationError('Selected store is not active');
            }
            return storeLocationId;
        }
        return resolveDefaultStoreId(conn as PoolClient);
    },

    async adjustAtStore(conn: DbConnection, params: StoreAdjustmentParams) {
        if (!(await isMultistoreEnabled(conn))) {
            throw new ValidationError('Store-scoped adjustments require multistore mode');
        }

        const adjusted = await UnitOfWork.runOrJoin(conn, async (client) => {
            const store = await storeLocationRepository.getById(client, params.storeLocationId);
            if (!store?.isActive) {
                throw new ValidationError('Selected store is not active');
            }

            let documentId = params.documentId;
            if (!documentId) {
                const year = getBusinessYear();
                const seqResult = await client.query(`SELECT nextval('adj_doc_seq') AS seq`);
                const seq = String(seqResult.rows[0].seq).padStart(5, '0');
                const documentNumber = `ADJ-${year}-${seq}`;

                const docResult = await client.query(
                    `INSERT INTO inventory_adjustment_documents (document_number, reason, notes, created_by)
                     VALUES ($1, $2, $3, $4)
                     RETURNING id`,
                    [documentNumber, params.reason, params.notes, params.userId],
                );
                documentId = docResult.rows[0].id as string;
            }

            const resolvedIncomingUnitCost =
                params.direction === 'IN'
                    ? await resolveIncreaseUnitCost(client, params.productId, params.unitCost)
                    : params.unitCost;

            await alignBatchSubledgerToStoreBalances(client, params.productId);

            const productLotId = await resolveProductLotForAdjustment(
                client,
                params,
                documentId,
                resolvedIncomingUnitCost,
            );

            const lot = await productLotRepository.getById(client, productLotId);
            if (!lot || lot.productId !== params.productId) {
                throw new ValidationError('Product lot not found for this product');
            }

            const batchId = params.batchId ?? lot.inventoryBatchId ?? undefined;
            if (
                params.batchId &&
                lot.inventoryBatchId &&
                params.batchId !== lot.inventoryBatchId
            ) {
                throw new ValidationError(
                    'Selected batch does not match the store lot for this adjustment',
                );
            }

            // OUT must have sellable qty at the chosen store — never debit another store silently.
            if (params.direction === 'OUT') {
                const sellableRes = await client.query<{ sellable: string }>(
                    `SELECT GREATEST(
                       COALESCE(ib.quantity_on_hand, 0)
                         - COALESCE(ib.quantity_reserved, 0)
                         - COALESCE(ib.quantity_committed, 0),
                       0
                     )::text AS sellable
                     FROM inventory_balances ib
                     WHERE ib.store_location_id = $1
                       AND ib.product_lot_id = $2
                       AND NOT ib.blocked`,
                    [params.storeLocationId, productLotId],
                );
                const sellable = parseFloat(sellableRes.rows[0]?.sellable ?? '0');
                if (!(sellable >= params.quantity - 0.0001)) {
                    throw new ValidationError(
                        `Insufficient sellable stock at store ${store.code} for this lot ` +
                            `(available ${sellable.toFixed(2)}, requested ${params.quantity.toFixed(2)}). ` +
                            `Switch the Adjustments store to where the stock sits (usually SELLING), ` +
                            `or transfer stock first.`,
                    );
                }
            }

            // DAMAGE quarantine = internal store transfer only. Batch total and GL stay unchanged
            // until a later write-off/disposal consumes stock from the DAMAGE location.
            if (params.reason === 'DAMAGE' && params.direction === 'OUT') {
                const damageStore = await ensureDamageStore(client);
                await warehouseInventoryRepository.moveLotQuantityBetweenStores(client, {
                    fromStoreId: params.storeLocationId,
                    toStoreId: damageStore.id,
                    productId: params.productId,
                    productLotId,
                    quantity: params.quantity,
                });

                const resolvedUnitCost =
                    params.unitCost && params.unitCost > 0
                        ? params.unitCost
                        : await resolveBatchUnitCost(client, batchId);

                const storeTag = `[store:${store.code}→${damageStore.code}]`;
                const movement = await recordMovement(client, {
                    productId: params.productId,
                    batchId: batchId ?? null,
                    movementType: 'DAMAGE',
                    quantity: params.quantity,
                    unitCost: resolvedUnitCost ?? null,
                    referenceType: 'ADJ_DOC',
                    referenceId: documentId,
                    notes: `${params.reason}: ${params.notes} ${storeTag} (internal quarantine transfer)`,
                    createdBy: params.userId,
                    economicEvent: 'QUARANTINE_TRANSFER',
                    postsGl: false,
                });

                // LQ-INV-4 / LQ-INV-5: mark lot QUARANTINED when no sellable qty remains
                await syncLotStatusAfterQuarantine(client, {
                    inventoryBatchId: batchId ?? lot.inventoryBatchId,
                    productLotId,
                    quarantineKind: 'DAMAGE',
                    userId: params.userId,
                });

                await assertWarehouseLayerConsistent(
                    client,
                    'damageQuarantineTransfer',
                    params.productId,
                );

                return {
                    documentId,
                    storeLocationId: params.storeLocationId,
                    productLotId,
                    quarantineStoreId: damageStore.id,
                    movementId: movement.id,
                    movementNumber: movement.movementNumber,
                    batchId: batchId ?? null,
                    actualQuantityChanged: params.quantity,
                };
            }

            // EXPIRY quarantine = internal transfer to EXPIRED store (no P&L until dispose).
            if (params.reason === 'EXPIRY' && params.direction === 'OUT') {
                const expiredStore = await ensureExpiredStore(client);
                await warehouseInventoryRepository.moveLotQuantityBetweenStores(client, {
                    fromStoreId: params.storeLocationId,
                    toStoreId: expiredStore.id,
                    productId: params.productId,
                    productLotId,
                    quantity: params.quantity,
                });

                const resolvedUnitCost =
                    params.unitCost && params.unitCost > 0
                        ? params.unitCost
                        : await resolveBatchUnitCost(client, batchId);

                const storeTag = `[store:${store.code}→${expiredStore.code}]`;
                const movement = await recordMovement(client, {
                    productId: params.productId,
                    batchId: batchId ?? null,
                    movementType: 'EXPIRY',
                    quantity: params.quantity,
                    unitCost: resolvedUnitCost ?? null,
                    referenceType: 'ADJ_DOC',
                    referenceId: documentId,
                    notes: `${params.reason}: ${params.notes} ${storeTag} (internal quarantine transfer)`,
                    createdBy: params.userId,
                    economicEvent: 'QUARANTINE_TRANSFER',
                    postsGl: false,
                });

                await syncLotStatusAfterQuarantine(client, {
                    inventoryBatchId: batchId ?? lot.inventoryBatchId,
                    productLotId,
                    quarantineKind: 'EXPIRED',
                    userId: params.userId,
                });

                await assertWarehouseLayerConsistent(
                    client,
                    'expiryQuarantineTransfer',
                    params.productId,
                );

                return {
                    documentId,
                    storeLocationId: params.storeLocationId,
                    productLotId,
                    quarantineStoreId: expiredStore.id,
                    movementId: movement.id,
                    movementNumber: movement.movementNumber,
                    batchId: batchId ?? null,
                    actualQuantityChanged: params.quantity,
                };
            }

            // OUT qty is owned by StockMovementHandler → consumeLot (store dual-write).
            // Do NOT pre-adjust balances here — that caused silent INV-002 drift when
            // processMovement only mutated the batch master.

            const movementType = mapMovementType(params.reason, params.direction);
            let referenceType = 'ADJ_DOC';
            if (params.reason === 'PHYSICAL_COUNT') referenceType = 'PHYSICAL_COUNT';
            if (params.reason === 'WRITE_OFF') referenceType = 'WRITE_OFF';

            let resolvedUnitCost = params.unitCost;
            if (movementType === 'ADJUSTMENT_IN' && (!resolvedUnitCost || resolvedUnitCost <= 0)) {
                resolvedUnitCost = resolvedIncomingUnitCost;
            }
            if (
                (movementType === 'DAMAGE' || movementType === 'EXPIRY') &&
                (!resolvedUnitCost || resolvedUnitCost <= 0)
            ) {
                resolvedUnitCost = await resolveBatchUnitCost(client, batchId);
            }

            const storeTag = `[store:${store.code}]`;

            // LQ-INV-7: WRITE_OFF from DAMAGE/EXPIRED posts 5120/5130 (not silent 5110)
            let effectiveMovementType = movementType;
            let expenseAccountCode: string | undefined;
            let allowDisposalStatuses = false;
            if (params.reason === 'WRITE_OFF' && params.direction === 'OUT') {
                const { resolveWriteOffPosting } = await import(
                    '../../loss-quarantine/lossDisposalService.js'
                );
                const posting = resolveWriteOffPosting(store.storeType);
                effectiveMovementType = posting.movementType;
                expenseAccountCode = posting.expenseAccountCode;
                allowDisposalStatuses =
                    store.storeType === 'DAMAGE' ||
                    store.storeType === 'EXPIRED' ||
                    store.storeType === 'RETURN';
            }

            const handlerPool = UnitOfWork.isPool(conn) ? conn : defaultPool;
            const handler = new StockMovementHandler(handlerPool);
            const result = await handler.processMovement(
                {
                    productId: params.productId,
                    batchId,
                    movementType: effectiveMovementType,
                    quantity: params.quantity,
                    unitCost: resolvedUnitCost,
                    targetStoreLocationId:
                        params.direction === 'IN' ? params.storeLocationId : undefined,
                    sourceStoreLocationId:
                        params.direction === 'OUT' ? params.storeLocationId : undefined,
                    reason: `${params.reason}: ${params.notes} ${storeTag}`,
                    referenceType,
                    referenceId: documentId,
                    userId: params.userId,
                    expenseAccountCode,
                    allowDisposalStatuses,
                },
                client,
            );

            return {
                documentId,
                storeLocationId: params.storeLocationId,
                productLotId: productLotId ?? null,
                ...result,
            };
        });
        if (UnitOfWork.isPool(conn)) {
            publishNotificationEvent({
                pool: conn,
                typeKey: 'INVENTORY_ADJUSTED',
                entityType: 'inventory_adjustment',
                entityId: String(adjusted.documentId),
                idempotencyKey: `INVENTORY_ADJUSTED:inventory_adjustment:${adjusted.documentId}`,
                payload: {
                    summary: `Inventory adjusted (${params.reason})`,
                    documentRef: String(adjusted.documentId),
                },
                actorUserId: params.userId,
                storeLocationId: params.storeLocationId,
            });
        }
        return adjusted;
    },
};
