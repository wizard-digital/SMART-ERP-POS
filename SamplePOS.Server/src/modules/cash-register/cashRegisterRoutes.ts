/**
 * Cash Register Routes
 *
 * REST API endpoints for cash register management.
 * Follows existing route patterns with Zod validation.
 */

import express from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission, getAuthorizationService } from '../../rbac/middleware.js';
import { cashRegisterService } from './cashRegisterService.js';
import logger from '../../utils/logger.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { pool as globalPool } from '../../db/pool.js';

const router = express.Router();

// =============================================================================
// VALIDATION SCHEMAS
// =============================================================================

const CreateRegisterSchema = z.object({
    name: z.string().min(1).max(100),
    location: z.string().max(255).optional(),
});

const UpdateRegisterSchema = z.object({
    name: z.string().min(1).max(100).optional(),
    location: z
        .string()
        .max(255)
        .optional()
        .nullable()
        .transform((val) => val ?? undefined),
    isActive: z.boolean().optional(),
});

const OpenSessionSchema = z.object({
    registerId: z.string().uuid(),
    openingFloat: z.number().nonnegative(),
    blindCountEnabled: z.boolean().optional().default(false), // QuickBooks/Odoo: hide expected
    varianceThreshold: z.number().nonnegative().optional().default(0), // Auto-approve below this
});

const CloseSessionSchema = z.object({
    actualClosing: z.number().nonnegative(),
    varianceReason: z.string().max(500).optional(),
    notes: z.string().max(1000).optional(),
    denominationBreakdown: z.record(z.string(), z.number()).optional(), // Cash by denomination
});

const RecordMovementSchema = z.object({
    sessionId: z.string().uuid(),
    movementType: z.enum([
        'CASH_IN',
        'CASH_IN_FLOAT',
        'CASH_IN_PAYMENT',
        'CASH_IN_OTHER',
        'CASH_OUT',
        'CASH_OUT_BANK',
        'CASH_OUT_EXPENSE',
        'CASH_OUT_OTHER',
    ]),
    amount: z.number().positive(),
    reason: z.string().max(255).optional(),
    approvedBy: z.string().uuid().optional(),
    paymentMethod: z.enum(['CASH', 'CARD', 'MOBILE_MONEY', 'CREDIT', 'OTHER']).optional(),
    invoiceId: z.string().uuid().optional(),
    customerId: z.string().uuid().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    clientUuid: z.string().uuid().optional(),
}).superRefine((val, ctx) => {
    if (val.movementType === 'CASH_IN_PAYMENT') {
        if (!val.customerId) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'Customer Payment requires customerId',
                path: ['customerId'],
            });
        }
        if (!val.invoiceId) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'Customer Payment requires invoiceId',
                path: ['invoiceId'],
            });
        }
    }
});

const SessionQuerySchema = z.object({
    registerId: z.string().uuid().optional(),
    userId: z.string().uuid().optional(),
    status: z.enum(['OPEN', 'CLOSED', 'RECONCILED']).optional(),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    limit: z.coerce.number().positive().max(100).optional(),
    offset: z.coerce.number().nonnegative().optional(),
});

const UuidParamSchema = z.object({
    id: z.string().uuid(),
});

const ApproveVarianceBodySchema = z.object({
    notes: z.string().max(1000).optional(),
});

// =============================================================================
// HEALTH CHECK
// =============================================================================

router.get('/health', (_req, res) => {
    res.json({
        success: true,
        data: {
            status: 'healthy',
            module: 'cash-register',
            timestamp: new Date().toISOString(),
        },
    });
});

// =============================================================================
// REGISTER ENDPOINTS
// =============================================================================

/**
 * GET /api/cash-registers
 * Get all registers with current session status
 * Managers/admins see all registers; staff see active only (with session info)
 */
router.get(
    '/',
    authenticate,
    asyncHandler(async (req, res) => {
        const pool = req.tenantPool || globalPool;
        const authz = getAuthorizationService(req);
        const subject = authz.subjectFromUser(req.user);
        const canViewAllRegisters = subject
            ? await authz.hasPermission(subject, 'pos.approve')
            : false;

        // Always include session status so the Open Register dialog knows availability
        const registersWithStatus = await cashRegisterService.getRegistersWithStatus(pool);

        // Staff only see active registers (already filtered in query)
        // Users with pos.approve see all (need to include inactive too)
        const registers = canViewAllRegisters ? await cashRegisterService.getAllRegisters(pool) : [];

        // Merge: for privileged users, enrich all registers with session info
        if (canViewAllRegisters && registers.length > 0) {
            const statusMap = new Map(registersWithStatus.map((r) => [r.id, r]));
            const enriched = registers.map((reg) => {
                const status = statusMap.get(reg.id);
                return {
                    ...reg,
                    currentSessionId: status?.currentSessionId || null,
                    currentSessionNumber: status?.currentSessionNumber || null,
                    currentSessionUserId: status?.currentSessionUserId || null,
                    currentSessionUserName: status?.currentSessionUserName || null,
                    currentSessionOpenedAt: status?.currentSessionOpenedAt || null,
                };
            });
            return res.json({ success: true, data: enriched });
        }

        res.json({
            success: true,
            data: registersWithStatus,
        });
    })
);

// =============================================================================
// Z-REPORT HISTORY (must be before /:id to avoid route shadowing)
// =============================================================================

const ZReportQuerySchema = z.object({
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    registerId: z.string().uuid().optional(),
    limit: z.coerce.number().positive().max(100).optional(),
    offset: z.coerce.number().nonnegative().optional(),
});

/**
 * GET /api/cash-registers/z-reports
 * Get Z-Report history with filters (enterprise audit)
 * NOTE: Must be defined before /:id to prevent Express matching 'z-reports' as :id param
 */
router.get(
    '/z-reports',
    authenticate,
    asyncHandler(async (req, res) => {
        const pool = req.tenantPool || globalPool;
        const filters = ZReportQuerySchema.parse(req.query);
        const result = await cashRegisterService.getZReportHistory(filters, pool);

        res.json({
            success: true,
            data: result.reports,
            pagination: {
                total: result.total,
                limit: filters.limit || 50,
                offset: filters.offset || 0,
            },
        });
    })
);

/**
 * GET /api/cash-registers/:id
 * Get register by ID
 */
router.get(
    '/:id',
    authenticate,
    asyncHandler(async (req, res) => {
        const pool = req.tenantPool || globalPool;
        const { id } = UuidParamSchema.parse(req.params);
        const register = await cashRegisterService.getRegisterById(id, pool);

        if (!register) {
            return res.status(404).json({
                success: false,
                error: 'Register not found',
            });
        }

        res.json({
            success: true,
            data: register,
        });
    })
);

/**
 * POST /api/cash-registers
 * Create a new register (admin/manager only)
 */
router.post(
    '/',
    authenticate,
    requirePermission('pos.create'),
    asyncHandler(async (req, res) => {
        const pool = req.tenantPool || globalPool;
        const data = CreateRegisterSchema.parse(req.body);
        const user = req.user as { id: string };

        const register = await cashRegisterService.createRegister(data, user.id, pool);

        res.status(201).json({
            success: true,
            data: register,
            message: 'Register created successfully',
        });
    })
);

/**
 * PUT /api/cash-registers/:id
 * Update a register (admin/manager only)
 */
router.put(
    '/:id',
    authenticate,
    requirePermission('pos.create'),
    asyncHandler(async (req, res) => {
        const pool = req.tenantPool || globalPool;
        const { id } = UuidParamSchema.parse(req.params);
        const data = UpdateRegisterSchema.parse(req.body);
        const user = req.user as { id: string };

        const register = await cashRegisterService.updateRegister(id, data, user.id, pool);

        if (!register) {
            return res.status(404).json({
                success: false,
                error: 'Register not found',
            });
        }

        res.json({
            success: true,
            data: register,
            message: 'Register updated successfully',
        });
    })
);

// =============================================================================
// SESSION ENDPOINTS
// =============================================================================

/**
 * GET /api/cash-registers/sessions/current
 * Get current user's open session + active session policy
 */
router.get(
    '/sessions/current',
    authenticate,
    asyncHandler(async (req, res) => {
        const pool = req.tenantPool || globalPool;
        const user = req.user as { id: string };
        const { session, posSessionPolicy } = await cashRegisterService.getCurrentSessionForUser(
            user.id,
            pool
        );

        const settingsRow = await pool.query(
            `SELECT pos_transaction_mode FROM system_settings LIMIT 1`
        );
        const posTransactionMode = (settingsRow.rows[0]?.pos_transaction_mode as string) || 'DirectSale';

        res.json({
            success: true,
            data: session, // null if no open session
            posSessionPolicy,
            posTransactionMode,
        });
    })
);

/**
 * GET /api/cash-registers/sessions
 * Get sessions with filters
 */
router.get(
    '/sessions',
    authenticate,
    asyncHandler(async (req, res) => {
        const pool = req.tenantPool || globalPool;
        const filters = SessionQuerySchema.parse(req.query);
        const result = await cashRegisterService.getSessions(filters, pool);

        res.json({
            success: true,
            data: result.sessions,
            pagination: {
                total: result.total,
                limit: filters.limit || 50,
                offset: filters.offset || 0,
            },
        });
    })
);

/**
 * GET /api/cash-registers/sessions/:id
 * Get session by ID
 */
router.get(
    '/sessions/:id',
    authenticate,
    asyncHandler(async (req, res) => {
        const pool = req.tenantPool || globalPool;
        const { id } = UuidParamSchema.parse(req.params);
        const session = await cashRegisterService.getSessionById(id, pool);

        if (!session) {
            return res.status(404).json({
                success: false,
                error: 'Session not found',
            });
        }

        res.json({
            success: true,
            data: session,
        });
    })
);

/**
 * GET /api/cash-registers/sessions/:id/summary
 * Get full session summary with movements
 */
router.get(
    '/sessions/:id/summary',
    authenticate,
    asyncHandler(async (req, res) => {
        const pool = req.tenantPool || globalPool;
        const { id } = UuidParamSchema.parse(req.params);
        const summary = await cashRegisterService.getSessionSummary(id, pool);

        if (!summary) {
            return res.status(404).json({
                success: false,
                error: 'Session not found',
            });
        }

        res.json({
            success: true,
            data: summary,
        });
    })
);

/**
 * POST /api/cash-registers/sessions/open
 * Open a new register session
 */
router.post(
    '/sessions/open',
    authenticate,
    asyncHandler(async (req, res) => {
        const pool = req.tenantPool || globalPool;
        const data = OpenSessionSchema.parse(req.body);
        const user = req.user as { id: string };

        const session = await cashRegisterService.openSession(
            {
                ...data,
                userId: user.id,
            },
            pool
        );

        res.status(201).json({
            success: true,
            data: session,
            message: 'Session opened successfully',
        });
    })
);

/**
 * POST /api/cash-registers/sessions/:id/close
 * Close a register session
 */
router.post(
    '/sessions/:id/close',
    authenticate,
    asyncHandler(async (req, res) => {
        const pool = req.tenantPool || globalPool;
        const { id } = UuidParamSchema.parse(req.params);
        const data = CloseSessionSchema.parse(req.body);
        const user = req.user as { id: string };

        const session = await cashRegisterService.closeSession(
            {
                sessionId: id,
                ...data,
            },
            user.id,
            pool
        );

        res.json({
            success: true,
            data: session,
            message: 'Session closed successfully',
        });
    })
);

/**
 * POST /api/cash-registers/sessions/:id/reconcile
 * Reconcile a closed session (manager only)
 */
router.post(
    '/sessions/:id/reconcile',
    authenticate,
    requirePermission('pos.approve'),
    async (req, res) => {
        try {
            const pool = req.tenantPool || globalPool;
            const { id } = UuidParamSchema.parse(req.params);
            const user = req.user as { id: string };
            const session = await cashRegisterService.reconcileSession(id, user.id, pool);

            res.json({
                success: true,
                data: session,
                message: 'Session reconciled successfully',
            });
        } catch (error) {
            if (
                error instanceof Error &&
                ['SESSION_NOT_FOUND', 'SESSION_NOT_CLOSED'].some((code) =>
                    (error instanceof Error ? error.message : String(error)).includes(code)
                )
            ) {
                return res.status(400).json({
                    success: false,
                    error: error instanceof Error ? error.message : String(error),
                });
            }

            logger.error('Error reconciling session:', error);
            res.status(500).json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to reconcile session',
            });
        }
    }
);

/**
 * POST /api/cash-registers/sessions/:id/force-close
 * Force-close a stale/abandoned session (admin/manager only)
 * Used when a cashier left without closing, blocking the register
 */
router.post(
    '/sessions/:id/force-close',
    authenticate,
    requirePermission('pos.approve'),
    async (req, res) => {
        try {
            const pool = req.tenantPool || globalPool;
            const { id } = UuidParamSchema.parse(req.params);
            const user = req.user as { id: string };
            const session = await cashRegisterService.forceCloseSession(id, user.id, pool);

            res.json({
                success: true,
                data: session,
                message: 'Session force-closed successfully',
            });
        } catch (error) {
            if (
                error instanceof Error &&
                ['SESSION_NOT_FOUND', 'SESSION_NOT_OPEN'].some((code) =>
                    (error instanceof Error ? error.message : String(error)).includes(code)
                )
            ) {
                return res.status(400).json({
                    success: false,
                    error: error instanceof Error ? error.message : String(error),
                });
            }

            logger.error('Error force-closing session:', error);
            res.status(500).json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to force-close session',
            });
        }
    }
);

// =============================================================================
// MOVEMENT ENDPOINTS
// =============================================================================

/**
 * GET /api/cash-registers/sessions/:id/movements
 * Get movements for a session
 */
router.get(
    '/sessions/:id/movements',
    authenticate,
    asyncHandler(async (req, res) => {
        const pool = req.tenantPool || globalPool;
        const { id } = UuidParamSchema.parse(req.params);
        const movements = await cashRegisterService.getSessionMovements(id, pool);

        res.json({
            success: true,
            data: movements,
        });
    })
);

/**
 * POST /api/cash-registers/movements
 * Record a cash movement (cash in/out)
 */
router.post(
    '/movements',
    authenticate,
    asyncHandler(async (req, res) => {
        const pool = req.tenantPool || globalPool;
        const data = RecordMovementSchema.parse(req.body);
        const user = req.user as { id: string };

        // For CASH_OUT types over a threshold, require approval
        // (This is a simplified check - in production, use a configurable threshold)
        const CASH_OUT_APPROVAL_THRESHOLD = 100000; // UGX
        const isCashOutType = data.movementType.startsWith('CASH_OUT');
        if (isCashOutType && data.amount > CASH_OUT_APPROVAL_THRESHOLD && !data.approvedBy) {
            return res.status(400).json({
                success: false,
                error: `Cash out over ${CASH_OUT_APPROVAL_THRESHOLD.toLocaleString()} UGX requires manager approval`,
            });
        }

        const movement = await cashRegisterService.recordMovement(
            {
                ...data,
                userId: user.id,
                customerId: data.customerId,
                invoiceId: data.invoiceId,
                metadata: data.metadata as Record<string, unknown> | undefined,
                clientUuid: data.clientUuid,
            },
            pool
        );

        res.status(201).json({
            success: true,
            data: movement,
            message: 'Movement recorded successfully',
        });
    })
);

// =============================================================================
// REPORT ENDPOINTS (QuickBooks/Odoo Standard)
// =============================================================================

/**
 * GET /api/cash-registers/sessions/:id/x-report
 * Generate X-Report (interim report - session stays OPEN)
 *
 * QuickBooks/Odoo equivalent: Interim cash register report
 */
router.get(
    '/sessions/:id/x-report',
    authenticate,
    asyncHandler(async (req, res) => {
        const pool = req.tenantPool || globalPool;
        const { id } = UuidParamSchema.parse(req.params);
        const report = await cashRegisterService.generateXReport(id, pool);

        res.json({
            success: true,
            data: report,
        });
    })
);

const ZReportSchema = z.object({
    actualClosing: z.number().nonnegative(),
    denominationBreakdown: z.record(z.string(), z.number()).optional(),
    varianceReason: z.string().max(500).optional(),
});

/**
 * POST /api/cash-registers/sessions/:id/z-report
 * Generate Z-Report (end of day - closes session)
 *
 * QuickBooks/Odoo equivalent: End-of-day closing report
 */
router.post(
    '/sessions/:id/z-report',
    authenticate,
    asyncHandler(async (req, res) => {
        const pool = req.tenantPool || globalPool;
        const { id } = UuidParamSchema.parse(req.params);
        const data = ZReportSchema.parse(req.body);
        const user = req.user as { id: string };

        const report = await cashRegisterService.generateZReport(
            id,
            data.actualClosing,
            data.denominationBreakdown,
            data.varianceReason,
            user.id,
            pool
        );

        res.json({
            success: true,
            data: report,
            message: 'Z-Report generated and session closed',
        });
    })
);

/**
 * POST /api/cash-registers/sessions/:id/approve-variance
 * Approve a cash variance (manager only)
 *
 * QuickBooks/Odoo equivalent: Variance sign-off
 */
router.post(
    '/sessions/:id/approve-variance',
    authenticate,
    requirePermission('pos.approve'),
    async (req, res) => {
        try {
            const pool = req.tenantPool || globalPool;
            const { id } = UuidParamSchema.parse(req.params);
            const user = req.user as { id: string };
            const { notes } = ApproveVarianceBodySchema.parse(req.body);

            const session = await cashRegisterService.approveVariance(id, user.id, notes, pool);

            res.json({
                success: true,
                data: session,
                message: 'Variance approved',
            });
        } catch (error) {
            if (
                error instanceof Error &&
                ['SESSION_NOT_FOUND', 'SESSION_NOT_CLOSED'].some((code) =>
                    (error instanceof Error ? error.message : String(error)).includes(code)
                )
            ) {
                return res.status(400).json({
                    success: false,
                    error: error instanceof Error ? error.message : String(error),
                });
            }

            logger.error('Error approving variance:', error);
            res.status(500).json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to approve variance',
            });
        }
    }
);

// =============================================================================
// RECONCILIATION HISTORY (Enterprise Upgrade 1)
// =============================================================================

/**
 * GET /api/cash-registers/sessions/:id/reconciliations
 * Get reconciliation audit trail for a session
 */
router.get(
    '/sessions/:id/reconciliations',
    authenticate,
    asyncHandler(async (req, res) => {
        const pool = req.tenantPool || globalPool;
        const { id } = UuidParamSchema.parse(req.params);
        const reconciliations = await cashRegisterService.getSessionReconciliations(id, pool);

        res.json({
            success: true,
            data: reconciliations,
        });
    })
);

// =============================================================================
// Z-REPORT STORED (Enterprise Upgrade 3 - per-session reprint)
// =============================================================================

/**
 * GET /api/cash-registers/sessions/:id/z-report-stored
 * Get persisted Z-Report for a session (for reprint)
 */
router.get(
    '/sessions/:id/z-report-stored',
    authenticate,
    asyncHandler(async (req, res) => {
        const pool = req.tenantPool || globalPool;
        const { id } = UuidParamSchema.parse(req.params);
        const report = await cashRegisterService.getStoredZReport(id, pool);

        if (!report) {
            return res.status(404).json({
                success: false,
                error: 'No Z-Report found for this session',
            });
        }

        res.json({
            success: true,
            data: report,
        });
    })
);

export default router;
