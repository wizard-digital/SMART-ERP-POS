// Split Payment Schema - Zod validation for split payments

import { z } from 'zod';

export const PaymentMethodEnum = z.enum([
  'CASH',
  'CARD',
  'MOBILE_MONEY',
  'AIRTEL_MONEY',
  'CUSTOMER_CREDIT',
  'CREDIT',
  'BANK_TRANSFER',
  'CHEQUE'
]);
export type PaymentMethod = z.infer<typeof PaymentMethodEnum>;

export const PaymentSegmentSchema = z.object({
  method: PaymentMethodEnum,
  amount: z.number().min(0.01, 'Payment amount must be positive'),
  reference: z.string().optional().nullable(), // Card/mobile money/cheque reference
  notes: z.string().optional().nullable(),
}).strict();

export const SplitPaymentSchema = z.object({
  payments: z.array(PaymentSegmentSchema).min(1, 'At least one payment required'),
  totalAmount: z.number().min(0.01),
  customerId: z.string().uuid().optional().nullable(), // Required if using CREDIT
}).strict().refine(
  (data) => {
    // Validate total payments equal total amount (or allow credit for remaining)
    const totalPaid = data.payments.reduce((sum, p) => sum + p.amount, 0);
    const hasCreditPayment = data.payments.some(p => p.method === 'CUSTOMER_CREDIT');

    // If using credit, can pay less than total
    if (hasCreditPayment) {
      return totalPaid <= data.totalAmount;
    }

    // Otherwise must pay exact amount or more (change calculated)
    return Math.abs(totalPaid - data.totalAmount) < 0.01; // Allow 1 cent rounding
  },
  {
    message: 'Total payments must equal total amount (unless using credit)',
    path: ['payments'],
  }
).refine(
  (data) => {
    // If using CUSTOMER_CREDIT payment, customer must be specified
    const hasCreditPayment = data.payments.some(p => p.method === 'CUSTOMER_CREDIT');
    return !hasCreditPayment || data.customerId;
  },
  {
    message: 'Customer required for credit payments',
    path: ['customerId'],
  }
);

export const PaymentRecordSchema = z.object({
  id: z.string().uuid(),
  saleId: z.string().uuid(),
  paymentMethod: PaymentMethodEnum,
  amount: z.number().min(0),
  reference: z.string().nullable(),
  notes: z.string().nullable(),
  createdAt: z.string().datetime(),
}).strict();

export type PaymentSegment = z.infer<typeof PaymentSegmentSchema>;
export type SplitPayment = z.infer<typeof SplitPaymentSchema>;
export type PaymentRecord = z.infer<typeof PaymentRecordSchema>;

/**
 * Calculate change amount from split payments
 * @param payments - Array of payment segments
 * @param totalDue - Total amount due
 * @returns Change amount (0 if no cash overpayment)
 */
export function calculateChange(
  payments: PaymentSegment[],
  totalDue: number
): number {
  const cashPayments = payments.filter(p => p.method === 'CASH');
  const totalCash = cashPayments.reduce((sum, p) => sum + p.amount, 0);
  const totalOtherPayments = payments
    .filter(p => p.method !== 'CASH')
    .reduce((sum, p) => sum + p.amount, 0);

  const remainingAfterOther = totalDue - totalOtherPayments;

  if (totalCash > remainingAfterOther) {
    return totalCash - remainingAfterOther;
  }

  return 0;
}

/**
 * Validate payment distribution
 * @param payments - Array of payment segments
 * @param totalDue - Total amount due
 * @returns Validation result with errors
 */
export function validatePaymentDistribution(
  payments: PaymentSegment[],
  totalDue: number
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (payments.length === 0) {
    errors.push('At least one payment method required');
    return { valid: false, errors };
  }

  const totalPaid = payments.reduce((sum, p) => sum + p.amount, 0);
  const hasCreditPayment = payments.some(p => p.method === 'CUSTOMER_CREDIT');

  // Check individual payment amounts
  for (const payment of payments) {
    if (payment.amount <= 0) {
      errors.push(`${payment.method} amount must be positive`);
    }
  }

  // Check total payment
  if (!hasCreditPayment) {
    if (totalPaid < totalDue - 0.01) {
      errors.push(`Insufficient payment: ${totalPaid.toFixed(2)} < ${totalDue.toFixed(2)}`);
    }
  }

  // Check for duplicate payment methods (except CASH can appear multiple times)
  const methodCounts = payments.reduce((acc, p) => {
    acc[p.method] = (acc[p.method] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  for (const [method, count] of Object.entries(methodCounts)) {
    if (method !== 'CASH' && count > 1) {
      errors.push(`Duplicate payment method: ${method}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
