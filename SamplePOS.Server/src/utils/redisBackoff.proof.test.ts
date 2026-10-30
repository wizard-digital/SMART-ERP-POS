import { describe, expect, it } from '@jest/globals';
import { createRedisBackoff } from './redisBackoff.js';
import { createThrottle, errorKey } from './throttledLog.js';

describe('createRedisBackoff', () => {
  it('grows exponentially to the cap even when ioredis resets its counter (times is always 1)', () => {
    let t = 1000;
    const b = createRedisBackoff({ jitter: 0, now: () => t, baseMs: 100, maxMs: 5000 });
    const delays: number[] = [];
    for (let i = 0; i < 9; i++) { const d = b(1); delays.push(d); t += d + 3; } // connection lives 3 ms (AUTH rejected)
    expect(delays).toEqual([100, 200, 400, 800, 1600, 3200, 5000, 5000, 5000]);
  });

  it('bounds the reconnect rate for a rejected password to < 1/s after the first seconds', () => {
    let t = 0; const b = createRedisBackoff({ jitter: 0, now: () => t });
    let attempts = 0;
    while (t < 60_000) { t += b(1) + 3; attempts++; }
    expect(attempts).toBeLessThan(25); // was ~3,500 per client-minute with Bull's exp(1) = 3 ms
  });

  it('resets after a connection genuinely stayed up (stableMs)', () => {
    let t = 0; const b = createRedisBackoff({ jitter: 0, now: () => t, stableMs: 10_000 });
    for (let i = 0; i < 6; i++) { t += b(1) + 3; }
    const grown = b(1);                 // 6 failures in => 3200ms
    t += grown + 60_000;                // then the connection stays healthy for a minute and drops
    expect(b(1)).toBe(100);             // back to base
    expect(grown).toBeGreaterThan(1000);
  });

  it('jitters within ±20% so clients do not reconnect in lock-step', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 50; i++) { const b = createRedisBackoff({ jitter: 0.2 }); b(1); seen.add(b(1)); } // 2nd delay: nominal 200
    for (const d of seen) { expect(d).toBeGreaterThanOrEqual(160); expect(d).toBeLessThanOrEqual(240); }
    expect(seen.size).toBeGreaterThan(5);
  });
});

describe('createThrottle / errorKey', () => {
  it('logs the first occurrence, suppresses repeats, then reports the suppressed count', () => {
    let t = 0; const th = createThrottle(30_000, () => t); const out: number[] = [];
    for (let i = 0; i < 100; i++) { th('k', (s) => out.push(s)); t += 100; } // 10 s of repeats
    expect(out).toEqual([0]);
    t = 31_000; th('k', (s) => out.push(s));
    expect(out).toEqual([0, 99]);
  });
  it('does not hide a DIFFERENT error behind an earlier one', () => {
    const th = createThrottle(30_000, () => 0); const out: string[] = [];
    th(errorKey('q', new Error('connect ECONNREFUSED 127.0.0.1:6379')), () => out.push('a'));
    th(errorKey('q', new Error('WRONGPASS invalid username-password pair')), () => out.push('b'));
    th(errorKey('q', new Error('connect ECONNREFUSED 127.0.0.1:6379')), () => out.push('a2'));
    expect(out).toEqual(['a', 'b']);
  });
});
