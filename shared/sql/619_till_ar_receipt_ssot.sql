-- Migration 619: Till AR collection SSOT
-- POS Cash In → Customer Payment posts TILL_RECEIPT: DR 1010 / CR 1200.
-- Office receipts stay PAYMENT_RECEIPT: DR 1015 / CR 1200.
-- Grant TILL_RECEIPT on till cash and AR so Rule B matches Rule E2.

UPDATE accounts
SET "AllowedSources" = (
  SELECT ARRAY(
    SELECT DISTINCT unnest(
      COALESCE("AllowedSources", ARRAY[]::text[])
      || ARRAY['TILL_RECEIPT']::text[]
    )
  )
)
WHERE "AccountCode" IN ('1010', '1200')
  AND NOT ('TILL_RECEIPT' = ANY(COALESCE("AllowedSources", ARRAY[]::text[])));

INSERT INTO schema_version (version) VALUES (619) ON CONFLICT DO NOTHING;
