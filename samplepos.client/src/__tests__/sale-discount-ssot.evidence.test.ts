/**
 * PROOF: sale detail / POS receipt / checkout payload — executed, not greps.
 *
 * Run: npx vitest run src/__tests__/sale-discount-ssot.evidence.test.ts
 */
import { describe, expect, it } from 'vitest';
import {
  buildCheckoutDiscountPayload,
  documentReductionLabel,
  inventedUnitFromCopiedDump,
  presentSaleDiscounts,
  projectExchangeReplacementSale,
} from '../../../shared/domain/saleDiscountSsot';
import { buildReceiptDataFromSale } from '../lib/receiptFromSale';

describe('Sale discount SSOT (client executed)', () => {
  it('receipt for copied-cart historic sale shows 306k unit, 6k cart, 300k total', () => {
    const invented = inventedUnitFromCopiedDump(306000, 6000, 1);
    expect(invented).toBe(312000);
    const data = buildReceiptDataFromSale({
      saleNumber: 'SALE-2026-0028',
      totalAmount: 300000,
      subtotal: 306000,
      discountAmount: 6000,
      taxAmount: 0,
      items: [
        {
          productName: 'SLIMLINE FLASK 0.5L',
          quantity: 1,
          unitPrice: 306000,
          totalPrice: 306000,
          discountAmount: 6000,
        },
      ],
    });
    expect(data.totalAmount).toBe(300000);
    expect(data.subtotal).toBe(306000);
    expect(data.discountAmount).toBe(6000);
    expect(data.items?.[0].unitPrice).toBe(306000);
    expect(data.items?.[0].unitPrice).not.toBe(invented);
    expect(data.items?.[0].discountAmount).toBeUndefined();
  });

  it('exchange replacement receipt labels Exchange credit and keeps 306k unit', () => {
    const exchange = projectExchangeReplacementSale({
      replacementItems: [{ quantity: 1, unitPrice: 306000, lineDiscount: 0 }],
      remainingCredit: 6000,
    });
    expect(exchange.identity.ok).toBe(true);
    const data = buildReceiptDataFromSale({
      saleNumber: 'SALE-EX-1',
      totalAmount: exchange.persist.chargedTotal,
      subtotal: exchange.persist.merchandiseNet,
      discountAmount: exchange.persist.headerDiscountDump,
      exchangeCreditApplied: exchange.creditApplied,
      taxAmount: 0,
      items: [
        {
          productName: 'SLIMLINE FLASK 0.5L',
          quantity: exchange.persist.items[0].quantity,
          unitPrice: exchange.persist.items[0].unitPrice,
          totalPrice: exchange.persist.items[0].totalPrice,
          discountAmount: exchange.persist.items[0].discountAmount,
        },
      ],
    });
    expect(data.discountLabel).toBe('Exchange credit');
    expect(documentReductionLabel(true)).toBe('Exchange credit');
    expect(data.items?.[0].unitPrice).toBe(306000);
    expect(data.items?.[0].discountAmount).toBeUndefined();
    expect(data.discountAmount).toBe(6000);
    expect(data.totalAmount).toBe(300000);
  });

  it('POS checkout payload never adds exchange credit onto the line', () => {
    const payload = buildCheckoutDiscountPayload({
      items: [{ quantity: 1, unitPrice: 306000, lineDiscount: 0 }],
      cartDiscount: 6000,
      isExchangeCredit: true,
    });
    expect(payload.items[0].discountAmount).toBe(0);
    expect(payload.discountAmount).toBe(6000);
    expect(payload.exchangeCreditApplied).toBe(6000);
    const view = presentSaleDiscounts({
      totalAmount: payload.persist.chargedTotal,
      items: payload.persist.items.map((line) => ({
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        lineNet: line.totalPrice,
      })),
    });
    expect(view.lines[0].unitPrice + view.lines[0].lineDiscount).not.toBe(312000);
    expect(view.cartDiscount).toBe(6000);
  });

  it('presentSaleDiscounts never stacks the same 6k twice from a 312k reconstruction', () => {
    const view = presentSaleDiscounts({
      totalAmount: 300000,
      items: [{ quantity: 1, unitPrice: 306000, lineNet: 306000 }],
    });
    expect(view.lines[0].unitPrice + view.lines[0].lineDiscount).not.toBe(312000);
    expect(view.cartDiscount).toBe(6000);
  });
});
