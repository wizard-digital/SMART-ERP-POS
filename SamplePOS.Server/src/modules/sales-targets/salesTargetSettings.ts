/**
 * Feature flag: sales_targets_enabled on system_settings.
 * Default false — tenants that do not want targets see no UI/API surface.
 */

import type { Pool, PoolClient } from 'pg';
import { tableHasColumn } from '../../db/schemaColumnCache.js';

export type DbConn = Pool | PoolClient;

export async function isSalesTargetsEnabled(conn: DbConn): Promise<boolean> {
  const hasFlagColumn = await tableHasColumn(conn, 'system_settings', 'sales_targets_enabled');
  if (!hasFlagColumn) {
    return false;
  }

  const result = await conn.query<{ enabled: boolean }>(
    `SELECT COALESCE(sales_targets_enabled, false) AS enabled
     FROM system_settings
     LIMIT 1`,
  );

  return result.rows[0]?.enabled ?? false;
}
