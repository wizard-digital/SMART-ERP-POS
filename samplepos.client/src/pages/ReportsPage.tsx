// Reports Page - Modern reporting interface with categorized reports
// Enhanced visual design with card-based layout and intuitive filters
//
// 🎯 DYNAMIC ARCHITECTURE: This component automatically adapts to new backend fields
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 1. Summary Cards: Uses Object.entries(reportData.summary) to render ALL fields
// 2. Data Table: Uses Object.keys() and Object.entries() for dynamic columns/rows
// 3. CSV Export: Automatically includes all fields from first row
// 4. Field Formatting: formatFieldValue() uses keyword detection to format ANY field
// 5. Color Coding: getFieldColorClass() applies semantic colors based on field name
//
// ✨ ADDING NEW FIELDS TO BACKEND:
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 1. Add field to repository SQL query (e.g., SUM(s.new_field) as newField)
// 2. Add field to service summary calculations
// 3. Frontend automatically renders it with proper formatting
// 4. No ReportsPage.tsx changes needed!
//
// 💡 SUPPORTED FIELD TYPES (Auto-detected by keyword in field name):
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// - Count (PRIORITY): fields ending with orders, suppliers, customers, products, items,
//     transactions, batches, records, movements, entries, receipts, invoices, users, categories
//     or containing 'count' → plain number (NOT currency)
// - Non-monetary (PRIORITY): fields ending with terms, method, status, type, days → plain number
// - Currency: amount, value, cost, price, revenue, profit, discount, sales, payment, balance, total, subtotal
// - Percentage: margin, rate, percentage, change, ratio
// - Quantity: quantity, count, units, items
// - Date: date, time (string or Date object)
// - Boolean: true/false → ✓/✗
// - Numbers: Default locale formatting
// - Strings: Direct display
//
// 🎨 AUTO-COLOR CODING:
// ━━━━━━━━━━━━━━━━━━━━━
// - Discounts: RED (always)
// - Costs/Expenses: ORANGE
// - Revenue/Sales/Income: GREEN
// - Profit: GREEN (positive) / RED (negative)
// - Percentages: GREEN (positive) / RED (negative)
// - IDs (customerNumber, etc.): BLUE background badge
// - Readable IDs (*Number): INDIGO
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import Layout from '../components/Layout';
import { formatCurrency } from '../utils/currency';
import { api } from '../services/api';
import { api as inventoryApi, getErrorMessage } from '../utils/api';
import { useAuth } from '../hooks/useAuth';
import CustomerAgingReport from '../components/reports/CustomerAgingReport';
import ReportCustomerCombobox from '../components/reports/ReportCustomerCombobox';
import ReportSupplierCombobox from '../components/reports/ReportSupplierCombobox';
import { ReportBackLink } from '../components/reports/ReportBackLink';
import { DateRangeFilter } from '../components/ui/DateRangeFilter';
import { formatTimestamp, formatTimestampDate, getBusinessDate } from '../utils/businessDate';
import {
  expiryUrgencyLabel,
  expiringBandFilterLabel,
  filterExpiringRegisterRows,
  filterExpiringRowsByBand,
  filterExpiringRowsBySearch,
  resolveExpiryRowBand,
  type ExpiryBandFilter,
} from '@shared/reports/expiringItemsSsot';
import {
  canPerformLotWriteDown,
  isNearExpiryWriteDownBand,
  LOT_WRITE_DOWN_MAX_DAYS,
  LOT_WRITE_DOWN_MIN_CARRYING,
} from '@shared/inventory-lot/lotWriteDown';
import {
  INVENTORY_LEDGER_REPORTS,
  INVENTORY_NETWORK_REPORTS,
  INVENTORY_OPERATIONAL_REPORTS,
} from '../config/inventoryReportCatalog';

/** Inclusive equal-length window immediately before [start, end] (YYYY-MM-DD). */
function equalLengthPriorRange(startYmd: string, endYmd: string): { start: string; end: string } {
  const parse = (s: string) => {
    const [y, m, d] = s.slice(0, 10).split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  };
  const fmt = (dt: Date) => {
    const y = dt.getUTCFullYear();
    const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const d = String(dt.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  };
  const start = parse(startYmd);
  const end = parse(endYmd);
  const days = Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
  const prevEnd = new Date(start);
  prevEnd.setUTCDate(prevEnd.getUTCDate() - 1);
  const prevStart = new Date(prevEnd);
  prevStart.setUTCDate(prevStart.getUTCDate() - (days - 1));
  return { start: fmt(prevStart), end: fmt(prevEnd) };
}

function formatPoPPercent(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${n.toFixed(2)}%`;
}

// TIMEZONE STRATEGY: DATE columns stay as YYYY-MM-DD; TIMESTAMPTZ uses business TZ display.
const formatDisplayDate = (dateString: string | null | undefined): string => {
  if (!dateString) return 'N/A';
  if (dateString.includes('T')) {
    return formatTimestampDate(dateString);
  }
  return dateString;
};

/**
 * Dynamic field formatting utility
 * Automatically detects field type and applies appropriate formatting
 * Supports: currency, percentages, dates, numbers, strings
 */
const formatFieldValue = (key: string, value: unknown): string => {
  const lowerKey = key.toLowerCase();

  if (value === null || value === undefined) return '-';

  if (typeof value === 'number') {
    // Count-like fields that happen to contain currency keywords (e.g., totalOrders, totalSuppliers)
    // These are entity counts, NOT monetary values — check BEFORE currency detection
    const isCountField = (
      lowerKey.endsWith('orders') ||
      lowerKey.endsWith('suppliers') ||
      lowerKey.endsWith('customers') ||
      lowerKey.endsWith('products') ||
      lowerKey.endsWith('items') ||
      lowerKey.endsWith('transactions') ||
      lowerKey.endsWith('batches') ||
      lowerKey.endsWith('records') ||
      lowerKey.endsWith('movements') ||
      lowerKey.endsWith('entries') ||
      lowerKey.endsWith('receipts') ||
      lowerKey.endsWith('invoices') ||
      lowerKey.endsWith('users') ||
      lowerKey.endsWith('categories') ||
      lowerKey.includes('count') ||
      lowerKey.includes('needingreorder') ||
      lowerKey.endsWith('events') ||
      lowerKey.endsWith('cashiers') ||
      lowerKey.endsWith('periods')
    );
    if (isCountField) {
      return value.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    }

    // Non-monetary numeric fields — velocity, stock levels, lead times, safety stock, forecast
    const isNonMonetaryField = (
      lowerKey.endsWith('terms') ||
      lowerKey.endsWith('method') ||
      lowerKey.endsWith('status') ||
      lowerKey.endsWith('type') ||
      lowerKey.endsWith('days') ||
      lowerKey.includes('velocity') ||
      lowerKey.includes('safetystock') ||
      lowerKey.includes('reorderpoint') ||
      lowerKey.includes('stock') ||
      lowerKey.includes('level') ||
      lowerKey.includes('forecast') ||
      lowerKey.includes('seasonalindex') ||
      lowerKey.includes('learningcycles')
    );
    if (isNonMonetaryField) {
      return value.toLocaleString();
    }

    // Trend ratio — displayed as multiplier (×1.19), not percentage
    if (lowerKey.includes('trendratio') || lowerKey === 'trendRatio') {
      return `×${value.toFixed(2)}`;
    }

    // Quantity/count fields (quantity, count, units, items)
    // Check BEFORE currency — totalQuantity, totalUnitsSold etc. contain 'total' but are NOT currency
    if (
      lowerKey.includes('quantity') ||
      lowerKey.includes('units')
    ) {
      return value.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 3 });
    }

    // Percentage fields (margin, rate, percentage, change)
    // Check BEFORE currency — grossProfitMargin contains 'profit' but IS a percentage
    if (
      lowerKey.includes('margin') ||
      lowerKey.includes('rate') ||
      lowerKey.includes('percentage') ||
      lowerKey.includes('change')
    ) {
      return `${value.toFixed(2)}%`;
    }

    // Currency fields (amount, value, cost, price, revenue, profit, discount, sales, payment, balance)
    if (
      lowerKey.includes('amount') ||
      lowerKey.includes('value') ||
      lowerKey.includes('cost') ||
      lowerKey.includes('price') ||
      lowerKey.includes('revenue') ||
      lowerKey.includes('profit') ||
      lowerKey.includes('discount') ||
      lowerKey.includes('sales') ||
      lowerKey.includes('payment') ||
      lowerKey.includes('balance') ||
      lowerKey.includes('total') ||
      lowerKey.includes('subtotal')
    ) {
      return formatCurrency(value);
    }

    // Default number formatting
    return value.toLocaleString();
  }

  // Date fields
  if (value instanceof Date) {
    return formatTimestampDate(value.toISOString());
  }

  // String date fields (ISO format or YYYY-MM-DD)
  if (typeof value === 'string' && (lowerKey.includes('date') || lowerKey.includes('time'))) {
    return formatDisplayDate(value);
  }

  // Boolean fields
  if (typeof value === 'boolean') {
    return value ? '✓' : '✗';
  }

  // Default string formatting
  return String(value);
};

/**
 * Get color class for field value based on field type
 * Returns appropriate Tailwind color class for visual distinction
 */
const getFieldColorClass = (key: string, value: unknown): string => {
  const lowerKey = key.toLowerCase();

  // String-based status/priority coloring
  if (typeof value === 'string') {
    const upperVal = value.toUpperCase();
    if (lowerKey === 'priority' || lowerKey === 'urgency') {
      if (upperVal === 'URGENT' || upperVal === 'CRITICAL') return 'text-red-600';
      if (upperVal === 'HIGH') return 'text-orange-600';
      if (upperVal === 'MEDIUM') return 'text-yellow-600';
      return 'text-green-600';
    }
    if (lowerKey === 'demandtrend' || lowerKey === 'trend') {
      if (upperVal === 'INCREASING') return 'text-green-600';
      if (upperVal === 'DECREASING') return 'text-red-600';
      return 'text-gray-600';
    }
    return 'text-gray-900';
  }

  if (typeof value !== 'number') return 'text-gray-900';

  // Count-like fields — neutral color, not monetary
  const isCountField = (
    lowerKey.endsWith('orders') ||
    lowerKey.endsWith('suppliers') ||
    lowerKey.endsWith('customers') ||
    lowerKey.endsWith('products') ||
    lowerKey.endsWith('items') ||
    lowerKey.endsWith('transactions') ||
    lowerKey.endsWith('batches') ||
    lowerKey.endsWith('records') ||
    lowerKey.endsWith('movements') ||
    lowerKey.endsWith('entries') ||
    lowerKey.endsWith('receipts') ||
    lowerKey.endsWith('invoices') ||
    lowerKey.endsWith('users') ||
    lowerKey.endsWith('categories') ||
    lowerKey.includes('count') ||
    lowerKey.includes('needingreorder')
  );
  if (isCountField) {
    return 'text-blue-600';
  }

  // Non-monetary numeric fields (terms, method, status, days, velocity, stock, safety, reorder, forecast)
  const isNonMonetaryField = (
    lowerKey.endsWith('terms') ||
    lowerKey.endsWith('method') ||
    lowerKey.endsWith('status') ||
    lowerKey.endsWith('type') ||
    lowerKey.endsWith('days') ||
    lowerKey.includes('velocity') ||
    lowerKey.includes('safetystock') ||
    lowerKey.includes('reorderpoint') ||
    lowerKey.includes('stock') ||
    lowerKey.includes('level') ||
    lowerKey.includes('trendratio') ||
    lowerKey.includes('forecast') ||
    lowerKey.includes('seasonalindex') ||
    lowerKey.includes('learningcycles')
  );
  if (isNonMonetaryField) {
    return 'text-gray-900';
  }

  // Discount fields - always red
  if (lowerKey.includes('discount')) {
    return 'text-red-600';
  }

  // Cost/expense fields - orange
  if (lowerKey.includes('cost') || lowerKey.includes('expense')) {
    return 'text-orange-600';
  }

  // Profit fields - green if positive, red if negative
  if (lowerKey.includes('profit')) {
    return value >= 0 ? 'text-green-600' : 'text-red-600';
  }

  // Revenue/sales/income fields - green
  if (lowerKey.includes('revenue') || lowerKey.includes('sales') || lowerKey.includes('income')) {
    return 'text-green-600';
  }

  // Percentage fields - green if positive, red if negative
  if (
    lowerKey.includes('margin') ||
    lowerKey.includes('rate') ||
    lowerKey.includes('percentage') ||
    lowerKey.includes('change')
  ) {
    return value >= 0 ? 'text-green-600' : 'text-red-600';
  }

  // Default green for positive monetary values
  if (
    lowerKey.includes('amount') ||
    lowerKey.includes('value') ||
    lowerKey.includes('price') ||
    lowerKey.includes('payment') ||
    lowerKey.includes('balance')
  ) {
    return 'text-green-600';
  }

  return 'text-gray-900';
};

// Report type definitions
type ReportType =
  | 'INVENTORY_VALUATION'
  | 'SALES_REPORT'
  | 'EXPIRING_ITEMS'
  | 'LOW_STOCK'
  | 'BEST_SELLING_PRODUCTS'
  | 'SUPPLIER_COST_ANALYSIS'
  | 'GOODS_RECEIVED'
  | 'PAYMENT_REPORT'
  | 'CUSTOMER_PAYMENTS'
  | 'PROFIT_LOSS'
  | 'DELETED_ITEMS'
  | 'INVENTORY_ADJUSTMENTS'
  | 'PURCHASE_ORDER_SUMMARY'
  | 'STOCK_MOVEMENT_ANALYSIS'
  | 'CUSTOMER_ACCOUNT_STATEMENT'
  | 'PROFIT_MARGIN_BY_PRODUCT'
  | 'DAILY_CASH_FLOW'
  | 'SUPPLIER_PAYMENT_STATUS'
  | 'TOP_CUSTOMERS'
  | 'STOCK_AGING'
  | 'WASTE_DAMAGE_REPORT'
  | 'REORDER_RECOMMENDATIONS'
  | 'SALES_BY_CATEGORY'
  | 'SALES_BY_PAYMENT_METHOD'
  | 'HOURLY_SALES_ANALYSIS'
  | 'SALES_COMPARISON'
  | 'CUSTOMER_PURCHASE_HISTORY'
  | 'SALES_SUMMARY_BY_DATE'
  | 'SALES_DETAILS_REPORT'
  | 'SALES_BY_CASHIER'
  | 'CUSTOMER_AGING_REPORT'
  | 'CASH_REGISTER_SESSION'
  | 'CASH_REGISTER_MOVEMENT_BREAKDOWN'
  | 'CASH_REGISTER_SESSION_HISTORY'
  | 'SALES_RETURNS_ALLOWANCES'
  | 'PURCHASE_RETURNS_ALLOWANCES'
  | 'AR_LEDGER'
  | 'AP_LEDGER'
  | 'NOTE_REGISTER'
  | 'TAX_REVERSAL'
  | 'TAX_COMPLIANCE'
  | 'LIQUIDITY_MOVEMENTS'
  | 'SUPPLIER_STATEMENT'
  | 'SUPPLIER_AGING'
  | 'VOID_SALES_REPORT'
  | 'REFUND_REPORT'
  | 'ORDERS_REPORT'
  | 'CANCELLED_ORDERS_REPORT';

interface ReportOption {
  value: ReportType;
  label: string;
  description: string;
  requiresDateRange: boolean;
  supportsFilters: string[];
  category: 'Sales' | 'Inventory' | 'Financial' | 'Customer' | 'Supplier';
  icon: string;
}

/** Customer suite — dedicated SSOT layout (skip generic summary/table dump). */
const CUSTOMER_SSOT_REPORTS = new Set<ReportType>([
  'CUSTOMER_PAYMENTS',
  'CUSTOMER_ACCOUNT_STATEMENT',
  'CUSTOMER_AGING_REPORT',
  'TOP_CUSTOMERS',
  'CUSTOMER_PURCHASE_HISTORY',
  'AR_LEDGER',
]);

/** Reports that must pick one customer before generate. */
const CUSTOMER_REQUIRED_REPORTS = new Set<ReportType>([
  'CUSTOMER_ACCOUNT_STATEMENT',
  'CUSTOMER_PURCHASE_HISTORY',
]);

/** Supplier suite — partner-ledger SSOT (skip generic dump). */
const SUPPLIER_SSOT_REPORTS = new Set<ReportType>([
  'SUPPLIER_STATEMENT',
  'AP_LEDGER',
]);

/** Reports that must pick one supplier before generate. */
const SUPPLIER_REQUIRED_REPORTS = new Set<ReportType>(['SUPPLIER_STATEMENT']);

/** Financial + ops reports with dedicated SSOT layouts (skip generic dump). */
const FINANCIAL_SSOT_REPORTS = new Set<string>([
  'PAYMENT_REPORT',
  'PROFIT_LOSS',
  'PROFIT_MARGIN_BY_PRODUCT',
  'DAILY_CASH_FLOW',
  'CASH_REGISTER_SESSION',
  'CASH_REGISTER_SESSION_SUMMARY',
  'CASH_REGISTER_MOVEMENT_BREAKDOWN',
  'CASH_REGISTER_SESSION_HISTORY',
  'SALES_RETURNS_ALLOWANCES',
  'PURCHASE_RETURNS_ALLOWANCES',
  'NOTE_REGISTER',
  'TAX_REVERSAL',
  'SALES_BY_CASHIER',
  'SALES_COMPARISON',
  'REFUND_REPORT',
  'VOID_SALES_REPORT',
  'EXPIRING_ITEMS',
]);

/** True when this report type has a dedicated renderer — never also dump generic summary/table. */
function isSsotReportType(reportType: string | undefined | null): boolean {
  if (!reportType) return false;
  return (
    CUSTOMER_SSOT_REPORTS.has(reportType as ReportType) ||
    SUPPLIER_SSOT_REPORTS.has(reportType as ReportType) ||
    FINANCIAL_SSOT_REPORTS.has(reportType)
  );
}

const REPORT_OPTIONS: ReportOption[] = [
  {
    value: 'SALES_REPORT',
    label: 'Sales Analysis',
    description:
      'Designable sales register — by day, cashier, payment type, product, or customer; pick columns',
    requiresDateRange: true,
    supportsFilters: ['groupBy', 'customer', 'paymentMethod', 'sessionId'],
    category: 'Sales',
    icon: '📊',
  },
  {
    value: 'EXPIRING_ITEMS',
    label: 'Expiring Items',
    description:
      'Shelf-life register — expired and near-expiry batches on hand, value at cost, urgency bands',
    requiresDateRange: false,
    supportsFilters: ['daysAhead', 'category'],
    category: 'Inventory',
    icon: '⏰',
  },
  {
    value: 'LOW_STOCK',
    label: 'Low Stock Alert',
    description: 'Products below reorder levels (Critical/Low/Warning)',
    requiresDateRange: false,
    supportsFilters: ['threshold', 'category'],
    category: 'Inventory',
    icon: '⚠️',
  },
  {
    value: 'BEST_SELLING_PRODUCTS',
    label: 'Best Selling Products',
    description: 'Top products by quantity sold or revenue',
    requiresDateRange: true,
    supportsFilters: ['limit', 'category'],
    category: 'Sales',
    icon: '🏆',
  },
  {
    value: 'SUPPLIER_COST_ANALYSIS',
    label: 'Supplier Cost Analysis',
    description: 'Performance metrics, lead times, and costs by supplier',
    requiresDateRange: true,
    supportsFilters: ['supplier'],
    category: 'Supplier',
    icon: '🏭',
  },
  {
    value: 'GOODS_RECEIVED',
    label: 'Goods Received',
    description: 'Detailed goods receipt log with values',
    requiresDateRange: true,
    supportsFilters: ['supplier', 'product'],
    category: 'Inventory',
    icon: '📥',
  },
  {
    value: 'PAYMENT_REPORT',
    label: 'Payment Report',
    description:
      'Payment method breakdown — liquid receipts with counts, totals, and share of period collections',
    requiresDateRange: true,
    supportsFilters: ['paymentMethod'],
    category: 'Financial',
    icon: '💳',
  },
  {
    value: 'CUSTOMER_PAYMENTS',
    label: 'Customer Payments',
    description:
      'Collections by payment date, open-item outstanding/overdue, and payment history lines (AR receipts)',
    requiresDateRange: true,
    supportsFilters: ['customer', 'status'],
    category: 'Customer',
    icon: '💰',
  },
  {
    value: 'PROFIT_LOSS',
    label: 'Profit & Loss',
    description:
      'Profit & loss — revenue, COGS, gross profit, operating expenses, and net margin for the period',
    requiresDateRange: true,
    supportsFilters: ['groupBy'],
    category: 'Financial',
    icon: '📈',
  },
  {
    value: 'DELETED_ITEMS',
    label: 'Deleted Items',
    description: 'Audit trail of deactivated products',
    requiresDateRange: false,
    supportsFilters: [],
    category: 'Inventory',
    icon: '🗑️',
  },
  {
    value: 'INVENTORY_ADJUSTMENTS',
    label: 'Inventory Adjustments',
    description: 'Stock movement history with reasons',
    requiresDateRange: true,
    supportsFilters: ['product'],
    category: 'Inventory',
    icon: '🔄',
  },
  {
    value: 'PURCHASE_ORDER_SUMMARY',
    label: 'Purchase Order Summary',
    description: 'PO status, supplier performance, and ordering trends',
    requiresDateRange: true,
    supportsFilters: ['supplier', 'status'],
    category: 'Supplier',
    icon: '📋',
  },
  {
    value: 'STOCK_MOVEMENT_ANALYSIS',
    label: 'Stock Movement Analysis',
    description: 'Detailed stock movements by type (goods receipt, sales, etc.)',
    requiresDateRange: true,
    supportsFilters: ['product', 'movementType'],
    category: 'Inventory',
    icon: '📦',
  },
  {
    value: 'CUSTOMER_ACCOUNT_STATEMENT',
    label: 'Customer Account Statement',
    description:
      'Customer account statement — opening/closing balance, invoices, payments, credit/debit notes',
    requiresDateRange: true,
    supportsFilters: ['customer'],
    category: 'Customer',
    icon: '📄',
  },
  {
    value: 'CUSTOMER_AGING_REPORT',
    label: 'Customer Aging Report',
    description:
      'Open-item aged receivables (0-30, 31-60, 61-90, 90+) net of on-account receipts',
    requiresDateRange: false,
    supportsFilters: [],
    category: 'Customer',
    icon: '📊',
  },
  {
    value: 'PROFIT_MARGIN_BY_PRODUCT',
    label: 'Profit Margin by Product',
    description:
      'Product profitability — revenue, cost, gross profit, and margin % by SKU',
    requiresDateRange: true,
    supportsFilters: ['category', 'minMargin'],
    category: 'Financial',
    icon: '💹',
  },
  {
    value: 'DAILY_CASH_FLOW',
    label: 'Daily Cash Flow',
    description:
      'Daily cash journal — POS liquid receipts, AR collections, deposits; credit sales as memo only',
    requiresDateRange: true,
    supportsFilters: [],
    category: 'Financial',
    icon: '💵',
  },
  {
    value: 'SUPPLIER_PAYMENT_STATUS',
    label: 'Supplier Payment Status',
    description: 'Outstanding supplier payment tracking with payment details',
    requiresDateRange: false,
    supportsFilters: ['supplier', 'status'],
    category: 'Supplier',
    icon: '💸',
  },
  {
    value: 'TOP_CUSTOMERS',
    label: 'Top Customers',
    description: 'Customer ranking by revenue, orders, or profit (voids excluded; AR open-item outstanding)',
    requiresDateRange: true,
    supportsFilters: ['limit', 'sortBy'],
    category: 'Customer',
    icon: '⭐',
  },
  {
    value: 'STOCK_AGING',
    label: 'Stock Aging Report',
    description: 'Inventory aging analysis with days in stock',
    requiresDateRange: false,
    supportsFilters: ['category'],
    category: 'Inventory',
    icon: '📅',
  },
  {
    value: 'WASTE_DAMAGE_REPORT',
    label: 'Waste & Damage Report',
    description: 'Loss tracking by reason (damage, expiry, theft)',
    requiresDateRange: true,
    supportsFilters: ['reason'],
    category: 'Inventory',
    icon: '⚠️',
  },
  {
    value: 'REORDER_RECOMMENDATIONS',
    label: 'Smart Reorder AI',
    description: 'AI inventory assistant: sales velocity, lead times, seasonal trends, safety stock',
    requiresDateRange: false,
    supportsFilters: ['daysToConsider', 'category'],
    category: 'Inventory',
    icon: '🤖',
  },
  {
    value: 'SALES_BY_CATEGORY',
    label: 'Sales by Category',
    description: 'Revenue and profit analysis grouped by product category',
    requiresDateRange: true,
    supportsFilters: ['category'],
    category: 'Sales',
    icon: '📂',
  },
  {
    value: 'SALES_BY_PAYMENT_METHOD',
    label: 'Sales by Payment Method',
    description: 'Payment method breakdown with percentages and totals',
    requiresDateRange: true,
    supportsFilters: [],
    category: 'Sales',
    icon: '💳',
  },
  {
    value: 'HOURLY_SALES_ANALYSIS',
    label: 'Hourly Sales Analysis',
    description: 'Sales patterns by hour of day with peak time identification',
    requiresDateRange: true,
    supportsFilters: [],
    category: 'Sales',
    icon: '🕐',
  },
  {
    value: 'SALES_COMPARISON',
    label: 'Sales Comparison',
    description:
      'Period-over-period sales — compare current vs previous range by day, week, or month (aligned by sequence, not calendar date)',
    requiresDateRange: true,
    supportsFilters: ['groupBy'],
    category: 'Sales',
    icon: '📉',
  },
  {
    value: 'CUSTOMER_PURCHASE_HISTORY',
    label: 'Customer Purchase History',
    description: 'Sale history for a customer (excludes voided/refunded tickets)',
    requiresDateRange: true,
    supportsFilters: ['customer'],
    category: 'Customer',
    icon: '🛒',
  },
  {
    value: 'SALES_SUMMARY_BY_DATE',
    label: 'Sales Summary by Date',
    description: 'Temporal sales analysis grouped by day, week, or month',
    requiresDateRange: true,
    supportsFilters: ['groupBy'],
    category: 'Sales',
    icon: '📅',
  },
  {
    value: 'SALES_DETAILS_REPORT',
    label: 'Sales Details Report',
    description: 'Product sales by date showing quantity (in sale UOM), revenue, and profit margin %',
    requiresDateRange: true,
    supportsFilters: ['productId'],
    category: 'Sales',
    icon: '📋',
  },
  {
    value: 'SALES_BY_CASHIER',
    label: 'Sales by Cashier',
    description: 'Sale line accountability report — who ordered and who received payment',
    requiresDateRange: true,
    supportsFilters: ['cashierId', 'orderedById', 'productId'],
    category: 'Sales',
    icon: '👤',
  },
  {
    value: 'CASH_REGISTER_SESSION',
    label: 'Cash Register Session Summary',
    description:
      'Cash register session — opening float, sales, refunds, drops, expected vs counted cash',
    requiresDateRange: false,
    supportsFilters: ['sessionId'],
    category: 'Financial',
    icon: '🧾',
  },
  {
    value: 'CASH_REGISTER_MOVEMENT_BREAKDOWN',
    label: 'Cash Register Movement Breakdown',
    description:
      'Cash drawer journal by movement type — sales, refunds, cash in/out, and adjustments',
    requiresDateRange: true,
    supportsFilters: [],
    category: 'Financial',
    icon: '💰',
  },
  {
    value: 'CASH_REGISTER_SESSION_HISTORY',
    label: 'Cash Register Session History',
    description:
      'Historical till sessions with open/close times, cashiers, and variance',
    requiresDateRange: true,
    supportsFilters: ['cashierId'],
    category: 'Financial',
    icon: '📜',
  },
  // ── Credit / Debit Note Reports ──────────────────────────
  {
    value: 'SALES_RETURNS_ALLOWANCES',
    label: 'Sales Returns & Allowances',
    description:
      'Sales returns & allowances — customer credit notes impacting revenue and tax',
    requiresDateRange: true,
    supportsFilters: [],
    category: 'Financial',
    icon: '↩️',
  },
  {
    value: 'PURCHASE_RETURNS_ALLOWANCES',
    label: 'Purchase Returns & Allowances',
    description:
      'Purchase returns & allowances — supplier credit notes impacting purchases and AP',
    requiresDateRange: true,
    supportsFilters: [],
    category: 'Financial',
    icon: '🔄',
  },
  {
    value: 'AR_LEDGER',
    label: 'Accounts Receivable Ledger',
    description:
      'GL control account 1200 ledger — invoices, payments, CN/DN, running balance (same axis as statement)',
    requiresDateRange: true,
    supportsFilters: ['customer'],
    category: 'Customer',
    icon: '📒',
  },
  {
    value: 'AP_LEDGER',
    label: 'Accounts Payable Ledger',
    description:
      'Accounts payable ledger — bills, payments, credit/debit notes, running balance; filter one supplier or all',
    requiresDateRange: true,
    supportsFilters: ['supplier'],
    category: 'Supplier',
    icon: '📕',
  },
  {
    value: 'NOTE_REGISTER',
    label: 'Credit / Debit Note Register',
    description:
      'Complete CN/DN register (customer & supplier) with status, tax, and GL document references',
    requiresDateRange: true,
    supportsFilters: ['noteSide', 'noteDocumentType', 'status'],
    category: 'Financial',
    icon: '📑',
  },
  {
    value: 'TAX_REVERSAL',
    label: 'Tax Reversal Report',
    description:
      'Tax impact of credit and debit notes for VAT/GST period reconciliation',
    requiresDateRange: true,
    supportsFilters: [],
    category: 'Financial',
    icon: '🏛️',
  },
  {
    value: 'TAX_COMPLIANCE',
    label: 'Tax Compliance Reports',
    description:
      'VAT summary, WHT register, and tax liability rollforward',
    requiresDateRange: true,
    supportsFilters: [],
    category: 'Financial',
    icon: '📋',
  },
  {
    value: 'LIQUIDITY_MOVEMENTS',
    label: 'Liquidity Movements',
    description:
      'Cash, bank, mobile money, and petty cash register — filter the period and choose what to show',
    requiresDateRange: true,
    supportsFilters: ['account'],
    category: 'Financial',
    icon: '🏦',
  },
  {
    value: 'SUPPLIER_STATEMENT',
    label: 'Supplier Statement',
    description:
      'Supplier account statement — bills, payments, credit/debit notes, opening/closing balance',
    requiresDateRange: true,
    supportsFilters: ['supplier'],
    category: 'Supplier',
    icon: '📄',
  },
  {
    value: 'SUPPLIER_AGING',
    label: 'Supplier Aging (Aged Payables)',
    description: 'Aged payables analysis by supplier with current, 30, 60, 90+ day buckets',
    requiresDateRange: false,
    supportsFilters: [],
    category: 'Supplier',
    icon: '⏳',
  },
  {
    value: 'VOID_SALES_REPORT',
    label: 'Void Sales Report',
    description:
      'Cancellation register — voided sales with reason, operator, accounting reversal docs (not credit-memo returns)',
    requiresDateRange: true,
    supportsFilters: [],
    category: 'Sales',
    icon: '🚫',
  },
  {
    value: 'REFUND_REPORT',
    label: 'Refund / Returns Report',
    description:
      'Credit memo register — document headers, line reversals (revenue/COGS/profit), stock return proof, top products',
    requiresDateRange: true,
    supportsFilters: [],
    category: 'Sales',
    icon: '↩️',
  },
  {
    value: 'ORDERS_REPORT',
    label: 'Orders Report',
    description:
      'Order register — pick columns to show or export (status, creator, cashier, cancel detail)',
    requiresDateRange: true,
    supportsFilters: ['status', 'userId'],
    category: 'Sales',
    icon: '📝',
  },
  {
    value: 'CANCELLED_ORDERS_REPORT',
    label: 'Cancelled Orders Report',
    description:
      'Cancelled orders designer — choose columns for reasons, canceller, and lost value export',
    requiresDateRange: true,
    supportsFilters: ['userId'],
    category: 'Sales',
    icon: '❌',
  },
];

// Dynamic report data interface - covers all report types
interface ReportDataSummary {
  totalCashIn?: number;
  overallProfitMargin?: number;
  salesRevenue?: number;
  salesPercent?: number;
  debtCollections?: number;
  collectionsPercent?: number;
  totalDays?: number;
  totalSalesValue?: number;
  grossProfit?: number;
  totalTransactions?: number;
  creditExtended?: number;
  businessInsights?: string | string[];
  openingBalance?: number;
  closingBalance?: number;
  totalOutstanding?: number;
  unallocatedReceiptsTotal?: number;
  collectionsInPeriod?: number;
  collectionCount?: number;
  totalDebits?: number;
  totalCredits?: number;
  totalDebit?: number;
  totalCredit?: number;
  isCustomerCredit?: boolean;
  // Cash register session summary
  openingFloat?: number;
  expectedClosing?: number;
  totalSales?: number;
  totalCashOut?: number;
  totalRefunds?: number;
  actualClosing?: number;
  variance?: number;
  netCashFlow?: number;
  // Cash register session history
  totalSessions?: number;
  openSessions?: number;
  closedSessions?: number;
  totalVariance?: number;
  averageVariance?: number;
  sessionsWithVariance?: number;
  // Cash register movement breakdown
  sessionCount?: number;
  movementCount?: number;
  // Profit & Loss
  totalRevenue?: number;
  totalCOGS?: number;
  grossProfitMargin?: number;
  totalExpenses?: number;
  operatingProfit?: number;
  netProfit?: number;
  netProfitMargin?: number;
  totalSupplierPayments?: number;
  supplierPaymentCount?: number;
  depositReceipts?: number;
  depositsPercent?: number;
  [key: string]: unknown;
}

interface ReportDataCustomer {
  customerNumber?: string;
  name?: string;
  email?: string;
  phone?: string;
  creditLimit?: number;
  currentBalance?: number;
}

interface ReportDataCategoryRow {
  category: string;
  productCount: number;
  quantityOnHand: number;
  costValue: number;
  potentialRevenue: number;
  potentialProfit: number;
  profitMargin: number;
}

interface SupplierPaymentRecord {
  paymentNumber: string;
  supplierName: string;
  paymentDate: string;
  amount: number;
  paymentMethod: string;
  status: string;
  reference?: string;
  allocatedAmount: number;
  unallocatedAmount: number;
  notes?: string;
  allocations: { invoiceNumber: string; amountAllocated: number; allocationDate: string }[];
}

interface ReportData {
  reportName?: string;
  reportType?: string;
  generatedAt?: string;
  recordCount?: number;
  executionTimeMs?: number;
  summary: ReportDataSummary;
  data: Record<string, unknown>[];
  customer?: ReportDataCustomer;
  transactions?: Record<string, unknown>[];
  paymentLines?: Array<Record<string, unknown>>;
  unallocatedReceiptsTotal?: number;
  byCategory?: ReportDataCategoryRow[];
  payments?: SupplierPaymentRecord[];
  // Void sales report
  byReason?: Array<{ reason: string; count: number; totalAmount: number }>;
  // Refund report
  lineItems?: Array<Record<string, unknown>>;
  topRefundedProducts?: Array<Record<string, unknown>>;
  // Cash register session summary
  session?: {
    sessionNumber?: string;
    registerName?: string;
    cashierName?: string;
    status?: string;
    openedAt?: string;
    closedAt?: string | null;
  };
  salesSummary?: {
    totalTransactions?: number;
    totalRevenue?: number;
    totalProfit?: number;
  };
  sales?: Array<Record<string, unknown>>;
  movements?: Array<Record<string, unknown>>;
  // Cash register session history
  sessions?: Array<Record<string, unknown>>;
  // Cash register movement breakdown
  totals?: {
    totalCashIn?: number;
    totalCashOut?: number;
    totalSales?: number;
    totalRefunds?: number;
    netCashFlow?: number;
    sessionCount?: number;
    movementCount?: number;
  };
  byMovementType?: Record<string, { count: number; amount: number }>;
  // Profit & Loss
  parameters?: { startDate?: string; endDate?: string;[key: string]: unknown };
  expenseBreakdown?: Array<{
    accountCode: string;
    accountName: string;
    entryCount: number;
    totalAmount: number;
  }>;
  // Cash register movement breakdown - daily
  dailyBreakdown?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export default function ReportsPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  /** Clearance markdown is ADMIN-only — UI mirrors server; inventory.adjust cannot unlock it. */
  const canClearanceMarkdown = canPerformLotWriteDown(user?.role);
  const [selectedReport, setSelectedReport] = useState<ReportType | null>(null);
  const [startDate, setStartDate] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);
  const [reportData, setReportData] = useState<ReportData | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Expiring Items KPI card → register filter (all | expired | critical | warning | watch). */
  const [expiringBandFilter, setExpiringBandFilter] = useState<ExpiryBandFilter>('all');
  /** Smart find: product / SKU / batch (client filter; KPIs stay full-horizon). */
  const [expiringSearch, setExpiringSearch] = useState('');
  const [expiringQuarantineBusyId, setExpiringQuarantineBusyId] = useState<string | null>(null);
  const [expiringQuarantineMsg, setExpiringQuarantineMsg] = useState<string | null>(null);
  const [expiringWriteDownBusyId, setExpiringWriteDownBusyId] = useState<string | null>(null);

  // Filter states
  const [groupBy, setGroupBy] = useState<'day' | 'week' | 'month' | 'product' | 'customer' | 'payment_method'>('day');
  const [daysAhead, setDaysAhead] = useState<number>(LOT_WRITE_DOWN_MAX_DAYS);
  const [limit, setLimit] = useState<number>(20);
  const [threshold, setThreshold] = useState<number>(50);
  const [sortBy, setSortBy] = useState<'REVENUE' | 'ORDERS' | 'PROFIT'>('REVENUE');
  const [daysToConsider, setDaysToConsider] = useState<number>(30);
  const [minMargin, setMinMargin] = useState<number>(0);
  const [movementType, setMovementType] = useState<string>('');
  const [reason, setReason] = useState<string>('');
  const [status, setStatus] = useState<string>('');

  // Sales Comparison specific states
  const [previousStartDate, setPreviousStartDate] = useState<string>('');
  const [previousEndDate, setPreviousEndDate] = useState<string>('');

  // Customer Purchase History specific state
  const [customerId, setCustomerId] = useState<string>('');
  const [customersList, setCustomersList] = useState<Array<{ id: string; customerNumber: string; name: string }>>([]);
  const [customersLoading, setCustomersLoading] = useState(false);

  // Cash Register Session specific state
  const [sessionId, setSessionId] = useState<string>('');

  // Supplier Statement specific state
  const [supplierId, setSupplierId] = useState<string>('');
  const [suppliersList, setSuppliersList] = useState<Array<{ id: string; supplierNumber: string; name: string }>>([]);
  const [suppliersLoading, setSuppliersLoading] = useState(false);

  // Note Register filters
  const [noteSide, setNoteSide] = useState<string>('');
  const [noteDocumentType, setNoteDocumentType] = useState<string>('');

  // Category filter for inventory valuation
  const [categoryFilter, setCategoryFilter] = useState<string>('');
  const [availableCategories, setAvailableCategories] = useState<string[]>([]);
  const [categoriesLoading, setCategoriesLoading] = useState(false);

  // Sales by Cashier filters
  const [sbcCashierId, setSbcCashierId] = useState<string>('');
  const [sbcOrderedById, setSbcOrderedById] = useState<string>('');
  const [sbcProductId, setSbcProductId] = useState<string>('');
  const [sbcUsersList, setSbcUsersList] = useState<Array<{ id: string; full_name: string }>>([]);
  const [sbcUsersLoading, setSbcUsersLoading] = useState(false);
  const [sbcProductsList, setSbcProductsList] = useState<Array<{ id: string; name: string }>>([]);
  const [sbcProductsLoading, setSbcProductsLoading] = useState(false);

  // Fetch customers for any report that supports the shared customer picker
  useEffect(() => {
    const option = REPORT_OPTIONS.find((r) => r.value === selectedReport);
    if (option?.supportsFilters.includes('customer')) {
      setCustomersLoading(true);
      const token = localStorage.getItem('auth_token');
      api.get('/customers', {
        params: { limit: 500 },
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
        .then(res => {
          const data = res.data?.data;
          const list = Array.isArray(data) ? data : data?.data || [];
          setCustomersList(list.map((c: Record<string, unknown>) => ({
            id: String(c.id),
            customerNumber: String(c.customerNumber || c.customer_number || ''),
            name: String(c.name || ''),
          })));
        })
        .catch(() => { /* customers fetch failed */ })
        .finally(() => setCustomersLoading(false));
    }
  }, [selectedReport]);

  // Fetch suppliers for any report that supports the shared supplier picker
  useEffect(() => {
    const option = REPORT_OPTIONS.find((r) => r.value === selectedReport);
    if (option?.supportsFilters.includes('supplier')) {
      setSuppliersLoading(true);
      const token = localStorage.getItem('auth_token');
      api.get('/suppliers', {
        params: { limit: 500 },
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
        .then(res => {
          const data = res.data?.data;
          const list = Array.isArray(data) ? data : data?.data || [];
          setSuppliersList(list.map((s: Record<string, unknown>) => ({
            id: String(s.id),
            supplierNumber: String(s.supplierNumber || s.SupplierCode || ''),
            name: String(s.name || s.CompanyName || ''),
          })));
        })
        .catch(() => { /* suppliers fetch failed */ })
        .finally(() => setSuppliersLoading(false));
    }
  }, [selectedReport]);

  // Fetch categories whenever a category-filtered report is selected
  useEffect(() => {
    const option = REPORT_OPTIONS.find((r) => r.value === selectedReport);
    if (option?.supportsFilters.includes('category')) {
      setCategoriesLoading(true);
      const token = localStorage.getItem('auth_token');
      api.get('/reports/product-categories', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
        .then(res => {
          const cats = res.data?.data;
          if (Array.isArray(cats)) setAvailableCategories(cats);
        })
        .catch(() => { /* categories are optional, silently fail */ })
        .finally(() => setCategoriesLoading(false));
    }
  }, [selectedReport]);

  // Fetch users list for Sales by Cashier filters
  useEffect(() => {
    if (selectedReport === 'SALES_BY_CASHIER') {
      setSbcUsersLoading(true);
      const token = localStorage.getItem('auth_token');
      api.get('/users', {
        params: { limit: 200, is_active: true },
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
        .then(res => {
          const rows = res.data?.data?.data || res.data?.data || [];
          setSbcUsersList(Array.isArray(rows) ? rows.map((u: Record<string, unknown>) => ({
            id: String(u.id),
            full_name: String(u.full_name || u.fullName || u.name || ''),
          })) : []);
        })
        .catch(() => { /* silently fail */ })
        .finally(() => setSbcUsersLoading(false));

      setSbcProductsLoading(true);
      api.get('/products', {
        params: { limit: 1000, is_active: true },
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
        .then(res => {
          const rows = res.data?.data?.data || res.data?.data || [];
          setSbcProductsList(Array.isArray(rows) ? rows.map((p: Record<string, unknown>) => ({
            id: String(p.id),
            name: String(p.name || p.productName || ''),
          })) : []);
        })
        .catch(() => { /* silently fail */ })
        .finally(() => setSbcProductsLoading(false));
    }
  }, [selectedReport]);

  const selectedReportOption = REPORT_OPTIONS.find((r) => r.value === selectedReport);

  const handleGenerateReport = async () => {
    if (!selectedReport) {
      setError('Please select a report type');
      return;
    }

    // Redirect to dedicated dashboard for reorder intelligence
    if (selectedReport === 'REORDER_RECOMMENDATIONS') {
      navigate('/reports/reorder');
      return;
    }

    if (selectedReport === 'TAX_COMPLIANCE') {
      navigate('/reports/tax-compliance');
      return;
    }

    if (selectedReport === 'LIQUIDITY_MOVEMENTS') {
      navigate('/reports/liquidity-movements');
      return;
    }

    if (selectedReport === 'SALES_REPORT') {
      navigate('/reports/sales-analysis');
      return;
    }

    if (selectedReport === 'ORDERS_REPORT') {
      navigate('/reports/orders');
      return;
    }

    if (selectedReport === 'CANCELLED_ORDERS_REPORT') {
      navigate('/reports/orders?mode=cancelled');
      return;
    }

    // Aging uses its own SSOT component (single fetch) — no duplicate generate API
    if (selectedReport === 'CUSTOMER_AGING_REPORT') {
      setError(null);
      setReportData({
        reportType: 'CUSTOMER_AGING_REPORT',
        reportName: 'Customer Aging Report',
        generatedAt: new Date().toISOString(),
        data: [],
        summary: {},
        recordCount: 0,
        executionTimeMs: 0,
      });
      return;
    }

    const reportOption = REPORT_OPTIONS.find((r) => r.value === selectedReport);
    if (reportOption?.requiresDateRange && (!startDate || !endDate)) {
      setError('Please select start and end dates');
      return;
    }

    if (
      selectedReport &&
      CUSTOMER_REQUIRED_REPORTS.has(selectedReport) &&
      !customerId.trim()
    ) {
      setError('Please select a customer');
      return;
    }

    if (selectedReport === 'SUPPLIER_STATEMENT' && !supplierId.trim()) {
      setError('Please select a supplier for Supplier Statement');
      return;
    }

    if (selectedReport === 'SALES_COMPARISON') {
      if (!previousStartDate || !previousEndDate) {
        setError('Please select previous period start and end dates');
        return;
      }
    }

    setIsLoading(true);
    setError(null);
    setReportData(null);

    try {
      // Build request parameters based on report type
      const params: Record<string, string | number | undefined> = {
        reportType: selectedReport,
      };

      if (startDate) params.startDate = startDate;
      if (endDate) params.endDate = endDate;

      // Add specific filters based on report type
      if (selectedReport === 'PROFIT_LOSS') {
        params.groupBy = groupBy;
        if (sessionId) params.sessionId = sessionId;
      } else if (selectedReport === 'EXPIRING_ITEMS') {
        params.daysAhead = daysAhead;
      } else if (selectedReport === 'LOW_STOCK') {
        params.threshold = threshold;
      } else if (selectedReport === 'BEST_SELLING_PRODUCTS') {
        params.limit = limit;
      } else if (selectedReport === 'TOP_CUSTOMERS') {
        params.limit = limit;
        params.sortBy = sortBy;
      } else if (selectedReport === 'PROFIT_MARGIN_BY_PRODUCT' && minMargin > 0) {
        params.minMargin = minMargin;
      } else if (selectedReport === 'STOCK_MOVEMENT_ANALYSIS' && movementType) {
        params.movementType = movementType;
      } else if (selectedReport === 'WASTE_DAMAGE_REPORT' && reason) {
        params.reason = reason;
      } else if (selectedReport === 'SUPPLIER_PAYMENT_STATUS') {
        if (status) params.status = status;
      } else if (selectedReport === 'SALES_COMPARISON') {
        // Sales Comparison requires 4 dates: current period and previous period
        params.currentStartDate = startDate;
        params.currentEndDate = endDate;
        params.previousStartDate = previousStartDate;
        params.previousEndDate = previousEndDate;
        params.groupBy = groupBy;
      } else if (selectedReport === 'CUSTOMER_PURCHASE_HISTORY') {
        params.customerId = customerId;
      } else if (selectedReport === 'CUSTOMER_ACCOUNT_STATEMENT') {
        const selectedCustomer = customersList.find(c => c.id === customerId);
        params.customerNumber = selectedCustomer?.customerNumber || customerId;
      } else if (selectedReport === 'CUSTOMER_PAYMENTS') {
        if (customerId) params.customerId = customerId;
        if (status) params.status = status;
      } else if (selectedReport === 'SALES_SUMMARY_BY_DATE') {
        // Sales Summary by Date - requires groupBy
        params.groupBy = groupBy;
      } else if (selectedReport === 'CASH_REGISTER_SESSION') {
        // Cash Register Session requires session ID
        params.sessionId = sessionId;
      } else if (selectedReport === 'AR_LEDGER') {
        if (customerId) params.customerId = customerId;
      } else if (selectedReport === 'AP_LEDGER') {
        if (supplierId) params.supplierId = supplierId;
      } else if (selectedReport === 'NOTE_REGISTER') {
        if (noteSide) params.side = noteSide;
        if (noteDocumentType) params.documentType = noteDocumentType;
        if (status) params.status = status;
      } else if (selectedReport === 'SUPPLIER_STATEMENT') {
        params.supplierId = supplierId;
      } else if (selectedReport === 'ORDERS_REPORT') {
        if (status) params.status = status;
      } else if (selectedReport === 'SALES_BY_CATEGORY') {
        if (categoryFilter) params.category = categoryFilter;
      } else if (selectedReport === 'SALES_BY_CASHIER') {
        if (sbcCashierId) params.cashierId = sbcCashierId;
        if (sbcOrderedById) params.orderedById = sbcOrderedById;
        if (sbcProductId) params.productId = sbcProductId;
      }

      // Shared supplier filter for any report that declares it
      if (
        reportOption?.supportsFilters.includes('supplier') &&
        supplierId.trim()
      ) {
        params.supplierId = supplierId;
      }

      const { data: result } = await api.post('/reports/generate', params);

      setExpiringBandFilter('all');
      setExpiringSearch('');
      setReportData(result.data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to generate report');
    } finally {
      setIsLoading(false);
    }
  };

  const handleExportPDF = async () => {
    if (!selectedReport) {
      alert('Please select a report type first');
      return;
    }

    const reportOption = REPORT_OPTIONS.find((r) => r.value === selectedReport);
    if (reportOption?.requiresDateRange && (!startDate || !endDate)) {
      alert('Please select start and end dates');
      return;
    }
    if (selectedReport === 'SUPPLIER_STATEMENT' && !supplierId.trim()) {
      alert('Please select a supplier');
      return;
    }

    try {
      const token = localStorage.getItem('auth_token');

      // Map report types to their API endpoints
      const reportEndpointMap: Record<string, string> = {
        'SALES_DETAILS_REPORT': 'sales-details',
        'SALES_BY_CASHIER': 'sales-by-cashier',
        'SALES_SUMMARY_BY_DATE': 'sales-summary-by-date',
        'INVENTORY_VALUATION': 'inventory-valuation',
        'LOW_STOCK': 'low-stock',
        'EXPIRING_ITEMS': 'expiring-items',
        'BEST_SELLING_PRODUCTS': 'best-selling',
        'PAYMENT_REPORT': 'payments',
        'PROFIT_LOSS': 'profit-loss',
        'TOP_CUSTOMERS': 'top-customers',
        'SALES_REPORT': 'sales',
        'GOODS_RECEIVED': 'goods-received',
        'SUPPLIER_COST_ANALYSIS': 'supplier-cost-analysis',
        'CUSTOMER_PAYMENTS': 'customer-payments',
        'DAILY_CASH_FLOW': 'daily-cash-flow',
        'PURCHASE_ORDER_SUMMARY': 'purchase-order-summary',
        'STOCK_MOVEMENT_ANALYSIS': 'stock-movement-analysis',
        'PROFIT_MARGIN_BY_PRODUCT': 'profit-margin',
        'SUPPLIER_PAYMENT_STATUS': 'supplier-payment-status',
        'STOCK_AGING': 'stock-aging',
        'WASTE_DAMAGE_REPORT': 'waste-damage',
        'DELETED_ITEMS': 'deleted-items',
        'INVENTORY_ADJUSTMENTS': 'inventory-adjustments',
        'CUSTOMER_ACCOUNT_STATEMENT': 'customer-account-statement',
        'REORDER_RECOMMENDATIONS': 'reorder-recommendations',
        'SALES_BY_CATEGORY': 'sales-by-category',
        'SALES_BY_PAYMENT_METHOD': 'sales-by-payment-method',
        'HOURLY_SALES_ANALYSIS': 'hourly-sales-analysis',
        'SALES_COMPARISON': 'sales-comparison',
        'CUSTOMER_PURCHASE_HISTORY': 'customer-purchase-history',
        'CUSTOMER_AGING_REPORT': 'customer-aging',
        'CASH_REGISTER_MOVEMENT_BREAKDOWN': 'cash-register/movement-breakdown',
        'CASH_REGISTER_SESSION_HISTORY': 'cash-register/session-history',
        'SALES_RETURNS_ALLOWANCES': 'sales-returns',
        'PURCHASE_RETURNS_ALLOWANCES': 'purchase-returns',
        'AR_LEDGER': 'ar-ledger',
        'AP_LEDGER': 'ap-ledger',
        'NOTE_REGISTER': 'note-register',
        'TAX_REVERSAL': 'tax-reversal',
        'SUPPLIER_STATEMENT': 'supplier-statement',
        'SUPPLIER_AGING': 'supplier-aging',
        'VOID_SALES_REPORT': 'void-sales',
        'REFUND_REPORT': 'refunds',
        'ORDERS_REPORT': 'orders-report',
        'CANCELLED_ORDERS_REPORT': 'cancelled-orders',
      };

      const endpoint = reportEndpointMap[selectedReport];
      if (!endpoint) {
        alert('PDF export not yet available for this report');
        return;
      }

      // Build query parameters
      const params = new URLSearchParams();
      params.append('format', 'pdf');

      if (startDate) params.append('start_date', startDate);
      if (endDate) params.append('end_date', endDate);

      // Add report-specific parameters
      if (selectedReport === 'SALES_SUMMARY_BY_DATE' && groupBy) {
        params.append('group_by', groupBy);
      } else if (selectedReport === 'PROFIT_LOSS' && groupBy) {
        params.append('group_by', groupBy);
      } else if (selectedReport === 'EXPIRING_ITEMS') {
        params.append('days_threshold', daysAhead.toString());
        if (expiringBandFilter !== 'all') {
          params.append('urgency_band', expiringBandFilter);
        }
      } else if (selectedReport === 'LOW_STOCK') {
        params.append('threshold_percentage', threshold.toString());
      } else if (selectedReport === 'BEST_SELLING_PRODUCTS') {
        params.append('limit', limit.toString());
      } else if (selectedReport === 'TOP_CUSTOMERS') {
        params.append('limit', limit.toString());
        if (sortBy) params.append('sort_by', sortBy);
      } else if (selectedReport === 'CUSTOMER_ACCOUNT_STATEMENT' && customerId) {
        const selectedCustomer = customersList.find(c => c.id === customerId);
        params.append('customer_number', selectedCustomer?.customerNumber || customerId);
      } else if (selectedReport === 'CUSTOMER_PURCHASE_HISTORY' && customerId) {
        params.append('customer_id', customerId);
      } else if (selectedReport === 'CUSTOMER_PAYMENTS') {
        if (customerId) params.append('customer_id', customerId);
        if (status) params.append('status', status);
      } else if (selectedReport === 'AR_LEDGER' && customerId) {
        params.append('customer_id', customerId);
      } else if (selectedReport === 'AP_LEDGER' && supplierId) {
        params.append('supplier_id', supplierId);
      } else if (selectedReport === 'WASTE_DAMAGE_REPORT' && reason) {
        params.append('reason', reason);
      } else if (selectedReport === 'SALES_COMPARISON') {
        // Sales Comparison needs different date parameters - override the default ones
        params.delete('start_date');
        params.delete('end_date');
        params.append('current_start_date', startDate);
        params.append('current_end_date', endDate);
        params.append('previous_start_date', previousStartDate);
        params.append('previous_end_date', previousEndDate);
        if (groupBy) params.append('group_by', groupBy);
      } else if (selectedReport === 'SALES_BY_CATEGORY' && categoryFilter) {
        params.append('category', categoryFilter);
      }

      // Use relative URL to go through Vite proxy (avoids CORS issues)
      const path =
        selectedReport === 'SUPPLIER_STATEMENT' && supplierId
          ? `supplier-statement/${supplierId}`
          : endpoint;
      const url = `/api/reports/${path}?${params.toString()}`;

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        // Try to parse error as JSON
        const contentType = response.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
          const errorData = await response.json();
          throw new Error(errorData.error || 'Failed to generate PDF');
        } else {
          throw new Error(`Failed to generate PDF: ${response.statusText}`);
        }
      }

      // Verify we got a PDF
      const contentType = response.headers.get('content-type');
      if (!contentType || !contentType.includes('application/pdf')) {
        throw new Error('Server did not return a PDF file. Please try again.');
      }

      // Download the PDF
      const blob = await response.blob();

      console.log('PDF Blob Info:', {
        size: blob.size,
        type: blob.type,
        reportType: selectedReport
      });

      if (blob.size === 0) {
        throw new Error('Received empty PDF file from server');
      }

      const downloadUrl = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = downloadUrl;
      const bandSuffix =
        selectedReport === 'EXPIRING_ITEMS' && expiringBandFilter !== 'all'
          ? `-${expiringBandFilter}`
          : '';
      a.download = `${selectedReport.toLowerCase()}${bandSuffix}-${getBusinessDate()}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(downloadUrl);

    } catch (err: unknown) {
      console.error('PDF export error:', err);
      alert(err instanceof Error ? err.message : 'Failed to export PDF. Please try again.');
    }
  };

  /**
   * Export report data to CSV format
   * DYNAMIC: Automatically includes ALL fields from backend response
   * No manual field mapping required - new backend fields appear automatically
   */
  const handleExportCSV = () => {
    if (!reportData?.data) return;

    const exportRows =
      reportData.reportType === 'EXPIRING_ITEMS'
        ? filterExpiringRegisterRows(reportData.data, expiringBandFilter, expiringSearch)
        : reportData.data;

    if (!exportRows.length) {
      alert('No rows to export for the current filter.');
      return;
    }

    // Dynamic CSV export - automatically includes all fields from first row
    const headers = Object.keys(exportRows[0] || {});
    const csvContent =
      headers.join(',') +
      '\n' +
      exportRows
        .map((row: Record<string, unknown>) =>
          headers.map((header) => JSON.stringify(row[header] || '')).join(',')
        )
        .join('\n');

    const bandSuffix =
      reportData.reportType === 'EXPIRING_ITEMS' && expiringBandFilter !== 'all'
        ? `_${expiringBandFilter}`
        : '';
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${selectedReport}${bandSuffix}_${getBusinessDate()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const renderFilterOptions = () => {
    if (!selectedReportOption) return null;

    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {/* Date Range Filters */}
        {selectedReportOption.requiresDateRange && (
          <div className="col-span-full">
            <DateRangeFilter
              startDate={startDate}
              endDate={endDate}
              onStartDateChange={setStartDate}
              onEndDateChange={setEndDate}
              defaultPreset="THIS_MONTH"
            />
          </div>
        )}

        {/* Category Filter */}
        {selectedReportOption.supportsFilters.includes('category') && (
          <div>
            <label htmlFor="categoryFilter" className="block text-sm font-semibold text-gray-700 mb-2">
              📂 Category
            </label>
            <select
              id="categoryFilter"
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              disabled={categoriesLoading}
              className="w-full px-4 py-3 border-2 border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-all bg-white disabled:bg-gray-100"
              aria-label="Product category"
            >
              <option value="">All Categories</option>
              {availableCategories.map((cat) => (
                <option key={cat} value={cat}>
                  {cat}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Group By */}
        {selectedReportOption.supportsFilters.includes('groupBy') && (
          <div>
            <label htmlFor="groupBy" className="block text-sm font-semibold text-gray-700 mb-2">
              📊 Group By
            </label>
            <select
              id="groupBy"
              value={groupBy}
              onChange={(e) => setGroupBy(e.target.value as 'day' | 'week' | 'month' | 'product' | 'customer' | 'payment_method')}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              aria-label="Group by"
            >
              <option value="day">Day</option>
              <option value="week">Week</option>
              <option value="month">Month</option>
              {selectedReport === 'SALES_REPORT' && (
                <>
                  <option value="product">Product</option>
                  <option value="customer">Customer</option>
                  <option value="payment_method">Payment Method</option>
                </>
              )}
            </select>
          </div>
        )}

        {/* Days Ahead */}
        {selectedReportOption.supportsFilters.includes('sessionId') && (
          <div>
            <label htmlFor="salesSessionFilter" className="block text-sm font-semibold text-gray-700 mb-2">
              🖥️ POS Session (Optional)
            </label>
            <input
              id="salesSessionFilter"
              type="text"
              value={sessionId}
              onChange={(e) => setSessionId(e.target.value.toUpperCase())}
              placeholder="REG-2026-0001"
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm uppercase"
              aria-label="Filter by POS session number"
            />
            <p className="text-xs text-gray-500 mt-1">Filter sales by a specific cash register session</p>
          </div>
        )}

        {/* Days Ahead */}
        {selectedReportOption.supportsFilters.includes('daysAhead') && (
          <div>
            <label htmlFor="daysAhead" className="block text-sm font-semibold text-gray-700 mb-2">
              Expiry horizon (days)
            </label>
            <input
              id="daysAhead"
              type="number"
              value={daysAhead}
              onChange={(e) => setDaysAhead(parseInt(e.target.value))}
              min="1"
              max="365"
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              aria-label="Days ahead"
            />
            <p className="text-xs text-gray-500 mt-1">
              Default {LOT_WRITE_DOWN_MAX_DAYS} days so lots eligible for clearance markdown are listed.
            </p>
          </div>
        )}

        {/* Limit */}
        {selectedReportOption.supportsFilters.includes('limit') && (
          <div>
            <label htmlFor="limit" className="block text-sm font-semibold text-gray-700 mb-2">
              Limit (Top N)
            </label>
            <input
              id="limit"
              type="number"
              value={limit}
              onChange={(e) => setLimit(parseInt(e.target.value))}
              min="1"
              max="100"
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              aria-label="Limit top N products"
            />
          </div>
        )}

        {/* Threshold */}
        {selectedReportOption.supportsFilters.includes('threshold') && (
          <div>
            <label htmlFor="threshold" className="block text-sm font-semibold text-gray-700 mb-2">
              Threshold (%)
            </label>
            <input
              id="threshold"
              type="number"
              value={threshold}
              onChange={(e) => setThreshold(parseInt(e.target.value))}
              min="1"
              max="100"
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              aria-label="Stock threshold percentage"
            />
          </div>
        )}

        {/* Sort By */}
        {selectedReportOption.supportsFilters.includes('sortBy') && (
          <div>
            <label htmlFor="sortBy" className="block text-sm font-semibold text-gray-700 mb-2">
              Sort By
            </label>
            <select
              id="sortBy"
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as 'REVENUE' | 'ORDERS' | 'PROFIT')}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              aria-label="Sort by"
            >
              <option value="REVENUE">Revenue</option>
              <option value="ORDERS">Orders</option>
              <option value="PROFIT">Profit</option>
            </select>
          </div>
        )}

        {/* Days To Consider */}
        {selectedReportOption.supportsFilters.includes('daysToConsider') && (
          <div>
            <label htmlFor="daysToConsider" className="block text-sm font-semibold text-gray-700 mb-2">
              Days to Consider
            </label>
            <input
              id="daysToConsider"
              type="number"
              value={daysToConsider}
              onChange={(e) => setDaysToConsider(parseInt(e.target.value))}
              min="7"
              max="365"
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              aria-label="Days to consider for reorder"
            />
          </div>
        )}

        {/* Min Margin */}
        {selectedReportOption.supportsFilters.includes('minMargin') && (
          <div>
            <label htmlFor="minMargin" className="block text-sm font-semibold text-gray-700 mb-2">
              Min Margin (%)
            </label>
            <input
              id="minMargin"
              type="number"
              value={minMargin}
              onChange={(e) => setMinMargin(parseFloat(e.target.value))}
              min="0"
              max="100"
              step="0.1"
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              aria-label="Minimum profit margin"
            />
          </div>
        )}

        {/* Movement Type */}
        {selectedReportOption.supportsFilters.includes('movementType') && (
          <div>
            <label htmlFor="movementType" className="block text-sm font-semibold text-gray-700 mb-2">
              Movement Type
            </label>
            <select
              id="movementType"
              value={movementType}
              onChange={(e) => setMovementType(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              aria-label="Movement type"
            >
              <option value="">All Types</option>
              <option value="GOODS_RECEIPT">Goods Receipt</option>
              <option value="SALE">Sale</option>
              <option value="ADJUSTMENT_IN">Adjustment In</option>
              <option value="ADJUSTMENT_OUT">Adjustment Out</option>
              <option value="TRANSFER_IN">Transfer In</option>
              <option value="TRANSFER_OUT">Transfer Out</option>
              <option value="RETURN">Return</option>
              <option value="DAMAGE">Damage</option>
              <option value="EXPIRY">Expiry</option>
              <option value="OPENING_BALANCE">Opening Balance</option>
            </select>
          </div>
        )}

        {/* Reason (for Waste/Damage) */}
        {selectedReportOption.supportsFilters.includes('reason') && (
          <div>
            <label htmlFor="reason" className="block text-sm font-semibold text-gray-700 mb-2">
              Reason
            </label>
            <select
              id="reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              aria-label="Reason for waste/damage"
            >
              <option value="">All Reasons</option>
              <option value="DAMAGE">Damage</option>
              <option value="EXPIRY">Expiry</option>
              <option value="THEFT">Theft</option>
              <option value="OTHER">Other</option>
            </select>
          </div>
        )}

        {/* Status */}
        {selectedReportOption.supportsFilters.includes('status') && (
          <div>
            <label htmlFor="status" className="block text-sm font-semibold text-gray-700 mb-2">
              Status
            </label>
            <select
              id="status"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              aria-label="Status filter"
            >
              <option value="">All Status</option>
              {selectedReport === 'ORDERS_REPORT' ? (
                <>
                  <option value="PENDING">Pending</option>
                  <option value="COMPLETED">Completed</option>
                  <option value="CANCELLED">Cancelled</option>
                </>
              ) : (
                <>
                  <option value="PENDING">Pending</option>
                  <option value="PAID">Paid</option>
                  <option value="PARTIAL">Partial</option>
                </>
              )}
            </select>
          </div>
        )}

        {/* Sales Comparison - Previous Period Dates */}
        {selectedReport === 'SALES_COMPARISON' && (
          <div className="col-span-full space-y-3">
            <DateRangeFilter
              startDate={previousStartDate}
              endDate={previousEndDate}
              onStartDateChange={setPreviousStartDate}
              onEndDateChange={setPreviousEndDate}
              label="Previous Period"
              defaultPreset="LAST_MONTH"
            />
            <div className="flex flex-col sm:flex-row sm:items-center gap-2">
              <button
                type="button"
                className="px-3 py-1.5 text-sm font-medium rounded-md border border-slate-300 bg-white text-slate-800 hover:bg-slate-50"
                onClick={() => {
                  if (!startDate || !endDate) return;
                  const prior = equalLengthPriorRange(startDate, endDate);
                  setPreviousStartDate(prior.start);
                  setPreviousEndDate(prior.end);
                }}
              >
                Use equal-length period before current
              </button>
              <p className="text-xs text-slate-500">
                Buckets are paired by sequence (1st week ↔ 1st week), not by matching calendar dates.
              </p>
            </div>
          </div>
        )}

        {/* Shared searchable customer picker — same design for all customer-filter reports */}
        {selectedReportOption?.supportsFilters.includes('customer') && selectedReport && (
          <ReportCustomerCombobox
            id="reportCustomerId"
            value={customerId}
            onChange={setCustomerId}
            customers={customersList}
            loading={customersLoading}
            required={CUSTOMER_REQUIRED_REPORTS.has(selectedReport)}
            allowEmpty={!CUSTOMER_REQUIRED_REPORTS.has(selectedReport)}
            emptyLabel={
              CUSTOMER_REQUIRED_REPORTS.has(selectedReport)
                ? '-- Select Customer --'
                : '-- All Customers --'
            }
            helperText="Type to search by name or CUST-####"
          />
        )}

        {/* Cash Register Session - Session ID */}
        {selectedReport === 'CASH_REGISTER_SESSION' && (
          <div>
            <label htmlFor="sessionId" className="block text-sm font-semibold text-gray-700 mb-2">
              Session Number
            </label>
            <input
              id="sessionId"
              type="text"
              value={sessionId}
              onChange={(e) => setSessionId(e.target.value.toUpperCase())}
              placeholder="REG-2026-0001"
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm uppercase"
              aria-label="Session Number"
            />
            <p className="text-xs text-gray-500 mt-1">Enter session number (e.g., REG-2026-0001)</p>
          </div>
        )}

        {/* Supplier picker — searchable (Statement required; AP Ledger / others allow All) */}
        {selectedReportOption?.supportsFilters.includes('supplier') && (
          <ReportSupplierCombobox
            id="supplierId"
            value={supplierId}
            onChange={setSupplierId}
            suppliers={suppliersList}
            loading={suppliersLoading}
            required={SUPPLIER_REQUIRED_REPORTS.has(selectedReport)}
            allowEmpty={!SUPPLIER_REQUIRED_REPORTS.has(selectedReport)}
            emptyLabel={
              SUPPLIER_REQUIRED_REPORTS.has(selectedReport)
                ? '-- Select Supplier --'
                : '-- All Suppliers --'
            }
            helperText="Type to search by name or SUP-####"
          />
        )}

        {/* Note Register - Side filter */}
        {selectedReportOption?.supportsFilters.includes('noteSide') && (
          <div>
            <label htmlFor="noteSide" className="block text-sm font-semibold text-gray-700 mb-2">
              Side
            </label>
            <select
              id="noteSide"
              value={noteSide}
              onChange={(e) => setNoteSide(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              aria-label="Note side"
            >
              <option value="">All (Customer & Supplier)</option>
              <option value="CUSTOMER">Customer</option>
              <option value="SUPPLIER">Supplier</option>
            </select>
          </div>
        )}

        {/* Note Register - Document Type filter */}
        {selectedReportOption?.supportsFilters.includes('noteDocumentType') && (
          <div>
            <label htmlFor="noteDocumentType" className="block text-sm font-semibold text-gray-700 mb-2">
              Document Type
            </label>
            <select
              id="noteDocumentType"
              value={noteDocumentType}
              onChange={(e) => setNoteDocumentType(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              aria-label="Document type"
            >
              <option value="">All Types</option>
              <option value="CREDIT_NOTE">Credit Note</option>
              <option value="DEBIT_NOTE">Debit Note</option>
              <option value="SUPPLIER_CREDIT_NOTE">Supplier Credit Note</option>
              <option value="SUPPLIER_DEBIT_NOTE">Supplier Debit Note</option>
            </select>
          </div>
        )}

        {/* Sales by Cashier — Cashier filter */}
        {selectedReportOption?.supportsFilters.includes('cashierId') && (
          <div>
            <label htmlFor="sbcCashier" className="block text-sm font-semibold text-gray-700 mb-2">
              Cashier (received payment)
            </label>
            <select
              id="sbcCashier"
              value={sbcCashierId}
              onChange={(e) => setSbcCashierId(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
              aria-label="Filter by cashier"
              disabled={sbcUsersLoading}
            >
              <option value="">{sbcUsersLoading ? 'Loading...' : '-- All Cashiers --'}</option>
              {sbcUsersList.map((u) => (
                <option key={u.id} value={u.id}>{u.full_name}</option>
              ))}
            </select>
          </div>
        )}

        {/* Sales by Cashier — Ordered By filter */}
        {selectedReportOption?.supportsFilters.includes('orderedById') && (
          <div>
            <label htmlFor="sbcOrderedBy" className="block text-sm font-semibold text-gray-700 mb-2">
              Ordered By (created the order)
            </label>
            <select
              id="sbcOrderedBy"
              value={sbcOrderedById}
              onChange={(e) => setSbcOrderedById(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
              aria-label="Filter by order creator"
              disabled={sbcUsersLoading}
            >
              <option value="">{sbcUsersLoading ? 'Loading...' : '-- All Users --'}</option>
              {sbcUsersList.map((u) => (
                <option key={u.id} value={u.id}>{u.full_name}</option>
              ))}
            </select>
          </div>
        )}

        {/* Sales by Cashier — Product filter */}
        {selectedReportOption?.supportsFilters.includes('productId') && (
          <div>
            <label htmlFor="sbcProduct" className="block text-sm font-semibold text-gray-700 mb-2">
              Product
            </label>
            <select
              id="sbcProduct"
              value={sbcProductId}
              onChange={(e) => setSbcProductId(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
              aria-label="Filter by product"
              disabled={sbcProductsLoading}
            >
              <option value="">{sbcProductsLoading ? 'Loading...' : '-- All Products --'}</option>
              {sbcProductsList.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
        )}
      </div>
    );
  };

  const renderReportData = () => {
    if (!reportData) return null;

    return (
      <div className="space-y-6">
        {/* Report Header — skip for self-contained SSOT panels (e.g. aging) */}
        {reportData.reportType !== 'CUSTOMER_AGING_REPORT' && (
        <div className="bg-gradient-to-r from-blue-500 to-blue-600 text-white p-6 rounded-xl shadow-lg">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-2xl font-bold mb-2 flex items-center gap-2">
                {selectedReportOption?.icon} {reportData.reportName}
              </h3>
              <p className="text-blue-100 text-sm">
                Generated: {reportData.generatedAt?.includes('T') ? `${formatDisplayDate(reportData.generatedAt)} ${reportData.generatedAt.split('T')[1].substring(0, 8)}` : formatDisplayDate(reportData.generatedAt)}
              </p>
            </div>
            <div className="text-right">
              <div className="text-3xl font-bold">{reportData.recordCount}</div>
              <div className="text-blue-100 text-sm">Records</div>
              <div className="text-blue-100 text-xs mt-1">{reportData.executionTimeMs}ms</div>
            </div>
          </div>
        </div>
        )}

        {/* Sales Comparison — period-over-period (ordinal align) */}
        {reportData.reportType === 'SALES_COMPARISON' && (
          <div className="space-y-4">
            <p className="text-sm text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-4 py-3">
              <span className="font-semibold text-slate-800">Period-over-period: </span>
              Current and previous ranges are bucketed separately, then paired by position
              (1st week of current vs 1st week of previous). When previous sales are zero,
              % change shows — (no baseline), not 100%.
            </p>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <div className="rounded-lg border border-slate-200 bg-white p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500 mb-1">Current sales</p>
                <p className="text-xl font-bold text-slate-900">
                  {formatCurrency(Number(reportData.summary?.currentPeriodSales ?? 0))}
                </p>
              </div>
              <div className="rounded-lg border border-slate-200 bg-white p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500 mb-1">Previous sales</p>
                <p className="text-xl font-bold text-slate-900">
                  {formatCurrency(Number(reportData.summary?.previousPeriodSales ?? 0))}
                </p>
              </div>
              <div className="rounded-lg border border-slate-200 bg-white p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500 mb-1">Difference</p>
                <p className="text-xl font-bold text-slate-900">
                  {formatCurrency(Number(reportData.summary?.totalDifference ?? 0))}
                </p>
              </div>
              <div className="rounded-lg border border-teal-200 bg-teal-50 p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-teal-700 mb-1">% change</p>
                <p className="text-xl font-bold text-teal-800">
                  {formatPoPPercent(reportData.summary?.overallPercentageChange)}
                </p>
              </div>
            </div>
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
              <div className="bg-slate-800 px-4 sm:px-6 py-3 flex justify-between">
                <h4 className="text-base font-semibold text-white">Aligned buckets</h4>
                <span className="text-slate-300 text-xs">{reportData.data?.length || 0} rows</span>
              </div>
              {!reportData.data?.length ? (
                <div className="p-8 text-center text-sm text-slate-500">No sales in either period.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-full text-sm">
                    <thead className="bg-slate-50 border-b">
                      <tr>
                        <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Current period</th>
                        <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Previous period</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Current sales</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Previous sales</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Difference</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">% change</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Txn (cur)</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Txn (prev)</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {reportData.data.map((row, idx) => {
                        const pct = row.percentageChange;
                        const pctTone =
                          pct === null || pct === undefined
                            ? 'text-slate-500'
                            : Number(pct) > 0.009
                              ? 'text-teal-800'
                              : Number(pct) < -0.009
                                ? 'text-red-700'
                                : 'text-slate-800';
                        return (
                          <tr key={idx} className="hover:bg-slate-50">
                            <td className="px-3 py-2.5 font-mono text-xs">{String(row.period ?? '')}</td>
                            <td className="px-3 py-2.5 font-mono text-xs text-slate-600">
                              {String(row.previousPeriod ?? '—')}
                            </td>
                            <td className="px-3 py-2.5 text-right tabular-nums font-semibold">
                              {formatCurrency(Number(row.currentSales ?? 0))}
                            </td>
                            <td className="px-3 py-2.5 text-right tabular-nums">
                              {formatCurrency(Number(row.previousSales ?? 0))}
                            </td>
                            <td className="px-3 py-2.5 text-right tabular-nums">
                              {formatCurrency(Number(row.difference ?? 0))}
                            </td>
                            <td className={`px-3 py-2.5 text-right tabular-nums font-semibold ${pctTone}`}>
                              {formatPoPPercent(pct)}
                            </td>
                            <td className="px-3 py-2.5 text-right tabular-nums">
                              {Number(row.currentTransactions ?? 0)}
                            </td>
                            <td className="px-3 py-2.5 text-right tabular-nums">
                              {Number(row.previousTransactions ?? 0)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Daily Cash Flow — cash journal */}
        {reportData.reportType === 'DAILY_CASH_FLOW' && reportData.summary ? (
          <div className="space-y-4">
            <p className="text-sm text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-4 py-3">
              <span className="font-semibold text-slate-800">Cash journal: </span>
              <strong>Cash in</strong> = POS liquid receipts + AR collections (Undeposited Funds) + customer deposits.
              Credit sales are shown as <strong>memo only</strong> — they do not increase cash.
            </p>

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <div className="rounded-lg border border-teal-200 bg-teal-50 p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-teal-700 mb-1">Total cash in</p>
                <p className="text-xl font-bold text-teal-800">
                  {formatCurrency(Number(reportData.summary.totalCashIn ?? 0))}
                </p>
                <p className="text-xs text-teal-700/80 mt-1">
                  {Number(reportData.summary.totalTransactions ?? 0)} receipt(s) · {Number(reportData.summary.totalDays ?? 0)} day(s)
                </p>
              </div>
              <div className="rounded-lg border border-slate-200 bg-white p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500 mb-1">POS receipts</p>
                <p className="text-xl font-bold text-slate-900">
                  {formatCurrency(Number(reportData.summary.salesRevenue ?? 0))}
                </p>
                <p className="text-xs text-slate-500 mt-1">
                  {Number(reportData.summary.salesTransactionCount ?? 0)} ticket(s)
                </p>
              </div>
              <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-blue-700 mb-1">AR collections</p>
                <p className="text-xl font-bold text-blue-800">
                  {formatCurrency(Number(reportData.summary.debtCollections ?? 0))}
                </p>
                <p className="text-xs text-blue-700/80 mt-1">
                  {Number(reportData.summary.collectionsTransactionCount ?? 0)} payment(s)
                </p>
              </div>
              <div className="rounded-lg border border-purple-200 bg-purple-50 p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-purple-700 mb-1">Customer deposits</p>
                <p className="text-xl font-bold text-purple-900">
                  {formatCurrency(Number(reportData.summary.depositReceipts ?? 0))}
                </p>
                <p className="text-xs text-purple-700/80 mt-1">
                  {Number(reportData.summary.depositsTransactionCount ?? 0)} deposit(s)
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
              <div className="rounded-lg border border-slate-200 bg-white p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500 mb-1">Sales booked (incl. credit)</p>
                <p className="text-lg font-bold text-slate-900">
                  {formatCurrency(Number(reportData.summary.totalSalesValue ?? 0))}
                </p>
              </div>
              <div className="rounded-lg border border-slate-200 bg-white p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500 mb-1">Gross profit / margin</p>
                <p className="text-lg font-bold text-slate-900">
                  {formatCurrency(Number(reportData.summary.grossProfit ?? 0))}
                  <span className="text-sm font-medium text-slate-500 ml-2">
                    {Number(reportData.summary.overallProfitMargin ?? 0).toFixed(1)}%
                  </span>
                </p>
              </div>
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-amber-700 mb-1">Credit extended (memo)</p>
                <p className="text-lg font-bold text-amber-800">
                  {formatCurrency(Number(reportData.summary.creditExtended ?? 0))}
                </p>
              </div>
            </div>

            {Array.isArray(reportData.summary.businessInsights) &&
              reportData.summary.businessInsights.length > 0 && (
                <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                  <div className="bg-slate-800 px-4 py-3">
                    <h4 className="text-sm font-semibold text-white">Notes</h4>
                  </div>
                  <ul className="p-4 space-y-1.5 text-sm text-slate-700">
                    {(reportData.summary.businessInsights as string[]).map((insight, idx) => (
                      <li key={idx} className="flex gap-2">
                        <span className="text-teal-600">•</span>
                        <span>{insight}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

            <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
              <div className="bg-slate-800 px-4 sm:px-6 py-3 flex justify-between items-center gap-2">
                <div>
                  <h4 className="text-base font-semibold text-white">Cash journal lines</h4>
                  <p className="text-slate-300 text-xs mt-0.5">By business date, flow type, and payment method</p>
                </div>
                <span className="text-slate-300 text-xs">{reportData.data?.length || 0} lines</span>
              </div>
              {!reportData.data?.length ? (
                <div className="p-8 text-center text-sm text-slate-500">
                  No cash journal lines in this period.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-full text-sm">
                    <thead className="bg-slate-50 border-b">
                      <tr>
                        <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Date</th>
                        <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Flow</th>
                        <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Method</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Count</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Cash in</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Credit (memo)</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">GP</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {reportData.data.map((row, idx) => {
                        const flow = String(row.revenueType ?? '');
                        const flowLabel =
                          flow === 'POS_RECEIPT' || flow === 'SALES_REVENUE'
                            ? 'POS receipt'
                            : flow === 'AR_COLLECTION' || flow === 'DEBT_COLLECTION'
                              ? 'AR collection'
                              : flow === 'CUSTOMER_DEPOSIT' || flow === 'DEPOSIT_RECEIPT'
                                ? 'Customer deposit'
                                : flow === 'CREDIT_EXTENDED'
                                  ? 'Credit extended'
                                  : flow.replace(/_/g, ' ');
                        const flowClass =
                          flow === 'CREDIT_EXTENDED'
                            ? 'bg-amber-100 text-amber-800'
                            : flow.includes('DEPOSIT')
                              ? 'bg-purple-100 text-purple-800'
                              : flow.includes('AR') || flow.includes('DEBT')
                                ? 'bg-blue-100 text-blue-800'
                                : 'bg-teal-100 text-teal-800';
                        return (
                          <tr key={idx} className="hover:bg-slate-50">
                            <td className="px-3 py-2.5 whitespace-nowrap tabular-nums">
                              {formatDisplayDate(String(row.transactionDate ?? ''))}
                            </td>
                            <td className="px-3 py-2.5">
                              <span className={`px-2 py-0.5 rounded text-xs font-semibold ${flowClass}`}>
                                {flowLabel}
                              </span>
                            </td>
                            <td className="px-3 py-2.5">
                              {String(row.paymentMethod ?? '').replace(/_/g, ' ')}
                            </td>
                            <td className="px-3 py-2.5 text-right tabular-nums">
                              {Number(row.transactionCount ?? 0)}
                            </td>
                            <td className="px-3 py-2.5 text-right tabular-nums font-semibold text-teal-800">
                              {Number(row.cashAmount ?? 0) > 0.009
                                ? formatCurrency(Number(row.cashAmount))
                                : '—'}
                            </td>
                            <td className="px-3 py-2.5 text-right tabular-nums text-amber-800">
                              {Number(row.creditCreated ?? 0) > 0.009
                                ? formatCurrency(Number(row.creditCreated))
                                : '—'}
                            </td>
                            <td className="px-3 py-2.5 text-right tabular-nums">
                              {Number(row.grossProfit ?? 0) > 0.009
                                ? formatCurrency(Number(row.grossProfit))
                                : '—'}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        ) : (
          /* Standard Summary — skip dedicated SSOT renderers */
          !isSsotReportType(reportData.reportType) &&
          reportData.summary && (
            <div className="bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden">
              <div className="bg-gradient-to-r from-purple-500 to-purple-600 px-4 sm:px-6 py-3">
                <h4 className="text-base sm:text-lg font-semibold text-white">📊 Summary Statistics</h4>
              </div>
              <div className="p-4 sm:p-6">
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
                  {Object.entries(reportData.summary).map(([key, value]) => (
                    <div key={key} className="bg-gradient-to-br from-gray-50 to-gray-100 border border-gray-200 rounded-lg p-3 sm:p-4 hover:shadow-md transition-shadow">
                      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1 sm:mb-2">
                        {key.replace(/([A-Z])/g, ' $1').trim().replace(/^\w/, c => c.toUpperCase())}
                      </p>
                      <p className={`text-xl sm:text-2xl font-bold break-words ${getFieldColorClass(key, value)}`}>
                        {formatFieldValue(key, value)}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )
        )}



        {/* Expiring Items — shelf-life / expiry register (SSOT) */}
        {reportData.reportType === 'EXPIRING_ITEMS' && reportData.summary && (() => {
          const allRows = Array.isArray(reportData.data) ? reportData.data : [];
          const bandRows = filterExpiringRowsByBand(allRows, expiringBandFilter);
          const filteredRows = filterExpiringRowsBySearch(bandRows, expiringSearch);
          const searchActive = Boolean(expiringSearch.trim());
          const selectBand = (band: ExpiryBandFilter) => {
            setExpiringBandFilter((prev) => (prev === band ? 'all' : band));
            requestAnimationFrame(() => {
              document.getElementById('expiring-register')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
          };
          const cardActive = (band: ExpiryBandFilter) =>
            expiringBandFilter === band
              ? 'ring-2 ring-offset-2 ring-slate-800 shadow-md'
              : 'hover:shadow-md hover:brightness-[0.98]';
          const filterLabel = expiringBandFilterLabel(expiringBandFilter);

          return (
          <div className="space-y-4">
            <p className="text-sm text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-4 py-3">
              <span className="font-semibold text-slate-800">Shelf-life register: </span>
              Active batches still on hand that are <strong>already expired</strong> or expire within
              the horizon (including <strong>0 days left / expires today</strong> under Expired). Value at risk = remaining qty × unit cost (inventory cost). Click a KPI card
              to show only that band in the list (click again to show all). Use search to jump to a product, SKU, or batch.{' '}
              <strong>Expired</strong> rows can be sent to quarantine (no P&amp;L) — then dispose from the{' '}
              <Link to="/inventory/quarantine" className="text-slate-900 underline font-semibold">
                Quarantine workqueue
              </Link>
              . Still-sellable lots expiring within {LOT_WRITE_DOWN_MAX_DAYS} days can use{' '}
              <strong>Clearance markdown</strong> (ADMIN only) so POS can sell below original cost at the new carrying cost.
            </p>

            {expiringQuarantineMsg && (
              <p className="text-sm text-teal-800 bg-teal-50 border border-teal-100 rounded-lg px-4 py-2">
                {expiringQuarantineMsg}{' '}
                {/quarantine/i.test(expiringQuarantineMsg) ? (
                  <Link to="/inventory/quarantine" className="underline font-semibold">
                    Open quarantine
                  </Link>
                ) : null}
              </p>
            )}

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3" data-expiring-kpi-cards="true">
              <button
                type="button"
                onClick={() => selectBand('all')}
                aria-pressed={expiringBandFilter === 'all'}
                className={`rounded-lg border border-amber-200 bg-amber-50 p-4 text-center transition-all cursor-pointer ${cardActive('all')}`}
              >
                <p className="text-xs font-medium uppercase tracking-wide text-amber-800 mb-1">Batches at risk</p>
                <p className="text-xl font-bold text-amber-900">
                  {Number(reportData.summary.totalItems ?? 0)}
                </p>
                <p className="text-xs text-amber-800/80 mt-1">
                  Qty {Number(reportData.summary.totalQuantityAtRisk ?? 0).toLocaleString()}
                </p>
              </button>
              <button
                type="button"
                onClick={() => selectBand('expired')}
                aria-pressed={expiringBandFilter === 'expired'}
                className={`rounded-lg border border-red-200 bg-red-50 p-4 text-center transition-all cursor-pointer ${cardActive('expired')}`}
              >
                <p className="text-xs font-medium uppercase tracking-wide text-red-700 mb-1">Expired</p>
                <p className="text-xl font-bold text-red-800">
                  {Number(reportData.summary.expiredCount ?? 0)}
                </p>
                <p className="text-xs text-red-700/80 mt-1">
                  {formatCurrency(Number(reportData.summary.expiredValue ?? 0))}
                </p>
              </button>
              <button
                type="button"
                onClick={() => selectBand('critical')}
                aria-pressed={expiringBandFilter === 'critical'}
                className={`rounded-lg border border-rose-200 bg-rose-50 p-4 text-center transition-all cursor-pointer ${cardActive('critical')}`}
              >
                <p className="text-xs font-medium uppercase tracking-wide text-rose-700 mb-1">Critical ≤7d</p>
                <p className="text-xl font-bold text-rose-800">
                  {Number(reportData.summary.criticalCount ?? 0)}
                </p>
                <p className="text-xs text-rose-700/80 mt-1">
                  {formatCurrency(Number(reportData.summary.criticalValue ?? 0))}
                </p>
              </button>
              <div
                className={`rounded-lg border border-slate-200 bg-white p-4 text-center transition-all ${
                  expiringBandFilter === 'warning' || expiringBandFilter === 'watch'
                    ? 'ring-2 ring-offset-2 ring-slate-800 shadow-md'
                    : ''
                }`}
              >
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500 mb-1">Value at risk</p>
                <p className="text-xl font-bold text-slate-900">
                  {formatCurrency(Number(reportData.summary.totalPotentialLoss ?? 0))}
                </p>
                <p className="text-xs text-slate-500 mt-1 flex flex-wrap justify-center gap-2">
                  <button
                    type="button"
                    onClick={() => selectBand('warning')}
                    aria-pressed={expiringBandFilter === 'warning'}
                    className={`underline-offset-2 hover:underline ${
                      expiringBandFilter === 'warning' ? 'font-semibold text-amber-800' : ''
                    }`}
                  >
                    Warn {Number(reportData.summary.warningCount ?? 0)}
                  </button>
                  <span aria-hidden>·</span>
                  <button
                    type="button"
                    onClick={() => selectBand('watch')}
                    aria-pressed={expiringBandFilter === 'watch'}
                    className={`underline-offset-2 hover:underline ${
                      expiringBandFilter === 'watch' ? 'font-semibold text-slate-800' : ''
                    }`}
                  >
                    Watch {Number(reportData.summary.watchCount ?? 0)}
                  </button>
                </p>
              </div>
            </div>

            <div id="expiring-register" className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
              <div className="bg-slate-800 px-4 sm:px-6 py-3 flex flex-wrap justify-between items-center gap-2">
                <div>
                  <h4 className="text-base font-semibold text-white">Expiry register</h4>
                  <p className="text-slate-300 text-xs mt-0.5">
                    Showing: {filterLabel}
                    {searchActive ? ` · search “${expiringSearch.trim()}”` : ''}
                    {expiringBandFilter !== 'all' ? (
                      <>
                        {' '}
                        ·{' '}
                        <button
                          type="button"
                          onClick={() => setExpiringBandFilter('all')}
                          className="underline text-amber-200 hover:text-white"
                        >
                          Show all
                        </button>
                      </>
                    ) : (
                      ' · most urgent first · cost valuation'
                    )}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <label className="relative block min-w-[12rem] flex-1 sm:flex-none sm:w-64">
                    <span className="sr-only">Search product, SKU, or batch</span>
                    <input
                      type="search"
                      value={expiringSearch}
                      onChange={(e) => setExpiringSearch(e.target.value)}
                      placeholder="Find product, SKU, or batch…"
                      data-expiring-search="true"
                      className="w-full rounded-lg border border-slate-500 bg-slate-900/60 px-3 py-1.5 text-sm text-white placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-amber-400"
                      autoComplete="off"
                    />
                  </label>
                  {(() => {
                    const expiredIds = filteredRows
                      .filter((r) => resolveExpiryRowBand({
                        urgency: r.urgency != null ? String(r.urgency) : null,
                        daysUntilExpiry: Number(r.daysUntilExpiry ?? 0),
                      }) === 'expired' && r.batchId)
                      .map((r) => String(r.batchId));
                    if (!expiredIds.length) return null;
                    return (
                      <button
                        type="button"
                        disabled={expiringQuarantineBusyId === 'bulk'}
                        className="text-xs px-2.5 py-1 rounded bg-amber-500/90 text-slate-900 font-semibold hover:bg-amber-400 disabled:opacity-50"
                        data-expiring-quarantine-bulk="true"
                        onClick={async () => {
                          if (
                            !window.confirm(
                              `Quarantine ${expiredIds.length} expired batch(es)? This does not post P&L — dispose later from Quarantine.`,
                            )
                          ) {
                            return;
                          }
                          setExpiringQuarantineBusyId('bulk');
                          setExpiringQuarantineMsg(null);
                          try {
                            const res = await inventoryApi.inventory.quarantineFromExpiringReportBulk({
                              inventoryBatchIds: expiredIds,
                              memo: 'Bulk quarantine from Expiring Items report',
                            });
                            const data = (res.data?.data ?? {}) as {
                              okCount?: number;
                              failCount?: number;
                            };
                            setExpiringQuarantineMsg(
                              `Quarantined ${data.okCount ?? 0} batch(es)` +
                                (data.failCount ? ` · ${data.failCount} skipped` : '') +
                                '. Refresh the report to update the register.',
                            );
                          } catch (err) {
                            setExpiringQuarantineMsg(
                              err instanceof Error ? err.message : 'Bulk quarantine failed',
                            );
                          } finally {
                            setExpiringQuarantineBusyId(null);
                          }
                        }}
                      >
                        {expiringQuarantineBusyId === 'bulk'
                          ? '…'
                          : `Quarantine expired (${expiredIds.length})`}
                      </button>
                    );
                  })()}
                  <Link
                    to="/inventory/quarantine"
                    className="text-xs text-amber-200 underline hover:text-white"
                    data-expiring-quarantine-link="true"
                  >
                    Quarantine workqueue
                  </Link>
                  <span className="text-slate-300 text-xs">
                    {filteredRows.length}
                    {expiringBandFilter !== 'all' || searchActive
                      ? ` of ${searchActive && expiringBandFilter === 'all' ? allRows.length : bandRows.length}`
                      : ''}{' '}
                    batches
                  </span>
                </div>
              </div>
              {!allRows.length ? (
                <div className="p-8 text-center text-sm text-slate-500">
                  No expired or near-expiry stock on hand in this horizon.
                </div>
              ) : !bandRows.length ? (
                <div className="p-8 text-center text-sm text-slate-500">
                  No batches in this band.{' '}
                  <button
                    type="button"
                    onClick={() => setExpiringBandFilter('all')}
                    className="underline text-slate-700"
                  >
                    Show all
                  </button>
                </div>
              ) : !filteredRows.length ? (
                <div className="p-8 text-center text-sm text-slate-500" data-expiring-search-empty="true">
                  No match for “{expiringSearch.trim()}”.{' '}
                  <button
                    type="button"
                    onClick={() => setExpiringSearch('')}
                    className="underline text-slate-700"
                  >
                    Clear search
                  </button>
                  {' '}
                  · Day-0 (expires today) lots appear under{' '}
                  <button
                    type="button"
                    onClick={() => {
                      setExpiringBandFilter('expired');
                      setExpiringSearch('');
                    }}
                    className="underline text-slate-700"
                  >
                    Expired
                  </button>
                  .
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[960px] text-sm">
                    <thead className="bg-slate-50 border-b">
                      <tr>
                        <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Urgency</th>
                        <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Product</th>
                        <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">SKU</th>
                        <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Batch</th>
                        <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Expiry</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Days</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Qty</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Unit cost</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Value at risk</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {filteredRows.map((row, idx) => {
                        const days = Number(row.daysUntilExpiry ?? 0);
                        const band = resolveExpiryRowBand({
                          urgency: row.urgency != null ? String(row.urgency) : null,
                          daysUntilExpiry: days,
                        });
                        const bandClass =
                          band === 'expired'
                            ? 'bg-red-100 text-red-800'
                            : band === 'critical'
                              ? 'bg-rose-100 text-rose-800'
                              : band === 'warning'
                                ? 'bg-amber-100 text-amber-800'
                                : 'bg-slate-100 text-slate-700';
                        const batchId = row.batchId != null ? String(row.batchId) : '';
                        const canQuarantine = band === 'expired' && Boolean(batchId);
                        const canWriteDown =
                          canClearanceMarkdown && isNearExpiryWriteDownBand(days) && Boolean(batchId);
                        const carrying = Number(row.unitCost ?? 0);
                        const originalCost = Number(
                          (row as { originalUnitCost?: number }).originalUnitCost ?? carrying,
                        );
                        return (
                          <tr key={idx} className="hover:bg-slate-50">
                            <td className="px-3 py-2.5">
                              <span className={`px-2 py-0.5 rounded text-xs font-semibold ${bandClass}`}>
                                {expiryUrgencyLabel(band)}
                              </span>
                            </td>
                            <td className="px-3 py-2.5 font-semibold text-slate-900">
                              {String(row.productName ?? '—')}
                            </td>
                            <td className="px-3 py-2.5 text-xs text-slate-600 font-mono">
                              {String(row.sku ?? '—')}
                            </td>
                            <td className="px-3 py-2.5 text-xs text-slate-600">
                              {String(row.batchNumber ?? '—')}
                            </td>
                            <td className="px-3 py-2.5 whitespace-nowrap tabular-nums">
                              {formatDisplayDate(String(row.expiryDate ?? ''))}
                            </td>
                            <td
                              className={`px-3 py-2.5 text-right tabular-nums font-semibold ${
                                days <= 0 ? 'text-red-700' : days <= 7 ? 'text-rose-700' : 'text-slate-800'
                              }`}
                            >
                              {days}
                            </td>
                            <td className="px-3 py-2.5 text-right tabular-nums">
                              {Number(row.quantityRemaining ?? 0).toLocaleString()}
                            </td>
                            <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">
                              {formatCurrency(carrying)}
                              {originalCost > 0 && Math.abs(originalCost - carrying) > 0.009 ? (
                                <span className="block text-[10px] text-slate-400 font-normal">
                                  orig {formatCurrency(originalCost)}
                                </span>
                              ) : null}
                            </td>
                            <td className="px-3 py-2.5 text-right tabular-nums font-semibold text-amber-900">
                              {formatCurrency(Number(row.potentialLoss ?? 0))}
                            </td>
                            <td className="px-3 py-2.5 text-right">
                              {canQuarantine ? (
                                <button
                                  type="button"
                                  disabled={expiringQuarantineBusyId === batchId}
                                  data-expiring-quarantine-row="true"
                                  className="text-xs px-2 py-1 rounded border border-red-200 text-red-800 hover:bg-red-50 disabled:opacity-50"
                                  onClick={async () => {
                                    if (
                                      !window.confirm(
                                        `Quarantine ${row.productName ?? 'batch'}? No P&L until you dispose from Quarantine.`,
                                      )
                                    ) {
                                      return;
                                    }
                                    setExpiringQuarantineBusyId(batchId);
                                    setExpiringQuarantineMsg(null);
                                    try {
                                      const res =
                                        await inventoryApi.inventory.quarantineFromExpiringReport({
                                          inventoryBatchId: batchId,
                                          memo: 'Quarantine from Expiring Items report',
                                        });
                                      const data = (res.data?.data ?? {}) as {
                                        quarantineMode?: string;
                                        quantityMoved?: number;
                                        movementNumber?: string;
                                      };
                                      setExpiringQuarantineMsg(
                                        `${data.quarantineMode === 'HARD' ? 'Moved' : 'Soft-quarantined'} ${data.quantityMoved ?? ''} (${data.movementNumber ?? ''}). Refresh report to drop ACTIVE rows.`,
                                      );
                                    } catch (err) {
                                      setExpiringQuarantineMsg(
                                        err instanceof Error ? err.message : 'Quarantine failed',
                                      );
                                    } finally {
                                      setExpiringQuarantineBusyId(null);
                                    }
                                  }}
                                >
                                  {expiringQuarantineBusyId === batchId ? '…' : 'Quarantine'}
                                </button>
                              ) : canWriteDown ? (
                                <button
                                  type="button"
                                  disabled={expiringWriteDownBusyId === batchId}
                                  data-expiring-write-down-row="true"
                                  className="text-xs px-2 py-1 rounded border border-rose-200 text-rose-800 hover:bg-rose-50 disabled:opacity-50"
                                  onClick={async () => {
                                    const raw = window.prompt(
                                      `Lot carrying-value write-down (clearance markdown 5140) for ${row.productName ?? 'batch'}?\nCurrent carrying: ${carrying}\nOriginal acquisition: ${originalCost}\nEnter the NEW carrying cost (must be lower). POS will then allow selling at or above that new cost.`,
                                      String(carrying),
                                    );
                                    if (raw == null) return;
                                    // Accept 20000, 20,000, 20000.50 — commas break Number().
                                    const cleaned = String(raw).replace(/,/g, '').trim();
                                    const next = Number(cleaned);
                                    if (
                                      !Number.isFinite(next) ||
                                      next < LOT_WRITE_DOWN_MIN_CARRYING ||
                                      next >= carrying
                                    ) {
                                      setExpiringQuarantineMsg(
                                        `New carrying cost must be a number at least ${LOT_WRITE_DOWN_MIN_CARRYING} and below the current book cost (${carrying}). You entered: ${raw}`,
                                      );
                                      return;
                                    }
                                    setExpiringWriteDownBusyId(batchId);
                                    setExpiringQuarantineMsg(null);
                                    try {
                                      const res = await inventoryApi.inventory.writeDownNearExpiryLot({
                                        inventoryBatchId: batchId,
                                        newUnitCost: next,
                                        memo: 'Near-expiry write-down from Expiring Items',
                                      });
                                      const data = (res.data?.data ?? {}) as {
                                        documentNumber?: string;
                                        newCarryingUnitCost?: number;
                                        originalUnitCost?: number;
                                        totalAmount?: number;
                                      };
                                      const newCarrying = Number(data.newCarryingUnitCost ?? next);
                                      const orig = Number(data.originalUnitCost ?? originalCost);
                                      // Patch the open report immediately — do not wait for manual refresh.
                                      setReportData((prev) => {
                                        if (!prev?.data || !Array.isArray(prev.data)) return prev;
                                        return {
                                          ...prev,
                                          data: prev.data.map((r) => {
                                            const id = String((r as { batchId?: string }).batchId ?? '');
                                            if (id !== batchId) return r;
                                            const qty = Number(
                                              (r as { quantityRemaining?: number }).quantityRemaining ?? 0,
                                            );
                                            return {
                                              ...r,
                                              unitCost: newCarrying,
                                              originalUnitCost: orig,
                                              potentialLoss: qty * newCarrying,
                                            };
                                          }),
                                        };
                                      });
                                      setExpiringQuarantineMsg(
                                        `Clearance markdown ${data.documentNumber ?? ''} posted. Carrying now ${formatCurrency(newCarrying)} (original ${formatCurrency(orig)}). Sell on POS at or above the new carrying cost.`,
                                      );
                                    } catch (err) {
                                      setExpiringQuarantineMsg(getErrorMessage(err));
                                    } finally {
                                      setExpiringWriteDownBusyId(null);
                                    }
                                  }}
                                >
                                  {expiringWriteDownBusyId === batchId ? '…' : 'Clearance markdown'}
                                </button>
                              ) : (
                                <span className="text-xs text-slate-400">—</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
          );
        })()}

        {/* Void Sales Report — cancellation register (SSOT; no generic dump) */}
        {reportData.reportType === 'VOID_SALES_REPORT' && reportData.summary && (
          <div className="space-y-4">
            <p className="text-sm text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-4 py-3">
              <span className="font-semibold text-slate-800">Void / cancellation register: </span>
              One row per sale with status <strong>VOID</strong>, dated by when the void posted.
              Posted returns and credit memos belong on <strong>Refund / Returns</strong> — not here.
              Accounting docs are reversal postings (comma-joined when a void reverses more than one journal).
            </p>

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-red-700 mb-1">Voided sales</p>
                <p className="text-xl font-bold text-red-800">
                  {Number(reportData.summary.voidedSaleCount ?? 0)}
                </p>
                <p className="text-xs text-red-700/80 mt-1">
                  With acct. doc: {Number(reportData.summary.withAccountingDocCount ?? 0)} · Without:{' '}
                  {Number(reportData.summary.withoutAccountingDocCount ?? 0)}
                </p>
              </div>
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-amber-800 mb-1">Voided amount</p>
                <p className="text-xl font-bold text-amber-900">
                  {formatCurrency(Number(reportData.summary.totalVoidedAmount ?? 0))}
                </p>
              </div>
              <div className="rounded-lg border border-slate-200 bg-white p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500 mb-1">COGS voided</p>
                <p className="text-xl font-bold text-slate-900">
                  {formatCurrency(Number(reportData.summary.totalVoidedCost ?? 0))}
                </p>
              </div>
              <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-rose-700 mb-1">Lost profit</p>
                <p className="text-xl font-bold text-rose-800">
                  {formatCurrency(Number(reportData.summary.totalLostProfit ?? 0))}
                </p>
              </div>
            </div>

            <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
              <div className="bg-slate-800 px-4 sm:px-6 py-3 flex justify-between items-center gap-2">
                <div>
                  <h4 className="text-base font-semibold text-white">Void documents</h4>
                  <p className="text-slate-300 text-xs mt-0.5">One row per cancelled sale</p>
                </div>
                <span className="text-slate-300 text-xs">{reportData.data?.length || 0} docs</span>
              </div>
              {!reportData.data?.length ? (
                <div className="p-8 text-center text-sm text-slate-500 space-y-2">
                  <p>No voided sales in this period.</p>
                  <p className="text-xs text-slate-400 max-w-lg mx-auto">
                    Completed POS sales are reversed with Return / Refund (credit memo), not Void.
                    If you expected return activity, open Refund / Returns Report for the same dates.
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[1000px] text-sm">
                    <thead className="bg-slate-50 border-b">
                      <tr>
                        <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Sale #</th>
                        <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Sale date</th>
                        <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Voided at</th>
                        <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Customer</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Amount</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Profit lost</th>
                        <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Reason</th>
                        <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Voided by</th>
                        <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Approved by</th>
                        <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Acct. doc</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Items</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {reportData.data.map((row, idx) => (
                        <tr key={idx} className="hover:bg-slate-50">
                          <td className="px-3 py-2.5 font-medium text-blue-700 whitespace-nowrap">
                            {String(row.saleNumber ?? '—')}
                          </td>
                          <td className="px-3 py-2.5 whitespace-nowrap tabular-nums">
                            {formatDisplayDate(String(row.saleDate ?? ''))}
                          </td>
                          <td className="px-3 py-2.5 whitespace-nowrap text-xs tabular-nums text-slate-600">
                            {String(row.voidedAt ?? '—')}
                          </td>
                          <td className="px-3 py-2.5">{String(row.customerName ?? '—')}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums font-medium text-amber-800">
                            {formatCurrency(Number(row.totalAmount ?? 0))}
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums font-semibold text-rose-700">
                            {formatCurrency(Number(row.profit ?? 0))}
                          </td>
                          <td
                            className="px-3 py-2.5 text-xs text-slate-600 max-w-[160px] truncate"
                            title={String(row.voidReason ?? '')}
                          >
                            {String(row.voidReason ?? '—')}
                          </td>
                          <td className="px-3 py-2.5 text-xs text-slate-600">{String(row.voidedBy ?? '—')}</td>
                          <td className="px-3 py-2.5 text-xs text-slate-600">
                            {String(row.voidApprovedBy ?? '—')}
                          </td>
                          <td
                            className="px-3 py-2.5 text-xs text-slate-600 max-w-[120px] truncate"
                            title={String(row.accountingDocNumber ?? '')}
                          >
                            {String(row.accountingDocNumber ?? '—')}
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums">{Number(row.itemCount ?? 0)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {Array.isArray(reportData.byReason) && reportData.byReason.length > 0 && (
              <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                <div className="bg-slate-800 px-4 sm:px-6 py-3 flex justify-between items-center gap-2">
                  <div>
                    <h4 className="text-base font-semibold text-white">By void reason</h4>
                    <p className="text-slate-300 text-xs mt-0.5">Control totals for audit</p>
                  </div>
                  <span className="text-slate-300 text-xs">{reportData.byReason.length} reasons</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-full text-sm">
                    <thead className="bg-slate-50 border-b">
                      <tr>
                        <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Reason</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Count</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Amount</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {(
                        reportData.byReason as Array<{
                          reason: string;
                          count: number;
                          totalAmount: number;
                        }>
                      ).map((item, idx) => (
                        <tr key={idx} className="hover:bg-slate-50">
                          <td className="px-3 py-2.5 font-semibold text-slate-900">{item.reason}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums">{item.count}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums font-semibold text-amber-800">
                            {formatCurrency(item.totalAmount)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Refund Report — credit memo / returns register (SSOT; no generic dump) */}
        {reportData.reportType === 'REFUND_REPORT' && reportData.summary && (
          <div className="space-y-4">
            <p className="text-sm text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-4 py-3">
              <span className="font-semibold text-slate-800">Credit memo register: </span>
              One row per refund document. Revenue and COGS reversals drive profit impact.
              Accounting document numbers are linked postings (comma-joined when a refund posts more than once).
              Line detail shows quantity, cost, and whether stock was returned.
            </p>

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-red-700 mb-1">Refunds</p>
                <p className="text-xl font-bold text-red-800">
                  {Number(reportData.summary.refundCount ?? 0)}
                </p>
                <p className="text-xs text-red-700/80 mt-1">
                  {Number(reportData.summary.fullRefundCount ?? 0)} full ·{' '}
                  {Number(reportData.summary.partialRefundCount ?? 0)} partial
                </p>
              </div>
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-amber-800 mb-1">Revenue reversed</p>
                <p className="text-xl font-bold text-amber-900">
                  {formatCurrency(Number(reportData.summary.totalRevenueReversal ?? 0))}
                </p>
              </div>
              <div className="rounded-lg border border-slate-200 bg-white p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500 mb-1">COGS reversed</p>
                <p className="text-xl font-bold text-slate-900">
                  {formatCurrency(Number(reportData.summary.totalCOGSReversal ?? 0))}
                </p>
              </div>
              <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-rose-700 mb-1">Profit impact</p>
                <p className="text-xl font-bold text-rose-800">
                  {formatCurrency(Number(reportData.summary.netProfitImpact ?? 0))}
                </p>
                <p className="text-xs text-rose-700/80 mt-1">
                  Stock returned: {Number(reportData.summary.linesWithStockReturn ?? 0)} /{' '}
                  {Number(reportData.summary.linesWithStockReturn ?? 0) +
                    Number(reportData.summary.linesWithoutStockReturn ?? 0)}{' '}
                  lines
                </p>
              </div>
            </div>

            <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
              <div className="bg-slate-800 px-4 sm:px-6 py-3 flex justify-between items-center gap-2">
                <div>
                  <h4 className="text-base font-semibold text-white">Refund documents</h4>
                  <p className="text-slate-300 text-xs mt-0.5">Header register — one row per credit memo</p>
                </div>
                <span className="text-slate-300 text-xs">{reportData.data?.length || 0} docs</span>
              </div>
              {!reportData.data?.length ? (
                <div className="p-8 text-center text-sm text-slate-500">No refunds in this period.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[960px] text-sm">
                    <thead className="bg-slate-50 border-b">
                      <tr>
                        <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Refund #</th>
                        <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Sale #</th>
                        <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Date</th>
                        <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Customer</th>
                        <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Type</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Revenue</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">COGS</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Profit</th>
                        <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Acct. doc</th>
                        <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Reason</th>
                        <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Created by</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {reportData.data.map((row, idx) => {
                        const type = String(row.refundType ?? '');
                        return (
                          <tr key={idx} className="hover:bg-slate-50">
                            <td className="px-3 py-2.5 font-medium text-blue-700 whitespace-nowrap">
                              {String(row.refundNumber ?? '—')}
                            </td>
                            <td className="px-3 py-2.5 whitespace-nowrap">{String(row.saleNumber ?? '—')}</td>
                            <td className="px-3 py-2.5 whitespace-nowrap tabular-nums">
                              {formatDisplayDate(String(row.refundDate ?? ''))}
                            </td>
                            <td className="px-3 py-2.5">{String(row.customerName ?? '—')}</td>
                            <td className="px-3 py-2.5">
                              <span
                                className={`px-2 py-0.5 rounded text-xs font-semibold ${
                                  type === 'Full' ? 'bg-red-100 text-red-800' : 'bg-amber-100 text-amber-800'
                                }`}
                              >
                                {type || '—'}
                              </span>
                            </td>
                            <td className="px-3 py-2.5 text-right tabular-nums text-amber-800 font-medium">
                              {formatCurrency(Number(row.totalRevenueReversal ?? 0))}
                            </td>
                            <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">
                              {formatCurrency(Number(row.totalCOGSReversal ?? 0))}
                            </td>
                            <td className="px-3 py-2.5 text-right tabular-nums font-semibold text-rose-700">
                              {formatCurrency(Number(row.netProfitImpact ?? 0))}
                            </td>
                            <td className="px-3 py-2.5 text-xs text-slate-600 max-w-[140px] truncate" title={String(row.accountingDocNumber ?? '')}>
                              {String(row.accountingDocNumber ?? '—')}
                            </td>
                            <td className="px-3 py-2.5 text-xs text-slate-600 max-w-[160px] truncate" title={String(row.reason ?? '')}>
                              {String(row.reason ?? '—')}
                            </td>
                            <td className="px-3 py-2.5 text-xs text-slate-600">
                              {String(row.createdBy ?? '—')}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {Array.isArray(reportData.lineItems) && reportData.lineItems.length > 0 && (
              <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                <div className="bg-slate-800 px-4 sm:px-6 py-3 flex justify-between items-center gap-2">
                  <div>
                    <h4 className="text-base font-semibold text-white">Line reversals</h4>
                    <p className="text-slate-300 text-xs mt-0.5">Product lines with qty, cost, and stock return</p>
                  </div>
                  <span className="text-slate-300 text-xs">{reportData.lineItems.length} lines</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[1100px] text-sm">
                    <thead className="bg-slate-50 border-b">
                      <tr>
                        <th className="px-2 sm:px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Refund #</th>
                        <th className="px-2 sm:px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Product</th>
                        <th className="px-2 sm:px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Sold</th>
                        <th className="px-2 sm:px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Refunded</th>
                        <th className="px-2 sm:px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Remain</th>
                        <th className="px-2 sm:px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Unit price</th>
                        <th className="px-2 sm:px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Unit COGS</th>
                        <th className="px-2 sm:px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Rev. rev.</th>
                        <th className="px-2 sm:px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">COGS rev.</th>
                        <th className="px-2 sm:px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Profit</th>
                        <th className="px-2 sm:px-3 py-3 text-center text-xs font-bold text-slate-600 uppercase">Stock</th>
                        <th className="px-2 sm:px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Batch</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {(reportData.lineItems as Array<{
                        refundNumber: string;
                        productName: string;
                        sku: string | null;
                        originalSoldQty: number;
                        refundedQty: number;
                        remainingQty: number;
                        unitSellingPrice: number;
                        unitCOGS: number;
                        lineRevenueReversed: number;
                        lineCOGSReversed: number;
                        profitImpact: number;
                        returnedToStock: boolean;
                        batchNumber: string | null;
                      }>).map((line, idx) => (
                        <tr key={idx} className="hover:bg-slate-50">
                          <td className="px-2 sm:px-3 py-2 text-xs font-medium text-blue-700">{line.refundNumber}</td>
                          <td className="px-2 sm:px-3 py-2 text-xs font-semibold text-slate-900">
                            {line.productName}
                            {line.sku ? ` (${line.sku})` : ''}
                          </td>
                          <td className="px-2 sm:px-3 py-2 text-xs text-right tabular-nums">{line.originalSoldQty}</td>
                          <td className="px-2 sm:px-3 py-2 text-xs text-right tabular-nums text-red-600 font-semibold">
                            {line.refundedQty}
                          </td>
                          <td className="px-2 sm:px-3 py-2 text-xs text-right tabular-nums">{line.remainingQty}</td>
                          <td className="px-2 sm:px-3 py-2 text-xs text-right tabular-nums">
                            {formatCurrency(line.unitSellingPrice)}
                          </td>
                          <td className="px-2 sm:px-3 py-2 text-xs text-right tabular-nums text-slate-600">
                            {formatCurrency(line.unitCOGS)}
                          </td>
                          <td className="px-2 sm:px-3 py-2 text-xs text-right tabular-nums text-amber-800 font-medium">
                            {formatCurrency(line.lineRevenueReversed)}
                          </td>
                          <td className="px-2 sm:px-3 py-2 text-xs text-right tabular-nums">
                            {formatCurrency(line.lineCOGSReversed)}
                          </td>
                          <td className="px-2 sm:px-3 py-2 text-xs text-right tabular-nums font-bold text-rose-700">
                            {formatCurrency(line.profitImpact)}
                          </td>
                          <td className="px-2 sm:px-3 py-2 text-xs text-center">
                            {line.returnedToStock ? (
                              <span className="text-teal-700 font-semibold">Yes</span>
                            ) : (
                              <span className="text-slate-400">No</span>
                            )}
                          </td>
                          <td className="px-2 sm:px-3 py-2 text-xs text-slate-600">{line.batchNumber || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {Array.isArray(reportData.topRefundedProducts) && reportData.topRefundedProducts.length > 0 && (
              <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                <div className="bg-slate-800 px-4 sm:px-6 py-3 flex justify-between items-center gap-2">
                  <div>
                    <h4 className="text-base font-semibold text-white">Top refunded products</h4>
                    <p className="text-slate-300 text-xs mt-0.5">By revenue reversed in period</p>
                  </div>
                  <span className="text-slate-300 text-xs">{reportData.topRefundedProducts.length} products</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-full text-sm">
                    <thead className="bg-slate-50 border-b">
                      <tr>
                        <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Product</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Times</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Qty</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Amount</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {(
                        reportData.topRefundedProducts as Array<{
                          productName: string;
                          timesRefunded: number;
                          totalQty: number;
                          totalAmount: number;
                        }>
                      ).map((item, idx) => (
                        <tr key={idx} className="hover:bg-slate-50">
                          <td className="px-3 py-2.5 font-semibold text-slate-900">{item.productName}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums">{item.timesRefunded}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums">{item.totalQty}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums font-semibold text-amber-800">
                            {formatCurrency(item.totalAmount)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Customer Account Statement — partner ledger */}
        {reportData.reportType === 'CUSTOMER_ACCOUNT_STATEMENT' && (reportData.customer || (reportData.data as { customer?: ReportDataCustomer })?.customer) && (
          <div className="space-y-4 sm:space-y-6">
            {(() => {
              const stmtCustomer =
                reportData.customer ||
                ((reportData.data as { customer?: ReportDataCustomer })?.customer as ReportDataCustomer);
              const stmtTx =
                reportData.transactions ||
                ((reportData.data as { transactions?: Record<string, unknown>[] })?.transactions ?? []);
              const opening =
                Number(reportData.summary?.openingBalance ?? 0) ||
                Number((reportData.data as { transactionSummary?: { openingBalance?: number } })?.transactionSummary?.openingBalance ?? 0);
              const closing =
                Number(reportData.summary?.closingBalance ?? stmtCustomer?.currentBalance ?? 0);
              const totalDebits = Number(
                reportData.summary?.totalDebits ?? reportData.summary?.totalSales ?? 0,
              );
              const totalCredits = Number(
                reportData.summary?.totalCredits ?? reportData.summary?.totalPaid ?? 0,
              );
              const unalloc = Number(
                reportData.unallocatedReceiptsTotal ??
                  reportData.summary?.unallocatedReceiptsTotal ??
                  0,
              );
              const isCredit = closing < -0.009;
              const typeClass = (status: string) => {
                const s = (status || '').toUpperCase();
                if (s === 'PAID' || s === 'RECEIVED' || s === 'APPLIED' || s === 'POSTED') return 'bg-green-100 text-green-800';
                if (s === 'PARTIAL' || s === 'UNPAID') return 'bg-amber-100 text-amber-800';
                if (s === 'CANCELLED' || s === 'VOIDED' || s === 'REVERSED') return 'bg-slate-100 text-slate-700';
                return 'bg-slate-100 text-slate-700';
              };
              return (
                <>
            <p className="text-sm text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-4 py-3">
              <span className="font-semibold text-slate-800">Account statement: </span>
              Debits increase what the customer owes; credits reduce it (payments, deposit applications, credit notes).
              A <strong>negative closing balance</strong> is a <strong>customer credit</strong> (credit on account) — not a report error by itself.
            </p>

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <div className="rounded-lg border border-slate-200 bg-white p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500 mb-1">Opening</p>
                <p className="text-xl font-bold text-slate-900">{formatCurrency(opening)}</p>
              </div>
              <div className="rounded-lg border border-slate-200 bg-white p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500 mb-1">Debits (charges)</p>
                <p className="text-xl font-bold text-slate-900">{formatCurrency(totalDebits)}</p>
              </div>
              <div className="rounded-lg border border-teal-200 bg-teal-50 p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-teal-700 mb-1">Credits (settlements)</p>
                <p className="text-xl font-bold text-teal-800">{formatCurrency(totalCredits)}</p>
              </div>
              <div className={`rounded-lg border p-4 text-center ${isCredit ? 'border-green-300 bg-green-50' : closing > 0.009 ? 'border-red-200 bg-red-50' : 'border-slate-200 bg-white'}`}>
                <p className="text-xs font-medium uppercase tracking-wide text-slate-600 mb-1">
                  {isCredit ? 'Closing — customer credit' : 'Closing — amount due'}
                </p>
                <p className={`text-xl font-bold ${isCredit ? 'text-green-800' : closing > 0.009 ? 'text-red-700' : 'text-slate-900'}`}>
                  {formatCurrency(Math.abs(closing))}
                  {isCredit ? ' CR' : closing > 0.009 ? ' DR' : ''}
                </p>
                {unalloc > 0.009 ? (
                  <p className="text-xs text-slate-500 mt-1">On-account unallocated: {formatCurrency(unalloc)}</p>
                ) : null}
              </div>
            </div>

            <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
              <div className="bg-indigo-700 px-4 sm:px-6 py-3">
                <h4 className="text-base font-semibold text-white">Customer</h4>
                <p className="text-indigo-100 text-sm mt-0.5">
                  <span className="font-mono font-semibold">{stmtCustomer?.customerNumber}</span>
                  {' · '}
                  {stmtCustomer?.name}
                  {stmtCustomer?.phone ? ` · ${stmtCustomer.phone}` : ''}
                </p>
              </div>
            </div>

            {stmtTx && stmtTx.length > 0 ? (
              <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                <div className="bg-slate-800 px-4 sm:px-6 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                  <div>
                    <h4 className="text-base font-semibold text-white">Account movements (GL AR 1200)</h4>
                    <p className="text-slate-300 text-xs mt-0.5">Running balance after each posted document</p>
                  </div>
                  <span className="text-slate-300 text-xs sm:text-sm">{stmtTx.length} lines</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-full text-sm">
                    <thead className="bg-slate-50 border-b">
                      <tr>
                        <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Date</th>
                        <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Type</th>
                        <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Document</th>
                        <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Description</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Debit</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Credit</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Balance</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {stmtTx.map((transaction: Record<string, unknown>, idx: number) => {
                        const bal = Number(transaction.balanceDue ?? 0);
                        const desc =
                          String(transaction.description ?? '') ||
                          String((transaction.items as Array<{ product_name?: string }> | undefined)?.[0]?.product_name ?? '');
                        return (
                          <tr key={idx} className="hover:bg-slate-50">
                            <td className="px-3 py-2.5 whitespace-nowrap tabular-nums">
                              {formatDisplayDate(transaction.saleDate as string | undefined)}
                            </td>
                            <td className="px-3 py-2.5">
                              <span className={`px-2 py-0.5 rounded text-xs font-semibold ${typeClass(String(transaction.paymentStatus ?? ''))}`}>
                                {String(transaction.documentType ?? transaction.paymentStatus ?? '')}
                              </span>
                            </td>
                            <td className="px-3 py-2.5 font-mono text-xs text-indigo-700">
                              {String(transaction.saleNumber ?? '')}
                            </td>
                            <td className="px-3 py-2.5 text-slate-700">{desc}</td>
                            <td className="px-3 py-2.5 text-right tabular-nums">
                              {Number(transaction.totalAmount ?? 0) > 0.009
                                ? formatCurrency(Number(transaction.totalAmount ?? 0))
                                : '—'}
                            </td>
                            <td className="px-3 py-2.5 text-right tabular-nums text-teal-800 font-medium">
                              {Number(transaction.amountPaid ?? 0) > 0.009
                                ? formatCurrency(Number(transaction.amountPaid ?? 0))
                                : '—'}
                            </td>
                            <td className={`px-3 py-2.5 text-right tabular-nums font-semibold ${bal < -0.009 ? 'text-green-700' : bal > 0.009 ? 'text-red-700' : 'text-slate-800'}`}>
                              {formatCurrency(Math.abs(bal))}
                              {bal < -0.009 ? ' CR' : bal > 0.009 ? ' DR' : ''}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {isCredit && (
                  <div className="border-t border-green-200 bg-green-50 px-4 py-3 text-sm text-green-900">
                    Closing credit {formatCurrency(Math.abs(closing))}: credits ({formatCurrency(totalCredits)}) exceeded
                    charges in this period ({formatCurrency(totalDebits)}). This remains a customer credit
                    until applied to a future invoice or refunded.
                  </div>
                )}
              </div>
            ) : (
              <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 sm:p-8 text-center">
                <p className="text-gray-500 text-sm sm:text-lg">No AR movements for this customer in the selected period.</p>
              </div>
            )}
                </>
              );
            })()}
          </div>
        )}

        {/* Supplier Statement — AP partner ledger */}
        {reportData.reportType === 'SUPPLIER_STATEMENT' && (
          <div className="space-y-4 sm:space-y-6">
            {(() => {
              const opening = Number(reportData.summary?.openingBalance ?? 0);
              const closing = Number(reportData.summary?.closingBalance ?? 0);
              const totalDebits = Number(
                reportData.summary?.totalDebits ?? reportData.summary?.totalDebit ?? 0,
              );
              const totalCredits = Number(
                reportData.summary?.totalCredits ?? reportData.summary?.totalCredit ?? 0,
              );
              const supplierName = String(reportData.summary?.supplierName ?? 'Supplier');
              const unalloc = Number(reportData.summary?.unallocatedPrepaymentsTotal ?? 0);
              const isCredit = closing < -0.009;
              const rows = reportData.data || [];
              const typeClass = (status: string) => {
                const s = (status || '').toUpperCase();
                if (s === 'PAID' || s === 'RECEIVED' || s === 'APPLIED' || s === 'POSTED') return 'bg-green-100 text-green-800';
                if (s === 'UNPAID' || s === 'PENDING BILL' || s === 'UNALLOCATED') return 'bg-amber-100 text-amber-800';
                if (s === 'CANCELLED' || s === 'VOIDED' || s === 'REVERSED') return 'bg-slate-100 text-slate-700';
                return 'bg-slate-100 text-slate-700';
              };
              return (
                <>
                  <p className="text-sm text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-4 py-3">
                    <span className="font-semibold text-slate-800">Supplier statement: </span>
                    Debits increase what you owe the supplier (bills / goods received);
                    credits reduce it (payments, returns, supplier credit notes).
                    A <strong>negative closing balance</strong> is a <strong>supplier credit</strong> (prepaid / CN on account).
                  </p>

                  <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                    <div className="rounded-lg border border-slate-200 bg-white p-4 text-center">
                      <p className="text-xs font-medium uppercase tracking-wide text-slate-500 mb-1">Opening</p>
                      <p className="text-xl font-bold text-slate-900">{formatCurrency(opening)}</p>
                    </div>
                    <div className="rounded-lg border border-slate-200 bg-white p-4 text-center">
                      <p className="text-xs font-medium uppercase tracking-wide text-slate-500 mb-1">Debits (liability ↑)</p>
                      <p className="text-xl font-bold text-slate-900">{formatCurrency(totalDebits)}</p>
                    </div>
                    <div className="rounded-lg border border-teal-200 bg-teal-50 p-4 text-center">
                      <p className="text-xs font-medium uppercase tracking-wide text-teal-700 mb-1">Credits (settlements)</p>
                      <p className="text-xl font-bold text-teal-800">{formatCurrency(totalCredits)}</p>
                    </div>
                    <div className={`rounded-lg border p-4 text-center ${isCredit ? 'border-green-300 bg-green-50' : closing > 0.009 ? 'border-red-200 bg-red-50' : 'border-slate-200 bg-white'}`}>
                      <p className="text-xs font-medium uppercase tracking-wide text-slate-600 mb-1">
                        {isCredit ? 'Closing — supplier credit' : 'Closing — amount payable'}
                      </p>
                      <p className={`text-xl font-bold ${isCredit ? 'text-green-800' : closing > 0.009 ? 'text-red-700' : 'text-slate-900'}`}>
                        {formatCurrency(Math.abs(closing))}
                        {isCredit ? ' CR' : closing > 0.009 ? ' DR' : ''}
                      </p>
                      {unalloc > 0.009 ? (
                        <p className="text-xs text-slate-500 mt-1">Unallocated prepayments: {formatCurrency(unalloc)}</p>
                      ) : null}
                    </div>
                  </div>

                  <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                    <div className="bg-indigo-700 px-4 sm:px-6 py-3">
                      <h4 className="text-base font-semibold text-white">Supplier</h4>
                      <p className="text-indigo-100 text-sm mt-0.5">{supplierName}</p>
                    </div>
                  </div>

                  {rows.length > 0 ? (
                    <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                      <div className="bg-slate-800 px-4 sm:px-6 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                        <div>
                          <h4 className="text-base font-semibold text-white">Account movements (AP partner ledger)</h4>
                          <p className="text-slate-300 text-xs mt-0.5">One row per business document — running balance after each</p>
                        </div>
                        <span className="text-slate-300 text-xs sm:text-sm">{rows.length} lines</span>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full min-w-full text-sm">
                          <thead className="bg-slate-50 border-b">
                            <tr>
                              <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Date</th>
                              <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Type</th>
                              <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Document</th>
                              <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Particulars</th>
                              <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Debit</th>
                              <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Credit</th>
                              <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Balance</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            {rows.map((row, idx) => {
                              const bal = Number(row.balanceAfter ?? row.balance ?? 0);
                              return (
                                <tr key={idx} className="hover:bg-slate-50">
                                  <td className="px-3 py-2.5 whitespace-nowrap tabular-nums">
                                    {formatDisplayDate(String(row.date ?? ''))}
                                  </td>
                                  <td className="px-3 py-2.5">
                                    <span className={`px-2 py-0.5 rounded text-xs font-semibold ${typeClass(String(row.itemStatus ?? row.vchType ?? ''))}`}>
                                      {String(row.vchType ?? row.itemStatus ?? '')}
                                    </span>
                                  </td>
                                  <td className="px-3 py-2.5 font-mono text-xs text-indigo-700">
                                    {String(row.vchNo ?? row.docNumber ?? '')}
                                  </td>
                                  <td className="px-3 py-2.5 text-slate-700">
                                    {String(row.particulars ?? row.description ?? '')}
                                  </td>
                                  <td className="px-3 py-2.5 text-right tabular-nums">
                                    {Number(row.debit ?? 0) > 0.009 ? formatCurrency(Number(row.debit)) : '—'}
                                  </td>
                                  <td className="px-3 py-2.5 text-right tabular-nums text-teal-800 font-medium">
                                    {Number(row.credit ?? 0) > 0.009 ? formatCurrency(Number(row.credit)) : '—'}
                                  </td>
                                  <td className={`px-3 py-2.5 text-right tabular-nums font-semibold ${bal < -0.009 ? 'text-green-700' : bal > 0.009 ? 'text-red-700' : 'text-slate-800'}`}>
                                    {formatCurrency(Math.abs(bal))}
                                    {bal < -0.009 ? ' CR' : bal > 0.009 ? ' DR' : ''}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ) : (
                    <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 sm:p-8 text-center">
                      <p className="text-gray-500 text-sm sm:text-lg">No AP movements for this supplier in the selected period.</p>
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        )}

        {/* Customer Payments — open-item + receipt journal */}
        {reportData.reportType === 'CUSTOMER_PAYMENTS' && (
          <div className="space-y-4">
            <p className="text-sm text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-4 py-3">
              <span className="font-semibold text-slate-800">How to read this: </span>
              <strong>Collected</strong> = customer receipts in the date range (posts to Undeposited Funds).{' '}
              <strong>Open balance</strong> = what they still owe now (open invoices − on-account).{' '}
              <strong>Invoiced</strong> = invoices issued in the range (not the same as collected). Deposits are a separate liability.
            </p>

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <div className="rounded-lg border border-teal-200 bg-teal-50 p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-teal-700 mb-1">Collected in period</p>
                <p className="text-xl font-bold text-teal-800">
                  {formatCurrency(Number(reportData.summary?.collectionsInPeriod ?? reportData.summary?.totalPaid ?? 0))}
                </p>
                <p className="text-xs text-teal-700/80 mt-1">
                  {Number(reportData.summary?.collectionCount ?? 0)} receipt(s)
                </p>
              </div>
              <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-red-700 mb-1">Open receivables</p>
                <p className="text-xl font-bold text-red-800">
                  {formatCurrency(Number(reportData.summary?.totalOutstanding ?? 0))}
                </p>
                <p className="text-xs text-red-700/80 mt-1">as of now</p>
              </div>
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-amber-700 mb-1">Overdue</p>
                <p className="text-xl font-bold text-amber-800">
                  {formatCurrency(Number(reportData.summary?.totalOverdue ?? 0))}
                </p>
                <p className="text-xs text-amber-700/80 mt-1">past due date</p>
              </div>
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-600 mb-1">Invoiced in period</p>
                <p className="text-xl font-bold text-slate-900">
                  {formatCurrency(Number(reportData.summary?.totalInvoiced ?? 0))}
                </p>
                <p className="text-xs text-slate-500 mt-1">
                  {Number(reportData.summary?.totalCustomers ?? 0)} customer(s)
                </p>
              </div>
            </div>

            {/* 1) Receipt journal — primary cashier view */}
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
              <div className="bg-teal-700 px-4 sm:px-6 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                <div>
                  <h4 className="text-base font-semibold text-white">1 — Customer receipts (payment journal)</h4>
                  <p className="text-teal-100 text-xs mt-0.5">Who paid, when, how much — by payment date</p>
                </div>
                <span className="text-teal-100 text-xs sm:text-sm">
                  {(reportData.paymentLines || []).length} receipt(s)
                </span>
              </div>
              {(reportData.paymentLines || []).length === 0 ? (
                <div className="p-8 text-center text-sm text-slate-500">
                  No AR receipts in this period. (Cash sales that never created a customer payment receipt will not appear here.)
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-full text-sm">
                    <thead className="bg-slate-50 border-b">
                      <tr>
                        <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Date</th>
                        <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Customer</th>
                        <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Receipt #</th>
                        <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Method</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Amount</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Unallocated</th>
                        <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {(reportData.paymentLines || []).map((line, idx) => (
                        <tr key={idx} className="hover:bg-teal-50/40">
                          <td className="px-3 py-2.5 whitespace-nowrap tabular-nums">{String(line.paymentDate ?? '')}</td>
                          <td className="px-3 py-2.5">
                            <div className="font-medium text-slate-900">{String(line.customerName ?? '')}</div>
                            <div className="text-xs text-slate-500 font-mono">{String(line.customerNumber ?? '')}</div>
                          </td>
                          <td className="px-3 py-2.5 font-mono text-xs text-indigo-700">{String(line.paymentNumber ?? '')}</td>
                          <td className="px-3 py-2.5">{String(line.paymentMethod ?? '').replace(/_/g, ' ')}</td>
                          <td className="px-3 py-2.5 text-right font-semibold text-teal-800 tabular-nums">
                            {formatCurrency(Number(line.amount ?? 0))}
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-slate-600">
                            {formatCurrency(Number(line.unallocatedAmount ?? 0))}
                          </td>
                          <td className="px-3 py-2.5 text-xs">{String(line.status ?? '')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* 2) Partner open balances */}
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
              <div className="bg-slate-800 px-4 sm:px-6 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                <div>
                  <h4 className="text-base font-semibold text-white">2 — Customer open balances</h4>
                  <p className="text-slate-300 text-xs mt-0.5">
                    Invoiced in range vs collected in range vs open AR now
                  </p>
                </div>
                <span className="text-slate-300 text-xs sm:text-sm">{reportData.data?.length || 0} customer(s)</span>
              </div>
              {!reportData.data || reportData.data.length === 0 ? (
                <div className="p-8 text-center text-sm text-slate-500">No customer AR activity in this period.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-full text-sm">
                    <thead className="bg-slate-50 border-b">
                      <tr>
                        <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Customer</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Invoices</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Invoiced (period)</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Collected (period)</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Open balance</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Overdue</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {reportData.data.map((row, idx) => (
                        <tr key={idx} className="hover:bg-slate-50">
                          <td className="px-3 py-2.5">
                            <div className="font-medium text-slate-900">{String(row.customerName ?? '')}</div>
                            <div className="text-xs text-slate-500 font-mono">{String(row.customerNumber ?? '')}</div>
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums">{Number(row.totalInvoices ?? 0)}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums">{formatCurrency(Number(row.totalInvoiced ?? 0))}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums font-semibold text-teal-800">
                            {formatCurrency(Number(row.totalPaid ?? 0))}
                          </td>
                          <td className={`px-3 py-2.5 text-right tabular-nums font-semibold ${Number(row.totalOutstanding ?? 0) > 0 ? 'text-red-700' : 'text-green-700'}`}>
                            {formatCurrency(Number(row.totalOutstanding ?? 0))}
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-amber-800">
                            {formatCurrency(Number(row.overdueAmount ?? 0))}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* 3) Deposits — separate liability */}
            {(Number(reportData.summary?.totalDeposited ?? 0) > 0 ||
              Number(reportData.summary?.depositAvailable ?? 0) > 0) && (
              <div className="bg-white rounded-xl shadow-sm border border-purple-200 overflow-hidden">
                <div className="bg-purple-800 px-4 sm:px-6 py-3">
                  <h4 className="text-base font-semibold text-white">3 — Customer deposits (liability — not AR)</h4>
                  <p className="text-purple-200 text-xs mt-0.5">
                    Prepayments held on account. Not the same as receivable collections above.
                  </p>
                </div>
                <div className="p-4 grid grid-cols-2 gap-3">
                  <div className="rounded-lg bg-purple-50 border border-purple-100 p-3 text-center">
                    <p className="text-xs uppercase text-purple-600 mb-1">Deposits taken (active book)</p>
                    <p className="text-lg font-bold text-purple-900">
                      {formatCurrency(Number(reportData.summary?.totalDeposited ?? 0))}
                    </p>
                  </div>
                  <div className="rounded-lg bg-purple-50 border border-purple-100 p-3 text-center">
                    <p className="text-xs uppercase text-purple-600 mb-1">Still available</p>
                    <p className="text-lg font-bold text-purple-900">
                      {formatCurrency(Number(reportData.summary?.depositAvailable ?? 0))}
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* AR Ledger — same GL partner-ledger pattern as Customer Account Statement */}
        {reportData.reportType === 'AR_LEDGER' && (
          <div className="space-y-4">
            <p className="text-sm text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-4 py-3">
              <span className="font-semibold text-slate-800">Accounts receivable ledger: </span>
              Same axis as Customer Account Statement. Debits = charges; credits = settlements.
              Negative closing = customer credit.
            </p>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <div className="rounded-lg border border-slate-200 bg-white p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500 mb-1">Opening</p>
                <p className="text-xl font-bold text-slate-900">
                  {formatCurrency(Number(reportData.summary?.openingBalance ?? 0))}
                </p>
              </div>
              <div className="rounded-lg border border-slate-200 bg-white p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500 mb-1">Debits</p>
                <p className="text-xl font-bold text-slate-900">
                  {formatCurrency(Number(reportData.summary?.totalDebit ?? reportData.summary?.totalDebits ?? 0))}
                </p>
              </div>
              <div className="rounded-lg border border-teal-200 bg-teal-50 p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-teal-700 mb-1">Credits</p>
                <p className="text-xl font-bold text-teal-800">
                  {formatCurrency(Number(reportData.summary?.totalCredit ?? reportData.summary?.totalCredits ?? 0))}
                </p>
              </div>
              <div className="rounded-lg border border-slate-200 bg-white p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-600 mb-1">Closing</p>
                {(() => {
                  const c = Number(reportData.summary?.closingBalance ?? 0);
                  const credit = c < -0.009;
                  return (
                    <p className={`text-xl font-bold ${credit ? 'text-green-800' : c > 0.009 ? 'text-red-700' : 'text-slate-900'}`}>
                      {formatCurrency(Math.abs(c))}
                      {credit ? ' CR' : c > 0.009 ? ' DR' : ''}
                    </p>
                  );
                })()}
              </div>
            </div>
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
              <div className="bg-slate-800 px-4 sm:px-6 py-3 flex justify-between items-center">
                <div>
                  <h4 className="text-base font-semibold text-white">AR ledger movements</h4>
                  <p className="text-slate-300 text-xs mt-0.5">Running balance on GL 1200</p>
                </div>
                <span className="text-slate-300 text-xs">{reportData.data?.length || 0} lines</span>
              </div>
              {!reportData.data?.length ? (
                <div className="p-8 text-center text-sm text-slate-500">No AR ledger lines in this period.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-full text-sm">
                    <thead className="bg-slate-50 border-b">
                      <tr>
                        <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Date</th>
                        <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Type</th>
                        <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Document</th>
                        <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Description</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Debit</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Credit</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Balance</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {reportData.data.map((row, idx) => {
                        const bal = Number(row.balance ?? 0);
                        const refType = String(row.referenceType ?? '').replace(/_/g, ' ');
                        const doc = String(row.referenceNumber || row.transactionNumber || '');
                        return (
                          <tr key={idx} className="hover:bg-slate-50">
                            <td className="px-3 py-2.5 whitespace-nowrap tabular-nums">
                              {formatDisplayDate(String(row.date ?? ''))}
                            </td>
                            <td className="px-3 py-2.5 text-xs font-medium text-slate-700">{refType}</td>
                            <td className="px-3 py-2.5 font-mono text-xs text-indigo-700">{doc}</td>
                            <td className="px-3 py-2.5 text-slate-700">{String(row.description ?? '')}</td>
                            <td className="px-3 py-2.5 text-right tabular-nums">
                              {Number(row.debit ?? 0) > 0.009 ? formatCurrency(Number(row.debit)) : '—'}
                            </td>
                            <td className="px-3 py-2.5 text-right tabular-nums text-teal-800 font-medium">
                              {Number(row.credit ?? 0) > 0.009 ? formatCurrency(Number(row.credit)) : '—'}
                            </td>
                            <td className={`px-3 py-2.5 text-right tabular-nums font-semibold ${bal < -0.009 ? 'text-green-700' : bal > 0.009 ? 'text-red-700' : 'text-slate-800'}`}>
                              {formatCurrency(Math.abs(bal))}
                              {bal < -0.009 ? ' CR' : bal > 0.009 ? ' DR' : ''}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {/* AP Ledger — same GL partner-ledger pattern as Supplier Statement */}
        {reportData.reportType === 'AP_LEDGER' && (
          <div className="space-y-4">
            <p className="text-sm text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-4 py-3">
              <span className="font-semibold text-slate-800">Accounts payable ledger: </span>
              Same axis as Supplier Statement. Debits = liability increases; credits = settlements.
              Negative closing = supplier credit / prepaid.
            </p>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <div className="rounded-lg border border-slate-200 bg-white p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500 mb-1">Opening</p>
                <p className="text-xl font-bold text-slate-900">
                  {formatCurrency(Number(reportData.summary?.openingBalance ?? 0))}
                </p>
              </div>
              <div className="rounded-lg border border-slate-200 bg-white p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500 mb-1">Debits</p>
                <p className="text-xl font-bold text-slate-900">
                  {formatCurrency(Number(reportData.summary?.totalDebit ?? reportData.summary?.totalDebits ?? 0))}
                </p>
              </div>
              <div className="rounded-lg border border-teal-200 bg-teal-50 p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-teal-700 mb-1">Credits</p>
                <p className="text-xl font-bold text-teal-800">
                  {formatCurrency(Number(reportData.summary?.totalCredit ?? reportData.summary?.totalCredits ?? 0))}
                </p>
              </div>
              <div className="rounded-lg border border-slate-200 bg-white p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-600 mb-1">Closing</p>
                {(() => {
                  const c = Number(reportData.summary?.closingBalance ?? 0);
                  const credit = c < -0.009;
                  return (
                    <p className={`text-xl font-bold ${credit ? 'text-green-800' : c > 0.009 ? 'text-red-700' : 'text-slate-900'}`}>
                      {formatCurrency(Math.abs(c))}
                      {credit ? ' CR' : c > 0.009 ? ' DR' : ''}
                    </p>
                  );
                })()}
              </div>
            </div>
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
              <div className="bg-slate-800 px-4 sm:px-6 py-3 flex justify-between items-center">
                <div>
                  <h4 className="text-base font-semibold text-white">AP ledger movements</h4>
                  <p className="text-slate-300 text-xs mt-0.5">Running balance on AP control</p>
                </div>
                <span className="text-slate-300 text-xs">{reportData.data?.length || 0} lines</span>
              </div>
              {!reportData.data?.length ? (
                <div className="p-8 text-center text-sm text-slate-500">No AP ledger lines in this period.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-full text-sm">
                    <thead className="bg-slate-50 border-b">
                      <tr>
                        <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Date</th>
                        <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Type</th>
                        <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Document</th>
                        <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Description</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Debit</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Credit</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Balance</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {reportData.data.map((row, idx) => {
                        const bal = Number(row.balance ?? 0);
                        const refType = String(row.referenceType ?? '').replace(/_/g, ' ');
                        const doc = String(row.referenceNumber || row.transactionNumber || '');
                        return (
                          <tr key={idx} className="hover:bg-slate-50">
                            <td className="px-3 py-2.5 whitespace-nowrap tabular-nums">
                              {formatDisplayDate(String(row.date ?? ''))}
                            </td>
                            <td className="px-3 py-2.5 text-xs font-medium text-slate-700">{refType}</td>
                            <td className="px-3 py-2.5 font-mono text-xs text-indigo-700">{doc}</td>
                            <td className="px-3 py-2.5 text-slate-700">{String(row.description ?? '')}</td>
                            <td className="px-3 py-2.5 text-right tabular-nums">
                              {Number(row.debit ?? 0) > 0.009 ? formatCurrency(Number(row.debit)) : '—'}
                            </td>
                            <td className="px-3 py-2.5 text-right tabular-nums text-teal-800 font-medium">
                              {Number(row.credit ?? 0) > 0.009 ? formatCurrency(Number(row.credit)) : '—'}
                            </td>
                            <td className={`px-3 py-2.5 text-right tabular-nums font-semibold ${bal < -0.009 ? 'text-green-700' : bal > 0.009 ? 'text-red-700' : 'text-slate-800'}`}>
                              {formatCurrency(Math.abs(bal))}
                              {bal < -0.009 ? ' CR' : bal > 0.009 ? ' DR' : ''}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Top Customers — sales ranking + open-item AR outstanding */}
        {reportData.reportType === 'TOP_CUSTOMERS' && (
          <div className="space-y-4">
            <p className="text-sm text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-4 py-3">
              <span className="font-semibold text-slate-800">Customer ranking: </span>
              Revenue/orders/profit from <strong>posted sales in the period</strong> (voids excluded).
              <strong> Open balance</strong> is current open-item AR (same SSOT as Aging), not period residual.
            </p>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
              <div className="rounded-lg border border-slate-200 bg-white p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500 mb-1">Customers ranked</p>
                <p className="text-xl font-bold text-slate-900">{reportData.data?.length || 0}</p>
              </div>
              <div className="rounded-lg border border-slate-200 bg-white p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500 mb-1">Period revenue</p>
                <p className="text-xl font-bold text-slate-900">
                  {formatCurrency(
                    (reportData.data || []).reduce((s, r) => s + Number(r.totalRevenue ?? 0), 0),
                  )}
                </p>
              </div>
              <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-red-700 mb-1">Open AR (now)</p>
                <p className="text-xl font-bold text-red-800">
                  {formatCurrency(
                    (reportData.data || []).reduce((s, r) => s + Number(r.outstandingBalance ?? 0), 0),
                  )}
                </p>
              </div>
            </div>
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
              <div className="bg-slate-800 px-4 sm:px-6 py-3">
                <h4 className="text-base font-semibold text-white">Customer ranking</h4>
              </div>
              {!reportData.data?.length ? (
                <div className="p-8 text-center text-sm text-slate-500">No customer sales in this period.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-full text-sm">
                    <thead className="bg-slate-50 border-b">
                      <tr>
                        <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">#</th>
                        <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Customer</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Orders</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Revenue</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Profit</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Avg ticket</th>
                        <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Last sale</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Open balance</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {reportData.data.map((row, idx) => (
                        <tr key={idx} className="hover:bg-slate-50">
                          <td className="px-3 py-2.5 tabular-nums text-slate-500">{Number(row.rank ?? idx + 1)}</td>
                          <td className="px-3 py-2.5">
                            <div className="font-medium text-slate-900">{String(row.customerName ?? '')}</div>
                            <div className="text-xs font-mono text-slate-500">{String(row.customerNumber ?? '')}</div>
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums">{Number(row.totalPurchases ?? 0)}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums font-semibold">
                            {formatCurrency(Number(row.totalRevenue ?? 0))}
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-teal-800">
                            {formatCurrency(Number(row.totalProfit ?? 0))}
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums">
                            {formatCurrency(Number(row.averagePurchaseValue ?? 0))}
                          </td>
                          <td className="px-3 py-2.5 whitespace-nowrap">
                            {formatDisplayDate(String(row.lastPurchaseDate ?? ''))}
                          </td>
                          <td className={`px-3 py-2.5 text-right tabular-nums font-semibold ${Number(row.outstandingBalance ?? 0) > 0.009 ? 'text-red-700' : 'text-green-700'}`}>
                            {formatCurrency(Number(row.outstandingBalance ?? 0))}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Customer Purchase History — sales tickets (not AR statement) */}
        {reportData.reportType === 'CUSTOMER_PURCHASE_HISTORY' && (
          <div className="space-y-4">
            <p className="text-sm text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-4 py-3">
              <span className="font-semibold text-slate-800">Purchase history (POS sales): </span>
              Ticket list for one customer. Voids/refunds excluded. For running AR balance use{' '}
              <strong>Customer Account Statement</strong> or <strong>AR Ledger</strong>.
            </p>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <div className="rounded-lg border border-slate-200 bg-white p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500 mb-1">Tickets</p>
                <p className="text-xl font-bold text-slate-900">{reportData.data?.length || 0}</p>
              </div>
              <div className="rounded-lg border border-slate-200 bg-white p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500 mb-1">Sales total</p>
                <p className="text-xl font-bold text-slate-900">
                  {formatCurrency(
                    (reportData.data || []).reduce((s, r) => s + Number(r.totalAmount ?? 0), 0),
                  )}
                </p>
              </div>
              <div className="rounded-lg border border-teal-200 bg-teal-50 p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-teal-700 mb-1">Paid on tickets</p>
                <p className="text-xl font-bold text-teal-800">
                  {formatCurrency(
                    (reportData.data || []).reduce((s, r) => s + Number(r.amountPaid ?? 0), 0),
                  )}
                </p>
              </div>
              <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-red-700 mb-1">Still due on tickets</p>
                <p className="text-xl font-bold text-red-800">
                  {formatCurrency(
                    (reportData.data || []).reduce((s, r) => s + Number(r.outstandingBalance ?? 0), 0),
                  )}
                </p>
              </div>
            </div>
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
              <div className="bg-slate-800 px-4 sm:px-6 py-3">
                <h4 className="text-base font-semibold text-white">Sales tickets</h4>
              </div>
              {!reportData.data?.length ? (
                <div className="p-8 text-center text-sm text-slate-500">No sales for this customer in the period.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-full text-sm">
                    <thead className="bg-slate-50 border-b">
                      <tr>
                        <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Date</th>
                        <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Sale #</th>
                        <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Method</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Items</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Total</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Paid</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Due</th>
                        <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {reportData.data.map((row, idx) => (
                        <tr key={idx} className="hover:bg-slate-50">
                          <td className="px-3 py-2.5 whitespace-nowrap tabular-nums">
                            {formatDisplayDate(String(row.saleDate ?? ''))}
                          </td>
                          <td className="px-3 py-2.5 font-mono text-xs text-indigo-700">
                            {String(row.saleNumber ?? '')}
                          </td>
                          <td className="px-3 py-2.5">{String(row.paymentMethod ?? '').replace(/_/g, ' ')}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums">{Number(row.itemCount ?? 0)}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums font-semibold">
                            {formatCurrency(Number(row.totalAmount ?? 0))}
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-teal-800">
                            {formatCurrency(Number(row.amountPaid ?? 0))}
                          </td>
                          <td className={`px-3 py-2.5 text-right tabular-nums font-semibold ${Number(row.outstandingBalance ?? 0) > 0.009 ? 'text-red-700' : 'text-green-700'}`}>
                            {formatCurrency(Number(row.outstandingBalance ?? 0))}
                          </td>
                          <td className="px-3 py-2.5 text-xs">{String(row.status ?? '')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Customer Aging Report - Special Handling (No API call needed, component fetches own data) */}
        {selectedReport === 'CUSTOMER_AGING_REPORT' && (
          <div className="space-y-6">
            <CustomerAgingReport />
          </div>
        )}

        {/* Cash Register Session Summary - Custom Renderer */}
        {/* Payment Report — tender / payment method analysis */}
        {reportData.reportType === 'PAYMENT_REPORT' && (
          <div className="space-y-4">
            <p className="text-sm text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-4 py-3">
              <span className="font-semibold text-slate-800">Payment methods: </span>
              Liquid receipts by payment method for the period (cash, card, mobile money, etc.).
            </p>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <div className="rounded-lg border border-teal-200 bg-teal-50 p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-teal-700 mb-1">Total collected</p>
                <p className="text-xl font-bold text-teal-800">
                  {formatCurrency(Number(reportData.summary?.totalAmount ?? 0))}
                </p>
              </div>
              <div className="rounded-lg border border-slate-200 bg-white p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500 mb-1">Transactions</p>
                <p className="text-xl font-bold text-slate-900">
                  {Number(reportData.summary?.totalTransactions ?? 0)}
                </p>
              </div>
              <div className="rounded-lg border border-slate-200 bg-white p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500 mb-1">Methods</p>
                <p className="text-xl font-bold text-slate-900">{reportData.data?.length || 0}</p>
              </div>
              <div className="rounded-lg border border-slate-200 bg-white p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500 mb-1">Top method</p>
                <p className="text-lg font-bold text-slate-900 truncate">
                  {String(reportData.data?.[0]?.paymentMethod ?? '—')}
                </p>
              </div>
            </div>
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
              <div className="bg-slate-800 px-4 sm:px-6 py-3">
                <h4 className="text-base font-semibold text-white">Payment method breakdown</h4>
              </div>
              {!reportData.data?.length ? (
                <div className="p-8 text-center text-sm text-slate-500">No payments in this period.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-full text-sm">
                    <thead className="bg-slate-50 border-b">
                      <tr>
                        <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Method</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Count</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Total</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Avg</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Share</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {reportData.data.map((row, idx) => (
                        <tr key={idx} className="hover:bg-slate-50">
                          <td className="px-3 py-2.5 font-medium text-slate-900">
                            {String(row.paymentMethod ?? '')}
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums">
                            {Number(row.transactionCount ?? 0)}
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums font-semibold">
                            {formatCurrency(Number(row.totalAmount ?? 0))}
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums">
                            {formatCurrency(Number(row.avgAmount ?? 0))}
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-teal-800">
                            {Number(row.percentageOfTotal ?? 0).toFixed(1)}%
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Profit Margin by Product */}
        {reportData.reportType === 'PROFIT_MARGIN_BY_PRODUCT' && (
          <div className="space-y-4">
            <p className="text-sm text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-4 py-3">
              <span className="font-semibold text-slate-800">Product margins: </span>
              Revenue − cost = gross profit; margin % is contribution by SKU for the period.
            </p>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <div className="rounded-lg border border-slate-200 bg-white p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500 mb-1">Products</p>
                <p className="text-xl font-bold text-slate-900">
                  {Number(reportData.summary?.totalProducts ?? reportData.data?.length ?? 0)}
                </p>
              </div>
              <div className="rounded-lg border border-slate-200 bg-white p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500 mb-1">Revenue</p>
                <p className="text-xl font-bold text-slate-900">
                  {formatCurrency(Number(reportData.summary?.totalRevenue ?? 0))}
                </p>
              </div>
              <div className="rounded-lg border border-teal-200 bg-teal-50 p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-teal-700 mb-1">Gross profit</p>
                <p className="text-xl font-bold text-teal-800">
                  {formatCurrency(Number(reportData.summary?.totalProfit ?? 0))}
                </p>
              </div>
              <div className="rounded-lg border border-slate-200 bg-white p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500 mb-1">Avg margin</p>
                <p className="text-xl font-bold text-slate-900">
                  {Number(reportData.summary?.averageMarginPercent ?? 0).toFixed(1)}%
                </p>
              </div>
            </div>
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
              <div className="bg-slate-800 px-4 sm:px-6 py-3 flex justify-between">
                <h4 className="text-base font-semibold text-white">Product margins</h4>
                <span className="text-slate-300 text-xs">{reportData.data?.length || 0} SKUs</span>
              </div>
              {!reportData.data?.length ? (
                <div className="p-8 text-center text-sm text-slate-500">No product margins for this period.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-full text-sm">
                    <thead className="bg-slate-50 border-b">
                      <tr>
                        <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Product</th>
                        <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Category</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Qty</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Revenue</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Cost</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Profit</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Margin %</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {reportData.data.map((row, idx) => (
                        <tr key={idx} className="hover:bg-slate-50">
                          <td className="px-3 py-2.5 font-medium text-slate-900">{String(row.productName ?? '')}</td>
                          <td className="px-3 py-2.5 text-slate-600">{String(row.category ?? '')}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums">{Number(row.totalQuantitySold ?? 0)}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums">{formatCurrency(Number(row.totalRevenue ?? 0))}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums">{formatCurrency(Number(row.totalCost ?? 0))}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-teal-800 font-medium">
                            {formatCurrency(Number(row.grossProfit ?? row.totalProfit ?? 0))}
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums font-semibold">
                            {Number(row.profitMarginPercent ?? row.marginPercent ?? row.profitMargin ?? 0).toFixed(1)}%
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Sales Returns & Allowances */}
        {reportData.reportType === 'SALES_RETURNS_ALLOWANCES' && (
          <div className="space-y-4">
            <p className="text-sm text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-4 py-3">
              <span className="font-semibold text-slate-800">Sales returns: </span>
              Customer credit notes reducing revenue (and output tax). Net sales = gross sales − returns.
            </p>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <div className="rounded-lg border border-slate-200 bg-white p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500 mb-1">Gross sales</p>
                <p className="text-xl font-bold text-slate-900">
                  {formatCurrency(Number(reportData.summary?.totalSales ?? 0))}
                </p>
              </div>
              <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-red-700 mb-1">Returns</p>
                <p className="text-xl font-bold text-red-800">
                  {formatCurrency(Number(reportData.summary?.totalReturns ?? 0))}
                </p>
              </div>
              <div className="rounded-lg border border-teal-200 bg-teal-50 p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-teal-700 mb-1">Net sales</p>
                <p className="text-xl font-bold text-teal-800">
                  {formatCurrency(Number(reportData.summary?.netSales ?? 0))}
                </p>
              </div>
              <div className="rounded-lg border border-slate-200 bg-white p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500 mb-1">Credit notes</p>
                <p className="text-xl font-bold text-slate-900">
                  {Number(reportData.summary?.totalCreditNotes ?? 0)}
                </p>
              </div>
            </div>
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
              <div className="bg-slate-800 px-4 sm:px-6 py-3">
                <h4 className="text-base font-semibold text-white">By period</h4>
              </div>
              {!reportData.data?.length ? (
                <div className="p-8 text-center text-sm text-slate-500">No sales returns in this period.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-full text-sm">
                    <thead className="bg-slate-50 border-b">
                      <tr>
                        <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Period</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Gross sales</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Returns</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Net sales</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">CN count</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {reportData.data.map((row, idx) => (
                        <tr key={idx} className="hover:bg-slate-50">
                          <td className="px-3 py-2.5 font-mono text-xs">{String(row.period ?? '')}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums">{formatCurrency(Number(row.totalSales ?? 0))}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-red-700">{formatCurrency(Number(row.salesReturns ?? 0))}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums font-semibold">{formatCurrency(Number(row.netSales ?? 0))}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums">{Number(row.creditNoteCount ?? 0)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Purchase Returns & Allowances */}
        {reportData.reportType === 'PURCHASE_RETURNS_ALLOWANCES' && (
          <div className="space-y-4">
            <p className="text-sm text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-4 py-3">
              <span className="font-semibold text-slate-800">Purchase returns: </span>
              Supplier credit notes reducing purchases / COGS. Net purchases = gross − returns.
            </p>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <div className="rounded-lg border border-slate-200 bg-white p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500 mb-1">Gross purchases</p>
                <p className="text-xl font-bold text-slate-900">
                  {formatCurrency(Number(reportData.summary?.totalPurchases ?? 0))}
                </p>
              </div>
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-amber-700 mb-1">Returns</p>
                <p className="text-xl font-bold text-amber-800">
                  {formatCurrency(Number(reportData.summary?.totalReturns ?? 0))}
                </p>
              </div>
              <div className="rounded-lg border border-teal-200 bg-teal-50 p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-teal-700 mb-1">Net purchases</p>
                <p className="text-xl font-bold text-teal-800">
                  {formatCurrency(Number(reportData.summary?.netPurchases ?? 0))}
                </p>
              </div>
              <div className="rounded-lg border border-slate-200 bg-white p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500 mb-1">SCN count</p>
                <p className="text-xl font-bold text-slate-900">
                  {Number(reportData.summary?.totalCreditNotes ?? 0)}
                </p>
              </div>
            </div>
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
              <div className="bg-slate-800 px-4 sm:px-6 py-3">
                <h4 className="text-base font-semibold text-white">By period</h4>
              </div>
              {!reportData.data?.length ? (
                <div className="p-8 text-center text-sm text-slate-500">No purchase returns in this period.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-full text-sm">
                    <thead className="bg-slate-50 border-b">
                      <tr>
                        <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Period</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Gross purchases</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Returns</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Net</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">SCN count</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {reportData.data.map((row, idx) => (
                        <tr key={idx} className="hover:bg-slate-50">
                          <td className="px-3 py-2.5 font-mono text-xs">{String(row.period ?? '')}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums">{formatCurrency(Number(row.totalPurchases ?? 0))}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-amber-800">{formatCurrency(Number(row.purchaseReturns ?? 0))}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums font-semibold">{formatCurrency(Number(row.netPurchases ?? 0))}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums">{Number(row.creditNoteCount ?? 0)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Credit / Debit Note Register */}
        {reportData.reportType === 'NOTE_REGISTER' && (
          <div className="space-y-4">
            <p className="text-sm text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-4 py-3">
              <span className="font-semibold text-slate-800">Credit / debit note register: </span>
              All customer and supplier credit/debit notes with status and amounts for the period.
            </p>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <div className="rounded-lg border border-slate-200 bg-white p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500 mb-1">Notes</p>
                <p className="text-xl font-bold text-slate-900">
                  {Number(reportData.summary?.totalNotes ?? reportData.data?.length ?? 0)}
                </p>
              </div>
              <div className="rounded-lg border border-slate-200 bg-white p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500 mb-1">Total amount</p>
                <p className="text-xl font-bold text-slate-900">
                  {formatCurrency(Number(reportData.summary?.totalAmount ?? 0))}
                </p>
              </div>
              <div className="rounded-lg border border-teal-200 bg-teal-50 p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-teal-700 mb-1">Posted</p>
                <p className="text-xl font-bold text-teal-800">
                  {Number(reportData.summary?.postedCount ?? 0)}
                </p>
              </div>
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-amber-700 mb-1">Draft</p>
                <p className="text-xl font-bold text-amber-800">
                  {Number(reportData.summary?.draftCount ?? 0)}
                </p>
              </div>
            </div>
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
              <div className="bg-slate-800 px-4 sm:px-6 py-3 flex justify-between">
                <h4 className="text-base font-semibold text-white">Note register</h4>
                <span className="text-slate-300 text-xs">{reportData.data?.length || 0} rows</span>
              </div>
              {!reportData.data?.length ? (
                <div className="p-8 text-center text-sm text-slate-500">No credit/debit notes in this period.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-full text-sm">
                    <thead className="bg-slate-50 border-b">
                      <tr>
                        <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Date</th>
                        <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Note #</th>
                        <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Type</th>
                        <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Side</th>
                        <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Party</th>
                        <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Ref invoice</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Tax</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Total</th>
                        <th className="px-3 py-3 text-left text-xs font-bold text-slate-600 uppercase">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {reportData.data.map((row, idx) => (
                        <tr key={idx} className="hover:bg-slate-50">
                          <td className="px-3 py-2.5 whitespace-nowrap tabular-nums">
                            {formatDisplayDate(String(row.issueDate ?? ''))}
                          </td>
                          <td className="px-3 py-2.5 font-mono text-xs text-indigo-700">{String(row.noteNumber ?? '')}</td>
                          <td className="px-3 py-2.5 text-xs">{String(row.documentType ?? '').replace(/_/g, ' ')}</td>
                          <td className="px-3 py-2.5 text-xs">{String(row.side ?? '')}</td>
                          <td className="px-3 py-2.5">{String(row.partyName ?? '')}</td>
                          <td className="px-3 py-2.5 font-mono text-xs">{String(row.referenceInvoiceNumber ?? '—')}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums">{formatCurrency(Number(row.taxAmount ?? 0))}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums font-semibold">{formatCurrency(Number(row.totalAmount ?? 0))}</td>
                          <td className="px-3 py-2.5 text-xs font-semibold">{String(row.status ?? '')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Tax Reversal Report */}
        {reportData.reportType === 'TAX_REVERSAL' && (
          <div className="space-y-4">
            <p className="text-sm text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-4 py-3">
              <span className="font-semibold text-slate-800">Tax reconciliation: </span>
              Output tax from sales vs reversed by customer CNs; input tax from purchases vs reversed by supplier CNs.
            </p>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <div className="rounded-lg border border-slate-200 bg-white p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500 mb-1">Output VAT</p>
                <p className="text-xl font-bold text-slate-900">
                  {formatCurrency(Number(reportData.summary?.totalSalesTax ?? 0))}
                </p>
              </div>
              <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-red-700 mb-1">CN tax reversal</p>
                <p className="text-xl font-bold text-red-800">
                  {formatCurrency(Number(reportData.summary?.totalSalesReversed ?? reportData.summary?.totalTaxReversedByCN ?? 0))}
                </p>
              </div>
              <div className="rounded-lg border border-slate-200 bg-white p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500 mb-1">Input VAT</p>
                <p className="text-xl font-bold text-slate-900">
                  {formatCurrency(Number(reportData.summary?.totalPurchaseTax ?? 0))}
                </p>
              </div>
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-amber-700 mb-1">SCN tax reversal</p>
                <p className="text-xl font-bold text-amber-800">
                  {formatCurrency(Number(reportData.summary?.totalPurchaseReversed ?? reportData.summary?.totalTaxReversedBySCN ?? 0))}
                </p>
              </div>
            </div>
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
              <div className="bg-slate-800 px-4 sm:px-6 py-3">
                <h4 className="text-base font-semibold text-white">By tax rate</h4>
              </div>
              {!reportData.data?.length ? (
                <div className="p-8 text-center text-sm text-slate-500">No tax reversal lines in this period.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-full text-sm">
                    <thead className="bg-slate-50 border-b">
                      <tr>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Rate %</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Sales tax</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">CN reversed</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Net output</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Purchase tax</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">SCN reversed</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-slate-600 uppercase">Net input</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {reportData.data.map((row, idx) => (
                        <tr key={idx} className="hover:bg-slate-50">
                          <td className="px-3 py-2.5 text-right tabular-nums font-medium">{Number(row.taxRate ?? 0)}%</td>
                          <td className="px-3 py-2.5 text-right tabular-nums">{formatCurrency(Number(row.salesTax ?? 0))}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-red-700">{formatCurrency(Number(row.taxReversedByCN ?? 0))}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums font-semibold">{formatCurrency(Number(row.netSalesTax ?? 0))}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums">{formatCurrency(Number(row.purchaseTax ?? 0))}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-amber-800">{formatCurrency(Number(row.taxReversedBySCN ?? 0))}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums font-semibold">{formatCurrency(Number(row.netPurchaseTax ?? 0))}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {reportData.reportType === 'CASH_REGISTER_SESSION_SUMMARY' && reportData.session && (
          <div className="space-y-6">
            {/* Session Info Card */}
            <div className="bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden">
              <div className="bg-gradient-to-r from-indigo-500 to-indigo-600 px-6 py-4">
                <h4 className="text-lg font-semibold text-white">🧾 Session Details</h4>
              </div>
              <div className="p-6">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  <div>
                    <div className="text-xs text-gray-500 uppercase tracking-wide">Session</div>
                    <div className="font-mono font-semibold text-gray-900">{reportData.session.sessionNumber}</div>
                  </div>
                  <div>
                    <div className="text-xs text-gray-500 uppercase tracking-wide">Register</div>
                    <div className="font-semibold text-gray-900">{reportData.session.registerName}</div>
                  </div>
                  <div>
                    <div className="text-xs text-gray-500 uppercase tracking-wide">Cashier</div>
                    <div className="font-semibold text-gray-900">{reportData.session.cashierName}</div>
                  </div>
                  <div>
                    <div className="text-xs text-gray-500 uppercase tracking-wide">Status</div>
                    <span className={`inline-flex px-2.5 py-0.5 rounded-full text-xs font-medium ${reportData.session.status === 'OPEN' ? 'bg-green-100 text-green-800' :
                      reportData.session.status === 'CLOSED' ? 'bg-gray-100 text-gray-800' :
                        'bg-yellow-100 text-yellow-800'
                      }`}>{reportData.session.status}</span>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4 mt-4 text-sm text-gray-600">
                  <div>Opened: {reportData.session.openedAt ? formatTimestamp(reportData.session.openedAt) : '—'}</div>
                  <div>Closed: {reportData.session.closedAt ? formatTimestamp(reportData.session.closedAt) : '—'}</div>
                </div>
              </div>
            </div>

            {/* Financial Summary */}
            {reportData.summary && (
              <div className="bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden">
                <div className="bg-gradient-to-r from-green-500 to-green-600 px-6 py-4">
                  <h4 className="text-lg font-semibold text-white">💰 Financial Summary</h4>
                </div>
                <div className="p-6">
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div className="flex justify-between py-2 border-b border-gray-100">
                      <span className="text-gray-600">Opening Float</span>
                      <span className="font-semibold">{formatCurrency(reportData.summary.openingFloat ?? 0)}</span>
                    </div>
                    <div className="flex justify-between py-2 border-b border-gray-100">
                      <span className="text-gray-600">Expected Closing</span>
                      <span className="font-semibold">{formatCurrency(reportData.summary.expectedClosing ?? 0)}</span>
                    </div>
                    <div className="flex justify-between py-2 border-b border-gray-100">
                      <span className="text-gray-600">Cash Sales</span>
                      <span className="font-semibold text-green-600">+ {formatCurrency(reportData.summary.totalSales ?? 0)}</span>
                    </div>
                    <div className="flex justify-between py-2 border-b border-gray-100">
                      <span className="text-gray-600">Cash In</span>
                      <span className="font-semibold text-green-600">+ {formatCurrency(reportData.summary.totalCashIn ?? 0)}</span>
                    </div>
                    <div className="flex justify-between py-2 border-b border-gray-100">
                      <span className="text-gray-600">Cash Out</span>
                      <span className="font-semibold text-red-600">- {formatCurrency(reportData.summary.totalCashOut ?? 0)}</span>
                    </div>
                    <div className="flex justify-between py-2 border-b border-gray-100">
                      <span className="text-gray-600">Refunds</span>
                      <span className="font-semibold text-red-600">- {formatCurrency(reportData.summary.totalRefunds ?? 0)}</span>
                    </div>
                    {reportData.summary.actualClosing != null && (
                      <>
                        <div className="flex justify-between py-2 border-b border-gray-100">
                          <span className="text-gray-600">Actual Closing</span>
                          <span className="font-semibold">{formatCurrency(reportData.summary.actualClosing)}</span>
                        </div>
                        <div className="flex justify-between py-2 border-b border-gray-100">
                          <span className="text-gray-600">Variance</span>
                          <span className={`font-semibold ${(reportData.summary.variance ?? 0) === 0 ? 'text-green-600' : 'text-red-600'}`}>
                            {formatCurrency(reportData.summary.variance ?? 0)}
                          </span>
                        </div>
                      </>
                    )}
                    <div className="flex justify-between py-2 col-span-2 bg-blue-50 px-3 rounded-lg">
                      <span className="font-semibold text-blue-900">Net Cash Flow</span>
                      <span className="font-semibold text-blue-900 text-lg">{formatCurrency(reportData.summary.netCashFlow ?? 0)}</span>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Sales Summary */}
            {reportData.salesSummary && (
              <div className="bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden">
                <div className="bg-gradient-to-r from-blue-500 to-blue-600 px-6 py-4">
                  <h4 className="text-lg font-semibold text-white">🛒 Sales Summary</h4>
                </div>
                <div className="p-6">
                  <div className="grid grid-cols-3 gap-4 text-center">
                    <div>
                      <div className="text-2xl font-bold text-gray-900">{reportData.salesSummary.totalTransactions}</div>
                      <div className="text-xs text-gray-500 uppercase tracking-wide mt-1">Transactions</div>
                    </div>
                    <div>
                      <div className="text-2xl font-bold text-green-600">{formatCurrency(reportData.salesSummary.totalRevenue ?? 0)}</div>
                      <div className="text-xs text-gray-500 uppercase tracking-wide mt-1">Revenue</div>
                    </div>
                    <div>
                      <div className="text-2xl font-bold text-blue-600">{formatCurrency(reportData.salesSummary.totalProfit ?? 0)}</div>
                      <div className="text-xs text-gray-500 uppercase tracking-wide mt-1">Profit</div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Linked Sales Table */}
            {reportData.sales && reportData.sales.length > 0 && (
              <div className="bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden">
                <div className="bg-gradient-to-r from-amber-500 to-amber-600 px-6 py-4 flex items-center justify-between">
                  <h4 className="text-lg font-semibold text-white">📋 Linked Sales</h4>
                  <span className="text-amber-100 text-sm">{reportData.sales.length} sales</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-full">
                    <thead className="bg-gray-100 border-b-2 border-gray-300">
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-bold text-gray-700 uppercase">Sale #</th>
                        <th className="px-4 py-3 text-left text-xs font-bold text-gray-700 uppercase">Customer</th>
                        <th className="px-4 py-3 text-left text-xs font-bold text-gray-700 uppercase">Payment</th>
                        <th className="px-4 py-3 text-right text-xs font-bold text-gray-700 uppercase">Amount</th>
                        <th className="px-4 py-3 text-right text-xs font-bold text-gray-700 uppercase">Profit</th>
                        <th className="px-4 py-3 text-left text-xs font-bold text-gray-700 uppercase">Time</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200">
                      {reportData.sales.map((sale: Record<string, unknown>, idx: number) => (
                        <tr key={idx} className="hover:bg-blue-50">
                          <td className="px-4 py-3 text-sm font-mono font-medium text-gray-900">{String(sale.saleNumber)}</td>
                          <td className="px-4 py-3 text-sm text-gray-600">{String(sale.customerName || 'Walk-in')}</td>
                          <td className="px-4 py-3 text-sm">
                            <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-700">{String(sale.paymentMethod)}</span>
                          </td>
                          <td className="px-4 py-3 text-sm text-right font-semibold">{formatCurrency(Number(sale.totalAmount))}</td>
                          <td className="px-4 py-3 text-sm text-right font-semibold text-green-600">{formatCurrency(Number(sale.profit))}</td>
                          <td className="px-4 py-3 text-sm text-gray-500">{sale.createdAt ? formatTimestamp(String(sale.createdAt)) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Cash Movements Table */}
            {reportData.movements && reportData.movements.length > 0 && (
              <div className="bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden">
                <div className="bg-gradient-to-r from-purple-500 to-purple-600 px-6 py-4 flex items-center justify-between">
                  <h4 className="text-lg font-semibold text-white">📊 Cash Movements</h4>
                  <span className="text-purple-100 text-sm">{reportData.movements.length} movements</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-full">
                    <thead className="bg-gray-100 border-b-2 border-gray-300">
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-bold text-gray-700 uppercase">Type</th>
                        <th className="px-4 py-3 text-right text-xs font-bold text-gray-700 uppercase">Amount</th>
                        <th className="px-4 py-3 text-left text-xs font-bold text-gray-700 uppercase">Reason</th>
                        <th className="px-4 py-3 text-left text-xs font-bold text-gray-700 uppercase">By</th>
                        <th className="px-4 py-3 text-left text-xs font-bold text-gray-700 uppercase">Time</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200">
                      {reportData.movements.map((mv: Record<string, unknown>, idx: number) => (
                        <tr key={idx} className="hover:bg-purple-50">
                          <td className="px-4 py-3 text-sm">
                            <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${String(mv.movementType).includes('IN') ? 'bg-green-100 text-green-700' :
                              String(mv.movementType).includes('OUT') ? 'bg-red-100 text-red-700' :
                                String(mv.movementType) === 'SALE' ? 'bg-blue-100 text-blue-700' :
                                  'bg-gray-100 text-gray-700'
                              }`}>{String(mv.movementType).replace(/_/g, ' ')}</span>
                          </td>
                          <td className="px-4 py-3 text-sm text-right font-semibold">{formatCurrency(Number(mv.amount))}</td>
                          <td className="px-4 py-3 text-sm text-gray-600">{String(mv.reason || '—')}</td>
                          <td className="px-4 py-3 text-sm text-gray-600">{String(mv.createdByName || '—')}</td>
                          <td className="px-4 py-3 text-sm text-gray-500">{mv.createdAt ? formatTimestamp(String(mv.createdAt)) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Cash Register Session History */}
        {reportData.reportType === 'CASH_REGISTER_SESSION_HISTORY' && reportData.sessions && (
          <div className="space-y-6">
            {/* Summary Cards */}
            {reportData.summary && (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
                <div className="bg-white rounded-xl shadow border p-4 text-center">
                  <div className="text-2xl font-bold text-indigo-600">{reportData.summary.totalSessions}</div>
                  <div className="text-xs text-gray-500 mt-1">Total Sessions</div>
                </div>
                <div className="bg-white rounded-xl shadow border p-4 text-center">
                  <div className="text-2xl font-bold text-green-600">{reportData.summary.openSessions}</div>
                  <div className="text-xs text-gray-500 mt-1">Open</div>
                </div>
                <div className="bg-white rounded-xl shadow border p-4 text-center">
                  <div className="text-2xl font-bold text-gray-600">{reportData.summary.closedSessions}</div>
                  <div className="text-xs text-gray-500 mt-1">Closed</div>
                </div>
                <div className="bg-white rounded-xl shadow border p-4 text-center">
                  <div className={`text-2xl font-bold ${Number(reportData.summary.totalVariance) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    {formatCurrency(Number(reportData.summary.totalVariance))}
                  </div>
                  <div className="text-xs text-gray-500 mt-1">Total Variance</div>
                </div>
                <div className="bg-white rounded-xl shadow border p-4 text-center">
                  <div className="text-2xl font-bold text-orange-600">
                    {formatCurrency(Number(reportData.summary.averageVariance))}
                  </div>
                  <div className="text-xs text-gray-500 mt-1">Avg Variance</div>
                </div>
                <div className="bg-white rounded-xl shadow border p-4 text-center">
                  <div className="text-2xl font-bold text-red-600">{reportData.summary.sessionsWithVariance}</div>
                  <div className="text-xs text-gray-500 mt-1">With Variance</div>
                </div>
              </div>
            )}

            {/* Revenue by Register */}
            {reportData.sessions.length > 0 && (() => {
              const byRegister: Record<string, { sessions: number; totalSales: number; totalVariance: number }> = {};
              for (const s of reportData.sessions as Array<Record<string, unknown>>) {
                const name = String(s.registerName || 'Unknown');
                if (!byRegister[name]) byRegister[name] = { sessions: 0, totalSales: 0, totalVariance: 0 };
                byRegister[name].sessions++;
                byRegister[name].totalSales += Number(s.totalSales || 0);
                byRegister[name].totalVariance += Number(s.variance || 0);
              }
              const entries = Object.entries(byRegister).sort((a, b) => b[1].totalSales - a[1].totalSales);
              const grandTotal = entries.reduce((s, [, v]) => s + v.totalSales, 0);
              return (
                <div className="bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden">
                  <div className="bg-gradient-to-r from-blue-500 to-blue-600 px-6 py-4">
                    <h4 className="text-lg font-semibold text-white">💰 Revenue by Register</h4>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-full">
                      <thead className="bg-gray-100 border-b-2 border-gray-300">
                        <tr>
                          <th className="px-4 py-3 text-left text-xs font-bold text-gray-700 uppercase">Register</th>
                          <th className="px-4 py-3 text-right text-xs font-bold text-gray-700 uppercase">Sessions</th>
                          <th className="px-4 py-3 text-right text-xs font-bold text-gray-700 uppercase">Total Sales</th>
                          <th className="px-4 py-3 text-right text-xs font-bold text-gray-700 uppercase">% of Total</th>
                          <th className="px-4 py-3 text-right text-xs font-bold text-gray-700 uppercase">Variance</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-200">
                        {entries.map(([name, data]) => (
                          <tr key={name} className="hover:bg-blue-50">
                            <td className="px-4 py-3 text-sm font-medium text-gray-900">{name}</td>
                            <td className="px-4 py-3 text-sm text-right text-gray-600">{data.sessions}</td>
                            <td className="px-4 py-3 text-sm text-right font-semibold text-blue-600">{formatCurrency(data.totalSales)}</td>
                            <td className="px-4 py-3 text-sm text-right text-gray-600">
                              {grandTotal > 0 ? ((data.totalSales / grandTotal) * 100).toFixed(1) : '0.0'}%
                            </td>
                            <td className={`px-4 py-3 text-sm text-right font-semibold ${data.totalVariance === 0 ? 'text-green-600' :
                              data.totalVariance > 0 ? 'text-blue-600' : 'text-red-600'
                              }`}>{formatCurrency(data.totalVariance)}</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot className="bg-gray-50 border-t-2 border-gray-300">
                        <tr className="font-bold">
                          <td className="px-4 py-3 text-sm text-gray-900">TOTAL</td>
                          <td className="px-4 py-3 text-sm text-right text-gray-600">
                            {entries.reduce((s, [, v]) => s + v.sessions, 0)}
                          </td>
                          <td className="px-4 py-3 text-sm text-right text-blue-600">{formatCurrency(grandTotal)}</td>
                          <td className="px-4 py-3 text-sm text-right text-gray-600">100.0%</td>
                          <td className="px-4 py-3 text-sm text-right text-gray-600">
                            {formatCurrency(entries.reduce((s, [, v]) => s + v.totalVariance, 0))}
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                </div>
              );
            })()}

            {/* Sessions Table */}
            <div className="bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden">
              <div className="bg-gradient-to-r from-indigo-500 to-indigo-600 px-6 py-4 flex items-center justify-between">
                <h4 className="text-lg font-semibold text-white">📋 Session History</h4>
                <span className="text-indigo-100 text-sm">{reportData.sessions.length} sessions</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-full">
                  <thead className="bg-gray-100 border-b-2 border-gray-300">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-bold text-gray-700 uppercase">Session #</th>
                      <th className="px-4 py-3 text-left text-xs font-bold text-gray-700 uppercase">Register</th>
                      <th className="px-4 py-3 text-left text-xs font-bold text-gray-700 uppercase">Cashier</th>
                      <th className="px-4 py-3 text-center text-xs font-bold text-gray-700 uppercase">Status</th>
                      <th className="px-4 py-3 text-left text-xs font-bold text-gray-700 uppercase">Opened</th>
                      <th className="px-4 py-3 text-left text-xs font-bold text-gray-700 uppercase">Closed</th>
                      <th className="px-4 py-3 text-right text-xs font-bold text-gray-700 uppercase">Opening Float</th>
                      <th className="px-4 py-3 text-right text-xs font-bold text-gray-700 uppercase">Sales Total</th>
                      <th className="px-4 py-3 text-right text-xs font-bold text-gray-700 uppercase">Expected</th>
                      <th className="px-4 py-3 text-right text-xs font-bold text-gray-700 uppercase">Actual</th>
                      <th className="px-4 py-3 text-right text-xs font-bold text-gray-700 uppercase">Variance</th>
                      <th className="px-4 py-3 text-right text-xs font-bold text-gray-700 uppercase">Movements</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200">
                    {reportData.sessions.map((s: Record<string, unknown>, idx: number) => (
                      <tr key={idx} className="hover:bg-indigo-50">
                        <td className="px-4 py-3 text-sm font-mono font-semibold text-indigo-700">{String(s.sessionNumber)}</td>
                        <td className="px-4 py-3 text-sm font-medium text-gray-900">{String(s.registerName)}</td>
                        <td className="px-4 py-3 text-sm text-gray-700">{String(s.cashierName)}</td>
                        <td className="px-4 py-3 text-center">
                          <span className={`inline-flex px-2.5 py-0.5 rounded-full text-xs font-medium ${s.status === 'OPEN' ? 'bg-green-100 text-green-800' :
                            s.status === 'CLOSED' ? 'bg-gray-100 text-gray-800' :
                              'bg-yellow-100 text-yellow-800'
                            }`}>{String(s.status)}</span>
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-500">{s.openedAt ? formatTimestamp(String(s.openedAt)) : '—'}</td>
                        <td className="px-4 py-3 text-sm text-gray-500">{s.closedAt ? formatTimestamp(String(s.closedAt)) : '—'}</td>
                        <td className="px-4 py-3 text-sm text-right font-semibold">{formatCurrency(Number(s.openingFloat))}</td>
                        <td className="px-4 py-3 text-sm text-right font-semibold text-blue-600">{formatCurrency(Number(s.totalSales))}</td>
                        <td className="px-4 py-3 text-sm text-right">{s.expectedClosing != null ? formatCurrency(Number(s.expectedClosing)) : '—'}</td>
                        <td className="px-4 py-3 text-sm text-right">{s.actualClosing != null ? formatCurrency(Number(s.actualClosing)) : '—'}</td>
                        <td className={`px-4 py-3 text-sm text-right font-semibold ${s.variance == null ? 'text-gray-400' :
                          Number(s.variance) === 0 ? 'text-green-600' :
                            Number(s.variance) > 0 ? 'text-blue-600' : 'text-red-600'
                          }`}>
                          {s.variance != null ? formatCurrency(Number(s.variance)) : '—'}
                        </td>
                        <td className="px-4 py-3 text-sm text-right text-gray-600">{Number(s.movementCount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* Cash Register Movement Breakdown */}
        {reportData.reportType === 'CASH_REGISTER_MOVEMENT_BREAKDOWN' && reportData.totals && (
          <div className="space-y-6">
            {/* Totals Overview Cards */}
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-4">
              <div className="bg-white rounded-xl shadow border p-4 text-center">
                <div className="text-xl font-bold text-green-600">{formatCurrency(Number(reportData.totals.totalCashIn))}</div>
                <div className="text-xs text-gray-500 mt-1">Cash In</div>
              </div>
              <div className="bg-white rounded-xl shadow border p-4 text-center">
                <div className="text-xl font-bold text-red-600">{formatCurrency(Number(reportData.totals.totalCashOut))}</div>
                <div className="text-xs text-gray-500 mt-1">Cash Out</div>
              </div>
              <div className="bg-white rounded-xl shadow border p-4 text-center">
                <div className="text-xl font-bold text-blue-600">{formatCurrency(Number(reportData.totals.totalSales))}</div>
                <div className="text-xs text-gray-500 mt-1">Sales</div>
              </div>
              <div className="bg-white rounded-xl shadow border p-4 text-center">
                <div className="text-xl font-bold text-orange-600">{formatCurrency(Number(reportData.totals.totalRefunds))}</div>
                <div className="text-xs text-gray-500 mt-1">Refunds</div>
              </div>
              <div className="bg-white rounded-xl shadow border p-4 text-center">
                <div className={`text-xl font-bold ${Number(reportData.totals.netCashFlow) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                  {formatCurrency(Number(reportData.totals.netCashFlow))}
                </div>
                <div className="text-xs text-gray-500 mt-1">Net Cash Flow</div>
              </div>
              <div className="bg-white rounded-xl shadow border p-4 text-center">
                <div className="text-xl font-bold text-indigo-600">{reportData.totals.sessionCount}</div>
                <div className="text-xs text-gray-500 mt-1">Sessions</div>
              </div>
              <div className="bg-white rounded-xl shadow border p-4 text-center">
                <div className="text-xl font-bold text-gray-600">{reportData.totals.movementCount}</div>
                <div className="text-xs text-gray-500 mt-1">Movements</div>
              </div>
            </div>

            {/* Movement Type Breakdown */}
            {reportData.byMovementType && Object.keys(reportData.byMovementType).length > 0 && (
              <div className="bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden">
                <div className="bg-gradient-to-r from-purple-500 to-purple-600 px-6 py-4">
                  <h4 className="text-lg font-semibold text-white">📊 Breakdown by Movement Type</h4>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-full">
                    <thead className="bg-gray-100 border-b-2 border-gray-300">
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-bold text-gray-700 uppercase">Movement Type</th>
                        <th className="px-4 py-3 text-right text-xs font-bold text-gray-700 uppercase">Count</th>
                        <th className="px-4 py-3 text-right text-xs font-bold text-gray-700 uppercase">Amount</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200">
                      {Object.entries(reportData.byMovementType).map(([type, data]: [string, unknown]) => {
                        const d = data as { count: number; amount: number };
                        return (
                          <tr key={type} className="hover:bg-purple-50">
                            <td className="px-4 py-3 text-sm">
                              <span className={`px-2.5 py-0.5 rounded-full text-xs font-medium ${type.includes('IN') ? 'bg-green-100 text-green-700' :
                                type.includes('OUT') ? 'bg-red-100 text-red-700' :
                                  type === 'SALE' ? 'bg-blue-100 text-blue-700' :
                                    type === 'REFUND' ? 'bg-orange-100 text-orange-700' :
                                      'bg-gray-100 text-gray-700'
                                }`}>{type.replace(/_/g, ' ')}</span>
                            </td>
                            <td className="px-4 py-3 text-sm text-right text-gray-600">{d.count}</td>
                            <td className="px-4 py-3 text-sm text-right font-semibold">{formatCurrency(d.amount)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Daily Breakdown Table */}
            {reportData.dailyBreakdown && reportData.dailyBreakdown.length > 0 && (
              <div className="bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden">
                <div className="bg-gradient-to-r from-teal-500 to-teal-600 px-6 py-4 flex items-center justify-between">
                  <h4 className="text-lg font-semibold text-white">📅 Daily Breakdown</h4>
                  <span className="text-teal-100 text-sm">{reportData.dailyBreakdown.length} days</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-full">
                    <thead className="bg-gray-100 border-b-2 border-gray-300">
                      <tr>
                        <th className="px-3 py-3 text-left text-xs font-bold text-gray-700 uppercase">Date</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-gray-700 uppercase">Float In</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-gray-700 uppercase">Pay In</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-gray-700 uppercase">Other In</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-gray-700 uppercase">Bank Out</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-gray-700 uppercase">Expense Out</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-gray-700 uppercase">Other Out</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-gray-700 uppercase">Sales</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-gray-700 uppercase">Refunds</th>
                        <th className="px-3 py-3 text-right text-xs font-bold text-gray-700 uppercase">Net Flow</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200">
                      {reportData.dailyBreakdown.map((day: Record<string, unknown>, idx: number) => (
                        <tr key={idx} className="hover:bg-teal-50">
                          <td className="px-3 py-3 text-sm font-medium text-gray-900">{String(day.date)}</td>
                          <td className="px-3 py-3 text-sm text-right text-green-600">{formatCurrency(Number(day.cashInFloat))}</td>
                          <td className="px-3 py-3 text-sm text-right text-green-600">{formatCurrency(Number(day.cashInPayment))}</td>
                          <td className="px-3 py-3 text-sm text-right text-green-600">{formatCurrency(Number(day.cashInOther))}</td>
                          <td className="px-3 py-3 text-sm text-right text-red-600">{formatCurrency(Number(day.cashOutBank))}</td>
                          <td className="px-3 py-3 text-sm text-right text-red-600">{formatCurrency(Number(day.cashOutExpense))}</td>
                          <td className="px-3 py-3 text-sm text-right text-red-600">{formatCurrency(Number(day.cashOutOther))}</td>
                          <td className="px-3 py-3 text-sm text-right font-semibold text-blue-600">{formatCurrency(Number(day.sales))}</td>
                          <td className="px-3 py-3 text-sm text-right text-orange-600">{formatCurrency(Number(day.refunds))}</td>
                          <td className={`px-3 py-3 text-sm text-right font-bold ${Number(day.netFlow) >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                            {formatCurrency(Number(day.netFlow))}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Standard Data Table — skip dedicated SSOT renderers */}
        {!isSsotReportType(reportData.reportType) &&
          reportData.data &&
          reportData.data.length > 0 && (
            <div className="bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden">
              <div className="bg-gradient-to-r from-green-500 to-green-600 px-4 sm:px-6 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                <h4 className="text-base sm:text-lg font-semibold text-white">📋 Detailed Data</h4>
                <span className="text-green-100 text-xs sm:text-sm">{reportData.data.length} rows</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-full">
                  <thead className="bg-gray-100 border-b-2 border-gray-300">
                    <tr>
                      {Object.keys(reportData.data[0])
                        .filter(header => {
                          // Skip UUID fields if we have readable ID alternatives
                          if (header === 'customerId' && reportData.data[0].customerNumber) return false;
                          if (header === 'customer_id' && reportData.data[0].customer_name) return false;
                          if (header === 'supplierId' && reportData.data[0].supplierNumber) return false;
                          if (header === 'supplier_id' && reportData.data[0].supplier_name) return false;
                          if (header === 'goodsReceiptId' && reportData.data[0].goodsReceiptNumber) return false;
                          if (header === 'saleId' && reportData.data[0].saleNumber) return false;
                          if (header === 'sale_id' && reportData.data[0].sale_number) return false;
                          if (header === 'productId' && reportData.data[0].productName) return false;
                          if (header === 'product_id' && (reportData.data[0].product_name || reportData.data[0].productName)) return false;
                          if (header === 'batchId' && reportData.data[0].batchNumber) return false;
                          if (header === 'batch_id' && reportData.data[0].batch_number) return false;
                          if (header === 'movementId') return false; // Stock movement IDs are internal
                          if (header === 'movement_id') return false; // Stock movement IDs are internal
                          if (header === 'id' && (reportData.data[0].orderNumber || reportData.data[0].poNumber)) return false;
                          return true;
                        })
                        .map((header) => (
                          <th
                            key={header}
                            className="px-3 sm:px-6 py-3 sm:py-4 text-left text-xs font-bold text-gray-700 uppercase tracking-wider whitespace-nowrap"
                          >
                            {header.replace(/([A-Z])/g, ' $1').trim().replace(/^\w/, c => c.toUpperCase())}
                          </th>
                        ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200">
                    {reportData.data.slice(0, 100).map((row: Record<string, unknown>, idx: number) => (
                      <tr key={idx} className="hover:bg-blue-50 transition-colors">
                        {Object.entries(row)
                          .filter(([key]) => {
                            // Skip UUID fields if we have readable ID alternatives
                            if (key === 'customerId' && row.customerNumber) return false;
                            if (key === 'customer_id' && row.customer_name) return false;
                            if (key === 'supplierId' && row.supplierNumber) return false;
                            if (key === 'supplier_id' && row.supplier_name) return false;
                            if (key === 'goodsReceiptId' && row.goodsReceiptNumber) return false;
                            if (key === 'saleId' && row.saleNumber) return false;
                            if (key === 'sale_id' && row.sale_number) return false;
                            if (key === 'productId' && row.productName) return false;
                            if (key === 'product_id' && (row.product_name || row.productName)) return false;
                            if (key === 'batchId' && row.batchNumber) return false;
                            if (key === 'batch_id' && row.batch_number) return false;
                            if (key === 'movementId') return false; // Stock movement IDs are internal
                            if (key === 'movement_id') return false; // Stock movement IDs are internal
                            if (key === 'id' && (row.orderNumber || row.poNumber)) return false;
                            return true;
                          })
                          .map(([key, value], colIdx) => {
                            // Special formatting for specific field types
                            const isNumber = key === 'customerNumber' || key === 'supplierNumber';
                            const isReadableId = key.toLowerCase().includes('number') && typeof value === 'string';

                            return (
                              <td key={colIdx} className="px-3 sm:px-6 py-3 sm:py-4 text-xs sm:text-sm whitespace-nowrap">
                                {isNumber ? (
                                  <span className="font-bold text-blue-600 bg-blue-50 px-2 py-1 rounded text-xs sm:text-sm">
                                    {String(value || '-')}
                                  </span>
                                ) : isReadableId ? (
                                  <span className="font-semibold text-indigo-600">
                                    {String(value || '-')}
                                  </span>
                                ) : (
                                  <span className={`font-semibold ${getFieldColorClass(key, value)}`}>
                                    {formatFieldValue(key, value)}
                                  </span>
                                )}
                              </td>
                            );
                          })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {reportData.data.length > 100 && (
                <div className="bg-yellow-50 border-t border-yellow-200 p-4 text-center">
                  <p className="text-sm text-yellow-800 font-medium">
                    ⚠️ Showing first 100 of {reportData.data.length} records. Export to CSV or PDF to see all data.
                  </p>
                </div>
              )}
            </div>
        )}

        {/* Supplier Payment Records Detail */}
        {reportData.reportType === 'SUPPLIER_PAYMENT_STATUS' && reportData.payments && reportData.payments.length > 0 && (
          <div className="bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden">
            <div className="bg-gradient-to-r from-orange-500 to-orange-600 px-4 sm:px-6 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
              <h4 className="text-base sm:text-lg font-semibold text-white">💳 Individual Payment Records</h4>
              <span className="text-orange-100 text-xs sm:text-sm">{reportData.payments.length} payments</span>
            </div>

            {/* Mobile Card View */}
            <div className="block sm:hidden p-4 space-y-4">
              {reportData.payments.map((payment, idx) => (
                <div key={idx} className="border border-gray-200 rounded-lg p-4 bg-gradient-to-r from-gray-50 to-white">
                  <div className="flex justify-between items-start mb-3">
                    <div>
                      <span className="font-bold text-indigo-600 text-sm">{payment.paymentNumber}</span>
                      <p className="text-xs text-gray-500 mt-1">{formatDisplayDate(payment.paymentDate)}</p>
                    </div>
                    <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${payment.status === 'COMPLETED' ? 'bg-green-100 text-green-800' :
                      payment.status === 'PENDING' ? 'bg-yellow-100 text-yellow-800' :
                        'bg-gray-100 text-gray-800'
                      }`}>{payment.status}</span>
                  </div>
                  <p className="text-sm font-medium text-gray-900 mb-2">{payment.supplierName}</p>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">Amount</div>
                      <div className="text-sm font-bold text-green-600">{formatCurrency(payment.amount || 0)}</div>
                    </div>
                    <div>
                      <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">Method</div>
                      <div className="text-sm font-semibold text-gray-900">{payment.paymentMethod}</div>
                    </div>
                    {payment.reference && (
                      <div className="col-span-2">
                        <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">Reference</div>
                        <div className="text-sm text-gray-700">{payment.reference}</div>
                      </div>
                    )}
                  </div>
                  {payment.allocations && payment.allocations.length > 0 && (
                    <div className="mt-3 pt-3 border-t border-gray-200">
                      <div className="text-xs text-gray-500 uppercase tracking-wide mb-2">Allocations</div>
                      {payment.allocations.map((alloc, aIdx) => (
                        <div key={aIdx} className="flex justify-between text-xs text-gray-600">
                          <span>{alloc.invoiceNumber}</span>
                          <span className="font-medium">{formatCurrency(alloc.amountAllocated || 0)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Desktop Table View */}
            <div className="hidden sm:block overflow-x-auto">
              <table className="w-full min-w-full">
                <thead className="bg-gray-100 border-b-2 border-gray-300">
                  <tr>
                    <th className="px-3 sm:px-6 py-3 sm:py-4 text-left text-xs font-bold text-gray-700 uppercase tracking-wider">Payment #</th>
                    <th className="px-3 sm:px-6 py-3 sm:py-4 text-left text-xs font-bold text-gray-700 uppercase tracking-wider">Supplier</th>
                    <th className="px-3 sm:px-6 py-3 sm:py-4 text-left text-xs font-bold text-gray-700 uppercase tracking-wider">Date</th>
                    <th className="px-3 sm:px-6 py-3 sm:py-4 text-right text-xs font-bold text-gray-700 uppercase tracking-wider">Amount</th>
                    <th className="px-3 sm:px-6 py-3 sm:py-4 text-left text-xs font-bold text-gray-700 uppercase tracking-wider">Method</th>
                    <th className="px-3 sm:px-6 py-3 sm:py-4 text-left text-xs font-bold text-gray-700 uppercase tracking-wider">Status</th>
                    <th className="px-3 sm:px-6 py-3 sm:py-4 text-left text-xs font-bold text-gray-700 uppercase tracking-wider">Reference</th>
                    <th className="px-3 sm:px-6 py-3 sm:py-4 text-left text-xs font-bold text-gray-700 uppercase tracking-wider">Allocations</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {reportData.payments.map((payment, idx) => (
                    <tr key={idx} className="hover:bg-blue-50 transition-colors">
                      <td className="px-3 sm:px-6 py-3 sm:py-4 text-xs sm:text-sm">
                        <span className="font-bold text-indigo-600">{payment.paymentNumber}</span>
                      </td>
                      <td className="px-3 sm:px-6 py-3 sm:py-4 text-xs sm:text-sm font-medium text-gray-900">{payment.supplierName}</td>
                      <td className="px-3 sm:px-6 py-3 sm:py-4 text-xs sm:text-sm text-gray-600">{formatDisplayDate(payment.paymentDate)}</td>
                      <td className="px-3 sm:px-6 py-3 sm:py-4 text-xs sm:text-sm text-right font-bold text-green-600">{formatCurrency(payment.amount || 0)}</td>
                      <td className="px-3 sm:px-6 py-3 sm:py-4 text-xs sm:text-sm text-gray-700">{payment.paymentMethod}</td>
                      <td className="px-3 sm:px-6 py-3 sm:py-4 text-xs sm:text-sm">
                        <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${payment.status === 'COMPLETED' ? 'bg-green-100 text-green-800' :
                          payment.status === 'PENDING' ? 'bg-yellow-100 text-yellow-800' :
                            'bg-gray-100 text-gray-800'
                          }`}>{payment.status}</span>
                      </td>
                      <td className="px-3 sm:px-6 py-3 sm:py-4 text-xs sm:text-sm text-gray-600">{payment.reference || '-'}</td>
                      <td className="px-3 sm:px-6 py-3 sm:py-4 text-xs sm:text-sm">
                        {payment.allocations && payment.allocations.length > 0 ? (
                          <div className="space-y-1">
                            {payment.allocations.map((alloc, aIdx) => (
                              <div key={aIdx} className="flex justify-between gap-2 text-xs">
                                <span className="text-blue-600">{alloc.invoiceNumber}</span>
                                <span className="font-medium text-gray-700">{formatCurrency(alloc.amountAllocated || 0)}</span>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <span className="text-gray-400">-</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ═══════════ SALES BY CASHIER — line-level accountability ═══════════ */}
        {reportData.reportType === 'SALES_BY_CASHIER' && (
          <div className="space-y-4">
            {/* Summary cards */}
            {reportData.summary && (
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
                {[
                  { label: 'Line Items', value: String(reportData.summary.totalLines ?? 0), color: 'text-blue-600' },
                  { label: 'Sales', value: String(reportData.summary.totalSales ?? 0), color: 'text-indigo-600' },
                  { label: 'Total Amount', value: formatCurrency(Number(reportData.summary.totalAmount ?? 0)), color: 'text-green-600' },
                  { label: 'Cashiers', value: String(reportData.summary.uniqueCashiers ?? 0), color: 'text-purple-600' },
                  { label: 'Ordered By', value: String(reportData.summary.uniqueOrderedBy ?? 0), color: 'text-orange-600' },
                ].map(({ label, value, color }) => (
                  <div key={label} className="bg-white rounded-xl shadow border border-gray-200 p-4 text-center">
                    <div className={`text-xl font-bold ${color}`}>{value}</div>
                    <div className="text-xs text-gray-500 mt-1">{label}</div>
                  </div>
                ))}
              </div>
            )}

            {/* Detail table */}
            <div className="bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden">
              <div className="bg-gradient-to-r from-blue-600 to-blue-700 px-4 sm:px-6 py-3 flex items-center justify-between">
                <h4 className="text-base sm:text-lg font-semibold text-white">👤 Sales by Cashier — Detail</h4>
                <span className="text-blue-100 text-xs sm:text-sm">{(reportData.data || []).length} line items</span>
              </div>
              {(!reportData.data || reportData.data.length === 0) ? (
                <div className="p-8 text-center text-gray-500">No sales found for the selected filters.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-full">
                    <thead className="bg-gray-100 border-b-2 border-gray-300">
                      <tr>
                        {['Sale #', 'Date & Time', 'Product', 'Qty', 'Amount', 'Ordered By', 'Cashier', 'Payment'].map(h => (
                          <th key={h} className="px-3 py-3 text-left text-xs font-bold text-gray-700 uppercase whitespace-nowrap">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200">
                      {(reportData.data as Record<string, unknown>[]).map((row, idx) => (
                        <tr key={idx} className="hover:bg-blue-50 transition-colors">
                          <td className="px-3 py-2 text-xs font-mono font-semibold text-indigo-700 whitespace-nowrap">{String(row.sale_number ?? '')}</td>
                          <td className="px-3 py-2 text-xs text-gray-600 whitespace-nowrap">{formatTimestamp(String(row.sale_date ?? ''))}</td>
                          <td className="px-3 py-2 text-xs text-gray-900">{String(row.product_name ?? '')}</td>
                          <td className="px-3 py-2 text-xs text-right text-gray-700">{Number(row.quantity).toLocaleString()}</td>
                          <td className="px-3 py-2 text-xs text-right font-semibold text-green-700 whitespace-nowrap">{formatCurrency(Number(row.amount ?? 0))}</td>
                          <td className="px-3 py-2 text-xs text-gray-700 whitespace-nowrap">{String(row.ordered_by ?? '')}</td>
                          <td className="px-3 py-2 text-xs text-gray-700 whitespace-nowrap">{String(row.cashier ?? '')}</td>
                          <td className="px-3 py-2 text-xs whitespace-nowrap">
                            <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-700">
                              {String(row.payment_method ?? '')}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    {reportData.data.length > 0 && (
                      <tfoot className="bg-gray-50 border-t-2 border-gray-300">
                        <tr className="font-bold">
                          <td colSpan={4} className="px-3 py-2 text-xs text-gray-700 uppercase">Total</td>
                          <td className="px-3 py-2 text-xs text-right text-green-700 whitespace-nowrap">
                            {formatCurrency(Number(reportData.summary?.totalAmount ?? 0))}
                          </td>
                          <td colSpan={3} />
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ═══════════ PROFIT & LOSS STATEMENT ═══════════ */}
        {reportData.reportType === 'PROFIT_LOSS' && reportData.summary && (
          <div className="space-y-6">
            {/* ── Income Statement ── */}
            <div className="bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden">
              <div className="bg-gradient-to-r from-indigo-700 to-indigo-900 px-4 sm:px-6 py-4">
                <h4 className="text-lg sm:text-xl font-bold text-white tracking-wide">Income Statement (P&L)</h4>
                <p className="text-indigo-200 text-xs mt-1">Financial Report • {reportData.parameters?.startDate} to {reportData.parameters?.endDate}</p>
              </div>

              <div className="divide-y divide-gray-100">
                {/* Section 1: Revenue */}
                <div className="px-4 sm:px-6 py-3 bg-blue-50/50">
                  <div className="flex justify-between items-center">
                    <span className="text-sm font-bold text-gray-800 uppercase tracking-wider">Revenue (Sales)</span>
                    <span className="text-lg sm:text-xl font-bold text-blue-700">{formatCurrency(reportData.summary.totalRevenue ?? 0)}</span>
                  </div>
                </div>

                {/* Section 2: COGS */}
                <div className="px-4 sm:px-6 py-3">
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-gray-600">Less: Cost of Goods Sold (COGS)</span>
                    <span className="text-sm font-semibold text-red-600">({formatCurrency(reportData.summary.totalCOGS ?? 0)})</span>
                  </div>
                </div>

                {/* Gross Profit Line */}
                <div className="px-4 sm:px-6 py-3 bg-green-50 border-t-2 border-green-200">
                  <div className="flex justify-between items-center">
                    <span className="text-sm font-bold text-green-800 uppercase tracking-wider">Gross Profit</span>
                    <div className="text-right">
                      <span className={`text-lg sm:text-xl font-bold ${(reportData.summary.grossProfit ?? 0) >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                        {formatCurrency(reportData.summary.grossProfit ?? 0)}
                      </span>
                      <span className="block text-xs text-green-600 font-medium">
                        Margin: {(reportData.summary.grossProfitMargin ?? 0).toFixed(2)}%
                      </span>
                    </div>
                  </div>
                </div>

                {/* Section 3: Operating Expenses */}
                <div className="px-4 sm:px-6 py-3">
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-gray-600">Less: Operating Expenses</span>
                    <span className="text-sm font-semibold text-red-600">({formatCurrency(reportData.summary.totalExpenses ?? 0)})</span>
                  </div>
                </div>

                {/* Expense Breakdown (if available) */}
                {reportData.expenseBreakdown && (reportData.expenseBreakdown as Array<{ accountCode: string; accountName: string; entryCount: number; totalAmount: number }>).length > 0 && (
                  <div className="px-6 sm:px-10 py-2 bg-gray-50/50">
                    {(reportData.expenseBreakdown as Array<{ accountCode: string; accountName: string; entryCount: number; totalAmount: number }>).map((exp, idx) => (
                      <div key={idx} className="flex justify-between items-center py-1">
                        <span className="text-xs text-gray-500">{exp.accountCode} — {exp.accountName}</span>
                        <span className="text-xs font-medium text-gray-700">{formatCurrency(exp.totalAmount)}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Operating Profit / EBIT */}
                <div className="px-4 sm:px-6 py-3 bg-amber-50 border-t-2 border-amber-200">
                  <div className="flex justify-between items-center">
                    <span className="text-sm font-bold text-amber-800 uppercase tracking-wider">Operating Profit (EBIT)</span>
                    <span className={`text-lg sm:text-xl font-bold ${(reportData.summary.operatingProfit ?? 0) >= 0 ? 'text-amber-700' : 'text-red-700'}`}>
                      {formatCurrency(reportData.summary.operatingProfit ?? 0)}
                    </span>
                  </div>
                </div>

                {/* Net Profit */}
                <div className="px-4 sm:px-6 py-4 bg-gradient-to-r from-indigo-50 to-purple-50 border-t-2 border-indigo-300">
                  <div className="flex justify-between items-center">
                    <span className="text-base font-bold text-indigo-900 uppercase tracking-wider">Net Profit</span>
                    <div className="text-right">
                      <span className={`text-xl sm:text-2xl font-bold ${(reportData.summary.netProfit ?? 0) >= 0 ? 'text-indigo-700' : 'text-red-700'}`}>
                        {formatCurrency(reportData.summary.netProfit ?? 0)}
                      </span>
                      <span className="block text-xs text-indigo-500 font-medium">
                        Net Margin: {(reportData.summary.netProfitMargin ?? 0).toFixed(2)}%
                      </span>
                    </div>
                  </div>
                </div>

                {/* Supplementary: Payments to Vendors (non-P&L) */}
                {(reportData.summary.totalSupplierPayments ?? 0) > 0 && (
                  <div className="px-4 sm:px-6 py-3 bg-gray-50 border-t border-dashed border-gray-300">
                    <div className="flex justify-between items-center">
                      <div>
                        <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Memo: Payments to Vendors</span>
                        <span className="block text-[10px] text-gray-400">Cash disbursements (non-P&L)</span>
                      </div>
                      <div className="text-right">
                        <span className="text-sm font-bold text-orange-600">{formatCurrency(reportData.summary.totalSupplierPayments ?? 0)}</span>
                        <span className="block text-[10px] text-gray-400">{reportData.summary.supplierPaymentCount ?? 0} payments</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* ── Period Detail Table ── */}
            {reportData.data && reportData.data.length > 0 && (
              <div className="bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden">
                <div className="bg-gradient-to-r from-indigo-600 to-indigo-700 px-4 sm:px-6 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                  <h4 className="text-base sm:text-lg font-semibold text-white">📊 Period Breakdown</h4>
                  <span className="text-indigo-200 text-xs sm:text-sm">{reportData.data.length} periods</span>
                </div>

                {/* Mobile Card View */}
                <div className="block sm:hidden p-4 space-y-4">
                  {reportData.data.map((row: Record<string, unknown>, idx: number) => (
                    <div key={idx} className="border border-gray-200 rounded-lg p-4 bg-gradient-to-r from-gray-50 to-white">
                      <div className="text-sm font-bold text-indigo-700 mb-3 pb-2 border-b border-indigo-100">
                        {String(row.period ?? '')}
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <div className="text-[10px] text-gray-500 uppercase tracking-wide mb-1">Revenue</div>
                          <div className="text-sm font-bold text-blue-600">{formatCurrency(Number(row.revenue ?? 0))}</div>
                        </div>
                        <div>
                          <div className="text-[10px] text-gray-500 uppercase tracking-wide mb-1">COGS</div>
                          <div className="text-sm font-semibold text-red-500">{formatCurrency(Number(row.costOfGoodsSold ?? 0))}</div>
                        </div>
                        <div>
                          <div className="text-[10px] text-gray-500 uppercase tracking-wide mb-1">Gross Profit</div>
                          <div className={`text-sm font-bold ${Number(row.grossProfit ?? 0) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                            {formatCurrency(Number(row.grossProfit ?? 0))}
                          </div>
                        </div>
                        <div>
                          <div className="text-[10px] text-gray-500 uppercase tracking-wide mb-1">Margin</div>
                          <div className="text-sm font-bold text-indigo-600">{Number(row.grossProfitMargin ?? 0).toFixed(2)}%</div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Desktop Table View */}
                <div className="hidden sm:block overflow-x-auto">
                  <table className="w-full min-w-full">
                    <thead className="bg-gray-100 border-b-2 border-gray-300">
                      <tr>
                        <th className="px-6 py-3 text-left text-xs font-bold text-gray-700 uppercase tracking-wider">Period</th>
                        <th className="px-6 py-3 text-right text-xs font-bold text-gray-700 uppercase tracking-wider">Revenue</th>
                        <th className="px-6 py-3 text-right text-xs font-bold text-gray-700 uppercase tracking-wider">COGS</th>
                        <th className="px-6 py-3 text-right text-xs font-bold text-gray-700 uppercase tracking-wider">Gross Profit</th>
                        <th className="px-6 py-3 text-right text-xs font-bold text-gray-700 uppercase tracking-wider">Margin %</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200">
                      {reportData.data.map((row: Record<string, unknown>, idx: number) => (
                        <tr key={idx} className="hover:bg-indigo-50/40 transition-colors">
                          <td className="px-6 py-3 text-sm font-medium text-gray-900">{String(row.period ?? '')}</td>
                          <td className="px-6 py-3 text-sm text-right font-semibold text-blue-700">{formatCurrency(Number(row.revenue ?? 0))}</td>
                          <td className="px-6 py-3 text-sm text-right text-red-600">{formatCurrency(Number(row.costOfGoodsSold ?? 0))}</td>
                          <td className={`px-6 py-3 text-sm text-right font-bold ${Number(row.grossProfit ?? 0) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                            {formatCurrency(Number(row.grossProfit ?? 0))}
                          </td>
                          <td className="px-6 py-3 text-sm text-right font-bold text-indigo-600">{Number(row.grossProfitMargin ?? 0).toFixed(2)}%</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="bg-indigo-50 border-t-2 border-indigo-300">
                      <tr>
                        <td className="px-6 py-3 text-sm font-bold text-gray-900 uppercase">Total</td>
                        <td className="px-6 py-3 text-sm text-right font-bold text-blue-700">{formatCurrency(reportData.summary.totalRevenue ?? 0)}</td>
                        <td className="px-6 py-3 text-sm text-right font-bold text-red-600">{formatCurrency(reportData.summary.totalCOGS ?? 0)}</td>
                        <td className={`px-6 py-3 text-sm text-right font-bold ${(reportData.summary.grossProfit ?? 0) >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                          {formatCurrency(reportData.summary.grossProfit ?? 0)}
                        </td>
                        <td className="px-6 py-3 text-sm text-right font-bold text-indigo-700">{(reportData.summary.grossProfitMargin ?? 0).toFixed(2)}%</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Export Buttons - Enhanced */}
        <div className="flex flex-wrap gap-4">
          <button
            onClick={handleExportPDF}
            className="flex items-center gap-2 px-6 py-3 bg-gradient-to-r from-red-600 to-red-700 text-white font-semibold rounded-lg hover:from-red-700 hover:to-red-800 focus:outline-none focus:ring-4 focus:ring-red-300 shadow-lg hover:shadow-xl transition-all"
          >
            <span className="text-xl">📄</span>
            Export PDF
          </button>
          <button
            onClick={handleExportCSV}
            className="flex items-center gap-2 px-6 py-3 bg-gradient-to-r from-green-600 to-green-700 text-white font-semibold rounded-lg hover:from-green-700 hover:to-green-800 focus:outline-none focus:ring-4 focus:ring-green-300 shadow-lg hover:shadow-xl transition-all"
          >
            <span className="text-xl">📊</span>
            Export CSV
          </button>
          <button
            onClick={() => {
              setReportData(null);
              setSelectedReport(null);
            }}
            className="flex items-center gap-2 px-6 py-3 bg-gradient-to-r from-gray-600 to-gray-700 text-white font-semibold rounded-lg hover:from-gray-700 hover:to-gray-800 focus:outline-none focus:ring-4 focus:ring-gray-300 shadow-lg hover:shadow-xl transition-all"
          >
            <span className="text-xl">🔄</span>
            New Report
          </button>
        </div>
      </div>
    );
  };

  // Group reports by category
  const groupedReports = REPORT_OPTIONS.reduce((acc, report) => {
    if (!acc[report.category]) {
      acc[report.category] = [];
    }
    acc[report.category].push(report);
    return acc;
  }, {} as Record<string, ReportOption[]>);

  const categoryColors = {
    Sales: 'from-blue-500 to-blue-600',
    Inventory: 'from-green-500 to-green-600',
    Financial: 'from-purple-500 to-purple-600',
    Customer: 'from-orange-500 to-orange-600',
    Supplier: 'from-indigo-500 to-indigo-600',
  };

  return (
    <Layout>
      <div className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100">
        <div className="container mx-auto px-3 sm:px-4 lg:px-6 py-4 sm:py-6 lg:py-8 max-w-7xl">
          {/* Header — title full-width on small screens; shortcut chips wrap below */}
          <div className="mb-6 sm:mb-8 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0 w-full lg:flex-1">
              <h1 className="text-2xl sm:text-3xl lg:text-4xl font-bold text-gray-900 mb-2">
                Reports & Analytics
              </h1>
              <p className="text-sm sm:text-base text-gray-600 max-w-2xl">
                Generate comprehensive reports across sales, inventory, and financial metrics
              </p>
            </div>
            <div
              className="flex w-full flex-wrap gap-2 lg:w-auto lg:max-w-xl lg:justify-end"
              data-reports-shortcuts="true"
            >
              <Link to="/reports/business-performance">
                <button
                  type="button"
                  className="bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-2 sm:px-4 rounded-lg shadow-md hover:shadow-lg transition-all flex items-center gap-2 text-sm min-h-[var(--layout-touch-target)]"
                >
                  Business Performance
                </button>
              </Link>
              <Link to="/reports/expenses">
                <button
                  type="button"
                  className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-2 sm:px-4 rounded-lg shadow-md hover:shadow-lg transition-all flex items-center gap-2 text-sm min-h-[var(--layout-touch-target)]"
                >
                  Expense Reports
                </button>
              </Link>
              <Link to="/reports/tax-compliance">
                <button
                  type="button"
                  className="bg-slate-700 hover:bg-slate-800 text-white px-3 py-2 sm:px-4 rounded-lg shadow-md hover:shadow-lg transition-all flex items-center gap-2 text-sm min-h-[var(--layout-touch-target)]"
                >
                  Tax Compliance
                </button>
              </Link>
              <Link to="/reports/liquidity-movements">
                <button
                  type="button"
                  className="bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-2 sm:px-4 rounded-lg shadow-md hover:shadow-lg transition-all flex items-center gap-2 text-sm min-h-[var(--layout-touch-target)]"
                >
                  Liquidity Movements
                </button>
              </Link>
            </div>
          </div>

          {/* Report Selection - Categorized Cards */}
          {!selectedReport && (
            <div className="space-y-6 sm:space-y-8">
              {Object.entries(groupedReports).map(([category, reports]) => (
                <div key={category} className="space-y-3 sm:space-y-4">
                  {/* Category Header */}
                  <div className={`inline-flex items-center gap-2 px-3 sm:px-4 py-1.5 sm:py-2 rounded-full bg-gradient-to-r ${categoryColors[category as keyof typeof categoryColors]} text-white font-semibold shadow-lg text-sm sm:text-base`}>
                    <span className="text-base sm:text-lg">{category}</span>
                    <span className="text-xs sm:text-sm opacity-90">({reports.length})</span>
                  </div>

                  {/* Report Cards Grid */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
                    {reports.map((option) => (
                      <button
                        key={option.value}
                        onClick={() => {
                          if (option.value === 'TAX_COMPLIANCE') {
                            navigate('/reports/tax-compliance');
                            return;
                          }
                          if (option.value === 'LIQUIDITY_MOVEMENTS') {
                            navigate('/reports/liquidity-movements');
                            return;
                          }
                          if (option.value === 'SALES_REPORT') {
                            navigate('/reports/sales-analysis');
                            return;
                          }
                          if (option.value === 'REORDER_RECOMMENDATIONS') {
                            navigate('/reports/reorder');
                            return;
                          }
                          setSelectedReport(option.value);
                        }}
                        className="group relative bg-white p-4 sm:p-6 rounded-xl border-2 border-gray-200 hover:border-blue-400 hover:shadow-xl transition-all duration-200 text-left"
                      >
                        {/* Icon Badge */}
                        <div className="absolute -top-2 sm:-top-3 -right-2 sm:-right-3 w-10 h-10 sm:w-12 sm:h-12 bg-gradient-to-br from-blue-500 to-blue-600 rounded-full flex items-center justify-center text-xl sm:text-2xl shadow-lg group-hover:scale-110 transition-transform">
                          {option.icon}
                        </div>

                        <div className="pr-6 sm:pr-8">
                          <h3 className="font-bold text-gray-900 mb-1 sm:mb-2 text-base sm:text-lg group-hover:text-blue-600 transition-colors">
                            {option.label}
                          </h3>
                          <p className="text-xs sm:text-sm text-gray-600 mb-2 sm:mb-3 line-clamp-2">
                            {option.description}
                          </p>

                          {/* Badges */}
                          <div className="flex flex-wrap gap-1.5 sm:gap-2">
                            {option.requiresDateRange && (
                              <span className="inline-flex items-center text-xs bg-blue-100 text-blue-700 px-2 py-0.5 sm:py-1 rounded-full font-medium">
                                📅 Date Range
                              </span>
                            )}
                            {option.supportsFilters.length > 0 && (
                              <span className="inline-flex items-center text-xs bg-green-100 text-green-700 px-2 py-0.5 sm:py-1 rounded-full font-medium">
                                🎯 {option.supportsFilters.length} Filters
                              </span>
                            )}
                          </div>
                        </div>

                        {/* Hover Arrow */}
                        <div className="absolute bottom-3 sm:bottom-4 right-3 sm:right-4 text-blue-500 opacity-0 group-hover:opacity-100 transition-opacity">
                          →
                        </div>
                      </button>
                    ))}

                    {/* Inventory module reports — canonical paths under /reports/inventory/* */}
                    {category === 'Inventory' && (
                      <>
                        {[
                          ...INVENTORY_NETWORK_REPORTS,
                          ...INVENTORY_LEDGER_REPORTS,
                          ...INVENTORY_OPERATIONAL_REPORTS,
                        ].map((card) => {
                          const badgeColor =
                            card.badge === 'Finance'
                              ? 'bg-blue-100 text-blue-700'
                              : card.badge === 'Accounting'
                                ? 'bg-purple-100 text-purple-700'
                                : card.badge === 'Commercial'
                                  ? 'bg-indigo-100 text-indigo-700'
                                  : card.badge === 'Multistore'
                                    ? 'bg-violet-100 text-violet-700'
                                    : card.badge === 'Cross-Module'
                                      ? 'bg-indigo-100 text-indigo-700'
                                      : 'bg-emerald-100 text-emerald-700';
                          const borderAccent =
                            card.id === 'network'
                              ? 'border-violet-200 hover:border-violet-400'
                              : card.id === 'category-intelligence'
                                ? 'border-indigo-200 hover:border-indigo-400'
                                : 'border-emerald-200 hover:border-emerald-400';
                          const gradientAccent =
                            card.id === 'network'
                              ? 'from-violet-500 to-indigo-600'
                              : card.id === 'category-intelligence'
                                ? 'from-indigo-500 to-violet-600'
                                : 'from-emerald-500 to-teal-600';
                          return (
                            <Link
                              key={card.path}
                              to={card.path}
                              className={`group relative bg-white p-4 sm:p-6 rounded-xl border-2 ${borderAccent} hover:shadow-xl transition-all duration-200 text-left block`}
                            >
                              <div
                                className={`absolute -top-2 sm:-top-3 -right-2 sm:-right-3 w-10 h-10 sm:w-12 sm:h-12 bg-gradient-to-br ${gradientAccent} rounded-full flex items-center justify-center text-xl sm:text-2xl shadow-lg group-hover:scale-110 transition-transform`}
                              >
                                {card.icon}
                              </div>
                              <div className="pr-6 sm:pr-8">
                                <h3 className="font-bold text-gray-900 mb-1 sm:mb-2 text-base sm:text-lg group-hover:text-emerald-700 transition-colors">
                                  {card.title}
                                </h3>
                                <p className="text-xs sm:text-sm text-gray-600 mb-2 sm:mb-3 line-clamp-2">
                                  {card.description}
                                </p>
                                <div className="flex flex-wrap gap-1.5">
                                  {card.badge && (
                                    <span
                                      className={`inline-flex items-center text-xs px-2 py-0.5 rounded-full font-medium ${badgeColor}`}
                                    >
                                      {card.badge}
                                    </span>
                                  )}
                                  {card.multistoreOnly && (
                                    <span className="inline-flex items-center text-xs bg-violet-50 text-violet-700 px-2 py-0.5 rounded-full font-medium">
                                      Multistore
                                    </span>
                                  )}
                                </div>
                              </div>
                              <div className="absolute bottom-3 sm:bottom-4 right-3 sm:right-4 text-emerald-500 opacity-0 group-hover:opacity-100 transition-opacity">
                                →
                              </div>
                            </Link>
                          );
                        })}
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Selected Report Configuration */}
          {selectedReport && !reportData && (
            <form
              className="space-y-4 sm:space-y-6"
              onSubmit={(e) => {
                e.preventDefault();
                if (!isLoading) handleGenerateReport();
              }}
            >
              {/* Back Button & Report Title */}
              <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4 mb-4 sm:mb-6">
                <ReportBackLink
                  onClick={() => {
                    setSelectedReport(null);
                    setError(null);
                  }}
                />
                <div className="flex-1">
                  <h2 className="text-2xl font-bold text-gray-900">
                    {selectedReportOption?.icon} {selectedReportOption?.label}
                  </h2>
                  <p className="text-gray-600 text-sm">{selectedReportOption?.description}</p>
                </div>
              </div>

              {/* Filter Card */}
              <div className="bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden">
                <div className="bg-gradient-to-r from-blue-500 to-blue-600 px-6 py-4">
                  <h3 className="text-xl font-semibold text-white">⚙️ Report Parameters</h3>
                </div>
                <div className="p-6">
                  {renderFilterOptions()}
                </div>
              </div>

              {/* Generate Button */}
              <div className="flex gap-4">
                <button
                  type="submit"
                  disabled={isLoading}
                  className="flex-1 flex items-center justify-center gap-3 px-8 py-4 bg-gradient-to-r from-blue-600 to-blue-700 text-white text-lg font-semibold rounded-xl hover:from-blue-700 hover:to-blue-800 focus:outline-none focus:ring-4 focus:ring-blue-300 disabled:opacity-50 disabled:cursor-not-allowed shadow-lg hover:shadow-xl transition-all"
                >
                  {isLoading ? (
                    <>
                      <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                      Generating Report...
                    </>
                  ) : (
                    <>
                      🚀 Generate Report
                    </>
                  )}
                </button>
              </div>

              {/* Error Message */}
              {error && (
                <div className="bg-red-50 border-l-4 border-red-500 p-4 rounded-lg">
                  <div className="flex items-center gap-2">
                    <span className="text-red-500 text-xl">⚠️</span>
                    <div>
                      <p className="font-semibold text-red-800">Error</p>
                      <p className="text-sm text-red-700">{error}</p>
                    </div>
                  </div>
                </div>
              )}
            </form>
          )}

          {/* Report Results */}
          {reportData && (
            <div className="space-y-6">
              <ReportBackLink
                onClick={() => {
                  setReportData(null);
                  setSelectedReport(null);
                  setError(null);
                }}
              />

              {renderReportData()}
            </div>
          )}
        </div>
      </div>
    </Layout>
  );
}


