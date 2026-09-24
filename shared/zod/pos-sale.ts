import { z } from 'zod';
import { DocumentTaxOverrideSchema } from './taxOverride.js';

// POS Sale Line Item Schema
export const POSSaleLineItemSchema = z.object({
  productId: z.string().min(1), // Accept UUID or custom IDs (e.g., custom_* for quotation items)
  productName: z.string().min(1),
  sku: z.string().optional().default(''), // Allow empty/missing for custom/service items
  uom: z.string().min(1),
  uomId: z.string().uuid().optional(), // UUID of product_uom used
  quantity: z.number().positive().finite(),
  unitPrice: z.number().nonnegative().finite(),
  costPrice: z.number().nonnegative().finite(),
  subtotal: z.number().nonnegative().finite(),
  discountAmount: z.number().nonnegative().finite().optional(), // Per-item discount amount
  taxAmount: z.number().nonnegative().finite().optional(),
  notes: z.string().max(500).optional().or(z.null()).transform(val => val ?? undefined), // Line item notes (converts null to undefined)
  // Cart/offline stamp — service lines skip stock; restaurant-enabled tenants always send this.
  productType: z.enum(['inventory', 'consumable', 'service']).optional(),
  /** Custom/service line tax bridge when no products row (DocumentTaxService). */
  isTaxable: z.boolean().optional(),
  taxRate: z.number().nonnegative().finite().optional(),
}).strict();

// Payment Line Schema (for split payments)
// MTN MoMo = MOBILE_MONEY; Airtel Money = AIRTEL_MONEY (must match POS UI + salesRoutes).
export const PaymentLineSchema = z.object({
  paymentMethod: z.enum(['CASH', 'CARD', 'MOBILE_MONEY', 'AIRTEL_MONEY', 'CREDIT', 'DEPOSIT']),
  amount: z.number().nonnegative().finite(), // Allow 0 for full CREDIT sales
  reference: z.string().optional(),
}).strict();

// POS Sale Schema
export const POSSaleSchema = z.object({
  customerId: z.string().uuid().optional(),
  customerEmail: z.string().email().optional().or(z.literal('')).or(z.null()).transform(val => val === '' || val === null ? undefined : val), // Customer email (optional, handles empty/null)
  quoteId: z.string().uuid().optional(), // Link to quotation if sale originates from quote
  cashRegisterSessionId: z.string().uuid().optional(), // Link to cash register session for drawer tracking
  lineItems: z.array(POSSaleLineItemSchema).min(1, 'At least one item is required'),
  subtotal: z.number().nonnegative().finite(),
  discountAmount: z.number().nonnegative().finite().optional(), // Cart-level discount
  taxAmount: z.number().nonnegative().finite(),
  totalAmount: z.number().nonnegative().finite(),
  paymentMethod: z.enum(['CASH', 'CARD', 'MOBILE_MONEY', 'AIRTEL_MONEY', 'CREDIT']).optional(), // Legacy single payment
  paymentLines: z.array(PaymentLineSchema).optional(), // New split payment support
  amountTendered: z.number().nonnegative().finite().optional(),
  changeGiven: z.number().nonnegative().finite().optional(),
  saleDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Sale date must be YYYY-MM-DD').optional(), // YYYY-MM-DD for backdated sales (DATE column — no time/timezone)
  notes: z.string().max(500).optional(),
  requiresApproval: z.boolean().optional(), // Flag for discount approvals or special pricing
  idempotencyKey: z.string().min(1).max(100).optional(), // Prevents duplicate sale creation
  /** Exchange refund document (REF-* with refund_type EXCHANGE) whose store credit is applied */
  exchangeRefundId: z.string().uuid().optional(),
  /**
   * Residual after applying exchange credit to this sale:
   * REFUND_ORIGINAL_TENDER pays change difference; KEEP_VOUCHER leaves numbered credit open.
   */
  exchangeResidualAction: z.enum(['REFUND_ORIGINAL_TENDER', 'KEEP_VOUCHER']).optional(),
  /** Phase 5 — privileged VAT override (server enforces sales.tax_override + reason). */
  taxOverride: DocumentTaxOverrideSchema.optional(),
}).strict().superRefine((data, ctx) => {
  // Must have either paymentMethod OR paymentLines
  if (!data.paymentMethod && (!data.paymentLines || data.paymentLines.length === 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['paymentMethod'],
      message: 'Must provide either paymentMethod or paymentLines',
    });
  }

  // If paymentLines provided, sum must equal totalAmount (or exceed for CASH to give change)
  if (data.paymentLines && data.paymentLines.length > 0) {
    const sum = data.paymentLines.reduce((acc, line) => acc + line.amount, 0);
    const hasCash = data.paymentLines.some(line => line.paymentMethod === 'CASH');
    const hasCredit = data.paymentLines.some(line => line.paymentMethod === 'CREDIT');

    // Allow underpayment ONLY if there's a CREDIT payment (for invoices/credit sales)
    // Otherwise, require full payment or overpayment with cash
    if (sum < data.totalAmount - 0.01 && !hasCredit) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['paymentLines'],
        message: `Sum of payment lines (${sum.toFixed(2)}) is less than total amount (${data.totalAmount.toFixed(2)}). Add CREDIT payment for partial payment.`,
      });
    }

    // If overpaid, must have cash payment
    if (sum > data.totalAmount + 0.01 && !hasCash) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['paymentLines'],
        message: `Overpayment (${sum.toFixed(2)}) without CASH payment. Only CASH can be overpaid to give change.`,
      });
    }

    // DEPOSIT payment requires a customer (deposits are tied to customer accounts)
    const hasDeposit = data.paymentLines.some(line => line.paymentMethod === 'DEPOSIT');
    if (hasDeposit && !data.customerId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['paymentLines'],
        message: 'DEPOSIT payment requires a customer. Cannot apply deposit without a customer account.',
      });
    }
  }

  // CRITICAL: CASH sales MUST have amountTendered (legacy single payment)
  if (data.paymentMethod === 'CASH' && !data.paymentLines) {
    if (data.amountTendered === undefined || data.amountTendered <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['amountTendered'],
        message: 'CASH sales require amount tendered. Cannot record cash sale without cash received.',
      });
    }
    if (data.amountTendered !== undefined && data.amountTendered < data.totalAmount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['amountTendered'],
        message: `Insufficient cash. Tendered: ${data.amountTendered}, Required: ${data.totalAmount}`,
      });
    }
  }

  // Validate subtotal matches sum of line items
  const calculatedSubtotal = data.lineItems.reduce((sum, item) => sum + item.subtotal, 0);
  if (Math.abs(calculatedSubtotal - data.subtotal) > 0.01) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['subtotal'],
      message: 'Subtotal does not match sum of line items',
    });
  }

  // Price-mode charge integrity:
  //   exclusive → total = subtotal - discount + tax
  //   inclusive → total = subtotal - discount  (tax extracted for display/GL, not added)
  const discountAmount = data.discountAmount || 0;
  const afterDiscount = data.subtotal - discountAmount;
  const exclusiveTotal = afterDiscount + data.taxAmount;
  const inclusiveTotal = afterDiscount;
  const matchesExclusive = Math.abs(exclusiveTotal - data.totalAmount) <= 0.01;
  const matchesInclusive = Math.abs(inclusiveTotal - data.totalAmount) <= 0.01;
  if (!matchesExclusive && !matchesInclusive) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['totalAmount'],
      message:
        `Total amount does not match priced charge. ` +
        `Exclusive expected ${exclusiveTotal.toFixed(2)} (sub−disc+tax); ` +
        `inclusive expected ${inclusiveTotal.toFixed(2)} (sub−disc, tax ${data.taxAmount.toFixed(2)} included). ` +
        `Got ${data.totalAmount.toFixed(2)}.`,
    });
  }

  // Validate change given for cash payments (legacy)
  if (data.paymentMethod === 'CASH' && data.amountTendered && !data.paymentLines) {
    const calculatedChange = data.amountTendered - data.totalAmount;
    if (data.changeGiven !== undefined && Math.abs(calculatedChange - data.changeGiven) > 0.01) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['changeGiven'],
        message: 'Change given does not match amount tendered - total',
      });
    }
  }
});

export type POSSaleLineItem = z.infer<typeof POSSaleLineItemSchema>;
export type PaymentLine = z.infer<typeof PaymentLineSchema>;
export type POSSale = z.infer<typeof POSSaleSchema>;
