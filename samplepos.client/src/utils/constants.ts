/**
 * System Constants
 * 
 * All magic numbers and configuration constants centralized here.
 * Based on SamplePOS business rules and operational requirements.
 */

import Decimal from 'decimal.js';

/**
 * Business Rule Codes
 */
export const BUSINESS_RULES = {
  // Inventory Rules (BR-INV)
  INV_001: 'BR-INV-001', // Sufficient stock before sale
  INV_002: 'BR-INV-002', // Positive quantity for adjustments
  INV_003: 'BR-INV-003', // FEFO batch selection

  // Sales Rules (BR-SAL)
  SAL_001: 'BR-SAL-001', // Valid customer
  SAL_002: 'BR-SAL-002', // Valid payment method
  SAL_003: 'BR-SAL-003', // Credit limit enforcement
  SAL_004: 'BR-SAL-004', // Non-negative sale amount

  // Purchase Order Rules (BR-PO)
  PO_001: 'BR-PO-001', // Valid supplier
  PO_002: 'BR-PO-002', // Valid items with quantities
  PO_003: 'BR-PO-003', // Positive unit cost
  PO_004: 'BR-PO-004', // Valid status transitions

  // Product Rules (BR-PRC)
  PRC_001: 'BR-PRC-001', // Cost price < selling price
  PRC_002: 'BR-PRC-002', // Min stock ≤ reorder level ≤ max stock
} as const;

/**
 * User Roles
 */
export const USER_ROLES = {
  ADMIN: 'ADMIN',
  MANAGER: 'MANAGER',
  CASHIER: 'CASHIER',
  STAFF: 'STAFF',
} as const;

/**
 * Purchase Order Status
 */
export const PO_STATUS = {
  DRAFT: 'DRAFT',
  PENDING: 'PENDING',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
} as const;

/**
 * Goods Receipt Status — SSOT matches goods_receipt_status PG enum
 * (DRAFT | COMPLETED | CANCELLED). COMPLETED = posted/finalized.
 */
export const GR_STATUS = {
  DRAFT: 'DRAFT',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  /** @deprecated UI alias only — never send to API/SQL; use COMPLETED */
  FINALIZED: 'COMPLETED',
} as const;

/**
 * Stock Movement Types
 */
export const STOCK_MOVEMENT_TYPE = {
  PURCHASE: 'PURCHASE',
  SALE: 'SALE',
  ADJUSTMENT: 'ADJUSTMENT',
  TRANSFER: 'TRANSFER',
  RETURN: 'RETURN',
  DAMAGE: 'DAMAGE',
  EXPIRY: 'EXPIRY',
  OPENING_BALANCE: 'OPENING_BALANCE',
} as const;

/**
 * Payment Methods
 */
export const PAYMENT_METHOD = {
  CASH: 'CASH',
  CARD: 'CARD',
  MOBILE_MONEY: 'MOBILE_MONEY',
  AIRTEL_MONEY: 'AIRTEL_MONEY',
  CREDIT: 'CREDIT',
  BANK_TRANSFER: 'BANK_TRANSFER',
  GIFT: 'GIFT',
} as const;

/**
 * Alert Severity Levels
 */
export const ALERT_SEVERITY = {
  INFO: 'INFO',
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
  CRITICAL: 'CRITICAL',
} as const;

/**
 * Alert Types
 */
export const ALERT_TYPE = {
  COST_PRICE_CHANGE: 'COST_PRICE_CHANGE',
  LOW_STOCK: 'LOW_STOCK',
  EXPIRY_WARNING: 'EXPIRY_WARNING',
  CREDIT_LIMIT: 'CREDIT_LIMIT',
  NEGATIVE_STOCK: 'NEGATIVE_STOCK',
} as const;

/**
 * LocalStorage Keys
 */
export const STORAGE_KEYS = {
  AUTH_TOKEN: 'auth_token',
  USER: 'user',
  CART: 'pos_persisted_cart_v1',
  INVENTORY: 'inventory_items',
  OFFLINE_QUEUE: 'offline_sync_queue',
  SETTINGS: 'app_settings',
} as const;

/**
 * API Configuration
 */
export const API_CONFIG = {
  BASE_URL: import.meta.env.VITE_API_URL || '',
  TIMEOUT: 30000, // 30 seconds
  RETRY_ATTEMPTS: 3,
  RETRY_DELAY: 1000, // 1 second
} as const;

/**
 * Pagination Defaults
 */
export const PAGINATION = {
  DEFAULT_PAGE: 1,
  DEFAULT_LIMIT: 50,
  MAX_LIMIT: 100,
  PAGE_SIZE_OPTIONS: [10, 25, 50, 100],
} as const;

/**
 * Date Formats
 */
export const DATE_FORMATS = {
  DISPLAY: 'MMM dd, yyyy',
  INPUT: 'yyyy-MM-dd',
  DATETIME: 'MMM dd, yyyy HH:mm',
  TIME: 'HH:mm',
  FULL: 'EEEE, MMMM dd, yyyy',
} as const;

/**
 * Validation Constraints
 */
export const VALIDATION = {
  // Product
  MIN_PRODUCT_NAME: 2,
  MAX_PRODUCT_NAME: 255,
  MIN_SKU: 3,
  MAX_SKU: 50,
  MIN_COST_PRICE: new Decimal(0.01),
  MIN_SELLING_PRICE: new Decimal(0.01),

  // Customer
  MIN_CUSTOMER_NAME: 2,
  MAX_CUSTOMER_NAME: 255,
  MIN_CREDIT_LIMIT: new Decimal(0),
  MAX_CREDIT_LIMIT: new Decimal(100000000), // 100M

  // Supplier
  MIN_SUPPLIER_NAME: 2,
  MAX_SUPPLIER_NAME: 255,

  // Quantity
  MIN_QUANTITY: new Decimal(0.001),
  MAX_QUANTITY: new Decimal(1000000),

  // Stock Levels
  MIN_STOCK: new Decimal(0),
  MIN_REORDER_LEVEL: new Decimal(0),
  MIN_MAX_STOCK: new Decimal(0),

  // Expiry Warning Days
  EXPIRY_WARNING_DAYS: 30,
  EXPIRY_CRITICAL_DAYS: 7,

  // Cost Change Alert Threshold
  COST_CHANGE_HIGH_PERCENT: new Decimal(10), // 10% = HIGH severity
  COST_CHANGE_MEDIUM_PERCENT: new Decimal(0), // Any change = MEDIUM
} as const;

/**
 * Inventory Configuration
 */
export const INVENTORY_CONFIG = {
  EXPIRY_WARNING_DAYS: 30,
  EXPIRY_CRITICAL_DAYS: 7,
  LOW_STOCK_MULTIPLIER: 1.5, // Reorder when qty < reorder_level * multiplier
} as const;

/**
 * Cache Configuration (React Query)
 */
export const CACHE_CONFIG = {
  STALE_TIME: {
    FAST: 15 * 1000, // 15 seconds (stock levels, cart)
    NORMAL: 30 * 1000, // 30 seconds (lists)
    SLOW: 60 * 1000, // 1 minute (summaries, reports)
    STATIC: 5 * 60 * 1000, // 5 minutes (settings, master data)
  },
  GC_TIME: 10 * 60 * 1000, // 10 minutes garbage collection
  RETRY: 3,
  RETRY_DELAY: 1000,
} as const;

/**
 * Keyboard Shortcuts
 */
export const KEYBOARD_SHORTCUTS = {
  SEARCH: 'Control+f',
  SAVE: 'Control+s',
  SUBMIT: 'Control+Enter',
  CANCEL: 'Escape',
  NEW: 'Control+n',
  EDIT: 'Control+e',
  DELETE: 'Control+d',
  RECALL: 'Control+r',
  HELP: 'F1',
} as const;

/**
 * UI Configuration
 */
export const UI_CONFIG = {
  DEBOUNCE_DELAY: 300, // ms
  TOAST_DURATION: 3000, // ms
  MODAL_ANIMATION_DURATION: 200, // ms
  SEARCH_MIN_LENGTH: 2,
  MAX_SEARCH_RESULTS: 50,
} as const;

/**
 * Product Units of Measure
 */
export const UOM = {
  PIECE: 'PIECE',
  KG: 'KG',
  GRAM: 'GRAM',
  LITER: 'LITER',
  ML: 'ML',
  BOX: 'BOX',
  PACK: 'PACK',
  CARTON: 'CARTON',
} as const;

/**
 * Unit Conversions (to base unit)
 */
export const UOM_CONVERSIONS: Record<string, Decimal> = {
  PIECE: new Decimal(1),
  KG: new Decimal(1),
  GRAM: new Decimal(0.001), // 1 gram = 0.001 kg
  LITER: new Decimal(1),
  ML: new Decimal(0.001), // 1 ml = 0.001 liter
  BOX: new Decimal(1),
  PACK: new Decimal(1),
  CARTON: new Decimal(1),
};

/**
 * Report Types
 */
export const REPORT_TYPE = {
  SALES_SUMMARY: 'SALES_SUMMARY',
  INVENTORY_VALUATION: 'INVENTORY_VALUATION',
  STOCK_MOVEMENT: 'STOCK_MOVEMENT',
  CUSTOMER_STATEMENT: 'CUSTOMER_STATEMENT',
  SUPPLIER_PERFORMANCE: 'SUPPLIER_PERFORMANCE',
  LOW_STOCK: 'LOW_STOCK',
  EXPIRY_ALERT: 'EXPIRY_ALERT',
} as const;

/**
 * Export Formats
 */
export const EXPORT_FORMAT = {
  PDF: 'PDF',
  CSV: 'CSV',
  EXCEL: 'EXCEL',
  JSON: 'JSON',
} as const;

/**
 * Feature Flags
 */
export const FEATURES = {
  OFFLINE_MODE: true,
  BARCODE_SCANNER: true,
  RECEIPT_PRINTER: true,
  MULTI_CURRENCY: false, // Future feature
  MULTI_LOCATION: false, // Future feature
  ADVANCED_PRICING: true,
  BATCH_TRACKING: true,
  FEFO_SELECTION: true,
  COST_ALERTS: true,
} as const;

/**
 * Error Codes
 */
export const ERROR_CODE = {
  NETWORK_ERROR: 'NETWORK_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  BUSINESS_RULE_VIOLATION: 'BUSINESS_RULE_VIOLATION',
  INSUFFICIENT_STOCK: 'INSUFFICIENT_STOCK',
  CREDIT_LIMIT_EXCEEDED: 'CREDIT_LIMIT_EXCEEDED',
  DUPLICATE_ENTRY: 'DUPLICATE_ENTRY',
  SERVER_ERROR: 'SERVER_ERROR',
} as const;

/**
 * Success Messages
 */
export const SUCCESS_MESSAGE = {
  CREATED: 'Record created successfully',
  UPDATED: 'Record updated successfully',
  DELETED: 'Record deleted successfully',
  SAVED: 'Changes saved successfully',
  SYNCED: 'Data synchronized successfully',
  EXPORTED: 'Data exported successfully',
} as const;

/**
 * Type exports for TypeScript
 */
export type BusinessRule = typeof BUSINESS_RULES[keyof typeof BUSINESS_RULES];
export type UserRole = typeof USER_ROLES[keyof typeof USER_ROLES];
export type POStatus = typeof PO_STATUS[keyof typeof PO_STATUS];
export type GRStatus = typeof GR_STATUS[keyof typeof GR_STATUS];
export type StockMovementType = typeof STOCK_MOVEMENT_TYPE[keyof typeof STOCK_MOVEMENT_TYPE];
export type PaymentMethod = typeof PAYMENT_METHOD[keyof typeof PAYMENT_METHOD];
export type AlertSeverity = typeof ALERT_SEVERITY[keyof typeof ALERT_SEVERITY];
export type AlertType = typeof ALERT_TYPE[keyof typeof ALERT_TYPE];
export type UnitOfMeasure = typeof UOM[keyof typeof UOM];
export type ReportType = typeof REPORT_TYPE[keyof typeof REPORT_TYPE];
export type ExportFormat = typeof EXPORT_FORMAT[keyof typeof EXPORT_FORMAT];
export type ErrorCode = typeof ERROR_CODE[keyof typeof ERROR_CODE];
