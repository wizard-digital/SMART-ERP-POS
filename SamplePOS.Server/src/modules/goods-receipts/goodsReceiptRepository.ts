import { Pool, PoolClient } from 'pg';
import logger from '../../utils/logger.js';
import { checkAccountingPeriodOpen } from '../../utils/periodGuard.js';
import { getBusinessYear } from '../../utils/dateRange.js';
import {
  tableHasColumn,
  grItemsConversionFactorExpr,
  grItemsIsBonusExpr,
} from '../../db/schemaColumnCache.js';
import { pickSortColumn, sqlSortOrder } from '../../utils/enterpriseListQuery.js';
import {
  poItemNetReceivedQuantitySql,
  poItemReturnedQuantitySql,
} from '../purchase-orders/purchaseOrderNetReceived.js';
import { resolveGrBillingLane } from '@shared/domain/grBillingStatusSsot.js';

const GR_SORT_COLUMNS: Record<string, string> = {
  grNumber: 'gr.receipt_number',
  poNumber: 'po.order_number',
  supplier: 's."CompanyName"',
  receivedDate: 'gr.received_date',
  receiptStatus: 'gr.status',
};

/** True when every received line on the GR has been fully returned via posted Return GRNs. */
function grLegacyFullyReversedSql(grAlias = 'gr'): string {
  return `(
    EXISTS (SELECT 1 FROM return_grn rg WHERE rg.grn_id = ${grAlias}.id AND rg.status = 'POSTED')
    AND NOT EXISTS (
      SELECT 1
      FROM goods_receipt_items gri
      WHERE gri.goods_receipt_id = ${grAlias}.id
        AND COALESCE(gri.received_quantity, 0)::numeric > COALESCE((
          SELECT SUM(rl.quantity)
          FROM return_grn_lines rl
          INNER JOIN return_grn rg2 ON rg2.id = rl.rgrn_id AND rg2.status = 'POSTED'
          WHERE rg2.grn_id = gri.goods_receipt_id
            AND rl.product_id = gri.product_id
        ), 0)::numeric + 0.0001
    )
  )`;
}

/** Metadata link and/or legacy inference from posted Return GRNs (pre-migration 522 backfill). */
async function grFullyReversedConditionSql(pool: Pool | PoolClient, grAlias = 'gr'): Promise<string> {
  const hasMetadata = await tableHasColumn(pool, 'goods_receipts', 'reversed_by_return_grn_id');
  const legacy = grLegacyFullyReversedSql(grAlias);
  if (!hasMetadata) return legacy;
  return `(${grAlias}.reversed_by_return_grn_id IS NOT NULL OR ${legacy})`;
}

async function grReversalSelectSql(pool: Pool | PoolClient, fullyReversedSql?: string): Promise<string> {
  const isReversedExpr = fullyReversedSql ?? (await grFullyReversedConditionSql(pool, 'gr'));
  const has = await tableHasColumn(pool, 'goods_receipts', 'reversed_by_return_grn_id');
  if (!has) {
    return `
         NULL::uuid AS "reversedByReturnGrnId",
         NULL::text AS "reversedByReturnGrnNumber",
         NULL::timestamptz AS "reversalTimestamp",
         NULL::text AS "reversalReason",
         (${isReversedExpr}) AS "isReversed"`;
  }
  return `
         gr.reversed_by_return_grn_id AS "reversedByReturnGrnId",
         (SELECT r.return_grn_number FROM return_grn r WHERE r.id = gr.reversed_by_return_grn_id) AS "reversedByReturnGrnNumber",
         gr.reversal_timestamp AS "reversalTimestamp",
         gr.reversal_reason AS "reversalReason",
         (${isReversedExpr}) AS "isReversed"`;
}

function buildGrItemRowSelectSql(options: {
  hasUomSnapshot: boolean;
  hasTargetStore: boolean;
}): string {
  const baseQtySelect = options.hasUomSnapshot
    ? 'base_qty as "baseQty"'
    : 'NULL::numeric as "baseQty"';
  const baseUomSelect = options.hasUomSnapshot
    ? 'base_uom_id as "baseUomId"'
    : 'NULL::uuid as "baseUomId"';
  const conversionSelect = options.hasUomSnapshot
    ? 'conversion_factor as "conversionFactor"'
    : 'NULL::numeric as "conversionFactor"';
  const targetStoreSelect = options.hasTargetStore
    ? 'target_store_location_id as "targetStoreLocationId"'
    : 'NULL::uuid as "targetStoreLocationId"';

  return `
         id,
         goods_receipt_id as "goodsReceiptId",
         product_id as "productId",
         received_quantity as "receivedQuantity",
         batch_number as "batchNumber",
         expiry_date as "expiryDate",
         cost_price as "unitCost",
         COALESCE(is_bonus, false) as "isBonus",
         uom_id as "uomId",
         ${baseQtySelect},
         ${baseUomSelect},
         ${conversionSelect},
         ${targetStoreSelect},
         created_at as "createdAt",
         version`;
}

export interface GoodsReceipt {
  id: string;
  grNumber: string;
  purchaseOrderId: string;
  receivedDate: string;  // DATE column — returned as YYYY-MM-DD string (timezone strategy)
  status: 'DRAFT' | 'COMPLETED' | 'CANCELLED';
  supplierDeliveryNote: string | null;
  receivedBy: string;
  receivedByName?: string | null;
  createdAt: string;
  updatedAt: string;
  // Join fields — present when fetched via getGRById / listGRs
  poNumber?: string | null;
  poStatus?: string | null;
  /** True when linked PO was auto-created by Manual GR (COMPLETED shell). */
  poManualReceipt?: boolean | null;
  supplierId?: string | null;
  supplierName?: string | null;
  /** Latest supplier bill (SBILL) linked to this GRN, if any. */
  supplierBillNumber?: string | null;
  /**
   * SAP/Odoo billing lane on the GR list:
   * DRAFT_GR = receipt not finalized | TO_INVOICE = received-not-billed (GR/IR) | INVOICED = AP bill exists
   * REVERSED = fully returned via posted Return GRN — not billable
   */
  billingStatus?: 'DRAFT_GR' | 'TO_INVOICE' | 'INVOICED' | 'REVERSED' | 'CANCELLED' | 'NOT_APPLICABLE';
  /** Posted Return GRN that fully reversed this receipt (counter-document). */
  reversedByReturnGrnId?: string | null;
  reversedByReturnGrnNumber?: string | null;
  reversalTimestamp?: string | null;
  reversalReason?: string | null;
  isReversed?: boolean;
  /** When another GR on the same PO already has a supplier bill (top-up receipt). */
  poSiblingBill?: {
    invoiceId: string;
    invoiceNumber: string;
    grnId: string;
    grnNumber: string;
  } | null;
}

export interface GoodsReceiptItem {
  id: string;
  goodsReceiptId: string;
  poItemId: string | null;
  productId: string;
  productName: string;
  trackExpiry?: boolean;
  orderedQuantity: number;
  receivedQuantity: number;
  unitCost: number;
  batchNumber: string | null;
  expiryDate: string | null;  // DATE column — returned as YYYY-MM-DD string
  isBonus: boolean;
  // Computed join fields — present from getGRById items query
  poUnitPrice?: number | null;
  productCostPrice?: number | null;
  qtyVariance?: number | null;
  costVariance?: number | null;
  uomName?: string | null;
  uomSymbol?: string | null;
  conversionFactor?: number;
  uomId?: string | null;
  baseQty?: number | null;
  baseUomId?: string | null;
  targetStoreLocationId?: string | null;
}

export interface CreateGRData {
  purchaseOrderId?: string | null;
  receiptDate: string;
  notes: string | null;
  receivedBy: string;
  source?: 'PURCHASE_ORDER' | 'MANUAL' | 'OPENING_BALANCE';
}

export interface CreateGRItemData {
  goodsReceiptId: string;
  poItemId?: string | null;
  productId: string;
  productName: string;
  orderedQuantity: number;
  receivedQuantity: number;
  unitCost: number;
  batchNumber: string | null;
  expiryDate: string | null;
  uomId?: string | null; // SAP pattern: inherited from PO item
  baseQty?: number | null; // SAP UoM snapshot: received quantity in base unit
  baseUomId?: string | null; // SAP UoM snapshot: base UoM ID at posting time
  conversionFactor?: number; // SAP UoM snapshot: conversion factor at posting time
  targetStoreLocationId?: string | null;
}

export interface UpdateGRItemData {
  receivedQuantity?: number;
  unitCost?: number;
  batchNumber?: string | null;
  isBonus?: boolean;
  expiryDate?: string | null;
  uomId?: string | null;
  baseQty?: number | null;
  baseUomId?: string | null;
  conversionFactor?: number;
  targetStoreLocationId?: string | null;
}

export const goodsReceiptRepository = {
  /**
   * Generate next GR number (GR-YYYY-NNNN format)
   * Accepts Pool or PoolClient — MUST be called on transaction client
   * so the advisory lock is held until COMMIT.
   */
  async generateGRNumber(pool: Pool | PoolClient): Promise<string> {
    const year = getBusinessYear();
    // Advisory lock prevents concurrent duplicate GR number generation
    await pool.query(`SELECT pg_advisory_xact_lock(hashtext('gr_number_seq'))`);
    const result = await pool.query(
      `SELECT receipt_number FROM goods_receipts 
       WHERE receipt_number LIKE $1 
       ORDER BY receipt_number DESC 
       LIMIT 1`,
      [`GR-${year}-%`]
    );

    if (result.rows.length === 0) {
      return `GR-${year}-0001`;
    }

    const lastNumber = result.rows[0].receipt_number;
    const sequence = parseInt(lastNumber.split('-')[2]) + 1;
    return `GR-${year}-${sequence.toString().padStart(4, '0')}`;
  },

  /**
   * Create goods receipt
   * Accepts Pool or PoolClient to participate in caller's transaction.
   */
  async createGR(pool: Pool | PoolClient, data: CreateGRData): Promise<GoodsReceipt> {
    const grNumber = await this.generateGRNumber(pool);

    // Period enforcement (replaces trg_enforce_period_goods_receipts)
    await checkAccountingPeriodOpen(pool, data.receiptDate);

    const result = await pool.query(
      `INSERT INTO goods_receipts (
        receipt_number, purchase_order_id, received_date, received_by_id, notes, status
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING 
        id,
        receipt_number as "grNumber",
        purchase_order_id as "purchaseOrderId",
        received_date as "receivedDate",
        status,
        notes as "supplierDeliveryNote",
        received_by_id as "receivedBy",
        created_at as "createdAt",
        updated_at as "updatedAt",
        version`,
      [
        grNumber,
        data.purchaseOrderId || null,
        data.receiptDate,
        data.receivedBy,
        data.notes,
        'DRAFT',
      ]
    );

    return result.rows[0];
  },

  /**
   * Add items to goods receipt
   * Accepts Pool or PoolClient to participate in caller's transaction.
   */
  async addGRItems(pool: Pool | PoolClient, items: CreateGRItemData[]): Promise<GoodsReceiptItem[]> {
    if (items.length === 0) return [];

    const hasUomSnapshot = await tableHasColumn(pool, 'goods_receipt_items', 'base_qty');
    const hasTargetStore = await tableHasColumn(pool, 'goods_receipt_items', 'target_store_location_id');
    const values: unknown[] = [];
    const placeholders: string[] = [];
    const fieldsPerRow = (hasUomSnapshot ? 11 : 8) + (hasTargetStore ? 1 : 0);

    items.forEach((item, index) => {
      const offset = index * fieldsPerRow;
      if (hasUomSnapshot) {
        const rowValues: unknown[] = [
          item.goodsReceiptId,
          item.productId,
          item.receivedQuantity,
          item.batchNumber || null,
          item.expiryDate || null,
          item.unitCost,
          item.uomId || null,
          item.poItemId || null,
          item.baseQty ?? null,
          item.baseUomId ?? null,
          item.conversionFactor ?? 1,
        ];
        if (hasTargetStore) {
          rowValues.push(item.targetStoreLocationId ?? null);
        }
        placeholders.push(
          `(${rowValues.map((_, i) => `$${offset + i + 1}`).join(', ')})`
        );
        values.push(...rowValues);
      } else {
        const rowValues: unknown[] = [
          item.goodsReceiptId,
          item.productId,
          item.receivedQuantity,
          item.batchNumber || null,
          item.expiryDate || null,
          item.unitCost,
          item.uomId || null,
          item.poItemId || null,
        ];
        if (hasTargetStore) {
          rowValues.push(item.targetStoreLocationId ?? null);
        }
        placeholders.push(
          `(${rowValues.map((_, i) => `$${offset + i + 1}`).join(', ')})`
        );
        values.push(...rowValues);
      }
    });

    const baseColumns = hasUomSnapshot
      ? `goods_receipt_id, product_id, received_quantity, batch_number, expiry_date, cost_price, uom_id, po_item_id, base_qty, base_uom_id, conversion_factor`
      : `goods_receipt_id, product_id, received_quantity, batch_number, expiry_date, cost_price, uom_id, po_item_id`;
    const insertColumns = hasTargetStore
      ? `${baseColumns}, target_store_location_id`
      : baseColumns;

    const result = await pool.query(
      `INSERT INTO goods_receipt_items (${insertColumns})
      VALUES ${placeholders.join(', ')}
      RETURNING 
        id,
        goods_receipt_id as "goodsReceiptId",
        po_item_id as "poItemId",
        product_id as "productId",
        received_quantity as "receivedQuantity",
        batch_number as "batchNumber",
        expiry_date as "expiryDate",
        cost_price as "unitCost",
        uom_id as "uomId",
        is_bonus as "isBonus",
        created_at as "createdAt",
        version`,
      values
    );

    return result.rows;
  },

  /**
   * Get GR by ID with items
   * Accepts Pool or PoolClient to participate in caller's transaction.
   */
  async getGRById(
    pool: Pool | PoolClient,
    id: string
  ): Promise<{ gr: GoodsReceipt; items: GoodsReceiptItem[]; productUomsMap?: Record<string, Array<{ id: string; uomId: string; uomName: string; uomSymbol: string | null; conversionFactor: string; barcode: string | null; isDefault: boolean; priceOverride: string | null; costOverride: string | null }>> } | null> {
    const reversalSql = await grReversalSelectSql(pool);
    const grResult = await pool.query(
      `SELECT 
         gr.id,
         gr.receipt_number as "grNumber",
         gr.purchase_order_id as "purchaseOrderId",
         gr.received_date as "receivedDate",
         gr.status,
         gr.notes as "supplierDeliveryNote",
         gr.received_by_id as "receivedBy",
         COALESCE(u.full_name, u.email) as "receivedByName",
         gr.created_at as "createdAt",
         gr.updated_at as "updatedAt",
         gr.version,
         po.order_number AS "poNumber",
         po.status AS "poStatus",
         COALESCE(po.manual_receipt, false) AS "poManualReceipt",
         po.supplier_id as "supplierId",
         s."CompanyName" as "supplierName",
         ${reversalSql},
         (SELECT si."SupplierInvoiceNumber"
            FROM supplier_invoices si
           WHERE si.document_type = 'SUPPLIER_INVOICE'
             AND si.deleted_at IS NULL
             AND COALESCE(si."Status",'') NOT IN ('Cancelled','CANCELLED','Voided','VOIDED')
             AND (
               si."Id" IN (
                 SELECT sigl.invoice_id FROM supplier_invoice_grn_links sigl
                 WHERE sigl.grn_id = gr.id
               )
               OR si."InternalReferenceNumber" = gr.receipt_number
             )
           ORDER BY si."CreatedAt" DESC
           LIMIT 1) AS "supplierBillNumber"
       FROM goods_receipts gr
       LEFT JOIN purchase_orders po ON gr.purchase_order_id = po.id
       LEFT JOIN suppliers s ON po.supplier_id = s."Id"
       LEFT JOIN users u ON u.id = gr.received_by_id
       WHERE gr.id = $1`,
      [id]
    );

    if (grResult.rows.length === 0) {
      return null;
    }

    const conversionFactorExpr = await grItemsConversionFactorExpr(pool);
    const isBonusExpr = await grItemsIsBonusExpr(pool);
    const hasUomSnapshot = await tableHasColumn(pool, 'goods_receipt_items', 'base_qty');
    const baseQtySelect = hasUomSnapshot ? 'gri.base_qty as "baseQty"' : 'NULL::numeric as "baseQty"';
    const baseUomSelect = hasUomSnapshot ? 'gri.base_uom_id as "baseUomId"' : 'NULL::uuid as "baseUomId"';
    const hasTargetStore = await tableHasColumn(pool, 'goods_receipt_items', 'target_store_location_id');
    const targetStoreSelect = hasTargetStore
      ? 'gri.target_store_location_id as "targetStoreLocationId"'
      : 'NULL::uuid as "targetStoreLocationId"';
    const returnedSql = poItemReturnedQuantitySql('poi');
    const netSql = poItemNetReceivedQuantitySql('poi');

    const itemsResult = await pool.query(
      `SELECT 
         gri.id,
         gri.goods_receipt_id as "goodsReceiptId",
         gri.product_id as "productId",
         gri.po_item_id as "poItemId",
         COALESCE(p.name, 'Unknown Product') as "productName",
         COALESCE(p.track_expiry, false) as "trackExpiry",
         ROUND(COALESCE(poi.ordered_quantity, gri.received_quantity)::numeric, 2) as "orderedQuantity",
         ROUND(COALESCE(poi.received_quantity, 0)::numeric, 2) as "poGrossReceived",
         ROUND((${returnedSql})::numeric, 2) as "poReturnedQuantity",
         ROUND((${netSql})::numeric, 2) as "poAlreadyReceived",
         ROUND(gri.received_quantity::numeric, 2) as "receivedQuantity",
         COALESCE(gri.batch_number, ib.batch_number) as "batchNumber",
         gri.expiry_date as "expiryDate",
         ROUND(gri.cost_price::numeric, 2) as "unitCost",
         ${isBonusExpr} as "isBonus",
         ROUND(poi.unit_price::numeric, 2) as "poUnitPrice",
         ROUND(pv.cost_price::numeric, 2) as "productCostPrice",
         ROUND((gri.received_quantity - COALESCE(poi.ordered_quantity, gri.received_quantity))::numeric, 2) as "qtyVariance",
         ROUND((gri.cost_price - COALESCE(poi.unit_price, pv.cost_price))::numeric, 2) as "costVariance",
         COALESCE(u.name, def_u.name) as "uomName",
         COALESCE(u.symbol, def_u.symbol) as "uomSymbol",
         ${conversionFactorExpr} as "conversionFactor",
         COALESCE(gri.uom_id, poi.uom_id) as "uomId",
         ${baseQtySelect},
         ${baseUomSelect},
         ${targetStoreSelect}
       FROM goods_receipt_items gri
       JOIN goods_receipts gr ON gr.id = gri.goods_receipt_id
       LEFT JOIN products p ON gri.product_id = p.id
       LEFT JOIN product_valuation pv ON pv.product_id = p.id
       LEFT JOIN purchase_order_items poi ON poi.id = gri.po_item_id
       LEFT JOIN inventory_batches ib ON ib.goods_receipt_id = gri.goods_receipt_id
         AND ib.product_id = gri.product_id
         AND gri.batch_number IS NULL
       LEFT JOIN uoms u ON u.id = COALESCE(gri.uom_id, poi.uom_id)
       LEFT JOIN product_uoms pu ON pu.product_id = gri.product_id AND pu.uom_id = COALESCE(gri.uom_id, poi.uom_id)
       LEFT JOIN product_uoms def_pu ON def_pu.product_id = gri.product_id AND def_pu.is_default = true
       LEFT JOIN uoms def_u ON def_u.id = def_pu.uom_id
       WHERE gri.goods_receipt_id = $1
       ORDER BY gri.created_at`,
      [id]
    );

    // Batch-fetch all product UoMs for every product in this GR (eliminates N+1)
    const productIds = [...new Set(itemsResult.rows.map((r: { productId: string }) => r.productId))];
    const productUomsMap: Record<string, Array<{
      id: string; uomId: string; uomName: string; uomSymbol: string | null;
      conversionFactor: string; barcode: string | null; isDefault: boolean;
      priceOverride: string | null; costOverride: string | null;
    }>> = {};

    if (productIds.length > 0) {
      const uomsResult = await pool.query(
        `SELECT
           pu.id,
           pu.product_id AS "productId",
           pu.uom_id AS "uomId",
           u.name AS "uomName",
           u.symbol AS "uomSymbol",
           pu.conversion_factor::text AS "conversionFactor",
           pu.barcode,
           pu.is_default AS "isDefault",
           pu.price_override::text AS "priceOverride",
           pu.cost_override::text AS "costOverride"
         FROM product_uoms pu
         JOIN uoms u ON u.id = pu.uom_id
         WHERE pu.product_id = ANY($1)
         ORDER BY pu.is_default DESC, u.name`,
        [productIds]
      );

      for (const row of uomsResult.rows) {
        const pid = row.productId;
        if (!productUomsMap[pid]) productUomsMap[pid] = [];
        productUomsMap[pid].push({
          id: row.id,
          uomId: row.uomId,
          uomName: row.uomName,
          uomSymbol: row.uomSymbol,
          conversionFactor: row.conversionFactor,
          barcode: row.barcode,
          isDefault: row.isDefault,
          priceOverride: row.priceOverride,
          costOverride: row.costOverride,
        });
      }
    }

    const grRow = grResult.rows[0] as GoodsReceipt;
    return {
      gr: {
        ...grRow,
        billingStatus: resolveGrBillingLane({
          receiptStatus: grRow.status,
          isReversed: grRow.isReversed,
          supplierBillNumber: grRow.supplierBillNumber,
        }),
        poSiblingBill: await this.resolvePoSiblingBill(pool, grRow, id),
      },
      items: itemsResult.rows,
      productUomsMap,
    };
  },

  /**
   * Active supplier bill on another completed GR for the same PO (re-receive / top-up).
   */
  async findPoSiblingSupplierBill(
    pool: Pool | PoolClient,
    poId: string,
    excludeGrId: string,
  ): Promise<{
    invoiceId: string;
    invoiceNumber: string;
    grnId: string;
    grnNumber: string;
  } | null> {
    const result = await pool.query(
      `SELECT si."Id" AS "invoiceId",
              si."SupplierInvoiceNumber" AS "invoiceNumber",
              gr.id AS "grnId",
              gr.receipt_number AS "grnNumber"
       FROM goods_receipts gr
       JOIN supplier_invoice_grn_links sigl ON sigl.grn_id = gr.id
       JOIN supplier_invoices si ON si."Id" = sigl.invoice_id
       WHERE gr.purchase_order_id = $1
         AND gr.id <> $2
         AND gr.status = 'COMPLETED'
         AND si.deleted_at IS NULL
         AND COALESCE(si."Status", '') NOT IN ('Cancelled', 'CANCELLED', 'Voided', 'VOIDED')
         AND COALESCE(si.document_type, 'SUPPLIER_INVOICE') = 'SUPPLIER_INVOICE'
       ORDER BY si."CreatedAt" DESC
       LIMIT 1`,
      [poId, excludeGrId],
    );
    return result.rows[0] ?? null;
  },

  async resolvePoSiblingBill(
    pool: Pool | PoolClient,
    gr: GoodsReceipt,
    grId: string,
  ): Promise<GoodsReceipt['poSiblingBill']> {
    if (!gr.purchaseOrderId) return null;
    const direct = await pool.query(
      `SELECT 1 FROM supplier_invoice_grn_links WHERE grn_id = $1 LIMIT 1`,
      [grId],
    );
    if (direct.rows.length > 0 || gr.supplierBillNumber) return null;
    return this.findPoSiblingSupplierBill(pool, gr.purchaseOrderId, grId);
  },

  /**
   * Get a single GR item by id with parent GR
   */
  async getGRItemWithParent(
    pool: Pool | PoolClient,
    itemId: string
  ): Promise<{ item: GoodsReceiptItem & { ordered_quantity?: number }; gr: GoodsReceipt } | null> {
    // Fetch item with proper camelCase aliases, joining PO items for ordered quantity
    const isBonusExpr = await grItemsIsBonusExpr(pool);
    const returnedSql = poItemReturnedQuantitySql('poi');
    const netSql = poItemNetReceivedQuantitySql('poi');

    const itemRes = await pool.query(
      `SELECT 
         gri.id,
         gri.goods_receipt_id as "goodsReceiptId",
         gri.po_item_id as "poItemId",
         gri.product_id as "productId",
         COALESCE(p.name, 'Unknown Product') as "productName",
         COALESCE(p.track_expiry, false) as "trackExpiry",
         gri.received_quantity as "receivedQuantity",
         gri.batch_number as "batchNumber",
         gri.expiry_date as "expiryDate",
         gri.cost_price as "unitCost",
         ${isBonusExpr} as "isBonus",
         COALESCE(poi.ordered_quantity, gri.received_quantity) as "orderedQuantity",
         ROUND(poi.unit_price::numeric, 2) as "poUnitPrice",
         ROUND(COALESCE(poi.received_quantity, 0)::numeric, 2) as "poGrossReceived",
         ROUND((${returnedSql})::numeric, 2) as "poReturnedQuantity",
         ROUND((${netSql})::numeric, 2) as "poAlreadyReceived"
       FROM goods_receipt_items gri
       LEFT JOIN products p ON gri.product_id = p.id
       LEFT JOIN purchase_order_items poi ON poi.id = gri.po_item_id
       WHERE gri.id = $1`,
      [itemId]
    );
    if (itemRes.rows.length === 0) return null;
    const item = itemRes.rows[0] as GoodsReceiptItem & { ordered_quantity?: number };
    // Fetch parent GR
    const grRes = await pool.query(
      `SELECT 
         id,
         receipt_number as "grNumber",
         purchase_order_id as "purchaseOrderId",
         received_date as "receivedDate",
         status,
         notes as "supplierDeliveryNote",
         received_by_id as "receivedBy",
         created_at as "createdAt",
         updated_at as "updatedAt"
       FROM goods_receipts WHERE id = $1`,
      [item.goodsReceiptId]
    );
    if (grRes.rows.length === 0) return null;
    const gr: GoodsReceipt = grRes.rows[0];
    return { item, gr };
  },

  /**
   * Update goods receipt item fields
   */
  async updateGRItem(
    pool: Pool | PoolClient,
    itemId: string,
    data: UpdateGRItemData
  ): Promise<GoodsReceiptItem> {
    const hasUomSnapshot = await tableHasColumn(pool, 'goods_receipt_items', 'base_qty');
    const hasTargetStore = await tableHasColumn(pool, 'goods_receipt_items', 'target_store_location_id');
    const rowSelect = buildGrItemRowSelectSql({ hasUomSnapshot, hasTargetStore });

    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (data.receivedQuantity !== undefined) {
      fields.push(`received_quantity = $${idx++}`);
      values.push(data.receivedQuantity);
    }
    if (data.unitCost !== undefined) {
      fields.push(`cost_price = $${idx++}`);
      values.push(data.unitCost);
    }
    if (data.batchNumber !== undefined) {
      fields.push(`batch_number = $${idx++}`);
      values.push(data.batchNumber);
    }
    if (data.isBonus !== undefined) {
      fields.push(`is_bonus = $${idx++}`);
      values.push(data.isBonus);
    }
    if (data.expiryDate !== undefined) {
      fields.push(`expiry_date = $${idx++}`);
      values.push(data.expiryDate);
    }
    if (data.uomId !== undefined) {
      fields.push(`uom_id = $${idx++}`);
      values.push(data.uomId);
    }
    if (hasUomSnapshot && data.baseQty !== undefined) {
      fields.push(`base_qty = $${idx++}`);
      values.push(data.baseQty);
    }
    if (hasUomSnapshot && data.baseUomId !== undefined) {
      fields.push(`base_uom_id = $${idx++}`);
      values.push(data.baseUomId);
    }
    if (hasUomSnapshot && data.conversionFactor !== undefined) {
      fields.push(`conversion_factor = $${idx++}`);
      values.push(data.conversionFactor);
    }
    if (hasTargetStore && data.targetStoreLocationId !== undefined) {
      fields.push(`target_store_location_id = $${idx++}`);
      values.push(data.targetStoreLocationId);
    }

    if (fields.length === 0) {
      // Nothing to update, return current row with aliases
      const current = await pool.query(
        `SELECT ${rowSelect}
         FROM goods_receipt_items WHERE id = $1`,
        [itemId]
      );
      if (current.rows.length === 0) throw new Error(`Goods receipt item ${itemId} not found`);
      return current.rows[0];
    }

    // Always bump version on GR item updates
    fields.push(`version = version + 1`);

    const result = await pool.query(
      `UPDATE goods_receipt_items
       SET ${fields.join(', ')}
       WHERE id = $${idx}
       RETURNING ${rowSelect}`,
      [...values, itemId]
    );

    if (result.rows.length === 0) {
      throw new Error(`Goods receipt item ${itemId} not found`);
    }

    return result.rows[0];
  },

  /**
   * List goods receipts
   */
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
      /** TO_INVOICE = completed GR with no supplier bill; INVOICED = bill linked; REVERSED = fully reversed */
      billingStatus?: 'TO_INVOICE' | 'INVOICED' | 'REVERSED';
      sortBy?: string;
      sortOrder?: 'asc' | 'desc';
    }
  ): Promise<{ grs: GoodsReceipt[]; total: number }> {
    const offset = (page - 1) * limit;
    const whereClauses: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (filters?.status) {
      whereClauses.push(`gr.status = $${paramIndex++}`);
      values.push(filters.status);
    }

    if (filters?.purchaseOrderId) {
      whereClauses.push(`gr.purchase_order_id = $${paramIndex++}`);
      values.push(filters.purchaseOrderId);
    }

    if (filters?.search) {
      const searchParam = `%${filters.search}%`;
      whereClauses.push(
        `(gr.receipt_number ILIKE $${paramIndex} OR po.order_number ILIKE $${paramIndex} OR s."CompanyName" ILIKE $${paramIndex})`
      );
      values.push(searchParam);
      paramIndex++;
    }

    if (filters?.startDate) {
      whereClauses.push(`gr.received_date::date >= $${paramIndex++}`);
      values.push(filters.startDate);
    }

    if (filters?.endDate) {
      whereClauses.push(`gr.received_date::date <= $${paramIndex++}`);
      values.push(filters.endDate);
    }

    const supplierBillExistsSql = `EXISTS (
      SELECT 1
      FROM supplier_invoices si
      WHERE si.document_type = 'SUPPLIER_INVOICE'
        AND si.deleted_at IS NULL
        AND COALESCE(si."Status",'') NOT IN ('Cancelled','CANCELLED','Voided','VOIDED')
        AND (
          si."Id" IN (
            SELECT sigl.invoice_id FROM supplier_invoice_grn_links sigl
            WHERE sigl.grn_id = gr.id
          )
          OR si."InternalReferenceNumber" = gr.receipt_number
        )
    )`;

    const fullyReversedSql = await grFullyReversedConditionSql(pool, 'gr');

    if (filters?.billingStatus === 'INVOICED') {
      whereClauses.push(`gr.status = 'COMPLETED'`);
      whereClauses.push(supplierBillExistsSql);
      whereClauses.push(`NOT (${fullyReversedSql})`);
    } else if (filters?.billingStatus === 'TO_INVOICE') {
      whereClauses.push(`gr.status = 'COMPLETED'`);
      whereClauses.push(`NOT (${supplierBillExistsSql})`);
      whereClauses.push(`NOT (${fullyReversedSql})`);
      // Empty opening-import shells have no lines — never treat as billable “To invoice”
      whereClauses.push(`EXISTS (
        SELECT 1 FROM goods_receipt_items gri0
        WHERE gri0.goods_receipt_id = gr.id
          AND COALESCE(gri0.received_quantity, 0) > 0
      )`);
    } else if (filters?.billingStatus === 'REVERSED') {
      whereClauses.push(`gr.status = 'COMPLETED'`);
      whereClauses.push(`(${fullyReversedSql})`);
    }

    const whereClause = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const supplierBillNumberSql = `(
      SELECT si."SupplierInvoiceNumber"
      FROM supplier_invoices si
      WHERE si.document_type = 'SUPPLIER_INVOICE'
        AND si.deleted_at IS NULL
        AND COALESCE(si."Status",'') NOT IN ('Cancelled','CANCELLED','Voided','VOIDED')
        AND (
          si."Id" IN (
            SELECT sigl.invoice_id FROM supplier_invoice_grn_links sigl
            WHERE sigl.grn_id = gr.id
          )
          OR si."InternalReferenceNumber" = gr.receipt_number
        )
      ORDER BY si."CreatedAt" DESC
      LIMIT 1
    )`;

    const countResult = await pool.query(
      `SELECT COUNT(*)
       FROM goods_receipts gr
       LEFT JOIN purchase_orders po ON gr.purchase_order_id = po.id
       LEFT JOIN suppliers s ON po.supplier_id = s."Id"
       ${whereClause}`,
      values
    );

    let orderBy: string;
    if (filters?.sortBy === 'invoiceStatus') {
      orderBy = `(CASE WHEN ${supplierBillExistsSql} THEN 1 ELSE 0 END) ${sqlSortOrder(filters.sortOrder ?? 'asc')}`;
    } else {
      const col = pickSortColumn(filters?.sortBy, GR_SORT_COLUMNS, 'receivedDate');
      orderBy = `${col} ${sqlSortOrder(filters?.sortOrder ?? 'desc')}`;
    }

    const reversalSql = await grReversalSelectSql(pool, fullyReversedSql);
    const result = await pool.query(
      `SELECT 
         gr.id,
         gr.receipt_number as "grNumber",
         gr.purchase_order_id as "purchaseOrderId",
         gr.received_date as "receivedDate",
         gr.status,
         gr.notes as "supplierDeliveryNote",
         gr.received_by_id as "receivedBy",
         COALESCE(u.full_name, u.email) as "receivedByName",
         gr.created_at as "createdAt",
         gr.updated_at as "updatedAt",
         gr.version,
         po.order_number AS "poNumber",
         po.status AS "poStatus",
         COALESCE(po.manual_receipt, false) AS "poManualReceipt",
         po.supplier_id as "supplierId",
         s."CompanyName" as "supplierName",
         ${reversalSql},
         ${supplierBillNumberSql} AS "supplierBillNumber",
         CASE
           WHEN gr.status = 'DRAFT' THEN 'DRAFT_GR'
           WHEN gr.status = 'CANCELLED' THEN 'CANCELLED'
           WHEN ${fullyReversedSql} THEN 'REVERSED'
           WHEN ${supplierBillNumberSql} IS NOT NULL THEN 'INVOICED'
           WHEN gr.status = 'COMPLETED' THEN 'TO_INVOICE'
           ELSE 'NOT_APPLICABLE'
         END AS "billingStatus"
       FROM goods_receipts gr
       LEFT JOIN purchase_orders po ON gr.purchase_order_id = po.id
       LEFT JOIN suppliers s ON po.supplier_id = s."Id"
       LEFT JOIN users u ON u.id = gr.received_by_id
       ${whereClause} 
       ORDER BY ${orderBy}, gr.created_at DESC 
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...values, limit, offset]
    );

    return {
      grs: result.rows,
      total: parseInt(countResult.rows[0].count),
    };
  },

  /**
   * Find the newest DRAFT goods receipt for a purchase order (Odoo open picking pattern).
   */
  async findDraftGRByPurchaseOrderId(
    pool: Pool | PoolClient,
    purchaseOrderId: string
  ): Promise<GoodsReceipt | null> {
    const result = await pool.query(
      `SELECT 
         id,
         receipt_number as "grNumber",
         purchase_order_id as "purchaseOrderId",
         received_date as "receivedDate",
         status,
         notes as "supplierDeliveryNote",
         received_by_id as "receivedBy",
         created_at as "createdAt",
         updated_at as "updatedAt"
       FROM goods_receipts
       WHERE purchase_order_id = $1 AND status = 'DRAFT'
       ORDER BY created_at DESC
       LIMIT 1`,
      [purchaseOrderId]
    );
    return result.rows[0] ?? null;
  },

  /**
   * Count goods receipts for a PO in a given status.
   */
  async countGRsByPOAndStatus(
    pool: Pool | PoolClient,
    purchaseOrderId: string,
    status: GoodsReceipt['status']
  ): Promise<number> {
    const result = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM goods_receipts
       WHERE purchase_order_id = $1 AND status = $2`,
      [purchaseOrderId, status]
    );
    return Number(result.rows[0]?.count ?? 0);
  },

  /**
   * GRs that still block PO delete/cancel: open drafts or completed receipts not fully reversed.
   * Cancelled + fully reversed GRs are audit-only and do not block closing a Draft PO.
   */
  async countActiveGoodsReceiptsBlockingPoClose(
    pool: Pool | PoolClient,
    purchaseOrderId: string,
  ): Promise<number> {
    const fullyReversedSql = await grFullyReversedConditionSql(pool, 'gr');
    const result = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM goods_receipts gr
       WHERE gr.purchase_order_id = $1
         AND gr.status <> 'CANCELLED'
         AND NOT (${fullyReversedSql})`,
      [purchaseOrderId],
    );
    return Number(result.rows[0]?.count ?? 0);
  },

  /**
   * Cancel all DRAFT goods receipts linked to a purchase order (no stock impact).
   */
  async cancelDraftGRsForPurchaseOrder(
    pool: Pool | PoolClient,
    purchaseOrderId: string
  ): Promise<string[]> {
    const result = await pool.query(
      `UPDATE goods_receipts
       SET status = 'CANCELLED',
           version = version + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE purchase_order_id = $1 AND status = 'DRAFT'
       RETURNING id, receipt_number as "grNumber"`,
      [purchaseOrderId]
    );
    return result.rows.map((r: { id: string }) => r.id);
  },

  /**
   * Cancel a single DRAFT goods receipt.
   */
  async cancelGR(pool: Pool | PoolClient, id: string): Promise<GoodsReceipt> {
    const result = await pool.query(
      `UPDATE goods_receipts
       SET status = 'CANCELLED',
           version = version + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND status = 'DRAFT'
       RETURNING 
         id,
         receipt_number as "grNumber",
         purchase_order_id as "purchaseOrderId",
         received_date as "receivedDate",
         status,
         notes as "supplierDeliveryNote",
         received_by_id as "receivedBy",
         created_at as "createdAt",
         updated_at as "updatedAt",
         version`,
      [id]
    );

    if (result.rows.length === 0) {
      throw new Error(
        'Goods receipt not found or cannot be cancelled (only DRAFT receipts can be cancelled)'
      );
    }

    return result.rows[0];
  },

  /**
   * Finalize goods receipt
   * Accepts Pool or PoolClient to participate in caller's transaction.
   */
  async finalizeGR(pool: Pool | PoolClient, id: string): Promise<GoodsReceipt> {
    const result = await pool.query(
      `UPDATE goods_receipts 
       SET status = $1,
           version = version + 1,
           total_value = (
             SELECT COALESCE(SUM(received_quantity * cost_price), 0)
             FROM goods_receipt_items
             WHERE goods_receipt_id = $2
           ),
           updated_at = CURRENT_TIMESTAMP 
       WHERE id = $2 
       RETURNING 
         id,
         receipt_number as "grNumber",
         purchase_order_id as "purchaseOrderId",
         received_date as "receivedDate",
         status,
         notes as "supplierDeliveryNote",
         received_by_id as "receivedBy",
         created_at as "createdAt",
         updated_at as "updatedAt",
         version`,
      ['COMPLETED', id]
    );

    if (result.rows.length === 0) {
      throw new Error(`Goods receipt ${id} not found`);
    }

    return result.rows[0];
  },

  /**
   * Update PO item received quantity
   * Accepts Pool or PoolClient to participate in caller's transaction.
   */
  async updatePOItemReceivedQuantity(
    pool: Pool | PoolClient,
    poItemId: string,
    additionalQuantity: number
  ): Promise<void> {
    logger.info('Executing updatePOItemReceivedQuantity', {
      poItemId,
      additionalQuantity,
    });
    const result = await pool.query(
      'UPDATE purchase_order_items SET received_quantity = received_quantity + $1 WHERE id = $2',
      [additionalQuantity, poItemId]
    );
    logger.info('PO item update query executed', {
      poItemId,
      rowsAffected: result.rowCount,
    });
  },

  /**
   * Check if PO is fully received
   */
  async isPOFullyReceived(pool: Pool | PoolClient, poId: string): Promise<boolean> {
    const netSql = poItemNetReceivedQuantitySql('poi');
    const result = await pool.query(
      `SELECT 
         COUNT(*) FILTER (
           WHERE COALESCE(poi.ordered_quantity, 0)::numeric > (${netSql})::numeric
         ) as pending_items
       FROM purchase_order_items poi
       WHERE poi.purchase_order_id = $1`,
      [poId]
    );

    return parseInt(result.rows[0].pending_items) === 0;
  },

  /**
   * Link a posted Return GRN as the counter-document that reversed this receipt.
   * Requires migration 522 + session flag to bypass COMPLETED immutability trigger.
   */
  async setReversalMetadata(
    pool: Pool | PoolClient,
    grId: string,
    data: {
      reversedByReturnGrnId: string;
      reversalReason: string;
      reversedByUserId: string;
    },
  ): Promise<void> {
    const has = await tableHasColumn(pool, 'goods_receipts', 'reversed_by_return_grn_id');
    if (!has) {
      throw new Error('Reversal metadata columns are not installed — run migration 522_gr_reversal_metadata.sql');
    }

    await pool.query(`SET LOCAL app.allow_gr_reversal_metadata = 'true'`);
    const result = await pool.query(
      `UPDATE goods_receipts
       SET reversed_by_return_grn_id = $1,
           reversal_timestamp = CURRENT_TIMESTAMP,
           reversal_reason = $2,
           reversed_by_user_id = $3,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $4
         AND status = 'COMPLETED'
         AND reversed_by_return_grn_id IS NULL`,
      [data.reversedByReturnGrnId, data.reversalReason, data.reversedByUserId, grId],
    );

    if ((result.rowCount ?? 0) === 0) {
      throw new Error('Could not set reversal metadata — receipt may already be reversed or is not COMPLETED');
    }
  },
};
