// Product History Service - business logic aggregation

import Decimal from 'decimal.js';
import type pg from 'pg';
import { applyProductHistoryRunningBalances } from '../../../../shared/utils/productHistoryRunningBalance.js';
import { productHistoryRepository } from './productHistoryRepository.js';
import * as productRepository from './productRepository.js';
import type {
  ProductHistoryItem,
  ProductHistorySummary,
} from '../../../../shared/zod/product-history.js';

export interface HistoryServiceFilters {
  startDate?: string;
  endDate?: string;
  type?: string;
  page?: number;
  limit?: number;
}

export const productHistoryService = {
  async getProductHistory(
    productId: string,
    filters: HistoryServiceFilters = {},
    dbPool?: pg.Pool
  ): Promise<{
    items: ProductHistoryItem[];
    summary: ProductHistorySummary;
    pagination: { page: number; limit: number; total: number; totalPages: number };
  }> {
    const page = filters.page && filters.page > 0 ? filters.page : 1;
    const limit = filters.limit && filters.limit > 0 ? Math.min(filters.limit, 200) : 100;

    // Fetch product for costing method
    const product = await productRepository.findProductById(productId, dbPool);
    if (!product) {
      throw new Error(`Product ${productId} not found`);
    }

    // Fetch all event types (filter by type later if provided)
    const [grRows, saleRows, moveRows] = await Promise.all([
      productHistoryRepository.getGoodsReceiptEvents(productId, filters, dbPool),
      productHistoryRepository.getSaleEvents(productId, filters, dbPool),
      productHistoryRepository.getStockMovementEvents(
        productId,
        filters.type ? { ...filters, type: filters.type } : filters,
        dbPool
      ),
    ]);

    // Normalize records to ProductHistoryItem
    const normalized: ProductHistoryItem[] = [];

    for (const r of grRows) {
      normalized.push({
        eventDate: r.event_date,
        type: 'GOODS_RECEIPT',
        quantityChange: new Decimal(r.quantity_change || r.received_quantity || 0).toNumber(),
        unitCost: r.unit_cost ?? undefined,
        totalCost: r.total_cost ?? undefined,
        batchNumber: r.batch_number ?? null,
        expiryDate: r.expiry_date ?? null,
        uomId: r.uom_id ?? undefined,
        uomName: r.uom_name ?? undefined,
        uomSymbol: r.uom_symbol ?? undefined,
        reference: {
          grId: r.gr_id,
          grNumber: r.gr_number,
          grStatus: r.gr_status ?? undefined,
          receivedDate: r.received_date ?? undefined,
          supplierDeliveryNote: r.supplier_delivery_note ?? undefined,
          poId: r.po_id ?? undefined,
          poNumber: r.po_number ?? undefined,
          supplierId: r.supplier_id ?? undefined,
          supplierName: r.supplier_name ?? undefined,
          receivedByName: r.received_by_name ?? undefined,
          orderedQuantity: r.ordered_quantity ?? undefined,
          poUnitPrice: r.po_unit_price ?? undefined,
          qtyVariance: r.qty_variance ?? undefined,
          costVariance: r.cost_variance ?? undefined,
          batchStatus: r.batch_status ?? undefined,
          batchRemainingQty: r.batch_remaining_qty != null ? new Decimal(r.batch_remaining_qty).toNumber() : undefined,
        },
      });
    }

    for (const r of saleRows) {
      normalized.push({
        eventDate: r.event_date,
        type: 'SALE',
        quantityChange: new Decimal(r.quantity_change || -r.quantity || 0).toNumber(),
        unitPrice: r.unit_price ?? undefined,
        lineTotal: r.line_total ?? undefined,
        unitCost: r.cost_price ?? undefined,
        batchNumber: r.batch_number ?? null,
        expiryDate: r.expiry_date ?? null,
        uomId: r.uom_id ?? undefined,
        uomName: r.uom_name ?? undefined,
        uomSymbol: r.uom_symbol ?? undefined,
        reference: {
          saleId: r.sale_id,
          saleNumber: r.sale_number,
          saleItemId: r.sale_item_id ?? undefined,
          saleStatus: r.sale_status ?? undefined,
          customerId: r.customer_id ?? undefined,
          customerName: r.customer_name ?? undefined,
          soldByName: r.sold_by_name ?? undefined,
          paymentMethod: r.payment_method ?? undefined,
          paymentReceived: r.payment_received ?? undefined,
          changeAmount: r.change_amount ?? undefined,
          totalAmount: r.total_amount ?? undefined,
          batchStatus: r.batch_status ?? undefined,
          batchRemainingQty: r.batch_remaining_qty != null ? new Decimal(r.batch_remaining_qty).toNumber() : undefined,
        },
      });
    }

    for (const r of moveRows) {
      normalized.push({
        eventDate: r.event_date,
        type: r.type,
        quantityChange: new Decimal(r.quantity_change || r.quantity || 0).toNumber(),
        batchNumber: r.batch_number ?? null,
        expiryDate: r.expiry_date ?? null,
        uomId: r.uom_id ?? undefined,
        uomName: r.uom_name ?? undefined,
        uomSymbol: r.uom_symbol ?? undefined,
        reference: {
          movementId: r.movement_id,
          referenceType: r.reference_type ?? undefined,
          referenceId: r.reference_id ?? undefined,
          notes: r.notes ?? undefined,
          actorName: r.actor_name ?? undefined,
        },
      } as unknown as ProductHistoryItem);
    }

    // Optional type filter applied across all events
    const filtered = filters.type ? normalized.filter((x) => x.type === filters.type) : normalized;

    // Sort desc by date (UI newest-first). Balances use original-index SSOT —
    // never date|type|qty keys (collides on multi-line same-second sales).
    filtered.sort((a, b) => new Date(b.eventDate).getTime() - new Date(a.eventDate).getTime());

    const balanced = applyProductHistoryRunningBalances(filtered, {
      fallbackUnitCost:
        product.costPrice != null ? Number(product.costPrice) : undefined,
    });
    const withBalanceDesc = balanced.items as ProductHistoryItem[];
    const summary: ProductHistorySummary = balanced.summary;

    const total = withBalanceDesc.length;
    const totalPages = Math.ceil(total / limit) || 1;
    const start = (page - 1) * limit;
    const items = withBalanceDesc.slice(start, start + limit);

    return {
      items,
      summary,
      pagination: { page, limit, total, totalPages },
    };
  },
};
