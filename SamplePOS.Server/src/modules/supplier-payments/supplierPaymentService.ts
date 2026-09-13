/**
 * Supplier Payment Service - Business logic layer
 *
 * PRECISION: All currency calculations use Decimal.js for accuracy
 */

import { Pool, type PoolClient } from 'pg';
import Decimal from 'decimal.js';
import * as supplierPaymentRepository from './supplierPaymentRepository.js';
import { recalculateOutstandingBalance as recalcSupplierBalance } from '../suppliers/supplierRepository.js';
import * as glEntryService from '../../services/glEntryService.js';
import logger from '../../utils/logger.js';
import { UnitOfWork } from '../../db/unitOfWork.js';
import * as documentFlowService from '../document-flow/documentFlowService.js';
import { AccountingCore, AccountingError } from '../../services/accountingCore.js';
import { checkAccountingPeriodOpen } from '../../utils/periodGuard.js';
import { getBusinessDate } from '../../utils/dateRange.js';
import { logOpeningBalanceAudit } from '../../utils/openingBalanceAudit.js';
import { assertPositiveFinite, fiscalPartsFromIsoDate, safeParseInt } from '../../utils/safeParse.js';
import * as auditRepository from '../audit/auditRepository.js';
import { ValidationError } from '../../middleware/errorHandler.js';
import { publishNotificationEvent } from '../notifications/notificationPublisher.js';
import { goodsReceiptRepository } from '../goods-receipts/goodsReceiptRepository.js';
import { PricingEngine } from '../../utils/pricingEngine.js';
import { assertSupplierCreditHeadroom } from '../suppliers/supplierCreditGuard.js';
import * as whtService from '../withholding-tax/whtService.js';
import {
    assertLinkedGrnsReadyForBilling,
    computeGrnBillableTotal,
    validateSupplierInvoiceGrnVariance,
} from './supplierInvoiceGrnValidation.js';
import {
    isSupplierBillCancellable,
    supplierBillCancelBlockReason,
} from '../../../../shared/utils/supplierBillCancelEligibility.js';
import {
    resolveSupplierPaymentCreditAccount,
    paymentMethodFromLiquidityTag,
} from './supplierPaymentPayFrom.js';

// Configure Decimal.js for currency precision
Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

export interface CreateSupplierPaymentInput {
    supplierId: string;
    amount: number;
    paymentMethod: string;
    paymentDate: string;
    reference?: string;
    notes?: string;
    targetInvoiceId?: string;
    /** Banking book to pay from (required when multiple banks / bank or MoMo methods). */
    bankAccountId?: string;
    /** Optional WHT type — amount is gross AP settlement; cash paid = net after WHT. */
    whtTypeId?: string;
    certificateNumber?: string;
    /**
     * Exact invoice allocations (correction path). When set, skips FIFO and applies these only.
     */
    exactAllocations?: Array<{ invoiceId: string; amount: number }>;
}

export interface CreateSupplierInvoiceInput {
    supplierId: string;
    supplierInvoiceNumber?: string;
    invoiceDate: string;
    dueDate?: string;
    notes?: string;
    lineItems: Array<{
        productName: string;
        description?: string;
        quantity: number;
        unitPrice: number;
    }>;
    /**
     * GRN ids to link to this invoice via supplier_invoice_grn_links.
     * When set, also signals to postInvoiceToGL that DR should hit GR/IR Clearing (2150)
     * via the existing InternalReferenceNumber detection.
     */
    grnIds?: string[];
    /**
     * PricingEngine-computed total from the linked GRN.
     * Stored for audit trail and used in variance GL posting.
     * Internal — set by createInvoiceFromGRN, not by UI input.
     */
    grnComputedTotal?: number;
    /**
     * Variance reason when supplier-reported total ≠ GRN computed total.
     * Internal — set by createInvoiceFromGRN after variance enforcement.
     */
    varianceReason?: string;
    /**
     * Override invoice TotalAmount (used when supplier-reported total differs from computed).
     * Internal — set by createInvoiceFromGRN. When set, AP = this amount; GR/IR = grnComputedTotal.
     * @internal
     */
    _overrideTotalAmount?: number;
}

export interface AllocatePaymentInput {
    supplierPaymentId: string;
    supplierInvoiceId: string;
    amount: number;
}

// ============================================================
// SUPPLIER PAYMENTS
// ============================================================

export async function getSupplierPayments(
    pool: Pool,
    options: {
        page?: number;
        limit?: number;
        supplierId?: string;
        paymentMethod?: string;
        search?: string;
        startDate?: string;
        endDate?: string;
    }
) {
    const { page = 1, limit = 50 } = options;
    const offset = (page - 1) * limit;

    const result = await supplierPaymentRepository.findAllPayments(pool, {
        ...options,
        limit,
        offset,
    });

    return {
        items: result.items,
        pagination: {
            page,
            limit,
            total: result.total,
            totalPages: Math.ceil(result.total / limit),
        },
    };
}

export async function getSupplierPaymentById(pool: Pool, id: string) {
    return supplierPaymentRepository.findPaymentById(pool, id);
}

/**
 * Create supplier payment with automatic allocation to outstanding invoices (FIFO by due date)
 *
 * BUSINESS LOGIC:
 * 1. Create the payment record
 * 2. Auto-allocate to outstanding invoices (oldest due date first)
 * 3. Update invoice statuses (Pending → PartiallyPaid → Paid)
 * 4. Update supplier outstanding balance
 * 5. Return detailed receipt data for printing
 */
export async function createSupplierPayment(
    pool: Pool,
    data: CreateSupplierPaymentInput,
    userId?: string,
    options?: { client?: PoolClient },
) {
    const run = async (client: PoolClient) => {
        // Use Decimal.js for precise amount handling
        const paymentAmount = new Decimal(data.amount);

        if (paymentAmount.lessThanOrEqualTo(0)) {
            throw new Error('Payment amount must be greater than zero');
        }

        // ── Layer 2: Row-level lock on supplier to serialize concurrent payments ──
        // Must happen BEFORE any reads/writes so concurrent requests queue up here.
        const supplierLockResult = await client.query<{
            Id: string; CompanyName: string; ContactName: string | null;
            Email: string | null; Phone: string | null;
        }>(
            'SELECT "Id", "CompanyName", "ContactName", "Email", "Phone" FROM suppliers WHERE "Id" = $1 FOR UPDATE',
            [data.supplierId]
        );
        if (!supplierLockResult.rows[0]) {
            throw new ValidationError(`Supplier ${data.supplierId} not found`);
        }
        const supplier = supplierLockResult.rows[0];

        // ── Layer 2: If targeting a specific invoice, lock it and re-read outstanding ──
        // Prevents two payments from both seeing the same outstanding balance.
        if (data.targetInvoiceId) {
            const invoiceLedger = await supplierPaymentRepository.lockAndComputeInvoiceOutstanding(
                client,
                data.targetInvoiceId
            );
            if (!invoiceLedger) {
                throw new ValidationError(`Invoice ${data.targetInvoiceId} not found or deleted`);
            }
            if (invoiceLedger.outstandingBalance.lessThan(0.01)) {
                throw new ValidationError('Invoice has no outstanding balance — it may have already been paid');
            }
            if (paymentAmount.greaterThan(invoiceLedger.outstandingBalance)) {
                throw new ValidationError(
                    `Payment amount (${paymentAmount.toFixed(2)}) exceeds invoice outstanding balance ` +
                    `(${invoiceLedger.outstandingBalance.toFixed(2)})`
                );
            }
        }

        // Resolve pay-from liquidity book (multi-bank / MoMo) before insert
        const payFrom = await resolveSupplierPaymentCreditAccount(client, {
            paymentMethod: data.paymentMethod,
            bankAccountId: data.bankAccountId,
        });
        const effectiveMethod =
            payFrom.bankAccountId && payFrom.glAccountTag
                ? paymentMethodFromLiquidityTag(payFrom.glAccountTag, data.paymentMethod)
                : data.paymentMethod;

        // Create the payment record
        const payment = await supplierPaymentRepository.createPayment(client, {
            supplierId: data.supplierId,
            paymentDate: data.paymentDate,
            paymentMethod: effectiveMethod,
            amount: paymentAmount.toNumber(),
            reference: data.reference,
            notes: data.notes,
            createdById: userId,
            bankAccountId: payFrom.bankAccountId,
        });

        // Auto-allocate to outstanding invoices (FIFO by due date), or exact correction snapshots
        // Use client (not pool) so this read is inside the transaction and sees locked rows.
        let outstandingInvoices = await supplierPaymentRepository.findOutstandingInvoices(
            client,
            data.supplierId
        );

        if (data.exactAllocations?.length) {
            const byId = new Map(outstandingInvoices.map((inv) => [inv.id, inv]));
            outstandingInvoices = [];
            for (const snap of data.exactAllocations) {
                const inv = byId.get(snap.invoiceId);
                if (!inv) {
                    throw new ValidationError(
                        `Cannot re-allocate to invoice ${snap.invoiceId} — not outstanding after reverse.`,
                    );
                }
                // Cap at snapshot amount via temporary outstanding override for the loop below
                outstandingInvoices.push({
                    ...inv,
                    outstandingBalance: Math.min(
                        Number(inv.outstandingBalance),
                        snap.amount,
                    ),
                });
            }
        } else if (data.targetInvoiceId) {
            // If a target invoice is specified, prioritize it by moving it to the front
            const targetIdx = outstandingInvoices.findIndex((inv) => inv.id === data.targetInvoiceId);
            if (targetIdx > 0) {
                const [target] = outstandingInvoices.splice(targetIdx, 1);
                outstandingInvoices = [target, ...outstandingInvoices];
            }
        }

        const allocations: Array<{
            invoiceId: string;
            invoiceNumber: string;
            supplierInvoiceRef: string | null;
            invoiceDate: string | null;
            dueDate: string | null;
            invoiceTotal: number;
            previouslyPaid: number;
            allocationAmount: number;
            newOutstanding: number;
            status: string;
            lineItems: Array<{
                productName: string;
                description: string | null;
                quantity: number;
                unitCost: number;
                lineTotal: number;
                unitOfMeasure: string | null;
            }>;
        }> = [];

        let remainingPayment = paymentAmount;
        let totalAllocated = new Decimal(0);

        for (const invoice of outstandingInvoices) {
            if (remainingPayment.lessThanOrEqualTo(0)) break;

            const invoiceOutstanding = new Decimal(invoice.outstandingBalance);
            const allocationAmount = Decimal.min(remainingPayment, invoiceOutstanding);

            // Create allocation record
            await supplierPaymentRepository.createAllocation(client, {
                supplierPaymentId: payment.id,
                supplierInvoiceId: invoice.id,
                amount: allocationAmount.toNumber(),
            });

            // Document Flow: Supplier Invoice → Supplier Payment
            await documentFlowService.linkDocuments(client, 'SUPPLIER_INVOICE', invoice.id, 'SUPPLIER_PAYMENT', payment.id, 'PAYS');

            // Fetch invoice line items
            const lineItemsResult = await client.query(
                `
                SELECT 
                    "ProductName",
                    "Description",
                    "Quantity",
                    "UnitCost",
                    "LineTotal",
                    "UnitOfMeasure"
                FROM supplier_invoice_line_items
                WHERE "SupplierInvoiceId" = $1
                ORDER BY "LineNumber"
            `,
                [invoice.id]
            );

            const lineItems = lineItemsResult.rows.map((item) => ({
                productName: item.ProductName,
                description: item.Description || null,
                quantity: new Decimal(item.Quantity || 0).toNumber(),
                unitCost: new Decimal(item.UnitCost || 0).toNumber(),
                lineTotal: new Decimal(item.LineTotal || 0).toNumber(),
                unitOfMeasure: item.UnitOfMeasure || null,
            }));

            // Calculate new outstanding for this invoice
            const newOutstanding = invoiceOutstanding.minus(allocationAmount);
            const invoiceTotal = new Decimal(invoice.totalAmount);
            const newPaidAmount = invoiceTotal.minus(newOutstanding);

            // Determine new status
            let newStatus = 'Pending';
            if (newOutstanding.lessThanOrEqualTo(0)) {
                newStatus = 'Paid';
            } else if (newPaidAmount.greaterThan(0)) {
                newStatus = 'PartiallyPaid';
            }

            // Update invoice paid amount and status (replaces trg_supplier_payment_allocation_sync)
            await supplierPaymentRepository.updateInvoicePaidAmount(
                client,
                invoice.id,
                newPaidAmount.toNumber()
            );

            allocations.push({
                invoiceId: invoice.id,
                invoiceNumber: invoice.invoiceNumber || 'N/A',
                supplierInvoiceRef: invoice.supplierInvoiceNumber || null,
                invoiceDate: invoice.invoiceDate || null,
                dueDate: invoice.dueDate || null,
                invoiceTotal: invoiceTotal.toNumber(),
                previouslyPaid: new Decimal(invoice.amountPaid || 0).toNumber(),
                allocationAmount: allocationAmount.toNumber(),
                newOutstanding: newOutstanding.toNumber(),
                status: newStatus,
                lineItems,
            });

            totalAllocated = totalAllocated.plus(allocationAmount);
            remainingPayment = remainingPayment.minus(allocationAmount);

            logger.info('Auto-allocated payment to invoice', {
                paymentId: payment.id,
                invoiceId: invoice.id,
                invoiceNumber: invoice.invoiceNumber,
                amount: allocationAmount.toNumber(),
                newStatus,
            });
        }

        // Calculate summary
        const unallocatedAmount = paymentAmount.minus(totalAllocated);

        // Optional WHT: amount stays gross for open-item; cash GL is net
        let whtCalc: Awaited<ReturnType<typeof whtService.calculateWht>> = null;
        let whtEntryId: string | undefined;
        if (data.whtTypeId) {
            whtCalc = await whtService.calculateWht(
                data.whtTypeId,
                paymentAmount.toNumber(),
                client,
                'SUPPLIER',
            );
            if (!whtCalc) {
                throw new ValidationError('Payment amount is below the WHT threshold for the selected type');
            }
            const whtEntry = await whtService.recordWhtEntryForPayment(
                {
                    whtTypeId: data.whtTypeId,
                    paymentId: payment.id,
                    baseAmount: whtCalc.baseAmount,
                    whtAmount: whtCalc.whtAmount,
                    netAmount: whtCalc.netAmount,
                    certificateNumber: data.certificateNumber,
                },
                client,
            );
            whtEntryId = whtEntry.id;
        }

        // Build receipt data
        const receiptData = {
            payment: {
                id: payment.id,
                paymentNumber: payment.paymentNumber,
                paymentDate: data.paymentDate,
                paymentMethod: effectiveMethod,
                reference: data.reference || null,
                notes: data.notes || null,
                amount: paymentAmount.toNumber(),
                allocatedAmount: totalAllocated.toNumber(),
                unallocatedAmount: unallocatedAmount.toNumber(),
                bankAccountId: payFrom.bankAccountId,
                bankAccountName: payFrom.bankAccountName,
                bankName: payFrom.bankName,
                bankAccountNumber: payFrom.bankAccountNumber,
                glAccountCode: payFrom.creditAccountCode,
                paymentAccountCode: payFrom.creditAccountCode,
                whtAmount: whtCalc?.whtAmount ?? 0,
                netCashAmount: whtCalc?.netAmount ?? paymentAmount.toNumber(),
                whtTypeName: whtCalc?.whtTypeName ?? null,
                certificateNumber: data.certificateNumber || null,
            },
            supplier: {
                id: data.supplierId,
                name: supplier?.CompanyName || 'Unknown',
                contactPerson: supplier?.ContactName || null,
                email: supplier?.Email || null,
                phone: supplier?.Phone || null,
            },
            allocations,
            summary: {
                totalPayment: paymentAmount.toNumber(),
                totalAllocated: totalAllocated.toNumber(),
                unallocatedBalance: unallocatedAmount.toNumber(),
                invoicesPaid: allocations.filter((a) => a.status === 'Paid').length,
                invoicesPartiallyPaid: allocations.filter((a) => a.status === 'PartiallyPaid').length,
                totalInvoicesAffected: allocations.length,
                whtAmount: whtCalc?.whtAmount ?? 0,
                netCashAmount: whtCalc?.netAmount ?? paymentAmount.toNumber(),
            },
            metadata: {
                createdAt: new Date().toISOString(),
                createdBy: userId || 'system',
                receiptType: 'SUPPLIER_PAYMENT_VOUCHER',
            },
        };

        logger.info('Supplier payment created with auto-allocation', {
            paymentId: payment.id,
            paymentNumber: payment.paymentNumber,
            amount: paymentAmount.toNumber(),
            allocatedAmount: totalAllocated.toNumber(),
            invoicesAffected: allocations.length,
            whtAmount: whtCalc?.whtAmount ?? 0,
        });

        // GL: DR AP (gross) / CR Cash (net) / CR WHT Payable (when withheld)
        const glResult = await glEntryService.recordSupplierPaymentToGL(
            {
                paymentId: payment.id,
                paymentNumber: payment.paymentNumber,
                paymentDate: data.paymentDate,
                amount: paymentAmount.toNumber(),
                paymentMethod: effectiveMethod as 'CASH' | 'CARD' | 'BANK_TRANSFER' | 'CHECK' | 'MOBILE_MONEY',
                paymentAccountCode: payFrom.creditAccountCode,
                supplierId: data.supplierId,
                supplierName: supplier?.CompanyName || 'Unknown',
                whtAmount: whtCalc?.whtAmount,
                whtTypeName: whtCalc?.whtTypeName,
                whtEntryId,
                whtAccountCode: whtCalc?.accountCode,
            },
            undefined,
            client
        );

        if (whtEntryId) {
            await whtService.linkWhtEntryToGlTransaction(whtEntryId, glResult.transactionId, client);
        }

        // Recalculate supplier balance from source (replaces trg_sync_supplier_balance_on_payment)
        await recalcSupplierBalance(client, data.supplierId);

        return receiptData;
    };

    if (options?.client) {
        return run(options.client);
    }
    const posted = await UnitOfWork.run(pool, run);
    publishNotificationEvent({
        pool,
        typeKey: 'SUPPLIER_PAYMENT_POSTED',
        entityType: 'supplier_payment',
        entityId: String(posted.payment.id),
        idempotencyKey: `SUPPLIER_PAYMENT_POSTED:supplier_payment:${posted.payment.id}`,
        payload: {
            summary: `Supplier payment ${posted.payment.paymentNumber} posted`,
            documentRef: posted.payment.paymentNumber,
            amount: posted.payment.amount,
        },
        actorUserId: userId || null,
    });
    return posted;
}

export async function updateSupplierPayment(
    pool: Pool,
    id: string,
    data: Partial<CreateSupplierPaymentInput>
) {
    return UnitOfWork.run(pool, async (client) => {
        const payment = await supplierPaymentRepository.updatePayment(client, id, data);
        return payment;
    });
}

export async function deleteSupplierPayment(pool: Pool, id: string) {
    return UnitOfWork.run(pool, async (client) => {
        // Check if payment has allocations
        const allocations = await supplierPaymentRepository.findAllocationsByPaymentId(pool, id);
        if (allocations.length > 0) {
            throw new Error('Cannot delete payment with existing allocations. Remove allocations first.');
        }

        // Get supplierId before deletion for balance recalculation
        const payment = await supplierPaymentRepository.findPaymentById(pool, id);
        const supplierId = payment?.supplierId;

        const result = await supplierPaymentRepository.deletePayment(client, id);

        // Recalculate supplier balance (replaces trg_sync_supplier_balance_on_payment)
        if (supplierId) {
            await recalcSupplierBalance(client, supplierId);
        }

        return result;
    });
}

export type ReverseSupplierPaymentResult = {
    paymentId: string;
    paymentNumber: string;
    supplierId: string;
    amount: number;
    previousPaymentMethod: string;
    glReversed: boolean;
    reversalTransactionId: string | null;
    allocationsRemoved: number;
    invoiceIds: string[];
    allocationSnapshots: Array<{ invoiceId: string; amount: number }>;
    whtTypeId: string | null;
};

export type CorrectSupplierPaymentMethodInput = {
    newPaymentMethod: string;
    reason: string;
    paymentDate?: string;
    reference?: string;
    notes?: string;
    /** Pay-from bank book for the replacement payment */
    bankAccountId?: string;
    /** When true (default), re-apply prior invoice allocations via target + FIFO on recreate */
    reallocate?: boolean;
};

/**
 * SAP FBRA / Odoo cancel payment: unapply allocations, reverse SUPPLIER_PAYMENT GL, mark REVERSED.
 * Bills reopen; cash/bank is restored. Does not create a replacement payment.
 */
export async function reverseSupplierPayment(
    pool: Pool,
    paymentId: string,
    userId: string,
    reason: string,
    options?: { client?: PoolClient; reversalDate?: string },
): Promise<ReverseSupplierPaymentResult> {
    if (!reason || reason.trim().length < 5) {
        throw new ValidationError('Reversal reason is required (min 5 characters)');
    }

    const run = async (client: PoolClient): Promise<ReverseSupplierPaymentResult> => {
        await client.query(`
          ALTER TABLE supplier_payments ADD COLUMN IF NOT EXISTS bank_account_id UUID NULL
        `);
        const payRes = await client.query<{
            Id: string;
            PaymentNumber: string;
            SupplierId: string;
            PaymentMethod: string;
            Amount: string | number;
            Status: string;
            PaymentDate: string;
            bank_account_id: string | null;
        }>(
            `SELECT "Id", "PaymentNumber", "SupplierId", "PaymentMethod", "Amount", "Status", "PaymentDate",
                    bank_account_id
             FROM supplier_payments
             WHERE "Id" = $1 AND deleted_at IS NULL
             FOR UPDATE`,
            [paymentId],
        );
        if (!payRes.rows[0]) {
            throw new ValidationError('Supplier payment not found');
        }
        const pay = payRes.rows[0];
        const status = String(pay.Status || '').toUpperCase();
        if (status === 'REVERSED') {
            throw new ValidationError(
                `Payment ${pay.PaymentNumber} is already reversed.`,
            );
        }
        if (status !== 'COMPLETED') {
            throw new ValidationError(
                `Cannot reverse payment ${pay.PaymentNumber} with status ${pay.Status}. Only COMPLETED payments can be reversed.`,
            );
        }

        const reversalDate = options?.reversalDate || getBusinessDate();
        await checkAccountingPeriodOpen(client, reversalDate);

        const allocations = await supplierPaymentRepository.findAllocationsByPaymentId(client, paymentId);
        const invoiceIds = [...new Set(allocations.map((a) => a.supplierInvoiceId))];
        const allocationSnapshots = allocations.map((a) => ({
            invoiceId: a.supplierInvoiceId,
            amount: new Decimal(a.amount).toNumber(),
        }));

        for (const alloc of allocations) {
            await supplierPaymentRepository.deleteAllocation(client, alloc.id);
        }
        for (const invoiceId of invoiceIds) {
            const sumResult = await client.query(
                `SELECT COALESCE(SUM("AmountAllocated"), 0) as total_paid
                 FROM supplier_payment_allocations
                 WHERE "SupplierInvoiceId" = $1 AND deleted_at IS NULL`,
                [invoiceId],
            );
            const newPaidAmount = new Decimal(sumResult.rows[0].total_paid).toNumber();
            await supplierPaymentRepository.updateInvoicePaidAmount(client, invoiceId, newPaidAmount);
        }

        const whtRes = await client.query<{ wht_type_id: string }>(
            `SELECT wht_type_id FROM withholding_tax_entries
             WHERE transaction_type = 'SUPPLIER_PAYMENT' AND transaction_id = $1
             LIMIT 1`,
            [paymentId],
        );
        const whtTypeId = whtRes.rows[0]?.wht_type_id ?? null;
        // Remove WHT subledger rows so payable control stays aligned after GL reverse
        await client.query(
            `DELETE FROM withholding_tax_entries
             WHERE transaction_type = 'SUPPLIER_PAYMENT' AND transaction_id = $1`,
            [paymentId],
        );

        let glReversed = false;
        let reversalTransactionId: string | null = null;
        const glTxn = await client.query<{ Id: string }>(
            `SELECT "Id" FROM ledger_transactions
             WHERE "ReferenceType" = 'SUPPLIER_PAYMENT'
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
                        reason: `REVERSE ${pay.PaymentNumber}: ${reason.trim()}`,
                        userId,
                        idempotencyKey: `SUPPLIER_PAYMENT_REVERSE-${paymentId}`,
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
            logger.warn('Supplier payment reverse: no open GL transaction found', {
                paymentId,
                paymentNumber: pay.PaymentNumber,
            });
        }

        const noteSuffix = `\n[REVERSED ${reversalDate}] ${reason.trim()}`;
        await client.query(
            `UPDATE supplier_payments
             SET "Status" = 'REVERSED',
                 "AllocatedAmount" = 0,
                 "UnallocatedAmount" = 0,
                 "Notes" = LEFT(COALESCE("Notes", '') || $2, 2000),
                 "UpdatedAt" = NOW()
             WHERE "Id" = $1`,
            [paymentId, noteSuffix],
        );

        await recalcSupplierBalance(client, pay.SupplierId);

        logger.info('Supplier payment reversed', {
            paymentId,
            paymentNumber: pay.PaymentNumber,
            glReversed,
            allocationsRemoved: allocations.length,
            userId,
        });

        return {
            paymentId,
            paymentNumber: pay.PaymentNumber,
            supplierId: pay.SupplierId,
            amount: new Decimal(pay.Amount).toNumber(),
            previousPaymentMethod: pay.PaymentMethod,
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
 * Smart correction: reverse wrong liquidity payment and re-post with the correct method
 * (e.g. CASH → BANK_TRANSFER) in one transaction — SAP reset+repay / Odoo cancel+recreate.
 */
export async function correctSupplierPaymentMethod(
    pool: Pool,
    paymentId: string,
    input: CorrectSupplierPaymentMethodInput,
    userId: string,
) {
    if (!input.newPaymentMethod?.trim()) {
        throw new ValidationError('newPaymentMethod is required');
    }
    if (!input.reason || input.reason.trim().length < 5) {
        throw new ValidationError('Correction reason is required (min 5 characters)');
    }

    return UnitOfWork.run(pool, async (client) => {
        const existing = await client.query<{ PaymentMethod: string; Status: string }>(
            `SELECT "PaymentMethod", "Status" FROM supplier_payments WHERE "Id" = $1 AND deleted_at IS NULL FOR UPDATE`,
            [paymentId],
        );
        if (!existing.rows[0]) {
            throw new ValidationError('Supplier payment not found');
        }
        if (String(existing.rows[0].Status).toUpperCase() !== 'COMPLETED') {
            throw new ValidationError('Only COMPLETED payments can be corrected');
        }
        if (existing.rows[0].PaymentMethod === input.newPaymentMethod) {
            throw new ValidationError(
                `Payment is already recorded as ${input.newPaymentMethod}. Choose a different method.`,
            );
        }

        const reversed = await reverseSupplierPayment(pool, paymentId, userId, input.reason, {
            client,
            reversalDate: input.paymentDate || getBusinessDate(),
        });

        const reallocate = input.reallocate !== false;

        const receipt = await createSupplierPayment(
            pool,
            {
                supplierId: reversed.supplierId,
                amount: reversed.amount,
                paymentMethod: input.newPaymentMethod,
                paymentDate: input.paymentDate || getBusinessDate(),
                reference: input.reference || `Corrects ${reversed.paymentNumber}`,
                notes:
                    input.notes ||
                    `Corrected from ${reversed.previousPaymentMethod} → ${input.newPaymentMethod}. ` +
                        `Original: ${reversed.paymentNumber}. ${input.reason.trim()}`,
                exactAllocations: reallocate ? reversed.allocationSnapshots : undefined,
                whtTypeId: reversed.whtTypeId || undefined,
                bankAccountId: input.bankAccountId,
            },
            userId,
            { client },
        );

        return {
            reversed,
            replacement: receipt,
        };
    });
}

// ============================================================
// SUPPLIER INVOICES
// ============================================================

export async function getSupplierInvoices(
    pool: Pool,
    options: {
        page?: number;
        limit?: number;
        supplierId?: string;
        status?: string;
        search?: string;
        startDate?: string;
        endDate?: string;
    }
) {
    const { page = 1, limit = 50 } = options;
    const offset = (page - 1) * limit;

    const result = await supplierPaymentRepository.findAllInvoices(pool, {
        ...options,
        limit,
        offset,
    });

    return {
        items: result.items,
        pagination: {
            page,
            limit,
            total: result.total,
            totalPages: Math.ceil(result.total / limit),
        },
    };
}

export async function getInvoiceSummary(pool: Pool) {
    return supplierPaymentRepository.getInvoiceSummary(pool);
}

export async function getSupplierInvoiceById(pool: Pool, id: string) {
    return supplierPaymentRepository.findInvoiceById(pool, id);
}

export async function getSupplierInvoiceWithDetails(pool: Pool, id: string) {
    return supplierPaymentRepository.findInvoiceWithDetails(pool, id);
}

export async function getSupplierInvoicesBySupplier(pool: Pool, supplierId: string) {
    return supplierPaymentRepository.findInvoicesBySupplier(pool, supplierId);
}

export async function getOutstandingInvoices(pool: Pool, supplierId: string) {
    return supplierPaymentRepository.findOutstandingInvoices(pool, supplierId);
}

export async function getAllUnpaidInvoicesForMassPayment(
    pool: Pool,
    options: { asOfDate?: string; supplierId?: string; search?: string } = {}
) {
    return supplierPaymentRepository.findAllUnpaidInvoicesForMassPayment(pool, options);
}

export async function createSupplierInvoice(
    pool: Pool,
    data: CreateSupplierInvoiceInput,
    userId?: string
) {
    return UnitOfWork.run(pool, async (client) => {
        // Calculate subtotal from line items using Decimal.js for precision
        const subtotal = data.lineItems.reduce(
            (sum, item) => sum.plus(new Decimal(item.quantity).times(new Decimal(item.unitPrice))),
            new Decimal(0)
        );
        const taxAmount = new Decimal(0); // Can be calculated if tax logic is needed

        // RULE: When _overrideTotalAmount is provided (set by createInvoiceFromGRN after
        // variance enforcement), use it as the AP amount (supplier reported total).
        // Otherwise totalAmount = computed subtotal. This ensures that:
        //   - For variance invoices: AP = supplier total, GR/IR cleared at grnComputedTotal
        //   - For normal invoices:   AP = computed total (same as GR/IR)
        const totalAmount = data._overrideTotalAmount !== undefined
            ? new Decimal(data._overrideTotalAmount)
            : subtotal.plus(taxAmount);

        let grnComputedTotal = data.grnComputedTotal;
        let varianceReason = data.varianceReason;

        // GR-linked bills: verify COMPLETED GRs, then bound invoice total to received value.
        if (data.grnIds && data.grnIds.length > 0) {
            const linked = await assertLinkedGrnsReadyForBilling(
                client,
                data.grnIds,
                data.supplierId,
            );
            grnComputedTotal = linked.billableTotal.toNumber();
            const varianceCheck = validateSupplierInvoiceGrnVariance({
                grnComputedTotal: linked.billableTotal,
                invoiceTotal: totalAmount,
                varianceReason: data.varianceReason,
                grLabel: linked.receiptNumbers.join(', '),
            });
            if (varianceCheck.hasVariance) {
                varianceReason = varianceCheck.normalizedReason;
            }
        }

        // Default dueDate to invoiceDate + 30 days when not provided (DueDate is NOT NULL in DB)
        const resolvedDueDate = data.dueDate || (() => {
            const d = new Date(data.invoiceDate + 'T00:00:00Z');
            d.setUTCDate(d.getUTCDate() + 30);
            return d.toISOString().slice(0, 10);
        })();

        const invoice = await supplierPaymentRepository.createInvoice(client, {
            supplierId: data.supplierId,
            supplierInvoiceNumber: data.supplierInvoiceNumber,
            invoiceDate: data.invoiceDate,
            dueDate: resolvedDueDate,
            subtotal: subtotal.toNumber(),
            taxAmount: taxAmount.toNumber(),
            totalAmount: totalAmount.toNumber(),
            notes: data.notes,
            grnComputedTotal,
            varianceReason,
        });

        // Persist line items into supplier_invoice_line_items
        if (data.lineItems && data.lineItems.length > 0) {
            const mappedLineItems = data.lineItems.map((item) => ({
                productId: '',
                productName: item.productName,
                description: item.description,
                quantity: item.quantity,
                unitOfMeasure: 'EA',
                unitCost: item.unitPrice,
                taxRate: 0,
                taxAmount: 0,
            }));
            await supplierPaymentRepository.createInvoiceLineItems(client, invoice.id, mappedLineItems);
        }

        // Link to GRNs (3-way match) so postInvoiceToGL clears GR/IR (2150)
        if (data.grnIds && data.grnIds.length > 0) {
            await supplierPaymentRepository.linkInvoiceToGRNs(client, invoice.id, data.grnIds);
        }

        logger.info('Supplier invoice created', {
            invoiceId: invoice.id,
            totalAmount: totalAmount.toNumber(),
            supplierId: data.supplierId,
            grnIds: data.grnIds,
        });

        // Recalculate supplier outstanding balance after invoice creation
        await recalcSupplierBalance(client, data.supplierId);

        return invoice;
    });
}

export async function deleteSupplierInvoice(pool: Pool, id: string) {
    return UnitOfWork.run(pool, async (client) => {
        // Check if invoice has payments
        const invoice = await supplierPaymentRepository.findInvoiceById(pool, id);
        if (invoice && invoice.amountPaid > 0) {
            throw new Error('Cannot delete invoice with existing payments.');
        }

        const result = await supplierPaymentRepository.deleteInvoice(client, id);

        // Recalculate supplier balance after deletion
        if (invoice?.supplierId) {
            await recalcSupplierBalance(client, invoice.supplierId);
        }

        return result;
    });
}

// ============================================================
// 3-WAY MATCH: CREATE SUPPLIER INVOICE FROM A GOODS RECEIPT
// ============================================================
// One-click "Bill This Receipt" workflow used by the Supplier Liability Workspace.
//   1. Loads GR header + items
//   2. Builds line items from received (non-bonus) quantities at GR cost
//   3. Calls createSupplierInvoice with grnIds=[grnId] and InternalReferenceNumber
//      set to the GR receipt_number (text link consumed by postInvoiceToGL routing)
//   4. Calls postInvoiceToGL → DR GR/IR Clearing (2150) / CR Accounts Payable (2100)
// ============================================================

export interface CreateInvoiceFromGRNInput {
    grnId: string;
    /** Supplier-provided invoice number (free text). Defaults to the GR receipt_number. */
    supplierInvoiceNumber?: string;
    /** Optional override; defaults to invoice date + 30 days. */
    dueDate?: string;
    /** Optional invoice date; defaults to GR received_date. */
    invoiceDate?: string;
    notes?: string;
    /**
     * The total printed on the supplier's physical invoice.
     *
     * ACCOUNTING RULE:
     *   - This field is a REFERENCE only. It never alters line quantities, unit costs,
     *     or inventory valuation — those are always derived from GRN data.
     *   - When provided and it differs from the GRN computed total by more than 0.005,
     *     the system blocks posting and requires a varianceReason.
     *   - When a valid varianceReason is supplied, the system posts a 3-line GL entry:
     *       DR GR/IR (2150)         grnComputedTotal   ← fully clears clearing account
     *       CR Accounts Payable     supplierReportedTotal ← what we owe supplier
     *       CR/DR Price Variance    difference         ← absorbs the mismatch
     */
    supplierReportedTotal?: number;
    /**
     * Why the supplier-reported total differs from the GRN computed total.
     * Required when |supplierReportedTotal − grnComputedTotal| > 0.005.
     *
     * 'EDIT_LINE_PRICES' is NOT a posting reason — it instructs the user to
     * correct the GRN line costs before billing. The system rejects posting
     * when this is the selected reason.
     */
    varianceReason?: 'SUPPLIER_DISCOUNT' | 'ROUNDING_DIFFERENCE' | 'PRICE_VARIANCE' | 'EDIT_LINE_PRICES';
}

/**
 * Normalize any date-ish value (Date, ISO string, 'YYYY-MM-DD HH:mm:ss+TZ')
 * to plain 'YYYY-MM-DD' for downstream Zod schemas / DATE columns.
 */
function normalizeToDateOnly(value: string | Date | null | undefined): string {
    if (!value) return new Date().toISOString().slice(0, 10);
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    const s = String(value).trim();
    // Already a date-only string
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    // Take leading date portion of any ISO/timestamp string
    const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
    // Last resort: try Date()
    const d = new Date(s);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    return new Date().toISOString().slice(0, 10);
}

export async function createInvoiceFromGRN(
    pool: Pool,
    input: CreateInvoiceFromGRNInput,
    userId?: string,
) {
    const grRecord = await goodsReceiptRepository.getGRById(pool, input.grnId);
    if (!grRecord) {
        throw new ValidationError(`Goods Receipt ${input.grnId} not found`);
    }
    const { gr, items } = grRecord;
    if (gr.status !== 'COMPLETED') {
        throw new ValidationError(`Cannot bill GR ${gr.grNumber} — status is ${gr.status}, expected COMPLETED`);
    }

    const grReversed = Boolean(
        (gr as { isReversed?: boolean }).isReversed
        || (gr as { reversedByReturnGrnId?: string | null }).reversedByReturnGrnId,
    );
    if (grReversed) {
        const rgrn =
            (gr as { reversedByReturnGrnNumber?: string | null }).reversedByReturnGrnNumber
            || (gr as { reversedByReturnGrnId?: string | null }).reversedByReturnGrnId
            || 'return GRN';
        throw new ValidationError(
            `Cannot bill GR ${gr.grNumber} — receipt was fully reversed (uninvoiced) by ${rgrn}. No AP liability remains.`,
        );
    }

    const supplierId = (gr as { supplierId?: string }).supplierId;
    if (!supplierId) {
        throw new ValidationError(`GR ${gr.grNumber} has no supplier — cannot create invoice`);
    }

    // Prevent double-billing: refuse if any active invoice already links this GR
    const existing = await pool.query(
        `SELECT si."SupplierInvoiceNumber"
           FROM supplier_invoice_grn_links sigl
           JOIN supplier_invoices si ON si."Id" = sigl.invoice_id
          WHERE sigl.grn_id = $1
            AND si.deleted_at IS NULL
            AND COALESCE(si."Status", '') NOT IN ('Cancelled', 'CANCELLED', 'Voided', 'VOIDED')
          LIMIT 1`,
        [input.grnId],
    );
    if (existing.rows.length > 0) {
        throw new ValidationError(
            `GR ${gr.grNumber} is already billed under invoice ${existing.rows[0].SupplierInvoiceNumber}`,
        );
    }

    if (gr.purchaseOrderId) {
        const siblingBill = await goodsReceiptRepository.findPoSiblingSupplierBill(
            pool,
            gr.purchaseOrderId,
            input.grnId,
        );
        if (siblingBill) {
            throw new ValidationError(
                `PO already billed on ${siblingBill.grnNumber} (${siblingBill.invoiceNumber}). ` +
                    `Top-up receipts on the same PO are covered by that bill — no separate supplier invoice.`,
            );
        }
    }

    // Build line items from received non-bonus items.
    // RULE: Totals are derived exclusively from GRN quantities × unit costs.
    //       The supplier-reported total is a REFERENCE field only.
    const billableItems = items.filter((it) => !it.isBonus);
    const lineItems = billableItems.map((it) => ({
        productName: it.productName || 'Item',
        description: it.batchNumber ? `Batch ${it.batchNumber}` : undefined,
        quantity: new Decimal(it.receivedQuantity).toNumber(),
        unitPrice: new Decimal(it.unitCost).toNumber(),
    }));

    if (lineItems.length === 0) {
        throw new ValidationError(`GR ${gr.grNumber} has no billable (non-bonus) items`);
    }

    // ── PricingEngine SSOT: authoritative billable total from linked GR ───────
    const linked = await assertLinkedGrnsReadyForBilling(pool, [input.grnId], supplierId);
    const grnComputedTotal = linked.billableTotal;

    // ── Variance enforcement ────────────────────────────────────────────────
    let resolvedInvoiceTotal = grnComputedTotal;
    let resolvedVarianceReason: string | undefined;

    if (input.supplierReportedTotal !== undefined) {
        const supplierTotal = new Decimal(input.supplierReportedTotal);
        const varianceCheck = validateSupplierInvoiceGrnVariance({
            grnComputedTotal,
            invoiceTotal: supplierTotal,
            varianceReason: input.varianceReason,
            grLabel: gr.grNumber,
        });
        if (varianceCheck.hasVariance) {
            resolvedInvoiceTotal = supplierTotal;
            resolvedVarianceReason = varianceCheck.normalizedReason;
        }
    }
    // else: bill = GRN computed total (line items below); createSupplierInvoice re-validates via grnIds.

    const invoiceDate = input.invoiceDate || normalizeToDateOnly(gr.receivedDate as unknown as string | Date);
    const grNumber = gr.grNumber;

    const created = await createSupplierInvoice(
        pool,
        {
            supplierId,
            supplierInvoiceNumber: input.supplierInvoiceNumber || grNumber,
            invoiceDate,
            dueDate: input.dueDate,
            notes: input.notes || `Bill for Goods Receipt ${grNumber}`,
            lineItems,
            grnIds: [input.grnId],
            // Variance metadata stored on the invoice for audit trail
            grnComputedTotal: grnComputedTotal.toNumber(),
            varianceReason: resolvedVarianceReason,
            // Override totalAmount when there is an acknowledged variance
            _overrideTotalAmount: resolvedInvoiceTotal.toNumber(),
        },
        userId,
    );

    // Post GL immediately so GR/IR Clearing (2150) is cleared and AP (2100) recognized.
    // The variance data is read from the invoice record inside postInvoiceToGL.
    //
    // ATOMICITY: createSupplierInvoice and postInvoiceToGL run in separate transactions.
    // If GL posting fails, the invoice record already exists. We compensate by deleting
    // the invoice so the operation is fully rolled back from the user's perspective.
    // The user will see an error and can safely retry.
    try {
        await postInvoiceToGL(pool, created.id);
    } catch (glError: unknown) {
        const detail = glError instanceof Error ? glError.message : String(glError);
        logger.error('GL posting failed after invoice creation — compensating by deleting invoice', {
            invoiceId: created.id,
            invoiceNumber: created.invoiceNumber,
            supplierId,
            grNumber,
            error: detail,
        });
        // Compensating delete: restore system to pre-create state
        try {
            await deleteSupplierInvoice(pool, created.id);
        } catch (deleteErr: unknown) {
            logger.error('CRITICAL: compensating delete also failed — invoice exists without GL', {
                invoiceId: created.id,
                invoiceNumber: created.invoiceNumber,
                deleteError: deleteErr instanceof Error ? deleteErr.message : String(deleteErr),
            });
        }
        throw new Error(`Invoice created but GL posting failed: ${detail}`);
    }

    return created;
}

// ============================================================
// 3-WAY MATCH: POST SUPPLIER INVOICE TO GL
// ============================================================
// System rule: AP (2100) is created ONLY when a Supplier Invoice is posted.
// Flow: DR GRN/IR Clearing (2150) → CR Accounts Payable (2100)

export async function postInvoiceToGL(pool: Pool, invoiceId: string): Promise<void> {
    return UnitOfWork.run(pool, async (client) => {
        // Fetch invoice with lock to prevent concurrent posting
        const result = await client.query(
            `SELECT si."Id", si."SupplierInvoiceNumber", si."SupplierId",
                    TO_CHAR(si."InvoiceDate", 'YYYY-MM-DD') AS "InvoiceDate",
                    si."TotalAmount", si.is_posted_to_gl, si."Status", si.deleted_at,
                    si.document_type, si."InternalReferenceNumber",
                    si.grn_computed_total, si.variance_reason,
                    si."PurchaseOrderId",
                    s."CompanyName" AS supplier_name
             FROM supplier_invoices si
             LEFT JOIN suppliers s ON s."Id" = si."SupplierId"
             WHERE si."Id" = $1
             FOR UPDATE OF si`,
            [invoiceId],
        );

        if (result.rows.length === 0) {
            throw new Error(`Supplier invoice ${invoiceId} not found`);
        }

        const inv = result.rows[0];

        if (inv.deleted_at) {
            throw new Error(`Supplier invoice ${inv.SupplierInvoiceNumber} has been deleted`);
        }
        if (inv.is_posted_to_gl) {
            throw new Error(`Supplier invoice ${inv.SupplierInvoiceNumber} is already posted to GL`);
        }
        if (inv.Status === 'Cancelled') {
            throw new Error(`Cannot post a cancelled supplier invoice`);
        }
        if (inv.document_type === 'SUPPLIER_CREDIT_NOTE' || inv.document_type === 'SUPPLIER_DEBIT_NOTE') {
            throw new ValidationError(
                `Cannot post ${inv.SupplierInvoiceNumber} via postInvoiceToGL: ` +
                `use the credit/debit note module (postNote) for ${inv.document_type} documents.`
            );
        }
        if (inv.document_type === 'OPENING_BALANCE') {
            throw new ValidationError(
                `Cannot post ${inv.SupplierInvoiceNumber} via postInvoiceToGL: ` +
                `opening balance entries are system-generated and their GL is already posted.`
            );
        }

        const totalAmount = new Decimal(inv.TotalAmount).toNumber();
        if (totalAmount <= 0) {
            throw new Error(`Supplier invoice ${inv.SupplierInvoiceNumber} has zero amount — nothing to post`);
        }

        await assertSupplierCreditHeadroom(
            client,
            inv.SupplierId,
            totalAmount,
            `supplier invoice ${inv.SupplierInvoiceNumber}`,
        );

        // Determine routing path:
        //   GR-linked invoice → DR GR/IR Clearing (2150) / CR AP (2100)  [2-line or 3-line]
        //   Standalone invoice → DR General Expense (6900) / CR AP (2100) [always 2-line]
        //
        // Detection order:
        //   1. InternalReferenceNumber starts with 'GR-' and the GR exists in goods_receipts
        //   2. INV-GR-… or any token containing GR-YYYY-NNNN that maps to a COMPLETED GR
        //   3. Fallback: supplier_invoice_grn_links (authoritative 3-way match table)
        const grRefRaw = (inv.InternalReferenceNumber || '').trim();
        let linkedGrNumber: string | null = null;

        const resolveCompletedGr = async (receiptNumber: string): Promise<boolean> => {
            const r = await client.query(
                `SELECT receipt_number FROM goods_receipts
                  WHERE receipt_number = $1 AND status = 'COMPLETED' LIMIT 1`,
                [receiptNumber],
            );
            if (r.rows.length > 0) {
                linkedGrNumber = r.rows[0].receipt_number;
                return true;
            }
            return false;
        };

        let hasGrReference = false;
        if (grRefRaw.startsWith('GR-')) {
            hasGrReference = await resolveCompletedGr(grRefRaw);
        }
        if (!hasGrReference && grRefRaw) {
            // INV-GR-2026-0290, "GR: GR-2026-0290", etc.
            const embedded = grRefRaw.match(/GR-\d{4}-\d+/i);
            if (embedded) {
                hasGrReference = await resolveCompletedGr(embedded[0].toUpperCase());
            }
        }

        // Fallback: supplier_invoice_grn_links is the authoritative source for 3-way match
        if (!hasGrReference) {
            const linkCheck = await client.query(
                `SELECT gr.receipt_number
                   FROM supplier_invoice_grn_links sigl
                   JOIN goods_receipts gr ON gr.id = sigl.grn_id AND gr.status = 'COMPLETED'
                  WHERE sigl.invoice_id = $1
                  LIMIT 1`,
                [invoiceId],
            );
            if (linkCheck.rows.length > 0) {
                hasGrReference = true;
                linkedGrNumber = linkCheck.rows[0].receipt_number;
            }
        }

        // PO-linked COMPLETED unbilled GR: never silent-expense the bill
        if (!hasGrReference && inv.PurchaseOrderId) {
            const poGr = await client.query(
                `SELECT gr.receipt_number
                   FROM goods_receipts gr
                  WHERE gr.purchase_order_id = $1
                    AND gr.status = 'COMPLETED'
                    AND EXISTS (
                      SELECT 1 FROM goods_receipt_items gri WHERE gri.goods_receipt_id = gr.id
                    )
                  ORDER BY gr.received_date DESC
                  LIMIT 1`,
                [inv.PurchaseOrderId],
            );
            if (poGr.rows.length > 0) {
                hasGrReference = true;
                linkedGrNumber = poGr.rows[0].receipt_number;
                logger.info('Supplier invoice treated as GR-linked via PO unbilled GR', {
                    invoiceId,
                    invoiceNumber: inv.SupplierInvoiceNumber,
                    grNumber: linkedGrNumber,
                });
            }
        }

        // ── Variance data ──────────────────────────────────────────────────────
        // grn_computed_total: PricingEngine total at GRN receipt time (stored on invoice).
        // When missing, compute from linked GR line totals so price gaps hit 5020 instead of 2150 residual.
        // When it differs from TotalAmount (supplier AP amount), post a 3-line entry
        // so GR/IR is cleared at the full GRN value, AP is set to supplier amount,
        // and the delta goes to Price Variance (5020).
        let grnComputedTotal: number | undefined;
        let varianceAmount: number | undefined;
        const varianceReason: string | undefined = inv.variance_reason || undefined;

        let computedTotal: number | null =
            inv.grn_computed_total !== null && inv.grn_computed_total !== undefined
                ? new Decimal(inv.grn_computed_total).toNumber()
                : null;

        if (hasGrReference && (computedTotal === null || !Number.isFinite(computedTotal))) {
            const linkIds = await client.query<{ grn_id: string }>(
                `SELECT sigl.grn_id::text AS grn_id
                   FROM supplier_invoice_grn_links sigl
                  WHERE sigl.invoice_id = $1`,
                [invoiceId],
            );
            const grnIds = linkIds.rows.map((row) => row.grn_id);
            if (grnIds.length > 0) {
                computedTotal = (await computeGrnBillableTotal(client, grnIds)).toNumber();
            } else if (linkedGrNumber) {
                const one = await client.query<{ id: string }>(
                    `SELECT gr.id::text AS id
                       FROM goods_receipts gr
                      WHERE gr.receipt_number = $1
                      LIMIT 1`,
                    [linkedGrNumber],
                );
                if (one.rows[0]?.id) {
                    computedTotal = (
                        await computeGrnBillableTotal(client, [one.rows[0].id])
                    ).toNumber();
                }
            }
        }

        if (hasGrReference && computedTotal !== null && Number.isFinite(computedTotal)) {
            const varianceCheck = validateSupplierInvoiceGrnVariance({
                grnComputedTotal: computedTotal,
                invoiceTotal: totalAmount,
                varianceReason: inv.variance_reason,
                grLabel: linkedGrNumber ? `GR ${linkedGrNumber}` : undefined,
            });
            if (varianceCheck.hasVariance) {
                grnComputedTotal = computedTotal;
                varianceAmount = varianceCheck.varianceAmount;
            }
        }

        // Post GL (2-line standard or 3-line variance)
        await glEntryService.recordSupplierInvoiceToGL(
            {
                invoiceId: inv.Id,
                invoiceNumber: inv.SupplierInvoiceNumber,
                invoiceDate: inv.InvoiceDate,
                totalAmount,
                supplierId: inv.SupplierId,
                supplierName: inv.supplier_name || 'Unknown Supplier',
                hasGrReference,
                grnComputedTotal,
                varianceAmount,
                varianceReason,
            },
            undefined,
            client,
        );

        // Mark posted
        await supplierPaymentRepository.markInvoicePostedToGL(client, invoiceId);

        const { syncSupplierApCache } = await import('./apBalanceGovernance.js');
        await syncSupplierApCache(client, inv.SupplierId, 'POST_INVOICE_TO_GL');
    });
}

/**
 * Authoritative GR billable total for UI preview — same PricingEngine path as billing/GL.
 */
export async function getGrnBillableTotalPreview(pool: Pool, grnId: string) {
    const grRecord = await goodsReceiptRepository.getGRById(pool, grnId);
    if (!grRecord) {
        throw new ValidationError(`Goods Receipt ${grnId} not found`);
    }
    const { gr } = grRecord;
    if (gr.status !== 'COMPLETED') {
        throw new ValidationError(`GR ${gr.grNumber} is ${gr.status} — billable total requires COMPLETED`);
    }
    const linked = await assertLinkedGrnsReadyForBilling(pool, [grnId]);
    return {
        grnId,
        grNumber: gr.grNumber,
        billableTotal: linked.billableTotal.toNumber(),
        receiptNumbers: linked.receiptNumbers,
    };
}

/**
 * Return GRNs that have not yet been billed (no posted supplier invoice linked).
 */
export async function getUnbilledGRNs(pool: Pool, supplierId?: string) {
    return supplierPaymentRepository.findUnbilledGRNs(pool, supplierId);
}

// ============================================================
// PAYMENT ALLOCATIONS
// ============================================================

export async function allocatePayment(pool: Pool, data: AllocatePaymentInput, userId?: string) {
    return UnitOfWork.run(pool, async (client) => {
        // Use Decimal.js for precise currency comparisons
        const allocationAmount = new Decimal(data.amount);

        // Validate payment exists and has enough unallocated amount
        const payment = await supplierPaymentRepository.findPaymentById(client, data.supplierPaymentId);
        if (!payment) {
            throw new ValidationError('Payment not found');
        }

        const unallocatedAmount = new Decimal(payment.unallocatedAmount);
        if (unallocatedAmount.lessThan(allocationAmount)) {
            throw new ValidationError(
                `Insufficient unallocated amount. Available: ${unallocatedAmount.toFixed(2)}, Requested: ${allocationAmount.toFixed(2)}`
            );
        }

        // Validate invoice exists and has enough outstanding amount
        const invoice = await supplierPaymentRepository.findInvoiceById(client, data.supplierInvoiceId);
        if (!invoice) {
            throw new ValidationError('Invoice not found');
        }
        if (invoice.supplierId !== payment.supplierId) {
            throw new ValidationError('Invoice does not belong to this payment supplier');
        }

        const outstandingBalance = new Decimal(invoice.outstandingBalance);
        if (outstandingBalance.lessThan(allocationAmount)) {
            throw new ValidationError(
                `Allocation amount exceeds outstanding amount. Outstanding: ${outstandingBalance.toFixed(2)}, Requested: ${allocationAmount.toFixed(2)}`
            );
        }

        // Validate amount is positive
        if (allocationAmount.lessThanOrEqualTo(0)) {
            throw new ValidationError('Allocation amount must be greater than zero');
        }

        const allocation = await supplierPaymentRepository.createAllocation(client, {
            ...data,
            amount: allocationAmount.toNumber(), // Ensure precise value
        });

        // Update invoice paid amount and status (replaces trg_supplier_payment_allocation_sync)
        const invoiceTotal = new Decimal(invoice.totalAmount);
        const newPaidAmount = new Decimal(invoice.amountPaid || 0).plus(allocationAmount);
        await supplierPaymentRepository.updateInvoicePaidAmount(
            client,
            data.supplierInvoiceId,
            newPaidAmount.toNumber()
        );

        // Recalculate supplier balance from source (replaces trg_sync_supplier_balance_on_payment)
        await recalcSupplierBalance(client, payment.supplierId);

        logger.info('Payment allocated to invoice', {
            paymentId: data.supplierPaymentId,
            invoiceId: data.supplierInvoiceId,
            amount: allocationAmount.toNumber(),
        });

        return allocation;
    });
}

export async function getPaymentAllocations(pool: Pool, paymentId: string) {
    return supplierPaymentRepository.findAllocationsByPaymentId(pool, paymentId);
}

export async function removeAllocation(pool: Pool, allocationId: string) {
    return UnitOfWork.run(pool, async (client) => {
        // Fetch allocation + payment details before deletion for recalculation
        const allocRow = await client.query(
            `SELECT spa."PaymentId", spa."SupplierInvoiceId", sp."SupplierId"
             FROM supplier_payment_allocations spa
             JOIN supplier_payments sp ON sp."Id" = spa."PaymentId"
             WHERE spa."Id" = $1 AND spa.deleted_at IS NULL`,
            [allocationId]
        );
        const allocInfo = allocRow.rows[0];

        const result = await supplierPaymentRepository.deleteAllocation(client, allocationId);

        // After deletion, recalculate invoice paid amount from remaining allocations
        if (allocInfo) {
            const sumResult = await client.query(
                `SELECT COALESCE(SUM("AmountAllocated"), 0) as total_paid
                 FROM supplier_payment_allocations
                 WHERE "SupplierInvoiceId" = $1 AND deleted_at IS NULL`,
                [allocInfo.SupplierInvoiceId]
            );
            const newPaidAmount = new Decimal(sumResult.rows[0].total_paid).toNumber();
            await supplierPaymentRepository.updateInvoicePaidAmount(
                client,
                allocInfo.SupplierInvoiceId,
                newPaidAmount
            );

            // Recalculate supplier balance from source
            await recalcSupplierBalance(client, allocInfo.SupplierId);
        }

        return result;
    });
}

export async function autoAllocatePayment(pool: Pool, paymentId: string, userId?: string) {
    return UnitOfWork.run(pool, async (client) => {
        const payment = await supplierPaymentRepository.findPaymentById(pool, paymentId);
        if (!payment) {
            throw new Error('Payment not found');
        }

        // Use Decimal.js for precise currency calculations
        let remainingAmount = new Decimal(payment.unallocatedAmount);

        if (remainingAmount.lessThanOrEqualTo(0)) {
            throw new Error('Payment is fully allocated');
        }

        // Get outstanding invoices for the supplier, ordered by due date (FIFO)
        const outstandingInvoices = await supplierPaymentRepository.findOutstandingInvoices(
            pool,
            payment.supplierId
        );

        if (outstandingInvoices.length === 0) {
            throw new Error('No outstanding invoices found for this supplier');
        }

        const allocations: supplierPaymentRepository.SupplierPaymentAllocation[] = [];

        for (const invoice of outstandingInvoices) {
            if (remainingAmount.lessThanOrEqualTo(0)) break;

            const invoiceOutstanding = new Decimal(invoice.outstandingBalance);
            // Allocate the minimum of remaining payment or invoice outstanding
            const allocationAmount = Decimal.min(remainingAmount, invoiceOutstanding);

            const allocation = await supplierPaymentRepository.createAllocation(client, {
                supplierPaymentId: paymentId,
                supplierInvoiceId: invoice.id,
                amount: allocationAmount.toNumber(),
            });

            // Update invoice paid amount and status (replaces trg_supplier_payment_allocation_sync)
            const invoiceTotal = new Decimal(invoice.totalAmount);
            const newPaidAmount = new Decimal(invoice.amountPaid || 0).plus(allocationAmount);
            await supplierPaymentRepository.updateInvoicePaidAmount(
                client,
                invoice.id,
                newPaidAmount.toNumber()
            );

            allocations.push(allocation);
            remainingAmount = remainingAmount.minus(allocationAmount);

            logger.info('Auto-allocated payment to invoice', {
                paymentId,
                invoiceId: invoice.id,
                invoiceNumber: invoice.invoiceNumber,
                amount: allocationAmount.toNumber(),
                remainingUnallocated: remainingAmount.toNumber(),
            });
        }

        // Recalculate supplier balance from source (replaces trg_sync_supplier_balance_on_payment)
        await recalcSupplierBalance(client, payment.supplierId);

        logger.info('Auto-allocation completed', {
            paymentId,
            allocationsCount: allocations.length,
            remainingUnallocated: remainingAmount.toNumber(),
        });

        return allocations;
    });
}

// ============================================================
// MASS PAYMENT RUN
// ============================================================

export interface MassPaymentAllocation {
    supplierId: string;
    invoiceId: string;
    amount: number;
}

export interface MassPaymentRunInput {
    paymentDate: string;
    paymentMethod: string;
    reference?: string;
    notes?: string;
    /** Pay-from bank book (required when multiple banks for bank/MoMo methods). */
    bankAccountId?: string;
    allocations: MassPaymentAllocation[];
}

export interface MassPaymentRunResult {
    paymentCount: number;
    totalAmount: number;
    payments: Array<{
        supplierId: string;
        supplierName: string;
        paymentNumber: string;
        amount: number;
        allocatedInvoices: number;
    }>;
}

/**
 * Mass Payment Run — pay multiple invoices across multiple suppliers in one operation.
 *
 * Groups allocations by supplier. For each supplier creates one payment record and
 * applies exact allocations. All inserts happen in a single transaction.
 *
 * GL posting: one DR Accounts Payable (2100) + one CR Cash/Bank per supplier payment.
 */
export async function massPaymentRun(
    pool: Pool,
    data: MassPaymentRunInput,
    userId?: string
): Promise<MassPaymentRunResult> {
    if (!data.allocations || data.allocations.length === 0) {
        throw new ValidationError('No allocations provided');
    }

    // Validate total > 0
    const grandTotal = data.allocations.reduce(
        (sum, a) => sum.plus(new Decimal(a.amount)),
        new Decimal(0)
    );
    if (grandTotal.lessThanOrEqualTo(0)) {
        throw new ValidationError('Total payment amount must be greater than zero');
    }

    // Group by supplier
    const bySupplier = new Map<string, MassPaymentAllocation[]>();
    for (const alloc of data.allocations) {
        if (!bySupplier.has(alloc.supplierId)) bySupplier.set(alloc.supplierId, []);
        bySupplier.get(alloc.supplierId)!.push(alloc);
    }

    const results: MassPaymentRunResult['payments'] = [];

    await UnitOfWork.run(pool, async (client) => {
        const payFrom = await resolveSupplierPaymentCreditAccount(client, {
            paymentMethod: data.paymentMethod,
            bankAccountId: data.bankAccountId,
        });
        const effectiveMethod =
            payFrom.bankAccountId && payFrom.glAccountTag
                ? paymentMethodFromLiquidityTag(payFrom.glAccountTag, data.paymentMethod)
                : data.paymentMethod;

        for (const [supplierId, supplierAllocs] of bySupplier) {
            const supplierTotal = supplierAllocs.reduce(
                (sum, a) => sum.plus(new Decimal(a.amount)),
                new Decimal(0)
            );

            // Create payment record
            const payment = await supplierPaymentRepository.createPayment(client, {
                supplierId,
                paymentDate: data.paymentDate,
                paymentMethod: effectiveMethod,
                amount: supplierTotal.toNumber(),
                reference: data.reference,
                notes: data.notes,
                createdById: userId,
                bankAccountId: payFrom.bankAccountId,
            });

            // Apply each allocation — validate against ledger BEFORE writing
            for (const alloc of supplierAllocs) {
                // Lock the invoice row and recompute outstanding entirely from the
                // ledger (payment allocations + posted credit notes). This prevents:
                //   - trusting UI totals
                //   - race conditions from concurrent payments
                //   - double-payment from stale UI data
                const ledger = await supplierPaymentRepository.lockAndComputeInvoiceOutstanding(
                    client,
                    alloc.invoiceId
                );
                if (!ledger) {
                    throw new ValidationError(
                        `Invoice ${alloc.invoiceId} not found or has been deleted`
                    );
                }
                if (['Cancelled', 'CANCELLED'].includes(ledger.status)) {
                    throw new ValidationError(
                        `Cannot pay a cancelled invoice (${ledger.invoiceNumber})`
                    );
                }
                const allocAmount = new Decimal(alloc.amount);
                const trueOutstanding = ledger.outstandingBalance;

                if (trueOutstanding.lessThanOrEqualTo(0)) {
                    throw new ValidationError(
                        `Invoice ${ledger.invoiceNumber} is already fully paid or credited ` +
                        `(original: ${ledger.originalAmount.toFixed(2)}, ` +
                        `paid: ${ledger.paidAmount.toFixed(2)}, ` +
                        `credits: ${ledger.returnCredits.plus(ledger.creditNotes).toFixed(2)})`
                    );
                }
                // Allow a 1-cent tolerance for rounding differences
                if (allocAmount.greaterThan(trueOutstanding.plus(new Decimal('0.01')))) {
                    throw new ValidationError(
                        `Allocation of ${allocAmount.toFixed(2)} for invoice ${ledger.invoiceNumber} ` +
                        `exceeds ledger outstanding ${trueOutstanding.toFixed(2)} ` +
                        `(original: ${ledger.originalAmount.toFixed(2)}, ` +
                        `paid: ${ledger.paidAmount.toFixed(2)}, ` +
                        `return credits: ${ledger.returnCredits.toFixed(2)}, ` +
                        `credit notes: ${ledger.creditNotes.toFixed(2)})`
                    );
                }

                await supplierPaymentRepository.createAllocation(client, {
                    supplierPaymentId: payment.id,
                    supplierInvoiceId: alloc.invoiceId,
                    amount: allocAmount.toNumber(),
                });

                // newPaid is ledger-derived: sum of existing allocations + this new one
                const newPaid = ledger.paidAmount.plus(allocAmount);
                await supplierPaymentRepository.updateInvoicePaidAmount(
                    client,
                    alloc.invoiceId,
                    newPaid.toNumber()
                );
            }

            // Post to GL
            const supplierResult = await client.query(
                'SELECT "CompanyName" FROM suppliers WHERE "Id" = $1',
                [supplierId]
            );
            const supplierName = supplierResult.rows[0]?.CompanyName ?? 'Unknown';

            await glEntryService.recordSupplierPaymentToGL(
                {
                    paymentId: payment.id,
                    paymentNumber: payment.paymentNumber,
                    paymentDate: data.paymentDate,
                    amount: supplierTotal.toNumber(),
                    paymentMethod: effectiveMethod as 'CASH' | 'CARD' | 'MOBILE_MONEY' | 'BANK_TRANSFER' | 'CHECK',
                    paymentAccountCode: payFrom.creditAccountCode,
                    supplierId,
                    supplierName,
                },
                undefined,
                client
            );

            // Recalculate supplier balance
            await recalcSupplierBalance(client, supplierId);

            results.push({
                supplierId,
                supplierName,
                paymentNumber: payment.paymentNumber,
                amount: supplierTotal.toNumber(),
                allocatedInvoices: supplierAllocs.length,
            });
        }
    });

    return {
        paymentCount: results.length,
        totalAmount: grandTotal.toNumber(),
        payments: results,
    };
}

// ============================================================
// SUPPLIER OPENING BALANCE IMPORT
// ============================================================

export interface ImportSupplierOpeningBalanceInput {
    supplierId: string;
    amount: number;
    asOfDate: string;
    dueDate?: string;
    notes?: string;
    userId: string;
    userName?: string;
    userRole?: string;
    postReason: string;
    skipAudit?: boolean;
}

/**
 * Import a supplier's historical opening balance.
 *
 * Posts GL: DR Opening Balance Equity (3050) / CR Accounts Payable (2100)
 * Creates a POSTED supplier invoice record (document_type = 'OPENING_BALANCE') so the
 * supplier ledger shows the brought-forward balance.
 *
 * Idempotent: errors if supplier already has an opening balance record.
 */
export async function importSupplierOpeningBalance(
    pool: Pool,
    data: ImportSupplierOpeningBalanceInput
): Promise<{ invoiceId: string; invoiceNumber: string; amount: number }> {
    const amountNum = assertPositiveFinite(data.amount, 'Opening balance amount');
    const amount = new Decimal(amountNum);

    return UnitOfWork.run(pool, async (client) => {
        // Idempotency: reject if supplier already has an opening balance
        const existing = await client.query(
            `SELECT "Id" FROM supplier_invoices
             WHERE "SupplierId" = $1
               AND document_type = 'OPENING_BALANCE'
               AND deleted_at IS NULL
               AND UPPER("Status") NOT IN ('CANCELLED', 'VOIDED', 'DELETED')`,
            [data.supplierId]
        );
        if (existing.rows.length > 0) {
            throw new Error(
                'This supplier already has an opening balance. Use Replace opening balance to correct the amount.'
            );
        }

        // Validate supplier exists
        const supplierRes = await client.query(
            'SELECT "CompanyName" FROM suppliers WHERE "Id" = $1',
            [data.supplierId]
        );
        if (!supplierRes.rows[0]) {
            throw new Error('Supplier not found');
        }
        const supplierName = supplierRes.rows[0].CompanyName as string;

        // Generate opening balance invoice number
        const seqResult = await client.query(
            `SELECT COALESCE(MAX(
               CAST(SUBSTRING("SupplierInvoiceNumber" FROM 'OB-([0-9]+)') AS INTEGER)
             ), 0) + 1 AS next_num
             FROM supplier_invoices
             WHERE "SupplierInvoiceNumber" LIKE 'OB-%'`
        );
        const nextNum = safeParseInt(seqResult.rows[0].next_num, 1);
        const invoiceNumber = `OB-${String(nextNum).padStart(6, '0')}`;

        // Validate dates before GL (prevents NaN fiscal_year/fiscal_period in period balances)
        fiscalPartsFromIsoDate(data.asOfDate, 'As-of date');
        if (data.dueDate) {
            fiscalPartsFromIsoDate(data.dueDate, 'Due date');
        }

        // Create supplier invoice record with document_type = 'OPENING_BALANCE'.
        // This drives supplier balance and aging WITHOUT appearing in the Purchases/Invoices screen.
        // The record is system-locked: it must never be edited or voided from regular invoice flows.
        // InvoiceDate = asOfDate (posting / cutover date)
        // DueDate = baseline date for aging — defaults to asOfDate when not supplied
        const dueDate = data.dueDate ?? data.asOfDate;
        const invoiceResult = await client.query(
            `INSERT INTO supplier_invoices (
               "Id", "SupplierInvoiceNumber", "SupplierId",
               "InvoiceDate", "DueDate",
               "Subtotal", "TaxAmount", "TotalAmount",
               "AmountPaid", "OutstandingBalance",
               "Status", "CurrencyCode", document_type,
               "Notes", "CreatedAt", "UpdatedAt"
             ) VALUES (
               gen_random_uuid(), $1, $2,
               $3, $4,
               $5, 0, $5,
               0, $5,
               'Pending', 'UGX', 'OPENING_BALANCE',
               $6, NOW(), NOW()
             ) RETURNING "Id", "SupplierInvoiceNumber"`,
            [
                invoiceNumber,
                data.supplierId,
                data.asOfDate,
                dueDate,
                amount.toNumber(),
                data.notes ?? `Opening balance as of ${data.asOfDate}`,
            ]
        );
        const invoice = invoiceResult.rows[0];

        // Post GL: DR Opening Balance Equity (3050) / CR Accounts Payable (2100)
        await AccountingCore.createJournalEntry(
            {
                entryDate: data.asOfDate,
                description: `Supplier opening balance — ${supplierName}`,
                referenceType: 'SUPPLIER_OPENING_BALANCE',
                referenceId: invoice.Id,
                referenceNumber: invoiceNumber,
                lines: [
                    {
                        accountCode: glEntryService.AccountCodes.OPENING_BALANCE_EQUITY,
                        description: `Opening balance equity — ${supplierName}`,
                        debitAmount: amount.toNumber(),
                        creditAmount: 0,
                    },
                    {
                        accountCode: glEntryService.AccountCodes.ACCOUNTS_PAYABLE,
                        description: `Supplier AP — ${supplierName} opening balance`,
                        debitAmount: 0,
                        creditAmount: amount.toNumber(),
                        entityType: 'supplier',
                        entityId: data.supplierId,
                    },
                ],
                userId: data.userId,
                idempotencyKey: `SUPPLIER_OB-${invoice.Id}`,
                source: 'CUTOVER_OB',
            },
            pool,
            client
        );

        // Recalculate supplier balance
        await recalcSupplierBalance(client, data.supplierId);

        // Mark the invoice as GL-posted so the postInvoiceToGL guard skips it safely
        await client.query(
            `UPDATE supplier_invoices SET is_posted_to_gl = TRUE, "UpdatedAt" = NOW() WHERE "Id" = $1`,
            [invoice.Id]
        );

        if (!data.skipAudit) {
            await logOpeningBalanceAudit(client, {
                party: 'supplier',
                partyId: data.supplierId,
                partyName: supplierName,
                action: 'IMPORT',
                invoiceId: invoice.Id as string,
                invoiceNumber,
                amount: amount.toNumber(),
                reason: data.postReason,
                userId: data.userId,
                userName: data.userName,
                userRole: data.userRole,
            });
        }

        return {
            invoiceId: invoice.Id as string,
            invoiceNumber,
            amount: amount.toNumber(),
        };
    });
}

export async function getSupplierOpeningBalanceHistory(
    pool: Pool,
    supplierId: string,
): Promise<{ data: import('../../../../shared/types/audit.js').AuditLog[]; total: number }> {
    return auditRepository.getAuditLogs(pool, {
        entityType: 'SUPPLIER',
        entityId: supplierId,
        tags: ['OPENING_BALANCE'],
        page: 1,
        limit: 50,
        sortBy: 'createdAt',
        sortOrder: 'desc',
    });
}

async function loadSupplierOpeningBalanceForCancel(
    client: PoolClient,
    invoiceId: string,
): Promise<{ Id: string; SupplierId: string; SupplierInvoiceNumber: string; AmountPaid: string | number }> {
    const invRes = await client.query(
        `SELECT "Id", "SupplierId", "SupplierInvoiceNumber", "AmountPaid", "Status", document_type
         FROM supplier_invoices
         WHERE "Id" = $1 AND deleted_at IS NULL`,
        [invoiceId],
    );
    const inv = invRes.rows[0];
    if (!inv || inv.document_type !== 'OPENING_BALANCE') {
        throw new Error('Supplier opening balance record not found');
    }
    const status = String(inv.Status || '').toUpperCase();
    if (['CANCELLED', 'VOIDED', 'DELETED'].includes(status)) {
        throw new Error('Opening balance is already cancelled');
    }
    const paid = new Decimal(inv.AmountPaid || 0);
    if (paid.greaterThan(0.01)) {
        throw new Error('Cannot cancel opening balance with payments applied.');
    }
    const alloc = await client.query(
        `SELECT 1 FROM supplier_payment_allocations
         WHERE "SupplierInvoiceId" = $1 AND deleted_at IS NULL LIMIT 1`,
        [invoiceId],
    );
    if (alloc.rows.length > 0) {
        throw new Error('Cannot cancel opening balance with payment allocations.');
    }
    return inv;
}

/**
 * Remove all payment allocations from an invoice (SAP: reset payment reconciliation).
 * Payments remain on the supplier as unallocated cash — user can re-apply after correction.
 */
export async function unallocateAllPaymentsFromInvoice(
    client: PoolClient,
    invoiceId: string,
    supplierId: string,
): Promise<{ allocationCount: number; amountUnallocated: number }> {
    const allocs = await client.query<{ Id: string; AmountAllocated: string | number }>(
        `SELECT "Id", "AmountAllocated" FROM supplier_payment_allocations
         WHERE "SupplierInvoiceId" = $1 AND deleted_at IS NULL`,
        [invoiceId],
    );

    let amountUnallocated = new Decimal(0);

    for (const row of allocs.rows) {
        amountUnallocated = amountUnallocated.plus(row.AmountAllocated || 0);
        const deleted = await supplierPaymentRepository.deleteAllocation(client, row.Id);
        if (!deleted) continue;
    }

    const sumResult = await client.query<{ total_paid: string | number }>(
        `SELECT COALESCE(SUM("AmountAllocated"), 0) as total_paid
         FROM supplier_payment_allocations
         WHERE "SupplierInvoiceId" = $1 AND deleted_at IS NULL`,
        [invoiceId],
    );
    const newPaidAmount = new Decimal(sumResult.rows[0]?.total_paid ?? 0).toNumber();
    await supplierPaymentRepository.updateInvoicePaidAmount(client, invoiceId, newPaidAmount);

    if (allocs.rows.length > 0) {
        await recalcSupplierBalance(client, supplierId);
    }

    return {
        allocationCount: allocs.rows.length,
        amountUnallocated: amountUnallocated.toNumber(),
    };
}

async function unallocateSupplierObPaymentsBeforeCancel(
    client: PoolClient,
    invoiceId: string,
    supplierId: string,
): Promise<number> {
    const { allocationCount } = await unallocateAllPaymentsFromInvoice(client, invoiceId, supplierId);
    return allocationCount;
}

export type CancelSupplierOpeningBalanceOptions = {
    forReplace?: boolean;
    skipAudit?: boolean;
    userName?: string;
    userRole?: string;
};

export async function cancelSupplierOpeningBalance(
    pool: Pool,
    invoiceId: string,
    userId: string,
    reason: string,
    options?: CancelSupplierOpeningBalanceOptions,
): Promise<{ invoiceId: string; invoiceNumber: string }> {
    if (!reason || reason.trim().length < 5) {
        throw new Error('Cancellation reason is required (min 5 characters)');
    }

    return UnitOfWork.run(pool, async (client) => {
        if (options?.forReplace) {
            const meta = await client.query<{ SupplierId: string }>(
                `SELECT "SupplierId" FROM supplier_invoices
                 WHERE "Id" = $1 AND document_type = 'OPENING_BALANCE' AND deleted_at IS NULL`,
                [invoiceId],
            );
            if (!meta.rows[0]) {
                throw new Error('Supplier opening balance record not found');
            }
            const unallocated = await unallocateSupplierObPaymentsBeforeCancel(
                client,
                invoiceId,
                meta.rows[0].SupplierId,
            );
            if (unallocated > 0) {
                logger.info('Unallocated supplier payments from OB before replace', {
                    invoiceId,
                    supplierId: meta.rows[0].SupplierId,
                    count: unallocated,
                });
            }
        }

        const inv = await loadSupplierOpeningBalanceForCancel(client, invoiceId);
        await checkAccountingPeriodOpen(client, getBusinessDate());

        const glTxn = await client.query<{ Id: string }>(
            `SELECT "Id" FROM ledger_transactions
             WHERE "ReferenceType" = 'SUPPLIER_OPENING_BALANCE'
               AND "ReferenceId" = $1
               AND "IsReversed" = FALSE
             LIMIT 1`,
            [invoiceId],
        );

        if (glTxn.rows[0]) {
            try {
                await AccountingCore.reverseTransaction(
                    {
                        originalTransactionId: glTxn.rows[0].Id,
                        reversalDate: getBusinessDate(),
                        reason: `CANCEL ${inv.SupplierInvoiceNumber}: ${reason.trim()}`,
                        userId,
                        idempotencyKey: `SUPPLIER_OB_CANCEL-${invoiceId}`,
                    },
                    pool,
                    client,
                );
            } catch (error: unknown) {
                if (error instanceof AccountingError && error.code === 'ALREADY_REVERSED') {
                    logger.info('Supplier OB GL already reversed', { invoiceId });
                } else {
                    throw error;
                }
            }
        }

        await client.query(
            `UPDATE supplier_invoices
             SET "Status" = 'Cancelled', "OutstandingBalance" = 0, "UpdatedAt" = NOW()
             WHERE "Id" = $1`,
            [invoiceId],
        );

        await recalcSupplierBalance(client, inv.SupplierId);

        if (!options?.skipAudit) {
            const supRes = await client.query<{ CompanyName: string }>(
                'SELECT "CompanyName" FROM suppliers WHERE "Id" = $1',
                [inv.SupplierId],
            );
            await logOpeningBalanceAudit(client, {
                party: 'supplier',
                partyId: inv.SupplierId,
                partyName: supRes.rows[0]?.CompanyName ?? 'Supplier',
                action: 'CANCEL',
                invoiceId,
                invoiceNumber: inv.SupplierInvoiceNumber as string,
                reason,
                userId,
                userName: options?.userName,
                userRole: options?.userRole,
            });
        }

        return { invoiceId, invoiceNumber: inv.SupplierInvoiceNumber as string };
    });
}

export type CancelSupplierInvoiceForCorrectionOptions = {
    /** When set, runs inside an existing transaction (e.g. supplier reassignment wizard). */
    client?: PoolClient;
    grnId?: string;
    /** SAP/Odoo: unapply payment allocations before reversing the bill (reassignment wizard). */
    unallocatePaymentsFirst?: boolean;
    /** GL audit tag — USER_CANCEL for UI cancel; GR_FULL_REVERSE for receipt reverse; default REASSIGN GR for wizard. */
    glReasonTag?: 'USER_CANCEL' | 'REASSIGN GR' | 'GR_FULL_REVERSE';
};

/**
 * Cancel an unpaid supplier bill from the UI (admin/manager).
 * Reverses posted GL and marks Cancelled so linked GRNs can be rebilled.
 */
export async function cancelSupplierInvoice(
    pool: Pool,
    invoiceId: string,
    userId: string,
    reason: string,
): Promise<{ invoiceId: string; invoiceNumber: string; glReversed: boolean }> {
    const trimmed = reason?.trim() ?? '';
    if (trimmed.length < 3) {
        throw new ValidationError('Cancellation reason is required (min 3 characters)');
    }

    return UnitOfWork.run(pool, async (client) => {
        const row = await supplierPaymentRepository.findInvoiceCancelContext(client, invoiceId);
        if (!row) {
            throw new ValidationError('Supplier invoice not found');
        }

        const blockReason = supplierBillCancelBlockReason({
            status: row.status,
            documentType: row.documentType,
            invoiceNumber: row.invoiceNumber,
            amountPaid: row.amountPaid,
            creditsApplied: row.creditsApplied,
        });
        if (blockReason) {
            throw new ValidationError(blockReason);
        }

        if (!isSupplierBillCancellable(row)) {
            throw new ValidationError('This bill cannot be cancelled.');
        }

        const allocCount = await supplierPaymentRepository.countActivePaymentAllocations(
            client,
            invoiceId,
        );
        if (allocCount > 0) {
            throw new ValidationError(
                'Remove payment allocations on this bill before cancelling (reverse the payment first).',
            );
        }

        return cancelSupplierInvoiceForCorrection(pool, invoiceId, userId, trimmed, {
            client,
            glReasonTag: 'USER_CANCEL',
        });
    });
}

/**
 * Cancel an unpaid supplier invoice for correction workflows (SAP/Odoo: reverse vendor bill).
 * Reverses posted GL (SUPPLIER_INVOICE) then marks invoice Cancelled — reopens GR/IR when GR-linked.
 */
export async function cancelSupplierInvoiceForCorrection(
    pool: Pool,
    invoiceId: string,
    userId: string,
    reason: string,
    options?: CancelSupplierInvoiceForCorrectionOptions,
): Promise<{ invoiceId: string; invoiceNumber: string; glReversed: boolean }> {
    if (!reason || reason.trim().length < 3) {
        throw new ValidationError('Cancellation reason is required (min 3 characters)');
    }

    const run = async (client: PoolClient) => {
        const result = await client.query<{
            Id: string;
            SupplierInvoiceNumber: string;
            SupplierId: string;
            Status: string;
            document_type: string | null;
            AmountPaid: string | number;
            is_posted_to_gl: boolean;
        }>(
            `SELECT "Id", "SupplierInvoiceNumber", "SupplierId", "Status", document_type,
                    COALESCE("AmountPaid", 0) AS "AmountPaid", COALESCE(is_posted_to_gl, false) AS is_posted_to_gl
             FROM supplier_invoices
             WHERE "Id" = $1 AND deleted_at IS NULL
             FOR UPDATE`,
            [invoiceId],
        );

        if (result.rows.length === 0) {
            throw new ValidationError('Supplier invoice not found');
        }

        const inv = result.rows[0];
        const status = String(inv.Status || '').toUpperCase();
        if (status === 'CANCELLED' || status === 'VOIDED' || status === 'DELETED') {
            return {
                invoiceId,
                invoiceNumber: inv.SupplierInvoiceNumber,
                glReversed: false,
            };
        }

        const amountPaid = Number(inv.AmountPaid) || 0;
        if (amountPaid > 0.01 && !options?.unallocatePaymentsFirst) {
            throw new ValidationError(
                `Cannot auto-reverse supplier invoice ${inv.SupplierInvoiceNumber}: payments exist. Use credit note workflow or enable payment unallocation.`,
            );
        }

        if (amountPaid > 0.01 && options?.unallocatePaymentsFirst) {
            await unallocateAllPaymentsFromInvoice(client, invoiceId, inv.SupplierId);
        }

        const docType = inv.document_type ?? '';
        if (docType === 'OPENING_BALANCE') {
            throw new ValidationError('Use opening balance cancel for opening balance documents.');
        }
        if (docType === 'SUPPLIER_CREDIT_NOTE' || docType === 'SUPPLIER_DEBIT_NOTE') {
            throw new ValidationError(`Cannot auto-reverse ${docType} via supplier reassignment.`);
        }

        await checkAccountingPeriodOpen(client, getBusinessDate());

        let glReversed = false;
        if (inv.is_posted_to_gl) {
            const glTxn = await client.query<{ Id: string }>(
                `SELECT "Id" FROM ledger_transactions
                 WHERE "ReferenceType" = 'SUPPLIER_INVOICE'
                   AND "ReferenceId" = $1
                   AND "IsReversed" = FALSE
                 ORDER BY "CreatedAt" DESC
                 LIMIT 1`,
                [invoiceId],
            );

            if (glTxn.rows[0]) {
                const suffix = options?.grnId ? `-${options.grnId}` : '';
                const tag = options?.glReasonTag ?? 'REASSIGN GR';
                try {
                    await AccountingCore.reverseTransaction(
                        {
                            originalTransactionId: glTxn.rows[0].Id,
                            reversalDate: getBusinessDate(),
                            reason: `${tag}: cancel ${inv.SupplierInvoiceNumber}: ${reason.trim()}`,
                            userId,
                            idempotencyKey: `SUPPLIER_INV_CANCEL-${invoiceId}${suffix}`,
                        },
                        pool,
                        client,
                    );
                    glReversed = true;
                } catch (error: unknown) {
                    if (error instanceof AccountingError && error.code === 'ALREADY_REVERSED') {
                        glReversed = true;
                    } else {
                        throw error;
                    }
                }
            }

            const openGl = await client.query<{ n: string }>(
                `SELECT COUNT(*)::int AS n
                   FROM ledger_transactions
                  WHERE "ReferenceType" = 'SUPPLIER_INVOICE'
                    AND "ReferenceId" = $1
                    AND "IsReversed" = FALSE
                    AND "Status" = 'POSTED'`,
                [invoiceId],
            );
            const openCount = Number(openGl.rows[0]?.n ?? 0);
            if (openCount > 0) {
                throw new ValidationError(
                    `Cannot cancel ${inv.SupplierInvoiceNumber}: ${openCount} open GL posting(s) remain — reversal incomplete.`,
                );
            }
            if (inv.is_posted_to_gl) {
                glReversed = true;
            }
        }

        await client.query(
            `UPDATE supplier_invoices
             SET "Status" = 'Cancelled',
                 "OutstandingBalance" = 0,
                 "UpdatedAt" = NOW()
             WHERE "Id" = $1`,
            [invoiceId],
        );

        await recalcSupplierBalance(client, inv.SupplierId);

        return {
            invoiceId,
            invoiceNumber: inv.SupplierInvoiceNumber,
            glReversed,
        };
    };

    if (options?.client) {
        return run(options.client);
    }
    return UnitOfWork.run(pool, run);
}

export async function replaceSupplierOpeningBalance(
    pool: Pool,
    data: ImportSupplierOpeningBalanceInput & { replaceReason: string },
): Promise<{ invoiceId: string; invoiceNumber: string; amount: number; replaced: boolean }> {
    const existing = await pool.query<{ Id: string }>(
        `SELECT "Id" FROM supplier_invoices
         WHERE "SupplierId" = $1
           AND document_type = 'OPENING_BALANCE'
           AND deleted_at IS NULL
           AND UPPER("Status") NOT IN ('CANCELLED', 'VOIDED', 'DELETED')`,
        [data.supplierId],
    );

    let replaced = false;
    let previousAmount: number | undefined;

    if (existing.rows[0]) {
        const oldInv = await pool.query<{ TotalAmount: string | number }>(
            `SELECT "TotalAmount" FROM supplier_invoices WHERE "Id" = $1`,
            [existing.rows[0].Id],
        );
        previousAmount = Number(oldInv.rows[0]?.TotalAmount ?? 0);

        await cancelSupplierOpeningBalance(
            pool,
            existing.rows[0].Id,
            data.userId,
            data.replaceReason || 'Replaced opening balance with corrected amount',
            { forReplace: true, skipAudit: true },
        );
        replaced = true;
    }

    const created = await importSupplierOpeningBalance(pool, {
        ...data,
        postReason: data.replaceReason,
        skipAudit: replaced,
    });

    if (replaced) {
        const supRes = await pool.query<{ CompanyName: string }>(
            'SELECT "CompanyName" FROM suppliers WHERE "Id" = $1',
            [data.supplierId],
        );
        await UnitOfWork.run(pool, async (client) => {
            await logOpeningBalanceAudit(client, {
                party: 'supplier',
                partyId: data.supplierId,
                partyName: supRes.rows[0]?.CompanyName ?? 'Supplier',
                action: 'UPDATE',
                invoiceId: created.invoiceId,
                invoiceNumber: created.invoiceNumber,
                amount: created.amount,
                previousAmount,
                reason: data.replaceReason,
                userId: data.userId,
                userName: data.userName,
                userRole: data.userRole,
            });
        });
    }

    return { ...created, replaced };
}

/**
 * Smart cutover increase for suppliers: enter delta to add, not screen outstanding.
 */
export async function increaseSupplierOpeningBalance(
    pool: Pool,
    data: ImportSupplierOpeningBalanceInput & {
        increaseBy: number;
        reason: string;
    },
): Promise<{
    invoiceId?: string;
    invoiceNumber: string;
    amount: number;
    replaced: boolean;
    previousCutoverTotal: number;
    increaseBy: number;
}> {
    const { BusinessError } = await import('../../middleware/errorHandler.js');
    const increaseBy = assertPositiveFinite(data.increaseBy, 'Increase amount');

    const active = await pool.query<{ Id: string; TotalAmount: string | number }>(
        `SELECT "Id", "TotalAmount" FROM supplier_invoices
         WHERE "SupplierId" = $1
           AND document_type = 'OPENING_BALANCE'
           AND deleted_at IS NULL
           AND UPPER("Status") NOT IN ('CANCELLED', 'VOIDED', 'DELETED')
         LIMIT 1`,
        [data.supplierId],
    );
    if (!active.rows[0]) {
        throw new BusinessError(
            'No active cutover opening balance for this supplier. Use Post go-live cutover first.',
            'OB_INCREASE_NO_ACTIVE_CUTOVER',
        );
    }

    const previousCutoverTotal = Number(active.rows[0].TotalAmount || 0);
    const newTotal = previousCutoverTotal + increaseBy;

    const result = await replaceSupplierOpeningBalance(pool, {
        ...data,
        amount: newTotal,
        replaceReason: `[INCREASE +${increaseBy}] ${data.reason}`,
        postReason: data.reason,
    });

    try {
        const supRes = await pool.query<{ CompanyName: string }>(
            'SELECT "CompanyName" FROM suppliers WHERE "Id" = $1',
            [data.supplierId],
        );
        await UnitOfWork.run(pool, async (client) => {
            await logOpeningBalanceAudit(client, {
                party: 'supplier',
                partyId: data.supplierId,
                partyName: supRes.rows[0]?.CompanyName ?? 'Supplier',
                action: 'INCREASE',
                invoiceId: result.invoiceId ?? active.rows[0].Id,
                invoiceNumber: result.invoiceNumber,
                amount: result.amount,
                previousAmount: previousCutoverTotal,
                increaseBy,
                reason: data.reason,
                userId: data.userId,
                userName: data.userName,
                userRole: data.userRole,
            });
        });
    } catch {
        /* secondary audit only */
    }

    return {
        ...result,
        previousCutoverTotal,
        increaseBy,
    };
}

export async function getSupplierCutoverSummary(pool: Pool, supplierId: string) {
    const sup = await pool.query<{ CompanyName: string; OutstandingBalance: string | number }>(
        `SELECT "CompanyName", COALESCE("OutstandingBalance", 0) AS "OutstandingBalance"
         FROM suppliers WHERE "Id" = $1`,
        [supplierId],
    );
    if (!sup.rows[0]) throw new Error(`Supplier ${supplierId} not found`);

    const ob = await pool.query<{
        Id: string;
        SupplierInvoiceNumber: string;
        TotalAmount: string | number;
        AmountPaid: string | number;
        OutstandingBalance: string | number;
        InvoiceDate: Date | string;
        Status: string;
    }>(
        `SELECT "Id", "SupplierInvoiceNumber", "TotalAmount", COALESCE("AmountPaid",0) AS "AmountPaid",
                COALESCE("OutstandingBalance",0) AS "OutstandingBalance", "InvoiceDate", "Status"
         FROM supplier_invoices
         WHERE "SupplierId" = $1
           AND document_type = 'OPENING_BALANCE'
           AND deleted_at IS NULL
           AND UPPER("Status") NOT IN ('CANCELLED', 'VOIDED', 'DELETED')
         ORDER BY "CreatedAt" DESC NULLS LAST
         LIMIT 1`,
        [supplierId],
    );

    const other = await pool.query<{ due: string | number; cnt: string | number }>(
        `SELECT COALESCE(SUM(COALESCE("OutstandingBalance",0)),0) AS due, COUNT(*)::int AS cnt
         FROM supplier_invoices
         WHERE "SupplierId" = $1
           AND COALESCE(document_type, 'INVOICE') <> 'OPENING_BALANCE'
           AND deleted_at IS NULL
           AND UPPER("Status") NOT IN ('CANCELLED', 'VOIDED', 'DELETED', 'PAID')
           AND COALESCE("OutstandingBalance",0) > 0.009`,
        [supplierId],
    );

    const currentOutstanding = Number(sup.rows[0].OutstandingBalance || 0);
    const cutover = ob.rows[0]
        ? {
              invoiceId: ob.rows[0].Id,
              invoiceNumber: ob.rows[0].SupplierInvoiceNumber,
              documentTotal: Number(ob.rows[0].TotalAmount || 0),
              amountPaid: Number(ob.rows[0].AmountPaid || 0),
              amountDue: Number(ob.rows[0].OutstandingBalance || 0),
              issueDate: String(ob.rows[0].InvoiceDate).slice(0, 10),
              status: ob.rows[0].Status,
          }
        : null;

    const guidance: string[] = [];
    if (!cutover) {
        guidance.push(
            'No go-live cutover yet. Post total still owed to this supplier from the old system as of cutover — not today’s AP alone.',
        );
    } else {
        guidance.push(
            `Cutover ${cutover.invoiceNumber} document total is ${cutover.documentTotal}. Current AP outstanding ${currentOutstanding} is calculated and may differ.`,
        );
        guidance.push('To bring more legacy AP, use Increase cutover by the extra amount.');
    }

    return {
        supplierId,
        supplierName: sup.rows[0].CompanyName,
        currentOutstanding,
        hasActiveCutover: Boolean(cutover),
        cutover,
        otherOpenInvoicesDue: Number(other.rows[0]?.due || 0),
        otherOpenInvoiceCount: Number(other.rows[0]?.cnt || 0),
        unallocatedCash: 0,
        guidance,
    };
}
