/**
 * Kitchen / store-issue queries must use the tenant database.
 * Global DATABASE_URL is pos_system (or platform) — restaurant_mode_enabled there
 * is not the operator's store.
 */

import type { Request } from 'express';
import type { Pool } from 'pg';
import { pool as globalPool } from '../../db/pool.js';

export function kitchenDb(req: Request): Pool {
  return (req.tenantPool || globalPool) as Pool;
}
