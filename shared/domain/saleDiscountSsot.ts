/**
 * Sale discount identity SSOT — SAP / Odoo / QuickBooks header model.
 *
 * - Unit price is the rung/catalog price (PR00). Never (net + discount) / qty.
 * - Line discount is the line markdown only. Never includes allocated cart.
 * - Line net = qty × unit − line discount.
 * - Cart/header discount reduces the document total. It is never written onto
 *   sale_items.discount_amount.
 * - Document total = sum(line nets) − cart  (+ tax when exclusive).
 * - The same shilling must not appear as a line markdown AND a document cut.
 *
 * sales.discount_amount may store cart + line as a reporting dump ("discount given").
 * Presentation must not use that dump as a second subtraction against line nets.
 *
 * Historic rows may have cart copied onto sale_items.discount_amount. Readers use
 * appliedLineDiscount = qty × unit − lineNet, not the stored dump.
 */

import Decimal from 'decimal.js';

export const SALE_DISCOUNT_MONEY_TOLERANCE = 0.02;

export const SALE_DISCOUNT_SSOT = {
  model: 'header_cart_plus_line_markdown',
  unitPrice: 'rung_or_catalog',
  lineDiscount: 'line_markdown_only',
  lineNet: 'qty * unit - line_discount',
  cartDiscount: 'document header; never copied onto sale_items.discount_amount',
  documentTotal: 'sum(line nets) - cart (+ tax if exclusive)',
  forbidden: [
    'Copy cart/header discount onto sale_items.discount_amount',
    'Derive persist unit_price from line net',
    'Reconstruct unit as (lineNet + discount) / qty',
    'Paint the same shilling as a line markdown and a document discount',
    'Allocate sales.discount_amount (cart+line) onto line.discount_amount',
    'Apply exchange store credit from header dump (cart+line) instead of cart only',
    'Treat exchange credit as a line markdown or invent a higher unit price',
    'Refund qty × catalog unit when the customer was charged line-net minus cart',
    'Leave cart discount in sales_daily_summary after a full return',
  ],
} as const;

export function documentReductionLabel(isExchangeCredit: boolean): string {
  return isExchangeCredit ? 'Exchange credit' : 'Discount';
}

export function roundSaleMoney(n: number): number {
  return new Decimal(n || 0).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();
}

export function lineNetFromRung(
  quantity: number,
  unitPrice: number,
  lineDiscount: number,
): number {
  return roundSaleMoney(
    new Decimal(quantity || 0).times(unitPrice || 0).minus(lineDiscount || 0).toNumber(),
  );
}

/** Markdown that actually left the line. Stored dump is ignored. */
export function appliedLineDiscount(
  quantity: number,
  unitPrice: number,
  lineNet: number,
): number {
  const applied = new Decimal(quantity || 0).times(unitPrice || 0).minus(lineNet || 0);
  if (applied.abs().lessThanOrEqualTo(SALE_DISCOUNT_MONEY_TOLERANCE)) return 0;
  if (applied.lessThan(0)) return 0;
  return roundSaleMoney(applied.toNumber());
}

export function remainingCartDiscount(
  merchandiseNet: number,
  totalAmount: number,
  taxAmount: number,
): number {
  const lines = new Decimal(merchandiseNet || 0);
  const total = new Decimal(totalAmount || 0);
  const tax = new Decimal(taxAmount || 0);
  const tol = SALE_DISCOUNT_MONEY_TOLERANCE;

  if (lines.minus(total).abs().lessThanOrEqualTo(tol)) return 0;

  if (tax.greaterThan(tol)) {
    const exclusivePretax = total.minus(tax);
    if (lines.minus(exclusivePretax).abs().lessThanOrEqualTo(tol)) return 0;
    const exclusiveCart = lines.minus(exclusivePretax);
    const inclusiveCart = lines.minus(total);
    if (
      inclusiveCart.greaterThan(tol) &&
      exclusiveCart.minus(inclusiveCart).abs().greaterThan(tol) &&
      inclusiveCart.lessThan(exclusiveCart)
    ) {
      return roundSaleMoney(inclusiveCart.toNumber());
    }
    if (exclusiveCart.greaterThan(tol)) {
      return roundSaleMoney(exclusiveCart.toNumber());
    }
  }

  const cart = lines.minus(total);
  if (cart.greaterThan(tol)) return roundSaleMoney(cart.toNumber());
  return 0;
}

export type SaleDiscountLineInput = {
  quantity: number;
  unitPrice: number;
  lineNet: number;
};

export type SaleDiscountLinePresentation = {
  unitPrice: number;
  lineDiscount: number;
  lineNet: number;
};

export type SaleDiscountPresentation = {
  lines: SaleDiscountLinePresentation[];
  merchandiseNet: number;
  cartDiscount: number;
  taxAmount: number;
  totalAmount: number;
  hasLineDiscounts: boolean;
  hasCartDiscount: boolean;
};

export function presentSaleDiscounts(input: {
  totalAmount: number;
  taxAmount?: number;
  items: SaleDiscountLineInput[];
}): SaleDiscountPresentation {
  const taxAmount = roundSaleMoney(input.taxAmount || 0);
  const totalAmount = roundSaleMoney(input.totalAmount || 0);
  const lines = (input.items || []).map((item) => {
    const quantity = Number(item.quantity || 0);
    const unitPrice = roundSaleMoney(item.unitPrice || 0);
    const lineNet = roundSaleMoney(item.lineNet || 0);
    return {
      unitPrice,
      lineDiscount: appliedLineDiscount(quantity, unitPrice, lineNet),
      lineNet,
    };
  });
  const merchandiseNet = roundSaleMoney(
    lines.reduce((sum, line) => sum + line.lineNet, 0),
  );
  const cartDiscount = remainingCartDiscount(merchandiseNet, totalAmount, taxAmount);
  return {
    lines,
    merchandiseNet,
    cartDiscount,
    taxAmount,
    totalAmount,
    hasLineDiscounts: lines.some((line) => line.lineDiscount > SALE_DISCOUNT_MONEY_TOLERANCE),
    hasCartDiscount: cartDiscount > SALE_DISCOUNT_MONEY_TOLERANCE,
  };
}

function num(...vals: unknown[]): number {
  for (const v of vals) {
    if (v == null || v === '') continue;
    const x = typeof v === 'number' ? v : parseFloat(String(v));
    if (Number.isFinite(x)) return x;
  }
  return 0;
}

/** Loose persisted sale/item rows (camel or snake). */
export function presentPersistedSaleDiscounts(
  sale: Record<string, unknown> | null | undefined,
  items: Array<Record<string, unknown>> | null | undefined,
): SaleDiscountPresentation {
  const row = sale || {};
  return presentSaleDiscounts({
    totalAmount: num(row.totalAmount, row.total_amount),
    taxAmount: num(row.taxAmount, row.tax_amount),
    items: (items || []).map((item) => ({
      quantity: num(item.quantity, item.qty),
      unitPrice: num(item.unitPrice, item.unit_price, item.price),
      lineNet: num(
        item.totalPrice,
        item.total_price,
        item.lineTotal,
        item.line_total,
        item.subtotal,
        item.totalAmount,
      ),
    })),
  });
}

/**
 * Spread cart discount onto line profit only. Never mutates discount_amount.
 * Last line receives remainder so shares sum to cart.
 */
export function cartDiscountProfitShares(
  lineNets: number[],
  cartDiscount: number,
  subtotal: number,
): number[] {
  const cart = new Decimal(cartDiscount || 0);
  const sub = new Decimal(subtotal || 0);
  if (cart.lessThanOrEqualTo(0) || sub.lessThanOrEqualTo(0) || lineNets.length === 0) {
    return lineNets.map(() => 0);
  }
  const shares: number[] = [];
  let allocated = new Decimal(0);
  for (let i = 0; i < lineNets.length; i += 1) {
    let share: Decimal;
    if (i === lineNets.length - 1) {
      share = cart.minus(allocated);
    } else {
      share = new Decimal(lineNets[i] || 0).times(cart).dividedBy(sub);
    }
    allocated = allocated.plus(share);
    shares.push(roundSaleMoney(share.toNumber()));
  }
  return shares;
}

/**
 * Exchange credit is store-credit (2210) applied as cart reduction.
 * It is never a line markdown and never cart+line.
 */
export function assertExchangeCreditIdentity(params: {
  cartDiscount: number;
  remainingCredit: number;
  merchandiseNet: number;
  chargedTotal: number;
  taxAmount?: number;
}): { ok: boolean; message: string; creditApplied: number } {
  const creditApplied = roundSaleMoney(params.cartDiscount || 0);
  const remaining = roundSaleMoney(params.remainingCredit || 0);
  const merchandiseNet = roundSaleMoney(params.merchandiseNet || 0);
  const chargedTotal = roundSaleMoney(params.chargedTotal || 0);
  const taxAmount = roundSaleMoney(params.taxAmount || 0);
  const tol = SALE_DISCOUNT_MONEY_TOLERANCE;

  if (creditApplied <= tol) {
    return {
      ok: false,
      message: 'Exchange credit requires a cart reduction on the replacement sale',
      creditApplied: 0,
    };
  }
  if (creditApplied > remaining + tol) {
    return {
      ok: false,
      message: `Exchange credit ${creditApplied.toFixed(2)} exceeds remaining ${remaining.toFixed(2)}`,
      creditApplied,
    };
  }
  if (creditApplied > merchandiseNet + tol) {
    return {
      ok: false,
      message: `Exchange credit ${creditApplied.toFixed(2)} exceeds replacement merchandise ${merchandiseNet.toFixed(2)}`,
      creditApplied,
    };
  }
  const cartFromTotals = remainingCartDiscount(merchandiseNet, chargedTotal, taxAmount);
  if (Math.abs(cartFromTotals - creditApplied) > tol) {
    return {
      ok: false,
      message:
        `Exchange credit ${creditApplied.toFixed(2)} does not equal charged reduction ` +
        `${cartFromTotals.toFixed(2)} (merchandise ${merchandiseNet.toFixed(2)} → total ${chargedTotal.toFixed(2)})`,
      creditApplied,
    };
  }
  return { ok: true, message: 'exchange credit identity OK', creditApplied };
}

export type SaleDiscountLinePersistInput = {
  quantity: number;
  unitPrice: number;
  lineDiscount?: number;
};

export type SaleDiscountPersistLine = {
  quantity: number;
  discountAmount: number;
  unitPrice: number;
  totalPrice: number;
};

export type SaleDiscountPersistProjection = {
  items: SaleDiscountPersistLine[];
  merchandiseNet: number;
  cartDiscount: number;
  headerDiscountDump: number;
  taxAmount: number;
  chargedTotal: number;
};

/**
 * Authoritative persist shape. Unit is the submitted rung/catalog price.
 * Line discount is the line markdown only. Cart stays on the header.
 */
export function projectSaleDiscountPersist(params: {
  items: SaleDiscountLinePersistInput[];
  cartDiscount: number;
  taxAmount?: number;
  taxInclusive?: boolean;
}): SaleDiscountPersistProjection {
  const cartDiscount = roundSaleMoney(Math.max(0, params.cartDiscount || 0));
  const taxAmount = roundSaleMoney(params.taxAmount || 0);
  const taxInclusive = params.taxInclusive !== false;
  const items = (params.items || []).map((item) => {
    const quantity = Number(item.quantity || 0);
    const unitPrice = roundSaleMoney(item.unitPrice || 0);
    const discountAmount = roundSaleMoney(Math.max(0, item.lineDiscount || 0));
    return {
      quantity,
      unitPrice,
      discountAmount,
      totalPrice: lineNetFromRung(quantity, unitPrice, discountAmount),
    };
  });
  const merchandiseNet = roundSaleMoney(items.reduce((sum, line) => sum + line.totalPrice, 0));
  const chargedPretax = roundSaleMoney(
    new Decimal(merchandiseNet).minus(cartDiscount).toNumber(),
  );
  const chargedTotal = taxInclusive
    ? chargedPretax
    : roundSaleMoney(new Decimal(chargedPretax).plus(taxAmount).toNumber());
  const headerDiscountDump = roundSaleMoney(
    new Decimal(cartDiscount).plus(items.reduce((sum, line) => sum + line.discountAmount, 0)).toNumber(),
  );
  return {
    items,
    merchandiseNet,
    cartDiscount,
    headerDiscountDump,
    taxAmount,
    chargedTotal,
  };
}

/**
 * What the broken modal did: (line net + stored dump) / qty.
 * 306000 + 6000 → 312000. Forbidden as persist or display unit.
 */
export function inventedUnitFromCopiedDump(
  lineNet: number,
  storedLineDiscount: number,
  quantity: number,
): number {
  const qty = Number(quantity || 0);
  if (qty <= 0) return 0;
  return roundSaleMoney(
    new Decimal(lineNet || 0).plus(storedLineDiscount || 0).dividedBy(qty).toNumber(),
  );
}

export function assertSaleDiscountPersistClosed(params: {
  items: SaleDiscountPersistLine[];
  cartDiscount: number;
  chargedTotal: number;
  taxAmount?: number;
  taxInclusive?: boolean;
}): { ok: boolean; message: string } {
  const projected = projectSaleDiscountPersist({
    items: params.items.map((item) => ({
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      lineDiscount: item.discountAmount,
    })),
    cartDiscount: params.cartDiscount,
    taxAmount: params.taxAmount,
    taxInclusive: params.taxInclusive,
  });
  const tol = SALE_DISCOUNT_MONEY_TOLERANCE;
  for (let i = 0; i < params.items.length; i += 1) {
    const actual = params.items[i];
    const expected = projected.items[i];
    if (!expected) {
      return { ok: false, message: `Persist line ${i} has no projection` };
    }
    if (Math.abs((actual.unitPrice || 0) - expected.unitPrice) > tol) {
      return {
        ok: false,
        message: `Persist unit ${actual.unitPrice} != submitted rung ${expected.unitPrice}`,
      };
    }
    if (Math.abs((actual.discountAmount || 0) - expected.discountAmount) > tol) {
      return {
        ok: false,
        message: `Persist line discount ${actual.discountAmount} != line markdown ${expected.discountAmount}`,
      };
    }
    if (Math.abs((actual.totalPrice || 0) - expected.totalPrice) > tol) {
      return {
        ok: false,
        message: `Persist line net ${actual.totalPrice} != qty×unit−lineDisc ${expected.totalPrice}`,
      };
    }
    const impliedUnit = inventedUnitFromCopiedDump(
      actual.totalPrice,
      actual.discountAmount,
      actual.quantity,
    );
    const applied = appliedLineDiscount(actual.quantity, actual.unitPrice, actual.totalPrice);
    if (
      applied <= tol &&
      (actual.discountAmount || 0) > tol &&
      Math.abs(impliedUnit - actual.unitPrice) > tol
    ) {
      return {
        ok: false,
        message:
          `Copied cart onto line would invent unit ${impliedUnit.toFixed(2)} ` +
          `from net ${actual.totalPrice} + dump ${actual.discountAmount}`,
      };
    }
    if (applied <= tol && (actual.discountAmount || 0) > tol) {
      return {
        ok: false,
        message:
          `sale_items.discount_amount ${actual.discountAmount} is a copied dump; ` +
          `unit×qty already equals line net ${actual.totalPrice}`,
      };
    }
  }
  if (Math.abs(projected.chargedTotal - roundSaleMoney(params.chargedTotal)) > tol) {
    return {
      ok: false,
      message:
        `Charged ${roundSaleMoney(params.chargedTotal).toFixed(2)} does not close to ` +
        `merchandise ${projected.merchandiseNet.toFixed(2)} − cart ${projected.cartDiscount.toFixed(2)}` +
        (projected.taxAmount > tol && params.taxInclusive === false
          ? ` + tax ${projected.taxAmount.toFixed(2)}`
          : ''),
    };
  }
  return { ok: true, message: 'sale discount persist closed' };
}

/**
 * Guided / POS exchange: 2210 credit is cart only, capped at replacement merchandise.
 */
export function projectExchangeReplacementSale(params: {
  replacementItems: SaleDiscountLinePersistInput[];
  remainingCredit: number;
  taxAmount?: number;
  taxInclusive?: boolean;
}): {
  creditApplied: number;
  persist: SaleDiscountPersistProjection;
  identity: ReturnType<typeof assertExchangeCreditIdentity>;
} {
  const merchandiseNet = roundSaleMoney(
    (params.replacementItems || []).reduce(
      (sum, item) =>
        sum +
        lineNetFromRung(item.quantity, item.unitPrice, Math.max(0, item.lineDiscount || 0)),
      0,
    ),
  );
  const creditApplied = roundSaleMoney(
    Math.max(0, Math.min(params.remainingCredit || 0, merchandiseNet)),
  );
  const persist = projectSaleDiscountPersist({
    items: params.replacementItems,
    cartDiscount: creditApplied,
    taxAmount: params.taxAmount,
    taxInclusive: params.taxInclusive,
  });
  const identity = assertExchangeCreditIdentity({
    cartDiscount: creditApplied,
    remainingCredit: params.remainingCredit,
    merchandiseNet: persist.merchandiseNet,
    chargedTotal: persist.chargedTotal,
    taxAmount: persist.taxAmount,
  });
  return { creditApplied, persist, identity };
}

/** POS checkout payload: line markdowns stay on lines; cart/credit stays on header. */
export function buildCheckoutDiscountPayload(params: {
  items: SaleDiscountLinePersistInput[];
  cartDiscount: number;
  isExchangeCredit?: boolean;
}): {
  items: Array<{ quantity: number; unitPrice: number; discountAmount: number }>;
  discountAmount: number;
  exchangeCreditApplied?: number;
  persist: SaleDiscountPersistProjection;
} {
  const persist = projectSaleDiscountPersist({
    items: params.items,
    cartDiscount: params.cartDiscount,
  });
  return {
    items: persist.items.map((line) => ({
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      discountAmount: line.discountAmount,
    })),
    discountAmount: persist.cartDiscount,
    exchangeCreditApplied: params.isExchangeCredit ? persist.cartDiscount : undefined,
    persist,
  };
}

export type SaleRefundChargedLineInput = {
  saleItemId: string;
  quantity: number;
  remainingQty: number;
  unitPrice: number;
  lineNet: number;
  thisQty: number;
};

export type SaleRefundChargedLine = {
  saleItemId: string;
  thisQty: number;
  lineCharged: number;
};

export type SaleRefundChargedProjection = {
  refundChargedTotal: number;
  remainingChargedBefore: number;
  remainingMerchandiseBefore: number;
  thisMerchandise: number;
  cartDiscount: number;
  chargedTotal: number;
  lines: SaleRefundChargedLine[];
};

function merchandiseSlice(lineNet: number, origQty: number, sliceQty: number): number {
  if (!(origQty > 0) || !(sliceQty > 0)) return 0;
  return new Decimal(lineNet || 0).times(sliceQty).dividedBy(origQty).toNumber();
}

/**
 * Refund the amount the customer was charged, not qty × catalog unit.
 * Cart stays on the header: remaining goods take remaining charged so a
 * full remaining return closes to sales.total_amount − prior refunds.
 * No-discount sales stay qty × unit (line net = list).
 */
export function projectSaleRefundCharged(params: {
  totalAmount: number;
  taxAmount?: number;
  alreadyRefundedCharged: number;
  items: SaleRefundChargedLineInput[];
}): SaleRefundChargedProjection {
  const presented = presentSaleDiscounts({
    totalAmount: params.totalAmount,
    taxAmount: params.taxAmount,
    items: (params.items || []).map((item) => ({
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      lineNet: item.lineNet,
    })),
  });
  const chargedTotal = roundSaleMoney(params.totalAmount);
  const already = roundSaleMoney(Math.max(0, params.alreadyRefundedCharged || 0));
  const remainingChargedBefore = roundSaleMoney(Math.max(0, chargedTotal - already));

  const remainingMerchandiseBefore = roundSaleMoney(
    (params.items || []).reduce(
      (sum, item) =>
        sum + merchandiseSlice(item.lineNet, item.quantity, item.remainingQty),
      0,
    ),
  );
  const thisMerchandise = roundSaleMoney(
    (params.items || []).reduce(
      (sum, item) => sum + merchandiseSlice(item.lineNet, item.quantity, item.thisQty),
      0,
    ),
  );

  let refundChargedTotal = 0;
  if (thisMerchandise > SALE_DISCOUNT_MONEY_TOLERANCE) {
    if (remainingMerchandiseBefore - thisMerchandise <= SALE_DISCOUNT_MONEY_TOLERANCE) {
      refundChargedTotal = remainingChargedBefore;
    } else if (remainingMerchandiseBefore > SALE_DISCOUNT_MONEY_TOLERANCE) {
      refundChargedTotal = roundSaleMoney(
        new Decimal(remainingChargedBefore)
          .times(thisMerchandise)
          .dividedBy(remainingMerchandiseBefore)
          .toNumber(),
      );
    }
  }

  const refundLines = (params.items || []).filter((item) => (item.thisQty || 0) > 0);
  const lineMerch = refundLines.map((item) =>
    roundSaleMoney(merchandiseSlice(item.lineNet, item.quantity, item.thisQty)),
  );
  const merchSum = roundSaleMoney(lineMerch.reduce((sum, n) => sum + n, 0));
  const lines: SaleRefundChargedLine[] = [];
  let allocated = 0;
  for (let i = 0; i < refundLines.length; i += 1) {
    const isLast = i === refundLines.length - 1;
    const share = isLast
      ? roundSaleMoney(refundChargedTotal - allocated)
      : merchSum <= 0
        ? 0
        : roundSaleMoney(
            new Decimal(refundChargedTotal).times(lineMerch[i]).dividedBy(merchSum).toNumber(),
          );
    if (!isLast) allocated = roundSaleMoney(allocated + share);
    lines.push({
      saleItemId: refundLines[i].saleItemId,
      thisQty: refundLines[i].thisQty,
      lineCharged: share,
    });
  }

  return {
    refundChargedTotal,
    remainingChargedBefore,
    remainingMerchandiseBefore,
    thisMerchandise,
    cartDiscount: presented.cartDiscount,
    chargedTotal,
    lines,
  };
}

function thisQtyLookup(
  thisQtyByItemId: Map<string, number> | Record<string, number> | undefined,
  id: string,
): number {
  if (!thisQtyByItemId) return 0;
  if (thisQtyByItemId instanceof Map) return num(thisQtyByItemId.get(id));
  return num(thisQtyByItemId[id]);
}

/**
 * Full return / void reverses the daily-summary increment: charged total AND cart discount.
 * After a full return that sale must contribute 0 sales, 0 amount, 0 discount.
 *
 * Healthy header already stores charged + discount. A trigger-wiped cash/card header
 * keeps list in total_amount, 0 discount, and charged on amount_paid — reverse those.
 * CREDIT underpay is not a wiped discount.
 */
export function projectSaleRollupDecrement(input: {
  paymentMethod: string;
  headerTotal: number;
  headerDiscount: number;
  amountPaid: number;
  giftAmount?: number;
}): { reverseAmount: number; reverseDiscount: number } {
  const headerTotal = roundSaleMoney(input.headerTotal);
  const headerDiscount = roundSaleMoney(Math.max(0, input.headerDiscount || 0));
  const amountPaid = roundSaleMoney(Math.max(0, input.amountPaid || 0));
  const giftAmount = roundSaleMoney(Math.max(0, input.giftAmount || 0));
  const method = String(input.paymentMethod || '').toUpperCase();
  if (method === 'GIFT') {
    return { reverseAmount: headerTotal, reverseDiscount: headerDiscount };
  }
  if (giftAmount > SALE_DISCOUNT_MONEY_TOLERANCE) {
    return {
      reverseAmount: roundSaleMoney(Math.max(0, headerTotal - giftAmount)),
      reverseDiscount: headerDiscount,
    };
  }
  if (
    method !== 'CREDIT' &&
    headerDiscount <= SALE_DISCOUNT_MONEY_TOLERANCE &&
    amountPaid > SALE_DISCOUNT_MONEY_TOLERANCE &&
    amountPaid + SALE_DISCOUNT_MONEY_TOLERANCE < headerTotal
  ) {
    return {
      reverseAmount: amountPaid,
      reverseDiscount: roundSaleMoney(headerTotal - amountPaid),
    };
  }
  return { reverseAmount: headerTotal, reverseDiscount: headerDiscount };
}

/**
 * Persist / UI adapter: pg numeric strings, camel or snake, same charged total.
 * refundSale and RefundSaleModal / ProductExchangeModal must both call this.
 */
export function projectSaleRefundChargedFromSale(params: {
  sale: Record<string, unknown> | null | undefined;
  items: Array<Record<string, unknown>>;
  thisQtyByItemId: Map<string, number> | Record<string, number>;
  alreadyRefundedCharged?: unknown;
}): SaleRefundChargedProjection {
  const sale = params.sale || {};
  return projectSaleRefundCharged({
    totalAmount: num(sale.totalAmount, sale.total_amount),
    taxAmount: num(sale.taxAmount, sale.tax_amount),
    alreadyRefundedCharged: num(
      params.alreadyRefundedCharged,
      sale.refundedChargedTotal,
      sale.refunded_charged_total,
    ),
    items: (params.items || []).map((item) => {
      const id = String(item.saleItemId || item.id || '');
      const quantity = num(item.quantity, item.qty);
      const remainingExplicit = item.remainingQty ?? item.remaining_qty;
      const remainingQty =
        remainingExplicit != null && remainingExplicit !== ''
          ? num(remainingExplicit)
          : num(item.maxRefundable) ||
            Math.max(0, quantity - num(item.refundedQty, item.refunded_qty));
      return {
        saleItemId: id,
        quantity,
        remainingQty,
        unitPrice: num(item.unitPrice, item.unit_price, item.price),
        lineNet: num(
          item.totalPrice,
          item.total_price,
          item.lineNet,
          item.lineTotal,
          item.line_total,
        ),
        thisQty: thisQtyLookup(params.thisQtyByItemId, id),
      };
    }),
  });
}
