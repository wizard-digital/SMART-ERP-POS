-- Migration 643: SAP FD / FOC gift sale on the existing POS sale path.
-- Complimentary goods leave as a SALE (FEFO + receipt). Not Store Issue GI 201.
-- GIFT is a payment method (no duplicate document type). Reason is SAP Grund.

-- 1. payment_method enum
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'GIFT'
      AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'payment_method')
  ) THEN
    ALTER TYPE payment_method ADD VALUE 'GIFT';
  END IF;
END $$;

-- 2. Lookup table (used by some UIs / reports)
INSERT INTO payment_methods (code, name, description, requires_reference)
VALUES ('GIFT', 'Gift (no charge)', 'Complimentary / free-of-charge issue — no tender, no AR', true)
ON CONFLICT (code) DO NOTHING;

-- 3. Widen payment_lines CHECK (if present)
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
        'CASH', 'CARD', 'MOBILE_MONEY', 'AIRTEL_MONEY', 'CREDIT', 'DEPOSIT',
        'BANK_TRANSFER', 'CUSTOMER_CREDIT', 'GIFT'
      ));
  END IF;
END $$;

-- 4. Header reason (SAP Grund)
ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS gift_reason VARCHAR(500) NULL;

ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS gift_amount NUMERIC(15,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN sales.gift_reason IS
  'Mandatory reason when any gift/FOC portion exists (who received it and why). SAP FD Grund analog.';
COMMENT ON COLUMN sales.gift_amount IS
  'FOC remainder (or full sale for a pure gift). Billed revenue = total_amount - gift_amount. Not AR.';

-- 4b. FOC gift (full or remainder) is settled — not AR.
-- amount_paid + gift_amount covers the document; unpaid billed sales still need a customer.
ALTER TABLE sales DROP CONSTRAINT IF EXISTS chk_sales_outstanding_has_customer;
ALTER TABLE sales ADD CONSTRAINT chk_sales_outstanding_has_customer
  CHECK (
    payment_method::text = 'GIFT'
    OR (amount_paid + COALESCE(gift_amount, 0)) >= total_amount
    OR (amount_paid < total_amount AND customer_id IS NOT NULL)
  );

COMMENT ON CONSTRAINT chk_sales_outstanding_has_customer ON sales IS
  'Unpaid billed sales require a customer (AR). Gift remainder is FOC settled — not outstanding.';

-- 5. RBAC — Administrator only (never Manager / Cashier / Accountant)
INSERT INTO rbac_permissions_catalog (key, module, action, description)
VALUES (
  'sales.gift',
  'sales',
  'gift',
  'Issue complimentary (gift / free of charge) sales without tender — Administrator only'
)
ON CONFLICT (key) DO UPDATE SET
  description = EXCLUDED.description;

DELETE FROM rbac_role_permissions rp
USING rbac_roles r
WHERE rp.role_id = r.id
  AND rp.permission_key = 'sales.gift'
  AND LOWER(r.name) NOT IN (
    'administrator', 'admin', 'super admin', 'super administrator'
  );

INSERT INTO rbac_role_permissions (role_id, permission_key, granted_by)
SELECT r.id, p.key, u.id
FROM rbac_roles r
CROSS JOIN (VALUES ('sales.gift')) AS p(key)
CROSS JOIN LATERAL (
  SELECT id FROM users ORDER BY created_at NULLS LAST LIMIT 1
) u
WHERE LOWER(r.name) IN ('administrator', 'admin', 'super admin', 'super administrator')
ON CONFLICT (role_id, permission_key) DO NOTHING;

INSERT INTO schema_version (version) VALUES (643) ON CONFLICT DO NOTHING;
