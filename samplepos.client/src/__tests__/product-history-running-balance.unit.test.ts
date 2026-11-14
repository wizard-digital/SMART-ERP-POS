import { describe, expect, it } from 'vitest';
import { applyProductHistoryRunningBalances } from '@shared/utils/productHistoryRunningBalance';

describe('applyProductHistoryRunningBalances', () => {
  it('gives distinct running balances for two identical SALE lines (AMSTEL double-line)', () => {
    const ts = '2026-11-13T21:33:51.000Z';
    const { items, summary } = applyProductHistoryRunningBalances(
      [
        {
          eventDate: ts,
          quantityChange: -2,
          lineTotal: 6000,
          unitCost: 4166.6,
        },
        {
          eventDate: ts,
          quantityChange: -2,
          lineTotal: 6000,
          unitCost: 4166.6,
        },
        {
          eventDate: '2026-11-13T18:45:10.000Z',
          quantityChange: 22,
          totalCost: 0,
          unitCost: 0,
        },
      ],
      { fallbackUnitCost: 4166.6 },
    );

    // Newest-first input + same-second sales: distinct balances (not both 18).
    expect(items.map((i) => i.runningQuantity)).toEqual([20, 18, 22]);
    expect(new Set(items.map((i) => i.runningQuantity)).size).toBe(3);

    expect(summary.totalInQuantity).toBe(22);
    expect(summary.totalOutQuantity).toBe(4);
    expect(summary.netQuantityChange).toBe(18);
  });

  it('does not collide when date|type|qty match but events are distinct', () => {
    const ts = '2026-11-13T21:33:51.000Z';
    const { items } = applyProductHistoryRunningBalances([
      { eventDate: ts, quantityChange: -2 },
      { eventDate: ts, quantityChange: -2 },
      { eventDate: '2026-11-13T10:00:00.000Z', quantityChange: 10, totalCost: 100 },
    ]);
    expect(items.map((i) => i.runningQuantity)).toEqual([8, 6, 10]);
    expect(new Set(items.map((i) => i.runningQuantity)).size).toBe(3);
  });
});
