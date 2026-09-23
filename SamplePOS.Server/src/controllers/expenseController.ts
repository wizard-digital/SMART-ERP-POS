import { Request } from 'express';
import * as expenseService from '../services/expenseService.js';
import { pool as globalPool } from '../db/pool.js';
import logger from '../utils/logger.js';
import type { UpdateExpenseData } from '../types/expense.js';
import { asyncHandler, AppError, NotFoundError, ValidationError, UnauthorizedError } from '../middleware/errorHandler.js';
import {
  CreateExpenseSchema,
  UpdateExpenseSchema,
  CreateExpenseCategorySchema,
  UpdateExpenseCategorySchema,
  ApproveExpenseSchema,
  RejectExpenseSchema,
  MarkExpensePaidSchema,
  ReverseExpenseSchema,
} from '../../../shared/zod/expense.js';
import { getBusinessDate } from '../utils/dateRange.js';

// Extend Express Request type to include user property
interface AuthenticatedUser {
  id?: string;
  userId?: string;
  role?: string;
}

// Helper to get user from request
function getUser(req: Request): AuthenticatedUser {
  return req.user || {};
}

/**
 * Get paginated list of expenses
 */
export const getExpenses = asyncHandler(async (req, res) => {
  const pool = req.tenantPool || globalPool;
  const {
    page = 1,
    limit = 20,
    status,
    // Accept both snake_case (legacy) and camelCase (frontend hook)
    category_id,
    categoryId,
    category,
    categoryCode,
    start_date,
    startDate,
    end_date,
    endDate,
    search,
    employeeId,
    employee_id,
  } = req.query;

  const categoryParam = (categoryId || category_id || category || categoryCode) as string | undefined;
  const isUuid = !!categoryParam && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(categoryParam);

  const filters = {
    page: parseInt(page as string),
    limit: parseInt(limit as string),
    status: status as string,
    categoryId: isUuid ? categoryParam : undefined,
    categoryCode: !isUuid && categoryParam ? categoryParam : undefined,
    employeeId: (employeeId || employee_id) as string | undefined,
    startDate: (startDate || start_date) as string,
    endDate: (endDate || end_date) as string,
    search: search as string
  };

  const result = await expenseService.getExpenses(filters, pool);

  res.json({
    success: true,
    data: result
  });
});

/**
 * Get expense by ID
 */
export const getExpenseById = asyncHandler(async (req, res) => {
  const pool = req.tenantPool || globalPool;
  const { id } = req.params;
  const expense = await expenseService.getExpenseById(id, pool);
  if (!expense) throw new NotFoundError('Expense');

  res.json({
    success: true,
    data: expense
  });
});

/**
 * Create new expense
 */
export const createExpense = asyncHandler(async (req, res) => {
  const pool = req.tenantPool || globalPool;
  const user = getUser(req);
  if (!user.id) throw new UnauthorizedError('Authentication required to create expenses');

  const validated = CreateExpenseSchema.parse(req.body);

  const expenseData = {
    title: validated.title,
    description: validated.description,
    amount: validated.amount,
    expense_date: validated.expenseDate,
    category: validated.category,
    category_id: validated.categoryId,
    vendor: validated.vendor,
    employee_id: validated.employeeId ?? null,
    payment_method: validated.paymentMethod,
    notes: validated.notes,
    receipt_required: validated.receiptRequired,
    submit_for_approval: undefined as boolean | undefined,
    created_by: user.id
  };

  const expense = await expenseService.createExpense(expenseData, pool);

  logger.info('Expense created', {
    expenseId: expense.id,
    expenseNumber: expense.expenseNumber,
    amount: expense.amount,
    employeeId: expense.employeeId ?? null,
    user: user.userId
  });

  res.status(201).json({
    success: true,
    data: expense,
    message: 'Expense created successfully'
  });
});

/**
 * Update expense
 */
export const updateExpense = asyncHandler(async (req, res) => {
  const pool = req.tenantPool || globalPool;
  const { id } = req.params;
  const user = getUser(req);

  let expense;
  try {
    const validated = UpdateExpenseSchema.parse(req.body);
    const updateData: UpdateExpenseData = {
      title: validated.title,
      description: validated.description,
      amount: validated.amount,
      expense_date: validated.expenseDate,
      category: validated.category,
      category_id: validated.categoryId,
      vendor: validated.vendor,
      employee_id: validated.employeeId === undefined ? undefined : validated.employeeId,
      payment_method: validated.paymentMethod,
      status: validated.status,
      receipt_number: undefined,
      notes: validated.notes,
    };
    expense = await expenseService.updateExpense(id, updateData, user.id!, pool);
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof Error && error.message === 'Cannot modify expense in current status') {
      throw new ValidationError(error.message);
    }
    throw error;
  }
  if (!expense) throw new NotFoundError('Expense');

  logger.info('Expense updated', { expenseId: id, user: user.userId });

  res.json({
    success: true,
    data: expense,
    message: 'Expense updated successfully'
  });
});

/**
 * Delete expense (soft delete)
 */
export const deleteExpense = asyncHandler(async (req, res) => {
  const pool = req.tenantPool || globalPool;
  const { id } = req.params;
  const user = getUser(req);

  let result;
  try {
    result = await expenseService.deleteExpense(id, user.id!, pool);
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof Error && error.message === 'Cannot delete expense in current status') {
      throw new ValidationError(error.message);
    }
    throw error;
  }
  if (!result) throw new NotFoundError('Expense');

  logger.info('Expense deleted', { expenseId: id, user: user.userId });

  res.json({
    success: true,
    message: 'Expense deleted successfully'
  });
});

/**
 * Submit expense for approval (DRAFT -> PENDING_APPROVAL)
 */
export const submitExpense = asyncHandler(async (req, res) => {
  const pool = req.tenantPool || globalPool;
  const { id } = req.params;
  const user = getUser(req);
  const userId = user.id;
  if (!userId) throw new UnauthorizedError('User not authenticated');

  let expense;
  try {
    expense = await expenseService.submitExpense(id, userId, pool);
  } catch (error) {
    if (error instanceof AppError) throw error;
    const msg = error instanceof Error ? error.message : String(error);
    if (msg === 'Expense not found') throw new NotFoundError('Expense');
    if (msg === 'Only draft expenses can be submitted for approval') throw new ValidationError(msg);
    throw error;
  }

  res.json({
    success: true,
    data: expense,
    message: 'Expense submitted for approval'
  });
});

/**
 * Approve expense
 */
export const approveExpense = asyncHandler(async (req, res) => {
  const pool = req.tenantPool || globalPool;
  const { id } = req.params;
  const { comments } = ApproveExpenseSchema.parse(req.body);
  const user = getUser(req);

  let expense;
  try {
    expense = await expenseService.approveExpense(id, user.id!, comments, pool);
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof Error && error.message.includes('Cannot approve expense')) {
      throw new ValidationError(error.message);
    }
    throw error;
  }
  if (!expense) throw new NotFoundError('Expense');

  logger.info('Expense approved', { expenseId: id, approver: user.userId, comments });

  res.json({
    success: true,
    data: expense,
    message: 'Expense approved successfully'
  });
});

/**
 * Reject expense
 */
export const rejectExpense = asyncHandler(async (req, res) => {
  const pool = req.tenantPool || globalPool;
  const { id } = req.params;
  const { reason } = RejectExpenseSchema.parse(req.body);
  const user = getUser(req);

  let expense;
  try {
    expense = await expenseService.rejectExpense(id, user.id!, reason ?? '', pool);
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof Error && error.message.includes('Cannot reject expense')) {
      throw new ValidationError(error.message);
    }
    throw error;
  }
  if (!expense) throw new NotFoundError('Expense');

  logger.info('Expense rejected', { expenseId: id, rejectedBy: user.userId, reason });

  res.json({
    success: true,
    data: expense,
    message: 'Expense rejected successfully'
  });
});

/**
 * Mark expense as paid
 */
export const markExpensePaid = asyncHandler(async (req, res) => {
  const pool = req.tenantPool || globalPool;
  const { id } = req.params;
  const { payment_date, payment_reference, notes, payment_account_id } = MarkExpensePaidSchema.parse(req.body);
  const user = getUser(req);

  let expense;
  try {
    expense = await expenseService.markExpensePaid(id, user.id!, {
      paymentDate: payment_date,
      paymentReference: payment_reference,
      notes,
      paymentAccountId: payment_account_id ?? undefined
    }, pool);
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof Error && error.message.includes('Cannot mark expense as paid')) {
      throw new ValidationError(error.message);
    }
    throw error;
  }
  if (!expense) throw new NotFoundError('Expense');

  logger.info('Expense marked as paid', {
    expenseId: id,
    paidBy: user.userId,
    paymentReference: payment_reference
  });

  res.json({
    success: true,
    data: expense,
    message: 'Expense marked as paid successfully'
  });
});

/**
 * Reverse an approved or paid expense (opposite GL; original journals kept).
 */
export const reverseExpense = asyncHandler(async (req, res) => {
  const pool = req.tenantPool || globalPool;
  const { id } = req.params;
  const { reason } = ReverseExpenseSchema.parse(req.body);
  const user = getUser(req);
  if (!user.id) throw new UnauthorizedError('User required');

  const expense = await expenseService.reverseExpense(id, user.id, reason, pool);
  if (!expense) throw new NotFoundError('Expense');

  logger.info('Expense reversed', {
    expenseId: id,
    reversedBy: user.id,
    reason,
  });

  res.json({
    success: true,
    data: expense,
    message: 'Expense reversed successfully',
  });
});

/**
 * Get expense documents
 */
export const getExpenseDocuments = asyncHandler(async (req, res) => {
  const pool = req.tenantPool || globalPool;
  const { id } = req.params;
  const documents = await expenseService.getExpenseDocuments(id, pool);

  res.json({
    success: true,
    data: documents
  });
});

/**
 * Upload expense document
 */
export const uploadExpenseDocument = asyncHandler(async (_req, res) => {
  // File upload logic would be handled by multer middleware
  // This is a placeholder for the actual implementation
  res.json({
    success: true,
    message: 'Document uploaded successfully'
  });
});

/**
 * Delete expense document
 */
export const deleteExpenseDocument = asyncHandler(async (req, res) => {
  const pool = req.tenantPool || globalPool;
  const { id, docId } = req.params;
  const user = getUser(req);

  const result = await expenseService.deleteExpenseDocument(docId, user.userId!, pool);
  if (!result) throw new NotFoundError('Document');

  logger.info('Expense document deleted', {
    expenseId: id,
    documentId: docId,
    user: user.userId
  });

  res.json({
    success: true,
    message: 'Document deleted successfully'
  });
});

/**
 * Get all expense categories
 */
export const getExpenseCategories = asyncHandler(async (req, res) => {
  const pool = req.tenantPool || globalPool;
  const includeInactive = req.query.includeInactive === 'true';
  const categories = await expenseService.getExpenseCategories(includeInactive, pool);

  res.json({
    success: true,
    data: categories
  });
});

/**
 * Get payment accounts (cash/bank accounts) for expense payment source
 */
export const getPaymentAccounts = asyncHandler(async (req, res) => {
  const pool = req.tenantPool || globalPool;
  const accounts = await expenseService.getPaymentAccounts(pool);

  res.json({
    success: true,
    data: accounts
  });
});

/**
 * Active HR employees for expense audit link (staff daily allowance / claim)
 */
export const listStaffOptions = asyncHandler(async (req, res) => {
  const pool = req.tenantPool || globalPool;
  const staff = await expenseService.listStaffOptions(pool);
  res.json({
    success: true,
    data: staff,
  });
});

/**
 * Create expense category
 */
export const createExpenseCategory = asyncHandler(async (req, res) => {
  const pool = req.tenantPool || globalPool;
  const categoryData = CreateExpenseCategorySchema.parse(req.body);
  const category = await expenseService.createExpenseCategory(categoryData, pool);
  const user = getUser(req);

  logger.info('Expense category created', {
    categoryId: category.id,
    user: user.userId
  });

  res.status(201).json({
    success: true,
    data: category
  });
});

/**
 * Update expense category
 */
export const updateExpenseCategory = asyncHandler(async (req, res) => {
  const pool = req.tenantPool || globalPool;
  const { id } = req.params;
  const user = getUser(req);
  const validated = UpdateExpenseCategorySchema.parse(req.body);
  const category = await expenseService.updateExpenseCategory(id, validated, user.userId!, pool);
  if (!category) throw new NotFoundError('Expense category');

  res.json({
    success: true,
    data: category,
    message: 'Expense category updated successfully'
  });
});

/**
 * Delete expense category
 */
export const deleteExpenseCategory = asyncHandler(async (req, res) => {
  const pool = req.tenantPool || globalPool;
  const { id } = req.params;
  const user = getUser(req);
  const deleted = await expenseService.deleteExpenseCategory(id, user.userId!, pool);
  if (!deleted) throw new NotFoundError('Expense category');

  res.json({
    success: true,
    message: 'Expense category deleted successfully'
  });
});

/**
 * Get expense summary/statistics
 */
export const getExpenseSummary = asyncHandler(async (req, res) => {
  const pool = req.tenantPool || globalPool;
  const { start_date, end_date, category_id } = req.query;

  const summary = await expenseService.getExpenseSummary({
    startDate: start_date as string,
    endDate: end_date as string,
    categoryId: category_id as string
  }, pool);

  res.json({
    success: true,
    data: summary
  });
});

/**
 * Get expenses by category report
 */
export const getExpensesByCategory = asyncHandler(async (req, res) => {
  const pool = req.tenantPool || globalPool;
  const { start_date, end_date } = req.query;

  const report = await expenseService.getExpensesByCategory({
    startDate: start_date as string,
    endDate: end_date as string
  }, pool);

  res.json({
    success: true,
    data: report
  });
});

/**
 * Get expenses by vendor report
 */
export const getExpensesByVendor = asyncHandler(async (req, res) => {
  const pool = req.tenantPool || globalPool;
  const { start_date, end_date } = req.query;

  const report = await expenseService.getExpensesByVendor({
    startDate: start_date as string,
    endDate: end_date as string
  }, pool);

  res.json({
    success: true,
    data: report
  });
});

/**
 * Get expense trends report
 */
export const getExpenseTrends = asyncHandler(async (req, res) => {
  const pool = req.tenantPool || globalPool;
  const { start_date, end_date } = req.query;

  const report = await expenseService.getExpenseTrends({
    startDate: start_date as string,
    endDate: end_date as string
  }, pool);

  res.json({
    success: true,
    data: report
  });
});

/**
 * Get expenses by payment method report
 */
export const getExpensesByPaymentMethod = asyncHandler(async (req, res) => {
  const pool = req.tenantPool || globalPool;
  const { start_date, end_date } = req.query;

  const report = await expenseService.getExpensesByPaymentMethod({
    startDate: start_date as string,
    endDate: end_date as string
  }, pool);

  res.json({
    success: true,
    data: report
  });
});

/**
 * Export expenses to CSV — single source: detailed list (no duplicate thin export shape).
 */
export const exportExpenses = asyncHandler(async (req, res) => {
  const pool = req.tenantPool || globalPool;
  const { start_date, end_date, category_id, status } = req.query;

  const expenses = await expenseService.getExpenseDetailedList({
    startDate: start_date as string,
    endDate: end_date as string,
    categoryId: category_id as string,
    status: status as string,
  }, pool);

  const headers = [
    'Expense Number',
    'Title',
    'Amount',
    'Expense Date',
    'Category',
    'GL Account',
    'Status',
    'Payment Status',
    'Payment Method',
    'Vendor',
    'Staff',
    'Receipt Number',
    'Reference Number',
    'Created By',
    'Approved By',
    'Approved At',
    'Rejected By',
    'Rejected At',
    'Rejection Reason',
    'Paid By',
    'Paid At',
    'Days Pending',
    'Notes',
  ];
  const csvRows = [headers.join(',')];

  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;

  for (const expense of expenses) {
    csvRows.push([
      esc(expense.expenseNumber),
      esc(expense.title),
      expense.amount,
      expense.expenseDate,
      esc(expense.category),
      esc(expense.glAccount),
      expense.status,
      expense.paymentStatus,
      expense.paymentMethod,
      esc(expense.vendor),
      esc(expense.employeeName),
      esc(expense.receiptNumber),
      esc(expense.referenceNumber),
      esc(expense.createdBy),
      esc(expense.approvedBy),
      expense.approvedAt || '',
      esc(expense.rejectedBy),
      expense.rejectedAt || '',
      esc(expense.rejectionReason),
      esc(expense.paidBy),
      expense.paidAt || '',
      expense.daysPending ?? '',
      esc(expense.notes),
    ].join(','));
  }

  const csv = csvRows.join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="expenses_${getBusinessDate()}.csv"`);
  res.send(csv);
});

/**
 * Enterprise Detailed Expense List with approval, GL account, payment tracking
 * GET /api/expenses/reports/detailed-list
 */
export const getExpenseDetailedList = asyncHandler(async (req, res) => {
  const pool = req.tenantPool || globalPool;
  const { start_date, end_date, status, category_id } = req.query;

  const report = await expenseService.getExpenseDetailedList({
    startDate: start_date as string,
    endDate: end_date as string,
    status: status as string,
    categoryId: category_id as string,
  }, pool);

  res.json({
    success: true,
    data: report,
  });
});

/**
 * Enterprise Approval Pipeline — expenses by approval stage with workflow metrics
 * GET /api/expenses/reports/approval-pipeline
 */
export const getExpenseApprovalPipeline = asyncHandler(async (req, res) => {
  const pool = req.tenantPool || globalPool;
  const { start_date, end_date } = req.query;

  const report = await expenseService.getExpenseApprovalPipeline({
    startDate: start_date as string,
    endDate: end_date as string,
  }, pool);

  res.json({
    success: true,
    data: report,
  });
});