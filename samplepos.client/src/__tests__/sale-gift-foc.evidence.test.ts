/**
 * PROOF — Gift / FOC sale on the existing POS path (SAP FD analog).
 * Executed: plan functions, POSSaleSchema, UI wiring, migration 643.
 *
 * Run: npx vitest run src/__tests__/sale-gift-foc.evidence.test.ts
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertGiftSale,
  GIFT_PERMISSION,
  resolveGiftSettlement,
  shouldSkipSaleRevenueJournal,
} from '@shared/domain/saleGiftFocSsot';
import { POSSaleSchema } from '@shared/zod/pos-sale';
import { SYSTEM_CASHIER_PERMISSION_KEYS } from '@shared/authorization/systemRoleGrants';
import { canIssueGiftSale } from '@shared/authorization/salesPolicy';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');

function readRepo(rel: string): string {
  return readFileSync(join(repoRoot, rel), 'utf8');
}

describe('EVIDENCE — sale gift FOC on existing POS', () => {
  it('plan: gift never becomes CREDIT and skips revenue journal', () => {
    expect(
      resolveGiftSettlement({
        isGift: true,
        paymentMethod: 'GIFT',
        hasOutstandingBalance: true,
      }).effectivePaymentMethod,
    ).toBe('GIFT');
    expect(
      resolveGiftSettlement({
        isGift: true,
        paymentMethod: 'GIFT',
        hasOutstandingBalance: true,
      }).hasOutstandingBalance,
    ).toBe(false);
    expect(shouldSkipSaleRevenueJournal({ paymentMethod: 'GIFT' })).toBe(true);
    expect(
      assertGiftSale({
        giftReason: 'Staff gift Jane',
        paymentLines: [{ paymentMethod: 'GIFT', amount: 50 }],
        totalAmount: 50,
      }).ok,
    ).toBe(true);
  });

  it('POSSaleSchema round-trips a gift sale and rejects mixed tender', () => {
    const line = {
      productId: 'custom_1',
      productName: 'Gift item',
      sku: '',
      uom: 'EA',
      quantity: 1,
      unitPrice: 50,
      costPrice: 20,
      subtotal: 50,
    };
    const ok = POSSaleSchema.safeParse({
      lineItems: [line],
      subtotal: 50,
      taxAmount: 0,
      totalAmount: 50,
      giftReason: 'Complimentary staff issue',
      paymentLines: [{ paymentMethod: 'GIFT', amount: 50 }],
    });
    expect(ok.success).toBe(true);
    const mixed = POSSaleSchema.safeParse({
      lineItems: [line],
      subtotal: 50,
      taxAmount: 0,
      totalAmount: 50,
      giftReason: 'Complimentary staff issue',
      paymentLines: [
        { paymentMethod: 'GIFT', amount: 20 },
        { paymentMethod: 'CASH', amount: 30 },
      ],
    });
    expect(mixed.success).toBe(true);
  });

  it('POS and order pay reuse the existing payment panel; cashiers cannot gift', () => {
    const pos = readRepo('samplepos.client/src/pages/pos/POSPage.tsx');
    const orderPay = readRepo('samplepos.client/src/pages/orders/OrderPaymentPage.tsx');
    expect(pos).toContain("setPaymentMethod('GIFT')");
    expect(pos).toContain('Gift (no charge)');
    expect(pos).toContain('giftReason');
    expect(pos).toContain('GIFT_PERMISSION');
    expect(pos).toContain('Remaining as discount');
    expect(pos).toContain('Remaining as gift');
    expect(orderPay).toContain('Remaining as discount');
    expect(orderPay).toContain('Remaining as gift');
    expect(orderPay).toContain("value: 'GIFT'");
    expect(orderPay).toContain('giftReason');
    expect(SYSTEM_CASHIER_PERMISSION_KEYS).not.toContain(GIFT_PERMISSION);
    expect(pos).toContain('admin.update');
    expect(orderPay).toContain('admin.update');
    expect(canIssueGiftSale(['sales.gift', 'admin.update'])).toBe(true);
    expect(canIssueGiftSale(['sales.gift'])).toBe(false);
    expect(canIssueGiftSale(['sales.create', 'pos.create'])).toBe(false);
    expect(canIssueGiftSale(['sales.gift', 'sales.approve'], 'MANAGER')).toBe(false);
  });

  it('server posts gift on the sale path: skip revenue, keep COGS, persist reason', () => {
    const service = readRepo('SamplePOS.Server/src/modules/sales/salesService.ts');
    const gl = readRepo('SamplePOS.Server/src/services/glEntryService.ts');
    const repo = readRepo('SamplePOS.Server/src/modules/sales/salesRepository.ts');
    const sql = readRepo('shared/sql/643_sale_gift_foc.sql');
    expect(service).toContain('resolveGiftSettlement');
    expect(service).toContain("GIFT_PERMISSION");
    expect(service).toContain('GIFT_ADMIN_LOCK_PERMISSION');
    expect(service).toContain('pureGiftSale ? 0');
    expect(service).toContain("line.paymentMethod !== 'GIFT'");
    expect(sql).toContain("'administrator'");
    expect(sql).not.toContain("'Manager'");
    expect(gl).toContain('skipRevenueJournal');
    expect(gl).toContain('shouldSkipSaleRevenueJournal');
    expect(repo).toContain('gift_reason');
    expect(repo).toContain('billedSalesSql');
    expect(sql).toContain("ADD VALUE 'GIFT'");
    expect(sql).toContain('sales.gift');
    expect(sql).toContain('INSERT INTO schema_version (version) VALUES (643)');
    const reports = readRepo('SamplePOS.Server/src/modules/reports/reportsRepository.ts');
    expect(reports).toContain('billedSalesSql');
    expect(reports).toContain('isGiftPaymentMethod');
  });
});
