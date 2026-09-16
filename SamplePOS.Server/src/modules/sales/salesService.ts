import { Pool } from 'pg';
import {
  salesRepository,
  CreateSaleData,
  CreateSaleItemData,
  SaleRecord,
  SaleItemRecord,
  CreateRefundData,
  CreateRefundItemData,
  RefundRecord,
  RefundItemRecord,
} from './salesRepository.js';
import * as costLayerService from '../../services/costLayerService.js';
import { BankingService } from '../../services/bankingService.js';
import { jobQueue } from '../../services/jobQueue.js';
import { incrementMetric } from '../../routes/health.js';
import {
  createCheckoutProfiler,
  isCheckoutProfileEnabled,
  type CheckoutProfileSnapshot,
} from './checkoutProfiler.js';
import { cashRegisterService, cashRegisterRepository } from '../cash-register/index.js';
import { ValidationError, BusinessError, NotFoundError } from '../../middleware/errorHandler.js';
import logger from '../../utils/logger.js';
import Decimal from 'decimal.js';
import { Money } from '../../utils/money.js';
import { assertAppliedEqualsRequested } from '@shared/domain/invoiceDepositPayment.js';
import { SalesBusinessRules, InventoryBusinessRules } from '../../middleware/businessRules.js';
import { accountingApiClient } from '../../services/accountingApiClient.js';
import * as glEntryService from '../../services/glEntryService.js';
import * as masterDataGuard from '../../services/masterDataGuard.js';
import { checkMaintenanceMode } from '../../utils/maintenanceGuard.js';
import { checkAccountingPeriodOpen } from '../../utils/periodGuard.js';
import { getBusinessDate, getBusinessYear, addDaysToDateString } from '../../utils/dateRange.js';
import type { SaleData, SaleRefundData } from '../../services/glEntryService.js';
import {
  batchFetchProducts,
  type ProductBatchRow,
} from '../../db/batchFetch.js';
import * as stateTablesRepo from '../../repositories/stateTablesRepository.js';
import { syncProductQuantity } from '../../utils/inventorySync.js';
import * as documentFlowService from '../document-flow/documentFlowService.js';
import { getFinalPricesBulk, type ResolvedPrice } from '../pricing/pricingEngineService.js';
import { getCustomerPricingMode } from '../pricing/pricingRepository.js';
import { validateAtCostSalePricing } from './atCostSalePricingGuard.js';
import { publishNotificationEvent } from '../notifications/notificationPublisher.js';
import { DISCOUNT_THRESHOLD_RATIO } from '../notifications/catalog.js';
import { buildProductLineNotificationPayload } from '../notifications/businessNotificationPayload.js';
import { assertQuoteConvertibleForPosSale } from './quoteConvertibilityGuard.js';
import { assertSaleLineNotBelowAllocatedCost } from './saleBelowCostGuard.js';
import { recordSaleLinePriceEvent } from './salePriceAuditService.js';
import {
  previewFefoIssueCostForBaseQty,
  previewFefoIssueLayers,
  type ProductValuationForAtCost,
} from '../pricing/atCostIssuePrice.js';
import { isMultistoreEnabled } from '../inventory/warehouse/multistoreSettings.js';
import { warehouseSaleDeductionService } from '../inventory/warehouse/warehouseSaleDeductionService.js';
import {
  explodeActiveRecipe,
  planSaleStockDeduction,
  type RecipeExplosionLine,
} from './saleRecipeExplosion.js';
import { buffetSessionService } from '../kitchen-production/buffetSessionService.js';
import { lotService } from '../inventory-lot/lotService.js';
import { loadGlobalSelectableLots } from '../inventory-lot/postgresLotSelector.js';
import { selectLots } from '@shared/inventory-lot/index.js';
import { warehouseReturnInventoryService } from '../inventory/warehouse/warehouseReturnInventoryService.js';
import { warehouseSaleVoidRestoreService } from '../inventory/warehouse/warehouseSaleVoidRestoreService.js';
import { allocateNextMovementNumber } from '../../utils/documentNumberAllocation.js';
import type { AuditContext } from '../../../../shared/types/audit.js';
import {
  resolveSaleHeaderTotal,
  deriveUnitPriceFromLineTotal,
} from './saleIntegrity.js';
import {
  DocumentTaxService,
  resolveAuthoritativeTaxAmount,
} from '../../services/documentTaxService.js';
import { loadCustomerTaxProfile } from '../../services/documentTaxRepository.js';
import { logAction } from '../audit/auditService.js';
import { DocumentTaxOverrideSchema, type DocumentTaxOverride } from '../../../../shared/zod/taxOverride.js';
import { resolveSaleItemUom, type SaleItemUomSnapshot } from './saleItemBaseQuantity.js';
import { reconcileSaleCostsToActualBatchDeduction } from '../../utils/cogsDriftGuard.js';
import {
  assertInventoryCouplingUnchanged,
  captureInventoryCoupling,
  documentTotalDiffersFromSubledger,
  INVENTORY_COUPLING_TOLERANCE,
  resolveGl1300FromBatchSubledgerDelta,
} from '../../services/inventorySubledgerCoupling.js';
import { userHasPermission, assertUserPermission } from '../../authorization/serviceAuth.js';

export interface SaleItemInput {
  productId: string;
  productName: string;
  uom?: string; // POS-selected UoM label (name or symbol)
  uomId?: string; // UUID of product_uom used
  quantity: number;
  unitPrice: number;
  discountAmount?: number; // Per-item discount amount
  /** Custom/service lines — DocumentTaxService bridge when no products row */
  isTaxable?: boolean;
  taxRate?: number;
}

export interface PaymentLineInput {
  paymentMethod: 'CASH' | 'CARD' | 'MOBILE_MONEY' | 'AIRTEL_MONEY' | 'CREDIT' | 'DEPOSIT';
  amount: number;
  reference?: string;
}

export interface CreateSaleInput {
  customerId?: string | null;
  quoteId?: string | null; // Link to quotation for auto-conversion workflow
  items: SaleItemInput[];
  subtotal?: number; // Subtotal before tax
  discountAmount?: number; // Discount amount applied to sale
  taxAmount?: number; // Tax amount
  totalAmount?: number; // Total amount (can be provided or calculated)
  paymentMethod: 'CASH' | 'CARD' | 'MOBILE_MONEY' | 'AIRTEL_MONEY' | 'CREDIT' | 'DEPOSIT' | 'BANK_TRANSFER';
  paymentReceived: number;
  soldBy: string;
  saleDate?: string; // ISO 8601 datetime for backdated sales
  paymentLines?: PaymentLineInput[]; // Split payment support
  cashRegisterSessionId?: string; // Link to cash register session for drawer tracking
  idempotencyKey?: string; // Offline sync idempotency key
  offlineId?: string; // Offline sale identifier
  fromOrderId?: string; // POS order ID — if set, mark the order COMPLETED atomically with this sale
  /** Exchange refund document whose store credit is applied as cart discount */
  exchangeRefundId?: string;
  /**
   * When exchange credit exceeds the replacement sale total:
   * - REFUND_ORIGINAL_TENDER: pay residual cash/card matching original sale tender (default)
   * - KEEP_VOUCHER: leave remaining as walk-in store credit (refund number is the voucher)
   */
  exchangeResidualAction?: 'REFUND_ORIGINAL_TENDER' | 'KEEP_VOUCHER';
  /** Optional audit context for price-edit / below-cost audit rows */
  auditContext?: AuditContext;
  /** P4: opt-in phase timings (also CHECKOUT_PROFILE=1 / X-Checkout-Profile). */
  profileCheckout?: boolean;
  /** Phase 5 — privileged DocumentTax override (sales.tax_override + reason). */
  taxOverride?: DocumentTaxOverride;
}

export interface RefundItemInput {
  saleItemId: string;   // UUID of the sale_item to refund
  quantity: number;     // How many units to refund (must be <= remaining refundable qty)
}

export interface RefundSaleInput {
  items: RefundItemInput[];
  reason: string;
  approvedById?: string;
  refundDate?: string; // YYYY-MM-DD, defaults to today
  refundType?: 'REFUND' | 'EXCHANGE';
}

export type ExchangeResidualAction = 'REFUND_ORIGINAL_TENDER' | 'KEEP_VOUCHER';

export interface CompleteProductExchangeInput {
  returnItems: RefundItemInput[];
  reason: string;
  /** Replacement products sold in the same guided exchange (optional if hold/voucher or pure residual refund) */
  replacementItems?: Array<{
    productId: string;
    productName?: string;
    quantity: number;
    unitPrice: number;
  }>;
  /**
   * Required when residual money remains after the replacement (or when no replacement):
   * payout cash/card vs keep numbered voucher.
   */
  residualAction: ExchangeResidualAction;
  /** How customer pays when replacement costs more than returned value */
  topUpPaymentMethod?: 'CASH' | 'CARD' | 'MOBILE_MONEY' | 'AIRTEL_MONEY';
  cashRegisterSessionId?: string;
  soldBy?: string;
}

export const salesService = {
  /**
   * Create a complete sale with items (ATOMIC TRANSACTION)
   * @param pool - Database connection pool
   * @param input - Sale creation data with items, payment, customer
   * @returns Created sale with generated sale_number, profit calculation, and cost layers consumed
   * @throws Error if validation fails or insufficient inventory
   *
   * Business Rules Enforced:
   * - BR-SAL-002: Sale must have at least one item
   * - BR-SAL-003: Credit sales require customer association
   * - BR-INV-001: FIFO cost layer consumption on sale
   * - BR-INV-002: Stock movement audit trail
   *
   * Transaction Flow:
   * 1. Validate sale items and payment method
   * 2. Calculate FIFO cost for each item
   * 3. Create sale record with auto-generated sale_number
   * 4. Create sale_items records
   * 5. Consume cost layers (FIFO)
   * 6. Create stock movement records
   * 7. Commit transaction atomically
   *
   * Financial Precision: Uses Decimal.js for all calculations
   */
  async createSale(
    pool: Pool,
    input: CreateSaleInput,
    tenantId?: string
  ): Promise<{
    sale: SaleRecord;
    items: SaleItemRecord[];
    paymentLines: PaymentLineInput[];
    warnings?: string[];
    checkoutProfile?: CheckoutProfileSnapshot;
  }> {
    const client = await pool.connect();
    const warnings: string[] = [];
    const profiler = createCheckoutProfiler(isCheckoutProfileEnabled(input.profileCheckout));

    try {
      await client.query('BEGIN');
      profiler.mark('begin');

      // Maintenance mode guard (replaces trg_maintenance_check_sales)
      await checkMaintenanceMode(client);

      // Exactly-one settlement: lock order row before inserting sale (order-scoped, not tenant-wide)
      if (input.fromOrderId) {
        const locked = await client.query<{ id: string; status: string; order_number: string }>(
          `SELECT id, status, order_number FROM pos_orders WHERE id = $1 FOR UPDATE`,
          [input.fromOrderId],
        );
        const orderRow = locked.rows[0];
        if (!orderRow) {
          throw new NotFoundError('Order');
        }
        if (orderRow.status !== 'PENDING') {
          throw new BusinessError(
            `Cannot complete order ${orderRow.order_number} — status is ${orderRow.status}`,
            'ERR_ORDER_003',
            { orderId: input.fromOrderId, currentStatus: orderRow.status },
          );
        }
      }
      profiler.mark('order_lock');

      const multistoreEnabled = await isMultistoreEnabled(client);
      let sellingStoreId: string | null = null;
      let priceOverrideCount = 0;
      if (multistoreEnabled) {
        sellingStoreId = await warehouseSaleDeductionService.resolveSellingStoreId(client);
      }

      // ========== POS SESSION ENFORCEMENT ==========
      // Reads policy via the SAME transactional client to avoid race conditions.
      // Uses cashRegisterRepository.getSessionById (single source of truth).
      let validatedSessionId: string | null = null;
      try {
        // Use SAVEPOINT so a missing column/table doesn't abort the whole TX
        await client.query('SAVEPOINT session_policy_check');

        // Read policy inside the transaction (same client) for serialisation safety
        const policyRow = await client.query(
          `SELECT pos_session_policy FROM system_settings LIMIT 1`
        );
        const policy = (policyRow.rows[0]?.pos_session_policy as string) || 'DISABLED';

        if (policy !== 'DISABLED') {
          if (!input.cashRegisterSessionId) {
            throw new BusinessError(
              'POS session is required. Please open a cash register session before making sales.',
              'ERR_SESSION_001',
              { policy }
            );
          }

          // Validate session via the canonical repository method (reuses client = same TX)
          const session = await cashRegisterRepository.getSessionById(
            client,
            input.cashRegisterSessionId
          );

          if (!session) {
            throw new BusinessError(
              'Invalid cash register session. The session does not exist.',
              'ERR_SESSION_002',
              { sessionId: input.cashRegisterSessionId }
            );
          }

          if (session.status !== 'OPEN') {
            throw new BusinessError(
              `Cash register session is ${session.status}. Only OPEN sessions can process sales.`,
              'ERR_SESSION_003',
              { sessionId: input.cashRegisterSessionId, status: session.status }
            );
          }

          // Policy-specific validation
          if (policy === 'PER_CASHIER_SESSION') {
            if (session.userId !== input.soldBy) {
              throw new BusinessError(
                'This session belongs to a different cashier. Per-cashier policy requires your own session.',
                'ERR_SESSION_004',
                { sessionUserId: session.userId, currentUserId: input.soldBy, registerId: session.registerId }
              );
            }
          }

          validatedSessionId = input.cashRegisterSessionId;
          logger.info('POS session validated for sale', {
            sessionId: validatedSessionId,
            policy,
            registerId: session.registerId,
            userId: input.soldBy,
          });
        } else if (input.cashRegisterSessionId) {
          // Policy is DISABLED but session was provided — still link it
          validatedSessionId = input.cashRegisterSessionId;
        }

        await client.query('RELEASE SAVEPOINT session_policy_check');
      } catch (sessionError: unknown) {
        if (sessionError instanceof BusinessError) throw sessionError;
        // Rollback savepoint to keep the TX usable even if the query failed
        await client.query('ROLLBACK TO SAVEPOINT session_policy_check').catch(() => { });
        // Non-blocking: settings fetch failure should not block sales
        logger.warn('Session policy check failed, proceeding without enforcement', {
          error: sessionError instanceof Error ? sessionError.message : String(sessionError),
        });
        if (input.cashRegisterSessionId) {
          validatedSessionId = input.cashRegisterSessionId;
        }
      }
      profiler.mark('session_policy');

      // Suppress the inventory_batches trigger that auto-creates SM- stock_movements
      // Sales code already creates proper MOV- movements for each batch deduction
      await client.query("SET LOCAL app.skip_stock_movement_trigger = 'true'");

      // ========== QUOTE PRE-VALIDATION (FAIL FAST, NO INVENTORY MUTATION) ==========
      // Reject the sale up front when the quote is no longer convertible. The
      // status list is centralised in quoteConvertibilityGuard so the same
      // contract can be unit-tested without booting the whole sales graph.
      if (input.quoteId) {
        const quoteCheck = await client.query<{ status: string; quote_number: string | null }>(
          `SELECT status, quote_number FROM quotations WHERE id = $1 FOR UPDATE`,
          [input.quoteId]
        );
        if (quoteCheck.rows.length === 0) {
          throw new NotFoundError('Quotation');
        }
        assertQuoteConvertibleForPosSale(
          quoteCheck.rows[0].status,
          quoteCheck.rows[0].quote_number ?? input.quoteId,
        );
      }
      // ========== BUSINESS RULE VALIDATIONS ==========

      // BR-SAL-002: Sale must have at least one item
      SalesBusinessRules.validateSaleItems(input.items);

      // BR-SAL-003: Validate credit sales
      if (input.paymentMethod === 'CREDIT') {
        const totalAmount = input.items
          .reduce(
            (sum, item) => sum.plus(new Decimal(item.quantity).times(item.unitPrice)),
            new Decimal(0)
          )
          .toNumber();
        await SalesBusinessRules.validateCreditSale(
          client,
          input.customerId || null,
          totalAmount,
          input.paymentMethod
        );
      }

      // BR-SAL-005: DEPOSIT payment requires a customer (covers both paymentMethod and paymentLines)
      const hasDepositInMethod = input.paymentMethod === 'DEPOSIT';
      const hasDepositInLines = input.paymentLines?.some(
        (line) => line.paymentMethod === 'DEPOSIT'
      ) ?? false;
      if ((hasDepositInMethod || hasDepositInLines) && !input.customerId) {
        throw new BusinessError(
          'DEPOSIT payment requires a customer. Cannot apply deposit without a customer account.',
          'ERR_SALE_005',
          { paymentMethod: 'DEPOSIT' }
        );
      }

      // Calculate totals and costs using new cost layer service
      let totalAmount = new Decimal(0);
      let totalCost = new Decimal(0);
      const itemsWithCosts: CreateSaleItemData[] = [];

      // Collect cost layer deduction data to process AFTER main transaction commits
      // This prevents nested transactions and connection pool exhaustion
      const costLayerDeductions: Array<{
        productId: string;
        quantity: number;
        costingMethod: 'FIFO' | 'AVCO' | 'STANDARD';
      }> = [];

      // ========== BATCH PRE-FETCH (N+1 elimination) ==========
      // Collect all regular product IDs and fetch in bulk before the per-item loop.
      // Previously each item triggered 2-3 individual product queries.
      const regularProductIds = input.items
        .filter((it) => !it.productId?.startsWith('custom_'))
        .map((it) => it.productId);

      const [productsMap] = await Promise.all([
        batchFetchProducts(client, regularProductIds),
      ]);
      profiler.mark('product_prefetch');

      // Wave 4 MUoM SSOT: resolve canonical UoM once per line (no silent factor=1 fallback).
      const saleUomSnapshots = new Map<number, SaleItemUomSnapshot>();
      for (let lineIdx = 0; lineIdx < input.items.length; lineIdx++) {
        const line = input.items[lineIdx];
        if (line.productId?.startsWith('custom_')) continue;
        saleUomSnapshots.set(
          lineIdx,
          await resolveSaleItemUom(line.productId, line, client),
        );
      }
      profiler.mark('uom_resolve');

      // Phase 3: pre-resolve recipe BOM explosion per sale line (null = direct product stock)
      const recipeExplosionByLine = new Map<number, RecipeExplosionLine[] | null>();
      for (let lineIdx = 0; lineIdx < input.items.length; lineIdx++) {
        const line = input.items[lineIdx];
        if (line.productId?.startsWith('custom_')) continue;
        const snap = saleUomSnapshots.get(lineIdx);
        if (!snap) continue;
        recipeExplosionByLine.set(
          lineIdx,
          await explodeActiveRecipe(client, line.productId, new Decimal(snap.baseQuantity)),
        );
      }
      profiler.mark('recipe_explode');

      // ========== PRICING ENGINE RESOLUTION ==========
      // Resolve prices through the full cascade (tier → rule → group discount → formula → base)
      // This ensures customer-group pricing, quantity breaks, and price rules are enforced server-side.
      const resolvedPriceMap = new Map<string, ResolvedPrice>();
      const customerPricingMode = input.customerId
        ? await getCustomerPricingMode(client, input.customerId)
        : null;

      if (regularProductIds.length > 0) {
        // SAVEPOINT: pricing queries run on the transaction client.
        // If any pricing table is missing or the query fails, we MUST rollback to
        // the savepoint — otherwise the whole transaction is left in an aborted state
        // (pgCode 25P02) and every subsequent query fails, killing the sale.
        await client.query('SAVEPOINT before_pricing');
        try {
          const bulkItems: Array<{ productId: string; quantity: number; baseQuantity: number }> = [];
          for (let lineIdx = 0; lineIdx < input.items.length; lineIdx++) {
            const it = input.items[lineIdx];
            if (it.productId?.startsWith('custom_')) continue;
            const snap = saleUomSnapshots.get(lineIdx);
            if (!snap) continue;
            bulkItems.push({
              productId: it.productId,
              quantity: it.quantity,
              baseQuantity: snap.baseQuantity,
            });
          }

          const resolved = await getFinalPricesBulk(
            bulkItems,
            input.customerId || undefined,
            undefined, // groupId resolved internally from customerId
            client,
          );

          for (let i = 0; i < bulkItems.length; i++) {
            resolvedPriceMap.set(
              `${bulkItems[i].productId}:${bulkItems[i].quantity}`,
              resolved[i],
            );
          }

          await client.query('RELEASE SAVEPOINT before_pricing');
          logger.info('Pricing engine resolved prices for sale', {
            itemCount: resolved.length,
            customerId: input.customerId,
            customerPricingMode,
            hasCustomerPricing: resolved.some((r) => r.appliedRule.scope !== 'base'),
          });

          if (customerPricingMode === 'AT_COST') {
            validateAtCostSalePricing(bulkItems, resolvedPriceMap);
          }
        } catch (pricingError) {
          await client.query('ROLLBACK TO SAVEPOINT before_pricing');
          await client.query('RELEASE SAVEPOINT before_pricing');
          if (pricingError instanceof BusinessError) {
            throw pricingError;
          }

          logger.error('Pricing engine failed during sale', {
            error: pricingError instanceof Error ? pricingError.message : String(pricingError),
            customerId: input.customerId,
            customerPricingMode,
            itemCount: regularProductIds.length,
          });

          if (customerPricingMode === 'AT_COST') {
            throw new BusinessError(
              'Cannot complete sale: at-cost pricing could not be verified. Try again or contact support.',
              'AT_COST_PRICING_UNAVAILABLE',
              { customerId: input.customerId },
            );
          }

          logger.warn('Pricing engine failed, using frontend-supplied prices', {
            error: pricingError instanceof Error ? pricingError.message : String(pricingError),
          });
        }
      }

      if (!input.customerId) {
        logger.warn('Sale posted without customer_id — AT_COST and credit invoicing will not apply', {
          itemCount: input.items.length,
        });
      }
      profiler.mark('pricing_engine');

      for (let lineIdx = 0; lineIdx < input.items.length; lineIdx++) {
        const item = input.items[lineIdx];
        // ========== CUSTOM ITEM DETECTION ==========
        // Custom items (service/one-off items from quotations) have custom_* IDs
        // They don't exist in products table, so skip all product-based validations
        const isCustomItem = item.productId?.startsWith('custom_');

        if (isCustomItem) {
          // Custom items: no product lookup, no cost, no inventory tracking
          const lineTotal = new Decimal(item.quantity).times(item.unitPrice);
          const customItemDiscount = new Decimal(item.discountAmount || 0);
          const lineTotalAfterDiscount = lineTotal.minus(customItemDiscount);
          totalAmount = totalAmount.plus(lineTotalAfterDiscount);

          itemsWithCosts.push({
            saleId: '', // Will be set after sale creation
            productId: item.productId,
            productName: item.productName,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            lineTotal: Money.toNumber(lineTotalAfterDiscount),
            costPrice: 0, // Custom items have no cost tracking
            profit: Money.toNumber(lineTotalAfterDiscount), // Full amount is profit
            discountAmount: Money.toNumber(customItemDiscount),
            uomId: undefined,
          });

          logger.info('Custom item added to sale', {
            productId: item.productId,
            productName: item.productName,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            lineTotal: lineTotal.toFixed(2),
          });

          continue; // Skip all product-based validations and processing
        }

        // ========== REGULAR PRODUCT PROCESSING ==========
        const uomSnapshot = saleUomSnapshots.get(lineIdx);
        if (!uomSnapshot) {
          throw new ValidationError(
            `UoM snapshot missing for product ${item.productId} — cannot post sale.`,
          );
        }

        const baseQty = new Decimal(uomSnapshot.baseQuantity);
        const snapshotConversionFactor = new Decimal(uomSnapshot.conversionFactor);
        const snapshotBaseUomId = uomSnapshot.baseUomId;
        const snapshotSellingUomId = uomSnapshot.sellingUomId;

        logger.info('UoM conversion resolved (canonical SSOT)', {
          productId: item.productId,
          inputUom: item.uom,
          inputUomId: item.uomId,
          baseUomId: snapshotBaseUomId,
          sellingUomId: snapshotSellingUomId,
          conversionFactor: snapshotConversionFactor.toNumber(),
          enteredQty: item.quantity,
          baseQty: baseQty.toNumber(),
        });

        // BR-INV-002: Validate positive quantity
        InventoryBusinessRules.validatePositiveQuantity(item.quantity, 'sale item');

        // BR-SAL-005: Validate product is active
        await SalesBusinessRules.validateProductActive(client, item.productId);

        // MASTER DATA GUARD (Rule 2): Block sales of items without configured selling price
        await masterDataGuard.assertItemHasSellingPrice(client, item.productId);

        // ========== PRICING ENGINE OVERRIDE ==========
        // If the pricing engine resolved a better price for this customer/quantity,
        // use it instead of the frontend-supplied price.
        //
        // SAP MUoM RULE: The pricing engine returns prices per BASE unit.
        // We must multiply by snapshotConversionFactor to get price per SELLING unit.
        // Example: base = 1,500/tablet, factor = 30 → effective PACKET price = 45,000.
        // Without this multiplication, a PACKET sale would be charged at 1,500 (tablet price).
        const resolvedPrice = resolvedPriceMap.get(`${item.productId}:${item.quantity}`);
        let effectiveUnitPrice = item.unitPrice;
        let engineSellingUnitPrice: number | null = null;
        if (resolvedPrice) {
          // Scale base-unit price to selling-UoM price.
          const uomAdjustedPrice = Money.toNumber(
            Money.round(
              new Decimal(resolvedPrice.finalPrice).times(snapshotConversionFactor),
              2,
            ),
          );
          engineSellingUnitPrice = uomAdjustedPrice;
          if (uomAdjustedPrice !== item.unitPrice) {
            logger.info('Pricing engine reference price (UoM-normalised)', {
              productId: item.productId,
              submittedPrice: item.unitPrice,
              engineBasePrice: resolvedPrice.finalPrice,
              conversionFactor: snapshotConversionFactor.toNumber(),
              uomAdjustedPrice,
              rule: resolvedPrice.appliedRule.scope,
              ruleName: resolvedPrice.appliedRule.ruleName,
            });
          }
        }
        // POS/API submitted unit price is authoritative; below-cost guard enforces inventory floor.
        effectiveUnitPrice = item.unitPrice;

        const lineTotal = new Decimal(item.quantity).times(effectiveUnitPrice);
        const itemDiscountAmount = new Decimal(item.discountAmount || 0);
        const lineTotalAfterDiscount = lineTotal.minus(itemDiscountAmount);
        totalAmount = totalAmount.plus(lineTotalAfterDiscount);

        // Use pre-fetched product data (eliminates duplicate per-item query)
        const productData = productsMap.get(item.productId);
        if (!productData) {
          throw new NotFoundError(`Product ${item.productId}`);
        }
        const costingMethod = (productData.costing_method || 'FIFO') as
          | 'FIFO'
          | 'AVCO'
          | 'STANDARD';
        // SAP MUoM: originalPrice must also be in selling-UoM for correct discount comparison.
        // base selling_price × conversionFactor = catalog price per selling unit.
        const originalPrice = Money.toNumber(
          Money.round(
            Money.parse(productData.selling_price || String(effectiveUnitPrice))
              .times(snapshotConversionFactor),
            2,
          )
        );

        // BR-SAL-004: Validate minimum price
        await SalesBusinessRules.validateMinimumPrice(client, item.productId, effectiveUnitPrice);

        // BR-SAL-006: Validate discount
        if (effectiveUnitPrice < originalPrice) {
          await SalesBusinessRules.validateDiscount(
            client,
            item.productId,
            effectiveUnitPrice,
            originalPrice
          );
        }

        // BR-INV-001: Validate stock availability
        // Phase 3: recipe parents validate/consume ingredients; service with no recipe skips stock.
        const recipeLines = recipeExplosionByLine.get(lineIdx) ?? null;
        const productType = String(productData.product_type || 'inventory');
        const stockPlan = planSaleStockDeduction(productType, Boolean(recipeLines?.length));
        const isServiceNoRecipe = stockPlan.kind === 'skip';

        if (stockPlan.kind === 'skip') {
          // Pure service — no inventory
        } else if (stockPlan.kind === 'ingredients' && recipeLines?.length) {
          for (const rl of recipeLines) {
            if (multistoreEnabled && sellingStoreId) {
              await warehouseSaleDeductionService.validateSellableAtStore(
                client,
                sellingStoreId,
                rl.componentProductId,
                rl.baseQty.toNumber(),
              );
            } else {
              await InventoryBusinessRules.validateStockAvailability(
                client,
                rl.componentProductId,
                rl.baseQty.toNumber(),
              );
            }
          }
        } else if (multistoreEnabled && sellingStoreId) {
          await warehouseSaleDeductionService.validateSellableAtStore(
            client,
            sellingStoreId,
            item.productId,
            baseQty.toNumber(),
          );
        } else {
          await InventoryBusinessRules.validateStockAvailability(
            client,
            item.productId,
            baseQty.toNumber(),
          );
        }

        const expiryRuleRes = await client.query(
          `SELECT COALESCE(min_days_before_expiry_sale, 0) AS min_days
           FROM products WHERE id = $1`,
          [item.productId],
        );
        const minDaysBeforeExpiry = parseInt(expiryRuleRes.rows[0]?.min_days ?? '0', 10);
        const masterCostPerBase = Money.parseDb(productData.cost_price || '0');

        // Calculate actual cost from FEFO inventory batches (same source as stock movements).
        // Using batch.cost_price directly ensures sale_items.unit_cost = SM unit_cost,
        // keeping GL COGS in sync with the batch subledger and preventing reconciliation drift.
        // Previously used costLayerService.calculateActualCost() which could diverge from
        // batch.cost_price due to FIFO layer averaging and UoM conversion rounding.
        let itemCostDecimal = new Decimal(0);
        let unitCost: number = 0; // per base unit
        const valuation: ProductValuationForAtCost = {
          sellingPrice: productData.selling_price || '0',
          costPrice: productData.cost_price || '0',
          averageCost: productData.average_cost || '0',
          costingMethod,
        };
        try {
          if (isServiceNoRecipe) {
            itemCostDecimal = new Decimal(0);
            unitCost = 0;
          } else if (recipeLines?.length) {
            // Phase 3: COGS preview = sum of ingredient FEFO costs
            for (const rl of recipeLines) {
              const compVal = await client.query(
                `SELECT COALESCE(pv.cost_price, 0) AS cost_price,
                        COALESCE(pv.average_cost, 0) AS average_cost
                 FROM products p
                 LEFT JOIN product_valuation pv ON pv.product_id = p.id
                 WHERE p.id = $1`,
                [rl.componentProductId],
              );
              const compMaster = Money.parseDb(String(compVal.rows[0]?.cost_price ?? '0'));
              const compExpiry = await client.query(
                `SELECT COALESCE(min_days_before_expiry_sale, 0) AS min_days
                 FROM products WHERE id = $1`,
                [rl.componentProductId],
              );
              const compMinDays = parseInt(compExpiry.rows[0]?.min_days ?? '0', 10);

              if (multistoreEnabled && sellingStoreId) {
                const storePreview = await warehouseSaleDeductionService.previewSaleCostAtStore(
                  client,
                  sellingStoreId,
                  rl.componentProductId,
                  rl.baseQty,
                  compMaster,
                );
                itemCostDecimal = itemCostDecimal.plus(storePreview.totalCost);
                if (storePreview.shortfall.greaterThan(0.001)) {
                  const avgCost = Money.parseDb(String(compVal.rows[0]?.average_cost ?? '0'));
                  const shortfallUnit = avgCost.greaterThan(0) ? avgCost : compMaster;
                  itemCostDecimal = itemCostDecimal.plus(storePreview.shortfall.times(shortfallUnit));
                }
              } else {
                const { totalCost: batchTotal, shortfall } = await previewFefoIssueCostForBaseQty(
                  client,
                  rl.componentProductId,
                  rl.baseQty,
                  compMaster,
                  { minDaysBeforeExpiry: compMinDays },
                );
                itemCostDecimal = itemCostDecimal.plus(batchTotal);
                if (shortfall.greaterThan(0.001)) {
                  const avgCost = Money.parseDb(String(compVal.rows[0]?.average_cost ?? '0'));
                  const shortfallUnit = avgCost.greaterThan(0) ? avgCost : compMaster;
                  itemCostDecimal = itemCostDecimal.plus(shortfall.times(shortfallUnit));
                }
              }
            }
            unitCost = baseQty.greaterThan(0)
              ? Money.toNumber(Money.round(itemCostDecimal.dividedBy(baseQty), 2))
              : 0;
            logger.info(`Recipe BOM cost preview for product ${item.productId}`, {
              ingredientCount: recipeLines.length,
              totalBatchCost: itemCostDecimal.toFixed(2),
              unitCostPerBase: unitCost,
            });
          } else if (multistoreEnabled && sellingStoreId) {
            const storePreview = await warehouseSaleDeductionService.previewSaleCostAtStore(
              client,
              sellingStoreId,
              item.productId,
              baseQty,
              masterCostPerBase,
            );
            itemCostDecimal = storePreview.totalCost;
            if (storePreview.shortfall.greaterThan(0.001)) {
              const avgCost = Money.parseDb(productData.average_cost);
              const costPriceDec = Money.parseDb(productData.cost_price);
              const shortfallUnit = avgCost.greaterThan(0) ? avgCost : costPriceDec;
              itemCostDecimal = itemCostDecimal.plus(storePreview.shortfall.times(shortfallUnit));
              logger.warn('[COGS DRIFT RISK] Store FEFO insufficient for GL cost preview — shortfall priced at average/master', {
                productId: item.productId,
                productName: item.productName,
                requestedBaseQty: baseQty.toFixed(4),
                shortfall: storePreview.shortfall.toFixed(4),
              });
            }
            unitCost = baseQty.greaterThan(0)
              ? Money.toNumber(Money.round(itemCostDecimal.dividedBy(baseQty), 2))
              : 0;
          } else {
          const { totalCost: batchTotal, shortfall } = await previewFefoIssueCostForBaseQty(
            client,
            item.productId,
            baseQty,
            masterCostPerBase,
            { minDaysBeforeExpiry },
          );
          itemCostDecimal = batchTotal;

          if (shortfall.greaterThan(0.001)) {
            const avgCost = Money.parseDb(productData.average_cost);
            const costPriceDec = Money.parseDb(productData.cost_price);
            const shortfallUnit = avgCost.greaterThan(0) ? avgCost : costPriceDec;
            itemCostDecimal = itemCostDecimal.plus(shortfall.times(shortfallUnit));
            logger.warn('[COGS DRIFT RISK] FEFO batches insufficient for GL cost preview — shortfall priced at average/master', {
              productId: item.productId,
              productName: item.productName,
              requestedBaseQty: baseQty.toFixed(4),
              shortfall: shortfall.toFixed(4),
            });
          }

          unitCost = baseQty.greaterThan(0)
            ? Money.toNumber(Money.round(itemCostDecimal.dividedBy(baseQty), 2))
            : 0;

          logger.info(`Batch-derived FEFO cost for product ${item.productId}`, {
            method: costingMethod,
            baseQty: baseQty.toNumber(),
            totalBatchCost: itemCostDecimal.toFixed(2),
            unitCostPerBase: unitCost,
          });
          }
        } catch (error: unknown) {
          if (isServiceNoRecipe) {
            itemCostDecimal = new Decimal(0);
            unitCost = 0;
          } else {
          const avgCost = Money.parseDb(productData.average_cost);
          const costPriceDec = Money.parseDb(productData.cost_price);
          unitCost = Money.toNumber(avgCost.greaterThan(0) ? avgCost : costPriceDec);
          itemCostDecimal = new Decimal(unitCost).times(baseQty);

          logger.debug(`Using product cost_price fallback for ${item.productId}`, {
            productId: item.productId,
            unitCost,
            error: error instanceof Error ? error.message : String(error),
          });
          }
        }

        const itemCost = itemCostDecimal;
        const costPerSellingUnit = Money.toNumber(
          Money.round(itemCost.dividedBy(new Decimal(item.quantity)), 2),
        );

        let fefoLayersForError: Array<{ baseQuantity: number; unitCostPerBase: number; totalCost: number }> = [];
        if (!multistoreEnabled || !sellingStoreId) {
          try {
            fefoLayersForError = await previewFefoIssueLayers(
              client,
              item.productId,
              baseQty,
              masterCostPerBase,
              { minDaysBeforeExpiry },
            );
          } catch {
            // Non-fatal — guard still runs without layer breakdown
          }
        }

        try {
          assertSaleLineNotBelowAllocatedCost({
            productId: item.productId,
            productName: item.productName,
            quantity: item.quantity,
            lineRevenue: Money.toNumber(lineTotalAfterDiscount),
            totalAllocatedCost: Money.toNumber(itemCost),
            costPerSellingUnit,
            unitPrice: effectiveUnitPrice,
            fefoLayers: fefoLayersForError,
          });
        } catch (belowCostError) {
          if (input.auditContext && belowCostError instanceof BusinessError) {
            // Separate connection — sale transaction will ROLLBACK; audit must persist.
            await recordSaleLinePriceEvent(
              pool,
              {
                eventType: 'BELOW_COST_BLOCKED',
                productId: item.productId,
                customerId: input.customerId,
                originalUnitPrice: engineSellingUnitPrice,
                newUnitPrice: effectiveUnitPrice,
                allocatedCostPerSellingUnit: costPerSellingUnit,
                allocatedTotalCost: Money.toNumber(itemCost),
                quantity: item.quantity,
                uomId: snapshotSellingUomId,
                reason: belowCostError.message,
                metadata: belowCostError.details,
              },
              input.auditContext,
            );
          }
          throw belowCostError;
        }

        if (
          input.auditContext &&
          engineSellingUnitPrice != null &&
          Math.abs(item.unitPrice - engineSellingUnitPrice) > 0.01
        ) {
          priceOverrideCount += 1;
          await recordSaleLinePriceEvent(
            client,
            {
              eventType: 'PRICE_EDIT',
              productId: item.productId,
              customerId: input.customerId,
              originalUnitPrice: engineSellingUnitPrice,
              newUnitPrice: item.unitPrice,
              allocatedCostPerSellingUnit: costPerSellingUnit,
              allocatedTotalCost: Money.toNumber(itemCost),
              quantity: item.quantity,
              uomId: snapshotSellingUomId,
              reason: 'POS unit price differs from pricing engine reference',
              metadata: {
                pricingScope: resolvedPrice?.appliedRule.scope,
              },
            },
            input.auditContext,
          );
        }

        totalCost = totalCost.plus(itemCost);
        const profit = lineTotalAfterDiscount.minus(itemCost);

        // Use the selling UoM ID resolved during conversion lookup (no extra query needed)
        const actualUomId = snapshotSellingUomId || undefined;

        const storedUnitPrice =
          item.quantity > 0
            ? deriveUnitPriceFromLineTotal(Money.toNumber(lineTotalAfterDiscount), item.quantity)
            : effectiveUnitPrice;

        itemsWithCosts.push({
          saleId: '', // Will be set after sale creation
          productId: item.productId,
          productName: item.productName,
          quantity: item.quantity,
          unitPrice: storedUnitPrice,
          lineTotal: Money.toNumber(lineTotalAfterDiscount),
          costPrice: costPerSellingUnit,
          profit: Money.toNumber(profit),
          discountAmount: Money.toNumber(itemDiscountAmount),
          uomId: actualUomId, // Use the actual uom_id from uoms table
          baseQty: baseQty.toNumber(), // SAP UoM snapshot: base quantity at posting time
          baseUomId: snapshotBaseUomId, // SAP UoM snapshot: base UoM ID at posting time
          conversionFactor: snapshotConversionFactor.toNumber(), // SAP UoM snapshot: conversion factor at posting time
          allocatedTotalCost: Money.toNumber(itemCost),
        });
      }

      // Use provided discount if available, otherwise default to 0
      const discountAmount = input.discountAmount
        ? new Decimal(input.discountAmount)
        : new Decimal(0);

      // ========== DocumentTaxService (authoritative) ==========
      // Client taxAmount is preview only. Server recomputes via determination → TaxEngine.compute.
      // Tax base = line net after line discounts (cart/document discount is not in the tax base —
      // matches current Retail POS preview).
      let validatedTaxOverride: DocumentTaxOverride | undefined;
      if (input.taxOverride) {
        const parsed = DocumentTaxOverrideSchema.safeParse(input.taxOverride);
        if (!parsed.success) {
          throw new ValidationError(
            `Invalid tax override: ${parsed.error.errors.map((e) => e.message).join('; ')}`,
          );
        }
        validatedTaxOverride = parsed.data;
        await assertUserPermission(pool, input.soldBy, 'sales.tax_override', {
          errorCode: 'ERR_TAX_OVERRIDE_PERMISSION',
          message: 'Missing permission: sales.tax_override',
        });
        if (input.customerId) {
          const profile = await loadCustomerTaxProfile(client, input.customerId);
          if (profile && !profile.allowTaxOverride) {
            const canApprove = await userHasPermission(pool, input.soldBy, 'sales.approve');
            if (!canApprove) {
              throw new BusinessError(
                'This customer does not allow tax overrides. Enable Allow tax override on the customer, or use sales.approve.',
                'ERR_TAX_OVERRIDE_CUSTOMER',
                { customerId: input.customerId },
              );
            }
          }
        }
      }

      let applyTenantDefaultWhenUnresolved = false;
      if (input.fromOrderId) {
        const { restaurantService } = await import('../restaurant/restaurantService.js');
        applyTenantDefaultWhenUnresolved = await restaurantService.isRestaurantCheck(
          pool,
          input.fromOrderId,
        );
      }

      const taxDoc = await DocumentTaxService.computeForLines(client, {
        customerId: input.customerId ?? null,
        documentDate: input.saleDate,
        scope: 'SALE',
        applyTenantDefaultWhenUnresolved,
        taxOverride: validatedTaxOverride ?? null,
        lines: input.items.map((item, lineIndex) => {
          const lineNet = new Decimal(item.quantity)
            .times(item.unitPrice)
            .minus(item.discountAmount || 0);
          return {
            lineIndex,
            productId: item.productId ?? null,
            lineNetAmount: Money.toNumber(Money.round(lineNet, 2)),
            quantity: item.quantity,
            // Client tax fields are preview-only for UUID products; DocumentTax loads DB bridge.
            // custom_* / non-UUID lines still use client isTaxable/taxRate.
            isTaxable: item.isTaxable,
            taxRate: item.taxRate,
          };
        }),
      });
      const taxAmount = resolveAuthoritativeTaxAmount(
        taxDoc.documentTotals.totalTax,
        input.taxAmount,
        { saleHint: 'createSale' },
      );

      // Phase 6 — stamp DocumentTax lineResults onto sale item rows (same order as input.items)
      if (itemsWithCosts.length !== taxDoc.lineResults.length) {
        throw new BusinessError(
          `DocumentTax lineResults length mismatch (${taxDoc.lineResults.length}) vs sale items (${itemsWithCosts.length})`,
          'ERR_TAX_LINE_MISMATCH',
          {
            items: itemsWithCosts.length,
            lineResults: taxDoc.lineResults.length,
          },
        );
      }
      let stampedLineTax = new Decimal(0);
      for (let i = 0; i < itemsWithCosts.length; i++) {
        const lr = taxDoc.lineResults[i];
        if (!lr) {
          throw new BusinessError(
            `DocumentTax missing lineResult for sale item index ${i}`,
            'ERR_TAX_LINE_MISMATCH',
            { lineIndex: i },
          );
        }
        const lineTax = lr.computation.totalTax;
        const pct = lr.taxes.find((t) => t.type === 'PERCENTAGE' && Number(t.rate) > 0);
        const lineRate = pct ? Number(pct.rate) : Number(input.items[i]?.taxRate || 0);
        itemsWithCosts[i].taxAmount = lineTax;
        itemsWithCosts[i].taxRate = lineTax > 0 ? lineRate : 0;
        itemsWithCosts[i].isTaxable = lineTax > 0 || lr.taxes.length > 0;
        itemsWithCosts[i].taxDetermination = lr.determination;
        stampedLineTax = stampedLineTax.plus(lineTax);
      }
      if (stampedLineTax.minus(taxAmount).abs().greaterThan(0.02)) {
        throw new BusinessError(
          `DocumentTax line tax sum (${stampedLineTax.toFixed(2)}) diverges from header tax (${taxAmount.toFixed(2)})`,
          'ERR_TAX_LINE_HEADER_MISMATCH',
          {
            lineTaxSum: stampedLineTax.toFixed(2),
            headerTax: taxAmount.toFixed(2),
          },
        );
      }
      // SSOT hard gate — never proceed if charge math disagrees with DocumentTax
      {
        const { assertLineTaxEqualsHeader, money2 } = await import(
          '../../services/documentTaxIntegrity.js'
        );
        assertLineTaxEqualsHeader(
          money2(stampedLineTax.toNumber()),
          money2(taxAmount.toNumber()),
          'createSale.DocumentTax',
        );
      }
      profiler.mark('document_tax');

      logger.info('DocumentTaxService createSale tax', {
        clientTax: input.taxAmount,
        serverTax: taxAmount.toFixed(2),
        taxInclusive: taxDoc.taxInclusive,
        customerExempt: taxDoc.customerExempt,
        taxOverrideApplied: taxDoc.taxOverrideApplied,
        applyTenantDefaultWhenUnresolved,
        determinations: taxDoc.lineResults.map((r) => r.determination),
        lineTaxes: itemsWithCosts.map((i) => i.taxAmount),
        'input.totalAmount': input.totalAmount,
        'input.subtotal': input.subtotal,
        'input.discountAmount': input.discountAmount,
        calculated_totalAmount_from_items: totalAmount.toFixed(2),
      });

      // Inclusive: charge = priced lines − cart discount (VAT already in shelf).
      // Exclusive: charge = lines − discount + tax.
      // Client exclusive-add trap (4200 + 640.68 → 4840.68) is coerced under inclusive.
      const pricedAfterDiscount = totalAmount.minus(discountAmount);
      const headerRes = resolveSaleHeaderTotal({
        providedTotal: input.totalAmount,
        pricedLinesAfterDiscount: pricedAfterDiscount,
        taxAmount,
        taxInclusive: taxDoc.taxInclusive === true,
      });
      if (
        headerRes.coercedFromExclusiveTrap ||
        (taxDoc.taxInclusive === true &&
          headerRes.clientTotal != null &&
          new Decimal(headerRes.clientTotal).minus(headerRes.finalTotal).abs().greaterThan(0.02))
      ) {
        logger.warn('DocumentTax: coerced client total under tax_inclusive', {
          clientTotal: headerRes.clientTotal,
          serverCharge: headerRes.finalTotal.toFixed(2),
          taxAmount: taxAmount.toFixed(2),
          exclusiveAddTrap: headerRes.coercedFromExclusiveTrap,
        });
      }
      const finalTotalAmount = headerRes.finalTotal;

      // If client paid exclusive trap (sub+tax) under inclusive, clamp cash lines to shelf
      // so cash.received / change is not inflated by extracted VAT.
      if (
        taxDoc.taxInclusive === true &&
        input.paymentLines &&
        input.paymentLines.length > 0
      ) {
        const exclusiveTrapAmt = Money.toNumber(pricedAfterDiscount.plus(taxAmount));
        const shelfAmt = Money.toNumber(finalTotalAmount);
        const paySum = input.paymentLines.reduce(
          (s, l) => s.plus(new Decimal(l.amount)),
          new Decimal(0),
        );
        if (
          paySum.minus(exclusiveTrapAmt).abs().lessThanOrEqualTo(0.02) &&
          new Decimal(shelfAmt).minus(exclusiveTrapAmt).abs().greaterThan(0.02)
        ) {
          const cashLine = input.paymentLines.find((l) => l.paymentMethod === 'CASH');
          if (cashLine && input.paymentLines.length === 1) {
            cashLine.amount = shelfAmt;
            logger.warn('DocumentTax: clamped cash payment from exclusive trap to shelf', {
              was: exclusiveTrapAmt,
              now: shelfAmt,
            });
          }
        }
      }

      if (input.exchangeRefundId) {
        if (discountAmount.lessThanOrEqualTo(0)) {
          throw new BusinessError(
            'Exchange credit requires a matching cart discount on the replacement sale',
            'ERR_EXCHANGE_CREDIT_002',
            { exchangeRefundId: input.exchangeRefundId },
          );
        }
        const exchangeRefund = await salesRepository.getExchangeRefundForApplication(
          client,
          input.exchangeRefundId,
        );
        if (!exchangeRefund || exchangeRefund.refundType !== 'EXCHANGE') {
          throw new BusinessError(
            'Invalid or expired exchange credit reference',
            'ERR_EXCHANGE_CREDIT_003',
            { exchangeRefundId: input.exchangeRefundId },
          );
        }
        const creditApplied = Money.toNumber(discountAmount);
        const remainingCredit = exchangeRefund.remainingAmount;
        if (creditApplied > remainingCredit + 0.01) {
          throw new BusinessError(
            `Exchange credit (${creditApplied.toFixed(2)}) exceeds available balance (${remainingCredit.toFixed(2)})`,
            'ERR_EXCHANGE_CREDIT_004',
            { exchangeRefundId: input.exchangeRefundId, creditApplied, remainingCredit },
          );
        }
      }

      logger.info('💰 FINAL TOTAL AMOUNT', {
        finalTotalAmount: finalTotalAmount.toFixed(2),
        used: 'calculated (items + tax - discount)',
      });

      // Calculate subtotal: if provided use it, otherwise use line item totals
      const subtotal = input.subtotal ? new Decimal(input.subtotal) : totalAmount;

      // For CREDIT/split payment sales, allow partial or zero payment
      // For other payment methods (CASH, CARD, MOBILE_MONEY), require full payment

      // Check if payment lines contain CREDIT
      const hasPaymentLines = input.paymentLines && input.paymentLines.length > 0;
      const hasCreditPayment = hasPaymentLines
        ? (input.paymentLines?.some((line) => line.paymentMethod === 'CREDIT') ?? false)
        : input.paymentMethod === 'CREDIT';

      // ============================================================
      // CRITICAL FIX: Calculate ACTUAL payment received (EXCLUDING CREDIT)
      // ============================================================
      // CREDIT is NOT actual payment - it's debt owed by the customer
      // DEPOSIT IS actual payment - it's money already received as prepayment
      // Only count CASH, CARD, MOBILE_MONEY, DEPOSIT, BANK_TRANSFER as actual payments
      // This ensures amount_paid reflects what was actually received
      // ============================================================
      const paymentReceived = hasPaymentLines
        ? (input.paymentLines
          ?.filter((line) => line.paymentMethod !== 'CREDIT') // Exclude CREDIT
          .reduce((sum, line) => sum.plus(new Decimal(line.amount)), new Decimal(0)) ??
          new Decimal(0))
        : new Decimal(input.paymentReceived || 0);

      // Calculate the CREDIT amount for logging/invoice purposes
      const creditAmount = hasPaymentLines
        ? (input.paymentLines
          ?.filter((line) => line.paymentMethod === 'CREDIT')
          .reduce((sum, line) => sum.plus(new Decimal(line.amount)), new Decimal(0)) ??
          new Decimal(0))
        : new Decimal(0);

      logger.info('Payment breakdown calculated', {
        totalPaymentLines: input.paymentLines?.length || 0,
        actualPaymentReceived: paymentReceived.toFixed(2),
        creditAmount: creditAmount.toFixed(2),
        totalAmount: finalTotalAmount.toFixed(2),
        hasCreditPayment,
      });

      const changeAmount = paymentReceived.minus(finalTotalAmount);

      // BR-SAL-001: Validate payment amount based on payment method
      if (hasCreditPayment) {
        // BUSINESS RULE: Credit sales MUST have a customer
        if (!input.customerId) {
          throw new BusinessError(
            'Credit payment requires a customer to be selected. Cannot process credit sale without customer linkage.',
            'ERR_SALE_002',
            { paymentMethod: 'CREDIT' }
          );
        }

        // Credit sales: Allow 0 to full payment (partial payments allowed)
        if (paymentReceived.lessThan(0)) {
          throw new BusinessError('Payment amount cannot be negative', 'ERR_PAYMENT_002', {
            amountReceived: Money.toNumber(paymentReceived),
          });
        }
        // Allow underpayment or exact payment for credit
        if (paymentReceived.greaterThan(finalTotalAmount.plus(0.01))) {
          throw new BusinessError(
            `Overpayment not allowed for credit sales. Total: ${finalTotalAmount.toFixed(2)}, Received: ${paymentReceived.toFixed(2)}`,
            'ERR_PAYMENT_003',
            {
              totalAmount: Money.toNumber(finalTotalAmount),
              amountReceived: Money.toNumber(paymentReceived),
            }
          );
        }

        logger.info('Credit sale validation passed', {
          customerId: input.customerId,
          totalAmount: finalTotalAmount.toFixed(2),
          paymentReceived: paymentReceived.toFixed(2),
          creditAmount: finalTotalAmount.minus(paymentReceived).toFixed(2),
        });
      } else if (!hasPaymentLines) {
        // Legacy single payment method validation
        // CASH, CARD, MOBILE_MONEY: Require full payment or more (for change)
        SalesBusinessRules.validatePaymentAmount(
          Money.toNumber(finalTotalAmount),
          Money.toNumber(paymentReceived),
          input.paymentMethod
        );

        if (changeAmount.lessThan(0)) {
          throw new BusinessError(
            `Insufficient payment. Total: ${finalTotalAmount.toFixed(2)}, Received: ${paymentReceived.toFixed(2)}`,
            'ERR_PAYMENT_001',
            {
              totalAmount: Money.toNumber(finalTotalAmount),
              amountReceived: Money.toNumber(paymentReceived),
              shortfall: Money.toNumber(changeAmount.abs()),
            }
          );
        }
      }

      // Create sale record with bank-grade precision
      // ============================================================
      // SINGLE SOURCE OF TRUTH: Payment Method Determination
      // ============================================================
      // Rule: If customer owes money after the sale, it's a CREDIT sale.
      // This ensures consistency between sales.payment_method and invoices.
      // - Full payment (amount_paid >= total): Use actual payment method (CASH, CARD, etc.)
      // - Partial/No payment (amount_paid < total): Always CREDIT
      // ============================================================
      const actualAmountPaid = Money.round(paymentReceived, 2);
      const actualTotalAmount = Money.round(finalTotalAmount, 2);
      const hasOutstandingBalance = actualAmountPaid.lessThan(actualTotalAmount);

      // Determine the effective payment method
      // CREDIT if there's any outstanding balance, otherwise use the provided method
      const effectivePaymentMethod = hasOutstandingBalance ? 'CREDIT' : input.paymentMethod;

      // ============================================================
      // CRITICAL: PREVENT GHOST SALES/INVOICES
      // ============================================================
      // Any sale with outstanding balance REQUIRES a customer for invoice tracking
      // This is the SINGLE SOURCE OF TRUTH enforcement point
      if (hasOutstandingBalance && !input.customerId) {
        const outstandingDec = actualTotalAmount.minus(actualAmountPaid);
        throw new BusinessError(
          `Customer required: Cannot create sale with outstanding balance of ${outstandingDec.toFixed(2)} without customer linkage. An invoice must be created to track receivables.`,
          'ERR_SALE_003',
          {
            outstandingBalance: Money.toNumber(outstandingDec),
            totalAmount: Money.toNumber(actualTotalAmount),
            amountPaid: Money.toNumber(actualAmountPaid),
          }
        );
      }

      // Validate customer exists in database if provided
      if (input.customerId) {
        const customerCheck = await client.query(
          'SELECT id, name, credit_limit, balance, COALESCE(unlimited_credit, false) AS unlimited_credit FROM customers WHERE id = $1',
          [input.customerId]
        );

        if (customerCheck.rows.length === 0) {
          throw new NotFoundError(`Customer ${input.customerId}`);
        }

        const customer = customerCheck.rows[0];
        const outstandingAmount = actualTotalAmount.minus(actualAmountPaid);

        // Check credit limit for sales with outstanding balance (enterprise: skip if unlimited)
        if (hasOutstandingBalance && !customer.unlimited_credit && customer.credit_limit) {
          const newBalance = Money.add(customer.balance || 0, outstandingAmount);
          const creditLimit = Money.parse(customer.credit_limit || 0);

          if (newBalance.greaterThan(creditLimit)) {
            logger.warn('Customer exceeding credit limit', {
              customerId: input.customerId,
              customerName: customer.name,
              currentBalance: customer.balance,
              newBalance: Money.toNumber(newBalance),
              creditLimit: Money.toNumber(creditLimit),
              outstandingAmount: Money.toNumber(outstandingAmount),
            });
          }
        }

        logger.info('Customer validation passed', {
          customerId: input.customerId,
          customerName: customer.name,
          hasOutstandingBalance,
          outstandingAmount: hasOutstandingBalance ? outstandingAmount.toFixed(2) : '0',
        });
      }

      // Total discount = cart-level discount + sum of all line-item discounts
      // This ensures sales.discount_amount reflects ALL discounts (not just cart-level)
      const cartDiscount = input.discountAmount
        ? Money.round(new Decimal(input.discountAmount), 2)
        : new Decimal(0);
      const lineItemDiscountTotal = itemsWithCosts.reduce(
        (sum, item) => sum.plus(new Decimal(item.discountAmount || 0)),
        new Decimal(0)
      );
      const totalDiscountAmount = cartDiscount.plus(lineItemDiscountTotal);

      const saleData: CreateSaleData = {
        customerId: input.customerId || null,
        subtotal: input.subtotal
          ? Money.toNumber(Money.round(new Decimal(input.subtotal), 2))
          : Money.toNumber(subtotal),
        totalAmount: Money.toNumber(actualTotalAmount),
        totalCost: Money.toNumber(totalCost),
        discountAmount: Money.toNumber(totalDiscountAmount),
        taxAmount: Money.toNumber(taxAmount),
        paymentMethod: effectivePaymentMethod,
        // Store the actual amount received from the customer (cash tendered)
        // For fully-paid sales: this is the real tendered amount (may exceed totalAmount for cash change)
        // For credit/partial: this is what was actually received
        paymentReceived: Money.toNumber(actualAmountPaid),
        changeAmount: hasOutstandingBalance
          ? 0 // No change for credit/partial payment sales
          : Money.toNumber(changeAmount),
        soldBy: input.soldBy,
        saleDate: input.saleDate, // Pass through backdated sale date if provided
        quoteId: input.quoteId || null, // Link to quotation for auto-conversion
        idempotencyKey: input.idempotencyKey,
        offlineId: input.offlineId,
        cashRegisterSessionId: validatedSessionId || undefined,
        taxOverrideMode: validatedTaxOverride?.mode ?? null,
        taxOverrideRate:
          validatedTaxOverride?.mode === 'FORCE_RATE'
            ? Number(validatedTaxOverride.rate ?? 0)
            : null,
        taxOverrideReason: validatedTaxOverride?.reason ?? null,
        taxOverrideBy: validatedTaxOverride ? input.soldBy : null,
      };

      profiler.mark('line_prep');
      const sale = await salesRepository.createSale(client, saleData);
      profiler.mark('persist_sale_header');

      if (validatedTaxOverride && input.auditContext) {
        await logAction(
          client,
          {
            entityType: 'SALE',
            entityId: sale.id,
            entityNumber: sale.saleNumber,
            action: 'TAX_OVERRIDE',
            severity: 'WARNING',
            category: 'FINANCIAL',
            actionDetails: `Tax override ${validatedTaxOverride.mode}${
              validatedTaxOverride.mode === 'FORCE_RATE'
                ? ` @ ${validatedTaxOverride.rate}%`
                : ''
            } → tax ${Money.toNumber(taxAmount).toFixed(2)}`,
            newValues: {
              mode: validatedTaxOverride.mode,
              rate: validatedTaxOverride.rate ?? null,
              reason: validatedTaxOverride.reason,
              taxAmount: Money.toNumber(taxAmount),
              customerId: input.customerId ?? null,
            },
            notes: validatedTaxOverride.reason,
            tags: ['tax', 'override', 'vat'],
            referenceNumber: sale.saleNumber,
          },
          input.auditContext,
        );
      }

      // ============================================================
      // CRITICAL: DISCOUNT ALLOCATION TO ITEM-LEVEL PROFITS
      // ============================================================
      // Problem: lineTotal and profit were calculated BEFORE discount
      // Fix: Proportionally allocate discount to each item's profit AND discount_amount
      // Formula: itemDiscountShare = lineTotal * (discountAmount / subtotal)
      //          adjustedProfit = originalProfit - itemDiscountShare
      // The item-level discount_amount is also set so the DB trigger
      // (fn_update_sale_totals_internal) can recalculate sale totals correctly.
      // ============================================================
      const discountToAllocate = new Decimal(saleData.discountAmount || 0);
      const saleSubtotal = new Decimal(saleData.subtotal || 0);

      if (discountToAllocate.greaterThan(0) && saleSubtotal.greaterThan(0)) {
        const discountRatio = discountToAllocate.dividedBy(saleSubtotal);

        logger.info('Allocating cart discount to items', {
          discountAmount: discountToAllocate.toFixed(2),
          subtotal: saleSubtotal.toFixed(2),
          discountRatio: discountRatio.toFixed(6),
          itemCount: itemsWithCosts.length,
        });

        let totalDiscountAllocated = new Decimal(0);

        for (let i = 0; i < itemsWithCosts.length; i++) {
          const item = itemsWithCosts[i];
          const itemLineTotal = new Decimal(item.lineTotal);

          // Calculate this item's share of the cart discount
          let itemDiscountShare: Decimal;

          if (i === itemsWithCosts.length - 1) {
            // Last item gets remainder to avoid rounding errors
            itemDiscountShare = discountToAllocate.minus(totalDiscountAllocated);
          } else {
            itemDiscountShare = itemLineTotal.times(discountRatio);
          }

          // Adjust profit: subtract the discount share
          const originalProfit = new Decimal(item.profit);
          const adjustedProfit = originalProfit.minus(itemDiscountShare);

          item.profit = Money.toNumber(adjustedProfit);

          // Distribute cart discount to each item's discount_amount.
          // This is the correct SAP-style approach: application layer calculates
          // all totals, and DB only validates (trg_validate_sale_totals).
          // Cart discount is stored at item level for accurate per-item reporting.
          const existingItemDiscount = new Decimal(item.discountAmount || 0);
          item.discountAmount = Money.toNumber(existingItemDiscount.plus(itemDiscountShare));

          totalDiscountAllocated = totalDiscountAllocated.plus(itemDiscountShare);

          logger.debug('Item adjusted for cart discount', {
            productName: item.productName,
            lineTotal: item.lineTotal,
            itemDiscountShare: itemDiscountShare.toFixed(2),
            totalItemDiscount: item.discountAmount,
            originalProfit: originalProfit.toFixed(2),
            adjustedProfit: adjustedProfit.toFixed(2),
          });
        }

        logger.info('Cart discount allocation complete', {
          totalDiscountAllocated: totalDiscountAllocated.toFixed(2),
          expectedDiscount: discountToAllocate.toFixed(2),
          allocationAccurate: totalDiscountAllocated.equals(discountToAllocate),
        });
      }

      // Add sale ID to items
      itemsWithCosts.forEach((item) => {
        item.saleId = sale.id;
      });

      // Create sale items
      const items = await salesRepository.addSaleItems(client, itemsWithCosts);
      profiler.mark('persist_sale_items');

      // Map to accumulate actual FEFO batch deduction costs per productId.
      // Used after all deductions to verify GL COGS matches actual batch costs (drift guard).
      const actualBatchCostMap = new Map<string, Decimal>();
      const warehouseTraces = new Map<
        number,
        { storeLocationId: string | null; productLotId: string | null; batchId: string | null }
      >();

      const inventoryCouplingBefore = await captureInventoryCoupling(client);

      // Deduct from cost layers AND inventory batches for each item
      for (let lineIdx = 0; lineIdx < input.items.length; lineIdx++) {
        const item = input.items[lineIdx];
        // Skip custom items - they don't have inventory or cost layers
        const isCustomItem = item.productId?.startsWith('custom_');
        if (isCustomItem) {
          logger.info('Skipping inventory deduction for custom item', {
            productId: item.productId,
            productName: item.productName,
          });
          continue;
        }

        // ========== REGULAR PRODUCT INVENTORY DEDUCTION ==========
        const uomSnapshot = saleUomSnapshots.get(lineIdx);
        if (!uomSnapshot) {
          throw new ValidationError(
            `UoM snapshot missing for inventory deduction on product ${item.productId}.`,
          );
        }

        const baseQty = new Decimal(uomSnapshot.baseQuantity);
        const deductConversionFactor = new Decimal(uomSnapshot.conversionFactor);
        const deductBaseUomId = uomSnapshot.baseUomId;

        const recipeLines = recipeExplosionByLine.get(lineIdx) ?? null;
        const parentTypeRes = await client.query(
          `SELECT COALESCE(product_type, 'inventory') AS product_type FROM products WHERE id = $1`,
          [item.productId],
        );
        const parentType = String(parentTypeRes.rows[0]?.product_type || 'inventory');
        const deductPlan = planSaleStockDeduction(parentType, Boolean(recipeLines?.length));
        if (deductPlan.kind === 'skip') {
          logger.info('Skipping inventory deduction for service item', {
            productId: item.productId,
            productName: item.productName,
          });
          continue;
        }

        type DeductTarget = {
          productId: string;
          productName: string;
          baseQty: Decimal;
          enteredQty: number;
          baseUomId: string;
          conversionFactor: Decimal;
        };

        const deductTargets: DeductTarget[] = [];
        if (deductPlan.kind === 'ingredients' && recipeLines?.length) {
          for (const rl of recipeLines) {
            const baseUomRes = await client.query(
              `SELECT p.base_uom_id AS "baseUomId"
               FROM products p
               WHERE p.id = $1`,
              [rl.componentProductId],
            );
            let baseUomId = baseUomRes.rows[0]?.baseUomId as string | undefined | null;
            if (!baseUomId) {
              const snap = await resolveSaleItemUom(
                rl.componentProductId,
                { quantity: 1 },
                client,
              );
              baseUomId = snap.baseUomId;
            }
            if (!baseUomId) {
              throw new ValidationError(
                `Ingredient "${rl.componentName}" needs a base UoM before recipe consumption`,
              );
            }
            deductTargets.push({
              productId: rl.componentProductId,
              productName: rl.componentName,
              baseQty: rl.baseQty,
              enteredQty: Number(rl.baseQty.toFixed(6)),
              baseUomId,
              conversionFactor: new Decimal(1),
            });
          }
          logger.info('Recipe BOM inventory explosion', {
            parentProductId: item.productId,
            parentName: item.productName,
            ingredientCount: deductTargets.length,
          });
        } else {
          deductTargets.push({
            productId: item.productId,
            productName: item.productName,
            baseQty,
            enteredQty: item.quantity,
            baseUomId: deductBaseUomId,
            conversionFactor: deductConversionFactor,
          });
        }

        // Movement numbers: Postgres SEQUENCE (nextval) — do NOT hold advisory_xact_lock
        // across FEFO/GL (that serialized concurrent order completes past the 30s timeout).

        let lineActualCost = new Decimal(0);

        for (const target of deductTargets) {
          const productResult = await client.query(
            'SELECT costing_method FROM product_valuation WHERE product_id = $1',
            [target.productId],
          );
          const costingMethod = productResult.rows[0]?.costing_method || 'FIFO';
          if (costingMethod === 'FIFO') {
            costLayerDeductions.push({
              productId: target.productId,
              quantity: target.baseQty.toNumber(),
              costingMethod,
            });
          }

          const expiryRuleRes = await client.query(
            `SELECT COALESCE(min_days_before_expiry_sale, 0) AS min_days
             FROM products WHERE id = $1`,
            [target.productId],
          );
          const minDaysBeforeExpiry = parseInt(expiryRuleRes.rows[0]?.min_days ?? '0', 10);

          if (multistoreEnabled && sellingStoreId) {
            const deductResult = await warehouseSaleDeductionService.deductForSaleLine(client, {
              storeLocationId: sellingStoreId,
              productId: target.productId,
              productName: target.productName,
              baseQty: target.baseQty,
              saleId: sale.id,
              saleNumber: sale.saleNumber,
              soldBy: input.soldBy ?? null,
              enteredQty: target.enteredQty,
              baseUomId: target.baseUomId,
              conversionFactor: target.conversionFactor.toFixed(6),
            });
            lineActualCost = lineActualCost.plus(deductResult.actualBatchCost);
            if (!warehouseTraces.has(lineIdx)) {
              warehouseTraces.set(lineIdx, {
                storeLocationId: deductResult.storeLocationId,
                productLotId: deductResult.primaryProductLotId,
                batchId: deductResult.primaryBatchId,
              });
            }
            continue;
          }

          const selectableLots = await loadGlobalSelectableLots(client, target.productId, {
            forUpdate: true,
            minDaysBeforeExpiry,
          });
          const consumptionPlan = selectLots({
            policy: 'FEFO',
            lots: selectableLots,
            quantity: target.baseQty.toNumber(),
            businessDate: getBusinessDate(),
            minDaysBeforeExpirySale: minDaysBeforeExpiry,
          });

          if (consumptionPlan.shortfall > 0.001) {
            const remainingQty = new Decimal(consumptionPlan.shortfall);
            const nearestExpiry = selectableLots[0]?.expiryDate ?? null;
            const totalAvailable = new Decimal(consumptionPlan.totalAllocated);
            const isExpiryBlock = minDaysBeforeExpiry > 0 && nearestExpiry;
            const errorCode =
              selectableLots.length === 0
                ? 'ERR_STOCK_001'
                : isExpiryBlock
                  ? 'ERR_EXPIRY_001'
                  : 'ERR_STOCK_001';

            throw new BusinessError(
              `Not enough stock for "${target.productName}"` +
                (recipeLines?.length ? ` (recipe ingredient for "${item.productName}")` : '') +
                `. Requested: ${target.baseQty.toFixed(2)}, Available: ${totalAvailable.toFixed(2)}, ` +
                `Short by: ${remainingQty.toFixed(2)}.`,
              errorCode,
              {
                product: target.productName,
                productId: target.productId,
                parentProductId: item.productId,
                requested: Money.toNumber(target.baseQty),
                available: Money.toNumber(totalAvailable),
                shortBy: Money.toNumber(remainingQty),
                expiryDate: nearestExpiry,
                minDaysBeforeExpiry: minDaysBeforeExpiry > 0 ? minDaysBeforeExpiry : undefined,
                batchCount: selectableLots.length,
              },
            );
          }

          const consumeResult = await lotService.consumeLot(client, {
            productId: target.productId,
            quantity: target.baseQty.toNumber(),
            selectionPolicy: 'FEFO',
            minDaysBeforeExpiry,
            referenceType: 'SALE',
            referenceId: sale.id,
            userId: input.soldBy ?? 'system',
            productName: target.productName,
            recordMovement: false,
            syncProduct: false,
          });

          for (const layer of consumeResult.layers) {
            const movementNumber = await allocateNextMovementNumber(client);

            const batchCostDec = Money.parseDb(layer.costPrice);
            const qtyToDeduct = new Decimal(layer.quantity);
            const batchUnitCost = Money.toNumber(Money.round(batchCostDec));

            await client.query(
              `INSERT INTO stock_movements (
                movement_number, product_id, batch_id, movement_type, quantity, unit_cost,
                reference_type, reference_id, notes, created_by_id,
                entered_qty, base_uom_id, conversion_factor
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
              [
                movementNumber,
                target.productId,
                layer.lotId,
                'SALE',
                qtyToDeduct.abs().toFixed(4),
                batchUnitCost,
                'SALE',
                sale.id,
                recipeLines?.length
                  ? `Sale ${sale.saleNumber} - recipe ingredient for ${item.productName}`
                  : `Sale ${sale.saleNumber} - FEFO batch deduction`,
                input.soldBy || null,
                target.enteredQty,
                target.baseUomId,
                target.conversionFactor.toFixed(6),
              ],
            );

            logger.info(`Inventory batch deducted for product ${target.productId}`, {
              batchId: layer.lotId,
              quantity: qtyToDeduct.toFixed(4),
            });
          }

          lineActualCost = lineActualCost.plus(Money.parseDb(consumeResult.totalCost));

          if (!warehouseTraces.has(lineIdx) && consumeResult.layers[0]) {
            warehouseTraces.set(lineIdx, {
              storeLocationId: null,
              productLotId: null,
              batchId: consumeResult.layers[0].lotId,
            });
          }

          await syncProductQuantity(client, target.productId);
        }

        // Attribute total ingredient cost to parent sale line for COGS reconcile
        const prevActual = actualBatchCostMap.get(item.productId) ?? new Decimal(0);
        actualBatchCostMap.set(item.productId, prevActual.plus(lineActualCost));
      }

      const couplingAfterDeduction = await captureInventoryCoupling(client);
      const exactInventoryIssueCost = resolveGl1300FromBatchSubledgerDelta(
        inventoryCouplingBefore,
        couplingAfterDeduction,
        'issue',
      );

      // ============================================================
      // ENTERPRISE COGS: physical deduction is source of truth
      // ============================================================
      // Preview (early in TX) may differ from locked FEFO deduction under
      // concurrency or rounding. Reconcile sale lines + header to actual cost;
      // log preview drift for ops — never block checkout.
      const { previewDrifts, totalActualCost } = reconcileSaleCostsToActualBatchDeduction(
        itemsWithCosts,
        actualBatchCostMap,
      );

      if (previewDrifts.length > 0) {
        logger.warn('[COGS PREVIEW DRIFT] Reconciled sale to actual FEFO deduction', {
          saleId: sale.id,
          saleNumber: sale.saleNumber,
          drifts: previewDrifts,
        });
      }

      const reconciledLineCostNum = Money.toNumber(totalActualCost);
      if (
        documentTotalDiffersFromSubledger(reconciledLineCostNum, exactInventoryIssueCost)
      ) {
        logger.warn('[COGS] Reconciled line cost differs from batch subledger reduction', {
          saleId: sale.id,
          saleNumber: sale.saleNumber,
          reconciledLineCost: reconciledLineCostNum,
          batchSubledgerReduction: exactInventoryIssueCost,
        });
      }

      const saleSubtotalDec = new Decimal(sale.subtotal ?? saleData.subtotal ?? 0);
      const saleDiscountDec = new Decimal(sale.discountAmount ?? saleData.discountAmount ?? 0);
      const revenueBeforeTax = saleSubtotalDec.minus(saleDiscountDec);
      const reconciledProfit = revenueBeforeTax.minus(exactInventoryIssueCost);
      const reconciledMargin = revenueBeforeTax.greaterThan(0)
        ? reconciledProfit.dividedBy(revenueBeforeTax).toNumber()
        : 0;

      await salesRepository.updatePostedSaleCostsAfterDeduction(
        client,
        sale.id,
        {
          totalCost: exactInventoryIssueCost,
          profit: Money.toNumber(Money.round(reconciledProfit, 2)),
          profitMargin: reconciledMargin,
        },
        items.map((postedItem, index) => ({
          id: postedItem.id,
          unitCost: itemsWithCosts[index]?.costPrice ?? 0,
          profit: itemsWithCosts[index]?.profit ?? 0,
        })),
      );

      for (let lineIdx = 0; lineIdx < items.length; lineIdx++) {
        const trace = warehouseTraces.get(lineIdx);
        if (trace) {
          await salesRepository.updateSaleItemWarehouseTrace(client, items[lineIdx].id, trace);
        }
      }

      sale.totalCost = exactInventoryIssueCost;

      const actualInventoryCost = exactInventoryIssueCost;
      profiler.mark('fefo_stock');

      // GL POSTING: AFTER physical FEFO deduction so COGS credits 1300 at actual batch cost.
      try {
        await glEntryService.recordSaleToGL(
          {
            saleId: sale.id,
            saleNumber: sale.saleNumber,
            saleDate: sale.saleDate || getBusinessDate(),
            totalAmount: sale.totalAmount,
            costAmount: sale.totalCost || 0,
            actualInventoryCost,
            paymentMethod: sale.paymentMethod as SaleData['paymentMethod'],
            amountPaid: sale.amountPaid ?? 0,
            taxAmount: sale.taxAmount || 0,
            customerId: sale.customerId || undefined,
            saleItems: itemsWithCosts.map((item) => ({
              productType: item.productId?.startsWith('custom_')
                ? ('service' as const)
                : ('inventory' as const),
              totalPrice: item.lineTotal,
              unitCost: item.costPrice || 0,
              quantity: item.quantity,
            })),
          },
          pool,
          client
        );
      } catch (glError: unknown) {
        logger.error('GL posting failed for sale — transaction will rollback', {
          saleId: sale.id,
          saleNumber: sale.saleNumber,
          error: glError instanceof Error ? glError.message : String(glError),
        });
        throw glError;
      }
      profiler.mark('gl_posting');

      // Kitchen Production Phase 3: buffet cover capacity (no ingredient re-explosion)
      try {
        await buffetSessionService.tryConsumeCoversForSale(client, {
          saleId: sale.id,
          saleDate: String(sale.saleDate || getBusinessDate()).slice(0, 10),
          userId: input.soldBy ?? null,
          lines: input.items
            .filter((it) => it.productId && !it.productId.startsWith('custom_'))
            .map((it) => ({
              productId: it.productId,
              quantity: it.quantity,
            })),
        });
      } catch (buffetErr) {
        logger.error('Buffet cover allocation failed — transaction will rollback', {
          saleId: sale.id,
          error: buffetErr instanceof Error ? buffetErr.message : String(buffetErr),
        });
        throw buffetErr;
      }

      if (input.exchangeRefundId && saleDiscountDec.greaterThan(0)) {
        const creditApplied = Money.toNumber(saleDiscountDec);
        const exchangeRefund = await salesRepository.getExchangeRefundForApplication(
          client,
          input.exchangeRefundId,
        );
        if (exchangeRefund) {
          await salesRepository.applyExchangeCreditToSale(
            client,
            input.exchangeRefundId,
            sale.id,
            creditApplied,
          );
          await glEntryService.recordExchangeCreditApplicationToGL(
            {
              refundId: exchangeRefund.id,
              refundNumber: exchangeRefund.refundNumber,
              saleId: sale.id,
              saleNumber: sale.saleNumber,
              applicationDate: String(sale.saleDate || getBusinessDate()).slice(0, 10),
              amount: creditApplied,
              customerId: input.customerId || undefined,
            },
            pool,
            client,
          );

          // Residual after this application — pay out or leave as numbered voucher
          const remainingAfter = exchangeRefund.remainingAmount - creditApplied;
          if (remainingAfter > 0.01) {
            const residualAction = input.exchangeResidualAction ?? 'REFUND_ORIGINAL_TENDER';
            if (residualAction === 'REFUND_ORIGINAL_TENDER') {
              // Look up original sale tender for residual payout source
              const orig = await client.query<{
                payment_method: string;
                customer_id: string | null;
              }>(
                `SELECT s.payment_method, s.customer_id
                 FROM sale_refunds r
                 JOIN sales s ON s.id = r.sale_id
                 WHERE r.id = $1`,
                [exchangeRefund.id],
              );
              const paymentMethod = (orig.rows[0]?.payment_method || 'CASH') as
                | 'CASH'
                | 'CARD'
                | 'MOBILE_MONEY'
                | 'AIRTEL_MONEY'
                | 'CREDIT'
                | 'DEPOSIT';
              await salesRepository.applyExchangeResidualPayout(
                client,
                exchangeRefund.id,
                remainingAfter,
              );
              await glEntryService.recordExchangeResidualPayoutToGL(
                {
                  refundId: exchangeRefund.id,
                  refundNumber: exchangeRefund.refundNumber,
                  payoutDate: String(sale.saleDate || getBusinessDate()).slice(0, 10),
                  amount: remainingAfter,
                  paymentMethod,
                  customerId: orig.rows[0]?.customer_id || input.customerId || undefined,
                },
                pool,
                client,
              );
              // Drawer tracking when residual leaves as cash
              if (paymentMethod === 'CASH' || paymentMethod === 'MOBILE_MONEY' || paymentMethod === 'AIRTEL_MONEY') {
                try {
                  let sessionId: string | null = input.cashRegisterSessionId || null;
                  if (!sessionId) {
                    const openSession = await cashRegisterRepository.getUserOpenSession(
                      client,
                      input.soldBy,
                    );
                    sessionId = openSession?.id || null;
                  }
                  if (sessionId) {
                    await cashRegisterService.recordRefundMovement(
                      sessionId,
                      exchangeRefund.id,
                      remainingAfter,
                      input.soldBy,
                      `Exchange residual ${exchangeRefund.refundNumber}`,
                      pool,
                    );
                  }
                } catch (regErr) {
                  logger.warn('Cash register residual exchange movement failed', {
                    refundId: exchangeRefund.id,
                    error: regErr instanceof Error ? regErr.message : String(regErr),
                  });
                }
              }
            }
            // KEEP_VOUCHER: remaining liability stays open on 2210, controlled by refund number
          }
        }
      }

      // BR-SAL-002: Update customer balance for CREDIT sales (split payment support)
      // Customer balance represents accounts receivable (amount owed by customer)

      // Check if any payment line is CREDIT
      const hasCreditInPaymentLines =
        input.paymentLines?.some((line) => line.paymentMethod === 'CREDIT') || false;
      const isCreditSale = input.paymentMethod === 'CREDIT' || hasCreditInPaymentLines;

      // creditAmount is already calculated above (from payment lines or as Decimal)
      // Convert to number for use below
      const creditAmountNum = Money.toNumber(creditAmount);

      // NOTE: Customer balance is now managed by the invoice system (SINGLE SOURCE OF TRUTH)
      // When an invoice is created/updated, the database trigger `trg_sync_customer_balance_on_invoice`
      // automatically recalculates customer.balance from SUM(invoices.OutstandingBalance)
      // We no longer directly update customer balance here to avoid double-counting
      if (isCreditSale && input.customerId && creditAmountNum > 0) {
        logger.info('Credit sale detected - customer balance will be updated by invoice trigger', {
          customerId: input.customerId,
          creditAmount: creditAmountNum,
        });
      }

      // ========== CREATE PAYMENT LINES (Split Payment Support) ==========
      if (input.paymentLines && input.paymentLines.length > 0) {
        // Insert payment lines
        const paymentLinesValues: unknown[] = [];
        const paymentLinesPlaceholders: string[] = [];

        input.paymentLines.forEach((line, index) => {
          const offset = index * 4;
          paymentLinesPlaceholders.push(
            `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4})`
          );
          paymentLinesValues.push(
            sale.id,
            line.paymentMethod,
            new Decimal(line.amount).toFixed(2), // String for PostgreSQL NUMERIC
            line.reference || null
          );
        });

        await client.query(
          `INSERT INTO payment_lines (sale_id, payment_method, amount, reference)
           VALUES ${paymentLinesPlaceholders.join(', ')}`,
          paymentLinesValues
        );

        logger.info('Payment lines created', {
          saleId: sale.id,
          saleNumber: sale.saleNumber,
          paymentCount: input.paymentLines.length,
          totalPaid: input.paymentLines
            .reduce((sum, line) => sum.plus(new Decimal(line.amount)), new Decimal(0))
            .toDecimalPlaces(2)
            .toNumber(),
        });

        // ========== APPLY DEPOSITS (if DEPOSIT payment method used) ==========
        const depositPaymentLines = input.paymentLines.filter(
          (line) => line.paymentMethod === 'DEPOSIT'
        );
        if (depositPaymentLines.length > 0 && !input.customerId) {
          throw new BusinessError(
            'DEPOSIT payment requires a customer. Cannot apply deposit without a customer account.',
            'ERR_SALE_005',
            { paymentMethod: 'DEPOSIT' }
          );
        }
        if (depositPaymentLines.length > 0 && input.customerId) {
          const totalDepositAmount = depositPaymentLines
            .reduce((sum, line) => sum.plus(new Decimal(line.amount)), new Decimal(0))
            .toNumber();

          if (totalDepositAmount > 0) {
            try {
              const { applyDepositsToSaleInTransaction } = await import(
                '../deposits/depositsService.js'
              );

              const depositResult = await applyDepositsToSaleInTransaction(
                client,
                input.customerId,
                sale.id,
                totalDepositAmount,
                input.soldBy
              );

              // GL POSTING: Clear Customer Deposits liability and AR for each application
              // MUST succeed — if GL fails, the entire sale rolls back to prevent discrepancies
              const custRow = await client.query(
                'SELECT name FROM customers WHERE id = $1',
                [input.customerId]
              );
              const depositCustomerName = custRow.rows[0]?.name || 'Unknown';
              for (const app of depositResult.applications) {
                await glEntryService.recordDepositApplicationToGL(
                  {
                    applicationId: app.id,
                    depositId: app.depositId,
                    depositNumber: app.depositNumber || '',
                    saleId: sale.id,
                    saleNumber: sale.saleNumber,
                    applicationDate: sale.saleDate || getBusinessDate(),
                    amount: app.amountApplied,
                    customerId: input.customerId,
                    customerName: depositCustomerName,
                  },
                  pool,
                  client
                );
              }

              logger.info('Customer deposits applied to sale', {
                saleId: sale.id,
                saleNumber: sale.saleNumber,
                customerId: input.customerId,
                totalDepositsApplied: depositResult.totalApplied,
                applicationsCount: depositResult.applications.length,
              });
              assertAppliedEqualsRequested(depositResult.totalApplied, totalDepositAmount);
            } catch (depositError: unknown) {
              logger.error('Failed to apply customer deposits', {
                saleId: sale.id,
                customerId: input.customerId,
                requestedAmount: totalDepositAmount,
                error: depositError instanceof Error ? depositError.message : String(depositError),
              });
              throw new BusinessError(
                `Failed to apply customer deposits: ${depositError instanceof Error ? depositError.message : String(depositError)}`,
                'ERR_SALE_004',
                { customerId: input.customerId, requestedAmount: totalDepositAmount }
              );
            }
          }
        }
      }

      // AUTO-CONVERSION: If quote ID provided, mark quotation as converted
      // Business Logic for POS: Allow DRAFT/SENT/ACCEPTED quotations to convert
      // Workflow: Quote (DRAFT/SENT/ACCEPTED) → Load to POS → Customer Pays → CONVERTED
      // Note: Stricter validation (ACCEPTED only) applies to formal conversion endpoint
      if (input.quoteId) {
        try {
          logger.info('🔍 Starting quote auto-conversion from POS', {
            quoteId: input.quoteId,
            customerId: input.customerId,
            hasPaymentLines: !!(input.paymentLines && input.paymentLines.length > 0),
          });

          // BR-QUOTE-001: Verify quotation exists and isn't already converted
          const quoteCheck = await client.query('SELECT status FROM quotations WHERE id = $1', [
            input.quoteId,
          ]);

          if (!quoteCheck.rows[0]) {
            throw new NotFoundError('Quotation');
          }

          const quoteStatus = quoteCheck.rows[0].status;

          // POS allows DRAFT, SENT, or ACCEPTED quotes to convert
          // (customer payment in POS implies acceptance)
          const allowedStatuses = ['DRAFT', 'SENT', 'ACCEPTED'];
          if (!allowedStatuses.includes(quoteStatus)) {
            throw new BusinessError(
              `Cannot convert quotation with status: ${quoteStatus}. Already converted, cancelled, or rejected.`,
              'ERR_SALE_005',
              { quoteId: input.quoteId, currentStatus: quoteStatus, allowedStatuses }
            );
          }

          logger.info('✅ Quotation verified for POS conversion', {
            quoteId: input.quoteId,
            status: quoteStatus,
            note: 'POS conversion allows DRAFT/SENT/ACCEPTED statuses',
          });

          // Create invoice for quote conversion (business rule: quotes always get invoices)
          let invoiceId: string | undefined;
          if (input.customerId) {
            const { invoiceRepository } = await import('../invoices/invoiceRepository.js');

            // Fetch customer name for invoice (required field)
            const customerResult = await client.query('SELECT name FROM customers WHERE id = $1', [
              input.customerId,
            ]);
            const customerName = customerResult.rows[0]?.name || 'Unknown Customer';

            // Calculate due date (30 days from today) — string-only, no Date conversion
            const dueDateStr = addDaysToDateString(getBusinessDate(), 30);

            const invoiceResult = await invoiceRepository.createInvoice(client, {
              saleId: sale.id,
              customerId: input.customerId,
              customerName: customerName,
              quoteId: input.quoteId,
              dueDate: dueDateStr,
              subtotal: Money.toNumber(subtotal),
              taxAmount: Money.toNumber(taxAmount),
              totalAmount: Money.toNumber(finalTotalAmount),
              createdById: input.soldBy,
            });
            invoiceId = invoiceResult?.id;

            // Record payments on invoice using repository (not service - we're already in a transaction)
            // Follow BR-INV-001, BR-INV-002, BR-INV-003 (established invoice payment business rules)
            if (input.paymentLines && input.paymentLines.length > 0 && invoiceId) {
              // VALIDATION: Ensure total payment amount doesn't exceed invoice total
              const totalPayments = input.paymentLines
                .filter((p) => p.paymentMethod !== 'CREDIT' && p.amount > 0)
                .reduce((sum, p) => sum.plus(new Decimal(p.amount)), new Decimal(0))
                .toNumber();

              if (
                new Decimal(totalPayments).greaterThan(
                  new Decimal(input.totalAmount || 0).plus('0.01')
                )
              ) {
                throw new BusinessError(
                  `Payment amount (${totalPayments}) exceeds invoice total (${input.totalAmount})`,
                  'ERR_PAYMENT_004',
                  { totalPayments, invoiceTotal: input.totalAmount }
                );
              }

              // Record each non-CREDIT payment separately (matches invoice_payments table structure)
              for (const paymentLine of input.paymentLines) {
                if (paymentLine.paymentMethod !== 'CREDIT' && paymentLine.amount > 0) {
                  await invoiceRepository.addPayment(client, {
                    invoiceId,
                    amount: Money.toNumber(Money.parse(paymentLine.amount)),
                    paymentMethod: paymentLine.paymentMethod as
                      | 'CASH'
                      | 'CARD'
                      | 'MOBILE_MONEY'
                      | 'AIRTEL_MONEY'
                      | 'BANK_TRANSFER',
                    paymentDate: undefined, // Use current date
                    referenceNumber: paymentLine.reference || null,
                    notes: null,
                    processedById: input.soldBy, // Cashier who processed the sale
                  });
                }
              }

              // Recalculate invoice aggregates & status after all payments
              await invoiceRepository.recalcInvoice(client, invoiceId);

              // Synchronize payment to linked sale
              const freshInvoice = await invoiceRepository.getInvoiceById(client, invoiceId);
              if (freshInvoice) {
                await client.query(
                  `UPDATE sales 
                   SET amount_paid = $1 
                   WHERE id = $2`,
                  [freshInvoice.amount_paid, sale.id]
                );
              }

              // Recalculate customer balance from invoices (SSOT)
              const { syncCustomerBalanceFromInvoices } = await import('../../utils/customerBalanceSync.js');
              await syncCustomerBalanceFromInvoices(client, input.customerId, 'QUOTATION_CREDIT_SALE');
            }
          }

          // BR-QUOTE-003: Mark quotation as CONVERTED (proper business logic)
          // CONVERTED status provides clear audit trail and prevents duplicate conversions
          const { quotationRepository } = await import('../quotations/quotationRepository.js');
          await quotationRepository.markQuotationAsConverted(
            client,
            input.quoteId,
            sale.id,
            invoiceId || null
          );

          logger.info('✅ Quote converted to sale', {
            quoteId: input.quoteId,
            saleId: sale.id,
            saleNumber: sale.saleNumber,
            invoiceId,
            note: 'Quotation status unchanged - remains visible in active list',
            workflow: 'Quote → POS Sale → Invoice (status preserved)',
          });
        } catch (quoteError) {
          logger.error('❌ Failed to link quote to sale', {
            quoteId: input.quoteId,
            saleId: sale.id,
            saleNumber: sale.saleNumber,
            error: quoteError instanceof Error ? quoteError.message : String(quoteError),
            stack: quoteError instanceof Error ? quoteError.stack : undefined,
          });
          // Hard fail: a quote link failure after inventory has been deducted
          // means we cannot guarantee convert-once. Roll back the whole TX so
          // stock and GL stay coupled and the customer can retry cleanly.
          // The earlier pre-validation makes the routine case (stale quoteId)
          // fail BEFORE any deduction; this re-throw protects against the
          // narrow race where the quote is converted between pre-check and
          // markQuotationAsConverted.
          throw quoteError;
        }
      }
      // CREDIT SALE INVOICE: Create invoice if there's any outstanding balance
      // Single Source of Truth: hasOutstandingBalance determines if invoice is needed
      else if (input.customerId && hasOutstandingBalance) {
        try {
          const { invoiceRepository } = await import('../invoices/invoiceRepository.js');

          // ============================================================
          // CRITICAL: VALIDATE CUSTOMER BEFORE INVOICE CREATION
          // ============================================================
          // Prevent ghost invoices - customer MUST exist and be valid
          const customerResult = await client.query(
            'SELECT name, is_active FROM customers WHERE id = $1',
            [input.customerId]
          );

          if (customerResult.rows.length === 0) {
            throw new BusinessError(
              `Cannot create invoice for non-existent customer. This would create an orphaned receivable.`,
              'ERR_SALE_006',
              { customerId: input.customerId }
            );
          }

          const customer = customerResult.rows[0];
          const customerName = customer.name || 'Unknown Customer';

          if (!customer.is_active) {
            logger.warn('Creating invoice for inactive customer', {
              customerId: input.customerId,
              customerName,
              saleId: sale.id,
              saleNumber: sale.saleNumber,
            });
            // Optional: Throw error to prevent sales to inactive customers
            // throw new Error(`Cannot create invoice for inactive customer "${customerName}"`);
          }

          logger.info('🧾 Creating invoice for credit sale', {
            saleId: sale.id,
            saleNumber: sale.saleNumber,
            customerId: input.customerId,
            customerName,
            creditAmount: creditAmount.toFixed(2),
            totalAmount: Money.toNumber(finalTotalAmount),
            hasPaymentLines: !!(input.paymentLines && input.paymentLines.length > 0),
          });

          // Calculate due date (30 days from today) — string-only, no Date conversion
          const dueDateStr = addDaysToDateString(getBusinessDate(), 30);

          // IMPORTANT: Invoice represents the FULL SALE, not just the credit portion
          // This allows tracking all payments against the full amount
          const invoiceResult = await invoiceRepository.createInvoice(client, {
            saleId: sale.id,
            customerId: input.customerId,
            customerName: customerName,
            quoteId: input.quoteId ?? null,
            dueDate: dueDateStr,
            subtotal: Money.toNumber(subtotal),
            taxAmount: Money.toNumber(taxAmount),
            totalAmount: Money.toNumber(finalTotalAmount), // Full sale amount
            createdById: input.soldBy,
          });
          const invoiceId = invoiceResult?.id;

          // Record ALL non-CREDIT payments on the invoice
          // This ensures the invoice shows what was already paid
          if (input.paymentLines && input.paymentLines.length > 0 && invoiceId) {
            for (const paymentLine of input.paymentLines) {
              if (paymentLine.paymentMethod !== 'CREDIT' && paymentLine.amount > 0) {
                await invoiceRepository.addPayment(client, {
                  invoiceId,
                  amount: Money.toNumber(Money.parse(paymentLine.amount)),
                  paymentMethod: paymentLine.paymentMethod as
                    | 'CASH'
                    | 'CARD'
                    | 'MOBILE_MONEY'
                    | 'AIRTEL_MONEY'
                    | 'BANK_TRANSFER',
                  paymentDate: undefined,
                  referenceNumber: paymentLine.reference || null,
                  notes: 'Initial payment from sale',
                  processedById: input.soldBy,
                });

                logger.info('Invoice payment recorded for credit sale', {
                  invoiceId,
                  amount: paymentLine.amount,
                  paymentMethod: paymentLine.paymentMethod,
                });
              }
            }

            // Recalculate invoice after all payments
            // This will update: amount_paid, balance, and status
            const updatedInvoice = await invoiceRepository.recalcInvoice(client, invoiceId);

            logger.info('Invoice recalculated', {
              invoiceId,
              totalAmount: updatedInvoice?.total_amount,
              amountPaid: updatedInvoice?.amount_paid,
              balance: updatedInvoice?.balance,
              status: updatedInvoice?.status,
            });
          }

          logger.info('✅ Invoice created for credit sale', {
            saleId: sale.id,
            saleNumber: sale.saleNumber,
            invoiceId,
            totalAmount: parseFloat(finalTotalAmount.toFixed(2)),
            creditAmount: creditAmount.toFixed(2),
            workflow: 'Credit sale → Invoice with initial payment',
          });

          // Recalculate customer balance from invoices (SSOT)
          const { syncCustomerBalanceFromInvoices } = await import('../../utils/customerBalanceSync.js');
          await syncCustomerBalanceFromInvoices(client, input.customerId, 'CREDIT_SALE');
        } catch (invoiceError) {
          logger.error('❌ Failed to create invoice for credit sale - ROLLING BACK TRANSACTION', {
            saleId: sale.id,
            saleNumber: sale.saleNumber,
            error: invoiceError instanceof Error ? invoiceError.message : String(invoiceError),
            stack: invoiceError instanceof Error ? invoiceError.stack : undefined,
          });
          // CRITICAL: Invoice is MANDATORY for credit sales - must rollback!
          // Without invoice, accounts receivable cannot be tracked
          throw new BusinessError(
            `Credit sale requires invoice but invoice creation failed: ${invoiceError instanceof Error ? invoiceError.message : String(invoiceError)}`,
            'ERR_SALE_007',
            { saleId: sale.id, saleNumber: sale.saleNumber }
          );
        }
      }
      profiler.mark('payments_ar');

      // ============================================================
      // PRE-COMMIT: Deduct from cost layers (FIFO products)
      // Must run inside transaction for atomicity with inventory changes
      // ============================================================
      for (const deduction of costLayerDeductions) {
        try {
          await costLayerService.deductFromCostLayers(
            deduction.productId,
            deduction.quantity,
            deduction.costingMethod,
            undefined, // dbPool
            client // txClient: reuse sale transaction to prevent deadlock
          );
          logger.info(`Cost layers deducted for product ${deduction.productId}`, {
            quantity: deduction.quantity,
            method: deduction.costingMethod,
          });
        } catch (error: unknown) {
          // Cost layer deduction failed - inventory already deducted but FIFO/AVCO tracking incomplete
          if (
            (error instanceof Error ? error.message : String(error))?.includes(
              'Insufficient cost layers'
            )
          ) {
            // Expected case: product uses average cost or has no layers
            logger.debug(
              `No cost layers available for product ${deduction.productId}, using average cost`,
              {
                productId: deduction.productId,
                quantity: deduction.quantity,
              }
            );
          } else {
            // Unexpected failure - log for manual review
            logger.warn('Cost layer deduction failed - FIFO/AVCO tracking may be inaccurate', {
              saleId: sale.id,
              saleNumber: sale.saleNumber,
              productId: deduction.productId,
              quantity: deduction.quantity,
              error: error instanceof Error ? error.message : String(error),
              remediation: 'Review cost layers for this product and adjust if needed',
            });
            warnings.push(
              `Cost layer deduction failed for product ${deduction.productId}: ${error instanceof Error ? error.message : String(error)}. FIFO/AVCO tracking may be inaccurate.`
            );
          }
        }
      }

      // ============================================================
      // SAP GLT0-EQUIVALENT: Atomically update daily summary rollup
      // Must happen INSIDE the transaction so totals stay in sync
      // SAVEPOINT: prevents PG aborted-transaction if this fails
      // ============================================================
      try {
        await client.query('SAVEPOINT daily_summary');
        const summaryDate = sale.saleDate || getBusinessDate();
        const isCredit = sale.paymentMethod === 'CREDIT';
        // pg returns NUMERIC as strings — must convert for numeric comparison
        const paidNum = parseFloat(String(sale.amountPaid ?? 0));
        const totalNum = parseFloat(String(sale.totalAmount));
        const isPartial = isCredit && paidNum > 0 && paidNum < totalNum;
        await salesRepository.incrementDailySummary(
          client,
          summaryDate,
          sale.paymentMethod,
          sale.totalAmount,
          sale.totalCost || 0,
          sale.discountAmount || 0,
          isCredit,
          isPartial
        );
      } catch (summaryError: unknown) {
        await client.query('ROLLBACK TO SAVEPOINT daily_summary');
        logger.error('Daily summary rollup update failed — will be healed by reconciliation', {
          saleId: sale.id,
          saleNumber: sale.saleNumber,
          error: summaryError instanceof Error ? summaryError.message : String(summaryError),
        });
      }

      // ============================================================
      // STATE TABLES: Product daily summary + Inventory balances
      // Atomically maintained inside posting transaction (SAP pattern)
      // Batch UPSERTs: 1 query per table instead of N per item (100M-scale)
      // SAVEPOINT: prevents PG aborted-transaction if this fails
      // ============================================================
      try {
        await client.query('SAVEPOINT state_tables');
        const stateDate = sale.saleDate || getBusinessDate();

        // Batch-fetch categories for all non-custom products
        const productIdsForCategory = itemsWithCosts
          .filter((it) => it.productId && !it.productId.startsWith('custom_'))
          .map((it) => it.productId!);

        const categoryMap = new Map<string, string>();
        if (productIdsForCategory.length > 0) {
          const catResult = await client.query(
            `SELECT id, COALESCE(NULLIF(TRIM(category), ''), 'Uncategorized') as category
             FROM products WHERE id = ANY($1)`,
            [[...new Set(productIdsForCategory)]]
          );
          for (const row of catResult.rows) {
            categoryMap.set(row.id, row.category);
          }
        }

        // Pre-aggregate by productId to avoid ON CONFLICT self-collision
        const pdsSummaryMap = new Map<string, { category: string; unitsSold: Decimal; revenue: Decimal; costOfGoods: Decimal; discountGiven: Decimal }>();
        const invSummaryMap = new Map<string, Decimal>();

        for (const item of itemsWithCosts) {
          if (!item.productId || item.productId.startsWith('custom_')) continue;

          const existing = pdsSummaryMap.get(item.productId);
          const costOfGoods = new Decimal(item.costPrice || 0).times(item.quantity);
          if (existing) {
            existing.unitsSold = existing.unitsSold.plus(item.quantity);
            existing.revenue = existing.revenue.plus(item.lineTotal);
            existing.costOfGoods = existing.costOfGoods.plus(costOfGoods);
            existing.discountGiven = existing.discountGiven.plus(item.discountAmount || 0);
          } else {
            pdsSummaryMap.set(item.productId, {
              category: categoryMap.get(item.productId) || 'Uncategorized',
              unitsSold: new Decimal(item.quantity),
              revenue: new Decimal(item.lineTotal),
              costOfGoods,
              discountGiven: new Decimal(item.discountAmount || 0),
            });
          }

          const invExisting = invSummaryMap.get(item.productId);
          invSummaryMap.set(item.productId, (invExisting || new Decimal(0)).plus(item.quantity));
        }

        // 1 query: batch product daily summary
        const pdsItems = Array.from(pdsSummaryMap.entries()).map(([productId, agg]) => ({
          productId,
          category: agg.category,
          unitsSold: agg.unitsSold.toNumber(),
          revenue: agg.revenue.toNumber(),
          costOfGoods: agg.costOfGoods.toNumber(),
          discountGiven: agg.discountGiven.toNumber(),
        }));
        await stateTablesRepo.batchUpsertProductDailySummary(client, stateDate, pdsItems);
      } catch (stateError: unknown) {
        await client.query('ROLLBACK TO SAVEPOINT state_tables');
        logger.error('State table update failed — will be healed by reconciliation', {
          saleId: sale.id,
          saleNumber: sale.saleNumber,
          error: stateError instanceof Error ? stateError.message : String(stateError),
        });
      }
      profiler.mark('cost_layers_summaries');

      // ============================================================
      // ATOMIC ORDER COMPLETION: Mark POS order COMPLETED and link
      // Must run INSIDE this transaction so sale creation and order
      // status update are a single atomic unit (prevents duplicate sale risk)
      // ============================================================
      if (input.fromOrderId) {
        const completed = await client.query<{ id: string }>(
          `UPDATE pos_orders SET status = 'COMPLETED', completed_at = NOW()
           WHERE id = $1 AND status = 'PENDING'
           RETURNING id`,
          [input.fromOrderId],
        );
        if (completed.rowCount === 0) {
          throw new BusinessError(
            `Cannot complete order — status is no longer PENDING`,
            'ERR_ORDER_003',
            { orderId: input.fromOrderId, currentStatus: 'NOT_PENDING' },
          );
        }
        await client.query(
          `UPDATE sales SET from_order_id = $1 WHERE id = $2`,
          [input.fromOrderId, sale.id]
        );
        // Document flow: ORDER → SALE (non-fatal)
        try {
          await documentFlowService.linkDocuments(client, 'ORDER', input.fromOrderId, 'SALE', sale.id, 'CREATES');
        } catch (dfErr) {
          logger.warn('Document flow link ORDER→SALE failed (non-fatal)', { orderId: input.fromOrderId, saleId: sale.id, error: dfErr });
        }
      }

      assertInventoryCouplingUnchanged(
        inventoryCouplingBefore,
        await captureInventoryCoupling(client),
        `sale ${sale.saleNumber}`,
      );
      profiler.mark('order_complete_coupling');

      await client.query('COMMIT');
      profiler.mark('commit');

      // NOTE: Audit logging is now handled in the controller layer
      // where we have access to request context (IP, user agent, session ID)

      // ============================================================
      // BANKING INTEGRATION: Create bank transactions for non-CASH payments
      // CRITICAL: Must succeed for bank reconciliation accuracy
      // Processes each payment individually so partial failures only
      // retry the payments that actually failed (not already-committed ones).
      // ============================================================
      {
        const saleDateStr = sale.saleDate || getBusinessDate();

        // Build the full list of non-cash payments that need bank transactions
        const paymentLinesToProcess = input.paymentLines || [];
        const pendingBankPayments: Array<{ amount: number; paymentMethod: string }> =
          paymentLinesToProcess
            .filter(
              (line) =>
                line.paymentMethod !== 'CASH' &&
                line.paymentMethod !== 'CREDIT' &&
                line.paymentMethod !== 'DEPOSIT'
            )
            .map((line) => ({ amount: line.amount, paymentMethod: line.paymentMethod }));

        // Single-payment fallback (no payment lines, non-cash)
        if (
          paymentLinesToProcess.length === 0 &&
          effectivePaymentMethod !== 'CASH' &&
          effectivePaymentMethod !== 'CREDIT'
        ) {
          pendingBankPayments.push({
            amount: Money.toNumber(actualTotalAmount),
            paymentMethod: effectivePaymentMethod,
          });
        }

        // Process each payment individually — track failures separately
        const failedPayments: Array<{ amount: number; paymentMethod: string }> = [];
        let lastError = '';

        for (const payment of pendingBankPayments) {
          try {
            await BankingService.createFromSale(
              sale.id,
              sale.saleNumber,
              payment.amount,
              payment.paymentMethod,
              saleDateStr,
              pool
            );
            logger.info('Bank transaction created for sale payment', {
              saleId: sale.id,
              saleNumber: sale.saleNumber,
              paymentMethod: payment.paymentMethod,
              amount: payment.amount,
            });
          } catch (error: unknown) {
            lastError = error instanceof Error ? error.message : String(error);
            failedPayments.push(payment);
            logger.error('Bank transaction failed for payment', {
              saleId: sale.id,
              saleNumber: sale.saleNumber,
              paymentMethod: payment.paymentMethod,
              amount: payment.amount,
              error: lastError,
            });
          }
        }

        // Queue ONLY the payments that actually failed
        if (failedPayments.length > 0) {
          const bankingPayload = {
            saleId: sale.id,
            saleNumber: sale.saleNumber,
            saleDate: saleDateStr,
            payments: failedPayments,
            failedAt: new Date().toISOString(),
            originalError: lastError,
            tenantId: tenantId || undefined,
          };

          try {
            await jobQueue.addJob('banking', 'create-bank-transaction', bankingPayload);
            incrementMetric('bankingRetriesTotal');
            logger.info('Banking retry job queued', {
              saleId: sale.id,
              saleNumber: sale.saleNumber,
              failedCount: failedPayments.length,
            });
          } catch (queueErr: unknown) {
            // Queue itself failed (Redis down?) — fall back to error log for manual remediation
            logger.error('CRITICAL: Banking queue also failed — manual remediation required', {
              saleId: sale.id,
              saleNumber: sale.saleNumber,
              queueError: queueErr instanceof Error ? queueErr.message : String(queueErr),
              bankingPayload,
            });
          }

          warnings.push(
            `Banking integration failed for ${failedPayments.length} payment(s) on sale ${sale.saleNumber}. Queued for automatic retry.`
          );
        }
      }

      // ============================================================
      // CASH REGISTER INTEGRATION: Record cash movements for drawer tracking
      // CRITICAL: Must record CASH payments to update expected closing amount
      // This ensures cash register closing has accurate expected total
      // ============================================================
      try {
        if (input.cashRegisterSessionId) {
          // Calculate total cash received (from payment lines or single payment)
          let totalCashReceived = new Decimal(0);

          if (input.paymentLines && input.paymentLines.length > 0) {
            // Split payment - sum up all CASH payments
            for (const line of input.paymentLines) {
              if (line.paymentMethod === 'CASH') {
                totalCashReceived = totalCashReceived.plus(new Decimal(line.amount));
              }
            }
          } else if (effectivePaymentMethod === 'CASH') {
            // Single payment method is CASH
            totalCashReceived = new Decimal(actualAmountPaid);
          }

          // Record cash movement if any cash was received
          if (totalCashReceived.greaterThan(0)) {
            await cashRegisterService.recordSaleMovement(
              input.cashRegisterSessionId,
              sale.id,
              totalCashReceived.toNumber(),
              input.soldBy
            );

            logger.info('Cash register movement recorded for sale', {
              saleId: sale.id,
              saleNumber: sale.saleNumber,
              sessionId: input.cashRegisterSessionId,
              cashAmount: totalCashReceived.toNumber(),
            });
          }
        } else {
          // No session provided - log warning if CASH payment
          const hasCashPayment =
            input.paymentLines?.some((l) => l.paymentMethod === 'CASH') ||
            effectivePaymentMethod === 'CASH';

          if (hasCashPayment) {
            logger.warn('Cash sale without register session - drawer tracking will be incomplete', {
              saleId: sale.id,
              saleNumber: sale.saleNumber,
              paymentMethod: effectivePaymentMethod,
              remediation: 'Ensure frontend passes cashRegisterSessionId for cash sales',
            });
          }
        }
      } catch (error: unknown) {
        // Non-blocking - sale is already committed
        logger.error('Cash register integration failed - drawer tracking incomplete', {
          saleId: sale.id,
          saleNumber: sale.saleNumber,
          sessionId: input.cashRegisterSessionId,
          error: error instanceof Error ? error.message : String(error),
          remediation: 'Manually record cash movement in cash register',
        });
        warnings.push(
          `Cash register integration failed: ${error instanceof Error ? error.message : String(error)}. Drawer tracking incomplete.`
        );
      }

      const result = {
        sale,
        items,
        paymentLines: input.paymentLines || [],
        warnings: warnings.length > 0 ? warnings : undefined,
        checkoutProfile: profiler.snapshot(),
      };

      // GL POSTING: Done above via glEntryService.recordSaleToGL()
      // (Database GL triggers disabled — application-layer posting is single source of truth)

      // ============================================================
      // DELIVERY NOTE: Created manually via Delivery > "From Sale" UI.
      // Previously auto-created here via setImmediate, but that conflicted
      // with the manual Tally-style workflow (createDeliveryFromSale).
      // Delivery should be an intentional user action, not automatic.
      // See: deliveryService.createDeliveryFromSale()
      // ============================================================

      incrementMetric('salesCreatedTotal');
      profiler.mark('post_commit');
      // Refresh snapshot so post_commit is included when profile enabled
      if (result.checkoutProfile) {
        result.checkoutProfile = profiler.snapshot()!;
      }

      const saleNotifyPayload = buildProductLineNotificationPayload({
        action: 'Sold',
        items: input.items,
        documentRef: sale.saleNumber,
        amount: Number(sale.totalAmount || 0),
      });
      publishNotificationEvent({
        pool,
        tenantId,
        typeKey: 'SALE_COMPLETED',
        entityType: 'sale',
        entityId: sale.id,
        idempotencyKey: `SALE_COMPLETED:sale:${sale.id}`,
        payload: saleNotifyPayload,
        actorUserId: input.soldBy,
        storeLocationId: sellingStoreId,
      });
      const publishedDiscount = Number(sale.discountAmount || 0);
      const publishedSubtotal = Number(sale.subtotal || sale.totalAmount || 0);
      const isExchangeReplacement = Boolean(input.exchangeRefundId);
      if (!isExchangeReplacement && publishedDiscount > 0.009) {
        publishNotificationEvent({
          pool,
          tenantId,
          typeKey: 'DISCOUNT_APPLIED',
          entityType: 'sale',
          entityId: sale.id,
          idempotencyKey: `DISCOUNT_APPLIED:sale:${sale.id}`,
          payload: { ...saleNotifyPayload, summary: `A discount was applied on sale ${sale.saleNumber}` },
          actorUserId: input.soldBy,
          storeLocationId: sellingStoreId,
        });
        if (publishedSubtotal > 0 && publishedDiscount / publishedSubtotal >= DISCOUNT_THRESHOLD_RATIO) {
          publishNotificationEvent({
            pool,
            tenantId,
            typeKey: 'DISCOUNT_ABOVE_THRESHOLD',
            entityType: 'sale',
            entityId: sale.id,
            idempotencyKey: `DISCOUNT_ABOVE_THRESHOLD:sale:${sale.id}`,
            payload: { ...saleNotifyPayload, summary: `A large discount was applied on sale ${sale.saleNumber}` },
            actorUserId: input.soldBy,
            storeLocationId: sellingStoreId,
          });
        }
      }
      if (priceOverrideCount > 0) {
        publishNotificationEvent({
          pool,
          tenantId,
          typeKey: 'SALE_PRICE_OVERRIDE',
          entityType: 'sale',
          entityId: sale.id,
          idempotencyKey: `SALE_PRICE_OVERRIDE:sale:${sale.id}`,
          payload: { ...saleNotifyPayload, summary: `A price override was used on sale ${sale.saleNumber}` },
          actorUserId: input.soldBy,
          storeLocationId: sellingStoreId,
        });
      }

      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },

  /**
   * Get sale by ID
   */
  async getSaleById(
    pool: Pool,
    id: string
  ): Promise<{
    sale: SaleRecord;
    items: SaleItemRecord[];
    paymentLines?: Record<string, unknown>[];
  }> {
    const result = await salesRepository.getSaleById(pool, id);

    if (!result) {
      throw new NotFoundError(`Sale ${id}`);
    }

    return result;
  },

  /**
   * List sales with pagination
   */
  async listSales(
    pool: Pool,
    page: number = 1,
    limit: number = 50,
    filters?: {
      status?: string;
      customerId?: string;
      cashierId?: string;
      paymentMethod?: string;
      startDate?: string;
      endDate?: string;
      search?: string;
      sortBy?: string;
      sortOrder?: 'asc' | 'desc';
      outstandingOnly?: boolean;
      balanceGt?: number;
    }
  ): Promise<{ sales: SaleRecord[]; total: number }> {
    return salesRepository.listSales(pool, page, limit, filters);
  },

  /**
   * Get sales summary (totals, count, by payment method)
   */
  async getSalesSummary(
    pool: Pool,
    filters?: {
      startDate?: string;
      endDate?: string;
      groupBy?: string;
      cashierId?: string;
    }
  ): Promise<Record<string, unknown>> {
    // SAP GLT0-equivalent: read from pre-aggregated rollup table
    // Falls back to raw table scan if cashierId filter is present
    return salesRepository.getSalesSummaryFromRollup(pool, filters);
  },

  /**
   * Reconcile daily summary rollup vs raw sales table.
   */
  async reconcileDailySummary(
    pool: Pool,
    startDate?: string,
    endDate?: string
  ): Promise<{ drifts: Record<string, unknown>[]; isClean: boolean }> {
    return salesRepository.reconcileDailySummary(pool, startDate, endDate);
  },

  /**
   * Full rebuild of the daily summary rollup from raw sales data.
   */
  async rebuildDailySummary(pool: Pool): Promise<number> {
    return salesRepository.rebuildDailySummary(pool);
  },

  /**
   * Get product sales summary report
   */
  async getProductSalesSummary(
    pool: Pool,
    filters?: {
      startDate?: string;
      endDate?: string;
      productId?: string;
      customerId?: string;
      cashierId?: string;
    }
  ): Promise<Record<string, unknown>[]> {
    return salesRepository.getProductSalesSummary(pool, filters);
  },

  /**
   * Get top selling products
   */
  async getTopSellingProducts(
    pool: Pool,
    limit: number = 10,
    filters?: {
      startDate?: string;
      endDate?: string;
      cashierId?: string;
    }
  ): Promise<Record<string, unknown>[]> {
    return salesRepository.getTopSellingProducts(pool, limit, filters);
  },

  /**
   * Get sales summary by date
   */
  async getSalesSummaryByDate(
    pool: Pool,
    groupBy: 'day' | 'week' | 'month' = 'day',
    filters?: {
      startDate?: string;
      endDate?: string;
      cashierId?: string;
    }
  ): Promise<Record<string, unknown>[]> {
    return salesRepository.getSalesSummaryByDate(pool, groupBy, filters);
  },

  /**
   * Get sales details report - items sold with quantity, UOM, and date
   */
  async getSalesDetailsReport(
    pool: Pool,
    filters?: {
      startDate?: Date;
      endDate?: Date;
      productId?: string;
      customerId?: string;
    }
  ): Promise<Record<string, unknown>[]> {
    return salesRepository.getSalesDetailsReport(pool, filters);
  },

  /**
   * Aggregated sales-by-cashier (Sales page performance tab).
   */
  async getSalesByCashier(
    pool: Pool,
    filters?: {
      startDate?: string;
      endDate?: string;
      userId?: string;
      cashierId?: string;
      orderedById?: string;
      productId?: string;
    }
  ): Promise<Record<string, unknown>[]> {
    return salesRepository.getSalesByCashierSummary(pool, filters ?? {});
  },

  /**
   * Line-level sales-by-cashier (Reports detail/export).
   */
  async getSalesByCashierDetail(
    pool: Pool,
    filters?: {
      startDate?: string;
      endDate?: string;
      userId?: string;
      cashierId?: string;
      orderedById?: string;
      productId?: string;
    }
  ): Promise<Record<string, unknown>[]> {
    return salesRepository.getSalesByCashierDetail(pool, filters ?? {});
  },

  /**
   * Void a sale (requires manager approval for high-value sales)
   *
   * Business Rules:
   * - Only COMPLETED sales can be voided
   * - Void reason is MANDATORY
   * - Manager approval required for sales > threshold
   * - Inventory is restored to batches (FEFO reversal)
   * - Cost layers are restored (FIFO reversal)
   * - Customer balance is adjusted if credit sale
   * - Audit trail is created
   *
   * @param pool - Database connection pool
   * @param saleId - UUID of sale to void
   * @param voidedById - UUID of user requesting void
   * @param voidReason - Required explanation for void
   * @param approvedById - Optional UUID of manager approving void
   * @param amountThreshold - Amount requiring manager approval (default 1000000 UGX)
   */
  async voidSale(
    pool: Pool,
    saleId: string,
    voidedById: string,
    voidReason: string,
    approvedById?: string,
    amountThreshold: number = 1000000,
    forceAdminVoid: boolean = false
  ): Promise<{
    success: boolean;
    sale: Record<string, unknown>;
    itemsRestored: number;
    totalAmount: number;
  }> {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Maintenance mode guard (replaces trg_maintenance_check_sales)
      await checkMaintenanceMode(client);

      // Suppress the inventory_batches trigger that auto-creates SM- stock_movements
      // Void code already creates proper MOV- movements for inventory restoration
      await client.query("SET LOCAL app.skip_stock_movement_trigger = 'true'");

      // Get sale details
      const saleResult = await client.query(`SELECT * FROM sales WHERE id = $1`, [saleId]);

      if (saleResult.rows.length === 0) {
        throw new NotFoundError('Sale');
      }

      const sale = saleResult.rows[0];

      // ERP discipline: A completed POS sale is NEVER voided — UNLESS an ADMIN explicitly
      // requests a force void (e.g., to correct a pricing error). forceAdminVoid must be
      // accompanied by an ADMIN-role voider; the reversal is full (GL + stock + invoice).
      if (sale.status === 'COMPLETED' || sale.status === 'PARTIALLY_RETURNED') {
        if (!forceAdminVoid) {
          throw new BusinessError(
            `Cannot void a completed POS sale (status: ${sale.status}). ` +
            `Stock, invoice, and payment are already posted. ` +
            `Use Return to reverse this sale — this restores inventory, posts a Credit Note, and issues a refund.`,
            'ERR_SALE_COMPLETED_NO_VOID',
            { saleId, currentStatus: sale.status }
          );
        }
        // forceAdminVoid path: requires admin.delete (destructive reversal of posted sale)
        await assertUserPermission(pool, voidedById, 'admin.delete', {
          errorCode: 'ERR_SALE_FORCE_VOID_ADMIN_ONLY',
          message: 'Only users with admin.delete permission can force-void a completed sale. Contact your system administrator.',
        });
        logger.warn('Force-void of completed sale authorised', {
          saleId,
          saleNumber: sale.sale_number,
          voidedById,
          voidReason,
        });
      }
      // Block void for already-reversed or already-voided statuses
      if (['VOID', 'REFUNDED', 'VOIDED_BY_RETURN'].includes(sale.status)) {
        throw new BusinessError(
          `Cannot void sale with status ${sale.status}.`,
          'ERR_SALE_008',
          { saleId, currentStatus: sale.status }
        );
      }

      // Fiscal period guard — cannot void sales in closed periods
      const saleDate = String(sale.sale_date).slice(0, 10);
      await checkAccountingPeriodOpen(client, saleDate);

      // Validate void reason
      if (!voidReason || voidReason.trim().length === 0) {
        throw new BusinessError('Void reason is required', 'ERR_SALE_009', { saleId });
      }

      // Check if manager approval is required
      const totalAmount = Money.toNumber(Money.parseDb(sale.total_amount ?? 0));
      const requiresApproval = totalAmount > amountThreshold;

      // Users with sales.approve can self-approve high-value voids
      const voiderCanApprove = await userHasPermission(pool, voidedById, 'sales.approve');

      if (requiresApproval && !approvedById && !voiderCanApprove) {
        throw new BusinessError(
          `Manager approval required for sales over ${amountThreshold}. Total amount: ${totalAmount}`,
          'ERR_SALE_010',
          { saleId, totalAmount, amountThreshold }
        );
      }

      // If approval provided by someone else, verify approver has sales.approve
      if (approvedById && approvedById !== voidedById) {
        await assertUserPermission(pool, approvedById, 'sales.approve', {
          errorCode: 'ERR_SALE_011',
          message: 'Approver must have sales.approve permission',
        });
      }

      // Get sale items for inventory restoration
      const saleItems = await salesRepository.getSaleItemsForVoid(client, saleId);

      logger.info('Voiding sale - restoring inventory', {
        saleId,
        saleNumber: sale.sale_number,
        itemCount: saleItems.length,
        totalAmount,
      });

      // Restore inventory for each item
      for (const item of saleItems) {
        // SAP MUoM: inventory_batches, cost_layers, and stock_movements all store BASE units.
        // sale_items.quantity is the DISPLAY (selling-UoM) quantity; base_qty is the physical
        // base-unit quantity. Use base_qty when available, fall back to quantity × conversion_factor.
        const displayQty = Money.toNumber(Money.parseDb(item.quantity ?? 0));
        const cf = item.conversionFactor ? new Decimal(item.conversionFactor).toNumber() : 1;
        const quantity = item.baseQty
          ? Money.toNumber(Money.parseDb(item.baseQty))
          : Money.toNumber(new Decimal(displayQty).times(cf));
        const productId = String(item.productId);
        const batchId = item.batchId;

        const multistoreRestored = await warehouseSaleVoidRestoreService.restoreVoidedSaleLine(
          client,
          {
            productId,
            quantity,
            unitCost: Money.toNumber(Money.parseDb(item.unitCost ?? 0)),
            storeLocationId: item.storeLocationId,
            productLotId: item.productLotId,
            batchId,
            saleId,
            saleNumber: sale.sale_number,
            voidReason,
            voidedById,
          },
        );

        // Get product costing method
        const productResult = await client.query(
          'SELECT costing_method FROM product_valuation WHERE product_id = $1',
          [productId]
        );
        const costingMethod = productResult.rows[0]?.costing_method || 'FIFO';

        // 1. FINANCIAL: Restore cost layers (reverse FIFO deduction)
        if (costingMethod === 'FIFO') {
          try {
            // Add back to cost layers
            const unitCost = Money.toNumber(Money.parseDb(item.unitCost ?? 0));
            await client.query(
              `INSERT INTO cost_layers (product_id, quantity, remaining_quantity, unit_cost, batch_number, created_at)
               VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)`,
              [productId, quantity, quantity, unitCost, `VOID-${sale.sale_number}`]
            );

            logger.info('Cost layer restored for voided sale', {
              productId,
              quantity,
              unitCost,
              saleNumber: sale.sale_number,
            });
          } catch (error: unknown) {
            logger.error('Failed to restore cost layer', {
              productId,
              error: error instanceof Error ? error.message : String(error),
            });
            // Don't fail transaction - inventory restoration is more critical
          }
        }

        // 2. PHYSICAL: Restore inventory batch (reverse FEFO deduction)
        if (multistoreRestored) {
          logger.info('Multistore void — stock restored to original store/lot', {
            productId,
            quantity,
            storeLocationId: item.storeLocationId,
            productLotId: item.productLotId,
            saleNumber: sale.sale_number,
          });
        } else {
          const unitCost = Money.toNumber(Money.parseDb(item.unitCost ?? 0));
          const restoredLot = await lotService.returnLot(client, {
            productId,
            batchId,
            quantity,
            costPrice: unitCost,
            lotNumber: `VOID-RESTORE-${sale.sale_number}`,
            referenceType: 'SALE_VOID',
            referenceId: sale.id,
            notes: `Restored from voided sale ${sale.sale_number}`,
            userId: voidedById,
          });

          logger.info('Inventory batch restored for voided sale', {
            batchId: restoredLot.id,
            quantity,
            productId,
          });
        }

        if (!multistoreRestored) {
        // App-layer sync: update BOTH product_inventory and products.quantity_on_hand
        await syncProductQuantity(client, productId);

        // 3. Record stock movement (VOID reversal) — SEQUENCE, no advisory lock
        const movementNumber = await allocateNextMovementNumber(client);

        await client.query(
          `INSERT INTO stock_movements (
            movement_number, product_id, batch_id, movement_type, quantity, unit_cost,
            reference_type, reference_id, notes, created_by_id
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            movementNumber,
            productId,
            batchId || null,
            'ADJUSTMENT_IN',
            quantity,
            Money.toNumber(Money.parseDb(item.unitCost ?? 0)),
            'VOID',
            saleId,
            `Void sale ${sale.sale_number}: ${voidReason}`,
            voidedById,
          ]
        );
        }
      }

      // Cancel linked invoice if exists (SINGLE SOURCE OF TRUTH)
      // The invoice cancellation will trigger customer balance recalculation
      const linkedInvoiceResult = await client.query(
        `SELECT id FROM invoices WHERE sale_id = $1`,
        [saleId]
      );

      if (linkedInvoiceResult.rows.length > 0) {
        const invoiceId = linkedInvoiceResult.rows[0].id;

        // Set invoice to Cancelled with zero outstanding (customer no longer owes)
        await client.query(
          `UPDATE invoices 
           SET status = 'CANCELLED', 
               amount_due = 0,
               updated_at = NOW()
           WHERE id = $1`,
          [invoiceId]
        );

        logger.info('Invoice cancelled for voided sale', {
          saleId,
          invoiceId,
        });

        // NOTE: The trg_sync_customer_balance_on_invoice trigger will automatically
        // recalculate customer.balance from remaining unpaid invoices
      } else if (sale.customer_id) {
        // No invoice exists - recalculate customer balance from invoices (SSOT)
        // Even legacy sales: the balance must always derive from invoices
        const paymentLinesResult = await client.query(
          `SELECT SUM(amount) as credit_amount 
           FROM payment_lines 
           WHERE sale_id = $1 AND payment_method = 'CREDIT'`,
          [saleId]
        );

        const creditAmount = Money.toNumber(Money.parseDb(paymentLinesResult.rows[0]?.credit_amount ?? 0));

        if (creditAmount > 0) {
          const { syncCustomerBalanceFromInvoices } = await import('../../utils/customerBalanceSync.js');
          await syncCustomerBalanceFromInvoices(client, sale.customer_id, 'SALE_VOID');

          logger.info('Customer balance recalculated for voided credit sale (no invoice)', {
            customerId: sale.customer_id,
            saleId,
            creditAmount,
          });
        }
      }

      // Mark sale as VOID
      const voidedSale = await salesRepository.voidSale(
        client,
        saleId,
        voidedById,
        voidReason,
        approvedById
      );

      // GL POSTING: Reverse the original sale GL entry
      // MUST succeed — if GL fails, the entire void rolls back to prevent discrepancies
      await glEntryService.recordSaleVoidToGL(
        {
          saleId,
          saleNumber: sale.sale_number,
          voidDate: getBusinessDate(),
          voidReason: voidReason || 'No reason provided',
        },
        pool,
        client
      );

      // ============================================================
      // SAP GLT0-EQUIVALENT: Atomically decrement daily summary rollup
      // Must happen INSIDE the transaction so totals stay in sync
      // SAVEPOINT: prevents PG aborted-transaction if this fails
      // ============================================================
      try {
        await client.query('SAVEPOINT void_daily_summary');
        const voidSaleDate = String(sale.sale_date).slice(0, 10);
        const isCredit = sale.payment_method === 'CREDIT';
        const amountPaid = Money.toNumber(Money.parseDb(sale.amount_paid ?? 0));
        const saleTotal = Money.toNumber(Money.parseDb(sale.total_amount ?? 0));
        const isPartial = isCredit && amountPaid > 0 && amountPaid < saleTotal;
        await salesRepository.decrementDailySummary(
          client,
          voidSaleDate,
          sale.payment_method,
          sale.total_amount || 0,
          sale.total_cost || 0,
          sale.discount_amount || 0,
          isCredit,
          isPartial
        );
      } catch (summaryError: unknown) {
        await client.query('ROLLBACK TO SAVEPOINT void_daily_summary');
        logger.error('Daily summary rollup decrement failed — will be healed by reconciliation', {
          saleId,
          saleNumber: sale.sale_number,
          error: summaryError instanceof Error ? summaryError.message : String(summaryError),
        });
      }

      // ============================================================
      // STATE TABLES: Reverse product daily summary + Inventory
      // Batch UPSERTs: 1 query per table instead of N per item (100M-scale)
      // SAVEPOINT: prevents PG aborted-transaction if this fails
      // ============================================================
      try {
        await client.query('SAVEPOINT void_state_tables');
        const voidDateStr = String(sale.sale_date).slice(0, 10);

        // Batch-fetch categories
        const voidProductIds = saleItems.map((it: { productId: string }) => it.productId).filter(Boolean);
        const voidCategoryMap = new Map<string, string>();
        if (voidProductIds.length > 0) {
          const catRes = await client.query(
            `SELECT id, COALESCE(NULLIF(TRIM(category), ''), 'Uncategorized') as category
             FROM products WHERE id = ANY($1)`,
            [[...new Set(voidProductIds)]]
          );
          for (const row of catRes.rows) {
            voidCategoryMap.set(row.id, row.category);
          }
        }

        // Pre-aggregate by productId
        const voidPdsMap = new Map<string, { category: string; unitsSold: Decimal; revenue: Decimal; costOfGoods: Decimal; discountGiven: Decimal }>();
        const voidInvMap = new Map<string, Decimal>();

        for (const item of saleItems) {
          if (!item.productId) continue;
          const qty = Money.parseDb(item.quantity);
          const unitCost = Money.parseDb(item.unitCost);
          const totalPrice = Money.parseDb(item.totalPrice);
          const costOfGoods = unitCost.times(qty);

          const itemDiscount = Money.parseDb(item.discountAmount ?? 0);
          const existing = voidPdsMap.get(item.productId);
          if (existing) {
            existing.unitsSold = existing.unitsSold.plus(qty);
            existing.revenue = existing.revenue.plus(totalPrice);
            existing.costOfGoods = existing.costOfGoods.plus(costOfGoods);
            existing.discountGiven = existing.discountGiven.plus(itemDiscount);
          } else {
            voidPdsMap.set(item.productId, {
              category: voidCategoryMap.get(item.productId) || 'Uncategorized',
              unitsSold: qty,
              revenue: totalPrice,
              costOfGoods,
              discountGiven: itemDiscount,
            });
          }

          const invExisting = voidInvMap.get(item.productId);
          voidInvMap.set(item.productId, (invExisting || new Decimal(0)).plus(qty));
        }

        // 1 query: batch decrement product daily summary
        const voidPdsItems = Array.from(voidPdsMap.entries()).map(([productId, agg]) => ({
          productId,
          category: agg.category,
          unitsSold: agg.unitsSold.toNumber(),
          revenue: agg.revenue.toNumber(),
          costOfGoods: agg.costOfGoods.toNumber(),
          discountGiven: agg.discountGiven.toNumber(),
        }));
        await stateTablesRepo.batchDecrementProductDailySummary(client, voidDateStr, voidPdsItems);
      } catch (stateError: unknown) {
        await client.query('ROLLBACK TO SAVEPOINT void_state_tables');
        logger.error('State table void reversal failed — will be healed by reconciliation', {
          saleId,
          saleNumber: sale.sale_number,
          error: stateError instanceof Error ? stateError.message : String(stateError),
        });
      }

      await client.query('COMMIT');

      logger.info('Sale voided successfully', {
        saleId,
        saleNumber: sale.sale_number,
        voidedById,
        approvedById,
        totalAmount,
      });

      const voidNotifyPayload = buildProductLineNotificationPayload({
        action: 'Voided',
        items: saleItems,
        documentRef: sale.sale_number,
        amount: Number(sale.total_amount || 0),
      });
      publishNotificationEvent({
        pool,
        typeKey: 'SALE_VOIDED',
        entityType: 'sale',
        entityId: saleId,
        idempotencyKey: `SALE_VOIDED:sale:${saleId}`,
        payload: voidNotifyPayload,
        actorUserId: voidedById,
        storeLocationId: sale.store_location_id || null,
      });

      return {
        success: true,
        sale: voidedSale,
        itemsRestored: saleItems.length,
        totalAmount,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Failed to void sale', {
        saleId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    } finally {
      client.release();
    }
  },

  // ============================================================
  // REFUND SALE (PARTIAL OR FULL)
  // ============================================================

  /**
   * Create a refund against a COMPLETED sale.
   *
   * Supports partial refunds (specific items/quantities) and full refunds.
   * Each refund creates an immutable sale_refunds document with line items.
   *
   * Business Rules:
   * - Only COMPLETED sales can be refunded (ERR_REFUND_001)
   * - Each item's refund qty must not exceed (quantity - refunded_qty) (ERR_REFUND_002)
   * - Inventory is restored to the original batch (or newest active)
   * - Cost layers are restored at original unit_cost (FIFO-accurate)
   * - GL entries are created: DR Revenue / CR Cash, DR Inventory / CR COGS
   * - When ALL items on the sale are fully refunded, sale status → REFUNDED
   * - Refund documents are immutable once created
   *
   * @param pool - Database connection pool
   * @param saleId - UUID of the sale to refund
   * @param refundedById - UUID of the user creating the refund
   * @param input - Refund items, reason, optional approval
   * @returns Refund document with items and restored inventory count
   */
  async refundSale(
    pool: Pool,
    saleId: string,
    refundedById: string,
    input: RefundSaleInput
  ): Promise<{
    refund: RefundRecord;
    refundItems: RefundItemRecord[];
    itemsRestored: number;
    isFullRefund: boolean;
  }> {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Maintenance mode guard
      await checkMaintenanceMode(client);

      // Suppress the inventory_batches trigger (refund code creates proper movements)
      await client.query("SET LOCAL app.skip_stock_movement_trigger = 'true'");

      // ── 1. Load & validate the sale ──────────────────────────────

      const saleResult = await client.query(
        `SELECT * FROM sales WHERE id = $1`,
        [saleId]
      );

      if (saleResult.rows.length === 0) {
        throw new NotFoundError('Sale');
      }

      const sale = saleResult.rows[0];

      // Allow return (refund) for COMPLETED and PARTIALLY_RETURNED sales
      // PARTIALLY_RETURNED = some items already returned; further returns allowed
      if (sale.status !== 'COMPLETED' && sale.status !== 'PARTIALLY_RETURNED') {
        throw new BusinessError(
          `Cannot return sale with status ${sale.status}. Only COMPLETED or PARTIALLY_RETURNED sales can be returned.`,
          'ERR_REFUND_001',
          { saleId, currentStatus: sale.status, requiredStatus: 'COMPLETED or PARTIALLY_RETURNED' }
        );
      }

      // Fiscal period guard — cannot refund sales in closed periods
      const saleDate = String(sale.sale_date).slice(0, 10);
      await checkAccountingPeriodOpen(client, saleDate);

      // Aged sale return: > 30 days → ADMIN only (server authoritative)
      {
        const { getBusinessDate } = await import('../../utils/dateRange.js');
        const {
          canProcessAgedSaleReturn,
          agedSaleReturnDeniedMessage,
          ERR_REFUND_AGED_ADMIN_ONLY,
          AGED_SALE_RETURN_DAYS,
        } = await import('@shared/authorization/agedSaleReturnPolicy.js');
        const roleRes = await client.query<{ role: string | null }>(
          `SELECT role FROM users WHERE id = $1`,
          [refundedById],
        );
        const actorRole = roleRes.rows[0]?.role ?? null;
        const aged = canProcessAgedSaleReturn({
          saleDate,
          asOfDate: getBusinessDate(),
          actorRole,
        });
        if (!aged.allowed) {
          throw new BusinessError(
            agedSaleReturnDeniedMessage(aged.ageDays, AGED_SALE_RETURN_DAYS),
            ERR_REFUND_AGED_ADMIN_ONLY,
            {
              saleId,
              saleDate,
              ageDays: aged.ageDays,
              limitDays: AGED_SALE_RETURN_DAYS,
              actorRole,
              requiresAdmin: true,
            },
          );
        }
      }

      // Validate reason
      if (!input.reason || input.reason.trim().length === 0) {
        throw new BusinessError('Refund reason is required', 'ERR_REFUND_003', { saleId });
      }

      // Validate at least one item
      if (!input.items || input.items.length === 0) {
        throw new BusinessError(
          'At least one item must be specified for refund',
          'ERR_REFUND_004',
          { saleId }
        );
      }

      const refundType = input.refundType === 'EXCHANGE' ? 'EXCHANGE' : 'REFUND';

      // Full-line exchange is allowed (single-item "wrong product" swaps are the common case).
      // Pure cash-out of a whole sale still belongs on the Return path, but EXCHANGE may reverse
      // every remaining line when the cashier posts store credit / a replacement.

      // If approval provided, verify approver has sales.approve
      if (input.approvedById) {
        await assertUserPermission(pool, input.approvedById, 'sales.approve', {
          errorCode: 'ERR_REFUND_005',
          message: 'Approver must have sales.approve permission',
        });
      }

      // ── 2. Load sale items & validate refund quantities ──────────

      const saleItems = await salesRepository.getSaleItemsForRefund(client, saleId);

      // Build lookup map by sale_item_id
      const saleItemMap = new Map(saleItems.map((si) => [si.id, si]));

      let refundTotalAmount = new Decimal(0);
      let refundTotalCost = new Decimal(0);

      // Validated list of items to process
      const validatedItems: Array<{
        saleItem: typeof saleItems[0];
        refundQty: Decimal;
        lineTotal: Decimal;
        costTotal: Decimal;
      }> = [];

      for (const refundItem of input.items) {
        const saleItem = saleItemMap.get(refundItem.saleItemId);
        if (!saleItem) {
          throw new BusinessError(
            `Sale item ${refundItem.saleItemId} not found on sale ${sale.sale_number}`,
            'ERR_REFUND_006',
            { saleItemId: refundItem.saleItemId, saleId }
          );
        }

        const remainingQty = new Decimal(saleItem.remainingQty);
        const refundQty = new Decimal(refundItem.quantity);

        if (!refundQty.isFinite() || refundQty.lessThanOrEqualTo(0)) {
          throw new BusinessError(
            'Refund quantity must be a positive finite number',
            'ERR_REFUND_007',
            { saleItemId: refundItem.saleItemId, quantity: refundItem.quantity }
          );
        }

        if (refundQty.greaterThan(remainingQty)) {
          throw new BusinessError(
            `Refund quantity ${refundQty} exceeds remaining refundable quantity ${remainingQty} for item "${saleItem.productName}"`,
            'ERR_REFUND_002',
            {
              saleItemId: refundItem.saleItemId,
              productName: saleItem.productName,
              requested: refundQty.toNumber(),
              remaining: remainingQty.toNumber(),
              originalQty: new Decimal(saleItem.quantity).toNumber(),
              alreadyRefunded: new Decimal(saleItem.refundedQty).toNumber(),
            }
          );
        }

        // Calculate refund amounts using ORIGINAL unit_price and unit_cost
        const unitPrice = new Decimal(saleItem.unitPrice);
        const unitCost = new Decimal(saleItem.unitCost);
        const lineTotal = Money.round(refundQty.times(unitPrice), 2);
        const costTotal = Money.round(refundQty.times(unitCost), 2);

        refundTotalAmount = refundTotalAmount.plus(lineTotal);
        refundTotalCost = refundTotalCost.plus(costTotal);

        validatedItems.push({ saleItem, refundQty, lineTotal, costTotal });
      }

      // ── 3. Create refund document ───────────────────────────────

      const refundData: CreateRefundData = {
        saleId,
        refundDate: input.refundDate || getBusinessDate(),
        reason: input.reason.trim(),
        totalAmount: refundTotalAmount.toFixed(2),
        totalCost: refundTotalCost.toFixed(2),
        refundType,
        createdById: refundedById,
        approvedById: input.approvedById,
      };

      const refund = await salesRepository.createRefund(client, refundData);

      logger.info('Refund document created', {
        refundId: refund.id,
        refundNumber: refund.refundNumber,
        saleId,
        saleNumber: sale.sale_number,
        totalAmount: refundTotalAmount.toFixed(2),
        totalCost: refundTotalCost.toFixed(2),
        itemCount: validatedItems.length,
      });

      // ── 4. Create refund line items & update refunded_qty ───────

      const refundItemsData: CreateRefundItemData[] = validatedItems.map(
        ({ saleItem, refundQty, lineTotal, costTotal }) => ({
          refundId: refund.id,
          saleItemId: saleItem.id,
          productId: saleItem.productId,
          batchId: saleItem.batchId,
          quantity: refundQty.toFixed(4),
          unitPrice: saleItem.unitPrice,
          unitCost: saleItem.unitCost,
          lineTotal: lineTotal.toFixed(2),
          costTotal: costTotal.toFixed(2),
        })
      );

      const refundItems = await salesRepository.addRefundItems(client, refundItemsData);

      // Increment refunded_qty on each sale_item
      for (const { saleItem, refundQty } of validatedItems) {
        await salesRepository.incrementRefundedQty(client, saleItem.id, Money.toNumber(refundQty));
      }

      // ── 5. Restore inventory for each refunded item ─────────────

      for (const { saleItem, refundQty } of validatedItems) {
        const productId = saleItem.productId;
        const batchId = saleItem.batchId;
        // SAP MUoM: inventory_batches, cost_layers, and stock_movements all store BASE units.
        // refundQty is expressed in the original selling UoM (display units).
        // Multiply by conversionFactor to get the physical base-unit quantity to restore.
        const storedConvFactor = saleItem.conversionFactor
          ? Money.toNumber(Money.parseDb(saleItem.conversionFactor))
          : 1;
        const quantity = Money.toNumber(Money.multiply(refundQty, storedConvFactor));
        if (!Number.isFinite(quantity) || quantity <= 0) {
          throw new BusinessError(
            'Invalid refund quantity after unit conversion',
            'ERR_REFUND_007',
            { saleItemId: saleItem.id, refundQty: refundQty.toNumber(), conversionFactor: storedConvFactor }
          );
        }
        const unitCost = Money.toNumber(Money.parseDb(saleItem.unitCost));

        // Skip custom items (no inventory)
        if (!productId || saleItem.itemType === 'custom') {
          logger.info('Skipping inventory restoration for custom/null product', {
            saleItemId: saleItem.id,
          });
          continue;
        }

        // 5a. Restore cost layer (FIFO-accurate at original unit_cost)
        try {
          await client.query(
            `INSERT INTO cost_layers (product_id, quantity, remaining_quantity, unit_cost, batch_number, created_at)
             VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)`,
            [productId, quantity, quantity, unitCost, `REFUND-${refund.refundNumber}`]
          );
        } catch (error: unknown) {
          logger.error('Failed to restore cost layer for refund', {
            productId,
            error: error instanceof Error ? error.message : String(error),
          });
        }

        const multistoreRestore = await warehouseReturnInventoryService.restoreCustomerReturn(client, {
          productId,
          quantity,
          unitCost,
          batchId,
          productLotId: saleItem.productLotId ?? null,
          referenceType: 'SALE_REFUND',
          referenceId: refund.id,
          notes: `Refund ${refund.refundNumber} for sale ${sale.sale_number}: ${input.reason}`,
        });

        if (multistoreRestore) {
          const refundLine = refundItems.find((ri) => ri.saleItemId === saleItem.id);
          if (refundLine) {
            await salesRepository.updateRefundItemWarehouseTrace(client, refundLine.id, {
              storeLocationId: multistoreRestore.storeLocationId,
              productLotId: multistoreRestore.productLotId,
            });
          }
          continue;
        }

        // 5b. Restore inventory batch (legacy single-store via LotService)
        const restoredLot = await lotService.returnLot(client, {
          productId,
          batchId,
          quantity,
          costPrice: unitCost,
          lotNumber: `REFUND-RESTORE-${refund.refundNumber}`,
          referenceType: 'SALE_REFUND',
          referenceId: refund.id,
          notes: `Restored from refund ${refund.refundNumber} on sale ${sale.sale_number}`,
          userId: refundedById,
        });
        const restoredBatchId = restoredLot.id;

        // 5c. Sync product_inventory and products.quantity_on_hand
        await syncProductQuantity(client, productId);

        // 5d. Record stock movement (RETURN type) — SEQUENCE, no advisory lock
        const movementNumber = await allocateNextMovementNumber(client);

        await client.query(
          `INSERT INTO stock_movements (
            movement_number, product_id, batch_id, movement_type, quantity, unit_cost,
            reference_type, reference_id, notes, created_by_id
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            movementNumber,
            productId,
            restoredBatchId,
            'RETURN',
            quantity,
            unitCost,
            'REFUND',
            refund.id,
            `Refund ${refund.refundNumber} for sale ${sale.sale_number}: ${input.reason}`,
            refundedById,
          ]
        );
      }

      // ── 6. Handle customer balance (credit sale refund) ─────────

      let arCreditAmount: number | undefined;
      if (sale.customer_id && sale.payment_method === 'CREDIT') {
        const dueResult = await client.query<{ amount_due: string }>(
          `SELECT amount_due::text AS amount_due
           FROM invoices
           WHERE sale_id = $1
             AND status NOT IN ('CANCELLED', 'VOIDED', 'DRAFT')
           ORDER BY created_at DESC
           LIMIT 1`,
          [saleId],
        );
        const currentDue = parseFloat(dueResult.rows[0]?.amount_due ?? '0');
        arCreditAmount = Math.min(refundTotalAmount.toNumber(), Math.max(currentDue, 0));

        // Step 6a: Reduce the invoice's amount_due by the refund amount FIRST.
        // syncCustomerBalanceFromInvoices (Wave 3 open-item SSOT) reads open invoice
        // due minus unallocated AR receipts — invoice amount_due must be updated here
        // or customer.balance will not reflect the refund.
        //
        // NOTE: We reduce amount_due directly (not via amount_paid) because a refund
        // is a forgiveness of debt, not a cash receipt. Incrementing amount_paid would
        // violate the CHECK constraint (amount_paid <= total_amount) when the refund
        // exceeds the unpaid portion.
        await client.query(
          `UPDATE invoices
           SET amount_due = GREATEST(amount_due - $2, 0),
               status = CASE
                 WHEN GREATEST(amount_due - $2, 0) = 0 THEN 'PAID'
                 WHEN $2 < amount_due THEN 'PARTIALLY_PAID'
                 ELSE status
               END,
               updated_at = NOW()
           WHERE sale_id = $1
             AND status NOT IN ('CANCELLED', 'VOIDED', 'DRAFT')`,
          [saleId, refundTotalAmount.toFixed(2)]
        );

        // Step 6b: Recalculate customer balance from invoices (SSOT).
        // Now that amount_due is updated, this will return the correct lower balance.
        const { syncCustomerBalanceFromInvoices } = await import('../../utils/customerBalanceSync.js');
        await syncCustomerBalanceFromInvoices(client, sale.customer_id, 'SALE_REFUND');
      }

      // ── 7. GL Posting: Refund journal entry ─────────────────────

      // GL POSTING: Refund journal entry
      // MUST succeed — if GL fails, the entire refund rolls back to prevent discrepancies
      const glRefundData: SaleRefundData = {
        refundId: refund.id,
        refundNumber: refund.refundNumber,
        saleId,
        saleNumber: sale.sale_number,
        refundDate: input.refundDate || getBusinessDate(),
        reason: input.reason,
        totalAmount: refundTotalAmount.toNumber(),
        totalCost: refundTotalCost.toNumber(),
        paymentMethod: sale.payment_method,
        customerId: sale.customer_id || undefined,
        arCreditAmount,
        refundType,
      };

      const glTransactionId = await glEntryService.recordSaleRefundToGL(glRefundData, pool, client);

      // Link GL transaction to refund document
      if (glTransactionId) {
        await salesRepository.updateRefundGlTransaction(client, refund.id, glTransactionId);
      }

      // ── 8. Check if sale is now fully refunded ──────────────────

      const isFullRefund = await salesRepository.isSaleFullyRefunded(client, saleId);

      if (isFullRefund) {
        // Full return: COMPLETED/PARTIALLY_RETURNED → VOIDED_BY_RETURN
        // (SAP/Odoo discipline: original sale document preserved in audit trail;
        //  VOIDED_BY_RETURN signals it was fully reversed through the return workflow)
        await salesRepository.markSaleVoidedByReturn(client, saleId);
        logger.info('Sale fully returned — status changed to VOIDED_BY_RETURN', {
          saleId,
          saleNumber: sale.sale_number,
        });

        // SAP GLT0: Sale status changes from COMPLETED → REFUNDED,
        // so it no longer counts in COMPLETED summaries — decrement rollup
        // SAVEPOINT: prevents PG aborted-transaction if this fails
        try {
          await client.query('SAVEPOINT refund_daily_summary');
          const refundSaleDate = String(sale.sale_date).slice(0, 10);
          const isCredit = sale.payment_method === 'CREDIT';
          const amtPaid = Money.toNumber(Money.parseDb(sale.amount_paid ?? 0));
          const saleTotalAmt = Money.toNumber(Money.parseDb(sale.total_amount ?? 0));
          const isPartial = isCredit && amtPaid > 0 && amtPaid < saleTotalAmt;
          await salesRepository.decrementDailySummary(
            client,
            refundSaleDate,
            sale.payment_method,
            sale.total_amount || 0,
            sale.total_cost || 0,
            sale.discount_amount || 0,
            isCredit,
            isPartial
          );
        } catch (summaryError: unknown) {
          await client.query('ROLLBACK TO SAVEPOINT refund_daily_summary');
          logger.error('Daily summary rollup decrement failed on full return — will be healed by reconciliation', {
            saleId,
            saleNumber: sale.sale_number,
            error: summaryError instanceof Error ? summaryError.message : String(summaryError),
          });
        }

        // STATE TABLES: Reverse product_daily_summary for the full sale
        // (sales_daily_summary was decremented above; product_daily_summary needs the same)
        try {
          await client.query('SAVEPOINT refund_product_daily_summary');
          const refundSaleDate = String(sale.sale_date).slice(0, 10);

          // Fetch categories for all products on the original sale
          const fullReturnProductIds = saleItems
            .map((si) => si.productId)
            .filter((id): id is string => !!id);
          const fullReturnCategoryMap = new Map<string, string>();
          if (fullReturnProductIds.length > 0) {
            const catRes = await client.query(
              `SELECT id, COALESCE(NULLIF(TRIM(category), ''), 'Uncategorized') AS category
               FROM products WHERE id = ANY($1)`,
              [[...new Set(fullReturnProductIds)]]
            );
            for (const row of catRes.rows) {
              fullReturnCategoryMap.set(row.id, row.category);
            }
          }

          // Aggregate all sale items into decrement entries
          const fullReturnPdsMap = new Map<string, { category: string; unitsSold: Decimal; revenue: Decimal; costOfGoods: Decimal; discountGiven: Decimal }>();
          for (const si of saleItems) {
            if (!si.productId) continue;
            const qty = Money.parseDb(si.quantity);
            const unitCost = Money.parseDb(si.unitCost);
            const totalPrice = Money.parseDb(si.totalPrice);
            const costOfGoods = unitCost.times(qty);
            const itemDiscount = Money.parseDb(si.discountAmount ?? 0);
            const existing = fullReturnPdsMap.get(si.productId);
            if (existing) {
              existing.unitsSold = existing.unitsSold.plus(qty);
              existing.revenue = existing.revenue.plus(totalPrice);
              existing.costOfGoods = existing.costOfGoods.plus(costOfGoods);
              existing.discountGiven = existing.discountGiven.plus(itemDiscount);
            } else {
              fullReturnPdsMap.set(si.productId, {
                category: fullReturnCategoryMap.get(si.productId) || 'Uncategorized',
                unitsSold: qty,
                revenue: totalPrice,
                costOfGoods,
                discountGiven: itemDiscount,
              });
            }
          }

          const fullReturnPdsItems = Array.from(fullReturnPdsMap.entries()).map(([productId, agg]) => ({
            productId,
            category: agg.category,
            unitsSold: agg.unitsSold.toNumber(),
            revenue: agg.revenue.toNumber(),
            costOfGoods: agg.costOfGoods.toNumber(),
            discountGiven: agg.discountGiven.toNumber(),
          }));
          await stateTablesRepo.batchDecrementProductDailySummary(client, refundSaleDate, fullReturnPdsItems);
        } catch (pdsError: unknown) {
          await client.query('ROLLBACK TO SAVEPOINT refund_product_daily_summary');
          logger.error('Product daily summary decrement failed on full return — will be healed by reconciliation', {
            saleId,
            saleNumber: sale.sale_number,
            error: pdsError instanceof Error ? pdsError.message : String(pdsError),
          });
        }
      } else {
        // Partial return: advance status from COMPLETED → PARTIALLY_RETURNED
        // If already PARTIALLY_RETURNED (prior returns exist), leave status as-is
        if (sale.status === 'COMPLETED') {
          await salesRepository.markSalePartiallyReturned(client, saleId);
          logger.info('Sale partially returned — status changed to PARTIALLY_RETURNED', {
            saleId,
            saleNumber: sale.sale_number,
          });
        }

        // STATE TABLES: Decrement product_daily_summary for the returned items.
        // Full refund path does the same at line ~3115; partial refund must mirror it
        // so that category-level revenue/COGS breakdown stays accurate.
        try {
          await client.query('SAVEPOINT partial_refund_pds');
          const partialRefundSaleDate = String(sale.sale_date).slice(0, 10);

          // Fetch categories for the returned products
          const partialProductIds = validatedItems
            .map(({ saleItem }) => saleItem.productId)
            .filter((id): id is string => !!id);
          const partialCategoryMap = new Map<string, string>();
          if (partialProductIds.length > 0) {
            const catRes = await client.query(
              `SELECT id, COALESCE(NULLIF(TRIM(category), ''), 'Uncategorized') AS category
               FROM products WHERE id = ANY($1)`,
              [[...new Set(partialProductIds)]]
            );
            for (const row of catRes.rows as Array<{ id: string; category: string }>) {
              partialCategoryMap.set(row.id, row.category);
            }
          }

          // Aggregate returned items by productId (same product may appear twice
          // if the caller submitted two line items for the same product)
          const partialPdsMap = new Map<string, {
            category: string;
            unitsSold: Decimal;
            revenue: Decimal;
            costOfGoods: Decimal;
            discountGiven: Decimal;
          }>();

          for (const { saleItem, refundQty, lineTotal, costTotal } of validatedItems) {
            if (!saleItem.productId) continue;
            // Pro-rate the original item discount by the returned fraction
            const originalQty = new Decimal(saleItem.quantity);
            const itemDiscount = originalQty.greaterThan(0)
              ? Money.parseDb(saleItem.discountAmount ?? 0)
                .times(refundQty)
                .dividedBy(originalQty)
              : new Decimal(0);

            const existing = partialPdsMap.get(saleItem.productId);
            if (existing) {
              existing.unitsSold = existing.unitsSold.plus(refundQty);
              existing.revenue = existing.revenue.plus(lineTotal);
              existing.costOfGoods = existing.costOfGoods.plus(costTotal);
              existing.discountGiven = existing.discountGiven.plus(itemDiscount);
            } else {
              partialPdsMap.set(saleItem.productId, {
                category: partialCategoryMap.get(saleItem.productId) || 'Uncategorized',
                unitsSold: refundQty,
                revenue: lineTotal,
                costOfGoods: costTotal,
                discountGiven: itemDiscount,
              });
            }
          }

          const partialPdsItems = Array.from(partialPdsMap.entries()).map(([productId, agg]) => ({
            productId,
            category: agg.category,
            unitsSold: agg.unitsSold.toNumber(),
            revenue: agg.revenue.toNumber(),
            costOfGoods: agg.costOfGoods.toNumber(),
            discountGiven: agg.discountGiven.toNumber(),
          }));

          if (partialPdsItems.length > 0) {
            await stateTablesRepo.batchDecrementProductDailySummary(
              client,
              partialRefundSaleDate,
              partialPdsItems
            );
          }
        } catch (pdsError: unknown) {
          await client.query('ROLLBACK TO SAVEPOINT partial_refund_pds');
          logger.error('Product daily summary decrement failed on partial return — will be healed by reconciliation', {
            saleId,
            saleNumber: sale.sale_number,
            error: pdsError instanceof Error ? pdsError.message : String(pdsError),
          });
        }
      }

      await client.query('COMMIT');

      logger.info('Sale return completed successfully', {
        refundId: refund.id,
        refundNumber: refund.refundNumber,
        saleId,
        saleNumber: sale.sale_number,
        totalAmount: refundTotalAmount.toFixed(2),
        totalCost: refundTotalCost.toFixed(2),
        itemsRestored: validatedItems.length,
        isFullRefund,
      });

      const returnNotifyPayload = buildProductLineNotificationPayload({
        action: 'Returned',
        items: validatedItems.map(({ saleItem, refundQty }) => ({
          productName: saleItem.productName,
          quantity: refundQty.toNumber(),
        })),
        documentRef: sale.sale_number,
        amount: Number(refundTotalAmount.toFixed(2)),
      });
      publishNotificationEvent({
        pool,
        typeKey: 'SALE_RETURNED',
        entityType: 'sale',
        entityId: saleId,
        idempotencyKey: `SALE_RETURNED:refund:${refund.id}`,
        payload: returnNotifyPayload,
        actorUserId: refundedById,
        storeLocationId: sale.store_location_id || null,
      });

      // CASH REGISTER: Record refund movement for drawer tracking (REFUND only — not exchange store credit)
      const isCashPayment = sale.payment_method === 'CASH';
      const isMobilePayment = sale.payment_method === 'MOBILE_MONEY' || sale.payment_method === 'AIRTEL_MONEY';
      if (
        refundType === 'REFUND'
        && (isCashPayment || isMobilePayment)
        && refundTotalAmount.greaterThan(0)
      ) {
        try {
          // Use original sale's session if still open; otherwise find user's open session
          let sessionId: string | null = sale.cash_register_session_id || null;
          if (sessionId) {
            const origSession = await cashRegisterRepository.getSessionById(pool, sessionId);
            if (!origSession || origSession.status !== 'OPEN') {
              sessionId = null;
            }
          }
          if (!sessionId) {
            const openSession = await cashRegisterRepository.getUserOpenSession(pool, refundedById);
            sessionId = openSession?.id || null;
          }
          if (sessionId) {
            await cashRegisterService.recordRefundMovement(
              sessionId,
              refund.id,
              refundTotalAmount.toNumber(),
              refundedById,
              `Refund ${refund.refundNumber}: ${input.reason}`,
              pool
            );
            logger.info('Cash register refund movement recorded', {
              refundId: refund.id,
              refundNumber: refund.refundNumber,
              sessionId,
              amount: refundTotalAmount.toNumber(),
            });
          } else {
            logger.warn('No open cash register session found for refund — drawer tracking incomplete', {
              refundId: refund.id,
              saleId,
              paymentMethod: sale.payment_method,
            });
          }
        } catch (regError: unknown) {
          logger.error('Cash register refund movement failed — drawer tracking incomplete', {
            refundId: refund.id,
            saleId,
            error: regError instanceof Error ? regError.message : String(regError),
          });
        }
      }

      return {
        refund,
        refundItems,
        itemsRestored: validatedItems.length,
        isFullRefund,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Failed to refund sale', {
        saleId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    } finally {
      client.release();
    }
  },

  /**
   * Guided product exchange: return wrong item(s) → optional replacement sale → residual settlement.
   * Prefer this over isolated EXCHANGE + later POS so walk-in residual never becomes an anonymous deposit.
   */
  async completeProductExchange(
    pool: Pool,
    originalSaleId: string,
    userId: string,
    input: CompleteProductExchangeInput,
  ): Promise<{
    refund: RefundRecord;
    replacementSale: SaleRecord | null;
    creditTotal: number;
    creditApplied: number;
    residualAmount: number;
    residualAction: ExchangeResidualAction;
    topUpPaid: number;
    voucherNumber: string | null;
    cashToCustomer: number;
  }> {
    if (!input.returnItems?.length) {
      throw new BusinessError('Select at least one item to exchange', 'ERR_EXCHANGE_ITEMS', {});
    }
    if (!input.reason?.trim()) {
      throw new BusinessError('Exchange reason is required', 'ERR_EXCHANGE_REASON', {});
    }

    const residualAction = input.residualAction || 'REFUND_ORIGINAL_TENDER';
    const replacementItems = input.replacementItems || [];

    const origResult = await salesRepository.getSaleById(pool, originalSaleId);
    if (!origResult) {
      throw new NotFoundError(`Sale ${originalSaleId}`);
    }
    const origSaleRow = origResult.sale as SaleRecord & { customer_id?: string | null };
    const originalCustomerId = origSaleRow.customerId ?? origSaleRow.customer_id ?? null;

    // 1) Post EXCHANGE credit (store credit liability 2210)
    const refundResult = await this.refundSale(pool, originalSaleId, userId, {
      items: input.returnItems,
      reason: input.reason.trim(),
      refundType: 'EXCHANGE',
    });

    const creditTotal = Money.toNumber(Money.parseDb(refundResult.refund.totalAmount));
    let creditApplied = 0;
    let topUpPaid = 0;
    let replacementSale: SaleRecord | null = null;
    let cashToCustomer = 0;

    // 2) Replacement sale with credit applied as discount
    if (replacementItems.length > 0) {
      const lineSubtotal = replacementItems.reduce(
        (sum, it) => sum.plus(new Decimal(it.unitPrice).times(it.quantity)),
        new Decimal(0),
      );
      creditApplied = Math.min(
        creditTotal,
        Money.toNumber(Money.round(lineSubtotal, 2)),
      );
      const residualBeforeSale = Money.toNumber(
        Money.round(Money.subtract(Money.parseDb(creditTotal), Money.parseDb(creditApplied)), 2),
      );
      topUpPaid = Math.max(
        0,
        Money.toNumber(Money.round(lineSubtotal.minus(creditApplied), 2)),
      );

      const paymentMethod = topUpPaid > 0.009
        ? (input.topUpPaymentMethod || 'CASH')
        : 'CASH';

      const saleResult = await this.createSale(pool, {
        customerId: originalCustomerId || undefined,
        items: replacementItems.map((it) => ({
          productId: it.productId,
          productName: it.productName || 'Product',
          quantity: it.quantity,
          unitPrice: it.unitPrice,
        })),
        discountAmount: creditApplied,
        paymentMethod,
        paymentReceived: topUpPaid,
        soldBy: input.soldBy || userId,
        cashRegisterSessionId: input.cashRegisterSessionId,
        exchangeRefundId: refundResult.refund.id,
        exchangeResidualAction: residualAction,
      });

      replacementSale = saleResult.sale;
      if (residualAction === 'REFUND_ORIGINAL_TENDER' && residualBeforeSale > 0.01) {
        cashToCustomer = residualBeforeSale;
      }
    } else if (residualAction === 'REFUND_ORIGINAL_TENDER') {
      await this.settleExchangeResidual(pool, refundResult.refund.id, userId, {
        residualAction: 'REFUND_ORIGINAL_TENDER',
        cashRegisterSessionId: input.cashRegisterSessionId,
      });
      cashToCustomer = creditTotal;
    }

    const openCredit = await salesRepository.getExchangeRefundForApplication(
      pool,
      refundResult.refund.id,
    );
    const remainingOpen = openCredit?.remainingAmount ?? 0;

    return {
      refund: refundResult.refund,
      replacementSale,
      creditTotal,
      creditApplied,
      residualAmount: remainingOpen,
      residualAction,
      topUpPaid,
      voucherNumber: remainingOpen > 0.01 ? refundResult.refund.refundNumber : null,
      cashToCustomer,
    };
  },

  /**
   * Settle leftover exchange store credit (cash/card out or leave as voucher intentionally).
   */
  async settleExchangeResidual(
    pool: Pool,
    refundId: string,
    userId: string,
    input: {
      residualAction: ExchangeResidualAction;
      cashRegisterSessionId?: string;
    },
  ): Promise<{ remainingAfter: number; paidOut: number; voucherNumber: string | null }> {
    const exchangeRefund = await salesRepository.getExchangeRefundForApplication(pool, refundId);
    if (!exchangeRefund || exchangeRefund.refundType !== 'EXCHANGE') {
      throw new BusinessError('Exchange credit not found', 'ERR_EXCHANGE_RESIDUAL_002', { refundId });
    }
    const remaining = exchangeRefund.remainingAmount;
    if (remaining <= 0.01) {
      return { remainingAfter: 0, paidOut: 0, voucherNumber: null };
    }

    if (input.residualAction === 'KEEP_VOUCHER') {
      return {
        remainingAfter: remaining,
        paidOut: 0,
        voucherNumber: exchangeRefund.refundNumber,
      };
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const orig = await client.query<{
        payment_method: string;
        customer_id: string | null;
      }>(
        `SELECT s.payment_method, s.customer_id
         FROM sale_refunds r
         JOIN sales s ON s.id = r.sale_id
         WHERE r.id = $1
         FOR UPDATE OF r`,
        [refundId],
      );
      const paymentMethod = (orig.rows[0]?.payment_method || 'CASH') as
        | 'CASH'
        | 'CARD'
        | 'MOBILE_MONEY'
        | 'AIRTEL_MONEY'
        | 'CREDIT'
        | 'DEPOSIT';

      await salesRepository.applyExchangeResidualPayout(client, refundId, remaining);
      await glEntryService.recordExchangeResidualPayoutToGL(
        {
          refundId: exchangeRefund.id,
          refundNumber: exchangeRefund.refundNumber,
          payoutDate: getBusinessDate(),
          amount: remaining,
          paymentMethod,
          customerId: orig.rows[0]?.customer_id || undefined,
        },
        pool,
        client,
      );

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    try {
      let sessionId: string | null = input.cashRegisterSessionId || null;
      if (!sessionId) {
        const openSession = await cashRegisterRepository.getUserOpenSession(pool, userId);
        sessionId = openSession?.id || null;
      }
      if (sessionId) {
        await cashRegisterService.recordRefundMovement(
          sessionId,
          refundId,
          remaining,
          userId,
          `Exchange residual payout ${exchangeRefund.refundNumber}`,
          pool,
        );
      }
    } catch (regErr) {
      logger.warn('Cash register residual settlement movement failed', {
        refundId,
        error: regErr instanceof Error ? regErr.message : String(regErr),
      });
    }

    return { remainingAfter: 0, paidOut: remaining, voucherNumber: null };
  },

  async listOpenExchangeCredits(pool: Pool, limit = 50) {
    return salesRepository.listOpenExchangeCredits(pool, limit);
  },
};
