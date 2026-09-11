/**
 * pricingEngineService — AT_COST override (FIFO issue cost per base unit)
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

type MockFn = (...args: unknown[]) => Promise<unknown>;

const mockGetCustomerPricingMode = jest.fn<MockFn>();
const mockGetProductBasePrice = jest.fn<MockFn>();
const mockGetProductValuationForAtCost = jest.fn<MockFn>();
const mockResolveAtCostWithLayers = jest.fn<MockFn>();
const mockGetCustomerGroupId = jest.fn<MockFn>();
const mockFindApplicableTier = jest.fn<MockFn>();
const mockFindApplicableRule = jest.fn<MockFn>();
const mockGetGroupDiscountPercentage = jest.fn<MockFn>();
const mockGetProductFormula = jest.fn<MockFn>();

jest.unstable_mockModule('./atCostIssuePrice.js', () => ({
    resolveAtCostWithLayers: mockResolveAtCostWithLayers,
    resolveAtCostPerBaseUnit: jest.fn<MockFn>(),
    previewFefoIssueCostForBaseQty: jest.fn<MockFn>(),
    previewFefoIssueLayers: jest.fn<MockFn>(),
}));

jest.unstable_mockModule('./pricingRepository.js', () => ({
    getCustomerPricingMode: mockGetCustomerPricingMode,
    getProductBasePrice: mockGetProductBasePrice,
    getProductValuationForAtCost: mockGetProductValuationForAtCost,
    getProductValuationForAtCostBulk: jest.fn<MockFn>(),
    getCustomerGroupId: mockGetCustomerGroupId,
    findApplicableTier: mockFindApplicableTier,
    findApplicableRule: mockFindApplicableRule,
    getGroupDiscountPercentage: mockGetGroupDiscountPercentage,
    getProductFormula: mockGetProductFormula,
    findApplicableTiersBulk: jest.fn<MockFn>(),
    findApplicableRulesBulk: jest.fn<MockFn>(),
    getProductBasePricesBulk: jest.fn<MockFn>(),
    listCustomerGroups: jest.fn<MockFn>(),
    listCategories: jest.fn<MockFn>(),
    normalisePriceRule: jest.fn(),
    normaliseProductCategory: jest.fn(),
}));

jest.unstable_mockModule('../../services/pricingService.js', () => ({
    evaluateFormula: jest.fn<MockFn>(),
}));

jest.unstable_mockModule('../../middleware/errorHandler.js', () => ({
    NotFoundError: class extends Error {
        constructor(msg: string) {
            super(`${msg} not found`);
            this.name = 'NotFoundError';
        }
    },
    ConflictError: class extends Error {},
    ValidationError: class extends Error {},
}));

jest.unstable_mockModule('../../utils/dateRange.js', () => ({
    getBusinessDate: () => '2026-05-21',
}));

const { getFinalPrice } = await import('./pricingEngineService.js');

const pool = {} as never;

describe('getFinalPrice — AT_COST', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockGetCustomerPricingMode.mockResolvedValue('AT_COST');
        mockGetProductValuationForAtCost.mockResolvedValue({
            sellingPrice: '1000.00',
            costPrice: '650.00',
            averageCost: '0',
            costingMethod: 'FIFO',
            categoryId: null,
        });
        mockResolveAtCostWithLayers.mockResolvedValue({
            unitPricePerBase: 550,
            ruleName: 'At Cost (FIFO issue)',
            layers: [{ baseQuantity: 20, unitCostPerBase: 550, totalCost: 11000 }],
        });
    });

    it('returns FIFO issue cost as finalPrice and skips tiers/rules', async () => {
        const result = await getFinalPrice('product-1', 'customer-1', undefined, 2, pool, 20);

        expect(result.finalPrice).toBe(550);
        expect(result.basePrice).toBe(1000);
        expect(result.appliedRule.scope).toBe('at_cost');
        expect(result.appliedRule.ruleName).toBe('At Cost (FIFO issue)');
        expect(mockResolveAtCostWithLayers).toHaveBeenCalledWith(
            pool,
            'product-1',
            20,
            expect.objectContaining({ costingMethod: 'FIFO' }),
        );
        expect(result.atCostLayers).toHaveLength(1);
        expect(mockFindApplicableTier).not.toHaveBeenCalled();
        expect(mockFindApplicableRule).not.toHaveBeenCalled();
        expect(mockGetGroupDiscountPercentage).not.toHaveBeenCalled();
    });

    it('STANDARD customer still resolves customer group for rules', async () => {
        mockGetCustomerPricingMode.mockResolvedValue(null);
        mockGetCustomerGroupId.mockResolvedValue('group-retail');
        mockGetProductBasePrice.mockResolvedValue({
            sellingPrice: '1000.00',
            costPrice: '650.00',
            categoryId: null,
        });
        mockFindApplicableTier.mockResolvedValue(null);
        mockFindApplicableRule.mockResolvedValue(null);
        mockGetGroupDiscountPercentage.mockResolvedValue(null);
        mockGetProductFormula.mockResolvedValue(null);

        const result = await getFinalPrice('product-1', 'customer-2', undefined, 1, pool);

        expect(result.finalPrice).toBe(1000);
        expect(result.appliedRule.scope).toBe('base');
        expect(mockGetCustomerGroupId).toHaveBeenCalledWith(pool, 'customer-2');
        expect(mockResolveAtCostWithLayers).not.toHaveBeenCalled();
    });
});
