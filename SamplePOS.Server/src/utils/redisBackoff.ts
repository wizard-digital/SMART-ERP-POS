/**
 * Reconnect backoff for Redis clients that does NOT trust ioredis' own attempt counter.
 *
 * Why: Bull creates its clients with `enableReadyCheck: false`. ioredis then declares the connection
 * "ready" (resetting retryAttempts to 0) BEFORE the server has rejected AUTH. A rejected password
 * (e.g. REDIS_PASSWORD stale after rotation) therefore reconnects with `retryStrategy(1)` every time —
 * Bull's default `exp(1)` ≈ 3 ms — i.e. ~60 reconnects/second per client (measured: ~500/s for 8 queues).
 *
 * This strategy keeps its own consecutive-failure count and only resets it after a connection
 * has genuinely stayed up for `stableMs`. Delay = min(maxMs, baseMs * 2^n) with ±jitter so clients do
 * not reconnect in lock-step after an outage (thundering herd).
 */
export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  /** a connection that survived at least this long counts as healthy and resets the counter */
  stableMs?: number;
  /** 0..1 fraction of the delay randomised, e.g. 0.2 => ±20% */
  jitter?: number;
  now?: () => number;
  random?: () => number;
}

export function createRedisBackoff(opts: BackoffOptions = {}): (times: number) => number {
  const { baseMs = 100, maxMs = 5000, stableMs = 10_000, jitter = 0.2, now = Date.now, random = Math.random } = opts;
  let failures = 0;
  let lastCallAt = 0;
  let lastDelay = 0;
  return () => {
    const t = now();
    if (lastCallAt !== 0) {
      const connectionLifetime = t - lastCallAt - lastDelay; // time the last connection stayed up
      if (connectionLifetime >= stableMs) failures = 0;
    }
    const raw = Math.min(maxMs, baseMs * 2 ** Math.min(failures, 20));
    failures++;
    const spread = raw * jitter;
    const delay = Math.max(1, Math.round(raw - spread + random() * 2 * spread));
    lastCallAt = t;
    lastDelay = delay;
    return delay;
  };
}
