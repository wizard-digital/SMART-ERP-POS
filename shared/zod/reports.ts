// Shared Zod Schemas - Reports
// Used by both frontend and backend for validation

import { z } from 'zod';
import { LOT_WRITE_DOWN_MAX_DAYS } from '../inventory-lot/lotWriteDown.js';

// Report Types
export const ReportTypeEnum = z.enum([
  'INVENTORY_VALUATION',
  'INVENTORY_ADJUSTMENTS',
  'SALES_REPORT',
  'EXPIRING_ITEMS',
  'LOW_STOCK',
  'BEST_SELLING_PRODUCTS',
  'SUPPLIER_COST_ANALYSIS',
  'GOODS_RECEIVED',
  'PAYMENT_REPORT',
  'CUSTOMER_PAYMENTS',
  'DELETED_ITEMS',
  'DELETED_CUSTOMERS',
  'PRODUCT_SALES_DETAIL',
  'PROFIT_LOSS',
  // New enhanced reports
  'PURCHASE_ORDER_SUMMARY',
  'STOCK_MOVEMENT_ANALYSIS',
  'CUSTOMER_ACCOUNT_STATEMENT',
  'PROFIT_MARGIN_BY_PRODUCT',
  'DAILY_CASH_FLOW',
  'SUPPLIER_PAYMENT_STATUS',
  'TOP_CUSTOMERS',
  'STOCK_AGING',
  'WASTE_DAMAGE_REPORT',
  'REORDER_RECOMMENDATIONS',
  // Additional sales analysis reports
  'SALES_BY_CATEGORY',
  'SALES_BY_PAYMENT_METHOD',
  'HOURLY_SALES_ANALYSIS',
  'SALES_COMPARISON',
  'CUSTOMER_PURCHASE_HISTORY',
  // Business intelligence reports
  'BUSINESS_POSITION',
  // Cash register session reports
  'CASH_REGISTER_SESSION_SUMMARY',
  'CASH_REGISTER_MOVEMENT_BREAKDOWN',
  'CASH_REGISTER_SESSION_HISTORY',
  // Delivery, quotation, accounting, banking reports
  'DELIVERY_NOTES',
  'QUOTATIONS',
  'MANUAL_JOURNAL_ENTRIES',
  'BANK_TRANSACTIONS',
  // Category Intelligence
  'CATEGORY_INTELLIGENCE',
]);
export type ReportType = z.infer<typeof ReportTypeEnum>;

// Base report request schema
export const ReportRequestSchema = z.object({
  reportType: ReportTypeEnum,
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  format: z.enum(['pdf', 'csv', 'json']).default('json'),
  filters: z.record(z.any()).optional(),
}).strict();

// Inventory Valuation Report
export const InventoryValuationRequestSchema = z.object({
  reportType: z.literal('INVENTORY_VALUATION'),
  asOfDate: z.string().optional(),
  categoryId: z.string().uuid().optional(),
  valuationMethod: z.enum(['FIFO', 'AVCO', 'LIFO']).default('FIFO'),
  format: z.enum(['pdf', 'csv', 'json']).default('json'),
}).strict();

export const InventoryValuationItemSchema = z.object({
  productId: z.string().uuid(),
  productName: z.string(),
  sku: z.string().optional(),
  category: z.string().optional(),
  quantityOnHand: z.number().nonnegative(),
  unitCost: z.number().nonnegative(),
  totalValue: z.number().nonnegative(),
  lastUpdated: z.string().optional(),
}).strict();

// Sales Report
export const SalesReportRequestSchema = z.object({
  reportType: z.literal('SALES_REPORT'),
  startDate: z.string(),
  endDate: z.string(),
  groupBy: z
    .enum([
      'day',
      'week',
      'month',
      'product',
      'customer',
      'payment_method',
      'cashier',
      'category',
    ])
    .optional(),
  customerId: z.string().uuid().optional(),
  format: z.enum(['pdf', 'csv', 'json']).default('json'),
}).strict();

export const SalesReportItemSchema = z.object({
  period: z.string(),
  totalSales: z.number().nonnegative(),
  totalCost: z.number().nonnegative(),
  grossProfit: z.number(),
  profitMargin: z.number(),
  transactionCount: z.number().int().nonnegative(),
  averageTransactionValue: z.number().nonnegative(),
}).strict();

// Expiring Items Report
export const ExpiringItemsRequestSchema = z.object({
  reportType: z.literal('EXPIRING_ITEMS'),
  daysAhead: z.number().int().positive().default(LOT_WRITE_DOWN_MAX_DAYS),
  categoryId: z.string().uuid().optional(),
  format: z.enum(['pdf', 'csv', 'json']).default('json'),
}).strict();

export const ExpiringItemSchema = z.object({
  batchId: z.string().uuid(),
  productId: z.string().uuid(),
  productName: z.string(),
  batchNumber: z.string(),
  expiryDate: z.string(),
  daysUntilExpiry: z.number().int(),
  quantityRemaining: z.number().nonnegative(),
  unitCost: z.number().nonnegative(),
  potentialLoss: z.number().nonnegative(),
}).strict();

// Low Stock Report
export const LowStockRequestSchema = z.object({
  reportType: z.literal('LOW_STOCK'),
  threshold: z.number().nonnegative().optional(),
  categoryId: z.string().uuid().optional(),
  format: z.enum(['pdf', 'csv', 'json']).default('json'),
}).strict();

export const LowStockItemSchema = z.object({
  productId: z.string().uuid(),
  productName: z.string(),
  sku: z.string().optional(),
  currentStock: z.number().nonnegative(),
  reorderLevel: z.number().nonnegative(),
  reorderQuantity: z.number().nonnegative().optional(),
  daysOfStockRemaining: z.number().nonnegative().optional(),
  status: z.enum(['CRITICAL', 'LOW', 'WARNING']),
}).strict();

// Best Selling Products Report
export const BestSellingRequestSchema = z.object({
  reportType: z.literal('BEST_SELLING_PRODUCTS'),
  startDate: z.string(),
  endDate: z.string(),
  limit: z.number().int().positive().default(20),
  categoryId: z.string().uuid().optional(),
  format: z.enum(['pdf', 'csv', 'json']).default('json'),
}).strict();

export const BestSellingProductSchema = z.object({
  productId: z.string().uuid(),
  productName: z.string(),
  sku: z.string().optional(),
  quantitySold: z.number().nonnegative(),
  totalRevenue: z.number().nonnegative(),
  totalCost: z.number().nonnegative(),
  grossProfit: z.number(),
  profitMargin: z.number(),
  transactionCount: z.number().int().nonnegative(),
}).strict();

// Supplier Cost Analysis Report
export const SupplierCostRequestSchema = z.object({
  reportType: z.literal('SUPPLIER_COST_ANALYSIS'),
  startDate: z.string(),
  endDate: z.string(),
  supplierId: z.string().uuid().optional(),
  format: z.enum(['pdf', 'csv', 'json']).default('json'),
}).strict();

export const SupplierCostItemSchema = z.object({
  supplierId: z.string().uuid(),
  supplierName: z.string(),
  totalPurchaseOrders: z.number().int().nonnegative(),
  totalPurchaseValue: z.number().nonnegative(),
  totalItemsReceived: z.number().nonnegative(),
  averageLeadTime: z.number().nonnegative().optional(),
  onTimeDeliveryRate: z.number().nonnegative().optional(),
}).strict();

// Goods Received Report
export const GoodsReceivedRequestSchema = z.object({
  reportType: z.literal('GOODS_RECEIVED'),
  startDate: z.string(),
  endDate: z.string(),
  supplierId: z.string().uuid().optional(),
  productId: z.string().uuid().optional(),
  format: z.enum(['pdf', 'csv', 'json']).default('json'),
}).strict();

export const GoodsReceivedItemSchema = z.object({
  goodsReceiptId: z.string().uuid(),
  goodsReceiptNumber: z.string(),
  purchaseOrderNumber: z.string(),
  supplierName: z.string(),
  receivedDate: z.string(),
  totalValue: z.number().nonnegative(),
  itemsCount: z.number().int().nonnegative(),
  status: z.string(),
}).strict();

// Payment Report
export const PaymentReportRequestSchema = z.object({
  reportType: z.literal('PAYMENT_REPORT'),
  startDate: z.string(),
  endDate: z.string(),
  paymentMethod: z.enum(['CASH', 'CARD', 'MOBILE_MONEY', 'BANK_TRANSFER', 'CREDIT']).optional(),
  format: z.enum(['pdf', 'csv', 'json']).default('json'),
}).strict();

export const PaymentReportItemSchema = z.object({
  paymentMethod: z.string(),
  transactionCount: z.number().int().nonnegative(),
  totalAmount: z.number().nonnegative(),
  averageAmount: z.number().nonnegative(),
  percentageOfTotal: z.number().nonnegative(),
}).strict();

// Customer Payments Report
export const CustomerPaymentsRequestSchema = z.object({
  reportType: z.literal('CUSTOMER_PAYMENTS'),
  startDate: z.string(),
  endDate: z.string(),
  customerId: z.string().uuid().optional(),
  status: z.enum(['PAID', 'PARTIALLY_PAID', 'UNPAID', 'OVERDUE']).optional(),
  format: z.enum(['pdf', 'csv', 'json']).default('json'),
}).strict();

export const CustomerPaymentItemSchema = z.object({
  customerId: z.string().uuid(),
  customerName: z.string(),
  totalInvoices: z.number().int().nonnegative(),
  totalInvoiced: z.number().nonnegative(),
  totalPaid: z.number().nonnegative(),
  totalOutstanding: z.number().nonnegative(),
  overdueAmount: z.number().nonnegative(),
  averagePaymentDays: z.number().nonnegative().optional(),
}).strict();

// Profit & Loss Report
export const ProfitLossRequestSchema = z.object({
  reportType: z.literal('PROFIT_LOSS'),
  startDate: z.string(),
  endDate: z.string(),
  groupBy: z.enum(['day', 'week', 'month']).default('month'),
  format: z.enum(['pdf', 'csv', 'json']).default('json'),
}).strict();

export const ProfitLossItemSchema = z.object({
  period: z.string(),
  revenue: z.number().nonnegative(),
  costOfGoodsSold: z.number().nonnegative(),
  grossProfit: z.number(),
  grossProfitMargin: z.number(),
  operatingExpenses: z.number().nonnegative().optional(),
  netProfit: z.number().optional(),
  netProfitMargin: z.number().optional(),
}).strict();

// Deleted Items Report
export const DeletedItemsRequestSchema = z.object({
  reportType: z.literal('DELETED_ITEMS'),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  format: z.enum(['pdf', 'csv', 'json']).default('json'),
}).strict();

// Generic report response
export const ReportResponseSchema = z.object({
  reportType: ReportTypeEnum,
  reportName: z.string(),
  generatedAt: z.string(),
  generatedBy: z.string().optional(),
  parameters: z.record(z.any()),
  data: z.array(z.any()),
  summary: z.record(z.any()).optional(),
  recordCount: z.number().int().nonnegative(),
  executionTimeMs: z.number().int().nonnegative().optional(),
}).strict();

// Export types
export type ReportRequest = z.infer<typeof ReportRequestSchema>;
export type InventoryValuationRequest = z.infer<typeof InventoryValuationRequestSchema>;
export type InventoryValuationItem = z.infer<typeof InventoryValuationItemSchema>;
export type SalesReportRequest = z.infer<typeof SalesReportRequestSchema>;
export type SalesReportItem = z.infer<typeof SalesReportItemSchema>;
export type ExpiringItemsRequest = z.infer<typeof ExpiringItemsRequestSchema>;
export type ExpiringItem = z.infer<typeof ExpiringItemSchema>;
export type LowStockRequest = z.infer<typeof LowStockRequestSchema>;
export type LowStockItem = z.infer<typeof LowStockItemSchema>;
export type BestSellingRequest = z.infer<typeof BestSellingRequestSchema>;
export type BestSellingProduct = z.infer<typeof BestSellingProductSchema>;
export type SupplierCostRequest = z.infer<typeof SupplierCostRequestSchema>;
export type SupplierCostItem = z.infer<typeof SupplierCostItemSchema>;
export type GoodsReceivedRequest = z.infer<typeof GoodsReceivedRequestSchema>;
export type GoodsReceivedItem = z.infer<typeof GoodsReceivedItemSchema>;
export type PaymentReportRequest = z.infer<typeof PaymentReportRequestSchema>;
export type PaymentReportItem = z.infer<typeof PaymentReportItemSchema>;
export type CustomerPaymentsRequest = z.infer<typeof CustomerPaymentsRequestSchema>;
export type CustomerPaymentItem = z.infer<typeof CustomerPaymentItemSchema>;
export type ProfitLossRequest = z.infer<typeof ProfitLossRequestSchema>;
export type ProfitLossItem = z.infer<typeof ProfitLossItemSchema>;
export type DeletedItemsRequest = z.infer<typeof DeletedItemsRequestSchema>;
export type ReportResponse = z.infer<typeof ReportResponseSchema>;

// Query Parameter Schemas for GET endpoints (snake_case)
// These match the req.query structure used by the controller

export const InventoryValuationParamsSchema = z.object({
  as_of_date: z.string().optional(),
  category_id: z.string().optional(),
  valuation_method: z.enum(['FIFO', 'AVCO', 'LIFO']).default('FIFO'),
  format: z.enum(['pdf', 'csv', 'json']).default('json'),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(1000).default(500),
});

export const SalesReportParamsSchema = z.object({
  start_date: z.string(),
  end_date: z.string(),
  group_by: z
    .enum([
      'day',
      'week',
      'month',
      'product',
      'customer',
      'payment_method',
      'cashier',
      'category',
    ])
    .optional(),
  customer_id: z.string().uuid().optional(),
  session_id: z.string().optional(),
  /** Comma-separated Sales Analysis column ids (matches UI designer). */
  columns: z.string().optional(),
  sort_by: z
    .enum([
      'netRevenue',
      'totalSales',
      'grossProfit',
      'profitMargin',
      'totalQuantitySold',
      'transactionCount',
      'period',
    ])
    .optional(),
  sort_dir: z.enum(['asc', 'desc']).optional(),
  top_n: z.enum(['all', '10', '20']).optional(),
  format: z.enum(['pdf', 'csv', 'json']).default('json'),
});

export const ExpiringItemsParamsSchema = z.object({
  days_threshold: z.coerce.number().int().positive().default(LOT_WRITE_DOWN_MAX_DAYS),
  category_id: z.string().uuid().optional(),
  /** KPI band filter for PDF/CSV — matches on-screen register filter. */
  urgency_band: z.enum(['all', 'expired', 'critical', 'warning', 'watch']).optional(),
  format: z.enum(['pdf', 'csv', 'json']).default('json'),
});

export const LowStockParamsSchema = z.object({
  threshold_percentage: z.coerce.number().nonnegative().optional(),
  category_id: z.string().uuid().optional(),
  format: z.enum(['pdf', 'csv', 'json']).default('json'),
});

export const BestSellingProductsParamsSchema = z.object({
  start_date: z.string(),
  end_date: z.string(),
  limit: z.coerce.number().int().positive().default(20),
  category_id: z.string().uuid().optional(),
  format: z.enum(['pdf', 'csv', 'json']).default('json'),
});

export const SupplierCostAnalysisParamsSchema = z.object({
  start_date: z.string(),
  end_date: z.string(),
  supplier_id: z.string().uuid().optional(),
  format: z.enum(['pdf', 'csv', 'json']).default('json'),
});

export const GoodsReceivedParamsSchema = z.object({
  start_date: z.string(),
  end_date: z.string(),
  supplier_id: z.string().uuid().optional(),
  product_id: z.string().uuid().optional(),
  format: z.enum(['pdf', 'csv', 'json']).default('json'),
});

export const PaymentReportParamsSchema = z.object({
  start_date: z.string(),
  end_date: z.string(),
  payment_method: z.enum(['CASH', 'CARD', 'MOBILE_MONEY', 'BANK_TRANSFER', 'CREDIT']).optional(),
  format: z.enum(['pdf', 'csv', 'json']).default('json'),
});

export const CustomerPaymentsParamsSchema = z.object({
  start_date: z.string(),
  end_date: z.string(),
  customer_id: z.string().uuid().optional(),
  status: z.enum(['PAID', 'PARTIALLY_PAID', 'UNPAID', 'OVERDUE']).optional(),
  format: z.enum(['pdf', 'csv', 'json']).default('json'),
});

export const ProfitLossParamsSchema = z.object({
  start_date: z.string(),
  end_date: z.string(),
  group_by: z.enum(['day', 'week', 'month']).default('month'),
  format: z.enum(['pdf', 'csv', 'json']).default('json'),
});

export const DeletedItemsParamsSchema = z.object({
  start_date: z.string().optional(),
  end_date: z.string().optional(),
  format: z.enum(['pdf', 'csv', 'json']).default('json'),
});

export const InventoryAdjustmentsParamsSchema = z.object({
  start_date: z.string(),
  end_date: z.string(),
  product_id: z.string().uuid().optional(),
  format: z.enum(['pdf', 'csv', 'json']).default('json'),
});

// ============================================================
// NEW ENHANCED REPORTS
// ============================================================

// Purchase Order Summary Report
export const PurchaseOrderSummaryRequestSchema = z.object({
  reportType: z.literal('PURCHASE_ORDER_SUMMARY'),
  startDate: z.string(),
  endDate: z.string(),
  supplierId: z.string().uuid().optional(),
  status: z.enum(['DRAFT', 'PENDING', 'COMPLETED', 'CANCELLED']).optional(),
  format: z.enum(['pdf', 'csv', 'json']).default('json'),
}).strict();

export const PurchaseOrderSummaryItemSchema = z.object({
  orderId: z.string().uuid(),
  orderNumber: z.string(),
  supplierName: z.string(),
  orderDate: z.string(),
  expectedDeliveryDate: z.string().optional(),
  status: z.string(),
  totalAmount: z.number().nonnegative(),
  itemCount: z.number().int().nonnegative(),
  receivedPercentage: z.number().nonnegative().optional(),
}).strict();

export const PurchaseOrderSummaryParamsSchema = z.object({
  start_date: z.string(),
  end_date: z.string(),
  supplier_id: z.string().uuid().optional(),
  status: z.enum(['DRAFT', 'PENDING', 'COMPLETED', 'CANCELLED']).optional(),
  format: z.enum(['pdf', 'csv', 'json']).default('json'),
});

// Stock Movement Analysis Report
export const StockMovementAnalysisRequestSchema = z.object({
  reportType: z.literal('STOCK_MOVEMENT_ANALYSIS'),
  startDate: z.string(),
  endDate: z.string(),
  productId: z.string().uuid().optional(),
  movementType: z.enum(['GOODS_RECEIPT', 'SALE', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'TRANSFER_IN', 'TRANSFER_OUT', 'RETURN', 'DAMAGE', 'EXPIRY']).optional(),
  format: z.enum(['pdf', 'csv', 'json']).default('json'),
}).strict();

export const StockMovementAnalysisItemSchema = z.object({
  movementDate: z.string(),
  productName: z.string(),
  movementType: z.string(),
  quantity: z.number(),
  unitCost: z.number().nonnegative().optional(),
  totalValue: z.number(),
  reference: z.string().optional(),
  notes: z.string().optional(),
}).strict();

export const StockMovementAnalysisParamsSchema = z.object({
  start_date: z.string(),
  end_date: z.string(),
  product_id: z.string().uuid().optional(),
  movement_type: z.enum(['GOODS_RECEIPT', 'SALE', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'TRANSFER_IN', 'TRANSFER_OUT', 'RETURN', 'DAMAGE', 'EXPIRY', 'OPENING_BALANCE']).optional(),
  format: z.enum(['pdf', 'csv', 'json']).default('json'),
});

// Customer Account Statement Report
export const CustomerAccountStatementRequestSchema = z.object({
  reportType: z.literal('CUSTOMER_ACCOUNT_STATEMENT'),
  customerId: z.string().uuid(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  format: z.enum(['pdf', 'csv', 'json']).default('json'),
}).strict();

export const CustomerAccountStatementItemSchema = z.object({
  transactionDate: z.string(),
  transactionType: z.enum(['SALE', 'PAYMENT', 'ADJUSTMENT', 'INVOICE']),
  referenceNumber: z.string(),
  description: z.string().optional(),
  debit: z.number().nonnegative(),
  credit: z.number().nonnegative(),
  balance: z.number(),
}).strict();

export const CustomerAccountStatementParamsSchema = z.object({
  customer_number: z.string().min(1), // Accept customer number like CUST-0001
  start_date: z.string().optional(),
  end_date: z.string().optional(),
  format: z.enum(['pdf', 'csv', 'json']).default('json'),
}).strict();

// Profit Margin by Product Report
export const ProfitMarginByProductRequestSchema = z.object({
  reportType: z.literal('PROFIT_MARGIN_BY_PRODUCT'),
  startDate: z.string(),
  endDate: z.string(),
  categoryId: z.string().uuid().optional(),
  minMargin: z.number().optional(),
  format: z.enum(['pdf', 'csv', 'json']).default('json'),
}).strict();

export const ProfitMarginByProductItemSchema = z.object({
  productId: z.string().uuid(),
  productName: z.string(),
  sku: z.string().optional(),
  category: z.string().optional(),
  quantitySold: z.number().nonnegative(),
  totalRevenue: z.number().nonnegative(),
  totalCost: z.number().nonnegative(),
  grossProfit: z.number(),
  profitMargin: z.number(),
  averageSellingPrice: z.number().nonnegative(),
  averageCostPrice: z.number().nonnegative(),
}).strict();

export const ProfitMarginByProductParamsSchema = z.object({
  start_date: z.string(),
  end_date: z.string(),
  category_id: z.string().uuid().optional(),
  min_margin: z.coerce.number().optional(),
  format: z.enum(['pdf', 'csv', 'json']).default('json'),
});

// Daily Cash Flow Report
export const DailyCashFlowRequestSchema = z.object({
  reportType: z.literal('DAILY_CASH_FLOW'),
  startDate: z.string(),
  endDate: z.string(),
  format: z.enum(['pdf', 'csv', 'json']).default('json'),
}).strict();

export const DailyCashFlowItemSchema = z.object({
  date: z.string(),
  openingBalance: z.number(),
  cashSales: z.number().nonnegative(),
  cardSales: z.number().nonnegative(),
  mobileMoneySales: z.number().nonnegative(),
  customerPayments: z.number().nonnegative(),
  supplierPayments: z.number().nonnegative(),
  otherIncome: z.number().nonnegative(),
  otherExpenses: z.number().nonnegative(),
  closingBalance: z.number(),
  netCashFlow: z.number(),
}).strict();

export const DailyCashFlowParamsSchema = z.object({
  start_date: z.string(),
  end_date: z.string(),
  format: z.enum(['pdf', 'csv', 'json']).default('json'),
});

// Supplier Payment Status Report
export const SupplierPaymentStatusRequestSchema = z.object({
  reportType: z.literal('SUPPLIER_PAYMENT_STATUS'),
  supplierId: z.string().uuid().optional(),
  status: z.enum(['PAID', 'PARTIALLY_PAID', 'UNPAID', 'OVERDUE']).optional(),
  format: z.enum(['pdf', 'csv', 'json']).default('json'),
}).strict();

export const SupplierPaymentStatusItemSchema = z.object({
  supplierId: z.string().uuid(),
  supplierName: z.string(),
  totalOrders: z.number().int().nonnegative(),
  totalAmount: z.number().nonnegative(),
  paidAmount: z.number().nonnegative(),
  outstandingAmount: z.number().nonnegative(),
  overdueAmount: z.number().nonnegative(),
  oldestUnpaidDate: z.string().optional(),
  paymentTerms: z.string().optional(),
}).strict();

export const SupplierPaymentStatusParamsSchema = z.object({
  supplier_id: z.string().uuid().optional(),
  status: z.enum(['PENDING', 'PAID', 'PARTIAL']).optional(),
  start_date: z.string().optional(),
  end_date: z.string().optional(),
  format: z.enum(['pdf', 'csv', 'json']).default('json'),
});

// Top Customers Report
export const TopCustomersRequestSchema = z.object({
  reportType: z.literal('TOP_CUSTOMERS'),
  startDate: z.string(),
  endDate: z.string(),
  limit: z.number().int().positive().default(25),
  sortBy: z.enum(['REVENUE', 'ORDERS', 'PROFIT']).default('REVENUE'),
  format: z.enum(['pdf', 'csv', 'json']).default('json'),
}).strict();

export const TopCustomersItemSchema = z.object({
  customerId: z.string().uuid(),
  customerName: z.string(),
  email: z.string().optional(),
  phone: z.string().optional(),
  totalOrders: z.number().int().nonnegative(),
  totalRevenue: z.number().nonnegative(),
  totalProfit: z.number(),
  averageOrderValue: z.number().nonnegative(),
  lastOrderDate: z.string().optional(),
}).strict();

export const TopCustomersParamsSchema = z.object({
  start_date: z.string(),
  end_date: z.string(),
  limit: z.coerce.number().int().positive().default(25),
  sort_by: z.enum(['REVENUE', 'ORDERS', 'PROFIT']).default('REVENUE'),
  format: z.enum(['pdf', 'csv', 'json']).default('json'),
});

// Stock Aging Report
export const StockAgingRequestSchema = z.object({
  reportType: z.literal('STOCK_AGING'),
  asOfDate: z.string().optional(),
  categoryId: z.string().uuid().optional(),
  format: z.enum(['pdf', 'csv', 'json']).default('json'),
}).strict();

export const StockAgingItemSchema = z.object({
  productId: z.string().uuid(),
  productName: z.string(),
  sku: z.string().optional(),
  batchNumber: z.string(),
  quantity: z.number().nonnegative(),
  receivedDate: z.string(),
  ageInDays: z.number().int().nonnegative(),
  ageCategory: z.enum(['0-30', '31-60', '61-90', '91-180', '180+']),
  unitCost: z.number().nonnegative(),
  totalValue: z.number().nonnegative(),
}).strict();

export const StockAgingParamsSchema = z.object({
  as_of_date: z.string().optional(),
  category_id: z.string().uuid().optional(),
  format: z.enum(['pdf', 'csv', 'json']).default('json'),
});

// Waste & Damage Report
export const WasteDamageRequestSchema = z.object({
  reportType: z.literal('WASTE_DAMAGE_REPORT'),
  startDate: z.string(),
  endDate: z.string(),
  reason: z.enum(['DAMAGE', 'EXPIRY', 'THEFT', 'OTHER']).optional(),
  format: z.enum(['pdf', 'csv', 'json']).default('json'),
}).strict();

export const WasteDamageItemSchema = z.object({
  date: z.string(),
  productName: z.string(),
  batchNumber: z.string().optional(),
  quantity: z.number().nonnegative(),
  unitCost: z.number().nonnegative(),
  totalLoss: z.number().nonnegative(),
  reason: z.string(),
  notes: z.string().optional(),
}).strict();

export const WasteDamageParamsSchema = z.object({
  start_date: z.string(),
  end_date: z.string(),
  reason: z.enum(['DAMAGE', 'EXPIRY', 'THEFT', 'OTHER']).optional(),
  format: z.enum(['pdf', 'csv', 'json']).default('json'),
});

// Reorder Recommendations Report
export const ReorderRecommendationsRequestSchema = z.object({
  reportType: z.literal('REORDER_RECOMMENDATIONS'),
  daysToConsider: z.number().int().positive().default(30),
  categoryId: z.string().uuid().optional(),
  format: z.enum(['pdf', 'csv', 'json']).default('json'),
}).strict();

export const ReorderRecommendationsItemSchema = z.object({
  productId: z.string().uuid(),
  productName: z.string(),
  sku: z.string().optional(),
  currentStock: z.number().nonnegative(),
  reorderLevel: z.number().nonnegative(),
  dailySalesVelocity: z.number().nonnegative(),
  daysUntilStockout: z.number().nullable(),
  suggestedOrderQuantity: z.number().nonnegative(),
  estimatedOrderCost: z.number().nonnegative(),
  preferredSupplier: z.string().nullable(),
  priority: z.enum(['URGENT', 'HIGH', 'MEDIUM']),
  leadTimeDays: z.number().int().nonnegative(),
  safetyStock: z.number().int().nonnegative(),
  reorderPoint: z.number().int().nonnegative(),
  demandTrend: z.enum(['INCREASING', 'DECREASING', 'STABLE']),
  trendRatio: z.number().nonnegative(),
  // Self-learning engine fields
  forecastDemand30d: z.number().nullable(),
  seasonalIndex: z.number().nullable(),
  learningCycles: z.number().int().nonnegative(),
});

export const ReorderRecommendationsParamsSchema = z.object({
  days_to_consider: z.coerce.number().int().positive().default(30),
  category_id: z.string().uuid().optional(),
  format: z.enum(['pdf', 'csv', 'json']).default('json'),
});

// Sales by Category Report
export const SalesByCategoryRequestSchema = z.object({
  reportType: z.literal('SALES_BY_CATEGORY'),
  startDate: z.string(),
  endDate: z.string(),
  category: z.string().optional(),
  format: z.enum(['pdf', 'csv', 'json']).default('json'),
}).strict();

export const SalesByCategoryItemSchema = z.object({
  category: z.string(),
  productCount: z.number().int().nonnegative(),
  totalQuantitySold: z.number().nonnegative(),
  totalRevenue: z.number().nonnegative(),
  totalCost: z.number().nonnegative(),
  grossProfit: z.number(),
  profitMargin: z.number(),
  transactionCount: z.number().int().nonnegative(),
  averageTransactionValue: z.number().nonnegative(),
}).strict();

export const SalesByCategoryParamsSchema = z.object({
  start_date: z.string(),
  end_date: z.string(),
  category: z.string().optional(),
  format: z.enum(['pdf', 'csv', 'json']).default('json'),
});

// Sales by Payment Method Report
export const SalesByPaymentMethodRequestSchema = z.object({
  reportType: z.literal('SALES_BY_PAYMENT_METHOD'),
  startDate: z.string(),
  endDate: z.string(),
  format: z.enum(['pdf', 'csv', 'json']).default('json'),
}).strict();

export const SalesByPaymentMethodItemSchema = z.object({
  paymentMethod: z.string(),
  transactionCount: z.number().int().nonnegative(),
  totalRevenue: z.number().nonnegative(),
  averageTransactionValue: z.number().nonnegative(),
  percentageOfTotal: z.number().nonnegative(),
}).strict();

export const SalesByPaymentMethodParamsSchema = z.object({
  start_date: z.string(),
  end_date: z.string(),
  format: z.enum(['pdf', 'csv', 'json']).default('json'),
});

// Hourly Sales Analysis Report
export const HourlySalesAnalysisRequestSchema = z.object({
  reportType: z.literal('HOURLY_SALES_ANALYSIS'),
  startDate: z.string(),
  endDate: z.string(),
  format: z.enum(['pdf', 'csv', 'json']).default('json'),
}).strict();

export const HourlySalesAnalysisItemSchema = z.object({
  hour: z.number().int().min(0).max(23),
  transactionCount: z.number().int().nonnegative(),
  totalRevenue: z.number().nonnegative(),
  averageTransactionValue: z.number().nonnegative(),
  peakDay: z.string().optional(),
}).strict();

export const HourlySalesAnalysisParamsSchema = z.object({
  start_date: z.string(),
  end_date: z.string(),
  format: z.enum(['pdf', 'csv', 'json']).default('json'),
});

// Sales Comparison Report (Period over Period)
export const SalesComparisonRequestSchema = z.object({
  reportType: z.literal('SALES_COMPARISON'),
  currentStartDate: z.string(),
  currentEndDate: z.string(),
  previousStartDate: z.string(),
  previousEndDate: z.string(),
  groupBy: z.enum(['day', 'week', 'month']).default('day'),
  format: z.enum(['pdf', 'csv', 'json']).default('json'),
}).strict();

export const SalesComparisonItemSchema = z.object({
  period: z.string(),
  previousPeriod: z.string().optional(),
  currentSales: z.number().nonnegative(),
  previousSales: z.number().nonnegative(),
  difference: z.number(),
  percentageChange: z.number().nullable(),
  currentTransactions: z.number().int().nonnegative(),
  previousTransactions: z.number().int().nonnegative(),
}).strict();

export const SalesComparisonParamsSchema = z.object({
  current_start_date: z.string(),
  current_end_date: z.string(),
  previous_start_date: z.string(),
  previous_end_date: z.string(),
  group_by: z.enum(['day', 'week', 'month']).default('day'),
  format: z.enum(['pdf', 'csv', 'json']).default('json'),
}).strict();

// Customer Purchase History Report
export const CustomerPurchaseHistoryRequestSchema = z.object({
  reportType: z.literal('CUSTOMER_PURCHASE_HISTORY'),
  customerId: z.string().uuid(),
  startDate: z.string(),
  endDate: z.string(),
  format: z.enum(['pdf', 'csv', 'json']).default('json'),
}).strict();

export const CustomerPurchaseHistoryItemSchema = z.object({
  saleId: z.string().uuid(),
  saleNumber: z.string(),
  saleDate: z.string(),
  totalAmount: z.number().nonnegative(),
  amountPaid: z.number().nonnegative(),
  outstandingBalance: z.number().nonnegative(),
  paymentMethod: z.string(),
  itemCount: z.number().int().nonnegative(),
  status: z.string(),
}).strict();

export const CustomerPurchaseHistoryParamsSchema = z.object({
  customer_id: z.string().min(1, 'Customer ID or number is required'),
  start_date: z.string(),
  end_date: z.string(),
  format: z.enum(['pdf', 'csv', 'json']).default('json'),
}).strict();

// Export new types
export type SalesByCategoryRequest = z.infer<typeof SalesByCategoryRequestSchema>;
export type SalesByCategoryItem = z.infer<typeof SalesByCategoryItemSchema>;
export type SalesByPaymentMethodRequest = z.infer<typeof SalesByPaymentMethodRequestSchema>;
export type SalesByPaymentMethodItem = z.infer<typeof SalesByPaymentMethodItemSchema>;
export type HourlySalesAnalysisRequest = z.infer<typeof HourlySalesAnalysisRequestSchema>;
export type HourlySalesAnalysisItem = z.infer<typeof HourlySalesAnalysisItemSchema>;
export type SalesComparisonRequest = z.infer<typeof SalesComparisonRequestSchema>;
export type SalesComparisonItem = z.infer<typeof SalesComparisonItemSchema>;
export type CustomerPurchaseHistoryRequest = z.infer<typeof CustomerPurchaseHistoryRequestSchema>;
export type CustomerPurchaseHistoryItem = z.infer<typeof CustomerPurchaseHistoryItemSchema>;

// Export existing types (keep these at the end)
export type PurchaseOrderSummaryRequest = z.infer<typeof PurchaseOrderSummaryRequestSchema>;
export type PurchaseOrderSummaryItem = z.infer<typeof PurchaseOrderSummaryItemSchema>;
export type StockMovementAnalysisRequest = z.infer<typeof StockMovementAnalysisRequestSchema>;
export type StockMovementAnalysisItem = z.infer<typeof StockMovementAnalysisItemSchema>;
export type CustomerAccountStatementRequest = z.infer<typeof CustomerAccountStatementRequestSchema>;
export type CustomerAccountStatementItem = z.infer<typeof CustomerAccountStatementItemSchema>;
export type ProfitMarginByProductRequest = z.infer<typeof ProfitMarginByProductRequestSchema>;
export type ProfitMarginByProductItem = z.infer<typeof ProfitMarginByProductItemSchema>;
export type DailyCashFlowRequest = z.infer<typeof DailyCashFlowRequestSchema>;
export type DailyCashFlowItem = z.infer<typeof DailyCashFlowItemSchema>;
export type SupplierPaymentStatusRequest = z.infer<typeof SupplierPaymentStatusRequestSchema>;
export type SupplierPaymentStatusItem = z.infer<typeof SupplierPaymentStatusItemSchema>;
export type TopCustomersRequest = z.infer<typeof TopCustomersRequestSchema>;
export type TopCustomersItem = z.infer<typeof TopCustomersItemSchema>;
export type StockAgingRequest = z.infer<typeof StockAgingRequestSchema>;
export type StockAgingItem = z.infer<typeof StockAgingItemSchema>;
export type WasteDamageRequest = z.infer<typeof WasteDamageRequestSchema>;
export type WasteDamageItem = z.infer<typeof WasteDamageItemSchema>;
export type ReorderRecommendationsRequest = z.infer<typeof ReorderRecommendationsRequestSchema>;
export type ReorderRecommendationsItem = z.infer<typeof ReorderRecommendationsItemSchema>;

// ================================================================================
// BUSINESS POSITION REPORT SCHEMAS
// ================================================================================

// Business Position Report Request Parameters
export const BusinessPositionParamsSchema = z.object({
  report_date: z.string().optional().describe('Date for the business position report (YYYY-MM-DD). Defaults to today.'),
  include_comparisons: z.string().optional().transform(val => val === 'true').describe('Include period comparisons'),
  include_forecasts: z.string().optional().transform(val => val === 'true').describe('Include forecast data'),
  format: z.enum(['json', 'pdf', 'csv']).optional().default('json'),
}).strict();

// Comprehensive Business Position Response Schema
export const BusinessPositionSchema = z.object({
  reportDate: z.string(),
  businessHealthScore: z.number().int().min(0).max(100),

  salesPerformance: z.object({
    transactionsCount: z.number().int().nonnegative(),
    uniqueCustomers: z.number().int().nonnegative(),
    totalRevenue: z.number().nonnegative(),
    totalCost: z.number().nonnegative(),
    grossProfit: z.number(),
    avgTransactionValue: z.number().nonnegative(),
    walkInRevenue: z.number().nonnegative(),
    customerRevenue: z.number().nonnegative(),
    salesCashCollected: z.number().nonnegative(),
    creditExtended: z.number().nonnegative(),
  }).strict(),

  collectionsPerformance: z.object({
    collectionTransactions: z.number().int().nonnegative(),
    totalCollections: z.number().nonnegative(),
    avgCollectionValue: z.number().nonnegative(),
    payingCustomers: z.number().int().nonnegative(),
  }).strict(),

  inventoryHealth: z.object({
    totalProducts: z.number().int().nonnegative(),
    lowStockItems: z.number().int().nonnegative(),
    expiringUnits: z.number().nonnegative(),
    inventoryValue: z.number().nonnegative(),
  }).strict(),

  customerMetrics: z.object({
    totalCustomers: z.number().int().nonnegative(),
    newCustomers30d: z.number().int().nonnegative(),
    totalReceivables: z.number().nonnegative(),
    customersWithBalance: z.number().int().nonnegative(),
    avgCustomerBalance: z.number(),
  }).strict(),

  cashPosition: z.object({
    totalCashIn: z.number().nonnegative(),
    newCreditExtended: z.number().nonnegative(),
    outstandingReceivables: z.number().nonnegative(),
    profitMarginPercent: z.number(),
    cashCollectionRate: z.number(),
  }).strict(),

  riskAssessment: z.object({
    receivablesRisk: z.enum(['LOW', 'MEDIUM', 'HIGH']),
    inventoryRisk: z.enum(['LOW', 'MEDIUM', 'HIGH']),
    overallRiskLevel: z.enum(['LOW', 'MEDIUM', 'HIGH']),
  }).strict(),

  enhancedAnalysis: z.object({
    liquidityMetrics: z.object({
      currentRatio: z.number().nonnegative(),
      quickRatio: z.number().nonnegative(),
      cashTurnoverRatio: z.number().nonnegative(),
    }).strict(),

    profitabilityMetrics: z.object({
      grossProfitMargin: z.number(),
      netProfitRatio: z.number(),
      returnOnSales: z.number(),
    }).strict(),

    efficiencyMetrics: z.object({
      assetTurnover: z.number().nonnegative(),
      inventoryTurnover: z.number().nonnegative(),
      receivablesToSalesRatio: z.number(),
    }).strict(),

    customerInsights: z.object({
      customerRetentionIndicator: z.number(),
      averageCustomerValue: z.number().nonnegative(),
      creditUtilizationRate: z.number(),
    }).strict(),

    riskMetrics: z.object({
      concentrationRisk: z.number(),
      badDebtRisk: z.number(),
      inventoryObsolescenceRisk: z.number(),
    }).strict(),

    performanceBenchmarks: z.object({
      dailyRevenueTarget: z.number().nonnegative(),
      profitMarginTarget: z.number(),
      inventoryTurnoverTarget: z.number(),
      collectionEfficiencyTarget: z.number(),
    }).strict(),

    recommendations: z.array(z.object({
      priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']),
      category: z.enum(['CASH_FLOW', 'PROFITABILITY', 'INVENTORY', 'GROWTH', 'RISK_MANAGEMENT']),
      message: z.string(),
      impact: z.enum(['FINANCIAL', 'PROFITABILITY', 'OPERATIONAL', 'GROWTH', 'STRATEGIC']),
    }).strict()),
  }).strict(),
}).strict();

// ==============================================================================
// CASH REGISTER SESSION REPORTS
// ==============================================================================

// Movement Type Enum for cash register
export const CashMovementTypeEnum = z.enum([
  'CASH_IN', 'CASH_IN_FLOAT', 'CASH_IN_PAYMENT', 'CASH_IN_OTHER',
  'CASH_OUT', 'CASH_OUT_BANK', 'CASH_OUT_EXPENSE', 'CASH_OUT_OTHER',
  'SALE', 'REFUND', 'FLOAT_ADJUSTMENT'
]);

// Cash Register Session Summary Report Request
export const CashRegisterSessionSummaryRequestSchema = z.object({
  reportType: z.literal('CASH_REGISTER_SESSION_SUMMARY'),
  sessionId: z.string().uuid(),
  format: z.enum(['pdf', 'csv', 'json']).default('json'),
}).strict();

// Cash Register Movement Breakdown Report Request
export const CashRegisterMovementBreakdownRequestSchema = z.object({
  reportType: z.literal('CASH_REGISTER_MOVEMENT_BREAKDOWN'),
  startDate: z.string(),
  endDate: z.string(),
  registerId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  format: z.enum(['pdf', 'csv', 'json']).default('json'),
}).strict();

// Cash Register Session History Report Request  
export const CashRegisterSessionHistoryRequestSchema = z.object({
  reportType: z.literal('CASH_REGISTER_SESSION_HISTORY'),
  startDate: z.string(),
  endDate: z.string(),
  registerId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  status: z.enum(['OPEN', 'CLOSED', 'ALL']).default('ALL'),
  format: z.enum(['pdf', 'csv', 'json']).default('json'),
}).strict();

// Movement breakdown schema (detailed by type)
export const MovementBreakdownSchema = z.object({
  cashInFloat: z.number(),       // Float received (petty cash)
  cashInPayment: z.number(),     // Customer payments/debt collections
  cashInOther: z.number(),       // Other cash receipts
  cashOutBank: z.number(),       // Bank deposits
  cashOutExpense: z.number(),    // Petty expenses
  cashOutOther: z.number(),      // Other cash disbursements
}).strict();

// Cash Register Session Summary Response
export const CashRegisterSessionSummaryResponseSchema = z.object({
  reportType: z.literal('CASH_REGISTER_SESSION_SUMMARY'),
  generatedAt: z.string(),

  session: z.object({
    id: z.string().uuid(),
    sessionNumber: z.string(),
    registerName: z.string(),
    cashierName: z.string(),
    status: z.enum(['OPEN', 'CLOSED']),
    openedAt: z.string(),
    closedAt: z.string().nullable(),
  }).strict(),

  summary: z.object({
    openingFloat: z.number(),
    expectedClosing: z.number(),
    actualClosing: z.number().nullable(),
    variance: z.number().nullable(),
    varianceReason: z.string().nullable(),

    // Aggregates
    totalCashIn: z.number(),
    totalCashOut: z.number(),
    totalSales: z.number(),
    totalRefunds: z.number(),
    netCashFlow: z.number(),
    movementCount: z.number(),

    // Detailed breakdown by movement type
    breakdown: MovementBreakdownSchema,
  }).strict(),

  // Payment method breakdown
  paymentSummary: z.object({
    CASH: z.number().optional(),
    CARD: z.number().optional(),
    MOBILE_MONEY: z.number().optional(),
    CREDIT: z.number().optional(),
  }).strict().nullable(),

  // Individual movements list
  movements: z.array(z.object({
    id: z.string().uuid(),
    movementType: CashMovementTypeEnum,
    amount: z.number(),
    reason: z.string().nullable(),
    referenceNumber: z.string().nullable(),
    createdAt: z.string(),
    createdByName: z.string().nullable(),
  }).strict()),
}).strict();

// Cash Register Movement Breakdown Response (across sessions)
export const CashRegisterMovementBreakdownResponseSchema = z.object({
  reportType: z.literal('CASH_REGISTER_MOVEMENT_BREAKDOWN'),
  generatedAt: z.string(),
  period: z.object({
    startDate: z.string(),
    endDate: z.string(),
  }).strict(),

  // Summary totals
  totals: z.object({
    totalCashIn: z.number(),
    totalCashOut: z.number(),
    totalSales: z.number(),
    totalRefunds: z.number(),
    netCashFlow: z.number(),
    sessionCount: z.number(),
    movementCount: z.number(),
  }).strict(),

  // Breakdown by movement type
  byMovementType: z.record(z.string(), z.object({
    count: z.number(),
    total: z.number(),
    percentage: z.number(),
  }).strict()),

  // Daily breakdown
  dailyBreakdown: z.array(z.object({
    date: z.string(),
    cashInFloat: z.number(),
    cashInPayment: z.number(),
    cashInOther: z.number(),
    cashOutBank: z.number(),
    cashOutExpense: z.number(),
    cashOutOther: z.number(),
    sales: z.number(),
    refunds: z.number(),
    netFlow: z.number(),
  }).strict()),
}).strict();

// Cash Register Session History Response
export const CashRegisterSessionHistoryResponseSchema = z.object({
  reportType: z.literal('CASH_REGISTER_SESSION_HISTORY'),
  generatedAt: z.string(),
  period: z.object({
    startDate: z.string(),
    endDate: z.string(),
  }).strict(),

  // Summary stats
  summary: z.object({
    totalSessions: z.number(),
    openSessions: z.number(),
    closedSessions: z.number(),
    totalVariance: z.number(),
    averageVariance: z.number(),
    sessionsWithVariance: z.number(),
  }).strict(),

  // Session list
  sessions: z.array(z.object({
    id: z.string().uuid(),
    sessionNumber: z.string(),
    registerName: z.string(),
    cashierName: z.string(),
    status: z.enum(['OPEN', 'CLOSED']),
    openedAt: z.string(),
    closedAt: z.string().nullable(),
    openingFloat: z.number(),
    expectedClosing: z.number().nullable(),
    actualClosing: z.number().nullable(),
    variance: z.number().nullable(),
    varianceReason: z.string().nullable(),
    movementCount: z.number(),
    totalSales: z.number(),
  }).strict()),
}).strict();

// Type exports for TypeScript
export type CashMovementType = z.infer<typeof CashMovementTypeEnum>;
export type CashRegisterSessionSummaryRequest = z.infer<typeof CashRegisterSessionSummaryRequestSchema>;
export type CashRegisterMovementBreakdownRequest = z.infer<typeof CashRegisterMovementBreakdownRequestSchema>;
export type CashRegisterSessionHistoryRequest = z.infer<typeof CashRegisterSessionHistoryRequestSchema>;
export type MovementBreakdown = z.infer<typeof MovementBreakdownSchema>;
export type CashRegisterSessionSummaryResponse = z.infer<typeof CashRegisterSessionSummaryResponseSchema>;
export type CashRegisterMovementBreakdownResponse = z.infer<typeof CashRegisterMovementBreakdownResponseSchema>;
export type CashRegisterSessionHistoryResponse = z.infer<typeof CashRegisterSessionHistoryResponseSchema>;

export type BusinessPositionParams = z.infer<typeof BusinessPositionParamsSchema>;
export type BusinessPosition = z.infer<typeof BusinessPositionSchema>;

// ── Delivery Notes Report ──
export const DeliveryNoteReportParamsSchema = z.object({
  start_date: z.string().min(1, 'Start date is required'),
  end_date: z.string().min(1, 'End date is required'),
  customer_id: z.string().uuid().optional(),
  status: z.enum(['DRAFT', 'POSTED']).optional(),
  format: z.enum(['json', 'pdf', 'csv']).optional(),
});

// ── Quotation Report ──
export const QuotationReportParamsSchema = z.object({
  start_date: z.string().min(1, 'Start date is required'),
  end_date: z.string().min(1, 'End date is required'),
  customer_id: z.string().uuid().optional(),
  status: z.enum(['DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'CONVERTED', 'CANCELLED']).optional(),
  quote_type: z.enum(['quick', 'standard']).optional(),
  format: z.enum(['json', 'pdf', 'csv']).optional(),
});

// ── Manual Journal Entry Report ──
export const ManualJournalEntryReportParamsSchema = z.object({
  start_date: z.string().min(1, 'Start date is required'),
  end_date: z.string().min(1, 'End date is required'),
  status: z.enum(['POSTED', 'REVERSED']).optional(),
  format: z.enum(['json', 'pdf', 'csv']).optional(),
});

// ── Bank Transaction Report ──
export const BankTransactionReportParamsSchema = z.object({
  start_date: z.string().min(1, 'Start date is required'),
  end_date: z.string().min(1, 'End date is required'),
  bank_account_id: z.string().uuid().optional(),
  type: z.enum(['DEPOSIT', 'WITHDRAWAL', 'TRANSFER_IN', 'TRANSFER_OUT', 'FEE', 'INTEREST']).optional(),
  is_reconciled: z.enum(['true', 'false']).optional(),
  format: z.enum(['json', 'pdf', 'csv']).optional(),
});

// ── Category Intelligence Report ──
export const CategoryIntelligenceReportTypeEnum = z.enum([
  'INVENTORY_POSITION',
  'SALES',
  'PURCHASES',
  'STOCK_VALUATION',
  'EXPIRY_EXPOSURE',
  'FULL_STATEMENT',
]);
export type CategoryIntelligenceReportType = z.infer<typeof CategoryIntelligenceReportTypeEnum>;

export const CategoryIntelligenceParamsSchema = z.object({
  category: z.string().min(1, 'Category is required'),
  report_type: CategoryIntelligenceReportTypeEnum,
  start_date: z.string().optional(),
  end_date: z.string().optional(),
  days_ahead: z.coerce.number().int().min(1).max(365).optional().default(90),
  format: z.enum(['json', 'pdf']).optional().default('json'),
});
