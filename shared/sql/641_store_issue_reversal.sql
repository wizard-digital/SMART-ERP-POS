-- Migration 641: Store issue reversal (SAP GI 202 / B1 Cancel Goods Issue).
-- Posted GI is immutable. Reverse restores FEFO lots and reverses the 5150/1300 journal.

DO $$
BEGIN
  ALTER TYPE movement_type ADD VALUE IF NOT EXISTS 'GOODS_ISSUE_REVERSAL';
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END $$;

CREATE OR REPLACE VIEW inventory_ledger AS
SELECT
  sm.id,
  sm.movement_number,
  sm.product_id,
  sm.batch_id,
  sm.movement_type,
  sm.quantity        AS abs_quantity,
  CASE
    WHEN sm.movement_type::text IN (
      'GOODS_RECEIPT', 'ADJUSTMENT_IN', 'TRANSFER_IN', 'RETURN',
      'PRODUCTION_RECEIPT', 'OPENING_BALANCE', 'GOODS_ISSUE_REVERSAL'
    )
      THEN  sm.quantity
    WHEN sm.movement_type::text IN (
      'SALE', 'ADJUSTMENT_OUT', 'TRANSFER_OUT', 'DAMAGE', 'EXPIRY',
      'PRODUCTION_ISSUE', 'DELIVERY', 'SUPPLIER_RETURN', 'GOODS_ISSUE'
    )
      THEN -sm.quantity
    ELSE sm.quantity
  END                AS signed_quantity,
  sm.unit_cost,
  CASE
    WHEN sm.movement_type::text IN (
      'GOODS_RECEIPT', 'ADJUSTMENT_IN', 'TRANSFER_IN', 'RETURN',
      'PRODUCTION_RECEIPT', 'OPENING_BALANCE', 'GOODS_ISSUE_REVERSAL'
    )
      THEN  sm.quantity * COALESCE(sm.unit_cost, 0)
    WHEN sm.movement_type::text IN (
      'SALE', 'ADJUSTMENT_OUT', 'TRANSFER_OUT', 'DAMAGE', 'EXPIRY',
      'PRODUCTION_ISSUE', 'DELIVERY', 'SUPPLIER_RETURN', 'GOODS_ISSUE'
    )
      THEN -sm.quantity * COALESCE(sm.unit_cost, 0)
    ELSE sm.quantity * COALESCE(sm.unit_cost, 0)
  END                AS signed_value,
  sm.reference_type,
  sm.reference_id,
  sm.notes,
  sm.created_by_id,
  sm.created_at      AS movement_date
FROM stock_movements sm;

COMMENT ON VIEW inventory_ledger IS
  'Signed quantity/value over stock_movements (054 + 587 PRODUCTION_* + 639 GOODS_ISSUE + 641 GOODS_ISSUE_REVERSAL)';

CREATE OR REPLACE FUNCTION fn_ledger_stock_balance(p_product_id UUID)
RETURNS NUMERIC
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(SUM(
    CASE
      WHEN movement_type::text IN (
        'GOODS_RECEIPT','ADJUSTMENT_IN','TRANSFER_IN','RETURN',
        'PRODUCTION_RECEIPT','OPENING_BALANCE','GOODS_ISSUE_REVERSAL'
      ) THEN quantity
      WHEN movement_type::text IN (
        'SALE','ADJUSTMENT_OUT','TRANSFER_OUT','DAMAGE','EXPIRY',
        'PRODUCTION_ISSUE','DELIVERY','SUPPLIER_RETURN','GOODS_ISSUE'
      ) THEN -quantity
      ELSE quantity
    END
  ), 0)
  FROM stock_movements
  WHERE product_id = p_product_id;
$$;

ALTER TABLE store_issue_documents
  DROP CONSTRAINT IF EXISTS store_issue_documents_status_check;

ALTER TABLE store_issue_documents
  ADD CONSTRAINT store_issue_documents_status_check
  CHECK (status IN ('DRAFT', 'POSTED', 'CANCELLED', 'REVERSED'));

ALTER TABLE store_issue_documents
  ADD COLUMN IF NOT EXISTS reversed_by UUID NULL REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS reversal_journal_id UUID NULL;

COMMENT ON COLUMN store_issue_documents.reversal_journal_id IS
  'AccountingCore reversal of the original STORE_ISSUE journal (DR 1300 / CR 5150).';

INSERT INTO schema_version (version) VALUES (641) ON CONFLICT DO NOTHING;
