/**
 * REHEARSAL — ops/security/50-redis-suspicious-keys.sh against a REAL Redis 7.4.8 (password, renamed dangerous commands,
 * exactly like production) holding a synthetic keyspace shaped like production's (float:NNNNNN, hui:<letter>, test, bull:*)
 * plus decoys that look similar but must never be touched.
 *
 *   K1  dry-run (default) removes nothing and sends no write command
 *   K2  --apply without the evidence marker is refused
 *   K3  evidence phase: dump.rdb copied + hashed, key manifest, target digest, no secret in the evidence files
 *   K4  remove refuses when the approved counts differ, or when ANY target value has an unexpected shape
 *   K5  remove: exactly the targets are gone; decoys and every bull:* key are byte-identical (DUMP hash)
 *   K6  recovery: scratch Redis loaded from the evidence dump + restore phase brings every target back byte-identical,
 *       and never overwrites a key that already exists on the live instance
 *   K7  static: no FLUSH*, no DEL/UNLINK with a pattern, no KEYS command, password never on a command line
 *
 * The exact same sequence was also run once against a copy of the real production dump.rdb (100,444 keys):
 * see PROOF_REDIS_SUSPICIOUS_KEYS_REHEARSAL.json.
 * Skips LOUDLY when bash / the Redis 7.4.8 binaries are missing.
 */
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Redis } from 'ioredis';
import { RedisProc, freePort } from '../services/redisTestKit.js';

const ROOT = resolve(process.cwd(), '..');
const SCRIPT = join(ROOT, 'ops', 'security', '50-redis-suspicious-keys.sh').replace(/\\/g, '/');
const BASH = [process.env.BASH_BIN, 'C:\\Program Files\\Git\\bin\\bash.exe', '/bin/bash', '/usr/bin/bash'].find((p) => p && existsSync(p));
const BIN = process.env.REDIS_748_BIN || join(tmpdir(), 'redis748', 'x', 'Redis-7.4.8-Windows-x64-msys2', 'redis-server.exe');
const CLI = join(dirname(BIN), 'redis-cli.exe');
const CHECK_RDB = join(dirname(BIN), 'redis-check-rdb.exe');
const ready = !!BASH && existsSync(BIN) && existsSync(CLI);
const suite = ready ? describe : describe.skip;
if (!ready) console.error('[REHEARSAL SKIPPED] bash or Redis 7.4.8 binaries not found: the suspicious-key procedure was NOT executed');

const PW = 'rehearsal-password-K';
const PROD_ARGS = ['--rename-command', 'SLAVEOF', '', '--rename-command', 'REPLICAOF', '', '--rename-command', 'MODULE', '', '--rename-command', 'DEBUG', ''];
const fwd = (p: string) => p.replace(/\\/g, '/');
const N_FLOAT = 3000;
const HUI = 'ABCDEFGHIJKLMNOPQRSTUVWXY'.split(''); // 25 letters

let main: RedisProc, scratch: RedisProc | undefined, c: Redis, work: string, port: number;
const dirs: string[] = [];

const run = (args: string[], env: Record<string, string> = {}) => {
  const r = spawnSync(BASH!, [SCRIPT, ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env, REDISCLI_AUTH: PW, OPS_RCLI: `${fwd(CLI)} --no-auth-warning -a ${PW} -p ${port}`, OPS_CHG_BASE: fwd(join(work, 'chg')),
      OPS_RDB_SRC: fwd(join(main.dir, 'dump.rdb')), OPS_CHECK_RDB: fwd(CHECK_RDB), ...env,
    },
  });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
};

const dumpHash = async (r: Redis, k: string) => crypto.createHash('sha256').update((await r.dumpBuffer(k)) ?? Buffer.alloc(0)).digest('hex');
async function snapshot(r: Redis, keep: (k: string) => boolean): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  let cur = '0';
  do {
    const [n, ks] = await r.scan(cur, 'COUNT', 2000); cur = n;
    for (const k of ks) if (keep(k)) m.set(k, await dumpHash(r, k));
  } while (cur !== '0');
  return m;
}
const isTarget = (k: string) => /^float:\d{6}$/.test(k) || /^hui:[A-Za-z]$/.test(k) || k === 'test';

async function seed(r: Redis) {
  let p = r.pipeline();
  for (let i = 0; i < N_FLOAT; i++) {
    p.set(`float:${String(i).padStart(6, '0')}`, `1337.${String(i).padStart(6, '0')}0500000000${i % 10}`);
    if (i % 500 === 499) { await p.exec(); p = r.pipeline(); }
  }
  for (const ch of HUI) p.set(`hui:${ch}`, Buffer.concat([Buffer.from([0, 0, 16, 0, 0, 0, 16, 0, 3]), Buffer.from(ch.repeat(300))]));
  p.set('test', '1');
  // decoys — similar looking, must survive
  p.set('float:12345', '1337.1'); p.set('float:abcdef', '1337.2'); p.set('floaty:000001', 'x'); p.set('hui:AB', 'x'); p.set('hui:1', 'x');
  p.set('test2', '1'); p.set('app:float:000001', 'x'); p.set('bull:float:000001', 'x'); p.set('Test', '1');
  // BullMQ-shaped keys
  for (const q of ['gl_events', 'banking']) {
    p.hset(`bull:${q}:1`, { name: 'job', data: '{"saleId":1}', attemptsMade: '0' }); p.hset(`bull:${q}:2`, { name: 'job', data: '{"saleId":2}' });
    p.rpush(`bull:${q}:wait`, '1', '2'); p.zadd(`bull:${q}:delayed`, 1893456000000, '2'); p.zadd(`bull:${q}:failed`, 1, '9'); p.set(`bull:${q}:id`, '2');
    p.hset(`bull:${q}:meta`, { 'opts.maxLenEvents': '10000' });
  }
  await p.exec();
}

suite('ops/security/50-redis-suspicious-keys.sh (real Redis 7.4.8 rehearsal)', () => {
  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'redis-keys-'));
    mkdirSync(join(work, 'chg')); dirs.push(work);
    port = await freePort();
    main = new RedisProc({ port, password: PW, dir: join(work, 'live'), binary: BIN, extraArgs: PROD_ARGS, save: '' });
    await main.start();
    c = main.admin();
    await seed(c);
  }, 120000);
  afterAll(async () => {
    try { c?.disconnect(); await scratch?.kill(); await main?.kill(); } catch { /* best effort */ }
    for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
  });

  const writes = async () => {
    const cs = await c.info('commandstats');
    return ['unlink', 'del', 'flushall', 'flushdb', 'set', 'hset', 'expire', 'config|set'].map((n) => {
      const m = cs.match(new RegExp(`cmdstat_${n.replace(/[|]/g, '\\|')}:calls=(\\d+)`));
      return m ? Number(m[1]) : 0;
    });
  };

  it('K1 check and dry-run remove change nothing and issue no write command', async () => {
    const before = await snapshot(c, () => true);
    const w0 = await writes(); const size0 = await c.dbsize();
    const chk = run(['--phase', 'check']);
    expect(chk.status).toBe(0);
    expect(chk.out).toContain(`float=${N_FLOAT} hui=25 test=1`);
    expect(chk.out).toMatch(/MODULE command is disabled/);
    const dry = run(['--phase', 'remove', '--ts', 'K1', '--expect-float', String(N_FLOAT), '--expect-hui', '25', '--expect-test', '1']);
    expect(dry.status).toBe(0);
    expect(dry.out).toContain('DRY-RUN (not executed): UNLINK');
    const after = await snapshot(c, () => true);
    expect(after.size).toBe(before.size);
    expect([...after].every(([k, h]) => before.get(k) === h)).toBe(true);
    expect(await c.dbsize()).toBe(size0);
    expect(await writes()).toEqual(w0);
  }, 120000);

  it('K2 remove --apply without evidence is refused and removes nothing', async () => {
    const size0 = await c.dbsize();
    const r = run(['--phase', 'remove', '--apply', '--ts', 'K2', '--expect-float', String(N_FLOAT), '--expect-hui', '25', '--expect-test', '1']);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('no evidence marker');
    expect(await c.dbsize()).toBe(size0);
  }, 120000);

  it('K3 evidence phase preserves dump.rdb, manifest and digests without secrets', async () => {
    const r = run(['--phase', 'evidence', '--apply', '--ts', 'KE']);
    expect(r.status).toBe(0);
    const ev = join(work, 'chg', 'sec-change-KE', 'redis-keys');
    const files = readdirSync(ev);
    for (const f of ['dump.rdb', 'dump.rdb.sha256', 'key-manifest.tsv', 'target.keys', 'nontarget.keys', 'pre-state.txt', 'redis-info.txt', 'MANIFEST.sha256', 'EVIDENCE_OK']) expect(files).toContain(f);
    const rdbSha = crypto.createHash('sha256').update(readFileSync(join(ev, 'dump.rdb'))).digest('hex');
    expect(readFileSync(join(ev, 'dump.rdb.sha256'), 'utf8')).toContain(rdbSha);
    expect(readFileSync(join(ev, 'target.keys'), 'utf8').trim().split('\n')).toHaveLength(N_FLOAT + 25 + 1);
    expect(readFileSync(join(ev, 'key-manifest.tsv'), 'utf8').trim().split('\n')).toHaveLength(await c.dbsize());
    for (const f of files.filter((x) => x !== 'dump.rdb')) expect(readFileSync(join(ev, f), 'utf8')).not.toContain(PW);
    // (the msys redis-cli.exe ignores REDISCLI_AUTH when launched from bash, so the local rehearsal passes -a through OPS_RCLI)
    // the preserved dump really contains the targets (load it into the scratch instance in K6)
    expect(readFileSync(join(ev, 'dump.rdb')).includes(Buffer.from('float:000000'))).toBe(true);
  }, 180000);

  it('K4 remove refuses on count mismatch and on an unexpected value shape (nothing removed)', async () => {
    const size0 = await c.dbsize();
    const bad = run(['--phase', 'remove', '--apply', '--ts', 'KE', '--expect-float', String(N_FLOAT - 1), '--expect-hui', '25', '--expect-test', '1']);
    expect(bad.status).not.toBe(0); expect(bad.out).toContain('counts differ from approval');
    await c.set('float:000007', 'NOT-A-FLOAT-1337');
    const shape = run(['--phase', 'remove', '--apply', '--ts', 'KE', '--expect-float', String(N_FLOAT), '--expect-hui', '25', '--expect-test', '1']);
    expect(shape.status).not.toBe(0); expect(shape.out).toMatch(/do not match the expected shape/);
    await c.set('float:000007', '1337.0000070500000000' + '7');
    await c.set('test', '2');
    const t = run(['--phase', 'remove', '--apply', '--ts', 'KE', '--expect-float', String(N_FLOAT), '--expect-hui', '25', '--expect-test', '1']);
    expect(t.status).not.toBe(0); expect(t.out).toContain("does not hold the string 1");
    await c.set('test', '1');
    expect(await c.dbsize()).toBe(size0);
  }, 180000);

  let keptBefore: Map<string, string>; let targetsBefore: Map<string, string>;
  it('K5 remove deletes exactly the approved targets; decoys and bull:* are byte-identical', async () => {
    // a still-valid but different value appears after the evidence was taken: the guard must notice, then evidence is re-taken
    await c.set('float:000009', '1337.99');
    const stale = run(['--phase', 'remove', '--apply', '--ts', 'KE', '--expect-float', String(N_FLOAT), '--expect-hui', '25', '--expect-test', '1']);
    expect(stale.status).not.toBe(0); expect(stale.out).toContain('target values changed since the evidence was taken');
    expect(run(['--phase', 'evidence', '--apply', '--ts', 'KF']).status).toBe(0);
    keptBefore = await snapshot(c, (k) => !isTarget(k));
    targetsBefore = await snapshot(c, isTarget);
    const size0 = await c.dbsize();
    const r = run(['--phase', 'remove', '--apply', '--ts', 'KF', '--expect-float', String(N_FLOAT), '--expect-hui', '25', '--expect-test', '1']);
    expect(r.out).toContain(`unlinked=${N_FLOAT + 26}`);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/dbsize \d+ -> \d+ \(exactly -3026\)/);
    expect(await c.dbsize()).toBe(size0 - (N_FLOAT + 26));
    expect((await snapshot(c, isTarget)).size).toBe(0);
    const keptAfter = await snapshot(c, (k) => !isTarget(k));
    expect(keptAfter.size).toBe(keptBefore.size);
    expect([...keptBefore].every(([k, h]) => keptAfter.get(k) === h)).toBe(true);
    for (const decoy of ['float:12345', 'float:abcdef', 'floaty:000001', 'hui:AB', 'hui:1', 'test2', 'app:float:000001', 'bull:float:000001', 'Test']) expect(await c.exists(decoy)).toBe(1);
    expect(run(['--phase', 'verify']).status).toBe(0);
  }, 240000);

  it('K6 recovery: restore from the evidence dump brings targets back byte-identical and never overwrites live keys', async () => {
    const ev = join(work, 'chg', 'sec-change-KF', 'redis-keys');
    const sdir = join(work, 'scratch'); mkdirSync(sdir);
    require_copy(join(ev, 'dump.rdb'), join(sdir, 'dump.rdb'));
    const sport = await freePort();
    scratch = new RedisProc({ port: sport, password: PW, dir: sdir, binary: BIN, extraArgs: PROD_ARGS, save: '' });
    await scratch.start();
    // a live key that already exists again (must be left alone: MIGRATE without REPLACE)
    await c.set('float:000001', 'live-value-created-after-removal');
    const env = { OPS_LIVE_HOST: '127.0.0.1', OPS_LIVE_PORT: String(port), OPS_SCRATCH_RCLI: `${fwd(CLI)} --no-auth-warning -a ${PW}`, OPS_SCRATCH_AUTH: PW };
    const dry = run(['--phase', 'restore', '--ts', 'KF', '--scratch-host', '127.0.0.1', '--scratch-port', String(sport)], env);
    expect(dry.status).toBe(0); expect(dry.out).toContain('DRY-RUN (not executed): MIGRATE');
    expect((await snapshot(c, isTarget)).size).toBe(1);
    const r = run(['--phase', 'restore', '--apply', '--ts', 'KF', '--scratch-host', '127.0.0.1', '--scratch-port', String(sport)], env);
    expect(r.status).toBe(0);
    expect(r.out).toContain('BUSYKEY');
    const after = await snapshot(c, isTarget);
    expect(after.size).toBe(N_FLOAT + 26);
    for (const [k, h] of targetsBefore) if (k !== 'float:000001') expect(after.get(k)).toBe(h);
    expect(await c.get('float:000001')).toBe('live-value-created-after-removal');
    const keptAfter = await snapshot(c, (k) => !isTarget(k));
    expect([...keptBefore].every(([k, h]) => keptAfter.get(k) === h)).toBe(true);
  }, 240000);

  it('K7 static: no flush, no pattern delete, no KEYS, no password on a command line, no volume or rdb removal', () => {
    const code = readFileSync(join(ROOT, 'ops', 'security', '50-redis-suspicious-keys.sh'), 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    expect(code).not.toMatch(/\bFLUSH(ALL|DB)\b/i);
    expect(code).not.toMatch(/\bKEYS\s+\*/i);
    expect(code).not.toMatch(/redis-cli[^\n]*(--scan[^\n]*(del|unlink)|-a\s)/i);
    expect(code).not.toMatch(/docker\s+(volume|system)|rm\s+[^\n]*(dump\.rdb|appendonlydir|redis_data)|--force-recreate|\bdown\b/i);
    expect(code).not.toMatch(/\bDEL\b/);
    // the only place the password is expanded is the 0600 command file used by restore (never argv)
    expect(code.match(/REDISCLI_AUTH/g)?.length).toBeLessThanOrEqual(3);
    expect(code).not.toMatch(/-a\s+"?\$/);
  });
});

import { copyFileSync } from 'node:fs';
function require_copy(a: string, b: string) { copyFileSync(a, b); }
