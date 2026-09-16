/**
 * Business notification payload SSOT.
 *
 * Publishers must build outbox payloads here — never invent ad-hoc summary
 * strings or permission prose. The worker turns these fields into inbox /
 * lock-screen copy via formatInboxBody / lockScreenCopy.
 *
 * Fields:
 *   summary       — what happened (verb + detail)
 *   detailSummary — lead line in the inbox (products, party, expense title)
 *   productSummary — alias of detailSummary for product-line events
 *   documentRef   — SALE-/EXP-/CRP-/SP- number
 *   amount        — money fact (formatted later)
 */

import { formatAmountLabel, summarizeSoldProducts } from './presentation.js';

export type BusinessNotificationPayload = {
  summary: string;
  detailSummary?: string;
  productSummary?: string;
  documentRef?: string;
  amount?: number;
  currency?: string;
  locationLabel?: string;
  itemCount?: number;
};

export type BusinessNotificationPayloadInput = {
  /** Short verb phrase: "Sold", "Returned", "Expense paid", "Customer paid" */
  action: string;
  /** Products, customer, supplier, or expense title — never permission copy */
  detail?: string | null;
  documentRef?: string | null;
  amount?: number | null;
  currency?: string | null;
  locationLabel?: string | null;
  itemCount?: number;
};

function trimOrNull(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

export function buildBusinessNotificationPayload(
  input: BusinessNotificationPayloadInput,
): BusinessNotificationPayload {
  const action = input.action.trim();
  const detail = trimOrNull(input.detail);
  const documentRef = trimOrNull(input.documentRef);
  const amountNum = typeof input.amount === 'number' ? input.amount : Number(input.amount);
  const amount = Number.isFinite(amountNum) ? amountNum : undefined;
  const currency = trimOrNull(input.currency) || undefined;
  const locationLabel = trimOrNull(input.locationLabel) || undefined;
  const amountLabel = amount === undefined ? null : formatAmountLabel(amount, currency);

  const summary = detail
    ? `${action} ${detail}`
    : [action, documentRef, amountLabel].filter(Boolean).join(' · ');

  const payload: BusinessNotificationPayload = { summary };
  if (detail) {
    payload.detailSummary = detail;
    payload.productSummary = detail;
  }
  if (documentRef) payload.documentRef = documentRef;
  if (amount !== undefined) payload.amount = amount;
  if (currency) payload.currency = currency;
  if (locationLabel) payload.locationLabel = locationLabel;
  if (typeof input.itemCount === 'number' && Number.isFinite(input.itemCount)) {
    payload.itemCount = input.itemCount;
  }
  return payload;
}

/** Product lines → detail for sale / void / return events. */
export function buildProductLineNotificationPayload(input: {
  action: string;
  /** quantity may be numeric or decimal-string from sale item rows */
  items: Array<{ productName?: string | null; quantity?: number | string | null }>;
  documentRef?: string | null;
  amount?: number | null;
  currency?: string | null;
  locationLabel?: string | null;
}): BusinessNotificationPayload {
  const detail = summarizeSoldProducts(input.items);
  return buildBusinessNotificationPayload({
    action: input.action,
    detail,
    documentRef: input.documentRef,
    amount: input.amount,
    currency: input.currency,
    locationLabel: input.locationLabel,
    itemCount: input.items.length,
  });
}

/** Expense title/category → detail for approval / paid events. */
export function expenseDetailLabel(expense: {
  title?: string | null;
  categoryName?: string | null;
  category?: string | null;
}): string | null {
  const title = trimOrNull(expense.title);
  if (title) return title;
  return trimOrNull(expense.categoryName) || trimOrNull(expense.category);
}
