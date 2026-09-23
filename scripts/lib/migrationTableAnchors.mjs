/**
 * Migration table anchors — JS mirror of migrationAnchors.ts for CLI scripts.
 * Keep logic aligned with SamplePOS.Server/src/modules/system/migrationAnchors.ts
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

export const PLATFORM_MIGRATION_FILES = new Set(['400_multi_tenant.sql']);

export const PLATFORM_TABLES = new Set([
  'tenants',
  'super_admins',
  'tenant_api_keys',
  'sync_ledger',
  'tenant_audit_log',
  'billing_events',
]);

export const MIGRATION_FILE_EXCLUDE = /^999_rollback|^apply-|^fix_|^backfill_/i;
export const NUMBERED_MIGRATION = /^[0-9]{3}_/;

const CREATE_TABLE_IF_NOT_EXISTS =
  /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(?:public\.)?"?([a-z][a-z0-9_]*)"?/gi;
const BARE_CREATE_TABLE = /CREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS)/i;

export function parseIdempotentTablesFromSql(sql) {
  if (BARE_CREATE_TABLE.test(sql)) return null;
  const tables = [];
  CREATE_TABLE_IF_NOT_EXISTS.lastIndex = 0;
  let match;
  while ((match = CREATE_TABLE_IF_NOT_EXISTS.exec(sql)) !== null) {
    const name = match[1];
    if (!PLATFORM_TABLES.has(name)) tables.push(name);
  }
  return tables;
}

export function resolveSqlDir() {
  const candidates = [
    process.env.SQL_DIR,
    path.join(REPO_ROOT, 'shared', 'sql'),
    '/app/shared/sql',
    '/shared/sql',
  ].filter(Boolean);
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  throw new Error(`shared/sql not found. Tried: ${candidates.join(', ')}`);
}

export function buildMigrationTableAnchors(sqlDir = resolveSqlDir()) {
  const anchors = {};
  for (const filename of fs.readdirSync(sqlDir).sort()) {
    if (!filename.endsWith('.sql')) continue;
    if (!NUMBERED_MIGRATION.test(filename)) continue;
    if (MIGRATION_FILE_EXCLUDE.test(filename)) continue;
    if (PLATFORM_MIGRATION_FILES.has(filename)) continue;

    const sql = fs.readFileSync(path.join(sqlDir, filename), 'utf-8');
    const tables = parseIdempotentTablesFromSql(sql);
    if (!tables?.length) continue;
    anchors[filename] = tables;
  }
  return anchors;
}

export function findDriftedMigrationFiles(existingTables, anchors = buildMigrationTableAnchors(), existingViews = new Set()) {
  const drifted = [];
  for (const [filename, requiredTables] of Object.entries(anchors)) {
    if (requiredTables.some((t) => !relationSatisfiesAnchor(t, existingTables, existingViews))) {
      drifted.push(filename);
    }
  }
  return drifted;
}

export const TABLE_SATISFACTION_ALIASES = {
  dist_invoices: ['dist_invoices', 'dist_invoices_legacy'],
  dist_invoice_lines: ['dist_invoice_lines', 'dist_invoice_lines_legacy'],
};

export function relationSatisfiesAnchor(tableName, existingTables, existingViews) {
  const candidates = TABLE_SATISFACTION_ALIASES[tableName] ?? [tableName];
  return candidates.some((name) => existingTables.has(name) || existingViews.has(name));
}

export const TENANT_REQUIRED_TABLES = [
  'users',
  'schema_migrations',
  'schema_version',
  'products',
  'product_inventory',
  'product_valuation',
  'product_categories',
  'product_uoms',
  'uoms',
  'customers',
  'customer_groups',
  'suppliers',
  'sales',
  'sale_items',
  'invoices',
  'invoice_line_items',
  'invoice_payments',
  'purchase_orders',
  'purchase_order_items',
  'goods_receipts',
  'goods_receipt_items',
  'inventory_batches',
  'stock_movements',
  'accounts',
  'ledger_entries',
  'expenses',
  'system_settings',
  'quotations',
  'quotation_items',
  'ar_customer_payments',
  'ar_payment_allocations',
  'delivery_notes',
  'delivery_note_lines',
  'pos_orders',
  'pos_order_items',
  'sale_refunds',
  'sale_refund_items',
  'item_uom_conversions',
  'supplier_invoice_grn_links',
  'import_jobs',
  'cash_registers',
  'cash_register_sessions',
  'cash_register_session_participants',
];
