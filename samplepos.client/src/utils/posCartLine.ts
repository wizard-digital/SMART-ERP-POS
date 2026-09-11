/** POS cart line: unit price edits, subtotals, and catalog-cost validation hints. */

import Decimal from 'decimal.js';
import type { DiscountType } from '@shared/zod/discount';

const TOLERANCE = new Decimal('0.01');

export interface PosCartLineDiscount {
  type: DiscountType;
  value: number;
  amount: number;
  reason: string;
}

export interface PosCartLineRecalcInput {
  quantity: number;
  unitPrice: number;
  costPrice: number;
  discount?: PosCartLineDiscount;
}

export function normalizePosUnitPrice(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return new Decimal(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();
}

/** Recompute subtotal (after line discount), margin %, and cap discount to gross line. */
export function recalcPosCartLineFields(input: PosCartLineRecalcInput): {
  quantity: number;
  unitPrice: number;
  subtotal: number;
  marginPct: number;
  discount?: PosCartLineDiscount;
} {
  const quantity = input.quantity;
  const unitPrice = normalizePosUnitPrice(input.unitPrice);
  const gross = new Decimal(quantity).times(unitPrice);
  let discount = input.discount;
  let subtotal = gross.toNumber();

  if (discount && discount.amount > 0) {
    const grossNum = gross.toNumber();
    const cappedAmount = Math.min(discount.amount, grossNum);
    if (cappedAmount < discount.amount) {
      discount = { ...discount, amount: cappedAmount };
    }
    subtotal = gross.minus(discount.amount).toNumber();
  }

  const marginPct =
    unitPrice > 0 && input.costPrice > 0
      ? new Decimal(unitPrice)
          .minus(input.costPrice)
          .dividedBy(unitPrice)
          .times(100)
          .toNumber()
      : 0;

  return { quantity, unitPrice, subtotal, marginPct, discount };
}

export function isPosAtCostLine(
  item: { pricingRule?: { scope?: string } },
  customerPricingMode?: string | null,
): boolean {
  return customerPricingMode === 'AT_COST' || item.pricingRule?.scope === 'at_cost';
}

/**
 * Floor for client validation — must match server FEFO allocated carrying
 * (lot write-down lowers this; catalog product cost_price is not the till floor).
 */
export function getPosLineMinUnitPrice(
  item: { unitPrice: number; costPrice: number; pricingRule?: { scope?: string } },
  customerPricingMode?: string | null,
): number {
  if (isPosAtCostLine(item, customerPricingMode)) {
    const synced =
      item.costPrice > 0 &&
      Math.abs(item.costPrice - item.unitPrice) <= 0.02;
    return synced ? item.costPrice : item.unitPrice;
  }
  return item.costPrice;
}

/** Client hint: unit price below catalog/UoM cost (server uses FEFO layers). */
export function isPosUnitPriceBelowCatalogCost(unitPrice: number, costPrice: number): boolean {
  if (costPrice <= 0) return false;
  return new Decimal(unitPrice).plus(TOLERANCE).lessThan(costPrice);
}

export function isPosUnitPriceBelowMin(
  unitPrice: number,
  item: { unitPrice: number; costPrice: number; pricingRule?: { scope?: string } },
  customerPricingMode?: string | null,
): boolean {
  const floor = getPosLineMinUnitPrice(item, customerPricingMode);
  return isPosUnitPriceBelowCatalogCost(unitPrice, floor);
}

/** Client hint: line revenue after discount below catalog cost × qty. */
export function isPosLineRevenueBelowCatalogCost(
  subtotal: number,
  quantity: number,
  costPrice: number,
): boolean {
  if (costPrice <= 0 || quantity <= 0) return false;
  const lineCost = new Decimal(quantity).times(costPrice);
  return new Decimal(subtotal).plus(TOLERANCE).lessThan(lineCost);
}

export function isPosLineBlockedByCatalogCost(
  item: {
    unitPrice: number;
    subtotal: number;
    quantity: number;
    costPrice: number;
    pricingRule?: { scope?: string };
  },
  customerPricingMode?: string | null,
): boolean {
  const floor = getPosLineMinUnitPrice(item, customerPricingMode);
  return (
    isPosUnitPriceBelowCatalogCost(item.unitPrice, floor) ||
    isPosLineRevenueBelowCatalogCost(item.subtotal, item.quantity, floor)
  );
}
