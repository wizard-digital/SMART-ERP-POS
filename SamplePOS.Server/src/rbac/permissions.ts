import type { Permission, PermissionModule, PermissionAction } from './types.js';

function p(
  key: string,
  module: PermissionModule,
  action: PermissionAction,
  description: string
): Permission {
  return { key, module, action, description };
}

export const PERMISSIONS: Record<string, Permission> = {
  SALES_READ: p('sales.read', 'sales', 'read', 'View sales transactions'),
  SALES_CREATE: p('sales.create', 'sales', 'create', 'Create new sales'),
  SALES_UPDATE: p('sales.update', 'sales', 'update', 'Modify existing sales'),
  SALES_DELETE: p('sales.delete', 'sales', 'delete', 'Delete sales transactions'),
  SALES_VOID: p('sales.void', 'sales', 'void', 'Void completed sales'),
  SALES_REFUND: p('sales.refund', 'sales', 'refund', 'Refund completed sales'),
  SALES_EXCHANGE: p('sales.exchange', 'sales', 'exchange', 'Exchange wrong products on completed sales'),
  SALES_EXPORT: p('sales.export', 'sales', 'export', 'Export sales data'),
  SALES_APPROVE: p('sales.approve', 'sales', 'approve', 'Approve sales requiring authorization'),
  SALES_TAX_OVERRIDE: p(
    'sales.tax_override',
    'sales',
    'tax_override',
    'Override VAT/tax determination on sales (requires reason + audit)',
  ),
  SALES_REPRINT: p('sales.reprint', 'sales', 'reprint', 'Reprint sale receipts'),
  SALES_REASSIGN_CUSTOMER: p(
    'sales.reassign_customer',
    'sales',
    'update',
    'Reassign sale to another customer (wrong customer correction; manager/admin only)',
  ),
  SALES_TAX_RESTATEMENT: p(
    'sales.tax_restatement',
    'sales',
    'update',
    'Restate tax on posted sales/invoices from DocumentTax (omitted VAT correction; manager/admin/accountant)',
  ),

  INVENTORY_READ: p('inventory.read', 'inventory', 'read', 'View inventory levels'),
  INVENTORY_CREATE: p('inventory.create', 'inventory', 'create', 'Create inventory items'),
  INVENTORY_UPDATE: p('inventory.update', 'inventory', 'update', 'Modify inventory items'),
  INVENTORY_DELETE: p('inventory.delete', 'inventory', 'delete', 'Delete inventory items'),
  INVENTORY_IMPORT: p('inventory.import', 'inventory', 'import', 'Import inventory data'),
  INVENTORY_EXPORT: p('inventory.export', 'inventory', 'export', 'Export inventory data'),
  INVENTORY_APPROVE: p('inventory.approve', 'inventory', 'approve', 'Approve stock adjustments'),
  INVENTORY_BATCH_EXPIRY_EDIT: p('inventory.batch_expiry_edit', 'inventory', 'update', 'Edit batch expiry dates (SAP master data correction — Batch Management screen only)'),

  POS_READ: p('pos.read', 'pos', 'read', 'Access point of sale'),
  POS_CREATE: p('pos.create', 'pos', 'create', 'Process transactions'),
  POS_VOID: p('pos.void', 'pos', 'void', 'Void POS transactions'),
  POS_APPROVE: p('pos.approve', 'pos', 'approve', 'Approve POS overrides'),

  ORDERS_READ: p('orders.read', 'orders', 'read', 'View POS orders queue'),
  ORDERS_CREATE: p('orders.create', 'orders', 'create', 'Create POS orders (dispenser)'),
  ORDERS_PAY: p('orders.pay', 'orders', 'pay', 'Complete POS orders with payment (cashier)'),
  ORDERS_CANCEL: p('orders.cancel', 'orders', 'cancel', 'Cancel pending POS orders'),

  RESTAURANT_READ: p('restaurant.read', 'restaurant', 'read', 'View restaurant floor, open checks, and menu'),
  RESTAURANT_ORDER: p('restaurant.order', 'restaurant', 'create', 'Create and edit restaurant orders (waiter)'),
  RESTAURANT_KITCHEN: p('restaurant.kitchen', 'restaurant', 'update', 'Send and manage kitchen tickets'),
  RESTAURANT_PAY: p('restaurant.pay', 'restaurant', 'pay', 'Complete restaurant check payment (settlement)'),
  RESTAURANT_EDIT_OTHERS: p(
    'restaurant.edit_others',
    'restaurant',
    'update',
    'Open and edit restaurant checks owned by another waiter',
  ),
  RESTAURANT_MANAGE: p('restaurant.manage', 'restaurant', 'manage', 'Manage restaurant tables and module settings'),

  PURCHASING_READ: p('purchasing.read', 'purchasing', 'read', 'View purchase orders'),
  PURCHASING_CREATE: p('purchasing.create', 'purchasing', 'create', 'Create purchase orders'),
  PURCHASING_UPDATE: p('purchasing.update', 'purchasing', 'update', 'Modify purchase orders'),
  PURCHASING_DELETE: p('purchasing.delete', 'purchasing', 'delete', 'Delete purchase orders'),
  PURCHASING_APPROVE: p('purchasing.approve', 'purchasing', 'approve', 'Approve purchase orders'),
  PURCHASING_POST: p('purchasing.post', 'purchasing', 'post', 'Post goods receipts'),
  PURCHASING_CANCEL_BILL: p(
    'purchasing.cancel_bill',
    'purchasing',
    'cancel',
    'Cancel unpaid supplier bills (reverse GL so GR can be rebilled)',
  ),

  CUSTOMERS_READ: p('customers.read', 'customers', 'read', 'View customers'),
  CUSTOMERS_CREATE: p('customers.create', 'customers', 'create', 'Create customers'),
  CUSTOMERS_UPDATE: p('customers.update', 'customers', 'update', 'Modify customers'),
  CUSTOMERS_DELETE: p('customers.delete', 'customers', 'delete', 'Delete customers'),
  CUSTOMERS_EXPORT: p('customers.export', 'customers', 'export', 'Export customer data'),
  CUSTOMERS_ADJUST: p('customers.adjust', 'customers', 'adjust', 'Adjust customer invoices (credit notes)'),

  SUPPLIERS_READ: p('suppliers.read', 'suppliers', 'read', 'View suppliers'),
  SUPPLIERS_CREATE: p('suppliers.create', 'suppliers', 'create', 'Create suppliers'),
  SUPPLIERS_UPDATE: p('suppliers.update', 'suppliers', 'update', 'Modify suppliers'),
  SUPPLIERS_DELETE: p('suppliers.delete', 'suppliers', 'delete', 'Delete suppliers'),

  ACCOUNTING_READ: p('accounting.read', 'accounting', 'read', 'View accounting data'),
  ACCOUNTING_CREATE: p('accounting.create', 'accounting', 'create', 'Create journal entries'),
  ACCOUNTING_UPDATE: p('accounting.update', 'accounting', 'update', 'Modify accounting records'),
  ACCOUNTING_DELETE: p('accounting.delete', 'accounting', 'delete', 'Delete accounting records'),
  ACCOUNTING_POST: p('accounting.post', 'accounting', 'post', 'Post journal entries'),
  ACCOUNTING_APPROVE: p(
    'accounting.approve',
    'accounting',
    'approve',
    'Approve accounting transactions'
  ),
  ACCOUNTING_VOID: p('accounting.void', 'accounting', 'void', 'Void posted entries'),
  ACCOUNTING_EXPORT: p('accounting.export', 'accounting', 'export', 'Export accounting data'),
  ACCOUNTING_PERIOD_MANAGE: p('accounting.period_manage', 'accounting', 'period_manage', 'Close, reopen, and lock accounting periods'),
  ACCOUNTING_RECONCILE: p('accounting.reconcile', 'accounting', 'reconcile', 'Perform account reconciliations (AR, AP, cash, inventory)'),
  ACCOUNTING_CHART_MANAGE: p('accounting.chart_manage', 'accounting', 'chart_manage', 'Manage chart of accounts (create, edit, deactivate accounts)'),
  ACCOUNTING_MANAGE: p('accounting.manage', 'accounting', 'manage', 'Manage accounting configuration (cost centers, periods, currencies, WHT, assets, dunning)'),
  ACCOUNTING_OPENING_BALANCE: p(
    'accounting.opening_balance',
    'accounting',
    'post',
    'Post or correct customer/supplier cutover opening balances (admin assigns to accountants)',
  ),


  REPORTS_READ: p('reports.read', 'reports', 'read', 'Access reports dashboard'),
  REPORTS_CREATE: p('reports.create', 'reports', 'create', 'Create custom reports'),
  REPORTS_EXPORT: p('reports.export', 'reports', 'export', 'Export reports to CSV/PDF'),
  REPORTS_SALES_VIEW: p('reports.sales_view', 'reports', 'sales_view', 'View sales reports (daily summary, by cashier, by category, by payment method, voids, refunds)'),
  REPORTS_INVENTORY_VIEW: p('reports.inventory_view', 'reports', 'inventory_view', 'View inventory reports (valuation, stock aging, low stock, expiring, adjustments, waste)'),
  REPORTS_FINANCIAL_VIEW: p('reports.financial_view', 'reports', 'financial_view', 'View financial reports (P&L, balance sheet, cash flow, trial balance, business position)'),
  REPORTS_PURCHASING_VIEW: p('reports.purchasing_view', 'reports', 'purchasing_view', 'View purchasing reports (PO summary, supplier cost analysis, goods received)'),
  REPORTS_CUSTOMERS_VIEW: p('reports.customers_view', 'reports', 'customers_view', 'View customer reports (aging, statements, top customers, purchase history)'),
  REPORTS_BANKING_VIEW: p('reports.banking_view', 'reports', 'banking_view', 'View banking reports (transactions, reconciliation, bank statements)'),
  REPORTS_HR_VIEW: p('reports.hr_view', 'reports', 'hr_view', 'View HR and payroll reports'),

  ADMIN_READ: p('admin.read', 'admin', 'read', 'View admin panel'),
  ADMIN_CREATE: p('admin.create', 'admin', 'create', 'Create admin resources'),
  ADMIN_UPDATE: p('admin.update', 'admin', 'update', 'Modify admin settings'),
  ADMIN_DELETE: p('admin.delete', 'admin', 'delete', 'Delete admin resources'),

  SYSTEM_READ: p('system.read', 'system', 'read', 'View system configuration'),
  SYSTEM_UPDATE: p('system.update', 'system', 'update', 'Modify system settings'),
  SYSTEM_AUDIT_READ: p('system.audit_read', 'system', 'read', 'View audit logs'),
  SYSTEM_USERS_READ: p('system.users_read', 'system', 'read', 'View users'),
  SYSTEM_USERS_CREATE: p('system.users_create', 'system', 'create', 'Create users'),
  SYSTEM_USERS_UPDATE: p('system.users_update', 'system', 'update', 'Modify users'),
  SYSTEM_USERS_DELETE: p('system.users_delete', 'system', 'delete', 'Delete users'),
  SYSTEM_ROLES_READ: p('system.roles_read', 'system', 'read', 'View roles'),
  SYSTEM_ROLES_CREATE: p('system.roles_create', 'system', 'create', 'Create roles'),
  SYSTEM_ROLES_UPDATE: p('system.roles_update', 'system', 'update', 'Modify roles'),
  SYSTEM_ROLES_DELETE: p('system.roles_delete', 'system', 'delete', 'Delete roles'),
  SYSTEM_PERMISSIONS_READ: p(
    'system.permissions_read',
    'system',
    'read',
    'View permissions catalog'
  ),

  // Banking Module
  BANKING_READ: p('banking.read', 'banking', 'read', 'View bank accounts and transactions'),
  BANKING_CREATE: p('banking.create', 'banking', 'create', 'Create bank accounts and transactions'),
  BANKING_UPDATE: p('banking.update', 'banking', 'update', 'Modify bank accounts and transactions'),
  BANKING_DELETE: p('banking.delete', 'banking', 'delete', 'Delete bank transactions'),
  BANKING_RECONCILE: p('banking.reconcile', 'banking', 'reconcile', 'Reconcile bank statements'),
  BANKING_IMPORT: p('banking.import', 'banking', 'import', 'Import bank statements'),
  BANKING_EXPORT: p('banking.export', 'banking', 'export', 'Export banking data'),

  // Delivery Module
  DELIVERY_READ: p('delivery.read', 'delivery', 'read', 'View delivery orders and routes'),
  DELIVERY_CREATE: p('delivery.create', 'delivery', 'create', 'Create delivery orders'),
  DELIVERY_UPDATE: p(
    'delivery.update',
    'delivery',
    'update',
    'Update delivery status and assign drivers'
  ),
  DELIVERY_DELETE: p('delivery.delete', 'delivery', 'delete', 'Delete delivery orders'),

  // Settings Module
  SETTINGS_READ: p('settings.read', 'settings', 'read', 'View application settings'),
  SETTINGS_UPDATE: p('settings.update', 'settings', 'update', 'Modify application settings'),

  // CRM Module
  CRM_READ: p('crm.read', 'crm', 'read', 'View CRM data (leads, opportunities, activities)'),
  CRM_CREATE: p('crm.create', 'crm', 'create', 'Create leads and opportunities'),
  CRM_UPDATE: p('crm.update', 'crm', 'update', 'Modify CRM records'),
  CRM_DELETE: p('crm.delete', 'crm', 'delete', 'Delete CRM records'),
  CRM_MANAGE: p('crm.manage', 'crm', 'manage', 'Manage opportunity pipeline'),

  // HR & Payroll Module
  HR_READ: p('hr.read', 'hr', 'read', 'View HR data (employees, departments, positions, payroll)'),
  HR_CREATE: p('hr.create', 'hr', 'create', 'Create employees, departments, positions, payroll periods'),
  HR_UPDATE: p('hr.update', 'hr', 'update', 'Modify HR records'),
  HR_DELETE: p('hr.delete', 'hr', 'delete', 'Delete HR records'),
  HR_PAYROLL_PROCESS: p('hr.payroll_process', 'hr', 'payroll_process', 'Process payroll (calculate entries)'),
  HR_PAYROLL_POST: p('hr.payroll_post', 'hr', 'payroll_post', 'Post payroll to General Ledger'),
  HR_PAYROLL_PAY: p('hr.payroll_pay', 'hr', 'payroll_pay', 'Pay salaries (clear Salaries Payable from cash/bank)'),
  HR_ADVANCE: p('hr.advance', 'hr', 'advance', 'Issue salary advances and charge cash shortages to employees'),

  // Inventory extended
  INVENTORY_STOCKCOUNT: p(
    'inventory.manage',
    'inventory',
    'manage',
    'Manage physical stock counts'
  ),
  INVENTORY_ADJUST: p('inventory.adjust', 'inventory', 'adjust', 'Perform stock adjustments (add, remove, transfer)'),

  // Kitchen Production (ADR-005) — posts into inventory engine; optional feature
  KITCHEN_PRODUCTION_READ: p(
    'kitchen.production.read',
    'kitchen',
    'read',
    'View kitchen production batches',
  ),
  KITCHEN_PRODUCTION_CREATE: p(
    'kitchen.production.create',
    'kitchen',
    'create',
    'Create and edit draft production batches',
  ),
  KITCHEN_PRODUCTION_POST: p(
    'kitchen.production.post',
    'kitchen',
    'post',
    'Post production batches (issue ingredients + receive finished food)',
  ),
  INVENTORY_TRANSFER_REQUEST: p(
    'inventory.transfer.request',
    'inventory',
    'create',
    'Create inter-store transfer requests',
  ),
  INVENTORY_TRANSFER_APPROVE: p(
    'inventory.transfer.approve',
    'inventory',
    'approve',
    'Approve pending transfer requests',
  ),
  INVENTORY_TRANSFER_DISPATCH: p(
    'inventory.transfer.dispatch',
    'inventory',
    'post',
    'Dispatch approved transfers to transit',
  ),
  INVENTORY_TRANSFER_RECEIVE: p(
    'inventory.transfer.receive',
    'inventory',
    'post',
    'Receive inbound transfers at destination stores',
  ),
  INVENTORY_TRANSFER_DIRECT: p(
    'inventory.transfer.direct',
    'inventory',
    'execute',
    'Execute transfers immediately without approval workflow',
  ),
  INVENTORY_TRANSFER_OVERRIDE: p(
    'inventory.transfer.override',
    'inventory',
    'manage',
    'Emergency override of transfer approval policies',
  ),

  // Expenses Module
  TARGETS_READ: p('targets.read', 'targets', 'read', 'View sales targets and achievement'),
  TARGETS_MANAGE: p(
    'targets.manage',
    'targets',
    'manage',
    'Create, edit, submit, amend, cancel, and close sales targets',
  ),
  TARGETS_APPROVE: p('targets.approve', 'targets', 'approve', 'Approve pending sales targets'),

  EXPENSES_READ: p('expenses.read', 'expenses', 'read', 'View expenses and expense summaries'),
  EXPENSES_CREATE: p('expenses.create', 'expenses', 'create', 'Create expense entries and claims'),
  EXPENSES_UPDATE: p('expenses.update', 'expenses', 'update', 'Modify expense records'),
  EXPENSES_DELETE: p('expenses.delete', 'expenses', 'delete', 'Delete expense records'),
  EXPENSES_APPROVE: p('expenses.approve', 'expenses', 'approve', 'Approve or reject expense submissions'),
  EXPENSES_EXPORT: p('expenses.export', 'expenses', 'export', 'Export expense data to CSV'),

  // Distribution / Sales Orders Module
  DISTRIBUTION_READ: p('distribution.read', 'distribution', 'read', 'View sales orders, deliveries, and invoices'),
  DISTRIBUTION_CREATE: p('distribution.create', 'distribution', 'create', 'Create sales orders and deliveries'),
  DISTRIBUTION_UPDATE: p('distribution.update', 'distribution', 'update', 'Edit sales orders'),
  DISTRIBUTION_DELETE: p('distribution.delete', 'distribution', 'delete', 'Cancel/delete sales orders'),
  DISTRIBUTION_APPROVE: p('distribution.approve', 'distribution', 'approve', 'Approve sales orders'),

  // Quotations Module
  QUOTATIONS_READ: p('quotations.read', 'quotations', 'read', 'View quotations'),
  QUOTATIONS_CREATE: p('quotations.create', 'quotations', 'create', 'Create quotations'),
  QUOTATIONS_UPDATE: p('quotations.update', 'quotations', 'update', 'Modify quotations'),
  QUOTATIONS_DELETE: p('quotations.delete', 'quotations', 'delete', 'Delete quotations'),

  CORRECTIONS_READ: p('corrections.read', 'corrections', 'read', 'View correction eligibility and previews'),
  CORRECTIONS_EXECUTE: p(
    'corrections.execute',
    'corrections',
    'execute',
    'Execute correction wizards (wrong product, supplier reassignment)',
  ),
} as const;

export const PERMISSION_KEYS = Object.values(PERMISSIONS).map((p) => p.key);

export function isValidPermissionKey(key: string): boolean {
  return PERMISSION_KEYS.includes(key);
}

export function getPermission(key: string): Permission | undefined {
  return Object.values(PERMISSIONS).find((p) => p.key === key);
}

export function getPermissionsByModule(module: PermissionModule): Permission[] {
  return Object.values(PERMISSIONS).filter((p) => p.module === module);
}

export function getAllPermissions(): Permission[] {
  return Object.values(PERMISSIONS);
}

export const SYSTEM_ROLES = {
  SUPER_ADMIN: 'super_admin',
  ADMIN: 'admin',
  MANAGER: 'manager',
  CASHIER: 'cashier',
  STAFF: 'staff',
  AUDITOR: 'auditor',
} as const;
