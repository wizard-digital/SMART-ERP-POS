/**
 * Report Row Types — Typed interfaces for reportsRepository return values
 * Used by reportsService and reportsController for type-safe data access
 */

// ── Sales Report ──
export interface SalesReportRow {
    period: string;
    totalSales: number;
    totalDiscounts: number;
    netRevenue: number;
    totalCost: number;
    grossProfit: number;
    profitMargin: number;
    transactionCount: number;
    averageTransactionValue: number;
    /** Units sold in the period / group (always present when SQL returns it). */
    totalQuantitySold: number;
    /** Product category when group_by is product or category (otherwise undefined). */
    category?: string | null;
}

// ── Supplier Cost Analysis ──
export interface SupplierCostAnalysisRow {
    supplierId: string;
    supplierNumber: string;
    supplierName: string;
    totalPurchaseOrders: number;
    totalPurchaseValue: number;
    totalItemsReceived: number;
    averageLeadTime?: number;
    onTimeDeliveryRate?: number;
}

// ── Payment Report ──
export interface PaymentReportRow {
    paymentMethod: string;
    transactionCount: number;
    totalAmount: number;
    averageAmount: number;
    percentageOfTotal: number;
}

// ── Inventory Adjustments ──
export interface InventoryAdjustmentRow {
    movementId: string;
    movementDate: string | null;
    movementType: string;
    productName: string;
    sku: string;
    batchNumber: string | null;
    quantityChange: number;
    referenceNumber: string | null;
    notes: string | null;
    performedBy: string | null;
}

// ── Purchase Order Summary ──
export interface PurchaseOrderSummaryRow {
    id: string;
    poNumber: string;
    status: string;
    orderDate: string | null;
    expectedDeliveryDate: string | null;
    supplierNumber: string;
    supplierName: string;
    supplierEmail: string | null;
    supplierPhone: string | null;
    totalAmount: number;
    totalReceipts: number;
    totalReceived: number;
    notes: string | null;
    createdAt: string | null;
}

// ── Stock Movement Analysis ──
export interface StockMovementAnalysisRow {
    transactionCount: number;
    totalIn: number;
    totalOut: number;
    netMovement: number;
    period: string | null;
    // Optional fields depending on groupBy mode
    product_id?: string;
    product_name?: string;
    sku?: string;
    movement_type?: string;
}

// ── Customer Account Statement ──
export interface CustomerStatementCustomer {
    id: string;
    customerNumber: string;
    name: string;
    email: string | null;
    phone: string | null;
    creditLimit: number;
    currentBalance: number;
    customerGroupId: string | null;
}

export interface CustomerStatementTransaction {
    saleId: string;
    saleNumber: string;
    saleDate: string | null;
    totalAmount: number;
    amountPaid: number;
    balanceDue: number;
    paymentStatus: string;
    items: unknown[];
}

export interface CustomerAccountStatementData {
    customer: CustomerStatementCustomer;
    transactions: CustomerStatementTransaction[];
    transactionSummary: {
        totalTransactions: number;
        totalSales: number;
        totalPaid: number;
        totalOutstanding: number;
        openingBalance?: number;
        closingBalance?: number;
    };
}

// ── Daily Cash Flow ──
export interface DailyCashFlowRow {
    transactionDate: string;
    paymentMethod: string;
    revenueType: string;
    transactionCount: number;
    cashAmount: number;
    totalSales: number;
    totalCost: number;
    grossProfit: number;
    creditCreated: number;
    averageTransactionValue: number;
    profitMargin: number;
    cashFlowImpact: number;
}

// ── Top Customers ──
export interface TopCustomerRow {
    rank: number;
    customerId: string;
    customerNumber: string;
    customerName: string;
    email: string | null;
    phone: string | null;
    totalPurchases: number;
    totalRevenue: number;
    totalProfit: number;
    averagePurchaseValue: number;
    lastPurchaseDate: string | null;
    outstandingBalance: number;
}

// ── Stock Aging ──
export interface StockAgingRow {
    productId: string;
    productName: string;
    sku: string;
    category: string | null;
    batchNumber: string;
    remainingQuantity: number;
    unitCost: number;
    totalValue: number;
    receivedDate: string | null;
    daysInStock: number;
    expiryDate: string | null;
    daysUntilExpiry: number | null;
}

// ── Sales by Category ──
export interface SalesByCategoryRow {
    category: string;
    productCount: number;
    totalQuantitySold: number;
    totalRevenue: number;
    totalCost: number;
    grossProfit: number;
    profitMargin: number;
    totalDiscounts: number;
    transactionCount: number;
    averageTransactionValue: number;
}

// ── Sales by Payment Method ──
export interface SalesByPaymentMethodRow {
    paymentMethod: string;
    transactionCount: number;
    totalRevenue: number;
    totalDiscounts: number;
    averageTransactionValue: number;
    percentageOfTotal: number;
}

// ── Hourly Sales Analysis ──
export interface HourlySalesAnalysisRow {
    hour: number;
    transactionCount: number;
    totalRevenue: number;
    averageTransactionValue: number;
    peakDay?: string;
}

// ── Business Position Report ──
export interface BusinessSalesPerformance {
    transactionsCount: number;
    uniqueCustomers: number;
    totalRevenue: number;
    totalCost: number;
    grossProfit: number;
    avgTransactionValue: number;
    walkInRevenue: number;
    customerRevenue: number;
    salesCashCollected: number;
    creditExtended: number;
}

export interface BusinessCollectionsPerformance {
    collectionTransactions: number;
    totalCollections: number;
    avgCollectionValue: number;
    payingCustomers: number;
}

export interface BusinessInventoryHealth {
    totalProducts: number;
    lowStockItems: number;
    expiringUnits: number;
    inventoryValue: number;
}

export interface BusinessCustomerMetrics {
    totalCustomers: number;
    newCustomers30d: number;
    totalReceivables: number;
    customersWithBalance: number;
    avgCustomerBalance: number;
}

export interface BusinessCashPosition {
    totalCashIn: number;
    newCreditExtended: number;
    outstandingReceivables: number;
    depositLiability: number;
    activeDepositCount: number;
    customersWithDeposits: number;
    totalDeposited: number;
    totalCleared: number;
    profitMarginPercent: number;
    cashCollectionRate: number;
}

export type RiskLevel = 'HIGH' | 'MEDIUM' | 'LOW';

export interface BusinessRiskAssessment {
    receivablesRisk: RiskLevel;
    inventoryRisk: RiskLevel;
    overallRiskLevel: RiskLevel;
}

export interface BusinessPositionData {
    reportDate: string;
    businessHealthScore: number;
    salesPerformance: BusinessSalesPerformance;
    collectionsPerformance: BusinessCollectionsPerformance;
    inventoryHealth: BusinessInventoryHealth;
    customerMetrics: BusinessCustomerMetrics;
    cashPosition: BusinessCashPosition;
    riskAssessment: BusinessRiskAssessment;
}

// ── Cash Register Session Summary ──
export interface CashRegisterSessionInfo {
    id: string;
    sessionNumber: string;
    registerName: string;
    cashierName: string;
    status: string;
    openedAt?: string;
    closedAt: string | null;
}

export interface CashRegisterBreakdown {
    cashInFloat: number;
    cashInPayment: number;
    cashInOther: number;
    cashOutBank: number;
    cashOutExpense: number;
    cashOutOther: number;
}

export interface CashRegisterSummaryInfo {
    openingFloat: number;
    expectedClosing: number;
    actualClosing: number | null;
    variance: number | null;
    varianceReason: string | null;
    totalCashIn: number;
    totalCashOut: number;
    totalSales: number;
    totalRefunds: number;
    netCashFlow: number;
    movementCount: number;
    breakdown: CashRegisterBreakdown;
}

export interface CashRegisterMovement {
    id: string;
    movementType: string;
    amount: number;
    reason: string | null;
    referenceNumber: string | null;
    createdAt?: string;
    createdByName: string | null;
}

export interface CashRegisterSessionSaleEntry {
    id: string;
    saleNumber: string;
    totalAmount: number;
    totalCost: number;
    profit: number;
    paymentMethod: string;
    amountPaid: number;
    status: string;
    saleDate: string;
    createdAt: string;
    customerName: string;
}

export interface CashRegisterSessionSummaryData {
    reportType: string;
    generatedAt: string;
    session: CashRegisterSessionInfo;
    summary: CashRegisterSummaryInfo;
    paymentSummary: unknown;
    movements: CashRegisterMovement[];
    sales?: CashRegisterSessionSaleEntry[];
    salesSummary?: {
        totalTransactions: number;
        totalRevenue: number;
        totalProfit: number;
    };
}

// ── Cash Register Movement Breakdown ──
export interface CashRegisterMovementTotals {
    totalCashIn: number;
    totalCashOut: number;
    totalSales: number;
    totalRefunds: number;
    netCashFlow: number;
    sessionCount: number;
    movementCount: number;
}

export interface CashRegisterDailyBreakdown {
    date: string;
    cashInFloat: number;
    cashInPayment: number;
    cashInOther: number;
    cashOutBank: number;
    cashOutExpense: number;
    cashOutOther: number;
    sales: number;
    refunds: number;
    netFlow: number;
}

export interface CashRegisterMovementBreakdownData {
    reportType: string;
    generatedAt: string;
    period: { startDate: string; endDate: string };
    totals: CashRegisterMovementTotals;
    byMovementType: Record<string, { count: number; total: number; percentage: number }>;
    dailyBreakdown: CashRegisterDailyBreakdown[];
}

// ── Cash Register Session History ──
export interface CashRegisterSessionHistorySummary {
    totalSessions: number;
    openSessions: number;
    closedSessions: number;
    totalVariance: number;
    averageVariance: number;
    sessionsWithVariance: number;
}

export interface CashRegisterSessionHistoryEntry {
    id: string;
    sessionNumber: string;
    registerName: string;
    cashierName: string;
    status: string;
    openedAt?: string;
    closedAt: string | null;
    openingFloat: number;
    expectedClosing: number | null;
    actualClosing: number | null;
    variance: number | null;
    varianceReason: string | null;
    movementCount: number;
    totalSales: number;
}

export interface CashRegisterSessionHistoryData {
    reportType: string;
    generatedAt: string;
    period: { startDate: string; endDate: string };
    summary: CashRegisterSessionHistorySummary;
    sessions: CashRegisterSessionHistoryEntry[];
}

// ── Inventory Valuation ──
export interface InventoryValuationRow {
    productId: string;
    productName: string;
    sku: string;
    category: string | null;
    productActive?: boolean;
    costSource?: 'FIFO_LAYER' | 'AVCO_FALLBACK' | 'NO_COST_BASIS';
    quantityOnHand: number;
    unitCost: number;
    sellingPrice?: number;
    totalValue: number;
    potentialRevenue?: number;
    profitPerUnit?: number;
    potentialProfit?: number;
    profitMargin?: number;
    lastUpdated: string | null;
    // ── SAP/Odoo-grade enrichments ──
    /** ABC classification by value: A = top 80%, B = next 15%, C = last 5% */
    abcClass?: 'A' | 'B' | 'C';
    /** % of total inventory value */
    valueContribution?: number;
    /** Days since oldest cost layer was received (stock age / FIFO age) */
    daysInStock?: number | null;
    /** Last sale date (YYYY-MM-DD) or null if never sold */
    lastSaleDate?: string | null;
    /** Days since last sale (null = never sold) */
    daysSinceLastSale?: number | null;
    /** Movement classification: FAST / SLOW / DEAD / NEW */
    movementClass?: 'FAST' | 'SLOW' | 'DEAD' | 'NEW';
    /** Qty in product_inventory (authoritative subledger) */
    qtySubledger?: number;
    /** Qty in cost_layers (FIFO layer sum) */
    qtyCostLayers?: number;
    /** Qty drift (subledger - cost_layers). Non-zero = needs investigation */
    qtyDrift?: number;
    /** Is qty drift material? */
    hasDrift?: boolean;
}

// ── Expiring Items (shelf-life / expiry register) ──
export interface ExpiringItemRow {
    batchId: string;
    productId: string;
    productName: string;
    sku: string | null;
    batchNumber: string;
    expiryDate: string | null;
    daysUntilExpiry: number;
    quantityRemaining: number;
    unitCost: number;
    /** Acquisition cost when a write-down has occurred; else same as unitCost. */
    originalUnitCost: number;
    potentialLoss: number;
    /** expired | critical | warning | watch */
    urgency: string;
}

// ── Low Stock Items ──
export interface LowStockItemRow {
    productId: string;
    productName: string;
    sku: string;
    currentStock: number;
    reorderLevel: number;
    reorderQuantity?: number;
    status: string;
}

// ── Best Selling Products ──
export interface BestSellingProductRow {
    productId: string;
    productName: string;
    sku: string;
    quantitySold: number;
    totalRevenue: number;
    totalCost: number;
    grossProfit: number;
    profitMargin: number;
    transactionCount: number;
}

// ── Goods Received Report ──
export interface GoodsReceivedRow {
    goodsReceiptId: string;
    goodsReceiptNumber: string;
    purchaseOrderNumber: string;
    supplierNumber: string;
    supplierName: string;
    receivedDate: string | null;
    totalValue: number;
    itemsCount: number;
    status: string;
}

// ── Customer Payments Report ──
export interface CustomerPaymentsRow {
    customerId: string;
    customerNumber: string;
    customerName: string;
    totalInvoices: number;
    totalInvoiced: number;
    totalPaid: number;
    totalOutstanding: number;
    overdueAmount: number;
    averagePaymentDays?: number;
    totalDeposited?: number;
    depositAvailable?: number;
}

// ── Profit/Loss Report ──
export interface ProfitLossRow {
    period: string;
    revenue: number;
    costOfGoodsSold: number;
    grossProfit: number;
    grossProfitMargin: number;
    taxCollected?: number;
    totalDiscounts?: number;
}

export interface ProfitLossSummary {
    totalRevenue: number;
    totalCOGS: number;
    grossProfit: number;
    grossProfitMargin: number;
    totalExpenses: number;
    operatingProfit: number;
    netProfit: number;
    netProfitMargin: number;
    totalSupplierPayments: number;
    supplierPaymentCount: number;
}

export interface ExpenseBreakdownRow {
    accountCode: string;
    accountName: string;
    entryCount: number;
    totalAmount: number;
}

// ── Deleted Items Report ──
export interface DeletedItemRow {
    productId: string;
    productName: string;
    sku: string;
    deletedDate: string | null;
    description: string | null;
    finalStockLevel: number;
}

// ── Profit Margin by Product ──
export interface ProfitMarginByProductRow {
    productId: string;
    productName: string;
    sku: string;
    category: string | null;
    totalSales: number;
    totalQuantitySold: number;
    totalRevenue: number;
    totalCost: number;
    totalProfit: number;
    profitMarginPercent: number;
}

// ── Supplier Payment Status ──
export interface SupplierPaymentStatusRow {
    supplierId: string;
    supplierNumber: string;
    supplierName: string;
    email: string | null;
    phone: string | null;
    totalOrders: number;
    totalAmount: number;
    totalPaid: number;
    outstandingBalance: number;
    lastOrderDate: string | null;
    paymentTerms: string | null;
}

export interface SupplierPaymentDetailRow {
    paymentNumber: string;
    supplierName: string;
    paymentDate: string;
    amount: number;
    paymentMethod: string;
    status: string;
    reference: string | null;
    allocatedAmount: number;
    unallocatedAmount: number;
    notes: string | null;
    allocations: SupplierPaymentAllocationRow[];
}

export interface SupplierPaymentAllocationRow {
    invoiceNumber: string;
    amountAllocated: number;
    allocationDate: string;
}

// ── Customer Aging ──
export interface CustomerAgingRow {
    customerId: string;
    customerNumber: string;
    customerName: string;
    email: string | null;
    phone: string | null;
    creditLimit: number;
    totalInvoices: number;
    totalOutstanding: number;
    current: number;
    days30: number;
    days60: number;
    days90: number;
    over90: number;
    overdueAmount: number;
    maxDaysOverdue: number;
    /** On-account AR receipts not yet allocated (reduces net outstanding) */
    unallocatedCredits?: number;
}

// ── Waste/Damage Report ──
export interface WasteDamageRow {
    movementId: string;
    lossDate: string | null;
    lossType: string;
    productId: string;
    productName: string;
    sku: string;
    category: string | null;
    batchNumber: string | null;
    expiryDate: string | null;
    quantityLost: number;
    unitCost: number;
    totalLossValue: number;
    notes: string | null;
    createdBy: string | null;
}

// ── Reorder Recommendations ──
export interface ReorderRecommendationRow {
    productId: string;
    productName: string;
    sku: string;
    category: string | null;
    reorderLevel: number;
    currentStock: number;
    unitsSoldPeriod: number;
    dailySalesVelocity: number;
    daysUntilStockout: number | null;
    suggestedOrderQuantity: number;
    estimatedOrderCost: number;
    preferredSupplier: string | null;
    priority: string;
    leadTimeDays: number;
    safetyStock: number;
    reorderPoint: number;
    demandTrend: 'INCREASING' | 'DECREASING' | 'STABLE';
    trendRatio: number;
    // Self-learning engine fields (populated when demand_forecast has run)
    forecastDemand30d: number | null;
    seasonalIndex: number | null;
    learningCycles: number;
}

// ── Reorder Dashboard (Business-Driven) ──
export type ReorderPriority = 'URGENT' | 'HIGH' | 'MEDIUM' | 'DEAD_STOCK' | 'HEALTHY';

export interface ReorderDashboardItem {
    productId: string;
    name: string;
    sku: string;
    category: string | null;
    currentStock: number;
    unitsSold30d: number;
    unitsSold7d: number;
    qtyOnOrder: number;
    dailySalesVelocity: number;
    daysUntilStockout: number | null;
    suggestedOrderQty: number;
    estimatedOrderCost: number | null;
    priority: ReorderPriority;
    reason: string;
    leadTimeDays: number;
    reorderPoint: number;
    reorderLevel: number;
    safetyStock: number;
    costPrice: number | null;
    preferredSupplier: string | null;
    preferredSupplierId: string | null;
}

export interface ReorderDashboardSummary {
    urgentCount: number;
    highCount: number;
    mediumCount: number;
    deadStockCount: number;
    /** Lines with computed order qty > 0 (urgent + high + normal) */
    itemsToReorderCount: number;
    totalReorderCost: number;
    totalDeadStockValue: number;
}

export interface ReorderDashboardResponse {
    summary: ReorderDashboardSummary;
    urgent: ReorderDashboardItem[];
    high: ReorderDashboardItem[];
    deadStock: ReorderDashboardItem[];
    medium: ReorderDashboardItem[];
}

// ── Sales Comparison ──
export interface SalesComparisonRow {
    period: string;
    /** Aligned previous-range bucket label (ordinal PoP, not calendar join) */
    previousPeriod: string;
    currentSales: number;
    previousSales: number;
    difference: number;
    /** null when previous baseline is 0 and current > 0 */
    percentageChange: number | null;
    currentTransactions: number;
    previousTransactions: number;
}

// ── Customer Purchase History ──
export interface CustomerPurchaseHistoryRow {
    saleId: string;
    saleNumber: string;
    saleDate: string;
    totalAmount: number;
    amountPaid: number;
    outstandingBalance: number;
    paymentMethod: string;
    itemCount: number;
    status: string;
    customerName?: string;
}

// ── Void Sales Report (cancellation / void document register) ──
export interface VoidSalesReportRow {
    saleNumber: string;
    saleDate: string | null;
    totalAmount: number;
    totalCost: number;
    profit: number;
    voidReason: string | null;
    voidedAt: string | null;
    voidedBy: string | null;
    voidApprovedBy: string | null;
    customerName: string | null;
    paymentMethod: string;
    itemCount: number;
    /** Aggregated REVERSAL TransactionNumber(s) for this sale */
    accountingDocNumber: string | null;
    glReversalAmount: number | null;
}

// ── Refund Report (credit memo / returns register) ──

/** Header row: one per refund document */
export interface RefundReportHeader {
    refundNumber: string;
    saleNumber: string;
    customerName: string | null;
    refundDate: string | null;
    reason: string | null;
    refundType: string; // 'Full' | 'Partial'
    createdBy: string | null;
    approvedBy: string | null;
    accountingDocNumber: string | null; // GL TransactionNumber (FI-style)
    totalRevenueReversal: number;       // sum of line revenue returned
    totalCOGSReversal: number;          // sum of line COGS reversed
    netProfitImpact: number;            // revenue - COGS = profit lost
}

/** Line row: one per refunded product line within a refund */
export interface RefundReportLine {
    refundNumber: string;
    saleNumber: string;
    productName: string;
    sku: string | null;
    originalSoldQty: number;
    refundedQty: number;
    remainingQty: number;
    unitSellingPrice: number;           // price at time of sale
    unitCOGS: number;                   // cost at time of sale
    lineRevenueReversed: number;        // refundedQty × unitSellingPrice
    lineCOGSReversed: number;           // refundedQty × unitCOGS
    profitImpact: number;               // revenue - COGS for this line
    returnedToStock: boolean;           // stock movement exists?
    batchNumber: string | null;         // which batch was restored
}

/** Legacy alias kept for backward compat with generateReport switch */
export type RefundReportRow = RefundReportHeader;

// ── Delivery Notes Report ──
export interface DeliveryNoteReportRow {
    deliveryNoteId: string;
    deliveryNoteNumber: string;
    quotationNumber: string;
    customerName: string;
    deliveryDate: string | null;
    status: string;
    totalAmount: number;
    lineCount: number;
    driverName: string | null;
    vehicleNumber: string | null;
    createdAt: string | null;
    postedAt: string | null;
}

// ── Quotation Report ──
export interface QuotationReportRow {
    quotationId: string;
    quoteNumber: string;
    customerName: string;
    quoteType: string;
    status: string;
    subtotal: number;
    discountAmount: number;
    taxAmount: number;
    totalAmount: number;
    validFrom: string | null;
    validUntil: string | null;
    lineCount: number;
    convertedToSale: string | null;
    convertedToInvoice: string | null;
    createdAt: string | null;
}

// ── Manual Journal Entry Report ──
export interface ManualJournalEntryReportRow {
    entryId: string;
    entryNumber: string;
    entryDate: string | null;
    narration: string;
    reference: string | null;
    totalDebit: number;
    totalCredit: number;
    status: string;
    lineCount: number;
    createdBy: string | null;
    createdAt: string | null;
}

// ── Bank Transaction Report ──
export interface BankTransactionReportRow {
    transactionId: string;
    transactionNumber: string;
    bankAccountName: string;
    transactionDate: string | null;
    type: string;
    description: string;
    reference: string | null;
    amount: number;
    runningBalance: number | null;
    sourceType: string | null;
    isReconciled: boolean;
    createdAt: string | null;
}

// ── Category Intelligence Report ──
export interface UomLevel {
    uomId: string;
    name: string;
    symbol: string | null;
    conversionFactor: number; // base units per 1 of this UoM (base itself = 1)
    isDefault: boolean;
}

export interface CategoryInventoryPositionRow {
    productId: string;
    sku: string | null;
    productName: string;
    unitOfMeasure: string | null;
    qtyOnHand: number;
    reorderLevel: number;
    unitCost: number;
    stockValue: number;
    uomLevels: UomLevel[];  // all UoMs sorted by conversionFactor DESC
}

export interface CategoryPurchasesRow {
    productId: string;
    sku: string | null;
    productName: string;
    unitOfMeasure: string | null;
    supplierName: string;
    receivedDate: string;
    grNumber: string;
    totalQtyReceived: number;
    totalPurchaseValue: number;
    avgUnitCost: number;
}

/** Per-product sales within a single selected category */
export interface CategorySalesProductRow {
    productId: string;
    sku: string | null;
    productName: string;
    totalQuantitySold: number;
    totalRevenue: number;
    totalCost: number;
    grossProfit: number;
    profitMargin: number;
    transactionCount: number;
}

export interface CategoryExpiryExposureRow {
    productId: string;
    sku: string | null;
    productName: string;
    unitOfMeasure: string | null;
    batchNumber: string;
    expiryDate: string;
    remainingQuantity: number;
    costPrice: number;
    exposedValue: number;
    status: string;
    daysUntilExpiry: number;
}
