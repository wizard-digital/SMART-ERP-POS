-- Ownership & equity. Sole proprietor remains the default.
-- 3200 Owner Capital, 3300 Owner Drawings, 3050, 3100, and 3000 are not renamed or repurposed.

ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS legal_form VARCHAR(32);
UPDATE system_settings SET legal_form = 'SOLE_PROPRIETOR' WHERE legal_form IS NULL;
ALTER TABLE system_settings ALTER COLUMN legal_form SET DEFAULT 'SOLE_PROPRIETOR';
ALTER TABLE system_settings ALTER COLUMN legal_form SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_system_settings_legal_form'
  ) THEN
    ALTER TABLE system_settings
      ADD CONSTRAINT chk_system_settings_legal_form
      CHECK (legal_form IN ('SOLE_PROPRIETOR', 'COMPANY'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS shareholders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name VARCHAR(255) NOT NULL,
  user_id UUID REFERENCES users(id),
  customer_id UUID REFERENCES customers(id),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID
);

CREATE TABLE IF NOT EXISTS share_classes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(32) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO share_classes (code, name)
SELECT 'ORDINARY', 'Ordinary'
WHERE NOT EXISTS (SELECT 1 FROM share_classes WHERE code = 'ORDINARY');

CREATE TABLE IF NOT EXISTS share_issues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shareholder_id UUID NOT NULL REFERENCES shareholders(id),
  share_class_id UUID NOT NULL REFERENCES share_classes(id),
  quantity NUMERIC(20, 4) NOT NULL CHECK (quantity > 0),
  issue_date DATE NOT NULL,
  consideration_amount NUMERIC(18, 2) NOT NULL DEFAULT 0 CHECK (consideration_amount >= 0),
  consideration_account_code VARCHAR(20),
  status VARCHAR(20) NOT NULL CHECK (status IN ('POSTED', 'CANCELLED')),
  reference TEXT,
  idempotency_key VARCHAR(200) NOT NULL UNIQUE,
  journal_transaction_id UUID,
  authorized_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS share_transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  share_class_id UUID NOT NULL REFERENCES share_classes(id),
  from_shareholder_id UUID NOT NULL REFERENCES shareholders(id),
  to_shareholder_id UUID NOT NULL REFERENCES shareholders(id),
  quantity NUMERIC(20, 4) NOT NULL CHECK (quantity > 0),
  transfer_date DATE NOT NULL,
  reference TEXT,
  reason TEXT,
  idempotency_key VARCHAR(200) NOT NULL UNIQUE,
  authorized_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_share_transfer_distinct CHECK (from_shareholder_id <> to_shareholder_id)
);

CREATE TABLE IF NOT EXISTS share_holdings (
  shareholder_id UUID NOT NULL REFERENCES shareholders(id),
  share_class_id UUID NOT NULL REFERENCES share_classes(id),
  quantity NUMERIC(20, 4) NOT NULL CHECK (quantity >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (shareholder_id, share_class_id)
);

CREATE TABLE IF NOT EXISTS share_ledger_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type VARCHAR(20) NOT NULL CHECK (event_type IN ('ISSUE', 'TRANSFER', 'CANCEL')),
  share_class_id UUID NOT NULL REFERENCES share_classes(id),
  from_shareholder_id UUID REFERENCES shareholders(id),
  to_shareholder_id UUID REFERENCES shareholders(id),
  quantity NUMERIC(20, 4) NOT NULL CHECK (quantity > 0),
  effective_date DATE NOT NULL,
  document_type VARCHAR(20) NOT NULL,
  document_id UUID NOT NULL,
  reference TEXT,
  authorized_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_share_ledger_events_date
  ON share_ledger_events (share_class_id, effective_date, created_at);

CREATE OR REPLACE FUNCTION fn_reject_share_ledger_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'share_ledger_events are immutable';
END;
$$;

DROP TRIGGER IF EXISTS trg_share_ledger_events_immutable ON share_ledger_events;
CREATE TRIGGER trg_share_ledger_events_immutable
  BEFORE UPDATE OR DELETE ON share_ledger_events
  FOR EACH ROW
  EXECUTE FUNCTION fn_reject_share_ledger_mutation();

CREATE TABLE IF NOT EXISTS dividends (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  amount NUMERIC(18, 2) NOT NULL CHECK (amount > 0),
  status VARCHAR(20) NOT NULL CHECK (status IN ('PROPOSED', 'APPROVED', 'DECLARED', 'PAID', 'CANCELLED')),
  proposed_by UUID NOT NULL,
  approved_by UUID,
  cash_account_code VARCHAR(20),
  declaration_journal_id UUID,
  payment_journal_id UUID,
  declare_idempotency_key VARCHAR(200) UNIQUE,
  pay_idempotency_key VARCHAR(200) UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dividend_allocations (
  dividend_id UUID NOT NULL REFERENCES dividends(id),
  shareholder_id UUID NOT NULL REFERENCES shareholders(id),
  shares NUMERIC(20, 4) NOT NULL,
  ownership_percent NUMERIC(12, 4) NOT NULL,
  amount NUMERIC(18, 2) NOT NULL,
  PRIMARY KEY (dividend_id, shareholder_id)
);

CREATE TABLE IF NOT EXISTS shareholder_loans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shareholder_id UUID NOT NULL REFERENCES shareholders(id),
  principal_amount NUMERIC(18, 2) NOT NULL CHECK (principal_amount > 0),
  cash_account_code VARCHAR(20) NOT NULL,
  status VARCHAR(20) NOT NULL CHECK (status IN ('OPEN', 'REPAID')),
  draw_journal_id UUID,
  repay_journal_id UUID,
  draw_idempotency_key VARCHAR(200) NOT NULL UNIQUE,
  repay_idempotency_key VARCHAR(200) UNIQUE,
  authorized_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM accounts
    WHERE "AccountCode" = '3400' AND "AccountName" IS DISTINCT FROM 'Share Capital'
  ) THEN
    RAISE EXCEPTION 'Account 3400 exists and is not Share Capital';
  END IF;
  IF EXISTS (
    SELECT 1 FROM accounts
    WHERE "AccountCode" = '2450' AND "AccountName" IS DISTINCT FROM 'Dividends Payable'
  ) THEN
    RAISE EXCEPTION 'Account 2450 exists and is not Dividends Payable';
  END IF;
  IF EXISTS (
    SELECT 1 FROM accounts
    WHERE "AccountCode" = '2600' AND "AccountName" IS DISTINCT FROM 'Shareholder Loans'
  ) THEN
    RAISE EXCEPTION 'Account 2600 exists and is not Shareholder Loans';
  END IF;
END $$;

-- Same allow-list as migration 550, plus the three ownership tags.
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS chk_system_account_tag;
ALTER TABLE accounts ADD CONSTRAINT chk_system_account_tag CHECK (
  "SystemAccountTag" IS NULL OR "SystemAccountTag" IN (
    'CASH',
    'COGS',
    'INVENTORY',
    'OPENING_BALANCE_EQUITY',
    'UNDEPOSITED_FUNDS',
    'CUSTOMER_DEPOSITS',
    'ACCOUNTS_RECEIVABLE',
    'ACCOUNTS_PAYABLE',
    'BANK',
    'MOBILE_MONEY',
    'CARD_CLEARING',
    'PETTY_CASH',
    'BAD_DEBT_EXPENSE',
    'TAX_PAYABLE',
    'TAX_RECEIVABLE',
    'WHT_PAYABLE',
    'WHT_RECEIVABLE',
    'AP',
    'PAYABLE',
    'GRIR',
    'SUPPLIER_RETURN_CLEARING',
    'SHARE_CAPITAL',
    'DIVIDENDS_PAYABLE',
    'SHAREHOLDER_LOAN'
  )
);

INSERT INTO accounts (
  "Id", "AccountCode", "AccountName", "AccountType", "NormalBalance",
  "ParentAccountId", "Level", "IsPostingAccount", "IsActive",
  "AllowManualPosting", "AllowedSources", "SystemAccountTag",
  "CurrentBalance", "Description", "CreatedAt", "UpdatedAt"
)
SELECT
  gen_random_uuid(), '3400', 'Share Capital', 'EQUITY', 'CREDIT',
  (SELECT "Id" FROM accounts WHERE "AccountCode" = '3000' LIMIT 1),
  1, TRUE, TRUE,
  FALSE, ARRAY['OWNERSHIP_EQUITY']::text[], 'SHARE_CAPITAL',
  0, 'Company share capital. Not owner capital 3200.', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE "AccountCode" = '3400');

INSERT INTO accounts (
  "Id", "AccountCode", "AccountName", "AccountType", "NormalBalance",
  "ParentAccountId", "Level", "IsPostingAccount", "IsActive",
  "AllowManualPosting", "AllowedSources", "SystemAccountTag",
  "CurrentBalance", "Description", "CreatedAt", "UpdatedAt"
)
SELECT
  gen_random_uuid(), '2450', 'Dividends Payable', 'LIABILITY', 'CREDIT',
  (SELECT "Id" FROM accounts WHERE "AccountCode" = '2000' LIMIT 1),
  1, TRUE, TRUE,
  FALSE, ARRAY['OWNERSHIP_EQUITY']::text[], 'DIVIDENDS_PAYABLE',
  0, 'Declared dividends not yet paid. Not trade AP 2100.', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE "AccountCode" = '2450');

INSERT INTO accounts (
  "Id", "AccountCode", "AccountName", "AccountType", "NormalBalance",
  "ParentAccountId", "Level", "IsPostingAccount", "IsActive",
  "AllowManualPosting", "AllowedSources", "SystemAccountTag",
  "CurrentBalance", "Description", "CreatedAt", "UpdatedAt"
)
SELECT
  gen_random_uuid(), '2600', 'Shareholder Loans', 'LIABILITY', 'CREDIT',
  (SELECT "Id" FROM accounts WHERE "AccountCode" = '2000' LIMIT 1),
  1, TRUE, TRUE,
  FALSE, ARRAY['OWNERSHIP_EQUITY']::text[], 'SHAREHOLDER_LOAN',
  0, 'Loans from shareholders. Not owner capital and not GR/IR.', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE "AccountCode" = '2600');

-- Extend existing liquidity allowed-source lists so ownership journals can use cash/bank.
-- Empty lists stay empty so this does not invent a restriction.
UPDATE accounts
SET "AllowedSources" = "AllowedSources" || ARRAY['OWNERSHIP_EQUITY']::text[]
WHERE "IsPostingAccount" = TRUE
  AND "AccountType" = 'ASSET'
  AND "AccountCode" <> '1015'
  AND COALESCE(array_length("AllowedSources", 1), 0) > 0
  AND NOT ('OWNERSHIP_EQUITY' = ANY ("AllowedSources"))
  AND (
    COALESCE("SystemAccountTag", '') IN ('CASH', 'BANK', 'CARD_CLEARING', 'MOBILE_MONEY', 'PETTY_CASH')
    OR "AccountCode" ~ '^10'
  );

INSERT INTO rbac_permissions_catalog (key, module, action, description)
VALUES
  ('ownership.read', 'ownership', 'read', 'View ownership register, holdings, dividends, and shareholder loans'),
  ('ownership.manage', 'ownership', 'manage', 'Set legal form and maintain shareholders'),
  ('ownership.issue', 'ownership', 'issue', 'Issue company shares'),
  ('ownership.transfer', 'ownership', 'transfer', 'Record a private share transfer'),
  ('ownership.dividend_approve', 'ownership', 'dividend_approve', 'Approve or declare a dividend')
ON CONFLICT (key) DO UPDATE SET
  module = EXCLUDED.module,
  action = EXCLUDED.action,
  description = EXCLUDED.description;

INSERT INTO rbac_role_permissions (role_id, permission_key, granted_by)
SELECT r.id, p.key, '00000000-0000-0000-0000-000000000001'
FROM rbac_roles r
JOIN rbac_permissions_catalog p ON p.key LIKE 'ownership.%'
WHERE r.is_system_role = TRUE
  AND r.name IN ('Administrator', 'Super Administrator', 'Manager')
ON CONFLICT (role_id, permission_key) DO NOTHING;

INSERT INTO rbac_role_permissions (role_id, permission_key, granted_by)
SELECT r.id, p.key, '00000000-0000-0000-0000-000000000001'
FROM rbac_roles r
JOIN rbac_permissions_catalog p ON p.key IN (
  'ownership.read', 'ownership.issue', 'ownership.dividend_approve'
)
WHERE r.is_system_role = TRUE AND r.name = 'Accountant'
ON CONFLICT (role_id, permission_key) DO NOTHING;

INSERT INTO rbac_role_permissions (role_id, permission_key, granted_by)
SELECT r.id, 'ownership.read', '00000000-0000-0000-0000-000000000001'
FROM rbac_roles r
WHERE r.is_system_role = TRUE AND r.name = 'Auditor'
ON CONFLICT (role_id, permission_key) DO NOTHING;

-- Ordinary shares are whole units. Scale 4 stores 1.0000, not a fraction.
ALTER TABLE share_issues DROP CONSTRAINT IF EXISTS chk_share_issues_whole_quantity;
ALTER TABLE share_issues ADD CONSTRAINT chk_share_issues_whole_quantity CHECK (quantity = trunc(quantity));
ALTER TABLE share_transfers DROP CONSTRAINT IF EXISTS chk_share_transfers_whole_quantity;
ALTER TABLE share_transfers ADD CONSTRAINT chk_share_transfers_whole_quantity CHECK (quantity = trunc(quantity));
ALTER TABLE share_holdings DROP CONSTRAINT IF EXISTS chk_share_holdings_whole_quantity;
ALTER TABLE share_holdings ADD CONSTRAINT chk_share_holdings_whole_quantity CHECK (quantity = trunc(quantity));
ALTER TABLE share_ledger_events DROP CONSTRAINT IF EXISTS chk_share_events_whole_quantity;
ALTER TABLE share_ledger_events ADD CONSTRAINT chk_share_events_whole_quantity CHECK (quantity = trunc(quantity));
ALTER TABLE dividend_allocations DROP CONSTRAINT IF EXISTS chk_dividend_allocations_whole_shares;
ALTER TABLE dividend_allocations ADD CONSTRAINT chk_dividend_allocations_whole_shares CHECK (shares = trunc(shares));

INSERT INTO schema_version (version)
SELECT 636 WHERE NOT EXISTS (SELECT 1 FROM schema_version WHERE version = 636);
