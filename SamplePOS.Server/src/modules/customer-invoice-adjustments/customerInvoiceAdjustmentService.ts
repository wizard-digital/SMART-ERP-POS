/**
 * Customer Invoice Adjustment Service
 *
 * Orchestrates SAP/Odoo-style customer invoice corrections:
 *   PRICE_CORRECTION — line-level credit note (no stock), posted atomically
 *   RETURN_GOODS     — credit note with returnsGoods + inventory RETURN
 *
 * Delegates GL and balance sync to creditDebitNoteService.
 */

import type { Pool } from 'pg';
import type { AdjustCustomerInvoice } from '../../../../shared/zod/customerInvoiceAdjustment.js';
import { creditDebitNoteRepository } from '../credit-debit-notes/creditDebitNoteRepository.js';
import { creditDebitNoteService } from '../credit-debit-notes/creditDebitNoteService.js';
import { invoiceRepository } from '../invoices/invoiceRepository.js';
import { salesRepository } from '../sales/salesRepository.js';
import { getFinalPrice } from '../pricing/pricingEngineService.js';
import * as pricingRepo from '../pricing/pricingRepository.js';
import { BusinessRuleException } from '../../errors/BusinessRuleException.js';
import { NotFoundError } from '../../middleware/errorHandler.js';
import logger from '../../utils/logger.js';
import { Money } from '../../utils/money.js';
import { saleLineReturnTaxRate } from '../invoices/invoiceSettlement.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OverchargeLine {
    saleItemId: string;
    productId: string;
    productName: string;
    quantity: number;
    unitPriceCharged: number;
    batchUnitCost: number;
    suggestedCorrectUnitPrice: number;
    suggestedCreditPerUnit: number;
    suggestedLineCredit: number;
    pricingScope: string | null;
}

export interface ReturnableSaleLine {
    saleItemId: string;
    productId: string;
    productName: string;
    quantity: number;
    returnableQuantity: number;
    refundedQuantity: number;
    unitPrice: number;
    taxRate: number;
    uomSymbol: string | null;
    uomName: string | null;
    baseUomSymbol: string | null;
    conversionFactor: number;
}

export interface AdjustmentContext {
    invoice: {
        id: string;
        invoiceNumber: string;
        customerId: string;
        customerName: string;
        totalAmount: number;
        amountPaid: number;
        outstandingBalance: number;
        status: string;
        saleId: string | null;
        saleNumber: string | null;
        saleStatus: string | null;
    };
    customerPricingMode: 'STANDARD' | 'AT_COST';
    overchargeLines: OverchargeLine[];
    returnableLines: ReturnableSaleLine[];
    existingCreditNoteTotal: number;
    /** Sum of suggestedLineCredit on eligible lines (before prior CN offsets). */
    totalSuggestedCredit: number;
    /** Room left on overcharge after posted credits on the same sale lines. */
    remainingOverchargeCredit: number;
    /** Max this adjustment may post: min(remaining overcharge, outstanding, invoice headroom). */
    maxAdditionalCredit: number;
    suggestedIntent: 'PRICE_CORRECTION' | 'RETURN_GOODS' | 'NONE';
}

export interface AdjustmentResult {
    intent: 'PRICE_CORRECTION' | 'RETURN_GOODS';
    creditNoteId: string;
    creditNoteNumber: string;
    totalCredit: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function saleItemFromRow(row: Record<string, unknown>) {
    const id = String(row.id ?? '');
    const productId = String(row.product_id ?? row.productId ?? '');
    const productName = String(row.product_name ?? row.productName ?? 'Item');
    const quantity = Money.toNumber(Money.parseDb(row.quantity ?? 0));
    const unitPrice = Money.toNumber(Money.parseDb(row.unit_price ?? row.unitPrice ?? 0));
    const unitCost = Money.toNumber(Money.parseDb(row.unit_cost ?? row.unitCost ?? row.cost_price ?? 0));
    const conversionFactor = Money.toNumber(Money.parseDb(row.conversion_factor ?? row.conversionFactor ?? 1));
    const uomSymbol = row.uom_symbol ?? row.uomSymbol;
    const uomName = row.uom_name ?? row.uomName;
    const baseUomSymbol = row.base_uom_symbol ?? row.baseUomSymbol;
    return {
        id,
        productId,
        productName,
        quantity,
        unitPrice,
        unitCost,
        conversionFactor,
        uomSymbol: uomSymbol != null ? String(uomSymbol) : null,
        uomName: uomName != null ? String(uomName) : null,
        baseUomSymbol: baseUomSymbol != null ? String(baseUomSymbol) : null,
    };
}

const VOID_SALE_STATUSES = new Set(['VOID', 'VOIDED', 'VOIDED_BY_RETURN', 'CANCELLED']);

/** Credits already posted per sale_items.id (from CN line description). */
async function getPostedCreditBySaleItem(
    pool: Pool,
    invoiceId: string,
): Promise<Map<string, number>> {
    const res = await pool.query(
        `SELECT ili."Description" AS description, ili."LineTotal" AS line_total
         FROM invoice_line_items ili
         JOIN invoices cn ON cn.id = ili."InvoiceId"
         WHERE cn.reference_invoice_id = $1
           AND cn.document_type = 'CREDIT_NOTE'
           AND UPPER(cn.status) = 'POSTED'`,
        [invoiceId],
    );
    const bySaleItem = new Map<string, number>();
    for (const row of res.rows as { description: string | null; line_total: string | number }[]) {
        const match = /sale_item:([0-9a-f-]{36})/i.exec(row.description ?? '');
        if (!match) continue;
        const prior = Money.toNumber(Money.parseDb(bySaleItem.get(match[1]) ?? 0));
        bySaleItem.set(
            match[1],
            Money.toNumber(Money.add(Money.parseDb(prior), Money.parseDb(row.line_total))),
        );
    }
    return bySaleItem;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export const customerInvoiceAdjustmentService = {

    async getInvoiceContext(pool: Pool, invoiceId: string): Promise<AdjustmentContext> {
        const invoice = await creditDebitNoteRepository.getInvoiceById(pool, invoiceId);
        if (!invoice) throw new NotFoundError('Customer invoice');
        if (invoice.documentType !== 'INVOICE') {
            throw new BusinessRuleException(
                'Only standard customer invoices can be adjusted',
                'ADJUST_NOT_INVOICE',
            );
        }
        if (['CANCELLED', 'Cancelled', 'VOIDED', 'VOID'].includes(invoice.status)) {
            throw new BusinessRuleException(
                'Cannot adjust a cancelled or voided invoice',
                'ADJUST_INVOICE_CANCELLED',
            );
        }

        const invRow = await invoiceRepository.getInvoiceById(pool, invoiceId);
        const saleId = invRow?.sale_id ?? null;

        let saleNumber: string | null = null;
        let saleStatus: string | null = null;
        const overchargeLines: OverchargeLine[] = [];
        const returnableLines: ReturnableSaleLine[] = [];
        let grossOverchargeTotal = 0;

        const pricingMode = invoice.customerId
            ? await pricingRepo.getCustomerPricingMode(pool, invoice.customerId)
            : 'STANDARD';

        const postedCreditBySaleItem = await getPostedCreditBySaleItem(pool, invoiceId);

        if (saleId) {
            const saleData = await salesRepository.getSaleById(pool, saleId);
            if (!saleData) {
                throw new BusinessRuleException(
                    'Linked sale not found — cannot build adjustment lines',
                    'ADJUST_SALE_MISSING',
                );
            }
            const sale = saleData.sale as unknown as Record<string, unknown>;
            saleNumber = String(sale.sale_number ?? sale.saleNumber ?? '');
            saleStatus = String(sale.status ?? '');
            if (VOID_SALE_STATUSES.has(saleStatus)) {
                throw new BusinessRuleException(
                    `Linked sale ${saleNumber} is void — use a different correction path`,
                    'ADJUST_SALE_VOID',
                );
            }

            for (const raw of saleData.items as unknown as Record<string, unknown>[]) {
                const item = saleItemFromRow(raw);
                if (!item.productId) continue;

                const refundedQty = Money.toNumber(
                    Money.parseDb(raw.refunded_qty ?? raw.refundedQty ?? 0),
                );
                const returnableQty = Math.max(0, item.quantity - refundedQty);
                const lineNet = Money.toNumber(Money.parseDb(raw.total_price ?? raw.totalPrice ?? item.unitPrice * item.quantity));
                const lineTax = Money.toNumber(Money.parseDb(raw.tax_amount ?? raw.taxAmount ?? 0));
                const taxRate = saleLineReturnTaxRate({
                    lineNet,
                    lineTax,
                    storedRate: Money.toNumber(Money.parseDb(raw.tax_rate ?? raw.taxRate ?? 0)),
                });
                if (returnableQty > 0.0001) {
                    returnableLines.push({
                        saleItemId: item.id,
                        productId: item.productId,
                        productName: item.productName,
                        quantity: item.quantity,
                        returnableQuantity: returnableQty,
                        refundedQuantity: refundedQty,
                        unitPrice: item.unitPrice,
                        taxRate,
                        uomSymbol: item.uomSymbol,
                        uomName: item.uomName,
                        baseUomSymbol: item.baseUomSymbol,
                        conversionFactor: item.conversionFactor,
                    });
                }

                const resolved = await getFinalPrice(
                    item.productId,
                    invoice.customerId,
                    undefined,
                    item.quantity,
                    pool,
                );
                const correct = Money.toNumber(Money.parseDb(resolved.finalPrice));
                const creditPerUnit = Money.toNumber(
                    Money.subtract(Money.parseDb(item.unitPrice), Money.parseDb(correct)),
                );
                if (creditPerUnit > 0.009) {
                    const grossLineCredit = Money.toNumber(
                        Money.multiply(Money.parseDb(item.quantity), Money.parseDb(creditPerUnit)),
                    );
                    grossOverchargeTotal += grossLineCredit;
                    const priorOnLine = postedCreditBySaleItem.get(item.id) ?? 0;
                    const lineCredit = Money.toNumber(
                        Money.max(
                            Money.zero(),
                            Money.subtract(Money.parseDb(grossLineCredit), Money.parseDb(priorOnLine)),
                        ),
                    );
                    if (lineCredit <= 0.009) continue;
                    const netPerUnit = item.quantity > 0 ? lineCredit / item.quantity : 0;
                    overchargeLines.push({
                        saleItemId: item.id,
                        productId: item.productId,
                        productName: item.productName,
                        quantity: item.quantity,
                        unitPriceCharged: item.unitPrice,
                        batchUnitCost: item.unitCost,
                        suggestedCorrectUnitPrice: correct,
                        suggestedCreditPerUnit: netPerUnit,
                        suggestedLineCredit: lineCredit,
                        pricingScope: resolved.appliedRule?.scope ?? null,
                    });
                }
            }
        }

        const settlement = await invoiceRepository.getInvoiceSettlement(pool, invoiceId);
        const outstandingBalance = settlement?.amountDue ?? invoice.outstandingBalance;
        const amountPaid = settlement?.amountPaid ?? invoice.amountPaid;

        const existingCreditNoteTotal = await creditDebitNoteRepository.sumPostedCreditNotesForInvoice(
            pool,
            invoiceId,
        );

        const totalSuggestedCredit = overchargeLines.reduce(
            (sum, l) => sum + l.suggestedLineCredit,
            0,
        );
        const remainingOverchargeCredit = Math.max(
            0,
            Math.max(grossOverchargeTotal, totalSuggestedCredit) - existingCreditNoteTotal,
        );
        if (
            overchargeLines.length > 0
            && totalSuggestedCredit > remainingOverchargeCredit + 0.009
            && remainingOverchargeCredit > 0.009
        ) {
            const scale = remainingOverchargeCredit / totalSuggestedCredit;
            for (const line of overchargeLines) {
                line.suggestedLineCredit = Money.toNumber(
                    Money.multiply(Money.parseDb(line.suggestedLineCredit), Money.parseDb(scale)),
                );
                line.suggestedCreditPerUnit = line.quantity > 0
                    ? line.suggestedLineCredit / line.quantity
                    : 0;
            }
        }
        const totalSuggestedCreditAfterCap = overchargeLines.reduce(
            (sum, l) => sum + l.suggestedLineCredit,
            0,
        );
        const invoiceHeadroom = Math.max(0, invoice.totalAmount - existingCreditNoteTotal);
        const maxAdditionalCredit = Math.min(
            outstandingBalance,
            invoiceHeadroom,
            remainingOverchargeCredit,
            totalSuggestedCreditAfterCap,
        );

        if (outstandingBalance <= 0.009 && overchargeLines.length === 0 && returnableLines.length === 0) {
            throw new BusinessRuleException(
                'This invoice is fully settled and has no lines eligible for price correction or return.',
                'ADJUST_INVOICE_SETTLED',
            );
        }
        if (remainingOverchargeCredit <= 0.009 && grossOverchargeTotal > 0.009) {
            throw new BusinessRuleException(
                existingCreditNoteTotal > 0.009
                    ? `Prior posted credit notes (${existingCreditNoteTotal.toFixed(2)}) already cover the remaining overcharge on this invoice.`
                    : 'Credit notes already cover the full overcharge on this invoice. No further adjustment is allowed.',
                'ADJUST_ALREADY_CREDITED',
                { existingCreditNoteTotal, outstandingBalance, invoiceTotal: invoice.totalAmount },
            );
        }
        if (overchargeLines.length > 0 && maxAdditionalCredit <= 0.009) {
            throw new BusinessRuleException(
                `No further price correction is available (maximum ${maxAdditionalCredit.toFixed(2)}).`,
                'ADJUST_CREDIT_LIMIT_ZERO',
                { maxAdditionalCredit, outstandingBalance, invoiceTotal: invoice.totalAmount },
            );
        }
        if (outstandingBalance <= 0.009 && maxAdditionalCredit <= 0.009 && returnableLines.length === 0) {
            throw new BusinessRuleException(
                'Cannot adjust a fully paid invoice with no remaining correctable amount.',
                'ADJUST_INVOICE_SETTLED',
            );
        }

        let suggestedIntent: AdjustmentContext['suggestedIntent'] = 'NONE';
        if (overchargeLines.length > 0) suggestedIntent = 'PRICE_CORRECTION';
        else if (returnableLines.length > 0) suggestedIntent = 'RETURN_GOODS';

        return {
            invoice: {
                id: invoice.id,
                invoiceNumber: invoice.invoiceNumber,
                customerId: invoice.customerId,
                customerName: invoice.customerName,
                totalAmount: invoice.totalAmount,
                amountPaid,
                outstandingBalance,
                status: invoice.status,
                saleId,
                saleNumber,
                saleStatus,
            },
            customerPricingMode: pricingMode ?? 'STANDARD',
            overchargeLines,
            returnableLines,
            existingCreditNoteTotal,
            totalSuggestedCredit: totalSuggestedCreditAfterCap,
            remainingOverchargeCredit,
            maxAdditionalCredit,
            suggestedIntent,
        };
    },

    async adjust(
        pool: Pool,
        input: AdjustCustomerInvoice,
        userId: string,
    ): Promise<AdjustmentResult> {
        const context = await this.getInvoiceContext(pool, input.invoiceId);

        if (input.intent === 'PRICE_CORRECTION') {
            return this.adjustPriceCorrection(pool, input, context, userId);
        }
        return this.adjustReturnGoods(pool, input, context, userId);
    },

    async adjustPriceCorrection(
        pool: Pool,
        input: Extract<AdjustCustomerInvoice, { intent: 'PRICE_CORRECTION' }>,
        context: AdjustmentContext,
        userId: string,
    ): Promise<AdjustmentResult> {
        const bySaleItem = new Map(context.overchargeLines.map((l) => [l.saleItemId, l]));
        const cnLines: Array<{
            productId: string;
            productName: string;
            description: string;
            quantity: number;
            unitPrice: number;
            taxRate: number;
        }> = [];

        for (const sel of input.lines) {
            const line = bySaleItem.get(sel.saleItemId);
            if (!line) {
                throw new BusinessRuleException(
                    `Line ${sel.saleItemId} is not eligible for price correction on this invoice`,
                    'ADJUST_LINE_NOT_ELIGIBLE',
                    { saleItemId: sel.saleItemId },
                );
            }
            cnLines.push({
                productId: line.productId,
                productName: line.productName,
                description: `sale_item:${line.saleItemId}|charged:${line.unitPriceCharged}|correct:${line.suggestedCorrectUnitPrice}`,
                quantity: line.quantity,
                unitPrice: line.suggestedCreditPerUnit,
                taxRate: 0,
            });
        }

        let totalCredit = cnLines.reduce(
            (sum, l) => sum + l.quantity * l.unitPrice,
            0,
        );
        if (totalCredit <= 0) {
            throw new BusinessRuleException(
                'Total credit must be greater than zero',
                'ADJUST_ZERO_CREDIT',
            );
        }
        const postedCnTotal = await creditDebitNoteRepository.sumPostedCreditNotesForInvoice(
            pool,
            input.invoiceId,
        );
        const invoiceHeadroom = Math.max(0, context.invoice.totalAmount - postedCnTotal);
        const allowedCredit = Math.min(
            context.maxAdditionalCredit,
            context.invoice.outstandingBalance,
            invoiceHeadroom,
        );

        if (totalCredit > allowedCredit + 0.01) {
            if (allowedCredit <= 0.009) {
                throw new BusinessRuleException(
                    postedCnTotal > 0.009
                        ? `Prior posted credit notes (${postedCnTotal.toFixed(2)}) already use the allowable credit on invoice ${context.invoice.invoiceNumber} (total ${context.invoice.totalAmount.toFixed(2)}).`
                        : 'No further price correction is available on this invoice.',
                    'ADJUST_CREDIT_LIMIT_ZERO',
                    { postedCnTotal, invoiceTotal: context.invoice.totalAmount },
                );
            }
            const requestedCredit = totalCredit;
            const scale = allowedCredit / totalCredit;
            for (const line of cnLines) {
                line.unitPrice = Money.toNumber(
                    Money.multiply(Money.parseDb(line.unitPrice), Money.parseDb(scale)),
                );
            }
            totalCredit = cnLines.reduce((sum, l) => sum + l.quantity * l.unitPrice, 0);
            logger.warn('Customer adjustment: scaled credit to invoice headroom', {
                invoiceId: input.invoiceId,
                requestedCredit,
                allowedCredit,
                postedCnTotal,
                scale,
            });
        }

        if (totalCredit <= 0.009) {
            throw new BusinessRuleException(
                'Total credit must be greater than zero after applying prior credit notes.',
                'ADJUST_ZERO_CREDIT',
            );
        }

        logger.info('Customer adjustment: PRICE_CORRECTION', {
            invoiceId: input.invoiceId,
            lineCount: cnLines.length,
            totalCredit,
            userId,
        });

        const { note } = await creditDebitNoteService.createCreditNote(pool, {
            invoiceId: input.invoiceId,
            noteType: 'PRICE_CORRECTION',
            reason: input.reason,
            notes: input.notes,
            returnsGoods: false,
            lines: cnLines,
        });

        const posted = await creditDebitNoteService.postNote(pool, note.id, userId);

        return {
            intent: 'PRICE_CORRECTION',
            creditNoteId: posted.id,
            creditNoteNumber: posted.invoiceNumber,
            totalCredit,
        };
    },

    async adjustReturnGoods(
        pool: Pool,
        input: Extract<AdjustCustomerInvoice, { intent: 'RETURN_GOODS' }>,
        context: AdjustmentContext,
        userId: string,
    ): Promise<AdjustmentResult> {
        const bySaleItem = new Map(context.returnableLines.map((l) => [l.saleItemId, l]));
        const cnLines: Array<{
            productId: string;
            productName: string;
            description: string;
            quantity: number;
            unitPrice: number;
            taxRate: number;
        }> = [];

        const freshQty = await pool.query<{ id: string; quantity: string; refunded_qty: string }>(
            `SELECT id, quantity::text, COALESCE(refunded_qty, 0)::text AS refunded_qty
             FROM sale_items
             WHERE id = ANY($1::uuid[])`,
            [input.lines.map((l) => l.saleItemId)],
        );
        const remainingByItem = new Map(
            freshQty.rows.map((row) => [
                row.id,
                Math.max(0, Number(row.quantity) - Number(row.refunded_qty)),
            ]),
        );

        for (const sel of input.lines) {
            const line = bySaleItem.get(sel.saleItemId);
            if (!line) {
                throw new BusinessRuleException(
                    `Line ${sel.saleItemId} is not returnable on this invoice`,
                    'ADJUST_RETURN_LINE_INVALID',
                    { saleItemId: sel.saleItemId },
                );
            }
            const remaining = remainingByItem.get(sel.saleItemId) ?? line.returnableQuantity;
            if (sel.quantity > remaining + 0.0001) {
                throw new BusinessRuleException(
                    `Return quantity exceeds sale quantity for ${line.productName}`,
                    'ADJUST_RETURN_QTY_EXCEEDED',
                    { saleItemId: sel.saleItemId, max: remaining },
                );
            }
            cnLines.push({
                productId: line.productId,
                productName: line.productName,
                description: `sale_item:${line.saleItemId}|return`,
                quantity: sel.quantity,
                unitPrice: line.unitPrice,
                taxRate: line.taxRate,
            });
        }

        const totalCredit = cnLines.reduce(
            (sum, l) => sum + l.quantity * l.unitPrice,
            0,
        );

        logger.info('Customer adjustment: RETURN_GOODS', {
            invoiceId: input.invoiceId,
            lineCount: cnLines.length,
            totalCredit,
            userId,
        });

        const { note } = await creditDebitNoteService.createCreditNote(pool, {
            invoiceId: input.invoiceId,
            noteType: 'PARTIAL',
            reason: input.reason,
            notes: input.notes,
            returnsGoods: true,
            lines: cnLines,
        });

        const posted = await creditDebitNoteService.postNote(pool, note.id, userId);

        const saleId = context.invoice.saleId;
        if (saleId) {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                for (const sel of input.lines) {
                    await salesRepository.incrementRefundedQty(client, sel.saleItemId, sel.quantity);
                }
                await salesRepository.syncSaleStatusAfterCustomerReturn(client, saleId);
                await client.query('COMMIT');
            } catch (syncErr) {
                await client.query('ROLLBACK');
                logger.error('Failed to sync sale_items after customer return CN', {
                    invoiceId: input.invoiceId,
                    saleId,
                    error: syncErr instanceof Error ? syncErr.message : String(syncErr),
                });
                throw syncErr;
            } finally {
                client.release();
            }
        }

        return {
            intent: 'RETURN_GOODS',
            creditNoteId: posted.id,
            creditNoteNumber: posted.invoiceNumber,
            totalCredit: posted.totalAmount,
        };
    },
};
