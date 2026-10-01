/**
 * Structural evidence: Customer Center AR KPIs use open-item SSOT + portfolio stats API.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8');

describe('Customer Center AR overview SSOT', () => {
  it('repository exposes live open-item balance formula (not raw c.balance only)', () => {
    const repo = read('SamplePOS.Server/src/modules/customers/customerRepository.ts');
    expect(repo).toContain('CUSTOMER_OPEN_AR_SQL');
    expect(repo).toContain('amount_due');
    expect(repo).toContain('unallocated_amount');
    expect(repo).toContain('getCustomerCenterStats');
    expect(repo).toMatch(/CUSTOMER_OPEN_AR_SQL[\s\S]*as "balance"/);
  });

  it('center-stats route is registered before /:id', () => {
    const routes = read('SamplePOS.Server/src/modules/customers/customerRoutes.ts');
    const center = routes.indexOf("'/center-stats'");
    const byId = routes.indexOf("'/:id'");
    expect(center).toBeGreaterThan(-1);
    expect(byId).toBeGreaterThan(center);
  });

  it('overview page uses center stats not page sum', () => {
    const page = read('samplepos.client/src/pages/CustomersPage.tsx');
    expect(page).toContain('useCustomerCenterStats');
    expect(page).toContain('totalArBalance');
    expect(page).toContain('customersWithDebt');
    expect(page).not.toMatch(/customers\.reduce\(\(sum.*c\.balance/);
    expect(page).not.toContain('Go-live cutover (legacy AR)');
    expect(page).toContain('RECENT_ACTIVITY_PATH');
    expect(page).toContain('customerListPreset');
    expect(page).toContain('CUSTOMER_MONEY_CELL');
    expect(page).not.toContain('align="right"');
    const cards = read('samplepos.client/src/components/customers/CustomerCenterOverviewCards.tsx');
    expect(cards).toContain('Open all customers');
    expect(cards).toContain('Open customers with an outstanding balance');
    expect(cards).not.toContain('Go-live cutover');
  });
});
