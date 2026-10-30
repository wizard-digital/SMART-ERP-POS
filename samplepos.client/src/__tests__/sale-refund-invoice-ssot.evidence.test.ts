/**
 * Client proof: refund preview and invoice picker use the same shared functions as the server.
 * Run: npx vitest run src/__tests__/sale-refund-invoice-ssot.evidence.test.ts
 */
import { describe, expect, it } from 'vitest';
import { projectSaleRefundChargedFromSale } from '../../../shared/domain/saleDiscountSsot';
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
});
