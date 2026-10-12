import type { PoolClient } from 'pg';
import Decimal from 'decimal.js';
import { BusinessError } from '../../../middleware/errorHandler.js';
import { Money } from '../../../utils/money.js';
import { getBusinessDate } from '../../../utils/dateRange.js';
import { syncProductQuantity } from '../../../utils/inventorySync.js';
import { posProductSearchService } from './posProductSearchService.js';
import { previewMultistoreBalancesForAllocation } from './posAllocationLockRepository.js';
import { storeLocationRepository } from './storeLocationRepository.js';
import { lotService } from '../../inventory-lot/lotService.js';
import { loadStoreSelectableLots } from '../../inventory-lot/postgresLotSelector.js';
import { selectLots } from '@shared/inventory-lot/index.js';
import { allocateNextMovementNumber } from '../../../utils/documentNumberAllocation.js';
import { getProductMinDaysBeforeExpirySale } from '../../products/productExpirySaleDays.js';

export interface MultistoreSaleDeductionResult {
    storeLocationId: string;
    primaryProductLotId: string | null;
    primaryBatchId: string | null;
    actualBatchCost: Decimal;
    movementCount: number;
    /** @deprecated Sequence allocation is via nextval; retained for call-site compat. */
    nextMovementSeq: number;
}

export interface MultistoreSaleCostPreview {
    totalCost: Decimal;
    coveredQty: Decimal;
    shortfall: Decimal;
}

export interface MultistoreStockDeductionParams {
    storeLocationId: string;
    productId: string;
    productName: string;
    baseQty: Decimal;
    movementType: 'SALE' | 'DELIVERY';
    referenceType: string;
    referenceId: string;
    notes: string;
    userId: string | null;
    enteredQty?: number;
    baseUomId?: string;
    conversionFactor?: string;
    /** @deprecated Ignored — movement numbers use doc_movement_number_seq. */
    movementSeqStart?: number;
}

async function insertStockMovement(
    client: PoolClient,
    params: {
        movementNumber: string;
        productId: string;
        batchId: string;
        quantity: Decimal;
        unitCost: number;
        movementType: 'SALE' | 'DELIVERY';
        referenceType: string;
        referenceId: string;
        notes: string;
        userId: string | null;
        enteredQty?: number;
        baseUomId?: string;
        conversionFactor?: string;
    },
): Promise<void> {
    await client.query(
        `INSERT INTO stock_movements (
           movement_number, product_id, batch_id, movement_type, quantity, unit_cost,
           reference_type, reference_id, notes, created_by_id,
           entered_qty, base_uom_id, conversion_factor
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
            params.movementNumber,
            params.productId,
            params.batchId,
            params.movementType,
            params.quantity.abs().toFixed(4),
            params.unitCost,
            params.referenceType,
            params.referenceId,
            params.notes,
            params.userId,
            params.enteredQty ?? null,
            params.baseUomId ?? null,
            params.conversionFactor ?? null,
        ],
    );
}

export const warehouseSaleDeductionService = {
    async resolveSellingStoreId(client: PoolClient): Promise<string> {
        const storeId = await posProductSearchService.resolveActiveSellingStoreId(client);
        if (!storeId) {
            throw new BusinessError(
                'Multistore POS/restaurant requires an active shop store (store_type=SELLING). MAIN warehouse cannot sell.',
                'ERR_STORE_001',
            );
        }
        return storeId;
    },

    async validateSellableAtStore(
        client: PoolClient,
        storeLocationId: string,
        productId: string,
        quantity: number,
    ): Promise<void> {
        const plan = await previewMultistoreBalancesForAllocation(
            client,
            storeLocationId,
            productId,
            quantity,
        );
        if (!plan.sufficient) {
            throw new BusinessError(
                `Insufficient stock at selling store. Available: ${plan.allocatedQuantity}, Requested: ${quantity}.`,
                'ERR_STOCK_001',
                { productId, available: plan.allocatedQuantity, requested: quantity },
            );
        }
    },

    /**
     * COGS preview at a store — same FEFO selectLots walk as deductAtStore.
     * Shortfall is returned uncovered; saleAllocatedCostPreview pads once (SSOT).
     */
    async previewSaleCostAtStore(
        client: PoolClient,
        storeLocationId: string,
        productId: string,
        baseQty: Decimal,
        _masterCostPerBase: Decimal,
    ): Promise<MultistoreSaleCostPreview> {
        const minDaysBeforeExpiry = await getProductMinDaysBeforeExpirySale(client, productId);
        const selectableLots = await loadStoreSelectableLots(
            client,
            productId,
            storeLocationId,
            { forUpdate: false, minDaysBeforeExpiry },
        );
        const plan = selectLots({
            policy: 'FEFO',
            lots: selectableLots,
            quantity: baseQty.toNumber(),
            businessDate: getBusinessDate(),
            minDaysBeforeExpirySale: minDaysBeforeExpiry,
        });
        return {
            totalCost: new Decimal(plan.totalCost),
            coveredQty: new Decimal(plan.totalAllocated),
            shortfall: plan.shortfall > 0 ? new Decimal(plan.shortfall) : new Decimal(0),
        };
    },

    async resolveMainStoreId(client: PoolClient): Promise<string> {
        const main = await storeLocationRepository.getDefaultReceivingStore(client);
        if (!main) {
            throw new BusinessError(
                'Multistore wholesale issue requires a MAIN receiving store.',
                'ERR_STORE_001',
            );
        }
        return main.id;
    },

    /**
     * Deduct sellable stock at a store via LotService.consumeLot (store-scoped FEFO).
     */
    async deductAtStore(
        client: PoolClient,
        params: MultistoreStockDeductionParams,
    ): Promise<MultistoreSaleDeductionResult> {
        const minDaysBeforeExpiry = await getProductMinDaysBeforeExpirySale(
            client,
            params.productId,
        );

        const selectableLots = await loadStoreSelectableLots(
            client,
            params.productId,
            params.storeLocationId,
            { forUpdate: true, minDaysBeforeExpiry },
        );
        const consumptionPlan = selectLots({
            policy: 'FEFO',
            lots: selectableLots,
            quantity: params.baseQty.toNumber(),
            businessDate: getBusinessDate(),
            minDaysBeforeExpirySale: minDaysBeforeExpiry,
        });

        if (consumptionPlan.shortfall > 0.001) {
            throw new BusinessError(
                `Not enough stock for "${params.productName}" at the selected store. ` +
                    `Requested: ${params.baseQty.toFixed(2)}, Available: ${consumptionPlan.totalAllocated.toFixed(2)}.`,
                'ERR_STOCK_001',
                {
                    product: params.productName,
                    productId: params.productId,
                    requested: Money.toNumber(params.baseQty),
                    available: consumptionPlan.totalAllocated,
                },
            );
        }

        const consumeResult = await lotService.consumeLot(client, {
            productId: params.productId,
            quantity: params.baseQty.toNumber(),
            storeLocationId: params.storeLocationId,
            selectionPolicy: 'FEFO',
            minDaysBeforeExpiry: minDaysBeforeExpiry,
            referenceType: params.referenceType,
            referenceId: params.referenceId,
            userId: params.userId ?? 'system',
            productName: params.productName,
            recordMovement: false,
            syncProduct: false,
        });

        let primaryProductLotId: string | null = null;
        let primaryBatchId: string | null = null;

        for (const layer of consumeResult.layers) {
            const movementNumber = await allocateNextMovementNumber(client);

            await insertStockMovement(client, {
                movementNumber,
                productId: params.productId,
                batchId: layer.lotId,
                quantity: new Decimal(layer.quantity),
                unitCost: layer.costPrice,
                movementType: params.movementType,
                referenceType: params.referenceType,
                referenceId: params.referenceId,
                notes: params.notes,
                userId: params.userId,
                enteredQty: params.enteredQty,
                baseUomId: params.baseUomId,
                conversionFactor: params.conversionFactor,
            });

            if (!primaryProductLotId && layer.productLotId) {
                primaryProductLotId = layer.productLotId;
                primaryBatchId = layer.lotId;
            }
        }

        await syncProductQuantity(client, params.productId);

        return {
            storeLocationId: params.storeLocationId,
            primaryProductLotId,
            primaryBatchId,
            actualBatchCost: Money.parseDb(consumeResult.totalCost),
            movementCount: consumeResult.layers.length,
            nextMovementSeq: 0,
        };
    },

    async deductForSaleLine(
        client: PoolClient,
        params: {
            storeLocationId: string;
            productId: string;
            productName: string;
            baseQty: Decimal;
            saleId: string;
            saleNumber: string;
            soldBy: string | null;
            enteredQty: number;
            baseUomId: string;
            conversionFactor: string;
            movementSeqStart?: number;
        },
    ): Promise<MultistoreSaleDeductionResult> {
        return this.deductAtStore(client, {
            storeLocationId: params.storeLocationId,
            productId: params.productId,
            productName: params.productName,
            baseQty: params.baseQty,
            movementType: 'SALE',
            referenceType: 'SALE',
            referenceId: params.saleId,
            notes: `Sale ${params.saleNumber} - FEFO store deduction`,
            userId: params.soldBy,
            enteredQty: params.enteredQty,
            baseUomId: params.baseUomId,
            conversionFactor: params.conversionFactor,
            movementSeqStart: params.movementSeqStart,
        });
    },
};
