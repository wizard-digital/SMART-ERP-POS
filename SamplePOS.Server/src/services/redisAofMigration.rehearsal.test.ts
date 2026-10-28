/**
 * REHEARSAL — enabling Redis persistence (AOF) on production-equivalent Redis 7.4.8 with a COPY of the real
 * production dump.rdb (100k keys, taken read-only from the live volume).
 *
 * Nothing here touches production. It proves (or refutes) each claim the production procedure relies on:
 *   R1  fidelity: server is 7.4.8, loads the real prod RDB, mirrors prod config (rename-commands, noeviction, save points)
 *   R2  hazard : booting with `appendonly yes` on a volume that only has dump.rdb  (what editing compose + recreate would do)
 *   R3  safe path: runtime CONFIG SET appendonly yes -> AOF built + validated (redis-check-aof) -> controlled restart
 *       with appendonly yes -> keyspace digest identical; wait/active/delayed/failed/completed/retryable job states retained
 *   R4  app reconnect: a worker attached after the restart processes every job; redelivered jobs do not create 2nd bank rows
 *   R5  crash durability after AOF is on (kill -9 loses <= ~1s)
 *   R6  rollback: graceful vs crash vs BGSAVE-first; appendonlydir is retained, never deleted
 *   R7  the digest tool is read-only
 *
 * Binary / data (skips LOUDLY when absent):
 *   REDIS_748_BIN   default %TEMP%/redis748/x/Redis-7.4.8-Windows-x64-msys2/redis-server.exe
 *   PROD_RDB_COPY   default %TEMP%/redis-prod-copy/dump.rdb     (sensitive: never commit)
 */
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Bull from 'bull';
import { Redis } from 'ioredis';
import { RedisProc, freePort, sleep, waitFor } from './redisTestKit.js';

const logSpy = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.unstable_mockModule('../utils/logger.js', () => ({ default: logSpy }));

const BIN = process.env.REDIS_748_BIN || join(tmpdir(), 'redis748', 'x', 'Redis-7.4.8-Windows-x64-msys2', 'redis-server.exe');
const CHECK_AOF = join(dirname(BIN), 'redis-check-aof.exe');
const PROD_RDB = process.env.PROD_RDB_COPY || join(tmpdir(), 'redis-prod-copy', 'dump.rdb');
const ready = existsSync(BIN) && existsSync(PROD_RDB);
const suite = ready ? describe : describe.skip;
if (!ready) console.error('[REHEARSAL SKIPPED] Redis 7.4.8 binary or prod RDB copy not found: the persistence rehearsal was NOT executed');

const PW = 'rehearsal-password';
// mirrors the generated /tmp/redis-secure.conf on the production host
const PROD_ARGS = ['--rename-command', 'SLAVEOF', '', '--rename-command', 'REPLICAOF', '', '--rename-command', 'MODULE', '', '--rename-command', 'DEBUG', ''];
const VOLATILE = [/:lock$/, /:stalled-check$/, /:stalled$/]; // owned by live workers, expire by design

const metrics: Record<string, unknown> = {};
let dig: {
  snapshotKeyspace(c: Redis, o?: { ignore?: RegExp[] }): Promise<{ keys: number; digest: string; perKey: Map<string, string>; byPrefix: Record<string, { keys: number; digest: string }> }>;
  diffSnapshots(a: unknown, b: unknown): { missing: string[]; added: string[]; changed: string[] };
  bullCensus(c: Redis, q: string): Promise<Record<string, number>>;
  READ_ONLY_COMMANDS: Set<string>;
};
const tmpDirs: string[] = [];

function newDataDir(withProdRdb = true): string {
  const d = mkdtempSync(join(tmpdir(), 'redis-aof-rehearsal-'));
  tmpDirs.push(d);
  if (withProdRdb) cpSync(PROD_RDB, join(d, 'dump.rdb'));
  return d;
}
const proc = (dir: string, port: number, appendonly: boolean) =>
  new RedisProc({ port, password: PW, dir, appendonly, binary: BIN, extraArgs: PROD_ARGS });
const url = (port: number) => `redis://:${PW}@127.0.0.1:${port}`;
const info = async (c: Redis, section: string): Promise<Record<string, string>> =>
  Object.fromEntries((await c.info(section)).split(/\r?\n/).filter((l) => l.includes(':')).map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1)]));
const snap = async (port: number) => {
  const c = new Redis({ port, password: PW, maxRetriesPerRequest: 2 });
  try { return await dig.snapshotKeyspace(c, { ignore: VOLATILE }); } finally { c.disconnect(); }
};
async function waitAofReady(c: Redis): Promise<Record<string, string>> {
  await waitFor(async () => { const p = await info(c, 'persistence'); return p.aof_rewrite_in_progress === '0' && p.aof_last_bgrewrite_status === 'ok' && p.aof_enabled === '1'; }, 30000, 'AOF rewrite finished', 100);
  return info(c, 'persistence');
}
// exact shape JobQueueService.addJob() stores: { type, payload, userId, timestamp }
const bankPayload = (n: string, over: Record<string, unknown> = {}) => ({
  type: 'bank-retry', userId: 'system', timestamp: '2026-10-28T00:00:00.000Z',
  payload: {
    saleId: '11111111-1111-4111-8111-111111111111', saleNumber: n, saleDate: '2026-10-28',
    payments: [{ amount: 5000, paymentMethod: 'MOBILE_MONEY' }, { amount: 3000, paymentMethod: 'MOBILE_MONEY' }, { amount: 2000, paymentMethod: 'CARD' }], ...over,
  },
});
const sk = (sale: string, method: string) => `${sale}|${method}`;

/** Bank-row store with the SAME contract as production: unique (sale, method); a second insert is a no-op (uq_bank_txn_sale_source_desc_live). */
class IdempotentBankStore {
  rows = new Set<string>();
  calls = 0;
  create = async (_saleId: string, saleNumber: string, amount: number, method: string) => {
    this.calls++;
    if (amount <= 0) throw new Error('bad amount');
    this.rows.add(sk(saleNumber, method));
  };
}

/** Plant every job state on `port`, then disconnect all app clients (so digests are deterministic). */
async function plantAllStates(port: number): Promise<{ ids: Record<string, string[]> }> {
  const q = new Bull('banking', url(port), { settings: { lockDuration: 2000, stalledInterval: 1000, maxStalledCount: 3 } });
  const store = new IdempotentBankStore();
  const hang = new Promise<never>(() => undefined);
  const { processBankingJob } = await import('./bankingRetryWorker.js');
  const retriedOnce = new Set<string>();
  // processor: C=completes, F=fails permanently, R=fails once (retryable, long backoff), A=hangs (active), D=writes bank row then hangs
  void q.process(5, async (job) => {
    const tag = String(job.data.payload.saleNumber).split('-')[0];
    if (tag === 'F') throw new Error('permanent failure');
    if (tag === 'R' && !retriedOnce.has(String(job.id))) { retriedOnce.add(String(job.id)); throw new Error('transient failure'); }
    if (tag === 'A') return hang;
    if (tag === 'D') { await processBankingJob(job as never, { resolveTenantPool: async () => ({}) as never, createFromSale: store.create as never }); return hang; }
    await processBankingJob(job as never, { resolveTenantPool: async () => ({}) as never, createFromSale: store.create as never });
    return undefined;
  });
  const ids: Record<string, string[]> = { C: [], F: [], R: [], A: [], D: [], W: [], T: [] };
  const add = async (tag: string, n: string, opts: Bull.JobOptions = {}) => { const j = await q.add(bankPayload(`${tag}-${n}`), opts); ids[tag].push(String(j.id)); return j; };
  await add('C', '1'); await add('C', '2');
  await waitFor(async () => (await q.getCompletedCount()) === 2, 15000, 'two jobs completed');
  await add('F', '1', { attempts: 1 });
  await add('R', '1', { attempts: 3, backoff: { type: 'fixed', delay: 3_600_000 } });
  await add('A', '1', { attempts: 3 });
  await add('D', '1', { attempts: 3 });
  await waitFor(async () => (await q.getActiveCount()) === 2 && (await q.getFailedCount()) === 1 && (await q.getDelayedCount()) === 1, 15000, 'active/failed/retryable states reached');
  // now stop consuming and add the waiting + scheduled jobs (no worker => they stay `wait` / `delayed`)
  await q.close(true);
  const q2 = new Bull('banking', url(port));
  for (const n of ['1', '2', '3']) ids.W.push(String((await q2.add(bankPayload(`W-${n}`), { attempts: 3 })).id));
  for (const n of ['1', '2']) ids.T.push(String((await q2.add(bankPayload(`T-${n}`), { delay: 7_200_000, attempts: 3 })).id));
  await q2.close(true);
  metrics.plantedBankRowsBeforeMigration = [...store.rows];
  return { ids };
}

async function census(port: number) {
  const c = new Redis({ port, password: PW });
  try { return await dig.bullCensus(c, 'banking'); } finally { c.disconnect(); }
}

suite('REHEARSAL — Redis 7.4.8 AOF migration on a copy of the production dataset', () => {
  beforeAll(async () => {
    process.env.REDIS_URL = 'redis://127.0.0.1:1'; // modules imported below must never touch a real Redis
    dig = (await import(/* webpackIgnore: true */ ('../../scripts/ops/' + 'redis-digest.mjs') as string)) as typeof dig;
  });
  afterAll(() => {
    writeFileSync(process.env.REHEARSAL_METRICS_OUT || 'redis-aof-rehearsal-metrics.json', JSON.stringify(metrics, null, 2));
    for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
  });

  it('R1 fidelity: 7.4.8 loads the real production RDB with production-equivalent config', async () => {
    const port = await freePort();
    const p = proc(newDataDir(), port, false);
    await p.start();
    const c = p.admin();
    try {
      const server = await info(c, 'server');
      expect(server.redis_version).toBe('7.4.8');
      expect(Number(await c.dbsize())).toBeGreaterThan(100000);
      const cfg = async (k: string) => (await c.config('GET', k) as string[])[1];
      expect(await cfg('appendonly')).toBe('no');
      expect(await cfg('maxmemory-policy')).toBe('noeviction');
      await expect(c.call('DEBUG', 'SLEEP', '0')).rejects.toThrow(/unknown command/i);
      await expect(c.call('SLAVEOF', 'NO', 'ONE')).rejects.toThrow(/unknown command/i);
      const s = await dig.snapshotKeyspace(c, { ignore: VOLATILE });
      metrics.R1 = { version: server.redis_version, keys: s.keys, digest: s.digest, prefixes: s.byPrefix };
    } finally { c.disconnect(); await p.kill(); }
  }, 120000);

  it('R2 hazard: booting with appendonly yes on a dump.rdb-only volume (what a compose edit + recreate would do)', async () => {
    const port = await freePort();
    const dir = newDataDir();
    const before = await (async () => { const p0 = proc(newDataDir(), await freePort(), false); await p0.start(); const c = p0.admin(); const n = Number(await c.dbsize()); c.disconnect(); await p0.kill(); return n; })();
    const p = proc(dir, port, true);
    await p.start();
    const c = p.admin();
    try {
      const after = Number(await c.dbsize());
      const ap = await info(c, 'persistence');
      metrics.R2_hazard = { keysInRdb: before, keysAfterBootWithAofOn: after, aof_enabled: ap.aof_enabled, files: readdirSync(dir) };
      // The procedure forbids this path. Assert what really happens so the runbook claim is evidence, not folklore.
      expect(after).toBe(0);
      expect(before).toBeGreaterThan(100000);
    } finally { c.disconnect(); await p.kill(); }
  }, 120000);

  it('R3 safe path: CONFIG SET appendonly yes -> AOF validated -> controlled restart -> identical keyspace and job states', async () => {
    const port = await freePort();
    const dir = newDataDir();
    let p = proc(dir, port, false);
    await p.start();
    const { ids } = await plantAllStates(port);

    // ── pre-migration truth (app disconnected) ──
    const cen0 = await census(port);
    expect(cen0).toEqual({ wait: 3, active: 2, paused: 0, delayed: 3, failed: 1, completed: 2 }); // delayed = 2 scheduled + 1 retryable
    const pre = await snap(port);

    // ── step 1: runtime enable (no restart) ──
    const c = p.admin();
    await c.config('SET', 'appendonly', 'yes');
    const ap = await waitAofReady(c);
    expect(ap.aof_last_write_status).toBe('ok');
    const mid = await snap(port);
    expect(mid.digest).toBe(pre.digest);
    const aofDir = join(dir, 'appendonlydir');
    const files = readdirSync(aofDir);
    expect(files.some((f) => f.endsWith('.manifest'))).toBe(true);
    expect(files.some((f) => /\.base\.rdb$/.test(f))).toBe(true);
    expect(files.some((f) => /\.incr\.aof$/.test(f))).toBe(true);
    const manifest = join(aofDir, files.find((f) => f.endsWith('.manifest'))!);
    const chk = spawnSync(CHECK_AOF, [manifest], { encoding: 'utf8' });
    metrics.R3_redisCheckAof = { status: chk.status, tail: (chk.stdout + chk.stderr).trim().split(/\r?\n/).slice(-4) };
    expect(chk.status).toBe(0);

    // ── step 2: controlled restart with the NEW (appendonly yes) config on the SAME directory ──
    await p.stopGraceful();
    p = proc(dir, port, true);
    await p.start();
    const post = await snap(port);
    const diff = dig.diffSnapshots(pre, post);
    expect(diff).toEqual({ missing: [], added: [], changed: [] });
    expect(post.digest).toBe(pre.digest);
    expect(await census(port)).toEqual(cen0);                       // wait/active/delayed/failed/completed all retained
    const c2 = p.admin();
    expect((await info(c2, 'persistence')).aof_enabled).toBe('1');
    expect(await c2.llen('bull:banking:active')).toBe(2);
    // retryable job kept its attempt history
    const retry = await c2.hgetall(`bull:banking:${ids.R[0]}`);
    expect(Number(retry.attemptsMade)).toBe(1);
    expect(Number(retry.attempts ?? JSON.parse(retry.opts).attempts)).toBe(3);
    metrics.R3 = { keys: post.keys, digestPre: pre.digest, digestPost: post.digest, census: cen0, aof: files };

    // ── R4: app reconnects; worker drains; effects are exactly-once per (sale, method) ──
    const store = new IdempotentBankStore();
    const { processBankingJob } = await import('./bankingRetryWorker.js');
    const q = new Bull('banking', url(port), { settings: { lockDuration: 1500, stalledInterval: 400, maxStalledCount: 3 } });
    // D-1 already wrote its bank row BEFORE the restart (hung before ack) — seed that history into the store
    store.rows.add(sk('D-1', 'MOBILE_MONEY')); store.rows.add(sk('D-1', 'CARD'));
    void q.process(5, (job) => processBankingJob(job as never, { resolveTenantPool: async () => ({}) as never, createFromSale: store.create as never }));
    // wait + stalled-active jobs (W1-3, A1, D1) must complete; scheduled (T) and retryable (R) stay delayed
    try {
      await waitFor(async () => (await q.getCompletedCount()) >= 2 + 5, 60000, 'drain', 100);
    } catch (e) {
      throw new Error(`${(e as Error).message} :: census=${JSON.stringify(await dig.bullCensus(c2, 'banking'))} rows=${[...store.rows].join(',')} errors=${JSON.stringify(logSpy.error.mock.calls.slice(0, 3))} warns=${JSON.stringify(logSpy.warn.mock.calls.slice(0, 3))}`);
    }
    const cen1 = await dig.bullCensus(c2, 'banking');
    expect(cen1.wait).toBe(0); expect(cen1.active).toBe(0);
    expect(cen1.delayed).toBe(3);                                   // T-1, T-2, R-1 untouched
    expect(cen1.failed).toBe(1);                                    // F-1 retained for audit
    for (const n of ['W-1', 'W-2', 'W-3', 'A-1', 'D-1', 'C-1']) {
      if (n === 'C-1') continue; // completed before the restart; not redelivered
      expect(store.rows.has(sk(n, 'MOBILE_MONEY'))).toBe(true);
      expect(store.rows.has(sk(n, 'CARD'))).toBe(true);
    }
    // one row per (sale, method): W/A/D ×{MOBILE_MONEY, CARD}; D-1 delivered twice in total, one row only
    expect(store.rows.size).toBe(5 * 2);
    const delivered = store.calls;
    metrics.R4 = { bankRows: store.rows.size, createFromSaleCalls: delivered, doubleDeliveredButDeduped: ['D-1'], census: cen1 };
    await q.close(true);
    c2.disconnect();
    await p.kill();
  }, 240000);

  it('R5 crash durability once AOF is on: kill -9 after the 1s fsync window loses nothing', async () => {
    const port = await freePort();
    const dir = newDataDir();
    let p = proc(dir, port, false);
    await p.start();
    let c = p.admin();
    await c.config('SET', 'appendonly', 'yes');
    await waitAofReady(c);
    for (let i = 0; i < 50; i++) await c.set(`rehearsal:crash:${i}`, String(i));
    await sleep(1600); // appendfsync everysec
    c.disconnect();
    await p.kill();                                                 // SIGKILL: no SAVE, no flush
    p = proc(dir, port, true);
    await p.start();
    c = p.admin();
    try {
      expect(await c.exists(...Array.from({ length: 50 }, (_, i) => `rehearsal:crash:${i}`))).toBe(50);
      metrics.R5 = { recovered: 50, of: 50 };
    } finally { c.disconnect(); await p.kill(); }
  }, 120000);

  describe('R6 rollback (AOF -> RDB-only) never silently discards queued work', () => {
    async function aofRigWithNewJobs() {
      const port = await freePort();
      const dir = newDataDir();
      let p = proc(dir, port, false);
      await p.start();
      let c = p.admin();
      await c.config('SET', 'appendonly', 'yes');
      await waitAofReady(c);
      // jobs enqueued AFTER the last RDB snapshot, only the AOF has them
      const q = new Bull('banking', url(port));
      for (let i = 1; i <= 5; i++) await q.add(bankPayload(`N-${i}`), { attempts: 3 });
      await q.close(true);
      await sleep(1300);
      c.disconnect();
      return { port, dir, p, redo: async () => { c = p.admin(); return c; } };
    }
    const countN = async (port: number) => { const c = new Redis({ port, password: PW }); try { return Number(await c.llen('bull:banking:wait')); } finally { c.disconnect(); } };

    it('graceful stop (docker stop = SIGTERM => SHUTDOWN SAVE) then revert to appendonly no: nothing lost', async () => {
      const r = await aofRigWithNewJobs();
      await r.p.stopGraceful();
      const back = proc(r.dir, r.port, false); await back.start();
      try { expect(await countN(r.port)).toBe(5); } finally { await back.kill(); }
      expect(existsSync(join(r.dir, 'appendonlydir'))).toBe(true);   // retained for forensics, never deleted
    }, 120000);

    it('HAZARD: crash (kill -9 / docker kill / OOM) then revert to RDB-only: AOF-only jobs are lost unless BGSAVE was done first', async () => {
      const r = await aofRigWithNewJobs();
      await r.p.kill();
      const back = proc(r.dir, r.port, false); await back.start();
      let lost: number;
      try { lost = 5 - (await countN(r.port)); } finally { await back.kill(); }
      metrics.R6_hazard_crash_then_rdb_only = { enqueued: 5, lost };
      expect(lost).toBe(5);
    }, 120000);

    it('SAFE rollback: BGSAVE completes first, then revert: nothing lost even after a crash', async () => {
      const r = await aofRigWithNewJobs();
      const c = await r.redo();
      const before = Number((await info(c, 'persistence')).rdb_last_save_time);
      await c.bgsave();
      await waitFor(async () => { const x = await info(c, 'persistence'); return x.rdb_bgsave_in_progress === '0' && x.rdb_last_bgsave_status === 'ok' && Number(x.rdb_last_save_time) >= before; }, 30000, 'bgsave done', 100);
      const unsaved = (await info(c, 'persistence')).rdb_changes_since_last_save;
      c.disconnect();
      await r.p.kill();
      const back = proc(r.dir, r.port, false); await back.start();
      try { expect(await countN(r.port)).toBe(5); metrics.R6_safe = { unsavedChangesAtBgsaveEnd: unsaved }; } finally { await back.kill(); }
    }, 120000);
  });

  it('R7 the digest tool only issues read-only commands', async () => {
    const port = await freePort();
    const p = proc(newDataDir(false), port, false);
    await p.start();
    const admin = p.admin();
    await admin.mset('a', '1', 'b', '2'); await admin.hset('h', 'x', '1'); await admin.rpush('l', 'v'); await admin.zadd('z', 1, 'm'); await admin.sadd('s', 'q');
    const mon = new Redis({ port, password: PW });
    const seen = new Set<string>();
    const m = (await mon.monitor()) as unknown as NodeJS.EventEmitter;
    m.on('monitor', (_t: string, args: string[]) => seen.add(String(args[0]).toUpperCase()));
    await snap(port);
    await sleep(200);
    mon.disconnect(); admin.disconnect(); await p.kill();
    seen.delete('AUTH'); seen.delete('INFO'); seen.delete('CLIENT'); seen.delete('MONITOR');
    const forbidden = [...seen].filter((x) => !dig.READ_ONLY_COMMANDS.has(x));
    expect(forbidden).toEqual([]);
    expect(seen.size).toBeGreaterThan(3);
  }, 60000);
});
