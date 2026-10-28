/**
 * ACCOUNTING CORE SERVICE
 *
 * SINGLE SOURCE OF TRUTH for all accounting operations.
 * Implements enterprise-grade accounting principles.
 *
 * DESIGN PRINCIPLES:
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * 🎯 DETERMINISTIC ACCOUNTING
 *    - Same inputs ALWAYS produce same outputs
 *    - No random values, timestamps from parameters only
 *    - Reproducible calculations
 *
 * 📊 DOUBLE-ENTRY ENFORCEMENT
 *    - Every transaction MUST balance (Debits = Credits)
 *    - Validation before ANY database write
 *    - Rejected transactions throw, never silently fail
 *
 * 🔒 IMMUTABILITY OF POSTED TRANSACTIONS
 *    - POSTED entries cannot be modified
 *    - Only DRAFT entries can be edited
 *    - Changes require reversing entries
 *
 * 🔄 IDEMPOTENT OPERATIONS
 *    - Same operation with same key produces same result
 *    - Idempotency keys prevent duplicate entries
 *    - Safe to retry failed operations
 *
 * 📅 PERIOD LOCKING
 *    - Closed periods reject new transactions
 *    - Period must be OPEN to post entries
 *    - Prevents backdating to locked periods
 *
 * ↩️ REVERSAL INSTEAD OF MUTATION
 *    - Errors corrected via reversing entries
 *    - Original entry preserved for audit
 *    - Clear correction trail
 *
 * 📝 AUDIT-SAFE DESIGN
 *    - All actions logged with user/timestamp
 *    - Full audit trail for every entry
 *    - Source entity tracking
 *
 * 💾 SOURCE-OF-TRUTH ENFORCEMENT
 *    - Database is the authority
 *    - No in-memory calculations that bypass DB
 *    - Balances computed from transactions
 *
 * ⚡ NO SIDE-EFFECTS OUTSIDE TRANSACTIONS
 *    - All changes within DB transactions
 *    - Atomic commit or rollback
 *    - Consistent state guaranteed
 *
 * 💰 DECIMAL-SAFE CALCULATIONS
 *    - Uses Decimal.js for all monetary math
 *    - No floating-point arithmetic
 *    - Consistent ROUND_HALF_UP rounding
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 */

import { pool as globalPool } from '../db/pool.js';
import type pg from 'pg';
import { PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { Money, Decimal } from '../utils/money.js';
import { fiscalPartsFromIsoDate, safeParseInt } from '../utils/safeParse.js';
import logger from '../utils/logger.js';
import { UnitOfWork } from '../db/unitOfWork.js';
import {
    PostingGovernanceService,
    type PostingSource,
    type GovernanceJournalLine,
} from './postingGovernanceService.js';
import {
    rebuildSingleAccountPeriodOnClient,
    scheduleGlRebuildJobs,
} from './glPeriodRebuildService.js';
import { writeProjectionEvent, scheduleImmediateRebuild } from './periodBalanceWorker.js';
import {
    LEDGER_FISCAL_PERIOD_SQL,
    LEDGER_FISCAL_YEAR_SQL,
    LEDGER_NET_ACTIVE_SQL,
} from '../utils/ledgerNetActive.js';
import { ACTIVE_GL_REFERENCE_PREDICATE_BARE } from '../utils/activeGlReference.js';
import {
    availableFromPostedTotals,
    postedLedgerBalanceLateral,
} from '../modules/treasury/postedLedgerBalance.js';

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

export type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';
export type NormalBalance = 'DEBIT' | 'CREDIT';
export type TransactionStatus = 'DRAFT' | 'POSTED' | 'REVERSED';
export type PeriodStatus = 'OPEN' | 'CLOSED' | 'LOCKED';

export interface JournalLine {
    accountCode: string;
    description: string;
    debitAmount: number;
    creditAmount: number;
    entityType?: string;
    entityId?: string;
}

// Re-export PostingSource so callers only need this file
export type { PostingSource } from './postingGovernanceService.js';

export interface JournalEntryRequest {
    entryDate: string; // YYYY-MM-DD
    description: string;
    referenceType: string; // SALE, PURCHASE, EXPENSE, ADJUSTMENT, etc.
    referenceId: string;
    referenceNumber: string;
    lines: JournalLine[];
    userId: string;
    idempotencyKey: string;
    /**
     * Posting source — identifies which module/workflow is creating this entry.
     * Enforced by PostingGovernanceService before any DB write.
     * Defaults to 'MANUAL_JOURNAL' when omitted (most restrictive).
     */
    source?: PostingSource;
}

export interface JournalEntryResult {
    transactionId: string;
    transactionNumber: string;
    status: TransactionStatus;
    totalDebits: number;
    totalCredits: number;
}

export interface ReversalRequest {
    originalTransactionId: string;
    reversalDate: string;
    reason: string;
    userId: string;
    idempotencyKey: string;
}

export interface AccountBalance {
    accountId: string;
    accountCode: string;
    accountName: string;
    accountType: AccountType;
    normalBalance: NormalBalance;
    debitTotal: number;
    creditTotal: number;
    balance: number;
}

// =============================================================================
// ERROR CLASSES
// =============================================================================

export class AccountingError extends Error {
    constructor(
        message: string,
        public readonly code: string
    ) {
        super(message);
        this.name = 'AccountingError';
    }
}

export class DoubleEntryViolationError extends AccountingError {
    constructor(debits: number, credits: number) {
        super(
            `Double-entry violation: Debits (${debits}) ≠ Credits (${credits}). Difference: ${Math.abs(debits - credits)}`,
            'DOUBLE_ENTRY_VIOLATION'
        );
    }
}

export class PeriodLockedError extends AccountingError {
    constructor(date: string, periodStatus: string) {
        super(`Cannot post to ${periodStatus} period for date ${date}`, 'PERIOD_LOCKED');
    }
}

export class ImmutabilityViolationError extends AccountingError {
    constructor(transactionId: string, status: string) {
        super(
            `Cannot modify ${status} transaction ${transactionId}. Use reversal instead.`,
            'IMMUTABILITY_VIOLATION'
        );
    }
}

export class IdempotencyConflictError extends AccountingError {
    constructor(key: string, existingTransactionId: string) {
        super(
            `Idempotency key "${key}" already used for transaction ${existingTransactionId}`,
            'IDEMPOTENCY_CONFLICT'
        );
    }
}

export class AccountNotFoundError extends AccountingError {
    constructor(accountCode: string) {
        super(`Account not found: ${accountCode}`, 'ACCOUNT_NOT_FOUND');
    }
}

// =============================================================================
// ACCOUNTING CORE SERVICE
// =============================================================================

export class AccountingCore {
    private static readonly BALANCE_TOLERANCE = 0.001; // Allow for tiny rounding differences

    // ===========================================================================
    // PERIOD MANAGEMENT
    // ===========================================================================

    /**
     * Check if a period is open for posting
     * DETERMINISTIC: Same date always returns same period status
     */
    static async isPeriodOpen(client: PoolClient, date: string): Promise<boolean> {
        const result = await client.query(
            `
      SELECT "Status" as status
      FROM financial_periods
      WHERE $1 BETWEEN start_date AND end_date
      LIMIT 1
    `,
            [date]
        );

        // If no period defined, allow posting (implicit open)
        if (result.rows.length === 0) {
            return true;
        }

        return result.rows[0].status === 'OPEN';
    }

    /**
     * Get period status for a date
     */
    static async getPeriodStatus(client: PoolClient, date: string): Promise<PeriodStatus | null> {
        const result = await client.query(
            `
      SELECT "Status" as status
      FROM financial_periods
      WHERE $1 BETWEEN start_date AND end_date
      LIMIT 1
    `,
            [date]
        );

        return result.rows[0]?.status || null;
    }

    /**
    /**
     * Lock a financial period
     * Prevents any new transactions in that period
     */
    static async lockPeriod(periodId: string, userId: string, dbPool?: pg.Pool): Promise<void> {
        const pool = dbPool || globalPool;
        return UnitOfWork.run(pool, async (client) => {
            // Check current status
            const current = await client.query(
                `
        SELECT "Status" as status FROM financial_periods WHERE "Id" = $1
      `,
                [periodId]
            );

            if (current.rows.length === 0) {
                throw new AccountingError('Period not found', 'PERIOD_NOT_FOUND');
            }

            if (current.rows[0].status === 'LOCKED') {
                throw new AccountingError('Period is already locked', 'ALREADY_LOCKED');
            }

            // Lock the period
            await client.query(
                `
        UPDATE financial_periods
        SET "Status" = 'LOCKED',
            "LockedAt" = NOW(),
            "LockedBy" = $2
        WHERE "Id" = $1
      `,
                [periodId, userId]
            );

            // Log the action
            await client.query(
                `
        INSERT INTO audit_log (id, action, entity_type, entity_id, user_id, action_details)
        VALUES ($1, 'UPDATE', 'SETTINGS', $2, $3, $4)
      `,
                [uuidv4(), periodId, userId, JSON.stringify({ action: 'Period locked' })]
            );

            logger.info('Financial period locked', { periodId, userId });
        });
    }

    // ===========================================================================
    // IDEMPOTENCY ENFORCEMENT
    // ===========================================================================

    /**
     * Check if an idempotency key has been used
     * Returns the existing transaction ID if already processed
     */
    static async checkIdempotencyKey(
        client: PoolClient,
        key: string
    ): Promise<{ exists: boolean; transactionId?: string }> {
        const result = await client.query(
            `
      SELECT "Id" as "transactionId"
      FROM ledger_transactions
      WHERE "IdempotencyKey" = $1
        AND "IsReversed" = FALSE
        AND "Status" = 'POSTED'
      LIMIT 1
    `,
            [key]
        );

        if (result.rows.length > 0) {
            return { exists: true, transactionId: result.rows[0].transactionId };
        }
        return { exists: false };
    }

    /**
     * Fail-closed check after writing a journal: header totals equal the sum of DebitAmount/CreditAmount,
     * and every line's Amount equals DebitAmount + CreditAmount.
     * TXN-002362 (Henber, Option A) is a historical exception of this class; new journals must not repeat it.
     */
    static async assertWrittenJournalMatchesHeader(client: PoolClient, transactionId: string): Promise<void> {
        const result = await client.query<{
            hdr_dr: string; hdr_cr: string; ent_dr: string; ent_cr: string; bad_amt: string;
        }>(
            `SELECT round(lt."TotalDebitAmount",2)::text hdr_dr, round(lt."TotalCreditAmount",2)::text hdr_cr,
                    round(sum(le."DebitAmount"),2)::text ent_dr, round(sum(le."CreditAmount"),2)::text ent_cr,
                    count(*) FILTER (WHERE le."Amount" <> le."DebitAmount" + le."CreditAmount")::text bad_amt
               FROM ledger_transactions lt
               JOIN ledger_entries le ON le."TransactionId" = lt."Id"
              WHERE lt."Id" = $1
              GROUP BY lt."Id"`,
            [transactionId],
        );
        const row = result.rows[0];
        if (!row) {
            throw new AccountingError('Posted journal has no entries', 'HEADER_ENTRY_MISMATCH');
        }
        if (row.hdr_dr !== row.ent_dr || row.hdr_cr !== row.ent_cr || row.bad_amt !== '0') {
            throw new AccountingError(
                `Posted journal header/Amount does not match entries (hdr ${row.hdr_dr}/${row.hdr_cr} vs entries ${row.ent_dr}/${row.ent_cr}, amount-column mismatches ${row.bad_amt})`,
                'HEADER_ENTRY_MISMATCH',
            );
        }
    }

    // ===========================================================================
    // DOUBLE-ENTRY VALIDATION
    // ===========================================================================

    /**
     * Validate that journal lines balance (Debits = Credits)
     * DETERMINISTIC: Pure function, no side effects
     */
    static validateDoubleEntry(lines: JournalLine[]): {
        isValid: boolean;
        totalDebits: number;
        totalCredits: number;
        difference: number;
    } {
        let totalDebits = Money.zero();
        let totalCredits = Money.zero();

        for (const line of lines) {
            totalDebits = Money.add(totalDebits, line.debitAmount);
            totalCredits = Money.add(totalCredits, line.creditAmount);
        }

        const difference = Money.abs(Money.subtract(totalDebits, totalCredits));
        const isValid = difference.lessThan(this.BALANCE_TOLERANCE);

        return {
            isValid,
            totalDebits: totalDebits.toNumber(),
            totalCredits: totalCredits.toNumber(),
            difference: difference.toNumber(),
        };
    }

    /**
     * Validate a line has either debit OR credit (not both, not neither)
     */
    static validateLineAmounts(line: JournalLine): boolean {
        const hasDebit = line.debitAmount > 0;
        const hasCredit = line.creditAmount > 0;

        // Must have exactly one: debit XOR credit
        return (hasDebit || hasCredit) && !(hasDebit && hasCredit);
    }

    // ===========================================================================
    // CORE JOURNAL ENTRY OPERATIONS
    // ===========================================================================

    /**
     * Create a new journal entry (ledger transaction)
     *
     * GUARANTEES:
     * - Double-entry balanced
     * - Period is open
     * - Idempotency enforced
     * - Atomic transaction
     * - Full audit trail
     */
    static async createJournalEntry(
        request: JournalEntryRequest,
        dbPool?: pg.Pool,
        /**
         * Optional transactional PoolClient. When provided, the journal entry
         * is created inside the CALLER's transaction (SAP LUW pattern) —
         * inventory changes and GL posting commit or rollback atomically.
         * When omitted, the method opens its own UnitOfWork transaction
         * (backward-compatible default).
         */
        txClient?: pg.PoolClient,
    ): Promise<JournalEntryResult> {
        // 1. Validate double-entry BEFORE touching database
        const validation = this.validateDoubleEntry(request.lines);
        if (!validation.isValid) {
            throw new DoubleEntryViolationError(validation.totalDebits, validation.totalCredits);
        }

        // 2. Validate each line has proper amounts
        for (const line of request.lines) {
            if (!this.validateLineAmounts(line)) {
                throw new AccountingError(
                    `Invalid line for account ${line.accountCode}: must have either debit OR credit, not both or neither`,
                    'INVALID_LINE_AMOUNTS'
                );
            }
        }

        const pool = dbPool || globalPool;

        // Phase 3b: collect (accountId, year, period) for post-commit rebuild.
        // Populated only when LEGACY_GL_PERIOD_WRITES !== 'true' AND no txClient.
        const pendingRebuildJobs: Array<{ accountId: string; fiscalYear: number; fiscalPeriod: number }> = [];
        const txClientRebuildKeys = new Set<string>();

        // If caller provided a transactional client, execute directly (atomic with caller).
        // Otherwise, start our own UnitOfWork transaction (backward compatible).
        const doWork = async (client: pg.PoolClient): Promise<JournalEntryResult> => {
            // 3a. Posting Governance check — hard block, no warnings
            //     Must run BEFORE idempotency check so a bad request is always rejected.
            const governanceSource: PostingSource = request.source ?? 'MANUAL_JOURNAL';
            const uniqueCodes = [...new Set(request.lines.map((l) => l.accountCode))];
            const governanceAccounts = await PostingGovernanceService.fetchGovernanceAccounts(
                client,
                uniqueCodes
            );
            PostingGovernanceService.validate({
                source: governanceSource,
                lines: request.lines as GovernanceJournalLine[],
                accounts: governanceAccounts,
                idempotencyKey: request.idempotencyKey,
            });

            const { validateJournal } = await import(
                '../modules/accounting-governance/accountingJournalGovernance.js'
            );
            validateJournal({
                referenceType: request.referenceType,
                referenceId: request.referenceId,
                referenceNumber: request.referenceNumber,
                source: governanceSource,
                idempotencyKey: request.idempotencyKey,
                lines: request.lines,
            });

            // 3b. Check idempotency by key - return existing if already processed
            const idempotencyCheck = await this.checkIdempotencyKey(client, request.idempotencyKey);
            if (idempotencyCheck.exists) {
                // Fetch and return existing transaction (idempotent behavior)
                const existing = await this.getTransaction(idempotencyCheck.transactionId!, dbPool);
                if (existing) {
                    logger.info('Idempotent request - returning existing transaction', {
                        idempotencyKey: request.idempotencyKey,
                        existingTransactionId: idempotencyCheck.transactionId,
                    });
                    return existing;
                }

                throw new IdempotencyConflictError(
                    request.idempotencyKey,
                    idempotencyCheck.transactionId!
                );
            }

            // 3c. Second-layer duplicate guard: one active FI document per business reference.
            // Checks ReferenceType + ReferenceId first (canonical SAP key), then ReferenceNumber.
            // Only considers POSTED, non-reversed transactions — reversed docs may be reposted.
            const returnExistingByReference = async (
                whereSql: string,
                params: string[],
                logField: string,
                logValue: string,
            ): Promise<JournalEntryResult | null> => {
                const refCheck = await client.query<{ Id: string }>(
                    `SELECT "Id" FROM ledger_transactions
                     WHERE ${whereSql}
                       AND ${ACTIVE_GL_REFERENCE_PREDICATE_BARE}
                     LIMIT 1`,
                    params,
                );
                if (refCheck.rows.length === 0) return null;
                const existingById = await this.getTransaction(refCheck.rows[0].Id, dbPool);
                if (!existingById) return null;
                logger.warn(
                    'Duplicate GL posting blocked by reference check (different idempotency key). ' +
                    'This indicates a code path that bypassed the primary idempotency guard.',
                    {
                        referenceType: request.referenceType,
                        [logField]: logValue,
                        idempotencyKey: request.idempotencyKey,
                        existingTransactionId: refCheck.rows[0].Id,
                    },
                );
                return existingById;
            };

            if (request.referenceType && request.referenceId) {
                const existing = await returnExistingByReference(
                    `"ReferenceType" = $1 AND "ReferenceId" = $2`,
                    [request.referenceType, request.referenceId],
                    'referenceId',
                    request.referenceId,
                );
                if (existing) return existing;
            }

            if (request.referenceType && request.referenceNumber) {
                const existing = await returnExistingByReference(
                    `"ReferenceType" = $1 AND "ReferenceNumber" = $2`,
                    [request.referenceType, request.referenceNumber],
                    'referenceNumber',
                    request.referenceNumber,
                );
                if (existing) return existing;
            }

            // 4. Check period is open
            const periodOpen = await this.isPeriodOpen(client, request.entryDate);
            if (!periodOpen) {
                const periodStatus = await this.getPeriodStatus(client, request.entryDate);
                throw new PeriodLockedError(request.entryDate, periodStatus || 'UNKNOWN');
            }

            // 5. Serialize transaction number allocation within the current DB transaction.
            // This prevents two concurrent journal entries from both reading the same MAX()
            // and generating duplicate TXN- numbers.
            await client.query(`
        SELECT pg_advisory_xact_lock(hashtext('ledger_transactions.transaction_number'))
      `);

            // 6. Generate transaction number (sequential under advisory lock)
            const countResult = await client.query(`
        SELECT COALESCE(MAX(CAST(SUBSTRING("TransactionNumber" FROM 5) AS INTEGER)), 0) + 1 as next_num 
        FROM ledger_transactions
        WHERE "TransactionNumber" ~ '^TXN-[0-9]+$'
      `);
            const nextNum = safeParseInt(countResult.rows[0].next_num, 1);
            const transactionNumber = `TXN-${String(nextNum).padStart(6, '0')}`;
            const transactionId = uuidv4();

            // 7. Create transaction header
            await client.query(
                `
        INSERT INTO ledger_transactions (
          "Id", "TransactionNumber", "TransactionDate", "ReferenceType",
          "ReferenceId", "ReferenceNumber", "Description",
          "TotalDebitAmount", "TotalCreditAmount", "Status",
          "IdempotencyKey", "CreatedBy", "CreatedAt", "UpdatedAt", "IsReversed"
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'POSTED', $10, $11, NOW(), NOW(), FALSE)
      `,
                [
                    transactionId,
                    transactionNumber,
                    request.entryDate,
                    request.referenceType,
                    request.referenceId,
                    request.referenceNumber,
                    request.description,
                    validation.totalDebits,
                    validation.totalCredits,
                    request.idempotencyKey,
                    request.userId,
                ]
            );

            // Stamp the PostingSource on ledger_transactions for audit
            await client.query(
                `UPDATE ledger_transactions SET "PostingSource" = $2 WHERE "Id" = $1`,
                [transactionId, governanceSource]
            );

            // 8. Create ledger entries
            let lineNumber = 1;
            for (const line of request.lines) {
                // Resolve account
                const accountResult = await client.query(
                    `
          SELECT "Id", "AccountName", "NormalBalance"
          FROM accounts 
          WHERE "AccountCode" = $1 AND "IsActive" = true
        `,
                    [line.accountCode]
                );

                if (accountResult.rows.length === 0) {
                    throw new AccountNotFoundError(line.accountCode);
                }

                const account = accountResult.rows[0];
                const entryId = uuidv4();
                const entryType = line.debitAmount > 0 ? 'DEBIT' : 'CREDIT';
                const amount = line.debitAmount > 0 ? line.debitAmount : line.creditAmount;

                await client.query(
                    `
          INSERT INTO ledger_entries (
            "Id", "TransactionId", "LedgerTransactionId", "AccountId", "EntryType", "Amount",
            "DebitAmount", "CreditAmount", "Description", "LineNumber",
            "EntityType", "EntityId", "EntryDate", "CreatedAt"
          ) VALUES ($1, $2, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
        `,
                    [
                        entryId,
                        transactionId,
                        account.Id,
                        entryType,
                        amount,
                        line.debitAmount,
                        line.creditAmount,
                        line.description,
                        lineNumber++,
                        line.entityType || null,
                        line.entityId || null,
                        request.entryDate,
                    ]
                );

                // 9. Update account running balance
                const balanceChange =
                    account.NormalBalance === 'DEBIT'
                        ? Money.subtract(line.debitAmount, line.creditAmount).toNumber()
                        : Money.subtract(line.creditAmount, line.debitAmount).toNumber();

                await client.query(
                    `
          UPDATE accounts
          SET "CurrentBalance" = "CurrentBalance" + $2,
              "UpdatedAt" = NOW()
          WHERE "Id" = $1
        `,
                    [account.Id, balanceChange]
                );

                // 9b. UPSERT gl_period_balances (SAP FAGLFLEXT pattern)
                //     Runs inside the SAME transaction — atomic with ledger entry.
                //     Defense-in-depth: isPeriodOpen() already gates this function,
                //     but the WHERE clause below provides a DB-level safety net.
                const entryYear = parseInt(request.entryDate.substring(0, 4), 10);
                const entryMonth = parseInt(request.entryDate.substring(5, 7), 10);

                if (process.env.LEGACY_GL_PERIOD_WRITES === 'true') {
                    // LEGACY escape hatch: inline incremental UPSERT (set env var to revert).
                    const upsertResult = await client.query(
                        `INSERT INTO gl_period_balances
                            (account_id, fiscal_year, fiscal_period, debit_total, credit_total, running_balance, last_updated)
                         SELECT $1, $2, $3, $4::numeric, $5::numeric, $4::numeric - $5::numeric, NOW()
                         WHERE NOT EXISTS (
                           SELECT 1 FROM financial_periods
                           WHERE period_year = $2 AND period_month = $3
                             AND "Status" IN ('CLOSED', 'LOCKED')
                         )
                         ON CONFLICT (account_id, fiscal_year, fiscal_period)
                         DO UPDATE SET
                            debit_total     = gl_period_balances.debit_total   + EXCLUDED.debit_total,
                            credit_total    = gl_period_balances.credit_total  + EXCLUDED.credit_total,
                            running_balance = (gl_period_balances.debit_total + EXCLUDED.debit_total) - (gl_period_balances.credit_total + EXCLUDED.credit_total),
                            last_updated    = NOW()`,
                        [account.Id, entryYear, entryMonth, line.debitAmount, line.creditAmount]
                    );
                    if (upsertResult.rowCount === 0) {
                        throw new PeriodLockedError(request.entryDate, 'LOCKED');
                    }
                } else if (txClient) {
                    // Deferred: recompute from net-active ledger after all lines are written.
                    txClientRebuildKeys.add(`${account.Id}|${entryYear}|${entryMonth}`);
                } else {
                    // Phase 3b path: write durable outbox event INSIDE this transaction
                    // (outbox pattern — commits atomically with the ledger entry).
                    // The setImmediate fast path fires after commit for immediate projection.
                    // The durable event guarantees delivery even on process crash.
                    await writeProjectionEvent(
                        client,
                        account.Id,
                        entryYear,
                        entryMonth,
                        transactionId,
                        request.idempotencyKey,
                    );
                    pendingRebuildJobs.push({ accountId: account.Id, fiscalYear: entryYear, fiscalPeriod: entryMonth });
                }

                // 9c. PHASE 3a SHADOW VERIFY
                //     Set GL_PERIOD_BALANCES_SHADOW_VERIFY=true to enable.
                //     READ-ONLY: never throws, never blocks the transaction.
                //     Compares the gl_period_balances row we just wrote against
                //     the ledger_entries SUM for the same account+period.
                //     Logs warnings so drift can be observed before removing
                //     the inline UPSERTs in Phase 3b.
                if (process.env.GL_PERIOD_BALANCES_SHADOW_VERIFY === 'true') {
                    try {
                        const vr = await client.query<{
                            le_debits: string; le_credits: string;
                            gpb_debits: string; gpb_credits: string;
                        }>(
                            `SELECT
                               COALESCE(SUM(le."DebitAmount"), 0)  AS le_debits,
                               COALESCE(SUM(le."CreditAmount"), 0) AS le_credits,
                               MAX(gpb.debit_total)                AS gpb_debits,
                               MAX(gpb.credit_total)               AS gpb_credits
                             FROM ledger_entries le
                             JOIN ledger_transactions lt ON lt."Id" = le."TransactionId"
                             LEFT JOIN gl_period_balances gpb
                               ON gpb.account_id = le."AccountId"
                               AND gpb.fiscal_year  = $2
                               AND gpb.fiscal_period = $3
                             WHERE le."AccountId" = $1
                               AND ${LEDGER_FISCAL_YEAR_SQL} = $2
                               AND ${LEDGER_FISCAL_PERIOD_SQL} = $3
                               AND ${LEDGER_NET_ACTIVE_SQL}`,
                            [account.Id, entryYear, entryMonth]
                        );
                        const vRow = vr.rows[0];
                        const leD = new Decimal(vRow?.le_debits ?? 0);
                        const leC = new Decimal(vRow?.le_credits ?? 0);
                        const gpbD = new Decimal(vRow?.gpb_debits ?? 0);
                        const gpbC = new Decimal(vRow?.gpb_credits ?? 0);
                        const driftD = leD.minus(gpbD).abs();
                        const driftC = leC.minus(gpbC).abs();
                        if (driftD.greaterThan('0.01') || driftC.greaterThan('0.01')) {
                            logger.warn('[PHASE3a] gl_period_balances drift after postTransaction', {
                                accountId: account.Id,
                                fiscalYear: entryYear,
                                fiscalPeriod: entryMonth,
                                ledgerDebits: leD.toFixed(2),
                                ledgerCredits: leC.toFixed(2),
                                gpbDebits: gpbD.toFixed(2),
                                gpbCredits: gpbC.toFixed(2),
                                debitDrift: driftD.toFixed(2),
                                creditDrift: driftC.toFixed(2),
                                transactionId,
                                transactionNumber,
                            });
                        }
                    } catch (verifyErr) {
                        logger.warn('[PHASE3a] gl_period_balances shadow verify error (non-fatal)', {
                            accountId: account.Id,
                            error: verifyErr instanceof Error ? verifyErr.message : String(verifyErr),
                        });
                    }
                }
            }

            await this.assertWrittenJournalMatchesHeader(client, transactionId);

            // 10. Create audit log entry
            await client.query(
                `
        INSERT INTO audit_log (id, action, entity_type, entity_id, user_id, action_details)
        VALUES ($1, 'CREATE', 'SYSTEM', $2, $3, $4)
      `,
                [
                    uuidv4(),
                    transactionId,
                    request.userId,
                    JSON.stringify({
                        transactionNumber,
                        referenceType: request.referenceType,
                        referenceNumber: request.referenceNumber,
                        totalDebits: validation.totalDebits,
                        totalCredits: validation.totalCredits,
                        lineCount: request.lines.length,
                    }),
                ]
            );

            // txClient path: recompute gl_period_balances from net-active ledger (same as async rebuild).
            if (txClient && txClientRebuildKeys.size > 0) {
                for (const key of txClientRebuildKeys) {
                    const [accountId, yearStr, periodStr] = key.split('|');
                    await rebuildSingleAccountPeriodOnClient(
                        client,
                        accountId,
                        parseInt(yearStr, 10),
                        parseInt(periodStr, 10),
                    );
                }
            }

            // Service-layer AP governance (no triggers): snap account caches + supplier master.
            const { afterJournalEntryGovernance } = await import(
                '../modules/supplier-payments/apBalanceGovernance.js'
            );
            await afterJournalEntryGovernance(
                client,
                request.lines.map((l) => ({
                    accountCode: l.accountCode,
                    entityType: l.entityType ?? null,
                    entityId: l.entityId ?? null,
                })),
            );

            logger.info('Journal entry created', {
                transactionId,
                transactionNumber,
                referenceNumber: request.referenceNumber,
                totalDebits: validation.totalDebits,
                totalCredits: validation.totalCredits,
            });

            return {
                transactionId,
                transactionNumber,
                status: 'POSTED',
                totalDebits: validation.totalDebits,
                totalCredits: validation.totalCredits,
            };
        };

        let journalResult: JournalEntryResult;
        try {
            if (txClient) {
                // Atomic with caller's transaction (SAP LUW pattern)
                journalResult = await doWork(txClient);
            } else {
                // Backward-compatible: own transaction
                journalResult = await UnitOfWork.run(pool, doWork);
            }
        } catch (error) {
            logger.error('Failed to create journal entry', {
                error,
                referenceNumber: request.referenceNumber,
                idempotencyKey: request.idempotencyKey,
            });
            throw error;
        }

        // Phase 3b: schedule post-commit rebuild for own-transaction path.
        // txClient callers already wrote absolute values inside the txClient (above).
        // Two-path strategy:
        //   1. scheduleGlRebuildJobs  — setImmediate fast path (usually fires < 5ms after response)
        //   2. scheduleImmediateRebuild — polls gl_projection_events outbox (durable safety net)
        // The outbox events were already committed to the DB inside the transaction above,
        // so even if both async calls are skipped (process crash), the events remain PENDING
        // and will be picked up by the next Bull gl_events cycle.
        if (!txClient && pendingRebuildJobs.length > 0) {
            scheduleGlRebuildJobs(pendingRebuildJobs, pool);
            scheduleImmediateRebuild(pool);
        }

        return journalResult;
    }

    // ===========================================================================
    // REVERSAL OPERATIONS (No Mutation)
    // ===========================================================================

    /**
     * Reverse a posted transaction
     * Creates a new reversing entry with opposite amounts
     *
     * IMMUTABILITY: Original transaction is never modified
     */
    static async reverseTransaction(
        request: ReversalRequest,
        dbPool?: pg.Pool,
        /**
         * Optional transactional PoolClient. When provided, the reversal runs
         * inside the CALLER's transaction (SAP LUW pattern) — sale void and
         * GL reversal commit or rollback atomically.
         * When omitted, the method opens its own UnitOfWork transaction
         * (backward-compatible default).
         */
        txClient?: pg.PoolClient,
    ): Promise<JournalEntryResult> {
        const pool = dbPool || globalPool;

        // Phase 3b: collect (accountId, year, period) for post-commit rebuild.
        const pendingReversalRebuildJobs: Array<{ accountId: string; fiscalYear: number; fiscalPeriod: number }> = [];
        const txReversalRebuildKeys = new Set<string>();

        const doReversal = async (client: pg.PoolClient) => {
            // 1. Check idempotency
            const idempotencyCheck = await this.checkIdempotencyKey(client, request.idempotencyKey);
            if (idempotencyCheck.exists) {
                const existing = await this.getTransaction(idempotencyCheck.transactionId!, dbPool);
                if (existing) return existing;
                throw new IdempotencyConflictError(
                    request.idempotencyKey,
                    idempotencyCheck.transactionId!
                );
            }

            // 2. Get original transaction
            const originalResult = await client.query(
                `
        SELECT 
          lt."Id", lt."TransactionNumber", lt."TransactionDate", lt."Description", lt."Status",
          lt."ReferenceType", lt."ReferenceId", lt."ReferenceNumber"
        FROM ledger_transactions lt
        WHERE lt."Id" = $1
      `,
                [request.originalTransactionId]
            );

            if (originalResult.rows.length === 0) {
                throw new AccountingError('Original transaction not found', 'TRANSACTION_NOT_FOUND');
            }

            const original = originalResult.rows[0];
            const origDateStr =
                original.TransactionDate instanceof Date
                    ? original.TransactionDate.toISOString().slice(0, 10)
                    : String(original.TransactionDate).slice(0, 10);
            const { year: origYear, month: origMonth } = fiscalPartsFromIsoDate(
                origDateStr,
                'Original transaction date',
            );
            const { year: revYear, month: revMonth } = fiscalPartsFromIsoDate(
                request.reversalDate,
                'Reversal date',
            );

            if (original.Status === 'REVERSED') {
                throw new AccountingError('Transaction already reversed', 'ALREADY_REVERSED');
            }

            if (original.Status === 'DRAFT') {
                throw new AccountingError('Cannot reverse draft transaction', 'INVALID_STATUS');
            }

            // 3. Check period is open for reversal date
            const periodOpen = await this.isPeriodOpen(client, request.reversalDate);
            if (!periodOpen) {
                const periodStatus = await this.getPeriodStatus(client, request.reversalDate);
                throw new PeriodLockedError(request.reversalDate, periodStatus || 'UNKNOWN');
            }

            // 4. Get original entries
            const entriesResult = await client.query<{
                AccountId: string;
                DebitAmount: string;
                CreditAmount: string;
                Description: string;
                AccountCode: string;
                EntityType: string | null;
                EntityId: string | null;
            }>(
                `
        SELECT 
          le."AccountId", le."DebitAmount", le."CreditAmount", le."Description",
          le."EntityType", le."EntityId",
          a."AccountCode"
        FROM ledger_entries le
        JOIN accounts a ON le."AccountId" = a."Id"
        WHERE le."TransactionId" = $1
        ORDER BY le."LineNumber"
      `,
                [request.originalTransactionId]
            );

            // 5. Create reversed lines (swap debits and credits; preserve entity tags)
            const reversedLines: JournalLine[] = entriesResult.rows.map((entry) => ({
                accountCode: entry.AccountCode,
                description: `REVERSAL: ${entry.Description}`,
                debitAmount: Money.parseDb(entry.CreditAmount).toNumber(),
                creditAmount: Money.parseDb(entry.DebitAmount).toNumber(),
                entityType: entry.EntityType?.toLowerCase() as JournalLine['entityType'],
                entityId: entry.EntityId ?? undefined,
            }));

            // 6. Generate reversal transaction number
            const countResult = await client.query(`
        SELECT COALESCE(MAX(CAST(SUBSTRING("TransactionNumber" FROM 5) AS INTEGER)), 0) + 1 as next_num 
        FROM ledger_transactions
        WHERE "TransactionNumber" ~ '^TXN-[0-9]+$'
      `);
            const nextNum = safeParseInt(countResult.rows[0].next_num, 1);
            const transactionNumber = `TXN-${String(nextNum).padStart(6, '0')}`;
            const transactionId = uuidv4();

            // Calculate totals
            const validation = this.validateDoubleEntry(reversedLines);

            // 7. Create reversal transaction
            await client.query(
                `
        INSERT INTO ledger_transactions (
          "Id", "TransactionNumber", "TransactionDate", "ReferenceType",
          "ReferenceId", "ReferenceNumber", "Description",
          "TotalDebitAmount", "TotalCreditAmount", "Status",
          "ReversesTransactionId", "IdempotencyKey", "CreatedBy", "CreatedAt", "UpdatedAt", "IsReversed"
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'POSTED', $10, $11, $12, NOW(), NOW(), FALSE)
      `,
                [
                    transactionId,
                    transactionNumber,
                    request.reversalDate,
                    'REVERSAL',
                    original.ReferenceId,
                    `REV-${original.ReferenceNumber}`,
                    `REVERSAL of ${original.TransactionNumber}: ${request.reason}`,
                    validation.totalDebits,
                    validation.totalCredits,
                    request.originalTransactionId,
                    request.idempotencyKey,
                    request.userId,
                ]
            );

            // 8. Create reversal entries
            let lineNumber = 1;
            for (let i = 0; i < reversedLines.length; i++) {
                const line = reversedLines[i];
                const orig = entriesResult.rows[i];
                const accountResult = await client.query(
                    `
          SELECT "Id", "NormalBalance" FROM accounts WHERE "AccountCode" = $1
        `,
                    [line.accountCode]
                );

                const account = accountResult.rows[0];
                const entryId = uuidv4();
                const entryType = line.debitAmount > 0 ? 'DEBIT' : 'CREDIT';
                const amount = line.debitAmount > 0 ? line.debitAmount : line.creditAmount;

                await client.query(
                    `
          INSERT INTO ledger_entries (
            "Id", "TransactionId", "LedgerTransactionId", "AccountId", "EntryType", "Amount",
            "DebitAmount", "CreditAmount", "Description", "LineNumber",
            "EntityType", "EntityId", "EntryDate", "CreatedAt"
          ) VALUES ($1, $2, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
        `,
                    [
                        entryId,
                        transactionId,
                        account.Id,
                        entryType,
                        amount,
                        line.debitAmount,
                        line.creditAmount,
                        line.description,
                        lineNumber++,
                        orig?.EntityType ?? line.entityType ?? null,
                        orig?.EntityId ?? line.entityId ?? null,
                        request.reversalDate,
                    ]
                );

                // Update account balance
                const balanceChange =
                    account.NormalBalance === 'DEBIT'
                        ? Money.subtract(line.debitAmount, line.creditAmount).toNumber()
                        : Money.subtract(line.creditAmount, line.debitAmount).toNumber();

                await client.query(
                    `
          UPDATE accounts SET "CurrentBalance" = "CurrentBalance" + $2 WHERE "Id" = $1
        `,
                    [account.Id, balanceChange]
                );

                // UPSERT gl_period_balances (SAP FAGLFLEXT) — reversal uses reversalDate
                //     Defense-in-depth: isPeriodOpen() already gates this function,
                //     but the WHERE clause below provides a DB-level safety net.
                if (process.env.LEGACY_GL_PERIOD_WRITES === 'true') {
                    // LEGACY escape hatch: inline incremental UPSERT (set env var to revert).
                    const revUpsertResult = await client.query(
                        `INSERT INTO gl_period_balances
                                (account_id, fiscal_year, fiscal_period, debit_total, credit_total, running_balance, last_updated)
                             SELECT $1, $2, $3, $4::numeric, $5::numeric, $4::numeric - $5::numeric, NOW()
                             WHERE NOT EXISTS (
                               SELECT 1 FROM financial_periods
                               WHERE period_year = $2 AND period_month = $3
                                 AND "Status" IN ('CLOSED', 'LOCKED')
                             )
                             ON CONFLICT (account_id, fiscal_year, fiscal_period)
                             DO UPDATE SET
                                debit_total     = gl_period_balances.debit_total   + EXCLUDED.debit_total,
                                credit_total    = gl_period_balances.credit_total  + EXCLUDED.credit_total,
                                running_balance = (gl_period_balances.debit_total + EXCLUDED.debit_total) - (gl_period_balances.credit_total + EXCLUDED.credit_total),
                                last_updated    = NOW()`,
                        [account.Id, revYear, revMonth, line.debitAmount, line.creditAmount]
                    );
                    if (revUpsertResult.rowCount === 0) {
                        throw new PeriodLockedError(request.reversalDate, 'LOCKED');
                    }
                } else if (txClient) {
                    txReversalRebuildKeys.add(`${account.Id}|${revYear}|${revMonth}`);
                    txReversalRebuildKeys.add(`${account.Id}|${origYear}|${origMonth}`);
                } else {
                    // Phase 3b path: collect for post-commit rebuild.
                    pendingReversalRebuildJobs.push({ accountId: account.Id, fiscalYear: revYear, fiscalPeriod: revMonth });
                    pendingReversalRebuildJobs.push({ accountId: account.Id, fiscalYear: origYear, fiscalPeriod: origMonth });
                }

                // PHASE 3a SHADOW VERIFY (reverseTransaction mirror)
                if (process.env.GL_PERIOD_BALANCES_SHADOW_VERIFY === 'true') {
                    try {
                        const vr = await client.query<{
                            le_debits: string; le_credits: string;
                            gpb_debits: string; gpb_credits: string;
                        }>(
                            `SELECT
                               COALESCE(SUM(le."DebitAmount"), 0)  AS le_debits,
                               COALESCE(SUM(le."CreditAmount"), 0) AS le_credits,
                               MAX(gpb.debit_total)                AS gpb_debits,
                               MAX(gpb.credit_total)               AS gpb_credits
                             FROM ledger_entries le
                             JOIN ledger_transactions lt ON lt."Id" = le."TransactionId"
                             LEFT JOIN gl_period_balances gpb
                               ON gpb.account_id = le."AccountId"
                               AND gpb.fiscal_year  = $2
                               AND gpb.fiscal_period = $3
                             WHERE le."AccountId" = $1
                               AND ${LEDGER_FISCAL_YEAR_SQL} = $2
                               AND ${LEDGER_FISCAL_PERIOD_SQL} = $3
                               AND ${LEDGER_NET_ACTIVE_SQL}`,
                            [account.Id, revYear, revMonth]
                        );
                        const vRow = vr.rows[0];
                        const leD = new Decimal(vRow?.le_debits ?? 0);
                        const leC = new Decimal(vRow?.le_credits ?? 0);
                        const gpbD = new Decimal(vRow?.gpb_debits ?? 0);
                        const gpbC = new Decimal(vRow?.gpb_credits ?? 0);
                        const driftD = leD.minus(gpbD).abs();
                        const driftC = leC.minus(gpbC).abs();
                        if (driftD.greaterThan('0.01') || driftC.greaterThan('0.01')) {
                            logger.warn('[PHASE3a] gl_period_balances drift after reverseTransaction', {
                                accountId: account.Id,
                                fiscalYear: revYear,
                                fiscalPeriod: revMonth,
                                ledgerDebits: leD.toFixed(2),
                                ledgerCredits: leC.toFixed(2),
                                gpbDebits: gpbD.toFixed(2),
                                gpbCredits: gpbC.toFixed(2),
                                debitDrift: driftD.toFixed(2),
                                creditDrift: driftC.toFixed(2),
                                transactionId,
                            });
                        }
                    } catch (verifyErr) {
                        logger.warn('[PHASE3a] gl_period_balances shadow verify error (non-fatal)', {
                            accountId: account.Id,
                            error: verifyErr instanceof Error ? verifyErr.message : String(verifyErr),
                        });
                    }
                }
            }

            await this.assertWrittenJournalMatchesHeader(client, transactionId);

            // 9. Mark original as reversed (but don't delete!)
            // Release IdempotencyKey so the business document may be reposted (SAP reversal pattern).
            await client.query(
                `
        UPDATE ledger_transactions
        SET "Status" = 'REVERSED',
            "ReversedByTransactionId" = $2,
            "ReversedAt" = NOW(),
            "IsReversed" = TRUE,
            "IdempotencyKey" = CASE
              WHEN "IdempotencyKey" IS NOT NULL AND "IdempotencyKey" != ''
              THEN "IdempotencyKey" || '::REVERSED::' || $2::uuid::text
              ELSE "IdempotencyKey"
            END,
            "UpdatedAt" = NOW()
        WHERE "Id" = $1
      `,
                [request.originalTransactionId, transactionId]
            );

            // Rebuild period balances after original is REVERSED (net-active excludes both legs).
            if (txClient && txReversalRebuildKeys.size > 0) {
                for (const key of txReversalRebuildKeys) {
                    const [accountId, yearStr, periodStr] = key.split('|');
                    await rebuildSingleAccountPeriodOnClient(
                        client,
                        accountId,
                        parseInt(yearStr, 10),
                        parseInt(periodStr, 10),
                    );
                }
            }

            // 10. Audit log
            await client.query(
                `
        INSERT INTO audit_log (id, action, entity_type, entity_id, user_id, action_details)
        VALUES ($1, 'VOID', 'SYSTEM', $2, $3, $4)
      `,
                [
                    uuidv4(),
                    transactionId,
                    request.userId,
                    JSON.stringify({
                        originalTransactionId: request.originalTransactionId,
                        originalTransactionNumber: original.TransactionNumber,
                        reversalReason: request.reason,
                    }),
                ]
            );

            const { afterJournalEntryGovernance } = await import(
                '../modules/supplier-payments/apBalanceGovernance.js'
            );
            await afterJournalEntryGovernance(
                client,
                reversedLines.map((l) => ({
                    accountCode: l.accountCode,
                    entityType: l.entityType ?? null,
                    entityId: l.entityId ?? null,
                })),
            );

            logger.info('Transaction reversed', {
                originalTransactionId: request.originalTransactionId,
                reversalTransactionId: transactionId,
                reason: request.reason,
            });

            return {
                transactionId,
                transactionNumber,
                status: 'POSTED' as const,
                totalDebits: validation.totalDebits,
                totalCredits: validation.totalCredits,
            };
        };

        let reversalResult: JournalEntryResult;
        try {
            if (txClient) {
                reversalResult = await doReversal(txClient);
            } else {
                reversalResult = await UnitOfWork.run(pool, doReversal);
            }
        } catch (error) {
            logger.error('Failed to reverse transaction', { error, request });
            throw error;
        }

        // Phase 3b: schedule post-commit rebuild (own-transaction path only).
        if (!txClient && pendingReversalRebuildJobs.length > 0) {
            scheduleGlRebuildJobs(pendingReversalRebuildJobs, pool);
        }

        return reversalResult;
    }

    // ===========================================================================
    // QUERY OPERATIONS (Read-only, Database-driven)
    // ===========================================================================

    /**
     * Get transaction by ID
     */
    static async getTransaction(
        transactionId: string,
        dbPool?: pg.Pool
    ): Promise<JournalEntryResult | null> {
        const pool = dbPool || globalPool;
        const result = await pool.query(
            `
      SELECT 
        "Id" as "transactionId",
        "TransactionNumber" as "transactionNumber",
        "Status" as status,
        "TotalDebitAmount" as "totalDebits",
        "TotalCreditAmount" as "totalCredits"
      FROM ledger_transactions
      WHERE "Id" = $1
    `,
            [transactionId]
        );

        if (result.rows.length === 0) return null;

        const row = result.rows[0];
        return {
            transactionId: row.transactionId,
            transactionNumber: row.transactionNumber,
            status: row.status,
            totalDebits: Money.parseDb(row.totalDebits).toNumber(),
            totalCredits: Money.parseDb(row.totalCredits).toNumber(),
        };
    }

    /**
     * Get account balance (calculated from transactions)
     * SOURCE-OF-TRUTH: Balance computed from actual ledger entries
     */
    static async getAccountBalance(
        accountCode: string,
        asOfDate?: string,
        dbPool?: pg.Pool
    ): Promise<AccountBalance | null> {
        const pool = dbPool || globalPool;

        const params: (string | undefined)[] = [accountCode];
        if (asOfDate) params.push(asOfDate);

        const result = await pool.query(
            `
      SELECT 
        a."Id" as "accountId",
        a."AccountCode" as "accountCode",
        a."AccountName" as "accountName",
        a."AccountType" as "accountType",
        a."NormalBalance" as "normalBalance",
        COALESCE(bal.debit_total, 0) as "debitTotal",
        COALESCE(bal.credit_total, 0) as "creditTotal"
      FROM accounts a
      ${postedLedgerBalanceLateral(asOfDate ? '$2' : undefined)}
      WHERE a."AccountCode" = $1
    `,
            params
        );

        if (result.rows.length === 0) return null;

        const row = result.rows[0];
        const debitTotal = Money.parseDb(row.debitTotal);
        const creditTotal = Money.parseDb(row.creditTotal);

        const balance = availableFromPostedTotals(
            debitTotal.toNumber(),
            creditTotal.toNumber(),
            row.normalBalance,
        );

        return {
            accountId: row.accountId,
            accountCode: row.accountCode,
            accountName: row.accountName,
            accountType: row.accountType,
            normalBalance: row.normalBalance,
            debitTotal: debitTotal.toNumber(),
            creditTotal: creditTotal.toNumber(),
            balance,
        };
    }

    /**
     * Validate trial balance (all accounts)
     * SOURCE-OF-TRUTH: Computed from ledger entries
     */
    static async validateTrialBalance(
        asOfDate: string,
        dbPool?: pg.Pool
    ): Promise<{
        isBalanced: boolean;
        totalDebits: number;
        totalCredits: number;
        difference: number;
    }> {
        const pool = dbPool || globalPool;
        const result = await pool.query(
            `
      SELECT 
        COALESCE(SUM(le."DebitAmount"), 0) as "totalDebits",
        COALESCE(SUM(le."CreditAmount"), 0) as "totalCredits"
      FROM ledger_entries le
      JOIN ledger_transactions lt ON le."TransactionId" = lt."Id"
      WHERE lt."Status" = 'POSTED'
        AND DATE(lt."TransactionDate") <= $1
    `,
            [asOfDate]
        );

        const row = result.rows[0];
        const totalDebits = Money.parseDb(row.totalDebits);
        const totalCredits = Money.parseDb(row.totalCredits);
        const difference = Money.abs(Money.subtract(totalDebits, totalCredits));

        return {
            isBalanced: difference.lessThan(this.BALANCE_TOLERANCE),
            totalDebits: totalDebits.toNumber(),
            totalCredits: totalCredits.toNumber(),
            difference: difference.toNumber(),
        };
    }
}

// Export singleton methods for convenience
export const createJournalEntry = AccountingCore.createJournalEntry.bind(AccountingCore);
export const reverseTransaction = AccountingCore.reverseTransaction.bind(AccountingCore);
export const getAccountBalance = AccountingCore.getAccountBalance.bind(AccountingCore);
export const validateTrialBalance = AccountingCore.validateTrialBalance.bind(AccountingCore);
export const lockPeriod = AccountingCore.lockPeriod.bind(AccountingCore);

export default AccountingCore;
