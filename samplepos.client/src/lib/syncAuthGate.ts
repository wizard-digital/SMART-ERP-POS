/**
 * Terminal sync gate.
 *
 * A 401 or 403 means this terminal is logged out or lacks permission.
 * Those events stay in the journal, and the 30-second retry stops until
 * the next successful login stores a new token.
 *
 * Retryable failures stay on the queue: no HTTP response, 408, 429, and 5xx.
 * Any other HTTP status goes to review so it is not posted again every 30s.
 */

const PAUSE_KEY = 'pos_sync_paused_for_auth';

export type SyncPostDecision =
  | { kind: 'synced' }
  | { kind: 'offline-stop' }
  | { kind: 'auth-stop' }
  | { kind: 'retry'; message: string }
  | { kind: 'review'; message: string };

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export function isSyncPausedForAuth(): boolean {
  try {
    return sessionStorage.getItem(PAUSE_KEY) === '1';
  } catch {
    return false;
  }
}

export function pauseSyncForAuth(): void {
  try {
    sessionStorage.setItem(PAUSE_KEY, '1');
  } catch {
    /* private mode */
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('sync-auth-paused'));
  }
}

/** Called when a new access token is stored. Clears the pause for every tab. */
export function resumeSyncAfterAuth(): void {
  try {
    sessionStorage.removeItem(PAUSE_KEY);
  } catch {
    /* private mode */
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('sync-auth-resumed'));
  }
}

/**
 * A 409 from offline sync with success / alreadySynced is a saved duplicate.
 * It must not be shown as "conflicts with existing data", and the event must
 * leave the retry queue.
 */
export function isAlreadySyncedSyncResponse(error: {
  config?: { url?: string };
  response?: { status?: number; data?: unknown };
}): boolean {
  if (error.response?.status !== 409) return false;
  const url = error.config?.url ?? '';
  if (!url.includes('pos/sync-events')) return false;
  const body = error.response.data as
    | { success?: boolean; data?: { alreadySynced?: boolean } }
    | undefined;
  return body?.success === true || body?.data?.alreadySynced === true;
}

/** Read a thrown sync failure, including the interceptor's HandledApiError. */
export function readThrownSync(err: unknown): {
  network: boolean;
  status?: number;
  message: string;
} {
  if (err && typeof err === 'object' && (err as { isHandled?: boolean }).isHandled === true) {
    const handled = err as { httpStatus?: number; message?: string };
    return {
      network: false,
      status: handled.httpStatus,
      message: handled.message || 'Sync error',
    };
  }
  const ax = err as {
    code?: string;
    message?: string;
    response?: { status?: number; data?: { error?: unknown } };
  };
  const serverMsg = ax.response?.data?.error;
  return {
    network: ax.code === 'ERR_NETWORK' || !ax.response,
    status: ax.response?.status,
    message: (typeof serverMsg === 'string' ? serverMsg : '') || ax.message || 'Sync error',
  };
}

export function decideSyncPost(input: {
  network: boolean;
  online: boolean;
  status?: number;
  message: string;
}): SyncPostDecision {
  if (input.network || !input.online) return { kind: 'offline-stop' };
  const status = input.status;
  if (status === 409) return { kind: 'synced' };
  if (status === 401 || status === 403) return { kind: 'auth-stop' };
  if (status != null && RETRYABLE_STATUS.has(status)) {
    return { kind: 'retry', message: input.message };
  }
  return { kind: 'review', message: input.message };
}
