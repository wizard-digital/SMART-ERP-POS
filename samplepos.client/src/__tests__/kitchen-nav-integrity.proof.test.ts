/**
 * PROOF — Kitchen nav integrity + label consistency (SSOT)
 *
 * Certifies:
 *  A) Main menu has exactly two kitchen-family entries with distinct names
 *  B) Paths / titles / App routes stay aligned (no dual "Kitchen" labels)
 *  C) Kitchen Display (KDS) ≠ Kitchen Production (ADR-005 hub)
 *  D) Workspace task-family classification is coherent
 *
 * Run:
 *   npx vitest run src/__tests__/kitchen-nav-integrity.proof.test.ts
 *
 * Artifacts (repo root):
 *   PROOF_KITCHEN_NAV_INTEGRITY.json
 *   PROOF_KITCHEN_NAV_INTEGRITY.md
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { classifyTaskFamily } from '../lib/workspaces';

const clientSrc = resolve(__dirname, '..');
const clientRoot = resolve(clientSrc, '..');
const repoRoot = resolve(clientRoot, '..');

function readRepo(rel: string): string {
  return readFileSync(resolve(repoRoot, rel), 'utf8');
}

type Gate = { id: string; pass: boolean; detail?: string };
const gates: Gate[] = [];

function gate(id: string, pass: boolean, detail?: string) {
  gates.push({ id, pass, detail });
  expect(pass, `${id}${detail ? ` — ${detail}` : ''}`).toBe(true);
}

/** Extract Layout primary nav {name, path} pairs (non-admin block). */
function extractLayoutNav(layoutSrc: string): Array<{ name: string; path: string }> {
  const block = layoutSrc.match(/const navItems: NavItem\[] = \[([\s\S]*?)\];\s*\n\s*const adminNavItems/);
  if (!block) return [];
  const re = /name:\s*'([^']+)'[\s\S]*?path:\s*'([^']+)'/g;
  const out: Array<{ name: string; path: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(block[1])) !== null) {
    out.push({ name: m[1], path: m[2] });
  }
  return out;
}

function extractAppPaths(appSrc: string): string[] {
  const re = /path="(\/[^"]+)"/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(appSrc)) !== null) out.push(m[1]);
  return out;
}

describe('PROOF — kitchen nav integrity & label consistency', () => {
  const layout = readRepo('samplepos.client/src/components/Layout.tsx');
  const app = readRepo('samplepos.client/src/App.tsx');
  const kds = readRepo('samplepos.client/src/pages/restaurant/KitchenDisplayPage.tsx');
  const hub = readRepo('samplepos.client/src/pages/kitchen/KitchenHubPage.tsx');
  const batches = readRepo('samplepos.client/src/pages/kitchen/KitchenProductionPage.tsx');
  const buffet = readRepo('samplepos.client/src/pages/kitchen/KitchenBuffetSessionsPage.tsx');
  const waste = readRepo('samplepos.client/src/pages/kitchen/KitchenWastePage.tsx');
  const storeIssue = readRepo('samplepos.client/src/pages/kitchen/KitchenStoreIssuePage.tsx');
  const storeIssueWorkspace = existsSync(
    resolve(repoRoot, 'samplepos.client/src/components/kitchen/StoreIssueCreateWorkspace.tsx'),
  )
    ? readRepo('samplepos.client/src/components/kitchen/StoreIssueCreateWorkspace.tsx')
    : '';
  const storeIssuePicker = existsSync(
    resolve(repoRoot, 'samplepos.client/src/components/kitchen/StoreIssueLinePicker.tsx'),
  )
    ? readRepo('samplepos.client/src/components/kitchen/StoreIssueLinePicker.tsx')
    : '';
  const analytics = readRepo('samplepos.client/src/pages/kitchen/KitchenAnalyticsPage.tsx');
  const cashier = readRepo('samplepos.client/src/utils/cashierLockdown.ts');
  const recipes = readRepo('samplepos.client/src/pages/restaurant/RestaurantRecipesPage.tsx');
  const workspaces = readRepo('samplepos.client/src/lib/workspaces.ts');

  const nav = extractLayoutNav(layout);
  const appPaths = extractAppPaths(app);

  it('A — menu labels distinct and correctly routed', () => {
    const kdsNav = nav.find((n) => n.path === '/restaurant/kitchen');
    const prodNav = nav.find((n) => n.path === '/kitchen');
    const kitchenOnlyLabels = nav.filter((n) => n.name === 'Kitchen');

    gate('A1-kds-nav-exists', !!kdsNav, JSON.stringify(kdsNav));
    gate('A2-prod-nav-exists', !!prodNav, JSON.stringify(prodNav));
    gate('A3-kds-label', kdsNav?.name === 'Kitchen Display', kdsNav?.name);
    gate('A4-prod-label', prodNav?.name === 'Kitchen Production', prodNav?.name);
    gate('A5-no-bare-Kitchen', kitchenOnlyLabels.length === 0, JSON.stringify(kitchenOnlyLabels));
    gate('A6-labels-differ', kdsNav?.name !== prodNav?.name);
    gate(
      'A7-no-duplicate-paths',
      new Set(nav.map((n) => n.path)).size === nav.length,
      `count=${nav.length} unique=${new Set(nav.map((n) => n.path)).size}`,
    );
    gate(
      'A8-no-duplicate-names',
      new Set(nav.map((n) => n.name)).size === nav.length,
      JSON.stringify(nav.map((n) => n.name)),
    );
    const prodSlice = layout.slice(
      layout.indexOf("name: 'Kitchen Production'"),
      layout.indexOf("name: 'Kitchen Production'") + 450,
    );
    const kdsSlice = layout.slice(
      layout.indexOf("name: 'Kitchen Display'"),
      layout.indexOf("name: 'Kitchen Display'") + 350,
    );
    gate('A9-prod-requires-restaurant', prodSlice.includes('requiresRestaurant: true'), prodSlice.slice(0, 120));
    gate('A10-kds-requires-restaurant', kdsSlice.includes('requiresRestaurant: true'), kdsSlice.slice(0, 120));
  });

  it('B — App routes wired for both families', () => {
    gate('B1-route-kds', appPaths.includes('/restaurant/kitchen'));
    gate('B2-route-hub', appPaths.includes('/kitchen'));
    gate('B3-route-batches', appPaths.includes('/kitchen/production'));
    gate('B4-route-buffet', appPaths.includes('/kitchen/buffet-sessions'));
    gate('B5-route-waste', appPaths.includes('/kitchen/waste'));
    gate('B5b-route-store-issues', appPaths.includes('/kitchen/store-issues'));
    gate('B5c-route-store-issue-audit', appPaths.includes('/reports/inventory/store-issues'));
    gate('B6-route-analytics', appPaths.includes('/kitchen/analytics'));
    gate('B7-layout-kds-perm', layout.includes("'restaurant.kitchen'"));
    gate('B8-layout-prod-perm', layout.includes("'kitchen.production.read'"));
  });

  it('C — page titles match product language', () => {
    gate('C1-kds-h1', /Kitchen Display/.test(kds));
    gate('C2-hub-h1', /Kitchen Production/.test(hub));
    gate('C3-batches-h1', /Production Batches/.test(batches));
    gate('C4-batches-not-confused-as-menu-only', !/name: 'Kitchen Production'/.test(batches));
    gate('C5-buffet-h1', /Buffet Sessions/.test(buffet));
    gate('C6-waste-h1', /Kitchen Waste/.test(waste));
    gate('C6b-store-issue-h1', /Store Issue to Expense/.test(storeIssue));
    gate(
      'C6c-store-issue-document-grid',
      /StoreIssueCreateWorkspace/.test(storeIssue) &&
        /StoreIssueLinePicker/.test(storeIssueWorkspace) &&
        /SlideDrawer/.test(storeIssueWorkspace) &&
        /StoreLocationSelect/.test(storeIssueWorkspace) &&
        /EnterpriseProductSearch/.test(storeIssuePicker) &&
        /DataTable/.test(storeIssuePicker),
    );
    gate(
      'C6d-store-issue-not-inline-selected',
      !/filteredProducts/.test(storeIssue) &&
        !/flex flex-wrap items-center gap-2 p-2/.test(storeIssuePicker),
    );
    gate(
      'C6e-store-issue-pdf-ssot',
      /documents\/STORE_ISSUE/.test(storeIssue) && /downloadFile/.test(storeIssue),
    );
    gate(
      'C6f-store-issue-uom',
      /UomSelector/.test(storeIssuePicker) &&
        /header: 'UoM'/.test(storeIssuePicker) &&
        /header: 'Requested'/.test(storeIssuePicker) &&
        /header: 'Issued'/.test(storeIssuePicker) &&
        /poLineBaseQuantity/.test(storeIssue),
    );
    gate(
      'C6g-store-issue-display-reverse',
      /openDisplay/.test(storeIssue) &&
        /Requested \/ issued/.test(storeIssue) &&
        /reverseIssue/.test(storeIssue) &&
        /mode === 'display'/.test(storeIssueWorkspace) &&
        /Confirm reverse/.test(storeIssueWorkspace) &&
        /formatQtyWithUom/.test(storeIssueWorkspace) &&
        /Reason for reverse/.test(storeIssueWorkspace) &&
        /kitchen.production.reverse/.test(storeIssue) &&
        /Store Issue Audit/.test(storeIssue) &&
        /mutate\(\{ id: draftId, reason \}\)/.test(storeIssue),
    );
    gate('C7-analytics-h1', /Kitchen Food Cost/.test(analytics));
    gate('C8-analytics-no-ambiguous', !/Kitchen Analytics/.test(analytics));
    gate('C9-recipes-link-hub', recipes.includes('to="/kitchen"') && recipes.includes('Kitchen Production'));
  });

  it('D — cashier lockdown + adaptive classification', () => {
    gate(
      'D1-cashier-kds-label',
      cashier.includes("name: 'Kitchen Display'") && cashier.includes("path: '/restaurant/kitchen'"),
    );
    gate('D2-cashier-no-bare', !/name: 'Kitchen',\s*path: '\/restaurant\/kitchen'/.test(cashier));
    gate('D3-workspace-class', workspaces.includes("path === '/kitchen'") || workspaces.includes("'/kitchen/'"));
    gate('D4-runtime-kds-family', classifyTaskFamily('/restaurant/kitchen') === 'restaurant');
    gate('D5-runtime-hub-family', classifyTaskFamily('/kitchen') === 'restaurant');
    gate('D6-runtime-batch-family', classifyTaskFamily('/kitchen/waste') === 'restaurant');
    gate(
      'D6b-runtime-store-issue-family',
      classifyTaskFamily('/kitchen/store-issues') === 'restaurant',
    );
    gate(
      'D7-layout-prod-requires-restaurant',
      layout.includes("name: 'Kitchen Production'") && layout.includes('requiresRestaurant: true'),
    );
    gate(
      'D8-settings-kitchen-tied-to-restaurant',
      /kitchenProductionEnabled[\s\S]*disabled=\{!formData\.restaurantModeEnabled\}|disabled=\{\!formData\.restaurantModeEnabled\}/.test(
        readRepo('samplepos.client/src/pages/settings/tabs/SystemSettingsTab.tsx'),
      ) ||
        readRepo('samplepos.client/src/pages/settings/tabs/SystemSettingsTab.tsx').includes(
          'disabled={!formData.restaurantModeEnabled}',
        ),
    );
    gate(
      'D9-server-requires-restaurant-mode',
      readRepo(
        'SamplePOS.Server/src/modules/kitchen-production/kitchenProductionSettings.ts',
      ).includes('isRestaurantModeEnabled'),
    );
    const inventoryNav = readRepo('samplepos.client/src/components/inventory/inventoryNavConfig.ts');
    const storeIssueNav = inventoryNav.slice(
      inventoryNav.indexOf("id: 'store-issue'"),
      inventoryNav.indexOf("id: 'store-issue'") + 550,
    );
    gate(
      'D10-inventory-store-issue-restaurant-only',
      storeIssueNav.includes('restaurantOnly: true'),
      storeIssueNav.slice(0, 180),
    );
  });

  it('E — integrity: production hub is single primary SSOT entry', () => {
    gate('E1-hub-ops-copy', /Central ops board/i.test(hub));
    gate('E2-hub-not-kds', !/\/restaurant\/kitchen/.test(hub) || hub.includes('POS'));
    gate('E3-layout-primary-path-is-hub', nav.find((n) => n.name === 'Kitchen Production')?.path === '/kitchen');
    // Advanced draft screens are not main-menu items
    gate(
      'E4-no-draft-routes-in-main-menu',
      !nav.some((n) =>
        [
          '/kitchen/production',
          '/kitchen/buffet-sessions',
          '/kitchen/waste',
          '/kitchen/store-issues',
          '/kitchen/analytics',
        ].includes(n.path),
      ),
    );
  });

  it('writes PROOF_KITCHEN_NAV_INTEGRITY evidence', () => {
    const pass = gates.filter((g) => g.pass).length;
    const fail = gates.filter((g) => !g.pass).length;
    const runAt = new Date().toISOString();
    const result = fail === 0 ? 'PASS' : 'FAIL';

    const payload = {
      proof: 'KITCHEN_NAV_INTEGRITY',
      objective:
        'Distinct Kitchen Display (KDS) vs Kitchen Production (ops hub) labels, routes, titles, and workspace class — no dual Kitchen menu',
      runAt,
      result,
      summary: { pass, fail, total: gates.length },
      navSsot: nav.filter(
        (n) =>
          n.path === '/restaurant/kitchen' ||
          n.path === '/kitchen' ||
          n.name.includes('Kitchen'),
      ),
      labels: {
        menuKds: 'Kitchen Display',
        menuProduction: 'Kitchen Production',
        pageKds: 'Kitchen Display',
        pageHub: 'Kitchen Production',
        pageBatches: 'Production Batches',
        pageBuffet: 'Buffet Sessions',
        pageWaste: 'Kitchen Waste & Yield',
        pageFoodCost: 'Kitchen Food Cost',
      },
      gates,
      command:
        'npx vitest run src/__tests__/kitchen-nav-integrity.proof.test.ts src/__tests__/adaptive-pwa-phase1-workspace.evidence.test.ts',
    };

    const jsonPath = resolve(repoRoot, 'PROOF_KITCHEN_NAV_INTEGRITY.json');
    const mdPath = resolve(repoRoot, 'PROOF_KITCHEN_NAV_INTEGRITY.md');
    writeFileSync(jsonPath, JSON.stringify(payload, null, 2), 'utf8');

    const md = [
      '# PROOF: Kitchen nav integrity & label consistency',
      '',
      `- Run: ${runAt}`,
      `- Command: \`${payload.command}\``,
      `- Result: **${result}** — ${pass} pass / ${fail} fail / ${gates.length} total`,
      '',
      '## Objective',
      '',
      payload.objective,
      '',
      '## Label SSOT',
      '',
      '| Surface | Label | Path |',
      '|---------|-------|------|',
      '| Main menu | Kitchen Display | `/restaurant/kitchen` |',
      '| Main menu | Kitchen Production | `/kitchen` |',
      '| KDS page H1 | Kitchen Display | `/restaurant/kitchen` |',
      '| Production hub H1 | Kitchen Production | `/kitchen` |',
      '| Advanced batches H1 | Production Batches | `/kitchen/production` |',
      '',
      '## Gates',
      '',
      ...gates.map(
        (g) =>
          `- **${g.pass ? 'PASS' : 'FAIL'}** ${g.id}${g.detail ? ` — ${g.detail}` : ''}`,
      ),
      '',
      '## Artifacts',
      '',
      '- `PROOF_KITCHEN_NAV_INTEGRITY.json`',
      '- `PROOF_KITCHEN_NAV_INTEGRITY.md`',
      '',
      '## Verdict',
      '',
      fail === 0
        ? '**PASS — certified** (menu integrity + page label consistency).'
        : '**FAIL — do not ship.**',
      '',
    ].join('\n');

    writeFileSync(mdPath, md, 'utf8');
    gate('W1-json', existsSync(jsonPath));
    gate('W2-md', existsSync(mdPath));
    gate('W3-zero-fail', fail === 0, `${fail} failures before write gates`);

    // Re-write with W* included
    const finalPass = gates.filter((g) => g.pass).length;
    const finalFail = gates.filter((g) => !g.pass).length;
    const final = {
      ...payload,
      result: finalFail === 0 ? 'PASS' : 'FAIL',
      summary: { pass: finalPass, fail: finalFail, total: gates.length },
      gates: [...gates],
    };
    writeFileSync(jsonPath, JSON.stringify(final, null, 2), 'utf8');
    writeFileSync(
      mdPath,
      md
        .replace(
          /Result: \*\*[A-Z]+\*\* — \d+ pass \/ \d+ fail \/ \d+ total/,
          `Result: **${final.result}** — ${final.summary.pass} pass / ${final.summary.fail} fail / ${final.summary.total} total`,
        )
        .replace(
          /## Gates\n\n[\s\S]*?\n## Artifacts/,
          `## Gates\n\n${gates
            .map(
              (g) =>
                `- **${g.pass ? 'PASS' : 'FAIL'}** ${g.id}${g.detail ? ` — ${g.detail}` : ''}`,
            )
            .join('\n')}\n\n## Artifacts`,
        ),
      'utf8',
    );
  });
});
