/**
 * Notification catalog SSOT.
 *
 * Types are defined in code so new events do not require a table-per-type.
 * Tenant policy overlays which types are allowed. User preferences overlay
 * which allowed types a user wants. Device subscriptions overlay where push
 * is delivered.
 */

export type NotificationCategory =
  | 'SALES'
  | 'CUSTOMER_AR'
  | 'PURCHASING_AP'
  | 'INVENTORY'
  | 'APPROVALS'
  | 'SECURITY'
  | 'RESTAURANT'
  | 'SYSTEM';

export type NotificationSeverity = 'INFO' | 'WARNING' | 'CRITICAL';

export type NotificationAudience = 'permission_holders' | 'subject_user' | 'subject_and_admins';

export type PreferenceMode = 'OPTIONAL' | 'ROLE_DEFAULT' | 'MANDATORY';

export type RoleProfile = 'ADMIN' | 'MANAGER' | 'ACCOUNTANT' | 'CASHIER' | 'STAFF' | 'OTHER';

export type RoleChannelDefault = { inApp: boolean; push: boolean };

export type NotificationTypeKey =
  | 'SALE_COMPLETED'
  | 'SALE_VOIDED'
  | 'SALE_RETURNED'
  | 'DISCOUNT_APPLIED'
  | 'DISCOUNT_ABOVE_THRESHOLD'
  | 'SALE_PRICE_OVERRIDE'
  | 'CUSTOMER_PAYMENT_RECEIVED'
  | 'CUSTOMER_CREDIT_POSTED'
  | 'AR_WRITE_OFF'
  | 'PO_CREATED'
  | 'PO_SUBMITTED'
  | 'PO_SENT'
  | 'PO_CANCELLED'
  | 'GOODS_RECEIVED'
  | 'GR_REVERSED'
  | 'SUPPLIER_PAYMENT_POSTED'
  | 'INVENTORY_LOW_STOCK'
  | 'INVENTORY_EXPIRY_WARNING'
  | 'STOCK_TRANSFER_REQUESTED'
  | 'STOCK_TRANSFER_APPROVED'
  | 'STOCK_TRANSFER_COMPLETED'
  | 'INVENTORY_ADJUSTED'
  | 'LOT_WRITE_DOWN'
  | 'STOCK_QUARANTINED'
  | 'APPROVAL_REQUIRED'
  | 'APPROVAL_COMPLETED'
  | 'APPROVAL_REJECTED'
  | 'EXPENSE_PAID'
  | 'SECURITY_PASSWORD_CHANGED'
  | 'SECURITY_ROLE_CHANGED'
  | 'SECURITY_ACCOUNT_DISABLED'
  | 'SECURITY_USER_CREATED'
  | 'PERIOD_CLOSE_SIGNOFF'
  | 'FINANCIAL_INTEGRITY_ALERT'
  | 'RESTAURANT_KOT_SENT'
  | 'RESTAURANT_ORDER_READY'
  | 'RESTAURANT_ORDER_CANCELLED'
  | 'NOTIFICATION_TEST';

export interface NotificationTypeDefinition {
  typeKey: NotificationTypeKey;
  category: NotificationCategory;
  categoryLabel: string;
  label: string;
  description: string;
  severity: NotificationSeverity;
  requiredPermission: string | null;
  audience: NotificationAudience;
  defaultInApp: boolean;
  defaultPush: boolean;
  highVolume: boolean;
  preferenceMode: PreferenceMode;
  roleDefaults?: Partial<Record<RoleProfile, RoleChannelDefault>>;
  navigationPath: (entityId: string | null) => string;
}

const CATEGORY_LABELS: Record<NotificationCategory, string> = {
  SALES: 'Sales',
  CUSTOMER_AR: 'Customer Accounts',
  PURCHASING_AP: 'Purchasing',
  INVENTORY: 'Inventory',
  APPROVALS: 'Approvals',
  SECURITY: 'Security / Account',
  RESTAURANT: 'Restaurant',
  SYSTEM: 'System',
};

function def(
  partial: Omit<NotificationTypeDefinition, 'categoryLabel' | 'preferenceMode'> & {
    category: NotificationCategory;
    preferenceMode?: PreferenceMode;
  },
): NotificationTypeDefinition {
  return {
    preferenceMode: 'ROLE_DEFAULT',
    ...partial,
    categoryLabel: CATEGORY_LABELS[partial.category],
  };
}

const OFF: RoleChannelDefault = { inApp: false, push: false };
const IN_APP: RoleChannelDefault = { inApp: true, push: false };

export const DISCOUNT_THRESHOLD_RATIO = 0.2;

export const NOTIFICATION_CATALOG: readonly NotificationTypeDefinition[] = [
  def({
    typeKey: 'SALE_COMPLETED',
    category: 'SALES',
    label: 'Sale completed',
    description: 'A sale was completed at the register or via an order.',
    severity: 'INFO',
    requiredPermission: 'sales.read',
    audience: 'permission_holders',
    defaultInApp: false,
    defaultPush: false,
    highVolume: true,
    preferenceMode: 'OPTIONAL',
    navigationPath: () => '/sales',
  }),
  def({
    typeKey: 'SALE_VOIDED',
    category: 'SALES',
    label: 'Sale cancelled / voided',
    description: 'A sale was voided or cancelled.',
    severity: 'WARNING',
    requiredPermission: 'sales.read',
    audience: 'permission_holders',
    defaultInApp: true,
    defaultPush: false,
    highVolume: false,
    roleDefaults: { CASHIER: IN_APP, STAFF: OFF },
    navigationPath: () => '/sales',
  }),
  def({
    typeKey: 'SALE_RETURNED',
    category: 'SALES',
    label: 'Returned sale',
    description: 'A completed sale was returned or refunded.',
    severity: 'WARNING',
    requiredPermission: 'sales.read',
    audience: 'permission_holders',
    defaultInApp: true,
    defaultPush: false,
    highVolume: false,
    roleDefaults: { CASHIER: IN_APP, STAFF: OFF },
    navigationPath: () => '/sales',
  }),
  def({
    typeKey: 'DISCOUNT_APPLIED',
    category: 'SALES',
    label: 'Discount applied',
    description: 'A discount was applied on a completed sale.',
    severity: 'INFO',
    requiredPermission: 'sales.read',
    audience: 'permission_holders',
    defaultInApp: false,
    defaultPush: false,
    highVolume: true,
    preferenceMode: 'OPTIONAL',
    navigationPath: () => '/sales',
  }),
  def({
    typeKey: 'DISCOUNT_ABOVE_THRESHOLD',
    category: 'SALES',
    label: 'Discount above threshold',
    description: 'A discount exceeded the configured threshold (20% of subtotal).',
    severity: 'WARNING',
    requiredPermission: 'sales.approve',
    audience: 'permission_holders',
    defaultInApp: true,
    defaultPush: false,
    highVolume: false,
    roleDefaults: { CASHIER: OFF, STAFF: OFF },
    navigationPath: () => '/sales',
  }),
  def({
    typeKey: 'SALE_PRICE_OVERRIDE',
    category: 'SALES',
    label: 'Price override',
    description: 'A POS line price was changed from the list price.',
    severity: 'INFO',
    requiredPermission: 'sales.read',
    audience: 'permission_holders',
    defaultInApp: false,
    defaultPush: false,
    highVolume: true,
    preferenceMode: 'OPTIONAL',
    navigationPath: () => '/sales',
  }),
  def({
    typeKey: 'CUSTOMER_PAYMENT_RECEIVED',
    category: 'CUSTOMER_AR',
    label: 'Customer payment received',
    description: 'A customer payment was posted against accounts receivable.',
    severity: 'INFO',
    requiredPermission: 'customers.read',
    audience: 'permission_holders',
    defaultInApp: true,
    defaultPush: false,
    highVolume: false,
    roleDefaults: {
      ADMIN: IN_APP,
      ACCOUNTANT: IN_APP,
      MANAGER: OFF,
      CASHIER: OFF,
      STAFF: OFF,
    },
    navigationPath: (id) => (id ? `/customers/${id}` : '/customers'),
  }),
  def({
    typeKey: 'CUSTOMER_CREDIT_POSTED',
    category: 'CUSTOMER_AR',
    label: 'Customer credit posted',
    description: 'A customer credit note was posted.',
    severity: 'WARNING',
    requiredPermission: 'customers.read',
    audience: 'permission_holders',
    defaultInApp: true,
    defaultPush: false,
    highVolume: false,
    roleDefaults: { CASHIER: OFF, STAFF: OFF },
    navigationPath: () => '/accounting/credit-debit-notes',
  }),
  def({
    typeKey: 'AR_WRITE_OFF',
    category: 'CUSTOMER_AR',
    label: 'AR write-off',
    description: 'A customer balance was written off.',
    severity: 'WARNING',
    requiredPermission: 'accounting.read',
    audience: 'permission_holders',
    defaultInApp: true,
    defaultPush: false,
    highVolume: false,
    roleDefaults: { CASHIER: OFF, STAFF: OFF },
    navigationPath: () => '/accounting/bad-debt',
  }),
  def({
    typeKey: 'PO_CREATED',
    category: 'PURCHASING_AP',
    label: 'Purchase order created',
    description: 'A purchase order was created.',
    severity: 'INFO',
    requiredPermission: 'purchasing.read',
    audience: 'permission_holders',
    defaultInApp: true,
    defaultPush: false,
    highVolume: false,
    roleDefaults: { CASHIER: OFF, STAFF: OFF },
    navigationPath: () => '/inventory/purchase-orders',
  }),
  def({
    typeKey: 'PO_SUBMITTED',
    category: 'PURCHASING_AP',
    label: 'Purchase order submitted',
    description: 'A purchase order was submitted for sending.',
    severity: 'WARNING',
    requiredPermission: 'purchasing.read',
    audience: 'permission_holders',
    defaultInApp: true,
    defaultPush: false,
    highVolume: false,
    roleDefaults: { CASHIER: OFF, STAFF: OFF },
    navigationPath: () => '/inventory/purchase-orders',
  }),
  def({
    typeKey: 'PO_SENT',
    category: 'PURCHASING_AP',
    label: 'Purchase order sent',
    description: 'A purchase order was sent to the supplier.',
    severity: 'INFO',
    requiredPermission: 'purchasing.read',
    audience: 'permission_holders',
    defaultInApp: true,
    defaultPush: false,
    highVolume: false,
    roleDefaults: { CASHIER: OFF, STAFF: OFF },
    navigationPath: () => '/inventory/purchase-orders',
  }),
  def({
    typeKey: 'PO_CANCELLED',
    category: 'PURCHASING_AP',
    label: 'Purchase order cancelled',
    description: 'A purchase order was cancelled.',
    severity: 'WARNING',
    requiredPermission: 'purchasing.read',
    audience: 'permission_holders',
    defaultInApp: true,
    defaultPush: false,
    highVolume: false,
    roleDefaults: { CASHIER: OFF, STAFF: OFF },
    navigationPath: () => '/inventory/purchase-orders',
  }),
  def({
    typeKey: 'GOODS_RECEIVED',
    category: 'PURCHASING_AP',
    label: 'Goods received',
    description: 'A goods receipt was finalized and stock was received.',
    severity: 'INFO',
    requiredPermission: 'purchasing.read',
    audience: 'permission_holders',
    defaultInApp: true,
    defaultPush: false,
    highVolume: false,
    roleDefaults: { CASHIER: OFF, STAFF: OFF },
    navigationPath: () => '/inventory/goods-receipts',
  }),
  def({
    typeKey: 'GR_REVERSED',
    category: 'PURCHASING_AP',
    label: 'Goods receipt reversed',
    description: 'An uninvoiced goods receipt was reversed.',
    severity: 'WARNING',
    requiredPermission: 'purchasing.read',
    audience: 'permission_holders',
    defaultInApp: true,
    defaultPush: false,
    highVolume: false,
    roleDefaults: { CASHIER: OFF, STAFF: OFF },
    navigationPath: () => '/inventory/goods-receipts',
  }),
  def({
    typeKey: 'SUPPLIER_PAYMENT_POSTED',
    category: 'PURCHASING_AP',
    label: 'Supplier payment posted',
    description: 'A supplier payment was posted.',
    severity: 'INFO',
    requiredPermission: 'purchasing.read',
    audience: 'permission_holders',
    defaultInApp: true,
    defaultPush: false,
    highVolume: false,
    roleDefaults: {
      ADMIN: IN_APP,
      ACCOUNTANT: IN_APP,
      MANAGER: OFF,
      CASHIER: OFF,
      STAFF: OFF,
    },
    navigationPath: () => '/accounting/supplier-payments',
  }),
  def({
    typeKey: 'INVENTORY_LOW_STOCK',
    category: 'INVENTORY',
    label: 'Low stock',
    description: 'A product reached its reorder / low-stock threshold.',
    severity: 'WARNING',
    requiredPermission: 'inventory.read',
    audience: 'permission_holders',
    defaultInApp: true,
    defaultPush: false,
    highVolume: false,
    roleDefaults: { ACCOUNTANT: OFF, CASHIER: OFF, STAFF: OFF },
    navigationPath: () => '/inventory/stock-levels',
  }),
  def({
    typeKey: 'INVENTORY_EXPIRY_WARNING',
    category: 'INVENTORY',
    label: 'Expiry warning',
    description: 'A batch is nearing expiry.',
    severity: 'WARNING',
    requiredPermission: 'inventory.read',
    audience: 'permission_holders',
    defaultInApp: true,
    defaultPush: false,
    highVolume: false,
    roleDefaults: { ACCOUNTANT: OFF, CASHIER: OFF, STAFF: OFF },
    navigationPath: () => '/inventory/batches',
  }),
  def({
    typeKey: 'STOCK_TRANSFER_REQUESTED',
    category: 'INVENTORY',
    label: 'Stock transfer requested',
    description: 'A store transfer was requested.',
    severity: 'INFO',
    requiredPermission: 'inventory.transfer.approve',
    audience: 'permission_holders',
    defaultInApp: true,
    defaultPush: false,
    highVolume: false,
    roleDefaults: { ACCOUNTANT: OFF, CASHIER: OFF, STAFF: OFF },
    navigationPath: () => '/inventory/transfer-approvals',
  }),
  def({
    typeKey: 'STOCK_TRANSFER_APPROVED',
    category: 'INVENTORY',
    label: 'Stock transfer approved',
    description: 'A store transfer was approved.',
    severity: 'INFO',
    requiredPermission: 'inventory.transfer.receive',
    audience: 'permission_holders',
    defaultInApp: true,
    defaultPush: false,
    highVolume: false,
    roleDefaults: { ACCOUNTANT: OFF, CASHIER: OFF, STAFF: OFF },
    navigationPath: () => '/inventory/transfer-approvals',
  }),
  def({
    typeKey: 'STOCK_TRANSFER_COMPLETED',
    category: 'INVENTORY',
    label: 'Stock transfer completed',
    description: 'A store transfer was received.',
    severity: 'INFO',
    requiredPermission: 'inventory.read',
    audience: 'permission_holders',
    defaultInApp: true,
    defaultPush: false,
    highVolume: false,
    roleDefaults: { ACCOUNTANT: OFF, CASHIER: OFF, STAFF: OFF },
    navigationPath: () => '/inventory/store-transfers',
  }),
  def({
    typeKey: 'INVENTORY_ADJUSTED',
    category: 'INVENTORY',
    label: 'Inventory adjustment',
    description: 'Store stock was adjusted.',
    severity: 'WARNING',
    requiredPermission: 'inventory.adjust',
    audience: 'permission_holders',
    defaultInApp: true,
    defaultPush: false,
    highVolume: false,
    roleDefaults: { CASHIER: OFF, STAFF: OFF },
    navigationPath: () => '/inventory/adjustments',
  }),
  def({
    typeKey: 'LOT_WRITE_DOWN',
    category: 'INVENTORY',
    label: 'Lot write-down',
    description: 'A lot carrying value was written down.',
    severity: 'WARNING',
    requiredPermission: 'inventory.read',
    audience: 'permission_holders',
    defaultInApp: true,
    defaultPush: false,
    highVolume: false,
    roleDefaults: { CASHIER: OFF, STAFF: OFF },
    navigationPath: () => '/inventory/batches',
  }),
  def({
    typeKey: 'STOCK_QUARANTINED',
    category: 'INVENTORY',
    label: 'Stock quarantined',
    description: 'Sellable stock was moved to quarantine.',
    severity: 'WARNING',
    requiredPermission: 'inventory.read',
    audience: 'permission_holders',
    defaultInApp: true,
    defaultPush: false,
    highVolume: false,
    roleDefaults: { CASHIER: OFF, STAFF: OFF },
    navigationPath: () => '/inventory/quarantine',
  }),
  def({
    typeKey: 'APPROVAL_REQUIRED',
    category: 'APPROVALS',
    label: 'Approval required',
    description: 'A document was submitted and needs approval.',
    severity: 'WARNING',
    requiredPermission: 'expenses.approve',
    audience: 'permission_holders',
    defaultInApp: true,
    defaultPush: false,
    highVolume: false,
    roleDefaults: { CASHIER: OFF, STAFF: OFF },
    navigationPath: () => '/expenses',
  }),
  def({
    typeKey: 'APPROVAL_COMPLETED',
    category: 'APPROVALS',
    label: 'Approval completed',
    description: 'A pending approval was approved.',
    severity: 'INFO',
    requiredPermission: 'expenses.read',
    audience: 'permission_holders',
    defaultInApp: true,
    defaultPush: false,
    highVolume: false,
    roleDefaults: { CASHIER: OFF, STAFF: OFF },
    navigationPath: () => '/expenses',
  }),
  def({
    typeKey: 'APPROVAL_REJECTED',
    category: 'APPROVALS',
    label: 'Approval rejected',
    description: 'A pending approval was rejected.',
    severity: 'WARNING',
    requiredPermission: 'expenses.read',
    audience: 'permission_holders',
    defaultInApp: true,
    defaultPush: false,
    highVolume: false,
    roleDefaults: { CASHIER: OFF, STAFF: OFF },
    navigationPath: () => '/expenses',
  }),
  def({
    typeKey: 'EXPENSE_PAID',
    category: 'APPROVALS',
    label: 'Expense paid',
    description: 'An approved expense was marked paid.',
    severity: 'INFO',
    requiredPermission: 'expenses.read',
    audience: 'permission_holders',
    defaultInApp: true,
    defaultPush: false,
    highVolume: false,
    roleDefaults: { CASHIER: OFF, STAFF: OFF },
    navigationPath: () => '/expenses',
  }),
  def({
    typeKey: 'SECURITY_PASSWORD_CHANGED',
    category: 'SECURITY',
    label: 'Password / security change',
    description: 'Your password was changed.',
    severity: 'CRITICAL',
    requiredPermission: null,
    audience: 'subject_user',
    defaultInApp: true,
    defaultPush: false,
    highVolume: false,
    preferenceMode: 'MANDATORY',
    navigationPath: () => '/settings/security',
  }),
  def({
    typeKey: 'SECURITY_ROLE_CHANGED',
    category: 'SECURITY',
    label: 'Role / permission change',
    description: 'A user role assignment changed.',
    severity: 'WARNING',
    requiredPermission: 'system.users_update',
    audience: 'subject_and_admins',
    defaultInApp: true,
    defaultPush: false,
    highVolume: false,
    preferenceMode: 'MANDATORY',
    navigationPath: () => '/settings?tab=users',
  }),
  def({
    typeKey: 'SECURITY_ACCOUNT_DISABLED',
    category: 'SECURITY',
    label: 'Account disabled',
    description: 'A user account was deactivated.',
    severity: 'CRITICAL',
    requiredPermission: 'system.users_update',
    audience: 'permission_holders',
    defaultInApp: true,
    defaultPush: false,
    highVolume: false,
    preferenceMode: 'MANDATORY',
    navigationPath: () => '/settings?tab=users',
  }),
  def({
    typeKey: 'SECURITY_USER_CREATED',
    category: 'SECURITY',
    label: 'New user',
    description: 'A user account was created.',
    severity: 'WARNING',
    requiredPermission: 'system.users_update',
    audience: 'permission_holders',
    defaultInApp: true,
    defaultPush: false,
    highVolume: false,
    preferenceMode: 'MANDATORY',
    navigationPath: () => '/settings?tab=users',
  }),
  def({
    typeKey: 'PERIOD_CLOSE_SIGNOFF',
    category: 'SYSTEM',
    label: 'Period-close signoff',
    description: 'A period-close signoff was requested.',
    severity: 'WARNING',
    requiredPermission: 'accounting.read',
    audience: 'permission_holders',
    defaultInApp: true,
    defaultPush: false,
    highVolume: false,
    roleDefaults: { CASHIER: OFF, STAFF: OFF },
    navigationPath: () => '/accounting/reconciliation/period-close',
  }),
  def({
    typeKey: 'FINANCIAL_INTEGRITY_ALERT',
    category: 'SYSTEM',
    label: 'Financial integrity alert',
    description: 'Accounting integrity drift was recorded.',
    severity: 'CRITICAL',
    requiredPermission: 'accounting.read',
    audience: 'permission_holders',
    defaultInApp: true,
    defaultPush: false,
    highVolume: false,
    preferenceMode: 'MANDATORY',
    roleDefaults: { CASHIER: OFF, STAFF: OFF },
    navigationPath: () => '/accounting/gl-integrity',
  }),
  def({
    typeKey: 'RESTAURANT_KOT_SENT',
    category: 'RESTAURANT',
    label: 'Kitchen ticket sent',
    description: 'A kitchen ticket was fired.',
    severity: 'INFO',
    requiredPermission: 'restaurant.kitchen',
    audience: 'permission_holders',
    defaultInApp: false,
    defaultPush: false,
    highVolume: true,
    preferenceMode: 'OPTIONAL',
    navigationPath: () => '/restaurant/kitchen',
  }),
  def({
    typeKey: 'RESTAURANT_ORDER_READY',
    category: 'RESTAURANT',
    label: 'Order ready',
    description: 'Kitchen marked an order ready.',
    severity: 'INFO',
    requiredPermission: 'restaurant.read',
    audience: 'permission_holders',
    defaultInApp: true,
    defaultPush: false,
    highVolume: false,
    roleDefaults: { ACCOUNTANT: OFF, STAFF: OFF },
    navigationPath: () => '/restaurant',
  }),
  def({
    typeKey: 'RESTAURANT_ORDER_CANCELLED',
    category: 'RESTAURANT',
    label: 'Restaurant order cancelled',
    description: 'A restaurant check was cancelled.',
    severity: 'WARNING',
    requiredPermission: 'restaurant.read',
    audience: 'permission_holders',
    defaultInApp: true,
    defaultPush: false,
    highVolume: false,
    roleDefaults: { ACCOUNTANT: OFF, STAFF: OFF },
    navigationPath: () => '/restaurant',
  }),
  def({
    typeKey: 'NOTIFICATION_TEST',
    category: 'SYSTEM',
    label: 'Test notification',
    description: 'A test notification sent to your own devices only.',
    severity: 'INFO',
    requiredPermission: null,
    audience: 'subject_user',
    defaultInApp: true,
    defaultPush: true,
    highVolume: false,
    preferenceMode: 'OPTIONAL',
    navigationPath: () => '/settings/notifications',
  }),
];

const BY_KEY = new Map(NOTIFICATION_CATALOG.map((t) => [t.typeKey, t]));

export function getNotificationType(typeKey: string): NotificationTypeDefinition | undefined {
  return BY_KEY.get(typeKey as NotificationTypeKey);
}

export function isNotificationTypeKey(value: string): value is NotificationTypeKey {
  return BY_KEY.has(value as NotificationTypeKey);
}

export function listCatalogForApi(allowedTypeKeys?: Set<string>) {
  return NOTIFICATION_CATALOG.filter((t) => !allowedTypeKeys || allowedTypeKeys.has(t.typeKey)).map(
    (t) => ({
      typeKey: t.typeKey,
      category: t.category,
      categoryLabel: t.categoryLabel,
      label: t.label,
      description: t.description,
      severity: t.severity,
      defaultInApp: t.defaultInApp,
      defaultPush: t.defaultPush,
      highVolume: t.highVolume,
      preferenceMode: t.preferenceMode,
      requiredPermission: t.requiredPermission,
      channels: ['IN_APP', 'WEB_PUSH'] as const,
    }),
  );
}

/** App-relative path only — never trust push payloads as URLs. */
export function isSafeNavigationPath(path: string | null | undefined): boolean {
  if (!path) return false;
  if (!path.startsWith('/')) return false;
  if (path.startsWith('//')) return false;
  if (path.includes('\\')) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return false;
  return true;
}
