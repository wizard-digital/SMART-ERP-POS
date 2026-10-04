-- Migration 633: Sales Targets GENERAL + named TEAM scopes
-- Keeps INDIVIDUAL. Achievement still derived (never stored).

-- ============================================================
-- 1. Named teams (membership)
-- ============================================================
CREATE TABLE IF NOT EXISTS sales_target_teams (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(120) NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_by  UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_sales_target_teams_name UNIQUE (name)
);

CREATE TABLE IF NOT EXISTS sales_target_team_members (
  team_id  UUID NOT NULL REFERENCES sales_target_teams(id) ON DELETE CASCADE,
  user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (team_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_sales_target_team_members_user
  ON sales_target_team_members (user_id);

-- ============================================================
-- 2. Expand sales_targets scope
-- ============================================================
ALTER TABLE sales_targets
  DROP CONSTRAINT IF EXISTS sales_targets_scope_check;

ALTER TABLE sales_targets
  ALTER COLUMN salesperson_id DROP NOT NULL;

ALTER TABLE sales_targets
  ADD COLUMN IF NOT EXISTS team_id UUID NULL REFERENCES sales_target_teams(id) ON DELETE RESTRICT;

ALTER TABLE sales_targets
  ADD CONSTRAINT sales_targets_scope_check
  CHECK (scope IN ('INDIVIDUAL', 'GENERAL', 'TEAM'));

ALTER TABLE sales_targets
  DROP CONSTRAINT IF EXISTS chk_sales_targets_scope_shape;

ALTER TABLE sales_targets
  ADD CONSTRAINT chk_sales_targets_scope_shape CHECK (
    (scope = 'INDIVIDUAL' AND salesperson_id IS NOT NULL AND team_id IS NULL)
    OR (scope = 'GENERAL' AND salesperson_id IS NULL AND team_id IS NULL)
    OR (scope = 'TEAM' AND team_id IS NOT NULL AND salesperson_id IS NULL)
  );

CREATE INDEX IF NOT EXISTS idx_sales_targets_scope_period
  ON sales_targets (scope, period_start, period_end)
  WHERE status IN ('PENDING_APPROVAL', 'ACTIVE');

CREATE INDEX IF NOT EXISTS idx_sales_targets_team_live
  ON sales_targets (team_id, period_start, period_end)
  WHERE status IN ('PENDING_APPROVAL', 'ACTIVE') AND scope = 'TEAM';

COMMENT ON COLUMN sales_targets.scope IS
  'INDIVIDUAL = one salesperson; GENERAL = all cashiers; TEAM = named team members.';

COMMENT ON TABLE sales_target_teams IS
  'Named groups for TEAM-scoped sales targets.';

INSERT INTO schema_version (version)
SELECT 633 WHERE NOT EXISTS (SELECT 1 FROM schema_version WHERE version = 633);
