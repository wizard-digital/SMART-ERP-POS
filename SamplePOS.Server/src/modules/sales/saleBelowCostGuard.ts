/**
 * Hard block: line revenue must not fall below FEFO/FIFO allocated inventory cost.
 *
 * REGRESSION: npm run test:pos-pricing-regression — see POS_PRICING_REGRESSION.md
 */
import Decimal from 'decimal.js';
import { BusinessError } from '../../middleware/errorHandler.js';
import { Money } from '../../utils/money.js';

const REVENUE_COST_TOLERANCE = new Decimal('0.01');

export interface SaleLineCostCheckInput {
  productId: string;
  productName?: string;
  quantity: number;
  /** Line revenue after line-level discount (selling UoM). */
  lineRevenue: number;
  /** Total allocated inventory cost for the line (base qty × batch layers). */
  totalAllocatedCost: number;
  costPerSellingUnit: number;
  unitPrice: number;
  /** FEFO layers that would be consumed (for diagnostics). */
  fefoLayers?: Array<{ baseQuantity: number; unitCostPerBase: number; totalCost: number }>;
}

/**
 * Throws BusinessError BELOW_ALLOCATED_COST when revenue is below allocated inventory cost.
 * Intended policy: exact allocated cost is allowed, plus a 0.01 money-cent tolerance
 * (REVENUE_COST_TOLERANCE). At carrying 6000: 6000.00 and 5999.99 are allowed;
 * 5999.98 is rejected. Do not change the tolerance to satisfy an old forensic table.
 */
export function assertSaleLineNotBelowAllocatedCost(input: SaleLineCostCheckInput): void {
  const qty = new Decimal(input.quantity);
  if (qty.lessThanOrEqualTo(0)) {
    return;
  }

  const lineRevenue = new Decimal(input.lineRevenue);
  const totalCost = new Decimal(input.totalAllocatedCost);

  if (totalCost.lessThanOrEqualTo(0)) {
    return;
  }

  if (lineRevenue.plus(REVENUE_COST_TOLERANCE).lessThan(totalCost)) {
    const costPerUnit = Money.toNumber(Money.round(totalCost.dividedBy(qty), 2));
    throw new BusinessError(
      'Sale blocked. Selling price cannot be below actual inventory cost.',
      'BELOW_ALLOCATED_COST',
      {
        productId: input.productId,
        productName: input.productName,
        quantity: input.quantity,
        lineRevenue: Money.toNumber(Money.round(lineRevenue, 2)),
        totalAllocatedCost: Money.toNumber(Money.round(totalCost, 2)),
        costPerSellingUnit: input.costPerSellingUnit,
        minimumUnitPrice: costPerUnit,
        submittedUnitPrice: input.unitPrice,
        ...(input.fefoLayers?.length ? { fefoAllocation: input.fefoLayers } : {}),
      },
    );
  }

  const unitRevenue = lineRevenue.dividedBy(qty);
  const minUnit = new Decimal(input.costPerSellingUnit);
  if (minUnit.greaterThan(0) && unitRevenue.plus(REVENUE_COST_TOLERANCE).lessThan(minUnit)) {
    throw new BusinessError(
      'Sale blocked. Selling price cannot be below actual inventory cost.',
      'BELOW_ALLOCATED_COST',
      {
        productId: input.productId,
        productName: input.productName,
        quantity: input.quantity,
        unitRevenue: Money.toNumber(Money.round(unitRevenue, 2)),
        costPerSellingUnit: input.costPerSellingUnit,
        submittedUnitPrice: input.unitPrice,
        ...(input.fefoLayers?.length ? { fefoAllocation: input.fefoLayers } : {}),
      },
    );
  }
}
