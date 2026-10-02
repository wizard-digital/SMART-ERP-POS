/**
 * In-memory proof: two callers, one execution, identical result.
 * Postgres proof runs when DATABASE_URL is local.
 */
import { describe, it, expect } from '@jest/globals';
import dotenv from 'dotenv';
import pg from 'pg';
dotenv.config({ path: '.env.test' });

import {
  createPgIdempotencyStore,
  runIdempotent,
  type IdempotencyStore,
} from './idempotencyClaim.js';

class MemoryStore implements IdempotencyStore {
  private rows = new Map<string, { statusCode: number | null; body: unknown }>();

  async readCompleted(key: string) {
    const row = this.rows.get(key);
    if (!row || row.statusCode == null) return null;
    return { statusCode: row.statusCode, body: row.body };
  }

  async claim(key: string) {
    if (this.rows.has(key)) return false;
    this.rows.set(key, { statusCode: null, body: null });
    return true;
  }

  async complete(key: string, statusCode: number, body: unknown) {
    this.rows.set(key, { statusCode, body });
  }

  async release(key: string) {
    const row = this.rows.get(key);
    if (row && row.statusCode == null) this.rows.delete(key);
  }
}

function localDatabaseUrl(): string | null {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  try {
    const host = new URL(url).hostname;
    if (host === 'localhost' || host === '127.0.0.1') return url;
  } catch {
    return null;
  }
  return null;
}

describe('idempotency claim — one execution', () => {
  it('two simultaneous callers execute once and share the response', async () => {
    const store = new MemoryStore();
    let runs = 0;
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });

    const call = () =>
      runIdempotent(
        store,
        { key: 'pay-1', userId: 'u1', method: 'POST', path: '/orders/1/complete' },
        async () => {
          runs += 1;
          await hold;
          return { statusCode: 201, body: { saleNumber: 'SALE-1' } };
        },
        2_000,
      );

    const first = call();
    await Promise.resolve();
    const second = call();
    release();
    const [a, b] = await Promise.all([first, second]);

    expect(runs).toBe(1);
    expect(a.executed).toBe(true);
    expect(b.executed).toBe(false);
    expect(a.body).toEqual({ saleNumber: 'SALE-1' });
    expect(b.body).toEqual({ saleNumber: 'SALE-1' });
    expect(b.statusCode).toBe(201);
  });

  it('a failed attempt releases the key so the retry runs', async () => {
    const store = new MemoryStore();
    let runs = 0;
    await expect(
      runIdempotent(store, { key: 'pay-2', userId: null, method: 'POST', path: '/x' }, async () => {
        runs += 1;
        throw new Error('stock');
      }),
    ).rejects.toThrow('stock');

    const retry = await runIdempotent(
      store,
      { key: 'pay-2', userId: null, method: 'POST', path: '/x' },
      async () => {
        runs += 1;
        return { statusCode: 200, body: { ok: true } };
      },
    );
    expect(runs).toBe(2);
    expect(retry.executed).toBe(true);
    expect(retry.body).toEqual({ ok: true });
  });
});

describe('idempotency claim — local database', () => {
  it('two connections claim one key and replay one sale body', async () => {
    const url = localDatabaseUrl();
    if (!url) return;
    const pool = new pg.Pool({ connectionString: url });
    const key = `proof_claim_${Date.now()}`;
    let runs = 0;
    try {
      const store = createPgIdempotencyStore(pool);
      const call = () =>
        runIdempotent(store, { key, userId: null, method: 'POST', path: '/proof' }, async () => {
          runs += 1;
          await new Promise((resolve) => setTimeout(resolve, 80));
          return { statusCode: 200, body: { saleNumber: 'SALE-PROOF', runs } };
        });
      const [a, b] = await Promise.all([call(), call()]);
      expect(runs).toBe(1);
      const executed = [a, b].filter((row) => row.executed);
      expect(executed).toHaveLength(1);
      expect(a.body).toEqual(b.body);
      expect(a.body).toEqual({ saleNumber: 'SALE-PROOF', runs: 1 });

      const again = await call();
      expect(again.executed).toBe(false);
      expect(again.body).toEqual(a.body);
      expect(runs).toBe(1);
    } finally {
      await pool.query(`DELETE FROM idempotency_keys WHERE key = $1`, [key]);
      await pool.end();
    }
  });

  it('two sales for one order cannot both commit', async () => {
    const url = localDatabaseUrl();
    if (!url) return;
    const pool = new pg.Pool({ connectionString: url });
    const stamp = Date.now();
    try {
      const dupes = await pool.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM (
           SELECT from_order_id
           FROM sales
           WHERE from_order_id IS NOT NULL
           GROUP BY from_order_id
           HAVING COUNT(*) > 1
         ) d`,
      );
      expect(dupes.rows[0].c).toBe(0);

      await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_one_settlement_per_order
        ON sales (from_order_id)
        WHERE from_order_id IS NOT NULL
      `);

      const user = await pool.query<{ id: string }>(
        `SELECT id FROM users WHERE is_active = true LIMIT 1`,
      );
      const userId = user.rows[0]?.id;
      expect(userId).toBeTruthy();

      const order = await pool.query<{ id: string }>(
        `INSERT INTO pos_orders (
           order_number, status, subtotal, discount_amount, tax_amount, total_amount,
           created_by, order_date
         ) VALUES ($1, 'PENDING', 10, 0, 0, 10, $2, CURRENT_DATE)
         RETURNING id`,
        [`ORD-PROOF-${stamp}`, userId],
      );
      const orderId = order.rows[0].id;

      const insertSale = (tag: string) =>
        pool.query(
          `INSERT INTO sales (
             sale_number, sale_date, subtotal, tax_amount, discount_amount, total_amount,
             total_cost, profit, profit_margin, payment_method, amount_paid, change_amount,
             cashier_id, idempotency_key, from_order_id, status, print_count
           ) VALUES (
             $1, CURRENT_DATE, 10, 0, 0, 10, 0, 10, 1, 'CASH', 10, 0, $2, $3, $4, 'COMPLETED', 0
           )`,
          [`SALE-PROOF-${stamp}-${tag}`, userId, `proof_ord_${stamp}_${tag}`, orderId],
        );

      const outcomes = await Promise.all(
        ['a', 'b'].map(async (tag) => {
          try {
            await insertSale(tag);
            return 'inserted';
          } catch (err) {
            const code = (err as { code?: string }).code;
            return code === '23505' ? 'duplicate' : `error:${code ?? 'unknown'}`;
          }
        }),
      );

      expect(outcomes.filter((row) => row === 'inserted')).toHaveLength(1);
      expect(outcomes.filter((row) => row === 'duplicate')).toHaveLength(1);
      const count = await pool.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM sales WHERE from_order_id = $1`,
        [orderId],
      );
      expect(count.rows[0].c).toBe(1);

      await pool.query(`DELETE FROM sales WHERE from_order_id = $1`, [orderId]);
      await pool.query(`DELETE FROM pos_orders WHERE id = $1`, [orderId]);
    } finally {
      await pool.end();
    }
  });
});
