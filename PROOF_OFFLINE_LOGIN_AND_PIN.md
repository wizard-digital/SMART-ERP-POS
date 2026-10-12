# PROOF: Offline login + PIN recovery

- Date: 2026-10-12T00:29:59.811Z
- Runner: `npx vitest run src/__tests__/offline-login-and-pin.proof.test.ts`
- Gates: 65/65 pass (0 fail)
- Verdict: **PASS**

## Scope

1. **Offline password login** — multi-user PBKDF2 cache after online login; works when `navigator.onLine` is false or API unreachable.
2. **PIN quick-login** — public pin-only routes; forceLogout does not bounce away from `/quick-login`.
3. **Session death interaction** — JWT wipe via `clearTokens` must leave offline credentials; network errors never auto-logout while refresh token exists.
4. **Cold-start PIN** — cashiers must re-PIN after reboot; admin/manager keep ERP restore.

## Matrix

| Gate | Result | Detail |
|---|---|---|
| OFF_CACHE_OK | PASS | validated cashier@shop.local |
| OFF_BAD_PWD | PASS | wrong password must be null |
| OFF_UNKNOWN | PASS | unknown user must be null |
| OFF_EMAIL_CASE | PASS | cashier@shop.local |
| OFF_MULTI | PASS | a=u-cashier-1 b=u-mgr |
| OFF_EVICT | PASS | cache size=10 max=10 |
| OFF_TOKEN_PREFIX | PASS | offline-session-1791764999695-cc1f29a295 |
| OFF_ISO_TOKEN_NEW | PASS | minted offline-session token |
| OFF_ISO_NO_JWT | PASS | prior JWT stripped before login() |
| OFF_ISO_NO_RT | PASS | prior RT stripped — prevents zombie refresh as user A |
| OFF_ISO_NO_EXPIRY | PASS | token_expiry cleared for offline session |
| OFF_ISO_NO_FOREIGN_RBAC | PASS | A permissions not left for B |
| OFF_ISO_CREDS_INTACT | PASS | offline password cache survives identity wipe |
| OFF_ISO_SAME_TOKEN | PASS | same-user mint |
| OFF_ISO_SAME_RBAC | PASS | same actor keeps offline permission cache |
| OFF_ISO_SAME_NO_RT | PASS | same actor still strips RT |
| PEEK_SAME | PASS | same user may reuse cache |
| PEEK_FOREIGN | PASS | different user must not see prior RBAC |
| PEEK_EMPTY | PASS | empty id rejected |
| OFF_PAGE_BEGIN | PASS | LoginPage uses beginOfflineLoginSession, not JWT reuse |
| OFF_SURVIVES_CLEAR | PASS | offline_login_credentials must survive JWT wipe |
| OFF_CLEAR_SRC | PASS | clearTokens must not remove offline credential key |
| OFF_PAGE_IMPORT | PASS | LoginPage wires offlineLoginCredentials + identity isolation |
| OFF_PAGE_OFFLINE_PATH | PASS | explicit offline + server-unreachable falls back to cache |
| PIN_PUBLIC_auth_quick-login_users_GET | PASS | GET auth/quick-login/users |
| PIN_PUBLIC__api_auth_quick-login_users_GET | PASS | GET /api/auth/quick-login/users |
| PIN_PUBLIC_auth_quick-login_pin-only_POST | PASS | POST auth/quick-login/pin-only |
| PIN_PUBLIC_auth_quick-login_pin_POST | PASS | POST auth/quick-login/pin |
| PIN_PUBLIC_auth_quick-login_check-device_POST | PASS | POST auth/quick-login/check-device |
| PIN_PUBLIC_auth_login_POST | PASS | POST auth/login |
| PIN_SETUP_NOT_PUBLIC_BY_MISTAKE | PASS | setup must stay protected |
| PATH_LOGIN | PASS | /login |
| PATH_LOGIN_NEST | PASS | endsWith /login |
| PATH_QL | PASS | /quick-login |
| PATH_QL_NEST | PASS | startsWith quick-login |
| PATH_MY_QL | PASS | /my/quick-login PIN setup |
| PATH_SECURITY | PASS | /settings/security password/2FA stay |
| PATH_SETTINGS_NOT | PASS | /settings must hard-nav |
| PATH_POS | PASS | /pos must hard-nav |
| PATH_SALES | PASS | /sales must hard-nav |
| FORCE_USES_RECOVERY | PASS | forceLogoutRedirect must skip redirect on recovery paths |
| FORCE_STILL_CLEARS | PASS | still clears + hard-navs protected UI |
| OFF_NET_KEEP | PASS | network must keep tokens for offline resilience |
| OFF_CLASSIFY_NET | PASS | kind=network |
| COLD_CASHIER_ROLE | PASS | cashier |
| COLD_WAITER_ROLE | PASS | waiter |
| COLD_ADMIN_ROLE | PASS | SHARED admin must re-auth |
| COLD_MGR_ROLE | PASS | SHARED manager must re-auth |
| COLD_HREF | PASS | /quick-login |
| COLD_IS | PASS | fresh tab is cold |
| COLD_ENFORCE_CASHIER | PASS | cashier + stored session + cold → PIN |
| COLD_ENFORCE_ADMIN | PASS | SHARED admin + cold → PIN (no silent restore) |
| COLD_AFTER_ALIVE | PASS | after alive mark, no pin gate (same browser session) |
| ACTOR_LOCK_BEATS_RESTORE | PASS | pagehide actor lock → next opener cannot inherit prior user |
| PERSONAL_ADMIN_RESTORE | PASS | PERSONAL mode allows admin restore |
| PERSONAL_CASHIER_GATE | PASS | PERSONAL still gates floor roles |
| AUTH_RECOVERY_SSOT | PASS | peer logout / cold-start share recovery path helper |
| AUTH_LOGIN_STRIP_RT | PASS | login() strips residual RT when no refresh issued |
| AUTH_LOGIN_RBAC_ISO | PASS | login() must not reuse another actor rbac_permissions |
| CLEAR_USES_WIPE_SSOT | PASS | clearTokens must iterate shared wipe key list |
| REVOKE_ALL_FORCE_LOGOUT | PASS | revoke-all must use forceLogoutRedirect SSOT (not location.href) |
| WIRE_src_hooks_useQuickLogin_ts | PASS | src/hooks/useQuickLogin.ts has pin-only |
| WIRE_src_lib_sessionColdStartLock_ts | PASS | src/lib/sessionColdStartLock.ts has roleRequiresColdStartPinGate |
| WIRE_src_lib_apiPublicRoutes_ts | PASS | src/lib/apiPublicRoutes.ts has auth/quick-login/pin-only |
| WIRE_src_lib_offlineLoginCredentials_ts | PASS | src/lib/offlineLoginCredentials.ts has validateOfflineLogin |

## Product truth

| Path | Online | Offline | After session death |
|---|---|---|---|
| Password `/login` | Server auth + cache credential | Cached password hash | `forceLogout` → stay on/login or hard-nav to `/login`; offline cache intact; **identity isolation** (no JWT/RT reuse) |
| PIN `/quick-login` | Public pin-only API | **Not supported** (server bcrypt) | Stay on `/quick-login` (no replace loop) |
| Cold start shared terminal | N/A | N/A | Cashier forced to `/quick-login` before silent restore |

## Automation

```bash
cd samplepos.client && npx vitest run src/__tests__/offline-login-and-pin.proof.test.ts
# or
npm run proof:offline-login-pin  # from samplepos.client when script present
```
