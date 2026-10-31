/**
 * Primary Inventory workspace navigation (Phase 1 — Store Network).
 * Multistore-only entries are flagged; InventoryLayout hides them when disabled.
 */

import {
  hasStockRequestAccess,
  hasTransferApprovalAccess,
  hasWarehouseNetworkAccess,
  WAREHOUSE_NETWORK_READ_PERMISSIONS,
} from '@shared/utils/warehouseRbac';
import { TRANSFER_PERMISSION_KEYS } from '@shared/types/transferWorkflow';
import { legacyRoleGrantsPermission } from '@shared/authorization/legacyRoleFallback';

export type InventoryMoreNavGroup = 'master' | 'procurement' | 'operations' | 'audit';

export interface InventoryNavItem {
  id: string;
  label: string;
  path: string;
  icon: string;
  multistoreOnly?: boolean;
  description?: string;
  group?: InventoryMoreNavGroup;
  matchPrefix?: string;
  /** When set, tab is hidden unless the user holds any of these RBAC keys. */
  requiredPermissions?: readonly string[];
  /** Kitchen/store-issue family — hidden unless restaurant_mode_enabled. */
  restaurantOnly?: boolean;
}

export const INVENTORY_MORE_GROUP_LABELS: Record<InventoryMoreNavGroup, string> = {
  master: 'Master data',
  procurement: 'Procurement',
  operations: 'Operations',
  audit: 'Audit & reports',
};

/** Routes that belong to the Store Network section (sub-nav + primary tab highlight). */
export const STORE_NETWORK_ROUTE_PREFIXES = [
  '/inventory/store-network',
  '/inventory/stores/',
  '/inventory/store-transfers',
  '/inventory/stock-counts',
  '/inventory/transfer-approvals',
  '/inventory/quarantine',
] as const;

/** Core operational tabs — single-store and multistore. */
export const INVENTORY_PRIMARY_NAV: InventoryNavItem[] = [
  { id: 'dashboard', label: 'Dashboard', path: '/inventory', icon: '📊' },
  { id: 'products', label: 'Products', path: '/inventory/products', icon: '🏷️' },
  { id: 'stock', label: 'Stock', path: '/inventory/stock-levels', icon: '📦' },
  {
    id: 'goods-receipts',
    label: 'Goods Receipts',
    path: '/inventory/goods-receipts',
    icon: '📥',
    description: 'Receive stock and attend supplier returns from one desk',
  },
  {
    id: 'purchase-orders',
    label: 'Purchase Orders',
    path: '/inventory/purchase-orders',
    icon: '📝',
  },
  { id: 'adjustments', label: 'Adjustments', path: '/inventory/adjustments', icon: '⚖️' },
  {
    id: 'store-network',
    label: 'Store Network',
    path: '/inventory/store-network/stores',
    icon: '🏪',
    multistoreOnly: true,
    requiredPermissions: WAREHOUSE_NETWORK_READ_PERMISSIONS,
  },
];

/** Secondary tools — overflow menu (More ▾). */
export const INVENTORY_MORE_NAV: InventoryNavItem[] = [
  {
    id: 'uoms',
    label: 'Units of Measure',
    path: '/inventory/uoms',
    icon: '📐',
    group: 'master',
    description: 'Define BOX, PCS, and conversion factors for MUoM products',
  },
  {
    id: 'batches',
    label: 'Batch Management',
    path: '/inventory/batches',
    icon: '🧪',
    group: 'operations',
    description: 'Lot numbers, expiry dates, and FEFO batch traceability',
  },
  {
    id: 'quarantine',
    label: 'Quarantine',
    path: '/inventory/quarantine',
    icon: '🚧',
    group: 'operations',
    description:
      'Expired / damaged quarantine aging (soft or hard) — still on inventory until dispose',
  },
  {
    id: 'store-issue',
    label: 'Store Issue',
    path: '/kitchen/store-issues',
    icon: '📤',
    group: 'operations',
    description: 'Issue store goods to kitchen/bar expense without a recipe (account 5150)',
    restaurantOnly: true,
    requiredPermissions: [
      'kitchen.production.read',
      'kitchen.production.create',
      'kitchen.production.post',
      'inventory.adjust',
    ],
  },
  {
    id: 'stock-movements',
    label: 'Movement History',
    path: '/inventory/stock-movements',
    icon: '📋',
    group: 'audit',
    description: 'Full stock ledger — sales, GRNs, adjustments, transfers',
  },
  {
    id: 'barcode-lookup',
    label: 'Barcode Lookup',
    path: '/inventory/barcode-lookup',
    icon: '📡',
    group: 'audit',
    description: 'Scan or search barcodes to find products quickly',
  },
  {
    id: 'reports',
    label: 'Inventory Reports',
    path: '/reports',
    icon: '📊',
    group: 'audit',
    matchPrefix: '/reports',
    description: 'Valuation, reconciliation, margins, and store network KPIs',
  },
];

/** Sub-navigation inside Store Network (multistore ON only). */
export const STORE_NETWORK_NAV: InventoryNavItem[] = [
  {
    id: 'stores',
    label: 'Stores',
    path: '/inventory/store-network/stores',
    icon: '🏪',
    requiredPermissions: WAREHOUSE_NETWORK_READ_PERMISSIONS,
  },
  {
    id: 'assortment',
    label: 'Assortment',
    path: '/inventory/store-network/assortment',
    icon: '🧩',
    requiredPermissions: ['inventory.manage', TRANSFER_PERMISSION_KEYS.LEGACY_APPROVE],
  },
  {
    id: 'transfers',
    label: 'Transfers',
    path: '/inventory/store-transfers',
    icon: '🚚',
    requiredPermissions: [
      TRANSFER_PERMISSION_KEYS.REQUEST,
      TRANSFER_PERMISSION_KEYS.DIRECT,
      TRANSFER_PERMISSION_KEYS.OVERRIDE,
      TRANSFER_PERMISSION_KEYS.LEGACY_APPROVE,
    ],
  },
  {
    id: 'stock-counts',
    label: 'Stock Counts',
    path: '/inventory/stock-counts',
    icon: '🔢',
    requiredPermissions: WAREHOUSE_NETWORK_READ_PERMISSIONS,
  },
  {
    id: 'quarantine',
    label: 'Quarantine',
    path: '/inventory/quarantine',
    icon: '🚧',
    requiredPermissions: WAREHOUSE_NETWORK_READ_PERMISSIONS,
  },
  {
    id: 'transfer-approvals',
    label: 'Approvals',
    path: '/inventory/transfer-approvals',
    icon: '✅',
    requiredPermissions: [
      TRANSFER_PERMISSION_KEYS.APPROVE,
      TRANSFER_PERMISSION_KEYS.DISPATCH,
      TRANSFER_PERMISSION_KEYS.RECEIVE,
      TRANSFER_PERMISSION_KEYS.LEGACY_APPROVE,
    ],
  },
  {
    id: 'locations',
    label: 'Locations',
    path: '/inventory/store-network/locations',
    icon: '📍',
    requiredPermissions: WAREHOUSE_NETWORK_READ_PERMISSIONS,
  },
  {
    id: 'settings',
    label: 'Settings',
    path: '/inventory/store-network/settings',
    icon: '⚙️',
    requiredPermissions: ['settings.update', TRANSFER_PERMISSION_KEYS.LEGACY_APPROVE],
  },
];

export function isStoreNetworkSectionPath(pathname: string): boolean {
  return STORE_NETWORK_ROUTE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`) || pathname.startsWith(prefix),
  );
}

export function isInventoryNavActive(pathname: string, path: string): boolean {
  if (path === '/inventory') {
    return pathname === '/inventory';
  }
  if (path === '/inventory/stock-levels') {
    return pathname === '/inventory/stock-levels';
  }
  // Receiving workbench: highlight Goods Receipts for receipts + returns sub-routes
  if (path === '/inventory/goods-receipts') {
    return (
      pathname === '/inventory/goods-receipts' ||
      pathname.startsWith('/inventory/goods-receipts/')
    );
  }
  if (path.startsWith('/inventory/store-network')) {
    return isStoreNetworkSectionPath(pathname);
  }
  return pathname === path || pathname.startsWith(`${path}/`);
}

export function isStoreNetworkNavActive(pathname: string, path: string): boolean {
  if (path === '/inventory/store-network/stores') {
    return (
      pathname === '/inventory/store-network/stores' ||
      pathname.startsWith('/inventory/stores/') ||
      pathname === '/inventory/store-network'
    );
  }
  return pathname === path || pathname.startsWith(`${path}/`);
}

export function isInventoryMoreNavActive(pathname: string, tab: InventoryNavItem): boolean {
  if (tab.matchPrefix) {
    return pathname.startsWith(tab.matchPrefix);
  }
  return isInventoryNavActive(pathname, tab.path);
}

export function groupInventoryMoreNav(tabs: InventoryNavItem[]): Array<{
  group: InventoryMoreNavGroup;
  label: string;
  items: InventoryNavItem[];
}> {
  const order: InventoryMoreNavGroup[] = ['master', 'procurement', 'operations', 'audit'];
  return order
    .map((group) => ({
      group,
      label: INVENTORY_MORE_GROUP_LABELS[group],
      items: tabs.filter((t) => t.group === group),
    }))
    .filter((section) => section.items.length > 0);
}

function canSeeNavItem(
  tab: InventoryNavItem,
  permissions: Set<string>,
  userRole?: string,
): boolean {
  if (!tab.requiredPermissions?.length) return true;
  const useLegacy = permissions.size === 0;
  return tab.requiredPermissions.some(
    (key) => permissions.has(key) || (useLegacy && legacyRoleGrantsPermission(userRole, key)),
  );
}

/** Filter nav items by RBAC permission keys (manager/admin legacy fallback). */
export function filterInventoryNavByPermissions(
  tabs: InventoryNavItem[],
  permissions: Set<string>,
  userRole?: string,
): InventoryNavItem[] {
  return tabs.filter((tab) => canSeeNavItem(tab, permissions, userRole));
}

/** Hide multistore / restaurant-only inventory tabs when those flags are off. */
export function filterInventoryNavByTenantFlags(
  tabs: InventoryNavItem[],
  flags: { isMultistoreEnabled: boolean; restaurantEnabled: boolean },
): InventoryNavItem[] {
  return tabs.filter((tab) => {
    if (tab.multistoreOnly && !flags.isMultistoreEnabled) return false;
    if (tab.restaurantOnly && !flags.restaurantEnabled) return false;
    return true;
  });
}

export {
  hasStockRequestAccess,
  hasTransferApprovalAccess,
  hasWarehouseNetworkAccess,
};
