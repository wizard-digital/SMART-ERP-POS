import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../rbac/middleware.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { pool as globalPool } from '../../db/pool.js';
import { writeDownNearExpiryLot } from './lotWriteDownService.js';

const router = Router();
router.use(authenticate);

const WriteDownSchema = z.object({
  inventoryBatchId: z.string().uuid(),
  newUnitCost: z.number().positive(),
  memo: z.string().max(2000).optional(),
});

router.post(
  '/',
  requirePermission('inventory.adjust'),
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
