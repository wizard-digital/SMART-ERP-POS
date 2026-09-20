/**
 * Pricing Engine Repository — Data Access Layer
 *
 * Raw SQL queries for price_rules, product_categories, and the
 * getFinalPrice resolver query used by the service layer.
 *
 * ARCHITECTURE: Repository layer — SQL only, no business logic
 */

import type { Pool, PoolClient } from 'pg';
import { Money } from '../../utils/money.js';

// ============================================================================
// Types (DB row shapes)
// ============================================================================

export interface PriceRuleDbRow {
    id: string;
    customer_group_id: string;
    customer_group_name?: string;
    name: string | null;
    rule_type: string;
    value: string;
    category_id: string | null;
    category_name?: string | null;
    product_id: string | null;
    product_name?: string | null;
    min_quantity: string;
    valid_from: string | null;
    valid_until: string | null;
    priority: number;
    is_active: boolean;
    created_at: string;
    updated_at: string;
}

export interface ProductCategoryDbRow {
    id: string;
    name: string;
    description: string | null;
    is_active: boolean;
    created_at: string;
    updated_at: string;
}

export interface ResolvedPriceRuleRow {
    rule_id: string;
    rule_name: string | null;
    rule_type: string;
    rule_value: string;
    scope: 'product' | 'category' | 'global';
    priority: number;
}

// ============================================================================
// Normalise helpers
// ============================================================================

export function normalisePriceRule(r: PriceRuleDbRow) {
    return {
        id: r.id,
        customerGroupId: r.customer_group_id,
        customerGroupName: r.customer_group_name,
        name: r.name,
        ruleType: r.rule_type as 'multiplier' | 'discount' | 'fixed',
        value: Money.toNumber(Money.parseDb(r.value)),
        categoryId: r.category_id,
        categoryName: r.category_name ?? null,
        productId: r.product_id,
        productName: r.product_name ?? null,
        minQuantity: Money.toNumber(Money.parseDb(r.min_quantity)),
        validFrom: r.valid_from,
        validUntil: r.valid_until,
        priority: r.priority,
        isActive: r.is_active,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
    };
}

export function normaliseProductCategory(r: ProductCategoryDbRow) {
    return {
        id: r.id,
        name: r.name,
        description: r.description,
        isActive: r.is_active,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
    };
}

// ============================================================================
// PRODUCT CATEGORIES
// ============================================================================

export async function listCategories(
    client: Pool | PoolClient,
    options: { isActive?: boolean; search?: string; offset: number; limit: number },
): Promise<{ rows: ProductCategoryDbRow[]; total: number }> {
    const where: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (options.isActive !== undefined) {
        where.push(`is_active = $${idx++}`);
        values.push(options.isActive);
    }
    if (options.search) {
        where.push(`name ILIKE $${idx++}`);
        // Escape ILIKE metacharacters so literal %, _, \ are matched
        const escaped = options.search.replace(/[%_\\]/g, '\\$&');
        values.push(`%${escaped}%`);
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const countRes = await client.query(
        `SELECT COUNT(*) FROM product_categories ${whereClause}`,
        values,
    );

    const dataRes = await client.query(
        `SELECT * FROM product_categories ${whereClause}
         ORDER BY name
         LIMIT $${idx} OFFSET $${idx + 1}`,
        [...values, options.limit, options.offset],
    );

    return {
        rows: dataRes.rows,
        total: parseInt(countRes.rows[0].count),
    };
}

export async function getCategoryById(
    client: Pool | PoolClient,
    id: string,
): Promise<ProductCategoryDbRow | null> {
    const res = await client.query(`SELECT * FROM product_categories WHERE id = $1`, [id]);
    return res.rows[0] ?? null;
}

export async function getCategoryByName(
    client: Pool | PoolClient,
    name: string,
): Promise<ProductCategoryDbRow | null> {
    const res = await client.query(
        `SELECT * FROM product_categories
         WHERE LOWER(TRIM(name)) = LOWER(TRIM($1))
         ORDER BY created_at ASC NULLS LAST, id ASC
         LIMIT 1`,
        [name],
    );
    return res.rows[0] ?? null;
}

export async function createCategory(
    client: Pool | PoolClient,
    data: { name: string; description?: string },
): Promise<ProductCategoryDbRow> {
    const res = await client.query(
        `INSERT INTO product_categories (name, description)
         VALUES (TRIM(BOTH FROM regexp_replace($1, '\\s+', ' ', 'g')), $2)
         RETURNING *`,
        [data.name, data.description ?? null],
    );
    return res.rows[0];
}

export async function updateCategory(
    client: Pool | PoolClient,
    id: string,
    data: { name?: string; description?: string | null; isActive?: boolean },
): Promise<ProductCategoryDbRow | null> {
    const sets: string[] = ['updated_at = NOW()'];
    const values: unknown[] = [id];
    let idx = 2;

    if (data.name !== undefined) {
        sets.push(`name = TRIM(BOTH FROM regexp_replace($${idx++}, '\\s+', ' ', 'g'))`);
        values.push(data.name);
    }
    if (data.description !== undefined) {
        sets.push(`description = $${idx++}`);
        values.push(data.description);
    }
    if (data.isActive !== undefined) {
        sets.push(`is_active = $${idx++}`);
        values.push(data.isActive);
    }

    const res = await client.query(
        `UPDATE product_categories SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
        values,
    );
    return res.rows[0] ?? null;
}

/**
 * Merge sourceId category into targetId:
 * 1. Reassign all products (FK + denormalized text column)
 * 2. Reassign all price_rules
 * 3. Delete the source category
 * Returns the number of products moved.
 */
export async function mergeCategories(
    client: Pool | PoolClient,
    targetId: string,
    sourceId: string,
): Promise<number> {
    // Fetch target name for the denormalized products.category column
    const tgtRes = await client.query(
        `SELECT name FROM product_categories WHERE id = $1`,
        [targetId],
    );
    const targetName: string = tgtRes.rows[0]?.name ?? '';

    // Reassign products
    const prodRes = await client.query(
        `UPDATE products
         SET category_id = $1, category = $2
         WHERE category_id = $3`,
        [targetId, targetName, sourceId],
    );

    // Reassign price_rules (avoid ON DELETE CASCADE wiping them)
    await client.query(
        `UPDATE price_rules SET category_id = $1 WHERE category_id = $2`,
        [targetId, sourceId],
    );

    // Delete the now-empty source category
    await client.query(`DELETE FROM product_categories WHERE id = $1`, [sourceId]);

    return prodRes.rowCount ?? 0;
}

// ============================================================================
// PRICE RULES CRUD
// ============================================================================

export async function createPriceRule(
    client: Pool | PoolClient,
    data: {
        customerGroupId: string;
        name?: string;
        ruleType: string;
        value: number;
        categoryId?: string | null;
        productId?: string | null;
        minQuantity?: number;
        validFrom?: string | null;
        validUntil?: string | null;
        priority?: number;
    },
): Promise<PriceRuleDbRow> {
    const res = await client.query(
        `INSERT INTO price_rules (
            customer_group_id, name, rule_type, value,
            category_id, product_id, min_quantity,
            valid_from, valid_until, priority
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING *`,
        [
            data.customerGroupId,
            data.name ?? null,
            data.ruleType,
            data.value,
            data.categoryId ?? null,
            data.productId ?? null,
            data.minQuantity ?? 1,
            data.validFrom ?? null,
            data.validUntil ?? null,
            data.priority ?? 0,
        ],
    );
    return res.rows[0];
}

export async function updatePriceRule(
    client: Pool | PoolClient,
    id: string,
    data: {
        name?: string | null;
        ruleType?: string;
        value?: number;
        categoryId?: string | null;
        productId?: string | null;
        minQuantity?: number;
        validFrom?: string | null;
        validUntil?: string | null;
        priority?: number;
        isActive?: boolean;
    },
): Promise<PriceRuleDbRow | null> {
    const sets: string[] = ['updated_at = NOW()'];
    const values: unknown[] = [id];
    let idx = 2;

    if (data.name !== undefined) { sets.push(`name = $${idx++}`); values.push(data.name); }
    if (data.ruleType !== undefined) { sets.push(`rule_type = $${idx++}`); values.push(data.ruleType); }
    if (data.value !== undefined) { sets.push(`value = $${idx++}`); values.push(data.value); }
    if (data.categoryId !== undefined) { sets.push(`category_id = $${idx++}`); values.push(data.categoryId); }
    if (data.productId !== undefined) { sets.push(`product_id = $${idx++}`); values.push(data.productId); }
    if (data.minQuantity !== undefined) { sets.push(`min_quantity = $${idx++}`); values.push(data.minQuantity); }
    if (data.validFrom !== undefined) { sets.push(`valid_from = $${idx++}`); values.push(data.validFrom); }
    if (data.validUntil !== undefined) { sets.push(`valid_until = $${idx++}`); values.push(data.validUntil); }
    if (data.priority !== undefined) { sets.push(`priority = $${idx++}`); values.push(data.priority); }
    if (data.isActive !== undefined) { sets.push(`is_active = $${idx++}`); values.push(data.isActive); }

    const res = await client.query(
        `UPDATE price_rules SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
        values,
    );
    return res.rows[0] ?? null;
}

export async function getPriceRuleById(
    client: Pool | PoolClient,
    id: string,
): Promise<PriceRuleDbRow | null> {
    const res = await client.query(
        `SELECT pr.*,
                cg.name AS customer_group_name,
                pc.name AS category_name,
                p.name  AS product_name
         FROM price_rules pr
         LEFT JOIN customer_groups cg ON cg.id = pr.customer_group_id
         LEFT JOIN product_categories pc ON pc.id = pr.category_id
         LEFT JOIN products p ON p.id = pr.product_id
         WHERE pr.id = $1`,
        [id],
    );
    return res.rows[0] ?? null;
}

export async function deletePriceRule(
    client: Pool | PoolClient,
    id: string,
): Promise<boolean> {
    const res = await client.query(
        `UPDATE price_rules SET is_active = false, updated_at = NOW() WHERE id = $1 AND is_active = true`,
        [id],
    );
    return (res.rowCount ?? 0) > 0;
}

export async function listPriceRules(
    client: Pool | PoolClient,
    options: {
        customerGroupId?: string;
        categoryId?: string;
        productId?: string;
        ruleType?: string;
        isActive?: boolean;
        offset: number;
        limit: number;
    },
): Promise<{ rows: PriceRuleDbRow[]; total: number }> {
    const where: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (options.customerGroupId) {
        where.push(`pr.customer_group_id = $${idx++}`);
        values.push(options.customerGroupId);
    }
    if (options.categoryId) {
        where.push(`pr.category_id = $${idx++}`);
        values.push(options.categoryId);
    }
    if (options.productId) {
        where.push(`pr.product_id = $${idx++}`);
        values.push(options.productId);
    }
    if (options.ruleType) {
        where.push(`pr.rule_type = $${idx++}`);
        values.push(options.ruleType);
    }
    if (options.isActive !== undefined) {
        where.push(`pr.is_active = $${idx++}`);
        values.push(options.isActive);
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const countRes = await client.query(
        `SELECT COUNT(*) FROM price_rules pr ${whereClause}`,
        values,
    );

    const dataRes = await client.query(
        `SELECT pr.*,
                cg.name AS customer_group_name,
                pc.name AS category_name,
                p.name  AS product_name
         FROM price_rules pr
         LEFT JOIN customer_groups cg ON cg.id = pr.customer_group_id
         LEFT JOIN product_categories pc ON pc.id = pr.category_id
         LEFT JOIN products p ON p.id = pr.product_id
         ${whereClause}
         ORDER BY pr.priority DESC, pr.created_at DESC
         LIMIT $${idx} OFFSET $${idx + 1}`,
        [...values, options.limit, options.offset],
    );

    return {
        rows: dataRes.rows,
        total: parseInt(countRes.rows[0].count),
    };
}

// ============================================================================
// CORE: Resolve best price rule for a product + customer group
// ============================================================================
//
// Single optimised query that finds the best-matching rule:
//   1. Product-specific rule  (highest specificity)
//   2. Category-specific rule
//   3. Global rule            (category_id IS NULL AND product_id IS NULL)
//
// Within each scope, highest priority wins.
// Only returns active rules within their valid date range and quantity threshold.
// ============================================================================

export async function findApplicableRule(
    client: Pool | PoolClient,
    productId: string,
    customerGroupId: string,
    quantity: number,
    today: string,
): Promise<ResolvedPriceRuleRow | null> {
    const res = await client.query<ResolvedPriceRuleRow>(
        `SELECT
            pr.id                       AS rule_id,
            pr.name                     AS rule_name,
            pr.rule_type,
            pr.value::text              AS rule_value,
            CASE
                WHEN pr.product_id  IS NOT NULL THEN 'product'
                WHEN pr.category_id IS NOT NULL THEN 'category'
                ELSE 'global'
            END                         AS scope,
            pr.priority
         FROM price_rules pr
         WHERE pr.customer_group_id = $1
           AND pr.is_active = true
           AND pr.min_quantity <= $2
           AND (pr.valid_from  IS NULL OR pr.valid_from  <= $3::date)
           AND (pr.valid_until IS NULL OR pr.valid_until >= $3::date)
           AND (
               -- product-specific
               pr.product_id = $4
               -- category-specific (match product's category)
               OR pr.category_id = (SELECT category_id FROM products WHERE id = $4)
               -- global (no product, no category)
               OR (pr.product_id IS NULL AND pr.category_id IS NULL)
           )
         ORDER BY
            CASE
                WHEN pr.product_id  IS NOT NULL THEN 1
                WHEN pr.category_id IS NOT NULL THEN 2
                ELSE 3
            END,
            pr.priority DESC,
            pr.min_quantity DESC
         LIMIT 1`,
        [customerGroupId, quantity, today, productId],
    );

    return res.rows[0] ?? null;
}

// ============================================================================
// BULK: Resolve rules for many products in one query (for cart/order)
// ============================================================================

export async function findApplicableRulesBulk(
    client: Pool | PoolClient,
    productIds: string[],
    customerGroupId: string,
    quantity: number,
    today: string,
): Promise<Map<string, ResolvedPriceRuleRow>> {
    if (productIds.length === 0) return new Map();

    // Use DISTINCT ON to get best rule per product
    const res = await client.query<ResolvedPriceRuleRow & { target_product_id: string }>(
        `SELECT DISTINCT ON (target.product_id)
            target.product_id           AS target_product_id,
            pr.id                       AS rule_id,
            pr.name                     AS rule_name,
            pr.rule_type,
            pr.value::text              AS rule_value,
            CASE
                WHEN pr.product_id  IS NOT NULL THEN 'product'
                WHEN pr.category_id IS NOT NULL THEN 'category'
                ELSE 'global'
            END                         AS scope,
            pr.priority
         FROM unnest($1::uuid[]) AS target(product_id)
         JOIN products p ON p.id = target.product_id
         JOIN price_rules pr
           ON pr.customer_group_id = $2
          AND pr.is_active = true
          AND pr.min_quantity <= $3
          AND (pr.valid_from  IS NULL OR pr.valid_from  <= $4::date)
          AND (pr.valid_until IS NULL OR pr.valid_until >= $4::date)
          AND (
              pr.product_id = target.product_id
              OR pr.category_id = p.category_id
              OR (pr.product_id IS NULL AND pr.category_id IS NULL)
          )
         ORDER BY
            target.product_id,
            CASE
                WHEN pr.product_id  IS NOT NULL THEN 1
                WHEN pr.category_id IS NOT NULL THEN 2
                ELSE 3
            END,
            pr.priority DESC,
            pr.min_quantity DESC`,
        [productIds, customerGroupId, quantity, today],
    );

    const map = new Map<string, ResolvedPriceRuleRow>();
    for (const row of res.rows) {
        map.set(row.target_product_id, {
            rule_id: row.rule_id,
            rule_name: row.rule_name,
            rule_type: row.rule_type,
            rule_value: row.rule_value,
            scope: row.scope,
            priority: row.priority,
        });
    }
    return map;
}

// ============================================================================
// Helpers
// ============================================================================

export async function getProductBasePrice(
    client: Pool | PoolClient,
    productId: string,
): Promise<{ sellingPrice: string; costPrice: string; categoryId: string | null } | null> {
    const res = await client.query(
        `SELECT p.category_id,
                COALESCE(pv.selling_price, p.selling_price) AS selling_price,
                COALESCE(pv.cost_price, p.cost_price)       AS cost_price
         FROM products p
         LEFT JOIN product_valuation pv ON pv.product_id = p.id
         WHERE p.id = $1`,
        [productId],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
        categoryId: row.category_id ?? null,
        sellingPrice: row.selling_price,
        costPrice: row.cost_price,
    };
}

/** Valuation fields for AT_COST issue-cost pricing (FIFO FEFO preview / AVCO average). */
export async function getProductValuationForAtCost(
    client: Pool | PoolClient,
    productId: string,
): Promise<{
    sellingPrice: string;
    costPrice: string;
    categoryId: string | null;
    averageCost: string;
    costingMethod: string;
} | null> {
    const res = await client.query(
        `SELECT p.category_id,
                COALESCE(pv.selling_price, p.selling_price) AS selling_price,
                COALESCE(pv.cost_price, p.cost_price)       AS cost_price,
                COALESCE(pv.average_cost, 0)                AS average_cost,
                COALESCE(pv.costing_method, 'FIFO')         AS costing_method
         FROM products p
         LEFT JOIN product_valuation pv ON pv.product_id = p.id
         WHERE p.id = $1`,
        [productId],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
        categoryId: row.category_id ?? null,
        sellingPrice: row.selling_price,
        costPrice: row.cost_price,
        averageCost: row.average_cost,
        costingMethod: row.costing_method,
    };
}

export async function getCustomerGroupId(
    client: Pool | PoolClient,
    customerId: string,
): Promise<string | null> {
    const res = await client.query(
        `SELECT customer_group_id FROM customers WHERE id = $1`,
        [customerId],
    );
    return res.rows[0]?.customer_group_id ?? null;
}

export async function getGroupDiscountPercentage(
    client: Pool | PoolClient,
    customerGroupId: string,
): Promise<string | null> {
    const res = await client.query(
        `SELECT discount_percentage FROM customer_groups
         WHERE id = $1 AND is_active = TRUE`,
        [customerGroupId],
    );
    return res.rows[0]?.discount_percentage ?? null;
}

export async function getProductFormula(
    client: Pool | PoolClient,
    productId: string,
): Promise<string | null> {
    const res = await client.query(
        `SELECT pv.pricing_formula
         FROM products p
         LEFT JOIN product_valuation pv ON pv.product_id = p.id
         WHERE p.id = $1`,
        [productId],
    );
    return res.rows[0]?.pricing_formula ?? null;
}

// ============================================================================
// PRICE GROUPS — master table for pricing modes
// ============================================================================

export type PricingMode = 'STANDARD' | 'AT_COST';

export interface PriceGroupDbRow {
    id: string;
    name: string;
    pricing_mode: PricingMode;
    description: string | null;
    is_active: boolean;
    created_at: string;
    updated_at: string;
}

export function normalisePriceGroup(r: PriceGroupDbRow) {
    return {
        id: r.id,
        name: r.name,
        pricingMode: r.pricing_mode as PricingMode,
        description: r.description,
        isActive: r.is_active,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
    };
}

/**
 * Returns the pricing mode for a given customer (via their price_group_id).
 * Returns null when the customer has no price group → treat as STANDARD.
 */
export async function getCustomerPricingMode(
    client: Pool | PoolClient,
    customerId: string,
): Promise<PricingMode | null> {
    const res = await client.query(
        `SELECT pg.pricing_mode
         FROM customers c
         JOIN price_groups pg ON pg.id = c.price_group_id
         WHERE c.id = $1
           AND pg.is_active = TRUE`,
        [customerId],
    );
    return (res.rows[0]?.pricing_mode as PricingMode) ?? null;
}

export async function listPriceGroups(
    client: Pool | PoolClient,
    isActive?: boolean,
): Promise<PriceGroupDbRow[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (isActive !== undefined) {
        params.push(isActive);
        conditions.push(`is_active = $${params.length}`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const res = await client.query(
        `SELECT id, name, pricing_mode, description, is_active, created_at, updated_at
         FROM price_groups ${where}
         ORDER BY name`,
        params,
    );
    return res.rows;
}

export async function createPriceGroup(
    client: Pool | PoolClient,
    data: { name: string; pricingMode: PricingMode; description?: string },
): Promise<PriceGroupDbRow> {
    const res = await client.query(
        `INSERT INTO price_groups (name, pricing_mode, description)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [data.name, data.pricingMode, data.description ?? null],
    );
    return res.rows[0];
}

export async function updatePriceGroup(
    client: Pool | PoolClient,
    id: string,
    data: { name?: string; pricingMode?: PricingMode; description?: string | null; isActive?: boolean },
): Promise<PriceGroupDbRow | null> {
    const sets: string[] = ['updated_at = NOW()'];
    const values: unknown[] = [id];
    let idx = 2;
    if (data.name !== undefined) { sets.push(`name = $${idx++}`); values.push(data.name); }
    if (data.pricingMode !== undefined) { sets.push(`pricing_mode = $${idx++}`); values.push(data.pricingMode); }
    if (data.description !== undefined) { sets.push(`description = $${idx++}`); values.push(data.description); }
    if (data.isActive !== undefined) { sets.push(`is_active = $${idx++}`); values.push(data.isActive); }
    const res = await client.query(
        `UPDATE price_groups SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
        values,
    );
    return res.rows[0] ?? null;
}

export async function deletePriceGroup(
    client: Pool | PoolClient,
    id: string,
): Promise<void> {
    // Soft-delete: deactivate so existing customer links remain intact
    await client.query(
        `UPDATE price_groups SET is_active = FALSE, updated_at = NOW() WHERE id = $1`,
        [id],
    );
}

export async function priceGroupExistsActive(
    client: Pool | PoolClient,
    id: string,
): Promise<boolean> {
    const res = await client.query(
        `SELECT 1 FROM price_groups WHERE id = $1 AND is_active = TRUE`,
        [id],
    );
    return res.rows.length > 0;
}

// ============================================================================
// Entity existence checks (used by service-layer validation)
// ============================================================================

export interface CustomerGroupDbRow {
    id: string;
    name: string;
    description: string | null;
    discount_percentage: string;
    is_active: boolean;
}

export async function listCustomerGroups(
    client: Pool | PoolClient,
    isActive?: boolean,
): Promise<CustomerGroupDbRow[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (isActive !== undefined) {
        params.push(isActive);
        conditions.push(`is_active = $${params.length}`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const res = await client.query(
        `SELECT id, name, description, discount_percentage, is_active
         FROM customer_groups ${where}
         ORDER BY name`,
        params,
    );
    return res.rows;
}

export function normaliseCustomerGroup(r: CustomerGroupDbRow) {
    return {
        id: r.id,
        name: r.name,
        description: r.description,
        discountPercentage: Money.toNumber(Money.parseDb(r.discount_percentage)),
        isActive: r.is_active,
    };
}

export async function customerGroupExists(
    client: Pool | PoolClient,
    id: string,
): Promise<boolean> {
    const res = await client.query(`SELECT 1 FROM customer_groups WHERE id = $1`, [id]);
    return res.rows.length > 0;
}

export async function categoryExists(
    client: Pool | PoolClient,
    id: string,
): Promise<boolean> {
    const res = await client.query(`SELECT 1 FROM product_categories WHERE id = $1`, [id]);
    return res.rows.length > 0;
}

export async function productExists(
    client: Pool | PoolClient,
    id: string,
): Promise<boolean> {
    const res = await client.query(`SELECT 1 FROM products WHERE id = $1`, [id]);
    return res.rows.length > 0;
}

// ============================================================================
// Pricing tier helpers
// ============================================================================

export interface PricingTierRow {
    id: string;
    name: string | null;
    calculated_price: string;
    pricing_formula: string;
    min_quantity: string;
    max_quantity: string | null;
    customer_group_id: string | null;
    priority: number;
}

/**
 * Find the best matching pricing tier for a single product.
 * This is a direct tier-only query — it does NOT fall through
 * to group discount / formula / base price like calculatePrice() does.
 */
export async function findApplicableTier(
    client: Pool | PoolClient,
    productId: string,
    customerGroupId: string | null,
    quantity: number,
    today: string,
): Promise<PricingTierRow | null> {
    const res = await client.query<PricingTierRow>(
        `SELECT id, name, calculated_price, pricing_formula,
                min_quantity, max_quantity, customer_group_id, priority
         FROM pricing_tiers
         WHERE product_id = $1
           AND is_active = TRUE
           AND min_quantity <= $2
           AND (max_quantity IS NULL OR max_quantity >= $2)
           AND (customer_group_id = $3 OR customer_group_id IS NULL)
           AND (valid_from IS NULL OR valid_from <= $4::date)
           AND (valid_until IS NULL OR valid_until >= $4::date)
         ORDER BY
           CASE WHEN customer_group_id = $3 THEN 1 ELSE 2 END,
           priority DESC,
           min_quantity DESC
         LIMIT 1`,
        [productId, quantity, customerGroupId, today],
    );
    return res.rows[0] ?? null;
}

/**
 * Batch: find applicable tiers for many products at once.
 * Returns a Map of productId → PricingTierRow for products that have a matching tier.
 */
export async function findApplicableTiersBulk(
    client: Pool | PoolClient,
    productIds: string[],
    customerGroupId: string | null,
    quantity: number,
    today: string,
): Promise<Map<string, PricingTierRow>> {
    if (productIds.length === 0) return new Map();

    const res = await client.query<PricingTierRow & { product_id: string }>(
        `SELECT DISTINCT ON (pt.product_id)
            pt.product_id,
            pt.id, pt.name, pt.calculated_price, pt.pricing_formula,
            pt.min_quantity, pt.max_quantity, pt.customer_group_id, pt.priority
         FROM pricing_tiers pt
         WHERE pt.product_id = ANY($1)
           AND pt.is_active = TRUE
           AND pt.min_quantity <= $2
           AND (pt.max_quantity IS NULL OR pt.max_quantity >= $2)
           AND (pt.customer_group_id = $3 OR pt.customer_group_id IS NULL)
           AND (pt.valid_from IS NULL OR pt.valid_from <= $4::date)
           AND (pt.valid_until IS NULL OR pt.valid_until >= $4::date)
         ORDER BY
            pt.product_id,
            CASE WHEN pt.customer_group_id = $3 THEN 1 ELSE 2 END,
            pt.priority DESC,
            pt.min_quantity DESC`,
        [productIds, quantity, customerGroupId, today],
    );

    const map = new Map<string, PricingTierRow>();
    for (const row of res.rows) {
        map.set(row.product_id, {
            id: row.id,
            name: row.name,
            calculated_price: row.calculated_price,
            pricing_formula: row.pricing_formula,
            min_quantity: row.min_quantity,
            max_quantity: row.max_quantity,
            customer_group_id: row.customer_group_id,
            priority: row.priority,
        });
    }
    return map;
}

// ============================================================================
// Bulk helpers (for getFinalPricesBulk batching)
// ============================================================================

export async function getProductBasePricesBulk(
    client: Pool | PoolClient,
    productIds: string[],
): Promise<Map<string, { sellingPrice: string; costPrice: string; categoryId: string | null }>> {
    if (productIds.length === 0) return new Map();
    const res = await client.query(
        `SELECT p.id,
                p.category_id,
                COALESCE(pv.selling_price, p.selling_price) AS selling_price,
                COALESCE(pv.cost_price, p.cost_price)       AS cost_price
         FROM products p
         LEFT JOIN product_valuation pv ON pv.product_id = p.id
         WHERE p.id = ANY($1)`,
        [productIds],
    );
    const map = new Map<string, { sellingPrice: string; costPrice: string; categoryId: string | null }>();
    for (const row of res.rows) {
        map.set(row.id, {
            sellingPrice: row.selling_price,
            costPrice: row.cost_price,
            categoryId: row.category_id,
        });
    }
    return map;
}

export async function getProductValuationForAtCostBulk(
    client: Pool | PoolClient,
    productIds: string[],
): Promise<Map<string, {
    sellingPrice: string;
    costPrice: string;
    categoryId: string | null;
    averageCost: string;
    costingMethod: string;
}>> {
    if (productIds.length === 0) return new Map();
    const res = await client.query(
        `SELECT p.id,
                p.category_id,
                COALESCE(pv.selling_price, p.selling_price) AS selling_price,
                COALESCE(pv.cost_price, p.cost_price)       AS cost_price,
                COALESCE(pv.average_cost, 0)                AS average_cost,
                COALESCE(pv.costing_method, 'FIFO')         AS costing_method
         FROM products p
         LEFT JOIN product_valuation pv ON pv.product_id = p.id
         WHERE p.id = ANY($1)`,
        [productIds],
    );
    const map = new Map<string, {
        sellingPrice: string;
        costPrice: string;
        categoryId: string | null;
        averageCost: string;
        costingMethod: string;
    }>();
    for (const row of res.rows) {
        map.set(row.id, {
            sellingPrice: row.selling_price,
            costPrice: row.cost_price,
            categoryId: row.category_id,
            averageCost: row.average_cost,
            costingMethod: row.costing_method,
        });
    }
    return map;
}
