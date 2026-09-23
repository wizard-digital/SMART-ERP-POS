/**
 * Offline Sales Sync Route
 *
 * POST /api/pos/sync-offline-sales
 *
 * Receives a single offline sale, validates idempotency, re-checks
 * stock, creates the sale via the existing salesService, and
 * returns success / requiresReview / error.
 *
 * Rules:
 * - Idempotency key prevents double-posting
 * - Stock is re-validated; if insufficient → REQUIRES_REVIEW
 * - Cash register session is looked up (current open session or most recent)
 * - Accounting entries are only created here (never offline)
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { Pool } from 'pg';
import { salesService, CreateSaleInput } from '../sales/salesService.js';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../rbac/middleware.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import logger from '../../utils/logger.js';
import { cashRegisterService } from '../cash-register/index.js';

// ── Validation ────────────────────────────────────────────────
const SyncPayloadSchema = z.object({
    idempotencyKey: z.string().min(1),
    offlineId: z.string().min(1),
    offlineTimestamp: z.number(),
    saleData: z.object({
        customerId: z.preprocess(
            (v) => (v === '' || v === undefined ? null : v),
            z.string().nullable().optional()
        ),
        quoteId: z.string().optional().nullable(),
        cashRegisterSessionId: z.preprocess(
            (v) => (v === '' || v === undefined ? null : v),
            z.string().nullable().optional()
        ),
        lineItems: z.array(
            z.object({
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
                productType: z.enum(['inventory', 'consumable', 'service']).optional(),
            })
        ).min(1),
        subtotal: z.number().nonnegative(),
        discountAmount: z.number().nonnegative().optional().default(0),
        taxAmount: z.number().nonnegative(),
        totalAmount: z.number().nonnegative(),
        paymentLines: z.array(
            z.object({
                paymentMethod: z.enum(['CASH', 'CARD', 'MOBILE_MONEY', 'AIRTEL_MONEY', 'CREDIT']),
                amount: z.number().nonnegative(),
                reference: z.string().optional(),
            })
        ).min(1),
        saleDate: z.string().optional(),
    }).passthrough(),
});

// ── Route factory ─────────────────────────────────────────────
export function createOfflineSyncRoutes(pool: Pool): Router {
    const router = Router();

    /**
     * POST /api/pos/sync-offline-sales
     * Sync a single offline sale
     */
    router.post(
        '/',
        authenticate,
        requirePermission('pos.create'),
        asyncHandler(async (req, res) => {
            // Use tenant pool when available (multi-tenant), fall back to factory pool
            const dbPool = req.tenantPool || pool;

            // ── 1. Validate payload ──
            const validation = SyncPayloadSchema.safeParse(req.body);
            if (!validation.success) {
                const fieldErrors = validation.error.errors
                    .map((e) => `${e.path.join('.')}: ${e.message}`)
                    .join('; ');
                logger.warn(`[OfflineSync] Payload validation failed: ${fieldErrors}`);
                res.status(400).json({
                    success: false,
                    error: `Invalid offline sale payload: ${fieldErrors}`,
                    details: validation.error.errors,
                });
                return;
            }

            const { idempotencyKey, offlineId, saleData, offlineTimestamp } = validation.data;

            // ── 1b. Reject unresolved offline customer IDs ──
            if (saleData.customerId && saleData.customerId.startsWith('offline_cust_')) {
                logger.warn(`[OfflineSync] Unresolved offline customer ID: ${saleData.customerId} for ${offlineId}`);
                res.status(200).json({
                    success: false,
                    requiresReview: true,
                    error: `Customer was created offline and has not been synced yet. Please sync the customer first, then retry this sale.`,
                    offlineId,
                });
                return;
            }

            // ── 2. Idempotency check ──
            const existing = await dbPool.query(
                `SELECT id, sale_number FROM sales WHERE idempotency_key = $1`,
                [idempotencyKey]
            );

            if (existing.rows.length > 0) {
                // Already synced – return success (idempotent)
                logger.info(`[OfflineSync] Duplicate idempotency key ${idempotencyKey}, returning existing sale`);
                res.json({
                    success: true,
                    data: {
                        saleId: existing.rows[0].id,
                        saleNumber: existing.rows[0].sale_number,
                        alreadySynced: true,
                    },
                });
                return;
            }

            // Resolve the session this cashier should sell against (policy SSOT).
            const userId = req.user?.id;
            let cashRegisterSessionId: string | null = null;

            if (userId) {
                const { session } = await cashRegisterService.getCurrentSessionForUser(userId, dbPool);
                cashRegisterSessionId = session?.id || null;
            }

            // ── 4. Build service input ──
            const serviceInput: CreateSaleInput = {
                customerId: saleData.customerId || null,
                cashRegisterSessionId: cashRegisterSessionId || undefined,
                items: saleData.lineItems.map((item) => ({
                    productId: item.productId,
                    productName: item.productName,
                    uom: item.uom,
                    uomId: item.uomId,
                    quantity: item.quantity,
                    unitPrice: item.unitPrice,
                })),
                subtotal: saleData.subtotal,
                discountAmount: saleData.discountAmount || 0,
                taxAmount: saleData.taxAmount,
                totalAmount: saleData.totalAmount,
                paymentMethod: saleData.paymentLines[0]?.paymentMethod || 'CASH',
                paymentReceived: saleData.totalAmount,
                soldBy: userId || '00000000-0000-0000-0000-000000000000',
                saleDate: saleData.saleDate,
                paymentLines: saleData.paymentLines,
                idempotencyKey,
                offlineId,
            };

            // ── 5. Attempt to create sale via existing service ──
            // idempotency_key is now included in the INSERT (atomic),
            // so a concurrent duplicate triggers a PG unique violation
            // instead of a TOCTOU race.
            try {
                const result = await salesService.createSale(dbPool, {
                    ...serviceInput,
                    auditContext: {
                        userId: userId || '00000000-0000-0000-0000-000000000000',
                        userName: req.user?.fullName,
                        userRole: req.user?.role,
                        ipAddress: req.ip,
                        userAgent: req.headers['user-agent'],
                        sessionId: req.cookies?.sessionId || (req.headers['x-session-id'] as string),
                        requestId: req.requestId,
                    },
                });

                logger.info(`[OfflineSync] Successfully synced offline sale ${offlineId} → ${result.sale.saleNumber}`);

                res.json({
                    success: true,
                    data: {
                        saleId: result.sale.id,
                        saleNumber: result.sale.saleNumber,
                        offlineId,
                    },
                });
            } catch (saleError: unknown) {
                const errMsg = saleError instanceof Error ? saleError.message : String(saleError);

                // ── Duplicate idempotency key (concurrent request already created this sale) ──
                const pgErr = saleError as { code?: string; constraint?: string };
                if (pgErr.code === '23505' && String(pgErr.constraint || errMsg).includes('idempotency_key')) {
                    const dup = await dbPool.query(
                        `SELECT id, sale_number FROM sales WHERE idempotency_key = $1`,
                        [idempotencyKey]
                    );
                    if (dup.rows.length > 0) {
                        logger.info(`[OfflineSync] Concurrent duplicate for ${idempotencyKey}, returning existing sale`);
                        res.json({
                            success: true,
                            data: {
                                saleId: dup.rows[0].id,
                                saleNumber: dup.rows[0].sale_number,
                                alreadySynced: true,
                                offlineId,
                            },
                        });
                        return;
                    }
                }

                // ── Stock conflict → REQUIRES_REVIEW ──
                if (
                    errMsg.includes('Insufficient') ||
                    errMsg.includes('stock') ||
                    errMsg.includes('inventory') ||
                    errMsg.includes('cost layer')
                ) {
                    logger.warn(`[OfflineSync] Stock conflict for ${offlineId}: ${errMsg}`);
                    res.status(200).json({
                        success: false,
                        requiresReview: true,
                        error: errMsg,
                        offlineId,
                    });
                    return;
                }

                // ── All other errors → FAILED with descriptive message ──
                logger.error(`[OfflineSync] Failed to create sale ${offlineId}: ${errMsg}`);
                res.status(200).json({
                    success: false,
                    error: errMsg,
                    offlineId,
                });
            }
        })
    );

    /**
     * GET /api/pos/sync-offline-sales/status
     * Get count of offline sales needing review
     */
    router.get(
        '/status',
        authenticate,
        asyncHandler(async (req, res) => {
            const dbPool = req.tenantPool || pool;
            const result = await dbPool.query(
                `SELECT
            COUNT(*) FILTER (WHERE offline_id IS NOT NULL) AS total_offline,
            COUNT(*) FILTER (WHERE offline_id IS NOT NULL AND status = 'COMPLETED') AS synced
           FROM sales`
            );

            // Sales that need review = offline sales that aren't completed
            const totalOffline = parseInt(result.rows[0]?.total_offline || '0');
            const synced = parseInt(result.rows[0]?.synced || '0');

            res.json({
                success: true,
                data: {
                    totalOffline,
                    synced,
                    pendingReview: totalOffline - synced,
                },
            });
        })
    );

    return router;
}
