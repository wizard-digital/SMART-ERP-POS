/**
 * Store issue to expense — pure plan (SAP GI 201).
 */

import { describe, expect, it } from '@jest/globals';
import {
  STORE_ISSUE_EXPENSE_ACCOUNT,
  STORE_ISSUE_FORBIDDEN_ACCOUNTS,
  STORE_ISSUE_MOVEMENT_TYPE,
  STORE_ISSUE_REVERSAL_MOVEMENT_TYPE,
  STORE_ISSUE_REVERSE_PERMISSION,
  STORE_ISSUE_REVERSE_RATE_WATCH,
  assertExpenseAccountLocked,
  assertStoreIssueReverseGovernance,
  assertStoreIssueReverseMovements,
  escapeIlikePattern,
  filterStoreIssueAuditRows,
  normalizeInclusiveDateRange,
  canCancelStoreIssue,
  canEditStoreIssue,
  canPostStoreIssue,
  canReverseStoreIssue,
  parseStoreIssueAuditMovementFilter,
  storeIssueAuditMovementLabel,
  summarizeStoreIssueAudit,
  consumeStoreIdForIssue,
  defaultIssueStoreId,
  formatInsufficientStoreIssue,
  formatQtyWithUom,
  issuedExceedsAvailable,
  issuedExceedsRequested,
  issueShortage,
  isSellableIssueStoreType,
  normalizeIssuedTo,
  normalizeStoreIssueLines,
  storeIssueEntryQty,
  storeIssueStepComplete,
  sumIssuableQty,
} from '../../../../shared/store-issue/issuePlan.js';

describe('store issue plan (pure)', () => {
  it('status gates draft only', () => {
    expect(canEditStoreIssue('DRAFT')).toBe(true);
    expect(canPostStoreIssue('DRAFT')).toBe(true);
    expect(canCancelStoreIssue('DRAFT')).toBe(true);
    expect(canPostStoreIssue('POSTED')).toBe(false);
    expect(canCancelStoreIssue('POSTED')).toBe(false);
    expect(canEditStoreIssue('CANCELLED')).toBe(false);
    expect(canReverseStoreIssue('POSTED')).toBe(true);
    expect(canReverseStoreIssue('DRAFT')).toBe(false);
    expect(canReverseStoreIssue('REVERSED')).toBe(false);
    expect(canEditStoreIssue('POSTED')).toBe(false);
  });

  it('locks expense to 5150 and forbids sale COGS / loss accounts', () => {
    expect(STORE_ISSUE_EXPENSE_ACCOUNT).toBe('5150');
    expect(STORE_ISSUE_MOVEMENT_TYPE).toBe('GOODS_ISSUE');
    expect(STORE_ISSUE_REVERSAL_MOVEMENT_TYPE).toBe('GOODS_ISSUE_REVERSAL');
    expect(STORE_ISSUE_FORBIDDEN_ACCOUNTS).toEqual(
      expect.arrayContaining(['5000', '5110', '5120', '5130', '5140']),
    );
    expect(() => assertExpenseAccountLocked('5150')).not.toThrow();
    expect(() => assertExpenseAccountLocked('5000')).toThrow(/5150/);
    expect(() => assertExpenseAccountLocked('5110')).toThrow();
  });

  it('normalizes lines and refuses duplicates / non-positive request', () => {
    const lines = normalizeStoreIssueLines([
      { productId: 'a', requestedQtyBase: 10, issuedQtyBase: 8 },
      { productId: 'b', requestedQtyBase: 1, issuedQtyBase: 1 },
    ]);
    expect(lines).toHaveLength(2);
    expect(issueShortage(10, 8)).toBe(2);
    expect(issuedExceedsRequested(10, 12)).toBe(true);

    expect(() =>
      normalizeStoreIssueLines([{ productId: 'a', requestedQtyBase: 1, issuedQtyBase: 0 }], {
        requireIssued: true,
      }),
    ).toThrow(/Issued quantity must be positive/);

    expect(() =>
      normalizeStoreIssueLines([
        { productId: 'a', requestedQtyBase: 1, issuedQtyBase: 1 },
        { productId: 'a', requestedQtyBase: 2, issuedQtyBase: 2 },
      ]),
    ).toThrow(/Duplicate/);

    const withUom = normalizeStoreIssueLines([
      {
        productId: 'a',
        requestedQtyBase: 60,
        issuedQtyBase: 60,
        uomId: '11111111-1111-1111-1111-111111111111',
        uomName: 'BOX',
        conversionFactor: 12,
      },
    ]);
    expect(withUom[0]).toMatchObject({ uomName: 'BOX', conversionFactor: 12 });
    expect(storeIssueEntryQty(60, 12)).toBe(5);
    expect(formatQtyWithUom(5, 'BOX')).toBe('5 BOX');
    expect(formatQtyWithUom(5, null)).toBe('5');
  });

  it('sellable stores only — not quarantine or transit', () => {
    expect(isSellableIssueStoreType('MAIN')).toBe(true);
    expect(isSellableIssueStoreType('SELLING')).toBe(true);
    expect(isSellableIssueStoreType('DAMAGE')).toBe(false);
    expect(isSellableIssueStoreType('EXPIRED')).toBe(false);
    expect(isSellableIssueStoreType('TRANSIT')).toBe(false);
    expect(normalizeIssuedTo('bar')).toBe('BAR');
  });

  it('defaults issuing store to MAIN warehouse, not the selling floor', () => {
    expect(
      defaultIssueStoreId([
        { id: 'sell', storeType: 'SELLING', isDefaultReceiving: true },
        { id: 'main', storeType: 'MAIN' },
        { id: 'recv', storeType: 'MAIN', isDefaultReceiving: true },
        { id: 'dmg', storeType: 'DAMAGE' },
      ]),
    ).toBe('recv');
    expect(
      defaultIssueStoreId([
        { id: 'sell', storeType: 'SELLING', isDefaultReceiving: true },
        { id: 'main', storeType: 'MAIN' },
      ]),
    ).toBe('main');
    expect(defaultIssueStoreId([{ id: 'shop', storeType: 'SELLING' }])).toBe('shop');
    expect(defaultIssueStoreId([{ id: 'dmg', storeType: 'DAMAGE' }])).toBeNull();
  });

  it('issuable qty is FEFO remaining at the consume store, not catalog on-hand', () => {
    expect(sumIssuableQty([])).toBe(0);
    expect(sumIssuableQty([{ remainingQuantity: 2 }, { remainingQuantity: 3.5 }])).toBe(5.5);
    expect(issuedExceedsAvailable(5, 0)).toBe(true);
    expect(issuedExceedsAvailable(5, 5)).toBe(false);
    expect(consumeStoreIdForIssue(false, 'store-1')).toBeNull();
    expect(consumeStoreIdForIssue(true, 'store-1')).toBe('store-1');
    expect(consumeStoreIdForIssue(true, null)).toBeNull();
    expect(
      formatInsufficientStoreIssue({
        productName: 'Abchlor eye droped',
        requested: 5,
        available: 0,
        storeLabel: 'MAIN',
      }),
    ).toMatch(/Abchlor eye droped at MAIN: requested 5\.0000, available 0\.0000/);
  });

  it('one-screen steps complete in order', () => {
    expect(storeIssueStepComplete({ step: 1, issuedTo: 'KITCHEN', lineCount: 0, linesIssuedPositive: false })).toBe(
      true,
    );
    expect(storeIssueStepComplete({ step: 2, issuedTo: 'KITCHEN', lineCount: 0, linesIssuedPositive: false })).toBe(
      false,
    );
    expect(storeIssueStepComplete({ step: 2, issuedTo: 'KITCHEN', lineCount: 1, linesIssuedPositive: false })).toBe(
      true,
    );
    expect(storeIssueStepComplete({ step: 3, issuedTo: 'KITCHEN', lineCount: 1, linesIssuedPositive: false })).toBe(
      false,
    );
    expect(storeIssueStepComplete({ step: 4, issuedTo: 'KITCHEN', lineCount: 1, linesIssuedPositive: true })).toBe(
      true,
    );
  });

  it('reverse governance: reason + four-eyes, not the original poster', () => {
    expect(STORE_ISSUE_REVERSE_PERMISSION).toBe('kitchen.production.reverse');
    expect(() =>
      assertStoreIssueReverseGovernance({
        reason: '  ',
        postedBy: 'a',
        reversingUserId: 'b',
        canOverrideFourEyes: false,
      }),
    ).toThrow(/Reversal reason is required/);
    expect(() =>
      assertStoreIssueReverseGovernance({
        reason: 'Entered wrong qty',
        postedBy: 'a',
        reversingUserId: 'a',
        canOverrideFourEyes: false,
      }),
    ).toThrow(/second authorized user/);
    expect(
      assertStoreIssueReverseGovernance({
        reason: 'Entered wrong qty',
        postedBy: 'a',
        reversingUserId: 'b',
        canOverrideFourEyes: false,
      }),
    ).toBe('Entered wrong qty');
    expect(
      assertStoreIssueReverseGovernance({
        reason: 'Owner correction',
        postedBy: 'a',
        reversingUserId: 'a',
        canOverrideFourEyes: true,
      }),
    ).toBe('Owner correction');
  });

  it('audit movement list: issue vs reverse and reverse-rate KPI', () => {
    expect(parseStoreIssueAuditMovementFilter('201')).toBe('GOODS_ISSUE');
    expect(parseStoreIssueAuditMovementFilter('REVERSE')).toBe('GOODS_ISSUE_REVERSAL');
    expect(storeIssueAuditMovementLabel('GOODS_ISSUE')).toBe('Issue');
    expect(storeIssueAuditMovementLabel('GOODS_ISSUE_REVERSAL')).toBe('Reverse');
    const totals = summarizeStoreIssueAudit([
      { movementType: 'GOODS_ISSUE', amount: 100, quantity: 10 },
      { movementType: 'GOODS_ISSUE', amount: 50, quantity: 5 },
      { movementType: 'GOODS_ISSUE_REVERSAL', amount: 50, quantity: 5 },
    ]);
    expect(totals.issuedAmount).toBe(150);
    expect(totals.reversedAmount).toBe(50);
    expect(totals.netAmount).toBe(100);
    expect(totals.reverseRate).toBeCloseTo(1 / 3);
    expect(totals.reverseRate).toBeGreaterThan(STORE_ISSUE_REVERSE_RATE_WATCH);
    expect(totals.issueLines).toBe(2);
    expect(totals.reverseLines).toBe(1);
    const mixed = [
      { movementType: 'GOODS_ISSUE', amount: 100, quantity: 10 },
      { movementType: 'GOODS_ISSUE_REVERSAL', amount: 40, quantity: 4 },
    ];
    expect(filterStoreIssueAuditRows(mixed, 'GOODS_ISSUE_REVERSAL')).toHaveLength(1);
    expect(summarizeStoreIssueAudit(mixed).reverseRate).toBeCloseTo(0.4);
    expect(normalizeInclusiveDateRange('2026-10-31', '2026-10-01')).toEqual({
      startDate: '2026-10-01',
      endDate: '2026-10-31',
    });
    expect(escapeIlikePattern('100%_off')).toBe('100\\%\\_off');
  });

  it('refuses reverse when original consume movements are missing or short', () => {
    expect(() => assertStoreIssueReverseMovements(5, 0)).toThrow(/movements were not found/);
    expect(() => assertStoreIssueReverseMovements(5, 4)).toThrow(/does not match/);
    expect(() => assertStoreIssueReverseMovements(5, 5)).not.toThrow();
  });
});
