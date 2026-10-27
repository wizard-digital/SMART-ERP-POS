/**
 * Sale posting integrity helpers (SALE-2026-4063 regression guards).
 */
import Decimal from 'decimal.js';
import { BusinessError } from '../../middleware/errorHandler.js';
import { Money } from '../../utils/money.js';

/** Net unit from a line total. FORBIDDEN as persist unit_price (that is the rung/catalog price). */
export function deriveUnitPriceFromLineTotal(lineTotal: number, quantity: number): number {
  if (quantity <= 0) return 0;
  return Money.toNumber(Money.round(new Decimal(lineTotal).dividedBy(quantity), 2));
}

export type SaleHeaderTotalResolution = {
  finalTotal: Decimal;
  clientTotal?: number;
  coercedFromExclusiveTrap: boolean;
};

/**
 * Header charge SSOT.
 * Inclusive tenants: charge is always shelf (priced lines − cart discount). Server owns
 * that number — client exclusive-add (4200 + 640.68 = 4840.68) is coerced, and any other
 * drift under inclusive is also replaced by shelf (never hard-fail checkout on total).
 * Exclusive tenants: charge = lines − discount + tax; strict match.
 */
export function resolveSaleHeaderTotal(input: {
  providedTotal?: number | null;
  pricedLinesAfterDiscount: Decimal;
  taxAmount: Decimal;
  taxInclusive: boolean;
}): SaleHeaderTotalResolution {
  const calculated = input.taxInclusive
    ? input.pricedLinesAfterDiscount
    : input.pricedLinesAfterDiscount.plus(input.taxAmount);

  if (input.providedTotal === undefined || input.providedTotal === null) {
    return { finalTotal: calculated, coercedFromExclusiveTrap: false };
  }

  const provided = new Decimal(input.providedTotal);
  if (provided.minus(calculated).abs().lessThanOrEqualTo(0.02)) {
    return {
      finalTotal: calculated,
      clientTotal: Money.toNumber(provided),
      coercedFromExclusiveTrap: false,
    };
  }

  // Inclusive: never reject — shelf charge is SSOT. Flag classic exclusive-add trap for logs.
  if (input.taxInclusive) {
    const exclusiveTrap = input.pricedLinesAfterDiscount.plus(input.taxAmount);
    const looksLikeExclusiveAdd = provided.minus(exclusiveTrap).abs().lessThanOrEqualTo(0.02);
    return {
      finalTotal: calculated,
      clientTotal: Money.toNumber(provided),
      coercedFromExclusiveTrap: looksLikeExclusiveAdd,
    };
  }

  assertSaleHeaderMatchesCalculatedTotal(input.providedTotal, calculated, {
    taxInclusive: input.taxInclusive,
    taxAmount: Money.toNumber(input.taxAmount),
    pricedLines: Money.toNumber(input.pricedLinesAfterDiscount),
  });
  // assert always throws when mismatch; unreachable
  return { finalTotal: calculated, coercedFromExclusiveTrap: false };
}

export function assertSaleHeaderMatchesCalculatedTotal(
  providedTotal: number | undefined,
  calculatedTotal: Decimal,
  detail?: {
    taxInclusive?: boolean;
    taxAmount?: number;
    pricedLines?: number;
  },
): void {
  if (providedTotal === undefined || providedTotal === null) return;
  const provided = new Decimal(providedTotal);
  if (provided.minus(calculatedTotal).abs().greaterThan(0.02)) {
    const taxAmt = Number(detail?.taxAmount ?? 0);
    const lines = Number(detail?.pricedLines ?? calculatedTotal.toNumber());
    const exclusiveHint = new Decimal(lines).plus(taxAmt).toFixed(2);
    const inclusiveHint = new Decimal(lines).toFixed(2);
    const mode =
      detail?.taxInclusive === true
        ? 'inclusive'
        : detail?.taxInclusive === false
          ? 'exclusive'
          : 'unknown';
    throw new BusinessError(
      `Sale total ${provided.toFixed(2)} does not match priced line items ${calculatedTotal.toFixed(2)} ` +
        `(price mode: ${mode}). ` +
        (mode === 'inclusive'
          ? `Tax ${taxAmt.toFixed(2)} is already in the shelf price — charge must be ${inclusiveHint}, not sub+tax ${exclusiveHint}. `
          : '') +
        'Reselect the customer, refresh cart prices, and try again.',
      'ERR_SALE_TOTAL_MISMATCH',
      {
        providedTotal: Money.toNumber(provided),
        calculatedTotal: Money.toNumber(calculatedTotal),
        taxInclusive: detail?.taxInclusive === true,
        taxAmount: taxAmt,
        exclusiveTotalIfMisadded: Money.toNumber(new Decimal(lines).plus(taxAmt)),
      },
    );
  }
}

export function assertSaleLineEconomicsConsistent(params: {
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  discountAmount?: number;
  tolerance?: number;
}): { ok: boolean; message: string } {
  const tol = params.tolerance ?? 0.02;
  const lineDisc = new Decimal(params.discountAmount || 0);
  const implied = new Decimal(params.quantity).times(params.unitPrice).minus(lineDisc);
  const stored = new Decimal(params.totalPrice);
  if (implied.minus(stored).abs().greaterThan(tol)) {
    return {
      ok: false,
      message:
        `unit×qty−lineDisc=${implied.toFixed(2)} != total_price=${stored.toFixed(2)}` +
        (lineDisc.greaterThan(0) ? ` (lineDisc=${lineDisc.toFixed(2)})` : ''),
    };
  }
  return { ok: true, message: 'line economics OK' };
}

export function assertAtCostMargin(params: {
  totalAmount: number;
  totalCost: number;
  maxMarginPct?: number;
}): { ok: boolean; message: string; marginPct: number } {
  const revenue = new Decimal(params.totalAmount);
  const cost = new Decimal(params.totalCost);
  if (revenue.lessThanOrEqualTo(0)) {
    return { ok: false, message: 'zero revenue', marginPct: 0 };
  }
  const marginPct = revenue.minus(cost).dividedBy(revenue).times(100).toNumber();
  const max = params.maxMarginPct ?? 2;
  if (marginPct > max) {
    return {
      ok: false,
      message: `margin ${marginPct.toFixed(2)}% exceeds at-cost max ${max}%`,
      marginPct,
    };
  }
  return { ok: true, message: 'at-cost margin OK', marginPct };
}
