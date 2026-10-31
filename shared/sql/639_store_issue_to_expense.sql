-- Migration 639: Store Issue to Expense (ADR-005 INGREDIENT_ISSUE)
-- SAP GI 201 / B1 Goods Issue analog: consume listed store SKUs to expense, no BOM.
-- Distinct from sale COGS 5000 and loss 5110/5120/5130/5140.
-- Restaurant mode required at the service layer (not kitchen_production_enabled).

-- ============================================================
-- 1. Movement type (signed OUT)
-- ============================================================
DO $$
BEGIN
  ALTER TYPE movement_type ADD VALUE IF NOT EXISTS 'GOODS_ISSUE';
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
      'PRODUCTION_RECEIPT', 'OPENING_BALANCE'
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
      'PRODUCTION_RECEIPT', 'OPENING_BALANCE'
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
  'Signed quantity/value over stock_movements (054 + 587 PRODUCTION_* + 639 GOODS_ISSUE)';

CREATE OR REPLACE FUNCTION fn_ledger_stock_balance(p_product_id UUID)
RETURNS NUMERIC
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(SUM(
    CASE
      WHEN movement_type::text IN (
        'GOODS_RECEIPT','ADJUSTMENT_IN','TRANSFER_IN','RETURN',
        'PRODUCTION_RECEIPT','OPENING_BALANCE'
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

-- ============================================================
-- 2. Expense account 5150 (intended consumption — not loss, not sale COGS)
-- ============================================================
INSERT INTO accounts (
  "Id", "AccountCode", "AccountName", "AccountType", "NormalBalance",
  "IsPostingAccount", "IsActive", "Level", "CurrentBalance",
  "AllowManualPosting", "Description",
  "CreatedAt", "UpdatedAt"
)
SELECT
  gen_random_uuid(),
  '5150',
  'Internal Inventory Issue',
  'EXPENSE',
  'DEBIT',
  true,
  true,
  2,
  0,
  false,
  'Store issue to expense (SAP GI 201). Intended consumption without BOM. Not sale COGS 5000 and not loss 5110-5140.',
  NOW(),
  NOW()
WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE "AccountCode" = '5150');

UPDATE accounts
SET "AccountName" = 'Internal Inventory Issue',
    "AccountType" = 'EXPENSE',
    "NormalBalance" = 'DEBIT',
    "IsPostingAccount" = true,
    "IsActive" = true,
    "AllowManualPosting" = false,
    "AllowedSources" = (
      SELECT ARRAY(
        SELECT DISTINCT unnest(
          COALESCE(accounts."AllowedSources", ARRAY[]::text[])
          || ARRAY['INVENTORY_MOVE', 'SYSTEM_CORRECTION']::text[]
        )
      )
    ),
    "UpdatedAt" = NOW()
WHERE "AccountCode" = '5150';

-- ============================================================
-- 3. Documents
-- ============================================================
CREATE SEQUENCE IF NOT EXISTS store_issue_document_seq START 1;

CREATE TABLE IF NOT EXISTS store_issue_documents (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_number         VARCHAR(40) NOT NULL,
  document_type           VARCHAR(32) NOT NULL DEFAULT 'INGREDIENT_ISSUE'
    CHECK (document_type IN ('INGREDIENT_ISSUE')),
  posting_intent          VARCHAR(20) NOT NULL DEFAULT 'EXPENSE'
    CHECK (posting_intent IN ('EXPENSE')),
  status                  VARCHAR(20) NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT', 'POSTED', 'CANCELLED')),
  issue_date              DATE NOT NULL DEFAULT (CURRENT_DATE),
  store_location_id       UUID NULL REFERENCES store_locations(id) ON DELETE RESTRICT,
  issued_to               VARCHAR(32) NOT NULL DEFAULT 'KITCHEN'
    CHECK (issued_to IN ('KITCHEN', 'BAR', 'HOUSEKEEPING', 'OTHER')),
  requested_by_name       VARCHAR(120) NULL,
  notes                   TEXT NULL,
  expense_account_code    VARCHAR(20) NOT NULL DEFAULT '5150',
  total_cost              NUMERIC(18, 4) NOT NULL DEFAULT 0,
  journal_entry_id        UUID NULL,
  created_by              UUID NOT NULL REFERENCES users(id),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  posted_by               UUID NULL REFERENCES users(id),
  posted_at               TIMESTAMPTZ NULL,
  cancelled_at            TIMESTAMPTZ NULL,
  row_version             INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT uq_store_issue_documents_number UNIQUE (document_number),
  CONSTRAINT chk_store_issue_expense_account CHECK (expense_account_code = '5150')
);

CREATE INDEX IF NOT EXISTS idx_store_issue_documents_status
  ON store_issue_documents (status, issue_date DESC);
CREATE INDEX IF NOT EXISTS idx_store_issue_documents_store
  ON store_issue_documents (store_location_id)
  WHERE store_location_id IS NOT NULL;

COMMENT ON TABLE store_issue_documents IS
  'ADR-005 INGREDIENT_ISSUE: store goods issue to expense (no BOM). FEFO consume + DR 5150 / CR 1300.';

CREATE TABLE IF NOT EXISTS store_issue_lines (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id          UUID NOT NULL REFERENCES store_issue_documents(id) ON DELETE CASCADE,
  product_id           UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  requested_qty_base   NUMERIC(18, 6) NOT NULL CHECK (requested_qty_base > 0),
  issued_qty_base      NUMERIC(18, 6) NOT NULL CHECK (issued_qty_base >= 0),
  actual_unit_cost     NUMERIC(18, 6) NULL,
  actual_line_cost     NUMERIC(18, 4) NULL,
  sort_order           INTEGER NOT NULL DEFAULT 0,
  notes                TEXT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_store_issue_line UNIQUE (document_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_store_issue_lines_doc
  ON store_issue_lines (document_id, sort_order);

COMMENT ON TABLE store_issue_lines IS
  'Requested vs issued qty. Post consumes issued_qty_base via FEFO (SAP GI actual).';

COMMENT ON COLUMN store_issue_documents.posting_intent IS
  'EXPENSE = consume store stock to 5150. Location transfer is a different document (store transfers).';

INSERT INTO schema_version (version) VALUES (639) ON CONFLICT DO NOTHING;
