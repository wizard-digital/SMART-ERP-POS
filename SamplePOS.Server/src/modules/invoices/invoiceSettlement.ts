/**
 * Invoice open-item settlement.
 *
 * One formula owns amount_due. Cash, posted credit notes, posted debit notes,
 * bad-debt write-offs, and completed credit-sale returns all settle the same invoice.
 * A later recalculation cannot put a returned credit sale back onto the customer.
 */
import { Money } from '../../utils/money.js';

export interface InvoiceSettlementComponents {
    totalAmount: number | string;
    cashPaid: number | string;
    creditNoteAmount: number | string;
    debitNoteAmount: number | string;
    writeoffAmount: number | string;
    /** Completed returns on the linked CREDIT sale. Not a second cash receipt. */
    creditSaleRefundAmount: number | string;
}

export function computeInvoiceSettlement(parts: InvoiceSettlementComponents): {
    totalAmount: number;
    amountPaid: number;
    amountDue: number;
} {
    const total = Money.parseDb(parts.totalAmount);
    const settled = Money.parseDb(parts.cashPaid)
        .plus(Money.parseDb(parts.creditNoteAmount))
        .minus(Money.parseDb(parts.debitNoteAmount))
        .plus(Money.parseDb(parts.writeoffAmount))
        .plus(Money.parseDb(parts.creditSaleRefundAmount));
    const amountPaid = Money.min(total, Money.max(settled, Money.zero()));
    const amountDue = Money.max(Money.zero(), Money.subtract(total, amountPaid));
    return {
        totalAmount: Money.toNumber(total),
        amountPaid: Money.toNumber(amountPaid),
        amountDue: Money.toNumber(amountDue),
    };
}

/**
 * Tax rate for a return credit note line. Prefer the rate stored on the sale line.
 * If only a tax amount was stored, derive the rate from that amount so the credit
 * reverses the VAT the customer was billed.
 */
export function saleLineReturnTaxRate(args: {
    lineNet: number;
    lineTax: number;
    storedRate: number;
}): number {
    const stored = Money.toNumber(Money.parseDb(args.storedRate));
    if (stored > 0) return stored;
    const net = Money.parseDb(args.lineNet);
    const tax = Money.parseDb(args.lineTax);
    if (net.greaterThan(0.009) && tax.greaterThan(0.009)) {
        return Money.toNumber(Money.multiply(Money.divide(tax, net), 100));
    }
    return 0;
}
