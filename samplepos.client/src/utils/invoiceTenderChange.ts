/**
 * POS-style tender against an open invoice (AR SSOT).
 * Post only what is due; cash overage is change, not overpayment.
 */

export type InvoiceTenderInput = {
  invoiceDue: number;
  depositRequested: number;
  cashTendered: number;
  /** Change is only returned for cash (same as POS). */
  paymentMethod: string;
};

export type InvoiceTenderResult = {
  depositApplied: number;
  cashApplied: number;
  totalApplied: number;
  changeGiven: number;
  remainingDue: number;
};

export function computeInvoiceTender(input: InvoiceTenderInput): InvoiceTenderResult {
  const due = Math.max(0, Number(input.invoiceDue) || 0);
  const depositRequested = Math.max(0, Number(input.depositRequested) || 0);
  const cashTendered = Math.max(0, Number(input.cashTendered) || 0);

  const depositApplied = Math.min(depositRequested, due);
  const remainingAfterDeposit = Math.max(0, due - depositApplied);
  const cashApplied = Math.min(cashTendered, remainingAfterDeposit);
  const totalApplied = depositApplied + cashApplied;
  const remainingDue = Math.max(0, due - totalApplied);

  const isCash = String(input.paymentMethod || '').toUpperCase() === 'CASH';
  const changeGiven = isCash ? Math.max(0, cashTendered - cashApplied) : 0;

  return {
    depositApplied,
    cashApplied,
    totalApplied,
    changeGiven,
    remainingDue,
  };
}
