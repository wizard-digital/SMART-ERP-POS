/**
 * EVIDENCE: FREE floor tile → open table → ghost settled ticket → KOT 400.
 *
 * Layers (each asserted separately — do not collapse into one guess):
 *  A) Prod nginx+DB: KOT posted against a COMPLETED order (not PENDING).
 *  B) Server gate: sendKot throws ERR_RESTAURANT_KOT when status !== PENDING.
 *  C) Client paint bug (pre-fix formula): live GET order:null loses to cached lines.
 *  D) Client paint fix: live GET order:null wins (same paint gen).
 *  E) Floor FREE hides server-UUID journal occupancy, but strip seed could still
 *     expose that UUID unless FREE open filters ofl-only.
 *  F) KOT URL uses activeOrderId || painted order id — ghost id is what gets POSTed.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { coalesceRestaurantCheckFetch } from '../lib/restaurantCheckOptimistic';
import { shouldPaintJournalOccupancyOnServerFree } from '../lib/restaurantFloorSession';
import { resolveKotFireOrderId } from '../lib/fohMenuAddTarget';
import { isJournalLocalOrderId } from '../lib/restaurantOfflineOps';

const repoRoot = resolve(__dirname, '../../..');

function readRepo(rel: string): string {
  return readFileSync(resolve(repoRoot, rel), 'utf8');
}

/** Exact Jazz incident from prod probe (2026-11-14). */
const JAZZ_INCIDENT = {
  orderId: '06519de6-0777-4256-8470-62d4e4beeb80',
  orderNumber: 'ORD-2026-0008',
  statusAtKot: 'COMPLETED' as const,
  completedAt: '2026-11-14 12:23:28.427103+00',
  kotAttemptsUtc: [
    '2026-11-14:12:25:32',
    '2026-11-14:12:25:38',
    '2026-11-14:12:25:45',
    '2026-11-14:12:25:59',
  ],
  tableCode: 'TB13',
  nginxPath: `/api/restaurant/checks/${'06519de6-0777-4256-8470-62d4e4beeb80'}/kot`,
  host: 'the-jazz-bar.wizarddigital-inv.com',
};

/**
 * Pre-fix coalesce branch (bug). Kept here as a frozen formula so the proof
 * does not depend on git history of the fixed function.
 */
function coalescePreFixGhostResurrect(input: {
  startedGen: number;
  paintGen: number;
  cached: { order?: { id?: string; items?: unknown[] } | null } | undefined;
  incoming: { order?: { id?: string; items?: unknown[] } | null };
}): { order?: { id?: string; items?: unknown[] } | null } {
  const cachedCount = input.cached?.order?.items?.length ?? 0;
  const incomingCount = input.incoming?.order?.items?.length ?? 0;
  let primary = input.incoming;
  if (input.startedGen < input.paintGen && cachedCount > 0) {
    primary = input.cached as typeof primary;
  } else if (cachedCount > 0 && incomingCount === 0) {
    const incomingId = input.incoming.order?.id;
    // BUG: !incomingId treated empty GET as "keep cache"
    if (!incomingId || incomingId === input.cached?.order?.id) {
      primary = input.cached as typeof primary;
    }
  }
  return primary;
}

/** Mirror of FREE-table strip filter added in RestaurantPosPage. */
function seedTicketStripOnOpen(input: {
  occupied: boolean;
  floorOpenCount: number;
  journalOrderIds: string[];
}): string[] {
  return input.journalOrderIds.filter(
    (id) =>
      input.occupied || input.floorOpenCount > 0 || isJournalLocalOrderId(id),
  );
}

describe('FREE table ghost KOT — layered evidence', () => {
  it('A) Prod incident fixture: KOT URL order was COMPLETED before attempts', () => {
    // completed_at from Jazz DB; nginx timestamps from smarterp-nginx (same day).
    const completedMs = Date.parse('2026-11-14T12:23:28.427Z');
    for (const stamp of JAZZ_INCIDENT.kotAttemptsUtc) {
      const iso = `${stamp.slice(0, 10)}T${stamp.slice(11)}Z`;
      expect(Date.parse(iso)).toBeGreaterThan(completedMs);
    }
    expect(JAZZ_INCIDENT.statusAtKot).toBe('COMPLETED');
    expect(JAZZ_INCIDENT.nginxPath).toContain(JAZZ_INCIDENT.orderId);
  });

  it('B) Server sendKot source gate is PENDING-only (ERR_RESTAURANT_KOT)', () => {
    const svc = readRepo('SamplePOS.Server/src/modules/restaurant/restaurantService.ts');
    const sendKot = svc.slice(svc.indexOf('async sendKot('), svc.indexOf('async voidCheckItems('));
    expect(sendKot).toMatch(/order\.status !== 'PENDING'/);
    expect(sendKot).toMatch(/Open restaurant check required to send KOT/);
    expect(sendKot).toMatch(/ERR_RESTAURANT_KOT/);
  });

  it('B2) getTableCheck refuses to return non-PENDING orders (server empty on reopen)', () => {
    const svc = readRepo('SamplePOS.Server/src/modules/restaurant/restaurantService.ts');
    const getCheck = svc.slice(
      svc.indexOf('async getTableCheck('),
      svc.indexOf('async activateCheck('),
    );
    expect(getCheck).toMatch(/if \(order\.status !== 'PENDING'\)/);
    expect(getCheck).toMatch(/order = null/);
    expect(getCheck).toMatch(/releaseTableByOrderId/);
  });

  it('C) PRE-FIX coalesce resurrects cached lines when live GET returns order:null', () => {
    const paidGhost = {
      order: {
        id: JAZZ_INCIDENT.orderId,
        items: [{ id: 'line-1', productName: 'Beer' }],
      },
    };
    const liveEmpty = { order: null as null };
    const painted = coalescePreFixGhostResurrect({
      startedGen: 5,
      paintGen: 5,
      cached: paidGhost,
      incoming: liveEmpty,
    });
    expect(painted.order?.id).toBe(JAZZ_INCIDENT.orderId);
    expect(painted.order?.items?.length).toBe(1);
  });

  it('D) CURRENT coalesce: live order:null wins — FREE reopen stays empty', () => {
    const paidGhost = {
      order: {
        id: JAZZ_INCIDENT.orderId,
        items: [{ id: 'line-1', productName: 'Beer' }],
      },
    };
    const cleared = coalesceRestaurantCheckFetch({
      startedGen: 5,
      paintGen: 5,
      cached: paidGhost,
      incoming: { order: null, siblingChecks: [] },
    });
    expect(cleared.order).toBeNull();
  });

  it('D2) CURRENT coalesce still protects in-flight paint (startedGen < paintGen)', () => {
    const painted = {
      order: {
        id: JAZZ_INCIDENT.orderId,
        items: [{ id: 'line-1' }],
      },
    };
    const kept = coalesceRestaurantCheckFetch({
      startedGen: 1,
      paintGen: 2,
      cached: painted,
      incoming: { order: null },
    });
    expect(kept.order?.items).toEqual(painted.order.items);
  });

  it('E) Floor FREE hides server-UUID journal occupancy (tile looks empty)', () => {
    expect(
      shouldPaintJournalOccupancyOnServerFree({
        isOnline: true,
        serverStatus: 'FREE',
        journalOrderId: JAZZ_INCIDENT.orderId,
        isJournalLocalOrderId: false,
        journalWaiterId: 'waiter-1',
        actorUserId: 'waiter-1',
      }),
    ).toBe(false);
  });

  it('E2) Without FREE filter, journal UUID would still seed ticket strip on open', () => {
    const unfiltered = [JAZZ_INCIDENT.orderId, 'ofl_ord_local'];
    // occupied=false, openCount=0, no filter → both ids (legacy danger)
    expect(unfiltered).toContain(JAZZ_INCIDENT.orderId);
    // With FREE filter: only ofl_ord_*
    expect(
      seedTicketStripOnOpen({
        occupied: false,
        floorOpenCount: 0,
        journalOrderIds: unfiltered,
      }),
    ).toEqual(['ofl_ord_local']);
  });

  it('E3) RestaurantPosPage wires FREE strip filter + check cache remove on settle', () => {
    const pos = readRepo('samplepos.client/src/pages/restaurant/RestaurantPosPage.tsx');
    expect(pos).toMatch(/occupied \|\| floorOpenCount > 0 \|\| isJournalLocalOrderId/);
    expect(pos).toMatch(/removeQueries\(\{ queryKey: \['restaurant', 'check', tableId\] \}/);
    expect(pos).toMatch(/coalesceRestaurantCheckFetch/);
  });

  it('F) Ghost painted id is the KOT POST target', () => {
    const fireId = resolveKotFireOrderId({
      activeOrderId: JAZZ_INCIDENT.orderId,
      paintedOrderId: JAZZ_INCIDENT.orderId,
    });
    expect(fireId).toBe(JAZZ_INCIDENT.orderId);
    // Chain: COMPLETED + fireId → server B gate → ERR_RESTAURANT_KOT
    expect(JAZZ_INCIDENT.statusAtKot !== 'PENDING').toBe(true);
  });

  it('CHAIN) FREE tile + pre-fix coalesce + KOT id = proven operator failure mode', () => {
    const floorPaintsBusy = shouldPaintJournalOccupancyOnServerFree({
      isOnline: true,
      serverStatus: 'FREE',
      journalOrderId: JAZZ_INCIDENT.orderId,
      isJournalLocalOrderId: false,
      journalWaiterId: 'w1',
      actorUserId: 'w1',
    });
    expect(floorPaintsBusy).toBe(false); // tile empty

    const afterOpenPreFix = coalescePreFixGhostResurrect({
      startedGen: 9,
      paintGen: 9,
      cached: {
        order: {
          id: JAZZ_INCIDENT.orderId,
          items: [{ id: 'beer' }],
        },
      },
      incoming: { order: null }, // getTableCheck after COMPLETED
    });
    expect(afterOpenPreFix.order?.id).toBe(JAZZ_INCIDENT.orderId); // ghost visible

    const kotTarget = resolveKotFireOrderId({
      activeOrderId: afterOpenPreFix.order?.id,
      paintedOrderId: afterOpenPreFix.order?.id,
    });
    expect(kotTarget).toBe(JAZZ_INCIDENT.orderId);
    expect(JAZZ_INCIDENT.statusAtKot).toBe('COMPLETED'); // server rejects
  });
});
