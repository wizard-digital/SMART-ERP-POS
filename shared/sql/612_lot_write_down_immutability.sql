-- Migration 612: Lot carrying-value write-down — original cost immutability + auditable markdown
--
-- Feature: Lot Carrying-Value Write-Down / Inventory Clearance Markdown (account 5140).
-- Distinct from damage write-off (5120) and expiry write-off (5130).
--
-- Invariants:
--   original_cost_price is set once at INSERT (= acquisition cost_price) and never changes.
--   inventory_batches.cost_price may decrease only when a posted lot_write_down_documents
--   row exists in this transaction (journal_entry_id still NULL — document inserted first).
--   new carrying cost has a governed floor of 0.01 (same cent as POS ±0.01).

CREATE OR REPLACE FUNCTION inventory_batches_carrying_write_down_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.original_cost_price := NEW.cost_price;
    RETURN NEW;
  END IF;

  IF NEW.original_cost_price IS DISTINCT FROM OLD.original_cost_price THEN
    RAISE EXCEPTION 'original_cost_price is immutable after lot creation'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW.cost_price IS DISTINCT FROM OLD.cost_price
     AND NEW.cost_price < OLD.cost_price - 0.0000005 THEN
    IF NOT EXISTS (
      SELECT 1
      FROM lot_write_down_documents d
      WHERE d.inventory_batch_id = NEW.id
        AND d.status = 'POSTED'
        AND d.journal_entry_id IS NULL
        AND abs(d.new_carrying_unit_cost - NEW.cost_price) < 0.0001
        AND abs(d.previous_carrying_unit_cost - OLD.cost_price) < 0.0001
    ) THEN
      RAISE EXCEPTION 'inventory_batches.cost_price may decrease only via a posted lot write-down document'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_inventory_batches_set_original_cost ON inventory_batches;
DROP TRIGGER IF EXISTS trg_inventory_batches_carrying_write_down ON inventory_batches;
CREATE TRIGGER trg_inventory_batches_carrying_write_down
  BEFORE INSERT OR UPDATE ON inventory_batches
  FOR EACH ROW
  EXECUTE FUNCTION inventory_batches_carrying_write_down_guard();

ALTER TABLE lot_write_down_documents
  DROP CONSTRAINT IF EXISTS chk_lot_write_down_new_positive;
ALTER TABLE lot_write_down_documents
  ADD CONSTRAINT chk_lot_write_down_new_positive
  CHECK (new_carrying_unit_cost >= 0.01);

COMMENT ON COLUMN inventory_batches.original_cost_price IS
  'Acquisition / GR unit cost. Immutable after INSERT. cost_price is carrying (1300 + FEFO / POS floor).';

INSERT INTO schema_version (version) VALUES (612) ON CONFLICT DO NOTHING;
