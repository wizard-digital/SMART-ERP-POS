/**
 * Inventory Reports Controller (SAP/Odoo-style)
 *
 * Four independent endpoints, one responsibility each. See individual
 * service files for the architectural rules.
 */

import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { generateValuation } from './valuationService.js';
import { generateReconciliation } from './reconciliationService.js';
import { generateAnalytics } from './analyticsService.js';
import { generateMargins } from './marginService.js';
import { generateStoreIssueAudit } from './storeIssueAuditService.js';
import {
  STORE_ISSUE_REVERSE_RATE_WATCH,
  formatQtyWithUom,
  storeIssueAuditMovementLabel,
} from '../../../../../shared/store-issue/index.js';
import {
  ReportPDFGenerator,
  PDFTableColumn,
  formatCurrencyPDF,
  PDFColors,
} from '../../documents/pdfGenerator.js';
import { reportsService } from '../reportsService.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function asOf(req: Request): string | undefined {
  const v = req.query.asOfDate;
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined;
}

function categoryId(req: Request): string | undefined {
  const v = req.query.categoryId;
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function queryString(req: Request, key: string): string | undefined {
  const v = req.query[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function isPdf(req: Request): boolean {
  return req.query.format === 'pdf';
}

function now(): string {
  return new Date().toLocaleString('en-GB', { hour12: false });
}

async function getCompanyName(pool: Pool): Promise<string> {
  try {
    const settings = await reportsService.getSystemSettings(pool);
    return settings.businessName || 'SMART ERP';
  } catch {
    return 'SMART ERP';
  }
}

// ── controller ───────────────────────────────────────────────────────────────

export const inventoryReportsController = {
  async getValuation(req: Request, res: Response, pool: Pool) {
    const report = await generateValuation(pool, {
      asOfDate: asOf(req),
      categoryId: categoryId(req),
    });

    if (isPdf(req)) {
      const company = await getCompanyName(pool);
      const gen = new ReportPDFGenerator(company);
      const doc = gen.getDocument();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="inventory-valuation-${report.asOfDate}.pdf"`);
      doc.pipe(res);

      gen.addHeader({
        companyName: company,
        title: 'Inventory Valuation Report',
        subtitle: `As of ${report.asOfDate}`,
        generatedAt: now(),
      });

      gen.addSummaryCards([
        { label: 'Products', value: String(report.totals.productCount), color: PDFColors.primary },
        { label: 'Total Qty', value: report.totals.totalQuantity.toLocaleString(), color: PDFColors.info },
        { label: 'Stock Value', value: formatCurrencyPDF(report.totals.totalStockValue), color: PDFColors.success },
      ]);

      const columns: PDFTableColumn[] = [
        { header: 'Product', key: 'productName', width: 0.30 },
        { header: 'SKU', key: 'sku', width: 0.15 },
        { header: 'Category', key: 'category', width: 0.18 },
        { header: 'Qty on Hand', key: 'qtyOnHand', width: 0.12, align: 'right' },
        { header: 'Unit Cost', key: 'unitCostFmt', width: 0.12, align: 'right' },
        { header: 'Stock Value', key: 'stockValueFmt', width: 0.13, align: 'right' },
      ];

      gen.addTable(columns, report.rows.map((r) => ({
        ...r,
        sku: r.sku ?? '—',
        category: r.category ?? '—',
        unitCostFmt: formatCurrencyPDF(r.unitCost),
        stockValueFmt: formatCurrencyPDF(r.stockValue),
      })));

      gen.end();
      return;
    }

    res.json({ success: true, data: report });
  },

  async getReconciliation(req: Request, res: Response, pool: Pool) {
    const report = await generateReconciliation(pool, { asOfDate: asOf(req) });

    if (isPdf(req)) {
      const company = await getCompanyName(pool);
      const gen = new ReportPDFGenerator(company);
      const doc = gen.getDocument();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="inventory-reconciliation-${report.asOfDate}.pdf"`);
      doc.pipe(res);

      gen.addHeader({
        companyName: company,
        title: 'Inventory Reconciliation Report',
        subtitle: `As of ${report.asOfDate} — ${report.reconciled ? 'RECONCILED' : 'DRIFT DETECTED'}`,
        generatedAt: now(),
      });

      gen.addSummaryCards([
        { label: 'Subledger', value: formatCurrencyPDF(report.subledgerValue), color: PDFColors.primary },
        { label: 'GL (Acct 1300)', value: formatCurrencyPDF(report.glValue), color: PDFColors.info },
        { label: 'Variance', value: formatCurrencyPDF(report.variance), color: report.reconciled ? PDFColors.success : PDFColors.danger },
        { label: 'Status', value: report.reconciled ? 'Reconciled ✓' : 'Drift', color: report.reconciled ? PDFColors.success : PDFColors.warning },
      ]);

      if (report.driftProducts.length > 0) {
        gen.addSectionHeading(`Subledger Internal Drift (${report.driftProducts.length} products)`);

        const columns: PDFTableColumn[] = [
          { header: 'Product', key: 'productName', width: 0.35 },
          { header: 'SKU', key: 'sku', width: 0.18 },
          { header: 'Inventory Qty', key: 'inventoryQty', width: 0.16, align: 'right' },
          { header: 'Cost Layers Qty', key: 'costLayersQty', width: 0.16, align: 'right' },
          { header: 'Difference', key: 'qtyDifference', width: 0.15, align: 'right' },
        ];

        gen.addTable(columns, report.driftProducts.map((r) => ({
          ...r,
          sku: r.sku ?? '—',
        })));
      }

      gen.end();
      return;
    }

    res.json({ success: true, data: report });
  },

  async getAnalytics(req: Request, res: Response, pool: Pool) {
    const deadRaw = req.query.deadStockDays;
    const deadStockDays =
      typeof deadRaw === 'string' && /^\d+$/.test(deadRaw) ? parseInt(deadRaw, 10) : undefined;
    const report = await generateAnalytics(pool, { asOfDate: asOf(req), deadStockDays });

    if (isPdf(req)) {
      const company = await getCompanyName(pool);
      const gen = new ReportPDFGenerator(company);
      const doc = gen.getDocument();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="inventory-analytics-${report.asOfDate}.pdf"`);
      doc.pipe(res);

      gen.addHeader({
        companyName: company,
        title: 'Inventory Analytics Report',
        subtitle: `As of ${report.asOfDate} — ABC & Velocity Analysis`,
        generatedAt: now(),
      });

      gen.addSummaryCards([
        { label: 'Total Products', value: String(report.summary.totalProducts), color: PDFColors.primary },
        { label: 'Fast Movers', value: String(report.summary.fast), color: PDFColors.success },
        { label: 'Slow / Dead', value: `${report.summary.slow} / ${report.summary.dead}`, color: PDFColors.warning },
        { label: 'ABC: A / B / C', value: `${report.summary.abcA} / ${report.summary.abcB} / ${report.summary.abcC}`, color: PDFColors.info },
      ]);

      const columns: PDFTableColumn[] = [
        { header: 'Product', key: 'productName', width: 0.25 },
        { header: 'SKU', key: 'sku', width: 0.12 },
        { header: 'Category', key: 'category', width: 0.13 },
        { header: 'Velocity', key: 'movementClass', width: 0.10 },
        { header: 'ABC', key: 'abcClass', width: 0.07 },
        { header: 'Last Sale', key: 'lastSaleDate', width: 0.12, align: 'center' },
        { header: 'Days in Stock', key: 'daysInStock', width: 0.10, align: 'right' },
        { header: 'Sold 90d', key: 'unitsSold90d', width: 0.11, align: 'right' },
      ];

      gen.addTable(columns, report.rows.map((r) => ({
        ...r,
        sku: r.sku ?? '—',
        category: r.category ?? '—',
        lastSaleDate: r.lastSaleDate ?? '—',
        daysInStock: r.daysInStock !== null ? String(r.daysInStock) : '—',
      })));

      gen.end();
      return;
    }

    res.json({ success: true, data: report });
  },

  async getMargins(req: Request, res: Response, pool: Pool) {
    const report = await generateMargins(pool, {
      asOfDate: asOf(req),
      categoryId: categoryId(req),
    });

    if (isPdf(req)) {
      const company = await getCompanyName(pool);
      const gen = new ReportPDFGenerator(company);
      const doc = gen.getDocument();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="price-margin-analysis-${report.asOfDate}.pdf"`);
      doc.pipe(res);

      gen.addHeader({
        companyName: company,
        title: 'Price & Margin Analysis',
        subtitle: `As of ${report.asOfDate}`,
        generatedAt: now(),
      });

      gen.addSummaryCards([
        { label: 'Products', value: String(report.summary.productCount), color: PDFColors.primary },
        { label: 'Avg Margin', value: `${report.summary.avgMarginPercent.toFixed(1)}%`, color: PDFColors.info },
        { label: 'Potential Profit', value: formatCurrencyPDF(report.summary.totalPotentialProfit), color: PDFColors.success },
        { label: 'Loss-Making', value: String(report.summary.negativeMarginCount), color: report.summary.negativeMarginCount > 0 ? PDFColors.danger : PDFColors.success },
      ]);

      const columns: PDFTableColumn[] = [
        { header: 'Product', key: 'productName', width: 0.22 },
        { header: 'SKU', key: 'sku', width: 0.10 },
        { header: 'Category', key: 'category', width: 0.12 },
        { header: 'Qty', key: 'qtyOnHand', width: 0.07, align: 'right' },
        { header: 'Unit Cost', key: 'unitCostFmt', width: 0.11, align: 'right' },
        { header: 'Sell Price', key: 'sellingPriceFmt', width: 0.11, align: 'right' },
        { header: 'Profit/Unit', key: 'profitFmt', width: 0.11, align: 'right' },
        { header: 'Margin %', key: 'marginFmt', width: 0.08, align: 'right' },
        { header: 'Markup %', key: 'markupFmt', width: 0.08, align: 'right' },
      ];

      gen.addTable(columns, report.rows.map((r) => ({
        ...r,
        sku: r.sku ?? '—',
        category: r.category ?? '—',
        unitCostFmt: formatCurrencyPDF(r.unitCost),
        sellingPriceFmt: formatCurrencyPDF(r.sellingPrice),
        profitFmt: formatCurrencyPDF(r.profitPerUnit),
        marginFmt: `${r.marginPercent.toFixed(1)}%`,
        markupFmt: `${r.markupPercent.toFixed(1)}%`,
      })));

      gen.end();
      return;
    }

    res.json({ success: true, data: report });
  },

  async getStoreIssues(req: Request, res: Response, pool: Pool) {
    const report = await generateStoreIssueAudit(pool, {
      startDate: queryString(req, 'startDate'),
      endDate: queryString(req, 'endDate'),
      movement: queryString(req, 'movement'),
      search: queryString(req, 'search'),
    });

    if (isPdf(req)) {
      const company = await getCompanyName(pool);
      const gen = new ReportPDFGenerator(company);
      const doc = gen.getDocument();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="store-issue-audit-${report.startDate}-${report.endDate}.pdf"`,
      );
      doc.pipe(res);

      gen.addHeader({
        companyName: company,
        title: 'Store Issue Audit',
        subtitle: `${report.startDate} to ${report.endDate}`,
        generatedAt: now(),
      });

      gen.addSummaryCards([
        { label: 'Issued', value: formatCurrencyPDF(report.totals.issuedAmount), color: PDFColors.primary },
        {
          label: 'Reversed',
          value: formatCurrencyPDF(report.totals.reversedAmount),
          color: PDFColors.warning,
        },
        { label: 'Net', value: formatCurrencyPDF(report.totals.netAmount), color: PDFColors.success },
        {
          label: 'Reverse rate',
          value: `${(report.totals.reverseRate * 100).toFixed(1)}%`,
          color: report.totals.reverseRate >= STORE_ISSUE_REVERSE_RATE_WATCH ? PDFColors.danger : PDFColors.info,
        },
      ]);

      const columns: PDFTableColumn[] = [
        { header: 'Date', key: 'postingDate', width: 0.10 },
        { header: 'Document', key: 'documentNumber', width: 0.14 },
        { header: 'Movement', key: 'movementLabel', width: 0.10 },
        { header: 'Product', key: 'productName', width: 0.20 },
        { header: 'Qty', key: 'qtyFmt', width: 0.12, align: 'right' },
        { header: 'Amount', key: 'amountFmt', width: 0.12, align: 'right' },
        { header: 'Posted by', key: 'postedByName', width: 0.12 },
        { header: 'Reason', key: 'reversalReason', width: 0.10 },
      ];

      gen.addTable(
        columns,
        report.rows.map((r) => ({
          ...r,
          movementLabel: storeIssueAuditMovementLabel(r.movementType),
          qtyFmt: formatQtyWithUom(r.quantity, r.uomName),
          amountFmt: formatCurrencyPDF(r.amount),
          postedByName: r.postedByName ?? '—',
          reversalReason: r.reversalReason ?? '—',
        })),
      );

      gen.end();
      return;
    }

    res.json({ success: true, data: report });
  },
};
