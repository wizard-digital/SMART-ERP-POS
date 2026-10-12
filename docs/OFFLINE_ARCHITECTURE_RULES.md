# Offline Architecture Rules

> **Mandatory for all AI assistants and contributors.**
> These rules are non-negotiable. If a requested change violates them, refuse and suggest the compliant approach.

## Core Principle

The offline system is an **immutable event journal**, not a mutable queue. This is the same model used by SAP S/4HANA and Odoo. Events are appended once and never modified or deleted. The UI and server both derive state by replaying events.

## Shell integrity (non-negotiable)

- **Login, POS, and Quick Login** are eager modules — offline must not fail because a Vite/HTTP chunk could not be fetched.
- Chunk / SW misses are **typed** (`OfflineIntegrityCode` / `error_code`) and **logged** — never empty 503 bodies, never silent `catch {}`.
- While online after auth, `CriticalOfflineWarmup` prefetches critical route chunks (orders, customers, products, stock, sales, restaurant FOH, security settings).
- Offline ErrorBoundary recovery uses cached restaurant mode: `/restaurant` for restaurant tenants, `/pos` otherwise — never bounce restaurant staff to retail POS.
- See `PROOF_OFFLINE_INTEGRITY_SHELL.md`.

---

## Storage Contract

```
localStorage['pos_offline_events']   // append-only PosOfflineEvent[]
localStorage['pos_sync_state']       // Record<key, SyncStateEntry>
```

These are the **only** two keys for offline POS state. Do not introduce `pos_offline_sales`, `pos_offline_orders`, or any other queue keys.

---

## Type Contract

All offline events must conform to the `PosOfflineEvent` discriminated union defined in:

```
samplepos.client/src/lib/offlineEventJournal.ts
```

**Use this type everywhere. Do not redefine it inline.**

Key shape (see source for full definition):

```typescript
export type PosOfflineEvent =
  | { eventType: 'ORDER_CREATED';   key: string; orderId: string; offlineId: string; lines: EventLine[]; customerId?: string; notes?: string; ts: number }
  | { eventType: 'ORDER_UPDATED';   key: string; orderId: string; lines: EventLine[]; customerId?: string; ts: number }
  | { eventType: 'ORDER_CANCELLED'; key: string; orderId: string; offlineId: string; ts: number }
  | { eventType: 'PAYMENT_ADDED';   key: string; orderId: string; offlineId: string; payments: EventPayment[]; ts: number }
  | { eventType: 'SALE_COMPLETED';  key: string; orderId: string; offlineId: string; lines: EventLine[]; payments: EventPayment[]; totalAmount: number; subtotal: number; taxAmount: number; discountAmount?: number; customerId?: string; stockDeductions: StockDeduction[]; ts: number }
  | { eventType: 'SALE_VOIDED';     key: string; orderId: string; offlineId: string; reason?: string; ts: number };
```

**No `any` types. No `payload: any` shortcut.** The project has a zero-tolerance rule on `any`.

---

## Forbidden Patterns

| Pattern | Why it's forbidden |
|---|---|
| `queue.filter(s => s.status !== 'SYNCED')` | Mutates/deletes journal entries |
| `queue.splice(index, 1)` | Same |
| `localStorage.setItem('pos_offline_sales', ...)` | Wrong key — use `pos_offline_events` |
| `setSyncQueue(prev => prev.map(...))` | UI state is not the source of truth |
| `POST /api/sales` while offline | Sends sale objects, not events |
| `POST /api/pos/sync-offline-sales` for new code | Legacy endpoint — new code uses `sync-events` |
| Storing business truth in React `useState` | Derive from journal, don't store in component state |
| Assigning `sale.status = 'SYNCED'` | Sync state belongs in `pos_sync_state`, not the event |
| Database triggers or generated columns | See system-wide rules in `COPILOT_IMPLEMENTATION_RULES.md` |

---

## Required Patterns

### 1. Appending events (write path)

```typescript
import { appendEvent, generateEventKey } from '../lib/offlineEventJournal';

// Every write is an append — never a replace
appendEvent({
  eventType: 'SALE_COMPLETED',
  key: generateEventKey(),          // ofl_<timestamp>_<random>
  orderId: `ofl_ord_${...}`,
  offlineId: `OFFLINE-${...}`,
  lines: [...],
  payments: [...],
  totalAmount: ...,
  subtotal: ...,
  taxAmount: ...,
  discountAmount: 0,
  stockDeductions: [...],
  ts: Date.now(),
});
```

### 2. Deriving UI state (read path)

```typescript
import { getAllEvents, getAllSyncState } from '../lib/offlineEventJournal';
import { deriveCompletedSales, deriveOpenOrders } from '../lib/offlineEventSelectors';

// Never read pos_offline_sales; always replay the journal
const events    = getAllEvents();
const syncState = getAllSyncState();

const sales  = deriveCompletedSales(events, syncState);
const orders = deriveOpenOrders(events, syncState);
```

### 3. Updating sync status (sync path)

```typescript
import { markSynced, markReview, markFailed } from '../lib/offlineEventJournal';

// After server responds:
if (response.ok)              markSynced(event.key);
if (response.status === 409)  markSynced(event.key);  // idempotency hit = already done
if (response.data.requiresReview) markReview(event.key, response.data.error);
// on network error:           markFailed(event.key, errMsg);
```

### 4. Syncing events to server

```typescript
// Always POST to /api/pos/sync-events — never to /api/sales or /api/pos/sync-offline-sales
const response = await apiClient.post('/pos/sync-events', { event: resolvedEvent });
```

---

## Selector Rule

**The UI must never read from mutable queues. All derived state comes from selector functions.**

Selectors live in `samplepos.client/src/lib/offlineEventSelectors.ts`:

| Selector | Purpose |
|---|---|
| `deriveOpenOrders(events, syncState)` | All ORDER_CREATED events not yet COMPLETED or CANCELLED |
| `deriveCompletedSales(events, syncState)` | All SALE_COMPLETED events (excludes CANCELLED) |
| `deriveOrderState(orderId, events, syncState)` | Full state of one order by replaying its events |
| `countBySyncStatus(events, syncState)` | Counts by status for badge display |

---

## Sync Engine Rule

**The standalone sync engine (`offlineSyncEngine.ts`) and the hook (`useOfflineMode.ts`) must both use the same journal functions.** There is one source of truth.

```
offlineSyncEngine.ts  →  getUnsyncedEvents() → POST /api/pos/sync-events
useOfflineMode.ts     →  getUnsyncedEvents() → POST /api/pos/sync-events
sw.js (Background Sync) → events + syncState sent from client → POST /api/pos/sync-events
```

---

## Backend Contract

`POST /api/pos/sync-events` (see `SamplePOS.Server/src/modules/pos/syncEventsRoutes.ts`):

- Receives `{ event: PosOfflineEvent }`
- **Delegates all business logic to `posEventReplayer.replay(pool, event, userId)`**
- The route contains zero domain logic — HTTP in, result out
- Returns `200 { success: true }` or `409` on idempotency hit (client marks SYNCED either way)
- Returns `200 { requiresReview: true }` on stock conflict
- The legacy `POST /api/pos/sync-offline-sales` remains for backward compatibility but must not be used in new code

---

## Event Replayer — The Single Source of Business Effects

**File**: `SamplePOS.Server/src/modules/pos/posEventReplayer.ts`

This is the **only file in the server allowed to**:
- Deduct inventory
- Create invoices / sales records
- Post GL entries
- Update order status
- Mark events as processed

```
Database  =  passive storage only
Events    =  instructions
posEventReplayer  =  the accountant
```

### Why triggers are forbidden for offline POS

| Trigger behaviour | Why it breaks offline replay |
|---|---|
| Deducts stock on INSERT | Fires on every replay, causing double-deduction |
| Posts GL on INSERT | Creates duplicate journal entries on retry |
| Fires on out-of-order events | Breaks deterministic state reconstruction |
| Can't check idempotency key | Causes double-posting during retries |
| Hidden from service layer | Violates "all logic visible in one place" rule |

**Database triggers are absolutely forbidden.** If you think a trigger is needed, implement it in `posEventReplayer` instead.

### Adding a new event handler

```typescript
// 1. Add a new case to the switch in posEventReplayer.replay()
case 'MY_NEW_EVENT':
    return posEventReplayer.handleMyNewEvent(pool, event, userId);

// 2. Implement the handler — all effects in one transaction
async handleMyNewEvent(pool, event, userId): Promise<ReplayResult> {
    // idempotency check → effects in withTransaction → return SYNCED/REVIEW/FAILED
}
```

The route (`syncEventsRoutes.ts`) never needs to change when new event types are added.

---

## Adding a New Offline Feature — Checklist

1. **Define a new `eventType` variant** in `offlineEventJournal.ts` with explicit typed fields (no `payload: any`)
2. **Add a selector** in `offlineEventSelectors.ts` to derive UI state from the new event
3. **Add a handler** in `syncEventsRoutes.ts` for the new event type
4. **Append the event** in the hook/component — never modify existing events
5. **Never add a new localStorage key** for the new feature — journal + sync_state covers everything
6. **Write tests** for the new selector function

---

## File Map

| File | Role |
|---|---|
| `samplepos.client/src/lib/offlineEventJournal.ts` | Journal API — append, read, mark status |
| `samplepos.client/src/lib/offlineEventSelectors.ts` | Pure selectors — derive UI state from events |
| `samplepos.client/src/hooks/useOfflineMode.ts` | React hook — exposes derived state + write actions |
| `samplepos.client/src/services/offlineSyncEngine.ts` | Standalone sync engine (used by OfflineSyncStatusPanel) |
| `samplepos.client/src/main.tsx` | SW bridge — sends journal to service worker on request |
| `samplepos.client/public/sw.js` | Service Worker — Background Sync via journal |
| `SamplePOS.Server/src/modules/pos/syncEventsRoutes.ts` | Backend event processor |
