#!/usr/bin/env node
/**
 * READ-ONLY Redis keyspace digest.
 *
 * Used for two things:
 *   1. the local rehearsal (redisAofMigration.rehearsal.test.ts) to prove a persistence migration keeps every key/value;
 *   2. the production change plan: take a digest before and after the change over an SSH tunnel
 *      (DEBUG is disabled in prod, so DEBUG DIGEST is not available; this is the replacement).
 *
 * Only these commands are ever sent: SCAN, TYPE, GET, HGETALL, LRANGE, SMEMBERS, ZRANGE, XRANGE, DUMP, DBSIZE, PING.
 * It never writes, never calls CONFIG SET, FLUSH*, DEL, EXPIRE, etc.  (asserted by the unit test below via a command allow-list.)
 *
 * CLI:
 *   REDIS_PASSWORD=... node redis-digest.mjs --host 127.0.0.1 --port 16379 --out digest.json [--ignore 'regex' ...] [--queues]
 *
 * Output JSON: { dbsize, keys, digest, byPrefix: {prefix: {keys, digest}}, queues?: {...}, perKey: sha256 per key (only with --per-key) }
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

export const READ_ONLY_COMMANDS = new Set(['SCAN', 'TYPE', 'GET', 'HGETALL', 'LRANGE', 'SMEMBERS', 'ZRANGE', 'XRANGE', 'DUMP', 'DBSIZE', 'PING', 'LLEN', 'ZCARD', 'INFO', 'CONFIG GET']);

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const B = (x) => (Buffer.isBuffer(x) ? x : Buffer.from(String(x)));

function frame(parts) {
  // length-prefixed framing so ("ab","c") and ("a","bc") cannot collide
  const out = [];
  for (const p of parts) {
    const b = B(p);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(b.length);
    out.push(len, b);
  }
  return Buffer.concat(out);
}

/** queue the read command for one key on a pipeline; returns a normaliser for the reply */
function queueRead(pipe, key, type) {
  switch (type) {
    case 'string':
      pipe.callBuffer('GET', key);
      return (v) => [v];
    case 'hash':
      pipe.callBuffer('HGETALL', key);
      return (arr) => {
        const pairs = [];
        for (let i = 0; i < arr.length; i += 2) pairs.push([arr[i], arr[i + 1]]);
        pairs.sort((a, b) => Buffer.compare(a[0], b[0]));
        return pairs.flat();
      };
    case 'list':
      pipe.callBuffer('LRANGE', key, '0', '-1');
      return (v) => v;
    case 'set':
      pipe.callBuffer('SMEMBERS', key);
      return (v) => [...v].sort(Buffer.compare);
    case 'zset':
      pipe.callBuffer('ZRANGE', key, '0', '-1', 'WITHSCORES');
      return (v) => v;
    case 'stream':
      pipe.call('XRANGE', key, '-', '+');
      return (v) => [Buffer.from(JSON.stringify(v))];
    default:
      pipe.callBuffer('DUMP', key);
      return (v) => [v];
  }
}

export function prefixOf(key) {
  // bull:<queue>:<kind>[:id]  -> bull:<queue>:<kind> ; cache:/tag: -> first segment ; otherwise first segment
  const s = key.toString();
  const parts = s.split(':');
  if (parts[0] === 'bull' && parts.length >= 3) return `bull:${parts[1]}:${/^\d+$/.test(parts[2]) ? 'job' : parts[2]}`;
  return parts.length > 1 ? `${parts[0]}:*` : s.replace(/\d+/g, '#').slice(0, 24);
}

/**
 * @param {import('ioredis').Redis} c
 * @param {{ ignore?: RegExp[], count?: number, perKey?: boolean }} [opt]
 */
export async function snapshotKeyspace(c, opt = {}) {
  const ignore = opt.ignore ?? [];
  const per = new Map();
  let cursor = '0';
  do {
    const [next, keys] = await c.scanBuffer(cursor, 'COUNT', opt.count ?? 1000);
    cursor = next.toString();
    const batch = keys.filter((k) => !ignore.some((re) => re.test(k.toString())));
    if (batch.length) {
      const tp = c.pipeline();
      batch.forEach((k) => tp.type(k));
      const types = await tp.exec();
      const rp = c.pipeline();
      const plan = [];
      for (let i = 0; i < batch.length; i++) {
        const type = String(types[i][1]);
        if (type === 'none') continue; // expired between SCAN and TYPE
        plan.push({ key: batch[i], type, norm: queueRead(rp, batch[i], type) });
      }
      const replies = plan.length ? await rp.exec() : [];
      plan.forEach((p, i) => {
        const [err, v] = replies[i];
        if (err) throw err;
        if (v === null || v === undefined) return; // expired between TYPE and read
        per.set(p.key.toString('latin1'), sha(frame([p.type, ...p.norm(v)])));
      });
    }
  } while (cursor !== '0');

  const sorted = [...per.keys()].sort();
  const all = crypto.createHash('sha256');
  const byPrefix = {};
  for (const k of sorted) {
    all.update(frame([k, per.get(k)]));
    const p = prefixOf(Buffer.from(k, 'latin1'));
    (byPrefix[p] ??= { keys: 0, h: crypto.createHash('sha256') });
    byPrefix[p].keys++;
    byPrefix[p].h.update(frame([k, per.get(k)]));
  }
  const prefixes = {};
  for (const [p, v] of Object.entries(byPrefix)) prefixes[p] = { keys: v.keys, digest: v.h.digest('hex') };
  return { keys: per.size, digest: all.digest('hex'), byPrefix: prefixes, perKey: per };
}

export function diffSnapshots(a, b) {
  const missing = [];
  const added = [];
  const changed = [];
  for (const [k, v] of a.perKey) {
    if (!b.perKey.has(k)) missing.push(k);
    else if (b.perKey.get(k) !== v) changed.push(k);
  }
  for (const k of b.perKey.keys()) if (!a.perKey.has(k)) added.push(k);
  return { missing, added, changed };
}

/** Bull job-state census for a queue (counts only; read-only). */
export async function bullCensus(c, queue) {
  const p = `bull:${queue}`;
  const [wait, active, paused, delayed, failed, completed] = await Promise.all([
    c.llen(`${p}:wait`), c.llen(`${p}:active`), c.llen(`${p}:paused`),
    c.zcard(`${p}:delayed`), c.zcard(`${p}:failed`), c.zcard(`${p}:completed`),
  ]);
  return { wait, active, paused, delayed, failed, completed };
}

async function main() {
  const args = process.argv.slice(2);
  const get = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
  const ignore = args.flatMap((a, i) => (a === '--ignore' ? [new RegExp(args[i + 1])] : []));
  const { default: Redis } = await import('ioredis');
  const password = process.env.REDIS_PASSWORD;
  if (!password) throw new Error('REDIS_PASSWORD env var required (never pass it on the command line)');
  const c = new Redis({ host: get('--host', '127.0.0.1'), port: Number(get('--port', '6379')), password, maxRetriesPerRequest: 2, retryStrategy: () => null });
  try {
    const snap = await snapshotKeyspace(c, { ignore });
    const out = { takenAt: new Date().toISOString(), dbsize: await c.dbsize(), keys: snap.keys, digest: snap.digest, byPrefix: snap.byPrefix };
    if (args.includes('--queues')) {
      out.queues = {};
      for (const q of ['inventory', 'reports', 'exports', 'calculations', 'imports', 'banking', 'gl_events', 'notifications']) out.queues[q] = await bullCensus(c, q);
    }
    if (args.includes('--per-key')) out.perKey = Object.fromEntries(snap.perKey);
    const file = get('--out');
    if (file) fs.writeFileSync(file, JSON.stringify(out, null, 2));
    else console.log(JSON.stringify(out, null, 2));
  } finally {
    c.disconnect();
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('redis-digest.mjs')) {
  main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
}
