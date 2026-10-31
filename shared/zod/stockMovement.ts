// Stock Movement Validation Schema
// Schema for inventory movement tracking and validation

import { z } from 'zod';
import Decimal from 'decimal.js';

/**
 * Movement type enum - all possible movement types in the system
 */
export const MovementTypeSchema = z.enum([
  'GOODS_RECEIPT',
  'SALE',
  'ADJUSTMENT_IN',
  'ADJUSTMENT_OUT',
  'TRANSFER_IN',
  'TRANSFER_OUT',
  'RETURN',
  'DAMAGE',
  'EXPIRY',
  'OPENING_BALANCE',
  'PRODUCTION_ISSUE',
  'PRODUCTION_RECEIPT',
  'GOODS_ISSUE',
  'GOODS_ISSUE_REVERSAL',
]);

export type MovementType = z.infer<typeof MovementTypeSchema>;

/**
 * Manual movement types (can be created directly by users)
 */
export const ManualMovementTypeSchema = z.enum([
  'ADJUSTMENT_IN',
  'ADJUSTMENT_OUT',
  'DAMAGE',
  'EXPIRY',
  'RETURN',
]);

export type ManualMovementType = z.infer<typeof ManualMovementTypeSchema>;

/**
 * Stock movement validation schema
 */
export const StockMovementSchema = z
  .object({
    id: z.string().uuid(),
    productId: z.string().uuid(),
    batchId: z.string().uuid().optional().nullable(),
    movementType: MovementTypeSchema,
    quantity: z
      .number()
      .refine((val) => {
        try {
          return new Decimal(val).abs().greaterThan(0);
        } catch {
          return false;
        }
      }, 'Quantity must be greater than 0')
      .transform((val) => new Decimal(val).toNumber()),
    unitCost: z
      .number()
      .nonnegative('Unit cost cannot be negative')
      .optional()
      .nullable()
      .transform((val) => (val !== null && val !== undefined ? new Decimal(val).toNumber() : null)),
    referenceType: z
      .enum(['SALE', 'PURCHASE_ORDER', 'GOODS_RECEIPT', 'ADJUSTMENT', 'TRANSFER', 'RETURN'])
      .optional()
      .nullable(),
    referenceId: z.string().uuid().optional().nullable(),
    referenceNumber: z.string().max(50).optional().nullable(),
    fromLocation: z.string().max(100).optional().nullable(),
    toLocation: z.string().max(100).optional().nullable(),
    notes: z.string().max(500).optional().nullable(),
    reason: z.string().max(255).optional().nullable(),
    createdBy: z.string().uuid(),
    createdAt: z.string().datetime(),
  })
  .strict()
  .refine(
    (data) => {
      // For TRANSFER movements, require both locations
      if (data.movementType === 'TRANSFER_IN' || data.movementType === 'TRANSFER_OUT') {
        return data.fromLocation && data.toLocation;
      }
      return true;
    },
    {
      message: 'Transfer movements require both fromLocation and toLocation',
      path: ['movementType'],
    }
  );

export type StockMovement = z.infer<typeof StockMovementSchema>;

/**
 * Create stock movement schema (for manual movements)
 */
export const CreateStockMovementSchema = z
  .object({
    productId: z.string().uuid(),
    batchId: z.string().uuid().optional().nullable(),
    movementType: ManualMovementTypeSchema,
    quantity: z
      .number()
      .refine((val) => {
        try {
          return new Decimal(val).abs().greaterThan(0);
        } catch {
          return false;
        }
      }, 'Quantity must be greater than 0'),
    notes: z.string().max(500).optional().nullable(),
    reason: z.string().max(255).optional().nullable(),
    createdBy: z.string().uuid(),
  })
  .strict();

export type CreateStockMovementInput = z.infer<typeof CreateStockMovementSchema>;

/**
 * Stock movement with product and batch details
 */
// Extract base object before applying extend (unwrap ZodEffects from refine)
const baseStockMovementSchema = StockMovementSchema._def.schema;
export const StockMovementWithDetailsSchema = baseStockMovementSchema.extend({
  productName: z.string(),
  productSku: z.string().optional().nullable(),
  batchNumber: z.string().optional().nullable(),
  expiryDate: z.string().optional().nullable(),
});

export type StockMovementWithDetails = z.infer<typeof StockMovementWithDetailsSchema>;

/**
 * Movement filters for querying
 */
export const MovementFiltersSchema = z.object({
  productId: z.string().uuid().optional(),
  batchId: z.string().uuid().optional(),
  movementType: MovementTypeSchema.optional(),
  referenceType: z
    .enum(['SALE', 'PURCHASE_ORDER', 'GOODS_RECEIPT', 'ADJUSTMENT', 'TRANSFER', 'RETURN'])
    .optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  createdBy: z.string().uuid().optional(),
});

export type MovementFilters = z.infer<typeof MovementFiltersSchema>;

/**
 * Movement summary aggregation
 */
export const MovementSummarySchema = z.object({
  productId: z.string().uuid(),
  productName: z.string(),
  totalIn: z.number().nonnegative(),
  totalOut: z.number().nonnegative(),
  netMovement: z.number(),
  movementCount: z.number().int().nonnegative(),
  valueIn: z.number().nonnegative().optional(),
  valueOut: z.number().nonnegative().optional(),
  lastMovementDate: z.string().datetime(),
});

export type MovementSummary = z.infer<typeof MovementSummarySchema>;
