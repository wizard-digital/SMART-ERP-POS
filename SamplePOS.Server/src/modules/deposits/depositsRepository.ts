/**
 * Deposits Repository - Raw SQL queries for customer deposits
 * Part of the SamplePOS hybrid architecture (Node.js managed deposits)
 */

import { Pool, PoolClient } from 'pg';
import Decimal from 'decimal.js';
import { UnitOfWork } from '../../db/unitOfWork.js';
import { getBusinessYear } from '../../utils/dateRange.js';
import { Money } from '../../utils/money.js';

// Type for either a Pool or PoolClient - allows reuse in transactions
type DbConnection = Pool | PoolClient;

export interface DepositDbRow {
    id: string;
    deposit_number: string;
    customer_id: string;
    amount: string;
    amount_used: string;
    amount_available: string;
    payment_method: string;
    reference: string | null;
    notes: string | null;
    status: 'ACTIVE' | 'DEPLETED' | 'REFUNDED' | 'CANCELLED';
    created_by: string | null;
    created_at: string;
    updated_at: string;
    customer_name?: string;
}

export interface DepositApplicationDbRow {
    id: string;
    deposit_id: string;
    sale_id: string | null;
    invoice_id?: string | null;
    amount_applied: string;
    applied_at: string;
    applied_by: string | null;
    deposit_number?: string;
    sale_number?: string;
}

export interface CustomerDepositSummary {
    customer_id: string;
    customer_name: string;
    available_deposit_balance: string;
    total_deposits: string;
    total_deposits_used: string;
    active_deposit_count: number;
}

export interface CreateDepositInput {
    customerId: string;
    amount: number;
    paymentMethod: 'CASH' | 'CARD' | 'MOBILE_MONEY' | 'BANK_TRANSFER';
    reference?: string;
    notes?: string;
    createdBy?: string;
}

export interface ApplyDepositInput {
    depositId: string;
    saleId: string | null;
    invoiceId?: string | null;
    amount: number | string;
    appliedBy?: string;
}

/**
 * Generate next deposit number (DEP-YYYY-####)
 */
export async function generateDepositNumber(
    pool: DbConnection
): Promise<string> {
    const year = getBusinessYear();
    const seq = await pool.query("SELECT nextval('deposit_number_seq')");
    const num = seq.rows[0].nextval;
    return `DEP-${year}-${String(num).padStart(4, '0')}`;
}

/**
 * Create a new customer deposit
 */
export async function createDeposit(
    pool: DbConnection,
    input: CreateDepositInput
): Promise<DepositDbRow> {
    const depositNumber = await generateDepositNumber(pool);

    const result = await pool.query<DepositDbRow>(
        `INSERT INTO pos_customer_deposits 
     (deposit_number, customer_id, amount, amount_available, payment_method, reference, notes, created_by)
     VALUES ($1, $2, $3, $3, $4, $5, $6, $7)
     RETURNING *`,
        [
            depositNumber,
            input.customerId,
            input.amount,
            input.paymentMethod,
            input.reference || null,
            input.notes || null,
            input.createdBy || null
        ]
    );
    return result.rows[0];
}

/**
 * Get deposit by ID
 */
export async function getDepositById(
    pool: Pool,
    depositId: string
): Promise<DepositDbRow | null> {
    const result = await pool.query<DepositDbRow>(
        `SELECT d.*, c.name as customer_name
     FROM pos_customer_deposits d
     JOIN customers c ON d.customer_id = c.id
     WHERE d.id = $1`,
        [depositId]
    );
    return result.rows[0] || null;
}

/**
 * Get deposits by customer ID
 */
export async function getDepositsByCustomer(
    pool: Pool,
    customerId: string,
    status?: 'ACTIVE' | 'DEPLETED' | 'REFUNDED' | 'CANCELLED'
): Promise<DepositDbRow[]> {
    let query = `
    SELECT d.*, c.name as customer_name
    FROM pos_customer_deposits d
    JOIN customers c ON d.customer_id = c.id
    WHERE d.customer_id = $1
  `;
    const params: unknown[] = [customerId];

    if (status) {
        query += ` AND d.status = $2`;
        params.push(status);
    }

    query += ` ORDER BY d.created_at DESC`;

    const result = await pool.query<DepositDbRow>(query, params);
    return result.rows;
}

/**
 * Get all active deposits with available balance for a customer
 * Uses FIFO order (oldest deposits first)
 */
export async function getActiveDepositsForCustomer(
    dbConn: DbConnection,
    customerId: string
): Promise<DepositDbRow[]> {
    const result = await dbConn.query<DepositDbRow>(
        `SELECT d.*, c.name as customer_name
     FROM pos_customer_deposits d
     JOIN customers c ON d.customer_id = c.id
     WHERE d.customer_id = $1 
       AND d.status = 'ACTIVE'
       AND d.amount_available > 0
     ORDER BY d.created_at ASC, d.id ASC`,
        [customerId]
    );
    return result.rows;
}

/**
 * Lock all active customer deposits in FIFO order (same order as apply).
 * Prevents concurrent Receive Payment / POS apply from over-consuming 2200.
 */
export async function lockActiveDepositsForCustomer(
    client: PoolClient,
    customerId: string
): Promise<DepositDbRow[]> {
    const result = await client.query<DepositDbRow>(
        `SELECT d.*, c.name as customer_name
     FROM pos_customer_deposits d
     JOIN customers c ON d.customer_id = c.id
     WHERE d.customer_id = $1
       AND d.status = 'ACTIVE'
       AND d.amount_available > 0
     ORDER BY d.created_at ASC, d.id ASC
     FOR UPDATE OF d`,
        [customerId]
    );
    return result.rows;
}

/**
 * Get customer deposit summary (available balance)
 */
export async function getCustomerDepositSummary(
    dbConn: DbConnection,
    customerId: string
): Promise<CustomerDepositSummary | null> {
    const result = await dbConn.query<CustomerDepositSummary>(
        `SELECT * FROM customer_deposit_summary WHERE customer_id = $1`,
        [customerId]
    );
    return result.rows[0] || null;
}

/**
 * Apply deposit to a sale (uses deposit funds)
 * If a PoolClient is passed, it's assumed to be in an existing transaction
 * If a Pool is passed, a new transaction is created
 */
export async function applyDepositToSale(
    dbConn: DbConnection,
    input: ApplyDepositInput
): Promise<DepositApplicationDbRow> {
    // Check if we're in an existing transaction (PoolClient) or need our own (Pool)
    // Pool has 'connect' method, PoolClient does not
    const isPool = 'connect' in dbConn && typeof (dbConn as Pool).connect === 'function';

    if (!isPool) {
        // Use the provided client directly (already in transaction)
        return applyDepositToSaleWithClient(dbConn as PoolClient, input);
    }

    // Create our own transaction using UnitOfWork
    return UnitOfWork.run(dbConn as Pool, async (client) => {
        return applyDepositToSaleWithClient(client, input);
    });
}

/**
 * Apply deposit to a sale using an existing transaction client
 * Use this when calling from within an existing transaction
 */
export async function applyDepositToSaleInTransaction(
    client: PoolClient,
    input: ApplyDepositInput
): Promise<DepositApplicationDbRow> {
    if (!input.saleId && !input.invoiceId) {
        throw new Error('DEPOSIT_APPLY_TARGET_REQUIRED: saleId or invoiceId must be provided');
    }

    // Lock the deposit row to prevent race conditions
    const depositResult = await client.query<DepositDbRow>(
        `SELECT * FROM pos_customer_deposits 
     WHERE id = $1 AND status = 'ACTIVE'
     FOR UPDATE`,
        [input.depositId]
    );

    if (depositResult.rows.length === 0) {
        throw new Error('Deposit not found or not active');
    }

    const deposit = depositResult.rows[0];
    const available = Money.parseDb(deposit.amount_available);
    const amountToApply = Money.round(input.amount);

    if (amountToApply.lte(0)) {
        throw new Error('DEPOSIT_APPLY_AMOUNT_INVALID: amount must be greater than zero');
    }
    if (amountToApply.greaterThan(available)) {
        throw new Error(`Insufficient deposit balance. Available: ${available.toFixed(2)}, Requested: ${amountToApply.toFixed(2)}`);
    }

    const amountFixed = amountToApply.toFixed(2);

    // invoice_id column is added by migration 600. Sale-only apply stays compatible
    // with the original schema so POS does not depend on 600.
    let applicationResult;
    if (!input.saleId && input.invoiceId) {
        try {
            applicationResult = await client.query<DepositApplicationDbRow>(
                `INSERT INTO pos_deposit_applications
             (deposit_id, sale_id, invoice_id, amount_applied, applied_by)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING *`,
                [
                    input.depositId,
                    null,
                    input.invoiceId,
                    amountFixed,
                    input.appliedBy || null,
                ],
            );
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (/invoice_id/i.test(msg) && /does not exist|undefined column/i.test(msg)) {
                throw new Error(
                    'DEPOSIT_APPLY_INVOICE_TARGET: apply shared/sql/600_deposit_apply_invoice.sql before using deposit on invoices without a linked sale.',
                );
            }
            throw err;
        }
    } else {
        applicationResult = await client.query<DepositApplicationDbRow>(
            `INSERT INTO pos_deposit_applications
         (deposit_id, sale_id, amount_applied, applied_by)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
            [
                input.depositId,
                input.saleId,
                amountFixed,
                input.appliedBy || null,
            ],
        );
    }

    // Update deposit used amount, available amount, and status
    // (replaces trg_update_deposit_status trigger)
    const newUsed = Money.parseDb(deposit.amount_used).plus(amountToApply);
    const depositAmount = Money.parseDb(deposit.amount);
    const newAvailable = depositAmount.minus(newUsed);
    const newStatus = newAvailable.lessThanOrEqualTo(0) ? 'DEPLETED' : 'ACTIVE';
    const availableFixed = (newAvailable.greaterThan(0) ? newAvailable : new Decimal(0)).toFixed(2);

    await client.query(
        `UPDATE pos_customer_deposits 
     SET amount_used = $1, amount_available = $2, status = $3
     WHERE id = $4`,
        [newUsed.toFixed(2), availableFixed, newStatus, input.depositId]
    );

    return applicationResult.rows[0];
}

/**
 * Internal function to apply deposit within a transaction client
 */
async function applyDepositToSaleWithClient(
    client: PoolClient,
    input: ApplyDepositInput
): Promise<DepositApplicationDbRow> {
    return applyDepositToSaleInTransaction(client, input);
}

/**
 * Reverse a deposit application using an existing transaction client
 */
export async function reverseDepositApplicationInTransaction(
    client: PoolClient,
    applicationId: string
): Promise<void> {
    // Get the application
    const appResult = await client.query<DepositApplicationDbRow>(
        `SELECT * FROM pos_deposit_applications WHERE id = $1`,
        [applicationId]
    );

    if (appResult.rows.length === 0) {
        throw new Error('Deposit application not found');
    }

    const application = appResult.rows[0];

    // Lock and update the deposit — recalculate available + status
    // (replaces trg_update_deposit_status trigger)
    await client.query(
        `UPDATE pos_customer_deposits 
     SET amount_used = amount_used - $1,
         amount_available = amount - (amount_used - $1),
         status = CASE WHEN (amount - (amount_used - $1)) > 0 THEN 'ACTIVE' ELSE 'DEPLETED' END
     WHERE id = $2`,
        [application.amount_applied, application.deposit_id]
    );

    // Delete the application record
    await client.query(
        `DELETE FROM pos_deposit_applications WHERE id = $1`,
        [applicationId]
    );
}

/**
 * Put part of an application back on the deposit. The application row stays
 * when some of it is still applied to the sale.
 */
export async function reduceDepositApplicationInTransaction(
    client: PoolClient,
    applicationId: string,
    reduceBy: string,
): Promise<void> {
    const appResult = await client.query<{ amount_applied: string; deposit_id: string }>(
        `SELECT amount_applied, deposit_id
         FROM pos_deposit_applications
         WHERE id = $1
         FOR UPDATE`,
        [applicationId],
    );
    if (appResult.rows.length === 0) {
        throw new Error('Deposit application not found');
    }
    const application = appResult.rows[0];
    const remaining = new Decimal(application.amount_applied).minus(reduceBy);
    if (remaining.lessThan(-0.001)) {
        throw new Error('Deposit application reduction exceeds the amount applied');
    }

    await client.query(
        `UPDATE pos_customer_deposits
         SET amount_used = amount_used - $1,
             amount_available = amount - (amount_used - $1),
             status = CASE WHEN (amount - (amount_used - $1)) > 0 THEN 'ACTIVE' ELSE 'DEPLETED' END
         WHERE id = $2`,
        [reduceBy, application.deposit_id],
    );

    if (remaining.abs().lessThan(0.001)) {
        await client.query(`DELETE FROM pos_deposit_applications WHERE id = $1`, [applicationId]);
        return;
    }

    await client.query(
        `UPDATE pos_deposit_applications
         SET amount_applied = $1
         WHERE id = $2`,
        [remaining.toDecimalPlaces(2).toFixed(2), applicationId],
    );
}

/**
 * Reverse a deposit application (e.g., when voiding a sale)
 * Creates its own transaction when called with a Pool.
 */
export async function reverseDepositApplication(
    pool: Pool,
    applicationId: string
): Promise<void> {
    await UnitOfWork.run(pool, async (client) => {
        await reverseDepositApplicationInTransaction(client, applicationId);
    });
}

/**
 * Get deposit applications for a sale
 */
export async function getDepositApplicationsBySale(
    pool: Pool,
    saleId: string
): Promise<DepositApplicationDbRow[]> {
    const result = await pool.query<DepositApplicationDbRow>(
        `SELECT a.*, d.deposit_number, s.sale_number
     FROM pos_deposit_applications a
     JOIN pos_customer_deposits d ON a.deposit_id = d.id
     LEFT JOIN sales s ON a.sale_id = s.id
     WHERE a.sale_id = $1
     ORDER BY a.applied_at`,
        [saleId]
    );
    return result.rows;
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
): Promise<{ deposits: DepositDbRow[]; total: number }> {
    const page = options.page || 1;
    const limit = options.limit || 20;
    const offset = (page - 1) * limit;

    let whereClause = 'WHERE 1=1';
    const params: unknown[] = [];
    let paramIndex = 1;

    if (options.status) {
        whereClause += ` AND d.status = $${paramIndex++}`;
        params.push(options.status);
    }

    if (options.customerId) {
        whereClause += ` AND d.customer_id = $${paramIndex++}`;
        params.push(options.customerId);
    }

    // Get total count
    const countResult = await pool.query(
        `SELECT COUNT(*) FROM pos_customer_deposits d ${whereClause}`,
        params
    );
    const total = parseInt(countResult.rows[0].count, 10);

    // Get deposits with pagination
    const depositsResult = await pool.query<DepositDbRow>(
        `SELECT d.*, c.name as customer_name
     FROM pos_customer_deposits d
     JOIN customers c ON d.customer_id = c.id
     ${whereClause}
     ORDER BY d.created_at DESC
     LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
        [...params, limit, offset]
    );

    return {
        deposits: depositsResult.rows,
        total
    };
}

/**
 * Refund a deposit (mark as refunded and restore to customer)
 */
export async function refundDeposit(
    pool: Pool,
    depositId: string,
    reason?: string
): Promise<DepositDbRow> {
    const result = await pool.query<DepositDbRow>(
        `UPDATE pos_customer_deposits 
     SET status = 'REFUNDED',
         notes = COALESCE(notes || ' | ', '') || 'REFUNDED: ' || COALESCE($2, 'No reason provided'),
         updated_at = NOW()
     WHERE id = $1 AND status = 'ACTIVE'
     RETURNING *`,
        [depositId, reason || null]
    );

    if (result.rows.length === 0) {
        throw new Error('Deposit not found or not refundable');
    }

    return result.rows[0];
}
