/**
 * Accounting Routes
 *
 * Provides REST API endpoints for accounting functionality:
 * - Chart of Accounts CRUD
 * - General Ledger queries
 * - Trial Balance
 * - Financial Statements (Balance Sheet, Income Statement, Cash Flow)
 *
 * This module queries REAL data from the PostgreSQL database,
 * following proper double-entry accounting principles.
 */

import express from 'express';
import { z } from 'zod';
import logger from '../../utils/logger.js';
import { authenticate } from '../../middleware/auth.js';
import * as accountingRepository from '../../repositories/accountingRepository.js';
import { Money } from '../../utils/money.js';
import { getSettings } from '../settings/invoiceSettingsService.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { requirePermission } from '../../rbac/middleware.js';
import { pool as globalPool } from '../../db/pool.js';
import { getBusinessDate, formatDateBusiness } from '../../utils/dateRange.js';
import {
  buildBalanceSheetIntegrity,
  buildIncomeStatementIntegrity,
  buildCashFlowIntegrity,
} from '../../services/financialIntegrityService.js';
import {
  buildCashFlowStatement,
  auditCashFlowClassification,
} from '../../services/cashFlowService.js';
import { billedRevenueSql, billedSalesSql } from '@shared/domain/saleGiftFocSsot.js';

// Zod schemas for accounting routes
const ChartOfAccountsQuerySchema = z.object({
  accountType: z.string().optional(),
  isActive: z.enum(['true', 'false']).optional(),
  isPostingAccount: z.enum(['true', 'false']).optional(),
  search: z.string().optional(),
});
const AccountIdParamSchema = z.object({ id: z.string().min(1) });
const CreateAccountSchema = z.object({
  accountNumber: z.string().min(1),
  accountName: z.string().min(1),
  accountType: z.enum(['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE']),
  normalBalance: z.enum(['DEBIT', 'CREDIT']),
  parentAccountId: z.string().uuid().optional().nullable(),
  isPostingAccount: z.boolean().optional().default(true),
  cashFlowClass: z.enum(['operating', 'investing', 'financing']).optional().nullable(),
  /** Banking "Create & use this GL" — stamps SystemAccountTag=BANK for deposit eligibility */
  bankLiquidity: z.boolean().optional().default(false),
});
const GLQuerySchema = z.object({
  page: z
    .string()
    .optional()
    .transform((v) => (v ? parseInt(v) : 1)),
  limit: z
    .string()
    .optional()
    .transform((v) => (v ? parseInt(v) : 20)),
  accountId: z.string().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  search: z.string().optional(),
});
const TransactionIdParamSchema = z.object({ transactionId: z.string().min(1) });
const TrialBalanceQuerySchema = z.object({
  asOfDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  includeZeroBalances: z.enum(['true', 'false']).optional().default('false'),
});
const DateQuerySchema = z.object({
  asOfDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});
const DateRangeQuerySchema = z.object({
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// =============================================================================
// CHART OF ACCOUNTS
// =============================================================================

/**
 * GET /api/accounting/chart-of-accounts
 * Get all accounts with optional filtering
 */
router.get(
  '/chart-of-accounts',
  requirePermission('accounting.read'),
  asyncHandler(async (req, res) => {
    const query = ChartOfAccountsQuerySchema.parse(req.query);

    const filters: accountingRepository.AccountFilters = {};

    if (query.accountType && query.accountType !== 'ALL') {
      filters.accountType = query.accountType;
    }
    if (query.isActive !== undefined) {
      filters.isActive = query.isActive === 'true';
    }
    if (query.isPostingAccount !== undefined) {
      filters.isPostingAccount = query.isPostingAccount === 'true';
    }
    if (query.search) {
      filters.search = query.search;
    }

    const accounts = await accountingRepository.getAccounts(filters, req.tenantPool || globalPool);

    // Transform to frontend format
    // For display purposes:
    // - ASSET, EXPENSE: Debit is positive (display as-is from Debit-Credit calculation)
    // - LIABILITY, EQUITY, REVENUE: Credit is positive (flip the sign for display)
    const formattedAccounts = accounts.map((acc) => {
      const rawBalance = Money.parseDb(acc.currentBalance);
      // Credit-normal accounts (Liability, Equity, Revenue) should display credit balances as positive
      const isCreditNormal = ['LIABILITY', 'EQUITY', 'REVENUE'].includes(acc.accountType);
      const displayBalance = isCreditNormal
        ? Money.negate(rawBalance).toNumber()
        : rawBalance.toNumber();

      return {
        id: acc.id,
        accountNumber: acc.accountCode,
        accountName: acc.accountName,
        accountType: acc.accountType,
        normalBalance: acc.normalBalance,
        parentAccountId: acc.parentAccountId,
        level: acc.level,
        isPostingAccount: acc.isPostingAccount,
        isActive: acc.isActive,
        currentBalance: displayBalance,
      };
    });

    res.json({
      success: true,
      data: formattedAccounts,
    });
  })
);

/**
 * GET /api/accounting/chart-of-accounts/:id
 * Get account by ID
 */
router.get(
  '/chart-of-accounts/:id',
  requirePermission('accounting.read'),
  asyncHandler(async (req, res) => {
    const { id } = AccountIdParamSchema.parse(req.params);
    const account = await accountingRepository.getAccountById(id, req.tenantPool || globalPool);

    if (!account) {
      return res.status(404).json({
        success: false,
        error: 'Account not found',
      });
    }

    res.json({
      success: true,
      data: {
        id: account.id,
        accountNumber: account.accountCode,
        accountName: account.accountName,
        accountType: account.accountType,
        normalBalance: account.normalBalance,
        parentAccountId: account.parentAccountId,
        level: account.level,
        isPostingAccount: account.isPostingAccount,
        isActive: account.isActive,
      },
    });
  })
);

/**
 * POST /api/accounting/chart-of-accounts
 * Create new account
 */
router.post(
  '/chart-of-accounts',
  authenticate,
  requirePermission('accounting.create'),
  asyncHandler(async (req, res) => {
    const pool = req.tenantPool || globalPool;
    const {
      accountNumber,
      accountName,
      accountType,
      normalBalance,
      parentAccountId,
      isPostingAccount,
      cashFlowClass,
      bankLiquidity,
    } = CreateAccountSchema.parse(req.body);

    if (bankLiquidity) {
      if (accountType !== 'ASSET') {
        return res.status(400).json({
          success: false,
          error: 'bankLiquidity GLs must be ASSET accounts',
        });
      }
      if (isPostingAccount === false) {
        return res.status(400).json({
          success: false,
          error: 'bankLiquidity GLs must be posting accounts',
        });
      }
    }

    // Determine level based on parent
    let level = 1;
    if (parentAccountId) {
      const parent = await accountingRepository.getAccountById(parentAccountId, pool);
      if (parent) {
        level = parent.level + 1;
      }
    }

    const account = await accountingRepository.createAccount(
      {
        accountCode: accountNumber,
        accountName,
        accountType,
        normalBalance,
        parentAccountId: parentAccountId || null,
        level,
        isPostingAccount: isPostingAccount !== false,
        isActive: true,
        cashFlowClass: cashFlowClass ?? null,
        systemAccountTag: bankLiquidity ? 'BANK' : null,
      },
      pool
    );

    res.status(201).json({
      success: true,
      data: {
        id: account.id,
        accountNumber: account.accountCode,
        accountName: account.accountName,
        accountType: account.accountType,
        normalBalance: account.normalBalance,
        cashFlowClass: account.cashFlowClass ?? null,
      },
    });
  })
);

/**
 * PUT /api/accounting/chart-of-accounts/:id
 * Update an existing account
 */
const UpdateAccountSchema = z.object({
  accountNumber: z.string().min(1).optional(),
  accountName: z.string().min(1).optional(),
  accountType: z.enum(['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE']).optional(),
  normalBalance: z.enum(['DEBIT', 'CREDIT']).optional(),
  parentAccountId: z.string().uuid().optional().nullable(),
  isPostingAccount: z.boolean().optional(),
  isActive: z.boolean().optional(),
  description: z.string().optional(),
  cashFlowClass: z.enum(['operating', 'investing', 'financing']).optional().nullable(),
});

router.put(
  '/chart-of-accounts/:id',
  requirePermission('accounting.update'),
  asyncHandler(async (req, res) => {
    const pool = req.tenantPool || globalPool;
    const { id } = AccountIdParamSchema.parse(req.params);
    const data = UpdateAccountSchema.parse(req.body);

    const existing = await accountingRepository.getAccountById(id, pool);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Account not found' });
    }

    const updated = await accountingRepository.updateAccount(
      id,
      {
        accountCode: data.accountNumber,
        accountName: data.accountName,
        accountType: data.accountType,
        normalBalance: data.normalBalance,
        parentAccountId: data.parentAccountId,
        isPostingAccount: data.isPostingAccount,
        isActive: data.isActive,
        ...('cashFlowClass' in data ? { cashFlowClass: data.cashFlowClass ?? null } : {}),
      },
      pool
    );

    res.json({
      success: true,
      data: updated
        ? {
          id: updated.id,
          accountNumber: updated.accountCode,
          accountName: updated.accountName,
          accountType: updated.accountType,
          normalBalance: updated.normalBalance,
          parentAccountId: updated.parentAccountId,
          isPostingAccount: updated.isPostingAccount,
          isActive: updated.isActive,
          cashFlowClass: updated.cashFlowClass ?? null,
        }
        : null,
    });
  })
);

/**
 * DELETE /api/accounting/chart-of-accounts/:id
 * Delete (or deactivate) an account
 */
router.delete(
  '/chart-of-accounts/:id',
  requirePermission('accounting.delete'),
  asyncHandler(async (req, res) => {
    const pool = req.tenantPool || globalPool;
    const { id } = AccountIdParamSchema.parse(req.params);

    const existing = await accountingRepository.getAccountById(id, pool);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Account not found' });
    }

    const deleted = await accountingRepository.deleteAccount(id, pool);
    if (!deleted) {
      return res.status(500).json({ success: false, error: 'Failed to delete account' });
    }

    res.json({
      success: true,
      message: 'Account deleted successfully',
    });
  })
);

// =============================================================================
// GENERAL LEDGER
// =============================================================================

/**
 * GET /api/accounting/general-ledger
 * Get ledger entries with filtering and pagination
 */
router.get(
  '/general-ledger',
  requirePermission('accounting.read'),
  asyncHandler(async (req, res) => {
    const query = GLQuerySchema.parse(req.query);

    const filters: accountingRepository.LedgerFilters = {
      page: query.page,
      limit: query.limit,
      accountId: query.accountId && query.accountId !== 'ALL' ? query.accountId : undefined,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
      search: query.search,
    };

    const { entries, total } = await accountingRepository.getLedgerEntries(
      filters,
      req.tenantPool || globalPool
    );

    res.json({
      success: true,
      data: entries.map((entry) => ({
        id: entry.id,
        transactionId: entry.transactionId,
        accountId: entry.accountId,
        accountNumber: entry.accountCode,
        accountName: entry.accountName,
        description: entry.description,
        debitAmount: entry.debitAmount,
        creditAmount: entry.creditAmount,
        balance: entry.runningBalance,
        transactionDate: entry.entryDate?.split('T')[0] || entry.entryDate,
        reference: entry.reference,
        createdAt: entry.createdAt,
      })),
      pagination: {
        page: filters.page,
        limit: filters.limit,
        total,
        totalPages: Math.ceil(total / filters.limit),
      },
    });
  })
);

/**
 * GET /api/accounting/general-ledger/export
 * Export general ledger entries as CSV
 * NOTE: This route MUST come before /general-ledger/:id to avoid route conflict
 */
router.get(
  '/general-ledger/export',
  requirePermission('accounting.export'),
  asyncHandler(async (req, res) => {
    const query = GLQuerySchema.parse(req.query);

    // Get all entries (high limit for export)
    const filters: accountingRepository.LedgerFilters = {
      page: 1,
      limit: 10000, // Get all for export
      accountId: query.accountId && query.accountId !== 'ALL' ? query.accountId : undefined,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
      search: query.search,
    };

    const { entries } = await accountingRepository.getLedgerEntries(
      filters,
      req.tenantPool || globalPool
    );

    // Build CSV content
    const headers = [
      'Date',
      'Reference',
      'Account Code',
      'Account Name',
      'Description',
      'Debit',
      'Credit',
      'Balance',
    ];
    const rows = entries.map((entry) => [
      entry.entryDate?.split('T')[0] || '',
      entry.reference || '',
      entry.accountCode || '',
      entry.accountName || '',
      (entry.description || '').replace(/,/g, ';'), // Escape commas
      Money.format(entry.debitAmount, 2),
      Money.format(entry.creditAmount, 2),
      Money.format(entry.runningBalance, 2),
    ]);

    const csvContent = [headers.join(','), ...rows.map((row) => row.join(','))].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="general-ledger-${getBusinessDate()}.csv"`
    );
    res.send(csvContent);
  })
);

/**
 * GET /api/accounting/general-ledger/:id
 * Get journal entry by ID with all lines
 */
router.get(
  '/general-ledger/:id',
  requirePermission('accounting.read'),
  asyncHandler(async (req, res) => {
    const { id } = AccountIdParamSchema.parse(req.params);
    const entry = await accountingRepository.getJournalEntryById(id, req.tenantPool || globalPool);

    if (!entry) {
      return res.status(404).json({
        success: false,
        error: 'Journal entry not found',
      });
    }

    res.json({
      success: true,
      data: entry,
    });
  })
);

/**
 * GET /api/accounting/transactions/:transactionId
 * Get transaction details by transaction ID
 * Tries ledger_transactions first (backfilled data), then journal_entries
 */
router.get(
  '/transactions/:transactionId',
  requirePermission('accounting.read'),
  asyncHandler(async (req, res) => {
    const { transactionId } = TransactionIdParamSchema.parse(req.params);

    // First, try to find in ledger_transactions (backfilled data)
    const ledgerTxn = await accountingRepository.getLedgerTransactionById(
      transactionId,
      req.tenantPool || globalPool
    );

    if (ledgerTxn) {
      return res.json({
        success: true,
        data: {
          id: ledgerTxn.id,
          transactionId: ledgerTxn.id,
          transactionNumber: ledgerTxn.transactionNumber,
          transactionDate: ledgerTxn.transactionDate?.split('T')[0] || '',
          reference: ledgerTxn.referenceNumber || ledgerTxn.transactionNumber,
          referenceType: ledgerTxn.referenceType,
          description: ledgerTxn.description,
          status: ledgerTxn.status,
          // Frontend expects totalAmount - use totalDebitAmount (or totalCreditAmount, they should match)
          totalAmount: ledgerTxn.totalDebitAmount || ledgerTxn.totalCreditAmount || 0,
          totalDebitAmount: ledgerTxn.totalDebitAmount,
          totalCreditAmount: ledgerTxn.totalCreditAmount,
          createdAt: ledgerTxn.createdAt || '',
          createdBy: ledgerTxn.createdBy || 'System',
          entries: ledgerTxn.entries.map((entry) => ({
            id: entry.id,
            accountId: entry.accountId,
            accountNumber: entry.accountCode,
            accountName: entry.accountName,
            debitAmount: entry.debitAmount,
            creditAmount: entry.creditAmount,
            description: entry.description,
          })),
        },
      });
    }

    // Fall back to journal_entries (original system)
    const journalEntry = await accountingRepository.getJournalEntryById(
      transactionId,
      req.tenantPool || globalPool
    );

    if (!journalEntry) {
      return res.status(404).json({
        success: false,
        error: 'Transaction not found',
      });
    }

    res.json({
      success: true,
      data: {
        id: journalEntry.id,
        transactionId: journalEntry.transactionId,
        date: journalEntry.entryDate?.split('T')[0],
        reference: journalEntry.transactionId,
        description: journalEntry.description,
        status: journalEntry.status,
        createdAt: journalEntry.createdAt,
        entries: journalEntry.lines.map((line) => ({
          id: line.id,
          accountId: line.accountId,
          accountNumber: line.accountCode,
          accountName: line.accountName,
          debitAmount: line.debitAmount,
          creditAmount: line.creditAmount,
          description: line.description,
        })),
      },
    });
  })
);

// =============================================================================
// TRIAL BALANCE
// =============================================================================

/**
 * GET /api/accounting/trial-balance
 * Generate trial balance as of a given date
 */
router.get(
  '/trial-balance',
  requirePermission('accounting.read'),
  asyncHandler(async (req, res) => {
    const query = TrialBalanceQuerySchema.parse(req.query);
    const asOfDate = query.asOfDate || getBusinessDate();
    const includeZeroBalances = query.includeZeroBalances === 'true';

    const trialBalance = await accountingRepository.getTrialBalance(
      asOfDate,
      includeZeroBalances,
      req.tenantPool || globalPool
    );

    res.json({
      success: true,
      data: trialBalance,
    });
  })
);

// =============================================================================
// BALANCE SHEET
// =============================================================================

/**
 * GET /api/accounting/balance-sheet
 * Generate balance sheet as of a given date
 */
router.get(
  '/balance-sheet',
  requirePermission('accounting.read'),
  asyncHandler(async (req, res) => {
    const pool = req.tenantPool || globalPool;
    const query = DateQuerySchema.parse(req.query);
    const asOfDate = query.asOfDate || getBusinessDate();

    const [balanceSheet, integrity] = await Promise.all([
      accountingRepository.getBalanceSheet(asOfDate, pool),
      buildBalanceSheetIntegrity(pool, asOfDate),
    ]);

    // Get company name from settings
    const settings = await getSettings(pool);
    const companyName = settings.companyName || 'SMART ERP';

    res.json({
      success: true,
      data: { ...balanceSheet, companyName, integrity },
    });
  })
);

// =============================================================================
// INCOME STATEMENT
// =============================================================================

/**
 * GET /api/accounting/income-statement
 * Generate income statement for a date range
 */
router.get(
  '/income-statement',
  requirePermission('accounting.read'),
  asyncHandler(async (req, res) => {
    const pool = req.tenantPool || globalPool;
    // Use business date for default range (timezone-safe, SAP pattern)
    const bizDate = getBusinessDate();
    const firstDayOfMonth = bizDate.slice(0, 8) + '01';

    const query = DateRangeQuerySchema.parse(req.query);
    const startDate = query.startDate || firstDayOfMonth;
    const endDate = query.endDate || bizDate;

    const [incomeStatement, integrity] = await Promise.all([
      accountingRepository.getIncomeStatement(startDate, endDate, pool),
      buildIncomeStatementIntegrity(pool, startDate, endDate),
    ]);

    // Get company name from settings
    const settings = await getSettings(pool);
    const companyName = settings.companyName || 'SMART ERP';

    res.json({
      success: true,
      data: { ...incomeStatement, companyName, integrity },
    });
  })
);

// =============================================================================
// CASH FLOW STATEMENT  (IAS 7 — GL-driven, Direct Method)
// =============================================================================

/**
 * GET /api/accounting/cash-flow
 *
 * IAS 7-compliant Cash Flow Statement.
 * Classification is determined solely by accounts.CashFlowClass of the
 * OPPOSITE GL account in each journal entry — never by transaction type.
 * No "OTHER" section ever appears.
 */
router.get(
  '/cash-flow',
  requirePermission('accounting.read'),
  asyncHandler(async (req, res) => {
    const pool = req.tenantPool || globalPool;
    const bizDate = getBusinessDate();
    const firstDayOfMonth = bizDate.slice(0, 8) + '01';

    const query = DateRangeQuerySchema.parse(req.query);
    const startDate = query.startDate || firstDayOfMonth;
    const endDate = query.endDate || bizDate;

    const [statement, settings, integrity] = await Promise.all([
      buildCashFlowStatement(pool, startDate, endDate),
      getSettings(pool),
      buildCashFlowIntegrity(pool, startDate, endDate),
    ]);

    // Map to the shape the frontend expects
    const mapItems = (items: typeof statement.operating.items) =>
      items.map((item) => ({
        description: item.description,   // aggregated account name, e.g. "Sales Revenue"
        accountCode: item.oppositeAccountCode,
        amount: item.net,
        cashInflow: item.cashInflow,
        cashOutflow: item.cashOutflow,
      }));

    res.json({
      success: true,
      data: {
        companyName: settings.companyName || 'SMART ERP',
        periodStart: startDate,
        periodEnd: endDate,
        generatedAt: statement.generatedAt,
        // Section objects with items + totals (used by frontend transformer)
        operatingActivities: {
          items: mapItems(statement.operating.items),
          totalOperatingCashFlow: statement.operating.netTotal,
        },
        investingActivities: {
          items: mapItems(statement.investing.items),
          totalInvestingCashFlow: statement.investing.netTotal,
        },
        financingActivities: {
          items: mapItems(statement.financing.items),
          totalFinancingCashFlow: statement.financing.netTotal,
        },
        // Flat totals (backward-compatible aliases)
        totalOperatingCashFlow: statement.operating.netTotal,
        totalInvestingCashFlow: statement.investing.netTotal,
        totalFinancingCashFlow: statement.financing.netTotal,
        netChangeInCash: statement.netChangeInCash,
        beginningCashBalance: statement.beginningCashBalance,
        endingCashBalance: statement.endingCashBalance,
        // Audit: classification issues (empty = fully compliant)
        unclassifiedIssues: statement.unclassifiedIssues,
        integrity,
      },
    });
  })
);

/**
 * GET /api/accounting/cash-flow/audit
 *
 * Returns all historical GL cash movements that cannot be classified because
 * the opposite account has no CashFlowClass set.
 * Empty result = chart of accounts is fully IAS 7 compliant.
 */
router.get(
  '/cash-flow/audit',
  requirePermission('accounting.read'),
  asyncHandler(async (req, res) => {
    const pool = req.tenantPool || globalPool;
    const bizDate = getBusinessDate();

    const query = DateRangeQuerySchema.parse(req.query);
    const startDate = query.startDate || '2000-01-01';
    const endDate = query.endDate || bizDate;

    const issues = await auditCashFlowClassification(pool, startDate, endDate);

    res.json({
      success: true,
      data: {
        periodStart: startDate,
        periodEnd: endDate,
        totalIssues: issues.length,
        issues,
        compliant: issues.length === 0,
        message:
          issues.length === 0
            ? 'All cash movements are fully classified per IAS 7'
            : `${issues.length} cash movement(s) could not be classified — assign CashFlowClass to the affected accounts`,
      },
    });
  })
);

// =============================================================================
// DASHBOARD SUMMARY ENDPOINT
// =============================================================================

/**
 * GET /api/accounting/dashboard-summary
 * Comprehensive dashboard data for accounting module
 * Fetches: chart of accounts, trial balance, sales summary, receivables, payables
 */
router.get(
  '/dashboard-summary',
  requirePermission('accounting.read'),
  asyncHandler(async (req, res) => {
    const pool = req.tenantPool || globalPool;

    // Fetch all dashboard data in parallel
    const [
      accountsResult,
      trialBalanceResult,
      salesSummaryResult,
      receivablesSummaryResult,
      payablesSummaryResult,
      journalEntriesResult,
      depositLiabilitiesResult,
    ] = await Promise.all([
      // Chart of accounts summary (using correct table and column names)
      pool.query(`
    SELECT "AccountType" as account_type, COUNT(*) as count
    FROM accounts
    WHERE "IsActive" = true
    GROUP BY "AccountType"
      `),
      // Trial balance totals from gl_period_balances (fast totals table)
      pool.query(`
    SELECT 
      COALESCE(SUM(gpb.debit_total), 0) as total_debits,
      COALESCE(SUM(gpb.credit_total), 0) as total_credits
    FROM gl_period_balances gpb
      `),
      // Sales summary (last 30 days) — billed revenue only; COGS includes FOC gift cost
      pool.query(`
    SELECT 
      COUNT(*) FILTER (WHERE ${billedSalesSql()})::integer as total_sales,
      COALESCE(SUM(${billedRevenueSql()}), 0) as total_revenue,
      COALESCE(SUM(total_cost), 0) as total_cogs,
      COALESCE(SUM(${billedRevenueSql()}), 0)
        - COALESCE(SUM(total_cost), 0) as total_profit
    FROM sales
    WHERE sale_date >= CURRENT_DATE - INTERVAL '30 days'
      AND status = 'COMPLETED'
      `),
      // Accounts receivable — from customers with positive balance
      pool.query(`
    SELECT 
      COUNT(*) as customer_count,
      COALESCE(SUM(balance), 0) as total_receivables
    FROM customers
    WHERE balance > 0
      `),
      // Accounts payable — supplier invoice subledger (matches Supplier Payments / Report Integrity)
      pool.query(`
    SELECT 
      (SELECT COUNT(*) FROM suppliers WHERE "IsActive" = true)::int AS supplier_count,
      GREATEST(COALESCE((
        SELECT SUM(
          CASE WHEN si.document_type = 'SUPPLIER_CREDIT_NOTE'
               THEN -COALESCE(si."OutstandingBalance", 0)
               ELSE  COALESCE(si."OutstandingBalance", 0) END
        )
        FROM supplier_invoices si
        WHERE si.deleted_at IS NULL
          AND UPPER(si."Status") NOT IN ('PAID', 'CANCELLED', 'DELETED')
      ), 0), 0) AS total_payables,
      COALESCE((
        SELECT SUM(gpb.credit_total) - SUM(gpb.debit_total)
        FROM gl_period_balances gpb
        JOIN accounts a ON a."Id" = gpb.account_id
        WHERE a."AccountCode" = '2100'
      ), 0) AS gl_2100_total
      `),
      // Recent ledger transactions count (where actual data lives)
      pool.query(`
    SELECT COUNT(*) as entry_count
    FROM ledger_transactions
    WHERE "TransactionDate" >= CURRENT_DATE - INTERVAL '30 days'
      AND "Status" = 'POSTED'
      `),
      // Customer deposit liabilities (prepayments held)
      pool.query(`
    SELECT 
      COUNT(*) as deposit_count,
      COUNT(DISTINCT customer_id) as customer_count,
      COALESCE(SUM(amount_available), 0) as total_liability
    FROM pos_customer_deposits
    WHERE status = 'ACTIVE' AND amount_available > 0
      `),
    ]);

    // Process accounts by type
    const accountsByType: Record<string, number> = {};
    let totalAccounts = 0;
    accountsResult.rows.forEach((row: { account_type: string; count: string }) => {
      accountsByType[row.account_type] = parseInt(row.count);
      totalAccounts += parseInt(row.count);
    });

    // Calculate trial balance status using decimal-safe arithmetic
    const totalDebits = Money.parseDb(trialBalanceResult.rows[0]?.total_debits);
    const totalCredits = Money.parseDb(trialBalanceResult.rows[0]?.total_credits);
    const difference = Money.abs(Money.subtract(totalDebits, totalCredits));
    const isBalanced = difference.lessThan(0.01);

    // Sales summary
    const salesData = salesSummaryResult.rows[0] || {};
    const totalRevenue = Money.parseDb(salesData.total_revenue);
    const totalCOGS = Money.parseDb(salesData.total_cogs);
    const totalProfit = Money.parseDb(salesData.total_profit);
    const profitMargin = Money.grossMargin(totalRevenue, totalCOGS);

    // Receivables summary
    const receivablesData = receivablesSummaryResult.rows[0] || {};

    // Payables summary
    const payablesData = payablesSummaryResult.rows[0] || {};

    // Journal entries count
    const journalEntriesCount = parseInt(journalEntriesResult.rows[0]?.entry_count || '0');

    // Deposit liabilities
    const depositData = depositLiabilitiesResult.rows[0] || {};

    res.json({
      success: true,
      data: {
        asOfDate: getBusinessDate(),
        chartOfAccounts: {
          total: totalAccounts,
          byType: accountsByType,
        },
        trialBalance: {
          totalDebits: totalDebits.toNumber(),
          totalCredits: totalCredits.toNumber(),
          difference: difference.toNumber(),
          isBalanced,
        },
        sales: {
          periodDays: 30,
          totalSales: parseInt(salesData.total_sales || '0'),
          totalRevenue: totalRevenue.toNumber(),
          totalCOGS: totalCOGS.toNumber(),
          totalProfit: totalProfit.toNumber(),
          profitMargin: profitMargin.toNumber(),
        },
        receivables: {
          customerCount: parseInt(receivablesData.customer_count || '0'),
          totalAmount: Money.parseDb(receivablesData.total_receivables).toNumber(),
        },
        payables: {
          supplierCount: parseInt(payablesData.supplier_count || '0'),
          totalAmount: Money.parseDb(payablesData.total_payables).toNumber(),
          gl2100Total: Money.parseDb(payablesData.gl_2100_total).toNumber(),
        },
        depositLiabilities: {
          depositCount: parseInt(depositData.deposit_count || '0'),
          customerCount: parseInt(depositData.customer_count || '0'),
          totalLiability: Money.parseDb(depositData.total_liability).toNumber(),
        },
        journalEntries: {
          recentCount: journalEntriesCount,
        },
      },
    });
  })
);

// =============================================================================
// EXPORT ENDPOINTS (Other reports - GL export is above with its routes)
// =============================================================================

router.get('/balance-sheet/export', requirePermission('accounting.export'), (_req, res) => {
  res.json({
    success: false,
    message: 'Export functionality coming soon',
  });
});

router.get('/income-statement/export', requirePermission('accounting.export'), (_req, res) => {
  res.json({
    success: false,
    message: 'Export functionality coming soon',
  });
});

router.get('/cash-flow/export', requirePermission('accounting.export'), (_req, res) => {
  res.json({
    success: false,
    message: 'Export functionality coming soon',
  });
});

router.get('/trial-balance/export', requirePermission('accounting.export'), (_req, res) => {
  res.json({
    success: false,
    message: 'Export functionality coming soon',
  });
});

export { router as accountingRoutes };
