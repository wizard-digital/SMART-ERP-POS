/**
 * AT_COST / allocated-issue cost from the same FEFO lot selection as sale deduction.
 *
 * Naming (do not conflate):
 * - product_valuation.costing_method `FIFO` = use batch/layer carrying (vs AVCO/STANDARD).
 * - Physical issue order is always SelectionPolicy `FEFO` (expiry → received → lotNumber),
 *   matching lotService.consumeLot / salesService / warehouseSaleDeductionService.
 *
 * REGRESSION: atCostIssuePrice.test.ts + npm run test:at-cost-regression
 * CONTRACT: AT_COST_FIFO_INTEGRITY.md
 */
import type { Pool, PoolClient } from 'pg';
import Decimal from 'decimal.js';
import { Money } from '../../utils/money.js';
import logger from '../../utils/logger.js';
import { getBusinessDate } from '../../utils/dateRange.js';
import { loadGlobalSelectableLots } from '../inventory-lot/postgresLotSelector.js';
import { selectLots, type SelectableLot } from '@shared/inventory-lot/index.js';

export type CostingMethod = 'FIFO' | 'AVCO' | 'STANDARD';

export interface ProductValuationForAtCost {
    sellingPrice: string;
    costPrice: string;
    averageCost: string;
    costingMethod: CostingMethod;
}

/** Lot rows for issue preview — same shape after load as deduction selectors. */
export interface SaleFefoBatchRow {
    id: string;
    remaining_quantity: string;
    cost_price: string;
    expiry_date?: string | null;
}

export interface LoadSaleFefoBatchesOptions {
    /** Matches products.min_days_before_expiry_sale — same filter as sale deduction. */
    minDaysBeforeExpiry?: number;
    forUpdate?: boolean;
}

const MAX_SELLING_FACTOR_QUERY = `
    SELECT COALESCE(MAX(pu.conversion_factor), 1)::text AS max_factor
    FROM product_uoms pu
    WHERE pu.product_id = $1 AND pu.conversion_factor > 1`;

export type FefoBatchRow = { remaining_quantity: string; cost_price: string };

/**
 * Opening-balance / legacy imports sometimes store batch remaining_quantity in selling units
 * (e.g. 1 strip + 2 strips) with cost_price per strip, while FEFO expects base units.
 */
export function normalizeLegacyFefoBatchRows(
    rows: FefoBatchRow[],
    requestedBaseQty: Decimal,
    sellingFactor: number,
    masterCostPerBase: Decimal,
): FefoBatchRow[] {
    if (sellingFactor <= 1 || rows.length === 0) return rows;

    const totalRemaining = rows.reduce(
        (s, r) => s.plus(new Decimal(r.remaining_quantity)),
        new Decimal(0),
    );
    if (totalRemaining.lessThanOrEqualTo(0)) return rows;

    const requestedSellingQty = requestedBaseQty.dividedBy(sellingFactor);
    const qtyTolerance = new Decimal(0.001);
    const remainingMatchesSellingQty = totalRemaining
        .minus(requestedSellingQty)
        .abs()
        .lessThanOrEqualTo(qtyTolerance);
    const baseWouldBeShort = totalRemaining.lessThan(requestedBaseQty.times(0.5));

    const hasSellingUnitCost = rows.some((r) => {
        const cost = new Decimal(r.cost_price);
        if (masterCostPerBase.greaterThan(0)) {
            return cost.greaterThan(masterCostPerBase.times(sellingFactor));
        }
        return cost.greaterThan(new Decimal(1000).times(sellingFactor));
    });

    if (!remainingMatchesSellingQty || !baseWouldBeShort || !hasSellingUnitCost) {
        return rows;
    }

    logger.info('[AT_COST] Normalizing legacy selling-unit batch rows to base units for FEFO', {
        sellingFactor,
        totalRemaining: totalRemaining.toFixed(4),
        requestedBaseQty: requestedBaseQty.toFixed(4),
    });

    return rows.map((r) => {
        const rem = new Decimal(r.remaining_quantity);
        const cost = new Decimal(r.cost_price);
        const costPerBase = cost.dividedBy(sellingFactor);

        return {
            remaining_quantity: rem.times(sellingFactor).toFixed(4),
            cost_price: Money.toNumber(Money.round(costPerBase)).toString(),
        };
    });
}

async function getProductMaxSellingFactor(conn: Pool | PoolClient, productId: string): Promise<number> {
    const res = await conn.query<{ max_factor: string }>(MAX_SELLING_FACTOR_QUERY, [productId]);
    const factor = Number(res.rows[0]?.max_factor ?? 1);
    return factor > 1 ? factor : 1;
}

function applyLegacyNormalizeToLots(
    lots: SelectableLot[],
    requestedBaseQty: Decimal,
    sellingFactor: number,
    masterCostPerBase: Decimal,
): SelectableLot[] {
    const normalized = normalizeLegacyFefoBatchRows(
        lots.map((l) => ({
            remaining_quantity: String(l.remainingQuantity),
            cost_price: String(l.costPrice),
        })),
        requestedBaseQty,
        sellingFactor,
        masterCostPerBase,
    );
    return lots.map((lot, i) => ({
        ...lot,
        remainingQuantity: Number(normalized[i]?.remaining_quantity ?? lot.remainingQuantity),
        costPrice: Number(normalized[i]?.cost_price ?? lot.costPrice),
    }));
}

/**
 * Load selectable lots for issue cost — same selector as sale deduction.
 * No minDays=0 fallback (deduction has none). Order finalized by selectLots(FEFO).
 */
export async function loadSaleFefoBatchesForIssue(
    conn: Pool | PoolClient,
    productId: string,
    requestedBaseQty: Decimal,
    masterCostPerBase: Decimal,
    options: LoadSaleFefoBatchesOptions = {},
): Promise<SaleFefoBatchRow[]> {
    const minDays = options.minDaysBeforeExpiry ?? 0;
    const lots = await loadSelectableLotsForIssuePreview(
        conn,
        productId,
        requestedBaseQty,
        masterCostPerBase,
        { minDaysBeforeExpiry: minDays, forUpdate: options.forUpdate },
    );
    return lots.map((lot) => ({
        id: lot.lotId,
        remaining_quantity: String(lot.remainingQuantity),
        cost_price: String(lot.costPrice),
        expiry_date: lot.expiryDate ?? null,
    }));
}

async function loadSelectableLotsForIssuePreview(
    conn: Pool | PoolClient,
    productId: string,
    requestedBaseQty: Decimal,
    masterCostPerBase: Decimal,
    options: LoadSaleFefoBatchesOptions = {},
): Promise<SelectableLot[]> {
    const minDays = options.minDaysBeforeExpiry ?? 0;
    const selectable = await loadGlobalSelectableLots(conn as PoolClient, productId, {
        forUpdate: options.forUpdate,
        minDaysBeforeExpiry: minDays,
    });
    const sellingFactor = await getProductMaxSellingFactor(conn, productId);
    return applyLegacyNormalizeToLots(
        selectable,
        requestedBaseQty,
        sellingFactor,
        masterCostPerBase,
    );
}

/**
 * Single FEFO walk for COGS / AT_COST / below-cost — same selectLots policy as consumeLot.
 */
function allocateFefoIssue(
    lots: SelectableLot[],
    baseQty: Decimal,
    minDaysBeforeExpiry: number,
) {
    return selectLots({
        policy: 'FEFO',
        lots,
        quantity: baseQty.toNumber(),
        businessDate: getBusinessDate(),
        minDaysBeforeExpirySale: minDaysBeforeExpiry,
    });
}

export interface FefoIssuePreview {
    totalCost: Decimal;
    coveredQty: Decimal;
    shortfall: Decimal;
}

/** One FEFO consumption segment at a single batch unit cost. */
export interface FefoIssueLayerSegment {
    baseQuantity: number;
    unitCostPerBase: number;
    totalCost: number;
}

/** Walk lots in FEFO order via selectLots (same as salesService physical deduction). */
export async function previewFefoIssueCostForBaseQty(
    conn: Pool | PoolClient,
    productId: string,
    baseQty: Decimal | number,
    masterCostPerBase: Decimal | number = new Decimal(0),
    options: LoadSaleFefoBatchesOptions = {},
): Promise<FefoIssuePreview> {
    const qty = baseQty instanceof Decimal ? baseQty : new Decimal(baseQty);
    const master =
      masterCostPerBase instanceof Decimal ? masterCostPerBase : new Decimal(masterCostPerBase);
    const minDays = options.minDaysBeforeExpiry ?? 0;
    const lots = await loadSelectableLotsForIssuePreview(conn, productId, qty, master, {
        minDaysBeforeExpiry: minDays,
        forUpdate: options.forUpdate,
    });
    const plan = allocateFefoIssue(lots, qty, minDays);
    return {
        totalCost: new Decimal(plan.totalCost),
        coveredQty: new Decimal(plan.totalAllocated),
        shortfall: plan.shortfall > 0 ? new Decimal(plan.shortfall) : new Decimal(0),
    };
}

/**
 * FEFO layer walk — one segment per batch cost consumed (e.g. 1@20000 + 1@18000).
 */
export async function previewFefoIssueLayers(
    conn: Pool | PoolClient,
    productId: string,
    baseQty: Decimal | number,
    masterCostPerBase: Decimal | number = new Decimal(0),
    options: LoadSaleFefoBatchesOptions = {},
): Promise<FefoIssueLayerSegment[]> {
    const qty = baseQty instanceof Decimal ? baseQty : new Decimal(baseQty);
    const master =
      masterCostPerBase instanceof Decimal ? masterCostPerBase : new Decimal(masterCostPerBase);
    const minDays = options.minDaysBeforeExpiry ?? 0;
    const lots = await loadSelectableLotsForIssuePreview(conn, productId, qty, master, {
        minDaysBeforeExpiry: minDays,
        forUpdate: options.forUpdate,
    });
    const plan = allocateFefoIssue(lots, qty, minDays);
    return plan.layers.map((layer) => ({
        baseQuantity: Money.toNumber(new Decimal(layer.quantity)),
        unitCostPerBase: Money.toNumber(Money.round(new Decimal(layer.costPrice))),
        totalCost: Money.toNumber(
            Money.round(new Decimal(layer.quantity).times(layer.costPrice)),
        ),
    }));
}

function fallbackUnitCost(valuation: ProductValuationForAtCost): Decimal {
    const avg = Money.parseDb(valuation.averageCost);
    const master = Money.parseDb(valuation.costPrice);
    return avg.greaterThan(0) ? avg : master;
}

/**
 * Resolved AT_COST price per base unit for the requested base quantity.
 * costing_method FIFO → FEFO layer walk; AVCO/STANDARD → average/master.
 */
export async function resolveAtCostWithLayers(
    conn: Pool | PoolClient,
    productId: string,
    baseQuantity: number,
    valuation: ProductValuationForAtCost,
): Promise<{
    unitPricePerBase: number;
    ruleName: string;
    layers: FefoIssueLayerSegment[];
}> {
    const method = (valuation.costingMethod || 'FIFO') as CostingMethod;
    const masterCost = Money.parseDb(valuation.costPrice);
    const baseQty = new Decimal(baseQuantity);

    if (method === 'AVCO' || method === 'STANDARD') {
        const unit = fallbackUnitCost(valuation);
        const unitNum = Money.toNumber(Money.round(unit));
        const label = method === 'AVCO' ? 'At Cost (average)' : 'At Cost (standard)';
        const qty = Math.max(baseQuantity, 0);
        return {
            unitPricePerBase: unitNum,
            ruleName: label,
            layers:
                qty > 0
                    ? [{ baseQuantity: qty, unitCostPerBase: unitNum, totalCost: Money.toNumber(unit.times(baseQty)) }]
                    : [],
        };
    }

    if (baseQty.lessThanOrEqualTo(0)) {
        const unitNum = Money.toNumber(Money.round(masterCost));
        return {
            unitPricePerBase: unitNum,
            ruleName: 'At Cost (FIFO issue)',
            layers: [],
        };
    }

    let segments = await previewFefoIssueLayers(conn, productId, baseQty, masterCost);
    const covered = segments.reduce((s, l) => s + l.baseQuantity, 0);
    const shortfall = baseQuantity - covered;

    if (shortfall > 0.001) {
        const shortfallUnit = Money.toNumber(fallbackUnitCost(valuation));
        segments = [
            ...segments,
            {
                baseQuantity: shortfall,
                unitCostPerBase: shortfallUnit,
                totalCost: Money.toNumber(new Decimal(shortfall).times(shortfallUnit)),
            },
        ];
        logger.warn('[AT_COST] FEFO batches insufficient for layer preview — shortfall segment added', {
            productId,
            requestedBaseQty: baseQty.toFixed(4),
            shortfall: shortfall.toFixed(4),
        });
    }

    const totalCost = segments.reduce((s, l) => s + l.totalCost, 0);
    const perBase = baseQty.greaterThan(0)
        ? Money.toNumber(Money.round(new Decimal(totalCost).dividedBy(baseQty)))
        : Money.toNumber(Money.round(masterCost));

    return {
        unitPricePerBase: perBase,
        // Valuation method name (FIFO); physical walk is FEFO selectLots.
        ruleName: 'At Cost (FIFO issue)',
        layers: segments,
    };
}

export async function resolveAtCostPerBaseUnit(
    conn: Pool | PoolClient,
    productId: string,
    baseQuantity: number,
    valuation: ProductValuationForAtCost,
): Promise<{ unitPricePerBase: number; ruleName: string }> {
    const resolved = await resolveAtCostWithLayers(conn, productId, baseQuantity, valuation);
    return {
        unitPricePerBase: resolved.unitPricePerBase,
        ruleName: resolved.ruleName,
    };
}
