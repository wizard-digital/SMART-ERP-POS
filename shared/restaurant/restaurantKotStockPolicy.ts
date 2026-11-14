/**
 * SambaPOS-style restaurant KOT stock (restaurant mode only).
 *
 * - KOT/send: deduct inventory/consumable parents immediately
 * - Void sent: restore
 * - Pay/createSale: do NOT deduct again when KOT already issued
 * - Service parents: never
 *
 * Stock movements: ADJUSTMENT_OUT / ADJUSTMENT_IN with
 * reference_type RESTAURANT_KOT / RESTAURANT_KOT_VOID (reuse enum; notes identify KOT).
 */

import { isServiceProductType } from '../utils/productTypeRules.js';

export const RESTAURANT_KOT_REFERENCE_TYPE = 'RESTAURANT_KOT' as const;
export const RESTAURANT_KOT_VOID_REFERENCE_TYPE = 'RESTAURANT_KOT_VOID' as const;

/** True when FOH KOT should hard-deduct this parent (not service). */
export function shouldDeductStockOnRestaurantKot(
  productType: string | null | undefined,
): boolean {
  return !isServiceProductType(productType);
}

/**
 * Menu paint: available (sellable) + ordered (open fired KOT qty on PENDING checks).
 * Available must already reflect hard KOT deducts when those have run.
 */
export function formatRestaurantMenuStockLabel(input: {
  productType: string | null | undefined;
  availableQty: number | null | undefined;
  orderedQty?: number | null | undefined;
}): { show: boolean; available: number | null; ordered: number; label: string } {
  if (!shouldDeductStockOnRestaurantKot(input.productType)) {
    return { show: false, available: null, ordered: 0, label: '' };
  }
  const available =
    input.availableQty == null || !Number.isFinite(Number(input.availableQty))
      ? null
      : Number(input.availableQty);
  const ordered =
    input.orderedQty == null || !Number.isFinite(Number(input.orderedQty))
      ? 0
      : Math.max(0, Number(input.orderedQty));
  if (available == null) {
    return { show: false, available: null, ordered, label: '' };
  }
  const availLabel = available.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (ordered > 1e-9) {
    const ordLabel = ordered.toLocaleString(undefined, { maximumFractionDigits: 2 });
    return {
      show: true,
      available,
      ordered,
      label: `${availLabel} left · ${ordLabel} ordered`,
    };
  }
  return {
    show: true,
    available,
    ordered: 0,
    label: `${availLabel} left`,
  };
}
