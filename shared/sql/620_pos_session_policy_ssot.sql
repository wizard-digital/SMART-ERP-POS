-- POS session policy SSOT:
--   one OPEN session per physical register (drawer)
--   cashiers may join a shared/global session without creating a second float
-- Safe: additive indexes + participants table; no drops.
-- Transaction is owned by tenantMigrationService / migrate.mjs.

CREATE TABLE IF NOT EXISTS cash_register_session_participants (
  session_id UUID NOT NULL REFERENCES cash_register_sessions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (session_id, user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_cash_register_session_participant_user
  ON cash_register_session_participants (user_id);

CREATE INDEX IF NOT EXISTS idx_cash_register_session_participants_session
  ON cash_register_session_participants (session_id);

-- Owners of currently OPEN sessions are participants (joiners added at join time).
INSERT INTO cash_register_session_participants (session_id, user_id)
SELECT DISTINCT ON (s.user_id) s.id, s.user_id
FROM cash_register_sessions s
WHERE s.status = 'OPEN'
ORDER BY s.user_id, s.opened_at DESC
ON CONFLICT DO NOTHING;

-- One float per drawer. Skip if historical duplicates exist (do not fail migrate).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM cash_register_sessions
    WHERE status = 'OPEN'
    GROUP BY register_id
    HAVING COUNT(*) > 1
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS uq_cash_register_one_open_session
      ON cash_register_sessions (register_id)
      WHERE status = 'OPEN';
  END IF;
END $$;

-- Constraint values MUST match POS_SESSION_POLICIES in shared/pos/posSessionPolicySsot.ts
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_pos_session_policy'
  ) THEN
    ALTER TABLE system_settings
      ADD CONSTRAINT chk_pos_session_policy
      CHECK (
        pos_session_policy IN (
          'DISABLED',
          'PER_CASHIER_SESSION',
          'PER_COUNTER_SHARED_SESSION',
          'GLOBAL_STORE_SESSION'
        )
      );
  END IF;
END $$;

INSERT INTO schema_version (version)
SELECT 620 WHERE NOT EXISTS (SELECT 1 FROM schema_version WHERE version = 620);
