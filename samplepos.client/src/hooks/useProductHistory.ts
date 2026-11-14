/**
 * React Query hook for Product History Timeline
 * 
 * Fetches complete product activity history including:
 * - Goods receipts with PO/supplier details
 * - Sales with customer details
 * - Stock movements (adjustments, transfers, etc.)
 * 
 * Features:
 * - Running quantity and valuation tracking
 * - Summary statistics (IN/OUT totals, date range)
 * - Pagination and filtering support
 * - Type-safe with Zod schemas
 */

import { useQuery } from '@tanstack/react-query';
import { api, type ApiResponse } from '../utils/api';
import { productKeys } from './useProducts';

// History Item Types (matching backend enum)
export type ProductHistoryType =
  | 'GOODS_RECEIPT'
  | 'SALE'
  | 'ADJUSTMENT_IN'
  | 'ADJUSTMENT_OUT'
  | 'TRANSFER_IN'
  | 'TRANSFER_OUT'
  | 'RETURN'
  | 'DAMAGE'
  | 'EXPIRY'
  | 'OPENING_BALANCE';

// Type-safe history item interface
export interface ProductHistoryItem {
  eventDate: string; // ISO datetime
  type: ProductHistoryType;
  quantityChange: number; // positive for IN, negative for OUT
  unitCost?: number;
  totalCost?: number;
  unitPrice?: number;
  lineTotal?: number;
  batchNumber?: string | null;
  expiryDate?: string | null; // ISO datetime
  runningQuantity?: number;
  runningValuation?: number;
  averageCost?: number;
  // UOM fields - optional for backward compatibility
  uomId?: string | null;
  uomName?: string | null;
  uomSymbol?: string | null;
  reference?: {
    // Goods Receipt fields
    grId?: string;
    grNumber?: string;
    grStatus?: string;
    receivedDate?: string;
    supplierDeliveryNote?: string;
    poId?: string;
    poNumber?: string;
    supplierId?: string;
    supplierName?: string;
    receivedByName?: string;
    orderedQuantity?: number;
    poUnitPrice?: number;
    qtyVariance?: number;
    costVariance?: number;

    // Sale fields
    saleId?: string;
    saleNumber?: string;
    saleItemId?: string;
    saleStatus?: string;
    customerId?: string;
    customerName?: string;
    soldByName?: string;
    paymentMethod?: string;
    paymentReceived?: number;
    changeAmount?: number;
    totalAmount?: number;
    batchStatus?: string;
    batchRemainingQty?: number;

    // Stock movement fields
    movementId?: string;
    referenceType?: string;
    referenceId?: string;
    notes?: string;
    // Actor — the user who performed this action
    actorName?: string;
  };
}

export interface ProductHistorySummary {
  firstMovementDate?: string;
  lastMovementDate?: string;
  totalInQuantity: number;
  totalOutQuantity: number;
  netQuantityChange: number;
  totalInValue: number;
  totalOutValue: number;
  currentValuation?: number;
}

export interface ProductHistoryFilters {
  page?: number;
  limit?: number;
  startDate?: string; // ISO datetime
  endDate?: string;   // ISO datetime
  type?: ProductHistoryType;
}

export interface ProductHistoryResponse {
  items: ProductHistoryItem[];
  summary: ProductHistorySummary;
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

// Query key factory
export const productHistoryKeys = {
  all: (productId: string) => [...productKeys.detail(productId), 'history'] as const,
  filtered: (productId: string, filters: ProductHistoryFilters) =>
    [...productHistoryKeys.all(productId), filters] as const,
};

/**
 * Fetch product history timeline with filters
 * 
 * @example
 * ```tsx
 * const { data, isLoading, error } = useProductHistory(productId, {
 *   page: 1,
 *   limit: 50,
 *   type: 'GOODS_RECEIPT',
 *   startDate: '2025-01-01T00:00:00.000Z'
 * });
 * 
 * if (data) {
 *   console.log('Summary:', data.summary);
 *   data.items.forEach(item => {
 *     console.log(`${item.type}: ${item.quantityChange} @ ${item.eventDate}`);
 *   });
 * }
 * ```
 */
export function useProductHistory(
  productId: string,
  filters: ProductHistoryFilters = {}
) {
  return useQuery({
    queryKey: productHistoryKeys.filtered(productId, filters),
    queryFn: async (): Promise<ProductHistoryResponse> => {
      const response = await api.products.history(productId, {
        page: filters.page,
        limit: filters.limit,
        startDate: filters.startDate,
        endDate: filters.endDate,
        type: filters.type,
      });

      if (!response.data.success) {
        throw new Error(response.data.error || 'Failed to fetch product history');
      }

      return {
        items: (response.data.data ?? []) as ProductHistoryItem[],
        summary: (response.data as ApiResponse & { summary?: ProductHistorySummary }).summary || {
          totalInQuantity: 0,
          totalOutQuantity: 0,
          netQuantityChange: 0,
          totalInValue: 0,
          totalOutValue: 0,
        },
        pagination: response.data.pagination || { page: 1, limit: 100, total: 0, totalPages: 0 },
      };
    },
    enabled: !!productId,
    staleTime: 30000, // 30 seconds
  });
}

// Utility helpers for UI rendering

/**
 * Get color/badge variant for history event type
 */
export function getHistoryTypeVariant(type: ProductHistoryType): {
  color: string;
  bgColor: string;
  label: string;
} {
  const variants: Record<ProductHistoryType, { color: string; bgColor: string; label: string }> = {
    GOODS_RECEIPT: { color: 'text-green-700', bgColor: 'bg-green-100', label: 'Received' },
    SALE: { color: 'text-blue-700', bgColor: 'bg-blue-100', label: 'Sale' },
    ADJUSTMENT_IN: { color: 'text-emerald-700', bgColor: 'bg-emerald-100', label: 'Adj. In' },
    ADJUSTMENT_OUT: { color: 'text-orange-700', bgColor: 'bg-orange-100', label: 'Adj. Out' },
    TRANSFER_IN: { color: 'text-teal-700', bgColor: 'bg-teal-100', label: 'Transfer In' },
    TRANSFER_OUT: { color: 'text-amber-700', bgColor: 'bg-amber-100', label: 'Transfer Out' },
    RETURN: { color: 'text-purple-700', bgColor: 'bg-purple-100', label: 'Return' },
    DAMAGE: { color: 'text-red-700', bgColor: 'bg-red-100', label: 'Damage' },
    EXPIRY: { color: 'text-gray-700', bgColor: 'bg-gray-100', label: 'Expiry' },
    OPENING_BALANCE: { color: 'text-cyan-700', bgColor: 'bg-cyan-100', label: 'Opening Bal.' },
  };
  return variants[type];
}

/**
 * Format quantity change with +/- sign
 */
export function formatQuantityChange(qty: number): string {
  const sign = qty >= 0 ? '+' : '';
  return `${sign}${qty}`;
}

/**
 * Check if batch is expiring soon (within 30 days)
 */
export function isExpiringSoon(expiryDate: string | null | undefined): boolean {
  if (!expiryDate) return false;
  const expiry = new Date(expiryDate);
  const now = new Date();
  const daysDiff = Math.ceil((expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
  return daysDiff <= 30 && daysDiff >= 0;
}

/**
 * Format reference info for display
 */
export function formatHistoryReference(item: ProductHistoryItem): string {
  const ref = item.reference;
  if (!ref) return '';

  switch (item.type) {
    case 'GOODS_RECEIPT':
      return `GR ${ref.grNumber}${ref.poNumber ? ` (PO ${ref.poNumber})` : ''}${ref.supplierName ? ` - ${ref.supplierName}` : ''}`;
    case 'SALE':
      return `${ref.saleNumber}${ref.customerName ? ` - ${ref.customerName}` : ''}${ref.paymentMethod ? ` • ${ref.paymentMethod}` : ''}`;
    case 'OPENING_BALANCE':
      return `Opening stock import${ref.notes ? ` — ${ref.notes}` : ''}`;
    default:
      return ref.notes || ref.referenceType || '';
  }
}

/**
 * Get the actor (user) name and label for a history event
 */
export function getHistoryActor(item: ProductHistoryItem): { label: string; name: string } | null {
  const labels: Record<ProductHistoryType, string> = {
    GOODS_RECEIPT: 'Received by',
    SALE: 'Sold by',
    ADJUSTMENT_IN: 'Adjusted by',
    ADJUSTMENT_OUT: 'Adjusted by',
    TRANSFER_IN: 'Transferred by',
    TRANSFER_OUT: 'Transferred by',
    RETURN: 'Returned by',
    DAMAGE: 'Recorded by',
    EXPIRY: 'Recorded by',
    OPENING_BALANCE: 'Set by',
  };

  let name: string | undefined;
  switch (item.type) {
    case 'GOODS_RECEIPT':
      name = item.reference?.receivedByName;
      break;
    case 'SALE':
      name = item.reference?.soldByName;
      break;
    default:
      name = item.reference?.actorName;
  }

  if (!name) return null;
  return { label: labels[item.type] ?? 'By', name };
}
