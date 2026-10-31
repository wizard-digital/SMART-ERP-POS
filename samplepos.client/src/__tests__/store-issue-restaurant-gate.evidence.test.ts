/**
 * HANDLER PROOF: Store Issue is hidden when restaurant mode is off.
 * Imports the real catalog/nav filters — not a grep of Layout.tsx.
 *
 * Run: npx vitest run src/__tests__/store-issue-restaurant-gate.evidence.test.ts
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALL_INVENTORY_REPORTS,
  visibleInventoryReports,
} from '../config/inventoryReportCatalog';
import {
  INVENTORY_MORE_NAV,
  filterInventoryNavByTenantFlags,
} from '../components/inventory/inventoryNavConfig';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const evidence: Array<{ name: string; ok: true; detail: Record<string, unknown> }> = [];

function prove(name: string, detail: Record<string, unknown>): void {
  evidence.push({ name, ok: true, detail });
}

describe('store issue restaurant gate (executed)', () => {
  it('hides Store Issue Audit from reports when restaurant is off', () => {
    const off = visibleInventoryReports(ALL_INVENTORY_REPORTS, { restaurantEnabled: false });
    const on = visibleInventoryReports(ALL_INVENTORY_REPORTS, { restaurantEnabled: true });
    expect(off.some((r) => r.id === 'store-issues')).toBe(false);
    expect(on.some((r) => r.id === 'store-issues')).toBe(true);
    prove('report-catalog-hidden-when-restaurant-off', {
      offIds: off.map((r) => r.id),
      onHasStoreIssues: on.some((r) => r.id === 'store-issues'),
    });
  });

  it('hides Inventory More Store Issue when restaurant is off', () => {
    const flagsOff = { isMultistoreEnabled: true, restaurantEnabled: false };
    const flagsOn = { isMultistoreEnabled: true, restaurantEnabled: true };
    const off = filterInventoryNavByTenantFlags(INVENTORY_MORE_NAV, flagsOff);
    const on = filterInventoryNavByTenantFlags(INVENTORY_MORE_NAV, flagsOn);
    expect(off.some((t) => t.id === 'store-issue')).toBe(false);
    expect(on.some((t) => t.id === 'store-issue')).toBe(true);
    prove('inventory-nav-hidden-when-restaurant-off', {
      offIds: off.map((t) => t.id),
      onHasStoreIssue: on.some((t) => t.id === 'store-issue'),
    });
  });

  it('Reports hub and Inventory More actually call the tenant filters', () => {
    const reports = readFileSync(
      path.join(repoRoot, 'samplepos.client/src/pages/ReportsPage.tsx'),
      'utf8',
    );
    const layout = readFileSync(
      path.join(repoRoot, 'samplepos.client/src/components/InventoryLayout.tsx'),
      'utf8',
    );
    const audit = readFileSync(
      path.join(repoRoot, 'samplepos.client/src/pages/reports/inventory/StoreIssueAuditReportPage.tsx'),
      'utf8',
    );
    const page = readFileSync(
      path.join(repoRoot, 'samplepos.client/src/pages/kitchen/KitchenStoreIssuePage.tsx'),
      'utf8',
    );
    expect(reports).toMatch(/visibleInventoryReports\(/);
    expect(reports).toMatch(/useRestaurantEnabled/);
    expect(layout).toMatch(/filterInventoryNavByTenantFlags\(/);
    expect(layout).toMatch(/restaurantEnabled:\s*!!restaurantEnabled/);
    expect(audit).toMatch(/useRestaurantEnabled/);
    expect(audit).toMatch(/Restaurant mode is required/);
    expect(page).toMatch(/useRestaurantEnabled/);
    expect(page).toMatch(/storeIssueUiGate/);
    expect(page).toMatch(/Restaurant mode is required/);
    expect(page).not.toMatch(/issuesEnabled/);
    expect(page).not.toMatch(/issues-enabled/);
    const withoutQueryEnabled = page.replace(/enabled:\s*workspaceOn/g, '');
    expect(withoutQueryEnabled).not.toMatch(/\benabled\b/);
    expect(page).toMatch(/canCreate && workspaceOn/);
    expect(page).toMatch(/\[canCreate, workspaceOn,/);
    prove('ui-wiring-uses-filters', {
      reportsPage: true,
      inventoryLayout: true,
      auditPage: true,
      storeIssuePage: true,
      storeIssueUiGateOnly: true,
      noDanglingEnabledIdentifier: true,
    });
  });

  it('writes executed evidence', () => {
    expect(evidence.length).toBe(3);
    const payload = {
      title: 'PROOF_STORE_ISSUE_RESTAURANT_GATE',
      runAt: new Date().toISOString(),
      verdict: 'PASS',
      exercised: 'visibleInventoryReports + filterInventoryNavByTenantFlags',
      checks: evidence,
    };
    const json = JSON.stringify(payload, null, 2);
    writeFileSync(path.join(repoRoot, 'PROOF_STORE_ISSUE_RESTAURANT_GATE.json'), json);
    writeFileSync(
      path.join(repoRoot, 'samplepos.client/PROOF_STORE_ISSUE_RESTAURANT_GATE.json'),
      json,
    );
  });
});
