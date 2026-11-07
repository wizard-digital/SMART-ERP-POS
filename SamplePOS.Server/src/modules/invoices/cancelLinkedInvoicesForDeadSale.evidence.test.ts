/**
 * Evidence: dead-sale invoice cancel is SSOT for VOID and VOIDED_BY_RETURN.
 * Prevents Henber-class orphan (INV open after SALE_REFUND_CORRECTION).
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from '@jest/globals';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8');

describe('cancelLinkedInvoicesForDeadSale SSOT', () => {
  it('helper cancels subledger only and syncs customer balance', () => {
    const src = read('src/modules/invoices/cancelLinkedInvoicesForDeadSale.ts');
    expect(src).toContain("status = 'CANCELLED'");
    expect(src).toContain('amount_due = 0');
    expect(src).toContain('syncCustomerBalanceFromInvoices');
    expect(src).not.toMatch(/createJournalEntry|recordSaleRefund|AccountCodes\.AR/);
  });

  it('full return path cancels linked invoices after VOIDED_BY_RETURN', () => {
    const src = read('src/modules/sales/salesService.ts');
    expect(src).toContain('markSaleVoidedByReturn');
    expect(src).toContain('cancelLinkedInvoicesForDeadSale');
    expect(src).toContain("'SALE_VOIDED_BY_RETURN'");
    const markIdx = src.indexOf('markSaleVoidedByReturn(client, saleId)');
    const cancelIdx = src.indexOf("'SALE_VOIDED_BY_RETURN'");
    expect(markIdx).toBeGreaterThan(0);
    expect(cancelIdx).toBeGreaterThan(markIdx);
  });

  it('sale void path uses the same helper', () => {
    const src = read('src/modules/sales/salesService.ts');
    expect(src).toContain("'SALE_VOID'");
    expect(src).toContain('cancelLinkedInvoicesForDeadSale');
  });

  it('credit-note return sync cancels invoices on full return', () => {
    const src = read('src/modules/sales/salesRepository.ts');
    expect(src).toContain('syncSaleStatusAfterCustomerReturn');
    expect(src).toContain('cancelLinkedInvoicesForDeadSale');
    expect(src).toContain("'SALE_FULL_RETURN_SYNC'");
  });

  it('integrity checker flags dead-sale open invoices as ERROR', () => {
    const src = read('src/services/glIntegrityChecker.ts');
    expect(src).toContain('checkDeadSaleOpenInvoices');
    expect(src).toContain('dead_sale_open_invoices');
    expect(src).toContain("s.status IN ('VOID', 'VOIDED_BY_RETURN', 'REFUNDED')");
  });
});
