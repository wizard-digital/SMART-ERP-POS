import { describe, expect, it } from '@jest/globals';
import { computeInvoiceSettlement, saleLineReturnTaxRate } from './invoiceSettlement.js';

describe('invoice settlement', () => {
    it('reduces a credit invoice by a completed sale return', () => {
        const result = computeInvoiceSettlement({
            totalAmount: 147960,
            cashPaid: 0,
            creditNoteAmount: 0,
            debitNoteAmount: 0,
            writeoffAmount: 0,
            creditSaleRefundAmount: 40000,
        });
        expect(result.amountDue).toBe(107960);
        expect(result.amountPaid).toBe(40000);
    });

    it('keeps a posted credit note and does not add a sale return that is not there', () => {
        const result = computeInvoiceSettlement({
            totalAmount: 147960,
            cashPaid: 0,
            creditNoteAmount: 147960,
            debitNoteAmount: 0,
            writeoffAmount: 0,
            creditSaleRefundAmount: 0,
        });
        expect(result.amountDue).toBe(0);
        expect(result.amountPaid).toBe(147960);
    });

    it('does not let the customer be credited above the invoice total', () => {
        const result = computeInvoiceSettlement({
            totalAmount: 100,
            cashPaid: 40,
            creditNoteAmount: 0,
            debitNoteAmount: 0,
            writeoffAmount: 0,
            creditSaleRefundAmount: 80,
        });
        expect(result.amountDue).toBe(0);
        expect(result.amountPaid).toBe(100);
    });

    it('uses the stored sale-line tax rate for a return of goods', () => {
        expect(saleLineReturnTaxRate({ lineNet: 100, lineTax: 18, storedRate: 18 })).toBe(18);
    });

    it('derives the tax rate when the sale line stored tax as an amount only', () => {
        expect(saleLineReturnTaxRate({ lineNet: 126000, lineTax: 21960, storedRate: 0 })).toBeCloseTo(17.428571, 4);
    });
});
