/**
 * Security guard (incident 2026-10-28): Redis/Postgres must never be published on a public
 * interface, Redis must require a password, and no script may embed a real DB password.
 *
 * Why: Docker-published ports bypass UFW. An unauthenticated public Redis was attacked
 * (SLAVEOF / CONFIG SET / MODULE LOAD / FLUSHALL) and a production Postgres password was found
 * hard-coded in tracked scripts.
 */
import { describe, expect, it } from '@jest/globals';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(process.cwd(), '..');

function composeFiles(): string[] {
  return readdirSync(repoRoot).filter((f) => /^docker-compose.*\.ya?ml$/.test(f));
}

function read(rel: string): string {
  return readFileSync(join(repoRoot, rel), 'utf8');
}

/** `- "5432:5432"`, `- '127.0.0.1:6379:6379'`, `- 5432:5432` */
const PORT_LINE = /^\s*-\s*["']?([0-9.]*:?)(5432|6379):(?:5432|6379)["']?\s*$/;

describe('Redis/Postgres are never published publicly', () => {
  it('finds the compose files', () => {
    expect(composeFiles().length).toBeGreaterThanOrEqual(3);
  });

  it.each(composeFiles())('%s publishes 5432/6379 only on 127.0.0.1', (file) => {
    const offenders: string[] = [];
    read(file)
      .split(/\r?\n/)
      .forEach((line, i) => {
        const m = PORT_LINE.exec(line);
        if (m && m[1] !== '127.0.0.1:') offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    expect(offenders).toEqual([]);
  });
});

describe('Redis requires a password and the backend receives it', () => {
  it.each(['docker-compose.yml', 'docker-compose.deploy.yml'])('%s: redis requirepass + backend url/password', (file) => {
    const text = read(file);
    expect(text).toMatch(/requirepass \$\$REDIS_PASSWORD/);
    expect(text).toMatch(/REDIS_PASSWORD:\?/); // fail closed when missing
    expect(text).toMatch(/REDIS_URL: redis:\/\/:\$\{REDIS_PASSWORD:\?[^}]*\}@redis:6379/);
    expect(text).toMatch(/REDIS_PASSWORD: \$\{REDIS_PASSWORD:\?/);
    expect(text).toMatch(/rename-command SLAVEOF ""/);
    expect(text).toMatch(/rename-command MODULE ""/);
    // password must not be passed on the command line (visible in `ps`)
    expect(text).not.toMatch(/--requirepass/);
    expect(text).toMatch(/user: redis/);
  });

  // Gate 3 (redisResilience.proof.test.ts 3.6a/3.6c): with AOF off, kill -9 loses queued jobs; AOF everysec keeps them.
  // noeviction: Redis must never silently evict queued Bull jobs under memory pressure.
  it.each(['docker-compose.yml', 'docker-compose.deploy.yml'])('%s: queue durability (AOF everysec) and no eviction', (file) => {
    const text = read(file);
    expect(text).toMatch(/echo "appendonly yes"/);
    expect(text).toMatch(/echo "appendfsync everysec"/);
    expect(text).toMatch(/echo "maxmemory-policy noeviction"/);
    expect(text).not.toMatch(/allkeys-lru|volatile-lru/);
  });
});

describe('no script embeds a real database password', () => {
  // postgres(ql)://user:LITERAL@host where LITERAL is >=20 chars and not an interpolation
  const LITERAL_PW_URL = /postgres(?:ql)?:\/\/[A-Za-z0-9_]+:(?!\$\{)([^@\s'"`$:/]{20,})@/;

  function walk(dir: string, out: string[]): void {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === '.git' || name === 'dist') continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(mjs|cjs|js|ts)$/.test(name)) out.push(p);
    }
  }

  it('scripts/ and SamplePOS.Server/scripts/ contain no literal DB password URLs', () => {
    const files: string[] = [];
    walk(join(repoRoot, 'scripts'), files);
    walk(join(repoRoot, 'SamplePOS.Server', 'scripts'), files);
    const offenders = files.filter((f) => LITERAL_PW_URL.test(readFileSync(f, 'utf8')));
    expect(offenders.map((f) => f.replace(repoRoot, ''))).toEqual([]);
  });
});
