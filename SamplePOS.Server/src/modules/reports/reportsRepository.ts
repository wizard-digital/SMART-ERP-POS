// Reports Repository - Database queries with bank-grade precision
// All monetary calculations use Decimal.js for accuracy

import { Pool } from 'pg';
import Decimal from 'decimal.js';
import logger from '../../utils/logger.js';
import { toUtcRange, BUSINESS_TIMEZONE, formatDateBusiness, getBusinessDate } from '../../utils/dateRange.js';
import { computeDaysUntilExpiry } from '../inventory-lot/lotReportHelpers.js';
import { demandForecastRepository, type ProductDemandStats } from './demandForecastRepository.js';
import { classifyReorderPriority } from './reorderDashboardLogic.js';
import { poItemOpenQuantitySql } from '../purchase-orders/purchaseOrderNetReceived.js';
import { alignSalesComparisonBuckets } from '../../../../shared/reports/salesComparisonSsot.js';
import { classifyExpiryUrgency } from '../../../../shared/reports/expiringItemsSsot.js';
import type {
  SalesReportRow,
  SupplierCostAnalysisRow,
  PaymentReportRow,
  InventoryAdjustmentRow,
  PurchaseOrderSummaryRow,
  StockMovementAnalysisRow,
  CustomerAccountStatementData,
  DailyCashFlowRow,
  TopCustomerRow,
  StockAgingRow,
  SalesByCategoryRow,
  SalesByPaymentMethodRow,
  HourlySalesAnalysisRow,
  BusinessPositionData,
  InventoryValuationRow,
  ExpiringItemRow,
  LowStockItemRow,
  BestSellingProductRow,
  GoodsReceivedRow,
  CustomerPaymentsRow,
  ProfitLossRow,
  ProfitLossSummary,
  ExpenseBreakdownRow,
  DeletedItemRow,
  ProfitMarginByProductRow,
  SupplierPaymentStatusRow,
  SupplierPaymentDetailRow,
  SupplierPaymentAllocationRow,
  CustomerAgingRow,
  WasteDamageRow,
  ReorderRecommendationRow,
  ReorderDashboardItem,
  ReorderPriority,
  SalesComparisonRow,
  CustomerPurchaseHistoryRow,
  CashRegisterSessionSummaryData,
  CashRegisterMovementBreakdownData,
  CashRegisterSessionHistoryData,
  DeliveryNoteReportRow,
  QuotationReportRow,
  ManualJournalEntryReportRow,
  BankTransactionReportRow,
  VoidSalesReportRow,
  RefundReportHeader,
  RefundReportLine,
  CategoryInventoryPositionRow,
  CategorySalesProductRow,
  CategoryPurchasesRow,
  CategoryExpiryExposureRow,
  UomLevel,
} from './reportTypes.js';

// Configure Decimal for financial precision (2 decimal places for currency)
Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

// Utility function to format timestamps in a simplified, human-readable format
// NOTE: This is only for TIMESTAMPTZ audit fields, NOT for DATE columns
// Always uses Africa/Kampala timezone for consistent output (SAP pattern)
function formatDate(date: Date | string | null | undefined): string | null {
  if (!date) return null;
  // If already a plain date string (YYYY-MM-DD), return as-is (timezone strategy)
  if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Africa/Kampala',
  });
}

// Utility function to format date only (no time)
// For DATE columns, returns the string as-is per timezone strategy
// Always uses Africa/Kampala timezone for consistent output (SAP pattern)
function formatDateOnly(date: Date | string | null | undefined): string | null {
  if (!date) return null;
  // If already a plain date string (YYYY-MM-DD), return as-is (timezone strategy)
  if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    timeZone: 'Africa/Kampala',
  });
}

/** SQL constant for AT TIME ZONE expressions */
const TZ = BUSINESS_TIMEZONE;

/** Category Intelligence / reports SSOT — FK + case-insensitive free-text. */
function productCategoryMatchSql(productAlias: string, paramIndex: number): string {
  return `(
    ${productAlias}.category_id IN (
      SELECT pc.id FROM product_categories pc
      WHERE LOWER(TRIM(pc.name)) = LOWER(TRIM($${paramIndex}))
    )
    OR LOWER(TRIM(COALESCE(${productAlias}.category, ''))) = LOWER(TRIM($${paramIndex}))
  )`;
}

/**
 * @deprecated Use productCategoryMatchSql — kept for any leftover string greps.
 * Exact category match (trimmed) — products.category is VARCHAR, not UUID
 */
function categoryMatchClause(columnRef: string, paramIndex: number): string {
  // columnRef historically 'p.category' — derive alias
  const alias = columnRef.includes('.') ? columnRef.split('.')[0]! : 'p';
  return productCategoryMatchSql(alias, paramIndex);
}

/**
 * Convert incoming Date or string dates to UTC-bounded params
 * suitable for WHERE col >= $start AND col < $end queries.
 */
function toUtcParams(
  startDate: Date | string,
  endDate: Date | string
): [string, string] {
  const start =
    startDate instanceof Date
      ? formatDateBusiness(startDate)
      : String(startDate).slice(0, 10);
  const end =
    endDate instanceof Date
      ? formatDateBusiness(endDate)
      : String(endDate).slice(0, 10);
  const { startUtc, endUtc } = toUtcRange(start, end, TZ);
  return [startUtc, endUtc];
}

export interface ReportRunRecord {
  id: string;
  report_type: string;
  report_name: string;
  parameters: Record<string, unknown>;
  generated_by_id: string | null;
  start_date: string | null;
  end_date: string | null;
  record_count: number;
  file_path: string | null;
  file_format: string | null;
  execution_time_ms: number | null;
  created_at: Date;
}

export const reportsRepository = {
  /**
   * Get distinct product categories for filter dropdowns.
   * SSOT: one display name per case-insensitive key — prefer product_categories.
   */
  async getProductCategories(pool: Pool): Promise<string[]> {
    const result = await pool.query(
      `WITH linked AS (
         SELECT
           LOWER(TRIM(COALESCE(pc.name, p.category))) AS name_key,
           COALESCE(pc.name, TRIM(p.category)) AS display_name,
           CASE WHEN pc.id IS NOT NULL THEN 0 ELSE 1 END AS prefer_master
         FROM products p
         LEFT JOIN product_categories pc
           ON pc.id = p.category_id
           OR (
             p.category_id IS NULL
             AND LOWER(TRIM(COALESCE(p.category, ''))) = LOWER(TRIM(pc.name))
           )
         WHERE p.is_active = TRUE
           AND (
             pc.id IS NOT NULL
             OR (p.category IS NOT NULL AND TRIM(p.category) <> '')
           )
       ),
       ranked AS (
         SELECT
           display_name,
           name_key,
           ROW_NUMBER() OVER (
             PARTITION BY name_key
             ORDER BY prefer_master ASC, display_name ASC
           ) AS rn
         FROM linked
         WHERE name_key IS NOT NULL AND name_key <> ''
       )
       SELECT display_name AS name
       FROM ranked
       WHERE rn = 1
       ORDER BY display_name`
    );
    return result.rows.map((r: { name: string }) => r.name);
  },

  /**
   * Log a report run for audit trail
   * Uses report_runs table created by migration 009
   */
  async logReportRun(
    pool: Pool,
    data: {
      reportType: string;
      reportName: string;
      parameters: Record<string, unknown>;
      generatedById: string | null;
      startDate?: string | Date | null;
      endDate?: string | Date | null;
      recordCount: number;
      filePath?: string | null;
      fileFormat?: string | null;
      executionTimeMs?: number | null;
    }
  ): Promise<ReportRunRecord | null> {
    try {
      const result = await pool.query(
        `INSERT INTO report_runs (
          report_type, report_name, parameters, generated_by_id,
          start_date, end_date, record_count, file_path, file_format, execution_time_ms
        ) VALUES ($1::report_type, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING 
          id,
          report_type as "reportType",
          report_name as "reportName",
          parameters,
          generated_by_id as "generatedById",
          start_date as "startDate",
          end_date as "endDate",
          record_count as "recordCount",
          file_path as "filePath",
          file_format as "fileFormat",
          execution_time_ms as "executionTimeMs",
          created_at as "createdAt"`,
        [
          data.reportType,
          data.reportName,
          JSON.stringify(data.parameters),
          data.generatedById,
          data.startDate || null,
          data.endDate || null,
          data.recordCount,
          data.filePath || null,
          data.fileFormat || null,
          data.executionTimeMs || null,
        ]
      );
      return result.rows[0];
    } catch (error: unknown) {
      logger.warn('Failed to log report run', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  },

  /**
   * INVENTORY VALUATION REPORT
   * Calculate current inventory value with GL reconciliation.
   *
   * Accuracy rules (enforced):
   *  - Quantities come from `product_inventory.quantity_on_hand` (authoritative subledger).
   *  - Cost comes from aggregated `cost_layers` when available; falls back to
   *    `product_valuation.average_cost` when a product has stock but no active layers
   *    (prevents silent zero-value rows for drift cases).
   *  - Deactivated products with stock are NOT hidden — they remain on the GL so must
   *    appear on the report. A `productActive` flag is included per row.
   *  - The report summary includes a three-way reconciliation vs GL account 1300 and
   *    the AVCO subledger, so finance sees drift immediately.
   *
   * Historical snapshots (asOfDate != today):
   *  - Not currently supported accurately — `remaining_quantity` is a live field.
   *    Callers get a warning via the service layer, and the report is computed as a
   *    current snapshot. A true historical reconstruction requires stock_movement
   *    replay and will be added as a separate code path.
   */
  async getInventoryValuation(
    pool: Pool,
    options: {
      asOfDate?: Date | string;
      categoryId?: string;
      valuationMethod?: 'FIFO' | 'AVCO' | 'LIFO';
      page?: number;
      limit?: number;
    }
  ): Promise<{
    items: InventoryValuationRow[];
    summary: {
      totalItems: number;
      totalQuantity: number;
      totalValue: number;
      totalPotentialRevenue: number;
      totalPotentialProfit: number;
      glInventoryBalance: number;
      costLayersTotal: number;
      subledgerAvcoTotal: number;
      variance: number;
      variancePercent: number;
      isReconciled: boolean;
      movementCounts?: { FAST: number; SLOW: number; DEAD: number; NEW: number };
      abcCounts?: { A: number; B: number; C: number };
      driftCount?: number;
      deadStockValue?: number;
    };
    byCategory: Array<{ category: string; productCount: number; quantityOnHand: number; costValue: number; potentialRevenue: number; potentialProfit: number; profitMargin: number }>;
  }> {
    const asOfDate = options.asOfDate || getBusinessDate();

    let categoryFilter = '';
    const params: unknown[] = [];

    if (options.categoryId) {
      categoryFilter = 'AND p.category = $1';
      params.push(options.categoryId);
    }

    // ── CTE shared by all three queries ──
    // Authoritative quantity: product_inventory.quantity_on_hand
    // Cost resolution priority: cost_layers aggregate → product_valuation.average_cost → 0
    // SAP/Odoo-grade enrichments:
    //   - oldest_received (FIFO stock age)
    //   - last_sale_date / days_since_last_sale (movement classification)
    //   - qty_subledger vs qty_cost_layers (drift detection per product)
    const baseCTE = `
      WITH cl_agg AS (
        SELECT
          cl.product_id,
          SUM(cl.remaining_quantity) AS layer_qty,
          SUM(cl.remaining_quantity * cl.unit_cost) AS layer_value,
          MIN(cl.received_date) AS oldest_received
        FROM cost_layers cl
        WHERE cl.is_active = true
          AND cl.remaining_quantity > 0
        GROUP BY cl.product_id
      ),
      last_sale AS (
        SELECT si.product_id, MAX(s.sale_date) AS last_sale_date
        FROM sale_items si
        JOIN sales s ON s.id = si.sale_id
        WHERE s.status NOT IN ('VOID', 'REFUNDED', 'VOIDED_BY_RETURN')
        GROUP BY si.product_id
      ),
      valuation AS (
        SELECT
          p.id AS product_id,
          p.name AS product_name,
          p.sku,
          p.category,
          p.is_active AS product_active,
          pi.quantity_on_hand AS total_quantity,
          COALESCE(cl_agg.layer_qty, 0) AS qty_cost_layers,
          (pi.quantity_on_hand - COALESCE(cl_agg.layer_qty, 0)) AS qty_drift,
          CASE
            WHEN COALESCE(cl_agg.layer_qty, 0) > 0
              THEN ROUND((cl_agg.layer_value / cl_agg.layer_qty)::numeric, 2)
            ELSE ROUND(COALESCE(pv.average_cost, 0)::numeric, 2)
          END AS unit_cost,
          COALESCE(pv.selling_price, 0) AS selling_price,
          ROUND((
            CASE
              WHEN COALESCE(cl_agg.layer_qty, 0) > 0
                THEN pi.quantity_on_hand * (cl_agg.layer_value / cl_agg.layer_qty)
              ELSE pi.quantity_on_hand * COALESCE(pv.average_cost, 0)
            END
          )::numeric, 2) AS total_value,
          ROUND((pi.quantity_on_hand * COALESCE(pv.selling_price, 0))::numeric, 2) AS potential_revenue,
          ROUND((
            pi.quantity_on_hand * COALESCE(pv.selling_price, 0)
            - (CASE
                WHEN COALESCE(cl_agg.layer_qty, 0) > 0
                  THEN pi.quantity_on_hand * (cl_agg.layer_value / cl_agg.layer_qty)
                ELSE pi.quantity_on_hand * COALESCE(pv.average_cost, 0)
              END)
          )::numeric, 2) AS potential_profit,
          CASE
            WHEN COALESCE(pv.selling_price, 0) > 0
              THEN ROUND((
                (COALESCE(pv.selling_price, 0)
                  - (CASE
                      WHEN COALESCE(cl_agg.layer_qty, 0) > 0
                        THEN cl_agg.layer_value / cl_agg.layer_qty
                      ELSE COALESCE(pv.average_cost, 0)
                    END)
                ) / COALESCE(pv.selling_price, 0) * 100
              )::numeric, 2)
            ELSE 0
          END AS profit_margin,
          ROUND((
            COALESCE(pv.selling_price, 0)
            - (CASE
                WHEN COALESCE(cl_agg.layer_qty, 0) > 0
                  THEN cl_agg.layer_value / cl_agg.layer_qty
                ELSE COALESCE(pv.average_cost, 0)
              END)
          )::numeric, 2) AS profit_per_unit,
          CASE
            WHEN COALESCE(cl_agg.layer_qty, 0) > 0 THEN 'FIFO_LAYER'
            WHEN COALESCE(pv.average_cost, 0) > 0 THEN 'AVCO_FALLBACK'
            ELSE 'NO_COST_BASIS'
          END AS cost_source,
          cl_agg.oldest_received,
          CASE WHEN cl_agg.oldest_received IS NOT NULL
               THEN GREATEST(0, (CURRENT_DATE - cl_agg.oldest_received::date))::integer
               ELSE NULL END AS days_in_stock,
          last_sale.last_sale_date::text AS last_sale_date,
          CASE WHEN last_sale.last_sale_date IS NOT NULL
               THEN GREATEST(0, (CURRENT_DATE - last_sale.last_sale_date::date))::integer
               ELSE NULL END AS days_since_last_sale,
          NOW() AS last_updated
        FROM product_inventory pi
        INNER JOIN products p ON p.id = pi.product_id
        LEFT JOIN cl_agg ON cl_agg.product_id = p.id
        LEFT JOIN product_valuation pv ON pv.product_id = p.id
        LEFT JOIN last_sale ON last_sale.product_id = p.id
        WHERE pi.quantity_on_hand > 0
          ${categoryFilter}
      )`;
    // Note: asOfDate parameter is accepted for API compatibility but not applied here
    // (see historical snapshots note above). Service layer emits a warning when used.
    void asOfDate;

    // ── 1) Summary totals (single row) ──
    const summaryQuery = `
      ${baseCTE}
      SELECT
        COUNT(*)::integer AS total_items,
        ROUND(COALESCE(SUM(total_quantity), 0)::numeric, 3) AS total_quantity,
        ROUND(COALESCE(SUM(total_value), 0)::numeric, 2) AS total_value,
        ROUND(COALESCE(SUM(potential_revenue), 0)::numeric, 2) AS total_potential_revenue,
        ROUND(COALESCE(SUM(potential_profit), 0)::numeric, 2) AS total_potential_profit
      FROM valuation
    `;

    // ── 2) By-category aggregation ──
    const categoryQuery = `
      ${baseCTE}
      SELECT
        COALESCE(category, 'Uncategorized') AS category,
        COUNT(*)::integer AS product_count,
        ROUND(COALESCE(SUM(total_quantity), 0)::numeric, 3) AS quantity_on_hand,
        ROUND(COALESCE(SUM(total_value), 0)::numeric, 2) AS cost_value,
        ROUND(COALESCE(SUM(potential_revenue), 0)::numeric, 2) AS potential_revenue,
        ROUND(COALESCE(SUM(potential_profit), 0)::numeric, 2) AS potential_profit,
        CASE WHEN COALESCE(SUM(potential_revenue), 0) > 0
          THEN ROUND((COALESCE(SUM(potential_profit), 0) / SUM(potential_revenue) * 100)::numeric, 2)
          ELSE 0
        END AS profit_margin
      FROM valuation
      GROUP BY COALESCE(category, 'Uncategorized')
      ORDER BY cost_value DESC
    `;

    // ── 3) Paginated item rows ──
    const page = options.page ?? 1;
    const limit = options.limit ?? 500;
    const offset = (page - 1) * limit;
    const itemParams = [...params, limit, offset];
    const limitParamIdx = params.length + 1;
    const offsetParamIdx = params.length + 2;

    const itemQuery = `
      ${baseCTE}
      SELECT * FROM valuation
      ORDER BY total_value DESC
      LIMIT $${limitParamIdx} OFFSET $${offsetParamIdx}
    `;

    // ── 4) GL reconciliation (account 1300 = Inventory) + AVCO subledger total ──
    // Mirrors inventoryIntegrityService canonical query — single source of truth.
    const reconciliationQuery = `
      SELECT
        (SELECT COALESCE(SUM(le."DebitAmount") - SUM(le."CreditAmount"), 0)
           FROM ledger_entries le
           JOIN ledger_transactions lt ON le."TransactionId" = lt."Id"
           JOIN accounts a ON le."AccountId" = a."Id"
           WHERE a."AccountCode" = '1300'
             AND lt."IsReversed" = FALSE) AS gl_balance,
        (SELECT COALESCE(ROUND(SUM(cl.remaining_quantity * cl.unit_cost)::numeric, 2), 0)
           FROM cost_layers cl
           WHERE cl.is_active = true
             AND cl.remaining_quantity > 0) AS cost_layers_total,
        (SELECT COALESCE(ROUND(SUM(pi.quantity_on_hand * COALESCE(pv.average_cost, 0))::numeric, 2), 0)
           FROM product_inventory pi
           LEFT JOIN product_valuation pv ON pv.product_id = pi.product_id
           WHERE pi.quantity_on_hand > 0) AS subledger_avco_total
    `;

    // Run all in parallel (all read-only, no contention)
    const [summaryResult, categoryResult, itemResult, reconResult] = await Promise.all([
      pool.query(summaryQuery, params),
      pool.query(categoryQuery, params),
      pool.query(itemQuery, itemParams),
      pool.query(reconciliationQuery),
    ]);

    const summaryRow = summaryResult.rows[0];
    const reconRow = reconResult.rows[0];
    const glBalance = new Decimal(reconRow.gl_balance || 0);
    const costLayersTotal = new Decimal(reconRow.cost_layers_total || 0);
    const subledgerAvcoTotal = new Decimal(reconRow.subledger_avco_total || 0);
    const reportTotal = new Decimal(summaryRow.total_value || 0);
    const variance = glBalance.minus(reportTotal);
    // Materiality threshold: max(5000, |GL| * 0.0001) — matches inventoryIntegrityService
    const pctThreshold = glBalance.abs().times(0.0001);
    const threshold = pctThreshold.greaterThan(5000) ? pctThreshold : new Decimal(5000);
    const isReconciled = variance.abs().lessThanOrEqualTo(threshold);
    const variancePercent = glBalance.abs().greaterThan(0)
      ? variance.dividedBy(glBalance).times(100).toDecimalPlaces(2).toNumber()
      : 0;

    const summary = {
      totalItems: parseInt(summaryRow.total_items) || 0,
      totalQuantity: new Decimal(summaryRow.total_quantity || 0).toNumber(),
      totalValue: reportTotal.toNumber(),
      totalPotentialRevenue: new Decimal(summaryRow.total_potential_revenue || 0).toNumber(),
      totalPotentialProfit: new Decimal(summaryRow.total_potential_profit || 0).toNumber(),
      glInventoryBalance: glBalance.toDecimalPlaces(2).toNumber(),
      costLayersTotal: costLayersTotal.toNumber(),
      subledgerAvcoTotal: subledgerAvcoTotal.toNumber(),
      variance: variance.toDecimalPlaces(2).toNumber(),
      variancePercent,
      isReconciled,
    };

    const byCategory = categoryResult.rows.map((row) => ({
      category: row.category,
      productCount: row.product_count,
      quantityOnHand: new Decimal(row.quantity_on_hand || 0).toNumber(),
      costValue: new Decimal(row.cost_value || 0).toNumber(),
      potentialRevenue: new Decimal(row.potential_revenue || 0).toNumber(),
      potentialProfit: new Decimal(row.potential_profit || 0).toNumber(),
      profitMargin: new Decimal(row.profit_margin || 0).toNumber(),
    }));

    // ── SAP/Odoo enrichments on items (post-SQL, over page) ──
    // ABC is computed on the full page (global ABC is approximated from total_value share).
    // Movement classification thresholds match common ERP defaults:
    //   NEW:  no sales yet AND received ≤ 30 days ago
    //   FAST: last sale ≤ 30 days
    //   SLOW: last sale 31..180 days
    //   DEAD: last sale > 180 days OR never sold AND in stock > 180 days
    const rawItems = itemResult.rows;
    // Sort a copy by total_value desc for ABC cumulative cutoff
    const sortedByValue = [...rawItems].sort(
      (a, b) => new Decimal(b.total_value || 0).minus(a.total_value || 0).toNumber()
    );
    const abcById = new Map<string, 'A' | 'B' | 'C'>();
    const totalForABC = reportTotal.toNumber();
    let cumulative = 0;
    for (const r of sortedByValue) {
      const before = totalForABC > 0 ? cumulative / totalForABC : 0;
      cumulative += new Decimal(r.total_value || 0).toNumber();
      // Standard Pareto ABC: items whose *pre-addition* cumulative share is
      // below the cutoff belong to that class (so the single item that crosses
      // 80% is classified as A, not pushed down).
      abcById.set(
        r.product_id,
        before < 0.8 ? 'A' : before < 0.95 ? 'B' : 'C'
      );
    }

    const driftThresholdQty = new Decimal('0.001');

    const items = rawItems.map((row) => {
      const qtyDrift = new Decimal(row.qty_drift || 0);
      const hasDrift = qtyDrift.abs().greaterThan(driftThresholdQty);
      const daysSinceLastSale: number | null =
        row.days_since_last_sale === null || row.days_since_last_sale === undefined
          ? null
          : parseInt(row.days_since_last_sale, 10);
      const daysInStock: number | null =
        row.days_in_stock === null || row.days_in_stock === undefined
          ? null
          : parseInt(row.days_in_stock, 10);

      let movementClass: 'FAST' | 'SLOW' | 'DEAD' | 'NEW';
      if (daysSinceLastSale === null) {
        movementClass = daysInStock !== null && daysInStock <= 30 ? 'NEW' : 'DEAD';
      } else if (daysSinceLastSale <= 30) {
        movementClass = 'FAST';
      } else if (daysSinceLastSale <= 180) {
        movementClass = 'SLOW';
      } else {
        movementClass = 'DEAD';
      }

      const tv = new Decimal(row.total_value || 0).toNumber();
      const valueContribution =
        totalForABC > 0 ? new Decimal(tv).dividedBy(totalForABC).times(100).toDecimalPlaces(2).toNumber() : 0;

      return {
        productId: row.product_id,
        productName: row.product_name,
        sku: row.sku,
        category: row.category,
        productActive: row.product_active,
        costSource: row.cost_source,
        quantityOnHand: new Decimal(row.total_quantity || 0).toNumber(),
        unitCost: new Decimal(row.unit_cost || 0).toNumber(),
        sellingPrice: new Decimal(row.selling_price || 0).toNumber(),
        totalValue: tv,
        potentialRevenue: new Decimal(row.potential_revenue || 0).toNumber(),
        profitPerUnit: new Decimal(row.profit_per_unit || 0).toNumber(),
        potentialProfit: new Decimal(row.potential_profit || 0).toNumber(),
        profitMargin: new Decimal(row.profit_margin || 0).toNumber(),
        lastUpdated: formatDate(row.last_updated),
        // enrichments
        abcClass: abcById.get(row.product_id) || 'C',
        valueContribution,
        daysInStock,
        lastSaleDate: row.last_sale_date || null,
        daysSinceLastSale,
        movementClass,
        qtySubledger: new Decimal(row.total_quantity || 0).toNumber(),
        qtyCostLayers: new Decimal(row.qty_cost_layers || 0).toNumber(),
        qtyDrift: qtyDrift.toDecimalPlaces(4).toNumber(),
        hasDrift,
      };
    });

    // Movement / ABC aggregate counts for the summary strip
    const movementCounts = items.reduce(
      (acc, it) => {
        acc[it.movementClass] += 1;
        return acc;
      },
      { FAST: 0, SLOW: 0, DEAD: 0, NEW: 0 } as Record<'FAST' | 'SLOW' | 'DEAD' | 'NEW', number>
    );
    const abcCounts = items.reduce(
      (acc, it) => {
        acc[it.abcClass] += 1;
        return acc;
      },
      { A: 0, B: 0, C: 0 } as Record<'A' | 'B' | 'C', number>
    );
    const driftCount = items.filter((it) => it.hasDrift).length;
    const deadStockValue = items
      .filter((it) => it.movementClass === 'DEAD')
      .reduce((sum, it) => sum.plus(it.totalValue), new Decimal(0))
      .toDecimalPlaces(2)
      .toNumber();

    (summary as Record<string, unknown>).movementCounts = movementCounts;
    (summary as Record<string, unknown>).abcCounts = abcCounts;
    (summary as Record<string, unknown>).driftCount = driftCount;
    (summary as Record<string, unknown>).deadStockValue = deadStockValue;

    return { items, summary, byCategory };
  },

  /**
   * SALES REPORT
   * Comprehensive sales analysis with profit calculations.
   * Returns grouped rows + a single SQL-aggregated summary row.
   */
  async getSalesReport(
    pool: Pool,
    options: {
      startDate: string;
      endDate: string;
      groupBy?: 'day' | 'week' | 'month' | 'product' | 'customer' | 'payment_method' | 'cashier' | 'category';
      customerId?: string;
      sessionId?: string;
    }
  ): Promise<{
    rows: SalesReportRow[];
    summary: {
      totalSales: number;
      totalDiscounts: number;
      netRevenue: number;
      totalCost: number;
      grossProfit: number;
      profitMargin: number;
      totalTransactions: number;
      averageDiscountRate: number;
      totalQuantitySold: number;
    };
  }> {
    const [startUtc, endUtc] = toUtcParams(options.startDate, options.endDate);
    const params: unknown[] = [startUtc, endUtc];
    let customerFilter = '';
    let sessionFilter = '';

    if (options.customerId) {
      customerFilter = `AND s.customer_id = $${params.length + 1}`;
      params.push(options.customerId);
    }

    if (options.sessionId) {
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(options.sessionId);
      if (isUuid) {
        sessionFilter = `AND s.cash_register_session_id = $${params.length + 1}`;
        params.push(options.sessionId);
      } else {
        sessionFilter = `AND s.cash_register_session_id = (SELECT id FROM cash_register_sessions WHERE session_number = $${params.length + 1} LIMIT 1)`;
        params.push(options.sessionId);
      }
    }

    // ── SQL summary (single row, no grouping overhead) ──
    const summaryQuery = `
      WITH filtered_sales AS (
        SELECT s.id, s.total_amount, s.discount_amount
        FROM sales s
        WHERE s.sale_date >= ($1::timestamptz AT TIME ZONE '${TZ}')::date AND s.sale_date < ($2::timestamptz AT TIME ZONE '${TZ}')::date
          AND s.status NOT IN ('VOID', 'REFUNDED', 'VOIDED_BY_RETURN')
          ${customerFilter}
          ${sessionFilter}
      ),
      sale_line_agg AS (
        SELECT si.sale_id,
               SUM(si.total_price) AS total_sales,
               SUM(si.quantity) AS total_qty,
               SUM(si.quantity * si.unit_cost) AS total_cost,
               SUM(si.profit) AS gross_profit
        FROM sale_items si
        WHERE si.sale_id IN (SELECT id FROM filtered_sales)
        GROUP BY si.sale_id
      )
      SELECT
        ROUND(COALESCE(SUM(sla.total_sales), 0)::numeric, 2) AS total_sales,
        ROUND(COALESCE(SUM(fs.discount_amount), 0)::numeric, 2) AS total_discounts,
        ROUND((COALESCE(SUM(sla.total_sales), 0) - COALESCE(SUM(fs.discount_amount), 0))::numeric, 2) AS net_revenue,
        ROUND(COALESCE(SUM(sla.total_cost), 0)::numeric, 2) AS total_cost,
        ROUND((COALESCE(SUM(sla.total_sales), 0) - COALESCE(SUM(fs.discount_amount), 0) - COALESCE(SUM(sla.total_cost), 0))::numeric, 2) AS gross_profit,
        ROUND(COALESCE(SUM(sla.total_qty), 0)::numeric, 3) AS total_quantity_sold,
        COUNT(fs.id)::integer AS total_transactions
      FROM filtered_sales fs
      LEFT JOIN sale_line_agg sla ON sla.sale_id = fs.id
    `;

    // ── Grouped rows (existing logic) ──
    let groupByClause = '';
    let selectClause = '';

    switch (options.groupBy) {
      case 'day':
        selectClause = `(fs.sale_date AT TIME ZONE '${TZ}')::date as period`;
        groupByClause = `(fs.sale_date AT TIME ZONE '${TZ}')::date`;
        break;
      case 'week':
        selectClause = `DATE_TRUNC('week', fs.sale_date AT TIME ZONE '${TZ}')::DATE as period`;
        groupByClause = `DATE_TRUNC('week', fs.sale_date AT TIME ZONE '${TZ}')`;
        break;
      case 'month':
        selectClause = `DATE_TRUNC('month', fs.sale_date AT TIME ZONE '${TZ}')::DATE as period`;
        groupByClause = `DATE_TRUNC('month', fs.sale_date AT TIME ZONE '${TZ}')`;
        break;
      case 'product':
      case 'category':
        selectClause = '';
        groupByClause = '';
        break;
      case 'customer':
        selectClause = "COALESCE(c.name, 'Walk-in Customer') as period";
        groupByClause = "COALESCE(c.name, 'Walk-in Customer')";
        break;
      case 'payment_method':
        selectClause = 'fs.payment_method as period';
        groupByClause = 'fs.payment_method';
        break;
      case 'cashier':
        selectClause = "COALESCE(u.full_name, 'Unknown cashier') as period";
        groupByClause = "COALESCE(u.full_name, 'Unknown cashier')";
        break;
      default:
        selectClause = `(fs.sale_date AT TIME ZONE '${TZ}')::date as period`;
        groupByClause = `(fs.sale_date AT TIME ZONE '${TZ}')::date`;
    }

    let rowQuery: string;

    if (options.groupBy === 'product') {
      rowQuery = `
        SELECT 
          COALESCE(p.name, si.product_name, 'Custom Item') as period,
          COALESCE(NULLIF(TRIM(p.category), ''), 'Uncategorized') as category,
          COUNT(DISTINCT s.id) as transaction_count,
          SUM(si.quantity) as total_quantity_sold,
          SUM(si.total_price) as total_sales,
          0 as total_discounts,
          SUM(si.quantity * si.unit_cost) as total_cost,
          SUM(si.profit) as gross_profit,
          AVG(si.total_price) as average_transaction_value
        FROM sale_items si
        INNER JOIN sales s ON s.id = si.sale_id
        LEFT JOIN products p ON p.id = si.product_id
        WHERE s.sale_date >= ($1::timestamptz AT TIME ZONE '${TZ}')::date AND s.sale_date < ($2::timestamptz AT TIME ZONE '${TZ}')::date
          AND s.status NOT IN ('VOID', 'REFUNDED', 'VOIDED_BY_RETURN')
          ${customerFilter}
          ${sessionFilter}
        GROUP BY COALESCE(p.name, si.product_name, 'Custom Item'),
                 COALESCE(NULLIF(TRIM(p.category), ''), 'Uncategorized')
        ORDER BY period
      `;
    } else if (options.groupBy === 'category') {
      rowQuery = `
        SELECT 
          COALESCE(NULLIF(TRIM(p.category), ''), 'Uncategorized') as period,
          COALESCE(NULLIF(TRIM(p.category), ''), 'Uncategorized') as category,
          COUNT(DISTINCT s.id) as transaction_count,
          SUM(si.quantity) as total_quantity_sold,
          SUM(si.total_price) as total_sales,
          0 as total_discounts,
          SUM(si.quantity * si.unit_cost) as total_cost,
          SUM(si.profit) as gross_profit,
          AVG(si.total_price) as average_transaction_value
        FROM sale_items si
        INNER JOIN sales s ON s.id = si.sale_id
        LEFT JOIN products p ON p.id = si.product_id
        WHERE s.sale_date >= ($1::timestamptz AT TIME ZONE '${TZ}')::date AND s.sale_date < ($2::timestamptz AT TIME ZONE '${TZ}')::date
          AND s.status NOT IN ('VOID', 'REFUNDED', 'VOIDED_BY_RETURN')
          ${customerFilter}
          ${sessionFilter}
        GROUP BY COALESCE(NULLIF(TRIM(p.category), ''), 'Uncategorized')
        ORDER BY period
      `;
    } else {
      rowQuery = `
        WITH filtered_sales AS (
          SELECT s.id, s.sale_date, s.customer_id, s.payment_method, s.cashier_id,
                 s.total_amount, s.discount_amount
          FROM sales s
          WHERE s.sale_date >= ($1::timestamptz AT TIME ZONE '${TZ}')::date AND s.sale_date < ($2::timestamptz AT TIME ZONE '${TZ}')::date
            AND s.status NOT IN ('VOID', 'REFUNDED', 'VOIDED_BY_RETURN')
            ${customerFilter}
            ${sessionFilter}
        ),
        sale_line_agg AS (
          SELECT si.sale_id,
                 SUM(si.quantity) as total_qty,
                 SUM(si.total_price) as total_sales,
                 SUM(si.quantity * si.unit_cost) as total_cost,
                 SUM(si.profit) as gross_profit
          FROM sale_items si
          WHERE si.sale_id IN (SELECT id FROM filtered_sales)
          GROUP BY si.sale_id
        )
        SELECT 
          ${selectClause},
          COUNT(fs.id) as transaction_count,
          SUM(sla.total_qty) as total_quantity_sold,
          SUM(sla.total_sales) as total_sales,
          SUM(fs.discount_amount) as total_discounts,
          SUM(sla.total_cost) as total_cost,
          SUM(sla.gross_profit) as gross_profit,
          AVG(fs.total_amount) as average_transaction_value
        FROM filtered_sales fs
        INNER JOIN sale_line_agg sla ON sla.sale_id = fs.id
        LEFT JOIN customers c ON c.id = fs.customer_id
        LEFT JOIN users u ON u.id = fs.cashier_id
        GROUP BY ${groupByClause}
        ORDER BY period
      `;
    }

    // Run summary and rows in parallel
    const [summaryResult, rowResult] = await Promise.all([
      pool.query(summaryQuery, params),
      pool.query(rowQuery, params),
    ]);

    const sr = summaryResult.rows[0];
    const totalSales = new Decimal(sr.total_sales || 0).toDecimalPlaces(2).toNumber();
    const totalDiscounts = new Decimal(sr.total_discounts || 0).toDecimalPlaces(2).toNumber();
    const netRevenue = new Decimal(sr.net_revenue || 0).toDecimalPlaces(2).toNumber();
    const totalCost = new Decimal(sr.total_cost || 0).toDecimalPlaces(2).toNumber();
    const grossProfit = new Decimal(sr.gross_profit || 0).toDecimalPlaces(2).toNumber();
    const totalTransactions = parseInt(sr.total_transactions) || 0;
    const totalQuantitySold = new Decimal(sr.total_quantity_sold || 0).toDecimalPlaces(3).toNumber();
    const profitMargin = netRevenue === 0 ? 0 :
      new Decimal(grossProfit).dividedBy(netRevenue).times(100).toDecimalPlaces(2).toNumber();
    const averageDiscountRate = totalSales === 0 ? 0 :
      new Decimal(totalDiscounts).dividedBy(totalSales).times(100).toDecimalPlaces(2).toNumber();

    const dateGrouped =
      !options.groupBy ||
      options.groupBy === 'day' ||
      options.groupBy === 'week' ||
      options.groupBy === 'month';

    const rows = rowResult.rows.map((row) => {
      const rowTotalSales = new Decimal(row.total_sales || 0);
      const rowTotalDiscounts = new Decimal(row.total_discounts || 0);
      const rowNetRevenue = rowTotalSales.minus(rowTotalDiscounts);
      const rowTotalCost = new Decimal(row.total_cost || 0);
      const rowGrossProfit = rowNetRevenue.minus(rowTotalCost);
      const rowProfitMargin = rowNetRevenue.isZero()
        ? new Decimal(0)
        : rowGrossProfit.dividedBy(rowNetRevenue).times(100);

      const periodRaw = row.period;
      const period = dateGrouped
        ? formatDateOnly(periodRaw) || String(periodRaw ?? '')
        : String(periodRaw ?? '');

      return {
        period,
        totalSales: rowTotalSales.toDecimalPlaces(2).toNumber(),
        totalDiscounts: rowTotalDiscounts.toDecimalPlaces(2).toNumber(),
        netRevenue: rowNetRevenue.toDecimalPlaces(2).toNumber(),
        totalCost: rowTotalCost.toDecimalPlaces(2).toNumber(),
        grossProfit: rowGrossProfit.toDecimalPlaces(2).toNumber(),
        profitMargin: rowProfitMargin.toDecimalPlaces(2).toNumber(),
        transactionCount: parseInt(row.transaction_count),
        averageTransactionValue: new Decimal(row.average_transaction_value || 0)
          .toDecimalPlaces(2)
          .toNumber(),
        totalQuantitySold: new Decimal(row.total_quantity_sold || 0).toDecimalPlaces(3).toNumber(),
        category:
          row.category != null && String(row.category).trim() !== ''
            ? String(row.category)
            : options.groupBy === 'product' || options.groupBy === 'category'
              ? 'Uncategorized'
              : null,
      };
    });

    return {
      rows,
      summary: {
        totalSales,
        totalDiscounts,
        netRevenue,
        totalCost,
        grossProfit,
        profitMargin,
        totalTransactions,
        averageDiscountRate,
        totalQuantitySold,
      },
    };
  },

  /**
   * Shelf-life / expiry register — active batches with qty on hand that are
   * already expired or expire within the horizon (business date).
   * Includes past-due stock still on hand (same rule as category expiry exposure).
   */
  async getExpiringItems(
    pool: Pool,
    options: {
      daysAhead: number;
      categoryId?: string;
      asOfDate?: string;
    }
  ): Promise<ExpiringItemRow[]> {
    const asOf = options.asOfDate || getBusinessDate();
    const params: unknown[] = [asOf, options.daysAhead];
    let categoryFilter = '';

    if (options.categoryId) {
      categoryFilter = 'AND p.category = $3';
      params.push(options.categoryId);
    }

    const query = `
      SELECT 
        b.id as batch_id,
        b.product_id,
        p.name as product_name,
        p.sku,
        b.batch_number,
        b.expiry_date,
        b.cost_price as unit_cost,
        COALESCE(b.original_cost_price, b.cost_price) as original_unit_cost,
        b.remaining_quantity as quantity_remaining
      FROM inventory_batches b
      INNER JOIN products p ON p.id = b.product_id
      WHERE b.expiry_date IS NOT NULL
        AND COALESCE(b.status, 'ACTIVE') = 'ACTIVE'
        AND b.remaining_quantity > 0
        AND b.expiry_date::date <= ($1::date + ($2::text || ' days')::interval)
        ${categoryFilter}
      ORDER BY b.expiry_date ASC, b.remaining_quantity DESC
    `;

    const result = await pool.query(query, params);

    return result.rows.map((row) => {
      const quantityRemaining = new Decimal(row.quantity_remaining);
      const unitCost = new Decimal(row.unit_cost || 0);
      const originalUnitCost = new Decimal(row.original_unit_cost || row.unit_cost || 0);
      const potentialLoss = quantityRemaining.times(unitCost);
      const daysUntilExpiry = computeDaysUntilExpiry(row.expiry_date) ?? 0;

      return {
        batchId: row.batch_id,
        productId: row.product_id,
        productName: row.product_name,
        sku: row.sku || null,
        batchNumber: row.batch_number,
        expiryDate: formatDateOnly(row.expiry_date),
        daysUntilExpiry,
        quantityRemaining: quantityRemaining.toDecimalPlaces(3).toNumber(),
        unitCost: unitCost.toDecimalPlaces(2).toNumber(),
        originalUnitCost: originalUnitCost.toDecimalPlaces(2).toNumber(),
        potentialLoss: potentialLoss.toDecimalPlaces(2).toNumber(),
        urgency: classifyExpiryUrgency(daysUntilExpiry),
      };
    });
  },

  /**
   * LOW STOCK REPORT
   * Products below reorder level
   */
  async getLowStockItems(
    pool: Pool,
    options: {
      threshold?: number;
      categoryId?: string;
    }
  ): Promise<LowStockItemRow[]> {
    const params: unknown[] = [];
    let categoryFilter = '';
    let thresholdFilter = '';

    if (options.categoryId) {
      categoryFilter = 'AND p.category = $1';
      params.push(options.categoryId);
    }

    if (options.threshold !== undefined) {
      const paramIndex = params.length + 1;
      thresholdFilter = `AND current_stock <= $${paramIndex}`;
      params.push(options.threshold);
    }

    const query = `
      WITH product_stock AS (
        SELECT 
          p.id as product_id,
          p.name as product_name,
          p.sku,
          pi.reorder_level,
          0 as reorder_quantity,
          COALESCE((
            SELECT SUM(ib.remaining_quantity)
            FROM inventory_batches ib
            WHERE ib.product_id = p.id
              AND ib.status = 'ACTIVE'
          ), 0) as current_stock
        FROM products p
        LEFT JOIN product_inventory pi ON pi.product_id = p.id
        WHERE p.is_active = true
          ${categoryFilter}
        GROUP BY p.id, p.name, p.sku, pi.reorder_level
      )
      SELECT 
        product_id,
        product_name,
        sku,
        current_stock,
        reorder_level,
        reorder_quantity
      FROM product_stock
      WHERE current_stock <= reorder_level
        ${thresholdFilter}
      ORDER BY 
        CASE 
          WHEN current_stock <= 0 THEN 1
          WHEN current_stock <= reorder_level * 0.5 THEN 2
          ELSE 3
        END,
        current_stock ASC
    `;

    const result = await pool.query(query, params);

    return result.rows.map((row) => {
      const currentStock = new Decimal(row.current_stock);
      const reorderLevel = new Decimal(row.reorder_level);

      let status: 'CRITICAL' | 'LOW' | 'WARNING' = 'WARNING';
      if (currentStock.lessThanOrEqualTo(0)) {
        status = 'CRITICAL';
      } else if (currentStock.lessThanOrEqualTo(reorderLevel.times(0.5))) {
        status = 'LOW';
      }

      return {
        productId: row.product_id,
        productName: row.product_name,
        sku: row.sku,
        currentStock: currentStock.toDecimalPlaces(3).toNumber(),
        reorderLevel: reorderLevel.toDecimalPlaces(3).toNumber(),
        reorderQuantity: row.reorder_quantity
          ? new Decimal(row.reorder_quantity).toDecimalPlaces(3).toNumber()
          : undefined,
        status,
      };
    });
  },

  /**
   * BEST SELLING PRODUCTS REPORT
   * Top products by quantity and revenue
   */
  async getBestSellingProducts(
    pool: Pool,
    options: {
      startDate: string;
      endDate: string;
      limit: number;
      categoryId?: string;
    }
  ): Promise<BestSellingProductRow[]> {
    const [startUtc, endUtc] = toUtcParams(options.startDate, options.endDate);
    const params: unknown[] = [startUtc, endUtc, options.limit];
    let categoryFilter = '';

    if (options.categoryId) {
      categoryFilter = 'AND p.category = $4';
      params.push(options.categoryId);
    }

    const query = `
      SELECT 
        p.id as product_id,
        COALESCE(p.name, si.product_name, 'Custom Item') as product_name,
        p.sku,
        SUM(si.quantity) as quantity_sold,
        SUM(si.total_price) as total_revenue,
        SUM(si.quantity * si.unit_cost) as total_cost,
        SUM(si.profit) as gross_profit,
        COUNT(DISTINCT s.id) as transaction_count
      FROM sale_items si
      INNER JOIN sales s ON s.id = si.sale_id
      LEFT JOIN products p ON p.id = si.product_id
      WHERE s.sale_date >= ($1::timestamptz AT TIME ZONE '${TZ}')::date AND s.sale_date < ($2::timestamptz AT TIME ZONE '${TZ}')::date
        AND s.status NOT IN ('VOID', 'REFUNDED', 'VOIDED_BY_RETURN')
        ${categoryFilter}
      GROUP BY p.id, COALESCE(p.name, si.product_name, 'Custom Item'), p.sku
      ORDER BY quantity_sold DESC
      LIMIT $3
    `;

    const result = await pool.query(query, params);

    return result.rows.map((row) => {
      const totalRevenue = new Decimal(row.total_revenue);
      const totalCost = new Decimal(row.total_cost);
      const grossProfit = totalRevenue.minus(totalCost);
      const profitMargin = totalRevenue.isZero()
        ? new Decimal(0)
        : grossProfit.dividedBy(totalRevenue).times(100);

      return {
        productId: row.product_id,
        productName: row.product_name,
        sku: row.sku,
        quantitySold: new Decimal(row.quantity_sold).toDecimalPlaces(3).toNumber(),
        totalRevenue: totalRevenue.toDecimalPlaces(2).toNumber(),
        totalCost: totalCost.toDecimalPlaces(2).toNumber(),
        grossProfit: grossProfit.toDecimalPlaces(2).toNumber(),
        profitMargin: profitMargin.toDecimalPlaces(2).toNumber(),
        transactionCount: parseInt(row.transaction_count),
      };
    });
  },

  /**
   * SUPPLIER COST ANALYSIS REPORT
   * Analyze supplier performance and costs
   */
  async getSupplierCostAnalysis(
    pool: Pool,
    options: {
      startDate: string;
      endDate: string;
      supplierId?: string;
    }
  ): Promise<SupplierCostAnalysisRow[]> {
    const [startUtc, endUtc] = toUtcParams(options.startDate, options.endDate);
    const params: unknown[] = [startUtc, endUtc];
    let supplierFilter = '';

    if (options.supplierId) {
      supplierFilter = 'AND s."Id" = $3';
      params.push(options.supplierId);
    }

    // Use pre-aggregated subqueries to avoid multiplicative joins
    // (joining POs to GRs directly would inflate SUM(po.total_amount) when a PO has multiple GRs)
    const query = `
      WITH po_agg AS (
        SELECT 
          supplier_id,
          COUNT(id) as total_purchase_orders,
          SUM(total_amount) as total_purchase_value
        FROM purchase_orders
        WHERE order_date >= $1 AND order_date < $2
        GROUP BY supplier_id
      ),
      gr_agg AS (
        SELECT 
          po.supplier_id,
          SUM(gri.received_quantity) as total_items_received,
          AVG(EXTRACT(EPOCH FROM (gr.received_date - po.order_date)) / 86400) as average_lead_time_days,
          (COUNT(CASE WHEN gr.received_date <= po.expected_delivery_date THEN 1 END)::DECIMAL / 
           NULLIF(COUNT(gr.id), 0) * 100) as on_time_delivery_rate
        FROM purchase_orders po
        INNER JOIN goods_receipts gr ON gr.purchase_order_id = po.id
        LEFT JOIN goods_receipt_items gri ON gri.goods_receipt_id = gr.id
        WHERE po.order_date >= $1 AND po.order_date < $2
        GROUP BY po.supplier_id
      )
      SELECT 
        s."Id" as supplier_id,
        s."SupplierCode" as supplier_number,
        s."CompanyName" as supplier_name,
        COALESCE(pa.total_purchase_orders, 0) as total_purchase_orders,
        COALESCE(pa.total_purchase_value, 0) as total_purchase_value,
        COALESCE(ga.total_items_received, 0) as total_items_received,
        ga.average_lead_time_days,
        ga.on_time_delivery_rate
      FROM suppliers s
      INNER JOIN po_agg pa ON pa.supplier_id = s."Id"
      LEFT JOIN gr_agg ga ON ga.supplier_id = s."Id"
      WHERE 1=1
        ${supplierFilter}
      ORDER BY total_purchase_value DESC
    `;

    const result = await pool.query(query, params);

    return result.rows.map((row) => ({
      supplierId: row.supplier_id,
      supplierNumber: row.supplier_number,
      supplierName: row.supplier_name,
      totalPurchaseOrders: parseInt(row.total_purchase_orders),
      totalPurchaseValue: new Decimal(row.total_purchase_value || 0).toDecimalPlaces(2).toNumber(),
      totalItemsReceived: new Decimal(row.total_items_received || 0).toDecimalPlaces(3).toNumber(),
      averageLeadTime: row.average_lead_time_days
        ? new Decimal(row.average_lead_time_days).toDecimalPlaces(1).toNumber()
        : undefined,
      onTimeDeliveryRate: row.on_time_delivery_rate
        ? new Decimal(row.on_time_delivery_rate).toDecimalPlaces(2).toNumber()
        : undefined,
    }));
  },

  /**
   * GOODS RECEIVED REPORT
   * Detailed goods receipts log
   */
  async getGoodsReceivedReport(
    pool: Pool,
    options: {
      startDate: string;
      endDate: string;
      supplierId?: string;
      productId?: string;
    }
  ): Promise<GoodsReceivedRow[]> {
    const [startUtc, endUtc] = toUtcParams(options.startDate, options.endDate);
    const params: unknown[] = [startUtc, endUtc];
    let filters = '';

    if (options.supplierId) {
      filters += ' AND s."Id" = $3';
      params.push(options.supplierId);
    }

    if (options.productId) {
      const paramIndex = params.length + 1;
      filters += ` AND EXISTS (
        SELECT 1 FROM goods_receipt_items gri 
        WHERE gri.goods_receipt_id = gr.id AND gri.product_id = $${paramIndex}
      )`;
      params.push(options.productId);
    }

    const query = `
      SELECT 
        gr.id as goods_receipt_id,
        gr.receipt_number as goods_receipt_number,
        po.order_number as purchase_order_number,
        s."SupplierCode" as supplier_number,
        s."CompanyName" as supplier_name,
        gr.received_date,
        gr.status,
        COUNT(gri.id) as items_count,
        SUM(gri.received_quantity * gri.cost_price) as total_value
      FROM goods_receipts gr
      INNER JOIN purchase_orders po ON po.id = gr.purchase_order_id
      INNER JOIN suppliers s ON s."Id" = po.supplier_id
      LEFT JOIN goods_receipt_items gri ON gri.goods_receipt_id = gr.id
      WHERE gr.received_date >= $1 AND gr.received_date < $2
        ${filters}
      GROUP BY gr.id, gr.receipt_number, po.order_number, s."SupplierCode", s."CompanyName", gr.received_date, gr.status
      ORDER BY gr.received_date DESC
    `;

    const result = await pool.query(query, params);

    return result.rows.map((row) => ({
      goodsReceiptId: row.goods_receipt_id,
      goodsReceiptNumber: row.goods_receipt_number,
      purchaseOrderNumber: row.purchase_order_number,
      supplierNumber: row.supplier_number,
      supplierName: row.supplier_name,
      receivedDate: formatDate(row.received_date),
      totalValue: new Decimal(row.total_value || 0).toDecimalPlaces(2).toNumber(),
      itemsCount: parseInt(row.items_count),
      status: row.status,
    }));
  },

  /**
   * PAYMENT REPORT
   * Breakdown of payments by method
   */
  async getPaymentReport(
    pool: Pool,
    options: {
      startDate: string;
      endDate: string;
      paymentMethod?: string;
    }
  ): Promise<PaymentReportRow[]> {
    const [startUtc, endUtc] = toUtcParams(options.startDate, options.endDate);
    const params: unknown[] = [startUtc, endUtc];
    let methodFilter = '';

    if (options.paymentMethod) {
      methodFilter = 'AND s.payment_method = $3::payment_method';
      params.push(options.paymentMethod);
    }

    const query = `
      WITH payment_summary AS (
        SELECT 
          s.payment_method,
          COUNT(*) as transaction_count,
          SUM(s.total_amount) as total_amount
        FROM sales s
        WHERE s.sale_date >= ($1::timestamptz AT TIME ZONE '${TZ}')::date AND s.sale_date < ($2::timestamptz AT TIME ZONE '${TZ}')::date
          AND s.status NOT IN ('VOID', 'REFUNDED', 'VOIDED_BY_RETURN')
          ${methodFilter}
        GROUP BY s.payment_method
      ),
      grand_total AS (
        SELECT SUM(total_amount) as grand_total FROM payment_summary
      )
      SELECT 
        ps.payment_method,
        ps.transaction_count,
        ps.total_amount,
        ps.total_amount / ps.transaction_count as average_amount,
        (ps.total_amount / gt.grand_total * 100) as percentage_of_total
      FROM payment_summary ps
      CROSS JOIN grand_total gt
      ORDER BY ps.total_amount DESC
    `;

    const result = await pool.query(query, params);

    return result.rows.map((row) => ({
      paymentMethod: row.payment_method,
      transactionCount: parseInt(row.transaction_count),
      totalAmount: new Decimal(row.total_amount).toDecimalPlaces(2).toNumber(),
      averageAmount: new Decimal(row.average_amount).toDecimalPlaces(2).toNumber(),
      percentageOfTotal: new Decimal(row.percentage_of_total || 0).toDecimalPlaces(2).toNumber(),
    }));
  },

  /**
   * CUSTOMER PAYMENTS REPORT (SAP/QB-style)
   * - Collections in period: ar_customer_payments by payment_date (excludes reversals)
   * - Outstanding / overdue: open-item SSOT (INVOICE + OPENING_BALANCE − on-account)
   * - Invoiced in period: invoices issued in range (activity context)
   */
  async getCustomerPaymentsReport(
    pool: Pool,
    options: {
      startDate: string;
      endDate: string;
      customerId?: string;
      status?: string;
    }
  ): Promise<{
    rows: CustomerPaymentsRow[];
    paymentLines: Array<{
      paymentDate: string;
      customerId: string;
      customerNumber: string;
      customerName: string;
      paymentNumber: string;
      paymentMethod: string;
      amount: number;
      allocatedAmount: number;
      unallocatedAmount: number;
      status: string;
    }>;
    summary: {
      totalCustomers: number;
      totalInvoiced: number;
      totalPaid: number;
      totalOutstanding: number;
      totalOverdue: number;
      totalDeposited: number;
      depositAvailable: number;
      collectionsInPeriod: number;
      collectionCount: number;
    };
  }> {
    const params: unknown[] = [options.startDate, options.endDate];
    let customerFilterInv = '';
    let customerFilterPay = '';
    let customerFilterOpen = '';

    if (options.customerId) {
      params.push(options.customerId);
      const p = `$${params.length}`;
      customerFilterInv = ` AND i.customer_id = ${p}`;
      customerFilterPay = ` AND p.customer_id = ${p}`;
      customerFilterOpen = ` AND i.customer_id = ${p}`;
    }

    if (options.status) {
      const paramIndex = params.length + 1;
      params.push(options.status);
      customerFilterInv += ` AND i.status = $${paramIndex}`;
    }

    const openItemFilter = `
      COALESCE(i.document_type, 'INVOICE') IN ('INVOICE', 'OPENING_BALANCE')
      AND i.status NOT IN ('CANCELLED', 'VOIDED', 'DRAFT')
    `;

    const query = `
      WITH invoice_period AS (
        SELECT 
          i.customer_id,
          COUNT(i.id)::integer AS total_invoices,
          COALESCE(SUM(i.total_amount), 0) AS total_invoiced
        FROM invoices i
        WHERE i.issue_date >= $1::date
          AND i.issue_date <= $2::date
          AND ${openItemFilter}
          ${customerFilterInv}
        GROUP BY i.customer_id
      ),
      collections AS (
        SELECT
          p.customer_id,
          COALESCE(SUM(p.total_amount), 0) AS collections_in_period,
          COUNT(p.id)::integer AS collection_count,
          AVG(
            CASE WHEN i.issue_date IS NOT NULL
              THEN EXTRACT(EPOCH FROM (p.payment_date - i.issue_date)) / 86400
              ELSE NULL
            END
          ) AS average_payment_days
        FROM ar_customer_payments p
        LEFT JOIN LATERAL (
          SELECT i.issue_date
          FROM ar_payment_allocations a
          JOIN invoices i ON i.id = a.invoice_id
          WHERE a.payment_id = p.id AND a.status = 'ACTIVE'
          ORDER BY a.allocation_date ASC
          LIMIT 1
        ) i ON true
        WHERE p.status <> 'REVERSED'
          AND p.reversal_of_payment_id IS NULL
          AND p.payment_date >= $1::date
          AND p.payment_date <= $2::date
          ${customerFilterPay}
        GROUP BY p.customer_id
      ),
      open_items AS (
        SELECT
          i.customer_id,
          COALESCE(SUM(i.amount_due), 0) AS gross_outstanding,
          COALESCE(SUM(CASE
            WHEN i.amount_due > 0.009
              AND COALESCE(i.due_date, i.issue_date) < CURRENT_DATE
            THEN i.amount_due ELSE 0
          END), 0) AS overdue_amount
        FROM invoices i
        WHERE ${openItemFilter}
          AND i.amount_due > 0.009
          ${customerFilterOpen}
        GROUP BY i.customer_id
      ),
      unalloc AS (
        SELECT
          p.customer_id,
          COALESCE(SUM(p.unallocated_amount), 0) AS unallocated_credits
        FROM ar_customer_payments p
        WHERE p.status <> 'REVERSED'
          AND p.reversal_of_payment_id IS NULL
          AND p.unallocated_amount > 0.009
          ${customerFilterPay}
        GROUP BY p.customer_id
      ),
      customers_in_scope AS (
        SELECT customer_id FROM invoice_period
        UNION
        SELECT customer_id FROM collections
        UNION
        SELECT customer_id FROM open_items
      )
      SELECT 
        c.id as customer_id,
        c.customer_number as customer_number,
        c.name as customer_name,
        COALESCE(ip.total_invoices, 0) AS total_invoices,
        COALESCE(ip.total_invoiced, 0) AS total_invoiced,
        COALESCE(col.collections_in_period, 0) AS total_paid,
        GREATEST(
          COALESCE(oi.gross_outstanding, 0) - COALESCE(ua.unallocated_credits, 0),
          0
        ) AS total_outstanding,
        COALESCE(oi.overdue_amount, 0) AS overdue_amount,
        col.average_payment_days
      FROM customers_in_scope s
      JOIN customers c ON c.id = s.customer_id
      LEFT JOIN invoice_period ip ON ip.customer_id = c.id
      LEFT JOIN collections col ON col.customer_id = c.id
      LEFT JOIN open_items oi ON oi.customer_id = c.id
      LEFT JOIN unalloc ua ON ua.customer_id = c.id
      ORDER BY total_outstanding DESC, total_paid DESC
    `;

    const paymentLinesQuery = `
      SELECT
        p.payment_date::text AS payment_date,
        c.id::text AS customer_id,
        c.customer_number,
        c.name AS customer_name,
        p.payment_number,
        p.payment_method,
        ROUND(p.total_amount::numeric, 2) AS amount,
        ROUND(p.allocated_amount::numeric, 2) AS allocated_amount,
        ROUND(p.unallocated_amount::numeric, 2) AS unallocated_amount,
        p.status
      FROM ar_customer_payments p
      JOIN customers c ON c.id = p.customer_id
      WHERE p.status <> 'REVERSED'
        AND p.reversal_of_payment_id IS NULL
        AND p.payment_date >= $1::date
        AND p.payment_date <= $2::date
        ${customerFilterPay}
      ORDER BY p.payment_date ASC, c.name ASC, p.payment_number ASC
    `;

    const depositSql = options.customerId
      ? `SELECT
           ROUND(COALESCE(SUM(cd.amount), 0)::numeric, 2) AS total_deposited,
           ROUND(COALESCE(SUM(cd.amount_available), 0)::numeric, 2) AS deposit_available
         FROM pos_customer_deposits cd
         WHERE cd.status = 'ACTIVE' AND cd.amount_available > 0 AND cd.customer_id = $1`
      : `SELECT
           ROUND(COALESCE(SUM(cd.amount), 0)::numeric, 2) AS total_deposited,
           ROUND(COALESCE(SUM(cd.amount_available), 0)::numeric, 2) AS deposit_available
         FROM pos_customer_deposits cd
         WHERE cd.status = 'ACTIVE' AND cd.amount_available > 0`;

    const paymentLineParams = options.customerId
      ? [options.startDate, options.endDate, options.customerId]
      : [options.startDate, options.endDate];

    const [rowResult, linesResult, depositResult] = await Promise.all([
      pool.query(query, params),
      pool.query(paymentLinesQuery, paymentLineParams),
      pool.query(depositSql, options.customerId ? [options.customerId] : []),
    ]);

    const rows = rowResult.rows.map((row) => ({
      customerId: row.customer_id,
      customerNumber: row.customer_number,
      customerName: row.customer_name,
      totalInvoices: parseInt(row.total_invoices, 10) || 0,
      totalInvoiced: new Decimal(row.total_invoiced || 0).toDecimalPlaces(2).toNumber(),
      totalPaid: new Decimal(row.total_paid || 0).toDecimalPlaces(2).toNumber(),
      totalOutstanding: new Decimal(row.total_outstanding || 0).toDecimalPlaces(2).toNumber(),
      overdueAmount: new Decimal(row.overdue_amount || 0).toDecimalPlaces(2).toNumber(),
      averagePaymentDays: row.average_payment_days
        ? new Decimal(row.average_payment_days).toDecimalPlaces(1).toNumber()
        : undefined,
    }));

    const paymentLines = linesResult.rows.map((row) => ({
      paymentDate: String(row.payment_date).slice(0, 10),
      customerId: String(row.customer_id),
      customerNumber: String(row.customer_number || ''),
      customerName: String(row.customer_name || ''),
      paymentNumber: String(row.payment_number || ''),
      paymentMethod: String(row.payment_method || ''),
      amount: new Decimal(row.amount || 0).toDecimalPlaces(2).toNumber(),
      allocatedAmount: new Decimal(row.allocated_amount || 0).toDecimalPlaces(2).toNumber(),
      unallocatedAmount: new Decimal(row.unallocated_amount || 0).toDecimalPlaces(2).toNumber(),
      status: String(row.status || ''),
    }));

    const dep = depositResult.rows[0] || {};
    const collectionsInPeriod = paymentLines.reduce(
      (s, l) => new Decimal(s).plus(l.amount).toNumber(),
      0,
    );

    return {
      rows,
      paymentLines,
      summary: {
        totalCustomers: rows.length,
        totalInvoiced: rows.reduce((s, r) => new Decimal(s).plus(r.totalInvoiced).toNumber(), 0),
        totalPaid: collectionsInPeriod,
        totalOutstanding: rows.reduce((s, r) => new Decimal(s).plus(r.totalOutstanding).toNumber(), 0),
        totalOverdue: rows.reduce((s, r) => new Decimal(s).plus(r.overdueAmount).toNumber(), 0),
        totalDeposited: new Decimal(dep.total_deposited || 0).toDecimalPlaces(2).toNumber(),
        depositAvailable: new Decimal(dep.deposit_available || 0).toDecimalPlaces(2).toNumber(),
        collectionsInPeriod,
        collectionCount: paymentLines.length,
      },
    };
  },

  /**
   * PROFIT & LOSS REPORT
   * Comprehensive P&L statement
   */
  async getProfitLossReport(
    pool: Pool,
    options: {
      startDate: string;
      endDate: string;
      groupBy: 'day' | 'week' | 'month';
    }
  ): Promise<{
    rows: ProfitLossRow[];
    summary: ProfitLossSummary;
    expenseBreakdown: ExpenseBreakdownRow[];
  }> {
    const [startUtc, endUtc] = toUtcParams(options.startDate, options.endDate);
    let dateGroup = '';
    switch (options.groupBy) {
      case 'day':
        dateGroup = `(s.sale_date AT TIME ZONE '${TZ}')::date`;
        break;
      case 'week':
        dateGroup = `DATE_TRUNC('week', s.sale_date AT TIME ZONE '${TZ}')::DATE`;
        break;
      case 'month':
        dateGroup = `DATE_TRUNC('month', s.sale_date AT TIME ZONE '${TZ}')::DATE`;
        break;
    }

    const query = `
      SELECT 
        ${dateGroup} as period,
        SUM(s.total_amount) as revenue,
        SUM(s.total_cost) as cost_of_goods_sold,
        SUM(s.profit) as gross_profit
      FROM sales s
      WHERE s.sale_date >= ($1::timestamptz AT TIME ZONE '${TZ}')::date AND s.sale_date < ($2::timestamptz AT TIME ZONE '${TZ}')::date
        AND s.status NOT IN ('VOID', 'REFUNDED', 'VOIDED_BY_RETURN')
      GROUP BY ${dateGroup}
      ORDER BY period
    `;

    const summaryQuery = `
      SELECT 
        COALESCE(SUM(s.total_amount), 0) as total_revenue,
        COALESCE(SUM(s.total_cost), 0) as total_cogs,
        COALESCE(SUM(s.profit), 0) as gross_profit,
        CASE WHEN SUM(s.total_amount) > 0
          THEN ROUND((SUM(s.profit) / SUM(s.total_amount)) * 100, 2)
          ELSE 0
        END as gross_profit_margin
      FROM sales s
      WHERE s.sale_date >= ($1::timestamptz AT TIME ZONE '${TZ}')::date AND s.sale_date < ($2::timestamptz AT TIME ZONE '${TZ}')::date
        AND s.status NOT IN ('VOID', 'REFUNDED', 'VOIDED_BY_RETURN')
    `;

    const [result, summaryResult, expenseResult, supplierPayResult] = await Promise.all([
      pool.query(query, [startUtc, endUtc]),
      pool.query(summaryQuery, [startUtc, endUtc]),
      // Operating expenses from GL
      pool.query(`
        SELECT
          a."AccountCode" AS account_code,
          a."AccountName" AS account_name,
          COUNT(le."Id")::integer AS entry_count,
          ROUND(COALESCE(SUM(le."DebitAmount"), 0)::numeric, 2) AS total_amount
        FROM ledger_entries le
        JOIN ledger_transactions lt ON lt."Id" = le."TransactionId"
        JOIN accounts a ON a."Id" = le."AccountId"
        WHERE lt."Status" = 'POSTED'
          AND lt."ReferenceType" IN ('EXPENSE', 'EXPENSE_PAYMENT')
          AND a."AccountType" = 'EXPENSE'
          AND le."DebitAmount" > 0
          AND ($1::timestamptz IS NULL OR le."EntryDate" >= $1::timestamptz)
          AND ($2::timestamptz IS NULL OR le."EntryDate" < $2::timestamptz)
        GROUP BY a."AccountCode", a."AccountName"
        ORDER BY total_amount DESC
      `, [startUtc, endUtc]),
      // Supplier payments (non-P&L cash disbursements)
      pool.query(`
        SELECT
          ROUND(COALESCE(SUM(le."CreditAmount"), 0)::numeric, 2) AS total_paid,
          COUNT(DISTINCT lt."Id")::integer AS payment_count
        FROM ledger_entries le
        JOIN ledger_transactions lt ON lt."Id" = le."TransactionId"
        JOIN accounts a ON a."Id" = le."AccountId"
        WHERE lt."Status" = 'POSTED'
          AND lt."ReferenceType" = 'SUPPLIER_PAYMENT'
          AND le."CreditAmount" > 0
          AND a."AccountType" IN ('ASSET', 'BANK')
          AND ($1::timestamptz IS NULL OR le."EntryDate" >= $1::timestamptz)
          AND ($2::timestamptz IS NULL OR le."EntryDate" < $2::timestamptz)
      `, [startUtc, endUtc]),
    ]);

    const sRow = summaryResult.rows[0] || {};
    const totalRevenue = new Decimal(sRow.total_revenue || 0);
    const totalCOGS = new Decimal(sRow.total_cogs || 0);
    const grossProfit = totalRevenue.minus(totalCOGS);
    const grossProfitMargin = totalRevenue.isZero()
      ? new Decimal(0)
      : grossProfit.dividedBy(totalRevenue).times(100);

    // Compute total expenses
    const totalExpenses = expenseResult.rows.reduce(
      (sum: Decimal, r: Record<string, unknown>) => sum.plus(new Decimal(String(r.total_amount) || '0')),
      new Decimal(0)
    );
    const operatingProfit = grossProfit.minus(totalExpenses);
    const netProfit = operatingProfit; // same for now (no interest/tax)
    const netProfitMargin = totalRevenue.isZero()
      ? new Decimal(0)
      : netProfit.dividedBy(totalRevenue).times(100);

    // Supplier payments (memo)
    const spRow = supplierPayResult.rows[0] || {};

    return {
      rows: result.rows.map((row) => {
        const revenue = new Decimal(row.revenue || 0);
        const cogs = new Decimal(row.cost_of_goods_sold || 0);
        const grossProfit = revenue.minus(cogs);
        const grossProfitMargin = revenue.isZero()
          ? new Decimal(0)
          : grossProfit.dividedBy(revenue).times(100);

        return {
          period: formatDateOnly(row.period) || String(row.period),
          revenue: revenue.toDecimalPlaces(2).toNumber(),
          costOfGoodsSold: cogs.toDecimalPlaces(2).toNumber(),
          grossProfit: grossProfit.toDecimalPlaces(2).toNumber(),
          grossProfitMargin: grossProfitMargin.toDecimalPlaces(2).toNumber(),
        };
      }),
      summary: {
        totalRevenue: totalRevenue.toDecimalPlaces(2).toNumber(),
        totalCOGS: totalCOGS.toDecimalPlaces(2).toNumber(),
        grossProfit: grossProfit.toDecimalPlaces(2).toNumber(),
        grossProfitMargin: grossProfitMargin.toDecimalPlaces(2).toNumber(),
        totalExpenses: totalExpenses.toDecimalPlaces(2).toNumber(),
        operatingProfit: operatingProfit.toDecimalPlaces(2).toNumber(),
        netProfit: netProfit.toDecimalPlaces(2).toNumber(),
        netProfitMargin: netProfitMargin.toDecimalPlaces(2).toNumber(),
        totalSupplierPayments: new Decimal(spRow.total_paid || 0).toDecimalPlaces(2).toNumber(),
        supplierPaymentCount: Number(spRow.payment_count || 0),
      },
      expenseBreakdown: expenseResult.rows.map((r) => ({
        accountCode: String(r.account_code),
        accountName: String(r.account_name),
        entryCount: Number(r.entry_count),
        totalAmount: new Decimal(String(r.total_amount) || '0').toDecimalPlaces(2).toNumber(),
      })),
    };
  },

  /**
   * DELETED ITEMS REPORT
   * Audit trail of deleted/deactivated products
   */
  async getDeletedItemsReport(
    pool: Pool,
    options: {
      startDate?: string;
      endDate?: string;
    }
  ): Promise<DeletedItemRow[]> {
    const params: unknown[] = [];
    let dateFilter = '';

    if (options.startDate && options.endDate) {
      const { startUtc, endUtc } = toUtcRange(options.startDate, options.endDate, BUSINESS_TIMEZONE);
      dateFilter = 'AND p.updated_at >= $1 AND p.updated_at < $2';
      params.push(startUtc, endUtc);
    }

    const query = `
      SELECT 
        p.id as product_id,
        p.name as product_name,
        p.sku,
        p.updated_at as deleted_date,
        p.description,
        COALESCE(SUM(
          CASE 
            WHEN sm.movement_type IN ('GOODS_RECEIPT', 'ADJUSTMENT_IN', 'RETURN', 'TRANSFER_IN', 'OPENING_BALANCE') THEN sm.quantity
            WHEN sm.movement_type IN ('SALE', 'ADJUSTMENT_OUT', 'EXPIRY', 'DAMAGE', 'TRANSFER_OUT') THEN -sm.quantity
            ELSE 0
          END
        ), 0) as final_stock_level
      FROM products p
      LEFT JOIN stock_movements sm ON sm.product_id = p.id
      WHERE p.is_active = false
        ${dateFilter}
      GROUP BY p.id, p.name, p.sku, p.updated_at, p.description
      ORDER BY p.updated_at DESC
    `;

    const result = await pool.query(query, params);

    return result.rows.map((row) => ({
      productId: row.product_id,
      productName: row.product_name,
      sku: row.sku,
      deletedDate: formatDate(row.deleted_date),
      description: row.description,
      finalStockLevel: new Decimal(row.final_stock_level).toDecimalPlaces(3).toNumber(),
    }));
  },

  /**
   * INVENTORY ADJUSTMENTS REPORT
   * Track all inventory adjustments (increases and decreases)
   */
  async getInventoryAdjustmentsReport(
    pool: Pool,
    options: {
      startDate: string;
      endDate: string;
      productId?: string;
    }
  ): Promise<InventoryAdjustmentRow[]> {
    const { startUtc, endUtc } = toUtcRange(options.startDate, options.endDate, BUSINESS_TIMEZONE);
    const params: unknown[] = [startUtc, endUtc];
    let productFilter = '';

    if (options.productId) {
      productFilter = 'AND sm.product_id = $3';
      params.push(options.productId);
    }

    const query = `
      SELECT 
        sm.id as movement_id,
        sm.created_at as movement_date,
        sm.movement_type,
        p.name as product_name,
        p.sku,
        b.batch_number,
        sm.quantity as quantity_change,
        sm.reference_id as reference_number,
        sm.notes,
        sm.created_by_id as performed_by
      FROM stock_movements sm
      INNER JOIN products p ON p.id = sm.product_id
      LEFT JOIN inventory_batches b ON b.id = sm.batch_id
      WHERE sm.movement_type IN ('ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'EXPIRY', 'DAMAGE', 'RETURN', 'TRANSFER_IN', 'TRANSFER_OUT', 'OPENING_BALANCE')
        AND sm.created_at >= $1 AND sm.created_at < $2
        ${productFilter}
      ORDER BY sm.created_at DESC
    `;

    const result = await pool.query(query, params);

    return result.rows.map((row) => ({
      movementId: row.movement_id,
      movementDate: formatDate(row.movement_date),
      movementType: row.movement_type,
      productName: row.product_name,
      sku: row.sku,
      batchNumber: row.batch_number,
      quantityChange: new Decimal(row.quantity_change).toDecimalPlaces(3).toNumber(),
      referenceNumber: row.reference_number,
      notes: row.notes,
      performedBy: row.performed_by,
    }));
  },

  /**
   * PURCHASE ORDER SUMMARY REPORT
   * Track purchase orders by status, supplier, and date range
   */
  async getPurchaseOrderSummary(
    pool: Pool,
    options: {
      startDate?: string;
      endDate?: string;
      status?: string;
      supplierId?: string;
    }
  ): Promise<PurchaseOrderSummaryRow[]> {
    const params: unknown[] = [];
    const filters: string[] = [];

    if (options.startDate && options.endDate) {
      const [su, eu] = toUtcParams(options.startDate, options.endDate);
      params.push(su, eu);
      filters.push(
        `po.order_date >= $${params.length - 1} AND po.order_date < $${params.length}`
      );
    }

    if (options.status) {
      params.push(options.status);
      filters.push(`po.status = $${params.length}`);
    }

    if (options.supplierId) {
      params.push(options.supplierId);
      filters.push(`po.supplier_id = $${params.length}`);
    }

    const whereClause = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';

    const query = `
      SELECT 
        po.id,
        po.order_number,
        po.status,
        po.order_date,
        po.expected_delivery_date,
        po.created_at,
        s."SupplierCode" as supplier_number,
        s."CompanyName" as supplier_name,
        s."Email" as supplier_email,
        s."Phone" as supplier_phone,
        COALESCE(po.total_amount, 0) as total_amount,
        COUNT(DISTINCT gr.id) as total_receipts,
        COALESCE(SUM(gri.received_quantity), 0) as total_received,
        po.notes
      FROM purchase_orders po
      INNER JOIN suppliers s ON s."Id" = po.supplier_id
      LEFT JOIN goods_receipts gr ON gr.purchase_order_id = po.id
      LEFT JOIN goods_receipt_items gri ON gri.goods_receipt_id = gr.id
      ${whereClause}
      GROUP BY po.id, po.order_number, po.status, po.order_date, po.expected_delivery_date, 
               po.created_at, s."SupplierCode", s."CompanyName", s."Email", s."Phone", po.total_amount, po.notes
      ORDER BY po.created_at DESC
    `;

    const result = await pool.query(query, params);

    return result.rows.map((row) => ({
      id: row.id,
      poNumber: row.order_number,
      status: row.status,
      orderDate: formatDate(row.order_date),
      expectedDeliveryDate: formatDateOnly(row.expected_delivery_date),
      supplierNumber: row.supplier_number,
      supplierName: row.supplier_name,
      supplierEmail: row.supplier_email,
      supplierPhone: row.supplier_phone,
      totalAmount: new Decimal(row.total_amount || 0).toDecimalPlaces(2).toNumber(),
      totalReceipts: parseInt(row.total_receipts),
      totalReceived: new Decimal(row.total_received || 0).toDecimalPlaces(3).toNumber(),
      notes: row.notes,
      createdAt: formatDate(row.created_at),
    }));
  },

  /**
   * STOCK MOVEMENT ANALYSIS REPORT
   * Analyze stock movements by type, product, or date range
   */
  async getStockMovementAnalysis(
    pool: Pool,
    options: {
      startDate: string;
      endDate: string;
      productId?: string;
      movementType?: string;
      groupBy?: 'day' | 'week' | 'month' | 'product' | 'movement_type';
    }
  ): Promise<{
    rows: StockMovementAnalysisRow[];
    summary: {
      totalTransactions: number;
      totalIn: number;
      totalOut: number;
      netMovement: number;
    };
  }> {
    const [startUtc, endUtc] = toUtcParams(options.startDate, options.endDate);
    const params: unknown[] = [startUtc, endUtc];
    const filters: string[] = ['sm.created_at >= $1 AND sm.created_at < $2'];

    if (options.productId) {
      params.push(options.productId);
      filters.push(`sm.product_id = $${params.length}`);
    }

    if (options.movementType) {
      params.push(options.movementType);
      filters.push(`sm.movement_type = $${params.length}`);
    }

    const whereClause = filters.join(' AND ');

    let groupByClause = '';
    let selectFields = '';

    switch (options.groupBy) {
      case 'day':
        groupByClause = `(sm.created_at AT TIME ZONE '${TZ}')::date`;
        selectFields = `(sm.created_at AT TIME ZONE '${TZ}')::date as period`;
        break;
      case 'week':
        groupByClause = `DATE_TRUNC('week', sm.created_at AT TIME ZONE '${TZ}')`;
        selectFields = `DATE_TRUNC('week', sm.created_at AT TIME ZONE '${TZ}') as period`;
        break;
      case 'month':
        groupByClause = `DATE_TRUNC('month', sm.created_at AT TIME ZONE '${TZ}')`;
        selectFields = `DATE_TRUNC('month', sm.created_at AT TIME ZONE '${TZ}') as period`;
        break;
      case 'product':
        groupByClause = 'p.id, p.name, p.sku';
        selectFields = `p.id as product_id, p.name as product_name, p.sku`;
        break;
      case 'movement_type':
        groupByClause = 'sm.movement_type';
        selectFields = `sm.movement_type`;
        break;
      default:
        groupByClause = 'sm.movement_type, p.id, p.name, p.sku';
        selectFields = `sm.movement_type, p.id as product_id, p.name as product_name, p.sku`;
    }

    const query = `
      SELECT 
        ${selectFields},
        COUNT(sm.id) as transaction_count,
        SUM(CASE WHEN sm.movement_type IN ('GOODS_RECEIPT', 'ADJUSTMENT_IN', 'RETURN', 'TRANSFER_IN', 'OPENING_BALANCE') THEN sm.quantity ELSE 0 END) as total_in,
        SUM(CASE WHEN sm.movement_type IN ('SALE', 'ADJUSTMENT_OUT', 'DAMAGE', 'EXPIRY', 'TRANSFER_OUT') THEN sm.quantity ELSE 0 END) as total_out,
        SUM(CASE WHEN sm.movement_type IN ('GOODS_RECEIPT', 'ADJUSTMENT_IN', 'RETURN', 'TRANSFER_IN', 'OPENING_BALANCE') THEN sm.quantity ELSE -sm.quantity END) as net_movement
      FROM stock_movements sm
      INNER JOIN products p ON p.id = sm.product_id
      WHERE ${whereClause}
      GROUP BY ${groupByClause}
      ORDER BY ${groupByClause}
    `;

    // Summary query: aggregate totals in SQL
    const summaryQuery = `
      SELECT
        COUNT(sm.id) as transaction_count,
        COALESCE(SUM(CASE WHEN sm.movement_type IN ('GOODS_RECEIPT', 'ADJUSTMENT_IN', 'RETURN', 'TRANSFER_IN', 'OPENING_BALANCE') THEN sm.quantity ELSE 0 END), 0) as total_in,
        COALESCE(SUM(CASE WHEN sm.movement_type IN ('SALE', 'ADJUSTMENT_OUT', 'DAMAGE', 'EXPIRY', 'TRANSFER_OUT') THEN sm.quantity ELSE 0 END), 0) as total_out,
        COALESCE(SUM(CASE WHEN sm.movement_type IN ('GOODS_RECEIPT', 'ADJUSTMENT_IN', 'RETURN', 'TRANSFER_IN', 'OPENING_BALANCE') THEN sm.quantity ELSE -sm.quantity END), 0) as net_movement
      FROM stock_movements sm
      WHERE ${whereClause}
    `;

    const [result, summaryResult] = await Promise.all([
      pool.query(query, params),
      pool.query(summaryQuery, params),
    ]);

    const sRow = summaryResult.rows[0] || {};

    return {
      rows: result.rows.map((row) => ({
        ...row,
        transactionCount: parseInt(row.transaction_count),
        totalIn: new Decimal(row.total_in || 0).toDecimalPlaces(3).toNumber(),
        totalOut: new Decimal(row.total_out || 0).toDecimalPlaces(3).toNumber(),
        netMovement: new Decimal(row.net_movement || 0).toDecimalPlaces(3).toNumber(),
        period: formatDateOnly(row.period),
      })),
      summary: {
        totalTransactions: parseInt(sRow.transaction_count || 0),
        totalIn: new Decimal(sRow.total_in || 0).toDecimalPlaces(3).toNumber(),
        totalOut: new Decimal(sRow.total_out || 0).toDecimalPlaces(3).toNumber(),
        netMovement: new Decimal(sRow.net_movement || 0).toDecimalPlaces(3).toNumber(),
      },
    };
  },

  /**
   * CUSTOMER ACCOUNT STATEMENT REPORT
   * Show customer balance, credit limit, and transaction history
   */
  /**
   * @deprecated Sales-based statement — NOT used by generateCustomerAccountStatement.
   * Live path is cnDnReportService.getSmartCustomerStatementData (GL 1200).
   * Kept only to avoid accidental re-wire; do not call for AR accuracy.
   */
  async getCustomerAccountStatement(
    pool: Pool,
    options: {
      customerId: string;
      startDate?: string;
      endDate?: string;
    }
  ): Promise<CustomerAccountStatementData> {
    const params: unknown[] = [options.customerId];
    const filters: string[] = ['s.customer_id = $1'];

    if (options.startDate && options.endDate) {
      params.push(options.startDate, options.endDate);
      filters.push(`s.sale_date BETWEEN $${params.length - 1} AND $${params.length}`);
    }

    const whereClause = filters.join(' AND ');

    // Get customer details
    const customerQuery = `
      SELECT 
        c.id,
        c.customer_number,
        c.name,
        c.email,
        c.phone,
        c.credit_limit,
        COALESCE(c.balance, 0) as current_balance,
        c.customer_group_id
      FROM customers c
      WHERE c.id = $1
    `;

    const customerResult = await pool.query(customerQuery, [options.customerId]);

    if (customerResult.rows.length === 0) {
      throw new Error('Customer not found');
    }

    const customer = customerResult.rows[0];

    // Get transaction history with invoice-based balance (invoices track actual payments)
    const transactionsQuery = `
      SELECT 
        s.id as sale_id,
        s.sale_number,
        s.sale_date,
        s.total_amount,
        COALESCE(i."AmountPaid", s.amount_paid) as amount_paid,
        COALESCE(i.amount_due, s.total_amount - s.amount_paid) as balance_due,
        COALESCE(i.status, s.status::text) as payment_status,
        array_agg(
          json_build_object(
            'product_name', COALESCE(p.name, si.product_name, 'Custom Item'),
            'quantity', si.quantity,
            'unit_price', si.unit_price,
            'subtotal', si.total_price
          )
        ) as items
      FROM sales s
      LEFT JOIN invoices i ON i.sale_id = s.id
      LEFT JOIN sale_items si ON si.sale_id = s.id
      LEFT JOIN products p ON p.id = si.product_id
      WHERE ${whereClause}
      GROUP BY s.id, s.sale_number, s.sale_date, s.total_amount, s.amount_paid, s.status,
               i.amount_paid, i.amount_due, i.status
      ORDER BY s.sale_date DESC
    `;

    // Summary query: aggregate transaction totals in SQL
    const summaryQuery = `
      SELECT
        COUNT(s.id) as total_transactions,
        COALESCE(SUM(s.total_amount), 0) as total_sales,
        COALESCE(SUM(COALESCE(i.amount_paid, s.amount_paid)), 0) as total_paid,
        COALESCE(SUM(COALESCE(i.amount_due, s.total_amount - s.amount_paid)), 0) as total_outstanding
      FROM sales s
      LEFT JOIN invoices i ON i.sale_id = s.id
      WHERE ${whereClause}
    `;

    const [transactionsResult, summaryResult] = await Promise.all([
      pool.query(transactionsQuery, params),
      pool.query(summaryQuery, params),
    ]);

    const sRow = summaryResult.rows[0] || {};

    return {
      customer: {
        id: customer.id,
        customerNumber: customer.customer_number,
        name: customer.name,
        email: customer.email,
        phone: customer.phone,
        creditLimit: new Decimal(customer.credit_limit || 0).toDecimalPlaces(2).toNumber(),
        currentBalance: new Decimal(customer.current_balance).toDecimalPlaces(2).toNumber(),
        customerGroupId: customer.customer_group_id,
      },
      transactions: transactionsResult.rows.map((row) => ({
        saleId: row.sale_id,
        saleNumber: row.sale_number,
        saleDate: formatDate(row.sale_date),
        totalAmount: new Decimal(row.total_amount).toDecimalPlaces(2).toNumber(),
        amountPaid: new Decimal(row.amount_paid).toDecimalPlaces(2).toNumber(),
        balanceDue: new Decimal(row.balance_due).toDecimalPlaces(2).toNumber(),
        paymentStatus: row.payment_status,
        items: row.items,
      })),
      transactionSummary: {
        totalTransactions: parseInt(sRow.total_transactions || 0),
        totalSales: new Decimal(sRow.total_sales || 0).toDecimalPlaces(2).toNumber(),
        totalPaid: new Decimal(sRow.total_paid || 0).toDecimalPlaces(2).toNumber(),
        totalOutstanding: new Decimal(sRow.total_outstanding || 0).toDecimalPlaces(2).toNumber(),
      },
    };
  },

  /**
   * PROFIT MARGIN BY PRODUCT REPORT
   * Calculate profit margins for each product
   */
  async getProfitMarginByProduct(
    pool: Pool,
    options: {
      startDate?: string;
      endDate?: string;
      categoryId?: string;
      minMarginPercent?: number;
    }
  ): Promise<{
    rows: ProfitMarginByProductRow[];
    summary: {
      totalProducts: number;
      totalRevenue: number;
      totalCost: number;
      totalProfit: number;
      averageMarginPercent: number;
    };
  }> {
    const params: unknown[] = [];
    const filters: string[] = [];

    if (options.startDate && options.endDate) {
      params.push(options.startDate, options.endDate);
      filters.push(`s.sale_date BETWEEN $${params.length - 1} AND $${params.length}`);
    }

    if (options.categoryId) {
      params.push(options.categoryId);
      filters.push(`p.category = $${params.length}`);
    }

    const whereClause = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';

    const query = `
      SELECT 
        p.id as product_id,
        p.name as product_name,
        p.sku,
        p.category,
        COUNT(DISTINCT s.id) as total_sales,
        SUM(si.quantity) as total_quantity_sold,
        SUM(si.total_price) as total_revenue,
        SUM(si.unit_cost * si.quantity) as total_cost,
        SUM(si.profit) as total_profit,
        CASE 
          WHEN SUM(si.total_price) > 0 
          THEN ((SUM(si.profit) / SUM(si.total_price)) * 100)
          ELSE 0 
        END as profit_margin_percent
      FROM products p
      LEFT JOIN sale_items si ON si.product_id = p.id
      LEFT JOIN sales s ON s.id = si.sale_id
      ${whereClause}
      GROUP BY p.id, p.name, p.sku, p.category
      HAVING SUM(si.quantity) > 0
      ${options.minMarginPercent !== undefined
        ? (() => {
          params.push(options.minMarginPercent);
          return `AND ((SUM(si.profit) / NULLIF(SUM(si.total_price), 0)) * 100) >= $${params.length}`;
        })()
        : ''
      }
      ORDER BY total_profit DESC
    `;

    const result = await pool.query(query, params);

    // Build summary from a wrapping query over the same data
    const summaryParams: unknown[] = [];
    const summaryFilters: string[] = [];
    if (options.startDate && options.endDate) {
      summaryParams.push(options.startDate, options.endDate);
      summaryFilters.push(`s.sale_date BETWEEN $${summaryParams.length - 1} AND $${summaryParams.length}`);
    }
    if (options.categoryId) {
      summaryParams.push(options.categoryId);
      summaryFilters.push(`p.category = $${summaryParams.length}`);
    }
    const summaryWhere = summaryFilters.length > 0 ? `WHERE ${summaryFilters.join(' AND ')}` : '';

    let summaryHaving = 'HAVING SUM(si.quantity) > 0';
    if (options.minMarginPercent !== undefined) {
      summaryParams.push(options.minMarginPercent);
      summaryHaving += ` AND ((SUM(si.profit) / NULLIF(SUM(si.total_price), 0)) * 100) >= $${summaryParams.length}`;
    }

    const summaryQuery = `
      SELECT
        COUNT(*) as total_products,
        COALESCE(SUM(total_revenue), 0) as total_revenue,
        COALESCE(SUM(total_cost), 0) as total_cost,
        COALESCE(SUM(total_profit), 0) as total_profit,
        COALESCE(AVG(margin_pct), 0) as avg_margin
      FROM (
        SELECT
          SUM(si.total_price) as total_revenue,
          SUM(si.unit_cost * si.quantity) as total_cost,
          SUM(si.profit) as total_profit,
          CASE WHEN SUM(si.total_price) > 0
            THEN ((SUM(si.profit) / SUM(si.total_price)) * 100)
            ELSE 0
          END as margin_pct
        FROM products p
        LEFT JOIN sale_items si ON si.product_id = p.id
        LEFT JOIN sales s ON s.id = si.sale_id
        ${summaryWhere}
        GROUP BY p.id
        ${summaryHaving}
      ) sub
    `;

    const summaryResult = await pool.query(summaryQuery, summaryParams);
    const sRow = summaryResult.rows[0] || {};

    const rows = result.rows.map((row) => ({
      productId: row.product_id,
      productName: row.product_name,
      sku: row.sku,
      category: row.category,
      totalSales: parseInt(row.total_sales),
      totalQuantitySold: new Decimal(row.total_quantity_sold || 0).toDecimalPlaces(3).toNumber(),
      totalRevenue: new Decimal(row.total_revenue || 0).toDecimalPlaces(2).toNumber(),
      totalCost: new Decimal(row.total_cost || 0).toDecimalPlaces(2).toNumber(),
      totalProfit: new Decimal(row.total_profit || 0).toDecimalPlaces(2).toNumber(),
      profitMarginPercent: new Decimal(row.profit_margin_percent || 0)
        .toDecimalPlaces(2)
        .toNumber(),
    }));

    return {
      rows,
      summary: {
        totalProducts: parseInt(sRow.total_products || 0),
        totalRevenue: new Decimal(sRow.total_revenue || 0).toDecimalPlaces(2).toNumber(),
        totalCost: new Decimal(sRow.total_cost || 0).toDecimalPlaces(2).toNumber(),
        totalProfit: new Decimal(sRow.total_profit || 0).toDecimalPlaces(2).toNumber(),
        averageMarginPercent: new Decimal(sRow.avg_margin || 0).toDecimalPlaces(2).toNumber(),
      },
    };
  },

  /**
   * ENHANCED DAILY CASH FLOW REPORT
   * Track daily cash in/out with separation of sales revenue vs debt collections
   * Bank-grade precision with Decimal.js for all financial calculations
   */
  async getDailyCashFlow(
    pool: Pool,
    options: {
      startDate: string;
      endDate: string;
      paymentMethod?: string;
      includeDebCollections?: boolean;
    }
  ): Promise<{
    rows: DailyCashFlowRow[];
    summary: {
      totalDays: number;
      salesRevenue: number;
      salesTransactionCount: number;
      totalSalesValue: number;
      grossProfit: number;
      overallProfitMargin: number;
      debtCollections: number;
      collectionsTransactionCount: number;
      depositReceipts: number;
      depositsTransactionCount: number;
      totalCashIn: number;
      totalTransactions: number;
      creditExtended: number;
    };
  }> {
    const startDate = String(options.startDate).slice(0, 10);
    const endDate = String(options.endDate).slice(0, 10);

    try {
      /**
       * SAP / QB cash journal SSOT:
       * 1) POS liquid receipts (sales.amount_paid, exclude CREDIT method tickets' unpaid credit leg)
       * 2) AR collections (ar_customer_payments → Undeposited Funds)
       * 3) Customer deposits (pos_customer_deposits)
       * Credit extended is memo only — not cash in.
       */
      const query = `
        WITH pos_cash AS (
          SELECT
            (s.sale_date AT TIME ZONE '${TZ}')::date AS transaction_date,
            s.payment_method::text AS payment_method,
            'POS_RECEIPT'::text AS revenue_type,
            COUNT(s.id)::integer AS transaction_count,
            ROUND(SUM(COALESCE(s.amount_paid, 0))::numeric, 4) AS cash_amount,
            ROUND(SUM(COALESCE(s.total_amount, 0))::numeric, 4) AS total_sales,
            ROUND(SUM(COALESCE(s.total_cost, 0))::numeric, 4) AS total_cost,
            ROUND(SUM(COALESCE(s.profit, 0))::numeric, 4) AS gross_profit,
            ROUND(SUM(GREATEST(COALESCE(s.total_amount, 0) - COALESCE(s.amount_paid, 0), 0))::numeric, 4) AS credit_created,
            ROUND(AVG(COALESCE(s.amount_paid, 0))::numeric, 4) AS average_transaction_value
          FROM sales s
          WHERE (s.sale_date AT TIME ZONE '${TZ}')::date >= $1::date
            AND (s.sale_date AT TIME ZONE '${TZ}')::date <= $2::date
            AND s.status NOT IN ('VOID', 'REFUNDED', 'VOIDED_BY_RETURN')
            AND COALESCE(s.amount_paid, 0) > 0.009
            AND UPPER(COALESCE(s.payment_method::text, '')) <> 'CREDIT'
            ${options.paymentMethod ? 'AND s.payment_method::text = $3' : ''}
          GROUP BY 1, 2
        ),
        credit_memo AS (
          SELECT
            (s.sale_date AT TIME ZONE '${TZ}')::date AS transaction_date,
            COALESCE(s.payment_method::text, 'CREDIT') AS payment_method,
            'CREDIT_EXTENDED'::text AS revenue_type,
            COUNT(s.id)::integer AS transaction_count,
            0::numeric AS cash_amount,
            ROUND(SUM(COALESCE(s.total_amount, 0))::numeric, 4) AS total_sales,
            ROUND(SUM(COALESCE(s.total_cost, 0))::numeric, 4) AS total_cost,
            ROUND(SUM(COALESCE(s.profit, 0))::numeric, 4) AS gross_profit,
            ROUND(SUM(
              CASE
                WHEN UPPER(COALESCE(s.payment_method::text, '')) = 'CREDIT'
                  THEN COALESCE(s.total_amount, 0)
                ELSE GREATEST(COALESCE(s.total_amount, 0) - COALESCE(s.amount_paid, 0), 0)
              END
            )::numeric, 4) AS credit_created,
            ROUND(AVG(COALESCE(s.total_amount, 0))::numeric, 4) AS average_transaction_value
          FROM sales s
          WHERE (s.sale_date AT TIME ZONE '${TZ}')::date >= $1::date
            AND (s.sale_date AT TIME ZONE '${TZ}')::date <= $2::date
            AND s.status NOT IN ('VOID', 'REFUNDED', 'VOIDED_BY_RETURN')
            AND (
              UPPER(COALESCE(s.payment_method::text, '')) = 'CREDIT'
              OR COALESCE(s.total_amount, 0) - COALESCE(s.amount_paid, 0) > 0.009
            )
            ${options.paymentMethod ? 'AND s.payment_method::text = $3' : ''}
          GROUP BY 1, 2
          HAVING ROUND(SUM(
              CASE
                WHEN UPPER(COALESCE(s.payment_method::text, '')) = 'CREDIT'
                  THEN COALESCE(s.total_amount, 0)
                ELSE GREATEST(COALESCE(s.total_amount, 0) - COALESCE(s.amount_paid, 0), 0)
              END
            )::numeric, 4) > 0.009
        ),
        ar_cash AS (
          SELECT
            p.payment_date::date AS transaction_date,
            p.payment_method::text AS payment_method,
            'AR_COLLECTION'::text AS revenue_type,
            COUNT(p.id)::integer AS transaction_count,
            ROUND(SUM(COALESCE(p.total_amount, 0))::numeric, 4) AS cash_amount,
            0::numeric AS total_sales,
            0::numeric AS total_cost,
            0::numeric AS gross_profit,
            0::numeric AS credit_created,
            ROUND(AVG(COALESCE(p.total_amount, 0))::numeric, 4) AS average_transaction_value
          FROM ar_customer_payments p
          WHERE p.status <> 'REVERSED'
            AND p.reversal_of_payment_id IS NULL
            AND p.payment_date >= $1::date
            AND p.payment_date <= $2::date
            ${options.paymentMethod ? 'AND p.payment_method::text = $3' : ''}
          GROUP BY 1, 2
        ),
        deposit_cash AS (
          SELECT
            (cd.created_at AT TIME ZONE '${TZ}')::date AS transaction_date,
            COALESCE(cd.payment_method::text, 'OTHER') AS payment_method,
            'CUSTOMER_DEPOSIT'::text AS revenue_type,
            COUNT(cd.id)::integer AS transaction_count,
            ROUND(SUM(COALESCE(cd.amount, 0))::numeric, 4) AS cash_amount,
            0::numeric AS total_sales,
            0::numeric AS total_cost,
            0::numeric AS gross_profit,
            0::numeric AS credit_created,
            ROUND(AVG(COALESCE(cd.amount, 0))::numeric, 4) AS average_transaction_value
          FROM pos_customer_deposits cd
          WHERE cd.status IN ('ACTIVE', 'DEPLETED')
            AND (cd.created_at AT TIME ZONE '${TZ}')::date >= $1::date
            AND (cd.created_at AT TIME ZONE '${TZ}')::date <= $2::date
            ${options.paymentMethod ? 'AND cd.payment_method::text = $3' : ''}
          GROUP BY 1, 2
        ),
        combined AS (
          SELECT * FROM pos_cash
          UNION ALL
          SELECT * FROM ar_cash
          UNION ALL
          SELECT * FROM deposit_cash
          UNION ALL
          SELECT * FROM credit_memo
        )
        SELECT
          to_char(transaction_date, 'YYYY-MM-DD') AS transaction_date,
          payment_method,
          revenue_type,
          transaction_count,
          cash_amount,
          total_sales,
          total_cost,
          gross_profit,
          credit_created,
          average_transaction_value
        FROM combined
        WHERE transaction_count > 0
        ORDER BY transaction_date DESC, revenue_type, payment_method
      `;

      const summaryQuery = `
        WITH pos AS (
          SELECT
            COUNT(s.id) FILTER (WHERE COALESCE(s.amount_paid, 0) > 0.009 AND UPPER(COALESCE(s.payment_method::text, '')) <> 'CREDIT') AS cash_txn_count,
            COALESCE(SUM(s.amount_paid) FILTER (WHERE COALESCE(s.amount_paid, 0) > 0.009 AND UPPER(COALESCE(s.payment_method::text, '')) <> 'CREDIT'), 0) AS sales_cash,
            COALESCE(SUM(s.total_amount), 0) AS total_sales,
            COALESCE(SUM(s.profit), 0) AS gross_profit,
            COALESCE(SUM(
              CASE
                WHEN UPPER(COALESCE(s.payment_method::text, '')) = 'CREDIT' THEN COALESCE(s.total_amount, 0)
                ELSE GREATEST(COALESCE(s.total_amount, 0) - COALESCE(s.amount_paid, 0), 0)
              END
            ), 0) AS credit_created,
            COUNT(DISTINCT (s.sale_date AT TIME ZONE '${TZ}')::date) AS sale_days
          FROM sales s
          WHERE (s.sale_date AT TIME ZONE '${TZ}')::date >= $1::date
            AND (s.sale_date AT TIME ZONE '${TZ}')::date <= $2::date
            AND s.status NOT IN ('VOID', 'REFUNDED', 'VOIDED_BY_RETURN')
            ${options.paymentMethod ? 'AND s.payment_method::text = $3' : ''}
        ),
        ar AS (
          SELECT
            COUNT(p.id) AS txn_count,
            COALESCE(SUM(p.total_amount), 0) AS cash_amount,
            COUNT(DISTINCT p.payment_date) AS coll_days
          FROM ar_customer_payments p
          WHERE p.status <> 'REVERSED'
            AND p.reversal_of_payment_id IS NULL
            AND p.payment_date >= $1::date
            AND p.payment_date <= $2::date
            ${options.paymentMethod ? 'AND p.payment_method::text = $3' : ''}
        ),
        dep AS (
          SELECT
            COUNT(cd.id) AS txn_count,
            COALESCE(SUM(cd.amount), 0) AS cash_amount,
            COUNT(DISTINCT (cd.created_at AT TIME ZONE '${TZ}')::date) AS dep_days
          FROM pos_customer_deposits cd
          WHERE cd.status IN ('ACTIVE', 'DEPLETED')
            AND (cd.created_at AT TIME ZONE '${TZ}')::date >= $1::date
            AND (cd.created_at AT TIME ZONE '${TZ}')::date <= $2::date
            ${options.paymentMethod ? 'AND cd.payment_method::text = $3' : ''}
        )
        SELECT
          pos.cash_txn_count AS sales_txn_count,
          pos.sales_cash AS sales_revenue,
          pos.total_sales,
          pos.gross_profit,
          pos.credit_created,
          pos.sale_days,
          ar.txn_count AS collections_txn_count,
          ar.cash_amount AS debt_collections,
          ar.coll_days,
          dep.txn_count AS deposits_txn_count,
          dep.cash_amount AS deposit_receipts,
          dep.dep_days
        FROM pos, ar, dep
      `;

      const params: string[] = [startDate, endDate];
      if (options.paymentMethod) params.push(options.paymentMethod);

      const [result, summaryResult] = await Promise.all([
        pool.query(query, params),
        pool.query(summaryQuery, params),
      ]);

      const sRow = summaryResult.rows[0] || {};
      const salesRevenue = new Decimal(sRow.sales_revenue || 0);
      const debtCollections = new Decimal(sRow.debt_collections || 0);
      const depositReceipts = new Decimal(sRow.deposit_receipts || 0);
      const totalCashIn = salesRevenue.plus(debtCollections).plus(depositReceipts);
      const totalSalesValue = new Decimal(sRow.total_sales || 0);
      const grossProfit = new Decimal(sRow.gross_profit || 0);

      const rows = (result.rows || []).map((row) => {
        const totalSales = new Decimal(row.total_sales || 0);
        const gp = new Decimal(row.gross_profit || 0);
        return {
          transactionDate: row.transaction_date,
          paymentMethod: row.payment_method,
          revenueType: row.revenue_type,
          transactionCount: parseInt(String(row.transaction_count || 0), 10),
          cashAmount: new Decimal(row.cash_amount || 0).toDecimalPlaces(2).toNumber(),
          totalSales: totalSales.toDecimalPlaces(2).toNumber(),
          totalCost: new Decimal(row.total_cost || 0).toDecimalPlaces(2).toNumber(),
          grossProfit: gp.toDecimalPlaces(2).toNumber(),
          creditCreated: new Decimal(row.credit_created || 0).toDecimalPlaces(2).toNumber(),
          averageTransactionValue: new Decimal(row.average_transaction_value || 0)
            .toDecimalPlaces(2)
            .toNumber(),
          profitMargin: totalSales.isZero()
            ? 0
            : gp.div(totalSales).mul(100).toDecimalPlaces(2).toNumber(),
          cashFlowImpact: new Decimal(row.cash_amount || 0).toDecimalPlaces(2).toNumber(),
        };
      });

      const totalDays = new Set(rows.map((r) => r.transactionDate)).size
        || Math.max(
          parseInt(String(sRow.sale_days || 0), 10),
          parseInt(String(sRow.coll_days || 0), 10),
          parseInt(String(sRow.dep_days || 0), 10),
        );

      return {
        rows,
        summary: {
          totalDays,
          salesRevenue: salesRevenue.toDecimalPlaces(2).toNumber(),
          salesTransactionCount: parseInt(String(sRow.sales_txn_count || 0), 10),
          totalSalesValue: totalSalesValue.toDecimalPlaces(2).toNumber(),
          grossProfit: grossProfit.toDecimalPlaces(2).toNumber(),
          overallProfitMargin: totalSalesValue.isZero()
            ? 0
            : grossProfit.div(totalSalesValue).mul(100).toDecimalPlaces(2).toNumber(),
          debtCollections: debtCollections.toDecimalPlaces(2).toNumber(),
          collectionsTransactionCount: parseInt(String(sRow.collections_txn_count || 0), 10),
          depositReceipts: depositReceipts.toDecimalPlaces(2).toNumber(),
          depositsTransactionCount: parseInt(String(sRow.deposits_txn_count || 0), 10),
          totalCashIn: totalCashIn.toDecimalPlaces(2).toNumber(),
          totalTransactions:
            parseInt(String(sRow.sales_txn_count || 0), 10) +
            parseInt(String(sRow.collections_txn_count || 0), 10) +
            parseInt(String(sRow.deposits_txn_count || 0), 10),
          creditExtended: new Decimal(sRow.credit_created || 0).toDecimalPlaces(2).toNumber(),
        },
      };
    } catch (error) {
      logger.error('Error in getDailyCashFlow', { error });
      return {
        rows: [],
        summary: {
          totalDays: 0,
          salesRevenue: 0,
          salesTransactionCount: 0,
          totalSalesValue: 0,
          grossProfit: 0,
          overallProfitMargin: 0,
          debtCollections: 0,
          collectionsTransactionCount: 0,
          depositReceipts: 0,
          depositsTransactionCount: 0,
          totalCashIn: 0,
          totalTransactions: 0,
          creditExtended: 0,
        },
      };
    }
  },

  /**
   * SUPPLIER PAYMENT STATUS REPORT
   * Track outstanding supplier payments
   */
  async getSupplierPaymentStatus(
    pool: Pool,
    options: {
      supplierId?: string;
      status?: 'PAID' | 'PARTIAL' | 'PENDING';
    }
  ): Promise<SupplierPaymentStatusRow[]> {
    const params: unknown[] = [];
    const supplierFilters: string[] = [];

    if (options.supplierId) {
      params.push(options.supplierId);
      supplierFilters.push(`s."Id" = $${params.length}`);
    }

    const supplierWhereClause =
      supplierFilters.length > 0 ? `WHERE ${supplierFilters.join(' AND ')}` : '';

    // GL-driven: derive all billing/payment amounts from ledger_entries on AP (2100).
    // Credits = liabilities incurred (GR postings), Debits = payments made against AP.
    const query = `
      SELECT 
        s."Id" as supplier_id,
        s."SupplierCode" as supplier_number,
        s."CompanyName" as supplier_name,
        s."Email" as email,
        s."Phone" as phone,
        COALESCE(po_agg.total_orders, 0) as total_orders,
        COALESCE(gl_agg.total_amount, 0) as total_amount,
        COALESCE(gl_agg.total_paid, 0) as total_paid,
        COALESCE(gl_agg.outstanding_balance, 0) as outstanding_balance,
        COALESCE(po_agg.last_order_date, gl_agg.last_transaction_date) as last_order_date,
        s."DefaultPaymentTerms" as payment_terms
      FROM suppliers s
      LEFT JOIN (
        SELECT supplier_id,
               COUNT(id) as total_orders,
               MAX(order_date) as last_order_date
        FROM purchase_orders
        GROUP BY supplier_id
      ) po_agg ON po_agg.supplier_id = s."Id"
      LEFT JOIN (
        SELECT 
          le."EntityId" as supplier_id,
          SUM(le."CreditAmount") as total_amount,
          SUM(le."DebitAmount") as total_paid,
          SUM(le."CreditAmount") - SUM(le."DebitAmount") as outstanding_balance,
          MAX(lt."TransactionDate") as last_transaction_date
        FROM ledger_entries le
        JOIN ledger_transactions lt ON le."TransactionId" = lt."Id"
        JOIN accounts a ON le."AccountId" = a."Id"
        WHERE a."AccountCode" IN ('2100', '2150')
          AND UPPER(le."EntityType") = 'SUPPLIER'
          AND lt."Status" = 'POSTED'
        GROUP BY le."EntityId"
      ) gl_agg ON gl_agg.supplier_id = s."Id"::text
      ${supplierWhereClause}
      ORDER BY outstanding_balance DESC
    `;

    const result = await pool.query(query, params);

    // Filter out suppliers with no AP activity (no GL entries)
    let filtered = result.rows.filter((row) => new Decimal(row.total_amount || 0).greaterThan(0));

    // Apply status filter on GL-computed balances
    if (options.status) {
      filtered = filtered.filter((row) => {
        const outstanding = new Decimal(row.outstanding_balance || 0);
        const paid = new Decimal(row.total_paid || 0);
        switch (options.status) {
          case 'PAID':
            return outstanding.lessThanOrEqualTo(0.01);
          case 'PARTIAL':
            return outstanding.greaterThan(0.01) && paid.greaterThan(0);
          case 'PENDING':
            return outstanding.greaterThan(0.01) && paid.lessThanOrEqualTo(0);
          default:
            return true;
        }
      });
    }

    return filtered.map((row) => ({
      supplierId: row.supplier_id,
      supplierNumber: row.supplier_number,
      supplierName: row.supplier_name,
      email: row.email,
      phone: row.phone,
      totalOrders: parseInt(row.total_orders || 0),
      totalAmount: new Decimal(row.total_amount || 0).toDecimalPlaces(2).toNumber(),
      totalPaid: new Decimal(row.total_paid || 0).toDecimalPlaces(2).toNumber(),
      outstandingBalance: new Decimal(row.outstanding_balance || 0).toDecimalPlaces(2).toNumber(),
      lastOrderDate: formatDate(row.last_order_date),
      paymentTerms: row.payment_terms,
    }));
  },

  /**
   * SUPPLIER PAYMENT DETAILS
   * Individual payment records from supplier_payments table with allocations
   */
  async getSupplierPaymentDetails(
    pool: Pool,
    options: {
      supplierId?: string;
      status?: string;
      startDate?: string;
      endDate?: string;
    }
  ): Promise<SupplierPaymentDetailRow[]> {
    const params: unknown[] = [];
    const filters: string[] = ['sp.deleted_at IS NULL'];

    if (options.supplierId) {
      params.push(options.supplierId);
      filters.push(`sp."SupplierId" = $${params.length}`);
    }

    if (options.status) {
      params.push(options.status);
      filters.push(`sp."Status" = $${params.length}`);
    }

    if (options.startDate) {
      params.push(options.startDate);
      filters.push(`sp."PaymentDate"::date >= $${params.length}::date`);
    }

    if (options.endDate) {
      params.push(options.endDate);
      filters.push(`sp."PaymentDate"::date <= $${params.length}::date`);
    }

    const whereClause = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';

    const query = `
      SELECT 
        sp."Id" as payment_id,
        sp."PaymentNumber" as payment_number,
        s."CompanyName" as supplier_name,
        sp."PaymentDate"::date as payment_date,
        sp."Amount" as amount,
        sp."PaymentMethod" as payment_method,
        sp."Status" as status,
        sp."Reference" as reference,
        COALESCE(sp."AllocatedAmount", sp.allocated_amount, 0) as allocated_amount,
        COALESCE(sp."UnallocatedAmount", 0) as unallocated_amount,
        sp."Notes" as notes,
        sp."CreatedAt" as created_at
      FROM supplier_payments sp
      JOIN suppliers s ON s."Id" = sp."SupplierId"
      ${whereClause}
      ORDER BY sp."PaymentDate" DESC, sp."PaymentNumber" DESC
    `;

    const result = await pool.query(query, params);

    // Fetch allocations for all payments in one query
    const paymentIds = result.rows.map((r) => r.payment_id);
    let allocationsMap: Record<string, SupplierPaymentAllocationRow[]> = {};

    if (paymentIds.length > 0) {
      const allocQuery = `
        SELECT 
          spa."PaymentId" as payment_id,
          si."SupplierInvoiceNumber" as invoice_number,
          spa."AmountAllocated" as amount_allocated,
          spa."AllocationDate"::date as allocation_date
        FROM supplier_payment_allocations spa
        JOIN supplier_invoices si ON si."Id" = spa."SupplierInvoiceId"
        WHERE spa."PaymentId" = ANY($1::uuid[])
          AND spa.deleted_at IS NULL
        ORDER BY spa."AllocationDate" DESC
      `;
      const allocResult = await pool.query(allocQuery, [paymentIds]);
      allocationsMap = allocResult.rows.reduce((acc: Record<string, SupplierPaymentAllocationRow[]>, row) => {
        const pid = row.payment_id;
        if (!acc[pid]) acc[pid] = [];
        acc[pid].push({
          invoiceNumber: row.invoice_number,
          amountAllocated: new Decimal(row.amount_allocated || 0).toDecimalPlaces(2).toNumber(),
          allocationDate: formatDate(row.allocation_date) || '',
        });
        return acc;
      }, {});
    }

    return result.rows.map((row) => ({
      paymentNumber: row.payment_number,
      supplierName: row.supplier_name,
      paymentDate: formatDate(row.payment_date) || '',
      amount: new Decimal(row.amount || 0).toDecimalPlaces(2).toNumber(),
      paymentMethod: row.payment_method || 'N/A',
      status: row.status || 'N/A',
      reference: row.reference,
      allocatedAmount: new Decimal(row.allocated_amount || 0).toDecimalPlaces(2).toNumber(),
      unallocatedAmount: new Decimal(row.unallocated_amount || 0).toDecimalPlaces(2).toNumber(),
      notes: row.notes,
      allocations: allocationsMap[row.payment_id] || [],
    }));
  },

  /**
   * TOP CUSTOMERS REPORT
   * Rank customers by revenue
   */
  async getTopCustomers(
    pool: Pool,
    options: {
      startDate: string;
      endDate: string;
      limit?: number;
      minPurchaseAmount?: number;
      sortBy?: 'REVENUE' | 'ORDERS' | 'PROFIT';
    }
  ): Promise<TopCustomerRow[]> {
    const [startUtc, endUtc] = toUtcParams(options.startDate, options.endDate);
    const params: unknown[] = [startUtc, endUtc];
    const filters: string[] = [
      `s.sale_date >= ($1::timestamptz AT TIME ZONE '${TZ}')::date`,
      `s.sale_date < ($2::timestamptz AT TIME ZONE '${TZ}')::date`,
      `s.status NOT IN ('VOID', 'REFUNDED', 'VOIDED_BY_RETURN')`,
    ];

    if (options.minPurchaseAmount) {
      params.push(options.minPurchaseAmount);
      filters.push(`s.total_amount >= $${params.length}`);
    }

    const whereClause = filters.join(' AND ');
    let limitClause = '';
    if (options.limit) {
      params.push(options.limit);
      limitClause = `LIMIT $${params.length}`;
    }

    // outstanding = open-item due − unallocated receipts (same SSOT as aging / customer balance)
    const query = `
      WITH open_due AS (
        SELECT i.customer_id, COALESCE(SUM(i.amount_due), 0) AS due
        FROM invoices i
        WHERE COALESCE(i.document_type, 'INVOICE') IN ('INVOICE', 'OPENING_BALANCE')
          AND i.status NOT IN ('CANCELLED', 'VOIDED', 'DRAFT')
          AND i.amount_due > 0.009
        GROUP BY i.customer_id
      ),
      unalloc AS (
        SELECT p.customer_id, COALESCE(SUM(p.unallocated_amount), 0) AS ua
        FROM ar_customer_payments p
        WHERE p.status <> 'REVERSED'
          AND p.reversal_of_payment_id IS NULL
          AND p.unallocated_amount > 0.009
        GROUP BY p.customer_id
      )
      SELECT 
        c.id as customer_id,
        c.customer_number as customer_number,
        c.name as customer_name,
        c.email,
        c.phone,
        COUNT(s.id) as total_purchases,
        SUM(s.total_amount) as total_revenue,
        SUM(s.profit) as total_profit,
        AVG(s.total_amount) as average_purchase_value,
        MAX(s.sale_date) as last_purchase_date,
        GREATEST(COALESCE(od.due, 0) - COALESCE(ua.ua, 0), 0) as outstanding_balance
      FROM customers c
      INNER JOIN sales s ON s.customer_id = c.id
      LEFT JOIN open_due od ON od.customer_id = c.id
      LEFT JOIN unalloc ua ON ua.customer_id = c.id
      WHERE ${whereClause}
      GROUP BY c.id, c.customer_number, c.name, c.email, c.phone, od.due, ua.ua
      ORDER BY ${options.sortBy === 'ORDERS' ? 'total_purchases' : options.sortBy === 'PROFIT' ? 'total_profit' : 'total_revenue'} DESC
      ${limitClause}
    `;

    const result = await pool.query(query, params);

    return result.rows.map((row, index) => ({
      rank: index + 1,
      customerId: row.customer_id,
      customerNumber: row.customer_number,
      customerName: row.customer_name,
      email: row.email,
      phone: row.phone,
      totalPurchases: parseInt(row.total_purchases),
      totalRevenue: new Decimal(row.total_revenue || 0).toDecimalPlaces(2).toNumber(),
      totalProfit: new Decimal(row.total_profit || 0).toDecimalPlaces(2).toNumber(),
      averagePurchaseValue: new Decimal(row.average_purchase_value || 0)
        .toDecimalPlaces(2)
        .toNumber(),
      lastPurchaseDate: formatDate(row.last_purchase_date),
      outstandingBalance: new Decimal(row.outstanding_balance || 0).toDecimalPlaces(2).toNumber(),
    }));
  },

  /**
   * CUSTOMER AGING REPORT
   * Outstanding customer balances by aging periods (0-30, 31-60, 61-90, 90+ days)
   */
  async getCustomerAging(
    pool: Pool,
    options: {
      asOfDate?: Date | string;
    }
  ): Promise<{
    rows: CustomerAgingRow[];
    summary: {
      totalCustomers: number;
      totalOutstanding: number;
      current: number;
      days30: number;
      days60: number;
      days90: number;
      over90: number;
      overdueAmount: number;
      unallocatedCredits: number;
      grossOpenItems: number;
    };
  }> {
    const asOfDate = options.asOfDate || getBusinessDate();
    const asOfDateStr = asOfDate instanceof Date ? formatDateBusiness(asOfDate) : String(asOfDate).slice(0, 10);

    // SAP/QB open-item aging: INVOICE + OPENING_BALANCE only; exclude cancelled/void/draft.
    // Unallocated AR receipts (on-account) reduce net outstanding and sit in Current.
    const openItemWhere = `
      COALESCE(i.document_type, 'INVOICE') IN ('INVOICE', 'OPENING_BALANCE')
      AND i.status NOT IN ('CANCELLED', 'VOIDED', 'DRAFT', 'PAID')
      AND i.amount_due > 0.009
    `;

    const query = `
      WITH customer_invoices AS (
        SELECT 
          c.id as customer_id,
          c.customer_number,
          c.name as customer_name,
          c.email,
          c.phone,
          c.credit_limit,
          i.id as invoice_id,
          i.invoice_number as invoice_number,
          i.issue_date as invoice_date,
          i.due_date as due_date,
          i.total_amount as total_amount,
          i.amount_paid as amount_paid,
          i.amount_due as outstanding_balance,
          EXTRACT(DAY FROM ($1::date - COALESCE(i.due_date, i.issue_date))) as days_overdue
        FROM customers c
        INNER JOIN invoices i ON i.customer_id = c.id
        WHERE ${openItemWhere}
      ),
      unalloc AS (
        SELECT
          p.customer_id,
          COALESCE(SUM(p.unallocated_amount), 0) AS unallocated_credits
        FROM ar_customer_payments p
        WHERE p.status <> 'REVERSED'
          AND p.reversal_of_payment_id IS NULL
          AND p.unallocated_amount > 0.009
          AND p.payment_date <= $1::date
        GROUP BY p.customer_id
      ),
      aged AS (
        SELECT 
          customer_id,
          customer_number,
          customer_name,
          email,
          phone,
          credit_limit,
          COUNT(invoice_id) as total_invoices,
          SUM(outstanding_balance) as gross_outstanding,
          SUM(CASE WHEN days_overdue <= 0 THEN outstanding_balance ELSE 0 END) as current_amount,
          SUM(CASE WHEN days_overdue > 0 AND days_overdue <= 30 THEN outstanding_balance ELSE 0 END) as days_1_30,
          SUM(CASE WHEN days_overdue > 30 AND days_overdue <= 60 THEN outstanding_balance ELSE 0 END) as days_31_60,
          SUM(CASE WHEN days_overdue > 60 AND days_overdue <= 90 THEN outstanding_balance ELSE 0 END) as days_61_90,
          SUM(CASE WHEN days_overdue > 90 THEN outstanding_balance ELSE 0 END) as days_over_90,
          MAX(days_overdue) as max_days_overdue
        FROM customer_invoices
        GROUP BY customer_id, customer_number, customer_name, email, phone, credit_limit
      )
      SELECT
        a.*,
        COALESCE(u.unallocated_credits, 0) AS unallocated_credits,
        GREATEST(a.gross_outstanding - COALESCE(u.unallocated_credits, 0), 0) AS total_outstanding,
        GREATEST(a.current_amount - COALESCE(u.unallocated_credits, 0), 0) AS current_net
      FROM aged a
      LEFT JOIN unalloc u ON u.customer_id = a.customer_id
      ORDER BY total_outstanding DESC
    `;

    const summaryQuery = `
      WITH customer_invoices AS (
        SELECT 
          c.id as customer_id,
          i.amount_due as outstanding_balance,
          EXTRACT(DAY FROM ($1::date - COALESCE(i.due_date, i.issue_date))) as days_overdue
        FROM customers c
        INNER JOIN invoices i ON i.customer_id = c.id
        WHERE ${openItemWhere}
      ),
      unalloc AS (
        SELECT COALESCE(SUM(p.unallocated_amount), 0) AS unallocated_credits
        FROM ar_customer_payments p
        WHERE p.status <> 'REVERSED'
          AND p.reversal_of_payment_id IS NULL
          AND p.unallocated_amount > 0.009
          AND p.payment_date <= $1::date
      ),
      bucket AS (
        SELECT
          COUNT(DISTINCT customer_id) as total_customers,
          COALESCE(SUM(outstanding_balance), 0) as gross_outstanding,
          COALESCE(SUM(CASE WHEN days_overdue <= 0 THEN outstanding_balance ELSE 0 END), 0) as current_amount,
          COALESCE(SUM(CASE WHEN days_overdue > 0 AND days_overdue <= 30 THEN outstanding_balance ELSE 0 END), 0) as days_1_30,
          COALESCE(SUM(CASE WHEN days_overdue > 30 AND days_overdue <= 60 THEN outstanding_balance ELSE 0 END), 0) as days_31_60,
          COALESCE(SUM(CASE WHEN days_overdue > 60 AND days_overdue <= 90 THEN outstanding_balance ELSE 0 END), 0) as days_61_90,
          COALESCE(SUM(CASE WHEN days_overdue > 90 THEN outstanding_balance ELSE 0 END), 0) as days_over_90
        FROM customer_invoices
      )
      SELECT
        b.*,
        u.unallocated_credits,
        GREATEST(b.gross_outstanding - u.unallocated_credits, 0) AS total_outstanding,
        GREATEST(b.current_amount - u.unallocated_credits, 0) AS current_net
      FROM bucket b
      CROSS JOIN unalloc u
    `;

    const [result, summaryResult] = await Promise.all([
      pool.query(query, [asOfDateStr]),
      pool.query(summaryQuery, [asOfDateStr]),
    ]);

    const sRow = summaryResult.rows[0] || {};
    const sCurrent = new Decimal(sRow.current_net || 0).toDecimalPlaces(2).toNumber();
    const sDays30 = new Decimal(sRow.days_1_30 || 0).toDecimalPlaces(2).toNumber();
    const sDays60 = new Decimal(sRow.days_31_60 || 0).toDecimalPlaces(2).toNumber();
    const sDays90 = new Decimal(sRow.days_61_90 || 0).toDecimalPlaces(2).toNumber();
    const sOver90 = new Decimal(sRow.days_over_90 || 0).toDecimalPlaces(2).toNumber();
    const sUnalloc = new Decimal(sRow.unallocated_credits || 0).toDecimalPlaces(2).toNumber();
    const sGross = new Decimal(sRow.gross_outstanding || 0).toDecimalPlaces(2).toNumber();

    const rows = result.rows.map((row) => {
      const current = new Decimal(row.current_net || 0).toDecimalPlaces(2).toNumber();
      const days30 = new Decimal(row.days_1_30 || 0).toDecimalPlaces(2).toNumber();
      const days60 = new Decimal(row.days_31_60 || 0).toDecimalPlaces(2).toNumber();
      const days90 = new Decimal(row.days_61_90 || 0).toDecimalPlaces(2).toNumber();
      const over90 = new Decimal(row.days_over_90 || 0).toDecimalPlaces(2).toNumber();
      const totalOutstanding = new Decimal(row.total_outstanding || 0)
        .toDecimalPlaces(2)
        .toNumber();
      const overdueAmount = days30 + days60 + days90 + over90;

      return {
        customerId: row.customer_id,
        customerNumber: row.customer_number,
        customerName: row.customer_name,
        email: row.email,
        phone: row.phone,
        creditLimit: new Decimal(row.credit_limit || 0).toDecimalPlaces(2).toNumber(),
        totalInvoices: parseInt(row.total_invoices || 0),
        totalOutstanding,
        current,
        days30,
        days60,
        days90,
        over90,
        overdueAmount,
        maxDaysOverdue: parseInt(row.max_days_overdue || 0),
        unallocatedCredits: new Decimal(row.unallocated_credits || 0).toDecimalPlaces(2).toNumber(),
      };
    });

    return {
      rows,
      summary: {
        totalCustomers: parseInt(sRow.total_customers || 0),
        totalOutstanding: new Decimal(sRow.total_outstanding || 0).toDecimalPlaces(2).toNumber(),
        current: sCurrent,
        days30: sDays30,
        days60: sDays60,
        days90: sDays90,
        over90: sOver90,
        overdueAmount: sDays30 + sDays60 + sDays90 + sOver90,
        unallocatedCredits: sUnalloc,
        grossOpenItems: sGross,
      },
    };
  },

  /**
   * STOCK AGING REPORT
   * Show how long inventory has been in stock
   */
  async getStockAging(
    pool: Pool,
    options: {
      categoryId?: string;
      minDaysInStock?: number;
    }
  ): Promise<StockAgingRow[]> {
    const params: unknown[] = [];
    const filters: string[] = ['b.remaining_quantity > 0'];

    if (options.categoryId) {
      params.push(options.categoryId);
      filters.push(`p.category = $${params.length}`);
    }

    if (options.minDaysInStock) {
      params.push(options.minDaysInStock);
      filters.push(`CURRENT_DATE - b.received_date >= $${params.length}`);
    }

    const whereClause = filters.join(' AND ');

    const query = `
      SELECT 
        p.id as product_id,
        p.name as product_name,
        p.sku,
        p.category,
        b.batch_number,
        b.remaining_quantity,
        b.cost_price as unit_cost,
        b.remaining_quantity * b.cost_price as total_value,
        b.received_date,
        CURRENT_DATE - b.received_date as days_in_stock,
        b.expiry_date
      FROM inventory_batches b
      INNER JOIN products p ON p.id = b.product_id
      WHERE ${whereClause}
      ORDER BY days_in_stock DESC, total_value DESC
    `;

    const result = await pool.query(query, params);

    return result.rows.map((row) => ({
      productId: row.product_id,
      productName: row.product_name,
      sku: row.sku,
      category: row.category,
      batchNumber: row.batch_number,
      remainingQuantity: new Decimal(row.remaining_quantity).toDecimalPlaces(3).toNumber(),
      unitCost: new Decimal(row.unit_cost).toDecimalPlaces(2).toNumber(),
      totalValue: new Decimal(row.total_value).toDecimalPlaces(2).toNumber(),
      receivedDate: formatDate(row.received_date),
      daysInStock: parseInt(row.days_in_stock),
      expiryDate: formatDateOnly(row.expiry_date),
      daysUntilExpiry: computeDaysUntilExpiry(row.expiry_date),
    }));
  },

  /**
   * WASTE & DAMAGE REPORT
   * Track inventory losses
   */
  async getWasteDamageReport(
    pool: Pool,
    options: {
      startDate: string;
      endDate: string;
      productId?: string;
      reason?: 'DAMAGE' | 'EXPIRY' | 'THEFT' | 'OTHER';
    }
  ): Promise<WasteDamageRow[]> {
    const { startUtc, endUtc } = toUtcRange(options.startDate, options.endDate, BUSINESS_TIMEZONE);
    const params: unknown[] = [startUtc, endUtc];
    const filters: string[] = [
      'sm.created_at >= $1 AND sm.created_at < $2',
      "sm.movement_type IN ('DAMAGE', 'EXPIRY')",
    ];

    if (options.productId) {
      params.push(options.productId);
      filters.push(`sm.product_id = $${params.length}`);
    }

    if (options.reason) {
      params.push(options.reason);
      filters.push(`sm.movement_type = $${params.length}`);
    }

    const whereClause = filters.join(' AND ');

    const query = `
      SELECT 
        sm.id as movement_id,
        sm.created_at as loss_date,
        sm.movement_type as loss_type,
        p.id as product_id,
        p.name as product_name,
        p.sku,
        p.category,
        b.batch_number,
        b.expiry_date,
        sm.quantity as quantity_lost,
        sm.unit_cost,
        sm.quantity * sm.unit_cost as total_loss_value,
        sm.notes,
        sm.created_by_id
      FROM stock_movements sm
      INNER JOIN products p ON p.id = sm.product_id
      LEFT JOIN inventory_batches b ON b.id = sm.batch_id
      WHERE ${whereClause}
      ORDER BY sm.created_at DESC
    `;

    const result = await pool.query(query, params);

    return result.rows.map((row) => ({
      movementId: row.movement_id,
      lossDate: formatDate(row.loss_date),
      lossType: row.loss_type,
      productId: row.product_id,
      productName: row.product_name,
      sku: row.sku,
      category: row.category,
      batchNumber: row.batch_number,
      expiryDate: formatDateOnly(row.expiry_date),
      quantityLost: new Decimal(row.quantity_lost || 0).toDecimalPlaces(3).toNumber(),
      unitCost: new Decimal(row.unit_cost || 0).toDecimalPlaces(2).toNumber(),
      totalLossValue: new Decimal(row.total_loss_value || 0).toDecimalPlaces(2).toNumber(),
      notes: row.notes,
      createdBy: row.created_by_id,
    }));
  },

  /**
   * SMART REORDER AI — Inventory Assistant
   * Analyzes sales history, seasonal demand trends, supplier lead times,
   * and demand variability to generate intelligent reorder recommendations
   * with safety stock buffers and lead-time-aware reorder points.
   */
  async getReorderRecommendations(
    pool: Pool,
    options: {
      categoryId?: string;
      daysToAnalyze?: number;
    }
  ): Promise<ReorderRecommendationRow[]> {
    const daysToAnalyze = options.daysToAnalyze || 30;
    const params: unknown[] = [daysToAnalyze];
    const filters: string[] = [];

    if (options.categoryId) {
      params.push(options.categoryId);
      filters.push(`p.category = $${params.length}`);
    }

    const whereClause = filters.length > 0 ? `AND ${filters.join(' AND ')}` : '';

    const query = `
      SELECT 
        p.id as product_id,
        p.name as product_name,
        p.sku,
        p.category,
        pi.reorder_level,
        COALESCE(SUM(b.remaining_quantity), 0) as current_stock,
        -- Total units sold in analysis period
        COALESCE((
          SELECT SUM(si.quantity)
          FROM sale_items si
          INNER JOIN sales s ON s.id = si.sale_id
          WHERE si.product_id = p.id
            AND s.sale_date >= CURRENT_DATE - INTERVAL '1 day' * $1
        ), 0) as units_sold_period,
        -- Average daily sales velocity over full period
        COALESCE((
          SELECT SUM(si.quantity)
          FROM sale_items si
          INNER JOIN sales s ON s.id = si.sale_id
          WHERE si.product_id = p.id
            AND s.sale_date >= CURRENT_DATE - INTERVAL '1 day' * $1
        ) / NULLIF($1, 0), 0) as daily_sales_velocity,
        -- Recent 7-day velocity for trend detection
        COALESCE((
          SELECT SUM(si.quantity)
          FROM sale_items si
          INNER JOIN sales s ON s.id = si.sale_id
          WHERE si.product_id = p.id
            AND s.sale_date >= CURRENT_DATE - INTERVAL '7 days'
        ) / 7.0, 0) as recent_7day_velocity,
        -- Daily sales standard deviation for safety stock
        COALESCE((
          SELECT STDDEV_POP(daily_qty) FROM (
            SELECT COALESCE(SUM(si.quantity), 0) as daily_qty
            FROM generate_series(
              CURRENT_DATE - INTERVAL '1 day' * $1,
              CURRENT_DATE - INTERVAL '1 day',
              INTERVAL '1 day'
            ) AS d(day)
            LEFT JOIN sale_items si ON si.product_id = p.id
            LEFT JOIN sales s ON s.id = si.sale_id AND s.sale_date = d.day::date
            GROUP BY d.day
          ) daily_sales
        ), 0) as sales_std_deviation,
        -- Days until stockout
        CASE 
          WHEN COALESCE((
            SELECT SUM(si.quantity)
            FROM sale_items si
            INNER JOIN sales s ON s.id = si.sale_id
            WHERE si.product_id = p.id
              AND s.sale_date >= CURRENT_DATE - INTERVAL '1 day' * $1
          ) / NULLIF($1, 0), 0) > 0
          THEN COALESCE(SUM(b.remaining_quantity), 0) / (
            SELECT SUM(si.quantity) / NULLIF($1, 0)
            FROM sale_items si
            INNER JOIN sales s ON s.id = si.sale_id
            WHERE si.product_id = p.id
              AND s.sale_date >= CURRENT_DATE - INTERVAL '1 day' * $1
          )
          ELSE 999
        END as days_until_stockout,
        pv.cost_price as unit_cost,
        -- Preferred supplier (most recent) with lead time
        (
          SELECT s."CompanyName"
          FROM suppliers s
          INNER JOIN purchase_orders po ON po.supplier_id = s."Id"
          INNER JOIN goods_receipts gr ON gr.purchase_order_id = po.id
          INNER JOIN goods_receipt_items gri ON gri.goods_receipt_id = gr.id
          WHERE gri.product_id = p.id
          ORDER BY po.order_date DESC
          LIMIT 1
        ) as preferred_supplier,
        -- Supplier lead time from most recent supplier
        COALESCE((
          SELECT s.lead_time_days
          FROM suppliers s
          INNER JOIN purchase_orders po ON po.supplier_id = s."Id"
          INNER JOIN goods_receipts gr ON gr.purchase_order_id = po.id
          INNER JOIN goods_receipt_items gri ON gri.goods_receipt_id = gr.id
          WHERE gri.product_id = p.id
          ORDER BY po.order_date DESC
          LIMIT 1
        ), 7) as lead_time_days,
        -- Actual measured lead time from PO history
        COALESCE((
          SELECT AVG(EXTRACT(EPOCH FROM (gr.received_date - po.order_date)) / 86400)
          FROM purchase_orders po
          INNER JOIN goods_receipts gr ON gr.purchase_order_id = po.id
          INNER JOIN goods_receipt_items gri ON gri.goods_receipt_id = gr.id
          WHERE gri.product_id = p.id
            AND gr.received_date IS NOT NULL
            AND po.order_date IS NOT NULL
        ), NULL) as actual_avg_lead_time
      FROM products p
      LEFT JOIN product_inventory pi ON pi.product_id = p.id
      LEFT JOIN product_valuation pv ON pv.product_id = p.id
      LEFT JOIN inventory_batches b ON b.product_id = p.id AND b.remaining_quantity > 0
      WHERE p.is_active = true
        ${whereClause}
      GROUP BY p.id, p.name, p.sku, p.category, pi.reorder_level, pv.cost_price
      HAVING COALESCE(SUM(b.remaining_quantity), 0) <= pi.reorder_level
        OR (
          CASE 
            WHEN COALESCE((
              SELECT SUM(si.quantity)
              FROM sale_items si
              INNER JOIN sales s ON s.id = si.sale_id
              WHERE si.product_id = p.id
                AND s.sale_date >= CURRENT_DATE - INTERVAL '1 day' * $1
            ) / NULLIF($1, 0), 0) > 0
            THEN COALESCE(SUM(b.remaining_quantity), 0) / (
              SELECT SUM(si.quantity) / NULLIF($1, 0)
              FROM sale_items si
              INNER JOIN sales s ON s.id = si.sale_id
              WHERE si.product_id = p.id
                AND s.sale_date >= CURRENT_DATE - INTERVAL '1 day' * $1
            )
            ELSE 999
          END
        ) <= 14
      ORDER BY days_until_stockout ASC
    `;

    const result = await pool.query(query, params);

    // ── Fetch pre-computed learned data (if any learning cycles have run) ──
    let learnedStats = new Map<string, ProductDemandStats>();
    let seasonalIndexes = new Map<string, number>();
    try {
      learnedStats = await demandForecastRepository.getAllStats(pool);
      if (learnedStats.size > 0) {
        const currentMonth = new Date().getMonth() + 1;
        seasonalIndexes = await demandForecastRepository.getSeasonalityForMonth(pool, currentMonth);
      }
    } catch {
      // Graceful degradation: if tables don't exist yet, continue without learned data
      logger.warn('Demand forecast data unavailable, using live calculations only');
    }

    return result.rows.map((row) => {
      const productId: string = row.product_id;
      const learned = learnedStats.get(productId);
      const seasonalIdx = seasonalIndexes.get(productId) ?? null;
      const dailyVelocity = new Decimal(row.daily_sales_velocity || 0)
        .toDecimalPlaces(2)
        .toNumber();
      const recent7dayVelocity = new Decimal(row.recent_7day_velocity || 0)
        .toDecimalPlaces(2)
        .toNumber();
      const salesStdDev = new Decimal(row.sales_std_deviation || 0).toDecimalPlaces(2).toNumber();
      const daysUntilStockout = new Decimal(row.days_until_stockout).toDecimalPlaces(0).toNumber();

      // Use actual measured lead time if available, otherwise supplier's configured value
      const leadTimeDays = row.actual_avg_lead_time
        ? Math.ceil(new Decimal(row.actual_avg_lead_time).toNumber())
        : new Decimal(row.lead_time_days || 7).toNumber();

      // Seasonal trend: compare recent week vs overall average
      // ratio > 1 = demand increasing, < 1 = demand decreasing
      const trendRatio =
        dailyVelocity > 0
          ? new Decimal(recent7dayVelocity).dividedBy(dailyVelocity).toDecimalPlaces(2).toNumber()
          : 1;

      // Effective velocity: weight recent trend (70% current avg + 30% recent trend)
      const effectiveVelocity =
        dailyVelocity > 0
          ? new Decimal(dailyVelocity)
            .times(0.7)
            .plus(new Decimal(recent7dayVelocity).times(0.3))
            .toDecimalPlaces(2)
            .toNumber()
          : 0;

      // ── Self-Learning Override: use pre-computed stats when available ──
      // When learning_cycles > 0, the demand forecast engine has run at least once
      // and we trust its pre-computed safety stock, reorder point, and trend.
      const useLearned = learned && learned.learningCycles > 0;

      const safetyStock = useLearned
        ? learned.computedSafetyStock
        : salesStdDev > 0
          ? Math.ceil(1.65 * salesStdDev * Math.sqrt(leadTimeDays))
          : 0;

      const currentStock = new Decimal(row.current_stock).toNumber();
      const reorderLevel = new Decimal(row.reorder_level || 0).toNumber();

      const reorderPoint = useLearned
        ? learned.computedReorderPoint
        : Math.ceil(effectiveVelocity * leadTimeDays + safetyStock);

      // ── Seasonal adjustment multiplier ──
      // seasonalIdx > 1 = hot month (order more), < 1 = cool month (order less)
      const seasonalMultiplier = seasonalIdx !== null && seasonalIdx > 0 ? seasonalIdx : 1;

      // Order quantity: cover lead time + review period, minus current stock, plus safety stock
      // Apply seasonal adjustment to account for demand fluctuations
      const reviewPeriod = Math.max(daysToAnalyze, 30);
      let suggestedOrderQty: number;
      if (effectiveVelocity > 0) {
        const baseOrder =
          effectiveVelocity * (leadTimeDays + reviewPeriod) + safetyStock - currentStock;
        suggestedOrderQty = Math.max(Math.ceil(baseOrder * seasonalMultiplier), 0);
      } else if (reorderLevel > 0 && currentStock < reorderLevel) {
        suggestedOrderQty = Math.ceil(reorderLevel - currentStock);
      } else {
        suggestedOrderQty = 0;
      }

      // Priority based on days until stockout relative to lead time
      let priority: string;
      if (currentStock <= 0 && reorderLevel > 0) {
        priority = 'URGENT';
      } else if (daysUntilStockout <= leadTimeDays) {
        priority = 'URGENT';
      } else if (daysUntilStockout <= leadTimeDays * 2) {
        priority = 'HIGH';
      } else {
        priority = 'MEDIUM';
      }

      // Use learned demand trend when available (more accurate from rolling stats)
      const demandTrend = useLearned
        ? learned.demandTrend
        : trendRatio > 1.15
          ? ('INCREASING' as const)
          : trendRatio < 0.85
            ? ('DECREASING' as const)
            : ('STABLE' as const);

      return {
        productId: row.product_id,
        productName: row.product_name,
        sku: row.sku,
        category: row.category,
        reorderLevel: new Decimal(row.reorder_level || 0).toDecimalPlaces(3).toNumber(),
        currentStock: new Decimal(row.current_stock).toDecimalPlaces(3).toNumber(),
        unitsSoldPeriod: new Decimal(row.units_sold_period).toDecimalPlaces(3).toNumber(),
        dailySalesVelocity: dailyVelocity,
        daysUntilStockout: daysUntilStockout > 900 ? null : daysUntilStockout,
        suggestedOrderQuantity: suggestedOrderQty,
        estimatedOrderCost: new Decimal(row.unit_cost || 0)
          .times(suggestedOrderQty)
          .toDecimalPlaces(2)
          .toNumber(),
        preferredSupplier: row.preferred_supplier,
        priority,
        leadTimeDays,
        safetyStock,
        reorderPoint,
        demandTrend,
        trendRatio,
        // Self-learning engine enrichment
        forecastDemand30d: useLearned ? learned.forecast30d : null,
        seasonalIndex: seasonalIdx,
        learningCycles: learned?.learningCycles ?? 0,
      };
    });
  },

  /**
   * REORDER DASHBOARD — Business-driven decision engine
   * Optimized: 1 bulk CTE query instead of N correlated subqueries
   * Classifies ALL products into URGENT / HIGH / MEDIUM / DEAD_STOCK / HEALTHY
   */
  async getReorderDashboard(
    pool: Pool,
    options: { category?: string }
  ): Promise<ReorderDashboardItem[]> {
    const params: unknown[] = [];
    let categoryFilter = '';
    if (options.category) {
      params.push(options.category);
      categoryFilter = `AND ${categoryMatchClause('p.category', params.length)}`;
    }

    const query = `
      WITH product_base AS (
        SELECT
          p.id,
          p.name,
          p.sku,
          p.category,
          COALESCE(pi.reorder_level, 0)::numeric AS reorder_level,
          COALESCE(pv.cost_price, 0)::numeric    AS cost_price
        FROM products p
        LEFT JOIN product_inventory pi ON pi.product_id = p.id
        LEFT JOIN product_valuation pv ON pv.product_id = p.id
        WHERE p.is_active = true ${categoryFilter}
      ),
      batch_stock AS (
        SELECT product_id, COALESCE(SUM(remaining_quantity), 0)::numeric AS batch_qty
        FROM inventory_batches
        WHERE status = 'ACTIVE'
        GROUP BY product_id
      ),
      qty_on_order AS (
        SELECT poi.product_id,
               COALESCE(SUM((${poItemOpenQuantitySql('poi')})::numeric), 0)::numeric AS qty
        FROM purchase_order_items poi
        JOIN purchase_orders po ON po.id = poi.purchase_order_id
        WHERE po.status = 'PENDING'
          AND (${poItemOpenQuantitySql('poi')})::numeric > 0
        GROUP BY poi.product_id
      ),
      sales_30d AS (
        SELECT si.product_id, SUM(si.quantity) AS units_sold
        FROM sale_items si
        JOIN sales s ON s.id = si.sale_id
        WHERE s.sale_date >= CURRENT_DATE - 30
          AND s.status = 'COMPLETED'
        GROUP BY si.product_id
      ),
      sales_7d AS (
        SELECT si.product_id, SUM(si.quantity) AS units_sold
        FROM sale_items si
        JOIN sales s ON s.id = si.sale_id
        WHERE s.sale_date >= CURRENT_DATE - 7
          AND s.status = 'COMPLETED'
        GROUP BY si.product_id
      ),
      supplier_info AS (
        SELECT DISTINCT ON (gri.product_id)
          gri.product_id,
          s."Id"                               AS supplier_id,
          s."CompanyName"                      AS supplier_name,
          COALESCE(s.lead_time_days, 7)        AS lead_time_days
        FROM goods_receipt_items gri
        JOIN goods_receipts gr ON gr.id = gri.goods_receipt_id
        JOIN purchase_orders po ON po.id = gr.purchase_order_id
        JOIN suppliers s ON s."Id" = po.supplier_id
        ORDER BY gri.product_id, po.order_date DESC
      )
      SELECT
        pb.id            AS product_id,
        pb.name          AS product_name,
        pb.sku,
        pb.category,
        COALESCE(bs.batch_qty, pi_fallback.quantity_on_hand, 0)::numeric AS current_stock,
        pb.cost_price,
        pb.reorder_level,
        COALESCE(s30.units_sold, 0) AS units_sold_30d,
        COALESCE(s7.units_sold, 0)  AS units_sold_7d,
        COALESCE(qoo.qty, 0)        AS qty_on_order,
        si.supplier_id,
        si.supplier_name,
        COALESCE(si.lead_time_days, 7) AS lead_time_days
      FROM product_base pb
      LEFT JOIN product_inventory pi_fallback ON pi_fallback.product_id = pb.id
      LEFT JOIN batch_stock bs ON bs.product_id = pb.id
      LEFT JOIN qty_on_order qoo ON qoo.product_id = pb.id
      LEFT JOIN sales_30d s30 ON s30.product_id = pb.id
      LEFT JOIN sales_7d s7 ON s7.product_id = pb.id
      LEFT JOIN supplier_info si ON si.product_id = pb.id
    `;

    const result = await pool.query(query, params);

    return result.rows.map((row): ReorderDashboardItem => {
      const currentStock = new Decimal(row.current_stock).toNumber();
      const costPrice = new Decimal(row.cost_price).toNumber();
      const unitsSold30d = new Decimal(row.units_sold_30d).toNumber();
      const unitsSold7d = new Decimal(row.units_sold_7d).toNumber();
      const qtyOnOrder = new Decimal(row.qty_on_order).toNumber();
      const leadTimeDays = Number(row.lead_time_days) || 7;
      const reorderLevel = new Decimal(row.reorder_level).toNumber();

      const velocity30d = new Decimal(unitsSold30d).dividedBy(30).toNumber();
      const velocity7d = new Decimal(unitsSold7d).dividedBy(7).toNumber();
      const effectiveVelocity = new Decimal(Math.max(velocity30d, velocity7d)).toDecimalPlaces(2).toNumber();

      const daysUntilStockout: number | null =
        effectiveVelocity > 0
          ? new Decimal(currentStock).dividedBy(effectiveVelocity).toDecimalPlaces(0).toNumber()
          : null;

      const safetyStock = effectiveVelocity > 0
        ? Math.ceil(effectiveVelocity * Math.max(leadTimeDays * 0.5, 2))
        : 0;

      const reorderPoint = effectiveVelocity > 0
        ? Math.ceil(effectiveVelocity * leadTimeDays + safetyStock)
        : reorderLevel;

      const netShortfall = Math.ceil(reorderPoint - currentStock - qtyOnOrder);
      const suggestedOrderQty = Math.max(0, netShortfall);
      const estimatedOrderCost = costPrice > 0
        ? new Decimal(suggestedOrderQty).times(costPrice).toDecimalPlaces(2).toNumber()
        : null;

      const { priority, reason } = classifyReorderPriority({
        currentStock,
        unitsSold30d,
        effectiveVelocity,
        daysUntilStockout,
        leadTimeDays,
        reorderPoint,
        reorderLevel,
        qtyOnOrder,
      });

      return {
        productId: row.product_id,
        name: row.product_name,
        sku: row.sku,
        category: row.category,
        currentStock,
        unitsSold30d,
        unitsSold7d,
        qtyOnOrder,
        dailySalesVelocity: effectiveVelocity,
        daysUntilStockout,
        suggestedOrderQty,
        estimatedOrderCost,
        priority,
        reason,
        leadTimeDays,
        reorderPoint,
        reorderLevel,
        safetyStock,
        costPrice: costPrice > 0 ? costPrice : null,
        preferredSupplier: row.supplier_name ?? null,
        preferredSupplierId: row.supplier_id ?? null,
      };
    });
  },

  /**
   * SALES BY CATEGORY REPORT
   * Analyze sales performance by product category
   */
  async getSalesByCategory(
    pool: Pool,
    options: {
      startDate: string;
      endDate: string;
      category?: string;
      paymentMethod?: string;
    }
  ): Promise<SalesByCategoryRow[]> {
    const [startUtc, endUtc] = toUtcParams(options.startDate, options.endDate);
    const params: unknown[] = [startUtc, endUtc];

    let categoryFilter = '';
    if (options.category) {
      params.push(options.category);
      categoryFilter = `AND ${categoryMatchClause('p.category', params.length)}`;
    }

    let paymentFilter = '';
    if (options.paymentMethod) {
      params.push(options.paymentMethod);
      paymentFilter = `AND s.payment_method::text = $${params.length}`;
    }

    const query = `
      SELECT 
        COALESCE(p.category, 'Uncategorized') as category,
        COUNT(DISTINCT p.id) as product_count,
        SUM(si.quantity) as total_quantity_sold,
        SUM(si.total_price) as total_revenue,
        SUM(si.quantity * si.unit_cost) as total_cost,
        SUM(si.profit) as gross_profit,
        COALESCE(SUM(si.discount_amount), 0) as total_discounts,
        COUNT(DISTINCT s.id) as transaction_count,
        AVG(si.total_price) as average_transaction_value
      FROM sales s
      INNER JOIN sale_items si ON si.sale_id = s.id
      LEFT JOIN products p ON p.id = si.product_id
      WHERE s.sale_date >= ($1::timestamptz AT TIME ZONE '${TZ}')::date AND s.sale_date < ($2::timestamptz AT TIME ZONE '${TZ}')::date
        AND s.status NOT IN ('VOID', 'REFUNDED', 'VOIDED_BY_RETURN')
        ${categoryFilter}
        ${paymentFilter}
      GROUP BY COALESCE(p.category, 'Uncategorized')
      ORDER BY total_revenue DESC
    `;

    const result = await pool.query(query, params);

    return result.rows.map((row) => {
      const totalRevenue = new Decimal(row.total_revenue || 0);
      const totalCost = new Decimal(row.total_cost || 0);
      const grossProfit = new Decimal(row.gross_profit || 0);
      const profitMargin = totalRevenue.isZero()
        ? new Decimal(0)
        : grossProfit.dividedBy(totalRevenue).times(100);

      return {
        category: row.category,
        productCount: parseInt(row.product_count),
        totalQuantitySold: new Decimal(row.total_quantity_sold || 0).toDecimalPlaces(2).toNumber(),
        totalRevenue: totalRevenue.toDecimalPlaces(2).toNumber(),
        totalCost: totalCost.toDecimalPlaces(2).toNumber(),
        grossProfit: grossProfit.toDecimalPlaces(2).toNumber(),
        profitMargin: profitMargin.toDecimalPlaces(2).toNumber(),
        totalDiscounts: new Decimal(row.total_discounts || 0).toDecimalPlaces(2).toNumber(),
        transactionCount: parseInt(row.transaction_count),
        averageTransactionValue: new Decimal(row.average_transaction_value || 0)
          .toDecimalPlaces(2)
          .toNumber(),
      };
    });
  },

  /**
   * SALES BY PAYMENT METHOD REPORT
   * Breakdown of sales by payment method
   */
  async getSalesByPaymentMethod(
    pool: Pool,
    options: {
      startDate: string;
      endDate: string;
    }
  ): Promise<SalesByPaymentMethodRow[]> {
    const [startUtc, endUtc] = toUtcParams(options.startDate, options.endDate);
    const params: unknown[] = [startUtc, endUtc];

    const query = `
      WITH payment_totals AS (
        SELECT 
          s.payment_method,
          COUNT(s.id) as transaction_count,
          SUM(s.total_amount) as total_revenue,
          AVG(s.total_amount) as average_transaction_value,
          COALESCE(SUM(s.discount_amount), 0) as total_discounts
        FROM sales s
        WHERE s.sale_date >= ($1::timestamptz AT TIME ZONE '${TZ}')::date AND s.sale_date < ($2::timestamptz AT TIME ZONE '${TZ}')::date
          AND s.status NOT IN ('VOID', 'REFUNDED', 'VOIDED_BY_RETURN')
        GROUP BY s.payment_method
      ),
      grand_total AS (
        SELECT SUM(total_revenue) as grand_total_revenue FROM payment_totals
      )
      SELECT 
        pt.payment_method,
        pt.transaction_count,
        pt.total_revenue,
        pt.average_transaction_value,
        pt.total_discounts,
        (pt.total_revenue / NULLIF(gt.grand_total_revenue, 0) * 100) as percentage_of_total
      FROM payment_totals pt
      CROSS JOIN grand_total gt
      ORDER BY pt.total_revenue DESC
    `;

    const result = await pool.query(query, params);

    return result.rows.map((row) => ({
      paymentMethod: row.payment_method || 'UNKNOWN',
      transactionCount: parseInt(row.transaction_count),
      totalRevenue: new Decimal(row.total_revenue || 0).toDecimalPlaces(2).toNumber(),
      totalDiscounts: new Decimal(row.total_discounts || 0).toDecimalPlaces(2).toNumber(),
      averageTransactionValue: new Decimal(row.average_transaction_value || 0)
        .toDecimalPlaces(2)
        .toNumber(),
      percentageOfTotal: new Decimal(row.percentage_of_total || 0).toDecimalPlaces(2).toNumber(),
    }));
  },

  /**
   * HOURLY SALES ANALYSIS REPORT
   * Analyze sales patterns by hour of day
   */
  async getHourlySalesAnalysis(
    pool: Pool,
    options: {
      startDate: string;
      endDate: string;
    }
  ): Promise<HourlySalesAnalysisRow[]> {
    const [startUtc, endUtc] = toUtcParams(options.startDate, options.endDate);
    const params: unknown[] = [startUtc, endUtc];

    const query = `
      SELECT 
        EXTRACT(HOUR FROM s.sale_date AT TIME ZONE '${TZ}') as hour,
        COUNT(s.id) as transaction_count,
        SUM(s.total_amount) as total_revenue,
        AVG(s.total_amount) as average_transaction_value,
        MODE() WITHIN GROUP (ORDER BY to_char(s.sale_date AT TIME ZONE '${TZ}', 'Day')) as peak_day
      FROM sales s
      WHERE s.sale_date >= ($1::timestamptz AT TIME ZONE '${TZ}')::date AND s.sale_date < ($2::timestamptz AT TIME ZONE '${TZ}')::date
        AND s.status NOT IN ('VOID', 'REFUNDED', 'VOIDED_BY_RETURN')
      GROUP BY EXTRACT(HOUR FROM s.sale_date AT TIME ZONE '${TZ}')
      ORDER BY hour
    `;

    const result = await pool.query(query, params);

    return result.rows.map((row) => ({
      hour: parseInt(row.hour),
      transactionCount: parseInt(row.transaction_count),
      totalRevenue: new Decimal(row.total_revenue || 0).toDecimalPlaces(2).toNumber(),
      averageTransactionValue: new Decimal(row.average_transaction_value || 0)
        .toDecimalPlaces(2)
        .toNumber(),
      peakDay: row.peak_day?.trim(),
    }));
  },

  /**
   * SALES COMPARISON REPORT
   * Period-over-period: bucket each range, then align by ordinal index
   * (1st week of current ↔ 1st week of previous). Never join on calendar labels.
   */
  async getSalesComparison(
    pool: Pool,
    options: {
      currentStartDate: string;
      currentEndDate: string;
      previousStartDate: string;
      previousEndDate: string;
      groupBy: 'day' | 'week' | 'month';
    }
  ): Promise<SalesComparisonRow[]> {
    const [curStartUtc, curEndUtc] = toUtcParams(options.currentStartDate, options.currentEndDate);
    const [prevStartUtc, prevEndUtc] = toUtcParams(options.previousStartDate, options.previousEndDate);

    let groupByClause = '';
    let selectClause = '';

    switch (options.groupBy) {
      case 'day':
        selectClause = `to_char((s.sale_date AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD')`;
        groupByClause = `(s.sale_date AT TIME ZONE '${TZ}')::date`;
        break;
      case 'week':
        selectClause = `to_char(DATE_TRUNC('week', s.sale_date AT TIME ZONE '${TZ}'), 'YYYY-MM-DD')`;
        groupByClause = `DATE_TRUNC('week', s.sale_date AT TIME ZONE '${TZ}')`;
        break;
      case 'month':
        selectClause = `to_char(DATE_TRUNC('month', s.sale_date AT TIME ZONE '${TZ}'), 'YYYY-MM')`;
        groupByClause = `DATE_TRUNC('month', s.sale_date AT TIME ZONE '${TZ}')`;
        break;
    }

    const bucketSql = `
      SELECT
        ${selectClause} as period,
        COALESCE(SUM(s.total_amount), 0) as total_sales,
        COUNT(s.id)::int as transaction_count
      FROM sales s
      WHERE s.sale_date >= ($1::timestamptz AT TIME ZONE '${TZ}')::date
        AND s.sale_date < ($2::timestamptz AT TIME ZONE '${TZ}')::date
        AND s.status NOT IN ('VOID', 'REFUNDED', 'VOIDED_BY_RETURN')
      GROUP BY ${groupByClause}
      ORDER BY period
    `;

    const [curRes, prevRes] = await Promise.all([
      pool.query(bucketSql, [curStartUtc, curEndUtc]),
      pool.query(bucketSql, [prevStartUtc, prevEndUtc]),
    ]);

    const toBucket = (row: Record<string, unknown>) => ({
      period: String(row.period ?? ''),
      totalSales: new Decimal(row.total_sales || 0).toDecimalPlaces(2).toNumber(),
      transactionCount: parseInt(String(row.transaction_count ?? 0), 10) || 0,
    });

    const aligned = alignSalesComparisonBuckets(
      curRes.rows.map(toBucket),
      prevRes.rows.map(toBucket),
    );

    return aligned.map((row) => ({
      period: row.period,
      previousPeriod: row.previousPeriod,
      currentSales: new Decimal(row.currentSales).toDecimalPlaces(2).toNumber(),
      previousSales: new Decimal(row.previousSales).toDecimalPlaces(2).toNumber(),
      difference: new Decimal(row.difference).toDecimalPlaces(2).toNumber(),
      percentageChange:
        row.percentageChange === null
          ? null
          : new Decimal(row.percentageChange).toDecimalPlaces(2).toNumber(),
      currentTransactions: row.currentTransactions,
      previousTransactions: row.previousTransactions,
    }));
  },

  /**
   * CUSTOMER PURCHASE HISTORY REPORT
   * Detailed purchase history for a specific customer
   */
  async getCustomerPurchaseHistory(
    pool: Pool,
    options: {
      customerId: string;
      startDate: string;
      endDate: string;
    }
  ): Promise<CustomerPurchaseHistoryRow[]> {
    const [startUtc, endUtc] = toUtcParams(options.startDate, options.endDate);

    // Determine if input is UUID or customer_number
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      options.customerId
    );

    // If not UUID, look up customer by customer_number first
    let customerUuid = options.customerId;
    if (!isUuid) {
      const customerLookup = await pool.query(
        'SELECT id FROM customers WHERE customer_number = $1',
        [options.customerId]
      );
      if (customerLookup.rows.length === 0) {
        // Return empty array if customer not found
        return [];
      }
      customerUuid = customerLookup.rows[0].id;
    }

    const params: unknown[] = [customerUuid, startUtc, endUtc];

    const query = `
      SELECT 
        s.id as sale_id,
        s.sale_number,
        to_char(s.sale_date, 'YYYY-MM-DD HH24:MI:SS') as sale_date,
        s.total_amount,
        COALESCE(i.amount_paid, s.amount_paid) as amount_paid,
        COALESCE(i.amount_due, s.total_amount - s.amount_paid) as outstanding_balance,
        s.payment_method,
        COUNT(si.id) as item_count,
        COALESCE(i.status, s.status::text) as status
      FROM sales s
      LEFT JOIN invoices i ON i.sale_id = s.id
      LEFT JOIN sale_items si ON si.sale_id = s.id
      WHERE s.customer_id = $1
        AND s.sale_date >= ($2::timestamptz AT TIME ZONE '${TZ}')::date AND s.sale_date < ($3::timestamptz AT TIME ZONE '${TZ}')::date
        AND s.status NOT IN ('VOID', 'REFUNDED', 'VOIDED_BY_RETURN')
      GROUP BY s.id, s.sale_number, s.sale_date, s.total_amount, s.amount_paid,
               s.payment_method, s.status, i.amount_paid, i.amount_due, i.status
      ORDER BY s.sale_date DESC
    `;

    const result = await pool.query(query, params);

    return result.rows.map((row) => ({
      saleId: row.sale_id,
      saleNumber: row.sale_number,
      saleDate: row.sale_date,
      totalAmount: new Decimal(row.total_amount || 0).toDecimalPlaces(2).toNumber(),
      amountPaid: new Decimal(row.amount_paid || 0).toDecimalPlaces(2).toNumber(),
      outstandingBalance: new Decimal(row.outstanding_balance || 0).toDecimalPlaces(2).toNumber(),
      paymentMethod: row.payment_method,
      itemCount: parseInt(row.item_count),
      status: row.status,
    }));
  },

  /**
   * COMPREHENSIVE BUSINESS POSITION REPORT
   * Daily business health assessment with multiple metrics
   * Includes liquidity, profitability, customer metrics, and risk indicators
   */
  async getBusinessPositionReport(
    pool: Pool,
    options: {
      reportDate: string;
      includeComparisons?: boolean;
      includeForecasts?: boolean;
    }
  ): Promise<BusinessPositionData> {
    const reportDateStr = String(options.reportDate).slice(0, 10);
    const [dayStartUtc, dayEndUtc] = toUtcParams(reportDateStr, reportDateStr);

    // Complex multi-CTE query for comprehensive business metrics
    const query = `
      WITH daily_sales_metrics AS (
        -- Today's sales performance
        SELECT 
          COUNT(s.id) as transactions_count,
          COUNT(DISTINCT s.customer_id) as unique_customers,
          SUM(s.total_amount) as total_revenue,
          SUM(s.subtotal - s.discount_amount) as net_revenue,
          SUM(s.total_cost) as total_cost,
          SUM(s.profit) as gross_profit,
          AVG(s.total_amount) as avg_transaction_value,
          SUM(CASE WHEN s.customer_id IS NULL THEN s.total_amount ELSE 0 END) as walk_in_revenue,
          SUM(CASE WHEN s.customer_id IS NOT NULL THEN s.total_amount ELSE 0 END) as customer_revenue,
          SUM(s.amount_paid) as cash_collected,
          SUM(s.total_amount - s.amount_paid) as credit_extended
        FROM sales s
        WHERE s.sale_date >= ($1::timestamptz AT TIME ZONE '${TZ}')::date AND s.sale_date < ($2::timestamptz AT TIME ZONE '${TZ}')::date
          AND s.status NOT IN ('VOID', 'REFUNDED', 'VOIDED_BY_RETURN')
      ),
      daily_collections AS (
        -- Today's debt collections
        SELECT 
          COUNT(ip.id) as collection_transactions,
          SUM(ip.amount) as total_collections,
          AVG(ip.amount) as avg_collection_value,
          COUNT(DISTINCT i.customer_id) as paying_customers
        FROM invoice_payments ip
        INNER JOIN invoices i ON ip.invoice_id = i.id
        WHERE ip.payment_date >= $1 AND ip.payment_date < $2
      ),
      inventory_health AS (
        -- Current inventory position
        SELECT 
          COUNT(DISTINCT p.id) as total_products,
          SUM(CASE WHEN COALESCE(ib.remaining_quantity, 0) <= pi.reorder_level THEN 1 ELSE 0 END) as low_stock_items,
          SUM(CASE WHEN ib.expiry_date <= ($3::date + INTERVAL '30 days') THEN ib.remaining_quantity ELSE 0 END) as expiring_units,
          SUM(ib.remaining_quantity * ib.cost_price) as inventory_value
        FROM products p
        LEFT JOIN product_inventory pi ON pi.product_id = p.id
        LEFT JOIN inventory_batches ib ON p.id = ib.product_id AND ib.remaining_quantity > 0
      ),
      customer_metrics AS (
        -- Customer base health
        SELECT 
          COUNT(c.id) as total_customers,
          COUNT(CASE WHEN c.created_at >= ($3::date - INTERVAL '30 days') THEN 1 END) as new_customers_30d,
          SUM(CASE WHEN c.balance > 0 THEN c.balance ELSE 0 END) as total_receivables,
          COUNT(CASE WHEN c.balance > 0 THEN 1 END) as customers_with_balance,
          AVG(c.balance) as avg_customer_balance
        FROM customers c
      ),
      deposit_liabilities AS (
        -- Customer deposit liabilities (prepayments owed)
        SELECT
          COUNT(cd.id) as active_deposit_count,
          COUNT(DISTINCT cd.customer_id) as customers_with_deposits,
          COALESCE(SUM(cd.amount_available), 0) as total_deposit_liability,
          COALESCE(SUM(cd.amount), 0) as total_deposited,
          COALESCE(SUM(cd.amount_used), 0) as total_cleared
        FROM pos_customer_deposits cd
        WHERE cd.status = 'ACTIVE' AND cd.amount_available > 0
      ),
      cash_position AS (
        -- Working capital indicators
        SELECT 
          -- Today's cash flow (including deposits received)
          COALESCE(dsm.cash_collected, 0) + COALESCE(dc.total_collections, 0) as total_cash_in,
          COALESCE(dsm.credit_extended, 0) as new_credit_extended,
          -- Outstanding position
          COALESCE(cm.total_receivables, 0) as outstanding_receivables,
          -- Deposit liabilities
          COALESCE(dl.total_deposit_liability, 0) as deposit_liability,
          COALESCE(dl.active_deposit_count, 0) as active_deposit_count,
          COALESCE(dl.customers_with_deposits, 0) as customers_with_deposits,
          COALESCE(dl.total_deposited, 0) as total_deposited,
          COALESCE(dl.total_cleared, 0) as total_cleared,
          -- Efficiency ratios
          CASE 
            WHEN COALESCE(dsm.net_revenue, 0) > 0 THEN 
              COALESCE(dsm.gross_profit, 0) / COALESCE(dsm.net_revenue, 0) * 100
            ELSE 0
          END as profit_margin_percent,
          CASE 
            WHEN COALESCE(dsm.total_revenue, 0) > 0 THEN
              COALESCE(dsm.cash_collected, 0) / COALESCE(dsm.total_revenue, 0) * 100
            ELSE 0
          END as cash_collection_rate
        FROM daily_sales_metrics dsm
        CROSS JOIN daily_collections dc
        CROSS JOIN customer_metrics cm
        CROSS JOIN deposit_liabilities dl
      )
      SELECT 
        -- Sales Performance
        dsm.transactions_count,
        dsm.unique_customers,
        dsm.total_revenue,
        dsm.total_cost,
        dsm.gross_profit,
        dsm.avg_transaction_value,
        dsm.walk_in_revenue,
        dsm.customer_revenue,
        dsm.cash_collected as sales_cash_collected,
        dsm.credit_extended,
        
        -- Collections Performance
        dc.collection_transactions,
        dc.total_collections,
        dc.avg_collection_value,
        dc.paying_customers,
        
        -- Inventory Health
        ih.total_products,
        ih.low_stock_items,
        ih.expiring_units,
        ih.inventory_value,
        
        -- Customer Base
        cm.total_customers,
        cm.new_customers_30d,
        cm.total_receivables,
        cm.customers_with_balance,
        cm.avg_customer_balance,
        
        -- Cash Position & Ratios
        cp.total_cash_in,
        cp.new_credit_extended,
        cp.outstanding_receivables,
        cp.deposit_liability,
        cp.active_deposit_count,
        cp.customers_with_deposits,
        cp.total_deposited,
        cp.total_cleared,
        cp.profit_margin_percent,
        cp.cash_collection_rate,
        
        -- Risk Indicators
        CASE 
          WHEN cm.total_receivables > (dsm.total_revenue * 30) THEN 'HIGH'
          WHEN cm.total_receivables > (dsm.total_revenue * 15) THEN 'MEDIUM'
          ELSE 'LOW'
        END as receivables_risk,
        
        CASE 
          WHEN ih.low_stock_items > (ih.total_products * 0.2) THEN 'HIGH'
          WHEN ih.low_stock_items > (ih.total_products * 0.1) THEN 'MEDIUM'
          ELSE 'LOW'
        END as inventory_risk,
        
        -- Business Health Score (0-100)
        GREATEST(0, LEAST(100, (
          (CASE WHEN dsm.total_revenue > 0 THEN 25 ELSE 0 END) + -- Revenue generation
          (CASE WHEN cp.profit_margin_percent >= 20 THEN 25 WHEN cp.profit_margin_percent >= 10 THEN 15 ELSE 5 END) + -- Profitability
          (CASE WHEN cp.cash_collection_rate >= 80 THEN 25 WHEN cp.cash_collection_rate >= 60 THEN 15 ELSE 5 END) + -- Collections
          (CASE WHEN ih.low_stock_items <= (ih.total_products * 0.1) THEN 25 WHEN ih.low_stock_items <= (ih.total_products * 0.2) THEN 15 ELSE 5 END) -- Inventory
        ))) as business_health_score
        
      FROM daily_sales_metrics dsm
      CROSS JOIN daily_collections dc
      CROSS JOIN inventory_health ih
      CROSS JOIN customer_metrics cm
      CROSS JOIN cash_position cp
    `;

    const result = await pool.query(query, [dayStartUtc, dayEndUtc, reportDateStr]);
    const row = result.rows[0];

    if (!row) {
      return {
        reportDate: reportDateStr,
        businessHealthScore: 0,
        salesPerformance: {
          transactionsCount: 0,
          uniqueCustomers: 0,
          totalRevenue: 0,
          totalCost: 0,
          grossProfit: 0,
          avgTransactionValue: 0,
          walkInRevenue: 0,
          customerRevenue: 0,
          salesCashCollected: 0,
          creditExtended: 0,
        },
        collectionsPerformance: {
          collectionTransactions: 0,
          totalCollections: 0,
          avgCollectionValue: 0,
          payingCustomers: 0,
        },
        inventoryHealth: {
          totalProducts: 0,
          lowStockItems: 0,
          expiringUnits: 0,
          inventoryValue: 0,
        },
        customerMetrics: {
          totalCustomers: 0,
          newCustomers30d: 0,
          totalReceivables: 0,
          customersWithBalance: 0,
          avgCustomerBalance: 0,
        },
        cashPosition: {
          totalCashIn: 0,
          newCreditExtended: 0,
          outstandingReceivables: 0,
          depositLiability: 0,
          activeDepositCount: 0,
          customersWithDeposits: 0,
          totalDeposited: 0,
          totalCleared: 0,
          profitMarginPercent: 0,
          cashCollectionRate: 0,
        },
        riskAssessment: {
          receivablesRisk: 'LOW' as const,
          inventoryRisk: 'LOW' as const,
          overallRiskLevel: 'LOW' as const,
        },
      };
    }

    // Return structured business position data with bank-grade precision
    return {
      reportDate: reportDateStr,
      businessHealthScore: parseInt(row.business_health_score || 0),

      salesPerformance: {
        transactionsCount: parseInt(row.transactions_count || 0),
        uniqueCustomers: parseInt(row.unique_customers || 0),
        totalRevenue: new Decimal(row.total_revenue || 0).toDecimalPlaces(2).toNumber(),
        totalCost: new Decimal(row.total_cost || 0).toDecimalPlaces(2).toNumber(),
        grossProfit: new Decimal(row.gross_profit || 0).toDecimalPlaces(2).toNumber(),
        avgTransactionValue: new Decimal(row.avg_transaction_value || 0)
          .toDecimalPlaces(2)
          .toNumber(),
        walkInRevenue: new Decimal(row.walk_in_revenue || 0).toDecimalPlaces(2).toNumber(),
        customerRevenue: new Decimal(row.customer_revenue || 0).toDecimalPlaces(2).toNumber(),
        salesCashCollected: new Decimal(row.sales_cash_collected || 0)
          .toDecimalPlaces(2)
          .toNumber(),
        creditExtended: new Decimal(row.credit_extended || 0).toDecimalPlaces(2).toNumber(),
      },

      collectionsPerformance: {
        collectionTransactions: parseInt(row.collection_transactions || 0),
        totalCollections: new Decimal(row.total_collections || 0).toDecimalPlaces(2).toNumber(),
        avgCollectionValue: new Decimal(row.avg_collection_value || 0)
          .toDecimalPlaces(2)
          .toNumber(),
        payingCustomers: parseInt(row.paying_customers || 0),
      },

      inventoryHealth: {
        totalProducts: parseInt(row.total_products || 0),
        lowStockItems: parseInt(row.low_stock_items || 0),
        expiringUnits: new Decimal(row.expiring_units || 0).toDecimalPlaces(0).toNumber(),
        inventoryValue: new Decimal(row.inventory_value || 0).toDecimalPlaces(2).toNumber(),
      },

      customerMetrics: {
        totalCustomers: parseInt(row.total_customers || 0),
        newCustomers30d: parseInt(row.new_customers_30d || 0),
        totalReceivables: new Decimal(row.total_receivables || 0).toDecimalPlaces(2).toNumber(),
        customersWithBalance: parseInt(row.customers_with_balance || 0),
        avgCustomerBalance: new Decimal(row.avg_customer_balance || 0)
          .toDecimalPlaces(2)
          .toNumber(),
      },

      cashPosition: {
        totalCashIn: new Decimal(row.total_cash_in || 0).toDecimalPlaces(2).toNumber(),
        newCreditExtended: new Decimal(row.new_credit_extended || 0).toDecimalPlaces(2).toNumber(),
        outstandingReceivables: new Decimal(row.outstanding_receivables || 0)
          .toDecimalPlaces(2)
          .toNumber(),
        depositLiability: new Decimal(row.deposit_liability || 0).toDecimalPlaces(2).toNumber(),
        activeDepositCount: parseInt(row.active_deposit_count || 0),
        customersWithDeposits: parseInt(row.customers_with_deposits || 0),
        totalDeposited: new Decimal(row.total_deposited || 0).toDecimalPlaces(2).toNumber(),
        totalCleared: new Decimal(row.total_cleared || 0).toDecimalPlaces(2).toNumber(),
        profitMarginPercent: new Decimal(row.profit_margin_percent || 0)
          .toDecimalPlaces(2)
          .toNumber(),
        cashCollectionRate: new Decimal(row.cash_collection_rate || 0)
          .toDecimalPlaces(2)
          .toNumber(),
      },

      riskAssessment: {
        receivablesRisk: row.receivables_risk || 'LOW',
        inventoryRisk: row.inventory_risk || 'LOW',
        overallRiskLevel: (() => {
          const risks = [row.receivables_risk, row.inventory_risk];
          if (risks.includes('HIGH')) return 'HIGH';
          if (risks.includes('MEDIUM')) return 'MEDIUM';
          return 'LOW';
        })(),
      },
    };
  },

  // ==============================================================================
  // CASH REGISTER SESSION REPORTS
  // ==============================================================================

  /**
   * CASH REGISTER SESSION SUMMARY REPORT
   * Single session details with full movement breakdown (like X-Report/Z-Report)
   */
  async getCashRegisterSessionSummary(
    pool: Pool,
    sessionId: string
  ): Promise<CashRegisterSessionSummaryData | null> {
    try {
      // Determine if input is UUID or session_number
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        sessionId
      );
      const whereClause = isUuid ? 's.id = $1' : 's.session_number = $1';

      // Get session details
      const sessionResult = await pool.query(
        `
        SELECT 
          s.id,
          s.session_number as "sessionNumber",
          r.name as "registerName",
          u.full_name as "cashierName",
          s.status,
          s.opened_at as "openedAt",
          s.closed_at as "closedAt",
          s.opening_float as "openingFloat",
          s.expected_closing as "expectedClosing",
          s.actual_closing as "actualClosing",
          s.variance,
          s.variance_reason as "varianceReason",
          s.payment_summary as "paymentSummary"
        FROM cash_register_sessions s
        LEFT JOIN cash_registers r ON s.register_id = r.id
        LEFT JOIN users u ON s.user_id = u.id
        WHERE ${whereClause}
      `,
        [sessionId]
      );

      if (sessionResult.rows.length === 0) return null;
      const session = sessionResult.rows[0];
      const actualSessionId = session.id; // Use the actual UUID for subsequent queries

      // Get movement summary with breakdown
      const summaryResult = await pool.query(
        `
        SELECT 
          COALESCE(SUM(CASE WHEN movement_type IN ('CASH_IN', 'CASH_IN_FLOAT', 'CASH_IN_PAYMENT', 'CASH_IN_OTHER') THEN amount ELSE 0 END), 0) as total_cash_in,
          COALESCE(SUM(CASE WHEN movement_type IN ('CASH_OUT', 'CASH_OUT_BANK', 'CASH_OUT_EXPENSE', 'CASH_OUT_OTHER') THEN amount ELSE 0 END), 0) as total_cash_out,
          COALESCE(SUM(CASE WHEN movement_type = 'SALE' THEN amount ELSE 0 END), 0) as total_sales,
          COALESCE(SUM(CASE WHEN movement_type = 'REFUND' THEN amount ELSE 0 END), 0) as total_refunds,
          -- Detailed breakdown
          COALESCE(SUM(CASE WHEN movement_type = 'CASH_IN_FLOAT' THEN amount ELSE 0 END), 0) as cash_in_float,
          COALESCE(SUM(CASE WHEN movement_type = 'CASH_IN_PAYMENT' THEN amount ELSE 0 END), 0) as cash_in_payment,
          COALESCE(SUM(CASE WHEN movement_type = 'CASH_IN_OTHER' THEN amount ELSE 0 END), 0) as cash_in_other,
          COALESCE(SUM(CASE WHEN movement_type = 'CASH_OUT_BANK' THEN amount ELSE 0 END), 0) as cash_out_bank,
          COALESCE(SUM(CASE WHEN movement_type = 'CASH_OUT_EXPENSE' THEN amount ELSE 0 END), 0) as cash_out_expense,
          COALESCE(SUM(CASE WHEN movement_type = 'CASH_OUT_OTHER' THEN amount ELSE 0 END), 0) as cash_out_other,
          COUNT(*) as movement_count
        FROM cash_movements
        WHERE session_id = $1
      `,
        [actualSessionId]
      );

      const s = summaryResult.rows[0];
      const totalCashIn = new Decimal(s.total_cash_in || 0);
      const totalCashOut = new Decimal(s.total_cash_out || 0);
      const totalSales = new Decimal(s.total_sales || 0);
      const totalRefunds = new Decimal(s.total_refunds || 0);
      const openingFloat = new Decimal(session.openingFloat || 0);
      const expectedClosing = openingFloat
        .plus(totalCashIn)
        .plus(totalSales)
        .minus(totalCashOut)
        .minus(totalRefunds);
      const netCashFlow = expectedClosing.minus(openingFloat);

      // Get movements list
      const movementsResult = await pool.query(
        `
        SELECT 
          m.id,
          m.movement_type as "movementType",
          m.amount,
          m.reason,
          m.reference_number as "referenceNumber",
          m.created_at as "createdAt",
          u.full_name as "createdByName"
        FROM cash_movements m
        LEFT JOIN users u ON m.created_by = u.id
        WHERE m.session_id = $1
        ORDER BY m.created_at DESC
      `,
        [actualSessionId]
      );

      // Get linked sales for this session (uses new cash_register_session_id column)
      const salesResult = await pool.query(
        `
        SELECT
          s.id,
          s.sale_number as "saleNumber",
          s.total_amount as "totalAmount",
          s.total_cost as "totalCost",
          s.profit,
          s.payment_method as "paymentMethod",
          s.amount_paid as "amountPaid",
          s.status,
          s.sale_date as "saleDate",
          s.created_at as "createdAt",
          c.name as "customerName"
        FROM sales s
        LEFT JOIN customers c ON c.id = s.customer_id
        WHERE s.cash_register_session_id = $1
          AND s.status NOT IN ('VOID', 'VOIDED_BY_RETURN', 'REFUNDED')
        ORDER BY s.created_at ASC
      `,
        [actualSessionId]
      );

      const sessionSales = salesResult.rows.map((row) => ({
        id: row.id,
        saleNumber: row.saleNumber,
        totalAmount: new Decimal(row.totalAmount || 0).toDecimalPlaces(2).toNumber(),
        totalCost: new Decimal(row.totalCost || 0).toDecimalPlaces(2).toNumber(),
        profit: new Decimal(row.profit || 0).toDecimalPlaces(2).toNumber(),
        paymentMethod: row.paymentMethod,
        amountPaid: new Decimal(row.amountPaid || 0).toDecimalPlaces(2).toNumber(),
        status: row.status,
        saleDate: row.saleDate,
        createdAt: row.createdAt?.toISOString(),
        customerName: row.customerName || 'Walk-in',
      }));

      const salesSummary = {
        totalTransactions: sessionSales.length,
        totalRevenue: sessionSales.reduce(
          (sum, s2) => sum.plus(new Decimal(s2.totalAmount)), new Decimal(0)
        ).toDecimalPlaces(2).toNumber(),
        totalProfit: sessionSales.reduce(
          (sum, s2) => sum.plus(new Decimal(s2.profit)), new Decimal(0)
        ).toDecimalPlaces(2).toNumber(),
      };

      return {
        reportType: 'CASH_REGISTER_SESSION_SUMMARY',
        generatedAt: new Date().toISOString(),

        session: {
          id: session.id,
          sessionNumber: session.sessionNumber,
          registerName: session.registerName || 'Unknown',
          cashierName: session.cashierName || 'Unknown',
          status: session.status,
          openedAt: session.openedAt?.toISOString(),
          closedAt: session.closedAt?.toISOString() || null,
        },

        summary: {
          openingFloat: openingFloat.toDecimalPlaces(2).toNumber(),
          expectedClosing: expectedClosing.toDecimalPlaces(2).toNumber(),
          actualClosing: session.actualClosing ? parseFloat(session.actualClosing) : null,
          variance: session.variance ? parseFloat(session.variance) : null,
          varianceReason: session.varianceReason,

          totalCashIn: totalCashIn.toDecimalPlaces(2).toNumber(),
          totalCashOut: totalCashOut.toDecimalPlaces(2).toNumber(),
          totalSales: totalSales.toDecimalPlaces(2).toNumber(),
          totalRefunds: totalRefunds.toDecimalPlaces(2).toNumber(),
          netCashFlow: netCashFlow.toDecimalPlaces(2).toNumber(),
          movementCount: parseInt(s.movement_count || 0),

          breakdown: {
            cashInFloat: new Decimal(s.cash_in_float || 0).toDecimalPlaces(2).toNumber(),
            cashInPayment: new Decimal(s.cash_in_payment || 0).toDecimalPlaces(2).toNumber(),
            cashInOther: new Decimal(s.cash_in_other || 0).toDecimalPlaces(2).toNumber(),
            cashOutBank: new Decimal(s.cash_out_bank || 0).toDecimalPlaces(2).toNumber(),
            cashOutExpense: new Decimal(s.cash_out_expense || 0).toDecimalPlaces(2).toNumber(),
            cashOutOther: new Decimal(s.cash_out_other || 0).toDecimalPlaces(2).toNumber(),
          },
        },

        paymentSummary: session.paymentSummary || null,

        movements: movementsResult.rows.map((m) => ({
          id: m.id,
          movementType: m.movementType,
          amount: new Decimal(m.amount || 0).toDecimalPlaces(2).toNumber(),
          reason: m.reason,
          referenceNumber: m.referenceNumber,
          createdAt: m.createdAt?.toISOString(),
          createdByName: m.createdByName,
        })),

        sales: sessionSales,
        salesSummary,
      };
    } catch (error) {
      console.error('Error in getCashRegisterSessionSummary:', error);
      return null;
    }
  },

  /**
   * CASH REGISTER MOVEMENT BREAKDOWN REPORT
   * Aggregate movement data across sessions for a date range
   */
  async getCashRegisterMovementBreakdown(
    pool: Pool,
    options: {
      startDate: string;
      endDate: string;
      registerId?: string;
      userId?: string;
    }
  ): Promise<CashRegisterMovementBreakdownData> {
    try {
      const [startUtc, endUtc] = toUtcParams(options.startDate, options.endDate);
      const params: unknown[] = [startUtc, endUtc];
      let paramIndex = 3;

      let whereClause = 'WHERE m.created_at >= $1 AND m.created_at < $2';
      if (options.registerId) {
        whereClause += ` AND s.register_id = $${paramIndex++}`;
        params.push(options.registerId);
      }
      if (options.userId) {
        whereClause += ` AND s.user_id = $${paramIndex++}`;
        params.push(options.userId);
      }

      // Get totals by movement type
      const typeResult = await pool.query(
        `
        SELECT 
          m.movement_type,
          COUNT(*) as count,
          COALESCE(SUM(m.amount), 0) as total
        FROM cash_movements m
        INNER JOIN cash_register_sessions s ON m.session_id = s.id
        ${whereClause}
        GROUP BY m.movement_type
        ORDER BY m.movement_type
      `,
        params
      );

      // Calculate totals
      let totalCashIn = new Decimal(0);
      let totalCashOut = new Decimal(0);
      let totalSales = new Decimal(0);
      let totalRefunds = new Decimal(0);
      let movementCount = 0;

      const byMovementType: Record<string, { count: number; total: number; percentage: number }> =
        {};
      let grandTotal = new Decimal(0);

      for (const row of typeResult.rows) {
        const amount = new Decimal(row.total || 0);
        grandTotal = grandTotal.plus(amount.abs());
        movementCount += parseInt(row.count);

        if (
          ['CASH_IN', 'CASH_IN_FLOAT', 'CASH_IN_PAYMENT', 'CASH_IN_OTHER'].includes(
            row.movement_type
          )
        ) {
          totalCashIn = totalCashIn.plus(amount);
        } else if (
          ['CASH_OUT', 'CASH_OUT_BANK', 'CASH_OUT_EXPENSE', 'CASH_OUT_OTHER'].includes(
            row.movement_type
          )
        ) {
          totalCashOut = totalCashOut.plus(amount);
        } else if (row.movement_type === 'SALE') {
          totalSales = totalSales.plus(amount);
        } else if (row.movement_type === 'REFUND') {
          totalRefunds = totalRefunds.plus(amount);
        }

        byMovementType[row.movement_type] = {
          count: parseInt(row.count),
          total: amount.toDecimalPlaces(2).toNumber(),
          percentage: 0, // Calculate after we have grand total
        };
      }

      // Calculate percentages
      for (const type of Object.keys(byMovementType)) {
        byMovementType[type].percentage = grandTotal.gt(0)
          ? new Decimal(byMovementType[type].total)
            .div(grandTotal)
            .times(100)
            .toDecimalPlaces(2)
            .toNumber()
          : 0;
      }

      // Get session count
      const sessionResult = await pool.query(
        `
        SELECT COUNT(DISTINCT s.id) as session_count
        FROM cash_register_sessions s
        INNER JOIN cash_movements m ON m.session_id = s.id
        ${whereClause}
      `,
        params
      );

      // Get daily breakdown
      const dailyResult = await pool.query(
        `
        SELECT 
          (m.created_at AT TIME ZONE '${TZ}')::date as date,
          COALESCE(SUM(CASE WHEN m.movement_type = 'CASH_IN_FLOAT' THEN m.amount ELSE 0 END), 0) as cash_in_float,
          COALESCE(SUM(CASE WHEN m.movement_type = 'CASH_IN_PAYMENT' THEN m.amount ELSE 0 END), 0) as cash_in_payment,
          COALESCE(SUM(CASE WHEN m.movement_type = 'CASH_IN_OTHER' THEN m.amount ELSE 0 END), 0) as cash_in_other,
          COALESCE(SUM(CASE WHEN m.movement_type = 'CASH_OUT_BANK' THEN m.amount ELSE 0 END), 0) as cash_out_bank,
          COALESCE(SUM(CASE WHEN m.movement_type = 'CASH_OUT_EXPENSE' THEN m.amount ELSE 0 END), 0) as cash_out_expense,
          COALESCE(SUM(CASE WHEN m.movement_type = 'CASH_OUT_OTHER' THEN m.amount ELSE 0 END), 0) as cash_out_other,
          COALESCE(SUM(CASE WHEN m.movement_type = 'SALE' THEN m.amount ELSE 0 END), 0) as sales,
          COALESCE(SUM(CASE WHEN m.movement_type = 'REFUND' THEN m.amount ELSE 0 END), 0) as refunds
        FROM cash_movements m
        INNER JOIN cash_register_sessions s ON m.session_id = s.id
        ${whereClause}
        GROUP BY (m.created_at AT TIME ZONE '${TZ}')::date
        ORDER BY (m.created_at AT TIME ZONE '${TZ}')::date DESC
      `,
        params
      );

      const netCashFlow = totalCashIn.plus(totalSales).minus(totalCashOut).minus(totalRefunds);

      return {
        reportType: 'CASH_REGISTER_MOVEMENT_BREAKDOWN',
        generatedAt: new Date().toISOString(),
        period: {
          startDate: options.startDate,
          endDate: options.endDate,
        },

        totals: {
          totalCashIn: totalCashIn.toDecimalPlaces(2).toNumber(),
          totalCashOut: totalCashOut.toDecimalPlaces(2).toNumber(),
          totalSales: totalSales.toDecimalPlaces(2).toNumber(),
          totalRefunds: totalRefunds.toDecimalPlaces(2).toNumber(),
          netCashFlow: netCashFlow.toDecimalPlaces(2).toNumber(),
          sessionCount: parseInt(sessionResult.rows[0]?.session_count || 0),
          movementCount,
        },

        byMovementType,

        dailyBreakdown: dailyResult.rows.map((row) => {
          const cashIn = new Decimal(row.cash_in_float || 0)
            .plus(row.cash_in_payment || 0)
            .plus(row.cash_in_other || 0);
          const cashOut = new Decimal(row.cash_out_bank || 0)
            .plus(row.cash_out_expense || 0)
            .plus(row.cash_out_other || 0);
          const netFlow = cashIn
            .plus(row.sales || 0)
            .minus(cashOut)
            .minus(row.refunds || 0);

          return {
            date: row.date ? formatDateBusiness(row.date) : '',
            cashInFloat: new Decimal(row.cash_in_float || 0).toDecimalPlaces(2).toNumber(),
            cashInPayment: new Decimal(row.cash_in_payment || 0).toDecimalPlaces(2).toNumber(),
            cashInOther: new Decimal(row.cash_in_other || 0).toDecimalPlaces(2).toNumber(),
            cashOutBank: new Decimal(row.cash_out_bank || 0).toDecimalPlaces(2).toNumber(),
            cashOutExpense: new Decimal(row.cash_out_expense || 0).toDecimalPlaces(2).toNumber(),
            cashOutOther: new Decimal(row.cash_out_other || 0).toDecimalPlaces(2).toNumber(),
            sales: new Decimal(row.sales || 0).toDecimalPlaces(2).toNumber(),
            refunds: new Decimal(row.refunds || 0).toDecimalPlaces(2).toNumber(),
            netFlow: netFlow.toDecimalPlaces(2).toNumber(),
          };
        }),
      };
    } catch (error) {
      console.error('Error in getCashRegisterMovementBreakdown:', error);
      return {
        reportType: 'CASH_REGISTER_MOVEMENT_BREAKDOWN',
        generatedAt: new Date().toISOString(),
        period: { startDate: options.startDate, endDate: options.endDate },
        totals: {
          totalCashIn: 0,
          totalCashOut: 0,
          totalSales: 0,
          totalRefunds: 0,
          netCashFlow: 0,
          sessionCount: 0,
          movementCount: 0,
        },
        byMovementType: {},
        dailyBreakdown: [],
      };
    }
  },

  /**
   * CASH REGISTER SESSION HISTORY REPORT
   * List of sessions with summary stats for a date range
   */
  async getCashRegisterSessionHistory(
    pool: Pool,
    options: {
      startDate: string;
      endDate: string;
      registerId?: string;
      userId?: string;
      status?: 'OPEN' | 'CLOSED' | 'ALL';
    }
  ): Promise<CashRegisterSessionHistoryData> {
    try {
      const [startUtc, endUtc] = toUtcParams(options.startDate, options.endDate);
      const params: unknown[] = [startUtc, endUtc];
      let paramIndex = 3;

      let whereClause = 'WHERE s.opened_at >= $1 AND s.opened_at < $2';
      if (options.registerId) {
        whereClause += ` AND s.register_id = $${paramIndex++}`;
        params.push(options.registerId);
      }
      if (options.userId) {
        whereClause += ` AND s.user_id = $${paramIndex++}`;
        params.push(options.userId);
      }
      if (options.status && options.status !== 'ALL') {
        whereClause += ` AND s.status = $${paramIndex++}`;
        params.push(options.status);
      }

      // Get sessions with movement counts
      const sessionsResult = await pool.query(
        `
        SELECT 
          s.id,
          s.session_number as "sessionNumber",
          r.name as "registerName",
          u.full_name as "cashierName",
          s.status,
          s.opened_at as "openedAt",
          s.closed_at as "closedAt",
          s.opening_float as "openingFloat",
          s.expected_closing as "expectedClosing",
          s.actual_closing as "actualClosing",
          s.variance,
          s.variance_reason as "varianceReason",
          COALESCE((SELECT COUNT(*) FROM cash_movements m WHERE m.session_id = s.id), 0) as movement_count,
          COALESCE((SELECT SUM(m.amount) FROM cash_movements m WHERE m.session_id = s.id AND m.movement_type = 'SALE'), 0) as total_sales
        FROM cash_register_sessions s
        LEFT JOIN cash_registers r ON s.register_id = r.id
        LEFT JOIN users u ON s.user_id = u.id
        ${whereClause}
        ORDER BY s.opened_at DESC
      `,
        params
      );

      // Calculate summary stats
      let totalVariance = new Decimal(0);
      let varianceCount = 0;
      let openCount = 0;
      let closedCount = 0;

      for (const row of sessionsResult.rows) {
        if (row.status === 'OPEN') openCount++;
        if (row.status === 'CLOSED') closedCount++;
        if (row.variance !== null && row.variance !== undefined) {
          totalVariance = totalVariance.plus(row.variance);
          varianceCount++;
        }
      }

      return {
        reportType: 'CASH_REGISTER_SESSION_HISTORY',
        generatedAt: new Date().toISOString(),
        period: {
          startDate: options.startDate,
          endDate: options.endDate,
        },

        summary: {
          totalSessions: sessionsResult.rows.length,
          openSessions: openCount,
          closedSessions: closedCount,
          totalVariance: totalVariance.toDecimalPlaces(2).toNumber(),
          averageVariance:
            varianceCount > 0 ? totalVariance.div(varianceCount).toDecimalPlaces(2).toNumber() : 0,
          sessionsWithVariance: varianceCount,
        },

        sessions: sessionsResult.rows.map((row) => ({
          id: row.id,
          sessionNumber: row.sessionNumber,
          registerName: row.registerName || 'Unknown',
          cashierName: row.cashierName || 'Unknown',
          status: row.status,
          openedAt: row.openedAt?.toISOString(),
          closedAt: row.closedAt?.toISOString() || null,
          openingFloat: new Decimal(row.openingFloat || 0).toDecimalPlaces(2).toNumber(),
          expectedClosing: row.expectedClosing
            ? new Decimal(row.expectedClosing).toDecimalPlaces(2).toNumber()
            : null,
          actualClosing: row.actualClosing
            ? new Decimal(row.actualClosing).toDecimalPlaces(2).toNumber()
            : null,
          variance: row.variance ? new Decimal(row.variance).toDecimalPlaces(2).toNumber() : null,
          varianceReason: row.varianceReason,
          movementCount: parseInt(row.movement_count || 0),
          totalSales: new Decimal(row.total_sales || 0).toDecimalPlaces(2).toNumber(),
        })),
      };
    } catch (error) {
      console.error('Error in getCashRegisterSessionHistory:', error);
      return {
        reportType: 'CASH_REGISTER_SESSION_HISTORY',
        generatedAt: new Date().toISOString(),
        period: { startDate: options.startDate, endDate: options.endDate },
        summary: {
          totalSessions: 0,
          openSessions: 0,
          closedSessions: 0,
          totalVariance: 0,
          averageVariance: 0,
          sessionsWithVariance: 0,
        },
        sessions: [],
      };
    }
  },

  // ── Delivery Notes Report ──
  async getDeliveryNoteReport(
    pool: Pool,
    options: {
      startDate: string;
      endDate: string;
      customerId?: string;
      status?: string;
    }
  ): Promise<DeliveryNoteReportRow[]> {
    const params: unknown[] = [options.startDate, options.endDate];
    let filters = '';

    if (options.customerId) {
      params.push(options.customerId);
      filters += ` AND dn.customer_id = $${params.length}`;
    }
    if (options.status) {
      params.push(options.status);
      filters += ` AND dn.status = $${params.length}`;
    }

    const query = `
      SELECT
        dn.id as delivery_note_id,
        dn.delivery_note_number,
        q.quote_number as quotation_number,
        dn.customer_name,
        dn.delivery_date,
        dn.status,
        dn.total_amount,
        COUNT(dnl.id) as line_count,
        dn.driver_name,
        dn.vehicle_number,
        dn.created_at,
        dn.posted_at
      FROM delivery_notes dn
      LEFT JOIN quotations q ON q.id = dn.quotation_id
      LEFT JOIN delivery_note_lines dnl ON dnl.delivery_note_id = dn.id
      WHERE dn.delivery_date BETWEEN DATE($1) AND DATE($2)
        ${filters}
      GROUP BY dn.id, dn.delivery_note_number, q.quote_number, dn.customer_name,
               dn.delivery_date, dn.status, dn.total_amount, dn.driver_name,
               dn.vehicle_number, dn.created_at, dn.posted_at
      ORDER BY dn.delivery_date DESC, dn.created_at DESC
    `;

    const result = await pool.query(query, params);

    return result.rows.map((row) => ({
      deliveryNoteId: row.delivery_note_id,
      deliveryNoteNumber: row.delivery_note_number,
      quotationNumber: row.quotation_number || 'N/A',
      customerName: row.customer_name,
      deliveryDate: formatDateOnly(row.delivery_date),
      status: row.status,
      totalAmount: new Decimal(row.total_amount || 0).toDecimalPlaces(2).toNumber(),
      lineCount: parseInt(row.line_count, 10),
      driverName: row.driver_name,
      vehicleNumber: row.vehicle_number,
      createdAt: formatDate(row.created_at),
      postedAt: formatDate(row.posted_at),
    }));
  },

  // ── Quotation Report ──
  async getQuotationReport(
    pool: Pool,
    options: {
      startDate: string;
      endDate: string;
      customerId?: string;
      status?: string;
      quoteType?: string;
    }
  ): Promise<QuotationReportRow[]> {
    const [startUtc, endUtc] = toUtcParams(options.startDate, options.endDate);
    const params: unknown[] = [startUtc, endUtc];
    let filters = '';

    if (options.customerId) {
      params.push(options.customerId);
      filters += ` AND q.customer_id = $${params.length}`;
    }
    if (options.status) {
      params.push(options.status);
      filters += ` AND q.status::text = $${params.length}`;
    }
    if (options.quoteType) {
      params.push(options.quoteType);
      filters += ` AND q.quote_type::text = $${params.length}`;
    }

    const query = `
      SELECT
        q.id as quotation_id,
        q.quote_number,
        q.customer_name,
        q.quote_type::text as quote_type,
        q.status::text as status,
        q.subtotal,
        q.discount_amount,
        q.tax_amount,
        q.total_amount,
        q.valid_from,
        q.valid_until,
        COUNT(qi.id) as line_count,
        s.sale_number as converted_to_sale,
        i.invoice_number as converted_to_invoice,
        q.created_at
      FROM quotations q
      LEFT JOIN quotation_items qi ON qi.quotation_id = q.id
      LEFT JOIN sales s ON s.id = q.converted_to_sale_id
      LEFT JOIN invoices i ON i.id = q.converted_to_invoice_id
      WHERE q.created_at >= $1 AND q.created_at < $2
        ${filters}
      GROUP BY q.id, q.quote_number, q.customer_name, q.quote_type, q.status,
               q.subtotal, q.discount_amount, q.tax_amount, q.total_amount,
               q.valid_from, q.valid_until, s.sale_number, i.invoice_number,
               q.created_at
      ORDER BY q.created_at DESC
    `;

    const result = await pool.query(query, params);

    return result.rows.map((row) => ({
      quotationId: row.quotation_id,
      quoteNumber: row.quote_number,
      customerName: row.customer_name,
      quoteType: row.quote_type,
      status: row.status,
      subtotal: new Decimal(row.subtotal || 0).toDecimalPlaces(2).toNumber(),
      discountAmount: new Decimal(row.discount_amount || 0).toDecimalPlaces(2).toNumber(),
      taxAmount: new Decimal(row.tax_amount || 0).toDecimalPlaces(2).toNumber(),
      totalAmount: new Decimal(row.total_amount || 0).toDecimalPlaces(2).toNumber(),
      validFrom: formatDateOnly(row.valid_from),
      validUntil: formatDateOnly(row.valid_until),
      lineCount: parseInt(row.line_count, 10),
      convertedToSale: row.converted_to_sale,
      convertedToInvoice: row.converted_to_invoice,
      createdAt: formatDate(row.created_at),
    }));
  },

  // ── Manual Journal Entry Report ──
  async getManualJournalEntryReport(
    pool: Pool,
    options: {
      startDate: string;
      endDate: string;
      status?: string;
    }
  ): Promise<ManualJournalEntryReportRow[]> {
    const params: unknown[] = [options.startDate, options.endDate];
    let filters = '';

    if (options.status) {
      params.push(options.status);
      filters += ` AND mje.status = $${params.length}`;
    }

    const query = `
      SELECT
        mje.id as entry_id,
        mje.entry_number,
        mje.entry_date,
        mje.narration,
        mje.reference,
        mje.total_debit,
        mje.total_credit,
        mje.status,
        COUNT(mjel.id) as line_count,
        mje.created_by,
        mje.created_at
      FROM manual_journal_entries mje
      LEFT JOIN manual_journal_entry_lines mjel ON mjel.journal_entry_id = mje.id
      WHERE mje.entry_date BETWEEN DATE($1) AND DATE($2)
        ${filters}
      GROUP BY mje.id, mje.entry_number, mje.entry_date, mje.narration,
               mje.reference, mje.total_debit, mje.total_credit, mje.status,
               mje.created_by, mje.created_at
      ORDER BY mje.entry_date DESC, mje.created_at DESC
    `;

    const result = await pool.query(query, params);

    return result.rows.map((row) => ({
      entryId: row.entry_id,
      entryNumber: row.entry_number,
      entryDate: formatDateOnly(row.entry_date),
      narration: row.narration,
      reference: row.reference,
      totalDebit: new Decimal(row.total_debit || 0).toDecimalPlaces(2).toNumber(),
      totalCredit: new Decimal(row.total_credit || 0).toDecimalPlaces(2).toNumber(),
      status: row.status,
      lineCount: parseInt(row.line_count, 10),
      createdBy: row.created_by,
      createdAt: formatDate(row.created_at),
    }));
  },

  // ── Bank Transaction Report ──
  async getBankTransactionReport(
    pool: Pool,
    options: {
      startDate: string;
      endDate: string;
      bankAccountId?: string;
      type?: string;
      isReconciled?: boolean;
    }
  ): Promise<BankTransactionReportRow[]> {
    const params: unknown[] = [options.startDate, options.endDate];
    let filters = '';

    if (options.bankAccountId) {
      params.push(options.bankAccountId);
      filters += ` AND bt.bank_account_id = $${params.length}`;
    }
    if (options.type) {
      params.push(options.type);
      filters += ` AND bt.type = $${params.length}`;
    }
    if (options.isReconciled !== undefined) {
      params.push(options.isReconciled);
      filters += ` AND bt.is_reconciled = $${params.length}`;
    }

    const query = `
      SELECT
        bt.id as transaction_id,
        bt.transaction_number,
        ba.name as bank_account_name,
        bt.transaction_date,
        bt.type,
        bt.description,
        bt.reference,
        bt.amount,
        bt.running_balance,
        bt.source_type,
        bt.is_reconciled,
        bt.created_at
      FROM bank_transactions bt
      INNER JOIN bank_accounts ba ON ba.id = bt.bank_account_id
      WHERE bt.transaction_date BETWEEN DATE($1) AND DATE($2)
        AND bt.is_reversed = FALSE
        ${filters}
    `;

    const result = await pool.query(query, params);

    return result.rows.map((row) => ({
      transactionId: row.transaction_id,
      transactionNumber: row.transaction_number,
      bankAccountName: row.bank_account_name,
      transactionDate: formatDateOnly(row.transaction_date),
      type: row.type,
      description: row.description,
      reference: row.reference,
      amount: new Decimal(row.amount || 0).toDecimalPlaces(2).toNumber(),
      runningBalance: row.running_balance
        ? new Decimal(row.running_balance).toDecimalPlaces(2).toNumber()
        : null,
      sourceType: row.source_type,
      isReconciled: row.is_reconciled,
      createdAt: formatDate(row.created_at),
    }));
  },

  // ── Void Sales Report ──
  async getVoidSalesReport(
    pool: Pool,
    options: {
      startDate: string;
      endDate: string;
    }
  ): Promise<{
    rows: VoidSalesReportRow[];
    summary: {
      voidedSaleCount: number;
      totalVoidedAmount: number;
      totalVoidedCost: number;
      totalLostProfit: number;
      withAccountingDocCount: number;
      withoutAccountingDocCount: number;
    };
    byReason: Array<{ reason: string; count: number; totalAmount: number }>;
  }> {
    const [startUtc, endUtc] = toUtcParams(options.startDate, options.endDate);

    // Event date = when the void posted (fallback for legacy rows missing voided_at).
    // One row per sale — accounting docs aggregated (a void may reverse SALE + SALE_COGS).
    const rowQuery = `
      SELECT
        s.sale_number,
        s.sale_date,
        s.total_amount,
        s.total_cost,
        s.profit,
        s.void_reason,
        COALESCE(s.voided_at, s.created_at) AS voided_at,
        vu.full_name AS voided_by,
        au.full_name AS void_approved_by,
        COALESCE(c.name, 'Walk-in') AS customer_name,
        s.payment_method,
        COALESCE(si_counts.item_count, 0)::integer AS item_count,
        gl_docs.accounting_doc_number,
        gl_rev.reversal_amount AS gl_reversal_amount
      FROM sales s
      LEFT JOIN users vu ON vu.id = s.voided_by_id
      LEFT JOIN users au ON au.id = s.void_approved_by_id
      LEFT JOIN customers c ON c.id = s.customer_id
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::integer AS item_count
        FROM sale_items si WHERE si.sale_id = s.id
      ) si_counts ON true
      LEFT JOIN LATERAL (
        SELECT string_agg(tn, ', ' ORDER BY tn) AS accounting_doc_number
        FROM (
          SELECT DISTINCT lt."TransactionNumber" AS tn
          FROM ledger_transactions lt
          WHERE lt."ReferenceType" = 'REVERSAL'
            AND lt."ReferenceId" = s.id
            AND lt."TransactionNumber" IS NOT NULL
        ) docs
      ) gl_docs ON true
      LEFT JOIN LATERAL (
        SELECT SUM(le."DebitAmount") AS reversal_amount
        FROM ledger_transactions lt
        JOIN ledger_entries le ON le."TransactionId" = lt."Id"
        WHERE lt."ReferenceType" = 'REVERSAL'
          AND lt."ReferenceId" = s.id
      ) gl_rev ON true
      WHERE s.status = 'VOID'
        AND COALESCE(s.voided_at, s.created_at) >= $1
        AND COALESCE(s.voided_at, s.created_at) < $2
      ORDER BY COALESCE(s.voided_at, s.created_at) DESC
    `;

    // Summary query
    const summaryQuery = `
      SELECT
        COUNT(*)::integer AS total_voided_sales,
        COALESCE(SUM(s.total_amount), 0)::numeric AS total_voided_amount,
        COALESCE(SUM(s.total_cost), 0)::numeric AS total_voided_cost,
        COALESCE(SUM(s.profit), 0)::numeric AS total_lost_profit,
        COUNT(*) FILTER (
          WHERE EXISTS (
            SELECT 1 FROM ledger_transactions lt
            WHERE lt."ReferenceType" = 'REVERSAL' AND lt."ReferenceId" = s.id
          )
        )::integer AS with_acct_doc,
        COUNT(*) FILTER (
          WHERE NOT EXISTS (
            SELECT 1 FROM ledger_transactions lt
            WHERE lt."ReferenceType" = 'REVERSAL' AND lt."ReferenceId" = s.id
          )
        )::integer AS without_acct_doc
      FROM sales s
      WHERE s.status = 'VOID'
        AND COALESCE(s.voided_at, s.created_at) >= $1
        AND COALESCE(s.voided_at, s.created_at) < $2
    `;

    // By-reason breakdown
    const reasonQuery = `
      SELECT
        COALESCE(NULLIF(TRIM(s.void_reason), ''), 'No reason specified') AS reason,
        COUNT(*)::integer AS count,
        COALESCE(SUM(s.total_amount), 0)::numeric AS total_amount
      FROM sales s
      WHERE s.status = 'VOID'
        AND COALESCE(s.voided_at, s.created_at) >= $1
        AND COALESCE(s.voided_at, s.created_at) < $2
      GROUP BY COALESCE(NULLIF(TRIM(s.void_reason), ''), 'No reason specified')
      ORDER BY total_amount DESC
    `;

    const [rowResult, summaryResult, reasonResult] = await Promise.all([
      pool.query(rowQuery, [startUtc, endUtc]),
      pool.query(summaryQuery, [startUtc, endUtc]),
      pool.query(reasonQuery, [startUtc, endUtc]),
    ]);

    const sr = summaryResult.rows[0];

    return {
      rows: rowResult.rows.map((row) => ({
        saleNumber: row.sale_number,
        saleDate: formatDateOnly(row.sale_date),
        totalAmount: new Decimal(row.total_amount || 0).toDecimalPlaces(2).toNumber(),
        totalCost: new Decimal(row.total_cost || 0).toDecimalPlaces(2).toNumber(),
        profit: new Decimal(row.profit || 0).toDecimalPlaces(2).toNumber(),
        voidReason: row.void_reason,
        voidedAt: formatDate(row.voided_at),
        voidedBy: row.voided_by,
        voidApprovedBy: row.void_approved_by,
        customerName: row.customer_name,
        paymentMethod: row.payment_method,
        itemCount: row.item_count,
        accountingDocNumber: row.accounting_doc_number || null,
        glReversalAmount: row.gl_reversal_amount
          ? new Decimal(row.gl_reversal_amount).toDecimalPlaces(2).toNumber()
          : null,
      })),
      summary: {
        voidedSaleCount: parseInt(sr.total_voided_sales) || 0,
        totalVoidedAmount: new Decimal(sr.total_voided_amount || 0).toDecimalPlaces(2).toNumber(),
        totalVoidedCost: new Decimal(sr.total_voided_cost || 0).toDecimalPlaces(2).toNumber(),
        totalLostProfit: new Decimal(sr.total_lost_profit || 0).toDecimalPlaces(2).toNumber(),
        withAccountingDocCount: parseInt(sr.with_acct_doc) || 0,
        withoutAccountingDocCount: parseInt(sr.without_acct_doc) || 0,
      },
      byReason: reasonResult.rows.map((r) => ({
        reason: r.reason,
        count: r.count,
        totalAmount: new Decimal(r.total_amount || 0).toDecimalPlaces(2).toNumber(),
      })),
    };
  },

  // ── Refund Report ──
  async getRefundReport(
    pool: Pool,
    options: {
      startDate: string;
      endDate: string;
    }
  ): Promise<{
    headers: RefundReportHeader[];
    lines: RefundReportLine[];
    summary: {
      refundCount: number;
      totalRevenueReversal: number;
      totalCOGSReversal: number;
      netProfitImpact: number;
      fullRefundCount: number;
      partialRefundCount: number;
      linesWithStockReturn: number;
      linesWithoutStockReturn: number;
    };
    topRefundedProducts: Array<{ productName: string; timesRefunded: number; totalQty: number; totalAmount: number }>;
  }> {
    const [startUtc, endUtc] = toUtcParams(options.startDate, options.endDate);

    // ── 1. Header query: one row per refund document (never multiply by GL postings) ──
    // Accounting docs aggregated — a refund may post multiple ledger transactions.
    const headerQuery = `
      SELECT
        sr.refund_number,
        s.sale_number,
        COALESCE(c.name, 'Walk-in') AS customer_name,
        sr.refund_date,
        sr.reason,
        CASE WHEN s.status = 'REFUNDED' THEN 'Full' ELSE 'Partial' END AS refund_type,
        cu.full_name AS created_by,
        au.full_name AS approved_by,
        (
          SELECT string_agg(tn, ', ' ORDER BY tn)
          FROM (
            SELECT DISTINCT lt."TransactionNumber" AS tn
            FROM ledger_transactions lt
            WHERE lt."ReferenceType" = 'SALE_REFUND'
              AND lt."ReferenceId" = sr.id
              AND lt."TransactionNumber" IS NOT NULL
          ) docs
        ) AS accounting_doc_number,
        sr.total_amount AS total_revenue_reversal,
        sr.total_cost  AS total_cogs_reversal
      FROM sale_refunds sr
      JOIN sales s ON s.id = sr.sale_id
      LEFT JOIN users cu ON cu.id = sr.created_by_id
      LEFT JOIN users au ON au.id = sr.approved_by_id
      LEFT JOIN customers c ON c.id = s.customer_id
      WHERE sr.created_at >= $1 AND sr.created_at < $2
        AND sr.status = 'COMPLETED'
      ORDER BY sr.created_at DESC
    `;

    // ── 2. Line-level query: one row per refunded product line ──
    // Joins back to sale_items for original sold qty and remaining,
    // checks stock_movements for return-to-stock proof,
    // joins inventory_batches for batch number.
    const lineQuery = `
      SELECT
        sr.refund_number,
        s.sale_number,
        COALESCE(p.name, 'Unknown Product') AS product_name,
        p.sku,
        si.quantity::numeric          AS original_sold_qty,
        ri.quantity::numeric          AS refunded_qty,
        (si.quantity - si.refunded_qty)::numeric AS remaining_qty,
        ri.unit_price::numeric        AS unit_selling_price,
        ri.unit_cost::numeric         AS unit_cogs,
        ri.line_total::numeric        AS line_revenue_reversed,
        ri.cost_total::numeric        AS line_cogs_reversed,
        (ri.line_total - ri.cost_total)::numeric AS profit_impact,
        CASE WHEN sm.id IS NOT NULL THEN true ELSE false END AS returned_to_stock,
        ib.batch_number
      FROM sale_refund_items ri
      JOIN sale_refunds sr ON sr.id = ri.refund_id
      JOIN sales s ON s.id = sr.sale_id
      JOIN sale_items si ON si.id = ri.sale_item_id
      LEFT JOIN products p ON p.id = ri.product_id
      LEFT JOIN inventory_batches ib ON ib.id = ri.batch_id
      LEFT JOIN LATERAL (
        SELECT sm2.id
        FROM stock_movements sm2
        WHERE sm2.reference_type = 'REFUND'
          AND sm2.reference_id = sr.id
          AND sm2.product_id = ri.product_id
          AND sm2.movement_type = 'RETURN'
        LIMIT 1
      ) sm ON true
      WHERE sr.created_at >= $1 AND sr.created_at < $2
        AND sr.status = 'COMPLETED'
      ORDER BY sr.created_at DESC, ri.created_at
    `;

    // ── 3. Summary query ──
    const summaryQuery = `
      SELECT
        COUNT(DISTINCT sr.id)::integer AS refund_count,
        COALESCE(SUM(sr.total_amount), 0)::numeric AS total_revenue_reversal,
        COALESCE(SUM(sr.total_cost), 0)::numeric AS total_cogs_reversal,
        COALESCE(SUM(sr.total_amount - sr.total_cost), 0)::numeric AS net_profit_impact,
        COUNT(DISTINCT sr.id) FILTER (WHERE s.status = 'REFUNDED')::integer AS full_refund_count,
        COUNT(DISTINCT sr.id) FILTER (WHERE s.status != 'REFUNDED')::integer AS partial_refund_count
      FROM sale_refunds sr
      JOIN sales s ON s.id = sr.sale_id
      WHERE sr.created_at >= $1 AND sr.created_at < $2
        AND sr.status = 'COMPLETED'
    `;

    // ── 4. Stock return stats (line-level) ──
    const stockStatsQuery = `
      SELECT
        COUNT(*)::integer AS total_lines,
        COUNT(*) FILTER (WHERE sm.id IS NOT NULL)::integer AS lines_with_return
      FROM sale_refund_items ri
      JOIN sale_refunds sr ON sr.id = ri.refund_id
      LEFT JOIN LATERAL (
        SELECT sm2.id
        FROM stock_movements sm2
        WHERE sm2.reference_type = 'REFUND'
          AND sm2.reference_id = sr.id
          AND sm2.product_id = ri.product_id
          AND sm2.movement_type = 'RETURN'
        LIMIT 1
      ) sm ON true
      WHERE sr.created_at >= $1 AND sr.created_at < $2
        AND sr.status = 'COMPLETED'
    `;

    // ── 5. Top refunded products ──
    const topProductsQuery = `
      SELECT
        COALESCE(p.name, 'Unknown Product') AS product_name,
        COUNT(DISTINCT sr.id)::integer AS times_refunded,
        SUM(ri.quantity)::numeric AS total_qty,
        SUM(ri.line_total)::numeric AS total_amount
      FROM sale_refund_items ri
      JOIN sale_refunds sr ON sr.id = ri.refund_id
      LEFT JOIN products p ON p.id = ri.product_id
      WHERE sr.created_at >= $1 AND sr.created_at < $2
        AND sr.status = 'COMPLETED'
      GROUP BY COALESCE(p.name, 'Unknown Product')
      ORDER BY total_amount DESC
      LIMIT 10
    `;

    const [headerResult, lineResult, summaryResult, stockStatsResult, topProductsResult] = await Promise.all([
      pool.query(headerQuery, [startUtc, endUtc]),
      pool.query(lineQuery, [startUtc, endUtc]),
      pool.query(summaryQuery, [startUtc, endUtc]),
      pool.query(stockStatsQuery, [startUtc, endUtc]),
      pool.query(topProductsQuery, [startUtc, endUtc]),
    ]);

    const sr = summaryResult.rows[0];
    const ss = stockStatsResult.rows[0];

    return {
      headers: headerResult.rows.map((row) => ({
        refundNumber: row.refund_number,
        saleNumber: row.sale_number,
        customerName: row.customer_name,
        refundDate: formatDateOnly(row.refund_date),
        reason: row.reason,
        refundType: row.refund_type,
        createdBy: row.created_by,
        approvedBy: row.approved_by,
        accountingDocNumber: row.accounting_doc_number || null,
        totalRevenueReversal: new Decimal(row.total_revenue_reversal || 0).toDecimalPlaces(2).toNumber(),
        totalCOGSReversal: new Decimal(row.total_cogs_reversal || 0).toDecimalPlaces(2).toNumber(),
        netProfitImpact: new Decimal(row.total_revenue_reversal || 0)
          .minus(row.total_cogs_reversal || 0).toDecimalPlaces(2).toNumber(),
      })),
      lines: lineResult.rows.map((row) => ({
        refundNumber: row.refund_number,
        saleNumber: row.sale_number,
        productName: row.product_name,
        sku: row.sku || null,
        originalSoldQty: new Decimal(row.original_sold_qty || 0).toDecimalPlaces(4).toNumber(),
        refundedQty: new Decimal(row.refunded_qty || 0).toDecimalPlaces(4).toNumber(),
        remainingQty: new Decimal(row.remaining_qty || 0).toDecimalPlaces(4).toNumber(),
        unitSellingPrice: new Decimal(row.unit_selling_price || 0).toDecimalPlaces(2).toNumber(),
        unitCOGS: new Decimal(row.unit_cogs || 0).toDecimalPlaces(2).toNumber(),
        lineRevenueReversed: new Decimal(row.line_revenue_reversed || 0).toDecimalPlaces(2).toNumber(),
        lineCOGSReversed: new Decimal(row.line_cogs_reversed || 0).toDecimalPlaces(2).toNumber(),
        profitImpact: new Decimal(row.profit_impact || 0).toDecimalPlaces(2).toNumber(),
        returnedToStock: row.returned_to_stock === true,
        batchNumber: row.batch_number || null,
      })),
      summary: {
        refundCount: parseInt(sr.refund_count) || 0,
        totalRevenueReversal: new Decimal(sr.total_revenue_reversal || 0).toDecimalPlaces(2).toNumber(),
        totalCOGSReversal: new Decimal(sr.total_cogs_reversal || 0).toDecimalPlaces(2).toNumber(),
        netProfitImpact: new Decimal(sr.net_profit_impact || 0).toDecimalPlaces(2).toNumber(),
        fullRefundCount: parseInt(sr.full_refund_count) || 0,
        partialRefundCount: parseInt(sr.partial_refund_count) || 0,
        linesWithStockReturn: parseInt(ss.lines_with_return) || 0,
        linesWithoutStockReturn: (parseInt(ss.total_lines) || 0) - (parseInt(ss.lines_with_return) || 0),
      },
      topRefundedProducts: topProductsResult.rows.map((r) => ({
        productName: r.product_name,
        timesRefunded: r.times_refunded,
        totalQty: new Decimal(r.total_qty || 0).toDecimalPlaces(2).toNumber(),
        totalAmount: new Decimal(r.total_amount || 0).toDecimalPlaces(2).toNumber(),
      })),
    };
  },

  // ─────────────────────────────────────────────────────────────────
  // CATEGORY INTELLIGENCE REPORTING ENGINE
  // ─────────────────────────────────────────────────────────────────

  /**
   * CATEGORY INVENTORY POSITION
   * Per-product snapshot of on-hand quantity, average cost, and stock value
   * for all products belonging to the given category.
   * Source: product_inventory + product_valuation + products (no GL).
   */
  async getCategoryInventoryPosition(
    pool: Pool,
    options: { category: string }
  ): Promise<CategoryInventoryPositionRow[]> {
    const query = `
      SELECT
        p.id                                        AS product_id,
        p.sku,
        p.name                                      AS product_name,
        COALESCE(u.symbol, u.name)                  AS unit_of_measure,
        COALESCE(bs.batch_qty, pi.quantity_on_hand, 0) AS qty_on_hand,
        COALESCE(pi.reorder_level, 0)               AS reorder_level,
        COALESCE(pv.average_cost, pv.cost_price, 0) AS unit_cost,
        COALESCE(bs.batch_qty, pi.quantity_on_hand, 0)
          * COALESCE(pv.average_cost, pv.cost_price, 0) AS stock_value
      FROM products p
      LEFT JOIN product_uoms       pu ON pu.product_id = p.id AND pu.is_default = TRUE
      LEFT JOIN uoms               u  ON u.id  = pu.uom_id
      LEFT JOIN product_inventory  pi ON pi.product_id = p.id
      LEFT JOIN product_valuation  pv ON pv.product_id = p.id
      LEFT JOIN (
        SELECT product_id, COALESCE(SUM(remaining_quantity), 0)::numeric AS batch_qty
        FROM inventory_batches
        WHERE status = 'ACTIVE'
        GROUP BY product_id
      ) bs ON bs.product_id = p.id
      WHERE ${productCategoryMatchSql('p', 1)}
        AND p.is_active = TRUE
      ORDER BY p.name
    `;
    const result = await pool.query(query, [options.category]);
    const rows = result.rows;

    // Fetch all UoM levels for these products in one query
    const productIds: string[] = rows.map((r) => r.product_id);
    const uomLevelsByProduct: Map<string, UomLevel[]> = new Map();
    if (productIds.length > 0) {
      const uomQuery = `
        SELECT
          pu.product_id,
          u.id    AS uom_id,
          u.name,
          u.symbol,
          pu.conversion_factor,
          pu.is_default
        FROM product_uoms pu
        JOIN uoms u ON u.id = pu.uom_id
        WHERE pu.product_id = ANY($1::uuid[])
        ORDER BY pu.product_id, pu.conversion_factor DESC
      `;
      const uomResult = await pool.query(uomQuery, [productIds]);
      for (const ur of uomResult.rows) {
        const levels = uomLevelsByProduct.get(ur.product_id) ?? [];
        levels.push({
          uomId: ur.uom_id,
          name: ur.name,
          symbol: ur.symbol || null,
          conversionFactor: new Decimal(ur.conversion_factor || 1).toNumber(),
          isDefault: ur.is_default,
        });
        uomLevelsByProduct.set(ur.product_id, levels);
      }
    }

    return rows.map((row) => ({
      productId: row.product_id,
      sku: row.sku || null,
      productName: row.product_name,
      unitOfMeasure: row.unit_of_measure || null,
      qtyOnHand: new Decimal(row.qty_on_hand || 0).toDecimalPlaces(4).toNumber(),
      reorderLevel: new Decimal(row.reorder_level || 0).toDecimalPlaces(4).toNumber(),
      unitCost: new Decimal(row.unit_cost || 0).toDecimalPlaces(2).toNumber(),
      stockValue: new Decimal(row.stock_value || 0).toDecimalPlaces(2).toNumber(),
      uomLevels: uomLevelsByProduct.get(row.product_id) ?? [],
    }));
  },

  /**
   * CATEGORY SALES BY PRODUCT — per-product movement for one selected category
   */
  async getCategorySalesByProduct(
    pool: Pool,
    options: { category: string; startDate: string; endDate: string }
  ): Promise<CategorySalesProductRow[]> {
    const [startUtc, endUtc] = toUtcParams(options.startDate, options.endDate);
    const query = `
      SELECT
        p.id AS product_id,
        p.sku,
        p.name AS product_name,
        SUM(si.quantity) AS total_quantity_sold,
        SUM(si.total_price) AS total_revenue,
        SUM(si.quantity * si.unit_cost) AS total_cost,
        SUM(si.profit) AS gross_profit,
        COUNT(DISTINCT s.id) AS transaction_count
      FROM sales s
      INNER JOIN sale_items si ON si.sale_id = s.id
      INNER JOIN products p ON p.id = si.product_id
      WHERE s.sale_date >= ($1::timestamptz AT TIME ZONE '${TZ}')::date
        AND s.sale_date < ($2::timestamptz AT TIME ZONE '${TZ}')::date
        AND s.status NOT IN ('VOID', 'REFUNDED', 'VOIDED_BY_RETURN')
        AND ${categoryMatchClause('p.category', 3)}
      GROUP BY p.id, p.sku, p.name
      ORDER BY total_revenue DESC
    `;
    const result = await pool.query(query, [startUtc, endUtc, options.category]);
    return result.rows.map((row) => {
      const totalRevenue = new Decimal(row.total_revenue || 0);
      const grossProfit = new Decimal(row.gross_profit || 0);
      const profitMargin = totalRevenue.isZero()
        ? 0
        : grossProfit.dividedBy(totalRevenue).times(100).toDecimalPlaces(2).toNumber();
      return {
        productId: row.product_id,
        sku: row.sku || null,
        productName: row.product_name,
        totalQuantitySold: new Decimal(row.total_quantity_sold || 0).toDecimalPlaces(2).toNumber(),
        totalRevenue: totalRevenue.toDecimalPlaces(2).toNumber(),
        totalCost: new Decimal(row.total_cost || 0).toDecimalPlaces(2).toNumber(),
        grossProfit: grossProfit.toDecimalPlaces(2).toNumber(),
        profitMargin,
        transactionCount: parseInt(row.transaction_count, 10) || 0,
      };
    });
  },

  /**
   * CATEGORY PURCHASES
   * Goods-receipt-based purchase analysis per category.
   * Aggregates received quantity and value from finalised GRs.
   * Source: goods_receipt_items + goods_receipts + products + purchase_orders + suppliers.
   */
  async getCategoryPurchases(
    pool: Pool,
    options: { category: string; startDate: string; endDate: string }
  ): Promise<CategoryPurchasesRow[]> {
    const [startUtc, endUtc] = toUtcParams(options.startDate, options.endDate);
    const query = `
      SELECT
        p.id                              AS product_id,
        p.sku,
        p.name                            AS product_name,
        COALESCE(u.symbol, u.name)        AS unit_of_measure,
        s."CompanyName"                   AS supplier_name,
        gr.received_date                  AS received_date,
        gr.receipt_number                 AS gr_number,
        SUM(gri.received_quantity)        AS total_qty_received,
        SUM(gri.received_quantity * gri.cost_price) AS total_purchase_value,
        AVG(gri.cost_price)               AS avg_unit_cost
      FROM goods_receipt_items   gri
      JOIN goods_receipts        gr  ON gr.id  = gri.goods_receipt_id
      JOIN products              p   ON p.id   = gri.product_id
      LEFT JOIN product_uoms     pu  ON pu.product_id = p.id AND pu.is_default = TRUE
      LEFT JOIN uoms             u   ON u.id   = pu.uom_id
      LEFT JOIN purchase_orders  po  ON po.id  = gr.purchase_order_id
      LEFT JOIN suppliers        s   ON s."Id" = po.supplier_id
      WHERE ${categoryMatchClause('p.category', 1)}
        AND gr.status = 'COMPLETED'
        AND gr.received_date >= ($2::timestamptz AT TIME ZONE '${TZ}')::date
        AND gr.received_date < ($3::timestamptz AT TIME ZONE '${TZ}')::date
      GROUP BY p.id, p.sku, p.name, COALESCE(u.symbol, u.name), s."CompanyName",
               gr.received_date, gr.receipt_number
      ORDER BY gr.received_date DESC, total_purchase_value DESC
    `;
    const result = await pool.query(query, [options.category, startUtc, endUtc]);
    return result.rows.map((row) => ({
      productId: row.product_id,
      sku: row.sku || null,
      productName: row.product_name,
      unitOfMeasure: row.unit_of_measure || null,
      supplierName: row.supplier_name || 'Unknown',
      receivedDate: row.received_date,
      grNumber: row.gr_number,
      totalQtyReceived: new Decimal(row.total_qty_received || 0).toDecimalPlaces(4).toNumber(),
      totalPurchaseValue: new Decimal(row.total_purchase_value || 0).toDecimalPlaces(2).toNumber(),
      avgUnitCost: new Decimal(row.avg_unit_cost || 0).toDecimalPlaces(2).toNumber(),
    }));
  },

  /**
   * CATEGORY EXPIRY EXPOSURE
   * Active batches expiring within daysAhead days for the given category.
   * Ordered by expiry_date ascending (most urgent first).
   * Source: inventory_batches + products.
   */
  async getCategoryExpiryExposure(
    pool: Pool,
    options: { category: string; daysAhead: number; asOfDate?: string }
  ): Promise<CategoryExpiryExposureRow[]> {
    // Same horizon rule as getExpiringItems (business as-of, include day-0 / past-due).
    const asOf = options.asOfDate || getBusinessDate();
    const query = `
      SELECT
        p.id               AS product_id,
        p.sku,
        p.name             AS product_name,
        COALESCE(u.symbol, u.name) AS unit_of_measure,
        ib.batch_number,
        ib.expiry_date,
        ib.remaining_quantity,
        ib.cost_price,
        ib.remaining_quantity * ib.cost_price AS exposed_value,
        ib.status
      FROM inventory_batches ib
      JOIN products p ON p.id = ib.product_id
      LEFT JOIN product_uoms pu ON pu.product_id = p.id AND pu.is_default = TRUE
      LEFT JOIN uoms u ON u.id = pu.uom_id
      WHERE ${categoryMatchClause('p.category', 1)}
        AND COALESCE(ib.status, 'ACTIVE') = 'ACTIVE'
        AND ib.expiry_date IS NOT NULL
        AND ib.expiry_date::date <= ($2::date + ($3::text || ' days')::interval)
        AND ib.remaining_quantity > 0
      ORDER BY ib.expiry_date ASC, exposed_value DESC
    `;
    const result = await pool.query(query, [options.category, asOf, options.daysAhead]);
    return result.rows.map((row) => ({
      productId: row.product_id,
      sku: row.sku || null,
      productName: row.product_name,
      unitOfMeasure: row.unit_of_measure || null,
      batchNumber: row.batch_number,
      expiryDate: row.expiry_date,
      remainingQuantity: new Decimal(row.remaining_quantity || 0).toDecimalPlaces(4).toNumber(),
      costPrice: new Decimal(row.cost_price || 0).toDecimalPlaces(2).toNumber(),
      exposedValue: new Decimal(row.exposed_value || 0).toDecimalPlaces(2).toNumber(),
      status: row.status,
      daysUntilExpiry: computeDaysUntilExpiry(row.expiry_date) ?? 0,
    }));
  },
};
