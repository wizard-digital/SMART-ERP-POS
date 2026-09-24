/**
 * BANKING SERVICE
 *
 * Handles all bank account operations with full GL integration.
 * Follows same principles as AccountingCore:
 *   ✔ Double-entry bookkeeping (all transactions post to GL)
 *   ✔ Immutable transactions (reversals only)
 *   ✔ Full audit trail
 *
 * ARCHITECTURE:
 *   BankingService → AccountingCore → Database
 *   Every bank transaction creates a GL entry automatically
 */

import { pool as globalPool } from '../db/pool.js';
import type pg from 'pg';
import { PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { Money } from '../utils/money.js';
import Decimal from 'decimal.js';
import { AccountingCore, JournalEntryRequest } from './accountingCore.js';
import logger from '../utils/logger.js';
import { UnitOfWork } from '../db/unitOfWork.js';
import { SYSTEM_USER_ID } from '../utils/constants.js';
import { ensureBankGlLiquidityTag, assertBankBookGlEligible, isEligibleBankBookLiquidity } from '../modules/banking/ensureBankGlLiquidityTag.js';
import { LEDGER_NET_ACTIVE_SQL } from '../utils/ledgerNetActive.js';
import { ensureDepositLiquidityBook } from '../modules/treasury/ensureDepositLiquidityBook.js';

/** GL book balance for a bank_accounts.gl_account_id — net-active reverse pairs. */
const BANK_GL_BALANCE_SQL = `
  COALESCE((
    SELECT SUM(le."DebitAmount") - SUM(le."CreditAmount")
    FROM ledger_entries le
    JOIN ledger_transactions lt ON le."TransactionId" = lt."Id"
    WHERE le."AccountId" = ba.gl_account_id
      AND ${LEDGER_NET_ACTIVE_SQL}
  ), 0)`;

const BANK_GL_BALANCE_AS_OF_SQL = `
  COALESCE((
    SELECT SUM(le."DebitAmount") - SUM(le."CreditAmount")
    FROM ledger_entries le
    JOIN ledger_transactions lt ON le."TransactionId" = lt."Id"
    WHERE le."AccountId" = ba.gl_account_id
      AND ${LEDGER_NET_ACTIVE_SQL}
      AND lt."TransactionDate" <= $1
  ), 0)`;

import type {
    BankAccount,
    BankAccountDbRow,
    BankTransaction,
    BankTransactionDbRow,
    BankCategory,
    BankCategoryDbRow,
    BankPattern,
    BankPatternDbRow,
    BankAlert,
    BankAlertDbRow,
    BankTemplate,
    BankTemplateDbRow,
    BankStatement,
    BankStatementDbRow,
    BankStatementLine,
    BankStatementLineDbRow,
    BankRecurringRule,
    BankRecurringRuleDbRow,
    CreateBankAccountDto,
    UpdateBankAccountDto,
    CreateBankTransactionDto,
    CreateTransferDto,
    ReverseBankTransactionDto,
    CreateRecurringRuleDto,
    UpdateRecurringRuleDto,
    PatternMatchRules,
    RecurringMatchRules,
    BankAccountSummary,
    BankActivityReport,
    CashPositionReport,
} from '../../../shared/types/banking.js';

// Import normalization functions from single source of truth
import {
    normalizeBankAccount,
    normalizeBankTransaction,
    normalizeBankCategory,
    normalizeBankPattern,
    normalizeBankAlert,
    normalizeBankTemplate,
    normalizeBankStatement,
    normalizeBankStatementLine,
    normalizeBankRecurringRule,
} from '../../../shared/types/banking.js';
import { getBusinessDate, getBusinessYear, formatDateBusiness } from '../utils/dateRange.js';
import {
    computeClearedBalance,
    computeReconciliationDifference,
    isReconciliationBalanced,
} from './bankReconciliationMath.js';
import { ValidationError } from '../middleware/errorHandler.js';

// SYSTEM_USER_ID imported from ../utils/constants.js

// Typed interfaces for statement import (replacing any[])
interface ParsedStatementLine {
    id: string;
    lineNumber: number;
    transactionDate: string | null;
    description: string;
    reference: string | null;
    amount: number;
    runningBalance: number | null;
    suggestedCategoryId?: string | null;
    suggestedCategoryName?: string | null;
    matchConfidence?: number | null;
}

interface ColumnMappings {
    dateColumn?: number;
    dateFormat: string;
    descriptionColumn?: number;
    amountColumn?: number;
    debitColumn?: number;
    creditColumn?: number;
    balanceColumn?: number;
    referenceColumn?: number;
    negativeIsDebit?: boolean;
}

// =============================================================================
// BANK ACCOUNT OPERATIONS
// =============================================================================

export class BankingService {
    // ---------------------------------------------------------------------------
    // NUMBER GENERATORS (replaces DB functions fn_generate_bank_txn_number, fn_generate_statement_number)
    // ---------------------------------------------------------------------------

    /**
     * Generate bank transaction number: BTX-YYYY-0001
     * Replaces fn_generate_bank_txn_number() which used a sequence
     */
    private static async generateBankTxnNumber(client: pg.Pool | pg.PoolClient): Promise<string> {
        const [num] = await BankingService.generateBankTxnNumbers(client, 1);
        return num;
    }

    /**
     * Allocate N consecutive BTX numbers under one advisory lock.
     * Required for transfers (OUT+IN) — calling generateBankTxnNumber twice
     * before INSERT reused the same MAX+1 and hit bank_transactions_transaction_number_key.
     */
    private static async generateBankTxnNumbers(
        client: pg.Pool | pg.PoolClient,
        count: number,
    ): Promise<string[]> {
        if (count < 1) {
            throw new Error('generateBankTxnNumbers requires count >= 1');
        }
        const year = getBusinessYear();
        const prefix = `BTX-${year}-`;
        // Serialize number allocation (MAX+1 without lock races under concurrent posts)
        await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [prefix]);
        // IMPORTANT: use substr(string, int) — "SUBSTRING(x FROM $n)" with a bound
        // parameter is parsed as regex substring and returns NULL.
        const result = await client.query<{ next_num: number | string }>(
            `SELECT COALESCE(
               MAX(CAST(NULLIF(substr(transaction_number, $2), '') AS INTEGER)),
               0
             ) + 1 AS next_num
             FROM bank_transactions WHERE transaction_number LIKE $1`,
            [`${prefix}%`, prefix.length + 1],
        );
        const start = Number(result.rows[0]?.next_num ?? 1);
        return Array.from({ length: count }, (_, i) =>
            `${prefix}${String(start + i).padStart(4, '0')}`,
        );
    }

    /**
     * Generate bank statement number: STM-YYYY-0001
     * Replaces fn_generate_statement_number()
     */
    private static async generateStatementNumber(client: pg.Pool | pg.PoolClient): Promise<string> {
        const year = getBusinessYear();
        const prefix = `STM-${year}-`;
        await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [prefix]);
        const result = await client.query(
            `SELECT COALESCE(
               MAX(CAST(NULLIF(substr(statement_number, $2), '') AS INTEGER)),
               0
             ) + 1 AS next_num
             FROM bank_statements WHERE statement_number LIKE $1`,
            [`${prefix}%`, prefix.length + 1]
        );
        return `${prefix}${String(result.rows[0].next_num).padStart(4, '0')}`;
    }

    // ---------------------------------------------------------------------------
    // BANK ACCOUNTS
    // ---------------------------------------------------------------------------

    /**
     * Get all bank accounts with GL-derived balances
     * PRINCIPLE: Balance is ALWAYS derived from General Ledger, never stored separately
     */
    static async getAllAccounts(includeInactive = false, dbPool?: pg.Pool): Promise<BankAccount[]> {
        const pool = dbPool || globalPool;
        // Get bank accounts with GL balance calculated from ledger entries
        const result = await pool.query<BankAccountDbRow>(
            `
      SELECT 
        ba.*,
        a."AccountCode" as gl_account_code,
        a."AccountName" as gl_account_name,
        a."SystemAccountTag" as gl_system_account_tag,
        -- Calculate current_balance from GL (net-active reverse pairs)
        ${BANK_GL_BALANCE_SQL} as current_balance
      FROM bank_accounts ba
      JOIN accounts a ON a."Id" = ba.gl_account_id
      WHERE ($1 = TRUE OR ba.is_active = TRUE)
      ORDER BY ba.is_default DESC, ba.name
    `,
            [includeInactive]
        );

        return result.rows.map((row) => {
            const normalized = normalizeBankAccount(row);
            return {
                ...normalized,
                glSystemAccountTag: row.gl_system_account_tag ?? null,
                transferEligible: isEligibleBankBookLiquidity(
                    row.gl_account_code || '',
                    row.gl_system_account_tag,
                ),
            };
        });
    }

    /**
     * Get bank account by ID with GL-derived balance
     * PRINCIPLE: Balance is ALWAYS derived from General Ledger
     */
    static async getAccountById(id: string, dbPool?: pg.Pool): Promise<BankAccount | null> {
        const pool = dbPool || globalPool;
        const result = await pool.query<BankAccountDbRow>(
            `
      SELECT 
        ba.*,
        a."AccountCode" as gl_account_code,
        a."AccountName" as gl_account_name,
        -- Calculate current_balance from GL (net-active reverse pairs)
        ${BANK_GL_BALANCE_SQL} as current_balance
      FROM bank_accounts ba
      JOIN accounts a ON a."Id" = ba.gl_account_id
      WHERE ba.id = $1
    `,
            [id]
        );

        return result?.rows?.[0] ? normalizeBankAccount(result.rows[0]) : null;
    }

    /**
     * Create a new bank account
     */
    static async createAccount(
        dto: CreateBankAccountDto,
        userId: string,
        dbPool?: pg.Pool
    ): Promise<BankAccount> {
        const pool = dbPool || globalPool;
        const created = await UnitOfWork.run(pool, async (client) => {
            // Verify GL exists and is eligible liquidity (rejects AR 1200, inventory, etc.)
            const glAccount = await client.query(
                `
        SELECT "Id", "AccountCode", "AccountName", "AccountType", "IsPostingAccount"
        FROM accounts 
        WHERE "Id" = $1 AND "IsActive" = TRUE
      `,
                [dto.glAccountId]
            );

            if (glAccount.rows.length === 0) {
                throw new Error(`GL Account ${dto.glAccountId} not found or inactive`);
            }

            // Check if another bank account already uses this GL account
            const existingWithSameGl = await client.query(
                `
        SELECT id, name FROM bank_accounts 
        WHERE gl_account_id = $1 AND is_active = TRUE
      `,
                [dto.glAccountId]
            );

            if (existingWithSameGl.rows.length > 0) {
                const existing = existingWithSameGl.rows[0];
                throw new Error(
                    `GL Account "${glAccount.rows[0].AccountCode} - ${glAccount.rows[0].AccountName}" is already used by ` +
                    `bank account "${existing.name}". Each bank account needs a unique GL account to track balances correctly. ` +
                    `Please create a new GL sub-account or select a different one.`
                );
            }

            // TD-INV-6: bank books must be Cash/Bank liquidity — never AR 1200 etc.
            await assertBankBookGlEligible(client, dto.glAccountId);

            // If setting as default, clear other defaults first
            if (dto.isDefault) {
                await client.query(`UPDATE bank_accounts SET is_default = FALSE WHERE is_default = TRUE`);
            }

            const id = uuidv4();
            const glCode = String(glAccount.rows[0].AccountCode || 'BNK');
            // Legacy columns (account_code/account_name/account_type/currency_code/opening_balance)
            // remain NOT NULL on upgraded tenants — keep them in sync with the modern name/gl fields.
            const legacyCode =
                (dto.accountNumber && String(dto.accountNumber).trim()) ||
                `BNK-${glCode}-${id.slice(0, 8).toUpperCase()}`;
            const opening = dto.openingBalance && dto.openingBalance !== 0 ? dto.openingBalance : 0;

            const result = await client.query<BankAccountDbRow>(
                `
        INSERT INTO bank_accounts (
          id, name, account_number, bank_name, branch,
          gl_account_id, current_balance, is_default, is_active,
          created_at, updated_at,
          account_code, account_name, account_type, currency_code,
          opening_balance, is_main_cash, is_main_bank
        )
        VALUES (
          $1, $2, $3, $4, $5,
          $6, 0, $7, TRUE,
          NOW(), NOW(),
          $8, $2, 'BANK', 'UGX',
          $9, FALSE, FALSE
        )
        RETURNING *
      `,
                [
                    id,
                    dto.name,
                    dto.accountNumber || null,
                    dto.bankName || null,
                    dto.branch || null,
                    dto.glAccountId,
                    dto.isDefault || false,
                    legacyCode,
                    opening,
                ]
            );

            // If there's an opening balance, post governed cutover JE (DR bank GL / CR 3050 OBE)
            if (dto.openingBalance && dto.openingBalance !== 0) {
                await this.createOpeningBalanceEntry(
                    client,
                    id,
                    dto.openingBalance,
                    glAccount.rows[0].AccountCode,
                    userId,
                );
            }

            // Audit log
            await client.query(
                `
        INSERT INTO audit_log (id, action, entity_type, entity_id, user_id, action_details)
        VALUES ($1, 'CREATE', 'SETTINGS', $2, $3, $4)
      `,
                [uuidv4(), id, userId, JSON.stringify({ name: dto.name, bank: dto.bankName })]
            );

            logger.info('Bank account created', { id, name: dto.name });

            return normalizeBankAccount({
                ...result.rows[0],
                gl_account_code: glAccount.rows[0].AccountCode,
                gl_account_name: glAccount.rows[0].AccountName,
            });
        });

        // Prefer GL-driven balance (includes opening JE) for immediate UI accuracy
        const refreshed = await this.getAccountById(created.id, pool);
        if (refreshed) return refreshed;
        return {
            ...created,
            currentBalance:
                dto.openingBalance && dto.openingBalance !== 0
                    ? dto.openingBalance
                    : created.currentBalance,
        };
    }

    /**
     * Update bank account metadata (and optionally correct cutover opening balance).
     * Opening balance corrections post a delta JE (never rewrite history).
     */
    static async updateAccount(
        id: string,
        dto: UpdateBankAccountDto,
        userId: string,
        dbPool?: pg.Pool
    ): Promise<BankAccount> {
        const pool = dbPool || globalPool;
        await UnitOfWork.run(pool, async (client) => {
            const existing = await client.query<BankAccountDbRow>(
                `SELECT * FROM bank_accounts WHERE id = $1`,
                [id],
            );
            if (existing.rows.length === 0) {
                throw new Error(`Bank account ${id} not found`);
            }
            const row = existing.rows[0];
            const storedOpening =
                row.opening_balance != null && row.opening_balance !== ''
                    ? parseFloat(String(row.opening_balance))
                    : 0;

            let nextGlId = row.gl_account_id;
            let nextGlCode: string | null = null;

            if (dto.glAccountId && dto.glAccountId !== row.gl_account_id) {
                const clash = await client.query(
                    `
          SELECT id, name FROM bank_accounts
          WHERE gl_account_id = $1 AND is_active = TRUE AND id <> $2
        `,
                    [dto.glAccountId, id],
                );
                if (clash.rows.length > 0) {
                    throw new Error(
                        `GL Account is already used by bank account "${clash.rows[0].name}".`,
                    );
                }
                const eligible = await assertBankBookGlEligible(client, dto.glAccountId);
                nextGlId = dto.glAccountId;
                nextGlCode = eligible.accountCode;
            } else if (nextGlId) {
                // Heal untagged bank GLs; do not hard-fail legacy bad links on name-only edits
                // (transfer/deposit will reject with a clear message until GL is fixed).
                await ensureBankGlLiquidityTag(client, nextGlId);
            }

            if (dto.isDefault === true) {
                await client.query(
                    `UPDATE bank_accounts SET is_default = FALSE WHERE is_default = TRUE AND id <> $1`,
                    [id],
                );
            }

            const name = dto.name !== undefined ? dto.name : (row.name || row.account_name || '');
            const accountNumber =
                dto.accountNumber !== undefined ? dto.accountNumber : row.account_number;
            const bankName = dto.bankName !== undefined ? dto.bankName : row.bank_name;
            const branch = dto.branch !== undefined ? dto.branch : row.branch;
            const isDefault =
                dto.isDefault !== undefined ? dto.isDefault : (row.is_default ?? false);
            const isActive =
                dto.isActive !== undefined ? dto.isActive : (row.is_active ?? true);

            let nextOpening = storedOpening;
            if (dto.openingBalance !== undefined) {
                const delta = new Decimal(dto.openingBalance).minus(storedOpening).toNumber();
                if (Math.abs(delta) >= 0.005) {
                    if (!nextGlCode) {
                        const gl = await client.query<{ AccountCode: string }>(
                            `SELECT "AccountCode" FROM accounts WHERE "Id" = $1`,
                            [nextGlId],
                        );
                        nextGlCode = gl.rows[0]?.AccountCode || null;
                    }
                    if (!nextGlCode) {
                        throw new Error('Cannot correct opening balance: bank GL code not found');
                    }
                    await this.createOpeningBalanceEntry(
                        client,
                        id,
                        delta,
                        nextGlCode,
                        userId,
                        {
                            description: 'Opening balance correction',
                            bankDescription: 'Opening balance correction',
                            idempotencyKey: `OPEN-CORR-${id}-${uuidv4()}`,
                            referenceNumber: `OPEN-CORR-${uuidv4().slice(0, 8).toUpperCase()}`,
                            referenceType: 'BANK_OPENING_ADJ',
                            referenceId: uuidv4(),
                        },
                    );
                }
                nextOpening = dto.openingBalance;
            }

            const legacyCode =
                (accountNumber && String(accountNumber).trim()) ||
                row.account_code ||
                `BNK-${(nextGlCode || 'BNK').slice(0, 8)}-${id.slice(0, 8).toUpperCase()}`;

            await client.query(
                `
        UPDATE bank_accounts SET
          name = $2,
          account_number = $3,
          bank_name = $4,
          branch = $5,
          gl_account_id = $6,
          is_default = $7,
          is_active = $8,
          opening_balance = $9,
          account_code = $10,
          account_name = $2,
          updated_at = NOW()
        WHERE id = $1
      `,
                [
                    id,
                    name,
                    accountNumber || null,
                    bankName || null,
                    branch || null,
                    nextGlId,
                    isDefault,
                    isActive,
                    nextOpening,
                    legacyCode,
                ],
            );

            await client.query(
                `
        INSERT INTO audit_log (id, action, entity_type, entity_id, user_id, action_details)
        VALUES ($1, 'UPDATE', 'SETTINGS', $2, $3, $4)
      `,
                [uuidv4(), id, userId, JSON.stringify(dto)],
            );

            logger.info('Bank account updated', { id, name });
        });

        const refreshed = await this.getAccountById(id, pool);
        if (!refreshed) {
            throw new Error(`Bank account ${id} not found after update`);
        }
        return refreshed;
    }

    /**
     * Create opening balance GL entry + bank book line.
     * Cutover pattern (same family as customer/supplier OB):
     *   DR Bank GL / CR Opening Balance Equity (3050), source CUTOVER_OB
     */
    private static async createOpeningBalanceEntry(
        client: PoolClient,
        bankAccountId: string,
        amount: number,
        bankGlCode: string,
        userId: string,
        options?: {
            description?: string;
            bankDescription?: string;
            idempotencyKey?: string;
            referenceNumber?: string;
            /** Distinct from initial OPEN so GL reference uniqueness allows corrections. */
            referenceType?: string;
            referenceId?: string;
        },
    ): Promise<void> {
        const entryDate = getBusinessDate();
        const equityCode = await this.ensureOpeningBalanceEquityAccount(client);
        const description = options?.description || 'Bank account opening balance';
        const bankDescription = options?.bankDescription || 'Opening balance';
        const referenceNumber =
            options?.referenceNumber || `OPEN-${bankAccountId.slice(0, 8).toUpperCase()}`;
        const idempotencyKey = options?.idempotencyKey || `OPEN-${bankAccountId}`;
        const referenceType = options?.referenceType || 'BANK_OPENING';
        const referenceId = options?.referenceId || bankAccountId;

        const request: JournalEntryRequest = {
            entryDate,
            description,
            referenceType,
            referenceId,
            referenceNumber,
            lines: [
                {
                    accountCode: bankGlCode,
                    description: bankDescription,
                    debitAmount: amount > 0 ? amount : 0,
                    creditAmount: amount < 0 ? Math.abs(amount) : 0,
                },
                {
                    accountCode: equityCode,
                    description: amount >= 0 ? 'Opening balance equity' : 'Opening balance equity correction',
                    debitAmount: amount < 0 ? Math.abs(amount) : 0,
                    creditAmount: amount > 0 ? amount : 0,
                },
            ],
            userId,
            idempotencyKey,
            source: 'CUTOVER_OB',
        };

        const glResult = await AccountingCore.createJournalEntry(request, undefined, client);

        // Mirror on bank register so Operators see the opening in Transactions
        const txnNum = await BankingService.generateBankTxnNumber(client);
        const txnId = uuidv4();
        const isInflow = amount >= 0;
        await client.query(
            `
        INSERT INTO bank_transactions (
          id, transaction_number, bank_account_id, transaction_date,
          type, description, reference, amount,
          gl_transaction_id, source_type, source_id,
          is_reconciled, is_reversed, created_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'MANUAL', $10, FALSE, FALSE, $11)
      `,
            [
                txnId,
                txnNum,
                bankAccountId,
                entryDate,
                isInflow ? 'DEPOSIT' : 'WITHDRAWAL',
                bankDescription,
                referenceNumber,
                Math.abs(amount),
                glResult.transactionId,
                bankAccountId,
                userId,
            ],
        );
    }

    /** Resolve Opening Balance Equity (3050 / OPENING_BALANCE_EQUITY). Never invent 3900. */
    private static async ensureOpeningBalanceEquityAccount(client: PoolClient): Promise<string> {
        const tagged = await client.query<{ AccountCode: string }>(
            `
      SELECT "AccountCode" FROM accounts
      WHERE "SystemAccountTag" = 'OPENING_BALANCE_EQUITY' AND "IsActive" = TRUE
      ORDER BY "AccountCode"
      LIMIT 1
    `,
        );
        if (tagged.rows[0]?.AccountCode) return tagged.rows[0].AccountCode;

        const byCode = await client.query<{ AccountCode: string }>(
            `SELECT "AccountCode" FROM accounts WHERE "AccountCode" = '3050' LIMIT 1`,
        );
        if (byCode.rows[0]?.AccountCode) return byCode.rows[0].AccountCode;

        await client.query(
            `
      INSERT INTO accounts (
        "Id", "AccountCode", "AccountName", "AccountType", "NormalBalance",
        "ParentAccountId", "Level", "IsPostingAccount", "IsActive",
        "SystemAccountTag", "CurrentBalance", "CreatedAt", "UpdatedAt"
      )
      VALUES (
        $1, '3050', 'Opening Balance Equity', 'EQUITY', 'CREDIT',
        NULL, 1, TRUE, TRUE,
        'OPENING_BALANCE_EQUITY', 0, NOW(), NOW()
      )
    `,
            [uuidv4()],
        );
        return '3050';
    }

    // ---------------------------------------------------------------------------
    // BANK TRANSACTIONS
    // ---------------------------------------------------------------------------

    /**
     * Get transactions for a bank account
     */
    static async getTransactions(
        bankAccountId: string,
        options: {
            startDate?: string;
            endDate?: string;
            type?: string;
            isReconciled?: boolean;
            limit?: number;
            offset?: number;
        } = {},
        dbPool?: pg.Pool
    ): Promise<{ transactions: BankTransaction[]; total: number }> {
        const pool = dbPool || globalPool;
        const conditions: string[] = ['bt.bank_account_id = $1', 'bt.is_reversed = FALSE'];
        const params: (string | number | boolean)[] = [bankAccountId];
        let paramIndex = 2;

        if (options.startDate) {
            conditions.push(`bt.transaction_date >= $${paramIndex++}`);
            params.push(options.startDate);
        }
        if (options.endDate) {
            conditions.push(`bt.transaction_date <= $${paramIndex++}`);
            params.push(options.endDate);
        }
        if (options.type) {
            conditions.push(`bt.type = $${paramIndex++}`);
            params.push(options.type);
        }
        if (options.isReconciled !== undefined) {
            conditions.push(`bt.is_reconciled = $${paramIndex++}`);
            params.push(options.isReconciled);
        }

        const whereClause = conditions.join(' AND ');

        // Get total count
        const countResult = await pool.query(
            `
      SELECT COUNT(*) as total FROM bank_transactions bt WHERE ${whereClause}
    `,
            params
        );

        // Get paginated results
        const limit = options.limit || 50;
        const offset = options.offset || 0;

        const result = await pool.query<BankTransactionDbRow>(
            `
      SELECT 
        bt.*,
        ba.name as bank_account_name,
        bc.code as category_code,
        bc.name as category_name,
        a."AccountCode" as contra_account_code,
        a."AccountName" as contra_account_name
      FROM bank_transactions bt
      JOIN bank_accounts ba ON ba.id = bt.bank_account_id
      LEFT JOIN bank_categories bc ON bc.id = bt.category_id
      LEFT JOIN accounts a ON a."Id" = bt.contra_account_id
      WHERE ${whereClause}
      ORDER BY bt.transaction_date DESC, bt.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `,
            params
        );

        return {
            transactions: result.rows.map(normalizeBankTransaction),
            total: parseInt(countResult.rows[0].total),
        };
    }

    /**
     * Get transactions across ALL bank accounts (with optional filters)
     */
    static async getAllTransactions(
        options: {
            startDate?: string;
            endDate?: string;
            type?: string;
            categoryId?: string;
            isReconciled?: boolean;
            limit?: number;
            offset?: number;
        } = {},
        dbPool?: pg.Pool
    ): Promise<{ transactions: BankTransaction[]; total: number }> {
        const pool = dbPool || globalPool;
        const conditions: string[] = ['bt.is_reversed = FALSE'];
        const params: (string | number | boolean)[] = [];
        let paramIndex = 1;

        if (options.startDate) {
            conditions.push(`bt.transaction_date >= $${paramIndex++}`);
            params.push(options.startDate);
        }
        if (options.endDate) {
            conditions.push(`bt.transaction_date <= $${paramIndex++}`);
            params.push(options.endDate);
        }
        if (options.type) {
            conditions.push(`bt.type = $${paramIndex++}`);
            params.push(options.type);
        }
        if (options.categoryId) {
            conditions.push(`bt.category_id = $${paramIndex++}`);
            params.push(options.categoryId);
        }
        if (options.isReconciled !== undefined) {
            conditions.push(`bt.is_reconciled = $${paramIndex++}`);
            params.push(options.isReconciled);
        }

        const whereClause = conditions.length > 0 ? conditions.join(' AND ') : 'TRUE';

        // Get total count
        const countResult = await pool.query(
            `
      SELECT COUNT(*) as total FROM bank_transactions bt WHERE ${whereClause}
    `,
            params
        );

        // Get paginated results
        const limit = options.limit || 100;
        const offset = options.offset || 0;

        const result = await pool.query<BankTransactionDbRow>(
            `
      SELECT 
        bt.*,
        ba.name as bank_account_name,
        bc.code as category_code,
        bc.name as category_name,
        a."AccountCode" as contra_account_code,
        a."AccountName" as contra_account_name
      FROM bank_transactions bt
      JOIN bank_accounts ba ON ba.id = bt.bank_account_id
      LEFT JOIN bank_categories bc ON bc.id = bt.category_id
      LEFT JOIN accounts a ON a."Id" = bt.contra_account_id
      WHERE ${whereClause}
      ORDER BY bt.transaction_date DESC, bt.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `,
            params
        );

        return {
            transactions: result.rows.map(normalizeBankTransaction),
            total: parseInt(countResult.rows[0].total),
        };
    }

    /**
     * Get a single transaction by ID
     */
    static async getTransactionById(id: string, dbPool?: pg.Pool): Promise<BankTransaction | null> {
        const pool = dbPool || globalPool;
        const result = await pool.query<BankTransactionDbRow>(
            `
      SELECT 
        bt.*,
        ba.name as bank_account_name,
        bc.code as category_code,
        bc.name as category_name,
        a."AccountCode" as contra_account_code,
        a."AccountName" as contra_account_name
      FROM bank_transactions bt
      JOIN bank_accounts ba ON ba.id = bt.bank_account_id
      LEFT JOIN bank_categories bc ON bc.id = bt.category_id
      LEFT JOIN accounts a ON a."Id" = bt.contra_account_id
      WHERE bt.id = $1
    `,
            [id]
        );

        return result.rows[0] ? normalizeBankTransaction(result.rows[0]) : null;
    }

    /**
     * Create a bank transaction (deposit or withdrawal)
     *
     * ALWAYS posts to GL via AccountingCore
     */
    static async createTransaction(
        dto: CreateBankTransactionDto,
        userId: string,
        dbPool?: pg.Pool
    ): Promise<BankTransaction> {
        const pool = dbPool || globalPool;
        return UnitOfWork.run(pool, async (client) => {
            // Get bank account and its GL account
            const bankAccount = await client.query(
                `
        SELECT ba.*, a."AccountCode" as gl_account_code
        FROM bank_accounts ba
        JOIN accounts a ON a."Id" = ba.gl_account_id
        WHERE ba.id = $1 AND ba.is_active = TRUE
      `,
                [dto.bankAccountId]
            );

            if (bankAccount.rows.length === 0) {
                throw new Error(`Bank account ${dto.bankAccountId} not found or inactive`);
            }

            const bankGlCode = bankAccount.rows[0].gl_account_code;

            // Resolve contra account
            let contraAccountCode: string | null = null;
            let resolvedContraAccountId: string | null = dto.contraAccountId || null;
            if (dto.contraAccountId) {
                const contraAccount = await client.query(
                    `
          SELECT "Id", "AccountCode" FROM accounts WHERE "Id" = $1
        `,
                    [dto.contraAccountId]
                );
                if (contraAccount.rows.length === 0) {
                    throw new Error(`Contra account ${dto.contraAccountId} not found`);
                }
                contraAccountCode = contraAccount.rows[0].AccountCode;
                resolvedContraAccountId = contraAccount.rows[0].Id;
            } else if (dto.categoryId) {
                // Get default account from category
                const category = await client.query(
                    `
          SELECT bc.*, a."Id" as default_account_id, a."AccountCode" as default_account_code
          FROM bank_categories bc
          LEFT JOIN accounts a ON a."Id" = bc.default_account_id
          WHERE bc.id = $1
        `,
                    [dto.categoryId]
                );
                if (category.rows.length > 0 && category.rows[0].default_account_code) {
                    contraAccountCode = category.rows[0].default_account_code;
                    resolvedContraAccountId = category.rows[0].default_account_id || null;
                }
            }

            if (!contraAccountCode) {
                throw new Error(
                    'Offset account is required. Pick a ledger (e.g. Owner Capital 3200) or a category with a default account — same as Journal Entry.'
                );
            }

            // Add Transaction is for external funds (owner capital, drawings, fees).
            // POS owns sales revenue; Customer Payments owns AR collections.
            const sourceType = dto.sourceType || 'MANUAL';
            if (sourceType === 'MANUAL') {
                if (contraAccountCode === '4000') {
                    throw new Error(
                        'Sales revenue is posted by POS, not Add Transaction. Use Owner Capital (3200) for owner capital, or Transfer / Move money to move cash between books.',
                    );
                }
                if (contraAccountCode === '1200') {
                    throw new Error(
                        'Customer invoice collections: use Accounting → Customer Payments so the receipt allocates to an invoice.',
                    );
                }
                if (/^10\d{2}/.test(String(contraAccountCode))) {
                    throw new Error(
                        'Cash↔bank moves use Transfer or Move money, not Add Transaction (Tally Contra / SAP bank transfer).',
                    );
                }
            }

            // Generate transaction number
            const transactionNumber = await BankingService.generateBankTxnNumber(client);
            const transactionId = uuidv4();

            // Determine GL entry pattern based on transaction type
            // DEPOSIT: DR Bank, CR Contra (e.g., Revenue, AR, etc.)
            // WITHDRAWAL: DR Contra (e.g., Expense), CR Bank
            const isInflow = ['DEPOSIT', 'TRANSFER_IN', 'INTEREST'].includes(dto.type);

            const journalRequest: JournalEntryRequest = {
                entryDate: dto.transactionDate,
                description: dto.description,
                referenceType: 'BANK_TXN',
                referenceId: transactionId,
                referenceNumber: transactionNumber,
                lines: [
                    {
                        accountCode: bankGlCode,
                        description: dto.description,
                        debitAmount: isInflow ? dto.amount : 0,
                        creditAmount: isInflow ? 0 : dto.amount,
                    },
                    {
                        accountCode: contraAccountCode,
                        description: dto.description,
                        debitAmount: isInflow ? 0 : dto.amount,
                        creditAmount: isInflow ? dto.amount : 0,
                    },
                ],
                userId,
                idempotencyKey: `BANK-${transactionId}`,
                source: 'BANK_MANUAL',
            };

            // Post to GL (inside UnitOfWork — pass client so GL is atomic with bank_transactions insert)
            const glResult = await AccountingCore.createJournalEntry(journalRequest, undefined, client);

            // Create bank transaction record
            await client.query(
                `
        INSERT INTO bank_transactions (
          id, transaction_number, bank_account_id, transaction_date,
          type, category_id, description, reference, amount,
          contra_account_id, gl_transaction_id, source_type, source_id,
          is_reconciled, is_reversed, created_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, FALSE, FALSE, $14)
      `,
                [
                    transactionId,
                    transactionNumber,
                    dto.bankAccountId,
                    dto.transactionDate,
                    dto.type,
                    dto.categoryId || null,
                    dto.description,
                    dto.reference || null,
                    dto.amount,
                    resolvedContraAccountId,
                    glResult.transactionId,
                    dto.sourceType || 'MANUAL',
                    dto.sourceId || null,
                    userId,
                ]
            );

            // Audit log
            await client.query(
                `
        INSERT INTO audit_log (id, action, entity_type, entity_id, user_id, action_details)
        VALUES ($1, 'CREATE', 'SYSTEM', $2, $3, $4)
      `,
                [
                    uuidv4(),
                    transactionId,
                    userId,
                    JSON.stringify({
                        transactionNumber,
                        type: dto.type,
                        amount: dto.amount,
                        glTransactionId: glResult.transactionId,
                    }),
                ]
            );

            logger.info('Bank transaction created', {
                transactionId,
                transactionNumber,
                type: dto.type,
                amount: dto.amount,
            });

            // Read back on THE SAME client — UnitOfWork is not committed yet, so
            // a separate pool connection cannot see this row (returns null).
            const created = await client.query<BankTransactionDbRow>(
                `
        SELECT 
          bt.*,
          ba.name as bank_account_name,
          bc.code as category_code,
          bc.name as category_name,
          a."AccountCode" as contra_account_code,
          a."AccountName" as contra_account_name
        FROM bank_transactions bt
        JOIN bank_accounts ba ON ba.id = bt.bank_account_id
        LEFT JOIN bank_categories bc ON bc.id = bt.category_id
        LEFT JOIN accounts a ON a."Id" = bt.contra_account_id
        WHERE bt.id = $1
      `,
                [transactionId],
            );
            if (!created.rows[0]) {
                throw new Error('Bank transaction insert did not return a row');
            }
            return normalizeBankTransaction(created.rows[0]);
        }).catch((error: unknown) => {
            logger.error('Failed to create bank transaction', { error, dto });
            throw error;
        });
    }

    /**
     * Create bank-to-bank transfer
     * Creates two linked transactions (TRANSFER_OUT + TRANSFER_IN)
     */
    static async createTransfer(
        dto: CreateTransferDto,
        userId: string,
        dbPool?: pg.Pool
    ): Promise<{
        outTransaction: BankTransaction;
        inTransaction: BankTransaction;
    }> {
        const pool = dbPool || globalPool;
        return UnitOfWork.run(pool, async (client) => {
            // Get both bank accounts (include GL tag for TD-INV-6 messaging)
            const fromAccount = await client.query(
                `
        SELECT ba.*, a."AccountCode" as gl_account_code, a."AccountName" as gl_account_name,
               a."SystemAccountTag" as gl_system_account_tag
        FROM bank_accounts ba
        JOIN accounts a ON a."Id" = ba.gl_account_id
        WHERE ba.id = $1 AND ba.is_active = TRUE
      `,
                [dto.fromAccountId]
            );

            const toAccount = await client.query(
                `
        SELECT ba.*, a."AccountCode" as gl_account_code, a."AccountName" as gl_account_name,
               a."SystemAccountTag" as gl_system_account_tag
        FROM bank_accounts ba
        JOIN accounts a ON a."Id" = ba.gl_account_id
        WHERE ba.id = $1 AND ba.is_active = TRUE
      `,
                [dto.toAccountId]
            );

            if (fromAccount.rows.length === 0) {
                throw new Error(`Source bank account ${dto.fromAccountId} not found`);
            }
            if (toAccount.rows.length === 0) {
                throw new Error(`Destination bank account ${dto.toAccountId} not found`);
            }

            if (dto.fromAccountId === dto.toAccountId) {
                throw new Error('Cannot transfer to the same account');
            }

            const fromGlCode = fromAccount.rows[0].gl_account_code;
            const toGlCode = toAccount.rows[0].gl_account_code;

            // Heal untagged bank GLs, then reject non-liquidity (e.g. AR 1200) with bank names
            await ensureBankGlLiquidityTag(client, fromAccount.rows[0].gl_account_id);
            await ensureBankGlLiquidityTag(client, toAccount.rows[0].gl_account_id);

            const fromTagRow = await client.query<{ SystemAccountTag: string | null }>(
                `SELECT "SystemAccountTag" FROM accounts WHERE "Id" = $1`,
                [fromAccount.rows[0].gl_account_id],
            );
            const toTagRow = await client.query<{ SystemAccountTag: string | null }>(
                `SELECT "SystemAccountTag" FROM accounts WHERE "Id" = $1`,
                [toAccount.rows[0].gl_account_id],
            );
            const fromTag = fromTagRow.rows[0]?.SystemAccountTag ?? fromAccount.rows[0].gl_system_account_tag;
            const toTag = toTagRow.rows[0]?.SystemAccountTag ?? toAccount.rows[0].gl_system_account_tag;

            if (!isEligibleBankBookLiquidity(fromGlCode, fromTag)) {
                throw new Error(
                    `Cannot transfer from "${fromAccount.rows[0].name}" — it is linked to GL ${fromGlCode} ` +
                    `(${fromAccount.rows[0].gl_account_name || 'non-liquidity'}), which is not a Cash/Bank account (TD-INV-6). ` +
                    `Edit the bank account under Banking → Accounts and link it to a bank GL (Create & use this GL), not Accounts Receivable (1200).`,
                );
            }
            if (!isEligibleBankBookLiquidity(toGlCode, toTag)) {
                throw new Error(
                    `Cannot transfer to "${toAccount.rows[0].name}" — it is linked to GL ${toGlCode} ` +
                    `(${toAccount.rows[0].gl_account_name || 'non-liquidity'}), which is not a Cash/Bank account (TD-INV-6). ` +
                    `Edit the bank account under Banking → Accounts and link it to a bank GL (Create & use this GL), not Accounts Receivable (1200).`,
                );
            }

            // Prevent transfers between accounts sharing the same GL account
            // This would create invalid double-entry (DR/CR same account) and incorrect balances
            if (fromAccount.rows[0].gl_account_id === toAccount.rows[0].gl_account_id) {
                throw new Error(
                    `Cannot transfer between "${fromAccount.rows[0].name}" and "${toAccount.rows[0].name}" - ` +
                    `both accounts are linked to the same GL account (${fromGlCode}). ` +
                    `Please assign different GL accounts to track individual balances.`
                );
            }

            // SSOT funds check (posted ledger) before TD or JE
            const { assertSufficientLiquidityFunds } = await import(
                '../modules/treasury/liquidityFundsGuard.js'
            );
            await assertSufficientLiquidityFunds(client, fromGlCode, dto.amount, {
                asOfDate: dto.transactionDate,
                actionLabel: `bank transfer to ${toAccount.rows[0].name}`,
            });

            // Generate transaction numbers (must be distinct — allocate together under one lock)
            const [outTxnNum, inTxnNum] = await BankingService.generateBankTxnNumbers(client, 2);

            const outTxnId = uuidv4();
            const inTxnId = uuidv4();

            const description =
                dto.description || `Transfer from ${fromAccount.rows[0].name} to ${toAccount.rows[0].name}`;

            // Phase 1C: post via Treasury Document when enabled (Rule D + TD-INV-6)
            const { isTreasuryDocumentEnabled } = await import('../modules/treasury/treasurySettings.js');
            const treasuryOn = await isTreasuryDocumentEnabled(client);

            let glTransactionId: string;
            if (treasuryOn) {
                const { createAndPostTransferInTx } = await import(
                    '../modules/treasury/treasuryTransferService.js'
                );
                const td = await createAndPostTransferInTx(client, pool, {
                    transactionDate: dto.transactionDate,
                    fromAccountCode: fromGlCode,
                    toAccountCode: toGlCode,
                    amount: dto.amount,
                    memo: description,
                    depositReference: dto.reference,
                    documentType: 'TREASURY_TRANSFER',
                    createdBy: userId,
                });
                if (!td.journalEntryId) {
                    throw new Error('Treasury Transfer posted without journalEntryId');
                }
                glTransactionId = td.journalEntryId;
            } else {
                // Same liquidity invariant as treasury path (TD-INV-6) — never allow AR/inventory
                // just because treasury_document_enabled is false (local/prod parity).
                const { assertLiquidityAccountsOnly } = await import('@shared/treasury/index.js');
                assertLiquidityAccountsOnly([
                    { accountCode: fromGlCode, systemAccountTag: fromTag },
                    { accountCode: toGlCode, systemAccountTag: toTag },
                ]);

                // GL Entry: DR ToBank, CR FromBank
                const journalRequest: JournalEntryRequest = {
                    entryDate: dto.transactionDate,
                    description,
                    referenceType: 'BANK_TRANSFER',
                    referenceId: outTxnId,
                    referenceNumber: `${outTxnNum}/${inTxnNum}`,
                    lines: [
                        {
                            accountCode: toGlCode,
                            description: `Transfer from ${fromAccount.rows[0].name}`,
                            debitAmount: dto.amount,
                            creditAmount: 0,
                        },
                        {
                            accountCode: fromGlCode,
                            description: `Transfer to ${toAccount.rows[0].name}`,
                            debitAmount: 0,
                            creditAmount: dto.amount,
                        },
                    ],
                    userId,
                    idempotencyKey: `TRANSFER-${outTxnId}`,
                    source: 'TREASURY_TRANSFER',
                };

                const glResult = await AccountingCore.createJournalEntry(journalRequest, undefined, client);
                glTransactionId = glResult.transactionId;
            }

            // Create TRANSFER_OUT transaction first (without transfer_pair_id to avoid FK violation)
            await client.query(
                `
        INSERT INTO bank_transactions (
          id, transaction_number, bank_account_id, transaction_date,
          type, description, reference, amount,
          gl_transaction_id, source_type, transfer_pair_id,
          is_reconciled, is_reversed, created_by
        )
        VALUES ($1, $2, $3, $4, 'TRANSFER_OUT', $5, $6, $7, $8, 'TRANSFER', NULL, FALSE, FALSE, $9)
      `,
                [
                    outTxnId,
                    outTxnNum,
                    dto.fromAccountId,
                    dto.transactionDate,
                    description,
                    dto.reference || null,
                    dto.amount,
                    glTransactionId,
                    userId,
                ]
            );

            // Create TRANSFER_IN transaction (can now reference the OUT transaction)
            await client.query(
                `
        INSERT INTO bank_transactions (
          id, transaction_number, bank_account_id, transaction_date,
          type, description, reference, amount,
          gl_transaction_id, source_type, transfer_pair_id,
          is_reconciled, is_reversed, created_by
        )
        VALUES ($1, $2, $3, $4, 'TRANSFER_IN', $5, $6, $7, $8, 'TRANSFER', $9, FALSE, FALSE, $10)
      `,
                [
                    inTxnId,
                    inTxnNum,
                    dto.toAccountId,
                    dto.transactionDate,
                    description,
                    dto.reference || null,
                    dto.amount,
                    glTransactionId,
                    outTxnId,
                    userId,
                ]
            );

            // Now update the OUT transaction to link to the IN transaction
            await client.query(
                `
        UPDATE bank_transactions SET transfer_pair_id = $1 WHERE id = $2
      `,
                [inTxnId, outTxnId]
            );

            logger.info('Bank transfer created', {
                outTxnId,
                inTxnId,
                amount: dto.amount,
            });

            return {
                outTransaction: (await this.getTransactionById(outTxnId))!,
                inTransaction: (await this.getTransactionById(inTxnId))!,
            };
        });
    }

    /**
     * Reverse a bank transaction
     * Creates a reversing entry (immutability principle)
     */
    static async reverseTransaction(
        dto: ReverseBankTransactionDto,
        userId: string,
        dbPool?: pg.Pool
    ): Promise<BankTransaction> {
        const pool = dbPool || globalPool;

        const existing = await pool.query<BankTransactionDbRow>(
            `SELECT * FROM bank_transactions WHERE id = $1`,
            [dto.transactionId],
        );
        if (existing.rows.length === 0) {
            throw new Error(`Transaction ${dto.transactionId} not found`);
        }
        const existingTxn = existing.rows[0];
        if (existingTxn.is_reversed) {
            throw new Error(`Transaction ${dto.transactionId} is already reversed`);
        }
        if (existingTxn.is_reconciled) {
            throw new Error(
                `Transaction ${dto.transactionId} is reconciled and cannot be reversed. Unreconcile first or post a correcting transfer.`,
            );
        }

        // Posted liquidity documents own the JE — reverse the document (opposite TD + bank flags).
        // Must run outside this method's UnitOfWork (treasury reverse starts its own).
        if (existingTxn.gl_transaction_id) {
            const td = await pool.query<{ id: string }>(
                `SELECT id FROM treasury_documents
                  WHERE journal_entry_id = $1
                    AND reversed_by_document_id IS NULL
                    AND status = 'POSTED'
                    AND document_type <> 'TREASURY_REVERSAL'
                  LIMIT 1`,
                [existingTxn.gl_transaction_id],
            );
            if (td.rows[0]?.id) {
                const { reverse: reverseTreasuryDocument } = await import(
                    '../modules/treasury/treasuryService.js'
                );
                await reverseTreasuryDocument(pool, td.rows[0].id, userId, dto.reason);
                const updated = await this.getTransactionById(dto.transactionId, pool);
                if (!updated) {
                    throw new Error(`Transaction ${dto.transactionId} not found after treasury reverse`);
                }
                logger.info('Bank transaction reversed via Treasury Document', {
                    originalId: dto.transactionId,
                    treasuryDocumentId: td.rows[0].id,
                    reason: dto.reason,
                });
                return updated;
            }
        }

        return UnitOfWork.run(pool, async (client) => {
            // Get original transaction
            const original = await client.query<BankTransactionDbRow>(
                `
        SELECT * FROM bank_transactions WHERE id = $1
      `,
                [dto.transactionId]
            );

            if (original.rows.length === 0) {
                throw new Error(`Transaction ${dto.transactionId} not found`);
            }

            const origTxn = original.rows[0];

            if (origTxn.is_reversed) {
                throw new Error(`Transaction ${dto.transactionId} is already reversed`);
            }

            if (origTxn.is_reconciled) {
                throw new Error(
                    `Transaction ${dto.transactionId} is reconciled and cannot be reversed. Unreconcile first or post a correcting transfer.`,
                );
            }

            if (!origTxn.gl_transaction_id) {
                throw new Error(`Transaction ${dto.transactionId} has no GL entry to reverse`);
            }

            let pairTxn: BankTransactionDbRow | null = null;
            if (origTxn.transfer_pair_id) {
                const pairRes = await client.query<BankTransactionDbRow>(
                    `SELECT * FROM bank_transactions WHERE id = $1`,
                    [origTxn.transfer_pair_id],
                );
                pairTxn = pairRes.rows[0] ?? null;
                if (pairTxn?.is_reconciled) {
                    throw new Error(
                        `Transfer pair ${pairTxn.transaction_number} is reconciled and cannot be reversed.`,
                    );
                }
                if (pairTxn?.is_reversed) {
                    throw new Error(`Transfer pair ${pairTxn.transaction_number} is already reversed`);
                }
            }

            // Reverse the GL entry once (shared by TRANSFER_OUT + TRANSFER_IN)
            await AccountingCore.reverseTransaction(
                {
                    originalTransactionId: origTxn.gl_transaction_id,
                    reversalDate: getBusinessDate(),
                    reason: dto.reason,
                    userId,
                    idempotencyKey: `REV-${dto.transactionId}`,
                },
                dbPool
            );

            // Generate reversal transaction number
            const revTxnNum = await BankingService.generateBankTxnNumber(client);
            const revTxnId = uuidv4();

            // Create reversal bank transaction for the selected leg
            const reversalType =
                origTxn.type.startsWith('DEPOSIT') ||
                    origTxn.type === 'TRANSFER_IN' ||
                    origTxn.type === 'INTEREST'
                    ? 'WITHDRAWAL'
                    : 'DEPOSIT';

            await client.query(
                `
        INSERT INTO bank_transactions (
          id, transaction_number, bank_account_id, transaction_date,
          type, category_id, description, reference, amount,
          contra_account_id, source_type,
          is_reconciled, is_reversed, created_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'MANUAL', FALSE, FALSE, $11)
      `,
                [
                    revTxnId,
                    revTxnNum,
                    origTxn.bank_account_id,
                    getBusinessDate(),
                    reversalType,
                    origTxn.category_id,
                    `REVERSAL: ${dto.reason}`,
                    `REV-${origTxn.transaction_number}`,
                    origTxn.amount,
                    origTxn.contra_account_id,
                    userId,
                ]
            );

            // Mark original as reversed
            await client.query(
                `
        UPDATE bank_transactions
        SET is_reversed = TRUE,
            reversed_at = NOW(),
            reversed_by = $2,
            reversal_reason = $3,
            reversal_transaction_id = $4
        WHERE id = $1
      `,
                [dto.transactionId, userId, dto.reason, revTxnId]
            );

            // Transfer pair: create countering bank row + mark pair reversed (GL already reversed once)
            if (pairTxn) {
                const pairRevType =
                    pairTxn.type === 'TRANSFER_IN' || pairTxn.type.startsWith('DEPOSIT')
                        ? 'WITHDRAWAL'
                        : 'DEPOSIT';
                const pairRevId = uuidv4();
                const pairRevNum = await BankingService.generateBankTxnNumber(client);
                await client.query(
                    `
          INSERT INTO bank_transactions (
            id, transaction_number, bank_account_id, transaction_date,
            type, category_id, description, reference, amount,
            contra_account_id, source_type, transfer_pair_id,
            is_reconciled, is_reversed, created_by
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'MANUAL', $11, FALSE, FALSE, $12)
        `,
                    [
                        pairRevId,
                        pairRevNum,
                        pairTxn.bank_account_id,
                        getBusinessDate(),
                        pairRevType,
                        pairTxn.category_id,
                        `REVERSAL: ${dto.reason}`,
                        `REV-${pairTxn.transaction_number}`,
                        pairTxn.amount,
                        pairTxn.contra_account_id,
                        revTxnId,
                        userId,
                    ],
                );
                await client.query(
                    `
          UPDATE bank_transactions
          SET is_reversed = TRUE,
              reversed_at = NOW(),
              reversed_by = $2,
              reversal_reason = $3,
              reversal_transaction_id = $4
          WHERE id = $1
        `,
                    [pairTxn.id, userId, dto.reason, pairRevId],
                );
            }

            logger.info('Bank transaction reversed', {
                originalId: dto.transactionId,
                reversalId: revTxnId,
                pairId: pairTxn?.id ?? null,
                reason: dto.reason,
            });

            return (await this.getTransactionById(revTxnId))!;
        });
    }

    // ---------------------------------------------------------------------------
    // CATEGORIES
    // ---------------------------------------------------------------------------

    /**
     * Get all bank categories
     */
    static async getCategories(direction?: 'IN' | 'OUT', dbPool?: pg.Pool): Promise<BankCategory[]> {
        const pool = dbPool || globalPool;
        const conditions: string[] = ['bc.is_active = TRUE'];
        const params: string[] = [];

        if (direction) {
            conditions.push(`bc.direction = $1`);
            params.push(direction);
        }

        const result = await pool.query<BankCategoryDbRow>(
            `
      SELECT 
        bc.*,
        a."AccountCode" as default_account_code,
        a."AccountName" as default_account_name
      FROM bank_categories bc
      LEFT JOIN accounts a ON a."Id" = bc.default_account_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY bc.display_order, bc.name
    `,
            params
        );

        return result.rows.map(normalizeBankCategory);
    }

    // ---------------------------------------------------------------------------
    // PATTERN MATCHING
    // ---------------------------------------------------------------------------

    /**
     * Find matching patterns for a description and amount
     */
    static async findMatchingPatterns(
        description: string,
        amount: number,
        direction: 'IN' | 'OUT',
        dbPool?: pg.Pool
    ): Promise<BankPattern[]> {
        const pool = dbPool || globalPool;
        const result = await pool.query<BankPatternDbRow>(`
      SELECT 
        p.*,
        bc.name as category_name,
        a."AccountName" as contra_account_name
      FROM bank_transaction_patterns p
      LEFT JOIN bank_categories bc ON bc.id = p.category_id
      LEFT JOIN accounts a ON a."Id" = p.contra_account_id
      WHERE p.is_active = TRUE
      ORDER BY p.confidence DESC, p.times_used DESC
    `);

        const matches: BankPattern[] = [];
        const descLower = description.toLowerCase();

        for (const row of result.rows) {
            const pattern = normalizeBankPattern(row);
            const rules = pattern.matchRules;

            // Check direction
            if (rules.direction && rules.direction !== direction) continue;

            // Check amount range
            if (rules.amountMin !== undefined && amount < rules.amountMin) continue;
            if (rules.amountMax !== undefined && amount > rules.amountMax) continue;

            // Check description contains
            if (rules.descriptionContains && rules.descriptionContains.length > 0) {
                const hasMatch = rules.descriptionContains.some((term) =>
                    descLower.includes(term.toLowerCase())
                );
                if (!hasMatch) continue;
            }

            // Check regex
            if (rules.descriptionRegex) {
                try {
                    const regex = new RegExp(rules.descriptionRegex, 'i');
                    if (!regex.test(description)) continue;
                } catch {
                    // Invalid regex, skip this rule
                    continue;
                }
            }

            matches.push(pattern);
        }

        return matches;
    }

    /**
     * Learn a new pattern from user categorization
     */
    static async learnPattern(
        description: string,
        amount: number,
        direction: 'IN' | 'OUT',
        categoryId: string | null,
        contraAccountId: string | null,
        userId: string,
        dbPool?: pg.Pool
    ): Promise<BankPattern> {
        const pool = dbPool || globalPool;
        // Extract key terms from description
        const terms = description
            .split(/\s+/)
            .filter((t) => t.length >= 4)
            .slice(0, 5)
            .map((t) => t.toUpperCase());

        if (terms.length === 0) {
            // Can't learn from empty description
            throw new Error('Description too short to learn pattern');
        }

        const matchRules: PatternMatchRules = {
            descriptionContains: terms,
            direction,
        };

        const id = uuidv4();
        const result = await pool.query<BankPatternDbRow>(
            `
      INSERT INTO bank_transaction_patterns (
        id, name, match_rules, category_id, contra_account_id,
        confidence, times_used, auto_apply_threshold,
        is_system, is_active, created_by
      )
      VALUES ($1, $2, $3, $4, $5, 50, 1, 90, FALSE, TRUE, $6)
      RETURNING *
    `,
            [
                id,
                `Pattern from: ${terms.join(' ')}`,
                JSON.stringify(matchRules),
                categoryId,
                contraAccountId,
                userId,
            ]
        );

        logger.info('New pattern learned', { id, terms, direction });

        return normalizeBankPattern(result.rows[0]);
    }

    /**
     * Update pattern confidence based on user feedback
     */
    static async updatePatternConfidence(
        patternId: string,
        accepted: boolean,
        dbPool?: pg.Pool
    ): Promise<void> {
        const pool = dbPool || globalPool;
        if (accepted) {
            await pool.query(
                `
        UPDATE bank_transaction_patterns
        SET times_used = times_used + 1,
            confidence = LEAST(100, confidence + 5),
            last_used_at = NOW(),
            updated_at = NOW()
        WHERE id = $1
      `,
                [patternId]
            );
        } else {
            await pool.query(
                `
        UPDATE bank_transaction_patterns
        SET times_rejected = times_rejected + 1,
            confidence = GREATEST(0, confidence - 10),
            updated_at = NOW()
        WHERE id = $1
      `,
                [patternId]
            );
        }
    }

    // ---------------------------------------------------------------------------
    // ALERTS
    // ---------------------------------------------------------------------------

    /**
     * Get active alerts
     */
    static async getAlerts(
        status: 'NEW' | 'REVIEWED' | 'DISMISSED' | 'RESOLVED' = 'NEW',
        dbPool?: pg.Pool
    ): Promise<BankAlert[]> {
        const pool = dbPool || globalPool;
        const result = await pool.query<BankAlertDbRow>(
            `
      SELECT 
        al.*,
        ba.name as bank_account_name,
        bt.transaction_number
      FROM bank_alerts al
      LEFT JOIN bank_accounts ba ON ba.id = al.bank_account_id
      LEFT JOIN bank_transactions bt ON bt.id = al.transaction_id
      WHERE al.status = $1
      ORDER BY 
        CASE al.severity 
          WHEN 'CRITICAL' THEN 1 
          WHEN 'WARNING' THEN 2 
          ELSE 3 
        END,
        al.created_at DESC
    `,
            [status]
        );

        return result.rows.map(normalizeBankAlert);
    }

    /**
     * Create an alert
     */
    static async createAlert(
        alertType: BankAlert['alertType'],
        severity: BankAlert['severity'],
        message: string,
        options: {
            bankAccountId?: string;
            transactionId?: string;
            statementLineId?: string;
            details?: Record<string, unknown>;
        } = {},
        dbPool?: pg.Pool
    ): Promise<BankAlert> {
        const pool = dbPool || globalPool;
        const id = uuidv4();

        await pool.query(
            `
      INSERT INTO bank_alerts (
        id, bank_account_id, transaction_id, statement_line_id,
        alert_type, severity, message, details, status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'NEW')
    `,
            [
                id,
                options.bankAccountId || null,
                options.transactionId || null,
                options.statementLineId || null,
                alertType,
                severity,
                message,
                options.details ? JSON.stringify(options.details) : null,
            ]
        );

        logger.warn('Bank alert created', { alertType, severity, message });

        const result = await pool.query<BankAlertDbRow>(
            `
      SELECT * FROM bank_alerts WHERE id = $1
    `,
            [id]
        );

        return normalizeBankAlert(result.rows[0]);
    }

    /**
     * Dismiss or resolve an alert
     */
    static async updateAlertStatus(
        alertId: string,
        status: 'REVIEWED' | 'DISMISSED' | 'RESOLVED',
        notes: string | null,
        userId: string,
        dbPool?: pg.Pool
    ): Promise<void> {
        const pool = dbPool || globalPool;
        await pool.query(
            `
      UPDATE bank_alerts
      SET status = $2,
          resolution_notes = $3,
          reviewed_by = $4,
          reviewed_at = NOW()
      WHERE id = $1
    `,
            [alertId, status, notes, userId]
        );
    }

    // ---------------------------------------------------------------------------
    // RECONCILIATION
    // ---------------------------------------------------------------------------

    /**
     * Mark transactions as reconciled (bank statement match).
     * Accuracy contract (classic / QBO style):
     *   cleared = last_reconciled_balance (0 if never) + Σ selected (in − out)
     *   difference = statementEnding − cleared
     * Refuses to post when |difference| > 0.01 — no silent inconsistency.
     */
    static async reconcileTransactions(
        bankAccountId: string,
        transactionIds: string[],
        statementBalance: number,
        userId: string,
        dbPool?: pg.Pool,
        statementDate?: string,
    ): Promise<{
        reconciledCount: number;
        difference: number;
        newBalance: number;
        clearedBalance: number;
        bookBalance: number;
        lastReconciledBalance: number;
    }> {
        const pool = dbPool || globalPool;
        if (!transactionIds.length) {
            throw new Error('Select at least one transaction to reconcile');
        }
        return UnitOfWork.run(pool, async (client) => {
            const accountResult = await client.query<{
                id: string;
                last_reconciled_balance: string | null;
            }>(
                `SELECT id, last_reconciled_balance FROM bank_accounts WHERE id = $1 AND is_active = TRUE`,
                [bankAccountId],
            );
            if (accountResult.rows.length === 0) {
                throw new Error(`Bank account ${bankAccountId} not found or inactive`);
            }

            const lastReconciledBalance = Money.toNumber(
                Money.round(Number(accountResult.rows[0]!.last_reconciled_balance ?? 0)),
            );

            const txnResult = await client.query<{
                id: string;
                type: string;
                amount: string;
                transaction_date: string;
                is_reconciled: boolean;
                is_reversed: boolean;
            }>(
                `
        SELECT id, type, amount::text, transaction_date::text, is_reconciled, is_reversed
        FROM bank_transactions
        WHERE bank_account_id = $1
          AND id = ANY($2::uuid[])
      `,
                [bankAccountId, transactionIds],
            );

            if (txnResult.rows.length !== transactionIds.length) {
                throw new Error('One or more transactions were not found on this bank account');
            }
            for (const row of txnResult.rows) {
                if (row.is_reversed) {
                    throw new Error(`Transaction ${row.id} is reversed and cannot be reconciled`);
                }
                if (row.is_reconciled) {
                    throw new Error(`Transaction ${row.id} is already reconciled`);
                }
                if (statementDate) {
                    const txnDay = String(row.transaction_date).slice(0, 10);
                    if (txnDay > statementDate) {
                        throw new Error(
                            `Transaction dated ${txnDay} is after statement date ${statementDate}`,
                        );
                    }
                }
            }

            const selected = txnResult.rows.map((r) => ({
                type: r.type,
                amount: parseFloat(r.amount),
            }));
            const clearedBalance = computeClearedBalance(lastReconciledBalance, selected);
            const difference = computeReconciliationDifference(statementBalance, clearedBalance);

            if (!isReconciliationBalanced(difference)) {
                throw new ValidationError(
                    `Reconciliation unbalanced: statement ${statementBalance.toFixed(2)} vs cleared ${clearedBalance.toFixed(2)} ` +
                        `(difference ${difference.toFixed(2)}). ` +
                        `Cleared = last reconciled ${lastReconciledBalance.toFixed(2)} + selected net. ` +
                        `Adjust selected transactions or the statement ending balance.`,
                );
            }

            const updateResult = await client.query(
                `
        UPDATE bank_transactions
        SET is_reconciled = TRUE,
            reconciled_at = NOW(),
            reconciled_by = $3
        WHERE bank_account_id = $1
          AND id = ANY($2::uuid[])
          AND is_reconciled = FALSE
          AND is_reversed = FALSE
      `,
                [bankAccountId, transactionIds, userId],
            );

            // Book (GL) balance — informational; recon gate uses cleared balance, not GL vs statement.
            const balanceResult = await client.query<{ current_balance: string }>(
                `
        SELECT ${BANK_GL_BALANCE_SQL}::text as current_balance
        FROM bank_accounts ba
        WHERE ba.id = $1
      `,
                [bankAccountId],
            );
            const bookBalance = parseFloat(balanceResult.rows[0]?.current_balance ?? '0');

            await client.query(
                `
        UPDATE bank_accounts
        SET last_reconciled_balance = $2,
            last_reconciled_at = NOW(),
            updated_at = NOW()
        WHERE id = $1
      `,
                [bankAccountId, statementBalance],
            );

            return {
                reconciledCount: updateResult.rowCount || 0,
                difference: 0,
                newBalance: statementBalance,
                clearedBalance,
                bookBalance,
                lastReconciledBalance,
            };
        });
    }

    // ---------------------------------------------------------------------------
    // RECURRING TRANSACTION RULES
    // ---------------------------------------------------------------------------

    /**
     * Get all recurring rules for a bank account
     */
    static async getRecurringRules(
        bankAccountId?: string,
        dbPool?: pg.Pool
    ): Promise<BankRecurringRule[]> {
        const pool = dbPool || globalPool;
        const conditions: string[] = ['r.is_active = TRUE'];
        const params: string[] = [];

        if (bankAccountId) {
            params.push(bankAccountId);
            conditions.push(`r.bank_account_id = $${params.length}`);
        }

        const result = await pool.query<BankRecurringRuleDbRow>(
            `
      SELECT 
        r.*,
        ba.name as bank_account_name,
        bc.name as category_name,
        a."AccountName" as contra_account_name
      FROM bank_recurring_rules r
      JOIN bank_accounts ba ON ba.id = r.bank_account_id
      LEFT JOIN bank_categories bc ON bc.id = r.category_id
      LEFT JOIN accounts a ON a."Id" = r.contra_account_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY r.name
    `,
            params
        );

        return result.rows.map(normalizeBankRecurringRule);
    }

    /**
     * Get a recurring rule by ID
     */
    static async getRecurringRuleById(
        id: string,
        dbPool?: pg.Pool
    ): Promise<BankRecurringRule | null> {
        const pool = dbPool || globalPool;
        const result = await pool.query<BankRecurringRuleDbRow>(
            `
      SELECT 
        r.*,
        ba.name as bank_account_name,
        bc.name as category_name,
        a."AccountName" as contra_account_name
      FROM bank_recurring_rules r
      JOIN bank_accounts ba ON ba.id = r.bank_account_id
      LEFT JOIN bank_categories bc ON bc.id = r.category_id
      LEFT JOIN accounts a ON a."Id" = r.contra_account_id
      WHERE r.id = $1
    `,
            [id]
        );

        return result.rows.length > 0 ? normalizeBankRecurringRule(result.rows[0]) : null;
    }

    /**
     * Create a new recurring rule
     */
    static async createRecurringRule(
        dto: CreateRecurringRuleDto,
        userId: string,
        dbPool?: pg.Pool
    ): Promise<BankRecurringRule> {
        const pool = dbPool || globalPool;
        const id = uuidv4();

        // Calculate next expected date based on frequency and day
        const nextExpected = this.calculateNextExpectedDate(dto.frequency, dto.expectedDay);

        await pool.query(
            `
      INSERT INTO bank_recurring_rules (
        id, name, bank_account_id, match_rules,
        frequency, expected_day, expected_amount, tolerance_percent,
        category_id, contra_account_id, next_expected_at,
        is_active, created_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, TRUE, $12)
    `,
            [
                id,
                dto.name,
                dto.bankAccountId,
                JSON.stringify(dto.matchRules),
                dto.frequency,
                dto.expectedDay,
                dto.expectedAmount,
                dto.tolerancePercent ?? 10,
                dto.categoryId || null,
                dto.contraAccountId || null,
                nextExpected,
                userId,
            ]
        );

        logger.info('Recurring rule created', { id, name: dto.name });

        return (await this.getRecurringRuleById(id))!;
    }

    /**
     * Update a recurring rule
     */
    static async updateRecurringRule(
        id: string,
        dto: UpdateRecurringRuleDto,
        dbPool?: pg.Pool
    ): Promise<BankRecurringRule> {
        const pool = dbPool || globalPool;
        const updates: string[] = [];
        const params: unknown[] = [id];
        let paramIndex = 2;

        if (dto.name !== undefined) {
            updates.push(`name = $${paramIndex++}`);
            params.push(dto.name);
        }
        if (dto.matchRules !== undefined) {
            updates.push(`match_rules = $${paramIndex++}`);
            params.push(JSON.stringify(dto.matchRules));
        }
        if (dto.frequency !== undefined) {
            updates.push(`frequency = $${paramIndex++}`);
            params.push(dto.frequency);
        }
        if (dto.expectedDay !== undefined) {
            updates.push(`expected_day = $${paramIndex++}`);
            params.push(dto.expectedDay);
        }
        if (dto.expectedAmount !== undefined) {
            updates.push(`expected_amount = $${paramIndex++}`);
            params.push(dto.expectedAmount);
        }
        if (dto.tolerancePercent !== undefined) {
            updates.push(`tolerance_percent = $${paramIndex++}`);
            params.push(dto.tolerancePercent);
        }
        if (dto.categoryId !== undefined) {
            updates.push(`category_id = $${paramIndex++}`);
            params.push(dto.categoryId || null);
        }
        if (dto.contraAccountId !== undefined) {
            updates.push(`contra_account_id = $${paramIndex++}`);
            params.push(dto.contraAccountId || null);
        }
        if (dto.isActive !== undefined) {
            updates.push(`is_active = $${paramIndex++}`);
            params.push(dto.isActive);
        }

        if (updates.length > 0) {
            await pool.query(
                `
        UPDATE bank_recurring_rules
        SET ${updates.join(', ')}
        WHERE id = $1
      `,
                params
            );
        }

        return (await this.getRecurringRuleById(id))!;
    }

    /**
     * Delete a recurring rule
     */
    static async deleteRecurringRule(id: string, dbPool?: pg.Pool): Promise<void> {
        const pool = dbPool || globalPool;
        await pool.query(
            `
      UPDATE bank_recurring_rules
      SET is_active = FALSE
      WHERE id = $1
    `,
            [id]
        );
    }

    /**
     * Check for overdue recurring transactions and create alerts
     */
    static async checkOverdueRecurring(dbPool?: pg.Pool): Promise<number> {
        const pool = dbPool || globalPool;
        // Find rules where next_expected_at is in the past
        const result = await pool.query<BankRecurringRuleDbRow>(`
      SELECT r.*, ba.name as bank_account_name
      FROM bank_recurring_rules r
      JOIN bank_accounts ba ON ba.id = r.bank_account_id
      WHERE r.is_active = TRUE
        AND r.next_expected_at < CURRENT_DATE
    `);

        let alertCount = 0;

        for (const row of result.rows) {
            const rule = normalizeBankRecurringRule(row);

            // Check if there's a matching transaction since last_matched_at
            const matchResult = await pool.query(
                `
        SELECT COUNT(*) as cnt
        FROM bank_transactions bt
        WHERE bt.bank_account_id = $1
          AND bt.transaction_date >= $2
          AND bt.is_reversed = FALSE
          AND ABS(bt.amount - $3) <= ($3 * $4 / 100)
      `,
                [
                    rule.bankAccountId,
                    rule.lastMatchedAt || rule.nextExpectedAt,
                    rule.expectedAmount,
                    rule.tolerancePercent,
                ]
            );

            if (parseInt(matchResult.rows[0].cnt) === 0) {
                // No matching transaction found - create alert
                await this.createAlert(
                    'OVERDUE_RECURRING',
                    'WARNING',
                    `Expected recurring transaction "${rule.name}" is overdue`,
                    {
                        bankAccountId: rule.bankAccountId,
                        details: {
                            ruleId: rule.id,
                            ruleName: rule.name,
                            expectedAmount: rule.expectedAmount,
                            expectedDate: rule.nextExpectedAt,
                        },
                    }
                );
                alertCount++;

                // Increment miss count
                await pool.query(
                    `
          UPDATE bank_recurring_rules
          SET miss_count = miss_count + 1,
              next_expected_at = $2
          WHERE id = $1
        `,
                    [rule.id, this.calculateNextExpectedDate(rule.frequency, rule.expectedDay)]
                );
            }
        }

        return alertCount;
    }

    /**
     * Match a transaction to recurring rules and update tracking
     */
    static async matchToRecurringRules(
        transaction: BankTransaction,
        dbPool?: pg.Pool
    ): Promise<void> {
        const pool = dbPool || globalPool;
        const rules = await this.getRecurringRules(transaction.bankAccountId);

        for (const rule of rules) {
            // Check if amount is within tolerance
            const tolerance = new Decimal(rule.expectedAmount)
                .times(rule.tolerancePercent)
                .dividedBy(100);
            if (new Decimal(transaction.amount).minus(rule.expectedAmount).abs().greaterThan(tolerance)) {
                continue;
            }

            // Check match rules
            const descLower = transaction.description.toLowerCase();
            const matchRules = rule.matchRules;

            let matches = true;
            if (matchRules.descriptionContains && matchRules.descriptionContains.length > 0) {
                matches = matchRules.descriptionContains.some((term) =>
                    descLower.includes(term.toLowerCase())
                );
            }
            if (matches && matchRules.descriptionRegex) {
                try {
                    const regex = new RegExp(matchRules.descriptionRegex, 'i');
                    matches = regex.test(transaction.description);
                } catch {
                    // Invalid regex
                    matches = false;
                }
            }

            if (matches) {
                // Update rule tracking
                await pool.query(
                    `
          UPDATE bank_recurring_rules
          SET last_matched_at = NOW(),
              last_matched_amount = $2,
              next_expected_at = $3,
              miss_count = 0
          WHERE id = $1
        `,
                    [
                        rule.id,
                        transaction.amount,
                        this.calculateNextExpectedDate(rule.frequency, rule.expectedDay),
                    ]
                );

                logger.info('Transaction matched to recurring rule', {
                    transactionId: transaction.id,
                    ruleId: rule.id,
                    ruleName: rule.name,
                });

                break; // Only match to first rule
            }
        }
    }

    /**
     * Calculate next expected date based on frequency
     */
    private static calculateNextExpectedDate(frequency: string, expectedDay: number): string {
        const today = new Date();
        const nextDate = new Date(today);

        switch (frequency) {
            case 'WEEKLY': {
                // expectedDay = day of week (1=Mon, 7=Sun)
                const currentDayOfWeek = today.getDay() || 7; // Convert 0 to 7 for Sunday
                let daysUntil = expectedDay - currentDayOfWeek;
                if (daysUntil <= 0) daysUntil += 7;
                nextDate.setDate(today.getDate() + daysUntil);
                break;
            }

            case 'BIWEEKLY': {
                const currentDow = today.getDay() || 7;
                let days = expectedDay - currentDow;
                if (days <= 0) days += 14;
                else days += 7; // Add extra week for biweekly
                nextDate.setDate(today.getDate() + days);
                break;
            }

            case 'MONTHLY':
                // expectedDay = day of month (1-31)
                nextDate.setMonth(today.getMonth() + 1);
                nextDate.setDate(
                    Math.min(
                        expectedDay,
                        new Date(nextDate.getFullYear(), nextDate.getMonth() + 1, 0).getDate()
                    )
                );
                break;

            case 'QUARTERLY':
                nextDate.setMonth(today.getMonth() + 3);
                nextDate.setDate(
                    Math.min(
                        expectedDay,
                        new Date(nextDate.getFullYear(), nextDate.getMonth() + 1, 0).getDate()
                    )
                );
                break;

            case 'YEARLY':
                nextDate.setFullYear(today.getFullYear() + 1);
                nextDate.setDate(
                    Math.min(
                        expectedDay,
                        new Date(nextDate.getFullYear(), nextDate.getMonth() + 1, 0).getDate()
                    )
                );
                break;
        }

        return formatDateBusiness(nextDate);
    }

    // ---------------------------------------------------------------------------
    // LOW BALANCE ALERTS
    // ---------------------------------------------------------------------------

    /**
     * Set low balance threshold for an account
     */
    static async setLowBalanceThreshold(
        bankAccountId: string,
        threshold: number,
        enabled: boolean,
        dbPool?: pg.Pool
    ): Promise<void> {
        const pool = dbPool || globalPool;
        // Store threshold in bank_accounts table using a JSONB settings column
        // For now, we'll add columns if they don't exist
        await pool.query(
            `
      UPDATE bank_accounts
      SET low_balance_threshold = $2,
          low_balance_alert_enabled = $3,
          updated_at = NOW()
      WHERE id = $1
    `,
            [bankAccountId, threshold, enabled]
        );
    }

    /**
     * Check all accounts for low balance and create alerts
     */
    static async checkLowBalanceAlerts(dbPool?: pg.Pool): Promise<number> {
        const pool = dbPool || globalPool;
        const result = await pool.query(`
      SELECT 
        ba.id,
        ba.name,
        ba.low_balance_threshold,
        ${BANK_GL_BALANCE_SQL} as current_balance
      FROM bank_accounts ba
      WHERE ba.is_active = TRUE
        AND ba.low_balance_alert_enabled = TRUE
        AND ba.low_balance_threshold IS NOT NULL
    `);

        let alertCount = 0;

        for (const row of result.rows) {
            const balance = parseFloat(row.current_balance);
            const threshold = parseFloat(row.low_balance_threshold);

            if (balance < threshold) {
                // Check if we already have an active alert for this
                const existingAlert = await pool.query(
                    `
          SELECT id FROM bank_alerts
          WHERE bank_account_id = $1
            AND alert_type = 'LOW_BALANCE'
            AND status = 'NEW'
        `,
                    [row.id]
                );

                if (existingAlert.rows.length === 0) {
                    await this.createAlert(
                        'LOW_BALANCE',
                        balance < 0 ? 'CRITICAL' : 'WARNING',
                        `Account "${row.name}" balance (${balance.toFixed(2)}) is below threshold (${threshold.toFixed(2)})`,
                        {
                            bankAccountId: row.id,
                            details: {
                                currentBalance: balance,
                                threshold,
                            },
                        }
                    );
                    alertCount++;
                }
            }
        }

        return alertCount;
    }

    // ---------------------------------------------------------------------------
    // BANK REPORTS
    // ---------------------------------------------------------------------------

    /**
     * Get bank account summary report
     */
    static async getAccountSummaries(dbPool?: pg.Pool): Promise<BankAccountSummary[]> {
        const pool = dbPool || globalPool;
        const result = await pool.query(`
      SELECT 
        ba.id,
        ba.name,
        ba.bank_name,
        -- Current balance from GL (net-active reverse pairs)
        ${BANK_GL_BALANCE_SQL} as current_balance,
        ba.last_reconciled_balance,
        ba.last_reconciled_at,
        -- Unreconciled count
        (SELECT COUNT(*) FROM bank_transactions bt 
         WHERE bt.bank_account_id = ba.id 
           AND bt.is_reconciled = FALSE 
           AND bt.is_reversed = FALSE) as unreconciled_count,
        -- This month deposits
        COALESCE((
          SELECT SUM(bt.amount) 
          FROM bank_transactions bt 
          WHERE bt.bank_account_id = ba.id 
            AND bt.type IN ('DEPOSIT', 'TRANSFER_IN', 'INTEREST')
            AND bt.is_reversed = FALSE
            AND bt.transaction_date >= DATE_TRUNC('month', CURRENT_DATE)
        ), 0) as total_deposits_this_month,
        -- This month withdrawals
        COALESCE((
          SELECT SUM(bt.amount) 
          FROM bank_transactions bt 
          WHERE bt.bank_account_id = ba.id 
            AND bt.type IN ('WITHDRAWAL', 'TRANSFER_OUT', 'FEE')
            AND bt.is_reversed = FALSE
            AND bt.transaction_date >= DATE_TRUNC('month', CURRENT_DATE)
        ), 0) as total_withdrawals_this_month
      FROM bank_accounts ba
      WHERE ba.is_active = TRUE
      ORDER BY ba.is_default DESC, ba.name
    `);

        return result.rows.map((row) => ({
            id: row.id,
            name: row.name,
            bankName: row.bank_name,
            currentBalance: parseFloat(row.current_balance),
            lastReconciledBalance: row.last_reconciled_balance
                ? parseFloat(row.last_reconciled_balance)
                : undefined,
            lastReconciledAt: row.last_reconciled_at,
            unreconciledCount: parseInt(row.unreconciled_count),
            totalDepositsThisMonth: parseFloat(row.total_deposits_this_month),
            totalWithdrawalsThisMonth: parseFloat(row.total_withdrawals_this_month),
        }));
    }

    /**
     * Get activity report for a bank account
     */
    static async getActivityReport(
        bankAccountId: string,
        periodStart: string,
        periodEnd: string,
        dbPool?: pg.Pool
    ): Promise<BankActivityReport> {
        const pool = dbPool || globalPool;
        const account = await this.getAccountById(bankAccountId);
        if (!account) {
            throw new Error('Bank account not found');
        }

        // Get opening balance (balance as of periodStart)
        const openingResult = await pool.query(
            `
      SELECT COALESCE(SUM(
        CASE WHEN bt.type IN ('DEPOSIT', 'TRANSFER_IN', 'INTEREST') THEN bt.amount
             ELSE -bt.amount END
      ), 0) as opening_balance
      FROM bank_transactions bt
      WHERE bt.bank_account_id = $1
        AND bt.transaction_date < $2
        AND bt.is_reversed = FALSE
    `,
            [bankAccountId, periodStart]
        );

        // Get transactions in period grouped by category
        const categoryResult = await pool.query(
            `
      SELECT 
        bc.id as category_id,
        bc.code as category_code,
        bc.name as category_name,
        bc.direction,
        COUNT(*) as transaction_count,
        SUM(bt.amount) as total_amount
      FROM bank_transactions bt
      LEFT JOIN bank_categories bc ON bc.id = bt.category_id
      WHERE bt.bank_account_id = $1
        AND bt.transaction_date >= $2
        AND bt.transaction_date <= $3
        AND bt.is_reversed = FALSE
      GROUP BY bc.id, bc.code, bc.name, bc.direction
      ORDER BY bc.direction, bc.display_order
    `,
            [bankAccountId, periodStart, periodEnd]
        );

        // Get totals
        const totalsResult = await pool.query(
            `
      SELECT 
        COALESCE(SUM(CASE WHEN type IN ('DEPOSIT', 'TRANSFER_IN', 'INTEREST') THEN amount ELSE 0 END), 0) as total_deposits,
        COALESCE(SUM(CASE WHEN type IN ('WITHDRAWAL', 'TRANSFER_OUT', 'FEE') THEN amount ELSE 0 END), 0) as total_withdrawals,
        COUNT(*) as transaction_count
      FROM bank_transactions
      WHERE bank_account_id = $1
        AND transaction_date >= $2
        AND transaction_date <= $3
        AND is_reversed = FALSE
    `,
            [bankAccountId, periodStart, periodEnd]
        );

        const openingBalance = parseFloat(openingResult.rows[0].opening_balance);
        const totalDeposits = parseFloat(totalsResult.rows[0].total_deposits);
        const totalWithdrawals = parseFloat(totalsResult.rows[0].total_withdrawals);
        const closingBalance = openingBalance + totalDeposits - totalWithdrawals;

        return {
            accountId: bankAccountId,
            accountName: account.name,
            periodStart,
            periodEnd,
            openingBalance,
            closingBalance,
            totalDeposits,
            totalWithdrawals,
            transactionCount: parseInt(totalsResult.rows[0].transaction_count),
            categories: categoryResult.rows.map((row) => ({
                categoryId: row.category_id,
                categoryName: row.category_name || 'Uncategorized',
                categoryCode: row.category_code || 'UNKNOWN',
                direction: (row.direction || 'OUT') as 'IN' | 'OUT',
                totalAmount: parseFloat(row.total_amount),
                transactionCount: parseInt(row.transaction_count),
            })),
        };
    }

    /**
     * Get cash position report (all accounts as of a date)
     */
    static async getCashPositionReport(
        asOfDate?: string,
        dbPool?: pg.Pool
    ): Promise<CashPositionReport> {
        const pool = dbPool || globalPool;
        const date = asOfDate || getBusinessDate();

        const result = await pool.query(
            `
      SELECT 
        ba.id,
        ba.name,
        ba.bank_name,
        ba.last_reconciled_at,
        -- Balance as of date from GL (net-active reverse pairs)
        ${BANK_GL_BALANCE_AS_OF_SQL} as balance,
        -- Unreconciled amount
        COALESCE((
          SELECT SUM(CASE WHEN bt.type IN ('DEPOSIT', 'TRANSFER_IN', 'INTEREST') THEN bt.amount ELSE -bt.amount END)
          FROM bank_transactions bt
          WHERE bt.bank_account_id = ba.id
            AND bt.is_reconciled = FALSE
            AND bt.is_reversed = FALSE
            AND bt.transaction_date <= $1
        ), 0) as unreconciled_amount
      FROM bank_accounts ba
      WHERE ba.is_active = TRUE
      ORDER BY ba.is_default DESC, ba.name
    `,
            [date]
        );

        const accounts = result.rows.map((row) => ({
            id: row.id,
            name: row.name,
            bankName: row.bank_name,
            balance: parseFloat(row.balance),
            lastReconciled: row.last_reconciled_at,
            unreconciledAmount: parseFloat(row.unreconciled_amount),
        }));

        return {
            asOfDate: date,
            accounts,
            totalCashBalance: accounts
                .reduce((sum, acc) => sum.plus(acc.balance), new Decimal(0))
                .toNumber(),
            totalUnreconciledAmount: accounts
                .reduce((sum, acc) => sum.plus(new Decimal(acc.unreconciledAmount).abs()), new Decimal(0))
                .toNumber(),
        };
    }

    // ---------------------------------------------------------------------------
    // AUTO-LINK TO SALES/EXPENSES
    // ---------------------------------------------------------------------------

    /**
     * Mirror a sale payment onto the Banking register.
     * GL is already posted by recordSaleToGL — do NOT post a second journal.
     * Bank book AccountCode must match the payment method liquidity GL (no mismatch).
     */
    static async createFromSale(
        saleId: string,
        saleNumber: string,
        amount: number,
        paymentMethod: string,
        saleDate: string,
        dbPool?: pg.Pool | PoolClient
    ): Promise<BankTransaction | null> {
        const pool = dbPool || globalPool;
        if (paymentMethod === 'CASH' || paymentMethod === 'CREDIT' || paymentMethod === 'DEPOSIT') {
            return null;
        }

        const txnDescription = `Sale ${saleNumber} [${paymentMethod}]`;
        const existing = await pool.query(
            `SELECT id FROM bank_transactions
             WHERE source_type = 'SALE' AND source_id = $1
               AND description = $2
             LIMIT 1`,
            [saleId, txnDescription]
        );
        if (existing.rows.length > 0) {
            logger.info('Bank transaction already exists for sale payment — skipping duplicate', {
                saleId,
                saleNumber,
                paymentMethod,
            });
            return null;
        }

        const glCodeMap: Record<string, string> = {
            CARD: '1020',
            MOBILE_MONEY: '1040',
            AIRTEL_MONEY: '1040',
            BANK_TRANSFER: '1030',
        };
        const targetGlCode = glCodeMap[paymentMethod];
        if (!targetGlCode) {
            logger.warn('No liquidity GL mapping for sale payment method — skipping bank mirror', {
                saleId,
                paymentMethod,
            });
            return null;
        }

        if (paymentMethod === 'MOBILE_MONEY' || paymentMethod === 'AIRTEL_MONEY') {
            await ensureDepositLiquidityBook(pool, 'MOBILE_MONEY');
        }

        const saleGl = await pool.query<{ Id: string }>(
            `SELECT "Id" FROM ledger_transactions
             WHERE "ReferenceType" = 'SALE'
               AND "ReferenceId" = $1
               AND "ReversesTransactionId" IS NULL
               AND COALESCE("IsReversed", FALSE) = FALSE
               AND "Status" = 'POSTED'
             ORDER BY "CreatedAt" DESC
             LIMIT 1`,
            [saleId]
        );
        const existingGlTransactionId = saleGl.rows[0]?.Id;
        if (!existingGlTransactionId) {
            throw new Error(
                `Sale ${saleNumber} has no posted SALE journal — cannot mirror bank without mismatch`
            );
        }

        // Fail closed: SALE journal must touch the liquidity account we will mirror
        const glTouch = await pool.query<{ ok: boolean }>(
            `SELECT EXISTS (
                SELECT 1
                FROM ledger_entries le
                JOIN accounts a ON a."Id" = le."AccountId"
                WHERE le."TransactionId" = $1
                  AND a."AccountCode" = $2
                  AND le."DebitAmount" > 0
             ) AS ok`,
            [existingGlTransactionId, targetGlCode]
        );
        if (!glTouch.rows[0]?.ok) {
            // Split tenders may not each appear on the SALE journal (header method drives GL).
            // Never invent a second journal — skip mirror rather than create a mismatch.
            logger.warn(
                'Sale GL does not debit payment liquidity — skipping bank mirror (no duplicate GL)',
                { saleId, saleNumber, paymentMethod, targetGlCode, existingGlTransactionId }
            );
            return null;
        }

        const bankAccountResult = await pool.query<{ id: string; gl_code: string }>(
            `
      SELECT ba.id, a."AccountCode" AS gl_code
      FROM bank_accounts ba
      JOIN accounts a ON a."Id" = ba.gl_account_id
      WHERE a."AccountCode" = $1 AND ba.is_active = TRUE
      ORDER BY ba.is_default DESC, ba.created_at ASC NULLS LAST
      LIMIT 1
    `,
            [targetGlCode]
        );

        if (bankAccountResult.rows.length === 0) {
            logger.warn('No bank account configured for payment method', {
                paymentMethod,
                targetGlCode,
            });
            return null;
        }

        const bankAccountId = bankAccountResult.rows[0].id;
        if (bankAccountResult.rows[0].gl_code !== targetGlCode) {
            throw new Error(
                `Bank book GL ${bankAccountResult.rows[0].gl_code} !== payment ${targetGlCode}`
            );
        }

        const categoryResult = await pool.query(`
      SELECT id FROM bank_categories WHERE code = 'SALES_DEPOSIT'
    `);
        const categoryId = categoryResult.rows[0]?.id || null;

        const transactionId = uuidv4();
        const transactionNumber = await BankingService.generateBankTxnNumber(pool);
        await pool.query(
            `
        INSERT INTO bank_transactions (
          id, transaction_number, bank_account_id, transaction_date,
          type, category_id, description, reference, amount,
          contra_account_id, gl_transaction_id, source_type, source_id,
          is_reconciled, is_reversed, created_by
        )
        VALUES ($1, $2, $3, $4, 'DEPOSIT', $5, $6, $7, $8,
                NULL, $9, 'SALE', $10, FALSE, FALSE, $11)
      `,
            [
                transactionId,
                transactionNumber,
                bankAccountId,
                saleDate,
                categoryId,
                txnDescription,
                saleNumber,
                amount,
                existingGlTransactionId,
                saleId,
                SYSTEM_USER_ID,
            ]
        );

        logger.info('Bank transaction mirrored for sale payment (linked GL — no second journal)', {
            saleId,
            saleNumber,
            paymentMethod,
            targetGlCode,
            glTransactionId: existingGlTransactionId,
            amount,
        });

        return BankingService.getTransactionById(transactionId, pool as pg.Pool);
    }

    /**
     * Mirror an expense payment onto the Banking register.
     *
     * GL is already posted by recordExpensePaymentToGL (DR AP / CR pay-from).
     * Do NOT post a second journal — link bank_transactions to that EXPENSE_PAYMENT GL.
     *
     * Never pass expense categoryId as contraAccountId (category UUID ≠ accounts."Id").
     */
    static async createFromExpense(
        expenseId: string,
        expenseNumber: string,
        amount: number,
        paymentMethod: string,
        expenseDate: string,
        options?: {
            paymentAccountCode?: string;
            existingGlTransactionId?: string;
        },
        dbPool?: pg.Pool | PoolClient
    ): Promise<BankTransaction | null> {
        const pool = dbPool || globalPool;

        const paymentAccountCode =
            options?.paymentAccountCode ||
            (paymentMethod === 'CASH' || paymentMethod === 'PETTY_CASH'
                ? '1010'
                : paymentMethod === 'MOBILE_MONEY' || paymentMethod === 'AIRTEL_MONEY'
                  ? '1040'
                  : paymentMethod === 'CARD'
                    ? '1020'
                    : '1030');

        if (paymentAccountCode === '1010' && paymentMethod === 'CASH' && !options?.existingGlTransactionId) {
            return null;
        }

        const existing = await pool.query(
            `SELECT id FROM bank_transactions
             WHERE source_type = 'EXPENSE' AND source_id = $1
               AND COALESCE(is_reversed, FALSE) = FALSE
             LIMIT 1`,
            [expenseId]
        );
        if (existing.rows.length > 0) {
            logger.info('Bank transaction already exists for expense — skipping duplicate', {
                expenseId,
                expenseNumber,
            });
            return null;
        }

        if (!options?.existingGlTransactionId) {
            logger.warn('createFromExpense called without existingGlTransactionId — skipping to avoid double GL', {
                expenseId,
                expenseNumber,
                paymentAccountCode,
            });
            return null;
        }

        const existingGlTransactionId = options.existingGlTransactionId;

        // Fail closed: EXPENSE_PAYMENT journal must credit the pay-from liquidity account
        const glTouch = await pool.query<{ ok: boolean }>(
            `SELECT EXISTS (
                SELECT 1
                FROM ledger_entries le
                JOIN accounts a ON a."Id" = le."AccountId"
                WHERE le."TransactionId" = $1
                  AND a."AccountCode" = $2
                  AND le."CreditAmount" > 0
             ) AS ok`,
            [existingGlTransactionId, paymentAccountCode]
        );
        if (!glTouch.rows[0]?.ok) {
            throw new Error(
                `Expense ${expenseNumber} GL does not credit ${paymentAccountCode} — refusing bank mirror (no mismatch)`
            );
        }

        if (paymentAccountCode === '1040') {
            await ensureDepositLiquidityBook(pool, 'MOBILE_MONEY');
        } else if (paymentAccountCode === '1010' || paymentAccountCode === '1012') {
            await ensureDepositLiquidityBook(pool, 'CASH');
        }

        const bankAccountResult = await pool.query<{ id: string; gl_code: string }>(
            `
      SELECT ba.id, a."AccountCode" AS gl_code
      FROM bank_accounts ba
      JOIN accounts a ON a."Id" = ba.gl_account_id
      WHERE a."AccountCode" = $1 AND ba.is_active = TRUE
      ORDER BY ba.is_default DESC, ba.created_at ASC NULLS LAST
      LIMIT 1
    `,
            [paymentAccountCode]
        );

        if (bankAccountResult.rows.length === 0) {
            logger.warn('No bank account configured for expense payment GL', {
                expenseId,
                paymentAccountCode,
                paymentMethod,
            });
            return null;
        }

        if (bankAccountResult.rows[0].gl_code !== paymentAccountCode) {
            throw new Error(
                `Bank book GL ${bankAccountResult.rows[0].gl_code} !== pay-from ${paymentAccountCode}`
            );
        }

        const bankAccountId = bankAccountResult.rows[0].id;

        const categoryResult = await pool.query(`
      SELECT id FROM bank_categories WHERE code = 'EXPENSE_PAYMENT'
    `);
        const categoryId = categoryResult.rows[0]?.id || null;

        const transactionId = uuidv4();
        const transactionNumber = await BankingService.generateBankTxnNumber(pool);
        await pool.query(
            `
        INSERT INTO bank_transactions (
          id, transaction_number, bank_account_id, transaction_date,
          type, category_id, description, reference, amount,
          contra_account_id, gl_transaction_id, source_type, source_id,
          is_reconciled, is_reversed, created_by
        )
        VALUES ($1, $2, $3, $4, 'WITHDRAWAL', $5, $6, $7, $8,
                NULL, $9, 'EXPENSE', $10, FALSE, FALSE, $11)
      `,
            [
                transactionId,
                transactionNumber,
                bankAccountId,
                expenseDate,
                categoryId,
                `Expense ${expenseNumber}`,
                expenseNumber,
                amount,
                existingGlTransactionId,
                expenseId,
                SYSTEM_USER_ID,
            ]
        );
        logger.info('Bank transaction mirrored for expense payment (linked GL — no second journal)', {
            expenseId,
            expenseNumber,
            bankAccountId,
            paymentAccountCode,
            glTransactionId: existingGlTransactionId,
        });
        return BankingService.getTransactionById(transactionId, pool as pg.Pool);
    }

    // ---------------------------------------------------------------------------
    // STATEMENT IMPORT
    // ---------------------------------------------------------------------------

    /**
     * Get all import templates
     */
    static async getTemplates(dbPool?: pg.Pool): Promise<BankTemplate[]> {
        const pool = dbPool || globalPool;
        const result = await pool.query<BankTemplateDbRow>(`
      SELECT * FROM bank_templates
      WHERE is_active = TRUE
      ORDER BY name
    `);
        return result.rows.map(normalizeBankTemplate);
    }

    /**
     * Create import template
     */
    static async createTemplate(
        data: {
            name: string;
            bankName?: string;
            columnMappings: {
                dateColumn: number;
                dateFormat: string;
                descriptionColumn: number;
                amountColumn?: number;
                debitColumn?: number;
                creditColumn?: number;
                balanceColumn?: number;
                referenceColumn?: number;
                negativeIsDebit?: boolean;
            };
            skipHeaderRows?: number;
            skipFooterRows?: number;
            delimiter?: string;
        },
        dbPool?: pg.Pool
    ): Promise<BankTemplate> {
        const pool = dbPool || globalPool;
        const id = uuidv4();
        const result = await pool.query<BankTemplateDbRow>(
            `
      INSERT INTO bank_templates (
        id, name, bank_name, column_mappings,
        skip_header_rows, skip_footer_rows, delimiter
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `,
            [
                id,
                data.name,
                data.bankName || null,
                JSON.stringify(data.columnMappings),
                data.skipHeaderRows || 1,
                data.skipFooterRows || 0,
                data.delimiter || ',',
            ]
        );
        return normalizeBankTemplate(result.rows[0]);
    }

    /**
     * Import bank statement from CSV
     */
    static async importStatement(
        bankAccountId: string,
        templateId: string,
        csvContent: string,
        statementDate: string,
        fileName: string,
        userId: string,
        options: {
            periodStart?: string;
            periodEnd?: string;
        } = {},
        dbPool?: pg.Pool
    ): Promise<{
        statementId: string;
        statementNumber: string;
        totalLines: number;
        parsedLines: ParsedStatementLine[];
    }> {
        const pool = dbPool || globalPool;
        return UnitOfWork.run(pool, async (client) => {
            // Get template
            const templateResult = await client.query(
                `
        SELECT * FROM bank_templates WHERE id = $1
      `,
                [templateId]
            );

            if (templateResult.rows.length === 0) {
                throw new Error(`Template ${templateId} not found`);
            }

            const template = templateResult.rows[0] as Record<string, unknown>;
            const mappings =
                typeof template.column_mappings === 'string'
                    ? (JSON.parse(template.column_mappings as string) as ColumnMappings)
                    : (template.column_mappings as ColumnMappings);

            // Parse CSV
            const lines = this.parseCSV(csvContent, String(template.delimiter || ','));
            const dataLines = lines.slice(
                Number(template.skip_header_rows || 1),
                lines.length - Number(template.skip_footer_rows || 0)
            );

            // Generate statement number
            const statementNumber = await BankingService.generateStatementNumber(client);
            const statementId = uuidv4();

            // Create statement record
            await client.query(
                `
        INSERT INTO bank_statements (
          id, statement_number, bank_account_id, statement_date,
          period_start, period_end, file_name, template_id,
          total_lines, status, imported_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'DRAFT', $10)
      `,
                [
                    statementId,
                    statementNumber,
                    bankAccountId,
                    statementDate,
                    options.periodStart || null,
                    options.periodEnd || null,
                    fileName,
                    templateId,
                    dataLines.length,
                    userId,
                ]
            );

            // Parse and insert statement lines
            const parsedLines: ParsedStatementLine[] = [];
            let lineNumber = 1;

            for (const row of dataLines) {
                if (!row || row.length === 0 || row.every((cell) => !cell.trim())) {
                    continue; // Skip empty rows
                }

                // Parse date
                let transactionDate: string | null = null;
                if (mappings.dateColumn !== undefined && row[mappings.dateColumn]) {
                    transactionDate = this.parseDate(row[mappings.dateColumn], mappings.dateFormat);
                }

                // Parse description
                const description =
                    mappings.descriptionColumn !== undefined
                        ? (row[mappings.descriptionColumn] || '').trim()
                        : '';

                // Parse reference
                const reference =
                    mappings.referenceColumn !== undefined
                        ? (row[mappings.referenceColumn] || '').trim()
                        : null;

                // Parse amount
                let amount = 0;
                if (mappings.amountColumn !== undefined && row[mappings.amountColumn]) {
                    amount = this.parseAmount(row[mappings.amountColumn]);
                    if (mappings.negativeIsDebit && amount < 0) {
                        // Negative means debit (outflow), so keep negative
                    }
                } else if (mappings.debitColumn !== undefined || mappings.creditColumn !== undefined) {
                    const debit =
                        mappings.debitColumn !== undefined
                            ? this.parseAmount(row[mappings.debitColumn] || '0')
                            : 0;
                    const credit =
                        mappings.creditColumn !== undefined
                            ? this.parseAmount(row[mappings.creditColumn] || '0')
                            : 0;
                    amount = credit - debit; // Credit positive, debit negative
                }

                // Parse running balance
                const runningBalance =
                    mappings.balanceColumn !== undefined
                        ? this.parseAmount(row[mappings.balanceColumn] || '0')
                        : null;

                // Skip lines with zero amount
                if (amount === 0) {
                    continue;
                }

                const lineId = uuidv4();
                const direction = amount >= 0 ? 'IN' : 'OUT';
                const absAmount = Math.abs(amount);

                // Find matching patterns
                const patterns = await this.findMatchingPatterns(description, absAmount, direction);
                const bestPattern = patterns.length > 0 ? patterns[0] : null;

                await client.query(
                    `
          INSERT INTO bank_statement_lines (
            id, statement_id, line_number, transaction_date,
            description, reference, amount, running_balance,
            match_status, suggested_category_id, suggested_account_id
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'UNMATCHED', $9, $10)
        `,
                    [
                        lineId,
                        statementId,
                        lineNumber++,
                        transactionDate,
                        description,
                        reference,
                        amount, // Keep sign for direction
                        runningBalance,
                        bestPattern?.categoryId || null,
                        bestPattern?.contraAccountId || null,
                    ]
                );

                parsedLines.push({
                    id: lineId,
                    lineNumber: lineNumber - 1,
                    transactionDate,
                    description,
                    reference,
                    amount,
                    runningBalance,
                    suggestedCategoryId: bestPattern?.categoryId,
                    suggestedCategoryName: bestPattern?.categoryName,
                    matchConfidence: bestPattern?.confidence,
                });
            }

            logger.info('Bank statement imported', {
                statementId,
                statementNumber,
                totalLines: parsedLines.length,
                fileName,
            });

            return {
                statementId,
                statementNumber,
                totalLines: parsedLines.length,
                parsedLines,
            };
        });
    }

    /**
     * Get statement lines for processing
     */
    static async getStatementLines(
        statementId: string,
        status?: 'UNMATCHED' | 'MATCHED' | 'CREATED' | 'SKIPPED',
        dbPool?: pg.Pool
    ): Promise<BankStatementLine[]> {
        const pool = dbPool || globalPool;
        const conditions = ['sl.statement_id = $1'];
        const params: string[] = [statementId];

        if (status) {
            conditions.push('sl.match_status = $2');
            params.push(status);
        }

        const result = await pool.query<BankStatementLineDbRow>(
            `
      SELECT 
        sl.*,
        bc.name as suggested_category_name,
        a."AccountName" as suggested_account_name
      FROM bank_statement_lines sl
      LEFT JOIN bank_categories bc ON bc.id = sl.suggested_category_id
      LEFT JOIN accounts a ON a."Id" = sl.suggested_account_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY sl.line_number
    `,
            params
        );

        return result.rows.map(normalizeBankStatementLine);
    }

    /**
     * Process a statement line (create transaction, match, or skip)
     */
    static async processStatementLine(
        lineId: string,
        action: 'CREATE' | 'MATCH' | 'SKIP',
        userId: string,
        options: {
            transactionId?: string; // For MATCH
            categoryId?: string; // For CREATE
            contraAccountId?: string; // For CREATE
            skipReason?: string; // For SKIP
        } = {},
        dbPool?: pg.Pool
    ): Promise<Record<string, unknown>> {
        const pool = dbPool || globalPool;

        if (action === 'CREATE') {
            // Phase 1: Lock and mark as PROCESSING (short transaction)
            const line = await UnitOfWork.run(pool, async (client) => {
                const lineResult = await client.query(
                    `
          SELECT sl.*, bs.bank_account_id
          FROM bank_statement_lines sl
          JOIN bank_statements bs ON bs.id = sl.statement_id
          WHERE sl.id = $1
          FOR UPDATE OF sl
        `,
                    [lineId]
                );

                if (lineResult.rows.length === 0) {
                    throw new Error(`Statement line ${lineId} not found`);
                }

                const ln = lineResult.rows[0] as Record<string, unknown>;

                if (ln.match_status !== 'UNMATCHED') {
                    throw new Error(`Line already processed with status: ${ln.match_status}`);
                }

                await client.query(
                    `
          UPDATE bank_statement_lines
          SET match_status = 'PROCESSING'
          WHERE id = $1
        `,
                    [lineId]
                );

                return ln;
            });

            // Phase 2: Create transaction (manages its own UnitOfWork)
            const txnType = (line.amount as number) >= 0 ? 'DEPOSIT' : 'WITHDRAWAL';
            const amount = Math.abs(parseFloat(String(line.amount)));
            let txn: BankTransaction;

            try {
                txn = await this.createTransaction(
                    {
                        bankAccountId: line.bank_account_id as string,
                        transactionDate:
                            (line.transaction_date as string) || getBusinessDate(),
                        type: txnType,
                        categoryId: (options.categoryId || line.suggested_category_id) as string | undefined,
                        description: (line.description as string) || 'Imported transaction',
                        reference: line.reference as string | undefined,
                        amount,
                        contraAccountId: (options.contraAccountId || line.suggested_account_id) as
                            | string
                            | undefined,
                        sourceType: 'STATEMENT_IMPORT',
                        sourceId: lineId,
                    },
                    userId
                );
            } catch (txnError) {
                // Rollback line status to UNMATCHED on failure
                await pool.query(
                    `
            UPDATE bank_statement_lines
            SET match_status = 'UNMATCHED'
            WHERE id = $1
          `,
                    [lineId]
                );
                throw txnError;
            }

            // Phase 3: Update line to CREATED with reference to new transaction
            await pool.query(
                `
          UPDATE bank_statement_lines
          SET match_status = 'CREATED',
              matched_transaction_id = $2,
              processed_at = NOW(),
              processed_by = $3
          WHERE id = $1
        `,
                [lineId, txn.id, userId]
            );

            // Learn pattern from this categorization (non-fatal)
            if (options.categoryId && line.description) {
                try {
                    await this.learnPattern(
                        line.description as string,
                        amount,
                        txnType === 'DEPOSIT' ? 'IN' : 'OUT',
                        options.categoryId,
                        options.contraAccountId || null,
                        userId
                    );
                } catch (patternError) {
                    logger.debug('Could not learn pattern', { error: patternError });
                }
            }

            return { lineId, action, transaction: txn };
        }

        // MATCH and SKIP actions use a single UnitOfWork transaction
        return UnitOfWork.run(pool, async (client) => {
            // Lock the line with FOR UPDATE to prevent concurrent processing
            const lineResult = await client.query(
                `
        SELECT sl.*, bs.bank_account_id
        FROM bank_statement_lines sl
        JOIN bank_statements bs ON bs.id = sl.statement_id
        WHERE sl.id = $1
        FOR UPDATE OF sl
      `,
                [lineId]
            );

            if (lineResult.rows.length === 0) {
                throw new Error(`Statement line ${lineId} not found`);
            }

            const line = lineResult.rows[0] as Record<string, unknown>;

            if (line.match_status !== 'UNMATCHED') {
                throw new Error(`Line already processed with status: ${line.match_status}`);
            }

            const result: Record<string, unknown> = { lineId, action };

            if (action === 'MATCH') {
                if (!options.transactionId) {
                    throw new Error('transactionId required for MATCH action');
                }

                // Verify transaction exists
                const txnResult = await client.query(
                    `
          SELECT id FROM bank_transactions WHERE id = $1
        `,
                    [options.transactionId]
                );

                if (txnResult.rows.length === 0) {
                    throw new Error(`Transaction ${options.transactionId} not found`);
                }

                // Update line as matched
                await client.query(
                    `
          UPDATE bank_statement_lines
          SET match_status = 'MATCHED',
              matched_transaction_id = $2,
              match_confidence = 100,
              processed_at = NOW(),
              processed_by = $3
          WHERE id = $1
        `,
                    [lineId, options.transactionId, userId]
                );

                // Update transaction with statement line reference
                // Protection: skip reconciled transactions (replaces trg_protect_reconciled_bank_txn)
                await client.query(
                    `
          UPDATE bank_transactions
          SET statement_line_id = $1,
              matched_at = NOW(),
              match_confidence = 100
          WHERE id = $2
            AND is_reconciled = FALSE
        `,
                    [lineId, options.transactionId]
                );

                result.matchedTransactionId = options.transactionId;
            } else if (action === 'SKIP') {
                await client.query(
                    `
          UPDATE bank_statement_lines
          SET match_status = 'SKIPPED',
              skip_reason = $2,
              processed_at = NOW(),
              processed_by = $3
          WHERE id = $1
        `,
                    [lineId, options.skipReason || 'Manually skipped', userId]
                );

                result.skipReason = options.skipReason;
            }

            return result;
        });
    }

    /**
     * Complete statement processing
     * Uses SELECT FOR UPDATE to prevent race condition between count check and status update
     */
    static async completeStatement(
        statementId: string,
        userId: string,
        dbPool?: pg.Pool
    ): Promise<void> {
        const pool = dbPool || globalPool;
        await UnitOfWork.run(pool, async (client) => {
            // Lock the statement row to prevent concurrent completion
            const stmtLock = await client.query(
                `
      SELECT id FROM bank_statements WHERE id = $1 FOR UPDATE
    `,
                [statementId]
            );

            if (stmtLock.rows.length === 0) {
                throw new Error(`Statement ${statementId} not found`);
            }

            // Count processed lines (within the same transaction as the lock)
            const countResult = await client.query(
                `
      SELECT 
        COUNT(*) FILTER (WHERE match_status = 'MATCHED') as matched,
        COUNT(*) FILTER (WHERE match_status = 'CREATED') as created,
        COUNT(*) FILTER (WHERE match_status = 'SKIPPED') as skipped,
        COUNT(*) FILTER (WHERE match_status = 'UNMATCHED') as unmatched
      FROM bank_statement_lines
      WHERE statement_id = $1
    `,
                [statementId]
            );

            const counts = countResult.rows[0] as Record<string, string>;

            if (parseInt(counts.unmatched) > 0) {
                throw new Error(`Cannot complete statement: ${counts.unmatched} lines still unmatched`);
            }

            await client.query(
                `
      UPDATE bank_statements
      SET status = 'COMPLETED',
          matched_lines = $2,
          created_lines = $3,
          skipped_lines = $4,
          completed_at = NOW()
      WHERE id = $1
    `,
                [statementId, parseInt(counts.matched), parseInt(counts.created), parseInt(counts.skipped)]
            );

            logger.info('Statement processing completed', {
                statementId,
                matched: counts.matched,
                created: counts.created,
                skipped: counts.skipped,
            });
        });
    }

    // ---------------------------------------------------------------------------
    // HELPER METHODS
    // ---------------------------------------------------------------------------

    /**
     * Parse CSV content
     */
    private static parseCSV(content: string, delimiter: string): string[][] {
        const lines: string[][] = [];
        const rows = content.split(/\r?\n/);

        for (const row of rows) {
            if (!row.trim()) continue;

            const cells: string[] = [];
            let current = '';
            let inQuotes = false;

            for (let i = 0; i < row.length; i++) {
                const char = row[i];

                if (char === '"') {
                    if (inQuotes && row[i + 1] === '"') {
                        current += '"';
                        i++;
                    } else {
                        inQuotes = !inQuotes;
                    }
                } else if (char === delimiter && !inQuotes) {
                    cells.push(current.trim());
                    current = '';
                } else {
                    current += char;
                }
            }
            cells.push(current.trim());
            lines.push(cells);
        }

        return lines;
    }

    /**
     * Parse date from various formats
     */
    private static parseDate(value: string, format: string): string | null {
        if (!value) return null;

        value = value.trim();

        try {
            // Common formats
            if (format === 'DD/MM/YYYY') {
                const parts = value.split('/');
                if (parts.length === 3) {
                    return `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
                }
            } else if (format === 'MM/DD/YYYY') {
                const parts = value.split('/');
                if (parts.length === 3) {
                    return `${parts[2]}-${parts[0].padStart(2, '0')}-${parts[1].padStart(2, '0')}`;
                }
            } else if (format === 'YYYY-MM-DD') {
                return value;
            } else if (format === 'DD-MM-YYYY') {
                const parts = value.split('-');
                if (parts.length === 3) {
                    return `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
                }
            }

            // Fallback: try native Date parsing
            const date = new Date(value);
            if (!isNaN(date.getTime())) {
                return formatDateBusiness(date);
            }
        } catch {
            // Ignore parsing errors
        }

        return null;
    }

    /**
     * Parse amount from string
     */
    private static parseAmount(value: string): number {
        if (!value) return 0;

        // Remove currency symbols, spaces, and thousands separators
        let cleaned = value
            .replace(/[^0-9.,\-()]/g, '')
            .replace(/,(?=\d{3})/g, '') // Remove thousand separators
            .trim();

        // Handle negative values in parentheses
        if (cleaned.startsWith('(') && cleaned.endsWith(')')) {
            cleaned = '-' + cleaned.slice(1, -1);
        }

        // Convert comma decimal separator if needed
        if (cleaned.includes(',') && !cleaned.includes('.')) {
            cleaned = cleaned.replace(',', '.');
        }

        const num = parseFloat(cleaned);
        return isNaN(num) ? 0 : num;
    }
}

export default BankingService;
