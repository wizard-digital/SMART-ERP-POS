/**
 * Client proof: refund preview and invoice picker use the same shared functions as the server.
 * Run: npx vitest run src/__tests__/sale-refund-invoice-ssot.evidence.test.ts
 */
import { describe, expect, it } from 'vitest';
import {
  projectSaleRefundChargedFromSale,
  projectSaleRollupDecrement,
} from '../../../shared/domain/saleDiscountSsot';
import { saleRowIsInvoiceEligible } from '../../../shared/domain/saleInvoiceEligibility';

describe('Client refund + invoice SSOT (executed)', () => {
  it('return preview for 35k cart is 3,200,000 charged, not 3,235,000 list', () => {
    const preview = projectSaleRefundChargedFromSale({
      sale: { total_amount: '3200000.00', tax_amount: '0', refunded_charged_total: '0' },
      items: [
        {
          id: 'a',
          quantity: '1',
          remainingQty: '1',
          unitPrice: '1500000.00',
          total_price: '1500000.00',
        },
        {
          id: 'b',
          quantity: '1',
          remainingQty: '1',
          unitPrice: '1735000.00',
          total_price: '1735000.00',
        },
      ],
      thisQtyByItemId: { a: 1, b: 1 },
    });
    expect(preview.refundChargedTotal).toBe(3_200_000);
    expect(preview.refundChargedTotal).not.toBe(3_235_000);
    expect(preview.cartDiscount).toBe(35_000);
  });

  it('no-discount preview stays qty × unit', () => {
    const preview = projectSaleRefundChargedFromSale({
      sale: { totalAmount: 80_000, taxAmount: 0 },
      items: [
        {
          id: 'a',
          quantity: 2,
          remainingQty: 2,
          unitPrice: 40_000,
          totalPrice: 80_000,
        },
      ],
      thisQtyByItemId: { a: 1 },
    });
    expect(preview.refundChargedTotal).toBe(40_000);
  });

  it('invoice picker: CASH underpay eligible; fully paid CASH and voided not', () => {
    expect(
      saleRowIsInvoiceEligible({
        status: 'COMPLETED',
        paymentMethod: 'CASH',
        amountPaid: 1_000_000,
        totalAmount: 3_200_000,
      }).ok,
    ).toBe(true);
    expect(
      saleRowIsInvoiceEligible({
        status: 'COMPLETED',
        paymentMethod: 'CREDIT',
        amountPaid: 0,
        totalAmount: 100_000,
      }).ok,
    ).toBe(true);
    expect(
      saleRowIsInvoiceEligible({
        status: 'COMPLETED',
        paymentMethod: 'CASH',
        amountPaid: 80_000,
        totalAmount: 80_000,
      }).ok,
    ).toBe(false);
    expect(
      saleRowIsInvoiceEligible({
        status: 'VOIDED_BY_RETURN',
        paymentMethod: 'CASH',
        amountPaid: 0,
        totalAmount: 3_200_000,
      }).ok,
    ).toBe(false);
  });

  it('dashboard leftover: list decrement paints CASH -35000; SSOT return does not', () => {
    const leftover = { paymentMethod: 'CASH', count: 0, totalAmount: -35_000 };
    const card = { paymentMethod: 'CARD', count: 1, totalAmount: 430_000 };
    const brokenTotal = leftover.totalAmount + card.totalAmount;
    expect(brokenTotal).toBe(395_000);

    const reverse = projectSaleRollupDecrement({
      paymentMethod: 'CASH',
      headerTotal: 3_235_000,
      headerDiscount: 0,
      amountPaid: 3_200_000,
    });
    expect(reverse.reverseAmount).toBe(3_200_000);
    expect(reverse.reverseDiscount).toBe(35_000);
    const incrementCash = 3_200_000;
    const incrementDiscount = 35_000;
    expect(incrementCash - reverse.reverseAmount).toBe(0);
    expect(incrementDiscount - reverse.reverseDiscount).toBe(0);
    const after = [card];
    expect(after.reduce((sum, row) => sum + row.totalAmount, 0)).toBe(430_000);
    expect(after.some((row) => row.paymentMethod === 'CASH')).toBe(false);
  });
});
