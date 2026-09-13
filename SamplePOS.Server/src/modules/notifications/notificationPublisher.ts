import type { Pool } from 'pg';
import logger from '../../utils/logger.js';
import { jobQueue } from '../../services/jobQueue.js';
import {
  getNotificationType,
  isNotificationTypeKey,
  type NotificationTypeKey,
} from './catalog.js';
import * as repo from './notificationRepository.js';
import { processNotificationEvent } from './notificationWorker.js';

export interface PublishNotificationInput {
  pool: Pool;
  tenantId?: string | null;
  typeKey: NotificationTypeKey | string;
  entityType: string;
  entityId: string;
  idempotencyKey: string;
  payload?: Record<string, unknown>;
  actorUserId?: string | null;
  storeLocationId?: string | null;
  subjectUserId?: string | null;
}

/**
 * Record a business event for notification processing.
 * Never throws to the caller — ERP transactions must not depend on push.
 */
export function publishNotificationEvent(input: PublishNotificationInput): void {
  void persistAndProcess(input).catch((err: unknown) => {
    logger.error('Notification outbox persist failed (non-blocking)', {
      typeKey: input.typeKey,
      entityId: input.entityId,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

async function persistAndProcess(input: PublishNotificationInput): Promise<void> {
  if (!isNotificationTypeKey(input.typeKey) || !getNotificationType(input.typeKey)) {
    logger.warn('Unknown notification type ignored', { typeKey: input.typeKey });
    return;
  }

  const payload = {
    ...(input.payload || {}),
    ...(input.subjectUserId ? { subjectUserId: input.subjectUserId } : {}),
  };

  const event = await repo.insertEvent(input.pool, {
    typeKey: input.typeKey,
    entityType: input.entityType,
    entityId: input.entityId,
    idempotencyKey: input.idempotencyKey,
    payload,
    actorUserId: input.actorUserId ?? null,
    storeLocationId: input.storeLocationId ?? null,
  });
  if (!event) return;

  if (input.tenantId) {
    try {
      await jobQueue.addJob(
        'notifications',
        'PROCESS_EVENT',
        { tenantId: input.tenantId, eventId: event.id },
        { jobId: `notif:${input.tenantId}:${event.idempotencyKey}`, removeOnComplete: 100 },
      );
    } catch (err: unknown) {
      logger.warn('Notification queue enqueue failed — processing locally', {
        eventId: event.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await processNotificationEvent(input.pool, event.id, input.tenantId ?? null);
}
