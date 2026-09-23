import { Pool, PoolClient } from 'pg';
import Decimal from 'decimal.js';
import { Money } from '../../utils/money.js';
import { UnitOfWork } from '../../db/unitOfWork.js';
import {
  goodsReceiptRepository,
  CreateGRData,
  CreateGRItemData,
  UpdateGRItemData,
  GoodsReceipt,
  GoodsReceiptItem,
} from './goodsReceiptRepository.js';
import { purchaseOrderRepository, type CreatePOItemData } from '../purchase-orders/purchaseOrderRepository.js';
import { linkInvoiceToGRNs } from '../supplier-payments/supplierPaymentRepository.js';
import * as costLayerService from '../../services/costLayerService.js';
import * as pricingService from '../../services/pricingService.js';
import * as glEntryService from '../../services/glEntryService.js';
import * as supplierProductPriceRepository from '../suppliers/supplierProductPriceRepository.js';
import { recalculateOutstandingBalance as recalcSupplierBalance } from '../suppliers/supplierRepository.js';
import { batchFetchProducts } from '../../db/batchFetch.js';
import logger from '../../utils/logger.js';
import * as documentFlowService from '../document-flow/documentFlowService.js';
import {
  InventoryBusinessRules,
  PurchaseOrderBusinessRules,
} from '../../middleware/businessRules.js';
import { assertSupplierCreditHeadroom } from '../suppliers/supplierCreditGuard.js';
import type { DuplicateStrategy } from '../../../../shared/zod/importSchemas.js';
import { getBusinessDate, getBusinessYear, formatDateBusiness } from '../../utils/dateRange.js';
import { allocateNextMovementNumber } from '../../utils/documentNumberAllocation.js';
import { syncProductQuantity } from '../../utils/inventorySync.js';
import { resolveCanonicalProductUom } from '../products/uomService.js';
import { PricingEngine } from '../../utils/pricingEngine.js';
import {
  assertInventoryCouplingUnchanged,
  captureInventoryCoupling,
  documentTotalDiffersFromSubledger,
  resolveGl1300FromBatchSubledgerDelta,
} from '../../services/inventorySubledgerCoupling.js';
import { correctionEligibilityService } from '../corrections/correctionEligibilityService.js';
import { publishNotificationEvent } from '../notifications/notificationPublisher.js';
import { returnGrnService } from '../return-grn/returnGrnService.js';
import { returnGrnRepository } from '../return-grn/returnGrnRepository.js';
import { returnGrnPurchaseQuantityFromBase } from '../return-grn/returnGrnQuantity.js';
import type { CorrectionEligibilityResult } from '../corrections/correctionEligibilityTypes.js';
import { BusinessError, ValidationError } from '../../middleware/errorHandler.js';
import { lotService, receiveOpeningLot } from '../inventory-lot/lotService.js';
import { isLikelyGrnBillDigitShiftTypo } from '../../../../shared/domain/grnBillPromptSsot.js';

// Alert shape consumed by controller for finalize response
export interface CostPriceChangeAlert {
  productId: string;
  productName: string;
  previousCost: number;
  newCost: number;
  changeAmount: number;
  changePercentage: number;
  batchNumber?: string | null;
}

// Service return types — proper contracts, no `any`
export interface CreateGRResult {
  gr: GoodsReceipt;
  items: GoodsReceiptItem[];
  manualPO?: {
    id: string;
    poNumber: string;
    supplierId: string;
    status: string;
    totalAmount: number;
  };
}

export interface FinalizeGRResult {
  gr: GoodsReceipt;
  items: GoodsReceiptItem[];
  costPriceChangeAlerts: CostPriceChangeAlert[] | null;
  hasAlerts: boolean;
  alertSummary: string | null;
  warnings?: string[];
  linkedSiblingBill?: {
    invoiceId: string;
    invoiceNumber: string;
    grnId: string;
    grnNumber: string;
  } | null;
}

export interface ListGRsResult {
  grs: GoodsReceipt[];
  total: number;
}

/** Odoo/SAP guard: only receive against an open (PENDING) purchase order.
 * Manual-receipt tracking POs are COMPLETED on insert — still allow finalize.
 */
async function assertPOAllowsReceiving(
  pool: Pool | PoolClient,
  purchaseOrderId: string
): Promise<void> {
  const poResult = await purchaseOrderRepository.getPOById(pool, purchaseOrderId);
  if (!poResult) {
    throw new Error(`Purchase order ${purchaseOrderId} not found`);
  }
  const status = poResult.po.status;
  const manualReceipt = Boolean(poResult.po.manualReceipt);
  if (status === 'CANCELLED') {
    throw new Error(
      'Cannot receive goods against a cancelled purchase order. Cancelled orders cannot be received.'
    );
  }
  if (manualReceipt && (status === 'COMPLETED' || status === 'PENDING')) {
    return;
  }
  if (status === 'COMPLETED') {
    const hasOpen = await purchaseOrderRepository.hasOpenReceiptQuantity(pool, purchaseOrderId);
    if (!hasOpen) {
      throw new Error('Purchase order is already fully received');
    }
    // Net-received model: returns reopen receipt against this PO (Phase 1B) — SSOT sync.
    const { syncPOStatusWithReceipts } = await import(
      '../purchase-orders/poReceiptStatusSync.js'
    );
    await syncPOStatusWithReceipts(pool, purchaseOrderId);
    return;
  }
  if (status !== 'PENDING') {
    throw new Error(
      `Purchase order must be pending (sent to supplier) before receiving. Current status: ${status}`
    );
  }
}

/** Add missing PO lines to a DRAFT GR — shared by hydrate and send-to-supplier idempotency. */
async function syncDraftGRLinesFromPO(
  client: PoolClient,
  grId: string
): Promise<number> {
  const grResult = await goodsReceiptRepository.getGRById(client, grId);
  if (!grResult) throw new Error(`Goods receipt ${grId} not found`);
  const { gr, items } = grResult;

  if (gr.status !== 'DRAFT') {
    throw new Error('Can only sync lines for DRAFT goods receipts');
  }
  if (!gr.purchaseOrderId) {
    throw new Error('Goods receipt is not linked to a purchase order');
  }

  await assertPOAllowsReceiving(client, gr.purchaseOrderId);

  const poDetail = await purchaseOrderRepository.getPOById(client, gr.purchaseOrderId);
  if (!poDetail) throw new Error(`Purchase order ${gr.purchaseOrderId} not found`);

  interface POItemRow {
    id: string;
    product_id?: string;
    productId?: string;
    product_name?: string;
    productName?: string;
    ordered_quantity?: number;
    quantity?: number;
    unit_price?: number;
    unitCost?: number;
    uom_id?: string | null;
    uomId?: string | null;
  }

  const poItems = (poDetail.items || []) as POItemRow[];
  if (poItems.length === 0) {
    throw new Error('Purchase order has no line items to receive');
  }

  const linkedPoItemIds = new Set(
    items.map((row) => row.poItemId).filter((id): id is string => !!id)
  );

  const toInsert: CreateGRItemData[] = poItems
    .filter((poi) => !linkedPoItemIds.has(poi.id))
    .map((poi) => {
      const productId = poi.product_id ?? poi.productId;
      if (!productId) {
        throw new Error(`PO line ${poi.id} is missing product_id`);
      }
      return {
        goodsReceiptId: gr.id,
        poItemId: poi.id,
        productId,
        productName: poi.product_name ?? poi.productName ?? 'Unknown Product',
        orderedQuantity: Money.parseDb(poi.ordered_quantity ?? poi.quantity ?? 0).toNumber(),
        receivedQuantity: 0,
        unitCost: Money.parseDb(poi.unit_price ?? poi.unitCost ?? 0).toNumber(),
        batchNumber: null,
        expiryDate: null,
        uomId: poi.uom_id ?? poi.uomId ?? null,
      };
    });

  if (toInsert.length === 0) {
    return 0;
  }

  await goodsReceiptRepository.addGRItems(client, toInsert);
  return toInsert.length;
}

export const goodsReceiptService = {
  /**
   * Create goods receipt with items (DRAFT state, manual or from PO)
   * @param pool - Database connection pool
   * @param data - GR creation data (PO linkage, items with batches/expiry, receipt date)
   * @returns Created GR with items and auto-generated manual PO (if supplier provided)
   * @throws Error if validation fails or PO not found
   *
   * Receipt Modes:
   * - **From Purchase Order**: Link to existing PO, validate item references
   * - **Manual Receipt**: Auto-generate "manual" PO if supplierId provided (no PO reference)
   *
   * Business Rules:
   * - BR-INV-002: Received quantity must be positive
   * - BR-INV-005: Batch/expiry tracking for perishables
   * - Manual receipts auto-create PO with source='MANUAL' flag
   *
   * Transaction Flow:
   * 1. If manual (no PO), create auto-generated manual PO
   * 2. Create GR header with DRAFT status
   * 3. Validate and insert GR items with batch/expiry
   * 4. Link GR items to PO items (if applicable)
   * 5. Commit transaction atomically
   *
   * Note: GR remains DRAFT until finalize(), which updates inventory and cost layers
   */
  async createGR(
    pool: Pool,
    data: Omit<CreateGRData, 'notes'> & { notes?: string | null; supplierId?: string | null } & {
      items: Array<{
        poItemId?: string | null;
        productId: string;
        productName: string;
        orderedQuantity: number;
        receivedQuantity: number;
        unitCost: number;
        batchNumber?: string | null;
        expiryDate?: string | null;
        uomId?: string | null;
      }>;
    }
  ): Promise<CreateGRResult> {
    const txResult = await UnitOfWork.run(pool, async (client) => {
      let purchaseOrderId = data.purchaseOrderId || null;
      let manualPO = null;

      if (purchaseOrderId) {
        await assertPOAllowsReceiving(client, purchaseOrderId);
      }

      // If supplierId provided without purchaseOrderId, create auto-generated manual PO
      if (!purchaseOrderId && data.supplierId) {
        logger.info(`Creating manual PO for supplier ${data.supplierId}`);

        await PurchaseOrderBusinessRules.validateSupplierExists(client, data.supplierId);

        // Prepare PO items from GR items (UoM snapshot matches purchaseOrderService.createPO)
        const poItems: CreatePOItemData[] = [];
        for (const item of data.items) {
          const { baseUomId, conversionFactor } = await resolveCanonicalProductUom(
            item.productId,
            item.uomId,
            client,
          );
          const baseQty = PricingEngine.calculateBaseQuantity(item.receivedQuantity, conversionFactor).toNumber();
          const baseUnitCost = PricingEngine.normalizeDisplayUnitCost(item.unitCost, conversionFactor);
          const canonicalLineTotal = PricingEngine.calculateDocumentLineFromBase(
            baseQty,
            baseUnitCost.toNumber(),
          ).toNumber();

          poItems.push({
            purchaseOrderId: '',
            productId: item.productId,
            productName: item.productName,
            quantity: item.receivedQuantity,
            unitCost: Money.toNumber(new Decimal(item.unitCost)),
            lineTotal: canonicalLineTotal,
            uomId: item.uomId || null,
            baseQty,
            baseUomId,
            conversionFactor,
          });
        }

        const manualTotal = Money.toNumber(poItems.reduce(
          (sum, item) => sum.plus(new Decimal(item.lineTotal ?? 0)),
          new Decimal(0),
        ));
        await assertSupplierCreditHeadroom(
          client,
          data.supplierId,
          manualTotal,
          'manual goods receipt',
        );

        // Create manual PO with items
        const poResult = await purchaseOrderRepository.createManualPO(client, {
          supplierId: data.supplierId,
          orderDate: data.receiptDate,
          expectedDate: data.receiptDate, // Same as receipt date for manual
          notes: data.notes || `Auto-generated from manual goods receipt`,
          createdBy: data.receivedBy,
          items: poItems,
        });

        manualPO = poResult.po;
        purchaseOrderId = manualPO.id;

        logger.info(`Created manual PO ${manualPO.poNumber} for manual goods receipt`);

        // Update items with poItemId references
        data.items.forEach((grItem, index) => {
          grItem.poItemId = poResult.items[index]?.id || null;
          grItem.orderedQuantity = grItem.receivedQuantity; // Set ordered = received for manual
        });
      }

      // Create GR header (now with purchaseOrderId from manual PO if created)
      const gr = await goodsReceiptRepository.createGR(client, {
        purchaseOrderId: purchaseOrderId,
        receiptDate: data.receiptDate,
        notes: data.notes ?? null,
        receivedBy: data.receivedBy,
        source: data.supplierId && !data.purchaseOrderId ? 'MANUAL' : 'PURCHASE_ORDER',
      });

      // Validate and insert items
      const itemsToInsert: CreateGRItemData[] = [];

      // ========== BATCH PRE-FETCH (N+1 elimination) ==========
      const grProductIds = data.items.map((it) => it.productId);
      const grProductsMap = await batchFetchProducts(client, grProductIds);

      for (const it of data.items) {
        const orderedQty = it.orderedQuantity;
        const receivedQty = it.receivedQuantity;
        const unitCost = it.unitCost;
        const expiry = it.expiryDate ?? null;

        const productData = grProductsMap.get(it.productId);

        // BR-INV-011: Validate item completeness (expiry only when track_expiry)
        const trackExpiry = !!(productData?.track_expiry);
        InventoryBusinessRules.validateGRItemCompleteness({
          productId: it.productId,
          receivedQuantity: receivedQty,
          unitCost: unitCost,
          batchNumber: it.batchNumber || null,
          expiryDate: expiry,
          trackExpiry,
        });
        if (receivedQty > 0) {
          logger.info('BR-INV-011: GR item completeness validation passed', {
            productId: it.productId,
          });

          // BR-INV-002: Validate positive quantity
          InventoryBusinessRules.validatePositiveQuantity(receivedQty, 'goods receipt item');
        }

        // BR-PO-003: Validate unit cost
        PurchaseOrderBusinessRules.validateUnitCost(unitCost);

        // BR-PO-006: PO-linked qty — open PO qty billable; excess is bonus (free)
        if (purchaseOrderId && !manualPO && receivedQty > 0) {
          const poAlready = Money.parseDb(
            (it as { poAlreadyReceived?: number }).poAlreadyReceived ?? 0
          ).toNumber();
          PurchaseOrderBusinessRules.validateGRReceiptAgainstPO(
            orderedQty,
            poAlready,
            receivedQty,
            !!(it as { isBonus?: boolean }).isBonus
          );
          logger.info('BR-PO-006: GR receipt quantity validated', {
            orderedQty,
            poAlready,
            receivedQty,
          });

          // BR-PO-008: Check quantity variance
          const qtyVariance = PurchaseOrderBusinessRules.validateQuantityVariance(
            orderedQty,
            receivedQty,
            5
          );
          if (qtyVariance.exceeded) {
            logger.warn('BR-PO-008: Quantity variance threshold exceeded', qtyVariance);
          }

          // BR-PO-007: Check cost variance (if base cost exists)
          if (productData && productData.cost_price) {
            const costVariance = PurchaseOrderBusinessRules.validateCostVariance(
              Money.parseDb(productData.cost_price).toNumber(),
              unitCost,
              10
            );
            if (costVariance.exceeded) {
              logger.warn('BR-PO-007: Cost variance threshold exceeded', costVariance);
            }
          }
        }

        // BR-INV-003: Validate expiry date
        if (expiry) {
          InventoryBusinessRules.validateExpiryDate(expiry, false);
          logger.info('BR-INV-003: Expiry date validation passed', {
            expiryDate: expiry,
          });

          // BR-INV-008: Reject short expiry items
          InventoryBusinessRules.validateShortExpiry(expiry, 7);
          logger.info('BR-INV-008: Short expiry validation passed');

          // BR-INV-007: Warn if expiring soon
          const expiryWarning = InventoryBusinessRules.validateExpiryWarning(expiry, 30);
          if (expiryWarning) {
            logger.warn('BR-INV-007: Item expiring within 30 days', {
              productName: it.productName,
              expiryDate: expiry,
            });
          }

          // BR-INV-010: Check batch expiry sequence
          await InventoryBusinessRules.validateBatchExpirySequence(client, it.productId, expiry);
        }

        // BR-PO-010: Validate batch number uniqueness
        if (it.batchNumber) {
          await PurchaseOrderBusinessRules.validateBatchNumber(
            client,
            it.productId,
            it.batchNumber
          );
        }

        const { baseUomId: grBaseUomId, conversionFactor: grConversionFactor } = await resolveCanonicalProductUom(
          it.productId,
          it.uomId,
          client,
        );
        const grBaseQty = PricingEngine.calculateBaseQuantity(receivedQty, grConversionFactor).toNumber();

        itemsToInsert.push({
          goodsReceiptId: gr.id,
          poItemId: it.poItemId || null,
          productId: it.productId,
          productName: it.productName,
          orderedQuantity: orderedQty,
          receivedQuantity: receivedQty,
          unitCost,
          batchNumber: it.batchNumber ?? null,
          expiryDate: expiry,
          uomId: it.uomId || null,
          baseQty: grBaseQty,
          baseUomId: grBaseUomId,
          conversionFactor: grConversionFactor,
          targetStoreLocationId: (it as { targetStoreLocationId?: string | null }).targetStoreLocationId ?? null,
        });
      }

      await goodsReceiptRepository.addGRItems(client, itemsToInsert);

      // Document Flow: PO → Goods Receipt
      if (purchaseOrderId) {
        await documentFlowService.linkDocuments(client, 'PURCHASE_ORDER', purchaseOrderId, 'GOODS_RECEIPT', gr.id, 'FULFILLS');
      }

      return {
        grId: gr.id,
        manualPOData: manualPO
          ? {
            id: manualPO.id,
            poNumber: manualPO.poNumber,
            supplierId: manualPO.supplierId,
            status: manualPO.status,
            totalAmount: manualPO.totalAmount,
          }
          : undefined,
      };
    });

    // Return via repository to include joins/aliases if needed
    const full = await goodsReceiptRepository.getGRById(pool, txResult.grId);
    if (!full) throw new Error(`Goods receipt ${txResult.grId} not found after creation`);

    return {
      gr: full.gr,
      items: full.items,
      manualPO: txResult.manualPOData,
    };
  },

  // Finalize a goods receipt: create batches, stock movements, cost layers, pricing updates
  async finalizeGR(pool: Pool, id: string): Promise<FinalizeGRResult> {
    const { alerts, warnings, linkedSiblingBill } = await UnitOfWork.run(pool, async (client) => {
      const warnings: string[] = [];
      let linkedSiblingBill: FinalizeGRResult['linkedSiblingBill'] = null;

      const grResult = await goodsReceiptRepository.getGRById(client, id);
      if (!grResult) throw new Error(`Goods receipt ${id} not found`);

      const { gr, items } = grResult;

      // TIMESTAMPTZ columns return Date objects from pg driver — coerce to YYYY-MM-DD string
      // The custom type parser only handles DATE (OID 1082), not TIMESTAMPTZ
      if (gr.receivedDate && typeof gr.receivedDate !== 'string') {
        gr.receivedDate = formatDateBusiness(gr.receivedDate as unknown as Date);
      }

      // Lock the GR row to prevent double-finalization by concurrent requests
      await client.query(`SELECT id FROM goods_receipts WHERE id = $1 FOR UPDATE`, [id]);

      // High-level validations before side effects
      if (gr.status === 'COMPLETED') throw new Error('Goods receipt is already completed');
      if (gr.status === 'CANCELLED') {
        throw new Error('Cannot finalize a cancelled goods receipt');
      }

      if (gr.purchaseOrderId) {
        await assertPOAllowsReceiving(client, gr.purchaseOrderId);
      }

      // Must have items
      if (!Array.isArray(items) || items.length === 0) {
        throw new Error('Cannot finalize a goods receipt with no items');
      }

      // Every item must have positive received quantity (no zero or negative lines)
      const nonPositiveLines = items
        .map((item) => ({
          name: item.productName ?? 'Unknown product',
          qty: Money.parseDb(item.receivedQuantity).toNumber(),
        }))
        .filter((x) => !Number.isFinite(x.qty) || x.qty <= 0);
      if (nonPositiveLines.length > 0) {
        const names = nonPositiveLines.map((x) => x.name).join(', ');
        throw new Error(`All items must have received quantity > 0. Fix: ${names}`);
      }

      // Collect per-item validation errors (do not mutate state yet)
      const finProductIds = [...new Set(items.map((i) => i.productId))];
      const finProductsMap = await batchFetchProducts(client, finProductIds);

      const preValidationErrors: string[] = [];
      for (const item of items) {
        const productName: string = item.productName ?? 'Unknown product';
        const receivedQty: number = Money.parseDb(item.receivedQuantity).toNumber();
        const unitCost: number = Money.parseDb(item.unitCost).toNumber();
        const expiryDate: string | null = item.expiryDate || null;
        const trackExpiry = !!(finProductsMap.get(item.productId)?.track_expiry);
        const poUnitPrice = Money.parseDb(item.poUnitPrice ?? 0).toNumber();
        const isBonusLine = !!item.isBonus;

        if (receivedQty <= 0)
          preValidationErrors.push(`${productName}: received quantity must be greater than 0`);
        if (!Number.isFinite(unitCost) || unitCost < 0)
          preValidationErrors.push(`${productName}: unit cost cannot be negative`);
        if (expiryDate && expiryDate < getBusinessDate())
          preValidationErrors.push(`${productName}: expiry date cannot be in the past`);
        if (trackExpiry && receivedQty > 0 && (!expiryDate || String(expiryDate).trim() === '')) {
          preValidationErrors.push(`${productName}: Expiry date is required`);
        }
        // Extra/missing-zero typo vs PO unit price (billable lines only)
        if (
          !isBonusLine &&
          poUnitPrice > 0 &&
          unitCost > 0 &&
          isLikelyGrnBillDigitShiftTypo(poUnitPrice, unitCost)
        ) {
          preValidationErrors.push(
            `${productName}: unit cost ${unitCost} looks like a digit/zero typo vs PO price ${poUnitPrice} — correct before finalize`,
          );
        }
      }

      if (preValidationErrors.length > 0) {
        throw new Error(`Validation failed: ${preValidationErrors.join('; ')}`);
      }

      const grNumber: string = gr.grNumber ?? '';
      const receivedBy: string = gr.receivedBy ?? '';

      const alerts: CostPriceChangeAlert[] = [];
      // Collect cost layer data to process AFTER main transaction commits
      // This prevents nested transactions and connection pool exhaustion
      const costLayerData: Array<{
        productId: string;
        quantity: number;
        unitCost: number;
        goodsReceiptId: string;
        batchNumber: string;
      }> = [];

      // Tell the fn_log_stock_movement trigger to skip — the app code below
      // already creates proper MOV- stock movements alongside batch inserts.
      // Without this guard the trigger creates duplicate SM- movements for each batch INSERT.
      await client.query("SET LOCAL app.skip_stock_movement_trigger = 'true'");

      const inventoryCouplingBefore = await captureInventoryCoupling(client);

      // Inventory SSOT for lot-based GRN: LotService.receiveLot (master + projection + store allocation).
      // StockMovementHandler GOODS_RECEIPT targets MAIN-batch adjustments only and does not
      // support per-lot expiry, bonus splits, or multistore inventory_balances coupling.

      for (const item of items) {
        const productId: string = item.productId;
        const productName: string = item.productName;
        const poItemId: string | null = item.poItemId ?? null;
        const orderedQty: number = Money.parseDb(item.orderedQuantity).toNumber();
        const receivedQty: number = Money.parseDb(item.receivedQuantity).toNumber();
        const unitCost: number = Money.parseDb(item.unitCost).toNumber();
        const isFullLineBonus: boolean = !!item.isBonus;
        const poAlreadyReceived: number = Money.parseDb(
          (item as GoodsReceiptItem & { poAlreadyReceived?: number }).poAlreadyReceived ?? 0
        ).toNumber();

        if (receivedQty <= 0) continue;

        const receiptSplit = gr.purchaseOrderId
          ? PurchaseOrderBusinessRules.validateGRReceiptAgainstPO(
              orderedQty,
              poAlreadyReceived,
              receivedQty,
              isFullLineBonus
            )
          : {
              billableQty: isFullLineBonus ? 0 : receivedQty,
              bonusQty: isFullLineBonus ? receivedQty : 0,
              openQty: orderedQty,
            };

        type ReceiptSegment = { qty: number; isBonusSegment: boolean };
        const segments: ReceiptSegment[] = [];
        if (isFullLineBonus) {
          segments.push({ qty: receivedQty, isBonusSegment: true });
        } else {
          if (receiptSplit.billableQty > 0) {
            segments.push({ qty: receiptSplit.billableQty, isBonusSegment: false });
          }
          if (receiptSplit.bonusQty > 0) {
            segments.push({ qty: receiptSplit.bonusQty, isBonusSegment: true });
          }
        }

        // MUoM SSOT: re-resolve conversion via uomService (no silent factor=1 fallback)
        const lineUomId = item.uomId ?? null;
        const resolvedUom = await resolveCanonicalProductUom(productId, lineUomId, client);
        const finConversionFactor = resolvedUom.conversionFactor;
        const finBaseUomId: string | null = item.baseUomId ?? resolvedUom.baseUomId;

        const expiryDate: string | null = item.expiryDate || null;
        const trackExpiry = !!(finProductsMap.get(productId)?.track_expiry);
        InventoryBusinessRules.validatePositiveQuantity(receivedQty, 'goods receipt item');
        PurchaseOrderBusinessRules.validateUnitCost(unitCost);
        InventoryBusinessRules.validateGRItemCompleteness({
          productId,
          receivedQuantity: receivedQty,
          unitCost,
          batchNumber: item.batchNumber ?? null,
          expiryDate,
          trackExpiry,
        });
        if (expiryDate) InventoryBusinessRules.validateExpiryDate(expiryDate, false);

        for (const segment of segments) {
          const segmentQty = segment.qty;
          const isBonus = segment.isBonusSegment;
          const baseQty = PricingEngine.calculateBaseQuantity(segmentQty, finConversionFactor).toNumber();
          const baseCostPerUnit: number = isBonus
            ? 0
            : PricingEngine.normalizeDisplayUnitCost(unitCost, finConversionFactor).toNumber();

          let batchNumber: string = item.batchNumber ?? '';
          if (!batchNumber || segments.length > 1) {
            const dateStr = getBusinessDate().replace(/-/g, '');
            const prefix = `BATCH-${dateStr}-`;
            await client.query(`SELECT pg_advisory_xact_lock(hashtext('batch_number_seq'))`);
            const seqResult = await client.query(
              `SELECT COALESCE(MAX(CAST(SUBSTRING(batch_number FROM $2) AS INTEGER)), 0) + 1 AS next_seq
               FROM inventory_batches 
               WHERE batch_number LIKE $1`,
              [`${prefix}%`, `${prefix.replace(/-/g, '\\-')}(\\d+)`]
            );
            const seqNum = (seqResult.rows[0]?.next_seq || 1).toString().padStart(3, '0');
            batchNumber = `${prefix}${seqNum}${isBonus ? '-B' : ''}`;
          }

          if (!isBonus) {
            const prodRes = await client.query(
              'SELECT p.name, pv.cost_price FROM products p LEFT JOIN product_valuation pv ON pv.product_id = p.id WHERE p.id = $1',
              [productId]
            );
            const previousCostNum: number = prodRes.rows.length
              ? Money.parseDb(prodRes.rows[0].cost_price).toNumber()
              : 0;

            if (Number.isFinite(previousCostNum) && previousCostNum !== baseCostPerUnit) {
              const prev = new Decimal(previousCostNum);
              const next = new Decimal(baseCostPerUnit);
              const changeAmount = next.minus(prev);
              const changePct = prev.eq(0) ? new Decimal(100) : changeAmount.div(prev).times(100);
              alerts.push({
                productId,
                productName,
                previousCost: prev.toNumber(),
                newCost: next.toNumber(),
                changeAmount: changeAmount.toNumber(),
                changePercentage: changePct.toNumber(),
                batchNumber,
              });
            }
          }

          const lot = await lotService.receiveLot(client, {
            productId,
            lotNumber: batchNumber,
            quantity: baseQty,
            costPrice: baseCostPerUnit,
            attributes: {
              receivedDate: getBusinessDate(),
              expiryDate,
            },
            sourceType: 'GOODS_RECEIPT',
            goodsReceiptId: gr.id,
            goodsReceiptItemId: item.id ?? null,
            purchaseOrderId: gr.purchaseOrderId ?? null,
            purchaseOrderItemId: poItemId ?? null,
            targetStoreLocationId: item.targetStoreLocationId ?? null,
            isBonus,
            userId: receivedBy || 'system',
          });

          await syncProductQuantity(client, productId);

          const movementNumber = await allocateNextMovementNumber(client);

          await client.query(
            `INSERT INTO stock_movements (
              movement_number, product_id, batch_id, movement_type, quantity, unit_cost,
              reference_type, reference_id, notes, created_by_id,
              entered_qty, base_uom_id, conversion_factor
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
            [
              movementNumber,
              productId,
              lot.id,
              'GOODS_RECEIPT',
              baseQty,
              baseCostPerUnit,
              'GOODS_RECEIPT',
              gr.id,
              `GR ${grNumber || gr.id} - Batch ${batchNumber}${isBonus ? ' (BONUS)' : ''}`,
              receivedBy || null,
              segmentQty,
              finBaseUomId,
              finConversionFactor,
            ]
          );

          if (!isBonus) {
            costLayerData.push({
              productId,
              quantity: baseQty,
              unitCost: baseCostPerUnit,
              goodsReceiptId: gr.id,
              batchNumber,
            });
          }
        }

        if (poItemId) {
          await goodsReceiptRepository.updatePOItemReceivedQuantity(client, poItemId, receivedQty);
        } else {
          logger.warn('No PO item ID found for GR item', { productId, productName });
        }
      }

      // ============================================================
      // SUPPLIER PRICE TRACKING
      // Auto-update supplier_product_prices for each product received
      // SAP: Store base-unit cost so ProcurementSearch returns consistent values
      // ============================================================
      const supplierId = gr.supplierId ?? null;
      const receiptDateStr: string = gr.receivedDate ?? '';
      if (supplierId) {
        for (const item of items) {
          // Only track non-bonus items for price history (bonus = free goods, not real pricing)
          if (!item.isBonus && Money.parseDb(item.unitCost).toNumber() > 0) {
            try {
              // Normalize to base-unit cost before storing
              const itemConvFactor = Number(item.conversionFactor) || 1;
              const supplierBaseCost = PricingEngine.normalizeDisplayUnitCost(
                Money.parseDb(item.unitCost).toString(),
                itemConvFactor,
              ).toNumber();
              await supplierProductPriceRepository.upsertSupplierPrice(
                client,
                supplierId,
                item.productId,
                supplierBaseCost,
                receiptDateStr || null
              );
            } catch (priceErr: unknown) {
              const errMsg = priceErr instanceof Error ? priceErr.message : String(priceErr);
              logger.warn('Failed to track supplier price (non-fatal)', {
                supplierId,
                productId: item.productId,
                error: errMsg,
              });
            }
          }
        }
      }

      // Complete the GR
      await goodsReceiptRepository.finalizeGR(client, id);

      // Align PO PENDING ↔ COMPLETED from net-received SSOT (sole sync writer)
      const { syncPOStatusWithReceipts } = await import(
        '../purchase-orders/poReceiptStatusSync.js'
      );
      await syncPOStatusWithReceipts(client, gr.purchaseOrderId);

      // ============================================================
      // SYSTEM RULE: GRN does NOT create Accounts Payable.
      // The GL posting below (GRIR Clearing) is the only GRN GL entry.
      // AP (2100) is created only when a Supplier Invoice is posted
      // via the 3-way match workflow (POST /supplier-payments/invoices/:id/post).
      // ============================================================
      const totalAmountDec = items.reduce((sum: Decimal, item: GoodsReceiptItem) => {
        const receivedQty = Money.parseDb(item.receivedQuantity).toNumber();
        const orderedQty = Money.parseDb(item.orderedQuantity).toNumber();
        const poAlready = Money.parseDb(
          (item as GoodsReceiptItem & { poAlreadyReceived?: number }).poAlreadyReceived ?? 0
        ).toNumber();
        const split = gr.purchaseOrderId
          ? PurchaseOrderBusinessRules.validateGRReceiptAgainstPO(
              orderedQty,
              poAlready,
              receivedQty,
              !!item.isBonus
            )
          : { billableQty: item.isBonus ? 0 : receivedQty, bonusQty: 0, openQty: orderedQty };
        if (split.billableQty <= 0) return sum;
        const cost = new Decimal(String(item.unitCost ?? 0));
        return sum.plus(new Decimal(split.billableQty).times(cost));
      }, new Decimal(0));
      const totalAmount = Money.toNumber(totalAmountDec);

      // ============================================================
      // PRE-COMMIT: Create cost layers and update pricing
      // Must run inside transaction for atomicity with inventory changes
      // ============================================================
      for (const costData of costLayerData) {
        try {
          await costLayerService.createCostLayer(costData, undefined, client);
          await pricingService.onCostChange(costData.productId, pool);
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          logger.error('Cost layer creation failed — GR finalize rolled back', {
            grId: id,
            grNumber,
            productId: costData.productId,
            quantity: costData.quantity,
            unitCost: costData.unitCost,
            error: errMsg,
          });
          throw new ValidationError(
            `Cost layer creation failed for product ${costData.productId}: ${errMsg}. ` +
              'GR finalize aborted to prevent FIFO/AVCO valuation drift.',
          );
        }
      }

      // ============================================================
      // SYNC products.cost_price from product_valuation
      // SAP/Odoo pattern: GR receipt updates the product master cost
      // FIFO/STANDARD → last_cost, AVCO → average_cost
      // ============================================================
      const costLayerProductIds = [...new Set(costLayerData.map((d) => d.productId))];
      if (costLayerProductIds.length > 0) {
        try {
          // SAP MAP / Odoo AVCO: the effective cost (MAP for AVCO, last purchase for FIFO)
          // becomes the product's displayed cost_price so the UI always reflects reality.
          await client.query(
            `UPDATE product_valuation pv
             SET cost_price = CASE
               WHEN pv.costing_method = 'AVCO' THEN pv.average_cost
               ELSE pv.last_cost
             END,
             updated_at = CURRENT_TIMESTAMP
             WHERE pv.product_id = ANY($1)
               AND pv.last_cost > 0`,
            [costLayerProductIds]
          );
          await client.query(
            `UPDATE products p
             SET cost_price = CASE
               WHEN pv.costing_method = 'AVCO' THEN pv.average_cost
               ELSE pv.last_cost
             END,
             updated_at = CURRENT_TIMESTAMP
             FROM product_valuation pv
             WHERE pv.product_id = p.id
               AND p.id = ANY($1)
               AND pv.last_cost > 0`,
            [costLayerProductIds]
          );
          logger.info('Synced cost_price (product_valuation + products master) from GRN', {
            grId: id,
            productCount: costLayerProductIds.length,
          });
        } catch (syncErr: unknown) {
          const errMsg = syncErr instanceof Error ? syncErr.message : String(syncErr);
          logger.error('Failed to sync products.cost_price from valuation', {
            grId: id,
            error: errMsg,
          });
          warnings.push(`Product cost sync failed: ${errMsg}`);
        }
      }

      // ============================================================
      // SUPPLIER BALANCE: Recalculate from source (Odoo compute pattern)
      // Replaces trg_sync_supplier_on_gr_complete / trg_sync_supplier_balance_on_gr
      // ============================================================
      if (supplierId) {
        await recalcSupplierBalance(client, supplierId);
      }

      // ============================================================
      // STATE TABLES: Inventory balances + Supplier balances
      // Atomically maintained inside posting transaction (SAP pattern)
      // Batch UPSERTs: 1 query per table instead of N per item (100M-scale)
      // SAVEPOINT: prevents PG aborted-transaction if this fails
      // ============================================================
      try {
        await client.query('SAVEPOINT gr_state_tables');

        // Pre-aggregate by productId for batch UPSERT
        const invMap = new Map<string, Decimal>();
        for (const item of items) {
          const receivedQty = Money.parseDb(item.receivedQuantity);
          if (receivedQty.lte(0) || !item.productId) continue;
          const existing = invMap.get(item.productId);
          invMap.set(item.productId, (existing || new Decimal(0)).plus(receivedQty));
        }

      } catch (stateError: unknown) {
        await client.query('ROLLBACK TO SAVEPOINT gr_state_tables');
        logger.error('State table update failed during GR — will be healed by reconciliation', {
          grId: id,
          grNumber,
          error: stateError instanceof Error ? stateError.message : String(stateError),
        });
      }

      // ============================================================
      // GL POSTING — INSIDE transaction (SAP LUW: stock receipt → FI from subledger)
      // DR Inventory (1300), CR GRN/IR Clearing (2150)
      // Amount = batch subledger increase (not PO line JS total).
      // ============================================================
      const couplingAfterReceipt = await captureInventoryCoupling(client);
      const glInventoryAmount = resolveGl1300FromBatchSubledgerDelta(
        inventoryCouplingBefore,
        couplingAfterReceipt,
        'receipt',
      );

      if (documentTotalDiffersFromSubledger(totalAmount, glInventoryAmount)) {
        logger.warn('[GR] PO line total differs from batch subledger increase — posting GL from subledger', {
          grId: id,
          grNumber,
          poLineTotal: totalAmount,
          batchSubledgerIncrease: glInventoryAmount,
        });
      }

      if (glInventoryAmount > 0 && supplierId) {
        const supplierRes = await client.query(
          'SELECT "CompanyName" FROM suppliers WHERE "Id" = $1',
          [supplierId]
        );
        const supplierName = supplierRes.rows[0]?.CompanyName || 'Unknown Supplier';

        await glEntryService.recordGoodsReceiptToGL(
          {
            grId: id,
            grNumber: grNumber || id,
            grDate: gr.receivedDate || getBusinessDate(),
            totalAmount: glInventoryAmount,
            supplierId,
            supplierName,
            poNumber: gr.purchaseOrderId || undefined,
          },
          undefined, // pool — not needed when txClient is provided
          client,    // atomic: GL commits/rolls back with inventory
        );
      }

      assertInventoryCouplingUnchanged(
        inventoryCouplingBefore,
        await captureInventoryCoupling(client),
        `goods receipt ${grNumber || id}`,
      );

      if (gr.purchaseOrderId) {
        const siblingBill = await goodsReceiptRepository.findPoSiblingSupplierBill(
          client,
          gr.purchaseOrderId,
          id,
        );
        if (siblingBill) {
          const existingLink = await client.query(
            `SELECT 1 FROM supplier_invoice_grn_links WHERE grn_id = $1 LIMIT 1`,
            [id],
          );
          if (existingLink.rows.length === 0) {
            await linkInvoiceToGRNs(client, siblingBill.invoiceId, [id]);
            linkedSiblingBill = siblingBill;
            warnings.push(
              `Top-up receipt linked to existing supplier bill ${siblingBill.invoiceNumber} ` +
                `from ${siblingBill.grnNumber} — no new supplier invoice for this PO.`,
            );
            logger.info('Follow-up GR linked to PO sibling supplier bill', {
              grId: id,
              poId: gr.purchaseOrderId,
              ...siblingBill,
            });
          }
        }
      }

      return { alerts, warnings, linkedSiblingBill };
    });

    // Reload completed GR for response
    const finalized = await goodsReceiptRepository.getGRById(pool, id);
    if (!finalized) throw new Error(`Goods receipt ${id} not found after finalization`);

    publishNotificationEvent({
      pool,
      typeKey: 'GOODS_RECEIVED',
      entityType: 'goods_receipt',
      entityId: id,
      idempotencyKey: `GOODS_RECEIVED:goods_receipt:${id}`,
      payload: { summary: `Goods receipt ${finalized.gr.grNumber} completed`, documentRef: finalized.gr.grNumber },
      actorUserId: finalized.gr.receivedBy || null,
    });

    return {
      gr: finalized.gr,
      items: finalized.items,
      costPriceChangeAlerts: alerts.length > 0 ? alerts : null,
      hasAlerts: alerts.length > 0,
      alertSummary:
        alerts.length > 0 ? `${alerts.length} product(s) with cost price changes` : null,
      warnings: warnings.length > 0 ? warnings : undefined,
      linkedSiblingBill: linkedSiblingBill ?? undefined,
    };
  },

  /** Get GR by ID */
  async getGRById(
    pool: Pool,
    id: string
  ): Promise<{ gr: GoodsReceipt; items: GoodsReceiptItem[]; productUomsMap?: Record<string, unknown[]> }> {
    const result = await goodsReceiptRepository.getGRById(pool, id);
    if (!result) throw new Error(`Goods receipt ${id} not found`);
    return result;
  },

  /** List GRs */
  async listGRs(
    pool: Pool,
    page: number = 1,
    limit: number = 50,
    filters?: {
      status?: string;
      purchaseOrderId?: string;
      search?: string;
      startDate?: string;
      endDate?: string;
      billingStatus?: 'TO_INVOICE' | 'INVOICED' | 'REVERSED';
      sortBy?: string;
      sortOrder?: 'asc' | 'desc';
    }
  ): Promise<ListGRsResult> {
    return goodsReceiptRepository.listGRs(pool, page, limit, filters);
  },

  /** Update a GR item (DRAFT only) */
  async updateGRItem(
    pool: Pool,
    grId: string,
    itemId: string,
    data: UpdateGRItemData
  ): Promise<GoodsReceiptItem> {
    return UnitOfWork.run(pool, async (client) => {
      const existing = await goodsReceiptRepository.getGRItemWithParent(client, itemId);
      if (!existing) throw new Error(`Goods receipt item ${itemId} not found`);
      const { item, gr } = existing;

      if (gr.id !== grId) throw new Error('Item does not belong to the specified goods receipt');
      if (gr.status !== 'DRAFT')
        throw new Error('Cannot update items of a finalized goods receipt');

      if (data.receivedQuantity !== undefined) {
        InventoryBusinessRules.validatePositiveQuantity(
          data.receivedQuantity,
          'goods receipt item'
        );
        // Only validate against ordered quantity when GR is linked to a PO and we have PO-sourced orderedQuantity
        const orderedQty = Money.parseDb(item.orderedQuantity).toNumber();
        if (gr.purchaseOrderId && orderedQty > 0) {
          const poAlready = Money.parseDb(
            (item as GoodsReceiptItem & { poAlreadyReceived?: number }).poAlreadyReceived ?? 0
          ).toNumber();
          PurchaseOrderBusinessRules.validateGRReceiptAgainstPO(
            orderedQty,
            poAlready,
            data.receivedQuantity,
            !!(data.isBonus ?? (item as GoodsReceiptItem).isBonus)
          );
        }
      }

      // Validate unitCost
      if (data.unitCost !== undefined) {
        PurchaseOrderBusinessRules.validateUnitCost(data.unitCost);
        const poUnitPrice = Money.parseDb(item.poUnitPrice ?? 0).toNumber();
        const nextBonus = data.isBonus !== undefined ? !!data.isBonus : !!item.isBonus;
        if (
          !nextBonus &&
          poUnitPrice > 0 &&
          data.unitCost > 0 &&
          isLikelyGrnBillDigitShiftTypo(poUnitPrice, data.unitCost)
        ) {
          throw new ValidationError(
            `${item.productName ?? 'Item'}: unit cost ${data.unitCost} looks like a digit/zero typo vs PO price ${poUnitPrice}`,
          );
        }
      }

      if (data.expiryDate) {
        InventoryBusinessRules.validateExpiryDate(data.expiryDate, false);
      }

      const effectiveQty =
        data.receivedQuantity !== undefined
          ? data.receivedQuantity
          : Money.parseDb(item.receivedQuantity).toNumber();
      const effectiveCost =
        data.unitCost !== undefined ? data.unitCost : Money.parseDb(item.unitCost).toNumber();
      const effectiveExpiry =
        data.expiryDate !== undefined ? data.expiryDate : item.expiryDate ?? null;
      const effectiveUomId =
        data.uomId !== undefined ? data.uomId : item.uomId ?? null;
      const productMap = await batchFetchProducts(client, [item.productId]);
      const trackExpiry = !!(productMap.get(item.productId)?.track_expiry);
      InventoryBusinessRules.validateGRItemCompleteness({
        productId: item.productId,
        receivedQuantity: effectiveQty,
        unitCost: effectiveCost,
        batchNumber: data.batchNumber ?? item.batchNumber ?? null,
        expiryDate: effectiveExpiry,
        trackExpiry,
      });

      const { baseUomId, conversionFactor } = await resolveCanonicalProductUom(
        item.productId,
        effectiveUomId,
        client,
      );
      const updateData = {
        ...data,
        uomId: effectiveUomId,
        baseQty: PricingEngine.calculateBaseQuantity(effectiveQty, conversionFactor).toNumber(),
        baseUomId,
        conversionFactor,
      };

      const updated = await goodsReceiptRepository.updateGRItem(client, itemId, updateData);
      return updated;
    });
  },

  /**
   * Batch update multiple GR items in a single transaction (DRAFT only).
   * Replaces N parallel PUT requests with one.
   */
  async batchUpdateGRItems(
    pool: Pool,
    grId: string,
    items: Array<{
      itemId: string;
      receivedQuantity?: number;
      unitCost?: number;
      batchNumber?: string | null;
      isBonus?: boolean;
      expiryDate?: string | null;
      uomId?: string | null;
      targetStoreLocationId?: string | null;
    }>
  ): Promise<GoodsReceiptItem[]> {
    return UnitOfWork.run(pool, async (client) => {
      // Verify GR exists and is DRAFT (one query for the whole batch)
      const grResult = await goodsReceiptRepository.getGRById(client, grId);
      if (!grResult) throw new Error(`Goods receipt ${grId} not found`);
      const { gr, items: existingItems } = grResult;

      if (gr.status !== 'DRAFT')
        throw new Error('Cannot update items of a finalized goods receipt');

      // Build lookup for existing items
      const itemMap = new Map(existingItems.map((it: GoodsReceiptItem) => [it.id, it]));
      const batchProductIds = [...new Set(existingItems.map((it: GoodsReceiptItem) => it.productId))];
      const batchProductsMap = await batchFetchProducts(client, batchProductIds);

      const results: GoodsReceiptItem[] = [];

      for (const update of items) {
        const existing = itemMap.get(update.itemId);
        if (!existing) throw new Error(`Goods receipt item ${update.itemId} not found in GR ${grId}`);

        // Validate receivedQuantity
        if (update.receivedQuantity !== undefined) {
          InventoryBusinessRules.validatePositiveQuantity(update.receivedQuantity, 'goods receipt item');
          const orderedQty = Money.parseDb(existing.orderedQuantity).toNumber();
          if (gr.purchaseOrderId && orderedQty > 0) {
            const poAlready = Money.parseDb(
              (existing as GoodsReceiptItem & { poAlreadyReceived?: number }).poAlreadyReceived ?? 0
            ).toNumber();
            const isBonus = update.isBonus ?? !!(existing as GoodsReceiptItem).isBonus;
            PurchaseOrderBusinessRules.validateGRReceiptAgainstPO(
              orderedQty,
              poAlready,
              update.receivedQuantity,
              !!isBonus
            );
          }
        }

        // Cost validation
        if (update.unitCost !== undefined) {
          PurchaseOrderBusinessRules.validateUnitCost(update.unitCost);
          const poUnitPrice = Money.parseDb(existing.poUnitPrice ?? 0).toNumber();
          const nextBonus = update.isBonus !== undefined ? !!update.isBonus : !!existing.isBonus;
          if (
            !nextBonus &&
            poUnitPrice > 0 &&
            update.unitCost > 0 &&
            isLikelyGrnBillDigitShiftTypo(poUnitPrice, update.unitCost)
          ) {
            throw new ValidationError(
              `${existing.productName ?? 'Item'}: unit cost ${update.unitCost} looks like a digit/zero typo vs PO price ${poUnitPrice}`,
            );
          }
        }

        if (update.expiryDate) {
          InventoryBusinessRules.validateExpiryDate(update.expiryDate, false);
        }

        const effectiveQty =
          update.receivedQuantity !== undefined
            ? update.receivedQuantity
            : Money.parseDb(existing.receivedQuantity).toNumber();
        const effectiveCost =
          update.unitCost !== undefined
            ? update.unitCost
            : Money.parseDb(existing.unitCost).toNumber();
        const effectiveExpiry =
          update.expiryDate !== undefined ? update.expiryDate : existing.expiryDate ?? null;
        const effectiveUomId =
          update.uomId !== undefined ? update.uomId : existing.uomId ?? null;
        const trackExpiry = !!(batchProductsMap.get(existing.productId)?.track_expiry);
        InventoryBusinessRules.validateGRItemCompleteness({
          productId: existing.productId,
          receivedQuantity: effectiveQty,
          unitCost: effectiveCost,
          batchNumber: update.batchNumber ?? existing.batchNumber ?? null,
          expiryDate: effectiveExpiry,
          trackExpiry,
        });

        const { baseUomId, conversionFactor } = await resolveCanonicalProductUom(
          existing.productId,
          effectiveUomId,
          client,
        );
        const data: UpdateGRItemData = {};
        if (update.receivedQuantity !== undefined) data.receivedQuantity = update.receivedQuantity;
        if (update.unitCost !== undefined) data.unitCost = update.unitCost;
        if (update.batchNumber !== undefined) data.batchNumber = update.batchNumber ?? undefined;
        if (update.expiryDate !== undefined) data.expiryDate = update.expiryDate ?? undefined;
        if (update.isBonus !== undefined) data.isBonus = update.isBonus;
        if (update.uomId !== undefined) data.uomId = update.uomId;
        if (update.targetStoreLocationId !== undefined) {
          data.targetStoreLocationId = update.targetStoreLocationId ?? undefined;
        }
        if (
          update.receivedQuantity !== undefined ||
          update.uomId !== undefined
        ) {
          data.baseQty = PricingEngine.calculateBaseQuantity(effectiveQty, conversionFactor).toNumber();
          data.baseUomId = baseUomId;
          data.conversionFactor = conversionFactor;
        }

        // Only update if there's something to change
        if (Object.keys(data).length > 0) {
          const updated = await goodsReceiptRepository.updateGRItem(client, update.itemId, data);
          results.push(updated);
        }
      }

      return results;
    });
  },

  /**
   * Add a new item to a DRAFT goods receipt
   */
  async addGRItem(
    pool: Pool,
    grId: string,
    data: {
      productId: string;
      productName: string;
      receivedQuantity: number;
      unitCost: number;
      batchNumber?: string | null;
      expiryDate?: string | null;
    }
  ): Promise<GoodsReceiptItem> {
    return UnitOfWork.run(pool, async (client) => {
      const grResult = await goodsReceiptRepository.getGRById(client, grId);
      if (!grResult) throw new Error(`Goods receipt ${grId} not found`);
      const { gr } = grResult;

      if (gr.status !== 'DRAFT')
        throw new Error('Cannot add items to a finalized goods receipt');

      InventoryBusinessRules.validatePositiveQuantity(data.receivedQuantity, 'goods receipt item');
      PurchaseOrderBusinessRules.validateUnitCost(data.unitCost);

      if (data.expiryDate) {
        InventoryBusinessRules.validateExpiryDate(data.expiryDate, false);
      }

      const productMap = await batchFetchProducts(client, [data.productId]);
      const trackExpiry = !!(productMap.get(data.productId)?.track_expiry);
      InventoryBusinessRules.validateGRItemCompleteness({
        productId: data.productId,
        receivedQuantity: data.receivedQuantity,
        unitCost: data.unitCost,
        batchNumber: data.batchNumber ?? null,
        expiryDate: data.expiryDate ?? null,
        trackExpiry,
      });

      const items = await goodsReceiptRepository.addGRItems(client, [{
        goodsReceiptId: grId,
        poItemId: null,
        productId: data.productId,
        productName: data.productName,
        orderedQuantity: 0,
        receivedQuantity: data.receivedQuantity,
        unitCost: data.unitCost,
        batchNumber: data.batchNumber || null,
        expiryDate: data.expiryDate || null,
      }]);

      return items[0];
    });
  },

  /**
   * Remove an item from a DRAFT goods receipt
   */
  async removeGRItem(
    pool: Pool,
    grId: string,
    itemId: string
  ): Promise<void> {
    return UnitOfWork.run(pool, async (client) => {
      const grResult = await goodsReceiptRepository.getGRById(client, grId);
      if (!grResult) throw new Error(`Goods receipt ${grId} not found`);
      const { gr, items } = grResult;

      if (gr.status !== 'DRAFT')
        throw new Error('Cannot remove items from a finalized goods receipt');

      // Verify item belongs to this GR
      const item = items.find((i: GoodsReceiptItem) => i.id === itemId);
      if (!item) throw new Error(`Item ${itemId} not found in goods receipt ${grId}`);

      // Must keep at least one item
      if (items.length <= 1) {
        throw new Error('Cannot remove the last item from a goods receipt. Delete the GR instead.');
      }

      await client.query(
        'DELETE FROM goods_receipt_items WHERE id = $1 AND goods_receipt_id = $2',
        [itemId, grId]
      );
    });
  },

  /** Sync DRAFT GR lines from its Purchase Order (adds any missing PO lines) */
  async hydrateFromPO(
    pool: Pool,
    grId: string
  ): Promise<{ gr: GoodsReceipt; items: GoodsReceiptItem[]; addedCount: number }> {
    let addedCount = 0;

    await UnitOfWork.run(pool, async (client) => {
      addedCount = await syncDraftGRLinesFromPO(client, grId);
    });

    const refreshed = await goodsReceiptRepository.getGRById(pool, grId);
    if (!refreshed) throw new Error(`Goods receipt ${grId} not found after hydration`);
    return { ...refreshed, addedCount };
  },

  /**
   * Cancel a DRAFT goods receipt (Odoo cancel open picking — no stock/GL impact).
   */
  async cancelGR(pool: Pool, id: string): Promise<GoodsReceipt> {
    return UnitOfWork.run(pool, async (client) => {
      const grResult = await goodsReceiptRepository.getGRById(client, id);
      if (!grResult) throw new Error(`Goods receipt ${id} not found`);

      if (grResult.gr.status !== 'DRAFT') {
        throw new Error('Only draft goods receipts can be cancelled');
      }

      return goodsReceiptRepository.cancelGR(client, id);
    });
  },

  /** Preview whether a posted uninvoiced receipt can be fully reversed via Return GRN orchestration. */
  async getReverseUninvoicedEligibility(
    pool: Pool,
    grId: string,
  ): Promise<CorrectionEligibilityResult> {
    return correctionEligibilityService.eligibilityReverseUninvoicedReceipt(pool, grId);
  },

/**
   * Full reverse of a posted goods receipt (one click).
   * Auto-cancels linked unpaid bills (AP/GL), posts full Return GRN, marks GR reversed, PO → DRAFT.
   * Blocked when any linked bill is paid or any received qty is sold/consumed.
   */
  async reverseUninvoicedReceipt(
    pool: Pool,
    grId: string,
    input: { reason: string; userId: string },
  ): Promise<{
    gr: GoodsReceipt;
    returnGrn: { id: string; returnGrnNumber: string; status: string };
    cancelledBills: Array<{ invoiceId: string; invoiceNumber: string; glReversed: boolean }>;
  }> {
    const reason = input.reason?.trim();
    if (!reason) throw new BusinessError('Reversal reason is required', 'ERR_GR_REVERSAL_001');

    const reversed = await UnitOfWork.run(pool, async (client) => {
      await client.query(`SELECT id FROM goods_receipts WHERE id = $1 FOR UPDATE`, [grId]);

      const eligibility = await correctionEligibilityService.eligibilityReverseUninvoicedReceipt(
        client,
        grId,
      );
      if (!eligibility.allowed || eligibility.route !== 'REVERSE_UNINVOICED_RECEIPT') {
        throw new BusinessError(
          eligibility.blockers[0] ?? 'This goods receipt is not eligible for full reverse',
          'ERR_GR_REVERSAL_002',
          { blockers: eligibility.blockers },
        );
      }

      const { planSupplierBillsForGrFullReverse, GR_FULL_REVERSE_REASON_PREFIX } = await import(
        '../../../../shared/domain/grFullReverseSsot.js'
      );
      const { correctionEligibilityRepository } = await import(
        '../corrections/correctionEligibilityRepository.js'
      );
      const { cancelSupplierInvoiceForCorrection } = await import(
        '../supplier-payments/supplierPaymentService.js'
      );

      const linkedBills =
        await correctionEligibilityRepository.getSupplierInvoicesDirectlyLinkedToGrn(client, grId);
      const billPlan = planSupplierBillsForGrFullReverse(linkedBills);
      if (billPlan.blockers.length > 0) {
        throw new BusinessError(billPlan.blockers[0], 'ERR_GR_REVERSAL_004', {
          blockers: billPlan.blockers,
        });
      }

      const cancelledBills: Array<{
        invoiceId: string;
        invoiceNumber: string;
        glReversed: boolean;
      }> = [];
      for (const inv of billPlan.toCancel) {
        const cancelled = await cancelSupplierInvoiceForCorrection(
          pool,
          inv.invoiceId,
          input.userId,
          `${GR_FULL_REVERSE_REASON_PREFIX} ${reason}`,
          {
            client,
            grnId: grId,
            glReasonTag: 'GR_FULL_REVERSE',
            // Paid bills are blocked in planSupplierBillsForGrFullReverse — never unallocate here.
            unallocatePaymentsFirst: false,
          },
        );
        cancelledBills.push(cancelled);
      }

      const returnableSnapshot = await returnGrnRepository.getReturnableItems(client, grId);
      const lines = returnableSnapshot
        .filter((item) => Number(item.returnableQuantity) > 0)
        .map((item) => {
          const factor = Number(item.conversionFactor) || 1;
          const baseQty = Number(item.returnableQuantity);
          const enteredQty = returnGrnPurchaseQuantityFromBase(baseQty, factor);
          return {
            productId: item.productId as string,
            batchId: (item.batchId as string | null) ?? null,
            uomId: (item.uomId as string | null) ?? null,
            quantity: enteredQty,
            unitCost: Number(item.unitCost) || 0,
          };
        });

      if (lines.length === 0) {
        throw new BusinessError('No returnable lines — cannot reverse receipt', 'ERR_GR_REVERSAL_003');
      }

      const { returnGrn } = await returnGrnService.create(
        pool,
        {
          grnId: grId,
          reason: `${GR_FULL_REVERSE_REASON_PREFIX} ${reason}`,
          createdBy: input.userId,
          lines,
        },
        client,
      );

      const posted = await returnGrnService.post(pool, returnGrn.id, client);

      await goodsReceiptRepository.setReversalMetadata(client, grId, {
        reversedByReturnGrnId: posted.id,
        reversalReason: reason,
        reversedByUserId: input.userId,
      });

      logger.info('[GR] Full receipt reverse: bills cancelled + Return GRN posted', {
        grId,
        returnGrnId: posted.id,
        returnGrnNumber: posted.returnGrnNumber,
        cancelledBillCount: cancelledBills.length,
        lineCount: lines.length,
      });

      const refreshed = await goodsReceiptRepository.getGRById(client, grId);
      if (!refreshed) throw new Error(`Goods receipt ${grId} not found after reversal`);

      return {
        gr: refreshed.gr,
        returnGrn: {
          id: posted.id,
          returnGrnNumber: posted.returnGrnNumber,
          status: posted.status,
        },
        cancelledBills,
      };
    });
    publishNotificationEvent({
      pool,
      typeKey: 'GR_REVERSED',
      entityType: 'goods_receipt',
      entityId: grId,
      idempotencyKey: `GR_REVERSED:goods_receipt:${grId}:${reversed.returnGrn.id}`,
      payload: {
        summary: `Goods receipt ${reversed.gr.grNumber} reversed`,
        documentRef: reversed.gr.grNumber,
      },
      actorUserId: input.userId,
    });
    return reversed;
  },

  /** Used by purchase order send/cancel flows inside a shared transaction. */
  syncDraftGRLinesFromPO,
  assertPOAllowsReceiving,

  // ════════════════════════════════════════════════════════════
  // OPENING BALANCE GRN — ERP Opening Inventory (SAP MB1C / Odoo Adjustment)
  // ════════════════════════════════════════════════════════════

  /**
   * Create an Opening Balance Goods Receipt for imported inventory.
   *
   * Per SAP/Odoo/Tally/QuickBooks best practices, opening stock enters the
   * system through a formal Goods Receipt document with a complete audit trail:
   *   - Inventory batch (FEFO-compatible, source_type = OPENING_BALANCE)
   *   - Stock movement (OPENING_BALANCE type)
   *   - Cost layer (FIFO/AVCO)
   *   - GL journal entry: DR Inventory (1300) / CR Opening Balance Equity (3050)
   *
   * For UPDATE re-imports, computes the VALUE delta (handles qty + cost changes)
   * per SAP revaluation pattern — GL reflects economic change, not absolute qty.
   *
   * @param pool - Database connection pool
   * @param items - Products with inventory data (qty > 0)
   * @param userId - User performing the import
   * @param duplicateStrategy - Controls batch upsert behavior (UPDATE = idempotent)
   */
  async createOpeningBalanceGRN(
    pool: Pool,
    items: Array<{
      productId: string;
      productName: string;
      sku: string;
      quantity: number;
      costPrice: number;
      batchNumber?: string;
      expiryDate?: string | null;
    }>,
    userId: string,
    duplicateStrategy: DuplicateStrategy = 'UPDATE'
  ): Promise<{
    grId: string;
    grNumber: string;
    stockMovements: Array<{
      movementId: string;
      movementNumber: string;
      productId: string;
      quantity: number;
      unitCost: number;
      movementValue: number;
    }>;
    warnings: string[];
  }> {
    if (items.length === 0) {
      return { grId: '', grNumber: '', stockMovements: [], warnings: [] };
    }

    const warnings: string[] = [];
    const stockMovements: Array<{
      movementId: string;
      movementNumber: string;
      productId: string;
      batchNumber: string;
      quantity: number;
      unitCost: number;
      movementValue: number;
    }> = [];
    const costLayerData: Array<{
      productId: string;
      quantity: number;
      unitCost: number;
      goodsReceiptId: string;
      batchNumber: string;
    }> = [];

    const openingProductIds = items.map((it) => it.productId);
    const openingProductsMap = await batchFetchProducts(pool, openingProductIds);

    const { grId, grNumber } = await UnitOfWork.run(pool, async (client) => {
      // Tell app.skip_stock_movement_trigger — we create movements explicitly
      await client.query("SET LOCAL app.skip_stock_movement_trigger = 'true'");

      // Create GR header (COMPLETED — no draft→finalize cycle for imports)
      const gr = await goodsReceiptRepository.createGR(client, {
        purchaseOrderId: null,
        receiptDate: getBusinessDate(),
        notes: 'Opening Inventory Import',
        receivedBy: userId,
        source: 'OPENING_BALANCE',
      });

      // Immediately finalize
      await goodsReceiptRepository.finalizeGR(client, gr.id);

      const inventoryCouplingBefore = await captureInventoryCoupling(client);

      // For UPDATE re-imports, capture existing batch state for delta calculation
      const existingBatchState = new Map<string, { qty: number; cost: number }>();
      if (duplicateStrategy === 'UPDATE') {
        const batchKeys = items.map((it) => ({
          productId: it.productId,
          batchNumber:
            it.batchNumber ||
            `IMP-INIT-${it.sku.toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 40)}`,
        }));
        const pids = batchKeys.map((k) => k.productId);
        const bns = batchKeys.map((k) => k.batchNumber);
        const existingResult = await client.query(
          `SELECT product_id, batch_number, remaining_quantity, cost_price
           FROM inventory_batches
           WHERE (product_id, batch_number) IN (
             SELECT UNNEST($1::uuid[]), UNNEST($2::text[])
           )`,
          [pids, bns]
        );
        for (const row of existingResult.rows) {
          const key = `${row.product_id}|${row.batch_number}`;
          existingBatchState.set(key, {
            qty: Money.parseDb(row.remaining_quantity).toNumber(),
            cost: Money.parseDb(row.cost_price).toNumber(),
          });
        }
      }

      // Process each item: batch → movement → qty update → cost layer data
      for (const item of items) {
        const trackExpiry = !!(openingProductsMap.get(item.productId)?.track_expiry);
        InventoryBusinessRules.validateGRItemCompleteness({
          productId: item.productId,
          receivedQuantity: item.quantity,
          unitCost: item.costPrice,
          batchNumber: item.batchNumber ?? null,
          expiryDate: item.expiryDate ?? null,
          trackExpiry,
        });

        const batchNumber =
          item.batchNumber ||
          `IMP-INIT-${item.sku.toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 40)}`;

        const openingReceive = await receiveOpeningLot(client, {
          productId: item.productId,
          lotNumber: batchNumber,
          quantity: item.quantity,
          costPrice: item.costPrice,
          attributes: {
            receivedDate: getBusinessDate(),
            expiryDate: item.expiryDate ?? null,
          },
          sourceType: 'OPENING_BALANCE',
          goodsReceiptId: gr.id,
          duplicateStrategy,
          userId,
        });

        if (openingReceive.skipped || !openingReceive.lot) continue;

        const lot = openingReceive.lot;
        const batchQty = lot.remainingQuantity;
        const batchCost = lot.costPrice;

        // Compute value delta for GL posting
        const existingKey = `${item.productId}|${batchNumber}`;
        const oldState = existingBatchState.get(existingKey);
        const oldQty = oldState?.qty ?? 0;
        const oldCost = oldState?.cost ?? 0;

        const oldValue = Money.lineTotal(oldQty, oldCost);
        const newValue = Money.lineTotal(batchQty, batchCost);
        const valueDelta = Money.toNumber(newValue.minus(oldValue));

        if (valueDelta === 0) continue; // No economic change (identical re-import)

        const qtyDelta = batchQty - oldQty;

        // Movement number: doc_movement_number_seq SSOT
        const movementNumber = await allocateNextMovementNumber(client);

        // Create stock movement
        // SAP UoM snapshot: resolve base UoM for opening balance (always base unit, factor=1)
        const obPuRes = await client.query(
          `SELECT pu.uom_id FROM product_uoms pu WHERE pu.product_id = $1 AND pu.is_default = true LIMIT 1`,
          [item.productId]
        );
        const obBaseUomId: string | null = obPuRes.rows[0]?.uom_id || null;

        const smResult = await client.query(
          `INSERT INTO stock_movements (
            movement_number, product_id, batch_id, movement_type, quantity, unit_cost,
            reference_type, reference_id, notes, created_by_id,
            entered_qty, base_uom_id, conversion_factor
          ) VALUES ($1, $2, $3, 'OPENING_BALANCE'::movement_type, $4, $5,
                    'GOODS_RECEIPT', $6, $7, $8, $9, $10, $11)
          RETURNING id, movement_number`,
          [
            movementNumber,
            item.productId,
            lot.id,
            Math.abs(qtyDelta),
            batchCost,
            gr.id,
            valueDelta > 0
              ? `Opening balance increase (qty ${oldQty}→${batchQty}, cost ${oldCost}→${batchCost})`
              : `Opening balance decrease (qty ${oldQty}→${batchQty}, cost ${oldCost}→${batchCost})`,
            userId,
            Math.abs(qtyDelta), // SAP UoM snapshot: entered qty = base qty for opening balance
            obBaseUomId, // SAP UoM snapshot: base UoM at posting time
            1, // SAP UoM snapshot: opening balance always factor=1
          ]
        );

        const sm = smResult.rows[0];
        stockMovements.push({
          movementId: sm.id as string,
          movementNumber: sm.movement_number as string,
          productId: item.productId,
          batchNumber,
          quantity: Math.abs(qtyDelta),
          unitCost: batchCost,
          movementValue: valueDelta,
        });

        // Update product_inventory.quantity_on_hand from batch totals
        await syncProductQuantity(client, item.productId);

        // Collect cost layer data (processed inside transaction for atomicity)
        costLayerData.push({
          productId: item.productId,
          quantity: Math.abs(qtyDelta),
          unitCost: batchCost,
          goodsReceiptId: gr.id,
          batchNumber,
        });
      }

      // Create cost layers inside transaction
      for (const costData of costLayerData) {
        try {
          await costLayerService.createCostLayer(
            costData,
            undefined,
            client
          );
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          logger.error('Cost layer creation failed for opening balance GRN item', {
            grId: gr.id,
            productId: costData.productId,
            error: errMsg,
          });
          warnings.push(
            `Cost layer failed for product ${costData.productId}: ${errMsg}`
          );
        }
      }

      const couplingAfterImport = await captureInventoryCoupling(client);
      const glInventoryAmount = resolveGl1300FromBatchSubledgerDelta(
        inventoryCouplingBefore,
        couplingAfterImport,
        'receipt',
      );
      const jsMovementTotal = stockMovements.reduce((s, sm) => s + sm.movementValue, 0);

      if (documentTotalDiffersFromSubledger(jsMovementTotal, glInventoryAmount)) {
        logger.warn('[OPENING STOCK] JS movement totals differ from batch subledger — posting GL from SQL delta', {
          grId: gr.id,
          grNumber: gr.grNumber,
          jsMovementTotal,
          batchSubledgerIncrease: glInventoryAmount,
        });
      }

      if (glInventoryAmount !== 0) {
        await glEntryService.recordOpeningStockImportSummaryToGL(
          {
            grId: gr.id,
            grNumber: gr.grNumber || gr.id,
            importDate: getBusinessDate(),
            totalValue: glInventoryAmount,
          },
          pool,
          client,
        );
      }

      assertInventoryCouplingUnchanged(
        inventoryCouplingBefore,
        couplingAfterImport,
        `opening stock import ${gr.grNumber || gr.id}`,
      );

      return { grId: gr.id, grNumber: gr.grNumber || '' };
    });

    return { grId, grNumber, stockMovements, warnings };
  },
};
