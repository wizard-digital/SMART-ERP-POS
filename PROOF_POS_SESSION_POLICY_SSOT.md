# PROOF — POS session policy SSOT

**Generated:** 2026-09-23T19:39:16.250Z  
**Verdict:** **PASS**  
**Scope:** Registers, POS Session Policy, current session, and sale enforcement share one decision table. A verification failure does not post a sale.

## Live `pos_system`

| Gate | Result | Detail |
|------|--------|--------|
| Participants table | PASS | `cash_register_session_participants` exists |
| CHECK constraint | PASS | `DISABLED`, `PER_CASHIER_SESSION`, `PER_COUNTER_SHARED_SESSION`, `GLOBAL_STORE_SESSION` |
| Live policy in SSOT | PASS | `PER_CASHIER_SESSION` |
| One OPEN session per drawer | PASS | unique index `uq_cash_register_one_open_session`; zero duplicate OPEN registers |
| Unknown join membership | PASS | PER_COUNTER with `isParticipant: null` denies (`ERR_SESSION_005`) |
| Per-cashier ignores foreign open | PASS | `resolveCurrentSession` returns null when another cashier owns the drawer |

## Behavioral matrix (executed, not grep)

| Policy | Sale without session | Sale on someone else’s OPEN session | Current session if not owner |
|--------|----------------------|-------------------------------------|------------------------------|
| Disabled | allow | link only if OPEN | none |
| Per cashier | `ERR_SESSION_001` | `ERR_SESSION_004` | none |
| Per counter | `ERR_SESSION_001` | allow iff joined; else `ERR_SESSION_004`; unknown → `ERR_SESSION_005` | joined, else unique open |
| Global | `ERR_SESSION_001` | allow any OPEN | any open |

Jest session: **21/21** (`posSessionEnforcement.behavior.test.ts` + `posSessionPolicySsot.evidence.test.ts` + `tillArReceiptSsot.evidence.test.ts`)  
Jest GL/sales: **pass** (`glEntryService.accuracy.test.ts`, `postingGovernanceService.test.ts`, `salesService.test.ts`, `salesService.quoteStrictReject.test.ts`)  
Vitest: **10/10** (`pos-session-policy-ssot.evidence.test.ts` + `till-ar-cash-in-ssot.evidence.test.ts` + `expenses-petty-ux-proof.test.ts`)  
Live script: **ok** (`scripts/proof-pos-session-policy-ssot.ts`)

## Fail closed

- Sale path no longer continues after a session-check exception (`ERR_SESSION_005`).
- Missing `cash_register_session_participants` raises `PARTICIPANTS_SCHEMA_MISSING` instead of pretending join succeeded.
- POS overlay and Pay block when the session query errors; Retry refetches.

Not pushed.
