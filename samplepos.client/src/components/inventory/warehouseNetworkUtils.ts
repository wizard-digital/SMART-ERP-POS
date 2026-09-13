import type { StoreLocation, StoreType } from '../../../../shared/types/warehouseNetwork';

export interface WarehouseNetworkTreeNode {
  store: StoreLocation;
  children: WarehouseNetworkTreeNode[];
}

const TYPE_ORDER: Record<StoreType, number> = {
  MAIN: 0,
  SELLING: 1,
  TRANSIT: 2,
  RETURN: 3,
  DAMAGE: 4,
  EXPIRED: 5,
};

const SPECIAL_STORE_TYPES = new Set<StoreType>(['TRANSIT', 'EXPIRED', 'DAMAGE', 'RETURN']);

/** MAIN warehouse and selling shops — the operational path warehouse → shops. Not quarantine. */
export function isOperationalNetworkStore(store: StoreLocation): boolean {
  return store.isActive && (store.storeType === 'MAIN' || store.storeType === 'SELLING');
}

/** Warehouse first, then shops — quantity filter options for Products / Stock Levels. */
export function operationalNetworkStores(
  stores: ReadonlyArray<StoreLocation>,
): StoreLocation[] {
  return stores
    .filter(isOperationalNetworkStore)
    .sort((a, b) => {
      const ta = TYPE_ORDER[a.storeType] ?? 99;
      const tb = TYPE_ORDER[b.storeType] ?? 99;
      if (ta !== tb) return ta - tb;
      return a.name.localeCompare(b.name);
    });
}

/**
 * Quantity views default to MAIN so operators walk warehouse → shops.
 * POS sellable qty is SELLING stores only — never treat MAIN qty as register stock.
 */
export function resolveDefaultStockViewStore(
  stores: ReadonlyArray<StoreLocation>,
): StoreLocation | undefined {
  const active = operationalNetworkStores(stores);
  return (
    active.find((s) => s.isDefaultReceiving)
    || active.find((s) => s.storeType === 'MAIN')
    || active.find((s) => s.storeType === 'SELLING' || s.isPosSelling)
    || active[0]
  );
}

/**
 * Keep the operator's warehouse/shop pick. Only default when empty or not in the network.
 * Prevents a later MAIN default from overwriting a shop click.
 */
export function retainOrDefaultStockViewStoreId(
  currentId: string,
  stores: ReadonlyArray<StoreLocation>,
): string {
  const network = operationalNetworkStores(stores);
  if (currentId && network.some((s) => s.id === currentId)) return currentId;
  return resolveDefaultStockViewStore(stores)?.id ?? currentId;
}

export function unwrapStockLevelRows(payload: unknown): Array<Record<string, unknown>> {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload as Array<Record<string, unknown>>;
  const record = payload as { data?: unknown };
  if (Array.isArray(record.data)) return record.data as Array<Record<string, unknown>>;
  if (record.data && typeof record.data === 'object') {
    const nested = record.data as { data?: unknown };
    if (Array.isArray(nested.data)) return nested.data as Array<Record<string, unknown>>;
  }
  return [];
}

export function stockQtyByProductId(payload: unknown): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of unwrapStockLevelRows(payload)) {
    const productId = row.product_id != null ? String(row.product_id) : '';
    if (!productId) continue;
    map.set(
      productId,
      parseFloat(String(row.total_stock ?? row.total_quantity ?? 0)) || 0,
    );
  }
  return map;
}

/** Special stores with no on-hand qty are hidden from the network map (they still exist in DB). */
export function filterSpecialStoresWithStock(
  stores: StoreLocation[],
  qtyByStoreId: ReadonlyMap<string, number>,
): StoreLocation[] {
  return stores.filter((store) => {
    const qty = qtyByStoreId.get(store.id) ?? 0;
    return qty > 0.001;
  });
}

export interface StoreNetworkSections {
  /** MAIN warehouse with selling shops nested underneath. */
  warehouseRoots: WarehouseNetworkTreeNode[];
  /** Transit, expired, damage, return — not nested under MAIN. */
  specialStores: StoreLocation[];
}

function sortStores(a: StoreLocation, b: StoreLocation): number {
  const ta = TYPE_ORDER[a.storeType] ?? 99;
  const tb = TYPE_ORDER[b.storeType] ?? 99;
  if (ta !== tb) return ta - tb;
  return a.name.localeCompare(b.name);
}

/**
 * Builds a MAIN-rooted hierarchy for the network map.
 * Stores without parent_store_id attach under MAIN by convention.
 */
export function buildWarehouseNetworkTree(stores: StoreLocation[]): WarehouseNetworkTreeNode[] {
  const active = stores.filter((s) => s.isActive);
  if (active.length === 0) return [];

  const main = active.find((s) => s.storeType === 'MAIN');
  const childrenByParent = new Map<string, StoreLocation[]>();

  for (const store of active) {
    if (store.storeType === 'MAIN') continue;
    const parentId = store.parentStoreId ?? (main ? main.id : null);
    if (!parentId) continue;
    const bucket = childrenByParent.get(parentId) ?? [];
    bucket.push(store);
    childrenByParent.set(parentId, bucket);
  }

  const buildNode = (store: StoreLocation): WarehouseNetworkTreeNode => ({
    store,
    children: (childrenByParent.get(store.id) ?? [])
      .sort(sortStores)
      .map(buildNode),
  });

  if (main) {
    return [buildNode(main)];
  }

  const roots = active.filter((s) => !s.parentStoreId).sort(sortStores);
  return roots.map(buildNode);
}

/**
 * Splits the network into operational warehouse tree vs special-purpose stores.
 */
export function buildStoreNetworkSections(stores: StoreLocation[]): StoreNetworkSections {
  const active = stores.filter((s) => s.isActive);
  const main = active.find((s) => s.storeType === 'MAIN');

  const sellingUnderMain: StoreLocation[] = [];
  const specialStores: StoreLocation[] = [];

  for (const store of active) {
    if (SPECIAL_STORE_TYPES.has(store.storeType)) {
      specialStores.push(store);
      continue;
    }
    if (store.storeType === 'SELLING') {
      sellingUnderMain.push(store);
    }
  }

  sellingUnderMain.sort(sortStores);
  specialStores.sort(sortStores);

  const warehouseRoots: WarehouseNetworkTreeNode[] = main
    ? [
        {
          store: main,
          children: sellingUnderMain.map((shop) => ({ store: shop, children: [] })),
        },
      ]
    : buildWarehouseNetworkTree(active);

  return { warehouseRoots, specialStores };
}
