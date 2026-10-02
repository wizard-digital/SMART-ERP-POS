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
