import { describe, expect, it, jest } from '@jest/globals';
import { insertEvent } from './notificationRepository.js';

describe('notification event idempotency', () => {
  it('returns the existing row when idempotency_key already exists', async () => {
    const rows = new Map<string, Record<string, unknown>>();
    const db = {
      query: jest.fn(async (sql: string, params: unknown[]) => {
        if (String(sql).includes('INSERT INTO notification_events')) {
          const key = String(params[3]);
          if (rows.has(key)) return { rows: [] };
          const row = {
            id: 'evt-new',
            type_key: params[0],
            entity_type: params[1],
            entity_id: params[2],
            idempotency_key: key,
            payload: { ok: true },
            actor_user_id: null,
            store_location_id: null,
            occurred_at: new Date().toISOString(),
            status: 'PENDING',
            retry_count: 0,
          };
          rows.set(key, row);
          return { rows: [row] };
        }
        if (String(sql).includes('WHERE idempotency_key')) {
          return { rows: [rows.get(String(params[0]))].filter(Boolean) };
        }
        return { rows: [] };
      }),
    };

    const first = await insertEvent(db as never, {
      typeKey: 'SALE_COMPLETED',
      entityType: 'sale',
      entityId: 's1',
      idempotencyKey: 'SALE_COMPLETED:sale:s1',
      payload: { ok: true },
    });
    const second = await insertEvent(db as never, {
      typeKey: 'SALE_COMPLETED',
      entityType: 'sale',
      entityId: 's1',
      idempotencyKey: 'SALE_COMPLETED:sale:s1',
      payload: { ok: true },
    });
    expect(first?.id).toBe('evt-new');
    expect(second?.id).toBe('evt-new');
    expect(rows.size).toBe(1);
  });
});
