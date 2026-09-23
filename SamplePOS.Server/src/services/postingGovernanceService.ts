/**
 * POSTING GOVERNANCE SERVICE
 *
 * Enterprise-grade posting controls comparable to SAP FI and Odoo accounting.
 *
 * SAP analogy:
 *   - Account master "posting block" (AllowManualPosting = false)
 *   - Field status group validation (AllowedSources)
 *   - Normal balance enforcement via substitution rules
 *
 * Odoo analogy:
 *   - account.account.deprecated flag
 *   - journal type restrictions
 *   - account tag constraints
 *
 * ALL rules are HARD BLOCKS — no warnings, no overrides.
 * Once violated, the transaction is rejected with a descriptive error.
 *
 * Architecture note:
 *   This service is called from AccountingCore.createJournalEntry() BEFORE
 *   any database write. The governance check is the outermost guard.
 */

import type pg from 'pg';
import { BusinessRuleException } from '../errors/BusinessRuleException.js';

// =============================================================================
// POSTING SOURCE TYPE
// =============================================================================

/**
 * Every journal entry must declare its source.
 * This is the single axis of control for posting governance.
 */
export type PostingSource =
    | 'SALES_INVOICE'           // POS sale / invoice posting
    | 'SALES_REFUND'            // Sale refund/return — reverses revenue and credits cash/AR
    | 'PAYMENT_RECEIPT'         // Customer payment/deposit → Dr Undeposited Funds / Cr AR or Customer Deposits
    | 'TILL_RECEIPT'            // POS till AR collection → Dr Cash Drawer 1010 / Cr AR (cash already in till)
    | 'PAYMENT_DEPOSIT'         // Bank deposit → Dr Cash / Cr Undeposited Funds
    | 'DEPOSIT_APPLICATION'     // Apply prepayment liability → Dr Customer Deposits (2200) / Cr AR (no cash)
    | 'PURCHASE_BILL'           // Supplier bill / goods receipt (creates AP liability)
    | 'SUPPLIER_PAYMENT'        // Supplier payment — Dr AP / Cr Cash or Bank
    | 'INVENTORY_MOVE'          // Stock adjustment, damage, expiry, COGS
    | 'OPENING_BALANCE_WIZARD'  // One-time OBE setup — locked after completion
    | 'MANUAL_JOURNAL'          // Human-entered journal entry
    | 'SYSTEM_CORRECTION'       // Admin remediation scripts (e.g. data-fix)
    | 'PAYROLL'                 // Payroll disbursements
    | 'EXPENSE_PAYMENT'         // Expense payment — Dr AP / Cr Cash or Bank
    | 'ASSET_DEPRECIATION'      // Fixed asset depreciation runs
    | 'PERIOD_CLOSE'            // Retained earnings close-out
    | 'FX_REVALUATION'          // Foreign currency revaluation
    | 'CUTOVER_OB'              // Cutover: supplier/customer opening balances (GL-only, no invoice)
    | 'CUTOVER_CORRECTION'      // Cutover: reversal of wrongly posted pre-ERP asset credits
    | 'WHT_REMITTANCE'          // Remit supplier WHT payable to tax authority — Dr 2350 / Cr Cash
    | 'WHT_RECEIVABLE_RECOVERY' // Recover customer Tax Receivable from URA — Dr Cash / Cr 1250
    | 'VAT_REMITTANCE'          // Remit net VAT payable to tax authority — Dr 2300 / Cr Cash (ADR-005)
    | 'TREASURY_DEPOSIT'        // Deposit worksheet / card / MoMo settlement — clears undeposited → bank/cash
    | 'TREASURY_TRANSFER'       // Liquidity ↔ liquidity (cash/bank/MoMo/card clearing)
    | 'TREASURY_PETTY_CASH'     // Petty cash fund / replenish / expense
    | 'TREASURY_REVERSAL'       // Reversal of a posted Treasury Document
    | 'AR_WRITEOFF'             // Bad debt direct write-off — Dr 5210 / Cr 1200 (ADR-006)
    | 'AR_WRITEOFF_REVERSAL'    // Reversal of a posted AR write-off document
    | 'BANK_MANUAL'             // Manual bank register deposit/withdrawal (Banking module)
    | 'CASH_VARIANCE'           // Till Z variance OR employee till-shortage charge — may credit CASH 1010

// =============================================================================
// GOVERNANCE ACCOUNT SHAPE
// (Extends the base Account with governance-specific columns)
// =============================================================================

export interface GovernanceAccount {
    id: string;
    accountCode: string;
    accountName: string;
    accountType: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';
    normalBalance: 'DEBIT' | 'CREDIT';
    isPostingAccount: boolean;
    isActive: boolean;
    allowManualPosting: boolean;           // AllowManualPosting
    allowedSources: PostingSource[];       // AllowedSources
    systemAccountTag: string | null;       // SystemAccountTag
}

// =============================================================================
// GOVERNANCE JOURNAL LINE
// =============================================================================

export interface GovernanceJournalLine {
    accountCode: string;
    debitAmount: number;
    creditAmount: number;
}

export interface GovernanceJournalRequest {
    source: PostingSource;
    lines: GovernanceJournalLine[];
    accounts: GovernanceAccount[];   // Pre-fetched from DB — one entry per unique account used
    /** Required when SYSTEM_CORRECTION touches account 1300 (inventory drift heal only). */
    idempotencyKey?: string;
}

/** Approved idempotency keys for SYSTEM_CORRECTION journals that credit/debit 1300. */
export const INVENTORY_DRIFT_HEAL_KEY_PATTERNS: readonly RegExp[] = [
    /^INV-GL-DRIFT-HEAL-\d{4}-\d{2}-\d{2}$/,
    /^inventory-gl-drift-fix-\d{4}-\d{2}-\d{2}$/,
];

export function isApprovedInventoryDriftHealKey(key: string | undefined): boolean {
    if (!key) return false;
    return INVENTORY_DRIFT_HEAL_KEY_PATTERNS.some((re) => re.test(key));
}

// =============================================================================
// ERROR CLASSES
// =============================================================================

/**
 * Standalone error class — does NOT extend AccountingError to avoid circular deps.
 * accountingCore imports this file; this file must NOT import accountingCore.
 *
 * Extends BusinessRuleException so the global handler returns HTTP 422 (not 500)
 * and the frontend can distinguish "rule violated" from "server crashed".
 */
export class PostingGovernanceError extends BusinessRuleException {
    constructor(
        message: string,
        /** GOV_RULE_* code — kept as `code` for backward-compat with existing call sites */
        public readonly code: string,
        context: Record<string, unknown> = {}
    ) {
        // Include [CODE] in message so Jest toThrow('CODE') assertions still work
        super(`[${code}] ${message}`, code, { ...context, reason: message });
        this.name = 'PostingGovernanceError';
        // Keep context as own property so tests that check err.context still pass
        Object.defineProperty(this, 'context', { value: context, enumerable: true });
    }

    /** @deprecated access this.details instead — kept for backward compat */
    declare readonly context: Record<string, unknown>;
}

// =============================================================================
// HELPER: find governance account by code
// =============================================================================

function findAccount(accounts: GovernanceAccount[], code: string): GovernanceAccount | undefined {
    return accounts.find((a) => a.accountCode === code);
}

// =============================================================================
// POSTING GOVERNANCE SERVICE
// =============================================================================

export class PostingGovernanceService {
    /**
     * Validate a proposed journal entry against all governance rules.
     * Throws PostingGovernanceError on any violation.
     *
     * Call this BEFORE any database write.
     */
    static validate(request: GovernanceJournalRequest): void {
        const { source, lines, accounts, idempotencyKey } = request;

        for (const line of lines) {
            const account = findAccount(accounts, line.accountCode);

            // Account not found — AccountingCore will handle the proper error upstream,
            // but governance should not crash on unknown account.
            if (!account) continue;

            const isDebit = line.debitAmount > 0;
            const isCredit = line.creditAmount > 0;

            // ------------------------------------------------------------------
            // Rule A: Normal balance violation — block reversals of normal side
            //         that would cause the account to go to the wrong side overall.
            //
            // We enforce that system-tagged accounts cannot be posted on the
            // WRONG side (e.g. Cash cannot go Credit) when source is MANUAL_JOURNAL.
            // For automated sources, the service itself is responsible for correct
            // posting direction; the governance service enforces structural rules.
            //
            // Implementation: For MANUAL_JOURNAL only — if account's normal balance
            // is DEBIT and a credit-only line is submitted, reject it for protected
            // accounts. And vice-versa for CREDIT-normal accounts.
            // ------------------------------------------------------------------
            if (source === 'MANUAL_JOURNAL' && account.systemAccountTag !== null) {
                const normalIsDebit = account.normalBalance === 'DEBIT';
                if (normalIsDebit && isCredit && !isDebit) {
                    throw new PostingGovernanceError(
                        `Account ${account.accountCode} (${account.accountName}) is a debit-normal system account. ` +
                        `Manual credit entries are not permitted. ` +
                        `Normal balance: DEBIT, tag: ${account.systemAccountTag}.`,
                        'GOV_RULE_A_NORMAL_BALANCE',
                        { accountCode: account.accountCode, normalBalance: account.normalBalance, source, tag: account.systemAccountTag }
                    );
                }
                const normalIsCredit = account.normalBalance === 'CREDIT';
                if (normalIsCredit && isDebit && !isCredit) {
                    throw new PostingGovernanceError(
                        `Account ${account.accountCode} (${account.accountName}) is a credit-normal system account. ` +
                        `Manual debit entries are not permitted. ` +
                        `Normal balance: CREDIT, tag: ${account.systemAccountTag}.`,
                        'GOV_RULE_A_NORMAL_BALANCE',
                        { accountCode: account.accountCode, normalBalance: account.normalBalance, source, tag: account.systemAccountTag }
                    );
                }
            }

            // ------------------------------------------------------------------
            // Rule B: Source not in account.allowedSources → block
            //         (only enforced when allowedSources is a non-empty list)
            //
            //  NOTE: For PAYMENT_RECEIPT and PAYMENT_DEPOSIT sources, Rule E performs
            //  a complete structural check of the entry. We skip per-line Rule B for
            //  these sources to avoid false positives (e.g. PAYMENT_DEPOSIT posting to
            //  AR temporarily before Rule E validates the overall structure).
            //  We also skip Rule B on CASH-tagged accounts — Rule D handles those explicitly.
            //  We also skip Rule B on accounts with allowManualPosting=false when source is
            //  MANUAL_JOURNAL — Rule C handles those and gives a more specific message.
            //  CUTOVER_CORRECTION / CUTOVER_OB are system-level cutover operations that must
            //  be able to debit Cash (reversing a wrong credit) and post to any system account.
            //  They are validated structurally by cutoverCorrectionService — not here.
            // ------------------------------------------------------------------
            const isPaymentSource =
                source === 'PAYMENT_RECEIPT' ||
                source === 'TILL_RECEIPT' ||
                source === 'PAYMENT_DEPOSIT' ||
                source === 'DEPOSIT_APPLICATION' || // structure validated by Rule E (liability→AR)
                source === 'TREASURY_DEPOSIT' ||
                source === 'TREASURY_TRANSFER' ||
                source === 'TREASURY_PETTY_CASH' ||
                source === 'BANK_MANUAL';
            const isCutoverSource = source === 'CUTOVER_CORRECTION' || source === 'CUTOVER_OB';
            const isCashTaggedCreditLine = account.systemAccountTag === 'CASH' && line.creditAmount > 0;
            const deferToRuleC = !account.allowManualPosting && source === 'MANUAL_JOURNAL';
            if (!isPaymentSource && !isCutoverSource && !isCashTaggedCreditLine && !deferToRuleC && account.allowedSources.length > 0) {
                if (!account.allowedSources.includes(source)) {
                    throw new PostingGovernanceError(
                        `Source '${source}' is not permitted to post to account ${account.accountCode} (${account.accountName}). ` +
                        `Allowed sources: [${account.allowedSources.join(', ')}].`,
                        'GOV_RULE_B_SOURCE_NOT_ALLOWED',
                        { accountCode: account.accountCode, source, allowedSources: account.allowedSources }
                    );
                }
            }

            // ------------------------------------------------------------------
            // Rule C: allowManualPosting = false + source = MANUAL_JOURNAL → block
            //
            // Exception: CASH-tagged accounts may be DEBITED via MANUAL_JOURNAL to
            // support capital investment and owner cash injection (Dr Cash / Cr Equity).
            // Crediting cash is separately and more strictly protected by Rule D.
            // ------------------------------------------------------------------
            if (!account.allowManualPosting && source === 'MANUAL_JOURNAL') {
                const isCashDebitOnly = account.systemAccountTag === 'CASH' && isDebit && !isCredit;
                if (!isCashDebitOnly) {
                    throw new PostingGovernanceError(
                        `Account ${account.accountCode} (${account.accountName}) does not allow manual journal entries. ` +
                        `This account is system-controlled. Use the appropriate module to post to it.`,
                        'GOV_RULE_C_NO_MANUAL_POSTING',
                        { accountCode: account.accountCode, systemAccountTag: account.systemAccountTag }
                    );
                }
            }
        }

        // ------------------------------------------------------------------
        // Rule D: Crediting a CASH-tagged account is only allowed from PAYMENT_DEPOSIT,
        //         SUPPLIER_PAYMENT (AP reduction → cash out), EXPENSE_PAYMENT,
        //         WHT_REMITTANCE, VAT_REMITTANCE, TREASURY_* sources, or SYSTEM_CORRECTION.
        // ------------------------------------------------------------------
        for (const line of lines) {
            if (line.creditAmount > 0) {
                const account = findAccount(accounts, line.accountCode);
                if (account?.systemAccountTag === 'CASH') {
                    if (
                        source !== 'PAYMENT_DEPOSIT' &&
                        source !== 'SUPPLIER_PAYMENT' &&
                        source !== 'EXPENSE_PAYMENT' &&
                        source !== 'SALES_REFUND' &&
                        source !== 'SYSTEM_CORRECTION' &&
                        source !== 'CUTOVER_CORRECTION' &&  // reversing a wrong pre-ERP cash credit
                        source !== 'WHT_REMITTANCE' &&
                        source !== 'VAT_REMITTANCE' &&
                        source !== 'TREASURY_DEPOSIT' &&
                        source !== 'TREASURY_TRANSFER' &&
                        source !== 'TREASURY_PETTY_CASH' &&
                        source !== 'TREASURY_REVERSAL' &&
                        source !== 'BANK_MANUAL' &&
                        source !== 'CASH_VARIANCE'
                    ) {
                        throw new PostingGovernanceError(
                            `Cannot credit Cash account ${account.accountCode} (${account.accountName}) from source '${source}'. ` +
                            `Cash may only be credited by a bank deposit (PAYMENT_DEPOSIT), treasury document (TREASURY_*), manual bank withdrawal (BANK_MANUAL), supplier payment (SUPPLIER_PAYMENT), WHT remittance (WHT_REMITTANCE), VAT remittance (VAT_REMITTANCE), sale refund (SALES_REFUND), cash variance / till shortage charge (CASH_VARIANCE), or system correction.`,
                            'GOV_RULE_D_CASH_CREDIT',
                            { accountCode: account.accountCode, source }
                        );
                    }
                }
            }
        }

        // ------------------------------------------------------------------
        // Rule E: Payment receipt must be Dr Undeposited Funds /
        //         Cr AR (invoice payment) OR Cr Customer Deposits (advance)
        //         Payment deposit must be Dr Cash / Cr Undeposited Funds
        // ------------------------------------------------------------------
        // Rule E: Payment receipt / deposit / treasury deposit structure
        // ------------------------------------------------------------------
        if (source === 'PAYMENT_RECEIPT') {
            const hasDebitUndepositedFunds = lines.some((l) => {
                const acct = findAccount(accounts, l.accountCode);
                return l.debitAmount > 0 && acct?.systemAccountTag === 'UNDEPOSITED_FUNDS';
            });
            const hasCreditAR = lines.some((l) => {
                const acct = findAccount(accounts, l.accountCode);
                return l.creditAmount > 0 && acct?.systemAccountTag === 'ACCOUNTS_RECEIVABLE';
            });
            // Customer advances / on-account prepayments credit liability 2200
            // (tag optional — CoA uses AccountCode 2200 as the SSOT code).
            const hasCreditCustomerDeposits = lines.some((l) => {
                const acct = findAccount(accounts, l.accountCode);
                if (l.creditAmount <= 0 || !acct) return false;
                return (
                    acct.systemAccountTag === 'CUSTOMER_DEPOSITS' ||
                    acct.accountCode === '2200'
                );
            });

            if (!hasDebitUndepositedFunds) {
                throw new PostingGovernanceError(
                    `PAYMENT_RECEIPT must debit Undeposited Funds (tag: UNDEPOSITED_FUNDS). ` +
                    `Payments must flow through the clearing account before reaching the bank.`,
                    'GOV_RULE_E_RECEIPT_STRUCTURE',
                    { source }
                );
            }
            if (!hasCreditAR && !hasCreditCustomerDeposits) {
                throw new PostingGovernanceError(
                    `PAYMENT_RECEIPT must credit Accounts Receivable (tag: ACCOUNTS_RECEIVABLE) ` +
                    `or Customer Deposits (2200). Invoice payments reduce AR; advances increase deposit liability.`,
                    'GOV_RULE_E_RECEIPT_STRUCTURE',
                    { source }
                );
            }
        }

        if (source === 'TILL_RECEIPT') {
            const hasDebitTillCash = lines.some((l) => {
                const acct = findAccount(accounts, l.accountCode);
                return (
                    l.debitAmount > 0 &&
                    acct?.accountCode === '1010' &&
                    acct.systemAccountTag === 'CASH'
                );
            });
            const hasCreditAR = lines.some((l) => {
                const acct = findAccount(accounts, l.accountCode);
                return l.creditAmount > 0 && acct?.systemAccountTag === 'ACCOUNTS_RECEIVABLE';
            });
            const hasUndepositedDebit = lines.some((l) => {
                const acct = findAccount(accounts, l.accountCode);
                return l.debitAmount > 0 && acct?.systemAccountTag === 'UNDEPOSITED_FUNDS';
            });
            if (!hasDebitTillCash || !hasCreditAR || hasUndepositedDebit) {
                throw new PostingGovernanceError(
                    `TILL_RECEIPT must debit Cash Drawer 1010 and credit Accounts Receivable. ` +
                    `Till collections must not debit Undeposited Funds (1015).`,
                    'GOV_RULE_E_TILL_RECEIPT_STRUCTURE',
                    { source }
                );
            }
        }

        // Apply customer deposit (prepayment) to a sale/invoice:
        //   DR Customer Deposits (2200)  — release liability
        //   CR Accounts Receivable       — clear AR from the sale
        // Cash already recognized when deposit was taken (PAYMENT_RECEIPT → Undeposited Funds).
        if (source === 'DEPOSIT_APPLICATION') {
            const hasDebitCustomerDeposits = lines.some((l) => {
                const acct = findAccount(accounts, l.accountCode);
                if (l.debitAmount <= 0 || !acct) return false;
                return (
                    acct.systemAccountTag === 'CUSTOMER_DEPOSITS' ||
                    acct.accountCode === '2200'
                );
            });
            const hasCreditAR = lines.some((l) => {
                const acct = findAccount(accounts, l.accountCode);
                return l.creditAmount > 0 && acct?.systemAccountTag === 'ACCOUNTS_RECEIVABLE';
            });

            if (!hasDebitCustomerDeposits || !hasCreditAR) {
                throw new PostingGovernanceError(
                    `DEPOSIT_APPLICATION must debit Customer Deposits (2200) and credit Accounts Receivable. ` +
                    `This clears prepayment liability against sale AR — it is not a cash receipt.`,
                    'GOV_RULE_E_DEPOSIT_APPLICATION_STRUCTURE',
                    { source }
                );
            }
        }

        if (source === 'PAYMENT_DEPOSIT' || source === 'TREASURY_DEPOSIT') {
            const hasDebitCashOrBank = lines.some((l) => {
                const acct = findAccount(accounts, l.accountCode);
                if (l.debitAmount <= 0 || !acct) return false;
                // Any liquidity destination: till, bank books, MoMo, petty cash, card clearing.
                // Extra bank GLs (1031/1032/…) must carry SystemAccountTag BANK (set on bank-account link).
                return (
                    acct.systemAccountTag === 'CASH' ||
                    acct.systemAccountTag === 'BANK' ||
                    acct.systemAccountTag === 'MOBILE_MONEY' ||
                    acct.systemAccountTag === 'PETTY_CASH' ||
                    acct.systemAccountTag === 'CARD_CLEARING' ||
                    acct.accountCode === '1010' ||
                    acct.accountCode === '1030'
                );
            });
            const hasCreditUndeposited = lines.some((l) => {
                const acct = findAccount(accounts, l.accountCode);
                return (
                    l.creditAmount > 0 &&
                    (acct?.systemAccountTag === 'UNDEPOSITED_FUNDS' || acct?.accountCode === '1015')
                );
            });

            if (!hasDebitCashOrBank) {
                throw new PostingGovernanceError(
                    `${source} must debit a Cash/Bank account. ` +
                    `Bank deposit moves money from Undeposited Funds to Cash/Bank.`,
                    'GOV_RULE_E_DEPOSIT_STRUCTURE',
                    { source }
                );
            }
            if (!hasCreditUndeposited) {
                throw new PostingGovernanceError(
                    `${source} must credit Undeposited Funds (1015). ` +
                    `Bank deposit clears the Undeposited Funds balance.`,
                    'GOV_RULE_E_DEPOSIT_STRUCTURE',
                    { source }
                );
            }
        }

        // ------------------------------------------------------------------
        // Rule F: COGS-tagged account can only be touched by INVENTORY_MOVE or SALES_INVOICE
        // ------------------------------------------------------------------
        for (const line of lines) {
            if (line.debitAmount > 0 || line.creditAmount > 0) {
                const account = findAccount(accounts, line.accountCode);
                if (account?.systemAccountTag === 'COGS') {
                    if (source !== 'INVENTORY_MOVE' && source !== 'SALES_INVOICE' && source !== 'SALES_REFUND' && source !== 'SYSTEM_CORRECTION') {
                        throw new PostingGovernanceError(
                            `Account ${account.accountCode} (${account.accountName}) is the Cost of Goods Sold account. ` +
                            `Only inventory movements (INVENTORY_MOVE, SALES_INVOICE, SALES_REFUND) may post to COGS. ` +
                            `Received source: '${source}'.`,
                            'GOV_RULE_F_COGS_RESTRICTED',
                            { accountCode: account.accountCode, source }
                        );
                    }
                }
            }
        }

        // ------------------------------------------------------------------
        // Rule G: Opening Balance Equity — only via OPENING_BALANCE_WIZARD
        //         (prevents manual back-door entries to equity)
        // ------------------------------------------------------------------
        for (const line of lines) {
            if (line.debitAmount > 0 || line.creditAmount > 0) {
                const account = findAccount(accounts, line.accountCode);
                if (account?.systemAccountTag === 'OPENING_BALANCE_EQUITY') {
                    if (
                        source !== 'OPENING_BALANCE_WIZARD' &&
                        source !== 'CUTOVER_OB' &&
                        source !== 'CUTOVER_CORRECTION' &&
                        source !== 'SYSTEM_CORRECTION'
                    ) {
                        throw new PostingGovernanceError(
                            `Account ${account.accountCode} (${account.accountName}) is the Opening Balance Equity account. ` +
                            `It can only be posted via the Opening Balance Wizard (OPENING_BALANCE_WIZARD), ` +
                            `a cutover entry (CUTOVER_OB, CUTOVER_CORRECTION), or system correction. ` +
                            `Received source: '${source}'.`,
                            'GOV_RULE_G_OBE_RESTRICTED',
                            { accountCode: account.accountCode, source }
                        );
                    }
                }
            }
        }

        // ------------------------------------------------------------------
        // Rule H: Inventory (tag = 'INVENTORY') — SAP-STRICT single source.
        //
        //   Any account tagged 'INVENTORY' (canonically 1300) may be posted
        //   to ONLY via the inventory movement engine (INVENTORY_MOVE),
        //   an auditor-controlled SYSTEM_CORRECTION, or the initial
        //   OPENING_BALANCE_WIZARD data load.
        //
        //   This defends the Inventory ↔ GL integrity invariant:
        //     SUM(cost_layers.remaining_quantity * unit_cost) == GL 1300
        //
        //   If a journal from any other source (SALES_INVOICE, PURCHASE_BILL,
        //   MANUAL_JOURNAL, etc.) attempts to touch 1300, throw immediately
        //   — this is a defense-in-depth check that runs even if an
        //   operator loosens the AllowedSources array in the DB.
        // ------------------------------------------------------------------
        const INVENTORY_ALLOWED_SOURCES: PostingSource[] = [
            'INVENTORY_MOVE',
            'SYSTEM_CORRECTION',
            'OPENING_BALANCE_WIZARD',
        ];
        for (const line of lines) {
            if (line.debitAmount > 0 || line.creditAmount > 0) {
                const account = findAccount(accounts, line.accountCode);
                if (account?.systemAccountTag === 'INVENTORY') {
                    if (!INVENTORY_ALLOWED_SOURCES.includes(source)) {
                        throw new PostingGovernanceError(
                            `Account ${account.accountCode} (${account.accountName}) is SAP-controlled Inventory. ` +
                            `Only the inventory movement engine (INVENTORY_MOVE), SYSTEM_CORRECTION, ` +
                            `or OPENING_BALANCE_WIZARD may post to it. Received source: '${source}'. ` +
                            `If this is a sale/GR/return flow, route the inventory leg through the ` +
                            `INVENTORY_MOVE engine instead of bundling it into a business-document journal.`,
                            'GOV_RULE_H_INVENTORY_STRICT',
                            { accountCode: account.accountCode, source }
                        );
                    }
                    if (
                        source === 'SYSTEM_CORRECTION' &&
                        !isApprovedInventoryDriftHealKey(idempotencyKey)
                    ) {
                        throw new PostingGovernanceError(
                            `SYSTEM_CORRECTION cannot post to Inventory (1300) except via the ` +
                            `approved inventory drift heal workflow (idempotency key INV-GL-DRIFT-HEAL-YYYY-MM-DD). ` +
                            `Received key: '${idempotencyKey ?? '(none)'}'.`,
                            'GOV_RULE_H_INVENTORY_HEAL_ONLY',
                            { accountCode: account.accountCode, idempotencyKey },
                        );
                    }
                }
            }
        }
    }

    // ===========================================================================
    // DB HELPER — load governance accounts for a set of account codes
    // ===========================================================================

    /**
     * Fetch GovernanceAccount data for a set of account codes.
     * Used by callers that need to pre-load accounts before calling validate().
     */
    static async fetchGovernanceAccounts(
        client: pg.PoolClient,
        accountCodes: string[]
    ): Promise<GovernanceAccount[]> {
        if (accountCodes.length === 0) return [];

        const placeholders = accountCodes.map((_, i) => `$${i + 1}`).join(', ');
        const result = await client.query<{
            Id: string;
            AccountCode: string;
            AccountName: string;
            AccountType: string;
            NormalBalance: string;
            IsPostingAccount: boolean;
            IsActive: boolean;
            AllowManualPosting: boolean;
            AllowedSources: string[] | null;
            SystemAccountTag: string | null;
        }>(
            `SELECT
        "Id", "AccountCode", "AccountName", "AccountType", "NormalBalance",
        "IsPostingAccount", "IsActive",
        "AllowManualPosting", "AllowedSources", "SystemAccountTag"
       FROM accounts
       WHERE "AccountCode" = ANY(ARRAY[${placeholders}])`,
            accountCodes
        );

        return result.rows.map((row) => ({
            id: row.Id,
            accountCode: row.AccountCode,
            accountName: row.AccountName,
            accountType: row.AccountType as GovernanceAccount['accountType'],
            normalBalance: row.NormalBalance as 'DEBIT' | 'CREDIT',
            isPostingAccount: row.IsPostingAccount,
            isActive: row.IsActive,
            allowManualPosting: row.AllowManualPosting ?? true,
            allowedSources: (row.AllowedSources ?? []) as PostingSource[],
            systemAccountTag: row.SystemAccountTag,
        }));
    }
}
