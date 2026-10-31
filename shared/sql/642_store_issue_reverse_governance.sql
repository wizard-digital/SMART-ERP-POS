-- Migration 642: Store issue reverse governance (SAP GI 202 / MBST).
-- Reverse is a separate posting: mandatory reason, dedicated permission, four-eyes in the service.

ALTER TABLE store_issue_documents
  ADD COLUMN IF NOT EXISTS reversal_reason VARCHAR(500) NULL;

COMMENT ON COLUMN store_issue_documents.reversal_reason IS
  'Mandatory reason for posted GI reverse. Audit trail (who / why) — not an edit of the original issue.';

INSERT INTO rbac_permissions_catalog (key, module, action, description)
VALUES
  (
    'kitchen.production.reverse',
    'kitchen',
    'void',
    'Reverse posted store issues (restore stock and reverse 5150/1300)'
  )
ON CONFLICT (key) DO NOTHING;

INSERT INTO rbac_role_permissions (role_id, permission_key, granted_by)
SELECT r.id, p.key, u.id
FROM rbac_roles r
CROSS JOIN (VALUES ('kitchen.production.reverse')) AS p(key)
CROSS JOIN LATERAL (
  SELECT id FROM users ORDER BY created_at NULLS LAST LIMIT 1
) u
WHERE r.name IN ('Administrator', 'Admin', 'Super Admin', 'Manager', 'Store Manager')
ON CONFLICT (role_id, permission_key) DO NOTHING;

INSERT INTO schema_version (version) VALUES (642) ON CONFLICT DO NOTHING;
