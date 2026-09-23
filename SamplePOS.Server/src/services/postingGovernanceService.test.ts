/**
 * PostingGovernanceService — Unit Tests
 *
 * Covers all 7 rules and the happy-path scenarios.
 * All tests are pure (no DB interaction) — governance validate() is a sync function.
 */

import {
    PostingGovernanceService,
    PostingGovernanceError,
    type GovernanceAccount,
    type GovernanceJournalLine,
    type GovernanceJournalRequest,
    type PostingSource,
} from './postingGovernanceService.js';

// =============================================================================
// TEST FIXTURES
// =============================================================================

const makeAccount = (overrides: Partial<GovernanceAccount> = {}): GovernanceAccount => ({
    id: 'test-id',
    accountCode: '9999',
    accountName: 'Test Account',
    accountType: 'ASSET',
    normalBalance: 'DEBIT',
    isPostingAccount: true,
    isActive: true,
    allowManualPosting: true,
    allowedSources: [],
    systemAccountTag: null,
    ...overrides,
});

const cashAccount = makeAccount({
    accountCode: '1010',
    accountName: 'Cash',
    accountType: 'ASSET',
    normalBalance: 'DEBIT',
    allowManualPosting: false,
    allowedSources: ['PAYMENT_DEPOSIT', 'SYSTEM_CORRECTION'],
    systemAccountTag: 'CASH',
});

const arAccount = makeAccount({
    accountCode: '1200',
    accountName: 'Accounts Receivable',
    accountType: 'ASSET',
    normalBalance: 'DEBIT',
    allowManualPosting: false,
    allowedSources: ['SALES_INVOICE', 'PAYMENT_RECEIPT', 'SYSTEM_CORRECTION'],
    systemAccountTag: 'ACCOUNTS_RECEIVABLE',
});

const undepositedFundsAccount = makeAccount({
    accountCode: '1015',
    accountName: 'Undeposited Funds',
    accountType: 'ASSET',
    normalBalance: 'DEBIT',
    allowManualPosting: false,
    allowedSources: ['PAYMENT_RECEIPT', 'PAYMENT_DEPOSIT', 'SYSTEM_CORRECTION'],
    systemAccountTag: 'UNDEPOSITED_FUNDS',
});

const cogsAccount = makeAccount({
    accountCode: '5000',
    accountName: 'Cost of Goods Sold',
    accountType: 'EXPENSE',
    normalBalance: 'DEBIT',
    allowManualPosting: false,
    allowedSources: ['INVENTORY_MOVE', 'SALES_INVOICE', 'SYSTEM_CORRECTION'],
    systemAccountTag: 'COGS',
});

// Post-migration-013: PURCHASE_BILL and SALES_INVOICE are removed from 1300's
// AllowedSources. The INVENTORY_MOVE engine is the single source of truth.
const inventoryAccount = makeAccount({
    accountCode: '1300',
    accountName: 'Inventory',
    accountType: 'ASSET',
    normalBalance: 'DEBIT',
    allowManualPosting: false,
    allowedSources: ['INVENTORY_MOVE', 'SYSTEM_CORRECTION', 'OPENING_BALANCE_WIZARD'],
    systemAccountTag: 'INVENTORY',
});

const obeAccount = makeAccount({
    accountCode: '3050',
    accountName: 'Opening Balance Equity',
    accountType: 'EQUITY',
    normalBalance: 'CREDIT',
    allowManualPosting: false,
    allowedSources: ['OPENING_BALANCE_WIZARD', 'SYSTEM_CORRECTION'],
    systemAccountTag: 'OPENING_BALANCE_EQUITY',
});

const revenueAccount = makeAccount({
    accountCode: '4000',
    accountName: 'Sales Revenue',
    accountType: 'REVENUE',
    normalBalance: 'CREDIT',
    allowManualPosting: true,
    allowedSources: [],
    systemAccountTag: null,
});

const makeRequest = (
    source: PostingSource,
    lines: GovernanceJournalLine[],
    accounts: GovernanceAccount[],
    idempotencyKey?: string,
): GovernanceJournalRequest => ({ source, lines, accounts, idempotencyKey });

// =============================================================================
// TESTS
// =============================================================================

describe('PostingGovernanceService', () => {
    // --------------------------------------------------------------------------
    // HAPPY PATH
    // --------------------------------------------------------------------------
    describe('Happy path — no violations', () => {
        it('allows a SALES_INVOICE to DR AR / CR Revenue', () => {
            const req = makeRequest(
                'SALES_INVOICE',
                [
                    { accountCode: '1200', debitAmount: 100, creditAmount: 0 },
                    { accountCode: '4000', debitAmount: 0, creditAmount: 100 },
                ],
                [arAccount, revenueAccount]
            );
            expect(() => PostingGovernanceService.validate(req)).not.toThrow();
        });

        it('allows a PAYMENT_RECEIPT to DR Undeposited Funds / CR AR', () => {
            const req = makeRequest(
                'PAYMENT_RECEIPT',
                [
                    { accountCode: '1015', debitAmount: 100, creditAmount: 0 },
                    { accountCode: '1200', debitAmount: 0, creditAmount: 100 },
                ],
                [undepositedFundsAccount, arAccount]
            );
            expect(() => PostingGovernanceService.validate(req)).not.toThrow();
        });

        it('allows a PAYMENT_DEPOSIT to DR Cash / CR Undeposited Funds', () => {
            const req = makeRequest(
                'PAYMENT_DEPOSIT',
                [
                    { accountCode: '1010', debitAmount: 100, creditAmount: 0 },
                    { accountCode: '1015', debitAmount: 0, creditAmount: 100 },
                ],
                [cashAccount, undepositedFundsAccount]
            );
            expect(() => PostingGovernanceService.validate(req)).not.toThrow();
        });

        it('allows BANK_MANUAL deposit to DR bank GL / CR revenue (not MANUAL_JOURNAL)', () => {
            const req = makeRequest(
                'BANK_MANUAL',
                [
                    { accountCode: '1030', debitAmount: 275_000.5, creditAmount: 0 },
                    { accountCode: '4000', debitAmount: 0, creditAmount: 275_000.5 },
                ],
                [
                    makeAccount({
                        accountCode: '1030',
                        accountName: 'Bank',
                        accountType: 'ASSET',
                        normalBalance: 'DEBIT',
                        allowManualPosting: false,
                        allowedSources: ['SYSTEM_CORRECTION'],
                        systemAccountTag: 'BANK',
                    }),
                    revenueAccount,
                ],
            );
            expect(() => PostingGovernanceService.validate(req)).not.toThrow();
        });

        it('allows BANK_MANUAL deposit to DR bank / CR AR (Customer Payment category)', () => {
            const req = makeRequest(
                'BANK_MANUAL',
                [
                    { accountCode: '1030', debitAmount: 500, creditAmount: 0 },
                    { accountCode: '1200', debitAmount: 0, creditAmount: 500 },
                ],
                [
                    makeAccount({
                        accountCode: '1030',
                        accountName: 'Bank',
                        accountType: 'ASSET',
                        normalBalance: 'DEBIT',
                        allowManualPosting: false,
                        allowedSources: ['SYSTEM_CORRECTION'],
                        systemAccountTag: 'BANK',
                    }),
                    arAccount,
                ],
            );
            expect(() => PostingGovernanceService.validate(req)).not.toThrow();
        });

        it('blocks MANUAL_JOURNAL credit to AR (bank register must use BANK_MANUAL)', () => {
            const req = makeRequest(
                'MANUAL_JOURNAL',
                [
                    { accountCode: '1030', debitAmount: 500, creditAmount: 0 },
                    { accountCode: '1200', debitAmount: 0, creditAmount: 500 },
                ],
                [
                    makeAccount({
                        accountCode: '1030',
                        accountName: 'Bank',
                        accountType: 'ASSET',
                        normalBalance: 'DEBIT',
                        allowManualPosting: true,
                        allowedSources: ['MANUAL_JOURNAL'],
                    }),
                    arAccount,
                ],
            );
            expect(() => PostingGovernanceService.validate(req)).toThrow(/Manual credit entries are not permitted/);
        });

        it('allows INVENTORY_MOVE to DR COGS / CR Inventory', () => {
            const req = makeRequest(
                'INVENTORY_MOVE',
                [
                    { accountCode: '5000', debitAmount: 50, creditAmount: 0 },
                    { accountCode: '1300', debitAmount: 0, creditAmount: 50 },
                ],
                [cogsAccount, inventoryAccount]
            );
            expect(() => PostingGovernanceService.validate(req)).not.toThrow();
        });

        it('allows OPENING_BALANCE_WIZARD to DR Assets / CR OBE', () => {
            const assetAcct = makeAccount({ accountCode: '1300', ...inventoryAccount });
            const req = makeRequest(
                'OPENING_BALANCE_WIZARD',
                [
                    { accountCode: '1300', debitAmount: 200, creditAmount: 0 },
                    { accountCode: '3050', debitAmount: 0, creditAmount: 200 },
                ],
                [inventoryAccount, obeAccount]
            );
            expect(() => PostingGovernanceService.validate(req)).not.toThrow();
        });

        it('allows SYSTEM_CORRECTION to post anywhere', () => {
            const req = makeRequest(
                'SYSTEM_CORRECTION',
                [
                    { accountCode: '1010', debitAmount: 100, creditAmount: 0 },
                    { accountCode: '3050', debitAmount: 0, creditAmount: 100 },
                ],
                [cashAccount, obeAccount]
            );
            expect(() => PostingGovernanceService.validate(req)).not.toThrow();
        });
    });

    // --------------------------------------------------------------------------
    // RULE A: Normal balance violation for MANUAL_JOURNAL
    // --------------------------------------------------------------------------
    describe('Rule A — Normal balance violation', () => {
        it('blocks MANUAL_JOURNAL credit-only line to a DEBIT-normal system account', () => {
            const req = makeRequest(
                'MANUAL_JOURNAL',
                [
                    { accountCode: '1010', debitAmount: 0, creditAmount: 100 },
                    { accountCode: '4000', debitAmount: 100, creditAmount: 0 },
                ],
                [cashAccount, revenueAccount]
            );
            expect(() => PostingGovernanceService.validate(req)).toThrow(PostingGovernanceError);
            expect(() => PostingGovernanceService.validate(req)).toThrow('GOV_RULE_A_NORMAL_BALANCE');
        });

        it('does NOT block MANUAL_JOURNAL debit line to a DEBIT-normal system account (normal side)', () => {
            // Cash DEBIT is normal side — but Cash has allowManualPosting=false so rule C fires instead
            // Use a hypothetical account with systemTag but allowManualPosting=true
            const taggedAllowed = makeAccount({
                accountCode: '9001',
                normalBalance: 'DEBIT',
                systemAccountTag: 'CASH',
                allowManualPosting: true,
                allowedSources: [],
            });
            const creditNormal = makeAccount({ accountCode: '9002', normalBalance: 'CREDIT' });
            const req = makeRequest(
                'MANUAL_JOURNAL',
                [
                    { accountCode: '9001', debitAmount: 100, creditAmount: 0 },
                    { accountCode: '9002', debitAmount: 0, creditAmount: 100 },
                ],
                [taggedAllowed, creditNormal]
            );
            expect(() => PostingGovernanceService.validate(req)).not.toThrow();
        });
    });

    // --------------------------------------------------------------------------
    // RULE B: Source not in allowedSources
    // --------------------------------------------------------------------------
    describe('Rule B — Source not in allowedSources', () => {
        it('allows MANUAL_JOURNAL to DEBIT Cash (1010) — capital investment exception in Rule C', () => {
            // Rule C exempts CASH-tagged debit-only lines so owner capital injection works.
            // Rule B is skipped for MANUAL_JOURNAL (deferred to Rule C per code comment).
            const req = makeRequest(
                'MANUAL_JOURNAL',
                [
                    { accountCode: '1010', debitAmount: 100, creditAmount: 0 },
                    { accountCode: '4000', debitAmount: 0, creditAmount: 100 },
                ],
                [cashAccount, revenueAccount]
            );
            expect(() => PostingGovernanceService.validate(req)).not.toThrow();
        });

        it('blocks PURCHASE_BILL from posting to Cash (not in its allowedSources)', () => {
            const req = makeRequest(
                'PURCHASE_BILL',
                [
                    { accountCode: '1010', debitAmount: 0, creditAmount: 100 },
                    { accountCode: '5000', debitAmount: 100, creditAmount: 0 },
                ],
                [cashAccount, cogsAccount]
            );
            expect(() => PostingGovernanceService.validate(req)).toThrow(PostingGovernanceError);
        });

        it('blocks unpaid expense accrual via PURCHASE_BILL on 6900 (prod failure path)', () => {
            // Migr 544: 6900 allows TREASURY_PETTY_CASH / EXPENSE_PAYMENT / SYSTEM_CORRECTION only.
            // Pre-fix expense approval used PURCHASE_BILL → GOV_RULE_B_SOURCE_NOT_ALLOWED.
            const expenseAcct = makeAccount({
                accountCode: '6900',
                accountName: 'General Expense',
                accountType: 'EXPENSE',
                normalBalance: 'DEBIT',
                allowManualPosting: true,
                allowedSources: ['TREASURY_PETTY_CASH', 'EXPENSE_PAYMENT', 'SYSTEM_CORRECTION'],
            });
            const ap = makeAccount({
                accountCode: '2100',
                accountName: 'Accounts Payable',
                accountType: 'LIABILITY',
                normalBalance: 'CREDIT',
                allowManualPosting: false,
                allowedSources: [
                    'PURCHASE_BILL',
                    'SUPPLIER_PAYMENT',
                    'EXPENSE_PAYMENT',
                    'SYSTEM_CORRECTION',
                ],
                systemAccountTag: 'AP',
            });
            const bad = makeRequest(
                'PURCHASE_BILL',
                [
                    { accountCode: '6900', debitAmount: 102_000, creditAmount: 0 },
                    { accountCode: '2100', debitAmount: 0, creditAmount: 102_000 },
                ],
                [expenseAcct, ap],
            );
            expect(() => PostingGovernanceService.validate(bad)).toThrow(/GOV_RULE_B_SOURCE_NOT_ALLOWED/);

            const good = makeRequest(
                'EXPENSE_PAYMENT',
                [
                    { accountCode: '6900', debitAmount: 102_000, creditAmount: 0 },
                    { accountCode: '2100', debitAmount: 0, creditAmount: 102_000 },
                ],
                [expenseAcct, ap],
            );
            expect(() => PostingGovernanceService.validate(good)).not.toThrow();
        });
    });

    // --------------------------------------------------------------------------
    // RULE C: allowManualPosting = false blocks MANUAL_JOURNAL
    // --------------------------------------------------------------------------
    describe('Rule C — allowManualPosting enforcement', () => {
        it('blocks MANUAL_JOURNAL to an account with allowManualPosting=false', () => {
            const req = makeRequest(
                'MANUAL_JOURNAL',
                [
                    { accountCode: '5000', debitAmount: 100, creditAmount: 0 },
                    { accountCode: '4000', debitAmount: 0, creditAmount: 100 },
                ],
                [cogsAccount, revenueAccount]
            );
            expect(() => PostingGovernanceService.validate(req)).toThrow(PostingGovernanceError);
            expect(() => PostingGovernanceService.validate(req)).toThrow('GOV_RULE_C_NO_MANUAL_POSTING');
        });

        it('allows MANUAL_JOURNAL to DEBIT cash (capital investment: Dr Cash / Cr Equity)', () => {
            const equityAccount = makeAccount({
                accountCode: '3200',
                accountName: 'Owner Capital',
                accountType: 'EQUITY',
                normalBalance: 'CREDIT',
                allowManualPosting: true,
                allowedSources: [],
                systemAccountTag: null,
            });
            const req = makeRequest(
                'MANUAL_JOURNAL',
                [
                    { accountCode: '1010', debitAmount: 1000000, creditAmount: 0 },
                    { accountCode: '3200', debitAmount: 0, creditAmount: 1000000 },
                ],
                [cashAccount, equityAccount]
            );
            expect(() => PostingGovernanceService.validate(req)).not.toThrow();
        });

        it('still blocks MANUAL_JOURNAL to CREDIT cash (Rule D handles cash-out)', () => {
            const equityAccount = makeAccount({
                accountCode: '3200',
                accountName: 'Owner Drawings',
                accountType: 'EQUITY',
                normalBalance: 'CREDIT',
                allowManualPosting: true,
                allowedSources: [],
                systemAccountTag: null,
            });
            const req = makeRequest(
                'MANUAL_JOURNAL',
                [
                    { accountCode: '3200', debitAmount: 500000, creditAmount: 0 },
                    { accountCode: '1010', debitAmount: 0, creditAmount: 500000 },
                ],
                [equityAccount, cashAccount]
            );
            // Rule A blocks credit-only line on debit-normal system account first
            expect(() => PostingGovernanceService.validate(req)).toThrow(PostingGovernanceError);
        });

        it('allows MANUAL_JOURNAL to accounts where allowManualPosting=true', () => {
            const customAccount = makeAccount({
                accountCode: '6000',
                accountName: 'Admin Expense',
                accountType: 'EXPENSE',
                normalBalance: 'DEBIT',
                allowManualPosting: true,
                allowedSources: [],
                systemAccountTag: null,
            });
            const req = makeRequest(
                'MANUAL_JOURNAL',
                [
                    { accountCode: '6000', debitAmount: 100, creditAmount: 0 },
                    { accountCode: '4000', debitAmount: 0, creditAmount: 100 },
                ],
                [customAccount, revenueAccount]
            );
            expect(() => PostingGovernanceService.validate(req)).not.toThrow();
        });
    });

    // --------------------------------------------------------------------------
    // RULE D: Cash can only be credited by PAYMENT_DEPOSIT
    // --------------------------------------------------------------------------
    describe('Rule D — Cash credit restriction', () => {
        it('blocks SALES_INVOICE from crediting Cash', () => {
            const req = makeRequest(
                'SALES_INVOICE',
                [
                    { accountCode: '5000', debitAmount: 100, creditAmount: 0 },
                    { accountCode: '1010', debitAmount: 0, creditAmount: 100 },
                ],
                [cogsAccount, cashAccount]
            );
            expect(() => PostingGovernanceService.validate(req)).toThrow(PostingGovernanceError);
            expect(() => PostingGovernanceService.validate(req)).toThrow('GOV_RULE_D_CASH_CREDIT');
        });

        it('blocks INVENTORY_MOVE from crediting Cash', () => {
            const req = makeRequest(
                'INVENTORY_MOVE',
                [
                    { accountCode: '5000', debitAmount: 100, creditAmount: 0 },
                    { accountCode: '1010', debitAmount: 0, creditAmount: 100 },
                ],
                [cogsAccount, cashAccount]
            );
            expect(() => PostingGovernanceService.validate(req)).toThrow(PostingGovernanceError);
        });

        it('allows PAYMENT_DEPOSIT to credit Cash (this is the only valid path)', () => {
            const req = makeRequest(
                'PAYMENT_DEPOSIT',
                [
                    { accountCode: '1010', debitAmount: 100, creditAmount: 0 },
                    { accountCode: '1015', debitAmount: 0, creditAmount: 100 },
                ],
                [cashAccount, undepositedFundsAccount]
            );
            expect(() => PostingGovernanceService.validate(req)).not.toThrow();
        });

        it('allows WHT_REMITTANCE to credit Cash', () => {
            const whtPayable = makeAccount({
                accountCode: '2350',
                accountName: 'WHT Payable',
                accountType: 'LIABILITY',
                normalBalance: 'CREDIT',
                allowManualPosting: false,
                allowedSources: [],
                systemAccountTag: null,
            });
            const req = makeRequest(
                'WHT_REMITTANCE',
                [
                    { accountCode: '2350', debitAmount: 60_000, creditAmount: 0 },
                    { accountCode: '1010', debitAmount: 0, creditAmount: 60_000 },
                ],
                [whtPayable, cashAccount],
            );
            expect(() => PostingGovernanceService.validate(req)).not.toThrow();
        });

        it('allows VAT_REMITTANCE to credit Cash (ADR-005)', () => {
            const vatPayable = makeAccount({
                accountCode: '2300',
                accountName: 'Tax Payable',
                accountType: 'LIABILITY',
                normalBalance: 'CREDIT',
                allowManualPosting: false,
                allowedSources: [],
                systemAccountTag: null,
            });
            const req = makeRequest(
                'VAT_REMITTANCE',
                [
                    { accountCode: '2300', debitAmount: 100_000, creditAmount: 0 },
                    { accountCode: '1010', debitAmount: 0, creditAmount: 100_000 },
                ],
                [vatPayable, cashAccount],
            );
            expect(() => PostingGovernanceService.validate(req)).not.toThrow();
        });

        it('allows WHT_RECEIVABLE_RECOVERY to debit Cash', () => {
            const taxReceivable = makeAccount({
                accountCode: '1250',
                accountName: 'Tax Receivable',
                accountType: 'ASSET',
                normalBalance: 'DEBIT',
                allowManualPosting: false,
                allowedSources: [],
                systemAccountTag: null,
            });
            const cashWithWht = makeAccount({
                ...cashAccount,
                allowedSources: [
                    ...cashAccount.allowedSources,
                    'WHT_REMITTANCE',
                    'WHT_RECEIVABLE_RECOVERY',
                ],
            });
            const req = makeRequest(
                'WHT_RECEIVABLE_RECOVERY',
                [
                    { accountCode: '1010', debitAmount: 60_000, creditAmount: 0 },
                    { accountCode: '1250', debitAmount: 0, creditAmount: 60_000 },
                ],
                [cashWithWht, taxReceivable],
            );
            expect(() => PostingGovernanceService.validate(req)).not.toThrow();
        });
        it('allows TREASURY_TRANSFER to credit Cash', () => {
            const bank = makeAccount({
                accountCode: '1030',
                accountName: 'Bank',
                accountType: 'ASSET',
                normalBalance: 'DEBIT',
                allowManualPosting: false,
                allowedSources: ['TREASURY_TRANSFER', 'SYSTEM_CORRECTION'],
                systemAccountTag: 'BANK',
            });
            const cashWithTreasury = makeAccount({
                ...cashAccount,
                allowedSources: [
                    ...cashAccount.allowedSources,
                    'TREASURY_TRANSFER',
                    'TREASURY_DEPOSIT',
                    'TREASURY_PETTY_CASH',
                    'TREASURY_REVERSAL',
                ],
            });
            const req = makeRequest(
                'TREASURY_TRANSFER',
                [
                    { accountCode: '1030', debitAmount: 50_000, creditAmount: 0 },
                    { accountCode: '1010', debitAmount: 0, creditAmount: 50_000 },
                ],
                [bank, cashWithTreasury],
            );
            expect(() => PostingGovernanceService.validate(req)).not.toThrow();
        });

        it('allows TREASURY_DEPOSIT to credit Cash', () => {
            const cashWithTreasury = makeAccount({
                ...cashAccount,
                allowedSources: [...cashAccount.allowedSources, 'TREASURY_DEPOSIT'],
            });
            const undeposited = makeAccount({
                ...undepositedFundsAccount,
                allowedSources: [...undepositedFundsAccount.allowedSources, 'TREASURY_DEPOSIT'],
            });
            const req = makeRequest(
                'TREASURY_DEPOSIT',
                [
                    { accountCode: '1010', debitAmount: 100, creditAmount: 0 },
                    { accountCode: '1015', debitAmount: 0, creditAmount: 100 },
                ],
                [cashWithTreasury, undeposited],
            );
            expect(() => PostingGovernanceService.validate(req)).not.toThrow();
        });

        it('allows TREASURY_REVERSAL to credit Cash', () => {
            const cashWithTreasury = makeAccount({
                ...cashAccount,
                allowedSources: [...cashAccount.allowedSources, 'TREASURY_REVERSAL'],
            });
            const bank = makeAccount({
                accountCode: '1030',
                accountName: 'Bank',
                accountType: 'ASSET',
                normalBalance: 'DEBIT',
                allowManualPosting: false,
                allowedSources: ['TREASURY_REVERSAL'],
                systemAccountTag: 'BANK',
            });
            const req = makeRequest(
                'TREASURY_REVERSAL',
                [
                    { accountCode: '1010', debitAmount: 0, creditAmount: 25_000 },
                    { accountCode: '1030', debitAmount: 25_000, creditAmount: 0 },
                ],
                [cashWithTreasury, bank],
            );
            expect(() => PostingGovernanceService.validate(req)).not.toThrow();
        });
        it('allows TREASURY_DEPOSIT with bank debit and undeposited credit', () => {
            const cashWithTreasury = makeAccount({
                ...cashAccount,
                allowedSources: [...cashAccount.allowedSources, 'TREASURY_DEPOSIT'],
            });
            const undeposited = makeAccount({
                ...undepositedFundsAccount,
                allowedSources: [...undepositedFundsAccount.allowedSources, 'TREASURY_DEPOSIT'],
            });
            const req = makeRequest(
                'TREASURY_DEPOSIT',
                [
                    { accountCode: '1010', debitAmount: 250, creditAmount: 0 },
                    { accountCode: '1015', debitAmount: 0, creditAmount: 250 },
                ],
                [cashWithTreasury, undeposited],
            );
            expect(() => PostingGovernanceService.validate(req)).not.toThrow();
        });

        it('rejects TREASURY_DEPOSIT without undeposited credit', () => {
            const cashWithTreasury = makeAccount({
                ...cashAccount,
                allowedSources: [...cashAccount.allowedSources, 'TREASURY_DEPOSIT'],
            });
            const bank = makeAccount({
                accountCode: '1030',
                accountName: 'Bank',
                accountType: 'ASSET',
                normalBalance: 'DEBIT',
                allowManualPosting: false,
                allowedSources: ['TREASURY_DEPOSIT'],
                systemAccountTag: 'CASH',
            });
            const req = makeRequest(
                'TREASURY_DEPOSIT',
                [
                    { accountCode: '1030', debitAmount: 250, creditAmount: 0 },
                    { accountCode: '1010', debitAmount: 0, creditAmount: 250 },
                ],
                [bank, cashWithTreasury],
            );
            expect(() => PostingGovernanceService.validate(req)).toThrow('GOV_RULE_E_DEPOSIT_STRUCTURE');
        });
        it('allows TREASURY_TRANSFER cash credit (Rule D)', () => {
            const cashWithTreasury = makeAccount({
                ...cashAccount,
                allowedSources: [...cashAccount.allowedSources, 'TREASURY_TRANSFER'],
            });
            const bank = makeAccount({
                accountCode: '1030',
                accountName: 'Bank',
                accountType: 'ASSET',
                normalBalance: 'DEBIT',
                allowManualPosting: false,
                allowedSources: ['TREASURY_TRANSFER'],
                systemAccountTag: 'BANK',
            });
            const req = makeRequest(
                'TREASURY_TRANSFER',
                [
                    { accountCode: '1030', debitAmount: 10_000, creditAmount: 0 },
                    { accountCode: '1010', debitAmount: 0, creditAmount: 10_000 },
                ],
                [bank, cashWithTreasury],
            );
            expect(() => PostingGovernanceService.validate(req)).not.toThrow();
        });

        it('blocks MANUAL_JOURNAL from crediting Cash (treasury must use TREASURY_*)', () => {
            const req = makeRequest(
                'MANUAL_JOURNAL',
                [
                    { accountCode: '6900', debitAmount: 100, creditAmount: 0 },
                    { accountCode: '1010', debitAmount: 0, creditAmount: 100 },
                ],
                [
                    makeAccount({
                        accountCode: '6900',
                        accountName: 'Expense',
                        accountType: 'EXPENSE',
                        normalBalance: 'DEBIT',
                        allowManualPosting: true,
                        allowedSources: [],
                    }),
                    cashAccount,
                ],
            );
            expect(() => PostingGovernanceService.validate(req)).toThrow(PostingGovernanceError);
            try {
                PostingGovernanceService.validate(req);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                expect(
                    msg.includes('GOV_RULE_D_CASH_CREDIT') || msg.includes('GOV_RULE_A_NORMAL_BALANCE'),
                ).toBe(true);
            }
        });
        it('allows TREASURY_PETTY_CASH to credit Petty Cash / Cash', () => {
            const petty = makeAccount({
                accountCode: '1012',
                accountName: 'Petty Cash',
                accountType: 'ASSET',
                normalBalance: 'DEBIT',
                allowManualPosting: false,
                allowedSources: ['TREASURY_PETTY_CASH', 'TREASURY_TRANSFER'],
                systemAccountTag: 'PETTY_CASH',
            });
            const expense = makeAccount({
                accountCode: '6900',
                accountName: 'General Expense',
                accountType: 'EXPENSE',
                normalBalance: 'DEBIT',
                allowManualPosting: true,
                allowedSources: ['TREASURY_PETTY_CASH'],
            });
            const req = makeRequest(
                'TREASURY_PETTY_CASH',
                [
                    { accountCode: '6900', debitAmount: 5_000, creditAmount: 0 },
                    { accountCode: '1012', debitAmount: 0, creditAmount: 5_000 },
                ],
                [expense, petty],
            );
            expect(() => PostingGovernanceService.validate(req)).not.toThrow();
        });
    });

    // --------------------------------------------------------------------------
    // RULE E: Payment receipt / deposit structure validation
    // --------------------------------------------------------------------------
    describe('Rule E — Payment receipt/deposit structure', () => {
        it('rejects PAYMENT_RECEIPT without Undeposited Funds debit', () => {
            const req = makeRequest(
                'PAYMENT_RECEIPT',
                [
                    { accountCode: '1010', debitAmount: 100, creditAmount: 0 }, // Wrong — should be 1015
                    { accountCode: '1200', debitAmount: 0, creditAmount: 100 },
                ],
                [cashAccount, arAccount]
            );
            expect(() => PostingGovernanceService.validate(req)).toThrow(PostingGovernanceError);
            expect(() => PostingGovernanceService.validate(req)).toThrow('GOV_RULE_E_RECEIPT_STRUCTURE');
        });

        it('allows TILL_RECEIPT as Dr Cash Drawer 1010 / Cr AR', () => {
            const req = makeRequest(
                'TILL_RECEIPT',
                [
                    { accountCode: '1010', debitAmount: 100, creditAmount: 0 },
                    { accountCode: '1200', debitAmount: 0, creditAmount: 100 },
                ],
                [cashAccount, arAccount]
            );
            expect(() => PostingGovernanceService.validate(req)).not.toThrow();
        });

        it('rejects TILL_RECEIPT that debits Undeposited Funds', () => {
            const req = makeRequest(
                'TILL_RECEIPT',
                [
                    { accountCode: '1015', debitAmount: 100, creditAmount: 0 },
                    { accountCode: '1200', debitAmount: 0, creditAmount: 100 },
                ],
                [undepositedFundsAccount, arAccount]
            );
            expect(() => PostingGovernanceService.validate(req)).toThrow(PostingGovernanceError);
            expect(() => PostingGovernanceService.validate(req)).toThrow('GOV_RULE_E_TILL_RECEIPT_STRUCTURE');
        });

        it('rejects PAYMENT_RECEIPT without AR or Customer Deposits credit', () => {
            const req = makeRequest(
                'PAYMENT_RECEIPT',
                [
                    { accountCode: '1015', debitAmount: 100, creditAmount: 0 },
                    { accountCode: '4000', debitAmount: 0, creditAmount: 100 }, // Wrong — should be AR or 2200
                ],
                [undepositedFundsAccount, revenueAccount]
            );
            expect(() => PostingGovernanceService.validate(req)).toThrow(PostingGovernanceError);
            expect(() => PostingGovernanceService.validate(req)).toThrow('GOV_RULE_E_RECEIPT_STRUCTURE');
        });

        it('allows PAYMENT_RECEIPT with Undeposited Funds / Customer Deposits (advance)', () => {
            const customerDepositsAccount = makeAccount({
                accountCode: '2200',
                accountName: 'Customer Deposits',
                accountType: 'LIABILITY',
                normalBalance: 'CREDIT',
                allowManualPosting: true,
                allowedSources: [],
                systemAccountTag: null,
            });
            const req = makeRequest(
                'PAYMENT_RECEIPT',
                [
                    { accountCode: '1015', debitAmount: 100, creditAmount: 0 },
                    { accountCode: '2200', debitAmount: 0, creditAmount: 100 },
                ],
                [undepositedFundsAccount, customerDepositsAccount]
            );
            expect(() => PostingGovernanceService.validate(req)).not.toThrow();
        });

        it('allows DEPOSIT_APPLICATION as Dr Customer Deposits / Cr AR (no cash)', () => {
            const customerDepositsAccount = makeAccount({
                accountCode: '2200',
                accountName: 'Customer Deposits',
                accountType: 'LIABILITY',
                normalBalance: 'CREDIT',
                allowManualPosting: true,
                allowedSources: [],
                systemAccountTag: 'CUSTOMER_DEPOSITS',
            });
            const req = makeRequest(
                'DEPOSIT_APPLICATION',
                [
                    { accountCode: '2200', debitAmount: 100, creditAmount: 0 },
                    { accountCode: '1200', debitAmount: 0, creditAmount: 100 },
                ],
                [customerDepositsAccount, arAccount],
            );
            expect(() => PostingGovernanceService.validate(req)).not.toThrow();
        });

        it('rejects DEPOSIT_APPLICATION mislabeled as cash-style receipt structure', () => {
            // Wrong: liability→AR must not use PAYMENT_RECEIPT source (lacks UF debit)
            const customerDepositsAccount = makeAccount({
                accountCode: '2200',
                accountName: 'Customer Deposits',
                accountType: 'LIABILITY',
                normalBalance: 'CREDIT',
                allowManualPosting: true,
                allowedSources: [],
                systemAccountTag: null,
            });
            const req = makeRequest(
                'PAYMENT_RECEIPT',
                [
                    { accountCode: '2200', debitAmount: 100, creditAmount: 0 },
                    { accountCode: '1200', debitAmount: 0, creditAmount: 100 },
                ],
                [customerDepositsAccount, arAccount],
            );
            expect(() => PostingGovernanceService.validate(req)).toThrow('GOV_RULE_E_RECEIPT_STRUCTURE');
        });

        it('rejects DEPOSIT_APPLICATION without AR credit', () => {
            const customerDepositsAccount = makeAccount({
                accountCode: '2200',
                accountName: 'Customer Deposits',
                accountType: 'LIABILITY',
                normalBalance: 'CREDIT',
                allowManualPosting: true,
                allowedSources: [],
                systemAccountTag: 'CUSTOMER_DEPOSITS',
            });
            const req = makeRequest(
                'DEPOSIT_APPLICATION',
                [
                    { accountCode: '2200', debitAmount: 100, creditAmount: 0 },
                    { accountCode: '1015', debitAmount: 0, creditAmount: 100 },
                ],
                [customerDepositsAccount, undepositedFundsAccount],
            );
            expect(() => PostingGovernanceService.validate(req)).toThrow(
                'GOV_RULE_E_DEPOSIT_APPLICATION_STRUCTURE',
            );
        });

        it('rejects PAYMENT_DEPOSIT without Cash debit', () => {
            const req = makeRequest(
                'PAYMENT_DEPOSIT',
                [
                    { accountCode: '1200', debitAmount: 100, creditAmount: 0 }, // Wrong — should be Cash
                    { accountCode: '1015', debitAmount: 0, creditAmount: 100 },
                ],
                [arAccount, undepositedFundsAccount]
            );
            expect(() => PostingGovernanceService.validate(req)).toThrow(PostingGovernanceError);
            expect(() => PostingGovernanceService.validate(req)).toThrow('GOV_RULE_E_DEPOSIT_STRUCTURE');
        });

        it('rejects PAYMENT_DEPOSIT without Undeposited Funds credit', () => {
            const req = makeRequest(
                'PAYMENT_DEPOSIT',
                [
                    { accountCode: '1010', debitAmount: 100, creditAmount: 0 },
                    { accountCode: '4000', debitAmount: 0, creditAmount: 100 }, // Wrong — should be Undeposited
                ],
                [cashAccount, revenueAccount]
            );
            expect(() => PostingGovernanceService.validate(req)).toThrow(PostingGovernanceError);
            expect(() => PostingGovernanceService.validate(req)).toThrow('GOV_RULE_E_DEPOSIT_STRUCTURE');
        });
    });

    // --------------------------------------------------------------------------
    // RULE F: COGS restricted to INVENTORY_MOVE / SALES_INVOICE
    // --------------------------------------------------------------------------
    describe('Rule F — COGS restriction', () => {
        it('blocks MANUAL_JOURNAL from touching COGS', () => {
            const req = makeRequest(
                'MANUAL_JOURNAL',
                [
                    { accountCode: '5000', debitAmount: 100, creditAmount: 0 },
                    { accountCode: '4000', debitAmount: 0, creditAmount: 100 },
                ],
                [cogsAccount, revenueAccount]
            );
            // Rule C fires first (allowManualPosting=false), which is equally correct
            expect(() => PostingGovernanceService.validate(req)).toThrow(PostingGovernanceError);
        });

        it('blocks PURCHASE_BILL from debiting COGS', () => {
            const req = makeRequest(
                'PURCHASE_BILL',
                [
                    { accountCode: '5000', debitAmount: 100, creditAmount: 0 },
                    { accountCode: '2100', debitAmount: 0, creditAmount: 100 },
                ],
                [cogsAccount, makeAccount({ accountCode: '2100', accountType: 'LIABILITY', normalBalance: 'CREDIT' })]
            );
            // Either Rule B (source not in allowedSources) or Rule F (COGS restricted) fires
            expect(() => PostingGovernanceService.validate(req)).toThrow(PostingGovernanceError);
        });

        it('allows INVENTORY_MOVE to debit COGS', () => {
            const req = makeRequest(
                'INVENTORY_MOVE',
                [
                    { accountCode: '5000', debitAmount: 100, creditAmount: 0 },
                    { accountCode: '1300', debitAmount: 0, creditAmount: 100 },
                ],
                [cogsAccount, inventoryAccount]
            );
            expect(() => PostingGovernanceService.validate(req)).not.toThrow();
        });
    });

    // --------------------------------------------------------------------------
    // RULE G: Opening Balance Equity restricted
    // --------------------------------------------------------------------------
    describe('Rule G — Opening Balance Equity restriction', () => {
        it('blocks MANUAL_JOURNAL from posting to OBE', () => {
            const req = makeRequest(
                'MANUAL_JOURNAL',
                [
                    { accountCode: '1300', debitAmount: 100, creditAmount: 0 },
                    { accountCode: '3050', debitAmount: 0, creditAmount: 100 },
                ],
                [inventoryAccount, obeAccount]
            );
            // Rule C fires first (allowManualPosting=false for OBE), which is still correct behavior
            expect(() => PostingGovernanceService.validate(req)).toThrow(PostingGovernanceError);
        });

        it('blocks SALES_INVOICE from posting to OBE', () => {
            const req = makeRequest(
                'SALES_INVOICE',
                [
                    { accountCode: '1200', debitAmount: 100, creditAmount: 0 },
                    { accountCode: '3050', debitAmount: 0, creditAmount: 100 },
                ],
                [arAccount, obeAccount]
            );
            // Either Rule B (source not allowed) or Rule G (OBE restricted) fires — both are correct
            expect(() => PostingGovernanceService.validate(req)).toThrow(PostingGovernanceError);
        });

        it('allows OPENING_BALANCE_WIZARD to post to OBE', () => {
            const req = makeRequest(
                'OPENING_BALANCE_WIZARD',
                [
                    { accountCode: '1300', debitAmount: 100, creditAmount: 0 },
                    { accountCode: '3050', debitAmount: 0, creditAmount: 100 },
                ],
                [inventoryAccount, obeAccount]
            );
            expect(() => PostingGovernanceService.validate(req)).not.toThrow();
        });

        it('allows SYSTEM_CORRECTION with heal key to post inventory + OBE', () => {
            const req = makeRequest(
                'SYSTEM_CORRECTION',
                [
                    { accountCode: '1300', debitAmount: 100, creditAmount: 0 },
                    { accountCode: '3050', debitAmount: 0, creditAmount: 100 },
                ],
                [inventoryAccount, obeAccount],
                'INV-GL-DRIFT-HEAL-2026-05-28',
            );
            expect(() => PostingGovernanceService.validate(req)).not.toThrow();
        });
    });

    // --------------------------------------------------------------------------
    // RULE H: SAP-strict inventory restriction (account tag = INVENTORY)
    // --------------------------------------------------------------------------
    describe('Rule H — Inventory account SAP-strict source', () => {
        it('blocks SALES_INVOICE from posting to account tagged INVENTORY (even if allowedSources permits)', () => {
            // Use a legacy-style account that still lists SALES_INVOICE in allowedSources.
            // Rule H must still throw because the hardcoded SAP rule trumps the column.
            const legacyInventory = makeAccount({
                accountCode: '1300',
                accountName: 'Inventory',
                accountType: 'ASSET',
                normalBalance: 'DEBIT',
                allowManualPosting: false,
                allowedSources: ['INVENTORY_MOVE', 'SALES_INVOICE', 'PURCHASE_BILL', 'SYSTEM_CORRECTION'],
                systemAccountTag: 'INVENTORY',
            });
            const req = makeRequest(
                'SALES_INVOICE',
                [
                    { accountCode: '5000', debitAmount: 50, creditAmount: 0 },
                    { accountCode: '1300', debitAmount: 0, creditAmount: 50 },
                ],
                [cogsAccount, legacyInventory],
            );
            expect(() => PostingGovernanceService.validate(req)).toThrow(PostingGovernanceError);
            try {
                PostingGovernanceService.validate(req);
            } catch (err) {
                expect(err).toBeInstanceOf(PostingGovernanceError);
                expect((err as PostingGovernanceError).code).toBe('GOV_RULE_H_INVENTORY_STRICT');
            }
        });

        it('blocks PURCHASE_BILL from posting to account tagged INVENTORY', () => {
            const legacyInventory = makeAccount({
                accountCode: '1300',
                accountName: 'Inventory',
                accountType: 'ASSET',
                normalBalance: 'DEBIT',
                allowManualPosting: false,
                allowedSources: ['INVENTORY_MOVE', 'PURCHASE_BILL', 'SYSTEM_CORRECTION'],
                systemAccountTag: 'INVENTORY',
            });
            const apAccount = makeAccount({
                accountCode: '2100',
                accountType: 'LIABILITY',
                normalBalance: 'CREDIT',
                allowManualPosting: false,
                allowedSources: ['PURCHASE_BILL', 'INVENTORY_MOVE', 'SYSTEM_CORRECTION'],
                systemAccountTag: 'ACCOUNTS_PAYABLE',
            });
            const req = makeRequest(
                'PURCHASE_BILL',
                [
                    { accountCode: '1300', debitAmount: 1000, creditAmount: 0 },
                    { accountCode: '2100', debitAmount: 0, creditAmount: 1000 },
                ],
                [legacyInventory, apAccount],
            );
            expect(() => PostingGovernanceService.validate(req)).toThrow(PostingGovernanceError);
        });

        it('blocks MANUAL_JOURNAL from posting to account tagged INVENTORY', () => {
            const req = makeRequest(
                'MANUAL_JOURNAL',
                [
                    { accountCode: '1300', debitAmount: 100, creditAmount: 0 },
                    { accountCode: '4000', debitAmount: 0, creditAmount: 100 },
                ],
                [inventoryAccount, revenueAccount],
            );
            // Rule C (manual posting blocked) may fire first; either is correct.
            expect(() => PostingGovernanceService.validate(req)).toThrow(PostingGovernanceError);
        });

        it('allows INVENTORY_MOVE to post to account tagged INVENTORY', () => {
            const req = makeRequest(
                'INVENTORY_MOVE',
                [
                    { accountCode: '5000', debitAmount: 50, creditAmount: 0 },
                    { accountCode: '1300', debitAmount: 0, creditAmount: 50 },
                ],
                [cogsAccount, inventoryAccount],
            );
            expect(() => PostingGovernanceService.validate(req)).not.toThrow();
        });

        it('allows SYSTEM_CORRECTION with approved heal key to post to INVENTORY', () => {
            const shrinkageAccount = makeAccount({
                accountCode: '5110',
                accountType: 'EXPENSE',
                normalBalance: 'DEBIT',
                allowManualPosting: true,
                allowedSources: [],
                systemAccountTag: null,
            });
            const req = makeRequest(
                'SYSTEM_CORRECTION',
                [
                    { accountCode: '5110', debitAmount: 100, creditAmount: 0 },
                    { accountCode: '1300', debitAmount: 0, creditAmount: 100 },
                ],
                [shrinkageAccount, inventoryAccount],
                'INV-GL-DRIFT-HEAL-2026-05-28',
            );
            expect(() => PostingGovernanceService.validate(req)).not.toThrow();
        });

        it('blocks SYSTEM_CORRECTION on INVENTORY without approved heal idempotency key', () => {
            const shrinkageAccount = makeAccount({
                accountCode: '5110',
                accountType: 'EXPENSE',
                normalBalance: 'DEBIT',
                allowManualPosting: true,
                allowedSources: [],
                systemAccountTag: null,
            });
            const req = makeRequest(
                'SYSTEM_CORRECTION',
                [
                    { accountCode: '5110', debitAmount: 100, creditAmount: 0 },
                    { accountCode: '1300', debitAmount: 0, creditAmount: 100 },
                ],
                [shrinkageAccount, inventoryAccount],
            );
            expect(() => PostingGovernanceService.validate(req)).toThrow(PostingGovernanceError);
            try {
                PostingGovernanceService.validate(req);
            } catch (err) {
                expect((err as PostingGovernanceError).code).toBe('GOV_RULE_H_INVENTORY_HEAL_ONLY');
            }
        });

        it('allows OPENING_BALANCE_WIZARD to post to account tagged INVENTORY', () => {
            const req = makeRequest(
                'OPENING_BALANCE_WIZARD',
                [
                    { accountCode: '1300', debitAmount: 500, creditAmount: 0 },
                    { accountCode: '3050', debitAmount: 0, creditAmount: 500 },
                ],
                [inventoryAccount, obeAccount],
            );
            expect(() => PostingGovernanceService.validate(req)).not.toThrow();
        });

        it('does not fire Rule H on accounts that are NOT tagged INVENTORY', () => {
            // COGS (tag=COGS) touched by SALES_INVOICE: Rule H should not apply.
            // Rule F may apply separately but we isolate the check here.
            const req = makeRequest(
                'INVENTORY_MOVE',
                [
                    { accountCode: '5000', debitAmount: 50, creditAmount: 0 },
                    { accountCode: '1300', debitAmount: 0, creditAmount: 50 },
                ],
                [cogsAccount, inventoryAccount],
            );
            expect(() => PostingGovernanceService.validate(req)).not.toThrow();
        });
    });

    // --------------------------------------------------------------------------
    // CUSTOMER CREDIT NOTE (SALES_REFUND → AR 1200)
    // --------------------------------------------------------------------------
    describe('SALES_REFUND — customer credit note GL', () => {
        const arProductionLike = makeAccount({
            ...arAccount,
            allowedSources: ['SALES_INVOICE', 'CUTOVER_CORRECTION', 'SYSTEM_CORRECTION', 'PAYMENT_RECEIPT'],
        });
        const salesReturns = makeAccount({
            accountCode: '4010',
            accountName: 'Sales Returns & Allowances',
            accountType: 'REVENUE',
            normalBalance: 'DEBIT',
            allowManualPosting: false,
            allowedSources: [],
            systemAccountTag: null,
        });

        it('blocks SALES_REFUND credit to AR when SALES_REFUND not in AllowedSources', () => {
            const req = makeRequest(
                'SALES_REFUND',
                [
                    { accountCode: '4010', debitAmount: 82900, creditAmount: 0 },
                    { accountCode: '1200', debitAmount: 0, creditAmount: 82900 },
                ],
                [arProductionLike, salesReturns],
            );
            expect(() => PostingGovernanceService.validate(req)).toThrow(/GOV_RULE_B_SOURCE_NOT_ALLOWED/);
            expect(() => PostingGovernanceService.validate(req)).toThrow(/1200/);
        });

        it('allows SALES_REFUND credit to AR when SALES_REFUND is in AllowedSources', () => {
            const arWithRefund = makeAccount({
                ...arProductionLike,
                allowedSources: [...arProductionLike.allowedSources, 'SALES_REFUND'],
            });
            const req = makeRequest(
                'SALES_REFUND',
                [
                    { accountCode: '4010', debitAmount: 100, creditAmount: 0 },
                    { accountCode: '1200', debitAmount: 0, creditAmount: 100 },
                ],
                [arWithRefund, salesReturns],
            );
            expect(() => PostingGovernanceService.validate(req)).not.toThrow();
        });
    });

    // --------------------------------------------------------------------------
    // EDGE CASES
    // --------------------------------------------------------------------------
    describe('Edge cases', () => {
        it('passes validation when account codes in request are not found in governance accounts (graceful skip)', () => {
            // Account governance is optional metadata — if not tagged, rules A/B/C don't apply
            const unknownAccount = makeAccount({
                accountCode: '9999',
                systemAccountTag: null,
                allowManualPosting: true,
                allowedSources: [],
            });
            const req = makeRequest(
                'MANUAL_JOURNAL',
                [
                    { accountCode: '9999', debitAmount: 100, creditAmount: 0 },
                    { accountCode: '8888', debitAmount: 0, creditAmount: 100 }, // Not in accounts array
                ],
                [unknownAccount]
            );
            expect(() => PostingGovernanceService.validate(req)).not.toThrow();
        });

        it('validates an empty lines array without throwing', () => {
            const req = makeRequest('MANUAL_JOURNAL', [], []);
            expect(() => PostingGovernanceService.validate(req)).not.toThrow();
        });
    });
});
