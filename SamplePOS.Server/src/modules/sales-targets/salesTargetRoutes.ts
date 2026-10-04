/**
 * Sales Targets API — /api/sales-targets
 */

import { Router } from 'express';
import type { Request } from 'express';
import { authenticate } from '../../middleware/auth.js';
import {
  requirePermission,
  requireAnyPermission,
  getRbacService,
} from '../../rbac/middleware.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { pool as globalPool } from '../../db/pool.js';
import { legacyRoleGrantsPermission } from '@shared/authorization/legacyRoleFallback.js';
import {
  AmendSalesTargetSchema,
  CancelSalesTargetSchema,
  CreateSalesTargetSchema,
  CreateSalesTargetTeamSchema,
  ListSalesTargetsQuerySchema,
  RowVersionSchema,
  UpdateDraftSalesTargetSchema,
  UpdateSalesTargetTeamSchema,
} from '@shared/zod/salesTarget.js';
import { salesTargetService, type ActorContext } from './salesTargetService.js';
import { isSalesTargetsEnabled } from './salesTargetSettings.js';

const router = Router();
router.use(authenticate);

const TARGET_PERMS = ['targets.read', 'targets.manage', 'targets.approve'] as const;

function poolOf(req: Request) {
  return req.tenantPool || globalPool;
}

/** Block module routes when tenant flag is off (except GET /enabled). */
async function requireSalesTargetsEnabled(
  req: Request,
  res: import('express').Response,
  next: import('express').NextFunction,
): Promise<void> {
  try {
    const enabled = await isSalesTargetsEnabled(poolOf(req));
    if (!enabled) {
      res.status(403).json({
        success: false,
        error:
          'Sales Targets is disabled for this tenant. Enable it in Settings → System.',
        error_code: 'ERR_SALES_TARGETS_DISABLED',
      });
      return;
    }
    next();
  } catch (err) {
    next(err);
  }
}

async function actorOf(req: Request): Promise<ActorContext> {
  let permissionKeys: string[] = [];
  if (req.authContext?.permissions?.size) {
    permissionKeys = Array.from(req.authContext.permissions);
  } else if (req.user?.id) {
    try {
      const service = getRbacService(req);
      const effective = await service.getUserEffectivePermissions(req.user.id);
      permissionKeys = effective.map((p) => p.permissionKey);
    } catch {
      permissionKeys = [];
    }
  }

  if (permissionKeys.length === 0 && req.user?.role) {
    permissionKeys = TARGET_PERMS.filter((k) =>
      legacyRoleGrantsPermission(req.user!.role, k),
    );
  }

  return {
    userId: req.user!.id,
    userName: req.user!.fullName ?? req.user!.email ?? null,
    userRole: req.user!.role ?? null,
    permissionKeys,
    ipAddress: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
    sessionId: (req as Request & { sessionId?: string }).sessionId ?? null,
    requestId: (req as Request & { requestId?: string }).requestId ?? null,
  };
}

/**
 * GET /api/sales-targets/enabled
 * Readable without targets.* so Layout / Sales strip can hide when flag-off.
 */
router.get(
  '/enabled',
  asyncHandler(async (req, res) => {
    const enabled = await isSalesTargetsEnabled(poolOf(req));
    res.json({ success: true, data: { enabled } });
  }),
);

router.use(requireSalesTargetsEnabled);

router.get(
  '/',
  requireAnyPermission(['targets.read', 'targets.manage', 'targets.approve']),
  asyncHandler(async (req, res) => {
    const parsed = ListSalesTargetsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: 'Invalid query',
        details: parsed.error.flatten(),
      });
    }
    const data = await salesTargetService.list(poolOf(req), await actorOf(req), parsed.data);
    res.json({ success: true, data: data.rows, pagination: { total: data.total, page: data.page, limit: data.limit } });
  }),
);

/** KPI strip — must be registered before /:id */
router.get(
  '/progress',
  requireAnyPermission(['targets.read', 'targets.manage', 'targets.approve']),
  asyncHandler(async (req, res) => {
    const salespersonId =
      typeof req.query.salespersonId === 'string' ? req.query.salespersonId : undefined;
    const asOfDate = typeof req.query.asOfDate === 'string' ? req.query.asOfDate : undefined;
    const data = await salesTargetService.getProgress(poolOf(req), await actorOf(req), {
      salespersonId,
      asOfDate,
    });
    res.json({ success: true, data });
  }),
);

router.get(
  '/teams',
  requireAnyPermission(['targets.read', 'targets.manage', 'targets.approve']),
  asyncHandler(async (req, res) => {
    const data = await salesTargetService.listTeams(poolOf(req), await actorOf(req));
    res.json({ success: true, data });
  }),
);

router.post(
  '/teams',
  requirePermission('targets.manage'),
  asyncHandler(async (req, res) => {
    const parsed = CreateSalesTargetTeamSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: 'Invalid body',
        details: parsed.error.flatten(),
      });
    }
    const data = await salesTargetService.createTeam(poolOf(req), await actorOf(req), parsed.data);
    res.status(201).json({ success: true, data });
  }),
);

router.patch(
  '/teams/:teamId',
  requirePermission('targets.manage'),
  asyncHandler(async (req, res) => {
    const parsed = UpdateSalesTargetTeamSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: 'Invalid body',
        details: parsed.error.flatten(),
      });
    }
    const data = await salesTargetService.updateTeam(
      poolOf(req),
      await actorOf(req),
      req.params.teamId,
      parsed.data,
    );
    res.json({ success: true, data });
  }),
);

router.post(
  '/',
  requirePermission('targets.manage'),
  asyncHandler(async (req, res) => {
    const parsed = CreateSalesTargetSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: 'Invalid body',
        details: parsed.error.flatten(),
      });
    }
    const data = await salesTargetService.create(poolOf(req), await actorOf(req), parsed.data);
    res.status(201).json({ success: true, data });
  }),
);

router.get(
  '/:id',
  requireAnyPermission(['targets.read', 'targets.manage', 'targets.approve']),
  asyncHandler(async (req, res) => {
    const data = await salesTargetService.getById(poolOf(req), await actorOf(req), req.params.id);
    res.json({ success: true, data });
  }),
);

router.patch(
  '/:id',
  requirePermission('targets.manage'),
  asyncHandler(async (req, res) => {
    const parsed = UpdateDraftSalesTargetSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: 'Invalid body',
        details: parsed.error.flatten(),
      });
    }
    const { salespersonId, teamId: _teamId, ...rest } = parsed.data;
    const data = await salesTargetService.updateDraft(
      poolOf(req),
      await actorOf(req),
      req.params.id,
      {
        ...rest,
        // Service/repo accept string | undefined; Zod allows null to clear omission
        salespersonId: salespersonId ?? undefined,
      },
    );
    res.json({ success: true, data });
  }),
);

router.post(
  '/:id/submit',
  requirePermission('targets.manage'),
  asyncHandler(async (req, res) => {
    const parsed = RowVersionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: 'Invalid body',
        details: parsed.error.flatten(),
      });
    }
    const data = await salesTargetService.submit(
      poolOf(req),
      await actorOf(req),
      req.params.id,
      parsed.data.rowVersion,
    );
    res.json({ success: true, data });
  }),
);

router.post(
  '/:id/approve',
  requirePermission('targets.approve'),
  asyncHandler(async (req, res) => {
    const parsed = RowVersionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: 'Invalid body',
        details: parsed.error.flatten(),
      });
    }
    const data = await salesTargetService.approve(
      poolOf(req),
      await actorOf(req),
      req.params.id,
      parsed.data.rowVersion,
    );
    res.json({ success: true, data });
  }),
);

router.post(
  '/:id/amend',
  requireAnyPermission(['targets.manage', 'targets.approve']),
  asyncHandler(async (req, res) => {
    const parsed = AmendSalesTargetSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: 'Invalid body',
        details: parsed.error.flatten(),
      });
    }
    const data = await salesTargetService.amend(
      poolOf(req),
      await actorOf(req),
      req.params.id,
      parsed.data,
    );
    res.json({ success: true, data });
  }),
);

router.post(
  '/:id/cancel',
  requireAnyPermission(['targets.manage', 'targets.approve']),
  asyncHandler(async (req, res) => {
    const parsed = CancelSalesTargetSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: 'Invalid body',
        details: parsed.error.flatten(),
      });
    }
    const data = await salesTargetService.cancel(
      poolOf(req),
      await actorOf(req),
      req.params.id,
      parsed.data,
    );
    res.json({ success: true, data });
  }),
);

router.post(
  '/:id/close',
  requireAnyPermission(['targets.manage', 'targets.approve']),
  asyncHandler(async (req, res) => {
    const parsed = RowVersionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: 'Invalid body',
        details: parsed.error.flatten(),
      });
    }
    const data = await salesTargetService.close(
      poolOf(req),
      await actorOf(req),
      req.params.id,
      parsed.data.rowVersion,
    );
    res.json({ success: true, data });
  }),
);

router.get(
  '/:id/achievement',
  requireAnyPermission(['targets.read', 'targets.manage', 'targets.approve']),
  asyncHandler(async (req, res) => {
    const data = await salesTargetService.getAchievementBreakdown(
      poolOf(req),
      await actorOf(req),
      req.params.id,
    );
    res.json({ success: true, data });
  }),
);

export { router as salesTargetRoutes };
