/**
 * Invoice Receive Payment via customer deposit — amount + FIFO SSOT.
 *
 * Server apply and Receive Payment UI MUST use these helpers.
 * Never JS float / Math.min / Number() for money on this path.
 */
import Decimal from 'decimal.js';

Decimal.set({
  precision: 20,
  rounding: Decimal.ROUND_HALF_UP,
});

export function money2(value: string | number | Decimal | null | undefined): Decimal {
  if (value === null || value === undefined || value === '') {
    return new Decimal(0);
  }
  const d = value instanceof Decimal ? value : new Decimal(String(value));
  if (!d.isFinite()) {
    throw new Error('DEPOSIT_PAYMENT_INVALID_AMOUNT: not a finite number');
  }
  return d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

/** Max amount that may be applied from deposit to an invoice. */
export function depositPaymentCap(
  outstanding: string | number | Decimal | null | undefined,
  depositAvailable: string | number | Decimal | null | undefined,
): Decimal {
  const o = money2(outstanding);
  const a = money2(depositAvailable);
  if (o.lte(0) || a.lte(0)) return new Decimal(0);
  return Decimal.min(o, a);
}

/**
 * Save Payment stays disabled for a blank, zero, or over-cap amount.
 * Cash cap is the invoice outstanding. Deposit cap is the smaller of
 * outstanding and available deposit.
 */
export function receivePaymentSaveBlocked(args: {
  amount: string | number | Decimal | null | undefined;
  outstanding: string | number | Decimal | null | undefined;
  method: string;
  depositAvailable?: string | number | Decimal | null | undefined;
}): boolean {
  if (args.amount === null || args.amount === undefined || String(args.amount).trim() === '') {
    return true;
  }
  let pay: Decimal;
  try {
    pay = money2(args.amount);
  } catch {
    return true;
  }
  if (pay.lte(0)) return true;
  const cap = args.method === 'DEPOSIT'
    ? depositPaymentCap(args.outstanding, args.depositAvailable ?? 0)
    : money2(args.outstanding);
  return pay.gt(cap);
}

export function assertDepositPaymentAmount(args: {
  amount: string | number | Decimal | null | undefined;
  outstanding: string | number | Decimal | null | undefined;
  depositAvailable: string | number | Decimal | null | undefined;
}): Decimal {
  const pay = money2(args.amount);
  if (pay.lte(0)) {
    throw new Error('DEPOSIT_PAYMENT_INVALID_AMOUNT: must be greater than zero');
  }
  const cap = depositPaymentCap(args.outstanding, args.depositAvailable);
  if (cap.lte(0)) {
    throw new Error('INSUFFICIENT_DEPOSIT: no available customer deposit');
  }
  if (pay.gt(cap)) {
    throw new Error(
      `DEPOSIT_PAYMENT_EXCEEDS_CAP: ${pay.toFixed(2)} exceeds ${cap.toFixed(2)} (min of outstanding and deposit)`,
    );
  }
  return pay;
}

export type DepositFifoBucket = {
  id: string;
  available: string | number | Decimal;
};

export type DepositFifoAllocation = {
  id: string;
  amount: Decimal;
};

/**
 * FIFO apply: oldest deposits first. Fail-loud if available < requested.
 * totalApplied is always exactly equal to requested (2dp) on success.
 */
export function allocateDepositFifo(
  deposits: ReadonlyArray<DepositFifoBucket>,
  amountToApply: string | number | Decimal,
): { allocations: DepositFifoAllocation[]; totalApplied: Decimal } {
  const requested = money2(amountToApply);
  if (requested.lte(0)) {
    throw new Error('Amount to apply must be greater than zero');
  }

  const totalAvailable = deposits.reduce(
    (sum, d) => sum.plus(money2(d.available)),
    new Decimal(0),
  );
  if (totalAvailable.lt(requested)) {
    throw new Error(
      `INSUFFICIENT_DEPOSIT: Customer has ${totalAvailable.toFixed(2)} available, but payment requires ${requested.toFixed(2)}`,
    );
  }

  const allocations: DepositFifoAllocation[] = [];
  let remaining = requested;
  for (const d of deposits) {
    if (remaining.lte(0)) break;
    const available = money2(d.available);
    if (available.lte(0)) continue;
    const apply = Decimal.min(remaining, available);
    allocations.push({ id: d.id, amount: apply });
    remaining = remaining.minus(apply);
  }

  if (remaining.gt(0)) {
    throw new Error(
      `DEPOSIT_APPLY_INCOMPLETE: remaining ${remaining.toFixed(2)} after FIFO (requested ${requested.toFixed(2)})`,
    );
  }

  const totalApplied = allocations.reduce((sum, a) => sum.plus(a.amount), new Decimal(0));
  if (!totalApplied.eq(requested)) {
    throw new Error(
      `DEPOSIT_APPLY_MISMATCH: applied ${totalApplied.toFixed(2)} != requested ${requested.toFixed(2)}`,
    );
  }

  return { allocations, totalApplied };
}

export function assertAppliedEqualsRequested(
  applied: string | number | Decimal,
  requested: string | number | Decimal,
): void {
  const a = money2(applied);
  const r = money2(requested);
  if (!a.eq(r)) {
    throw new Error(
      `DEPOSIT_APPLY_MISMATCH: applied ${a.toFixed(2)} != requested ${r.toFixed(2)}`,
    );
  }
}
