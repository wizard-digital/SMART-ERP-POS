// Customers Repository - Database Layer
// Contains ONLY SQL queries - NO business logic

import { pool as globalPool } from '../../db/pool.js';
import type pg from 'pg';
import type { Customer, CreateCustomer, UpdateCustomer } from '../../../../shared/zod/customer.js';
import { assertRowUpdated } from '../../utils/optimisticUpdate.js';
import { NotFoundError } from '../../middleware/errorHandler.js';
import { toUtcRange, BUSINESS_TIMEZONE, formatDateBusiness } from '../../utils/dateRange.js';
import {
  pickSortColumn,
  sqlSortOrder,
  type EnterpriseListQuery,
} from '../../utils/enterpriseListQuery.js';
import { AR_OPEN_DOCUMENT_TYPE_IN_SQL } from '../customer-payments/arReconciliationEngine.js';

export type CustomerListQuery = EnterpriseListQuery;

/**
 * Open-item AR for list/center UI — same formula as syncCustomerBalanceFromOpenItems:
 * GREATEST(0, open invoice amount_due − unallocated posted receipts).
 * Computes live so overview/list is accurate even when customers.balance is stale.
 */
export const CUSTOMER_OPEN_AR_SQL = `GREATEST(0,
      COALESCE((
        SELECT SUM(i.amount_due)
        FROM invoices i
        WHERE i.customer_id = c.id
          AND COALESCE(i.document_type, 'INVOICE') IN (${AR_OPEN_DOCUMENT_TYPE_IN_SQL})
          AND i.status NOT IN ('CANCELLED', 'VOIDED', 'DRAFT')
      ), 0)
      - COALESCE((
        SELECT SUM(p.unallocated_amount)
        FROM ar_customer_payments p
        WHERE p.customer_id = c.id
          AND p.status IN ('POSTED', 'PARTIALLY_ALLOCATED', 'FULLY_ALLOCATED')
      ), 0)
    )`;

const CUSTOMER_FROM_JOIN = `
    FROM customers c
    LEFT JOIN price_groups pg ON pg.id = c.price_group_id
    LEFT JOIN LATERAL (
      SELECT SUM(amount_available) as available_balance
      FROM pos_customer_deposits
      WHERE customer_id = c.id AND status = 'ACTIVE'
    ) dep ON true`;

const CUSTOMER_SELECT = `
      c.id, c.customer_number as "customerNumber", c.name, c.email, c.phone, c.address,
      c.customer_group_id as "customerGroupId",
      c.price_group_id as "priceGroupId",
      pg.pricing_mode as "pricingMode",
      ${CUSTOMER_OPEN_AR_SQL}::float8 as "balance",
      c.credit_limit as "creditLimit",
      COALESCE(c.unlimited_credit, false) as "unlimitedCredit",
      COALESCE(c.wht_liable, false) as "whtLiable",
      c.default_wht_type_id as "defaultWhtTypeId",
      COALESCE(c.vat_registered, false) as "vatRegistered",
      c.tin,
      COALESCE(c.tax_profile, 'STANDARD') as "taxProfile",
      c.default_vat_rate::float8 as "defaultVatRate",
      c.vat_registration_date::text as "vatRegistrationDate",
      c.tax_effective_from::text as "taxEffectiveFrom",
      COALESCE(c.tax_exempt, false) as "taxExempt",
      COALESCE(c.allow_tax_override, false) as "allowTaxOverride",
      c.is_active as "isActive",
      c.created_at as "createdAt",
      c.updated_at as "updatedAt",
      c.version,
      COALESCE(dep.available_balance, 0) as "depositBalance"`;

const CUSTOMER_SORT_COLUMNS: Record<string, string> = {
  name: 'c.name',
  contact: "LOWER(COALESCE(c.email, '') || ' ' || COALESCE(c.phone, ''))",
  balance: CUSTOMER_OPEN_AR_SQL,
  deposits: 'COALESCE(dep.available_balance, 0)',
  creditLimit: 'c.credit_limit',
  status: 'c.is_active',
  createdAt: 'c.created_at',
};

function buildCustomerListClauses(query: CustomerListQuery = {}) {
  const params: unknown[] = [];
  const conditions: string[] = ['c.is_active = true'];
  let paramIndex = 1;

  if (query.search?.trim()) {
    params.push(`%${query.search.trim()}%`);
    conditions.push(
      `(c.name ILIKE $${paramIndex} OR c.email ILIKE $${paramIndex} OR c.phone ILIKE $${paramIndex} OR c.customer_number ILIKE $${paramIndex})`,
    );
    paramIndex++;
  }

  if (query.outstandingOnly || (query.balanceGt != null && query.balanceGt > 0)) {
    conditions.push(`(${CUSTOMER_OPEN_AR_SQL}) > 0.009`);
  }

  let orderBy: string;
  if (query.sortBy === 'balance') {
    orderBy = `(${CUSTOMER_OPEN_AR_SQL}) ${sqlSortOrder(query.sortOrder ?? 'desc')}, c.name ASC`;
  } else {
    const col = pickSortColumn(query.sortBy, CUSTOMER_SORT_COLUMNS, 'name');
    orderBy = `${col} ${sqlSortOrder(query.sortOrder ?? 'asc')}, c.name ASC`;
  }

  return { whereClause: conditions.join(' AND '), params, orderBy, nextParamIndex: paramIndex };
}

export async function findAllCustomers(
  limit: number = 50,
  offset: number = 0,
  dbPool?: pg.Pool,
  query: CustomerListQuery = {},
): Promise<Customer[]> {
  const pool = dbPool || globalPool;
  const { whereClause, params, orderBy, nextParamIndex } = buildCustomerListClauses(query);
  const limitParam = `$${nextParamIndex}`;
  const offsetParam = `$${nextParamIndex + 1}`;

  const result = await pool.query(
    `SELECT ${CUSTOMER_SELECT}
    ${CUSTOMER_FROM_JOIN}
    WHERE ${whereClause}
    ORDER BY ${orderBy}
    LIMIT ${limitParam} OFFSET ${offsetParam}`,
    [...params, limit, offset],
  );

  return result.rows;
}

export async function findCustomerById(id: string, dbPool?: pg.Pool | pg.PoolClient): Promise<Customer | null> {
  const pool = dbPool || globalPool;
  const result = await pool.query(
    `SELECT ${CUSTOMER_SELECT}
     ${CUSTOMER_FROM_JOIN}
     WHERE c.id = $1`,
    [id]
  );

  return result.rows[0] || null;
}

export async function findCustomerByEmail(email: string, dbPool?: pg.Pool | pg.PoolClient): Promise<Customer | null> {
  const pool = dbPool || globalPool;
  const result = await pool.query(
    `SELECT ${CUSTOMER_SELECT}
     ${CUSTOMER_FROM_JOIN}
     WHERE c.email = $1`,
    [email]
  );

  return result.rows[0] || null;
}

/**
 * Generate next customer number (CUST-NNNNNN format).
 * Uses advisory lock + sequence — safe for concurrent calls.
 */
export async function generateCustomerNumber(conn: pg.Pool | pg.PoolClient): Promise<string> {
  await conn.query(`SELECT pg_advisory_xact_lock(hashtext('customer_number_seq'))`);
  const result = await conn.query(`SELECT nextval('customer_number_seq') AS seq`);
  const seq = parseInt(result.rows[0].seq, 10);
  return `CUST-${seq.toString().padStart(6, '0')}`;
}

function resolveTaxProfileWrite(data: {
  vatRegistered?: boolean;
  taxExempt?: boolean;
  taxProfile?: string | null;
}): { vatRegistered: boolean; taxExempt: boolean; taxProfile: string } {
  let taxProfile = data.taxProfile || 'STANDARD';
  let vatRegistered = data.vatRegistered === true;
  let taxExempt = data.taxExempt === true;
  if (taxProfile === 'VAT_REGISTERED') vatRegistered = true;
  if (taxProfile === 'EXEMPT') taxExempt = true;
  if (taxExempt) taxProfile = 'EXEMPT';
  else if (vatRegistered && taxProfile === 'STANDARD') taxProfile = 'VAT_REGISTERED';
  return { vatRegistered, taxExempt, taxProfile };
}

export async function createCustomer(data: CreateCustomer, dbPool?: pg.Pool | pg.PoolClient): Promise<Customer> {
  const pool = dbPool || globalPool;
  const customerNumber = await generateCustomerNumber(pool);
  const tax = resolveTaxProfileWrite(data);
  const result = await pool.query(
    `INSERT INTO customers (
      customer_number, name, email, phone, address, customer_group_id, price_group_id, credit_limit,
      unlimited_credit,
      wht_liable, default_wht_type_id,
      vat_registered, tin, tax_profile, default_vat_rate, vat_registration_date, tax_effective_from,
      tax_exempt, allow_tax_override
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
    RETURNING id`,
    [
      customerNumber,
      data.name,
      data.email || null,
      data.phone || null,
      data.address || null,
      data.customerGroupId || null,
      data.priceGroupId || null,
      data.creditLimit || 0,
      data.unlimitedCredit === true,
      data.whtLiable === true,
      data.whtLiable === true ? data.defaultWhtTypeId || null : null,
      tax.vatRegistered,
      data.tin || null,
      tax.taxProfile,
      data.defaultVatRate ?? null,
      data.vatRegistrationDate || null,
      data.taxEffectiveFrom || null,
      tax.taxExempt,
      data.allowTaxOverride === true,
    ]
  );

  const created = await findCustomerById(result.rows[0].id, pool);
  if (!created) throw new NotFoundError('Customer');
  return created;
}

export async function updateCustomer(id: string, data: UpdateCustomer, dbPool?: pg.Pool | pg.PoolClient): Promise<Customer | null> {
  const pool = dbPool || globalPool;
  const clientVersion = data.version;
  const fields: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (data.name !== undefined) {
    fields.push(`name = $${paramIndex++}`);
    values.push(data.name);
  }
  if (data.email !== undefined) {
    fields.push(`email = $${paramIndex++}`);
    values.push(data.email);
  }
  if (data.phone !== undefined) {
    fields.push(`phone = $${paramIndex++}`);
    values.push(data.phone);
  }
  if (data.address !== undefined) {
    fields.push(`address = $${paramIndex++}`);
    values.push(data.address);
  }
  if (data.customerGroupId !== undefined) {
    fields.push(`customer_group_id = $${paramIndex++}`);
    values.push(data.customerGroupId);
  }
  if (data.priceGroupId !== undefined) {
    fields.push(`price_group_id = $${paramIndex++}`);
    values.push(data.priceGroupId);
  }
  if (data.creditLimit !== undefined) {
    fields.push(`credit_limit = $${paramIndex++}`);
    values.push(data.creditLimit);
  }
  if (data.unlimitedCredit !== undefined) {
    fields.push(`unlimited_credit = $${paramIndex++}`);
    values.push(data.unlimitedCredit === true);
  }
  if (data.whtLiable !== undefined) {
    fields.push(`wht_liable = $${paramIndex++}`);
    values.push(data.whtLiable === true);
  }
  if (data.whtLiable === false) {
    fields.push(`default_wht_type_id = $${paramIndex++}`);
    values.push(null);
  } else if (data.defaultWhtTypeId !== undefined) {
    fields.push(`default_wht_type_id = $${paramIndex++}`);
    values.push(data.defaultWhtTypeId);
  }

  if (data.taxProfile !== undefined) {
    const tax = resolveTaxProfileWrite({
      vatRegistered: data.vatRegistered,
      taxExempt: data.taxExempt,
      taxProfile: data.taxProfile,
    });
    fields.push(`vat_registered = $${paramIndex++}`);
    values.push(tax.vatRegistered);
    fields.push(`tax_exempt = $${paramIndex++}`);
    values.push(tax.taxExempt);
    fields.push(`tax_profile = $${paramIndex++}`);
    values.push(tax.taxProfile);
  } else {
    if (data.vatRegistered !== undefined) {
      fields.push(`vat_registered = $${paramIndex++}`);
      values.push(data.vatRegistered === true);
      if (data.vatRegistered === true) {
        fields.push(`tax_profile = $${paramIndex++}`);
        values.push('VAT_REGISTERED');
      }
    }
    if (data.taxExempt !== undefined) {
      fields.push(`tax_exempt = $${paramIndex++}`);
      values.push(data.taxExempt === true);
      if (data.taxExempt === true) {
        fields.push(`tax_profile = $${paramIndex++}`);
        values.push('EXEMPT');
      }
    }
  }
  if (data.tin !== undefined) {
    fields.push(`tin = $${paramIndex++}`);
    values.push(data.tin || null);
  }
  if (data.defaultVatRate !== undefined) {
    fields.push(`default_vat_rate = $${paramIndex++}`);
    values.push(data.defaultVatRate);
  }
  if (data.vatRegistrationDate !== undefined) {
    fields.push(`vat_registration_date = $${paramIndex++}`);
    values.push(data.vatRegistrationDate || null);
  }
  if (data.taxEffectiveFrom !== undefined) {
    fields.push(`tax_effective_from = $${paramIndex++}`);
    values.push(data.taxEffectiveFrom || null);
  }
  if (data.allowTaxOverride !== undefined) {
    fields.push(`allow_tax_override = $${paramIndex++}`);
    values.push(data.allowTaxOverride === true);
  }

  if (fields.length === 0) {
    return findCustomerById(id, pool);
  }

  // Always bump version
  fields.push(`version = version + 1`);

  values.push(id);
  let whereClause = `id = $${paramIndex++}`;

  if (clientVersion !== undefined) {
    whereClause += ` AND version = $${paramIndex++}`;
    values.push(clientVersion);
  }

  const result = await pool.query(
    `UPDATE customers 
     SET ${fields.join(', ')}
     WHERE ${whereClause}
     RETURNING id`,
    values
  );

  if (clientVersion !== undefined) {
    assertRowUpdated(result.rowCount, 'Customer', id);
  }

  if (!result.rows[0]?.id) return null;
  return findCustomerById(result.rows[0].id, pool);
}

export async function deleteCustomer(id: string, dbPool?: pg.Pool | pg.PoolClient): Promise<boolean> {
  const pool = dbPool || globalPool;
  const result = await pool.query('UPDATE customers SET is_active = false WHERE id = $1', [id]);

  return result.rowCount !== null && result.rowCount > 0;
}

export async function toggleCustomerActive(id: string, isActive: boolean, dbPool?: pg.Pool | pg.PoolClient): Promise<Customer | null> {
  const pool = dbPool || globalPool;
  const result = await pool.query(
    `UPDATE customers 
     SET is_active = $1, version = version + 1
     WHERE id = $2
     RETURNING id`,
    [isActive, id]
  );

  if (!result.rows[0]?.id) return null;
  return findCustomerById(result.rows[0].id, pool);
}

export async function updateCustomerBalance(id: string, amount: number, dbPool?: pg.Pool | pg.PoolClient): Promise<Customer | null> {
  const pool = dbPool || globalPool;
  const result = await pool.query(
    `UPDATE customers 
     SET balance = balance + $1, version = version + 1
     WHERE id = $2
     RETURNING id`,
    [amount, id]
  );

  // NOTE: AR control account (1200) CurrentBalance is maintained exclusively by
  // AccountingCore via ledger_entries. Do NOT sync from customers.balance here —
  // that would bypass the GL and cause reconciliation drift.

  if (!result.rows[0]?.id) return null;
  return findCustomerById(result.rows[0].id, pool);
}

export async function findCustomerByNumber(customerNumber: string, dbPool?: pg.Pool | pg.PoolClient): Promise<Customer | null> {
  const pool = dbPool || globalPool;
  const result = await pool.query(
    `SELECT ${CUSTOMER_SELECT}
     ${CUSTOMER_FROM_JOIN}
     WHERE c.customer_number = $1`,
    [customerNumber]
  );

  return result.rows[0] || null;
}

export async function searchCustomers(searchTerm: string, limit: number = 20, dbPool?: pg.Pool | pg.PoolClient): Promise<Customer[]> {
  const pool = dbPool || globalPool;
  const result = await pool.query(
    `SELECT ${CUSTOMER_SELECT}
     ${CUSTOMER_FROM_JOIN}
     WHERE c.is_active = true
      AND (
        c.customer_number ILIKE $1
        OR c.name ILIKE $1
        OR c.email ILIKE $1
        OR c.phone ILIKE $1
      )
    ORDER BY 
      CASE 
        WHEN c.customer_number ILIKE $1 THEN 1
        WHEN c.name ILIKE $2 THEN 2
        ELSE 3
      END,
      c.name ASC
    LIMIT $3`,
    [`%${searchTerm}%`, `${searchTerm}%`, limit]
  );

  return result.rows;
}

export async function countCustomers(
  dbPool?: pg.Pool | pg.PoolClient,
  query: CustomerListQuery = {},
): Promise<number> {
  const pool = dbPool || globalPool;
  const { whereClause, params } = buildCustomerListClauses(query);
  const result = await pool.query(
    `SELECT COUNT(*) as count ${CUSTOMER_FROM_JOIN} WHERE ${whereClause}`,
    params,
  );

  return parseInt(result.rows[0].count, 10);
}

/**
 * Get customer sales/invoices history
 */
export interface CustomerSale {
  id: string;
  saleNumber: string;
  saleDate: Date;
  totalAmount: number;
  paymentMethod: string;
  amountPaid: number;
  changeAmount: number;
  status: string;
  itemCount: number;
  cashierName?: string;
}

export async function findCustomerSales(
  customerId: string,
  limit: number = 50,
  offset: number = 0,
  dbPool?: pg.Pool
): Promise<CustomerSale[]> {
  const pool = dbPool || globalPool;
  const result = await pool.query(
    `SELECT 
      s.id,
      s.sale_number as "saleNumber",
      s.sale_date as "saleDate",
      s.total_amount as "totalAmount",
      s.payment_method as "paymentMethod",
      s.amount_paid as "amountPaid",
      s.change_amount as "changeAmount",
      s.status,
      COUNT(si.id) as "itemCount",
      u.full_name as "cashierName"
    FROM sales s
    LEFT JOIN sale_items si ON s.id = si.sale_id
    LEFT JOIN users u ON s.cashier_id = u.id
    WHERE s.customer_id = $1
  GROUP BY s.id, u.full_name
    ORDER BY s.sale_date DESC, s.created_at DESC
    LIMIT $2 OFFSET $3`,
    [customerId, limit, offset]
  );

  return result.rows.map(row => ({
    ...row,
    itemCount: parseInt(row.itemCount, 10)
  }));
}

export async function countCustomerSales(customerId: string, dbPool?: pg.Pool | pg.PoolClient): Promise<number> {
  const pool = dbPool || globalPool;
  const result = await pool.query(
    'SELECT COUNT(*) as count FROM sales WHERE customer_id = $1',
    [customerId]
  );

  return parseInt(result.rows[0].count, 10);
}

/**
 * Get customer transaction history (for accounting/balance tracking)
 */
export interface CustomerTransaction {
  id: string;
  transactionDate: Date;
  type: 'SALE' | 'PAYMENT' | 'ADJUSTMENT';
  amount: number;
  balance: number;
  description: string;
  referenceNumber?: string;
}

export async function findCustomerTransactions(
  customerId: string,
  limit: number = 50,
  offset: number = 0,
  dbPool?: pg.Pool
): Promise<CustomerTransaction[]> {
  const pool = dbPool || globalPool;
  // Combine credit sales and invoice payments
  // Note: invoices uses PascalCase columns (EF Core), invoice_payments uses lowercase
  const result = await pool.query(
    `(
      SELECT 
        s.id,
        s.sale_date as "transactionDate",
        'SALE' as type,
        s.total_amount as amount,
        s.sale_number as "referenceNumber",
        CONCAT('Sale #', s.sale_number) as description
      FROM sales s
      WHERE s.customer_id = $1 AND s.payment_method = 'CREDIT'
    )
    UNION ALL
    (
      SELECT 
        ip.id,
        ip.payment_date as "transactionDate",
        'PAYMENT' as type,
        -ip.amount as amount, -- negative for liability reduction
        ip.receipt_number as "referenceNumber",
        CONCAT('Payment ', ip.receipt_number) as description
      FROM invoice_payments ip
      INNER JOIN invoices i ON i.id = ip.invoice_id
      WHERE i.customer_id = $1
    )
    ORDER BY "transactionDate" DESC
    LIMIT $2 OFFSET $3`,
    [customerId, limit, offset]
  );

  return result.rows;
}

/**
 * Count total customer transactions (for pagination)
 */
export async function countCustomerTransactions(customerId: string, dbPool?: pg.Pool | pg.PoolClient): Promise<number> {
  const pool = dbPool || globalPool;
  // Count from invoices (AR ledger) + payments — same source as statement
  const result = await pool.query(
    `SELECT COUNT(*) as total FROM (
      SELECT i.id FROM invoices i
      WHERE i.customer_id = $1
        AND i.status NOT IN ('CANCELLED', 'DRAFT')
      UNION ALL
      SELECT ip.id FROM invoice_payments ip
      INNER JOIN invoices i ON i.id = ip.invoice_id
      WHERE i.customer_id = $1
    ) combined`,
    [customerId]
  );

  return parseInt(result.rows[0]?.total || '0', 10);
}

/**
 * Statement queries: opening balance and in-period entries
 */
export async function getOpeningBalance(customerId: string, start: Date | string, dbPool?: pg.Pool | pg.PoolClient): Promise<number> {
  const pool = dbPool || globalPool;
  const startStr = start instanceof Date ? formatDateBusiness(start) : String(start).slice(0, 10);
  const { startUtc } = toUtcRange(startStr, startStr, BUSINESS_TIMEZONE);
  // Derive opening balance from invoices (AR ledger) — same source as fn_recalculate_customer_ar_balance
  const res = await pool.query(
    `WITH debits AS (
       SELECT COALESCE(SUM(
         CASE WHEN i.document_type IS NULL OR i.document_type IN ('INVOICE', 'DEBIT_NOTE', 'OPENING_BALANCE', 'DIST_INVOICE')
              THEN i.total_amount ELSE 0 END
       ),0) AS amt
       FROM invoices i
       WHERE i.customer_id = $1
         AND i.status NOT IN ('CANCELLED', 'DRAFT')
         AND i.issue_date < $2
     ),
     credits AS (
       SELECT COALESCE(SUM(ip.amount),0) AS amt
       FROM invoice_payments ip
       INNER JOIN invoices i ON i.id = ip.invoice_id
       WHERE i.customer_id = $1 AND ip.payment_date < $2
     ),
     credit_notes AS (
       SELECT COALESCE(SUM(i.total_amount),0) AS amt
       FROM invoices i
       WHERE i.customer_id = $1
         AND i.document_type = 'CREDIT_NOTE'
         AND i.status NOT IN ('CANCELLED', 'DRAFT')
         AND i.issue_date < $2
     )
     SELECT (d.amt - c.amt - cn.amt) AS opening
     FROM debits d, credits c, credit_notes cn`,
    [customerId, startUtc]
  );
  return parseFloat(res.rows[0]?.opening ?? 0);
}

/**
 * Get statement entries for invoice/liability tracking only
 * This tracks: Credit sales (INVOICE), Payments (PAYMENT), Manual adjustments (ADJUSTMENT)
 * Deposits are tracked separately - they don't affect invoice balance
 */
export async function getStatementEntries(customerId: string, start: Date | string, end: Date | string, dbPool?: pg.Pool | pg.PoolClient): Promise<Record<string, unknown>[]> {
  const pool = dbPool || globalPool;
  const startStr = start instanceof Date ? formatDateBusiness(start) : String(start).slice(0, 10);
  const endStr = end instanceof Date ? formatDateBusiness(end) : String(end).slice(0, 10);
  const { startUtc, endUtc } = toUtcRange(startStr, endStr, BUSINESS_TIMEZONE);
  // Derive entries from invoices (AR ledger) — same source as fn_recalculate_customer_ar_balance
  const res = await pool.query(
    `(
      SELECT 
        i.issue_date as date,
        'INVOICE' as type,
        i.invoice_number as reference,
        CONCAT('Invoice ', i.invoice_number) as description,
        i.total_amount as debit,
        0::numeric as credit
      FROM invoices i
      WHERE i.customer_id = $1
        AND (i.document_type IS NULL OR i.document_type IN ('INVOICE', 'DIST_INVOICE'))
        AND i.status NOT IN ('CANCELLED', 'DRAFT')
        AND i.issue_date >= $2 AND i.issue_date < $3
    )
    UNION ALL
    (
      SELECT 
        i.issue_date as date,
        'INVOICE' as type,
        i.invoice_number as reference,
        CONCAT('Opening balance ', i.invoice_number) as description,
        i.total_amount as debit,
        0::numeric as credit
      FROM invoices i
      WHERE i.customer_id = $1
        AND i.document_type = 'OPENING_BALANCE'
        AND i.status NOT IN ('CANCELLED', 'DRAFT')
        AND i.issue_date >= $2 AND i.issue_date < $3
    )
    UNION ALL
    (
      SELECT 
        i.issue_date as date,
        'ADJUSTMENT' as type,
        i.invoice_number as reference,
        CONCAT('Credit Note ', i.invoice_number, ' - ', COALESCE(i.reason, '')) as description,
        0::numeric as debit,
        i.total_amount as credit
      FROM invoices i
      WHERE i.customer_id = $1
        AND i.document_type = 'CREDIT_NOTE'
        AND i.status NOT IN ('CANCELLED', 'DRAFT')
        AND i.issue_date >= $2 AND i.issue_date < $3
    )
    UNION ALL
    (
      SELECT 
        i.issue_date as date,
        'ADJUSTMENT' as type,
        i.invoice_number as reference,
        CONCAT('Debit Note ', i.invoice_number, ' - ', COALESCE(i.reason, '')) as description,
        i.total_amount as debit,
        0::numeric as credit
      FROM invoices i
      WHERE i.customer_id = $1
        AND i.document_type = 'DEBIT_NOTE'
        AND i.status NOT IN ('CANCELLED', 'DRAFT')
        AND i.issue_date >= $2 AND i.issue_date < $3
    )
    UNION ALL
    (
      SELECT 
        ip.payment_date as date,
        'PAYMENT' as type,
        ip.receipt_number as reference,
        CONCAT('Payment ', ip.receipt_number) as description,
        0::numeric as debit,
        ip.amount as credit
      FROM invoice_payments ip
      INNER JOIN invoices i ON i.id = ip.invoice_id
      WHERE i.customer_id = $1 AND ip.payment_date >= $2 AND ip.payment_date < $3
    )
    UNION ALL
    (
      SELECT 
        sm.created_at as date,
        'ADJUSTMENT' as type,
        sm.reference as reference,
        sm.description as description,
        CASE WHEN sm.amount > 0 THEN sm.amount ELSE 0 END as debit,
        CASE WHEN sm.amount < 0 THEN -sm.amount ELSE 0 END as credit
      FROM customer_balance_adjustments sm
      WHERE sm.customer_id = $1 AND sm.created_at >= $2 AND sm.created_at < $3
    )
    ORDER BY date ASC`,
    [customerId, startUtc, endUtc]
  );
  return res.rows;
}

/**
 * Get deposit activity for a customer (separate from invoice ledger)
 * Returns both deposit receipts and deposit applications
 */
export async function getDepositEntries(customerId: string, start: Date | string, end: Date | string, dbPool?: pg.Pool | pg.PoolClient): Promise<Record<string, unknown>[]> {
  const pool = dbPool || globalPool;
  const startStr = start instanceof Date ? formatDateBusiness(start) : String(start).slice(0, 10);
  const endStr = end instanceof Date ? formatDateBusiness(end) : String(end).slice(0, 10);
  const { startUtc, endUtc } = toUtcRange(startStr, endStr, BUSINESS_TIMEZONE);
  const res = await pool.query(
    `(
      SELECT 
        d.created_at as date,
        'DEPOSIT_IN' as type,
        d.deposit_number as reference,
        CONCAT('Deposit received (', d.payment_method, ')') as description,
        d.amount as amount,
        d.status
      FROM pos_customer_deposits d
      WHERE d.customer_id = $1 AND d.created_at >= $2 AND d.created_at < $3
    )
    UNION ALL
    (
      SELECT 
        da.applied_at as date,
        'DEPOSIT_OUT' as type,
        d.deposit_number as reference,
        CONCAT('Applied to sale ', s.sale_number) as description,
        -da.amount_applied as amount,
        'APPLIED' as status
      FROM pos_deposit_applications da
      INNER JOIN pos_customer_deposits d ON d.id = da.deposit_id
      INNER JOIN sales s ON s.id = da.sale_id
      WHERE d.customer_id = $1 AND da.applied_at >= $2 AND da.applied_at < $3
    )
    ORDER BY date ASC`,
    [customerId, startUtc, endUtc]
  );
  return res.rows;
}

/**
 * Get customer deposit summary (current balances)
 */
export async function getCustomerDepositSummary(customerId: string, dbPool?: pg.Pool | pg.PoolClient): Promise<{
  totalDeposited: number;
  totalUsed: number;
  availableBalance: number;
  depositCount: number;
}> {
  const pool = dbPool || globalPool;
  const res = await pool.query(
    `SELECT 
      COALESCE(SUM(amount), 0) as total_deposited,
      COALESCE(SUM(amount_used), 0) as total_used,
      COALESCE(SUM(amount_available), 0) as available_balance,
      COUNT(*) as deposit_count
    FROM pos_customer_deposits
    WHERE customer_id = $1 AND status = 'ACTIVE'`,
    [customerId]
  );

  const row = res.rows[0];
  return {
    totalDeposited: parseFloat(row.total_deposited || 0),
    totalUsed: parseFloat(row.total_used || 0),
    availableBalance: parseFloat(row.available_balance || 0),
    depositCount: parseInt(row.deposit_count || 0, 10)
  };
}

/**
 * Get customer summary statistics
 */
export interface CustomerSummary {
  totalSales: number;
  totalSpent: number;
  totalInvoices: number;
  outstandingBalance: number;
  creditUsed: number;
  creditAvailable: number | null;
  /** Enterprise: true when customer has no hard AR ceiling */
  unlimitedCredit?: boolean;
  lastPurchaseDate?: Date;
  pendingInvoices: number;
}

/**
 * Customer Center dashboard KPIs — entire active portfolio (not one page).
 * AR totals use open-item SSOT (same as list balance column).
 */
export interface CustomerCenterStats {
  totalCustomers: number;
  activeCustomers: number;
  totalArBalance: number;
  customersWithDebt: number;
  recentActivityCount: number;
}

export async function getCustomerCenterStats(dbPool?: pg.Pool): Promise<CustomerCenterStats> {
  const pool = dbPool || globalPool;
  const result = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE c.is_active)::int AS "totalCustomers",
       COUNT(*) FILTER (WHERE c.is_active)::int AS "activeCustomers",
       COALESCE(SUM(CASE WHEN c.is_active THEN (${CUSTOMER_OPEN_AR_SQL}) ELSE 0 END), 0)::float8 AS "totalArBalance",
       COUNT(*) FILTER (WHERE c.is_active AND (${CUSTOMER_OPEN_AR_SQL}) > 0.009)::int AS "customersWithDebt",
       (
         SELECT COUNT(*)::int
         FROM invoices i
         WHERE i.created_at >= (NOW() - INTERVAL '7 days')
           AND COALESCE(i.document_type, 'INVOICE') IN ('INVOICE', 'OPENING_BALANCE', 'DIST_INVOICE', 'CREDIT_NOTE', 'DEBIT_NOTE')
           AND i.status NOT IN ('CANCELLED', 'VOIDED', 'DRAFT')
       ) AS "recentActivityCount"
     FROM customers c`,
  );
  const row = result.rows[0] || {};
  return {
    totalCustomers: parseInt(String(row.totalCustomers ?? 0), 10),
    activeCustomers: parseInt(String(row.activeCustomers ?? 0), 10),
    totalArBalance: parseFloat(String(row.totalArBalance ?? 0)),
    customersWithDebt: parseInt(String(row.customersWithDebt ?? 0), 10),
    recentActivityCount: parseInt(String(row.recentActivityCount ?? 0), 10),
  };
}

export async function getCustomerSummary(customerId: string, dbPool?: pg.Pool | pg.PoolClient): Promise<CustomerSummary> {
  const pool = dbPool || globalPool;
  const customer = await findCustomerById(customerId, pool);
  if (!customer) {
    throw new Error(`Customer with ID ${customerId} not found`);
  }

  // Derive summary from invoices (AR ledger) — covers both POS credit sales and DN→Invoice flow
  const invoiceResult = await pool.query(
    `SELECT 
      COUNT(*) as "totalInvoices",
      COALESCE(SUM(total_amount), 0) as "totalSpent",
      MAX(issue_date) as "lastPurchaseDate"
    FROM invoices 
    WHERE customer_id = $1
      AND status NOT IN ('CANCELLED', 'DRAFT')`,
    [customerId]
  );

  // Count pending (unpaid/partially paid) invoices
  const pendingResult = await pool.query(
    `SELECT COUNT(*) as "pendingCount"
    FROM invoices
    WHERE customer_id = $1
      AND status NOT IN ('CANCELLED', 'DRAFT', 'PAID')`,
    [customerId]
  );

  const summary = invoiceResult.rows[0];
  const pendingInvoices = parseInt(pendingResult.rows[0]?.pendingCount || '0', 10);
  // Open-item AR SSOT (live) — not stale customers.balance column
  const balance = typeof customer.balance === 'string' ? parseFloat(customer.balance) : (customer.balance || 0);
  const creditLimit = typeof customer.creditLimit === 'string' ? parseFloat(String(customer.creditLimit)) : (customer.creditLimit || 0);
  const unlimitedCredit = Boolean((customer as { unlimitedCredit?: boolean }).unlimitedCredit);
  const outstandingBalance = balance > 0 ? balance : 0;
  const creditUsed = outstandingBalance;
  const creditAvailable = unlimitedCredit ? null : Math.max(0, creditLimit - creditUsed);

  return {
    totalSales: parseInt(summary.totalInvoices, 10),
    totalSpent: parseFloat(summary.totalSpent),
    totalInvoices: parseInt(summary.totalInvoices, 10),
    outstandingBalance,
    creditUsed,
    /** null = unlimited (enterprise) */
    creditAvailable,
    unlimitedCredit,
    lastPurchaseDate: summary.lastPurchaseDate || undefined,
    pendingInvoices,
  };
}
