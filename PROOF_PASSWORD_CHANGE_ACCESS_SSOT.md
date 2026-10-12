# PROOF: Password change access SSOT

- Date: 2026-10-12
- Runner: `cd samplepos.client && npx vitest run src/__tests__/password-change-access-ssot.evidence.test.ts src/utils/cashierLockdown.test.ts src/utils/restaurantWaiterLockdown.test.ts src/__tests__/offline-login-and-pin.proof.test.ts src/__tests__/offline-integrity-shell.evidence.test.ts src/__tests__/chunkLoadError.test.ts`
- Vitest JSON: `PROOF_SESSION_SECURITY_GURU_PACK.vitest.json`
- Tests: **51/51 pass** (0 fail)
- Verdict: **PASS**

## Defects fixed (this pass)

1. **2FA login skipped soft password-expiry redirect** — password login went to `/settings/security`, but `handle2FASuccess` always went home. Server `POST /auth/2fa/verify` now returns the same `mustChangePassword` + `passwordExpiry` payload as password login; client soft-redirects (with GET `auth/password/must-change` fallback for older servers).
2. **Ownership equity route** was mixed into this WIP — removed from `App.tsx` (ADR not approved; must not ship with this package).

## Guarantees proven

1. **All authenticated roles** can open `/settings/security` (no `system.read` gate).
2. **Cashiers / waiters** may open `/settings/security` only — not the rest of `/settings`.
3. **Auth recovery** treats `/settings/security` like login/PIN so session death does not kick users off mid password/2FA change.
4. **Password API hooks** use shared `apiClient` (refresh / 401 SSOT). Policy + validate stay public; change / expiry / must-change stay protected.
5. **Login + 2FA soft-redirect** expired / first-login users to Security Settings. The hard API `checkPasswordExpiry` gate is **not** mounted globally (would brick POS/FOH).

## Intentionally not done

- Global server middleware that returns `403 PASSWORD_EXPIRED` on every API call — would stop POS sales for expired accounts. Soft client redirect + banner only.
