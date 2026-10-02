/**
 * Behavioral proof: a restaurant table lock is taken and released on the
 * same connection, and two tables lock in a stable order.
 */
import type { Pool } from 'pg';
import {
  restaurantTableLockKey,
  sortLockKeys,
  withRestaurantTableLocks,
} from './restaurantTableLock.js';

type LogRow = { clientId: number; sql: string; params?: unknown[]; destroyed: boolean };

function fakePool(opts?: { lockCode?: string }) {
  const log: LogRow[] = [];
  let nextId = 1;
  const pool = {
    async connect() {
      const id = nextId++;
      let destroyed = false;
      const client = {
        async query(sql: string, params?: unknown[]) {
          log.push({ clientId: id, sql, params, destroyed });
          if (opts?.lockCode && sql.includes('pg_advisory_lock(')) {
            const err = new Error('lock timeout') as Error & { code: string };
            err.code = opts.lockCode;
            throw err;
          }
          return { rows: [], rowCount: 1 };
        },
        release(err?: Error) {
          destroyed = Boolean(err);
          log.push({ clientId: id, sql: destroyed ? 'DESTROY' : 'RELEASE', destroyed });
        },
      };
      return client;
    },
  };
  return { pool: pool as unknown as Pool, log };
}

describe('restaurant table lock — one connection', () => {
  it('sorts keys so opposite transfers cannot deadlock', () => {
    expect(sortLockKeys(['restaurant_table_b', 'restaurant_table_a', 'restaurant_table_a'])).toEqual([
      'restaurant_table_a',
      'restaurant_table_b',
    ]);
    expect(restaurantTableLockKey('t1')).toBe('restaurant_table_t1');
  });

  it('locks and unlocks on the same client, then returns it to the pool', async () => {
    const { pool, log } = fakePool();
    const value = await withRestaurantTableLocks(pool, ['restaurant_table_b', 'restaurant_table_a'], async () => {
      return 'ok';
    });
    expect(value).toBe('ok');
    const clientIds = new Set(log.map((row) => row.clientId));
    expect(clientIds.size).toBe(1);
    const lock = log.find((row) => row.sql.includes('pg_advisory_lock('));
    const unlock = log.find((row) => row.sql.includes('pg_advisory_unlock('));
    expect(lock?.params).toEqual(['restaurant_table_a', 'restaurant_table_b']);
    expect(unlock?.params).toEqual(['restaurant_table_a', 'restaurant_table_b']);
    expect(lock?.clientId).toBe(unlock?.clientId);
    expect(log.at(-1)?.sql).toBe('RELEASE');
    expect(log.some((row) => row.sql.includes("set_config('lock_timeout', '0'"))).toBe(true);
  });

  it('returns a conflict when the other terminal still holds the table', async () => {
    const { pool, log } = fakePool({ lockCode: '55P03' });
    await expect(
      withRestaurantTableLocks(pool, ['restaurant_table_t1'], async () => 'nope'),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(log.some((row) => row.sql.includes('pg_advisory_unlock('))).toBe(false);
    expect(log.at(-1)?.sql).toBe('RELEASE');
  });

  it('does not block a different table', async () => {
    const { pool, log } = fakePool();
    await Promise.all([
      withRestaurantTableLocks(pool, ['restaurant_table_1'], async () => 1),
      withRestaurantTableLocks(pool, ['restaurant_table_2'], async () => 2),
    ]);
    const ids = new Set(log.map((row) => row.clientId));
    expect(ids.size).toBe(2);
  });
});
