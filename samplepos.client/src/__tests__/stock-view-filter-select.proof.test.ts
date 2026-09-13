/**
 * Proof: By Store shop pick inside Filters must commit, not snap back to MAIN.
 *
 * Reproduction (the live bug):
 * 1. Filters panel is open (AdaptiveToolbar compact overlay).
 * 2. Warehouse-or-shop Radix list is portaled to document.body.
 * 3. mousedown on a shop option is outside the toolbar DOM.
 * 4. Old dismiss closed Filters and unmounted the Select before onValueChange.
 * 5. storeFilterId stayed MAIN.
 *
 * This file fires those handlers. Source greps are wiring only, after the handlers pass.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { pointerEventStaysInsideOverlay } from '../lib/adaptiveOverlayDismiss';
import { commitStoreLocationSelectValue } from '../components/inventory/storeLocationSelectCommit';
import {
  retainOrDefaultStockViewStoreId,
} from '../components/inventory/warehouseNetworkUtils';
import type { StoreLocation as SharedStoreLocation } from '../../../shared/types/warehouseNetwork';

const clientSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function store(id: string, storeType: SharedStoreLocation['storeType']): SharedStoreLocation {
  return {
    id,
    code: storeType,
    name: storeType,
    storeType,
    isActive: true,
    isDefaultReceiving: storeType === 'MAIN',
    isPosSelling: storeType === 'SELLING',
    parentStoreId: null,
    notes: null,
    createdAt: '',
    updatedAt: '',
  };
}

/** Same decision AdaptiveToolbar onPointer uses: keep Filters open or close. */
function filtersStayOpen(
  toolbarContainsTarget: boolean,
  target: { closest: (selector: string) => unknown } | Record<string, never>,
): boolean {
  const toolbar = { contains: () => toolbarContainsTarget };
  return pointerEventStaysInsideOverlay(toolbar, { target });
}

function portaledShopOption() {
  return {
    closest: (selector: string) =>
      selector.includes('data-radix-select-content') ? { role: 'listbox' } : null,
  };
}

/**
 * Operator path: Filters open → click shop in portaled list → Radix commits id →
 * store list refetch runs defaulting.
 */
function pickShopInsideFilters(args: {
  stores: SharedStoreLocation[];
  currentStoreId: string;
  shopId: string;
  click: 'shop-option' | 'page-background' | 'filters-panel';
}): { filtersOpen: boolean; storeId: string } {
  let filtersOpen = true;
  let storeId = args.currentStoreId;

  const shopOption = portaledShopOption();
  const pageBackground = {};
  const filtersPanel = { closest: () => null };

  const target =
    args.click === 'shop-option'
      ? shopOption
      : args.click === 'filters-panel'
        ? filtersPanel
        : pageBackground;
  const insideToolbar = args.click === 'filters-panel';

  if (!filtersStayOpen(insideToolbar, target)) {
    filtersOpen = false;
  }

  if (filtersOpen && args.click === 'shop-option') {
    commitStoreLocationSelectValue(args.shopId, (id) => {
      storeId = id;
    });
  }

  storeId = retainOrDefaultStockViewStoreId(storeId, args.stores);
  return { filtersOpen, storeId };
}

describe('stock view Filters shop select — handler proof', () => {
  const main = store('main', 'MAIN');
  const shop = store('shop', 'SELLING');
  const stores = [main, shop];

  it('keeps Filters open when the pointer is on a portaled Radix shop option', () => {
    expect(filtersStayOpen(false, portaledShopOption())).toBe(true);
  });

  it('still closes Filters on a true outside click (page background)', () => {
    expect(filtersStayOpen(false, {})).toBe(false);
  });

  it('keeps Filters open for a click that is actually inside the toolbar', () => {
    expect(filtersStayOpen(true, {})).toBe(true);
  });

  it('commits the shop id from Select onValueChange', () => {
    const seen: string[] = [];
    commitStoreLocationSelectValue('shop', (id) => seen.push(id));
    commitStoreLocationSelectValue('__pending__', (id) => seen.push(id));
    expect(seen).toEqual(['shop']);
  });

  it('does not let MAIN default overwrite a shop that was just picked', () => {
    expect(retainOrDefaultStockViewStoreId('shop', stores)).toBe('shop');
    expect(retainOrDefaultStockViewStoreId('', stores)).toBe('main');
    expect(retainOrDefaultStockViewStoreId('damage', stores)).toBe('main');
  });

  it('full path: shop option click inside Filters selects the shop, not MAIN', () => {
    const result = pickShopInsideFilters({
      stores,
      currentStoreId: 'main',
      shopId: 'shop',
      click: 'shop-option',
    });
    expect(result).toEqual({ filtersOpen: true, storeId: 'shop' });
  });

  it('full path: page click closes Filters and does not change store', () => {
    const result = pickShopInsideFilters({
      stores,
      currentStoreId: 'main',
      shopId: 'shop',
      click: 'page-background',
    });
    expect(result).toEqual({ filtersOpen: false, storeId: 'main' });
  });

  it('old dismiss (contains-only) would have dropped the shop pick', () => {
    const toolbar = { contains: () => false };
    const shopOption = portaledShopOption();
    const oldWouldClose = !toolbar.contains(shopOption);
    const nowStaysOpen = pointerEventStaysInsideOverlay(toolbar, { target: shopOption });
    expect(oldWouldClose).toBe(true);
    expect(nowStaysOpen).toBe(true);
  });
});

describe('stock view Filters shop select — page wiring', () => {
  it('Products and Stock Levels keep the picker in Filters and do not close() on store change', () => {
    const products = readFileSync(path.join(clientSrc, 'pages/inventory/ProductsPage.tsx'), 'utf8');
    const stock = readFileSync(path.join(clientSrc, 'pages/inventory/StockLevelsPage.tsx'), 'utf8');
    const toolbar = readFileSync(
      path.join(clientSrc, 'components/adaptive/AdaptiveToolbar.tsx'),
      'utf8',
    );

    const productsStoreBlock = products.slice(
      products.indexOf('id="filter-store-location-products"'),
      products.indexOf('id="filter-store-location-products"') + 420,
    );
    const stockStoreBlock = stock.slice(
      stock.indexOf('id="filter-store-location"'),
      stock.indexOf('id="filter-store-location"') + 420,
    );

    expect(products).toContain('data-products-filter-panel');
    expect(products).toContain('retainOrDefaultStockViewStoreId');
    expect(productsStoreBlock).toContain('onChange={setStoreFilterId}');
    expect(productsStoreBlock).not.toContain('close()');

    expect(stock).toContain('data-stock-filter-panel');
    expect(stock).toContain('retainOrDefaultStockViewStoreId');
    expect(stockStoreBlock).toContain('onChange={setStoreFilterId}');
    expect(stockStoreBlock).not.toContain('close()');

    expect(toolbar).toContain('pointerEventStaysInsideOverlay');
  });
});
