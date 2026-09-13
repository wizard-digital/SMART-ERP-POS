import { createContext, useContext, useState, useEffect, useCallback, ReactNode, useMemo, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { storeTokens, clearTokens, getRefreshToken, getAccessToken, setupAxiosInterceptors, isTokenExpired, willExpireInNext, refreshAccessTokenDeduped, resetAuthState, forceLogoutRedirect } from '../hooks/useTokenRefresh';
import { apiClient } from '../utils/api';
import { useIdleTimeout } from '../hooks/useIdleTimeout';
import { useSessionKeepalive } from '../hooks/useSessionKeepalive';
import { useGlobalSessionActivity } from '../hooks/useGlobalSessionActivity';
import { setupAuthBroadcastListener, onAuthBroadcast, broadcastAuthEvent } from '../lib/authBroadcast';
import { setupOfflineQueueAutoFlush } from '../lib/offlineRequestQueue';
import { setupSessionResumeAuth } from '../lib/sessionResumeCoordinator';
import { takeRememberedSubscriptionId, clearRememberedSubscriptionId } from '../lib/pushSubscription';
// INVARIANT_SESSION_RESUME_INTEGRITY_v1 — proactive tab-resume auth + TOKEN_REFRESH peer sync
import { isUserActiveOrGuarded, isTransactionGuardActive } from '../lib/sessionActivity';
import {
  shouldPerformIdleLogout,
} from '../lib/sessionLogoutPolicy';
import {
  COLD_START_QUICK_LOGIN_HREF,
  markBrowserSessionAlive,
  markLoginGrace,
  shouldEnforceColdStartPinGate,
} from '../lib/sessionColdStartLock';
import {
  assertSessionWiped,
  beaconRevokeRefreshToken,
  clearActorLock,
  getDeviceSessionMode,
  idleTimeoutMsForMode,
  lockSharedSessionOnUnload,
} from '../lib/deviceSessionPolicy';
import { isAuthRecoveryPath, peekCachedPermissionKeysForUser } from '../lib/offlineLoginCredentials';
import { refreshRestaurantFloorSession } from '../lib/restaurantFloorSession';
import { persistAuthStorage } from '../lib/originStorageQuota';
import '../lib/offlineEventJournal';
import type { AxiosError } from 'axios';
import { HandledApiError, isHandledForbiddenError } from '../utils/errorHandler';
import type { UserRole } from '../types';

interface User {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
}

interface AuthContextType {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  /** Pre-loaded permission keys (session-embedded, no async race) */
  permissions: Set<string>;
  /** RBAC role display names from /rbac/me/permissions (for FOH ownership override). */
  rbacRoleNames: string[];
  /** Force re-fetch permissions (e.g. after role change) */
  refreshPermissions: () => Promise<void>;
  login: (userData: User, token: string, refreshToken?: string, expiresIn?: number) => Promise<void>;
  logout: () => void;
}

const EMPTY_PERMISSIONS = new Set<string>();

const AuthContext = createContext<AuthContextType | undefined>(undefined);

interface AuthProviderProps {
  children: ReactNode;
}

// Setup axios interceptors once on load
setupAxiosInterceptors();

type PermissionFetchResult = { keys: string[]; roleNames: string[] };

/**
 * Fetch permissions from /rbac/me/permissions using raw fetch (no axios dependency
 * risk during auth init). Returns permission keys + RBAC role names when present.
 * Empty keys means "unavailable / failed" — callers must not treat it as
 * "user has zero permissions" without consulting same-user cache policy.
 */
async function fetchPermissionPayload(): Promise<PermissionFetchResult> {
  try {
    const token = localStorage.getItem('auth_token');
    if (!token) return { keys: [], roleNames: [] };

    const baseUrl = import.meta.env.VITE_API_BASE_URL || '/api';
    const res = await fetch(`${baseUrl}/rbac/me/permissions`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      console.warn(`[Auth] Permission fetch HTTP ${res.status} — keeping prior same-user cache if any`);
      return { keys: [], roleNames: [] };
    }

    const json = await res.json();
    if (json.success && Array.isArray(json.data)) {
      const roleNames = new Set<string>();
      const keys = json.data.map((p: { permissionKey: string; roleName?: string }) => {
        if (p.roleName) roleNames.add(p.roleName);
        return p.permissionKey;
      });
      return { keys, roleNames: [...roleNames] };
    }
    console.warn('[Auth] Permission fetch returned unexpected shape');
    return { keys: [], roleNames: [] };
  } catch (err) {
    console.warn('[Auth] Permission fetch failed (offline/network):', err instanceof Error ? err.message : err);
    return { keys: [], roleNames: [] };
  }
}

export function AuthProvider({ children }: AuthProviderProps) {
  const queryClient = useQueryClient();
  const [user, setUser] = useState<User | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [permissionKeys, setPermissionKeys] = useState<string[]>([]);
  const [rbacRoleNames, setRbacRoleNames] = useState<string[]>([]);
  const pendingIdleLogoutRef = useRef(false);
  const isAuthenticatedRef = useRef(false);
  // Idle auto-logout: 60 minutes with no deliberate keyboard/mouse/touch (SSOT).
  // SHARED vs PERSONAL share the same window; walk-up security is actor-lock + cold-start PIN.
  const IDLE_TIMEOUT_MS = idleTimeoutMsForMode(getDeviceSessionMode());

  // Global activity — all modules/tabs (enterprise SSOT; independent of idle/guard)
  useGlobalSessionActivity(isAuthenticated);

  useEffect(() => {
    isAuthenticatedRef.current = isAuthenticated;
  }, [isAuthenticated]);

  // Proactive token refresh during long data-entry sessions (any module)
  useSessionKeepalive(isAuthenticated);

  const permissions = useMemo(() => {
    if (permissionKeys.length === 0) return EMPTY_PERMISSIONS;
    return new Set(permissionKeys);
  }, [permissionKeys]);

  useEffect(() => {
    // Initialize authentication state from localStorage
    // ERP pattern: load user + permissions BEFORE rendering routes
    const initAuth = async () => {
      try {
        let token = localStorage.getItem('auth_token');
        const savedUser = localStorage.getItem('user');

        if (token && savedUser) {
          const userData = JSON.parse(savedUser);

          // ── COLD-START / REBOOT PIN GATE (shared POS) ───────────────────────
          // localStorage survives reboot; sessionStorage does not. Without this,
          // the last cashier/waiter is silently restored and anyone can operate.
          if (
            shouldEnforceColdStartPinGate({
              role: userData.role,
              hasStoredSession: true,
            })
          ) {
            // Mandatory wipe + verify — never leave JWT material for the next opener.
            beaconRevokeRefreshToken(getRefreshToken());
            clearTokens();
            assertSessionWiped();
            const path = typeof window !== 'undefined' ? window.location.pathname : '';
            if (!isAuthRecoveryPath(path) && typeof window !== 'undefined') {
              window.location.replace(COLD_START_QUICK_LOGIN_HREF);
            }
            return;
          }

          // ── PROACTIVE TOKEN REFRESH (Fix #1 + #4) ───────────────────────────
          // initAuth() uses raw fetch() below which bypasses the axios interceptor.
          // Refresh here first if the access token is expired or within 2 min of
          // expiry so the profile validation gets a fresh token, not a 401.
          if (navigator.onLine && (isTokenExpired() || willExpireInNext(2)) && getRefreshToken()) {
            try {
              await refreshAccessTokenDeduped();
              token = getAccessToken() || localStorage.getItem('auth_token') || '';
            } catch {
              // _refreshOnce forceLogoutRedirect on definitive; never revive with a stale access token.
              if (!getAccessToken()) {
                if (!isAuthRecoveryPath(window.location.pathname)) {
                  forceLogoutRedirect('boot_refresh_failed');
                }
                return;
              }
              token = getAccessToken() || '';
            }
          }

          // ── SERVER-SIDE TOKEN VALIDATION ─────────────────────────────────────
          // SECURITY: Never trust localStorage alone. If online, verify the token
          // is still valid with the server before granting frontend access.
          // This prevents: expired sessions, revoked accounts, spoofed localStorage.
          if (navigator.onLine) {
            try {
              const profileController = new AbortController();
              const profileTimeout = setTimeout(() => profileController.abort(), 12_000);
              const validationRes = await apiClient.get('/auth/profile', {
                signal: profileController.signal,
              });
              clearTimeout(profileTimeout);
              // 200: sync role/id from server to prevent localStorage role spoofing
              if (validationRes.data?.success && validationRes.data?.data) {
                const serverUser = validationRes.data.data;
                userData.id = serverUser.id ?? userData.id;
                userData.email = serverUser.email ?? userData.email;
                userData.fullName = serverUser.fullName ?? serverUser.full_name ?? userData.fullName;
                userData.role = serverUser.role ?? userData.role;
                persistAuthStorage('user', JSON.stringify(userData));
              }
            } catch (err) {
              const handled = err instanceof HandledApiError ? err : null;
              const axErr = err as AxiosError;
              const status = handled?.httpStatus ?? axErr?.response?.status;
              const aborted =
                axErr?.code === 'ERR_CANCELED' ||
                axErr?.code === 'ECONNABORTED' ||
                axErr?.message?.includes('aborted');
              // RBAC / plan 403 must NEVER wipe the session (restaurant open used to).
              if (aborted || isHandledForbiddenError(err) || status === 403) {
                if (status === 403 || isHandledForbiddenError(err)) {
                  console.error(
                    '[Auth] Profile forbidden — keeping session; check RBAC / plan',
                    handled?.message || axErr?.message,
                  );
                }
                // Slow/unreachable API or forbidden profile — use cached session
              } else if (status === 401 || (!getAccessToken() && !getRefreshToken())) {
                // Must not set isAuthenticated with a dead/cleared session.
                forceLogoutRedirect(
                  status === 401 ? 'profile_rejected_401' : 'profile_rejected_no_token',
                );
                return;
              }
              // Network error or 5xx — allow cached access (offline support)
            }
          }
          // ─────────────────────────────────────────────────────────────────────

          // Refuse to paint authenticated shell without a usable access token.
          if (!getAccessToken() && !localStorage.getItem('auth_token')) {
            return;
          }
          // Lock must clear before we paint as authenticated (fail-loud).
          clearActorLock();
          markBrowserSessionAlive();
          setUser(userData);
          setIsAuthenticated(true);

          // Restore cached permissions immediately (prevents flash)
          const cachedPerms = localStorage.getItem('rbac_permissions');
          if (cachedPerms) {
            try {
              const parsed = JSON.parse(cachedPerms) as unknown;
              if (Array.isArray(parsed)) {
                setPermissionKeys(parsed.filter((p): p is string => typeof p === 'string'));
              } else {
                localStorage.removeItem('rbac_permissions');
              }
            } catch {
              console.warn('[Auth] Corrupt rbac_permissions cache — discarded');
              localStorage.removeItem('rbac_permissions');
            }
          }

          // Then fetch fresh permissions from server (updates cache)
          const freshPerms = await fetchPermissionPayload();
          if (freshPerms.keys.length > 0) {
            setPermissionKeys(freshPerms.keys);
            setRbacRoleNames(freshPerms.roleNames);
            persistAuthStorage('rbac_permissions', JSON.stringify(freshPerms.keys));
          }
        }
      } catch (error) {
        console.error('Error initializing auth:', error);
        // Never wipe a live session on non-auth failures (HandledApiError 403,
        // network blips, assert noise). Only definitive token absence.
        if (!getAccessToken() && !getRefreshToken()) {
          clearTokens();
        }
      } finally {
        setIsLoading(false);
      }
    };

    initAuth();

    // Cross-tab only: same-tab login/logout already apply React state.
    // Re-running initAuth on same-tab `auth-changed` re-applied SHARED cold-start
    // and bounced fresh logins to /quick-login (login → instant logout).
    const handleStorageChange = (event: StorageEvent) => {
      if (event.key === 'user') {
        void initAuth();
        return;
      }
      if (event.key === 'auth_token') {
        // Peer tab token rotation — skip heavy profile re-init (was freezing UI).
        if (event.newValue && isAuthenticatedRef.current) {
          resetAuthState();
          return;
        }
        void initAuth();
      }
    };

    window.addEventListener('storage', handleStorageChange);

    // ── Multi-tab broadcast: react to auth events from other tabs ──
    const cleanupBroadcastListener = setupAuthBroadcastListener();
    const unsubscribeBroadcast = onAuthBroadcast((event) => {
      if (event.type === 'LOGOUT') {
        clearTokens();
        setUser(null);
        setIsAuthenticated(false);
        setPermissionKeys([]);
        setRbacRoleNames([]);
        if (!isAuthRecoveryPath(window.location.pathname)) {
          window.location.replace(`${window.location.origin}/login`);
        }
        return;
      }
      if (event.type === 'SESSION_EXPIRED') {
        // Peer tab proved refresh is dead — never keep a working UI on a dead session.
        clearTokens();
        setUser(null);
        setIsAuthenticated(false);
        setPermissionKeys([]);
        setRbacRoleNames([]);
        try {
          sessionStorage.setItem('session_expired', '1');
        } catch {
          /* ignore */
        }
        if (!isAuthRecoveryPath(window.location.pathname)) {
          window.location.replace(`${window.location.origin}/login`);
        }
        return;
      }
      if (event.type === 'TOKEN_REFRESH') {
        // Peer refreshed — localStorage already has fresh tokens; unblock waiters.
        resetAuthState();
      }
    });

    const cleanupSessionResume = setupSessionResumeAuth(); // INVARIANT_SESSION_RESUME_INTEGRITY_v1

    // ── Offline queue: auto-flush pending mutations when connectivity returns ──
    const cleanupOfflineQueue = setupOfflineQueueAutoFlush(apiClient);

    return () => {
      window.removeEventListener('storage', handleStorageChange);
      cleanupBroadcastListener();
      unsubscribeBroadcast();
      cleanupOfflineQueue();
      cleanupSessionResume();
    };
  }, []);

  const login = async (userData: User, token: string, refreshToken?: string, expiresIn?: number) => {
    if (!token || token === 'undefined' || token.length < 20) {
      throw new Error('Invalid token received from server');
    }

    // Cross-tab FIRST: peer PC tabs fire storage→initAuth as soon as auth_token is written.
    // Grace must be in localStorage (and lock cleared) *before* that write, or SHARED
    // cold-start wipes the new session (phones usually single-tab — looked "fine").
    markLoginGrace();
    clearActorLock();

    // Snapshot prior actor BEFORE overwrite — RBAC cache is only safe for same user.id.
    const sameUserCachedPerms = peekCachedPermissionKeysForUser(userData.id);

    // Store tokens (fetchPermissionKeys reads from localStorage)
    if (refreshToken && expiresIn) {
      storeTokens(token, refreshToken, expiresIn);
    } else {
      // Access-only / offline session — never inherit prior RT (would revive wrong actor)
      localStorage.removeItem('refresh_token');
      localStorage.removeItem('token_expiry');
      persistAuthStorage('auth_token', token);
    }
    persistAuthStorage('user', JSON.stringify(userData));

    // ERP pattern: fetch permissions BEFORE marking authenticated
    // This prevents the race where routes render with empty permissions
    const perms = await fetchPermissionPayload();
    if (perms.keys.length > 0) {
      setPermissionKeys(perms.keys);
      setRbacRoleNames(perms.roleNames);
      persistAuthStorage('rbac_permissions', JSON.stringify(perms.keys));
    } else if (sameUserCachedPerms && sameUserCachedPerms.length > 0) {
      // Same actor offline / fetch miss — keep last known rights for that user only
      setPermissionKeys(sameUserCachedPerms);
    } else {
      // Different actor or no cache — never inherit foreign RBAC
      setPermissionKeys([]);
      setRbacRoleNames([]);
      localStorage.removeItem('rbac_permissions');
    }

    // NOW set authenticated — routes will render with permissions already loaded.
    markBrowserSessionAlive();
    setUser(userData);
    setIsAuthenticated(true);
    resetAuthState();

    // FOH session isolation: drop prior actor floor RQ so User B never paints User A.
    refreshRestaurantFloorSession(queryClient);

    // Same-tab listeners (e.g. POSPage) — AuthProvider does NOT re-initAuth on this.
    window.dispatchEvent(new Event('auth-changed'));
  };

  /** Force re-fetch permissions from server */
  const refreshPermissions = useCallback(async () => {
    const perms = await fetchPermissionPayload();
    if (perms.keys.length > 0) {
      setPermissionKeys(perms.keys);
      setRbacRoleNames(perms.roleNames);
      persistAuthStorage('rbac_permissions', JSON.stringify(perms.keys));
    }
  }, []);

  const logout = useCallback(() => {
    try {
      // Revoke refresh token server-side (fire-and-forget)
      const refreshToken = getRefreshToken();
      const baseUrl = import.meta.env.VITE_API_BASE_URL || '/api';
      const token = localStorage.getItem('auth_token');
      if (refreshToken) {
        fetch(`${baseUrl}/auth/logout`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ refreshToken }),
          credentials: 'include',
        }).catch(() => { /* best-effort — don't block local cleanup */ });
      }
      // Shared-terminal POS: revoke THIS installation only so the next user
      // cannot receive the previous user's tenant pushes. Other devices stay.
      try {
        const subId = takeRememberedSubscriptionId();
        if (subId && token && /^[0-9a-f-]{36}$/i.test(subId)) {
          fetch(`${baseUrl}/notifications/devices/${subId}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token}` },
            credentials: 'include',
          }).catch(() => { /* best-effort */ });
        }
        clearRememberedSubscriptionId();
      } catch {
        /* ignore */
      }

      // Broadcast to other tabs before clearing tokens
      broadcastAuthEvent({ type: 'LOGOUT' });

      // Clear all tokens using the single authority (also removes user + rbac_permissions)
      clearTokens();
      assertSessionWiped();
      try {
        clearActorLock();
      } catch (lockErr) {
        // Tokens already wiped — lock residue still fail-closes next boot. Surface loudly.
        console.error('[Auth] Actor lock clear failed after logout wipe:', lockErr);
      }
      setUser(null);
      setIsAuthenticated(false);
      setPermissionKeys([]);
      setRbacRoleNames([]);

      // Drop floor cache so next login cannot reuse this session's RQ entries.
      refreshRestaurantFloorSession(queryClient);

      // Notify other tabs/components about auth change
      window.dispatchEvent(new Event('auth-changed'));
    } catch (error) {
      console.error('Error during logout:', error);
    }
  }, [queryClient]);

  // ── Auto-logout on idle (device-mode aware) ────────────────────────────────
  const idleLogout = useCallback(() => {
    // SAP/Odoo: never idle-logout while this or any peer tab is still working.
    if (!shouldPerformIdleLogout(isUserActiveOrGuarded(IDLE_TIMEOUT_MS))) {
      return;
    }
    if (isTransactionGuardActive()) {
      pendingIdleLogoutRef.current = true;
      return;
    }
    pendingIdleLogoutRef.current = false;
    logout();
    try {
      sessionStorage.setItem('session_expired', '1');
    } catch {
      /* ignore */
    }
    // Hard nav so SPA cannot remain on a protected module after idle wipe
    if (!isAuthRecoveryPath(window.location.pathname)) {
      window.location.replace(`${window.location.origin}/login`);
    }
  }, [logout, IDLE_TIMEOUT_MS]);

  useEffect(() => {
    const onGuard = (e: Event) => {
      const detail = (e as CustomEvent<{ active?: boolean }>).detail;
      if (detail?.active) return;
      if (!pendingIdleLogoutRef.current) return;
      if (!shouldPerformIdleLogout(isUserActiveOrGuarded(IDLE_TIMEOUT_MS))) {
        pendingIdleLogoutRef.current = false;
        return;
      }
      pendingIdleLogoutRef.current = false;
      logout();
      try {
        sessionStorage.setItem('session_expired', '1');
      } catch {
        /* ignore */
      }
      if (!isAuthRecoveryPath(window.location.pathname)) {
        window.location.replace(`${window.location.origin}/login`);
      }
    };
    window.addEventListener('app:transaction-guard', onGuard);
    return () => window.removeEventListener('app:transaction-guard', onGuard);
  }, [logout, IDLE_TIMEOUT_MS]);

  // SHARED POS (Toast/Square): browser/tab CLOSE = full logout so the next
  // person cannot inherit this account. Capture RT before wipe (beforeunload
  // may run first). bfcache (persisted) skips entirely. Tab switches do not
  // fire pagehide — multi-tab work stays alive.
  useEffect(() => {
    if (!isAuthenticated) return;

    const destroySharedSession = (destroySession: boolean) => {
      // Snapshot RT before clearTokens — second event (pagehide after beforeunload)
      // would otherwise beacon with null.
      const refreshToken = getRefreshToken();
      lockSharedSessionOnUnload({
        mode: getDeviceSessionMode(),
        clearSession: clearTokens,
        refreshToken,
        destroySession,
      });
    };

    const onPageHide = (e: PageTransitionEvent) => {
      destroySharedSession(!e.persisted);
    };

    const onBeforeUnload = () => {
      destroySharedSession(true);
    };

    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [isAuthenticated]);

  useIdleTimeout({
    timeoutMs: IDLE_TIMEOUT_MS,
    onIdle: idleLogout,
    onWarning: () => {
      window.dispatchEvent(new CustomEvent('app:session-warning'));
      console.warn('[Auth] Session expiring soon due to inactivity');
    },
    enabled: isAuthenticated,
  });

  return (
    <AuthContext.Provider value={{ user, isAuthenticated, isLoading, permissions, rbacRoleNames, refreshPermissions, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}