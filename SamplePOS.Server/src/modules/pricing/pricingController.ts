/**
 * Pricing Engine Controller — HTTP Request Handlers
 *
 * Validates input (Zod), delegates to service, formats { success, data } responses.
 *
 * ARCHITECTURE: Controller layer — no business logic, no SQL
 */

import type { Request, Response } from 'express';
import { z } from 'zod';
import { pool as globalPool } from '../../db/pool.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import {
    CreateProductCategorySchema,
    UpdateProductCategorySchema,
    CreatePriceRuleSchema,
    UpdatePriceRuleSchema,
    GetPriceRequestSchema,
    BulkPriceRequestSchema,
} from '../../../../shared/zod/priceRules.js';
import { PRICING_LIST_MAX_LIMIT } from '../../../../shared/pricing/listLimit.js';
import * as pricingEngine from './pricingEngineService.js';

// ---- Param / Query schemas ----
const UuidParamSchema = z.object({ id: z.string().uuid() });
const PaginationQuerySchema = z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(PRICING_LIST_MAX_LIMIT).default(50),
});

// ============================================================================
// PRICE CALCULATION
// ============================================================================

/**
 * GET /api/pricing/price?productId=&customerId=&customerGroupId=&quantity=
 */
export const getPrice = asyncHandler(async (req: Request, res: Response) => {
    const pool = req.tenantPool || globalPool;
    const { productId, customerId, customerGroupId, quantity } =
        GetPriceRequestSchema.parse(req.query);

    const result = await pricingEngine.getFinalPrice(
        productId,
        customerId,
        customerGroupId,
        quantity,
        pool,
    );

    res.json({ success: true, data: result });
});

/**
 * POST /api/pricing/price/bulk
 */
export const getBulkPrices = asyncHandler(async (req: Request, res: Response) => {
    const pool = req.tenantPool || globalPool;
    const { items, customerId, customerGroupId } = BulkPriceRequestSchema.parse(req.body);

    const resultsArray = await pricingEngine.getFinalPricesBulk(
        items,
        customerId,
        customerGroupId,
        pool,
    );

    // C2: Array is index-aligned with input — handles duplicate productIds at different quantities
    const data = items.map((item, index) => ({
        productId: item.productId,
        quantity: item.quantity,
        ...resultsArray[index],
    }));

    res.json({ success: true, data });
});

// ============================================================================
// CUSTOMER GROUPS (read-only for dropdowns)
// ============================================================================

/**
 * GET /api/pricing/customer-groups?isActive=true
 */
export const listCustomerGroups = asyncHandler(async (req: Request, res: Response) => {
    const pool = req.tenantPool || globalPool;
    const isActive = req.query.isActive === 'true' ? true
        : req.query.isActive === 'false' ? false
            : undefined;

    const data = await pricingEngine.listCustomerGroups(pool, isActive);
    res.json({ success: true, data });
});

// ============================================================================
// PRODUCT CATEGORIES
// ============================================================================

/**
 * GET /api/pricing/categories
 */
export const listCategories = asyncHandler(async (req: Request, res: Response) => {
    const pool = req.tenantPool || globalPool;
    const { page, limit } = PaginationQuerySchema.parse(req.query);
    const search = typeof req.query.search === 'string' ? req.query.search : undefined;
    const isActive = req.query.isActive === 'true' ? true
        : req.query.isActive === 'false' ? false
            : undefined;

    const result = await pricingEngine.listCategories(pool, page, limit, { isActive, search });
    res.json({ success: true, ...result });
});

/**
 * GET /api/pricing/categories/:id
 */
export const getCategoryById = asyncHandler(async (req: Request, res: Response) => {
    const pool = req.tenantPool || globalPool;
    const { id } = UuidParamSchema.parse(req.params);
    const category = await pricingEngine.getCategoryById(pool, id);
    res.json({ success: true, data: category });
});

/**
 * POST /api/pricing/categories
 */
export const createCategory = asyncHandler(async (req: Request, res: Response) => {
    const pool = req.tenantPool || globalPool;
    const data = CreateProductCategorySchema.parse(req.body);
    const category = await pricingEngine.createCategory(pool, data);
    res.status(201).json({ success: true, data: category, message: 'Category created' });
});

/**
 * PUT /api/pricing/categories/:id
 */
export const updateCategory = asyncHandler(async (req: Request, res: Response) => {
    const pool = req.tenantPool || globalPool;
    const { id } = UuidParamSchema.parse(req.params);
    const data = UpdateProductCategorySchema.parse(req.body);
    const category = await pricingEngine.updateCategory(pool, id, data);
    res.json({ success: true, data: category, message: 'Category updated' });
});

/**
 * POST /api/pricing/categories/:targetId/merge
 * Body: { sourceId: string }
 * Moves all products + price_rules from sourceId → targetId, then deletes sourceId.
 */
export const mergeCategory = asyncHandler(async (req: Request, res: Response) => {
    const pool = req.tenantPool || globalPool;
    const { id: targetId } = UuidParamSchema.parse(req.params);
    const { sourceId } = z.object({ sourceId: z.string().uuid() }).parse(req.body);
    const result = await pricingEngine.mergeCategories(pool, targetId, sourceId);
    res.json({ success: true, data: result, message: `Merged into category (${result.movedProducts} products moved)` });
});

// ============================================================================
// PRICE RULES
// ============================================================================

/**
 * GET /api/pricing/rules
 */
export const listPriceRules = asyncHandler(async (req: Request, res: Response) => {
    const pool = req.tenantPool || globalPool;
    const { page, limit } = PaginationQuerySchema.parse(req.query);

    const filters = {
        customerGroupId: typeof req.query.customerGroupId === 'string' ? req.query.customerGroupId : undefined,
        categoryId: typeof req.query.categoryId === 'string' ? req.query.categoryId : undefined,
        productId: typeof req.query.productId === 'string' ? req.query.productId : undefined,
        ruleType: typeof req.query.ruleType === 'string' ? req.query.ruleType : undefined,
        isActive: req.query.isActive === 'true' ? true
            : req.query.isActive === 'false' ? false
                : undefined,
    };

    const result = await pricingEngine.listPriceRules(pool, page, limit, filters);
    res.json({ success: true, ...result });
});

/**
 * GET /api/pricing/rules/:id
 */
export const getPriceRuleById = asyncHandler(async (req: Request, res: Response) => {
    const pool = req.tenantPool || globalPool;
    const { id } = UuidParamSchema.parse(req.params);
    const rule = await pricingEngine.getPriceRuleById(pool, id);
    res.json({ success: true, data: rule });
});

/**
 * POST /api/pricing/rules
 */
export const createPriceRule = asyncHandler(async (req: Request, res: Response) => {
    const pool = req.tenantPool || globalPool;
    const data = CreatePriceRuleSchema.parse(req.body);
    const rule = await pricingEngine.createPriceRule(pool, data);
    res.status(201).json({ success: true, data: rule, message: 'Price rule created' });
});

/**
 * PUT /api/pricing/rules/:id
 */
export const updatePriceRule = asyncHandler(async (req: Request, res: Response) => {
    const pool = req.tenantPool || globalPool;
    const { id } = UuidParamSchema.parse(req.params);
    const data = UpdatePriceRuleSchema.parse(req.body);
    const rule = await pricingEngine.updatePriceRule(pool, id, data);
    res.json({ success: true, data: rule, message: 'Price rule updated' });
});

/**
 * DELETE /api/pricing/rules/:id
 */
export const deletePriceRule = asyncHandler(async (req: Request, res: Response) => {
    const pool = req.tenantPool || globalPool;
    const { id } = UuidParamSchema.parse(req.params);
    await pricingEngine.deletePriceRule(pool, id);
    res.json({ success: true, message: 'Price rule deactivated' });
});

// ============================================================================
// PRICE GROUPS
// ============================================================================

const CreatePriceGroupSchema = z.object({
    name: z.string().min(1).max(255),
    pricingMode: z.enum(['STANDARD', 'AT_COST']),
    description: z.string().max(1000).optional(),
});

const UpdatePriceGroupSchema = CreatePriceGroupSchema.partial().extend({
    isActive: z.boolean().optional(),
});

/**
 * GET /api/pricing/price-groups
 */
export const listPriceGroups = asyncHandler(async (req: Request, res: Response) => {
    const pool = req.tenantPool || globalPool;
    const isActive = req.query.isActive === 'true' ? true
        : req.query.isActive === 'false' ? false
            : undefined;
    const data = await pricingEngine.listPriceGroups(pool, isActive);
    res.json({ success: true, data });
});

/**
 * POST /api/pricing/price-groups
 */
export const createPriceGroup = asyncHandler(async (req: Request, res: Response) => {
    const pool = req.tenantPool || globalPool;
    const data = CreatePriceGroupSchema.parse(req.body);
    const result = await pricingEngine.createPriceGroup(pool, data);
    res.status(201).json({ success: true, data: result, message: 'Price group created' });
});

/**
 * PUT /api/pricing/price-groups/:id
 */
export const updatePriceGroup = asyncHandler(async (req: Request, res: Response) => {
    const pool = req.tenantPool || globalPool;
    const { id } = UuidParamSchema.parse(req.params);
    const data = UpdatePriceGroupSchema.parse(req.body);
    const result = await pricingEngine.updatePriceGroup(pool, id, data);
    res.json({ success: true, data: result, message: 'Price group updated' });
});

/**
 * DELETE /api/pricing/price-groups/:id
 */
export const deletePriceGroup = asyncHandler(async (req: Request, res: Response) => {
    const pool = req.tenantPool || globalPool;
    const { id } = UuidParamSchema.parse(req.params);
    await pricingEngine.deletePriceGroup(pool, id);
    res.json({ success: true, message: 'Price group deactivated' });
});
