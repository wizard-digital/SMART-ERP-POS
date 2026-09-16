import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');

function readRepo(rel: string): string {
  return readFileSync(join(repoRoot, rel), 'utf8');
}

describe('EVIDENCE — notification platform SSOT', () => {
  it('settings UI renders catalog from the API, not a hardcoded type list', () => {
    const tab = readRepo('samplepos.client/src/pages/settings/tabs/NotificationSettingsTab.tsx');
    expect(tab).toContain("/notifications/preferences");
    expect(tab).not.toContain('SALE_COMPLETED');
    expect(tab).toContain('Choose the areas you want to be notified about');
    expect(tab).toContain('Recommended for you');
    expect(tab).toContain('Customize notifications');
    expect(tab).toContain('Manage device');
    expect(tab).toContain('managingDeviceId');
    expect(tab).toContain('groupPreferenceAreas');
    expect(tab).toContain('Notification category');
    expect(tab).toContain('aria-label="Notification category"');
    expect(tab).toContain('Deliver to');
    expect(tab).toContain('This device follows your notification types');
    expect(tab).toContain('Other devices');
    expect(tab).toContain('whyYouReceive');
    expect(tab).toContain('deviceMutes');
    expect(tab).not.toContain('grouped.map');
  });

  it('service worker handles push and notificationclick without replacing offline sync', () => {
    const sw = readRepo('samplepos.client/public/sw.js');
    expect(sw).toContain("self.addEventListener('push'");
    expect(sw).toContain("self.addEventListener('notificationclick'");
    expect(sw).toContain("sync-offline-sales");
    expect(sw).toContain('showNotification');
    expect(sw).not.toContain('cache.addAll');
    expect(sw).not.toContain('pos-icon-192.png');
  });

  it('deep link fetches the inbox record instead of trusting the push URL', () => {
    const deep = readRepo('samplepos.client/src/components/notifications/NotificationDeepLink.tsx');
    expect(deep).toContain('/notifications/${nid}');
    expect(deep).toContain('toInAppLocation');
    expect(deep).toContain('isAuthenticated');
    expect(deep).toContain('getAccessToken');
    expect(deep).not.toContain("navigate('/settings/notifications'");
    expect(deep).not.toContain('window.location = data.url');
  });

  it('settings tab does not declare Device twice and guards list payloads', () => {
    const tab = readRepo('samplepos.client/src/pages/settings/tabs/NotificationSettingsTab.tsx');
    expect(tab.match(/type Device = \{/g)?.length).toBe(1);
    expect(tab).toContain('function asList');
    expect(tab).toContain('useAdaptiveLayoutOptional');
  });

  it('Enable and Send test buttons call the live handlers, not a dead label', () => {
    const tab = readRepo('samplepos.client/src/pages/settings/tabs/NotificationSettingsTab.tsx');
    expect(tab).toContain('async function enablePush()');
    expect(tab).toContain("onClick={() => void enablePush()}");
    expect(tab).toContain('async function sendTest()');
    expect(tab).toContain("onClick={() => void sendTest()}");
    expect(tab).toContain("apiClient.post('/notifications/test'");
    expect(tab).toContain("apiClient.post('/notifications/devices'");
  });

  it('enable push checks VAPID catalog before requesting OS permission', () => {
    const tab = readRepo('samplepos.client/src/pages/settings/tabs/NotificationSettingsTab.tsx');
    const push = readRepo('samplepos.client/src/lib/pushSubscription.ts');
    expect(tab).toContain("/notifications/catalog");
    expect(tab.indexOf('vapidPublicKey')).toBeLessThan(tab.indexOf('Notification.requestPermission'));
    expect(tab).not.toContain('VAPID public key missing');
    expect(tab).toContain('subscribeThisBrowser');
    expect(tab).toContain('describePushRegisterError');
    expect(push).toContain('getPushRegistration');
    expect(push).toContain('unsubscribe');
    expect(push).toContain('applicationServerKeyFromVapid');
  });

  it('inbox shows what happened, not why-you-received permission prose', () => {
    const center = readRepo('samplepos.client/src/components/notifications/NotificationCenter.tsx');
    expect(center).toContain('item.body');
    expect(center).toContain('latest.body');
    expect(center).not.toContain('Why you received this');
    expect(center).not.toContain('whyReceived');
  });

  it('notification popup fits the viewport as a compact dropdown, not a full-screen sheet', () => {
    const center = readRepo('samplepos.client/src/components/notifications/NotificationCenter.tsx');
    const layout = readRepo('samplepos.client/src/lib/notificationCenterLayout.ts');
    expect(layout).toContain("return 'dropdown'");
    expect(layout).toContain('50dvh');
    expect(center).toContain('resolveNotificationCenterPresentation');
    expect(center).toContain('data-notification-center="dropdown"');
    expect(center).toContain('break-words');
    expect(center).toContain('notificationCenterMaxHeightCss');
    expect(center).not.toContain('data-notification-center="sheet"');
    expect(center).not.toContain('92dvh');
    expect(center).not.toContain('justify-end bg-black/40');
  });

  it('business notification payload SSOT covers sales, expenses, AR and AP publishers', () => {
    const ssot = readRepo('SamplePOS.Server/src/modules/notifications/businessNotificationPayload.ts');
    const sales = readRepo('SamplePOS.Server/src/modules/sales/salesService.ts');
    const expenses = readRepo('SamplePOS.Server/src/services/expenseService.ts');
    const ar = readRepo('SamplePOS.Server/src/modules/ar-payments/arPaymentService.ts');
    const ap = readRepo('SamplePOS.Server/src/modules/supplier-payments/supplierPaymentService.ts');
    const center = readRepo('samplepos.client/src/components/notifications/NotificationCenter.tsx');
    expect(ssot).toContain('buildBusinessNotificationPayload');
    expect(ssot).toContain('buildProductLineNotificationPayload');
    expect(sales).toContain('buildProductLineNotificationPayload');
    expect(expenses).toContain('buildBusinessNotificationPayload');
    expect(expenses).toContain('expenseDetailLabel');
    expect(ar).toContain('buildBusinessNotificationPayload');
    expect(ar).toContain('Customer paid');
    expect(ap).toContain('buildBusinessNotificationPayload');
    expect(ap).toContain('Supplier paid');
    expect(center).not.toContain('Why you received this');
  });

  it('backend catalog is the type SSOT and sales publish after COMMIT', () => {
    const catalog = readRepo('SamplePOS.Server/src/modules/notifications/catalog.ts');
    const sales = readRepo('SamplePOS.Server/src/modules/sales/salesService.ts');
    const decision = readRepo('SamplePOS.Server/src/modules/notifications/notificationDecision.ts');
    expect(catalog).toContain("typeKey: 'SALE_COMPLETED'");
    expect(catalog).toContain('Shows which products were sold');
    expect(decision).toContain("role === 'DIRECTOR'");
    expect(decision).toContain("name.includes('owner')");
    expect(sales).toContain('buildProductLineNotificationPayload');
    expect(sales.indexOf("await client.query('COMMIT')")).toBeLessThan(sales.indexOf("typeKey: 'SALE_COMPLETED'"));
  });
});
