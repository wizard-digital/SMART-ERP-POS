/**
 * Canonical inventory report catalog — used by Inventory Reports hub and Reports module.
 * All report screens live under /reports/* (Reports module).
 */

export interface InventoryReportLink {
  id: string;
  title: string;
  description: string;
  path: string;
  icon: string;
  multistoreOnly?: boolean;
  restaurantOnly?: boolean;
  badge?: string;
}

/** Ledger-based inventory report suite */
export const INVENTORY_LEDGER_REPORTS: InventoryReportLink[] = [
  {
    id: 'valuation',
    title: 'Inventory Valuation',
    description: 'Book value from cost layers — product, qty, unit cost, stock value.',
    path: '/reports/inventory/valuation',
    icon: '💰',
    badge: 'Finance',
  },
  {
    id: 'reconciliation',
    title: 'Inventory Reconciliation',
    description: 'Subledger vs GL 1300 control account — drift detection.',
    path: '/reports/inventory/reconciliation',
    icon: '⚖️',
    badge: 'Accounting',
  },
  {
    id: 'analytics',
    title: 'Inventory Analytics',
    description: 'ABC classification, movement velocity, and dead-stock flags.',
    path: '/reports/inventory/analytics',
    icon: '📊',
    badge: 'Operations',
  },
  {
    id: 'margins',
    title: 'Price & Margin Analysis',
    description: 'Per-product margin %, markup %, and potential profit on current stock.',
    path: '/reports/inventory/margins',
    icon: '📈',
    badge: 'Commercial',
  },
  {
    id: 'store-issues',
    title: 'Store Issue Audit',
    description:
      'Posted warehouse issues and reversals — who posted, who reversed, reason, and reverse rate.',
    path: '/reports/inventory/store-issues',
    icon: '🧾',
    badge: 'Control',
    restaurantOnly: true,
  },
];

/** Multistore warehouse network reporting */
export const INVENTORY_NETWORK_REPORTS: InventoryReportLink[] = [
  {
    id: 'network',
    title: 'Store Network Reports',
    description:
      'Stock by location, transfer activity, expiry exposure, and quarantine balances.',
    path: '/reports/inventory/network',
    icon: '🏪',
    multistoreOnly: true,
    badge: 'Multistore',
  },
];

/** Operational inventory intelligence */
export const INVENTORY_OPERATIONAL_REPORTS: InventoryReportLink[] = [
  {
    id: 'reorder',
    title: 'Reorder Dashboard',
    description: 'AI-assisted reorder points, safety stock, and purchase suggestions.',
    path: '/reports/reorder',
    icon: '🔄',
    badge: 'Operations',
  },
  {
    id: 'category-intelligence',
    title: 'Category Intelligence',
    description:
      'Cross-dimensional analysis — sales, purchases, stock valuation, and expiry exposure.',
    path: '/reports/category-intelligence',
    icon: '🏷️',
    badge: 'Cross-Module',
  },
];

export const ALL_INVENTORY_REPORTS: InventoryReportLink[] = [
  ...INVENTORY_NETWORK_REPORTS,
  ...INVENTORY_LEDGER_REPORTS,
  ...INVENTORY_OPERATIONAL_REPORTS,
];

/** Hide restaurant-only reports (Store Issue Audit) when restaurant mode is off. */
export function visibleInventoryReports(
  reports: InventoryReportLink[],
  flags: { restaurantEnabled: boolean },
): InventoryReportLink[] {
  return reports.filter((report) => !report.restaurantOnly || flags.restaurantEnabled);
}
