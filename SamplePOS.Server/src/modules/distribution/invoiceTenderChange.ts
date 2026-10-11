/**
 * POS-style tender against an open invoice (AR SSOT).
 * Cash overage → change; never post more than amount due.
 */
import { Money } from '../../utils/money.js';

export function computeInvoiceTender(input: {
  invoiceDue: number;
  depositRequested: number;
  cashTendered: number;
  paymentMethod?: string;
}): {
  depositApplied: number;
  cashApplied: number;
  totalApplied: number;
  changeGiven: number;
  remainingDue: number;
} {
  const due = Money.max(Money.zero(), Money.parse(input.invoiceDue));
  const depositRequested = Money.max(Money.zero(), Money.parse(input.depositRequested));
  const cashTendered = Money.max(Money.zero(), Money.parse(input.cashTendered));

  const depositApplied = Money.min(depositRequested, due);
  const remainingAfterDeposit = Money.max(Money.zero(), Money.subtract(due, depositApplied));
  const cashApplied = Money.min(cashTendered, remainingAfterDeposit);
  const totalApplied = Money.add(depositApplied, cashApplied);
  const remainingDue = Money.max(Money.zero(), Money.subtract(due, totalApplied));

  const isCash = String(input.paymentMethod || '').toUpperCase() === 'CASH';
  const changeGiven = isCash
    ? Money.max(Money.zero(), Money.subtract(cashTendered, cashApplied))
    : Money.zero();

  return {
    depositApplied: Money.toNumber(depositApplied),
    cashApplied: Money.toNumber(cashApplied),
    totalApplied: Money.toNumber(totalApplied),
    changeGiven: Money.toNumber(changeGiven),
    remainingDue: Money.toNumber(remainingDue),
  };
}
