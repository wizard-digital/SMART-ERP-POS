/**
 * Distribution Module — Repository Layer
 *
 * Raw SQL queries for dist_sales_orders, dist_deliveries,
 * dist_invoices, dist_receipts, and dist_down_payment_clearings.
 */

import { Pool, PoolClient } from 'pg';
import Decimal from 'decimal.js';
import { Money } from '../../utils/money.js';
import { getBusinessYear, getBusinessDate } from '../../utils/dateRange.js';
import { deductStockFEFO as sharedDeductStockFEFO } from '../../utils/fefoDeduction.js';
import { isMultistoreEnabled } from '../inventory/warehouse/multistoreSettings.js';
import { warehouseSaleDeductionService } from '../inventory/warehouse/warehouseSaleDeductionService.js';
import { storeLocationRepository } from '../inventory/warehouse/storeLocationRepository.js';

export type DbConn = Pool | PoolClient;

// ─── DB Row Types ───────────────────────────────────────────

export interface SalesOrderDbRow {
  id: string;
  order_number: string;
  customer_id: string;
  customer_name: string;
  credit_limit: string;
  status: string;
  order_date: string;
  notes: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  total_amount: string;
  total_confirmed: string;
  total_delivered: string;
}

export interface SalesOrderLineDbRow {
  id: string;
  sales_order_id: string;
  product_id: string;
  product_name: string;
  sku: string;
  ordered_qty: string;
  confirmed_qty: string;
  delivered_qty: string;
  open_qty: string;
  unit_price: string;
  line_total: string;
}

export interface DeliveryDbRow {
  id: string;
  delivery_number: string;
  sales_order_id: string;
  order_number: string;
  customer_id: string;
  customer_name: string;
  status: string;
  delivery_date: string;
  notes: string | null;
  created_by: string;
  created_at: string;
  total_amount: string;
  total_cost: string;
}

export interface DeliveryLineDbRow {
  id: string;
  delivery_id: string;
  sales_order_line_id: string;
  product_id: string;
  product_name: string;
  quantity: string;
  unit_cost: string;
  unit_price: string;
  line_total: string;
}

export interface DistInvoiceDbRow {
  id: string;
  invoice_number: string;
  sales_order_id: string;
  order_number: string;
  delivery_id: string;
  delivery_number: string;
  customer_id: string;
  customer_name: string;
  total_amount: string;
  amount_paid: string;
  amount_due: string;
  status: string;
  issue_date: string;
  due_date: string | null;
  notes: string | null;
  created_by: string;
  created_at: string;
}

export interface ReceiptDbRow {
  id: string;
  receipt_number: string;
  invoice_id: string;
  invoice_number: string;
  customer_id: string;
  customer_name: string;
  amount: string;
  payment_method: string;
  reference_number: string | null;
  receipt_date: string;
  notes: string | null;
  created_by: string;
  created_at: string;
}

export interface AtpRow {
  product_id: string;
  product_name: string;
  sku: string;
  on_hand: string;
  reserved: string;
  atp: string;
}

// ─── Business Number Generators ─────────────────────────────

async function generateNumber(
  conn: DbConn, table: string, column: string, prefix: string
): Promise<string> {
  const year = getBusinessYear();
  const pattern = `${prefix}-${year}-%`;
  await conn.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`${table}_seq`]);
  const result = await conn.query(
    `SELECT ${column} FROM ${table} WHERE ${column} LIKE $1 ORDER BY ${column} DESC LIMIT 1`,
    [pattern]
  );
  let next = 1;
  if (result.rows.length > 0) {
    const last = result.rows[0][column] as string;
    const num = parseInt(last.split('-').pop() || '0', 10);
    next = num + 1;
  }
  return `${prefix}-${year}-${String(next).padStart(4, '0')}`;
}

// ─── Issue store (ATP + delivery must use the same location) ──

/**
 * Distribution ships from the same sellable store GRN/POS land on:
 * active POS SELLING first, else default MAIN receiving.
 * Never promise global batch qty that MAIN cannot deduct.
 */
export async function resolveDistributionIssueStoreId(conn: DbConn): Promise<string | null> {
  const selling = await storeLocationRepository.getActivePosSellingStore(conn);
  if (selling?.id) return selling.id;
  const main = await storeLocationRepository.getDefaultReceivingStore(conn);
  return main?.id ?? null;
}

// ─── ATP (Available-to-Promise) ─────────────────────────────

export async function getAtpForProducts(
  conn: DbConn, productIds: string[]
): Promise<AtpRow[]> {
  if (productIds.length === 0) return [];
  const placeholders = productIds.map((_, i) => `$${i + 1}`).join(',');
  // Reserved = undelivered confirmed qty on open DSOs (cannot double-promise).
  const reservedJoin = `
    LEFT JOIN (
      SELECT sol.product_id, SUM(sol.confirmed_qty - sol.delivered_qty) AS qty
      FROM dist_sales_order_lines sol
      JOIN dist_sales_orders so ON so.id = sol.sales_order_id
      WHERE so.status IN ('OPEN', 'PARTIALLY_DELIVERED')
      GROUP BY sol.product_id
    ) reserved ON reserved.product_id = p.id`;

  if (await isMultistoreEnabled(conn)) {
    const issueStoreId = await resolveDistributionIssueStoreId(conn);
    if (issueStoreId) {
      // Same sellable formula as loadStoreSelectableLots at the issue store.
      const result = await conn.query(
        `
        SELECT
          p.id AS product_id,
          p.name AS product_name,
          p.sku,
          COALESCE(onhand.qty, 0) AS on_hand,
          COALESCE(reserved.qty, 0) AS reserved,
          COALESCE(onhand.qty, 0) - COALESCE(reserved.qty, 0) AS atp
        FROM products p
        LEFT JOIN (
          SELECT
            pl.product_id,
            SUM(GREATEST(
              ib_bal.quantity_on_hand - ib_bal.quantity_reserved - ib_bal.quantity_committed,
              0
            )) AS qty
          FROM inventory_balances ib_bal
          INNER JOIN product_lots pl ON pl.id = ib_bal.product_lot_id
          INNER JOIN inventory_batches ib ON ib.id = pl.inventory_batch_id
          INNER JOIN store_locations sl ON sl.id = ib_bal.store_location_id
          WHERE ib_bal.store_location_id = $${productIds.length + 1}
            AND NOT ib_bal.blocked
            AND sl.store_type IN ('MAIN', 'SELLING')
            AND COALESCE(pl.status::text, 'ACTIVE') = 'ACTIVE'
            AND COALESCE(ib.status::text, 'ACTIVE') = 'ACTIVE'
            AND (ib.expiry_date IS NULL OR ib.expiry_date > CURRENT_DATE)
          GROUP BY pl.product_id
        ) onhand ON onhand.product_id = p.id
        ${reservedJoin}
        WHERE p.id IN (${placeholders})
        `,
        [...productIds, issueStoreId],
      );
      return result.rows;
    }
  }

  // Legacy single-store: ACTIVE batch subledger.
  const result = await conn.query(
    `
    SELECT
      p.id AS product_id,
      p.name AS product_name,
      p.sku,
      COALESCE(SUM(ib.remaining_quantity), 0) AS on_hand,
      COALESCE(reserved.qty, 0) AS reserved,
      COALESCE(SUM(ib.remaining_quantity), 0) - COALESCE(reserved.qty, 0) AS atp
    FROM products p
    LEFT JOIN inventory_batches ib
      ON ib.product_id = p.id
     AND ib.remaining_quantity > 0
     AND ib.status = 'ACTIVE'
    ${reservedJoin}
    WHERE p.id IN (${placeholders})
    GROUP BY p.id, p.name, p.sku, reserved.qty
    `,
    productIds,
  );
  return result.rows;
}

// ─── Sales Orders ───────────────────────────────────────────

export async function createSalesOrder(
  conn: DbConn,
  data: { customerId: string; orderDate: string; notes?: string; createdBy: string }
): Promise<string> {
  const orderNumber = await generateNumber(conn, 'dist_sales_orders', 'order_number', 'DSO');
  const result = await conn.query(`
    INSERT INTO dist_sales_orders (order_number, customer_id, status, order_date, notes, created_by)
    VALUES ($1, $2, 'OPEN', $3, $4, $5)
    RETURNING id
  `, [orderNumber, data.customerId, data.orderDate, data.notes || null, data.createdBy]);
  return result.rows[0].id;
}

export async function addSalesOrderLine(
  conn: DbConn,
  data: {
    salesOrderId: string;
    productId: string;
    orderedQty: number;
    confirmedQty: number;
    unitPrice: number;
  }
): Promise<void> {
  const openQty = data.orderedQty - data.confirmedQty;
  // Order commercial value = ordered × price (ATP/backorder lives in confirmed_qty).
  // Delivery / invoice / AR remain on delivered qty × price elsewhere.
  const lineTotal = Money.toNumber(Money.lineTotal(data.orderedQty, data.unitPrice));
  await conn.query(`
    INSERT INTO dist_sales_order_lines
      (sales_order_id, product_id, ordered_qty, confirmed_qty, delivered_qty, open_qty, unit_price, line_total)
    VALUES ($1, $2, $3, $4, 0, $5, $6, $7)
  `, [data.salesOrderId, data.productId, data.orderedQty, data.confirmedQty, openQty, data.unitPrice, lineTotal]);
}

export async function getSalesOrder(conn: DbConn, id: string): Promise<SalesOrderDbRow | null> {
  const result = await conn.query(`
    SELECT
      so.*,
      c.name AS customer_name,
      c.credit_limit,
      COALESCE(SUM(sol.ordered_qty * sol.unit_price), 0) AS total_amount,
      COALESCE(SUM(sol.confirmed_qty * sol.unit_price), 0) AS total_confirmed,
      COALESCE(SUM(sol.delivered_qty * sol.unit_price), 0) AS total_delivered
    FROM dist_sales_orders so
    JOIN customers c ON c.id = so.customer_id
    LEFT JOIN dist_sales_order_lines sol ON sol.sales_order_id = so.id
    WHERE so.id = $1
    GROUP BY so.id, c.name, c.credit_limit
  `, [id]);
  return result.rows[0] || null;
}

export async function getSalesOrderByNumber(conn: DbConn, orderNumber: string): Promise<SalesOrderDbRow | null> {
  const result = await conn.query(`
    SELECT
      so.*,
      c.name AS customer_name,
      c.credit_limit,
      COALESCE(SUM(sol.ordered_qty * sol.unit_price), 0) AS total_amount,
      COALESCE(SUM(sol.confirmed_qty * sol.unit_price), 0) AS total_confirmed,
      COALESCE(SUM(sol.delivered_qty * sol.unit_price), 0) AS total_delivered
    FROM dist_sales_orders so
    JOIN customers c ON c.id = so.customer_id
    LEFT JOIN dist_sales_order_lines sol ON sol.sales_order_id = so.id
    WHERE so.order_number = $1
    GROUP BY so.id, c.name, c.credit_limit
  `, [orderNumber]);
  return result.rows[0] || null;
}

export async function getSalesOrderLines(conn: DbConn, salesOrderId: string): Promise<SalesOrderLineDbRow[]> {
  const result = await conn.query(`
    SELECT
      sol.id,
      sol.sales_order_id,
      sol.product_id,
      sol.ordered_qty,
      sol.confirmed_qty,
      sol.delivered_qty,
      sol.open_qty,
      sol.unit_price,
      (sol.ordered_qty * sol.unit_price) AS line_total,
      sol.created_at,
      p.name AS product_name,
      p.sku
    FROM dist_sales_order_lines sol
    JOIN products p ON p.id = sol.product_id
    WHERE sol.sales_order_id = $1
    ORDER BY sol.created_at
  `, [salesOrderId]);
  return result.rows;
}

export async function listSalesOrders(
  conn: DbConn,
  filters: { status?: string; customerId?: string; limit: number; offset: number }
): Promise<{ rows: SalesOrderDbRow[]; count: number }> {
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  let idx = 1;

  if (filters.status) { conditions.push(`so.status = $${idx++}`); params.push(filters.status); }
  if (filters.customerId) { conditions.push(`so.customer_id = $${idx++}`); params.push(filters.customerId); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countResult = await conn.query(
    `SELECT COUNT(DISTINCT so.id) AS cnt FROM dist_sales_orders so ${where}`, params
  );
  const count = parseInt(countResult.rows[0].cnt, 10);

  const dataResult = await conn.query(`
    SELECT
      so.*,
      c.name AS customer_name,
      c.credit_limit,
      COALESCE(SUM(sol.ordered_qty * sol.unit_price), 0) AS total_amount,
      COALESCE(SUM(sol.confirmed_qty * sol.unit_price), 0) AS total_confirmed,
      COALESCE(SUM(sol.delivered_qty * sol.unit_price), 0) AS total_delivered
    FROM dist_sales_orders so
    JOIN customers c ON c.id = so.customer_id
    LEFT JOIN dist_sales_order_lines sol ON sol.sales_order_id = so.id
    ${where}
    GROUP BY so.id, c.name, c.credit_limit
    ORDER BY so.created_at DESC
    LIMIT $${idx++} OFFSET $${idx++}
  `, [...params, filters.limit, filters.offset]);

  return { rows: dataResult.rows, count };
}

export async function updateSalesOrderStatus(conn: DbConn, id: string, status: string): Promise<void> {
  await conn.query(`UPDATE dist_sales_orders SET status = $1, updated_at = NOW() WHERE id = $2`, [status, id]);
}

export async function updateSalesOrderLineDelivered(
  conn: DbConn, lineId: string, additionalQty: number
): Promise<void> {
  await conn.query(`
    UPDATE dist_sales_order_lines
    SET delivered_qty = delivered_qty + $1,
        open_qty = confirmed_qty - (delivered_qty + $1)
    WHERE id = $2
  `, [additionalQty, lineId]);
}

export async function reserveConfirmedQty(
  conn: DbConn, lineId: string, confirmedQty: number
): Promise<void> {
  await conn.query(`
    UPDATE dist_sales_order_lines
    SET confirmed_qty = $1, open_qty = ordered_qty - $1
    WHERE id = $2
  `, [confirmedQty, lineId]);
}

// ─── Deliveries ─────────────────────────────────────────────

export async function createDelivery(
  conn: DbConn,
  data: { salesOrderId: string; customerId: string; deliveryDate: string; notes?: string; createdBy: string }
): Promise<{ id: string; deliveryNumber: string }> {
  const deliveryNumber = await generateNumber(conn, 'dist_deliveries', 'delivery_number', 'DDL');
  const result = await conn.query(`
    INSERT INTO dist_deliveries (delivery_number, sales_order_id, customer_id, status, delivery_date, notes, created_by)
    VALUES ($1, $2, $3, 'DRAFT', $4, $5, $6)
    RETURNING id
  `, [deliveryNumber, data.salesOrderId, data.customerId, data.deliveryDate, data.notes || null, data.createdBy]);
  return { id: result.rows[0].id, deliveryNumber };
}

export async function addDeliveryLine(
  conn: DbConn,
  data: { deliveryId: string; salesOrderLineId: string; productId: string; quantity: number; unitCost: number }
): Promise<void> {
  await conn.query(`
    INSERT INTO dist_delivery_lines (delivery_id, sales_order_line_id, product_id, quantity, unit_cost)
    VALUES ($1, $2, $3, $4, $5)
  `, [data.deliveryId, data.salesOrderLineId, data.productId, data.quantity, data.unitCost]);
}

export async function getDelivery(conn: DbConn, id: string): Promise<DeliveryDbRow | null> {
  const result = await conn.query(`
    SELECT
      d.*,
      so.order_number,
      c.name AS customer_name,
      COALESCE(SUM(dl.quantity * sol.unit_price), 0) AS total_amount,
      COALESCE(SUM(dl.quantity * dl.unit_cost), 0) AS total_cost
    FROM dist_deliveries d
    JOIN dist_sales_orders so ON so.id = d.sales_order_id
    JOIN customers c ON c.id = d.customer_id
    LEFT JOIN dist_delivery_lines dl ON dl.delivery_id = d.id
    LEFT JOIN dist_sales_order_lines sol ON sol.id = dl.sales_order_line_id
    WHERE d.id = $1
    GROUP BY d.id, so.order_number, c.name
  `, [id]);
  return result.rows[0] || null;
}

export async function getDeliveryLines(conn: DbConn, deliveryId: string): Promise<DeliveryLineDbRow[]> {
  const result = await conn.query(`
    SELECT
      dl.*,
      p.name AS product_name,
      sol.unit_price,
      dl.quantity * sol.unit_price AS line_total
    FROM dist_delivery_lines dl
    JOIN products p ON p.id = dl.product_id
    JOIN dist_sales_order_lines sol ON sol.id = dl.sales_order_line_id
    WHERE dl.delivery_id = $1
    ORDER BY dl.created_at
  `, [deliveryId]);
  return result.rows;
}

export async function updateDeliveryStatus(conn: DbConn, id: string, status: string): Promise<void> {
  await conn.query(`UPDATE dist_deliveries SET status = $1 WHERE id = $2`, [status, id]);
}

export async function listDeliveries(
  conn: DbConn,
  filters: { salesOrderId?: string; status?: string; customerId?: string; limit: number; offset: number }
): Promise<{ rows: DeliveryDbRow[]; count: number }> {
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  let idx = 1;

  if (filters.salesOrderId) { conditions.push(`d.sales_order_id = $${idx++}`); params.push(filters.salesOrderId); }
  if (filters.status) { conditions.push(`d.status = $${idx++}`); params.push(filters.status); }
  if (filters.customerId) { conditions.push(`d.customer_id = $${idx++}`); params.push(filters.customerId); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countResult = await conn.query(
    `SELECT COUNT(DISTINCT d.id) AS cnt FROM dist_deliveries d ${where}`, params
  );
  const count = parseInt(countResult.rows[0].cnt, 10);

  const dataResult = await conn.query(`
    SELECT
      d.*,
      so.order_number,
      c.name AS customer_name,
      COALESCE(SUM(dl.quantity * sol.unit_price), 0) AS total_amount,
      COALESCE(SUM(dl.quantity * dl.unit_cost), 0) AS total_cost
    FROM dist_deliveries d
    JOIN dist_sales_orders so ON so.id = d.sales_order_id
    JOIN customers c ON c.id = d.customer_id
    LEFT JOIN dist_delivery_lines dl ON dl.delivery_id = d.id
    LEFT JOIN dist_sales_order_lines sol ON sol.id = dl.sales_order_line_id
    ${where}
    GROUP BY d.id, so.order_number, c.name
    ORDER BY d.created_at DESC
    LIMIT $${idx++} OFFSET $${idx++}
  `, [...params, filters.limit, filters.offset]);

  return { rows: dataResult.rows, count };
}

// ─── Distribution Invoices ──────────────────────────────────

export async function createDistInvoice(
  conn: DbConn,
  data: {
    salesOrderId: string; deliveryId: string; customerId: string; customerName: string;
    totalAmount: number; issueDate: string; dueDate?: string;
    notes?: string; createdBy: string;
  }
): Promise<{ id: string; invoiceNumber: string }> {
  const invoiceNumber = await generateNumber(conn, 'invoices', 'invoice_number', 'DIN');
  const result = await conn.query(`
    INSERT INTO invoices
      (invoice_number, sales_order_id, delivery_id, customer_id, customer_name,
       subtotal, tax_amount, total_amount, amount_paid, amount_due,
       status, issue_date, due_date, payment_terms, notes,
       created_by_id, source_module, document_type, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5,
            $6, 0, $6, 0, $6,
            'UNPAID', $7, $8, 30, $9,
            $10, 'DISTRIBUTION', 'DIST_INVOICE', NOW(), NOW())
    RETURNING id
  `, [invoiceNumber, data.salesOrderId, data.deliveryId, data.customerId, data.customerName, data.totalAmount,
    data.issueDate, data.dueDate || data.issueDate, data.notes || null, data.createdBy]);
  return { id: result.rows[0].id, invoiceNumber };
}

export async function addDistInvoiceLine(
  conn: DbConn,
  data: { invoiceId: string; deliveryLineId: string; productId: string; quantity: number; unitPrice: number; lineTotal: number }
): Promise<void> {
  await conn.query(`
    INSERT INTO invoice_lines (invoice_id, delivery_line_id, product_id, quantity, unit_price, line_total)
    VALUES ($1, $2, $3, $4, $5, $6)
  `, [data.invoiceId, data.deliveryLineId, data.productId, data.quantity, data.unitPrice, data.lineTotal]);
}

export async function getDistInvoice(conn: DbConn, id: string): Promise<DistInvoiceDbRow | null> {
  const result = await conn.query(`
    SELECT
      i.*,
      so.order_number,
      d.delivery_number,
      c.name AS customer_name
    FROM invoices i
    JOIN dist_sales_orders so ON so.id = i.sales_order_id
    JOIN dist_deliveries d ON d.id = i.delivery_id
    JOIN customers c ON c.id = i.customer_id
    WHERE i.id = $1 AND i.source_module = 'DISTRIBUTION'
  `, [id]);
  return result.rows[0] || null;
}

export async function listDistInvoices(
  conn: DbConn,
  filters: { customerId?: string; status?: string; salesOrderId?: string; limit: number; offset: number }
): Promise<{ rows: DistInvoiceDbRow[]; count: number }> {
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  let idx = 1;

  if (filters.customerId) { conditions.push(`i.customer_id = $${idx++}`); params.push(filters.customerId); }
  if (filters.status) { conditions.push(`i.status = $${idx++}`); params.push(filters.status); }
  if (filters.salesOrderId) { conditions.push(`i.sales_order_id = $${idx++}`); params.push(filters.salesOrderId); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countResult = await conn.query(`SELECT COUNT(*) AS cnt FROM invoices i WHERE i.source_module = 'DISTRIBUTION' ${conditions.length > 0 ? 'AND ' + conditions.join(' AND ') : ''}`, params);
  const count = parseInt(countResult.rows[0].cnt, 10);

  const dataResult = await conn.query(`
    SELECT
      i.*,
      so.order_number,
      d.delivery_number,
      c.name AS customer_name
    FROM invoices i
    JOIN dist_sales_orders so ON so.id = i.sales_order_id
    JOIN dist_deliveries d ON d.id = i.delivery_id
    JOIN customers c ON c.id = i.customer_id
    WHERE i.source_module = 'DISTRIBUTION' ${conditions.length > 0 ? 'AND ' + conditions.join(' AND ') : ''}
    ORDER BY i.created_at DESC
    LIMIT $${idx++} OFFSET $${idx++}
  `, [...params, filters.limit, filters.offset]);

  return { rows: dataResult.rows, count };
}

export async function getOpenDistInvoicesForCustomer(conn: DbConn, customerId: string): Promise<DistInvoiceDbRow[]> {
  const result = await conn.query(`
    SELECT
      i.*,
      so.order_number,
      d.delivery_number,
      c.name AS customer_name
    FROM invoices i
    JOIN dist_sales_orders so ON so.id = i.sales_order_id
    JOIN dist_deliveries d ON d.id = i.delivery_id
    JOIN customers c ON c.id = i.customer_id
    WHERE i.customer_id = $1 AND i.source_module = 'DISTRIBUTION' AND i.status IN ('UNPAID','PARTIALLY_PAID') AND i.amount_due > 0
    ORDER BY i.issue_date
  `, [customerId]);
  return result.rows;
}

/**
 * @deprecated Settlement SSOT is invoiceRepository.recalcInvoice / getInvoiceSettlement
 * (invoice_payments + legacy dist rows). Kept as a thin adapter for any remaining callers.
 */
export async function recalcDistInvoice(conn: DbConn, invoiceId: string): Promise<void> {
  const { invoiceRepository } = await import('../invoices/invoiceRepository.js');
  await invoiceRepository.recalcInvoice(conn, invoiceId);
}

// ─── Receipts ───────────────────────────────────────────────

export async function createReceipt(
  conn: DbConn,
  data: {
    invoiceId: string; customerId: string; amount: number;
    paymentMethod: string; referenceNumber?: string;
    receiptDate: string; notes?: string; createdBy: string;
  }
): Promise<{ id: string; receiptNumber: string }> {
  const receiptNumber = await generateNumber(conn, 'dist_receipts', 'receipt_number', 'DRC');
  const result = await conn.query(`
    INSERT INTO dist_receipts
      (receipt_number, invoice_id, customer_id, amount, payment_method, reference_number, receipt_date, notes, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING id
  `, [receiptNumber, data.invoiceId, data.customerId, data.amount,
    data.paymentMethod, data.referenceNumber || null, data.receiptDate, data.notes || null, data.createdBy]);
  return { id: result.rows[0].id, receiptNumber };
}

// ─── Down Payment Clearing ─────────────────────────────────

export async function createDistClearing(
  conn: DbConn,
  data: { invoiceId: string; downPaymentId: string; customerId: string; amount: number; clearedBy: string; notes?: string }
): Promise<{ id: string; clearingNumber: string }> {
  const clearingNumber = await generateNumber(conn, 'dist_down_payment_clearings', 'clearing_number', 'DCL');
  const result = await conn.query(`
    INSERT INTO dist_down_payment_clearings (clearing_number, invoice_id, down_payment_id, customer_id, amount, cleared_by, notes)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING id
  `, [clearingNumber, data.invoiceId, data.downPaymentId, data.customerId, data.amount, data.clearedBy, data.notes || null]);
  return { id: result.rows[0].id, clearingNumber };
}

export async function reduceDepositBalance(conn: DbConn, depositId: string, amount: number): Promise<void> {
  await conn.query(`
    UPDATE pos_customer_deposits
    SET amount_used = amount_used + $1,
        amount_available = amount_available - $1,
        status = CASE WHEN amount_available - $1 <= 0 THEN 'FULLY_USED' ELSE status END
    WHERE id = $2
  `, [amount, depositId]);
}

export async function getOpenDepositsForCustomer(conn: DbConn, customerId: string): Promise<Array<{
  id: string; deposit_number: string; amount: string; amount_used: string; amount_available: string; payment_method: string; created_at: string;
}>> {
  const result = await conn.query(`
    SELECT id, deposit_number, amount, amount_used, amount_available, payment_method, created_at
    FROM pos_customer_deposits
    WHERE customer_id = $1 AND status = 'ACTIVE' AND amount_available > 0
    ORDER BY created_at
  `, [customerId]);
  return result.rows;
}

// ─── Customer Outstanding AR ────────────────────────────────

export async function getCustomerOutstandingAR(conn: DbConn, customerId: string): Promise<number> {
  const result = await conn.query(`
    SELECT COALESCE(SUM(amount_due), 0) AS outstanding
    FROM invoices
    WHERE customer_id = $1 AND source_module = 'DISTRIBUTION' AND status IN ('UNPAID','PARTIALLY_PAID')
  `, [customerId]);
  return Money.toNumber(Money.parseDb(result.rows[0].outstanding));
}

// ─── Stock Deduction (FEFO) — same store as ATP ─────────────

export async function deductStockFEFO(
  conn: DbConn,
  productId: string,
  quantity: number,
  referenceId: string,
  createdBy: string
): Promise<{ totalCost: number }> {
  if (await isMultistoreEnabled(conn)) {
    const issueStoreId =
      (await resolveDistributionIssueStoreId(conn)) ||
      (await warehouseSaleDeductionService.resolveMainStoreId(conn as PoolClient));
    const pResult = await conn.query<{ name: string }>(
      'SELECT name FROM products WHERE id = $1',
      [productId],
    );
    const productName = pResult.rows[0]?.name ?? productId;

    const deductResult = await warehouseSaleDeductionService.deductAtStore(conn as PoolClient, {
      storeLocationId: issueStoreId,
      productId,
      productName,
      baseQty: Money.parse(quantity),
      movementType: 'SALE',
      referenceType: 'DIST_DELIVERY',
      referenceId,
      notes: `Distribution delivery ${referenceId}`,
      userId: createdBy,
    });
    return { totalCost: Money.toNumber(deductResult.actualBatchCost) };
  }

  // Delegate to the canonical shared FEFO implementation
  // which ensures: ACTIVE filter, FOR UPDATE locking, DEPLETED transition,
  // positive movement quantities, and consistent batch ordering.
  const result = await sharedDeductStockFEFO(conn as PoolClient, {
    productId,
    quantity: Money.parse(quantity),
    movementType: 'SALE',
    referenceType: 'DIST_DELIVERY',
    referenceId,
    createdById: createdBy,
  });
  return { totalCost: Money.toNumber(result.totalCost) };
}

// ─── Sales Orders with Open Lines (for backorder screen) ────

export async function getSalesOrdersWithOpenLines(
  conn: DbConn, productId?: string
): Promise<Array<{ orderId: string; orderNumber: string; customerName: string; lineId: string; productId: string; productName: string; openQty: string }>> {
  const conditions = [`so.status IN ('OPEN','PARTIALLY_DELIVERED')`, `sol.open_qty > 0`];
  const params: string[] = [];
  if (productId) {
    conditions.push(`sol.product_id = $1`);
    params.push(productId);
  }
  const result = await conn.query(`
    SELECT
      so.id AS "orderId",
      so.order_number AS "orderNumber",
      c.name AS "customerName",
      sol.id AS "lineId",
      sol.product_id AS "productId",
      p.name AS "productName",
      sol.open_qty AS "openQty"
    FROM dist_sales_order_lines sol
    JOIN dist_sales_orders so ON so.id = sol.sales_order_id
    JOIN customers c ON c.id = so.customer_id
    JOIN products p ON p.id = sol.product_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY so.created_at, sol.created_at
  `, params);
  return result.rows;
}

// ─── Sales Order Edit Operations ────────────────────────────

export async function updateSalesOrderHeader(
  conn: DbConn,
  id: string,
  data: { notes?: string | null; orderDate?: string }
): Promise<void> {
  const sets: string[] = ['updated_at = NOW()'];
  const params: (string | null)[] = [];
  let idx = 1;
  if (data.notes !== undefined) { sets.push(`notes = $${idx++}`); params.push(data.notes); }
  if (data.orderDate !== undefined) { sets.push(`order_date = $${idx++}`); params.push(data.orderDate); }
  params.push(id);
  await conn.query(
    `UPDATE dist_sales_orders SET ${sets.join(', ')} WHERE id = $${idx}`,
    params,
  );
}

export async function updateSalesOrderLine(
  conn: DbConn,
  lineId: string,
  data: { orderedQty: number; unitPrice: number; confirmedQty: number }
): Promise<void> {
  const openQty = data.orderedQty - data.confirmedQty;
  const lineTotal = Money.toNumber(Money.lineTotal(data.orderedQty, data.unitPrice));
  await conn.query(`
    UPDATE dist_sales_order_lines
    SET ordered_qty = $1, unit_price = $2, confirmed_qty = $3,
        open_qty = $4, line_total = $5
    WHERE id = $6
  `, [data.orderedQty, data.unitPrice, data.confirmedQty, openQty, lineTotal, lineId]);
}

export async function deleteSalesOrderLine(conn: DbConn, lineId: string): Promise<void> {
  await conn.query('DELETE FROM dist_sales_order_lines WHERE id = $1', [lineId]);
}

export async function getDeliveryCountForOrderLine(conn: DbConn, lineId: string): Promise<number> {
  const result = await conn.query(
    `SELECT COALESCE(SUM(quantity), 0) AS delivered FROM dist_delivery_lines WHERE sales_order_line_id = $1`,
    [lineId],
  );
  return Number(result.rows[0].delivered);
}
