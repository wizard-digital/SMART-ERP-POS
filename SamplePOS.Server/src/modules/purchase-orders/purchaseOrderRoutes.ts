import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { pool as globalPool } from '../../db/pool.js';
import { purchaseOrderService } from './purchaseOrderService.js';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../rbac/middleware.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { EnterpriseListQueryFields } from '../../../../shared/zod/enterpriseListQuery.js';
import * as supplierProductPriceRepository from '../suppliers/supplierProductPriceRepository.js';

/** Coerce empty/ISO date strings to YYYY-MM-DD or null for PO date fields. */
const optionalDateOnly = () =>
  z.preprocess(
    (val) => {
      if (val === '' || val === undefined || val === null) return null;
      if (typeof val === 'string') {
        const trimmed = val.trim();
        if (!trimmed) return null;
        if (trimmed.includes('T')) return trimmed.slice(0, 10);
        return trimmed;
      }
      return val;
    },
    z
      .union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'), z.null()])
      .optional()
  );

const requiredDateOnly = () =>
  z.preprocess(
    (val) => {
      if (typeof val === 'string' && val.includes('T')) return val.slice(0, 10);
      return val;
    },
    z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD')
  );

// Validation schemas
const POItemSchema = z.object({
  productId: z.string().uuid(),
  productName: z.string().min(1),
  quantity: z.number().positive(),
  unitCost: z.number().nonnegative(),
  lineTotal: z.number().nonnegative().optional(),
  uomId: z.string().uuid().optional().nullable(),
});

const CreatePOSchema = z
  .object({
    supplierId: z.string().uuid(),
    orderDate: requiredDateOnly(),
    expectedDate: optionalDateOnly(),
    notes: z.string().optional().nullable(),
    createdBy: z.string().uuid().optional(), // Optional - will use req.user if not provided
    items: z.array(POItemSchema).min(1, 'Purchase order must have at least one item'),
  })
  .strict();

const UpdatePOStatusSchema = z
  .object({
    status: z.enum(['DRAFT', 'PENDING', 'COMPLETED', 'CANCELLED']),
  })
  .strict();

const UpdateDraftPOSchema = z.object({
  supplierId: z.string().uuid().optional(),
  expectedDate: optionalDateOnly(),
  notes: z.string().optional().nullable(),
  items: z.array(POItemSchema).min(1, 'Purchase order must have at least one item').optional(),
}).strict();

const ListPOsQuerySchema = z.object({
  page: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val) : 1)),
  limit: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val) : 50)),
  status: z.enum(['DRAFT', 'PENDING', 'COMPLETED', 'CANCELLED']).optional(),
  supplierId: z.string().uuid().optional(),
  search: z.string().optional(),
  ...EnterpriseListQueryFields,
});

const UuidParamSchema = z.object({
  id: z.string().uuid(),
});

const CreateInvoiceSchema = z.object({
  purchaseOrderId: z.string().uuid(),
  goodsReceiptId: z.string().uuid(),
  invoiceNumber: z.string().min(1),
  invoiceDate: z.string(),
  dueDate: z.string(),
  supplierId: z.string().uuid(),
  totalAmount: z.coerce.number().nonnegative(),
  paymentTerms: z.string().optional(),
  notes: z.string().optional(),
});

const RecordPaymentSchema = z.object({
  invoiceId: z.string().uuid(),
  supplierId: z.string().uuid(),
  amount: z.coerce.number().positive(),
  paymentMethod: z.string().min(1),
  paymentDate: z.string(),
  referenceNumber: z.string().optional(),
  notes: z.string().optional(),
});

export const purchaseOrderController = {
  /**
   * Create purchase order
   */
  async createPO(req: Request, res: Response): Promise<void> {
    const pool = req.tenantPool || globalPool;
    const validatedData = CreatePOSchema.parse(req.body);

    // Use authenticated user's ID if createdBy not provided
    const createdBy = validatedData.createdBy || req.user?.id;
    if (!createdBy) {
      res.status(400).json({
        success: false,
        error: 'User ID is required. Please provide createdBy or ensure you are authenticated.',
      });
      return;
    }

    const result = await purchaseOrderService.createPO(pool, {
      ...validatedData,
      createdBy,
    });

    // Log audit trail
    try {
      const auditContext = req.auditContext || {
        userId: req.user?.id || createdBy,
        userName: req.user?.fullName,
        userRole: req.user?.role,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      };

      const { logPurchaseOrderCreated } = await import('../audit/auditService.js');
      await logPurchaseOrderCreated(
        pool,
        result.po.id,
        result.po.poNumber,
        {
          itemCount: result.items?.length || 0,
          totalAmount: result.po.totalAmount,
          supplierId: result.po.supplierId,
          status: result.po.status,
        },
        auditContext
      );

      res.status(201).json({
        success: true,
        data: result,
        message: `Purchase order ${result.po.poNumber} created successfully`,
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

      console.error('Error creating purchase order:', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to create purchase order',
      });
    }
  },

  /**
   * Get PO by ID
   */
  async getPOById(req: Request, res: Response): Promise<void> {
    const pool = req.tenantPool || globalPool;
    const { id } = UuidParamSchema.parse(req.params);
    const result = await purchaseOrderService.getPOById(pool, id);

    res.json({
      success: true,
      data: result,
    });
  },

  /**
   * List purchase orders
   */
  async listPOs(req: Request, res: Response): Promise<void> {
    const pool = req.tenantPool || globalPool;
    const query = ListPOsQuerySchema.parse(req.query);
    const result = await purchaseOrderService.listPOs(pool, query.page, query.limit, {
      status: query.status,
      supplierId: query.supplierId,
      search: query.search,
      sortBy: query.sortBy,
      sortOrder: query.sortOrder,
    });

    res.json({
      success: true,
      data: result.pos,
      pagination: {
        page: query.page,
        limit: query.limit,
        total: result.total,
        totalPages: Math.ceil(result.total / query.limit),
      },
    });
  },

  /**
   * Update PO status
   */
  async updatePOStatus(req: Request, res: Response): Promise<void> {
    const pool = req.tenantPool || globalPool;
    const { id } = UuidParamSchema.parse(req.params);
    const { status } = UpdatePOStatusSchema.parse(req.body);

    // Get current status before update for audit
    const currentPO = await purchaseOrderService.getPOById(pool, id);
    const oldStatus = currentPO?.po?.status;

    const result = await purchaseOrderService.updatePOStatus(pool, id, status);

    // Log audit trail for status change
    try {
      const auditContext = req.auditContext || {
        userId: req.user?.id || '00000000-0000-0000-0000-000000000000',
        userName: req.user?.fullName,
        userRole: req.user?.role,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      };

      const { logPurchaseOrderStatusChanged } = await import('../audit/auditService.js');
      await logPurchaseOrderStatusChanged(
        pool,
        id,
        result.poNumber,
        oldStatus || 'UNKNOWN',
        status,
        auditContext
      );

      res.json({
        success: true,
        data: result,
        message: `Purchase order status updated to ${status}`,
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

      console.error('Error updating purchase order status:', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update purchase order status',
      });
    }
  },

  /**
   * Submit purchase order (DRAFT -> PENDING)
   */
  async submitPO(req: Request, res: Response): Promise<void> {
    const pool = req.tenantPool || globalPool;
    const { id } = UuidParamSchema.parse(req.params);
    const result = await purchaseOrderService.submitPO(pool, id, req.user?.id);

    res.json({
      success: true,
      data: result,
      message: 'Purchase order submitted successfully',
    });
  },

  /**
   * Cancel purchase order
   */
  async cancelPO(req: Request, res: Response): Promise<void> {
    const pool = req.tenantPool || globalPool;
    const { id } = UuidParamSchema.parse(req.params);
    const result = await purchaseOrderService.cancelPO(pool, id, req.user?.id);

    res.json({
      success: true,
      data: result,
      message:
        'Purchase order cancelled. Any linked draft goods receipts were cancelled and will no longer appear for receiving.',
    });
  },

  /**
   * Delete purchase order
   */
  async deletePO(req: Request, res: Response): Promise<void> {
    const pool = req.tenantPool || globalPool;
    const { id } = UuidParamSchema.parse(req.params);
    await purchaseOrderService.deletePO(pool, id);

    res.json({
      success: true,
      message: 'Purchase order deleted successfully',
    });
  },

  /**
   * Permanently delete a CANCELLED purchase order
   */
  async purgeCancelledPO(req: Request, res: Response): Promise<void> {
    const pool = req.tenantPool || globalPool;
    const { id } = UuidParamSchema.parse(req.params);
    await purchaseOrderService.purgeCancelledPO(pool, id);

    res.json({
      success: true,
      message: 'Cancelled purchase order permanently deleted',
    });
  },

  /**
   * Update draft purchase order (SAP ME22N pattern)
   */
  async updateDraftPO(req: Request, res: Response): Promise<void> {
    const pool = req.tenantPool || globalPool;
    const { id } = UuidParamSchema.parse(req.params);
    const validatedData = UpdateDraftPOSchema.parse(req.body);

    const result = await purchaseOrderService.updateDraftPO(pool, id, validatedData);

    res.json({
      success: true,
      data: result,
      message: 'Purchase order updated successfully',
    });
  },

  /**
   * Send PO to supplier (auto-creates goods receipt draft)
   */
  async sendPOToSupplier(req: Request, res: Response): Promise<void> {
    const pool = req.tenantPool || globalPool;
    const { id } = UuidParamSchema.parse(req.params);
    const userId = req.user!.id;

    const result = await purchaseOrderService.sendPOToSupplier(pool, id, userId);

    res.json({
      success: true,
      data: result,
      message: 'Purchase order sent to supplier. Goods receipt draft created for receiving.',
    });
  },

  /**
   * Create supplier invoice
   */
  async createInvoice(req: Request, res: Response): Promise<void> {
    const pool = req.tenantPool || globalPool;
    const data = CreateInvoiceSchema.parse(req.body);
    const userId = req.user!.id;

    const invoice = await purchaseOrderService.createSupplierInvoice(pool, {
      purchaseOrderId: data.purchaseOrderId,
      goodsReceiptId: data.goodsReceiptId,
      invoiceNumber: data.invoiceNumber,
      invoiceDate: new Date(data.invoiceDate),
      dueDate: new Date(data.dueDate),
      supplierId: data.supplierId,
      totalAmount: data.totalAmount,
      paymentTerms: data.paymentTerms,
      notes: data.notes,
      createdBy: userId,
    });

    res.status(201).json({
      success: true,
      data: invoice,
      message: 'Supplier invoice created via canonical GRN billing path',
      deprecated: 'Use POST /supplier-payments/invoices/from-grn',
    });
  },

  /**
   * Get items for a specific PO (lightweight endpoint for inline display)
   */
  async getPOItems(req: Request, res: Response): Promise<void> {
    const pool = req.tenantPool || globalPool;
    const { id } = UuidParamSchema.parse(req.params);
    const result = await purchaseOrderService.getPOById(pool, id);

    if (!result) {
      res.status(404).json({ success: false, error: 'Purchase order not found' });
      return;
    }

    // Net received (purchase UoM) is the operational SSOT for supplier/PO displays.
    // Gross received is immutable receipt history; returns reduce net, not gross.
    const items = result.items.map((row) => ({
      id: row.id,
      productId: row.productId,
      productName: row.productName,
      orderedQuantity: row.quantity,
      receivedQuantity: row.netReceivedQuantity ?? row.receivedQuantity ?? 0,
      grossReceivedQuantity: row.receivedQuantity ?? 0,
      returnedQuantity: row.returnedQuantity ?? 0,
      netReceivedQuantity: row.netReceivedQuantity ?? row.receivedQuantity ?? 0,
      openQuantity: row.openQuantity ?? 0,
      unitPrice: row.unitCost,
      lineTotal: row.lineTotal,
      uomName: row.uomName ?? null,
    }));

    res.json({ success: true, data: items });
  },

  /**
   * Record payment
   */
  async recordPayment(req: Request, res: Response): Promise<void> {
    const pool = req.tenantPool || globalPool;
    const data = RecordPaymentSchema.parse(req.body);
    const userId = req.user!.id;

    const payment = await purchaseOrderService.recordPayment(pool, {
      invoiceId: data.invoiceId,
      supplierId: data.supplierId,
      amount: data.amount,
      paymentMethod: data.paymentMethod,
      paymentDate: new Date(data.paymentDate),
      referenceNumber: data.referenceNumber,
      notes: data.notes,
      createdBy: userId,
    });

    res.status(201).json({
      success: true,
      data: payment,
      message: 'Payment recorded successfully',
    });
  },
};

// ── Resolve Unit Cost ─────────────────────────────────────────────────

const ResolveUnitCostSchema = z.object({
  productId: z.string().uuid(),
  supplierId: z.string().uuid(),
});

/**
 * GET /purchase-orders/resolve-unit-cost?productId=&supplierId=
 * Priority: supplier_product_prices → product_valuation.last_cost → cost_price
 */
async function resolveUnitCost(req: Request, res: Response): Promise<void> {
  const pool = req.tenantPool || globalPool;
  const { productId, supplierId } = ResolveUnitCostSchema.parse(req.query);

  // 1. Try supplier-specific price
  const supplierPrices = await supplierProductPriceRepository.getSupplierPricesForProduct(productId, pool);
  const forThisSupplier = supplierPrices.find((sp) => sp.supplierId === supplierId);
  if (forThisSupplier && Number(forThisSupplier.lastPurchasePrice) > 0) {
    res.json({
      success: true,
      data: {
        unitCost: Number(forThisSupplier.lastPurchasePrice),
        source: 'supplier_history',
        supplierName: (forThisSupplier as unknown as Record<string, unknown>).supplierName || null,
        purchaseCount: forThisSupplier.purchaseCount,
      },
    });
    return;
  }

  // 2. Try product_valuation.last_cost → cost_price
  const valResult = await pool.query(
    `SELECT COALESCE(last_cost, 0) AS "lastCost", COALESCE(cost_price, 0) AS "costPrice"
     FROM product_valuation WHERE product_id = $1`,
    [productId]
  );

  if (valResult.rows.length > 0) {
    const { lastCost, costPrice } = valResult.rows[0];
    const last = Number(lastCost);
    const cost = Number(costPrice);

    if (last > 0) {
      res.json({ success: true, data: { unitCost: last, source: 'last_purchase' } });
      return;
    }
    if (cost > 0) {
      res.json({ success: true, data: { unitCost: cost, source: 'cost_price' } });
      return;
    }
  }

  // 3. Fallback
  res.json({ success: true, data: { unitCost: 0, source: 'none' } });
}

// Routes
export const purchaseOrderRoutes = Router();

// View routes - all authenticated users
purchaseOrderRoutes.get('/', authenticate, asyncHandler(purchaseOrderController.listPOs));

// Resolve unit cost — must be before /:id
purchaseOrderRoutes.get('/resolve-unit-cost', authenticate, asyncHandler(resolveUnitCost));

purchaseOrderRoutes.get('/:id', authenticate, asyncHandler(purchaseOrderController.getPOById));
purchaseOrderRoutes.get('/:id/items', authenticate, asyncHandler(purchaseOrderController.getPOItems));

// Create/modify routes - requires purchasing permissions
purchaseOrderRoutes.post(
  '/',
  authenticate,
  requirePermission('purchasing.create'),
  asyncHandler(purchaseOrderController.createPO)
);
purchaseOrderRoutes.put(
  '/:id/status',
  authenticate,
  requirePermission('purchasing.update'),
  asyncHandler(purchaseOrderController.updatePOStatus)
);
purchaseOrderRoutes.put(
  '/:id',
  authenticate,
  requirePermission('purchasing.update'),
  asyncHandler(purchaseOrderController.updateDraftPO)
);
purchaseOrderRoutes.post(
  '/:id/submit',
  authenticate,
  requirePermission('purchasing.approve'),
  asyncHandler(purchaseOrderController.submitPO)
);
purchaseOrderRoutes.post(
  '/:id/send-to-supplier',
  authenticate,
  requirePermission('purchasing.approve'),
  asyncHandler(purchaseOrderController.sendPOToSupplier)
);
purchaseOrderRoutes.post(
  '/:id/cancel',
  authenticate,
  requirePermission('purchasing.update'),
  asyncHandler(purchaseOrderController.cancelPO)
);
purchaseOrderRoutes.delete(
  '/:id',
  authenticate,
  requirePermission('purchasing.delete'),
  asyncHandler(purchaseOrderController.deletePO)
);
purchaseOrderRoutes.delete(
  '/:id/purge',
  authenticate,
  requirePermission('purchasing.delete'),
  asyncHandler(purchaseOrderController.purgeCancelledPO)
);

// Invoice and payment routes
purchaseOrderRoutes.post(
  '/invoices',
  authenticate,
  requirePermission('purchasing.create'),
  asyncHandler(purchaseOrderController.createInvoice)
);
purchaseOrderRoutes.post(
  '/payments',
  authenticate,
  requirePermission('purchasing.create'),
  asyncHandler(purchaseOrderController.recordPayment)
);
