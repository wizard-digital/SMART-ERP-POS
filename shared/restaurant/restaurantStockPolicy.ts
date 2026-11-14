/**
 * Restaurant FOH stock policy (Toast/Square-style).
 *
 * Reuses catalog productTypeRules:
 * - service parents: no remaining qty on menu; no FOH stock warn; pay skips parent stock
 * - inventory / consumable: show remaining; warn when oversell is OFF
 *
 * Pay / createSale still enforces BR-INV-001 for inventory (insufficient at settle)
 * unless a future true-negative-inventory path is approved. This flag only controls
 * FOH order/KOT soft warnings so kitchens are not printed into a settlement fail.
 */

import { isServiceProductType } from '../utils/productTypeRules.js';

/** system_settings.restaurant_allow_oversell — default false (strict FOH). */
export const RESTAURANT_ALLOW_OVERSELL_SETTING_KEY = 'restaurant_allow_oversell' as const;

export function showRestaurantMenuRemainingQty(
  productType: string | null | undefined,
): boolean {
  return !isServiceProductType(productType);
}

export function restaurantStockIsShort(
  remainingQty: number | null | undefined,
  requestedQty: number,
): boolean {
  if (remainingQty == null || !Number.isFinite(remainingQty)) return false;
  if (!Number.isFinite(requestedQty) || requestedQty <= 0) return false;
  return remainingQty + 1e-9 < requestedQty;
}

/**
 * Soft FOH warn when oversell is OFF and an inventory/consumable line exceeds remaining.
 * Returns null when no warn (service, oversell on, or enough stock).
 */
export function restaurantFohStockWarnMessage(input: {
  allowOversell: boolean;
  productType: string | null | undefined;
  productName: string;
  remainingQty: number | null | undefined;
  requestedQty: number;
  stage: 'add' | 'kot' | 'pay';
}): string | null {
  if (input.allowOversell) return null;
  if (!showRestaurantMenuRemainingQty(input.productType)) return null;
  if (!restaurantStockIsShort(input.remainingQty, input.requestedQty)) return null;

  const rem =
    input.remainingQty == null ? '?' : String(Number(input.remainingQty));
  const base = `"${input.productName}" needs ${input.requestedQty}, remaining ${rem}.`;

  if (input.stage === 'kot') {
    return `${base} Avoid printing/sending to kitchen — settlement will fail if stock is still short.`;
  }
  if (input.stage === 'pay') {
    return `${base} Complete sale will reject for insufficient stock.`;
  }
  return `${base} Low stock — avoid sending to kitchen until restocked.`;
}

/** Aggregate unsent (or all) inventory lines vs menu remaining map. */
export function restaurantFohStockWarnForLines(input: {
  allowOversell: boolean;
  stage: 'add' | 'kot' | 'pay';
  lines: Array<{
    productId: string;
    productName: string;
    productType?: string | null;
    quantity: number;
  }>;
  remainingByProductId: Map<string, number | null | undefined> | Record<string, number | null | undefined>;
}): string[] {
  if (input.allowOversell) return [];

  const getRem = (id: string): number | null | undefined => {
    if (input.remainingByProductId instanceof Map) {
      return input.remainingByProductId.get(id);
    }
    return input.remainingByProductId[id];
  };

  const needed = new Map<
    string,
    { productName: string; productType?: string | null; quantity: number }
  >();
  for (const line of input.lines) {
    if (!line.productId || line.productId.startsWith('custom_')) continue;
    if (!showRestaurantMenuRemainingQty(line.productType)) continue;
    const prev = needed.get(line.productId);
    if (prev) {
      prev.quantity += line.quantity;
    } else {
      needed.set(line.productId, {
        productName: line.productName,
        productType: line.productType,
        quantity: line.quantity,
      });
    }
  }

  const msgs: string[] = [];
  for (const [productId, agg] of needed) {
    const msg = restaurantFohStockWarnMessage({
      allowOversell: false,
      productType: agg.productType,
      productName: agg.productName,
      remainingQty: getRem(productId),
      requestedQty: agg.quantity,
      stage: input.stage,
    });
    if (msg) msgs.push(msg);
  }
  return msgs;
}
