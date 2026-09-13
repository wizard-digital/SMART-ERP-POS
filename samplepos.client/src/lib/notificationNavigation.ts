/**
 * Deep-link helpers. Push payloads are not authorization.
 * Paths must be in-app relative routes.
 */

const FALLBACK = '/settings/notifications';

export function isNotificationId(value: string | null | undefined): boolean {
  if (!value) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function resolveAuthorizedNotificationPath(path: unknown): string {
  if (typeof path !== 'string') return FALLBACK;
  if (!path.startsWith('/')) return FALLBACK;
  if (path.startsWith('//')) return FALLBACK;
  if (path.includes('\\')) return FALLBACK;
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return FALLBACK;
  return path;
}

/** Split an in-app path so React Router object-navigate does not stuff `?query` into pathname. */
export function toInAppLocation(path: unknown): { pathname: string; search: string } {
  const safe = resolveAuthorizedNotificationPath(path);
  const q = safe.indexOf('?');
  if (q < 0) return { pathname: safe, search: '' };
  return { pathname: safe.slice(0, q), search: safe.slice(q) };
}

export function appendNotificationQuery(path: string, nid: string | null | undefined): string {
  if (!isNotificationId(nid)) return path;
  const [pathname, search = ''] = path.split('?');
  const params = new URLSearchParams(search);
  params.set('nid', nid as string);
  return `${pathname}?${params.toString()}`;
}

export function notificationIdFromPath(path: string | null | undefined): string | null {
  if (!path || !path.includes('?')) return null;
  const nid = new URLSearchParams(path.slice(path.indexOf('?') + 1)).get('nid');
  return isNotificationId(nid) ? nid : null;
}

export function locationFromState(from: { pathname?: string; search?: string } | undefined): string | undefined {
  if (!from?.pathname) return undefined;
  return `${from.pathname}${from.search || ''}`;
}

export type InboxOperatorFilter = 'attention' | 'waiting' | 'cash' | 'all';

export function inboxMatchesFilter(
  operatorBand: string | null | undefined,
  filter: InboxOperatorFilter,
): boolean {
  if (filter === 'all') return true;
  if (filter === 'attention') {
    return operatorBand === 'EXCEPTIONS' || operatorBand === 'SECURITY' || operatorBand === 'SYSTEM';
  }
  if (filter === 'waiting') return operatorBand === 'APPROVALS';
  if (filter === 'cash') return operatorBand === 'MONEY';
  return true;
}
