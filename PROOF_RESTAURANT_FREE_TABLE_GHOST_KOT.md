# FREE table → ghost ticket → KOT 400

## Verdict

**PASS_ROOT_CAUSE_PROVEN** (code + Jazz nginx/DB + layered vitest).  
Not a browser click capture on Jazz today — mechanism is proven by frozen pre-fix formula + live functions + prod timestamps.

## What operators see

1. Floor tile looks **empty (FREE)**.
2. Opening the table shows a **previous ticket** (lines still painted).
3. KOT → `400 ERR_RESTAURANT_KOT` / `Open restaurant check required to send KOT`.

## Proven layers (do not mix)

| Layer | Fact | Evidence |
| --- | --- | --- |
| A | Jazz POSTed KOT to `06519de6-…` four times at 12:25:32–59 UTC | nginx access log |
| A | That order is `ORD-2026-0008` **COMPLETED** at 12:23:28 (before KOT) | Jazz `pos_orders` |
| B | `sendKot` requires `status === 'PENDING'` else `ERR_RESTAURANT_KOT` | `restaurantService.ts` |
| B2 | `getTableCheck` sets `order = null` for non-PENDING | `restaurantService.ts` |
| C | **Pre-fix** coalesce: `order:null` + cached lines → **keeps cache** | frozen formula in evidence test |
| D | **Current** coalesce: same inputs → `order:null` | vitest |
| E | Online FREE floor **hides** server-UUID journal occupancy | `shouldPaintJournalOccupancyOnServerFree` |
| F | KOT URL id = `activeOrderId \|\| paintedOrderId` | `resolveKotFireOrderId` |

## Root cause (single)

**Client React Query cache resurrected a settled ticket over an authoritative empty GET.**

Sequence:

1. Pay/cancel → server COMPLETED/CANCELLED; floor FREE (correct).
2. Check payload for that table remains in React Query (invalidate alone does not clear).
3. Reopen table → `getTableCheck` returns `{ order: null }` (correct).
4. Pre-fix `coalesceRestaurantCheckFetch`: `!incomingId` kept cached lines.
5. Sole-ticket bind / KOT used that ghost UUID → server PENDING gate → 400.

Floor looked empty because `shouldPaintJournalOccupancyOnServerFree` is false for server UUIDs on FREE tables — that is why the bug presents as “empty tile, full ticket inside.”

## Not the root cause

- Samba KOT stock commit (guard is before stock).
- Server painting COMPLETED checks in `getTableCheck` (it nulls them).

## Fix (local)

1. Coalesce: live `order:null` wins (in-flight paint race still protected).
2. Settle: `removeQueries(['restaurant','check', tableId])`.
3. FREE open: do not seed ticket strip with stale server UUIDs.

## How to re-run proof

```bash
cd samplepos.client
npx vitest run src/__tests__/restaurant-free-table-ghost-kot.evidence.test.ts src/lib/restaurantCheckOptimistic.proof.test.ts
```
