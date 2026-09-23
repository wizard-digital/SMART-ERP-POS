/**
 * POS Event Replayer
 *
 * THE ONLY place in the server allowed to:
 *   - deduct inventory
 *   - create invoices / sales
 *   - post GL entries
 *   - update order status
 *   - mark events as processed
 *
 * No database triggers. No generated columns. No hidden side effects.
 * All business logic is explicit, visible, and testable here.
 *
 * Each handler is idempotent: calling it twice with the same event key
 * is safe — the idempotency guard returns the existing record.
 *
 * Architecture: SAP-style state machine. Events are instructions.
 * The database is passive storage. This service is the accountant.
 */

import { Pool, PoolClient } from 'pg';
import { salesService, CreateSaleInput } from '../sales/salesService.js';
import { ordersService } from '../orders/ordersService.js';
import logger from '../../utils/logger.js';
import { cashRegisterService } from '../cash-register/index.js';

// ── Typed event inputs (mirror of the client PosOfflineEvent shapes) ─────────

export interface ReplayEventLine {
    productId: string;
    productName: string;
    sku: string;
    uom: string;
    uomId?: string;
    quantity: number;
    unitPrice: number;
    costPrice: number;
    subtotal: number;
    taxAmount: number;
    discountAmount?: number;
    lineId?: string;
    kitchenSentAt?: string | null;
    lineNotes?: string | null;
}

export interface ReplayEventPayment {
    paymentMethod: 'CASH' | 'CARD' | 'MOBILE_MONEY' | 'AIRTEL_MONEY' | 'CREDIT';
    amount: number;
    reference?: string;
}

export interface SaleCompletedEvent {
    eventType: 'SALE_COMPLETED';
    key: string;
    orderId: string;
    offlineId: string;
    customerId?: string | null;
    lines: ReplayEventLine[];
    payments: ReplayEventPayment[];
    subtotal: number;
    discountAmount?: number;
    taxAmount: number;
    totalAmount: number;
    ts: number;
    /** Phase 5.2 — when set, complete linked restaurant check + release table */
    tableId?: string;
    channel?: 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY';
    tableCode?: string;
}

export interface OrderCreatedEvent {
    eventType: 'ORDER_CREATED';
    key: string;
    orderId: string;
    offlineId: string;
    customerId?: string | null;
    notes?: string | null;
    lines: ReplayEventLine[];
    ts: number;
    channel?: 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY';
    tableId?: string;
    tableCode?: string;
    waiterId?: string;
}

export interface RestaurantKotFiredEvent {
    eventType: 'RESTAURANT_KOT_FIRED';
    key: string;
    orderId: string;
    kotOfflineId: string;
    ts: number;
    [extra: string]: unknown;
}

export interface RestaurantCheckTransferredEvent {
    eventType: 'RESTAURANT_CHECK_TRANSFERRED';
    key: string;
    orderId: string;
    offlineId?: string;
    fromTableId: string;
    toTableId: string;
    toTableCode?: string;
    toTableName?: string;
    channel?: 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY';
    ts: number;
}

export interface RestaurantCheckMergedEvent {
    eventType: 'RESTAURANT_CHECK_MERGED';
    key: string;
    primaryOrderId: string;
    secondaryOrderId: string;
    primaryOfflineId?: string;
    secondaryOfflineId?: string;
    primaryTableId?: string;
    secondaryTableId?: string;
    ts: number;
}

export interface RestaurantCheckSplitEvent {
    eventType: 'RESTAURANT_CHECK_SPLIT';
    key: string;
    sourceOrderId: string;
    sourceOfflineId?: string;
    newOrderId: string;
    newOfflineId: string;
    lineIds: string[];
    /** Samba Move N of M — when set, only that many units leave each source line. */
    quantityByLineId?: Record<string, number>;
    movedLines: ReplayEventLine[];
    sourceTableId: string;
    targetTableId: string;
    targetTableCode?: string;
    targetTableName?: string;
    sameTable: boolean;
    channel?: 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY';
    waiterId?: string;
    waiterName?: string;
    ts: number;
}

export interface RestaurantKotStatusEvent {
    eventType: 'RESTAURANT_KOT_STATUS';
    key: string;
    orderId: string;
    kotOfflineId: string;
    status: 'SENT' | 'PREPARING' | 'READY' | 'BUMPED';
    ts: number;
}

export interface OrderCancelledEvent {
    eventType: 'ORDER_CANCELLED';
    key: string;
    orderId: string;
    offlineId?: string;
    reason?: string;
    ts: number;
    tableId?: string;
    tableCode?: string;
}

export interface OrderUpdatedEvent {
    eventType: 'ORDER_UPDATED';
    key: string;
    orderId: string;
    offlineId?: string;
    ts: number;
    [extra: string]: unknown;
}

export interface PaymentAddedEvent {
    eventType: 'PAYMENT_ADDED';
    key: string;
    orderId: string;
    offlineId: string;
    ts: number;
    [extra: string]: unknown;
}

export interface SaleVoidedEvent {
    eventType: 'SALE_VOIDED';
    key: string;
    orderId?: string;
    saleId?: string;
    offlineId?: string;
    reason?: string;
    ts: number;
    [extra: string]: unknown;
}

export type ReplayableEvent =
    | SaleCompletedEvent
    | OrderCreatedEvent
    | OrderCancelledEvent
    | OrderUpdatedEvent
    | PaymentAddedEvent
    | SaleVoidedEvent
    | RestaurantKotFiredEvent
    | RestaurantCheckTransferredEvent
    | RestaurantCheckMergedEvent
    | RestaurantCheckSplitEvent
    | RestaurantKotStatusEvent;

// ── Result types ──────────────────────────────────────────────

export interface ReplaySuccess {
    status: 'SYNCED';
    data: Record<string, unknown>;
}

export interface ReplayDuplicate {
    status: 'DUPLICATE';
    data: Record<string, unknown>;
}

export interface ReplayReview {
    status: 'REVIEW';
    error: string;
}

export interface ReplayFailed {
    status: 'FAILED';
    error: string;
}

export interface ReplayAcknowledged {
    status: 'ACKNOWLEDGED';
    eventType: string;
}

export type ReplayResult =
    | ReplaySuccess
    | ReplayDuplicate
    | ReplayReview
    | ReplayFailed
    | ReplayAcknowledged;

/** Resolve PENDING restaurant check for a floor table. */
async function resolvePendingOrderIdForTable(
    pool: Pool,
    tableId: string
): Promise<string | null> {
    const byCurrent = await pool.query(
        `SELECT current_order_id AS id FROM restaurant_tables
         WHERE id = $1 AND current_order_id IS NOT NULL`,
        [tableId]
    );
    if (byCurrent.rows[0]?.id) {
        const st = await pool.query(`SELECT status FROM pos_orders WHERE id = $1`, [
            byCurrent.rows[0].id,
        ]);
        if (st.rows[0]?.status === 'PENDING') {
            return byCurrent.rows[0].id as string;
        }
    }
    const byTable = await pool.query(
        `SELECT id FROM pos_orders
         WHERE table_id = $1 AND status = 'PENDING'
         ORDER BY created_at DESC LIMIT 1`,
        [tableId]
    );
    return (byTable.rows[0]?.id as string) ?? null;
}

const ORDER_UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function isPendingOrderOnTable(
    pool: Pool,
    orderId: string,
    tableId: string,
): Promise<boolean> {
    if (!ORDER_UUID_RE.test(orderId)) return false;
    const row = await pool.query(
        `SELECT id FROM pos_orders WHERE id = $1 AND table_id = $2 AND status = 'PENDING'`,
        [orderId, tableId],
    );
    return !!row.rows[0]?.id;
}

/** Multi-ticket tables: prefer event source id, then match split lines on siblings. */
async function resolveSourceOrderIdForSplit(
    pool: Pool,
    event: RestaurantCheckSplitEvent,
): Promise<string | null> {
    if (
        event.sourceOrderId &&
        (await isPendingOrderOnTable(pool, event.sourceOrderId, event.sourceTableId))
    ) {
        return event.sourceOrderId;
    }

    const sibs = await pool.query(
        `SELECT id FROM pos_orders
         WHERE table_id = $1 AND status = 'PENDING'
         ORDER BY created_at ASC`,
        [event.sourceTableId],
    );
    const siblingIds = sibs.rows.map((r: { id: string }) => r.id as string);
    if (event.lineIds?.length && siblingIds.length > 0) {
        for (const orderId of siblingIds) {
            const items = await resolveSplitItems(pool, orderId, event);
            if (items.length === event.lineIds.length) return orderId;
        }
    }

    return resolvePendingOrderIdForTable(pool, event.sourceTableId);
}

/**
 * Free restaurant floor after offline pay. Errors are returned — never swallowed as silent success.
 */
async function releaseRestaurantFloorAfterSale(
    pool: Pool | PoolClient,
    event: SaleCompletedEvent,
    knownFromOrderId?: string
): Promise<{ fromOrderId: string | null; error: string | null }> {
    if (!event.tableId) {
        return { fromOrderId: knownFromOrderId ?? null, error: null };
    }

    try {
        const { isRestaurantModeEnabled } = await import('../restaurant/restaurantSettings.js');
        if (!(await isRestaurantModeEnabled(pool))) {
            return { fromOrderId: knownFromOrderId ?? null, error: null };
        }

        let fromOrderId = knownFromOrderId ?? null;
        if (!fromOrderId) {
            fromOrderId = await resolvePendingOrderIdForTable(pool as Pool, event.tableId);
        }

        if (fromOrderId) {
            const { restaurantService } = await import('../restaurant/restaurantService.js');
            await restaurantService.releaseTableForOrder(pool, fromOrderId);
            return { fromOrderId, error: null };
        }

        const { restaurantRepository } = await import('../restaurant/restaurantRepository.js');
        await restaurantRepository.releaseTable(pool, event.tableId);
        return { fromOrderId: null, error: null };
    } catch (err: unknown) {
        return {
            fromOrderId: knownFromOrderId ?? null,
            error: err instanceof Error ? err.message : String(err),
        };
    }
}

const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export { computeVoidItemsFromUpdatedLines } from '../../../../shared/utils/reconcileOrderLineVoids.js';
import { computeVoidItemsFromUpdatedLines } from '../../../../shared/utils/reconcileOrderLineVoids.js';

// ── Event Replayer ────────────────────────────────────────────

export const posEventReplayer = {
    /**
     * Dispatch a single offline event to its handler.
     * This is the sole entry point — the route calls only this.
     */
    async replay(pool: Pool | PoolClient, event: ReplayableEvent, userId: string): Promise<ReplayResult> {
        logger.debug(`[EventReplayer] Processing ${event.eventType} key=${event.key}`);

        switch (event.eventType) {
            case 'ORDER_CREATED':
                return posEventReplayer.createOrderDraft(pool, event, userId);

            case 'SALE_COMPLETED':
                return posEventReplayer.finalizeSale(pool, event, userId);

            case 'ORDER_CANCELLED':
                return posEventReplayer.cancelOrder(pool, event, userId);

            case 'ORDER_UPDATED':
                return posEventReplayer.updateOrder(pool, event, userId);

            case 'RESTAURANT_CHECK_TRANSFERRED':
                return posEventReplayer.transferRestaurantCheck(pool, event, userId);

            case 'RESTAURANT_CHECK_MERGED':
                return posEventReplayer.mergeRestaurantChecks(pool, event, userId);

            case 'RESTAURANT_CHECK_SPLIT':
                return posEventReplayer.splitRestaurantCheck(pool, event, userId);

            case 'RESTAURANT_KOT_FIRED':
                return posEventReplayer.fireRestaurantKot(pool, event, userId);

            case 'PAYMENT_ADDED':
            case 'SALE_VOIDED':
            case 'RESTAURANT_KOT_STATUS':
                // KDS status advances online; offline board is local-first until a later phase.
                logger.debug(`[EventReplayer] ${event.eventType} acknowledged (no-op)`);
                return { status: 'ACKNOWLEDGED', eventType: event.eventType };

            default: {
                const _unreachable: never = event;
                logger.warn(`[EventReplayer] Unknown eventType: ${(_unreachable as ReplayableEvent).eventType}`);
                return { status: 'FAILED', error: `Unknown eventType` };
            }
        }
    },

    /**
     * ORDER_CREATED → create a draft order.
     */
    async createOrderDraft(
        pool: Pool | PoolClient,
        event: OrderCreatedEvent,
        userId: string
    ): Promise<ReplayResult> {
        if (event.customerId?.startsWith('offline_cust_')) {
            return {
                status: 'REVIEW',
                error: 'Customer was created offline and has not been synced yet.',
            };
        }

        try {
            const order = await ordersService.createOrder(pool as Pool, {
                customerId: event.customerId ?? null,
                notes:
                    event.notes ??
                    (event.tableCode ? `Restaurant ${event.tableCode}` : null),
                createdBy: userId,
                idempotencyKey: event.key,
                items: event.lines.map((line) => ({
                    productId: line.productId,
                    productName: line.productName,
                    quantity: line.quantity,
                    unitPrice: line.unitPrice,
                    uomId: line.uomId,
                })),
            });

            // Persist Samba-style line notes onto created items (ORDER_CREATED → pos_order_items).
            if (order.items?.length) {
                for (let i = 0; i < order.items.length; i++) {
                    const notes = event.lines[i]?.lineNotes ?? null;
                    if (!notes) continue;
                    await pool.query(
                        `UPDATE pos_order_items SET line_notes = $2 WHERE id = $1`,
                        [order.items[i].id, notes],
                    );
                }
            }

            // Phase 5.1: restaurant table link when present — do not swallow floor failures
            if (event.tableId && event.channel) {
                try {
                    const { restaurantRepository } = await import('../restaurant/restaurantRepository.js');
                    const { isRestaurantModeEnabled } = await import('../restaurant/restaurantSettings.js');
                    if (await isRestaurantModeEnabled(pool)) {
                        await restaurantRepository.patchOrderRestaurantFields(pool, order.id, {
                            tableId: event.tableId,
                            orderChannel: event.channel,
                            waiterId: event.waiterId ?? null,
                            kitchenStatus: 'NONE',
                        });
                        await restaurantRepository.occupyTable(pool, event.tableId, order.id);
                    }
                } catch (restErr) {
                    const errMsg = restErr instanceof Error ? restErr.message : String(restErr);
                    logger.error('[EventReplayer] Restaurant table link failed on ORDER_CREATED', {
                        offlineId: event.offlineId,
                        orderId: order.id,
                        tableId: event.tableId,
                        error: errMsg,
                    });
                    return {
                        status: 'REVIEW',
                        error: `Order created but restaurant table link failed: ${errMsg}`,
                    };
                }
            }

            logger.info(`[EventReplayer] ORDER_CREATED ${event.offlineId} → ${order.orderNumber}`);
            return {
                status: 'SYNCED',
                data: { orderId: order.id, orderNumber: order.orderNumber, offlineId: event.offlineId },
            };
        } catch (err: unknown) {
            const pgErr = err as { code?: string };
            if (pgErr.code === '23505') {
                return { status: 'DUPLICATE', data: { alreadySynced: true } };
            }
            const errMsg = err instanceof Error ? err.message : String(err);
            logger.error(`[EventReplayer] ORDER_CREATED failed ${event.offlineId}: ${errMsg}`);
            return { status: 'FAILED', error: errMsg };
        }
    },

    /**
     * SALE_COMPLETED → finalize the sale (createSale SSOT).
     * Phase 5.2: restaurant tableId → fromOrderId + release floor.
     */
    async finalizeSale(
        pool: Pool | PoolClient,
        event: SaleCompletedEvent,
        userId: string
    ): Promise<ReplayResult> {
        if (event.customerId?.startsWith('offline_cust_')) {
            return {
                status: 'REVIEW',
                error: 'Customer was created offline and has not been synced yet.',
            };
        }

        const existing = await (pool as Pool).query(
            `SELECT id, sale_number FROM sales WHERE idempotency_key = $1`,
            [event.key]
        );
        if (existing.rows.length > 0) {
            logger.info(`[EventReplayer] SALE_COMPLETED duplicate key=${event.key}, returning existing`);
            // Idempotent retry must still free the floor if prior sync sold but failed release
            const releaseDup = await releaseRestaurantFloorAfterSale(pool, event, undefined);
            if (releaseDup.error) {
                return {
                    status: 'REVIEW',
                    error: `Sale already synced but table release failed: ${releaseDup.error}`,
                };
            }
            return {
                status: 'DUPLICATE',
                data: {
                    saleId: existing.rows[0].id,
                    saleNumber: existing.rows[0].sale_number,
                    alreadySynced: true,
                    fromOrderId: releaseDup.fromOrderId ?? null,
                },
            };
        }

        let cashRegisterSessionId: string | null = null;
        const { session } = await cashRegisterService.getCurrentSessionForUser(userId, pool as Pool);
        if (session) {
            cashRegisterSessionId = session.id;
        }

        let fromOrderId: string | undefined;
        if (event.tableId) {
            try {
                const { isRestaurantModeEnabled } = await import('../restaurant/restaurantSettings.js');
                if (await isRestaurantModeEnabled(pool)) {
                    const resolved = await resolvePendingOrderIdForTable(pool as Pool, event.tableId);
                    if (resolved) fromOrderId = resolved;
                }
            } catch (linkErr) {
                logger.warn('[EventReplayer] Restaurant fromOrderId resolve skipped', {
                    offlineId: event.offlineId,
                    error: linkErr instanceof Error ? linkErr.message : String(linkErr),
                });
            }
        }

        const serviceInput: CreateSaleInput = {
            customerId: event.customerId || null,
            cashRegisterSessionId: cashRegisterSessionId || undefined,
            items: event.lines.map((line) => ({
                productId: line.productId,
                productName: line.productName,
                uom: line.uomId ? line.uom : undefined,
                uomId: line.uomId,
                quantity: line.quantity,
                unitPrice: line.unitPrice,
            })),
            subtotal: event.subtotal,
            discountAmount: event.discountAmount ?? 0,
            taxAmount: event.taxAmount,
            totalAmount: event.totalAmount,
            paymentMethod: event.payments[0]?.paymentMethod ?? 'CASH',
            paymentReceived: event.totalAmount,
            soldBy: userId,
            paymentLines: event.payments,
            idempotencyKey: event.key,
            offlineId: event.offlineId,
            fromOrderId,
        };

        try {
            const result = await salesService.createSale(pool as Pool, serviceInput);

            const release = await releaseRestaurantFloorAfterSale(pool, event, fromOrderId);
            if (release.error) {
                logger.error('[EventReplayer] Restaurant table release failed after SALE_COMPLETED', {
                    offlineId: event.offlineId,
                    fromOrderId: release.fromOrderId,
                    error: release.error,
                });
                return {
                    status: 'REVIEW',
                    error: `Sale created (${result.sale.saleNumber}) but table release failed: ${release.error}`,
                };
            }

            logger.info(`[EventReplayer] SALE_COMPLETED ${event.offlineId} → ${result.sale.saleNumber}`);
            return {
                status: 'SYNCED',
                data: {
                    saleId: result.sale.id,
                    saleNumber: result.sale.saleNumber,
                    offlineId: event.offlineId,
                    fromOrderId: release.fromOrderId ?? fromOrderId ?? null,
                },
            };
        } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            const pgErr = err as { code?: string; constraint?: string };

            if (pgErr.code === '23505' && String(pgErr.constraint ?? errMsg).includes('idempotency_key')) {
                const dup = await (pool as Pool).query(
                    `SELECT id, sale_number FROM sales WHERE idempotency_key = $1`,
                    [event.key]
                );
                if (dup.rows.length > 0) {
                    const releaseDup = await releaseRestaurantFloorAfterSale(pool, event, fromOrderId);
                    if (releaseDup.error) {
                        return {
                            status: 'REVIEW',
                            error: `Sale already synced but table release failed: ${releaseDup.error}`,
                        };
                    }
                    return {
                        status: 'DUPLICATE',
                        data: {
                            saleId: dup.rows[0].id,
                            saleNumber: dup.rows[0].sale_number,
                            alreadySynced: true,
                            fromOrderId: releaseDup.fromOrderId ?? fromOrderId ?? null,
                        },
                    };
                }
            }

            if (
                errMsg.includes('Insufficient') ||
                errMsg.includes('stock') ||
                errMsg.includes('inventory') ||
                errMsg.includes('cost layer')
            ) {
                logger.warn(`[EventReplayer] Stock conflict ${event.offlineId}: ${errMsg}`);
                return { status: 'REVIEW', error: errMsg };
            }

            logger.error(`[EventReplayer] SALE_COMPLETED failed ${event.offlineId}: ${errMsg}`);
            return { status: 'FAILED', error: errMsg };
        }
    },

    /**
     * ORDER_UPDATED → apply offline line voids (journal snapshot) + waiter when present.
     * Without this, FOH voids look removed locally but Complete Sale still charges server lines.
     */
    async updateOrder(
        pool: Pool | PoolClient,
        event: OrderUpdatedEvent,
        userId: string,
    ): Promise<ReplayResult> {
        const waiterId = typeof event.waiterId === 'string' ? event.waiterId : undefined;
        const tableId = typeof event.tableId === 'string' ? event.tableId : undefined;
        const eventLines = Array.isArray(event.lines) ? event.lines : null;

        try {
            const { isRestaurantModeEnabled } = await import('../restaurant/restaurantSettings.js');
            if (!(await isRestaurantModeEnabled(pool))) {
                return { status: 'ACKNOWLEDGED', eventType: 'ORDER_UPDATED' };
            }

            let orderId: string | null = null;
            if (event.orderId && UUID_RE.test(event.orderId)) {
                orderId = event.orderId;
            } else if (tableId) {
                orderId = await resolvePendingOrderIdForTable(pool as Pool, tableId);
            }

            if (!orderId) {
                // No server row yet (ofl_ord_* not created) — ACK so sync does not stick.
                return { status: 'ACKNOWLEDGED', eventType: 'ORDER_UPDATED' };
            }

            const { restaurantRepository } = await import('../restaurant/restaurantRepository.js');
            const { restaurantService } = await import('../restaurant/restaurantService.js');
            let voidedCount = 0;
            let checkCancelled = false;

            if (eventLines) {
                const order = await ordersService.getOrder(pool as Pool, orderId);
                if (order && order.status === 'PENDING') {
                    const voidItems = computeVoidItemsFromUpdatedLines(
                        order.items || [],
                        eventLines as Array<{
                            lineId?: string;
                            productId?: string;
                            quantity?: number;
                        }>,
                    );
                    if (voidItems.length > 0) {
                        const reason =
                            typeof event.voidReason === 'string' && event.voidReason.trim()
                                ? event.voidReason.trim()
                                : 'Offline void sync';
                        const voided = await restaurantService.voidCheckItems(pool as Pool, orderId, {
                            items: voidItems,
                            reason,
                            voidedBy: userId,
                        });
                        voidedCount = voidItems.length;
                        checkCancelled = !!voided.checkCancelled;
                        logger.info(
                            `[EventReplayer] ORDER_UPDATED voided ${voidItems.length} line(s) → order ${orderId}`,
                        );
                    }
                }
            }

            if (waiterId && !checkCancelled) {
                // Same ownership gate as online assignWaiter — do not let offline events steal peers.
                try {
                    await restaurantService.assignWaiter(pool as Pool, orderId, waiterId, {
                        userId,
                    });
                    logger.info(`[EventReplayer] ORDER_UPDATED waiter → order ${orderId}`);
                } catch (assignErr: unknown) {
                    const msg =
                        assignErr instanceof Error ? assignErr.message : String(assignErr);
                    if (msg.includes('owned') || msg.includes('Forbidden') || msg.includes('403')) {
                        logger.warn(
                            `[EventReplayer] ORDER_UPDATED waiter rejected (ownership) order=${orderId}`,
                        );
                    } else {
                        throw assignErr;
                    }
                }
            }

            if (voidedCount > 0 || waiterId) {
                return {
                    status: 'SYNCED',
                    data: { orderId, waiterId: waiterId ?? null, voidedCount, checkCancelled },
                };
            }
            return { status: 'ACKNOWLEDGED', eventType: 'ORDER_UPDATED' };
        } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            logger.error(`[EventReplayer] ORDER_UPDATED failed key=${event.key}: ${errMsg}`);
            return { status: 'FAILED', error: errMsg };
        }
    },

    /**
     * ORDER_CANCELLED → cancel PENDING pos_orders + release restaurant table (Phase 5.3).
     */
    async cancelOrder(
        pool: Pool | PoolClient,
        event: OrderCancelledEvent,
        userId: string
    ): Promise<ReplayResult> {
        try {
            let orderId: string | null = null;

            // Prefer explicit server order id when the client already resolved it.
            if (
                event.orderId &&
                /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
                    event.orderId,
                )
            ) {
                orderId = event.orderId;
            } else if (event.tableId) {
                orderId = await resolvePendingOrderIdForTable(pool as Pool, event.tableId);
            }

            if (!orderId) {
                // Never wipe a multi-ticket table when the cancelled check is already gone.
                if (event.tableId) {
                    try {
                        const { isRestaurantModeEnabled } = await import('../restaurant/restaurantSettings.js');
                        const { restaurantRepository } = await import('../restaurant/restaurantRepository.js');
                        if (await isRestaurantModeEnabled(pool)) {
                            const pending = await (pool as Pool).query(
                                `SELECT COUNT(*)::int AS n FROM pos_orders
                                 WHERE table_id = $1 AND status = 'PENDING'
                                   AND order_channel IS DISTINCT FROM 'RETAIL'`,
                                [event.tableId],
                            );
                            if ((pending.rows[0]?.n as number) === 0) {
                                await restaurantRepository.releaseTable(pool, event.tableId);
                            }
                        }
                    } catch {
                        /* best-effort */
                    }
                }
                logger.warn(
                    `[EventReplayer] ORDER_CANCELLED: order not found offlineId=${event.offlineId ?? 'n/a'} — ACK`
                );
                return { status: 'ACKNOWLEDGED', eventType: 'ORDER_CANCELLED' };
            }

            const statusRes = await (pool as Pool).query(
                `SELECT status FROM pos_orders WHERE id = $1`,
                [orderId]
            );
            const status = statusRes.rows[0]?.status as string | undefined;
            if (status === 'CANCELLED') {
                try {
                    const { restaurantService } = await import('../restaurant/restaurantService.js');
                    await restaurantService.releaseTableForOrder(pool, orderId, {
                        updatedBy: userId,
                        bumpVoids: true,
                    });
                } catch {
                    /* already cancelled */
                }
                return { status: 'DUPLICATE', data: { alreadySynced: true, orderId } };
            }

            if (status !== 'PENDING') {
                return {
                    status: 'REVIEW',
                    error: `Cannot cancel order in status ${status ?? 'unknown'}`,
                };
            }

            // SSOT: cancelCheck emits VOID KOTs for kitchen-sent lines, then cancels + releases.
            const { restaurantService } = await import('../restaurant/restaurantService.js');
            const meta = await (
                await import('../restaurant/restaurantRepository.js')
            ).restaurantRepository.getOrderRestaurantMeta(pool, orderId);
            if (meta && meta.orderChannel !== 'RETAIL') {
                await restaurantService.cancelCheck(
                    pool as Pool,
                    orderId,
                    userId,
                    event.reason?.trim() || 'Cancelled offline (restaurant)',
                    { userId },
                );
            } else {
                await ordersService.cancelOrder(
                    pool as Pool,
                    orderId,
                    userId,
                    event.reason?.trim() || 'Cancelled offline (restaurant)',
                );
                try {
                    await restaurantService.releaseTableForOrder(pool, orderId, {
                        updatedBy: userId,
                        bumpVoids: true,
                    });
                } catch (releaseErr) {
                    logger.error('[EventReplayer] Table release after cancel failed', {
                        orderId,
                        error: releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
                    });
                }
            }

            logger.info(
                `[EventReplayer] ORDER_CANCELLED ${event.offlineId ?? event.orderId} → order ${orderId}`
            );
            return {
                status: 'SYNCED',
                data: { orderId, offlineId: event.offlineId ?? null },
            };
        } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            logger.error(
                `[EventReplayer] ORDER_CANCELLED failed ${event.offlineId ?? event.orderId}: ${errMsg}`
            );
            return { status: 'FAILED', error: errMsg };
        }
    },

    /**
     * Offline KOT fire → restaurantService.sendKot (idempotent when lines already sent).
     * Creates restaurant_kot + print_jobs so kitchen/VOID routing stays SSOT after sync.
     */
    async fireRestaurantKot(
        pool: Pool | PoolClient,
        event: RestaurantKotFiredEvent,
        userId: string,
    ): Promise<ReplayResult> {
        try {
            const { isRestaurantModeEnabled } = await import('../restaurant/restaurantSettings.js');
            if (!(await isRestaurantModeEnabled(pool))) {
                return { status: 'ACKNOWLEDGED', eventType: 'RESTAURANT_KOT_FIRED' };
            }

            let orderId: string | null = null;
            if (event.orderId && UUID_RE.test(event.orderId)) {
                orderId = event.orderId;
            } else if (typeof event.tableId === 'string' && event.tableId) {
                orderId = await resolvePendingOrderIdForTable(pool as Pool, event.tableId);
            }

            if (!orderId) {
                // ORDER_CREATED may not have landed yet — ACK so sync does not stick.
                return { status: 'ACKNOWLEDGED', eventType: 'RESTAURANT_KOT_FIRED' };
            }

            const { restaurantService } = await import('../restaurant/restaurantService.js');
            const result = await restaurantService.sendKot(pool as Pool, orderId, userId, {
                userId,
            });
            logger.info(
                `[EventReplayer] RESTAURANT_KOT_FIRED → order ${orderId} kots=${result.kots.length}`,
            );
            return {
                status: result.kots.length > 0 ? 'SYNCED' : 'DUPLICATE',
                data: {
                    orderId,
                    kotOfflineId: event.kotOfflineId,
                    kotCount: result.kots.length,
                    printJobCount: result.printJobs.length,
                },
            };
        } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            logger.error(
                `[EventReplayer] RESTAURANT_KOT_FIRED failed key=${event.key}: ${errMsg}`,
            );
            return { status: 'FAILED', error: errMsg };
        }
    },

    /**
     * Phase 5.4 — transfer via restaurantService SSOT.
     */
    async transferRestaurantCheck(
        pool: Pool | PoolClient,
        event: RestaurantCheckTransferredEvent,
        userId: string
    ): Promise<ReplayResult> {
        try {
            const { isRestaurantModeEnabled } = await import('../restaurant/restaurantSettings.js');
            if (!(await isRestaurantModeEnabled(pool))) {
                return { status: 'ACKNOWLEDGED', eventType: 'RESTAURANT_CHECK_TRANSFERRED' };
            }
            let orderId = event.orderId;
            if (
                orderId &&
                !(await isPendingOrderOnTable(pool as Pool, orderId, event.fromTableId))
            ) {
                orderId = '';
            }
            if (!orderId) {
                orderId =
                    (await resolvePendingOrderIdForTable(pool as Pool, event.fromTableId)) ?? '';
            }
            if (!orderId) {
                return {
                    status: 'REVIEW',
                    error: 'Source check not found on server for offline transfer (sync ORDER_CREATED first)',
                };
            }
            const { restaurantService } = await import('../restaurant/restaurantService.js');
            const result = await restaurantService.transferCheck(
                pool as Pool,
                orderId,
                event.toTableId,
                userId,
            );
            logger.info(`[EventReplayer] RESTAURANT_CHECK_TRANSFERRED → ${orderId}`);
            return {
                status: 'SYNCED',
                data: { orderId, fromTableId: result.fromTableId, toTableId: result.toTableId },
            };
        } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            if (errMsg.includes('already on that table') || errMsg.includes('Target table must be free')) {
                return { status: 'REVIEW', error: errMsg };
            }
            logger.error(`[EventReplayer] TRANSFER failed: ${errMsg}`);
            return { status: 'FAILED', error: errMsg };
        }
    },

    /**
     * Phase 5.4 — merge via restaurantService SSOT.
     */
    async mergeRestaurantChecks(
        pool: Pool | PoolClient,
        event: RestaurantCheckMergedEvent,
        userId: string
    ): Promise<ReplayResult> {
        try {
            const { isRestaurantModeEnabled } = await import('../restaurant/restaurantSettings.js');
            if (!(await isRestaurantModeEnabled(pool))) {
                return { status: 'ACKNOWLEDGED', eventType: 'RESTAURANT_CHECK_MERGED' };
            }
            if (!event.primaryTableId || !event.secondaryTableId) {
                return { status: 'REVIEW', error: 'Merge event missing table ids' };
            }
            let primaryId: string | null = null;
            let secondaryId: string | null = null;
            if (event.primaryTableId === event.secondaryTableId) {
                const tableRes = await (pool as Pool).query(
                    `SELECT current_order_id FROM restaurant_tables WHERE id = $1`,
                    [event.primaryTableId]
                );
                const currentId = tableRes.rows[0]?.current_order_id as string | null;
                const sibs = await (pool as Pool).query(
                    `SELECT id FROM pos_orders
                     WHERE table_id = $1 AND status = 'PENDING'
                     ORDER BY created_at ASC`,
                    [event.primaryTableId]
                );
                const ids = sibs.rows.map((r: { id: string }) => r.id);
                if (ids.length < 2) {
                    return {
                        status: 'REVIEW',
                        error: 'Need two open sibling checks on table for offline merge',
                    };
                }
                primaryId = currentId && ids.includes(currentId) ? currentId : ids[0];
                secondaryId = ids.find((id: string) => id !== primaryId) ?? null;
            } else {
                primaryId = await resolvePendingOrderIdForTable(pool as Pool, event.primaryTableId);
                secondaryId = await resolvePendingOrderIdForTable(pool as Pool, event.secondaryTableId);
            }
            if (!primaryId || !secondaryId) {
                return {
                    status: 'REVIEW',
                    error: 'One or both checks not found on server for offline merge',
                };
            }
            const { restaurantService } = await import('../restaurant/restaurantService.js');
            const result = await restaurantService.mergeChecks(
                pool as Pool,
                primaryId,
                secondaryId,
                userId,
            );
            logger.info(`[EventReplayer] RESTAURANT_CHECK_MERGED ${secondaryId} → ${primaryId}`);
            return {
                status: 'SYNCED',
                data: { primaryOrderId: primaryId, cancelledOrderId: result.cancelledOrderId },
            };
        } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            logger.error(`[EventReplayer] MERGE failed: ${errMsg}`);
            return { status: 'FAILED', error: errMsg };
        }
    },

    /**
     * Phase 5.4 — split via restaurantService SSOT (match lines by id or product/qty).
     */
    async splitRestaurantCheck(
        pool: Pool | PoolClient,
        event: RestaurantCheckSplitEvent,
        userId: string
    ): Promise<ReplayResult> {
        try {
            const { isRestaurantModeEnabled } = await import('../restaurant/restaurantSettings.js');
            if (!(await isRestaurantModeEnabled(pool))) {
                return { status: 'ACKNOWLEDGED', eventType: 'RESTAURANT_CHECK_SPLIT' };
            }
            const sourceId = await resolveSourceOrderIdForSplit(pool as Pool, event);
            if (!sourceId) {
                return {
                    status: 'REVIEW',
                    error: 'Source check not found on server for offline split',
                };
            }

            const items = await resolveSplitItems(pool as Pool, sourceId, event);
            if (items.length !== event.lineIds.length) {
                return {
                    status: 'REVIEW',
                    error: `Could not match split lines on server (${items.length}/${event.lineIds.length})`,
                };
            }

            const { restaurantService } = await import('../restaurant/restaurantService.js');
            const result = await restaurantService.splitCheck(pool as Pool, sourceId, {
                items,
                targetTableId: event.targetTableId,
                actorId: userId,
                sameTable: event.sameTable,
            });
            logger.info(`[EventReplayer] RESTAURANT_CHECK_SPLIT ${sourceId} → ${result.split.order.id}`);
            return {
                status: 'SYNCED',
                data: {
                    sourceOrderId: sourceId,
                    newOrderId: result.split.order.id,
                    offlineNewOrderId: event.newOrderId,
                },
            };
        } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            logger.error(`[EventReplayer] SPLIT failed: ${errMsg}`);
            return { status: 'FAILED', error: errMsg };
        }
    },
};

/** Match offline split lineIds to server pos_order_items (UUID or product+qty). */
async function resolveSplitItems(
    pool: Pool,
    sourceOrderId: string,
    event: RestaurantCheckSplitEvent
): Promise<Array<{ itemId: string; quantity?: number }>> {
    const order = await ordersService.getOrder(pool, sourceOrderId);
    const items = [...(order.items || [])];
    const used = new Set<string>();
    const resolved: Array<{ itemId: string; quantity?: number }> = [];
    const qtyBy = event.quantityByLineId || {};

    for (const lineId of event.lineIds) {
        const moveQty = qtyBy[lineId];
        const byId = items.find((i) => i.id === lineId && !used.has(i.id));
        if (byId) {
            used.add(byId.id);
            resolved.push(
                moveQty != null && moveQty > 0 && moveQty < Number(byId.quantity)
                    ? { itemId: byId.id, quantity: moveQty }
                    : { itemId: byId.id },
            );
            continue;
        }
        const moved = event.movedLines.find((l) => l.lineId === lineId)
            ?? event.movedLines[resolved.length];
        if (!moved) continue;
        // Prefer matching product with enough on-hand qty (partial move).
        const wantQty = moveQty ?? Number(moved.quantity);
        const match =
            items.find(
                (i) =>
                    !used.has(i.id) &&
                    i.productId === moved.productId &&
                    Number(i.quantity) >= wantQty - 1e-9,
            ) ||
            items.find(
                (i) =>
                    !used.has(i.id) &&
                    i.productId === moved.productId &&
                    Number(i.quantity) === Number(moved.quantity),
            );
        if (match) {
            used.add(match.id);
            resolved.push(
                wantQty > 0 && wantQty < Number(match.quantity)
                    ? { itemId: match.id, quantity: wantQty }
                    : { itemId: match.id },
            );
        }
    }
    return resolved;
}
