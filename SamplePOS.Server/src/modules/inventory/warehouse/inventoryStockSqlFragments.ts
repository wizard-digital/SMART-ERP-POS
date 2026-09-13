import { poItemOpenQuantitySql } from '../../purchase-orders/purchaseOrderNetReceived.js';

/** JSON aggregate of product UoMs — shared by legacy and multistore stock-level queries. */
export function productUomsJsonSql(productAlias = 'p', valuationAlias = 'pv'): string {
    return `COALESCE(
         (
           SELECT json_agg(
             json_build_object(
               'uomId', pu.uom_id,
               'name', u.name,
               'symbol', u.symbol,
               'conversionFactor', pu.conversion_factor,
               'isDefault', pu.is_default,
               'price', COALESCE(pu.price_override, ${valuationAlias}.selling_price * pu.conversion_factor),
               'cost', COALESCE(
                 pu.cost_override,
                 CASE
                   WHEN pu.price_override IS NOT NULL AND ${valuationAlias}.selling_price > 0
                   THEN ROUND(
                     (COALESCE(NULLIF(${valuationAlias}.average_cost, 0), ${valuationAlias}.cost_price)::numeric / ${valuationAlias}.selling_price::numeric)
                     * pu.price_override::numeric,
                     2
                   )
                   ELSE COALESCE(NULLIF(${valuationAlias}.average_cost, 0), ${valuationAlias}.cost_price) * pu.conversion_factor
                 END
               ),
               'priceIsOverridden', (pu.price_override IS NOT NULL),
               'computedPrice', (${valuationAlias}.selling_price * pu.conversion_factor)
             )
           )
           FROM product_uoms pu
           JOIN uoms u ON pu.uom_id = u.id
           WHERE pu.product_id = ${productAlias}.id
         ),
         (
           SELECT json_build_array(
             json_build_object(
               'uomId', u.id,
               'name', u.name,
               'symbol', u.symbol,
               'conversionFactor', 1,
               'isDefault', true,
               'price', ${valuationAlias}.selling_price,
               'cost', COALESCE(NULLIF(${valuationAlias}.average_cost, 0), ${valuationAlias}.cost_price),
               'priceIsOverridden', false,
               'computedPrice', ${valuationAlias}.selling_price
             )
           )
           FROM uoms u
           WHERE u.id = ${productAlias}.base_uom_id
         )
       )`;
}

/** Open PO qty subquery join fragment */
export function openPurchaseOrdersJoinSql(): string {
    return `LEFT JOIN (
         SELECT poi.product_id,
                SUM(${poItemOpenQuantitySql('poi')}) as qty_on_order
         FROM purchase_order_items poi
         JOIN purchase_orders po ON po.id = poi.purchase_order_id
         WHERE po.status = 'PENDING'
           AND ${poItemOpenQuantitySql('poi')} > 0
         GROUP BY poi.product_id
       ) po_agg ON po_agg.product_id = p.id`;
}

/** Store scope predicate for POS selling stock (parameterized: $N = store UUID). */
export function posSellingStoreFilterSql(storeParamRef: string): string {
    return `sl.is_active = true
        AND sl.id = ${storeParamRef}`;
}

/** Store scope when no explicit selling store is configured yet. */
export const POS_SELLING_STORE_FALLBACK_FILTER_SQL = `sl.is_active = true
        AND sl.store_type = 'SELLING'`;

/** Inventory worklist company total: MAIN warehouse + selling shops. Not quarantine. Not POS-only. */
export const OPERATIONAL_NETWORK_STORE_FILTER_SQL = `sl.is_active = true
        AND sl.store_type IN ('MAIN', 'SELLING')`;

/** Lot + balance eligibility for sellable stock (correlated to products.min_days_before_expiry_sale). */
export const SELLABLE_LOT_PREDICATE_SQL = `pl.status = 'ACTIVE'
        AND NOT ib.blocked
        AND ib.quantity_on_hand > 0
        AND (pl.expiry_date IS NULL OR pl.expiry_date > CURRENT_DATE)
        AND (
          pl.expiry_date IS NULL
          OR pl.expiry_date > CURRENT_DATE + COALESCE(p2.min_days_before_expiry_sale, 0) * INTERVAL '1 day'
        )`;
