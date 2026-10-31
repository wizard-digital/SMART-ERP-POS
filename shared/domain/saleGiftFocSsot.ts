/**
 * SAP SD FD / FOC — complimentary sale on the existing POS sale path.
 *
 * Staff or anyone the company names can take goods without paying.
 * This is a sale (register, FEFO SALE, receipt), not Store Issue GI 201 / 5150.
 * No duplicate document type: GIFT is a payment method on the existing sale.
 *
 * Remainder after a partial payment (SAP Teilweise unentgeltlich):
 *   - Discount: commercial markdown. Sale total falls. Cash + revenue = amount paid.
 *   - Gift: FOC for the unpaid remainder. Cash + revenue = amount paid. Gift is not AR.
 *     COGS still posts for all goods that left.
 *
 * Accounting (pure gift): skip 1010 / 1200 / 4000 / 2300; still COGS 5000 / 1300.
 * Accounting (pay + gift remainder): debit cash for money received, credit revenue for
 *   the billed portion, skip AR for the gift remainder, COGS for all goods.
 */

export const GIFT_PAYMENT_METHOD = 'GIFT' as const;
export const GIFT_PERMISSION = 'sales.gift';
/** Extra lock: only Administrator (admin.update). Manager/cashier must never issue gifts. */
export const GIFT_ADMIN_LOCK_PERMISSION = 'admin.update';
export const GIFT_REASON_MIN_LENGTH = 3;
export const GIFT_REASON_MAX_LENGTH = 500;

/** SQL: billed/revenue sales only. Gift is FOC — compare via ::text, never COALESCE(enum,''). */
export function billedSalesSql(alias?: string): string {
  const col = alias ? `${alias}.payment_method` : 'payment_method';
  return `${col}::text <> '${GIFT_PAYMENT_METHOD}'`;
}

export function giftSalesSql(alias?: string): string {
  const col = alias ? `${alias}.payment_method` : 'payment_method';
  return `${col}::text = '${GIFT_PAYMENT_METHOD}'`;
}

/** Billed revenue: merchandise minus FOC remainder. Pure gift is 0. */
export function billedRevenueSql(alias?: string): string {
  const total = alias ? `${alias}.total_amount` : 'total_amount';
  const gift = alias ? `${alias}.gift_amount` : 'gift_amount';
  return `(${total} - COALESCE(${gift}, 0))`;
}

export function giftAmountSql(alias?: string): string {
  const gift = alias ? `${alias}.gift_amount` : 'gift_amount';
  return `COALESCE(${gift}, 0)`;
}

/**
 * Rebuild sales_daily_summary so dashboard KPIs match reports:
 *   billed rows = header method, amount = total - gift_amount, cost = full COGS
 *   GIFT row    = FOC merchandise (pure gift + mixed remainder), cost = pure-gift COGS only
 */
export function salesDailySummaryRebuildSelectSql(): string {
  return `
  WITH src AS (
    SELECT
      sale_date,
      payment_method::text AS payment_method,
      total_amount,
      ${giftAmountSql()} AS gift_amount,
      COALESCE(total_cost, 0) AS total_cost,
      COALESCE(discount_amount, 0) AS discount_amount,
      amount_paid,
      ${billedRevenueSql()} AS billed_amount
    FROM sales
    WHERE status = 'COMPLETED'
  ),
  billed AS (
    SELECT
      sale_date,
      payment_method,
      COUNT(*)::INTEGER AS transaction_count,
      COALESCE(SUM(billed_amount), 0) AS total_amount,
      COALESCE(SUM(total_cost), 0) AS total_cost,
      COALESCE(SUM(billed_amount - total_cost), 0) AS total_profit,
      COALESCE(SUM(discount_amount), 0) AS total_discounts,
      COUNT(*) FILTER (WHERE payment_method = 'CREDIT')::INTEGER AS credit_count,
      COUNT(*) FILTER (
        WHERE payment_method = 'CREDIT'
          AND amount_paid > 0
          AND amount_paid < total_amount
      )::INTEGER AS partial_payment_count
    FROM src
    WHERE payment_method <> '${GIFT_PAYMENT_METHOD}'
    GROUP BY sale_date, payment_method
  ),
  gifts AS (
    SELECT
      sale_date,
      '${GIFT_PAYMENT_METHOD}' AS payment_method,
      COUNT(*) FILTER (
        WHERE gift_amount > 0.009 OR payment_method = '${GIFT_PAYMENT_METHOD}'
      )::INTEGER AS transaction_count,
      COALESCE(SUM(
        CASE WHEN payment_method = '${GIFT_PAYMENT_METHOD}' THEN total_amount ELSE gift_amount END
      ), 0) AS total_amount,
      COALESCE(SUM(
        CASE WHEN payment_method = '${GIFT_PAYMENT_METHOD}' THEN total_cost ELSE 0 END
      ), 0) AS total_cost,
      COALESCE(SUM(
        CASE WHEN payment_method = '${GIFT_PAYMENT_METHOD}' THEN total_amount - total_cost ELSE 0 END
      ), 0) AS total_profit,
      0::numeric AS total_discounts,
      0::INTEGER AS credit_count,
      0::INTEGER AS partial_payment_count
    FROM src
    WHERE gift_amount > 0.009 OR payment_method = '${GIFT_PAYMENT_METHOD}'
    GROUP BY sale_date
  )
  SELECT * FROM billed
  UNION ALL
  SELECT * FROM gifts`;
}

export type GiftRollupRow = {
  paymentMethod: string;
  transactionCount: number;
  totalAmount: number;
  totalCost: number;
};

/**
 * Sales-report totals that match GL:
 *   billed revenue excludes GIFT (no 4000)
 *   COGS includes gift cost (5000/1300 still posted)
 *   company cash in is never the gift merchandise value
 */
export function projectBilledSalesTotals(rows: readonly GiftRollupRow[]): {
  billedCount: number;
  billedAmount: number;
  totalCost: number;
  billedProfit: number;
  giftCount: number;
  giftAmount: number;
  giftCost: number;
} {
  let billedCount = 0;
  let billedAmount = 0;
  let totalCost = 0;
  let giftCount = 0;
  let giftAmount = 0;
  let giftCost = 0;
  for (const row of rows) {
    const count = Number(row.transactionCount || 0);
    const amount = Number(row.totalAmount || 0);
    const cost = Number(row.totalCost || 0);
    totalCost += cost;
    if (isGiftPaymentMethod(row.paymentMethod)) {
      giftCount += count;
      giftAmount += amount;
      giftCost += cost;
    } else {
      billedCount += count;
      billedAmount += amount;
    }
  }
  return {
    billedCount,
    billedAmount,
    totalCost,
    billedProfit: billedAmount - totalCost,
    giftCount,
    giftAmount,
    giftCost,
  };
}

export function isGiftPaymentMethod(method: string | null | undefined): boolean {
  return String(method || '').toUpperCase() === GIFT_PAYMENT_METHOD;
}

export function isGiftSale(input: {
  paymentMethod?: string | null;
  paymentLines?: ReadonlyArray<{ paymentMethod: string }> | null;
}): boolean {
  if (input.paymentLines && input.paymentLines.length > 0) {
    return input.paymentLines.some((l) => isGiftPaymentMethod(l.paymentMethod));
  }
  return isGiftPaymentMethod(input.paymentMethod);
}

/** Every tender is GIFT (or header-only GIFT). Company received nothing. */
export function isPureGiftSale(input: {
  paymentMethod?: string | null;
  paymentLines?: ReadonlyArray<{ paymentMethod: string }> | null;
}): boolean {
  const lines = input.paymentLines || [];
  if (lines.length > 0) {
    return lines.every((l) => isGiftPaymentMethod(l.paymentMethod));
  }
  return isGiftPaymentMethod(input.paymentMethod);
}

export function giftCoveredAmount(input: {
  giftAmount?: number | null;
  totalAmount?: number | null;
  paymentMethod?: string | null;
  paymentLines?: ReadonlyArray<{ paymentMethod: string; amount?: number | string }> | null;
}): number {
  const lines = input.paymentLines || [];
  if (lines.length > 0) {
    return lines
      .filter((l) => isGiftPaymentMethod(l.paymentMethod))
      .reduce((s, l) => s + Number(l.amount || 0), 0);
  }
  if (Number(input.giftAmount || 0) > 0) return Number(input.giftAmount);
  if (isGiftPaymentMethod(input.paymentMethod)) return Number(input.totalAmount || 0);
  return 0;
}

export function giftPaymentLabel(method: string | null | undefined): string {
  if (isGiftPaymentMethod(method)) return 'Gift (no charge)';
  return method || '';
}

export type GiftSaleAssertion =
  | { ok: true; reason: string }
  | { ok: false; code: string; message: string };

export function normalizeGiftReason(raw: string | null | undefined): string {
  return String(raw || '').trim();
}

export function assertGiftSale(input: {
  isGift?: boolean;
  giftReason?: string | null;
  paymentMethod?: string | null;
  paymentLines?: ReadonlyArray<{ paymentMethod: string; amount: number }> | null;
  totalAmount: number;
}): GiftSaleAssertion {
  const gift = input.isGift ?? isGiftSale(input);
  if (!gift) return { ok: true, reason: '' };

  const reason = normalizeGiftReason(input.giftReason);
  if (reason.length < GIFT_REASON_MIN_LENGTH) {
    return {
      ok: false,
      code: 'ERR_GIFT_REASON',
      message: 'Gift requires a reason (who received it and why).',
    };
  }
  if (reason.length > GIFT_REASON_MAX_LENGTH) {
    return {
      ok: false,
      code: 'ERR_GIFT_REASON',
      message: `Gift reason must be at most ${GIFT_REASON_MAX_LENGTH} characters.`,
    };
  }

  const lines = input.paymentLines || [];
  const total = Number(input.totalAmount || 0);
  if (lines.length > 0) {
    if (lines.some((l) => String(l.paymentMethod || '').toUpperCase() === 'CREDIT')) {
      return {
        ok: false,
        code: 'ERR_GIFT_MIXED',
        message: 'Gift cannot mix with credit. The remainder is complimentary, not AR.',
      };
    }
    const giftSum = lines
      .filter((l) => isGiftPaymentMethod(l.paymentMethod))
      .reduce((s, l) => s + Number(l.amount || 0), 0);
    const paidSum = lines
      .filter((l) => !isGiftPaymentMethod(l.paymentMethod))
      .reduce((s, l) => s + Number(l.amount || 0), 0);
    if (giftSum > total + 0.01) {
      return {
        ok: false,
        code: 'ERR_GIFT_AMOUNT',
        message: 'Gift amount cannot exceed the sale total.',
      };
    }
    if (paidSum + giftSum + 0.01 < total) {
      return {
        ok: false,
        code: 'ERR_GIFT_AMOUNT',
        message: 'Gift must cover the unpaid remainder. Partial gift that leaves a balance is not allowed.',
      };
    }
  } else if (!isGiftPaymentMethod(input.paymentMethod)) {
    return {
      ok: false,
      code: 'ERR_GIFT_METHOD',
      message: 'Gift sale requires payment method GIFT.',
    };
  }

  return { ok: true, reason };
}

/** FOC remainder is settled (not AR). Never rewrite GIFT to CREDIT. Mixed pay+gift keeps the money tender. */
export function resolveGiftSettlement(input: {
  isGift: boolean;
  paymentMethod: string;
  hasOutstandingBalance: boolean;
  paymentLines?: ReadonlyArray<{ paymentMethod: string }> | null;
}): { effectivePaymentMethod: string; hasOutstandingBalance: boolean } {
  if (input.isGift) {
    if (isPureGiftSale(input)) {
      return { effectivePaymentMethod: GIFT_PAYMENT_METHOD, hasOutstandingBalance: false };
    }
    const paidMethod =
      (input.paymentLines || []).find((l) => !isGiftPaymentMethod(l.paymentMethod))
        ?.paymentMethod ||
      (isGiftPaymentMethod(input.paymentMethod) ? 'CASH' : input.paymentMethod);
    return { effectivePaymentMethod: paidMethod, hasOutstandingBalance: false };
  }
  return {
    effectivePaymentMethod: input.hasOutstandingBalance ? 'CREDIT' : input.paymentMethod,
    hasOutstandingBalance: input.hasOutstandingBalance,
  };
}

export function shouldSkipSaleRevenueJournal(input: {
  paymentMethod?: string | null;
  paymentLines?: ReadonlyArray<{ paymentMethod: string }> | null;
}): boolean {
  return isPureGiftSale(input);
}

export function isNonBankTenderMethod(method: string | null | undefined): boolean {
  const m = String(method || '').toUpperCase();
  return m === 'CASH' || m === 'CREDIT' || m === 'DEPOSIT' || m === GIFT_PAYMENT_METHOD;
}
