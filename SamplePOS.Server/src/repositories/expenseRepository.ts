import { pool as globalPool } from '../db/pool.js';
import type pg from 'pg';
import { ExpenseFilters, Expense, ExpenseDbRow, CreateExpenseData, UpdateExpenseData } from '../types/expense.js';
import logger from '../utils/logger.js';
import { ConflictError, ValidationError } from '../middleware/errorHandler.js';
import { getBusinessDate, formatDateBusiness } from '../utils/dateRange.js';
import {
  mapExpenseCategoryCodeToGl,
  normalizeExpenseCategoryCode,
} from '../../../shared/expense/categoryGlMap.js';
import {
  EXPENSE_NOT_VOID_SQL,
  EXPENSE_RECOGNIZED_SQL,
  expenseNotVoidSql,
} from '../../../shared/expense/expenseLiveStatusSsot.js';

type ResolvedExpenseCategory = {
  id: string;
  code: string;
  name: string;
  accountId: string | null;
};

/**
 * Resolve an expense category by id and/or code (including legacy aliases).
 * Ensures both category_id and GL account_id can be set accurately.
 */
export const resolveExpenseCategory = async (
  opts: { categoryId?: string | null; categoryCode?: string | null },
  dbPool?: pg.Pool | pg.PoolClient
): Promise<ResolvedExpenseCategory> => {
  const pool = dbPool || globalPool;
  const rawCode = opts.categoryCode?.trim();
  const normalizedCode = rawCode ? normalizeExpenseCategoryCode(rawCode) : null;

  if (opts.categoryId) {
    const byId = await pool.query(
      `SELECT id, code, name, account_id
       FROM expense_categories
       WHERE id = $1`,
      [opts.categoryId]
    );
    if (byId.rows[0]) {
      return {
        id: byId.rows[0].id,
        code: byId.rows[0].code,
        name: byId.rows[0].name,
        accountId: byId.rows[0].account_id,
      };
    }
  }

  if (rawCode || normalizedCode) {
    const codes = Array.from(
      new Set([rawCode?.toUpperCase(), normalizedCode].filter(Boolean) as string[])
    );
    const byCode = await pool.query(
      `SELECT id, code, name, account_id
       FROM expense_categories
       WHERE UPPER(code) = ANY($1::text[])
       ORDER BY CASE WHEN is_active THEN 0 ELSE 1 END, updated_at DESC
       LIMIT 1`,
      [codes]
    );
    if (byCode.rows[0]) {
      return {
        id: byCode.rows[0].id,
        code: byCode.rows[0].code,
        name: byCode.rows[0].name,
        accountId: byCode.rows[0].account_id,
      };
    }
  }

  throw new ValidationError(
    `Unknown expense category${rawCode ? `: ${rawCode}` : opts.categoryId ? ` id ${opts.categoryId}` : ''}`
  );
};

async function resolveGlAccountIdForCategory(
  category: ResolvedExpenseCategory,
  dbPool: pg.Pool | pg.PoolClient
): Promise<string | null> {
  if (category.accountId) return category.accountId;

  const glCode = mapExpenseCategoryCodeToGl(category.code);
  const fallback = await dbPool.query(
    `SELECT "Id" FROM accounts WHERE "AccountCode" = $1 LIMIT 1`,
    [glCode]
  );
  if (fallback.rows[0]?.Id) {
    // Persist mapping so future posts / reports stay consistent
    await dbPool.query(
      `UPDATE expense_categories SET account_id = $1, updated_at = NOW() WHERE id = $2 AND account_id IS NULL`,
      [fallback.rows[0].Id, category.id]
    );
    return fallback.rows[0].Id;
  }

  const general = await dbPool.query(
    `SELECT "Id" FROM accounts WHERE "AccountCode" = '6900' LIMIT 1`
  );
  return general.rows[0]?.Id ?? null;
}

/**
 * Resolve GL AccountCode for an expense (DB account_id → category → hardcoded map).
 */
export const resolveExpenseGlAccountCode = async (
  expenseId: string,
  fallbackCategoryCode: string | null | undefined,
  dbPool?: pg.Pool | pg.PoolClient
): Promise<string> => {
  const pool = dbPool || globalPool;
  const result = await pool.query(
    `SELECT a."AccountCode" AS expense_account_code,
            ca."AccountCode" AS category_account_code,
            COALESCE(ec.code, e.category) AS category_code
     FROM expenses e
     LEFT JOIN accounts a ON e.account_id = a."Id"
     LEFT JOIN expense_categories ec ON e.category_id = ec.id
     LEFT JOIN accounts ca ON ec.account_id = ca."Id"
     WHERE e.id = $1`,
    [expenseId]
  );
  const row = result.rows[0];
  if (row?.expense_account_code) return row.expense_account_code;
  if (row?.category_account_code) return row.category_account_code;
  return mapExpenseCategoryCodeToGl(row?.category_code || fallbackCategoryCode);
};

/**
 * Get expenses with filtering and pagination
 * Updated to match actual database schema
 */
export const getExpenses = async (filters: ExpenseFilters, dbPool?: pg.Pool | pg.PoolClient): Promise<Expense[]> => {
  const pool = dbPool || globalPool;
  try {
    let query = `
      SELECT 
        e.id,
        e.expense_number,
        e.title,
        e.description,
        e.amount,
        e.expense_date,
        e.category,
        e.category_id,
        e.vendor,
        e.employee_id,
        e.payment_method,
        e.notes,
        e.status,
        e.created_by,
        e.approved_by,
        e.rejected_by,
        e.paid_by,
        e.rejection_reason,
        e.reversed_by,
        e.reversed_at,
        e.reversal_reason,
        e.created_at,
        e.updated_at,
        e.approved_at,
        e.rejected_at,
        e.paid_at,
        ec.name as category_name,
        ec.code as category_code,
        uc.full_name as created_by_name,
        ua.full_name as approved_by_name,
        ur.full_name as rejected_by_name,
        up.full_name as paid_by_name,
        NULLIF(TRIM(CONCAT(COALESCE(emp."FirstName", ''), ' ', COALESCE(emp."LastName", ''))), '') AS employee_name
      FROM expenses e
      LEFT JOIN expense_categories ec ON e.category_id = ec.id
      LEFT JOIN users uc ON e.created_by = uc.id
      LEFT JOIN users ua ON e.approved_by = ua.id
      LEFT JOIN users ur ON e.rejected_by = ur.id
      LEFT JOIN users up ON e.paid_by = up.id
      LEFT JOIN employees emp ON e.employee_id = emp."Id"
      WHERE 1=1
    `;

    const queryParams: unknown[] = [];
    let paramIndex = 1;

    // Add filters
    if (filters.status) {
      // Explicit status filter — respect it exactly
      query += ` AND e.status = $${paramIndex}`;
      queryParams.push(filters.status);
      paramIndex++;
    } else {
      // No status filter: hide cancelled expenses from default list view
      query += ` AND e.status != 'CANCELLED'`;
    }

    if (filters.categoryId) {
      query += ` AND e.category_id = $${paramIndex}`;
      queryParams.push(filters.categoryId);
      paramIndex++;
    } else if (filters.categoryCode) {
      query += ` AND (
        UPPER(e.category) = UPPER($${paramIndex})
        OR e.category_id IN (
          SELECT id FROM expense_categories WHERE UPPER(code) = UPPER($${paramIndex})
        )
      )`;
      queryParams.push(filters.categoryCode);
      paramIndex++;
    }

    if (filters.employeeId) {
      query += ` AND e.employee_id = $${paramIndex}`;
      queryParams.push(filters.employeeId);
      paramIndex++;
    }

    if (filters.startDate) {
      query += ` AND e.expense_date >= $${paramIndex}`;
      queryParams.push(filters.startDate);
      paramIndex++;
    }

    if (filters.endDate) {
      query += ` AND e.expense_date <= $${paramIndex}`;
      queryParams.push(filters.endDate);
      paramIndex++;
    }

    if (filters.search) {
      query += ` AND (
        e.title ILIKE $${paramIndex}
        OR e.description ILIKE $${paramIndex}
        OR e.category ILIKE $${paramIndex}
        OR e.vendor ILIKE $${paramIndex}
        OR emp."FirstName" ILIKE $${paramIndex}
        OR emp."LastName" ILIKE $${paramIndex}
      )`;
      queryParams.push(`%${filters.search}%`);
      paramIndex++;
    }

    // Add ordering and pagination
    query += ` ORDER BY e.created_at DESC`;
    query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    queryParams.push(filters.limit, (filters.page - 1) * filters.limit);

    const result = await pool.query(query, queryParams);
    return result.rows.map(normalizeExpenseFromDb);
  } catch (error) {
    logger.error('Error in expenseRepository getExpenses', { error, filters });
    throw error;
  }
};

/**
 * Get total count of expenses matching filters
 */
export const getExpenseCount = async (filters: ExpenseFilters, dbPool?: pg.Pool | pg.PoolClient): Promise<number> => {
  const pool = dbPool || globalPool;
  try {
    let query = `
      SELECT COUNT(*) as count
      FROM expenses e
      WHERE 1=1
    `;

    const queryParams: unknown[] = [];
    let paramIndex = 1;

    // Add same filters as getExpenses (without joins for performance)
    if (filters.status) {
      query += ` AND e.status = $${paramIndex}`;
      queryParams.push(filters.status);
      paramIndex++;
    } else {
      query += ` AND e.status != 'CANCELLED'`;
    }

    if (filters.categoryId) {
      query += ` AND e.category_id = $${paramIndex}`;
      queryParams.push(filters.categoryId);
      paramIndex++;
    } else if (filters.categoryCode) {
      query += ` AND (
        UPPER(e.category) = UPPER($${paramIndex})
        OR e.category_id IN (
          SELECT id FROM expense_categories WHERE UPPER(code) = UPPER($${paramIndex})
        )
      )`;
      queryParams.push(filters.categoryCode);
      paramIndex++;
    }

    if (filters.employeeId) {
      query += ` AND e.employee_id = $${paramIndex}`;
      queryParams.push(filters.employeeId);
      paramIndex++;
    }

    if (filters.startDate) {
      query += ` AND e.expense_date >= $${paramIndex}`;
      queryParams.push(filters.startDate);
      paramIndex++;
    }

    if (filters.endDate) {
      query += ` AND e.expense_date <= $${paramIndex}`;
      queryParams.push(filters.endDate);
      paramIndex++;
    }

    if (filters.search) {
      query += ` AND (
        e.title ILIKE $${paramIndex}
        OR e.description ILIKE $${paramIndex}
        OR e.category ILIKE $${paramIndex}
        OR e.vendor ILIKE $${paramIndex}
        OR EXISTS (
          SELECT 1 FROM employees emp
          WHERE emp."Id" = e.employee_id
            AND (emp."FirstName" ILIKE $${paramIndex} OR emp."LastName" ILIKE $${paramIndex})
        )
      )`;
      queryParams.push(`%${filters.search}%`);
    }

    const result = await pool.query(query, queryParams);
    return parseInt(result.rows[0].count);
  } catch (error) {
    logger.error('Error in expenseRepository getExpenseCount', { error, filters });
    throw error;
  }
};

/**
 * Get expense by ID
 */
export const getExpenseById = async (id: string, dbPool?: pg.Pool | pg.PoolClient): Promise<Expense | null> => {
  const pool = dbPool || globalPool;
  try {
    const query = `
      SELECT 
        e.id,
        e.expense_number,
        e.title,
        e.description,
        e.amount,
        e.expense_date,
        e.category,
        e.category_id,
        e.vendor,
        e.employee_id,
        e.payment_method,
        e.notes,
        e.status,
        e.created_by,
        e.approved_by,
        e.rejected_by,
        e.paid_by,
        e.rejection_reason,
        e.reversed_by,
        e.reversed_at,
        e.reversal_reason,
        e.created_at,
        e.updated_at,
        e.approved_at,
        e.rejected_at,
        e.paid_at,
        ec.name as category_name,
        ec.code as category_code,
        uc.full_name as created_by_name,
        ua.full_name as approved_by_name,
        ur.full_name as rejected_by_name,
        up.full_name as paid_by_name,
        NULLIF(TRIM(CONCAT(COALESCE(emp."FirstName", ''), ' ', COALESCE(emp."LastName", ''))), '') AS employee_name
      FROM expenses e
      LEFT JOIN expense_categories ec ON e.category_id = ec.id
      LEFT JOIN users uc ON e.created_by = uc.id
      LEFT JOIN users ua ON e.approved_by = ua.id
      LEFT JOIN users ur ON e.rejected_by = ur.id
      LEFT JOIN users up ON e.paid_by = up.id
      LEFT JOIN employees emp ON e.employee_id = emp."Id"
      WHERE e.id = $1
    `;

    const result = await pool.query(query, [id]);
    return result.rows.length > 0 ? normalizeExpenseFromDb(result.rows[0]) : null;
  } catch (error) {
    logger.error('Error in expenseRepository getExpenseById', { error, id });
    throw error;
  }
};

/**
 * Create new expense
 * Updated to include payment_status and payment_account_id for GL posting
 */
export const createExpense = async (data: CreateExpenseData & { expense_number: string; status: string }, dbPool?: pg.Pool | pg.PoolClient): Promise<Expense> => {
  const pool = dbPool || globalPool;
  try {
    const category = await resolveExpenseCategory(
      { categoryId: data.category_id, categoryCode: data.category },
      pool
    );
    const expenseAccountId = await resolveGlAccountIdForCategory(category, pool);

    // payment_account_id is the cash/bank account used for payment (CREDIT side)
    // This comes from user selection when they mark expense as PAID
    const paymentAccountId = data.payment_account_id || null;
    const paymentStatus = data.payment_status || 'UNPAID';

    const query = `
      INSERT INTO expenses (
        expense_number, title, description, amount, expense_date,
        category, category_id, vendor, employee_id, payment_method, notes,
        status, created_by, account_id, payment_status, payment_account_id
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
      ) RETURNING *
    `;

    const values = [
      data.expense_number,
      data.title,
      data.description || null,
      data.amount,
      data.expense_date,
      category.code,
      category.id,
      data.vendor || null,
      data.employee_id || null,
      data.payment_method || null,
      data.notes || null,
      data.status,
      data.created_by || null,
      expenseAccountId,
      paymentStatus,
      paymentAccountId
    ];

    const result = await pool.query(query, values);
    // Re-fetch with employee join for display name
    return (await getExpenseById(result.rows[0].id, pool)) ?? normalizeExpenseFromDb(result.rows[0]);
  } catch (error) {
    logger.error('Error in expenseRepository createExpense', { error, data });
    throw error;
  }
};

/**
 * Update expense
 */
export const updateExpense = async (id: string, data: UpdateExpenseData, dbPool?: pg.Pool | pg.PoolClient): Promise<Expense | null> => {
  const pool = dbPool || globalPool;
  try {
    // Protection: block modification of finalized expenses (replaces trg_protect_paid_expense)
    const current = await pool.query('SELECT status FROM expenses WHERE id = $1', [id]);
    if (!current.rows[0]) return null;
    const currentStatus = current.rows[0].status;
    if (currentStatus === 'REVERSED') {
      throw new ConflictError('Cannot modify a reversed expense');
    }
    if (currentStatus === 'PAID') {
      throw new ConflictError('Cannot modify a paid expense');
    }
    if (currentStatus === 'APPROVED') {
      const newStatus = (data as Record<string, unknown>).status as string | undefined;
      if (newStatus && !['PAID', 'CANCELLED'].includes(newStatus)) {
        throw new ConflictError('Approved expense can only transition to PAID or CANCELLED');
      }
    }

    // When category_id or category code changes, sync legacy category text + GL account_id
    const updatePayload: Record<string, unknown> = { ...data };
    if (data.category_id || data.category) {
      const category = await resolveExpenseCategory(
        { categoryId: data.category_id, categoryCode: data.category },
        pool
      );
      updatePayload.category = category.code;
      updatePayload.category_id = category.id;
      updatePayload.account_id = await resolveGlAccountIdForCategory(category, pool);
    }

    // Whitelist of allowed column names to prevent SQL injection
    const ALLOWED_UPDATE_FIELDS = new Set([
      'title', 'description', 'amount', 'expense_date', 'category', 'category_id',
      'account_id', 'supplier_id', 'vendor', 'employee_id', 'payment_method', 'receipt_number',
      'reference_number', 'notes', 'tags', 'status', 'approved_by',
      'approved_at', 'rejected_by', 'rejected_at', 'rejection_reason',
      'paid_by', 'paid_at', 'payment_status', 'payment_account_id'
    ]);

    const fields = [];
    const values = [];
    let paramIndex = 1;

    // Build dynamic update query with whitelisted fields only
    for (const [key, value] of Object.entries(updatePayload)) {
      if (value !== undefined && ALLOWED_UPDATE_FIELDS.has(key)) {
        fields.push(`${key} = $${paramIndex}`);
        values.push(value);
        paramIndex++;
      }
    }

    if (fields.length === 0) {
      throw new Error('No fields to update');
    }

    fields.push(`updated_at = NOW()`);

    const query = `
      UPDATE expenses 
      SET ${fields.join(', ')}
      WHERE id = $${paramIndex}
      RETURNING *
    `;

    values.push(id);

    const result = await pool.query(query, values);
    if (result.rows.length === 0) return null;
    return (await getExpenseById(id, pool)) ?? normalizeExpenseFromDb(result.rows[0]);
  } catch (error) {
    logger.error('Error in expenseRepository updateExpense', { error, id, data });
    throw error;
  }
};

/**
 * Mark a posted expense reversed. Dedicated path — generic update blocks PAID.
 */
export const markExpenseReversed = async (
  id: string,
  data: { reversedBy: string; reversalReason: string },
  dbPool?: pg.Pool | pg.PoolClient
): Promise<Expense | null> => {
  const pool = dbPool || globalPool;
  const locked = await pool.query(
    `SELECT status FROM expenses WHERE id = $1 FOR UPDATE`,
    [id]
  );
  if (!locked.rows[0]) return null;
  const status = locked.rows[0].status as string;
  if (status === 'REVERSED') {
    throw new ConflictError('Expense has already been reversed');
  }
  if (status !== 'APPROVED' && status !== 'PAID') {
    throw new ConflictError(`Cannot reverse expense in status ${status}`);
  }

  const result = await pool.query(
    `UPDATE expenses
     SET status = 'REVERSED',
         payment_status = 'UNPAID',
         payment_account_id = NULL,
         reversed_by = $2,
         reversed_at = NOW(),
         reversal_reason = $3,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [id, data.reversedBy, data.reversalReason]
  );
  if (result.rows.length === 0) return null;
  return (await getExpenseById(id, pool)) ?? normalizeExpenseFromDb(result.rows[0]);
};

/**
 * Delete expense (soft delete by updating status)
 */
export const deleteExpense = async (id: string, dbPool?: pg.Pool | pg.PoolClient): Promise<boolean> => {
  const pool = dbPool || globalPool;
  try {
    // Protection: block deletion of finalized expenses (replaces trg_protect_paid_expense)
    const current = await pool.query('SELECT status FROM expenses WHERE id = $1', [id]);
    if (!current.rows[0]) return false;
    const currentStatus = current.rows[0].status;
    if (currentStatus === 'PAID') {
      throw new ConflictError('Cannot delete a paid expense');
    }
    if (currentStatus === 'REVERSED') {
      throw new ConflictError('Cannot delete a reversed expense');
    }
    if (currentStatus === 'APPROVED') {
      throw new ConflictError('Cannot delete an approved expense');
    }

    const query = `
      UPDATE expenses 
      SET status = 'CANCELLED', updated_at = NOW()
      WHERE id = $1
    `;

    const result = await pool.query(query, [id]);
    return (result.rowCount ?? 0) > 0;
  } catch (error) {
    logger.error('Error in expenseRepository deleteExpense', { error, id });
    throw error;
  }
};

/**
 * Generate expense number in service layer (replaces generate_expense_number() DB function)
 * Pattern: EXP-YYYYMM-0001
 */
export const generateExpenseNumber = async (dbPool?: pg.Pool | pg.PoolClient): Promise<string> => {
  const pool = dbPool || globalPool;
  try {
    // Use business date (Africa/Kampala) to avoid wrong month near midnight UTC
    const bizDate = getBusinessDate();
    const yearPart = bizDate.slice(0, 4);
    const monthPart = bizDate.slice(5, 7);
    const prefix = `EXP-${yearPart}${monthPart}-`;

    const result = await pool.query(
      `SELECT COALESCE(MAX(CAST(SUBSTRING(expense_number FROM 10) AS INTEGER)), 0) + 1 AS next_num
       FROM expenses WHERE expense_number LIKE $1`,
      [`${prefix}%`]
    );
    const seq = result.rows[0].next_num;
    return `${prefix}${String(seq).padStart(4, '0')}`;
  } catch (error) {
    logger.error('Error in expenseRepository generateExpenseNumber', { error });
    throw error;
  }
};

/**
 * Get payment accounts (cash/bank/MoMo/petty) for expense payment source.
 * Available balance = net-active ledger SSOT (same as Banking / funds guard).
 * Never use accounts.CurrentBalance — bare POSTED / cache drift after reverse.
 */
export const getPaymentAccounts = async (dbPool?: pg.Pool | pg.PoolClient) => {
  const pool = dbPool || globalPool;
  try {
    const { postedLedgerBalanceLateralForList, availableFromPostedTotals } = await import(
      '../modules/treasury/postedLedgerBalance.js'
    );
    // Only cash-out liquidity accounts that allow EXPENSE_PAYMENT (Rule B).
    // Exclude undeposited (1015) and card clearing (1020) — customer receipt lanes, not expense pay-from.
    const query = `
      SELECT 
        a."Id" as id,
        a."AccountCode" as account_code,
        a."AccountName" as account_name,
        a."AccountType" as account_type,
        COALESCE(a."SystemAccountTag", '') as system_account_tag,
        a."NormalBalance" as normal_balance,
        COALESCE(bal.debit_total, 0)::text as debit_total,
        COALESCE(bal.credit_total, 0)::text as credit_total
      FROM accounts a
      ${postedLedgerBalanceLateralForList()}
      WHERE a."AccountType" = 'ASSET' 
        AND a."IsActive" = true
        AND a."IsPostingAccount" = true
        AND (
          a."SystemAccountTag" IN ('CASH', 'BANK', 'MOBILE_MONEY', 'PETTY_CASH')
          OR a."AccountCode" IN ('1010', '1012', '1030', '1040')
        )
        AND 'EXPENSE_PAYMENT' = ANY(COALESCE(a."AllowedSources", ARRAY[]::text[]))
      ORDER BY a."AccountCode"
    `;

    const result = await pool.query(query);
    return result.rows.map((row) => {
      const balance = availableFromPostedTotals(
        Number(row.debit_total || 0),
        Number(row.credit_total || 0),
        row.normal_balance || 'DEBIT',
      );
      return {
        id: row.id,
        account_code: row.account_code,
        code: row.account_code,
        account_name: row.account_name,
        name: row.account_name,
        account_type: row.account_type,
        type: row.account_type,
        systemAccountTag: row.system_account_tag || null,
        currentBalance: balance,
        /** True when the account has a positive funded balance */
        hasFunds: balance > 0.0001,
      };
    });
  } catch (error) {
    logger.error('Error in expenseRepository getPaymentAccounts', { error });
    throw error;
  }
};

/**
 * Get expense categories
 * @param includeInactive - when true, also returns inactive categories (admin use)
 */
export const getExpenseCategories = async (dbPool?: pg.Pool | pg.PoolClient, includeInactive = false) => {
  const pool = dbPool || globalPool;
  try {
    const query = `
      SELECT ec.id, ec.name, ec.description, ec.code, ec.is_active, ec.created_at, ec.updated_at,
             COALESCE(cnt.expense_count, 0)::int AS expense_count
      FROM expense_categories ec
      LEFT JOIN (
        SELECT category_id, COUNT(*) AS expense_count
        FROM expenses
        WHERE status != 'CANCELLED'
        GROUP BY category_id
      ) cnt ON cnt.category_id = ec.id
      WHERE ($1::boolean = true OR ec.is_active = true)
      ORDER BY ec.is_active DESC, ec.name
    `;

    const result = await pool.query(query, [includeInactive]);
    return result.rows.map(row => ({
      id: row.id,
      name: row.name,
      code: row.code,
      description: row.description,
      isActive: row.is_active,
      expenseCount: row.expense_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  } catch (error) {
    logger.error('Error in expenseRepository getExpenseCategories', { error });
    throw error;
  }
};

/**
 * Get expense category by code
 */
export const getExpenseCategoryByCode = async (code: string, dbPool?: pg.Pool | pg.PoolClient) => {
  const pool = dbPool || globalPool;
  try {
    const query = `
      SELECT id, name, description, code, is_active, created_at, updated_at
      FROM expense_categories
      WHERE code = $1
    `;

    const result = await pool.query(query, [code]);
    return result.rows.length > 0 ? result.rows[0] : null;
  } catch (error) {
    logger.error('Error in expenseRepository getExpenseCategoryByCode', { error, code });
    throw error;
  }
};

/**
 * Create expense category
 */
export const createExpenseCategory = async (data: { name: string; code: string; description?: string }, dbPool?: pg.Pool | pg.PoolClient) => {
  const pool = dbPool || globalPool;
  try {
    const code = normalizeExpenseCategoryCode(data.code);
    const glCode = mapExpenseCategoryCodeToGl(code);
    const accountResult = await pool.query(
      `SELECT "Id" FROM accounts WHERE "AccountCode" = $1 LIMIT 1`,
      [glCode]
    );
    const accountId = accountResult.rows[0]?.Id ?? null;

    const query = `
      INSERT INTO expense_categories (name, code, description, account_id)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `;

    const result = await pool.query(query, [data.name, code, data.description || null, accountId]);
    return result.rows[0];
  } catch (error) {
    logger.error('Error in expenseRepository createExpenseCategory', { error, data });
    throw error;
  }
};

/**
 * Create approval record
 */
export const createApprovalRecord = async (expenseId: string, approverId: string, dbPool?: pg.Pool | pg.PoolClient) => {
  const pool = dbPool || globalPool;
  try {
    const query = `
      INSERT INTO expense_approvals (expense_id, approver_id, status)
      VALUES ($1, $2, 'PENDING')
      RETURNING *
    `;

    const result = await pool.query(query, [expenseId, approverId]);
    return result.rows[0];
  } catch (error) {
    logger.error('Error in expenseRepository createApprovalRecord', { error, expenseId, approverId });
    throw error;
  }
};

/**
 * Update approval record - Updates the pending approval for an expense
 * Sets the actual approver who made the decision
 */
export const updateApprovalRecord = async (
  expenseId: string,
  approverId: string,
  status: string,
  comments?: string,
  dbPool?: pg.Pool | pg.PoolClient
) => {
  const pool = dbPool || globalPool;
  try {
    // First try to update an existing record for this expense
    // Update approver_id to the actual person who approved/rejected
    const query = `
      UPDATE expense_approvals 
      SET status = $2, approver_id = $3, decision_date = NOW(), comments = $4, updated_at = NOW()
      WHERE expense_id = $1 AND status = 'PENDING'
      RETURNING *
    `;

    let result = await pool.query(query, [expenseId, status, approverId, comments || null]);

    // If no pending record exists, create one
    if (result.rows.length === 0) {
      const insertQuery = `
        INSERT INTO expense_approvals (expense_id, approver_id, status, decision_date, comments)
        VALUES ($1, $2, $3, NOW(), $4)
        RETURNING *
      `;
      result = await pool.query(insertQuery, [expenseId, approverId, status, comments || null]);
    }

    return result.rows[0];
  } catch (error) {
    logger.error('Error in expenseRepository updateApprovalRecord', { error, expenseId, approverId, status, comments });
    throw error;
  }
};

/**
 * Get expense documents
 */
export const getExpenseDocuments = async (expenseId: string, dbPool?: pg.Pool | pg.PoolClient) => {
  const pool = dbPool || globalPool;
  try {
    const query = `
      SELECT 
        id, expense_id, filename, original_name, file_path, file_size,
        mime_type, document_type, description, uploaded_by, created_at
      FROM expense_documents
      WHERE expense_id = $1
      ORDER BY created_at DESC
    `;

    const result = await pool.query(query, [expenseId]);
    return result.rows;
  } catch (error) {
    logger.error('Error in expenseRepository getExpenseDocuments', { error, expenseId });
    throw error;
  }
};

/**
 * Get expense document by ID
 */
export const getExpenseDocumentById = async (documentId: string, dbPool?: pg.Pool | pg.PoolClient) => {
  const pool = dbPool || globalPool;
  try {
    const query = `
      SELECT 
        id, expense_id, filename, original_name, file_path, file_size,
        mime_type, document_type, description, uploaded_by, created_at
      FROM expense_documents
      WHERE id = $1
    `;

    const result = await pool.query(query, [documentId]);
    return result.rows.length > 0 ? result.rows[0] : null;
  } catch (error) {
    logger.error('Error in expenseRepository getExpenseDocumentById', { error, documentId });
    throw error;
  }
};

/**
 * Delete expense document
 */
export const deleteExpenseDocument = async (documentId: string, dbPool?: pg.Pool | pg.PoolClient): Promise<boolean> => {
  const pool = dbPool || globalPool;
  try {
    const query = `DELETE FROM expense_documents WHERE id = $1`;
    const result = await pool.query(query, [documentId]);
    return (result.rowCount ?? 0) > 0;
  } catch (error) {
    logger.error('Error in expenseRepository deleteExpenseDocument', { error, documentId });
    throw error;
  }
};

/**
 * Expense summary — business KPIs (excludes CANCELLED).
 * Recognized = APPROVED + PAID (GL posts on approval).
 * Unpaid AP = APPROVED not yet paid. Cash out = PAID only.
 * Live totals exclude REVERSED so voucher money matches net-active GL after reverse.
 */
export const getExpenseSummary = async (filters: { startDate?: string; endDate?: string; categoryId?: string }, dbPool?: pg.Pool | pg.PoolClient) => {
  const pool = dbPool || globalPool;
  try {
    let query = `
      SELECT 
        COUNT(*) FILTER (WHERE ${EXPENSE_NOT_VOID_SQL})::integer as voucher_count,
        COALESCE(SUM(amount) FILTER (WHERE ${EXPENSE_NOT_VOID_SQL}), 0)::numeric(12,2) as total_amount,
        COUNT(*) FILTER (WHERE status = 'DRAFT')::integer as draft_count,
        COALESCE(SUM(amount) FILTER (WHERE status = 'DRAFT'), 0)::numeric(12,2) as draft_amount,
        COUNT(*) FILTER (WHERE status = 'PENDING_APPROVAL')::integer as pending_count,
        COALESCE(SUM(amount) FILTER (WHERE status = 'PENDING_APPROVAL'), 0)::numeric(12,2) as pending_amount,
        COUNT(*) FILTER (WHERE status = 'APPROVED')::integer as unpaid_ap_count,
        COALESCE(SUM(amount) FILTER (WHERE status = 'APPROVED'), 0)::numeric(12,2) as unpaid_ap_amount,
        COUNT(*) FILTER (WHERE ${EXPENSE_RECOGNIZED_SQL})::integer as recognized_count,
        COALESCE(SUM(amount) FILTER (WHERE ${EXPENSE_RECOGNIZED_SQL}), 0)::numeric(12,2) as recognized_amount,
        COUNT(*) FILTER (WHERE status = 'PAID')::integer as paid_count,
        COALESCE(SUM(amount) FILTER (WHERE status = 'PAID'), 0)::numeric(12,2) as paid_amount,
        COUNT(*) FILTER (WHERE status = 'REJECTED')::integer as rejected_count,
        COALESCE(SUM(amount) FILTER (WHERE status = 'REJECTED'), 0)::numeric(12,2) as rejected_amount,
        COUNT(*) FILTER (WHERE status = 'REVERSED')::integer as reversed_count,
        COALESCE(SUM(amount) FILTER (WHERE status = 'REVERSED'), 0)::numeric(12,2) as reversed_amount
      FROM expenses e
      WHERE e.status != 'CANCELLED'
    `;

    const queryParams: unknown[] = [];
    let paramIndex = 1;

    if (filters.startDate) {
      query += ` AND e.expense_date >= $${paramIndex}`;
      queryParams.push(filters.startDate);
      paramIndex++;
    }

    if (filters.endDate) {
      query += ` AND e.expense_date <= $${paramIndex}`;
      queryParams.push(filters.endDate);
      paramIndex++;
    }

    if (filters.categoryId) {
      query += ` AND e.category_id = $${paramIndex}`;
      queryParams.push(filters.categoryId);
    }

    const result = await pool.query(query, queryParams);
    const row = result.rows[0] || {};
    return {
      voucherCount: parseInt(row.voucher_count || '0', 10),
      totalAmount: parseFloat(row.total_amount || '0'),
      draftCount: parseInt(row.draft_count || '0', 10),
      draftAmount: parseFloat(row.draft_amount || '0'),
      pendingCount: parseInt(row.pending_count || '0', 10),
      pendingAmount: parseFloat(row.pending_amount || '0'),
      unpaidApCount: parseInt(row.unpaid_ap_count || '0', 10),
      unpaidApAmount: parseFloat(row.unpaid_ap_amount || '0'),
      recognizedCount: parseInt(row.recognized_count || '0', 10),
      recognizedAmount: parseFloat(row.recognized_amount || '0'),
      paidCount: parseInt(row.paid_count || '0', 10),
      paidAmount: parseFloat(row.paid_amount || '0'),
      rejectedCount: parseInt(row.rejected_count || '0', 10),
      rejectedAmount: parseFloat(row.rejected_amount || '0'),
      reversedCount: parseInt(row.reversed_count || '0', 10),
      reversedAmount: parseFloat(row.reversed_amount || '0'),
    };
  } catch (error) {
    logger.error('Error in expenseRepository getExpenseSummary', { error, filters });
    throw error;
  }
};

/**
 * Expense report by category — P&L-aligned (excludes CANCELLED).
 * One category column (name + code), recognized vs paid amounts.
 */
export const getExpensesByCategory = async (filters: { startDate?: string; endDate?: string }, dbPool?: pg.Pool | pg.PoolClient) => {
  const pool = dbPool || globalPool;
  try {
    const query = `
      SELECT 
        c.name as category_name,
        c.code as category_code,
        COALESCE(a."AccountCode", '') as gl_account_code,
        COUNT(e.id)::integer as expense_count,
        COALESCE(SUM(e.amount), 0)::numeric(12,2) as total_amount,
        COALESCE(SUM(e.amount) FILTER (WHERE ${EXPENSE_RECOGNIZED_SQL}), 0)::numeric(12,2) as recognized_amount,
        COALESCE(SUM(e.amount) FILTER (WHERE e.status = 'APPROVED'), 0)::numeric(12,2) as unpaid_ap_amount,
        COALESCE(SUM(e.amount) FILTER (WHERE e.status = 'PAID'), 0)::numeric(12,2) as paid_amount,
        COUNT(*) FILTER (WHERE e.status = 'PENDING_APPROVAL')::integer as pending_count
      FROM expense_categories c
      LEFT JOIN accounts a ON c.account_id = a."Id"
      LEFT JOIN expenses e ON c.id = e.category_id
        AND ${EXPENSE_NOT_VOID_SQL}
        AND ($1::date IS NULL OR e.expense_date >= $1)
        AND ($2::date IS NULL OR e.expense_date <= $2)
      WHERE c.is_active = true OR EXISTS (
        SELECT 1 FROM expenses ex WHERE ex.category_id = c.id AND ${expenseNotVoidSql('ex')}
      )
      GROUP BY c.id, c.name, c.code, a."AccountCode"
      HAVING COUNT(e.id) > 0
      ORDER BY recognized_amount DESC, total_amount DESC
    `;

    const result = await pool.query(query, [filters.startDate || null, filters.endDate || null]);

    return result.rows.map(row => {
      const name = row.category_name || 'Uncategorized';
      const code = row.category_code || '';
      const gl = row.gl_account_code || '';
      return {
        category: code ? `${name} (${code})` : name,
        glAccount: gl || '—',
        expenseCount: parseInt(row.expense_count, 10),
        totalAmount: parseFloat(row.total_amount || '0'),
        recognizedAmount: parseFloat(row.recognized_amount || '0'),
        unpaidApAmount: parseFloat(row.unpaid_ap_amount || '0'),
        paidAmount: parseFloat(row.paid_amount || '0'),
        pendingCount: parseInt(row.pending_count || '0', 10),
      };
    });
  } catch (error) {
    logger.error('Error in expenseRepository getExpensesByCategory', { error, filters });
    throw error;
  }
};

/**
 * Expense report by vendor (excludes CANCELLED)
 */
export const getExpensesByVendor = async (filters: { startDate?: string; endDate?: string }, dbPool?: pg.Pool | pg.PoolClient) => {
  const pool = dbPool || globalPool;
  try {
    const query = `
      SELECT 
        COALESCE(NULLIF(TRIM(e.vendor), ''), 'Unknown') as vendor_name,
        COUNT(e.id)::integer as expense_count,
        COALESCE(SUM(e.amount), 0)::numeric(12,2) as total_amount,
        COALESCE(SUM(e.amount) FILTER (WHERE ${EXPENSE_RECOGNIZED_SQL}), 0)::numeric(12,2) as recognized_amount,
        COALESCE(SUM(e.amount) FILTER (WHERE e.status = 'PAID'), 0)::numeric(12,2) as paid_amount,
        MIN(e.expense_date)::date as first_expense_date,
        MAX(e.expense_date)::date as last_expense_date
      FROM expenses e
      WHERE ${EXPENSE_NOT_VOID_SQL}
        AND ($1::date IS NULL OR e.expense_date >= $1)
        AND ($2::date IS NULL OR e.expense_date <= $2)
      GROUP BY COALESCE(NULLIF(TRIM(e.vendor), ''), 'Unknown')
      ORDER BY recognized_amount DESC, total_amount DESC
    `;

    const result = await pool.query(query, [filters.startDate || null, filters.endDate || null]);

    return result.rows.map(row => ({
      vendor: row.vendor_name,
      expenseCount: parseInt(row.expense_count, 10),
      totalAmount: parseFloat(row.total_amount || '0'),
      recognizedAmount: parseFloat(row.recognized_amount || '0'),
      paidAmount: parseFloat(row.paid_amount || '0'),
      firstExpenseDate: row.first_expense_date,
      lastExpenseDate: row.last_expense_date,
    }));
  } catch (error) {
    logger.error('Error in expenseRepository getExpensesByVendor', { error, filters });
    throw error;
  }
};

/**
 * Monthly expense trends (excludes CANCELLED)
 */
export const getExpenseTrends = async (filters: { startDate?: string; endDate?: string }, dbPool?: pg.Pool | pg.PoolClient) => {
  const pool = dbPool || globalPool;
  try {
    const query = `
      SELECT 
        TO_CHAR(DATE_TRUNC('month', e.expense_date), 'YYYY-MM') as period,
        COUNT(e.id)::integer as expense_count,
        COALESCE(SUM(e.amount), 0)::numeric(12,2) as total_amount,
        COALESCE(SUM(e.amount) FILTER (WHERE ${EXPENSE_RECOGNIZED_SQL}), 0)::numeric(12,2) as recognized_amount,
        COALESCE(SUM(e.amount) FILTER (WHERE e.status = 'PAID'), 0)::numeric(12,2) as paid_amount,
        COUNT(DISTINCT e.category_id)::integer as category_count
      FROM expenses e
      WHERE ${EXPENSE_NOT_VOID_SQL}
        AND ($1::date IS NULL OR e.expense_date >= $1)
        AND ($2::date IS NULL OR e.expense_date <= $2)
      GROUP BY DATE_TRUNC('month', e.expense_date)
      ORDER BY DATE_TRUNC('month', e.expense_date) DESC
    `;

    const result = await pool.query(query, [filters.startDate || null, filters.endDate || null]);

    return result.rows.map(row => ({
      period: row.period,
      expenseCount: parseInt(row.expense_count, 10),
      totalAmount: parseFloat(row.total_amount || '0'),
      recognizedAmount: parseFloat(row.recognized_amount || '0'),
      paidAmount: parseFloat(row.paid_amount || '0'),
      categoryCount: parseInt(row.category_count, 10),
    }));
  } catch (error) {
    logger.error('Error in expenseRepository getExpenseTrends', { error, filters });
    throw error;
  }
};

/**
 * By payment method — intended pay method on voucher (excludes CANCELLED)
 */
export const getExpensesByPaymentMethod = async (filters: { startDate?: string; endDate?: string }, dbPool?: pg.Pool | pg.PoolClient) => {
  const pool = dbPool || globalPool;
  try {
    const query = `
      SELECT 
        COALESCE(e.payment_method, 'UNKNOWN') as payment_method,
        COUNT(e.id)::integer as expense_count,
        COALESCE(SUM(e.amount), 0)::numeric(12,2) as total_amount,
        COALESCE(SUM(e.amount) FILTER (WHERE ${EXPENSE_RECOGNIZED_SQL}), 0)::numeric(12,2) as recognized_amount,
        COALESCE(SUM(e.amount) FILTER (WHERE e.status = 'PAID'), 0)::numeric(12,2) as paid_amount
      FROM expenses e
      WHERE ${EXPENSE_NOT_VOID_SQL}
        AND ($1::date IS NULL OR e.expense_date >= $1)
        AND ($2::date IS NULL OR e.expense_date <= $2)
      GROUP BY e.payment_method
      ORDER BY paid_amount DESC, total_amount DESC
    `;

    const result = await pool.query(query, [filters.startDate || null, filters.endDate || null]);

    return result.rows.map(row => ({
      paymentMethod: row.payment_method,
      expenseCount: parseInt(row.expense_count, 10),
      totalAmount: parseFloat(row.total_amount || '0'),
      recognizedAmount: parseFloat(row.recognized_amount || '0'),
      paidAmount: parseFloat(row.paid_amount || '0'),
    }));
  } catch (error) {
    logger.error('Error in expenseRepository getExpensesByPaymentMethod', { error, filters });
    throw error;
  }
};

/**
 * Convert database row to Expense object (following camelCase convention)
 */
const normalizeExpenseFromDb = (row: ExpenseDbRow): Expense => {
  return {
    id: row.id,
    expenseNumber: row.expense_number,
    title: row.title,
    description: row.description,
    amount: parseFloat(row.amount || '0'),
    expenseDate: row.expense_date,
    category: row.category,
    categoryId: row.category_id,
    categoryName: row.category_name,
    categoryCode: row.category_code,
    supplierId: row.supplier_id,
    supplierName: row.supplier_name,
    vendor: row.vendor,
    employeeId: row.employee_id ?? null,
    employeeName: row.employee_name ?? null,
    paymentMethod: row.payment_method as Expense['paymentMethod'],
    receiptNumber: row.receipt_number,
    referenceNumber: row.reference_number,
    status: row.status as Expense['status'],
    notes: row.notes,
    tags: row.tags || [],
    createdBy: row.created_by,
    approvedBy: row.approved_by,
    rejectedBy: row.rejected_by,
    paidBy: row.paid_by,
    rejectionReason: row.rejection_reason,
    reversedBy: row.reversed_by,
    reversedAt: row.reversed_at,
    reversalReason: row.reversal_reason,
    createdByName: row.created_by_name,
    approvedByName: row.approved_by_name,
    rejectedByName: row.rejected_by_name,
    paidByName: row.paid_by_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    approvedAt: row.approved_at,
    rejectedAt: row.rejected_at,
    paidAt: row.paid_at,
    reversedAt: row.reversed_at
  };
};

/**
 * Update expense category
 */
export const updateExpenseCategory = async (id: string, updateData: Record<string, unknown>, dbPool?: pg.Pool | pg.PoolClient) => {
  const pool = dbPool || globalPool;

  // Build dynamic SET clause to support partial updates including isActive toggle
  const setClauses: string[] = ['updated_at = NOW()'];
  const params: unknown[] = [id];
  let idx = 2;

  if (updateData.name !== undefined) { setClauses.push(`name = $${idx++}`); params.push(updateData.name); }
  if (updateData.code !== undefined) {
    const code = normalizeExpenseCategoryCode(updateData.code as string);
    setClauses.push(`code = $${idx++}`);
    params.push(code);
    // Keep GL link accurate when code changes
    const glCode = mapExpenseCategoryCodeToGl(code);
    const acct = await pool.query(`SELECT "Id" FROM accounts WHERE "AccountCode" = $1 LIMIT 1`, [glCode]);
    if (acct.rows[0]?.Id) {
      setClauses.push(`account_id = $${idx++}`);
      params.push(acct.rows[0].Id);
    }
  }
  if (updateData.description !== undefined) { setClauses.push(`description = $${idx++}`); params.push((updateData.description as string) || null); }
  if (updateData.isActive !== undefined) { setClauses.push(`is_active = $${idx++}`); params.push(updateData.isActive); }
  if (updateData.accountId !== undefined || updateData.account_id !== undefined) {
    setClauses.push(`account_id = $${idx++}`);
    params.push(updateData.accountId ?? updateData.account_id);
  }

  const query = `UPDATE expense_categories SET ${setClauses.join(', ')} WHERE id = $1 RETURNING *`;

  try {
    const result = await pool.query(query, params);
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
      id: row.id,
      name: row.name,
      code: row.code,
      description: row.description,
      isActive: row.is_active,
      expenseCount: 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  } catch (error) {
    logger.error('Update expense category repository error', { id, updateData, error });
    throw error;
  }
};

/**
 * Delete expense category (soft delete)
 */
export const deleteExpenseCategory = async (id: string, dbPool?: pg.Pool | pg.PoolClient) => {
  const pool = dbPool || globalPool;
  const query = 'UPDATE expense_categories SET is_active = false, updated_at = NOW() WHERE id = $1 AND is_active = true';

  try {
    const result = await pool.query(query, [id]);
    return (result.rowCount || 0) > 0;
  } catch (error) {
    logger.error('Delete expense category repository error', { id, error });
    throw error;
  }
};

/**
 * Get expense count by category
 */
export const getExpenseCountByCategory = async (categoryId: string, dbPool?: pg.Pool | pg.PoolClient) => {
  const pool = dbPool || globalPool;
  const query = 'SELECT COUNT(*) as count FROM expenses WHERE category_id = $1';

  try {
    const result = await pool.query(query, [categoryId]);
    return parseInt(result.rows[0].count) || 0;
  } catch (error) {
    logger.error('Get expense count by category repository error', { categoryId, error });
    throw error;
  }
};

/**
 * Active HR employees for expense audit picker (expenses.create/read — no hr.read required).
 */
export const listStaffOptionsForExpense = async (
  dbPool?: pg.Pool | pg.PoolClient
): Promise<Array<{ id: string; firstName: string; lastName: string; fullName: string }>> => {
  const pool = dbPool || globalPool;
  const result = await pool.query(
    `SELECT e."Id" AS id,
            e."FirstName" AS first_name,
            e."LastName" AS last_name
     FROM employees e
     WHERE e."Status" = 'ACTIVE'
     ORDER BY e."LastName" ASC, e."FirstName" ASC
     LIMIT 500`
  );
  return result.rows.map((row: { id: string; first_name: string; last_name: string }) => {
    const firstName = row.first_name || '';
    const lastName = row.last_name || '';
    return {
      id: row.id,
      firstName,
      lastName,
      fullName: `${firstName} ${lastName}`.trim(),
    };
  });
};

/**
 * Ensure employee_id points at an active HR employee (audit link).
 */
export const assertActiveEmployeeForExpense = async (
  employeeId: string,
  dbPool?: pg.Pool | pg.PoolClient
): Promise<void> => {
  const pool = dbPool || globalPool;
  const result = await pool.query(
    `SELECT "Id", "Status" FROM employees WHERE "Id" = $1`,
    [employeeId]
  );
  if (!result.rows[0]) {
    throw new ValidationError('Employee not found for expense link');
  }
  if (result.rows[0].Status !== 'ACTIVE') {
    throw new ValidationError('Cannot link expense to an inactive employee');
  }
};

/**
 * Enterprise Detailed Expense List with approval, GL account, and payment tracking
 */
export const getExpenseDetailedList = async (
  filters: { startDate?: string; endDate?: string; status?: string; categoryId?: string },
  dbPool?: pg.Pool | pg.PoolClient
) => {
  const pool = dbPool || globalPool;
  try {
    const params: unknown[] = [];
    const conditions: string[] = [];

    if (filters.startDate) {
      params.push(filters.startDate);
      conditions.push(`e.expense_date >= $${params.length}::date`);
    }
    if (filters.endDate) {
      params.push(filters.endDate);
      conditions.push(`e.expense_date <= $${params.length}::date`);
    }
    if (filters.status) {
      params.push(filters.status);
      conditions.push(`e.status = $${params.length}`);
    }
    if (filters.categoryId) {
      params.push(filters.categoryId);
      conditions.push(`e.category_id = $${params.length}::uuid`);
    }

    const whereClause = conditions.length > 0
      ? `WHERE ${conditions.join(' AND ')} AND e.status != 'CANCELLED'`
      : `WHERE e.status != 'CANCELLED'`;

    // If caller explicitly filters status (including CANCELLED), honor it without the default exclude
    const whereFinal = filters.status
      ? (conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '')
      : whereClause;

    const query = `
      SELECT 
        e.expense_number,
        e.title,
        e.amount::numeric(10,2) as amount,
        e.expense_date::date as expense_date,
        COALESCE(c.name, 'Uncategorized') as category_name,
        COALESCE(c.code, '') as category_code,
        COALESCE(a."AccountCode", '') as gl_account_code,
        COALESCE(a."AccountName", '') as gl_account_name,
        e.status,
        e.payment_status,
        e.payment_method,
        COALESCE(NULLIF(TRIM(e.vendor), ''), 'N/A') as vendor,
        NULLIF(TRIM(CONCAT(COALESCE(emp."FirstName", ''), ' ', COALESCE(emp."LastName", ''))), '') AS employee_name,
        e.receipt_number,
        e.reference_number,
        COALESCE(uc.full_name, 'System') as created_by,
        COALESCE(ua.full_name, '') as approved_by,
        e.approved_at,
        COALESCE(ur.full_name, '') as rejected_by,
        e.rejected_at,
        e.rejection_reason,
        COALESCE(up.full_name, '') as paid_by,
        e.paid_at,
        CASE
          WHEN e.status = 'PENDING_APPROVAL' THEN
            EXTRACT(DAY FROM NOW() - e.created_at)::integer
          ELSE NULL
        END as days_pending,
        e.notes,
        e.created_at
      FROM expenses e
      LEFT JOIN expense_categories c ON e.category_id = c.id
      LEFT JOIN accounts a ON e.account_id = a."Id"
      LEFT JOIN users uc ON e.created_by = uc.id
      LEFT JOIN users ua ON e.approved_by = ua.id
      LEFT JOIN users ur ON e.rejected_by = ur.id
      LEFT JOIN users up ON e.paid_by = up.id
      LEFT JOIN employees emp ON e.employee_id = emp."Id"
      ${whereFinal}
      ORDER BY e.expense_date DESC, e.created_at DESC
    `;

    const result = await pool.query(query, params);

    return result.rows.map(row => {
      const categoryName = row.category_name || 'Uncategorized';
      const categoryCode = row.category_code || '';
      const glCode = row.gl_account_code || '';
      const glName = row.gl_account_name || '';
      return {
        expenseNumber: row.expense_number,
        title: row.title,
        amount: parseFloat(row.amount || '0'),
        expenseDate: row.expense_date,
        // Merged — avoid Category Name + Category Code twin columns
        category: categoryCode ? `${categoryName} (${categoryCode})` : categoryName,
        // Merged — avoid GL Code + GL Name twin columns
        glAccount: glCode && glName ? `${glCode} - ${glName}` : glCode || glName || '',
        status: row.status,
        paymentStatus: row.payment_status,
        paymentMethod: row.payment_method || 'N/A',
        vendor: row.vendor,
        employeeName: row.employee_name || '',
        receiptNumber: row.receipt_number || '',
        referenceNumber: row.reference_number || '',
        createdBy: row.created_by,
        approvedBy: row.approved_by || '',
        approvedAt: row.approved_at ? formatDateBusiness(new Date(row.approved_at)) : '',
        rejectedBy: row.rejected_by || '',
        rejectedAt: row.rejected_at ? formatDateBusiness(new Date(row.rejected_at)) : '',
        rejectionReason: row.rejection_reason || '',
        paidBy: row.paid_by || '',
        paidAt: row.paid_at ? formatDateBusiness(new Date(row.paid_at)) : '',
        daysPending: row.days_pending,
        notes: row.notes || '',
      };
    });
  } catch (error) {
    logger.error('Error in expenseRepository getExpenseDetailedList', { error, filters });
    throw error;
  }
};

/** @deprecated Alias — use getExpenseDetailedList */
export const getExpensesForExport = getExpenseDetailedList;

/**
 * Enterprise Approval Pipeline — expenses grouped by approval status with workflow metrics
 */
export const getExpenseApprovalPipeline = async (
  filters: { startDate?: string; endDate?: string },
  dbPool?: pg.Pool | pg.PoolClient
) => {
  const pool = dbPool || globalPool;
  try {
    const query = `
      SELECT 
        e.status,
        COUNT(e.id)::integer as expense_count,
        COALESCE(SUM(e.amount), 0)::numeric(10,2) as total_amount,
        COALESCE(AVG(e.amount), 0)::numeric(10,2) as average_amount,
        COALESCE(MIN(e.amount), 0)::numeric(10,2) as min_amount,
        COALESCE(MAX(e.amount), 0)::numeric(10,2) as max_amount,
        CASE 
          WHEN e.status = 'PENDING_APPROVAL' THEN
            COALESCE(AVG(EXTRACT(DAY FROM NOW() - e.created_at)), 0)::numeric(10,1)
          WHEN e.status IN ('APPROVED', 'PAID') THEN
            COALESCE(AVG(EXTRACT(DAY FROM e.approved_at - e.created_at)), 0)::numeric(10,1)
          ELSE NULL
        END as avg_days_in_status
      FROM expenses e
      WHERE ($1::date IS NULL OR e.expense_date >= $1)
        AND ($2::date IS NULL OR e.expense_date <= $2)
      GROUP BY e.status
      ORDER BY 
        CASE e.status
          WHEN 'DRAFT' THEN 1
          WHEN 'PENDING_APPROVAL' THEN 2
          WHEN 'APPROVED' THEN 3
          WHEN 'REJECTED' THEN 4
          WHEN 'PAID' THEN 5
          WHEN 'CANCELLED' THEN 6
          WHEN 'REVERSED' THEN 7
        END
    `;

    const result = await pool.query(query, [filters.startDate || null, filters.endDate || null]);

    return result.rows.map(row => ({
      status: row.status,
      expenseCount: parseInt(row.expense_count, 10),
      totalAmount: parseFloat(row.total_amount || '0'),
      averageAmount: parseFloat(row.average_amount || '0'),
      avgDaysInStatus: row.avg_days_in_status ? parseFloat(row.avg_days_in_status) : null,
    }));
  } catch (error) {
    logger.error('Error in expenseRepository getExpenseApprovalPipeline', { error, filters });
    throw error;
  }
};
