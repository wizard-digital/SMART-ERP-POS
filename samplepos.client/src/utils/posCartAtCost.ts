/**
 * AT_COST + FIFO layer split — separate cart lines per batch cost when integrity requires it.
 *
 * REGRESSION: npm run test:pos-pricing-regression — see POS_PRICING_REGRESSION.md
 */

import Decimal from 'decimal.js';
import { getPosLineConversionFactor } from './posCartUom';
import { recalcPosCartLineFields, type PosCartLineDiscount } from './posCartLine';

export interface AtCostLayerSegment {
  baseQuantity: number;
  unitCostPerBase: number;
  totalCost?: number;
}

export interface PosAtCostLineTemplate {
  id: string;
  name: string;
  sku: string;
  uom: string;
  costPrice: number;
  marginPct: number;
  productType?: 'inventory' | 'consumable' | 'service';
  stockOnHand?: number;
  isTaxable: boolean;
  taxRate: number;
  availableUoms?: Array<{
    uomId: string;
    name: string;
    symbol?: string;
    conversionFactor: number;
    price: number;
    cost: number;
    isDefault: boolean;
  }>;
  selectedUomId?: string;
  baseCost?: number;
  discount?: PosCartLineDiscount;
  pricingRule?: {
    scope: string;
    ruleName: string | null;
    basePrice: number;
    discount: number;
  };
  unitPriceManuallySet?: boolean;
}

export type PosAtCostCartLine = PosAtCostLineTemplate & {
  quantity: number;
  unitPrice: number;
  subtotal: number;
  atCostLayerIndex?: number;
  atCostLayerLabel?: string;
};

export function posCartGroupKey(productId: string, selectedUomId?: string): string {
  return `${productId}:${selectedUomId ?? ''}`;
}

/** True when FIFO layers have more than one distinct batch unit cost. */
export function shouldSplitAtCostFifoLayers(layers: AtCostLayerSegment[] | undefined): boolean {
  if (!layers || layers.length <= 1) return false;
  const costs = new Set(layers.map((l) => Math.round(l.unitCostPerBase * 100) / 100));
  return costs.size > 1;
}

function fifoLayersTotalCost(layers: AtCostLayerSegment[]): Decimal {
  return layers.reduce(
    (sum, l) =>
      sum.plus(
        l.totalCost != null
          ? l.totalCost
          : new Decimal(l.baseQuantity).times(l.unitCostPerBase),
      ),
    new Decimal(0),
  );
}

/**
 * True when a single blended cart line cannot reproduce the exact FIFO total
 * (e.g. currency rounding: 38,001 ÷ 2 → no whole-cent unit price).
 * Prefer one blended line whenever this returns false.
 */
export function mustSplitAtCostFifoLayers(
  layers: AtCostLayerSegment[] | undefined,
  totalSellingQty: number,
  blendedUnitPerSelling: number,
): boolean {
  if (!layers || layers.length <= 1 || totalSellingQty <= 0) return false;
  if (!shouldSplitAtCostFifoLayers(layers)) return false;

  const fifoTotal = fifoLayersTotalCost(layers).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const blendedTotal = new Decimal(blendedUnitPerSelling)
    .times(totalSellingQty)
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

  return blendedTotal.minus(fifoTotal).abs().greaterThan(0.01);
}

export function layerBaseToSellingQuantity(baseQty: number, factor: number): number | null {
  if (factor <= 0 || baseQty <= 0) return null;
  const selling = new Decimal(baseQty).dividedBy(factor);
  const rounded = selling.toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
  if (!rounded.times(factor).minus(baseQty).abs().lessThanOrEqualTo(0.0001)) {
    return null;
  }
  const sellingQty = rounded.toNumber();
  // POS cart lines need whole selling units (qty ≥ 1); otherwise use blended line + FIFO hint.
  if (sellingQty < 1 - 0.0001 || Math.abs(sellingQty - Math.round(sellingQty)) > 0.0001) {
    return null;
  }
  return Math.round(sellingQty);
}

export function canSplitAtCostLayersToSellingUom(
  layers: AtCostLayerSegment[],
  factor: number,
): boolean {
  return layers.every((l) => layerBaseToSellingQuantity(l.baseQuantity, factor) != null);
}

/** Build cart lines from FIFO layers (one line per batch cost segment). */
export function buildAtCostSplitCartLines(
  template: PosAtCostLineTemplate,
  layers: AtCostLayerSegment[],
  pricingRule?: PosAtCostLineTemplate['pricingRule'],
): PosAtCostCartLine[] {
  const factor = getPosLineConversionFactor(template.availableUoms, template.selectedUomId);

  return layers.map((layer, index) => {
    const sellingQty = layerBaseToSellingQuantity(layer.baseQuantity, factor) ?? layer.baseQuantity;
    const unitPrice = new Decimal(layer.unitCostPerBase).times(factor).toDecimalPlaces(2).toNumber();
    const recalc = recalcPosCartLineFields({
      quantity: sellingQty,
      unitPrice,
      costPrice: unitPrice,
      discount: undefined,
    });

    return {
      ...template,
      ...recalc,
      costPrice: unitPrice,
      pricingRule,
      atCostLayerIndex: index,
      atCostLayerLabel: `FIFO batch @ ${unitPrice}`,
      unitPriceManuallySet: false,
    };
  });
}

/** Single blended line with layer breakdown attached (fallback when UoM cannot split cleanly). */
/** Stable signature for comparing repriced cart lines (order-independent). */
export function atCostCartLinesSignature(
  lines: Array<{
    quantity: number;
    unitPrice: number;
    costPrice?: number;
    atCostLayerIndex?: number;
    atCostLayerLabel?: string;
    atCostLayers?: AtCostLayerSegment[];
    pricingRule?: { scope?: string };
  }>,
): string {
  return [...lines]
    .map((l) =>
      [
        l.quantity,
        l.unitPrice,
        l.costPrice ?? '',
        l.atCostLayerIndex ?? '',
        l.atCostLayerLabel ?? '',
        l.pricingRule?.scope ?? '',
        l.atCostLayers?.length
          ? l.atCostLayers.map((x) => `${x.baseQuantity}@${x.unitCostPerBase}`).join('+')
          : '',
      ].join(':'),
    )
    .sort()
    .join('|');
}

/** True when repriced lines must replace current cart lines (incl. costPrice / layer sync). */
export function atCostCartGroupNeedsUpdate(
  oldLines: Array<{
    quantity: number;
    unitPrice: number;
    costPrice: number;
    atCostLayerIndex?: number;
    atCostLayerLabel?: string;
    atCostLayers?: AtCostLayerSegment[];
    pricingRule?: { scope?: string };
  }>,
  newLines: Array<{
    quantity: number;
    unitPrice: number;
    costPrice: number;
    atCostLayerIndex?: number;
    atCostLayerLabel?: string;
    atCostLayers?: AtCostLayerSegment[];
    pricingRule?: { scope?: string };
  }>,
  isAtCostRule: boolean,
): boolean {
  if (oldLines.length !== newLines.length) return true;
  if (atCostCartLinesSignature(oldLines) !== atCostCartLinesSignature(newLines)) return true;
  if (!isAtCostRule) return false;
  for (let i = 0; i < oldLines.length; i++) {
    const o = oldLines[i];
    if (Math.abs(o.costPrice - o.unitPrice) > 0.02) return true;
  }
  return false;
}

export function buildAtCostBlendedCartLine(
  template: PosAtCostLineTemplate,
  totalSellingQty: number,
  blendedUnitPerSelling: number,
  layers: AtCostLayerSegment[],
  pricingRule?: PosAtCostLineTemplate['pricingRule'],
  /** When true (AT_COST / FEFO issue price), cost = issue price. Otherwise preserve catalog inventory cost. */
  isAtCostIssuePrice = false,
): PosAtCostCartLine {
  const inventoryCost = template.costPrice;
  const lineCost = isAtCostIssuePrice ? blendedUnitPerSelling : inventoryCost;
  const recalc = recalcPosCartLineFields({
    quantity: totalSellingQty,
    unitPrice: blendedUnitPerSelling,
    costPrice: lineCost,
    discount: template.discount,
  });

  return {
    ...template,
    ...recalc,
    costPrice: lineCost,
    pricingRule,
    atCostLayerIndex: undefined,
    atCostLayerLabel: layers.length > 1 ? `${layers.length} FIFO layers` : undefined,
    unitPriceManuallySet: template.unitPriceManuallySet,
  };
}

/**
 * Walk-in / retail: keep catalog (or manual) selling price; set cost floor to FEFO carrying.
 * AT_COST: selling price and cost are the issue price.
 */
export function applyAllocatedCarryingToCartLine<
  T extends {
    unitPrice: number;
    costPrice: number;
    quantity: number;
    discount?: PosCartLineDiscount;
  },
>(
  line: T,
  allocatedCostPerSellingUnit: number | null | undefined,
): T {
  if (
    allocatedCostPerSellingUnit == null ||
    !Number.isFinite(allocatedCostPerSellingUnit) ||
    allocatedCostPerSellingUnit <= 0
  ) {
    return line;
  }
  const costPrice = new Decimal(allocatedCostPerSellingUnit).toDecimalPlaces(2).toNumber();
  const recalc = recalcPosCartLineFields({
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    costPrice,
    discount: line.discount,
  });
  return { ...line, ...recalc, costPrice };
}
