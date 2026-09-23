-- Expense reversal SSOT: posted APPROVED / PAID expenses reverse via
-- AccountingCore.reverseTransaction (opposite GL, original immutable).
-- Transaction is owned by tenantMigrationService / migrate.mjs.

ALTER TABLE expenses
  ADD COLUMN IF NOT EXISTS reversed_by UUID,
  ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reversal_reason TEXT;

ALTER TABLE expenses DROP CONSTRAINT IF EXISTS expenses_status_check;
ALTER TABLE expenses ADD CONSTRAINT expenses_status_check
  CHECK (status IN (
    'DRAFT',
    'PENDING_APPROVAL',
    'APPROVED',
    'REJECTED',
    'PAID',
    'CANCELLED',
    'REVERSED'
  ));

INSERT INTO schema_version (version)
SELECT 622 WHERE NOT EXISTS (SELECT 1 FROM schema_version WHERE version = 622);
