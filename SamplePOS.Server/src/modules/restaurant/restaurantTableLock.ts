/**
 * Table lock for multi-terminal restaurant writes.
 *
 * Session advisory locks are per connection. pool.query() checks out a
 * connection, runs one statement, and returns it — so a lock and its unlock
 * land on different sessions and the lock stays held. Every later write to
 * that table waits until the browser gives up.
 *
 * This holds one client for the lock, the critical section, and the unlock.
 * Two keys are taken in sorted order so transfers in opposite directions
 * cannot deadlock. If the table stays busy past the timeout, the caller gets
 * a conflict it can retry. The connection's lock_timeout is reset before it
 * goes back to the pool.
 */
import type { Pool } from 'pg';
import { ConflictError } from '../../middleware/errorHandler.js';

export const TABLE_LOCK_TIMEOUT_MS = 8_000;

export function restaurantTableLockKey(tableId: string): string {
  return `restaurant_table_${tableId}`;
}

export function sortLockKeys(keys: string[]): string[] {
  return [...new Set(keys)].sort();
}

function isLockTimeout(err: unknown): boolean {
  const code = (err as { code?: string }).code;
  return code === '55P03' || code === '57014';
}

export async function withRestaurantTableLocks<T>(
  pool: Pool,
  keys: string[],
  fn: () => Promise<T>,
): Promise<T> {
  const ordered = sortLockKeys(keys);
  if (ordered.length === 0) return fn();

  const client = await pool.connect();
  let locked = false;
  let timeoutSet = false;
  try {
    await client.query(`SELECT set_config('lock_timeout', $1, false)`, [`${TABLE_LOCK_TIMEOUT_MS}ms`]);
    timeoutSet = true;
    const lockSql = `SELECT ${ordered.map((_, i) => `pg_advisory_lock(hashtext($${i + 1}))`).join(', ')}`;
    try {
      await client.query(lockSql, ordered);
      locked = true;
    } catch (err) {
      if (isLockTimeout(err)) {
        throw new ConflictError(
          'This table is busy on another terminal. Wait a moment and try again.',
        );
      }
      throw err;
    }
    return await fn();
  } finally {
    let unlockFailed: Error | undefined;
    if (locked) {
      const unlockSql = `SELECT ${ordered.map((_, i) => `pg_advisory_unlock(hashtext($${i + 1}))`).join(', ')}`;
      try {
        await client.query(unlockSql, ordered);
      } catch (err) {
        unlockFailed = err instanceof Error ? err : new Error(String(err));
      }
    }
    if (timeoutSet && !unlockFailed) {
      try {
        await client.query(`SELECT set_config('lock_timeout', '0', false)`);
      } catch (err) {
        unlockFailed = err instanceof Error ? err : new Error(String(err));
      }
    }
    client.release(unlockFailed);
  }
}
