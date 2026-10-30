/**
 * JS mirror of legacyTriggerPostconditions.ts for CLI audit/heal scripts.
 */

export const LEGACY_TRIGGERS_BY_MIGRATION = {
  '061_drop_disabled_triggers.sql': [
    ['invoices', 'trg_sync_customer_on_invoice'],
    ['invoices', 'trg_post_customer_invoice_to_ledger'],
    ['customer_payments', 'trg_post_customer_payment_to_ledger'],
    ['supplier_invoices', 'trg_sync_supplier_on_invoice'],
  ],
  '063_drop_number_generator_and_balance_sync_triggers.sql': [
    ['delivery_notes', 'trg_generate_delivery_note_number'],
    ['invoice_payments', 'trg_sync_invoice_balance'],
    ['ledger_entries', 'trg_sync_account_balance'],
  ],
  '064_drop_protection_and_validation_triggers.sql': [
    ['invoices', 'trg_protect_paid_invoice'],
    ['expenses', 'trg_protect_paid_expense'],
    ['sales', 'trg_protect_completed_sale'],
    ['invoice_payments', 'trg_prevent_invoice_overpayment'],
  ],
  '065_drop_period_audit_autopopulate_triggers.sql': [
    ['sales', 'trg_enforce_period_sales'],
    ['goods_receipts', 'trg_enforce_period_goods_receipts'],
    ['invoice_payments', 'trg_enforce_period_invoice_payments'],
    ['products', 'trg_product_create_children'],
    ['inventory_batches', 'trg_log_stock_movement'],
  ],
  '638_sale_totals_trigger_ssot.sql': [
    ['sale_items', 'trg_sync_sale_totals'],
  ],
};

export async function legacyTriggersAbsentForMigration(pool, filename) {
  const triggers = LEGACY_TRIGGERS_BY_MIGRATION[filename];
  if (!triggers?.length) return true;

  const tables = triggers.map(([table]) => table);
  const names = triggers.map(([, name]) => name);
  const { rows } = await pool.query(
    `SELECT NOT EXISTS (
        SELECT 1
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND NOT t.tgisinternal
          AND (c.relname, t.tgname) IN (
              SELECT * FROM unnest($1::text[], $2::text[]) AS u(relname, tgname)
          )
    ) AS ok`,
    [tables, names],
  );
  return rows[0]?.ok === true;
}
