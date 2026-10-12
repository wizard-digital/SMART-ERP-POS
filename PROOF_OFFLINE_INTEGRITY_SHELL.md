# PROOF: Offline integrity shell

- Runner: `cd samplepos.client && npx vitest run src/__tests__/offline-integrity-shell.evidence.test.ts`
- Companion: `src/__tests__/chunkLoadError.test.ts`, `src/__tests__/offline-login-and-pin.proof.test.ts`
- Pack: `PROOF_SESSION_SECURITY_GURU_PACK.vitest.json` — **51/51 PASS**
- Verdict: see `PROOF_OFFLINE_INTEGRITY_SHELL.json` (**PASS**, 23/23 gates)

## Enterprise rule

Offline must **not** black-screen or silently empty-out. Failures are typed, logged, and recoverable.

| Layer | Integrity |
|---|---|
| Login / POS / Quick Login | **Eager** in main shell — never depend on a late chunk fetch offline |
| Other routes | Lazy + `CriticalOfflineWarmup` while online |
| Warmup list | orders, customers, products, stock, sales, **restaurant FOH**, **security settings** |
| Chunk miss offline | `OFFLINE_MODULE_LOAD` + `OfflineIntegrityCode` + `Error.cause` preserved |
| ErrorBoundary | Offline card + restaurant-aware recovery (`/restaurant` vs `/pos`) |
| Service worker miss | JSON `error_code` matching `OfflineIntegrityCode` + `console.warn` (no empty 503) |
| Docs | `docs/OFFLINE_ARCHITECTURE_RULES.md` → Shell integrity |

## Consistency lock

The evidence test asserts App ↔ ErrorBoundary ↔ SW codes ↔ docs ↔ warmup list stay aligned. Re-run after any offline change.

## Operator expectation

1. Open the app **online** once (login).
2. POS / Restaurant FOH remains available offline after warmup.
3. Unwarmed screens show a clear offline card — not a black Vite overlay.
4. Recovery button returns restaurant tenants to FOH, retail to POS.
