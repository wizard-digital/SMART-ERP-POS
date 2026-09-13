import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from '@jest/globals';
import { getNotificationType, isSafeNavigationPath, NOTIFICATION_CATALOG } from './catalog.js';
import { isValidPermissionKey } from '../../rbac/permissions.js';
import {
  NOTIFICATION_COVERAGE,
  unexplainedCatalogGaps,
  unexplainedPublishedDuplicates,
} from './coverage.js';

const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = join(here, '../../..');

const PUBLISHER_FILES: Record<string, string> = {
  'salesService.createSale': 'src/modules/sales/salesService.ts',
  'salesService.voidSale': 'src/modules/sales/salesService.ts',
  'salesService.refundSale': 'src/modules/sales/salesService.ts',
  'arPaymentService.createCustomerPayment': 'src/modules/ar-payments/arPaymentService.ts',
  'creditDebitNoteService.postNote': 'src/modules/credit-debit-notes/creditDebitNoteService.ts',
  'badDebtService.createAndPostWriteoff': 'src/modules/bad-debt/badDebtService.ts',
  'purchaseOrderService.createPO': 'src/modules/purchase-orders/purchaseOrderService.ts',
  'purchaseOrderService.submitPO': 'src/modules/purchase-orders/purchaseOrderService.ts',
  'purchaseOrderService.sendPOToSupplier': 'src/modules/purchase-orders/purchaseOrderService.ts',
  'purchaseOrderService.cancelPO': 'src/modules/purchase-orders/purchaseOrderService.ts',
  'goodsReceiptService.finalizeGR': 'src/modules/goods-receipts/goodsReceiptService.ts',
  'goodsReceiptService.reverseUninvoicedReceipt': 'src/modules/goods-receipts/goodsReceiptService.ts',
  'supplierPaymentService.createSupplierPayment': 'src/modules/supplier-payments/supplierPaymentService.ts',
  inventoryConditionPublisher: 'src/modules/notifications/inventoryConditionPublisher.ts',
  'storeTransferService.createTransfer': 'src/modules/inventory/warehouse/storeTransferService.ts',
  'storeTransferService.approveTransfer': 'src/modules/inventory/warehouse/storeTransferService.ts',
  'storeTransferService.receiveTransfer': 'src/modules/inventory/warehouse/storeTransferService.ts',
  'warehouseAdjustmentService.adjustAtStore': 'src/modules/inventory/warehouse/warehouseAdjustmentService.ts',
  'lotWriteDownService.writeDownNearExpiryLot': 'src/modules/inventory-lot/lotWriteDownService.ts',
  'softQuarantineService.applySoftQuarantine': 'src/modules/loss-quarantine/softQuarantineService.ts',
  'expenseService.submitExpense': 'src/services/expenseService.ts',
  'expenseService.approveExpense': 'src/services/expenseService.ts',
  'expenseService.rejectExpense': 'src/services/expenseService.ts',
  'expenseService.markExpensePaid': 'src/services/expenseService.ts',
  passwordRoutes: 'src/modules/auth/passwordRoutes.ts',
  'rbac.service.assignRoleToUser': 'src/rbac/service.ts',
  'userService.deleteUser': 'src/modules/users/userService.ts',
  'userService.createUser': 'src/modules/users/userService.ts',
  'notificationService.sendTestNotification': 'src/modules/notifications/notificationService.ts',
  'periodCloseSignoffService.requestPeriodCloseSignoff':
    'src/modules/financial-governance/periodCloseSignoffService.ts',
  'integrityAlertService.detectIntegrityDriftAlerts':
    'src/modules/financial-governance/integrityAlertService.ts',
  'restaurantService.sendKot': 'src/modules/restaurant/restaurantService.ts',
  'restaurantService.advanceKotStatus': 'src/modules/restaurant/restaurantService.ts',
  'restaurantService.cancelCheck': 'src/modules/restaurant/restaurantService.ts',
};

describe('notification coverage matrix', () => {
  it('classifies every catalog type as PUBLISHED exactly once', () => {
    expect(unexplainedCatalogGaps()).toEqual([]);
    expect(unexplainedPublishedDuplicates()).toEqual([]);
  });

  it('keeps coverage preference aligned with the catalog', () => {
    const mismatches: string[] = [];
    for (const row of NOTIFICATION_COVERAGE) {
      if (row.status !== 'PUBLISHED' || !row.typeKey || row.preference === 'n/a') continue;
      const type = getNotificationType(row.typeKey);
      if (!type) {
        mismatches.push(`${row.typeKey} missing from catalog`);
        continue;
      }
      if (type.preferenceMode !== row.preference) {
        mismatches.push(`${row.typeKey}: coverage ${row.preference} catalog ${type.preferenceMode}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('finds each PUBLISHED typeKey in its named publisher source', () => {
    const missing: string[] = [];
    for (const row of NOTIFICATION_COVERAGE) {
      if (row.status !== 'PUBLISHED' || !row.typeKey || !row.publisher) continue;
      const relative = PUBLISHER_FILES[row.publisher];
      if (!relative) {
        missing.push(`${row.typeKey}: unknown publisher ${row.publisher}`);
        continue;
      }
      const src = readFileSync(join(serverRoot, relative), 'utf8');
      if (!src.includes(`'${row.typeKey}'`) && !src.includes(`"${row.typeKey}"`)) {
        missing.push(`${row.typeKey} not found in ${relative}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('catalog navigationPath targets a route declared in App.tsx', () => {
    const app = readFileSync(
      join(serverRoot, '..', 'samplepos.client', 'src', 'App.tsx'),
      'utf8',
    );
    const missing: string[] = [];
    const probeId = '11111111-1111-4111-8111-111111111111';
    for (const type of NOTIFICATION_CATALOG) {
      const withId = type.navigationPath(probeId).split('?')[0];
      const staticPath = type.navigationPath(null).split('?')[0];
      const declared =
        app.includes(`path="${staticPath}"`) ||
        app.includes(`path="${withId}"`) ||
        (withId !== staticPath && app.includes(`path="${staticPath}/:`));
      if (!declared) missing.push(`${type.typeKey} → ${staticPath}`);
    }
    expect(missing).toEqual([]);
  });

  it('catalog requiredPermission keys exist in the RBAC catalog', () => {
    const missing = NOTIFICATION_CATALOG
      .filter((type) => type.requiredPermission && !isValidPermissionKey(type.requiredPermission))
      .map((type) => `${type.typeKey}:${type.requiredPermission}`);
    expect(missing).toEqual([]);
  });

  it('catalog navigationPath values are safe app-relative paths', () => {
    const probeId = '11111111-1111-4111-8111-111111111111';
    const unsafe = NOTIFICATION_CATALOG
      .filter((type) => !isSafeNavigationPath(type.navigationPath(null))
        || !isSafeNavigationPath(type.navigationPath(probeId)))
      .map((type) => type.typeKey);
    expect(unsafe).toEqual([]);
  });

  it('settings ?tab= values exist on SettingsPage', () => {
    const settings = readFileSync(
      join(serverRoot, '..', 'samplepos.client', 'src', 'pages', 'settings', 'SettingsPage.tsx'),
      'utf8',
    );
    const missing: string[] = [];
    for (const type of NOTIFICATION_CATALOG) {
      const query = type.navigationPath(null).split('?')[1];
      if (!query) continue;
      const tab = new URLSearchParams(query).get('tab');
      if (!tab) continue;
      if (!settings.includes(`'${tab}'`)) missing.push(`${type.typeKey} tab=${tab}`);
    }
    expect(missing).toEqual([]);
  });

  it('period-close review reuses PERIOD_CLOSE_SIGNOFF after commit instead of a second type', () => {
    const src = readFileSync(
      join(serverRoot, 'src/modules/financial-governance/periodCloseSignoffService.ts'),
      'utf8',
    );
    expect(src).toContain('reviewPeriodCloseSignoff');
    expect(src).toContain('PERIOD_CLOSE_SIGNOFF:review:');
    const excluded = NOTIFICATION_COVERAGE.find((row) => row.operation === 'Period-close signoff reviewed');
    expect(excluded?.status).toBe('EXCLUDED');
    expect(excluded?.typeKey).toBeNull();
  });
});
