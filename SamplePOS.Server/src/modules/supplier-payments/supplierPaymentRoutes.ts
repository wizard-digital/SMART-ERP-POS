/**
 * Supplier Payment Routes - Route definitions
 */

import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { z } from 'zod';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission, requireAnyPermission } from '../../rbac/middleware.js';
import * as supplierPaymentService from './supplierPaymentService.js';
import Decimal from 'decimal.js';
import logger from '../../utils/logger.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import {
    SupplierOpeningBalanceSchema,
    SupplierOpeningBalanceReplaceSchema,
    SupplierOpeningBalanceIncreaseSchema,
    SupplierOpeningBalanceCancelSchema,
} from '../../../../shared/zod/supplierOpeningBalance.js';
import { assertPositiveFinite } from '../../utils/safeParse.js';

// Zod schemas for validation
const UuidParamSchema = z.object({ id: z.string().uuid() });
const SupplierIdParamSchema = z.object({ supplierId: z.string().uuid() });
const PaymentsQuerySchema = z.object({
    page: z
        .string()
        .optional()
        .transform((v) => (v ? parseInt(v) : 1)),
    limit: z
        .string()
        .optional()
        .transform((v) => (v ? parseInt(v) : 50)),
    supplierId: z.string().uuid().optional(),
    paymentMethod: z.string().optional(),
    search: z.string().optional(),
    startDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
    endDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
});
const CreatePaymentSchema = z.object({
    supplierId: z.string().uuid(),
    amount: z.union([z.number().positive(), z.string().transform(Number)]),
    paymentMethod: z.string().min(1),
    paymentDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
    reference: z.string().optional(),
    notes: z.string().optional(),
    targetInvoiceId: z.string().uuid().nullable().optional(),
    bankAccountId: z.string().uuid().nullable().optional(),
    whtTypeId: z.string().uuid().nullable().optional(),
    certificateNumber: z.string().max(100).optional(),
});
const InvoicesQuerySchema = z.object({
    page: z
        .string()
        .optional()
        .transform((v) => (v ? parseInt(v) : 1)),
    limit: z
        .string()
        .optional()
        .transform((v) => (v ? parseInt(v) : 50)),
    supplierId: z.string().uuid().optional(),
    status: z.string().optional(),
    search: z.string().optional(),
    startDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
    endDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
});
const CreateInvoiceSchema = z.object({
    supplierId: z.string().uuid(),
    supplierInvoiceNumber: z.string().optional(),
    invoiceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    dueDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
    notes: z.string().optional(),
    lineItems: z
        .array(
            z.object({
                productName: z.string().min(1),
                description: z.string().optional(),
                quantity: z.number().positive(),
                unitPrice: z.number().nonnegative(),
            })
        )
        .min(1, 'At least one line item is required'),
    grnIds: z.array(z.string().uuid()).optional(),
    /**
     * Required when bill total linked to grnIds differs from received value.
     * SUPPLIER_DISCOUNT or ROUNDING_DIFFERENCE only when supplier billed less.
     * Over-billing is always rejected regardless of reason.
     */
    varianceReason: z
        .enum(['SUPPLIER_DISCOUNT', 'ROUNDING_DIFFERENCE', 'EDIT_LINE_PRICES'])
        .optional(),
});
const CreateInvoiceFromGRNSchema = z.object({
    grnId: z.string().uuid(),
    supplierInvoiceNumber: z.string().optional(),
    invoiceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    notes: z.string().optional(),
    /**
     * Total printed on the supplier's physical invoice.
     * REFERENCE only — never used to back-calculate line costs.
     * When present and it differs from the GRN computed total, varianceReason is required.
     */
    supplierReportedTotal: z.number().positive().optional(),
    /**
     * Why the supplier total differs from the GRN computed total.
     * Required when supplierReportedTotal is present and variance > 0.005.
     * Over-billing is always rejected — only favorable variance (discount/rounding) allowed.
     * ≈10× / ≈0.1× paper totals are rejected as digit typos.
     */
    varianceReason: z
        .enum(['SUPPLIER_DISCOUNT', 'ROUNDING_DIFFERENCE', 'EDIT_LINE_PRICES'])
        .optional(),
});
const CreateAllocationSchema = z.object({
    supplierPaymentId: z.string().uuid(),
    supplierInvoiceId: z.string().uuid(),
    amount: z.union([z.number().positive(), z.string().transform(Number)]),
});

export function createSupplierPaymentRoutes(pool: Pool): Router {
    const router = Router();

    // Apply authentication to all routes
    router.use(authenticate);

    // Resolve tenant pool for multi-tenant support
    const p = (req: Request): Pool => (req as unknown as { tenantPool?: Pool }).tenantPool || pool;

    // ============================================================
    // SUPPLIER PAYMENTS
    // ============================================================

    // Get all supplier payments
    router.get(
        '/payments',
        asyncHandler(async (req, res) => {
            const query = PaymentsQuerySchema.parse(req.query);

            const result = await supplierPaymentService.getSupplierPayments(p(req), {
                page: query.page,
                limit: query.limit,
                supplierId: query.supplierId,
                paymentMethod: query.paymentMethod,
                search: query.search,
                startDate: query.startDate,
                endDate: query.endDate,
            });

            res.json({
                success: true,
                data: result,
            });
        })
    );

    // Get supplier payment by ID
    router.get(
        '/payments/:id',
        asyncHandler(async (req, res) => {
            const { id } = UuidParamSchema.parse(req.params);
            const payment = await supplierPaymentService.getSupplierPaymentById(p(req), id);
            if (!payment) {
                return res.status(404).json({ success: false, error: 'Payment not found' });
            }
            res.json({ success: true, data: payment });
        })
    );

    // Create supplier payment
    router.post(
        '/payments',
        requirePermission('suppliers.create'),
        asyncHandler(async (req, res) => {
            const validated = CreatePaymentSchema.parse(req.body);

            // Use SQL CURRENT_DATE for timezone-safe default (avoids JS Date timezone issues)
            let resolvedPaymentDate = validated.paymentDate;
            if (!resolvedPaymentDate) {
                const dateResult = await p(req).query('SELECT CURRENT_DATE::text as today');
                resolvedPaymentDate = dateResult.rows[0].today;
            }

            const userId = req.user?.id;
            const payment = await supplierPaymentService.createSupplierPayment(
                p(req),
                {
                    supplierId: validated.supplierId,
                    amount: new Decimal(validated.amount).toNumber(),
                    paymentMethod: validated.paymentMethod,
                    paymentDate: resolvedPaymentDate!,
                    reference: validated.reference,
                    notes: validated.notes,
                    targetInvoiceId: validated.targetInvoiceId ?? undefined,
                    bankAccountId: validated.bankAccountId ?? undefined,
                    whtTypeId: validated.whtTypeId ?? undefined,
                    certificateNumber: validated.certificateNumber,
                },
                userId
            );

            res.status(201).json({ success: true, data: payment });
        })
    );

    // Update supplier payment
    router.put(
        '/payments/:id',
        requirePermission('suppliers.update'),
        asyncHandler(async (req, res) => {
            const { id } = UuidParamSchema.parse(req.params);
            const payment = await supplierPaymentService.updateSupplierPayment(p(req), id, req.body);
            if (!payment) {
                return res.status(404).json({ success: false, error: 'Payment not found' });
            }
            res.json({ success: true, data: payment });
        })
    );

    // Delete supplier payment
    router.delete(
        '/payments/:id',
        requirePermission('suppliers.delete'),
        asyncHandler(async (req, res) => {
            const { id } = UuidParamSchema.parse(req.params);
            const result = await supplierPaymentService.deleteSupplierPayment(p(req), id);
            if (!result) {
                return res.status(404).json({ success: false, error: 'Payment not found' });
            }
            res.json({ success: true, message: 'Payment deleted successfully' });
        })
    );

    // Get payment allocations
    router.get(
        '/payments/:id/allocations',
        asyncHandler(async (req, res) => {
            const { id } = UuidParamSchema.parse(req.params);
            const allocations = await supplierPaymentService.getPaymentAllocations(p(req), id);
            res.json({ success: true, data: allocations });
        })
    );

    // Auto-allocate payment
    router.post(
        '/payments/:id/auto-allocate',
        requirePermission('suppliers.create'),
        asyncHandler(async (req, res) => {
            const { id } = UuidParamSchema.parse(req.params);
            const userId = req.user?.id;
            const allocations = await supplierPaymentService.autoAllocatePayment(p(req), id, userId);
            res.json({ success: true, data: allocations });
        })
    );

    const ReversePaymentSchema = z.object({
        reason: z.string().min(5),
        reversalDate: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional(),
    });

    const CorrectPaymentMethodSchema = z.object({
        newPaymentMethod: z.string().min(1),
        reason: z.string().min(5),
        paymentDate: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional(),
        reference: z.string().optional(),
        notes: z.string().optional(),
        bankAccountId: z.string().uuid().optional(),
        reallocate: z.boolean().optional(),
    });

    // Reverse completed supplier payment (unapply + reverse GL) — SAP FBRA / Odoo cancel
    router.post(
        '/payments/:id/reverse',
        requireAnyPermission(['corrections.execute', 'suppliers.update']),
        asyncHandler(async (req, res) => {
            const { id } = UuidParamSchema.parse(req.params);
            const body = ReversePaymentSchema.parse(req.body);
            const userId = req.user?.id;
            if (!userId) {
                return res.status(401).json({ success: false, error: 'Authentication required' });
            }
            const result = await supplierPaymentService.reverseSupplierPayment(
                p(req),
                id,
                userId,
                body.reason,
                { reversalDate: body.reversalDate },
            );
            res.json({ success: true, data: result });
        })
    );

    // Correct payment method (reverse + re-post with new method) e.g. CASH → BANK_TRANSFER
    router.post(
        '/payments/:id/correct-method',
        requireAnyPermission(['corrections.execute', 'suppliers.update']),
        asyncHandler(async (req, res) => {
            const { id } = UuidParamSchema.parse(req.params);
            const body = CorrectPaymentMethodSchema.parse(req.body);
            const userId = req.user?.id;
            if (!userId) {
                return res.status(401).json({ success: false, error: 'Authentication required' });
            }
            const result = await supplierPaymentService.correctSupplierPaymentMethod(
                p(req),
                id,
                body,
                userId,
            );
            res.json({ success: true, data: result });
        })
    );

    // ============================================================
    // SUPPLIER INVOICES (BILLS)
    // ============================================================

    // Get supplier invoice summary stats (total, unpaid, outstanding)
    router.get('/invoices/summary', async (_req: Request, res: Response) => {
        try {
            const summary = await supplierPaymentService.getInvoiceSummary(
                (_req as unknown as { tenantPool?: Pool }).tenantPool || pool
            );
            res.json({ success: true, data: summary });
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            logger.error('Error fetching invoice summary', { error: message });
            res.status(500).json({ success: false, error: message });
        }
    });

    // Get all supplier invoices
    router.get(
        '/invoices',
        requirePermission('suppliers.read'),
        asyncHandler(async (req, res) => {
            const query = InvoicesQuerySchema.parse(req.query);

            const result = await supplierPaymentService.getSupplierInvoices(p(req), {
                page: query.page,
                limit: query.limit,
                supplierId: query.supplierId,
                status: query.status,
                search: query.search,
                startDate: query.startDate,
                endDate: query.endDate,
            });

            res.json({
                success: true,
                data: result,
            });
        })
    );

    // ─── 3-way match: unbilled GRNs ──────────────────────────────────────────
    // Returns GRNs that have been received but not yet linked to a posted invoice.
    // Used by the Supplier Bills UI to let the user select which GRNs to bill.
    router.get(
        '/invoices/unbilled-grns',
        requirePermission('suppliers.read'),
        asyncHandler(async (req, res) => {
            const supplierId = typeof req.query.supplierId === 'string'
                ? req.query.supplierId
                : undefined;
            const grns = await supplierPaymentService.getUnbilledGRNs(p(req), supplierId);
            res.json({ success: true, data: grns });
        }),
    );

    // ─── 3-way match: post invoice to GL ─────────────────────────────────────
    // Posts DR GRN/IR Clearing (2150) / CR Accounts Payable (2100).
    // SYSTEM RULE: AP is only created via this endpoint, never from GRN finalization.
    router.post(
        '/invoices/:id/post',
        requirePermission('suppliers.create'),
        asyncHandler(async (req, res) => {
            const { id } = UuidParamSchema.parse(req.params);
            await supplierPaymentService.postInvoiceToGL(p(req), id);
            res.json({ success: true, message: 'Invoice posted to GL' });
        }),
    );

    // Get supplier invoice with full details (line items + allocations)
    router.get(
        '/invoices/:id/details',
        asyncHandler(async (req, res) => {
            const { id } = UuidParamSchema.parse(req.params);
            const details = await supplierPaymentService.getSupplierInvoiceWithDetails(p(req), id);
            if (!details) {
                return res.status(404).json({ success: false, error: 'Invoice not found' });
            }
            res.json({ success: true, data: details });
        })
    );

    // Legacy PDF path — redirect to documents SSOT (same pattern as customer /invoices/:id/export.pdf)
    router.get(
        '/invoices/:id/pdf',
        asyncHandler(async (req, res) => {
            res.redirect(307, `/api/documents/SUPPLIER_INVOICE/${req.params.id}`);
        }),
    );

    // ============================================================
    // MASS PAYMENT RUN
    // ============================================================

    // Get all unpaid invoices across all suppliers (for mass payment picker)
    // Must be registered before /invoices/:id to avoid ambiguous match
    router.get(
        '/invoices/unpaid-all',
        asyncHandler(async (req, res) => {
            const query = z.object({
                asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
                supplierId: z.string().uuid().optional(),
                search: z.string().optional(),
            }).parse(req.query);

            const items = await supplierPaymentService.getAllUnpaidInvoicesForMassPayment(
                p(req),
                query
            );
            res.json({ success: true, data: items });
        })
    );

    // ============================================================
    // SUPPLIER OPENING BALANCE IMPORT
    // ============================================================

    router.get(
        '/invoices/opening-balance/history',
        requirePermission('accounting.opening_balance'),
        asyncHandler(async (req, res) => {
            const supplierId = z.string().uuid().parse(req.query.supplierId);
            const result = await supplierPaymentService.getSupplierOpeningBalanceHistory(
                p(req),
                supplierId,
            );
            res.json({ success: true, data: result.data, total: result.total });
        }),
    );

    router.get(
        '/invoices/opening-balance/summary',
        requirePermission('accounting.opening_balance'),
        asyncHandler(async (req, res) => {
            const supplierId = z.string().uuid().parse(req.query.supplierId);
            const result = await supplierPaymentService.getSupplierCutoverSummary(p(req), supplierId);
            res.json({ success: true, data: result });
        }),
    );

    router.post(
        '/invoices/opening-balance',
        requirePermission('accounting.opening_balance'),
        asyncHandler(async (req, res) => {
            const validated = SupplierOpeningBalanceSchema.parse(req.body);
            const result = await supplierPaymentService.importSupplierOpeningBalance(p(req), {
                supplierId: validated.supplierId,
                amount: assertPositiveFinite(validated.amount, 'Opening balance amount'),
                asOfDate: validated.asOfDate,
                dueDate: validated.dueDate,
                notes: validated.notes,
                postReason: validated.postReason,
                userId: req.user!.id,
                userName: req.user!.fullName,
                userRole: req.user!.role,
            });
            res.status(201).json({ success: true, data: result });
        })
    );

    router.post(
        '/invoices/opening-balance/replace',
        requirePermission('accounting.opening_balance'),
        asyncHandler(async (req, res) => {
            const validated = SupplierOpeningBalanceReplaceSchema.parse(req.body);
            const result = await supplierPaymentService.replaceSupplierOpeningBalance(p(req), {
                supplierId: validated.supplierId,
                amount: assertPositiveFinite(validated.amount, 'Opening balance amount'),
                asOfDate: validated.asOfDate,
                dueDate: validated.dueDate,
                notes: validated.notes,
                postReason: validated.replaceReason,
                userId: req.user!.id,
                userName: req.user!.fullName,
                userRole: req.user!.role,
                replaceReason: validated.replaceReason,
            });
            res.status(201).json({ success: true, data: result });
        }),
    );

    router.post(
        '/invoices/opening-balance/increase',
        requirePermission('accounting.opening_balance'),
        asyncHandler(async (req, res) => {
            const validated = SupplierOpeningBalanceIncreaseSchema.parse(req.body);
            const result = await supplierPaymentService.increaseSupplierOpeningBalance(p(req), {
                supplierId: validated.supplierId,
                increaseBy: assertPositiveFinite(validated.increaseBy, 'Increase amount'),
                amount: assertPositiveFinite(validated.increaseBy, 'Increase amount'), // placeholder overwritten
                asOfDate: validated.asOfDate,
                dueDate: validated.dueDate,
                notes: validated.notes,
                postReason: validated.reason,
                reason: validated.reason,
                userId: req.user!.id,
                userName: req.user!.fullName,
                userRole: req.user!.role,
            });
            res.status(201).json({ success: true, data: result });
        }),
    );

    router.post(
        '/invoices/opening-balance/cancel',
        requirePermission('accounting.opening_balance'),
        asyncHandler(async (req, res) => {
            const validated = SupplierOpeningBalanceCancelSchema.parse(req.body);
            const result = await supplierPaymentService.cancelSupplierOpeningBalance(
                p(req),
                validated.invoiceId,
                req.user!.id,
                validated.reason,
                { userName: req.user!.fullName, userRole: req.user!.role },
            );
            res.json({ success: true, data: result });
        }),
    );

    // Get supplier invoice by ID
    router.get(
        '/invoices/:id',
        asyncHandler(async (req, res) => {
            const { id } = UuidParamSchema.parse(req.params);
            const invoice = await supplierPaymentService.getSupplierInvoiceById(p(req), id);
            if (!invoice) {
                return res.status(404).json({ success: false, error: 'Invoice not found' });
            }
            res.json({ success: true, data: invoice });
        })
    );

    // Create supplier invoice
    router.post(
        '/invoices',
        requirePermission('purchasing.create'),
        asyncHandler(async (req, res) => {
            const validated = CreateInvoiceSchema.parse(req.body);

            const userId = req.user?.id;
            const invoice = await supplierPaymentService.createSupplierInvoice(
                p(req),
                {
                    supplierId: validated.supplierId,
                    supplierInvoiceNumber: validated.supplierInvoiceNumber,
                    invoiceDate: validated.invoiceDate,
                    dueDate: validated.dueDate,
                    notes: validated.notes,
                    lineItems: validated.lineItems,
                    grnIds: validated.grnIds,
                    varianceReason: validated.varianceReason,
                },
                userId
            );

            res.status(201).json({ success: true, data: invoice });
        })
    );

    // Authoritative GR billable total (PricingEngine SSOT — UI must not compute locally)
    router.get(
        '/grns/:grnId/billable-total',
        requirePermission('purchasing.create'),
        asyncHandler(async (req, res) => {
            const { grnId } = z.object({ grnId: z.string().uuid() }).parse(req.params);
            const preview = await supplierPaymentService.getGrnBillableTotalPreview(p(req), grnId);
            res.json({ success: true, data: preview });
        }),
    );

    // Create supplier invoice from a Goods Receipt (3-way match one-click bill)
    router.post(
        '/invoices/from-grn',
        requirePermission('purchasing.create'),
        asyncHandler(async (req, res) => {
            const validated = CreateInvoiceFromGRNSchema.parse(req.body);
            const invoice = await supplierPaymentService.createInvoiceFromGRN(
                p(req),
                {
                    grnId: validated.grnId,
                    supplierInvoiceNumber: validated.supplierInvoiceNumber,
                    invoiceDate: validated.invoiceDate,
                    dueDate: validated.dueDate,
                    notes: validated.notes,
                    supplierReportedTotal: validated.supplierReportedTotal,
                    varianceReason: validated.varianceReason,
                },
                req.user?.id,
            );
            res.status(201).json({ success: true, data: invoice });
        })
    );

    const CancelSupplierInvoiceSchema = z.object({
        reason: z.string().trim().min(3, 'Cancellation reason is required (min 3 characters)'),
    });

    // Cancel unpaid supplier bill (reverse GL + mark Cancelled — GR can be rebilled)
    router.post(
        '/invoices/:id/cancel',
        requirePermission('purchasing.cancel_bill'),
        asyncHandler(async (req, res) => {
            const { id } = UuidParamSchema.parse(req.params);
            const validated = CancelSupplierInvoiceSchema.parse(req.body);
            const userId = req.user?.id;
            if (!userId) {
                return res.status(401).json({ success: false, error: 'Authentication required' });
            }
            const result = await supplierPaymentService.cancelSupplierInvoice(
                p(req),
                id,
                userId,
                validated.reason,
            );
            res.json({
                success: true,
                message: `Bill ${result.invoiceNumber} cancelled${result.glReversed ? ' (GL reversed)' : ''}`,
                data: result,
            });
        }),
    );

    // Delete supplier invoice
    router.delete(
        '/invoices/:id',
        requirePermission('purchasing.delete'),
        asyncHandler(async (req, res) => {
            const { id } = UuidParamSchema.parse(req.params);
            const result = await supplierPaymentService.deleteSupplierInvoice(p(req), id);
            if (!result) {
                return res.status(404).json({ success: false, error: 'Invoice not found' });
            }
            res.json({ success: true, message: 'Invoice deleted successfully' });
        })
    );

    // Get outstanding invoices for a supplier
    router.get(
        '/suppliers/:supplierId/outstanding-invoices',
        asyncHandler(async (req, res) => {
            const { supplierId } = SupplierIdParamSchema.parse(req.params);
            const invoices = await supplierPaymentService.getOutstandingInvoices(p(req), supplierId);
            res.json({ success: true, data: invoices });
        })
    );

    // Get ALL invoices for a supplier (with line item counts)
    router.get(
        '/suppliers/:supplierId/invoices',
        asyncHandler(async (req, res) => {
            const { supplierId } = SupplierIdParamSchema.parse(req.params);
            const invoices = await supplierPaymentService.getSupplierInvoicesBySupplier(
                p(req),
                supplierId
            );
            res.json({ success: true, data: invoices });
        })
    );

    // ============================================================
    // PAYMENT ALLOCATIONS
    // ============================================================

    // Allocate payment to invoice
    router.post(
        '/allocations',
        requirePermission('suppliers.create'),
        asyncHandler(async (req, res) => {
            const validated = CreateAllocationSchema.parse(req.body);

            const userId = req.user?.id;
            const allocation = await supplierPaymentService.allocatePayment(
                p(req),
                {
                    supplierPaymentId: validated.supplierPaymentId,
                    supplierInvoiceId: validated.supplierInvoiceId,
                    amount: new Decimal(validated.amount).toNumber(),
                },
                userId
            );

            res.status(201).json({ success: true, data: allocation });
        })
    );

    // Remove allocation
    router.delete(
        '/allocations/:id',
        requirePermission('suppliers.delete'),
        asyncHandler(async (req, res) => {
            const { id } = UuidParamSchema.parse(req.params);
            const result = await supplierPaymentService.removeAllocation(p(req), id);
            if (!result) {
                return res.status(404).json({ success: false, error: 'Allocation not found' });
            }
            res.json({ success: true, message: 'Allocation removed successfully' });
        })
    );

    // Post mass payment run (multiple suppliers, multiple invoices in one operation)
    const MassPaymentRunSchema = z.object({
        paymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        paymentMethod: z.string().min(1),
        reference: z.string().optional(),
        notes: z.string().optional(),
        bankAccountId: z.string().uuid().optional(),
        allocations: z.array(z.object({
            supplierId: z.string().uuid(),
            invoiceId: z.string().uuid(),
            amount: z.union([z.number().positive(), z.string().transform(Number)]),
        })).min(1, 'At least one allocation is required'),
    });

    router.post(
        '/payments/mass-run',
        requirePermission('suppliers.create'),
        asyncHandler(async (req, res) => {
            const validated = MassPaymentRunSchema.parse(req.body);
            const userId = req.user?.id;
            const result = await supplierPaymentService.massPaymentRun(
                p(req),
                {
                    paymentDate: validated.paymentDate,
                    paymentMethod: validated.paymentMethod,
                    reference: validated.reference,
                    notes: validated.notes,
                    bankAccountId: validated.bankAccountId,
                    allocations: validated.allocations.map((a) => ({
                        supplierId: a.supplierId,
                        invoiceId: a.invoiceId,
                        amount: new Decimal(a.amount).toNumber(),
                    })),
                },
                userId
            );
            res.status(201).json({ success: true, data: result });
        })
    );

    return router;
}
