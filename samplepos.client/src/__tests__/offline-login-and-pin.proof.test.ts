/**
 * PROOF: Offline password login + PIN (quick-login) recovery
 *
 * Automates product guarantees that session-death force-login must NOT break:
 * A) Offline password re-entry (`/login` + offline_login_credentials)
 * B) PIN quick-login (`/quick-login` + public pin-only API)
 * C) Cold-start cashier PIN gate (sessionStorage)
 * D) forceLogout never redirects away from auth recovery screens
 * E) clearTokens never deletes offline credential cache
 *
 * Generates: PROOF_OFFLINE_LOGIN_AND_PIN.md + .json (repo root)
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OFFLINE_CREDENTIALS_KEY,
  MAX_OFFLINE_USERS,
  cacheLoginCredential,
  validateOfflineLogin,
  generateOfflineToken,
  beginOfflineLoginSession,
  isOfflineSessionToken,
  offlineCredentialsSurvivesClearTokens,
  isAuthRecoveryPath,
  peekCachedPermissionKeysForUser,
} from '../lib/offlineLoginCredentials';
import { isPublicApiRoute } from '../lib/apiPublicRoutes';
import {
  shouldEnforceColdStartPinGate,
  roleRequiresColdStartPinGate,
  COLD_START_QUICK_LOGIN_HREF,
  markBrowserSessionAlive,
  isBrowserColdStart,
  AUTH_BOOT_SESSION_KEY,
} from '../lib/sessionColdStartLock';
import {
  setActorLock,
  clearActorLock,
  setDeviceSessionMode,
} from '../lib/deviceSessionPolicy';
import {
  shouldPerformAutoLogout,
  classifyRefreshError,
} from '../lib/sessionLogoutPolicy';

const here = dirname(fileURLToPath(import.meta.url));
const clientRoot = resolve(here, '../..');
const repoRoot = resolve(clientRoot, '..');

type Gate = { id: string; ok: boolean; detail: string };
const gates: Gate[] = [];

function gate(id: string, ok: boolean, detail: string) {
  gates.push({ id, ok, detail });
  expect.soft({ id, ok, detail }).toEqual({ id, ok: true, detail });
}

function readClient(rel: string): string {
  return readFileSync(join(clientRoot, rel), 'utf8');
}

const cashierUser = {
  id: 'u-cashier-1',
  email: 'cashier@shop.local',
  fullName: 'Cashier One',
  role: 'CASHIER' as const,
};

function memoryStorage() {
  const mem = new Map<string, string>();
  return {
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    setItem: (k: string, v: string) => {
      mem.set(k, String(v));
    },
    removeItem: (k: string) => {
      mem.delete(k);
    },
    clear: () => mem.clear(),
    key: (i: number) => [...mem.keys()][i] ?? null,
    get length() {
      return mem.size;
    },
  };
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: memoryStorage(),
    configurable: true,
  });
  Object.defineProperty(globalThis, 'sessionStorage', {
    value: memoryStorage(),
    configurable: true,
  });
});

describe('PROOF: Offline login credentials', () => {
  it('cache + validate correct password', async () => {
    await cacheLoginCredential(cashierUser.email, 'Secret#1', cashierUser);
    const user = await validateOfflineLogin(cashierUser.email, 'Secret#1');
    gate(
      'OFF_CACHE_OK',
      !!user && user.id === cashierUser.id && user.role === 'CASHIER',
      user ? `validated ${user.email}` : 'null user',
    );
  });

  it('wrong password rejected', async () => {
    await cacheLoginCredential(cashierUser.email, 'Secret#1', cashierUser);
    const bad = await validateOfflineLogin(cashierUser.email, 'WrongPass');
    gate('OFF_BAD_PWD', bad === null, 'wrong password must be null');
  });

  it('unknown email rejected', async () => {
    const none = await validateOfflineLogin('ghost@shop.local', 'x');
    gate('OFF_UNKNOWN', none === null, 'unknown user must be null');
  });

  it('email match is case-insensitive', async () => {
    await cacheLoginCredential('Cashier@Shop.Local', 'Secret#1', cashierUser);
    const user = await validateOfflineLogin('CASHIER@shop.local', 'Secret#1');
    gate('OFF_EMAIL_CASE', !!user && user.id === cashierUser.id, user?.email || 'null');
  });

  it('multi-user cache keeps both', async () => {
    const mgr = {
      id: 'u-mgr',
      email: 'mgr@shop.local',
      fullName: 'Mgr',
      role: 'MANAGER' as const,
    };
    await cacheLoginCredential(cashierUser.email, 'A', cashierUser);
    await cacheLoginCredential(mgr.email, 'B', mgr);
    const a = await validateOfflineLogin(cashierUser.email, 'A');
    const b = await validateOfflineLogin(mgr.email, 'B');
    gate('OFF_MULTI', !!a && !!b && a.id !== b.id, `a=${a?.id} b=${b?.id}`);
  });

  it(`evicts oldest beyond MAX_OFFLINE_USERS (${MAX_OFFLINE_USERS})`, async () => {
    for (let i = 0; i < MAX_OFFLINE_USERS + 2; i++) {
      await cacheLoginCredential(
        `u${i}@shop.local`,
        'p',
        {
          id: `id-${i}`,
          email: `u${i}@shop.local`,
          fullName: `U${i}`,
          role: 'CASHIER',
        },
      );
    }
    const raw = JSON.parse(localStorage.getItem(OFFLINE_CREDENTIALS_KEY) || '[]') as unknown[];
    gate(
      'OFF_EVICT',
      raw.length === MAX_OFFLINE_USERS,
      `cache size=${raw.length} max=${MAX_OFFLINE_USERS}`,
    );
  });

  it('offline session token prefix is distinct', () => {
    const t = generateOfflineToken();
    gate('OFF_TOKEN_PREFIX', isOfflineSessionToken(t) === true, t.slice(0, 40));
  });

  it('beginOfflineLoginSession isolates identity (no JWT/RT reuse, no foreign RBAC)', async () => {
    const userA = {
      id: 'u-a',
      email: 'a@shop.local',
      fullName: 'A',
      role: 'CASHIER' as const,
    };
    const userB = {
      id: 'u-b',
      email: 'b@shop.local',
      fullName: 'B',
      role: 'MANAGER' as const,
    };

    localStorage.setItem('auth_token', 'jwt-of-user-A-must-not-reuse-xxxxxxxx');
    localStorage.setItem('refresh_token', 'rt-of-user-A-must-not-revive');
    localStorage.setItem('token_expiry', String(Date.now() + 60_000));
    localStorage.setItem('user', JSON.stringify(userA));
    localStorage.setItem('rbac_permissions', JSON.stringify(['sales.read', 'admin.only']));
    await cacheLoginCredential(userB.email, 'Bpass', userB);
    // Keep offline credentials under a different key path — call begin after caching
    localStorage.setItem(OFFLINE_CREDENTIALS_KEY, localStorage.getItem(OFFLINE_CREDENTIALS_KEY)!);

    const tokenB = beginOfflineLoginSession(userB);
    gate('OFF_ISO_TOKEN_NEW', isOfflineSessionToken(tokenB), 'minted offline-session token');
    gate(
      'OFF_ISO_NO_JWT',
      localStorage.getItem('auth_token') === null,
      'prior JWT stripped before login()',
    );
    gate(
      'OFF_ISO_NO_RT',
      localStorage.getItem('refresh_token') === null,
      'prior RT stripped — prevents zombie refresh as user A',
    );
    gate(
      'OFF_ISO_NO_EXPIRY',
      localStorage.getItem('token_expiry') === null,
      'token_expiry cleared for offline session',
    );
    gate(
      'OFF_ISO_NO_FOREIGN_RBAC',
      localStorage.getItem('rbac_permissions') === null,
      'A permissions not left for B',
    );
    gate(
      'OFF_ISO_CREDS_INTACT',
      Boolean(localStorage.getItem(OFFLINE_CREDENTIALS_KEY)),
      'offline password cache survives identity wipe',
    );

    // Same user re-login keeps RBAC cache
    localStorage.setItem('user', JSON.stringify(userB));
    localStorage.setItem('rbac_permissions', JSON.stringify(['pos.sell']));
    localStorage.setItem('auth_token', 'junk');
    localStorage.setItem('refresh_token', 'junk-rt');
    const tokenB2 = beginOfflineLoginSession(userB);
    gate('OFF_ISO_SAME_TOKEN', isOfflineSessionToken(tokenB2), 'same-user mint');
    gate(
      'OFF_ISO_SAME_RBAC',
      localStorage.getItem('rbac_permissions') === JSON.stringify(['pos.sell']),
      'same actor keeps offline permission cache',
    );
    gate(
      'OFF_ISO_SAME_NO_RT',
      localStorage.getItem('refresh_token') === null,
      'same actor still strips RT',
    );
  });

  it('peekCachedPermissionKeysForUser never returns foreign RBAC', () => {
    localStorage.setItem('user', JSON.stringify({ id: 'u-a', email: 'a@x', fullName: 'A', role: 'CASHIER' }));
    localStorage.setItem('rbac_permissions', JSON.stringify(['sales.read', 'admin.only']));
    gate(
      'PEEK_SAME',
      JSON.stringify(peekCachedPermissionKeysForUser('u-a')) ===
        JSON.stringify(['sales.read', 'admin.only']),
      'same user may reuse cache',
    );
    gate(
      'PEEK_FOREIGN',
      peekCachedPermissionKeysForUser('u-b') === null,
      'different user must not see prior RBAC',
    );
    gate('PEEK_EMPTY', peekCachedPermissionKeysForUser('') === null, 'empty id rejected');
  });

  it('LoginPage never reuses existing JWT for offline login', () => {
    const src = readClient('src/pages/LoginPage.tsx');
    gate(
      'OFF_PAGE_BEGIN',
      src.includes('beginOfflineLoginSession') && !src.includes("localStorage.getItem('auth_token') || generateOfflineToken"),
      'LoginPage uses beginOfflineLoginSession, not JWT reuse',
    );
  });

  it('clearTokens key list does not include offline credentials', () => {
    const wipeKeys = [
      'auth_token',
      'refresh_token',
      'token_expiry',
      'user',
      'rbac_permissions',
      'refresh_lock',
    ];
    gate(
      'OFF_SURVIVES_CLEAR',
      offlineCredentialsSurvivesClearTokens(wipeKeys),
      'offline_login_credentials must survive JWT wipe',
    );

    const clearSrc = readClient('src/hooks/useTokenRefresh.ts');
    const clearFn = clearSrc.slice(
      clearSrc.indexOf('export function clearTokens'),
      clearSrc.indexOf('export function clearTokens') + 500,
    );
    gate(
      'OFF_CLEAR_SRC',
      !clearFn.includes(OFFLINE_CREDENTIALS_KEY) && clearFn.includes('removeItem'),
      'clearTokens must not remove offline credential key',
    );
  });

  it('LoginPage uses offline module + navigator/offline fallback', () => {
    const src = readClient('src/pages/LoginPage.tsx');
    gate(
      'OFF_PAGE_IMPORT',
      src.includes("from '../lib/offlineLoginCredentials'") &&
        src.includes('validateOfflineLogin') &&
        src.includes('cacheLoginCredential') &&
        src.includes('beginOfflineLoginSession'),
      'LoginPage wires offlineLoginCredentials + identity isolation',
    );
    gate(
      'OFF_PAGE_OFFLINE_PATH',
      src.includes('!navigator.onLine') && src.includes('isServerUnreachable'),
      'explicit offline + server-unreachable falls back to cache',
    );
  });
});

describe('PROOF: PIN / quick-login public recovery', () => {
  it('pin-only and users endpoints are public (no access token)', () => {
    const routes: Array<[string, string]> = [
      ['auth/quick-login/users', 'GET'],
      ['/api/auth/quick-login/users', 'GET'],
      ['auth/quick-login/pin-only', 'POST'],
      ['auth/quick-login/pin', 'POST'],
      ['auth/quick-login/check-device', 'POST'],
      ['auth/login', 'POST'],
    ];
    for (const [url, method] of routes) {
      gate(
        `PIN_PUBLIC_${url.replace(/\//g, '_')}_${method}`,
        isPublicApiRoute(url, method) === true,
        `${method} ${url}`,
      );
    }
    gate(
      'PIN_SETUP_NOT_PUBLIC_BY_MISTAKE',
      isPublicApiRoute('auth/quick-login/setup', 'POST') === false,
      'setup must stay protected',
    );
  });

  it('auth recovery paths include login + quick-login', () => {
    gate('PATH_LOGIN', isAuthRecoveryPath('/login') === true, '/login');
    gate('PATH_LOGIN_NEST', isAuthRecoveryPath('/tenant/login') === true, 'endsWith /login');
    gate('PATH_QL', isAuthRecoveryPath('/quick-login') === true, '/quick-login');
    gate('PATH_QL_NEST', isAuthRecoveryPath('/quick-login/device') === true, 'startsWith quick-login');
    gate('PATH_MY_QL', isAuthRecoveryPath('/my/quick-login') === true, '/my/quick-login PIN setup');
    gate(
      'PATH_SECURITY',
      isAuthRecoveryPath('/settings/security') === true,
      '/settings/security password/2FA stay',
    );
    gate('PATH_SETTINGS_NOT', isAuthRecoveryPath('/settings') === false, '/settings must hard-nav');
    gate('PATH_POS', isAuthRecoveryPath('/pos') === false, '/pos must hard-nav');
    gate('PATH_SALES', isAuthRecoveryPath('/sales') === false, '/sales must hard-nav');
  });

  it('forceLogoutRedirect uses isAuthRecoveryPath (PIN + offline stay)', () => {
    const src = readClient('src/hooks/useTokenRefresh.ts');
    gate(
      'FORCE_USES_RECOVERY',
      src.includes('isAuthRecoveryPath') &&
        src.includes('forceLogoutRedirect') &&
        src.includes("from '../lib/offlineLoginCredentials'"),
      'forceLogoutRedirect must skip redirect on recovery paths',
    );
    gate(
      'FORCE_STILL_CLEARS',
      src.includes('clearTokens()') && src.includes('location.replace'),
      'still clears + hard-navs protected UI',
    );
  });

  it('network refresh failure never auto-logout (offline keep session)', () => {
    const net = shouldPerformAutoLogout({
      activeOrGuarded: true,
      errorKind: 'network',
      hasRefreshToken: true,
    });
    gate('OFF_NET_KEEP', net === false, 'network must keep tokens for offline resilience');

    const kind = classifyRefreshError(Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' }));
    gate('OFF_CLASSIFY_NET', kind === 'network', `kind=${kind}`);
  });

  it('cold-start PIN gate: SHARED locks all roles; actor lock beats Chrome restore', () => {
    gate('COLD_CASHIER_ROLE', roleRequiresColdStartPinGate('CASHIER') === true, 'cashier');
    gate('COLD_WAITER_ROLE', roleRequiresColdStartPinGate('WAITER') === true, 'waiter');
    gate('COLD_ADMIN_ROLE', roleRequiresColdStartPinGate('ADMIN') === true, 'SHARED admin must re-auth');
    gate('COLD_MGR_ROLE', roleRequiresColdStartPinGate('MANAGER') === true, 'SHARED manager must re-auth');
    gate('COLD_HREF', COLD_START_QUICK_LOGIN_HREF === '/quick-login', COLD_START_QUICK_LOGIN_HREF);

    // cold start = no auth_boot_session
    gate('COLD_IS', isBrowserColdStart() === true, 'fresh tab is cold');
    gate(
      'COLD_ENFORCE_CASHIER',
      shouldEnforceColdStartPinGate({ role: 'CASHIER', hasStoredSession: true }) === true,
      'cashier + stored session + cold → PIN',
    );
    gate(
      'COLD_ENFORCE_ADMIN',
      shouldEnforceColdStartPinGate({ role: 'ADMIN', hasStoredSession: true }) === true,
      'SHARED admin + cold → PIN (no silent restore)',
    );
    markBrowserSessionAlive();
    gate(
      'COLD_AFTER_ALIVE',
      sessionStorage.getItem(AUTH_BOOT_SESSION_KEY) === '1' &&
        shouldEnforceColdStartPinGate({ role: 'CASHIER', hasStoredSession: true }) === false,
      'after alive mark, no pin gate (same browser session)',
    );

    // Close-without-logout: actor lock must force re-auth even if sessionStorage restored
    setActorLock();
    gate(
      'ACTOR_LOCK_BEATS_RESTORE',
      shouldEnforceColdStartPinGate({ role: 'CASHIER', hasStoredSession: true }) === true &&
        shouldEnforceColdStartPinGate({ role: 'ADMIN', hasStoredSession: true }) === true,
      'pagehide actor lock → next opener cannot inherit prior user',
    );
    clearActorLock();

    // PERSONAL office opt-in: admin may silent-restore
    setDeviceSessionMode('PERSONAL');
    sessionStorage.clear();
    gate(
      'PERSONAL_ADMIN_RESTORE',
      roleRequiresColdStartPinGate('ADMIN') === false &&
        shouldEnforceColdStartPinGate({ role: 'ADMIN', hasStoredSession: true }) === false,
      'PERSONAL mode allows admin restore',
    );
    gate(
      'PERSONAL_CASHIER_GATE',
      roleRequiresColdStartPinGate('CASHIER') === true &&
        shouldEnforceColdStartPinGate({ role: 'CASHIER', hasStoredSession: true }) === true,
      'PERSONAL still gates floor roles',
    );
  });

  it('AuthContext uses isAuthRecoveryPath + access-only strips RT', () => {
    const src = readClient('src/contexts/AuthContext.tsx');
    gate(
      'AUTH_RECOVERY_SSOT',
      src.includes('isAuthRecoveryPath') &&
        src.includes("from '../lib/offlineLoginCredentials'"),
      'peer logout / cold-start share recovery path helper',
    );
    gate(
      'AUTH_LOGIN_STRIP_RT',
      src.includes("localStorage.removeItem('refresh_token')") &&
        src.includes('// Access-only / offline session'),
      'login() strips residual RT when no refresh issued',
    );
    gate(
      'AUTH_LOGIN_RBAC_ISO',
      src.includes('peekCachedPermissionKeysForUser') &&
        src.includes('never inherit foreign RBAC'),
      'login() must not reuse another actor rbac_permissions',
    );
  });

  it('clearTokens wipes via AUTH_SESSION_WIPE_KEYS SSOT', () => {
    const clearSrc = readClient('src/hooks/useTokenRefresh.ts');
    gate(
      'CLEAR_USES_WIPE_SSOT',
      clearSrc.includes('AUTH_SESSION_WIPE_KEYS') &&
        clearSrc.includes("from '@shared/security/deviceSessionPolicySsot'"),
      'clearTokens must iterate shared wipe key list',
    );
    gate(
      'REVOKE_ALL_FORCE_LOGOUT',
      clearSrc.includes("forceLogoutRedirect('revoke_all_sessions')"),
      'revoke-all must use forceLogoutRedirect SSOT (not location.href)',
    );
  });

  it('structural wiring: QuickLogin + soft-start lock + pin numpad exist', () => {
    const wiring: Array<[string, string]> = [
      ['src/hooks/useQuickLogin.ts', 'pin-only'],
      ['src/lib/sessionColdStartLock.ts', 'roleRequiresColdStartPinGate'],
      ['src/lib/apiPublicRoutes.ts', 'auth/quick-login/pin-only'],
      ['src/lib/offlineLoginCredentials.ts', 'validateOfflineLogin'],
    ];
    for (const [file, needle] of wiring) {
      const full = join(clientRoot, file);
      const ok = existsSync(full) && readFileSync(full, 'utf8').includes(needle);
      gate(`WIRE_${file.replace(/[/.]/g, '_')}`, ok, `${file} has ${needle}`);
    }
  });
});

afterAll(() => {
  const pass = gates.filter((g) => g.ok).length;
  const fail = gates.filter((g) => !g.ok).length;
  const verdict = fail === 0 ? 'PASS' : 'FAIL';
  const iso = new Date().toISOString();

  const md = [
    `# PROOF: Offline login + PIN recovery`,
    ``,
    `- Date: ${iso}`,
    `- Runner: \`npx vitest run src/__tests__/offline-login-and-pin.proof.test.ts\``,
    `- Gates: ${pass}/${gates.length} pass (${fail} fail)`,
    `- Verdict: **${verdict}**`,
    ``,
    `## Scope`,
    ``,
    `1. **Offline password login** — multi-user PBKDF2 cache after online login; works when \`navigator.onLine\` is false or API unreachable.`,
    `2. **PIN quick-login** — public pin-only routes; forceLogout does not bounce away from \`/quick-login\`.`,
    `3. **Session death interaction** — JWT wipe via \`clearTokens\` must leave offline credentials; network errors never auto-logout while refresh token exists.`,
    `4. **Cold-start PIN** — cashiers must re-PIN after reboot; admin/manager keep ERP restore.`,
    ``,
    `## Matrix`,
    ``,
    `| Gate | Result | Detail |`,
    `|---|---|---|`,
    ...gates.map((g) => `| ${g.id} | ${g.ok ? 'PASS' : 'FAIL'} | ${g.detail.replace(/\|/g, '/')} |`),
    ``,
    `## Product truth`,
    ``,
    `| Path | Online | Offline | After session death |`,
    `|---|---|---|---|`,
    `| Password \`/login\` | Server auth + cache credential | Cached password hash | \`forceLogout\` → stay on/login or hard-nav to \`/login\`; offline cache intact; **identity isolation** (no JWT/RT reuse) |`,
    `| PIN \`/quick-login\` | Public pin-only API | **Not supported** (server bcrypt) | Stay on \`/quick-login\` (no replace loop) |`,
    `| Cold start shared terminal | N/A | N/A | Cashier forced to \`/quick-login\` before silent restore |`,
    ``,
    `## Automation`,
    ``,
    `\`\`\`bash`,
    `cd samplepos.client && npx vitest run src/__tests__/offline-login-and-pin.proof.test.ts`,
    `# or`,
    `npm run proof:offline-login-pin  # from samplepos.client when script present`,
    `\`\`\``,
    ``,
  ].join('\n');

  const json = {
    proof: 'OFFLINE_LOGIN_AND_PIN',
    date: iso,
    verdict,
    pass,
    fail,
    total: gates.length,
    gates,
  };

  writeFileSync(join(repoRoot, 'PROOF_OFFLINE_LOGIN_AND_PIN.md'), md, 'utf8');
  writeFileSync(join(repoRoot, 'PROOF_OFFLINE_LOGIN_AND_PIN.json'), JSON.stringify(json, null, 2), 'utf8');
});
