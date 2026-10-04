-- Migration 632: Sales Targets tenant feature flag
--
-- Opt-in per tenant (default OFF). Tables from 631 remain; mutating APIs and UI
-- stay dark until system_settings.sales_targets_enabled = TRUE.

ALTER TABLE system_settings
  ADD COLUMN IF NOT EXISTS sales_targets_enabled BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN system_settings.sales_targets_enabled IS
  'When true, Sales Targets module (nav, KPI strip, /api/sales-targets) is available. Default false — tenants opt in.';

INSERT INTO schema_version (version)
SELECT 632 WHERE NOT EXISTS (SELECT 1 FROM schema_version WHERE version = 632);
