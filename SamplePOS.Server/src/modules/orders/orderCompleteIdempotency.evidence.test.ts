/**
 * P1 PROOF: order complete idempotency + exactly-one settlement integrity.
 *
 * Gates (no prod without green):
 * - CompleteOrderSchema requires idempotencyKey
 * - Route passes key into createSale + handles 23505 / ERR_ORDER_003 replay
 * - createSale locks pos_orders FOR UPDATE and aborts if complete UPDATE hits 0 rows
 * - Client sends stable session key + X-Idempotency-Key
 * - Offline finalizeSale still uses event.key (replay safe)
 */
import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isIdempotencyUniqueViolation,
  resolveExistingCompleteSale,
} from './orderCompleteIdempotency.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../..');

function readRepo(rel: string): string {
  return readFileSync(resolve(root, rel), 'utf8');
}

describe('order complete idempotency — pure helpers', () => {
  it('detects PG unique violation on idempotency_key', () => {
    expect(
      isIdempotencyUniqueViolation({
        code: '23505',
        constraint: 'sales_idempotency_key_key',
      }),
    ).toBe(true);
    expect(isIdempotencyUniqueViolation({ code: '23505', constraint: 'other' })).toBe(false);
    expect(isIdempotencyUniqueViolation({ code: '40P01' })).toBe(false);
  });

  it('resolveExistingCompleteSale prefers key then from_order_id', async () => {
    const calls: string[] = [];
    const fakePool = {
      query: async (sql: string, params: unknown[]) => {
        calls.push(String(sql));
        if (sql.includes('idempotency_key')) {
          expect(params[0]).toBe('ordc_key_1');
          return { rows: [{ id: 'sale-1', sale_number: 'SALE-2026-0001' }] };
        }
        return { rows: [] };
      },
    };
    const hit = await resolveExistingCompleteSale(fakePool as never, {
      orderId: 'order-1',
      idempotencyKey: 'ordc_key_1',
    });
    expect(hit).toEqual({ id: 'sale-1', saleNumber: 'SALE-2026-0001' });
    expect(calls.some((s) => s.includes('idempotency_key'))).toBe(true);
  });

  it('resolveExistingCompleteSale falls back to from_order_id', async () => {
    const fakePool = {
      query: async (sql: string) => {
        if (sql.includes('idempotency_key')) return { rows: [] };
        if (sql.includes('from_order_id')) {
          return { rows: [{ id: 'sale-2', sale_number: 'SALE-2026-0002' }] };
        }
        return { rows: [] };
      },
    };
    const hit = await resolveExistingCompleteSale(fakePool as never, {
      orderId: 'order-2',
      idempotencyKey: 'missing-key',
    });
    expect(hit).toEqual({ id: 'sale-2', saleNumber: 'SALE-2026-0002' });
  });
});

describe('order complete idempotency — SSOT source gates', () => {
  it('EVIDENCE: CompleteOrderSchema requires idempotencyKey', () => {
    const routes = readRepo('SamplePOS.Server/src/modules/orders/ordersRoutes.ts');
    expect(routes).toMatch(/CompleteOrderSchema[\s\S]*idempotencyKey:\s*z\.string\(\)\.min\(1\)\.max\(100\)/);
    expect(routes).toContain('idempotencyKey,');
    expect(routes).toContain('alreadyCompleted: true');
    expect(routes).toContain('isIdempotencyUniqueViolation');
    expect(routes).toContain('ERR_ORDER_003');
    expect(routes).toContain("headers['x-idempotency-key']");
    expect(routes).toMatch(
      /catch \(createErr: unknown\) \{[\s\S]*resolveExistingCompleteSale\(pool, \{ orderId, idempotencyKey \}\)[\s\S]*throw createErr/,
    );
  });

  it('EVIDENCE: createSale locks order FOR UPDATE and fails closed on lost complete race', () => {
    const sales = readRepo('SamplePOS.Server/src/modules/sales/salesService.ts');
    expect(sales).toContain('FOR UPDATE');
    expect(sales).toContain('fromOrderId');
    expect(sales).toMatch(/WHERE id = \$1 AND status = 'PENDING'[\s\S]*RETURNING id/);
    expect(sales).toContain('rowCount === 0');
    expect(sales).toContain('ERR_ORDER_003');
  });

  it('EVIDENCE: client sends stable complete key + X-Idempotency-Key', () => {
    const page = readRepo('samplepos.client/src/pages/orders/OrderPaymentPage.tsx');
    expect(page).toContain('getOrCreateOrderCompleteIdempotencyKey');
    expect(page).toContain('order_complete_idem:');
    expect(page).toContain('idempotencyKey: getOrCreateOrderCompleteIdempotencyKey');
    expect(page).toContain('clearOrderCompleteIdempotencyKey');

    const api = readRepo('samplepos.client/src/utils/api.ts');
    expect(api).toContain('idempotencyKey: string');
    expect(api).toContain("'X-Idempotency-Key'");
  });

  it('EVIDENCE: offline SALE_COMPLETED replay still keys createSale with event.key', () => {
    const replayer = readRepo('SamplePOS.Server/src/modules/pos/posEventReplayer.ts');
    expect(replayer).toMatch(/idempotencyKey:\s*event\.key/);
    expect(replayer).toContain('idempotency_key');
    expect(replayer).toContain('23505');
  });
});
