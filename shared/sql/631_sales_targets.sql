-- Migration 631: Sales Targets (individual salesperson v1)
-- Planning records only. Achievement is computed from posted sales / sale_refunds — never stored as editable SSOT.

CREATE TABLE IF NOT EXISTS sales_targets (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope             VARCHAR(20) NOT NULL DEFAULT 'INDIVIDUAL'
                      CHECK (scope = 'INDIVIDUAL'),
  salesperson_id    UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  period_type       VARCHAR(20) NOT NULL
                      CHECK (period_type IN ('WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY', 'CUSTOM')),
  period_start      DATE NOT NULL,
  period_end        DATE NOT NULL,
  target_amount     DECIMAL(15, 2) NOT NULL CHECK (target_amount > 0),
  status            VARCHAR(20) NOT NULL DEFAULT 'DRAFT'
                      CHECK (status IN (
                        'DRAFT',
                        'PENDING_APPROVAL',
                        'ACTIVE',
                        'CLOSED',
                        'CANCELLED'
                      )),
  created_by        UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  approved_by       UUID NULL REFERENCES users(id) ON DELETE RESTRICT,
  approved_at       TIMESTAMPTZ NULL,
  closed_by         UUID NULL REFERENCES users(id) ON DELETE RESTRICT,
  closed_at         TIMESTAMPTZ NULL,
  cancelled_by      UUID NULL REFERENCES users(id) ON DELETE RESTRICT,
  cancelled_at      TIMESTAMPTZ NULL,
  amendment_reason  TEXT NULL,
  cancel_reason     TEXT NULL,
  notes             TEXT NULL,
  row_version       INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_sales_targets_period CHECK (period_end >= period_start)
);

CREATE INDEX IF NOT EXISTS idx_sales_targets_salesperson_period
  ON sales_targets (salesperson_id, period_start, period_end);

CREATE INDEX IF NOT EXISTS idx_sales_targets_status
  ON sales_targets (status);

CREATE INDEX IF NOT EXISTS idx_sales_targets_created_at
  ON sales_targets (created_at DESC);

-- Overlap uniqueness for live targets is enforced transactionally in the service
-- (range exclusion would require btree_gist; not all tenant DBs enable it).
CREATE INDEX IF NOT EXISTS idx_sales_targets_live_overlap
  ON sales_targets (salesperson_id, period_start, period_end)
  WHERE status IN ('PENDING_APPROVAL', 'ACTIVE');

COMMENT ON TABLE sales_targets IS
  'Individual salesperson sales targets (planning). Achievement derived from sales/sale_refunds.';

COMMENT ON COLUMN sales_targets.target_amount IS
  'Planned target amount in tenant currency (DECIMAL 15,2). Not achievement.';

COMMENT ON COLUMN sales_targets.row_version IS
  'Optimistic concurrency token; increments on every update.';

-- Permissions catalog
INSERT INTO rbac_permissions_catalog (key, module, action, description)
VALUES
  ('targets.read', 'targets', 'read', 'View sales targets and achievement'),
  ('targets.manage', 'targets', 'manage', 'Create, edit, submit, amend, cancel, and close sales targets'),
  ('targets.approve', 'targets', 'approve', 'Approve pending sales targets')
ON CONFLICT (key) DO UPDATE SET
  module = EXCLUDED.module,
  action = EXCLUDED.action,
  description = EXCLUDED.description;

-- Grant to system Manager / Administrator / Super Administrator
INSERT INTO rbac_role_permissions (role_id, permission_key, granted_by)
SELECT r.id, p.perm, '00000000-0000-0000-0000-000000000001'
FROM rbac_roles r
CROSS JOIN (VALUES
  ('targets.read'),
  ('targets.manage'),
  ('targets.approve')
) AS p(perm)
WHERE r.name IN ('Super Administrator', 'Administrator', 'Manager')
  AND r.is_system_role = true
ON CONFLICT (role_id, permission_key) DO NOTHING;

-- Cashiers may read their own targets (list/detail scoped in service)
INSERT INTO rbac_role_permissions (role_id, permission_key, granted_by)
SELECT r.id, 'targets.read', '00000000-0000-0000-0000-000000000001'
FROM rbac_roles r
WHERE r.name = 'Cashier'
  AND r.is_system_role = true
ON CONFLICT (role_id, permission_key) DO NOTHING;

INSERT INTO schema_version (version)
SELECT 631 WHERE NOT EXISTS (SELECT 1 FROM schema_version WHERE version = 631);
