import { Pool, PoolClient } from 'pg';
import { Money } from '../../utils/money.js';
import logger from '../../utils/logger.js';
import { checkAccountingPeriodOpen } from '../../utils/periodGuard.js';
import { getBusinessYear, getBusinessDate, formatDateBusiness } from '../../utils/dateRange.js';
import { snapshotQuotationReferenceDetails } from '@shared/utils/quotationReferenceDetails.js';
import { computeInvoiceSettlement } from './invoiceSettlement.js';

// Normalize snake_case database columns to InvoiceRecord
function normalizeInvoiceRow(row: Record<string, unknown>): InvoiceRecord {
  const status = String(row.status || 'UNPAID').toUpperCase();
  return {
    id: row.id as string,
    invoice_number: row.invoice_number as string,
    customer_id: row.customer_id as string,
    sale_id: (row.sale_id as string) || null,
    quote_id: (row.quote_id as string) || null,
    reference: (row.reference as string) || null,
    issue_date: row.issue_date as Date,
    due_date: row.due_date as Date,
    status: status === 'PAID' ? 'PAID' : status === 'PARTIALLY_PAID' ? 'PARTIALLY_PAID' : 'UNPAID',
    subtotal: row.subtotal as number,
    tax_amount: row.tax_amount as number,
    total_amount: row.total_amount as number,
    amount_paid: row.amount_paid as number,
    balance: row.amount_due as number,
    document_type: (row.document_type as string) || 'INVOICE',
    notes: (row.notes as string) || null,
    created_by_id: (row.created_by_id as string) || null,
    created_at: row.created_at as Date,
    updated_at: row.updated_at as Date,
  };
}

export interface InvoiceRecord {
  id: string;
  invoice_number: string;
  customer_id: string;
  sale_id: string | null;
  quote_id: string | null;
  reference: string | null;
  issue_date: Date;
  due_date: Date | null;
  status: 'UNPAID' | 'PARTIALLY_PAID' | 'PAID' | 'CANCELLED';
  payment_method?: 'CASH' | 'CARD' | 'MOBILE_MONEY' | 'AIRTEL_MONEY' | 'BANK_TRANSFER' | 'CREDIT' | 'DEPOSIT' | null;
  subtotal: number;
  tax_amount: number;
  total_amount: number;
  amount_paid: number;
  balance: number;
  document_type?: string;
  notes: string | null;
  created_by_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface InvoicePaymentRecord {
  id: string;
  receipt_number: string;
  invoice_id: string;
  payment_date: Date;
  payment_method: 'CASH' | 'CARD' | 'MOBILE_MONEY' | 'AIRTEL_MONEY' | 'BANK_TRANSFER' | 'CREDIT' | 'DEPOSIT';
  amount: number;
  reference_number: string | null;
  notes: string | null;
  processed_by_id: string | null;
  created_at: Date;
}

export const invoiceRepository = {
  async findBySaleId(pool: Pool | PoolClient, saleId: string): Promise<InvoiceRecord | null> {
    const res = await pool.query('SELECT * FROM invoices WHERE sale_id = $1 LIMIT 1', [saleId]);
    return res.rows[0] ? normalizeInvoiceRow(res.rows[0]) : null;
  },
  async generateInvoiceNumber(pool: Pool | PoolClient): Promise<string> {
    const year = getBusinessYear();
    // Advisory lock prevents concurrent duplicate invoice number generation
    // NOTE: Only fully effective when caller wraps in a transaction (passes client as pool)
    await pool.query(`SELECT pg_advisory_xact_lock(hashtext('invoice_number_seq'))`);
    const result = await pool.query(
      `SELECT invoice_number FROM invoices 
       WHERE invoice_number LIKE $1 
       ORDER BY invoice_number DESC 
       LIMIT 1`,
      [`INV-${year}-%`]
    );

    if (result.rows.length === 0) {
      return `INV-${year}-0001`;
    }

    const last = result.rows[0].invoice_number as string;
    const seq = parseInt(last.split('-')[2]) + 1;
    return `INV-${year}-${seq.toString().padStart(4, '0')}`;
  },

  async generateReceiptNumber(pool: Pool | PoolClient): Promise<string> {
    const year = getBusinessYear();
    // Advisory lock prevents concurrent duplicate receipt number generation
    // NOTE: Only fully effective when caller wraps in a transaction (passes client as pool)
    await pool.query(`SELECT pg_advisory_xact_lock(hashtext('receipt_number_seq'))`);
    const result = await pool.query(
      `SELECT receipt_number FROM invoice_payments 
       WHERE receipt_number LIKE $1 
       ORDER BY receipt_number DESC 
       LIMIT 1`,
      [`RCPT-${year}-%`]
    );

    if (result.rows.length === 0) {
      return `RCPT-${year}-0001`;
    }

    const last = result.rows[0].receipt_number as string;
    const seq = parseInt(last.split('-')[2]) + 1;
    return `RCPT-${year}-${seq.toString().padStart(4, '0')}`;
  },

  async createInvoice(
    pool: Pool | PoolClient,
    data: {
      customerId: string;
      customerName: string;
      saleId?: string | null;
      quoteId?: string | null;
      reference?: string | null;
      issueDate?: string | Date | null;
      dueDate?: string | Date | null;
      subtotal: number;
      taxAmount: number;
      totalAmount: number;
      notes?: string | null;
      createdById?: string | null;
    }
  ): Promise<InvoiceRecord> {
    const invoiceNumber = await this.generateInvoiceNumber(pool);

    const now = new Date();

    let reference = data.reference ?? null;
    if (data.quoteId && reference == null) {
      const quoteRow = await pool.query(
        'SELECT reference, description FROM quotations WHERE id = $1',
        [data.quoteId],
      );
      if (quoteRow.rows[0]) {
        reference = snapshotQuotationReferenceDetails(
          quoteRow.rows[0].reference as string | null,
          quoteRow.rows[0].description as string | null,
        );
      }
    }

    const result = await pool.query(
      `INSERT INTO invoices (
        id, invoice_number, customer_id, customer_name, sale_id, quote_id, reference,
        issue_date, due_date,
        subtotal, tax_amount, total_amount, amount_paid, amount_due,
        notes, status, payment_terms, created_by_id, created_at, updated_at
      ) VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,0,$11,$12,'DRAFT',30,$13,$14,$14)
      RETURNING *`,
      [
        invoiceNumber,
        data.customerId,
        data.customerName,
        data.saleId || null,
        data.quoteId || null,
        reference,
        data.issueDate || getBusinessDate(),
        data.dueDate || (() => { const d = new Date(getBusinessDate() + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 30); return formatDateBusiness(d); })(),
        data.subtotal,
        data.taxAmount,
        data.totalAmount,
        data.notes || null,
        data.createdById || null,
        now,
      ]
    );
    const invoice = normalizeInvoiceRow(result.rows[0]);
    if (data.saleId) {
      await this.copySaleItemsAsInvoiceLines(pool, invoice.id, data.saleId);
    }
    return invoice;
  },

  /**
   * Phase 8a — Materialize invoice_line_items from sale_items DocumentTax snapshot.
   * Enables remittance boxes to prefer invoice lines (Phase 7 NOT EXISTS guard).
   * Idempotent: no-op if lines already exist for this invoice.
   */
  async copySaleItemsAsInvoiceLines(
    pool: Pool | PoolClient,
    invoiceId: string,
    saleId: string,
  ): Promise<number> {
    const existing = await pool.query(
      `SELECT 1 FROM invoice_line_items WHERE "InvoiceId" = $1 LIMIT 1`,
      [invoiceId],
    );
    if (existing.rows.length > 0) {
      return 0;
    }

    const result = await pool.query(
      `INSERT INTO invoice_line_items (
         "Id", "InvoiceId", "LineNumber", "ProductId", "ProductName",
         "Description", "Quantity", "UnitOfMeasure", "UnitPrice", "LineTotal",
         "TaxRate", "TaxAmount", "LineTotalIncludingTax"
       )
       SELECT
         gen_random_uuid(),
         $1::uuid,
         ROW_NUMBER() OVER (ORDER BY si.created_at NULLS LAST, si.id),
         COALESCE(si.product_id::text, ''),
         COALESCE(si.product_name, 'Item'),
         NULL,
         si.quantity,
         'EA',
         si.unit_price,
         si.total_price,
         COALESCE(si.tax_rate, 0),
         COALESCE(si.tax_amount, 0),
         COALESCE(si.total_price, 0) + COALESCE(si.tax_amount, 0)
       FROM sale_items si
       WHERE si.sale_id = $2::uuid
       RETURNING "Id"`,
      [invoiceId, saleId],
    );

    const integrity = await pool.query(
      `SELECT
         COALESCE(s.tax_amount, 0)::numeric AS sale_tax,
         COALESCE(SUM(si.tax_amount), 0)::numeric AS line_tax
       FROM sales s
       LEFT JOIN sale_items si ON si.sale_id = s.id
       WHERE s.id = $1::uuid
       GROUP BY s.tax_amount`,
      [saleId],
    );
    const saleTax = Number(integrity.rows[0]?.sale_tax ?? 0);
    const lineTax = Number(integrity.rows[0]?.line_tax ?? 0);
    if (saleTax > 0.009 && lineTax < 0.009) {
      throw new Error(
        `Cannot copy sale ${saleId} to invoice ${invoiceId}: sales.tax_amount=${saleTax} but sale_items tax sum is 0`,
      );
    }

    const count = result.rowCount ?? result.rows.length;
    if (count > 0) {
      logger.info('Copied sale_items → invoice_line_items (DocumentTax)', {
        invoiceId,
        saleId,
        lineCount: count,
      });
    }
    return count;
  },

  /**
   * Create invoice from sale (for quote conversion)
   */
  async createInvoiceFromSale(
    pool: Pool | PoolClient,
    data: {
      saleId: string;
      saleNumber: string;
      customerId: string;
      customerName: string;
      totalAmount: number;
      quoteId?: string | null;
    }
  ): Promise<InvoiceRecord> {
    const invoiceNumber = await this.generateInvoiceNumber(pool);

    const now = new Date();

    const saleTotals = await pool.query(
      `SELECT subtotal, tax_amount, total_amount
       FROM sales WHERE id = $1::uuid`,
      [data.saleId],
    );
    const saleRow = saleTotals.rows[0];
    const saleSubtotal = saleRow ? Number(saleRow.subtotal ?? 0) : data.totalAmount;
    const saleTax = saleRow ? Number(saleRow.tax_amount ?? 0) : 0;
    const saleTotal = saleRow
      ? Number(saleRow.total_amount ?? data.totalAmount)
      : data.totalAmount;

    const result = await pool.query(
      `INSERT INTO invoices (
        id, invoice_number, customer_id, customer_name, sale_id, issue_date, due_date,
        subtotal, tax_amount, total_amount, amount_paid, amount_due, 
        notes, status, payment_terms, created_at, updated_at
      ) VALUES (gen_random_uuid(),$1,$2,$3,$4,NOW(),NOW() + INTERVAL '30 days',
                $5, $6, $7, 0, $7, $8, 'DRAFT', 30, $9, $9)
      RETURNING *`,
      [
        invoiceNumber,
        data.customerId,
        data.customerName,
        data.saleId,
        saleSubtotal,
        saleTax,
        saleTotal,
        `Invoice for sale ${data.saleNumber}`,
        now,
      ]
    );
    const invoice = normalizeInvoiceRow(result.rows[0]);
    await this.copySaleItemsAsInvoiceLines(pool, invoice.id, data.saleId);
    return invoice;
  },

  async getInvoiceById(pool: Pool | PoolClient, id: string): Promise<InvoiceRecord | null> {
    const result = await pool.query(
      `SELECT i.* FROM invoices i 
       WHERE i.id = $1`,
      [id]
    );

    if (!result.rows[0]) return null;
    return normalizeInvoiceRow(result.rows[0]);
  },

  async listInvoices(
    pool: Pool | PoolClient,
    page: number,
    limit: number,
    filters?: { customerId?: string; status?: string }
  ): Promise<{ invoices: InvoiceRecord[]; total: number }> {
    const offset = (page - 1) * limit;
    const where: string[] = [`i.status NOT IN ('CANCELLED', 'DRAFT', 'VOIDED')`];
    const values: unknown[] = [];
    let idx = 1;

    if (filters?.customerId) {
      where.push(`i.customer_id = $${idx++}`);
      values.push(filters.customerId);
      // Customer AR list = sales + opening balance; CNs live in credit-debit-notes API
      where.push(`COALESCE(i.document_type, 'INVOICE') IN ('INVOICE', 'OPENING_BALANCE')`);
    }
    if (filters?.status) {
      if (filters.status === 'OVERDUE') {
        where.push(`i.due_date < CURRENT_DATE`);
        where.push(`i.amount_due > 0`);
        where.push(`i.status NOT IN ('PAID')`);
      } else {
        where.push(`i.status = $${idx++}`);
        values.push(filters.status);
      }
    }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const countRes = await pool.query(`SELECT COUNT(*) FROM invoices i ${whereClause}`, values);
    const res = await pool.query(
      `SELECT i.* FROM invoices i 
       ${whereClause} 
       ORDER BY i.created_at DESC 
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...values, limit, offset]
    );

    let invoices = res.rows.map(normalizeInvoiceRow);
    if (filters?.customerId) {
      const healed: InvoiceRecord[] = [];
      for (const invoice of invoices) {
        const fresh = await this.healSettlementDrift(pool, invoice.id);
        healed.push(fresh ?? invoice);
      }
      invoices = healed;
    }

    return {
      invoices,
      total: parseInt(countRes.rows[0].count)
    };
  },

  async addPayment(
    pool: Pool | PoolClient,
    data: {
      invoiceId: string;
      amount: number;
      paymentMethod: 'CASH' | 'CARD' | 'MOBILE_MONEY' | 'AIRTEL_MONEY' | 'BANK_TRANSFER' | 'CREDIT' | 'DEPOSIT';
      paymentDate?: Date | string | null;
      referenceNumber?: string | null;
      notes?: string | null;
      processedById?: string | null;
    }
  ): Promise<InvoicePaymentRecord> {
    const receiptNumber = await this.generateReceiptNumber(pool);

    // Period enforcement (replaces trg_enforce_period_invoice_payments)
    const periodDate = typeof data.paymentDate === 'string'
      ? data.paymentDate
      : (data.paymentDate ? formatDateBusiness(data.paymentDate instanceof Date ? data.paymentDate : new Date(data.paymentDate)) : getBusinessDate());
    await checkAccountingPeriodOpen(pool, periodDate);

    // invoice_payments table has lowercase columns with uuid_generate_v4() default for id
    const res = await pool.query(
      `INSERT INTO invoice_payments (
        receipt_number, invoice_id, payment_date, payment_method, amount, reference_number, notes, processed_by_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *`,
      [
        receiptNumber,
        data.invoiceId,
        data.paymentDate || new Date(),
        data.paymentMethod,
        data.amount,
        data.referenceNumber || null,
        data.notes || null,
        data.processedById || null,
      ]
    );
    return res.rows[0];
  },

  async listPayments(pool: Pool | PoolClient, invoiceId: string, limit = 200): Promise<InvoicePaymentRecord[]> {
    const res = await pool.query(
      'SELECT * FROM invoice_payments WHERE invoice_id = $1 ORDER BY created_at ASC LIMIT $2',
      [invoiceId, limit]
    );
    return res.rows;
  },

  /**
   * Settlement on an invoice: cash, posted credit/debit notes, write-offs,
 * and completed returns on the linked sale.
 * The sale header can be rewritten from CREDIT to CASH once the invoice reaches
 * zero, so the return is tied to the sale, not to the current payment method.
 */
  async getInvoiceSettlement(
    pool: Pool | PoolClient,
    invoiceId: string,
  ): Promise<{ totalAmount: number; amountPaid: number; amountDue: number } | null> {
    const res = await pool.query(
      `SELECT
         i.total_amount,
         COALESCE(pay.cash_paid, 0) AS cash_paid,
         COALESCE(cn.cn_amount, 0) AS cn_amount,
         COALESCE(dn.dn_amount, 0) AS dn_amount,
         COALESCE(wo.writeoff_amount, 0) AS writeoff_amount,
         COALESCE(rf.refund_amount, 0) AS sale_refund_amount
       FROM invoices i
       LEFT JOIN (
         SELECT ip.invoice_id, SUM(ip.amount) AS cash_paid
         FROM invoice_payments ip
         WHERE ip.invoice_id = $1
           AND (
             NOT EXISTS (
               SELECT 1 FROM ar_payment_allocations a
               WHERE a.invoice_payment_id = ip.id
             )
             OR EXISTS (
               SELECT 1 FROM ar_payment_allocations a
               WHERE a.invoice_payment_id = ip.id
                 AND a.status = 'ACTIVE'
             )
           )
         GROUP BY ip.invoice_id
       ) pay ON pay.invoice_id = i.id
       LEFT JOIN (
         SELECT reference_invoice_id, SUM(total_amount) AS cn_amount
         FROM invoices
         WHERE reference_invoice_id = $1
           AND document_type = 'CREDIT_NOTE'
           AND status = 'POSTED'
         GROUP BY reference_invoice_id
       ) cn ON cn.reference_invoice_id = i.id
       LEFT JOIN (
         SELECT reference_invoice_id, SUM(total_amount) AS dn_amount
         FROM invoices
         WHERE reference_invoice_id = $1
           AND document_type = 'DEBIT_NOTE'
           AND status = 'POSTED'
         GROUP BY reference_invoice_id
       ) dn ON dn.reference_invoice_id = i.id
       LEFT JOIN (
         SELECT l.invoice_id, SUM(l.writeoff_amount) AS writeoff_amount
         FROM ar_writeoff_lines l
         JOIN ar_writeoff_documents d ON d.id = l.writeoff_document_id
         WHERE l.invoice_id = $1
           AND d.status = 'POSTED'
           AND d.reversed_by_document_id IS NULL
           AND d.reverses_document_id IS NULL
         GROUP BY l.invoice_id
       ) wo ON wo.invoice_id = i.id
       LEFT JOIN (
         SELECT r.sale_id, SUM(r.total_amount) AS refund_amount
         FROM sale_refunds r
         WHERE r.status = 'COMPLETED'
         GROUP BY r.sale_id
       ) rf ON rf.sale_id = i.sale_id
       WHERE i.id = $1`,
      [invoiceId],
    );
    if (!res.rows[0]) return null;

    return computeInvoiceSettlement({
      totalAmount: res.rows[0].total_amount,
      cashPaid: res.rows[0].cash_paid,
      creditNoteAmount: res.rows[0].cn_amount,
      debitNoteAmount: res.rows[0].dn_amount,
      writeoffAmount: res.rows[0].writeoff_amount,
      creditSaleRefundAmount: res.rows[0].sale_refund_amount,
    });
  },

  /**
   * Rewrite amount_due when stored settlement has drifted from the formula.
   * Returns the fresh invoice when a write happened.
   */
  async healSettlementDrift(
    pool: Pool | PoolClient,
    invoiceId: string,
  ): Promise<InvoiceRecord | null> {
    const current = await this.getInvoiceById(pool, invoiceId);
    if (!current) return null;
    const settlement = await this.getInvoiceSettlement(pool, invoiceId);
    if (!settlement) return current;
    const paidDrift = Math.abs(Number(current.amount_paid || 0) - settlement.amountPaid);
    const dueDrift = Math.abs(Number(current.balance || 0) - settlement.amountDue);
    if (paidDrift <= 0.009 && dueDrift <= 0.009) return current;
    const fresh = await this.recalcInvoice(pool, invoiceId);
    if (fresh?.customer_id) {
      const { syncCustomerBalanceFromInvoices } = await import('../../utils/customerBalanceSync.js');
      await syncCustomerBalanceFromInvoices(pool, fresh.customer_id, 'INVOICE_SETTLEMENT_HEAL');
    }
    return fresh;
  },

  /**
   * Keep linked credit sale amount_paid in sync with invoice settlement (cash + credit notes).
   */
  async syncLinkedSaleFromInvoice(pool: Pool | PoolClient, invoiceId: string): Promise<void> {
    const res = await pool.query(
      `SELECT sale_id, total_amount, amount_paid, amount_due
       FROM invoices WHERE id = $1`,
      [invoiceId],
    );
    const row = res.rows[0] as {
      sale_id?: string | null;
      total_amount?: string | number;
      amount_paid?: string | number;
      amount_due?: string | number;
    } | undefined;
    if (!row?.sale_id) return;

    const totalDec = Money.parseDb(row.total_amount ?? 0);
    const paidDec = Money.parseDb(row.amount_paid ?? 0);
    const dueDec = Money.parseDb(row.amount_due ?? 0);
    const isFullySettled = dueDec.lte(0) && paidDec.greaterThan(0);

    const saleRes = await pool.query(
      'SELECT payment_method FROM sales WHERE id = $1',
      [row.sale_id],
    );
    const currentMethod = saleRes.rows[0]?.payment_method as string | undefined;
    const newPaymentMethod =
      isFullySettled && currentMethod === 'CREDIT' ? 'CASH' : currentMethod;

    await pool.query(
      `UPDATE sales
       SET amount_paid = $1::numeric,
           payment_method = COALESCE($2::payment_method, payment_method)
       WHERE id = $3`,
      [Money.toNumber(paidDec), newPaymentMethod ?? null, row.sale_id],
    );

    logger.info('Linked sale synced from invoice settlement', {
      invoiceId,
      saleId: row.sale_id,
      amountPaid: Money.toNumber(paidDec),
      amountDue: Money.toNumber(dueDec),
      totalAmount: Money.toNumber(totalDec),
      paymentMethod: newPaymentMethod ?? currentMethod,
    });
  },

  /**
   * Recalculate and persist aggregate payment metrics & status for an invoice.
   * Includes posted credit/debit notes linked via reference_invoice_id (not only cash payments).
   */
  async recalcInvoice(pool: Pool | PoolClient, invoiceId: string): Promise<InvoiceRecord | null> {
    const settlement = await this.getInvoiceSettlement(pool, invoiceId);
    if (!settlement) return null;

    const { amountPaid, amountDue } = settlement;
    const updated = await pool.query(
      `UPDATE invoices
         SET amount_paid = $1::numeric,
             amount_due = $2::numeric,
             status = (
                        CASE
                          WHEN $2::numeric = 0 AND $1::numeric > 0 THEN 'PAID'::invoice_status
                          WHEN $2::numeric > 0 AND $1::numeric > 0 THEN 'PARTIALLY_PAID'::invoice_status
                          ELSE 'UNPAID'::invoice_status
                        END
                      ),
             updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [amountPaid, amountDue, invoiceId],
    );
    if (!updated.rows[0]) return null;

    await this.syncLinkedSaleFromInvoice(pool, invoiceId);
    return normalizeInvoiceRow(updated.rows[0]);
  },
};
