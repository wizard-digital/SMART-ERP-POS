import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { EnterpriseListQueryFields } from '../../../../shared/zod/enterpriseListQuery.js';
import { pool as globalPool } from '../../db/pool.js';
import { salesService, CreateSaleInput, RefundSaleInput } from './salesService.js';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission, requireAnyPermission, getRbacService } from '../../rbac/middleware.js';
import { normalizeResponse, normalizePaginatedResponse } from '../../utils/caseConverter.js';
import { POSSaleSchema, POSSaleLineItemSchema } from '../../../../shared/zod/pos-sale.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import {
  shouldRestrictSalesToOwnUser,
  canProcessRefundType,
  sanitizeSaleFinancialFields,
} from '@shared/authorization/salesPolicy.js';

export { shouldRestrictSalesToOwnUser, canProcessRefundType, sanitizeSaleFinancialFields };

async function getEffectivePermissionKeys(req: Request): Promise<Set<string>> {
  if (req.authContext?.permissions) {
    return req.authContext.permissions;
  }

  if (!req.user?.id) {
    return new Set<string>();
  }

  try {
    const service = getRbacService(req);
    const permissions = await service.getUserEffectivePermissions(req.user.id);
    return new Set(permissions.map((permission) => permission.permissionKey));
  } catch {
    return new Set<string>();
  }
}

// Internal validation for legacy format compatibility
const SaleItemSchema = z.object({
  productId: z.string().min(1), // Accept UUID or custom IDs for quotation conversion
  productName: z.string().min(1),
  quantity: z.number().positive(),
  unitPrice: z.number().nonnegative(),
});

const CreateSaleSchema = z
  .object({
    customerId: z.string().uuid().optional().nullable(),
    customerName: z.string().optional().nullable(),
    items: z.array(SaleItemSchema).min(1),
    paymentMethod: z.enum(['CASH', 'CARD', 'MOBILE_MONEY', 'AIRTEL_MONEY', 'CREDIT', 'GIFT']),
    paymentReceived: z.number().nonnegative(),
    // soldBy intentionally omitted — always forced from req.user.id (SECURITY LAW)
  })
  .strict();

const ListSalesQuerySchema = z.object({
  page: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val) : 1)),
  limit: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val) : 50)),
  status: z.enum(['COMPLETED', 'CANCELLED', 'REFUNDED', 'VOID', 'PARTIALLY_RETURNED', 'VOIDED_BY_RETURN']).optional(),
  customerId: z.string().uuid().optional(),
  cashierId: z.string().uuid().optional(),
  paymentMethod: z.enum(['CASH', 'CARD', 'MOBILE_MONEY', 'AIRTEL_MONEY', 'CREDIT', 'GIFT']).optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  search: z.string().optional(),
  ...EnterpriseListQueryFields,
});

const UuidParamSchema = z.object({
  id: z.string().uuid(),
});

const SalesSummaryQuerySchema = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  groupBy: z.string().optional(),
});

const ProductSalesSummaryQuerySchema = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  productId: z.string().uuid().optional(),
  customerId: z.string().uuid().optional(),
});

const TopSellingQuerySchema = z.object({
  limit: z.coerce.number().positive().max(100).optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

const SalesByDateQuerySchema = z.object({
  groupBy: z.enum(['day', 'week', 'month']).optional().default('day'),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

const VoidSaleBodySchema = z.object({
  reason: z.string().min(1).trim(),
  approvedById: z.string().uuid().optional(),
  amountThreshold: z.number().positive().optional(),
  forceAdminVoid: z.boolean().optional().default(false),
});

const RefundSaleBodySchema = z.object({
  items: z.array(z.object({
    saleItemId: z.string().uuid(),
    quantity: z.number().finite('Quantity must be a finite number').positive(),
  })).min(1, 'At least one item is required for refund'),
  reason: z.string().min(1).trim(),
  approvedById: z.string().uuid().optional(),
  refundDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD format').optional(),
  refundType: z.enum(['REFUND', 'EXCHANGE']).optional().default('REFUND'),
});

const CompleteProductExchangeBodySchema = z.object({
  returnItems: z.array(z.object({
    saleItemId: z.string().uuid(),
    quantity: z.number().finite().positive(),
  })).min(1),
  reason: z.string().min(5).trim(),
  replacementItems: z.array(z.object({
    productId: z.string().uuid(),
    productName: z.string().optional(),
    quantity: z.number().finite().positive(),
    unitPrice: z.number().finite().nonnegative(),
  })).optional().default([]),
  residualAction: z.enum(['REFUND_ORIGINAL_TENDER', 'KEEP_VOUCHER']),
  topUpPaymentMethod: z.enum(['CASH', 'CARD', 'MOBILE_MONEY', 'AIRTEL_MONEY']).optional(),
  cashRegisterSessionId: z.string().uuid().optional(),
});

const SettleExchangeResidualBodySchema = z.object({
  residualAction: z.enum(['REFUND_ORIGINAL_TENDER', 'KEEP_VOUCHER']),
  cashRegisterSessionId: z.string().uuid().optional(),
});

export const salesController = {
  /**
   * Create a new sale
   * Accepts EITHER:
   * 1. New format (from POS frontend): { customerId?, lineItems[], subtotal, taxAmount, totalAmount, paymentMethod, amountTendered?, changeGiven? }
   * 2. Legacy format: { customerId?, items[], paymentMethod, paymentReceived, soldBy }
   */
  async createSale(req: Request, res: Response): Promise<void> {
    const pool = req.tenantPool || globalPool;
    let validatedData: z.infer<typeof POSSaleSchema> | z.infer<typeof CreateSaleSchema> | undefined;
    let serviceInput: CreateSaleInput & { customerName?: string | null };

    // Try new POS format first
    const posValidation = POSSaleSchema.safeParse(req.body);
    if (posValidation.success) {
      const posData = posValidation.data;

      // ── Idempotency check: return existing sale if key already used ──
      if (posData.idempotencyKey) {
        const existing = await pool.query(
          `SELECT id, sale_number FROM sales WHERE idempotency_key = $1`,
          [posData.idempotencyKey]
        );
        if (existing.rows.length > 0) {
          res.status(200).json({
            success: true,
            data: {
              sale: { id: existing.rows[0].id, saleNumber: existing.rows[0].sale_number },
              items: [],
              paymentLines: [],
              alreadySynced: true,
            },
            message: 'Sale already created (idempotent)',
          });
          return;
        }
      }

      // Convert POS format to service format
      serviceInput = {
        customerId: posData.customerId || null,
        quoteId: posData.quoteId || null, // Link to quotation for auto-conversion
        cashRegisterSessionId: posData.cashRegisterSessionId || undefined, // Link to cash register for drawer tracking
        customerName: null, // Will be fetched from DB if needed
        idempotencyKey: posData.idempotencyKey,
        items: posData.lineItems.map((item: z.infer<typeof POSSaleLineItemSchema>) => ({
          productId: item.productId,
          productName: item.productName,
          uom: item.uom,
          uomId: item.uomId, // Include UOM ID for tracking
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          discountAmount: item.discountAmount || 0, // Per-item discount
          isTaxable: item.isTaxable,
          taxRate: item.taxRate,
        })),
        subtotal: posData.subtotal,
        discountAmount: posData.discountAmount || 0,
        taxAmount: posData.taxAmount,
        totalAmount: posData.totalAmount,
        paymentMethod:
          posData.paymentMethod ||
          (posData.paymentLines && posData.paymentLines.length > 0
            ? posData.paymentLines.reduce(
              (primary, line) => (line.amount > primary.amount ? line : primary),
              posData.paymentLines[0]
            ).paymentMethod
            : 'CASH'), // Use highest-amount payment line as primary method
        paymentReceived: posData.amountTendered ?? posData.totalAmount,
        soldBy: req.user?.id || '00000000-0000-0000-0000-000000000000', // From auth middleware - null UUID for system
        saleDate: posData.saleDate || undefined, // Backdated sale date if provided
        paymentLines: posData.paymentLines || undefined, // Include payment lines for split payment
        exchangeRefundId: posData.exchangeRefundId || undefined,
        exchangeResidualAction: posData.exchangeResidualAction || undefined,
        taxOverride: posData.taxOverride,
        giftReason: posData.giftReason,
      };
    } else {
      // Log POS validation errors
      console.error(
        'POS Schema validation failed:',
        JSON.stringify(posValidation.error.errors, null, 2)
      );
      console.error('Request body:', JSON.stringify(req.body, null, 2));

      // Try legacy format
      const legacyValidation = CreateSaleSchema.safeParse(req.body);
      if (legacyValidation.success) {
        serviceInput = {
          ...legacyValidation.data,
          soldBy: req.user?.id || '00000000-0000-0000-0000-000000000000', // SECURITY LAW: force from JWT, not body
        };
      } else {
        // Both validations failed - return POS schema errors as they're more relevant
        console.error(
          'Legacy Schema validation also failed:',
          JSON.stringify(legacyValidation.error.errors, null, 2)
        );
        res.status(400).json({
          success: false,
          error: 'Validation failed',
          details: posValidation.error.errors,
        });
        return;
      }
    }

    let result;
    try {
      result = await salesService.createSale(
        pool,
        {
          ...serviceInput,
          auditContext: req.auditContext ?? {
            userId: req.user?.id || '00000000-0000-0000-0000-000000000000',
            userName: req.user?.fullName,
            userRole: req.user?.role,
            ipAddress: req.ip,
            userAgent: req.headers['user-agent'],
            sessionId: req.cookies?.sessionId || (req.headers['x-session-id'] as string),
            requestId: req.requestId,
          },
        },
        req.tenantId,
      );
    } catch (createErr: unknown) {
      // Handle concurrent duplicate: PG unique violation on idempotency_key
      const pgErr = createErr as { code?: string; constraint?: string };
      if (
        pgErr.code === '23505' &&
        String(pgErr.constraint || '').includes('idempotency_key') &&
        serviceInput.idempotencyKey
      ) {
        const dup = await pool.query(
          `SELECT id, sale_number FROM sales WHERE idempotency_key = $1`,
          [serviceInput.idempotencyKey]
        );
        if (dup.rows.length > 0) {
          res.status(200).json({
            success: true,
            data: {
              sale: { id: dup.rows[0].id, saleNumber: dup.rows[0].sale_number },
              items: [],
              paymentLines: [],
              alreadySynced: true,
            },
            message: 'Sale already created (idempotent)',
          });
          return;
        }
      }
      throw createErr; // Re-throw non-duplicate errors
    }

    // Log audit trail with context from request
    try {
      const auditContext = req.auditContext || {
        userId: req.user?.id || '00000000-0000-0000-0000-000000000000',
        userName: req.user?.fullName,
        userRole: req.user?.role,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      };

      // Import audit service dynamically
      const { logSaleCreated } = await import('../audit/auditService.js');
      await logSaleCreated(
        pool,
        result.sale.id,
        result.sale.saleNumber,
        {
          itemCount: result.items.length,
          totalAmount: result.sale.totalAmount,
          totalCost: result.sale.totalCost ?? 0,
          profit: result.sale.profit ?? 0,
          paymentMethod: result.sale.paymentMethod,
          customerId: result.sale.customerId,
        },
        auditContext
      );

      const permissionKeys = await getEffectivePermissionKeys(req);
      const normalizedCreateResult = normalizeResponse(result) as Record<string, unknown>;
      if (normalizedCreateResult.sale && typeof normalizedCreateResult.sale === 'object') {
        normalizedCreateResult.sale = sanitizeSaleFinancialFields(
          normalizedCreateResult.sale as Record<string, unknown>,
          permissionKeys,
          req.user?.role
        );
      }
      res.status(201).json({
        success: true,
        data: normalizedCreateResult,
        message: `Sale ${result.sale.saleNumber} created successfully`,
        warnings: result.warnings,
      });
    } catch (error: unknown) {
      if (error instanceof z.ZodError) {
        res.status(400).json({
          success: false,
          error: 'Validation failed',
          details: error.errors,
        });
        return;
      }

      console.error('Error creating sale:', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to create sale',
      });
    }
  },

  /**
   * Get sale by ID
   */
  async getSaleById(req: Request, res: Response): Promise<void> {
    const pool = req.tenantPool || globalPool;
    const { id } = UuidParamSchema.parse(req.params);
    const result = await salesService.getSaleById(pool, id);

    const permissionKeys = await getEffectivePermissionKeys(req);
    if (shouldRestrictSalesToOwnUser(permissionKeys, req.user?.role) && result.sale.soldBy !== req.user?.id) {
      res.status(403).json({ success: false, error: 'Forbidden' });
      return;
    }

    const normalizedGetById = normalizeResponse(result) as Record<string, unknown>;
    if (normalizedGetById.sale && typeof normalizedGetById.sale === 'object') {
      normalizedGetById.sale = sanitizeSaleFinancialFields(
        normalizedGetById.sale as Record<string, unknown>,
        permissionKeys,
        req.user?.role
      );
    }
    res.json({
      success: true,
      data: normalizedGetById,
    });
  },

  /**
   * List sales with pagination and filters
   * Users without sales.read are scoped to their own sales (permission policy).
   */
  async listSales(req: Request, res: Response): Promise<void> {
    const pool = req.tenantPool || globalPool;
    const query = ListSalesQuerySchema.parse(req.query);
    const permissionKeys = await getEffectivePermissionKeys(req);

    const effectiveCashierId = shouldRestrictSalesToOwnUser(permissionKeys, req.user?.role)
      ? req.user?.id
      : query.cashierId;

    const result = await salesService.listSales(pool, query.page, query.limit, {
      status: query.status,
      customerId: query.customerId,
      cashierId: effectiveCashierId,
      paymentMethod: query.paymentMethod,
      startDate: query.startDate,
      endDate: query.endDate,
      search: query.search,
      sortBy: query.sortBy,
      sortOrder: query.sortOrder,
      outstandingOnly: query.outstandingOnly,
      balanceGt: query.balanceGt,
    });

    res.json({
      success: true,
      data: result.sales.map((sale) =>
        sanitizeSaleFinancialFields(
          normalizeResponse(sale) as Record<string, unknown>,
          permissionKeys,
          req.user?.role
        )
      ),
      pagination: {
        page: query.page,
        limit: query.limit,
        total: result.total,
        totalPages: Math.ceil(result.total / query.limit),
      },
    });
  } /**
   * Get sales summary (totals, count, by payment method)
   */,
  async getSalesSummary(req: Request, res: Response): Promise<void> {
    const pool = req.tenantPool || globalPool;
    const { startDate, endDate, groupBy } = SalesSummaryQuerySchema.parse(req.query);
    const permissionKeys = await getEffectivePermissionKeys(req);

    const filters: { startDate?: string; endDate?: string; groupBy?: string; cashierId?: string } = {};
    if (startDate) filters.startDate = startDate;
    if (endDate) filters.endDate = endDate;
    if (groupBy) filters.groupBy = groupBy;
    if (shouldRestrictSalesToOwnUser(permissionKeys, req.user?.role)) filters.cashierId = req.user!.id;

    const result = await salesService.getSalesSummary(pool, filters);

    res.json({
      success: true,
      data: sanitizeSaleFinancialFields(result as Record<string, unknown>, permissionKeys, req.user?.role),
    });
  },

  /**
   * Get product sales summary report
   */
  async getProductSalesSummary(req: Request, res: Response): Promise<void> {
    const pool = req.tenantPool || globalPool;
    const { startDate, endDate, productId, customerId } = ProductSalesSummaryQuerySchema.parse(
      req.query
    );
    const permissionKeys = await getEffectivePermissionKeys(req);

    const filters: {
      startDate?: string;
      endDate?: string;
      productId?: string;
      customerId?: string;
      cashierId?: string;
    } = {};
    if (startDate) filters.startDate = startDate;
    if (endDate) filters.endDate = endDate;
    if (productId) filters.productId = productId;
    if (customerId) filters.customerId = customerId;
    if (shouldRestrictSalesToOwnUser(permissionKeys, req.user?.role)) filters.cashierId = req.user!.id;

    const result = await salesService.getProductSalesSummary(pool, filters);

    res.json({
      success: true,
      data: result,
      message: `Retrieved sales summary for ${result.length} product(s)`,
    });
  },

  /**
   * Get top selling products
   */
  async getTopSellingProducts(req: Request, res: Response): Promise<void> {
    const pool = req.tenantPool || globalPool;
    const query = TopSellingQuerySchema.parse(req.query);
    const permissionKeys = await getEffectivePermissionKeys(req);

    const filters: { startDate?: string; endDate?: string; cashierId?: string } = {};
    if (query.startDate) filters.startDate = query.startDate;
    if (query.endDate) filters.endDate = query.endDate;
    if (shouldRestrictSalesToOwnUser(permissionKeys, req.user?.role)) filters.cashierId = req.user!.id;

    const result = await salesService.getTopSellingProducts(pool, query.limit ?? 10, filters);

    res.json({
      success: true,
      data: result,
    });
  },

  /**
   * Get sales summary by date
   */
  async getSalesSummaryByDate(req: Request, res: Response): Promise<void> {
    const pool = req.tenantPool || globalPool;
    const { groupBy, startDate, endDate } = SalesByDateQuerySchema.parse(req.query);
    const permissionKeys = await getEffectivePermissionKeys(req);

    const filters: { startDate?: string; endDate?: string; cashierId?: string } = {};
    if (startDate) filters.startDate = startDate;
    if (endDate) filters.endDate = endDate;
    if (shouldRestrictSalesToOwnUser(permissionKeys, req.user?.role)) filters.cashierId = req.user!.id;

    const result = await salesService.getSalesSummaryByDate(pool, groupBy, filters);

    res.json({
      success: true,
      data: result,
    });
  },

  /**
   * Get sales grouped by cashier (server-side aggregation)
   */
  async getSalesByCashier(req: Request, res: Response): Promise<void> {
    const pool = req.tenantPool || globalPool;
    const { startDate, endDate } = SalesSummaryQuerySchema.parse(req.query);
    const permissionKeys = await getEffectivePermissionKeys(req);

    const filters: { startDate?: string; endDate?: string; userId?: string } = {};
    if (startDate) filters.startDate = startDate;
    if (endDate) filters.endDate = endDate;
    if (shouldRestrictSalesToOwnUser(permissionKeys, req.user?.role)) filters.userId = req.user!.id;

    const result = await salesService.getSalesByCashier(pool, filters);

    res.json({
      success: true,
      data: result,
    });
  },

  /**
   * Void a sale (requires manager approval for high-value sales)
   * POST /api/sales/:id/void
   * Body: { reason: string, approvedById?: string }
   */
  async voidSale(req: Request, res: Response): Promise<void> {
    const pool = req.tenantPool || globalPool;
    const { id } = UuidParamSchema.parse(req.params);
    const { reason, approvedById, amountThreshold, forceAdminVoid } = VoidSaleBodySchema.parse(req.body);

    const voidedById = req.user?.id;
    if (!voidedById) {
      res.status(401).json({
        success: false,
        error: 'User not authenticated',
      });
      return;
    }

    // Void the sale
    const result = await salesService.voidSale(
      pool,
      id,
      voidedById,
      reason,
      approvedById || undefined,
      amountThreshold || 1000000, // Default threshold: 1M UGX
      forceAdminVoid
    );

    // Log audit trail (failure here should not fail the void)
    try {
      const auditContext = req.auditContext || {
        userId: voidedById,
        userName: req.user?.fullName,
        userRole: req.user?.role,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      };

      const { logSaleVoided } = await import('../audit/auditService.js');
      await logSaleVoided(
        pool,
        id,
        String(result.sale.saleNumber || ''),
        reason.trim(),
        {
          totalAmount: result.totalAmount,
          itemsRestored: result.itemsRestored,
          voidedById,
          approvedById: approvedById || null,
        },
        auditContext
      );
    } catch (auditError: unknown) {
      console.error('Audit logging failed for void:', auditError);
    }

    res.json({
      success: true,
      data: normalizeResponse(result),
      message: `Sale ${result.sale.saleNumber} voided successfully`,
    });
  },

  /**
   * Refund a sale (partial or full)
   * POST /sales/:id/refund
   * Body: { items: [{ saleItemId, quantity }], reason, approvedById?, refundDate? }
   */
  async refundSale(req: Request, res: Response): Promise<void> {
    const pool = req.tenantPool || globalPool;
    const { id } = UuidParamSchema.parse(req.params);
    const body = RefundSaleBodySchema.parse(req.body);
    const userId = req.user?.id || '00000000-0000-0000-0000-000000000000';

    const refundType = body.refundType ?? 'REFUND';
    const permissionKeys = await getEffectivePermissionKeys(req);
    const permitted = canProcessRefundType(refundType, permissionKeys, req.user?.role);
    if (!permitted) {
      res.status(403).json({ success: false, error: 'Insufficient permissions', code: 'PERMISSION_DENIED' });
      return;
    }

    const input: RefundSaleInput = {
      items: body.items,
      reason: body.reason,
      approvedById: body.approvedById,
      refundDate: body.refundDate,
      refundType,
    };

    const result = await salesService.refundSale(pool, id, userId, input);

    // Audit trail
    try {
      const auditContext = req.auditContext || {
        userId,
        userName: req.user?.fullName,
        userRole: req.user?.role,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      };

      const { logSaleRefunded } = await import('../audit/auditService.js');
      await logSaleRefunded(
        pool,
        id,
        '', // sale number derived from refund
        result.refund.refundNumber,
        body.reason,
        {
          refundId: result.refund.id,
          refundNumber: result.refund.refundNumber,
          totalAmount: result.refund.totalAmount,
          totalCost: result.refund.totalCost,
          itemsRestored: result.itemsRestored,
          isFullRefund: result.isFullRefund,
        },
        auditContext
      );
    } catch (auditError: unknown) {
      // Audit failure should not fail the refund
      console.error('Audit logging failed for refund:', auditError);
    }

    res.status(201).json({
      success: true,
      data: normalizeResponse(result),
      message: `Refund ${result.refund.refundNumber} created successfully${result.isFullRefund ? ' (sale fully refunded)' : ''}`,
    });
  },

  /**
   * Guided product exchange (return → replace → residual settlement)
   * POST /sales/:id/exchange
   */
  async completeProductExchange(req: Request, res: Response): Promise<void> {
    const pool = req.tenantPool || globalPool;
    const { id } = UuidParamSchema.parse(req.params);
    const body = CompleteProductExchangeBodySchema.parse(req.body);
    const userId = req.user?.id || '00000000-0000-0000-0000-000000000000';

    const permissionKeys = await getEffectivePermissionKeys(req);
    const permitted = canProcessRefundType('EXCHANGE', permissionKeys, req.user?.role);
    if (!permitted) {
      res.status(403).json({ success: false, error: 'Insufficient permissions', code: 'PERMISSION_DENIED' });
      return;
    }

    const result = await salesService.completeProductExchange(pool, id, userId, {
      returnItems: body.returnItems,
      reason: body.reason,
      replacementItems: body.replacementItems,
      residualAction: body.residualAction,
      topUpPaymentMethod: body.topUpPaymentMethod,
      cashRegisterSessionId: body.cashRegisterSessionId,
      soldBy: userId,
    });

    res.status(201).json({
      success: true,
      data: normalizeResponse(result),
      message: result.replacementSale
        ? `Exchange completed — ${result.refund.refundNumber}`
        : result.voucherNumber
          ? `Exchange credit held as voucher ${result.voucherNumber}`
          : `Exchange residual paid out — ${result.refund.refundNumber}`,
    });
  },

  /**
   * Settle leftover exchange store credit
   * POST /sales/exchange-credits/:refundId/settle
   */
  async settleExchangeResidual(req: Request, res: Response): Promise<void> {
    const pool = req.tenantPool || globalPool;
    const refundId = z.string().uuid().parse(req.params.refundId);
    const body = SettleExchangeResidualBodySchema.parse(req.body);
    const userId = req.user?.id || '00000000-0000-0000-0000-000000000000';

    const permissionKeys = await getEffectivePermissionKeys(req);
    const permitted = canProcessRefundType('EXCHANGE', permissionKeys, req.user?.role)
      || canProcessRefundType('REFUND', permissionKeys, req.user?.role);
    if (!permitted) {
      res.status(403).json({ success: false, error: 'Insufficient permissions', code: 'PERMISSION_DENIED' });
      return;
    }

    const result = await salesService.settleExchangeResidual(pool, refundId, userId, {
      residualAction: body.residualAction,
      cashRegisterSessionId: body.cashRegisterSessionId,
    });

    res.json({
      success: true,
      data: result,
      message: result.paidOut > 0
        ? `Paid out ${result.paidOut}`
        : result.voucherNumber
          ? `Voucher remains open: ${result.voucherNumber}`
          : 'No residual remaining',
    });
  },

  /**
   * List open exchange store credits (control report)
   * GET /sales/exchange-credits/open
   */
  async listOpenExchangeCredits(req: Request, res: Response): Promise<void> {
    const pool = req.tenantPool || globalPool;
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const rows = await salesService.listOpenExchangeCredits(pool, limit);
    res.json({ success: true, data: rows });
  },

  /**
   * Get refunds for a sale
   * GET /sales/:id/refunds
   */
  async getRefundsBySaleId(req: Request, res: Response): Promise<void> {
    const pool = req.tenantPool || globalPool;
    const { id } = UuidParamSchema.parse(req.params);

    const { salesRepository } = await import('./salesRepository.js');
    const refunds = await salesRepository.getRefundsBySaleId(pool, id);

    res.json({
      success: true,
      data: refunds.map((r) => normalizeResponse(r)),
    });
  },

  /**
   * Reconcile daily summary rollup table against raw sales data.
   * GET /sales/summary/reconcile
   */
  async reconcileSummary(req: Request, res: Response): Promise<void> {
    const pool = req.tenantPool || globalPool;
    const { startDate, endDate } = req.query as { startDate?: string; endDate?: string };
    const result = await salesService.reconcileDailySummary(pool, startDate, endDate);
    res.json({ success: true, data: result });
  },

  /**
   * Rebuild daily summary rollup table from raw sales data.
   * POST /sales/summary/rebuild
   */
  async rebuildSummary(req: Request, res: Response): Promise<void> {
    const pool = req.tenantPool || globalPool;
    const rowCount = await salesService.rebuildDailySummary(pool);
    res.json({
      success: true,
      data: { rowsUpserted: rowCount },
      message: 'Daily summary rollup rebuilt from raw sales data',
    });
  },
};

// Routes
export const salesRoutes = Router();

// Create sale - requires sales.create permission
salesRoutes.post(
  '/',
  authenticate,
  requirePermission('sales.create'),
  asyncHandler(salesController.createSale)
);

// List and view sales - all authenticated users
salesRoutes.get('/', authenticate, asyncHandler(salesController.listSales));
salesRoutes.get('/summary', authenticate, asyncHandler(salesController.getSalesSummary));

// Daily summary rollup admin endpoints (SAP GLT0-equivalent)
salesRoutes.get(
  '/summary/reconcile',
  authenticate,
  requirePermission('reports.read'),
  asyncHandler(salesController.reconcileSummary)
);
salesRoutes.post(
  '/summary/rebuild',
  authenticate,
  requirePermission('settings.update'),
  asyncHandler(salesController.rebuildSummary)
);

// Tax restatement (omitted VAT) — manager/admin — must be before /:id
salesRoutes.post(
  '/tax-restatement/preview',
  authenticate,
  requirePermission('sales.tax_restatement'),
  asyncHandler(async (req: Request, res: Response) => {
    const body = (
      await import('../../../../shared/zod/saleTaxRestatement.js')
    ).SaleTaxRestatementBodySchema.safeParse(req.body);
    if (!body.success) {
      const { ValidationError } = await import('../../middleware/errorHandler.js');
      throw new ValidationError(
        body.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '),
      );
    }
    const { saleTaxRestatementService } = await import(
      '../corrections/saleTaxRestatementService.js'
    );
    const pool = req.tenantPool || globalPool;
    const data = await saleTaxRestatementService.preview(pool, body.data);
    res.json({ success: true, data });
  }),
);

salesRoutes.post(
  '/tax-restatement/execute',
  authenticate,
  requirePermission('sales.tax_restatement'),
  asyncHandler(async (req: Request, res: Response) => {
    const body = (
      await import('../../../../shared/zod/saleTaxRestatement.js')
    ).SaleTaxRestatementExecuteSchema.safeParse(req.body);
    if (!body.success) {
      const { ValidationError } = await import('../../middleware/errorHandler.js');
      throw new ValidationError(
        body.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '),
      );
    }
    if (!req.user?.id) {
      const { ValidationError } = await import('../../middleware/errorHandler.js');
      throw new ValidationError('User identity required');
    }
    const { saleTaxRestatementService } = await import(
      '../corrections/saleTaxRestatementService.js'
    );
    const pool = req.tenantPool || globalPool;
    const data = await saleTaxRestatementService.execute(pool, body.data, req.user.id);
    res.status(201).json({ success: true, data });
  }),
);

// Wrong-customer correction (manager/admin) — must be before /:id
salesRoutes.post(
  '/customer-reassignment/preview',
  authenticate,
  requirePermission('sales.reassign_customer'),
  asyncHandler(async (req: Request, res: Response) => {
    const body = (
      await import('../../../../shared/zod/saleCustomerReassignment.js')
    ).SaleCustomerReassignmentBodySchema.safeParse(req.body);
    if (!body.success) {
      const { ValidationError } = await import('../../middleware/errorHandler.js');
      throw new ValidationError(
        body.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '),
      );
    }
    const { saleCustomerReassignmentService } = await import(
      '../corrections/saleCustomerReassignmentService.js'
    );
    const pool = req.tenantPool || globalPool;
    const data = await saleCustomerReassignmentService.preview(pool, body.data);
    res.json({ success: true, data });
  }),
);

salesRoutes.post(
  '/customer-reassignment/execute',
  authenticate,
  requirePermission('sales.reassign_customer'),
  asyncHandler(async (req: Request, res: Response) => {
    const body = (
      await import('../../../../shared/zod/saleCustomerReassignment.js')
    ).SaleCustomerReassignmentExecuteSchema.safeParse(req.body);
    if (!body.success) {
      const { ValidationError } = await import('../../middleware/errorHandler.js');
      throw new ValidationError(
        body.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '),
      );
    }
    if (!req.user?.id) {
      const { ValidationError } = await import('../../middleware/errorHandler.js');
      throw new ValidationError('User identity required');
    }
    const { saleCustomerReassignmentService } = await import(
      '../corrections/saleCustomerReassignmentService.js'
    );
    const pool = req.tenantPool || globalPool;
    const data = await saleCustomerReassignmentService.execute(pool, body.data, req.user.id);
    res.status(201).json({ success: true, data });
  }),
);

// Open exchange store credits (control list) — must be before /:id
salesRoutes.get(
  '/exchange-credits/open',
  authenticate,
  requireAnyPermission(['sales.exchange', 'sales.refund', 'sales.read']),
  asyncHandler(salesController.listOpenExchangeCredits)
);

// Settle residual exchange credit — must be before /:id
salesRoutes.post(
  '/exchange-credits/:refundId/settle',
  authenticate,
  requireAnyPermission(['sales.exchange', 'sales.refund']),
  asyncHandler(salesController.settleExchangeResidual)
);

salesRoutes.get('/:id', authenticate, asyncHandler(salesController.getSaleById));

// Sales reports - all authenticated users
salesRoutes.get(
  '/reports/product-summary',
  authenticate,
  asyncHandler(salesController.getProductSalesSummary)
);
salesRoutes.get(
  '/reports/top-selling',
  authenticate,
  asyncHandler(salesController.getTopSellingProducts)
);
salesRoutes.get(
  '/reports/summary-by-date',
  authenticate,
  asyncHandler(salesController.getSalesSummaryByDate)
);
salesRoutes.get(
  '/reports/by-cashier',
  authenticate,
  asyncHandler(salesController.getSalesByCashier)
);

// Void sale - requires sales.void permission (with audit trail)
salesRoutes.post(
  '/:id/void',
  authenticate,
  requirePermission('sales.void'),
  asyncHandler(salesController.voidSale)
);

// Refund / exchange sale — permission checked in controller (refund vs exchange)
salesRoutes.post(
  '/:id/refund',
  authenticate,
  requireAnyPermission(['sales.refund', 'sales.exchange']),
  asyncHandler(salesController.refundSale)
);

// Guided product exchange (return + replacement + residual in one flow)
salesRoutes.post(
  '/:id/exchange',
  authenticate,
  requireAnyPermission(['sales.exchange', 'sales.refund']),
  asyncHandler(salesController.completeProductExchange)
);

// Get refunds for a sale - all authenticated users
salesRoutes.get(
  '/:id/refunds',
  authenticate,
  asyncHandler(salesController.getRefundsBySaleId)
);

// Reprint receipt - requires sales.reprint permission (with audit trail)
salesRoutes.post(
  '/:id/reprint',
  authenticate,
  requirePermission('sales.reprint'),
  asyncHandler(async (req: Request, res: Response) => {
    const pool = req.tenantPool || globalPool;
    const { id } = UuidParamSchema.parse(req.params);

    // Get the sale to verify it exists and get its sale number
    const { salesRepository } = await import('./salesRepository.js');
    const saleData = await salesRepository.getSaleById(pool, id);
    if (!saleData) {
      res.status(404).json({ success: false, error: 'Sale not found' });
      return;
    }

    const saleNumber = saleData.sale.saleNumber || (saleData.sale as unknown as Record<string, unknown>).sale_number as string;

    // Increment print_count (self-heal if schema drift left the column off)
    let printCount = 1;
    try {
      const result = await pool.query(
        'UPDATE sales SET print_count = COALESCE(print_count, 0) + 1 WHERE id = $1 RETURNING print_count',
        [id],
      );
      printCount = Number(result.rows[0]?.print_count ?? 1);
    } catch (err: unknown) {
      const pgCode =
        err && typeof err === 'object' && 'code' in err
          ? String((err as { code?: string }).code)
          : '';
      // 42703 = undefined_column
      if (pgCode === '42703') {
        await pool.query(
          `ALTER TABLE sales ADD COLUMN IF NOT EXISTS print_count INTEGER NOT NULL DEFAULT 0`,
        );
        const result = await pool.query(
          'UPDATE sales SET print_count = COALESCE(print_count, 0) + 1 WHERE id = $1 RETURNING print_count',
          [id],
        );
        printCount = Number(result.rows[0]?.print_count ?? 1);
      } else {
        throw err;
      }
    }

    // Log to audit trail
    try {
      const auditContext = req.auditContext || {
        userId: req.user?.id || '00000000-0000-0000-0000-000000000000',
        userName: req.user?.fullName,
        userRole: req.user?.role,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      };

      const { logReceiptReprint } = await import('../audit/auditService.js');
      await logReceiptReprint(pool, id, saleNumber, printCount, auditContext);
    } catch (auditError: unknown) {
      console.error('Audit logging failed for receipt reprint:', auditError);
    }

    res.json({
      success: true,
      data: { printCount, isReprint: printCount > 1 },
      message: printCount > 1
        ? `Receipt reprinted (print #${printCount})`
        : 'Receipt printed',
    });
  })
);
