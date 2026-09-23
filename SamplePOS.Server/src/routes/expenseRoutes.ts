import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { requirePermission, requireAnyPermission } from '../rbac/middleware.js';
import * as expenseController from '../controllers/expenseController.js';

const router = Router();

// Apply authentication to all expense routes
router.use(authenticate);

/**
 * @route GET /api/expenses/summary
 * @desc Get expense summary/statistics
 */
router.get('/summary', requirePermission('expenses.read'), expenseController.getExpenseSummary);

/**
 * @route GET /api/expenses/reports/by-category
 * @desc Get expense report grouped by category
 */
router.get('/reports/by-category', requirePermission('expenses.read'), expenseController.getExpensesByCategory);

/**
 * @route GET /api/expenses/reports/by-vendor
 * @desc Get expense report grouped by vendor
 */
router.get('/reports/by-vendor', requirePermission('expenses.read'), expenseController.getExpensesByVendor);

/**
 * @route GET /api/expenses/reports/trends
 * @desc Get expense trends over time
 */
router.get('/reports/trends', requirePermission('expenses.read'), expenseController.getExpenseTrends);

/**
 * @route GET /api/expenses/reports/by-payment-method
 * @desc Get expense report grouped by payment method
 */
router.get('/reports/by-payment-method', requirePermission('expenses.read'), expenseController.getExpensesByPaymentMethod);

/**
 * @route GET /api/expenses/reports/export
 * @desc Export expense data to CSV
 */
router.get('/reports/export', requirePermission('expenses.export'), expenseController.exportExpenses);

/**
 * @route GET /api/expenses/reports/detailed-list
 * @desc Enterprise detailed expense list with approval, GL account, payment tracking
 */
router.get('/reports/detailed-list', requirePermission('expenses.read'), expenseController.getExpenseDetailedList);

/**
 * @route GET /api/expenses/reports/approval-pipeline
 * @desc Enterprise approval pipeline — expenses by approval stage with workflow metrics
 */
router.get('/reports/approval-pipeline', requirePermission('expenses.read'), expenseController.getExpenseApprovalPipeline);

/**
 * @route GET /api/expenses
 * @desc Get paginated list of expenses with filtering
 */
router.get('/', requirePermission('expenses.read'), expenseController.getExpenses);

/**
 * @route GET /api/expenses/categories
 * @desc Get all expense categories
 */
router.get('/categories', requirePermission('expenses.read'), expenseController.getExpenseCategories);

/**
 * @route GET /api/expenses/payment-accounts
 * @desc Get available payment accounts (cash/bank) for expense payment
 */
router.get('/payment-accounts', requirePermission('expenses.read'), expenseController.getPaymentAccounts);

/**
 * @route GET /api/expenses/staff-options
 * @desc Active HR employees for expense audit link (no hr.read required)
 */
router.get(
  '/staff-options',
  requireAnyPermission(['expenses.read', 'expenses.create']),
  expenseController.listStaffOptions
);

/**
 * @route POST /api/expenses/categories
 * @desc Create new expense category
 */
router.post('/categories', requirePermission('expenses.create'), expenseController.createExpenseCategory);

/**
 * @route PUT /api/expenses/categories/:id
 * @desc Update expense category
 */
router.put('/categories/:id', requirePermission('expenses.update'), expenseController.updateExpenseCategory);

/**
 * @route DELETE /api/expenses/categories/:id
 * @desc Delete expense category
 */
router.delete('/categories/:id', requirePermission('expenses.delete'), expenseController.deleteExpenseCategory);

/**
 * @route GET /api/expenses/:id
 * @desc Get single expense by ID
 */
router.get('/:id', requirePermission('expenses.read'), expenseController.getExpenseById);

/**
 * @route POST /api/expenses
 * @desc Create new expense
 */
router.post('/', requirePermission('expenses.create'), expenseController.createExpense);

/**
 * @route PUT /api/expenses/:id
 * @desc Update expense
 */
router.put('/:id', requirePermission('expenses.update'), expenseController.updateExpense);

/**
 * @route DELETE /api/expenses/:id
 * @desc Delete expense (soft delete)
 */
router.delete('/:id', requirePermission('expenses.delete'), expenseController.deleteExpense);

/**
 * @route POST /api/expenses/:id/submit
 * @desc Submit expense for approval
 */
router.post('/:id/submit', requirePermission('expenses.create'), expenseController.submitExpense);

/**
 * @route POST /api/expenses/:id/approve
 * @desc Approve expense
 */
router.post('/:id/approve', requirePermission('expenses.approve'), expenseController.approveExpense);

/**
 * @route POST /api/expenses/:id/reject
 * @desc Reject expense
 */
router.post('/:id/reject', requirePermission('expenses.approve'), expenseController.rejectExpense);

/**
 * @route POST /api/expenses/:id/mark-paid
 * @desc Mark expense as paid
 */
router.post('/:id/mark-paid', requireAnyPermission(['expenses.approve', 'accounting.post']), expenseController.markExpensePaid);

/**
 * @route POST /api/expenses/:id/reverse
 * @desc Reverse posted expense GL (mistake correction). Original journals stay; opposite entry posted.
 */
router.post(
  '/:id/reverse',
  requireAnyPermission(['expenses.approve', 'accounting.post']),
  expenseController.reverseExpense
);

/**
 * @route GET /api/expenses/:id/documents
 * @desc Get expense documents
 */
router.get('/:id/documents', requirePermission('expenses.read'), expenseController.getExpenseDocuments);

/**
 * @route POST /api/expenses/:id/documents
 * @desc Upload expense document
 */
router.post('/:id/documents', requirePermission('expenses.create'), expenseController.uploadExpenseDocument);

/**
 * @route DELETE /api/expenses/:id/documents/:docId
 * @desc Delete expense document
 */
router.delete('/:id/documents/:docId', requirePermission('expenses.delete'), expenseController.deleteExpenseDocument);

export default router;