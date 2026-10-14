/**
 * Centralized AR open-item allocation calculations (SAP/Odoo SSOT).
 * All services MUST use this module — no duplicate reconciliation math.
 */

import type { Pool, PoolClient } from 'pg';
import Decimal from 'decimal.js';
import { Money } from '../../utils/money.js';
import logger from '../../utils/logger.js';
import { invoiceRepository } from '../invoices/invoiceRepository.js';
import { AR_OPEN_DOCUMENT_TYPE_IN_SQL } from '../customer-payments/arReconciliationEngine.js';

/** Pool or transaction client — query interface is identical. */
export type OpenItemDbConn = Pool | PoolClient;

export type AllocationType = 'MANUAL' | 'FIFO' | 'EXACT' | 'DUE_DATE';

export interface OpenInvoiceRow {
  id: string;
  invoiceNumber: string;
  issueDate: string;
  dueDate: string;
  totalAmount: number;
  amountDue: number;
  status: string;
  documentType: string;
}

export interface AllocationLineInput {
  invoiceId: string;
  amount: number;
}

export interface PaymentLedger {
  paymentId: string;
  totalAmount: Decimal;
  allocatedAmount: Decimal;
  unallocatedAmount: Decimal;
  status: string;
}

export async function getPaymentLedger(
  client: PoolClient,
  paymentId: string,
): Promise<PaymentLedger | null> {
  const res = await client.query(
    `SELECT id, total_amount, allocated_amount, unallocated_amount, status
     FROM ar_customer_payments WHERE id = $1`,
    [paymentId],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    paymentId: row.id as string,
    totalAmount: Money.parseDb(row.total_amount),
    allocatedAmount: Money.parseDb(row.allocated_amount),
    unallocatedAmount: Money.parseDb(row.unallocated_amount),
    status: String(row.status),
  };
}

export async function getInvoiceOpenBalance(
  client: PoolClient,
  invoiceId: string,
): Promise<Decimal> {
  const settlement = await invoiceRepository.getInvoiceSettlement(client, invoiceId);
  if (!settlement) return new Decimal(0);
  return Money.parseDb(settlement.amountDue);
}

export async function listOpenInvoicesForCustomer(
  client: PoolClient,
  customerId: string,
): Promise<OpenInvoiceRow[]> {
  const res = await client.query(
    `SELECT id, invoice_number, issue_date, due_date, total_amount, amount_due, status,
            COALESCE(document_type, 'INVOICE') AS document_type
     FROM invoices
     WHERE customer_id = $1
       AND COALESCE(document_type, 'INVOICE') IN (${AR_OPEN_DOCUMENT_TYPE_IN_SQL})
       AND status NOT IN ('CANCELLED', 'VOIDED', 'DRAFT')
       AND amount_due > 0.009
     ORDER BY due_date ASC NULLS LAST, issue_date ASC`,
    [customerId],
  );
  return res.rows.map((r) => ({
    id: r.id as string,
    invoiceNumber: r.invoice_number as string,
    issueDate: String(r.issue_date).slice(0, 10),
    dueDate: String(r.due_date).slice(0, 10),
    totalAmount: Money.toNumber(Money.parseDb(r.total_amount)),
    amountDue: Money.toNumber(Money.parseDb(r.amount_due)),
    status: String(r.status),
    documentType: String(r.document_type),
  }));
}

export function validateAllocationLines(params: {
  paymentUnallocated: Decimal;
  lines: AllocationLineInput[];
  invoiceOpenById: Map<string, Decimal>;
  customerId: string;
  invoiceCustomerById: Map<string, string>;
  invoiceStatusById: Map<string, string>;
}): void {
  const { paymentUnallocated, lines, invoiceOpenById, invoiceCustomerById, invoiceStatusById } =
    params;

  if (!lines.length) {
    throw new Error('At least one allocation line is required');
  }

  let totalAlloc = new Decimal(0);
  const seen = new Set<string>();

  for (const line of lines) {
    if (seen.has(line.invoiceId)) {
      throw new Error('Duplicate invoice in allocation batch');
    }
    seen.add(line.invoiceId);

    const amt = new Decimal(line.amount);
    if (amt.lessThanOrEqualTo(0)) {
      throw new Error('Allocation amount must be positive');
    }

    const invCustomer = invoiceCustomerById.get(line.invoiceId);
    if (!invCustomer) {
      throw new Error(`Invoice ${line.invoiceId} not found`);
    }
    if (invCustomer !== params.customerId) {
      throw new Error('Cannot allocate across different customers');
    }

    const st = invoiceStatusById.get(line.invoiceId) ?? '';
    if (['CANCELLED', 'VOIDED', 'DRAFT'].includes(st)) {
      throw new Error(`Cannot allocate to invoice with status ${st}`);
    }

    const open = invoiceOpenById.get(line.invoiceId) ?? new Decimal(0);
    if (amt.greaterThan(open.plus(0.009))) {
      throw new Error(
        `Allocation ${amt.toFixed(2)} exceeds invoice open balance ${open.toFixed(2)}`,
      );
    }

    totalAlloc = totalAlloc.plus(amt);
  }

  if (totalAlloc.greaterThan(paymentUnallocated.plus(0.009))) {
    throw new Error(
      `Total allocation ${totalAlloc.toFixed(2)} exceeds unallocated payment ${paymentUnallocated.toFixed(2)}`,
    );
  }
}

export function buildFifoAllocations(
  openInvoices: OpenInvoiceRow[],
  unallocated: Decimal,
): AllocationLineInput[] {
  const lines: AllocationLineInput[] = [];
  let remaining = unallocated;
  for (const inv of openInvoices) {
    if (remaining.lessThanOrEqualTo(0.009)) break;
    const open = new Decimal(inv.amountDue);
    const alloc = Decimal.min(remaining, open);
    if (alloc.greaterThan(0)) {
      lines.push({ invoiceId: inv.id, amount: Money.toNumber(alloc) });
      remaining = remaining.minus(alloc);
    }
  }
  return lines;
}

/**
 * Customer AR balance = open invoice due − unallocated posted receipts (on-account credit).
 */
export async function syncCustomerBalanceFromOpenItems(
  conn: OpenItemDbConn,
  customerId: string,
  changeSource: string,
): Promise<{ oldBalance: number; newBalance: number }> {
  const balanceUpdate = await conn.query(
    `WITH old AS (SELECT balance, name FROM customers WHERE id = $1),
     open_inv AS (
       SELECT COALESCE(SUM(amount_due), 0) AS due
       FROM invoices
       WHERE customer_id = $1
         AND COALESCE(document_type, 'INVOICE') IN (${AR_OPEN_DOCUMENT_TYPE_IN_SQL})
         AND status NOT IN ('CANCELLED', 'VOIDED', 'DRAFT')
     ),
     unalloc AS (
       SELECT COALESCE(SUM(unallocated_amount), 0) AS ua
       FROM ar_customer_payments
       WHERE customer_id = $1
         AND status IN ('POSTED', 'PARTIALLY_ALLOCATED', 'FULLY_ALLOCATED')
     )
     UPDATE customers SET balance = GREATEST(0, (SELECT due FROM open_inv) - (SELECT ua FROM unalloc))
     WHERE id = $1
     RETURNING balance,
               (SELECT balance FROM old) AS old_balance,
               (SELECT name FROM old) AS customer_name`,
    [customerId],
  );

  const row = balanceUpdate.rows[0];
  if (!row) {
    logger.warn('syncCustomerBalanceFromOpenItems: customer not found', { customerId, changeSource });
    return { oldBalance: 0, newBalance: 0 };
  }

  const oldBalance = Money.toNumber(Money.parseDb(row.old_balance ?? 0));
  const newBalance = Money.toNumber(Money.parseDb(row.balance ?? 0));

  if (oldBalance !== newBalance) {
    await conn.query(
      `INSERT INTO customer_balance_audit
       (customer_id, customer_name, old_balance, new_balance, change_amount, change_source)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        customerId,
        row.customer_name,
        oldBalance,
        newBalance,
        newBalance - oldBalance,
        changeSource,
      ],
    );
  }

  logger.info('Customer balance synced from open items (SSOT)', {
    customerId,
    oldBalance,
    newBalance,
    changeSource,
  });

  return { oldBalance, newBalance };
}

export async function assertArIntegrity(
  client: PoolClient,
  customerId?: string,
): Promise<{ ok: boolean; message: string }> {
  const custFilter = customerId ? 'AND c.id = $1' : '';
  const params = customerId ? [customerId] : [];
  const res = await client.query(
    `SELECT c.id, c.name, c.balance,
            COALESCE(inv.due, 0) AS invoice_due,
            COALESCE(pay.unalloc, 0) AS unallocated_payments,
            GREATEST(0, COALESCE(inv.due, 0) - COALESCE(pay.unalloc, 0)) AS expected_balance
     FROM customers c
     LEFT JOIN LATERAL (
       SELECT SUM(amount_due) AS due
       FROM invoices i
       WHERE i.customer_id = c.id
         AND COALESCE(i.document_type, 'INVOICE') IN (${AR_OPEN_DOCUMENT_TYPE_IN_SQL})
         AND i.status NOT IN ('CANCELLED', 'VOIDED', 'DRAFT')
     ) inv ON TRUE
     LEFT JOIN LATERAL (
       SELECT SUM(unallocated_amount) AS unalloc
       FROM ar_customer_payments p
       WHERE p.customer_id = c.id
         AND p.status IN ('POSTED', 'PARTIALLY_ALLOCATED', 'FULLY_ALLOCATED')
     ) pay ON TRUE
     WHERE c.is_active = true ${custFilter}`,
    params,
  );

  for (const row of res.rows) {
    const stored = Money.toNumber(Money.parseDb(row.balance));
    const expected = Money.toNumber(Money.parseDb(row.expected_balance));
    if (Math.abs(stored - expected) > 0.02) {
      return {
        ok: false,
        message: `Customer ${row.name}: balance ${stored} != expected ${expected} (due ${row.invoice_due} − unalloc ${row.unallocated_payments})`,
      };
    }
  }
  return { ok: true, message: 'AR open-item integrity OK' };
}
