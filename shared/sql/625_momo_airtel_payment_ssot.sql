-- ============================================================================
-- Migration: 625_momo_airtel_payment_ssot.sql
-- Platform SSOT: every tenant gets the same MoMo / Airtel Money sale path.
-- No tenant may be "ahead" or "behind" on AIRTEL_MONEY enum, payment_methods,
-- GL 1040, or SALES_INVOICE on liquidity accounts. Idempotent heal.
-- ============================================================================

-- 1. payment_method enum includes AIRTEL_MONEY (MTN = MOBILE_MONEY already)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'AIRTEL_MONEY'
      AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'payment_method')
  ) THEN
    ALTER TYPE payment_method ADD VALUE 'AIRTEL_MONEY';
  END IF;
END $$;

-- 2. Lookup table row (pickers / reports)
INSERT INTO payment_methods (code, name, description, requires_reference)
VALUES ('AIRTEL_MONEY', 'Airtel Money', 'Airtel Money mobile payment', true)
ON CONFLICT (code) DO UPDATE
SET name = EXCLUDED.name,
    description = EXCLUDED.description,
    requires_reference = EXCLUDED.requires_reference;

INSERT INTO payment_methods (code, name, description, requires_reference)
VALUES ('MOBILE_MONEY', 'MTN Mobile Money', 'MTN MoMo mobile payment', true)
ON CONFLICT (code) DO NOTHING;

-- 3. payment_lines CHECK includes AIRTEL_MONEY when a CHECK exists
DO $$
DECLARE
  v_constraint_name TEXT;
BEGIN
  SELECT conname INTO v_constraint_name
  FROM pg_constraint
  WHERE conrelid = 'payment_lines'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%payment_method%';

  IF v_constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE payment_lines DROP CONSTRAINT %I', v_constraint_name);
    ALTER TABLE payment_lines ADD CONSTRAINT payment_lines_payment_method_check
      CHECK (payment_method IN (
        'CASH', 'CARD', 'MOBILE_MONEY', 'AIRTEL_MONEY',
        'CREDIT', 'DEPOSIT', 'BANK_TRANSFER', 'CUSTOMER_CREDIT'
      ));
  END IF;
END $$;

-- 4. Ensure GL 1040 Mobile Money exists and is tagged
INSERT INTO accounts (
  "Id", "AccountCode", "AccountName", "AccountType", "NormalBalance",
  "IsPostingAccount", "IsActive", "Level", "CurrentBalance",
  "AllowManualPosting", "SystemAccountTag", "CreatedAt", "UpdatedAt"
)
SELECT gen_random_uuid(), '1040', 'Mobile Money', 'ASSET', 'DEBIT',
       TRUE, TRUE, 2, 0, TRUE, 'MOBILE_MONEY', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE "AccountCode" = '1040');

UPDATE accounts
SET "AccountName" = COALESCE(NULLIF(TRIM("AccountName"), ''), 'Mobile Money'),
    "AccountType" = 'ASSET',
    "NormalBalance" = 'DEBIT',
    "IsPostingAccount" = TRUE,
    "IsActive" = TRUE,
    "SystemAccountTag" = 'MOBILE_MONEY',
    "UpdatedAt" = CURRENT_TIMESTAMP
WHERE "AccountCode" = '1040';

-- 5. POS liquidity must accept SALES_INVOICE (554 heal — never leave a tenant without it)
UPDATE accounts
SET "AllowedSources" = (
  SELECT ARRAY(
    SELECT DISTINCT unnest(
      COALESCE("AllowedSources", ARRAY[]::text[])
      || ARRAY[
        'SALES_INVOICE',
        'PAYMENT_RECEIPT',
        'PAYMENT_DEPOSIT',
        'SALES_REFUND',
        'EXPENSE_PAYMENT',
        'SUPPLIER_PAYMENT',
        'SYSTEM_CORRECTION'
      ]::text[]
    )
  )
)
WHERE "AccountCode" IN ('1010', '1012', '1020', '1030', '1040')
   OR "SystemAccountTag" IN ('CASH', 'PETTY_CASH', 'BANK', 'CARD_CLEARING', 'MOBILE_MONEY');

-- 6. Banking book for 1040 so sale deposit routing is not tenant-luck
INSERT INTO bank_accounts (
  id, name, account_number, bank_name, branch,
  gl_account_id, current_balance, is_default, is_active,
  created_at, updated_at,
  account_code, account_name, account_type, currency_code,
  opening_balance, is_main_cash, is_main_bank
)
SELECT
  gen_random_uuid(),
  'Mobile Money',
  NULL,
  'Mobile Money',
  NULL,
  a."Id",
  0,
  FALSE,
  TRUE,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP,
  'MOMO-1040',
  'Mobile Money',
  'BANK',
  'UGX',
  0,
  FALSE,
  FALSE
FROM accounts a
WHERE a."AccountCode" = '1040'
  AND NOT EXISTS (
    SELECT 1 FROM bank_accounts ba WHERE ba.gl_account_id = a."Id"
  );

UPDATE bank_accounts ba
SET is_active = TRUE,
    updated_at = CURRENT_TIMESTAMP
FROM accounts a
WHERE a."AccountCode" = '1040'
  AND ba.gl_account_id = a."Id"
  AND ba.is_active IS DISTINCT FROM TRUE;

INSERT INTO schema_version (version)
SELECT 625 WHERE NOT EXISTS (SELECT 1 FROM schema_version WHERE version = 625);
