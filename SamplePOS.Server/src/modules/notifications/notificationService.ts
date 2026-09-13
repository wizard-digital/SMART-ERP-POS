import type { Pool } from 'pg';
import { ValidationError, NotFoundError } from '../../middleware/errorHandler.js';
import {
  getNotificationType,
  isNotificationTypeKey,
  listCatalogForApi,
  NOTIFICATION_CATALOG,
} from './catalog.js';
import { catalogPolicyLabel, explainEligibility, explainWhyReceived, resolveRoleProfile, resolveUserChannels } from './notificationDecision.js';
import * as repo from './notificationRepository.js';
import { describePushTestOutcome, getVapidPublicKey, isWebPushConfigured } from './pushDeliveryService.js';
import { processNotificationEvent } from './notificationWorker.js';

function isMissingRelation(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { code?: string }).code === '42P01');
}

async function safeRead<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isMissingRelation(err)) return fallback;
    throw err;
  }
}

export async function getCatalog(pool: Pool) {
  const policies = await safeRead(() => repo.getTenantPolicyMap(pool), new Map());
  const allowed = new Set(
    NOTIFICATION_CATALOG.filter((t) => {
      const policy = policies.get(t.typeKey);
      return !policy || policy.isAllowed;
    }).map((t) => t.typeKey),
  );
  return {
    types: listCatalogForApi(allowed),
    vapidConfigured: isWebPushConfigured(),
    vapidPublicKey: getVapidPublicKey(),
  };
}

export async function getAdminPolicy(pool: Pool) {
  const policies = await safeRead(() => repo.getTenantPolicyMap(pool), new Map());
  return NOTIFICATION_CATALOG.map((t) => {
    const policy = policies.get(t.typeKey);
    return {
      typeKey: t.typeKey,
      category: t.category,
      categoryLabel: t.categoryLabel,
      label: t.label,
      description: t.description,
      isAllowed: policy ? policy.isAllowed : true,
      lockScreenDetail: policy ? policy.lockScreenDetail : false,
      preferenceMode: t.preferenceMode,
      lockScreenDetailNote:
        'When enabled, the lock screen may include a document reference. Amounts and customer names stay hidden.',
    };
  });
}

export async function updateAdminPolicy(
  pool: Pool,
  userId: string,
  items: Array<{ typeKey: string; isAllowed: boolean; lockScreenDetail?: boolean }>,
) {
  for (const item of items) {
    if (!isNotificationTypeKey(item.typeKey)) {
      throw new ValidationError(`Unknown notification type: ${item.typeKey}`);
    }
    const type = getNotificationType(item.typeKey);
    if (type?.preferenceMode === 'MANDATORY' && item.isAllowed === false) {
      throw new ValidationError(`Required notification type cannot be disabled: ${item.typeKey}`);
    }
    await repo.upsertTenantPolicy(
      pool,
      item.typeKey,
      item.isAllowed,
      item.lockScreenDetail === true,
      userId,
    );
  }
  return getAdminPolicy(pool);
}

export async function getPreferences(pool: Pool, userId: string) {
  const catalog = await getCatalog(pool);
  const prefs = await safeRead(() => repo.getUserPreferenceMap(pool, userId), new Map());
  const profiles = await safeRead(
    () => repo.listUserNotificationProfiles(pool, [userId]),
    new Map(),
  );
  const profile = profiles.get(userId);
  const role = resolveRoleProfile(profile?.role, profile?.rbacNames ?? []);
  return catalog.types.map((t) => {
    const stored = prefs.get(t.typeKey);
    const type = getNotificationType(t.typeKey)!;
    const channels = resolveUserChannels(type, stored, role);
    return {
      typeKey: t.typeKey,
      category: t.category,
      categoryLabel: t.categoryLabel,
      label: t.label,
      description: t.description,
      severity: t.severity,
      highVolume: t.highVolume,
      preferenceMode: t.preferenceMode,
      preferenceModeLabel: catalogPolicyLabel(type.preferenceMode),
      audience: type.audience,
      whyYouReceive: explainEligibility(type),
      inAppEnabled: channels.inAppEnabled,
      pushEnabled: channels.pushEnabled,
      inAppLocked: type.preferenceMode === 'MANDATORY',
    };
  });
}

export async function updatePreferences(
  pool: Pool,
  userId: string,
  items: Array<{ typeKey: string; inAppEnabled: boolean; pushEnabled: boolean }>,
) {
  const policies = await repo.getTenantPolicyMap(pool);
  for (const item of items) {
    if (!isNotificationTypeKey(item.typeKey)) {
      throw new ValidationError(`Unknown notification type: ${item.typeKey}`);
    }
    const policy = policies.get(item.typeKey);
    if (policy && !policy.isAllowed) {
      throw new ValidationError(`Notification type is not available for this tenant: ${item.typeKey}`);
    }
    const type = getNotificationType(item.typeKey)!;
    const inAppEnabled = type.preferenceMode === 'MANDATORY' ? true : item.inAppEnabled;
    await repo.upsertUserPreference(pool, userId, item.typeKey, inAppEnabled, item.pushEnabled);
  }
  return getPreferences(pool, userId);
}

export async function listNotifications(
  pool: Pool,
  userId: string,
  options: { unreadOnly?: boolean; limit?: number; offset?: number },
) {
  const data = await safeRead(
    () => repo.listInbox(pool, userId, options),
    { rows: [], total: 0, unreadCount: 0 },
  );
  return {
    ...data,
    rows: data.rows.map((row) => decorateInbox(row, userId)),
  };
}

export async function getNotification(pool: Pool, userId: string, id: string) {
  const row = await safeRead(() => repo.getInboxById(pool, id, userId), null);
  if (!row) throw new NotFoundError('Notification');
  return decorateInbox(row, userId);
}

export async function markNotificationRead(pool: Pool, userId: string, id: string) {
  const exists = await repo.getInboxById(pool, id, userId);
  if (!exists) throw new NotFoundError('Notification');
  await repo.markRead(pool, id, userId);
  return { unreadCount: await repo.unreadCount(pool, userId) };
}

export async function markAllNotificationsRead(pool: Pool, userId: string) {
  const updated = await repo.markAllRead(pool, userId);
  return { updated, unreadCount: 0 };
}

export async function getUnreadCount(pool: Pool, userId: string) {
  return { unreadCount: await safeRead(() => repo.unreadCount(pool, userId), 0) };
}

function decorateInbox(row: repo.InboxRow, recipientUserId: string) {
  const type = getNotificationType(row.typeKey);
  return {
    ...row,
    whyReceived: type
      ? explainWhyReceived({
          type,
          recipientUserId,
          entityType: row.entityType,
          entityId: row.entityId,
        })
      : null,
  };
}

function publicDevice(
  row: repo.DeviceSubscriptionRow,
  typePreferences: Array<{ typeKey: string; pushEnabled: boolean; label?: string }> = [],
) {
  const muted = typePreferences.filter((pref) => pref.pushEnabled === false);
  return {
    id: row.id,
    clientInstallationId: row.clientInstallationId,
    platformHint: row.platformHint,
    browserHint: row.browserHint,
    displayName: row.displayName,
    permissionState: row.permissionState,
    pushEnabled: row.pushEnabled && !row.revokedAt,
    lastSeenAt: row.lastSeenAt,
    createdAt: row.createdAt,
    revoked: Boolean(row.revokedAt),
    typePreferences: muted,
    typeOverrides: muted,
    followsUserTypes: muted.length === 0,
  };
}

export async function listDevices(pool: Pool, userId: string) {
  const rows = await safeRead(() => repo.listDevicesForUser(pool, userId), []);
  const maps = await repo.getDeviceTypePreferenceMaps(
    pool,
    rows.map((row) => row.id),
  );
  return rows.map((row) => {
    const typePreferences = [...(maps.get(row.id) ?? new Map()).entries()].map(([typeKey, pushEnabled]) => ({
      typeKey,
      pushEnabled,
      label: getNotificationType(typeKey)?.label,
    }));
    return publicDevice(row, typePreferences);
  });
}

export async function registerDevice(
  pool: Pool,
  userId: string,
  input: {
    endpoint: string;
    p256dh: string;
    auth: string;
    clientInstallationId: string;
    platformHint?: string;
    browserHint?: string | null;
    displayName?: string | null;
    permissionState?: string;
  },
) {
  if (!input.endpoint.startsWith('https://')) {
    throw new ValidationError('Push endpoint must be https');
  }
  if (!input.p256dh || !input.auth || !input.clientInstallationId) {
    throw new ValidationError('Incomplete push subscription');
  }
  const row = await repo.upsertDeviceSubscription(pool, {
    userId,
    endpoint: input.endpoint,
    p256dh: input.p256dh,
    auth: input.auth,
    clientInstallationId: input.clientInstallationId.slice(0, 64),
    platformHint: (input.platformHint || 'unknown').slice(0, 32),
    browserHint: input.browserHint ?? null,
    displayName: input.displayName ?? null,
    permissionState: input.permissionState || 'granted',
  });
  return publicDevice(row);
}

export async function updateDevice(
  pool: Pool,
  userId: string,
  subscriptionId: string,
  patch: { pushEnabled?: boolean; typeKeys?: Array<{ typeKey: string; pushEnabled: boolean }> },
) {
  const existing = await repo.getDeviceForUser(pool, subscriptionId, userId);
  if (!existing || existing.revokedAt) throw new NotFoundError('Device subscription');
  if (typeof patch.pushEnabled === 'boolean') {
    await repo.setDevicePushEnabled(pool, subscriptionId, userId, patch.pushEnabled);
  }
  if (patch.typeKeys) {
    for (const item of patch.typeKeys) {
      if (!isNotificationTypeKey(item.typeKey)) {
        throw new ValidationError(`Unknown notification type: ${item.typeKey}`);
      }
      await repo.upsertDeviceTypePreference(pool, subscriptionId, item.typeKey, item.pushEnabled);
    }
  }
  const updated = await repo.getDeviceForUser(pool, subscriptionId, userId);
  const maps = await repo.getDeviceTypePreferenceMaps(pool, [subscriptionId]);
  const typePreferences = [...(maps.get(subscriptionId) ?? new Map()).entries()].map(([typeKey, pushEnabled]) => ({
    typeKey,
    pushEnabled,
    label: getNotificationType(typeKey)?.label,
  }));
  return publicDevice(updated!, typePreferences);
}

export async function removeDevice(pool: Pool, userId: string, subscriptionId: string) {
  const ok = await repo.revokeDevice(pool, subscriptionId, userId);
  if (!ok) throw new NotFoundError('Device subscription');
  return { revoked: true };
}

export async function sendTestNotification(
  pool: Pool,
  userId: string,
  tenantId: string | null,
) {
  const devices = await repo.listActivePushSubscriptionsForUser(pool, userId);
  const event = await repo.insertEvent(pool, {
    typeKey: 'NOTIFICATION_TEST',
    entityType: 'user',
    entityId: userId,
    idempotencyKey: `NOTIFICATION_TEST:user:${userId}:${Date.now()}`,
    payload: { subjectUserId: userId, summary: 'Test notification from SMART-ERP-POS' },
    actorUserId: userId,
    storeLocationId: null,
  });
  if (!event) {
    return { status: 'failed' as const, reason: 'Could not record test event', devicesRegistered: devices.length };
  }

  const processed = await processNotificationEvent(pool, event.id, tenantId);
  const deliveries = await safeRead(() => repo.listWebPushDeliveriesForEvent(pool, event.id), []);
  const outcome = describePushTestOutcome({
    vapidConfigured: isWebPushConfigured(),
    devicesRegistered: devices.length,
    created: processed?.created ?? 0,
    pushed: processed?.pushed ?? 0,
    deliveries,
  });
  return {
    ...outcome,
    devicesRegistered: devices.length,
    created: processed?.created ?? 0,
    pushed: processed?.pushed ?? 0,
    providerStatus: deliveries[0]?.providerStatus ?? null,
    category: deliveries[0]?.category ?? null,
  };
}
