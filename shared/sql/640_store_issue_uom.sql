-- Migration 640: Store issue unit of entry (SAP ERFME / B1 Goods Issue UoM).
-- issued_qty_base remains the posting SSOT. uom_* is how the operator entered qty.

ALTER TABLE store_issue_lines
  ADD COLUMN IF NOT EXISTS uom_id UUID NULL REFERENCES uoms(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS uom_name VARCHAR(64) NULL,
  ADD COLUMN IF NOT EXISTS conversion_factor NUMERIC(18, 6) NOT NULL DEFAULT 1;

COMMENT ON COLUMN store_issue_lines.uom_id IS
  'Unit of entry for requested/issued qty. Post still consumes issued_qty_base.';
COMMENT ON COLUMN store_issue_lines.conversion_factor IS
  'Display qty × factor = base qty. Default 1 = base UoM.';

INSERT INTO schema_version (version) VALUES (640) ON CONFLICT DO NOTHING;
