/**
 * Deposits Service - Business logic for customer deposits
 * Part of the SamplePOS hybrid architecture
 */

import { Pool, PoolClient } from 'pg';
import Decimal from 'decimal.js';
import * as depositsRepository from './depositsRepository.js';
import { findCustomerById } from '../customers/customerRepository.js';
import * as glEntryService from '../../services/glEntryService.js';
import { UnitOfWork } from '../../db/unitOfWork.js';
import { AccountingCore } from '../../services/accountingCore.js';
import logger from '../../utils/logger.js';
import { Money } from '../../utils/money.js';
import {
    allocateDepositFifo,
    assertAppliedEqualsRequested,
    money2,
} from '@shared/domain/invoiceDepositPayment.js';

// Type for either a Pool or PoolClient - allows reuse in transactions
type DbConnection = Pool | PoolClient;

export interface Deposit {
    id: string;
    depositNumber: string;
    customerId: string;
    customerName?: string;
    amount: number;
    amountUsed: number;
    amountAvailable: number;
    paymentMethod: 'CASH' | 'CARD' | 'MOBILE_MONEY' | 'BANK_TRANSFER';
    reference?: string;
    notes?: string;
    status: 'ACTIVE' | 'DEPLETED' | 'REFUNDED' | 'CANCELLED';
    createdBy?: string;
    createdAt: string;
    updatedAt: string;
}

export interface DepositApplication {
    id: string;
    depositId: string;
    saleId: string | null;
    invoiceId?: string | null;
    amountApplied: number;
    appliedAt: string;
    appliedBy?: string;
    depositNumber?: string;
    saleNumber?: string;
}

export interface CreateDepositInput {
    customerId: string;
    amount: number;
    paymentMethod: 'CASH' | 'CARD' | 'MOBILE_MONEY' | 'BANK_TRANSFER';
    reference?: string;
    notes?: string;
    createdBy?: string;
}

export interface CustomerDepositBalance {
    customerId: string;
    customerName: string;
    availableBalance: number;
    totalDeposits: number;
    totalUsed: number;
    activeDepositCount: number;
}

// Normalize DB row to camelCase
function normalizeDeposit(row: depositsRepository.DepositDbRow): Deposit {
    return {
        id: row.id,
        depositNumber: row.deposit_number,
        customerId: row.customer_id,
        customerName: row.customer_name,
        amount: Money.toNumber(Money.parseDb(row.amount)),
        amountUsed: Money.toNumber(Money.parseDb(row.amount_used)),
        amountAvailable: Money.toNumber(Money.parseDb(row.amount_available)),
        paymentMethod: row.payment_method as Deposit['paymentMethod'],
        reference: row.reference || undefined,
        notes: row.notes || undefined,
        status: row.status,
        createdBy: row.created_by || undefined,
        createdAt: typeof row.created_at === 'string' ? row.created_at : new Date(row.created_at).toISOString(),
        updatedAt: typeof row.updated_at === 'string' ? row.updated_at : new Date(row.updated_at).toISOString()
    };
}

function normalizeApplication(row: depositsRepository.DepositApplicationDbRow): DepositApplication {
    return {
        id: row.id,
        depositId: row.deposit_id,
        saleId: row.sale_id,
        invoiceId: row.invoice_id || null,
        amountApplied: Money.toNumber(Money.parseDb(row.amount_applied)),
        appliedAt: row.applied_at,
        appliedBy: row.applied_by || undefined,
        depositNumber: row.deposit_number,
        saleNumber: row.sale_number
    };
}

/**
 * Create a new customer deposit
 * Atomic: deposit row + GL posting in single transaction
 *
 * IDENTITY SSOT (mandatory):
 *   - customerId is written only after findCustomerById (customers master)
 *   - GL description uses master customer.name — never a client/list label
 *   - Client list pages are not identity and never authorize this write
 */
export async function createDeposit(
    pool: Pool,
    input: CreateDepositInput
): Promise<Deposit> {
    // Master SSOT — reject unknown customers before any insert
    const customer = await findCustomerById(input.customerId, pool);
    if (!customer) {
        throw new Error(`Customer not found: ${input.customerId}`);
    }
    const customerNameSsot = customer.name;

    // Validate amount
    if (input.amount <= 0) {
        throw new Error('Deposit amount must be greater than zero');
    }

    // Validate payment method
    const validMethods = ['CASH', 'CARD', 'MOBILE_MONEY', 'BANK_TRANSFER'];
    if (!validMethods.includes(input.paymentMethod)) {
        throw new Error(`Invalid payment method: ${input.paymentMethod}`);
    }

    logger.info('Creating deposit', {
        customerId: input.customerId,
        customerName: customerNameSsot,
        amount: input.amount,
        paymentMethod: input.paymentMethod
    });

    // Atomic: deposit row + GL posting in one transaction
    const deposit = await UnitOfWork.run(pool, async (client) => {
        const depositRow = await depositsRepository.createDeposit(client, input);

        logger.info('Deposit created', {
            depositNumber: depositRow.deposit_number,
            amount: depositRow.amount
        });

        const normalized = normalizeDeposit(depositRow);

        // GL POSTING: DR Undeposited Funds (1015) / CR Customer Deposits (2200)
        const depositDate = normalized.createdAt.includes('T')
            ? normalized.createdAt.split('T')[0]
            : normalized.createdAt.split(' ')[0];

        await glEntryService.recordCustomerDepositToGL({
            depositId: normalized.id,
            depositNumber: normalized.depositNumber,
            depositDate,
            amount: normalized.amount,
            paymentMethod: normalized.paymentMethod,
            customerId: input.customerId,
            customerName: customerNameSsot,
        }, pool, client);

        return {
            ...normalized,
            customerName: customerNameSsot,
        };
    });

    return deposit;
}

/**
 * Get deposit by ID
 */
export async function getDepositById(
    pool: Pool,
    depositId: string
): Promise<Deposit | null> {
    const row = await depositsRepository.getDepositById(pool, depositId);
    return row ? normalizeDeposit(row) : null;
}

/**
 * Get all deposits for a customer
 */
export async function getCustomerDeposits(
    pool: Pool,
    customerId: string,
    status?: 'ACTIVE' | 'DEPLETED' | 'REFUNDED' | 'CANCELLED'
): Promise<Deposit[]> {
    const rows = await depositsRepository.getDepositsByCustomer(pool, customerId, status);
    return rows.map(normalizeDeposit);
}

/**
 * Get customer's available deposit balance
 */
export async function getCustomerDepositBalance(
    dbConn: DbConnection,
    customerId: string
): Promise<CustomerDepositBalance> {
    const summary = await depositsRepository.getCustomerDepositSummary(dbConn, customerId);

    if (!summary) {
        // Customer exists but no deposits
        const customer = await findCustomerById(customerId, dbConn);
        return {
            customerId,
            customerName: customer?.name || 'Unknown',
            availableBalance: 0,
            totalDeposits: 0,
            totalUsed: 0,
            activeDepositCount: 0
        };
    }

    return {
        customerId: summary.customer_id,
        customerName: summary.customer_name,
        availableBalance: Money.toNumber(Money.parseDb(summary.available_deposit_balance)),
        totalDeposits: Money.toNumber(Money.parseDb(summary.total_deposits)),
        totalUsed: Money.toNumber(Money.parseDb(summary.total_deposits_used)),
        activeDepositCount: summary.active_deposit_count
    };
}

/**
 * Apply deposits using FIFO (oldest first) inside an existing transaction.
 * Locks all active deposit rows for the customer before allocating.
 * totalApplied is always exactly equal to requested (2dp) or this throws.
 */
export async function applyDepositsToSaleInTransaction(
    client: PoolClient,
    customerId: string,
    saleId: string | null,
    amountToApply: number | string,
    appliedBy?: string,
    options?: { invoiceId?: string | null }
): Promise<{ applications: DepositApplication[]; totalApplied: number }> {
    const invoiceId = options?.invoiceId ?? null;
    if (!saleId && !invoiceId) {
        throw new Error('DEPOSIT_APPLY_TARGET_REQUIRED: saleId or invoiceId must be provided');
    }

    const requested = money2(amountToApply);
    if (requested.lte(0)) {
        throw new Error('Amount to apply must be greater than zero');
    }

    const activeDeposits = await depositsRepository.lockActiveDepositsForCustomer(client, customerId);

    if (activeDeposits.length === 0) {
        throw new Error('No active deposits available for this customer');
    }

    const plan = allocateDepositFifo(
        activeDeposits.map((d) => ({ id: d.id, available: d.amount_available })),
        requested,
    );

    const applications: DepositApplication[] = [];
    for (const alloc of plan.allocations) {
        const deposit = activeDeposits.find((d) => d.id === alloc.id);
        const applicationRow = await depositsRepository.applyDepositToSaleInTransaction(client, {
            depositId: alloc.id,
            saleId,
            invoiceId,
            amount: alloc.amount.toFixed(2),
            appliedBy
        });

        applications.push(normalizeApplication(applicationRow));

        logger.info('Deposit applied to sale', {
            depositNumber: deposit?.deposit_number,
            amountApplied: alloc.amount.toFixed(2),
            saleId,
            invoiceId
        });
    }

    const totalApplied = applications.reduce(
        (sum, app) => sum.plus(money2(app.amountApplied)),
        new Decimal(0),
    );
    assertAppliedEqualsRequested(totalApplied, requested);

    return {
        applications,
        totalApplied: Money.toNumber(totalApplied),
    };
}

/**
 * Apply deposits to a sale using FIFO (oldest deposits first)
 * Returns the applications created and total amount applied
 * Accepts either a Pool (creates own connection) or PoolClient (uses existing transaction)
 */
export async function applyDepositsToSale(
    dbConn: DbConnection,
    customerId: string,
    saleId: string | null,
    amountToApply: number | string,
    appliedBy?: string,
    options?: { invoiceId?: string | null }
): Promise<{ applications: DepositApplication[]; totalApplied: number }> {
    // Check if this is a Pool or PoolClient
    // Pool has 'totalCount' and 'idleCount' properties
    const isPool = 'totalCount' in dbConn;

    if (isPool) {
        // Use pool - the repository will create its own transaction
        return applyDepositsToSaleWithPool(dbConn as Pool, customerId, saleId, amountToApply, appliedBy, options);
    } else {
        // Use existing client - use the transaction-safe version
        return applyDepositsToSaleInTransaction(
            dbConn as PoolClient,
            customerId,
            saleId,
            amountToApply,
            appliedBy,
            options,
        );
    }
}

/**
 * Apply deposits to a sale using a Pool (creates own transaction)
 */
async function applyDepositsToSaleWithPool(
    pool: Pool,
    customerId: string,
    saleId: string | null,
    amountToApply: number | string,
    appliedBy?: string,
    options?: { invoiceId?: string | null }
): Promise<{ applications: DepositApplication[]; totalApplied: number }> {
    return UnitOfWork.run(pool, async (client) => {
        return applyDepositsToSaleInTransaction(
            client,
            customerId,
            saleId,
            amountToApply,
            appliedBy,
            options,
        );
    });
}

export interface DepositApplicationRestore {
    /** Amount whose liability journal and deposit balance both moved. */
    restored: number;
    applications: number;
}

/**
 * Put deposit applications for a sale back onto the customer deposit,
 * in the caller's transaction.
 *
 * The deposit balance moves only when the matching DEPOSIT_APPLICATION
 * journal moves with it. An application with no journal is left in place,
 * because restoring the balance alone would break the liability.
 * Newest applications are restored first, up to `amount`.
 */
export async function restoreSaleDepositApplicationsInTransaction(
    client: PoolClient,
    pool: Pool,
    input: {
        saleId: string;
        amount: number;
        reversalDate: string;
        reason: string;
        userId: string;
    },
): Promise<DepositApplicationRestore> {
    const cap = money2(input.amount);
    if (!cap.greaterThan(0)) {
        return { restored: 0, applications: 0 };
    }

    const apps = await client.query<{
        id: string;
        amount_applied: string;
        customer_id: string;
        deposit_number: string;
    }>(
        `SELECT a.id, a.amount_applied, d.customer_id, d.deposit_number
         FROM pos_deposit_applications a
         JOIN pos_customer_deposits d ON d.id = a.deposit_id
         WHERE a.sale_id = $1
         ORDER BY a.applied_at DESC, a.id DESC
         FOR UPDATE OF a, d`,
        [input.saleId],
    );

    let remaining = cap;
    let restored = money2(0);
    let applications = 0;

    for (const app of apps.rows) {
        if (!remaining.greaterThan(0.009)) break;
        const applied = money2(app.amount_applied);
        if (!applied.greaterThan(0)) continue;

        const journal = await client.query<{ Id: string }>(
            `SELECT "Id"
             FROM ledger_transactions
             WHERE "ReferenceType" = 'DEPOSIT_APPLICATION'
               AND "ReferenceId" = $1
               AND "IsReversed" = FALSE
             ORDER BY "CreatedAt" DESC
             LIMIT 1`,
            [app.id],
        );
        if (journal.rows.length === 0) {
            logger.warn('Deposit application left in place: no unreversed journal to match it', {
                applicationId: app.id,
                saleId: input.saleId,
            });
            continue;
        }

        const slice = Decimal.min(remaining, applied);
        const whole = slice.minus(applied).abs().lessThan(0.001);
        if (whole) {
            await AccountingCore.reverseTransaction({
                originalTransactionId: journal.rows[0].Id,
                reversalDate: input.reversalDate,
                reason: input.reason,
                userId: input.userId,
                idempotencyKey: `DEPOSIT_APP_RESTORE-${app.id}`,
            }, pool, client);
            await depositsRepository.reverseDepositApplicationInTransaction(client, app.id);
        } else {
            const amount = slice.toDecimalPlaces(2).toNumber();
            await AccountingCore.createJournalEntry({
                entryDate: input.reversalDate,
                description: `Restore part of ${app.deposit_number}: ${input.reason}`,
                referenceType: 'DEPOSIT_APPLICATION_REVERSAL',
                referenceId: `${app.id}:${slice.toFixed(2)}`,
                referenceNumber: `REV-${app.deposit_number}`,
                lines: [
                    {
                        accountCode: glEntryService.AccountCodes.ACCOUNTS_RECEIVABLE,
                        description: `AR reopened — part of ${app.deposit_number} restored`,
                        debitAmount: amount,
                        creditAmount: 0,
                        entityType: 'customer',
                        entityId: app.customer_id,
                    },
                    {
                        accountCode: glEntryService.AccountCodes.CUSTOMER_DEPOSITS,
                        description: `Customer deposit restored — ${app.deposit_number}`,
                        debitAmount: 0,
                        creditAmount: amount,
                        entityType: 'customer',
                        entityId: app.customer_id,
                    },
                ],
                userId: input.userId,
                idempotencyKey: `DEPOSIT_APP_RESTORE-${app.id}-${slice.toFixed(2)}`,
                source: 'SYSTEM_CORRECTION',
            }, pool, client);
            await depositsRepository.reduceDepositApplicationInTransaction(
                client,
                app.id,
                slice.toFixed(2),
            );
        }

        remaining = remaining.minus(slice);
        restored = restored.plus(slice);
        applications += 1;
        logger.info('Deposit application restored with its journal', {
            depositNumber: app.deposit_number,
            amount: slice.toFixed(2),
            saleId: input.saleId,
        });
    }

    return {
        restored: restored.toDecimalPlaces(2).toNumber(),
        applications,
    };
}

/**
 * Reverse all deposit applications for a sale.
 * Balance and liability move together inside one transaction.
 */
export async function reverseDepositsForSale(
    pool: Pool,
    saleId: string,
    input: { reversalDate: string; reason: string; userId: string },
): Promise<number> {
    const result = await UnitOfWork.run(pool, async (client) => {
        return restoreSaleDepositApplicationsInTransaction(client, pool, {
            saleId,
            amount: Number.MAX_SAFE_INTEGER,
            reversalDate: input.reversalDate,
            reason: input.reason,
            userId: input.userId,
        });
    });
    return result.applications;
}

/**
 * Get deposit applications for a sale
 */
export async function getSaleDepositApplications(
    pool: Pool,
    saleId: string
): Promise<DepositApplication[]> {
    const rows = await depositsRepository.getDepositApplicationsBySale(pool, saleId);
    return rows.map(normalizeApplication);
}

/**
 * Get all deposits with pagination
 */
export async function getAllDeposits(
    pool: Pool,
    options: {
        page?: number;
        limit?: number;
        status?: string;
        customerId?: string;
    } = {}
): Promise<{ deposits: Deposit[]; total: number; page: number; limit: number; totalPages: number }> {
    const { deposits, total } = await depositsRepository.getAllDeposits(pool, options);
    const page = options.page || 1;
    const limit = options.limit || 20;

    return {
        deposits: deposits.map(normalizeDeposit),
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit)
    };
}

/**
 * Refund a deposit
 */
export async function refundDeposit(
    pool: Pool,
    depositId: string,
    reason?: string
): Promise<Deposit> {
    const row = await depositsRepository.refundDeposit(pool, depositId, reason);

    logger.info('Deposit refunded', {
        depositNumber: row.deposit_number,
        amount: row.amount_available,
        reason
    });

    return normalizeDeposit(row);
}

/**
 * Backfill GL entries for orphaned deposits that have no ledger_transactions.
 * Finds deposits in pos_customer_deposits that lack a CUSTOMER_DEPOSIT
 * entry in ledger_transactions, and posts the missing GL entry.
 * Uses idempotency keys to prevent duplicates.
 */
export async function backfillOrphanedDepositGL(
    pool: Pool
): Promise<{ backfilled: number; errors: string[] }> {
    // Find deposits missing GL entries
    const orphanResult = await pool.query(`
        SELECT d.id, d.deposit_number, d.customer_id, d.amount, d.payment_method,
               d.created_at::text as created_at, c.name as customer_name
        FROM pos_customer_deposits d
        JOIN customers c ON d.customer_id = c.id
        WHERE d.status IN ('ACTIVE', 'DEPLETED')
          AND NOT EXISTS (
            SELECT 1 FROM ledger_transactions lt
            WHERE lt."IdempotencyKey" = 'CUSTOMER_DEPOSIT-' || d.id::text
          )
        ORDER BY d.created_at ASC
    `);

    const orphans = orphanResult.rows;
    let backfilled = 0;
    const errors: string[] = [];

    for (const dep of orphans) {
        try {
            const depositDate = dep.created_at.includes('T')
                ? dep.created_at.split('T')[0]
                : dep.created_at.split(' ')[0];

            await glEntryService.recordCustomerDepositToGL({
                depositId: dep.id,
                depositNumber: dep.deposit_number,
                depositDate,
                amount: Money.toNumber(Money.parseDb(dep.amount)),
                paymentMethod: dep.payment_method as 'CASH' | 'CARD' | 'MOBILE_MONEY' | 'BANK_TRANSFER',
                customerId: dep.customer_id,
                customerName: dep.customer_name || 'Unknown',
            }, pool);
            backfilled++;
            logger.info('Backfilled GL for orphaned deposit', { depositNumber: dep.deposit_number });
        } catch (err) {
            const msg = `Failed to backfill ${dep.deposit_number}: ${err instanceof Error ? err.message : String(err)}`;
            errors.push(msg);
            logger.error(msg);
        }
    }

    return { backfilled, errors };
}
