/**
 * Click proof for Customer Center cards and the 7-day sales window.
 * The buttons rendered here are the shipping cards. Each click runs the same
 * preset the page applies before the customer list query is built.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import { CustomerCenterOverviewCards } from '../components/customers/CustomerCenterOverviewCards';
import {
  CUSTOMER_CONTACT_CLASS,
  CUSTOMER_MONEY_CELL,
  RECENT_ACTIVITY_PATH,
  customerListPreset,
  lastSevenBusinessDays,
  salesWindowForRecentActivity,
  serverListParamsForState,
} from '../lib/customerCenterOverview';
import { toServerListQuery } from '../lib/serverListParams';

function cardsMarkup() {
  return renderToStaticMarkup(
    createElement(CustomerCenterOverviewCards, {
      totalCustomers: 58,
      activeCustomers: 58,
      totalArText: 'UGX 407,116,519.00',
      totalArTone: 'due',
      customersWithDebt: 43,
      recentActivityText: '65',
      onOpenAll: () => undefined,
      onOpenOwing: () => undefined,
      onOpenRecent: () => undefined,
    }),
  );
}

function listQuery(preset: 'all' | 'owing') {
  const next = customerListPreset(preset);
  return toServerListQuery(
    serverListParamsForState(
      { sortField: next.field, sortOrder: next.order, columnFilterActive: next.filter },
      'balanceGt',
    ),
  );
}

describe('customer center overview', () => {
  it('opens all customers with no balance filter', () => {
    const next = customerListPreset('all');
    expect(next).toEqual({ tab: 'list', search: '', field: 'name', order: 'asc', filter: false });
    expect(listQuery('all')).toEqual({ sortBy: 'name', sortOrder: 'asc' });
  });

  it('opens Total AR and With Debt as the same outstanding-balance list', () => {
    const ar = customerListPreset('owing');
    const debt = customerListPreset('owing');
    expect(ar).toEqual(debt);
    expect(ar).toEqual({ tab: 'list', search: '', field: 'balance', order: 'desc', filter: true });
    expect(listQuery('owing')).toEqual({ sortBy: 'balance', sortOrder: 'desc', balanceGt: 0.01 });
  });

  it('keeps a 7-day business window across month and year boundaries', () => {
    expect(lastSevenBusinessDays('2026-10-01')).toEqual({ start: '2026-09-25', end: '2026-10-01' });
    expect(lastSevenBusinessDays('2026-03-01')).toEqual({ start: '2026-02-23', end: '2026-03-01' });
    expect(lastSevenBusinessDays('2026-01-01')).toEqual({ start: '2025-12-26', end: '2026-01-01' });
    expect(() => lastSevenBusinessDays('2026-02-31')).toThrow('invalid business date');
  });

  it('opens sales on that window and leaves a locked cashier on the business day', () => {
    expect(
      salesWindowForRecentActivity({
        range: 'last-7-days',
        lockToBusinessDay: false,
        today: '2026-10-01',
      }),
    ).toEqual({ dateFilter: 'custom', tab: 'all-sales', start: '2026-09-25', end: '2026-10-01' });
    expect(
      salesWindowForRecentActivity({
        range: 'last-7-days',
        lockToBusinessDay: true,
        today: '2026-10-01',
      }),
    ).toBeNull();
    expect(RECENT_ACTIVITY_PATH).toBe('/sales?range=last-7-days');
  });

  it('uses one left-aligned money class so the header and the amount share an edge', () => {
    expect(CUSTOMER_MONEY_CELL.startsWith('px-3 sm:px-4 py-3')).toBe(true);
    expect(CUSTOMER_MONEY_CELL.includes('whitespace-nowrap')).toBe(true);
    expect(CUSTOMER_MONEY_CELL.includes('tabular-nums')).toBe(true);
    expect(CUSTOMER_MONEY_CELL.includes('text-right')).toBe(false);
    expect(CUSTOMER_CONTACT_CLASS).toBe('hidden lg:table-cell');
  });

  it('clicks each shipping card and applies that card’s list or sales action', async () => {
    const html = cardsMarkup();
    expect(html.includes('Go-live cutover')).toBe(false);
    expect(html.includes('UGX 407,116,519.00')).toBe(true);

    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const clicked: string[] = [];
      await page.exposeFunction('reportCard', (card: string) => {
        clicked.push(card);
      });
      await page.setContent(`<!doctype html><html><body>${html}
        <script>
          document.body.addEventListener('click', (event) => {
            const button = event.target.closest('[data-card]');
            if (!button) return;
            window.reportCard(button.getAttribute('data-card'));
          });
        </script>
      </body></html>`);

      await page.getByRole('button', { name: 'Open all customers' }).click();
      await page.getByRole('button', { name: 'Open customers with an outstanding balance' }).click();
      await page.getByRole('button', { name: 'Open customers with debt' }).click();
      await page.getByRole('button', { name: 'Open sales from the last 7 days' }).click();

      expect(clicked).toEqual(['all', 'ar', 'debt', 'activity']);
      const actions = clicked.map((card) => {
        if (card === 'all') return listQuery('all');
        if (card === 'ar' || card === 'debt') return listQuery('owing');
        return RECENT_ACTIVITY_PATH;
      });
      expect(actions[0]).toEqual({ sortBy: 'name', sortOrder: 'asc' });
      expect(actions[1]).toEqual({ sortBy: 'balance', sortOrder: 'desc', balanceGt: 0.01 });
      expect(actions[2]).toEqual(actions[1]);
      expect(actions[3]).toBe('/sales?range=last-7-days');
    } finally {
      await browser.close();
    }
  });
});
