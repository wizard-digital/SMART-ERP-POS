import { describe, expect, it, vi } from 'vitest';
import { fetchAllPages, PRICING_LIST_MAX_LIMIT } from '../../../shared/pricing/listLimit';

describe('pricing list limit', () => {
  it('never asks for more than 200 rows', async () => {
    const fetchPage = vi.fn(async (page: number, limit: number) => {
      expect(limit).toBeLessThanOrEqual(PRICING_LIST_MAX_LIMIT);
      expect(limit).toBe(200);
      if (page === 1) {
        return { data: ['a'], pagination: { totalPages: 2, total: 2 } };
      }
      return { data: ['b'], pagination: { totalPages: 2, total: 2 } };
    });

    const rows = await fetchAllPages(fetchPage, 500);
    expect(rows).toEqual(['a', 'b']);
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(fetchPage).toHaveBeenNthCalledWith(1, 1, 200);
    expect(fetchPage).toHaveBeenNthCalledWith(2, 2, 200);
  });
});
