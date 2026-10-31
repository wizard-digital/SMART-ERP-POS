/**
 * Sync Events Route
 *
 * POST /api/pos/sync-events
 *
 * HTTP layer only — validates the request, then delegates all business
 * logic to posEventReplayer. This file must never contain domain logic.
 *
 * Idempotency: all events carry a unique key. Duplicate keys on the server
 * return 409 (already processed), which the client treats as SYNCED.
 */

import { Router } from 'express';
import { z } from 'zod';
import { Pool } from 'pg';
import { posEventReplayer, type ReplayableEvent } from './posEventReplayer.js';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../rbac/middleware.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import logger from '../../utils/logger.js';

// ── Common sub-schemas ────────────────────────────────────────

const EventLineSchema = z.object({
    productId: z.string().min(1),
    productName: z.string().min(1),
    sku: z.string().optional().default(''),
    uom: z.string().optional().default(''),
    uomId: z.string().optional(),
    quantity: z.number().positive(),
    unitPrice: z.number().nonnegative(),
    costPrice: z.number().nonnegative().optional().default(0),
    subtotal: z.number().nonnegative().optional().default(0),
    taxAmount: z.number().nonnegative().optional().default(0),
    discountAmount: z.number().nonnegative().optional().default(0),
    lineId: z.string().optional(),
    kitchenSentAt: z.string().nullable().optional(),
    lineNotes: z.string().nullable().optional(),
});

const EventPaymentSchema = z.object({
    paymentMethod: z.enum(['CASH', 'CARD', 'MOBILE_MONEY', 'AIRTEL_MONEY', 'CREDIT', 'GIFT']),
    amount: z.number().nonnegative(),
    reference: z.string().optional(),
});

// ── Discriminated union event schema ─────────────────────────

const SaleCompletedEventSchema = z.object({
    eventType: z.literal('SALE_COMPLETED'),
    key: z.string().min(1),
    orderId: z.string().min(1),
    offlineId: z.string().min(1),
    customerId: z.preprocess(
        (v) => (v === '' || v === undefined ? null : v),
        z.string().nullable().optional()
    ),
    lines: z.array(EventLineSchema).min(1),
    payments: z.array(EventPaymentSchema).min(1),
    subtotal: z.number().nonnegative(),
    discountAmount: z.number().nonnegative().optional().default(0),
    taxAmount: z.number().nonnegative(),
    totalAmount: z.number().nonnegative(),
    giftReason: z.string().max(500).optional(),
    stockDeductions: z.array(z.object({
        productId: z.string(),
        quantity: z.number(),
    })).optional().default([]),
    ts: z.number(),
    /** Phase 5.2 restaurant */
    tableId: z.string().optional(),
    channel: z.enum(['DINE_IN', 'TAKEAWAY', 'DELIVERY']).optional(),
    tableCode: z.string().optional(),
});

const OrderCreatedEventSchema = z.object({
    eventType: z.literal('ORDER_CREATED'),
    key: z.string().min(1),
    orderId: z.string().min(1),
    offlineId: z.string().min(1),
    customerId: z.string().optional().nullable(),
    notes: z.string().optional().nullable(),
    lines: z.array(EventLineSchema).min(1),
    ts: z.number(),
    channel: z.enum(['DINE_IN', 'TAKEAWAY', 'DELIVERY']).optional(),
    tableId: z.string().optional(),
    tableCode: z.string().optional(),
    tableName: z.string().optional(),
    waiterId: z.string().optional(),
    waiterName: z.string().optional(),
    guestName: z.string().nullable().optional(),
    guestPhone: z.string().nullable().optional(),
    deliveryAddress: z.string().nullable().optional(),
    pickupLabel: z.string().nullable().optional(),
});

const OrderUpdatedEventSchema = z.object({
    eventType: z.literal('ORDER_UPDATED'),
    key: z.string().min(1),
    orderId: z.string().min(1),
    offlineId: z.string().optional(),
    ts: z.number(),
}).passthrough();

const OrderCancelledEventSchema = z.object({
    eventType: z.literal('ORDER_CANCELLED'),
    key: z.string().min(1),
    orderId: z.string().min(1),
    offlineId: z.string().min(1).optional(),
    reason: z.string().optional(),
    ts: z.number(),
    tableId: z.string().optional(),
    tableCode: z.string().optional(),
});

const PaymentAddedEventSchema = z.object({
    eventType: z.literal('PAYMENT_ADDED'),
    key: z.string().min(1),
    orderId: z.string().min(1),
    offlineId: z.string().min(1),
    ts: z.number(),
}).passthrough();

const SaleVoidedEventSchema = z.object({
    eventType: z.literal('SALE_VOIDED'),
    key: z.string().min(1),
    orderId: z.string().min(1).optional(),
    saleId: z.string().optional(),
    offlineId: z.string().min(1).optional(),
    reason: z.string().optional(),
    ts: z.number(),
}).passthrough();

const RestaurantKotFiredEventSchema = z.object({
    eventType: z.literal('RESTAURANT_KOT_FIRED'),
    key: z.string().min(1),
    orderId: z.string().min(1),
    kotOfflineId: z.string().min(1),
    tableId: z.string().optional(),
    tableCode: z.string().optional(),
    tableName: z.string().optional(),
    waiterName: z.string().optional(),
    station: z.string().optional(),
    orderChannel: z.string().optional(),
    guestName: z.string().nullable().optional(),
    lines: z.array(z.object({
        lineId: z.string().min(1),
        productName: z.string().min(1),
        quantity: z.number().positive(),
        lineNotes: z.string().nullable().optional(),
    })).min(1),
    ts: z.number(),
});

const RestaurantCheckTransferredSchema = z.object({
    eventType: z.literal('RESTAURANT_CHECK_TRANSFERRED'),
    key: z.string().min(1),
    orderId: z.string().min(1),
    offlineId: z.string().optional(),
    fromTableId: z.string().min(1),
    toTableId: z.string().min(1),
    toTableCode: z.string().optional(),
    toTableName: z.string().optional(),
    channel: z.enum(['DINE_IN', 'TAKEAWAY', 'DELIVERY']).optional(),
    ts: z.number(),
});

const RestaurantCheckMergedSchema = z.object({
    eventType: z.literal('RESTAURANT_CHECK_MERGED'),
    key: z.string().min(1),
    primaryOrderId: z.string().min(1),
    secondaryOrderId: z.string().min(1),
    primaryOfflineId: z.string().optional(),
    secondaryOfflineId: z.string().optional(),
    primaryTableId: z.string().optional(),
    secondaryTableId: z.string().optional(),
    ts: z.number(),
});

const RestaurantCheckSplitSchema = z.object({
    eventType: z.literal('RESTAURANT_CHECK_SPLIT'),
    key: z.string().min(1),
    sourceOrderId: z.string().min(1),
    sourceOfflineId: z.string().optional(),
    newOrderId: z.string().min(1),
    newOfflineId: z.string().min(1),
    lineIds: z.array(z.string().min(1)).min(1),
    quantityByLineId: z.record(z.string(), z.number().positive()).optional(),
    movedLines: z.array(EventLineSchema).min(1),
    sourceTableId: z.string().min(1),
    targetTableId: z.string().min(1),
    targetTableCode: z.string().optional(),
    targetTableName: z.string().optional(),
    sameTable: z.boolean(),
    channel: z.enum(['DINE_IN', 'TAKEAWAY', 'DELIVERY']).optional(),
    waiterId: z.string().optional(),
    waiterName: z.string().optional(),
    guestName: z.string().nullable().optional(),
    guestPhone: z.string().nullable().optional(),
    deliveryAddress: z.string().nullable().optional(),
    pickupLabel: z.string().nullable().optional(),
    ts: z.number(),
});

const RestaurantKotStatusSchema = z.object({
    eventType: z.literal('RESTAURANT_KOT_STATUS'),
    key: z.string().min(1),
    orderId: z.string().min(1),
    kotOfflineId: z.string().min(1),
    status: z.enum(['SENT', 'PREPARING', 'READY', 'BUMPED']),
    ts: z.number(),
});

const PosOfflineEventSchema = z.discriminatedUnion('eventType', [
    SaleCompletedEventSchema,
    OrderCreatedEventSchema,
    OrderUpdatedEventSchema,
    OrderCancelledEventSchema,
    PaymentAddedEventSchema,
    SaleVoidedEventSchema,
    RestaurantKotFiredEventSchema,
    RestaurantCheckTransferredSchema,
    RestaurantCheckMergedSchema,
    RestaurantCheckSplitSchema,
    RestaurantKotStatusSchema,
]);

const SyncEventPayloadSchema = z.object({
    event: PosOfflineEventSchema,
});

// ── Route factory ─────────────────────────────────────────────

export function createSyncEventsRoutes(pool: Pool): Router {
    const router = Router();

    /**
     * POST /api/pos/sync-events
     * Sync a single offline event to the server.
     * All business logic lives in posEventReplayer — not here.
     */
    router.post(
        '/',
        authenticate,
        requirePermission('pos.create'),
        asyncHandler(async (req, res) => {
            const dbPool = req.tenantPool || pool;

            // ── Validate payload ──
            const validation = SyncEventPayloadSchema.safeParse(req.body);
            if (!validation.success) {
                const fieldErrors = validation.error.errors
                    .map((e) => `${e.path.join('.')}: ${e.message}`)
                    .join('; ');
                logger.warn(`[SyncEvents] Payload validation failed: ${fieldErrors}`);
                res.status(400).json({
                    success: false,
                    error: `Invalid event payload: ${fieldErrors}`,
                    details: validation.error.errors,
                });
                return;
            }

            const { event } = validation.data;
            const userId = req.user?.id ?? '00000000-0000-0000-0000-000000000000';

            // ── Delegate ALL business logic to the event replayer ──
            // Zod passthrough + optional fields are structurally close but not assignable to ReplayableEvent
            const result = await posEventReplayer.replay(dbPool, event as ReplayableEvent, userId);

            switch (result.status) {
                case 'SYNCED':
                    res.json({ success: true, data: result.data });
                    break;

                case 'DUPLICATE':
                    res.status(409).json({ success: true, data: result.data });
                    break;

                case 'REVIEW':
                    res.status(200).json({
                        success: false,
                        requiresReview: true,
                        error: result.error,
                        offlineId: 'offlineId' in event ? event.offlineId : undefined,
                    });
                    break;

                case 'ACKNOWLEDGED':
                    res.json({ success: true, data: { acknowledged: true, eventType: result.eventType } });
                    break;

                case 'FAILED':
                    res.status(500).json({ success: false, error: result.error });
                    break;
            }
        })
    );

    return router;
}
