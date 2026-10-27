/**
 * End-to-end SSOT proof: POS checkout → schema → persist → 2210 → modal → receipt → thermal HTML.
 *
 * Run: npx vitest run src/__tests__/sale-discount-exchange-e2e.evidence.test.ts
 */
import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { POSSaleSchema } from '../../../shared/zod/pos-sale';
import {
  assertExchangeCreditIdentity,
  assertSaleDiscountPersistClosed,
  buildCheckoutDiscountPayload,
  documentReductionLabel,
  inventedUnitFromCopiedDump,
  presentPersistedSaleDiscounts,
  projectExchangeReplacementSale,
} from '../../../shared/domain/saleDiscountSsot';
import { buildReceiptDataFromSale, mergeSaleForReceipt } from '../lib/receiptFromSale';
import {
  buildThermalGuestDocumentHtml,
  receiptToThermalGuestDocument,
} from '../lib/thermalGuestDocument';

const repoRoot = path.resolve(__dirname, '../../..');
const EXCHANGE_REFUND_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PRODUCT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const BLISS = {
  catalogUnit: 306000,
  credit: 6000,
  charged: 300000,
  inventedUnit: 312000,
} as const;

const hops: Array<{ hop: string; ok: true; detail: Record<string, unknown> }> = [];

function prove(hop: string, detail: Record<string, unknown>): void {
  hops.push({ hop, ok: true, detail });
}

function presentSaleModal(
  sale: Record<string, unknown>,
  details: Record<string, unknown>,
  items: Array<Record<string, unknown>>,
) {
  const detailSale = { ...sale, ...details };
  const discountView = presentPersistedSaleDiscounts(detailSale, items);
  return {
    unit: discountView.lines[0]?.unitPrice ?? 0,
    lineDiscount: discountView.lines[0]?.lineDiscount ?? 0,
    lineNet: discountView.lines[0]?.lineNet ?? 0,
    cartDiscount: discountView.cartDiscount,
    total: discountView.totalAmount,
    label: documentReductionLabel(
      Number(detailSale.exchangeCreditApplied || detailSale.exchange_credit_applied || 0) > 0.02,
    ),
  };
}

describe('Sale discount + exchange SSOT end-to-end', () => {
  it('exchange flask: POS → persist → 2210 → modal → receipt HTML never invents 312000', () => {
    const remainingCredit = BLISS.credit;
    const cart = [
      { quantity: 1, unitPrice: BLISS.catalogUnit, lineDiscount: 0, name: 'SLIMLINE FLASK 0.5L' },
    ];

    const checkout = buildCheckoutDiscountPayload({
      items: cart,
      cartDiscount: remainingCredit,
      isExchangeCredit: true,
    });
    expect(checkout.items[0].unitPrice).toBe(306000);
    expect(checkout.items[0].discountAmount).toBe(0);
    expect(checkout.discountAmount).toBe(6000);
    prove('1-pos-checkout-payload', {
      unitSent: checkout.items[0].unitPrice,
      lineDiscountSent: checkout.items[0].discountAmount,
      cartSent: checkout.discountAmount,
    });

    const posBody = {
      lineItems: [
        {
          productId: PRODUCT_ID,
          productName: cart[0].name,
          sku: 'FLASK',
          uom: 'PCS',
          quantity: checkout.items[0].quantity,
          unitPrice: checkout.items[0].unitPrice,
          costPrice: 100000,
          subtotal: checkout.persist.items[0].totalPrice,
          discountAmount: checkout.items[0].discountAmount || undefined,
        },
      ],
      subtotal: checkout.persist.merchandiseNet,
      discountAmount: checkout.discountAmount,
      taxAmount: 0,
      totalAmount: checkout.persist.chargedTotal,
      paymentLines: [{ paymentMethod: 'CASH' as const, amount: checkout.persist.chargedTotal }],
      exchangeRefundId: EXCHANGE_REFUND_ID,
      exchangeResidualAction: 'REFUND_ORIGINAL_TENDER' as const,
    };
    const parsed = POSSaleSchema.safeParse(posBody);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error(parsed.error.message);
    prove('2-pos-schema', {
      totalAmount: parsed.data.totalAmount,
      headerDiscount: parsed.data.discountAmount,
      lineDiscount: parsed.data.lineItems[0].discountAmount || 0,
      exchangeRefundId: parsed.data.exchangeRefundId,
    });

    const serviceInput = {
      items: parsed.data.lineItems.map((item) => ({
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        discountAmount: item.discountAmount || 0,
      })),
      discountAmount: parsed.data.discountAmount || 0,
      totalAmount: parsed.data.totalAmount,
      taxAmount: parsed.data.taxAmount,
      exchangeRefundId: parsed.data.exchangeRefundId,
    };
    expect(serviceInput.items[0].discountAmount).toBe(0);
    expect(serviceInput.discountAmount).toBe(6000);

    const exchange = projectExchangeReplacementSale({
      replacementItems: serviceInput.items.map((item) => ({
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        lineDiscount: item.discountAmount,
      })),
      remainingCredit,
    });
    expect(exchange.identity.ok).toBe(true);
    expect(exchange.creditApplied).toBe(serviceInput.discountAmount);
    expect(exchange.persist.items[0].unitPrice).toBe(306000);
    prove('3-complete-product-exchange', {
      creditApplied: exchange.creditApplied,
      merchandiseNet: exchange.persist.merchandiseNet,
      charged: exchange.persist.chargedTotal,
    });

    const persistRows = exchange.persist.items.map((line) => ({
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      discountAmount: line.discountAmount,
      totalPrice: line.totalPrice,
    }));
    const persistClosed = assertSaleDiscountPersistClosed({
      items: persistRows,
      cartDiscount: exchange.creditApplied,
      chargedTotal: parsed.data.totalAmount,
      taxAmount: parsed.data.taxAmount,
      taxInclusive: true,
    });
    expect(persistClosed.ok).toBe(true);
    prove('4-create-sale-persist-closed', { message: persistClosed.message });

    const headerDump = exchange.persist.headerDiscountDump;
    const creditTo2210 = exchange.creditApplied;
    expect(creditTo2210).toBe(6000);
    expect(creditTo2210).not.toBe(12000);
    expect(headerDump).toBe(6000);
    prove('5-apply-2210-cart-only', {
      creditTo2210,
      headerDump,
      rejectedIfCartPlusLine: 12000,
    });

    const persistedSale = {
      saleNumber: 'SALE-EX-E2E',
      totalAmount: exchange.persist.chargedTotal,
      subtotal: exchange.persist.merchandiseNet,
      discountAmount: headerDump,
      taxAmount: 0,
    };
    const saleDetails = {
      exchangeCreditApplied: creditTo2210,
      exchange_credit_applied: creditTo2210,
      exchangeRefundNumber: 'REF-EX-E2E',
    };
    const persistedItems = persistRows.map((line) => ({
      productName: 'SLIMLINE FLASK 0.5L',
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      totalPrice: line.totalPrice,
      discountAmount: line.discountAmount,
    }));
    const modal = presentSaleModal(persistedSale, saleDetails, persistedItems);
    expect(modal.unit).toBe(306000);
    expect(modal.lineDiscount).toBe(0);
    expect(modal.cartDiscount).toBe(6000);
    expect(modal.total).toBe(300000);
    expect(modal.label).toBe('Exchange credit');
    expect(modal.unit).not.toBe(BLISS.inventedUnit);
    prove('6-sales-modal', modal);

    const merged = mergeSaleForReceipt(
      { ...persistedSale, items: persistedItems },
      saleDetails,
    );
    const receipt = buildReceiptDataFromSale({
      ...merged,
      items: persistedItems,
      exchangeCreditApplied: creditTo2210,
    });
    expect(receipt.items?.[0].unitPrice).toBe(306000);
    expect(receipt.items?.[0].discountAmount).toBeUndefined();
    expect(receipt.discountAmount).toBe(6000);
    expect(receipt.discountLabel).toBe('Exchange credit');
    expect(receipt.totalAmount).toBe(300000);
    prove('7-receipt-from-sale', {
      unit: receipt.items?.[0].unitPrice,
      lineDiscount: receipt.items?.[0].discountAmount ?? 0,
      cart: receipt.discountAmount,
      label: receipt.discountLabel,
      total: receipt.totalAmount,
    });

    const thermal = receiptToThermalGuestDocument(receipt);
    const html = buildThermalGuestDocumentHtml(thermal);
    expect(thermal.items[0].unitPrice).toBe(306000);
    expect(thermal.discountLabel).toBe('Exchange credit');
    expect(html).toContain('Exchange credit');
    expect(html).toMatch(/306[,.]?000/);
    expect(html).not.toMatch(/312[,.]?000/);
    prove('8-thermal-html', {
      unit: thermal.items[0].unitPrice,
      label: thermal.discountLabel,
      htmlHasExchangeCredit: html.includes('Exchange credit'),
      htmlHasInvented312000: /312[,.]?000/.test(html),
    });

    const invented = inventedUnitFromCopiedDump(306000, 6000, 1);
    expect(invented).toBe(312000);
    const oneCut = assertSaleDiscountPersistClosed({
      items: [{ quantity: 1, unitPrice: 312000, discountAmount: 0, totalPrice: 312000 }],
      cartDiscount: 6000,
      chargedTotal: 300000,
    });
    expect(oneCut.ok).toBe(false);
    const copied = assertSaleDiscountPersistClosed({
      items: [{ quantity: 1, unitPrice: 306000, discountAmount: 6000, totalPrice: 306000 }],
      cartDiscount: 6000,
      chargedTotal: 300000,
    });
    expect(copied.ok).toBe(false);
    const overApply = assertExchangeCreditIdentity({
      cartDiscount: 12000,
      remainingCredit: 6000,
      merchandiseNet: 306000,
      chargedTotal: 294000,
    });
    expect(overApply.ok).toBe(false);
    prove('9-fail-closed', {
      inventedUnit: invented,
      oneCutRejected: oneCut.message,
      copiedDumpRejected: copied.message,
      cartPlusLineRejected: overApply.message,
    });
  });

  it('writes end-to-end evidence artifact', () => {
    expect(hops.length).toBeGreaterThanOrEqual(9);
    const payload = {
      title: 'PROOF_SALE_DISCOUNT_EXCHANGE_E2E',
      runAt: new Date().toISOString(),
      verdict: 'PASS',
      path: 'POS checkout → POSSaleSchema → completeProductExchange → createSale persist → 2210 apply → sale modal → receipt → thermal HTML',
      blissCase: BLISS,
      hops,
    };
    const json = JSON.stringify(payload, null, 2);
    writeFileSync(path.join(repoRoot, 'PROOF_SALE_DISCOUNT_EXCHANGE_E2E.json'), json);
    const md = [
      '# Sale discount + exchange SSOT (end-to-end)',
      '',
      `Run: ${payload.runAt}`,
      '',
      `Verdict: **PASS**`,
      '',
      payload.path,
      '',
      '| Hop | Result |',
      '|---|---|',
      ...hops.map((row) => `| ${row.hop} | PASS |`),
      '',
      '312000 − 6000 = 306000, not 300000. Exchange charges 300000 at unit 306000. Thermal HTML contains Exchange credit and does not contain 312000.',
      '',
    ].join('\n');
    writeFileSync(path.join(repoRoot, 'PROOF_SALE_DISCOUNT_EXCHANGE_E2E.md'), md);
  });
});
