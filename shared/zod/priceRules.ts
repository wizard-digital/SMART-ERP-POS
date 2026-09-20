// Price Rules Zod Schemas — Odoo-style pricelist rules
// Validation for price rules, product categories, and price calculation requests

import { z } from 'zod';
import { normalizeProductCategoryName } from '../utils/productCategoryName.js';

// ============================================================================
// Enums
// ============================================================================

export const PriceRuleType = z.enum(['multiplier', 'discount', 'fixed']);
export type PriceRuleType = z.infer<typeof PriceRuleType>;

// ============================================================================
// Product Category
// ============================================================================

const ProductCategoryNameSchema = z
  .string()
  .transform((v) => normalizeProductCategoryName(v))
  .pipe(z.string().min(1, 'Category name is required').max(255));

export const ProductCategorySchema = z.object({
    id: z.string().uuid(),
    name: z.string().min(1).max(255),
    description: z.string().nullable().optional(),
    isActive: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
}).strict();

export const CreateProductCategorySchema = z.object({
    name: ProductCategoryNameSchema,
    description: z.string().max(1000).optional(),
}).strict();

export const UpdateProductCategorySchema = z.object({
    name: ProductCategoryNameSchema.optional(),
    description: z.string().max(1000).nullable().optional(),
    isActive: z.boolean().optional(),
}).strict();

export type ProductCategory = z.infer<typeof ProductCategorySchema>;
export type CreateProductCategory = z.infer<typeof CreateProductCategorySchema>;
export type UpdateProductCategory = z.infer<typeof UpdateProductCategorySchema>;

// ============================================================================
// Price Rule
// ============================================================================

export const PriceRuleSchema = z.object({
    id: z.string().uuid(),
    customerGroupId: z.string().uuid(),
    customerGroupName: z.string().optional(),
    name: z.string().nullable().optional(),
    ruleType: PriceRuleType,
    value: z.number(),
    categoryId: z.string().uuid().nullable().optional(),
    categoryName: z.string().nullable().optional(),
    productId: z.string().uuid().nullable().optional(),
    productName: z.string().nullable().optional(),
    minQuantity: z.number().positive(),
    validFrom: z.string().nullable().optional(),
    validUntil: z.string().nullable().optional(),
    priority: z.number().int().nonnegative(),
    isActive: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
}).strict();

export const CreatePriceRuleSchema = z.object({
    customerGroupId: z.string().uuid('Invalid customer group ID'),
    name: z.string().max(255).optional(),
    ruleType: PriceRuleType,
    value: z.number().finite('Value must be a finite number'),
    categoryId: z.string().uuid('Invalid category ID').nullable().optional(),
    productId: z.string().uuid('Invalid product ID').nullable().optional(),
    minQuantity: z.number().positive('Minimum quantity must be positive').default(1),
    validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD').optional(),
    validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD').optional(),
    priority: z.number().int().nonnegative('Priority must be non-negative').default(0),
}).strict().superRefine((data, ctx) => {
    // Scope constraint: cannot target both category AND product
    if (data.categoryId && data.productId) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['productId'],
            message: 'A rule cannot target both a category and a product. Use one or neither (global).',
        });
    }

    // Business rule validations by type
    if (data.ruleType === 'multiplier' && data.value <= 0) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['value'],
            message: 'Multiplier must be positive (e.g., 0.95 for 5% below base, 1.20 for 20% markup)',
        });
    }

    if (data.ruleType === 'discount') {
        if (data.value < 0 || data.value >= 100) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['value'],
                message: 'Discount must be between 0 and 99.99 (percentage). 100% discount is not allowed.',
            });
        }
    }

    if (data.ruleType === 'fixed' && data.value < 0) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['value'],
            message: 'Fixed price cannot be negative',
        });
    }

    // Date range validation
    if (data.validFrom && data.validUntil && data.validFrom > data.validUntil) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['validUntil'],
            message: 'validUntil must be on or after validFrom',
        });
    }
});

export const UpdatePriceRuleSchema = z.object({
    name: z.string().max(255).nullable().optional(),
    ruleType: PriceRuleType.optional(),
    value: z.number().finite().optional(),
    categoryId: z.string().uuid().nullable().optional(),
    productId: z.string().uuid().nullable().optional(),
    minQuantity: z.number().positive().optional(),
    validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    priority: z.number().int().nonnegative().optional(),
    isActive: z.boolean().optional(),
}).strict().superRefine((data, ctx) => {
    // Scope constraint: cannot target both category AND product
    if (data.categoryId && data.productId) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['productId'],
            message: 'A rule cannot target both a category and a product. Use one or neither (global).',
        });
    }

    // Value validations when both ruleType and value are present
    if (data.ruleType !== undefined && data.value !== undefined) {
        if (data.ruleType === 'multiplier' && data.value <= 0) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['value'],
                message: 'Multiplier must be positive (e.g., 0.95 for 5% below base, 1.20 for 20% markup)',
            });
        }

        if (data.ruleType === 'discount' && (data.value < 0 || data.value >= 100)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['value'],
                message: 'Discount must be between 0 and 99.99 (percentage). 100% discount is not allowed.',
            });
        }

        if (data.ruleType === 'fixed' && data.value < 0) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['value'],
                message: 'Fixed price cannot be negative',
            });
        }
    }

    // Value-only validation: guard against clearly invalid values even if ruleType not in this update
    if (data.value !== undefined && data.ruleType === undefined) {
        // Cannot fully validate without knowing the rule type, but reject obviously bad values
        if (!isFinite(data.value)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['value'],
                message: 'Value must be a finite number',
            });
        }
    }

    // Date range validation
    if (data.validFrom && data.validUntil && data.validFrom > data.validUntil) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['validUntil'],
            message: 'validUntil must be on or after validFrom',
        });
    }
});

export type PriceRule = z.infer<typeof PriceRuleSchema>;
export type CreatePriceRule = z.infer<typeof CreatePriceRuleSchema>;
export type UpdatePriceRule = z.infer<typeof UpdatePriceRuleSchema>;

// ============================================================================
// Price Calculation Request / Response
// ============================================================================

export const GetPriceRequestSchema = z.object({
    productId: z.string().uuid('Invalid product ID'),
    customerId: z.string().uuid('Invalid customer ID').optional(),
    customerGroupId: z.string().uuid('Invalid customer group ID').optional(),
    quantity: z.coerce.number().positive('Quantity must be positive').default(1),
}).strict();

export const BulkPriceRequestSchema = z.object({
    items: z.array(z.object({
        productId: z.string().uuid('Invalid product ID'),
        quantity: z.number().positive().default(1),
        /** Base-unit qty for AT_COST FIFO issue preview (defaults to quantity when omitted). */
        baseQuantity: z.number().positive().optional(),
    })).min(1, 'At least one item required').max(500, 'Maximum 500 items per request'),
    customerId: z.string().uuid().optional(),
    customerGroupId: z.string().uuid().optional(),
}).strict();

export type GetPriceRequest = z.infer<typeof GetPriceRequestSchema>;
export type BulkPriceRequest = z.infer<typeof BulkPriceRequestSchema>;
