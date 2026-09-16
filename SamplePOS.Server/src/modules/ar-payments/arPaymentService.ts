import type { Pool, PoolClient } from 'pg';
import Decimal from 'decimal.js';
import * as arPaymentRepository from './arPaymentRepository.js';
import * as openItemEngine from './openItemAllocationEngine.js';
import type { AllocationLineInput, AllocationType } from './openItemAllocationEngine.js';
import { invoiceRepository } from '../invoices/invoiceRepository.js';
import * as glEntryService from '../../services/glEntryService.js';
import { AccountingCore, AccountingError } from '../../services/accountingCore.js';
import { UnitOfWork, DbConnection } from '../../db/unitOfWork.js';
import { checkAccountingPeriodOpen } from '../../utils/periodGuard.js';
import { ValidationError } from '../../middleware/errorHandler.js';
import logger from '../../utils/logger.js';
import { getBusinessDate, formatDateBusiness } from '../../utils/dateRange.js';
import { Money } from '../../utils/money.js';
import * as documentFlowService from '../document-flow/documentFlowService.js';
import type { InvoicePaymentRecord } from '../invoices/invoiceRepository.js';
import * as whtService from '../withholding-tax/whtService.js';
import * as receiptSettlementRepo from '../treasury/receiptSettlementRepository.js';
import { publishNotificationEvent } from '../notifications/notificationPublisher.js';
import { buildBusinessNotificationPayload } from '../notifications/businessNotificationPayload.js';

const REVERSIBLE_AR_PAYMENT_STATUSES = new Set([
  'POSTED',
  'PARTIALLY_ALLOCATED',
  'FULLY_ALLOCATED',
]);

const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000001';

/** Standard clearing methods routed through AR open-item SSOT (not legacy INVOICE_PAYMENT GL). */
export const AR_SSOT_INVOICE_PAYMENT_METHODS = new Set([
  'CASH',
  'CARD',
  'MOBILE_MONEY',
  'BANK_TRANSFER',
]);

export interface RecordInvoicePaymentViaArInput {
  amount: number;
  paymentMethod: string;
  paymentDate?: Date | string | null;
  referenceNumber?: string | null;
  notes?: string | null;
  processedById?: string | null;
}

export interface CreateArPaymentInput {
  customerId: string;
  amount: number;
  paymentDate: string;
  paymentMethod: string;
  reference?: string;
  notes?: string;
  createdById: string;
  autoAllocate?: boolean;
  allocationType?: AllocationType;
  allocations?: AllocationLineInput[];
  /** Optional WHT type — amount is gross AR settlement; cash received = net after customer WHT. */
  whtTypeId?: string;
  certificateNumber?: string;
  /** Optional bank book link (parity with supplier payments / deposit routing). */
  bankAccountId?: string | null;
}

export type ReverseCustomerPaymentResult = {
  paymentId: string;
  paymentNumber: string;
  customerId: string;
  amount: number;
  previousPaymentMethod: string;
  glReversed: boolean;
  reversalTransactionId: string | null;
  allocationsRemoved: number;
  invoiceIds: string[];
  allocationSnapshots: Array<{ invoiceId: string; amount: number }>;
  whtTypeId: string | null;
};

export type CorrectCustomerPaymentMethodInput = {
  newPaymentMethod: string;
  reason: string;
  paymentDate?: string;
  reference?: string;
  notes?: string;
  bankAccountId?: string;
  /** When true (default), re-apply prior invoice allocations on recreate */
  reallocate?: boolean;
};

export async function createCustomerPayment(handle: DbConnection, input: CreateArPaymentInput) {
  const paymentAmount = new Decimal(input.amount);
  if (paymentAmount.lessThanOrEqualTo(0)) {
    throw new ValidationError('Payment amount must be greater than zero');
  }

  const posted = await UnitOfWork.runOrJoin(handle, async (client) => {
    await checkAccountingPeriodOpen(client, input.paymentDate);

    await client.query(`SELECT id FROM customers WHERE id = $1 FOR UPDATE`, [input.customerId]);
    const cust = await client.query(`SELECT id, name FROM customers WHERE id = $1`, [
      input.customerId,
    ]);
    if (!cust.rows[0]) throw new ValidationError('Customer not found');
    const customerName = cust.rows[0].name as string;

    const paymentNumber = await arPaymentRepository.nextPaymentNumber(client);
    const payment = await arPaymentRepository.createPaymentHeader(client, {
      paymentNumber,
      customerId: input.customerId,
      paymentDate: input.paymentDate,
      paymentMethod: input.paymentMethod,
      totalAmount: paymentAmount.toNumber(),
      reference: input.reference,
      notes: input.notes,
      createdById: input.createdById,
      bankAccountId: input.bankAccountId,
    });

    let whtCalc: Awaited<ReturnType<typeof whtService.calculateWht>> = null;
    let whtEntryId: string | undefined;
    if (input.whtTypeId) {
      whtCalc = await whtService.calculateWht(
        input.whtTypeId,
        paymentAmount.toNumber(),
        client,
        'CUSTOMER',
      );
      if (!whtCalc) {
        throw new ValidationError('Payment amount is below the WHT threshold for the selected type');
      }
      const whtEntry = await whtService.recordWhtEntryForPayment(
        {
          whtTypeId: input.whtTypeId,
          paymentId: payment.id,
          baseAmount: whtCalc.baseAmount,
          whtAmount: whtCalc.whtAmount,
          netAmount: whtCalc.netAmount,
          certificateNumber: input.certificateNumber,
          transactionType: 'CUSTOMER_PAYMENT',
        },
        client,
      );
      whtEntryId = whtEntry.id;
    }

    const glResult = await glEntryService.recordCustomerPaymentToGL(
      {
        paymentId: payment.id,
        paymentNumber: payment.paymentNumber,
        customerId: input.customerId,
        customerName,
        amount: paymentAmount.toNumber(),
        paymentDate: input.paymentDate,
        paymentMethod: input.paymentMethod as 'CASH' | 'CARD' | 'MOBILE_MONEY' | 'BANK_TRANSFER',
        reducesAR: true,
        whtAmount: whtCalc?.whtAmount,
        whtTypeName: whtCalc?.whtTypeName,
        whtEntryId,
        whtAccountCode: whtCalc?.accountCode,
      },
      UnitOfWork.isPool(handle) ? handle : undefined,
      client,
    );

    if (whtEntryId) {
      await whtService.linkWhtEntryToGlTransaction(whtEntryId, glResult.transactionId, client);
    }

    let lines = input.allocations ?? [];
    if (input.autoAllocate && lines.length === 0) {
      const open = await openItemEngine.listOpenInvoicesForCustomer(client, input.customerId);
      lines = openItemEngine.buildFifoAllocations(open, paymentAmount);
    }

    const allocationResults =
      lines.length > 0
        ? await applyAllocations(client, {
            paymentId: payment.id,
            customerId: input.customerId,
            paymentDate: input.paymentDate,
            paymentMethod: input.paymentMethod,
            lines,
            allocationType: input.allocationType ?? (input.autoAllocate ? 'FIFO' : 'MANUAL'),
            createdById: input.createdById,
            processedById: input.createdById,
          })
        : [];

    await openItemEngine.syncCustomerBalanceFromOpenItems(
      client,
      input.customerId,
      'AR_PAYMENT_RECEIPT',
    );

    const updated = await arPaymentRepository.findPaymentById(client, payment.id);

    logger.info('AR customer payment posted', {
      paymentId: payment.id,
      paymentNumber,
      customerId: input.customerId,
      amount: paymentAmount.toNumber(),
      allocations: allocationResults.length,
    });

    return {
      payment: updated,
      allocations: allocationResults,
      customerName,
    };
  });

  if (UnitOfWork.isPool(handle) && posted.payment?.id) {
    publishNotificationEvent({
      pool: handle,
      typeKey: 'CUSTOMER_PAYMENT_RECEIVED',
      entityType: 'customer',
      entityId: posted.payment.customerId,
      idempotencyKey: `CUSTOMER_PAYMENT_RECEIVED:payment:${posted.payment.id}`,
      payload: buildBusinessNotificationPayload({
        action: 'Customer paid',
        detail: posted.customerName,
        documentRef: posted.payment.paymentNumber,
        amount: Number(posted.payment.totalAmount || 0),
      }),
      actorUserId: input.createdById,
    });
  }

  return posted;
}

export async function allocatePayment(
  pool: Pool,
  paymentId: string,
  lines: AllocationLineInput[],
  options: {
    allocationType?: AllocationType;
    createdById: string;
    paymentMethod?: string;
    paymentDate?: string;
  },
) {
  return UnitOfWork.run(pool, async (client) => {
    const payment = await arPaymentRepository.findPaymentById(client, paymentId);
    if (!payment) throw new ValidationError('Payment not found');
    if (payment.status === 'REVERSED') {
      throw new ValidationError('Cannot allocate a reversed payment');
    }

    const paymentDate = options.paymentDate ?? payment.paymentDate;
    await checkAccountingPeriodOpen(client, paymentDate);

    const allocationType = options.allocationType ?? 'MANUAL';
    let allocLines = lines;
    if (allocLines.length === 0 && allocationType === 'FIFO') {
      const ledger = await openItemEngine.getPaymentLedger(client, paymentId);
      if (!ledger) throw new ValidationError('Payment not found');
      const open = await openItemEngine.listOpenInvoicesForCustomer(client, payment.customerId);
      allocLines = openItemEngine.buildFifoAllocations(open, ledger.unallocatedAmount);
    }
    if (!allocLines.length) {
      throw new ValidationError('No allocation lines — select invoices or use FIFO with open items');
    }

    const allocations = await applyAllocations(client, {
      paymentId,
      customerId: payment.customerId,
      paymentDate,
      paymentMethod: options.paymentMethod ?? payment.paymentMethod,
      lines: allocLines,
      allocationType,
      createdById: options.createdById,
      processedById: options.createdById,
    });

    await openItemEngine.syncCustomerBalanceFromOpenItems(
      client,
      payment.customerId,
      'AR_PAYMENT_ALLOCATE',
    );

    return {
      payment: await arPaymentRepository.findPaymentById(client, paymentId),
      allocations,
    };
  });
}

/**
 * Apply oldest unallocated receipts (FIFO) onto a single open invoice — used after
 * OB replace so cancelled OB allocations land on the corrected opening balance.
 */
export async function allocateUnallocatedReceiptsToInvoice(
  handle: DbConnection,
  params: {
    customerId: string;
    invoiceId: string;
    createdById: string;
  },
): Promise<{ allocatedTotal: number; allocationCount: number }> {
  return UnitOfWork.runOrJoin(handle, async (client) => {
    let remaining = await openItemEngine.getInvoiceOpenBalance(client, params.invoiceId);
    if (remaining.lessThanOrEqualTo(0.009)) {
      return { allocatedTotal: 0, allocationCount: 0 };
    }

    const receipts = await client.query<{
      id: string;
      unallocated_amount: string;
      payment_date: Date | string;
      payment_method: string;
    }>(
      `SELECT id, unallocated_amount, payment_date, payment_method
       FROM ar_customer_payments
       WHERE customer_id = $1
         AND status NOT IN ('REVERSED', 'CANCELLED', 'DRAFT')
         AND unallocated_amount > 0.009
       ORDER BY payment_date ASC, created_at ASC`,
      [params.customerId],
    );

    let allocatedTotal = new Decimal(0);
    let allocationCount = 0;

    for (const row of receipts.rows) {
      if (remaining.lessThanOrEqualTo(0.009)) break;
      const avail = Money.parseDb(row.unallocated_amount);
      const amt = Decimal.min(remaining, avail);
      if (amt.lessThanOrEqualTo(0.009)) continue;

      const paymentDate = String(row.payment_date).slice(0, 10);
      await applyAllocations(client, {
        paymentId: row.id,
        customerId: params.customerId,
        paymentDate,
        paymentMethod: row.payment_method,
        lines: [{ invoiceId: params.invoiceId, amount: Money.toNumber(amt) }],
        allocationType: 'FIFO',
        createdById: params.createdById,
        processedById: params.createdById,
      });

      allocatedTotal = allocatedTotal.plus(amt);
      remaining = remaining.minus(amt);
      allocationCount += 1;
    }

    if (allocationCount > 0) {
      await openItemEngine.syncCustomerBalanceFromOpenItems(
        client,
        params.customerId,
        'AR_OB_REPLACE_REALLOCATE',
      );
    }

    return {
      allocatedTotal: Money.toNumber(allocatedTotal),
      allocationCount,
    };
  });
}

async function applyAllocations(
  client: import('pg').PoolClient,
  params: {
    paymentId: string;
    customerId: string;
    paymentDate: string;
    paymentMethod: string;
    lines: AllocationLineInput[];
    allocationType: AllocationType;
    createdById: string;
    processedById: string;
  },
) {
  const ledger = await openItemEngine.getPaymentLedger(client, params.paymentId);
  if (!ledger) throw new ValidationError('Payment not found');

  const invoiceOpenById = new Map<string, Decimal>();
  const invoiceCustomerById = new Map<string, string>();
  const invoiceStatusById = new Map<string, string>();

  for (const line of params.lines) {
    const inv = await client.query(
      `SELECT customer_id, status FROM invoices WHERE id = $1`,
      [line.invoiceId],
    );
    if (!inv.rows[0]) throw new ValidationError(`Invoice ${line.invoiceId} not found`);
    invoiceCustomerById.set(line.invoiceId, inv.rows[0].customer_id as string);
    invoiceStatusById.set(line.invoiceId, inv.rows[0].status as string);
    invoiceOpenById.set(line.invoiceId, await openItemEngine.getInvoiceOpenBalance(client, line.invoiceId));
  }

  openItemEngine.validateAllocationLines({
    paymentUnallocated: ledger.unallocatedAmount,
    lines: params.lines,
    invoiceOpenById,
    invoiceCustomerById,
    invoiceStatusById,
    customerId: params.customerId,
  });

  const results: arPaymentRepository.ArPaymentAllocation[] = [];

  for (const line of params.lines) {
    const ip = await invoiceRepository.addPayment(client, {
      invoiceId: line.invoiceId,
      amount: line.amount,
      paymentMethod: params.paymentMethod as 'CASH',
      paymentDate: params.paymentDate,
      processedById: params.processedById,
    });

    const alloc = await arPaymentRepository.createAllocationRow(client, {
      paymentId: params.paymentId,
      invoiceId: line.invoiceId,
      invoicePaymentId: ip.id,
      amount: line.amount,
      allocationType: params.allocationType,
      allocationDate: params.paymentDate,
      createdById: params.createdById,
    });

    await arPaymentRepository.bumpPaymentAllocated(client, params.paymentId, line.amount);
    await invoiceRepository.recalcInvoice(client, line.invoiceId);

    results.push(alloc);
  }

  return results;
}

export async function reverseAllocation(
  pool: Pool,
  allocationId: string,
  reversedById: string,
) {
  return UnitOfWork.run(pool, async (client) => {
    const allocRes = await client.query(
      `SELECT a.*, p.customer_id, p.payment_method, p.payment_date
       FROM ar_payment_allocations a
       JOIN ar_customer_payments p ON p.id = a.payment_id
       WHERE a.id = $1 AND a.status = 'ACTIVE'`,
      [allocationId],
    );
    if (!allocRes.rows[0]) throw new ValidationError('Active allocation not found');

    const row = allocRes.rows[0];
    await checkAccountingPeriodOpen(client, String(row.payment_date).slice(0, 10));

    // Immutable audit: keep invoice_payment row; settlement excludes non-ACTIVE allocations.
    await arPaymentRepository.reverseAllocation(client, allocationId, reversedById);
    await invoiceRepository.recalcInvoice(client, row.invoice_id as string);
    await openItemEngine.syncCustomerBalanceFromOpenItems(
      client,
      row.customer_id as string,
      'AR_ALLOCATION_REVERSAL',
    );

    return { success: true, allocationId };
  });
}

/**
 * Record payment against a specific invoice via AR SSOT.
 * Posts one CUSTOMER_PAYMENT GL document, creates invoice_payment via allocation,
 * and syncs customer balance through open-item engine.
 */
export async function recordInvoicePaymentViaArSsot(
  handle: DbConnection,
  invoiceId: string,
  input: RecordInvoicePaymentViaArInput,
): Promise<{
  invoice: Awaited<ReturnType<typeof invoiceRepository.getInvoiceById>>;
  payment: InvoicePaymentRecord;
  arPaymentId: string;
}> {
  return UnitOfWork.runOrJoin(handle, async (client) => {
    const inv = await invoiceRepository.getInvoiceById(client, invoiceId);
    if (!inv) {
      throw new ValidationError(
        `GHOST PAYMENT PREVENTION: Invoice ${invoiceId} does not exist.`,
      );
    }
    if (!inv.customer_id) {
      throw new ValidationError(
        `Invoice ${inv.invoice_number} has no customer — cannot post AR payment.`,
      );
    }

    const customerCheck = await client.query('SELECT id FROM customers WHERE id = $1', [inv.customer_id]);
    if (customerCheck.rows.length === 0) {
      throw new ValidationError(
        `GHOST CUSTOMER: Invoice ${inv.invoice_number} is linked to non-existent customer ${inv.customer_id}.`,
      );
    }

    const paymentAmount = new Decimal(input.amount);
    if (paymentAmount.lessThanOrEqualTo(0)) {
      throw new ValidationError('Payment amount must be positive and greater than zero');
    }

    const settlement = await invoiceRepository.getInvoiceSettlement(client, invoiceId);
    if (!settlement) {
      throw new ValidationError(`Cannot resolve settlement for invoice ${invoiceId}`);
    }
    const amountDueDec = Money.parseDb(settlement.amountDue);
    if (paymentAmount.greaterThan(amountDueDec)) {
      throw new ValidationError(
        `OVERPAYMENT PREVENTION: Payment of ${paymentAmount.toFixed(2)} exceeds outstanding balance ` +
          `(${amountDueDec.toFixed(2)}) on invoice ${inv.invoice_number}.`,
      );
    }

    const paymentDateStr =
      input.paymentDate instanceof Date
        ? formatDateBusiness(input.paymentDate)
        : typeof input.paymentDate === 'string'
          ? input.paymentDate.slice(0, 10)
          : getBusinessDate();

    // createCustomerPayment now joins our existing transaction (same client).
    const arResult = await createCustomerPayment(client, {
      customerId: inv.customer_id,
      amount: paymentAmount.toNumber(),
      paymentDate: paymentDateStr,
      paymentMethod: input.paymentMethod,
      reference: input.referenceNumber ?? undefined,
      notes: input.notes ?? undefined,
      createdById: input.processedById || SYSTEM_USER_ID,
      autoAllocate: false,
      allocations: [{ invoiceId, amount: paymentAmount.toNumber() }],
      allocationType: 'MANUAL',
    });

    const allocation = arResult.allocations[0];
    const invoicePaymentId = allocation?.invoicePaymentId;
    if (!invoicePaymentId) {
      throw new ValidationError('AR payment posted but invoice allocation row was not created');
    }

    const paymentRows = await client.query<InvoicePaymentRecord>(
      'SELECT * FROM invoice_payments WHERE id = $1',
      [invoicePaymentId],
    );
    const payment = paymentRows.rows[0];
    if (!payment) {
      throw new ValidationError(`Invoice payment row ${invoicePaymentId} not found after allocation`);
    }

    await documentFlowService.linkDocuments(
      client,
      'INVOICE',
      invoiceId,
      'PAYMENT',
      invoicePaymentId,
      'PAYS',
    );

    const fresh = await invoiceRepository.getInvoiceById(client, invoiceId);
    if (!fresh) {
      throw new ValidationError('Invoice not found after payment allocation');
    }

    logger.info('Invoice payment recorded via AR SSOT', {
      invoiceId,
      invoiceNumber: inv.invoice_number,
      invoicePaymentId,
      arPaymentId: arResult.payment?.id,
      amount: paymentAmount.toNumber(),
      paymentMethod: input.paymentMethod,
    });

    return {
      invoice: fresh,
      payment,
      arPaymentId: arResult.payment?.id ?? '',
    };
  });
}

export async function getPaymentWithAllocations(pool: Pool, paymentId: string) {
  const payment = await arPaymentRepository.findPaymentById(pool, paymentId);
  if (!payment) return null;
  const allocations = await arPaymentRepository.findAllocationsByPaymentId(pool, paymentId);
  return { payment, allocations };
}

export async function listCustomerPayments(
  pool: Pool,
  filters: { customerId?: string; search?: string; limit?: number; offset?: number },
) {
  return arPaymentRepository.listPayments(pool, filters);
}

export async function listOpenInvoices(pool: Pool, customerId: string) {
  const client = await pool.connect();
  try {
    return openItemEngine.listOpenInvoicesForCustomer(client, customerId);
  } finally {
    client.release();
  }
}

/**
 * SAP FBRA / Odoo cancel payment (AR): unapply allocations, reverse CUSTOMER_PAYMENT GL, mark REVERSED.
 * Invoices reopen; undeposited funds / AR cash side is restored. Does not create a replacement receipt.
 */
export async function reverseCustomerPayment(
  pool: Pool,
  paymentId: string,
  userId: string,
  reason: string,
  options?: { client?: PoolClient; reversalDate?: string },
): Promise<ReverseCustomerPaymentResult> {
  if (!reason || reason.trim().length < 5) {
    throw new ValidationError('Reversal reason is required (min 5 characters)');
  }

  const run = async (client: PoolClient): Promise<ReverseCustomerPaymentResult> => {
    const payRes = await client.query<{
      id: string;
      payment_number: string;
      customer_id: string;
      payment_method: string;
      total_amount: string | number;
      status: string;
    }>(
      `SELECT id, payment_number, customer_id, payment_method, total_amount, status
       FROM ar_customer_payments
       WHERE id = $1
       FOR UPDATE`,
      [paymentId],
    );
    if (!payRes.rows[0]) {
      throw new ValidationError('Customer payment not found');
    }
    const pay = payRes.rows[0];
    const status = String(pay.status || '').toUpperCase();
    if (status === 'REVERSED') {
      throw new ValidationError(`Payment ${pay.payment_number} is already reversed.`);
    }
    if (!REVERSIBLE_AR_PAYMENT_STATUSES.has(status)) {
      throw new ValidationError(
        `Cannot reverse payment ${pay.payment_number} with status ${pay.status}. ` +
          `Only posted / allocated receipts can be reversed.`,
      );
    }

    const reversalDate = options?.reversalDate || getBusinessDate();
    await checkAccountingPeriodOpen(client, reversalDate);

    const allocations = (
      await arPaymentRepository.findAllocationsByPaymentId(client, paymentId)
    ).filter((a) => a.status === 'ACTIVE');
    const invoiceIds = [...new Set(allocations.map((a) => a.invoiceId))];
    const allocationSnapshots = allocations.map((a) => ({
      invoiceId: a.invoiceId,
      amount: a.amountAllocated,
    }));

    for (const alloc of allocations) {
      await arPaymentRepository.reverseAllocation(client, alloc.id, userId);
      await invoiceRepository.recalcInvoice(client, alloc.invoiceId);
    }

    try {
      await receiptSettlementRepo.voidSettlementForReversedArPayment(client, paymentId);
    } catch (err: unknown) {
      const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: string }).code) : '';
      if (code === 'RECEIPT_ALREADY_DEPOSITED') {
        throw new ValidationError(err instanceof Error ? err.message : String(err));
      }
      throw err;
    }

    const whtRes = await client.query<{ wht_type_id: string }>(
      `SELECT wht_type_id FROM withholding_tax_entries
       WHERE transaction_type = 'CUSTOMER_PAYMENT' AND transaction_id = $1
       LIMIT 1`,
      [paymentId],
    );
    const whtTypeId = whtRes.rows[0]?.wht_type_id ?? null;
    await client.query(
      `DELETE FROM withholding_tax_entries
       WHERE transaction_type = 'CUSTOMER_PAYMENT' AND transaction_id = $1`,
      [paymentId],
    );

    let glReversed = false;
    let reversalTransactionId: string | null = null;
    const glTxn = await client.query<{ Id: string }>(
      `SELECT "Id" FROM ledger_transactions
       WHERE "ReferenceType" = 'CUSTOMER_PAYMENT'
         AND "ReferenceId" = $1
         AND "IsReversed" = FALSE
       ORDER BY "CreatedAt" DESC
       LIMIT 1`,
      [paymentId],
    );

    if (glTxn.rows[0]) {
      try {
        const rev = await AccountingCore.reverseTransaction(
          {
            originalTransactionId: glTxn.rows[0].Id,
            reversalDate,
            reason: `REVERSE ${pay.payment_number}: ${reason.trim()}`,
            userId,
            idempotencyKey: `CUSTOMER_PAYMENT_REVERSE-${paymentId}`,
          },
          pool,
          client,
        );
        glReversed = true;
        reversalTransactionId = rev.transactionId;
      } catch (error: unknown) {
        if (error instanceof AccountingError && error.code === 'ALREADY_REVERSED') {
          glReversed = true;
        } else {
          throw error;
        }
      }
    } else {
      logger.warn('Customer payment reverse: no open GL transaction found', {
        paymentId,
        paymentNumber: pay.payment_number,
      });
    }

    const noteSuffix = `\n[REVERSED ${reversalDate}] ${reason.trim()}`;
    // alloc_bounds: allocated + unallocated = total_amount (cannot zero both while total > 0)
    await client.query(
      `UPDATE ar_customer_payments
       SET status = 'REVERSED',
           allocated_amount = 0,
           unallocated_amount = total_amount,
           notes = LEFT(COALESCE(notes, '') || $2, 2000),
           reversed_by_id = $3,
           reversed_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [paymentId, noteSuffix, userId],
    );

    await openItemEngine.syncCustomerBalanceFromOpenItems(
      client,
      pay.customer_id,
      'AR_PAYMENT_REVERSAL',
    );

    logger.info('Customer payment reversed', {
      paymentId,
      paymentNumber: pay.payment_number,
      glReversed,
      allocationsRemoved: allocations.length,
      userId,
    });

    return {
      paymentId,
      paymentNumber: pay.payment_number,
      customerId: pay.customer_id,
      amount: new Decimal(pay.total_amount).toNumber(),
      previousPaymentMethod: pay.payment_method,
      glReversed,
      reversalTransactionId,
      allocationsRemoved: allocations.length,
      invoiceIds,
      allocationSnapshots,
      whtTypeId,
    };
  };

  if (options?.client) {
    return run(options.client);
  }
  return UnitOfWork.run(pool, run);
}

/**
 * Smart correction: reverse wrong receipt liquidity method and re-post with the correct method
 * (e.g. CASH → BANK_TRANSFER) — same pattern as supplier correctSupplierPaymentMethod.
 */
export async function correctCustomerPaymentMethod(
  pool: Pool,
  paymentId: string,
  input: CorrectCustomerPaymentMethodInput,
  userId: string,
) {
  if (!input.newPaymentMethod?.trim()) {
    throw new ValidationError('newPaymentMethod is required');
  }
  if (!input.reason || input.reason.trim().length < 5) {
    throw new ValidationError('Correction reason is required (min 5 characters)');
  }

  return UnitOfWork.run(pool, async (client) => {
    const existing = await client.query<{ payment_method: string; status: string }>(
      `SELECT payment_method, status FROM ar_customer_payments WHERE id = $1 FOR UPDATE`,
      [paymentId],
    );
    if (!existing.rows[0]) {
      throw new ValidationError('Customer payment not found');
    }
    const status = String(existing.rows[0].status || '').toUpperCase();
    if (!REVERSIBLE_AR_PAYMENT_STATUSES.has(status)) {
      throw new ValidationError('Only posted / allocated receipts can be corrected');
    }
    if (existing.rows[0].payment_method === input.newPaymentMethod) {
      throw new ValidationError(
        `Payment is already recorded as ${input.newPaymentMethod}. Choose a different method.`,
      );
    }

    const reversed = await reverseCustomerPayment(pool, paymentId, userId, input.reason, {
      client,
      reversalDate: input.paymentDate || getBusinessDate(),
    });

    const reallocate = input.reallocate !== false;

    const receipt = await createCustomerPayment(client, {
      customerId: reversed.customerId,
      amount: reversed.amount,
      paymentMethod: input.newPaymentMethod,
      paymentDate: input.paymentDate || getBusinessDate(),
      reference: input.reference || `Corrects ${reversed.paymentNumber}`,
      notes:
        input.notes ||
        `Corrected from ${reversed.previousPaymentMethod} → ${input.newPaymentMethod}. ` +
          `Original: ${reversed.paymentNumber}. ${input.reason.trim()}`,
      createdById: userId,
      autoAllocate: false,
      allocations: reallocate ? reversed.allocationSnapshots : undefined,
      allocationType: 'MANUAL',
      whtTypeId: reversed.whtTypeId || undefined,
      bankAccountId: input.bankAccountId,
    });

    return {
      reversed,
      replacement: receipt,
    };
  });
}
