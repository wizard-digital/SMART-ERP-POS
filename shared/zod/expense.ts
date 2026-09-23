import { z } from 'zod';

// Enums
export const ExpenseStatusSchema = z.enum([
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'REJECTED',
  'PAID',
  'CANCELLED',
  'REVERSED'
]);

export const ExpenseCategorySchema = z.enum([
  'OFFICE',
  'OFFICE_SUPPLIES',
  'TRAVEL',
  'MEALS',
  'FUEL',
  'UTILITIES',
  'MAINTENANCE',
  'MARKETING',
  'EQUIPMENT',
  'SOFTWARE',
  'PROFESSIONAL',
  'PROFESSIONAL_SERVICES',
  'ACCOMMODATION',
  'TRAINING',
  'ALLOWANCE',
  'OTHER',
  'RENT',
  'SALARIES',
  'INSURANCE',
  'GENERAL'
]);

export const PaymentMethodSchema = z.enum([
  'CASH',
  'CARD',
  'BANK_TRANSFER',
  'MOBILE_MONEY',
  'CHEQUE'
]);

export const PaymentStatusSchema = z.enum([
  'UNPAID',
  'PAID',
  'PARTIAL'
]);

// Create Expense Schema
export const CreateExpenseSchema = z.object({
  title: z.string()
    .min(1, 'Title is required')
    .max(255, 'Title cannot exceed 255 characters')
    .trim(),

  description: z.string()
    .max(1000, 'Description cannot exceed 1000 characters')
    .trim()
    .optional(),

  amount: z.number()
    .positive('Amount must be greater than zero')
    .multipleOf(0.01, 'Amount cannot have more than 2 decimal places'),

  expenseDate: z.string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expense date must be in YYYY-MM-DD format'),

  // Accept any DB category code (not restricted to the TypeScript enum subset)
  category: z.string().min(1, 'Category is required').max(100).trim(),

  categoryId: z.string().uuid('Invalid category ID').optional(),

  vendor: z.string()
    .max(255, 'Vendor name cannot exceed 255 characters')
    .trim()
    .optional(),

  /** HR employee for audit (who received/claimed). Not payroll. */
  employeeId: z.string().uuid('Invalid employee ID').optional().nullable(),

  paymentMethod: PaymentMethodSchema,

  receiptRequired: z.boolean().optional(),

  notes: z.string()
    .max(1000, 'Notes cannot exceed 1000 characters')
    .trim()
    .optional(),

  documentIds: z.array(z.string().uuid('Invalid document ID')).optional(),

  // Payment status and source account for GL posting
  paymentStatus: PaymentStatusSchema.optional().default('UNPAID'),

  // Which cash/bank account the expense was paid from (required when paymentStatus is PAID)
  paymentAccountId: z.string().uuid('Invalid payment account ID').optional().nullable()
}).strict().refine((data) => {
  // If status is PAID, payment account must be selected
  if (data.paymentStatus === 'PAID' && !data.paymentAccountId) {
    return false;
  }
  return true;
}, {
  message: 'Payment account is required when expense is marked as PAID',
  path: ['paymentAccountId']
}).refine((data) => {
  // Staff allowance payouts must name the employee (audit) — still not payroll
  if (String(data.category).toUpperCase() === 'ALLOWANCE' && !data.employeeId) {
    return false;
  }
  return true;
}, {
  message: 'Employee is required for Employee Allowances (audit who received the payout)',
  path: ['employeeId']
});

// Update Expense Schema
export const UpdateExpenseSchema = z.object({
  title: z.string()
    .min(1, 'Title is required')
    .max(255, 'Title cannot exceed 255 characters')
    .trim()
    .optional(),

  description: z.string()
    .max(1000, 'Description cannot exceed 1000 characters')
    .trim()
    .optional(),

  amount: z.number()
    .positive('Amount must be greater than zero')
    .multipleOf(0.01, 'Amount cannot have more than 2 decimal places')
    .optional(),

  expenseDate: z.string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expense date must be in YYYY-MM-DD format')
    .optional(),

  category: z.string().min(1).max(100).trim().optional(),
  categoryId: z.string().uuid('Invalid category ID').optional(),

  vendor: z.string()
    .max(255, 'Vendor name cannot exceed 255 characters')
    .trim()
    .optional(),

  employeeId: z.string().uuid('Invalid employee ID').optional().nullable(),

  paymentMethod: PaymentMethodSchema.optional(),

  status: ExpenseStatusSchema.optional(),

  receiptRequired: z.boolean().optional(),

  notes: z.string()
    .max(1000, 'Notes cannot exceed 1000 characters')
    .trim()
    .optional()
}).strict().refine((data) => {
  if (data.category && String(data.category).toUpperCase() === 'ALLOWANCE' && !data.employeeId) {
    return false;
  }
  return true;
}, {
  message: 'Employee is required for Employee Allowances (audit who received the payout)',
  path: ['employeeId']
});

// Expense Filter Schema
export const ExpenseFilterSchema = z.object({
  status: ExpenseStatusSchema.optional(),
  category: z.string().min(1).max(100).optional(),
  categoryId: z.string().uuid().optional(),
  employeeId: z.string().uuid().optional(),

  startDate: z.string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Start date must be in YYYY-MM-DD format')
    .optional(),

  endDate: z.string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'End date must be in YYYY-MM-DD format')
    .optional(),

  minAmount: z.number()
    .nonnegative('Minimum amount must be non-negative')
    .multipleOf(0.01)
    .optional(),

  maxAmount: z.number()
    .positive('Maximum amount must be positive')
    .multipleOf(0.01)
    .optional(),

  search: z.string()
    .min(1, 'Search term must not be empty')
    .max(255, 'Search term cannot exceed 255 characters')
    .trim()
    .optional(),

  page: z.number()
    .int('Page must be an integer')
    .positive('Page must be positive')
    .default(1)
    .optional(),

  limit: z.number()
    .int('Limit must be an integer')
    .positive('Limit must be positive')
    .max(100, 'Limit cannot exceed 100')
    .default(20)
    .optional(),

  offset: z.number()
    .int('Offset must be an integer')
    .nonnegative('Offset must be non-negative')
    .optional(),

  includeSummary: z.boolean().default(false).optional()
}).strict()
  .transform((data) => ({
    ...data,
    // Convert page to offset if page is provided but offset is not
    offset: data.offset !== undefined ? data.offset :
      data.page ? (data.page - 1) * (data.limit || 20) : 0
  }))
  .refine((data) => {
    // Validate date range
    if (data.startDate && data.endDate) {
      return new Date(data.startDate) <= new Date(data.endDate);
    }
    return true;
  }, {
    message: 'Start date must be before or equal to end date',
    path: ['endDate']
  })
  .refine((data) => {
    // Validate amount range
    if (data.minAmount !== undefined && data.maxAmount !== undefined) {
      return data.minAmount <= data.maxAmount;
    }
    return true;
  }, {
    message: 'Minimum amount must be less than or equal to maximum amount',
    path: ['maxAmount']
  });

// Export types
export type CreateExpenseData = z.infer<typeof CreateExpenseSchema>;
export type UpdateExpenseData = z.infer<typeof UpdateExpenseSchema>;
export type ExpenseFilter = z.infer<typeof ExpenseFilterSchema>;
export type ExpenseStatus = z.infer<typeof ExpenseStatusSchema>;
export type ExpenseCategory = z.infer<typeof ExpenseCategorySchema>;
export type PaymentMethod = z.infer<typeof PaymentMethodSchema>;

// ── Expense Category CRUD ──

export const CreateExpenseCategorySchema = z.object({
  name: z.string().min(1, 'Name is required').max(100).trim(),
  code: z.string().min(1, 'Code is required').max(50).trim(),
  description: z.string().max(500).trim().optional(),
}).strict();

export const UpdateExpenseCategorySchema = CreateExpenseCategorySchema.extend({
  isActive: z.boolean().optional(),
}).partial().strict();

// ── Approval / Rejection / Payment ──

export const ApproveExpenseSchema = z.object({
  comments: z.string().max(1000, 'Comments cannot exceed 1000 characters').trim().optional(),
}).strict();

export const RejectExpenseSchema = z.object({
  reason: z.string().max(1000, 'Reason cannot exceed 1000 characters').trim().optional(),
}).strict();

export const MarkExpensePaidSchema = z.object({
  payment_date: z.string()
    .regex(/^\d{4}-\d{2}-\d{2}/, 'Payment date must start with YYYY-MM-DD')
    .optional(),
  payment_reference: z.string().max(255).trim().optional(),
  notes: z.string().max(1000).trim().optional(),
  payment_account_id: z.string().uuid('Invalid payment account ID').optional(),
}).strict();

export const ReverseExpenseSchema = z.object({
  reason: z.string()
    .trim()
    .min(3, 'Reversal reason is required')
    .max(1000, 'Reason cannot exceed 1000 characters'),
}).strict();

export type CreateExpenseCategoryData = z.infer<typeof CreateExpenseCategorySchema>;
export type ApproveExpenseData = z.infer<typeof ApproveExpenseSchema>;
export type RejectExpenseData = z.infer<typeof RejectExpenseSchema>;
export type MarkExpensePaidData = z.infer<typeof MarkExpensePaidSchema>;
export type ReverseExpenseData = z.infer<typeof ReverseExpenseSchema>;