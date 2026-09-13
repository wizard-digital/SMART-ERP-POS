import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type { Pool } from 'pg';

type MockFn = (...args: unknown[]) => Promise<unknown>;

const mockInsertEvent = jest.fn<MockFn>();
const mockListActivePushSubscriptionsForUser = jest.fn<MockFn>();
const mockListWebPushDeliveriesForEvent = jest.fn<MockFn>();
const mockUpsertDeviceSubscription = jest.fn<MockFn>();
const mockProcessNotificationEvent = jest.fn<MockFn>();

jest.unstable_mockModule('./notificationWorker.js', () => ({
  processNotificationEvent: mockProcessNotificationEvent,
}));

jest.unstable_mockModule('./notificationRepository.js', () => ({
  insertEvent: mockInsertEvent,
  listActivePushSubscriptionsForUser: mockListActivePushSubscriptionsForUser,
  listWebPushDeliveriesForEvent: mockListWebPushDeliveriesForEvent,
  upsertDeviceSubscription: mockUpsertDeviceSubscription,
}));

const { sendTestNotification, registerDevice } = await import('./notificationService.js');

process.env.VAPID_PUBLIC_KEY = 'test-public';
process.env.VAPID_PRIVATE_KEY = 'test-private';

const pool = {} as Pool;
const userId = '11111111-2222-4333-a444-555555555555';

describe('sendTestNotification handler', () => {
  afterEach(() => {
    jest.clearAllMocks();
    process.env.VAPID_PUBLIC_KEY = 'test-public';
    process.env.VAPID_PRIVATE_KEY = 'test-private';
  });

  it('records NOTIFICATION_TEST, processes it, and tells the operator to enable when no device is registered', async () => {
    mockListActivePushSubscriptionsForUser.mockResolvedValue([]);
    mockInsertEvent.mockResolvedValue({ id: 'evt-test' });
    mockProcessNotificationEvent.mockResolvedValue({ created: 1, pushed: 0 });
    mockListWebPushDeliveriesForEvent.mockResolvedValue([]);

    const result = await sendTestNotification(pool, userId, 'tenant-1');

    expect(mockInsertEvent).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        typeKey: 'NOTIFICATION_TEST',
        entityType: 'user',
        entityId: userId,
        actorUserId: userId,
        payload: expect.objectContaining({
          summary: 'Test notification from SMART-ERP-POS',
          subjectUserId: userId,
        }),
      }),
    );
    expect(mockProcessNotificationEvent).toHaveBeenCalledWith(pool, 'evt-test', 'tenant-1');
    expect(result.status).toBe('device_not_registered');
    expect(result.reason).toContain('Enable notifications on this device first');
    expect(result.created).toBe(1);
    expect(result.pushed).toBe(0);
  });

  it('returns submitted only when the push service accepted the request', async () => {
    mockListActivePushSubscriptionsForUser.mockResolvedValue([{ id: 'sub-1' }]);
    mockInsertEvent.mockResolvedValue({ id: 'evt-test' });
    mockProcessNotificationEvent.mockResolvedValue({ created: 1, pushed: 1 });
    mockListWebPushDeliveriesForEvent.mockResolvedValue([
      { status: 'SUBMITTED', providerStatus: 201, category: 'web_push_accepted', errorReason: null },
    ]);

    const result = await sendTestNotification(pool, userId, 'tenant-1');

    expect(result.status).toBe('submitted');
    expect(result.reason).toContain('not proof the device displayed');
    expect(result.pushed).toBe(1);
    expect(result.providerStatus).toBe(201);
  });

  it('does not call a 401 WNS channel delivered — it tells the operator to Enable again', async () => {
    mockListActivePushSubscriptionsForUser.mockResolvedValue([{ id: 'sub-1' }]);
    mockInsertEvent.mockResolvedValue({ id: 'evt-test' });
    mockProcessNotificationEvent.mockResolvedValue({ created: 1, pushed: 0 });
    mockListWebPushDeliveriesForEvent.mockResolvedValue([
      {
        status: 'INVALID_SUBSCRIPTION',
        providerStatus: 401,
        category: 'subscription_unauthorized',
        errorReason: 'Received unexpected response code',
      },
    ]);

    const result = await sendTestNotification(pool, userId, 'tenant-1');

    expect(result.status).toBe('failed');
    expect(result.reason).toContain('Enable notifications on this device again');
    expect(result.reason).toContain('401');
  });
});

describe('registerDevice handler', () => {
  it('rejects a non-https push endpoint', async () => {
    await expect(
      registerDevice(pool, userId, {
        endpoint: 'http://insecure.example/push',
        p256dh: 'p',
        auth: 'a',
        clientInstallationId: 'install-1',
      }),
    ).rejects.toMatchObject({ statusCode: 400, message: 'Push endpoint must be https' });
    expect(mockUpsertDeviceSubscription).not.toHaveBeenCalled();
  });
});
