-- Migration 616: Managers get completed-sale phone alerts
--
-- SALE_COMPLETED used to be OPTIONAL with both channels off. Saving Sales as
-- On persisted that quiet row, so a manager with an active phone still got
-- nothing when a cashier completed a sale.
--
-- Application catalog now defaults managers/admins on (cashiers stay off).
-- This one-shot upgrades stored both-off rows for supervisors. Cashiers stay
-- off. Directors stored as STAFF (legacy role column has no DIRECTOR) are
-- included when their RBAC role is director/manager/admin. A later explicit
-- opt-out still wins.

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
    UPPER(TRIM(COALESCE(u.role, ''))) NOT IN ('STAFF', 'ACCOUNTANT')
    OR EXISTS (
      SELECT 1
        FROM rbac_user_roles ur
        INNER JOIN rbac_roles r
          ON r.id = ur.role_id AND r.is_active = true
       WHERE ur.user_id = u.id
         AND ur.is_active = true
         AND (ur.expires_at IS NULL OR ur.expires_at > NOW())
         AND (
           LOWER(r.name) IN ('admin', 'administrator', 'director', 'manager')
           OR LOWER(r.name) LIKE '%director%'
           OR LOWER(r.name) LIKE '%administrator%'
           OR LOWER(r.name) LIKE '%manager%'
         )
    )
  );

INSERT INTO schema_version (version) VALUES (616) ON CONFLICT DO NOTHING;
