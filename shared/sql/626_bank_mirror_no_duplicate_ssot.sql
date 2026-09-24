-- ============================================================================
-- Migration: 626_bank_mirror_no_duplicate_ssot.sql
-- One bank mirror per expense; one per sale+description. Prevents duplicate register rows.
-- ============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_txn_expense_source_live
  ON bank_transactions (source_id)
  WHERE source_type = 'EXPENSE'
    AND source_id IS NOT NULL
    AND COALESCE(is_reversed, FALSE) = FALSE;

CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_txn_sale_source_desc_live
  ON bank_transactions (source_id, description)
  WHERE source_type = 'SALE'
    AND source_id IS NOT NULL
    AND COALESCE(is_reversed, FALSE) = FALSE;

INSERT INTO schema_version (version)
SELECT 626 WHERE NOT EXISTS (SELECT 1 FROM schema_version WHERE version = 626);
