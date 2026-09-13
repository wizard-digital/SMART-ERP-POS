import type { Pool, PoolClient } from 'pg';

import { UnitOfWork } from '../../../db/unitOfWork.js';

import { ValidationError } from '../../../middleware/errorHandler.js';

import { isMultistoreEnabled, type DbConn } from './multistoreSettings.js';

import { storeLocationRepository } from './storeLocationRepository.js';

import { storeTransferRepository } from './storeTransferRepository.js';

import { warehouseInventoryRepository } from './warehouseInventoryRepository.js';

import type { CreateStoreTransferDto, StoreTransfer, ApproveTransferDto, DispatchTransferDto, ReceiveTransferDto, CancelTransferDto } from '../../../../../shared/types/storeTransfer.js';

import { productLotRepository } from './productLotRepository.js';

import { transferPolicyService } from './transferPolicyService.js';

import {

    buildWorkflowCapabilities,

    permissionForWorkflowMode,

    resolveCreateWorkflowMode,

    type TransferWorkflowContext,

} from './transferWorkflowService.js';

import type { TransferWorkflowCapabilities } from '../../../../../shared/types/transferWorkflow.js';

import { TRANSFER_PERMISSION_KEYS } from '../../../../../shared/types/transferWorkflow.js';

import { transferAssortmentService } from './transferAssortmentService.js';
import { assertWarehouseLayerConsistentForProducts } from '../../../services/warehouseInventoryCoupling.js';
import { publishNotificationEvent } from '../../notifications/notificationPublisher.js';
import { recordMovement } from '../../stock-movements/stockMovementRepository.js';
import { syncLotStatusAfterQuarantine } from '../../loss-quarantine/quarantineLotStatus.js';
import {
    deriveStatusAfterApproval,
    deriveStatusAfterDispatch,
    deriveStatusAfterReceive,
    effectiveApprovedQty,
    remainingToDispatch,
    remainingToReceive,
} from '../../../../../shared/utils/transferNegotiation.js';

export interface TransferActorContext {

    userId?: string;

    userRole?: string;

    permissions: Set<string>;

}



async function estimateTransferTotals(

    conn: DbConn,

    lines: Array<{ productLotId: string; quantity: number; productId: string }>,

): Promise<{ totalQty: number; totalInventoryValue: number }> {

    let totalQty = 0;

    let totalInventoryValue = 0;



    for (const line of lines) {

        totalQty += line.quantity;

        const costResult = await conn.query<{ average_cost: string | null }>(

            `SELECT COALESCE(NULLIF(pv.average_cost, 0), pv.cost_price) AS average_cost

             FROM product_valuation pv

             WHERE pv.product_id = $1`,

            [line.productId],

        );

        const cost = parseFloat(costResult.rows[0]?.average_cost ?? '0') || 0;

        totalInventoryValue += cost * line.quantity;

    }



    return { totalQty, totalInventoryValue };

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

async function logTransferEvent(

    conn: DbConn,

    transfer: StoreTransfer,

    eventType: string,

    actor: TransferActorContext,

    permissionUsed?: string,

    payload?: Record<string, unknown>,

): Promise<void> {

    await storeTransferRepository.logAuditEvent(conn, {

        storeTransferId: transfer.id,

        eventType,

        workflowMode: transfer.workflowMode,

        permissionUsed: permissionUsed ?? transfer.permissionUsed ?? null,

        userId: actor.userId ?? null,

        userRole: actor.userRole ?? null,

        payload: payload ?? {},

    });

}



async function applyAssortmentExpansionsOnComplete(

    client: PoolClient,

    transfer: StoreTransfer,

    actor: TransferActorContext,

): Promise<void> {

    const decisions = transfer.assortmentExpansionDecisions ?? [];

    const applied = await transferAssortmentService.applyPermanentExpansions(

        client,

        transfer.destinationStoreId,

        decisions,

    );

    if (applied.length > 0) {

        await logTransferEvent(client, transfer, 'ASSORTMENT_EXPANDED', actor, undefined, {

            expansions: applied,

        });

    }

}



export const storeTransferService = {

    async assertMultistore(conn: DbConn): Promise<void> {

        if (!(await isMultistoreEnabled(conn))) {

            throw new ValidationError(

                'Store transfers require is_multistore_enabled = true on system_settings.',

            );

        }

    },



    async getWorkflowCapabilities(

        pool: Pool,

        permissions: Set<string>,

    ): Promise<TransferWorkflowCapabilities> {

        const policy = await transferPolicyService.getPolicy(pool);

        return buildWorkflowCapabilities(permissions, policy);

    },



    async previewTransferAssortment(

        pool: Pool,

        destinationStoreId: string,

        lines: Array<{ productLotId: string; quantity: number }>,

    ) {

        return UnitOfWork.run(pool, async (client) => {

            await storeTransferService.assertMultistore(client);

            const productIds: string[] = [];

            for (const line of lines) {

                const lot = await productLotRepository.getById(client, line.productLotId);

                if (!lot) {

                    throw new ValidationError(`Product lot ${line.productLotId} not found`);

                }

                productIds.push(lot.productId);

            }

            return transferAssortmentService.preview(client, destinationStoreId, productIds);

        });

    },



    async createTransfer(

        pool: Pool,

        dto: CreateStoreTransferDto,

        actor: TransferActorContext,

    ): Promise<StoreTransfer> {

        const created = await UnitOfWork.run(pool, async (client) => {

            await storeTransferService.assertMultistore(client);



            if (!dto.lines?.length) {

                throw new ValidationError('Transfer must have at least one line');

            }



            const { main, transit, selling } = await storeLocationRepository.ensureDefaultNetworkStores(client);

            const destinationStoreId = dto.destinationStoreId ?? selling.id;



            const destStore = await storeLocationRepository.getById(client, destinationStoreId);

            if (!destStore?.isActive || destStore.storeType !== 'SELLING') {

                throw new ValidationError('Destination must be an active SELLING store');

            }



            const resolvedLines: Array<{

                productId: string;

                productLotId: string;

                quantity: number;

            }> = [];

            for (const line of dto.lines) {

                const lot = await productLotRepository.getById(client, line.productLotId);

                if (!lot) {

                    throw new ValidationError(`Product lot ${line.productLotId} not found`);

                }

                resolvedLines.push({

                    productId: lot.productId,

                    productLotId: line.productLotId,

                    quantity: line.quantity,

                });

            }



            const productIds = resolvedLines.map((line) => line.productId);

            const assortmentPreview = await transferAssortmentService.preview(

                client,

                destinationStoreId,

                productIds,

            );

            const assortmentExpansionDecisions = transferAssortmentService.resolveExpansionDecisions(

                assortmentPreview.policy,

                assortmentPreview.gaps,

                dto.assortmentExpansions,

            );



            const policy = await transferPolicyService.getPolicy(client);

            const totals = await estimateTransferTotals(client, resolvedLines);



            const workflowCtx: TransferWorkflowContext = {

                permissions: actor.permissions,

                policy,

                dto,

                sourceStore: main,

                destinationStore: destStore,

                totalQty: totals.totalQty,

                totalInventoryValue: totals.totalInventoryValue,

            };



            let workflowMode: ReturnType<typeof resolveCreateWorkflowMode>;

            try {

                workflowMode = resolveCreateWorkflowMode(workflowCtx);

            } catch (err) {

                throw new ValidationError(

                    err instanceof Error ? err.message : 'Cannot create transfer',

                );

            }



            const permissionUsed = permissionForWorkflowMode(workflowMode);

            const transferNumber = await storeTransferRepository.generateTransferNumber(client);



            if (workflowMode === 'DIRECT' || workflowMode === 'EMERGENCY_OVERRIDE') {

                return storeTransferService.executeImmediateTransfer(client, {

                    transferNumber,

                    main,

                    transit,

                    destStore,

                    dto,

                    resolvedLines,

                    workflowMode,

                    permissionUsed,

                    totals,

                    actor,

                    assortmentExpansionDecisions,

                });

            }



            const transfer = await storeTransferRepository.createTransfer(client, {

                transferNumber,

                sourceStoreId: main.id,

                transitStoreId: transit.id,

                destinationStoreId,

                notes: dto.notes,

                createdById: actor.userId,

                workflowMode,

                totalInventoryValue: totals.totalInventoryValue,

                permissionUsed,

                assortmentExpansionDecisions,

            });



            const insertedLines = await storeTransferRepository.addLines(client, transfer.id, resolvedLines);

            const full = { ...transfer, lines: insertedLines };



            await logTransferEvent(client, full, 'CREATED', actor, permissionUsed, {

                totalQty: totals.totalQty,

                totalInventoryValue: totals.totalInventoryValue,

            });



            return full;

        });

        publishNotificationEvent({

            pool,

            typeKey: 'STOCK_TRANSFER_REQUESTED',

            entityType: 'store_transfer',

            entityId: created.id,

            idempotencyKey: `STOCK_TRANSFER_REQUESTED:store_transfer:${created.id}`,

            payload: {

                summary: `Stock transfer ${created.transferNumber} requested`,

                documentRef: created.transferNumber,

            },

            actorUserId: actor.userId,

            storeLocationId: created.sourceStoreId || created.destinationStoreId || null,

        });

        if (created.status === 'RECEIVED') {

            publishNotificationEvent({

                pool,

                typeKey: 'STOCK_TRANSFER_COMPLETED',

                entityType: 'store_transfer',

                entityId: created.id,

                idempotencyKey: `STOCK_TRANSFER_COMPLETED:store_transfer:${created.id}`,

                payload: {

                    summary: `Stock transfer ${created.transferNumber} completed`,

                    documentRef: created.transferNumber,

                },

                actorUserId: actor.userId,

                storeLocationId: created.destinationStoreId || created.sourceStoreId || null,

            });

        }

        return created;

    },



    async executeImmediateTransfer(

        client: PoolClient,

        params: {

            transferNumber: string;

            main: { id: string };

            transit: { id: string };

            destStore: { id: string };

            dto: CreateStoreTransferDto;

            resolvedLines: Array<{ productId: string; productLotId: string; quantity: number }>;

            workflowMode: 'DIRECT' | 'EMERGENCY_OVERRIDE';

            permissionUsed: string;

            totals: { totalQty: number; totalInventoryValue: number };

            actor: TransferActorContext;

            assortmentExpansionDecisions: Array<{ productId: string; expandPermanently: boolean }>;

        },

    ): Promise<StoreTransfer> {

        const {

            transferNumber,

            main,

            transit,

            destStore,

            dto,

            resolvedLines,

            workflowMode,

            permissionUsed,

            totals,

            actor,

            assortmentExpansionDecisions,

        } = params;



        for (const line of resolvedLines) {

            const available = await warehouseInventoryRepository.getSellableQuantityAtStore(

                client,

                main.id,

                line.productLotId,

            );

            if (available < line.quantity) {

                throw new ValidationError(

                    `Insufficient stock at MAIN for lot ${line.productLotId}. ` +

                        `Available ${available}, requested ${line.quantity}.`,

                );

            }

        }



        const transfer = await storeTransferRepository.createTransfer(client, {

            transferNumber,

            sourceStoreId: main.id,

            transitStoreId: transit.id,

            destinationStoreId: destStore.id,

            notes: dto.notes,

            createdById: actor.userId,

            workflowMode,

            overrideReason: dto.overrideReason ?? null,

            overrideComments: dto.overrideComments ?? null,

            totalInventoryValue: totals.totalInventoryValue,

            permissionUsed,

            initialStatus: 'APPROVED',

            assortmentExpansionDecisions,

        });



        const insertedLines = await storeTransferRepository.addLines(client, transfer.id, resolvedLines);

        const current = { ...transfer, lines: insertedLines };



        await logTransferEvent(client, current, 'CREATED', actor, permissionUsed, {

            workflowMode,

            totalQty: totals.totalQty,

            totalInventoryValue: totals.totalInventoryValue,

            overrideReason: dto.overrideReason ?? null,

        });



        for (const line of insertedLines) {

            await warehouseInventoryRepository.moveLotQuantityBetweenStores(client, {

                fromStoreId: main.id,

                toStoreId: transit.id,

                productId: line.productId,

                productLotId: line.productLotId,

                quantity: line.quantity,

                trackTransferMetrics: true,

            });

            await storeTransferRepository.markLineDispatched(client, line.id, line.quantity);

        }



        await storeTransferRepository.updateStatus(client, transfer.id, 'IN_TRANSIT', {

            dispatchedById: actor.userId,

            approvedById: actor.userId,

            executedById: actor.userId,

        });



        await logTransferEvent(client, current, 'INVENTORY_DEDUCTED', actor, permissionUsed);



        const locked = await storeTransferRepository.getByIdForUpdate(client, transfer.id);

        if (!locked?.lines) throw new ValidationError('Transfer not found after dispatch');



        for (const line of locked.lines) {

            const qtyToReceive = line.quantityDispatched - line.quantityReceived;

            if (qtyToReceive <= 0) continue;



            await warehouseInventoryRepository.moveLotQuantityBetweenStores(client, {

                fromStoreId: transit.id,

                toStoreId: destStore.id,

                productId: line.productId,

                productLotId: line.productLotId,

                quantity: qtyToReceive,

                trackTransferMetrics: true,

            });

            await storeTransferRepository.markLineReceived(client, line.id, qtyToReceive);

        }



        await storeTransferRepository.updateStatus(client, transfer.id, 'RECEIVED', {

            receivedById: actor.userId,

            executedById: actor.userId,

            completedAt: true,

        });



        const completed = await storeTransferRepository.getById(client, transfer.id);

        if (!completed) throw new ValidationError('Transfer not found after completion');



        await applyAssortmentExpansionsOnComplete(client, completed, actor);

        await assertWarehouseLayerConsistentForProducts(
            client,
            `store transfer ${completed.transferNumber} complete`,
            (completed.lines ?? []).map((l) => l.productId),
        );

        await logTransferEvent(client, completed, 'COMPLETED', actor, permissionUsed, {

            workflowMode,

            overrideReason: dto.overrideReason ?? null,

        });



        if (workflowMode === 'EMERGENCY_OVERRIDE') {

            await logTransferEvent(client, completed, 'OVERRIDE_EXECUTED', actor, permissionUsed, {

                overrideReason: dto.overrideReason,

                overrideComments: dto.overrideComments,

            });

        }



        return completed;

    },



    async saveApprovalDraft(

        pool: Pool,

        transferId: string,

        actor: TransferActorContext,

        dto?: ApproveTransferDto,

    ): Promise<StoreTransfer> {

        return UnitOfWork.run(pool, async (client) => {

            await storeTransferService.assertMultistore(client);



            const transfer = await storeTransferRepository.getByIdForUpdate(client, transferId);

            if (!transfer) throw new ValidationError('Transfer not found');

            if (transfer.status !== 'DRAFT') {

                throw new ValidationError(`Cannot save approval draft in status ${transfer.status}`);

            }

            if (transfer.workflowMode !== 'REQUEST') {

                throw new ValidationError('Approval drafts apply only to stock requests');

            }



            const lineInputs = new Map(

                (dto?.lines ?? []).map((l) => [l.lineId, l]),

            );



            for (const line of transfer.lines ?? []) {

                const input = lineInputs.get(line.id);

                const qtyApproved = input?.quantity ?? line.quantityApproved ?? line.quantity;

                if (qtyApproved < 0) {

                    throw new ValidationError(`Approved quantity cannot be negative for line ${line.lineNumber}`);

                }

                if (qtyApproved > line.quantity + 0.0001) {

                    throw new ValidationError(

                        `Approved quantity ${qtyApproved} exceeds requested ${line.quantity} on line ${line.lineNumber}`,

                    );

                }



                await storeTransferRepository.setLineApproval(

                    client,

                    line.id,

                    qtyApproved,

                    input?.comment,

                );

            }



            const refreshed = await storeTransferRepository.getByIdForUpdate(client, transferId);



            await logTransferEvent(

                client,

                refreshed!,

                'APPROVAL_DRAFT_SAVED',

                actor,

                TRANSFER_PERMISSION_KEYS.APPROVE,

                {

                    lines: (refreshed?.lines ?? []).map((l) => ({

                        lineId: l.id,

                        requested: l.quantity,

                        approved: l.quantityApproved,

                        comment: l.approvalComment,

                    })),

                },

            );



            return (await storeTransferRepository.getById(client, transferId))!;

        });

    },



    async approveTransfer(

        pool: Pool,

        transferId: string,

        actor: TransferActorContext,

        dto?: ApproveTransferDto,

    ): Promise<StoreTransfer> {

        const approved = await UnitOfWork.run(pool, async (client) => {

            await storeTransferService.assertMultistore(client);



            const transfer = await storeTransferRepository.getByIdForUpdate(client, transferId);

            if (!transfer) throw new ValidationError('Transfer not found');

            if (transfer.status !== 'DRAFT') {

                throw new ValidationError(`Cannot approve transfer in status ${transfer.status}`);

            }



            const lineInputs = new Map(

                (dto?.lines ?? []).map((l) => [l.lineId, l]),

            );



            for (const line of transfer.lines ?? []) {

                const input = lineInputs.get(line.id);

                const qtyApproved = input?.quantity ?? line.quantityApproved ?? line.quantity;

                if (qtyApproved < 0) {

                    throw new ValidationError(`Approved quantity cannot be negative for line ${line.lineNumber}`);

                }

                if (qtyApproved > line.quantity + 0.0001) {

                    throw new ValidationError(

                        `Approved quantity ${qtyApproved} exceeds requested ${line.quantity} on line ${line.lineNumber}`,

                    );

                }

                if (qtyApproved > 0) {

                    const available = await warehouseInventoryRepository.getSellableQuantityAtStore(

                        client,

                        transfer.sourceStoreId,

                        line.productLotId,

                    );

                    if (available < qtyApproved) {

                        throw new ValidationError(

                            `Insufficient stock at MAIN for line ${line.lineNumber}. ` +

                                `Available ${available}, approved ${qtyApproved}.`,

                        );

                    }

                }



                await storeTransferRepository.setLineApproval(

                    client,

                    line.id,

                    qtyApproved,

                    input?.comment,

                );

            }



            const refreshed = await storeTransferRepository.getByIdForUpdate(client, transferId);

            const nextStatus = deriveStatusAfterApproval(refreshed?.lines ?? []);



            const updated = await storeTransferRepository.updateStatus(client, transferId, nextStatus, {

                approvedById: actor.userId,

            });



            await logTransferEvent(

                client,

                updated,

                nextStatus === 'CANCELLED'
                    ? 'REJECTED'
                    : nextStatus === 'PARTIALLY_APPROVED'
                      ? 'PARTIALLY_APPROVED'
                      : 'APPROVED',

                actor,

                TRANSFER_PERMISSION_KEYS.APPROVE,

                {

                    lines: (refreshed?.lines ?? []).map((l) => ({

                        lineId: l.id,

                        requested: l.quantity,

                        approved: l.quantityApproved,

                        comment: l.approvalComment,

                    })),

                },

            );



            return (await storeTransferRepository.getById(client, transferId))!;

        });

        publishNotificationEvent({

            pool,

            typeKey: 'STOCK_TRANSFER_APPROVED',

            entityType: 'store_transfer',

            entityId: approved.id,

            idempotencyKey: `STOCK_TRANSFER_APPROVED:store_transfer:${approved.id}`,

            payload: {

                summary: `Stock transfer ${approved.transferNumber} approved`,

                documentRef: approved.transferNumber,

            },

            actorUserId: actor.userId,

            storeLocationId: approved.sourceStoreId || approved.destinationStoreId || null,

        });

        return approved;

    },



    async dispatchTransfer(

        pool: Pool,

        transferId: string,

        actor: TransferActorContext,

        dto?: DispatchTransferDto,

    ): Promise<StoreTransfer> {

        return UnitOfWork.run(pool, async (client) => {

            await storeTransferService.assertMultistore(client);



            const transfer = await storeTransferRepository.getByIdForUpdate(client, transferId);

            if (!transfer) throw new ValidationError('Transfer not found');

            if (!['APPROVED', 'PARTIALLY_APPROVED', 'PARTIALLY_DISPATCHED'].includes(transfer.status)) {

                throw new ValidationError(`Cannot dispatch transfer in status ${transfer.status}`);

            }



            const lineInputs = new Map(

                (dto?.lines ?? []).map((l) => [l.lineId, l]),

            );



            for (const line of transfer.lines ?? []) {

                const remaining = remainingToDispatch(line);

                if (remaining <= 0) continue;



                const input = lineInputs.get(line.id);

                const qtyToMove = input?.quantity ?? remaining;

                if (qtyToMove <= 0) continue;

                if (qtyToMove > remaining + 0.0001) {

                    throw new ValidationError(

                        `Dispatch quantity ${qtyToMove} exceeds remaining ${remaining} on line ${line.lineNumber}`,

                    );

                }



                const available = await warehouseInventoryRepository.getSellableQuantityAtStore(

                    client,

                    transfer.sourceStoreId,

                    line.productLotId,

                );

                if (available < qtyToMove) {

                    throw new ValidationError(

                        `Insufficient stock at MAIN for line ${line.lineNumber}. ` +

                            `Available ${available}, dispatch ${qtyToMove}.`,

                    );

                }



                await warehouseInventoryRepository.moveLotQuantityBetweenStores(client, {

                    fromStoreId: transfer.sourceStoreId,

                    toStoreId: transfer.transitStoreId,

                    productId: line.productId,

                    productLotId: line.productLotId,

                    quantity: qtyToMove,

                    trackTransferMetrics: true,

                });



                await storeTransferRepository.markLineDispatched(client, line.id, qtyToMove);

                await storeTransferRepository.setLineDispatchComment(client, line.id, input?.comment);

            }



            const refreshed = await storeTransferRepository.getByIdForUpdate(client, transferId);

            const nextStatus = deriveStatusAfterDispatch(refreshed?.lines ?? []);



            await storeTransferRepository.updateStatus(client, transferId, nextStatus, {

                dispatchedById: actor.userId,

            });



            const updated = await storeTransferRepository.getById(client, transferId);

            if (!updated) throw new ValidationError('Transfer not found after dispatch');



            await logTransferEvent(

                client,

                updated,

                nextStatus === 'PARTIALLY_DISPATCHED' ? 'PARTIALLY_DISPATCHED' : 'DISPATCHED',

                actor,

                TRANSFER_PERMISSION_KEYS.DISPATCH,

                {

                    lines: (refreshed?.lines ?? []).map((l) => ({

                        lineId: l.id,

                        approved: effectiveApprovedQty(l),

                        dispatched: l.quantityDispatched,

                        comment: l.dispatchComment,

                    })),

                },

            );



            return updated;

        });

    },



    async receiveTransfer(

        pool: Pool,

        transferId: string,

        actor: TransferActorContext,

        dto?: ReceiveTransferDto,

    ): Promise<StoreTransfer> {

        const received = await UnitOfWork.run(pool, async (client) => {

            await storeTransferService.assertMultistore(client);



            const transfer = await storeTransferRepository.getByIdForUpdate(client, transferId);

            if (!transfer) throw new ValidationError('Transfer not found');

            if (

                !['IN_TRANSIT', 'DISPATCHED', 'PARTIALLY_DISPATCHED', 'PARTIALLY_RECEIVED'].includes(

                    transfer.status,

                )

            ) {

                throw new ValidationError(`Cannot receive transfer in status ${transfer.status}`);

            }



            const lineInputs = new Map(

                (dto?.lines ?? []).map((l) => [l.lineId, l]),

            );



            for (const line of transfer.lines ?? []) {

                const inTransit = remainingToReceive(line);

                if (inTransit <= 0) continue;



                const input = lineInputs.get(line.id);

                const qtyToReceive = input?.quantity ?? inTransit;

                if (qtyToReceive <= 0) continue;

                if (qtyToReceive > inTransit + 0.0001) {

                    throw new ValidationError(

                        `Receive quantity ${qtyToReceive} exceeds in-transit ${inTransit} on line ${line.lineNumber}`,

                    );

                }



                const shortageDelta = inTransit - qtyToReceive;



                await warehouseInventoryRepository.moveLotQuantityBetweenStores(client, {

                    fromStoreId: transfer.transitStoreId,

                    toStoreId: transfer.destinationStoreId,

                    productId: line.productId,

                    productLotId: line.productLotId,

                    quantity: qtyToReceive,

                    trackTransferMetrics: true,

                });



                if (shortageDelta > 0.0001) {

                    const damageStore = await ensureDamageStore(client);

                    await warehouseInventoryRepository.moveLotQuantityBetweenStores(client, {

                        fromStoreId: transfer.transitStoreId,

                        toStoreId: damageStore.id,

                        productId: line.productId,

                        productLotId: line.productLotId,

                        quantity: shortageDelta,

                    });

                    const lot = await productLotRepository.getById(client, line.productLotId);
                    const batchId = lot?.inventoryBatchId ?? null;
                    await recordMovement(client, {
                        productId: line.productId,
                        batchId,
                        movementType: 'DAMAGE',
                        quantity: shortageDelta,
                        referenceType: 'STORE_TRANSFER',
                        referenceId: transfer.id,
                        notes: `Transfer receive shortage → ${damageStore.code} (quarantine)`,
                        createdBy: actor.userId ?? transfer.createdById ?? transfer.id,
                        economicEvent: 'QUARANTINE_TRANSFER',
                        postsGl: false,
                    });
                    if (batchId) {
                        await syncLotStatusAfterQuarantine(client, {
                            inventoryBatchId: batchId,
                            productLotId: line.productLotId,
                            quarantineKind: 'DAMAGE',
                            userId: actor.userId ?? transfer.createdById ?? transfer.id,
                        });
                    }

                }



                await storeTransferRepository.markLineReceived(client, line.id, qtyToReceive, {

                    receiveComment: input?.comment,

                    shortageDelta,

                });

            }



            const refreshed = await storeTransferRepository.getByIdForUpdate(client, transferId);

            const nextStatus = deriveStatusAfterReceive(refreshed?.lines ?? []);



            await storeTransferRepository.updateStatus(client, transferId, nextStatus, {

                receivedById: actor.userId,

                completedAt: nextStatus === 'RECEIVED',

            });



            const updated = await storeTransferRepository.getById(client, transferId);

            if (!updated) throw new ValidationError('Transfer not found after receive');



            if (nextStatus === 'RECEIVED') {

                await applyAssortmentExpansionsOnComplete(client, updated, actor);

            }

            await assertWarehouseLayerConsistentForProducts(
                client,
                `store transfer ${updated.transferNumber} received`,
                (updated.lines ?? []).map((l) => l.productId),
            );

            await logTransferEvent(

                client,

                updated,

                nextStatus === 'PARTIALLY_RECEIVED' ? 'PARTIALLY_RECEIVED' : 'RECEIVED',

                actor,

                TRANSFER_PERMISSION_KEYS.RECEIVE,

                {

                    lines: (refreshed?.lines ?? []).map((l) => ({

                        lineId: l.id,

                        dispatched: l.quantityDispatched,

                        received: l.quantityReceived,

                        shortage: l.quantityShortage,

                        comment: l.receiveComment,

                    })),

                },

            );

            if (nextStatus === 'RECEIVED') {

                await logTransferEvent(

                    client,

                    updated,

                    'COMPLETED',

                    actor,

                    TRANSFER_PERMISSION_KEYS.RECEIVE,

                );

            }



            return updated;

        });

        if (received.status === 'RECEIVED') {

            publishNotificationEvent({

                pool,

                typeKey: 'STOCK_TRANSFER_COMPLETED',

                entityType: 'store_transfer',

                entityId: received.id,

                idempotencyKey: `STOCK_TRANSFER_COMPLETED:store_transfer:${received.id}`,

                payload: {

                    summary: `Stock transfer ${received.transferNumber} completed`,

                    documentRef: received.transferNumber,

                },

                actorUserId: actor.userId,

                storeLocationId: received.destinationStoreId || received.sourceStoreId || null,

            });

        }

        return received;

    },



    async completeRequestTransfer(

        pool: Pool,

        transferId: string,

        actor: TransferActorContext,

        dto?: ApproveTransferDto,

    ): Promise<StoreTransfer> {

        const approved = await storeTransferService.approveTransfer(pool, transferId, actor, dto);

        if (approved.status === 'CANCELLED') {

            throw new ValidationError('Cannot complete a rejected request');

        }

        if (!['APPROVED', 'PARTIALLY_APPROVED'].includes(approved.status)) {

            throw new ValidationError(`Cannot complete transfer in status ${approved.status}`);

        }



        const dispatchLines = (approved.lines ?? [])

            .map((l) => ({ lineId: l.id, quantity: remainingToDispatch(l) }))

            .filter((l) => l.quantity > 0.0001);

        if (dispatchLines.length === 0) {

            throw new ValidationError('No approved quantity to dispatch');

        }



        const dispatched = await storeTransferService.dispatchTransfer(pool, transferId, actor, {

            lines: dispatchLines,

        });



        const receiveLines = (dispatched.lines ?? [])

            .map((l) => ({ lineId: l.id, quantity: remainingToReceive(l) }))

            .filter((l) => l.quantity > 0.0001);

        if (receiveLines.length === 0) {

            throw new ValidationError('No in-transit quantity to receive');

        }



        await storeTransferService.receiveTransfer(pool, transferId, actor, {

            lines: receiveLines,

        });



        return UnitOfWork.run(pool, async (client) => {

            const final = await storeTransferRepository.getById(client, transferId);

            if (!final) throw new ValidationError('Transfer not found after completion');

            await logTransferEvent(

                client,

                final,

                'OVERRIDE_EXECUTED',

                actor,

                TRANSFER_PERMISSION_KEYS.OVERRIDE,

                { completedVia: 'REQUEST_COMPLETE' },

            );

            return final;

        });

    },



    async cancelTransfer(

        pool: Pool,

        transferId: string,

        actor: TransferActorContext,

        dto?: CancelTransferDto,

    ): Promise<StoreTransfer> {

        return UnitOfWork.run(pool, async (client) => {

            await storeTransferService.assertMultistore(client);



            const transfer = await storeTransferRepository.getByIdForUpdate(client, transferId);

            if (!transfer) throw new ValidationError('Transfer not found');

            if (transfer.status !== 'DRAFT') {

                throw new ValidationError(`Cannot cancel transfer in status ${transfer.status}`);

            }

            if (transfer.workflowMode !== 'REQUEST') {

                throw new ValidationError('Only request-mode transfers can be cancelled');

            }



            const updated = await storeTransferRepository.updateStatus(client, transferId, 'CANCELLED', {});



            await logTransferEvent(

                client,

                updated,

                'CANCELLED',

                actor,

                TRANSFER_PERMISSION_KEYS.REQUEST,

                { reason: dto?.reason ?? null },

            );



            return (await storeTransferRepository.getById(client, transferId))!;

        });

    },



    async getTransfer(pool: Pool, transferId: string): Promise<StoreTransfer | null> {

        return storeTransferRepository.getById(pool, transferId);

    },



    async listTransfers(pool: Pool, limit = 50): Promise<StoreTransfer[]> {

        return storeTransferRepository.listTransfers(pool, limit);

    },

};


