-- Migration 617: Heal SALE_COMPLETED for Owner/CEO supervisors
--
-- Same quiet both-off rows as 616, but for tenants that named the RBAC role
-- Owner / CEO / Proprietor instead of Director. Cashiers stay off.

UPDATE notification_user_preferences p
SET in_app_enabled = true,
    push_enabled = true,
    updated_at = NOW()
FROM users u
WHERE p.user_id = u.id
  AND p.type_key = 'SALE_COMPLETED'
  AND p.in_app_enabled IS FALSE
  AND p.push_enabled IS FALSE
  AND UPPER(TRIM(COALESCE(u.role, ''))) <> 'CASHIER'
  AND (
    UPPER(TRIM(COALESCE(u.role, ''))) IN ('ADMIN', 'MANAGER', 'OWNER', 'DIRECTOR')
    OR EXISTS (
      SELECT 1
        FROM rbac_user_roles ur
        INNER JOIN rbac_roles r
          ON r.id = ur.role_id AND r.is_active = true
       WHERE ur.user_id = u.id
         AND ur.is_active = true
         AND (ur.expires_at IS NULL OR ur.expires_at > NOW())
         AND (
           LOWER(r.name) IN (
             'admin', 'administrator', 'director', 'manager',
             'owner', 'ceo', 'md', 'proprietor', 'supervisor'
           )
           OR LOWER(r.name) LIKE '%director%'
           OR LOWER(r.name) LIKE '%administrator%'
           OR LOWER(r.name) LIKE '%manager%'
           OR LOWER(r.name) LIKE '%owner%'
           OR LOWER(r.name) LIKE '%proprietor%'
           OR LOWER(r.name) LIKE '%supervisor%'
         )
    )
  );

INSERT INTO schema_version (version) VALUES (617) ON CONFLICT DO NOTHING;
