// Reports Routes - Express router for reports endpoints
// Updated: 2025-11-09 to support 5 new sales analysis reports

import { Router } from 'express';
import { Pool } from 'pg';
import { reportsController } from './reportsController.js';
import { cnDnReportsController } from './cnDnReportController.js';
import { taxComplianceReportController } from './taxComplianceReportController.js';
import { liquidityMovementsReportController } from './liquidityMovementsReportController.js';
import { inventoryReportsController } from './inventory/inventoryReportsController.js';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../rbac/middleware.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { demandForecastService } from './demandForecastService.js';
import { demandForecastRepository } from './demandForecastRepository.js';
import { getBusinessDate } from '../../utils/dateRange.js';

export function createReportsRouter(pool: Pool) {
  const router = Router();

  // Apply authentication to all routes
  router.use(authenticate);

  // Helper: resolve tenant pool (if multi-tenant) or fall back to factory pool
  const p = (req: import('express').Request) => (req.tenantPool || pool) as Pool;

  router.get(
    '/system-settings',
    asyncHandler(async (req, res) => reportsController.getSystemSettings(req, res, p(req)))
  );
  router.post(
    '/generate',
    asyncHandler(async (req, res) => reportsController.generateReport(req, res, p(req)))
  );
  router.get(
    '/types',
    asyncHandler(async (req, res) => reportsController.getReportTypes(req, res))
  );

  // Inventory Reports
  router.get(
    '/product-categories',
    asyncHandler(async (req, res) => reportsController.getProductCategories(req, res, p(req)))
  );
  router.get(
    '/inventory-valuation',
    requirePermission('reports.read'),
    asyncHandler(async (req, res) => reportsController.getInventoryValuation(req, res, p(req)))
  );

  // ── SAP/Odoo-style inventory reports (refactored: one responsibility each) ──
  // Valuation = finance truth (cost_layers only)
  router.get(
    '/inventory/valuation',
    requirePermission('reports.read'),
    asyncHandler(async (req, res) => inventoryReportsController.getValuation(req, res, p(req)))
  );
  // Reconciliation = accounting control (subledger vs GL 1300)
  router.get(
    '/inventory/reconciliation',
    requirePermission('reports.read'),
    asyncHandler(async (req, res) =>
      inventoryReportsController.getReconciliation(req, res, p(req))
    )
  );
  // Analytics = operations insight (ABC, velocity, dead stock)
  router.get(
    '/inventory/analytics',
    requirePermission('reports.read'),
    asyncHandler(async (req, res) => inventoryReportsController.getAnalytics(req, res, p(req)))
  );
  // Margins = commercial insight (cost vs price)
  router.get(
    '/inventory/margins',
    requirePermission('reports.read'),
    asyncHandler(async (req, res) => inventoryReportsController.getMargins(req, res, p(req)))
  );
  // Store issue audit = posted GI + reverse list (who / why / reverse rate)
  router.get(
    '/inventory/store-issues',
    requirePermission('reports.read'),
    asyncHandler(async (req, res) => inventoryReportsController.getStoreIssues(req, res, p(req)))
  );

  router.get(
    '/inventory-adjustments',
    requirePermission('reports.read'),
    asyncHandler(async (req, res) => reportsController.getInventoryAdjustments(req, res, p(req)))
  );
  router.get(
    '/low-stock',
    requirePermission('reports.read'),
    asyncHandler(async (req, res) => reportsController.getLowStock(req, res, p(req)))
  );
  router.get(
    '/expiring-items',
    requirePermission('reports.read'),
    asyncHandler(async (req, res) => reportsController.getExpiringItems(req, res, p(req)))
  );

  // Sales Reports
  router.get(
    '/sales',
    requirePermission('reports.read'),
    asyncHandler(async (req, res) => reportsController.getSalesReport(req, res, p(req)))
  );
  router.get(
    '/best-selling',
    requirePermission('reports.read'),
    asyncHandler(async (req, res) => reportsController.getBestSelling(req, res, p(req)))
  );
  router.get(
    '/profit-loss',
    requirePermission('reports.read'),
    asyncHandler(async (req, res) => reportsController.getProfitLoss(req, res, p(req)))
  );

  // Supplier Reports
  router.get(
    '/supplier-cost',
    requirePermission('reports.read'),
    asyncHandler(async (req, res) => reportsController.getSupplierCostAnalysis(req, res, p(req)))
  );
  router.get(
    '/goods-received',
    requirePermission('reports.read'),
    asyncHandler(async (req, res) => reportsController.getGoodsReceived(req, res, p(req)))
  );

  // Payment Reports
  router.get(
    '/payments',
    requirePermission('reports.read'),
    asyncHandler(async (req, res) => reportsController.getPaymentReport(req, res, p(req)))
  );
  router.get(
    '/customer-payments',
    requirePermission('reports.read'),
    asyncHandler(async (req, res) => reportsController.getCustomerPayments(req, res, p(req)))
  );

  // Audit Reports
  router.get(
    '/deleted-items',
    requirePermission('reports.read'),
    asyncHandler(async (req, res) => reportsController.getDeletedItems(req, res, p(req)))
  );

  // Void & Refund Reports
  router.get(
    '/void-sales',
    requirePermission('reports.read'),
    asyncHandler(async (req, res) => reportsController.getVoidSalesReport(req, res, p(req)))
  );
  router.get(
    '/refunds',
    requirePermission('reports.read'),
    asyncHandler(async (req, res) => reportsController.getRefundReport(req, res, p(req)))
  );

  // Enhanced Reports
  router.get(
    '/purchase-order-summary',
    requirePermission('reports.read'),
    asyncHandler(async (req, res) => reportsController.getPurchaseOrderSummary(req, res, p(req)))
  );
  router.get(
    '/stock-movement-analysis',
    requirePermission('reports.read'),
    asyncHandler(async (req, res) => reportsController.getStockMovementAnalysis(req, res, p(req)))
  );
  router.get(
    '/customer-account-statement',
    requirePermission('reports.read'),
    asyncHandler(async (req, res) =>
      reportsController.getCustomerAccountStatement(req, res, p(req))
    )
  );
  router.get(
    '/profit-margin',
    requirePermission('reports.read'),
    asyncHandler(async (req, res) => reportsController.getProfitMarginByProduct(req, res, p(req)))
  );
  router.get(
    '/daily-cash-flow',
    requirePermission('reports.read'),
    asyncHandler(async (req, res) => reportsController.getDailyCashFlow(req, res, p(req)))
  );
  router.get(
    '/supplier-payment-status',
    requirePermission('reports.read'),
    asyncHandler(async (req, res) => reportsController.getSupplierPaymentStatus(req, res, p(req)))
  );
  router.get(
    '/top-customers',
    requirePermission('reports.read'),
    asyncHandler(async (req, res) => reportsController.getTopCustomers(req, res, p(req)))
  );
  router.get(
    '/customer-aging',
    requirePermission('reports.read'),
    asyncHandler(async (req, res) => reportsController.getCustomerAging(req, res, p(req)))
  );
  router.get(
    '/stock-aging',
    requirePermission('reports.read'),
    asyncHandler(async (req, res) => reportsController.getStockAging(req, res, p(req)))
  );
  router.get(
    '/waste-damage',
    requirePermission('reports.read'),
    asyncHandler(async (req, res) => reportsController.getWasteDamage(req, res, p(req)))
  );
  router.get(
    '/reorder-recommendations',
    requirePermission('reports.read'),
    asyncHandler(async (req, res) => reportsController.getReorderRecommendations(req, res, p(req)))
  );
  router.get(
    '/reorder-dashboard',
    requirePermission('reports.read'),
    asyncHandler(async (req, res) => reportsController.getReorderDashboard(req, res, p(req)))
  );
  router.post(
    '/reorder-dashboard/pdf',
    requirePermission('reports.read'),
    asyncHandler(async (req, res) => reportsController.exportReorderDashboardPdf(req, res, p(req)))
  );
  router.post(
    '/reorder-dashboard/csv',
    requirePermission('reports.read'),
    asyncHandler(async (req, res) => reportsController.exportReorderDashboardCsv(req, res, p(req)))
  );
  router.get(
    '/business-position',
    requirePermission('reports.read'),
    asyncHandler(async (req, res) => reportsController.getBusinessPositionReport(req, res, p(req)))
  );

  // Sales Analysis Reports
  router.get(
    '/sales-by-category',
    requirePermission('reports.read'),
    asyncHandler(async (req, res) => reportsController.getSalesByCategory(req, res, p(req)))
  );
  router.get(
    '/sales-by-payment-method',
    requirePermission('reports.read'),
    asyncHandler(async (req, res) => reportsController.getSalesByPaymentMethod(req, res, p(req)))
  );
  router.get(
    '/hourly-sales-analysis',
    requirePermission('reports.read'),
    asyncHandler(async (req, res) => reportsController.getHourlySalesAnalysis(req, res, p(req)))
  );
  router.get(
    '/sales-comparison',
    requirePermission('reports.read'),
    asyncHandler(async (req, res) => reportsController.getSalesComparison(req, res, p(req)))
  );
  router.get(
    '/customer-purchase-history',
    requirePermission('reports.read'),
    asyncHandler(async (req, res) => reportsController.getCustomerPurchaseHistory(req, res, p(req)))
  );

  // Additional Sales Reports
  router.get(
    '/sales-summary-by-date',
    requirePermission('reports.read'),
    asyncHandler(async (req, res) =>
      reportsController.getSalesSummaryByDateReport(req, res, p(req))
    )
  );
  router.get(
    '/sales-details',
    requirePermission('reports.read'),
    asyncHandler(async (req, res) => reportsController.getSalesDetailsReport(req, res, p(req)))
  );
  router.get(
    '/sales-by-cashier',
    requirePermission('reports.read'),
    asyncHandler(async (req, res) => reportsController.getSalesByCashierReport(req, res, p(req)))
  );

  // Cash Register Session Reports
  router.get(
    '/cash-register/session/:sessionId',
    requirePermission('reports.read'),
    asyncHandler(async (req, res) =>
      reportsController.getCashRegisterSessionSummary(req, res, p(req))
    )
  );
  router.get(
    '/cash-register/movement-breakdown',
    requirePermission('reports.read'),
    asyncHandler(async (req, res) =>
      reportsController.getCashRegisterMovementBreakdown(req, res, p(req))
    )
  );
  router.get(
    '/cash-register/session-history',
    requirePermission('reports.read'),
    asyncHandler(async (req, res) =>
      reportsController.getCashRegisterSessionHistory(req, res, p(req))
    )
  );

  // Delivery Notes, Quotations, Journal Entries, Bank Transactions Reports
  router.get(
    '/delivery-notes',
    requirePermission('reports.read'),
    asyncHandler(async (req, res) => reportsController.getDeliveryNoteReport(req, res, p(req)))
  );
  router.get(
    '/quotations',
    requirePermission('reports.read'),
    asyncHandler(async (req, res) => reportsController.getQuotationReport(req, res, p(req)))
  );
  router.get(
    '/manual-journal-entries',
    requirePermission('reports.read'),
    asyncHandler(async (req, res) => reportsController.getManualJournalEntryReport(req, res, p(req)))
  );
  router.get(
    '/bank-transactions',
    requirePermission('reports.read'),
    asyncHandler(async (req, res) => reportsController.getBankTransactionReport(req, res, p(req)))
  );

  // ── Demand Forecasting (Self-Learning Engine) ────────
  // Manual trigger: run daily demand stats refresh now (admin/manager only)
  router.post(
    '/demand-forecast/refresh-daily',
    requirePermission('admin.update'),
    asyncHandler(async (req, res) => {
      const result = await demandForecastService.runDailyUpdate(p(req));
      res.json({ success: true, data: result });
    })
  );

  // Manual trigger: run monthly seasonality refresh now (admin/manager only)
  router.post(
    '/demand-forecast/refresh-monthly',
    requirePermission('admin.update'),
    asyncHandler(async (req, res) => {
      const result = await demandForecastService.runMonthlyUpdate(p(req));
      res.json({ success: true, data: result });
    })
  );

  // Get learned demand stats for a specific product
  router.get(
    '/demand-forecast/product/:productId',
    asyncHandler(async (req, res) => {
      const stats = await demandForecastRepository.getStatsForProduct(p(req), req.params.productId);
      const currentMonth = parseInt(getBusinessDate().slice(5, 7), 10);
      const seasonality = await demandForecastRepository.getSeasonalityForMonth(
        p(req),
        currentMonth
      );
      res.json({
        success: true,
        data: {
          demandStats: stats,
          seasonalIndex: seasonality.get(req.params.productId) ?? null,
          currentMonth,
        },
      });
    })
  );

  // Get forecast run history
  router.get(
    '/demand-forecast/runs',
    asyncHandler(async (req, res) => {
      const limit = parseInt(String(req.query.limit || '20'), 10);
      const runs = await demandForecastRepository.getRecentRuns(p(req), limit);
      res.json({ success: true, data: runs });
    })
  );

  // ── Credit/Debit Note Reports ────────────────────────────────────
  router.get(
    '/sales-returns',
    requirePermission('reports.read'),
    asyncHandler(async (req, res) => cnDnReportsController.getSalesReturns(req, res, p(req)))
  );
  router.get(
    '/purchase-returns',
    requirePermission('reports.read'),
    asyncHandler(async (req, res) => cnDnReportsController.getPurchaseReturns(req, res, p(req)))
  );
  router.get(
    '/ar-ledger',
    requirePermission('reports.read'),
    asyncHandler(async (req, res) => cnDnReportsController.getArLedger(req, res, p(req)))
  );
  router.get(
    '/ap-ledger',
    requirePermission('reports.read'),
    asyncHandler(async (req, res) => cnDnReportsController.getApLedger(req, res, p(req)))
  );
  router.get(
    '/note-register',
    requirePermission('reports.read'),
    asyncHandler(async (req, res) => cnDnReportsController.getNoteRegister(req, res, p(req)))
  );
  router.get(
    '/tax-reversal',
    requirePermission('reports.read'),
    asyncHandler(async (req, res) => cnDnReportsController.getTaxReversal(req, res, p(req)))
  );

  // Tax compliance (SSOT: withholding-tax/whtReportService)
  router.get(
    '/tax-compliance/summary',
    requirePermission('reports.read'),
    asyncHandler(async (req, res) => taxComplianceReportController.getSummary(req, res, p(req)))
  );
  router.get(
    '/tax-compliance/register',
    requirePermission('reports.read'),
    asyncHandler(async (req, res) => taxComplianceReportController.getRegister(req, res, p(req)))
  );
  router.get(
    '/tax-compliance/liability',
    requirePermission('reports.read'),
    asyncHandler(async (req, res) => taxComplianceReportController.getLiability(req, res, p(req)))
  );

  // Liquidity movements (Banking & Liquidity SSOT — posted ledger)
  router.get(
    '/liquidity-movements',
    requirePermission('reports.read'),
    asyncHandler(async (req, res) =>
      liquidityMovementsReportController.getMovements(req, res, p(req)),
    ),
  );
  router.get(
    '/liquidity-movements/balances',
    requirePermission('reports.read'),
    asyncHandler(async (req, res) =>
      liquidityMovementsReportController.getBalances(req, res, p(req)),
    ),
  );
  router.get(
    '/liquidity-movements/columns',
    requirePermission('reports.read'),
    asyncHandler(async (req, res) => liquidityMovementsReportController.getColumns(req, res)),
  );

  router.get(
    '/invoice-adjustments/:invoiceId',
    requirePermission('reports.read'),
    asyncHandler(async (req, res) => cnDnReportsController.getInvoiceAdjustments(req, res, p(req)))
  );
  router.get(
    '/supplier-statement/:supplierId',
    requirePermission('reports.read'),
    asyncHandler(async (req, res) => cnDnReportsController.getSupplierStatement(req, res, p(req)))
  );
  router.get(
    '/supplier-aging',
    requirePermission('reports.read'),
    asyncHandler(async (req, res) => cnDnReportsController.getSupplierAging(req, res, p(req)))
  );

  // Orders Reports
  router.get(
    '/orders-report',
    requirePermission('reports.read'),
    asyncHandler(async (req, res) => reportsController.getOrdersReport(req, res, p(req)))
  );
  router.get(
    '/cancelled-orders',
    requirePermission('reports.read'),
    asyncHandler(async (req, res) => reportsController.getCancelledOrdersReport(req, res, p(req)))
  );

  // Category Intelligence
  router.get(
    '/category-intelligence',
    requirePermission('reports.financial_view'),
    asyncHandler(async (req, res) => reportsController.getCategoryIntelligenceReport(req, res, p(req)))
  );

  return router;
}
