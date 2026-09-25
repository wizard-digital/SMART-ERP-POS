-- Expense (and any other) reverse posts one REVERSAL journal per original journal,
-- all with ReferenceType = 'REVERSAL' and ReferenceId = the business document.
-- UNIQUE (ReferenceType, ReferenceId) makes the second journal a 23505 / HTTP 409.
-- Migration 017 dropped that constraint. Bliss still had it; other tenants did not,
-- so reverse worked there and failed on Bliss. Idempotency stays UNIQUE (IdempotencyKey).

ALTER TABLE ledger_transactions
  DROP CONSTRAINT IF EXISTS uq_ledger_transactions_reference;

DROP INDEX IF EXISTS uq_ledger_transactions_reference;
DROP INDEX IF EXISTS idx_ledger_transactions_reference_unique;

CREATE INDEX IF NOT EXISTS idx_ledger_transactions_reference
  ON ledger_transactions ("ReferenceType", "ReferenceId");

INSERT INTO schema_version (version)
SELECT 628 WHERE NOT EXISTS (SELECT 1 FROM schema_version WHERE version = 628);
