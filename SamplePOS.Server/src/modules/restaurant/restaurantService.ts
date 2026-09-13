/**
 * Restaurant service — FOH workflow on top of pos_orders + createSale SSOT.
 * Never creates parallel sales, invoices, payments, or product catalogs.
 */

import type { Pool, PoolClient } from 'pg';
import Decimal from 'decimal.js';
import { UnitOfWork } from '../../db/unitOfWork.js';
import { tableHasColumn } from '../../db/schemaColumnCache.js';
import { BusinessError, ForbiddenError, NotFoundError, ValidationError } from '../../middleware/errorHandler.js';
import { Money } from '../../utils/money.js';
import { normalizeProductIdForDb } from '../../utils/productIdBoundary.js';
import { resolveSaleItemUom } from '../products/uomService.js';
import { ordersRepository, type CreateOrderItemData } from '../orders/ordersRepository.js';
import { ordersService, type OrderItemInput } from '../orders/ordersService.js';
import logger from '../../utils/logger.js';
import { DocumentTaxService } from '../../services/documentTaxService.js';
import { isRestaurantModeEnabled } from './restaurantSettings.js';
import { publishNotificationEvent } from '../notifications/notificationPublisher.js';
import {
  restaurantRepository,
  type OrderChannel,
  type RestaurantTableRecord,
  type KotRecord,
  type RestaurantMenuProduct,
  type RestaurantCategory,
  type KotTicketStatus,
  type RestaurantStationRecord,
} from './restaurantRepository.js';
import { recipeRepository } from './recipeRepository.js';
import { orderTagRepository } from './orderTagRepository.js';
import {
  formatOrderTagsAsLineNotes,
  sumOrderTagPrices,
  type RestaurantOrderTagSelection,
} from '../../../../shared/utils/restaurantOrderTags.js';
import { consolidateKotLines } from '../../../../shared/utils/consolidateKotLines.js';
import {
  canAccessRestaurantServiceLane,
  canEditOtherWaitersChecks,
  canMutateRestaurantCheck,
  canVoidKitchenSentRestaurantItems,
  isSharedRestaurantServiceCounter,
  isTableVisibleToWaiter,
  RESTAURANT_CHECK_OWNED_MESSAGE,
  RESTAURANT_SERVICE_LANE_RESTRICTED_MESSAGE,
  RESTAURANT_VOID_SENT_RESTRICTED_MESSAGE,
  type OwnershipActor,
} from '../../../../shared/utils/restaurantCheckOwnership.js';
import { resolveClosedCheckAddRetry } from '../../../../shared/utils/restaurantClosedCheckAdd.js';
import { isMultistoreEnabled } from '../inventory/warehouse/multistoreSettings.js';
import { posProductSearchService } from '../inventory/warehouse/posProductSearchService.js';
import { printJobsService } from '../print-jobs/printJobsService.js';
import type { PrintJobRecord } from '../print-jobs/printJobTypes.js';
import { systemSettingsService } from '../system-settings/systemSettingsService.js';

async function lookupUserDisplayName(client: PoolClient, userId: string): Promise<string | null> {
  const row = await client.query<{ full_name: string | null }>(
    `SELECT full_name FROM users WHERE id = $1`,
    [userId],
  );
  return row.rows[0]?.full_name?.trim() || null;
}

function applyKotActorNames(
  kot: KotRecord,
  firedByName: string | null,
  checkWaiterName: string | null | undefined,
): void {
  kot.firedByName = firedByName;
  if (checkWaiterName && checkWaiterName !== firedByName) {
    kot.serverName = checkWaiterName;
  }
}

/** Structured print payload — client renders HTML; agent receives silent job. */
function kotToPrintPayload(
  kot: KotRecord,
  meta: {
    orderChannel?: string | null;
    guestName?: string | null;
    guestPhone?: string | null;
    deliveryAddress?: string | null;
    pickupLabel?: string | null;
  },
): Record<string, unknown> {
  return {
    kotNumber: kot.kotNumber,
    station: kot.station,
    tableLabel: kot.tableName || kot.tableCode || 'Table',
    tableCode: kot.tableCode,
    tableName: kot.tableName,
    sentByName: kot.firedByName || kot.waiterName || null,
    serverName: kot.serverName || null,
    waiterName: kot.firedByName || kot.waiterName || null,
    firedAt: kot.firedAt,
    ticketKind: kot.ticketKind || 'FIRE',
    voidReason: kot.voidReason || null,
    orderChannel: meta.orderChannel ?? null,
    guestName: meta.guestName ?? null,
    guestPhone: meta.guestPhone ?? null,
    deliveryAddress: meta.deliveryAddress ?? null,
    pickupLabel: meta.pickupLabel ?? null,
    items: (kot.items || []).map((it) => ({
      productName: it.productName,
      quantity: Number(it.quantity),
      lineNotes: it.lineNotes ?? null,
    })),
  };
}

function requireCheckMutationAccess(
  checkWaiterId: string | null | undefined,
  actor: OwnershipActor | undefined,
  opts?: { sharedServiceCounter?: boolean },
): void {
  if (!actor) return;
  if (opts?.sharedServiceCounter && !canAccessRestaurantServiceLane(actor)) {
    throw new ForbiddenError(RESTAURANT_SERVICE_LANE_RESTRICTED_MESSAGE);
  }
  if (
    canMutateRestaurantCheck({
      checkWaiterId,
      actor,
      sharedServiceCounter: opts?.sharedServiceCounter,
    })
  ) {
    return;
  }
  throw new ForbiddenError(
    opts?.sharedServiceCounter
      ? RESTAURANT_SERVICE_LANE_RESTRICTED_MESSAGE
      : RESTAURANT_CHECK_OWNED_MESSAGE,
  );
}

function tableIsSharedServiceCounter(table: {
  code: string;
  zone: string;
}): boolean {
  return isSharedRestaurantServiceCounter({
    tableCode: table.code,
    tableZone: table.zone,
  });
}

async function requireOrderMutationAccess(
  conn: Pool | PoolClient,
  meta: { waiterId?: string | null; tableId?: string | null } | null | undefined,
  actor: OwnershipActor | undefined,
): Promise<void> {
  if (!actor) return;
  let shared = false;
  if (meta?.tableId) {
    const table = await restaurantRepository.getTableById(conn, meta.tableId);
    if (table) shared = tableIsSharedServiceCounter(table);
  }
  requireCheckMutationAccess(meta?.waiterId, actor, { sharedServiceCounter: shared });
}

/** Samba/Toast: same product + same notes → one KOT qty line (prices never enter KOT). */
function toConsolidatedKotItems(
  items: Array<{
    id: string;
    productId?: string | null;
    productName: string;
    quantity: number | string;
    lineNotes?: string | null;
  }>,
): Array<{
  orderItemId: string;
  productName: string;
  quantity: number;
  lineNotes: string | null;
}> {
  return consolidateKotLines(
    items.map((it) => ({
      productId: it.productId ?? null,
      productName: it.productName,
      quantity: it.quantity,
      lineNotes: it.lineNotes ?? null,
      orderItemId: it.id,
    })),
  ).map((c) => ({
    orderItemId: c.orderItemId || c.sourceIds[0] || items[0]!.id,
    productName: c.productName,
    quantity: c.quantity,
    lineNotes: c.lineNotes,
  }));
}

async function resolveRestaurantShopStoreId(pool: Pool | PoolClient): Promise<string | null> {
  if (!(await isMultistoreEnabled(pool))) return null;
  const storeId = await posProductSearchService.resolveActiveSellingStoreId(pool);
  if (!storeId) {
    throw new BusinessError(
      'Multistore restaurant requires an active shop/selling store (not MAIN warehouse).',
      'ERR_STORE_001',
    );
  }
  return storeId;
}

const KOT_STATUS_FLOW: Record<KotTicketStatus, KotTicketStatus | null> = {
  SENT: 'PREPARING',
  PREPARING: 'READY',
  READY: 'BUMPED',
  BUMPED: null,
};

async function assertRestaurantEnabled(pool: Pool | PoolClient): Promise<void> {
  if (!(await isRestaurantModeEnabled(pool))) {
    throw new ForbiddenError(
      'Restaurant mode is disabled. Enable restaurant_mode_enabled in system settings.',
    );
  }
}

function channelForTable(table: RestaurantTableRecord): OrderChannel {
  const code = table.code.toUpperCase();
  if (code === 'TA' || (table.zone === 'SERVICE' && /take\s*away/i.test(table.name))) {
    return 'TAKEAWAY';
  }
  if (code === 'DL' || /delivery/i.test(table.name)) {
    return 'DELIVERY';
  }
  return 'DINE_IN';
}

/**
 * Restaurant tax via DocumentTaxService (tenant-default fallback preserves prior flat rate).
 * Server is authoritative — do not trust client taxAmount.
 */
async function computeRestaurantDocumentTax(
  conn: Pool | PoolClient,
  items: Array<{
    productId?: string | null;
    quantity: string | number;
    unitPrice: string | number;
    discountAmount?: string | number | null;
  }>,
  customerId?: string | null,
): Promise<Decimal> {
  const result = await DocumentTaxService.computeForLines(conn, {
    customerId: customerId ?? null,
    scope: 'SALE',
    applyTenantDefaultWhenUnresolved: true,
    lines: items.map((it, lineIndex) => {
      const lineNet = Money.parseDb(String(it.quantity))
        .times(Money.parseDb(String(it.unitPrice)))
        .minus(Money.parseDb(String(it.discountAmount || 0)));
      return {
        lineIndex,
        productId: it.productId ?? null,
        lineNetAmount: Money.toNumber(Money.round(lineNet, 2)),
        quantity: Number(it.quantity) || 0,
      };
    }),
  });
  return new Decimal(result.documentTotals.totalTax);
}

function recalcFromItems(
  items: Array<{ quantity: string | number; unitPrice: string | number; discountAmount?: string | number }>,
  taxAmount: Decimal,
): { subtotal: number; discountAmount: number; taxAmount: number; totalAmount: number } {
  let subtotal = new Decimal(0);
  let discount = new Decimal(0);
  for (const item of items) {
    const qty = Money.parseDb(String(item.quantity));
    const price = Money.parseDb(String(item.unitPrice));
    const disc = Money.parseDb(String(item.discountAmount || 0));
    subtotal = subtotal.plus(qty.times(price));
    discount = discount.plus(disc);
  }
  const total = subtotal.minus(discount).plus(taxAmount);
  return {
    subtotal: Money.toNumber(Money.round(subtotal, 2)),
    discountAmount: Money.toNumber(Money.round(discount, 2)),
    taxAmount: Money.toNumber(Money.round(taxAmount, 2)),
    totalAmount: Money.toNumber(Money.round(total.lessThan(0) ? new Decimal(0) : total, 2)),
  };
}

export interface RestaurantOrderItemInput {
  productId: string;
  productName?: string;
  quantity: number;
  unitPrice?: number;
  discountAmount?: number;
  lineNotes?: string | null;
  /** Samba-style structured tags — denormalized into lineNotes for KOT. */
  orderTags?: RestaurantOrderTagSelection[] | null;
  uomId?: string | null;
}

function resolveItemNotesAndPrice(item: RestaurantOrderItemInput): {
  lineNotes: string | null;
  orderTags: RestaurantOrderTagSelection[];
  priceDelta: number;
} {
  const orderTags = (item.orderTags || [])
    .map((t) => ({
      id: t.id ?? null,
      label: String(t.label || '').trim(),
      prefix: t.prefix ?? null,
      price: Number(t.price) || 0,
    }))
    .filter((t) => t.label);
  const fromTags = formatOrderTagsAsLineNotes(orderTags, null);
  const free = String(item.lineNotes || '').trim();
  // If client already sent formatted notes and no structured tags, keep notes.
  const lineNotes =
    orderTags.length > 0
      ? formatOrderTagsAsLineNotes(orderTags, free && free !== fromTags ? free : null)
      : free || null;
  return {
    lineNotes,
    orderTags,
    priceDelta: sumOrderTagPrices(orderTags),
  };
}

export interface RestaurantGuestDetails {
  guestName?: string | null;
  guestPhone?: string | null;
  deliveryAddress?: string | null;
  pickupLabel?: string | null;
}

/**
 * Guest / customer details are optional for takeaway & delivery (walk-up / unnamed).
 * Kept as a named hook for channel-specific validation if stricter rules return later.
 */
function assertChannelGuest(
  _channel: OrderChannel,
  _guest: RestaurantGuestDetails | undefined,
): void {
  // Optional by design — do not require name/address to open or ring a service check.
}

export const restaurantService = {
  async isEnabled(pool: Pool): Promise<boolean> {
    return isRestaurantModeEnabled(pool);
  },

  /**
   * True when the order is a restaurant FOH check (table and/or non-RETAIL channel).
   * Used so settlement requires restaurant.pay instead of orders.pay alone.
   */
  async isRestaurantCheck(pool: Pool, orderId: string): Promise<boolean> {
    if (!(await isRestaurantModeEnabled(pool))) return false;
    const meta = await restaurantRepository.getOrderRestaurantMeta(pool, orderId);
    if (!meta) return false;
    if (meta.tableId) return true;
    return meta.orderChannel != null && meta.orderChannel !== 'RETAIL';
  },

  async listTables(
    pool: Pool,
    includeInactive = false,
    actor?: OwnershipActor,
  ): Promise<RestaurantTableRecord[]> {
    await assertRestaurantEnabled(pool);
    const tables = await restaurantRepository.listTables(pool, includeInactive);
    if (!actor || canEditOtherWaitersChecks(actor)) return tables;

    const owned = await pool.query<{ table_id: string }>(
      `SELECT DISTINCT table_id
       FROM pos_orders
       WHERE status = 'PENDING'
         AND waiter_id = $1
         AND table_id IS NOT NULL
         AND order_channel IS DISTINCT FROM 'RETAIL'`,
      [actor.userId],
    );
    const ownedSet = new Set(owned.rows.map((r) => r.table_id));

    return tables.filter((t) =>
      isTableVisibleToWaiter({
        tableStatus: t.status,
        checkWaiterId: t.waiterId,
        actorOwnsAnyCheckOnTable: ownedSet.has(t.id),
        sharedServiceCounter: tableIsSharedServiceCounter(t),
        actor,
      }),
    );
  },

  async listAssignableWaiters(pool: Pool) {
    await assertRestaurantEnabled(pool);
    return restaurantRepository.listAssignableWaiters(pool);
  },

  async assignWaiter(
    pool: Pool,
    orderId: string,
    waiterId: string,
    actor?: OwnershipActor,
  ) {
    await assertRestaurantEnabled(pool);
    const meta = await restaurantRepository.getOrderRestaurantMeta(pool, orderId);
    if (!meta || meta.orderChannel === 'RETAIL') {
      throw new BusinessError('Not a restaurant check', 'ERR_RESTAURANT_CHANNEL');
    }
    await requireOrderMutationAccess(pool, meta, actor);

    const order = await ordersService.getOrder(pool, orderId);
    if (order.status !== 'PENDING') {
      throw new BusinessError('Only open checks can change waiter', 'ERR_RESTAURANT_CHECK_CLOSED');
    }

    // Only edit-others (manager/cashier) may hand a check to a different waiter.
    if (actor && !canEditOtherWaitersChecks(actor) && waiterId !== actor.userId) {
      throw new ForbiddenError(
        'Only a manager or cashier can reassign this check to another waiter',
      );
    }

    const waiters = await restaurantRepository.listAssignableWaiters(pool);
    const target = waiters.find((w) => w.id === waiterId);
    if (!target) {
      throw new ValidationError('Selected user is not an assignable waiter');
    }

    await restaurantRepository.patchOrderRestaurantFields(pool, orderId, { waiterId });

    return {
      order: await ordersService.getOrder(pool, orderId),
      meta: await restaurantRepository.getOrderRestaurantMeta(pool, orderId),
    };
  },

  async createTable(
    pool: Pool,
    data: { code: string; name: string; zone?: string; seats?: number; sortOrder?: number },
  ): Promise<RestaurantTableRecord> {
    await assertRestaurantEnabled(pool);
    if (!data.code?.trim() || !data.name?.trim()) {
      throw new ValidationError('Table code and name are required');
    }
    return restaurantRepository.createTable(pool, data);
  },

  /**
   * Ensure Takeaway / Delivery / Quick service lanes exist.
   * Cashiers (restaurant.pay) and managers (restaurant.manage) only — not floor waiters.
   * Idempotent: returns existing rows when already present.
   */
  async ensureServiceLanes(pool: Pool): Promise<RestaurantTableRecord[]> {
    await assertRestaurantEnabled(pool);
    const defs = [
      { code: 'TA', name: 'Takeaway', zone: 'SERVICE', seats: 0, sortOrder: 9001 },
      { code: 'DL', name: 'Delivery', zone: 'SERVICE', seats: 0, sortOrder: 9002 },
      { code: 'QK', name: 'Quick order', zone: 'SERVICE', seats: 0, sortOrder: 9003 },
    ] as const;

    const out: RestaurantTableRecord[] = [];
    for (const def of defs) {
      const existing = await restaurantRepository.getTableByCode(pool, def.code);
      if (existing && existing.isActive !== false) {
        out.push(existing);
        continue;
      }
      if (existing && existing.isActive === false) {
        const revived = await restaurantRepository.updateTable(pool, existing.id, {
          isActive: true,
          name: def.name,
          zone: def.zone,
        });
        if (revived) {
          out.push(revived);
          continue;
        }
      }
      out.push(await restaurantRepository.createTable(pool, { ...def }));
    }
    return out;
  },

  async updateTable(
    pool: Pool,
    id: string,
    data: Partial<{
      code: string;
      name: string;
      zone: string;
      seats: number;
      sortOrder: number;
      isActive: boolean;
    }>,
  ): Promise<RestaurantTableRecord> {
    await assertRestaurantEnabled(pool);
    const updated = await restaurantRepository.updateTable(pool, id, data);
    if (!updated) throw new NotFoundError('Restaurant table');
    return updated;
  },

  async listMenuCategories(pool: Pool): Promise<RestaurantCategory[]> {
    await assertRestaurantEnabled(pool);
    const sellingStoreId = await resolveRestaurantShopStoreId(pool);
    return restaurantRepository.listMenuCategories(pool, { sellingStoreId });
  },

  async listMenuProducts(
    pool: Pool,
    filters?: { categoryId?: string | null },
  ): Promise<RestaurantMenuProduct[]> {
    await assertRestaurantEnabled(pool);
    const sellingStoreId = await resolveRestaurantShopStoreId(pool);
    return restaurantRepository.listMenuProducts(pool, {
      ...filters,
      sellingStoreId,
    });
  },

  async setProductFlags(
    pool: Pool,
    productId: string,
    data: { availableInRestaurant?: boolean; kitchenStation?: string | null },
  ): Promise<RestaurantMenuProduct> {
    await assertRestaurantEnabled(pool);
    const updated = await restaurantRepository.setProductRestaurantFlags(pool, productId, data);
    if (!updated) throw new NotFoundError('Product');
    return updated;
  },

  /**
   * Open or resume the pending check for a table.
   * Does not create an empty order — returns table + existing order if any.
   */
  async getTableCheck(
    pool: Pool,
    tableId: string,
    activeOrderId?: string | null,
    actor?: OwnershipActor,
  ) {
    await assertRestaurantEnabled(pool);
    const table = await restaurantRepository.getTableById(pool, tableId);
    if (!table || !table.isActive) throw new NotFoundError('Restaurant table');

    const siblings = await restaurantRepository.listPendingOrdersForTable(pool, tableId);
    const sharedCounter = tableIsSharedServiceCounter(table);
    // TA / DL / QK — cashiers & managers only (not floor waiters).
    if (sharedCounter && actor && !canAccessRestaurantServiceLane(actor)) {
      throw new ForbiddenError(RESTAURANT_SERVICE_LANE_RESTRICTED_MESSAGE);
    }
    // Shared counters: multi-ticket open to counter staff; ownership not waiter-scoped.
    const scopedSiblings =
      !sharedCounter && actor && !canEditOtherWaitersChecks(actor)
        ? siblings.filter((s) => !s.waiterId || s.waiterId === actor.userId)
        : siblings;

    // Defense: ignore client temp/journal ids (tmp_ord_*, ofl_*) — never query UUID columns with them.
    const ORDER_UUID_RE =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const safeActive =
      activeOrderId && ORDER_UUID_RE.test(activeOrderId) ? activeOrderId : null;
    const sameUuid = (a: string | null | undefined, b: string | null | undefined) =>
      !!a && !!b && a.toLowerCase() === b.toLowerCase();
    const isPendingOnThisTable = (id: string | null | undefined) =>
      !!id && siblings.some((s) => sameUuid(s.id, id));

    let orderId: string | null = safeActive || table.currentOrderId || null;

    // Never load a PENDING check from another table (or closed id). That used to seed the
    // FOH journal under the wrong tableId → multi-ticket strip ghosts → activate-check 400.
    if (orderId && !isPendingOnThisTable(orderId)) {
      if (safeActive && sameUuid(safeActive, orderId)) {
        // Explicit wrong id — drop to an open sibling (if any), do not fetch foreign order.
        orderId =
          (table.currentOrderId && isPendingOnThisTable(table.currentOrderId)
            ? table.currentOrderId
            : null) ||
          scopedSiblings[0]?.id ||
          siblings[0]?.id ||
          null;
      } else if (siblings.length > 0) {
        // Stale floor pointer — prefer owned when scoped.
        orderId =
          (table.currentOrderId && isPendingOnThisTable(table.currentOrderId)
            ? table.currentOrderId
            : null) ||
          scopedSiblings[0]?.id ||
          siblings[0]?.id ||
          null;
      } else {
        orderId = null;
      }
    }

    // Toast/Aloha: waiters may only open their own dining checks (FREE tables are fine).
    // Ownership runs before any floor-pointer write so a 403 cannot re-point the table.
    if (
      !sharedCounter &&
      actor &&
      !canEditOtherWaitersChecks(actor) &&
      siblings.length > 0
    ) {
      if (scopedSiblings.length === 0) {
        throw new ForbiddenError(RESTAURANT_CHECK_OWNED_MESSAGE);
      }
      const pointed = orderId ? siblings.find((s) => sameUuid(s.id, orderId)) : null;
      if (pointed?.waiterId && pointed.waiterId !== actor.userId) {
        orderId = scopedSiblings[0]!.id;
      } else if (!orderId) {
        orderId = scopedSiblings[0]!.id;
      }
      const target = siblings.find((s) => sameUuid(s.id, orderId));
      if (target?.waiterId && target.waiterId !== actor.userId) {
        throw new ForbiddenError(RESTAURANT_CHECK_OWNED_MESSAGE);
      }
    } else if (!orderId && siblings.length > 0) {
      orderId = siblings[0]!.id;
    }

    // Heal floor pointer only after the actor is allowed to open the chosen check.
    if (orderId && !sameUuid(table.currentOrderId, orderId) && isPendingOnThisTable(orderId)) {
      await restaurantRepository.setTableCurrentOrder(pool, tableId, orderId);
    }

    let order = null;
    if (orderId) {
      try {
        order = await ordersService.getOrder(pool, orderId);
        if (order.status !== 'PENDING') {
          await restaurantRepository.releaseTableByOrderId(pool, orderId);
          order = null;
        }
      } catch {
        await restaurantRepository.releaseTableByOrderId(pool, orderId);
        order = null;
      }
    }

    const meta = order
      ? await restaurantRepository.getOrderRestaurantMeta(pool, order.id)
      : null;
    const voids = order
      ? await restaurantRepository.listVoidTicketsForOrder(pool, order.id)
      : [];

    return {
      table: await restaurantRepository.getTableById(pool, tableId),
      order,
      meta,
      siblingChecks: scopedSiblings,
      voids,
    };
  },

  async activateCheck(
    pool: Pool,
    tableId: string,
    orderId: string,
    actor?: OwnershipActor,
  ) {
    await assertRestaurantEnabled(pool);
    const table = await restaurantRepository.getTableById(pool, tableId);
    if (!table || !table.isActive) throw new NotFoundError('Restaurant table');
    const order = await ordersService.getOrder(pool, orderId);
    if (order.status !== 'PENDING') {
      // Stale FOH tab — free pointer if it still points at this closed check.
      if (table.currentOrderId === orderId) {
        const siblings = await restaurantRepository.listPendingOrdersForTable(pool, tableId);
        if (siblings[0]) {
          await restaurantRepository.setTableCurrentOrder(pool, tableId, siblings[0].id);
        } else {
          await restaurantRepository.releaseTableByOrderId(pool, orderId);
        }
      }
      throw new BusinessError('Only open checks can be activated', 'ERR_RESTAURANT_CHECK_CLOSED');
    }
    let meta = await restaurantRepository.getOrderRestaurantMeta(pool, orderId);
    const sameUuid = (a: string | null | undefined, b: string | null | undefined) =>
      !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();

    // Heal orphan header: PENDING restaurant check with null table_id while open on floor,
    // or already listed under this table but meta.tableId drifted (legacy rows).
    const pending = await restaurantRepository.listPendingOrdersForTable(pool, tableId);
    const onTable = pending.some((s) => sameUuid(s.id, orderId));

    if (meta && !meta.tableId && (sameUuid(table.currentOrderId, orderId) || onTable)) {
      await restaurantRepository.patchOrderRestaurantFields(pool, orderId, {
        tableId,
        orderChannel:
          (meta.orderChannel as 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY' | null) ||
          channelForTable(table),
      });
      meta = await restaurantRepository.getOrderRestaurantMeta(pool, orderId);
    }

    // Soft heal: PENDING, correct table_id on meta, missing only from list due to RETAIL filter
    // — no; if still not on table, refuse.
    if (!meta || !sameUuid(meta.tableId, tableId)) {
      // One more list after heal
      const pending2 = await restaurantRepository.listPendingOrdersForTable(pool, tableId);
      if (pending2.some((s) => sameUuid(s.id, orderId))) {
        // Meta lag: trust pending membership
      } else {
        throw new BusinessError(
          'Check does not belong to this table',
          'ERR_RESTAURANT_CHECK_WRONG_TABLE',
          {
            orderId,
            tableId,
            orderTableId: meta?.tableId ?? null,
          },
        );
      }
    } else if (!onTable) {
      // Meta says table but not in PENDING list (closed race) — treat as closed.
      throw new BusinessError('Only open checks can be activated', 'ERR_RESTAURANT_CHECK_CLOSED');
    }
    requireCheckMutationAccess(meta!.waiterId, actor, {
      sharedServiceCounter: tableIsSharedServiceCounter(table),
    });
    await restaurantRepository.setTableCurrentOrder(pool, tableId, orderId);
    return this.getTableCheck(pool, tableId, orderId, actor);
  },

  /**
   * Samba-style: open an empty pending check on a table (party tab) without moving items.
   * Does not merge, cancel, or touch sibling lines / KOT / payments.
   * Sets current_order_id to the new check only; other PENDING checks remain open.
   */
  async openEmptyCheck(
    pool: Pool,
    input: {
      tableId: string;
      waiterId: string;
      actor?: OwnershipActor;
      guestName?: string | null;
      guestPhone?: string | null;
      deliveryAddress?: string | null;
      pickupLabel?: string | null;
    },
  ) {
    await assertRestaurantEnabled(pool);
    const table = await restaurantRepository.getTableById(pool, input.tableId);
    if (!table || !table.isActive) throw new NotFoundError('Restaurant table');

    if (
      tableIsSharedServiceCounter(table) &&
      input.actor &&
      !canAccessRestaurantServiceLane(input.actor)
    ) {
      throw new ForbiddenError(RESTAURANT_SERVICE_LANE_RESTRICTED_MESSAGE);
    }

    const actor = input.actor;
    const effectiveWaiterId =
      actor && !canEditOtherWaitersChecks(actor) ? actor.userId : input.waiterId;

    const lockKey = `restaurant_table_${input.tableId}`;
    await pool.query(`SELECT pg_advisory_lock(hashtext($1))`, [lockKey]);
    try {
      const locked = await restaurantRepository.getTableById(pool, input.tableId);
      if (!locked) throw new NotFoundError('Restaurant table');

      const pending = await restaurantRepository.listPendingOrdersForTable(
        pool,
        input.tableId,
      );
      // Cap empty/party tabs — integrity guard against runaway open headers.
      const MAX_OPEN_CHECKS_PER_TABLE = 20;
      if (pending.length >= MAX_OPEN_CHECKS_PER_TABLE) {
        throw new BusinessError(
          `This table already has ${pending.length} open tickets (max ${MAX_OPEN_CHECKS_PER_TABLE})`,
          'ERR_RESTAURANT_TOO_MANY_CHECKS',
          { tableId: input.tableId, openCount: pending.length },
        );
      }

      // Ownership: waiters may open a new tab only if the table is free for them,
      // or they already own a check here, or they can edit others (manager/cashier).
      if (actor && !canEditOtherWaitersChecks(actor) && !tableIsSharedServiceCounter(locked)) {
        if (pending.length > 0) {
          const ownsAny = pending.some((s) => !s.waiterId || s.waiterId === actor.userId);
          if (!ownsAny) {
            throw new ForbiddenError(RESTAURANT_CHECK_OWNED_MESSAGE);
          }
        }
      }

      const channel = channelForTable(locked);
      const guestPayload: RestaurantGuestDetails = {
        guestName: input.guestName,
        guestPhone: input.guestPhone,
        deliveryAddress: input.deliveryAddress,
        pickupLabel: input.pickupLabel,
      };
      // First open on service lanes still needs guest identity; sibling tabs inherit context optionally.
      if (pending.length === 0 && (channel === 'TAKEAWAY' || channel === 'DELIVERY')) {
        assertChannelGuest(channel, guestPayload);
      }

      const waiters = await restaurantRepository.listAssignableWaiters(pool);
      const actorOk = actor?.userId && actor.userId === effectiveWaiterId;
      if (
        waiters.length > 0 &&
        !waiters.some((w) => w.id === effectiveWaiterId) &&
        !actorOk
      ) {
        throw new ValidationError('Selected user is not an assignable waiter');
      }

      let orderId: string;
      try {
        orderId = await UnitOfWork.run(pool, async (client: PoolClient) => {
          // Header-only — same path as split destination; no retail createOrder item rule.
          const header = await ordersRepository.createOrder(client, {
            customerId: null,
            subtotal: 0,
            discountAmount: 0,
            taxAmount: 0,
            totalAmount: 0,
            createdBy: effectiveWaiterId,
            notes: `Restaurant ${locked.code} · ticket`,
          });

          await restaurantRepository.patchOrderRestaurantFields(client, header.id, {
            tableId: locked.id,
            orderChannel: channel,
            waiterId: effectiveWaiterId,
            kitchenStatus: 'NONE',
            guestName: input.guestName ?? null,
            guestPhone: input.guestPhone ?? null,
            deliveryAddress: input.deliveryAddress ?? null,
            pickupLabel: input.pickupLabel ?? null,
          });

          // Point floor at new tab; siblings stay PENDING and unaltered.
          await restaurantRepository.occupyTable(client, locked.id, header.id);
          return header.id;
        });
      } catch (err) {
        logger.error('openEmptyCheck failed', { tableId: input.tableId, err });
        throw err;
      }

      logger.info('Restaurant empty check opened (multi-ticket)', {
        tableCode: locked.code,
        orderId,
        priorOpenCount: pending.length,
      });

      return this.getTableCheck(pool, input.tableId, orderId, actor);
    } finally {
      await pool.query(`SELECT pg_advisory_unlock(hashtext($1))`, [lockKey]);
    }
  },

  /**
   * Add items to a table check. Creates pos_orders on first item (SSOT).
   */
  async addItemsToTable(
    pool: Pool,
    input: {
      tableId: string;
      /** Multi-ticket: target open check (avoids racing activateCheck). */
      orderId?: string;
      /**
       * Always open a new check with these items (party-list menu tap).
       * Does not append to current_order_id or passed orderId; siblings stay open.
       */
      forceNewCheck?: boolean;
      items: RestaurantOrderItemInput[];
      waiterId: string;
      customerId?: string | null;
      taxAmount?: number;
      guestName?: string | null;
      guestPhone?: string | null;
      deliveryAddress?: string | null;
      pickupLabel?: string | null;
      /** Acting user — ownership + line attribution (Toast/Aloha). */
      actor?: OwnershipActor;
    },
  ) {
    await assertRestaurantEnabled(pool);

    if (!input.items?.length) {
      throw new ValidationError('At least one item is required');
    }

    const table = await restaurantRepository.getTableById(pool, input.tableId);
    if (!table || !table.isActive) throw new NotFoundError('Restaurant table');

    if (
      tableIsSharedServiceCounter(table) &&
      input.actor &&
      !canAccessRestaurantServiceLane(input.actor)
    ) {
      throw new ForbiddenError(RESTAURANT_SERVICE_LANE_RESTRICTED_MESSAGE);
    }

    // Waiters always own what they open; managers may assign another waiter on open.
    const actor = input.actor;
    const effectiveWaiterId =
      actor && !canEditOtherWaitersChecks(actor) ? actor.userId : input.waiterId;
    const addedByUserId = actor?.userId || effectiveWaiterId;

    const channel = channelForTable(table);
    const guestPayload: RestaurantGuestDetails = {
      guestName: input.guestName,
      guestPhone: input.guestPhone,
      deliveryAddress: input.deliveryAddress,
      pickupLabel: input.pickupLabel,
    };

    // On first open for service channels, require guest details
    const openingFresh = !table.currentOrderId;
    if (openingFresh && (channel === 'TAKEAWAY' || channel === 'DELIVERY')) {
      assertChannelGuest(channel, guestPayload);
    }

    // Resolve product names/prices from catalog (SSOT — refuse stale client-only names when product exists)
    const resolvedItems: OrderItemInput[] = [];
    const lineExtras = input.items.map(resolveItemNotesAndPrice);
    for (let idx = 0; idx < input.items.length; idx++) {
      const raw = input.items[idx];
      if (!raw.quantity || raw.quantity <= 0) {
        throw new ValidationError('Item quantity must be positive');
      }
      const productId = normalizeProductIdForDb(raw.productId);
      const prod = await pool.query(
        `SELECT p.id, p.name, COALESCE(pv.selling_price, 0) AS selling_price, p.kitchen_station
         FROM products p
         LEFT JOIN product_valuation pv ON pv.product_id = p.id
         WHERE p.id = $1 AND COALESCE(p.is_active, true) = TRUE`,
        [productId],
      );
      if (!prod.rows[0]) {
        throw new ValidationError(`Product not found or inactive: ${raw.productId}`);
      }
      const basePrice =
        raw.unitPrice !== undefined
          ? raw.unitPrice
          : Money.toNumber(Money.parseDb(String(prod.rows[0].selling_price)));
      const unitPrice = Money.toNumber(
        Money.round(new Decimal(basePrice).plus(lineExtras[idx].priceDelta), 2),
      );
      resolvedItems.push({
        productId: prod.rows[0].id,
        productName: raw.productName?.trim() || prod.rows[0].name,
        quantity: raw.quantity,
        unitPrice,
        discountAmount: raw.discountAmount || 0,
        uomId: raw.uomId ?? null,
      });
    }

    // Append / create under session advisory lock — prevent double-open races
    const lockKey = `restaurant_table_${input.tableId}`;
    await pool.query(`SELECT pg_advisory_lock(hashtext($1))`, [lockKey]);
    try {
      let orderId: string | null = null;
      const forceNew = !!input.forceNewCheck;

      if (forceNew) {
        // Party list / new guest seat: never append to floor pointer or a sibling.
        orderId = null;
      } else if (input.orderId) {
        const meta = await restaurantRepository.getOrderRestaurantMeta(pool, input.orderId);
        if (!meta || meta.tableId !== input.tableId) {
          throw new ValidationError('Order does not belong to this table');
        }
        const existing = await ordersRepository.getById(pool, input.orderId);
        if (!existing || existing.status !== 'PENDING') {
          // Stale client orderId after pay/cancel/void-last-lines — FOH often still paints it.
          const pending = await restaurantRepository.listPendingOrdersForTable(
            pool,
            input.tableId,
          );
          const retry = resolveClosedCheckAddRetry(
            input.orderId,
            pending.map((p) => p.id),
          );
          if (retry.action === 'open-new') {
            logger.info('addItems: closed orderId with no open siblings — opening new check', {
              tableId: input.tableId,
              closedOrderId: input.orderId,
              status: existing?.status ?? null,
            });
            orderId = null;
          } else if (retry.action === 'bind') {
            logger.info('addItems: closed orderId — binding remaining open check', {
              tableId: input.tableId,
              closedOrderId: input.orderId,
              bindOrderId: retry.orderId,
            });
            const bindMeta = await restaurantRepository.getOrderRestaurantMeta(pool, retry.orderId);
            requireCheckMutationAccess(bindMeta?.waiterId, actor, {
              sharedServiceCounter: tableIsSharedServiceCounter(table),
            });
            orderId = retry.orderId;
          } else {
            throw new BusinessError('Check is not open', 'ERR_RESTAURANT_CHECK_CLOSED', {
              orderId: input.orderId,
              status: existing?.status ?? null,
              openOrderIds: retry.openOrderIds,
            });
          }
        } else {
          requireCheckMutationAccess(meta.waiterId, actor, {
            sharedServiceCounter: tableIsSharedServiceCounter(table),
          });
          orderId = input.orderId;
        }
      } else {
        orderId = table.currentOrderId;
        if (orderId) {
          const existing = await ordersRepository.getById(pool, orderId);
          if (!existing || existing.status !== 'PENDING') {
            orderId = null;
          } else {
            const meta = await restaurantRepository.getOrderRestaurantMeta(pool, orderId);
            requireCheckMutationAccess(meta?.waiterId, actor, {
              sharedServiceCounter: tableIsSharedServiceCounter(table),
            });
          }
        }
      }

      const lockedTable = await restaurantRepository.getTableById(pool, input.tableId);
      if (!lockedTable) throw new NotFoundError('Restaurant table');
      if (!forceNew && !input.orderId && lockedTable.currentOrderId) {
        orderId = lockedTable.currentOrderId;
        const existing = await ordersRepository.getById(pool, orderId);
        if (!existing || existing.status !== 'PENDING') {
          orderId = null;
        } else {
          const meta = await restaurantRepository.getOrderRestaurantMeta(pool, orderId);
          requireCheckMutationAccess(meta?.waiterId, actor, {
            sharedServiceCounter: tableIsSharedServiceCounter(lockedTable),
          });
        }
      }

      if (!orderId) {
        // Cap party tabs (same guard as openEmptyCheck).
        const pendingForNew = await restaurantRepository.listPendingOrdersForTable(
          pool,
          input.tableId,
        );
        const MAX_OPEN_CHECKS_PER_TABLE = 20;
        if (pendingForNew.length >= MAX_OPEN_CHECKS_PER_TABLE) {
          throw new BusinessError(
            `This table already has ${pendingForNew.length} open tickets (max ${MAX_OPEN_CHECKS_PER_TABLE})`,
            'ERR_RESTAURANT_TOO_MANY_CHECKS',
            { tableId: input.tableId, openCount: pendingForNew.length },
          );
        }
        if (actor && !canEditOtherWaitersChecks(actor) && !tableIsSharedServiceCounter(lockedTable)) {
          if (pendingForNew.length > 0) {
            const ownsAny = pendingForNew.some(
              (s) => !s.waiterId || s.waiterId === actor.userId,
            );
            if (!ownsAny) {
              throw new ForbiddenError(RESTAURANT_CHECK_OWNED_MESSAGE);
            }
          }
        }

        const waiters = await restaurantRepository.listAssignableWaiters(pool);
        // Always allow the acting user to own the check they open (managers/admins
        // may not appear in the waiter picker edge cases; never block on that).
        const actorOk = actor?.userId && actor.userId === effectiveWaiterId;
        if (
          waiters.length > 0 &&
          !waiters.some((w) => w.id === effectiveWaiterId) &&
          !actorOk
        ) {
          throw new ValidationError('Selected user is not an assignable waiter');
        }

        const created = await ordersService.createOrder(pool, {
          customerId: input.customerId ?? null,
          items: resolvedItems,
          createdBy: effectiveWaiterId,
          notes: `Restaurant ${lockedTable.code}`,
        });
        orderId = created.id;

        try {
          await UnitOfWork.run(pool, async (client: PoolClient) => {
            await restaurantRepository.patchOrderRestaurantFields(client, orderId!, {
              tableId: lockedTable.id,
              orderChannel: channel,
              waiterId: effectiveWaiterId,
              kitchenStatus: 'NONE',
              guestName: input.guestName,
              guestPhone: input.guestPhone,
              deliveryAddress: input.deliveryAddress,
              pickupLabel: input.pickupLabel,
            });

            const fresh = await ordersRepository.getById(client, orderId!);
            if (fresh?.items) {
              for (let i = 0; i < fresh.items.length; i++) {
                const stationRow = await client.query(
                  `SELECT kitchen_station FROM products WHERE id = $1`,
                  [normalizeProductIdForDb(resolvedItems[i].productId)],
                );
                const hasAddedBy = await tableHasColumn(client, 'pos_order_items', 'added_by');
                if (hasAddedBy) {
                  await client.query(
                    `UPDATE pos_order_items
                     SET line_notes = $2, kitchen_station = $3, added_by = $4
                     WHERE id = $1`,
                    [
                      fresh.items[i].id,
                      lineExtras[i]?.lineNotes ?? null,
                      stationRow.rows[0]?.kitchen_station ?? null,
                      addedByUserId,
                    ],
                  );
                  const hasAddedAt = await tableHasColumn(client, 'pos_order_items', 'added_at');
                  if (hasAddedAt) {
                    await client.query(
                      `UPDATE pos_order_items SET added_at = COALESCE(added_at, NOW()) WHERE id = $1`,
                      [fresh.items[i].id],
                    );
                  }
                } else {
                  await client.query(
                    `UPDATE pos_order_items
                     SET line_notes = $2, kitchen_station = $3
                     WHERE id = $1`,
                    [
                      fresh.items[i].id,
                      lineExtras[i]?.lineNotes ?? null,
                      stationRow.rows[0]?.kitchen_station ?? null,
                    ],
                  );
                }
                await orderTagRepository.setOrderItemTags(
                  client,
                  fresh.items[i].id,
                  lineExtras[i]?.orderTags ?? [],
                  lineExtras[i]?.lineNotes ?? null,
                );
              }
            }

            await restaurantRepository.occupyTable(client, lockedTable.id, orderId!);

            const order = await ordersRepository.getById(client, orderId!);
            const tax = await computeRestaurantDocumentTax(
              client,
              order!.items || [],
              order!.customerId,
            );
            const totals = recalcFromItems(order!.items || [], tax);
            await restaurantRepository.updateOrderTotals(client, orderId!, totals);
          });
        } catch (err) {
          try {
            await ordersService.cancelOrder(
              pool,
              orderId,
              effectiveWaiterId,
              'Restaurant open-check failed',
            );
          } catch (cancelErr) {
            logger.error('Failed to cancel orphan restaurant order after open failure', {
              orderId,
              cancelErr,
            });
          }
          throw err;
        }

        logger.info('Restaurant check opened', {
          tableCode: lockedTable.code,
          orderNumber: created.orderNumber,
          channel,
        });

        return {
          table: await restaurantRepository.getTableById(pool, lockedTable.id),
          order: await ordersService.getOrder(pool, orderId),
          meta: await restaurantRepository.getOrderRestaurantMeta(pool, orderId),
        };
      }

      await UnitOfWork.run(pool, async (client: PoolClient) => {
        const existing = await ordersRepository.getById(client, orderId!);
        if (!existing || existing.status !== 'PENDING') {
          throw new BusinessError('Table check is not open', 'ERR_RESTAURANT_CHECK_CLOSED');
        }

        const itemsData: CreateOrderItemData[] = [];
        for (const item of resolvedItems) {
          const lineTotal = new Decimal(item.quantity).times(new Decimal(item.unitPrice));
          const dbProductId = normalizeProductIdForDb(item.productId);
          if (!dbProductId) {
            throw new ValidationError(`Invalid product id: ${item.productId}`);
          }
          const snapshot = await resolveSaleItemUom(
            dbProductId,
            { quantity: item.quantity, uomId: item.uomId ?? null },
            client,
          );
          itemsData.push({
            orderId: orderId!,
            productId: dbProductId,
            productName: item.productName,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            lineTotal: parseFloat(lineTotal.toFixed(2)),
            discountAmount: item.discountAmount || 0,
            uomId: snapshot.sellingUomId,
            baseQty: snapshot.baseQuantity,
            baseUomId: snapshot.baseUomId,
            conversionFactor: snapshot.conversionFactor,
            addedBy: addedByUserId,
            addedAt: new Date().toISOString(),
          });
        }

        const added = await ordersRepository.addOrderItems(client, itemsData);
        for (let i = 0; i < added.length; i++) {
          const stationRow = await client.query(
            `SELECT kitchen_station FROM products WHERE id = $1`,
            [normalizeProductIdForDb(resolvedItems[i].productId)],
          );
          const hasAddedBy = await tableHasColumn(client, 'pos_order_items', 'added_by');
          if (hasAddedBy) {
            await client.query(
              `UPDATE pos_order_items
               SET line_notes = $2, kitchen_station = $3, added_by = COALESCE(added_by, $4)
               WHERE id = $1`,
              [
                added[i].id,
                lineExtras[i]?.lineNotes ?? null,
                stationRow.rows[0]?.kitchen_station ?? null,
                addedByUserId,
              ],
            );
            const hasAddedAt = await tableHasColumn(client, 'pos_order_items', 'added_at');
            if (hasAddedAt) {
              await client.query(
                `UPDATE pos_order_items SET added_at = COALESCE(added_at, NOW()) WHERE id = $1`,
                [added[i].id],
              );
            }
          } else {
            await client.query(
              `UPDATE pos_order_items
               SET line_notes = $2, kitchen_station = $3
               WHERE id = $1`,
              [
                added[i].id,
                lineExtras[i]?.lineNotes ?? null,
                stationRow.rows[0]?.kitchen_station ?? null,
              ],
            );
          }
          await orderTagRepository.setOrderItemTags(
            client,
            added[i].id,
            lineExtras[i]?.orderTags ?? [],
            lineExtras[i]?.lineNotes ?? null,
          );
        }

        const refreshed = await ordersRepository.getById(client, orderId!);
        const tax = await computeRestaurantDocumentTax(
          client,
          refreshed?.items || [],
          refreshed?.customerId,
        );
        const totals = recalcFromItems(refreshed?.items || [], tax);
        await restaurantRepository.updateOrderTotals(client, orderId!, totals);

        if (lockedTable.status === 'FREE' || !lockedTable.currentOrderId) {
          await restaurantRepository.occupyTable(client, lockedTable.id, orderId!);
        } else if (input.orderId && lockedTable.currentOrderId !== orderId) {
          // Multi-ticket: keep table pointer on the check the FOH just added to.
          await restaurantRepository.setTableCurrentOrder(client, lockedTable.id, orderId!);
        }
      });

      return {
        table: await restaurantRepository.getTableById(pool, lockedTable.id),
        order: await ordersService.getOrder(pool, orderId),
        meta: await restaurantRepository.getOrderRestaurantMeta(pool, orderId),
      };
    } finally {
      await pool.query(`SELECT pg_advisory_unlock(hashtext($1))`, [lockKey]);
    }
  },

  /**
   * Fire unsent lines to kitchen. Creates immutable KOT rows + print_jobs (SSOT).
   * Local agent delivers jobs; browser never selects a printer.
   */
  async sendKot(
    pool: Pool,
    orderId: string,
    firedBy: string,
    actor?: OwnershipActor,
  ): Promise<{ kots: KotRecord[]; printJobs: PrintJobRecord[] }> {
    await assertRestaurantEnabled(pool);

    const fired = await UnitOfWork.run(pool, async (client: PoolClient) => {
      const order = await ordersRepository.getById(client, orderId);
      if (!order || order.status !== 'PENDING') {
        throw new BusinessError('Open restaurant check required to send KOT', 'ERR_RESTAURANT_KOT');
      }
      const metaEarly = await restaurantRepository.getOrderRestaurantMeta(client, orderId);
      await requireOrderMutationAccess(
        client,
        metaEarly,
        actor || { userId: firedBy },
      );

      const meta = await restaurantRepository.getOrderRestaurantMeta(client, orderId);
      if (!meta || meta.orderChannel === 'RETAIL') {
        throw new BusinessError(
          'KOT is only for restaurant channel orders',
          'ERR_RESTAURANT_CHANNEL',
        );
      }

      // Serialize concurrent fires (READ COMMITTED): lock unsent rows before reading.
      await restaurantRepository.lockUnsentItemsForUpdate(client, orderId);
      const unsent = await restaurantRepository.listUnsentItems(client, orderId);
      // Expert FOH: KOT with nothing new is a no-op success — ticket stays open.
      // Do not error; empty array means "already fired".
      if (unsent.length === 0) {
        logger.info('Restaurant KOT no-op (no unsent items)', { orderId });
        return { kots: [], printJobs: [] };
      }

      // Heal lines missing kitchen_station so menu→station→printer routing works
      // for items added before routing was configured (or offline sync gaps).
      const healed = await restaurantRepository.healUnsentLineKitchenStations(client, orderId);
      const unsentForKot =
        healed > 0
          ? await restaurantRepository.listUnsentItems(client, orderId)
          : unsent;

      // Toast/Aloha: ticket shows who SENT it (login user), not only check owner.
      const firedByName = await lookupUserDisplayName(client, firedBy);

      // Split by resolved station (registry SSOT — unknown codes → default)
      const byStation = new Map<string, { station: RestaurantStationRecord; items: typeof unsentForKot }>();
      for (const item of unsentForKot) {
        const resolved = await restaurantRepository.resolveStation(client, item.kitchenStation);
        const key = resolved.code.toUpperCase();
        const bucket = byStation.get(key) || { station: resolved, items: [] };
        bucket.items.push(item);
        byStation.set(key, bucket);
      }

      const kots: KotRecord[] = [];
      const printJobs: PrintJobRecord[] = [];
      for (const { station, items } of byStation.values()) {
        const kot = await restaurantRepository.createKot(client, {
          orderId,
          tableCode: meta.tableCode,
          tableName: meta.tableName,
          // Persist the person who fired — kitchen must see who commanded the ticket.
          waiterName: firedByName || meta.waiterName,
          station: station.code,
          firedBy,
          items: toConsolidatedKotItems(
            items.map((it) => ({
              id: it.id,
              productId: it.productId,
              productName: it.productName,
              quantity: Money.toNumber(Money.parseDb(it.quantity)),
              lineNotes: it.lineNotes,
            })),
          ),
        });
        await restaurantRepository.markItemsKitchenSent(
          client,
          items.map((it) => it.id),
        );
        kot.printerName = station.printerName;
        applyKotActorNames(kot, firedByName, meta.waiterName);
        kots.push(kot);

        const isVoid = kot.ticketKind === 'VOID';
        const job = await printJobsService.enqueue(client, {
          documentType: isVoid ? 'VOID_KOT' : 'KOT',
          targetPrinter: station.printerName,
          payloadJson: kotToPrintPayload(kot, meta),
          sourceType: 'restaurant_kot',
          sourceId: kot.id,
          orderId,
          stationCode: station.code,
        });
        if (job) printJobs.push(job);
      }

      await restaurantRepository.patchOrderRestaurantFields(client, orderId, {
        kitchenStatus: 'SENT',
      });

      logger.info('Restaurant KOT fired', {
        orderId,
        kotCount: kots.length,
        printJobCount: printJobs.length,
        kotNumbers: kots.map((k) => k.kotNumber),
        printers: printJobs.map((j) => j.targetPrinter),
      });

      return { kots, printJobs };
    });
    if (fired.kots.length > 0) {
      publishNotificationEvent({
        pool,
        typeKey: 'RESTAURANT_KOT_SENT',
        entityType: 'restaurant_order',
        entityId: orderId,
        idempotencyKey: `RESTAURANT_KOT_SENT:restaurant_order:${orderId}:${fired.kots[0].id}`,
        payload: {
          summary: `Kitchen ticket ${fired.kots.map((k) => k.kotNumber).join(', ')} sent`,
          documentRef: fired.kots[0].kotNumber,
        },
        actorUserId: firedBy,
      });
    }
    return fired;
  },

  /**
   * Void check lines (Toast/Samba style).
   * Pass quantity per line to void only part of a multi-qty row; remainder stays on the check.
   * Kitchen-sent qty produces VOID KOT tickets (no prices). Unsent qty is removed quietly.
   * If no lines remain, the check is cancelled and the table is freed.
   */
  async voidCheckItems(
    pool: Pool,
    orderId: string,
    input: {
      items: Array<{ itemId: string; quantity?: number }>;
      reason: string;
      voidedBy: string;
      actor?: OwnershipActor;
    },
  ): Promise<{
    voidKots: KotRecord[];
    printJobs: PrintJobRecord[];
    checkCancelled: boolean;
    order: Awaited<ReturnType<typeof ordersService.getOrder>> | null;
    meta: Awaited<ReturnType<typeof restaurantRepository.getOrderRestaurantMeta>> | null;
  }> {
    await assertRestaurantEnabled(pool);
    const reason = input.reason?.trim();
    if (!reason) throw new ValidationError('Void reason is required');
    if (!input.items?.length) throw new ValidationError('Select at least one line to void');

    const voidRequests = new Map<string, number | 'FULL'>();
    for (const row of input.items) {
      if (row.quantity === undefined) {
        voidRequests.set(row.itemId, 'FULL');
        continue;
      }
      if (!(row.quantity > 0)) {
        throw new ValidationError('Void quantity must be positive');
      }
      const prev = voidRequests.get(row.itemId);
      if (prev === 'FULL') continue;
      voidRequests.set(row.itemId, (typeof prev === 'number' ? prev : 0) + row.quantity);
    }
    const uniqueIds = [...voidRequests.keys()];

    const result = await UnitOfWork.run(pool, async (client: PoolClient) => {
      const order = await ordersRepository.getById(client, orderId);
      if (!order || order.status !== 'PENDING') {
        throw new BusinessError('Open restaurant check required to void', 'ERR_RESTAURANT_VOID');
      }
      const meta = await restaurantRepository.getOrderRestaurantMeta(client, orderId);
      if (!meta || meta.orderChannel === 'RETAIL') {
        throw new BusinessError('Not a restaurant check', 'ERR_RESTAURANT_CHANNEL');
      }
      await requireOrderMutationAccess(
        client,
        meta,
        input.actor || { userId: input.voidedBy },
      );

      const rows = await restaurantRepository.listOrderItemsForVoid(client, orderId, uniqueIds);
      const foundIds = new Set(rows.map((r) => r.id));
      const missingIds = uniqueIds.filter((id) => !foundIds.has(id));
      // Stale FOH itemIds (already voided, swapped check, optimism) — drop ghosts, void what remains.
      // All missing → hard fail with guidance (not a silent no-op).
      if (rows.length === 0) {
        let elsewhere = 0;
        try {
          const hit = await client.query(
            `SELECT COUNT(*)::int AS n FROM pos_order_items WHERE id = ANY($1::uuid[])`,
            [uniqueIds],
          );
          elsewhere = Number(hit.rows[0]?.n || 0);
        } catch {
          elsewhere = 0;
        }
        throw new ValidationError(
          elsewhere > 0
            ? 'Those lines are on a different check — switch the ticket tab and try again'
            : 'Those lines are no longer on this check — refresh the table and try again',
        );
      }
      if (missingIds.length > 0) {
        logger.warn('voidCheckItems: ignoring stale item ids not on check', {
          orderId,
          missingCount: missingIds.length,
          foundCount: rows.length,
        });
      }

      type VoidSlice = (typeof rows)[number] & { voidQuantity: number };
      const slices: VoidSlice[] = [];
      for (const row of rows) {
        const onHand = Money.toNumber(Money.parseDb(row.quantity));
        const req = voidRequests.get(row.id);
        const want = req === 'FULL' || req === undefined ? onHand : req;
        if (want > onHand + 1e-9) {
          throw new ValidationError(
            `Cannot void ${want} of "${row.productName}" — only ${onHand} on the check`,
          );
        }
        slices.push({ ...row, voidQuantity: want });
      }

      const sentSlices = slices.filter((r) => !!r.kitchenSentAt);
      if (
        sentSlices.length > 0 &&
        !canVoidKitchenSentRestaurantItems(input.actor || { userId: input.voidedBy })
      ) {
        throw new ForbiddenError(RESTAURANT_VOID_SENT_RESTRICTED_MESSAGE);
      }
      const voidKots: KotRecord[] = [];
      const printJobs: PrintJobRecord[] = [];

      if (sentSlices.length > 0) {
        const byStation = new Map<
          string,
          { station: RestaurantStationRecord; items: VoidSlice[] }
        >();
        for (const item of sentSlices) {
          const resolved = await restaurantRepository.resolveStationForVoidItem(
            client,
            item.id,
            item.kitchenStation,
          );
          const key = resolved.code.toUpperCase();
          const bucket = byStation.get(key) || { station: resolved, items: [] };
          bucket.items.push(item);
          byStation.set(key, bucket);
        }
        const voidedByName = await lookupUserDisplayName(client, input.voidedBy);
        for (const { station, items } of byStation.values()) {
          const kot = await restaurantRepository.createKot(client, {
            orderId,
            tableCode: meta.tableCode,
            tableName: meta.tableName,
            waiterName: voidedByName || meta.waiterName,
            station: station.code,
            firedBy: input.voidedBy,
            ticketKind: 'VOID',
            voidReason: reason,
            items: toConsolidatedKotItems(
              items.map((it) => ({
                id: it.id,
                productId: it.productId,
                productName: it.productName,
                quantity: it.voidQuantity,
                lineNotes: it.lineNotes,
              })),
            ),
          });
          kot.printerName = station.printerName;
          applyKotActorNames(kot, voidedByName, meta.waiterName);
          voidKots.push(kot);
          const voidJob = await printJobsService.enqueue(client, {
            documentType: 'VOID_KOT',
            targetPrinter: station.printerName,
            payloadJson: kotToPrintPayload(kot, meta),
            sourceType: 'restaurant_kot',
            sourceId: kot.id,
            orderId,
            stationCode: station.code,
          });
          if (voidJob) printJobs.push(voidJob);
        }
      }

      const deleteIds: string[] = [];
      for (const slice of slices) {
        const onHand = Money.toNumber(Money.parseDb(slice.quantity));
        const remaining = new Decimal(onHand).minus(slice.voidQuantity);
        if (remaining.lte(0)) {
          deleteIds.push(slice.id);
        } else {
          // Same proportional discount math as split — keep line discount consistent with qty.
          const lineDiscount = Money.toNumber(Money.parseDb(String(slice.discountAmount || 0)));
          const remainDiscount =
            onHand > 0
              ? Number(
                  new Decimal(lineDiscount)
                    .times(remaining)
                    .div(onHand)
                    .toFixed(2),
                )
              : 0;
          const ok = await restaurantRepository.reduceOrderItemQuantity(
            client,
            orderId,
            slice.id,
            remaining.toNumber(),
            { discountAmount: remainDiscount },
          );
          if (!ok) {
            throw new BusinessError('Failed to reduce voided line quantity', 'ERR_RESTAURANT_VOID');
          }
        }
      }
      if (deleteIds.length > 0) {
        const deleted = await restaurantRepository.deleteOrderItems(client, orderId, deleteIds);
        if (deleted !== deleteIds.length) {
          throw new BusinessError('Failed to void all selected lines', 'ERR_RESTAURANT_VOID');
        }
      }

      const fresh = await ordersRepository.getById(client, orderId);
      const remainingLines = fresh?.items || [];
      if (remainingLines.length === 0) {
        return { voidKots, printJobs, checkCancelled: true as const, meta };
      }

      const tax = await computeRestaurantDocumentTax(
        client,
        remainingLines,
        fresh?.customerId,
      );
      await restaurantRepository.updateOrderTotals(
        client,
        orderId,
        recalcFromItems(remainingLines, tax),
      );

      const stillSent = remainingLines.some((it) => !!it.kitchenSentAt);
      if (!stillSent) {
        await restaurantRepository.patchOrderRestaurantFields(client, orderId, {
          kitchenStatus: 'NONE',
        });
      }

      return { voidKots, printJobs, checkCancelled: false as const, meta };
    });

    if (result.checkCancelled) {
      await ordersService.cancelOrder(pool, orderId, input.voidedBy, reason);
      await this.releaseTableForOrder(pool, orderId, {
        bumpVoids: true,
        updatedBy: input.voidedBy,
      });
      logger.info('Restaurant check voided completely', { orderId, reason });
      return {
        voidKots: result.voidKots,
        printJobs: result.printJobs,
        checkCancelled: true,
        order: null,
        meta: result.meta,
      };
    }

    logger.info('Restaurant lines voided', {
      orderId,
      itemCount: input.items.length,
      voidedLineCount: result.voidKots.reduce((n, k) => n + (k.items?.length || 0), 0),
      voidKotCount: result.voidKots.length,
      reason,
    });

    return {
      voidKots: result.voidKots,
      printJobs: result.printJobs,
      checkCancelled: false,
      order: await ordersService.getOrder(pool, orderId),
      meta: await restaurantRepository.getOrderRestaurantMeta(pool, orderId),
    };
  },

  async listKitchenBoard(pool: Pool, filters?: { station?: string | null }): Promise<KotRecord[]> {
    await assertRestaurantEnabled(pool);
    // Start from current truth: bump KOTs for paid/cancelled/voided checks first.
    const purged = await restaurantRepository.purgeSettledKitchenTickets(pool, null);
    if (purged > 0) {
      logger.info('Purged settled kitchen tickets from board', { purged });
    }
    const tickets = await restaurantRepository.listActiveKitchenTickets(pool, filters);
    // Attach printer routing for reprint / station display
    for (const ticket of tickets) {
      const station = await restaurantRepository.resolveStation(pool, ticket.station);
      ticket.printerName = station.printerName;
    }
    return tickets;
  },

  async listStations(pool: Pool, includeInactive = false): Promise<RestaurantStationRecord[]> {
    await assertRestaurantEnabled(pool);
    return restaurantRepository.listStations(pool, includeInactive);
  },

  async createStation(
    pool: Pool,
    data: {
      code: string;
      name: string;
      printerName?: string | null;
      sortOrder?: number;
      isDefault?: boolean;
    },
  ): Promise<RestaurantStationRecord> {
    await assertRestaurantEnabled(pool);
    if (!data.code?.trim() || !data.name?.trim()) {
      throw new ValidationError('Station code and name are required');
    }
    return restaurantRepository.createStation(pool, data);
  },

  async updateStation(
    pool: Pool,
    id: string,
    data: Partial<{
      code: string;
      name: string;
      printerName: string | null;
      sortOrder: number;
      isActive: boolean;
      isDefault: boolean;
    }>,
  ): Promise<RestaurantStationRecord> {
    await assertRestaurantEnabled(pool);
    const updated = await restaurantRepository.updateStation(pool, id, data);
    if (!updated) throw new NotFoundError('Kitchen station');
    return updated;
  },

  /**
   * Advance or set KOT ticket status on the KDS board.
   * Allowed: SENT → PREPARING → READY → BUMPED (or explicit next via action).
   */
  async advanceKotStatus(
    pool: Pool,
    kotId: string,
    updatedBy: string,
    targetStatus?: KotTicketStatus,
  ): Promise<{ kot: KotRecord; orderKitchenStatus: string }> {
    await assertRestaurantEnabled(pool);

    const advanced = await UnitOfWork.run(pool, async (client: PoolClient) => {
      const current = await restaurantRepository.getKotById(client, kotId);
      if (!current) throw new NotFoundError('Kitchen ticket');

      const meta = await restaurantRepository.getOrderRestaurantMeta(client, current.orderId);
      if (!meta || meta.orderChannel === 'RETAIL') {
        throw new BusinessError('Not a restaurant kitchen ticket', 'ERR_RESTAURANT_CHANNEL');
      }

      const order = await ordersRepository.getById(client, current.orderId);
      if (!order || order.status !== 'PENDING') {
        throw new BusinessError('Kitchen ticket order is not open', 'ERR_RESTAURANT_KOT');
      }

      const next =
        targetStatus ??
        KOT_STATUS_FLOW[current.status] ??
        null;
      if (!next) {
        throw new BusinessError('Kitchen ticket already cleared', 'ERR_RESTAURANT_KOT_DONE');
      }

      // Enforce forward-only: one step, or SENT → READY skip
      const orderRank = ['SENT', 'PREPARING', 'READY', 'BUMPED'] as const;
      const fromIdx = orderRank.indexOf(current.status);
      const toIdx = orderRank.indexOf(next);
      const allowedSkip = current.status === 'SENT' && next === 'READY';
      if (toIdx <= fromIdx || (toIdx > fromIdx + 1 && !allowedSkip)) {
        throw new BusinessError(
          `Invalid kitchen status transition ${current.status} → ${next}`,
          'ERR_RESTAURANT_KOT_STATUS',
        );
      }

      const kot = await restaurantRepository.updateKotStatus(client, kotId, next, updatedBy);
      if (!kot) throw new NotFoundError('Kitchen ticket');

      const orderKitchenStatus = await restaurantRepository.syncOrderKitchenStatusFromKots(
        client,
        current.orderId,
      );

      logger.info('Restaurant KOT status updated', {
        kotNumber: kot.kotNumber,
        from: current.status,
        to: next,
        orderKitchenStatus,
      });

      return { kot, orderKitchenStatus };
    });
    if (advanced.kot.status === 'READY') {
      publishNotificationEvent({
        pool,
        typeKey: 'RESTAURANT_ORDER_READY',
        entityType: 'restaurant_kot',
        entityId: advanced.kot.id,
        idempotencyKey: `RESTAURANT_ORDER_READY:restaurant_kot:${advanced.kot.id}`,
        payload: {
          summary: `Kitchen ticket ${advanced.kot.kotNumber} is ready`,
          documentRef: advanced.kot.kotNumber,
        },
        actorUserId: updatedBy,
      });
    }
    return advanced;
  },

  async markBilling(pool: Pool, orderId: string): Promise<void> {
    await assertRestaurantEnabled(pool);
    const meta = await restaurantRepository.getOrderRestaurantMeta(pool, orderId);
    if (!meta?.tableId) return;
    // Multi-ticket tables: billing one check must not paint the whole table BILLING
    // (sibling tickets would incorrectly look billed). Sole open check → BILLING.
    const siblings = await restaurantRepository.listPendingOrdersForTable(pool, meta.tableId);
    if (siblings.length <= 1) {
      await restaurantRepository.markTableBilling(pool, meta.tableId);
    }
  },

  /**
   * Release floor table when order completes or cancels.
   * Safe no-op when restaurant flag off or order is not table-linked.
   * Also bumps kitchen FIRE tickets so KDS clears settled checks.
   */
  async releaseTableForOrder(
    pool: Pool | PoolClient,
    orderId: string,
    opts?: { bumpVoids?: boolean; updatedBy?: string },
  ): Promise<void> {
    const enabled = await isRestaurantModeEnabled(pool);
    if (!enabled) return;
    // KDS bump must never block floor release (status_updated_by is UUID-nullable).
    let bumped = 0;
    try {
      bumped = await restaurantRepository.bumpKitchenTicketsForOrder(
        pool,
        orderId,
        opts?.updatedBy ?? null,
        { bumpVoids: opts?.bumpVoids !== false },
      );
    } catch (bumpErr) {
      logger.error('Kitchen bump failed during table release — continuing with floor free', {
        orderId,
        error: bumpErr instanceof Error ? bumpErr.message : String(bumpErr),
      });
    }
    const released = await restaurantRepository.releaseTableByOrderId(pool, orderId);
    if (released || bumped > 0) {
      logger.info('Restaurant table/kitchen cleared for order', {
        orderId,
        released,
        bumpedTickets: bumped,
        bumpVoids: opts?.bumpVoids !== false,
      });
    }
  },

  /**
   * SambaPOS Print Bill rule (FOH):
   * 1) Mark this check billed; table → BILLING only when it is the sole open check
   * 2) Return check payload for optional local print (best-effort)
   * Order stays PENDING until Pay. Multi-ticket tables stay on floor with siblings.
   */
  async requestBill(pool: Pool, orderId: string, actor?: OwnershipActor) {
    await assertRestaurantEnabled(pool);
    const order = await ordersService.getOrder(pool, orderId);
    if (order.status !== 'PENDING') {
      throw new BusinessError('Bill is only available for open checks', 'ERR_RESTAURANT_BILL');
    }
    if (!order.items || order.items.length === 0) {
      throw new BusinessError('Cannot bill an empty check', 'ERR_RESTAURANT_BILL_EMPTY');
    }
    const meta = await restaurantRepository.getOrderRestaurantMeta(pool, orderId);
    if (!meta || meta.orderChannel === 'RETAIL') {
      throw new BusinessError('Not a restaurant check', 'ERR_RESTAURANT_CHANNEL');
    }
    await requireOrderMutationAccess(pool, meta, actor);
    await this.markBilling(pool, orderId);
    const table = meta.tableId
      ? await restaurantRepository.getTableById(pool, meta.tableId)
      : null;

    const guestBillCfg = await systemSettingsService.getGuestBillPrintConfig(pool);
    const printJob = await printJobsService.enqueue(pool, {
      documentType: 'GUEST_BILL',
      targetPrinter: guestBillCfg.printerName,
      payloadJson: {
        orderId,
        orderNumber: order.orderNumber,
        tableLabel: table?.name || meta.tableName || meta.tableCode || 'Table',
        waiterName: meta.waiterName,
        orderChannel: meta.orderChannel,
        guestName: meta.guestName,
        guestPhone: meta.guestPhone,
        deliveryAddress: meta.deliveryAddress,
        pickupLabel: meta.pickupLabel,
        items: (order.items || []).map((it) => ({
          productId: it.productId,
          productName: it.productName,
          quantity: Number(it.quantity),
          unitPrice: Number(it.unitPrice),
          lineTotal: Number(it.lineTotal ?? Number(it.quantity) * Number(it.unitPrice)),
          lineNotes: it.lineNotes ?? null,
        })),
        subtotal: Number(order.subtotal),
        discountAmount: Number(order.discountAmount || 0),
        taxAmount: Number(order.taxAmount || 0),
        totalAmount: Number(order.totalAmount),
      },
      sourceType: 'pos_orders',
      sourceId: orderId,
      orderId,
    });

    logger.info('Restaurant bill requested', {
      orderId,
      tableId: meta.tableId,
      tableStatus: table?.status ?? null,
      printJobId: printJob?.id ?? null,
      printer: printJob?.targetPrinter ?? guestBillCfg.printerName,
    });
    return { order, meta, table, printJobs: printJob ? [printJob] : [] };
  },

  /** @deprecated Prefer requestBill — same behavior */
  async getBill(pool: Pool, orderId: string, actor?: OwnershipActor) {
    return this.requestBill(pool, orderId, actor);
  },

  /**
   * Cancel open restaurant check via orders SSOT, then free the table.
   */
  async updateCheckGuest(
    pool: Pool,
    orderId: string,
    guest: RestaurantGuestDetails,
    actor?: OwnershipActor,
  ) {
    await assertRestaurantEnabled(pool);
    const meta = await restaurantRepository.getOrderRestaurantMeta(pool, orderId);
    if (!meta || meta.orderChannel === 'RETAIL') {
      throw new BusinessError('Not a restaurant check', 'ERR_RESTAURANT_CHANNEL');
    }
    await requireOrderMutationAccess(pool, meta, actor);
    const order = await ordersService.getOrder(pool, orderId);
    if (order.status !== 'PENDING') {
      throw new BusinessError('Only open checks can update guest details', 'ERR_RESTAURANT_CHECK_CLOSED');
    }
    assertChannelGuest(meta.orderChannel, {
      guestName: guest.guestName ?? meta.guestName,
      guestPhone: guest.guestPhone ?? meta.guestPhone,
      deliveryAddress: guest.deliveryAddress ?? meta.deliveryAddress,
      pickupLabel: guest.pickupLabel ?? meta.pickupLabel,
    });

    await restaurantRepository.patchOrderRestaurantFields(pool, orderId, {
      guestName: guest.guestName,
      guestPhone: guest.guestPhone,
      deliveryAddress: guest.deliveryAddress,
      pickupLabel: guest.pickupLabel,
    });

    return {
      order: await ordersService.getOrder(pool, orderId),
      meta: await restaurantRepository.getOrderRestaurantMeta(pool, orderId),
    };
  },

  /**
   * Per-ticket FOA note (pos_orders.notes SSOT).
   * Does not alter lines, totals, KOT, or sibling checks.
   */
  async updateCheckNotes(
    pool: Pool,
    orderId: string,
    notes: string | null,
    actor?: OwnershipActor,
  ) {
    await assertRestaurantEnabled(pool);
    const meta = await restaurantRepository.getOrderRestaurantMeta(pool, orderId);
    if (!meta || meta.orderChannel === 'RETAIL') {
      throw new BusinessError('Not a restaurant check', 'ERR_RESTAURANT_CHANNEL');
    }
    await requireOrderMutationAccess(pool, meta, actor);
    const order = await ordersService.getOrder(pool, orderId);
    if (order.status !== 'PENDING') {
      throw new BusinessError('Only open checks can update notes', 'ERR_RESTAURANT_CHECK_CLOSED');
    }

    const cleaned = notes == null ? null : String(notes).trim().slice(0, 2000) || null;
    await restaurantRepository.updateOrderNotes(pool, orderId, cleaned);

    return {
      order: await ordersService.getOrder(pool, orderId),
      meta: await restaurantRepository.getOrderRestaurantMeta(pool, orderId),
    };
  },

  async cancelCheck(
    pool: Pool,
    orderId: string,
    cancelledBy: string,
    reason: string,
    actor?: OwnershipActor,
  ) {
    await assertRestaurantEnabled(pool);
    const meta = await restaurantRepository.getOrderRestaurantMeta(pool, orderId);
    if (!meta || meta.orderChannel === 'RETAIL') {
      throw new BusinessError('Not a restaurant check', 'ERR_RESTAURANT_CHANNEL');
    }
    await requireOrderMutationAccess(pool, meta, actor || { userId: cancelledBy });

    // Notify kitchen for any already-fired lines before cancelling the check.
    const { voidKots, printJobs } = await UnitOfWork.run(pool, async (client: PoolClient) => {
      const sent = await restaurantRepository.listKitchenSentItems(client, orderId);
      if (sent.length === 0) return { voidKots: [] as KotRecord[], printJobs: [] as PrintJobRecord[] };

      const byStation = new Map<
        string,
        { station: RestaurantStationRecord; items: typeof sent }
      >();
      for (const item of sent) {
        const resolved = await restaurantRepository.resolveStationForVoidItem(
          client,
          item.id,
          item.kitchenStation,
        );
        const key = resolved.code.toUpperCase();
        const bucket = byStation.get(key) || { station: resolved, items: [] };
        bucket.items.push(item);
        byStation.set(key, bucket);
      }

      const cancelledByName = await lookupUserDisplayName(client, cancelledBy);
      const kots: KotRecord[] = [];
      const jobs: PrintJobRecord[] = [];
      for (const { station, items } of byStation.values()) {
        const kot = await restaurantRepository.createKot(client, {
          orderId,
          tableCode: meta.tableCode,
          tableName: meta.tableName,
          waiterName: cancelledByName || meta.waiterName,
          station: station.code,
          firedBy: cancelledBy,
          ticketKind: 'VOID',
          voidReason: reason.trim() || 'Check cancelled',
          items: toConsolidatedKotItems(
            items.map((it) => ({
              id: it.id,
              productId: it.productId,
              productName: it.productName,
              quantity: Money.toNumber(Money.parseDb(it.quantity)),
              lineNotes: it.lineNotes,
            })),
          ),
        });
        kot.printerName = station.printerName;
        applyKotActorNames(kot, cancelledByName, meta.waiterName);
        kots.push(kot);
        const cancelJob = await printJobsService.enqueue(client, {
          documentType: 'VOID_KOT',
          targetPrinter: station.printerName,
          payloadJson: kotToPrintPayload(kot, meta),
          sourceType: 'restaurant_kot',
          sourceId: kot.id,
          orderId,
          stationCode: station.code,
        });
        if (cancelJob) jobs.push(cancelJob);
      }
      return { voidKots: kots, printJobs: jobs };
    });

    const order = await ordersService.cancelOrder(
      pool,
      orderId,
      cancelledBy,
      reason.trim() || 'Cancelled from restaurant POS',
    );
    await this.releaseTableForOrder(pool, orderId, {
      bumpVoids: true,
      updatedBy: cancelledBy,
    });
    publishNotificationEvent({
      pool,
      typeKey: 'RESTAURANT_ORDER_CANCELLED',
      entityType: 'restaurant_order',
      entityId: orderId,
      idempotencyKey: `RESTAURANT_ORDER_CANCELLED:restaurant_order:${orderId}`,
      payload: {
        summary: `Restaurant check cancelled`,
        documentRef: order.orderNumber || orderId,
      },
      actorUserId: cancelledBy,
    });
    return { order, tableId: meta.tableId, voidKots, printJobs };
  },

  // ─── Phase 3: Recipes / BOM ───────────────────────────────────────────

  async listRecipes(pool: Pool) {
    await assertRestaurantEnabled(pool);
    if (!(await recipeRepository.tableExists(pool))) {
      throw new BusinessError(
        'Recipe tables missing. Apply migration 565_restaurant_recipes.sql',
        'ERR_RESTAURANT_RECIPES_SCHEMA',
      );
    }
    return recipeRepository.listRecipes(pool);
  },

  async getRecipeByProduct(pool: Pool, parentProductId: string) {
    await assertRestaurantEnabled(pool);
    return recipeRepository.getByParentProductId(pool, parentProductId);
  },

  async upsertRecipe(
    pool: Pool,
    data: {
      parentProductId: string;
      name: string;
      isActive?: boolean;
      notes?: string | null;
      usageMode?: 'AT_SALE' | 'AT_PRODUCTION';
      lines: Array<{ componentProductId: string; quantityBase: number; sortOrder?: number }>;
    },
  ) {
    await assertRestaurantEnabled(pool);
    if (!(await recipeRepository.tableExists(pool))) {
      throw new BusinessError(
        'Recipe tables missing. Apply migration 565_restaurant_recipes.sql',
        'ERR_RESTAURANT_RECIPES_SCHEMA',
      );
    }
    if (!data.parentProductId) throw new ValidationError('Parent product is required');
    if (!data.name?.trim()) throw new ValidationError('Recipe name is required');
    if (!data.lines?.length) throw new ValidationError('At least one ingredient is required');

    const usageMode = data.usageMode === 'AT_PRODUCTION' ? 'AT_PRODUCTION' : 'AT_SALE';

    const parent = await pool.query(
      `SELECT id, name, product_type FROM products WHERE id = $1 AND COALESCE(is_active, TRUE) = TRUE`,
      [data.parentProductId],
    );
    if (!parent.rows[0]) throw new NotFoundError('Parent product');

    // Manufacture BOM: parent should be stockable (inventory/consumable)
    if (usageMode === 'AT_PRODUCTION' && parent.rows[0].product_type === 'service') {
      throw new ValidationError(
        'AT_PRODUCTION recipes require an inventory/consumable parent (prepared food). Use AT_SALE for service menu kits.',
      );
    }

    const seen = new Set<string>();
    for (const line of data.lines) {
      if (!line.componentProductId) throw new ValidationError('Ingredient product is required');
      if (!(line.quantityBase > 0)) throw new ValidationError('Ingredient quantity must be positive');
      if (line.componentProductId === data.parentProductId) {
        throw new ValidationError('A product cannot be an ingredient of itself');
      }
      if (seen.has(line.componentProductId)) {
        throw new ValidationError('Duplicate ingredient on recipe');
      }
      seen.add(line.componentProductId);

      const comp = await pool.query(
        `SELECT id, name, product_type FROM products WHERE id = $1 AND COALESCE(is_active, TRUE) = TRUE`,
        [line.componentProductId],
      );
      if (!comp.rows[0]) throw new NotFoundError(`Ingredient product ${line.componentProductId}`);
      if (comp.rows[0].product_type === 'service') {
        throw new ValidationError(`Ingredient "${comp.rows[0].name}" cannot be a service product`);
      }

      // Phase 3: one-level BOM only — refuse nested recipes
      const nested = await recipeRepository.getByParentProductId(pool, line.componentProductId);
      if (nested?.isActive && nested.lines.length > 0) {
        throw new ValidationError(
          `Ingredient "${comp.rows[0].name}" has its own recipe. Phase 3 supports one-level BOM only.`,
        );
      }
    }

    return recipeRepository.upsertRecipe(pool, { ...data, usageMode });
  },

  async deleteRecipe(pool: Pool, id: string) {
    await assertRestaurantEnabled(pool);
    const ok = await recipeRepository.deleteRecipe(pool, id);
    if (!ok) throw new NotFoundError('Recipe');
    return { deleted: true };
  },

  // ─── Phase 4: Split / Merge / Transfer ───────────────────────────────

  async transferCheck(
    pool: Pool,
    orderId: string,
    toTableId: string,
    actorId: string,
    actor?: OwnershipActor,
  ) {
    await assertRestaurantEnabled(pool);
    const meta = await restaurantRepository.getOrderRestaurantMeta(pool, orderId);
    if (!meta || meta.orderChannel === 'RETAIL') {
      throw new BusinessError('Not a restaurant check', 'ERR_RESTAURANT_CHANNEL');
    }
    await requireOrderMutationAccess(pool, meta, actor || { userId: actorId });
    const order = await ordersService.getOrder(pool, orderId);
    if (order.status !== 'PENDING') {
      throw new BusinessError('Only open checks can transfer', 'ERR_RESTAURANT_CHECK_CLOSED');
    }
    if (!meta.tableId) throw new ValidationError('Check has no table');
    if (meta.tableId === toTableId) {
      throw new ValidationError('Check is already on that table');
    }

    const fromTable = await restaurantRepository.getTableById(pool, meta.tableId);
    const toTable = await restaurantRepository.getTableById(pool, toTableId);
    if (!fromTable || !toTable || !toTable.isActive) throw new NotFoundError('Restaurant table');
    if (toTable.status !== 'FREE' || toTable.currentOrderId) {
      throw new BusinessError('Target table must be free', 'ERR_RESTAURANT_TABLE_BUSY');
    }

    const lockFrom = `restaurant_table_${meta.tableId}`;
    const lockTo = `restaurant_table_${toTableId}`;
    await pool.query(`SELECT pg_advisory_lock(hashtext($1)), pg_advisory_lock(hashtext($2))`, [
      lockFrom,
      lockTo,
    ]);
    try {
      await UnitOfWork.run(pool, async (client: PoolClient) => {
        const lockedTo = await restaurantRepository.getTableById(client, toTableId);
        if (!lockedTo || lockedTo.status !== 'FREE' || lockedTo.currentOrderId) {
          throw new BusinessError('Target table must be free', 'ERR_RESTAURANT_TABLE_BUSY');
        }
        await restaurantRepository.patchOrderRestaurantFields(client, orderId, {
          tableId: toTableId,
          orderChannel: channelForTable(lockedTo),
        });
        await restaurantRepository.releaseTableByOrderId(client, orderId);
        // releaseTableByOrderId may have re-pointed from-table; force clear if still pointing here
        const fromNow = await restaurantRepository.getTableById(client, meta.tableId!);
        if (fromNow?.currentOrderId === orderId) {
          await restaurantRepository.releaseTable(client, meta.tableId!);
        }
        await restaurantRepository.occupyTable(client, toTableId, orderId);
      });
    } finally {
      await pool.query(`SELECT pg_advisory_unlock(hashtext($1)), pg_advisory_unlock(hashtext($2))`, [
        lockFrom,
        lockTo,
      ]);
    }

    logger.info('Restaurant check transferred', { orderId, from: meta.tableId, to: toTableId });
    return {
      order: await ordersService.getOrder(pool, orderId),
      meta: await restaurantRepository.getOrderRestaurantMeta(pool, orderId),
      fromTableId: meta.tableId,
      toTableId,
    };
  },

  async mergeChecks(
    pool: Pool,
    primaryOrderId: string,
    secondaryOrderId: string,
    actorId: string,
    actor?: OwnershipActor,
  ) {
    await assertRestaurantEnabled(pool);
    if (primaryOrderId === secondaryOrderId) {
      throw new ValidationError('Cannot merge a check into itself');
    }

    const primaryMeta = await restaurantRepository.getOrderRestaurantMeta(pool, primaryOrderId);
    const secondaryMeta = await restaurantRepository.getOrderRestaurantMeta(pool, secondaryOrderId);
    if (!primaryMeta || primaryMeta.orderChannel === 'RETAIL') {
      throw new BusinessError('Primary is not a restaurant check', 'ERR_RESTAURANT_CHANNEL');
    }
    if (!secondaryMeta || secondaryMeta.orderChannel === 'RETAIL') {
      throw new BusinessError('Secondary is not a restaurant check', 'ERR_RESTAURANT_CHANNEL');
    }
    const ownership = actor || { userId: actorId };
    await requireOrderMutationAccess(pool, primaryMeta, ownership);
    await requireOrderMutationAccess(pool, secondaryMeta, ownership);

    const primary = await ordersService.getOrder(pool, primaryOrderId);
    const secondary = await ordersService.getOrder(pool, secondaryOrderId);
    if (primary.status !== 'PENDING' || secondary.status !== 'PENDING') {
      throw new BusinessError('Both checks must be open to merge', 'ERR_RESTAURANT_CHECK_CLOSED');
    }

    // Samba: merge only tickets on the same dining table.
    if (!primaryMeta.tableId || primaryMeta.tableId !== secondaryMeta.tableId) {
      throw new ValidationError(
        'Merge only works for tickets on the same table — use Change table first if needed',
      );
    }

    const secondaryItems = secondary.items || [];
    if (secondaryItems.length === 0) {
      throw new ValidationError('Secondary check has no items');
    }

    const itemIds = secondaryItems.map((i) => i.id);
    await UnitOfWork.run(pool, async (client: PoolClient) => {
      const moved = await restaurantRepository.moveOrderItems(client, itemIds, primaryOrderId);
      if (moved !== itemIds.length) {
        throw new BusinessError('Failed to move all items for merge', 'ERR_RESTAURANT_MERGE');
      }
      await restaurantRepository.reassignKotsToOrder(client, secondaryOrderId, primaryOrderId);

      const primaryFresh = await ordersRepository.getById(client, primaryOrderId);
      // Recalc from items after move
      const items = primaryFresh?.items || [];
      const tax = await computeRestaurantDocumentTax(
        client,
        items,
        primaryFresh?.customerId,
      );
      const totals = recalcFromItems(items, tax);
      await restaurantRepository.updateOrderTotals(client, primaryOrderId, totals);
    });

    await ordersService.cancelOrder(
      pool,
      secondaryOrderId,
      actorId,
      `Merged into ${primary.orderNumber}`,
    );
    await this.releaseTableForOrder(pool, secondaryOrderId);

    // Ensure primary owns its floor pointer when on a table
    if (primaryMeta.tableId) {
      const table = await restaurantRepository.getTableById(pool, primaryMeta.tableId);
      if (table && (!table.currentOrderId || table.currentOrderId === secondaryOrderId)) {
        await restaurantRepository.setTableCurrentOrder(pool, primaryMeta.tableId, primaryOrderId);
      }
    }

    logger.info('Restaurant checks merged', { primaryOrderId, secondaryOrderId });
    return {
      order: await ordersService.getOrder(pool, primaryOrderId),
      meta: await restaurantRepository.getOrderRestaurantMeta(pool, primaryOrderId),
      cancelledOrderId: secondaryOrderId,
    };
  },

  /**
   * Split selected lines (or partial quantities) onto a new check.
   * Samba Move: whole lines move via order_id reassignment; partial qty clones
   * a sibling row onto the dest check and reduces the source (kitchen_sent_at preserved).
   */
  async splitCheck(
    pool: Pool,
    sourceOrderId: string,
    input: {
      itemIds?: string[];
      items?: Array<{ itemId: string; quantity?: number }>;
      targetTableId: string;
      actorId: string;
      sameTable?: boolean;
      actor?: OwnershipActor;
    },
  ) {
    await assertRestaurantEnabled(pool);

    const moveRequests = new Map<string, number | 'FULL'>();
    if (input.items?.length) {
      for (const row of input.items) {
        if (row.quantity === undefined) {
          moveRequests.set(row.itemId, 'FULL');
          continue;
        }
        if (!(row.quantity > 0)) {
          throw new ValidationError('Move quantity must be positive');
        }
        const prev = moveRequests.get(row.itemId);
        if (prev === 'FULL') continue;
        moveRequests.set(row.itemId, (typeof prev === 'number' ? prev : 0) + row.quantity);
      }
    } else if (input.itemIds?.length) {
      for (const id of input.itemIds) moveRequests.set(id, 'FULL');
    }
    if (moveRequests.size === 0) {
      throw new ValidationError('Select at least one line to split');
    }

    const sourceMeta = await restaurantRepository.getOrderRestaurantMeta(pool, sourceOrderId);
    if (!sourceMeta || sourceMeta.orderChannel === 'RETAIL') {
      throw new BusinessError('Not a restaurant check', 'ERR_RESTAURANT_CHANNEL');
    }
    await requireOrderMutationAccess(
      pool,
      sourceMeta,
      input.actor || { userId: input.actorId },
    );
    const source = await ordersService.getOrder(pool, sourceOrderId);
    if (source.status !== 'PENDING') {
      throw new BusinessError('Only open checks can split', 'ERR_RESTAURANT_CHECK_CLOSED');
    }

    const sourceItems = source.items || [];
    const byId = new Map(sourceItems.map((i) => [i.id, i]));
    type MoveSlice = {
      itemId: string;
      onHand: number;
      moveQty: number;
      unitPrice: number;
      discountAmount: number;
    };
    const slices: MoveSlice[] = [];
    for (const [itemId, req] of moveRequests) {
      const row = byId.get(itemId);
      if (!row) {
        throw new ValidationError('One or more lines are not on this check');
      }
      const onHand = Money.toNumber(Money.parseDb(String(row.quantity)));
      const moveQty = req === 'FULL' ? onHand : req;
      if (moveQty > onHand + 1e-9) {
        throw new ValidationError(
          `Cannot move ${moveQty} of "${row.productName}" — only ${onHand} on the check`,
        );
      }
      slices.push({
        itemId,
        onHand,
        moveQty,
        unitPrice: Money.toNumber(Money.parseDb(String(row.unitPrice))),
        discountAmount: Money.toNumber(Money.parseDb(String(row.discountAmount || 0))),
      });
    }

    // After moves, at least one unit must remain on the source check.
    let remainingUnits = sourceItems.reduce(
      (s, it) => s + Money.toNumber(Money.parseDb(String(it.quantity))),
      0,
    );
    for (const slice of slices) remainingUnits -= slice.moveQty;
    if (remainingUnits <= 1e-9) {
      throw new ValidationError('Cannot split all lines — leave at least one on the source check');
    }

    const sameTable =
      !!input.sameTable || input.targetTableId === sourceMeta.tableId;
    let targetTable = await restaurantRepository.getTableById(pool, input.targetTableId);
    if (!targetTable || !targetTable.isActive) throw new NotFoundError('Target table');

    if (!sameTable) {
      if (targetTable.status !== 'FREE' || targetTable.currentOrderId) {
        throw new BusinessError('Target table must be free', 'ERR_RESTAURANT_TABLE_BUSY');
      }
    } else if (!sourceMeta.tableId) {
      throw new ValidationError('Source check has no table for same-table split');
    }

    const lockKeys = sameTable
      ? [`restaurant_table_${sourceMeta.tableId}`]
      : [`restaurant_table_${sourceMeta.tableId}`, `restaurant_table_${input.targetTableId}`];

    for (const k of lockKeys) {
      await pool.query(`SELECT pg_advisory_lock(hashtext($1))`, [k]);
    }

    let newOrderId = '';
    try {
      await UnitOfWork.run(pool, async (client: PoolClient) => {
        if (!sameTable) {
          const lockedTo = await restaurantRepository.getTableById(client, input.targetTableId);
          if (!lockedTo || lockedTo.status !== 'FREE' || lockedTo.currentOrderId) {
            throw new BusinessError('Target table must be free', 'ERR_RESTAURANT_TABLE_BUSY');
          }
          targetTable = lockedTo;
        }

        const destTableId = sameTable ? sourceMeta.tableId! : input.targetTableId;
        const destChannel = channelForTable(
          (await restaurantRepository.getTableById(client, destTableId))!,
        );

        const header = await ordersRepository.createOrder(client, {
          customerId: source.customerId,
          subtotal: 0,
          discountAmount: 0,
          taxAmount: 0,
          totalAmount: 0,
          createdBy: input.actorId,
          notes: `Split from ${source.orderNumber}`,
        });
        newOrderId = header.id;

        await restaurantRepository.patchOrderRestaurantFields(client, newOrderId, {
          tableId: destTableId,
          orderChannel: destChannel,
          waiterId: sourceMeta.waiterId,
          kitchenStatus: 'NONE',
          guestName: sourceMeta.guestName,
          guestPhone: sourceMeta.guestPhone,
          deliveryAddress: sourceMeta.deliveryAddress,
          pickupLabel: sourceMeta.pickupLabel,
        });

        const fullMoveIds: string[] = [];
        for (const slice of slices) {
          if (slice.moveQty >= slice.onHand - 1e-9) {
            fullMoveIds.push(slice.itemId);
            continue;
          }
          const cloned = await restaurantRepository.cloneOrderItemPartial(
            client,
            slice.itemId,
            sourceOrderId,
            newOrderId,
            slice.moveQty,
          );
          if (!cloned) {
            throw new BusinessError('Failed to split partial quantity', 'ERR_RESTAURANT_SPLIT');
          }
          const remainQty = slice.onHand - slice.moveQty;
          const remainDiscount =
            slice.onHand > 0
              ? Number(
                new Decimal(slice.discountAmount)
                  .times(remainQty)
                  .div(slice.onHand)
                  .toFixed(2),
              )
              : 0;
          const reduced = await restaurantRepository.reduceOrderItemQuantity(
            client,
            sourceOrderId,
            slice.itemId,
            remainQty,
            { discountAmount: remainDiscount },
          );
          if (!reduced) {
            throw new BusinessError('Failed to reduce source line after split', 'ERR_RESTAURANT_SPLIT');
          }
        }

        if (fullMoveIds.length > 0) {
          const moved = await restaurantRepository.moveOrderItems(
            client,
            fullMoveIds,
            newOrderId,
          );
          if (moved !== fullMoveIds.length) {
            throw new BusinessError('Failed to move split lines', 'ERR_RESTAURANT_SPLIT');
          }
          // KOTs whose items all left the source follow the dest check (merge parity).
          await restaurantRepository.reassignOrphanedKotsAfterItemMove(
            client,
            sourceOrderId,
            newOrderId,
          );
        }

        const sourceFresh = await ordersRepository.getById(client, sourceOrderId);
        const destFresh = await ordersRepository.getById(client, newOrderId);
        for (const [oid, fresh] of [
          [sourceOrderId, sourceFresh],
          [newOrderId, destFresh],
        ] as const) {
          const items = fresh?.items || [];
          const tax = await computeRestaurantDocumentTax(client, items, fresh?.customerId);
          await restaurantRepository.updateOrderTotals(client, oid, recalcFromItems(items, tax));
        }

        // Keep kitchenStatus aligned with KOTs / kitchen_sent_at on both checks.
        for (const oid of [sourceOrderId, newOrderId]) {
          const synced = await restaurantRepository.syncOrderKitchenStatusFromKots(client, oid);
          if (synced === 'NONE') {
            const fresh = await ordersRepository.getById(client, oid);
            const stillSent = (fresh?.items || []).some((it) => !!it.kitchenSentAt);
            if (stillSent) {
              await restaurantRepository.patchOrderRestaurantFields(client, oid, {
                kitchenStatus: 'SENT',
              });
            }
          }
        }

        if (!sameTable) {
          await restaurantRepository.occupyTable(client, destTableId, newOrderId);
        }
      });
    } finally {
      for (const k of lockKeys) {
        await pool.query(`SELECT pg_advisory_unlock(hashtext($1))`, [k]);
      }
    }

    logger.info('Restaurant check split', {
      sourceOrderId,
      newOrderId,
      itemCount: slices.length,
      sameTable,
      targetTableId: input.targetTableId,
    });

    return {
      source: {
        order: await ordersService.getOrder(pool, sourceOrderId),
        meta: await restaurantRepository.getOrderRestaurantMeta(pool, sourceOrderId),
      },
      split: {
        order: await ordersService.getOrder(pool, newOrderId),
        meta: await restaurantRepository.getOrderRestaurantMeta(pool, newOrderId),
      },
    };
  },

  async listOrderTagCatalog(pool: Pool) {
    await assertRestaurantEnabled(pool);
    return orderTagRepository.listGroupsWithTags(pool, { activeOnly: true });
  },

  async listOrderTagsForProduct(pool: Pool, productId: string) {
    await assertRestaurantEnabled(pool);
    return orderTagRepository.listGroupsForProduct(pool, productId);
  },

  async upsertOrderTagGroup(
    pool: Pool,
    data: {
      id?: string;
      name: string;
      sortOrder?: number;
      minSelect?: number;
      maxSelect?: number | null;
      autoPrompt?: boolean;
      isActive?: boolean;
    },
  ) {
    await assertRestaurantEnabled(pool);
    if (!data.name?.trim()) throw new ValidationError('Tag group name is required');
    return orderTagRepository.upsertGroup(pool, data);
  },

  async upsertOrderTag(
    pool: Pool,
    data: {
      id?: string;
      groupId: string;
      label: string;
      prefix?: string | null;
      price?: number;
      sortOrder?: number;
      isActive?: boolean;
    },
  ) {
    await assertRestaurantEnabled(pool);
    if (!data.groupId) throw new ValidationError('groupId is required');
    if (!data.label?.trim()) throw new ValidationError('Tag label is required');
    return orderTagRepository.upsertTag(pool, data);
  },

  async mapOrderTagGroup(
    pool: Pool,
    data: { groupId: string; productId?: string | null; categoryId?: string | null },
  ) {
    await assertRestaurantEnabled(pool);
    if (!data.groupId) throw new ValidationError('groupId is required');
    await orderTagRepository.setGroupMapping(pool, data);
    return { ok: true };
  },

  /**
   * Attach/replace Samba order tags on an open line (before or after paint; KOT uses line_notes).
   * Blocks tag edits after kitchen fire to avoid silent KOT drift — void + re-add instead.
   */
  async setOrderItemTags(
    pool: Pool,
    input: {
      orderId: string;
      itemId: string;
      orderTags?: RestaurantOrderTagSelection[] | null;
      freeText?: string | null;
      actor?: OwnershipActor;
    },
  ) {
    await assertRestaurantEnabled(pool);
    const order = await ordersRepository.getById(pool, input.orderId);
    if (!order || order.status !== 'PENDING') {
      throw new BusinessError('Check is not open', 'ERR_RESTAURANT_CHECK_CLOSED');
    }
    const metaEarly = await restaurantRepository.getOrderRestaurantMeta(pool, input.orderId);
    await requireOrderMutationAccess(pool, metaEarly, input.actor);
    const item = (order.items || []).find((it) => it.id === input.itemId);
    if (!item) throw new NotFoundError('Order item');
    if (item.kitchenSentAt) {
      throw new BusinessError(
        'Cannot change tags after KOT — void the line and re-add',
        'ERR_RESTAURANT_TAGS_LOCKED',
      );
    }

    const resolved = resolveItemNotesAndPrice({
      productId: item.productId || '',
      quantity: Number(item.quantity) || 1,
      lineNotes: input.freeText ?? null,
      orderTags: input.orderTags ?? [],
    });

    // Rebuild unit price: strip prior tag prices then apply new delta.
    const priorTags = Array.isArray((item as { orderTags?: unknown }).orderTags)
      ? ((item as { orderTags?: RestaurantOrderTagSelection[] }).orderTags || [])
      : [];
    // Prefer reading order_tags from DB when column exists.
    let priorPrice = 0;
    await UnitOfWork.run(pool, async (client) => {
      const tagCol = await client.query(
        `SELECT order_tags, unit_price::text AS "unitPrice", quantity::text AS quantity,
                discount_amount::text AS "discountAmount"
         FROM pos_order_items WHERE id = $1 FOR UPDATE`,
        [input.itemId],
      );
      if (!tagCol.rows[0]) throw new NotFoundError('Order item');
      const rawTags = tagCol.rows[0].order_tags;
      const existingTags: RestaurantOrderTagSelection[] = Array.isArray(rawTags)
        ? rawTags
        : typeof rawTags === 'string'
          ? (JSON.parse(rawTags) as RestaurantOrderTagSelection[])
          : priorTags;
      priorPrice = sumOrderTagPrices(existingTags);
      const currentUnit = Money.parseDb(String(tagCol.rows[0].unitPrice));
      const base = currentUnit.minus(priorPrice);
      const nextUnit = Money.toNumber(
        Money.round(base.plus(resolved.priceDelta).lessThan(0) ? new Decimal(0) : base.plus(resolved.priceDelta), 2),
      );
      const qty = Money.parseDb(String(tagCol.rows[0].quantity));
      const lineTotal = Money.toNumber(Money.round(qty.times(nextUnit), 2));
      await client.query(
        `UPDATE pos_order_items
         SET unit_price = $2, line_total = $3
         WHERE id = $1`,
        [input.itemId, nextUnit, lineTotal],
      );
      await orderTagRepository.setOrderItemTags(
        client,
        input.itemId,
        resolved.orderTags,
        resolved.lineNotes,
      );

      const refreshed = await ordersRepository.getById(client, input.orderId);
      const tax = await computeRestaurantDocumentTax(
        client,
        refreshed?.items || [],
        refreshed?.customerId,
      );
      await restaurantRepository.updateOrderTotals(
        client,
        input.orderId,
        recalcFromItems(refreshed?.items || [], tax),
      );
    });

    return {
      order: await ordersService.getOrder(pool, input.orderId),
      meta: await restaurantRepository.getOrderRestaurantMeta(pool, input.orderId),
    };
  },
};
