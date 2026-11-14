import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { pool as globalPool } from '../../db/pool.js';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission, requireAnyPermission } from '../../rbac/middleware.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { restaurantService } from './restaurantService.js';
import { systemSettingsService } from '../system-settings/systemSettingsService.js';
import type { OwnershipActor } from '../../../../shared/utils/restaurantCheckOwnership.js';
import { legacyRoleGrantsPermission } from '../../../../shared/authorization/legacyRoleFallback.js';

/**
 * Ownership must match route gates: RBAC perms when present, unioned with
 * legacy users.role grants for floor override (ADMIN/MANAGER/CASHIER).
 *
 * Do NOT gate legacy merge on `permissions.size === 0` — if authContext is
 * missing/partial, a Super-Admin who still has users.role=STAFF (mis-seeded
 * admin@test.com) would be blocked from peer tables.
 */
function ownershipActorFromReq(req: Request): OwnershipActor {
  const rbac = req.authContext?.permissions;
  const permissions = new Set<string>(rbac ? [...rbac] : []);
  const rbacRoleNames = new Set<string>();
  if (req.authContext?.scopedPermissions) {
    for (const entries of req.authContext.scopedPermissions.values()) {
      for (const entry of entries) {
        if (entry.roleName) rbacRoleNames.add(entry.roleName);
      }
    }
  }
  if (req.user?.role) {
    for (const key of [
      'restaurant.pay',
      'restaurant.manage',
      'restaurant.edit_others',
    ] as const) {
      if (legacyRoleGrantsPermission(req.user.role, key)) permissions.add(key);
    }
  }
  return {
    userId: req.user!.id,
    role: req.user!.role,
    permissions,
    rbacRoleNames,
  };
}

const router = Router();
router.use(authenticate);

const TableCreateSchema = z.object({
  code: z.string().min(1).max(32),
  name: z.string().min(1).max(120),
  zone: z.string().max(64).optional(),
  seats: z.number().int().min(0).optional(),
  sortOrder: z.number().int().optional(),
});

const TableUpdateSchema = TableCreateSchema.partial().extend({
  isActive: z.boolean().optional(),
});

const AddItemsSchema = z.object({
  tableId: z.string().uuid(),
  /** Multi-ticket: append to this open check (not only table.current_order_id). */
  orderId: z.string().uuid().optional(),
  /**
   * Party-list menu add: always open a new PENDING check with these items.
   * Ignores orderId and table.current_order_id (siblings stay open).
   */
  forceNewCheck: z.boolean().optional(),
  customerId: z.string().uuid().nullable().optional(),
  taxAmount: z.number().nonnegative().optional(),
  waiterId: z.string().uuid().optional(),
  guestName: z.string().max(200).nullable().optional(),
  guestPhone: z.string().max(50).nullable().optional(),
  deliveryAddress: z.string().max(1000).nullable().optional(),
  pickupLabel: z.string().max(120).nullable().optional(),
  items: z
    .array(
      z.object({
        productId: z.string().min(1),
        productName: z.string().optional(),
        quantity: z.number().positive(),
        unitPrice: z.number().nonnegative().optional(),
        discountAmount: z.number().nonnegative().optional(),
        lineNotes: z.string().nullable().optional(),
        orderTags: z
          .array(
            z.object({
              id: z.string().uuid().nullable().optional(),
              label: z.string().min(1).max(80),
              prefix: z.string().max(20).nullable().optional(),
              price: z.number().nonnegative().optional(),
            }),
          )
          .optional(),
        uomId: z.string().uuid().nullable().optional(),
      }),
    )
    .min(1),
});

const GuestDetailsSchema = z.object({
  guestName: z.string().max(200).nullable().optional(),
  guestPhone: z.string().max(50).nullable().optional(),
  deliveryAddress: z.string().max(1000).nullable().optional(),
  pickupLabel: z.string().max(120).nullable().optional(),
});

const AssignWaiterSchema = z.object({
  waiterId: z.string().uuid(),
});

const ProductFlagsSchema = z.object({
  availableInRestaurant: z.boolean().optional(),
  kitchenStation: z.string().max(64).nullable().optional(),
});

/**
 * GET /api/restaurant/enabled
 * Readable without restaurant permissions so Layout can hide/show nav.
 */
router.get(
  '/enabled',
  asyncHandler(async (req: Request, res: Response) => {
    const pool = req.tenantPool || globalPool;
    const flags = await restaurantService.getFohFlags(pool);
    res.json({
      success: true,
      data: { enabled: flags.enabled, allowOversell: flags.allowOversell },
    });
  }),
);

router.get(
  '/tables',
  requireAnyPermission(['restaurant.read', 'restaurant.order', 'restaurant.manage']),
  asyncHandler(async (req: Request, res: Response) => {
    const pool = req.tenantPool || globalPool;
    const includeInactive = req.query.includeInactive === 'true';
    const tables = await restaurantService.listTables(
      pool,
      includeInactive,
      ownershipActorFromReq(req),
    );
    res.json({ success: true, data: tables });
  }),
);

router.get(
  '/waiters',
  requireAnyPermission(['restaurant.read', 'restaurant.order', 'restaurant.manage']),
  asyncHandler(async (req: Request, res: Response) => {
    const pool = req.tenantPool || globalPool;
    const waiters = await restaurantService.listAssignableWaiters(pool);
    res.json({ success: true, data: waiters });
  }),
);

router.post(
  '/tables',
  requirePermission('restaurant.manage'),
  asyncHandler(async (req: Request, res: Response) => {
    const pool = req.tenantPool || globalPool;
    const body = TableCreateSchema.parse(req.body);
    const table = await restaurantService.createTable(pool, body);
    res.status(201).json({ success: true, data: table });
  }),
);

/** Cashiers / managers may ensure TA/DL/QK lanes (not floor waiters). */
router.post(
  '/service-lanes/ensure',
  requireAnyPermission(['restaurant.manage', 'restaurant.pay']),
  asyncHandler(async (req: Request, res: Response) => {
    const pool = req.tenantPool || globalPool;
    const tables = await restaurantService.ensureServiceLanes(pool);
    res.json({ success: true, data: tables });
  }),
);

router.patch(
  '/tables/:id',
  requirePermission('restaurant.manage'),
  asyncHandler(async (req: Request, res: Response) => {
    const pool = req.tenantPool || globalPool;
    const body = TableUpdateSchema.parse(req.body);
    const table = await restaurantService.updateTable(pool, req.params.id, body);
    res.json({ success: true, data: table });
  }),
);

const ORDER_ID_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

router.get(
  '/tables/:id/check',
  requireAnyPermission(['restaurant.read', 'restaurant.order']),
  asyncHandler(async (req: Request, res: Response) => {
    const pool = req.tenantPool || globalPool;
    // Optimistic tmp_ord_* / ofl_ord_* must never reach Postgres UUID columns (22P02).
    const rawOrderId =
      typeof req.query.orderId === 'string' && req.query.orderId.length > 0
        ? req.query.orderId
        : null;
    const activeOrderId = rawOrderId && ORDER_ID_UUID_RE.test(rawOrderId) ? rawOrderId : null;
    const check = await restaurantService.getTableCheck(
      pool,
      req.params.id,
      activeOrderId,
      ownershipActorFromReq(req),
    );
    res.json({ success: true, data: check });
  }),
);

router.post(
  '/tables/:id/activate-check',
  requirePermission('restaurant.order'),
  asyncHandler(async (req: Request, res: Response) => {
    const pool = req.tenantPool || globalPool;
    const body = z.object({ orderId: z.string().min(1) }).parse(req.body);
    // Optimistic tmp_ord_* / ofl_* must never hit UUID columns — ignore and resume table check.
    if (!ORDER_ID_UUID_RE.test(body.orderId)) {
      const check = await restaurantService.getTableCheck(
        pool,
        req.params.id,
        null,
        ownershipActorFromReq(req),
      );
      res.json({ success: true, data: check });
      return;
    }
    const check = await restaurantService.activateCheck(
      pool,
      req.params.id,
      body.orderId,
      ownershipActorFromReq(req),
    );
    res.json({ success: true, data: check });
  }),
);

/**
 * POST /api/restaurant/tables/:id/open-check
 * Samba multi-ticket: open empty PENDING check on table without moving lines.
 * Preserves all sibling checks (no merge/cancel/release).
 */
router.post(
  '/tables/:id/open-check',
  requirePermission('restaurant.order'),
  asyncHandler(async (req: Request, res: Response) => {
    const pool = req.tenantPool || globalPool;
    const body = z
      .object({
        waiterId: z.string().uuid().optional(),
        guestName: z.string().max(200).nullable().optional(),
        guestPhone: z.string().max(50).nullable().optional(),
        deliveryAddress: z.string().max(1000).nullable().optional(),
        pickupLabel: z.string().max(120).nullable().optional(),
      })
      .parse(req.body ?? {});
    const actor = ownershipActorFromReq(req);
    const waiterId = body.waiterId || req.user!.id;
    const check = await restaurantService.openEmptyCheck(pool, {
      tableId: req.params.id,
      waiterId,
      actor,
      guestName: body.guestName,
      guestPhone: body.guestPhone,
      deliveryAddress: body.deliveryAddress,
      pickupLabel: body.pickupLabel,
    });
    res.status(201).json({ success: true, data: check });
  }),
);

router.get(
  '/menu/categories',
  requireAnyPermission(['restaurant.read', 'restaurant.order']),
  asyncHandler(async (req: Request, res: Response) => {
    const pool = req.tenantPool || globalPool;
    const categories = await restaurantService.listMenuCategories(pool);
    res.json({ success: true, data: categories });
  }),
);

router.get(
  '/menu/products',
  requireAnyPermission(['restaurant.read', 'restaurant.order']),
  asyncHandler(async (req: Request, res: Response) => {
    const pool = req.tenantPool || globalPool;
    const categoryId =
      typeof req.query.categoryId === 'string' && req.query.categoryId.length > 0
        ? req.query.categoryId
        : null;
    const products = await restaurantService.listMenuProducts(pool, { categoryId });
    res.json({ success: true, data: products });
  }),
);

router.patch(
  '/menu/products/:id',
  requirePermission('restaurant.manage'),
  asyncHandler(async (req: Request, res: Response) => {
    const pool = req.tenantPool || globalPool;
    const body = ProductFlagsSchema.parse(req.body);
    const product = await restaurantService.setProductFlags(pool, req.params.id, body);
    res.json({ success: true, data: product });
  }),
);

router.post(
  '/checks/items',
  requirePermission('restaurant.order'),
  asyncHandler(async (req: Request, res: Response) => {
    const pool = req.tenantPool || globalPool;
    const body = AddItemsSchema.parse(req.body);
    const result = await restaurantService.addItemsToTable(pool, {
      ...body,
      waiterId: body.waiterId ?? req.user!.id,
      actor: ownershipActorFromReq(req),
    });
    res.status(201).json({ success: true, data: result });
  }),
);

router.patch(
  '/checks/:orderId/guest',
  requirePermission('restaurant.order'),
  asyncHandler(async (req: Request, res: Response) => {
    const pool = req.tenantPool || globalPool;
    const body = GuestDetailsSchema.parse(req.body ?? {});
    const result = await restaurantService.updateCheckGuest(
      pool,
      req.params.orderId,
      body,
      ownershipActorFromReq(req),
    );
    res.json({ success: true, data: result });
  }),
);

router.patch(
  '/checks/:orderId/notes',
  requirePermission('restaurant.order'),
  asyncHandler(async (req: Request, res: Response) => {
    const pool = req.tenantPool || globalPool;
    const body = z
      .object({ notes: z.string().max(2000).nullable() })
      .parse(req.body ?? {});
    const result = await restaurantService.updateCheckNotes(
      pool,
      req.params.orderId,
      body.notes,
      ownershipActorFromReq(req),
    );
    res.json({ success: true, data: result });
  }),
);

router.patch(
  '/checks/:orderId/waiter',
  requirePermission('restaurant.order'),
  asyncHandler(async (req: Request, res: Response) => {
    const pool = req.tenantPool || globalPool;
    const body = AssignWaiterSchema.parse(req.body);
    const result = await restaurantService.assignWaiter(
      pool,
      req.params.orderId,
      body.waiterId,
      ownershipActorFromReq(req),
    );
    res.json({ success: true, data: result });
  }),
);

const TransferSchema = z.object({
  toTableId: z.string().uuid(),
});

const MergeSchema = z.object({
  secondaryOrderId: z.string().uuid(),
});

const SplitSchema = z
  .object({
    /** Full-line move (legacy). Prefer `items` when moving partial qty. */
    itemIds: z.array(z.string().uuid()).optional(),
    /** Samba Move N of M — quantity omitted means move the whole line. */
    items: z
      .array(
        z.object({
          itemId: z.string().uuid(),
          quantity: z.number().positive().optional(),
        }),
      )
      .optional(),
    targetTableId: z.string().uuid(),
    sameTable: z.boolean().optional(),
  })
  .refine((d) => (d.items?.length ?? 0) > 0 || (d.itemIds?.length ?? 0) > 0, {
    message: 'Select at least one line to split',
  });

router.post(
  '/checks/:orderId/transfer',
  requirePermission('restaurant.order'),
  asyncHandler(async (req: Request, res: Response) => {
    const pool = req.tenantPool || globalPool;
    const body = TransferSchema.parse(req.body);
    const result = await restaurantService.transferCheck(
      pool,
      req.params.orderId,
      body.toTableId,
      req.user!.id,
      ownershipActorFromReq(req),
    );
    res.json({ success: true, data: result });
  }),
);

router.post(
  '/checks/:orderId/merge',
  requirePermission('restaurant.order'),
  asyncHandler(async (req: Request, res: Response) => {
    const pool = req.tenantPool || globalPool;
    const body = MergeSchema.parse(req.body);
    const result = await restaurantService.mergeChecks(
      pool,
      req.params.orderId,
      body.secondaryOrderId,
      req.user!.id,
      ownershipActorFromReq(req),
    );
    res.json({ success: true, data: result });
  }),
);

router.post(
  '/checks/:orderId/split',
  requirePermission('restaurant.order'),
  asyncHandler(async (req: Request, res: Response) => {
    const pool = req.tenantPool || globalPool;
    const body = SplitSchema.parse(req.body);
    const result = await restaurantService.splitCheck(pool, req.params.orderId, {
      itemIds: body.itemIds,
      items: body.items,
      targetTableId: body.targetTableId,
      sameTable: body.sameTable,
      actorId: req.user!.id,
      actor: ownershipActorFromReq(req),
    });
    res.status(201).json({ success: true, data: result });
  }),
);

router.post(
  '/checks/:orderId/kot',
  requireAnyPermission(['restaurant.kitchen', 'restaurant.order']),
  asyncHandler(async (req: Request, res: Response) => {
    const pool = req.tenantPool || globalPool;
    const result = await restaurantService.sendKot(
      pool,
      req.params.orderId,
      req.user!.id,
      ownershipActorFromReq(req),
    );
    res.status(201).json({ success: true, data: result });
  }),
);

const VoidItemsSchema = z
  .object({
    reason: z.string().min(1).max(500),
    /** Toast/Samba: void this many units per line (omit quantity = full line). */
    items: z
      .array(
        z.object({
          itemId: z.string().uuid(),
          quantity: z.number().positive().optional(),
        }),
      )
      .min(1)
      .optional(),
    /** Legacy: void entire line(s). Prefer `items` with quantity. */
    itemIds: z.array(z.string().uuid()).min(1).optional(),
  })
  .refine((b) => (b.items?.length || 0) > 0 || (b.itemIds?.length || 0) > 0, {
    message: 'Select at least one line to void',
  });

/**
 * POST /api/restaurant/checks/:orderId/void-items
 * Void selected lines (optional partial quantity). Kitchen-sent qty emits VOID KOT tickets.
 */
router.post(
  '/checks/:orderId/void-items',
  requirePermission('restaurant.order'),
  asyncHandler(async (req: Request, res: Response) => {
    const pool = req.tenantPool || globalPool;
    const body = VoidItemsSchema.parse(req.body);
    const items =
      body.items && body.items.length > 0
        ? body.items
        : (body.itemIds || []).map((itemId) => ({ itemId }));
    const result = await restaurantService.voidCheckItems(pool, req.params.orderId, {
      items,
      reason: body.reason,
      voidedBy: req.user!.id,
      actor: ownershipActorFromReq(req),
    });
    res.status(200).json({
      success: true,
      data: result,
      message: result.checkCancelled
        ? 'Check voided — table freed'
        : `Voided ${items.length} line(s)`,
    });
  }),
);

/**
 * GET /api/restaurant/kitchen/board — active KDS tickets (no prices)
 */
router.get(
  '/kitchen/board',
  requireAnyPermission(['restaurant.kitchen', 'restaurant.read', 'restaurant.order']),
  asyncHandler(async (req: Request, res: Response) => {
    const pool = req.tenantPool || globalPool;
    const station =
      typeof req.query.station === 'string' && req.query.station.length > 0
        ? req.query.station
        : null;
    const tickets = await restaurantService.listKitchenBoard(pool, { station });
    res.json({ success: true, data: tickets });
  }),
);

const StationCreateSchema = z.object({
  code: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  printerName: z.string().max(200).nullable().optional(),
  sortOrder: z.number().int().optional(),
  isDefault: z.boolean().optional(),
});

const StationUpdateSchema = StationCreateSchema.partial().extend({
  isActive: z.boolean().optional(),
});

const GuestBillPrinterSchema = z.object({
  printerName: z.string().max(200).nullable(),
});

router.get(
  '/guest-bill-printer',
  requireAnyPermission(['restaurant.read', 'restaurant.order', 'restaurant.manage']),
  asyncHandler(async (req: Request, res: Response) => {
    const pool = req.tenantPool || globalPool;
    const settings = await systemSettingsService.getSettings(pool);
    const dedicated = settings.guestBillPrinterName?.trim() || null;
    const resolved = (await systemSettingsService.getGuestBillPrintConfig(pool)).printerName;
    res.json({
      success: true,
      data: {
        printerName: dedicated,
        resolvedPrinterName: resolved,
      },
    });
  }),
);

router.patch(
  '/guest-bill-printer',
  requirePermission('restaurant.manage'),
  asyncHandler(async (req: Request, res: Response) => {
    const pool = req.tenantPool || globalPool;
    const body = GuestBillPrinterSchema.parse(req.body);
    const result = await systemSettingsService.updateSettings(
      pool,
      { guestBillPrinterName: body.printerName },
      req.user?.id,
    );
    const dedicated = result.settings.guestBillPrinterName?.trim() || null;
    const resolved = (await systemSettingsService.getGuestBillPrintConfig(pool)).printerName;
    res.json({
      success: true,
      data: {
        printerName: dedicated,
        resolvedPrinterName: resolved,
      },
    });
  }),
);

const RecipeUpsertSchema = z.object({
  parentProductId: z.string().uuid(),
  name: z.string().min(1).max(120),
  isActive: z.boolean().optional(),
  notes: z.string().max(2000).nullable().optional(),
  usageMode: z.enum(['AT_SALE', 'AT_PRODUCTION']).optional(),
  lines: z
    .array(
      z.object({
        componentProductId: z.string().uuid(),
        quantityBase: z.number().positive(),
        sortOrder: z.number().int().optional(),
      }),
    )
    .min(1),
});

router.get(
  '/stations',
  requireAnyPermission(['restaurant.read', 'restaurant.order', 'restaurant.kitchen', 'restaurant.manage']),
  asyncHandler(async (req: Request, res: Response) => {
    const pool = req.tenantPool || globalPool;
    const includeInactive = req.query.includeInactive === 'true';
    const stations = await restaurantService.listStations(pool, includeInactive);
    res.json({ success: true, data: stations });
  }),
);

router.post(
  '/stations',
  requirePermission('restaurant.manage'),
  asyncHandler(async (req: Request, res: Response) => {
    const pool = req.tenantPool || globalPool;
    const body = StationCreateSchema.parse(req.body);
    const station = await restaurantService.createStation(pool, body);
    res.status(201).json({ success: true, data: station });
  }),
);

router.patch(
  '/stations/:id',
  requirePermission('restaurant.manage'),
  asyncHandler(async (req: Request, res: Response) => {
    const pool = req.tenantPool || globalPool;
    const body = StationUpdateSchema.parse(req.body);
    const station = await restaurantService.updateStation(pool, req.params.id, body);
    res.json({ success: true, data: station });
  }),
);

router.get(
  '/recipes',
  requireAnyPermission(['restaurant.read', 'restaurant.manage']),
  asyncHandler(async (req: Request, res: Response) => {
    const pool = req.tenantPool || globalPool;
    const recipes = await restaurantService.listRecipes(pool);
    res.json({ success: true, data: recipes });
  }),
);

router.get(
  '/recipes/by-product/:productId',
  requireAnyPermission(['restaurant.read', 'restaurant.manage']),
  asyncHandler(async (req: Request, res: Response) => {
    const pool = req.tenantPool || globalPool;
    const recipe = await restaurantService.getRecipeByProduct(pool, req.params.productId);
    res.json({ success: true, data: recipe });
  }),
);

router.put(
  '/recipes',
  requirePermission('restaurant.manage'),
  asyncHandler(async (req: Request, res: Response) => {
    const pool = req.tenantPool || globalPool;
    const body = RecipeUpsertSchema.parse(req.body);
    const recipe = await restaurantService.upsertRecipe(pool, body);
    res.json({ success: true, data: recipe });
  }),
);

router.delete(
  '/recipes/:id',
  requirePermission('restaurant.manage'),
  asyncHandler(async (req: Request, res: Response) => {
    const pool = req.tenantPool || globalPool;
    const result = await restaurantService.deleteRecipe(pool, req.params.id);
    res.json({ success: true, data: result });
  }),
);

const KotStatusSchema = z.object({
  status: z.enum(['SENT', 'PREPARING', 'READY', 'BUMPED']).optional(),
});

/**
 * POST /api/restaurant/kitchen/tickets/:kotId/advance
 * Advance ticket: SENT → PREPARING → READY → BUMPED
 */
router.post(
  '/kitchen/tickets/:kotId/advance',
  requirePermission('restaurant.kitchen'),
  asyncHandler(async (req: Request, res: Response) => {
    const pool = req.tenantPool || globalPool;
    const body = KotStatusSchema.parse(req.body ?? {});
    const result = await restaurantService.advanceKotStatus(
      pool,
      req.params.kotId,
      req.user!.id,
      body.status,
    );
    res.json({ success: true, data: result });
  }),
);

/** Mark table BILLING + return check for print. Prefer POST (mutating). */
const billHandler = asyncHandler(async (req: Request, res: Response) => {
  const pool = req.tenantPool || globalPool;
  const bill = await restaurantService.requestBill(
    pool,
    req.params.orderId,
    ownershipActorFromReq(req),
  );
  res.json({ success: true, data: bill });
});

router.post(
  '/checks/:orderId/bill',
  // Mutating BILLING transition — not a read-only print peek.
  requireAnyPermission(['restaurant.pay', 'restaurant.order']),
  billHandler,
);

/** @deprecated Prefer POST — kept for older clients */
router.get(
  '/checks/:orderId/bill',
  requireAnyPermission(['restaurant.pay', 'restaurant.order']),
  billHandler,
);

const CancelCheckSchema = z.object({
  reason: z.string().min(1).max(500).optional(),
});

router.post(
  '/checks/:orderId/cancel',
  // Managers only — waiters/cashiers cannot cancel entire checks (UI + API).
  requirePermission('restaurant.manage'),
  asyncHandler(async (req: Request, res: Response) => {
    const pool = req.tenantPool || globalPool;
    const body = CancelCheckSchema.parse(req.body ?? {});
    const result = await restaurantService.cancelCheck(
      pool,
      req.params.orderId,
      req.user!.id,
      body.reason || 'Cancelled from restaurant POS',
      ownershipActorFromReq(req),
    );
    res.json({
      success: true,
      data: result,
      message: `Check ${result.order.orderNumber} cancelled`,
    });
  }),
);

// ── Order tags (Samba modifiers) ─────────────────────────────────────

router.get(
  '/order-tags',
  requireAnyPermission(['restaurant.read', 'restaurant.order', 'restaurant.manage']),
  asyncHandler(async (req: Request, res: Response) => {
    const pool = req.tenantPool || globalPool;
    const data = await restaurantService.listOrderTagCatalog(pool);
    res.json({ success: true, data });
  }),
);

router.get(
  '/order-tags/for-product/:productId',
  requireAnyPermission(['restaurant.read', 'restaurant.order']),
  asyncHandler(async (req: Request, res: Response) => {
    const pool = req.tenantPool || globalPool;
    const data = await restaurantService.listOrderTagsForProduct(pool, req.params.productId);
    res.json({ success: true, data });
  }),
);

const UpsertTagGroupSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1).max(80),
  sortOrder: z.number().int().optional(),
  minSelect: z.number().int().min(0).optional(),
  maxSelect: z.number().int().min(0).nullable().optional(),
  autoPrompt: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

router.post(
  '/order-tags/groups',
  requirePermission('restaurant.manage'),
  asyncHandler(async (req: Request, res: Response) => {
    const pool = req.tenantPool || globalPool;
    const body = UpsertTagGroupSchema.parse(req.body);
    const data = await restaurantService.upsertOrderTagGroup(pool, body);
    res.json({ success: true, data });
  }),
);

const UpsertTagSchema = z.object({
  id: z.string().uuid().optional(),
  groupId: z.string().uuid(),
  label: z.string().min(1).max(80),
  prefix: z.string().max(20).nullable().optional(),
  price: z.number().nonnegative().optional(),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional(),
});

router.post(
  '/order-tags/tags',
  requirePermission('restaurant.manage'),
  asyncHandler(async (req: Request, res: Response) => {
    const pool = req.tenantPool || globalPool;
    const body = UpsertTagSchema.parse(req.body);
    const data = await restaurantService.upsertOrderTag(pool, body);
    res.json({ success: true, data });
  }),
);

const MapTagGroupSchema = z.object({
  groupId: z.string().uuid(),
  productId: z.string().uuid().nullable().optional(),
  categoryId: z.string().uuid().nullable().optional(),
});

router.post(
  '/order-tags/mappings',
  requirePermission('restaurant.manage'),
  asyncHandler(async (req: Request, res: Response) => {
    const pool = req.tenantPool || globalPool;
    const body = MapTagGroupSchema.parse(req.body);
    const data = await restaurantService.mapOrderTagGroup(pool, body);
    res.json({ success: true, data });
  }),
);

const SetItemTagsSchema = z.object({
  itemId: z.string().uuid(),
  freeText: z.string().max(500).nullable().optional(),
  orderTags: z
    .array(
      z.object({
        id: z.string().uuid().nullable().optional(),
        label: z.string().min(1).max(80),
        prefix: z.string().max(20).nullable().optional(),
        price: z.number().nonnegative().optional(),
      }),
    )
    .default([]),
});

router.post(
  '/checks/:orderId/item-tags',
  requirePermission('restaurant.order'),
  asyncHandler(async (req: Request, res: Response) => {
    const pool = req.tenantPool || globalPool;
    const body = SetItemTagsSchema.parse(req.body);
    const data = await restaurantService.setOrderItemTags(pool, {
      orderId: req.params.orderId,
      itemId: body.itemId,
      orderTags: body.orderTags,
      freeText: body.freeText,
      actor: ownershipActorFromReq(req),
    });
    res.json({ success: true, data });
  }),
);

export default router;
