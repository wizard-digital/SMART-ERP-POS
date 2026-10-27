import { Pool, PoolClient } from 'pg';
import Decimal from 'decimal.js';
import { Money } from '../../utils/money.js';
import { BusinessError } from '../../middleware/errorHandler.js';
import { checkAccountingPeriodOpen } from '../../utils/periodGuard.js';
import { getBusinessDate, getBusinessYear } from '../../utils/dateRange.js';
import { pickSortColumn, sqlSortOrder } from '../../utils/enterpriseListQuery.js';
import { allocateNextPrefixedDocumentNumber } from '../../utils/documentNumberAllocation.js';

const SALES_SORT_COLUMNS: Record<string, string> = {
  saleNumber: 's.sale_number',
  date: 's.sale_date',
  customer: 'c.name',
  amount: 's.total_amount',
  profit: 's.profit',
  payment: 's.payment_method',
  status: 's.status',
};

export interface SaleRecord {
  id: string;
  saleNumber: string;
  customerId: string | null;
  customerName: string | null;
  subtotal?: number;
  taxAmount?: number;
  discountAmount?: number;
  totalAmount: number;
  totalCost?: number;
  profit?: number;
  profitMargin?: number;
  paymentMethod: string;
  paymentReceived: number;
  amountPaid?: number;
  changeAmount: number;
  status: string;
  soldBy: string;
  cashierId?: string;
  quoteId?: string | null;
  createdAt: Date;
  saleDate?: string;
  exchangeCreditApplied?: number;
  exchangeRefundNumber?: string;
}

export interface SaleItemRecord {
  id: string;
  saleId: string;
  productId: string;
  productName: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  costPrice: number;
  profit: number;
}

export interface VoidSaleItemRecord {
  id: string;
  saleId: string;
  productId: string;
  batchId: string | null;
  storeLocationId?: string | null;
  productLotId?: string | null;
  quantity: string;
  baseQty: string | null;         // SAP MUoM: base-unit qty at posting time
  conversionFactor: string | null; // SAP MUoM: display→base factor at posting time
  unitPrice: string;
  unitCost: string;
  totalPrice: string;
  profit: string;
  discountAmount: string;
  uomId: string | null;
  productName: string;
  sku: string;
}

export interface RefundableSaleItemRecord {
  id: string;
  saleId: string;
  productId: string | null;
  batchId: string | null;
  storeLocationId?: string | null;
  productLotId?: string | null;
  quantity: string;
  baseQty: string | null;         // SAP MUoM: base-unit qty at posting time
  conversionFactor: string | null; // SAP MUoM: display→base factor at posting time
  refundedQty: string;
  remainingQty: string;
  unitPrice: string;
  unitCost: string;
  totalPrice: string;
  discountAmount: string;
  profit: string;
  uomId: string | null;
  productType: string;
  itemType: string;
  productName: string;
  sku: string | null;
  uomSymbol?: string | null;
  uomName?: string | null;
  baseUomSymbol?: string | null;
}

export interface RefundRecord {
  id: string;
  refundNumber: string;
  saleId: string;
  refundDate: string;
  reason: string;
  totalAmount: string;
  totalCost: string;
  status: string;
  refundType?: string;
  exchangeAppliedAmount?: string;
  exchangeAppliedSaleId?: string | null;
  glTransactionId: string | null;
  createdById: string;
  approvedById: string | null;
  createdAt: string;
}

export interface RefundItemRecord {
  id: string;
  refundId: string;
  saleItemId: string;
  productId: string | null;
  batchId: string | null;
  quantity: string;
  unitPrice: string;
  unitCost: string;
  lineTotal: string;
  costTotal: string;
  productName: string;
  sku: string | null;
}

export interface CreateRefundData {
  saleId: string;
  refundDate?: string;
  reason: string;
  totalAmount: string;
  totalCost: string;
  refundType?: 'REFUND' | 'EXCHANGE';
  createdById: string;
  approvedById?: string;
}

export interface CreateRefundItemData {
  refundId: string;
  saleItemId: string;
  productId: string | null;
  batchId: string | null;
  quantity: string;
  unitPrice: string;
  unitCost: string;
  lineTotal: string;
  costTotal: string;
}

export interface CreateSaleData {
  customerId: string | null;
  subtotal?: number; // Subtotal before discount/tax
  totalAmount: number;
  totalCost?: number;
  discountAmount?: number; // Discount applied to sale
  taxAmount?: number;
  paymentMethod: string;
  paymentReceived: number;
  changeAmount: number;
  soldBy: string;
  saleDate?: string; // ISO 8601 datetime for backdated sales
  isSplitPayment?: boolean; // Indicates if sale uses split payment
  totalPaid?: number; // Total amount paid (may differ from totalAmount for credit)
  balanceDue?: number; // Remaining balance (for customer credit)
  quoteId?: string | null; // Link to quotation if sale is from quote conversion
  idempotencyKey?: string; // Offline sync idempotency key
  offlineId?: string; // Offline sale identifier
  cashRegisterSessionId?: string; // Link to cash register session for drawer tracking
  /** Phase 5 DocumentTax override audit columns */
  taxOverrideMode?: string | null;
  taxOverrideRate?: number | null;
  taxOverrideReason?: string | null;
  taxOverrideBy?: string | null;
}

export interface CreateSaleItemData {
  saleId: string;
  productId: string;
  productName: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  costPrice: number;
  profit: number;
  discountAmount?: number; // Per-item discount amount
  uomId?: string; // UUID of the product_uom used (optional for backward compatibility)
  baseQty?: number | null; // SAP UoM snapshot: quantity in base unit
  baseUomId?: string | null; // SAP UoM snapshot: base UoM ID at posting time
  conversionFactor?: number; // SAP UoM snapshot: conversion factor at posting time
  /** FEFO total cost at sale build — used by COGS drift guard (not persisted). */
  allocatedTotalCost?: number;
  /** Phase 6 — DocumentTax line snapshot at posting */
  taxAmount?: number;
  taxRate?: number;
  isTaxable?: boolean;
  taxDetermination?: string | null;
}

export const salesRepository = {
  /**
   * Generate next sale number (SALE-YYYY-NNNN format).
   * Accepts Pool or PoolClient — MUST be called on the transaction client
   * so the advisory lock is held until COMMIT.
   *
   * SSOT: allocateNextPrefixedDocumentNumber (numeric MAX, digits-only).
   */
  async generateSaleNumber(pool: Pool | PoolClient): Promise<string> {
    const year = getBusinessYear();
    return allocateNextPrefixedDocumentNumber(pool, {
      kind: 'sale',
      prefix: `SALE-${year}-`,
    });
  },

  /**
   * Create a new sale (transaction wrapper should be handled in service)
   * Accepts Pool or PoolClient to participate in caller's transaction.
   * Maps to actual sales table schema from 001_initial_schema.sql
   */
  async createSale(pool: Pool | PoolClient, data: CreateSaleData): Promise<SaleRecord> {
    // Schema fields: sale_number, customer_id, sale_date, subtotal, tax_amount,
    // discount_amount, total_amount, total_cost, profit, profit_margin,
    // payment_method, amount_paid, change_amount, status, notes, cashier_id

    // Calculate profit and margin with BANK-GRADE PRECISION
    const totalAmount = new Decimal(data.totalAmount);
    const totalCost = new Decimal(data.totalCost || 0);
    const taxAmount = new Decimal(data.taxAmount || 0);
    const discountAmount = new Decimal(data.discountAmount || 0);

    // Use subtotal from input if provided, otherwise calculate as total + discount - tax
    const subtotal =
      data.subtotal !== undefined
        ? new Decimal(data.subtotal)
        : totalAmount.plus(discountAmount).minus(taxAmount);

    // CRITICAL: Profit should EXCLUDE tax (tax is pass-through to government)
    // Profit = Revenue - Cost, where Revenue = Subtotal (before tax)
    // Formula: Profit = (Subtotal - Discount) - TotalCost
    const revenueBeforeTax = subtotal.minus(discountAmount);
    const profit = revenueBeforeTax.minus(totalCost);
    const profitMargin = revenueBeforeTax.greaterThan(0)
      ? profit.dividedBy(revenueBeforeTax)
      : new Decimal(0);

    let result: { rows: SaleRecord[] } | undefined;
    try {
      // Period enforcement (replaces trg_enforce_period_sales)
      await checkAccountingPeriodOpen(pool, data.saleDate ?? getBusinessDate());

      // Savepoint retry: after a unique_violation PG aborts the TX unless we roll back to SP.
      const maxAttempts = 3;
      let saleNumber = await this.generateSaleNumber(pool);
      let inserted: { rows: SaleRecord[] } | undefined;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        await pool.query('SAVEPOINT sp_sale_number_insert');
        try {
          inserted = await pool.query(
            `INSERT INTO sales (
        sale_number, customer_id, sale_date, subtotal, tax_amount, discount_amount, total_amount,
        total_cost, profit, profit_margin,
        payment_method, amount_paid, change_amount, cashier_id, quote_id,
        idempotency_key, offline_id, cash_register_session_id,
        tax_override_mode, tax_override_rate, tax_override_reason, tax_override_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
                $19, $20, $21, $22)
      RETURNING 
        id,
        sale_number as "saleNumber",
        customer_id as "customerId",
        sale_date as "saleDate",
        subtotal,
        tax_amount as "taxAmount",
        discount_amount as "discountAmount",
        total_amount as "totalAmount",
        total_cost as "totalCost",
        profit,
        profit_margin as "profitMargin",
        payment_method as "paymentMethod",
        amount_paid as "amountPaid",
        change_amount as "changeAmount",
        cashier_id as "cashierId",
        quote_id as "quoteId",
        cash_register_session_id as "cashRegisterSessionId",
        created_at as "createdAt"`,
            [
              saleNumber,
              data.customerId,
              data.saleDate || getBusinessDate(), // YYYY-MM-DD in Africa/Kampala timezone
              subtotal.toFixed(2), // $4 — string for PostgreSQL NUMERIC (bank-grade precision)
              taxAmount.toFixed(2), // $5
              discountAmount.toFixed(2), // $6
              totalAmount.toFixed(2), // $7
              totalCost.toFixed(2), // $8
              profit.toFixed(2), // $9
              profitMargin.toFixed(4), // 4 decimal places for margin (0.2500 = 25%)
              data.paymentMethod,
              data.paymentReceived,
              data.changeAmount,
              data.soldBy, // Maps to cashier_id
              data.quoteId || null, // Link to quotation
              data.idempotencyKey || null,
              data.offlineId || null,
              data.cashRegisterSessionId || null, // Link to cash register session
              data.taxOverrideMode || null,
              data.taxOverrideRate != null ? data.taxOverrideRate : null,
              data.taxOverrideReason || null,
              data.taxOverrideBy || null,
            ],
          );
          await pool.query('RELEASE SAVEPOINT sp_sale_number_insert');
          break;
        } catch (insertErr: unknown) {
          const pgInsert = insertErr as { code?: string; constraint?: string };
          await pool.query('ROLLBACK TO SAVEPOINT sp_sale_number_insert');
          if (
            pgInsert.code === '23505' &&
            pgInsert.constraint === 'sales_sale_number_key' &&
            attempt < maxAttempts
          ) {
            saleNumber = await this.generateSaleNumber(pool);
            continue;
          }
          throw insertErr;
        }
      }
      if (!inserted) {
        throw new BusinessError(
          'Could not allocate a unique sale number. Please retry payment.',
          'ERR_SALE_NUMBER_CONFLICT',
          { attempts: maxAttempts },
        );
      }
      result = inserted;
    } catch (dbError: unknown) {
      // Convert PostgreSQL constraint violations to structured BusinessErrors
      const pgError = dbError as { code?: string; constraint?: string; message?: string };
      if (pgError.constraint === 'chk_sales_payment_valid') {
        throw new BusinessError(
          `Payment amount is invalid for this sale. Amount paid: ${data.paymentReceived}, Total: ${totalAmount.toFixed(2)}`,
          'ERR_PAYMENT_005',
          {
            amountPaid: data.paymentReceived,
            totalAmount: Money.toNumber(totalAmount),
            constraint: 'chk_sales_payment_valid',
          }
        );
      }
      if (pgError.constraint === 'sales_sale_number_key') {
        throw new BusinessError(
          'Sale number conflict — please retry payment.',
          'ERR_SALE_NUMBER_CONFLICT',
          { constraint: pgError.constraint, pgCode: pgError.code },
        );
      }
      throw dbError; // Re-throw non-constraint DB errors
    }

    return result.rows[0];
  },

  /**
   * Add items to a sale
   * Accepts Pool or PoolClient to participate in caller's transaction.
   * Schema fields: sale_id, product_id, product_name, item_type, batch_id, quantity, unit_price,
   * unit_cost, discount_amount, total_price, profit
   */
  async addSaleItems(
    pool: Pool | PoolClient,
    items: CreateSaleItemData[]
  ): Promise<SaleItemRecord[]> {
    // Batch-fetch product_type and income_account_id for all non-custom items
    // (replaces trg_sale_items_set_product_type trigger)
    const productIds = items
      .filter((item) => !item.productId?.startsWith('custom_') && item.productId)
      .map((item) => item.productId!);

    const productTypeMap = new Map<
      string,
      { productType: string; incomeAccountId: string | null }
    >();
    if (productIds.length > 0) {
      const uniqueIds = [...new Set(productIds)];
      const ptResult = await pool.query(
        `SELECT p.id, p.product_type,
           COALESCE(p.income_account_id,
             CASE WHEN p.product_type = 'service'
               THEN (SELECT "Id" FROM accounts WHERE "AccountCode" = '4100' LIMIT 1)
               ELSE (SELECT "Id" FROM accounts WHERE "AccountCode" = '4000' LIMIT 1)
             END
           ) AS income_account_id
         FROM products p
         WHERE p.id = ANY($1)`,
        [uniqueIds]
      );
      for (const row of ptResult.rows) {
        productTypeMap.set(row.id, {
          productType: row.product_type || 'inventory',
          incomeAccountId: row.income_account_id || null,
        });
      }
    }

    const values: unknown[] = [];
    const placeholders: string[] = [];

    items.forEach((item, index) => {
      const offset = index * 20; // 20 fields (Phase 6: tax_amount/rate/is_taxable/determination)
      placeholders.push(
        `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, $${offset + 11}, $${offset + 12}, $${offset + 13}, $${offset + 14}, $${offset + 15}, $${offset + 16}, $${offset + 17}, $${offset + 18}, $${offset + 19}, $${offset + 20})`
      );

      // Use provided profit if available (may include discount allocation),
      // otherwise calculate from lineTotal - (costPrice * quantity)
      const lineTotal = new Decimal(item.lineTotal || 0);
      const costPrice = new Decimal(item.costPrice || 0);
      const quantity = new Decimal(item.quantity || 0);
      const itemProfit =
        item.profit !== undefined
          ? new Decimal(item.profit) // Use pre-calculated profit (with discount allocation)
          : lineTotal.minus(costPrice.times(quantity)); // Fallback calculation

      // Handle custom/service items (productId starts with 'custom_')
      const isCustomItem = item.productId?.startsWith('custom_');
      const productId = isCustomItem ? null : item.productId;
      const itemType = isCustomItem ? 'custom' : 'product';

      // Resolve product_type and income_account_id from batch lookup
      const productInfo = productId ? productTypeMap.get(productId) : null;
      const productType = productInfo?.productType || 'inventory';
      const incomeAccountId = productInfo?.incomeAccountId || null;
      const lineTaxAmount = new Decimal(item.taxAmount || 0);

      values.push(
        item.saleId,
        productId, // NULL for custom items
        item.productName || null, // Store name for custom items
        itemType,
        item.quantity,
        item.unitPrice,
        lineTotal.toFixed(2), // Maps to total_price — string for PostgreSQL NUMERIC
        costPrice.toFixed(2), // Maps to unit_cost
        itemProfit.toFixed(2), // Maps to profit
        item.uomId || null, // Include uom_id (NULL if not provided)
        item.discountAmount || 0, // Per-item discount amount
        productType,
        incomeAccountId,
        item.baseQty ?? null, // SAP UoM snapshot: base quantity
        item.baseUomId ?? null, // SAP UoM snapshot: base UoM at posting time
        item.conversionFactor ?? 1, // SAP UoM snapshot: conversion factor at posting time
        lineTaxAmount.toFixed(2),
        Number(item.taxRate || 0),
        item.isTaxable === true || lineTaxAmount.greaterThan(0),
        item.taxDetermination || null,
      );
    });

    const result = await pool.query(
      `INSERT INTO sale_items (
        sale_id, product_id, product_name, item_type, quantity, unit_price, total_price, unit_cost, profit, uom_id, discount_amount, product_type, income_account_id, base_qty, base_uom_id, conversion_factor,
        tax_amount, tax_rate, is_taxable, tax_determination
      ) VALUES ${placeholders.join(', ')}
      RETURNING *`,
      values
    );

    return result.rows;
  },

  /**
   * After FEFO batch deduction, align sale header and line costs with actual issue cost.
   */
  async updatePostedSaleCostsAfterDeduction(
    pool: Pool | PoolClient,
    saleId: string,
    header: { totalCost: number; profit: number; profitMargin: number },
    lineUpdates: Array<{ id: string; unitCost: number; profit: number }>,
  ): Promise<void> {
    for (const line of lineUpdates) {
      await pool.query(
        `UPDATE sale_items
         SET unit_cost = $1, profit = $2
         WHERE id = $3 AND sale_id = $4`,
        [
          new Decimal(line.unitCost).toFixed(2),
          new Decimal(line.profit).toFixed(2),
          line.id,
          saleId,
        ],
      );
    }

    await pool.query(
      `UPDATE sales
       SET total_cost = $1, profit = $2, profit_margin = $3
       WHERE id = $4`,
      [
        new Decimal(header.totalCost).toFixed(2),
        new Decimal(header.profit).toFixed(2),
        new Decimal(header.profitMargin).toFixed(4),
        saleId,
      ],
    );
  },

  async updateSaleItemWarehouseTrace(
    pool: Pool | PoolClient,
    saleItemId: string,
    trace: {
      storeLocationId?: string | null;
      productLotId?: string | null;
      batchId?: string | null;
    },
  ): Promise<void> {
    await pool.query(
      `UPDATE sale_items
       SET store_location_id = COALESCE($1, store_location_id),
           product_lot_id = COALESCE($2, product_lot_id),
           batch_id = COALESCE($3, batch_id)
       WHERE id = $4`,
      [
        trace.storeLocationId ?? null,
        trace.productLotId ?? null,
        trace.batchId ?? null,
        saleItemId,
      ],
    );
  },

  async updateRefundItemWarehouseTrace(
    pool: Pool | PoolClient,
    refundItemId: string,
    trace: {
      storeLocationId?: string | null;
      productLotId?: string | null;
    },
  ): Promise<void> {
    await pool.query(
      `UPDATE sale_refund_items
       SET store_location_id = COALESCE($1, store_location_id),
           product_lot_id = COALESCE($2, product_lot_id)
       WHERE id = $3`,
      [trace.storeLocationId ?? null, trace.productLotId ?? null, refundItemId],
    );
  },

  /**
   * Get sale by ID with items
   */
  async getSaleById(
    pool: Pool | PoolClient,
    id: string
  ): Promise<{
    sale: SaleRecord;
    items: SaleItemRecord[];
    paymentLines?: Record<string, unknown>[];
  } | null> {
    const saleResult = await pool.query(
      `SELECT
        s.*,
        c.name AS customer_name,
        c.phone AS customer_phone,
        c.email AS customer_email,
        u.full_name AS cashier_name
       FROM sales s
       LEFT JOIN customers c ON s.customer_id = c.id
       LEFT JOIN users u ON s.cashier_id = u.id
       WHERE s.id = $1`,
      [id]
    );

    if (saleResult.rows.length === 0) {
      return null;
    }

    // Include product name (and identifiers) by joining products
    // For custom items, use si.product_name; for inventory items, use p.name
    const itemsResult = await pool.query(
      `SELECT 
        si.*,
        COALESCE(p.name, si.product_name) AS product_name,
        p.sku AS sku,
        p.barcode AS barcode,
        COALESCE(sell_uom.symbol, sell_uom.name) AS uom_symbol,
        sell_uom.name AS uom_name,
        COALESCE(base_uom.symbol, base_uom.name) AS base_uom_symbol
       FROM sale_items si
       LEFT JOIN products p ON p.id = si.product_id
       LEFT JOIN uoms sell_uom ON sell_uom.id = si.uom_id
       LEFT JOIN uoms base_uom ON base_uom.id = si.base_uom_id
       WHERE si.sale_id = $1
       ORDER BY si.created_at`,
      [id]
    );

    // Fetch payment lines (for split payment support)
    const paymentLinesResult = await pool.query(
      `SELECT 
        id,
        payment_method,
        amount,
        reference,
        created_at
       FROM payment_lines
       WHERE sale_id = $1
       ORDER BY created_at`,
      [id]
    );

    const exchangeResult = await pool.query<{
      refund_number: string;
      exchange_applied_amount: string;
    }>(
      `SELECT refund_number, exchange_applied_amount
         FROM sale_refunds
        WHERE exchange_applied_sale_id = $1
          AND refund_type = 'EXCHANGE'
        ORDER BY updated_at DESC
        LIMIT 1`,
      [id],
    );

    const sale = saleResult.rows[0] as SaleRecord & Record<string, unknown>;
    if (exchangeResult.rows[0]) {
      const applied = Money.toNumber(Money.parseDb(exchangeResult.rows[0].exchange_applied_amount));
      sale.exchangeCreditApplied = applied;
      sale.exchange_credit_applied = applied;
      sale.exchangeRefundNumber = exchangeResult.rows[0].refund_number;
      sale.exchange_refund_number = exchangeResult.rows[0].refund_number;
    }

    return {
      sale,
      items: itemsResult.rows,
      paymentLines: paymentLinesResult.rows.length > 0 ? paymentLinesResult.rows : undefined,
    };
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
    const offset = (page - 1) * limit;
    const whereClauses: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (filters?.status) {
      whereClauses.push(`s.status = $${paramIndex++}`);
      values.push(filters.status);
    }

    if (filters?.customerId) {
      whereClauses.push(`s.customer_id = $${paramIndex++}`);
      values.push(filters.customerId);
    }

    if (filters?.cashierId) {
      whereClauses.push(`s.cashier_id = $${paramIndex++}`);
      values.push(filters.cashierId);
    }

    if (filters?.paymentMethod) {
      whereClauses.push(`s.payment_method = $${paramIndex++}`);
      values.push(filters.paymentMethod);
    }

    if (filters?.startDate) {
      whereClauses.push(`s.sale_date >= $${paramIndex++}::date`);
      values.push(filters.startDate);
    }

    if (filters?.endDate) {
      whereClauses.push(`s.sale_date <= $${paramIndex++}::date`);
      values.push(filters.endDate);
    }

    if (filters?.search?.trim()) {
      whereClauses.push(
        `(s.sale_number ILIKE $${paramIndex} OR c.name ILIKE $${paramIndex})`,
      );
      values.push(`%${filters.search.trim()}%`);
      paramIndex++;
    }

    if (filters?.outstandingOnly || (filters?.balanceGt != null && filters.balanceGt > 0)) {
      whereClauses.push(`(s.total_amount - COALESCE(s.amount_paid, 0)) > 0.009`);
    }

    const whereClause = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM sales s
       LEFT JOIN customers c ON s.customer_id = c.id
       ${whereClause}`,
      values,
    );

    let orderBy: string;
    if (filters?.sortBy === 'date') {
      orderBy = `s.sale_date ${sqlSortOrder(filters.sortOrder ?? 'desc')}, s.created_at ${sqlSortOrder(filters.sortOrder ?? 'desc')}`;
    } else if (filters?.sortBy === 'outstanding' || filters?.sortBy === 'balance') {
      orderBy = `(s.total_amount - COALESCE(s.amount_paid, 0)) ${sqlSortOrder(filters.sortOrder ?? 'desc')}`;
    } else {
      const col = pickSortColumn(filters?.sortBy, SALES_SORT_COLUMNS, 'date');
      orderBy = `${col} ${sqlSortOrder(filters?.sortOrder ?? 'desc')}`;
      if (filters?.sortBy !== 'date') {
        orderBy += `, s.sale_date DESC`;
      }
    }

    const result = await pool.query(
      `SELECT 
        s.id,
        s.sale_number,
        s.customer_id,
        s.sale_date,
        s.subtotal,
        s.tax_amount,
        s.discount_amount,
        s.total_amount,
        s.total_cost,
        s.profit,
        s.profit_margin,
        s.payment_method,
        s.amount_paid,
        s.change_amount,
        s.status,
        s.notes,
        s.cashier_id,
        s.created_at,
        c.name as customer_name,
        c.phone as customer_phone,
        c.email as customer_email,
        u.full_name as cashier_name
       FROM sales s
       LEFT JOIN customers c ON s.customer_id = c.id
       LEFT JOIN users u ON s.cashier_id = u.id
       ${whereClause} 
       ORDER BY ${orderBy}
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...values, limit, offset]
    );

    return {
      sales: result.rows,
      total: parseInt(countResult.rows[0].count),
    };
  },

  /**
   * Get FIFO cost layers for a product (oldest first)
   * Uses FOR UPDATE to prevent concurrent depletion by parallel sales.
   */
  async getFIFOCostLayers(
    pool: Pool | PoolClient,
    productId: string
  ): Promise<Record<string, unknown>[]> {
    const result = await pool.query(
      `SELECT * FROM cost_layers 
       WHERE product_id = $1 AND remaining_quantity > 0 
       ORDER BY created_at ASC
       FOR UPDATE`,
      [productId]
    );
    return result.rows;
  },

  /**
   * Update cost layer remaining quantity
   * @param poolOrClient - Pool for standalone operations, PoolClient for transactional operations
   */
  async updateCostLayerQuantity(
    poolOrClient: Pool | PoolClient,
    layerId: string,
    newQuantity: number
  ): Promise<void> {
    await poolOrClient.query('UPDATE cost_layers SET remaining_quantity = $1, updated_at = NOW() WHERE id = $2', [
      newQuantity,
      layerId,
    ]);
  },

  /**
   * Create cost layer (when receiving goods)
   */
  async createCostLayer(
    pool: Pool,
    data: {
      productId: string;
      batchNumber?: string | null; // aligned with schema
      quantity: number;
      unitCost: number; // aligned with schema
    }
  ): Promise<Record<string, unknown>> {
    // Note: Prefer using costLayerService.createCostLayer; this is a fallback aligned to schema
    const result = await pool.query(
      `INSERT INTO cost_layers (product_id, quantity, remaining_quantity, unit_cost, batch_number)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [data.productId, data.quantity, data.quantity, data.unitCost, data.batchNumber || null]
    );
    return result.rows[0];
  },

  /**
   * Get overall sales summary (totals, count, by payment method)
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
    const whereClauses: string[] = ['status = $1'];
    const values: unknown[] = ['COMPLETED'];
    let paramIndex = 2;

    if (filters?.cashierId) {
      whereClauses.push(`cashier_id = $${paramIndex++}`);
      values.push(filters.cashierId);
    }

    if (filters?.startDate) {
      whereClauses.push(`sale_date >= $${paramIndex++}::date`);
      values.push(filters.startDate);
    }

    if (filters?.endDate) {
      whereClauses.push(`sale_date <= $${paramIndex++}::date`);
      values.push(filters.endDate);
    }

    const whereClause = whereClauses.join(' AND ');

    // Get overall summary
    const summaryResult = await pool.query(
      `SELECT 
        COUNT(*) as total_sales,
        COALESCE(SUM(total_amount), 0) as total_amount,
        COALESCE(SUM(total_cost), 0) as total_cost,
        COALESCE(SUM(total_amount - COALESCE(total_cost, 0)), 0) as total_profit,
        COALESCE(SUM(discount_amount), 0) as total_discounts
       FROM sales
       WHERE ${whereClause}`,
      values
    );

    // Get breakdown by payment method
    const paymentMethodResult = await pool.query(
      `SELECT 
        payment_method,
        COUNT(*) as count,
        COALESCE(SUM(total_amount), 0) as total_amount
       FROM sales
       WHERE ${whereClause}
       GROUP BY payment_method
       ORDER BY total_amount DESC`,
      values
    );

    // Get credit sales + partial payment counts (server-side, not limited by pagination)
    const creditResult = await pool.query(
      `SELECT 
        COUNT(*) as credit_count,
        COUNT(*) FILTER (WHERE amount_paid > 0 AND amount_paid < total_amount) as partial_count
       FROM sales
       WHERE ${whereClause} AND payment_method = 'CREDIT'`,
      values
    );

    return {
      totalSales: parseInt(summaryResult.rows[0].total_sales),
      totalAmount: parseFloat(summaryResult.rows[0].total_amount),
      totalCost: parseFloat(summaryResult.rows[0].total_cost),
      totalProfit: parseFloat(summaryResult.rows[0].total_profit),
      totalDiscounts: parseFloat(summaryResult.rows[0].total_discounts),
      creditSalesCount: parseInt(creditResult.rows[0].credit_count),
      partialPaymentCount: parseInt(creditResult.rows[0].partial_count),
      byPaymentMethod: paymentMethodResult.rows.map((row) => ({
        paymentMethod: row.payment_method,
        count: parseInt(row.count),
        totalAmount: parseFloat(row.total_amount),
      })),
    };
  },

  /**
   * Get product sales summary report
   * Returns aggregated sales data per product for a date range
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
    const whereClauses: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    // Join sales with sale_items to get product-level data
    let query = `
      SELECT 
        si.product_id,
        si.product_name,
        COUNT(DISTINCT s.id) as transaction_count,
        ROUND(SUM(si.quantity)::numeric, 2) as total_quantity_sold,
        ROUND(SUM(si.total_price)::numeric, 2) as total_revenue,
        ROUND(SUM(si.unit_cost * si.quantity)::numeric, 2) as total_cost,
        ROUND(SUM(si.profit)::numeric, 2) as total_profit,
        ROUND(AVG(si.unit_price)::numeric, 2) as avg_selling_price,
        ROUND(AVG(si.unit_cost)::numeric, 2) as avg_cost_price,
        TO_CHAR(MIN(s.sale_date), 'Mon DD, YYYY') as first_sale_date,
        TO_CHAR(MAX(s.sale_date), 'Mon DD, YYYY') as last_sale_date
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
    `;

    // Only include completed sales
    whereClauses.push(`s.status = 'COMPLETED'`);

    if (filters?.cashierId) {
      whereClauses.push(`s.cashier_id = $${paramIndex++}`);
      values.push(filters.cashierId);
    }

    if (filters?.startDate) {
      whereClauses.push(`s.sale_date >= $${paramIndex++}::date`);
      values.push(filters.startDate);
    }

    if (filters?.endDate) {
      whereClauses.push(`s.sale_date <= $${paramIndex++}::date`);
      values.push(filters.endDate);
    }

    if (filters?.productId) {
      whereClauses.push(`si.product_id = $${paramIndex++}`);
      values.push(filters.productId);
    }

    if (filters?.customerId) {
      whereClauses.push(`s.customer_id = $${paramIndex++}`);
      values.push(filters.customerId);
    }

    if (whereClauses.length > 0) {
      query += ` WHERE ${whereClauses.join(' AND ')}`;
    }

    query += `
      GROUP BY si.product_id, si.product_name
      ORDER BY total_revenue DESC
    `;

    const result = await pool.query(query, values);

    // Calculate profit margin percentage for each product
    return result.rows.map((row: Record<string, unknown>) => {
      const totalRevenue = Number(row.total_revenue) || 0;
      const totalProfit = Number(row.total_profit) || 0;
      return {
        ...row,
        profit_margin_pct:
          totalRevenue > 0
            ? new Decimal(totalProfit)
              .dividedBy(totalRevenue)
              .times(100)
              .toDecimalPlaces(2)
              .toString()
            : '0.00',
      };
    });
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
    const whereClauses: string[] = ["s.status = 'COMPLETED'"];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (filters?.cashierId) {
      whereClauses.push(`s.cashier_id = $${paramIndex++}`);
      values.push(filters.cashierId);
    }

    if (filters?.startDate) {
      whereClauses.push(`s.sale_date >= $${paramIndex++}::date`);
      values.push(filters.startDate);
    }

    if (filters?.endDate) {
      whereClauses.push(`s.sale_date <= $${paramIndex++}::date`);
      values.push(filters.endDate);
    }

    const query = `
      SELECT 
        si.product_id,
        si.product_name,
        ROUND(SUM(si.quantity)::numeric, 2) as total_quantity,
        ROUND(SUM(si.total_price)::numeric, 2) as total_revenue,
        COUNT(DISTINCT s.id) as sale_count
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
      WHERE ${whereClauses.join(' AND ')}
      GROUP BY si.product_id, si.product_name
      ORDER BY total_quantity DESC
      LIMIT $${paramIndex}
    `;

    const result = await pool.query(query, [...values, limit]);
    return result.rows;
  },

  /**
   * Get sales summary by date — LEDGER-DRIVEN (SAP/Odoo pattern)
   *
   * Reads from double-entry GL postings instead of the sales table.
   * Revenue  = credits to REVENUE accounts (4xxx)
   * COGS     = debits to account 5000
   * Profit   = Revenue − COGS
   * Cash     = debits to ASSET receivable accounts (1010, 1200)
   *
   * This makes the report immune to POS table bugs — it reflects
   * accounting truth exactly as SAP Gross Profit Report does.
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
    // For cashier-filtered requests, use the raw sales table (sales_daily_summary has no cashier_id)
    if (filters?.cashierId) {
      const whereClauses: string[] = ['s.status = $1'];
      const values: unknown[] = ['COMPLETED'];
      let paramIndex = 2;

      whereClauses.push(`s.cashier_id = $${paramIndex++}`);
      values.push(filters.cashierId);

      if (filters.startDate) {
        whereClauses.push(`s.sale_date >= $${paramIndex++}::date`);
        values.push(filters.startDate);
      }
      if (filters.endDate) {
        whereClauses.push(`s.sale_date <= $${paramIndex++}::date`);
        values.push(filters.endDate);
      }

      let dateGroupExpr = '';
      let dateFormatExpr = '';
      switch (groupBy) {
        case 'day':
          dateGroupExpr = 's.sale_date';
          dateFormatExpr = `TO_CHAR(s.sale_date, 'Mon DD, YYYY')`;
          break;
        case 'week':
          dateGroupExpr = `DATE_TRUNC('week', s.sale_date)`;
          dateFormatExpr = `TO_CHAR(DATE_TRUNC('week', s.sale_date), 'Mon DD, YYYY')`;
          break;
        case 'month':
          dateGroupExpr = `DATE_TRUNC('month', s.sale_date)`;
          dateFormatExpr = `TO_CHAR(DATE_TRUNC('month', s.sale_date), 'Mon YYYY')`;
          break;
      }

      const cashierQuery = `
        SELECT
          ${dateFormatExpr} AS period,
          COUNT(*)::integer AS transaction_count,
          ROUND(COALESCE(SUM(s.total_amount), 0)::numeric, 2) AS total_revenue,
          ROUND(COALESCE(SUM(s.total_cost), 0)::numeric, 2) AS total_cost,
          ROUND(COALESCE(SUM(s.total_amount - COALESCE(s.total_cost, 0)), 0)::numeric, 2) AS total_profit,
          ROUND(
            COALESCE(SUM(s.total_amount), 0) / NULLIF(COUNT(*), 0)::numeric
          , 2) AS avg_transaction_value
        FROM sales s
        WHERE ${whereClauses.join(' AND ')}
        GROUP BY ${dateGroupExpr}
        ORDER BY ${dateGroupExpr} DESC
      `;
      const cashierResult = await pool.query(cashierQuery, values);
      return cashierResult.rows;
    }

    // Non-cashier case: use sales_daily_summary state table for accurate pre-computed totals.
    // The GL-based query was unreliable (COGS only captured account '5000', missing COGS for
    // some entries). The state table is the single source of truth for daily sales figures.
    const whereClauses: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (filters?.startDate) {
      whereClauses.push(`sale_date >= $${paramIndex++}::date`);
      values.push(filters.startDate);
    }
    if (filters?.endDate) {
      whereClauses.push(`sale_date <= $${paramIndex++}::date`);
      values.push(filters.endDate);
    }

    const whereClause = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';

    let dateGroupExpr = '';
    let dateFormatExpr = '';
    switch (groupBy) {
      case 'day':
        dateGroupExpr = 'sale_date';
        dateFormatExpr = `TO_CHAR(sale_date, 'Mon DD, YYYY')`;
        break;
      case 'week':
        dateGroupExpr = `DATE_TRUNC('week', sale_date)`;
        dateFormatExpr = `TO_CHAR(DATE_TRUNC('week', sale_date), 'Mon DD, YYYY')`;
        break;
      case 'month':
        dateGroupExpr = `DATE_TRUNC('month', sale_date)`;
        dateFormatExpr = `TO_CHAR(DATE_TRUNC('month', sale_date), 'Mon YYYY')`;
        break;
    }

    const query = `
      SELECT
        ${dateFormatExpr} AS period,
        COALESCE(SUM(transaction_count), 0)::integer AS transaction_count,
        ROUND(COALESCE(SUM(total_amount), 0)::numeric, 2) AS total_revenue,
        ROUND(COALESCE(SUM(total_cost), 0)::numeric, 2) AS total_cost,
        ROUND(COALESCE(SUM(total_profit), 0)::numeric, 2) AS total_profit,
        ROUND(
          COALESCE(SUM(total_amount), 0) / NULLIF(COALESCE(SUM(transaction_count), 0), 0)::numeric
        , 2) AS avg_transaction_value
      FROM sales_daily_summary
      ${whereClause}
      GROUP BY ${dateGroupExpr}
      ORDER BY ${dateGroupExpr} DESC
    `;

    const result = await pool.query(query, values);
    return result.rows;
  },

  /**
   * Get sales details report - aggregated by date and product with revenue/cost metrics
   */
  async getSalesDetailsReport(
    pool: Pool,
    filters: Record<string, unknown> = {}
  ): Promise<Record<string, unknown>[]> {
    const whereClauses = ['s.status = $1'];
    const values: unknown[] = ['COMPLETED'];
    let paramIndex = 2;

    if (filters.startDate) {
      whereClauses.push(`s.sale_date >= $${paramIndex++}`);
      values.push(filters.startDate);
    }

    if (filters.endDate) {
      whereClauses.push(`s.sale_date <= $${paramIndex++}`);
      values.push(filters.endDate);
    }

    if (filters.productId) {
      whereClauses.push(`p.id = $${paramIndex++}`);
      values.push(filters.productId);
    }

    const query = `
      SELECT 
        TO_CHAR(DATE(s.sale_date), 'Mon DD, YYYY') as sale_date,
        p.name as product_name,
        p.sku,
        (SELECT u.symbol FROM product_uoms pu JOIN uoms u ON pu.uom_id = u.id WHERE pu.product_id = p.id AND pu.is_default = true LIMIT 1) as unit_of_measure,
        ROUND(SUM(si.quantity)::numeric, 2) as total_quantity,
        ROUND(AVG(si.unit_price)::numeric, 2) as avg_unit_price,
        ROUND(SUM(si.total_price)::numeric, 2) as total_revenue,
        CASE 
          WHEN SUM(si.total_price) > 0 
          THEN ROUND((SUM(si.profit) / SUM(si.total_price) * 100)::numeric, 2)
          ELSE 0 
        END as profit_margin_percent,
        COUNT(DISTINCT s.id) as transaction_count
      FROM sales s
      INNER JOIN sale_items si ON s.id = si.sale_id
      INNER JOIN products p ON si.product_id = p.id
      WHERE ${whereClauses.join(' AND ')}
      GROUP BY DATE(s.sale_date), p.id, p.name, p.sku
      ORDER BY DATE(s.sale_date) DESC, total_revenue DESC
    `;

    const result = await pool.query(query, values);
    return result.rows;
  },

  /**
   * Aggregated sales-by-cashier (one row per cashier). Used by Sales page performance tab.
   */
  async getSalesByCashierSummary(
    pool: Pool,
    filters: Record<string, unknown> = {}
  ): Promise<Record<string, unknown>[]> {
    const whereClauses = ["s.status = 'COMPLETED'"];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (filters.startDate) {
      whereClauses.push(`s.sale_date >= $${paramIndex++}`);
      values.push(filters.startDate);
    }

    if (filters.endDate) {
      whereClauses.push(`s.sale_date <= $${paramIndex++}`);
      values.push(filters.endDate);
    }

    if (filters.cashierId) {
      whereClauses.push(`s.cashier_id = $${paramIndex++}`);
      values.push(filters.cashierId);
    } else if (filters.userId) {
      whereClauses.push(`s.cashier_id = $${paramIndex++}`);
      values.push(filters.userId);
    }

    if (filters.orderedById) {
      whereClauses.push(
        `(po.created_by = $${paramIndex++} OR (s.from_order_id IS NULL AND s.cashier_id = $${paramIndex++}))`
      );
      values.push(filters.orderedById, filters.orderedById);
    }

    if (filters.productId) {
      whereClauses.push(
        `EXISTS (SELECT 1 FROM sale_items si_f WHERE si_f.sale_id = s.id AND si_f.product_id = $${paramIndex++})`
      );
      values.push(filters.productId);
    }

    const query = `
      SELECT
        u.id                                                   AS user_id,
        u.full_name                                            AS cashier_name,
        u.role,
        COUNT(DISTINCT s.id)::int                              AS total_transactions,
        ROUND(SUM(s.total_amount)::numeric, 2)                 AS total_revenue,
        ROUND(SUM(s.total_cost)::numeric, 2)                   AS total_cost,
        ROUND(SUM(s.profit)::numeric, 2)                       AS total_profit,
        COUNT(DISTINCT po.created_by)::int                     AS unique_order_creators,
        TO_CHAR(MAX(s.sale_date), 'YYYY-MM-DD')                AS last_sale_date
      FROM sales s
      INNER JOIN users u ON u.id = s.cashier_id
      LEFT JOIN pos_orders po ON po.id = s.from_order_id
      WHERE ${whereClauses.join(' AND ')}
      GROUP BY u.id, u.full_name, u.role
      ORDER BY total_revenue DESC
    `;

    const result = await pool.query(query, values);
    return result.rows;
  },

  /**
   * Line-level sales-by-cashier (one row per sale_item). Used by Reports export/detail.
   */
  async getSalesByCashierDetail(
    pool: Pool,
    filters: Record<string, unknown> = {}
  ): Promise<Record<string, unknown>[]> {
    const whereClauses = ["s.status = 'COMPLETED'"];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (filters.startDate) {
      whereClauses.push(`s.sale_date >= $${paramIndex++}`);
      values.push(filters.startDate);
    }

    if (filters.endDate) {
      whereClauses.push(`s.sale_date <= $${paramIndex++}`);
      values.push(filters.endDate);
    }

    if (filters.cashierId) {
      whereClauses.push(`s.cashier_id = $${paramIndex++}`);
      values.push(filters.cashierId);
    } else if (filters.userId) {
      whereClauses.push(`s.cashier_id = $${paramIndex++}`);
      values.push(filters.userId);
    }

    if (filters.orderedById) {
      whereClauses.push(
        `(po.created_by = $${paramIndex++} OR (s.from_order_id IS NULL AND s.cashier_id = $${paramIndex++}))`
      );
      values.push(filters.orderedById, filters.orderedById);
    }

    if (filters.productId) {
      whereClauses.push(`si.product_id = $${paramIndex++}`);
      values.push(filters.productId);
    }

    const query = `
      SELECT
        s.sale_number,
        s.sale_date,
        si.product_name,
        ROUND(si.quantity::numeric, 4)                           AS quantity,
        ROUND(si.total_price::numeric, 2)                        AS amount,
        COALESCE(ou.full_name, cu.full_name)                     AS ordered_by,
        cu.full_name                                             AS cashier,
        s.payment_method
      FROM sales s
      INNER JOIN sale_items  si ON si.sale_id    = s.id
      INNER JOIN users       cu ON cu.id         = s.cashier_id
      LEFT  JOIN pos_orders  po ON po.id         = s.from_order_id
      LEFT  JOIN users       ou ON ou.id         = po.created_by
      WHERE ${whereClauses.join(' AND ')}
      ORDER BY s.sale_date DESC, s.sale_number, si.product_name
    `;

    const result = await pool.query(query, values);
    return result.rows;
  },

  /**
   * Void a sale (mark as VOID, record who/when/why)
   * Accepts Pool or PoolClient to participate in caller's transaction.
   * Returns updated sale record with void details
   */
  async voidSale(
    pool: Pool | PoolClient,
    saleId: string,
    voidedById: string,
    voidReason: string,
    approvedById?: string
  ): Promise<Record<string, unknown>> {
    const result = await pool.query(
      `UPDATE sales 
       SET status = 'VOID',
           voided_at = CURRENT_TIMESTAMP,
           voided_by_id = $2,
           void_reason = $3,
           void_approved_by_id = $4::uuid,
           void_approved_at = CASE WHEN $4::uuid IS NOT NULL THEN CURRENT_TIMESTAMP ELSE NULL END
       WHERE id = $1 AND status = 'COMPLETED'
       RETURNING 
         id,
         sale_number as "saleNumber",
         status,
         voided_at as "voidedAt",
         voided_by_id as "voidedById",
         void_reason as "voidReason",
         void_approved_by_id as "voidApprovedById",
         void_approved_at as "voidApprovedAt"`,
      [saleId, voidedById, voidReason, approvedById || null]
    );

    if (result.rows.length === 0) {
      throw new BusinessError('Sale not found or already voided', 'ERR_SALE_013', { saleId });
    }

    return result.rows[0];
  },

  /**
   * Get sale items for a sale (needed for inventory restoration)
   * Accepts Pool or PoolClient to participate in caller's transaction.
   */
  async getSaleItemsForVoid(
    pool: Pool | PoolClient,
    saleId: string
  ): Promise<VoidSaleItemRecord[]> {
    const result = await pool.query(
      `SELECT 
        si.id,
        si.sale_id as "saleId",
        si.product_id as "productId",
        si.batch_id as "batchId",
        si.store_location_id AS "storeLocationId",
        si.product_lot_id AS "productLotId",
        si.quantity,
        si.base_qty AS "baseQty",
        si.conversion_factor AS "conversionFactor",
        si.unit_price as "unitPrice",
        si.unit_cost as "unitCost",
        si.total_price as "totalPrice",
        si.profit,
        si.discount_amount as "discountAmount",
        si.uom_id as "uomId",
        p.name as "productName",
        p.sku
       FROM sale_items si
       JOIN products p ON si.product_id = p.id
       WHERE si.sale_id = $1`,
      [saleId]
    );

    return result.rows;
  },


  // ============================================================
  // REFUND OPERATIONS
  // ============================================================

  /**
   * Get sale items with refundable quantities for a given sale.
   * Returns items where (quantity - refunded_qty) > 0.
   */
  async getSaleItemsForRefund(
    pool: Pool | PoolClient,
    saleId: string
  ): Promise<RefundableSaleItemRecord[]> {
    const result = await pool.query(
      `SELECT
        si.id,
        si.sale_id AS "saleId",
        si.product_id AS "productId",
        si.batch_id AS "batchId",
        si.store_location_id AS "storeLocationId",
        si.product_lot_id AS "productLotId",
        si.quantity,
        si.base_qty AS "baseQty",
        si.conversion_factor AS "conversionFactor",
        si.refunded_qty AS "refundedQty",
        (si.quantity - si.refunded_qty) AS "remainingQty",
        si.unit_price AS "unitPrice",
        si.unit_cost AS "unitCost",
        si.total_price AS "totalPrice",
        si.discount_amount AS "discountAmount",
        si.profit,
        si.uom_id AS "uomId",
        si.product_type AS "productType",
        si.item_type AS "itemType",
        COALESCE(p.name, si.product_name) AS "productName",
        p.sku,
        COALESCE(sell_uom.symbol, sell_uom.name) AS "uomSymbol",
        sell_uom.name AS "uomName",
        COALESCE(base_uom.symbol, base_uom.name) AS "baseUomSymbol"
       FROM sale_items si
       LEFT JOIN products p ON si.product_id = p.id
       LEFT JOIN uoms sell_uom ON sell_uom.id = si.uom_id
       LEFT JOIN uoms base_uom ON base_uom.id = si.base_uom_id
       WHERE si.sale_id = $1
       ORDER BY si.created_at`,
      [saleId]
    );

    return result.rows;
  },

  /**
   * Generate next refund number (REF-YYYY-NNNN format).
   * Must be called inside a transaction for advisory lock safety.
   * SSOT: allocateNextPrefixedDocumentNumber (numeric MAX, digits-only).
   */
  async generateRefundNumber(pool: Pool | PoolClient): Promise<string> {
    const year = getBusinessYear();
    return allocateNextPrefixedDocumentNumber(pool, {
      kind: 'refund',
      prefix: `REF-${year}-`,
    });
  },

  /**
   * Create a refund document header.
   */
  async createRefund(
    pool: Pool | PoolClient,
    data: CreateRefundData
  ): Promise<RefundRecord> {
    const refundNumber = await this.generateRefundNumber(pool);
    const result = await pool.query(
      `INSERT INTO sale_refunds (
        refund_number, sale_id, refund_date, reason,
        total_amount, total_cost, status, refund_type,
        created_by_id, approved_by_id
      ) VALUES ($1, $2, $3, $4, $5, $6, 'COMPLETED', $7, $8, $9)
      RETURNING
        id,
        refund_number AS "refundNumber",
        sale_id AS "saleId",
        refund_date AS "refundDate",
        reason,
        total_amount AS "totalAmount",
        total_cost AS "totalCost",
        status,
        refund_type AS "refundType",
        exchange_applied_amount AS "exchangeAppliedAmount",
        exchange_applied_sale_id AS "exchangeAppliedSaleId",
        gl_transaction_id AS "glTransactionId",
        created_by_id AS "createdById",
        approved_by_id AS "approvedById",
        created_at AS "createdAt"`,
      [
        refundNumber,
        data.saleId,
        data.refundDate || getBusinessDate(),
        data.reason,
        data.totalAmount,
        data.totalCost,
        data.refundType || 'REFUND',
        data.createdById,
        data.approvedById || null,
      ]
    );
    return result.rows[0];
  },

  /**
   * Create refund line items.
   */
  async addRefundItems(
    pool: Pool | PoolClient,
    items: CreateRefundItemData[]
  ): Promise<RefundItemRecord[]> {
    if (items.length === 0) return [];

    const values: unknown[] = [];
    const placeholders: string[] = [];

    items.forEach((item, index) => {
      const offset = index * 9;
      placeholders.push(
        `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9})`
      );
      values.push(
        item.refundId,
        item.saleItemId,
        item.productId || null,
        item.batchId || null,
        item.quantity,
        item.unitPrice,
        item.unitCost,
        item.lineTotal,
        item.costTotal,
      );
    });

    const result = await pool.query(
      `INSERT INTO sale_refund_items (
        refund_id, sale_item_id, product_id, batch_id,
        quantity, unit_price, unit_cost, line_total, cost_total
      ) VALUES ${placeholders.join(', ')}
      RETURNING
        id,
        refund_id AS "refundId",
        sale_item_id AS "saleItemId",
        product_id AS "productId",
        batch_id AS "batchId",
        quantity,
        unit_price AS "unitPrice",
        unit_cost AS "unitCost",
        line_total AS "lineTotal",
        cost_total AS "costTotal"`,
      values
    );

    return result.rows;
  },

  /**
   * Increment refunded_qty on a sale_item (within a transaction).
   */
  async incrementRefundedQty(
    pool: Pool | PoolClient,
    saleItemId: string,
    qty: number
  ): Promise<void> {
    const result = await pool.query(
      `UPDATE sale_items
       SET refunded_qty = refunded_qty + $1
       WHERE id = $2
         AND refunded_qty + $1 <= quantity
       RETURNING id`,
      [qty, saleItemId]
    );
    if (result.rows.length === 0) {
      throw new BusinessError(
        'Refund quantity exceeds remaining refundable quantity',
        'ERR_REFUND_002',
        { saleItemId, requestedQty: qty }
      );
    }
  },

  /**
   * Check if ALL items on a sale are fully refunded.
   * Returns true if every sale_item has refunded_qty = quantity.
   */
  async isSaleFullyRefunded(pool: Pool | PoolClient, saleId: string): Promise<boolean> {
    const result = await pool.query(
      `SELECT COUNT(*) AS total,
              COUNT(*) FILTER (WHERE refunded_qty >= quantity) AS fully_refunded
       FROM sale_items
       WHERE sale_id = $1`,
      [saleId]
    );
    const row = result.rows[0];
    return parseInt(row.total) > 0 && parseInt(row.total) === parseInt(row.fully_refunded);
  },

  /**
   * Mark a sale as REFUNDED (only when all items fully refunded).
   * @deprecated Use markSaleVoidedByReturn for completed POS sales (ERP discipline).
   */
  async markSaleRefunded(pool: Pool | PoolClient, saleId: string): Promise<void> {
    await pool.query(
      `UPDATE sales SET status = 'REFUNDED' WHERE id = $1 AND status = 'COMPLETED'`,
      [saleId]
    );
  },

  /**
   * Mark a sale as VOIDED_BY_RETURN after all items have been returned.
   * ERP discipline (SAP/Odoo): completed POS sales are never voided — they are reversed
   * through Return → Credit Note → Refund. VOIDED_BY_RETURN records this outcome while
   * preserving the original sale document in the audit trail.
   */
  async markSaleVoidedByReturn(pool: Pool | PoolClient, saleId: string): Promise<void> {
    await pool.query(
      `UPDATE sales SET status = 'VOIDED_BY_RETURN'
       WHERE id = $1 AND status IN ('COMPLETED', 'PARTIALLY_RETURNED')`,
      [saleId]
    );
  },

  /**
   * Mark a sale as PARTIALLY_RETURNED when some (but not all) items have been returned.
   * Only advances from COMPLETED → PARTIALLY_RETURNED; already-partial sales stay PARTIALLY_RETURNED.
   */
  async markSalePartiallyReturned(pool: Pool | PoolClient, saleId: string): Promise<void> {
    await pool.query(
      `UPDATE sales SET status = 'PARTIALLY_RETURNED'
       WHERE id = $1 AND status = 'COMPLETED'`,
      [saleId]
    );
  },

  /**
   * After customer credit-note return goods or invoice adjustment, align sale status
   * with refunded_qty on sale_items (same rules as salesService.refundSale).
   */
  async syncSaleStatusAfterCustomerReturn(pool: Pool | PoolClient, saleId: string): Promise<void> {
    const isFull = await this.isSaleFullyRefunded(pool, saleId);
    if (isFull) {
      await this.markSaleVoidedByReturn(pool, saleId);
      return;
    }
    const statusRes = await pool.query<{ status: string }>(
      `SELECT status FROM sales WHERE id = $1`,
      [saleId],
    );
    if (statusRes.rows[0]?.status === 'COMPLETED') {
      await this.markSalePartiallyReturned(pool, saleId);
    }
  },

  /**
   * Load an EXCHANGE refund eligible for POS credit application.
   */
  async getExchangeRefundForApplication(
    pool: Pool | PoolClient,
    refundId: string,
  ): Promise<{
    id: string;
    refundNumber: string;
    totalAmount: number;
    exchangeAppliedAmount: number;
    exchangeResidualPayoutAmount: number;
    remainingAmount: number;
    refundType: string;
    status: string;
  } | null> {
    const result = await pool.query(
      `SELECT id, refund_number, total_amount, exchange_applied_amount,
              COALESCE(exchange_residual_payout_amount, 0) AS exchange_residual_payout_amount,
              refund_type, status
       FROM sale_refunds WHERE id = $1`,
      [refundId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const totalAmount = Money.toNumber(Money.parseDb(row.total_amount));
    const exchangeAppliedAmount = Money.toNumber(Money.parseDb(row.exchange_applied_amount ?? 0));
    const exchangeResidualPayoutAmount = Money.toNumber(
      Money.parseDb(row.exchange_residual_payout_amount ?? 0),
    );
    return {
      id: row.id,
      refundNumber: row.refund_number,
      totalAmount,
      exchangeAppliedAmount,
      exchangeResidualPayoutAmount,
      remainingAmount: Math.max(
        0,
        Money.toNumber(
          Money.round(
            Money.subtract(
              Money.subtract(Money.parseDb(totalAmount), Money.parseDb(exchangeAppliedAmount)),
              Money.parseDb(exchangeResidualPayoutAmount),
            ),
            2,
          ),
        ),
      ),
      refundType: row.refund_type ?? 'REFUND',
      status: row.status,
    };
  },

  /**
   * Record exchange credit applied on a replacement POS sale.
   */
  async applyExchangeCreditToSale(
    pool: Pool | PoolClient,
    refundId: string,
    saleId: string,
    appliedAmount: number,
  ): Promise<void> {
    const result = await pool.query(
      `UPDATE sale_refunds
       SET exchange_applied_amount = exchange_applied_amount + $1,
           exchange_applied_sale_id = COALESCE(exchange_applied_sale_id, $2),
           updated_at = NOW()
       WHERE id = $3
         AND refund_type = 'EXCHANGE'
         AND status = 'COMPLETED'
         AND exchange_applied_amount + COALESCE(exchange_residual_payout_amount, 0) + $1
             <= total_amount + 0.01
       RETURNING id`,
      [appliedAmount, saleId, refundId],
    );
    if (result.rows.length === 0) {
      throw new BusinessError(
        'Exchange credit could not be applied — invalid or exhausted exchange refund',
        'ERR_EXCHANGE_CREDIT_001',
        { refundId, saleId, appliedAmount },
      );
    }
  },

  /**
   * Record residual cash/card payout of unused exchange store credit.
   */
  async applyExchangeResidualPayout(
    pool: Pool | PoolClient,
    refundId: string,
    payoutAmount: number,
  ): Promise<void> {
    const result = await pool.query(
      `UPDATE sale_refunds
       SET exchange_residual_payout_amount = COALESCE(exchange_residual_payout_amount, 0) + $1,
           updated_at = NOW()
       WHERE id = $2
         AND refund_type = 'EXCHANGE'
         AND status = 'COMPLETED'
         AND exchange_applied_amount + COALESCE(exchange_residual_payout_amount, 0) + $1
             <= total_amount + 0.01
       RETURNING id`,
      [payoutAmount, refundId],
    );
    if (result.rows.length === 0) {
      throw new BusinessError(
        'Exchange residual payout could not be recorded — invalid or exhausted credit',
        'ERR_EXCHANGE_RESIDUAL_001',
        { refundId, payoutAmount },
      );
    }
  },

  /**
   * List open (unapplied / unpayout) EXCHANGE store credits for control/reporting.
   */
  async listOpenExchangeCredits(
    pool: Pool | PoolClient,
    limit = 50,
  ): Promise<
    Array<{
      id: string;
      refundNumber: string;
      saleId: string;
      saleNumber: string | null;
      totalAmount: number;
      remainingAmount: number;
      reason: string | null;
      createdAt: string;
      customerId: string | null;
      customerName: string | null;
    }>
  > {
    const result = await pool.query(
      `SELECT
         r.id,
         r.refund_number AS "refundNumber",
         r.sale_id AS "saleId",
         s.sale_number AS "saleNumber",
         r.total_amount AS "totalAmount",
         r.exchange_applied_amount AS "applied",
         COALESCE(r.exchange_residual_payout_amount, 0) AS "payout",
         r.reason,
         r.created_at AS "createdAt",
         s.customer_id AS "customerId",
         c.name AS "customerName"
       FROM sale_refunds r
       JOIN sales s ON s.id = r.sale_id
       LEFT JOIN customers c ON c.id = s.customer_id
       WHERE r.refund_type = 'EXCHANGE'
         AND r.status = 'COMPLETED'
         AND (r.total_amount - r.exchange_applied_amount - COALESCE(r.exchange_residual_payout_amount, 0)) > 0.01
       ORDER BY r.created_at DESC
       LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => {
      const total = Money.toNumber(Money.parseDb(row.totalAmount));
      const applied = Money.toNumber(Money.parseDb(row.applied));
      const payout = Money.toNumber(Money.parseDb(row.payout));
      return {
        id: row.id,
        refundNumber: row.refundNumber,
        saleId: row.saleId,
        saleNumber: row.saleNumber,
        totalAmount: total,
        remainingAmount: Math.max(0, Money.toNumber(Money.round(Money.parseDb(total - applied - payout), 2))),
        reason: row.reason,
        createdAt: row.createdAt,
        customerId: row.customerId,
        customerName: row.customerName,
      };
    });
  },

  /**
   * Update refund's gl_transaction_id after GL posting.
   */
  async updateRefundGlTransaction(
    pool: Pool | PoolClient,
    refundId: string,
    glTransactionId: string
  ): Promise<void> {
    // Direct update on new row still in COMPLETED status within same TX
    await pool.query(
      `UPDATE sale_refunds SET gl_transaction_id = $1 WHERE id = $2`,
      [glTransactionId, refundId]
    );
  },

  /**
   * Get refunds for a sale.
   */
  async getRefundsBySaleId(
    pool: Pool | PoolClient,
    saleId: string
  ): Promise<RefundRecord[]> {
    const result = await pool.query(
      `SELECT
        id,
        refund_number AS "refundNumber",
        sale_id AS "saleId",
        refund_date AS "refundDate",
        reason,
        total_amount AS "totalAmount",
        total_cost AS "totalCost",
        status,
        gl_transaction_id AS "glTransactionId",
        created_by_id AS "createdById",
        approved_by_id AS "approvedById",
        created_at AS "createdAt"
       FROM sale_refunds
       WHERE sale_id = $1
       ORDER BY created_at DESC`,
      [saleId]
    );
    return result.rows;
  },

  /**
   * Get refund items for a refund.
   */
  async getRefundItems(
    pool: Pool | PoolClient,
    refundId: string
  ): Promise<RefundItemRecord[]> {
    const result = await pool.query(
      `SELECT
        ri.id,
        ri.refund_id AS "refundId",
        ri.sale_item_id AS "saleItemId",
        ri.product_id AS "productId",
        ri.batch_id AS "batchId",
        ri.quantity,
        ri.unit_price AS "unitPrice",
        ri.unit_cost AS "unitCost",
        ri.line_total AS "lineTotal",
        ri.cost_total AS "costTotal",
        COALESCE(p.name, si.product_name) AS "productName",
        p.sku
       FROM sale_refund_items ri
       LEFT JOIN products p ON ri.product_id = p.id
       LEFT JOIN sale_items si ON ri.sale_item_id = si.id
       WHERE ri.refund_id = $1
       ORDER BY ri.created_at`,
      [refundId]
    );
    return result.rows;
  },

  // ============================================================
  // SAP GLT0-Equivalent: Sales Daily Summary (Rollup Table)
  // ============================================================

  /**
   * Atomically increment the daily summary row for a new COMPLETED sale.
   * Must be called inside the sale transaction (using the same PoolClient).
   */
  async incrementDailySummary(
    client: PoolClient,
    saleDate: string,
    paymentMethod: string,
    totalAmount: string | number,
    totalCost: string | number,
    discountAmount: string | number,
    isCredit: boolean,
    isPartialPayment: boolean
  ): Promise<void> {
    const profit = new Decimal(totalAmount).minus(new Decimal(totalCost || 0));
    await client.query(
      `INSERT INTO sales_daily_summary (
          sale_date, payment_method,
          transaction_count, total_amount, total_cost, total_profit, total_discounts,
          credit_count, partial_payment_count, updated_at
       ) VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT (sale_date, payment_method) DO UPDATE SET
          transaction_count     = sales_daily_summary.transaction_count + 1,
          total_amount          = sales_daily_summary.total_amount + EXCLUDED.total_amount,
          total_cost            = sales_daily_summary.total_cost + EXCLUDED.total_cost,
          total_profit          = sales_daily_summary.total_profit + EXCLUDED.total_profit,
          total_discounts       = sales_daily_summary.total_discounts + EXCLUDED.total_discounts,
          credit_count          = sales_daily_summary.credit_count + EXCLUDED.credit_count,
          partial_payment_count = sales_daily_summary.partial_payment_count + EXCLUDED.partial_payment_count,
          updated_at            = NOW()`,
      [
        saleDate,
        paymentMethod,
        new Decimal(totalAmount).toFixed(2),
        new Decimal(totalCost || 0).toFixed(2),
        profit.toFixed(2),
        new Decimal(discountAmount || 0).toFixed(2),
        isCredit ? 1 : 0,
        isPartialPayment ? 1 : 0,
      ]
    );
  },

  /**
   * Atomically decrement the daily summary row when a sale is voided.
   * Must be called inside the void transaction (using the same PoolClient).
   */
  async decrementDailySummary(
    client: PoolClient,
    saleDate: string,
    paymentMethod: string,
    totalAmount: string | number,
    totalCost: string | number,
    discountAmount: string | number,
    isCredit: boolean,
    isPartialPayment: boolean
  ): Promise<void> {
    const profit = new Decimal(totalAmount).minus(new Decimal(totalCost || 0));
    await client.query(
      `UPDATE sales_daily_summary SET
          transaction_count     = GREATEST(transaction_count - 1, 0),
          total_amount          = total_amount - $3,
          total_cost            = total_cost - $4,
          total_profit          = total_profit - $5,
          total_discounts       = total_discounts - $6,
          credit_count          = GREATEST(credit_count - $7, 0),
          partial_payment_count = GREATEST(partial_payment_count - $8, 0),
          updated_at            = NOW()
       WHERE sale_date = $1 AND payment_method = $2`,
      [
        saleDate,
        paymentMethod,
        new Decimal(totalAmount).toFixed(2),
        new Decimal(totalCost || 0).toFixed(2),
        profit.toFixed(2),
        new Decimal(discountAmount || 0).toFixed(2),
        isCredit ? 1 : 0,
        isPartialPayment ? 1 : 0,
      ]
    );
  },

  /**
   * Read aggregated summary from the rollup table (SAP GLT0-style).
   * Replaces the full-table scan on `sales` for dashboard KPIs.
   */
  async getSalesSummaryFromRollup(
    pool: Pool,
    filters?: {
      startDate?: string;
      endDate?: string;
      cashierId?: string;
    }
  ): Promise<Record<string, unknown>> {
    // If cashierId filter is present, fall back to raw table scan
    // because the rollup table doesn't track per-cashier data
    if (filters?.cashierId) {
      return this.getSalesSummary(pool, filters);
    }

    const whereClauses: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (filters?.startDate) {
      whereClauses.push(`sale_date >= $${paramIndex++}::date`);
      values.push(filters.startDate);
    }

    if (filters?.endDate) {
      whereClauses.push(`sale_date <= $${paramIndex++}::date`);
      values.push(filters.endDate);
    }

    const whereClause = whereClauses.length > 0
      ? 'WHERE ' + whereClauses.join(' AND ')
      : '';

    const summaryResult = await pool.query(
      `SELECT
        COALESCE(SUM(transaction_count), 0)     AS total_sales,
        COALESCE(SUM(total_amount), 0)           AS total_amount,
        COALESCE(SUM(total_cost), 0)             AS total_cost,
        COALESCE(SUM(total_profit), 0)           AS total_profit,
        COALESCE(SUM(total_discounts), 0)        AS total_discounts,
        COALESCE(SUM(credit_count), 0)           AS credit_count,
        COALESCE(SUM(partial_payment_count), 0)  AS partial_count
       FROM sales_daily_summary
       ${whereClause}`,
      values
    );

    const paymentMethodResult = await pool.query(
      `SELECT
        payment_method,
        SUM(transaction_count)::INTEGER AS count,
        COALESCE(SUM(total_amount), 0)  AS total_amount
       FROM sales_daily_summary
       ${whereClause}
       GROUP BY payment_method
       ORDER BY total_amount DESC`,
      values
    );

    return {
      totalSales: parseInt(summaryResult.rows[0].total_sales),
      totalAmount: parseFloat(summaryResult.rows[0].total_amount),
      totalCost: parseFloat(summaryResult.rows[0].total_cost),
      totalProfit: parseFloat(summaryResult.rows[0].total_profit),
      totalDiscounts: parseFloat(summaryResult.rows[0].total_discounts),
      creditSalesCount: parseInt(summaryResult.rows[0].credit_count),
      partialPaymentCount: parseInt(summaryResult.rows[0].partial_count),
      byPaymentMethod: paymentMethodResult.rows.map((row: Record<string, unknown>) => ({
        paymentMethod: row.payment_method,
        count: parseInt(String(row.count)),
        totalAmount: parseFloat(String(row.total_amount)),
      })),
    };
  },

  /**
   * Reconciliation: Compare rollup table totals against raw sales table.
   * Returns drift per (sale_date, payment_method) where values differ.
   */
  async reconcileDailySummary(
    pool: Pool,
    startDate?: string,
    endDate?: string
  ): Promise<{ drifts: Record<string, unknown>[]; isClean: boolean }> {
    const whereClauses: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (startDate) {
      whereClauses.push(`s.sale_date >= $${paramIndex++}::date`);
      values.push(startDate);
    }
    if (endDate) {
      whereClauses.push(`s.sale_date <= $${paramIndex++}::date`);
      values.push(endDate);
    }

    const saleWhere = whereClauses.length > 0
      ? 'AND ' + whereClauses.join(' AND ')
      : '';

    // Build equivalent WHERE for rollup table (uses different alias)
    const rollupWhereClauses = whereClauses.map(c => c.replace(/s\.sale_date/g, 'r.sale_date'));
    const rollupWhere = rollupWhereClauses.length > 0
      ? 'AND ' + rollupWhereClauses.join(' AND ')
      : '';

    const result = await pool.query(
      `WITH actual AS (
          SELECT
            sale_date,
            payment_method::text AS payment_method,
            COUNT(*)::INTEGER AS transaction_count,
            COALESCE(SUM(total_amount), 0) AS total_amount,
            COALESCE(SUM(total_cost), 0) AS total_cost,
            COALESCE(SUM(discount_amount), 0) AS total_discounts
          FROM sales s
          WHERE status = 'COMPLETED' ${saleWhere}
          GROUP BY sale_date, payment_method
       ),
       rollup AS (
          SELECT sale_date, payment_method, transaction_count,
                 total_amount, total_cost, total_discounts
          FROM sales_daily_summary r
          WHERE 1=1 ${rollupWhere}
       )
       SELECT
          COALESCE(a.sale_date, r.sale_date) AS sale_date,
          COALESCE(a.payment_method, r.payment_method) AS payment_method,
          a.transaction_count AS actual_count,
          r.transaction_count AS rollup_count,
          a.total_amount AS actual_amount,
          r.total_amount AS rollup_amount
       FROM actual a
       FULL OUTER JOIN rollup r
         ON a.sale_date = r.sale_date AND a.payment_method = r.payment_method
       WHERE a.transaction_count IS DISTINCT FROM r.transaction_count
          OR ABS(COALESCE(a.total_amount,0) - COALESCE(r.total_amount,0)) > 0.01
       ORDER BY COALESCE(a.sale_date, r.sale_date) DESC
       LIMIT 100`,
      values
    );

    return {
      drifts: result.rows,
      isClean: result.rows.length === 0,
    };
  },

  /**
   * Full rebuild of the rollup table from raw sales data.
   * Use to heal drift or after bulk data operations.
   */
  async rebuildDailySummary(pool: Pool): Promise<number> {
    const result = await pool.query(`
      INSERT INTO sales_daily_summary (
          sale_date, payment_method,
          transaction_count, total_amount, total_cost, total_profit, total_discounts,
          credit_count, partial_payment_count, updated_at
      )
      SELECT
          sale_date,
          payment_method,
          COUNT(*)::INTEGER,
          COALESCE(SUM(total_amount), 0),
          COALESCE(SUM(total_cost), 0),
          COALESCE(SUM(total_amount - COALESCE(total_cost, 0)), 0),
          COALESCE(SUM(discount_amount), 0),
          COUNT(*) FILTER (WHERE payment_method = 'CREDIT')::INTEGER,
          COUNT(*) FILTER (WHERE payment_method = 'CREDIT'
              AND amount_paid > 0
              AND amount_paid < total_amount)::INTEGER,
          NOW()
      FROM sales
      WHERE status = 'COMPLETED'
      GROUP BY sale_date, payment_method
      ON CONFLICT (sale_date, payment_method) DO UPDATE SET
          transaction_count     = EXCLUDED.transaction_count,
          total_amount          = EXCLUDED.total_amount,
          total_cost            = EXCLUDED.total_cost,
          total_profit          = EXCLUDED.total_profit,
          total_discounts       = EXCLUDED.total_discounts,
          credit_count          = EXCLUDED.credit_count,
          partial_payment_count = EXCLUDED.partial_payment_count,
          updated_at            = NOW()
    `);
    return result.rowCount ?? 0;
  },
};
