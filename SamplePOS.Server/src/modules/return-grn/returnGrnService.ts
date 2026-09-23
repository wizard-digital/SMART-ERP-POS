/**
 * Return GRN Service
 * 
 * Business logic for creating and posting Return Goods Receipt Notes.
 * 
 * POSTING LOGIC (SAP LUW — atomic inventory + GL):
 * - Validates return qty ≤ (received qty − previously returned qty)
 * - Creates SUPPLIER_RETURN stock movements (decreases stock)
 * - Reduces batch remaining_quantity
 * - Deducts FIFO cost_layers (keeps layer subledger aligned with inventory GL)
 * - Recalculates product_inventory.quantity_on_hand
 * - Posts GL: DR GRN/IR Clearing (2150) or Return Clearing (2160) / CR Inventory (1300)
 * - Supplier Credit Note is created separately from the GR detail screen (POST …/credit-note);
 *   user must apply the SCN to open bills manually on Credit Notes
 */

import type { Pool, PoolClient } from 'pg';
import Decimal from 'decimal.js';
import { UnitOfWork } from '../../db/unitOfWork.js';
import {
    returnGrnRepository,
    type ReturnGrn,
    type ReturnGrnLine,
} from './returnGrnRepository.js';
import * as stockMovementRepository from '../stock-movements/stockMovementRepository.js';
import * as costLayerService from '../../services/costLayerService.js';
import * as glEntryService from '../../services/glEntryService.js';
import { Money } from '../../utils/money.js';
import logger from '../../utils/logger.js';
import * as documentFlowService from '../document-flow/documentFlowService.js';
import {
    supplierCreditDebitNoteRepository,
} from '../credit-debit-notes/creditDebitNoteRepository.js';
import { recordSupplierCreditNoteToGL, AccountCodes } from '../../services/glEntryService.js';
import { resolveRgrnClearingAccountCode } from './rgrnClearingAccount.js';
import {
    assertInventoryCouplingUnchanged,
    captureInventoryCoupling,
    documentTotalDiffersFromSubledger,
    resolveGl1300FromBatchSubledgerDelta,
} from '../../services/inventorySubledgerCoupling.js';
import { syncProductQuantity } from '../../utils/inventorySync.js';
import { recalculateOutstandingBalance as recalcSupplierBalance } from '../suppliers/supplierRepository.js';
import { getBusinessDate } from '../../utils/dateRange.js';
import { BusinessError, ValidationError } from '../../middleware/errorHandler.js';
import {
    SUPPLIER_BILL_REQUIRED_FOR_SCN_CODE,
    SUPPLIER_BILL_REQUIRED_FOR_SCN_MESSAGE,
} from './returnGrnMessages.js';
import { resolveCanonicalProductUom } from '../products/uomService.js';
import { syncPOStatusWithReceipts } from '../purchase-orders/poReceiptStatusSync.js';
import { warehouseSupplierReturnDeductionService } from '../inventory/warehouse/warehouseSupplierReturnDeductionService.js';
import { isGoodsReceiptPosted } from '@shared/domain/pgDomainEnums.js';
import {
    assertWithinReturnableLimits,
    pickReturnableRow,
    validateReturnLinesAgainstSnapshot,
    type ReturnGrnLimitDisplay,
} from './returnGrnValidation.js';
import {
    returnGrnEnteredToBaseQuantity,
    returnGrnPurchaseQuantityFromBase,
} from './returnGrnQuantity.js';

export interface CreateReturnGrnInput {
    grnId: string;
    returnDate?: string;
    reason: string;
    createdBy: string;
    lines: Array<{
        productId: string;
        batchId?: string | null;
        uomId?: string | null;
        quantity: number;
        unitCost: number;
    }>;
}

export const returnGrnService = {

    /**
     * Create a Return GRN (DRAFT).
     * Validates that the GRN is finalized and lines reference valid items.
     */
    async create(
        pool: Pool,
        input: CreateReturnGrnInput,
        txClient?: PoolClient,
    ): Promise<{ returnGrn: ReturnGrn; lines: ReturnGrnLine[] }> {

        const execute = async (client: PoolClient) => {
            // 1. Validate source GRN exists and is finalized
            // Resolve supplier through PO (standard) or through manual PO (for manual GRs)
            const grResult = await client.query(
                `SELECT g.id, g.status, g.purchase_order_id,
                COALESCE(s."Id", s2."Id") AS "supplierId",
                COALESCE(s."CompanyName", s2."CompanyName") AS "supplierName"
         FROM goods_receipts g
         LEFT JOIN purchase_orders po ON po.id = g.purchase_order_id
         LEFT JOIN suppliers s ON s."Id" = po.supplier_id
         LEFT JOIN inventory_batches ib_any ON ib_any.goods_receipt_id = g.id
         LEFT JOIN purchase_orders po2 ON po2.id = ib_any.purchase_order_id
         LEFT JOIN suppliers s2 ON s2."Id" = po2.supplier_id
         WHERE g.id = $1
         LIMIT 1`,
                [input.grnId]
            );
            if (grResult.rows.length === 0) throw new Error('Goods receipt not found');
            const gr = grResult.rows[0];
            if (!isGoodsReceiptPosted(gr.status)) {
                throw new Error('Can only return items from a posted (COMPLETED) goods receipt');
            }
            if (!gr.supplierId) throw new Error('GRN has no linked supplier');

            // 2. Validate at least one line
            if (!input.lines.length) throw new Error('At least one return line is required');

            // 3. Create RGRN header
            const returnGrn = await returnGrnRepository.create(client, {
                grnId: input.grnId,
                supplierId: gr.supplierId,
                returnDate: input.returnDate || getBusinessDate(),
                reason: input.reason,
                createdBy: input.createdBy,
            });

            // 4. Validate all lines against one snapshot (prevents multi-line over-return)
            const returnableSnapshot = await returnGrnRepository.getReturnableItems(client, input.grnId);
            const pendingLines: Array<{
                productId: string;
                batchId?: string | null;
                baseQuantity: number;
                productName: string;
                limitDisplay?: ReturnGrnLimitDisplay;
                enteredUomId: string | null;
            }> = [];

            for (const line of input.lines) {
                if (line.quantity <= 0) throw new Error('Return quantity must be positive');

                const grItemRow = await client.query<{
                    uom_id: string | null;
                    uom_symbol: string | null;
                    product_name: string | null;
                    base_uom_symbol: string | null;
                }>(
                    `SELECT gri.uom_id,
                            COALESCE(u.symbol, u.name) AS uom_symbol,
                            p.name AS product_name,
                            COALESCE(base_u.symbol, base_u.name) AS base_uom_symbol
                     FROM goods_receipt_items gri
                     LEFT JOIN uoms u ON u.id = gri.uom_id
                     JOIN products p ON p.id = gri.product_id
                     LEFT JOIN uoms base_u ON base_u.id = p.base_uom_id
                     WHERE gri.goods_receipt_id = $1 AND gri.product_id = $2
                     LIMIT 1`,
                    [input.grnId, line.productId],
                );
                const purchaseUomId: string | null = grItemRow.rows[0]?.uom_id ?? null;
                const productName = grItemRow.rows[0]?.product_name ?? 'product';
                const baseUomSymbol = grItemRow.rows[0]?.base_uom_symbol ?? 'units';

                let effectiveUomId: string | null = line.uomId ?? purchaseUomId;
                if (!effectiveUomId) {
                    const baseRow = await client.query<{ base_uom_id: string | null }>(
                        `SELECT base_uom_id FROM products WHERE id = $1 LIMIT 1`,
                        [line.productId],
                    );
                    effectiveUomId = baseRow.rows[0]?.base_uom_id ?? null;
                }
                if (!effectiveUomId) {
                    throw new ValidationError(
                        `Unit of measure is required to return ${productName}.`,
                    );
                }

                const { conversionFactor } = await resolveCanonicalProductUom(
                    line.productId,
                    effectiveUomId,
                    client,
                );

                const uomSymbolRow = await client.query<{ symbol: string | null }>(
                    `SELECT COALESCE(symbol, name) AS symbol FROM uoms WHERE id = $1 LIMIT 1`,
                    [effectiveUomId],
                );
                const enteredUomSymbol = uomSymbolRow.rows[0]?.symbol ?? 'units';

                const baseQuantity = returnGrnEnteredToBaseQuantity(line.quantity, conversionFactor);

                const snapshotRow = pickReturnableRow(
                    returnableSnapshot,
                    line.productId,
                    line.batchId ?? null,
                );
                const maxBaseQuantity = Number(snapshotRow?.returnableQuantity) || 0;

                logger.info('[RETURN GRN] quantity validation input', {
                    grnId: input.grnId,
                    productId: line.productId,
                    productName,
                    enteredQuantity: line.quantity,
                    enteredUomId: effectiveUomId,
                    enteredUomSymbol,
                    conversionFactor,
                    baseQuantity,
                    maxBaseQuantity,
                });

                const limitDisplay: ReturnGrnLimitDisplay = {
                    enteredQuantity: line.quantity,
                    enteredUomSymbol,
                    factorToBase: conversionFactor,
                    baseUomSymbol,
                };

                pendingLines.push({
                    productId: line.productId,
                    batchId: line.batchId ?? null,
                    baseQuantity,
                    productName,
                    limitDisplay,
                    enteredUomId: effectiveUomId,
                });
            }

            const resolvedBatches = validateReturnLinesAgainstSnapshot(
                returnableSnapshot,
                pendingLines.map((p) => ({
                    productId: p.productId,
                    batchId: p.batchId,
                    baseQuantity: p.baseQuantity,
                    productName: p.productName,
                    limitDisplay: p.limitDisplay,
                })),
            );

            const lines: ReturnGrnLine[] = [];
            for (let i = 0; i < input.lines.length; i++) {
                const line = input.lines[i];
                const pending = pendingLines[i];
                const resolvedBatchId = resolvedBatches[i]?.batchId ?? line.batchId ?? null;

                const grItemRow = await client.query<{
                    uom_id: string | null;
                }>(
                    `SELECT gri.uom_id FROM goods_receipt_items gri
                     WHERE gri.goods_receipt_id = $1 AND gri.product_id = $2 LIMIT 1`,
                    [input.grnId, line.productId],
                );
                const purchaseUomId: string | null = grItemRow.rows[0]?.uom_id ?? null;
                const effectiveUomId = pending.enteredUomId;

                const { conversionFactor: purchaseFactor } = await resolveCanonicalProductUom(
                    line.productId,
                    purchaseUomId,
                    client,
                );

                const baseQuantity = pending.baseQuantity;
                const purchaseQuantity = returnGrnPurchaseQuantityFromBase(
                    baseQuantity,
                    purchaseFactor,
                );

                // lineTotal = purchase-UOM qty × purchase-UOM unit cost (gri.cost_price).
                const lineTotal = Money.toNumber(
                    Money.multiply(Money.parseDb(purchaseQuantity), Money.parseDb(line.unitCost))
                );

                const created = await returnGrnRepository.createLine(client, {
                    rgrnId: returnGrn.id,
                    productId: line.productId,
                    batchId: resolvedBatchId,
                    uomId: effectiveUomId,
                    quantity: purchaseQuantity,
                    baseQuantity,
                    unitCost: line.unitCost,
                    lineTotal,
                });
                lines.push(created);
            }

            // Document Flow: GR → Return GRN
            await documentFlowService.linkDocuments(client, 'GOODS_RECEIPT', input.grnId, 'RETURN_GRN', returnGrn.id, 'RETURNS');

            logger.info('Return GRN draft created', {
                rgrnId: returnGrn.id,
                rgrnNumber: returnGrn.returnGrnNumber,
                grnId: input.grnId,
                lineCount: lines.length,
            });

            return { returnGrn, lines };
        };

        if (txClient) return execute(txClient);
        return UnitOfWork.run(pool, execute);
    },

    /**
     * Post a Return GRN (DRAFT → POSTED).
     * 
     * For each line:
     * - Validates quantity ≤ (received - previously returned)
     * - Reduces batch remaining_quantity
     * - Creates SUPPLIER_RETURN stock movement
     * - Recalculates product_inventory.quantity_on_hand
     * 
     * GL entries (SAP pattern — atomic with inventory changes):
     *   DR Accounts Payable (2100) — reduce what we owe
     *   CR Inventory (1300) — reduce inventory value
     */
    async post(
        pool: Pool,
        rgrnId: string,
        txClient?: PoolClient,
    ): Promise<ReturnGrn> {

        const execute = async (client: PoolClient) => {
            // 1. Get the RGRN and validate DRAFT status
            const rgrn = await returnGrnRepository.getById(client, rgrnId);
            if (!rgrn) throw new Error('Return GRN not found');
            if (rgrn.status !== 'DRAFT') throw new Error('Only DRAFT Return GRNs can be posted');

            // 2. Get lines
            const lines = await returnGrnRepository.getLines(client, rgrnId);
            if (lines.length === 0) throw new Error('Return GRN has no line items');

            const returnableSnapshot = await returnGrnRepository.getReturnableItems(client, rgrn.grnId);

            validateReturnLinesAgainstSnapshot(
                returnableSnapshot,
                lines.map((l) => ({
                    productId: l.productId,
                    batchId: l.batchId,
                    baseQuantity: l.baseQuantity,
                    productName: l.productName,
                })),
            );

            const inventoryCouplingBefore = await captureInventoryCoupling(client);

            // 3. Process each line
            // Also accumulate the GL amount from actual batch.cost_price (not line.unitCost).
            // line.unitCost is user-entered on the return document and can be wrong;
            // batch.cost_price is the authoritative inventory cost used in the batch subledger.
            // Using batch cost for GL ensures CR Inventory = batch subledger reduction.
            let returnTotalFromBatch = new Decimal(0);

            for (const line of lines) {
                // 3a. Batch must match draft line (resolved at create); FIFO fallback for legacy drafts
                let effectiveBatchId = line.batchId;
                if (!effectiveBatchId) {
                    effectiveBatchId = pickReturnableRow(
                        returnableSnapshot,
                        line.productId,
                        null,
                    )?.batchId ?? null;
                }

                // 3b. Re-check limits against live snapshot row (defense in depth)
                assertWithinReturnableLimits(
                    pickReturnableRow(returnableSnapshot, line.productId, effectiveBatchId ?? null),
                    line.baseQuantity,
                    line.productName ?? 'product',
                );

                // 3c. Reduce batch + warehouse balances (multistore) and capture batch.cost_price for GL
                let batchCostPrice = new Decimal(line.unitCost || 0); // fallback to line.unitCost
                if (effectiveBatchId) {
                    const deduction = await warehouseSupplierReturnDeductionService.deductForSupplierReturn(
                        client,
                        {
                            productId: line.productId,
                            inventoryBatchId: effectiveBatchId,
                            quantity: line.baseQuantity,
                        },
                    );
                    batchCostPrice = deduction.costPrice;
                } else {
                    logger.warn('No batch found for return line — stock movement will be recorded but batch not deducted', {
                        productId: line.productId,
                        grnId: rgrn.grnId,
                    });
                }

                // Accumulate GL amount at batch cost (not user-entered line.unitCost)
                returnTotalFromBatch = returnTotalFromBatch.plus(
                    new Decimal(String(line.baseQuantity)).times(batchCostPrice)
                );

                // 3d. Create SUPPLIER_RETURN stock movement (use batch cost for SM consistency)
                await stockMovementRepository.recordMovement(client, {
                    productId: line.productId,
                    batchId: effectiveBatchId,
                    movementType: 'SUPPLIER_RETURN',
                    quantity: -line.baseQuantity, // Negative = stock decrease
                    unitCost: Money.toNumber(batchCostPrice), // batch.cost_price, not line.unitCost
                    referenceType: 'RETURN_GRN',
                    referenceId: rgrnId,
                    notes: `Return to supplier: ${rgrn.reason}`,
                    createdBy: rgrn.createdBy,
                });

                // 3e. FIFO cost_layers — mirror sale outbound (GR finalize creates layers)
                const costingResult = await client.query<{ costing_method: string | null }>(
                    `SELECT costing_method FROM product_valuation WHERE product_id = $1`,
                    [line.productId],
                );
                const costingMethod = (costingResult.rows[0]?.costing_method || 'FIFO') as
                    | 'FIFO'
                    | 'AVCO'
                    | 'STANDARD';
                if (costingMethod === 'FIFO') {
                    await costLayerService.deductFromCostLayers(
                        line.productId,
                        line.baseQuantity,
                        'FIFO',
                        undefined,
                        client,
                    );
                    logger.debug('Return GRN cost layers deducted', {
                        rgrnId,
                        productId: line.productId,
                        baseQuantity: line.baseQuantity,
                    });
                }

                // 3f. App-layer sync: update BOTH product_inventory and products.quantity_on_hand
                await syncProductQuantity(client, line.productId);
            }

            // 4. Post the RGRN
            const posted = await returnGrnRepository.post(client, rgrnId);
            if (!posted) throw new Error('Failed to post Return GRN');

            // 4b. Reopen / complete PO from net-received SSOT (sole sync writer).
            const grPoRow = await client.query<{ purchase_order_id: string | null }>(
              `SELECT purchase_order_id FROM goods_receipts WHERE id = $1`,
              [rgrn.grnId],
            );
            const linkedPoId = grPoRow.rows[0]?.purchase_order_id;
            if (linkedPoId) {
              await syncPOStatusWithReceipts(client, linkedPoId, {
                forceDraftIfFullyReversed: true,
              });
            }

            // 5. GL posting — INSIDE transaction (SAP LUW: issue from subledger valuation)
            const couplingAfterReturn = await captureInventoryCoupling(client);
            const glInventoryAmount = resolveGl1300FromBatchSubledgerDelta(
                inventoryCouplingBefore,
                couplingAfterReturn,
                'issue',
            );
            const returnTotalNum = glInventoryAmount;

            if (documentTotalDiffersFromSubledger(Money.toNumber(returnTotalFromBatch), glInventoryAmount)) {
                logger.warn('[RETURN GRN] JS batch walk total differs from subledger — posting GL from SQL delta', {
                    rgrnId,
                    jsTotal: Money.toNumber(returnTotalFromBatch),
                    batchSubledgerReduction: glInventoryAmount,
                });
            }

            // Look up supplier name for GL description (hoisted for use in both step 5 and step 6)
            const grResult = await client.query(
                `SELECT COALESCE(po.supplier_id, po2.supplier_id) AS supplier_id,
                        COALESCE(s."CompanyName", s2."CompanyName") AS supplier_name,
                        g.receipt_number AS gr_number
                 FROM goods_receipts g
                 LEFT JOIN purchase_orders po ON po.id = g.purchase_order_id
                 LEFT JOIN suppliers s ON s."Id" = po.supplier_id
                 LEFT JOIN inventory_batches ib_any ON ib_any.goods_receipt_id = g.id
                 LEFT JOIN purchase_orders po2 ON po2.id = ib_any.purchase_order_id
                 LEFT JOIN suppliers s2 ON s2."Id" = po2.supplier_id
                 WHERE g.id = $1
                 LIMIT 1`,
                [rgrn.grnId]
            );
            const supplierName = grResult.rows[0]?.supplier_name || 'Unknown Supplier';
            const supplierId = grResult.rows[0]?.supplier_id || rgrn.supplierId || '';
            const originalGrNumber = grResult.rows[0]?.gr_number;
            let hasInvoice = false;

            if (returnTotalNum > 0) {
                // MR11 PURITY — detect whether the originating GRN already has a
                // posted supplier invoice.  If yes, the return must route through
                // Supplier Return Clearing (2160) so GR/IR (2150) is not polluted.
                const invoiceCheck = await client.query<{ has_invoice: boolean }>(
                    `SELECT EXISTS(
                        SELECT 1
                        FROM supplier_invoices si
                        WHERE si.deleted_at IS NULL
                          AND si.document_type = 'SUPPLIER_INVOICE'
                          AND UPPER(COALESCE(si."Status",'')) NOT IN ('CANCELLED', 'VOID', 'VOIDED', 'DELETED')
                          AND (
                            si."Id" IN (
                              SELECT sigl.invoice_id
                              FROM supplier_invoice_grn_links sigl
                              WHERE sigl.grn_id = $1
                            )
                            OR si."InternalReferenceNumber" = (
                              SELECT receipt_number FROM goods_receipts WHERE id = $1
                            )
                            OR si."InternalReferenceNumber" = (
                              SELECT 'INV-' || receipt_number FROM goods_receipts WHERE id = $1
                            )
                          )
                     ) AS has_invoice`,
                    [rgrn.grnId],
                );
                hasInvoice = invoiceCheck.rows[0]?.has_invoice ?? false;

                await glEntryService.recordReturnGrnToGL(
                    {
                        returnGrnId: rgrnId,
                        returnGrnNumber: posted.returnGrnNumber || rgrnId,
                        returnDate: getBusinessDate(),
                        totalAmount: returnTotalNum,
                        supplierId,
                        supplierName,
                        originalGrNumber,
                        hasInvoice,
                    },
                    undefined, // pool — not needed when txClient is provided
                    client,    // atomic: GL commits/rolls back with inventory
                );
            }

            assertInventoryCouplingUnchanged(
                inventoryCouplingBefore,
                await captureInventoryCoupling(client),
                `return GRN ${posted.returnGrnNumber || rgrnId}`,
            );

            logger.info('Return GRN posted — stock decreased, GL posted', {
                rgrnId: posted.id,
                rgrnNumber: posted.returnGrnNumber,
                grnId: posted.grnId,
                lineCount: lines.length,
                glAmount: returnTotalNum,
            });

            return posted;
        };

        if (txClient) return execute(txClient);
        return UnitOfWork.run(pool, execute);
    },

    /**
     * Get a Return GRN with its line items.
     */
    async getById(
        pool: Pool,
        rgrnId: string,
    ): Promise<{ returnGrn: ReturnGrn; lines: ReturnGrnLine[] } | null> {
        const returnGrn = await returnGrnRepository.getById(pool, rgrnId);
        if (!returnGrn) return null;
        const lines = await returnGrnRepository.getLines(pool, rgrnId);
        return { returnGrn, lines };
    },

    /**
     * List Return GRNs with pagination.
     */
    async list(
        pool: Pool,
        options: {
            grnId?: string;
            supplierId?: string;
            status?: string;
            search?: string;
            needsAttention?: boolean;
            page: number;
            limit: number;
        },
    ) {
        return returnGrnRepository.list(pool, options);
    },

    /**
     * Get returnable items for a GRN (for UI).
     */
    async getReturnableItems(pool: Pool, grnId: string) {
        const items = await returnGrnRepository.getReturnableItems(pool, grnId);
        return items.map((item) => {
            const rawUoms = item.availableUoms;
            const availableUoms = Array.isArray(rawUoms)
                ? rawUoms.map((u: Record<string, unknown>) => ({
                    uomId: String(u.uomId ?? ''),
                    uomName: String(u.uomName ?? ''),
                    uomSymbol: String(u.uomSymbol ?? u.uomName ?? ''),
                    conversionFactor: Number(u.conversionFactor) || 1,
                    isDefault: Boolean(u.isDefault),
                }))
                : [];

            return {
                ...item,
                conversionFactor: Number(item.conversionFactor) || 1,
                receivedQuantity: Number(item.receivedQuantity) || 0,
                unitCost: Number(item.unitCost) || 0,
                returnedQuantity: Number(item.returnedQuantity) || 0,
                returnableQuantity: Number(item.returnableQuantity) || 0,
                documentReturnableQuantity: Number(item.documentReturnableQuantity) || 0,
                onHandQuantity: Number(item.onHandQuantity) || 0,
                consumedQuantity: Number(item.consumedQuantity) || 0,
                availableUoms,
            };
        });
    },

    /**
     * Get Return GRNs linked to a specific GRN (for badge display).
     */
    async getByGrnId(pool: Pool, grnId: string) {
        return returnGrnRepository.getByGrnId(pool, grnId);
    },

    /**
     * Create a Supplier Credit Note from a POSTED Return GRN.
     *
     * This is the ONLY way a Return GRN should reduce AP (2100).
     *
     * Two GL flows depending on whether the Return GRN was posted before or
     * after the originating GRN had a supplier invoice:
     *
     * ── Pre-invoice return (GRN uninvoiced at return time) ──────────────
     *   Return GRN posts:  DR GR/IR Clearing (2150) / CR Inventory (1300)
     *   Credit Note posts: DR AP (2100)              / CR GR/IR Clearing (2150)
     *   Net effect: DR AP / CR Inventory ✓  |  GR/IR clears to zero ✓
     *
     * ── Post-invoice return (GRN already invoiced at return time) ───────
     *   Return GRN posts:  DR Supplier Return Clearing (2160) / CR Inventory (1300)
     *   Credit Note posts: DR AP (2100)                       / CR 2160
     *   Net effect: DR AP / CR Inventory ✓  |  GR/IR untouched ✓  |  2160 clears ✓
     *
     * The correct clearing account is determined by looking up which account
     * the Return GRN's journal entry debited (2150 or 2160).
     */
    async createCreditNoteFromReturn(
        pool: Pool,
        rgrnId: string,
        knownReferenceInvoiceId?: string,
        txClient?: PoolClient,
    ): Promise<{ creditNoteId: string; creditNoteNumber: string }> {
        const run = async (client: PoolClient) => {
            // 1. Validate RGRN exists and is POSTED
            const rgrn = await returnGrnRepository.getById(client, rgrnId);
            if (!rgrn) throw new Error('Return GRN not found');
            if (rgrn.status !== 'POSTED') throw new Error('Return GRN must be POSTED before creating a Credit Note');

            const { isFullReceiptReverseReason } = await import(
                '../../../../shared/domain/grFullReverseSsot.js'
            );
            if (isFullReceiptReverseReason(rgrn.reason)) {
                throw new BusinessError(
                    'This return fully reversed the goods receipt — stock and GR/IR are already cleared. No supplier credit note is required (and sibling bills must not be credited from this return).',
                    'ERR_SCN_FULL_REVERSE',
                    { returnGrnId: rgrnId, returnGrnNumber: rgrn.returnGrnNumber, reason: rgrn.reason },
                );
            }

            const grReverseLink = await client.query<{ reversed_by_return_grn_id: string | null }>(
                `SELECT reversed_by_return_grn_id::text
                 FROM goods_receipts
                 WHERE id = $1
                 LIMIT 1`,
                [rgrn.grnId],
            );
            if (grReverseLink.rows[0]?.reversed_by_return_grn_id === rgrnId) {
                throw new BusinessError(
                    'This goods receipt was fully reversed by this return — stock, GR/IR, and any unpaid bill were already cleared. No supplier credit note is required.',
                    'ERR_SCN_FULL_REVERSE',
                    {
                        returnGrnId: rgrnId,
                        returnGrnNumber: rgrn.returnGrnNumber,
                        grnId: rgrn.grnId,
                    },
                );
            }

            // 2. Prevent duplicate: active SCN only (list/hasCreditNote SSOT).
            // Cancelled/void notes keep return_grn_id for audit but must not block re-create
            // after cancel reverses GL (POSTED/APPLIED → CANCELLED with ledger reverse).
            const existing = await client.query(
                `SELECT "Id", "Status" FROM supplier_invoices
                 WHERE return_grn_id = $1
                   AND document_type = 'SUPPLIER_CREDIT_NOTE'
                   AND deleted_at IS NULL
                   AND UPPER(COALESCE("Status",'')) NOT IN ('CANCELLED', 'VOID', 'VOIDED', 'DELETED')
                 LIMIT 1`,
                [rgrnId],
            );
            if (existing.rows.length > 0) {
                throw new Error('A Supplier Credit Note already exists for this Return GRN');
            }

            // 3. Load lines to calculate total and build line items
            const lines = await returnGrnRepository.getLines(client, rgrnId);
            if (lines.length === 0) throw new Error('Return GRN has no line items');

            // Use the pre-computed lineTotal from each return line.
            // lineTotal = quantity × unitCost (both in purchase-UOM units).
            // Do NOT recompute as baseQuantity × unitCost — that mixes base-unit
            // quantity with purchase-UOM price, producing a gross overstatement.
            let returnTotal = new Decimal(0);
            for (const line of lines) {
                returnTotal = returnTotal.plus(new Decimal(String(line.lineTotal)));
            }
            const returnTotalNum = Money.toNumber(returnTotal);
            if (returnTotalNum <= 0) throw new Error('Return GRN total amount is zero — cannot create Credit Note');

            // 4. Resolve supplier info
            const grResult = await client.query(
                `SELECT COALESCE(po.supplier_id, po2.supplier_id) AS supplier_id,
                        COALESCE(s."CompanyName", s2."CompanyName") AS supplier_name
                 FROM goods_receipts g
                 LEFT JOIN purchase_orders po ON po.id = g.purchase_order_id
                 LEFT JOIN suppliers s ON s."Id" = po.supplier_id
                 LEFT JOIN inventory_batches ib_any ON ib_any.goods_receipt_id = g.id
                 LEFT JOIN purchase_orders po2 ON po2.id = ib_any.purchase_order_id
                 LEFT JOIN suppliers s2 ON s2."Id" = po2.supplier_id
                 WHERE g.id = $1
                 LIMIT 1`,
                [rgrn.grnId],
            );
            const supplierId: string = grResult.rows[0]?.supplier_id || rgrn.supplierId || '';
            const supplierName: string = grResult.rows[0]?.supplier_name || 'Unknown Supplier';

            // 5. Find the original Supplier Invoice for THIS goods receipt only.
            //    Never fall back to PurchaseOrderId — that credits a sibling GR's bill.
            //    SSOT aligned with return-grn worklist hasSupplierBill:
            //      - junction link for this GR (authoritative), OR
            //      - InternalReferenceNumber = receipt_number, OR
            //      - InternalReferenceNumber = 'INV-' || receipt_number (Henber bill create pattern)
            //    Do NOT require empty InternalReference for junction matches — bills often
            //    store INV-GR-… while links correctly point at the GR (ERR_RETURN_GRN_001 false positive).
            let referenceInvoiceId: string | undefined = knownReferenceInvoiceId;
            if (!referenceInvoiceId) {
                const siResult = await client.query(
                    `SELECT si."Id"
                     FROM supplier_invoices si
                     WHERE si.document_type = 'SUPPLIER_INVOICE'
                       AND si.deleted_at IS NULL
                       AND UPPER(COALESCE(si."Status",'')) NOT IN ('CANCELLED', 'VOID', 'VOIDED', 'DELETED')
                       AND (
                         si."Id" IN (
                           SELECT sigl.invoice_id FROM supplier_invoice_grn_links sigl
                           WHERE sigl.grn_id = $1
                         )
                         OR si."InternalReferenceNumber" = (
                           SELECT receipt_number FROM goods_receipts WHERE id = $1
                         )
                         OR si."InternalReferenceNumber" = (
                           SELECT 'INV-' || receipt_number FROM goods_receipts WHERE id = $1
                         )
                       )
                     ORDER BY si."CreatedAt" DESC LIMIT 1`,
                    [rgrn.grnId],
                );
                referenceInvoiceId = siResult.rows[0]?.Id as string | undefined;
            }
            if (!referenceInvoiceId) {
                throw new BusinessError(
                    SUPPLIER_BILL_REQUIRED_FOR_SCN_MESSAGE,
                    SUPPLIER_BILL_REQUIRED_FOR_SCN_CODE,
                    { grnId: rgrn.grnId, returnGrnId: rgrnId, returnGrnNumber: rgrn.returnGrnNumber },
                );
            }

            const billRow = await client.query<{
                TotalAmount: string;
                Subtotal: string;
                Status: string;
            }>(
                `SELECT "TotalAmount", "Subtotal", "Status"
                 FROM supplier_invoices
                 WHERE "Id" = $1 AND deleted_at IS NULL`,
                [referenceInvoiceId],
            );
            if (!billRow.rows[0]) {
                throw new Error('Reference supplier bill not found');
            }
            const billTotal = Money.toNumber(Money.parseDb(billRow.rows[0].TotalAmount));
            const billSubtotal = Money.toNumber(Money.parseDb(billRow.rows[0].Subtotal));
            const billStatus = String(billRow.rows[0].Status || '').toUpperCase();
            if (['CANCELLED', 'VOIDED', 'VOID', 'DELETED'].includes(billStatus)) {
                throw new BusinessError(
                    'Cannot create credit note against a cancelled supplier bill',
                    'ERR_SCN_BILL_CANCELLED',
                    { referenceInvoiceId, returnGrnId: rgrnId },
                );
            }

            // AP ceiling = bill TotalAmount. Return line sum is inventory cost and can
            // exceed AP when the SI was under-billed (Subtotal=GR, TotalAmount=supplier AP).
            // Cap SCN at bill total in that case — never credit more than was billed.
            let scnAmount = returnTotalNum;
            if (scnAmount > billTotal + 0.009) {
                if (billSubtotal + 0.009 >= returnTotalNum) {
                    scnAmount = billTotal;
                } else {
                    throw new BusinessError(
                        `Return credit note would exceed supplier bill total (${billTotal.toFixed(2)})`,
                        'ERR_SCN_EXCEEDS_BILL',
                        {
                            referenceInvoiceId,
                            returnGrnId: rgrnId,
                            billTotal,
                            billSubtotal,
                            returnTotal: returnTotalNum,
                        },
                    );
                }
            }

            const existingNotes = await supplierCreditDebitNoteRepository.getNotesForSupplierInvoice(
                client,
                referenceInvoiceId,
                'SUPPLIER_CREDIT_NOTE',
            );
            const cumulativeCredits = existingNotes.reduce(
                (sum, note) => sum.plus(note.totalAmount),
                new Decimal(0),
            );
            if (Money.toNumber(cumulativeCredits.plus(scnAmount)) > billTotal + 0.009) {
                throw new BusinessError(
                    `Return credit note would exceed supplier bill total (${billTotal.toFixed(2)})`,
                    'ERR_SCN_EXCEEDS_BILL',
                    {
                        referenceInvoiceId,
                        returnGrnId: rgrnId,
                        billTotal,
                        returnTotal: returnTotalNum,
                        scnAmount,
                        existingCredits: Money.toNumber(cumulativeCredits),
                    },
                );
            }

            // Return SCNs post on-account (supplier credit). Paid bills have Outstanding=0;
            // do not require open AP — lock only for concurrency.
            const { lockAndComputeInvoiceOutstanding } = await import(
                '../supplier-payments/supplierPaymentRepository.js'
            );
            await lockAndComputeInvoiceOutstanding(client, referenceInvoiceId);

            // 6. Generate SCN number and create header
            const scnNumber = await supplierCreditDebitNoteRepository.generateSupplierCreditNoteNumber(client);

            const scn = await supplierCreditDebitNoteRepository.createSupplierNote(client, {
                invoiceNumber: scnNumber,
                documentType: 'SUPPLIER_CREDIT_NOTE',
                referenceInvoiceId: referenceInvoiceId,
                supplierId,
                issueDate: getBusinessDate(),
                subtotal: scnAmount,
                taxAmount: 0,
                totalAmount: scnAmount,
                reason: `Credit Note for ${rgrn.returnGrnNumber}: ${rgrn.reason}`,
                notes:
                    scnAmount + 0.009 < returnTotalNum
                        ? `Linked to Return GRN ${rgrn.returnGrnNumber} (SCN capped at bill AP ${billTotal.toFixed(2)}; return goods ${returnTotalNum.toFixed(2)})`
                        : `Linked to Return GRN ${rgrn.returnGrnNumber}`,
                returnGrnId: rgrnId,
            });

            // 7. Create line items
            // Use purchase-UOM quantity (line.quantity), not base quantity.
            // The supplier deals in purchase UOM (PKT, BOX) — not in base tablets.
            await supplierCreditDebitNoteRepository.createSupplierNoteLineItems(
                client,
                scn.id,
                lines.map((line, idx) => ({
                    productId: line.productId,
                    productName: line.productName || `Product ${idx + 1}`,
                    description: `Returned: ${line.quantity}${line.uomSymbol ? ' ' + line.uomSymbol : ''} × ${line.unitCost} (${rgrn.reason})`,
                    quantity: line.quantity,        // purchase-UOM qty (1 PKT, not 10 tablets)
                    unitCost: line.unitCost,        // purchase-UOM cost (6000/PKT, not 600/tablet)
                    taxRate: 0,
                })),
            );

            // 8. Post the SCN
            const postedScn = await supplierCreditDebitNoteRepository.postSupplierNote(client, scn.id);
            if (!postedScn) throw new Error('Failed to post Supplier Credit Note');

            // 9. GL: DR AP (2100) / CR [clearing account used by the RGRN]
            //
            // The clearing account depends on which path the Return GRN took:
            //   \u2022 Pre-invoice return  \u2192 RGRN debited GR/IR (2150)  \u2192 Credit Note credits 2150
            //   \u2022 Post-invoice return \u2192 RGRN debited 2160 (Supplier Return Clearing)
            //                         \u2192 Credit Note credits 2160
            //
            // Look up the debit leg of the RGRN journal to find which account was used.
            const rgrnClearingCode = await resolveRgrnClearingAccountCode(client, rgrnId);

            // GL: AP debit = billed ceiling (scnAmount); clearing credit = return goods
            // (returnTotalNum). Gap posts to Price Variance — reverses SI under-bill PPV.
            await recordSupplierCreditNoteToGL({
                noteId: postedScn.id,
                noteNumber: postedScn.invoiceNumber,
                noteDate: getBusinessDate(),
                subtotal: returnTotalNum,
                taxAmount: 0,
                totalAmount: scnAmount,
                supplierId,
                supplierName,
                clearingAccountCode: rgrnClearingCode,
            }, undefined, client);

            // 10. Credit note stays POSTED (on-account) until the user clicks
            //     "Apply to Open Bills" on the Credit Notes screen.

            // 11. Recalculate supplier outstanding balance
            if (supplierId) {
                await recalcSupplierBalance(client, supplierId);
            }

            // 12. Document Flow: RETURN_GRN → SUPPLIER_CREDIT_NOTE
            await documentFlowService.linkDocuments(
                client, 'RETURN_GRN', rgrnId,
                'SUPPLIER_CREDIT_NOTE', postedScn.id, 'CREATES',
            );

            logger.info('Supplier Credit Note created from Return GRN', {
                scnId: postedScn.id,
                scnNumber: postedScn.invoiceNumber,
                rgrnId,
                rgrnNumber: rgrn.returnGrnNumber,
                amount: scnAmount,
                returnGoods: returnTotalNum,
            });

            return { creditNoteId: postedScn.id, creditNoteNumber: postedScn.invoiceNumber };
        };
        if (txClient) return run(txClient);
        return UnitOfWork.run(pool, run);
    },
};
