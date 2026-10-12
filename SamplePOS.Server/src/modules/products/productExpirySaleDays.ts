/**
 * SSOT: products.min_days_before_expiry_sale for FEFO eligibility.
 * Tenants mid-migration without the column → 0 (same as COALESCE default).
 */
import type { Pool, PoolClient } from 'pg';
import { tableHasColumn } from '../../db/schemaColumnCache.js';

type DbConn = Pool | PoolClient;

export async function getProductMinDaysBeforeExpirySale(
  conn: DbConn,
  productId: string,
): Promise<number> {
  const hasCol = await tableHasColumn(conn, 'products', 'min_days_before_expiry_sale');
  if (!hasCol) return 0;

  const res = await conn.query<{ min_days: string | number }>(
    `SELECT COALESCE(min_days_before_expiry_sale, 0) AS min_days
       FROM products WHERE id = $1`,
    [productId],
  );
  return parseInt(String(res.rows[0]?.min_days ?? '0'), 10) || 0;
}
