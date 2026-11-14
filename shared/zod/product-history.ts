// Shared Zod Schemas - Product History Timeline
// Used by both frontend and backend

import { z } from 'zod';

export const ProductHistoryTypeEnum = z.enum([
  'GOODS_RECEIPT',
  'SALE',
  'ADJUSTMENT_IN',
  'ADJUSTMENT_OUT',
  'TRANSFER_IN',
  'TRANSFER_OUT',
  'RETURN',
  'DAMAGE',
  'EXPIRY'
]);

export const ProductHistoryReferenceSchema = z.object({
  // Optional references depending on type
  grId: z.string().uuid().optional(),
  grNumber: z.string().optional(),
  grStatus: z.string().optional(),
  receivedDate: z.string().datetime().optional(),
  supplierDeliveryNote: z.string().optional(),
  poId: z.string().uuid().optional(),
  poNumber: z.string().optional(),
  supplierId: z.string().uuid().optional(),
  supplierName: z.string().optional(),
  receivedByName: z.string().optional(),
  // Purchase-order line context (for this product)
  orderedQuantity: z.number().optional(),
  poUnitPrice: z.number().optional(),
  qtyVariance: z.number().optional(),
  costVariance: z.number().optional(),

  saleId: z.string().uuid().optional(),
  saleNumber: z.string().optional(),
  /** Distinguishes multiple sale_items on the same SALE (same second). */
  saleItemId: z.string().uuid().optional(),
  saleStatus: z.string().optional(),

  customerId: z.string().uuid().optional(),
  customerName: z.string().optional(),
  soldByName: z.string().optional(),
  paymentMethod: z.string().optional(),
  paymentReceived: z.number().optional(),
  changeAmount: z.number().optional(),
  totalAmount: z.number().optional(),

  movementId: z.string().uuid().optional(),
  referenceType: z.string().optional(),
  referenceId: z.string().optional(),
  notes: z.string().optional(),
  // Actor — user who performed this action (for all movement types)
  actorName: z.string().optional(),
  // Batch context on sale items
  batchStatus: z.string().optional(),
  batchRemainingQty: z.number().optional(),
}).strict();

export const ProductHistoryItemSchema = z.object({
  eventDate: z.string().datetime(),
  type: ProductHistoryTypeEnum,
  // Positive for IN, negative for OUT
  quantityChange: z.number(),
  unitCost: z.number().optional(),
  totalCost: z.number().optional(),
  unitPrice: z.number().optional(),
  lineTotal: z.number().optional(),
  batchNumber: z.string().optional().nullable(),
  expiryDate: z.string().datetime().optional().nullable(),
  runningQuantity: z.number().optional(),
  runningValuation: z.number().optional(),
  averageCost: z.number().optional(),
  reference: ProductHistoryReferenceSchema.optional(),
  // UOM fields - optional for backward compatibility
  uomId: z.string().uuid().optional().nullable(),
  uomName: z.string().optional().nullable(),
  uomSymbol: z.string().optional().nullable(),
}).strict();

export const ProductHistoryQuerySchema = z.object({
  page: z.number().int().positive().default(1),
  limit: z.number().int().positive().max(200).default(100),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  type: ProductHistoryTypeEnum.optional(),
}).strict();

export const ProductHistorySummarySchema = z.object({
  firstMovementDate: z.string().datetime().optional(),
  lastMovementDate: z.string().datetime().optional(),
  totalInQuantity: z.number(),
  totalOutQuantity: z.number(),
  netQuantityChange: z.number(),
  totalInValue: z.number(),
  totalOutValue: z.number(),
  currentValuation: z.number().optional(),
}).strict();

export type ProductHistoryItem = z.infer<typeof ProductHistoryItemSchema>;
export type ProductHistoryQuery = z.infer<typeof ProductHistoryQuerySchema>;
export type ProductHistorySummary = z.infer<typeof ProductHistorySummarySchema>;
