import fs from 'fs';
import path from 'path';
import {
  allocateDividend,
  assertMoney,
  assertPositiveQuantity,
  dividendDeclarationLegs,
  dividendPaymentLegs,
  holdingsFromEvents,
  loanDrawLegs,
  ownershipFromHoldings,
  shareIssueJournalLegs,
  soleProprietorRevertBlocked,
  soleProprietorRevertMessage,
  soleProprietorRevertReasons,
  transferResult,
  SHARE_CAPITAL_CODE,
  SHAREHOLDER_LOAN_CODE,
  OWNER_CAPITAL_CODE,
} from '../../../../shared/domain/ownershipEquity.js';

const classId = 'ordinary';

describe('ownership equity domain', () => {
  const events = [
    { eventType: 'ISSUE' as const, shareClassId: classId, fromShareholderId: null, toShareholderId: 'A', quantity: '5000', effectiveDate: '2026-01-02' },
    { eventType: 'ISSUE' as const, shareClassId: classId, fromShareholderId: null, toShareholderId: 'B', quantity: '3000', effectiveDate: '2026-01-03' },
    { eventType: 'ISSUE' as const, shareClassId: classId, fromShareholderId: null, toShareholderId: 'C', quantity: '2000', effectiveDate: '2026-01-04' },
  ];

  it('issues 5000, 3000, and 2000 as 50/30/20', () => {
    const holdings = holdingsFromEvents(events, '2026-12-31');
    const slices = ownershipFromHoldings(holdings);
    expect(slices.map((row) => [row.shareholderId, row.percent])).toEqual([
      ['A', '50.0000'],
      ['B', '30.0000'],
      ['C', '20.0000'],
    ]);
    expect(holdings.reduce((sum, row) => sum + Number(row.quantity), 0)).toBe(10000);
  });

  it('answers who held shares before a later transfer', () => {
    const withTransfer = [
      ...events,
      { eventType: 'TRANSFER' as const, shareClassId: classId, fromShareholderId: 'A', toShareholderId: 'B', quantity: '1000', effectiveDate: '2026-06-01' },
    ];
    const before = ownershipFromHoldings(holdingsFromEvents(withTransfer, '2026-05-31'));
    const after = transferResult(holdingsFromEvents(withTransfer, '2026-05-31'), classId, 'A', 'B', '1000');
    expect(before.find((row) => row.shareholderId === 'A')?.shares).toBe('5000.0000');
    expect(after.find((row) => row.shareholderId === 'A')?.quantity).toBe('4000.0000');
    expect(after.find((row) => row.shareholderId === 'B')?.quantity).toBe('4000.0000');
    expect(after.reduce((sum, row) => sum + Number(row.quantity), 0)).toBe(10000);
  });

  it('posts one balanced share-issue journal and no journal for a zero consideration', () => {
    const legs = shareIssueJournalLegs('1010', '50000000');
    expect(legs?.[0]).toMatchObject({ accountCode: '1010', debitAmount: 50000000, creditAmount: 0 });
    expect(legs?.[1]).toMatchObject({ accountCode: SHARE_CAPITAL_CODE, debitAmount: 0, creditAmount: 50000000 });
    expect(shareIssueJournalLegs('1010', '0')).toBeNull();
    expect(() => shareIssueJournalLegs('4000', '10')).toThrow('OWNERSHIP_ACCOUNT_BLOCKED');
    expect(() => shareIssueJournalLegs('1015', '10')).toThrow('OWNERSHIP_ACCOUNT_BLOCKED');
    expect(soleProprietorRevertBlocked({ shares: '1.0000', openLoans: 0, openDividends: 0 })).toBe(true);
    expect(soleProprietorRevertBlocked({ shares: '0', openLoans: 0, openDividends: 0 })).toBe(false);
    expect(soleProprietorRevertReasons({ shares: '500.0000', openLoans: 1, openDividends: 0 })).toEqual([
      '500 company shares are still issued',
      '1 shareholder loan is still open',
    ]);
    expect(soleProprietorRevertMessage({ shares: '0', openLoans: 0, openDividends: 2 })).toBe(
      'Clear the following before the legal form can return to sole proprietor: 2 dividends are still proposed, approved, or unpaid.',
    );
    expect(soleProprietorRevertMessage({ shares: '0', openLoans: 0, openDividends: 0 })).toBe('');
    expect(assertPositiveQuantity('2')).toBe('2.0000');
    expect(() => assertPositiveQuantity('1.5')).toThrow('OWNERSHIP_QTY_INVALID');
    expect(() => assertPositiveQuantity('-1')).toThrow('OWNERSHIP_QTY_INVALID');
    expect(assertMoney('1000000.99')).toBe('1000000.99');
    expect(assertMoney('0.01')).toBe('0.01');
    expect(() => assertMoney('-0.01')).toThrow('OWNERSHIP_AMOUNT_INVALID');
  });

  it('a cancellation event removes shares without renaming owner capital', () => {
    const afterCancel = holdingsFromEvents(
      [
        ...events,
        { eventType: 'CANCEL', shareClassId: classId, fromShareholderId: 'C', toShareholderId: null, quantity: '2000', effectiveDate: '2026-02-01' },
      ],
      '2026-12-31',
    );
    expect(afterCancel.find((row) => row.shareholderId === 'C')).toBeUndefined();
    expect(OWNER_CAPITAL_CODE).toBe('3200');
  });

  it('keeps a private transfer off the ledger and a loan off owner capital', () => {
    const loan = loanDrawLegs('1010', '20000000');
    expect(loan.map((line) => line.accountCode)).toEqual(['1010', SHAREHOLDER_LOAN_CODE]);
    expect(loan.some((line) => line.accountCode === OWNER_CAPITAL_CODE)).toBe(false);
  });

  it('separates dividend proposal amounts from declaration and payment legs', () => {
    const declared = dividendDeclarationLegs('1000');
    const paid = dividendPaymentLegs('1010', '1000');
    expect(declared[0].accountCode).toBe('3100');
    expect(declared[1].accountCode).toBe('2450');
    expect(paid[0].debitAmount).toBe(1000);
    expect(paid[1].accountCode).toBe('1010');
    const allocated = allocateDividend('100', ownershipFromHoldings(holdingsFromEvents(events, '2026-12-31')));
    expect(allocated.reduce((sum, row) => sum + Number(row.amount), 0)).toBe(100);
  });
});

describe('ownership migration does not retarget existing equity', () => {
  const sql = fs.readFileSync(path.resolve(process.cwd(), '../shared/sql/636_ownership_equity.sql'), 'utf8');
  const service = fs.readFileSync(path.resolve(process.cwd(), 'src/modules/ownership/ownershipService.ts'), 'utf8');

  it('keeps 3200, 3300, 3100, 3050, and 3000 and does not write the ledger itself', () => {
    expect(sql).toContain('SOLE_PROPRIETOR');
    expect(sql).toContain("'3400', 'Share Capital'");
    expect(sql).toContain("'2450', 'Dividends Payable'");
    expect(sql).toContain("'2600', 'Shareholder Loans'");
    expect(sql).not.toContain("SET \"AccountName\" = 'Share Capital'");
    expect(sql).not.toContain('CREATE TRIGGER trg_cost_layer');
    expect(sql).not.toContain('CREATE OR REPLACE FUNCTION fn_post_cost_layer');
    expect(sql).toContain("'ownership.read'");
    expect(sql).not.toContain("name = 'Cashier'");
    expect(service).not.toContain('INSERT INTO ledger_entries');
    expect(service).not.toContain('INSERT INTO ledger_transactions');
    expect(service).toContain('AccountingCore.createJournalEntry');
    expect(service).toContain('journalId: null');
  });
});
