/**
 * JS mirror of migrationPostconditions.ts for CLI audit/heal scripts.
 */

import { legacyTriggersAbsentForMigration } from './legacyTriggerPostconditions.mjs';

export const MIGRATION_POSTCONDITION_FILES = [
  '061_drop_disabled_triggers.sql',
  '063_drop_number_generator_and_balance_sync_triggers.sql',
  '064_drop_protection_and_validation_triggers.sql',
  '065_drop_period_audit_autopopulate_triggers.sql',
  '638_sale_totals_trigger_ssot.sql',
  '417_customer_opening_balance.sql',
  '20251118_create_stock_counts.sql',
  '20260616_cutover_accounting.sql',
  '524_relax_ledger_entries_constraints.sql',
];

async function constraintDefIncludes(pool, tableName, constraintName, needle) {
  const { rows } = await pool.query(
    `SELECT EXISTS (
        SELECT 1
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid AND t.relname = $1
        WHERE c.conname = $2
          AND pg_get_constraintdef(c.oid) ILIKE $3
    ) AS ok`,
    [tableName, constraintName, `%${needle}%`],
  );
  return rows[0]?.ok === true;
}

async function accountAllowsSource(pool, accountCode, source) {
  const { rows } = await pool.query(
    `SELECT EXISTS (
        SELECT 1 FROM accounts
        WHERE "AccountCode" = $1
          AND $2 = ANY(COALESCE("AllowedSources", '{}'::text[]))
    ) AS ok`,
    [accountCode, source],
  );
  return rows[0]?.ok === true;
}

async function tableExists(pool, tableName) {
  const { rows } = await pool.query(
    `SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = $1
    ) AS ok`,
    [tableName],
  );
  return rows[0]?.ok === true;
}

async function columnIsNullable(pool, tableName, columnName) {
  const { rows } = await pool.query(
    `SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = $1
          AND column_name = $2
          AND is_nullable = 'YES'
    ) AS ok`,
    [tableName, columnName],
  );
  return rows[0]?.ok === true;
}

export async function verifyMigrationPostcondition(pool, filename) {
  switch (filename) {
    case '061_drop_disabled_triggers.sql':
    case '063_drop_number_generator_and_balance_sync_triggers.sql':
    case '064_drop_protection_and_validation_triggers.sql':
    case '065_drop_period_audit_autopopulate_triggers.sql':
    case '638_sale_totals_trigger_ssot.sql':
      return legacyTriggersAbsentForMigration(pool, filename);
    case '20251118_create_stock_counts.sql': {
      const [counts, lines] = await Promise.all([
        tableExists(pool, 'stock_counts'),
        tableExists(pool, 'stock_count_lines'),
      ]);
      return counts && lines;
    }
    case '417_customer_opening_balance.sql': {
      const [docOk, arOk] = await Promise.all([
        constraintDefIncludes(
          pool,
          'invoices',
          'chk_invoices_document_type',
          'OPENING_BALANCE',
        ),
        accountAllowsSource(pool, '1200', 'CUTOVER_OB'),
      ]);
      return docOk && arOk;
    }
    case '20260616_cutover_accounting.sql': {
      const { rows: tableExistsRows } = await pool.query(
        `SELECT EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = 'supplier_invoices'
        ) AS ok`,
      );
      if (!tableExistsRows[0]?.ok) return true;

      const [docOk, apOk, equityOk] = await Promise.all([
        constraintDefIncludes(
          pool,
          'supplier_invoices',
          'chk_supplier_invoices_document_type',
          'OPENING_BALANCE',
        ),
        accountAllowsSource(pool, '2100', 'CUTOVER_OB'),
        accountAllowsSource(pool, '3050', 'CUTOVER_OB'),
      ]);
      return docOk && apOk && equityOk;
    }
    case '524_relax_ledger_entries_constraints.sql':
      return columnIsNullable(pool, 'ledger_entries', 'LedgerTransactionId');
    default:
      return true;
  }
}

export async function findPostconditionDriftedMigrationFiles(pool) {
  const drifted = [];
  for (const filename of MIGRATION_POSTCONDITION_FILES) {
    if (!(await verifyMigrationPostcondition(pool, filename))) {
      drifted.push(filename);
    }
  }
  return drifted;
}
