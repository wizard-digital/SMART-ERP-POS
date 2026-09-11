// Reports Service - Business logic and orchestration
// Coordinates report generation with audit logging

import { Pool } from 'pg';
import { reportsRepository } from './reportsRepository.js';
import { buildReorderDashboardSummary } from './reorderDashboardLogic.js';
import type { ReorderDashboardItem } from './reportTypes.js';
import * as cnDnReportService from './cnDnReportService.js';
import { systemSettingsService } from '../system-settings/systemSettingsService.js';
import { SystemSettings } from '../../../../shared/types/systemSettings.js';
import { summarizeSalesComparison } from '../../../../shared/reports/salesComparisonSsot.js';
import { summarizeExpiringItems, filterExpiringRowsByBand, type ExpiryBandFilter } from '../../../../shared/reports/expiringItemsSsot.js';
import Decimal from 'decimal.js';
import { getBusinessDate } from '../../utils/dateRange.js';

// Configure Decimal for financial precision
Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

/**
 * Interface for system settings context included in all reports
 */
interface ReportSystemContext {
  businessName: string;
  currencyCode: string;
  currencySymbol: string;
  dateFormat: string;
  timeFormat: string;
  timezone: string;
  taxEnabled: boolean;
  taxName: string;
  defaultTaxRate: number;
}

/**
 * Helper to get system settings context for reports
 */
async function getSystemContext(pool: Pool): Promise<ReportSystemContext> {
  const settings = await systemSettingsService.getSettings(pool);
  return {
    businessName: settings.businessName,
    currencyCode: settings.currencyCode,
    currencySymbol: settings.currencySymbol,
    dateFormat: settings.dateFormat,
    timeFormat: settings.timeFormat,
    timezone: settings.timezone,
    taxEnabled: settings.taxEnabled,
    taxName: settings.taxName,
    defaultTaxRate: settings.defaultTaxRate,
  };
}

/**
 * Format currency value according to system settings
 */
function formatCurrency(amount: number, currencySymbol: string): string {
  return `${currencySymbol}${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Format date according to system settings date format.
 * Always uses Africa/Kampala timezone to ensure consistent output
 * regardless of server locale (SAP/Odoo pattern: server-authoritative TZ).
 */
function formatDate(date: Date | string, dateFormat: string): string {
  const d = typeof date === 'string' ? new Date(date) : date;

  // Common date format patterns
  const formatters: Record<string, Intl.DateTimeFormatOptions> = {
    'DD/MM/YYYY': { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Africa/Kampala' },
    'MM/DD/YYYY': { month: '2-digit', day: '2-digit', year: 'numeric', timeZone: 'Africa/Kampala' },
    'YYYY-MM-DD': { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Africa/Kampala' },
    'DD-MM-YYYY': { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Africa/Kampala' },
    'MMM DD, YYYY': { month: 'short', day: '2-digit', year: 'numeric', timeZone: 'Africa/Kampala' },
  };

  const options = formatters[dateFormat] || formatters['DD/MM/YYYY'];
  return d.toLocaleDateString('en-US', options);
}

export const reportsService = {
  /**
   * Get current system settings for report formatting
   * Returns currency, date format, business name, and tax configuration
   */
  async getSystemSettings(pool: Pool): Promise<ReportSystemContext> {
    return getSystemContext(pool);
  },

  /**
   * Generate Inventory Valuation Report with audit logging
   * @param pool - Database connection pool
   * @param options - Report parameters (date, category, method, format, user)
   * @returns Report data with summary and execution metrics
   *
   * Valuation Methods:
   * - **FIFO** (First In First Out): Values using oldest cost layers
   * - **AVCO** (Average Cost): Weighted average across all layers
   * - **LIFO** (Last In First Out): Values using newest cost layers (rare)
   *
   * Report Structure:
   * - Per-product inventory line items
   * - quantity_on_hand: Current stock level
   * - unit_cost: Per-unit cost based on valuation method
   * - total_value: quantity * unit_cost
   * - Summary: Total items, total value, total quantity
   *
   * Use Cases:
   * - Financial statements (Balance Sheet - Current Assets)
   * - Insurance valuation
   * - Tax reporting (year-end inventory value)
   * - Stock audits and reconciliation
   *
   * Performance:
   * - Execution time logged for monitoring
   * - Category filter reduces dataset for large inventories
   * - as_of_date enables historical valuation snapshots
   *
   * Audit Trail:
   * - Logs to report_runs table (BR-RPT-001)
   * - Records: user, parameters, execution time, row count
   * - Enables compliance reporting and query optimization
   */
  async generateInventoryValuation(
    pool: Pool,
    options: {
      asOfDate?: Date | string;
      categoryId?: string;
      valuationMethod?: 'FIFO' | 'AVCO' | 'LIFO';
      format?: 'json' | 'pdf' | 'csv';
      userId?: string;
      page?: number;
      limit?: number;
    }
  ) {
    const startTime = Date.now();

    // Get system settings for report formatting
    const systemContext = await getSystemContext(pool);

    // SQL returns pre-aggregated summary, byCategory, and paginated items —
    // no JS .reduce() or Map grouping needed.
    const { items: data, summary: sqlSummary, byCategory } =
      await reportsRepository.getInventoryValuation(pool, {
        asOfDate: options.asOfDate,
        categoryId: options.categoryId,
        valuationMethod: options.valuationMethod,
        page: options.page,
        limit: options.limit,
      });

    const executionTime = Date.now() - startTime;

    // Log report run
    await reportsRepository.logReportRun(pool, {
      reportType: 'INVENTORY_VALUATION',
      reportName: 'Inventory Valuation Report',
      parameters: {
        asOfDate: options.asOfDate,
        categoryId: options.categoryId,
        valuationMethod: options.valuationMethod,
      },
      generatedById: options.userId || null,
      recordCount: sqlSummary.totalItems,
      fileFormat: options.format || 'json',
      executionTimeMs: executionTime,
    });

    const overallMargin = sqlSummary.totalPotentialRevenue > 0
      ? new Decimal(sqlSummary.totalPotentialProfit)
        .dividedBy(sqlSummary.totalPotentialRevenue)
        .times(100)
        .toDecimalPlaces(2)
        .toNumber()
      : 0;

    // ── Warnings (historical as-of not supported accurately, reconciliation drift) ──
    const warnings: string[] = [];
    const today = getBusinessDate();
    const requestedDate = options.asOfDate
      ? (typeof options.asOfDate === 'string' ? options.asOfDate.slice(0, 10) : options.asOfDate.toISOString().slice(0, 10))
      : today;
    if (requestedDate !== today) {
      warnings.push(
        `Historical as-of snapshots are not yet supported — showing CURRENT inventory. Requested date ${requestedDate} was ignored.`
      );
    }
    if (!sqlSummary.isReconciled) {
      const diff = sqlSummary.variance;
      warnings.push(
        `GL inventory (account 1300) balance of ${sqlSummary.glInventoryBalance.toLocaleString()} differs from this report by ${diff.toLocaleString()} (${sqlSummary.variancePercent.toFixed(2)}%). Run the inventory integrity check to investigate.`
      );
    }

    return {
      reportType: 'INVENTORY_VALUATION' as const,
      reportName: 'Inventory Valuation Report',
      generatedAt: new Date().toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false, timeZone: 'Africa/Kampala',
      }),
      systemSettings: systemContext,
      parameters: options,
      warnings,
      data,
      byCategory,
      summary: {
        totalItems: sqlSummary.totalItems,
        totalValue: sqlSummary.totalValue,
        totalValueFormatted: formatCurrency(sqlSummary.totalValue, systemContext.currencySymbol),
        totalQuantity: sqlSummary.totalQuantity,
        totalPotentialRevenue: sqlSummary.totalPotentialRevenue,
        totalPotentialRevenueFormatted: formatCurrency(
          sqlSummary.totalPotentialRevenue,
          systemContext.currencySymbol
        ),
        totalPotentialProfit: sqlSummary.totalPotentialProfit,
        totalPotentialProfitFormatted: formatCurrency(
          sqlSummary.totalPotentialProfit,
          systemContext.currencySymbol
        ),
        overallMargin,
        valuationMethod: options.valuationMethod || 'FIFO',
        // ── GL reconciliation (account 1300 Inventory) ──
        glInventoryBalance: sqlSummary.glInventoryBalance,
        glInventoryBalanceFormatted: formatCurrency(sqlSummary.glInventoryBalance, systemContext.currencySymbol),
        costLayersTotal: sqlSummary.costLayersTotal,
        subledgerAvcoTotal: sqlSummary.subledgerAvcoTotal,
        variance: sqlSummary.variance,
        varianceFormatted: formatCurrency(sqlSummary.variance, systemContext.currencySymbol),
        variancePercent: sqlSummary.variancePercent,
        isReconciled: sqlSummary.isReconciled,
        // ── SAP/Odoo enrichment counters ──
        movementCounts: sqlSummary.movementCounts,
        abcCounts: sqlSummary.abcCounts,
        driftCount: sqlSummary.driftCount,
        deadStockValue: sqlSummary.deadStockValue,
        deadStockValueFormatted:
          sqlSummary.deadStockValue !== undefined
            ? formatCurrency(sqlSummary.deadStockValue, systemContext.currencySymbol)
            : undefined,
      },
      recordCount: sqlSummary.totalItems,
      executionTimeMs: executionTime,
    };
  },

  /**
   * Generate Sales Report with grouping and profit analysis
   * @param pool - Database connection pool
   * @param options - Report parameters (date range, groupBy, customer, format, user)
   * @returns Sales data grouped by selected dimension with profit metrics
   *
   * Grouping Dimensions:
   * - **day**: Daily sales totals (trend analysis)
   * - **week**: Weekly aggregation (performance tracking)
   * - **month**: Monthly summaries (financial reporting)
   * - **product**: Best sellers and profitability by product
   * - **customer**: Customer purchase patterns and value
   * - **payment_method**: Payment preference analysis
   *
   * Metrics Calculated:
   * - totalSales: Revenue (sum of sale.total_amount)
   * - totalCost: COGS (sum of sale_items.unit_cost * quantity)
   * - grossProfit: totalSales - totalCost
   * - profitMargin: (grossProfit / totalSales) * 100
   * - transactionCount: Number of sales
   * - averageTransactionValue: totalSales / transactionCount
   *
   * Use Cases:
   * - Daily/weekly/monthly sales tracking
   * - Product performance analysis (ABC classification)
   * - Customer segmentation (VIP identification)
   * - Payment method trends (cash vs card vs mobile)
   * - Profit center analysis
   *
   * Performance:
   * - Date range filtering for fast queries
   * - Customer filter for account statements
   * - Execution time monitoring via report_runs
   *
   * Precision: Uses Decimal.js for financial calculations
   */
  async generateSalesReport(
    pool: Pool,
    options: {
      startDate: string;
      endDate: string;
      groupBy?: 'day' | 'week' | 'month' | 'product' | 'customer' | 'payment_method' | 'cashier' | 'category';
      customerId?: string;
      sessionId?: string;
      format?: 'json' | 'pdf' | 'csv';
      userId?: string;
    }
  ) {
    const startTime = Date.now();

    // Get system settings for report formatting
    const systemContext = await getSystemContext(pool);

    const { rows: data, summary: sqlSummary } = await reportsRepository.getSalesReport(pool, {
      startDate: options.startDate,
      endDate: options.endDate,
      groupBy: options.groupBy,
      customerId: options.customerId,
      sessionId: options.sessionId,
    });

    // Summary already computed in SQL — no JS .reduce() needed
    const executionTime = Date.now() - startTime;

    await reportsRepository.logReportRun(pool, {
      reportType: 'SALES_REPORT',
      reportName: 'Sales Report',
      parameters: options,
      generatedById: options.userId || null,
      startDate: options.startDate,
      endDate: options.endDate,
      recordCount: data.length,
      fileFormat: options.format || 'json',
      executionTimeMs: executionTime,
    });

    return {
      reportType: 'SALES_REPORT' as const,
      reportName: 'Sales Report',
      generatedAt: new Date().toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false, timeZone: 'Africa/Kampala',
      }),
      systemSettings: systemContext,
      parameters: options,
      data,
      summary: {
        totalSales: sqlSummary.totalSales,
        totalDiscounts: sqlSummary.totalDiscounts,
        netRevenue: sqlSummary.netRevenue,
        totalCost: sqlSummary.totalCost,
        grossProfit: sqlSummary.grossProfit,
        profitMargin: sqlSummary.profitMargin,
        averageDiscountRate: sqlSummary.averageDiscountRate,
        totalTransactions: sqlSummary.totalTransactions,
        totalQuantitySold: sqlSummary.totalQuantitySold ?? 0,
      },
      recordCount: data.length,
      executionTimeMs: executionTime,
    };
  },

  /**
   * Generate Expiring Items Report
   */
  async generateExpiringItems(
    pool: Pool,
    options: {
      daysAhead: number;
      categoryId?: string;
      urgencyBand?: ExpiryBandFilter;
      format?: 'json' | 'pdf' | 'csv';
      userId?: string;
    }
  ) {
    const startTime = Date.now();

    const rawData = await reportsRepository.getExpiringItems(pool, {
      daysAhead: options.daysAhead,
      categoryId: options.categoryId,
    });

    const urgencyBand: ExpiryBandFilter = options.urgencyBand || 'all';
    const data = filterExpiringRowsByBand(rawData, urgencyBand);
    const summary = summarizeExpiringItems(data);

    const executionTime = Date.now() - startTime;

    await reportsRepository.logReportRun(pool, {
      reportType: 'EXPIRING_ITEMS',
      reportName: 'Expiring Items Report',
      parameters: { ...options, urgencyBand },
      generatedById: options.userId || null,
      recordCount: data.length,
      fileFormat: options.format || 'json',
      executionTimeMs: executionTime,
    });

    return {
      reportType: 'EXPIRING_ITEMS' as const,
      reportName: 'Expiring Items Report',
      generatedAt: new Date().toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false, timeZone: 'Africa/Kampala',
      }),
      parameters: { ...options, urgencyBand },
      data,
      summary,
      recordCount: data.length,
      executionTimeMs: executionTime,
    };
  },

  /**
   * Generate Low Stock Report
   */
  async generateLowStock(
    pool: Pool,
    options: {
      threshold?: number;
      categoryId?: string;
      format?: 'json' | 'pdf' | 'csv';
      userId?: string;
    }
  ) {
    const startTime = Date.now();

    const data = await reportsRepository.getLowStockItems(pool, {
      threshold: options.threshold,
      categoryId: options.categoryId,
    });

    // Count by status
    const critical = data.filter((item) => item.status === 'CRITICAL').length;
    const low = data.filter((item) => item.status === 'LOW').length;
    const warning = data.filter((item) => item.status === 'WARNING').length;

    const executionTime = Date.now() - startTime;

    await reportsRepository.logReportRun(pool, {
      reportType: 'LOW_STOCK',
      reportName: 'Low Stock Report',
      parameters: options,
      generatedById: options.userId || null,
      recordCount: data.length,
      fileFormat: options.format || 'json',
      executionTimeMs: executionTime,
    });

    return {
      reportType: 'LOW_STOCK' as const,
      reportName: 'Low Stock Report',
      generatedAt: new Date().toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false, timeZone: 'Africa/Kampala',
      }),
      parameters: options,
      data,
      summary: {
        totalItems: data.length,
        criticalCount: critical,
        lowCount: low,
        warningCount: warning,
      },
      recordCount: data.length,
      executionTimeMs: executionTime,
    };
  },

  /**
   * Generate Best Selling Products Report
   */
  async generateBestSelling(
    pool: Pool,
    options: {
      startDate: string;
      endDate: string;
      limit: number;
      categoryId?: string;
      format?: 'json' | 'pdf' | 'csv';
      userId?: string;
    }
  ) {
    const startTime = Date.now();

    const data = await reportsRepository.getBestSellingProducts(pool, {
      startDate: options.startDate,
      endDate: options.endDate,
      limit: options.limit,
      categoryId: options.categoryId,
    });

    // Calculate summary
    const totalRevenue = data.reduce(
      (sum, item) => new Decimal(sum).plus(item.totalRevenue),
      new Decimal(0)
    );
    const totalProfit = data.reduce(
      (sum, item) => new Decimal(sum).plus(item.grossProfit),
      new Decimal(0)
    );
    const totalQuantity = data.reduce(
      (sum, item) => new Decimal(sum).plus(item.quantitySold),
      new Decimal(0)
    );

    const executionTime = Date.now() - startTime;

    await reportsRepository.logReportRun(pool, {
      reportType: 'BEST_SELLING_PRODUCTS',
      reportName: 'Best Selling Products',
      parameters: options,
      generatedById: options.userId || null,
      startDate: options.startDate,
      endDate: options.endDate,
      recordCount: data.length,
      fileFormat: options.format || 'json',
      executionTimeMs: executionTime,
    });

    return {
      reportType: 'BEST_SELLING_PRODUCTS' as const,
      reportName: 'Best Selling Products',
      generatedAt: new Date().toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false, timeZone: 'Africa/Kampala',
      }),
      parameters: options,
      data,
      summary: {
        totalProducts: data.length,
        totalRevenue: totalRevenue.toDecimalPlaces(2).toNumber(),
        totalProfit: totalProfit.toDecimalPlaces(2).toNumber(),
        totalQuantitySold: totalQuantity.toDecimalPlaces(3).toNumber(),
      },
      recordCount: data.length,
      executionTimeMs: executionTime,
    };
  },

  /**
   * Generate Supplier Cost Analysis Report
   */
  async generateSupplierCostAnalysis(
    pool: Pool,
    options: {
      startDate: string;
      endDate: string;
      supplierId?: string;
      format?: 'json' | 'pdf' | 'csv';
      userId?: string;
    }
  ) {
    const startTime = Date.now();

    const data = await reportsRepository.getSupplierCostAnalysis(pool, {
      startDate: options.startDate,
      endDate: options.endDate,
      supplierId: options.supplierId,
    });

    // Calculate summary
    const totalPurchaseValue = data.reduce(
      (sum, item) => new Decimal(sum).plus(item.totalPurchaseValue),
      new Decimal(0)
    );
    const totalPOs = data.reduce((sum, item) => sum + item.totalPurchaseOrders, 0);

    const executionTime = Date.now() - startTime;

    await reportsRepository.logReportRun(pool, {
      reportType: 'SUPPLIER_COST_ANALYSIS',
      reportName: 'Supplier Cost Analysis',
      parameters: options,
      generatedById: options.userId || null,
      startDate: options.startDate,
      endDate: options.endDate,
      recordCount: data.length,
      fileFormat: options.format || 'json',
      executionTimeMs: executionTime,
    });

    return {
      reportType: 'SUPPLIER_COST_ANALYSIS' as const,
      reportName: 'Supplier Cost Analysis',
      generatedAt: new Date().toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false, timeZone: 'Africa/Kampala',
      }),
      parameters: options,
      data,
      summary: {
        totalSuppliers: data.length,
        totalPurchaseOrders: totalPOs,
        totalPurchaseValue: totalPurchaseValue.toDecimalPlaces(2).toNumber(),
      },
      recordCount: data.length,
      executionTimeMs: executionTime,
    };
  },

  /**
   * Generate Goods Received Report
   */
  async generateGoodsReceived(
    pool: Pool,
    options: {
      startDate: string;
      endDate: string;
      supplierId?: string;
      productId?: string;
      format?: 'json' | 'pdf' | 'csv';
      userId?: string;
    }
  ) {
    const startTime = Date.now();

    const data = await reportsRepository.getGoodsReceivedReport(pool, {
      startDate: options.startDate,
      endDate: options.endDate,
      supplierId: options.supplierId,
      productId: options.productId,
    });

    // Calculate summary
    const totalValue = data.reduce(
      (sum, item) => new Decimal(sum).plus(item.totalValue),
      new Decimal(0)
    );

    const executionTime = Date.now() - startTime;

    await reportsRepository.logReportRun(pool, {
      reportType: 'GOODS_RECEIVED',
      reportName: 'Goods Received Report',
      parameters: options,
      generatedById: options.userId || null,
      startDate: options.startDate,
      endDate: options.endDate,
      recordCount: data.length,
      fileFormat: options.format || 'json',
      executionTimeMs: executionTime,
    });

    return {
      reportType: 'GOODS_RECEIVED' as const,
      reportName: 'Goods Received Report',
      generatedAt: new Date().toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false, timeZone: 'Africa/Kampala',
      }),
      parameters: options,
      data,
      summary: {
        totalReceipts: data.length,
        totalValue: totalValue.toDecimalPlaces(2).toNumber(),
      },
      recordCount: data.length,
      executionTimeMs: executionTime,
    };
  },

  /**
   * Generate Payment Report
   */
  async generatePaymentReport(
    pool: Pool,
    options: {
      startDate: string;
      endDate: string;
      paymentMethod?: string;
      format?: 'json' | 'pdf' | 'csv';
      userId?: string;
    }
  ) {
    const startTime = Date.now();

    const data = await reportsRepository.getPaymentReport(pool, {
      startDate: options.startDate,
      endDate: options.endDate,
      paymentMethod: options.paymentMethod,
    });

    // Calculate summary
    const totalAmount = data.reduce(
      (sum, item) => new Decimal(sum).plus(item.totalAmount),
      new Decimal(0)
    );
    const totalTransactions = data.reduce((sum, item) => sum + item.transactionCount, 0);

    const executionTime = Date.now() - startTime;

    await reportsRepository.logReportRun(pool, {
      reportType: 'PAYMENT_REPORT',
      reportName: 'Payment Report',
      parameters: options,
      generatedById: options.userId || null,
      startDate: options.startDate,
      endDate: options.endDate,
      recordCount: data.length,
      fileFormat: options.format || 'json',
      executionTimeMs: executionTime,
    });

    return {
      reportType: 'PAYMENT_REPORT' as const,
      reportName: 'Payment Report',
      generatedAt: new Date().toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false, timeZone: 'Africa/Kampala',
      }),
      parameters: options,
      data,
      summary: {
        totalAmount: totalAmount.toDecimalPlaces(2).toNumber(),
        totalTransactions,
        paymentMethods: data.length,
      },
      recordCount: data.length,
      executionTimeMs: executionTime,
    };
  },

  /**
   * Generate Customer Payments Report
   */
  async generateCustomerPayments(
    pool: Pool,
    options: {
      startDate: string;
      endDate: string;
      customerId?: string;
      status?: string;
      format?: 'json' | 'pdf' | 'csv';
      userId?: string;
    }
  ) {
    const startTime = Date.now();

    const { rows: data, paymentLines, summary: sqlSummary } = await reportsRepository.getCustomerPaymentsReport(pool, {
      startDate: options.startDate,
      endDate: options.endDate,
      customerId: options.customerId,
      status: options.status,
    });

    const executionTime = Date.now() - startTime;

    await reportsRepository.logReportRun(pool, {
      reportType: 'CUSTOMER_PAYMENTS',
      reportName: 'Customer Payments Report',
      parameters: options,
      generatedById: options.userId || null,
      startDate: options.startDate,
      endDate: options.endDate,
      recordCount: data.length,
      fileFormat: options.format || 'json',
      executionTimeMs: executionTime,
    });

    return {
      reportType: 'CUSTOMER_PAYMENTS' as const,
      reportName: 'Customer Payments Report',
      generatedAt: new Date().toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false, timeZone: 'Africa/Kampala',
      }),
      parameters: options,
      data,
      paymentLines,
      summary: {
        totalCustomers: data.length,
        totalInvoiced: sqlSummary.totalInvoiced,
        totalPaid: sqlSummary.totalPaid,
        totalOutstanding: sqlSummary.totalOutstanding,
        totalOverdue: sqlSummary.totalOverdue,
        totalDeposited: sqlSummary.totalDeposited,
        depositAvailable: sqlSummary.depositAvailable,
        collectionsInPeriod: sqlSummary.collectionsInPeriod,
        collectionCount: sqlSummary.collectionCount,
      },
      recordCount: data.length,
      executionTimeMs: executionTime,
    };
  },

  /**
   * Generate Profit & Loss Report
   */
  async generateProfitLoss(
    pool: Pool,
    options: {
      startDate: string;
      endDate: string;
      groupBy: 'day' | 'week' | 'month';
      format?: 'json' | 'pdf' | 'csv';
      userId?: string;
    }
  ) {
    const startTime = Date.now();

    const { rows: data, summary: sqlSummary, expenseBreakdown } = await reportsRepository.getProfitLossReport(pool, {
      startDate: options.startDate,
      endDate: options.endDate,
      groupBy: options.groupBy,
    });

    const executionTime = Date.now() - startTime;

    await reportsRepository.logReportRun(pool, {
      reportType: 'PROFIT_LOSS',
      reportName: 'Profit & Loss Report',
      parameters: options,
      generatedById: options.userId || null,
      startDate: options.startDate,
      endDate: options.endDate,
      recordCount: data.length,
      fileFormat: options.format || 'json',
      executionTimeMs: executionTime,
    });

    return {
      reportType: 'PROFIT_LOSS' as const,
      reportName: 'Profit & Loss Report',
      generatedAt: new Date().toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false, timeZone: 'Africa/Kampala',
      }),
      parameters: options,
      data,
      summary: {
        totalRevenue: sqlSummary.totalRevenue,
        totalCOGS: sqlSummary.totalCOGS,
        grossProfit: sqlSummary.grossProfit,
        grossProfitMargin: sqlSummary.grossProfitMargin,
        totalExpenses: sqlSummary.totalExpenses,
        operatingProfit: sqlSummary.operatingProfit,
        netProfit: sqlSummary.netProfit,
        netProfitMargin: sqlSummary.netProfitMargin,
        totalSupplierPayments: sqlSummary.totalSupplierPayments,
        supplierPaymentCount: sqlSummary.supplierPaymentCount,
      },
      expenseBreakdown,
      recordCount: data.length,
      executionTimeMs: executionTime,
    };
  },

  /**
   * Generate Deleted Items Report
   */
  async generateDeletedItems(
    pool: Pool,
    options: {
      startDate?: string;
      endDate?: string;
      format?: 'json' | 'pdf' | 'csv';
      userId?: string;
    }
  ) {
    const startTime = Date.now();

    const data = await reportsRepository.getDeletedItemsReport(pool, {
      startDate: options.startDate,
      endDate: options.endDate,
    });

    const executionTime = Date.now() - startTime;

    await reportsRepository.logReportRun(pool, {
      reportType: 'DELETED_ITEMS',
      reportName: 'Deleted Items Report',
      parameters: options,
      generatedById: options.userId || null,
      startDate: options.startDate || null,
      endDate: options.endDate || null,
      recordCount: data.length,
      fileFormat: options.format || 'json',
      executionTimeMs: executionTime,
    });

    return {
      reportType: 'DELETED_ITEMS' as const,
      reportName: 'Deleted Items Report',
      generatedAt: new Date().toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false, timeZone: 'Africa/Kampala',
      }),
      parameters: options,
      data,
      summary: {
        totalDeletedItems: data.length,
      },
      recordCount: data.length,
      executionTimeMs: executionTime,
    };
  },

  /**
   * Generate Inventory Adjustments Report
   */
  async generateInventoryAdjustments(
    pool: Pool,
    options: {
      startDate: string;
      endDate: string;
      productId?: string;
      format?: 'json' | 'pdf' | 'csv';
      userId?: string;
    }
  ) {
    const startTime = Date.now();

    const data = await reportsRepository.getInventoryAdjustmentsReport(pool, {
      startDate: options.startDate,
      endDate: options.endDate,
      productId: options.productId,
    });

    // Calculate summary
    const totalAdjustmentsIn = data
      .filter((item) => ['ADJUSTMENT_IN', 'RETURN_FROM_CUSTOMER'].includes(item.movementType))
      .reduce((sum, item) => new Decimal(sum).plus(Math.abs(item.quantityChange)), new Decimal(0));

    const totalAdjustmentsOut = data
      .filter((item) =>
        ['ADJUSTMENT_OUT', 'WASTE', 'DAMAGE', 'RETURN_TO_SUPPLIER'].includes(item.movementType)
      )
      .reduce((sum, item) => new Decimal(sum).plus(Math.abs(item.quantityChange)), new Decimal(0));

    const executionTime = Date.now() - startTime;

    await reportsRepository.logReportRun(pool, {
      reportType: 'INVENTORY_ADJUSTMENTS',
      reportName: 'Inventory Adjustments Report',
      parameters: options,
      generatedById: options.userId || null,
      startDate: options.startDate,
      endDate: options.endDate,
      recordCount: data.length,
      fileFormat: options.format || 'json',
      executionTimeMs: executionTime,
    });

    return {
      reportType: 'INVENTORY_ADJUSTMENTS' as const,
      reportName: 'Inventory Adjustments Report',
      generatedAt: new Date().toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false, timeZone: 'Africa/Kampala',
      }),
      parameters: options,
      data,
      summary: {
        totalAdjustments: data.length,
        totalAdjustmentsIn: totalAdjustmentsIn.toDecimalPlaces(3).toNumber(),
        totalAdjustmentsOut: totalAdjustmentsOut.toDecimalPlaces(3).toNumber(),
      },
      recordCount: data.length,
      executionTimeMs: executionTime,
    };
  },

  /**
   * Generate Purchase Order Summary Report
   */
  async generatePurchaseOrderSummary(
    pool: Pool,
    options: {
      startDate?: string;
      endDate?: string;
      status?: string;
      supplierId?: string;
      format?: 'json' | 'pdf' | 'csv';
      userId?: string;
    }
  ) {
    const startTime = Date.now();

    const data = await reportsRepository.getPurchaseOrderSummary(pool, options);

    const summary = {
      totalOrders: data.length,
      totalAmount: data
        .reduce((sum, po) => new Decimal(sum).plus(po.totalAmount || 0), new Decimal(0))
        .toDecimalPlaces(2)
        .toNumber(),
      totalReceipts: data.reduce((sum, po) => sum + (po.totalReceipts || 0), 0),
      totalReceived: data
        .reduce((sum, po) => new Decimal(sum).plus(po.totalReceived || 0), new Decimal(0))
        .toDecimalPlaces(3)
        .toNumber(),
    };

    const executionTime = Date.now() - startTime;

    await reportsRepository.logReportRun(pool, {
      reportType: 'PURCHASE_ORDER_SUMMARY',
      reportName: 'Purchase Order Summary Report',
      parameters: options,
      generatedById: options.userId || null,
      startDate: options.startDate || null,
      endDate: options.endDate || null,
      recordCount: data.length,
      fileFormat: options.format || 'json',
      executionTimeMs: executionTime,
    });

    return {
      reportType: 'PURCHASE_ORDER_SUMMARY' as const,
      reportName: 'Purchase Order Summary Report',
      generatedAt: new Date().toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false, timeZone: 'Africa/Kampala',
      }),
      parameters: options,
      data,
      summary,
      recordCount: data.length,
      executionTimeMs: executionTime,
    };
  },

  /**
   * Generate Stock Movement Analysis Report
   */
  async generateStockMovementAnalysis(
    pool: Pool,
    options: {
      startDate: string;
      endDate: string;
      productId?: string;
      movementType?: string;
      groupBy?: 'day' | 'week' | 'month' | 'product' | 'movement_type';
      format?: 'json' | 'pdf' | 'csv';
      userId?: string;
    }
  ) {
    const startTime = Date.now();

    const { rows: data, summary: sqlSummary } = await reportsRepository.getStockMovementAnalysis(pool, options);

    const summary = {
      totalTransactions: sqlSummary.totalTransactions,
      totalIn: sqlSummary.totalIn,
      totalOut: sqlSummary.totalOut,
      netMovement: sqlSummary.netMovement,
    };

    const executionTime = Date.now() - startTime;

    await reportsRepository.logReportRun(pool, {
      reportType: 'STOCK_MOVEMENT_ANALYSIS',
      reportName: 'Stock Movement Analysis Report',
      parameters: options,
      generatedById: options.userId || null,
      startDate: options.startDate,
      endDate: options.endDate,
      recordCount: data.length,
      fileFormat: options.format || 'json',
      executionTimeMs: executionTime,
    });

    return {
      reportType: 'STOCK_MOVEMENT_ANALYSIS' as const,
      reportName: 'Stock Movement Analysis Report',
      generatedAt: new Date().toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false, timeZone: 'Africa/Kampala',
      }),
      parameters: options,
      data,
      summary,
      recordCount: data.length,
      executionTimeMs: executionTime,
    };
  },

  /**
   * Generate Customer Account Statement Report
   */
  async generateCustomerAccountStatement(
    pool: Pool,
    options: {
      customerId: string;
      startDate?: string;
      endDate?: string;
      format?: 'json' | 'pdf' | 'csv';
      userId?: string;
    }
  ) {
    const startTime = Date.now();
    const startDate = options.startDate || getBusinessDate();
    const endDate = options.endDate || getBusinessDate();

    const smart = await cnDnReportService.getSmartCustomerStatementData(
      pool,
      options.customerId,
      startDate,
      endDate,
    );

    const customerRow = await pool.query(
      `SELECT id, customer_number, name, email, phone, credit_limit,
              COALESCE(balance, 0) AS balance, customer_group_id
       FROM customers WHERE id = $1`,
      [options.customerId],
    );
    const customer = customerRow.rows[0];

    let totalDebit = new Decimal(0);
    let totalCredit = new Decimal(0);
    const transactions = smart.entries.map((entry) => {
      totalDebit = totalDebit.plus(entry.debit);
      totalCredit = totalCredit.plus(entry.credit);
      return {
        saleId: entry.transactionId,
        saleNumber: entry.vchNo || entry.particulars,
        saleDate: entry.date,
        totalAmount: entry.debit,
        amountPaid: entry.credit,
        balanceDue: entry.balanceAfter ?? 0,
        paymentStatus: entry.itemStatus,
        documentType: entry.vchType,
        description: entry.particulars,
        referenceType: entry.referenceType,
        items: [{ product_name: entry.particulars, quantity: 1, unit_price: entry.debit, subtotal: entry.debit }],
      };
    });

    const data = {
      customer: {
        id: customer.id,
        customerNumber: customer.customer_number,
        name: customer.name,
        email: customer.email,
        phone: customer.phone,
        creditLimit: new Decimal(customer.credit_limit || 0).toDecimalPlaces(2).toNumber(),
        currentBalance: smart.closingBalance,
        customerGroupId: customer.customer_group_id,
      },
      transactions,
      transactionSummary: {
        openingBalance: smart.openingBalance,
        closingBalance: smart.closingBalance,
        totalTransactions: transactions.length,
        totalSales: totalDebit.toDecimalPlaces(2).toNumber(),
        totalPaid: totalCredit.toDecimalPlaces(2).toNumber(),
        totalOutstanding: smart.closingBalance,
      },
      unallocatedReceipts: smart.unallocatedReceipts,
      unallocatedReceiptsTotal: smart.unallocatedReceiptsTotal,
    };

    const summary = {
      openingBalance: smart.openingBalance,
      closingBalance: smart.closingBalance,
      totalTransactions: transactions.length,
      totalDebits: totalDebit.toDecimalPlaces(2).toNumber(),
      totalCredits: totalCredit.toDecimalPlaces(2).toNumber(),
      // Keep legacy keys for older PDF/CSV consumers
      totalSales: totalDebit.toDecimalPlaces(2).toNumber(),
      totalPaid: totalCredit.toDecimalPlaces(2).toNumber(),
      totalOutstanding: smart.closingBalance,
      unallocatedReceiptsTotal: smart.unallocatedReceiptsTotal,
      isCustomerCredit: smart.closingBalance < -0.009,
    };

    const executionTime = Date.now() - startTime;

    await reportsRepository.logReportRun(pool, {
      reportType: 'CUSTOMER_ACCOUNT_STATEMENT',
      reportName: 'Customer Account Statement',
      parameters: options,
      generatedById: options.userId || null,
      startDate,
      endDate,
      recordCount: transactions.length,
      fileFormat: options.format || 'json',
      executionTimeMs: executionTime,
    });

    return {
      reportType: 'CUSTOMER_ACCOUNT_STATEMENT' as const,
      reportName: 'Customer Account Statement',
      generatedAt: new Date().toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false, timeZone: 'Africa/Kampala',
      }),
      parameters: { ...options, startDate, endDate },
      // Flatten for ReportsPage special layout (expects top-level customer/transactions)
      customer: data.customer,
      transactions: data.transactions,
      data,
      summary,
      unallocatedReceipts: smart.unallocatedReceipts,
      unallocatedReceiptsTotal: smart.unallocatedReceiptsTotal,
      recordCount: transactions.length,
      executionTimeMs: executionTime,
    };
  },

  /**
   * Generate Profit Margin by Product Report
   */
  async generateProfitMarginByProduct(
    pool: Pool,
    options: {
      startDate?: string;
      endDate?: string;
      categoryId?: string;
      minMargin?: number;
      format?: 'json' | 'pdf' | 'csv';
      userId?: string;
    }
  ) {
    const startTime = Date.now();

    const { rows: data, summary: sqlSummary } = await reportsRepository.getProfitMarginByProduct(pool, options);

    const summary = {
      totalProducts: data.length,
      totalRevenue: sqlSummary.totalRevenue,
      totalCost: sqlSummary.totalCost,
      totalProfit: sqlSummary.totalProfit,
      averageMarginPercent: sqlSummary.averageMarginPercent,
    };

    const executionTime = Date.now() - startTime;

    await reportsRepository.logReportRun(pool, {
      reportType: 'PROFIT_MARGIN_BY_PRODUCT',
      reportName: 'Profit Margin by Product Report',
      parameters: options,
      generatedById: options.userId || null,
      startDate: options.startDate || null,
      endDate: options.endDate || null,
      recordCount: data.length,
      fileFormat: options.format || 'json',
      executionTimeMs: executionTime,
    });

    return {
      reportType: 'PROFIT_MARGIN_BY_PRODUCT' as const,
      reportName: 'Profit Margin by Product Report',
      generatedAt: new Date().toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false, timeZone: 'Africa/Kampala',
      }),
      parameters: options,
      data,
      summary,
      recordCount: data.length,
      executionTimeMs: executionTime,
    };
  },

  /**
   * Generate Enhanced Daily Cash Flow Report
   * Separates sales revenue from debt collections with bank-grade precision
   */
  async generateDailyCashFlow(
    pool: Pool,
    options: {
      startDate: string;
      endDate: string;
      paymentMethod?: string;
      format?: 'json' | 'pdf' | 'csv';
      userId?: string;
    }
  ) {
    const startTime = Date.now();

    const { rows: data, summary: sqlSummary } = await reportsRepository.getDailyCashFlow(pool, {
      ...options,
      includeDebCollections: true,
    });

    // Flat summary structure to match frontend expectations
    const summary = {
      totalDays: sqlSummary.totalDays,

      // Sales Revenue Metrics (flattened for frontend)
      salesRevenue: sqlSummary.salesRevenue,
      salesTransactionCount: sqlSummary.salesTransactionCount,
      totalSalesValue: sqlSummary.totalSalesValue,
      grossProfit: sqlSummary.grossProfit,
      overallProfitMargin: sqlSummary.overallProfitMargin,

      // Debt Collections Metrics (flattened for frontend)
      debtCollections: sqlSummary.debtCollections,
      collectionsTransactionCount: sqlSummary.collectionsTransactionCount,

      // Customer Deposit Receipts (advance payments received)
      depositReceipts: sqlSummary.depositReceipts,
      depositsTransactionCount: sqlSummary.depositsTransactionCount,

      // Combined Metrics
      totalCashIn: sqlSummary.totalCashIn,
      totalTransactions: sqlSummary.totalTransactions,

      // Revenue Composition (completely flattened for frontend)
      salesPercent: sqlSummary.totalCashIn === 0
        ? 0
        : new Decimal(sqlSummary.salesRevenue).div(sqlSummary.totalCashIn).mul(100).toDecimalPlaces(1).toNumber(),
      collectionsPercent: sqlSummary.totalCashIn === 0
        ? 0
        : new Decimal(sqlSummary.debtCollections).div(sqlSummary.totalCashIn).mul(100).toDecimalPlaces(1).toNumber(),
      depositsPercent: sqlSummary.totalCashIn === 0
        ? 0
        : new Decimal(sqlSummary.depositReceipts).div(sqlSummary.totalCashIn).mul(100).toDecimalPlaces(1).toNumber(),
      salesAmount: sqlSummary.salesRevenue,
      collectionsAmount: sqlSummary.debtCollections,
      depositsAmount: sqlSummary.depositReceipts,

      // Working Capital Impact
      creditExtended: sqlSummary.creditExtended,

      // Business Intelligence Insights
      businessInsights: [
        sqlSummary.totalCashIn > 0
          ? `Cash received ${sqlSummary.totalCashIn.toFixed(2)} across ${sqlSummary.totalTransactions} receipt(s)`
          : 'No liquid cash receipts in this period',
        ...(sqlSummary.salesRevenue > 0
          ? [`POS cash/card/mobile: ${sqlSummary.salesRevenue.toFixed(2)} (${sqlSummary.salesTransactionCount} tickets)`]
          : []),
        ...(sqlSummary.debtCollections > 0
          ? [`AR collections (Undeposited Funds): ${sqlSummary.debtCollections.toFixed(2)}`]
          : []),
        ...(sqlSummary.depositReceipts > 0
          ? [`Customer deposits (liability): ${sqlSummary.depositReceipts.toFixed(2)}`]
          : []),
        ...(sqlSummary.creditExtended > 0
          ? [`Credit extended (not cash): ${sqlSummary.creditExtended.toFixed(2)}`]
          : []),
        ...(sqlSummary.overallProfitMargin > 0
          ? [`Period sales margin ${sqlSummary.overallProfitMargin.toFixed(1)}%`]
          : []),
      ],
    };

    const executionTime = Date.now() - startTime;

    await reportsRepository.logReportRun(pool, {
      reportType: 'DAILY_CASH_FLOW',
      reportName: 'Daily Cash Flow Report',
      parameters: options,
      generatedById: options.userId || null,
      startDate: options.startDate,
      endDate: options.endDate,
      recordCount: data.length,
      fileFormat: options.format || 'json',
      executionTimeMs: executionTime,
    });

    return {
      reportType: 'DAILY_CASH_FLOW' as const,
      reportName: 'Daily Cash Flow Report',
      generatedAt: new Date().toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false, timeZone: 'Africa/Kampala',
      }),
      parameters: options,
      data,
      summary,
      recordCount: data.length,
      executionTimeMs: executionTime,
    };
  },

  /**
   * Generate Supplier Payment Status Report
   */
  async generateSupplierPaymentStatus(
    pool: Pool,
    options: {
      supplierId?: string;
      status?: 'PAID' | 'PARTIAL' | 'PENDING';
      startDate?: string;
      endDate?: string;
      format?: 'json' | 'pdf' | 'csv';
      userId?: string;
    }
  ) {
    const startTime = Date.now();

    // Fetch both supplier-level GL summary and individual payment records in parallel
    const [data, payments] = await Promise.all([
      reportsRepository.getSupplierPaymentStatus(pool, options),
      reportsRepository.getSupplierPaymentDetails(pool, {
        supplierId: options.supplierId,
        status: options.status === 'PAID' ? 'COMPLETED' : options.status,
        startDate: options.startDate,
        endDate: options.endDate,
      }),
    ]);

    const summary = {
      totalSuppliers: data.length,
      totalAmount: data
        .reduce((sum, s) => new Decimal(sum).plus(s.totalAmount), new Decimal(0))
        .toDecimalPlaces(2)
        .toNumber(),
      totalPaid: data
        .reduce((sum, s) => new Decimal(sum).plus(s.totalPaid), new Decimal(0))
        .toDecimalPlaces(2)
        .toNumber(),
      totalOutstanding: data
        .reduce((sum, s) => new Decimal(sum).plus(s.outstandingBalance), new Decimal(0))
        .toDecimalPlaces(2)
        .toNumber(),
      totalPayments: payments.length,
      totalPaymentAmount: payments
        .reduce((sum, p) => new Decimal(sum).plus(p.amount), new Decimal(0))
        .toDecimalPlaces(2)
        .toNumber(),
    };

    const executionTime = Date.now() - startTime;

    await reportsRepository.logReportRun(pool, {
      reportType: 'SUPPLIER_PAYMENT_STATUS',
      reportName: 'Supplier Payment Status Report',
      parameters: options,
      generatedById: options.userId || null,
      startDate: options.startDate || null,
      endDate: options.endDate || null,
      recordCount: data.length,
      fileFormat: options.format || 'json',
      executionTimeMs: executionTime,
    });

    return {
      reportType: 'SUPPLIER_PAYMENT_STATUS' as const,
      reportName: 'Supplier Payment Status Report',
      generatedAt: new Date().toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false, timeZone: 'Africa/Kampala',
      }),
      parameters: options,
      data,
      payments,
      summary,
      recordCount: data.length,
      executionTimeMs: executionTime,
    };
  },

  /**
   * Generate Top Customers Report
   */
  async generateTopCustomers(
    pool: Pool,
    options: {
      startDate: string;
      endDate: string;
      limit?: number;
      sortBy?: 'REVENUE' | 'ORDERS' | 'PROFIT';
      format?: 'json' | 'pdf' | 'csv';
      userId?: string;
    }
  ) {
    const startTime = Date.now();

    const data = await reportsRepository.getTopCustomers(pool, options);

    const summary = {
      totalCustomers: data.length,
      totalRevenue: data
        .reduce((sum, c) => new Decimal(sum).plus(c.totalRevenue), new Decimal(0))
        .toDecimalPlaces(2)
        .toNumber(),
      totalPurchases: data.reduce((sum, c) => sum + c.totalPurchases, 0),
      averageOrderValue:
        data.length > 0
          ? new Decimal(
            data.reduce((sum, c) => new Decimal(sum).plus(c.totalRevenue), new Decimal(0))
          )
            .div(data.reduce((sum, c) => sum + c.totalPurchases, 0))
            .toDecimalPlaces(2)
            .toNumber()
          : 0,
    };

    const executionTime = Date.now() - startTime;

    await reportsRepository.logReportRun(pool, {
      reportType: 'TOP_CUSTOMERS',
      reportName: 'Top Customers Report',
      parameters: options,
      generatedById: options.userId || null,
      startDate: options.startDate,
      endDate: options.endDate,
      recordCount: data.length,
      fileFormat: options.format || 'json',
      executionTimeMs: executionTime,
    });

    return {
      reportType: 'TOP_CUSTOMERS' as const,
      reportName: 'Top Customers Report',
      generatedAt: new Date().toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false, timeZone: 'Africa/Kampala',
      }),
      parameters: options,
      data,
      summary,
      recordCount: data.length,
      executionTimeMs: executionTime,
    };
  },

  /**
   * Generate Customer Aging Report
   */
  async generateCustomerAging(
    pool: Pool,
    options: {
      asOfDate?: Date | string;
      format?: 'json' | 'pdf' | 'csv';
      userId?: string;
    }
  ) {
    const startTime = Date.now();

    const { rows: data, summary: sqlSummary } = await reportsRepository.getCustomerAging(pool, {
      asOfDate: options.asOfDate,
    });

    const summary = {
      totalCustomers: data.length,
      totalOutstanding: sqlSummary.totalOutstanding,
      current: sqlSummary.current,
      days30: sqlSummary.days30,
      days60: sqlSummary.days60,
      days90: sqlSummary.days90,
      over90: sqlSummary.over90,
      overdueAmount: sqlSummary.overdueAmount,
      unallocatedCredits: sqlSummary.unallocatedCredits,
      grossOpenItems: sqlSummary.grossOpenItems,
    };

    const executionTime = Date.now() - startTime;

    await reportsRepository.logReportRun(pool, {
      reportType: 'CUSTOMER_AGING',
      reportName: 'Customer Aging Report',
      parameters: options,
      generatedById: options.userId || null,
      startDate: null,
      endDate: null,
      recordCount: data.length,
      fileFormat: options.format || 'json',
      executionTimeMs: executionTime,
    });

    return {
      reportType: 'CUSTOMER_AGING' as const,
      reportName: 'Customer Aging Report',
      generatedAt: new Date().toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false, timeZone: 'Africa/Kampala',
      }),
      parameters: options,
      data,
      summary,
      recordCount: data.length,
      executionTimeMs: executionTime,
    };
  },

  /**
   * Generate Stock Aging Report
   */
  async generateStockAging(
    pool: Pool,
    options: {
      asOfDate?: Date | string;
      categoryId?: string;
      format?: 'json' | 'pdf' | 'csv';
      userId?: string;
    }
  ) {
    const startTime = Date.now();

    const data = await reportsRepository.getStockAging(pool, options);

    const summary = {
      totalBatches: data.length,
      totalValue: data
        .reduce((sum, b) => new Decimal(sum).plus(b.totalValue), new Decimal(0))
        .toDecimalPlaces(2)
        .toNumber(),
      averageDaysInStock:
        data.length > 0
          ? Math.round(data.reduce((sum, b) => sum + b.daysInStock, 0) / data.length)
          : 0,
      oldestBatchDays: data.length > 0 ? Math.max(...data.map((b) => b.daysInStock)) : 0,
    };

    const executionTime = Date.now() - startTime;

    await reportsRepository.logReportRun(pool, {
      reportType: 'STOCK_AGING',
      reportName: 'Stock Aging Report',
      parameters: options,
      generatedById: options.userId || null,
      startDate: null,
      endDate: null,
      recordCount: data.length,
      fileFormat: options.format || 'json',
      executionTimeMs: executionTime,
    });

    return {
      reportType: 'STOCK_AGING' as const,
      reportName: 'Stock Aging Report',
      generatedAt: new Date().toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false, timeZone: 'Africa/Kampala',
      }),
      parameters: options,
      data,
      summary,
      recordCount: data.length,
      executionTimeMs: executionTime,
    };
  },

  /**
   * Generate Waste & Damage Report
   */
  async generateWasteDamageReport(
    pool: Pool,
    options: {
      startDate: string;
      endDate: string;
      productId?: string;
      reason?: 'DAMAGE' | 'EXPIRY' | 'THEFT' | 'OTHER';
      format?: 'json' | 'pdf' | 'csv';
      userId?: string;
    }
  ) {
    const startTime = Date.now();

    const data = await reportsRepository.getWasteDamageReport(pool, options);

    const summary = {
      totalLossEvents: data.length,
      totalQuantityLost: data
        .reduce((sum, l) => new Decimal(sum).plus(l.quantityLost), new Decimal(0))
        .toDecimalPlaces(3)
        .toNumber(),
      totalLossValue: data
        .reduce((sum, l) => new Decimal(sum).plus(l.totalLossValue), new Decimal(0))
        .toDecimalPlaces(2)
        .toNumber(),
      damageCount: data.filter((l) => l.lossType === 'DAMAGE').length,
      expiryCount: data.filter((l) => l.lossType === 'EXPIRY').length,
    };

    const executionTime = Date.now() - startTime;

    await reportsRepository.logReportRun(pool, {
      reportType: 'WASTE_DAMAGE_REPORT',
      reportName: 'Waste & Damage Report',
      parameters: options,
      generatedById: options.userId || null,
      startDate: options.startDate,
      endDate: options.endDate,
      recordCount: data.length,
      fileFormat: options.format || 'json',
      executionTimeMs: executionTime,
    });

    return {
      reportType: 'WASTE_DAMAGE_REPORT' as const,
      reportName: 'Waste & Damage Report',
      generatedAt: new Date().toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false, timeZone: 'Africa/Kampala',
      }),
      parameters: options,
      data,
      summary,
      recordCount: data.length,
      executionTimeMs: executionTime,
    };
  },

  /**
   * Generate Reorder Dashboard — Business-driven decision engine
   * Groups products by priority (full lists for PO selection), calculates summaries
   */
  async generateReorderDashboard(
    pool: Pool,
    options: { category?: string }
  ) {
    const startTime = Date.now();
    const allItems = await reportsRepository.getReorderDashboard(pool, options);

    // Group by priority
    const urgent = allItems
      .filter((i) => i.priority === 'URGENT')
      .sort((a, b) => (a.daysUntilStockout ?? -1) - (b.daysUntilStockout ?? -1));

    const high = allItems
      .filter((i) => i.priority === 'HIGH')
      .sort((a, b) => (a.daysUntilStockout ?? 9999) - (b.daysUntilStockout ?? 9999));

    const deadStock = allItems
      .filter((i) => i.priority === 'DEAD_STOCK')
      .sort((a, b) => {
        const aVal = (a.currentStock) * (a.costPrice ?? 0);
        const bVal = (b.currentStock) * (b.costPrice ?? 0);
        return bVal - aVal; // highest value first
      });

    const medium = allItems
      .filter((i) => i.priority === 'MEDIUM')
      .sort((a, b) => (a.daysUntilStockout ?? 9999) - (b.daysUntilStockout ?? 9999));

    const summary = buildReorderDashboardSummary(urgent, high, medium, deadStock);

    return {
      summary,
      urgent,
      high,
      deadStock,
      medium,
      executionTimeMs: Date.now() - startTime,
    };
  },

  /**
   * Selected lines for reorder dashboard PDF (before PO creation).
   */
  async getReorderDashboardExportLines(
    pool: Pool,
    options: { productIds: string[]; category?: string }
  ): Promise<ReorderDashboardItem[]> {
    const idSet = new Set(options.productIds);
    if (idSet.size === 0) return [];
    const allItems = await reportsRepository.getReorderDashboard(pool, {
      category: options.category,
    });
    const byId = new Map(allItems.map((i) => [i.productId, i]));
    return options.productIds
      .map((id) => byId.get(id))
      .filter((i): i is ReorderDashboardItem => i != null);
  },

  /**
   * Generate Reorder Recommendations Report
   */
  async generateReorderRecommendations(
    pool: Pool,
    options: {
      categoryId?: string;
      daysToConsider?: number;
      format?: 'json' | 'pdf' | 'csv';
      userId?: string;
    }
  ) {
    const startTime = Date.now();

    const data = await reportsRepository.getReorderRecommendations(pool, {
      categoryId: options.categoryId,
      daysToAnalyze: options.daysToConsider,
    });

    const summary = {
      totalProductsNeedingReorder: data.length,
      urgentCount: data.filter((p) => p.priority === 'URGENT').length,
      highCount: data.filter((p) => p.priority === 'HIGH').length,
      mediumCount: data.filter((p) => p.priority === 'MEDIUM').length,
      totalEstimatedCost: data
        .reduce((sum, p) => new Decimal(sum).plus(p.estimatedOrderCost), new Decimal(0))
        .toDecimalPlaces(2)
        .toNumber(),
      trendingUp: data.filter((p) => p.demandTrend === 'INCREASING').length,
      trendingDown: data.filter((p) => p.demandTrend === 'DECREASING').length,
      avgLeadTimeDays:
        data.length > 0
          ? new Decimal(data.reduce((sum, p) => sum + p.leadTimeDays, 0))
            .dividedBy(data.length)
            .toDecimalPlaces(1)
            .toNumber()
          : 0,
    };

    const executionTime = Date.now() - startTime;

    await reportsRepository.logReportRun(pool, {
      reportType: 'REORDER_RECOMMENDATIONS',
      reportName: 'Reorder Recommendations Report',
      parameters: options,
      generatedById: options.userId || null,
      startDate: null,
      endDate: null,
      recordCount: data.length,
      fileFormat: options.format || 'json',
      executionTimeMs: executionTime,
    });

    return {
      reportType: 'REORDER_RECOMMENDATIONS' as const,
      reportName: 'Reorder Recommendations Report',
      generatedAt: new Date().toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false, timeZone: 'Africa/Kampala',
      }),
      parameters: options,
      data,
      summary,
      recordCount: data.length,
      executionTimeMs: executionTime,
    };
  },

  /**
   * Generate Sales by Category Report
   */
  async generateSalesByCategory(
    pool: Pool,
    options: {
      startDate: string;
      endDate: string;
      category?: string;
      format?: 'pdf' | 'csv' | 'json';
      userId?: string;
    }
  ) {
    const startTime = Date.now();
    const data = await reportsRepository.getSalesByCategory(pool, options);
    const executionTime = Date.now() - startTime;

    const summary = {
      totalCategories: data.length,
      totalRevenue: data
        .reduce((sum: Decimal, item) => sum.plus(item.totalRevenue), new Decimal(0))
        .toDecimalPlaces(2)
        .toNumber(),
      totalProfit: data
        .reduce((sum: Decimal, item) => sum.plus(item.grossProfit), new Decimal(0))
        .toDecimalPlaces(2)
        .toNumber(),
      totalTransactions: data.reduce((sum, item) => sum + item.transactionCount, 0),
      topCategory: data.length > 0 ? data[0].category : null,
    };

    // Audit logging handled by controller layer

    return {
      reportType: 'SALES_BY_CATEGORY' as const,
      reportName: 'Sales by Category Report',
      generatedAt: new Date().toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false, timeZone: 'Africa/Kampala',
      }),
      parameters: options,
      data,
      summary,
      recordCount: data.length,
      executionTimeMs: executionTime,
    };
  },

  /**
   * Generate Sales by Payment Method Report
   */
  async generateSalesByPaymentMethod(
    pool: Pool,
    options: {
      startDate: string;
      endDate: string;
      format?: 'pdf' | 'csv' | 'json';
      userId?: string;
    }
  ) {
    const startTime = Date.now();
    const data = await reportsRepository.getSalesByPaymentMethod(pool, options);
    const executionTime = Date.now() - startTime;

    const summary = {
      totalPaymentMethods: data.length,
      totalRevenue: data
        .reduce((sum: Decimal, item) => sum.plus(item.totalRevenue), new Decimal(0))
        .toDecimalPlaces(2)
        .toNumber(),
      totalTransactions: data.reduce((sum, item) => sum + item.transactionCount, 0),
      topPaymentMethod: data.length > 0 ? data[0].paymentMethod : null,
    };

    // Audit logging handled by controller layer

    return {
      reportType: 'SALES_BY_PAYMENT_METHOD' as const,
      reportName: 'Sales by Payment Method Report',
      generatedAt: new Date().toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false, timeZone: 'Africa/Kampala',
      }),
      parameters: options,
      data,
      summary,
      recordCount: data.length,
      executionTimeMs: executionTime,
    };
  },

  /**
   * Generate Hourly Sales Analysis Report
   */
  async generateHourlySalesAnalysis(
    pool: Pool,
    options: {
      startDate: string;
      endDate: string;
      format?: 'pdf' | 'csv' | 'json';
      userId?: string;
    }
  ) {
    const startTime = Date.now();
    const data = await reportsRepository.getHourlySalesAnalysis(pool, options);
    const executionTime = Date.now() - startTime;

    const peakHour =
      data.length > 0
        ? data.reduce((max, item) => (item.totalRevenue > max.totalRevenue ? item : max))
        : null;

    const summary = {
      totalHours: data.length,
      totalRevenue: data
        .reduce((sum: Decimal, item) => sum.plus(item.totalRevenue), new Decimal(0))
        .toDecimalPlaces(2)
        .toNumber(),
      totalTransactions: data.reduce((sum, item) => sum + item.transactionCount, 0),
      peakHour: peakHour?.hour,
      peakHourRevenue: peakHour?.totalRevenue || 0,
    };

    // Audit logging handled by controller layer

    return {
      reportType: 'HOURLY_SALES_ANALYSIS' as const,
      reportName: 'Hourly Sales Analysis Report',
      generatedAt: new Date().toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false, timeZone: 'Africa/Kampala',
      }),
      parameters: options,
      data,
      summary,
      recordCount: data.length,
      executionTimeMs: executionTime,
    };
  },

  /**
   * Generate Sales Comparison Report
   */
  async generateSalesComparison(
    pool: Pool,
    options: {
      currentStartDate: string;
      currentEndDate: string;
      previousStartDate: string;
      previousEndDate: string;
      groupBy: 'day' | 'week' | 'month';
      format?: 'pdf' | 'csv' | 'json';
      userId?: string;
    }
  ) {
    const startTime = Date.now();
    const data = await reportsRepository.getSalesComparison(pool, options);
    const executionTime = Date.now() - startTime;

    const summary = summarizeSalesComparison(data);

    // Audit logging handled by controller layer

    return {
      reportType: 'SALES_COMPARISON' as const,
      reportName: 'Sales Comparison Report',
      generatedAt: new Date().toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false, timeZone: 'Africa/Kampala',
      }),
      parameters: options,
      data,
      summary,
      recordCount: data.length,
      executionTimeMs: executionTime,
    };
  },

  /**
   * Generate Customer Purchase History Report
   */
  async generateCustomerPurchaseHistory(
    pool: Pool,
    options: {
      customerId: string;
      startDate: string;
      endDate: string;
      format?: 'pdf' | 'csv' | 'json';
      userId?: string;
    }
  ) {
    const startTime = Date.now();
    const data = await reportsRepository.getCustomerPurchaseHistory(pool, options);
    const executionTime = Date.now() - startTime;

    const summary = {
      totalPurchases: data.length,
      totalSpent: data
        .reduce((sum: Decimal, item) => sum.plus(item.totalAmount), new Decimal(0))
        .toDecimalPlaces(2)
        .toNumber(),
      totalPaid: data
        .reduce((sum: Decimal, item) => sum.plus(item.amountPaid), new Decimal(0))
        .toDecimalPlaces(2)
        .toNumber(),
      totalOutstanding: data
        .reduce((sum: Decimal, item) => sum.plus(item.outstandingBalance), new Decimal(0))
        .toDecimalPlaces(2)
        .toNumber(),
      averagePurchaseValue:
        data.length > 0
          ? data
            .reduce((sum: Decimal, item) => sum.plus(item.totalAmount), new Decimal(0))
            .dividedBy(data.length)
            .toDecimalPlaces(2)
            .toNumber()
          : 0,
    };

    // Audit logging handled by controller layer

    return {
      reportType: 'CUSTOMER_PURCHASE_HISTORY' as const,
      reportName: 'Customer Purchase History Report',
      generatedAt: new Date().toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false, timeZone: 'Africa/Kampala',
      }),
      parameters: options,
      data,
      summary,
      recordCount: data.length,
      executionTimeMs: executionTime,
    };
  },

  /**
   * Generate Comprehensive Business Position Report
   * Advanced business health assessment with bank-grade precision
   */
  async generateBusinessPositionReport(
    pool: Pool,
    options: {
      reportDate: string;
      includeComparisons?: boolean;
      includeForecasts?: boolean;
      format?: 'json' | 'pdf' | 'csv';
      userId?: string;
    }
  ) {
    const startTime = Date.now();

    const data = await reportsRepository.getBusinessPositionReport(pool, {
      reportDate: options.reportDate,
      includeComparisons: options.includeComparisons,
      includeForecasts: options.includeForecasts,
    });

    // Advanced business intelligence calculations with bank-grade precision
    const enhancedAnalysis = {
      // Liquidity Ratios (Bank-grade analysis)
      liquidityMetrics: {
        currentRatio:
          data.cashPosition.totalCashIn > 0
            ? new Decimal(data.cashPosition.totalCashIn)
              .div(Math.max(data.cashPosition.newCreditExtended, 1))
              .toDecimalPlaces(2)
              .toNumber()
            : 0,
        quickRatio:
          data.cashPosition.totalCashIn > 0
            ? new Decimal(data.cashPosition.totalCashIn)
              .div(Math.max(data.cashPosition.outstandingReceivables, 1))
              .toDecimalPlaces(2)
              .toNumber()
            : 0,
        cashTurnoverRatio:
          data.salesPerformance.totalRevenue > 0
            ? new Decimal(data.cashPosition.totalCashIn)
              .div(data.salesPerformance.totalRevenue)
              .toDecimalPlaces(2)
              .toNumber()
            : 0,
      },

      // Profitability Analysis
      profitabilityMetrics: {
        grossProfitMargin: data.cashPosition.profitMarginPercent,
        netProfitRatio:
          data.salesPerformance.totalRevenue > 0
            ? new Decimal(data.salesPerformance.grossProfit)
              .div(data.salesPerformance.totalRevenue)
              .mul(100)
              .toDecimalPlaces(2)
              .toNumber()
            : 0,
        returnOnSales:
          data.salesPerformance.totalRevenue > 0
            ? new Decimal(data.salesPerformance.grossProfit)
              .div(data.salesPerformance.totalRevenue)
              .mul(100)
              .toDecimalPlaces(2)
              .toNumber()
            : 0,
      },

      // Efficiency Metrics
      efficiencyMetrics: {
        assetTurnover:
          data.inventoryHealth.inventoryValue > 0
            ? new Decimal(data.salesPerformance.totalRevenue)
              .div(data.inventoryHealth.inventoryValue)
              .toDecimalPlaces(2)
              .toNumber()
            : 0,
        inventoryTurnover:
          data.inventoryHealth.inventoryValue > 0
            ? new Decimal(data.salesPerformance.totalCost)
              .div(data.inventoryHealth.inventoryValue)
              .toDecimalPlaces(2)
              .toNumber()
            : 0,
        receivablesToSalesRatio:
          data.salesPerformance.totalRevenue > 0
            ? new Decimal(data.customerMetrics.totalReceivables)
              .div(data.salesPerformance.totalRevenue)
              .mul(100)
              .toDecimalPlaces(2)
              .toNumber()
            : 0,
      },

      // Customer Analytics
      customerInsights: {
        customerRetentionIndicator:
          data.customerMetrics.totalCustomers > 0
            ? new Decimal(data.salesPerformance.uniqueCustomers)
              .div(data.customerMetrics.totalCustomers)
              .mul(100)
              .toDecimalPlaces(2)
              .toNumber()
            : 0,
        averageCustomerValue:
          data.salesPerformance.uniqueCustomers > 0
            ? new Decimal(data.salesPerformance.totalRevenue)
              .div(data.salesPerformance.uniqueCustomers)
              .toDecimalPlaces(2)
              .toNumber()
            : 0,
        creditUtilizationRate:
          data.customerMetrics.totalCustomers > 0
            ? new Decimal(data.customerMetrics.customersWithBalance)
              .div(data.customerMetrics.totalCustomers)
              .mul(100)
              .toDecimalPlaces(2)
              .toNumber()
            : 0,
      },

      // Risk Assessment (Advanced)
      riskMetrics: {
        concentrationRisk:
          data.salesPerformance.customerRevenue > 0
            ? new Decimal(data.salesPerformance.customerRevenue)
              .div(data.salesPerformance.totalRevenue)
              .mul(100)
              .toDecimalPlaces(2)
              .toNumber()
            : 0,
        badDebtRisk:
          data.customerMetrics.totalReceivables > 0
            ? new Decimal(data.customerMetrics.totalReceivables)
              .div(Math.max(data.salesPerformance.totalRevenue * 30, 1)) // 30 days of sales
              .mul(100)
              .toDecimalPlaces(2)
              .toNumber()
            : 0,
        inventoryObsolescenceRisk:
          data.inventoryHealth.totalProducts > 0
            ? new Decimal(data.inventoryHealth.lowStockItems + data.inventoryHealth.expiringUnits)
              .div(data.inventoryHealth.totalProducts)
              .mul(100)
              .toDecimalPlaces(2)
              .toNumber()
            : 0,
      },

      // Performance Benchmarks
      performanceBenchmarks: {
        dailyRevenueTarget: 10000, // Configurable business target
        profitMarginTarget: 25, // Configurable business target
        inventoryTurnoverTarget: 12, // Configurable business target
        collectionEfficiencyTarget: 85, // Configurable business target
      },

      // Recommendations (AI-driven insights)
      recommendations: (() => {
        const recommendations = [];

        if (data.cashPosition.cashCollectionRate < 70) {
          recommendations.push({
            priority: 'HIGH',
            category: 'CASH_FLOW',
            message:
              'Cash collection rate is below 70%. Consider tightening credit terms or implementing automated collection processes.',
            impact: 'FINANCIAL',
          });
        }

        if (data.cashPosition.profitMarginPercent < 15) {
          recommendations.push({
            priority: 'HIGH',
            category: 'PROFITABILITY',
            message: 'Profit margin is below 15%. Review pricing strategy and cost management.',
            impact: 'PROFITABILITY',
          });
        }

        if (data.inventoryHealth.lowStockItems > data.inventoryHealth.totalProducts * 0.2) {
          recommendations.push({
            priority: 'MEDIUM',
            category: 'INVENTORY',
            message:
              'Over 20% of products are low stock. Review reorder points and supplier lead times.',
            impact: 'OPERATIONAL',
          });
        }

        if (data.customerMetrics.newCustomers30d < data.customerMetrics.totalCustomers * 0.1) {
          recommendations.push({
            priority: 'MEDIUM',
            category: 'GROWTH',
            message:
              'Customer acquisition rate is low. Consider marketing initiatives to attract new customers.',
            impact: 'GROWTH',
          });
        }

        if (data.riskAssessment.overallRiskLevel === 'HIGH') {
          recommendations.push({
            priority: 'URGENT',
            category: 'RISK_MANAGEMENT',
            message:
              'Overall business risk is HIGH. Immediate attention required for risk mitigation.',
            impact: 'STRATEGIC',
          });
        }

        return recommendations;
      })(),
    };

    const executionTime = Date.now() - startTime;

    // Log report generation
    await reportsRepository.logReportRun(pool, {
      reportType: 'BUSINESS_POSITION',
      reportName: 'Comprehensive Business Position Report',
      parameters: options,
      generatedById: options.userId || null,
      startDate: options.reportDate,
      endDate: options.reportDate,
      recordCount: 1,
      fileFormat: options.format || 'json',
      executionTimeMs: executionTime,
    });

    return {
      reportType: 'BUSINESS_POSITION' as const,
      reportName: 'Comprehensive Business Position Report',
      generatedAt: new Date().toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false, timeZone: 'Africa/Kampala',
      }),
      parameters: options,
      data: {
        ...data,
        enhancedAnalysis,
      },
      summary: {
        businessHealthScore: data.businessHealthScore,
        overallRiskLevel: data.riskAssessment.overallRiskLevel,
        keyMetrics: {
          totalRevenue: data.salesPerformance.totalRevenue,
          grossProfit: data.salesPerformance.grossProfit,
          totalCashIn: data.cashPosition.totalCashIn,
          outstandingReceivables: data.cashPosition.outstandingReceivables,
          inventoryValue: data.inventoryHealth.inventoryValue,
        },
        criticalAlerts: enhancedAnalysis.recommendations.filter(
          (r) => r.priority === 'URGENT' || r.priority === 'HIGH'
        ).length,
      },
      recordCount: 1,
      executionTimeMs: executionTime,
    };
  },

  // ── Delivery Notes Report ──
  async generateDeliveryNoteReport(pool: Pool, options: {
    startDate: string; endDate: string;
    customerId?: string; status?: string;
    format?: 'json' | 'pdf' | 'csv'; userId?: string;
  }) {
    const startTime = Date.now();

    const data = await reportsRepository.getDeliveryNoteReport(pool, {
      startDate: options.startDate,
      endDate: options.endDate,
      customerId: options.customerId,
      status: options.status,
    });

    const totalValue = data.reduce(
      (sum, item) => new Decimal(sum).plus(item.totalAmount), new Decimal(0)
    );
    const postedCount = data.filter(d => d.status === 'POSTED').length;
    const draftCount = data.filter(d => d.status === 'DRAFT').length;

    const executionTime = Date.now() - startTime;

    await reportsRepository.logReportRun(pool, {
      reportType: 'DELIVERY_NOTES', reportName: 'Delivery Notes Report',
      parameters: options, generatedById: options.userId || null,
      startDate: options.startDate, endDate: options.endDate,
      recordCount: data.length, fileFormat: options.format || 'json',
      executionTimeMs: executionTime,
    });

    return {
      reportType: 'DELIVERY_NOTES' as const,
      reportName: 'Delivery Notes Report',
      generatedAt: new Date().toLocaleString('en-US', {
        year: 'numeric', month: 'short', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Africa/Kampala',
      }),
      parameters: options,
      data,
      summary: {
        totalDeliveryNotes: data.length,
        totalValue: totalValue.toDecimalPlaces(2).toNumber(),
        postedCount,
        draftCount,
      },
      recordCount: data.length,
      executionTimeMs: executionTime,
    };
  },

  // ── Quotation Report ──
  async generateQuotationReport(pool: Pool, options: {
    startDate: string; endDate: string;
    customerId?: string; status?: string; quoteType?: string;
    format?: 'json' | 'pdf' | 'csv'; userId?: string;
  }) {
    const startTime = Date.now();

    const data = await reportsRepository.getQuotationReport(pool, {
      startDate: options.startDate,
      endDate: options.endDate,
      customerId: options.customerId,
      status: options.status,
      quoteType: options.quoteType,
    });

    const totalValue = data.reduce(
      (sum, item) => new Decimal(sum).plus(item.totalAmount), new Decimal(0)
    );
    const convertedCount = data.filter(d => d.status === 'CONVERTED').length;
    const conversionRate = data.length > 0
      ? new Decimal(convertedCount).div(data.length).times(100).toDecimalPlaces(1).toNumber()
      : 0;

    const executionTime = Date.now() - startTime;

    await reportsRepository.logReportRun(pool, {
      reportType: 'QUOTATIONS', reportName: 'Quotation Report',
      parameters: options, generatedById: options.userId || null,
      startDate: options.startDate, endDate: options.endDate,
      recordCount: data.length, fileFormat: options.format || 'json',
      executionTimeMs: executionTime,
    });

    return {
      reportType: 'QUOTATIONS' as const,
      reportName: 'Quotation Report',
      generatedAt: new Date().toLocaleString('en-US', {
        year: 'numeric', month: 'short', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Africa/Kampala',
      }),
      parameters: options,
      data,
      summary: {
        totalQuotations: data.length,
        totalValue: totalValue.toDecimalPlaces(2).toNumber(),
        convertedCount,
        conversionRate,
        statusBreakdown: Object.fromEntries(
          ['DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'CONVERTED', 'CANCELLED']
            .map(s => [s, data.filter(d => d.status === s).length])
            .filter(([, v]) => (v as number) > 0)
        ),
      },
      recordCount: data.length,
      executionTimeMs: executionTime,
    };
  },

  // ── Manual Journal Entry Report ──
  async generateManualJournalEntryReport(pool: Pool, options: {
    startDate: string; endDate: string;
    status?: string;
    format?: 'json' | 'pdf' | 'csv'; userId?: string;
  }) {
    const startTime = Date.now();

    const data = await reportsRepository.getManualJournalEntryReport(pool, {
      startDate: options.startDate,
      endDate: options.endDate,
      status: options.status,
    });

    const totalDebit = data.reduce(
      (sum, item) => new Decimal(sum).plus(item.totalDebit), new Decimal(0)
    );
    const totalCredit = data.reduce(
      (sum, item) => new Decimal(sum).plus(item.totalCredit), new Decimal(0)
    );

    const executionTime = Date.now() - startTime;

    await reportsRepository.logReportRun(pool, {
      reportType: 'MANUAL_JOURNAL_ENTRIES', reportName: 'Manual Journal Entries Report',
      parameters: options, generatedById: options.userId || null,
      startDate: options.startDate, endDate: options.endDate,
      recordCount: data.length, fileFormat: options.format || 'json',
      executionTimeMs: executionTime,
    });

    return {
      reportType: 'MANUAL_JOURNAL_ENTRIES' as const,
      reportName: 'Manual Journal Entries Report',
      generatedAt: new Date().toLocaleString('en-US', {
        year: 'numeric', month: 'short', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Africa/Kampala',
      }),
      parameters: options,
      data,
      summary: {
        totalEntries: data.length,
        totalDebit: totalDebit.toDecimalPlaces(2).toNumber(),
        totalCredit: totalCredit.toDecimalPlaces(2).toNumber(),
        postedCount: data.filter(d => d.status === 'POSTED').length,
        reversedCount: data.filter(d => d.status === 'REVERSED').length,
      },
      recordCount: data.length,
      executionTimeMs: executionTime,
    };
  },

  // ── Bank Transaction Report ──
  async generateBankTransactionReport(pool: Pool, options: {
    startDate: string; endDate: string;
    bankAccountId?: string; type?: string; isReconciled?: boolean;
    format?: 'json' | 'pdf' | 'csv'; userId?: string;
  }) {
    const startTime = Date.now();

    const data = await reportsRepository.getBankTransactionReport(pool, {
      startDate: options.startDate,
      endDate: options.endDate,
      bankAccountId: options.bankAccountId,
      type: options.type,
      isReconciled: options.isReconciled,
    });

    const totalDeposits = data
      .filter(d => ['DEPOSIT', 'TRANSFER_IN', 'INTEREST'].includes(d.type))
      .reduce((sum, d) => new Decimal(sum).plus(d.amount), new Decimal(0));
    const totalWithdrawals = data
      .filter(d => ['WITHDRAWAL', 'TRANSFER_OUT', 'FEE'].includes(d.type))
      .reduce((sum, d) => new Decimal(sum).plus(d.amount), new Decimal(0));
    const reconciledCount = data.filter(d => d.isReconciled).length;

    const executionTime = Date.now() - startTime;

    await reportsRepository.logReportRun(pool, {
      reportType: 'BANK_TRANSACTIONS', reportName: 'Bank Transactions Report',
      parameters: options, generatedById: options.userId || null,
      startDate: options.startDate, endDate: options.endDate,
      recordCount: data.length, fileFormat: options.format || 'json',
      executionTimeMs: executionTime,
    });

    return {
      reportType: 'BANK_TRANSACTIONS' as const,
      reportName: 'Bank Transactions Report',
      generatedAt: new Date().toLocaleString('en-US', {
        year: 'numeric', month: 'short', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Africa/Kampala',
      }),
      parameters: options,
      data,
      summary: {
        totalTransactions: data.length,
        totalDeposits: totalDeposits.toDecimalPlaces(2).toNumber(),
        totalWithdrawals: totalWithdrawals.toDecimalPlaces(2).toNumber(),
        netFlow: totalDeposits.minus(totalWithdrawals).toDecimalPlaces(2).toNumber(),
        reconciledCount,
        unreconciledCount: data.length - reconciledCount,
      },
      recordCount: data.length,
      executionTimeMs: executionTime,
    };
  },

  // ── Void Sales Report ──
  async generateVoidSalesReport(
    pool: Pool,
    options: {
      startDate: string;
      endDate: string;
      format?: 'json' | 'pdf' | 'csv';
      userId?: string;
    }
  ) {
    const startTime = Date.now();
    const systemContext = await getSystemContext(pool);

    const { rows: data, summary, byReason } = await reportsRepository.getVoidSalesReport(pool, {
      startDate: options.startDate,
      endDate: options.endDate,
    });

    const executionTime = Date.now() - startTime;

    await reportsRepository.logReportRun(pool, {
      reportType: 'VOID_SALES_REPORT',
      reportName: 'Void Sales Report',
      parameters: options,
      generatedById: options.userId || null,
      startDate: options.startDate,
      endDate: options.endDate,
      recordCount: data.length,
      fileFormat: options.format || 'json',
      executionTimeMs: executionTime,
    });

    return {
      reportType: 'VOID_SALES_REPORT' as const,
      reportName: 'Void Sales Report',
      generatedAt: new Date().toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false, timeZone: 'Africa/Kampala',
      }),
      systemSettings: systemContext,
      parameters: options,
      data,
      byReason,
      // Numeric SSOT only — UI/PDF format currency (no duplicate *Formatted dump fields)
      summary: {
        voidedSaleCount: summary.voidedSaleCount,
        totalVoidedAmount: summary.totalVoidedAmount,
        totalVoidedCost: summary.totalVoidedCost,
        totalLostProfit: summary.totalLostProfit,
        withAccountingDocCount: summary.withAccountingDocCount,
        withoutAccountingDocCount: summary.withoutAccountingDocCount,
      },
      recordCount: data.length,
      executionTimeMs: executionTime,
    };
  },

  // ── Refund Report ──
  async generateRefundReport(
    pool: Pool,
    options: {
      startDate: string;
      endDate: string;
      format?: 'json' | 'pdf' | 'csv';
      userId?: string;
    }
  ) {
    const startTime = Date.now();
    const systemContext = await getSystemContext(pool);

    const { headers, lines, summary, topRefundedProducts } = await reportsRepository.getRefundReport(pool, {
      startDate: options.startDate,
      endDate: options.endDate,
    });

    const executionTime = Date.now() - startTime;

    await reportsRepository.logReportRun(pool, {
      reportType: 'REFUND_REPORT',
      reportName: 'Refund Report',
      parameters: options,
      generatedById: options.userId || null,
      startDate: options.startDate,
      endDate: options.endDate,
      recordCount: headers.length,
      fileFormat: options.format || 'json',
      executionTimeMs: executionTime,
    });

    return {
      reportType: 'REFUND_REPORT' as const,
      reportName: 'Refund Report',
      generatedAt: new Date().toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false, timeZone: 'Africa/Kampala',
      }),
      systemSettings: systemContext,
      parameters: options,
      data: headers,
      lineItems: lines,
      topRefundedProducts,
      // Numeric SSOT only — UI/PDF format currency (no duplicate *Formatted dump fields)
      summary: {
        refundCount: summary.refundCount,
        totalRevenueReversal: summary.totalRevenueReversal,
        totalCOGSReversal: summary.totalCOGSReversal,
        netProfitImpact: summary.netProfitImpact,
        fullRefundCount: summary.fullRefundCount,
        partialRefundCount: summary.partialRefundCount,
        linesWithStockReturn: summary.linesWithStockReturn,
        linesWithoutStockReturn: summary.linesWithoutStockReturn,
      },
      recordCount: headers.length,
      executionTimeMs: executionTime,
    };
  },

  // ─────────────────────────────────────────────────────────────────
  // CATEGORY INTELLIGENCE REPORTING ENGINE
  // ─────────────────────────────────────────────────────────────────

  /**
   * Generates a Category Intelligence report for a single category.
   * reportType controls which sections are populated:
   *   INVENTORY_POSITION | SALES | PURCHASES | STOCK_VALUATION | EXPIRY_EXPOSURE | FULL_STATEMENT
   */
  async generateCategoryIntelligenceReport(
    pool: Pool,
    options: {
      category: string;
      reportType: 'INVENTORY_POSITION' | 'SALES' | 'PURCHASES' | 'STOCK_VALUATION' | 'EXPIRY_EXPOSURE' | 'FULL_STATEMENT';
      startDate?: string;
      endDate?: string;
      daysAhead?: number;
      userId?: string;
    }
  ) {
    const start = performance.now();
    const systemContext = await getSystemContext(pool);
    const today = getBusinessDate();
    const startDate = options.startDate || today.slice(0, 8) + '01'; // first of current month
    const endDate = options.endDate || today;
    const daysAhead = options.daysAhead ?? 90;

    const include = (section: string) =>
      options.reportType === 'FULL_STATEMENT' || options.reportType === section;

    const [inventoryRows, salesRows, purchasesRows, expiryRows] = await Promise.all([
      include('INVENTORY_POSITION') || include('STOCK_VALUATION')
        ? reportsRepository.getCategoryInventoryPosition(pool, { category: options.category })
        : Promise.resolve(null),
      include('SALES')
        ? reportsRepository.getCategorySalesByProduct(pool, {
          startDate,
          endDate,
          category: options.category,
        })
        : Promise.resolve(null),
      include('PURCHASES')
        ? reportsRepository.getCategoryPurchases(pool, {
          category: options.category,
          startDate,
          endDate,
        })
        : Promise.resolve(null),
      include('EXPIRY_EXPOSURE')
        ? reportsRepository.getCategoryExpiryExposure(pool, {
          category: options.category,
          daysAhead,
          asOfDate: today,
        })
        : Promise.resolve(null),
    ]);

    // ── Inventory / Stock-Valuation totals ──
    const inventorySummary = inventoryRows
      ? {
        productCount: inventoryRows.length,
        totalQtyOnHand: inventoryRows.reduce(
          (s, r) => new Decimal(s).plus(r.qtyOnHand).toNumber(), 0
        ),
        totalStockValue: inventoryRows.reduce(
          (s, r) => new Decimal(s).plus(r.stockValue).toNumber(), 0
        ),
        belowReorderCount: inventoryRows.filter((r) => r.qtyOnHand < r.reorderLevel).length,
      }
      : null;

    // ── Sales totals ──
    const salesSummary = salesRows
      ? {
        totalRevenue: salesRows.reduce((s, r) => new Decimal(s).plus(r.totalRevenue).toNumber(), 0),
        totalCost: salesRows.reduce((s, r) => new Decimal(s).plus(r.totalCost).toNumber(), 0),
        grossProfit: salesRows.reduce((s, r) => new Decimal(s).plus(r.grossProfit).toNumber(), 0),
        totalTransactions: salesRows.reduce((s, r) => s + r.transactionCount, 0),
        productCount: salesRows.length,
      }
      : null;

    // ── Purchases totals ──
    const purchasesSummary = purchasesRows
      ? {
        totalQtyReceived: purchasesRows.reduce(
          (s, r) => new Decimal(s).plus(r.totalQtyReceived).toNumber(), 0
        ),
        totalPurchaseValue: purchasesRows.reduce(
          (s, r) => new Decimal(s).plus(r.totalPurchaseValue).toNumber(), 0
        ),
        deliveryCount: new Set(purchasesRows.map((r) => r.grNumber)).size,
      }
      : null;

    // ── Expiry totals ──
    const expirySummary = expiryRows
      ? {
        batchCount: expiryRows.length,
        totalExposedQty: expiryRows.reduce(
          (s, r) => new Decimal(s).plus(r.remainingQuantity).toNumber(), 0
        ),
        totalExposedValue: expiryRows.reduce(
          (s, r) => new Decimal(s).plus(r.exposedValue).toNumber(), 0
        ),
        expiredCount: expiryRows.filter((r) => r.daysUntilExpiry <= 0).length,
        expiringSoonCount: expiryRows.filter((r) => r.daysUntilExpiry > 0 && r.daysUntilExpiry <= 30).length,
      }
      : null;

    return {
      reportType: 'CATEGORY_INTELLIGENCE' as const,
      reportName: `Category Intelligence — ${options.category}`,
      category: options.category,
      sectionType: options.reportType,
      generatedAt: new Date().toISOString(),
      parameters: { startDate, endDate, daysAhead },
      systemSettings: systemContext,
      inventoryPosition: inventoryRows,
      inventorySummary,
      sales: salesRows,
      salesSummary,
      purchases: purchasesRows,
      purchasesSummary,
      expiry: expiryRows,
      expirySummary,
      executionTimeMs: Math.round(performance.now() - start),
    };
  },
};
