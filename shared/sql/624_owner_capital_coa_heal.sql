-- 623 stamped before Owner Capital heal finished on some DBs.
-- Idempotent: 3200 = Owner Capital, 3300 = Owner Drawings, categories point there.
-- 3050 stays Opening Balance Equity (openings only).

UPDATE accounts
SET "AccountName" = 'Owner Capital',
    "AccountType" = 'EQUITY',
    "NormalBalance" = 'CREDIT',
    "IsPostingAccount" = TRUE,
    "IsActive" = TRUE,
    "UpdatedAt" = CURRENT_TIMESTAMP
WHERE "AccountCode" = '3200'
  AND "AccountName" IS DISTINCT FROM 'Owner Capital';

INSERT INTO accounts (
  "Id", "AccountCode", "AccountName", "AccountType", "NormalBalance",
  "ParentAccountId", "Level", "IsPostingAccount", "IsActive",
  "CurrentBalance", "CreatedAt", "UpdatedAt"
)
SELECT gen_random_uuid(), '3200', 'Owner Capital', 'EQUITY', 'CREDIT',
       NULL, 1, TRUE, TRUE, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE "AccountCode" = '3200');

INSERT INTO accounts (
  "Id", "AccountCode", "AccountName", "AccountType", "NormalBalance",
  "ParentAccountId", "Level", "IsPostingAccount", "IsActive",
  "CurrentBalance", "CreatedAt", "UpdatedAt"
)
SELECT gen_random_uuid(), '3300', 'Owner Drawings', 'EQUITY', 'DEBIT',
       NULL, 1, TRUE, TRUE, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE "AccountCode" = '3300');

UPDATE accounts
SET "AccountName" = 'Owner Drawings',
    "AccountType" = 'EQUITY',
    "NormalBalance" = 'DEBIT',
    "IsPostingAccount" = TRUE,
    "IsActive" = TRUE,
    "UpdatedAt" = CURRENT_TIMESTAMP
WHERE "AccountCode" = '3300'
  AND "AccountName" IS DISTINCT FROM 'Owner Drawings';

INSERT INTO bank_categories (id, code, name, direction, is_system, display_order)
VALUES
  (gen_random_uuid(), 'OWNER_CAPITAL', 'Owner contribution', 'IN', TRUE, 5),
  (gen_random_uuid(), 'OWNER_DRAWING', 'Owner drawing', 'OUT', TRUE, 105)
ON CONFLICT (code) DO NOTHING;

UPDATE bank_categories c
SET default_account_id = a."Id",
    name = 'Owner contribution'
FROM accounts a
WHERE a."AccountCode" = '3200'
  AND c.code = 'OWNER_CAPITAL';

UPDATE bank_categories c
SET default_account_id = a."Id",
    name = 'Owner drawing'
FROM accounts a
WHERE a."AccountCode" = '3300'
  AND c.code = 'OWNER_DRAWING';

INSERT INTO schema_version (version)
SELECT 624 WHERE NOT EXISTS (SELECT 1 FROM schema_version WHERE version = 624);
