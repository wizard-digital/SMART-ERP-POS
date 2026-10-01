import type { ServerListParams } from './serverListParams';

/** Same padding on the header and the cell so the label sits on the amount. */
export const CUSTOMER_CELL = 'px-3 sm:px-4 py-3 align-middle';
export const CUSTOMER_MONEY_CELL = `${CUSTOMER_CELL} whitespace-nowrap tabular-nums`;
/** Hidden together on narrower widths so Balance, Deposits, and Credit Limit still fit. */
export const CUSTOMER_CONTACT_CLASS = 'hidden lg:table-cell';

export const RECENT_ACTIVITY_PATH = '/sales?range=last-7-days';

export type CustomerListPresetName = 'all' | 'owing';

export interface CustomerListPreset {
  tab: 'list';
  search: '';
  field: 'name' | 'balance';
  order: 'asc' | 'desc';
  filter: boolean;
}

/** What a Customer Center card opens. Owing is the same open-item set as Total AR and With Debt. */
export function customerListPreset(preset: CustomerListPresetName): CustomerListPreset {
  if (preset === 'owing') {
    return { tab: 'list', search: '', field: 'balance', order: 'desc', filter: true };
  }
  return { tab: 'list', search: '', field: 'name', order: 'asc', filter: false };
}

/**
 * Inclusive business-calendar window: `today` and the six days before it.
 * `today` is a business date YYYY-MM-DD, not a browser clock time.
 */
export function lastSevenBusinessDays(todayYmd: string): { start: string; end: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(todayYmd)) {
    throw new Error('business date must be YYYY-MM-DD');
  }
  const [year, month, day] = todayYmd.split('-').map((part) => parseInt(part, 10));
  const cursor = new Date(Date.UTC(year, month - 1, day));
  if (
    cursor.getUTCFullYear() !== year ||
    cursor.getUTCMonth() !== month - 1 ||
    cursor.getUTCDate() !== day
  ) {
    throw new Error('invalid business date');
  }
  cursor.setUTCDate(cursor.getUTCDate() - 6);
  return { start: cursor.toISOString().slice(0, 10), end: todayYmd };
}

export interface RecentActivityWindow {
  dateFilter: 'custom';
  tab: 'all-sales';
  start: string;
  end: string;
}

/** Cashiers stay on the business day. Everyone else opening Recent Activity gets the 7-day window. */
export function salesWindowForRecentActivity(args: {
  range: string | null;
  lockToBusinessDay: boolean;
  today: string;
}): RecentActivityWindow | null {
  if (args.lockToBusinessDay || args.range !== 'last-7-days') return null;
  const window = lastSevenBusinessDays(args.today);
  return { dateFilter: 'custom', tab: 'all-sales', start: window.start, end: window.end };
}

export function serverListParamsForState(
  state: { sortField: string; sortOrder: 'asc' | 'desc'; columnFilterActive: boolean },
  filterParam: 'outstandingOnly' | 'balanceGt' | 'stockGt' = 'outstandingOnly',
): ServerListParams {
  return {
    sortBy: state.sortField,
    sortOrder: state.sortOrder,
    ...(state.columnFilterActive && filterParam === 'outstandingOnly' ? { outstandingOnly: true } : {}),
    ...(state.columnFilterActive && filterParam === 'balanceGt' ? { balanceGt: 0.01 } : {}),
    ...(state.columnFilterActive && filterParam === 'stockGt' ? { stockGt: true } : {}),
  };
}
