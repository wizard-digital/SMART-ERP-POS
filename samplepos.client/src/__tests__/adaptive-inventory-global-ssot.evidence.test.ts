/**
 * PROOF: Global inventory adaptive SSOT — KPI strip + worklist consumers.
 *
 * Invariant: Inventory worklists inherit AdaptiveKpiStrip / AdaptiveDataGrid /
 * AdaptiveToolbar — dense + toolbarInline + Filters popover — not hand-rolled
 * grid-cols-1 towers or desktop-only tables.
 *
 * npx vitest run src/__tests__/adaptive-inventory-global-ssot.evidence.test.ts
 */
import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ADAPTIVE_WORKLIST_DENSITY,
  ADAPTIVE_WORKLIST_SEARCH_DEBOUNCE_MS,
  WORKLIST_KPI_GRID_4_CLASS,
  WORKLIST_KPI_GRID_6_CLASS,
  worklistKpiGridClass,
} from '../lib/adaptiveDashboard';

const here = dirname(fileURLToPath(import.meta.url));
const clientRoot = resolve(here, '../..');
const repoRoot = resolve(clientRoot, '..');

type Gate = { id: string; ok: boolean; detail: string };
const gates: Gate[] = [];

function gate(id: string, ok: boolean, detail: string): void {
  gates.push({ id, ok, detail });
  expect({ id, ok, detail }).toEqual({ id, ok: true, detail });
}

function read(rel: string): string {
  return readFileSync(resolve(clientRoot, 'src', rel), 'utf8');
}

const WORKLIST_PAGES = [
  'pages/inventory/ProductsPage.tsx',
  'pages/inventory/PurchaseOrdersPage.tsx',
  'pages/inventory/GoodsReceiptsPage.tsx',
  'pages/inventory/StockMovementsPage.tsx',
  'pages/inventory/InventoryAdjustmentsPage.tsx',
  'pages/inventory/BatchManagementPage.tsx',
  'pages/inventory/StockLevelsPage.tsx',
  'pages/inventory/SupplierReturnsPage.tsx',
] as const;

describe('PROOF: global inventory adaptive SSOT', () => {
  it('adaptiveDashboard exports worklist KPI grids that never cols-1', () => {
    gate(
      'WORKLIST_2UP',
      WORKLIST_KPI_GRID_4_CLASS.includes('grid-cols-2') &&
        !WORKLIST_KPI_GRID_4_CLASS.includes('grid-cols-1') &&
        WORKLIST_KPI_GRID_6_CLASS.includes('grid-cols-2') &&
        !WORKLIST_KPI_GRID_6_CLASS.includes('grid-cols-1'),
      'worklist grids are 2-up on phone',
    );
    gate(
      'WORKLIST_RESOLVER',
      worklistKpiGridClass(3) === WORKLIST_KPI_GRID_4_CLASS &&
        worklistKpiGridClass(6) === WORKLIST_KPI_GRID_6_CLASS,
      'worklistKpiGridClass maps count → grid class',
    );
    gate(
      'WORKLIST_DENSITY_TOKEN',
      ADAPTIVE_WORKLIST_DENSITY === 'dense' &&
        ADAPTIVE_WORKLIST_SEARCH_DEBOUNCE_MS === 300,
      'ADAPTIVE_WORKLIST_DENSITY dense + search debounce 300ms',
    );
  });

  it('AdaptiveKpiStrip is the consumer SSOT', () => {
    const src = read('components/adaptive/AdaptiveKpiStrip.tsx');
    const barrel = read('components/adaptive/index.ts');
    gate(
      'KPI_STRIP_SSOT',
      src.includes('data-adaptive-kpi-strip') &&
        src.includes('data-kpi-ssot="adaptiveDashboard"') &&
        src.includes('worklistKpiGridClass') &&
        barrel.includes('AdaptiveKpiStrip'),
      'AdaptiveKpiStrip + barrel export',
    );
  });

  it('All inventory worklists share dense + toolbarInline + AdaptiveSearch chrome', () => {
    const createFirst = new Set([
      'pages/inventory/ProductsPage.tsx',
      'pages/inventory/PurchaseOrdersPage.tsx',
      'pages/inventory/GoodsReceiptsPage.tsx',
      'pages/inventory/StockMovementsPage.tsx',
      'pages/inventory/InventoryAdjustmentsPage.tsx',
    ]);
    const serverSearch = new Set([
      'pages/inventory/PurchaseOrdersPage.tsx',
      'pages/inventory/GoodsReceiptsPage.tsx',
      'pages/inventory/StockMovementsPage.tsx',
      'pages/inventory/SupplierReturnsPage.tsx',
    ]);

    for (const rel of WORKLIST_PAGES) {
      const src = read(rel);
      const id = rel.split('/').pop()!.replace('.tsx', '').toUpperCase();
      gate(
        `DENSE_${id}`,
        src.includes('ADAPTIVE_WORKLIST_DENSITY') &&
          (src.includes('toolbarInline') || src.includes('toolbarInline={!embedded}')),
        `${rel}: ADAPTIVE_WORKLIST_DENSITY + toolbarInline`,
      );
      gate(
        `SEARCH_${id}`,
        src.includes('AdaptiveSearch') &&
          src.includes('<AdaptiveToolbar') &&
          (src.includes('leading={') || src.includes('leading ={')),
        `${rel}: AdaptiveSearch in AdaptiveToolbar leading (no blank toolbar)`,
      );
      if (createFirst.has(rel)) {
        gate(
          `CREATE_FIRST_${id}`,
          src.includes('actionsBeforeLeading'),
          `${rel}: create-first CTAs before Search`,
        );
      }
      if (serverSearch.has(rel)) {
        gate(
          `SERVER_SEARCH_${id}`,
          src.includes('ADAPTIVE_WORKLIST_SEARCH_DEBOUNCE_MS') &&
            src.includes('debouncedSearch'),
          `${rel}: debounced server search (accurate, not per-keystroke)`,
        );
      }
    }
  });

  it('PurchaseOrdersPage consumes AdaptiveKpiStrip + toolbar filters', () => {
    const src = read('pages/inventory/PurchaseOrdersPage.tsx');
    gate(
      'PO_KPI_STRIP',
      src.includes('AdaptiveKpiStrip') &&
        src.includes('ADAPTIVE_PAGE_PAD_CLASS') &&
        !src.includes('grid grid-cols-1 md:grid-cols-6'),
      'PO uses AdaptiveKpiStrip; no cols-1×6 towers',
    );
    gate(
      'PO_FILTERS_TOOLBAR',
      src.includes('data-po-filter-panel') &&
        src.includes('secondary={({ close })') &&
        src.includes('modeOverride="compact"') &&
        src.includes('actionsBeforeLeading') &&
        src.includes('AdaptiveSearch') &&
        src.includes('Search purchase orders') &&
        src.includes('search: debouncedSearch'),
      'PO: Create + Filters + Search on AdaptiveToolbar (search fills dead space)',
    );
  });

  it('InventoryAdjustmentsPage uses AdaptivePage + DataGrid + Search', () => {
    const src = read('pages/inventory/InventoryAdjustmentsPage.tsx');
    gate(
      'ADJ_ADAPTIVE_SHELL',
      src.includes('AdaptivePage') &&
        src.includes('AdaptiveToolbar') &&
        src.includes('AdaptiveSearch') &&
        src.includes('ADAPTIVE_PAGE_PAD_CLASS'),
      'Adjustments uses AdaptivePage chrome',
    );
    gate(
      'ADJ_DATA_GRID',
      src.includes('AdaptiveDataGrid') &&
        src.includes('adjustmentBatchColumns') &&
        src.includes('renderRowActions'),
      'batch list uses AdaptiveDataGrid (cards on phone)',
    );
    gate(
      'ADJ_PC_KPI',
      src.includes('AdaptiveKpiStrip') && src.includes('pc-disc'),
      'physical count stats use AdaptiveKpiStrip',
    );
  });

  it('Movement History + Batches + Stock Levels inherit worklist SSOT', () => {
    const mov = read('pages/inventory/StockMovementsPage.tsx');
    const batch = read('pages/inventory/BatchManagementPage.tsx');
    const stock = read('pages/inventory/StockLevelsPage.tsx');
    const adj = read('pages/inventory/InventoryAdjustmentsPage.tsx');
    const returns = read('pages/inventory/SupplierReturnsPage.tsx');
    gate(
      'MOVEMENTS_SSOT',
      mov.includes('AdaptivePage') &&
        mov.includes('AdaptiveKpiStrip') &&
        mov.includes('ADAPTIVE_WORKLIST_DENSITY') &&
        mov.includes('data-movements-result-count') &&
        mov.includes('data-movements-primary-cta') &&
        mov.includes('more={') &&
        mov.includes('<AdaptiveToolbar') &&
        mov.includes('ADAPTIVE_TOOLBAR_CARD_CLASS') &&
        mov.includes('actionsBeforeLeading') &&
        !mov.includes('flex-col gap-2 w-full min-w') &&
        !mov.includes('grid grid-cols-1 md:grid-cols-4'),
      'Movement History: dense Adjustments+Filters+More — no CTA towers',
    );
    gate(
      'BATCHES_SSOT',
      batch.includes('AdaptivePage') &&
        batch.includes('AdaptiveKpiStrip') &&
        batch.includes('more={') &&
        batch.includes('ADAPTIVE_TOOLBAR_CARD_CLASS') &&
        batch.includes('ADAPTIVE_WORKLIST_DENSITY') &&
        !batch.includes('mobileActionBtnClass') &&
        !batch.includes('grid grid-cols-1 md:grid-cols-5'),
      'Batch Management: dense Refresh in toolbar More — no hero Refresh CTA',
    );
    gate(
      'STOCK_KPI_SSOT',
      stock.includes('AdaptiveKpiStrip') &&
        stock.includes('ADAPTIVE_PAGE_PAD_CLASS') &&
        stock.includes('modeOverride="compact"') &&
        stock.includes('secondary={({ close })') &&
        stock.includes('more={') &&
        stock.includes('ADAPTIVE_TOOLBAR_CARD_CLASS') &&
        stock.includes('ADAPTIVE_WORKLIST_DENSITY') &&
        !stock.includes('grid grid-cols-1 md:grid-cols-4'),
      'Stock Levels: dense Filters with close() + More Refresh',
    );
    gate(
      'ADJ_NO_CTA_TOWER',
      adj.includes('data-adj-primary-cta') &&
        adj.includes('more={') &&
        adj.includes('ADAPTIVE_TOOLBAR_CARD_CLASS') &&
        adj.includes('actionsBeforeLeading') &&
        !adj.includes('flex w-full flex-col gap-2'),
      'Adjustments: Physical Count before Search; Movement History in More',
    );
    gate(
      'RETURNS_SSOT',
      returns.includes('AdaptivePage') &&
        returns.includes('hideTitle={embedded}') &&
        returns.includes('AdaptiveToolbar') &&
        returns.includes('AdaptiveFacetChips') &&
        returns.includes('AdaptiveKpiStrip') &&
        returns.includes('AdaptiveRowActions') &&
        returns.includes('ADAPTIVE_WORKLIST_DENSITY') &&
        !returns.includes('flex flex-col gap-1.5 min-w-[140px]'),
      'Supplier Returns inherits AdaptivePage/Toolbar/facets/row-actions SSOT',
    );
  });

  it('Products catalog inherits AdaptiveToolbar worklist SSOT', () => {
    const src = read('pages/inventory/ProductsPage.tsx');
    gate(
      'PRODUCTS_SSOT',
      src.includes('AdaptivePage') &&
        src.includes('AdaptiveToolbar') &&
        src.includes('AdaptiveSearch') &&
        src.includes('data-products-primary-cta') &&
        src.includes('data-products-filter-panel') &&
        src.includes('AdaptiveRowActions') &&
        src.includes('toolbarInline') &&
        src.includes('ADAPTIVE_WORKLIST_DENSITY') &&
        !src.includes('flex justify-between items-center mb-6') &&
        !src.includes('Search Products') &&
        !src.includes("byStoreView ? 'md:grid-cols-4' : 'md:grid-cols-3'"),
      'Products: title + Add/Filters/Search share one header row (no white band)',
    );
    gate(
      'PRODUCTS_ACTIONS_BEFORE_SEARCH',
      src.includes('actionsBeforeLeading') &&
        src.includes('data-products-primary-cta'),
      'Products: + Add Product and Filters sit before Search on one row',
    );
    gate(
      'PRODUCTS_MOBILE_CARD_ALIGN',
      src.includes('data-products-mobile-card') &&
        src.includes('data-products-card-actions') &&
        src.includes('data-product-status="inactive"') &&
        src.includes('!product.isActive') &&
        !src.includes("product.isActive ? 'Active' : 'Inactive'"),
      'Phone product cards: hide Active (default); only Inactive + ··· aligned — no right-column stack',
    );
  });

  it('AdaptiveToolbar supports actions-before-search chrome (Products SSOT)', () => {
    const toolbar = read('components/adaptive/AdaptiveToolbar.tsx');
    const page = read('components/adaptive/AdaptivePage.tsx');
    const search = read('components/adaptive/AdaptiveSearch.tsx');
    const moreMenu = read('components/adaptive/AdaptiveMoreMenu.tsx');
    const sortUi = read('components/ui/MobileSortSelect.tsx');
    const po = read('pages/inventory/PurchaseOrdersPage.tsx');
    const mov = read('pages/inventory/StockMovementsPage.tsx');
    gate(
      'ACTIONS_BEFORE_LEADING_PROP',
      toolbar.includes('actionsBeforeLeading') &&
        toolbar.includes('data-toolbar-actions-before'),
      'AdaptiveToolbar exposes actionsBeforeLeading for create-first worklists',
    );
    gate(
      'PAGE_TOOLBAR_INLINE',
      page.includes('toolbarInline') &&
        page.includes('data-toolbar-inline') &&
        page.includes('data-page-toolbar-inline') &&
        page.includes('flex flex-col gap-2 md:flex-row') &&
        page.includes('w-full md:flex-1 md:basis-[12rem]'),
      'AdaptivePage: title above full-width toolbar until md; then title|toolbar inline',
    );
    gate(
      'CREATE_FIRST_RESPONSIVE',
      toolbar.includes('actionsBeforeLeading') &&
        toolbar.includes('data-toolbar-actions-before') &&
        toolbar.includes('flex-col gap-2 sm:flex-row') &&
        toolbar.includes('sm:flex-1 sm:basis-[12rem]') &&
        !toolbar.includes('min-w-0 w-full flex-1 basis-[12rem]') &&
        search.includes('w-full min-w-0') &&
        search.includes('data-adaptive-search'),
      'create-first: no phone flex-basis blank band; sm+ Search grows on one row',
    );
    gate(
      'MORE_OVERFLOW_ELLIPSIS',
      moreMenu.includes('···') &&
        moreMenu.includes('sm:hidden') &&
        moreMenu.includes('hidden sm:inline'),
      'More trigger is ··· on phone (SAP/Square overflow), labeled More on sm+',
    );
    gate(
      'MOBILE_SORT_IN_MORE',
      sortUi.includes("presentation === 'menu'") &&
        sortUi.includes('data-mobile-sort-menu') &&
        po.includes('presentation="menu"') &&
        mov.includes('presentation="menu"') &&
        !po.includes('className="mt-2"'),
      'Phone sort lives in More overflow — no separate Sort row under Search',
    );
    gate(
      'FILTERS_POPOVER',
      toolbar.includes("data-secondary-presentation=\"popover\"") &&
        toolbar.includes('data-adaptive-toolbar-filter-anchor') &&
        toolbar.includes('data-filter-fit="full-bleed"') &&
        toolbar.includes("e.key === 'Escape'") &&
        toolbar.includes('pointerEventStaysInsideOverlay'),
      'Filters: full-bleed overlay under chrome + Escape/outside-click close; portaled Select stays open',
    );
    gate(
      'FILTERS_MORE_MUTEX',
      toolbar.includes('onMoreOpenChange') &&
        toolbar.includes('setMoreOpen(false)') &&
        toolbar.includes('setSecondaryOpen(false)') &&
        toolbar.includes("data-toolbar-panel={") &&
        moreMenu.includes('onOpenChange') &&
        moreMenu.includes('openControlled') &&
        moreMenu.includes('max-h-[min(70vh,24rem)]'),
      'Filters XOR More: controlled AdaptiveMoreMenu + scroll panel — never stacked overlays',
    );
    gate(
      'SORT_MENU_LABEL_SSOT',
      sortUi.includes('formatMobileSortMenuLabel') &&
        sortUi.includes("replace(/^Sort by\\s+/i") &&
        !sortUi.includes("Sort: {opt.label}"),
      'More sort items use Sort by X once — never Sort: Sort by …',
    );
    gate(
      'FILTER_PANEL_PHONE_SSOT',
      (() => {
        const panel = read('components/adaptive/AdaptiveFilterPanel.tsx');
        const tokens = read('lib/adaptiveDashboard.ts');
        return (
          panel.includes('data-adaptive-filter-panel') &&
          panel.includes('ADAPTIVE_FILTER_GRID_CLASS') &&
          tokens.includes("ADAPTIVE_FILTER_GRID_CLASS = 'grid grid-cols-2 gap-2'") &&
          tokens.includes('ADAPTIVE_FILTER_LABEL_CLASS') &&
          toolbar.includes('data-filter-fit="full-bleed"')
        );
      })(),
      'AdaptiveFilterPanel: dense 2-up grid + full-bleed Filters fit on phone',
    );
  });
});

afterAll(() => {
  const passed = gates.filter((g) => g.ok).length;
  const failed = gates.filter((g) => !g.ok);
  const payload = {
    proof: 'ADAPTIVE_INVENTORY_GLOBAL_SSOT',
    verdict: failed.length === 0 ? 'PASS' : 'FAIL',
    generatedAt: new Date().toISOString(),
    passed,
    total: gates.length,
    gates,
    integrity:
      'Global inventory adaptive SSOT: dense + toolbarInline + AdaptiveSearch; Filters XOR More (mutex); sort labels SSOT; create-first CTAs; debounced server search; Filters popover — no stacked chrome or Sort: Sort by forks.',
  };
  const json = JSON.stringify(payload, null, 2);
  const md = `# PROOF — Adaptive inventory global SSOT

**Verdict:** ${payload.verdict}
**Generated:** ${payload.generatedAt}
**Gates:** ${passed}/${gates.length}

${gates.map((g) => `- ${g.ok ? 'PASS' : 'FAIL'} \`${g.id}\` — ${g.detail}`).join('\n')}

## Integrity
${payload.integrity}
`;
  for (const dir of [clientRoot, repoRoot]) {
    writeFileSync(resolve(dir, 'PROOF_ADAPTIVE_INVENTORY_GLOBAL_SSOT.json'), json);
    writeFileSync(resolve(dir, 'PROOF_ADAPTIVE_INVENTORY_GLOBAL_SSOT.md'), md);
  }
});
