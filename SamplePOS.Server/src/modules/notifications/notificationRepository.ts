import type { Pool, PoolClient } from 'pg';
import type { NotificationSeverity, NotificationTypeKey } from './catalog.js';

type Db = Pool | PoolClient;

export interface NotificationEventRow {
  id: string;
  typeKey: NotificationTypeKey;
  entityType: string;
  entityId: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  actorUserId: string | null;
  storeLocationId: string | null;
  occurredAt: string;
  status: 'PENDING' | 'PROCESSING' | 'DONE' | 'FAILED';
  retryCount: number;
}

export interface InboxRow {
  id: string;
  eventId: string;
  recipientUserId: string;
  typeKey: string;
  severity: NotificationSeverity;
  title: string;
  body: string;
  entityType: string | null;
  entityId: string | null;
  navigationPath: string | null;
  isRead: boolean;
  readAt: string | null;
  createdAt: string;
  actorUserId: string | null;
  actorDisplay: string | null;
  documentRef: string | null;
  locationLabel: string | null;
  groupingKey: string | null;
  priority: string;
}

export interface DeviceSubscriptionRow {
  id: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  clientInstallationId: string;
  platformHint: string;
  browserHint: string | null;
  displayName: string | null;
  permissionState: string;
  pushEnabled: boolean;
  lastSeenAt: string;
  createdAt: string;
  revokedAt: string | null;
}

function mapEvent(row: Record<string, unknown>): NotificationEventRow {
  return {
    id: String(row.id),
    typeKey: row.type_key as NotificationTypeKey,
    entityType: String(row.entity_type),
    entityId: String(row.entity_id),
    idempotencyKey: String(row.idempotency_key),
    payload: (row.payload as Record<string, unknown>) || {},
    actorUserId: row.actor_user_id ? String(row.actor_user_id) : null,
    storeLocationId: row.store_location_id ? String(row.store_location_id) : null,
    occurredAt: new Date(String(row.occurred_at)).toISOString(),
    status: row.status as NotificationEventRow['status'],
    retryCount: Number(row.retry_count || 0),
  };
}

function mapInbox(row: Record<string, unknown>): InboxRow {
  return {
    id: String(row.id),
    eventId: String(row.event_id),
    recipientUserId: String(row.recipient_user_id),
    typeKey: String(row.type_key),
    severity: row.severity as NotificationSeverity,
    title: String(row.title),
    body: String(row.body),
    entityType: row.entity_type ? String(row.entity_type) : null,
    entityId: row.entity_id ? String(row.entity_id) : null,
    navigationPath: row.navigation_path ? String(row.navigation_path) : null,
    isRead: Boolean(row.is_read),
    readAt: row.read_at ? new Date(String(row.read_at)).toISOString() : null,
    createdAt: new Date(String(row.created_at)).toISOString(),
    actorUserId: row.actor_user_id ? String(row.actor_user_id) : null,
    actorDisplay: row.actor_display ? String(row.actor_display) : null,
    documentRef: row.document_ref ? String(row.document_ref) : null,
    locationLabel: row.location_label ? String(row.location_label) : null,
    groupingKey: row.grouping_key ? String(row.grouping_key) : null,
    priority: String(row.priority || 'NORMAL'),
  };
}

function mapDevice(row: Record<string, unknown>): DeviceSubscriptionRow {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    endpoint: String(row.endpoint),
    p256dh: String(row.p256dh),
    auth: String(row.auth),
    clientInstallationId: String(row.client_installation_id),
    platformHint: String(row.platform_hint || 'unknown'),
    browserHint: row.browser_hint ? String(row.browser_hint) : null,
    displayName: row.display_name ? String(row.display_name) : null,
    permissionState: String(row.permission_state || 'granted'),
    pushEnabled: Boolean(row.push_enabled),
    lastSeenAt: new Date(String(row.last_seen_at)).toISOString(),
    createdAt: new Date(String(row.created_at)).toISOString(),
    revokedAt: row.revoked_at ? new Date(String(row.revoked_at)).toISOString() : null,
  };
}

export async function insertEvent(
  db: Db,
  input: {
    typeKey: string;
    entityType: string;
    entityId: string;
    idempotencyKey: string;
    payload: Record<string, unknown>;
    actorUserId?: string | null;
    storeLocationId?: string | null;
  },
): Promise<NotificationEventRow | null> {
  const result = await db.query(
    `INSERT INTO notification_events
       (type_key, entity_type, entity_id, idempotency_key, payload, actor_user_id, store_location_id)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING *`,
    [
      input.typeKey,
      input.entityType,
      input.entityId,
      input.idempotencyKey,
      JSON.stringify(input.payload),
      input.actorUserId ?? null,
      input.storeLocationId ?? null,
    ],
  );
  if (result.rows[0]) return mapEvent(result.rows[0]);

  const existing = await db.query(`SELECT * FROM notification_events WHERE idempotency_key = $1`, [
    input.idempotencyKey,
  ]);
  return existing.rows[0] ? mapEvent(existing.rows[0]) : null;
}

export async function claimPendingEvent(db: Db, eventId: string): Promise<NotificationEventRow | null> {
  const result = await db.query(
    `UPDATE notification_events
        SET status = 'PROCESSING'
      WHERE id = $1 AND status IN ('PENDING', 'FAILED')
      RETURNING *`,
    [eventId],
  );
  return result.rows[0] ? mapEvent(result.rows[0]) : null;
}

export async function markEventDone(db: Db, eventId: string): Promise<void> {
  await db.query(
    `UPDATE notification_events SET status = 'DONE', processed_at = NOW(), error_message = NULL WHERE id = $1`,
    [eventId],
  );
}

export async function markEventFailed(db: Db, eventId: string, errorMessage: string): Promise<void> {
  await db.query(
    `UPDATE notification_events
        SET status = 'FAILED',
            retry_count = retry_count + 1,
            error_message = $2
      WHERE id = $1`,
    [eventId, errorMessage.slice(0, 1000)],
  );
}

export async function listPendingEvents(db: Db, limit = 50): Promise<NotificationEventRow[]> {
  const result = await db.query(
    `SELECT * FROM notification_events
      WHERE status = 'PENDING' OR (status = 'FAILED' AND retry_count < 8)
      ORDER BY created_at ASC
      LIMIT $1`,
    [limit],
  );
  return result.rows.map((row: Record<string, unknown>) => mapEvent(row));
}

export async function insertInbox(
  db: Db,
  input: {
    eventId: string;
    recipientUserId: string;
    typeKey: string;
    severity: NotificationSeverity;
    title: string;
    body: string;
    entityType: string | null;
    entityId: string | null;
    navigationPath: string | null;
    actorUserId?: string | null;
    actorDisplay?: string | null;
    documentRef?: string | null;
    locationLabel?: string | null;
    groupingKey?: string | null;
    priority?: string;
  },
): Promise<InboxRow | null> {
  const result = await db.query(
    `INSERT INTO notifications
       (event_id, recipient_user_id, type_key, severity, title, body, entity_type, entity_id, navigation_path,
        actor_user_id, actor_display, document_ref, location_label, grouping_key, priority)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (event_id, recipient_user_id) DO NOTHING
     RETURNING *`,
    [
      input.eventId,
      input.recipientUserId,
      input.typeKey,
      input.severity,
      input.title,
      input.body,
      input.entityType,
      input.entityId,
      input.navigationPath,
      input.actorUserId ?? null,
      input.actorDisplay ?? null,
      input.documentRef ?? null,
      input.locationLabel ?? null,
      input.groupingKey ?? null,
      input.priority ?? 'NORMAL',
    ],
  );
  if (result.rows[0]) return mapInbox(result.rows[0]);
  const existing = await db.query(
    `SELECT * FROM notifications WHERE event_id = $1 AND recipient_user_id = $2`,
    [input.eventId, input.recipientUserId],
  );
  return existing.rows[0] ? mapInbox(existing.rows[0]) : null;
}

export async function listInbox(
  db: Db,
  userId: string,
  options: { unreadOnly?: boolean; limit?: number; offset?: number } = {},
): Promise<{ rows: InboxRow[]; total: number; unreadCount: number }> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const offset = Math.max(options.offset ?? 0, 0);
  const unreadClause = options.unreadOnly ? 'AND is_read = false' : '';
  const count = await db.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE is_read = false)::int AS unread
       FROM notifications WHERE recipient_user_id = $1`,
    [userId],
  );
  const result = await db.query(
    `SELECT * FROM notifications
      WHERE recipient_user_id = $1 ${unreadClause}
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3`,
    [userId, limit, offset],
  );
  return {
    rows: result.rows.map((row: Record<string, unknown>) => mapInbox(row)),
    total: Number(count.rows[0]?.total || 0),
    unreadCount: Number(count.rows[0]?.unread || 0),
  };
}

export async function getInboxById(db: Db, id: string, userId: string): Promise<InboxRow | null> {
  const result = await db.query(
    `SELECT * FROM notifications WHERE id = $1 AND recipient_user_id = $2`,
    [id, userId],
  );
  return result.rows[0] ? mapInbox(result.rows[0]) : null;
}

export async function markRead(db: Db, id: string, userId: string): Promise<boolean> {
  const result = await db.query(
    `UPDATE notifications
        SET is_read = true, read_at = COALESCE(read_at, NOW())
      WHERE id = $1 AND recipient_user_id = $2 AND is_read = false`,
    [id, userId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function markAllRead(db: Db, userId: string): Promise<number> {
  const result = await db.query(
    `UPDATE notifications
        SET is_read = true, read_at = COALESCE(read_at, NOW())
      WHERE recipient_user_id = $1 AND is_read = false`,
    [userId],
  );
  return result.rowCount ?? 0;
}

export async function unreadCount(db: Db, userId: string): Promise<number> {
  const result = await db.query(
    `SELECT COUNT(*)::int AS unread FROM notifications WHERE recipient_user_id = $1 AND is_read = false`,
    [userId],
  );
  return Number(result.rows[0]?.unread || 0);
}

export async function listRecipientCandidateIds(
  db: Db,
  permissionKey: string,
  storeLocationId: string | null,
): Promise<string[]> {
  // Mirrors AuthorizationService: ADMIN always; RBAC permission + scope;
  // legacy MANAGER/ADMIN fallback only when the user has no RBAC assignments.
  const result = await db.query(
    `SELECT DISTINCT u.id
       FROM users u
      WHERE u.is_active = true
        AND (
          UPPER(u.role) = 'ADMIN'
          OR EXISTS (
            SELECT 1
              FROM rbac_user_roles ur
              INNER JOIN rbac_roles r
                ON r.id = ur.role_id AND r.is_active = true
              INNER JOIN rbac_role_permissions rp
                ON rp.role_id = r.id
             WHERE ur.user_id = u.id
               AND ur.is_active = true
               AND (ur.expires_at IS NULL OR ur.expires_at > NOW())
               AND rp.permission_key = $1
               AND (
                 ur.scope_type IS NULL
                 OR ur.scope_type IN ('global', 'organization')
                 OR (
                   $2::uuid IS NOT NULL
                   AND ur.scope_type IN ('branch', 'warehouse')
                   AND ur.scope_id = $2
                 )
               )
          )
          OR (
            UPPER(u.role) = 'MANAGER'
            AND NOT EXISTS (
              SELECT 1
                FROM rbac_user_roles ur0
               WHERE ur0.user_id = u.id
                 AND ur0.is_active = true
                 AND (ur0.expires_at IS NULL OR ur0.expires_at > NOW())
            )
          )
        )`,
    [permissionKey, storeLocationId],
  );
  return result.rows.map((row: { id: string }) => row.id);
}

export async function getActorIdentity(
  db: Db,
  userId: string | null,
): Promise<{ display: string; role: string; isActive: boolean } | null> {
  if (!userId) return null;
  const result = await db.query(
    `SELECT full_name, role, is_active FROM users WHERE id = $1`,
    [userId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    display: String(row.full_name || 'User'),
    role: String(row.role || ''),
    isActive: Boolean(row.is_active),
  };
}

export async function isUserActive(db: Db, userId: string): Promise<boolean> {
  const result = await db.query(`SELECT is_active FROM users WHERE id = $1`, [userId]);
  return Boolean(result.rows[0]?.is_active);
}

export async function listUserNotificationProfiles(
  db: Db,
  userIds: string[],
): Promise<Map<string, { role: string; rbacNames: string[] }>> {
  const map = new Map<string, { role: string; rbacNames: string[] }>();
  if (userIds.length === 0) return map;
  const result = await db.query(
    `SELECT u.id,
            u.role,
            COALESCE(
              ARRAY_AGG(r.name) FILTER (WHERE r.name IS NOT NULL),
              '{}'::text[]
            ) AS rbac_names
       FROM users u
       LEFT JOIN rbac_user_roles ur
         ON ur.user_id = u.id
        AND ur.is_active = true
        AND (ur.expires_at IS NULL OR ur.expires_at > NOW())
       LEFT JOIN rbac_roles r
         ON r.id = ur.role_id AND r.is_active = true
      WHERE u.id = ANY($1::uuid[])
      GROUP BY u.id, u.role`,
    [userIds],
  );
  for (const row of result.rows) {
    map.set(String(row.id), {
      role: String(row.role || ''),
      rbacNames: Array.isArray(row.rbac_names) ? row.rbac_names.map(String) : [],
    });
  }
  return map;
}

export async function getTenantPolicyMap(db: Db): Promise<Map<string, { isAllowed: boolean; lockScreenDetail: boolean }>> {
  const result = await db.query(`SELECT type_key, is_allowed, lock_screen_detail FROM notification_tenant_policies`);
  const map = new Map<string, { isAllowed: boolean; lockScreenDetail: boolean }>();
  for (const row of result.rows) {
    map.set(String(row.type_key), {
      isAllowed: Boolean(row.is_allowed),
      lockScreenDetail: Boolean(row.lock_screen_detail),
    });
  }
  return map;
}

export async function upsertTenantPolicy(
  db: Db,
  typeKey: string,
  isAllowed: boolean,
  lockScreenDetail: boolean,
  updatedBy: string,
): Promise<void> {
  await db.query(
    `INSERT INTO notification_tenant_policies (type_key, is_allowed, lock_screen_detail, updated_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (type_key) DO UPDATE SET
       is_allowed = EXCLUDED.is_allowed,
       lock_screen_detail = EXCLUDED.lock_screen_detail,
       updated_at = NOW(),
       updated_by = EXCLUDED.updated_by`,
    [typeKey, isAllowed, lockScreenDetail, updatedBy],
  );
}

export async function getUserPreferenceMap(
  db: Db,
  userId: string,
): Promise<Map<string, { inAppEnabled: boolean; pushEnabled: boolean }>> {
  const maps = await getUserPreferenceMaps(db, [userId]);
  return maps.get(userId) ?? new Map();
}

export async function getUserPreferenceMaps(
  db: Db,
  userIds: string[],
): Promise<Map<string, Map<string, { inAppEnabled: boolean; pushEnabled: boolean }>>> {
  const maps = new Map<string, Map<string, { inAppEnabled: boolean; pushEnabled: boolean }>>();
  for (const id of userIds) maps.set(id, new Map());
  if (userIds.length === 0) return maps;
  const result = await db.query(
    `SELECT user_id, type_key, in_app_enabled, push_enabled
       FROM notification_user_preferences
      WHERE user_id = ANY($1::uuid[])`,
    [userIds],
  );
  for (const row of result.rows) {
    const userId = String(row.user_id);
    const map = maps.get(userId) ?? new Map();
    map.set(String(row.type_key), {
      inAppEnabled: Boolean(row.in_app_enabled),
      pushEnabled: Boolean(row.push_enabled),
    });
    maps.set(userId, map);
  }
  return maps;
}

export async function upsertUserPreference(
  db: Db,
  userId: string,
  typeKey: string,
  inAppEnabled: boolean,
  pushEnabled: boolean,
): Promise<void> {
  await db.query(
    `INSERT INTO notification_user_preferences (user_id, type_key, in_app_enabled, push_enabled)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, type_key) DO UPDATE SET
       in_app_enabled = EXCLUDED.in_app_enabled,
       push_enabled = EXCLUDED.push_enabled,
       updated_at = NOW()`,
    [userId, typeKey, inAppEnabled, pushEnabled],
  );
}

export async function upsertDeviceSubscription(
  db: Db,
  input: {
    userId: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    clientInstallationId: string;
    platformHint: string;
    browserHint?: string | null;
    displayName?: string | null;
    permissionState: string;
  },
): Promise<DeviceSubscriptionRow> {
  await db.query(
    `UPDATE notification_device_subscriptions
        SET revoked_at = NOW(), push_enabled = false
      WHERE endpoint = $1
        AND revoked_at IS NULL
        AND NOT (user_id = $2 AND client_installation_id = $3)`,
    [input.endpoint, input.userId, input.clientInstallationId],
  );
  const result = await db.query(
    `INSERT INTO notification_device_subscriptions
       (user_id, endpoint, p256dh, auth, client_installation_id, platform_hint, browser_hint, display_name, permission_state, push_enabled, revoked_at, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, NULL, NOW())
     ON CONFLICT (user_id, client_installation_id) DO UPDATE SET
       endpoint = EXCLUDED.endpoint,
       p256dh = EXCLUDED.p256dh,
       auth = EXCLUDED.auth,
       platform_hint = EXCLUDED.platform_hint,
       browser_hint = EXCLUDED.browser_hint,
       display_name = EXCLUDED.display_name,
       permission_state = EXCLUDED.permission_state,
       push_enabled = true,
       revoked_at = NULL,
       last_seen_at = NOW()
     RETURNING *`,
    [
      input.userId,
      input.endpoint,
      input.p256dh,
      input.auth,
      input.clientInstallationId,
      input.platformHint,
      input.browserHint ?? null,
      input.displayName ?? null,
      input.permissionState,
    ],
  );
  return mapDevice(result.rows[0]);
}

export async function listDevicesForUser(db: Db, userId: string): Promise<DeviceSubscriptionRow[]> {
  const result = await db.query(
    `SELECT * FROM notification_device_subscriptions
      WHERE user_id = $1
      ORDER BY last_seen_at DESC`,
    [userId],
  );
  return result.rows.map((row: Record<string, unknown>) => mapDevice(row));
}

export async function getDeviceForUser(
  db: Db,
  subscriptionId: string,
  userId: string,
): Promise<DeviceSubscriptionRow | null> {
  const result = await db.query(
    `SELECT * FROM notification_device_subscriptions WHERE id = $1 AND user_id = $2`,
    [subscriptionId, userId],
  );
  return result.rows[0] ? mapDevice(result.rows[0]) : null;
}

export async function listActivePushSubscriptionsForUser(
  db: Db,
  userId: string,
): Promise<DeviceSubscriptionRow[]> {
  const grouped = await listActivePushSubscriptionsForUsers(db, [userId]);
  return grouped.get(userId) ?? [];
}

export async function listActivePushSubscriptionsForUsers(
  db: Db,
  userIds: string[],
): Promise<Map<string, DeviceSubscriptionRow[]>> {
  const grouped = new Map<string, DeviceSubscriptionRow[]>();
  for (const id of userIds) grouped.set(id, []);
  if (userIds.length === 0) return grouped;
  const result = await db.query(
    `SELECT * FROM notification_device_subscriptions
      WHERE user_id = ANY($1::uuid[]) AND revoked_at IS NULL AND push_enabled = true`,
    [userIds],
  );
  for (const row of result.rows as Record<string, unknown>[]) {
    const mapped = mapDevice(row);
    const list = grouped.get(mapped.userId) ?? [];
    list.push(mapped);
    grouped.set(mapped.userId, list);
  }
  return grouped;
}

export async function setDevicePushEnabled(
  db: Db,
  subscriptionId: string,
  userId: string,
  enabled: boolean,
): Promise<boolean> {
  const result = await db.query(
    `UPDATE notification_device_subscriptions
        SET push_enabled = $3, last_seen_at = NOW()
      WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [subscriptionId, userId, enabled],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function revokeDevice(db: Db, subscriptionId: string, userId: string): Promise<boolean> {
  const result = await db.query(
    `UPDATE notification_device_subscriptions
        SET revoked_at = NOW(), push_enabled = false
      WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [subscriptionId, userId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function revokeDeviceByEndpoint(db: Db, endpoint: string): Promise<void> {
  await db.query(
    `UPDATE notification_device_subscriptions
        SET revoked_at = NOW(), push_enabled = false
      WHERE endpoint = $1 AND revoked_at IS NULL`,
    [endpoint],
  );
}

export async function revokeAllDevicesForUser(db: Db, userId: string): Promise<void> {
  await db.query(
    `UPDATE notification_device_subscriptions
        SET revoked_at = NOW(), push_enabled = false
      WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId],
  );
}

export async function getDeviceTypePreferenceMap(
  db: Db,
  subscriptionId: string,
): Promise<Map<string, boolean>> {
  const maps = await getDeviceTypePreferenceMaps(db, [subscriptionId]);
  return maps.get(subscriptionId) ?? new Map();
}

export async function getDeviceTypePreferenceMaps(
  db: Db,
  subscriptionIds: string[],
): Promise<Map<string, Map<string, boolean>>> {
  const maps = new Map<string, Map<string, boolean>>();
  for (const id of subscriptionIds) maps.set(id, new Map());
  if (subscriptionIds.length === 0) return maps;
  const result = await db.query(
    `SELECT subscription_id, type_key, push_enabled
       FROM notification_device_preferences
      WHERE subscription_id = ANY($1::uuid[])`,
    [subscriptionIds],
  );
  for (const row of result.rows) {
    const subscriptionId = String(row.subscription_id);
    const map = maps.get(subscriptionId) ?? new Map();
    map.set(String(row.type_key), Boolean(row.push_enabled));
    maps.set(subscriptionId, map);
  }
  return maps;
}

export async function hasSubmittedWebPush(
  db: Db,
  notificationId: string,
  subscriptionId: string,
): Promise<boolean> {
  const result = await db.query(
    `SELECT 1
       FROM notification_deliveries
      WHERE notification_id = $1
        AND subscription_id = $2
        AND channel = 'WEB_PUSH'
        AND status = 'SUBMITTED'
      LIMIT 1`,
    [notificationId, subscriptionId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function upsertDeviceTypePreference(
  db: Db,
  subscriptionId: string,
  typeKey: string,
  pushEnabled: boolean,
): Promise<void> {
  await db.query(
    `INSERT INTO notification_device_preferences (subscription_id, type_key, push_enabled)
     VALUES ($1, $2, $3)
     ON CONFLICT (subscription_id, type_key) DO UPDATE SET push_enabled = EXCLUDED.push_enabled`,
    [subscriptionId, typeKey, pushEnabled],
  );
}

export async function insertDelivery(
  db: Db,
  input: {
    notificationId: string;
    subscriptionId: string | null;
    channel: 'IN_APP' | 'WEB_PUSH';
    status: 'QUEUED' | 'SUBMITTED' | 'FAILED' | 'EXPIRED' | 'INVALID_SUBSCRIPTION';
    providerStatus?: number | null;
    providerResponseCategory?: string | null;
    errorReason?: string | null;
  },
): Promise<string> {
  const result = await db.query(
    `INSERT INTO notification_deliveries
       (notification_id, subscription_id, channel, status, attempt_count, provider_status, provider_response_category, error_reason)
     VALUES ($1, $2, $3, $4, 1, $5, $6, $7)
     RETURNING id`,
    [
      input.notificationId,
      input.subscriptionId,
      input.channel,
      input.status,
      input.providerStatus ?? null,
      input.providerResponseCategory ?? null,
      input.errorReason ?? null,
    ],
  );
  return String(result.rows[0].id);
}

export async function listWebPushDeliveriesForEvent(
  db: Db,
  eventId: string,
): Promise<Array<{
  status: string;
  providerStatus: number | null;
  category: string | null;
  errorReason: string | null;
}>> {
  const result = await db.query(
    `SELECT d.status, d.provider_status, d.provider_response_category, d.error_reason
       FROM notification_deliveries d
       INNER JOIN notifications n ON n.id = d.notification_id
      WHERE n.event_id = $1 AND d.channel = 'WEB_PUSH'
      ORDER BY d.created_at DESC`,
    [eventId],
  );
  return (result.rows as Record<string, unknown>[]).map((row) => ({
    status: String(row.status),
    providerStatus: row.provider_status == null ? null : Number(row.provider_status),
    category: row.provider_response_category == null ? null : String(row.provider_response_category),
    errorReason: row.error_reason == null ? null : String(row.error_reason),
  }));
}

export async function updateDelivery(
  db: Db,
  deliveryId: string,
  patch: {
    status: 'QUEUED' | 'SUBMITTED' | 'FAILED' | 'EXPIRED' | 'INVALID_SUBSCRIPTION';
    providerStatus?: number | null;
    providerResponseCategory?: string | null;
    errorReason?: string | null;
  },
): Promise<void> {
  await db.query(
    `UPDATE notification_deliveries
        SET status = $2,
            attempt_count = attempt_count + 1,
            provider_status = $3,
            provider_response_category = $4,
            error_reason = $5,
            updated_at = NOW()
      WHERE id = $1`,
    [
      deliveryId,
      patch.status,
      patch.providerStatus ?? null,
      patch.providerResponseCategory ?? null,
      patch.errorReason ?? null,
    ],
  );
}
