-- Migration 613: Lot write-down — carrying mutation inseparable from posted GL
--
-- Forensic 611+612: POSTED + journal_entry_id IS NULL authorized a cost decrease
-- with no 5140/1300 journal. cost_price increases were also ungoverned.
--
-- Enforcement:
--   1) BEFORE UPDATE: original_cost_price immutable; cost_price may not increase;
--      cost_price may decrease only when a matching POSTED write-down document
--      exists for this lot (previous/new carrying). journal_entry_id may still
--      be NULL mid-transaction (service inserts the document, then journals).
--   2) CONSTRAINT TRIGGER DEFERRABLE INITIALLY DEFERRED on documents:
--      at COMMIT, re-read the row. POSTED documents MUST have a POSTED
--      ledger_transactions row (ReferenceType LOT_WRITE_DOWN, ReferenceId =
--      document id) with DR 5140 = CR 1300 = document.total_amount.
--      Re-read is required: PostgreSQL deferred triggers see NEW from the event,
--      not the final row. Forged POSTED+NULL cannot commit. Happy path sets JE
--      before COMMIT and passes.
--
-- There is no lot write-up document. Arbitrary carrying increases are forbidden.
-- New lots still INSERT with cost_price (original_cost_price := cost_price).

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
     AND NEW.cost_price > OLD.cost_price + 0.0000005 THEN
    RAISE EXCEPTION 'inventory_batches.cost_price cannot increase after lot creation'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW.cost_price IS DISTINCT FROM OLD.cost_price
     AND NEW.cost_price < OLD.cost_price - 0.0000005 THEN
    IF NOT EXISTS (
      SELECT 1
      FROM lot_write_down_documents d
      WHERE d.inventory_batch_id = NEW.id
        AND d.status = 'POSTED'
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

DROP TRIGGER IF EXISTS trg_inventory_batches_carrying_write_down ON inventory_batches;
CREATE TRIGGER trg_inventory_batches_carrying_write_down
  BEFORE INSERT OR UPDATE ON inventory_batches
  FOR EACH ROW
  EXECUTE FUNCTION inventory_batches_carrying_write_down_guard();

CREATE OR REPLACE FUNCTION lot_write_down_posted_requires_journal()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  rec lot_write_down_documents%ROWTYPE;
  je_status TEXT;
  je_ref_type TEXT;
  je_ref_id TEXT;
  debit_5140 NUMERIC;
  credit_1300 NUMERIC;
BEGIN
  SELECT * INTO rec FROM lot_write_down_documents WHERE id = NEW.id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF rec.status IS DISTINCT FROM 'POSTED' THEN
    RETURN NULL;
  END IF;

  IF rec.journal_entry_id IS NULL THEN
    RAISE EXCEPTION 'POSTED lot write-down requires a posted journal'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT lt."Status"::text, lt."ReferenceType"::text, lt."ReferenceId"::text
    INTO je_status, je_ref_type, je_ref_id
  FROM ledger_transactions lt
  WHERE lt."Id" = rec.journal_entry_id;

  IF je_status IS DISTINCT FROM 'POSTED'
     OR je_ref_type IS DISTINCT FROM 'LOT_WRITE_DOWN'
     OR je_ref_id IS DISTINCT FROM CAST(rec.id AS TEXT) THEN
    RAISE EXCEPTION 'lot write-down journal must be POSTED LOT_WRITE_DOWN for this document'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT
    COALESCE(SUM(CASE WHEN a."AccountCode" = '5140' THEN le."DebitAmount" ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN a."AccountCode" = '1300' THEN le."CreditAmount" ELSE 0 END), 0)
  INTO debit_5140, credit_1300
  FROM ledger_entries le
  JOIN accounts a ON a."Id" = le."AccountId"
  WHERE le."TransactionId" = rec.journal_entry_id;

  IF abs(debit_5140 - rec.total_amount) > 0.01
     OR abs(credit_1300 - rec.total_amount) > 0.01 THEN
    RAISE EXCEPTION 'lot write-down journal amounts must equal document total_amount (DR5140/CR1300)'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_lot_write_down_posted_journal ON lot_write_down_documents;
CREATE CONSTRAINT TRIGGER trg_lot_write_down_posted_journal
AFTER INSERT OR UPDATE ON lot_write_down_documents
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION lot_write_down_posted_requires_journal();

COMMENT ON FUNCTION lot_write_down_posted_requires_journal() IS
  'Deferred: POSTED lot write-down documents cannot commit without a matching POSTED 5140/1300 journal.';

INSERT INTO schema_version (version) VALUES (613) ON CONFLICT DO NOTHING;
