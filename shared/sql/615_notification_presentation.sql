-- Migration 615: Notification inbox presentation (actor, document, grouping)
-- Additive columns. Inbox remains useful if these are null.

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS actor_user_id UUID,
  ADD COLUMN IF NOT EXISTS actor_display TEXT,
  ADD COLUMN IF NOT EXISTS document_ref TEXT,
  ADD COLUMN IF NOT EXISTS location_label TEXT,
  ADD COLUMN IF NOT EXISTS grouping_key TEXT,
  ADD COLUMN IF NOT EXISTS priority VARCHAR(16) NOT NULL DEFAULT 'NORMAL';

CREATE INDEX IF NOT EXISTS idx_notifications_grouping
  ON notifications (recipient_user_id, grouping_key, created_at DESC);

INSERT INTO schema_version (version) VALUES (615) ON CONFLICT DO NOTHING;
