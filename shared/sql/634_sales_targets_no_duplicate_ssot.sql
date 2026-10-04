-- Migration 634: Sales Targets anti-duplicate / SSOT hardening
-- - Case-insensitive unique team names (no "Cashiers" / "cashiers" twins)
-- - Live overlap remains enforced in service under advisory xact locks
--   (range exclusion needs btree_gist; not assumed on all tenants)

ALTER TABLE sales_target_teams
  DROP CONSTRAINT IF EXISTS uq_sales_target_teams_name;

CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_target_teams_name_ci
  ON sales_target_teams (lower(btrim(name)));

COMMENT ON INDEX uq_sales_target_teams_name_ci IS
  'SSOT: one team name per tenant (case/whitespace insensitive).';

-- Helpful lookup for live individual windows (overlap still service-locked)
CREATE INDEX IF NOT EXISTS idx_sales_targets_individual_live
  ON sales_targets (salesperson_id, period_start, period_end)
  WHERE status IN ('PENDING_APPROVAL', 'ACTIVE') AND scope = 'INDIVIDUAL';

CREATE INDEX IF NOT EXISTS idx_sales_targets_general_live
  ON sales_targets (period_start, period_end)
  WHERE status IN ('PENDING_APPROVAL', 'ACTIVE') AND scope = 'GENERAL';

INSERT INTO schema_version (version)
SELECT 634 WHERE NOT EXISTS (SELECT 1 FROM schema_version WHERE version = 634);
