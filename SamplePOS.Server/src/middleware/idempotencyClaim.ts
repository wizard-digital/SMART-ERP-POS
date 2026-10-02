/**
 * One idempotency key runs the mutation once.
 *
 * A check-then-insert lets two terminals both pass the lookup and both
 * commit. The key is claimed first. The loser waits for the stored response
 * and replays it. A failed attempt releases the claim so a retry can proceed.
 */
import type { Pool } from 'pg';

export const IDEMPOTENCY_WAIT_MS = 8_000;

export type CompletedIdempotency = {
  statusCode: number;
  body: unknown;
};

export interface IdempotencyStore {
  readCompleted(key: string): Promise<CompletedIdempotency | null>;
  /** Returns true when this caller owns the key. */
  claim(key: string, userId: string | null, method: string, path: string): Promise<boolean>;
  complete(key: string, statusCode: number, body: unknown): Promise<void>;
  release(key: string): Promise<void>;
}

export type IdempotentResult = {
  statusCode: number;
  body: unknown;
  executed: boolean;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitForCompleted(
  store: IdempotencyStore,
  key: string,
  waitMs = IDEMPOTENCY_WAIT_MS,
  pause: (ms: number) => Promise<void> = sleep,
): Promise<CompletedIdempotency | null> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const done = await store.readCompleted(key);
    if (done) return done;
    await pause(50);
  }
  return store.readCompleted(key);
}

/**
 * Run `exec` once per key. A second caller receives the first result and
 * does not call `exec`.
 */
export async function runIdempotent(
  store: IdempotencyStore,
  input: { key: string; userId: string | null; method: string; path: string },
  exec: () => Promise<{ statusCode: number; body: unknown }>,
  waitMs = IDEMPOTENCY_WAIT_MS,
): Promise<IdempotentResult> {
  const existing = await store.readCompleted(input.key);
  if (existing) {
    return { statusCode: existing.statusCode, body: existing.body, executed: false };
  }

  const owned = await store.claim(input.key, input.userId, input.method, input.path);
  if (!owned) {
    const replay = await waitForCompleted(store, input.key, waitMs);
    if (!replay) {
      const err = new Error('Duplicate request is still in progress');
      (err as Error & { statusCode: number }).statusCode = 409;
      throw err;
    }
    return { statusCode: replay.statusCode, body: replay.body, executed: false };
  }

  try {
    const result = await exec();
    if (result.statusCode >= 200 && result.statusCode < 300) {
      await store.complete(input.key, result.statusCode, result.body);
    } else {
      await store.release(input.key);
    }
    return { ...result, executed: true };
  } catch (err) {
    await store.release(input.key).catch(() => undefined);
    throw err;
  }
}

export function createPgIdempotencyStore(pool: Pool): IdempotencyStore {
  return {
    async readCompleted(key) {
      const existing = await pool.query<{ status_code: number; response_body: unknown }>(
        `SELECT status_code, response_body
         FROM idempotency_keys
         WHERE key = $1
           AND expires_at > NOW()
           AND status_code IS NOT NULL`,
        [key],
      );
      const row = existing.rows[0];
      if (!row) return null;
      return { statusCode: row.status_code, body: row.response_body };
    },
    async claim(key, userId, method, path) {
      await pool.query(
        `DELETE FROM idempotency_keys
         WHERE key = $1
           AND status_code IS NULL
           AND created_at < NOW() - INTERVAL '30 seconds'`,
        [key],
      );
      const claimed = await pool.query(
        `INSERT INTO idempotency_keys (key, user_id, method, path)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (key) DO NOTHING
         RETURNING id`,
        [key, userId, method, path],
      );
      return (claimed.rowCount ?? 0) > 0;
    },
    async complete(key, statusCode, body) {
      await pool.query(
        `UPDATE idempotency_keys
         SET status_code = $2, response_body = $3::jsonb
         WHERE key = $1 AND status_code IS NULL`,
        [key, statusCode, JSON.stringify(body)],
      );
    },
    async release(key) {
      await pool.query(
        `DELETE FROM idempotency_keys WHERE key = $1 AND status_code IS NULL`,
        [key],
      );
    },
  };
}
