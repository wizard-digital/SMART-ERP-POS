import type { Pool } from 'pg';
import logger from '../../utils/logger.js';
import {
  getNotificationType,
  isSafeNavigationPath,
  type NotificationTypeDefinition,
} from './catalog.js';
import {
  lockScreenCopy,
  resolveDevicePush,
  resolveRoleProfile,
  resolveUserChannels,
} from './notificationDecision.js';
import {
  formatAmountLabel,
  formatInboxBody,
  groupingKeyFor,
  payloadString,
  priorityFromType,
} from './presentation.js';
import * as repo from './notificationRepository.js';
import { deliverWebPush, type PushSendResult } from './pushDeliveryService.js';

async function resolveRecipients(
  pool: Pool,
  type: NotificationTypeDefinition,
  payload: Record<string, unknown>,
  storeLocationId: string | null,
  actorUserId: string | null,
): Promise<string[]> {
  const ids = new Set<string>();
  const subjectUserId = typeof payload.subjectUserId === 'string' ? payload.subjectUserId : null;

  if (type.audience === 'subject_user' || type.audience === 'subject_and_admins') {
    if (subjectUserId && (await repo.isUserActive(pool, subjectUserId))) {
      ids.add(subjectUserId);
    }
  }

  if (type.audience === 'permission_holders' || type.audience === 'subject_and_admins') {
    if (type.requiredPermission) {
      const holders = await repo.listRecipientCandidateIds(pool, type.requiredPermission, storeLocationId);
      for (const id of holders) ids.add(id);
    }
  }

  if (actorUserId && actorUserId !== subjectUserId) {
    ids.delete(actorUserId);
  }

  return [...ids];
}

function preferenceFor(
  type: NotificationTypeDefinition,
  prefs: Map<string, { inAppEnabled: boolean; pushEnabled: boolean }>,
  role: ReturnType<typeof resolveRoleProfile>,
): { inAppEnabled: boolean; pushEnabled: boolean } {
  return resolveUserChannels(type, prefs.get(type.typeKey), role);
}

export async function processNotificationEvent(
  pool: Pool,
  eventId: string,
  tenantId: string | null,
): Promise<{ created: number; pushed: number } | null> {
  const claimed = await repo.claimPendingEvent(pool, eventId);
  if (!claimed) {
    return null;
  }

  const type = getNotificationType(claimed.typeKey);
  if (!type) {
    await repo.markEventFailed(pool, eventId, 'Unknown notification type');
    return { created: 0, pushed: 0 };
  }

  try {
    const policies = await repo.getTenantPolicyMap(pool);
    const policy = policies.get(type.typeKey);
    if (policy && !policy.isAllowed && type.preferenceMode !== 'MANDATORY') {
      await repo.markEventDone(pool, eventId);
      logger.info('Notification type disabled by tenant policy', {
        typeKey: type.typeKey,
        eventId,
        tenantId,
      });
      return { created: 0, pushed: 0 };
    }

    const lockScreenDetail = policy?.lockScreenDetail === true;
    const recipients = await resolveRecipients(
      pool,
      type,
      claimed.payload,
      claimed.storeLocationId,
      claimed.actorUserId,
    );
    const copy = lockScreenCopy(type, claimed.payload, lockScreenDetail);
    const actor = await repo.getActorIdentity(pool, claimed.actorUserId);
    const actorDisplay = actor?.display ?? payloadString(claimed.payload, 'actorDisplay');
    const actorRole = actor?.role ?? payloadString(claimed.payload, 'actorRole');
    const documentRef =
      payloadString(claimed.payload, 'documentRef') ||
      payloadString(claimed.payload, 'saleNumber') ||
      payloadString(claimed.payload, 'documentNumber');
    const locationLabel = payloadString(claimed.payload, 'locationLabel');
    const amountLabel = formatAmountLabel(claimed.payload.amount, claimed.payload.currency);
    const inboxBody = formatInboxBody({
      actorDisplay,
      actorRole,
      documentRef,
      locationLabel,
      amountLabel,
      fallback: copy.body,
    });
    const groupingKey = groupingKeyFor(
      type,
      claimed.storeLocationId,
      claimed.occurredAt ? new Date(claimed.occurredAt) : new Date(),
    );
    const priority = priorityFromType(type);
    const navigationPath = type.navigationPath(claimed.entityId);
    const safePath = isSafeNavigationPath(navigationPath) ? navigationPath : null;
    const pushBody = lockScreenDetail
      ? copy.body
      : [actorDisplay, copy.body].filter(Boolean).join(' · ');

    let created = 0;
    let pushed = 0;

    const prefMaps = await repo.getUserPreferenceMaps(pool, recipients);
    const profiles = await repo.listUserNotificationProfiles(pool, recipients);
    const inboxUserIds: string[] = [];
    const pushUserIds: string[] = [];
    for (const recipientId of recipients) {
      const profile = profiles.get(recipientId);
      const role = resolveRoleProfile(profile?.role, profile?.rbacNames ?? []);
      const prefs = preferenceFor(type, prefMaps.get(recipientId) ?? new Map(), role);
      const isTest = type.typeKey === 'NOTIFICATION_TEST';
      if (!isTest && !prefs.inAppEnabled && !prefs.pushEnabled) {
        logger.info('Notification decision', {
          eventId,
          typeKey: type.typeKey,
          tenantId,
          recipientUserId: recipientId,
          role,
          authorized: true,
          userInApp: false,
          userPush: false,
          decision: 'user_opted_out',
        });
        continue;
      }
      inboxUserIds.push(recipientId);
      if (isTest || prefs.pushEnabled) pushUserIds.push(recipientId);
      logger.info('Notification decision', {
        eventId,
        typeKey: type.typeKey,
        tenantId,
        recipientUserId: recipientId,
        role,
        authorized: true,
        userInApp: prefs.inAppEnabled,
        userPush: prefs.pushEnabled,
        preferenceMode: type.preferenceMode,
        decision: prefs.pushEnabled ? 'send_in_app_and_push' : 'in_app_only',
      });
    }

    const devicesByUser = await repo.listActivePushSubscriptionsForUsers(pool, pushUserIds);
    const allDeviceIds = [...devicesByUser.values()].flat().map((device) => device.id);
    const devicePrefMaps = await repo.getDeviceTypePreferenceMaps(pool, allDeviceIds);

    for (const recipientId of inboxUserIds) {
      const inbox = await repo.insertInbox(pool, {
        eventId: claimed.id,
        recipientUserId: recipientId,
        typeKey: type.typeKey,
        severity: type.severity,
        title: copy.title,
        body: inboxBody,
        entityType: claimed.entityType,
        entityId: claimed.entityId,
        navigationPath: safePath,
        actorUserId: claimed.actorUserId,
        actorDisplay,
        documentRef,
        locationLabel,
        groupingKey,
        priority,
      });
      if (!inbox) continue;
      created += 1;

      await repo.insertDelivery(pool, {
        notificationId: inbox.id,
        subscriptionId: null,
        channel: 'IN_APP',
        status: 'SUBMITTED',
        providerResponseCategory: 'in_app_persisted',
      });

      if (!pushUserIds.includes(recipientId)) continue;

      const devices = devicesByUser.get(recipientId) ?? [];
      for (const device of devices) {
        const devicePrefs = devicePrefMaps.get(device.id) ?? new Map();
        const devicePush = resolveDevicePush({
          userPushWanted: true,
          devicePushEnabled: device.pushEnabled,
          deviceRevoked: Boolean(device.revokedAt),
          deviceTypePref: devicePrefs.has(type.typeKey) ? devicePrefs.get(type.typeKey) : undefined,
        });
        logger.info('Notification device decision', {
          eventId,
          typeKey: type.typeKey,
          tenantId,
          recipientUserId: recipientId,
          subscriptionId: device.id,
          platformHint: device.platformHint,
          decision: devicePush.reason,
        });
        if (!devicePush.push) continue;
        if (await repo.hasSubmittedWebPush(pool, inbox.id, device.id)) {
          continue;
        }

        const deliveryId = await repo.insertDelivery(pool, {
          notificationId: inbox.id,
          subscriptionId: device.id,
          channel: 'WEB_PUSH',
          status: 'QUEUED',
        });

        const result = await sendPushTracked(pool, deliveryId, device, {
          notificationId: inbox.id,
          typeKey: type.typeKey,
          title: copy.title,
          body: pushBody,
          path: safePath,
          severity: type.severity,
        });
        if (result.status === 'SUBMITTED') pushed += 1;
      }
    }

    await repo.markEventDone(pool, eventId);
    logger.info('Notification event processed', {
      eventId,
      typeKey: type.typeKey,
      tenantId,
      recipientCount: recipients.length,
      created,
      pushed,
    });
    return { created, pushed };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await repo.markEventFailed(pool, eventId, message);
    logger.error('Notification event processing failed', {
      eventId,
      typeKey: claimed.typeKey,
      tenantId,
      error: message,
    });
    throw err;
  }
}

async function sendPushTracked(
  pool: Pool,
  deliveryId: string,
  device: repo.DeviceSubscriptionRow,
  payload: {
    notificationId: string;
    typeKey: string;
    title: string;
    body: string;
    path: string | null;
    severity: string;
  },
): Promise<PushSendResult> {
  const result = await deliverWebPush(
    {
      endpoint: device.endpoint,
      keys: { p256dh: device.p256dh, auth: device.auth },
    },
    payload,
  );

  await repo.updateDelivery(pool, deliveryId, {
    status: result.status,
    providerStatus: result.providerStatus,
    providerResponseCategory: result.category,
    errorReason: result.errorReason,
  });

  if (result.status === 'INVALID_SUBSCRIPTION') {
    await repo.revokeDeviceByEndpoint(pool, device.endpoint);
    logger.info('Revoked invalid push subscription', {
      subscriptionId: device.id,
      category: result.category,
    });
  }

  return result;
}

export async function sweepPendingNotificationEvents(pool: Pool, tenantId: string | null): Promise<number> {
  const pending = await repo.listPendingEvents(pool, 25);
  let processed = 0;
  for (const event of pending) {
    try {
      await processNotificationEvent(pool, event.id, tenantId);
      processed += 1;
    } catch {
      // already marked failed
    }
  }
  return processed;
}
