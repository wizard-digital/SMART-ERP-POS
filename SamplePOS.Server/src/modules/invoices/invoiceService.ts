import { Pool, PoolClient } from 'pg';
import { invoiceRepository, InvoicePaymentRecord } from './invoiceRepository.js';
import { resolveInvoiceSourceQuotation, resolveInvoiceAuthorisedByName } from './invoiceSourceQuotation.js';
import { salesRepository } from '../sales/salesRepository.js';
import logger from '../../utils/logger.js';
import { accountingApiClient } from '../../services/accountingApiClient.js';
import * as depositsService from '../deposits/depositsService.js';
import Decimal from 'decimal.js';
import { Money } from '../../utils/money.js';
import { UnitOfWork, DbConnection } from '../../db/unitOfWork.js';
import * as glEntryService from '../../services/glEntryService.js';
import * as documentFlowService from '../document-flow/documentFlowService.js';
import { getBusinessDate, formatDateBusiness } from '../../utils/dateRange.js';
import * as arPaymentService from '../ar-payments/arPaymentService.js';
import { AR_SSOT_INVOICE_PAYMENT_METHODS } from '../ar-payments/arPaymentService.js';
import * as openItemEngine from '../ar-payments/openItemAllocationEngine.js';
import { ValidationError } from '../../middleware/errorHandler.js';
import {
  assertAppliedEqualsRequested,
  assertDepositPaymentAmount,
  money2,
} from '@shared/domain/invoiceDepositPayment.js';

/** Raw DB row from payment_lines table as returned by salesRepository */
interface PaymentLineRow {
  id: string;
  payment_method: string;
  paymentMethod?: string;
  amount: string | number;
  reference?: string | null;
  created_at: string;
}

/** Raw DB row fields from sales table as accessed in this module */
interface RawSaleRow {
  customer_id?: string | null;
  customerId?: string | null;
  subtotal?: string | number;
  tax_amount?: string | number;
  total_amount?: string | number;
  quote_id?: string | null;
  [key: string]: unknown;
}

/** Raw DB row from sale_items as accessed in this module */
interface RawSaleItemRow {
  id: string;
  product_id?: string;
  productId?: string;
  quantity?: string | number;
  unit_price?: string | number;
  unitPrice?: string | number;
  total_price?: string | number;
  lineTotal?: string | number;
  unit_cost?: string | number;
  unitCost?: string | number;
  product_name?: string | null;
  productName?: string | null;
  name?: string | null;
  product_code?: string | null;
  productCode?: string | null;
  sku?: string | null;
  barcode?: string | null;
  uom_name?: string | null;
  uomName?: string | null;
}

/** Mapped invoice line item for UI display */
interface InvoiceLineItem {
  id: string;
  productId?: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  unitCost: number;
  productName: string | null;
  productCode: string | null;
  uomName: string | null;
  sku: string | null;
  barcode: string | null;
}

/** Row shape from sale_items query for delivery integration */
interface SaleItemDeliveryRow {
  product_id: string;
  product_name: string;
  quantity: number;
  unit_price: string | number;
  line_total: string | number;
}

type InvoicePaymentInput = {
  amount: number;
  paymentMethod: 'CASH' | 'CARD' | 'MOBILE_MONEY' | 'AIRTEL_MONEY' | 'BANK_TRANSFER' | 'CREDIT' | 'DEPOSIT';
  paymentDate?: Date | string | null;
  referenceNumber?: string | null;
  notes?: string | null;
  processedById?: string | null;
};

async function syncLinkedSaleAfterInvoicePayment(
  handle: DbConnection,
  inv: { sale_id: string | null; invoice_number: string },
  fresh: { amount_paid: number | null; total_amount: number | null },
  paymentMethod: string,
  paymentAmount: number,
): Promise<void> {
  if (!inv.sale_id) return;

  const isFullyPaid = new Decimal(fresh.amount_paid || 0).greaterThanOrEqualTo(
    new Decimal(fresh.total_amount),
  );
  const saleResult = await handle.query('SELECT payment_method FROM sales WHERE id = $1', [inv.sale_id]);
  const currentPaymentMethod = saleResult.rows[0]?.payment_method;
  const newPaymentMethod =
    isFullyPaid && currentPaymentMethod === 'CREDIT' ? paymentMethod : currentPaymentMethod;

  await handle.query(
    `UPDATE sales
     SET amount_paid = $1,
         payment_method = $2::payment_method
     WHERE id = $3`,
    [fresh.amount_paid, newPaymentMethod, inv.sale_id],
  );

  logger.info('Sale payment synchronized', {
    saleId: inv.sale_id,
    invoiceNumber: inv.invoice_number,
    amountPaid: fresh.amount_paid,
    paymentAmount,
    isFullyPaid,
    paymentMethodUpdated: currentPaymentMethod !== newPaymentMethod,
    newPaymentMethod,
  });
}

/** Legacy invoice payment path — DEPOSIT and CREDIT only (special GL/deposit handling). */
async function addLegacyInvoicePayment(
  pool: Pool,
  invoiceId: string,
  input: InvoicePaymentInput,
): Promise<{
  invoice: NonNullable<Awaited<ReturnType<typeof invoiceRepository.getInvoiceById>>>;
  payment: InvoicePaymentRecord;
}> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const inv = await invoiceRepository.getInvoiceById(client, invoiceId);
    if (!inv) {
      throw new Error(
        `GHOST PAYMENT PREVENTION: Invoice ${invoiceId} does not exist. ` +
          `Cannot record payment against non-existent invoice. This would create orphaned transaction records.`,
      );
    }

    if (inv.customer_id) {
      const customerCheck = await client.query('SELECT id, name FROM customers WHERE id = $1', [
        inv.customer_id,
      ]);
      if (customerCheck.rows.length === 0) {
        throw new Error(
          `GHOST CUSTOMER: Invoice ${inv.invoice_number} is linked to non-existent customer ${inv.customer_id}. ` +
            `Cannot process payment for invoice with orphaned customer linkage. Data integrity violation detected.`,
        );
      }
    }

    if (input.amount <= 0) {
      throw new Error('Payment amount must be positive and greater than zero');
    }

    const settlement = await invoiceRepository.getInvoiceSettlement(client, invoiceId);
    if (!settlement) {
      throw new Error(`Cannot resolve settlement for invoice ${invoiceId}`);
    }
    const amountDueDec = Money.parseDb(settlement.amountDue);
    const paymentDec = Money.parseDb(input.amount);
    if (paymentDec.greaterThan(amountDueDec)) {
      throw new Error(
        `OVERPAYMENT PREVENTION: Payment of ${paymentDec.toFixed(2)} exceeds outstanding balance. ` +
          `Invoice ${inv.invoice_number} total: ${Money.parseDb(settlement.totalAmount).toFixed(2)}, ` +
          `Settled (payments, credit notes, and credit-sale returns): ${Money.parseDb(settlement.amountPaid).toFixed(2)}, ` +
          `Outstanding: ${amountDueDec.toFixed(2)}`,
      );
    }

    if (input.paymentMethod === 'DEPOSIT') {
      if (!inv.customer_id) {
        throw new Error('Cannot use deposit payment method for invoices without a customer');
      }

      const depositBalance = await depositsService.getCustomerDepositBalance(client, inv.customer_id);
      const paymentExact = assertDepositPaymentAmount({
        amount: paymentDec,
        outstanding: amountDueDec,
        depositAvailable: depositBalance.availableBalance,
      });

      const depositApplicationResult = await depositsService.applyDepositsToSaleInTransaction(
        client,
        inv.customer_id,
        inv.sale_id,
        paymentExact.toFixed(2),
        input.processedById || undefined,
        inv.sale_id ? undefined : { invoiceId },
      );
      assertAppliedEqualsRequested(depositApplicationResult.totalApplied, paymentExact);

      logger.info('Deposit applied to invoice payment', {
        invoiceId,
        invoiceNumber: inv.invoice_number,
        customerId: inv.customer_id,
        amount: paymentExact.toFixed(2),
        depositBalanceBefore: money2(depositBalance.availableBalance).toFixed(2),
        depositBalanceAfter: money2(depositBalance.availableBalance).minus(paymentExact).toFixed(2),
        applicationsCount: depositApplicationResult.applications.length,
        saleId: inv.sale_id,
      });

      const paymentDateStrDeposit =
        input.paymentDate instanceof Date
          ? formatDateBusiness(input.paymentDate)
          : typeof input.paymentDate === 'string'
            ? input.paymentDate
            : getBusinessDate();
      const customerRow = await client.query('SELECT name FROM customers WHERE id = $1', [
        inv.customer_id,
      ]);
      const customerNameForDeposit = customerRow.rows[0]?.name;
      if (!customerNameForDeposit) {
        throw new Error(
          `GHOST CUSTOMER NAME: Invoice ${inv.invoice_number} customer ${inv.customer_id} has no name on master.`,
        );
      }
      for (const app of depositApplicationResult.applications) {
        await glEntryService.recordDepositApplicationToGL(
          {
            applicationId: app.id,
            depositId: app.depositId,
            depositNumber: app.depositNumber || '',
            saleId: inv.sale_id || invoiceId,
            saleNumber: inv.invoice_number,
            applicationDate: paymentDateStrDeposit,
            amount: app.amountApplied,
            customerId: inv.customer_id,
            customerName: customerNameForDeposit,
          },
          pool,
          client,
        );
      }
    }

    const payment = await invoiceRepository.addPayment(client, {
      invoiceId,
      amount: Money.toNumber(paymentDec),
      paymentMethod: input.paymentMethod,
      paymentDate: input.paymentDate || getBusinessDate(),
      referenceNumber: input.referenceNumber || null,
      notes: input.notes || null,
      processedById: input.processedById || null,
    });

    await documentFlowService.linkDocuments(client, 'INVOICE', invoiceId, 'PAYMENT', payment.id, 'PAYS');

    const fresh = await invoiceRepository.recalcInvoice(client, invoiceId);
    if (!fresh) {
      throw new Error('Failed to recalculate invoice after recording payment');
    }

    if (inv.sale_id) {
      const isFullyPaid = new Decimal(fresh.amount_paid || 0).greaterThanOrEqualTo(
        new Decimal(fresh.total_amount),
      );
      const saleResult = await client.query('SELECT payment_method FROM sales WHERE id = $1', [
        inv.sale_id,
      ]);
      const currentPaymentMethod = saleResult.rows[0]?.payment_method;
      const newPaymentMethod =
        isFullyPaid && currentPaymentMethod === 'CREDIT'
          ? input.paymentMethod
          : currentPaymentMethod;

      await client.query(
        `UPDATE sales
         SET amount_paid = $1,
             payment_method = $2::payment_method
         WHERE id = $3`,
        [fresh.amount_paid, newPaymentMethod, inv.sale_id],
      );

      logger.info('Sale payment synchronized', {
        invoiceId,
        saleId: inv.sale_id,
        amountPaid: fresh.amount_paid,
        paymentAmount: input.amount,
        isFullyPaid,
        paymentMethodUpdated: currentPaymentMethod !== newPaymentMethod,
        newPaymentMethod,
      });
    }

    if (inv.customer_id) {
      await openItemEngine.syncCustomerBalanceFromOpenItems(
        client,
        inv.customer_id,
        'INVOICE_PAYMENT',
      );
    }

    const paymentDateStr =
      input.paymentDate instanceof Date
        ? formatDateBusiness(input.paymentDate)
        : typeof input.paymentDate === 'string'
          ? input.paymentDate
          : getBusinessDate();

    await glEntryService.recordInvoicePaymentToGL(
      {
        paymentId: payment.id,
        receiptNumber: payment.receipt_number,
        paymentDate: paymentDateStr,
        amount: input.amount,
        paymentMethod: input.paymentMethod,
        invoiceId,
        invoiceNumber: inv.invoice_number,
        customerId: inv.customer_id,
      },
      pool,
      client,
    );

    await client.query('COMMIT');

    logger.info('Legacy invoice payment committed with GL verification', {
      invoiceId,
      paymentId: payment.id,
      receiptNumber: payment.receipt_number,
      amount: input.amount,
      paymentMethod: input.paymentMethod,
    });

    return { invoice: fresh, payment };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export const invoiceService = {
  /**
   * Create invoice from sale with optional initial payment
   * @param pool - Database connection pool
   * @param input - Invoice creation data (customer, sale linkage, dates, payment)
   * @returns Created invoice with initial payment (if provided)
   * @throws Error if sale already has invoice or validation fails
   *
   * Business Rules:
   * - One invoice per sale (enforced uniqueness)
   * - Customer must match sale customer (if sale has customer)
   * - Invoice amounts derived from sale totals
   * - Initial payment updates invoice balance immediately
   *
   * Invoice Workflow:
   * 1. Check sale doesn't already have invoice
   * 2. Validate customer linkage with sale
   * 3. Derive subtotal, tax, total from sale
   * 4. Create invoice record with auto-generated invoice_number
   * 5. Process initial payment (optional)
   * 6. Recalculate invoice balance
   *
   * Status Management:
   * - DRAFT: Initial state
   * - SENT: Delivered to customer
   * - PAID: Full payment received
   * - PARTIALLY_PAID: Partial payment received
   * - OVERDUE: Past due date with outstanding balance
   * - CANCELLED: Invoice voided
   */
  async createInvoice(
    handle: DbConnection,
    input: {
      customerId: string;
      saleId?: string | null;
      quoteId?: string | null;
      issueDate?: Date | string | null;
      dueDate?: Date | string | null;
      notes?: string | null;
      createdById?: string | null;
      initialPaymentAmount?: number | null;
    }
  ) {
    // ============================================================
    // VALIDATION PHASE (read-only, outside transaction)
    // ============================================================

    // Enforce uniqueness: one invoice per sale
    if (input.saleId) {
      const existing = await invoiceRepository.findBySaleId(handle, input.saleId);
      if (existing) {
        throw new Error('An invoice already exists for this sale');
      }
    }
    // When linked to a sale, derive amounts from the sale
    let subtotal = 0;
    let taxAmount = 0;
    let totalAmount = 0;
    let nonCreditPaymentLinesForInvoice: PaymentLineRow[] = [];
    let saleAmountPaid = 0;

    if (input.saleId) {
      const saleData = await salesRepository.getSaleById(handle, input.saleId);
      if (!saleData) throw new Error(`Sale ${input.saleId} not found`);

      // Cast sale to raw DB field shape (repository types use camelCase but actual DB rows are snake_case)
      const rawSale = saleData.sale as unknown as RawSaleRow;

      logger.info('Invoice creation - Sale data retrieved', {
        saleId: input.saleId,
        hasSaleData: !!saleData,
        hasPaymentLines: !!saleData.paymentLines,
        paymentLinesCount: (saleData.paymentLines || []).length,
        paymentLines: saleData.paymentLines,
      });

      // Ensure customer linkage
      const saleCustomerId = rawSale.customer_id || rawSale.customerId;
      if (saleCustomerId && saleCustomerId !== input.customerId) {
        throw new Error('Sale is linked to a different customer');
      }

      // Get sale totals
      const saleSubtotal = Money.parseDb(rawSale.subtotal).toNumber();
      const saleTaxAmount = Money.parseDb(rawSale.tax_amount).toNumber();
      const saleTotalAmount = Money.parseDb(rawSale.total_amount).toNumber();

      // Calculate amount paid from payment_lines (EXCLUDING CREDIT payments)
      // Credit payments represent the invoice amount, not actual payments
      const paymentLines: PaymentLineRow[] = (saleData.paymentLines ||
        []) as unknown as PaymentLineRow[];
      const creditPaymentLines = paymentLines.filter(
        (line: PaymentLineRow) =>
          line.payment_method === 'CREDIT' || line.paymentMethod === 'CREDIT'
      );
      const nonCreditPaymentLines = paymentLines.filter(
        (line: PaymentLineRow) =>
          line.payment_method !== 'CREDIT' && line.paymentMethod !== 'CREDIT'
      );

      const amountPaid = nonCreditPaymentLines.reduce((sum: Decimal, line: PaymentLineRow) => {
        return sum.plus(new Decimal(line.amount || 0));
      }, new Decimal(0));

      const creditAmount = creditPaymentLines.reduce((sum: Decimal, line: PaymentLineRow) => {
        return sum.plus(new Decimal(line.amount || 0));
      }, new Decimal(0));

      // Hoist for use after invoice creation (auto-record split payments)
      nonCreditPaymentLinesForInvoice = nonCreditPaymentLines;
      saleAmountPaid = Money.toNumber(amountPaid);

      logger.info('Invoice creation - Payment calculation', {
        saleId: input.saleId,
        saleSubtotal,
        saleTaxAmount,
        saleTotalAmount,
        totalPaymentLines: paymentLines.length,
        creditPaymentLines: creditPaymentLines.length,
        nonCreditPaymentLines: nonCreditPaymentLines.length,
        amountPaid: Money.toNumber(amountPaid),
        creditAmount: Money.toNumber(creditAmount),
      });

      // Check if this is a quote-linked sale (quote conversions should always create invoices)
      const isQuoteLinkedSale = input.quoteId || rawSale.quote_id;

      // Invoice should only be created if there's a CREDIT payment OR if it's a quote conversion
      if (!isQuoteLinkedSale && creditAmount.lessThanOrEqualTo(0)) {
        logger.warn('Invoice creation blocked - no credit payment found', {
          saleId: input.saleId,
          saleTotalAmount,
          amountPaid: Money.toNumber(amountPaid),
          creditAmount: Money.toNumber(creditAmount),
        });
        throw new Error('Cannot create invoice: no credit payment in sale');
      }

      if (isQuoteLinkedSale) {
        // For quote conversions, use full sale amounts (formal business transaction)
        subtotal = saleSubtotal;
        taxAmount = saleTaxAmount;
        totalAmount = saleTotalAmount;

        logger.info('Invoice amounts set for quote conversion', {
          saleId: input.saleId,
          quoteId: input.quoteId || rawSale.quote_id,
          invoiceSubtotal: subtotal,
          invoiceTaxAmount: taxAmount,
          invoiceTotalAmount: totalAmount,
        });
      } else {
        // CRITICAL: Invoice must represent the FULL SALE amount (matching salesService Path A)
        // This ensures consistency with:
        //   1. Statement SQL which debits sales.total_amount (full amount)
        //   2. DB trigger which sets customer.balance = SUM(invoices.OutstandingBalance)
        //   3. Non-credit payments recorded below as invoice_payments
        // Without this, statement balance, invoice outstanding, and customer.balance would diverge
        subtotal = saleSubtotal;
        taxAmount = saleTaxAmount;
        totalAmount = saleTotalAmount;
      }

      if (!isQuoteLinkedSale) {
        logger.info('Invoice amounts set from full sale total (consistency with statement)', {
          saleId: input.saleId,
          saleTotalAmount,
          amountPaid,
          creditAmount,
          invoiceSubtotal: subtotal,
          invoiceTaxAmount: taxAmount,
          invoiceTotalAmount: totalAmount,
        });
      }
    } else {
      // For future enhancement: standalone invoice not tied to sale
      // For now require sale linkage to keep amounts consistent
      throw new Error('saleId is required for invoice creation at this time');
    }

    // ============================================================
    // MUTATION PHASE (all writes inside a single transaction)
    // Advisory xact locks in invoiceRepository are now effective.
    // When called from an outer transaction (handle === PoolClient), runOrJoin
    // joins it so the invoice + payments are atomic with the caller's work.
    // ============================================================
    const fresh = await UnitOfWork.runOrJoin(handle, async (client: PoolClient) => {
      // Re-check uniqueness inside transaction (prevent race condition)
      if (input.saleId) {
        const existing = await invoiceRepository.findBySaleId(client, input.saleId);
        if (existing) {
          throw new Error('An invoice already exists for this sale');
        }
      }

      // Fetch customer name for invoice
      const customerResult = await client.query('SELECT name FROM customers WHERE id = $1', [
        input.customerId,
      ]);
      const customerName = (customerResult.rows[0]?.name as string) || 'Unknown Customer';

      const quoteIdForInvoice =
        input.quoteId
        || (input.saleId
          ? ((await client.query('SELECT quote_id FROM sales WHERE id = $1', [input.saleId])).rows[0]
              ?.quote_id as string | null)
          : null)
        || null;

      const invoice = await invoiceRepository.createInvoice(client, {
        customerId: input.customerId,
        customerName,
        saleId: input.saleId || null,
        quoteId: quoteIdForInvoice,
        issueDate: input.issueDate || undefined,
        dueDate: input.dueDate || undefined,
        subtotal,
        taxAmount,
        totalAmount,
        notes: input.notes || null,
        createdById: input.createdById || null,
      });

      // Document Flow: Sale → Invoice
      if (input.saleId) {
        await documentFlowService.linkDocuments(client, 'SALE', input.saleId, 'INVOICE', invoice.id, 'CREATED_FROM');
      }

      // Record initial payments: either from explicit amount OR from sale's non-credit payment lines
      if (input.initialPaymentAmount && input.initialPaymentAmount > 0) {
        // Explicit initial payment amount provided by caller
        await invoiceRepository.addPayment(client, {
          invoiceId: invoice.id,
          amount: input.initialPaymentAmount,
          paymentMethod: 'CASH', // default; controller may override
          paymentDate: getBusinessDate(),
          referenceNumber: null,
          notes: 'Initial payment at invoice creation',
          processedById: input.createdById || null,
        });
      } else if (input.saleId && saleAmountPaid > 0) {
        // Auto-record non-credit payment lines from the linked sale
        // This ensures split payments (e.g. CASH 50,000 + CREDIT 50,800) are reflected on the invoice
        for (const payLine of nonCreditPaymentLinesForInvoice) {
          const lineAmount = Money.parseDb(payLine.amount).toNumber();
          if (lineAmount > 0) {
            const lineMethod = payLine.payment_method || payLine.paymentMethod || 'CASH';
            await invoiceRepository.addPayment(client, {
              invoiceId: invoice.id,
              amount: lineAmount,
              paymentMethod: lineMethod as 'CASH' | 'CARD' | 'MOBILE_MONEY' | 'AIRTEL_MONEY' | 'BANK_TRANSFER',
              paymentDate: getBusinessDate(),
              referenceNumber: payLine.reference || null,
              notes: 'Initial payment from sale',
              processedById: input.createdById || null,
            });

            logger.info('Auto-recorded sale payment on invoice', {
              invoiceId: invoice.id,
              amount: lineAmount,
              paymentMethod: lineMethod,
              saleId: input.saleId,
            });
          }
        }
      }

      // Refresh and recalc invoice after potential payment
      const freshInvoice = await invoiceRepository.recalcInvoice(client, invoice.id);

      if (!freshInvoice) {
        throw new Error('Failed to refresh invoice after creation');
      }

      // BR-INV-003: Recalculate customer balance from invoices (SSOT)
      const { syncCustomerBalanceFromInvoices } = await import('../../utils/customerBalanceSync.js');
      await syncCustomerBalanceFromInvoices(client, input.customerId, 'INVOICE_CREATED');

      return freshInvoice;
    });

    // ============================================================
    // GL POSTING: NOT needed for invoice creation.
    // The sale GL (recordSaleToGL) already posted DR AR / CR Revenue
    // for the credit portion. The invoice is a tracking document only.
    // Invoice *payments* post GL via recordInvoicePaymentToGL below.
    // ============================================================

    // DELIVERY INTEGRATION: Auto-create delivery order for invoice if customer needs delivery.
    // CRITICAL: Non-blocking — invoice creation continues even if delivery creation fails.
    // When createInvoice is composed inside another transaction (handle === PoolClient), the
    // outer caller controls commit timing; we can still queue the side-effect against the
    // underlying Pool which we recover from the handle.
    const postCommitPool: Pool | undefined = UnitOfWork.isPool(handle) ? handle : undefined;
    if (postCommitPool) {
      const pool = postCommitPool;
      setImmediate(async () => {
      try {
        // Only create delivery order if invoice is linked to a sale (has actual products)
        if (fresh.sale_id) {
          const customerResult = await pool.query(
            'SELECT name, phone, email, address FROM customers WHERE id = $1',
            [fresh.customer_id]
          );

          const customer = customerResult.rows[0];

          // Only create delivery order if customer has address (delivery needed)
          if (customer && customer.address && customer.address.trim()) {
            // Get sale items for delivery
            const saleItemsResult = await pool.query(
              'SELECT product_id, product_name, quantity, unit_price, line_total FROM sale_items WHERE sale_id = $1',
              [fresh.sale_id]
            );

            if (saleItemsResult.rows.length > 0) {
              const { createDeliveryOrder } = await import('../delivery/deliveryService.js');

              // Prepare delivery items from sale items
              const deliveryItems = saleItemsResult.rows.map((item: SaleItemDeliveryRow) => ({
                productId: item.product_id,
                productName: item.product_name,
                quantityRequested: item.quantity,
                unitPrice: Money.parseDb(item.unit_price).toNumber(),
                lineTotal: Money.parseDb(item.line_total).toNumber(),
              }));

              const deliveryOrderData = {
                saleId: fresh.sale_id,
                invoiceId: fresh.id,
                customerId: fresh.customer_id,
                customerName: customer.name,
                customerPhone: customer.phone || '',
                customerEmail: customer.email || '',
                deliveryAddress: customer.address,
                items: deliveryItems,
                totalAmount: Money.parseDb(fresh.total_amount).toNumber(),
                deliveryDate: getBusinessDate(), // Today
                priority: 'NORMAL' as const,
                notes: `Auto-generated from invoice ${fresh.invoice_number}`,
              };

              // Create audit context for delivery creation
              const auditContext = {
                userId: input.createdById || 'system',
                sessionId: 'system-auto',
                ipAddress: 'system',
                userAgent: 'InvoiceService-AutoDelivery',
              };

              const deliveryResult = await createDeliveryOrder(deliveryOrderData, auditContext);

              if (deliveryResult.success && deliveryResult.data) {
                logger.info('Auto-created delivery order for invoice', {
                  invoiceId: fresh.id,
                  invoiceNumber: fresh.invoice_number,
                  deliveryNumber: deliveryResult.data.deliveryNumber,
                  customerId: fresh.customer_id,
                  customerName: customer.name,
                });
              } else {
                logger.warn('Failed to auto-create delivery order for invoice', {
                  invoiceId: fresh.id,
                  invoiceNumber: fresh.invoice_number,
                  error: deliveryResult.error,
                });
              }
            }
          } else {
            logger.debug('Skipping delivery order creation for invoice - no customer address', {
              invoiceId: fresh.id,
              invoiceNumber: fresh.invoice_number,
              customerId: fresh.customer_id,
              hasAddress: !!customer?.address?.trim(),
            });
          }
        }
      } catch (error: unknown) {
        logger.error('Unexpected error in delivery integration for invoice', {
          invoiceId: fresh.id,
          invoiceNumber: fresh.invoice_number,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      });
    } else {
      logger.debug('Skipping post-commit auto-delivery dispatch — invoice created inside a composed transaction (no Pool available)', {
        invoiceId: fresh.id,
        invoiceNumber: fresh.invoice_number,
      });
    }

    return { invoice: fresh, initialPayment: null };
  },

  /**
   * Get invoice by ID with full payment history and sale items
   * @param pool - Database connection pool
   * @param id - Invoice UUID
   * @returns Invoice with payments array and sale line items
   * @throws Error if invoice not found
   *
   * Includes:
   * - Invoice header (amounts, dates, status)
   * - All payment records (amount, method, date, reference)
   * - Sale line items (product, quantity, price, cost)
   * - Calculated fields (amount_paid, balance)
   *
   * Use Cases:
   * - Invoice detail page
   * - Payment processing screen
   * - Invoice PDF generation
   * - Customer account statement
   */
  async getInvoiceById(pool: Pool, id: string) {
    const healed = await invoiceRepository.healSettlementDrift(pool, id);
    const inv = healed ?? await invoiceRepository.getInvoiceById(pool, id);
    if (!inv) throw new Error(`Invoice ${id} not found`);
    const payments = await invoiceRepository.listPayments(pool, id);
    // Include sale items for visibility in UI
    let items: InvoiceLineItem[] = [];
    if (inv.sale_id) {
      const saleId = inv.sale_id;
      const saleData = await salesRepository.getSaleById(pool, saleId);
      if (saleData && Array.isArray(saleData.items)) {
        items = (saleData.items as unknown as RawSaleItemRow[]).map((it) => ({
          id: it.id,
          productId: it.product_id ?? it.productId,
          quantity: Money.parseDb(it.quantity).toNumber(),
          unitPrice: Money.parseDb(it.unit_price ?? it.unitPrice).toNumber(),
          lineTotal: Money.parseDb(it.total_price ?? it.lineTotal).toNumber(),
          unitCost: Money.parseDb(it.unit_cost ?? it.unitCost).toNumber(),
          productName: it.product_name ?? it.productName ?? it.name ?? null,
          productCode: it.product_code ?? it.productCode ?? null,
          uomName: (it.uom_name ?? it.uomName ?? null) as string | null,
          sku: it.sku ?? null,
          barcode: it.barcode ?? null,
        }));
      }
    }
    const sourceQuotation = await resolveInvoiceSourceQuotation(pool, inv);
    const invoiceAuthorisedByName = await resolveInvoiceAuthorisedByName(pool, inv);
    return { invoice: inv, payments, items, sourceQuotation, invoiceAuthorisedByName };
  },

  async listInvoices(
    pool: Pool,
    page: number,
    limit: number,
    filters?: { customerId?: string; status?: string }
  ) {
    return invoiceRepository.listInvoices(pool, page, limit, filters);
  },

  async addPayment(
    handle: DbConnection,
    invoiceId: string,
    input: InvoicePaymentInput,
  ) {
    // SSOT: standard clearing methods post through AR open-item engine (one CUSTOMER_PAYMENT GL doc).
    if (AR_SSOT_INVOICE_PAYMENT_METHODS.has(input.paymentMethod)) {
      const result = await arPaymentService.recordInvoicePaymentViaArSsot(handle, invoiceId, input);
      if (result.invoice?.sale_id) {
        await syncLinkedSaleAfterInvoicePayment(
          handle,
          { sale_id: result.invoice.sale_id, invoice_number: result.invoice.invoice_number },
          result.invoice,
          input.paymentMethod,
          input.amount,
        );
      }
      return { invoice: result.invoice, payment: result.payment };
    }

    // DEPOSIT / CREDIT retain legacy path (own transaction, requires a Pool) until those
    // paths are folded into the AR engine. Composed callers using a PoolClient must use
    // one of the AR_SSOT_INVOICE_PAYMENT_METHODS instead.
    if (!UnitOfWork.isPool(handle)) {
      throw new ValidationError(
        `Payment method ${input.paymentMethod} is not supported inside a composed transaction. ` +
        `Use CASH / CARD / MOBILE_MONEY / BANK_TRANSFER, or call addPayment with a Pool.`,
      );
    }
    return addLegacyInvoicePayment(handle, invoiceId, input);
  },

  async listPayments(pool: Pool, invoiceId: string) {
    return invoiceRepository.listPayments(pool, invoiceId);
  },
};
