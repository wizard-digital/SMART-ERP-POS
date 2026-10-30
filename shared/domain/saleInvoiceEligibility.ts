/**
 * Sale → invoice eligibility SSOT.
 *
 * One rule for every tenant. Opening-balance AR invoices (OB-*) are a
 * different document path and are not gated here.
 *
 * Eligible when the sale is live AND any of:
 *   - linked quote (conversion always invoices)
 *   - CREDIT header or CREDIT tender (AR remainder)
 *   - amount_paid < charged total (outstanding, including CASH underpay)
 *
 * Fully paid non-credit sales are not invoiced. Voided / fully returned
 * sales are not invoiced.
 */

import { SALE_DISCOUNT_MONEY_TOLERANCE } from './saleDiscountSsot.js';

export const SALE_NOT_INVOICEABLE_STATUSES = [
  'VOID',
  'VOIDED',
  'REFUNDED',
  'VOIDED_BY_RETURN',
  'CANCELLED',
] as const;

export type SaleInvoiceEligibilityReason =
  | 'quote'
  | 'credit'
  | 'outstanding'
  | 'fully_paid_cash'
  | 'sale_not_live'
  | 'missing_sale';

export type SaleInvoiceEligibilityInput = {
  status?: string | null;
  quoteId?: string | null;
  paymentMethod?: string | null;
  amountPaid?: number | null;
  totalAmount?: number | null;
  hasCreditTender?: boolean;
};

export type SaleInvoiceEligibility = {
  ok: boolean;
  reason: SaleInvoiceEligibilityReason;
};

function num(v: unknown): number {
  if (v == null || v === '') return 0;
  const x = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(x) ? x : 0;
}

export function saleIsInvoiceEligible(
  input: SaleInvoiceEligibilityInput | null | undefined,
): SaleInvoiceEligibility {
  if (!input) return { ok: false, reason: 'missing_sale' };

  const status = String(input.status || '').trim().toUpperCase();
  if (
    status &&
    (SALE_NOT_INVOICEABLE_STATUSES as readonly string[]).includes(status)
  ) {
    return { ok: false, reason: 'sale_not_live' };
  }

  const quoteId = input.quoteId != null ? String(input.quoteId).trim() : '';
  if (quoteId) return { ok: true, reason: 'quote' };

  const method = String(input.paymentMethod || '').trim().toUpperCase();
  if (method === 'CREDIT' || input.hasCreditTender === true) {
    return { ok: true, reason: 'credit' };
  }

  const total = num(input.totalAmount);
  const paid = num(input.amountPaid);
  if (total - paid > SALE_DISCOUNT_MONEY_TOLERANCE) {
    return { ok: true, reason: 'outstanding' };
  }

  return { ok: false, reason: 'fully_paid_cash' };
}

/** Loose sale row (customer sales list / POS / invoice picker). */
export function saleRowIsInvoiceEligible(
  row: object | null | undefined,
): SaleInvoiceEligibility {
  if (!row) return { ok: false, reason: 'missing_sale' };
  const rec = row as Record<string, unknown>;
  const method = String(rec.paymentMethod || rec.payment_method || '');
  const lines = Array.isArray(rec.paymentLines)
    ? rec.paymentLines
    : Array.isArray(rec.payment_lines)
      ? rec.payment_lines
      : [];
  const hasCreditTender = lines.some((line) => {
    if (!line || typeof line !== 'object') return false;
    const pay = line as Record<string, unknown>;
    return String(pay.paymentMethod || pay.payment_method || '').toUpperCase() === 'CREDIT';
  });
  return saleIsInvoiceEligible({
    status: String(rec.status || ''),
    quoteId: (rec.quoteId || rec.quote_id || null) as string | null,
    paymentMethod: method,
    amountPaid: num(rec.amountPaid ?? rec.amount_paid),
    totalAmount: num(rec.totalAmount ?? rec.total_amount),
    hasCreditTender,
  });
}

/** Header cash (or card/momo) to copy onto the invoice when sale_payments is empty. */
export function invoicePaymentsFromSaleHeader(params: {
  amountPaid: number;
  paymentMethod?: string | null;
  hasPaymentLines: boolean;
}): { amount: number; method: string } | null {
  if (params.hasPaymentLines) return null;
  const amount = num(params.amountPaid);
  if (amount <= SALE_DISCOUNT_MONEY_TOLERANCE) return null;
  const method = String(params.paymentMethod || 'CASH').trim().toUpperCase();
  return {
    amount,
    method: method === 'CREDIT' ? 'CASH' : method || 'CASH',
  };
}
