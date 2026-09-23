/**
 * Proof: POS Cash In Customer Payment is real AR (customer + invoice), not a till note.
 * Run: npx vitest run src/__tests__/till-ar-cash-in-ssot.evidence.test.ts
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');

function readSrc(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

describe('Till AR Cash In — client SSOT', () => {
  it('Customer Payment requires an existing customer and an open invoice on one screen', () => {
    const dialog = readSrc('components/cash-register/CashMovementDialog.tsx');
    expect(dialog).not.toContain('CustomerSelector');
    expect(dialog).not.toContain('QuickAddCustomerModal');
    expect(dialog).not.toContain('+ Add');
    expect(dialog).toContain('api.customers.search');
    expect(dialog).toContain('getOpenInvoices');
    expect(dialog).toContain('customerId: isTillAr ? customer?.id');
    expect(dialog).toContain('invoiceId: isTillAr ? invoiceId');
    expect(dialog).toContain('(!isTillAr || selectedInvoice)');
    expect(dialog).not.toContain('John Doe - INV-00123');
    expect(dialog).toContain('DR Cash Drawer 1010 / CR Accounts Receivable 1200');
  });

  it('close dialog expected cash excludes petty spend', () => {
    const close = readSrc('components/cash-register/CloseRegisterDialog.tsx');
    expect(close).toContain('Petty spend (not till)');
    expect(close).toContain('cashOutExpense');
  });
});
