/**
 * Distribution Module — Service Layer
 *
 * SAP-style document flow:
 *   Sales Order (with ATP) → Delivery → Invoice → Clearing/Payment
 *
 * Business rules:
 *   - No delivery without a sales order
 *   - No delivery without creating an invoice
 *   - Stock confirmation uses ATP, not raw stock
 *   - Partial delivery → backorder in same order
 *   - Credit limit check blocks delivery
 *   - Deposits are liabilities, never wallet balances
 *   - User chooses: deposit, cash, or both (no auto-clearing)
 *   - All balances computed from documents
 */

import { Pool } from 'pg';
import Decimal from 'decimal.js';
import * as repo from './distRepository.js';
import { AccountingCore } from '../../services/accountingCore.js';
import {
  recordCustomerInvoiceToGL,
  AccountCodes,
} from '../../services/glEntryService.js';
import { UnitOfWork } from '../../db/unitOfWork.js';
import { Money } from '../../utils/money.js';
import { getBusinessDate } from '../../utils/dateRange.js';
import { BusinessError, ConflictError, NotFoundError, ValidationError } from '../../middleware/errorHandler.js';
import logger from '../../utils/logger.js';
import { quotationRepository } from '../quotations/quotationRepository.js';
import { POS_CONVERTIBLE_QUOTE_STATUSES } from '../sales/quoteConvertibilityGuard.js';

const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

// ─── Normalized Types ───────────────────────────────────────

export interface SalesOrder {
  id: string;
  orderNumber: string;
  customerId: string;
  customerName: string;
  creditLimit: number;
  status: string;
  orderDate: string;
  notes: string | null;
  createdBy: string;
  createdAt: string;
  totalAmount: number;
  totalConfirmed: number;
  totalDelivered: number;
}

export interface SalesOrderLine {
  id: string;
  salesOrderId: string;
  productId: string;
  productName: string;
  sku: string;
  orderedQty: number;
  confirmedQty: number;
  deliveredQty: number;
  openQty: number;
  unitPrice: number;
  lineTotal: number;
}

export interface Delivery {
  id: string;
  deliveryNumber: string;
  salesOrderId: string;
  orderNumber: string;
  customerId: string;
  customerName: string;
  status: string;
  deliveryDate: string;
  notes: string | null;
  createdBy: string;
  createdAt: string;
  totalAmount: number;
  totalCost: number;
}

export interface DistInvoice {
  id: string;
  invoiceNumber: string;
  salesOrderId: string;
  orderNumber: string;
  deliveryId: string;
  deliveryNumber: string;
  customerId: string;
  customerName: string;
  totalAmount: number;
  amountPaid: number;
  amountDue: number;
  status: string;
  issueDate: string;
  dueDate: string | null;
  notes: string | null;
  createdBy: string;
  createdAt: string;
}

// ─── Normalizers ────────────────────────────────────────────

function normalizeSO(row: repo.SalesOrderDbRow): SalesOrder {
  return {
    id: row.id,
    orderNumber: row.order_number,
    customerId: row.customer_id,
    customerName: row.customer_name,
    creditLimit: Money.toNumber(Money.parseDb(row.credit_limit)),
    status: row.status,
    orderDate: row.order_date,
    notes: row.notes,
    createdBy: row.created_by,
    createdAt: row.created_at,
    totalAmount: Money.toNumber(Money.parseDb(row.total_amount)),
    totalConfirmed: Money.toNumber(Money.parseDb(row.total_confirmed)),
    totalDelivered: Money.toNumber(Money.parseDb(row.total_delivered)),
  };
}

function normalizeSOLine(row: repo.SalesOrderLineDbRow): SalesOrderLine {
  return {
    id: row.id,
    salesOrderId: row.sales_order_id,
    productId: row.product_id,
    productName: row.product_name,
    sku: row.sku,
    orderedQty: Money.toNumber(Money.parseDb(row.ordered_qty)),
    confirmedQty: Money.toNumber(Money.parseDb(row.confirmed_qty)),
    deliveredQty: Money.toNumber(Money.parseDb(row.delivered_qty)),
    openQty: Money.toNumber(Money.parseDb(row.open_qty)),
    unitPrice: Money.toNumber(Money.parseDb(row.unit_price)),
    // SSOT: commercial line value is always ordered × price (never confirmed × price).
    lineTotal: Money.toNumber(Money.lineTotal(row.ordered_qty, row.unit_price)),
  };
}

function normalizeDelivery(row: repo.DeliveryDbRow): Delivery {
  return {
    id: row.id,
    deliveryNumber: row.delivery_number,
    salesOrderId: row.sales_order_id,
    orderNumber: row.order_number,
    customerId: row.customer_id,
    customerName: row.customer_name,
    status: row.status,
    deliveryDate: row.delivery_date,
    notes: row.notes,
    createdBy: row.created_by,
    createdAt: row.created_at,
    totalAmount: Money.toNumber(Money.parseDb(row.total_amount)),
    totalCost: Money.toNumber(Money.parseDb(row.total_cost)),
  };
}

function normalizeDistInvoice(row: repo.DistInvoiceDbRow): DistInvoice {
  return {
    id: row.id,
    invoiceNumber: row.invoice_number,
    salesOrderId: row.sales_order_id,
    orderNumber: row.order_number,
    deliveryId: row.delivery_id,
    deliveryNumber: row.delivery_number,
    customerId: row.customer_id,
    customerName: row.customer_name,
    totalAmount: Money.toNumber(Money.parseDb(row.total_amount)),
    amountPaid: Money.toNumber(Money.parseDb(row.amount_paid)),
    amountDue: Money.toNumber(Money.parseDb(row.amount_due)),
    status: row.status,
    issueDate: row.issue_date,
    dueDate: row.due_date,
    notes: row.notes,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

// ─── 1. Create Sales Order with ATP ─────────────────────────

export interface CreateSalesOrderInput {
  customerId: string;
  orderDate?: string;
  notes?: string;
  createdBy: string;
  lines: Array<{
    productId: string;
    orderedQty: number;
    unitPrice: number;
  }>;
}

export async function createSalesOrder(
  pool: Pool, input: CreateSalesOrderInput
): Promise<{ order: SalesOrder; lines: SalesOrderLine[] }> {
  if (!input.lines || input.lines.length === 0) {
    throw new ValidationError('At least one line item is required');
  }

  // Get ATP for all products
  const productIds = input.lines.map(l => l.productId);
  const atpRows = await repo.getAtpForProducts(pool, productIds);
  const atpMap = new Map(atpRows.map(r => [r.product_id, Money.toNumber(Money.parseDb(r.atp))]));

  const orderDate = input.orderDate || getBusinessDate();

  const result = await UnitOfWork.run(pool, async (client) => {
    const orderId = await repo.createSalesOrder(client, {
      customerId: input.customerId,
      orderDate,
      notes: input.notes,
      createdBy: input.createdBy,
    });

    for (const line of input.lines) {
      const atp = atpMap.get(line.productId) ?? 0;
      const confirmedQty = Math.min(line.orderedQty, Math.max(0, atp));

      await repo.addSalesOrderLine(client, {
        salesOrderId: orderId,
        productId: line.productId,
        orderedQty: line.orderedQty,
        confirmedQty,
        unitPrice: line.unitPrice,
      });
    }

    const order = await repo.getSalesOrder(client, orderId);
    const lines = await repo.getSalesOrderLines(client, orderId);
    return { order: order!, lines };
  });

  return {
    order: normalizeSO(result.order),
    lines: result.lines.map(normalizeSOLine),
  };
}

// ─── 1b. Edit Sales Order (SAP VA02 equivalent) ────────────

export interface EditSalesOrderInput {
  orderId: string;
  orderDate?: string;
  notes?: string;
  updatedBy: string;
  lines: Array<{
    /** Existing line ID — omit for new lines */
    id?: string;
    productId: string;
    orderedQty: number;
    unitPrice: number;
  }>;
}

/**
 * Edit an open sales order.
 *
 * Business rules (SAP-aligned):
 *  1. Only OPEN or PARTIALLY_DELIVERED orders can be edited.
 *  2. Lines with deliveries cannot be removed.
 *  3. Ordered qty cannot be reduced below already-delivered qty.
 *  4. Price changes only apply to undelivered portion.
 *  5. New lines can be added; ATP is calculated for them.
 *  6. Confirmed qty is recalculated based on current ATP.
 */
export async function editSalesOrder(
  pool: Pool, input: EditSalesOrderInput
): Promise<{ order: SalesOrder; lines: SalesOrderLine[] }> {
  if (!input.lines || input.lines.length === 0) {
    throw new ValidationError('At least one line item is required');
  }

  const result = await UnitOfWork.run(pool, async (client) => {
    // 1. Load current order + lines
    const order = await repo.getSalesOrder(client, input.orderId);
    if (!order) throw new NotFoundError('Sales order not found');

    if (!['OPEN', 'PARTIALLY_DELIVERED'].includes(order.status)) {
      throw new ValidationError(
        `Cannot edit order in status ${order.status}. Only OPEN or PARTIALLY_DELIVERED orders can be edited.`
      );
    }

    const existingLines = await repo.getSalesOrderLines(client, input.orderId);
    const existingLineMap = new Map(existingLines.map(l => [l.id, l]));

    // 2. Determine which existing lines are being kept (by id in input)
    const inputLineIds = new Set(input.lines.filter(l => l.id).map(l => l.id!));

    // 3. Check lines to be removed — block if any have deliveries
    for (const existing of existingLines) {
      if (!inputLineIds.has(existing.id)) {
        const deliveredQty = Money.toNumber(Money.parseDb(existing.delivered_qty));
        if (deliveredQty > 0) {
          throw new ValidationError(
            `Cannot remove line for "${existing.product_name}" — ${deliveredQty} units already delivered.`
          );
        }
        await repo.deleteSalesOrderLine(client, existing.id);
      }
    }

    // 4. Get ATP for all products in the updated order
    const allProductIds = input.lines.map(l => l.productId);
    const atpRows = await repo.getAtpForProducts(client, allProductIds);
    const atpMap = new Map(atpRows.map(r => [r.product_id, Money.toNumber(Money.parseDb(r.atp))]));

    // 5. Process each line (update existing or add new)
    for (const line of input.lines) {
      if (line.id && existingLineMap.has(line.id)) {
        // ── Update existing line ──
        const existing = existingLineMap.get(line.id)!;
        const deliveredQty = Money.toNumber(Money.parseDb(existing.delivered_qty));

        // Cannot reduce below delivered
        if (line.orderedQty < deliveredQty) {
          throw new ValidationError(
            `Cannot reduce qty for "${existing.product_name}" below delivered amount (${deliveredQty}).`
          );
        }

        // Recalculate confirmed: delivered is locked, confirm up to ATP for remainder
        const atp = atpMap.get(line.productId) ?? 0;
        // Add back the current reservation for this line to get true available
        const currentConfirmed = Money.toNumber(Money.parseDb(existing.confirmed_qty));
        const availableForLine = atp + (currentConfirmed - deliveredQty);
        const newConfirmed = Math.min(line.orderedQty, deliveredQty + Math.max(0, availableForLine));

        await repo.updateSalesOrderLine(client, line.id, {
          orderedQty: line.orderedQty,
          unitPrice: line.unitPrice,
          confirmedQty: Math.max(newConfirmed, deliveredQty), // never below delivered
        });
      } else {
        // ── Add new line ──
        const atp = atpMap.get(line.productId) ?? 0;
        const confirmedQty = Math.min(line.orderedQty, Math.max(0, atp));

        await repo.addSalesOrderLine(client, {
          salesOrderId: input.orderId,
          productId: line.productId,
          orderedQty: line.orderedQty,
          confirmedQty,
          unitPrice: line.unitPrice,
        });
      }
    }

    // 6. Update header
    await repo.updateSalesOrderHeader(client, input.orderId, {
      notes: input.notes ?? null,
      orderDate: input.orderDate,
    });

    // 7. Return updated order
    const updatedOrder = await repo.getSalesOrder(client, input.orderId);
    const updatedLines = await repo.getSalesOrderLines(client, input.orderId);
    return { order: updatedOrder!, lines: updatedLines };
  });

  return {
    order: normalizeSO(result.order),
    lines: result.lines.map(normalizeSOLine),
  };
}

// ─── 2. Create Delivery + Invoice (atomic) ──────────────────

export interface CreateDeliveryInput {
  salesOrderId: string;
  deliveryDate?: string;
  notes?: string;
  createdBy: string;
  lines: Array<{
    salesOrderLineId: string;
    quantity: number;
  }>;
}

export async function createDeliveryWithInvoice(
  pool: Pool, input: CreateDeliveryInput
): Promise<{ delivery: Delivery; invoice: DistInvoice }> {
  if (!input.lines || input.lines.length === 0) {
    throw new ValidationError('At least one delivery line is required');
  }

  // Pre-validation: load order
  const order = await repo.getSalesOrder(pool, input.salesOrderId);
  if (!order) throw new NotFoundError('Sales order not found');
  if (order.status === 'CLOSED' || order.status === 'CANCELLED') {
    throw new BusinessError('Cannot deliver from a closed/cancelled order', 'ERR_DIST_001');
  }

  const orderLines = await repo.getSalesOrderLines(pool, input.salesOrderId);
  const lineMap = new Map(orderLines.map(l => [l.id, l]));

  // Validate each delivery line
  for (const dLine of input.lines) {
    const soLine = lineMap.get(dLine.salesOrderLineId);
    if (!soLine) throw new NotFoundError(`Sales order line ${dLine.salesOrderLineId} not found`);
    const deliverable = Money.toNumber(Money.parseDb(soLine.confirmed_qty))
      - Money.toNumber(Money.parseDb(soLine.delivered_qty));
    if (dLine.quantity > deliverable + 0.001) {
      throw new BusinessError(
        `Cannot deliver ${dLine.quantity} of ${soLine.product_name}. Max deliverable: ${deliverable}`,
        'ERR_DIST_002'
      );
    }
  }

  // Credit limit check
  const outstanding = await repo.getCustomerOutstandingAR(pool, order.customer_id);
  const deliveryTotal = input.lines.reduce((sum, dLine) => {
    const soLine = lineMap.get(dLine.salesOrderLineId)!;
    return sum + dLine.quantity * Money.toNumber(Money.parseDb(soLine.unit_price));
  }, 0);
  const creditLimit = Money.toNumber(Money.parseDb(order.credit_limit));

  if (creditLimit > 0 && (outstanding + deliveryTotal) > creditLimit) {
    throw new BusinessError(
      `Credit limit exceeded. Outstanding: ${outstanding.toFixed(2)}, New invoice: ${deliveryTotal.toFixed(2)}, Limit: ${creditLimit.toFixed(2)}`,
      'ERR_DIST_CREDIT'
    );
  }

  const deliveryDate = input.deliveryDate || getBusinessDate();
  const issueDate = getBusinessDate();

  const result = await UnitOfWork.run(pool, async (client) => {
    // 1. Create delivery header
    const { id: deliveryId, deliveryNumber } = await repo.createDelivery(client, {
      salesOrderId: input.salesOrderId,
      customerId: order.customer_id,
      deliveryDate,
      notes: input.notes,
      createdBy: input.createdBy,
    });

    let totalAmount = new Decimal(0);
    let totalCost = new Decimal(0);
    const invoiceLineData: Array<{
      deliveryLineId: string; productId: string; quantity: number; unitPrice: number; lineTotal: number;
    }> = [];

    // 2. Process each line: add delivery line, deduct stock, update SO line
    for (const dLine of input.lines) {
      const soLine = lineMap.get(dLine.salesOrderLineId)!;
      const unitPrice = Money.toNumber(Money.parseDb(soLine.unit_price));

      // Deduct stock FEFO
      const { totalCost: lineCost } = await repo.deductStockFEFO(
        client, soLine.product_id, dLine.quantity, deliveryId, input.createdBy
      );

      // Add delivery line
      await repo.addDeliveryLine(client, {
        deliveryId,
        salesOrderLineId: dLine.salesOrderLineId,
        productId: soLine.product_id,
        quantity: dLine.quantity,
        unitCost: lineCost / dLine.quantity,
      });

      // Update SO line delivered qty
      await repo.updateSalesOrderLineDelivered(client, dLine.salesOrderLineId, dLine.quantity);

      const lineTotal = new Decimal(dLine.quantity).times(unitPrice).toDecimalPlaces(2).toNumber();
      totalAmount = totalAmount.plus(lineTotal);
      totalCost = totalCost.plus(lineCost);

      // We need the delivery_line id for invoice lines — query it
      const dlResult = await client.query(
        `SELECT id FROM dist_delivery_lines WHERE delivery_id = $1 AND sales_order_line_id = $2`,
        [deliveryId, dLine.salesOrderLineId]
      );
      invoiceLineData.push({
        deliveryLineId: dlResult.rows[0].id,
        productId: soLine.product_id,
        quantity: dLine.quantity,
        unitPrice,
        lineTotal,
      });
    }

    // Mark delivery as POSTED
    await repo.updateDeliveryStatus(client, deliveryId, 'POSTED');

    // 3. Create mandatory invoice (due date defaults to 30 days from issue)
    const dueDateObj = new Date(issueDate);
    dueDateObj.setDate(dueDateObj.getDate() + 30);
    const dueDate = dueDateObj.toISOString().split('T')[0];

    const { id: invoiceId, invoiceNumber } = await repo.createDistInvoice(client, {
      salesOrderId: input.salesOrderId,
      deliveryId,
      customerId: order.customer_id,
      customerName: order.customer_name,
      totalAmount: totalAmount.toNumber(),
      issueDate,
      dueDate,
      createdBy: input.createdBy,
    });

    for (const ild of invoiceLineData) {
      await repo.addDistInvoiceLine(client, {
        invoiceId,
        deliveryLineId: ild.deliveryLineId,
        productId: ild.productId,
        quantity: ild.quantity,
        unitPrice: ild.unitPrice,
        lineTotal: ild.lineTotal,
      });
    }

    // 4. Update sales order status
    const updatedLines = await repo.getSalesOrderLines(client, input.salesOrderId);
    const allDelivered = updatedLines.every(l =>
      Money.toNumber(Money.parseDb(l.delivered_qty)) >= Money.toNumber(Money.parseDb(l.confirmed_qty))
    );
    const hasOpenQty = updatedLines.some(l => Money.toNumber(Money.parseDb(l.open_qty)) > 0);

    if (allDelivered && !hasOpenQty) {
      await repo.updateSalesOrderStatus(client, input.salesOrderId, 'FULLY_DELIVERED');
    } else {
      await repo.updateSalesOrderStatus(client, input.salesOrderId, 'PARTIALLY_DELIVERED');
    }

    const delivery = await repo.getDelivery(client, deliveryId);
    const invoice = await repo.getDistInvoice(client, invoiceId);

    // Sync customer balance & AR from invoices (SSOT)
    const { syncCustomerBalanceFromInvoices } = await import('../../utils/customerBalanceSync.js');
    await syncCustomerBalanceFromInvoices(client, order.customer_id, 'DIST_INVOICE_CREATED');

    // Post GL entries atomically — inside the same transaction so any GL failure
    // rolls back the delivery, invoice, and stock deduction together (SAP LUW pattern)
    // DR COGS / CR Inventory (goods issue)
    if (totalCost.greaterThan(0)) {
      await AccountingCore.createJournalEntry({
        entryDate: deliveryDate,
        description: `Distribution delivery ${delivery!.delivery_number} — COGS`,
        referenceType: 'DIST_DELIVERY',
        referenceId: delivery!.id,
        referenceNumber: delivery!.delivery_number,
        lines: [
          { accountCode: AccountCodes.COGS, description: `COGS — ${delivery!.delivery_number}`, debitAmount: totalCost.toNumber(), creditAmount: 0 },
          { accountCode: AccountCodes.INVENTORY, description: `Inventory reduction — ${delivery!.delivery_number}`, debitAmount: 0, creditAmount: totalCost.toNumber() },
        ],
        userId: input.createdBy,
        idempotencyKey: `DIST_DELIVERY_COGS-${delivery!.id}`,
        source: 'INVENTORY_MOVE' as const,
      }, undefined, client);
    }

    // DR AR / CR Revenue (invoice)
    const invoiceTotalAmt = Money.toNumber(Money.parseDb(invoice!.total_amount));
    if (invoiceTotalAmt > 0) {
      await recordCustomerInvoiceToGL({
        invoiceId: invoice!.id,
        invoiceNumber: invoice!.invoice_number,
        invoiceDate: issueDate,
        totalAmount: invoiceTotalAmt,
        customerId: order.customer_id,
        customerName: order.customer_name,
      }, undefined, client);
    }

    return { delivery: delivery!, invoice: invoice! };
  });

  return {
    delivery: normalizeDelivery(result.delivery),
    invoice: normalizeDistInvoice(result.invoice),
  };
}

// ─── 3. Backorder Re-confirmation ───────────────────────────

export async function reconfirmBackorders(pool: Pool, productId: string): Promise<number> {
  // Get current ATP for this product
  const atpRows = await repo.getAtpForProducts(pool, [productId]);
  if (atpRows.length === 0) return 0;
  let availableAtp = Money.toNumber(Money.parseDb(atpRows[0].atp));
  if (availableAtp <= 0) return 0;

  // Get open order lines for this product (FIFO by order date)
  const openLines = await repo.getSalesOrdersWithOpenLines(pool, productId);
  let confirmed = 0;

  for (const line of openLines) {
    if (availableAtp <= 0) break;
    const openQty = Money.toNumber(Money.parseDb(line.openQty));
    const toConfirm = Math.min(openQty, availableAtp);

    if (toConfirm > 0) {
      await UnitOfWork.run(pool, async (client) => {
        // Get current confirmed from the line
        const soLines = await repo.getSalesOrderLines(client, line.orderId);
        const soLine = soLines.find(l => l.id === line.lineId);
        if (!soLine) return;
        const currentConfirmed = Money.toNumber(Money.parseDb(soLine.confirmed_qty));
        await repo.reserveConfirmedQty(client, line.lineId, currentConfirmed + toConfirm);
      });
      availableAtp -= toConfirm;
      confirmed += toConfirm;
    }
  }

  return confirmed;
}

/**
 * Recalculate confirmed qty on this SO from current ATP (same store as delivery).
 * Can raise or lower confirmed (never below delivered). Fixes over-promise when
 * ATP used to count global batches while delivery deducted at another store.
 */
export async function reconfirmSalesOrder(
  pool: Pool,
  salesOrderId: string,
): Promise<{ confirmedUnits: number; order: SalesOrder; lines: SalesOrderLine[] }> {
  const order = await repo.getSalesOrder(pool, salesOrderId);
  if (!order) throw new NotFoundError('Sales order not found');
  if (order.status === 'CLOSED' || order.status === 'CANCELLED') {
    throw new BusinessError('Cannot reconfirm a closed/cancelled order', 'ERR_DIST_001');
  }

  const soLines = await repo.getSalesOrderLines(pool, salesOrderId);
  const productIds = [...new Set(soLines.map((l) => l.product_id))];
  const atpRows = await repo.getAtpForProducts(pool, productIds);
  const atpMap = new Map(atpRows.map((r) => [r.product_id, Money.toNumber(Money.parseDb(r.atp))]));

  let confirmedDelta = 0;
  await UnitOfWork.run(pool, async (client) => {
    for (const line of soLines) {
      const ordered = Money.toNumber(Money.parseDb(line.ordered_qty));
      const delivered = Money.toNumber(Money.parseDb(line.delivered_qty));
      const currentConfirmed = Money.toNumber(Money.parseDb(line.confirmed_qty));
      const atp = atpMap.get(line.product_id) ?? 0;
      // ATP already subtracts this line's undelivered confirmed — add it back for this line.
      const availableForLine = atp + (currentConfirmed - delivered);
      let newConfirmed = Math.min(ordered, Math.max(0, availableForLine));
      newConfirmed = Math.max(newConfirmed, delivered);
      if (Math.abs(newConfirmed - currentConfirmed) > 0.0001) {
        await repo.reserveConfirmedQty(client, line.id, newConfirmed);
        const delta = newConfirmed - currentConfirmed;
        confirmedDelta += delta;
        atpMap.set(line.product_id, atp - delta);
      }
    }
  });

  const refreshed = await getSalesOrder(pool, salesOrderId);
  return {
    confirmedUnits: Math.max(0, confirmedDelta),
    order: refreshed.order,
    lines: refreshed.lines,
  };
}

// ─── 4. Clearing / Payment ──────────────────────────────────

export interface ClearingInput {
  customerId: string;
  invoiceId: string;
  depositAllocations: Array<{ depositId: string; amount: number }>;
  cashPayment?: {
    amount: number;
    paymentMethod: 'CASH' | 'CARD' | 'MOBILE_MONEY' | 'BANK_TRANSFER';
    referenceNumber?: string;
  };
  notes?: string;
  clearedBy: string;
}

/**
 * Distribution payment shortcut → customer invoice AR SSOT.
 * POS-style tender: cash overage is change; only amount due is posted to AR.
 */
export async function processClearing(
  pool: Pool, input: ClearingInput
): Promise<{
  clearingNumbers: string[];
  receiptNumber?: string;
  totalCleared: number;
  changeGiven: number;
  cashTendered: number;
  cashApplied: number;
}> {
  const invoice = await repo.getDistInvoice(pool, input.invoiceId);
  if (!invoice) throw new NotFoundError('Invoice not found');
  if (invoice.customer_id !== input.customerId) {
    throw new BusinessError('Invoice does not belong to this customer', 'ERR_DIST_CLR_001');
  }

  const { invoiceRepository } = await import('../invoices/invoiceRepository.js');
  await invoiceRepository.healSettlementDrift(pool, input.invoiceId);
  const settlement = await invoiceRepository.getInvoiceSettlement(pool, input.invoiceId);
  const invoiceDue = settlement
    ? settlement.amountDue
    : Money.toNumber(Money.parseDb(invoice.amount_due));
  if (invoiceDue <= 0) throw new BusinessError('Invoice is already paid', 'ERR_DIST_CLR_002');

  let depositRequested = new Decimal(0);
  for (const alloc of input.depositAllocations) {
    if (alloc.amount <= 0) throw new ValidationError('Deposit allocation amount must be positive');
    depositRequested = depositRequested.plus(alloc.amount);
  }
  const cashTendered = input.cashPayment ? new Decimal(input.cashPayment.amount) : new Decimal(0);
  if (input.cashPayment && cashTendered.lte(0)) throw new ValidationError('Cash amount must be positive');

  if (input.depositAllocations.length === 0 && !input.cashPayment) {
    throw new ValidationError('At least one deposit allocation or cash payment is required');
  }

  if (depositRequested.gt(0)) {
    const deposits = await repo.getOpenDepositsForCustomer(pool, input.customerId);
    const depositMap = new Map(deposits.map((d) => [d.id, d]));
    for (const alloc of input.depositAllocations) {
      const dep = depositMap.get(alloc.depositId);
      if (!dep) {
        throw new NotFoundError(`Deposit ${alloc.depositId} not found or exhausted`);
      }
      const available = Money.toNumber(Money.parseDb(dep.amount_available));
      if (available < alloc.amount - 0.01) {
        throw new BusinessError(
          `Deposit ${dep.deposit_number} has ${available.toFixed(2)} available, but ${alloc.amount} was requested`,
          'ERR_DIST_CLR_004',
        );
      }
    }
    // Application posts as one DEPOSIT payment (FIFO across customer deposits) — same as Customer Center.
  }

  const { computeInvoiceTender } = await import('./invoiceTenderChange.js');
  const tender = computeInvoiceTender({
    invoiceDue,
    depositRequested: depositRequested.toNumber(),
    cashTendered: cashTendered.toNumber(),
    paymentMethod: input.cashPayment?.paymentMethod ?? 'CASH',
  });

  if (tender.totalApplied <= 0.009) {
    throw new ValidationError('Nothing to apply — enter deposit and/or tender amount');
  }

  const { invoiceService } = await import('../invoices/invoiceService.js');
  const receiptNumbers: string[] = [];
  let lastReceipt: string | undefined;

  if (tender.depositApplied > 0.009) {
    const depositResult = await invoiceService.addPayment(pool, input.invoiceId, {
      amount: tender.depositApplied,
      paymentMethod: 'DEPOSIT',
      notes: input.notes ?? null,
      processedById: input.clearedBy,
    });
    const rn = String(depositResult.payment.receipt_number ?? '');
    if (rn) {
      receiptNumbers.push(rn);
      lastReceipt = rn;
    }
  }

  if (input.cashPayment && tender.cashApplied > 0.009) {
    const cashResult = await invoiceService.addPayment(pool, input.invoiceId, {
      amount: tender.cashApplied,
      paymentMethod: input.cashPayment.paymentMethod,
      referenceNumber: input.cashPayment.referenceNumber ?? null,
      notes: input.notes ?? null,
      processedById: input.clearedBy,
    });
    const rn = String(cashResult.payment.receipt_number ?? '');
    if (rn) {
      receiptNumbers.push(rn);
      lastReceipt = rn;
    }
  }

  logger.info('Distribution clearing posted via invoice AR SSOT (POS tender)', {
    invoiceId: input.invoiceId,
    customerId: input.customerId,
    invoiceDue,
    cashTendered: cashTendered.toNumber(),
    cashApplied: tender.cashApplied,
    depositApplied: tender.depositApplied,
    changeGiven: tender.changeGiven,
    receipts: receiptNumbers,
  });

  return {
    clearingNumbers: receiptNumbers,
    receiptNumber: lastReceipt,
    totalCleared: tender.totalApplied,
    changeGiven: tender.changeGiven,
    cashTendered: cashTendered.toNumber(),
    cashApplied: tender.cashApplied,
  };
}

// ─── Read Operations ────────────────────────────────────────

export async function getSalesOrder(pool: Pool, id: string): Promise<{ order: SalesOrder; lines: SalesOrderLine[] }> {
  const row = await repo.getSalesOrder(pool, id);
  if (!row) throw new NotFoundError('Sales order not found');
  const lines = await repo.getSalesOrderLines(pool, id);
  return { order: normalizeSO(row), lines: lines.map(normalizeSOLine) };
}

export async function listSalesOrders(
  pool: Pool, filters: { status?: string; customerId?: string; page: number; limit: number }
): Promise<{ data: SalesOrder[]; total: number }> {
  const offset = (filters.page - 1) * filters.limit;
  const { rows, count } = await repo.listSalesOrders(pool, { ...filters, offset, limit: filters.limit });
  return { data: rows.map(normalizeSO), total: count };
}

export async function getDelivery(pool: Pool, id: string): Promise<Delivery> {
  const row = await repo.getDelivery(pool, id);
  if (!row) throw new NotFoundError('Delivery not found');
  return normalizeDelivery(row);
}

export async function listDeliveries(
  pool: Pool, filters: { salesOrderId?: string; status?: string; customerId?: string; page: number; limit: number }
): Promise<{ data: Delivery[]; total: number }> {
  const offset = (filters.page - 1) * filters.limit;
  const { rows, count } = await repo.listDeliveries(pool, { ...filters, offset, limit: filters.limit });
  return { data: rows.map(normalizeDelivery), total: count };
}

export async function getDistInvoice(pool: Pool, id: string): Promise<DistInvoice> {
  const row = await repo.getDistInvoice(pool, id);
  if (!row) throw new NotFoundError('Invoice not found');
  return normalizeDistInvoice(row);
}

export async function listDistInvoices(
  pool: Pool, filters: { customerId?: string; status?: string; salesOrderId?: string; page: number; limit: number }
): Promise<{ data: DistInvoice[]; total: number }> {
  const offset = (filters.page - 1) * filters.limit;
  const { rows, count } = await repo.listDistInvoices(pool, { ...filters, offset, limit: filters.limit });
  return { data: rows.map(normalizeDistInvoice), total: count };
}

export async function getAtpForProducts(pool: Pool, productIds: string[]) {
  const rows = await repo.getAtpForProducts(pool, productIds);
  return rows.map(r => ({
    productId: r.product_id,
    productName: r.product_name,
    sku: r.sku,
    onHand: Money.toNumber(Money.parseDb(r.on_hand)),
    reserved: Money.toNumber(Money.parseDb(r.reserved)),
    atp: Money.toNumber(Money.parseDb(r.atp)),
  }));
}

export async function getClearingScreenData(pool: Pool, customerId: string) {
  const [rawInvoices, deposits] = await Promise.all([
    repo.getOpenDistInvoicesForCustomer(pool, customerId),
    repo.getOpenDepositsForCustomer(pool, customerId),
  ]);
  const { invoiceRepository } = await import('../invoices/invoiceRepository.js');
  const invoices = [];
  for (const row of rawInvoices) {
    await invoiceRepository.healSettlementDrift(pool, row.id);
    const fresh = await repo.getDistInvoice(pool, row.id);
    if (fresh && Money.toNumber(Money.parseDb(fresh.amount_due)) > 0.009) {
      invoices.push(normalizeDistInvoice(fresh));
    }
  }
  const outstanding = await repo.getCustomerOutstandingAR(pool, customerId);

  return {
    invoices,
    deposits: deposits.map(d => ({
      id: d.id,
      depositNumber: d.deposit_number,
      amount: Money.toNumber(Money.parseDb(d.amount)),
      usedAmount: Money.toNumber(Money.parseDb(d.amount_used)),
      remainingAmount: Money.toNumber(Money.parseDb(d.amount_available)),
      paymentMethod: d.payment_method,
      createdAt: d.created_at,
    })),
    outstanding,
  };
}

export async function getBackorders(pool: Pool, productId?: string) {
  const rows = await repo.getSalesOrdersWithOpenLines(pool, productId);
  return rows.map(r => ({
    orderId: r.orderId,
    orderNumber: r.orderNumber,
    customerName: r.customerName,
    lineId: r.lineId,
    productId: r.productId,
    productName: r.productName,
    openQty: Money.toNumber(Money.parseDb(r.openQty)),
  }));
}

// ─── 7. Convert WHOLESALE Quotation → Distribution Sales Order ────

/**
 * Converts a WHOLESALE quotation to a Distribution Sales Order.
 * Only WHOLESALE quotations are eligible (RETAIL uses quotation→sale conversion).
 *
 * SAP equivalent: VA01 from quotation reference.
 *
 * Business rules:
 *   - Quotation must be WHOLESALE fulfillment_mode
 *   - Quotation must be convertible: DRAFT, SENT, or ACCEPTED
 *     (same SSOT as POS retail quote conversion — not DRAFT-blocked)
 *   - ATP is checked and confirmed at conversion time
 *   - Quotation is marked as CONVERTED with reference to the new sales order
 */
export async function convertFromQuotation(
  pool: Pool,
  quotationId: string,
  userId: string,
): Promise<{ order: SalesOrder; lines: SalesOrderLine[]; quotationNumber: string }> {
  // Load quotation
  const quoteData = await quotationRepository.getQuotationById(pool, quotationId);
  if (!quoteData) throw new NotFoundError('Quotation not found');

  const { quotation, items } = quoteData;

  // BR-QUOTE-010: Only WHOLESALE quotations may convert to distribution SO
  if (quotation.fulfillment_mode !== 'WHOLESALE') {
    throw new BusinessError(
      `Quotation ${quotation.quote_number} is ${quotation.fulfillment_mode}. ` +
      `Only WHOLESALE quotations can be converted to Distribution Sales Orders. ` +
      `RETAIL quotations should use the standard Quotation → Sale conversion.`,
      'ERR_DIST_QUOTE_MODE'
    );
  }

  // Status check — same convertible set as POS / retail quote conversion (DRAFT|SENT|ACCEPTED).
  // UI treats these as OPEN via normalizeStatus; rejecting DRAFT alone caused Henber Q-2026-0299 400s.
  if (!(POS_CONVERTIBLE_QUOTE_STATUSES as readonly string[]).includes(quotation.status)) {
    throw new BusinessError(
      `Quotation ${quotation.quote_number} is ${quotation.status}. ` +
      `Only DRAFT, SENT, or ACCEPTED quotations can be converted.`,
      'ERR_DIST_QUOTE_STATUS',
      {
        quotationId,
        quoteNumber: quotation.quote_number,
        currentStatus: quotation.status,
        allowedStatuses: [...POS_CONVERTIBLE_QUOTE_STATUSES],
      },
    );
  }

  // Expiry check
  if (quotation.valid_until && String(quotation.valid_until) < getBusinessDate()) {
    throw new BusinessError(
      `Quotation ${quotation.quote_number} has expired (valid until ${quotation.valid_until}).`,
      'ERR_DIST_QUOTE_EXPIRED'
    );
  }

  // Conversion guard: must not already be converted via either retail or wholesale path
  if (quotation.converted_to_sale_id) {
    throw new ConflictError(
      `Quotation ${quotation.quote_number} has already been converted to sale.`,
    );
  }
  if ((quotation as { converted_to_so_id?: string | null }).converted_to_so_id) {
    throw new ConflictError(
      `Quotation ${quotation.quote_number} has already been converted to a distribution sales order.`,
    );
  }

  // Guard: block if quotation has existing delivery notes (DN fulfillment path)
  const dnCheck = await pool.query(
    `SELECT delivery_note_number, status FROM delivery_notes
     WHERE quotation_id = $1 AND status != 'DRAFT'
     LIMIT 1`,
    [quotationId]
  ).catch(() => ({ rows: [] })); // Graceful if delivery_notes table missing

  if (dnCheck.rows.length > 0) {
    throw new BusinessError(
      `Quotation ${quotation.quote_number} is being fulfilled via Delivery Notes ` +
      `(${dnCheck.rows[0].delivery_note_number} is ${dnCheck.rows[0].status}). ` +
      `Cannot convert to Distribution SO — use the Delivery Notes module instead.`,
      'ERR_DIST_QUOTE_DN_EXISTS'
    );
  }

  // Filter to accepted items only (SAP-style item decisions)
  // Distribution SO requires physical products — skip service/custom items
  const acceptedItems = items.filter(item =>
    (item.item_status === 'ACCEPTED' || item.item_status === 'OPEN') &&
    item.product_id != null
  );
  if (acceptedItems.length === 0) {
    throw new ValidationError('No accepted product items found on the quotation');
  }

  // Build lines from quotation items
  const soLines = acceptedItems.map(item => ({
    productId: item.product_id!,
    orderedQty: Money.toNumber(Money.parseDb(item.quantity)),
    unitPrice: Money.toNumber(Money.parseDb(item.unit_price)),
  }));

  // ATP can be read outside the tx (read-only snapshot is acceptable here).
  const productIds = soLines.map(l => l.productId);
  const atpRows = await repo.getAtpForProducts(pool, productIds);
  const atpMap = new Map(atpRows.map(r => [r.product_id, Money.toNumber(Money.parseDb(r.atp))]));
  const orderDate = getBusinessDate();

  // Single transaction: create SO and claim the quotation atomically.
  // If the claim fails (concurrent conversion attempt), the SO insert is rolled
  // back — no orphaned wholesale order is left behind. This is the SAP VA01-
  // from-reference contract: either the source document is consumed and the
  // target document exists, or neither change happens.
  const txResult = await UnitOfWork.run(pool, async (client) => {
    const orderId = await repo.createSalesOrder(client, {
      customerId: quotation.customer_id!,
      orderDate,
      notes: `Converted from quotation ${quotation.quote_number}`,
      createdBy: userId,
    });

    for (const line of soLines) {
      const atp = atpMap.get(line.productId) ?? 0;
      const confirmedQty = Math.min(line.orderedQty, Math.max(0, atp));
      await repo.addSalesOrderLine(client, {
        salesOrderId: orderId,
        productId: line.productId,
        orderedQty: line.orderedQty,
        confirmedQty,
        unitPrice: line.unitPrice,
      });
    }

    // Atomic convert-once claim — rejects if any other path already converted
    // this quotation (retail sale OR wholesale SO).
    await quotationRepository.markQuotationAsConvertedToSO(client, quotationId, orderId);

    const order = await repo.getSalesOrder(client, orderId);
    const lines = await repo.getSalesOrderLines(client, orderId);
    return { order: order!, lines };
  });

  logger.info('Quotation converted to Distribution SO', {
    quotationNumber: quotation.quote_number,
    orderNumber: txResult.order.order_number,
    lineCount: txResult.lines.length,
  });

  return {
    order: normalizeSO(txResult.order),
    lines: txResult.lines.map(normalizeSOLine),
    quotationNumber: quotation.quote_number,
  };
}
