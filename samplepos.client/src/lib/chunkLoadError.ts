/**
 * Lazy-route / Vite chunk load failures.
 * Offline integrity: typed error + cause preserved — never a silent reload loop.
 */

import {
  OfflineIntegrityCode,
  reportOfflineIntegrityEvent,
} from './offlineIntegrity';

export const OFFLINE_MODULE_ERROR = 'OFFLINE_MODULE_LOAD';

export function isLikelyOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

export function isChunkOrNetworkLoadError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  const name = err instanceof Error ? err.name : '';
  return (
    name === 'ChunkLoadError' ||
    name === OFFLINE_MODULE_ERROR ||
    /loading chunk|failed to fetch|networkerror|dynamically imported module|importing a module script failed|load failed|net::err_/i.test(
      msg,
    )
  );
}

export function createOfflineModuleError(
  cause?: unknown,
  code: OfflineIntegrityCode = OfflineIntegrityCode.CHUNK_LOAD_OFFLINE,
): Error {
  const err = new Error(
    'This screen is not available offline yet. Reconnect, open it once online (or wait for cache warm-up), then retry.',
  );
  err.name = OFFLINE_MODULE_ERROR;
  if (cause !== undefined) {
    Object.defineProperty(err, 'cause', { value: cause, enumerable: false });
  }
  reportOfflineIntegrityEvent(code, err.message, cause, {
    offline: isLikelyOffline(),
    href: typeof location !== 'undefined' ? location.pathname : undefined,
  });
  return err;
}

export function isOfflineModuleError(err: unknown): boolean {
  return err instanceof Error && err.name === OFFLINE_MODULE_ERROR;
}
