import type { Pool } from 'pg';
import logger from '../../utils/logger.js';

/**
 * Critical columns every tenant DB must have for core ERP flows.
 * Derived from production reference tenants — catches migration-record drift
 * (migration marked applied but DDL never ran on clone).
 */
export const CRITICAL_SCHEMA_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  customers: [
    'customer_number',
    'customer_group_id',
    'price_group_id',
    'credit_limit',
    'balance',
    'version',
  ],
  products: [
    'base_uom_id',
    'purchase_uom_id',
    'is_taxable',
    'tax_rate',
    'max_stock_level',
    'reorder_point',
    'optimal_stock_level',
  ],
  quotation_items: [
    'uom_id',
    'uom_name',
    'is_taxable',
    'tax_rate',
    'line_total',
  ],
  quotations: [
    'customer_id',
    'customer_name',
    'subtotal',
    'tax_amount',
    'total_amount',
    'content_hash',
  ],
  price_groups: ['pricing_mode'],
  customer_groups: ['default_price_group_id'],
  system_settings: ['pos_session_policy'],
  sales: ['cash_register_session_id'],
  expenses: ['employee_id'],
};

export interface SchemaIntegrityResult {
  ok: boolean;
  missing: Array<{ table: string; column: string }>;
}

export async function verifyTenantSchemaIntegrity(pool: Pool): Promise<SchemaIntegrityResult> {
  const missing: Array<{ table: string; column: string }> = [];

  for (const [table, columns] of Object.entries(CRITICAL_SCHEMA_COLUMNS)) {
    const { rows: tableExists } = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = $1
       ) AS exists`,
      [table]
    );
    if (!tableExists[0]?.exists) {
      for (const column of columns) {
        missing.push({ table, column: `(table missing)` });
      }
      continue;
    }

    const { rows: existingCols } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1`,
      [table]
    );
    const colSet = new Set(existingCols.map((r) => r.column_name));

    for (const column of columns) {
      if (!colSet.has(column)) {
        missing.push({ table, column });
      }
    }
  }

  return { ok: missing.length === 0, missing };
}

export async function assertTenantSchemaIntegrity(pool: Pool, tenantLabel: string): Promise<void> {
  const result = await verifyTenantSchemaIntegrity(pool);
  if (result.ok) return;

  const summary = result.missing
    .slice(0, 12)
    .map((m) => `${m.table}.${m.column}`)
    .join(', ');
  const suffix = result.missing.length > 12 ? ` (+${result.missing.length - 12} more)` : '';

  logger.error(`Schema integrity check failed for "${tenantLabel}"`, {
    missing: result.missing,
  });

  throw new Error(
    `Tenant "${tenantLabel}" database schema incomplete: missing ${summary}${suffix}. ` +
      'Run tenant migrations or schema repair before provisioning.'
  );
}
