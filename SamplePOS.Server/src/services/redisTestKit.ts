/**
 * Test kit for REAL Redis failure scenarios (no mocks).
 *  - RedisProc: spawns a real redis-server (hard kill == kill -9, graceful == SHUTDOWN)
 *  - ChaosProxy: TCP proxy in front of Redis that can pass / refuse (accept+drop) / blackhole traffic
 *    and counts connection attempts — this is how reconnect storms are measured.
 *
 * Binary: REDIS_SERVER_BIN, else %TEMP%/gates-redis/x/Redis-8.10.3-Windows-x64-msys2/redis-server.exe
 * (portable build, SHA-256 verified at download; see PROOF_GATES_REPORT.md). When absent, suites skip LOUDLY.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { Redis } from 'ioredis';

export const REDIS_BIN =
  process.env.REDIS_SERVER_BIN ||
  join(tmpdir(), 'gates-redis', 'x', 'Redis-8.10.3-Windows-x64-msys2', 'redis-server.exe');
export const redisAvailable = existsSync(REDIS_BIN);

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs: number, label = 'condition', stepMs = 50): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout (${timeoutMs}ms) waiting for ${label}`);
    await sleep(stepMs);
  }
}

export interface RedisOpts {
  port: number;
  password: string;
  dir?: string;
  appendonly?: boolean;
  /** RDB save points, e.g. '3600 1 300 100 60 10000' (production) or '' to disable */
  save?: string;
  /** extra redis-server args, e.g. ['--rename-command','DEBUG',''] (used to mirror the production config) */
  extraArgs?: string[];
  /** override binary (rehearsals pin Redis 7.4.8 == production) */
  binary?: string;
}

export class RedisProc {
  child: ChildProcess | null = null;
  readonly dir: string;
  constructor(readonly opts: RedisOpts) {
    this.dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'redis-proof-'));
    mkdirSync(this.dir, { recursive: true });
  }

  async start(): Promise<void> {
    const o = this.opts;
    const args = [
      '--port', String(o.port), '--bind', '127.0.0.1', '--protected-mode', 'yes',
      '--requirepass', o.password, '--dir', this.dir.replace(/\\/g, '/'),
      '--appendonly', o.appendonly ? 'yes' : 'no', '--appendfsync', 'everysec',
      '--save', o.save ?? '3600 1 300 100 60 10000',
      '--maxmemory-policy', 'noeviction', '--stop-writes-on-bgsave-error', 'no',
      ...(o.extraArgs ?? []),
    ];
    this.child = spawn(o.binary ?? REDIS_BIN, args, { stdio: 'ignore', windowsHide: true });
    await waitFor(async () => {
      try { const c = this.admin(); await c.ping(); await c.quit(); return true; } catch { return false; }
    }, 15000, `redis on :${o.port}`, 100);
  }

  /** hard kill — equivalent to kill -9 / OOM-kill / power loss (no SAVE, no AOF flush) */
  get isDead(): boolean {
    // a process killed by a signal has exitCode === null but signalCode set
    return !this.child || this.child.exitCode !== null || this.child.signalCode !== null;
  }

  kill(): Promise<void> {
    return new Promise((resolve) => {
      const c = this.child;
      if (!c || this.isDead) return resolve();
      const guard = setTimeout(resolve, 8000);
      c.once('exit', () => { clearTimeout(guard); resolve(); });
      c.kill('SIGKILL');
    });
  }

  /** graceful stop — what `docker stop` (SIGTERM) does: SHUTDOWN with save points => RDB written */
  async stopGraceful(): Promise<void> {
    const c = this.admin();
    await c.shutdown('SAVE').catch(() => undefined);
    c.disconnect();
    await waitFor(() => this.isDead, 10000, 'redis exit');
  }

  admin(): Redis {
    return new Redis({ host: '127.0.0.1', port: this.opts.port, password: this.opts.password, maxRetriesPerRequest: 1, lazyConnect: false, retryStrategy: () => null });
  }
}

export type ProxyMode = 'pass' | 'refuse' | 'blackhole';

export class ChaosProxy {
  private server: net.Server | null = null;
  private sockets = new Set<net.Socket>();
  mode: ProxyMode = 'pass';
  /** connection attempts that reached the proxy (the reconnect-storm meter) */
  attempts = 0;
  constructor(readonly listenPort: number, public targetPort: number) {}

  async start(): Promise<void> {
    this.server = net.createServer((client) => {
      this.attempts++;
      this.sockets.add(client);
      client.on('close', () => this.sockets.delete(client));
      client.on('error', () => undefined);
      if (this.mode === 'refuse') return void client.destroy();
      if (this.mode === 'blackhole') return; // accept, never answer
      const up = net.connect({ host: '127.0.0.1', port: this.targetPort });
      this.sockets.add(up);
      up.on('close', () => { this.sockets.delete(up); client.destroy(); });
      up.on('error', () => client.destroy());
      client.on('close', () => up.destroy());
      client.pipe(up); up.pipe(client);
    });
    await new Promise<void>((r) => this.server!.listen(this.listenPort, '127.0.0.1', r));
  }

  /** abruptly drop every live connection (network interruption), then apply mode for new ones */
  interrupt(mode: ProxyMode): void {
    this.mode = mode;
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
  }
  heal(): void { this.mode = 'pass'; }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }
}
