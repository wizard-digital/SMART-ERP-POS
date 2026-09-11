import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/auth.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { pool as globalPool } from '../../db/pool.js';
import {
  canPerformLotWriteDown,
  ERR_LOT_WRITE_DOWN_ADMIN_ONLY,
  lotWriteDownAdminDeniedMessage,
} from '@shared/inventory-lot/lotWriteDown.js';
import { writeDownNearExpiryLot } from './lotWriteDownService.js';

const router = Router();
router.use(authenticate);

const WriteDownSchema = z.object({
  inventoryBatchId: z.string().uuid(),
  newUnitCost: z.number().positive(),
  memo: z.string().max(2000).optional(),
});

/**
 * ADMIN-only gate for clearance markdown.
 * Does NOT use inventory.adjust — managers/cashiers with adjust cannot bypass.
 * Prefers users.role from DB; falls back to JWT role only if DB row missing.
 */
async function requireLotWriteDownAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!req.user?.id) {
    res.status(401).json({ success: false, error: 'Authentication required' });
    return;
  }
  const pool = req.tenantPool || globalPool;
  let actorRole: string | null | undefined = req.user.role;
  try {
    const roleRes = await pool.query<{ role: string | null }>(
      `SELECT role FROM users WHERE id = $1`,
      [req.user.id],
    );
    if (roleRes.rows[0]) {
      actorRole = roleRes.rows[0].role;
    }
  } catch {
    // Keep JWT role fallback if users table unavailable mid-migration.
  }
  if (!canPerformLotWriteDown(actorRole)) {
    res.status(403).json({
      success: false,
      error: lotWriteDownAdminDeniedMessage(),
      code: ERR_LOT_WRITE_DOWN_ADMIN_ONLY,
      requiresAdmin: true,
    });
    return;
  }
  next();
}

router.post(
  '/',
  requireLotWriteDownAdmin,
  asyncHandler(async (req, res) => {
    const pool = req.tenantPool || globalPool;
    const body = WriteDownSchema.parse(req.body);
    const data = await writeDownNearExpiryLot(pool, {
      inventoryBatchId: body.inventoryBatchId,
      newUnitCost: body.newUnitCost,
      memo: body.memo,
      userId: req.user!.id,
    });
    res.status(201).json({ success: true, data });
  }),
);

export const lotWriteDownRoutes = router;
