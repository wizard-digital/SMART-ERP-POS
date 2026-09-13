import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Pool } from 'pg';

type MockFn = (...args: unknown[]) => Promise<unknown>;

const mockDeliverWebPush = jest.fn<MockFn>();
const mockClaimPendingEvent = jest.fn<MockFn>();
const mockGetTenantPolicyMap = jest.fn<MockFn>();
const mockMarkEventDone = jest.fn<MockFn>();
const mockMarkEventFailed = jest.fn<MockFn>();
const mockListRecipientCandidateIds = jest.fn<MockFn>();
const mockIsUserActive = jest.fn<MockFn>();
const mockGetActorIdentity = jest.fn<MockFn>();
const mockListUserNotificationProfiles = jest.fn<MockFn>();
const mockGetUserPreferenceMap = jest.fn<MockFn>();
const mockGetUserPreferenceMaps = jest.fn<MockFn>();
const mockInsertInbox = jest.fn<MockFn>();
const mockInsertDelivery = jest.fn<MockFn>();
const mockListActivePushSubscriptionsForUser = jest.fn<MockFn>();
const mockListActivePushSubscriptionsForUsers = jest.fn<MockFn>();
const mockGetDeviceTypePreferenceMap = jest.fn<MockFn>();
const mockGetDeviceTypePreferenceMaps = jest.fn<MockFn>();
const mockHasSubmittedWebPush = jest.fn<MockFn>();
const mockUpdateDelivery = jest.fn<MockFn>();
const mockRevokeDeviceByEndpoint = jest.fn<MockFn>();

jest.unstable_mockModule('./pushDeliveryService.js', () => ({
  deliverWebPush: mockDeliverWebPush,
  isWebPushConfigured: () => true,
  getVapidPublicKey: () => 'test-public',
}));

jest.unstable_mockModule('./notificationRepository.js', () => ({
  claimPendingEvent: mockClaimPendingEvent,
  getTenantPolicyMap: mockGetTenantPolicyMap,
  markEventDone: mockMarkEventDone,
  markEventFailed: mockMarkEventFailed,
  listRecipientCandidateIds: mockListRecipientCandidateIds,
  isUserActive: mockIsUserActive,
  getActorIdentity: mockGetActorIdentity,
  listUserNotificationProfiles: mockListUserNotificationProfiles,
  getUserPreferenceMap: mockGetUserPreferenceMap,
  getUserPreferenceMaps: mockGetUserPreferenceMaps,
  insertInbox: mockInsertInbox,
  insertDelivery: mockInsertDelivery,
  listActivePushSubscriptionsForUser: mockListActivePushSubscriptionsForUser,
  listActivePushSubscriptionsForUsers: mockListActivePushSubscriptionsForUsers,
  getDeviceTypePreferenceMap: mockGetDeviceTypePreferenceMap,
  getDeviceTypePreferenceMaps: mockGetDeviceTypePreferenceMaps,
  hasSubmittedWebPush: mockHasSubmittedWebPush,
  updateDelivery: mockUpdateDelivery,
  revokeDeviceByEndpoint: mockRevokeDeviceByEndpoint,
}));

const { processNotificationEvent } = await import('./notificationWorker.js');

const pendingEvent = (overrides: Record<string, unknown> = {}) => ({
  id: 'evt-1',
  typeKey: 'SALE_VOIDED',
  entityType: 'sale',
  entityId: 'sale-1',
  idempotencyKey: 'SALE_VOIDED:sale:sale-1',
  payload: {},
  actorUserId: 'u1',
  storeLocationId: 'store-a',
  occurredAt: new Date().toISOString(),
  status: 'PROCESSING',
  retryCount: 0,
  ...overrides,
});

const inbox = (overrides: Record<string, unknown> = {}) => ({
  id: 'n1',
  eventId: 'evt-1',
  recipientUserId: 'user-allowed',
  typeKey: 'SALE_VOIDED',
  severity: 'WARNING',
  title: 'Sale cancelled / voided',
  body: 'A sale was voided or cancelled.',
  entityType: 'sale',
  entityId: 'sale-1',
  navigationPath: '/sales',
  isRead: false,
  readAt: null,
  createdAt: new Date().toISOString(),
  ...overrides,
});

const device = (overrides: Record<string, unknown> = {}) => ({
  id: 'sub-1',
  userId: 'user-1',
  endpoint: 'https://push.example/abc',
  p256dh: 'p',
  auth: 'a',
  clientInstallationId: 'inst-1',
  platformHint: 'android',
  browserHint: 'Chrome',
  displayName: 'Phone',
  permissionState: 'granted',
  pushEnabled: true,
  lastSeenAt: new Date().toISOString(),
  createdAt: new Date().toISOString(),
  revokedAt: null,
  ...overrides,
});

describe('notification processing policy', () => {
  const pool = { name: 'tenant-a' } as unknown as Pool;

  beforeEach(() => {
    mockDeliverWebPush.mockResolvedValue({
      status: 'SUBMITTED',
      providerStatus: 201,
      category: 'web_push_accepted',
      errorReason: null,
    });
    mockMarkEventDone.mockResolvedValue(undefined);
    mockInsertDelivery.mockResolvedValue('d1');
    mockGetDeviceTypePreferenceMap.mockResolvedValue(new Map());
    mockGetDeviceTypePreferenceMaps.mockResolvedValue(new Map());
    mockListUserNotificationProfiles.mockResolvedValue(new Map());
    mockGetUserPreferenceMaps.mockResolvedValue(new Map());
    mockListActivePushSubscriptionsForUsers.mockResolvedValue(new Map());
    mockHasSubmittedWebPush.mockResolvedValue(false);
    mockUpdateDelivery.mockResolvedValue(undefined);
    mockRevokeDeviceByEndpoint.mockResolvedValue(undefined);
    mockGetActorIdentity.mockResolvedValue({ display: 'John', role: 'CASHIER', isActive: true });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('does not create notifications when tenant policy disables the type', async () => {
    mockClaimPendingEvent.mockResolvedValue(pendingEvent({ typeKey: 'SALE_COMPLETED' }));
    mockGetTenantPolicyMap.mockResolvedValue(
      new Map([['SALE_COMPLETED', { isAllowed: false, lockScreenDetail: false }]]),
    );

    const result = await processNotificationEvent(pool, 'evt-1', 'tenant-a');
    expect(result).toEqual({ created: 0, pushed: 0 });
    expect(mockMarkEventDone).toHaveBeenCalled();
    expect(mockInsertInbox).not.toHaveBeenCalled();
  });

  it('resolves recipients with the required permission and store scope', async () => {
    mockClaimPendingEvent.mockResolvedValue(pendingEvent());
    mockGetTenantPolicyMap.mockResolvedValue(new Map());
    mockListRecipientCandidateIds.mockResolvedValue(['user-allowed']);
    mockGetUserPreferenceMap.mockResolvedValue(new Map());
    mockGetUserPreferenceMaps.mockResolvedValue(new Map([['user-allowed', new Map()]]));
    mockInsertInbox.mockResolvedValue(inbox());
    mockListActivePushSubscriptionsForUser.mockResolvedValue([]);
    mockListActivePushSubscriptionsForUsers.mockResolvedValue(new Map([['user-allowed', []]]));

    const result = await processNotificationEvent(pool, 'evt-1', 'tenant-a');
    expect(mockListRecipientCandidateIds).toHaveBeenCalledWith(pool, 'sales.read', 'store-a');
    expect(result?.created).toBe(1);
    expect(mockInsertInbox).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({ recipientUserId: 'user-allowed' }),
    );
  });

  it('is idempotent: second claim of the same event is a no-op', async () => {
    mockClaimPendingEvent.mockResolvedValue(null);
    const result = await processNotificationEvent(pool, 'evt-dup', 'tenant-a');
    expect(result).toBeNull();
  });

  it('records SUBMITTED rather than DELIVERED when the push service accepts the request', async () => {
    mockClaimPendingEvent.mockResolvedValue(
      pendingEvent({
        id: 'evt-3',
        typeKey: 'NOTIFICATION_TEST',
        entityType: 'user',
        entityId: 'user-1',
        payload: { subjectUserId: 'user-1' },
        storeLocationId: null,
      }),
    );
    mockGetTenantPolicyMap.mockResolvedValue(new Map());
    mockIsUserActive.mockResolvedValue(true);
    mockGetUserPreferenceMaps.mockResolvedValue(new Map([['user-1', new Map()]]));
    mockInsertInbox.mockResolvedValue(inbox({ id: 'n-test', recipientUserId: 'user-1', typeKey: 'NOTIFICATION_TEST' }));
    mockListActivePushSubscriptionsForUsers.mockResolvedValue(new Map([['user-1', [device()]]]));

    const result = await processNotificationEvent(pool, 'evt-3', 'tenant-a');
    expect(result?.pushed).toBe(1);
    expect(mockUpdateDelivery).toHaveBeenCalledWith(
      pool,
      'd1',
      expect.objectContaining({ status: 'SUBMITTED' }),
    );
    const status = (mockUpdateDelivery.mock.calls[0]?.[2] as { status: string }).status;
    expect(status).not.toBe('DELIVERED');
  });

  it('revokes a subscription when the push service reports it gone', async () => {
    mockDeliverWebPush.mockResolvedValue({
      status: 'INVALID_SUBSCRIPTION',
      providerStatus: 410,
      category: 'subscription_gone',
      errorReason: 'Gone',
    });
    mockClaimPendingEvent.mockResolvedValue(
      pendingEvent({
        typeKey: 'NOTIFICATION_TEST',
        payload: { subjectUserId: 'user-1' },
        storeLocationId: null,
      }),
    );
    mockGetTenantPolicyMap.mockResolvedValue(new Map());
    mockIsUserActive.mockResolvedValue(true);
    mockGetUserPreferenceMaps.mockResolvedValue(new Map([['user-1', new Map()]]));
    mockInsertInbox.mockResolvedValue(inbox({ recipientUserId: 'user-1', typeKey: 'NOTIFICATION_TEST' }));
    mockListActivePushSubscriptionsForUsers.mockResolvedValue(
      new Map([['user-1', [device({ id: 'sub-gone', endpoint: 'https://push.example/gone', platformHint: 'ios' })]]]),
    );

    await processNotificationEvent(pool, 'evt-4', 'tenant-a');
    expect(mockRevokeDeviceByEndpoint).toHaveBeenCalledWith(pool, 'https://push.example/gone');
  });

  it('never queries a second pool object', async () => {
    const poolA = { name: 'tenant-a' } as unknown as Pool;
    mockClaimPendingEvent.mockImplementation(async (db) => {
      expect(db).toBe(poolA);
      return pendingEvent({ typeKey: 'SALE_COMPLETED' });
    });
    mockGetTenantPolicyMap.mockImplementation(async (db) => {
      expect(db).toBe(poolA);
      return new Map([['SALE_COMPLETED', { isAllowed: false, lockScreenDetail: false }]]);
    });
    mockMarkEventDone.mockImplementation(async (db) => {
      expect(db).toBe(poolA);
    });
    await processNotificationEvent(poolA, 'evt-iso', 'tenant-a');
  });

  it('does not notify users without the required permission', async () => {
    mockClaimPendingEvent.mockResolvedValue(pendingEvent());
    mockGetTenantPolicyMap.mockResolvedValue(new Map());
    mockListRecipientCandidateIds.mockResolvedValue([]);
    mockGetUserPreferenceMaps.mockResolvedValue(new Map());

    const result = await processNotificationEvent(pool, 'evt-1', 'tenant-a');
    expect(result?.created).toBe(0);
    expect(mockInsertInbox).not.toHaveBeenCalled();
    expect(mockDeliverWebPush).not.toHaveBeenCalled();
  });

  it('skips a recipient who opted out of both channels', async () => {
    mockClaimPendingEvent.mockResolvedValue(pendingEvent());
    mockGetTenantPolicyMap.mockResolvedValue(new Map());
    mockListRecipientCandidateIds.mockResolvedValue(['user-allowed']);
    mockGetUserPreferenceMaps.mockResolvedValue(
      new Map([['user-allowed', new Map([['SALE_VOIDED', { inAppEnabled: false, pushEnabled: false }]])]]),
    );

    const result = await processNotificationEvent(pool, 'evt-1', 'tenant-a');
    expect(result?.created).toBe(0);
    expect(mockInsertInbox).not.toHaveBeenCalled();
  });

  it('creates an inbox record and pushes when only the push channel is enabled', async () => {
    mockClaimPendingEvent.mockResolvedValue(pendingEvent());
    mockGetTenantPolicyMap.mockResolvedValue(new Map());
    mockListRecipientCandidateIds.mockResolvedValue(['user-allowed']);
    mockGetUserPreferenceMaps.mockResolvedValue(
      new Map([['user-allowed', new Map([['SALE_VOIDED', { inAppEnabled: false, pushEnabled: true }]])]]),
    );
    mockInsertInbox.mockResolvedValue(inbox());
    mockListActivePushSubscriptionsForUsers.mockResolvedValue(
      new Map([['user-allowed', [device({ userId: 'user-allowed' })]]]),
    );

    const result = await processNotificationEvent(pool, 'evt-1', 'tenant-a');
    expect(result?.created).toBe(1);
    expect(result?.pushed).toBe(1);
    expect(mockDeliverWebPush).toHaveBeenCalled();
  });

  it('does not resubmit push when a SUBMITTED delivery already exists', async () => {
    mockClaimPendingEvent.mockResolvedValue(
      pendingEvent({
        typeKey: 'NOTIFICATION_TEST',
        payload: { subjectUserId: 'user-1' },
        storeLocationId: null,
      }),
    );
    mockGetTenantPolicyMap.mockResolvedValue(new Map());
    mockIsUserActive.mockResolvedValue(true);
    mockGetUserPreferenceMaps.mockResolvedValue(new Map([['user-1', new Map()]]));
    mockInsertInbox.mockResolvedValue(inbox({ recipientUserId: 'user-1', typeKey: 'NOTIFICATION_TEST' }));
    mockListActivePushSubscriptionsForUsers.mockResolvedValue(new Map([['user-1', [device()]]]));
    mockHasSubmittedWebPush.mockResolvedValue(true);

    const result = await processNotificationEvent(pool, 'evt-1', 'tenant-a');
    expect(result?.pushed).toBe(0);
    expect(mockDeliverWebPush).not.toHaveBeenCalled();
  });

  it('does not notify a deactivated subject user', async () => {
    mockClaimPendingEvent.mockResolvedValue(
      pendingEvent({
        typeKey: 'SECURITY_PASSWORD_CHANGED',
        payload: { subjectUserId: 'user-disabled' },
        storeLocationId: null,
      }),
    );
    mockGetTenantPolicyMap.mockResolvedValue(new Map());
    mockIsUserActive.mockResolvedValue(false);
    mockGetUserPreferenceMaps.mockResolvedValue(new Map());

    const result = await processNotificationEvent(pool, 'evt-1', 'tenant-a');
    expect(mockIsUserActive).toHaveBeenCalledWith(pool, 'user-disabled');
    expect(result?.created).toBe(0);
    expect(mockInsertInbox).not.toHaveBeenCalled();
  });

  it('same payment event: Director and Accountant receive, Manager opted out, Cashier not eligible', async () => {
    mockClaimPendingEvent.mockResolvedValue(
      pendingEvent({
        typeKey: 'CUSTOMER_PAYMENT_RECEIVED',
        entityType: 'customer',
        entityId: 'cust-1',
        storeLocationId: null,
      }),
    );
    mockGetTenantPolicyMap.mockResolvedValue(new Map());
    mockListRecipientCandidateIds.mockResolvedValue(['director', 'manager', 'accountant']);
    mockListUserNotificationProfiles.mockResolvedValue(
      new Map([
        ['director', { role: 'ADMIN', rbacNames: [] }],
        ['manager', { role: 'MANAGER', rbacNames: [] }],
        ['accountant', { role: 'STAFF', rbacNames: ['Accountant'] }],
      ]),
    );
    mockGetUserPreferenceMaps.mockResolvedValue(
      new Map([
        ['director', new Map([['CUSTOMER_PAYMENT_RECEIVED', { inAppEnabled: true, pushEnabled: false }]])],
        ['manager', new Map([['CUSTOMER_PAYMENT_RECEIVED', { inAppEnabled: false, pushEnabled: false }]])],
        ['accountant', new Map([['CUSTOMER_PAYMENT_RECEIVED', { inAppEnabled: true, pushEnabled: false }]])],
      ]),
    );
    mockInsertInbox.mockImplementation(async (_db, input: { recipientUserId: string }) =>
      inbox({
        id: `n-${input.recipientUserId}`,
        recipientUserId: input.recipientUserId,
        typeKey: 'CUSTOMER_PAYMENT_RECEIVED',
      }),
    );

    const result = await processNotificationEvent(pool, 'evt-1', 'tenant-a');
    const recipients = mockInsertInbox.mock.calls.map((call) => (call[1] as { recipientUserId: string }).recipientUserId);
    expect(recipients.sort()).toEqual(['accountant', 'director']);
    expect(result?.created).toBe(2);
  });

  it('same user, two devices: sales push only on iPhone, AR on both', async () => {
    const iphone = device({ id: 'sub-iphone', platformHint: 'ios', clientInstallationId: 'iphone' });
    const laptop = device({ id: 'sub-laptop', platformHint: 'desktop', clientInstallationId: 'laptop' });
    mockClaimPendingEvent.mockResolvedValue(
      pendingEvent({
        typeKey: 'SALE_COMPLETED',
        storeLocationId: 'store-a',
      }),
    );
    mockGetTenantPolicyMap.mockResolvedValue(new Map());
    mockListRecipientCandidateIds.mockResolvedValue(['director']);
    mockListUserNotificationProfiles.mockResolvedValue(new Map([['director', { role: 'ADMIN', rbacNames: [] }]]));
    mockGetUserPreferenceMaps.mockResolvedValue(
      new Map([['director', new Map([['SALE_COMPLETED', { inAppEnabled: true, pushEnabled: true }]])]]),
    );
    mockInsertInbox.mockResolvedValue(inbox({ recipientUserId: 'director', typeKey: 'SALE_COMPLETED' }));
    mockListActivePushSubscriptionsForUsers.mockResolvedValue(new Map([['director', [iphone, laptop]]]));
    mockGetDeviceTypePreferenceMaps.mockResolvedValue(
      new Map([
        ['sub-iphone', new Map([['SALE_COMPLETED', true], ['CUSTOMER_PAYMENT_RECEIVED', true]])],
        ['sub-laptop', new Map([['SALE_COMPLETED', false], ['CUSTOMER_PAYMENT_RECEIVED', true]])],
      ]),
    );
    mockInsertDelivery.mockImplementation(async (_db, input: { channel: string; subscriptionId: string | null }) =>
      input.channel === 'WEB_PUSH' ? `d-${input.subscriptionId}` : 'd-inapp',
    );

    const sale = await processNotificationEvent(pool, 'evt-1', 'tenant-a');
    expect(sale?.pushed).toBe(1);
    expect(mockDeliverWebPush).toHaveBeenCalledTimes(1);
    expect((mockDeliverWebPush.mock.calls[0]?.[0] as { endpoint: string }).endpoint).toBe(iphone.endpoint);
  });

  it('revoking device A does not stop device B', async () => {
    const remaining = device({ id: 'sub-b', userId: 'director', endpoint: 'https://push.example/b' });
    mockClaimPendingEvent.mockResolvedValue(
      pendingEvent({ typeKey: 'NOTIFICATION_TEST', payload: { subjectUserId: 'director' }, storeLocationId: null }),
    );
    mockGetTenantPolicyMap.mockResolvedValue(new Map());
    mockIsUserActive.mockResolvedValue(true);
    mockListUserNotificationProfiles.mockResolvedValue(new Map([['director', { role: 'ADMIN', rbacNames: [] }]]));
    mockGetUserPreferenceMaps.mockResolvedValue(new Map([['director', new Map()]]));
    mockInsertInbox.mockResolvedValue(inbox({ recipientUserId: 'director', typeKey: 'NOTIFICATION_TEST' }));
    mockListActivePushSubscriptionsForUsers.mockResolvedValue(new Map([['director', [remaining]]]));

    const result = await processNotificationEvent(pool, 'evt-1', 'tenant-a');
    expect(result?.pushed).toBe(1);
    expect(mockDeliverWebPush).toHaveBeenCalledTimes(1);
    expect((mockDeliverWebPush.mock.calls[0]?.[0] as { endpoint: string }).endpoint).toBe(remaining.endpoint);
  });

  it('keeps the inbox row when web push submission fails', async () => {
    mockDeliverWebPush.mockResolvedValue({
      status: 'FAILED',
      providerStatus: 503,
      category: 'web_push_rejected',
      errorReason: 'unavailable',
    });
    mockClaimPendingEvent.mockResolvedValue(
      pendingEvent({ typeKey: 'NOTIFICATION_TEST', payload: { subjectUserId: 'user-1' }, storeLocationId: null }),
    );
    mockGetTenantPolicyMap.mockResolvedValue(new Map());
    mockIsUserActive.mockResolvedValue(true);
    mockGetUserPreferenceMaps.mockResolvedValue(new Map([['user-1', new Map()]]));
    mockInsertInbox.mockResolvedValue(inbox({ recipientUserId: 'user-1', typeKey: 'NOTIFICATION_TEST' }));
    mockListActivePushSubscriptionsForUsers.mockResolvedValue(new Map([['user-1', [device()]]]));

    const result = await processNotificationEvent(pool, 'evt-1', 'tenant-a');
    expect(mockInsertInbox).toHaveBeenCalled();
    expect(result?.created).toBe(1);
    expect(result?.pushed).toBe(0);
  });

  it('still creates a password-change inbox when the user opted out', async () => {
    mockClaimPendingEvent.mockResolvedValue(
      pendingEvent({
        typeKey: 'SECURITY_PASSWORD_CHANGED',
        payload: { subjectUserId: 'user-1' },
        storeLocationId: null,
      }),
    );
    mockGetTenantPolicyMap.mockResolvedValue(new Map());
    mockIsUserActive.mockResolvedValue(true);
    mockListUserNotificationProfiles.mockResolvedValue(new Map([['user-1', { role: 'CASHIER', rbacNames: [] }]]));
    mockGetUserPreferenceMaps.mockResolvedValue(
      new Map([['user-1', new Map([['SECURITY_PASSWORD_CHANGED', { inAppEnabled: false, pushEnabled: false }]])]]),
    );
    mockInsertInbox.mockResolvedValue(inbox({ recipientUserId: 'user-1', typeKey: 'SECURITY_PASSWORD_CHANGED' }));
    mockListActivePushSubscriptionsForUsers.mockResolvedValue(new Map([['user-1', []]]));

    const result = await processNotificationEvent(pool, 'evt-1', 'tenant-a');
    expect(result?.created).toBe(1);
  });

  it('notifies the director phone when a cashier completes a sale — cashier settings are unused', async () => {
    mockClaimPendingEvent.mockResolvedValue(
      pendingEvent({ typeKey: 'SALE_COMPLETED', actorUserId: 'cashier', storeLocationId: 'store-a' }),
    );
    mockGetTenantPolicyMap.mockResolvedValue(new Map());
    mockListRecipientCandidateIds.mockResolvedValue(['cashier', 'director']);
    mockListUserNotificationProfiles.mockResolvedValue(
      new Map([
        ['cashier', { role: 'CASHIER', rbacNames: [] }],
        ['director', { role: 'STAFF', rbacNames: ['Director'] }],
      ]),
    );
    mockGetUserPreferenceMaps.mockResolvedValue(
      new Map([
        ['cashier', new Map([['SALE_COMPLETED', { inAppEnabled: false, pushEnabled: false }]])],
        ['director', new Map()],
      ]),
    );
    mockInsertInbox.mockResolvedValue(inbox({ recipientUserId: 'director', typeKey: 'SALE_COMPLETED' }));
    mockListActivePushSubscriptionsForUsers.mockResolvedValue(
      new Map([['director', [device({ userId: 'director' })]]]),
    );

    const result = await processNotificationEvent(pool, 'evt-1', 'tenant-a');
    expect(result?.created).toBe(1);
    expect(result?.pushed).toBe(1);
    expect(mockInsertInbox).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({ recipientUserId: 'director' }),
    );
    const notified = mockInsertInbox.mock.calls.map((call) => (call[1] as { recipientUserId: string }).recipientUserId);
    expect(notified).not.toContain('cashier');
  });

  it('notifies managers of completed sales from role defaults when they never saved type prefs', async () => {
    mockClaimPendingEvent.mockResolvedValue(pendingEvent({ typeKey: 'SALE_COMPLETED', storeLocationId: 'store-a' }));
    mockGetTenantPolicyMap.mockResolvedValue(new Map());
    mockListRecipientCandidateIds.mockResolvedValue(['manager']);
    mockListUserNotificationProfiles.mockResolvedValue(new Map([['manager', { role: 'MANAGER', rbacNames: [] }]]));
    mockGetUserPreferenceMaps.mockResolvedValue(new Map([['manager', new Map()]]));
    mockInsertInbox.mockResolvedValue(inbox({ recipientUserId: 'manager', typeKey: 'SALE_COMPLETED' }));
    mockListActivePushSubscriptionsForUsers.mockResolvedValue(
      new Map([['manager', [device({ userId: 'manager' })]]]),
    );

    const result = await processNotificationEvent(pool, 'evt-1', 'tenant-a');
    expect(result?.created).toBe(1);
    expect(result?.pushed).toBe(1);
    expect(mockDeliverWebPush).toHaveBeenCalled();
  });

  it('does not notify cashiers of completed sales by default', async () => {
    mockClaimPendingEvent.mockResolvedValue(pendingEvent({ typeKey: 'SALE_COMPLETED', storeLocationId: 'store-a' }));
    mockGetTenantPolicyMap.mockResolvedValue(new Map());
    mockListRecipientCandidateIds.mockResolvedValue(['cashier']);
    mockListUserNotificationProfiles.mockResolvedValue(new Map([['cashier', { role: 'CASHIER', rbacNames: [] }]]));
    mockGetUserPreferenceMaps.mockResolvedValue(new Map([['cashier', new Map()]]));

    const result = await processNotificationEvent(pool, 'evt-1', 'tenant-a');
    expect(result?.created).toBe(0);
    expect(mockInsertInbox).not.toHaveBeenCalled();
    expect(mockDeliverWebPush).not.toHaveBeenCalled();
  });

  it('notifies every eligible sale when the user explicitly enables SALE_COMPLETED', async () => {
    mockClaimPendingEvent.mockResolvedValue(pendingEvent({ typeKey: 'SALE_COMPLETED', storeLocationId: 'store-a' }));
    mockGetTenantPolicyMap.mockResolvedValue(new Map());
    mockListRecipientCandidateIds.mockResolvedValue(['manager']);
    mockListUserNotificationProfiles.mockResolvedValue(new Map([['manager', { role: 'MANAGER', rbacNames: [] }]]));
    mockGetUserPreferenceMaps.mockResolvedValue(
      new Map([['manager', new Map([['SALE_COMPLETED', { inAppEnabled: true, pushEnabled: false }]])]]),
    );
    mockInsertInbox.mockResolvedValue(inbox({ recipientUserId: 'manager', typeKey: 'SALE_COMPLETED' }));
    mockListActivePushSubscriptionsForUsers.mockResolvedValue(new Map([['manager', []]]));

    const result = await processNotificationEvent(pool, 'evt-1', 'tenant-a');
    expect(result?.created).toBe(1);
    expect(mockListRecipientCandidateIds).toHaveBeenCalledWith(pool, 'sales.read', 'store-a');
  });

  it('does not notify a Kampala-only manager when recipients resolve to the Entebbe user only', async () => {
    mockClaimPendingEvent.mockResolvedValue(pendingEvent({ storeLocationId: 'entebbe' }));
    mockGetTenantPolicyMap.mockResolvedValue(new Map());
    mockListRecipientCandidateIds.mockResolvedValue(['manager-entebbe']);
    mockGetUserPreferenceMaps.mockResolvedValue(new Map([['manager-entebbe', new Map()]]));
    mockInsertInbox.mockResolvedValue(inbox({ recipientUserId: 'manager-entebbe' }));
    mockListActivePushSubscriptionsForUsers.mockResolvedValue(new Map([['manager-entebbe', []]]));

    await processNotificationEvent(pool, 'evt-1', 'tenant-a');
    expect(mockListRecipientCandidateIds).toHaveBeenCalledWith(pool, 'sales.read', 'entebbe');
    expect(mockInsertInbox).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({ recipientUserId: 'manager-entebbe' }),
    );
    const notified = mockInsertInbox.mock.calls.map((call) => (call[1] as { recipientUserId: string }).recipientUserId);
    expect(notified).not.toContain('manager-kampala');
  });

  it('keeps cashier John as actor after he is disabled; manager Mary still receives', async () => {
    mockClaimPendingEvent.mockResolvedValue(
      pendingEvent({
        typeKey: 'SALE_VOIDED',
        actorUserId: 'john',
        payload: { documentRef: 'SAL-10482', amount: 250000, currency: 'UGX', locationLabel: 'Kampala Branch' },
        storeLocationId: 'kampala',
      }),
    );
    mockGetTenantPolicyMap.mockResolvedValue(new Map());
    mockListRecipientCandidateIds.mockResolvedValue(['john', 'mary']);
    mockGetActorIdentity.mockResolvedValue({ display: 'John', role: 'CASHIER', isActive: false });
    mockListUserNotificationProfiles.mockResolvedValue(
      new Map([
        ['john', { role: 'CASHIER', rbacNames: [] }],
        ['mary', { role: 'MANAGER', rbacNames: [] }],
      ]),
    );
    mockGetUserPreferenceMaps.mockResolvedValue(
      new Map([
        ['john', new Map()],
        ['mary', new Map()],
      ]),
    );
    mockInsertInbox.mockResolvedValue(inbox({ recipientUserId: 'mary', typeKey: 'SALE_VOIDED' }));
    mockListActivePushSubscriptionsForUsers.mockResolvedValue(new Map([['mary', []]]));

    const result = await processNotificationEvent(pool, 'evt-1', 'tenant-a');
    expect(mockGetActorIdentity).toHaveBeenCalledWith(pool, 'john');
    const recipients = mockInsertInbox.mock.calls.map((call) => (call[1] as { recipientUserId: string }).recipientUserId);
    expect(recipients).toEqual(['mary']);
    expect(recipients).not.toContain('john');
    expect(mockInsertInbox).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        recipientUserId: 'mary',
        actorUserId: 'john',
        actorDisplay: 'John',
        documentRef: 'SAL-10482',
        locationLabel: 'Kampala Branch',
        body: expect.stringContaining('John'),
      }),
    );
    expect(result?.created).toBe(1);
  });

  it('does not send lock-screen push body with the sale amount', async () => {
    mockClaimPendingEvent.mockResolvedValue(
      pendingEvent({
        typeKey: 'SALE_COMPLETED',
        actorUserId: 'john',
        payload: { documentRef: 'SAL-10482', amount: 250000, currency: 'UGX', summary: 'Sale SAL-10482 UGX 250,000' },
      }),
    );
    mockGetTenantPolicyMap.mockResolvedValue(new Map());
    mockListRecipientCandidateIds.mockResolvedValue(['mary']);
    mockGetUserPreferenceMaps.mockResolvedValue(
      new Map([['mary', new Map([['SALE_COMPLETED', { inAppEnabled: true, pushEnabled: true }]])]]),
    );
    mockInsertInbox.mockResolvedValue(inbox({ recipientUserId: 'mary', typeKey: 'SALE_COMPLETED' }));
    mockListActivePushSubscriptionsForUsers.mockResolvedValue(
      new Map([['mary', [device({ userId: 'mary' })]]]),
    );

    await processNotificationEvent(pool, 'evt-1', 'tenant-a');
    const pushPayload = mockDeliverWebPush.mock.calls[0]?.[1] as { body: string };
    expect(pushPayload.body).not.toMatch(/250,?000/);
    expect(mockInsertInbox.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ body: expect.stringMatching(/UGX/) }),
    );
  });
});
