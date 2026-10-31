import { describe, expect, it } from '@jest/globals';
import {
  assertGiftSale,
  billedRevenueSql,
  billedSalesSql,
  GIFT_ADMIN_LOCK_PERMISSION,
  GIFT_PAYMENT_METHOD,
  GIFT_PERMISSION,
  isGiftSale,
  projectBilledSalesTotals,
  resolveGiftSettlement,
  salesDailySummaryRebuildSelectSql,
  shouldSkipSaleRevenueJournal,
} from '../../../../shared/domain/saleGiftFocSsot.js';
import { POSSaleSchema } from '../../../../shared/zod/pos-sale.js';
import { canIssueGiftSale } from '../../../../shared/authorization/salesPolicy.js';
import { isSystemManagerPermission } from '../../../../shared/authorization/systemRoleGrants.js';
import { legacyRoleGrantsPermission } from '../../../../shared/authorization/legacyRoleFallback.js';

const line = {
  productId: 'custom_gift_1',
  productName: 'Staff gift item',
  sku: '',
  uom: 'EA',
  quantity: 1,
  unitPrice: 10000,
  costPrice: 4000,
  subtotal: 10000,
};

describe('SAP FD / FOC gift sale SSOT', () => {
  it('does not rewrite GIFT to CREDIT when the gift covers the sale', () => {
    const settlement = resolveGiftSettlement({
      isGift: true,
      paymentMethod: GIFT_PAYMENT_METHOD,
      hasOutstandingBalance: true,
    });
    expect(settlement).toEqual({
      effectivePaymentMethod: 'GIFT',
      hasOutstandingBalance: false,
    });
  });

  it('still rewrites unpaid cash sales to CREDIT', () => {
    expect(
      resolveGiftSettlement({
        isGift: false,
        paymentMethod: 'CASH',
        hasOutstandingBalance: true,
      }),
    ).toEqual({ effectivePaymentMethod: 'CREDIT', hasOutstandingBalance: true });
  });

  it('rejects credit mix, missing reason, and uncovered remainder', () => {
    expect(
      assertGiftSale({
        giftReason: 'Staff gift — Jane',
        paymentLines: [
          { paymentMethod: 'GIFT', amount: 5000 },
          { paymentMethod: 'CREDIT', amount: 5000 },
        ],
        totalAmount: 10000,
      }).code,
    ).toBe('ERR_GIFT_MIXED');
    expect(
      assertGiftSale({
        giftReason: '',
        paymentLines: [{ paymentMethod: 'GIFT', amount: 10000 }],
        totalAmount: 10000,
      }).code,
    ).toBe('ERR_GIFT_REASON');
    expect(
      assertGiftSale({
        giftReason: 'Sample for customer visit',
        paymentLines: [{ paymentMethod: 'GIFT', amount: 1000 }],
        totalAmount: 10000,
      }).code,
    ).toBe('ERR_GIFT_AMOUNT');
  });

  it('allows cash 2000 + gift remainder (SAP partial FOC)', () => {
    const ok = assertGiftSale({
      giftReason: 'Customer paid 2000; remainder complimentary',
      paymentMethod: 'CASH',
      paymentLines: [
        { paymentMethod: 'CASH', amount: 2000 },
        { paymentMethod: 'GIFT', amount: 8000 },
      ],
      totalAmount: 10000,
    });
    expect(ok.ok).toBe(true);
    expect(
      shouldSkipSaleRevenueJournal({
        paymentMethod: 'CASH',
        paymentLines: [
          { paymentMethod: 'CASH', amount: 2000 },
          { paymentMethod: 'GIFT', amount: 8000 },
        ],
      }),
    ).toBe(false);
    expect(
      resolveGiftSettlement({
        isGift: true,
        paymentMethod: 'CASH',
        hasOutstandingBalance: true,
        paymentLines: [
          { paymentMethod: 'CASH', amount: 2000 },
          { paymentMethod: 'GIFT', amount: 8000 },
        ],
      }),
    ).toEqual({ effectivePaymentMethod: 'CASH', hasOutstandingBalance: false });
  });

  it('accepts exclusive GIFT covering the charged total with a reason', () => {
    const ok = assertGiftSale({
      giftReason: 'Complimentary issue to staff member Jane',
      paymentMethod: 'GIFT',
      paymentLines: [{ paymentMethod: 'GIFT', amount: 10000 }],
      totalAmount: 10000,
    });
    expect(ok.ok).toBe(true);
    expect(shouldSkipSaleRevenueJournal({ paymentMethod: 'GIFT' })).toBe(true);
    expect(shouldSkipSaleRevenueJournal({ paymentMethod: 'CASH' })).toBe(false);
    expect(GIFT_PERMISSION).toBe('sales.gift');
  });

  it('POSSaleSchema accepts gift payload, pay+gift remainder, and rejects no reason', () => {
    const base = {
      lineItems: [line],
      subtotal: 10000,
      taxAmount: 0,
      totalAmount: 10000,
    };
    const ok = POSSaleSchema.safeParse({
      ...base,
      giftReason: 'Staff gift — Jane',
      paymentLines: [{ paymentMethod: 'GIFT', amount: 10000 }],
    });
    expect(ok.success).toBe(true);

    const noReason = POSSaleSchema.safeParse({
      ...base,
      paymentLines: [{ paymentMethod: 'GIFT', amount: 10000 }],
    });
    expect(noReason.success).toBe(false);

    const mixed = POSSaleSchema.safeParse({
      ...base,
      giftReason: 'Staff gift — Jane',
      paymentLines: [
        { paymentMethod: 'GIFT', amount: 4000 },
        { paymentMethod: 'CASH', amount: 6000 },
      ],
    });
    expect(mixed.success).toBe(true);
    expect(isGiftSale({ paymentLines: [{ paymentMethod: 'GIFT' }] })).toBe(true);
  });

  it('only Administrator may issue a gift — not Manager or Cashier', () => {
    expect(canIssueGiftSale(['sales.gift', 'admin.update'])).toBe(true);
    expect(canIssueGiftSale(['sales.gift'], 'ADMIN')).toBe(true);
    expect(canIssueGiftSale(['sales.gift'])).toBe(false);
    expect(canIssueGiftSale(['sales.gift', 'sales.approve', 'sales.create'])).toBe(false);
    expect(canIssueGiftSale([], 'MANAGER')).toBe(false);
    expect(legacyRoleGrantsPermission('MANAGER', GIFT_PERMISSION)).toBe(false);
    expect(legacyRoleGrantsPermission('ADMIN', GIFT_PERMISSION)).toBe(true);
    expect(isSystemManagerPermission({ key: GIFT_PERMISSION, module: 'sales' })).toBe(false);
    expect(GIFT_ADMIN_LOCK_PERMISSION).toBe('admin.update');
  });

  it('reports treat gift as not billed revenue while keeping gift COGS', () => {
    const totals = projectBilledSalesTotals([
      { paymentMethod: 'CASH', transactionCount: 2, totalAmount: 100000, totalCost: 40000 },
      { paymentMethod: 'GIFT', transactionCount: 1, totalAmount: 25000, totalCost: 8000 },
    ]);
    expect(totals.billedAmount).toBe(100000);
    expect(totals.billedCount).toBe(2);
    expect(totals.giftAmount).toBe(25000);
    expect(totals.giftCost).toBe(8000);
    expect(totals.totalCost).toBe(48000);
    expect(totals.billedProfit).toBe(52000);
    expect(billedSalesSql('s')).toBe("s.payment_method::text <> 'GIFT'");
    expect(billedRevenueSql('s')).toBe('(s.total_amount - COALESCE(s.gift_amount, 0))');
  });

  it('dashboard rebuild SQL splits billed vs FOC remainder onto GIFT so KPIs match reports', () => {
    const sql = salesDailySummaryRebuildSelectSql();
    expect(sql).toContain('billed_amount');
    expect(sql).toContain("payment_method <> 'GIFT'");
    expect(sql).toContain("'GIFT' AS payment_method");
    expect(sql).toContain('UNION ALL');
    expect(sql).toContain('ELSE gift_amount END');
  });
});
