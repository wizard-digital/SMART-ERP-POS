// Reports Controller - HTTP endpoints for report generation
// Handles parameter validation, authentication, and response formatting

import '../../types/express.js';
import { Request, Response } from 'express';
import { Pool } from 'pg';
import Decimal from 'decimal.js';
import { reportsService } from './reportsService.js';
import { ValidationError, NotFoundError } from '../../middleware/errorHandler.js';
import { reportsRepository } from './reportsRepository.js';
import { InventoryValuationRow, GoodsReceivedRow } from './reportTypes.js';
import logger from '../../utils/logger.js';
import {
  ReportPDFGenerator,
  PDFTableColumn,
  formatCurrencyPDF,
  formatQuantityPDF,
  formatDatePDF,
  formatDateTimePDF,
  PDFColors,
} from '../documents/pdfGenerator.js';
import { cnDnReportsController } from './cnDnReportController.js';
import { buildReorderDashboardCsv, buildReorderExportRows } from './reorderDashboardExport.js';
import { resolvePdfColumnIds } from '../../../../shared/reports/ordersReportColumnsSsot.js';
import {
  expiringPdfFilterSubtitle,
  expiryUrgencyLabel,
  type ExpiryBandFilter,
} from '../../../../shared/reports/expiringItemsSsot.js';
import { LOT_WRITE_DOWN_MAX_DAYS } from '../../../../shared/inventory-lot/lotWriteDown.js';

/** Map SSOT column ids → PDF defs; never returns empty (fail-closed to defaults / order #). */
function buildOrdersPdfColumns(
  colsMap: Record<string, PDFTableColumn>,
  columnsParam: string | undefined,
  mode: 'all' | 'cancelled',
): PDFTableColumn[] {
  const pick = (ids: string[]) =>
    ids.map((id) => colsMap[id]).filter((c): c is PDFTableColumn => Boolean(c));

  let mapped = pick(resolvePdfColumnIds(columnsParam, mode));
  if (mapped.length === 0) {
    mapped = pick(resolvePdfColumnIds(null, mode));
  }
  if (mapped.length === 0 && colsMap.orderNumber) {
    mapped = [colsMap.orderNumber];
  }
  const widthSum = mapped.reduce((s, c) => s + (c.width || 0), 0) || 1;
  return mapped.map((c) => ({
    ...c,
    width: Number((((c.width || 0.1) / widthSum)).toFixed(4)),
  }));
}

// Helper to get company name from system settings for PDF generation
async function getCompanyName(pool: Pool): Promise<string> {
  try {
    const settings = await reportsService.getSystemSettings(pool);
    return settings.businessName || 'SMART ERP';
  } catch {
    return 'SMART ERP';
  }
}

// Utility function to format dates in a simplified, human-readable format
// Always uses Africa/Kampala timezone for consistent output (SAP pattern)
function formatDateTime(date: Date = new Date()): string {
  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: 'Africa/Kampala',
  });
}

// Utility function to format date only (no time)
// Always uses Africa/Kampala timezone for consistent output (SAP pattern)
function formatDate(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    timeZone: 'Africa/Kampala',
  });
}

import {
  InventoryValuationParamsSchema,
  SalesReportParamsSchema,
  ExpiringItemsParamsSchema,
  LowStockParamsSchema,
  BestSellingProductsParamsSchema,
  SupplierCostAnalysisParamsSchema,
  GoodsReceivedParamsSchema,
  PaymentReportParamsSchema,
  CustomerPaymentsParamsSchema,
  ProfitLossParamsSchema,
  DeletedItemsParamsSchema,
  InventoryAdjustmentsParamsSchema,
  PurchaseOrderSummaryParamsSchema,
  StockMovementAnalysisParamsSchema,
  CustomerAccountStatementParamsSchema,
  ProfitMarginByProductParamsSchema,
  DailyCashFlowParamsSchema,
  SupplierPaymentStatusParamsSchema,
  TopCustomersParamsSchema,
  StockAgingParamsSchema,
  WasteDamageParamsSchema,
  ReorderRecommendationsParamsSchema,
  SalesByCategoryParamsSchema,
  SalesByPaymentMethodParamsSchema,
  HourlySalesAnalysisParamsSchema,
  SalesComparisonParamsSchema,
  CustomerPurchaseHistoryParamsSchema,
  BusinessPositionParamsSchema,
  DeliveryNoteReportParamsSchema,
  QuotationReportParamsSchema,
  ManualJournalEntryReportParamsSchema,
  BankTransactionReportParamsSchema,
  CategoryIntelligenceParamsSchema,
} from '../../../../shared/zod/reports.js';
import { z } from 'zod';
import { getBusinessDate } from '../../utils/dateRange.js';

/** Sales Analysis dimension labels (keep in sync with SalesAnalysisReportPage). */
const SALES_ANALYSIS_DIMENSION: Record<
  string,
  { periodLabel: string; title: string }
> = {
  day: { periodLabel: 'Date', title: 'By day' },
  week: { periodLabel: 'Week', title: 'By week' },
  month: { periodLabel: 'Month', title: 'By month' },
  cashier: { periodLabel: 'Cashier', title: 'By user / cashier' },
  customer: { periodLabel: 'Customer', title: 'By customer' },
  payment_method: { periodLabel: 'Payment', title: 'By payment type' },
  category: { periodLabel: 'Category', title: 'By item category' },
  product: { periodLabel: 'Product', title: 'By product' },
};

type SalesAnalysisColId =
  | 'rank'
  | 'period'
  | 'category'
  | 'transactionCount'
  | 'totalQuantitySold'
  | 'totalSales'
  | 'totalDiscounts'
  | 'netRevenue'
  | 'shareOfNet'
  | 'totalCost'
  | 'grossProfit'
  | 'profitMargin'
  | 'averageTransactionValue';

const SALES_ANALYSIS_COLUMN_META: Array<{
  id: SalesAnalysisColId;
  label: string;
  money?: boolean;
  pct?: boolean;
  qty?: boolean;
  productOnly?: boolean;
  computed?: boolean;
  pdfWidth: number;
  align?: 'left' | 'right' | 'center';
}> = [
  { id: 'rank', label: '#', computed: true, pdfWidth: 0.05, align: 'right' },
  { id: 'period', label: 'Group', pdfWidth: 0.16 },
  { id: 'category', label: 'Category', productOnly: true, pdfWidth: 0.12 },
  { id: 'transactionCount', label: 'Tickets', pdfWidth: 0.08, align: 'right' },
  { id: 'totalQuantitySold', label: 'Qty', qty: true, pdfWidth: 0.07, align: 'right' },
  { id: 'totalSales', label: 'Gross', money: true, pdfWidth: 0.1, align: 'right' },
  { id: 'totalDiscounts', label: 'Discount', money: true, pdfWidth: 0.09, align: 'right' },
  { id: 'netRevenue', label: 'Net', money: true, pdfWidth: 0.1, align: 'right' },
  { id: 'shareOfNet', label: 'Share', pct: true, computed: true, pdfWidth: 0.07, align: 'right' },
  { id: 'totalCost', label: 'Cost', money: true, pdfWidth: 0.09, align: 'right' },
  { id: 'grossProfit', label: 'GP', money: true, pdfWidth: 0.09, align: 'right' },
  { id: 'profitMargin', label: 'Margin', pct: true, pdfWidth: 0.08, align: 'right' },
  { id: 'averageTransactionValue', label: 'Avg ticket', money: true, pdfWidth: 0.1, align: 'right' },
];

const DEFAULT_SALES_ANALYSIS_COLUMNS: SalesAnalysisColId[] = [
  'rank',
  'period',
  'category',
  'transactionCount',
  'totalQuantitySold',
  'netRevenue',
  'shareOfNet',
  'grossProfit',
  'profitMargin',
];

type SalesAnalysisExportRow = Record<string, unknown> & {
  period: string;
  category?: string | null;
  netRevenue: number;
  rank: number;
  shareOfNet: number;
};

function parseSalesAnalysisColumns(
  raw: string | undefined,
  groupBy?: string | null,
): typeof SALES_ANALYSIS_COLUMN_META {
  const allowed = new Set(SALES_ANALYSIS_COLUMN_META.map((c) => c.id));
  const requested = (raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is SalesAnalysisColId => allowed.has(s as SalesAnalysisColId));
  const ids = requested.length > 0 ? requested : DEFAULT_SALES_ANALYSIS_COLUMNS;
  return SALES_ANALYSIS_COLUMN_META.filter((c) => {
    if (!ids.includes(c.id)) return false;
    if (c.productOnly && groupBy !== 'product') return false;
    return true;
  });
}

function enrichSalesAnalysisRows(
  rows: Array<Record<string, unknown>>,
  summaryNetRevenue: number,
  options: {
    sortBy?: string;
    sortDir?: 'asc' | 'desc';
    topN?: 'all' | '10' | '20';
  },
): SalesAnalysisExportRow[] {
  const netBase =
    Math.abs(Number(summaryNetRevenue || 0)) > 0.0001
      ? Number(summaryNetRevenue)
      : rows.reduce((a, r) => a + Number(r.netRevenue || 0), 0);

  const sortBy = options.sortBy || 'netRevenue';
  const sortDir = options.sortDir || (sortBy === 'period' ? 'asc' : 'desc');

  const sorted = [...rows].sort((a, b) => {
    if (sortBy === 'period') {
      const cmp = String(a.period ?? '').localeCompare(String(b.period ?? ''), undefined, {
        numeric: true,
        sensitivity: 'base',
      });
      return sortDir === 'asc' ? cmp : -cmp;
    }
    const av = Number((a as Record<string, unknown>)[sortBy] || 0);
    const bv = Number((b as Record<string, unknown>)[sortBy] || 0);
    return sortDir === 'asc' ? av - bv : bv - av;
  });

  const withShare = sorted.map((r) => {
    const net = Number(r.netRevenue || 0);
    const share = netBase === 0 ? 0 : (net / netBase) * 100;
    return {
      ...r,
      period: String(r.period ?? ''),
      netRevenue: net,
      shareOfNet: share,
      rank: 0,
    } as SalesAnalysisExportRow;
  });

  const byNet = [...withShare].sort((a, b) => b.netRevenue - a.netRevenue);
  const rankMap = new Map(byNet.map((r, i) => [`${r.period}|${r.category ?? ''}`, i + 1]));
  const ranked = withShare.map((r) => ({
    ...r,
    rank: rankMap.get(`${r.period}|${r.category ?? ''}`) ?? 0,
  }));

  if (options.topN === '10') return ranked.slice(0, 10);
  if (options.topN === '20') return ranked.slice(0, 20);
  return ranked;
}

function formatSalesAnalysisCell(
  row: SalesAnalysisExportRow,
  col: (typeof SALES_ANALYSIS_COLUMN_META)[number],
): string {
  if (col.id === 'rank') return String(row.rank);
  if (col.id === 'shareOfNet') return `${Number(row.shareOfNet || 0).toFixed(1)}%`;
  if (col.id === 'period') return String(row.period || '');
  if (col.id === 'category') {
    return row.category == null || row.category === '' ? '—' : String(row.category);
  }
  const v = row[col.id];
  if (col.money) return formatCurrencyPDF(Number(v || 0));
  if (col.pct) return `${Number(v || 0).toFixed(1)}%`;
  if (col.qty) return formatQuantityPDF(Number(v || 0));
  return String(v ?? '');
}

// Zod schemas for unvalidated report handlers
const SalesSummaryByDateQuerySchema = z.object({
  start_date: z.string().optional(),
  end_date: z.string().optional(),
  group_by: z.enum(['day', 'week', 'month']).optional().default('day'),
  format: z.string().optional(),
});
const SalesDetailsQuerySchema = z.object({
  start_date: z.string().optional(),
  end_date: z.string().optional(),
  product_id: z.string().optional(),
  format: z.string().optional(),
});
const SalesByCashierQuerySchema = z.object({
  start_date: z.string().optional(),
  end_date: z.string().optional(),
  user_id: z.string().optional(),     // legacy compat
  cashier_id: z.string().optional(),
  ordered_by_id: z.string().optional(),
  product_id: z.string().optional(),
  format: z.string().optional(),
});
const OrdersReportQuerySchema = z.object({
  start_date: z.string().optional(),
  end_date: z.string().optional(),
  status: z.enum(['PENDING', 'COMPLETED', 'CANCELLED']).optional(),
  user_id: z.string().optional(),
  format: z.string().optional(),
  /** Comma-separated column ids for PDF (client column chooser). */
  columns: z.string().optional(),
});
const CancelledOrdersQuerySchema = z.object({
  start_date: z.string().optional(),
  end_date: z.string().optional(),
  user_id: z.string().optional(),
  format: z.string().optional(),
  columns: z.string().optional(),
});
const CashRegisterDateRangeSchema = z.object({
  startDate: z.string().min(1, 'startDate is required'),
  endDate: z.string().min(1, 'endDate is required'),
  registerId: z.string().optional(),
  userId: z.string().optional(),
});
const CashRegisterSessionHistorySchema = CashRegisterDateRangeSchema.extend({
  status: z.enum(['OPEN', 'CLOSED', 'ALL']).optional().default('ALL'),
});

async function resolveReorderDashboardExportLines(req: Request, pool: Pool) {
  const body = req.body as { productIds?: unknown };
  const productIds = Array.isArray(body?.productIds)
    ? body.productIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : [];
  if (productIds.length === 0) {
    throw new ValidationError('Select at least one product to export');
  }

  const category =
    typeof req.query.category === 'string'
      ? req.query.category
      : typeof req.query.category_id === 'string'
        ? req.query.category_id
        : undefined;

  const lines = await reportsService.getReorderDashboardExportLines(pool, {
    productIds,
    category,
  });
  if (lines.length === 0) {
    throw new NotFoundError('No matching products found for export');
  }
  return lines;
}

export const reportsController = {
  /**
   * Get current system settings for report formatting
   * GET /api/reports/system-settings
   * Returns currency, date format, business name, and tax configuration
   */
  async getSystemSettings(req: Request, res: Response, pool: Pool) {
    const settings = await reportsService.getSystemSettings(pool);

    res.json({
      success: true,
      data: settings,
    });
  },

  /**
   * Get distinct product categories for filter dropdowns
   * GET /api/reports/product-categories
   */
  async getProductCategories(req: Request, res: Response, pool: Pool) {
    const categories = await reportsRepository.getProductCategories(pool);
    res.json({ success: true, data: categories });
  },

  /**
   * Generate Inventory Valuation Report
   * GET /api/reports/inventory-valuation
   */
  async getInventoryValuation(req: Request, res: Response, pool: Pool) {
    const params = InventoryValuationParamsSchema.parse(req.query);
    const userId = req.user?.id;

    const report = await reportsService.generateInventoryValuation(pool, {
      asOfDate: params.as_of_date,
      categoryId: params.category_id,
      valuationMethod: params.valuation_method,
      format: params.format,
      userId,
      page: params.page,
      limit: params.limit,
    });

    // PDF export
    if (params.format === 'pdf') {
      const companyName = await getCompanyName(pool);
      const pdfGen = new ReportPDFGenerator(companyName);
      const doc = pdfGen.getDocument();

      const date = getBusinessDate();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="inventory-valuation-${date}.pdf"`
      );
      doc.pipe(res);

      const asOfDate = params.as_of_date ? formatDatePDF(params.as_of_date) : 'Current';
      const method = params.valuation_method || 'FIFO';

      pdfGen.addHeader({
        companyName,
        title: 'Inventory Valuation Report',
        subtitle: `As of ${asOfDate} - Valuation Method: ${method}`,
        generatedAt: formatDateTime(),
      });

      pdfGen.addSummaryCards([
        {
          label: 'Total Value',
          value: formatCurrencyPDF(report.summary.totalValue),
          color: PDFColors.success,
        },
        {
          label: 'Total Items',
          value: String(report.summary.totalItems),
          color: PDFColors.primary,
        },
        {
          label: 'Total Quantity',
          value: formatQuantityPDF(report.summary.totalQuantity),
          color: PDFColors.info,
        },
        { label: 'Valuation Method', value: method, color: PDFColors.secondary },
      ]);

      const columns: PDFTableColumn[] = [
        { header: 'Product', key: 'productName', width: 0.3 },
        { header: 'SKU', key: 'sku', width: 0.18 },
        { header: 'Category', key: 'category', width: 0.15 },
        { header: 'Qty on Hand', key: 'quantityOnHand', width: 0.12, align: 'right' },
        { header: 'Unit Cost', key: 'unitCost', width: 0.12, align: 'right' },
        { header: 'Total Value', key: 'totalValue', width: 0.13, align: 'right' },
      ];

      // Format the data for the PDF
      const formattedData = (report.data as InventoryValuationRow[]).map((item) => ({
        ...item,
        unitCost: formatCurrencyPDF(item.unitCost),
        totalValue: formatCurrencyPDF(item.totalValue),
      }));

      pdfGen.addTable(columns, formattedData);
      pdfGen.end();
      return;
    }

    logger.info('Inventory valuation report generated', {
      userId,
      recordCount: report.recordCount,
      executionTime: report.executionTimeMs,
    });

    res.json({ success: true, data: report });
  },

  /**
   * Generate Sales Report
   * GET /api/reports/sales
   */
  async getSalesReport(req: Request, res: Response, pool: Pool) {
    const params = SalesReportParamsSchema.parse(req.query);
    const userId = req.user?.id;

    const report = await reportsService.generateSalesReport(pool, {
      startDate: params.start_date,
      endDate: params.end_date,
      groupBy: params.group_by,
      customerId: params.customer_id,
      sessionId: params.session_id,
      format: params.format,
      userId,
    });

    const groupBy = params.group_by || 'day';
    const dim = SALES_ANALYSIS_DIMENSION[groupBy] || {
      periodLabel: 'Group',
      title: groupBy.replace(/_/g, ' '),
    };
    const groupLabel = ` · ${dim.title}`;
    const exportCols = parseSalesAnalysisColumns(params.columns, groupBy);
    const exportRows = enrichSalesAnalysisRows(
      report.data as unknown as Array<Record<string, unknown>>,
      Number(report.summary.netRevenue || 0),
      {
        sortBy: params.sort_by,
        sortDir: params.sort_dir,
        topN: params.top_n,
      },
    );

    // CSV export — same columns / sort / top-N as on-screen Sales Analysis
    if (params.format === 'csv') {
      const csvEscape = (value: string) =>
        /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
      const headers = exportCols.map((c) =>
        c.id === 'period' ? dim.periodLabel : c.label,
      );
      const lines = exportRows.map((row) =>
        exportCols
          .map((col) => {
            if (col.money) return Number(row[col.id] || 0).toFixed(2);
            if (col.pct || col.id === 'shareOfNet') {
              return Number(col.id === 'shareOfNet' ? row.shareOfNet : row[col.id] || 0).toFixed(2);
            }
            if (col.id === 'rank') return String(row.rank);
            if (col.id === 'category') {
              return csvEscape(
                row.category == null || row.category === '' ? '—' : String(row.category),
              );
            }
            if (col.id === 'period') return csvEscape(String(row.period ?? ''));
            return csvEscape(String(row[col.id] ?? ''));
          })
          .join(','),
      );
      const body = [headers.join(','), ...lines].join('\n');
      const filename = `sales-analysis-${params.start_date}_${params.end_date}-${groupBy}.csv`;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(`\uFEFF${body}\n`);
      return;
    }

    // PDF export — match selected dimension + visible columns
    if (params.format === 'pdf') {
      const companyName = await getCompanyName(pool);
      const useLandscape = exportCols.length > 7;
      const pdfGen = new ReportPDFGenerator(companyName, {
        layout: useLandscape ? 'landscape' : 'portrait',
      });
      const doc = pdfGen.getDocument();

      const date = getBusinessDate();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="sales-analysis-${date}-${groupBy}.pdf"`,
      );
      doc.pipe(res);

      const startDate = formatDatePDF(params.start_date);
      const endDate = formatDatePDF(params.end_date);
      const topNote =
        params.top_n && params.top_n !== 'all' ? ` · top ${params.top_n}` : '';

      pdfGen.addHeader({
        companyName,
        title: 'Sales Analysis',
        subtitle: `${startDate} - ${endDate}${groupLabel}${topNote}`,
        generatedAt: formatDateTime(),
      });

      const avgTicket =
        Number(report.summary.totalTransactions || 0) > 0
          ? Number(report.summary.netRevenue) / Number(report.summary.totalTransactions)
          : 0;

      pdfGen.addSummaryCards([
        {
          label: 'Net revenue',
          value: formatCurrencyPDF(report.summary.netRevenue),
          color: PDFColors.primary,
        },
        {
          label: 'Gross profit',
          value: formatCurrencyPDF(report.summary.grossProfit),
          color: PDFColors.success,
        },
        {
          label: 'Margin',
          value: `${Number(report.summary.profitMargin || 0).toFixed(1)}%`,
          color: PDFColors.info,
        },
        {
          label: 'Qty / tickets',
          value: `${formatQuantityPDF(report.summary.totalQuantitySold || 0)} / ${report.summary.totalTransactions}`,
          color: PDFColors.secondary,
        },
      ]);

      pdfGen.addSectionHeading(
        `${dim.title} · ${exportRows.length} row(s)${params.sort_by ? ` · sorted by ${params.sort_by}` : ''}`,
      );

      const widthSum = exportCols.reduce((s, c) => s + c.pdfWidth, 0) || 1;

      // Build display rows with preformatted strings so addTable keys work cleanly
      const displayRows = exportRows.map((row) => {
        const out: Record<string, string | number> = {};
        for (const col of exportCols) {
          out[col.id] = formatSalesAnalysisCell(row, col);
        }
        return out;
      });

      const pdfColumns: PDFTableColumn[] = exportCols.map((c) => ({
        header: c.id === 'period' ? dim.periodLabel : c.label,
        key: c.id,
        width: c.pdfWidth / widthSum,
        align: c.align || 'left',
      }));

      pdfGen.addTable(pdfColumns, displayRows);

      // Keep avg ticket / discounts visible in footer summary when not in table
      if (
        !exportCols.some((c) => c.id === 'averageTransactionValue') ||
        !exportCols.some((c) => c.id === 'totalDiscounts')
      ) {
        pdfGen.addSectionHeading(
          `Discounts ${formatCurrencyPDF(report.summary.totalDiscounts || 0)} · Avg ticket ${formatCurrencyPDF(avgTicket)}`,
        );
      }

      pdfGen.end();
      return;
    }

    logger.info('Sales report generated', {
      userId,
      startDate: params.start_date,
      endDate: params.end_date,
      recordCount: report.recordCount,
    });

    res.json({ success: true, data: report });
  },

  /**
   * Generate Expiring Items Report
   * GET /api/reports/expiring-items
   */
  async getExpiringItems(req: Request, res: Response, pool: Pool) {
    const params = ExpiringItemsParamsSchema.parse(req.query);
    const userId = req.user?.id;
    const urgencyBand: ExpiryBandFilter = params.urgency_band || 'all';

    const report = await reportsService.generateExpiringItems(pool, {
      daysAhead: params.days_threshold,
      categoryId: params.category_id,
      urgencyBand,
      format: params.format,
      userId,
    });

    // PDF export
    if (params.format === 'pdf') {
      const companyName = await getCompanyName(pool);
      const pdfGen = new ReportPDFGenerator(companyName);
      const doc = pdfGen.getDocument();

      const date = getBusinessDate();
      const fileSuffix = urgencyBand === 'all' ? date : `${urgencyBand}-${date}`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="expiring-items-${fileSuffix}.pdf"`);
      doc.pipe(res);

      const days = params.days_threshold || LOT_WRITE_DOWN_MAX_DAYS;

      pdfGen.addHeader({
        companyName,
        title: 'Expiring Items Report',
        subtitle: expiringPdfFilterSubtitle(urgencyBand, days),
        generatedAt: formatDateTime(),
      });

      pdfGen.addSummaryCards([
        {
          label: urgencyBand === 'all' ? 'Batches at risk' : `${expiryUrgencyLabel(urgencyBand)} batches`,
          value: String(report.summary.totalItems),
          color: PDFColors.warning,
        },
        ...(urgencyBand === 'all'
          ? [
              {
                label: 'Expired',
                value: String(report.summary.expiredCount ?? 0),
                color: PDFColors.danger,
              },
              {
                label: 'Critical ≤7d',
                value: String(report.summary.criticalCount ?? 0),
                color: PDFColors.danger,
              },
            ]
          : []),
        {
          label: 'Qty at risk',
          value: formatQuantityPDF(report.summary.totalQuantityAtRisk || 0),
          color: PDFColors.info,
        },
        {
          label: 'Value at risk',
          value: formatCurrencyPDF(report.summary.totalPotentialLoss || 0),
          color: PDFColors.danger,
        },
      ]);

      pdfGen.addSectionHeading(
        urgencyBand === 'all' ? 'Expiry register' : `Expiry register — ${expiryUrgencyLabel(urgencyBand)} only`,
      );

      const columns: PDFTableColumn[] = [
        { header: 'Urgency', key: 'urgency', width: 0.1 },
        { header: 'Product', key: 'productName', width: 0.18 },
        { header: 'SKU', key: 'sku', width: 0.1 },
        { header: 'Batch', key: 'batchNumber', width: 0.1 },
        { header: 'Expiry', key: 'expiryDate', width: 0.1 },
        { header: 'Days', key: 'daysUntilExpiry', width: 0.07, align: 'right' },
        {
          header: 'Qty',
          key: 'quantityRemaining',
          width: 0.08,
          align: 'right',
          format: (v) => formatQuantityPDF(Number(v) || 0),
        },
        {
          header: 'Unit cost',
          key: 'unitCost',
          width: 0.12,
          align: 'right',
          format: (v) => formatCurrencyPDF(v),
        },
        {
          header: 'Value at risk',
          key: 'potentialLoss',
          width: 0.15,
          align: 'right',
          format: (v) => formatCurrencyPDF(v),
        },
      ];

      pdfGen.addTable(columns, report.data);
      pdfGen.end();
      return;
    }

    logger.info('Expiring items report generated', {
      userId,
      daysAhead: params.days_threshold,
      recordCount: report.recordCount,
    });

    res.json({ success: true, data: report });
  },

  /**
   * Generate Low Stock Report
   * GET /api/reports/low-stock
   */
  async getLowStock(req: Request, res: Response, pool: Pool) {
    const params = LowStockParamsSchema.parse(req.query);
    const userId = req.user?.id;

    const report = await reportsService.generateLowStock(pool, {
      threshold: params.threshold_percentage,
      categoryId: params.category_id,
      format: params.format,
      userId,
    });

    // PDF export
    if (params.format === 'pdf') {
      const companyName = await getCompanyName(pool);
      const pdfGen = new ReportPDFGenerator(companyName);
      const doc = pdfGen.getDocument();

      const date = getBusinessDate();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="low-stock-${date}.pdf"`);
      doc.pipe(res);

      const threshold = params.threshold_percentage || 20;

      pdfGen.addHeader({
        companyName,
        title: 'Low Stock Report',
        subtitle: `Items Below ${threshold}% of Reorder Level`,
        generatedAt: formatDateTime(),
      });

      pdfGen.addSummaryCards([
        {
          label: 'Total Low Stock Items',
          value: String(report.summary.totalItems),
          color: PDFColors.warning,
        },
        {
          label: 'Critical Items',
          value: String(report.summary.criticalCount || 0),
          color: PDFColors.danger,
        },
        {
          label: 'Low Stock Items',
          value: String(report.summary.lowCount || 0),
          color: PDFColors.warning,
        },
        { label: 'Threshold', value: `${threshold}%`, color: PDFColors.info },
      ]);

      const columns: PDFTableColumn[] = [
        { header: 'Product', key: 'productName', width: 0.3 },
        { header: 'SKU', key: 'sku', width: 0.2 },
        { header: 'Current Stock', key: 'currentStock', width: 0.18, align: 'right' },
        { header: 'Reorder Level', key: 'reorderLevel', width: 0.18, align: 'right' },
        {
          header: 'Status',
          key: 'status',
          width: 0.14,
          format: (v) => (v != null ? String(v) : 'N/A'),
        },
      ];

      pdfGen.addTable(columns, report.data);
      pdfGen.end();
      return;
    }

    logger.info('Low stock report generated', {
      userId,
      threshold: params.threshold_percentage,
      recordCount: report.recordCount,
    });

    res.json({ success: true, data: report });
  },

  /**
   * Generate Best Selling Products Report
   * GET /api/reports/best-selling
   */
  async getBestSelling(req: Request, res: Response, pool: Pool) {
    const params = BestSellingProductsParamsSchema.parse(req.query);
    const userId = req.user?.id;

    const report = await reportsService.generateBestSelling(pool, {
      startDate: params.start_date,
      endDate: params.end_date,
      limit: params.limit || 10,
      categoryId: params.category_id,
      format: params.format,
      userId,
    });

    // PDF export
    if (params.format === 'pdf') {
      const companyName = await getCompanyName(pool);
      const pdfGen = new ReportPDFGenerator(companyName);
      const doc = pdfGen.getDocument();

      const date = getBusinessDate();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="best-selling-${date}.pdf"`);
      doc.pipe(res);

      const startDate = formatDatePDF(params.start_date);
      const endDate = formatDatePDF(params.end_date);

      pdfGen.addHeader({
        companyName,
        title: 'Best Selling Products Report',
        subtitle: `Top ${params.limit || 10} Products - ${startDate} to ${endDate}`,
        generatedAt: formatDateTime(),
      });

      pdfGen.addSummaryCards([
        {
          label: 'Total Products',
          value: String(report.summary.totalProducts),
          color: PDFColors.primary,
        },
        {
          label: 'Total Revenue',
          value: formatCurrencyPDF(report.summary.totalRevenue || 0),
          color: PDFColors.success,
        },
        {
          label: 'Total Units Sold',
          value: formatQuantityPDF(report.summary.totalQuantitySold || 0),
          color: PDFColors.info,
        },
        {
          label: 'Total Profit',
          value: formatCurrencyPDF(report.summary.totalProfit || 0),
          color: PDFColors.secondary,
        },
      ]);

      const columns: PDFTableColumn[] = [
        { header: 'Rank', key: 'rank', width: 0.08 },
        { header: 'Product', key: 'productName', width: 0.25 },
        { header: 'SKU', key: 'sku', width: 0.12 },
        { header: 'Units Sold', key: 'unitsSold', width: 0.12, align: 'right' },
        {
          header: 'Revenue',
          key: 'totalRevenue',
          width: 0.13,
          align: 'right',
          format: (v) => formatCurrencyPDF(v),
        },
        {
          header: 'Profit',
          key: 'profit',
          width: 0.13,
          align: 'right',
          format: (v) => formatCurrencyPDF(v),
        },
        {
          header: 'Margin %',
          key: 'profitMargin',
          width: 0.09,
          align: 'right',
          format: (v) => v + '%',
        },
        {
          header: 'Avg Price',
          key: 'avgPrice',
          width: 0.08,
          align: 'right',
          format: (v) => formatCurrencyPDF(v),
        },
      ];

      pdfGen.addTable(columns, report.data);
      pdfGen.end();
      return;
    }

    logger.info('Best selling products report generated', {
      userId,
      startDate: params.start_date,
      endDate: params.end_date,
      recordCount: report.recordCount,
    });

    res.json({ success: true, data: report });
  },

  /**
   * Generate Supplier Cost Analysis Report
   * GET /api/reports/supplier-cost-analysis
   */
  async getSupplierCostAnalysis(req: Request, res: Response, pool: Pool) {
    const params = SupplierCostAnalysisParamsSchema.parse(req.query);
    const userId = req.user?.id;

    const report = await reportsService.generateSupplierCostAnalysis(pool, {
      startDate: params.start_date,
      endDate: params.end_date,
      supplierId: params.supplier_id,
      format: params.format,
      userId,
    });

    // PDF export
    if (params.format === 'pdf') {
      const companyName = await getCompanyName(pool);
      const pdfGen = new ReportPDFGenerator(companyName);
      const doc = pdfGen.getDocument();

      const date = getBusinessDate();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="supplier-cost-analysis-${date}.pdf"`
      );
      doc.pipe(res);

      const startDate = formatDatePDF(params.start_date);
      const endDate = formatDatePDF(params.end_date);

      pdfGen.addHeader({
        companyName,
        title: 'Supplier Cost Analysis Report',
        subtitle: `${startDate} to ${endDate}`,
        generatedAt: formatDateTime(),
      });

      pdfGen.addSummaryCards([
        {
          label: 'Total Suppliers',
          value: String(report.summary.totalSuppliers || 0),
          color: PDFColors.primary,
        },
        {
          label: 'Total Purchase Value',
          value: formatCurrencyPDF(report.summary.totalPurchaseValue || 0),
          color: PDFColors.success,
        },
        {
          label: 'Total Orders',
          value: String(report.summary.totalPurchaseOrders || 0),
          color: PDFColors.info,
        },
        {
          label: 'Avg Order Value',
          value: formatCurrencyPDF(
            report.summary.totalPurchaseOrders
              ? (report.summary.totalPurchaseValue || 0) / report.summary.totalPurchaseOrders
              : 0
          ),
          color: PDFColors.secondary,
        },
      ]);

      const columns: PDFTableColumn[] = [
        { header: 'Supplier', key: 'supplierName', width: 0.25 },
        { header: 'Orders', key: 'orderCount', width: 0.12, align: 'right' },
        {
          header: 'Total Cost',
          key: 'totalCost',
          width: 0.18,
          align: 'right',
          format: (v) => formatCurrencyPDF(v),
        },
        {
          header: 'Avg Cost',
          key: 'avgCost',
          width: 0.15,
          align: 'right',
          format: (v) => formatCurrencyPDF(v),
        },
        { header: 'Products', key: 'productCount', width: 0.12, align: 'right' },
        {
          header: '% of Total',
          key: 'percentOfTotal',
          width: 0.18,
          align: 'right',
          format: (v) => `${Number(v).toFixed(1)}%`,
        },
      ];

      pdfGen.addTable(columns, report.data);
      pdfGen.end();
      return;
    }

    logger.info('Supplier cost analysis report generated', {
      userId,
      startDate: params.start_date,
      endDate: params.end_date,
      recordCount: report.recordCount,
    });

    res.json({ success: true, data: report });
  },

  /**
   * Generate Goods Received Report
   * GET /api/reports/goods-received
   */
  async getGoodsReceived(req: Request, res: Response, pool: Pool) {
    const params = GoodsReceivedParamsSchema.parse(req.query);
    const userId = req.user?.id;

    const report = await reportsService.generateGoodsReceived(pool, {
      startDate: params.start_date,
      endDate: params.end_date,
      supplierId: params.supplier_id,
      productId: params.product_id,
      format: params.format,
      userId,
    });

    // PDF export
    if (params.format === 'pdf') {
      const companyName = await getCompanyName(pool);
      const pdfGen = new ReportPDFGenerator(companyName);
      const doc = pdfGen.getDocument();

      const date = getBusinessDate();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="goods-received-${date}.pdf"`);
      doc.pipe(res);

      const startDate = formatDatePDF(params.start_date);
      const endDate = formatDatePDF(params.end_date);

      pdfGen.addHeader({
        companyName,
        title: 'Goods Received Report',
        subtitle: `${startDate} to ${endDate}`,
        generatedAt: formatDateTime(),
      });

      // Calculate additional summary info
      const grData = report.data as GoodsReceivedRow[];
      const totalItems = grData.reduce((sum: number, r) => sum + (Number(r.itemsCount) || 0), 0);
      const uniqueSuppliers = new Set(grData.map((r) => r.supplierName)).size;

      pdfGen.addSummaryCards([
        {
          label: 'Total Receipts',
          value: String(report.summary.totalReceipts || 0),
          color: PDFColors.primary,
        },
        {
          label: 'Total Value',
          value: formatCurrencyPDF(report.summary.totalValue || 0),
          color: PDFColors.success,
        },
        { label: 'Total Items', value: String(totalItems), color: PDFColors.info },
        { label: 'Suppliers', value: String(uniqueSuppliers), color: PDFColors.secondary },
      ]);

      const columns: PDFTableColumn[] = [
        { header: 'Date', key: 'receivedDate', width: 0.14 },
        { header: 'GR #', key: 'goodsReceiptNumber', width: 0.14 },
        { header: 'PO #', key: 'purchaseOrderNumber', width: 0.14 },
        { header: 'Supplier', key: 'supplierName', width: 0.24 },
        { header: 'Items', key: 'itemsCount', width: 0.1, align: 'right' },
        {
          header: 'Total Value',
          key: 'totalValue',
          width: 0.24,
          align: 'right',
          format: (v) => formatCurrencyPDF(v),
        },
      ];

      pdfGen.addTable(columns, report.data);
      pdfGen.end();
      return;
    }

    logger.info('Goods received report generated', {
      userId,
      startDate: params.start_date,
      endDate: params.end_date,
      recordCount: report.recordCount,
    });

    res.json({ success: true, data: report });
  },

  /**
   * Generate Payment Report
   * GET /api/reports/payments
   */
  async getPaymentReport(req: Request, res: Response, pool: Pool) {
    const params = PaymentReportParamsSchema.parse(req.query);
    const userId = req.user?.id;

    const report = await reportsService.generatePaymentReport(pool, {
      startDate: params.start_date,
      endDate: params.end_date,
      paymentMethod: params.payment_method,
      format: params.format,
      userId,
    });

    // PDF export
    if (params.format === 'pdf') {
      const companyName = await getCompanyName(pool);
      const pdfGen = new ReportPDFGenerator(companyName);
      const doc = pdfGen.getDocument();

      const date = getBusinessDate();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="payment-report-${date}.pdf"`);
      doc.pipe(res);

      const startDate = formatDatePDF(params.start_date);
      const endDate = formatDatePDF(params.end_date);

      pdfGen.addHeader({
        companyName,
        title: 'Payment Methods Report',
        subtitle: `${startDate} to ${endDate}`,
        generatedAt: formatDateTime(),
      });

      pdfGen.addSummaryCards([
        {
          label: 'Total Amount',
          value: formatCurrencyPDF(report.summary.totalAmount || 0),
          color: PDFColors.success,
        },
        {
          label: 'Total Transactions',
          value: String(report.summary.totalTransactions || 0),
          color: PDFColors.primary,
        },
        { label: 'Payment Methods', value: String(report.data.length), color: PDFColors.info },
        { label: 'Period', value: `${startDate} to ${endDate}`, color: PDFColors.secondary },
      ]);

      const columns: PDFTableColumn[] = [
        { header: 'Payment Method', key: 'paymentMethod', width: 0.25 },
        { header: 'Transactions', key: 'transactionCount', width: 0.15, align: 'right' },
        {
          header: 'Total Amount',
          key: 'totalAmount',
          width: 0.2,
          align: 'right',
          format: (v) => formatCurrencyPDF(v),
        },
        {
          header: 'Avg Amount',
          key: 'avgAmount',
          width: 0.2,
          align: 'right',
          format: (v) => formatCurrencyPDF(v),
        },
        {
          header: '% of Total',
          key: 'percentageOfTotal',
          width: 0.2,
          align: 'right',
          format: (v) => v + '%',
        },
      ];

      pdfGen.addTable(columns, report.data);
      pdfGen.end();
      return;
    }

    logger.info('Payment report generated', {
      userId,
      startDate: params.start_date,
      endDate: params.end_date,
      recordCount: report.recordCount,
    });

    res.json({ success: true, data: report });
  },

  /**
   * Generate Customer Payments Report
   * GET /api/reports/customer-payments
   */
  async getCustomerPayments(req: Request, res: Response, pool: Pool) {
    const params = CustomerPaymentsParamsSchema.parse(req.query);
    const userId = req.user?.id;

    const report = await reportsService.generateCustomerPayments(pool, {
      startDate: params.start_date,
      endDate: params.end_date,
      customerId: params.customer_id,
      status: params.status,
      format: params.format,
      userId,
    });

    // PDF export — receipt journal + open balances (matches on-screen SSOT layout)
    if (params.format === 'pdf') {
      const companyName = await getCompanyName(pool);
      const pdfGen = new ReportPDFGenerator(companyName, { layout: 'landscape' });
      const doc = pdfGen.getDocument();

      const date = getBusinessDate();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="customer-payments-${date}.pdf"`);
      doc.pipe(res);

      const startDate = formatDatePDF(params.start_date);
      const endDate = formatDatePDF(params.end_date);

      pdfGen.addHeader({
        companyName,
        title: 'Customer Payments Report',
        subtitle: `${startDate} to ${endDate}`,
        generatedAt: formatDateTime(),
      });

      pdfGen.addSummaryCards([
        {
          label: 'Collected in period',
          value: formatCurrencyPDF(report.summary.collectionsInPeriod ?? report.summary.totalPaid ?? 0),
          color: PDFColors.success,
        },
        {
          label: 'Open receivables',
          value: formatCurrencyPDF(report.summary.totalOutstanding || 0),
          color: PDFColors.danger,
        },
        {
          label: 'Overdue',
          value: formatCurrencyPDF(report.summary.totalOverdue || 0),
          color: PDFColors.warning,
        },
        {
          label: 'Invoiced in period',
          value: formatCurrencyPDF(report.summary.totalInvoiced || 0),
          color: PDFColors.info,
        },
      ]);

      pdfGen.addSectionHeading(
        `1 — Customer receipts (payment journal) · ${report.paymentLines?.length || 0} receipt(s)`,
      );

      const receiptColumns: PDFTableColumn[] = [
        {
          header: 'Date',
          key: 'paymentDate',
          width: 0.1,
          format: (v) => (v ? formatDatePDF(String(v).slice(0, 10)) : ''),
        },
        { header: 'Customer', key: 'customerLabel', width: 0.22 },
        { header: 'Receipt #', key: 'paymentNumber', width: 0.14 },
        {
          header: 'Method',
          key: 'paymentMethod',
          width: 0.12,
          format: (v) => String(v || '').replace(/_/g, ' '),
        },
        {
          header: 'Amount',
          key: 'amount',
          width: 0.14,
          align: 'right',
          format: (v) => formatCurrencyPDF(v),
        },
        {
          header: 'Unallocated',
          key: 'unallocatedAmount',
          width: 0.14,
          align: 'right',
          format: (v) => formatCurrencyPDF(v),
        },
        { header: 'Status', key: 'status', width: 0.14 },
      ];

      const receiptRows = (report.paymentLines || []).map((line) => ({
        ...line,
        customerLabel: [line.customerNumber, line.customerName].filter(Boolean).join(' — '),
      }));

      pdfGen.addTable(receiptColumns, receiptRows);

      pdfGen.addSectionHeading(
        `2 — Customer open balances · ${report.data?.length || 0} customer(s)`,
      );

      const balanceColumns: PDFTableColumn[] = [
        { header: 'Customer', key: 'customerLabel', width: 0.22 },
        { header: 'Invoices', key: 'totalInvoices', width: 0.1, align: 'right' },
        {
          header: 'Invoiced (period)',
          key: 'totalInvoiced',
          width: 0.16,
          align: 'right',
          format: (v) => formatCurrencyPDF(v),
        },
        {
          header: 'Collected (period)',
          key: 'totalPaid',
          width: 0.16,
          align: 'right',
          format: (v) => formatCurrencyPDF(v),
        },
        {
          header: 'Open balance',
          key: 'totalOutstanding',
          width: 0.18,
          align: 'right',
          format: (v) => formatCurrencyPDF(v),
        },
        {
          header: 'Overdue',
          key: 'overdueAmount',
          width: 0.18,
          align: 'right',
          format: (v) => formatCurrencyPDF(v),
        },
      ];

      const balanceRows = (report.data || []).map((row) => ({
        ...row,
        customerLabel: [row.customerNumber, row.customerName].filter(Boolean).join(' — '),
      }));

      pdfGen.addTable(balanceColumns, balanceRows);

      const totalDeposited = Number(report.summary.totalDeposited ?? 0);
      const depositAvailable = Number(report.summary.depositAvailable ?? 0);
      if (totalDeposited > 0.009 || depositAvailable > 0.009) {
        pdfGen.addSectionHeading('3 — Customer deposits (liability — not AR)');
        pdfGen.addSummaryCards([
          {
            label: 'Deposits taken (active book)',
            value: formatCurrencyPDF(totalDeposited),
            color: PDFColors.secondary,
          },
          {
            label: 'Still available',
            value: formatCurrencyPDF(depositAvailable),
            color: PDFColors.secondary,
          },
        ]);
      }

      pdfGen.end();
      return;
    }

    logger.info('Customer payments report generated', {
      userId,
      startDate: params.start_date,
      endDate: params.end_date,
      recordCount: report.recordCount,
    });

    res.json({ success: true, data: report });
  },

  /**
   * Generate Profit & Loss Report
   * GET /api/reports/profit-loss
   */
  async getProfitLoss(req: Request, res: Response, pool: Pool) {
    const params = ProfitLossParamsSchema.parse(req.query);
    const userId = req.user?.id;

    const report = await reportsService.generateProfitLoss(pool, {
      startDate: params.start_date,
      endDate: params.end_date,
      groupBy: params.group_by,
      format: params.format,
      userId,
    });

    // PDF export
    if (params.format === 'pdf') {
      const companyName = await getCompanyName(pool);
      const pdfGen = new ReportPDFGenerator(companyName);
      const doc = pdfGen.getDocument();

      const date = getBusinessDate();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="profit-loss-${date}.pdf"`);
      doc.pipe(res);

      const startDate = formatDatePDF(params.start_date);
      const endDate = formatDatePDF(params.end_date);

      pdfGen.addHeader({
        companyName,
        title: 'Profit & Loss Report',
        subtitle: `${startDate} to ${endDate}`,
        generatedAt: formatDateTime(),
      });

      // SAP FI-CO Income Statement
      pdfGen.addIncomeStatement(report.summary, report.expenseBreakdown);

      // Period breakdown table
      pdfGen.addSectionHeading('Period Breakdown');

      const columns: PDFTableColumn[] = [
        { header: 'Period', key: 'period', width: 0.2 },
        {
          header: 'Revenue',
          key: 'revenue',
          width: 0.2,
          align: 'right',
          format: (v) => formatCurrencyPDF(v),
        },
        {
          header: 'COGS',
          key: 'costOfGoodsSold',
          width: 0.2,
          align: 'right',
          format: (v) => formatCurrencyPDF(v),
        },
        {
          header: 'Gross Profit',
          key: 'grossProfit',
          width: 0.2,
          align: 'right',
          format: (v) => formatCurrencyPDF(v),
        },
        {
          header: 'Margin %',
          key: 'grossProfitMargin',
          width: 0.2,
          align: 'right',
          format: (v) => (v !== undefined && v !== null ? Number(v).toFixed(2) + '%' : '0%'),
        },
      ];

      pdfGen.addTable(columns, report.data);
      pdfGen.end();
      return;
    }

    logger.info('Profit & loss report generated', {
      userId,
      startDate: params.start_date,
      endDate: params.end_date,
      recordCount: report.recordCount,
    });

    res.json({ success: true, data: report });
  },

  /**
   * Generate Deleted Items Report
   * GET /api/reports/deleted-items
   */
  async getDeletedItems(req: Request, res: Response, pool: Pool) {
    const params = DeletedItemsParamsSchema.parse(req.query);
    const userId = req.user?.id;

    const report = await reportsService.generateDeletedItems(pool, {
      startDate: params.start_date,
      endDate: params.end_date,
      format: params.format,
      userId,
    });

    // PDF export
    if (params.format === 'pdf') {
      const companyName = await getCompanyName(pool);
      const pdfGen = new ReportPDFGenerator(companyName);
      const doc = pdfGen.getDocument();

      const date = getBusinessDate();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="deleted-items-${date}.pdf"`);
      doc.pipe(res);

      const startDate = params.start_date
        ? formatDatePDF(params.start_date)
        : 'Beginning';
      const endDate = params.end_date ? formatDatePDF(params.end_date) : 'Today';

      pdfGen.addHeader({
        companyName,
        title: 'Deleted Items Report',
        subtitle: `${startDate} to ${endDate}`,
        generatedAt: formatDateTime(),
      });

      pdfGen.addSummaryCards([
        {
          label: 'Total Deleted Items',
          value: String(report.summary.totalDeletedItems || 0),
          color: PDFColors.danger,
        },
      ]);

      const columns: PDFTableColumn[] = [
        { header: 'Date', key: 'deletedAt', width: 0.15 },
        { header: 'Product', key: 'productName', width: 0.25 },
        { header: 'SKU', key: 'sku', width: 0.12 },
        { header: 'Quantity', key: 'quantity', width: 0.12, align: 'right' },
        {
          header: 'Value',
          key: 'value',
          width: 0.15,
          align: 'right',
          format: (v) => formatCurrencyPDF(v),
        },
        { header: 'Reason', key: 'reason', width: 0.21 },
      ];

      pdfGen.addTable(columns, report.data);
      pdfGen.end();
      return;
    }

    logger.info('Deleted items report generated', {
      userId,
      startDate: params.start_date,
      endDate: params.end_date,
      recordCount: report.recordCount,
    });

    res.json({ success: true, data: report });
  },

  /**
   * Generate Inventory Adjustments Report
   * GET /api/reports/inventory-adjustments
   */
  async getInventoryAdjustments(req: Request, res: Response, pool: Pool) {
    const params = InventoryAdjustmentsParamsSchema.parse(req.query);
    const userId = req.user?.id;

    const report = await reportsService.generateInventoryAdjustments(pool, {
      startDate: params.start_date,
      endDate: params.end_date,
      productId: params.product_id,
      format: params.format,
      userId,
    });

    // PDF export
    if (params.format === 'pdf') {
      const companyName = await getCompanyName(pool);
      const pdfGen = new ReportPDFGenerator(companyName);
      const doc = pdfGen.getDocument();

      const date = getBusinessDate();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="inventory-adjustments-${date}.pdf"`
      );
      doc.pipe(res);

      const startDate = formatDatePDF(params.start_date);
      const endDate = formatDatePDF(params.end_date);

      pdfGen.addHeader({
        companyName,
        title: 'Inventory Adjustments Report',
        subtitle: `${startDate} to ${endDate}`,
        generatedAt: formatDateTime(),
      });

      pdfGen.addSummaryCards([
        {
          label: 'Total Adjustments',
          value: String(report.summary.totalAdjustments || 0),
          color: PDFColors.primary,
        },
        {
          label: 'Qty Increased',
          value: String(report.summary.totalAdjustmentsIn || 0),
          color: PDFColors.success,
        },
        {
          label: 'Qty Decreased',
          value: String(report.summary.totalAdjustmentsOut || 0),
          color: PDFColors.danger,
        },
        {
          label: 'Net Change',
          value: String(
            (report.summary.totalAdjustmentsIn || 0) - (report.summary.totalAdjustmentsOut || 0)
          ),
          color: PDFColors.info,
        },
      ]);

      const columns: PDFTableColumn[] = [
        { header: 'Date', key: 'adjustmentDate', width: 0.12 },
        { header: 'Product', key: 'productName', width: 0.22 },
        { header: 'SKU', key: 'sku', width: 0.12 },
        { header: 'Qty Change', key: 'quantityChange', width: 0.12, align: 'right' },
        { header: 'Type', key: 'adjustmentType', width: 0.12 },
        { header: 'Reason', key: 'reason', width: 0.18 },
        { header: 'User', key: 'userName', width: 0.12 },
      ];

      pdfGen.addTable(columns, report.data);
      pdfGen.end();
      return;
    }

    logger.info('Inventory adjustments report generated', {
      userId,
      startDate: params.start_date,
      endDate: params.end_date,
      recordCount: report.recordCount,
    });

    res.json({ success: true, data: report });
  },

  /**
   * Generate Purchase Order Summary Report
   * GET /api/reports/purchase-order-summary
   */
  async getPurchaseOrderSummary(req: Request, res: Response, pool: Pool) {
    const params = PurchaseOrderSummaryParamsSchema.parse(req.query);
    const userId = req.user?.id;

    const report = await reportsService.generatePurchaseOrderSummary(pool, {
      startDate: params.start_date,
      endDate: params.end_date,
      status: params.status,
      supplierId: params.supplier_id,
      format: params.format,
      userId,
    });

    // PDF export
    if (params.format === 'pdf') {
      const companyName = await getCompanyName(pool);
      const pdfGen = new ReportPDFGenerator(companyName);
      const doc = pdfGen.getDocument();

      const date = getBusinessDate();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="purchase-orders-${date}.pdf"`);
      doc.pipe(res);

      const startDate = params.start_date
        ? formatDatePDF(params.start_date)
        : 'Beginning';
      const endDate = params.end_date ? formatDatePDF(params.end_date) : 'Today';

      pdfGen.addHeader({
        companyName,
        title: 'Purchase Order Summary Report',
        subtitle: `${startDate} to ${endDate}`,
        generatedAt: formatDateTime(),
      });

      pdfGen.addSummaryCards([
        {
          label: 'Total Orders',
          value: String(report.summary.totalOrders || 0),
          color: PDFColors.primary,
        },
        {
          label: 'Total Amount',
          value: formatCurrencyPDF(report.summary.totalAmount || 0),
          color: PDFColors.success,
        },
        {
          label: 'Total Receipts',
          value: String(report.summary.totalReceipts || 0),
          color: PDFColors.warning,
        },
        {
          label: 'Qty Received',
          value: String(report.summary.totalReceived || 0),
          color: PDFColors.info,
        },
      ]);

      const columns: PDFTableColumn[] = [
        { header: 'PO #', key: 'poNumber', width: 0.14 },
        { header: 'Date', key: 'orderDate', width: 0.14 },
        { header: 'Supplier', key: 'supplierName', width: 0.24 },
        {
          header: 'Total',
          key: 'totalAmount',
          width: 0.18,
          align: 'right',
          format: (v) => formatCurrencyPDF(v),
        },
        { header: 'Receipts', key: 'totalReceipts', width: 0.12, align: 'right' },
        { header: 'Status', key: 'status', width: 0.18 },
      ];

      pdfGen.addTable(columns, report.data);
      pdfGen.end();
      return;
    }

    logger.info('Purchase order summary report generated', {
      userId,
      recordCount: report.recordCount,
    });

    res.json({ success: true, data: report });
  },

  /**
   * Generate Stock Movement Analysis Report
   * GET /api/reports/stock-movement-analysis
   */
  async getStockMovementAnalysis(req: Request, res: Response, pool: Pool) {
    const params = StockMovementAnalysisParamsSchema.parse(req.query);
    const userId = req.user?.id;

    const report = await reportsService.generateStockMovementAnalysis(pool, {
      startDate: params.start_date,
      endDate: params.end_date,
      productId: params.product_id,
      movementType: params.movement_type,
      format: params.format,
      userId,
    });

    // PDF export
    if (params.format === 'pdf') {
      const companyName = await getCompanyName(pool);
      const pdfGen = new ReportPDFGenerator(companyName);
      const doc = pdfGen.getDocument();

      const date = getBusinessDate();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="stock-movements-${date}.pdf"`);
      doc.pipe(res);

      const startDate = formatDatePDF(params.start_date);
      const endDate = formatDatePDF(params.end_date);

      pdfGen.addHeader({
        companyName,
        title: 'Stock Movement Analysis Report',
        subtitle: `${startDate} to ${endDate}`,
        generatedAt: formatDateTime(),
      });

      pdfGen.addSummaryCards([
        {
          label: 'Total Transactions',
          value: String(report.summary.totalTransactions || 0),
          color: PDFColors.primary,
        },
        { label: 'Stock In', value: String(report.summary.totalIn || 0), color: PDFColors.success },
        {
          label: 'Stock Out',
          value: String(report.summary.totalOut || 0),
          color: PDFColors.danger,
        },
        {
          label: 'Net Movement',
          value: String(report.summary.netMovement || 0),
          color: PDFColors.info,
        },
      ]);

      const columns: PDFTableColumn[] = [
        { header: 'Movement Type', key: 'movement_type', width: 0.25 },
        { header: 'Product', key: 'product_name', width: 0.3 },
        { header: 'SKU', key: 'sku', width: 0.15 },
        { header: 'In', key: 'totalIn', width: 0.1, align: 'right' },
        { header: 'Out', key: 'totalOut', width: 0.1, align: 'right' },
        { header: 'Net', key: 'netMovement', width: 0.1, align: 'right' },
      ];

      pdfGen.addTable(columns, report.data);
      pdfGen.end();
      return;
    }

    logger.info('Stock movement analysis report generated', {
      userId,
      recordCount: report.recordCount,
    });

    res.json({ success: true, data: report });
  },

  /**
   * Generate Customer Account Statement Report
   * GET /api/reports/customer-account-statement
   */
  async getCustomerAccountStatement(req: Request, res: Response, pool: Pool) {
    const params = CustomerAccountStatementParamsSchema.parse(req.query);
    const userId = req.user?.id;

    // Lookup customer by customer_number to get the UUID
    const customerResult = await pool.query('SELECT id FROM customers WHERE customer_number = $1', [
      params.customer_number,
    ]);

    if (customerResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: `Customer not found: ${params.customer_number}`,
      });
    }

    const customerId = customerResult.rows[0].id;

    const report = await reportsService.generateCustomerAccountStatement(pool, {
      customerId: customerId,
      startDate: params.start_date,
      endDate: params.end_date,
      format: params.format,
      userId,
    });

    // PDF export — SAP/QB partner statement (same axis as on-screen layout)
    if (params.format === 'pdf') {
      const companyName = await getCompanyName(pool);
      const pdfGen = new ReportPDFGenerator(companyName, { layout: 'landscape' });
      const doc = pdfGen.getDocument();

      const date = getBusinessDate();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="customer-statement-${params.customer_number}-${date}.pdf"`
      );
      doc.pipe(res);

      const customerName = report.data.customer.name || 'Unknown Customer';
      const startDate = params.start_date
        ? formatDatePDF(params.start_date)
        : 'Beginning';
      const endDate = params.end_date
        ? formatDatePDF(params.end_date)
        : 'Today';
      const opening = Number(report.summary.openingBalance ?? 0);
      const closing = Number(report.summary.closingBalance ?? report.summary.totalOutstanding ?? 0);
      const totalDebits = Number(report.summary.totalDebits ?? report.summary.totalSales ?? 0);
      const totalCredits = Number(report.summary.totalCredits ?? report.summary.totalPaid ?? 0);
      const unalloc = Number(report.summary.unallocatedReceiptsTotal ?? 0);
      const isCredit = closing < -0.009;
      const formatSignedBalance = (v: unknown) => {
        const n = Number(v) || 0;
        if (Math.abs(n) < 0.009) return formatCurrencyPDF(0);
        return `${formatCurrencyPDF(Math.abs(n))}${n < 0 ? ' CR' : ' DR'}`;
      };

      pdfGen.addHeader({
        companyName,
        title: 'Customer Account Statement',
        subtitle: `${customerName} (${params.customer_number}) · GL AR 1200 · ${startDate} to ${endDate}`,
        generatedAt: formatDateTime(),
      });

      pdfGen.addSummaryCards([
        {
          label: 'Opening',
          value: formatSignedBalance(opening),
          color: PDFColors.primary,
        },
        {
          label: 'Debits (charges)',
          value: formatCurrencyPDF(totalDebits),
          color: PDFColors.info,
        },
        {
          label: 'Credits (settlements)',
          value: formatCurrencyPDF(totalCredits),
          color: PDFColors.success,
        },
        {
          label: isCredit ? 'Closing — customer credit' : 'Closing — amount due',
          value: formatSignedBalance(closing),
          color: isCredit ? PDFColors.success : closing > 0.009 ? PDFColors.danger : PDFColors.dark,
        },
      ]);

      if (unalloc > 0.009) {
        pdfGen.addSectionHeading(`On-account unallocated: ${formatCurrencyPDF(unalloc)}`);
      }

      pdfGen.addSectionHeading('Account movements (GL AR 1200)');

      const txRows = (report.data.transactions || []).map((t: Record<string, unknown>) => ({
        saleDate: t.saleDate,
        documentType: t.documentType || t.paymentStatus || '',
        saleNumber: t.saleNumber || '',
        description: t.description || '',
        debit: Number(t.totalAmount ?? 0),
        credit: Number(t.amountPaid ?? 0),
        balanceDue: Number(t.balanceDue ?? 0),
      }));

      const columns: PDFTableColumn[] = [
        {
          header: 'Date',
          key: 'saleDate',
          width: 0.1,
          format: (v) => (v ? formatDatePDF(String(v).slice(0, 10)) : ''),
        },
        { header: 'Type', key: 'documentType', width: 0.12 },
        { header: 'Document', key: 'saleNumber', width: 0.14 },
        { header: 'Description', key: 'description', width: 0.24 },
        {
          header: 'Debit',
          key: 'debit',
          width: 0.12,
          align: 'right',
          format: (v) => (Number(v) > 0.009 ? formatCurrencyPDF(v as number) : '—'),
        },
        {
          header: 'Credit',
          key: 'credit',
          width: 0.12,
          align: 'right',
          format: (v) => (Number(v) > 0.009 ? formatCurrencyPDF(v as number) : '—'),
        },
        {
          header: 'Balance',
          key: 'balanceDue',
          width: 0.16,
          align: 'right',
          format: formatSignedBalance,
        },
      ];

      pdfGen.addTable(columns, txRows);
      pdfGen.end();
      return;
    }

    logger.info('Customer account statement generated', {
      userId,
      customerNumber: params.customer_number,
      customerId: customerId,
      recordCount: report.recordCount,
    });

    res.json({ success: true, data: report });
  },

  /**
   * Generate Profit Margin by Product Report
   * GET /api/reports/profit-margin
   */
  async getProfitMarginByProduct(req: Request, res: Response, pool: Pool) {
    const params = ProfitMarginByProductParamsSchema.parse(req.query);
    const userId = req.user?.id;

    const report = await reportsService.generateProfitMarginByProduct(pool, {
      startDate: params.start_date,
      endDate: params.end_date,
      categoryId: params.category_id,
      minMargin: params.min_margin,
      format: params.format,
      userId,
    });

    // PDF export
    if (params.format === 'pdf') {
      const companyName = await getCompanyName(pool);
      const pdfGen = new ReportPDFGenerator(companyName);
      const doc = pdfGen.getDocument();

      const date = getBusinessDate();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="profit-margin-${date}.pdf"`);
      doc.pipe(res);

      const startDate = params.start_date ? formatDatePDF(params.start_date) : 'All Time';
      const endDate = params.end_date ? formatDatePDF(params.end_date) : 'Present';

      pdfGen.addHeader({
        companyName,
        title: 'Profit Margin by Product Report',
        subtitle: `${startDate} to ${endDate}`,
        generatedAt: formatDateTime(),
      });

      pdfGen.addSummaryCards([
        {
          label: 'Products',
          value: String(report.summary.totalProducts || 0),
          color: PDFColors.primary,
        },
        {
          label: 'Avg Margin',
          value: `${(report.summary.averageMarginPercent || 0).toFixed(1)}%`,
          color: PDFColors.success,
        },
        {
          label: 'Total Revenue',
          value: formatCurrencyPDF(report.summary.totalRevenue || 0),
          color: PDFColors.info,
        },
        {
          label: 'Total Profit',
          value: formatCurrencyPDF(report.summary.totalProfit || 0),
          color: PDFColors.secondary,
        },
      ]);

      const columns: PDFTableColumn[] = [
        { header: 'Product', key: 'productName', width: 0.25 },
        { header: 'Category', key: 'category', width: 0.15 },
        { header: 'Units Sold', key: 'totalQuantitySold', width: 0.12, align: 'right' },
        {
          header: 'Revenue',
          key: 'totalRevenue',
          width: 0.16,
          align: 'right',
          format: (v) => formatCurrencyPDF(v),
        },
        {
          header: 'Cost',
          key: 'totalCost',
          width: 0.16,
          align: 'right',
          format: (v) => formatCurrencyPDF(v),
        },
        {
          header: 'Margin %',
          key: 'profitMarginPercent',
          width: 0.16,
          align: 'right',
          format: (v) =>
            v !== undefined && v !== null && !isNaN(Number(v)) ? `${Number(v).toFixed(1)}%` : '0%',
        },
      ];

      pdfGen.addTable(columns, report.data);
      pdfGen.end();
      return;
    }

    logger.info('Profit margin by product report generated', {
      userId,
      recordCount: report.recordCount,
    });

    res.json({ success: true, data: report });
  },

  /**
   * Generate Daily Cash Flow Report
   * GET /api/reports/daily-cash-flow
   */
  async getDailyCashFlow(req: Request, res: Response, pool: Pool) {
    const params = DailyCashFlowParamsSchema.parse(req.query);
    const userId = req.user?.id;

    const report = await reportsService.generateDailyCashFlow(pool, {
      startDate: params.start_date,
      endDate: params.end_date,
      format: params.format,
      userId,
    });

    // PDF export
    if (params.format === 'pdf') {
      const companyName = await getCompanyName(pool);
      const pdfGen = new ReportPDFGenerator(companyName);
      const doc = pdfGen.getDocument();

      const date = getBusinessDate();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="daily-cash-flow-${date}.pdf"`);
      doc.pipe(res);

      const startDate = formatDatePDF(params.start_date);
      const endDate = formatDatePDF(params.end_date);

      pdfGen.addHeader({
        companyName,
        title: 'Daily Cash Flow Report',
        subtitle: `${startDate} to ${endDate}`,
        generatedAt: formatDateTime(),
      });

      pdfGen.addSummaryCards([
        {
          label: 'POS receipts',
          value: formatCurrencyPDF(report.summary.salesRevenue || 0),
          color: PDFColors.success,
        },
        {
          label: 'AR collections',
          value: formatCurrencyPDF(report.summary.debtCollections || 0),
          color: PDFColors.info,
        },
        {
          label: 'Deposits',
          value: formatCurrencyPDF(report.summary.depositReceipts || 0),
          color: PDFColors.secondary,
        },
        {
          label: 'Total cash in',
          value: formatCurrencyPDF(report.summary.totalCashIn || 0),
          color: PDFColors.primary,
        },
      ]);

      if (Number(report.summary.creditExtended || 0) > 0.009) {
        pdfGen.addSectionHeading(
          `Credit extended (memo — not cash): ${formatCurrencyPDF(report.summary.creditExtended || 0)}`,
        );
      }

      pdfGen.addSectionHeading('Cash journal by day / method');

      const flowLabel = (v: unknown) => {
        const t = String(v || '');
        if (t === 'POS_RECEIPT' || t === 'SALES_REVENUE') return 'POS receipt';
        if (t === 'AR_COLLECTION' || t === 'DEBT_COLLECTION') return 'AR collection';
        if (t === 'CUSTOMER_DEPOSIT' || t === 'DEPOSIT_RECEIPT') return 'Customer deposit';
        if (t === 'CREDIT_EXTENDED') return 'Credit extended';
        return t.replace(/_/g, ' ');
      };

      const columns: PDFTableColumn[] = [
        {
          header: 'Date',
          key: 'transactionDate',
          width: 0.12,
          format: (v) => (v ? formatDatePDF(String(v).slice(0, 10)) : ''),
        },
        { header: 'Flow', key: 'revenueType', width: 0.16, format: flowLabel },
        {
          header: 'Method',
          key: 'paymentMethod',
          width: 0.14,
          format: (v) => String(v || '').replace(/_/g, ' '),
        },
        { header: 'Count', key: 'transactionCount', width: 0.08, align: 'right' },
        {
          header: 'Cash in',
          key: 'cashAmount',
          width: 0.16,
          align: 'right',
          format: (v) => formatCurrencyPDF(v),
        },
        {
          header: 'Credit (memo)',
          key: 'creditCreated',
          width: 0.16,
          align: 'right',
          format: (v) => (Number(v) > 0.009 ? formatCurrencyPDF(v) : '—'),
        },
        {
          header: 'GP (POS)',
          key: 'grossProfit',
          width: 0.18,
          align: 'right',
          format: (v) => (Number(v) > 0.009 ? formatCurrencyPDF(v) : '—'),
        },
      ];

      pdfGen.addTable(columns, report.data || []);
      pdfGen.end();
      return;
    }

    logger.info('Daily cash flow report generated', {
      userId,
      recordCount: report.recordCount,
    });

    res.json({ success: true, data: report });
  },

  /**
   * Generate Supplier Payment Status Report
   * GET /api/reports/supplier-payment-status
   */
  async getSupplierPaymentStatus(req: Request, res: Response, pool: Pool) {
    const params = SupplierPaymentStatusParamsSchema.parse(req.query);
    const userId = req.user?.id;

    const report = await reportsService.generateSupplierPaymentStatus(pool, {
      supplierId: params.supplier_id,
      status: params.status,
      startDate: params.start_date,
      endDate: params.end_date,
      format: params.format,
      userId,
    });

    // PDF export
    if (params.format === 'pdf') {
      const companyName = await getCompanyName(pool);
      const pdfGen = new ReportPDFGenerator(companyName);
      const doc = pdfGen.getDocument();

      const date = getBusinessDate();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="supplier-payment-status-${date}.pdf"`
      );
      doc.pipe(res);

      pdfGen.addHeader({
        companyName,
        title: 'Supplier Payment Status Report',
        subtitle: 'Current Payment Status by Supplier',
        generatedAt: formatDateTime(),
      });

      pdfGen.addSummaryCards([
        {
          label: 'Total Suppliers',
          value: String(report.summary.totalSuppliers || 0),
          color: PDFColors.primary,
        },
        {
          label: 'Total Amount',
          value: formatCurrencyPDF(report.summary.totalAmount || 0),
          color: PDFColors.info,
        },
        {
          label: 'Total Paid',
          value: formatCurrencyPDF(report.summary.totalPaid || 0),
          color: PDFColors.success,
        },
        {
          label: 'Outstanding',
          value: formatCurrencyPDF(report.summary.totalOutstanding || 0),
          color: PDFColors.danger,
        },
      ]);

      const columns: PDFTableColumn[] = [
        { header: 'Supplier', key: 'supplierName', width: 0.28 },
        { header: 'Orders', key: 'totalOrders', width: 0.12, align: 'right' },
        {
          header: 'Total Amount',
          key: 'totalAmount',
          width: 0.2,
          align: 'right',
          format: (v) => formatCurrencyPDF(v),
        },
        {
          header: 'Paid',
          key: 'totalPaid',
          width: 0.2,
          align: 'right',
          format: (v) => formatCurrencyPDF(v),
        },
        {
          header: 'Outstanding',
          key: 'outstandingBalance',
          width: 0.2,
          align: 'right',
          format: (v) => formatCurrencyPDF(v),
        },
      ];

      pdfGen.addTable(columns, report.data);

      // Add individual payment records section
      if (report.payments && report.payments.length > 0) {
        pdfGen.addSectionHeading('Individual Payment Records');

        const paymentColumns: PDFTableColumn[] = [
          { header: 'Payment #', key: 'paymentNumber', width: 0.15 },
          { header: 'Supplier', key: 'supplierName', width: 0.25 },
          { header: 'Date', key: 'paymentDate', width: 0.12 },
          {
            header: 'Amount',
            key: 'amount',
            width: 0.16,
            align: 'right',
            format: (v) => formatCurrencyPDF(v),
          },
          { header: 'Method', key: 'paymentMethod', width: 0.12 },
          { header: 'Status', key: 'status', width: 0.1 },
          { header: 'Ref', key: 'reference', width: 0.1 },
        ];

        pdfGen.addTable(paymentColumns, report.payments);
      }

      pdfGen.end();
      return;
    }

    logger.info('Supplier payment status report generated', {
      userId,
      recordCount: report.recordCount,
    });

    res.json({ success: true, data: report });
  },

  /**
   * Generate Top Customers Report
   * GET /api/reports/top-customers
   */
  async getTopCustomers(req: Request, res: Response, pool: Pool) {
    const params = TopCustomersParamsSchema.parse(req.query);
    const userId = req.user?.id;

    const report = await reportsService.generateTopCustomers(pool, {
      startDate: params.start_date,
      endDate: params.end_date,
      limit: params.limit,
      sortBy: params.sort_by,
      format: params.format,
      userId,
    });

    // PDF export
    if (params.format === 'pdf') {
      const companyName = await getCompanyName(pool);
      const pdfGen = new ReportPDFGenerator(companyName);
      const doc = pdfGen.getDocument();

      const date = getBusinessDate();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="top-customers-${date}.pdf"`);
      doc.pipe(res);

      const startDate = formatDatePDF(params.start_date);
      const endDate = formatDatePDF(params.end_date);

      pdfGen.addHeader({
        companyName,
        title: 'Top Customers Report',
        subtitle: `Top ${params.limit || 10} Customers - ${startDate} to ${endDate}`,
        generatedAt: formatDateTime(),
      });

      pdfGen.addSummaryCards([
        { label: 'Customers ranked', value: String(report.data.length), color: PDFColors.primary },
        {
          label: 'Period revenue',
          value: formatCurrencyPDF(report.summary.totalRevenue || 0),
          color: PDFColors.success,
        },
        {
          label: 'Orders',
          value: String(report.summary.totalPurchases || 0),
          color: PDFColors.info,
        },
        {
          label: 'Open AR (now)',
          value: formatCurrencyPDF(
            (report.data || []).reduce(
              (s, r) =>
                s + Number((r as { outstandingBalance?: number; currentBalance?: number }).outstandingBalance
                  ?? (r as { currentBalance?: number }).currentBalance
                  ?? 0),
              0,
            ),
          ),
          color: PDFColors.danger,
        },
      ]);

      const columns: PDFTableColumn[] = [
        { header: '#', key: 'rank', width: 0.06 },
        { header: 'Customer', key: 'customerLabel', width: 0.22 },
        { header: 'Orders', key: 'totalPurchases', width: 0.1, align: 'right' },
        {
          header: 'Revenue',
          key: 'totalRevenue',
          width: 0.14,
          align: 'right',
          format: (v) => formatCurrencyPDF(v),
        },
        {
          header: 'Profit',
          key: 'totalProfit',
          width: 0.12,
          align: 'right',
          format: (v) => formatCurrencyPDF(v),
        },
        {
          header: 'Avg ticket',
          key: 'averagePurchaseValue',
          width: 0.12,
          align: 'right',
          format: (v) => formatCurrencyPDF(Number(v ?? 0)),
        },
        {
          header: 'Last sale',
          key: 'lastPurchaseDate',
          width: 0.12,
          format: (v) => (v ? formatDatePDF(String(v).slice(0, 10)) : ''),
        },
        {
          header: 'Open balance',
          key: 'openBalance',
          width: 0.12,
          align: 'right',
          format: (v) => formatCurrencyPDF(v),
        },
      ];

      const topRows = (report.data || []).map((row, idx) => {
        const r = row as {
          rank?: number;
          customerNumber?: string;
          customerName?: string;
          averagePurchaseValue?: number;
          avgPurchase?: number;
          outstandingBalance?: number;
          currentBalance?: number;
        };
        return {
          ...row,
          rank: r.rank ?? idx + 1,
          customerLabel: [r.customerNumber, r.customerName].filter(Boolean).join(' — '),
          averagePurchaseValue: r.averagePurchaseValue ?? r.avgPurchase ?? 0,
          openBalance: r.outstandingBalance ?? r.currentBalance ?? 0,
        };
      });

      pdfGen.addTable(columns, topRows);
      pdfGen.end();
      return;
    }

    logger.info('Top customers report generated', {
      userId,
      recordCount: report.recordCount,
    });

    res.json({ success: true, data: report });
  },

  /**
   * Generate Customer Aging Report
   * GET /api/reports/customer-aging
   */
  async getCustomerAging(req: Request, res: Response, pool: Pool) {
    const userId = req.user?.id;
    const format = (req.query.format as string) || 'json';
    const asOfRaw = (req.query.as_of_date as string) || (req.query.asOfDate as string);
    const asOfDate = asOfRaw && /^\d{4}-\d{2}-\d{2}$/.test(asOfRaw) ? asOfRaw : getBusinessDate();

    const report = await reportsService.generateCustomerAging(pool, {
      asOfDate,
      format: format as 'json' | 'pdf' | 'csv',
      userId,
    });

    // PDF export
    if (format === 'pdf') {
      const companyName = await getCompanyName(pool);
      const pdfGen = new ReportPDFGenerator(companyName);
      const doc = pdfGen.getDocument();

      const date = getBusinessDate();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="customer-aging-${date}.pdf"`);
      doc.pipe(res);

      pdfGen.addHeader({
        companyName,
        title: 'Customer Aging Report',
        subtitle: `As of ${formatDateTime()}`,
        generatedAt: formatDateTime(),
      });

      pdfGen.addSummaryCards([
        {
          label: 'Total Customers',
          value: String(report.summary.totalCustomers || 0),
          color: PDFColors.primary,
        },
        {
          label: 'Total Outstanding',
          value: formatCurrencyPDF(report.summary.totalOutstanding || 0),
          color: PDFColors.danger,
        },
        {
          label: 'Current',
          value: formatCurrencyPDF(report.summary.current || 0),
          color: PDFColors.success,
        },
        {
          label: '90+ Days',
          value: formatCurrencyPDF(report.summary.over90 || 0),
          color: PDFColors.warning,
        },
      ]);

      const columns: PDFTableColumn[] = [
        { header: 'Customer', key: 'customerName', width: 0.2 },
        {
          header: 'Current',
          key: 'current',
          width: 0.13,
          align: 'right',
          format: (v) => formatCurrencyPDF(v),
        },
        {
          header: '1-30',
          key: 'days30',
          width: 0.13,
          align: 'right',
          format: (v) => formatCurrencyPDF(v),
        },
        {
          header: '31-60',
          key: 'days60',
          width: 0.13,
          align: 'right',
          format: (v) => formatCurrencyPDF(v),
        },
        {
          header: '61-90',
          key: 'days90',
          width: 0.13,
          align: 'right',
          format: (v) => formatCurrencyPDF(v),
        },
        {
          header: '90+',
          key: 'over90',
          width: 0.13,
          align: 'right',
          format: (v) => formatCurrencyPDF(v),
        },
        {
          header: 'Total',
          key: 'totalOutstanding',
          width: 0.15,
          align: 'right',
          format: (v) => formatCurrencyPDF(v),
        },
      ];

      pdfGen.addTable(columns, report.data);
      pdfGen.end();
      return;
    }

    logger.info('Customer aging report generated', {
      userId,
      recordCount: report.recordCount,
    });

    res.json({ success: true, data: report });
  },

  /**
   * Generate Stock Aging Report
   * GET /api/reports/stock-aging
   */
  async getStockAging(req: Request, res: Response, pool: Pool) {
    const params = StockAgingParamsSchema.parse(req.query);
    const userId = req.user?.id;

    const report = await reportsService.generateStockAging(pool, {
      asOfDate: params.as_of_date ? params.as_of_date : undefined,
      categoryId: params.category_id,
      format: params.format,
      userId,
    });

    // PDF export
    if (params.format === 'pdf') {
      const companyName = await getCompanyName(pool);
      const pdfGen = new ReportPDFGenerator(companyName);
      const doc = pdfGen.getDocument();

      const date = getBusinessDate();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="stock-aging-${date}.pdf"`);
      doc.pipe(res);

      pdfGen.addHeader({
        companyName,
        title: 'Stock Aging Report',
        subtitle: params.as_of_date
          ? `As of ${formatDatePDF(params.as_of_date)}`
          : 'Current Stock',
        generatedAt: formatDateTime(),
      });

      pdfGen.addSummaryCards([
        {
          label: 'Total Batches',
          value: String(report.summary.totalBatches),
          color: PDFColors.primary,
        },
        {
          label: 'Total Value',
          value: formatCurrencyPDF(report.summary.totalValue),
          color: PDFColors.success,
        },
        {
          label: 'Avg Days in Stock',
          value: String(report.summary.averageDaysInStock),
          color: PDFColors.info,
        },
        {
          label: 'Oldest Batch',
          value: `${report.summary.oldestBatchDays} days`,
          color: PDFColors.warning,
        },
      ]);

      const columns: PDFTableColumn[] = [
        { header: 'Product', key: 'productName', width: 0.22 },
        { header: 'SKU', key: 'sku', width: 0.14 },
        { header: 'Batch', key: 'batchNumber', width: 0.16 },
        { header: 'Qty', key: 'remainingQuantity', width: 0.08, align: 'right' },
        {
          header: 'Value',
          key: 'totalValue',
          width: 0.14,
          align: 'right',
          format: (v) => formatCurrencyPDF(v),
        },
        { header: 'Days', key: 'daysInStock', width: 0.08, align: 'right' },
        { header: 'Expiry', key: 'expiryDate', width: 0.1 },
        {
          header: 'Days Left',
          key: 'daysUntilExpiry',
          width: 0.08,
          align: 'right',
          format: (v) => (v !== null ? String(v) : '-'),
        },
      ];

      pdfGen.addTable(columns, report.data);
      pdfGen.end();
      return;
    }

    logger.info('Stock aging report generated', {
      userId,
      recordCount: report.recordCount,
    });

    res.json({ success: true, data: report });
  },

  /**
   * Generate Waste & Damage Report
   * GET /api/reports/waste-damage
   */
  async getWasteDamage(req: Request, res: Response, pool: Pool) {
    const params = WasteDamageParamsSchema.parse(req.query);
    const userId = req.user?.id;

    const report = await reportsService.generateWasteDamageReport(pool, {
      startDate: params.start_date,
      endDate: params.end_date,
      reason: params.reason,
      format: params.format,
      userId,
    });

    // PDF export
    if (params.format === 'pdf') {
      const companyName = await getCompanyName(pool);
      const pdfGen = new ReportPDFGenerator(companyName);
      const doc = pdfGen.getDocument();

      const date = getBusinessDate();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="waste-damage-${date}.pdf"`);
      doc.pipe(res);

      const startDate = formatDatePDF(params.start_date);
      const endDate = formatDatePDF(params.end_date);

      pdfGen.addHeader({
        companyName,
        title: 'Waste & Damage Report',
        subtitle: `${startDate} to ${endDate}`,
        generatedAt: formatDateTime(),
      });

      pdfGen.addSummaryCards([
        {
          label: 'Total Events',
          value: String(report.summary.totalLossEvents),
          color: PDFColors.primary,
        },
        {
          label: 'Total Qty Lost',
          value: String(report.summary.totalQuantityLost),
          color: PDFColors.danger,
        },
        {
          label: 'Total Loss Value',
          value: formatCurrencyPDF(report.summary.totalLossValue),
          color: PDFColors.danger,
        },
        {
          label: 'Damage / Expiry',
          value: `${report.summary.damageCount} / ${report.summary.expiryCount}`,
          color: PDFColors.warning,
        },
      ]);

      const columns: PDFTableColumn[] = [
        { header: 'Date', key: 'lossDate', width: 0.12 },
        { header: 'Type', key: 'lossType', width: 0.1 },
        { header: 'Product', key: 'productName', width: 0.22 },
        { header: 'Batch', key: 'batchNumber', width: 0.14 },
        { header: 'Qty Lost', key: 'quantityLost', width: 0.1, align: 'right' },
        {
          header: 'Unit Cost',
          key: 'unitCost',
          width: 0.14,
          align: 'right',
          format: (v) => formatCurrencyPDF(v),
        },
        {
          header: 'Loss Value',
          key: 'totalLossValue',
          width: 0.18,
          align: 'right',
          format: (v) => formatCurrencyPDF(v),
        },
      ];

      pdfGen.addTable(columns, report.data);
      pdfGen.end();
      return;
    }

    logger.info('Waste & damage report generated', {
      userId,
      recordCount: report.recordCount,
    });

    res.json({ success: true, data: report });
  },

  /**
   * Generate Reorder Recommendations Report
   * GET /api/reports/reorder-recommendations
   */
  async getReorderRecommendations(req: Request, res: Response, pool: Pool) {
    const params = ReorderRecommendationsParamsSchema.parse(req.query);
    const userId = req.user?.id;

    const report = await reportsService.generateReorderRecommendations(pool, {
      categoryId: params.category_id,
      daysToConsider: params.days_to_consider,
      format: params.format,
      userId,
    });

    // PDF export
    if (params.format === 'pdf') {
      const companyName = await getCompanyName(pool);
      const pdfGen = new ReportPDFGenerator(companyName);
      const doc = pdfGen.getDocument();

      const date = getBusinessDate();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="reorder-recommendations-${date}.pdf"`
      );
      doc.pipe(res);

      pdfGen.addHeader({
        companyName,
        title: 'Smart Reorder AI Report',
        subtitle: `Analysis Period: ${params.days_to_consider || 30} Days | Lead Time Aware`,
        generatedAt: formatDateTime(),
      });

      pdfGen.addSummaryCards([
        {
          label: 'Products to Reorder',
          value: String(report.summary.totalProductsNeedingReorder),
          color: PDFColors.warning,
        },
        {
          label: 'Urgent Items',
          value: String(report.summary.urgentCount),
          color: PDFColors.danger,
        },
        {
          label: 'Est. Order Value',
          value: formatCurrencyPDF(report.summary.totalEstimatedCost),
          color: PDFColors.primary,
        },
        {
          label: 'Demand Trending Up',
          value: String(report.summary.trendingUp),
          color: PDFColors.info,
        },
      ]);

      const columns: PDFTableColumn[] = [
        { header: 'Product', key: 'productName', width: 0.18 },
        { header: 'Stock', key: 'currentStock', width: 0.07, align: 'right' },
        { header: 'Daily Avg', key: 'dailySalesVelocity', width: 0.08, align: 'right' },
        {
          header: 'Days Left',
          key: 'daysUntilStockout',
          width: 0.08,
          align: 'right',
          format: (v) => (v !== null ? String(v) : '-'),
        },
        {
          header: 'Lead Time',
          key: 'leadTimeDays',
          width: 0.08,
          align: 'right',
          format: (v) => `${v}d`,
        },
        { header: 'Safety', key: 'safetyStock', width: 0.07, align: 'right' },
        { header: 'Order Qty', key: 'suggestedOrderQuantity', width: 0.08, align: 'right' },
        { header: 'Trend', key: 'demandTrend', width: 0.1 },
        { header: 'Priority', key: 'priority', width: 0.08 },
        { header: 'Supplier', key: 'preferredSupplier', width: 0.18 },
      ];

      pdfGen.addTable(columns, report.data);
      pdfGen.end();
      return;
    }

    logger.info('Reorder recommendations report generated', {
      userId,
      recordCount: report.recordCount,
    });

    res.json({ success: true, data: report });
  },

  /**
   * Reorder Dashboard — Business-driven decision engine
   * GET /api/reports/reorder-dashboard
   */
  async getReorderDashboard(req: Request, res: Response, pool: Pool) {
    const category =
      typeof req.query.category === 'string'
        ? req.query.category
        : typeof req.query.category_id === 'string'
          ? req.query.category_id
          : undefined;
    const result = await reportsService.generateReorderDashboard(pool, { category });
    res.json({ success: true, data: result });
  },

  /**
   * Export selected reorder dashboard lines as PDF (no PO required).
   * POST /api/reports/reorder-dashboard/pdf
   * Body: { productIds: string[] }
   */
  async exportReorderDashboardPdf(req: Request, res: Response, pool: Pool) {
    const lines = await resolveReorderDashboardExportLines(req, pool);
    const companyName = await getCompanyName(pool);
    const pdfGen = new ReportPDFGenerator(companyName);
    const doc = pdfGen.getDocument();
    const date = getBusinessDate();
    const tableRows = buildReorderExportRows(lines);

    const totalCost = tableRows.reduce((sum, r) => sum + r.estCost, 0);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="reorder-intelligence-${date}.pdf"`
    );
    doc.pipe(res);

    pdfGen.addHeader({
      companyName,
      title: 'Reorder Intelligence — Selection',
      subtitle: `${lines.length} product(s) · ${date}`,
      generatedAt: formatDateTimePDF(new Date()),
    });

    pdfGen.addSummaryCards([
      {
        label: 'Lines',
        value: String(lines.length),
        color: PDFColors.primary,
      },
      {
        label: 'Est. Order Value',
        value: formatCurrencyPDF(totalCost),
        color: PDFColors.warning,
      },
    ]);

    const columns: PDFTableColumn[] = [
      { header: 'Product', key: 'name', width: 0.18 },
      { header: 'Category', key: 'category', width: 0.12 },
      { header: 'Stock', key: 'currentStock', width: 0.06, align: 'right' },
      { header: 'On PO', key: 'qtyOnOrder', width: 0.06, align: 'right' },
      { header: 'Order Qty', key: 'orderQty', width: 0.07, align: 'right' },
      {
        header: 'Est. Cost',
        key: 'estCost',
        width: 0.09,
        align: 'right',
        format: (v) => formatCurrencyPDF(v as number),
      },
      { header: 'Priority', key: 'priority', width: 0.08 },
      { header: 'Reason', key: 'reason', width: 0.2 },
      { header: 'Supplier', key: 'preferredSupplier', width: 0.14 },
    ];

    pdfGen.addTable(columns, tableRows);
    pdfGen.end();
  },

  /**
   * Export selected reorder dashboard lines as CSV (no PO required).
   * POST /api/reports/reorder-dashboard/csv
   */
  async exportReorderDashboardCsv(req: Request, res: Response, pool: Pool) {
    const lines = await resolveReorderDashboardExportLines(req, pool);
    const date = getBusinessDate();
    const csv = buildReorderDashboardCsv(lines);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="reorder-intelligence-${date}.csv"`
    );
    res.send(csv);
  },

  /**
   * Get list of available report types
   * GET /api/reports/types
   */
  async getReportTypes(req: Request, res: Response) {
    const reportTypes = [
      {
        id: 'inventory-valuation',
        name: 'Inventory Valuation',
        description: 'Current inventory value with FIFO/AVCO/LIFO methods',
        category: 'INVENTORY',
        parameters: ['as_of_date', 'category_id', 'valuation_method'],
      },
      {
        id: 'sales',
        name: 'Sales Report',
        description: 'Sales analysis grouped by various dimensions',
        category: 'SALES',
        parameters: ['start_date', 'end_date', 'group_by', 'customer_id'],
      },
      {
        id: 'expiring-items',
        name: 'Expiring Items',
        description: 'Items approaching or past expiry date',
        category: 'INVENTORY',
        parameters: ['days_threshold', 'category_id'],
      },
      {
        id: 'low-stock',
        name: 'Low Stock Alert',
        description: 'Items below reorder level',
        category: 'INVENTORY',
        parameters: ['threshold_percentage', 'category_id'],
      },
      {
        id: 'best-selling',
        name: 'Best Selling Products',
        description: 'Top selling products by quantity or revenue',
        category: 'SALES',
        parameters: ['start_date', 'end_date', 'limit', 'category_id'],
      },
      {
        id: 'supplier-cost-analysis',
        name: 'Supplier Cost Analysis',
        description: 'Supplier performance and cost metrics',
        category: 'PURCHASING',
        parameters: ['start_date', 'end_date', 'supplier_id'],
      },
      {
        id: 'goods-received',
        name: 'Goods Received',
        description: 'Detailed log of goods receipts',
        category: 'PURCHASING',
        parameters: ['start_date', 'end_date', 'supplier_id', 'product_id'],
      },
      {
        id: 'payments',
        name: 'Payment Report',
        description: 'Payment analysis by method',
        category: 'FINANCIAL',
        parameters: ['start_date', 'end_date', 'payment_method'],
      },
      {
        id: 'customer-payments',
        name: 'Customer Payments',
        description: 'Customer payment history and outstanding balances',
        category: 'FINANCIAL',
        parameters: ['start_date', 'end_date', 'customer_id', 'status'],
      },
      {
        id: 'profit-loss',
        name: 'Profit & Loss',
        description: 'Revenue, costs, and profitability analysis',
        category: 'FINANCIAL',
        parameters: ['start_date', 'end_date', 'group_by'],
      },
      {
        id: 'deleted-items',
        name: 'Deleted Items',
        description: 'Audit trail of deleted products',
        category: 'AUDIT',
        parameters: ['start_date', 'end_date'],
      },
      {
        id: 'inventory-adjustments',
        name: 'Inventory Adjustments',
        description: 'Stock adjustments and movements',
        category: 'INVENTORY',
        parameters: ['start_date', 'end_date', 'product_id'],
      },
      {
        id: 'purchase-order-summary',
        name: 'Purchase Order Summary',
        description: 'Overview of purchase orders by status and supplier',
        category: 'PURCHASING',
        parameters: ['start_date', 'end_date', 'status', 'supplier_id'],
      },
      {
        id: 'stock-movement-analysis',
        name: 'Stock Movement Analysis',
        description: 'Detailed analysis of stock movements and trends',
        category: 'INVENTORY',
        parameters: ['start_date', 'end_date', 'product_id', 'movement_type', 'group_by'],
      },
      {
        id: 'customer-account-statement',
        name: 'Customer Account Statement',
        description: 'Detailed customer account history and balances',
        category: 'FINANCIAL',
        parameters: ['customer_id', 'start_date', 'end_date'],
      },
      {
        id: 'profit-margin',
        name: 'Profit Margin by Product',
        description: 'Product-level profitability analysis',
        category: 'FINANCIAL',
        parameters: ['start_date', 'end_date', 'category_id', 'min_margin_percent'],
      },
      {
        id: 'daily-cash-flow',
        name: 'Daily Cash Flow',
        description: 'Daily cash in and out tracking',
        category: 'FINANCIAL',
        parameters: ['start_date', 'end_date', 'payment_method'],
      },
      {
        id: 'supplier-payment-status',
        name: 'Supplier Payment Status',
        description: 'Outstanding supplier payments and balances',
        category: 'PURCHASING',
        parameters: ['supplier_id', 'status'],
      },
      {
        id: 'top-customers',
        name: 'Top Customers',
        description: 'Customer ranking by revenue and purchases',
        category: 'SALES',
        parameters: ['start_date', 'end_date', 'limit', 'min_purchase_amount'],
      },
      {
        id: 'stock-aging',
        name: 'Stock Aging',
        description: 'Inventory aging analysis',
        category: 'INVENTORY',
        parameters: ['category_id', 'min_days_in_stock'],
      },
      {
        id: 'waste-damage',
        name: 'Waste & Damage',
        description: 'Track inventory losses from damage and expiry',
        category: 'AUDIT',
        parameters: ['start_date', 'end_date', 'product_id'],
      },
      {
        id: 'reorder-recommendations',
        name: 'Reorder Recommendations',
        description: 'Smart reorder suggestions based on sales velocity',
        category: 'INVENTORY',
        parameters: ['category_id', 'days_to_analyze'],
      },
      {
        id: 'delivery-notes',
        name: 'Delivery Notes',
        description: 'Delivery note listing with fulfillment status',
        category: 'SALES',
        parameters: ['start_date', 'end_date', 'customer_id', 'status'],
      },
      {
        id: 'quotations',
        name: 'Quotations',
        description: 'Quotation summary with conversion tracking',
        category: 'SALES',
        parameters: ['start_date', 'end_date', 'customer_id', 'status', 'quote_type'],
      },
      {
        id: 'manual-journal-entries',
        name: 'Manual Journal Entries',
        description: 'Manual journal entry audit log',
        category: 'FINANCIAL',
        parameters: ['start_date', 'end_date', 'status'],
      },
      {
        id: 'bank-transactions',
        name: 'Bank Transactions',
        description: 'Bank transaction listing with reconciliation status',
        category: 'FINANCIAL',
        parameters: ['start_date', 'end_date', 'bank_account_id', 'type', 'is_reconciled'],
      },
    ];

    res.json({ success: true, data: reportTypes });
  },

  /**
   * Generate Sales by Category Report
   * GET /api/reports/sales-by-category
   */
  async getSalesByCategory(req: Request, res: Response, pool: Pool) {
    const params = SalesByCategoryParamsSchema.parse(req.query);
    const userId = req.user?.id;

    const report = await reportsService.generateSalesByCategory(pool, {
      startDate: params.start_date,
      endDate: params.end_date,
      category: params.category,
      format: params.format,
      userId,
    });

    // PDF export
    if (params.format === 'pdf') {
      const companyName = await getCompanyName(pool);
      const pdfGen = new ReportPDFGenerator(companyName);
      const doc = pdfGen.getDocument();

      const date = getBusinessDate();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="sales-by-category-${date}.pdf"`);
      doc.pipe(res);

      const startDate = params.start_date
        ? formatDatePDF(params.start_date)
        : 'All Time';
      const endDate = params.end_date
        ? formatDatePDF(params.end_date)
        : 'Present';

      pdfGen.addHeader({
        companyName,
        title: 'Sales by Category Report',
        subtitle: params.category
          ? `Category: ${params.category} — ${startDate} to ${endDate}`
          : `All categories — ${startDate} to ${endDate}`,
        generatedAt: formatDateTime(),
      });

      pdfGen.addSummaryCards([
        {
          label: 'Total Categories',
          value: String(report.summary.totalCategories || 0),
          color: PDFColors.primary,
        },
        {
          label: 'Total Revenue',
          value: formatCurrencyPDF(report.summary.totalRevenue || 0),
          color: PDFColors.success,
        },
        {
          label: 'Total Profit',
          value: formatCurrencyPDF(report.summary.totalProfit || 0),
          color: PDFColors.secondary,
        },
        {
          label: 'Transactions',
          value: String(report.summary.totalTransactions || 0),
          color: PDFColors.info,
        },
      ]);

      const columns: PDFTableColumn[] = [
        { header: 'Category', key: 'category', width: 0.22 },
        { header: 'Products', key: 'productCount', width: 0.09, align: 'right' },
        { header: 'Qty Sold', key: 'totalQuantitySold', width: 0.09, align: 'right' },
        {
          header: 'Revenue',
          key: 'totalRevenue',
          width: 0.13,
          align: 'right',
          format: (v) => formatCurrencyPDF(v as number),
        },
        {
          header: 'Cost',
          key: 'totalCost',
          width: 0.12,
          align: 'right',
          format: (v) => formatCurrencyPDF(v as number),
        },
        {
          header: 'Gross Profit',
          key: 'grossProfit',
          width: 0.12,
          align: 'right',
          format: (v) => formatCurrencyPDF(v as number),
        },
        {
          header: 'Margin %',
          key: 'profitMargin',
          width: 0.09,
          align: 'right',
          format: (v) => String(v) + '%',
        },
        { header: 'Trans.', key: 'transactionCount', width: 0.08, align: 'right' },
        {
          header: 'Avg Trans.',
          key: 'averageTransactionValue',
          width: 0.06,
          align: 'right',
          format: (v) => formatCurrencyPDF(v as number),
        },
      ];

      // Ensure numeric values are passed raw; pdfGenerator will format using column formatters
      pdfGen.addTable(columns, report.data);
      pdfGen.end();
      return;
    }

    logger.info('Sales by category report generated', {
      userId,
      recordCount: report.recordCount,
    });

    res.json({ success: true, data: report });
  },

  /**
   * Generate Sales by Payment Method Report
   * GET /api/reports/sales-by-payment-method
   */
  async getSalesByPaymentMethod(req: Request, res: Response, pool: Pool) {
    const params = SalesByPaymentMethodParamsSchema.parse(req.query);
    const userId = req.user?.id;

    const report = await reportsService.generateSalesByPaymentMethod(pool, {
      startDate: params.start_date,
      endDate: params.end_date,
      format: params.format,
      userId,
    });

    // PDF export
    if (params.format === 'pdf') {
      const companyName = await getCompanyName(pool);
      const pdfGen = new ReportPDFGenerator(companyName);
      const doc = pdfGen.getDocument();

      const date = getBusinessDate();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="sales-by-payment-method-${date}.pdf"`
      );
      doc.pipe(res);

      const startDate = params.start_date
        ? formatDatePDF(params.start_date)
        : 'All Time';
      const endDate = params.end_date
        ? formatDatePDF(params.end_date)
        : 'Present';

      pdfGen.addHeader({
        companyName,
        title: 'Sales by Payment Method Report',
        subtitle: `Payment breakdown - ${startDate} to ${endDate}`,
        generatedAt: formatDateTime(),
      });

      pdfGen.addSummaryCards([
        {
          label: 'Payment Methods',
          value: String(report.summary.totalPaymentMethods || 0),
          color: PDFColors.primary,
        },
        {
          label: 'Total Revenue',
          value: formatCurrencyPDF(report.summary.totalRevenue || 0),
          color: PDFColors.success,
        },
        {
          label: 'Transactions',
          value: String(report.summary.totalTransactions || 0),
          color: PDFColors.info,
        },
        {
          label: 'Top Method',
          value: String(report.summary.topPaymentMethod || 'N/A'),
          color: PDFColors.secondary,
        },
      ]);

      const columns: PDFTableColumn[] = [
        { header: 'Payment Method', key: 'paymentMethod', width: 0.3 },
        { header: 'Transactions', key: 'transactionCount', width: 0.15, align: 'right' },
        {
          header: 'Total Revenue',
          key: 'totalRevenue',
          width: 0.2,
          align: 'right',
          format: (v) => formatCurrencyPDF(v as number),
        },
        {
          header: 'Avg Amount',
          key: 'averageAmount',
          width: 0.2,
          align: 'right',
          format: (v) => formatCurrencyPDF(v as number),
        },
        {
          header: '% of Total',
          key: 'percentageOfTotal',
          width: 0.15,
          align: 'right',
          format: (v) => String(v) + '%',
        },
      ];

      pdfGen.addTable(columns, report.data);
      pdfGen.end();
      return;
    }

    logger.info('Sales by payment method report generated', {
      userId,
      recordCount: report.recordCount,
    });

    res.json({ success: true, data: report });
  },

  /**
   * Generate Hourly Sales Analysis Report
   * GET /api/reports/hourly-sales-analysis
   */
  async getHourlySalesAnalysis(req: Request, res: Response, pool: Pool) {
    const params = HourlySalesAnalysisParamsSchema.parse(req.query);
    const userId = req.user?.id;

    const report = await reportsService.generateHourlySalesAnalysis(pool, {
      startDate: params.start_date,
      endDate: params.end_date,
      format: params.format,
      userId,
    });

    // PDF export
    if (params.format === 'pdf') {
      const companyName = await getCompanyName(pool);
      const pdfGen = new ReportPDFGenerator(companyName);
      const doc = pdfGen.getDocument();

      const date = getBusinessDate();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="hourly-sales-${date}.pdf"`);
      doc.pipe(res);

      const startDate = formatDatePDF(params.start_date);
      const endDate = formatDatePDF(params.end_date);

      pdfGen.addHeader({
        companyName,
        title: 'Hourly Sales Analysis Report',
        subtitle: `${startDate} to ${endDate}`,
        generatedAt: formatDateTime(),
      });

      pdfGen.addSummaryCards([
        {
          label: 'Peak Hour',
          value: String(report.summary.peakHour || 'N/A'),
          color: PDFColors.primary,
        },
        {
          label: 'Peak Revenue',
          value: formatCurrencyPDF(report.summary.peakHourRevenue || 0),
          color: PDFColors.success,
        },
        {
          label: 'Total Revenue',
          value: formatCurrencyPDF(report.summary.totalRevenue || 0),
          color: PDFColors.info,
        },
        {
          label: 'Avg/Hour',
          value: formatCurrencyPDF(
            report.summary.totalHours
              ? (report.summary.totalRevenue || 0) / report.summary.totalHours
              : 0
          ),
          color: PDFColors.secondary,
        },
      ]);

      const columns: PDFTableColumn[] = [
        { header: 'Hour', key: 'hour', width: 0.15 },
        { header: 'Transactions', key: 'transactionCount', width: 0.17, align: 'right' },
        {
          header: 'Revenue',
          key: 'totalRevenue',
          width: 0.22,
          align: 'right',
          format: (v) => formatCurrencyPDF(v),
        },
        {
          header: 'Avg Transaction',
          key: 'avgTransaction',
          width: 0.22,
          align: 'right',
          format: (v) => formatCurrencyPDF(v),
        },
        {
          header: '% of Total',
          key: 'percentOfTotal',
          width: 0.24,
          align: 'right',
          format: (v) => `${Number(v).toFixed(1)}%`,
        },
      ];

      pdfGen.addTable(columns, report.data);
      pdfGen.end();
      return;
    }

    logger.info('Hourly sales analysis report generated', {
      userId,
      recordCount: report.recordCount,
    });

    res.json({ success: true, data: report });
  },

  /**
   * Generate Sales Comparison Report
   * GET /api/reports/sales-comparison
   */
  async getSalesComparison(req: Request, res: Response, pool: Pool) {
    const params = SalesComparisonParamsSchema.parse(req.query);
    const userId = req.user?.id;

    const report = await reportsService.generateSalesComparison(pool, {
      currentStartDate: params.current_start_date,
      currentEndDate: params.current_end_date,
      previousStartDate: params.previous_start_date,
      previousEndDate: params.previous_end_date,
      groupBy: params.group_by,
      format: params.format,
      userId,
    });

    // PDF export
    if (params.format === 'pdf') {
      const companyName = await getCompanyName(pool);
      const pdfGen = new ReportPDFGenerator(companyName);
      const doc = pdfGen.getDocument();

      const date = getBusinessDate();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="sales-comparison-${date}.pdf"`);
      doc.pipe(res);

      const currentStart = formatDatePDF(params.current_start_date);
      const currentEnd = formatDatePDF(params.current_end_date);

      pdfGen.addHeader({
        companyName,
        title: 'Sales Comparison Report',
        subtitle: `Comparing periods ending ${currentEnd}`,
        generatedAt: formatDateTime(),
      });

      pdfGen.addSummaryCards([
        {
          label: 'Current Revenue',
          value: formatCurrencyPDF(report.summary.currentPeriodSales || 0),
          color: PDFColors.primary,
        },
        {
          label: 'Previous Revenue',
          value: formatCurrencyPDF(report.summary.previousPeriodSales || 0),
          color: PDFColors.secondary,
        },
        {
          label: 'Change %',
          value:
            report.summary.overallPercentageChange === null ||
            report.summary.overallPercentageChange === undefined
              ? '—'
              : `${Number(report.summary.overallPercentageChange).toFixed(1)}%`,
          color:
            (report.summary.overallPercentageChange ?? 0) >= 0
              ? PDFColors.success
              : PDFColors.danger,
        },
        {
          label: 'Growth',
          value: formatCurrencyPDF(report.summary.totalDifference || 0),
          color: PDFColors.info,
        },
      ]);

      const columns: PDFTableColumn[] = [
        { header: 'Current period', key: 'period', width: 0.14 },
        { header: 'Previous period', key: 'previousPeriod', width: 0.14 },
        {
          header: 'Current',
          key: 'currentSales',
          width: 0.16,
          align: 'right',
          format: (v) => formatCurrencyPDF(v),
        },
        {
          header: 'Previous',
          key: 'previousSales',
          width: 0.16,
          align: 'right',
          format: (v) => formatCurrencyPDF(v),
        },
        {
          header: 'Difference',
          key: 'difference',
          width: 0.16,
          align: 'right',
          format: (v) => formatCurrencyPDF(v),
        },
        {
          header: '% Change',
          key: 'percentageChange',
          width: 0.14,
          align: 'right',
          format: (v) =>
            v === null || v === undefined ? '—' : `${Number(v).toFixed(1)}%`,
        },
      ];

      pdfGen.addTable(columns, report.data);
      pdfGen.end();
      return;
    }

    logger.info('Sales comparison report generated', {
      userId,
      recordCount: report.recordCount,
    });

    res.json({ success: true, data: report });
  },

  /**
   * Generate Customer Purchase History Report
   * GET /api/reports/customer-purchase-history
   */
  async getCustomerPurchaseHistory(req: Request, res: Response, pool: Pool) {
    const params = CustomerPurchaseHistoryParamsSchema.parse(req.query);
    const userId = req.user?.id;

    const report = await reportsService.generateCustomerPurchaseHistory(pool, {
      customerId: params.customer_id,
      startDate: params.start_date,
      endDate: params.end_date,
      format: params.format,
      userId,
    });

    // PDF export
    if (params.format === 'pdf') {
      const companyName = await getCompanyName(pool);
      const pdfGen = new ReportPDFGenerator(companyName);
      const doc = pdfGen.getDocument();

      const date = getBusinessDate();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="customer-history-${date}.pdf"`);
      doc.pipe(res);

      const startDate = formatDatePDF(params.start_date);
      const endDate = formatDatePDF(params.end_date);
      const customerName =
        Array.isArray(report.data) && report.data.length > 0
          ? report.data[0]?.customerName || params.customer_id
          : params.customer_id;

      pdfGen.addHeader({
        companyName,
        title: 'Customer Purchase History',
        subtitle: `${customerName} - ${startDate} to ${endDate}`,
        generatedAt: formatDateTime(),
      });

      pdfGen.addSummaryCards([
        {
          label: 'Tickets',
          value: String(report.summary.totalPurchases || report.data?.length || 0),
          color: PDFColors.primary,
        },
        {
          label: 'Sales total',
          value: formatCurrencyPDF(report.summary.totalSpent || 0),
          color: PDFColors.info,
        },
        {
          label: 'Paid on tickets',
          value: formatCurrencyPDF(
            (report.data || []).reduce((s, r) => s + Number(r.amountPaid ?? 0), 0),
          ),
          color: PDFColors.success,
        },
        {
          label: 'Still due on tickets',
          value: formatCurrencyPDF(
            report.summary.totalOutstanding ??
              (report.data || []).reduce((s, r) => s + Number(r.outstandingBalance ?? 0), 0),
          ),
          color: PDFColors.danger,
        },
      ]);

      pdfGen.addSectionHeading('Sales tickets');

      const columns: PDFTableColumn[] = [
        {
          header: 'Date',
          key: 'saleDate',
          width: 0.12,
          format: (v) => (v ? formatDatePDF(String(v).slice(0, 10)) : ''),
        },
        { header: 'Sale #', key: 'saleNumber', width: 0.14 },
        {
          header: 'Method',
          key: 'paymentMethod',
          width: 0.14,
          format: (v) => String(v || '').replace(/_/g, ' '),
        },
        { header: 'Items', key: 'itemCount', width: 0.08, align: 'right' },
        {
          header: 'Total',
          key: 'totalAmount',
          width: 0.14,
          align: 'right',
          format: (v) => formatCurrencyPDF(v),
        },
        {
          header: 'Paid',
          key: 'amountPaid',
          width: 0.14,
          align: 'right',
          format: (v) => formatCurrencyPDF(v),
        },
        {
          header: 'Due',
          key: 'outstandingBalance',
          width: 0.12,
          align: 'right',
          format: (v) => formatCurrencyPDF(v),
        },
        { header: 'Status', key: 'status', width: 0.12 },
      ];

      pdfGen.addTable(columns, report.data || []);
      pdfGen.end();
      return;
    }

    logger.info('Customer purchase history report generated', {
      userId,
      customerId: params.customer_id,
      recordCount: report.recordCount,
    });

    res.json({ success: true, data: report });
  },

  /**
   * Generate Sales Summary by Date Report
   * GET /api/reports/sales-summary-by-date
   */
  async getSalesSummaryByDateReport(req: Request, res: Response, pool: Pool) {
    const {
      start_date,
      end_date,
      group_by: groupBy,
      format,
    } = SalesSummaryByDateQuerySchema.parse(req.query);
    const userId = req.user?.id;

    const filters: Record<string, string | number | Date | undefined> = {};
    if (start_date) filters.startDate = start_date;
    if (end_date) filters.endDate = end_date;

    // Import salesService
    const { salesService } = await import('../sales/salesService.js');
    const result = await salesService.getSalesSummaryByDate(
      pool,
      groupBy as 'day' | 'week' | 'month',
      filters
    );

    // Calculate summary using Decimal.js for precision
    // NOTE: Repository returns snake_case field names from PostgreSQL
    const summary =
      result.length > 0
        ? {
          totalRevenue: result
            .reduce(
              (sum: Decimal, item: Record<string, unknown>) => sum.plus(item.total_revenue || 0),
              new Decimal(0)
            )
            .toDecimalPlaces(2)
            .toNumber(),
          totalProfit: result
            .reduce(
              (sum: Decimal, item: Record<string, unknown>) => sum.plus(item.total_profit || 0),
              new Decimal(0)
            )
            .toDecimalPlaces(2)
            .toNumber(),
          totalTransactions: result.reduce(
            (sum: number, item: Record<string, unknown>) =>
              sum + parseInt(String(item.transaction_count ?? '0'), 10),
            0
          ),
          averageRevenue:
            result.length > 0
              ? result
                .reduce(
                  (sum: Decimal, item: Record<string, unknown>) =>
                    sum.plus(Number(item.total_revenue) || 0),
                  new Decimal(0)
                )
                .dividedBy(result.length)
                .toDecimalPlaces(2)
                .toNumber()
              : 0,
          periodCount: result.length,
        }
        : {
          totalRevenue: 0,
          totalProfit: 0,
          totalTransactions: 0,
          averageRevenue: 0,
          periodCount: 0,
        };

    // PDF export
    if (format === 'pdf') {
      const companyName = await getCompanyName(pool);
      const pdfGen = new ReportPDFGenerator(companyName);
      const doc = pdfGen.getDocument();

      const date = getBusinessDate();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="sales-summary-${groupBy}-${date}.pdf"`
      );
      doc.pipe(res);

      const startDate = start_date ? formatDatePDF(start_date as string) : 'All Time';
      const endDate = end_date ? formatDatePDF(end_date as string) : 'Present';

      pdfGen.addHeader({
        companyName,
        title: 'Sales Summary by Date',
        subtitle: `Grouped by ${groupBy.toUpperCase()} - ${startDate} to ${endDate}`,
        generatedAt: formatDateTime(),
      });

      pdfGen.addSummaryCards([
        {
          label: 'Total Revenue',
          value: formatCurrencyPDF(summary.totalRevenue),
          color: PDFColors.success,
        },
        {
          label: 'Total Profit',
          value: formatCurrencyPDF(summary.totalProfit),
          color: PDFColors.primary,
        },
        {
          label: 'Total Transactions',
          value: String(summary.totalTransactions),
          color: PDFColors.info,
        },
        {
          label: 'Avg Transaction',
          value: formatCurrencyPDF(summary.averageRevenue),
          color: PDFColors.secondary,
        },
      ]);

      const columns: PDFTableColumn[] = [
        { header: 'Period', key: 'period', width: 0.2 },
        { header: 'Transactions', key: 'transactionCount', width: 0.13 },
        {
          header: 'Revenue',
          key: 'totalRevenue',
          width: 0.15,
          align: 'right',
          format: (v) => formatCurrencyPDF(v),
        },
        {
          header: 'Cost',
          key: 'totalCost',
          width: 0.15,
          align: 'right',
          format: (v) => formatCurrencyPDF(v),
        },
        {
          header: 'Profit',
          key: 'totalProfit',
          width: 0.15,
          align: 'right',
          format: (v) => formatCurrencyPDF(v),
        },
        {
          header: 'Margin %',
          key: 'profitMarginPercentage',
          width: 0.12,
          align: 'right',
          format: (v) => v + '%',
        },
        {
          header: 'Avg Trans. Value',
          key: 'avgTransactionValue',
          width: 0.1,
          align: 'right',
          format: (v) => formatCurrencyPDF(v),
        },
      ];

      // Normalize snake_case DB rows to camelCase for PDF table columns
      const normalizedRows = result.map((row: Record<string, unknown>) => {
        const revenue = Number(row.total_revenue) || 0;
        const cost = Number(row.total_cost) || 0;
        const profit = Number(row.total_profit) || 0;
        const margin = revenue > 0 ? new Decimal(profit).dividedBy(revenue).times(100).toDecimalPlaces(1).toNumber() : 0;
        return {
          period: row.period,
          transactionCount: parseInt(String(row.transaction_count ?? '0'), 10),
          totalRevenue: revenue,
          totalCost: cost,
          totalProfit: profit,
          profitMarginPercentage: margin,
          avgTransactionValue: Number(row.avg_transaction_value) || 0,
        };
      });

      pdfGen.addTable(columns, normalizedRows);
      pdfGen.end();
      return;
    }

    // JSON response
    const report = {
      reportType: 'SALES_SUMMARY_BY_DATE',
      reportName: 'Sales Summary by Date',
      generatedAt: formatDateTime(),
      generatedBy: userId,
      parameters: { groupBy, ...filters, format },
      data: result,
      recordCount: result.length,
      executionTimeMs: 0,
      summary,
    };

    logger.info('Sales summary by date report generated', {
      userId,
      groupBy,
      recordCount: report.recordCount,
    });

    res.json({ success: true, data: report });
  },

  /**
   * Generate Sales Details Report
   * GET /api/reports/sales-details
   */
  async getSalesDetailsReport(req: Request, res: Response, pool: Pool) {
    const { start_date, end_date, product_id, format } = SalesDetailsQuerySchema.parse(req.query);
    const userId = req.user?.id;

    const filters: Record<string, string | number | Date | undefined> = {};
    if (start_date) filters.startDate = start_date;
    if (end_date) filters.endDate = end_date;
    if (product_id) filters.productId = product_id;

    // Import salesService
    const { salesService } = await import('../sales/salesService.js');
    const result = await salesService.getSalesDetailsReport(pool, filters);

    const summary =
      result.length > 0
        ? {
          totalQuantity: result
            .reduce(
              (sum: Decimal, item: Record<string, unknown>) => sum.plus(item.total_quantity || 0),
              new Decimal(0)
            )
            .toDecimalPlaces(3)
            .toNumber(),
          totalRevenue: result
            .reduce(
              (sum: Decimal, item: Record<string, unknown>) => sum.plus(item.total_revenue || 0),
              new Decimal(0)
            )
            .toDecimalPlaces(2)
            .toNumber(),
          avgProfitMargin:
            result.length > 0
              ? result
                .reduce(
                  (sum: Decimal, item: Record<string, unknown>) =>
                    sum.plus(item.profit_margin_percent || 0),
                  new Decimal(0)
                )
                .dividedBy(result.length)
                .toDecimalPlaces(2)
                .toNumber() + '%'
              : '0%',
          uniqueProducts: new Set(
            result.map((item: Record<string, unknown>) => item.product_name)
          ).size,
          transactionCount: result.reduce(
            (sum: number, item: Record<string, unknown>) =>
              sum + parseInt(String(item.transaction_count ?? '0'), 10),
            0
          ),
        }
        : {};

    // Handle PDF format
    if (format === 'pdf') {
      const companyName = await getCompanyName(pool);
      const pdfGen = new ReportPDFGenerator(companyName);
      const doc = pdfGen.getDocument();

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="sales-details-${getBusinessDate()}.pdf"`
      );
      doc.pipe(res);

      // Header
      pdfGen.addHeader({
        companyName,
        title: 'Sales Details Report',
        subtitle: `Product Sales by Date - ${filters.startDate ? formatDatePDF(filters.startDate as Date) : 'All'} to ${filters.endDate ? formatDatePDF(filters.endDate as Date) : 'All'}`,
        generatedAt: formatDateTime(),
      });

      // Summary cards
      pdfGen.addSummaryCards([
        {
          label: 'Total Revenue',
          value: formatCurrencyPDF(summary.totalRevenue || 0),
          color: PDFColors.success,
        },
        {
          label: 'Total Quantity',
          value: formatQuantityPDF(summary.totalQuantity || 0),
          color: PDFColors.info,
        },
        {
          label: 'Avg Profit Margin',
          value: summary.avgProfitMargin || '0%',
          color: PDFColors.primary,
        },
        {
          label: 'Transactions',
          value: String(summary.transactionCount || 0),
          color: PDFColors.secondary,
        },
      ]);

      // Table
      const columns: PDFTableColumn[] = [
        { header: 'Date', key: 'sale_date', width: 0.12, align: 'left' },
        { header: 'Product', key: 'product_name', width: 0.22, align: 'left' },
        { header: 'SKU', key: 'sku', width: 0.12, align: 'left' },
        { header: 'UOM', key: 'unit_of_measure', width: 0.08, align: 'center' },
        {
          header: 'Qty',
          key: 'total_quantity',
          width: 0.11,
          align: 'right',
          format: (v) => formatQuantityPDF(v),
        },
        {
          header: 'Avg Price',
          key: 'avg_unit_price',
          width: 0.11,
          align: 'right',
          format: (v) => formatCurrencyPDF(v),
        },
        {
          header: 'Revenue',
          key: 'total_revenue',
          width: 0.12,
          align: 'right',
          format: (v) => formatCurrencyPDF(v),
        },
        {
          header: 'Margin %',
          key: 'profit_margin_percent',
          width: 0.12,
          align: 'right',
          format: (v) => v + '%',
        },
      ];

      pdfGen.addTable(columns, result);
      pdfGen.end();
      return;
    }

    // JSON response
    const report = {
      reportType: 'SALES_DETAILS_REPORT',
      reportName: 'Sales Details Report',
      generatedAt: formatDateTime(),
      generatedBy: userId,
      parameters: { ...filters, format },
      data: result,
      recordCount: result.length,
      executionTimeMs: 0,
      summary,
    };

    logger.info('Sales details report generated', {
      userId,
      recordCount: report.recordCount,
    });

    res.json({ success: true, data: report });
  },

  /**
   * Generate Sales by Cashier Report
   * GET /api/reports/sales-by-cashier
   */
  async getSalesByCashierReport(req: Request, res: Response, pool: Pool) {
    const { start_date, end_date, user_id, cashier_id, ordered_by_id, product_id, format } =
      SalesByCashierQuerySchema.parse(req.query);
    const userId = req.user?.id;

    const filters: Record<string, string | undefined> = {};
    if (start_date) filters.startDate = start_date;
    if (end_date) filters.endDate = end_date;
    if (cashier_id) filters.cashierId = cashier_id;
    else if (user_id) filters.userId = user_id;   // legacy compat
    if (ordered_by_id) filters.orderedById = ordered_by_id;
    if (product_id) filters.productId = product_id;

    // Import salesService
    const { salesService } = await import('../sales/salesService.js');
    const result = await salesService.getSalesByCashierDetail(pool, filters);

    // Summary over line-level rows
    const summary =
      result.length > 0
        ? {
          totalLines: result.length,
          totalSales: [...new Set(result.map((r: Record<string, unknown>) => r.sale_number))].length,
          totalAmount: result
            .reduce(
              (sum: Decimal, r: Record<string, unknown>) =>
                sum.plus(Number(r.amount) || 0),
              new Decimal(0)
            )
            .toDecimalPlaces(2)
            .toNumber(),
          uniqueCashiers: [...new Set(result.map((r: Record<string, unknown>) => r.cashier))].length,
          uniqueOrderedBy: [...new Set(result.map((r: Record<string, unknown>) => r.ordered_by))].length,
        }
        : { totalLines: 0, totalSales: 0, totalAmount: 0, uniqueCashiers: 0, uniqueOrderedBy: 0 };

    // PDF export
    if (format === 'pdf') {
      const companyName = await getCompanyName(pool);
      const pdfGen = new ReportPDFGenerator(companyName);
      const doc = pdfGen.getDocument();

      const date = getBusinessDate();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="sales-by-cashier-${date}.pdf"`);
      doc.pipe(res);

      const startDate = start_date ? formatDatePDF(start_date as string) : 'All Time';
      const endDate = end_date ? formatDatePDF(end_date as string) : 'Present';

      pdfGen.addHeader({
        companyName,
        title: 'Sales by Cashier Report',
        subtitle: `Performance Overview - ${startDate} to ${endDate}`,
        generatedAt: formatDateTime(),
      });

      pdfGen.addSummaryCards([
        {
          label: 'Total Amount',
          value: formatCurrencyPDF(summary.totalAmount),
          color: PDFColors.success,
        },
        {
          label: 'Total Sales',
          value: String(summary.totalSales),
          color: PDFColors.info,
        },
        { label: 'Line Items', value: String(summary.totalLines), color: PDFColors.primary },
        {
          label: 'Cashiers',
          value: String(summary.uniqueCashiers),
          color: PDFColors.secondary,
        },
      ]);

      const columns: PDFTableColumn[] = [
        { header: 'Sale #', key: 'sale_number', width: 0.12 },
        {
          header: 'Date & Time',
          key: 'sale_date',
          width: 0.12,
          format: (v) => (v ? formatDateTimePDF(String(v)) : ''),
        },
        { header: 'Product', key: 'product_name', width: 0.22 },
        { header: 'Qty', key: 'quantity', width: 0.07, align: 'right' },
        {
          header: 'Amount',
          key: 'amount',
          width: 0.12,
          align: 'right',
          format: (v) => formatCurrencyPDF(v),
        },
        { header: 'Ordered By', key: 'ordered_by', width: 0.15 },
        { header: 'Cashier', key: 'cashier', width: 0.15 },
        { header: 'Payment', key: 'payment_method', width: 0.10 },
      ];

      pdfGen.addTable(columns, result);
      pdfGen.end();
      return;
    }

    // JSON response
    const report = {
      reportType: 'SALES_BY_CASHIER',
      reportName: 'Sales by Cashier',
      generatedAt: formatDateTime(),
      generatedBy: userId,
      parameters: { ...filters, format },
      data: result,
      recordCount: result.length,
      executionTimeMs: 0,
      summary,
    };

    logger.info('Sales by cashier report generated', {
      userId,
      recordCount: report.recordCount,
    });

    res.json({ success: true, data: report });
  },

  /**
   * Void Sales Report
   * GET /api/reports/void-sales
   */
  async getVoidSalesReport(req: Request, res: Response, pool: Pool) {
    const params = z.object({
      start_date: z.string().min(1),
      end_date: z.string().min(1),
      format: z.string().optional(),
    }).parse(req.query);

    const userId = req.user?.id;

    const report = await reportsService.generateVoidSalesReport(pool, {
      startDate: params.start_date,
      endDate: params.end_date,
      format: params.format as 'json' | 'pdf' | 'csv' | undefined,
      userId,
    });

    // PDF export
    if (params.format === 'pdf') {
      const companyName = await getCompanyName(pool);
      const pdfGen = new ReportPDFGenerator(companyName);
      const doc = pdfGen.getDocument();

      const date = getBusinessDate();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="void-sales-${date}.pdf"`);
      doc.pipe(res);

      pdfGen.addHeader({
        companyName,
        title: 'Void Sales Report',
        subtitle: `${formatDatePDF(params.start_date)} - ${formatDatePDF(params.end_date)}`,
        generatedAt: formatDateTime(),
      });

      pdfGen.addSummaryCards([
        { label: 'Voided sales', value: String(report.summary.voidedSaleCount), color: PDFColors.danger },
        { label: 'Voided amount', value: formatCurrencyPDF(report.summary.totalVoidedAmount), color: PDFColors.warning },
        { label: 'COGS voided', value: formatCurrencyPDF(report.summary.totalVoidedCost), color: PDFColors.info },
        { label: 'Lost profit', value: formatCurrencyPDF(report.summary.totalLostProfit), color: PDFColors.danger },
      ]);

      pdfGen.addSectionHeading('Void document register');

      const columns: PDFTableColumn[] = [
        { header: 'Sale #', key: 'saleNumber', width: 0.11 },
        { header: 'Sale date', key: 'saleDate', width: 0.08 },
        { header: 'Voided at', key: 'voidedAt', width: 0.1 },
        { header: 'Customer', key: 'customerName', width: 0.1 },
        { header: 'Amount', key: 'totalAmount', width: 0.09, align: 'right', format: (v) => formatCurrencyPDF(v) },
        { header: 'Profit lost', key: 'profit', width: 0.09, align: 'right', format: (v) => formatCurrencyPDF(v) },
        { header: 'Reason', key: 'voidReason', width: 0.14 },
        { header: 'Voided by', key: 'voidedBy', width: 0.1 },
        { header: 'Acct. doc', key: 'accountingDocNumber', width: 0.11 },
        { header: 'Items', key: 'itemCount', width: 0.08, align: 'right' },
      ];

      pdfGen.addTable(columns, report.data);

      if (report.byReason.length > 0) {
        pdfGen.addSectionHeading('By void reason');
        const reasonCols: PDFTableColumn[] = [
          { header: 'Reason', key: 'reason', width: 0.55 },
          { header: 'Count', key: 'count', width: 0.15, align: 'right' },
          {
            header: 'Amount',
            key: 'totalAmount',
            width: 0.3,
            align: 'right',
            format: (v) => formatCurrencyPDF(v),
          },
        ];
        pdfGen.addTable(reasonCols, report.byReason);
      }
      pdfGen.end();
      return;
    }

    logger.info('Void sales report generated', { userId, recordCount: report.recordCount });
    res.json({ success: true, data: report });
  },

  /**
   * Refund Report
   * GET /api/reports/refunds
   */
  async getRefundReport(req: Request, res: Response, pool: Pool) {
    const params = z.object({
      start_date: z.string().min(1),
      end_date: z.string().min(1),
      format: z.string().optional(),
    }).parse(req.query);

    const userId = req.user?.id;

    const report = await reportsService.generateRefundReport(pool, {
      startDate: params.start_date,
      endDate: params.end_date,
      format: params.format as 'json' | 'pdf' | 'csv' | undefined,
      userId,
    });

    // PDF export
    if (params.format === 'pdf') {
      const companyName = await getCompanyName(pool);
      const pdfGen = new ReportPDFGenerator(companyName);
      const doc = pdfGen.getDocument();

      const date = getBusinessDate();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="refund-report-${date}.pdf"`);
      doc.pipe(res);

      pdfGen.addHeader({
        companyName,
        title: 'Refund Report',
        subtitle: `${formatDatePDF(params.start_date)} - ${formatDatePDF(params.end_date)}`,
        generatedAt: formatDateTime(),
      });

      pdfGen.addSummaryCards([
        { label: 'Total Refunds', value: String(report.summary.refundCount), color: PDFColors.danger },
        { label: 'Revenue Reversed', value: formatCurrencyPDF(report.summary.totalRevenueReversal), color: PDFColors.warning },
        { label: 'COGS Reversed', value: formatCurrencyPDF(report.summary.totalCOGSReversal), color: PDFColors.info },
        { label: 'Profit Impact', value: formatCurrencyPDF(report.summary.netProfitImpact), color: PDFColors.danger },
        { label: 'Full / Partial', value: `${report.summary.fullRefundCount} / ${report.summary.partialRefundCount}`, color: PDFColors.secondary },
        { label: 'Stock Returned', value: `${report.summary.linesWithStockReturn} lines`, color: PDFColors.success },
      ]);

      // Document register — one row per refund (accounting docs may be comma-joined)
      const headerColumns: PDFTableColumn[] = [
        { header: 'Refund #', key: 'refundNumber', width: 0.11 },
        { header: 'Sale #', key: 'saleNumber', width: 0.1 },
        { header: 'Date', key: 'refundDate', width: 0.08 },
        { header: 'Customer', key: 'customerName', width: 0.1 },
        { header: 'Type', key: 'refundType', width: 0.07 },
        { header: 'Revenue Rev.', key: 'totalRevenueReversal', width: 0.1, align: 'right', format: (v) => formatCurrencyPDF(v) },
        { header: 'COGS Rev.', key: 'totalCOGSReversal', width: 0.09, align: 'right', format: (v) => formatCurrencyPDF(v) },
        { header: 'Profit Impact', key: 'netProfitImpact', width: 0.1, align: 'right', format: (v) => formatCurrencyPDF(v) },
        { header: 'Acct. Doc', key: 'accountingDocNumber', width: 0.13 },
        { header: 'Reason', key: 'reason', width: 0.12 },
      ];

      pdfGen.addSectionHeading('Refund document register');
      pdfGen.addTable(headerColumns, report.data);

      // Line-level detail table (one row per product line per refund)
      if (report.lineItems.length > 0) {
        pdfGen.addSectionHeading('Line-Level Detail');

        const lineColumns: PDFTableColumn[] = [
          { header: 'Refund #', key: 'refundNumber', width: 0.1 },
          { header: 'Product', key: 'productName', width: 0.14 },
          { header: 'Sold', key: 'originalSoldQty', width: 0.06, align: 'right' },
          { header: 'Refunded', key: 'refundedQty', width: 0.07, align: 'right' },
          { header: 'Remain', key: 'remainingQty', width: 0.06, align: 'right' },
          { header: 'Unit Price', key: 'unitSellingPrice', width: 0.09, align: 'right', format: (v) => formatCurrencyPDF(v) },
          { header: 'Unit COGS', key: 'unitCOGS', width: 0.09, align: 'right', format: (v) => formatCurrencyPDF(v) },
          { header: 'Rev. Reversed', key: 'lineRevenueReversed', width: 0.1, align: 'right', format: (v) => formatCurrencyPDF(v) },
          { header: 'Profit Impact', key: 'profitImpact', width: 0.1, align: 'right', format: (v) => formatCurrencyPDF(v) },
          { header: 'Stock', key: 'returnedToStock', width: 0.06, format: (v) => v ? 'Yes' : 'No' },
          { header: 'Batch', key: 'batchNumber', width: 0.13 },
        ];

        pdfGen.addTable(lineColumns, report.lineItems);
      }
      pdfGen.end();
      return;
    }

    logger.info('Refund report generated', { userId, recordCount: report.recordCount });
    res.json({ success: true, data: report });
  },

  /**
   * Unified Report Generation Dispatcher
   * POST /api/reports/generate
   * Routes to appropriate report controller based on reportType
   */
  async generateReport(req: Request, res: Response, pool: Pool) {
    const { reportType, ...params } = req.body;

    if (!reportType) {
      return res.status(400).json({
        success: false,
        error: 'Report type is required',
      });
    }

    // Create a proxy request object with custom query and params properties
    let queryParams: Record<string, unknown> = {};
    const requestParams: Record<string, string> = { ...req.params };
    const modifiedReq = new Proxy(req, {
      get(target, prop, receiver) {
        if (prop === 'query') {
          return queryParams;
        }
        if (prop === 'params') {
          return requestParams;
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as unknown as Request;

    // Route to appropriate controller based on reportType
    switch (reportType) {
      case 'INVENTORY_VALUATION':
        queryParams = {
          as_of_date: params.asOfDate,
          category_id: params.categoryId,
          valuation_method: params.valuationMethod,
          format: params.format,
        };
        return await reportsController.getInventoryValuation(modifiedReq, res, pool);

      case 'SALES_REPORT':
        queryParams = {
          start_date: params.startDate,
          end_date: params.endDate,
          group_by: params.groupBy,
          customer_id: params.customerId,
          session_id: params.sessionId,
          format: params.format,
        };
        return await reportsController.getSalesReport(modifiedReq, res, pool);

      case 'EXPIRING_ITEMS':
        queryParams = {
          days_threshold: params.daysAhead,
          category_id: params.categoryId,
          format: params.format,
        };
        return await reportsController.getExpiringItems(modifiedReq, res, pool);

      case 'LOW_STOCK':
        queryParams = {
          threshold_percentage: params.threshold,
          category_id: params.categoryId,
          format: params.format,
        };
        return await reportsController.getLowStock(modifiedReq, res, pool);

      case 'BEST_SELLING_PRODUCTS':
        queryParams = {
          start_date: params.startDate,
          end_date: params.endDate,
          limit: params.limit,
          category_id: params.categoryId,
          format: params.format,
        };
        return await reportsController.getBestSelling(modifiedReq, res, pool);

      case 'SUPPLIER_COST_ANALYSIS':
        queryParams = {
          start_date: params.startDate,
          end_date: params.endDate,
          supplier_id: params.supplierId,
          format: params.format,
        };
        return await reportsController.getSupplierCostAnalysis(modifiedReq, res, pool);

      case 'GOODS_RECEIVED':
        queryParams = {
          start_date: params.startDate,
          end_date: params.endDate,
          supplier_id: params.supplierId,
          product_id: params.productId,
          format: params.format,
        };
        return await reportsController.getGoodsReceived(modifiedReq, res, pool);

      case 'PAYMENT_REPORT':
        queryParams = {
          start_date: params.startDate,
          end_date: params.endDate,
          payment_method: params.paymentMethod,
          format: params.format,
        };
        return await reportsController.getPaymentReport(modifiedReq, res, pool);

      case 'CUSTOMER_PAYMENTS':
        queryParams = {
          start_date: params.startDate,
          end_date: params.endDate,
          customer_id: params.customerId,
          status: params.status,
          format: params.format,
        };
        return await reportsController.getCustomerPayments(modifiedReq, res, pool);

      case 'PROFIT_LOSS':
        queryParams = {
          start_date: params.startDate,
          end_date: params.endDate,
          group_by: params.groupBy,
          format: params.format,
        };
        return await reportsController.getProfitLoss(modifiedReq, res, pool);

      case 'DELETED_ITEMS':
        queryParams = {
          start_date: params.startDate,
          end_date: params.endDate,
          format: params.format,
        };
        return await reportsController.getDeletedItems(modifiedReq, res, pool);

      case 'INVENTORY_ADJUSTMENTS':
        queryParams = {
          start_date: params.startDate,
          end_date: params.endDate,
          product_id: params.productId,
          format: params.format,
        };
        return await reportsController.getInventoryAdjustments(modifiedReq, res, pool);

      case 'PURCHASE_ORDER_SUMMARY':
        queryParams = {
          start_date: params.startDate,
          end_date: params.endDate,
          status: params.status,
          supplier_id: params.supplierId,
          format: params.format,
        };
        return await reportsController.getPurchaseOrderSummary(modifiedReq, res, pool);

      case 'STOCK_MOVEMENT_ANALYSIS':
        queryParams = {
          start_date: params.startDate,
          end_date: params.endDate,
          product_id: params.productId,
          movement_type: params.movementType,
          format: params.format,
        };
        return await reportsController.getStockMovementAnalysis(modifiedReq, res, pool);

      case 'CUSTOMER_ACCOUNT_STATEMENT':
        queryParams = {
          customer_number: params.customerNumber,
          start_date: params.startDate,
          end_date: params.endDate,
          format: params.format || 'json',
        };
        return await reportsController.getCustomerAccountStatement(modifiedReq, res, pool);

      case 'PROFIT_MARGIN_BY_PRODUCT':
        queryParams = {
          start_date: params.startDate,
          end_date: params.endDate,
          category_id: params.categoryId,
          min_margin: params.minMargin,
          format: params.format,
        };
        return await reportsController.getProfitMarginByProduct(modifiedReq, res, pool);

      case 'DAILY_CASH_FLOW':
        queryParams = {
          start_date: params.startDate,
          end_date: params.endDate,
          format: params.format,
        };
        return await reportsController.getDailyCashFlow(modifiedReq, res, pool);

      case 'SUPPLIER_PAYMENT_STATUS':
        queryParams = {
          supplier_id: params.supplierId,
          status: params.status,
          start_date: params.startDate,
          end_date: params.endDate,
          format: params.format,
        };
        return await reportsController.getSupplierPaymentStatus(modifiedReq, res, pool);

      case 'TOP_CUSTOMERS':
        queryParams = {
          start_date: params.startDate,
          end_date: params.endDate,
          limit: params.limit,
          sort_by: params.sortBy,
          format: params.format,
        };
        return await reportsController.getTopCustomers(modifiedReq, res, pool);

      case 'CUSTOMER_AGING_REPORT':
        queryParams = {
          format: params.format,
          as_of_date: params.asOfDate || params.endDate,
        };
        return await reportsController.getCustomerAging(modifiedReq, res, pool);

      case 'STOCK_AGING':
        queryParams = {
          as_of_date: params.asOfDate,
          category_id: params.categoryId,
          format: params.format,
        };
        return await reportsController.getStockAging(modifiedReq, res, pool);

      case 'WASTE_DAMAGE_REPORT':
        queryParams = {
          start_date: params.startDate,
          end_date: params.endDate,
          reason: params.reason,
          format: params.format || 'json',
        };
        return await reportsController.getWasteDamage(modifiedReq, res, pool);

      case 'REORDER_RECOMMENDATIONS':
        queryParams = {
          category_id: params.categoryId,
          days_to_consider: params.daysToConsider,
          format: params.format,
        };
        return await reportsController.getReorderRecommendations(modifiedReq, res, pool);

      case 'SALES_BY_CATEGORY':
        queryParams = {
          start_date: params.startDate,
          end_date: params.endDate,
          category: params.category,
          format: params.format,
        };
        return await reportsController.getSalesByCategory(modifiedReq, res, pool);

      case 'SALES_BY_PAYMENT_METHOD':
        queryParams = {
          start_date: params.startDate,
          end_date: params.endDate,
          format: params.format,
        };
        return await reportsController.getSalesByPaymentMethod(modifiedReq, res, pool);

      case 'HOURLY_SALES_ANALYSIS':
        queryParams = {
          start_date: params.startDate,
          end_date: params.endDate,
          format: params.format,
        };
        return await reportsController.getHourlySalesAnalysis(modifiedReq, res, pool);

      case 'SALES_COMPARISON':
        queryParams = {
          current_start_date: params.currentStartDate,
          current_end_date: params.currentEndDate,
          previous_start_date: params.previousStartDate,
          previous_end_date: params.previousEndDate,
          group_by: params.groupBy,
          format: params.format,
        };
        return await reportsController.getSalesComparison(modifiedReq, res, pool);

      case 'CUSTOMER_PURCHASE_HISTORY':
        queryParams = {
          customer_id: params.customerId,
          start_date: params.startDate,
          end_date: params.endDate,
          format: params.format,
        };
        return await reportsController.getCustomerPurchaseHistory(modifiedReq, res, pool);

      case 'SALES_SUMMARY_BY_DATE':
        queryParams = {
          start_date: params.startDate,
          end_date: params.endDate,
          group_by: params.groupBy || 'day',
          format: params.format,
        };
        return await reportsController.getSalesSummaryByDateReport(modifiedReq, res, pool);

      case 'SALES_DETAILS_REPORT':
        queryParams = {
          start_date: params.startDate,
          end_date: params.endDate,
          product_id: params.productId,
          customer_id: params.customerId,
          format: params.format,
        };
        return await reportsController.getSalesDetailsReport(modifiedReq, res, pool);

      case 'SALES_BY_CASHIER':
        queryParams = {
          start_date: params.startDate,
          end_date: params.endDate,
          user_id: params.userId,
          cashier_id: params.cashierId,
          ordered_by_id: params.orderedById,
          product_id: params.productId,
          format: params.format,
        };
        return await reportsController.getSalesByCashierReport(modifiedReq, res, pool);

      case 'BUSINESS_POSITION':
        queryParams = {
          report_date: params.reportDate,
          include_comparisons: params.includeComparisons,
          include_forecasts: params.includeForecasts,
          format: params.format,
        };
        return await reportsController.getBusinessPositionReport(modifiedReq, res, pool);

      case 'CASH_REGISTER_SESSION':
        // Special case: session ID comes from params, set it in request params
        requestParams.sessionId = params.sessionId;
        return await reportsController.getCashRegisterSessionSummary(modifiedReq, res, pool);

      case 'CASH_REGISTER_MOVEMENT_BREAKDOWN':
        queryParams = {
          startDate: params.startDate,
          endDate: params.endDate,
          format: params.format,
        };
        return await reportsController.getCashRegisterMovementBreakdown(modifiedReq, res, pool);

      case 'CASH_REGISTER_SESSION_HISTORY':
        queryParams = {
          startDate: params.startDate,
          endDate: params.endDate,
          userId: params.cashierId,
          format: params.format,
        };
        return await reportsController.getCashRegisterSessionHistory(modifiedReq, res, pool);

      case 'DELIVERY_NOTES':
        queryParams = {
          start_date: params.startDate,
          end_date: params.endDate,
          customer_id: params.customerId,
          status: params.status,
          format: params.format,
        };
        return await reportsController.getDeliveryNoteReport(modifiedReq, res, pool);

      case 'QUOTATIONS':
        queryParams = {
          start_date: params.startDate,
          end_date: params.endDate,
          customer_id: params.customerId,
          status: params.status,
          quote_type: params.quoteType,
          format: params.format,
        };
        return await reportsController.getQuotationReport(modifiedReq, res, pool);

      case 'MANUAL_JOURNAL_ENTRIES':
        queryParams = {
          start_date: params.startDate,
          end_date: params.endDate,
          status: params.status,
          format: params.format,
        };
        return await reportsController.getManualJournalEntryReport(modifiedReq, res, pool);

      case 'BANK_TRANSACTIONS':
        queryParams = {
          start_date: params.startDate,
          end_date: params.endDate,
          bank_account_id: params.bankAccountId,
          type: params.type,
          is_reconciled: params.isReconciled,
          format: params.format,
        };
        return await reportsController.getBankTransactionReport(modifiedReq, res, pool);

      // ── Void & Refund Reports ──────────────────────────────────
      case 'VOID_SALES_REPORT':
        queryParams = {
          start_date: params.startDate,
          end_date: params.endDate,
          format: params.format,
        };
        return await reportsController.getVoidSalesReport(modifiedReq, res, pool);

      case 'REFUND_REPORT':
        queryParams = {
          start_date: params.startDate,
          end_date: params.endDate,
          format: params.format,
        };
        return await reportsController.getRefundReport(modifiedReq, res, pool);

      // ── Credit / Debit Note Reports ──────────────────────────────
      case 'SALES_RETURNS_ALLOWANCES':
        queryParams = {
          startDate: params.startDate,
          endDate: params.endDate,
        };
        return await cnDnReportsController.getSalesReturns(modifiedReq, res, pool);

      case 'PURCHASE_RETURNS_ALLOWANCES':
        queryParams = {
          startDate: params.startDate,
          endDate: params.endDate,
        };
        return await cnDnReportsController.getPurchaseReturns(modifiedReq, res, pool);

      case 'AR_LEDGER':
        queryParams = {
          startDate: params.startDate,
          endDate: params.endDate,
          customerId: params.customerId,
        };
        return await cnDnReportsController.getArLedger(modifiedReq, res, pool);

      case 'AP_LEDGER':
        queryParams = {
          startDate: params.startDate,
          endDate: params.endDate,
          supplierId: params.supplierId,
        };
        return await cnDnReportsController.getApLedger(modifiedReq, res, pool);

      case 'NOTE_REGISTER':
        queryParams = {
          startDate: params.startDate,
          endDate: params.endDate,
          side: params.side,
          documentType: params.documentType,
          status: params.status,
        };
        return await cnDnReportsController.getNoteRegister(modifiedReq, res, pool);

      case 'TAX_REVERSAL':
        queryParams = {
          startDate: params.startDate,
          endDate: params.endDate,
        };
        return await cnDnReportsController.getTaxReversal(modifiedReq, res, pool);

      case 'SUPPLIER_STATEMENT':
        requestParams.supplierId = params.supplierId;
        queryParams = {
          startDate: params.startDate,
          endDate: params.endDate,
          start_date: params.startDate,
          end_date: params.endDate,
          format: params.format,
        };
        return await cnDnReportsController.getSupplierStatement(modifiedReq, res, pool);

      case 'SUPPLIER_AGING':
        return await cnDnReportsController.getSupplierAging(modifiedReq, res, pool);

      case 'INVOICE_ADJUSTMENTS':
        requestParams.invoiceId = params.invoiceId;
        queryParams = {
          side: params.side,
        };
        return await cnDnReportsController.getInvoiceAdjustments(modifiedReq, res, pool);

      // ── Orders Reports ──────────────────────────────
      case 'ORDERS_REPORT':
        queryParams = {
          start_date: params.startDate,
          end_date: params.endDate,
          status: params.status,
          user_id: params.userId,
          format: params.format,
        };
        return await reportsController.getOrdersReport(modifiedReq, res, pool);

      case 'CANCELLED_ORDERS_REPORT':
        queryParams = {
          start_date: params.startDate,
          end_date: params.endDate,
          user_id: params.userId,
          format: params.format,
        };
        return await reportsController.getCancelledOrdersReport(modifiedReq, res, pool);

      case 'CATEGORY_INTELLIGENCE':
        queryParams = {
          category: params.category,
          report_type: params.reportType2 ?? 'FULL_STATEMENT',
          start_date: params.startDate,
          end_date: params.endDate,
          days_ahead: params.daysAhead,
          format: params.format,
        };
        return await reportsController.getCategoryIntelligenceReport(modifiedReq, res, pool);

      default:
        return res.status(400).json({
          success: false,
          error: `Unknown report type: ${reportType}`,
        });
    }
  },

  /**
   * Generate Comprehensive Business Position Report
   * GET /api/reports/business-position
   */
  async getBusinessPositionReport(req: Request, res: Response, pool: Pool) {
    const reportDate = (req.query.report_date as string) || getBusinessDate();
    const includeComparisons = req.query.include_comparisons === 'true';
    const includeForecasts = req.query.include_forecasts === 'true';
    const format = (req.query.format as string) || 'json';
    const userId = req.user?.id;

    const report = await reportsService.generateBusinessPositionReport(pool, {
      reportDate,
      includeComparisons,
      includeForecasts,
      format: format as 'json' | 'pdf' | 'csv',
      userId,
    });

    // PDF export handling
    if (format === 'pdf') {
      const companyName = await getCompanyName(pool);
      const pdfGen = new ReportPDFGenerator(companyName);
      const doc = pdfGen.getDocument();

      const date = reportDate;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="business-position-${date}.pdf"`);
      doc.pipe(res);

      pdfGen.addHeader({
        companyName,
        title: 'Business Position Report',
        subtitle: `Comprehensive Business Health Assessment - ${formatDate(reportDate)}`,
        generatedAt: formatDateTime(),
      });

      // Business Health Score Section
      pdfGen.addSummaryCards([
        {
          label: 'Business Health Score',
          value: `${report.data.businessHealthScore}/100`,
          color:
            report.data.businessHealthScore >= 80
              ? PDFColors.success
              : report.data.businessHealthScore >= 60
                ? PDFColors.warning
                : PDFColors.danger,
        },
        {
          label: 'Total Revenue',
          value: formatCurrencyPDF(report.data.salesPerformance.totalRevenue),
          color: PDFColors.primary,
        },
        {
          label: 'Gross Profit',
          value: formatCurrencyPDF(report.data.salesPerformance.grossProfit),
          color: PDFColors.success,
        },
        {
          label: 'Cash Position',
          value: formatCurrencyPDF(report.data.cashPosition.totalCashIn),
          color: PDFColors.info,
        },
      ]);

      // Sales Performance Section
      pdfGen.addSectionHeading('Sales Performance');

      const salesColumns: PDFTableColumn[] = [
        { header: 'Metric', key: 'metric', width: 0.6 },
        { header: 'Value', key: 'value', width: 0.4, align: 'right' },
      ];

      const salesData = [
        {
          metric: 'Total Transactions',
          value: String(report.data.salesPerformance.transactionsCount),
        },
        { metric: 'Unique Customers', value: String(report.data.salesPerformance.uniqueCustomers) },
        {
          metric: 'Average Transaction',
          value: formatCurrencyPDF(report.data.salesPerformance.avgTransactionValue),
        },
        {
          metric: 'Walk-in Revenue',
          value: formatCurrencyPDF(report.data.salesPerformance.walkInRevenue),
        },
        {
          metric: 'Customer Revenue',
          value: formatCurrencyPDF(report.data.salesPerformance.customerRevenue),
        },
      ];

      pdfGen.addTable(salesColumns, salesData);

      // Collections Performance Section
      pdfGen.addSectionHeading('Collections Performance');

      const collectionsData = [
        {
          metric: 'Collection Transactions',
          value: String(report.data.collectionsPerformance.collectionTransactions),
        },
        {
          metric: 'Total Collections',
          value: formatCurrencyPDF(report.data.collectionsPerformance.totalCollections),
        },
        {
          metric: 'Average Collection',
          value: formatCurrencyPDF(report.data.collectionsPerformance.avgCollectionValue),
        },
        {
          metric: 'Paying Customers',
          value: String(report.data.collectionsPerformance.payingCustomers),
        },
      ];

      pdfGen.addTable(salesColumns, collectionsData);

      // Risk Assessment Section
      pdfGen.addSectionHeading('Risk Assessment');

      const riskData = [
        { metric: 'Receivables Risk', value: report.data.riskAssessment.receivablesRisk },
        { metric: 'Inventory Risk', value: report.data.riskAssessment.inventoryRisk },
        { metric: 'Overall Risk Level', value: report.data.riskAssessment.overallRiskLevel },
      ];

      pdfGen.addTable(salesColumns, riskData);

      // Recommendations Section
      if (report.data.enhancedAnalysis.recommendations.length > 0) {
        pdfGen.addSectionHeading('Business Recommendations');

        const recommendationsColumns: PDFTableColumn[] = [
          { header: 'Priority', key: 'priority', width: 0.15 },
          { header: 'Category', key: 'category', width: 0.2 },
          { header: 'Recommendation', key: 'message', width: 0.45 },
          { header: 'Impact', key: 'impact', width: 0.2 },
        ];

        pdfGen.addTable(recommendationsColumns, report.data.enhancedAnalysis.recommendations);
      }

      pdfGen.end();
      return;
    }

    logger.info('Business position report generated', {
      userId,
      businessHealthScore: report.data.businessHealthScore,
      reportDate: reportDate,
    });

    res.json({ success: true, data: report });
  },

  // ===========================================================================
  // CASH REGISTER SESSION REPORTS
  // ===========================================================================

  /**
   * Get Cash Register Session Summary Report
   * GET /api/reports/cash-register/session/:sessionId
   *
   * Returns detailed session summary with movement breakdown
   */
  async getCashRegisterSessionSummary(req: Request, res: Response, pool: Pool) {
    const { sessionId } = req.params;

    if (!sessionId) {
      return res.status(400).json({
        success: false,
        error: 'Session ID is required',
      });
    }

    const report = await reportsRepository.getCashRegisterSessionSummary(pool, sessionId);

    if (!report) {
      return res.status(404).json({
        success: false,
        error: 'Session not found',
      });
    }

    logger.info('Cash register session summary generated', {
      userId: req.user?.id,
      sessionId,
      sessionNumber: report.session.sessionNumber,
    });

    res.json({ success: true, data: report });
  },

  /**
   * Get Cash Register Movement Breakdown Report
   * GET /api/reports/cash-register/movement-breakdown
   * Query params: startDate, endDate, registerId?, userId?
   *
   * Returns aggregate movement data across sessions for a date range
   */
  async getCashRegisterMovementBreakdown(req: Request, res: Response, pool: Pool) {
    const {
      startDate,
      endDate,
      registerId,
      userId: filterUserId,
    } = CashRegisterDateRangeSchema.parse(req.query);

    const report = await reportsRepository.getCashRegisterMovementBreakdown(pool, {
      startDate,
      endDate,
      registerId,
      userId: filterUserId,
    });

    logger.info('Cash register movement breakdown generated', {
      userId: req.user?.id,
      startDate,
      endDate,
      sessionCount: report.totals.sessionCount,
      movementCount: report.totals.movementCount,
    });

    res.json({ success: true, data: report });
  },

  /**
   * Get Cash Register Session History Report
   * GET /api/reports/cash-register/session-history
   * Query params: startDate, endDate, registerId?, userId?, status?
   *
   * Returns list of sessions with summary stats for a date range
   */
  async getCashRegisterSessionHistory(req: Request, res: Response, pool: Pool) {
    const {
      startDate,
      endDate,
      registerId,
      userId: filterUserId,
      status,
    } = CashRegisterSessionHistorySchema.parse(req.query);

    const report = await reportsRepository.getCashRegisterSessionHistory(pool, {
      startDate,
      endDate,
      registerId,
      userId: filterUserId,
      status,
    });

    logger.info('Cash register session history generated', {
      userId: req.user?.id,
      startDate,
      endDate,
      totalSessions: report.summary.totalSessions,
    });

    res.json({ success: true, data: report });
  },

  // ── Delivery Notes Report ──
  async getDeliveryNoteReport(req: Request, res: Response, pool: Pool) {
    const params = DeliveryNoteReportParamsSchema.parse(req.query);
    const userId = req.user?.id;

    const report = await reportsService.generateDeliveryNoteReport(pool, {
      startDate: params.start_date,
      endDate: params.end_date,
      customerId: params.customer_id,
      status: params.status,
      format: params.format,
      userId,
    });

    if (params.format === 'pdf') {
      const companyName = await getCompanyName(pool);
      const pdfGen = new ReportPDFGenerator(companyName);
      const doc = pdfGen.getDocument();

      const date = getBusinessDate();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="delivery-notes-${date}.pdf"`);
      doc.pipe(res);

      pdfGen.addHeader({
        companyName,
        title: 'Delivery Notes Report',
        subtitle: `${params.start_date} to ${params.end_date}`,
        generatedAt: formatDateTime(),
      });

      pdfGen.addSummaryCards([
        { label: 'Total DNs', value: String(report.summary.totalDeliveryNotes), color: PDFColors.primary },
        { label: 'Total Value', value: formatCurrencyPDF(report.summary.totalValue), color: PDFColors.success },
        { label: 'Posted', value: String(report.summary.postedCount), color: PDFColors.info },
        { label: 'Draft', value: String(report.summary.draftCount), color: PDFColors.warning },
      ]);

      const columns: PDFTableColumn[] = [
        { header: 'DN Number', key: 'deliveryNoteNumber', width: 0.15 },
        { header: 'Customer', key: 'customerName', width: 0.2 },
        { header: 'Date', key: 'deliveryDate', width: 0.1 },
        { header: 'Status', key: 'status', width: 0.1 },
        { header: 'Lines', key: 'lineCount', width: 0.07, align: 'right' },
        { header: 'Total', key: 'totalAmount', width: 0.13, align: 'right', format: (v) => formatCurrencyPDF(v as number) },
        { header: 'Quote', key: 'quotationNumber', width: 0.12 },
        { header: 'Driver', key: 'driverName', width: 0.13 },
      ];

      pdfGen.addTable(columns, report.data);
      pdfGen.end();
      return;
    }

    logger.info('Delivery notes report generated', { userId, recordCount: report.recordCount });
    res.json({ success: true, data: report });
  },

  // ── Quotation Report ──
  async getQuotationReport(req: Request, res: Response, pool: Pool) {
    const params = QuotationReportParamsSchema.parse(req.query);
    const userId = req.user?.id;

    const report = await reportsService.generateQuotationReport(pool, {
      startDate: params.start_date,
      endDate: params.end_date,
      customerId: params.customer_id,
      status: params.status,
      quoteType: params.quote_type,
      format: params.format,
      userId,
    });

    if (params.format === 'pdf') {
      const companyName = await getCompanyName(pool);
      const pdfGen = new ReportPDFGenerator(companyName);
      const doc = pdfGen.getDocument();

      const date = getBusinessDate();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="quotations-${date}.pdf"`);
      doc.pipe(res);

      pdfGen.addHeader({
        companyName,
        title: 'Quotation Report',
        subtitle: `${params.start_date} to ${params.end_date}`,
        generatedAt: formatDateTime(),
      });

      pdfGen.addSummaryCards([
        { label: 'Total Quotes', value: String(report.summary.totalQuotations), color: PDFColors.primary },
        { label: 'Total Value', value: formatCurrencyPDF(report.summary.totalValue), color: PDFColors.success },
        { label: 'Converted', value: String(report.summary.convertedCount), color: PDFColors.info },
        { label: 'Conversion Rate', value: `${report.summary.conversionRate}%`, color: PDFColors.secondary },
      ]);

      const columns: PDFTableColumn[] = [
        { header: 'Quote #', key: 'quoteNumber', width: 0.14 },
        { header: 'Customer', key: 'customerName', width: 0.2 },
        { header: 'Type', key: 'quoteType', width: 0.08 },
        { header: 'Status', key: 'status', width: 0.1 },
        { header: 'Subtotal', key: 'subtotal', width: 0.12, align: 'right', format: (v) => formatCurrencyPDF(v as number) },
        { header: 'Tax', key: 'taxAmount', width: 0.1, align: 'right', format: (v) => formatCurrencyPDF(v as number) },
        { header: 'Total', key: 'totalAmount', width: 0.13, align: 'right', format: (v) => formatCurrencyPDF(v as number) },
        { header: 'Valid Until', key: 'validUntil', width: 0.13 },
      ];

      pdfGen.addTable(columns, report.data);
      pdfGen.end();
      return;
    }

    logger.info('Quotation report generated', { userId, recordCount: report.recordCount });
    res.json({ success: true, data: report });
  },

  // ── Manual Journal Entry Report ──
  async getManualJournalEntryReport(req: Request, res: Response, pool: Pool) {
    const params = ManualJournalEntryReportParamsSchema.parse(req.query);
    const userId = req.user?.id;

    const report = await reportsService.generateManualJournalEntryReport(pool, {
      startDate: params.start_date,
      endDate: params.end_date,
      status: params.status,
      format: params.format,
      userId,
    });

    if (params.format === 'pdf') {
      const companyName = await getCompanyName(pool);
      const pdfGen = new ReportPDFGenerator(companyName);
      const doc = pdfGen.getDocument();

      const date = getBusinessDate();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="journal-entries-${date}.pdf"`);
      doc.pipe(res);

      pdfGen.addHeader({
        companyName,
        title: 'Manual Journal Entries Report',
        subtitle: `${params.start_date} to ${params.end_date}`,
        generatedAt: formatDateTime(),
      });

      pdfGen.addSummaryCards([
        { label: 'Total Entries', value: String(report.summary.totalEntries), color: PDFColors.primary },
        { label: 'Total Debit', value: formatCurrencyPDF(report.summary.totalDebit), color: PDFColors.success },
        { label: 'Total Credit', value: formatCurrencyPDF(report.summary.totalCredit), color: PDFColors.info },
        { label: 'Reversed', value: String(report.summary.reversedCount), color: PDFColors.warning },
      ]);

      const columns: PDFTableColumn[] = [
        { header: 'Entry #', key: 'entryNumber', width: 0.12 },
        { header: 'Date', key: 'entryDate', width: 0.1 },
        { header: 'Narration', key: 'narration', width: 0.28 },
        { header: 'Reference', key: 'reference', width: 0.1 },
        { header: 'Debit', key: 'totalDebit', width: 0.12, align: 'right', format: (v) => formatCurrencyPDF(v as number) },
        { header: 'Credit', key: 'totalCredit', width: 0.12, align: 'right', format: (v) => formatCurrencyPDF(v as number) },
        { header: 'Status', key: 'status', width: 0.08 },
        { header: 'Lines', key: 'lineCount', width: 0.08, align: 'right' },
      ];

      pdfGen.addTable(columns, report.data);
      pdfGen.end();
      return;
    }

    logger.info('Manual journal entries report generated', { userId, recordCount: report.recordCount });
    res.json({ success: true, data: report });
  },

  // ── Bank Transaction Report ──
  async getBankTransactionReport(req: Request, res: Response, pool: Pool) {
    const params = BankTransactionReportParamsSchema.parse(req.query);
    const userId = req.user?.id;

    const report = await reportsService.generateBankTransactionReport(pool, {
      startDate: params.start_date,
      endDate: params.end_date,
      bankAccountId: params.bank_account_id,
      type: params.type,
      isReconciled: params.is_reconciled === 'true' ? true : params.is_reconciled === 'false' ? false : undefined,
      format: params.format,
      userId,
    });

    if (params.format === 'pdf') {
      const companyName = await getCompanyName(pool);
      const pdfGen = new ReportPDFGenerator(companyName);
      const doc = pdfGen.getDocument();

      const date = getBusinessDate();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="bank-transactions-${date}.pdf"`);
      doc.pipe(res);

      pdfGen.addHeader({
        companyName,
        title: 'Bank Transactions Report',
        subtitle: `${params.start_date} to ${params.end_date}`,
        generatedAt: formatDateTime(),
      });

      pdfGen.addSummaryCards([
        { label: 'Transactions', value: String(report.summary.totalTransactions), color: PDFColors.primary },
        { label: 'Total Deposits', value: formatCurrencyPDF(report.summary.totalDeposits), color: PDFColors.success },
        { label: 'Total Withdrawals', value: formatCurrencyPDF(report.summary.totalWithdrawals), color: PDFColors.danger },
        { label: 'Net Flow', value: formatCurrencyPDF(report.summary.netFlow), color: PDFColors.info },
      ]);

      const columns: PDFTableColumn[] = [
        { header: 'Txn #', key: 'transactionNumber', width: 0.12 },
        { header: 'Account', key: 'bankAccountName', width: 0.15 },
        { header: 'Date', key: 'transactionDate', width: 0.1 },
        { header: 'Type', key: 'type', width: 0.1 },
        { header: 'Description', key: 'description', width: 0.2 },
        { header: 'Amount', key: 'amount', width: 0.13, align: 'right', format: (v) => formatCurrencyPDF(v as number) },
        { header: 'Balance', key: 'runningBalance', width: 0.12, align: 'right', format: (v) => v != null ? formatCurrencyPDF(v as number) : '—' },
        { header: 'Recon', key: 'isReconciled', width: 0.08, format: (v) => v ? 'Yes' : 'No' },
      ];

      pdfGen.addTable(columns, report.data);
      pdfGen.end();
      return;
    }

    logger.info('Bank transactions report generated', { userId, recordCount: report.recordCount });
    res.json({ success: true, data: report });
  },

  /**
   * Orders Report — all orders with creator/canceller details
   * GET /api/reports/orders-report
   */
  async getOrdersReport(req: Request, res: Response, pool: Pool) {
    const { start_date, end_date, status, user_id, format, columns } = OrdersReportQuerySchema.parse(req.query);
    const userId = req.user?.id;

    const conditions: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (start_date) {
      conditions.push(`o.order_date >= $${idx++}`);
      values.push(start_date);
    }
    if (end_date) {
      conditions.push(`o.order_date <= $${idx++}`);
      values.push(end_date);
    }
    if (status) {
      conditions.push(`o.status = $${idx++}`);
      values.push(status);
    }
    if (user_id) {
      conditions.push(`o.created_by = $${idx++}`);
      values.push(user_id);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await pool.query(
      `SELECT
        o.order_number     AS "orderNumber",
        o.order_date       AS "orderDate",
        o.status,
        c.name             AS "customerName",
        o.total_amount     AS "totalAmount",
        o.discount_amount  AS "discountAmount",
        uc.full_name       AS "createdBy",
        ua.full_name       AS "assignedCashier",
        o.completed_at     AS "completedAt",
        o.cancelled_at     AS "cancelledAt",
        ucx.full_name      AS "cancelledBy",
        o.cancel_reason    AS "cancelReason",
        o.notes,
        o.created_at       AS "createdAt",
        (SELECT COUNT(*) FROM pos_order_items WHERE order_id = o.id)::int AS "itemCount"
      FROM pos_orders o
      LEFT JOIN customers c ON c.id = o.customer_id
      LEFT JOIN users uc ON uc.id = o.created_by
      LEFT JOIN users ua ON ua.id = o.assigned_cashier_id
      LEFT JOIN users ucx ON ucx.id = o.cancelled_by
      ${whereClause}
      ORDER BY o.created_at DESC`,
      values
    );

    const rows = result.rows;

    // Summary aggregation
    const totalOrders = rows.length;
    const pendingOrders = rows.filter((r: Record<string, unknown>) => r.status === 'PENDING').length;
    const completedOrders = rows.filter((r: Record<string, unknown>) => r.status === 'COMPLETED').length;
    const cancelledOrders = rows.filter((r: Record<string, unknown>) => r.status === 'CANCELLED').length;
    const totalValue = rows.reduce(
      (sum: Decimal, r: Record<string, unknown>) => sum.plus(Number(r.totalAmount) || 0),
      new Decimal(0)
    ).toDecimalPlaces(2).toNumber();
    const cancelledValue = rows
      .filter((r: Record<string, unknown>) => r.status === 'CANCELLED')
      .reduce(
        (sum: Decimal, r: Record<string, unknown>) => sum.plus(Number(r.totalAmount) || 0),
        new Decimal(0)
      ).toDecimalPlaces(2).toNumber();
    const cancellationRate = totalOrders > 0
      ? new Decimal(cancelledOrders).dividedBy(totalOrders).times(100).toDecimalPlaces(1).toNumber()
      : 0;

    const summary = {
      totalOrders,
      pendingOrders,
      completedOrders,
      cancelledOrders,
      totalValue,
      cancelledValue,
      cancellationRate,
    };

    // PDF export
    if (format === 'pdf') {
      const companyName = await getCompanyName(pool);
      const pdfGen = new ReportPDFGenerator(companyName);
      const doc = pdfGen.getDocument();

      const date = getBusinessDate();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="orders-report-${date}.pdf"`);
      doc.pipe(res);

      const startDate = start_date ? formatDatePDF(start_date) : 'All Time';
      const endDate = end_date ? formatDatePDF(end_date) : 'Present';

      pdfGen.addHeader({
        companyName,
        title: 'Orders Report',
        subtitle: `${startDate} to ${endDate}`,
        generatedAt: formatDateTime(),
      });

      pdfGen.addSummaryCards([
        { label: 'Total Orders', value: String(totalOrders), color: PDFColors.primary },
        { label: 'Completed', value: String(completedOrders), color: PDFColors.success },
        { label: 'Cancelled', value: String(cancelledOrders), color: PDFColors.danger },
        { label: 'Total Value', value: formatCurrencyPDF(totalValue), color: PDFColors.info },
        { label: 'Cancellation Rate', value: `${cancellationRate}%`, color: PDFColors.warning },
      ]);

      const ORDER_PDF_COLS: Record<string, PDFTableColumn> = {
        orderNumber: { header: 'Order #', key: 'orderNumber', width: 0.1 },
        orderDate: { header: 'Date', key: 'orderDate', width: 0.08 },
        status: { header: 'Status', key: 'status', width: 0.08 },
        customerName: { header: 'Customer', key: 'customerName', width: 0.1 },
        totalAmount: {
          header: 'Amount',
          key: 'totalAmount',
          width: 0.09,
          align: 'right',
          format: (v) => formatCurrencyPDF(v as number),
        },
        discountAmount: {
          header: 'Discount',
          key: 'discountAmount',
          width: 0.08,
          align: 'right',
          format: (v) => formatCurrencyPDF(v as number),
        },
        itemCount: { header: 'Items', key: 'itemCount', width: 0.06, align: 'right' },
        createdBy: { header: 'Created By', key: 'createdBy', width: 0.1 },
        assignedCashier: { header: 'Cashier', key: 'assignedCashier', width: 0.09 },
        completedAt: { header: 'Completed', key: 'completedAt', width: 0.09 },
        cancelledAt: { header: 'Cancelled', key: 'cancelledAt', width: 0.09 },
        cancelledBy: { header: 'Cancelled By', key: 'cancelledBy', width: 0.09 },
        cancelReason: { header: 'Reason', key: 'cancelReason', width: 0.1 },
        notes: { header: 'Notes', key: 'notes', width: 0.1 },
        createdAt: { header: 'Created', key: 'createdAt', width: 0.09 },
      };
      // SSOT: same ids as screen/CSV; never empty
      const columnsPdf = buildOrdersPdfColumns(ORDER_PDF_COLS, columns, 'all');

      pdfGen.addTable(columnsPdf, rows);
      pdfGen.end();
      return;
    }

    // JSON response
    const report = {
      reportType: 'ORDERS_REPORT',
      reportName: 'Orders Report',
      generatedAt: formatDateTime(),
      generatedBy: userId,
      parameters: { start_date, end_date, status, user_id },
      data: rows,
      recordCount: rows.length,
      executionTimeMs: 0,
      summary,
    };

    logger.info('Orders report generated', { userId, recordCount: report.recordCount });
    res.json({ success: true, data: report });
  },

  /**
   * Cancelled Orders Report — focused on cancelled orders with reasons + canceller
   * GET /api/reports/cancelled-orders
   */
  async getCancelledOrdersReport(req: Request, res: Response, pool: Pool) {
    const { start_date, end_date, user_id, format, columns } = CancelledOrdersQuerySchema.parse(req.query);
    const userId = req.user?.id;

    const conditions: string[] = [`o.status = 'CANCELLED'`];
    const values: unknown[] = [];
    let idx = 1;

    if (start_date) {
      conditions.push(`o.order_date >= $${idx++}`);
      values.push(start_date);
    }
    if (end_date) {
      conditions.push(`o.order_date <= $${idx++}`);
      values.push(end_date);
    }
    if (user_id) {
      conditions.push(`(o.created_by = $${idx} OR o.cancelled_by = $${idx++})`);
      values.push(user_id);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const result = await pool.query(
      `SELECT
        o.order_number     AS "orderNumber",
        o.order_date       AS "orderDate",
        c.name             AS "customerName",
        o.total_amount     AS "totalAmount",
        uc.full_name       AS "createdBy",
        o.cancelled_at     AS "cancelledAt",
        ucx.full_name      AS "cancelledBy",
        o.cancel_reason    AS "cancelReason",
        o.notes,
        (SELECT COUNT(*) FROM pos_order_items WHERE order_id = o.id)::int AS "itemCount"
      FROM pos_orders o
      LEFT JOIN customers c ON c.id = o.customer_id
      LEFT JOIN users uc ON uc.id = o.created_by
      LEFT JOIN users ucx ON ucx.id = o.cancelled_by
      ${whereClause}
      ORDER BY o.cancelled_at DESC`,
      values
    );

    const rows = result.rows;

    // Summary: group by cancel reason
    const reasonCounts: Record<string, number> = {};
    let totalLostValue = new Decimal(0);
    for (const row of rows) {
      const reason = (row as Record<string, unknown>).cancelReason as string || 'No reason provided';
      reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
      totalLostValue = totalLostValue.plus(Number((row as Record<string, unknown>).totalAmount) || 0);
    }

    // Group by canceller
    const cancellerCounts: Record<string, number> = {};
    for (const row of rows) {
      const canceller = (row as Record<string, unknown>).cancelledBy as string || 'Unknown';
      cancellerCounts[canceller] = (cancellerCounts[canceller] || 0) + 1;
    }

    const summary = {
      totalCancelledOrders: rows.length,
      totalLostValue: totalLostValue.toDecimalPlaces(2).toNumber(),
      topCancelReasons: Object.entries(reasonCounts)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5)
        .map(([reason, count]) => ({ reason, count })),
      cancellationsByUser: Object.entries(cancellerCounts)
        .sort(([, a], [, b]) => b - a)
        .map(([user, count]) => ({ user, count })),
    };

    // PDF export
    if (format === 'pdf') {
      const companyName = await getCompanyName(pool);
      const pdfGen = new ReportPDFGenerator(companyName);
      const doc = pdfGen.getDocument();

      const date = getBusinessDate();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="cancelled-orders-${date}.pdf"`);
      doc.pipe(res);

      const startDate = start_date ? formatDatePDF(start_date) : 'All Time';
      const endDate = end_date ? formatDatePDF(end_date) : 'Present';

      pdfGen.addHeader({
        companyName,
        title: 'Cancelled Orders Report',
        subtitle: `${startDate} to ${endDate}`,
        generatedAt: formatDateTime(),
      });

      pdfGen.addSummaryCards([
        { label: 'Total Cancelled', value: String(rows.length), color: PDFColors.danger },
        { label: 'Lost Value', value: formatCurrencyPDF(summary.totalLostValue), color: PDFColors.warning },
      ]);

      const CANCEL_PDF_COLS: Record<string, PDFTableColumn> = {
        orderNumber: { header: 'Order #', key: 'orderNumber', width: 0.12 },
        orderDate: { header: 'Date', key: 'orderDate', width: 0.09 },
        customerName: { header: 'Customer', key: 'customerName', width: 0.12 },
        totalAmount: {
          header: 'Amount',
          key: 'totalAmount',
          width: 0.1,
          align: 'right',
          format: (v) => formatCurrencyPDF(v as number),
        },
        discountAmount: {
          header: 'Discount',
          key: 'discountAmount',
          width: 0.08,
          align: 'right',
          format: (v) => formatCurrencyPDF(v as number),
        },
        itemCount: { header: 'Items', key: 'itemCount', width: 0.06, align: 'right' },
        createdBy: { header: 'Created By', key: 'createdBy', width: 0.11 },
        cancelledBy: { header: 'Cancelled By', key: 'cancelledBy', width: 0.11 },
        cancelledAt: {
          header: 'Cancelled At',
          key: 'cancelledAt',
          width: 0.11,
          format: (v) => (v ? formatDatePDF(String(v)) : '—'),
        },
        cancelReason: { header: 'Reason', key: 'cancelReason', width: 0.14 },
        notes: { header: 'Notes', key: 'notes', width: 0.1 },
        createdAt: { header: 'Created', key: 'createdAt', width: 0.09 },
      };
      // SSOT: same ids as screen/CSV; never empty
      const columnsPdf = buildOrdersPdfColumns(CANCEL_PDF_COLS, columns, 'cancelled');

      pdfGen.addTable(columnsPdf, rows);
      pdfGen.end();
      return;
    }

    // JSON response
    const report = {
      reportType: 'CANCELLED_ORDERS_REPORT',
      reportName: 'Cancelled Orders Report',
      generatedAt: formatDateTime(),
      generatedBy: userId,
      parameters: { start_date, end_date, user_id },
      data: rows,
      recordCount: rows.length,
      executionTimeMs: 0,
      summary,
    };

    logger.info('Cancelled orders report generated', { userId, recordCount: report.recordCount });
    res.json({ success: true, data: report });
  },

  // ─────────────────────────────────────────────────────────────────
  // CATEGORY INTELLIGENCE REPORTING ENGINE
  // ─────────────────────────────────────────────────────────────────

  async getCategoryIntelligenceReport(req: Request, res: Response, pool: Pool) {
    const params = CategoryIntelligenceParamsSchema.parse(req.query);
    const userId = req.user?.id;

    const report = await reportsService.generateCategoryIntelligenceReport(pool, {
      category: params.category,
      reportType: params.report_type,
      startDate: params.start_date,
      endDate: params.end_date,
      daysAhead: params.days_ahead,
      userId,
    });

    // ── PDF export ──
    if (params.format === 'pdf') {
      const companyName = await getCompanyName(pool);
      const pdfGen = new ReportPDFGenerator(companyName);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="category_intelligence_${params.category.replace(/\s+/g, '_')}_${params.report_type}.pdf"`
      );
      pdfGen.getDocument().pipe(res);

      const subtitle = `Category: ${params.category} | ${params.report_type.replace(/_/g, ' ')} | ${report.parameters.startDate} – ${report.parameters.endDate}`;
      pdfGen.addHeader({
        title: 'Category Intelligence Report',
        subtitle,
        generatedAt: report.generatedAt,
        generatedBy: userId,
        companyName,
      });

      // Section: Inventory Position / Stock Valuation
      if (report.inventoryPosition && report.inventorySummary && report.inventoryPosition.length > 0) {
        pdfGen.addSummaryCards([
          { label: 'Products', value: report.inventorySummary.productCount.toLocaleString() },
          { label: 'Total Qty on Hand', value: report.inventorySummary.totalQtyOnHand.toLocaleString() },
          { label: 'Total Stock Value', value: `${report.systemSettings.currencySymbol} ${report.inventorySummary.totalStockValue.toLocaleString()}`, color: PDFColors.primary },
          { label: 'Below Reorder', value: report.inventorySummary.belowReorderCount.toLocaleString(), color: report.inventorySummary.belowReorderCount > 0 ? PDFColors.danger : PDFColors.success },
        ]);
        pdfGen.addSectionHeading('Inventory Position');
        const invCols: PDFTableColumn[] = [
          { header: 'Product', key: 'productName', width: 0.3 },
          { header: 'SKU', key: 'sku', width: 0.12, format: (v) => (v as string | null) ?? '—' },
          { header: 'UoM', key: 'unitOfMeasure', width: 0.08, format: (v) => (v as string | null) ?? '—' },
          { header: 'Qty on Hand', key: 'qtyOnHand', width: 0.12, align: 'right', format: (v) => formatQuantityPDF(v as number) },
          { header: 'Reorder Lvl', key: 'reorderLevel', width: 0.12, align: 'right', format: (v) => formatQuantityPDF(v as number) },
          { header: 'Unit Cost', key: 'unitCost', width: 0.13, align: 'right', format: (v) => formatCurrencyPDF(v as number) },
          { header: 'Stock Value', key: 'stockValue', width: 0.13, align: 'right', format: (v) => formatCurrencyPDF(v as number) },
        ];
        pdfGen.addTable(invCols, report.inventoryPosition);
      }

      // Section: Sales
      if (report.sales && report.salesSummary) {
        pdfGen.addSectionHeading('Sales Performance');
        pdfGen.addSummaryCards([
          { label: 'Revenue', value: `${report.systemSettings.currencySymbol} ${report.salesSummary.totalRevenue.toLocaleString()}`, color: PDFColors.primary },
          { label: 'Gross Profit', value: `${report.systemSettings.currencySymbol} ${report.salesSummary.grossProfit.toLocaleString()}`, color: PDFColors.success },
          { label: 'Products Sold', value: String(report.salesSummary.productCount ?? report.sales.length) },
          { label: 'Transactions', value: report.salesSummary.totalTransactions.toLocaleString() },
        ]);
        const salesCols: PDFTableColumn[] = [
          { header: 'Product', key: 'productName', width: 0.22 },
          { header: 'SKU', key: 'sku', width: 0.1 },
          { header: 'Qty Sold', key: 'totalQuantitySold', width: 0.1, align: 'right', format: (v) => formatQuantityPDF(v as number) },
          { header: 'Revenue', key: 'totalRevenue', width: 0.13, align: 'right', format: (v) => formatCurrencyPDF(v as number) },
          { header: 'Cost', key: 'totalCost', width: 0.12, align: 'right', format: (v) => formatCurrencyPDF(v as number) },
          { header: 'Gross Profit', key: 'grossProfit', width: 0.13, align: 'right', format: (v) => formatCurrencyPDF(v as number) },
          { header: 'Margin %', key: 'profitMargin', width: 0.1, align: 'right', format: (v) => `${(v as number).toFixed(1)}%` },
          { header: 'Trans.', key: 'transactionCount', width: 0.1, align: 'right' },
        ];
        if (report.sales.length > 0) {
          pdfGen.addTable(salesCols, report.sales);
        }
      }

      // Section: Purchases
      if (report.purchases && report.purchasesSummary && report.purchases.length > 0) {
        pdfGen.addSectionHeading('Purchase History');
        pdfGen.addSummaryCards([
          { label: 'Deliveries', value: report.purchasesSummary.deliveryCount.toLocaleString() },
          { label: 'Total Qty Received', value: report.purchasesSummary.totalQtyReceived.toLocaleString() },
          { label: 'Total Purchase Value', value: `${report.systemSettings.currencySymbol} ${report.purchasesSummary.totalPurchaseValue.toLocaleString()}`, color: PDFColors.warning },
        ]);
        const purCols: PDFTableColumn[] = [
          { header: 'Product', key: 'productName', width: 0.22 },
          { header: 'GR #', key: 'grNumber', width: 0.12 },
          { header: 'Supplier', key: 'supplierName', width: 0.15 },
          { header: 'Date', key: 'receivedDate', width: 0.1, format: (v) => String(v) },
          { header: 'Qty Received', key: 'totalQtyReceived', width: 0.12, align: 'right', format: (v) => formatQuantityPDF(v as number) },
          { header: 'Avg Unit Cost', key: 'avgUnitCost', width: 0.12, align: 'right', format: (v) => formatCurrencyPDF(v as number) },
          { header: 'Total Value', key: 'totalPurchaseValue', width: 0.12, align: 'right', format: (v) => formatCurrencyPDF(v as number) },
        ];
        pdfGen.addTable(purCols, report.purchases);
      }

      // Section: Expiry Exposure
      if (report.expiry && report.expirySummary && report.expiry.length > 0) {
        pdfGen.addSectionHeading(`Expiry Exposure (next ${report.parameters.daysAhead} days)`);
        pdfGen.addSummaryCards([
          { label: 'Active Batches', value: report.expirySummary.batchCount.toLocaleString() },
          { label: 'Exposed Qty', value: report.expirySummary.totalExposedQty.toLocaleString() },
          { label: 'Exposed Value', value: `${report.systemSettings.currencySymbol} ${report.expirySummary.totalExposedValue.toLocaleString()}`, color: PDFColors.danger },
          { label: 'Expiring ≤ 30 days', value: report.expirySummary.expiringSoonCount.toLocaleString(), color: report.expirySummary.expiringSoonCount > 0 ? PDFColors.warning : PDFColors.success },
        ]);
        const expCols: PDFTableColumn[] = [
          { header: 'Product', key: 'productName', width: 0.22 },
          { header: 'Batch #', key: 'batchNumber', width: 0.13 },
          { header: 'Expiry Date', key: 'expiryDate', width: 0.11, format: (v) => String(v) },
          { header: 'Days Left', key: 'daysUntilExpiry', width: 0.09, align: 'right', format: (v) => (v as number) <= 0 ? 'EXPIRED' : String(v) },
          { header: 'Qty Remaining', key: 'remainingQuantity', width: 0.12, align: 'right', format: (v) => formatQuantityPDF(v as number) },
          { header: 'Unit Cost', key: 'costPrice', width: 0.12, align: 'right', format: (v) => formatCurrencyPDF(v as number) },
          { header: 'Exposed Value', key: 'exposedValue', width: 0.13, align: 'right', format: (v) => formatCurrencyPDF(v as number) },
        ];
        pdfGen.addTable(expCols, report.expiry);
      }

      // Fallback: nothing to show
      const sectionsRendered = [
        report.inventoryPosition?.length,
        report.sales?.length,
        report.purchases?.length,
        report.expiry?.length,
      ].some((n) => n && n > 0);

      if (!sectionsRendered) {
        pdfGen.addTable([], []);
      }

      pdfGen.end();
      return;
    }

    res.json({ success: true, data: report });
  },
};
