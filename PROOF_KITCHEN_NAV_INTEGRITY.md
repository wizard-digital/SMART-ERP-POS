# PROOF: Kitchen nav integrity & label consistency

- Run: 2026-10-31T10:11:35.389Z
- Command: `npx vitest run src/__tests__/kitchen-nav-integrity.proof.test.ts src/__tests__/adaptive-pwa-phase1-workspace.evidence.test.ts`
- Result: **PASS** — 53 pass / 0 fail / 53 total

## Objective

Distinct Kitchen Display (KDS) vs Kitchen Production (ops hub) labels, routes, titles, and workspace class — no dual Kitchen menu

## Label SSOT

| Surface | Label | Path |
|---------|-------|------|
| Main menu | Kitchen Display | `/restaurant/kitchen` |
| Main menu | Kitchen Production | `/kitchen` |
| KDS page H1 | Kitchen Display | `/restaurant/kitchen` |
| Production hub H1 | Kitchen Production | `/kitchen` |
| Advanced batches H1 | Production Batches | `/kitchen/production` |

## Gates

- **PASS** A1-kds-nav-exists — {"name":"Kitchen Display","path":"/restaurant/kitchen"}
- **PASS** A2-prod-nav-exists — {"name":"Kitchen Production","path":"/kitchen"}
- **PASS** A3-kds-label — Kitchen Display
- **PASS** A4-prod-label — Kitchen Production
- **PASS** A5-no-bare-Kitchen — []
- **PASS** A6-labels-differ
- **PASS** A7-no-duplicate-paths — count=24 unique=24
- **PASS** A8-no-duplicate-names — ["Dashboard","Point of Sale","Restaurant","Kitchen Display","Stations","Printers","Recipes","Kitchen Production","Order tags","Orders Queue","Inventory","Customers","Suppliers","Sales","Sales Targets","Quotations","CRM","HR & Payroll","Sales Orders","Dispatch","Pricing","Accounting","Reports","Category Reports"]
- **PASS** A9-prod-requires-restaurant — name: 'Kitchen Production',
      path: '/kitchen',
      icon: '🍲',
      color: 'text-orange-800',
      permissions:
- **PASS** A10-kds-requires-restaurant — name: 'Kitchen Display',
      path: '/restaurant/kitchen',
      icon: '👨‍🍳',
      color: 'text-orange-700',
      p
- **PASS** B1-route-kds
- **PASS** B2-route-hub
- **PASS** B3-route-batches
- **PASS** B4-route-buffet
- **PASS** B5-route-waste
- **PASS** B5b-route-store-issues
- **PASS** B5c-route-store-issue-audit
- **PASS** B6-route-analytics
- **PASS** B7-layout-kds-perm
- **PASS** B8-layout-prod-perm
- **PASS** C1-kds-h1
- **PASS** C2-hub-h1
- **PASS** C3-batches-h1
- **PASS** C4-batches-not-confused-as-menu-only
- **PASS** C5-buffet-h1
- **PASS** C6-waste-h1
- **PASS** C6b-store-issue-h1
- **PASS** C6c-store-issue-document-grid
- **PASS** C6d-store-issue-not-inline-selected
- **PASS** C6e-store-issue-pdf-ssot
- **PASS** C6f-store-issue-uom
- **PASS** C6g-store-issue-display-reverse
- **PASS** C7-analytics-h1
- **PASS** C8-analytics-no-ambiguous
- **PASS** C9-recipes-link-hub
- **PASS** D1-cashier-kds-label
- **PASS** D2-cashier-no-bare
- **PASS** D3-workspace-class
- **PASS** D4-runtime-kds-family
- **PASS** D5-runtime-hub-family
- **PASS** D6-runtime-batch-family
- **PASS** D6b-runtime-store-issue-family
- **PASS** D7-layout-prod-requires-restaurant
- **PASS** D8-settings-kitchen-tied-to-restaurant
- **PASS** D9-server-requires-restaurant-mode
- **PASS** D10-inventory-store-issue-restaurant-only — id: 'store-issue',
    label: 'Store Issue',
    path: '/kitchen/store-issues',
    icon: '📤',
    group: 'operations',
    description: 'Issue store goods to kitchen/bar exp
- **PASS** E1-hub-ops-copy
- **PASS** E2-hub-not-kds
- **PASS** E3-layout-primary-path-is-hub
- **PASS** E4-no-draft-routes-in-main-menu
- **PASS** W1-json
- **PASS** W2-md
- **PASS** W3-zero-fail — 0 failures before write gates

## Artifacts

- `PROOF_KITCHEN_NAV_INTEGRITY.json`
- `PROOF_KITCHEN_NAV_INTEGRITY.md`

## Verdict

**PASS — certified** (menu integrity + page label consistency).
