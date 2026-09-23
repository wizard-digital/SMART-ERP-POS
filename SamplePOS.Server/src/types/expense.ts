// Expense system types for Node.js backend
// Following SamplePOS architecture: camelCase for TypeScript, snake_case for DB

export interface Expense {
  id: string;
  expenseNumber: string;
  title: string;
  description?: string;
  amount: number;
  expenseDate: string; // YYYY-MM-DD
  category?: string; // Legacy field
  categoryId?: string;
  categoryName?: string;
  categoryCode?: string;
  supplierId?: string;
  supplierName?: string;
  vendor?: string;
  /** HR employee who received/claimed — audit only, not payroll. */
  employeeId?: string | null;
  employeeName?: string | null;
  paymentMethod: PaymentMethod;
  receiptNumber?: string;
  referenceNumber?: string;
  status: ExpenseStatus;
  notes?: string;
  tags?: string[];

  // Audit fields
  createdBy: string;
  approvedBy?: string;
  rejectedBy?: string;
  paidBy?: string;
  rejectionReason?: string;
  reversedBy?: string;
  reversedAt?: string;
  reversalReason?: string;

  // Display names (from joins)
  createdByName?: string;
  approvedByName?: string;
  rejectedByName?: string;
  paidByName?: string;

  // Timestamps
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
  rejectedAt?: string;
  paidAt?: string;
}

export interface ExpenseCategory {
  id: string;
  name: string;
  description?: string;
  code: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ExpenseDocument {
  id: string;
  expenseId: string;
  filename: string;
  originalName: string;
  filePath: string;
  fileSize: number;
  mimeType: string;
  documentType: DocumentType;
  description?: string;
  uploadedBy: string;
  createdAt: string;
}

export interface ExpenseApproval {
  id: string;
  expenseId: string;
  approverId: string;
  approvalLevel: number;
  status: ApprovalStatus;
  decisionDate?: string;
  comments?: string;
  createdAt: string;
  updatedAt: string;
}

// Enums
export type ExpenseStatus =
  | 'DRAFT'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'REJECTED'
  | 'PAID'
  | 'CANCELLED'
  | 'REVERSED';

export type PaymentMethod =
  | 'CASH'
  | 'CARD'
  | 'BANK_TRANSFER'
  | 'MOBILE_MONEY'
  | 'CHEQUE';

export type DocumentType =
  | 'RECEIPT'
  | 'INVOICE'
  | 'CONTRACT'
  | 'APPROVAL'
  | 'OTHER';

export type ApprovalStatus =
  | 'PENDING'
  | 'APPROVED'
  | 'REJECTED';

// Request/Response types
export interface CreateExpenseData {
  title: string;
  description?: string;
  amount: number;
  expense_date: string; // snake_case for DB compatibility
  category?: string; // Legacy field for categorization
  category_id?: string;
  supplier_id?: string;
  vendor?: string;
  employee_id?: string | null;
  payment_method?: PaymentMethod;
  receipt_number?: string;
  reference_number?: string;
  notes?: string;
  tags?: string[];
  created_by?: string;
  submit_for_approval?: boolean;
  // Payment status and source account for GL posting
  payment_status?: 'UNPAID' | 'PAID' | 'PARTIAL';
  payment_account_id?: string | null; // UUID of cash/bank account (required when PAID)
}

export interface UpdateExpenseData {
  title?: string;
  description?: string;
  amount?: number;
  expense_date?: string;
  category?: string;
  category_id?: string;
  supplier_id?: string;
  vendor?: string;
  employee_id?: string | null;
  payment_method?: PaymentMethod;
  receipt_number?: string;
  reference_number?: string;
  notes?: string;
  tags?: string[];
  status?: ExpenseStatus;
  approved_by?: string;
  approved_at?: string;
  rejected_by?: string;
  rejected_at?: string;
  rejection_reason?: string;
  paid_by?: string;
  paid_at?: string;
  // Payment status and account for GL posting
  payment_status?: 'UNPAID' | 'PAID' | 'PARTIAL';
  payment_account_id?: string | null;
}

export interface ExpenseFilters {
  page: number;
  limit: number;
  status?: string;
  categoryId?: string;
  /** Filter by category code (e.g. OFFICE) when UUID not provided */
  categoryCode?: string;
  employeeId?: string;
  startDate?: string;
  endDate?: string;
  search?: string;
}

// Database row types (snake_case)
export interface ExpenseDbRow {
  id: string;
  expense_number: string;
  title: string;
  description?: string;
  amount: string; // PostgreSQL numeric returns as string
  expense_date: string;
  category?: string;
  category_id?: string;
  supplier_id?: string;
  vendor?: string;
  employee_id?: string | null;
  employee_name?: string | null;
  payment_method: string;
  receipt_number?: string;
  reference_number?: string;
  status: string;
  notes?: string;
  tags?: string[];
  created_by: string;
  approved_by?: string;
  rejected_by?: string;
  paid_by?: string;
  rejection_reason?: string;
  reversed_by?: string;
  reversed_at?: string;
  reversal_reason?: string;
  created_at: string;
  updated_at: string;
  approved_at?: string;
  rejected_at?: string;
  paid_at?: string;

  // Joined fields
  category_name?: string;
  category_code?: string;
  supplier_name?: string;
  created_by_name?: string;
  approved_by_name?: string;
  rejected_by_name?: string;
  paid_by_name?: string;
}

export interface ExpenseCategoryDbRow {
  id: string;
  name: string;
  description?: string;
  code: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface ExpenseDocumentDbRow {
  id: string;
  expense_id: string;
  filename: string;
  original_name: string;
  file_path: string;
  file_size: number;
  mime_type: string;
  document_type: string;
  description?: string;
  uploaded_by: string;
  created_at: string;
}

// Summary/Statistics types
export interface ExpenseSummary {
  totalCount: number;
  totalAmount: number;
  draftCount: number;
  pendingCount: number;
  approvedCount: number;
  rejectedCount: number;
  paidCount: number;
  paidAmount: number;
  reversedCount?: number;
  reversedAmount?: number;
}

// API Response types
export interface ExpenseListResponse {
  data: Expense[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}