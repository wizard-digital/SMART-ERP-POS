/**
 * Sale → Banking register mirror policy (pure, no I/O).
 *
 * SSOT for WHICH sale tenders may be mirrored into `bank_transactions` and onto which GL.
 * The GL journal (recordSaleToGL) is always the source of truth; the bank row is only a
 * register view linked to that journal. Mirroring NEVER posts a second journal.
 *
 * Why CARD is opt-in (evidence, 2026-10-28, Henber/Blis/Bliss):
 *  - CARD sales post DR 1020 "Credit Card Receipts" correctly (GL ties to the sales table to the cent).
 *  - Card receipts are cleared by Treasury transfers (1020 -> 1010/1012), not by a sale-time bank row.
 *  - Only Cash (1010) and Mobile Money (1040) books are auto-created (ensureDepositLiquidityBook);
 *    no tenant has a book on 1020, so a CARD mirror is skipped. That is intentional, not data loss —
 *    and it must be OBSERVABLE (reason code), never a silent per-sale warning.
 *  - Bulk back-filling bank rows for historic CARD sales would double-represent receipts that Treasury
 *    transfers already settled. Do not do it.
 */

/** Tenders that never touch the bank register. */
export const SALE_NON_BANK_TENDERS: ReadonlySet<string> = new Set(['CASH', 'CREDIT', 'DEPOSIT']);

/** Payment method → liquidity GL the SALE journal must debit for a mirror to be valid. */
export const SALE_BANK_MIRROR_GL: Readonly<Record<string, string>> = Object.freeze({
  CARD: '1020',
  MOBILE_MONEY: '1040',
  AIRTEL_MONEY: '1040',
  BANK_TRANSFER: '1030',
});

/** Methods whose book is auto-created on demand (Deposit Worksheet / Mobile Money). CARD is NOT. */
export const SALE_BANK_BOOK_AUTO_ENSURED: ReadonlySet<string> = new Set(['MOBILE_MONEY', 'AIRTEL_MONEY']);

export type SaleBankMirrorSkipReason =
  | 'NOT_A_BANK_TENDER'
  | 'NO_LIQUIDITY_GL_MAPPING'
  | 'NO_ACTIVE_BANK_BOOK_ON_GL'
  | 'SALE_GL_DOES_NOT_DEBIT_LIQUIDITY'
  | 'ALREADY_MIRRORED';

/**
 * One bank row per (sale, payment method): the register's idempotency key is `Sale <no> [<METHOD>]`
 * (unique index uq_bank_txn_sale_source_desc_live). A split sale with two lines of the SAME method
 * (e.g. MOBILE_MONEY 5,000 + MOBILE_MONEY 3,000) must therefore be mirrored as ONE row of 8,000.
 * Mirroring the lines one by one would silently drop the second line as a "duplicate".
 * Amounts are summed in integer minor units (cents) so float drift cannot create a mismatch.
 */
export function aggregatePaymentsByMethod<T extends { amount: number; paymentMethod: string }>(
  payments: readonly T[],
): Array<{ amount: number; paymentMethod: string }> {
  const order: string[] = [];
  const cents = new Map<string, number>();
  for (const p of payments) {
    if (!cents.has(p.paymentMethod)) {
      order.push(p.paymentMethod);
      cents.set(p.paymentMethod, 0);
    }
    cents.set(p.paymentMethod, cents.get(p.paymentMethod)! + Math.round(p.amount * 100));
  }
  return order.map((paymentMethod) => ({ paymentMethod, amount: cents.get(paymentMethod)! / 100 }));
}

export function isNonBankTender(paymentMethod: string): boolean {
  return SALE_NON_BANK_TENDERS.has(paymentMethod);
}

export function saleBankMirrorGlCode(paymentMethod: string): string | null {
  return SALE_BANK_MIRROR_GL[paymentMethod] ?? null;
}

export function shouldAutoEnsureBook(paymentMethod: string): boolean {
  return SALE_BANK_BOOK_AUTO_ENSURED.has(paymentMethod);
}

/** Human-readable explanation attached to the structured skip log. */
export function describeSaleBankMirrorSkip(reason: SaleBankMirrorSkipReason, paymentMethod: string, glCode?: string | null): string {
  switch (reason) {
    case 'NOT_A_BANK_TENDER':
      return `${paymentMethod} is not a bank tender`;
    case 'NO_LIQUIDITY_GL_MAPPING':
      return `no liquidity GL is mapped for ${paymentMethod}`;
    case 'NO_ACTIVE_BANK_BOOK_ON_GL':
      return paymentMethod === 'CARD'
        ? `no active bank book on GL ${glCode}; card receipts stay on the GL and settle via Treasury transfer (opt-in: create a book on ${glCode} to mirror)`
        : `no active bank book on GL ${glCode}`;
    case 'SALE_GL_DOES_NOT_DEBIT_LIQUIDITY':
      return `the SALE journal does not debit GL ${glCode}; never invent a second journal`;
    case 'ALREADY_MIRRORED':
      return 'bank transaction already exists for this sale payment';
  }
}
