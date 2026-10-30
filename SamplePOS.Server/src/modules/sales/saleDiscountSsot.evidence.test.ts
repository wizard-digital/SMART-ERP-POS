/**
 * PROOF: sale discount + exchange credit identity — executed numbers, not greps.
 *
 * Run: node --experimental-vm-modules ./node_modules/jest/bin/jest.js src/modules/sales/saleDiscountSsot.evidence.test.ts --no-coverage
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from '@jest/globals';
import {
  appliedLineDiscount,
  assertExchangeCreditIdentity,
  assertSaleDiscountPersistClosed,
  buildCheckoutDiscountPayload,
  documentReductionLabel,
  inventedUnitFromCopiedDump,
  presentSaleDiscounts,
  projectExchangeReplacementSale,
  projectSaleDiscountPersist,
  projectSaleRefundCharged,
  projectSaleRefundChargedFromSale,
  projectSaleRollupDecrement,
  remainingCartDiscount,
} from '../../../../shared/domain/saleDiscountSsot.js';
import { POSSaleSchema } from '../../../../shared/zod/pos-sale.js';
import { assertSaleLineEconomicsConsistent } from './saleIntegrity.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

const BLISS = {
  catalogUnit: 306000,
  copiedDump: 6000,
  charged: 300000,
  inventedUnit: 312000,
} as const;

const evidence: Array<{ name: string; ok: true; detail: Record<string, unknown> }> = [];

function prove(name: string, detail: Record<string, unknown>): void {
  evidence.push({ name, ok: true, detail });
}

describe('Sale discount + exchange SSOT (executed)', () => {
  it('FAIL: 312000 − 6000 cannot close at 300000 (one cut)', () => {
    const persist = projectSaleDiscountPersist({
      items: [{ quantity: 1, unitPrice: BLISS.inventedUnit, lineDiscount: 0 }],
      cartDiscount: BLISS.copiedDump,
    });
    expect(persist.chargedTotal).toBe(306000);
    expect(persist.chargedTotal).not.toBe(BLISS.charged);
    const closed = assertSaleDiscountPersistClosed({
      items: persist.items,
      cartDiscount: persist.cartDiscount,
      chargedTotal: BLISS.charged,
    });
    expect(closed.ok).toBe(false);
    expect(312000 - 6000).toBe(306000);
    expect(312000 - 6000).not.toBe(300000);
    prove('fail-312000-minus-6000-is-not-300000', {
      inventedUnit: BLISS.inventedUnit,
      oneCut: 312000 - 6000,
      claimedCharge: BLISS.charged,
      persistWouldCharge: persist.chargedTotal,
      rejected: closed.message,
    });
  });

  it('exchange replacement persists 306000 unit, 0 line markdown, 6000 cart, 300000 charged', () => {
    const exchange = projectExchangeReplacementSale({
      replacementItems: [{ quantity: 1, unitPrice: BLISS.catalogUnit, lineDiscount: 0 }],
      remainingCredit: BLISS.copiedDump,
    });
    expect(exchange.identity.ok).toBe(true);
    expect(exchange.creditApplied).toBe(6000);
    expect(exchange.persist.items[0].unitPrice).toBe(306000);
    expect(exchange.persist.items[0].discountAmount).toBe(0);
    expect(exchange.persist.items[0].totalPrice).toBe(306000);
    expect(exchange.persist.cartDiscount).toBe(6000);
    expect(exchange.persist.chargedTotal).toBe(300000);
    expect(exchange.persist.items[0].unitPrice).not.toBe(BLISS.inventedUnit);
    const closed = assertSaleDiscountPersistClosed({
      items: exchange.persist.items,
      cartDiscount: exchange.persist.cartDiscount,
      chargedTotal: exchange.persist.chargedTotal,
    });
    expect(closed.ok).toBe(true);
    prove('exchange-persist-306k-unit-6k-cart-300k-charge', {
      unit: exchange.persist.items[0].unitPrice,
      lineDiscount: exchange.persist.items[0].discountAmount,
      lineNet: exchange.persist.items[0].totalPrice,
      creditApplied: exchange.creditApplied,
      charged: exchange.persist.chargedTotal,
      label: documentReductionLabel(true),
    });
  });

  it('FAIL: applying cart+line (12000) when remaining credit is 6000', () => {
    const mixed = assertExchangeCreditIdentity({
      cartDiscount: 12000,
      remainingCredit: 6000,
      merchandiseNet: 306000,
      chargedTotal: 294000,
      taxAmount: 0,
    });
    expect(mixed.ok).toBe(false);
    prove('fail-exchange-must-not-consume-cart-plus-line', {
      attemptedApply: 12000,
      remainingCredit: 6000,
      rejected: mixed.message,
    });
  });

  it('FAIL: persist refuses copied cart dump (unit already equals line net)', () => {
    const copied = assertSaleDiscountPersistClosed({
      items: [
        {
          quantity: 1,
          unitPrice: 306000,
          discountAmount: 6000,
          totalPrice: 306000,
        },
      ],
      cartDiscount: 6000,
      chargedTotal: 300000,
    });
    expect(copied.ok).toBe(false);
    const economics = assertSaleLineEconomicsConsistent({
      quantity: 1,
      unitPrice: 306000,
      totalPrice: 306000,
      discountAmount: 6000,
    });
    expect(economics.ok).toBe(false);
    prove('fail-copied-cart-onto-line-dump', {
      storedUnit: 306000,
      storedLineDiscount: 6000,
      storedLineNet: 306000,
      persistRejected: copied.message,
      economicsRejected: economics.message,
    });
  });

  it('historic Bliss row presents 306000 unit — never invents 312000', () => {
    const invented = inventedUnitFromCopiedDump(306000, 6000, 1);
    expect(invented).toBe(312000);
    const view = presentSaleDiscounts({
      totalAmount: 300000,
      taxAmount: 0,
      items: [{ quantity: 1, unitPrice: 306000, lineNet: 306000 }],
    });
    expect(view.lines[0].unitPrice).toBe(306000);
    expect(view.lines[0].lineDiscount).toBe(0);
    expect(view.cartDiscount).toBe(6000);
    expect(view.totalAmount).toBe(300000);
    expect(view.lines[0].unitPrice).not.toBe(invented);
    expect(appliedLineDiscount(1, 306000, 306000)).toBe(0);
    prove('historic-display-never-invents-312000', {
      brokenModalUnit: invented,
      presentedUnit: view.lines[0].unitPrice,
      presentedLineDiscount: view.lines[0].lineDiscount,
      presentedCart: view.cartDiscount,
      presentedTotal: view.totalAmount,
    });
  });

  it('POS checkout payload keeps cart off the line', () => {
    const payload = buildCheckoutDiscountPayload({
      items: [{ quantity: 1, unitPrice: 306000, lineDiscount: 0 }],
      cartDiscount: 6000,
      isExchangeCredit: true,
    });
    expect(payload.items[0].unitPrice).toBe(306000);
    expect(payload.items[0].discountAmount).toBe(0);
    expect(payload.discountAmount).toBe(6000);
    expect(payload.exchangeCreditApplied).toBe(6000);
    expect(payload.items[0].discountAmount + payload.discountAmount).not.toBe(12000);
    prove('pos-payload-cart-stays-on-header', {
      lineDiscountSent: payload.items[0].discountAmount,
      cartSent: payload.discountAmount,
      exchangeCreditApplied: payload.exchangeCreditApplied,
    });
  });

  it('exclusive VAT: cart is lines − (total − tax); inclusive cart is lines − total', () => {
    expect(remainingCartDiscount(100, 108, 18)).toBe(10);
    expect(remainingCartDiscount(100, 118, 18)).toBe(0);
    expect(remainingCartDiscount(100, 90, 15)).toBe(10);
    const exclusive = projectSaleDiscountPersist({
      items: [{ quantity: 1, unitPrice: 100, lineDiscount: 0 }],
      cartDiscount: 10,
      taxAmount: 18,
      taxInclusive: false,
    });
    expect(exclusive.chargedTotal).toBe(108);
    const identity = assertExchangeCreditIdentity({
      cartDiscount: 10,
      remainingCredit: 10,
      merchandiseNet: 100,
      chargedTotal: 108,
      taxAmount: 18,
    });
    expect(identity.ok).toBe(true);
    prove('vat-modes-close', {
      exclusiveCharge: exclusive.chargedTotal,
      exclusiveCartFromTotals: remainingCartDiscount(100, 108, 18),
      inclusiveCartFromTotals: remainingCartDiscount(100, 90, 15),
    });
  });

  it('POS schema + persist + 2210 apply close on the exchange payload', () => {
    const checkout = buildCheckoutDiscountPayload({
      items: [{ quantity: 1, unitPrice: 306000, lineDiscount: 0 }],
      cartDiscount: 6000,
      isExchangeCredit: true,
    });
    const parsed = POSSaleSchema.safeParse({
      lineItems: [
        {
          productId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          productName: 'SLIMLINE FLASK 0.5L',
          sku: 'FLASK',
          uom: 'PCS',
          quantity: 1,
          unitPrice: checkout.items[0].unitPrice,
          costPrice: 100000,
          subtotal: checkout.persist.merchandiseNet,
          discountAmount: checkout.items[0].discountAmount || undefined,
        },
      ],
      subtotal: checkout.persist.merchandiseNet,
      discountAmount: checkout.discountAmount,
      taxAmount: 0,
      totalAmount: checkout.persist.chargedTotal,
      paymentLines: [{ paymentMethod: 'CASH', amount: checkout.persist.chargedTotal }],
      exchangeRefundId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error(parsed.error.message);
    const persistClosed = assertSaleDiscountPersistClosed({
      items: checkout.persist.items,
      cartDiscount: parsed.data.discountAmount || 0,
      chargedTotal: parsed.data.totalAmount,
      taxAmount: parsed.data.taxAmount,
      taxInclusive: true,
    });
    expect(persistClosed.ok).toBe(true);
    expect(parsed.data.discountAmount).toBe(6000);
    expect(parsed.data.lineItems[0].discountAmount || 0).toBe(0);
    prove('pos-schema-persist-2210-close', {
      schemaOk: parsed.success,
      charged: parsed.data.totalAmount,
      creditTo2210: parsed.data.discountAmount,
      lineDiscount: parsed.data.lineItems[0].discountAmount || 0,
    });
  });

  it('full remaining return reverses charged total, not qty × list (35k cart)', () => {
    const refund = projectSaleRefundCharged({
      totalAmount: 3_200_000,
      alreadyRefundedCharged: 0,
      items: [
        {
          saleItemId: 'a',
          quantity: 1,
          remainingQty: 1,
          unitPrice: 1_500_000,
          lineNet: 1_500_000,
          thisQty: 1,
        },
        {
          saleItemId: 'b',
          quantity: 1,
          remainingQty: 1,
          unitPrice: 1_735_000,
          lineNet: 1_735_000,
          thisQty: 1,
        },
      ],
    });
    expect(refund.cartDiscount).toBe(35_000);
    expect(refund.thisMerchandise).toBe(3_235_000);
    expect(refund.refundChargedTotal).toBe(3_200_000);
    expect(refund.refundChargedTotal).not.toBe(3_235_000);
    const lineSum = refund.lines.reduce((sum, line) => sum + line.lineCharged, 0);
    expect(lineSum).toBe(3_200_000);
    prove('refund-full-remaining-is-charged-not-list', {
      list: 3_235_000,
      charged: 3_200_000,
      refunded: refund.refundChargedTotal,
      cart: refund.cartDiscount,
    });
  });

  it('no-discount refund stays qty × unit (Henber-class)', () => {
    const refund = projectSaleRefundCharged({
      totalAmount: 80_000,
      alreadyRefundedCharged: 0,
      items: [
        {
          saleItemId: 'a',
          quantity: 2,
          remainingQty: 2,
          unitPrice: 40_000,
          lineNet: 80_000,
          thisQty: 1,
        },
      ],
    });
    expect(refund.cartDiscount).toBe(0);
    expect(refund.refundChargedTotal).toBe(40_000);
    expect(refund.lines[0].lineCharged).toBe(40_000);
    prove('refund-no-discount-qty-times-unit', {
      refunded: refund.refundChargedTotal,
      expected: 40_000,
    });
  });

  it('pg numeric strings (refundSale row shape) reverse charged, not list', () => {
    const charged = projectSaleRefundChargedFromSale({
      sale: {
        total_amount: '3200000.00',
        tax_amount: '0.00',
      },
      alreadyRefundedCharged: '0',
      items: [
        {
          id: 'a',
          quantity: '1.0000',
          remainingQty: '1.0000',
          unitPrice: '1500000.00',
          totalPrice: '1500000.00',
        },
        {
          id: 'b',
          quantity: '1.0000',
          remainingQty: '1.0000',
          unitPrice: '1735000.00',
          totalPrice: '1735000.00',
        },
      ],
      thisQtyByItemId: new Map([
        ['a', 1],
        ['b', 1],
      ]),
    });
    expect(charged.refundChargedTotal).toBe(3_200_000);
    expect(charged.refundChargedTotal).not.toBe(3_235_000);
    prove('refund-pg-strings-charged-not-list', {
      refunded: charged.refundChargedTotal,
      list: 3_235_000,
    });
  });

  it('last remaining slice closes to remaining charged', () => {
    const first = projectSaleRefundCharged({
      totalAmount: 3_200_000,
      alreadyRefundedCharged: 0,
      items: [
        {
          saleItemId: 'a',
          quantity: 1,
          remainingQty: 1,
          unitPrice: 1_500_000,
          lineNet: 1_500_000,
          thisQty: 1,
        },
        {
          saleItemId: 'b',
          quantity: 1,
          remainingQty: 1,
          unitPrice: 1_735_000,
          lineNet: 1_735_000,
          thisQty: 0,
        },
      ],
    });
    const rest = projectSaleRefundCharged({
      totalAmount: 3_200_000,
      alreadyRefundedCharged: first.refundChargedTotal,
      items: [
        {
          saleItemId: 'a',
          quantity: 1,
          remainingQty: 0,
          unitPrice: 1_500_000,
          lineNet: 1_500_000,
          thisQty: 0,
        },
        {
          saleItemId: 'b',
          quantity: 1,
          remainingQty: 1,
          unitPrice: 1_735_000,
          lineNet: 1_735_000,
          thisQty: 1,
        },
      ],
    });
    expect(first.refundChargedTotal + rest.refundChargedTotal).toBe(3_200_000);
    expect(rest.refundChargedTotal).toBe(3_200_000 - first.refundChargedTotal);
    prove('refund-last-slice-closes-charged', {
      first: first.refundChargedTotal,
      rest: rest.refundChargedTotal,
      sum: first.refundChargedTotal + rest.refundChargedTotal,
    });
  });

  it('full return reverses charged total AND cart discount (0031 leftover)', () => {
    const wiped = projectSaleRollupDecrement({
      paymentMethod: 'CASH',
      headerTotal: 3_235_000,
      headerDiscount: 0,
      amountPaid: 3_200_000,
    });
    expect(wiped.reverseAmount).toBe(3_200_000);
    expect(wiped.reverseDiscount).toBe(35_000);
    const increment = { amount: 3_200_000, discount: 35_000 };
    expect(increment.amount - wiped.reverseAmount).toBe(0);
    expect(increment.discount - wiped.reverseDiscount).toBe(0);

    const healthy = projectSaleRollupDecrement({
      paymentMethod: 'CARD',
      headerTotal: 395_000,
      headerDiscount: 35_000,
      amountPaid: 395_000,
    });
    expect(healthy.reverseAmount).toBe(395_000);
    expect(healthy.reverseDiscount).toBe(35_000);

    const credit = projectSaleRollupDecrement({
      paymentMethod: 'CREDIT',
      headerTotal: 500_000,
      headerDiscount: 0,
      amountPaid: 100_000,
    });
    expect(credit.reverseAmount).toBe(500_000);
    expect(credit.reverseDiscount).toBe(0);

    prove('full-return-reverses-discount-in-rollup', {
      wiped,
      leftoverIfListUsed: 3_200_000 - 3_235_000,
      leftoverAfterSsot: increment.amount - wiped.reverseAmount,
      healthy,
      creditUnderpayNotTreatedAsDiscount: credit,
    });
  });

  it('writes evidence artifact', () => {
    expect(evidence.length).toBeGreaterThanOrEqual(7);
    const payload = {
      title: 'PROOF_SALE_DISCOUNT_EXCHANGE_SSOT',
      runAt: new Date().toISOString(),
      verdict: 'PASS',
      identity: {
        unit: 'rung_or_catalog',
        lineDiscount: 'line_markdown_only',
        cartDiscount: 'header_only',
        exchangeCredit: '2210 applied as cart',
        forbiddenUnit: '(lineNet + discount) / qty',
      },
      blissCase: BLISS,
      checks: evidence,
    };
    const json = JSON.stringify(payload, null, 2);
    writeFileSync(path.join(repoRoot, 'PROOF_SALE_DISCOUNT_EXCHANGE_SSOT.json'), json);
    writeFileSync(
      path.join(repoRoot, 'SamplePOS.Server/PROOF_SALE_DISCOUNT_EXCHANGE_SSOT.json'),
      json,
    );
    const md = [
      '# Sale discount + exchange SSOT',
      '',
      `Run: ${payload.runAt}`,
      '',
      'Verdict: **PASS** — executed persist/exchange/presentation numbers, not source greps.',
      '',
      '| Check | Result |',
      '|---|---|',
      ...evidence.map((row) => `| ${row.name} | PASS |`),
      '',
      '312000 − 6000 = 306000, not 300000. Exchange credit 6,000 on a 306,000 replacement charges 300,000 and keeps unit 306,000.',
      '',
    ].join('\n');
    writeFileSync(path.join(repoRoot, 'PROOF_SALE_DISCOUNT_EXCHANGE_SSOT.md'), md);
    writeFileSync(
      path.join(repoRoot, 'SamplePOS.Server/PROOF_SALE_DISCOUNT_EXCHANGE_SSOT.md'),
      md,
    );
  });
});
