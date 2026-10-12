/**
 * Offline password login credentials — multi-user cache for when the network
 * or API is unavailable after a successful online login.
 *
 * Independent of online JWT/refresh death: `clearTokens()` / forceLogout must
 * NOT wipe this store so staff can still open `/login` offline with last password.
 *
 * PIN quick-login is online-only (server bcrypt + device trust); offline is password only.
 *
 * CRITICAL (identity isolation):
 * Never reuse a prior user's JWT/refresh token for a different offline actor.
 * Never leave a prior refresh token in storage when establishing an offline session —
 * keepalive / interceptors would otherwise revive the previous server identity.
 */

import type { UserRole } from '../types';
import { persistLocalStorage } from './originStorageQuota';

export const OFFLINE_CREDENTIALS_KEY = 'offline_login_credentials';
export const OFFLINE_CREDENTIALS_LEGACY_KEY = 'offline_login_credential';
export const MAX_OFFLINE_USERS = 10;
export const OFFLINE_SESSION_TOKEN_PREFIX = 'offline-session-';

const SUBTLE_AVAILABLE = typeof crypto !== 'undefined' && !!crypto.subtle;

export type HashMethod = 'pbkdf2' | 'basic';

export type OfflineAuthUser = { id: string; email: string; fullName: string; role: UserRole };

export interface OfflineCachedUser {
  email: string;
  hash: string;
  salt: string;
  method?: HashMethod;
  user: OfflineAuthUser;
  cachedAt: number;
}

export function getHashMethod(): HashMethod {
  return SUBTLE_AVAILABLE ? 'pbkdf2' : 'basic';
}

export function isOfflineSessionToken(token: string | null | undefined): boolean {
  return typeof token === 'string' && token.startsWith(OFFLINE_SESSION_TOKEN_PREFIX);
}

function cyrb53(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return n.toString(16).padStart(16, '0');
}

function deriveKeyBasic(password: string, saltHex: string): string {
  let current = `${saltHex}:${password}`;
  for (let i = 0; i < 5000; i++) {
    current = cyrb53(current + ':' + saltHex, i);
  }
  return current;
}

function parseSaltBytes(saltHex: string): Uint8Array | null {
  const cleaned = String(saltHex || '').trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(cleaned) || cleaned.length % 2 !== 0 || cleaned.length < 16) {
    return null;
  }
  const pairs = cleaned.match(/.{2}/g);
  if (!pairs) return null;
  return new Uint8Array(pairs.map((b) => parseInt(b, 16)));
}

export async function deriveKey(
  password: string,
  saltHex: string,
  method?: HashMethod,
): Promise<string> {
  const useMethod = method || getHashMethod();

  if (useMethod === 'pbkdf2' && SUBTLE_AVAILABLE) {
    const salt = parseSaltBytes(saltHex);
    if (!salt) {
      // Corrupt cache entry — fall back so login does not throw
      return deriveKeyBasic(password, saltHex);
    }
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      enc.encode(password),
      'PBKDF2',
      false,
      ['deriveBits'],
    );
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' },
      keyMaterial,
      256,
    );
    return Array.from(new Uint8Array(bits))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  return deriveKeyBasic(password, saltHex);
}

export function randomSalt(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function cacheLoginCredential(
  email: string,
  password: string,
  user: OfflineAuthUser,
): Promise<void> {
  const normalEmail = email.toLowerCase().trim();
  const salt = randomSalt();
  const hash = await deriveKey(password, salt);

  let credentials: OfflineCachedUser[] = [];
  try {
    const parsed = JSON.parse(localStorage.getItem(OFFLINE_CREDENTIALS_KEY) || '[]');
    credentials = Array.isArray(parsed) ? parsed : [];
  } catch {
    /* corrupted — start fresh */
  }

  credentials = credentials.filter((c) => c && c.email !== normalEmail);
  credentials.push({
    email: normalEmail,
    hash,
    salt,
    method: getHashMethod(),
    user,
    cachedAt: Date.now(),
  });

  if (credentials.length > MAX_OFFLINE_USERS) {
    credentials.sort((a, b) => (b.cachedAt || 0) - (a.cachedAt || 0));
    credentials = credentials.slice(0, MAX_OFFLINE_USERS);
  }

  persistLocalStorage(OFFLINE_CREDENTIALS_KEY, JSON.stringify(credentials));
}

/** Validate offline login against cached credentials (multi-user). */
export async function validateOfflineLogin(
  email: string,
  password: string,
): Promise<OfflineAuthUser | null> {
  const normalEmail = email.toLowerCase().trim();
  if (!normalEmail || !password) return null;

  let credentials: OfflineCachedUser[] = [];
  try {
    const parsed = JSON.parse(localStorage.getItem(OFFLINE_CREDENTIALS_KEY) || '[]');
    credentials = Array.isArray(parsed) ? parsed : [];
  } catch {
    /* corrupted */
  }

  const entry = credentials.find((c) => c && c.email === normalEmail);
  if (entry && entry.hash && entry.salt && entry.user?.id) {
    const entryMethod: HashMethod = entry.method || 'pbkdf2';
    if (entryMethod === 'pbkdf2' && !SUBTLE_AVAILABLE) {
      return null;
    }
    try {
      const inputHash = await deriveKey(password, entry.salt, entryMethod);
      if (inputHash === entry.hash) return entry.user;
    } catch {
      return null;
    }
    return null;
  }

  // Fallback: migrate old single-user SHA-256 cache
  try {
    const raw = localStorage.getItem(OFFLINE_CREDENTIALS_LEGACY_KEY);
    if (raw && SUBTLE_AVAILABLE) {
      const { hash, user } = JSON.parse(raw) as {
        hash: string;
        user: OfflineAuthUser;
      };
      if (!hash || !user?.id) return null;
      const enc = new TextEncoder();
      const data = enc.encode(`${normalEmail}:${password}`);
      const buf = await crypto.subtle.digest('SHA-256', data);
      const oldHash = Array.from(new Uint8Array(buf))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      if (oldHash === hash) {
        void cacheLoginCredential(email, password, user);
        localStorage.removeItem(OFFLINE_CREDENTIALS_LEGACY_KEY);
        return user;
      }
    }
  } catch {
    /* old key corrupted or crypto unavailable */
  }

  return null;
}

export function generateOfflineToken(): string {
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${OFFLINE_SESSION_TOKEN_PREFIX}${Date.now()}-${id}`;
}

/**
 * Wipe prior online identity and mint a new offline-session token.
 * Must be called before AuthContext.login for offline password auth.
 *
 * Preserves offline_login_credentials always.
 * Preserves rbac_permissions only when the same user.id is re-authenticating
 * (so offline POS keeps last known permissions for that actor).
 */
export function beginOfflineLoginSession(user: OfflineAuthUser): string {
  let sameUser = false;
  try {
    const raw = localStorage.getItem('user');
    if (raw) {
      const prev = JSON.parse(raw) as { id?: string };
      sameUser = Boolean(prev?.id && user?.id && prev.id === user.id);
    }
  } catch {
    sameUser = false;
  }

  // Never keep previous actor's JWT / refresh — identity isolation
  localStorage.removeItem('auth_token');
  localStorage.removeItem('refresh_token');
  localStorage.removeItem('token_expiry');
  localStorage.removeItem('refresh_lock');

  if (!sameUser) {
    localStorage.removeItem('rbac_permissions');
  }

  return generateOfflineToken();
}

/** True when session death wipe must leave offline password cache intact. */
export function offlineCredentialsSurvivesClearTokens(keysRemoved: string[]): boolean {
  return (
    !keysRemoved.includes(OFFLINE_CREDENTIALS_KEY) &&
    !keysRemoved.includes(OFFLINE_CREDENTIALS_LEGACY_KEY)
  );
}

/**
 * forceLogout / peer LOGOUT must stop on auth recovery surfaces so
 * /login (offline password) and /quick-login (PIN) remain usable.
 * Includes `/my/quick-login` (cashier/waiter PIN setup) — same recovery family.
 * Includes `/settings/security` so expired-password / 2FA setup is not interrupted.
 */
export function isAuthRecoveryPath(pathname: string): boolean {
  const path = pathname || '';
  if (path === '/login' || path.endsWith('/login')) return true;
  if (path.startsWith('/platform')) return true;
  // Any quick-login surface: /quick-login, /quick-login/*, /my/quick-login
  if (/(^|\/)quick-login(\/|$)/.test(path)) return true;
  if (path === '/settings/security') return true;
  return false;
}

/**
 * RBAC cache is only safe to reuse when it belongs to the same actor.
 * Call BEFORE overwriting `user` in localStorage when establishing a new session.
 */
export function peekCachedPermissionKeysForUser(userId: string | null | undefined): string[] | null {
  if (!userId) return null;
  try {
    const rawUser = localStorage.getItem('user');
    if (!rawUser) return null;
    const prev = JSON.parse(rawUser) as { id?: string };
    if (!prev?.id || prev.id !== userId) return null;
    const rawPerms = localStorage.getItem('rbac_permissions');
    if (!rawPerms) return null;
    const parsed = JSON.parse(rawPerms) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((p): p is string => typeof p === 'string');
  } catch {
    return null;
  }
}
