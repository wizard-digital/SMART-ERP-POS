-- ============================================================================
-- Migration: 627_tenant_banking_momo_column_ssot.sql
-- Fail-closed: every tenant has the same banking / MoMo columns.
-- Missing-column drift (Bliss/Dynamics) is healed — never left as a special case.
-- ============================================================================

-- payment_methods (013 may exist without later columns on poisoned clones)
CREATE TABLE IF NOT EXISTS payment_methods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(50) UNIQUE NOT NULL,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  is_active BOOLEAN DEFAULT true,
  requires_reference BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE payment_methods ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE payment_methods ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;
ALTER TABLE payment_methods ADD COLUMN IF NOT EXISTS requires_reference BOOLEAN DEFAULT false;
ALTER TABLE payment_methods ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE payment_methods ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- bank_accounts — columns used by ensureDepositLiquidityBook + 625 MoMo book insert
CREATE TABLE IF NOT EXISTS bank_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  account_number VARCHAR(50),
  bank_name VARCHAR(100),
  branch VARCHAR(100),
  gl_account_id UUID REFERENCES accounts("Id"),
  current_balance NUMERIC(18,2) DEFAULT 0,
  is_default BOOLEAN DEFAULT FALSE,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS gl_account_id UUID;
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS current_balance NUMERIC(18,2) DEFAULT 0;
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS is_default BOOLEAN DEFAULT FALSE;
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS account_code VARCHAR(50);
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS account_name VARCHAR(100);
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS account_type VARCHAR(20) DEFAULT 'BANK';
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS currency_code VARCHAR(3) DEFAULT 'UGX';
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS opening_balance NUMERIC(18,2) DEFAULT 0;
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS is_main_cash BOOLEAN DEFAULT FALSE;
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS is_main_bank BOOLEAN DEFAULT FALSE;
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS branch VARCHAR(100);
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS bank_name VARCHAR(100);
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS account_number VARCHAR(50);

-- bank_transactions — columns used by sale/expense bank mirrors (no second GL)
CREATE TABLE IF NOT EXISTS bank_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_number VARCHAR(50) NOT NULL,
  bank_account_id UUID NOT NULL,
  transaction_date DATE NOT NULL,
  type VARCHAR(20) NOT NULL,
  category_id UUID,
  description VARCHAR(500) NOT NULL,
  reference VARCHAR(100),
  amount NUMERIC(18,2) NOT NULL,
  contra_account_id UUID,
  gl_transaction_id UUID,
  source_type VARCHAR(50),
  source_id UUID,
  is_reconciled BOOLEAN DEFAULT FALSE,
  is_reversed BOOLEAN DEFAULT FALSE,
  created_by VARCHAR(100),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS category_id UUID;
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS reference VARCHAR(100);
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS contra_account_id UUID;
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS gl_transaction_id UUID;
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS source_type VARCHAR(50);
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS source_id UUID;
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS is_reconciled BOOLEAN DEFAULT FALSE;
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS is_reversed BOOLEAN DEFAULT FALSE;
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ;
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS reversed_by VARCHAR(100);
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS reversal_reason VARCHAR(500);
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS created_by VARCHAR(100);
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

-- bank_categories used by mirrors
CREATE TABLE IF NOT EXISTS bank_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(50) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  direction VARCHAR(10) NOT NULL DEFAULT 'OUT',
  default_account_id UUID,
  is_system BOOLEAN DEFAULT FALSE,
  is_active BOOLEAN DEFAULT TRUE,
  display_order INT DEFAULT 100,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO bank_categories (id, code, name, direction, is_system, display_order)
VALUES
  (gen_random_uuid(), 'SALES_DEPOSIT', 'Sales Deposit', 'IN', TRUE, 10),
  (gen_random_uuid(), 'EXPENSE_PAYMENT', 'Expense Payment', 'OUT', TRUE, 120)
ON CONFLICT (code) DO NOTHING;

-- accounts columns required for MoMo AllowedSources / tags (Rule B)
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS "AllowedSources" TEXT[];
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS "SystemAccountTag" VARCHAR(50);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS "AllowManualPosting" BOOLEAN DEFAULT TRUE;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS "IsPostingAccount" BOOLEAN DEFAULT TRUE;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS "IsActive" BOOLEAN DEFAULT TRUE;

-- MoMo / Airtel payment method + 1040 (idempotent; same as 625)
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

INSERT INTO payment_methods (code, name, description, requires_reference)
VALUES ('AIRTEL_MONEY', 'Airtel Money', 'Airtel Money mobile payment', true)
ON CONFLICT (code) DO UPDATE
SET name = EXCLUDED.name,
    description = EXCLUDED.description,
    requires_reference = EXCLUDED.requires_reference;

INSERT INTO payment_methods (code, name, description, requires_reference)
VALUES ('MOBILE_MONEY', 'MTN Mobile Money', 'MTN MoMo mobile payment', true)
ON CONFLICT (code) DO NOTHING;

INSERT INTO accounts (
  "Id", "AccountCode", "AccountName", "AccountType", "NormalBalance",
  "IsPostingAccount", "IsActive", "Level", "CurrentBalance",
  "AllowManualPosting", "SystemAccountTag", "CreatedAt", "UpdatedAt"
)
SELECT gen_random_uuid(), '1040', 'Mobile Money', 'ASSET', 'DEBIT',
       TRUE, TRUE, 2, 0, TRUE, 'MOBILE_MONEY', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE "AccountCode" = '1040');

UPDATE accounts
SET "SystemAccountTag" = COALESCE(NULLIF(TRIM("SystemAccountTag"), ''), 'MOBILE_MONEY'),
    "IsPostingAccount" = TRUE,
    "IsActive" = TRUE,
    "UpdatedAt" = CURRENT_TIMESTAMP
WHERE "AccountCode" = '1040';

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

-- No-duplicate live mirrors (626) — re-assert after column heal
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
SELECT 627 WHERE NOT EXISTS (SELECT 1 FROM schema_version WHERE version = 627);
