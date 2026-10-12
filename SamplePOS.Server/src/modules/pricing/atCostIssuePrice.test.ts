/**
 * AT_COST FIFO issue-cost preview — blended layer cost per base unit.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import Decimal from 'decimal.js';
import {
    previewFefoIssueCostForBaseQty,
    previewFefoIssueLayers,
    resolveAtCostPerBaseUnit,
    resolveAtCostWithLayers,
    normalizeLegacyFefoBatchRows,
    type ProductValuationForAtCost,
} from './atCostIssuePrice.js';

type MockQuery = (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, string>> }>;

describe('atCostIssuePrice', () => {
    let mockQuery: jest.Mock<MockQuery>;

    beforeEach(() => {
        mockQuery = jest.fn<MockQuery>();
    });

    const pool = { query: (...args: unknown[]) => mockQuery(args[0] as string, args[1] as unknown[]) } as never;

    function mockFefoOnly(rows: Array<Record<string, string>>) {
        mockQuery.mockImplementation(async (sql: string) => {
            if (sql.includes('product_uoms')) {
                return { rows: [{ max_factor: '1' }] };
            }
            // postgresLotSelector.loadGlobalSelectableLots needs identity columns for FEFO tie-break
            return {
                rows: rows.map((r, i) => ({
                    id: r.id ?? `lot-${i + 1}`,
                    batch_number: r.batch_number ?? `B${i + 1}`,
                    product_id: 'product-1',
                    received_date: r.received_date ?? '2026-01-01',
                    created_at: r.created_at ?? '2026-01-01',
                    expiry_date: r.expiry_date ?? null,
                    ...r,
                })),
            };
        });
    }

    it('previewFefoIssueCostForBaseQty blends FEFO layers (10@110 + 10@125 → 11,000 / 20)', async () => {
        mockFefoOnly([
            { remaining_quantity: '10', cost_price: '110' },
            { remaining_quantity: '10', cost_price: '125' },
        ]);

        const preview = await previewFefoIssueCostForBaseQty(pool, 'product-1', new Decimal(20));
        expect(preview.totalCost.toNumber()).toBe(2350);
        expect(preview.coveredQty.toNumber()).toBe(20);
        expect(preview.shortfall.toNumber()).toBe(0);
    });

    it('resolveAtCostPerBaseUnit returns blended FIFO issue cost per base (2350/20 → 118 UGX)', async () => {
        mockFefoOnly([
            { remaining_quantity: '10', cost_price: '110' },
            { remaining_quantity: '10', cost_price: '125' },
        ]);

        const valuation: ProductValuationForAtCost = {
            sellingPrice: '1500',
            costPrice: '1250',
            averageCost: '0',
            costingMethod: 'FIFO',
        };

        const result = await resolveAtCostPerBaseUnit(pool, 'product-1', 20, valuation);
        // 2350/20 = 117.5 at Money 2dp (FEFO layer total ÷ base qty)
        expect(result.unitPricePerBase).toBe(117.5);
        expect(result.ruleName).toBe('At Cost (FIFO issue)');
    });

    it('previewFefoIssueLayers returns separate segments per batch cost (20k + 18k)', async () => {
        mockFefoOnly([
            { remaining_quantity: '1', cost_price: '20000' },
            { remaining_quantity: '1', cost_price: '18000' },
        ]);

        const layers = await previewFefoIssueLayers(pool, 'product-1', new Decimal(2));
        expect(layers).toHaveLength(2);
        expect(layers[0]).toMatchObject({ baseQuantity: 1, unitCostPerBase: 20000 });
        expect(layers[1]).toMatchObject({ baseQuantity: 1, unitCostPerBase: 18000 });
    });

    it('resolveAtCostWithLayers exposes layers and blended per-base (38k/2 → 19k)', async () => {
        mockFefoOnly([
            { remaining_quantity: '1', cost_price: '20000' },
            { remaining_quantity: '1', cost_price: '18000' },
        ]);

        const valuation: ProductValuationForAtCost = {
            sellingPrice: '25000',
            costPrice: '19000',
            averageCost: '0',
            costingMethod: 'FIFO',
        };

        const result = await resolveAtCostWithLayers(pool, 'product-1', 2, valuation);
        expect(result.layers).toHaveLength(2);
        expect(result.unitPricePerBase).toBe(19000);
    });

    it('resolveAtCostPerBaseUnit uses average for AVCO', async () => {
        const valuation: ProductValuationForAtCost = {
            sellingPrice: '1500',
            costPrice: '1250',
            averageCost: '800',
            costingMethod: 'AVCO',
        };

        const result = await resolveAtCostPerBaseUnit(pool, 'product-1', 5, valuation);
        expect(result.unitPricePerBase).toBe(800);
        expect(result.ruleName).toBe('At Cost (average)');
        expect(mockQuery).not.toHaveBeenCalled();
    });

    it('normalizeLegacyFefoBatchRows converts strip batches to base (Ozempic pattern)', () => {
        const rows = [
            { remaining_quantity: '1', cost_price: '1600000' },
            { remaining_quantity: '2', cost_price: '1150000' },
        ];
        const normalized = normalizeLegacyFefoBatchRows(
            rows,
            new Decimal(30),
            10,
            new Decimal(130000),
        );
        expect(normalized[0]).toMatchObject({ remaining_quantity: '10.0000', cost_price: '160000' });
        expect(normalized[1]).toMatchObject({ remaining_quantity: '20.0000', cost_price: '115000' });
    });

    it('previewFefoIssueLayers splits legacy strip batches for 3-strip AT_COST sale', async () => {
        mockQuery.mockImplementation(async (sql: string) => {
            if (sql.includes('product_uoms')) {
                return { rows: [{ max_factor: '10' }] };
            }
            return {
                rows: [
                    {
                        id: 'l1',
                        batch_number: 'A',
                        product_id: 'ozempic',
                        remaining_quantity: '1',
                        cost_price: '1600000',
                        expiry_date: null,
                        received_date: '2026-01-01',
                        created_at: '2026-01-01',
                    },
                    {
                        id: 'l2',
                        batch_number: 'B',
                        product_id: 'ozempic',
                        remaining_quantity: '2',
                        cost_price: '1150000',
                        expiry_date: null,
                        received_date: '2026-01-02',
                        created_at: '2026-01-02',
                    },
                ],
            };
        });

        const layers = await previewFefoIssueLayers(
            pool,
            'ozempic',
            new Decimal(30),
            new Decimal(130000),
        );
        expect(layers).toHaveLength(2);
        expect(layers[0]).toMatchObject({ baseQuantity: 10, unitCostPerBase: 160000, totalCost: 1600000 });
        expect(layers[1]).toMatchObject({ baseQuantity: 20, unitCostPerBase: 115000, totalCost: 2300000 });
    });

    it('resolveAtCostWithLayers returns 130000 per base for 3-strip Ozempic FEFO blend', async () => {
        mockQuery.mockImplementation(async (sql: string) => {
            if (sql.includes('product_uoms')) {
                return { rows: [{ max_factor: '10' }] };
            }
            return {
                rows: [
                    {
                        id: 'l1',
                        batch_number: 'A',
                        product_id: 'ozempic',
                        remaining_quantity: '1',
                        cost_price: '1600000',
                        expiry_date: null,
                        received_date: '2026-01-01',
                        created_at: '2026-01-01',
                    },
                    {
                        id: 'l2',
                        batch_number: 'B',
                        product_id: 'ozempic',
                        remaining_quantity: '2',
                        cost_price: '1150000',
                        expiry_date: null,
                        received_date: '2026-01-02',
                        created_at: '2026-01-02',
                    },
                ],
            };
        });

        const valuation: ProductValuationForAtCost = {
            sellingPrice: '1700000',
            costPrice: '130000',
            averageCost: '130000',
            costingMethod: 'FIFO',
        };

        const result = await resolveAtCostWithLayers(pool, 'ozempic', 30, valuation);
        expect(result.unitPricePerBase).toBe(130000);
        expect(result.layers).toHaveLength(2);
    });

    it('FEFO tie-break uses lotNumber — same order as selectLots / consumeLot', async () => {
        mockFefoOnly([
            {
                id: 'late',
                batch_number: 'Z-LOT',
                remaining_quantity: '1',
                cost_price: '100',
                expiry_date: '2099-06-01',
                received_date: '2026-01-01',
            },
            {
                id: 'early',
                batch_number: 'A-LOT',
                remaining_quantity: '1',
                cost_price: '200',
                expiry_date: '2099-06-01',
                received_date: '2026-01-01',
            },
        ]);

        const layers = await previewFefoIssueLayers(pool, 'product-1', new Decimal(1));
        // Equal expiry+received → A-LOT before Z-LOT → cost 200 first
        expect(layers).toHaveLength(1);
        expect(layers[0].unitCostPerBase).toBe(200);
    });
});
