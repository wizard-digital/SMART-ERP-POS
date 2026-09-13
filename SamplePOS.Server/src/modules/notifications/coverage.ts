/**
 * Notification event-coverage matrix (SSOT for classification).
 *
 * Status:
 *   PUBLISHED — catalog type + publisher after COMMIT
 *   EXCLUDED — inspected, intentionally not a notification
 *   NO_COMMITTED_EVENT — operation does not persist an event (rollback / UI-only)
 *
 * Every catalog typeKey must appear as PUBLISHED.
 * Inspected operations without a type are EXCLUDED or NO_COMMITTED_EVENT.
 */

import { NOTIFICATION_CATALOG, type NotificationTypeKey, type PreferenceMode } from './catalog.js';

export type CoverageStatus = 'PUBLISHED' | 'EXCLUDED' | 'NO_COMMITTED_EVENT';

export interface CoverageRow {
  operation: string;
  area: string;
  typeKey: NotificationTypeKey | null;
  status: CoverageStatus;
  preference: PreferenceMode | 'n/a';
  volume: 'high' | 'normal' | 'n/a';
  reason: string;
  publisher?: string;
}

export const NOTIFICATION_COVERAGE: readonly CoverageRow[] = [
  { area: 'Sales', operation: 'Sale completed', typeKey: 'SALE_COMPLETED', status: 'PUBLISHED', preference: 'OPTIONAL', volume: 'high', reason: 'High volume POS; off by default', publisher: 'salesService.createSale' },
  { area: 'Sales', operation: 'Sale voided', typeKey: 'SALE_VOIDED', status: 'PUBLISHED', preference: 'ROLE_DEFAULT', volume: 'normal', reason: 'Control event after void commit', publisher: 'salesService.voidSale' },
  { area: 'Sales', operation: 'Sale returned (full or partial)', typeKey: 'SALE_RETURNED', status: 'PUBLISHED', preference: 'ROLE_DEFAULT', volume: 'normal', reason: 'Refund commit is the SSOT', publisher: 'salesService.refundSale' },
  { area: 'Sales', operation: 'Discount applied', typeKey: 'DISCOUNT_APPLIED', status: 'PUBLISHED', preference: 'OPTIONAL', volume: 'high', reason: 'Noise unless opted in', publisher: 'salesService.createSale' },
  { area: 'Sales', operation: 'Discount above 20% threshold', typeKey: 'DISCOUNT_ABOVE_THRESHOLD', status: 'PUBLISHED', preference: 'ROLE_DEFAULT', volume: 'normal', reason: 'Existing DISCOUNT_THRESHOLD_RATIO', publisher: 'salesService.createSale' },
  { area: 'Sales', operation: 'POS line price override', typeKey: 'SALE_PRICE_OVERRIDE', status: 'PUBLISHED', preference: 'OPTIONAL', volume: 'high', reason: 'PRICE_EDIT audit exists inside sale commit', publisher: 'salesService.createSale' },
  { area: 'Sales', operation: 'Below-cost line rejection', typeKey: null, status: 'NO_COMMITTED_EVENT', preference: 'n/a', volume: 'n/a', reason: 'assertSaleLineNotBelowAllocatedCost rolls back the sale UoW' },
  { area: 'Sales', operation: 'Receipt reprint', typeKey: null, status: 'EXCLUDED', preference: 'n/a', volume: 'n/a', reason: 'No new business event; reprint is operational noise' },
  { area: 'Sales', operation: 'High-value sale threshold', typeKey: null, status: 'EXCLUDED', preference: 'n/a', volume: 'n/a', reason: 'No tenant high-value SSOT exists; do not invent a threshold' },

  { area: 'AR', operation: 'Customer payment posted', typeKey: 'CUSTOMER_PAYMENT_RECEIVED', status: 'PUBLISHED', preference: 'ROLE_DEFAULT', volume: 'normal', reason: 'AR payment service after commit', publisher: 'arPaymentService.createCustomerPayment' },
  { area: 'AR', operation: 'Customer credit note posted', typeKey: 'CUSTOMER_CREDIT_POSTED', status: 'PUBLISHED', preference: 'ROLE_DEFAULT', volume: 'normal', reason: 'creditDebitNoteService.postNote', publisher: 'creditDebitNoteService.postNote' },
  { area: 'AR', operation: 'AR write-off posted', typeKey: 'AR_WRITE_OFF', status: 'PUBLISHED', preference: 'ROLE_DEFAULT', volume: 'normal', reason: 'badDebtService.createAndPostWriteoff', publisher: 'badDebtService.createAndPostWriteoff' },
  { area: 'AR', operation: 'Credit-limit field change on customer', typeKey: null, status: 'EXCLUDED', preference: 'n/a', volume: 'n/a', reason: 'Master-data edit, not a posting event; no dedicated credit-limit SSOT event' },
  { area: 'AR', operation: 'Customer create', typeKey: null, status: 'EXCLUDED', preference: 'n/a', volume: 'n/a', reason: 'Master data, not operational' },
  { area: 'AR', operation: 'Write-off reverse', typeKey: null, status: 'EXCLUDED', preference: 'n/a', volume: 'n/a', reason: 'Covered by accounting document; avoid duplicate of AR_WRITE_OFF' },

  { area: 'Purchasing', operation: 'PO created', typeKey: 'PO_CREATED', status: 'PUBLISHED', preference: 'ROLE_DEFAULT', volume: 'normal', reason: 'createPO after UoW', publisher: 'purchaseOrderService.createPO' },
  { area: 'Purchasing', operation: 'PO submitted for approval', typeKey: 'PO_SUBMITTED', status: 'PUBLISHED', preference: 'ROLE_DEFAULT', volume: 'normal', reason: 'submitPO DRAFT→PENDING', publisher: 'purchaseOrderService.submitPO' },
  { area: 'Purchasing', operation: 'PO sent to supplier', typeKey: 'PO_SENT', status: 'PUBLISHED', preference: 'ROLE_DEFAULT', volume: 'normal', reason: 'sendPOToSupplier after UoW', publisher: 'purchaseOrderService.sendPOToSupplier' },
  { area: 'Purchasing', operation: 'PO cancelled', typeKey: 'PO_CANCELLED', status: 'PUBLISHED', preference: 'ROLE_DEFAULT', volume: 'normal', reason: 'cancelPO after UoW', publisher: 'purchaseOrderService.cancelPO' },
  { area: 'Purchasing', operation: 'Goods receipt finalized', typeKey: 'GOODS_RECEIVED', status: 'PUBLISHED', preference: 'ROLE_DEFAULT', volume: 'normal', reason: 'finalizeGR', publisher: 'goodsReceiptService.finalizeGR' },
  { area: 'Purchasing', operation: 'Uninvoiced GR reversed', typeKey: 'GR_REVERSED', status: 'PUBLISHED', preference: 'ROLE_DEFAULT', volume: 'normal', reason: 'reverseUninvoicedReceipt', publisher: 'goodsReceiptService.reverseUninvoicedReceipt' },
  { area: 'Purchasing', operation: 'Supplier payment posted', typeKey: 'SUPPLIER_PAYMENT_POSTED', status: 'PUBLISHED', preference: 'ROLE_DEFAULT', volume: 'normal', reason: 'createSupplierPayment', publisher: 'supplierPaymentService.createSupplierPayment' },
  { area: 'Purchasing', operation: 'Draft GR cancel', typeKey: null, status: 'EXCLUDED', preference: 'n/a', volume: 'n/a', reason: 'Draft never posted stock/GL' },
  { area: 'Purchasing', operation: 'PO approve/reject named actions', typeKey: null, status: 'EXCLUDED', preference: 'n/a', volume: 'n/a', reason: 'SSOT is submit/send/cancel, not approvePO' },
  { area: 'Purchasing', operation: 'Supplier invoice posted from GRN', typeKey: null, status: 'EXCLUDED', preference: 'n/a', volume: 'n/a', reason: 'Bill creation is coupled to goods receipt / AP document flow; GOODS_RECEIVED and SUPPLIER_PAYMENT_POSTED are the operational ends. Do not duplicate every AP bill.' },

  { area: 'Inventory', operation: 'Low stock (condition job)', typeKey: 'INVENTORY_LOW_STOCK', status: 'PUBLISHED', preference: 'ROLE_DEFAULT', volume: 'normal', reason: 'inventoryConditionPublisher uses inventory SSOT', publisher: 'inventoryConditionPublisher' },
  { area: 'Inventory', operation: 'Expiry warning (condition job)', typeKey: 'INVENTORY_EXPIRY_WARNING', status: 'PUBLISHED', preference: 'ROLE_DEFAULT', volume: 'normal', reason: 'Same job, batches SSOT', publisher: 'inventoryConditionPublisher' },
  { area: 'Inventory', operation: 'Stock transfer requested', typeKey: 'STOCK_TRANSFER_REQUESTED', status: 'PUBLISHED', preference: 'ROLE_DEFAULT', volume: 'normal', reason: 'createTransfer after UoW', publisher: 'storeTransferService.createTransfer' },
  { area: 'Inventory', operation: 'Stock transfer approved', typeKey: 'STOCK_TRANSFER_APPROVED', status: 'PUBLISHED', preference: 'ROLE_DEFAULT', volume: 'normal', reason: 'approveTransfer after UoW', publisher: 'storeTransferService.approveTransfer' },
  { area: 'Inventory', operation: 'Stock transfer received/completed', typeKey: 'STOCK_TRANSFER_COMPLETED', status: 'PUBLISHED', preference: 'ROLE_DEFAULT', volume: 'normal', reason: 'receiveTransfer after UoW', publisher: 'storeTransferService.receiveTransfer' },
  { area: 'Inventory', operation: 'Store stock adjustment', typeKey: 'INVENTORY_ADJUSTED', status: 'PUBLISHED', preference: 'ROLE_DEFAULT', volume: 'normal', reason: 'adjustAtStore after commit', publisher: 'warehouseAdjustmentService.adjustAtStore' },
  { area: 'Inventory', operation: 'Lot write-down', typeKey: 'LOT_WRITE_DOWN', status: 'PUBLISHED', preference: 'ROLE_DEFAULT', volume: 'normal', reason: 'writeDownNearExpiryLot admin SSOT', publisher: 'lotWriteDownService.writeDownNearExpiryLot' },
  { area: 'Inventory', operation: 'Soft quarantine', typeKey: 'STOCK_QUARANTINED', status: 'PUBLISHED', preference: 'ROLE_DEFAULT', volume: 'normal', reason: 'applySoftQuarantine', publisher: 'softQuarantineService.applySoftQuarantine' },
  { area: 'Inventory', operation: 'Negative stock prevention', typeKey: null, status: 'NO_COMMITTED_EVENT', preference: 'n/a', volume: 'n/a', reason: 'Guards throw and roll back; no posted event' },

  { area: 'Expenses', operation: 'Expense submitted', typeKey: 'APPROVAL_REQUIRED', status: 'PUBLISHED', preference: 'ROLE_DEFAULT', volume: 'normal', reason: 'submitExpense', publisher: 'expenseService.submitExpense' },
  { area: 'Expenses', operation: 'Expense approved', typeKey: 'APPROVAL_COMPLETED', status: 'PUBLISHED', preference: 'ROLE_DEFAULT', volume: 'normal', reason: 'approveExpense', publisher: 'expenseService.approveExpense' },
  { area: 'Expenses', operation: 'Expense rejected', typeKey: 'APPROVAL_REJECTED', status: 'PUBLISHED', preference: 'ROLE_DEFAULT', volume: 'normal', reason: 'rejectExpense', publisher: 'expenseService.rejectExpense' },
  { area: 'Expenses', operation: 'Expense paid', typeKey: 'EXPENSE_PAID', status: 'PUBLISHED', preference: 'ROLE_DEFAULT', volume: 'normal', reason: 'markExpensePaid after UoW', publisher: 'expenseService.markExpensePaid' },
  { area: 'Expenses', operation: 'Expense draft created', typeKey: null, status: 'EXCLUDED', preference: 'n/a', volume: 'n/a', reason: 'Draft is not an approval/payment event' },

  { area: 'Security', operation: 'Password changed', typeKey: 'SECURITY_PASSWORD_CHANGED', status: 'PUBLISHED', preference: 'MANDATORY', volume: 'normal', reason: 'Subject user only', publisher: 'passwordRoutes' },
  { area: 'Security', operation: 'Role assigned', typeKey: 'SECURITY_ROLE_CHANGED', status: 'PUBLISHED', preference: 'MANDATORY', volume: 'normal', reason: 'assignRoleToUser', publisher: 'rbac.service.assignRoleToUser' },
  { area: 'Security', operation: 'Account deactivated', typeKey: 'SECURITY_ACCOUNT_DISABLED', status: 'PUBLISHED', preference: 'MANDATORY', volume: 'normal', reason: 'deleteUser soft-deactivate', publisher: 'userService.deleteUser' },
  { area: 'Security', operation: 'User created', typeKey: 'SECURITY_USER_CREATED', status: 'PUBLISHED', preference: 'MANDATORY', volume: 'normal', reason: 'createUser after UoW', publisher: 'userService.createUser' },
  { area: 'Security', operation: 'Test notification', typeKey: 'NOTIFICATION_TEST', status: 'PUBLISHED', preference: 'OPTIONAL', volume: 'normal', reason: 'Self-test to own devices', publisher: 'notificationService.sendTestNotification' },
  { area: 'Security', operation: 'User re-enabled via profile edit', typeKey: null, status: 'EXCLUDED', preference: 'n/a', volume: 'n/a', reason: 'updateUser is generic master-data; no dedicated enable SSOT distinct from other profile edits' },
  { area: 'Security', operation: 'New device / login session', typeKey: null, status: 'EXCLUDED', preference: 'n/a', volume: 'n/a', reason: 'Session rows are high-volume; existing security architecture does not expose a committed new-device business event for notification' },

  { area: 'Accounting', operation: 'Period-close signoff requested', typeKey: 'PERIOD_CLOSE_SIGNOFF', status: 'PUBLISHED', preference: 'ROLE_DEFAULT', volume: 'normal', reason: 'requestPeriodCloseSignoff and reviewPeriodCloseSignoff after commit', publisher: 'periodCloseSignoffService.requestPeriodCloseSignoff' },
  { area: 'Accounting', operation: 'Financial integrity drift alert', typeKey: 'FINANCIAL_INTEGRITY_ALERT', status: 'PUBLISHED', preference: 'MANDATORY', volume: 'normal', reason: 'detectIntegrityDriftAlerts inserts alerts', publisher: 'integrityAlertService.detectIntegrityDriftAlerts' },
  { area: 'Accounting', operation: 'GL posting failure', typeKey: null, status: 'NO_COMMITTED_EVENT', preference: 'n/a', volume: 'n/a', reason: 'Posting failures roll back UoW; no failure-event table' },
  { area: 'Accounting', operation: 'Manual journal create', typeKey: null, status: 'EXCLUDED', preference: 'n/a', volume: 'n/a', reason: 'Too noisy; JE approval is a separate SSOT when parked' },
  { area: 'Accounting', operation: 'Bank / mobile-money reconciliation exception', typeKey: null, status: 'EXCLUDED', preference: 'n/a', volume: 'n/a', reason: 'No committed reconciliation-exception event in AccountingCore suitable for notification without inventing a second SSOT' },

  { area: 'Restaurant', operation: 'KOT sent', typeKey: 'RESTAURANT_KOT_SENT', status: 'PUBLISHED', preference: 'OPTIONAL', volume: 'high', reason: 'Only fires when restaurant sendKot runs', publisher: 'restaurantService.sendKot' },
  { area: 'Restaurant', operation: 'KOT marked ready', typeKey: 'RESTAURANT_ORDER_READY', status: 'PUBLISHED', preference: 'ROLE_DEFAULT', volume: 'normal', reason: 'advanceKotStatus READY', publisher: 'restaurantService.advanceKotStatus' },
  { area: 'Restaurant', operation: 'Check cancelled', typeKey: 'RESTAURANT_ORDER_CANCELLED', status: 'PUBLISHED', preference: 'ROLE_DEFAULT', volume: 'normal', reason: 'cancelCheck', publisher: 'restaurantService.cancelCheck' },
  { area: 'Accounting', operation: 'Period-close signoff reviewed', typeKey: null, status: 'EXCLUDED', preference: 'n/a', volume: 'n/a', reason: 'Review commit reuses PERIOD_CLOSE_SIGNOFF (same worklist); no second type' },
  { area: 'Accounting', operation: 'Payment run approved', typeKey: null, status: 'EXCLUDED', preference: 'n/a', volume: 'n/a', reason: 'Treasury worklist; cash posting is SUPPLIER_PAYMENT_POSTED' },
  { area: 'Purchasing', operation: 'Supplier credit/debit note posted', typeKey: null, status: 'EXCLUDED', preference: 'n/a', volume: 'n/a', reason: 'AP document; GOODS_RECEIVED and SUPPLIER_PAYMENT_POSTED are the operational ends. Do not duplicate every SCN.' },
  { area: 'Sales', operation: 'Quotation converted', typeKey: null, status: 'EXCLUDED', preference: 'n/a', volume: 'n/a', reason: 'Status change on quotations worklist; SALE_COMPLETED fires if it becomes a POS sale' },
  { area: 'Sales', operation: 'Cash register session open/close', typeKey: null, status: 'EXCLUDED', preference: 'n/a', volume: 'n/a', reason: 'High-volume shift operations; no exception event beyond existing POS session policy' },
  { area: 'HR', operation: 'Payroll run posted', typeKey: null, status: 'EXCLUDED', preference: 'n/a', volume: 'n/a', reason: 'Payroll has its own posting/worklist SSOT; do not invent a parallel HR notification engine' },
  { area: 'Restaurant', operation: 'Open empty check', typeKey: null, status: 'EXCLUDED', preference: 'n/a', volume: 'n/a', reason: 'Opening a table is not an exception' },
];

export function coveragePublishedTypeKeys(): NotificationTypeKey[] {
  return NOTIFICATION_COVERAGE.filter((row) => row.status === 'PUBLISHED' && row.typeKey)
    .map((row) => row.typeKey as NotificationTypeKey);
}

export function unexplainedCatalogGaps(): string[] {
  const published = new Set(coveragePublishedTypeKeys());
  return NOTIFICATION_CATALOG.filter((t) => !published.has(t.typeKey)).map((t) => t.typeKey);
}

export function unexplainedPublishedDuplicates(): string[] {
  const seen = new Map<string, number>();
  for (const row of NOTIFICATION_COVERAGE) {
    if (row.status !== 'PUBLISHED' || !row.typeKey) continue;
    seen.set(row.typeKey, (seen.get(row.typeKey) || 0) + 1);
  }
  return [...seen.entries()].filter(([, n]) => n !== 1).map(([k]) => k);
}
