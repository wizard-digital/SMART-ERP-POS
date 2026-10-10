-- Migration 635: Expense payment_method optional at prepare
-- Settlement metadata only — unpaid vouchers may leave it NULL;
-- mark-paid derives and stores it from the pay-from account.

ALTER TABLE expenses
  ALTER COLUMN payment_method DROP NOT NULL;

INSERT INTO schema_version (version)
SELECT 635 WHERE NOT EXISTS (SELECT 1 FROM schema_version WHERE version = 635);
