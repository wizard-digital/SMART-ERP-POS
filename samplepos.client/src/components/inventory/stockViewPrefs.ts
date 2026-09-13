export type StockViewMode = 'company' | 'store';

const STOCK_VIEW_MODE_KEY = 'inventory.stockViewMode';
const STOCK_VIEW_STORE_KEY = 'inventory.stockViewStoreId';

export function readStockViewMode(): StockViewMode {
  try {
    const v = localStorage.getItem(STOCK_VIEW_MODE_KEY);
    return v === 'store' ? 'store' : 'company';
  } catch {
    return 'company';
  }
}

export function writeStockViewMode(mode: StockViewMode): void {
  try {
    localStorage.setItem(STOCK_VIEW_MODE_KEY, mode);
  } catch {
    /* ignore */
  }
}

export function readStockViewStoreId(): string {
  try {
    return localStorage.getItem(STOCK_VIEW_STORE_KEY) || '';
  } catch {
    return '';
  }
}

export function writeStockViewStoreId(id: string): void {
  try {
    if (id) localStorage.setItem(STOCK_VIEW_STORE_KEY, id);
    else localStorage.removeItem(STOCK_VIEW_STORE_KEY);
  } catch {
    /* ignore */
  }
}
