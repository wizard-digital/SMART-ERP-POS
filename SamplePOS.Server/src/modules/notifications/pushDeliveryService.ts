import logger from '../../utils/logger.js';

export type PushDeliveryStatus = 'SUBMITTED' | 'FAILED' | 'EXPIRED' | 'INVALID_SUBSCRIPTION';

export interface PushSendResult {
  status: PushDeliveryStatus;
  providerStatus: number | null;
  category: string;
  errorReason: string | null;
}

export interface WebPushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

import { ensureVapidKeys } from './vapidKeys.js';

export function getVapidPublicKey(): string | null {
  ensureVapidKeys();
  return process.env.VAPID_PUBLIC_KEY || null;
}

export function isWebPushConfigured(): boolean {
  ensureVapidKeys();
  return Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

function vapidSubject(): string {
  const raw = (process.env.VAPID_SUBJECT || 'mailto:ops@localhost').trim();
  return raw.replace(/\s+/g, '');
}

type WebPushModule = {
  setVapidDetails: (subject: string, publicKey: string, privateKey: string) => void;
  sendNotification: (
    subscription: WebPushSubscription,
    payload: string,
    options?: { TTL?: number; urgency?: string },
  ) => Promise<{ statusCode?: number }>;
};

let webPushLoaded: WebPushModule | null | undefined;

async function loadWebPush(): Promise<WebPushModule | null> {
  if (webPushLoaded !== undefined) return webPushLoaded;
  try {
    const mod = (await import('web-push')) as { default?: WebPushModule } & WebPushModule;
    webPushLoaded = mod.default ?? mod;
    return webPushLoaded;
  } catch {
    webPushLoaded = null;
    return null;
  }
}

/**
 * SUBMITTED means the push service accepted the request.
 * This is not proof that the device displayed the notification.
 */
export async function deliverWebPush(
  subscription: WebPushSubscription,
  payload: Record<string, unknown>,
): Promise<PushSendResult> {
  if (!isWebPushConfigured()) {
    return {
      status: 'FAILED',
      providerStatus: null,
      category: 'vapid_unconfigured',
      errorReason: 'VAPID keys are not configured',
    };
  }

  const webpush = await loadWebPush();
  if (!webpush) {
    return {
      status: 'FAILED',
      providerStatus: null,
      category: 'web_push_module_missing',
      errorReason: 'web-push is not installed',
    };
  }

  try {
    webpush.setVapidDetails(
      vapidSubject(),
      process.env.VAPID_PUBLIC_KEY as string,
      process.env.VAPID_PRIVATE_KEY as string,
    );
    const response = await webpush.sendNotification(subscription, JSON.stringify(payload), {
      TTL: 86400,
      urgency: 'normal',
    });
    const statusCode = response?.statusCode ?? 201;
    logger.info('Web push submitted', {
      category: 'web_push_accepted',
      providerStatus: statusCode,
      typeKey: payload.typeKey,
      notificationId: payload.notificationId,
    });
    return {
      status: 'SUBMITTED',
      providerStatus: statusCode,
      category: 'web_push_accepted',
      errorReason: null,
    };
  } catch (err: unknown) {
    const result = classifyWebPushFailure(err);
    logger.warn(`Web push submission failed (${result.providerStatus ?? 'no-status'} ${result.category}): ${result.errorReason || ''}`);
    return result;
  }
}

/** WNS/FCM often put the useful text in `message` and leave `body` empty. */
export function webPushErrorText(err: unknown): string {
  if (!err || typeof err !== 'object') return String(err);
  const rec = err as { body?: unknown; message?: unknown };
  const body = rec.body != null ? String(rec.body).trim() : '';
  const message = rec.message != null ? String(rec.message).trim() : '';
  return (body || message || 'Push service rejected the request').slice(0, 300);
}

/**
 * 401/403 from WNS and FCM mean this browser channel is dead (expired token or VAPID mismatch).
 * Only 404/410 were treated as gone, so Edge/Windows kept a "registered" row that could never send.
 */
export function classifyWebPushFailure(err: unknown): PushSendResult {
  const statusCode =
    typeof err === 'object' && err && 'statusCode' in err
      ? Number((err as { statusCode?: number }).statusCode)
      : null;
  const errorReason = webPushErrorText(err);

  if (statusCode === 404 || statusCode === 410 || statusCode === 401 || statusCode === 403) {
    return {
      status: 'INVALID_SUBSCRIPTION',
      providerStatus: statusCode,
      category: statusCode === 401 || statusCode === 403 ? 'subscription_unauthorized' : 'subscription_gone',
      errorReason,
    };
  }
  if (statusCode === 413) {
    return {
      status: 'FAILED',
      providerStatus: statusCode,
      category: 'payload_too_large',
      errorReason,
    };
  }
  if (statusCode === 429) {
    return {
      status: 'FAILED',
      providerStatus: statusCode,
      category: 'rate_limited',
      errorReason,
    };
  }
  return {
    status: 'FAILED',
    providerStatus: Number.isFinite(statusCode) ? statusCode : null,
    category: 'web_push_rejected',
    errorReason,
  };
}

export function describePushTestOutcome(input: {
  vapidConfigured: boolean;
  devicesRegistered: number;
  created: number;
  pushed: number;
  deliveries: Array<{
    status: string;
    providerStatus: number | null;
    category: string | null;
    errorReason: string | null;
  }>;
}): { status: 'submitted' | 'queued' | 'device_not_registered' | 'failed'; reason: string } {
  if (!input.vapidConfigured) {
    return {
      status: 'queued',
      reason: 'In-app notification created. Push is not configured on the server (VAPID keys missing).',
    };
  }
  if (input.devicesRegistered === 0) {
    return {
      status: 'device_not_registered',
      reason: 'No active push subscription on this account. Enable notifications on this device first.',
    };
  }
  if (input.pushed > 0) {
    return {
      status: 'submitted',
      reason: 'Push request accepted by the push service. This is not proof the device displayed it.',
    };
  }
  const invalid = input.deliveries.find((row) => row.status === 'INVALID_SUBSCRIPTION');
  if (invalid) {
    return {
      status: 'failed',
      reason:
        'This device\'s lock-screen channel expired or was rejected (HTTP '
        + `${invalid.providerStatus ?? 'unknown'}). Enable notifications on this device again.`,
    };
  }
  const rejected = input.deliveries.find((row) => row.status === 'FAILED');
  if (rejected) {
    return {
      status: 'failed',
      reason:
        rejected.errorReason
        || `Push service rejected the request (${rejected.providerStatus ?? 'no status'}).`,
    };
  }
  return {
    status: 'failed',
    reason: 'Push was not submitted. The in-app notification was created; lock-screen push did not run.',
  };
}
