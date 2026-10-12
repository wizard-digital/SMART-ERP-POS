/**
 * Ownership & equity calculations. Share counts are the ownership source of truth.
 * General-ledger balances are never converted into ownership percent.
 */
import Decimal from 'decimal.js';

Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

export const SHARE_CAPITAL_CODE = '3400';
export const DIVIDENDS_PAYABLE_CODE = '2450';
export const SHAREHOLDER_LOAN_CODE = '2600';
export const RETAINED_EARNINGS_CODE = '3100';
export const OWNER_CAPITAL_CODE = '3200';
export const OWNER_DRAWINGS_CODE = '3300';
export const OPENING_BALANCE_EQUITY_CODE = '3050';
export const EQUITY_HEADER_CODE = '3000';
export const TRADE_AP_CODE = '2100';
export const GRIR_CODE = '2150';
export const UNDEPOSITED_FUNDS_CODE = '1015';

/** Posting source passed to AccountingCore / PostingGovernanceService. */
export const OWNERSHIP_POSTING_SOURCE = 'OWNERSHIP_EQUITY';

export const LEGAL_FORMS = ['SOLE_PROPRIETOR', 'COMPANY'] as const;
export type LegalForm = (typeof LEGAL_FORMS)[number];

const BLOCKED_CONSIDERATION_CODES = new Set([
  EQUITY_HEADER_CODE,
  OPENING_BALANCE_EQUITY_CODE,
  RETAINED_EARNINGS_CODE,
  OWNER_CAPITAL_CODE,
  OWNER_DRAWINGS_CODE,
  TRADE_AP_CODE,
  GRIR_CODE,
  SHARE_CAPITAL_CODE,
  DIVIDENDS_PAYABLE_CODE,
  SHAREHOLDER_LOAN_CODE,
  UNDEPOSITED_FUNDS_CODE,
]);

export interface ShareEvent {
  eventType: 'ISSUE' | 'TRANSFER' | 'CANCEL';
  shareClassId: string;
  fromShareholderId: string | null;
  toShareholderId: string | null;
  quantity: string;
  effectiveDate: string;
}

export interface HoldingQty {
  shareholderId: string;
  shareClassId: string;
  quantity: string;
}

export interface OwnershipSlice {
  shareholderId: string;
  shareClassId: string;
  shares: string;
  percent: string;
}

function qty(value: string | number | Decimal): Decimal {
  const d = value instanceof Decimal ? value : new Decimal(String(value));
  if (!d.isFinite() || d.lt(0)) {
    throw new Error('OWNERSHIP_QTY_INVALID');
  }
  return d.toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
}

export function assertPositiveQuantity(value: string | number): string {
  const d = new Decimal(String(value));
  if (!d.isFinite() || d.lte(0)) {
    throw new Error('OWNERSHIP_QTY_INVALID');
  }
  const whole = d.toDecimalPlaces(0, Decimal.ROUND_DOWN);
  if (!whole.eq(d)) {
    throw new Error('OWNERSHIP_QTY_INVALID');
  }
  return d.toFixed(4);
}

export function assertMoney(value: string | number): string {
  const d = new Decimal(String(value));
  if (!d.isFinite() || d.lt(0)) {
    throw new Error('OWNERSHIP_AMOUNT_INVALID');
  }
  return d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

export function assertConsiderationAccount(accountCode: string): void {
  if (BLOCKED_CONSIDERATION_CODES.has(accountCode) || !isLiquidityAccountCode(accountCode)) {
    throw new Error(`OWNERSHIP_ACCOUNT_BLOCKED:${accountCode}`);
  }
}

/** Cash, bank, card, and mobile-money books live in the 10xx range. 1015 is undeposited funds. */
export function isLiquidityAccountCode(accountCode: string): boolean {
  return accountCode.startsWith('10') && accountCode !== UNDEPOSITED_FUNDS_CODE;
}

export function moneyIsPositive(amount: string): boolean {
  return new Decimal(assertMoney(amount)).gt(0);
}

export type SoleProprietorRevertState = {
  shares: string;
  openLoans: number;
  openDividends: number;
};

export function soleProprietorRevertBlocked(state: SoleProprietorRevertState): boolean {
  return new Decimal(state.shares || 0).gt(0) || state.openLoans > 0 || state.openDividends > 0;
}

/** Names only the instruments that still block a return to sole proprietor. */
export function soleProprietorRevertReasons(state: SoleProprietorRevertState): string[] {
  const reasons: string[] = [];
  const shares = new Decimal(state.shares || 0);
  if (shares.gt(0)) {
    // Decimal.js has isInteger at runtime; ambient typings omit it — use trunc equality.
    const whole = shares.toDecimalPlaces(0, Decimal.ROUND_DOWN);
    const text = shares.eq(whole) ? shares.toFixed(0) : shares.toDecimalPlaces(4).toFixed(4);
    reasons.push(shares.eq(1) ? `${text} company share is still issued` : `${text} company shares are still issued`);
  }
  if (state.openLoans > 0) {
    reasons.push(
      state.openLoans === 1 ? '1 shareholder loan is still open' : `${state.openLoans} shareholder loans are still open`,
    );
  }
  if (state.openDividends > 0) {
    reasons.push(
      state.openDividends === 1
        ? '1 dividend is still proposed, approved, or unpaid'
        : `${state.openDividends} dividends are still proposed, approved, or unpaid`,
    );
  }
  return reasons;
}

export function soleProprietorRevertMessage(state: SoleProprietorRevertState): string {
  const reasons = soleProprietorRevertReasons(state);
  if (reasons.length === 0) return '';
  return `Clear the following before the legal form can return to sole proprietor: ${reasons.join('; ')}.`;
}

export function holdingsFromEvents(events: ShareEvent[], asOf: string, shareClassId?: string): HoldingQty[] {
  const map = new Map<string, Decimal>();
  // Stable order: date, then original array index (same-day issue before transfer).
  const ordered = events
    .map((e, index) => ({ e, index }))
    .filter(({ e }) => e.effectiveDate <= asOf && (!shareClassId || e.shareClassId === shareClassId))
    .sort((a, b) => {
      const byDate = a.e.effectiveDate.localeCompare(b.e.effectiveDate);
      return byDate !== 0 ? byDate : a.index - b.index;
    })
    .map(({ e }) => e);

  const add = (shareholderId: string | null, classId: string, delta: Decimal) => {
    if (!shareholderId) return;
    const key = `${shareholderId}|${classId}`;
    map.set(key, (map.get(key) ?? new Decimal(0)).plus(delta));
  };

  for (const event of ordered) {
    const q = qty(event.quantity);
    if (event.eventType === 'ISSUE') {
      add(event.toShareholderId, event.shareClassId, q);
    } else if (event.eventType === 'TRANSFER') {
      add(event.fromShareholderId, event.shareClassId, q.negated());
      add(event.toShareholderId, event.shareClassId, q);
    } else if (event.eventType === 'CANCEL') {
      add(event.fromShareholderId, event.shareClassId, q.negated());
    }
  }

  const rows: HoldingQty[] = [];
  for (const [key, quantity] of map) {
    if (quantity.lte(0)) continue;
    const [shareholderId, classId] = key.split('|');
    rows.push({ shareholderId, shareClassId: classId, quantity: quantity.toFixed(4) });
  }
  return rows.sort((a, b) => a.shareholderId.localeCompare(b.shareholderId));
}

export function ownershipFromHoldings(holdings: HoldingQty[], shareClassId?: string): OwnershipSlice[] {
  const scoped = shareClassId ? holdings.filter((h) => h.shareClassId === shareClassId) : holdings;
  const total = scoped.reduce((sum, h) => sum.plus(qty(h.quantity)), new Decimal(0));
  if (total.lte(0)) return [];
  return scoped.map((h) => {
    const shares = qty(h.quantity);
    const percent = shares.div(total).times(100).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
    return {
      shareholderId: h.shareholderId,
      shareClassId: h.shareClassId,
      shares: shares.toFixed(4),
      percent: percent.toFixed(4),
    };
  });
}

export function transferResult(
  holdings: HoldingQty[],
  shareClassId: string,
  fromShareholderId: string,
  toShareholderId: string,
  quantity: string,
): HoldingQty[] {
  if (fromShareholderId === toShareholderId) {
    throw new Error('OWNERSHIP_TRANSFER_SAME_HOLDER');
  }
  const q = qty(assertPositiveQuantity(quantity));
  const from = holdings.find((h) => h.shareholderId === fromShareholderId && h.shareClassId === shareClassId);
  const available = from ? qty(from.quantity) : new Decimal(0);
  if (available.lt(q)) {
    throw new Error('OWNERSHIP_INSUFFICIENT_SHARES');
  }
  const next = holdings.map((h) => ({ ...h }));
  const fromRow = next.find((h) => h.shareholderId === fromShareholderId && h.shareClassId === shareClassId);
  if (fromRow) {
    const left = qty(fromRow.quantity).minus(q);
    fromRow.quantity = left.toFixed(4);
  }
  let toRow = next.find((h) => h.shareholderId === toShareholderId && h.shareClassId === shareClassId);
  if (!toRow) {
    toRow = { shareholderId: toShareholderId, shareClassId, quantity: '0.0000' };
    next.push(toRow);
  }
  toRow.quantity = qty(toRow.quantity).plus(q).toFixed(4);
  return next.filter((h) => qty(h.quantity).gt(0));
}

export interface JournalLeg {
  accountCode: string;
  description: string;
  debitAmount: number;
  creditAmount: number;
}

function moneyNumber(value: string): number {
  return Number(new Decimal(value).toFixed(2));
}

export function shareIssueJournalLegs(cashAccountCode: string, amount: string): JournalLeg[] | null {
  const money = assertMoney(amount);
  if (new Decimal(money).lte(0)) return null;
  assertConsiderationAccount(cashAccountCode);
  const n = moneyNumber(money);
  return [
    { accountCode: cashAccountCode, description: 'Share issue consideration', debitAmount: n, creditAmount: 0 },
    { accountCode: SHARE_CAPITAL_CODE, description: 'Share capital issued', debitAmount: 0, creditAmount: n },
  ];
}

export function dividendDeclarationLegs(amount: string): JournalLeg[] {
  const n = moneyNumber(assertMoney(amount));
  if (n <= 0) throw new Error('OWNERSHIP_AMOUNT_INVALID');
  return [
    { accountCode: RETAINED_EARNINGS_CODE, description: 'Dividend declared', debitAmount: n, creditAmount: 0 },
    { accountCode: DIVIDENDS_PAYABLE_CODE, description: 'Dividend payable', debitAmount: 0, creditAmount: n },
  ];
}

export function dividendPaymentLegs(cashAccountCode: string, amount: string): JournalLeg[] {
  assertConsiderationAccount(cashAccountCode);
  const n = moneyNumber(assertMoney(amount));
  if (n <= 0) throw new Error('OWNERSHIP_AMOUNT_INVALID');
  return [
    { accountCode: DIVIDENDS_PAYABLE_CODE, description: 'Dividend payment', debitAmount: n, creditAmount: 0 },
    { accountCode: cashAccountCode, description: 'Dividend paid', debitAmount: 0, creditAmount: n },
  ];
}

export function loanDrawLegs(cashAccountCode: string, amount: string): JournalLeg[] {
  assertConsiderationAccount(cashAccountCode);
  const n = moneyNumber(assertMoney(amount));
  if (n <= 0) throw new Error('OWNERSHIP_AMOUNT_INVALID');
  return [
    { accountCode: cashAccountCode, description: 'Shareholder loan received', debitAmount: n, creditAmount: 0 },
    { accountCode: SHAREHOLDER_LOAN_CODE, description: 'Shareholder loan liability', debitAmount: 0, creditAmount: n },
  ];
}

export function loanRepayLegs(cashAccountCode: string, amount: string): JournalLeg[] {
  assertConsiderationAccount(cashAccountCode);
  const n = moneyNumber(assertMoney(amount));
  if (n <= 0) throw new Error('OWNERSHIP_AMOUNT_INVALID');
  return [
    { accountCode: SHAREHOLDER_LOAN_CODE, description: 'Shareholder loan repaid', debitAmount: n, creditAmount: 0 },
    { accountCode: cashAccountCode, description: 'Shareholder loan repayment', debitAmount: 0, creditAmount: n },
  ];
}

export function allocateDividend(
  amount: string,
  slices: OwnershipSlice[],
): Array<OwnershipSlice & { amount: string }> {
  const total = new Decimal(assertMoney(amount));
  if (slices.length === 0 || total.lte(0)) {
    throw new Error('OWNERSHIP_DIVIDEND_NO_HOLDERS');
  }
  const rows = slices.map((slice) => {
    const share = total.times(new Decimal(slice.percent).div(100)).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    return { ...slice, amount: share.toFixed(2) };
  });
  const assigned = rows.reduce((sum, row) => sum.plus(row.amount), new Decimal(0));
  const drift = total.minus(assigned);
  if (!drift.isZero()) {
    const last = rows[rows.length - 1];
    last.amount = new Decimal(last.amount).plus(drift).toFixed(2);
  }
  return rows;
}

/** Book retained earnings only. This is not a statutory distributable-profit test. */
export function assertWithinRetainedEarnings(amount: string, retainedEarningsCreditBalance: string): void {
  const n = new Decimal(assertMoney(amount));
  const available = new Decimal(assertMoney(retainedEarningsCreditBalance));
  if (n.gt(available)) {
    throw new Error('OWNERSHIP_DIVIDEND_EXCEEDS_RETAINED_EARNINGS');
  }
}
