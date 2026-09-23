/**
 * Global API Error Handler
 *
 * Parses structured BusinessError responses (error_code + details)
 * from the backend and returns user-friendly messages.
 *
 * Usage:
 *   import { handleApiError } from '@/utils/errorHandler';
 *
 *   catch (error) {
 *     handleApiError(error);                     // toast.error with structured message
 *     handleApiError(error, { silent: true });    // returns message without toasting
 *     handleApiError(error, { fallback: 'Custom fallback' });
 *   }
 */
import axios, { type AxiosError } from 'axios';
import toast from 'react-hot-toast';
import { toast as sonnerToast } from 'sonner';
import { formatCurrency } from './currency';

// ── Types ──────────────────────────────────────────────────────────

/**
 * Thrown (and re-rejected) by the API interceptor after it has already
 * shown a toast for a GOV_RULE_* / ACC_RULE_* / INV_RULE_* / HTTP error.
 * Catch handlers that call handleApiError / toastApiError skip a
 * duplicate toast. A global toast.error / sonner wrapper also suppresses
 * re-toasts of the same message when pages still call toast.error(msg).
 */
export class HandledApiError extends Error {
  readonly isHandled = true as const;
  /** Original HTTP status when known (403 must never be treated as session death). */
  readonly httpStatus?: number;
  readonly errorCode?: string;
  constructor(message: string, opts?: { httpStatus?: number; errorCode?: string }) {
    super(message);
    this.name = 'HandledApiError';
    this.httpStatus = opts?.httpStatus;
    this.errorCode = opts?.errorCode;
  }
}

/** True when interceptor already classified this as HTTP 403 (RBAC / ownership). */
export function isHandledForbiddenError(error: unknown): boolean {
  return error instanceof HandledApiError && error.httpStatus === 403;
}

// ── Global anti-double-toast (SSOT) ──────────────────────────────────
// Interceptor toasts first, then rejects HandledApiError. Many screens still
// call toast.error(...) in catch / onError — suppress those for a short window.

const API_TOAST_DEDUPE_MS = 6000;
const recentApiErrorNotices = new Map<string, number>();
let rhtToastErrorPatched = false;
let sonnerToastErrorPatched = false;

function normalizeToastText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Record messages already shown for an API failure (call once per interceptor notify). */
export function markApiErrorNotified(...messages: Array<string | null | undefined>): void {
  const now = Date.now();
  for (const raw of messages) {
    if (typeof raw !== 'string') continue;
    const n = normalizeToastText(raw);
    if (n.length < 2) continue;
    recentApiErrorNotices.set(n, now);
  }
  for (const [k, t] of recentApiErrorNotices) {
    if (now - t > API_TOAST_DEDUPE_MS * 2) recentApiErrorNotices.delete(k);
  }
}

/** True when a redundant toast for this API message would be a double-notify. */
export function shouldSuppressApiErrorToast(
  ...messages: Array<string | null | undefined>
): boolean {
  const now = Date.now();
  for (const raw of messages) {
    if (typeof raw !== 'string') continue;
    const n = normalizeToastText(raw);
    if (!n) continue;
    const t = recentApiErrorNotices.get(n);
    if (t != null && now - t < API_TOAST_DEDUPE_MS) return true;
  }
  return false;
}

function collectToastMessageTexts(message: unknown, options?: unknown): string[] {
  const out: string[] = [];
  if (typeof message === 'string') out.push(message);
  if (options && typeof options === 'object') {
    const o = options as { description?: unknown; id?: unknown };
    if (typeof o.description === 'string') out.push(o.description);
    if (typeof o.id === 'string') out.push(o.id);
  }
  return out;
}

/**
 * Wrap a toast.error implementation so previously notified API messages are no-ops.
 * Used by production install and by proof/evidence tests (pure — no spy side effects).
 */
export function wrapToastErrorWithApiDedupe(
  original: (message: unknown, options?: unknown) => unknown,
): (message: unknown, options?: unknown) => unknown {
  return (message: unknown, options?: unknown) => {
    const texts = collectToastMessageTexts(message, options);
    if (texts.length > 0 && shouldSuppressApiErrorToast(...texts)) {
      return typeof options === 'object' &&
        options &&
        'id' in options &&
        typeof (options as { id?: unknown }).id === 'string'
        ? (options as { id: string }).id
        : 'suppressed-api-error';
    }
    return original(message, options);
  };
}

function installToastErrorDedupe(
  host: { error: (...args: unknown[]) => unknown },
  flag: { get: () => boolean; set: () => void },
): void {
  if (flag.get()) return;
  flag.set();

  const unwrapped = host.error as ((...args: unknown[]) => unknown) & {
    mockImplementation?: (fn: (...args: unknown[]) => unknown) => unknown;
    getMockImplementation?: () => ((...args: unknown[]) => unknown) | undefined;
    __apiToastDedupe?: boolean;
  };

  // Vitest/Jest: keep the spy identity (so expect(toast.error).not.toHaveBeenCalled works
  // for code paths that never invoke toast). Additionally wire dedupe for production realism.
  if (typeof unwrapped.mockImplementation === 'function') {
    if (unwrapped.__apiToastDedupe) return;
    const prior =
      (typeof unwrapped.getMockImplementation === 'function'
        ? unwrapped.getMockImplementation()
        : undefined) || (() => undefined);
    unwrapped.__apiToastDedupe = true;
    unwrapped.mockImplementation(wrapToastErrorWithApiDedupe(prior));
    return;
  }

  // Production (real toast APIs): replace host.error so the underlying toast never fires twice
  const original = host.error.bind(host) as (message: unknown, options?: unknown) => unknown;
  host.error = wrapToastErrorWithApiDedupe(original) as typeof host.error;
}

/**
 * Patch toast libraries so page-level re-toasts of interceptor failures are no-ops.
 * Safe to call multiple times. Invoked on module load and from App bootstrap.
 */
export function installGlobalApiToastDedupe(): void {
  installToastErrorDedupe(toast as { error: (...args: unknown[]) => unknown }, {
    get: () => rhtToastErrorPatched,
    set: () => {
      rhtToastErrorPatched = true;
    },
  });

  try {
    installToastErrorDedupe(sonnerToast as { error: (...args: unknown[]) => unknown }, {
      get: () => sonnerToastErrorPatched,
      set: () => {
        sonnerToastErrorPatched = true;
      },
    });
  } catch {
    // sonner may be absent in some test shims
  }
}

/** Test-only: clear dedupe window between suites. */
export function resetApiErrorToastDedupeForTests(): void {
  recentApiErrorNotices.clear();
}

/** User-facing copy for HTTP 403 / RBAC denials — never show status codes. */
export const ACCESS_DENIED_MESSAGE =
  'You do not have permission to perform this action. Contact an administrator if you need access.';

const AXIOS_STATUS_CODE_MESSAGE = /^Request failed with status code (\d+)$/i;

function isGenericPermissionMessage(message: string | undefined): boolean {
  if (!message) return false;
  const normalized = message.trim().toLowerCase();
  return (
    normalized === 'insufficient permissions' ||
    normalized === 'forbidden' ||
    normalized === 'access denied'
  );
}

/** Map HTTP status / raw Axios text to a stable user-facing message. */
export function friendlyHttpErrorMessage(
  status: number | undefined,
  apiError?: string,
  fallback = 'Something went wrong. Please try again.'
): string {
  const statusFromAxiosMsg = apiError?.match(AXIOS_STATUS_CODE_MESSAGE)?.[1];
  const resolvedStatus = status ?? (statusFromAxiosMsg ? Number(statusFromAxiosMsg) : undefined);

  if (resolvedStatus === 403 || isGenericPermissionMessage(apiError)) {
    // Preserve specific ownership / floor messages — not generic "Access denied".
    if (
      apiError &&
      !AXIOS_STATUS_CODE_MESSAGE.test(apiError) &&
      /another waiter|belongs to another|edit others|reassign/i.test(apiError)
    ) {
      return apiError;
    }
    return ACCESS_DENIED_MESSAGE;
  }
  if (apiError && !AXIOS_STATUS_CODE_MESSAGE.test(apiError)) {
    return apiError;
  }
  if (resolvedStatus === 401) return 'Your session has expired. Please sign in again.';
  if (resolvedStatus === 400 || resolvedStatus === 422) {
    return 'Please check your input and try again.';
  }
  if (resolvedStatus === 404) return 'The requested item was not found.';
  if (resolvedStatus === 409) {
    return 'This conflicts with existing data. Please refresh and try again.';
  }
  if (resolvedStatus === 429) return 'Too many requests. Please wait a moment and try again.';
  if (resolvedStatus && resolvedStatus >= 500) {
    return 'Something went wrong on the server. Please try again.';
  }
  return fallback;
}

/** Standard toast title for an HTTP status — never includes status codes. */
export function titleForHttpStatus(status?: number): string {
  switch (status) {
    case 400:
      return 'Invalid request';
    case 401:
      return 'Session expired';
    case 403:
      return 'Access denied';
    case 404:
      return 'Not found';
    case 409:
      return 'Conflict';
    case 422:
      return 'Action not allowed';
    case 429:
      return 'Too many requests';
    default:
      if (status && status >= 500) return 'Server error';
      return 'Something went wrong';
  }
}

export interface UserFacingApiNotification {
  title: string;
  message: string;
  /** Stable id so rapid duplicate failures collapse to one toast */
  toastId: string;
  status?: number;
}

/**
 * Toast an API error unless the interceptor already notified (HandledApiError).
 */
export function toastApiError(error: unknown, fallback?: string): void {
  if (error instanceof HandledApiError) return;
  const notification = resolveUserFacingApiNotification(error);
  const msg =
    fallback && notification.message === 'Something went wrong. Please try again.'
      ? fallback
      : notification.message;
  toast.error(msg, { duration: 6000, id: notification.toastId });
}

export interface ValidationDetail {
  path: string;
  message: string;
  field?: string;
}

export interface StructuredErrorResponse {
  success: false;
  error: string;
  error_code?: string;
  details?: Record<string, unknown> | ValidationDetail[];
}

export interface HandleApiErrorOptions {
  /** If true, do NOT call toast — just return the formatted message */
  silent?: boolean;
  /** Fallback message when no structured info is available */
  fallback?: string;
}

export interface ParsedApiError {
  /** Human-readable message (single paragraph) */
  message: string;
  /** The raw error_code from backend, if any */
  errorCode?: string;
  /** The raw details object from backend, if any */
  details?: Record<string, unknown>;
  /** Validation field errors (from Zod), if any */
  validationErrors?: ValidationDetail[];
  /** HTTP status code, if available */
  status?: number;
}

// ── Core parser ────────────────────────────────────────────────────

/**
 * Extract structured error info from an unknown caught error.
 */
export function parseApiError(
  error: unknown,
  fallback = 'An unexpected error occurred'
): ParsedApiError {
  if (error instanceof HandledApiError) {
    return { message: error.message || fallback };
  }

  if (axios.isAxiosError(error)) {
    const axErr = error as AxiosError<StructuredErrorResponse>;
    const data = axErr.response?.data;
    const status = axErr.response?.status;

    if (data && typeof data === 'object') {
      // Detect Zod validation arrays: details is [{path, message}, ...]
      const rawDetails = data.details;
      const isValidationArray =
        Array.isArray(rawDetails) &&
        rawDetails.length > 0 &&
        typeof rawDetails[0] === 'object' &&
        ('message' in rawDetails[0] || 'path' in rawDetails[0]);

      return {
        message: friendlyHttpErrorMessage(status, data.error, fallback),
        errorCode: data.error_code,
        details: isValidationArray ? undefined : (rawDetails as Record<string, unknown>),
        validationErrors: isValidationArray ? (rawDetails as ValidationDetail[]) : undefined,
        status,
      };
    }

    return {
      message: friendlyHttpErrorMessage(status, axErr.message, fallback),
      status,
    };
  }

  if (error instanceof Error) {
    if (AXIOS_STATUS_CODE_MESSAGE.test(error.message)) {
      const status = Number(error.message.match(AXIOS_STATUS_CODE_MESSAGE)?.[1]);
      return { message: friendlyHttpErrorMessage(status, error.message, fallback), status };
    }
    return { message: error.message || fallback };
  }

  return { message: fallback };
}

// ── Friendly message builders per error-code prefix ────────────────

function formatStockError(parsed: ParsedApiError): string {
  const d = parsed.details;
  if (!d) return parsed.message;

  const product = d.product as string | undefined;
  const requested = d.requested as number | undefined;
  const available = d.available as number | undefined;
  const shortBy = d.shortBy as number | undefined;
  const expiryDate = d.expiryDate as string | undefined;

  let msg = `📦 Insufficient Stock`;
  if (product) msg += ` — ${product}`;
  msg += '\n';
  if (requested != null) msg += `Requested: ${requested}`;
  if (available != null) msg += ` | Available: ${available}`;
  if (shortBy != null) msg += ` | Short by: ${shortBy}`;
  if (expiryDate) msg += `\nExpiry constraint: ${expiryDate}`;
  return msg;
}

function formatPaymentError(parsed: ParsedApiError): string {
  const d = parsed.details;
  if (!d) return parsed.message;

  const totalAmount = d.totalAmount as number | undefined;
  const amountReceived = d.amountReceived as number | undefined;
  const shortfall = d.shortfall as number | undefined;

  let msg = '💰 Insufficient Payment\n';
  if (totalAmount != null) msg += `Total: ${formatCurrency(totalAmount)}`;
  if (amountReceived != null) msg += ` | Received: ${formatCurrency(amountReceived)}`;
  if (shortfall != null) msg += ` | Short: ${formatCurrency(shortfall)}`;
  return msg;
}

function formatUserError(parsed: ParsedApiError): string {
  const code = parsed.errorCode;
  switch (code) {
    case 'ERR_USER_001':
      return `Email already in use: ${parsed.details?.email ?? ''}`.trim();
    case 'ERR_USER_002':
      return 'Current password is incorrect';
    case 'ERR_USER_004':
      return 'Cannot delete user — they have existing transactions. Deactivate instead.';
    default:
      return parsed.message;
  }
}

function formatExpenseError(parsed: ParsedApiError): string {
  const code = parsed.errorCode;
  switch (code) {
    case 'ERR_EXPENSE_012':
      return 'This expense has already been reversed.';
    case 'ERR_EXPENSE_013':
      return 'Only approved or paid expenses can be reversed.';
    case 'ERR_EXPENSE_014':
      return 'No posted GL found for this expense. It cannot be reversed.';
    case 'ERR_EXPENSE_015':
      return 'Linked bank transaction is reconciled. Unreconcile it before reversing this expense.';
    case 'ERR_EXPENSE_016':
      return 'Reversal would leave a GL mismatch. Nothing was changed.';
    case 'ERR_EXPENSE_007':
      return `Category code already exists: ${parsed.details?.code ?? ''}`.trim();
    case 'ERR_EXPENSE_008':
      return 'Permission denied — you can only manage your own expenses.';
    case 'ERR_EXPENSE_009': {
      const count = parsed.details?.expenseCount;
      return `Cannot delete category — it has ${count ?? 'existing'} expense(s). Reassign them first.`;
    }
    default:
      return parsed.message;
  }
}

function formatJournalError(parsed: ParsedApiError): string {
  const d = parsed.details;
  if (!d) return parsed.message;

  const code = parsed.errorCode;
  switch (code) {
    case 'ERR_JOURNAL_002':
      return `Journal entry requires at least ${d.minimumRequired ?? 2} lines (you have ${d.lineCount ?? 0}).`;
    case 'ERR_JOURNAL_008': {
      const diff = d.difference as number | undefined;
      return `Journal entry is not balanced — difference: ${diff != null ? formatCurrency(diff) : 'unknown'}.`;
    }
    case 'ERR_JOURNAL_010':
      return 'This journal entry has already been reversed.';
    default:
      return parsed.message;
  }
}

function formatCostLayerError(parsed: ParsedApiError): string {
  const d = parsed.details;
  if (!d) return parsed.message;

  const code = parsed.errorCode;
  switch (code) {
    case 'ERR_COSTLAYER_004': {
      const requested = d.requested as number | undefined;
      const available = d.available as number | undefined;
      return `Insufficient inventory — requested ${requested ?? '?'}, available ${available ?? '?'}.`;
    }
    case 'ERR_COSTLAYER_005':
      return `Invalid costing method "${d.costingMethod}". Valid: ${d.validMethods ?? 'FIFO, AVCO, STANDARD'}`;
    default:
      return parsed.message;
  }
}

function formatPricingError(parsed: ParsedApiError): string {
  return parsed.message;
}

function formatSaleError(parsed: ParsedApiError): string {
  const d = parsed.details;
  const code = parsed.errorCode;
  if (!d) return parsed.message;

  switch (code) {
    case 'ERR_SALE_001':
      return `No cost layers found for product "${d.productId ?? ''}". Receive stock first.`;
    case 'ERR_SALE_002':
      return 'Credit sales require a customer to be selected.';
    case 'ERR_SALE_003': {
      const balance = d.outstandingBalance as number | undefined;
      return `Customer has an outstanding balance of ${balance != null ? formatCurrency(balance) : 'unknown'}. Please select a customer.`;
    }
    case 'ERR_SALE_004':
      return 'Failed to apply customer deposits. Please check the customer account.';
    case 'ERR_SALE_005': {
      const status = d.currentStatus as string | undefined;
      return `Cannot convert quotation — current status is "${status ?? 'unknown'}".`;
    }
    case 'ERR_SALE_006':
      return 'Cannot create invoice — the selected customer does not exist.';
    case 'ERR_SALE_007':
      return 'Credit sale completed but invoice creation failed. Please contact a manager.';
    case 'ERR_SALE_008': {
      const status = d.currentStatus as string | undefined;
      return `Cannot void this sale — it is currently "${status ?? 'unknown'}". Only completed sales can be voided.`;
    }
    case 'ERR_SALE_009':
      return 'A reason is required when voiding a sale.';
    case 'ERR_SALE_010': {
      const threshold = d.amountThreshold as number | undefined;
      return `Manager approval required for voiding sales over ${threshold != null ? formatCurrency(threshold) : 'the threshold'}.`;
    }
    case 'ERR_SALE_011':
      return 'Only managers or admins can approve void requests.';
    case 'ERR_SALE_012':
      return `Service products missing account configuration: ${d.products ?? ''}. Update product settings.`;
    case 'ERR_SALE_013':
      return 'Sale not found or already voided.';
    case 'ERR_PAYMENT_002': {
      const amt = d.amountReceived as number | undefined;
      return `Payment amount ${amt != null ? formatCurrency(amt) : ''} cannot be negative.`.trim();
    }
    case 'ERR_PAYMENT_003': {
      const total = d.totalAmount as number | undefined;
      const received = d.amountReceived as number | undefined;
      return `Overpayment not allowed for credit sales. Total: ${total != null ? formatCurrency(total) : '?'}, Received: ${received != null ? formatCurrency(received) : '?'}.`;
    }
    case 'ERR_PAYMENT_004': {
      const payments = d.totalPayments as number | undefined;
      const invoiceTotal = d.invoiceTotal as number | undefined;
      return `Total payments ${payments != null ? formatCurrency(payments) : '?'} exceed invoice total ${invoiceTotal != null ? formatCurrency(invoiceTotal) : '?'}.`;
    }
    default:
      return parsed.message;
  }
}

// ── Map error_code prefix → formatter ──────────────────────────────

function formatValidationErrors(parsed: ParsedApiError): string {
  const errors = parsed.validationErrors;
  if (!errors || errors.length === 0) return parsed.message;

  const bullets = errors
    .map((e) => {
      const field = e.field || e.path;
      const label = field ? humanizeField(field) : '';
      return label ? `• ${label}: ${e.message}` : `• ${e.message}`;
    })
    .join('\n');

  return `Please fix the following:\n\n${bullets}`;
}

/** Convert snake_case / camelCase field paths to readable labels */
function humanizeField(field: string): string {
  // Take the last segment (e.g. "items.0.quantity" → "quantity")
  const last = field.split('.').pop() || field;
  return last
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatByErrorCode(parsed: ParsedApiError): string {
  // Validation field-level errors always take priority
  if (parsed.validationErrors && parsed.validationErrors.length > 0) {
    return formatValidationErrors(parsed);
  }

  const code = parsed.errorCode;
  if (!code) return parsed.message;

  if (code === 'ERR_STOCK_001' || code === 'ERR_EXPIRY_001') return formatStockError(parsed);
  if (code === 'ERR_PAYMENT_001') return formatPaymentError(parsed);
  if (code.startsWith('ERR_SALE_') || code.startsWith('ERR_PAYMENT_'))
    return formatSaleError(parsed);
  if (code.startsWith('ERR_USER_')) return formatUserError(parsed);
  if (code.startsWith('ERR_EXPENSE_')) return formatExpenseError(parsed);
  if (code.startsWith('ERR_JOURNAL_')) return formatJournalError(parsed);
  if (code.startsWith('ERR_COSTLAYER_')) return formatCostLayerError(parsed);
  if (code.startsWith('ERR_PRICING_')) return formatPricingError(parsed);
  if (code === 'ERR_RETURN_GRN_001') {
    return (
      'Supplier bill required before credit note.\n\n' +
      '1. On this Goods Receipt, click **Create Supplier Bill** (receipt must be finalized).\n' +
      '2. After the bill exists, click **Create Credit Note** on the posted return.\n\n' +
      'Credit notes reduce accounts payable against a bill — they cannot be created while the receipt is still unbilled.'
    );
  }
  if (code === 'ERR_SCN_FULL_REVERSE') {
    return (
      'No credit note needed — this goods receipt was fully reversed.\n\n' +
      'Stock, GR/IR, and any unpaid supplier bill were already cleared when the return posted. ' +
      'Credit notes only apply to partial returns against an open supplier bill.'
    );
  }

  // Accounting / governance / inventory rule violations
  if (
    code.startsWith('GOV_RULE_') ||
    code.startsWith('ACC_RULE_') ||
    code.startsWith('INV_RULE_')
  ) {
    // Prefer details.reason (set by backend for GOV_RULE errors);
    // fall back to the top-level error message
    return (parsed.details?.reason as string | undefined) ?? parsed.message;
  }

  // Generic classified errors from middleware (catches all plain Error throws)
  if (code === 'ERR_NOT_FOUND')
    return `Not found: ${(parsed.details?.reason as string) || parsed.message}`;
  if (code === 'ERR_AUTH') return parsed.message;
  if (code === 'ERR_FORBIDDEN' || parsed.status === 403) return ACCESS_DENIED_MESSAGE;
  if (code === 'ERR_VALIDATION') return parsed.message;
  if (code === 'ERR_BUSINESS') return parsed.message;
  if (code === 'ERR_CONSTRAINT')
    return 'A data constraint was violated. Please check your input values.';
  if (code === 'ERR_INTERNAL') return parsed.message;

  // Unknown structured error — still better than the raw message alone
  return parsed.message;
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Handle an API error: parse, format, and optionally toast.
 *
 * @returns The formatted user-facing error message.
 */
export function handleApiError(error: unknown, options: HandleApiErrorOptions = {}): string {
  const { silent = false, fallback = 'An unexpected error occurred' } = options;

  // The API interceptor already showed a toast for GOV/ACC/INV rule errors and 403s;
  // don't toast again from individual catch blocks.
  if (error instanceof HandledApiError) {
    return error.message;
  }

  const parsed = parseApiError(error, fallback);
  const friendly =
    parsed.status === 403 ? ACCESS_DENIED_MESSAGE : formatByErrorCode(parsed);

  if (!silent) {
    toast.error(friendly, {
      duration: 6000,
      ...(parsed.status === 403 ? { id: 'app-forbidden', icon: '🔒' } : {}),
    });
  }

  return friendly;
}

/**
 * Sugar for getting just the formatted message without side-effects.
 */
export function getStructuredErrorMessage(error: unknown, fallback?: string): string {
  return handleApiError(error, { silent: true, fallback });
}

/**
 * SSOT: resolve any API/Axios/unknown error into a clear user notification.
 * Never returns "Request failed with status code NNN".
 */
export function resolveUserFacingApiNotification(error: unknown): UserFacingApiNotification {
  if (error instanceof HandledApiError) {
    return {
      title: 'Notice',
      message: error.message || 'Something went wrong. Please try again.',
      toastId: 'app-api-handled',
    };
  }

  const parsed = parseApiError(error, 'Something went wrong. Please try again.');
  // Prefer API body (ownership / business copy) via friendly mapper — not blind ACCESS_DENIED.
  let message =
    parsed.status === 403
      ? friendlyHttpErrorMessage(403, parsed.message, ACCESS_DENIED_MESSAGE)
      : formatByErrorCode(parsed);

  if (AXIOS_STATUS_CODE_MESSAGE.test(message)) {
    message = friendlyHttpErrorMessage(parsed.status, message);
  }

  const reason =
    typeof parsed.details?.reason === 'string' ? parsed.details.reason.trim() : '';
  if (
    reason &&
    (message === parsed.message ||
      isGenericPermissionMessage(message) ||
      message === 'Please check your input and try again.')
  ) {
    message = reason;
  }

  const status = parsed.status;
  const ownership403 =
    status === 403 && /another waiter|belongs to another|edit others|reassign/i.test(message);
  const toastId = ownership403
    ? 'app-forbidden-ownership'
    : status === 403
      ? 'app-forbidden'
      : `app-api-${status ?? 'error'}-${(parsed.errorCode || message).slice(0, 48)}`;

  return {
    title: ownership403 ? 'Table in use' : titleForHttpStatus(status),
    message,
    toastId,
    status,
  };
}

/** Dispatch the global standard API error toast (App.tsx listener). */
export function dispatchUserFacingApiNotification(error: unknown): HandledApiError {
  const notification = resolveUserFacingApiNotification(error);
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    if (notification.status === 403) {
      window.dispatchEvent(new CustomEvent('app:forbidden', { detail: notification.message }));
    } else {
      window.dispatchEvent(new CustomEvent('app:api-error', { detail: notification }));
    }
  }
  // App listener may toast a React node (not a string). Register body/title so
  // catch-block toast.error(message) does not double-fire.
  markApiErrorNotified(notification.message, notification.title, notification.toastId);
  return new HandledApiError(notification.message, {
    httpStatus: notification.status,
  });
}

// Install once on import (api.ts / App both pull this module).
installGlobalApiToastDedupe();
