/**
 * Pricing Engine Service — Business Logic Layer
 *
 * Orchestrates the Odoo-style price rule resolution and provides
 * a unified getFinalPrice() method for the whole system.
 *
 * Resolution priority:
 *   1. Product-specific pricing_tier  (existing)
 *   2. Price Rule: product → category → global  (NEW)
 *   3. Customer group flat discount  (existing)
 *   4. Product pricing_formula  (existing)
 *   5. Base selling_price fallback  (existing)
 *
 * ARCHITECTURE: Service layer — business logic only, delegates SQL to pricingRepository
 */

import type { Pool, PoolClient } from 'pg';
import Decimal from 'decimal.js';
import NodeCache from 'node-cache';
import { pool as globalPool } from '../../db/pool.js';
import { Money } from '../../utils/money.js';
import {
    ConflictError,
    NotFoundError,
    ValidationError,
} from '../../middleware/errorHandler.js';
import logger from '../../utils/logger.js';
import * as pricingCache from '../../services/pricingCacheService.js';
import * as pricingService from '../../services/pricingService.js';
import * as repo from './pricingRepository.js';
import { normalisePriceRule, normaliseProductCategory } from './pricingRepository.js';
import {
    previewFefoIssueCostForBaseQty,
    previewFefoIssueLayers,
    resolveAtCostWithLayers,
    type ProductValuationForAtCost,
} from './atCostIssuePrice.js';
import type {
    CreateProductCategory,
    UpdateProductCategory,
    CreatePriceRule,
    UpdatePriceRule,
} from '../../../../shared/zod/priceRules.js';
import { getBusinessDate } from '../../utils/dateRange.js';

// ============================================================================
// Engine-private cache — stores full ResolvedPrice objects
// Separate namespace from pricingCacheService to avoid cross-engine contamination
// ============================================================================

const engineCache = new NodeCache({
    stdTTL: 3600,      // 1 hour
    checkperiod: 600,   // Check expired every 10 min
    useClones: false,   // Immutable objects — skip clone overhead
});

function eCacheKey(productId: string, groupId: string | null, qty: number): string {
    return `pe:${productId}:${groupId ?? 'default'}:${qty}`;
}

function eCacheGet(productId: string, groupId: string | null, qty: number): ResolvedPrice | null {
    return engineCache.get<ResolvedPrice>(eCacheKey(productId, groupId, qty)) ?? null;
}

function eCacheSet(productId: string, groupId: string | null, qty: number, result: ResolvedPrice): void {
    engineCache.set(eCacheKey(productId, groupId, qty), result);
}

function eCacheInvalidateGroup(groupId: string): void {
    const needle = `:${groupId}:`;
    for (const key of engineCache.keys()) {
        if (key.includes(needle)) {
            engineCache.del(key);
        }
    }
}

// ============================================================================
// Types
// ============================================================================

export interface AtCostLayerPrice {
    baseQuantity: number;
    unitCostPerBase: number;
    totalCost: number;
}

export interface ResolvedPrice {
    finalPrice: number;
    basePrice: number;
    discount: number;
    /** FIFO/FEFO segments when scope is at_cost (e.g. 1@20000 + 1@18000). */
    atCostLayers?: AtCostLayerPrice[];
    /**
     * FEFO/FIFO allocated carrying per base unit for the requested qty.
     * POS walk-in floor after lot write-down. Independent of catalog cost_price.
     */
    allocatedCostPerBase?: number;
    allocatedLayers?: AtCostLayerPrice[];
    appliedRule: {
        ruleId: string | null;
        ruleName: string | null;
        ruleType: string | null;
        ruleValue: number | null;
        scope: 'tier' | 'product' | 'category' | 'global' | 'group_discount' | 'formula' | 'base' | 'at_cost';
    };
}

/** Live FEFO carrying — not cached with selling price (write-down must be visible immediately). */
async function attachAllocatedIssueCost(
    pool: Pool | PoolClient,
    productId: string,
    baseQty: number,
    price: ResolvedPrice,
): Promise<ResolvedPrice> {
    const qty = new Decimal(baseQty);
    if (!qty.isFinite() || qty.lessThanOrEqualTo(0)) return price;
    try {
        const preview = await previewFefoIssueCostForBaseQty(pool, productId, qty);
        const covered = preview?.coveredQty;
        if (!covered || covered.lessThanOrEqualTo(0)) return price;
        const allocatedCostPerBase = Money.toNumber(Money.round(preview.totalCost.dividedBy(covered), 2));
        if (!(allocatedCostPerBase > 0)) return price;
        let allocatedLayers = price.atCostLayers;
        if (!allocatedLayers?.length) {
            allocatedLayers = await previewFefoIssueLayers(pool, productId, qty);
        }
        return {
            ...price,
            allocatedCostPerBase,
            allocatedLayers: allocatedLayers?.length ? allocatedLayers : undefined,
        };
    } catch (err) {
        logger.debug('Allocated FEFO cost preview unavailable', {
            productId,
            error: err instanceof Error ? err.message : String(err),
        });
        return price;
    }
}

// ============================================================================
// CORE: getFinalPrice — single product price resolution
// ============================================================================

async function resolveSellingPrice(
    productId: string,
    customerId: string | undefined,
    customerGroupId: string | undefined,
    quantity: number = 1,
    dbPool?: Pool | PoolClient,
    baseQuantity?: number,
): Promise<ResolvedPrice> {
    const pool = dbPool || globalPool;

    // Resolve customer group if customerId provided but no groupId
    let groupId = customerGroupId ?? null;
    if (!groupId && customerId) {
        groupId = await repo.getCustomerGroupId(pool, customerId);
    }

    // ── AT_COST override: customer's price group supersedes ALL other pricing ──
    // Check before cache — AT_COST is customer-specific, not group-specific,
    // so the engine cache (keyed by productId+groupId+qty) is not safe to use.
    if (customerId) {
        const pricingMode = await repo.getCustomerPricingMode(pool, customerId);
        if (pricingMode === 'AT_COST') {
            const product = await repo.getProductValuationForAtCost(pool, productId);
            if (!product) throw new NotFoundError(`Product ${productId}`);
            const baseQty = baseQuantity ?? quantity;
            const valuation: ProductValuationForAtCost = {
                sellingPrice: product.sellingPrice,
                costPrice: product.costPrice,
                averageCost: product.averageCost,
                costingMethod: product.costingMethod as ProductValuationForAtCost['costingMethod'],
            };
            const { unitPricePerBase, ruleName, layers } = await resolveAtCostWithLayers(
                pool,
                productId,
                baseQty,
                valuation,
            );
            const basePriceForMode = Money.parseDb(product.sellingPrice);
            const issueCost = Money.parseDb(String(unitPricePerBase));
            const discountAmt = basePriceForMode.minus(issueCost).greaterThan(0)
                ? basePriceForMode.minus(issueCost)
                : Money.zero();
            return {
                finalPrice: unitPricePerBase,
                basePrice: Money.toNumber(Money.round(basePriceForMode)),
                discount: Money.toNumber(Money.round(discountAmt)),
                atCostLayers: layers,
                appliedRule: {
                    ruleId: null,
                    ruleName,
                    ruleType: 'at_cost',
                    ruleValue: null,
                    scope: 'at_cost',
                },
            };
        }
    }

    // C1: Engine-private cache stores full ResolvedPrice (not just a number)
    const cached = eCacheGet(productId, groupId, quantity);
    if (cached) return cached;

    // Get product base price
    const product = await repo.getProductBasePrice(pool, productId);
    if (!product) {
        throw new NotFoundError(`Product ${productId}`);
    }

    const basePrice = Money.parseDb(product.sellingPrice);
    const _costPrice = Money.parseDb(product.costPrice);
    const today = getBusinessDate(); // YYYY-MM-DD

    // --- 1. Pricing Tier (direct query — bypasses old calculatePrice) ---
    const tier = await repo.findApplicableTier(pool, productId, groupId, quantity, today);
    if (tier) {
        const tierPrice = Money.parseDb(tier.calculated_price);
        const discount = basePrice.minus(tierPrice).greaterThan(0)
            ? basePrice.minus(tierPrice)
            : Money.zero();

        const result: ResolvedPrice = {
            finalPrice: Money.toNumber(Money.round(tierPrice)),
            basePrice: Money.toNumber(Money.round(basePrice)),
            discount: Money.toNumber(Money.round(discount)),
            appliedRule: {
                ruleId: tier.id,
                ruleName: tier.name,
                ruleType: 'tier',
                ruleValue: null,
                scope: 'tier',
            },
        };
        eCacheSet(productId, groupId, quantity, result);
        return result;
    }

    // --- 2. Price Rule (product → category → global) ---
    if (groupId) {
        const rule = await repo.findApplicableRule(pool, productId, groupId, quantity, today);

        if (rule) {
            const resolvedPrice = applyRule(
                rule.rule_type,
                Money.parseDb(rule.rule_value),
                basePrice,
            );

            const discount = basePrice.minus(resolvedPrice).greaterThan(0)
                ? basePrice.minus(resolvedPrice)
                : Money.zero();

            const result: ResolvedPrice = {
                finalPrice: Money.toNumber(Money.round(resolvedPrice)),
                basePrice: Money.toNumber(Money.round(basePrice)),
                discount: Money.toNumber(Money.round(discount)),
                appliedRule: {
                    ruleId: rule.rule_id,
                    ruleName: rule.rule_name,
                    ruleType: rule.rule_type,
                    ruleValue: Money.toNumber(Money.parseDb(rule.rule_value)),
                    scope: rule.scope,
                },
            };
            eCacheSet(productId, groupId, quantity, result);
            return result;
        }
    }

    // --- 3. Customer Group Discount (flat percentage) ---
    if (groupId) {
        const discountPctStr = await repo.getGroupDiscountPercentage(pool, groupId);
        if (discountPctStr) {
            const discountPct = Money.parseDb(discountPctStr);
            if (!discountPct.isZero()) {
                const discountAmt = Money.multiply(basePrice, discountPct);
                const finalPrice = Money.subtract(basePrice, discountAmt);

                const result: ResolvedPrice = {
                    finalPrice: Money.toNumber(Money.round(finalPrice)),
                    basePrice: Money.toNumber(Money.round(basePrice)),
                    discount: Money.toNumber(Money.round(discountAmt)),
                    appliedRule: {
                        ruleId: null,
                        ruleName: null,
                        ruleType: 'group_discount',
                        ruleValue: Money.toNumber(discountPct),
                        scope: 'group_discount',
                    },
                };
                eCacheSet(productId, groupId, quantity, result);
                return result;
            }
        }
    }

    // --- 4. Product Pricing Formula (VM2 sandbox) ---
    const formula = await repo.getProductFormula(pool, productId);
    if (formula) {
        try {
            const formulaPrice = await pricingService.evaluateFormula(formula, productId, quantity, pool);
            const price = Money.parse(formulaPrice);

            const result: ResolvedPrice = {
                finalPrice: Money.toNumber(Money.round(price)),
                basePrice: Money.toNumber(Money.round(basePrice)),
                discount: Money.toNumber(Money.zero()),
                appliedRule: {
                    ruleId: null,
                    ruleName: null,
                    ruleType: 'formula',
                    ruleValue: null,
                    scope: 'formula',
                },
            };
            eCacheSet(productId, groupId, quantity, result);
            return result;
        } catch (error) {
            logger.warn('Formula evaluation failed, falling back to base price', {
                productId,
                formula,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    // --- 5. Base Selling Price Fallback ---
    const fallback: ResolvedPrice = {
        finalPrice: Money.toNumber(Money.round(basePrice)),
        basePrice: Money.toNumber(Money.round(basePrice)),
        discount: Money.toNumber(Money.zero()),
        appliedRule: {
            ruleId: null,
            ruleName: null,
            ruleType: null,
            ruleValue: null,
            scope: 'base',
        },
    };
    eCacheSet(productId, groupId, quantity, fallback);
    return fallback;
}

export async function getFinalPrice(
    productId: string,
    customerId: string | undefined,
    customerGroupId: string | undefined,
    quantity: number = 1,
    dbPool?: Pool | PoolClient,
    baseQuantity?: number,
): Promise<ResolvedPrice> {
    const pool = dbPool || globalPool;
    const price = await resolveSellingPrice(
        productId,
        customerId,
        customerGroupId,
        quantity,
        dbPool,
        baseQuantity,
    );
    return attachAllocatedIssueCost(pool, productId, baseQuantity ?? quantity, price);
}

// ============================================================================
// BULK: getFinalPricesBulk — cart / order pricing (batched)
// ============================================================================

async function resolveSellingPricesBulk(
    items: Array<{ productId: string; quantity: number; baseQuantity?: number }>,
    customerId: string | undefined,
    customerGroupId: string | undefined,
    dbPool?: Pool | PoolClient,
): Promise<ResolvedPrice[]> {
    const pool = dbPool || globalPool;
    const results: ResolvedPrice[] = [];

    if (items.length === 0) return results;

    // --- Batch shared lookups (1 query each instead of N) ---
    let groupId = customerGroupId ?? null;
    if (!groupId && customerId) {
        groupId = await repo.getCustomerGroupId(pool, customerId);
    }

    // ── AT_COST override: resolve once for the whole cart ──────────────────
    if (customerId) {
        const pricingMode = await repo.getCustomerPricingMode(pool, customerId);
        if (pricingMode === 'AT_COST') {
            const productIds = items.map(i => i.productId);
            const valuationMap = await repo.getProductValuationForAtCostBulk(pool, productIds);
            return Promise.all(items.map(async (item) => {
                const baseData = valuationMap.get(item.productId);
                if (!baseData) throw new NotFoundError(`Product ${item.productId}`);
                const baseQty = item.baseQuantity ?? item.quantity;
                const valuation: ProductValuationForAtCost = {
                    sellingPrice: baseData.sellingPrice,
                    costPrice: baseData.costPrice,
                    averageCost: baseData.averageCost,
                    costingMethod: baseData.costingMethod as ProductValuationForAtCost['costingMethod'],
                };
                const { unitPricePerBase, ruleName, layers } = await resolveAtCostWithLayers(
                    pool,
                    item.productId,
                    baseQty,
                    valuation,
                );
                const basePrice = Money.parseDb(baseData.sellingPrice);
                const issueCost = Money.parseDb(String(unitPricePerBase));
                const discountAmt = basePrice.minus(issueCost).greaterThan(0)
                    ? basePrice.minus(issueCost)
                    : Money.zero();
                return {
                    finalPrice: unitPricePerBase,
                    basePrice: Money.toNumber(Money.round(basePrice)),
                    discount: Money.toNumber(Money.round(discountAmt)),
                    atCostLayers: layers,
                    appliedRule: {
                        ruleId: null,
                        ruleName,
                        ruleType: 'at_cost',
                        ruleValue: null,
                        scope: 'at_cost' as const,
                    },
                };
            }));
        }
    }

    const productIds = items.map(i => i.productId);
    const today = getBusinessDate();

    // Batch: base prices (1 query)
    const basePriceMap = await repo.getProductBasePricesBulk(pool, productIds);

    // Batch: tiers per distinct quantity (1 query per distinct qty)
    const tierResults = new Map<string, repo.PricingTierRow>();
    {
        const qtyGroups = new Map<number, string[]>();
        for (const item of items) {
            const group = qtyGroups.get(item.quantity) || [];
            group.push(item.productId);
            qtyGroups.set(item.quantity, group);
        }
        for (const [qty, pids] of qtyGroups) {
            const batch = await repo.findApplicableTiersBulk(pool, pids, groupId, qty, today);
            for (const [pid, tier] of batch) {
                tierResults.set(`${pid}:${qty}`, tier);
            }
        }
    }

    // Batch: rules per distinct quantity (1 query per distinct qty)
    const ruleResults = new Map<string, repo.ResolvedPriceRuleRow>();
    if (groupId) {
        const qtyGroups = new Map<number, string[]>();
        for (const item of items) {
            const group = qtyGroups.get(item.quantity) || [];
            group.push(item.productId);
            qtyGroups.set(item.quantity, group);
        }
        for (const [qty, pids] of qtyGroups) {
            const batch = await repo.findApplicableRulesBulk(pool, pids, groupId, qty, today);
            for (const [pid, rule] of batch) {
                ruleResults.set(`${pid}:${qty}`, rule);
            }
        }
    }

    // Group discount (1 query — same for all items)
    let groupDiscountPct: Decimal | null = null;
    if (groupId) {
        const pctStr = await repo.getGroupDiscountPercentage(pool, groupId);
        if (pctStr) {
            const pct = Money.parseDb(pctStr);
            if (!pct.isZero()) groupDiscountPct = pct;
        }
    }

    // --- Resolve each item using batched data ---
    for (const item of items) {
        // P2: Check engine cache first
        const cached = eCacheGet(item.productId, groupId, item.quantity);
        if (cached) {
            results.push(cached);
            continue;
        }

        const baseData = basePriceMap.get(item.productId);
        if (!baseData) {
            throw new NotFoundError(`Product ${item.productId}`);
        }

        const basePrice = Money.parseDb(baseData.sellingPrice);

        // Step 1: Tier (from batch — no calculatePrice call)
        const tier = tierResults.get(`${item.productId}:${item.quantity}`);
        if (tier) {
            const tierPrice = Money.parseDb(tier.calculated_price);
            const discount = basePrice.minus(tierPrice).greaterThan(0)
                ? basePrice.minus(tierPrice)
                : Money.zero();
            const result: ResolvedPrice = {
                finalPrice: Money.toNumber(Money.round(tierPrice)),
                basePrice: Money.toNumber(Money.round(basePrice)),
                discount: Money.toNumber(Money.round(discount)),
                appliedRule: {
                    ruleId: tier.id,
                    ruleName: tier.name,
                    ruleType: 'tier',
                    ruleValue: null,
                    scope: 'tier',
                },
            };
            eCacheSet(item.productId, groupId, item.quantity, result);
            results.push(result);
            continue;
        }

        // Step 2: Price rule (from batch)
        const rule = ruleResults.get(`${item.productId}:${item.quantity}`);
        if (rule) {
            const resolvedPrice = applyRule(rule.rule_type, Money.parseDb(rule.rule_value), basePrice);
            const discount = basePrice.minus(resolvedPrice).greaterThan(0)
                ? basePrice.minus(resolvedPrice)
                : Money.zero();
            const result: ResolvedPrice = {
                finalPrice: Money.toNumber(Money.round(resolvedPrice)),
                basePrice: Money.toNumber(Money.round(basePrice)),
                discount: Money.toNumber(Money.round(discount)),
                appliedRule: {
                    ruleId: rule.rule_id,
                    ruleName: rule.rule_name,
                    ruleType: rule.rule_type,
                    ruleValue: Money.toNumber(Money.parseDb(rule.rule_value)),
                    scope: rule.scope,
                },
            };
            eCacheSet(item.productId, groupId, item.quantity, result);
            results.push(result);
            continue;
        }

        // Step 3: Group discount (from batch — same for all)
        if (groupDiscountPct) {
            const discountAmt = Money.multiply(basePrice, groupDiscountPct);
            const finalPrice = Money.subtract(basePrice, discountAmt);
            const result: ResolvedPrice = {
                finalPrice: Money.toNumber(Money.round(finalPrice)),
                basePrice: Money.toNumber(Money.round(basePrice)),
                discount: Money.toNumber(Money.round(discountAmt)),
                appliedRule: {
                    ruleId: null,
                    ruleName: null,
                    ruleType: 'group_discount',
                    ruleValue: Money.toNumber(groupDiscountPct),
                    scope: 'group_discount',
                },
            };
            eCacheSet(item.productId, groupId, item.quantity, result);
            results.push(result);
            continue;
        }

        // Step 4: Formula — individual (rare, expensive to batch)
        const formula = await repo.getProductFormula(pool, item.productId);
        if (formula) {
            try {
                const formulaPrice = await pricingService.evaluateFormula(
                    formula, item.productId, item.quantity, pool,
                );
                const price = Money.parse(formulaPrice);
                const result: ResolvedPrice = {
                    finalPrice: Money.toNumber(Money.round(price)),
                    basePrice: Money.toNumber(Money.round(basePrice)),
                    discount: Money.toNumber(Money.zero()),
                    appliedRule: {
                        ruleId: null, ruleName: null, ruleType: 'formula',
                        ruleValue: null, scope: 'formula',
                    },
                };
                eCacheSet(item.productId, groupId, item.quantity, result);
                results.push(result);
                continue;
            } catch {
                // Fall through to base price
            }
        }

        // Step 5: Base price fallback
        const fallback: ResolvedPrice = {
            finalPrice: Money.toNumber(Money.round(basePrice)),
            basePrice: Money.toNumber(Money.round(basePrice)),
            discount: Money.toNumber(Money.zero()),
            appliedRule: {
                ruleId: null, ruleName: null, ruleType: null,
                ruleValue: null, scope: 'base',
            },
        };
        eCacheSet(item.productId, groupId, item.quantity, fallback);
        results.push(fallback);
    }

    return results;
}

export async function getFinalPricesBulk(
    items: Array<{ productId: string; quantity: number; baseQuantity?: number }>,
    customerId: string | undefined,
    customerGroupId: string | undefined,
    dbPool?: Pool | PoolClient,
): Promise<ResolvedPrice[]> {
    const pool = dbPool || globalPool;
    const selling = await resolveSellingPricesBulk(items, customerId, customerGroupId, dbPool);
    return Promise.all(
        items.map((item, i) =>
            attachAllocatedIssueCost(
                pool,
                item.productId,
                item.baseQuantity ?? item.quantity,
                selling[i],
            ),
        ),
    );
}

// ============================================================================
// Rule Application
// ============================================================================

function applyRule(
    ruleType: string,
    ruleValue: Decimal,
    basePrice: Decimal,
): Decimal {
    switch (ruleType) {
        case 'multiplier':
            // base × value (e.g., 0.95 = 5% below base, 1.20 = 20% above base)
            return Money.multiply(basePrice, ruleValue);
        case 'discount':
            // base × (1 − value/100) (e.g., value=10 → 10% discount)
            return Money.multiply(
                basePrice,
                Money.parse(1).minus(ruleValue.dividedBy(100)),
            );
        case 'fixed':
            // Flat price override
            return ruleValue;
        default:
            return basePrice;
    }
}

// ============================================================================
// CUSTOMER GROUPS (read-only for pricing UI dropdowns)
// ============================================================================

export async function listCustomerGroups(
    pool: Pool | PoolClient,
    isActive?: boolean,
) {
    const rows = await repo.listCustomerGroups(pool, isActive);
    return rows.map(repo.normaliseCustomerGroup);
}

// ============================================================================
// PRODUCT CATEGORIES CRUD
// ============================================================================

export async function listCategories(
    pool: Pool | PoolClient,
    page: number,
    limit: number,
    options?: { isActive?: boolean; search?: string },
) {
    const offset = (page - 1) * limit;
    const { rows, total } = await repo.listCategories(pool, {
        isActive: options?.isActive,
        search: options?.search,
        offset,
        limit,
    });

    return {
        data: rows.map(normaliseProductCategory),
        pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
        },
    };
}

export async function getCategoryById(pool: Pool | PoolClient, id: string) {
    const row = await repo.getCategoryById(pool, id);
    if (!row) throw new NotFoundError(`Product category ${id}`);
    return normaliseProductCategory(row);
}

export async function createCategory(pool: Pool | PoolClient, data: CreateProductCategory) {
    // Check uniqueness
    const existing = await repo.getCategoryByName(pool, data.name);
    if (existing) {
        throw new ConflictError(`Product category "${data.name}" already exists`);
    }
    const row = await repo.createCategory(pool, data);
    logger.info('Product category created', { categoryId: row.id, name: row.name });
    return normaliseProductCategory(row);
}

export async function updateCategory(
    pool: Pool | PoolClient,
    id: string,
    data: UpdateProductCategory,
) {
    // Check name uniqueness if changing
    if (data.name) {
        const existing = await repo.getCategoryByName(pool, data.name);
        if (existing && existing.id !== id) {
            throw new ConflictError(`Product category "${data.name}" already exists`);
        }
    }
    const row = await repo.updateCategory(pool, id, data);
    if (!row) throw new NotFoundError(`Product category ${id}`);
    logger.info('Product category updated', { categoryId: id });
    return normaliseProductCategory(row);
}

/**
 * Merge sourceId category into targetId.
 * All products and price_rules referencing sourceId are moved to targetId,
 * then the source category is deleted.
 */
export async function mergeCategories(
    pool: Pool | PoolClient,
    targetId: string,
    sourceId: string,
): Promise<{ movedProducts: number }> {
    if (targetId === sourceId) {
        throw new ConflictError('Cannot merge a category into itself');
    }
    const target = await repo.getCategoryById(pool, targetId);
    if (!target) throw new NotFoundError(`Target category ${targetId}`);
    const source = await repo.getCategoryById(pool, sourceId);
    if (!source) throw new NotFoundError(`Source category ${sourceId}`);

    const movedProducts = await repo.mergeCategories(pool, targetId, sourceId);
    logger.info('Product categories merged', {
        targetId,
        targetName: target.name,
        sourceId,
        sourceName: source.name,
        movedProducts,
    });
    return { movedProducts };
}

// ============================================================================
// PRICE RULES CRUD
// ============================================================================

export async function listPriceRules(
    pool: Pool | PoolClient,
    page: number,
    limit: number,
    filters?: {
        customerGroupId?: string;
        categoryId?: string;
        productId?: string;
        ruleType?: string;
        isActive?: boolean;
    },
) {
    const offset = (page - 1) * limit;
    const { rows, total } = await repo.listPriceRules(pool, {
        customerGroupId: filters?.customerGroupId,
        categoryId: filters?.categoryId,
        productId: filters?.productId,
        ruleType: filters?.ruleType,
        isActive: filters?.isActive,
        offset,
        limit,
    });

    return {
        data: rows.map(normalisePriceRule),
        pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
        },
    };
}

export async function getPriceRuleById(pool: Pool | PoolClient, id: string) {
    const row = await repo.getPriceRuleById(pool, id);
    if (!row) throw new NotFoundError(`Price rule ${id}`);
    return normalisePriceRule(row);
}

export async function createPriceRule(pool: Pool | PoolClient, data: CreatePriceRule) {
    // Validate referenced entities exist
    await validateReferences(pool, data.customerGroupId, data.categoryId, data.productId);

    const row = await repo.createPriceRule(pool, {
        customerGroupId: data.customerGroupId,
        name: data.name,
        ruleType: data.ruleType,
        value: data.value,
        categoryId: data.categoryId ?? null,
        productId: data.productId ?? null,
        minQuantity: data.minQuantity,
        validFrom: data.validFrom ?? null,
        validUntil: data.validUntil ?? null,
        priority: data.priority,
    });

    // Invalidate both engine cache and legacy cache
    eCacheInvalidateGroup(data.customerGroupId);
    pricingCache.invalidateCustomerGroup(data.customerGroupId);

    logger.info('Price rule created', {
        ruleId: row.id,
        ruleType: data.ruleType,
        customerGroupId: data.customerGroupId,
        scope: data.productId ? 'product' : data.categoryId ? 'category' : 'global',
    });

    // Re-fetch with JOINs for response
    return normalisePriceRule((await repo.getPriceRuleById(pool, row.id))!);
}

export async function updatePriceRule(pool: Pool | PoolClient, id: string, data: UpdatePriceRule) {
    // Check exists
    const existing = await repo.getPriceRuleById(pool, id);
    if (!existing) throw new NotFoundError(`Price rule ${id}`);

    // Scope constraint: if updating both fields, enforce constraint
    const newCategoryId = data.categoryId !== undefined ? data.categoryId : existing.category_id;
    const newProductId = data.productId !== undefined ? data.productId : existing.product_id;
    if (newCategoryId && newProductId) {
        throw new ValidationError('A rule cannot target both a category and a product');
    }

    // Merge ruleType + value with existing for cross-field validation
    const effectiveType = data.ruleType ?? existing.rule_type;
    const effectiveValue = data.value ?? Money.toNumber(Money.parseDb(existing.value));

    if (effectiveType === 'multiplier' && effectiveValue <= 0) {
        throw new ValidationError('Multiplier must be positive');
    }
    if (effectiveType === 'discount' && (effectiveValue < 0 || effectiveValue >= 100)) {
        throw new ValidationError('Discount must be between 0 and 99.99');
    }
    if (effectiveType === 'fixed' && effectiveValue < 0) {
        throw new ValidationError('Fixed price cannot be negative');
    }

    // Date range validation (merge with existing)
    const effectiveFrom = data.validFrom !== undefined ? data.validFrom : existing.valid_from;
    const effectiveUntil = data.validUntil !== undefined ? data.validUntil : existing.valid_until;
    if (effectiveFrom && effectiveUntil && effectiveFrom > effectiveUntil) {
        throw new ValidationError('validUntil must be on or after validFrom');
    }

    // Validate references if updated
    if (data.categoryId !== undefined || data.productId !== undefined) {
        await validateReferences(
            pool,
            existing.customer_group_id,
            data.categoryId !== undefined ? data.categoryId : existing.category_id,
            data.productId !== undefined ? data.productId : existing.product_id,
        );
    }

    const row = await repo.updatePriceRule(pool, id, data);
    if (!row) throw new NotFoundError(`Price rule ${id}`);

    eCacheInvalidateGroup(existing.customer_group_id);
    pricingCache.invalidateCustomerGroup(existing.customer_group_id);

    logger.info('Price rule updated', { ruleId: id });
    return normalisePriceRule((await repo.getPriceRuleById(pool, row.id))!);
}

export async function deletePriceRule(pool: Pool | PoolClient, id: string) {
    const existing = await repo.getPriceRuleById(pool, id);
    if (!existing) throw new NotFoundError(`Price rule ${id}`);
    if (!existing.is_active) throw new NotFoundError(`Price rule ${id} is already deleted`);

    await repo.deletePriceRule(pool, id);
    eCacheInvalidateGroup(existing.customer_group_id);
    pricingCache.invalidateCustomerGroup(existing.customer_group_id);

    logger.info('Price rule deactivated', { ruleId: id });
}

// ============================================================================
// PRICE GROUPS CRUD
// ============================================================================

export async function listPriceGroups(
    pool: Pool | PoolClient,
    isActive?: boolean,
) {
    const rows = await repo.listPriceGroups(pool, isActive);
    return rows.map(repo.normalisePriceGroup);
}

export async function createPriceGroup(
    pool: Pool | PoolClient,
    data: { name: string; pricingMode: repo.PricingMode; description?: string },
) {
    const row = await repo.createPriceGroup(pool, data);
    logger.info('Price group created', { priceGroupId: row.id, name: row.name, pricingMode: row.pricing_mode });
    return repo.normalisePriceGroup(row);
}

export async function updatePriceGroup(
    pool: Pool | PoolClient,
    id: string,
    data: { name?: string; pricingMode?: repo.PricingMode; description?: string | null; isActive?: boolean },
) {
    const row = await repo.updatePriceGroup(pool, id, data);
    if (!row) throw new NotFoundError(`Price group ${id}`);
    logger.info('Price group updated', { priceGroupId: id });
    return repo.normalisePriceGroup(row);
}

export async function deletePriceGroup(pool: Pool | PoolClient, id: string) {
    await repo.deletePriceGroup(pool, id);
    logger.info('Price group deactivated', { priceGroupId: id });
}

// ============================================================================
// Helpers
// ============================================================================

async function validateReferences(
    pool: Pool | PoolClient,
    customerGroupId: string,
    categoryId: string | null | undefined,
    productId: string | null | undefined,
): Promise<void> {
    if (!(await repo.customerGroupExists(pool, customerGroupId))) {
        throw new ValidationError(`Customer group ${customerGroupId} does not exist`);
    }

    if (categoryId) {
        if (!(await repo.categoryExists(pool, categoryId))) {
            throw new ValidationError(`Product category ${categoryId} does not exist`);
        }
    }

    if (productId) {
        if (!(await repo.productExists(pool, productId))) {
            throw new ValidationError(`Product ${productId} does not exist`);
        }
    }
}
