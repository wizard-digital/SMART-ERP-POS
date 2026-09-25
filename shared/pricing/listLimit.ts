/** Shared with GET /pricing/categories and GET /pricing/rules. */
export const PRICING_LIST_MAX_LIMIT = 200;

type Page<T> = {
  data: T[];
  pagination?: { totalPages?: number; total?: number };
};

/**
 * Load every page without sending a limit the pricing API rejects.
 */
export async function fetchAllPages<T>(
  fetchPage: (page: number, limit: number) => Promise<Page<T>>,
  pageSize = PRICING_LIST_MAX_LIMIT,
): Promise<T[]> {
  const size = Math.min(Math.max(1, pageSize), PRICING_LIST_MAX_LIMIT);
  const first = await fetchPage(1, size);
  const totalPages = Math.max(1, first.pagination?.totalPages ?? 1);
  const rows = [...(first.data ?? [])];
  for (let page = 2; page <= totalPages; page += 1) {
    const next = await fetchPage(page, size);
    rows.push(...(next.data ?? []));
  }
  return rows;
}
