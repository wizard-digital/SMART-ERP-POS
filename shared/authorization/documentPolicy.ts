/**
 * Document and document-flow permission policies.
 * Maps document/entity types to required read permissions (any match grants access).
 */

/** PDF document renderer types → permissions */
export const DOCUMENT_TYPE_PERMISSIONS: Record<string, readonly string[]> = {
  INVOICE: ['sales.read', 'customers.read'],
  RECEIPT: ['sales.read', 'pos.read'],
  QUOTATION: ['quotations.read'],
  PURCHASE_ORDER: ['purchasing.read'],
  GOODS_RECEIPT: ['purchasing.read'],
  STORE_ISSUE: ['kitchen.production.read', 'inventory.read', 'inventory.adjust'],
  DELIVERY_NOTE: ['delivery.read'],
  CREDIT_NOTE: ['customers.read', 'sales.read'],
  CUSTOMER_STATEMENT: ['customers.read', 'reports.customers_view'],
  SUPPLIER_STATEMENT: ['suppliers.read', 'reports.read'],
  SUPPLIER_INVOICE: ['suppliers.read', 'purchasing.read'],
  PAYMENT_VOUCHER: ['banking.read', 'suppliers.read'],
  PROFIT_LOSS: ['reports.financial_view', 'accounting.read'],
  BALANCE_SHEET: ['reports.financial_view', 'accounting.read'],
  TRIAL_BALANCE: ['reports.financial_view', 'accounting.read'],
  CASH_FLOW: ['reports.financial_view', 'accounting.read'],
  GENERAL_LEDGER: ['accounting.read'],
  AGED_RECEIVABLES: ['reports.customers_view', 'accounting.read'],
  AGED_PAYABLES: ['suppliers.read', 'accounting.read'],
};

/** Document flow entity types → permissions */
export const ENTITY_FLOW_PERMISSIONS: Record<string, readonly string[]> = {
  QUOTATION: ['quotations.read'],
  SALE: ['sales.read'],
  DELIVERY_ORDER: ['delivery.read'],
  DELIVERY_NOTE: ['delivery.read'],
  INVOICE: ['customers.read', 'sales.read'],
  PAYMENT: ['customers.read', 'banking.read'],
  CREDIT_NOTE: ['customers.read'],
  DEBIT_NOTE: ['customers.read'],
  PURCHASE_ORDER: ['purchasing.read'],
  GOODS_RECEIPT: ['purchasing.read'],
  RETURN_GRN: ['purchasing.read'],
  SUPPLIER_INVOICE: ['suppliers.read'],
  SUPPLIER_PAYMENT: ['suppliers.read'],
};

const DEFAULT_DOCUMENT_PERMISSIONS = ['reports.read'] as const;

export function permissionsForDocumentType(documentType: string): readonly string[] {
  return DOCUMENT_TYPE_PERMISSIONS[documentType] ?? DEFAULT_DOCUMENT_PERMISSIONS;
}

export function permissionsForEntityFlow(entityType: string): readonly string[] {
  return ENTITY_FLOW_PERMISSIONS[entityType] ?? DEFAULT_DOCUMENT_PERMISSIONS;
}
