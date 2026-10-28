/**
 * Docker-EQUIVALENT startup proof for the Redis service of docker-compose.yml and docker-compose.deploy.yml.
 *
 * Docker is not available on this machine, so the container itself is NOT started (still UNVERIFIED: image pull, `user: redis`
 * against the existing volume's file ownership, alpine redis-cli reading REDISCLI_AUTH, healthcheck). What IS executed:
 *   D1  the exact `command:` shell block from each compose file (parsed from the YAML, `$$` unescaped as compose does) is run under
 *       bash and generates the real redis config; a real Redis 7.4.8 starts from it and behaves as hardened:
 *       NOAUTH without the password, AUTH works, appendonly yes, noeviction, SLAVEOF/REPLICAOF/MODULE/DEBUG disabled,
 *       and the password is not on the redis-server command line
 *   D2  the existing named volumes are NOT renamed, replaced or dropped relative to git HEAD (data volume preservation),
 *       container names and images are unchanged, and Postgres/Redis ports are published on 127.0.0.1 only (or not at all)
 */
import { afterAll, describe, expect, it } from '@jest/globals';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import net from 'node:net';
import { Redis } from 'ioredis';
import YAML from 'yaml';
import { freePort, waitFor } from '../services/redisTestKit.js';

const ROOT = resolve(process.cwd(), '..');
const BASH = [process.env.BASH_BIN, 'C:\\Program Files\\Git\\bin\\bash.exe', '/bin/bash', '/usr/bin/bash'].find((p) => p && existsSync(p));
const BIN = process.env.REDIS_748_BIN || join(tmpdir(), 'redis748', 'x', 'Redis-7.4.8-Windows-x64-msys2', 'redis-server.exe');
const ready = !!BASH && existsSync(BIN);
const suite = ready ? describe : describe.skip;
if (!ready) console.error('[COMPOSE STARTUP SKIPPED] bash or Redis 7.4.8 binary missing: compose command blocks were NOT executed');

const FILES = ['docker-compose.yml', 'docker-compose.deploy.yml'];
const fwd = (p: string) => p.replace(/\\/g, '/');
// msys programs (redis-server.exe launched from bash) read "C:/x" as a RELATIVE path; arguments inside the script use "/c/x"
const msys = (p: string) => fwd(p).replace(/^([A-Za-z]):/, (_m, d: string) => '/' + d.toLowerCase());
const cyg = (p: string) => fwd(p).replace(/^([A-Za-z]):/, (_m, d: string) => '/cygdrive/' + d.toLowerCase());
const load = (f: string) => YAML.parse(readFileSync(join(ROOT, f), 'utf8'));
const loadHead = (f: string) => YAML.parse(spawnSync('git', ['show', `HEAD:${f}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).stdout);
const procs: ChildProcess[] = []; const dirs: string[] = [];
afterAll(() => {
  for (const p of procs) { try { spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ } }
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

suite('docker-compose redis service (Docker-equivalent startup)', () => {
  it.each(FILES)('D1 %s: the compose command block starts a hardened Redis 7.4.8', async (f) => {
    const redis = load(f).services.redis;
    const cmd: string[] = redis.command;
    expect(cmd.slice(0, 2)).toEqual(['sh', '-c']);
    const work = mkdtempSync(join(tmpdir(), 'compose-redis-')); dirs.push(work);
    const data = join(work, 'data'); mkdirSync(data);
    const conf = msys(join(work, 'redis-secure.conf'));
    const port = await freePort();
    const PW = `compose-pw-${Math.random().toString(36).slice(2)}`;
    // compose turns $$ into $; the container path /tmp is mapped to a temp dir and the redis binary/port/dir are supplied
    let script = cmd[2].replace(/\$\$/g, '$').replace(/\/tmp\/redis-secure\.conf/g, conf);
    expect(script).toContain('exec redis-server ');
    // the portable redis-server.exe has its own msys root: it sees drives as /cygdrive/c, git-bash writes them as /c
    script = script.replace(/exec redis-server (\S+)/, `exec "${fwd(BIN)}" ${cyg(join(work, 'redis-secure.conf'))} --port ${port} --bind 127.0.0.1 --dir ${cyg(data)}`);
    const sh = join(work, 'start.sh'); writeFileSync(sh, script);
    const child = spawn(BASH!, [fwd(sh)], { env: { ...process.env, REDIS_PASSWORD: PW, REDISCLI_AUTH: PW }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let childOut = '';
    child.stdout?.on('data', (d) => { childOut += String(d); });
    child.stderr?.on('data', (d) => { childOut += String(d); });
    procs.push(child);
    // raw RESP probe: an unauthenticated client must be refused with -NOAUTH (ioredis would try its own ready-check first)
    const raw = (cmd: string) => new Promise<string>((res) => {
      const s = net.connect({ host: '127.0.0.1', port }); let buf = '';
      const done = (v: string) => { s.destroy(); res(v); };
      s.on('data', (d) => { buf += String(d); if (buf.includes('\r\n')) done(buf); });
      s.on('error', () => done('ERROR'));
      s.setTimeout(2000, () => done('TIMEOUT'));
      s.on('connect', () => s.write(cmd + '\r\n'));
    });
    await waitFor(async () => /NOAUTH|Authentication/.test(await raw('PING')), 20000, `redis from ${f}`, 200).catch((e: Error) => { throw new Error(`${e.message}; child output: ${childOut.slice(0, 600)}`); });
    expect(await raw('GET k')).toMatch(/NOAUTH|Authentication/);
    expect(await raw('CONFIG GET requirepass')).toMatch(/NOAUTH|Authentication/);
    const c = new Redis({ host: '127.0.0.1', port, password: PW, maxRetriesPerRequest: 1, retryStrategy: () => null });
    try {
      expect(await c.ping()).toBe('PONG');
      const cfg = async (k: string) => ((await c.config('GET', k)) as string[])[1];
      expect(await cfg('appendonly')).toBe('yes');
      expect(await cfg('appendfsync')).toBe('everysec');
      expect(await cfg('maxmemory-policy')).toBe('noeviction');
      expect(await cfg('stop-writes-on-bgsave-error')).toBe('no');
      expect(await cfg('protected-mode')).toBe('yes');
      expect(await cfg('requirepass')).toBe(PW);
      for (const dangerous of ['SLAVEOF', 'REPLICAOF', 'MODULE', 'DEBUG']) {
        await expect(c.call(dangerous, ...(dangerous === 'MODULE' ? ['LIST'] : dangerous === 'DEBUG' ? ['SLEEP', '0'] : ['NO', 'ONE']))).rejects.toThrow(/unknown command/i);
      }
      // the password must not be visible in the redis-server command line (only the config path is)
      const ps = spawnSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='redis-server.exe'" | ForEach-Object { $_.CommandLine }`], { encoding: 'utf8' });
      if (ps.status === 0 && ps.stdout.includes('redis-server')) {
        expect(ps.stdout).not.toContain(PW);
        expect(ps.stdout).toContain('redis-secure.conf');
      }
      // the generated file is private (umask 077 in the script) — the config contains the secret, so it must exist only as a file
      expect(readFileSync(join(work, 'redis-secure.conf'), 'utf8')).toContain('requirepass ');
    } finally { c.disconnect(); }
  }, 60000);

  it.each(FILES)('D2 %s: named volumes, container names and images are unchanged vs HEAD; db ports are loopback-only', (f) => {
    const now = load(f); const head = loadHead(f);
    expect(Object.keys(now.volumes ?? {}).sort()).toEqual(Object.keys(head.volumes ?? {}).sort());
    for (const v of Object.keys(head.volumes ?? {})) expect(JSON.stringify(now.volumes[v])).toBe(JSON.stringify(head.volumes[v]));
    for (const [name, svc] of Object.entries<any>(head.services)) {
      const cur = now.services[name];
      expect(cur).toBeDefined();
      expect(cur.container_name).toBe(svc.container_name);
      expect(cur.image).toBe(svc.image);
      const named = (s: any) => (s.volumes ?? []).filter((m: string) => typeof m === 'string' && !/^[./~]/.test(m)).sort();
      expect(named(cur)).toEqual(named(svc));
    }
    for (const name of ['postgres', 'redis']) {
      for (const p of (now.services[name]?.ports ?? []) as string[]) expect(String(p)).toMatch(/^127\.0\.0\.1:/);
    }
  });
});
