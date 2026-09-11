import { Request, Response, Router } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { pool as globalPool } from '../../db/pool.js';
import { inventoryService } from './inventoryService.js';
import { inventoryRepository } from './inventoryRepository.js';
import { inventoryLedgerRepository } from './inventoryLedgerRepository.js';
import { validateExpiryEdit } from './batchExpiryGovernanceService.js';
import { correctLotExpiry } from '../inventory-lot/lotService.js';
import { UnitOfWork } from '../../db/unitOfWork.js';
import { authenticate } from '../../middleware/auth.js';
import { requireAnyPermission, requirePermission } from '../../rbac/middleware.js';
import { stockCountRoutes } from './stockCountRoutes.js';
import { storeTransferRoutes } from './warehouse/storeTransferRoutes.js';
import { expiryAutomationRoutes } from './warehouse/expiryAutomationRoutes.js';
import { warehouseReportingRoutes } from './warehouse/warehouseReportingRoutes.js';
import { lossQuarantineRoutes } from '../loss-quarantine/lossQuarantineRoutes.js';
import { lotWriteDownRoutes } from '../inventory-lot/lotWriteDownRoutes.js';
import { storeLocationRoutes } from './warehouse/storeLocationRoutes.js';
import { productStoreDistributionService } from './warehouse/productStoreDistributionService.js';
import { productDistributionService } from './warehouse/productDistributionService.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { BatchAdjustmentSchema } from '../../../../shared/zod/inventory.js';
import { INVENTORY_STOCK_ADJUST_PERMISSIONS } from '../../../../shared/authorization/inventoryAdjustPermissions.js';

const UpdateProductDistributionPolicySchema = z.object({
  distributionPolicy: z.enum(['GLOBAL', 'RESTRICTED']),
  assignments: z
    .array(
      z.object({
        storeLocationId: z.string().uuid(),
        isAssigned: z.boolean().optional(),
        isPosVisible: z.boolean().optional(),
      }),
    )
    .default([]),
});

const StoreLotSearchQuerySchema = z.object({
  storeLocationId: z.string().uuid(),
  q: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

const StoreProductSearchQuerySchema = z.object({
  storeLocationId: z.string().uuid(),
  q: z.string().min(2),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

const StoreProductLotsQuerySchema = z.object({
  storeLocationId: z.string().uuid(),
});

const AssortmentMatrixQuerySchema = z.object({
  search: z.string().optional(),
  category: z.string().optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
});

const UpdateAssortmentMatrixCellSchema = z.object({
  productId: z.string().uuid(),
  storeLocationId: z.string().uuid(),
  status: z.enum(['ACTIVE', 'HIDDEN', 'UNASSIGNED']),
});

// Validation schemas
const AdjustInventorySchema = z
  .object({
    productId: z.string().uuid('Invalid product ID'),
    adjustment: z
      .number()
      .refine((val) => val !== 0, {
        message: 'Adjustment cannot be zero',
      }),
    reason: z.string().min(5, 'Reason must be at least 5 characters'),
    userId: z.string().uuid('Invalid user ID'),
  })
  .strict();

const GetBatchesQuerySchema = z.object({
  productId: z.string().uuid(),
});

const ExpiryQuerySchema = z.object({
  daysThreshold: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val) : 30)),
});

const PosProductSearchQuerySchema = z.object({
  q: z.string().min(1, 'Search query is required'),
  limit: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : 50)),
});

const PosLockAllocationSchema = z.object({
  productId: z.string().uuid(),
  quantity: z.number().positive(),
});

export const inventoryController = {
  /**
   * Get all batches for a product
   */
  /**
   * Get all active batches (for offline sync / pre-warm)
   */
  async getAllActiveBatches(req: Request, res: Response): Promise<void> {
    const pool = req.tenantPool || globalPool;
    const batches = await inventoryService.getAllActiveBatches(pool);
    res.json({ success: true, data: batches });
  },

  async getBatchesByProduct(req: Request, res: Response): Promise<void> {
    const pool = req.tenantPool || globalPool;
    const { productId } = GetBatchesQuerySchema.parse(req.query);
    const batches = await inventoryService.getBatchesByProduct(pool, productId);

    res.json({
      success: true,
      data: batches,
    });
  },

  /**
   * Get batches expiring soon
   */
  async getBatchesExpiringSoon(req: Request, res: Response): Promise<void> {
    const pool = req.tenantPool || globalPool;
    const { daysThreshold } = ExpiryQuerySchema.parse(req.query);
    const batches = await inventoryService.getBatchesExpiringSoon(pool, daysThreshold);

    res.json({
      success: true,
      data: batches,
      message: `Found ${batches.length} batches expiring within ${daysThreshold} days`,
    });
  },

  /**
   * Get stock levels for all products
   */
  async getStockLevels(req: Request, res: Response): Promise<void> {
    const pool = req.tenantPool || globalPool;
    const storeLocationId =
      typeof req.query.storeLocationId === 'string' ? req.query.storeLocationId : undefined;
    const stockLevels = await inventoryService.getStockLevels(pool, storeLocationId);

    res.json({
      success: true,
      data: stockLevels,
      meta: storeLocationId ? { storeLocationId } : undefined,
    });
  },

  async getProductStoreDistribution(req: Request, res: Response): Promise<void> {
    const pool = req.tenantPool || globalPool;
    const rows = await productStoreDistributionService.getDistribution(pool, req.params.productId);
    res.json({ success: true, data: rows });
  },

  async getProductDistributionPolicy(req: Request, res: Response): Promise<void> {
    const pool = req.tenantPool || globalPool;
    const policy = await productDistributionService.getPolicy(pool, req.params.productId);
    if (!policy) {
      res.status(404).json({ success: false, error: 'Product not found or multistore disabled' });
      return;
    }
    res.json({ success: true, data: policy });
  },

  async updateProductDistributionPolicy(req: Request, res: Response): Promise<void> {
    const pool = req.tenantPool || globalPool;
    const body = UpdateProductDistributionPolicySchema.parse(req.body);
    const updated = await UnitOfWork.run(pool, async (client) =>
      productDistributionService.updatePolicy(client, req.params.productId, body),
    );
    res.json({ success: true, data: updated });
  },

  async getStoreLots(req: Request, res: Response): Promise<void> {
    const pool = req.tenantPool || globalPool;
    const storeLocationId = String(req.query.storeLocationId ?? '');
    if (!storeLocationId) {
      res.status(400).json({ success: false, error: 'storeLocationId is required' });
      return;
    }
    const rows = await productStoreDistributionService.listLotsAtStore(pool, storeLocationId);
    res.json({ success: true, data: rows });
  },

  async searchStoreLots(req: Request, res: Response): Promise<void> {
    const pool = req.tenantPool || globalPool;
    const parsed = StoreLotSearchQuerySchema.parse(req.query);
    const rows = await productStoreDistributionService.searchLotsAtStore(
      pool,
      parsed.storeLocationId,
      parsed.q,
      parsed.limit,
    );
    res.json({ success: true, data: rows, meta: { count: rows.length } });
  },

  async searchStoreProducts(req: Request, res: Response): Promise<void> {
    const pool = req.tenantPool || globalPool;
    const parsed = StoreProductSearchQuerySchema.parse(req.query);
    const rows = await productStoreDistributionService.searchProductsAtStore(
      pool,
      parsed.storeLocationId,
      parsed.q,
      parsed.limit,
    );
    res.json({ success: true, data: rows, meta: { count: rows.length } });
  },

  async getStoreProductLots(req: Request, res: Response): Promise<void> {
    const pool = req.tenantPool || globalPool;
    const productId = z.string().uuid().parse(req.params.productId);
    const parsed = StoreProductLotsQuerySchema.parse(req.query);
    const rows = await productStoreDistributionService.listLotsForProductAtStore(
      pool,
      parsed.storeLocationId,
      productId,
    );
    res.json({ success: true, data: rows, meta: { count: rows.length } });
  },

  async getAssortmentMatrix(req: Request, res: Response): Promise<void> {
    const pool = req.tenantPool || globalPool;
    const parsed = AssortmentMatrixQuerySchema.parse(req.query);
    const matrix = await productDistributionService.getAssortmentMatrix(pool, parsed);
    res.json({ success: true, data: matrix });
  },

  async updateAssortmentMatrixCell(req: Request, res: Response): Promise<void> {
    const pool = req.tenantPool || globalPool;
    const body = UpdateAssortmentMatrixCellSchema.parse(req.body);
    await UnitOfWork.run(pool, async (client) => {
      await productDistributionService.updateMatrixCell(client, body);
    });
    res.json({ success: true, message: 'Assortment updated' });
  },

  /**
   * POS catalog sync — sellable stock only (zero-qty and expired omitted).
   */
  async getPosCatalog(req: Request, res: Response): Promise<void> {
    const pool = req.tenantPool || globalPool;
    const catalog = await inventoryService.getPosCatalog(pool);
    res.json({ success: true, data: catalog });
  },

  /**
   * POS product search — store-isolated when multistore; empty array = no results.
   */
  async searchPosProducts(req: Request, res: Response): Promise<void> {
    const pool = req.tenantPool || globalPool;
    const { q, limit } = PosProductSearchQuerySchema.parse(req.query);
    const { storeLocationId, results } = await inventoryService.searchPosProducts(pool, q, limit);

    res.json({
      success: true,
      data: results,
      meta: { storeLocationId, count: results.length },
      message: results.length === 0 ? 'No results found' : undefined,
    });
  },

  /**
   * POS allocation lock — FEFO row locks inside a transaction (race-safe preview).
   */
  async lockPosAllocation(req: Request, res: Response): Promise<void> {
    const pool = req.tenantPool || globalPool;
    const body = PosLockAllocationSchema.parse(req.body);
    const allocation = await inventoryService.lockPosAllocation(
      pool,
      body.productId,
      body.quantity,
    );

    res.json({ success: true, data: allocation });
  },

  /**
   * Stock visibility — Phase 6 dimensions (store-scoped when multistore).
   */
  async getStockVisibility(req: Request, res: Response): Promise<void> {
    const pool = req.tenantPool || globalPool;
    const visibility = await inventoryService.getStockVisibility(pool);
    res.json({ success: true, data: visibility });
  },

  /**
   * Get stock level for specific product
   */
  async getStockLevelByProduct(req: Request, res: Response): Promise<void> {
    const pool = req.tenantPool || globalPool;
    const { productId } = req.params;
    const stockLevel = await inventoryService.getStockLevelByProduct(pool, productId);

    res.json({
      success: true,
      data: stockLevel,
    });
  },

  /**
   * Get products needing reorder
   */
  async getProductsNeedingReorder(req: Request, res: Response): Promise<void> {
    const pool = req.tenantPool || globalPool;
    const products = await inventoryService.getProductsNeedingReorder(pool);

    res.json({
      success: true,
      data: products,
      message: `${products.length} products need reordering`,
    });
  },

  /**
   * Adjust inventory quantity
   */
  async adjustInventory(req: Request, res: Response): Promise<void> {
    const pool = req.tenantPool || globalPool;
    const validatedData = AdjustInventorySchema.parse(req.body);
    const result = await inventoryService.adjustInventory(
      pool,
      validatedData.productId,
      validatedData.adjustment,
      validatedData.reason,
      validatedData.userId
    );

    res.json({
      success: true,
      data: result,
      message: 'Inventory adjusted successfully',
    });
  },

  /**
   * Enterprise-grade batch adjustment
   * Accepts explicit direction + reason — no sign inference, no negative quantities.
   * Creates an inventory_adjustment_document as the audit header.
   */
  async adjustBatch(req: Request, res: Response): Promise<void> {
    const pool = req.tenantPool || globalPool;
    const validated = BatchAdjustmentSchema.parse(req.body);
    const result = await inventoryService.adjustBatch(pool, {
      batchId: validated.batchId,         // optional — FEFO auto-select when absent
      productId: validated.productId,
      quantity: validated.quantity,
      direction: validated.direction,
      reason: validated.reason,
      notes: validated.notes,
      userId: validated.userId,
      documentId: validated.documentId,
      unitCost: validated.unitCost,        // optional — service auto-looks up product cost for ADJUSTMENT_IN
      storeLocationId: validated.storeLocationId,
      productLotId: validated.productLotId,
    });

    res.json({
      success: true,
      data: result,
      message: `${validated.reason} adjustment recorded (${validated.direction === 'IN' ? '+' : '-'}${validated.quantity})`,
    });
  },

  /**
   * Get inventory value
   */
  async getInventoryValue(req: Request, res: Response): Promise<void> {
    const pool = req.tenantPool || globalPool;
    const { productId } = req.query;
    const value = await inventoryService.getInventoryValue(pool, productId as string | undefined);

    res.json({
      success: true,
      data: value,
    });
  },

  /**
   * Check if batch number exists
   */
  async checkBatchExists(req: Request, res: Response): Promise<void> {
    const pool = req.tenantPool || globalPool;
    const { batchNumber } = req.query;

    if (!batchNumber || typeof batchNumber !== 'string') {
      res.status(400).json({
        success: false,
        error: 'Batch number is required',
      });
      return;
    }

    const result = await pool.query(
      'SELECT EXISTS(SELECT 1 FROM inventory_batches WHERE batch_number = $1)',
      [batchNumber]
    );

    res.json({
      success: true,
      exists: result.rows[0].exists,
    });
  },
};

// Routes
export const inventoryRoutes = Router();

// View routes - require inventory.read unless the endpoint is POS-specific
inventoryRoutes.get(
  '/batches-all',
  authenticate,
  requirePermission('inventory.read'),
  asyncHandler(inventoryController.getAllActiveBatches),
);
inventoryRoutes.get(
  '/batches',
  authenticate,
  requirePermission('inventory.read'),
  asyncHandler(inventoryController.getBatchesByProduct),
);
inventoryRoutes.get(
  '/batches/exists',
  authenticate,
  requirePermission('inventory.read'),
  asyncHandler(inventoryController.checkBatchExists),
);
inventoryRoutes.get(
  '/batches/expiring',
  authenticate,
  requirePermission('inventory.read'),
  asyncHandler(inventoryController.getBatchesExpiringSoon),
);
inventoryRoutes.get(
  '/stock-levels',
  authenticate,
  requirePermission('inventory.read'),
  asyncHandler(inventoryController.getStockLevels),
);
inventoryRoutes.get(
  '/products/:productId/store-distribution',
  authenticate,
  requirePermission('inventory.read'),
  asyncHandler(inventoryController.getProductStoreDistribution),
);
inventoryRoutes.get(
  '/products/:productId/distribution-policy',
  authenticate,
  requirePermission('inventory.read'),
  asyncHandler(inventoryController.getProductDistributionPolicy),
);
inventoryRoutes.put(
  '/products/:productId/distribution-policy',
  authenticate,
  requirePermission('inventory.manage'),
  asyncHandler(inventoryController.updateProductDistributionPolicy),
);
inventoryRoutes.get(
  '/assortment-matrix',
  authenticate,
  requirePermission('inventory.read'),
  asyncHandler(inventoryController.getAssortmentMatrix),
);
inventoryRoutes.patch(
  '/assortment-matrix/cell',
  authenticate,
  requirePermission('inventory.manage'),
  asyncHandler(inventoryController.updateAssortmentMatrixCell),
);
inventoryRoutes.get(
  '/store-lots/search',
  authenticate,
  requirePermission('inventory.read'),
  asyncHandler(inventoryController.searchStoreLots),
);
inventoryRoutes.get(
  '/store-products/search',
  authenticate,
  requirePermission('inventory.read'),
  asyncHandler(inventoryController.searchStoreProducts),
);
inventoryRoutes.get(
  '/store-products/:productId/lots',
  authenticate,
  requirePermission('inventory.read'),
  asyncHandler(inventoryController.getStoreProductLots),
);
inventoryRoutes.get(
  '/store-lots',
  authenticate,
  requirePermission('inventory.read'),
  asyncHandler(inventoryController.getStoreLots),
);
// FOH waiters have restaurant.read (not pos.read) but still need the shop catalog
// for offline stock mirror — same selling projection retail POS uses.
inventoryRoutes.get(
  '/pos/catalog',
  authenticate,
  requireAnyPermission(['pos.read', 'restaurant.read']),
  asyncHandler(inventoryController.getPosCatalog),
);
inventoryRoutes.get(
  '/pos/product-search',
  authenticate,
  requirePermission('pos.read'),
  asyncHandler(inventoryController.searchPosProducts),
);
inventoryRoutes.post(
  '/pos/lock-allocation',
  authenticate,
  requirePermission('pos.read'),
  asyncHandler(inventoryController.lockPosAllocation),
);
inventoryRoutes.get(
  '/stock-visibility',
  authenticate,
  requirePermission('inventory.read'),
  asyncHandler(inventoryController.getStockVisibility),
);
inventoryRoutes.get(
  '/stock-levels/:productId',
  authenticate,
  requirePermission('inventory.read'),
  asyncHandler(inventoryController.getStockLevelByProduct)
);
inventoryRoutes.get(
  '/reorder',
  authenticate,
  requirePermission('inventory.read'),
  asyncHandler(inventoryController.getProductsNeedingReorder),
);
inventoryRoutes.get(
  '/value',
  authenticate,
  requirePermission('inventory.read'),
  asyncHandler(inventoryController.getInventoryValue),
);

// Adjustment routes — accept inventory.adjust OR inventory.approve (Role UI SSOT).
inventoryRoutes.post(
  '/adjust',
  authenticate,
  requireAnyPermission([...INVENTORY_STOCK_ADJUST_PERMISSIONS]),
  asyncHandler(inventoryController.adjustInventory)
);

// Enterprise batch adjustment route — direction + reason explicit, no sign inference
inventoryRoutes.post(
  '/adjust-batch',
  authenticate,
  requireAnyPermission([...INVENTORY_STOCK_ADJUST_PERMISSIONS]),
  asyncHandler(inventoryController.adjustBatch)
);

// Stock count routes - nested under /api/inventory/stockcounts
// All routes require authentication (handled in stockCountRoutes)
inventoryRoutes.use('/stockcounts', stockCountRoutes);
inventoryRoutes.use('/store-transfers', storeTransferRoutes);
inventoryRoutes.use('/expiry-automation', expiryAutomationRoutes);
inventoryRoutes.use('/reports', warehouseReportingRoutes);
inventoryRoutes.use('/loss-quarantine', lossQuarantineRoutes);
inventoryRoutes.use('/lot-write-down', lotWriteDownRoutes);
inventoryRoutes.use('/store-locations', storeLocationRoutes);

// ── Inventory Ledger & Reconciliation ────────────────────────

function ledgerPool(req: Request): Pool {
  return req.tenantPool || globalPool;
}

// Get full movement ledger for a product (audit trail)
inventoryRoutes.get('/ledger/:productId', authenticate, requirePermission('inventory.read'), asyncHandler(async (req: Request, res: Response) => {
  const pool = ledgerPool(req);
  const productId = z.string().uuid().parse(req.params.productId);
  const limit = parseInt(String(req.query.limit || '100'), 10);
  const offset = parseInt(String(req.query.offset || '0'), 10);

  const result = await inventoryLedgerRepository.getProductLedger(pool, productId, { limit, offset });
  const balance = await inventoryLedgerRepository.getLedgerBalance(pool, productId);

  res.json({
    success: true,
    data: {
      ...result,
      ledgerBalance: balance,
      pagination: { limit, offset, total: result.total },
    },
  });
}));

// Get ledger-derived stock balance (truth value)
inventoryRoutes.get('/ledger-balance/:productId', authenticate, requirePermission('inventory.read'), asyncHandler(async (req: Request, res: Response) => {
  const pool = ledgerPool(req);
  const productId = z.string().uuid().parse(req.params.productId);
  const balance = await inventoryLedgerRepository.getLedgerBalance(pool, productId);
  res.json({ success: true, data: { productId, ledgerBalance: balance } });
}));

// Get valuation layers for a product
inventoryRoutes.get('/valuation-layers/:productId', authenticate, requirePermission('inventory.read'), asyncHandler(async (req: Request, res: Response) => {
  const pool = ledgerPool(req);
  const productId = z.string().uuid().parse(req.params.productId);
  const activeOnly = req.query.active !== 'false';
  const layers = await inventoryLedgerRepository.getProductValuationLayers(pool, productId, activeOnly);
  res.json({ success: true, data: layers });
}));

// Get total inventory valuation summary
inventoryRoutes.get('/valuation-summary', authenticate, requirePermission('inventory.read'), asyncHandler(async (req: Request, res: Response) => {
  const pool = ledgerPool(req);
  const summary = await inventoryLedgerRepository.getTotalValuation(pool);
  res.json({ success: true, data: summary });
}));

// Three-way stock reconciliation (ledger vs batches vs cache)
inventoryRoutes.get('/reconciliation', authenticate, requirePermission('inventory.read'), asyncHandler(async (req: Request, res: Response) => {
  const pool = ledgerPool(req);
  const reconciliation = await inventoryLedgerRepository.getReconciliation(pool);
  const discrepancyCount = reconciliation.filter(r => !r.isReconciled).length;
  res.json({
    success: true,
    data: {
      products: reconciliation,
      summary: {
        total: reconciliation.length,
        reconciled: reconciliation.length - discrepancyCount,
        discrepancies: discrepancyCount,
      },
    },
  });
}));

// Get only products with stock discrepancies
inventoryRoutes.get('/discrepancies', authenticate, requirePermission('inventory.read'), asyncHandler(async (req: Request, res: Response) => {
  const pool = ledgerPool(req);
  const discrepancies = await inventoryLedgerRepository.getDiscrepancies(pool);
  res.json({ success: true, data: discrepancies });
}));

// Movement summary (by type) — optionally filtered by product
inventoryRoutes.get('/movement-summary', authenticate, requirePermission('inventory.read'), asyncHandler(async (req: Request, res: Response) => {
  const pool = ledgerPool(req);
  const productId = req.query.productId ? z.string().uuid().parse(String(req.query.productId)) : undefined;
  const summary = await inventoryLedgerRepository.getMovementSummary(pool, productId);
  res.json({ success: true, data: summary });
}));

// ── Batch Expiry Management (SAP master data correction) ─────────────────────

const PatchExpirySchema = z.object({
  newExpiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD'),
  reason: z.string().min(5, 'Reason must be at least 5 characters'),
});

// GET /api/inventory/batches/:id — get single batch by ID
inventoryRoutes.get(
  '/batches/:id',
  authenticate,
  requirePermission('inventory.read'),
  asyncHandler(async (req: Request, res: Response) => {
    const pool = req.tenantPool || globalPool;
    const { id } = req.params;
    if (!/^[0-9a-f-]{36}$/.test(id)) {
      res.status(400).json({ success: false, error: 'Invalid batch ID' });
      return;
    }
    const batch = await inventoryRepository.getBatchById(pool, id);
    if (!batch) {
      res.status(404).json({ success: false, error: 'Batch not found' });
      return;
    }
    res.json({ success: true, data: batch });
  })
);

// PATCH /api/inventory/batches/:id/expiry — update batch expiry (governance-gated)
inventoryRoutes.patch(
  '/batches/:id/expiry',
  authenticate,
  requirePermission('inventory.batch_expiry_edit'),
  asyncHandler(async (req: Request, res: Response) => {
    const pool = req.tenantPool || globalPool;
    const { id } = req.params;
    if (!/^[0-9a-f-]{36}$/.test(id)) {
      res.status(400).json({ success: false, error: 'Invalid batch ID' });
      return;
    }
    const body = PatchExpirySchema.parse(req.body);

    // Fetch batch (must exist)
    const batch = await inventoryRepository.getBatchById(pool, id);
    if (!batch) {
      res.status(404).json({ success: false, error: 'Batch not found' });
      return;
    }

    // Build user context from JWT (req.user set by authenticate middleware)
    // permissions come from req.authContext (loaded by requirePermission middleware)
    // Fall back to full-grant for legacy ADMIN role if RBAC context is not available
    const userPermissions: Set<string> = req.authContext?.permissions ?? new Set(['inventory.batch_expiry_edit']);
    const userCtx = {
      id: req.user!.id,
      fullName: req.user!.fullName ?? req.user!.email,
      permissions: userPermissions,
    };

    // Governance validation — throws ForbiddenError or ValidationError on violation
    const validated = validateExpiryEdit(
      batch as { id: string; batch_number: string; remaining_quantity: string; expiry_date: string | null; product_name: string },
      userCtx,
      body.newExpiryDate,
      body.reason
    );

    // Atomic update + audit via LotService (master + projection sync)
    await UnitOfWork.run(pool, async (client) => {
      await correctLotExpiry(client, {
        lotId: id,
        newExpiryDate: validated.newExpiryDate,
        reason: validated.reason,
        userId: validated.userId,
        userName: validated.userName,
        ipAddress: req.ip ?? null,
      });
    });

    res.json({
      success: true,
      data: { batchId: id, newExpiryDate: validated.newExpiryDate },
      message: `Batch ${validated.batchNumber} expiry updated to ${validated.newExpiryDate}`,
    });
  })
);

// GET /api/inventory/batches/:id/expiry-audit — fetch audit history
inventoryRoutes.get(
  '/batches/:id/expiry-audit',
  authenticate,
  requirePermission('inventory.read'),
  asyncHandler(async (req: Request, res: Response) => {
    const pool = req.tenantPool || globalPool;
    const { id } = req.params;
    if (!/^[0-9a-f-]{36}$/.test(id)) {
      res.status(400).json({ success: false, error: 'Invalid batch ID' });
      return;
    }
    const history = await inventoryRepository.getExpiryAuditHistory(pool, id);
    res.json({ success: true, data: history });
  })
);
