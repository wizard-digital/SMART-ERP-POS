/**
 * PROOF — GL outbox worker: crash safety, stale-claim recovery, retries, duplicate delivery,
 * concurrent workers. REAL Postgres (row locks, backend termination); rebuild is a controllable fake
 * (its idempotency + atomicity is proven in periodBalanceWorker.atomicity.proof.test.ts).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';
import { createScratchDb, histogram, insertEvents, statusOf, type ScratchDb } from './periodBalanceWorker.testDb.js';

type RebuildFn = (client: pg.PoolClient, accountId: string, year: number, period: number) => Promise<void>;
let impl: RebuildFn = async () => undefined;
const calls: Array<{ accountId: string; year: number; period: number; pid?: number }> = [];

jest.unstable_mockModule('./glPeriodRebuildService.js', () => ({
  rebuildSingleAccountPeriodOnClient: async (c: pg.PoolClient, a: string, y: number, p: number) => {
    calls.push({ accountId: a, year: y, period: p });
    return impl(c, a, y, p);
  },
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { pollAndProcessPendingEvents, LEGACY_PROCESSING_RECLAIM_SECONDS } = await import('./periodBalanceWorker.js');

const db: ScratchDb | null = await createScratchDb();
if (!db) console.error('[SKIPPED] local Postgres unreachable — outbox recovery proofs NOT executed');
const suite = db ? describe : describe.skip;

suite('GL outbox worker — recovery guarantees (real Postgres)', () => {
  const pool = db!.pool;
  const observer = db!.observer;

  beforeEach(async () => {
    calls.length = 0;
    impl = async () => undefined;
    await pool.query('TRUNCATE gl_projection_events');
  });
  afterAll(async () => {
    await db?.drop();
  });
  beforeAll(() => undefined);

  it('happy path: dedupes per tuple, marks every event DONE, never persists PROCESSING', async () => {
    const acct = '11111111-1111-1111-1111-111111111111';
    const ids = await insertEvents(pool, [
      { accountId: acct, period: 4 },
      { accountId: acct, period: 4 }, // same tuple -> one rebuild
      { accountId: acct, period: 5 },
    ]);
    const r = await pollAndProcessPendingEvents(pool);
    expect(r).toMatchObject({ claimed: 3, rebuilt: 2, failed: 0 });
    expect(calls).toHaveLength(2);
    expect(Object.values(await statusOf(pool, ids))).toEqual(['DONE', 'DONE', 'DONE']);
    const done = await pool.query(`SELECT count(*) n FROM gl_projection_events WHERE processed_at IS NOT NULL`);
    expect(Number(done.rows[0].n)).toBe(3);
  });

  it('WORKER CRASH mid-rebuild: events stay PENDING (not PROCESSING) and are recovered by the next cycle', async () => {
    const ids = await insertEvents(pool, [{}, {}, {}]);
    // Simulate process death: the server kills this worker's own backend during the rebuild.
    impl = async (client) => {
      await client.query('SELECT pg_terminate_backend(pg_backend_pid())').catch(() => undefined);
      throw new Error('connection terminated (simulated crash)');
    };
    const crashed = await pollAndProcessPendingEvents(pool);
    expect(crashed.rebuilt).toBe(0);

    const mid = await statusOf(observer, ids);
    expect(Object.values(mid)).toEqual(['PENDING', 'PENDING', 'PENDING']); // <- the old bug left PROCESSING here
    expect(await histogram(observer)).toEqual({ PENDING: 3 });

    impl = async () => undefined; // healthy worker
    const recovered = await pollAndProcessPendingEvents(pool);
    expect(recovered).toMatchObject({ claimed: 3, failed: 0 });
    expect(await histogram(observer)).toEqual({ DONE: 3 });
  });

  it('CONCURRENT worker cannot double-claim in-flight events (SKIP LOCKED); lock releases on commit', async () => {
    const ids = await insertEvents(pool, [{}, {}, {}, {}]);
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    let entered!: () => void;
    const started = new Promise<void>((res) => (entered = res));
    impl = async () => {
      entered();
      await gate;
    };

    const first = pollAndProcessPendingEvents(pool);
    await started;
    // while worker #1 is mid-flight: rows look PENDING to everyone, but worker #2 gets nothing
    expect(Object.values(await statusOf(observer, ids))).toEqual(['PENDING', 'PENDING', 'PENDING', 'PENDING']);
    const second = await pollAndProcessPendingEvents(pool);
    expect(second.claimed).toBe(0);
    expect(calls).toHaveLength(1);

    release();
    const done = await first;
    expect(done).toMatchObject({ claimed: 4, rebuilt: 4 });
    expect(await histogram(observer)).toEqual({ DONE: 4 });
  });

  it('4 concurrent workers over 250 events: every event processed exactly once, none lost, work really split', async () => {
    const ids = await insertEvents(pool, Array.from({ length: 250 }, () => ({})));
    impl = async () => {
      await new Promise((r) => setTimeout(r, 4));
    };
    const results = await Promise.all([1, 2, 3, 4].map(() => pollAndProcessPendingEvents(pool)));

    expect(results.reduce((s, r) => s + r.claimed, 0)).toBe(250);
    expect(results.reduce((s, r) => s + r.rebuilt, 0)).toBe(250);
    expect(results.filter((r) => r.claimed > 0).length).toBeGreaterThanOrEqual(2); // genuine overlap
    expect(calls).toHaveLength(250);
    expect(new Set(calls.map((c) => c.accountId)).size).toBe(250); // no tuple rebuilt twice
    expect(await histogram(observer)).toEqual({ DONE: 250 });
    expect(Object.keys(await statusOf(observer, ids))).toHaveLength(250);
  });

  it('concurrent workers over SHARED tuples: all DONE, idempotent re-delivery only (<= one call per worker per tuple)', async () => {
    const accts = ['aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000003'];
    await insertEvents(pool, Array.from({ length: 300 }, (_, i) => ({ accountId: accts[i % 3], period: 6 })));
    const results = await Promise.all([1, 2, 3].map(() => pollAndProcessPendingEvents(pool)));
    expect(results.reduce((s, r) => s + r.claimed, 0)).toBe(300);
    expect(await histogram(observer)).toEqual({ DONE: 300 });
    expect(calls.length).toBeLessThanOrEqual(9); // 3 workers x 3 tuples max
  });

  it('tuples are rebuilt in sorted order (deadlock-free lock ordering)', async () => {
    await insertEvents(pool, [
      { accountId: 'cccccccc-0000-0000-0000-000000000003', period: 2 },
      { accountId: 'cccccccc-0000-0000-0000-000000000001', period: 9 },
      { accountId: 'cccccccc-0000-0000-0000-000000000002', period: 1 },
    ]);
    await pollAndProcessPendingEvents(pool);
    const keys = calls.map((c) => `${c.accountId}|${c.year}|${c.period}`);
    expect(keys).toEqual([...keys].sort());
  });

  it('STALE PROCESSING rows (legacy stranded claims) are recovered; a fresh PROCESSING row is left alone', async () => {
    const [stale1, stale2, fresh] = await insertEvents(pool, [
      { status: 'PROCESSING', ageSeconds: 3600 * 24 * 30 },
      { status: 'PROCESSING', ageSeconds: LEGACY_PROCESSING_RECLAIM_SECONDS + 5 },
      { status: 'PROCESSING', ageSeconds: 5 },
    ]);
    const r = await pollAndProcessPendingEvents(pool);
    expect(r).toMatchObject({ claimed: 2, rebuilt: 2, failed: 0 });
    const s = await statusOf(pool, [stale1, stale2, fresh]);
    expect(s[stale1]).toBe('DONE');
    expect(s[stale2]).toBe('DONE');
    expect(s[fresh]).toBe('PROCESSING');
    // and the stranded state is not re-created or re-processed on the next cycle
    const again = await pollAndProcessPendingEvents(pool);
    expect(again.claimed).toBe(0);
  });

  it('DUPLICATE DELIVERY: DONE events are never reclaimed or re-applied', async () => {
    const ids = await insertEvents(pool, [{ status: 'DONE' }, { status: 'DONE' }]);
    const before = await pool.query(`SELECT id, processed_at FROM gl_projection_events WHERE id = ANY($1::uuid[]) ORDER BY id`, [ids]);
    const r = await pollAndProcessPendingEvents(pool);
    expect(r.claimed).toBe(0);
    expect(calls).toHaveLength(0);
    const after = await pool.query(`SELECT id, processed_at FROM gl_projection_events WHERE id = ANY($1::uuid[]) ORDER BY id`, [ids]);
    expect(after.rows).toEqual(before.rows);
  });

  it('RETRY: a failing tuple is isolated (others commit), marked FAILED+1, then retried to DONE', async () => {
    const bad = 'dddddddd-0000-0000-0000-00000000000b';
    const ok = 'dddddddd-0000-0000-0000-00000000000a';
    const [evBad1, evBad2, evOk] = await insertEvents(pool, [{ accountId: bad }, { accountId: bad }, { accountId: ok }]);
    impl = async (client, a) => {
      if (a === bad) {
        await client.query('SELECT 1/0'); // real SQL error => aborted txn, savepoint must contain it
      }
    };
    const r1 = await pollAndProcessPendingEvents(pool);
    expect(r1).toMatchObject({ claimed: 3, rebuilt: 1, failed: 1 });
    const s1 = await pool.query(`SELECT id, status, retry_count, error_message FROM gl_projection_events ORDER BY id`);
    const by = Object.fromEntries(s1.rows.map((x) => [x.id, x]));
    expect(by[evOk].status).toBe('DONE');
    for (const id of [evBad1, evBad2]) {
      expect(by[id].status).toBe('FAILED');
      expect(by[id].retry_count).toBe(1);
      expect(by[id].error_message).toMatch(/division by zero/);
    }

    impl = async () => undefined; // transient problem gone
    const r2 = await pollAndProcessPendingEvents(pool);
    expect(r2).toMatchObject({ claimed: 2, rebuilt: 1, failed: 0 });
    const s2 = await pool.query(`SELECT status, retry_count, error_message FROM gl_projection_events WHERE id = ANY($1::uuid[])`, [[evBad1, evBad2]]);
    expect(s2.rows.every((x) => x.status === 'DONE' && x.error_message === null)).toBe(true);
  });

  it('MAX_RETRIES: exhausted FAILED events stay FAILED for humans and are not hot-looped', async () => {
    const [id] = await insertEvents(pool, [{ status: 'FAILED', retryCount: 5 }]);
    const r = await pollAndProcessPendingEvents(pool);
    expect(r.claimed).toBe(0);
    expect((await statusOf(pool, [id]))[id]).toBe('FAILED');
  });

  it('missing table (global/empty DB) is swallowed, connection returned to the pool', async () => {
    const empty = await createScratchDb();
    try {
      await empty!.pool.query('DROP TABLE gl_projection_events');
      const r = await pollAndProcessPendingEvents(empty!.pool);
      expect(r).toMatchObject({ claimed: 0, rebuilt: 0, failed: 0 });
      expect(empty!.pool.idleCount + empty!.pool.waitingCount).toBeGreaterThanOrEqual(0);
      expect(empty!.pool.totalCount - empty!.pool.idleCount).toBe(0); // nothing leaked
    } finally {
      await empty!.drop();
    }
  });
});
