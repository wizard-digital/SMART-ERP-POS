/**
 * Kitchen Production routes — ADR-005 Phase 1.
 * Mount: /api/kitchen-production
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { authenticate } from '../../middleware/auth.js';
import { getAuthorizationService, requireAnyPermission, requirePermission } from '../../rbac/middleware.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { kitchenProductionService } from './kitchenProductionService.js';
import { buffetSessionService } from './buffetSessionService.js';
import { kitchenWasteService } from './kitchenWasteService.js';
import { kitchenAnalyticsService } from './kitchenAnalyticsService.js';
import { kitchenOpsService } from './kitchenOpsService.js';
import { storeIssueService } from './storeIssueService.js';
import {
  STORE_ISSUE_REVERSE_REASON_MAX,
  STORE_ISSUE_REVERSE_REASON_MIN,
} from '../../../../shared/store-issue/index.js';

const router = Router();
router.use(authenticate);

const LineSchema = z.object({
  productId: z.string().uuid(),
  plannedQtyBase: z.number().nonnegative().optional(),
  actualQtyBase: z.number().positive(),
  sortOrder: z.number().int().optional(),
});

const DraftSchema = z.object({
  productionDate: z.string().optional(),
  storeLocationId: z.string().uuid().nullable().optional(),
  outputProductId: z.string().uuid(),
  outputQtyBase: z.number().positive(),
  outputLotNumber: z.string().max(64).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  lines: z.array(LineSchema).min(1),
});

const UpdateSchema = DraftSchema.partial().extend({
  lines: z.array(LineSchema).min(1).optional(),
});

/** GET /api/kitchen-production/enabled */
router.get(
  '/enabled',
  asyncHandler(async (_req: Request, res: Response) => {
    const enabled = await kitchenProductionService.isEnabled(pool);
    res.json({ success: true, data: { enabled } });
  }),
);

/** GET /api/kitchen-production/producible-products */
router.get(
  '/producible-products',
  requirePermission('kitchen.production.read'),
  asyncHandler(async (req: Request, res: Response) => {
    const preparedOnly =
      req.query.preparedOnly === 'false' || req.query.preparedOnly === '0'
        ? false
        : true;
    const search = typeof req.query.search === 'string' ? req.query.search : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const data = await kitchenProductionService.listProducibleProducts(pool, {
      preparedOnly,
      search,
      limit,
    });
    res.json({ success: true, data });
  }),
);

/** GET /api/kitchen-production/batches */
router.get(
  '/batches',
  requirePermission('kitchen.production.read'),
  asyncHandler(async (req: Request, res: Response) => {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const data = await kitchenProductionService.list(pool, { status, limit });
    res.json({ success: true, data });
  }),
);

/** GET /api/kitchen-production/batches/:id */
router.get(
  '/batches/:id',
  requirePermission('kitchen.production.read'),
  asyncHandler(async (req: Request, res: Response) => {
    const data = await kitchenProductionService.getById(pool, req.params.id);
    res.json({ success: true, data });
  }),
);

/** POST /api/kitchen-production/plan-from-recipe */
router.post(
  '/plan-from-recipe',
  requirePermission('kitchen.production.create'),
  asyncHandler(async (req: Request, res: Response) => {
    const body = z
      .object({
        outputProductId: z.string().uuid(),
        outputQtyBase: z.number().positive(),
      })
      .parse(req.body);
    const data = await kitchenProductionService.planFromRecipe(
      pool,
      body.outputProductId,
      body.outputQtyBase,
    );
    res.json({ success: true, data });
  }),
);

/** POST /api/kitchen-production/batches */
router.post(
  '/batches',
  requirePermission('kitchen.production.create'),
  asyncHandler(async (req: Request, res: Response) => {
    const body = DraftSchema.parse(req.body);
    const lines = body.lines.map((l) => ({
      productId: l.productId,
      plannedQtyBase: l.plannedQtyBase ?? l.actualQtyBase,
      actualQtyBase: l.actualQtyBase,
      sortOrder: l.sortOrder,
    }));
    const data = await kitchenProductionService.createDraft(
      pool,
      { ...body, lines },
      req.user!.id,
    );
    res.status(201).json({ success: true, data });
  }),
);

/** PATCH /api/kitchen-production/batches/:id */
router.patch(
  '/batches/:id',
  requirePermission('kitchen.production.create'),
  asyncHandler(async (req: Request, res: Response) => {
    const body = UpdateSchema.parse(req.body);
    const lines = body.lines?.map((l) => ({
      productId: l.productId,
      plannedQtyBase: l.plannedQtyBase ?? l.actualQtyBase,
      actualQtyBase: l.actualQtyBase,
      sortOrder: l.sortOrder,
    }));
    const data = await kitchenProductionService.updateDraft(pool, req.params.id, {
      ...body,
      lines,
    });
    res.json({ success: true, data });
  }),
);

/** POST /api/kitchen-production/batches/:id/post */
router.post(
  '/batches/:id/post',
  requirePermission('kitchen.production.post'),
  asyncHandler(async (req: Request, res: Response) => {
    const data = await kitchenProductionService.post(pool, req.params.id, req.user!.id);
    res.json({ success: true, data });
  }),
);

/** POST /api/kitchen-production/batches/:id/cancel */
router.post(
  '/batches/:id/cancel',
  requirePermission('kitchen.production.create'),
  asyncHandler(async (req: Request, res: Response) => {
    const data = await kitchenProductionService.cancelDraft(pool, req.params.id);
    res.json({ success: true, data });
  }),
);

// ─── Phase 3: Buffet Sessions ───────────────────────────────────────────

const BuffetLineSchema = z.object({
  preparedProductId: z.string().uuid(),
  plannedQtyBase: z.number().nonnegative(),
  unitLabel: z.string().max(40).nullable().optional(),
  sortOrder: z.number().int().optional(),
  notes: z.string().max(500).nullable().optional(),
});

const BuffetDraftSchema = z.object({
  name: z.string().min(1).max(160),
  serviceDate: z.string().optional(),
  coverProductId: z.string().uuid(),
  expectedCovers: z.number().nonnegative(),
  allowOverbook: z.boolean().optional(),
  storeLocationId: z.string().uuid().nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  lines: z.array(BuffetLineSchema).optional(),
});

router.get(
  '/buffet-sessions',
  requirePermission('kitchen.production.read'),
  asyncHandler(async (req: Request, res: Response) => {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const serviceDate =
      typeof req.query.serviceDate === 'string' ? req.query.serviceDate : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const data = await buffetSessionService.list(pool, { status, serviceDate, limit });
    res.json({ success: true, data });
  }),
);

router.get(
  '/buffet-sessions/:id',
  requirePermission('kitchen.production.read'),
  asyncHandler(async (req: Request, res: Response) => {
    const data = await buffetSessionService.getById(pool, req.params.id);
    res.json({ success: true, data });
  }),
);

router.post(
  '/buffet-sessions',
  requirePermission('kitchen.production.create'),
  asyncHandler(async (req: Request, res: Response) => {
    const body = BuffetDraftSchema.parse(req.body);
    const data = await buffetSessionService.createDraft(pool, body, req.user!.id);
    res.status(201).json({ success: true, data });
  }),
);

router.patch(
  '/buffet-sessions/:id',
  requirePermission('kitchen.production.create'),
  asyncHandler(async (req: Request, res: Response) => {
    const body = BuffetDraftSchema.partial().parse(req.body);
    const data = await buffetSessionService.updateDraft(pool, req.params.id, body);
    res.json({ success: true, data });
  }),
);

router.post(
  '/buffet-sessions/:id/open',
  requirePermission('kitchen.production.post'),
  asyncHandler(async (req: Request, res: Response) => {
    const data = await buffetSessionService.open(pool, req.params.id, req.user!.id);
    res.json({ success: true, data });
  }),
);

router.post(
  '/buffet-sessions/:id/close',
  requirePermission('kitchen.production.post'),
  asyncHandler(async (req: Request, res: Response) => {
    const data = await buffetSessionService.close(pool, req.params.id, req.user!.id);
    res.json({ success: true, data });
  }),
);

router.post(
  '/buffet-sessions/:id/cancel',
  requirePermission('kitchen.production.create'),
  asyncHandler(async (req: Request, res: Response) => {
    const data = await buffetSessionService.cancel(pool, req.params.id);
    res.json({ success: true, data });
  }),
);

// ─── Phase 4: Kitchen Waste / Yield ─────────────────────────────────────

const WasteLineSchema = z.object({
  productId: z.string().uuid(),
  plannedQtyBase: z.number().nonnegative().optional(),
  qtyBase: z.number().positive(),
  sortOrder: z.number().int().optional(),
  notes: z.string().max(500).nullable().optional(),
});

const WasteDraftSchema = z.object({
  documentType: z.enum(['WASTE_YIELD', 'CLOSING']).optional(),
  wasteDate: z.string().optional(),
  reason: z
    .enum(['COOKING_LOSS', 'LEFTOVER', 'STAFF_MEAL', 'SPOILAGE', 'OVERPRODUCTION', 'OTHER'])
    .optional(),
  storeLocationId: z.string().uuid().nullable().optional(),
  buffetSessionId: z.string().uuid().nullable().optional(),
  productionDocumentId: z.string().uuid().nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  lines: z.array(WasteLineSchema).min(1),
});

const CloseWithLeftoversSchema = z.object({
  leftoverLines: z.array(WasteLineSchema).optional(),
  reason: z
    .enum(['COOKING_LOSS', 'LEFTOVER', 'STAFF_MEAL', 'SPOILAGE', 'OVERPRODUCTION', 'OTHER'])
    .optional(),
  storeLocationId: z.string().uuid().nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

router.get(
  '/waste',
  requirePermission('kitchen.production.read'),
  asyncHandler(async (req: Request, res: Response) => {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const buffetSessionId =
      typeof req.query.buffetSessionId === 'string' ? req.query.buffetSessionId : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const data = await kitchenWasteService.list(pool, { status, buffetSessionId, limit });
    res.json({ success: true, data });
  }),
);

router.get(
  '/waste/:id',
  requirePermission('kitchen.production.read'),
  asyncHandler(async (req: Request, res: Response) => {
    const data = await kitchenWasteService.getById(pool, req.params.id);
    res.json({ success: true, data });
  }),
);

router.post(
  '/waste',
  requirePermission('kitchen.production.create'),
  asyncHandler(async (req: Request, res: Response) => {
    const body = WasteDraftSchema.parse(req.body);
    const data = await kitchenWasteService.createDraft(pool, body, req.user!.id);
    res.status(201).json({ success: true, data });
  }),
);

router.patch(
  '/waste/:id',
  requirePermission('kitchen.production.create'),
  asyncHandler(async (req: Request, res: Response) => {
    const body = WasteDraftSchema.partial().extend({
      lines: z.array(WasteLineSchema).min(1).optional(),
    }).parse(req.body);
    const data = await kitchenWasteService.updateDraft(pool, req.params.id, body);
    res.json({ success: true, data });
  }),
);

router.post(
  '/waste/:id/post',
  requirePermission('kitchen.production.post'),
  asyncHandler(async (req: Request, res: Response) => {
    const data = await kitchenWasteService.post(pool, req.params.id, req.user!.id);
    res.json({ success: true, data });
  }),
);

router.post(
  '/waste/:id/cancel',
  requirePermission('kitchen.production.create'),
  asyncHandler(async (req: Request, res: Response) => {
    const data = await kitchenWasteService.cancelDraft(pool, req.params.id);
    res.json({ success: true, data });
  }),
);

/** Close buffet session with optional leftover waste (Phase 4). */
router.post(
  '/buffet-sessions/:id/close-with-leftovers',
  requirePermission('kitchen.production.post'),
  asyncHandler(async (req: Request, res: Response) => {
    const body = CloseWithLeftoversSchema.parse(req.body ?? {});
    const data = await kitchenWasteService.closeBuffetWithLeftovers(
      pool,
      req.params.id,
      req.user!.id,
      body,
    );
    res.json({ success: true, data });
  }),
);

// ─── Phase 6: Kitchen Ops Hub (central one-shot operations) ─────────────

/** GET /api/kitchen-production/ops/board — day board + recommended next action */
router.get(
  '/ops/board',
  requirePermission('kitchen.production.read'),
  asyncHandler(async (req: Request, res: Response) => {
    const serviceDate =
      typeof req.query.serviceDate === 'string' ? req.query.serviceDate : undefined;
    const data = await kitchenOpsService.getBoard(pool, { serviceDate });
    res.json({ success: true, data });
  }),
);

/** POST /api/kitchen-production/ops/quick-produce — recipe plan + create + post */
router.post(
  '/ops/quick-produce',
  requirePermission('kitchen.production.post'),
  asyncHandler(async (req: Request, res: Response) => {
    const body = z
      .object({
        outputProductId: z.string().uuid(),
        outputQtyBase: z.number().positive(),
        storeLocationId: z.string().uuid().nullable().optional(),
        notes: z.string().max(2000).nullable().optional(),
        productionDate: z.string().optional(),
        lines: z.array(LineSchema).optional(),
      })
      .parse(req.body);
    const data = await kitchenOpsService.quickProduce(pool, body, req.user!.id);
    res.status(201).json({ success: true, data });
  }),
);

/** POST /api/kitchen-production/ops/start-service — create buffet + open */
router.post(
  '/ops/start-service',
  requirePermission('kitchen.production.post'),
  asyncHandler(async (req: Request, res: Response) => {
    const body = BuffetDraftSchema.parse(req.body);
    const data = await kitchenOpsService.startService(pool, body, req.user!.id);
    res.status(201).json({ success: true, data });
  }),
);

/** POST /api/kitchen-production/ops/quick-waste — create + post waste */
router.post(
  '/ops/quick-waste',
  requirePermission('kitchen.production.post'),
  asyncHandler(async (req: Request, res: Response) => {
    const body = WasteDraftSchema.parse(req.body);
    const data = await kitchenOpsService.quickWaste(pool, body, req.user!.id);
    res.status(201).json({ success: true, data });
  }),
);

/** POST /api/kitchen-production/ops/end-service — leftovers + close session */
router.post(
  '/ops/end-service',
  requirePermission('kitchen.production.post'),
  asyncHandler(async (req: Request, res: Response) => {
    const body = z
      .object({
        sessionId: z.string().uuid(),
        leftoverLines: z.array(WasteLineSchema).optional(),
        reason: z
          .enum(['COOKING_LOSS', 'LEFTOVER', 'STAFF_MEAL', 'SPOILAGE', 'OVERPRODUCTION', 'OTHER'])
          .optional(),
        storeLocationId: z.string().uuid().nullable().optional(),
        notes: z.string().max(2000).nullable().optional(),
      })
      .parse(req.body);
    const { sessionId, leftoverLines, reason, storeLocationId, notes } = body;
    const data = await kitchenOpsService.endService(pool, sessionId, req.user!.id, {
      leftoverLines,
      reason,
      storeLocationId,
      notes,
    });
    res.json({ success: true, data });
  }),
);

// ─── Phase 5: Food-cost analytics ───────────────────────────────────────

router.get(
  '/analytics/summary',
  requirePermission('kitchen.production.read'),
  asyncHandler(async (req: Request, res: Response) => {
    const from = typeof req.query.from === 'string' ? req.query.from : undefined;
    const to = typeof req.query.to === 'string' ? req.query.to : undefined;
    const data = await kitchenAnalyticsService.summary(pool, { from, to });
    res.json({ success: true, data });
  }),
);

router.get(
  '/analytics/production-variance',
  requirePermission('kitchen.production.read'),
  asyncHandler(async (req: Request, res: Response) => {
    const from = typeof req.query.from === 'string' ? req.query.from : undefined;
    const to = typeof req.query.to === 'string' ? req.query.to : undefined;
    const data = await kitchenAnalyticsService.productionVariance(pool, { from, to });
    res.json({ success: true, data });
  }),
);

router.get(
  '/analytics/waste',
  requirePermission('kitchen.production.read'),
  asyncHandler(async (req: Request, res: Response) => {
    const from = typeof req.query.from === 'string' ? req.query.from : undefined;
    const to = typeof req.query.to === 'string' ? req.query.to : undefined;
    const data = await kitchenAnalyticsService.wasteBreakdown(pool, { from, to });
    res.json({ success: true, data });
  }),
);

router.get(
  '/analytics/buffet',
  requirePermission('kitchen.production.read'),
  asyncHandler(async (req: Request, res: Response) => {
    const from = typeof req.query.from === 'string' ? req.query.from : undefined;
    const to = typeof req.query.to === 'string' ? req.query.to : undefined;
    const data = await kitchenAnalyticsService.buffetProfitability(pool, { from, to });
    res.json({ success: true, data });
  }),
);

// ─── Store Issue to Expense (ADR-005 INGREDIENT_ISSUE) ───────────────────

const ISSUE_READ = ['kitchen.production.read', 'inventory.read', 'inventory.adjust'] as const;
const ISSUE_CREATE = ['kitchen.production.create', 'inventory.adjust'] as const;
const ISSUE_POST = ['kitchen.production.post', 'inventory.adjust'] as const;
const ISSUE_REVERSE = ['kitchen.production.reverse'] as const;

const IssueLineSchema = z.object({
  productId: z.string().uuid(),
  requestedQtyBase: z.number().positive(),
  issuedQtyBase: z.number().nonnegative(),
  sortOrder: z.number().int().optional(),
  notes: z.string().max(500).nullable().optional(),
  uomId: z.string().uuid().nullable().optional(),
  uomName: z.string().max(64).nullable().optional(),
  conversionFactor: z.number().positive().max(1_000_000).optional(),
});

const IssueDraftSchema = z.object({
  issueDate: z.string().optional(),
  storeLocationId: z.string().uuid().nullable().optional(),
  issuedTo: z.enum(['KITCHEN', 'BAR', 'HOUSEKEEPING', 'OTHER']).optional(),
  requestedByName: z.string().max(120).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  lines: z.array(IssueLineSchema).min(1),
});

router.get(
  '/issues/enabled',
  asyncHandler(async (_req: Request, res: Response) => {
    const enabled = await storeIssueService.isEnabled(pool);
    res.json({ success: true, data: { enabled } });
  }),
);

router.get(
  '/issues/stock-products',
  requireAnyPermission([...ISSUE_READ]),
  asyncHandler(async (req: Request, res: Response) => {
    const search = typeof req.query.search === 'string' ? req.query.search : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const data = await storeIssueService.listStockProducts(pool, { search, limit });
    res.json({ success: true, data });
  }),
);

router.get(
  '/issues/availability',
  requireAnyPermission([...ISSUE_READ]),
  asyncHandler(async (req: Request, res: Response) => {
    const productId = z.string().uuid().parse(req.query.productId);
    const storeLocationId = req.query.storeLocationId
      ? z.string().uuid().parse(req.query.storeLocationId)
      : null;
    const data = await storeIssueService.previewAvailability(pool, productId, storeLocationId);
    res.json({ success: true, data });
  }),
);

router.get(
  '/issues',
  requireAnyPermission([...ISSUE_READ]),
  asyncHandler(async (req: Request, res: Response) => {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const data = await storeIssueService.list(pool, { status, limit });
    res.json({ success: true, data });
  }),
);

router.post(
  '/issues',
  requireAnyPermission([...ISSUE_CREATE]),
  asyncHandler(async (req: Request, res: Response) => {
    const body = IssueDraftSchema.parse(req.body);
    const data = await storeIssueService.createDraft(pool, body, req.user!.id);
    res.status(201).json({ success: true, data });
  }),
);

router.post(
  '/issues/post-now',
  requireAnyPermission([...ISSUE_POST]),
  asyncHandler(async (req: Request, res: Response) => {
    const body = IssueDraftSchema.parse(req.body);
    const data = await storeIssueService.postNow(pool, body, req.user!.id);
    res.status(201).json({ success: true, data });
  }),
);

router.get(
  '/issues/:id',
  requireAnyPermission([...ISSUE_READ]),
  asyncHandler(async (req: Request, res: Response) => {
    const data = await storeIssueService.getById(pool, req.params.id);
    res.json({ success: true, data });
  }),
);

router.patch(
  '/issues/:id',
  requireAnyPermission([...ISSUE_CREATE]),
  asyncHandler(async (req: Request, res: Response) => {
    const body = IssueDraftSchema.partial()
      .extend({
        lines: z.array(IssueLineSchema).min(1).optional(),
      })
      .parse(req.body);
    const data = await storeIssueService.updateDraft(pool, req.params.id, body);
    res.json({ success: true, data });
  }),
);

router.post(
  '/issues/:id/post',
  requireAnyPermission([...ISSUE_POST]),
  asyncHandler(async (req: Request, res: Response) => {
    const data = await storeIssueService.post(pool, req.params.id, req.user!.id);
    res.json({ success: true, data });
  }),
);

router.post(
  '/issues/:id/cancel',
  requireAnyPermission([...ISSUE_CREATE]),
  asyncHandler(async (req: Request, res: Response) => {
    const data = await storeIssueService.cancelDraft(pool, req.params.id);
    res.json({ success: true, data });
  }),
);

const ReverseIssueSchema = z.object({
  reason: z.string().trim().min(STORE_ISSUE_REVERSE_REASON_MIN).max(STORE_ISSUE_REVERSE_REASON_MAX),
});

router.post(
  '/issues/:id/reverse',
  requireAnyPermission([...ISSUE_REVERSE]),
  asyncHandler(async (req: Request, res: Response) => {
    const { reason } = ReverseIssueSchema.parse(req.body ?? {});
    const authz = getAuthorizationService(req);
    const subject = authz.subjectFromUser(req.user);
    const canOverrideFourEyes = subject
      ? await authz.hasPermission(subject, 'inventory.approve')
      : false;
    const data = await storeIssueService.reverse(pool, req.params.id, req.user!.id, {
      reason,
      canOverrideFourEyes,
    });
    res.json({ success: true, data });
  }),
);

export default router;
