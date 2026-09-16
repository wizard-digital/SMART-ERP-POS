import * as expenseRepository from '../repositories/expenseRepository.js';
import { ExpenseFilters, CreateExpenseData, UpdateExpenseData } from '../types/expense.js';
import logger from '../utils/logger.js';
import { BusinessError, NotFoundError, ValidationError } from '../middleware/errorHandler.js';
import * as glEntryService from './glEntryService.js';
import { BankingService } from './bankingService.js';
import { pool as globalPool } from '../db/pool.js';
import { UnitOfWork } from '../db/unitOfWork.js';
import { Pool, PoolClient } from 'pg';
import { getBusinessDate } from '../utils/dateRange.js';
import { normalizeExpenseCategoryCode } from '../../../shared/expense/categoryGlMap.js';
import { publishNotificationEvent } from '../modules/notifications/notificationPublisher.js';
import {
  buildBusinessNotificationPayload,
  expenseDetailLabel,
} from '../modules/notifications/businessNotificationPayload.js';

/**
 * Get expenses with filtering and pagination
 */
export const getExpenses = async (filters: ExpenseFilters, pool?: Pool) => {
  try {
    const dbPool = pool || globalPool;
    const expenses = await expenseRepository.getExpenses(filters, dbPool);
    const total = await expenseRepository.getExpenseCount(filters, dbPool);

    return {
      data: expenses,
      pagination: {
        page: filters.page,
        limit: filters.limit,
        total,
        totalPages: Math.ceil(total / filters.limit),
      },
    };
  } catch (error) {
    logger.error('Error in expense service getExpenses', { error, filters });
    throw new Error(`Failed to retrieve expenses: ${(error as Error).message}`);
  }
};

/**
 * Get expense by ID
 */
export const getExpenseById = async (id: string, pool?: Pool) => {
  try {
    return await expenseRepository.getExpenseById(id, pool || globalPool);
  } catch (error) {
    logger.error('Error in expense service getExpenseById', { error, id });
    throw new Error(`Failed to retrieve expense: ${(error as Error).message}`);
  }
};

/**
 * Create new expense
 */
export const createExpense = async (data: CreateExpenseData, pool?: Pool) => {
  try {
    const dbPool = pool || globalPool;
    // Generate expense number
    const expenseNumber = await generateExpenseNumber(dbPool);

    if (data.employee_id) {
      await expenseRepository.assertActiveEmployeeForExpense(data.employee_id, dbPool);
    }

    const expenseData = {
      ...data,
      expense_number: expenseNumber,
      status: 'DRAFT' as const,
    };

    // Wrap create + approval in a single transaction
    const expense = await UnitOfWork.run(dbPool, async (client: PoolClient) => {
      const created = await expenseRepository.createExpense(expenseData, client);

      // Create initial approval record if needed
      if (data.submit_for_approval && data.created_by) {
        await expenseRepository.createApprovalRecord(created.id, data.created_by, client);
      }

      return created;
    });

    return expense;
  } catch (error) {
    logger.error('Error in expense service createExpense', { error, data });
    throw error;
  }
};

/**
 * Update expense
 */
export const updateExpense = async (
  id: string,
  data: UpdateExpenseData,
  userId: string,
  pool?: Pool
) => {
  try {
    const dbPool = pool || globalPool;
    // Check if expense exists and is modifiable
    const existingExpense = await expenseRepository.getExpenseById(id, dbPool);
    if (!existingExpense) {
      return null;
    }

    // Business rule: Only draft expenses can be modified by creator
    if (existingExpense.status !== 'DRAFT' && existingExpense.createdBy !== userId) {
      throw new BusinessError('Cannot modify expense in current status', 'ERR_EXPENSE_001', {
        expenseId: id,
        currentStatus: existingExpense.status,
      });
    }

    if (data.employee_id) {
      await expenseRepository.assertActiveEmployeeForExpense(data.employee_id, dbPool);
    }

    // ALLOWANCE must stay linked to an employee (create zod + update parity).
    // Category may change via category_id only — resolve code before checking.
    let nextCategory = String(existingExpense.category ?? '').toUpperCase();
    if (data.category_id) {
      const resolved = await expenseRepository.resolveExpenseCategory(
        { categoryId: data.category_id },
        dbPool
      );
      nextCategory = String(resolved.code || '').toUpperCase();
    } else if (data.category) {
      nextCategory = String(data.category).toUpperCase();
    }
    const nextEmployeeId =
      data.employee_id !== undefined ? data.employee_id : (existingExpense.employeeId ?? null);
    if (nextCategory === 'ALLOWANCE' && !nextEmployeeId) {
      throw new ValidationError(
        'Employee is required for Employee Allowances (audit who received the payout)'
      );
    }

    return await expenseRepository.updateExpense(id, data, dbPool);
  } catch (error) {
    logger.error('Error in expense service updateExpense', { error, id, data, userId });
    throw error;
  }
};

/**
 * Delete expense (soft delete)
 */
export const deleteExpense = async (id: string, userId: string, pool?: Pool) => {
  try {
    const dbPool = pool || globalPool;
    const existingExpense = await expenseRepository.getExpenseById(id, dbPool);
    if (!existingExpense) {
      return false;
    }

    // Business rule: Only draft expenses can be deleted by creator
    if (existingExpense.status !== 'DRAFT' && existingExpense.createdBy !== userId) {
      throw new BusinessError('Cannot delete expense in current status', 'ERR_EXPENSE_002', {
        expenseId: id,
        currentStatus: existingExpense.status,
      });
    }

    return await expenseRepository.deleteExpense(id, dbPool);
  } catch (error) {
    logger.error('Error in expense service deleteExpense', { error, id, userId });
    throw error;
  }
};

/**
 * Submit expense for approval (DRAFT -> PENDING_APPROVAL)
 * Creates an approval record so approvers can see it in their queue.
 */
export const submitExpense = async (id: string, userId: string, pool?: Pool) => {
  try {
    const dbPool = pool || globalPool;
    const existingExpense = await expenseRepository.getExpenseById(id, dbPool);
    if (!existingExpense) {
      throw new NotFoundError('Expense');
    }

    // Business rule: Only draft expenses can be submitted
    if (existingExpense.status !== 'DRAFT') {
      throw new BusinessError(
        'Only draft expenses can be submitted for approval',
        'ERR_EXPENSE_003',
        { expenseId: id, currentStatus: existingExpense.status, requiredStatus: 'DRAFT' }
      );
    }

    // Wrap status update + approval record in a single transaction
    const expense = await UnitOfWork.run(dbPool, async (client: PoolClient) => {
      const updated = await expenseRepository.updateExpense(
        id,
        { status: 'PENDING_APPROVAL' },
        client
      );
      await expenseRepository.createApprovalRecord(id, userId, client);
      return updated;
    });

    publishNotificationEvent({
      pool: dbPool,
      typeKey: 'APPROVAL_REQUIRED',
      entityType: 'expense',
      entityId: id,
      idempotencyKey: `APPROVAL_REQUIRED:expense:${id}`,
      payload: buildBusinessNotificationPayload({
        action: 'Expense awaiting approval',
        detail: expenseDetailLabel(existingExpense),
        documentRef: existingExpense.expenseNumber,
        amount: Number(existingExpense.amount || 0),
      }),
      actorUserId: userId,
    });

    return expense;
  } catch (error) {
    logger.error('Error in expense service submitExpense', { error, id, userId });
    throw error;
  }
};

/**
 * Approve expense
 */
export const approveExpense = async (
  id: string,
  approverId: string,
  comments?: string,
  pool?: Pool
) => {
  try {
    const dbPool = pool || globalPool;
    const existingExpense = await expenseRepository.getExpenseById(id, dbPool);
    if (!existingExpense) {
      return null;
    }

    // Business rule: Only pending expenses can be approved
    if (existingExpense.status !== 'PENDING_APPROVAL') {
      throw new BusinessError('Cannot approve expense in current status', 'ERR_EXPENSE_004', {
        expenseId: id,
        currentStatus: existingExpense.status,
        requiredStatus: 'PENDING_APPROVAL',
      });
    }

    // ============================================================
    // Wrap approval status update + GL posting in a single transaction
    // so that APPROVED status and GL entry commit or rollback atomically.
    // ============================================================
    const expense = await UnitOfWork.run(dbPool, async (client: PoolClient) => {
      // Update expense status
      const updated = await expenseRepository.updateExpense(
        id,
        {
          status: 'APPROVED',
          approved_by: approverId,
          approved_at: new Date().toISOString(),
        },
        client
      );

      // Update approval record
      await expenseRepository.updateApprovalRecord(id, approverId, 'APPROVED', comments, client);

      // ── GL POSTING inside transaction ──────────────────────────
      // DR Expense (6xxx)  /  CR Cash (if paid) or AP (if unpaid)
      const paymentStatusResult = await client.query(
        'SELECT payment_status FROM expenses WHERE id = $1',
        [id]
      );
      const isPaidAtApproval = paymentStatusResult.rows[0]?.payment_status === 'PAID';

      const expenseAccountCode = await expenseRepository.resolveExpenseGlAccountCode(
        id,
        existingExpense.categoryCode || existingExpense.category || 'OTHER',
        client
      );

      await glEntryService.recordExpenseApprovalToGL(
        {
          expenseId: id,
          expenseNumber: existingExpense.expenseNumber,
          expenseDate: existingExpense.expenseDate,
          amount: existingExpense.amount,
          categoryCode: existingExpense.categoryCode || existingExpense.category || 'OTHER',
          expenseAccountCode,
          description: existingExpense.title || existingExpense.expenseNumber,
          isPaidAtApproval,
        },
        dbPool,
        client
      );

      return updated;
    });

    publishNotificationEvent({
      pool: dbPool,
      typeKey: 'APPROVAL_COMPLETED',
      entityType: 'expense',
      entityId: id,
      idempotencyKey: `APPROVAL_COMPLETED:expense:${id}`,
      payload: buildBusinessNotificationPayload({
        action: 'Expense approved',
        detail: expenseDetailLabel(existingExpense),
        documentRef: existingExpense.expenseNumber,
        amount: Number(existingExpense.amount || 0),
      }),
      actorUserId: approverId,
    });

    return expense;
  } catch (error) {
    logger.error('Error in expense service approveExpense', { error, id, approverId, comments });
    throw error;
  }
};

/**
 * Reject expense
 */
export const rejectExpense = async (
  id: string,
  rejectorId: string,
  reason: string,
  pool?: Pool
) => {
  try {
    const dbPool = pool || globalPool;
    const existingExpense = await expenseRepository.getExpenseById(id, dbPool);
    if (!existingExpense) {
      return null;
    }

    // Business rule: Only pending expenses can be rejected
    if (existingExpense.status !== 'PENDING_APPROVAL') {
      throw new BusinessError('Cannot reject expense in current status', 'ERR_EXPENSE_005', {
        expenseId: id,
        currentStatus: existingExpense.status,
        requiredStatus: 'PENDING_APPROVAL',
      });
    }

    // Wrap status update + approval record in a single transaction
    const expense = await UnitOfWork.run(dbPool, async (client: PoolClient) => {
      // Update expense status
      const updated = await expenseRepository.updateExpense(
        id,
        {
          status: 'REJECTED',
          rejected_by: rejectorId,
          rejected_at: new Date().toISOString(),
          rejection_reason: reason,
        },
        client
      );

      // Update approval record
      await expenseRepository.updateApprovalRecord(id, rejectorId, 'REJECTED', reason, client);

      return updated;
    });

    publishNotificationEvent({
      pool: dbPool,
      typeKey: 'APPROVAL_REJECTED',
      entityType: 'expense',
      entityId: id,
      idempotencyKey: `APPROVAL_REJECTED:expense:${id}`,
      payload: buildBusinessNotificationPayload({
        action: 'Expense rejected',
        detail: expenseDetailLabel(existingExpense),
        documentRef: existingExpense.expenseNumber,
        amount: Number(existingExpense.amount || 0),
      }),
      actorUserId: rejectorId,
    });

    return expense;
  } catch (error) {
    logger.error('Error in expense service rejectExpense', { error, id, rejectorId, reason });
    throw error;
  }
};

/**
 * Mark expense as paid
 */
export const markExpensePaid = async (
  id: string,
  paidById: string,
  paymentData: {
    paymentDate?: string;
    paymentReference?: string;
    notes?: string;
    paymentAccountId?: string;
  },
  pool?: Pool
) => {
  try {
    const dbPool = pool || globalPool;
    const existingExpense = await expenseRepository.getExpenseById(id, dbPool);
    if (!existingExpense) {
      return null;
    }

    // Business rule: Only approved expenses can be marked as paid
    if (existingExpense.status !== 'APPROVED') {
      throw new BusinessError('Cannot mark expense as paid in current status', 'ERR_EXPENSE_006', {
        expenseId: id,
        currentStatus: existingExpense.status,
        requiredStatus: 'APPROVED',
      });
    }

    // Get default cash account if no payment account specified
    let paymentAccountId = paymentData.paymentAccountId;
    if (!paymentAccountId) {
      const cashAccounts = await expenseRepository.getPaymentAccounts(dbPool);
      const cashAccount =
        cashAccounts.find(
          (a) =>
            (a.account_code === '1010' || a.code === '1010') &&
            a.currentBalance + 0.0001 >= existingExpense.amount
        ) ||
        cashAccounts.find((a) => a.currentBalance + 0.0001 >= existingExpense.amount);
      if (cashAccount) {
        paymentAccountId = cashAccount.id;
      }
    }

    if (paymentAccountId) {
      const acctCheck = await dbPool.query(
        `SELECT "AccountCode", "AccountName", "AllowedSources", "SystemAccountTag"
         FROM accounts WHERE "Id" = $1`,
        [paymentAccountId],
      );
      const acct = acctCheck.rows[0];
      if (!acct) {
        throw new BusinessError('Payment account not found', 'ERR_EXPENSE_009', {
          paymentAccountId,
        });
      }
      const allowed: string[] = Array.isArray(acct.AllowedSources) ? acct.AllowedSources : [];
      if (!allowed.includes('EXPENSE_PAYMENT')) {
        throw new BusinessError(
          `Cannot pay expense from ${acct.AccountCode} (${acct.AccountName}). Choose Cash, Bank, MoMo, or Petty Cash.`,
          'ERR_EXPENSE_010',
          {
            paymentAccountId,
            accountCode: acct.AccountCode,
            allowedSources: allowed,
            requiredSource: 'EXPENSE_PAYMENT',
          },
        );
      }
      const { getLiquidityAvailable } = await import(
        '../modules/treasury/liquidityFundsGuard.js'
      );
      const { available } = await getLiquidityAvailable(dbPool, acct.AccountCode);
      if (available + 0.0001 < existingExpense.amount) {
        throw new BusinessError(
          `Insufficient funds in ${acct.AccountCode} (${acct.AccountName}). Available ${available.toFixed(2)}, required ${Number(existingExpense.amount).toFixed(2)}.`,
          'ERR_EXPENSE_011',
          {
            paymentAccountId,
            accountCode: acct.AccountCode,
            available,
            required: existingExpense.amount,
          },
        );
      }
    }

    const updateData = {
      status: 'PAID' as const,
      paid_by: paidById,
      paid_at: paymentData.paymentDate || new Date().toISOString(),
      reference_number: paymentData.paymentReference || existingExpense.referenceNumber,
      notes: paymentData.notes
        ? `${existingExpense.notes || ''}\n\nPayment: ${paymentData.notes}`.trim()
        : existingExpense.notes,
      // Set payment status and account for GL trigger
      payment_status: 'PAID' as const,
      payment_account_id: paymentAccountId || null,
    };

    // ============================================================
    // Wrap expense update + GL + bank transaction in a single UnitOfWork
    // Prevents PAID status without GL entry or bank record
    // ============================================================
    const updatedExpense = await UnitOfWork.run(dbPool, async (client: PoolClient) => {
      const updated = await expenseRepository.updateExpense(id, updateData, client);

      // ── GL POSTING inside transaction ──────────────────────────
      // DR AP (2100) / CR Cash or Bank — only if approval credited AP
      // (if expense was paid at approval, approval GL already credited Cash)
      let paymentAccountCode: string | undefined;
      if (paymentAccountId) {
        const acctResult = await client.query(
          'SELECT "AccountCode" FROM accounts WHERE "Id" = $1',
          [paymentAccountId]
        );
        if (acctResult.rows.length > 0) {
          paymentAccountCode = acctResult.rows[0].AccountCode;
        }
      }

      const paymentDate = paymentData.paymentDate || getBusinessDate();

      await glEntryService.recordExpensePaymentToGL(
        {
          expenseId: id,
          expenseNumber: existingExpense.expenseNumber,
          amount: existingExpense.amount,
          paymentDate,
          paymentAccountCode,
        },
        dbPool,
        client
      );

      // ── BANKING INTEGRATION ────────────────────────────────────
      // Create bank transaction for non-cash payments
      if (updated && existingExpense.paymentMethod !== 'CASH') {
        const bankTxn = await BankingService.createFromExpense(
          id,
          existingExpense.expenseNumber,
          existingExpense.amount,
          existingExpense.paymentMethod || 'BANK_TRANSFER',
          updateData.paid_at?.split('T')[0] || getBusinessDate(),
          existingExpense.categoryId || undefined,
          dbPool
        );
        if (bankTxn) {
          logger.info('Bank transaction created for expense', {
            expenseId: id,
            expenseNumber: existingExpense.expenseNumber,
            bankTxnNumber: bankTxn.transactionNumber,
            amount: existingExpense.amount,
          });
        }
      }

      return updated;
    });

    publishNotificationEvent({
      pool: dbPool,
      typeKey: 'EXPENSE_PAID',
      entityType: 'expense',
      entityId: id,
      idempotencyKey: `EXPENSE_PAID:expense:${id}`,
      payload: buildBusinessNotificationPayload({
        action: 'Expense paid',
        detail: expenseDetailLabel(existingExpense),
        documentRef: existingExpense.expenseNumber,
        amount: Number(existingExpense.amount || 0),
      }),
      actorUserId: paidById,
    });

    return updatedExpense;
  } catch (error) {
    logger.error('Error in expense service markExpensePaid', { error, id, paidById, paymentData });
    throw error;
  }
};

/**
 * Get expense categories
 */
export const getExpenseCategories = async (includeInactive = false, pool?: Pool) => {
  try {
    return await expenseRepository.getExpenseCategories(pool || globalPool, includeInactive);
  } catch (error) {
    logger.error('Error in expense service getExpenseCategories', { error });
    throw new Error(`Failed to retrieve expense categories: ${(error as Error).message}`);
  }
};

/**
 * Get payment accounts (cash/bank accounts) for expense payment source
 * Returns accounts that can be used as the CREDIT side of expense journal entries
 */
export const getPaymentAccounts = async (pool?: Pool) => {
  try {
    return await expenseRepository.getPaymentAccounts(pool || globalPool);
  } catch (error) {
    logger.error('Error in expense service getPaymentAccounts', { error });
    throw new Error(`Failed to retrieve payment accounts: ${(error as Error).message}`);
  }
};

/** Active HR employees for expense audit picker (staff daily allowance). */
export const listStaffOptions = async (pool?: Pool) => {
  try {
    return await expenseRepository.listStaffOptionsForExpense(pool || globalPool);
  } catch (error) {
    logger.error('Error in expense service listStaffOptions', { error });
    throw error;
  }
};

/**
 * Create expense category
 */
export const createExpenseCategory = async (
  data: {
    name: string;
    code: string;
    description?: string;
  },
  pool?: Pool
) => {
  try {
    const dbPool = pool || globalPool;
    const code = normalizeExpenseCategoryCode(data.code);
    // Check if category with same name or code exists (including alias → canonical)
    const existing = await expenseRepository.getExpenseCategoryByCode(code, dbPool);
    if (existing) {
      throw new BusinessError('Category with this code already exists', 'ERR_EXPENSE_007', {
        code,
      });
    }

    return await expenseRepository.createExpenseCategory({ ...data, code }, dbPool);
  } catch (error) {
    logger.error('Error in expense service createExpenseCategory', { error, data });
    throw error;
  }
};

/**
 * Get expense documents
 */
export const getExpenseDocuments = async (expenseId: string, pool?: Pool) => {
  try {
    return await expenseRepository.getExpenseDocuments(expenseId, pool || globalPool);
  } catch (error) {
    logger.error('Error in expense service getExpenseDocuments', { error, expenseId });
    throw new Error(`Failed to retrieve expense documents: ${(error as Error).message}`);
  }
};

/**
 * Delete expense document
 */
export const deleteExpenseDocument = async (documentId: string, userId: string, pool?: Pool) => {
  try {
    const dbPool = pool || globalPool;
    // Check if document exists and user has permission
    const document = await expenseRepository.getExpenseDocumentById(documentId, dbPool);
    if (!document) {
      return false;
    }

    // Check if user can delete this document (owns the expense or is admin)
    const expense = await expenseRepository.getExpenseById(document.expense_id, dbPool);
    if (!expense || expense.createdBy !== userId) {
      throw new BusinessError('Permission denied', 'ERR_EXPENSE_008', { documentId, userId });
    }

    return await expenseRepository.deleteExpenseDocument(documentId, dbPool);
  } catch (error) {
    logger.error('Error in expense service deleteExpenseDocument', { error, documentId, userId });
    throw error;
  }
};

/**
 * Generate expense number
 */
const generateExpenseNumber = async (pool?: Pool): Promise<string> => {
  try {
    const result = await expenseRepository.generateExpenseNumber(pool || globalPool);
    return result;
  } catch (error) {
    logger.error('Error generating expense number', { error });
    // Fallback to timestamp-based number
    const bizDate = getBusinessDate();
    const year = bizDate.slice(0, 4);
    const month = bizDate.slice(5, 7);
    const timestamp = Date.now().toString().slice(-4);
    return `EXP-${year}${month}-${timestamp}`;
  }
};

/**
 * Get expenses by category report
 */
export const getExpensesByCategory = async (
  filters: { startDate?: string; endDate?: string },
  pool?: Pool
) => {
  try {
    return await expenseRepository.getExpensesByCategory(filters, pool || globalPool);
  } catch (error) {
    logger.error('Error in expenseService getExpensesByCategory', { error, filters });
    throw new Error(`Failed to get expenses by category: ${(error as Error).message}`);
  }
};

/**
 * Get expenses by vendor report
 */
export const getExpensesByVendor = async (
  filters: { startDate?: string; endDate?: string },
  pool?: Pool
) => {
  try {
    return await expenseRepository.getExpensesByVendor(filters, pool || globalPool);
  } catch (error) {
    logger.error('Error in expenseService getExpensesByVendor', { error, filters });
    throw new Error(`Failed to get expenses by vendor: ${(error as Error).message}`);
  }
};

/**
 * Get expense trends
 */
export const getExpenseTrends = async (
  filters: { startDate?: string; endDate?: string },
  pool?: Pool
) => {
  try {
    return await expenseRepository.getExpenseTrends(filters, pool || globalPool);
  } catch (error) {
    logger.error('Error in expenseService getExpenseTrends', { error, filters });
    throw new Error(`Failed to get expense trends: ${(error as Error).message}`);
  }
};

/**
 * Get expenses by payment method
 */
export const getExpensesByPaymentMethod = async (
  filters: {
    startDate?: string;
    endDate?: string;
  },
  pool?: Pool
) => {
  try {
    return await expenseRepository.getExpensesByPaymentMethod(filters, pool || globalPool);
  } catch (error) {
    logger.error('Error in expenseService getExpensesByPaymentMethod', { error, filters });
    throw new Error(`Failed to get expenses by payment method: ${(error as Error).message}`);
  }
};

/**
 * Get expenses for export — same shape as detailed list (no duplicate thin export).
 */
export const getExpensesForExport = async (
  filters: {
    startDate?: string;
    endDate?: string;
    categoryId?: string;
    status?: string;
  },
  pool?: Pool
) => {
  try {
    return await expenseRepository.getExpenseDetailedList(filters, pool || globalPool);
  } catch (error) {
    logger.error('Error in expenseService getExpensesForExport', { error, filters });
    throw new Error(`Failed to get expenses for export: ${(error as Error).message}`);
  }
};

/**
 * Get expense summary/statistics
 */
export const getExpenseSummary = async (
  filters: {
    startDate?: string;
    endDate?: string;
    categoryId?: string;
  },
  pool?: Pool
) => {
  try {
    return await expenseRepository.getExpenseSummary(filters, pool || globalPool);
  } catch (error) {
    logger.error('Error in expense service getExpenseSummary', { error, filters });
    throw new Error(`Failed to retrieve expense summary: ${(error as Error).message}`);
  }
};

/**
 * Update expense category
 */
export const updateExpenseCategory = async (
  id: string,
  updateData: Record<string, unknown>,
  userId: string,
  pool?: Pool
) => {
  try {
    const category = await expenseRepository.updateExpenseCategory(
      id,
      updateData,
      pool || globalPool
    );

    if (category) {
      logger.info('Expense category updated', {
        categoryId: id,
        updatedBy: userId,
      });
    }

    return category;
  } catch (error) {
    logger.error('Update expense category service error', { id, updateData, userId, error });
    throw error;
  }
};

/**
 * Delete expense category
 */
export const deleteExpenseCategory = async (id: string, userId: string, pool?: Pool) => {
  try {
    const dbPool = pool || globalPool;
    // Check if category has associated expenses
    const expenseCount = await expenseRepository.getExpenseCountByCategory(id, dbPool);
    if (expenseCount > 0) {
      throw new BusinessError(
        `Cannot delete category: ${expenseCount} expenses are associated with this category`,
        'ERR_EXPENSE_009',
        { categoryId: id, expenseCount }
      );
    }

    const deleted = await expenseRepository.deleteExpenseCategory(id, dbPool);

    if (deleted) {
      logger.info('Expense category deleted', {
        categoryId: id,
        deletedBy: userId,
      });
    }

    return deleted;
  } catch (error) {
    logger.error('Delete expense category service error', { id, userId, error });
    throw error;
  }
};

/**
 * Enterprise Detailed Expense List with approval, GL account, payment tracking
 */
export const getExpenseDetailedList = async (
  filters: { startDate?: string; endDate?: string; status?: string; categoryId?: string },
  pool?: Pool
) => {
  try {
    return await expenseRepository.getExpenseDetailedList(filters, pool || globalPool);
  } catch (error) {
    logger.error('Error in expenseService getExpenseDetailedList', { error, filters });
    throw new Error(`Failed to get detailed expense list: ${(error as Error).message}`);
  }
};

/**
 * Enterprise Approval Pipeline — expenses by approval stage with workflow metrics
 */
export const getExpenseApprovalPipeline = async (
  filters: { startDate?: string; endDate?: string },
  pool?: Pool
) => {
  try {
    return await expenseRepository.getExpenseApprovalPipeline(filters, pool || globalPool);
  } catch (error) {
    logger.error('Error in expenseService getExpenseApprovalPipeline', { error, filters });
    throw new Error(`Failed to get expense approval pipeline: ${(error as Error).message}`);
  }
};
