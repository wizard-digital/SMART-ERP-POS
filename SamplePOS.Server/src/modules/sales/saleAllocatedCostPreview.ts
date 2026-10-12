/**
 * SSOT: allocated carrying cost for one product × base qty.
 * Used by salesService.createSale and quotationService.convertQuotationToSale.
 *
 * Physical issue order is always FEFO (selectLots) — same as deduction.
 * product_valuation.costing_method FIFO means "use layer carrying" (not SQL FIFO order).
 */
import type { PoolClient } from 'pg';
import Decimal from 'decimal.js';
import { Money } from '../../utils/money.js';
import { previewFefoIssueCostForBaseQty } from '../pricing/atCostIssuePrice.js';
import { warehouseSaleDeductionService } from '../inventory/warehouse/warehouseSaleDeductionService.js';

export type AllocatedCostPreviewInput = {
  productId: string;
  baseQty: Decimal;
  /** products.cost_price (master). */
  masterCost: Decimal;
  /** product_valuation.average_cost — shortfall pad when average > 0. */
  averageCost: Decimal;
  minDaysBeforeExpiry: number;
  /** When set, store-scoped FEFO preview (same selectLots as deductAtStore). */
  sellingStoreId: string | null;
};

export type AllocatedCostPreviewResult = {
  totalCost: Decimal;
  shortfall: Decimal;
};

function padShortfall(
  coveredCost: Decimal,
  shortfall: Decimal,
  masterCost: Decimal,
  averageCost: Decimal,
): Decimal {
  if (!shortfall.greaterThan(0.001)) return coveredCost;
  const shortfallUnit = averageCost.greaterThan(0) ? averageCost : masterCost;
  return coveredCost.plus(shortfall.times(shortfallUnit));
}

/**
 * FEFO covered cost (+ one shortfall pad). Store and legacy use the same pad rule.
 */
export async function previewProductLineAllocatedCost(
  client: PoolClient,
  input: AllocatedCostPreviewInput,
): Promise<AllocatedCostPreviewResult> {
  const { productId, baseQty, masterCost, averageCost, minDaysBeforeExpiry, sellingStoreId } =
    input;

  if (sellingStoreId) {
    const storePreview = await warehouseSaleDeductionService.previewSaleCostAtStore(
      client,
      sellingStoreId,
      productId,
      baseQty,
      masterCost,
    );
    return {
      totalCost: padShortfall(
        storePreview.totalCost,
        storePreview.shortfall,
        masterCost,
        averageCost,
      ),
      shortfall: storePreview.shortfall,
    };
  }

  const preview = await previewFefoIssueCostForBaseQty(
    client,
    productId,
    baseQty,
    masterCost,
    { minDaysBeforeExpiry },
  );
  return {
    totalCost: padShortfall(preview.totalCost, preview.shortfall, masterCost, averageCost),
    shortfall: preview.shortfall,
  };
}

/** Selling-UoM unit cost from allocated total (same rounding as createSale). */
export function allocatedCostPerSellingUnit(
  totalCost: Decimal,
  sellingQty: number,
): number {
  if (!(sellingQty > 0)) return 0;
  return Money.toNumber(Money.round(totalCost.dividedBy(new Decimal(sellingQty)), 2));
}
