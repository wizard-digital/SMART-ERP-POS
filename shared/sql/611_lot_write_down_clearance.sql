-- Migration 611: Near-expiry lot write-down (NRV / clearance markdown)
--
-- Economic event distinct from ADR-004 quarantine/disposal:
--   qty unchanged; carrying cost (inventory_batches.cost_price) falls;
--   original acquisition cost is preserved on original_cost_price;
--   GL: DR 5140 / CR 1300 by remaining_qty × (old carrying − new carrying).
-- POS / FEFO / AT_COST keep using cost_price (now carrying). No till override.

ALTER TABLE inventory_batches
  ADD COLUMN IF NOT EXISTS original_cost_price NUMERIC(15, 6);

COMMENT ON COLUMN inventory_batches.original_cost_price IS
  'Acquisition / GR unit cost. Never overwritten by lot write-down. cost_price is carrying (1300 + FEFO floor).';

UPDATE inventory_batches
SET original_cost_price = cost_price
WHERE original_cost_price IS NULL
  AND cost_price IS NOT NULL;

CREATE OR REPLACE FUNCTION inventory_batches_set_original_cost()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.original_cost_price IS NULL THEN
    NEW.original_cost_price := NEW.cost_price;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_inventory_batches_set_original_cost ON inventory_batches;
CREATE TRIGGER trg_inventory_batches_set_original_cost
  BEFORE INSERT ON inventory_batches
  FOR EACH ROW
  EXECUTE FUNCTION inventory_batches_set_original_cost();

CREATE SEQUENCE IF NOT EXISTS lot_write_down_document_seq START 1;

CREATE TABLE IF NOT EXISTS lot_write_down_documents (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_number             VARCHAR(40) NOT NULL,
    status                      VARCHAR(20) NOT NULL DEFAULT 'POSTED'
        CHECK (status IN ('DRAFT', 'POSTED', 'REVERSED', 'CANCELLED')),
    reason                      VARCHAR(40) NOT NULL DEFAULT 'NEAR_EXPIRY'
        CHECK (reason = 'NEAR_EXPIRY'),
    product_id                 UUID NOT NULL REFERENCES products(id),
    inventory_batch_id         UUID NOT NULL REFERENCES inventory_batches(id),
    quantity                    NUMERIC(15, 4) NOT NULL,
    original_unit_cost         NUMERIC(15, 6) NOT NULL,
    previous_carrying_unit_cost NUMERIC(15, 6) NOT NULL,
    new_carrying_unit_cost      NUMERIC(15, 6) NOT NULL,
    total_amount                NUMERIC(18, 2) NOT NULL DEFAULT 0,
    expense_account_code        VARCHAR(20) NOT NULL DEFAULT '5140',
    days_until_expiry           INTEGER,
    memo                        TEXT,
    journal_entry_id           UUID,
    created_by                  UUID NOT NULL REFERENCES users(id),
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    posted_at                   TIMESTAMPTZ,
    reverses_document_id        UUID REFERENCES lot_write_down_documents(id),
    reversed_by_document_id    UUID REFERENCES lot_write_down_documents(id),
    row_version                  INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT uq_lot_write_down_documents_number UNIQUE (document_number),
    CONSTRAINT chk_lot_write_down_new_below_previous
      CHECK (new_carrying_unit_cost < previous_carrying_unit_cost),
    CONSTRAINT chk_lot_write_down_new_positive
      CHECK (new_carrying_unit_cost > 0),
    CONSTRAINT chk_lot_write_down_qty_positive
      CHECK (quantity > 0)
);

CREATE INDEX IF NOT EXISTS idx_lot_write_down_documents_batch
    ON lot_write_down_documents (inventory_batch_id);
CREATE INDEX IF NOT EXISTS idx_lot_write_down_documents_status
    ON lot_write_down_documents (status);

COMMENT ON TABLE lot_write_down_documents IS
  'Near-expiry NRV write-down: revalues sellable lot carrying cost; does not consume qty; not DAMAGE/EXPIRY disposal.';

INSERT INTO accounts (
  "Id", "AccountCode", "AccountName", "AccountType", "NormalBalance",
  "IsPostingAccount", "IsActive", "Level", "CurrentBalance",
  "AllowManualPosting", "Description",
  "CreatedAt", "UpdatedAt"
)
SELECT
  gen_random_uuid(),
  '5140',
  'Inventory Clearance Markdown',
  'EXPENSE',
  'DEBIT',
  true,
  true,
  2,
  0,
  false,
  'Near-expiry lot write-down (NRV). Distinct from 5130 expiry dispose and 5120 damage dispose.',
  NOW(),
  NOW()
WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE "AccountCode" = '5140');

UPDATE accounts
SET "AccountName" = 'Inventory Clearance Markdown',
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
WHERE "AccountCode" = '5140';

INSERT INTO schema_version (version) VALUES (611) ON CONFLICT DO NOTHING;
