/**
 * GATE 3 — Redis / queue resilience, against a REAL redis-server process (no mocks of Redis, Bull or ioredis).
 *   - real JobQueueService (Bull) and DistributedCacheService (ioredis) classes from production code
 *   - real banking processor (bankingRetryWorker.processBankingJob); only BankingService.createFromSale is a spy
 *     (its DB idempotency is covered by the migration-626 unique indexes)
 *   - failure injection: kill -9, graceful SHUTDOWN, TCP interruption (refuse), blackhole, wrong/absent password
 *
 * Skips LOUDLY (never "passes") when the portable redis-server binary is absent.
 * Run: node --experimental-vm-modules ./node_modules/jest/bin/jest.js src/services/redisResilience.proof.test.ts --no-coverage --forceExit
 * Measured numbers are written to $GATE3_METRICS_OUT (default ./gate3-metrics.json) for the evidence pack.
 */
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { appendFileSync, writeFileSync } from 'node:fs';
import Bull from 'bull';
import type pg from 'pg';
import { ChaosProxy, RedisProc, freePort, redisAvailable, sleep, waitFor } from './redisTestKit.js';

const logSpy = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.unstable_mockModule('../utils/logger.js', () => ({ default: logSpy }));

const suite = redisAvailable ? describe : describe.skip;
if (!redisAvailable) console.error('[GATE3 SKIPPED] portable redis-server not found: Gate 3 real-Redis tests were NOT executed');

const metrics: Record<string, unknown> = {};
const asyncFaults: string[] = [];
const onFault = (e: unknown) => asyncFaults.push(String((e as Error)?.stack ?? e));

const PW = 'gate3-test-password';
// opt-in step trace for diagnosing hangs: GATE3_TRACE=1 (writes ./gate3-trace.log); off by default so runs leave no files
const trace = (m: string) => { if (process.env.GATE3_TRACE) appendFileSync('gate3-trace.log', `${Date.now()} ${m}\n`); };
function tmo<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, sleep(ms).then((): never => { throw new Error(`timeout ${ms}ms`); })]);
}
const QUEUES = ['inventory', 'reports', 'exports', 'calculations', 'imports', 'banking', 'gl_events', 'notifications'];

type Mods = {
  JobQueueService: typeof import('./jobQueue.js').JobQueueService;
  DistributedCacheService: typeof import('./distributedCache.js').DistributedCacheService;
  processBankingJob: typeof import('./bankingRetryWorker.js').processBankingJob;
  jobQueueSingleton: { closeAll(): Promise<void> };
  cacheSingleton: { close(): Promise<void> };
};
let M: Mods;

function pointAppAt(port: number, password: string | undefined) {
  process.env.REDIS_URL = password ? `redis://:${encodeURIComponent(password)}@127.0.0.1:${port}` : `redis://127.0.0.1:${port}`;
  process.env.REDIS_HOST = '127.0.0.1';
  process.env.REDIS_PORT = String(port);
  if (password) process.env.REDIS_PASSWORD = password; else delete process.env.REDIS_PASSWORD;
}

interface Rig { redis: RedisProc; proxy: ChaosProxy; q: InstanceType<Mods['JobQueueService']>; cache: InstanceType<Mods['DistributedCacheService']>; stop(): Promise<void>; }

async function rig(opts: { appPassword?: string | null; appendonly?: boolean } = {}): Promise<Rig> {
  const rport = await freePort(); const pport = await freePort();
  const redis = new RedisProc({ port: rport, password: PW, appendonly: opts.appendonly });
  await redis.start();
  const proxy = new ChaosProxy(pport, rport); await proxy.start();
  pointAppAt(pport, opts.appPassword === undefined ? PW : opts.appPassword ?? undefined);
  const q = new M.JobQueueService(); const cache = new M.DistributedCacheService();
  return {
    redis, proxy, q, cache,
    async stop() {
      // every step is bounded: Bull/ioredis close() can block while Redis is unreachable
      const T = trace;
      T('stop:begin');
      await Promise.race([q.closeAll(), sleep(3000)]).catch(() => undefined); T('stop:queues');
      await Promise.race([cache.close().catch(() => undefined), sleep(3000)]); T('stop:cache');
      await Promise.race([proxy.stop(), sleep(3000)]); T('stop:proxy');
      await Promise.race([this.redis.kill(), sleep(9000)]); T('stop:redis'); // this.redis = CURRENT process (tests replace it on restart)
    },
  };
}

async function redisInfo(r: RedisProc, section: string): Promise<Record<string, string>> {
  const c = r.admin(); const raw = await c.info(section); c.disconnect();
  return Object.fromEntries(raw.split(/\r?\n/).filter((l) => l.includes(':')).map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1)]));
}

const goodPayload = (over: Record<string, unknown> = {}) => ({
  saleId: '11111111-1111-4111-8111-111111111111', saleNumber: 'SALE-1', saleDate: '2026-10-28',
  payments: [{ amount: 5000, paymentMethod: 'MOBILE_MONEY' }, { amount: 3000, paymentMethod: 'MOBILE_MONEY' }, { amount: 2000, paymentMethod: 'CARD' }],
  ...over,
});

suite('GATE 3 — Redis & queue resilience (real Redis)', () => {
  beforeAll(async () => {
    process.on('unhandledRejection', onFault); process.on('uncaughtException', onFault);
    pointAppAt(1, 'unused'); // singletons created at import must not touch a real Redis
    const jq = await import('./jobQueue.js'); const dc = await import('./distributedCache.js'); const bw = await import('./bankingRetryWorker.js');
    M = { JobQueueService: jq.JobQueueService, DistributedCacheService: dc.DistributedCacheService, processBankingJob: bw.processBankingJob, jobQueueSingleton: jq.jobQueue, cacheSingleton: dc.distributedCache };
  });
  afterAll(async () => {
    await Promise.race([M?.jobQueueSingleton.closeAll(), sleep(2000)]).catch(() => undefined);
    await M?.cacheSingleton.close().catch(() => undefined);
    process.off('unhandledRejection', onFault); process.off('uncaughtException', onFault);
    metrics.asyncFaultsObserved = asyncFaults.length;
    writeFileSync(process.env.GATE3_METRICS_OUT ?? 'gate3-metrics.json', JSON.stringify(metrics, null, 2));
  });

  // ───────────────────────────── authentication ─────────────────────────────
  it('3.1 every queue + the cache authenticates; Redis recorded ZERO auth denials; a job round-trips', async () => {
    const r = await rig();
    try {
      for (const n of QUEUES) await expect(r.q.getQueue(n)!.isReady()).resolves.toBeDefined();
      let seen = 0;
      r.q.processQueue('banking', async () => { seen++; return 'ok'; });
      await r.q.addJob('banking', 'ping', { n: 1 });
      await waitFor(() => seen === 1, 10000, 'job processed');
      await r.cache.set('k', { v: 1 }, 30);
      expect(await r.cache.get('k')).toEqual({ v: 1 });
      await sleep(1000);
      const stats = await redisInfo(r.redis, 'stats'); const clients = await redisInfo(r.redis, 'clients');
      metrics.auth = { queuesReady: QUEUES.length, aclDeniedAuth: Number(stats.acl_access_denied_auth), connectedClients: Number(clients.connected_clients) };
      expect(Number(stats.acl_access_denied_auth)).toBe(0);
      expect(Number(clients.connected_clients)).toBeGreaterThanOrEqual(QUEUES.length);
    } finally { await r.stop(); }
  }, 60000);

  it.each([['wrong password', 'definitely-wrong'], ['no password', null]])(
    '3.2 %s: Redis REJECTS, app does not crash/hang, cache degrades to null, errors are throttled',
    async (_label, appPw) => {
      const r = await rig({ appPassword: appPw });
      try {
        logSpy.error.mockClear(); asyncFaults.length = 0;
        const a0 = r.proxy.attempts;
        await sleep(6000);
        const connAttempts6s = r.proxy.attempts - a0;
        const t0 = Date.now(); const got = await r.cache.get('k'); const ms = Date.now() - t0;
        const healthy = await r.cache.healthCheck();
        const stats = await redisInfo(r.redis, 'stats');
        metrics[`auth_${_label.replace(/\W/g, '_')}`] = { aclDeniedAuth: Number(stats.acl_access_denied_auth), cacheGetMs: ms, errorLogLines6s: logSpy.error.mock.calls.length, connAttempts6s, connAttemptsPerSec: +(connAttempts6s / 6).toFixed(1) };
        console.warn(`[gate3] ${_label}: connAttempts6s=${connAttempts6s} aclDenied=${stats.acl_access_denied_auth}`);
        expect(Number(stats.acl_access_denied_auth) + Number((await redisInfo(r.redis, 'stats')).total_error_replies)).toBeGreaterThan(0); // Redis really enforced auth
        // no reconnect storm on auth failure: was ~3,044 attempts / 6s (~500/s) before utils/redisBackoff.ts
        expect(connAttempts6s).toBeLessThan(200);
        expect(got).toBeNull();
        expect(ms).toBeLessThan(1500);
        expect(healthy).toBe(false);
        expect(logSpy.error.mock.calls.length).toBeLessThan(40);
        expect(asyncFaults).toEqual([]);
      } finally { await r.stop(); }
    }, 60000);

  // ───────────────────────────── outages ─────────────────────────────
  it('3.3 network interruption (connections dropped + refused 12s): bounded reconnects, throttled logs, auto-recovery', async () => {
    const r = await rig();
    try {
      await sleep(2500);
      const clients = r.proxy.attempts;
      let handled = 0;
      r.q.processQueue('banking', async () => { handled++; return 'ok'; });
      logSpy.error.mockClear(); asyncFaults.length = 0;
      const a0 = r.proxy.attempts;
      r.proxy.interrupt('refuse');
      await sleep(12000);
      const attempts = r.proxy.attempts - a0; const perClientPerSec = attempts / clients / 12; const errLines = logSpy.error.mock.calls.length;
      const t0 = Date.now(); const cacheVal = await r.cache.get('x'); const cacheMs = Date.now() - t0;
      // What does a producer see while Redis is unreachable? (salesService enqueues failed bank mirrors here)
      const tAdd = Date.now();
      const addOutcome = await tmo(r.q.addJob('reports', 'during-outage', { n: 0 }), 8000).then(() => 'resolved', (e: Error) => e.message);
      const addMs = Date.now() - tAdd;
      metrics.addJobDuringOutage = { outcome: addOutcome, ms: addMs, before: 'never returned (still pending after 4000ms)' };
      // must REJECT promptly so callers' catch/fallback paths run (was: hang forever => POS request hangs)
      expect(addOutcome).toMatch(/enqueue timed out/);
      expect(addMs).toBeLessThan(5000);
      r.proxy.heal();
      const tHeal = Date.now();
      await waitFor(async () => (await r.q.getQueueStats('banking').then(() => true).catch(() => false)), 30000, 'queue stats usable', 250);
      await r.q.addJob('banking', 'after-heal', { n: 2 });
      await waitFor(() => handled === 1, 30000, 'job handled after heal', 100);
      const recoveredMs = Date.now() - tHeal;
      metrics.interruptRefuse12s = { clientConnections: clients, reconnectAttempts: attempts, perClientPerSec: +perClientPerSec.toFixed(2), errorLogLines: errLines, cacheMs, recoveredMs };
      expect(cacheVal).toBeNull(); expect(cacheMs).toBeLessThan(1500);
      expect(perClientPerSec).toBeLessThanOrEqual(1.0);   // no reconnect storm
      expect(errLines).toBeLessThanOrEqual(40);            // was 96 before throttling (8/s)
      expect(recoveredMs).toBeLessThan(20000);
      expect(asyncFaults).toEqual([]);
    } finally { await r.stop(); }
  }, 120000);

  it('3.4 blackhole (accepts TCP, never answers) 12s: no crash, cache returns fast, recovers when healed', async () => {
    const r = await rig();
    try {
      await sleep(2500);
      let handled = 0; r.q.processQueue('banking', async () => { handled++; return 'ok'; });
      logSpy.error.mockClear(); asyncFaults.length = 0;
      const a0 = r.proxy.attempts;
      r.proxy.interrupt('blackhole');
      await sleep(12000);
      const t0 = Date.now(); const v = await r.cache.get('x'); const ms = Date.now() - t0;
      const attempts = r.proxy.attempts - a0;
      r.proxy.interrupt('pass');
      await waitFor(async () => (await r.q.getQueueStats('banking').then(() => true).catch(() => false)), 60000, 'recovered after blackhole', 500);
      await r.q.addJob('banking', 'after-blackhole', { n: 3 });
      await waitFor(() => handled === 1, 30000, 'job handled', 100);
      metrics.blackhole12s = { reconnectAttempts: attempts, errorLogLines: logSpy.error.mock.calls.length, cacheMs: ms };
      expect(v).toBeNull(); expect(ms).toBeLessThan(2000);
      expect(logSpy.error.mock.calls.length).toBeLessThanOrEqual(40);
      expect(asyncFaults).toEqual([]);
    } finally { await r.stop(); }
  }, 150000);

  it('3.5 Redis killed with kill -9 and restarted: clients reconnect on their own and work resumes', async () => {
    const r = await rig();
    try {
      let handled = 0; r.q.processQueue('banking', async () => { handled++; return 'ok'; });
      await r.q.addJob('banking', 'before', { n: 1 });
      await waitFor(() => handled === 1, 10000, 'first job');
      asyncFaults.length = 0;
      const trace: string[] = [];
      await tmo(r.redis.kill(), 10000); trace.push('killed');
      await sleep(4000);
      expect(await tmo(r.cache.get('x'), 3000)).toBeNull(); // down => null, not throw
      trace.push('cache-null-while-down');
      const redis2 = new RedisProc({ port: r.redis.opts.port, password: PW, dir: r.redis.dir });
      await tmo(redis2.start(), 20000); r.redis = redis2; trace.push('restarted');
      const t0 = Date.now();
      let attemptsToEnqueue = 0;
      await waitFor(async () => { attemptsToEnqueue++; try { await tmo(r.q.addJob('banking', 'after', { n: 2 }), 3000); return true; } catch { return false; } }, 60000, 'enqueue after restart', 500);
      trace.push('enqueued-after-restart');
      await waitFor(() => handled >= 2, 60000, 'job after restart handled', 200);
      trace.push('handled-after-restart');
      metrics.kill9Restart = { reconnectAndProcessedMs: Date.now() - t0, attemptsToEnqueue, trace };
      expect(asyncFaults).toEqual([]);
    } finally { await r.stop(); }
  }, 150000);

  // ───────────────────────────── persistence ─────────────────────────────
  async function persistenceCase(opts: { appendonly: boolean }, how: 'kill' | 'graceful', preKillWaitMs: number): Promise<number> {
    const r = await rig({ appendonly: opts.appendonly });
    try {
      for (let i = 0; i < 5; i++) await r.q.addJob('banking', 'persist', goodPayload({ saleNumber: `P-${i}` }), { delay: 600000 });
      expect((await r.q.getQueueStats('banking')).delayed).toBe(5);
      await sleep(preKillWaitMs);
      trace('persist:pre-stop');
      if (how === 'kill') await tmo(r.redis.kill(), 10000); else await r.redis.stopGraceful();
      trace('persist:stopped');
      // NOTE: do not closeAll() here — Bull.close() blocks while its Redis is down (see 3.11); r.stop() bounds it.
      const redis2 = new RedisProc({ port: r.redis.opts.port, password: PW, dir: r.redis.dir, appendonly: opts.appendonly });
      await tmo(redis2.start(), 20000); r.redis = redis2;
      trace('persist:restarted');
      const c = redis2.admin(); const n = await c.zcard('bull:banking:delayed'); c.disconnect();
      return n;
    } finally { await r.stop(); }
  }

  it('3.6a KNOWN GAP (production config today: RDB only, appendonly no): kill -9 right after enqueue LOSES the queued jobs', async () => {
    const survived = await persistenceCase({ appendonly: false }, 'kill', 1500);
    metrics.persistence_rdbOnly_kill9 = { enqueued: 5, survived };
    expect(survived).toBe(0); // characterisation: documents the gap that appendonly yes fixes
  }, 90000);

  it('3.6b graceful stop (docker stop => SHUTDOWN SAVE) with the production RDB config KEEPS all queued jobs', async () => {
    const survived = await persistenceCase({ appendonly: false }, 'graceful', 200);
    metrics.persistence_rdbOnly_graceful = { enqueued: 5, survived };
    expect(survived).toBe(5);
  }, 90000);

  it('3.6c with appendonly yes + everysec, kill -9 keeps all queued jobs (the proposed hardening works)', async () => {
    const survived = await persistenceCase({ appendonly: true }, 'kill', 2000);
    metrics.persistence_aof_kill9 = { enqueued: 5, survived };
    expect(survived).toBe(5);
  }, 90000);

  // ───────────── migration path: turning AOF on for a Redis volume that so far only has dump.rdb ─────────────
  async function seedJobs(r: Rig, n: number) {
    for (let i = 0; i < n; i++) await r.q.addJob('banking', 'seed', goodPayload({ saleNumber: `S-${i}` }), { delay: 600000 });
  }
  async function delayedCount(redis: RedisProc): Promise<number> { const c = redis.admin(); const n = await c.zcard('bull:banking:delayed'); c.disconnect(); return n; }

  it('3.11a DEPLOY HAZARD: recreating Redis with appendonly yes on an RDB-only volume starts EMPTY (dump.rdb ignored) — enable AOF at runtime first (3.11b)', async () => {
    const r = await rig({ appendonly: false });
    try {
      await seedJobs(r, 3);
      await r.redis.stopGraceful();                       // RDB written
      const redis2 = new RedisProc({ port: r.redis.opts.port, password: PW, dir: r.redis.dir, appendonly: true });
      await tmo(redis2.start(), 20000); r.redis = redis2;
      const survived = await delayedCount(redis2);
      metrics.aofMigration_naiveStartup = { enqueued: 3, survived, note: 'appendonly yes at startup on a volume with dump.rdb and no AOF files' };
      expect(survived).toBe(0);                          // measured on Redis 8.x; if this ever changes, the deploy runbook can be simplified
    } finally { await r.stop(); }
  }, 90000);

  it('3.11b SAFE PROCEDURE: CONFIG SET appendonly yes at runtime (no restart), then kill -9 and restart with appendonly yes keeps every job', async () => {
    const r = await rig({ appendonly: false });
    try {
      await seedJobs(r, 3);
      const c = r.redis.admin();
      await c.config('SET', 'appendonly', 'yes');
      await waitFor(async () => { const i = await c.info('persistence'); return /aof_enabled:1/.test(i) && /aof_rewrite_in_progress:0/.test(i) && /aof_last_bgrewrite_status:ok/.test(i); }, 20000, 'AOF rewrite complete', 200);
      c.disconnect();
      await sleep(1500);                                  // everysec
      await tmo(r.redis.kill(), 10000);
      const redis2 = new RedisProc({ port: r.redis.opts.port, password: PW, dir: r.redis.dir, appendonly: true });
      await tmo(redis2.start(), 20000); r.redis = redis2;
      const survived = await delayedCount(redis2);
      metrics.aofMigration_safePath = { enqueued: 3, survived };
      expect(survived).toBe(3);
    } finally { await r.stop(); }
  }, 90000);

  // ───────────────────────────── banking worker: retry, no silent loss, untrusted input ─────────────────────────────
  const FAST = { attempts: 3, backoff: { type: 'fixed' as const, delay: 150 } };
  const fakePool = {} as pg.Pool;

  it('3.7 banking job: tenant pool unresolved twice then OK => retried, mirrored once per METHOD (same-method lines summed)', async () => {
    const r = await rig();
    try {
      const create = jest.fn(async () => undefined);
      let resolves = 0;
      r.q.processQueue('banking', (job) => M.processBankingJob(job as never, {
        resolveTenantPool: async () => (++resolves <= 2 ? null : fakePool), createFromSale: create as never,
      }));
      await r.q.addJob('banking', 'bank-retry', goodPayload({ tenantId: '22222222-2222-4222-8222-222222222222' }), FAST);
      await waitFor(async () => (await r.q.getQueueStats('banking')).completed === 1, 20000, 'completed after retries', 100);
      expect(resolves).toBe(3);
      expect(create).toHaveBeenCalledTimes(2);                       // MOBILE_MONEY (5000+3000) and CARD — not 3 calls
      expect(create).toHaveBeenCalledWith(expect.any(String), 'SALE-1', 8000, 'MOBILE_MONEY', '2026-10-28', fakePool);
      expect(create).toHaveBeenCalledWith(expect.any(String), 'SALE-1', 2000, 'CARD', '2026-10-28', fakePool);
      expect((await r.q.getQueueStats('banking')).failed).toBe(0);
      metrics.bankingRetry = { resolveAttempts: resolves, createFromSaleCalls: create.mock.calls.length };
    } finally { await r.stop(); }
  }, 60000);

  it('3.8 banking job whose tenant pool NEVER resolves is NOT silently completed: it ends in the failed set, nothing mirrored', async () => {
    const r = await rig();
    try {
      const create = jest.fn(async () => undefined);
      r.q.processQueue('banking', (job) => M.processBankingJob(job as never, { resolveTenantPool: async () => null, createFromSale: create as never }));
      await r.q.addJob('banking', 'bank-retry', goodPayload({ tenantId: '22222222-2222-4222-8222-222222222222' }), FAST);
      await waitFor(async () => (await r.q.getQueueStats('banking')).failed === 1, 20000, 'failed set holds the job', 100);
      const s = await r.q.getQueueStats('banking');
      expect(s.completed).toBe(0); expect(create).not.toHaveBeenCalled();
      const failed = await r.q.getQueue('banking')!.getFailed();
      expect(failed[0].attemptsMade).toBe(3);                         // all retries used, then retained for audit
    } finally { await r.stop(); }
  }, 60000);

  it.each([
    ['payload missing (foreign producer)', { foo: 'bar' }, undefined],
    ['non-uuid saleId / negative amount / unknown method', undefined, goodPayload({ saleId: "x'; DROP TABLE sales;--", payments: [{ amount: -5, paymentMethod: 'EVIL' }] })],
    ['NaN-like amount', undefined, goodPayload({ payments: [{ amount: 'NaN', paymentMethod: 'CARD' }] })],
    ['tenantId not a uuid', undefined, goodPayload({ tenantId: '../../etc/passwd' })],
  ])('3.9 planted/invalid job (%s): never reaches the bank writer, rejected on the first attempt (no retry loop)', async (_l, rawData, payload) => {
    const r = await rig();
    try {
      const create = jest.fn(async () => undefined); const resolve = jest.fn(async () => fakePool);
      r.q.processQueue('banking', (job) => M.processBankingJob(job as never, { resolveTenantPool: resolve as never, createFromSale: create as never }));
      if (rawData) await r.q.getQueue('banking')!.add(rawData as never, FAST);
      else await r.q.addJob('banking', 'planted', payload, FAST);
      await waitFor(async () => (await r.q.getQueueStats('banking')).failed === 1, 20000, 'rejected job in failed set', 100);
      const failed = await r.q.getQueue('banking')!.getFailed();
      expect(failed[0].attemptsMade).toBe(1);        // discard() => no retries
      expect(create).not.toHaveBeenCalled(); expect(resolve).not.toHaveBeenCalled();
    } finally { await r.stop(); }
  }, 60000);

  // ───────────────────────────── duplicate delivery ─────────────────────────────
  it('3.10 stalled job (worker lost its lock) is RE-DELIVERED by Bull (at-least-once) with the identical payload/idempotency key', async () => {
    const rport = await freePort();
    const redis = new RedisProc({ port: rport, password: PW }); await redis.start();
    const url = `redis://:${PW}@127.0.0.1:${rport}`;
    const q = new Bull('stalltest', url, { settings: { lockDuration: 1000, stalledInterval: 400, maxStalledCount: 2 } });
    const seen: string[] = [];
    try {
      let first = true;
      q.process(async (job) => {
        seen.push(`${job.id}:${(job.data as { key: string }).key}`);
        if (first) { first = false; await sleep(2500); }        // simulates a hung/crashed worker
        return 'done';
      });
      const job = await q.add({ key: 'Sale N [CARD]' });
      await waitFor(() => seen.length === 1, 5000, 'first delivery');
      const c = redis.admin(); await c.del(`bull:stalltest:${job.id}:lock`); c.disconnect(); // lock lost => stalled
      await waitFor(() => seen.length >= 2, 15000, 'second delivery', 100);
      metrics.redelivery = { deliveries: seen.length, sameKey: new Set(seen).size === 1 };
      expect(new Set(seen).size).toBe(1);   // same job id + same payload => consumer MUST be idempotent (BankingService is: existing-row check + unique index)
    } finally { await q.close().catch(() => undefined); await redis.kill(); }
  }, 60000);
});
