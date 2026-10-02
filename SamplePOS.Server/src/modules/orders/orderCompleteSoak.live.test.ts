/**
 * P1 live soak — order complete integrity primitives.
 *
 * Structural always. Live races when ORDER_COMPLETE_SOAK=1 + DATABASE_URL.
 * Prefer: npm run proof:order-complete-soak (writes metrics report).
 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import dotenv from 'dotenv';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  findSaleByIdempotencyKey,
  isIdempotencyUniqueViolation,
  resolveExistingCompleteSale,
} from './orderCompleteIdempotency.js';

dotenv.config({ path: '.env.test' });

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const databaseHost = (() => {
  try {
    return new URL(process.env.DATABASE_URL ?? '').hostname;
  } catch {
    return '';
  }
})();
const RUN_LIVE =
  process.env.ORDER_COMPLETE_SOAK === '1' &&
  (databaseHost === 'localhost' || databaseHost === '127.0.0.1');

function src(rel: string): string {
  return readFileSync(resolve(serverRoot, rel), 'utf8');
}

describe('order complete soak (structural)', () => {
  it('complete path requires idempotencyKey and handles unique violation', () => {
    const routes = src('src/modules/orders/ordersRoutes.ts');
    expect(routes).toContain('idempotencyKey: z.string().min(1).max(100)');
    expect(routes).toContain('isIdempotencyUniqueViolation');
    expect(routes).toContain('alreadyCompleted: true');
  });

  it('createSale serializes order settlement with FOR UPDATE', () => {
    const sales = src('src/modules/sales/salesService.ts');
    expect(sales).toContain('FOR UPDATE');
    expect(sales).toContain('rowCount === 0');
  });

  it('soak runner script exists', () => {
    const script = src('scripts/proof-order-complete-soak.mjs');
    expect(script).toContain('ORDER_COMPLETE_SOAK');
    expect(script).toContain('Duplicate submit');
    expect(script).toContain('p95');
  });
});

describe('order complete soak (live DB)', () => {
  let pool: pg.Pool;
  let userId: string;

  beforeAll(async () => {
    if (!RUN_LIVE) return;
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const u = await pool.query<{ id: string }>(
      `SELECT id FROM users WHERE is_active = true LIMIT 1`,
    );
    userId = u.rows[0]?.id ?? '';
    expect(userId).toBeTruthy();
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  it(
    RUN_LIVE
      ? '8-way same idempotency key → exactly one sale + resolve hits'
      : 'live duplicate-key soak skipped',
    async () => {
      if (!RUN_LIVE) {
        expect(process.env.ORDER_COMPLETE_SOAK).not.toBe('1');
        return;
      }

      const stamp = Date.now();
      const key = `jest_soak_dup_${stamp}`;

      const outcomes = await Promise.all(
        Array.from({ length: 8 }, async (_, i) => {
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            try {
              const ins = await client.query(
                `INSERT INTO sales (
                   sale_number, sale_date, subtotal, tax_amount, discount_amount, total_amount,
                   total_cost, profit, profit_margin, payment_method, amount_paid, change_amount,
                   cashier_id, idempotency_key, status, print_count
                 ) VALUES (
                   $1, CURRENT_DATE, 10, 0, 0, 10, 0, 10, 1, 'CASH', 10, 0, $2, $3, 'COMPLETED', 0
                 ) RETURNING id`,
                [`SALE-JSOAK-${stamp}-${i}`, userId, key],
              );
              await client.query('COMMIT');
              return { kind: 'insert' as const, id: ins.rows[0].id as string };
            } catch (e: unknown) {
              await client.query('ROLLBACK');
              if (isIdempotencyUniqueViolation(e)) {
                const existing = await findSaleByIdempotencyKey(pool, key);
                return { kind: 'duplicate' as const, id: existing?.id ?? null };
              }
              throw e;
            }
          } finally {
            client.release();
          }
        }),
      );

      const inserts = outcomes.filter((o) => o.kind === 'insert');
      const ids = new Set(outcomes.map((o) => o.id).filter(Boolean));
      expect(inserts).toHaveLength(1);
      expect(ids.size).toBe(1);

      const resolved = await resolveExistingCompleteSale(pool, {
        orderId: '00000000-0000-0000-0000-000000000000',
        idempotencyKey: key,
      });
      expect(resolved?.id).toBe(inserts[0].id);

      await pool.query(`DELETE FROM sales WHERE idempotency_key = $1`, [key]);
    },
  );

  it(
    RUN_LIVE
      ? 'two FOR UPDATE completes on same order → one COMPLETED'
      : 'live order-lock soak skipped',
    async () => {
      if (!RUN_LIVE) return;

      const stamp = Date.now();
      const setup = await pool.connect();
      let orderId = '';
      try {
        await setup.query('BEGIN');
        const ord = await setup.query<{ id: string }>(
          `INSERT INTO pos_orders (
             order_number, status, subtotal, discount_amount, tax_amount, total_amount,
             created_by, order_date
           ) VALUES ($1, 'PENDING', 10, 0, 0, 10, $2, CURRENT_DATE)
           RETURNING id`,
          [`ORD-JSOAK-${stamp}`, userId],
        );
        orderId = ord.rows[0].id;
        await setup.query('COMMIT');
      } catch (e) {
        await setup.query('ROLLBACK');
        throw e;
      } finally {
        setup.release();
      }

      const race = async (tag: string) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const locked = await client.query<{ status: string }>(
            `SELECT status FROM pos_orders WHERE id = $1 FOR UPDATE`,
            [orderId],
          );
          if (locked.rows[0]?.status !== 'PENDING') {
            await client.query('ROLLBACK');
            return 'lost';
          }
          await client.query(
            `INSERT INTO sales (
               sale_number, sale_date, subtotal, tax_amount, discount_amount, total_amount,
               total_cost, profit, profit_margin, payment_method, amount_paid, change_amount,
               cashier_id, idempotency_key, from_order_id, status, print_count
             ) VALUES (
               $1, CURRENT_DATE, 10, 0, 0, 10, 0, 10, 1, 'CASH', 10, 0, $2, $3, $4, 'COMPLETED', 0
             )`,
            [`SALE-JSOAK-L-${stamp}-${tag}`, userId, `jest_soak_ord_${stamp}_${tag}`, orderId],
          );
          const upd = await client.query(
            `UPDATE pos_orders SET status = 'COMPLETED', completed_at = NOW()
             WHERE id = $1 AND status = 'PENDING' RETURNING id`,
            [orderId],
          );
          if ((upd.rowCount ?? 0) === 0) {
            await client.query('ROLLBACK');
            return 'lost';
          }
          await client.query('COMMIT');
          return 'won';
        } catch (e) {
          await client.query('ROLLBACK').catch(() => {});
          throw e;
        } finally {
          client.release();
        }
      };

      const [a, b] = await Promise.all([race('a'), race('b')]);
      const wins = [a, b].filter((x) => x === 'won');
      expect(wins).toHaveLength(1);

      const sales = await pool.query(
        `SELECT COUNT(*)::int AS c FROM sales WHERE from_order_id = $1`,
        [orderId],
      );
      expect(sales.rows[0].c).toBe(1);

      await pool.query(`DELETE FROM sales WHERE from_order_id = $1`, [orderId]);
      await pool.query(`DELETE FROM pos_orders WHERE id = $1`, [orderId]);
    },
  );
});
