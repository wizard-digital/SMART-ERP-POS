-- Migration 614: Enterprise notification platform (tenant DB)
--
-- Generic notification architecture. Notification types live in application
-- catalog code (SSOT). This schema stores:
--   tenant policy, user preferences, per-installation push subscriptions,
--   per-device type overrides, durable outbox events, inbox records,
--   and delivery attempts.
--
-- Isolation: tables live in each tenant database (DB-per-tenant). There is
-- no tenant_id column and no cross-tenant addressability.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS notification_tenant_policies (
  type_key VARCHAR(80) PRIMARY KEY,
  is_allowed BOOLEAN NOT NULL DEFAULT true,
  lock_screen_detail BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID
);

CREATE TABLE IF NOT EXISTS notification_user_preferences (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type_key VARCHAR(80) NOT NULL,
  in_app_enabled BOOLEAN NOT NULL DEFAULT true,
  push_enabled BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, type_key)
);

CREATE INDEX IF NOT EXISTS idx_notification_user_prefs_user
  ON notification_user_preferences (user_id);

CREATE TABLE IF NOT EXISTS notification_device_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  client_installation_id VARCHAR(64) NOT NULL,
  platform_hint VARCHAR(32) NOT NULL DEFAULT 'unknown',
  browser_hint VARCHAR(64),
  display_name VARCHAR(120),
  permission_state VARCHAR(16) NOT NULL DEFAULT 'granted',
  push_enabled BOOLEAN NOT NULL DEFAULT true,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  CONSTRAINT notification_device_install_unique UNIQUE (user_id, client_installation_id)
);

-- Active endpoints are unique. Revoked rows may retain the same endpoint
-- so a later installation can reuse it after logout/re-login.
CREATE UNIQUE INDEX IF NOT EXISTS notification_device_endpoint_active
  ON notification_device_subscriptions (endpoint)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_notification_device_user_active
  ON notification_device_subscriptions (user_id)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS notification_device_preferences (
  subscription_id UUID NOT NULL REFERENCES notification_device_subscriptions(id) ON DELETE CASCADE,
  type_key VARCHAR(80) NOT NULL,
  push_enabled BOOLEAN NOT NULL DEFAULT true,
  PRIMARY KEY (subscription_id, type_key)
);

CREATE TABLE IF NOT EXISTS notification_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type_key VARCHAR(80) NOT NULL,
  entity_type VARCHAR(64) NOT NULL,
  entity_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor_user_id UUID,
  store_location_id UUID,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status VARCHAR(16) NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'PROCESSING', 'DONE', 'FAILED')),
  retry_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  CONSTRAINT notification_events_idempotency UNIQUE (idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_notification_events_pending
  ON notification_events (created_at)
  WHERE status = 'PENDING';

CREATE INDEX IF NOT EXISTS idx_notification_events_type
  ON notification_events (type_key, occurred_at DESC);

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES notification_events(id) ON DELETE CASCADE,
  recipient_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type_key VARCHAR(80) NOT NULL,
  severity VARCHAR(16) NOT NULL DEFAULT 'INFO'
    CHECK (severity IN ('INFO', 'WARNING', 'CRITICAL')),
  title VARCHAR(200) NOT NULL,
  body VARCHAR(500) NOT NULL,
  entity_type VARCHAR(64),
  entity_id TEXT,
  navigation_path TEXT,
  is_read BOOLEAN NOT NULL DEFAULT false,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT notifications_event_recipient UNIQUE (event_id, recipient_user_id)
);

CREATE INDEX IF NOT EXISTS idx_notifications_inbox
  ON notifications (recipient_user_id, is_read, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notifications_unread
  ON notifications (recipient_user_id)
  WHERE is_read = false;

CREATE TABLE IF NOT EXISTS notification_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id UUID NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  subscription_id UUID REFERENCES notification_device_subscriptions(id) ON DELETE SET NULL,
  channel VARCHAR(16) NOT NULL
    CHECK (channel IN ('IN_APP', 'WEB_PUSH')),
  status VARCHAR(32) NOT NULL DEFAULT 'QUEUED'
    CHECK (status IN ('QUEUED', 'SUBMITTED', 'FAILED', 'EXPIRED', 'INVALID_SUBSCRIPTION')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  provider_status INTEGER,
  provider_response_category VARCHAR(64),
  error_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_queued
  ON notification_deliveries (created_at)
  WHERE status = 'QUEUED' AND channel = 'WEB_PUSH';

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_notification
  ON notification_deliveries (notification_id);

INSERT INTO schema_version (version) VALUES (614) ON CONFLICT DO NOTHING;
