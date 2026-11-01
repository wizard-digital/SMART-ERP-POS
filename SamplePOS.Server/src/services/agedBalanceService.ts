/**
 * AGED RECEIVABLES / PAYABLES SERVICE
 *
 * Enterprise-grade aging analysis (Odoo Accounting Reports pattern).
 *
 * Integrity rules:
 *   - AR: same open-item SSOT as reports aging / customer.balance
 *     (amount_due, AR_OPEN_DOCUMENT_TYPE_IN_SQL). Uninvoiced credit sales are
 *     a separate leak — do not mix them into invoice aging.
 *   - AP: supplier invoices UNION open POs without open bill — never JOIN cartesian
 *   - Response SSOT: summary.total === grandTotal; table rows = entities (not invoice details)
 */

import type pg from 'pg';
import { pool as globalPool } from '../db/pool.js';
import { Money, Decimal } from '../utils/money.js';
import { AR_OPEN_DOCUMENT_TYPE_IN_SQL } from '../modules/customer-payments/arReconciliationEngine.js';

// =============================================================================
// TYPES
// =============================================================================

export interface AgingBucket {
  label: string;
  minDays: number;
  maxDays: number | null; // null = unbounded (90+)
}

export interface AgingLineItem {
  entityId: string;
  entityName: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  daysOverdue: number;
  originalAmount: number;
  outstandingAmount: number;
  bucket: string;
}

export interface AgingEntitySummary {
  entityId: string;
  entityName: string;
  current: number;
  days1to30: number;
  days31to60: number;
  days61to90: number;
  over90: number;
  total: number;
}

export interface AgingReportSummary {
  current: number;
  days1to30: number;
  days31to60: number;
  days61to90: number;
  over90: number;
  /** Same as grandTotal — UI/report consumer SSOT */
  total: number;
  grandTotal: number;
  entityCount: number;
}

export interface AgingReport {
  reportType: 'RECEIVABLE' | 'PAYABLE';
  asOfDate: string;
  generatedAt: string;
  buckets: AgingBucket[];
  summary: AgingReportSummary;
  /** Per customer/supplier bucket matrix (UI table) */
  entities: AgingEntitySummary[];
  /** Line-level invoices/sales (PDF detail; not the main table) */
  details: AgingLineItem[];
}

const DEFAULT_BUCKETS: AgingBucket[] = [
  { label: 'Current', minDays: 0, maxDays: 0 },
  { label: '1-30 Days', minDays: 1, maxDays: 30 },
  { label: '31-60 Days', minDays: 31, maxDays: 60 },
  { label: '61-90 Days', minDays: 61, maxDays: 90 },
  { label: '90+ Days', minDays: 91, maxDays: null },
];

// =============================================================================
// AGED RECEIVABLES / PAYABLES SERVICE
// =============================================================================

export class AgedBalanceService {
  /**
   * Aged Receivables — open AR only, no sale+invoice double count.
   */
  static async agedReceivables(
    asOfDate: string,
    dbPool?: pg.Pool
  ): Promise<AgingReport> {
    const pool = dbPool || globalPool;

    const invoiceResult = await pool.query(
      `SELECT
         COALESCE(c.id::text, i.customer_id::text, 'unknown') as entity_id,
         COALESCE(c.name, i.customer_name, 'Unknown Customer') as entity_name,
         i.invoice_number as invoice_number,
         i.issue_date::date::text as invoice_date,
         COALESCE(i.due_date, i.issue_date)::date::text as due_date,
         i.total_amount as original_amount,
         i.amount_due as outstanding_amount,
         ($1::date - COALESCE(i.due_date, i.issue_date)::date) as days_overdue
       FROM invoices i
       LEFT JOIN customers c ON c.id = i.customer_id
       WHERE COALESCE(i.document_type, 'INVOICE') IN (${AR_OPEN_DOCUMENT_TYPE_IN_SQL})
         AND UPPER(COALESCE(i.status::text, '')) NOT IN ('CANCELLED', 'PAID', 'VOIDED', 'VOID', 'DRAFT')
         AND i.amount_due > 0.009
         AND i.issue_date::date <= $1::date`,
      [asOfDate]
    );

    const unallocResult = await pool.query(
      `SELECT
         p.customer_id::text AS customer_id,
         COALESCE(SUM(p.unallocated_amount), 0) AS unallocated_credits
       FROM ar_customer_payments p
       WHERE p.status <> 'REVERSED'
         AND p.reversal_of_payment_id IS NULL
         AND p.unallocated_amount > 0.009
         AND p.payment_date <= $1::date
       GROUP BY p.customer_id`,
      [asOfDate]
    );
    const unallocByCustomer = new Map<string, number>();
    for (const row of unallocResult.rows) {
      unallocByCustomer.set(String(row.customer_id), Number(row.unallocated_credits) || 0);
    }

    const report = this.buildReport('RECEIVABLE', asOfDate, invoiceResult.rows);
    return this.applyUnallocatedCredits(report, unallocByCustomer);
  }

  /**
   * Aged Payables — open supplier bills UNION open POs (no cartesian product).
   */
  static async agedPayables(
    asOfDate: string,
    dbPool?: pg.Pool
  ): Promise<AgingReport> {
    const pool = dbPool || globalPool;

    const bills = await pool.query(
      `SELECT
         COALESCE(s."Id"::text, si."SupplierId"::text, 'unknown') as entity_id,
         COALESCE(s."CompanyName", 'Unknown Supplier') as entity_name,
         COALESCE(si."SupplierInvoiceNumber", si."InternalReferenceNumber", si."Id"::text) as invoice_number,
         si."InvoiceDate"::date::text as invoice_date,
         COALESCE(si."DueDate", si."InvoiceDate")::date::text as due_date,
         si."TotalAmount" as original_amount,
         COALESCE(si."OutstandingBalance", si."TotalAmount" - COALESCE(si."AmountPaid", 0)) as outstanding_amount,
         ($1::date - COALESCE(si."DueDate", si."InvoiceDate")::date) as days_overdue
       FROM supplier_invoices si
       LEFT JOIN suppliers s ON s."Id" = si."SupplierId"
       WHERE COALESCE(si.document_type, 'SUPPLIER_INVOICE') = 'SUPPLIER_INVOICE'
         AND si.deleted_at IS NULL
         AND COALESCE(si."Status", '') NOT IN ('PAID', 'CANCELLED', 'Cancelled', 'VOIDED', 'Voided')
         AND COALESCE(si."OutstandingBalance", si."TotalAmount" - COALESCE(si."AmountPaid", 0), 0) > 0.01
         AND si."InvoiceDate"::date <= $1::date`,
      [asOfDate]
    );

    // Unbilled PO residual only when no open SI is linked to the PO
    const pos = await pool.query(
      `SELECT
         COALESCE(s."Id"::text, po.supplier_id::text, 'unknown') as entity_id,
         COALESCE(s."CompanyName", 'Unknown Supplier') as entity_name,
         po.order_number as invoice_number,
         po.order_date::date::text as invoice_date,
         COALESCE(po.expected_delivery_date, po.order_date)::date::text as due_date,
         po.total_amount as original_amount,
         (po.total_amount - COALESCE(po.paid_amount, 0)) as outstanding_amount,
         ($1::date - COALESCE(po.expected_delivery_date, po.order_date)::date) as days_overdue
       FROM purchase_orders po
       LEFT JOIN suppliers s ON s."Id" = po.supplier_id
       WHERE po.status NOT IN ('CANCELLED', 'DRAFT')
         AND (po.total_amount - COALESCE(po.paid_amount, 0)) > 0.01
         AND po.order_date::date <= $1::date
         AND NOT EXISTS (
           SELECT 1 FROM supplier_invoices si2
           WHERE si2."PurchaseOrderId" = po.id
             AND si2.deleted_at IS NULL
             AND COALESCE(si2."Status", '') NOT IN ('PAID', 'CANCELLED', 'Cancelled', 'VOIDED', 'Voided')
         )`,
      [asOfDate]
    );

    return this.buildReport('PAYABLE', asOfDate, [...bills.rows, ...pos.rows]);
  }

  // ===========================================================================
  // PRIVATE HELPERS
  // ===========================================================================

  private static buildReport(
    reportType: 'RECEIVABLE' | 'PAYABLE',
    asOfDate: string,
    rows: Array<Record<string, unknown>>
  ): AgingReport {
    const details: AgingLineItem[] = [];
    const entityMap = new Map<string, AgingEntitySummary>();

    let totalCurrent = Money.zero();
    let total1to30 = Money.zero();
    let total31to60 = Money.zero();
    let total61to90 = Money.zero();
    let totalOver90 = Money.zero();

    for (const row of rows) {
      const daysOverdue = Math.max(0, Number(row.days_overdue) || 0);
      const outstanding = Money.parseDb(String(row.outstanding_amount || 0));
      if (outstanding.lte(0.01)) continue;

      const bucket = this.getBucketLabel(daysOverdue);
      const entityId = String(row.entity_id || 'unknown');
      const entityName = String(row.entity_name || 'Unknown');

      details.push({
        entityId,
        entityName,
        invoiceNumber: String(row.invoice_number || ''),
        invoiceDate: String(row.invoice_date || ''),
        dueDate: String(row.due_date || ''),
        daysOverdue,
        originalAmount: Money.parseDb(String(row.original_amount || 0)).toNumber(),
        outstandingAmount: outstanding.toNumber(),
        bucket,
      });

      if (!entityMap.has(entityId)) {
        entityMap.set(entityId, {
          entityId,
          entityName,
          current: 0,
          days1to30: 0,
          days31to60: 0,
          days61to90: 0,
          over90: 0,
          total: 0,
        });
      }

      const entity = entityMap.get(entityId)!;

      if (daysOverdue <= 0) {
        entity.current = Money.add(new Decimal(entity.current), outstanding).toNumber();
        totalCurrent = Money.add(totalCurrent, outstanding);
      } else if (daysOverdue <= 30) {
        entity.days1to30 = Money.add(new Decimal(entity.days1to30), outstanding).toNumber();
        total1to30 = Money.add(total1to30, outstanding);
      } else if (daysOverdue <= 60) {
        entity.days31to60 = Money.add(new Decimal(entity.days31to60), outstanding).toNumber();
        total31to60 = Money.add(total31to60, outstanding);
      } else if (daysOverdue <= 90) {
        entity.days61to90 = Money.add(new Decimal(entity.days61to90), outstanding).toNumber();
        total61to90 = Money.add(total61to90, outstanding);
      } else {
        entity.over90 = Money.add(new Decimal(entity.over90), outstanding).toNumber();
        totalOver90 = Money.add(totalOver90, outstanding);
      }

      entity.total = Money.add(new Decimal(entity.total), outstanding).toNumber();
    }

    const grandTotal = Money.add(
      Money.add(
        Money.add(totalCurrent, total1to30),
        Money.add(total31to60, total61to90)
      ),
      totalOver90
    ).toNumber();

    return {
      reportType,
      asOfDate,
      generatedAt: new Date().toISOString(),
      buckets: DEFAULT_BUCKETS,
      summary: {
        current: totalCurrent.toNumber(),
        days1to30: total1to30.toNumber(),
        days31to60: total31to60.toNumber(),
        days61to90: total61to90.toNumber(),
        over90: totalOver90.toNumber(),
        total: grandTotal,
        grandTotal,
        entityCount: entityMap.size,
      },
      entities: Array.from(entityMap.values()).sort((a, b) => b.total - a.total),
      details,
    };
  }

  /** Same as reports aging: unallocated AR receipts reduce Current, then total. */
  private static applyUnallocatedCredits(
    report: AgingReport,
    unallocByCustomer: Map<string, number>,
  ): AgingReport {
    const entities: AgingEntitySummary[] = [];
    for (const entity of report.entities) {
      const credit = Money.parseDb(unallocByCustomer.get(entity.entityId) ?? 0);
      if (credit.lte(0.009)) {
        entities.push(entity);
        continue;
      }
      const currentCut = Decimal.min(new Decimal(entity.current), credit);
      const newCurrent = Money.subtract(entity.current, currentCut).toNumber();
      const newTotal = Money.subtract(entity.total, credit);
      if (newTotal.lte(0.009)) continue;
      entities.push({
        ...entity,
        current: newCurrent,
        total: newTotal.toNumber(),
      });
    }

    const summary = entities.reduce(
      (acc, e) => ({
        current: Money.add(acc.current, e.current).toNumber(),
        days1to30: Money.add(acc.days1to30, e.days1to30).toNumber(),
        days31to60: Money.add(acc.days31to60, e.days31to60).toNumber(),
        days61to90: Money.add(acc.days61to90, e.days61to90).toNumber(),
        over90: Money.add(acc.over90, e.over90).toNumber(),
        total: Money.add(acc.total, e.total).toNumber(),
      }),
      { current: 0, days1to30: 0, days31to60: 0, days61to90: 0, over90: 0, total: 0 },
    );

    return {
      ...report,
      summary: {
        ...summary,
        grandTotal: summary.total,
        entityCount: entities.length,
      },
      entities: entities.sort((a, b) => b.total - a.total),
      details: report.details.filter((d) => entities.some((e) => e.entityId === d.entityId)),
    };
  }

  private static getBucketLabel(daysOverdue: number): string {
    if (daysOverdue <= 0) return 'Current';
    if (daysOverdue <= 30) return '1-30 Days';
    if (daysOverdue <= 60) return '31-60 Days';
    if (daysOverdue <= 90) return '61-90 Days';
    return '90+ Days';
  }
}

export default AgedBalanceService;
