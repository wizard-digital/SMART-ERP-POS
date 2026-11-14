/**
 * Pure optimistic check painters for online FOH adds.
 * Keeps the ticket responsive while addItems + soft refresh run in the background.
 */

export type OptimisticChannel = 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY';

export type OptimisticTicketTab = {
  id: string;
  orderNumber: string;
  totalAmount: string;
  /** User FOA note (optional; shown on party list). */
  note?: string | null;
};

export type OptimisticOrderItem = {
  id: string;
  productId: string | null;
  productName: string;
  quantity: string;
  unitPrice: string;
  lineTotal: string;
  discountAmount: string;
  kitchenSentAt?: string | null;
  addedBy?: string | null;
  addedByName?: string | null;
  addedAt?: string | null;
};

export type OptimisticCheckPayload = {
  table: {
    id: string;
    code: string;
    name: string;
    zone?: string;
    seats?: number;
    status: 'FREE' | 'OCCUPIED' | 'BILLING';
    currentOrderId: string | null;
    orderTotal?: string | null;
    guestName?: string | null;
  };
  order: {
    id: string;
    orderNumber: string;
    subtotal: string;
    discountAmount: string;
    taxAmount: string;
    totalAmount: string;
    status: string;
    items: OptimisticOrderItem[];
    notes?: string | null;
  } | null;
  meta?: {
    tableCode: string | null;
    tableName: string | null;
    waiterId: string | null;
    waiterName: string | null;
    kitchenStatus: string;
    orderChannel: string;
    guestName?: string | null;
    guestPhone?: string | null;
    deliveryAddress?: string | null;
    pickupLabel?: string | null;
  };
  siblingChecks?: Array<{
    id: string;
    orderNumber: string;
    totalAmount: string;
    createdAt: string;
    notes?: string | null;
  }>;
};

export type InFlightOptimisticLine = {
  tempLineId: string;
  productId: string;
  productName: string;
  quantity: number;
  unitPrice: number;
};

export function isTempRestaurantId(id: string | null | undefined): boolean {
  if (!id) return false;
  return id.startsWith('tmp_line_') || id.startsWith('tmp_ord_');
}

/**
 * Only real server check UUIDs may be sent as ?orderId= / activateCheck body.
 * Optimistic tmp_ord_* and journal ofl_ord_* must never hit Postgres UUID columns.
 */
export function toServerRestaurantOrderId(
  id: string | null | undefined,
): string | undefined {
  if (!id) return undefined;
  if (isTempRestaurantId(id)) return undefined;
  if (id.startsWith('ofl_ord_') || id.startsWith('ofl_')) return undefined;
  // Loose UUID shape — reject labels that would 500 as 22P02.
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      id,
    )
  ) {
    return undefined;
  }
  return id;
}

export function newTempLineId(now = Date.now()): string {
  return `tmp_line_${now}_${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Ticket tabs / sibling chips must never expose optimistic tmp_ord_* ghosts.
 * Those ghosts caused activate-check 400 (Invalid uuid) after first online add.
 */
export function scrubRestaurantTicketTabs(
  tabs: OptimisticTicketTab[],
): OptimisticTicketTab[] {
  const out: OptimisticTicketTab[] = [];
  for (const t of tabs) {
    if (!t?.id || isTempRestaurantId(t.id)) continue;
    if (out.some((x) => x.id === t.id)) continue;
    out.push(t);
  }
  return out;
}

function isJournalLocalOrderId(id: string): boolean {
  return id.startsWith('ofl_ord_') || id.startsWith('ofl_');
}

/**
 * Merge multi-ticket strip without wiping server siblings or resurrecting closed checks.
 *
 * - Always keep `data.siblingChecks` (PENDING / authoritative when from API).
 * - Add `knownTabs` for mid-switch continuity.
 * - When `openOrderIds` is provided, drop known UUID tabs not in that set
 *   (paid/cancelled → activate-check ERR_RESTAURANT_CHECK_CLOSED).
 * - Journal-local `ofl_*` ids are always eligible when present in knownTabs.
 */
export function mergeRestaurantSiblingTabs(
  data: OptimisticCheckPayload,
  knownTabs: OptimisticTicketTab[],
  openOrderIds?: ReadonlySet<string>,
): OptimisticCheckPayload {
  const activeId = data.order?.id ?? null;
  const byId = new Map<
    string,
    NonNullable<OptimisticCheckPayload['siblingChecks']>[number]
  >();

  for (const s of data.siblingChecks || []) {
    if (!s?.id || s.id === activeId || isTempRestaurantId(s.id)) continue;
    byId.set(s.id, { ...s, notes: preferUserTicketNote(s.notes) });
  }

  for (const t of scrubRestaurantTicketTabs(knownTabs)) {
    if (!t.id || t.id === activeId || byId.has(t.id)) continue;
    if (isTempRestaurantId(t.id)) continue;
    if (openOrderIds && !openOrderIds.has(t.id) && !isJournalLocalOrderId(t.id)) {
      continue;
    }
    byId.set(t.id, {
      id: t.id,
      orderNumber: t.orderNumber,
      totalAmount: t.totalAmount,
      createdAt: new Date().toISOString(),
      notes: preferUserTicketNote(t.note),
    });
  }

  const siblings = Array.from(byId.values());
  if (siblings.length === 0 && !Array.isArray(data.siblingChecks)) {
    return data;
  }
  return { ...data, siblingChecks: siblings };
}

function attachSiblingTabs(
  data: OptimisticCheckPayload,
  knownTabs: OptimisticTicketTab[],
): OptimisticCheckPayload {
  return mergeRestaurantSiblingTabs(data, knownTabs);
}

function recalculateTotals(
  items: OptimisticOrderItem[],
  discountAmount: number,
  taxAmount: number,
): { subtotal: number; total: number } {
  const subtotal = items.reduce((s, it) => s + Number(it.lineTotal || 0), 0);
  return {
    subtotal,
    total: subtotal - discountAmount + taxAmount,
  };
}

/**
 * Query-key ids that must receive an add paint.
 * FOH reads ['restaurant','check', tableId, activeOrderId]. Adds that only
 * wrote [table, targetOrderId] left [table, null] stale until KOT refetch.
 */
export function restaurantCheckQueryPaintIds(input: {
  paintedOrderId: string | null | undefined;
  targetOrderId?: string | null;
  displayedOrderId: string | null | undefined;
}): Array<string | null> {
  const ids = new Set<string | null>();
  const painted = input.paintedOrderId ?? null;
  ids.add(painted);
  if (input.targetOrderId !== undefined) ids.add(input.targetOrderId);
  const displayed = input.displayedOrderId ?? null;
  if (displayed === null || displayed === painted || displayed === (input.targetOrderId ?? null)) {
    ids.add(displayed);
  }
  return [...ids];
}

/** Table-open GET started before an add must not replace the painted ticket. */
export function shouldDiscardStaleCheckFetch(startedGen: number, paintGen: number): boolean {
  return paintGen > startedGen;
}

/** System journal / seed notes — never show as FOA ticket notes. */
function isSystemGeneratedTicketNote(notes: string | null | undefined): boolean {
  const n = (notes || '').trim();
  if (!n) return true;
  return (
    /^hydrated\b/i.test(n) ||
    /^Restaurant\s+.+\s*·\s*ticket$/i.test(n) ||
    /^Restaurant\s+\S+$/i.test(n) ||
    /^Split from\s+/i.test(n)
  );
}

/** User-facing FOA note only. Journal "Hydrated T1" / "Restaurant T1" are not ticket notes. */
export function displayTicketNote(notes: string | null | undefined): string {
  if (isSystemGeneratedTicketNote(notes)) return '';
  return (notes || '').trim();
}

/**
 * Waiter-facing note on the open check body (with or without lines).
 * Party list and the empty loading shell do not paint the check-body note.
 */
export function resolveTicketNoteOnCheckPaint(input: {
  partyListVisible: boolean;
  loadingEmptyTicket: boolean;
  hasOrder: boolean;
  notes: string | null | undefined;
}): { paint: 'on-check' | 'hidden'; visibleText: string } {
  if (input.partyListVisible || input.loadingEmptyTicket || !input.hasOrder) {
    return { paint: 'hidden', visibleText: '' };
  }
  return { paint: 'on-check', visibleText: displayTicketNote(input.notes) };
}

/** First real FOA note from server / paint / journal (system seed text skipped). */
export function preferUserTicketNote(
  ...candidates: Array<string | null | undefined>
): string | null {
  for (const c of candidates) {
    const n = displayTicketNote(c);
    if (n) return n;
  }
  return null;
}

export function sanitizeCheckTicketNotes<
  T extends {
    order?: { notes?: string | null } | null;
    siblingChecks?: Array<{ notes?: string | null }>;
  },
>(payload: T): T {
  const order = payload.order
    ? { ...payload.order, notes: preferUserTicketNote(payload.order.notes) }
    : payload.order;
  const siblingChecks = payload.siblingChecks
    ? payload.siblingChecks.map((s) => ({
        ...s,
        notes: preferUserTicketNote(s.notes),
      }))
    : payload.siblingChecks;
  return { ...payload, order, siblingChecks };
}

/**
 * FOA ticket note — header + party-list sibling row. Does not touch lines/totals.
 */
export function applyTicketNoteToCheck<
  T extends {
    order?: { id?: string; notes?: string | null } | null;
    siblingChecks?: Array<{ id: string; notes?: string | null }>;
  },
>(payload: T | undefined, orderId: string, notes: string | null): T | undefined {
  if (!payload || !orderId) return payload;
  const nextNotes = preferUserTicketNote(notes);
  const order =
    payload.order?.id === orderId
      ? { ...payload.order, notes: nextNotes }
      : payload.order;
  const siblingChecks = (payload.siblingChecks || []).map((s) =>
    s.id === orderId ? { ...s, notes: nextNotes } : s,
  );
  return sanitizeCheckTicketNotes({ ...payload, order, siblingChecks });
}

export function applyTicketNoteToTabs(
  tabs: OptimisticTicketTab[],
  orderId: string,
  notes: string | null,
): OptimisticTicketTab[] {
  const nextNotes = preferUserTicketNote(notes);
  return tabs.map((t) => (t.id === orderId ? { ...t, note: nextNotes } : t));
}

/**
 * Check query vs in-place paint (add / KOT / ticket note).
 * An older in-flight GET must not blank a ticket the waiter already sees after
 * a newer paint (add / KOT). A live GET that returns order:null (FREE / settled)
 * must win — otherwise paid/cancelled tickets resurrect on reopen and KOT 400s.
 */
export function coalesceRestaurantCheckFetch<
  T extends {
    order?: { id?: string; items?: unknown[]; notes?: string | null } | null;
    siblingChecks?: Array<{ id: string; notes?: string | null }>;
  },
>(input: {
  startedGen: number;
  paintGen: number;
  cached: T | undefined;
  incoming: T;
}): T {
  const cachedCount = input.cached?.order?.items?.length ?? 0;
  const incomingCount = input.incoming?.order?.items?.length ?? 0;
  let primary = input.incoming;
  let secondary = input.cached;
  if (shouldDiscardStaleCheckFetch(input.startedGen, input.paintGen) && cachedCount > 0) {
    primary = input.cached as T;
    secondary = input.incoming;
  } else if (cachedCount > 0 && incomingCount === 0) {
    const incomingId = input.incoming.order?.id;
    // order:null = authoritative empty check (table free / paid / cancelled).
    // Never resurrect cached lines from a settled ticket.
    if (incomingId && incomingId === input.cached?.order?.id) {
      primary = input.cached as T;
      secondary = input.incoming;
    }
  }
  const orderId = primary.order?.id || secondary?.order?.id;
  if (!orderId) return sanitizeCheckTicketNotes(primary);
  return applyTicketNoteToCheck(
    primary,
    orderId,
    preferUserTicketNote(primary.order?.notes, secondary?.order?.notes),
  ) as T;
}

/** Optimistic ticket line for online add — UI paints before API returns. */
export function appendOptimisticMenuItem(
  prev: OptimisticCheckPayload | undefined,
  args: {
    table: OptimisticCheckPayload['table'];
    product: { id: string; name: string; sellingPrice?: number | string };
    quantity: number;
    tempLineId: string;
    channel: OptimisticChannel;
    waiterId?: string | null;
    waiterName?: string | null;
    /** Acting user who rang this add (may differ from check owner). */
    addedBy?: string | null;
    addedByName?: string | null;
    addedAt?: string | null;
    guestName?: string | null;
    guestPhone?: string | null;
    deliveryAddress?: string | null;
    pickupLabel?: string | null;
    knownTabs?: OptimisticTicketTab[];
    now?: number;
  },
): OptimisticCheckPayload {
  const qty = Math.max(1, args.quantity);
  const unitPrice = Number(args.product.sellingPrice) || 0;
  const lineTotal = qty * unitPrice;
  const newItem: OptimisticOrderItem = {
    id: args.tempLineId,
    productId: args.product.id,
    productName: args.product.name,
    quantity: String(qty),
    unitPrice: String(unitPrice),
    lineTotal: String(lineTotal),
    discountAmount: '0',
    kitchenSentAt: null,
    addedBy: args.addedBy ?? null,
    addedByName: args.addedByName ?? null,
    addedAt: args.addedAt ?? new Date().toISOString(),
  };
  const knownTabs = args.knownTabs || [];

  if (prev?.order) {
    const items = [...(prev.order.items || []), newItem];
    const { subtotal, total } = recalculateTotals(
      items,
      Number(prev.order.discountAmount || 0),
      Number(prev.order.taxAmount || 0),
    );
    return attachSiblingTabs(
      {
        ...prev,
        table: {
          ...prev.table,
          status: 'OCCUPIED',
          currentOrderId: prev.order.id,
          orderTotal: String(total),
        },
        order: {
          ...prev.order,
          items,
          subtotal: String(subtotal),
          totalAmount: String(total),
        },
      },
      knownTabs,
    );
  }

  const tempOrderId = `tmp_ord_${(args.now ?? Date.now()).toString(36)}`;
  return attachSiblingTabs(
    {
      table: {
        ...args.table,
        status: 'OCCUPIED',
        currentOrderId: tempOrderId,
        orderTotal: String(lineTotal),
        guestName: args.guestName ?? null,
      },
      order: {
        id: tempOrderId,
        orderNumber: '…',
        subtotal: String(lineTotal),
        discountAmount: '0',
        taxAmount: '0',
        totalAmount: String(lineTotal),
        status: 'PENDING',
        items: [newItem],
      },
      meta: {
        tableCode: args.table.code,
        tableName: args.table.name,
        orderChannel: args.channel,
        kitchenStatus: 'NONE',
        waiterId: args.waiterId ?? null,
        waiterName: args.waiterName ?? null,
        guestName: args.guestName ?? null,
        guestPhone: args.guestPhone ?? null,
        deliveryAddress: args.deliveryAddress ?? null,
        pickupLabel: args.pickupLabel ?? null,
      },
      siblingChecks: [],
    },
    knownTabs,
  );
}

/**
 * Keep in-flight optimistic lines visible when a soft refresh returns mid-tap race.
 * Confirmed server UUIDs replace temps; remaining temps stay until their mutation finishes.
 */
export function mergeInFlightOptimisticLines(
  data: OptimisticCheckPayload,
  inFlight: Iterable<InFlightOptimisticLine>,
): OptimisticCheckPayload {
  if (!data.order) return data;
  const flight = [...inFlight];
  if (flight.length === 0) return data;

  const existingIds = new Set(data.order.items.map((it) => it.id));
  const extras: OptimisticOrderItem[] = [];
  for (const f of flight) {
    if (existingIds.has(f.tempLineId)) continue;
    const qty = Math.max(1, f.quantity);
    const unitPrice = Number(f.unitPrice) || 0;
    extras.push({
      id: f.tempLineId,
      productId: f.productId,
      productName: f.productName,
      quantity: String(qty),
      unitPrice: String(unitPrice),
      lineTotal: String(qty * unitPrice),
      discountAmount: '0',
      kitchenSentAt: null,
    });
  }
  if (extras.length === 0) return data;

  const items = [...data.order.items, ...extras];
  const { subtotal, total } = recalculateTotals(
    items,
    Number(data.order.discountAmount || 0),
    Number(data.order.taxAmount || 0),
  );
  return {
    ...data,
    table: {
      ...data.table,
      status: 'OCCUPIED',
      currentOrderId: data.order.id,
      orderTotal: String(total),
    },
    order: {
      ...data.order,
      items,
      subtotal: String(subtotal),
      totalAmount: String(total),
    },
  };
}

/**
 * POST /checks/items body. Rejects envelopes that have no server check UUID —
 * those must not become FOH order.id (void/KOT would 400 "check required").
 */
export function readRestaurantAddItemsPayload(raw: unknown): {
  table: OptimisticCheckPayload['table'];
  order: NonNullable<OptimisticCheckPayload['order']>;
  meta: OptimisticCheckPayload['meta'];
} | null {
  if (!raw || typeof raw !== 'object') return null;
  const root = raw as Record<string, unknown>;
  const nested = root.data;
  const body =
    root.order && typeof root.order === 'object'
      ? root
      : nested && typeof nested === 'object' && (nested as Record<string, unknown>).order
        ? (nested as Record<string, unknown>)
        : null;
  if (!body) return null;
  const order = body.order;
  if (!order || typeof order !== 'object') return null;
  const id = toServerRestaurantOrderId((order as { id?: string }).id);
  if (!id) return null;
  if (!body.table || typeof body.table !== 'object') return null;
  return {
    table: body.table as OptimisticCheckPayload['table'],
    order: { ...(order as NonNullable<OptimisticCheckPayload['order']>), id },
    meta: (body.meta as OptimisticCheckPayload['meta']) || undefined,
  };
}

/** Minus on an optimistic line that has not been ACK'd — never POST tmp_line_* / tmp_ord_*. */
export function dropOptimisticCheckLines(
  prev: OptimisticCheckPayload | undefined,
  lineIds: string[],
): OptimisticCheckPayload | undefined {
  if (!prev?.order || lineIds.length === 0) return prev;
  const drop = new Set(lineIds);
  const items = prev.order.items.filter((it) => !drop.has(it.id));
  if (items.length === prev.order.items.length) return prev;
  const { subtotal, total } = recalculateTotals(
    items,
    Number(prev.order.discountAmount || 0),
    Number(prev.order.taxAmount || 0),
  );
  if (items.length === 0 && isTempRestaurantId(prev.order.id)) {
    return {
      ...prev,
      order: null,
      table: {
        ...prev.table,
        status: 'FREE',
        currentOrderId: null,
        orderTotal: null,
      },
    };
  }
  return {
    ...prev,
    table: { ...prev.table, orderTotal: String(total) },
    order: {
      ...prev.order,
      items,
      subtotal: String(subtotal),
      totalAmount: String(total),
    },
  };
}
