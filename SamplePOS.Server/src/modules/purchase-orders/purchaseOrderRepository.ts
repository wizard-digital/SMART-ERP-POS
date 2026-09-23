import { Pool, PoolClient } from 'pg';
import Decimal from 'decimal.js';
import { UnitOfWork } from '../../db/unitOfWork.js';
import { assertRowUpdated } from '../../utils/optimisticUpdate.js';
import { getBusinessYear } from '../../utils/dateRange.js';
import { tableHasColumn } from '../../db/schemaColumnCache.js';
import { pickSortColumn, sqlSortOrder } from '../../utils/enterpriseListQuery.js';
import { PricingEngine } from '../../utils/pricingEngine.js';
import {
  poItemNetReceivedQuantitySql,
  poItemOpenQuantitySql,
  poItemReturnedQuantitySql,
  poOrderedQtyTotalSql,
  poNetReceivedQtyTotalSql,
  poOpenQtyTotalSql,
  poCompletedGrCountSql,
} from './purchaseOrderNetReceived.js';

const PO_SORT_COLUMNS: Record<string, string> = {
  poNumber: 'po.order_number',
  supplier: 's."CompanyName"',
  orderDate: 'po.order_date',
  expectedDelivery: 'po.expected_delivery_date',
  status: 'po.status',
  totalAmount: 'po.total_amount',
};

export interface PurchaseOrder {
  id: string;
  poNumber: string;
  supplierId: string;
  /** Present on get/list joins with suppliers.CompanyName */
  supplierName?: string;
  orderDate: string;
  expectedDate: string | null;
  status: 'DRAFT' | 'PENDING' | 'COMPLETED' | 'CANCELLED';
  totalAmount: number;
  notes: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** Auto-generated tracking PO from Manual GR (may be COMPLETED before GR finalize). */
  manualReceipt?: boolean;
  /** Receipt progress (list/detail aggregates). */
  orderedQtyTotal?: number;
  netReceivedQtyTotal?: number;
  openQtyTotal?: number;
  completedGrCount?: number;
}

export interface PurchaseOrderItem {
  id: string;
  purchaseOrderId: string;
  productId: string;
  productName: string;
  quantity: number;
  unitCost: number;
  lineTotal: number;
  receivedQuantity: number;
  /** Posted supplier returns against receipts on this PO line (purchase UoM). */
  returnedQuantity?: number;
  /** receivedQuantity − returnedQuantity (open receipt uses this, not gross). */
  netReceivedQuantity?: number;
  openQuantity?: number;
  uomId?: string | null;
  uomName?: string | null;
}

export interface CreatePOData {
  supplierId: string;
  orderDate: string;
  expectedDate: string | null;
  notes: string | null;
  createdBy: string;
}

export interface CreatePOItemData {
  purchaseOrderId: string;
  productId: string;
  productName: string;
  quantity: number;
  unitCost: number;
  lineTotal?: number; // Ignored for persistence — PE(qty×unit) is SSOT
  uomId?: string | null;
  baseQty?: number | null; // SAP UoM snapshot: quantity in base unit
  baseUomId?: string | null; // SAP UoM snapshot: base UoM ID at posting time
  conversionFactor?: number; // SAP UoM snapshot: conversion factor at posting time
}

type DbRow = Record<string, unknown>;

function mapPurchaseOrderRow(row: DbRow): PurchaseOrder {
  return {
    id: row.id as string,
    poNumber: (row.poNumber ?? row.order_number) as string,
    supplierId: (row.supplierId ?? row.supplier_id) as string,
    supplierName: (row.supplierName ?? row.supplier_name ?? undefined) as string | undefined,
    orderDate: String(row.orderDate ?? row.order_date ?? ''),
    expectedDate: (row.expectedDate ?? row.expected_delivery_date ?? null) as string | null,
    status: row.status as PurchaseOrder['status'],
    totalAmount: Number(row.totalAmount ?? row.total_amount ?? 0),
    notes: (row.notes ?? null) as string | null,
    createdBy: (row.createdBy ?? row.created_by_id) as string,
    createdAt: String(row.createdAt ?? row.created_at ?? ''),
    updatedAt: String(row.updatedAt ?? row.updated_at ?? ''),
    manualReceipt: Boolean(row.manualReceipt ?? row.manual_receipt ?? false),
    orderedQtyTotal:
      row.orderedQtyTotal != null
        ? Number(row.orderedQtyTotal)
        : row.ordered_qty_total != null
          ? Number(row.ordered_qty_total)
          : undefined,
    netReceivedQtyTotal:
      row.netReceivedQtyTotal != null
        ? Number(row.netReceivedQtyTotal)
        : row.net_received_qty_total != null
          ? Number(row.net_received_qty_total)
          : undefined,
    openQtyTotal:
      row.openQtyTotal != null
        ? Number(row.openQtyTotal)
        : row.open_qty_total != null
          ? Number(row.open_qty_total)
          : undefined,
    completedGrCount:
      row.completedGrCount != null
        ? Number(row.completedGrCount)
        : row.completed_gr_count != null
          ? Number(row.completed_gr_count)
          : undefined,
  };
}

function mapPurchaseOrderItemRow(row: DbRow): PurchaseOrderItem {
  return {
    id: row.id as string,
    purchaseOrderId: (row.purchaseOrderId ?? row.purchase_order_id) as string,
    productId: (row.productId ?? row.product_id) as string,
    productName: (row.productName ?? row.product_name ?? 'Unknown Product') as string,
    quantity: Number(row.quantity ?? row.ordered_quantity ?? 0),
    unitCost: Number(row.unitCost ?? row.unit_price ?? 0),
    lineTotal: Number(row.lineTotal ?? row.total_price ?? 0),
    receivedQuantity: Number(
      row.receivedQuantity ?? row.gross_received_quantity ?? row.received_quantity ?? 0,
    ),
    returnedQuantity:
      row.returnedQuantity != null
        ? Number(row.returnedQuantity)
        : row.returned_quantity != null
          ? Number(row.returned_quantity)
          : undefined,
    netReceivedQuantity:
      row.netReceivedQuantity != null
        ? Number(row.netReceivedQuantity)
        : row.net_received_quantity != null
          ? Number(row.net_received_quantity)
          : undefined,
    openQuantity:
      row.openQuantity != null
        ? Number(row.openQuantity)
        : row.open_quantity != null
          ? Number(row.open_quantity)
          : undefined,
    uomId: (row.uomId ?? row.uom_id ?? null) as string | null,
    uomName: (row.uomName ?? row.uom_name ?? null) as string | null,
  };
}

export const purchaseOrderRepository = {
  /**
   * Generate next PO number (PO-YYYY-NNNN format)
   */
  async generatePONumber(pool: Pool | PoolClient): Promise<string> {
    const year = getBusinessYear();
    // Advisory lock prevents concurrent duplicate PO number generation (held until TX commit)
    await pool.query(`SELECT pg_advisory_xact_lock(hashtext('po_number_seq'))`);
    const result = await pool.query(
      `SELECT order_number FROM purchase_orders 
       WHERE order_number LIKE $1 
       ORDER BY order_number DESC 
       LIMIT 1`,
      [`PO-${year}-%`]
    );

    if (result.rows.length === 0) {
      return `PO-${year}-0001`;
    }

    const lastNumber = result.rows[0].order_number;
    const sequence = parseInt(lastNumber.split('-')[2]) + 1;
    return `PO-${year}-${sequence.toString().padStart(4, '0')}`;
  },

  /**
   * Create purchase order
   */
  async createPO(pool: Pool | PoolClient, data: CreatePOData): Promise<PurchaseOrder> {
    const poNumber = await this.generatePONumber(pool);

    const result = await pool.query(
      `INSERT INTO purchase_orders (
        order_number, supplier_id, order_date, expected_delivery_date, notes, created_by_id
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *`,
      [poNumber, data.supplierId, data.orderDate, data.expectedDate, data.notes, data.createdBy]
    );

    return mapPurchaseOrderRow(result.rows[0]);
  },

  /**
   * Create manual PO (auto-generated from manual goods receipt).
   * PO is PENDING + manual_receipt until the GR is finalized (then sync → COMPLETED).
   * Never pretends goods are posted before Finalize.
   */
  async createManualPO(
    pool: Pool | PoolClient,
    data: CreatePOData & { items: CreatePOItemData[] }
  ): Promise<{ po: PurchaseOrder; items: PurchaseOrderItem[] }> {
    const poNumber = await this.generatePONumber(pool);

    // Calculate total amount from items (PricingEngine SSOT)
    const totalAmount = PricingEngine.calculateDocumentTotal(
      data.items.map((item) => ({ quantity: item.quantity, unitCost: item.unitCost })),
    ).toNumber();

    // PENDING: open for Finalize; COMPLETED only after GR posts (syncPOStatusWithReceipts)
    const poResult = await pool.query(
      `INSERT INTO purchase_orders (
        order_number, supplier_id, order_date, expected_delivery_date, 
        notes, created_by_id, status, total_amount, manual_receipt
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING 
        id,
        order_number as "poNumber",
        supplier_id as "supplierId",
        order_date as "orderDate",
        expected_delivery_date as "expectedDate",
        status,
        total_amount as "totalAmount",
        notes,
        created_by_id as "createdBy",
        manual_receipt as "manualReceipt",
        created_at as "createdAt",
        updated_at as "updatedAt"`,
      [
        poNumber,
        data.supplierId,
        data.orderDate,
        data.expectedDate,
        data.notes || `Auto-generated PO for manual goods receipt`,
        data.createdBy,
        'PENDING',
        totalAmount,
        true, // Flag as manual receipt
      ]
    );

    const po = poResult.rows[0];

    // Add PO items
    const itemsWithPOId = data.items.map((item) => ({
      ...item,
      purchaseOrderId: po.id,
    }));

    const items = await this.addPOItems(pool, itemsWithPOId);

    return { po, items };
  },

  /**
   * Add items to purchase order
   */
  async addPOItems(pool: Pool | PoolClient, items: CreatePOItemData[]): Promise<PurchaseOrderItem[]> {
    if (items.length === 0) return [];

    const hasUomSnapshot = await tableHasColumn(pool, 'purchase_order_items', 'base_qty');
    const values: unknown[] = [];
    const placeholders: string[] = [];
    const fieldsPerRow = hasUomSnapshot ? 9 : 6;

    items.forEach((item, index) => {
      const offset = index * fieldsPerRow;
      // SSOT: persist PricingEngine line total from qty × unit (ignore divergent client totals)
      const lineTotal = PricingEngine.calculateLineTotal(item.quantity, item.unitCost).toNumber();

      if (hasUomSnapshot) {
        placeholders.push(
          `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9})`
        );
        values.push(
          item.purchaseOrderId,
          item.productId,
          item.quantity,
          item.unitCost,
          lineTotal,
          item.uomId || null,
          item.baseQty ?? null,
          item.baseUomId ?? null,
          item.conversionFactor ?? 1
        );
      } else {
        placeholders.push(
          `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6})`
        );
        values.push(
          item.purchaseOrderId,
          item.productId,
          item.quantity,
          item.unitCost,
          lineTotal,
          item.uomId || null
        );
      }
    });

    const insertColumns = hasUomSnapshot
      ? `purchase_order_id, product_id, ordered_quantity, unit_price, total_price, uom_id, base_qty, base_uom_id, conversion_factor`
      : `purchase_order_id, product_id, ordered_quantity, unit_price, total_price, uom_id`;

    const result = await pool.query(
      `INSERT INTO purchase_order_items (${insertColumns})
      VALUES ${placeholders.join(', ')}
      RETURNING *`,
      values
    );

    return result.rows;
  },

  /**
   * Get PO by ID with items
   */
  async getPOById(
    pool: Pool | PoolClient,
    id: string
  ): Promise<{ po: PurchaseOrder; items: PurchaseOrderItem[] } | null> {
    const poResult = await pool.query(
      `SELECT po.*, s."CompanyName" as supplier_name,
              ROUND((${poOrderedQtyTotalSql('po')})::numeric, 4) AS ordered_qty_total,
              ROUND((${poNetReceivedQtyTotalSql('po')})::numeric, 4) AS net_received_qty_total,
              ROUND((${poOpenQtyTotalSql('po')})::numeric, 4) AS open_qty_total,
              ${poCompletedGrCountSql('po')} AS completed_gr_count
       FROM purchase_orders po
       JOIN suppliers s ON po.supplier_id = s."Id"
       WHERE po.id = $1`,
      [id]
    );

    if (poResult.rows.length === 0) {
      return null;
    }

    const returnedSql = poItemReturnedQuantitySql('poi');
    const netSql = poItemNetReceivedQuantitySql('poi');
    const openSql = poItemOpenQuantitySql('poi');

    const itemsResult = await pool.query(
      `SELECT 
         poi.*,
         p.name as product_name,
         COALESCE(u.name, def_u.name) as uom_name,
         COALESCE(pu.conversion_factor, 1)::numeric as conversion_factor,
         COALESCE(pv.cost_price, 0)::numeric as product_cost_price,
         ROUND(COALESCE(poi.received_quantity, 0)::numeric, 4) AS gross_received_quantity,
         ROUND((${returnedSql})::numeric, 4) AS returned_quantity,
         ROUND((${netSql})::numeric, 4) AS net_received_quantity,
         ROUND((${openSql})::numeric, 4) AS open_quantity
       FROM purchase_order_items poi
       JOIN products p ON poi.product_id = p.id
       LEFT JOIN uoms u ON poi.uom_id = u.id
       LEFT JOIN product_uoms pu ON pu.product_id = p.id AND pu.uom_id = poi.uom_id
       LEFT JOIN product_uoms def_pu ON def_pu.product_id = p.id AND def_pu.is_default = true
       LEFT JOIN uoms def_u ON def_u.id = def_pu.uom_id
       LEFT JOIN product_valuation pv ON pv.product_id = p.id
       WHERE poi.purchase_order_id = $1 
       ORDER BY poi.created_at`,
      [id]
    );

    return {
      po: mapPurchaseOrderRow(poResult.rows[0]),
      items: itemsResult.rows.map(mapPurchaseOrderItemRow),
    };
  },

  /**
   * List purchase orders with pagination
   */
  async listPOs(
    pool: Pool | PoolClient,
    page: number = 1,
    limit: number = 50,
    filters?: {
      status?: string;
      supplierId?: string;
      search?: string;
      sortBy?: string;
      sortOrder?: 'asc' | 'desc';
    }
  ): Promise<{ pos: PurchaseOrder[]; total: number }> {
    const offset = (page - 1) * limit;
    const whereClauses: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (filters?.status) {
      whereClauses.push(`po.status = $${paramIndex++}`);
      values.push(filters.status);

      // PENDING + open receipt qty (first delivery or re-receive after return).
      if (filters.status === 'PENDING') {
        const openSql = poItemOpenQuantitySql('poi');
        whereClauses.push(`EXISTS (
          SELECT 1 FROM purchase_order_items poi
          WHERE poi.purchase_order_id = po.id
            AND (${openSql})::numeric > 0.0001
        )`);
      }
    }

    if (filters?.supplierId) {
      whereClauses.push(`po.supplier_id = $${paramIndex++}`);
      values.push(filters.supplierId);
    }

    const search = filters?.search?.trim();
    if (search) {
      const searchParam = `%${search}%`;
      whereClauses.push(
        `(po.order_number ILIKE $${paramIndex}
          OR s."CompanyName" ILIKE $${paramIndex}
          OR COALESCE(s."SupplierCode", '') ILIKE $${paramIndex})`,
      );
      values.push(searchParam);
      paramIndex++;
    }

    // Default list hides cancelled POs; pass status=CANCELLED to audit voided orders.
    if (!filters?.status) {
      whereClauses.push(`po.status <> 'CANCELLED'`);
    }

    const whereClause = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
    const fromSql = `FROM purchase_orders po
       JOIN suppliers s ON po.supplier_id = s."Id"`;

    const countResult = await pool.query(
      `SELECT COUNT(*) ${fromSql} ${whereClause}`,
      values,
    );

    const orderCol = pickSortColumn(filters?.sortBy, PO_SORT_COLUMNS, 'orderDate');
    const orderDir = sqlSortOrder(filters?.sortOrder ?? (filters?.sortBy ? 'asc' : 'desc'));

    const result = await pool.query(
      `SELECT po.*, s."CompanyName" as supplier_name,
              ROUND((${poOrderedQtyTotalSql('po')})::numeric, 4) AS ordered_qty_total,
              ROUND((${poNetReceivedQtyTotalSql('po')})::numeric, 4) AS net_received_qty_total,
              ROUND((${poOpenQtyTotalSql('po')})::numeric, 4) AS open_qty_total,
              ${poCompletedGrCountSql('po')} AS completed_gr_count
       ${fromSql}
       ${whereClause} 
       ORDER BY ${orderCol} ${orderDir}, po.created_at DESC 
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...values, limit, offset],
    );

    return {
      pos: result.rows.map(mapPurchaseOrderRow),
      total: parseInt(countResult.rows[0].count),
    };
  },

  /** True when any PO line has open receipt qty (ordered − net received > 0). */
  async hasOpenReceiptQuantity(pool: Pool | PoolClient, poId: string): Promise<boolean> {
    const openSql = poItemOpenQuantitySql('poi');
    const result = await pool.query(
      `SELECT EXISTS (
         SELECT 1 FROM purchase_order_items poi
         WHERE poi.purchase_order_id = $1 AND (${openSql})::numeric > 0.0001
       ) AS has_open`,
      [poId],
    );
    return result.rows[0]?.has_open === true;
  },

  /**
   * Update PO status
   */
  async updatePOStatus(pool: Pool | PoolClient, id: string, status: string): Promise<PurchaseOrder> {
    const result = await pool.query(
      'UPDATE purchase_orders SET status = $1, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *',
      [status, id]
    );

    if (result.rows.length === 0) {
      throw new Error(`Purchase order ${id} not found`);
    }

    return mapPurchaseOrderRow(result.rows[0]);
  },

  /**
   * Update PO total amount — sum of PricingEngine line totals; heal line total_price too.
   */
  async updatePOTotal(pool: Pool | PoolClient, id: string): Promise<void> {
    const lines = await pool.query<{
      id: string;
      ordered_quantity: string;
      unit_price: string;
    }>(
      `SELECT id, ordered_quantity::text, unit_price::text
       FROM purchase_order_items
       WHERE purchase_order_id = $1`,
      [id],
    );

    for (const row of lines.rows) {
      const lineTotal = PricingEngine.calculateLineTotal(
        row.ordered_quantity,
        row.unit_price,
      ).toNumber();
      await pool.query(
        `UPDATE purchase_order_items SET total_price = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [lineTotal, row.id],
      );
    }

    const totalAmount = PricingEngine.calculateDocumentTotal(
      lines.rows.map((r) => ({ quantity: r.ordered_quantity, unitCost: r.unit_price })),
    ).toNumber();

    await pool.query(
      `UPDATE purchase_orders
       SET total_amount = $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [totalAmount, id],
    );
  },

  /**
   * Blockers for changing PO supplier before any receipt or supplier invoice.
   * Returns human-readable reason, or null when change is allowed.
   */
  async getPOSupplierChangeBlocker(
    pool: Pool | PoolClient,
    poId: string
  ): Promise<string | null> {
    const poRes = await pool.query(
      `SELECT status FROM purchase_orders WHERE id = $1`,
      [poId]
    );
    if (poRes.rows.length === 0) return 'Purchase order not found';
    const status = poRes.rows[0].status as string;
    if (!['DRAFT', 'PENDING'].includes(status)) {
      return `Purchase order is ${status}. Supplier can only be changed while DRAFT or PENDING (before receipt).`;
    }

    const netSql = poItemNetReceivedQuantitySql('poi');
    const receivedRes = await pool.query(
      `SELECT COUNT(*)::int AS cnt
       FROM purchase_order_items poi
       WHERE poi.purchase_order_id = $1
         AND (${netSql})::numeric > 0.0001`,
      [poId]
    );
    if ((receivedRes.rows[0]?.cnt ?? 0) > 0) {
      return 'Goods have already been received on this PO. Use Return to supplier for corrections.';
    }

    // Net 0 after reverse: manage as draft. Still block if an active supplier bill remains.
    const invoiceRes = await pool.query(
      `SELECT si."SupplierInvoiceNumber" AS invoice_number
       FROM supplier_invoices si
       JOIN supplier_invoice_grn_links sigl ON sigl.invoice_id = si."Id"
       JOIN goods_receipts gr ON gr.id = sigl.grn_id
       WHERE gr.purchase_order_id = $1
         AND si.deleted_at IS NULL
         AND COALESCE(si."Status", '') NOT IN ('Cancelled', 'CANCELLED', 'Voided', 'VOIDED')
       LIMIT 1`,
      [poId]
    );
    if (invoiceRes.rows.length > 0) {
      const invNo = invoiceRes.rows[0].invoice_number || 'supplier invoice';
      return `Supplier invoice ${invNo} exists for this PO. Cancel or reverse the invoice before changing supplier.`;
    }

    return null;
  },

  /**
   * Update PO header fields (DRAFT or PENDING when allowed)
   */
  async updatePOHeader(
    pool: Pool | PoolClient,
    id: string,
    data: { supplierId?: string; expectedDate?: string | null; notes?: string | null },
    allowedStatuses: string[] = ['DRAFT']
  ): Promise<PurchaseOrder> {
    const setClauses: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (data.supplierId !== undefined) {
      setClauses.push(`supplier_id = $${paramIndex++}`);
      values.push(data.supplierId);
    }
    if (data.expectedDate !== undefined) {
      setClauses.push(`expected_delivery_date = $${paramIndex++}`);
      values.push(data.expectedDate);
    }
    if (data.notes !== undefined) {
      setClauses.push(`notes = $${paramIndex++}`);
      values.push(data.notes);
    }

    if (setClauses.length === 0) {
      throw new Error('No fields to update');
    }

    setClauses.push(`version = version + 1`);
    setClauses.push(`updated_at = CURRENT_TIMESTAMP`);

    const idParam = paramIndex++;
    const statusParam = paramIndex;
    values.push(id, allowedStatuses);

    const result = await pool.query(
      `UPDATE purchase_orders 
       SET ${setClauses.join(', ')} 
       WHERE id = $${idParam} AND status::text = ANY($${statusParam}::text[])
       RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      throw new Error(
        `Purchase order ${id} not found or status does not allow this update (${allowedStatuses.join(', ')})`
      );
    }

    return mapPurchaseOrderRow(result.rows[0]);
  },

  /**
   * Update a single PO item
   */
  async updatePOItem(
    pool: Pool | PoolClient,
    itemId: string,
    poId: string,
    data: { quantity?: number; unitCost?: number; uomId?: string | null }
  ): Promise<PurchaseOrderItem> {
    const setClauses: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (data.quantity !== undefined) {
      setClauses.push(`ordered_quantity = $${paramIndex++}`);
      values.push(data.quantity);
    }
    if (data.unitCost !== undefined) {
      setClauses.push(`unit_price = $${paramIndex++}`);
      values.push(data.unitCost);
    }
    if (data.uomId !== undefined) {
      setClauses.push(`uom_id = $${paramIndex++}`);
      values.push(data.uomId);
    }

    if (setClauses.length === 0) {
      throw new Error('No fields to update');
    }

    // Recalculate total_price if quantity or unitCost changed (PricingEngine SSOT)
    if (data.quantity !== undefined || data.unitCost !== undefined) {
      const current = await pool.query<{ ordered_quantity: string; unit_price: string }>(
        `SELECT ordered_quantity::text, unit_price::text FROM purchase_order_items WHERE id = $1`,
        [itemId],
      );
      const qty = data.quantity ?? Number(current.rows[0]?.ordered_quantity ?? 0);
      const unit = data.unitCost ?? Number(current.rows[0]?.unit_price ?? 0);
      const lineTotal = PricingEngine.calculateLineTotal(qty, unit).toNumber();
      setClauses.push(`total_price = $${paramIndex++}`);
      values.push(lineTotal);
    }

    const result = await pool.query(
      `UPDATE purchase_order_items 
       SET ${setClauses.join(', ')} 
       WHERE id = $${paramIndex} AND purchase_order_id = $${paramIndex + 1}
       RETURNING *`,
      [...values, itemId, poId]
    );

    if (result.rows.length === 0) {
      throw new Error(`PO item ${itemId} not found for purchase order ${poId}`);
    }

    return mapPurchaseOrderItemRow(result.rows[0]);
  },

  /**
   * Remove a PO item (DRAFT only — verified at service layer)
   */
  async removePOItem(pool: Pool | PoolClient, itemId: string, poId: string): Promise<void> {
    const result = await pool.query(
      `DELETE FROM purchase_order_items WHERE id = $1 AND purchase_order_id = $2`,
      [itemId, poId]
    );

    if (result.rowCount === 0) {
      throw new Error(`PO item ${itemId} not found for purchase order ${poId}`);
    }
  },

  /**
   * Delete PO (only if DRAFT). Soft-cancels the PO.
   * Fully reversed / cancelled GRs are audit history and do not block —
   * otherwise Draft-after-reverse POs could neither Delete nor Cancel.
   */
  async deletePO(pool: Pool, id: string): Promise<void> {
    await UnitOfWork.run(pool, async (client) => {
      const { goodsReceiptRepository } = await import(
        '../goods-receipts/goodsReceiptRepository.js'
      );
      await goodsReceiptRepository.cancelDraftGRsForPurchaseOrder(client, id);

      const blocking = await goodsReceiptRepository.countActiveGoodsReceiptsBlockingPoClose(
        client,
        id,
      );
      if (blocking > 0) {
        throw new Error(
          'Cannot delete purchase order: it still has open or posted (not reversed) goods receipts. Reverse or cancel those receipts first.',
        );
      }

      // Soft delete: Update status to CANCELLED instead of hard delete
      // This preserves the record for audit trail while marking it as deleted
      const result = await client.query(
        `UPDATE purchase_orders 
         SET status = 'CANCELLED', updated_at = NOW() 
         WHERE id = $1 AND status = $2`,
        [id, 'DRAFT']
      );

      if (result.rowCount === 0) {
        throw new Error('Can only delete purchase orders in DRAFT status');
      }

      // Note: PO items are preserved for audit trail since the PO still exists
    });
  },

  /**
   * Hard-delete a CANCELLED purchase order and all its items.
   * Only allowed when status = 'CANCELLED' and no goods receipts exist.
   */
  async purgeCancelledPO(pool: Pool, id: string): Promise<void> {
    await UnitOfWork.run(pool, async (client) => {
      // Verify PO exists and is CANCELLED
      const poCheck = await client.query(
        `SELECT id, status FROM purchase_orders WHERE id = $1`,
        [id]
      );

      if (poCheck.rowCount === 0) {
        throw new Error(`Purchase order ${id} not found`);
      }

      if (poCheck.rows[0].status !== 'CANCELLED') {
        throw new Error('Can only permanently delete CANCELLED purchase orders');
      }

      // Block if any goods receipts were ever created against this PO
      const grCheck = await client.query(
        'SELECT COUNT(*) FROM goods_receipts WHERE purchase_order_id = $1',
        [id]
      );

      if (parseInt(grCheck.rows[0].count) > 0) {
        throw new Error('Cannot delete purchase order that has goods receipts attached');
      }

      // Hard delete items first (FK constraint), then the PO
      await client.query(
        'DELETE FROM purchase_order_items WHERE purchase_order_id = $1',
        [id]
      );

      await client.query(
        'DELETE FROM purchase_orders WHERE id = $1',
        [id]
      );
    });
  },
};
