/**
 * Store Issue to Expense — pure plan (SAP GI 201 / B1 Goods Issue).
 * No inventory ownership. Service layer posts through Inventory Engine.
 */

export type StoreIssueStatus = 'DRAFT' | 'POSTED' | 'CANCELLED' | 'REVERSED';

export type StoreIssueDocumentType = 'INGREDIENT_ISSUE';

export type StoreIssuePostingIntent = 'EXPENSE';

export type StoreIssueIssuedTo = 'KITCHEN' | 'BAR' | 'HOUSEKEEPING' | 'OTHER';

/** Dedicated consumption account. Never 5000 (sale COGS) or 5110–5140 (loss/markdown). */
export const STORE_ISSUE_EXPENSE_ACCOUNT = '5150';

export const STORE_ISSUE_FORBIDDEN_ACCOUNTS = [
  '5000',
  '5110',
  '5120',
  '5130',
  '5140',
] as const;

export const STORE_ISSUE_MOVEMENT_TYPE = 'GOODS_ISSUE';

/** SAP GI 202 — restores stock that GOODS_ISSUE consumed. */
export const STORE_ISSUE_REVERSAL_MOVEMENT_TYPE = 'GOODS_ISSUE_REVERSAL';

/** Dedicated reverse posting — not kitchen.production.post and not inventory.adjust. */
export const STORE_ISSUE_REVERSE_PERMISSION = 'kitchen.production.reverse';

/** Self-reverse exception (owner / inventory.approve). Everyone else is four-eyes. */
export const STORE_ISSUE_FOUR_EYES_OVERRIDE_PERMISSION = 'inventory.approve';

export const STORE_ISSUE_REVERSE_REASON_MIN = 3;
export const STORE_ISSUE_REVERSE_REASON_MAX = 500;

/** Watch KPI: reversed 5150 amount / issued 5150 amount. */
export const STORE_ISSUE_REVERSE_RATE_WATCH = 0.2;

export const STORE_ISSUE_ECONOMIC_EVENT = 'INTERNAL_CONSUMPTION';

export const STORE_ISSUE_ISSUED_TO: readonly StoreIssueIssuedTo[] = [
  'KITCHEN',
  'BAR',
  'HOUSEKEEPING',
  'OTHER',
] as const;

const QUARANTINE_OR_TRANSIT = new Set(['DAMAGE', 'EXPIRED', 'RETURN', 'TRANSIT']);

export function canEditStoreIssue(status: StoreIssueStatus): boolean {
  return status === 'DRAFT';
}

export function canPostStoreIssue(status: StoreIssueStatus): boolean {
  return status === 'DRAFT';
}

export function canCancelStoreIssue(status: StoreIssueStatus): boolean {
  return status === 'DRAFT';
}

export function canReverseStoreIssue(status: StoreIssueStatus): boolean {
  return status === 'POSTED';
}

/**
 * Store Issue UI gate. Restaurant mode is the only tenant switch.
 * Do not AND this with kitchen-production/issues/enabled — that endpoint can
 * read the wrong database and lie that restaurant is off.
 */
export function storeIssueUiGate(
  restaurantEnabled: boolean | undefined | null,
): 'ok' | 'restaurant-off' {
  return restaurantEnabled ? 'ok' : 'restaurant-off';
}

export function normalizeStoreIssueReversalReason(reason: string | null | undefined): string {
  const trimmed = String(reason ?? '').trim();
  if (trimmed.length < STORE_ISSUE_REVERSE_REASON_MIN) {
    throw new Error('Reversal reason is required (at least 3 characters).');
  }
  if (trimmed.length > STORE_ISSUE_REVERSE_REASON_MAX) {
    throw new Error('Reversal reason is too long');
  }
  return trimmed;
}

export function assertStoreIssueFourEyes(input: {
  postedBy: string | null | undefined;
  reversingUserId: string;
  canOverrideFourEyes: boolean;
}): void {
  const postedBy = String(input.postedBy || '');
  if (!postedBy || !input.reversingUserId) return;
  if (postedBy === input.reversingUserId && !input.canOverrideFourEyes) {
    throw new Error(
      'You cannot reverse a goods issue you posted. A second authorized user must reverse it.',
    );
  }
}

export function assertStoreIssueReverseGovernance(input: {
  reason: string | null | undefined;
  postedBy: string | null | undefined;
  reversingUserId: string;
  canOverrideFourEyes: boolean;
}): string {
  const reason = normalizeStoreIssueReversalReason(input.reason);
  assertStoreIssueFourEyes(input);
  return reason;
}

/** Fail closed: never reverse GL if the original FEFO consume movements are missing or short. */
export function assertStoreIssueReverseMovements(issuedQtyBase: number, movementQty: number): void {
  const issued = Number(issuedQtyBase) || 0;
  const moved = Number(movementQty) || 0;
  if (issued > 0.001 && moved < 0.001) {
    throw new Error('Cannot reverse: original goods-issue movements were not found.');
  }
  if (Math.abs(issued - moved) > 0.001) {
    throw new Error('Cannot reverse: restored quantity does not match the original issue.');
  }
}

export function escapeIlikePattern(raw: string): string {
  return String(raw || '').replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

export function normalizeInclusiveDateRange(startDate: string, endDate: string): {
  startDate: string;
  endDate: string;
} {
  if (startDate && endDate && startDate > endDate) {
    return { startDate: endDate, endDate: startDate };
  }
  return { startDate, endDate };
}

export function filterStoreIssueAuditRows<T extends { movementType: string }>(
  rows: T[],
  movement: StoreIssueAuditMovementFilter,
): T[] {
  if (movement === 'ALL') return rows;
  return rows.filter((row) => row.movementType === movement);
}

export type StoreIssueAuditMovementFilter = 'ALL' | 'GOODS_ISSUE' | 'GOODS_ISSUE_REVERSAL';

export function parseStoreIssueAuditMovementFilter(raw: unknown): StoreIssueAuditMovementFilter {
  const v = String(raw || 'ALL').toUpperCase();
  if (v === 'ISSUE' || v === 'GOODS_ISSUE' || v === '201') return 'GOODS_ISSUE';
  if (v === 'REVERSE' || v === 'REVERSAL' || v === 'GOODS_ISSUE_REVERSAL' || v === '202') {
    return 'GOODS_ISSUE_REVERSAL';
  }
  return 'ALL';
}

export function storeIssueAuditMovementLabel(movementType: string): string {
  return movementType === STORE_ISSUE_REVERSAL_MOVEMENT_TYPE ? 'Reverse' : 'Issue';
}

export function summarizeStoreIssueAudit(
  rows: Array<{ movementType: string; amount: number; quantity: number }>,
): {
  issuedAmount: number;
  reversedAmount: number;
  netAmount: number;
  reverseRate: number;
  issuedQty: number;
  reversedQty: number;
  issueLines: number;
  reverseLines: number;
} {
  let issuedAmount = 0;
  let reversedAmount = 0;
  let issuedQty = 0;
  let reversedQty = 0;
  let issueLines = 0;
  let reverseLines = 0;
  for (const row of rows) {
    const amount = Number(row.amount) || 0;
    const quantity = Number(row.quantity) || 0;
    if (row.movementType === STORE_ISSUE_REVERSAL_MOVEMENT_TYPE) {
      reversedAmount += amount;
      reversedQty += quantity;
      reverseLines += 1;
    } else {
      issuedAmount += amount;
      issuedQty += quantity;
      issueLines += 1;
    }
  }
  const reverseRate = issuedAmount > 0 ? reversedAmount / issuedAmount : 0;
  return {
    issuedAmount,
    reversedAmount,
    netAmount: issuedAmount - reversedAmount,
    reverseRate,
    issuedQty,
    reversedQty,
    issueLines,
    reverseLines,
  };
}

export function isStoreIssueIssuedTo(value: string | null | undefined): value is StoreIssueIssuedTo {
  return STORE_ISSUE_ISSUED_TO.includes(String(value || '').toUpperCase() as StoreIssueIssuedTo);
}

export function normalizeIssuedTo(value: string | null | undefined): StoreIssueIssuedTo {
  const upper = String(value || 'KITCHEN').toUpperCase();
  return isStoreIssueIssuedTo(upper) ? upper : 'KITCHEN';
}

export function assertExpenseAccountLocked(accountCode: string): void {
  if (accountCode !== STORE_ISSUE_EXPENSE_ACCOUNT) {
    throw new Error(
      `Store issue must post to ${STORE_ISSUE_EXPENSE_ACCOUNT}; got ${accountCode}`,
    );
  }
  if ((STORE_ISSUE_FORBIDDEN_ACCOUNTS as readonly string[]).includes(accountCode)) {
    throw new Error(`Store issue cannot post to ${accountCode}`);
  }
}

export function isSellableIssueStoreType(storeType: string | null | undefined): boolean {
  const type = String(storeType || '').toUpperCase();
  if (!type) return true;
  return !QUARANTINE_OR_TRANSIT.has(type);
}

/** Issued qty is what posts. Requested is the indent; shortage is informational. */
export function issueShortage(requestedQty: number, issuedQty: number): number {
  if (!(requestedQty > 0) || !(issuedQty >= 0)) return 0;
  return Math.max(0, requestedQty - issuedQty);
}

export function issuedExceedsRequested(requestedQty: number, issuedQty: number): boolean {
  return issuedQty > requestedQty + 1e-9;
}

export function issuedExceedsAvailable(issuedQty: number, availableQty: number): boolean {
  return issuedQty > availableQty + 0.001;
}

export function sumIssuableQty(lots: Array<{ remainingQuantity?: number }>): number {
  return lots.reduce((sum, lot) => sum + Math.max(0, Number(lot.remainingQuantity) || 0), 0);
}

/**
 * Same consume scope as lotService.consumeLot: store lots only when
 * multistore is on and a store is selected; otherwise global FEFO lots.
 */
export function consumeStoreIdForIssue(
  multistore: boolean,
  storeLocationId: string | null | undefined,
): string | null {
  if (!multistore) return null;
  return storeLocationId || null;
}

export function defaultIssueStoreId(
  stores: Array<{
    id: string;
    storeType?: string | null;
    isDefaultReceiving?: boolean;
    isActive?: boolean;
    code?: string | null;
  }>,
): string | null {
  const active = stores.filter(
    (s) => s.isActive !== false && isSellableIssueStoreType(s.storeType),
  );
  const mains = active.filter(
    (s) =>
      String(s.storeType || '').toUpperCase() === 'MAIN' ||
      String(s.code || '').toUpperCase() === 'MAIN',
  );
  const receivingMain = mains.find((s) => s.isDefaultReceiving);
  return receivingMain?.id || mains[0]?.id || active[0]?.id || null;
}

export function storeIssueEntryQty(qtyBase: number, conversionFactor?: number | null): number {
  const factor = Number(conversionFactor || 1) || 1;
  return qtyBase / factor;
}

export function formatQtyWithUom(qty: number, uomName?: string | null): string {
  const n = Number(qty || 0).toLocaleString(undefined, { maximumFractionDigits: 4 });
  const uom = String(uomName || '').trim();
  return uom ? `${n} ${uom}` : n;
}

export function formatInsufficientStoreIssue(input: {
  productName: string;
  requested: number;
  available: number;
  storeLabel: string;
}): string {
  const requested = Number(input.requested).toFixed(4);
  const available = Number(input.available).toFixed(4);
  return (
    `Insufficient issuable stock for ${input.productName} at ${input.storeLabel}: ` +
    `requested ${requested}, available ${available}. ` +
    `Only FEFO-sellable lots at this store can be issued — catalog on-hand, reserved, expired, and other stores do not count.`
  );
}

export type StoreIssueLinePlanInput = {
  productId: string;
  requestedQtyBase: number;
  issuedQtyBase: number;
  sortOrder?: number;
  notes?: string | null;
  uomId?: string | null;
  uomName?: string | null;
  conversionFactor?: number;
};

export type StoreIssueLinePlan = {
  productId: string;
  requestedQtyBase: number;
  issuedQtyBase: number;
  sortOrder: number;
  notes: string | null;
  uomId: string | null;
  uomName: string | null;
  conversionFactor: number;
};

/**
 * Draft/post line rules: unique stockable product, requested > 0, issued >= 0.
 * Post additionally requires issued > 0 on every remaining line.
 */
export function normalizeStoreIssueLines(
  lines: StoreIssueLinePlanInput[],
  opts?: { requireIssued?: boolean },
): StoreIssueLinePlan[] {
  if (!lines?.length) {
    throw new Error('At least one issue line is required');
  }
  const seen = new Set<string>();
  return lines.map((line, i) => {
    if (!line.productId) throw new Error('Product is required');
    if (!(line.requestedQtyBase > 0)) {
      throw new Error('Requested quantity must be positive');
    }
    if (!(line.issuedQtyBase >= 0) || Number.isNaN(line.issuedQtyBase)) {
      throw new Error('Issued quantity cannot be negative');
    }
    if (opts?.requireIssued && !(line.issuedQtyBase > 0)) {
      throw new Error('Issued quantity must be positive to post');
    }
    if (seen.has(line.productId)) {
      throw new Error('Duplicate product on store issue');
    }
    seen.add(line.productId);
    const conversionFactor = Number(line.conversionFactor ?? 1);
    if (!(conversionFactor > 0) || !Number.isFinite(conversionFactor)) {
      throw new Error('Conversion factor must be positive');
    }
    return {
      productId: line.productId,
      requestedQtyBase: line.requestedQtyBase,
      issuedQtyBase: line.issuedQtyBase,
      sortOrder: line.sortOrder ?? i,
      notes: line.notes ?? null,
      uomId: line.uomId?.trim() || null,
      uomName: line.uomName?.trim() || null,
      conversionFactor,
    };
  });
}

export function storeIssueStepComplete(input: {
  step: 1 | 2 | 3 | 4;
  issuedTo?: string | null;
  lineCount: number;
  linesIssuedPositive: boolean;
}): boolean {
  if (input.step === 1) return isStoreIssueIssuedTo(input.issuedTo);
  if (input.step === 2) return input.lineCount > 0;
  if (input.step === 3) return input.lineCount > 0 && input.linesIssuedPositive;
  return input.lineCount > 0 && input.linesIssuedPositive && isStoreIssueIssuedTo(input.issuedTo);
}
