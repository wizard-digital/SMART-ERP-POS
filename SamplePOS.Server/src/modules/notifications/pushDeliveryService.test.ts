import { describe, expect, it } from '@jest/globals';
import {
  classifyWebPushFailure,
  describePushTestOutcome,
  webPushErrorText,
} from './pushDeliveryService.js';

describe('web push failure classification', () => {
  it('uses message when WNS/FCM leave body empty', () => {
    expect(webPushErrorText({ statusCode: 401, body: '', message: 'Received unexpected response code' }))
      .toBe('Received unexpected response code');
  });

  it('treats WNS/FCM 401 and 403 as a dead subscription, not a generic reject', () => {
    const unauthorized = classifyWebPushFailure({
      statusCode: 401,
      body: '',
      message: 'Received unexpected response code',
    });
    expect(unauthorized.status).toBe('INVALID_SUBSCRIPTION');
    expect(unauthorized.category).toBe('subscription_unauthorized');
    expect(unauthorized.providerStatus).toBe(401);
    expect(unauthorized.errorReason).toContain('Received unexpected response code');

    const forbidden = classifyWebPushFailure({ statusCode: 403, body: 'UnauthorizedRegistration' });
    expect(forbidden.status).toBe('INVALID_SUBSCRIPTION');
    expect(forbidden.category).toBe('subscription_unauthorized');
  });

  it('still treats 410 as gone', () => {
    const gone = classifyWebPushFailure({ statusCode: 410, body: 'Gone' });
    expect(gone.status).toBe('INVALID_SUBSCRIPTION');
    expect(gone.category).toBe('subscription_gone');
  });
});

describe('push test outcome copy', () => {
  it('tells the operator to re-enable after an expired WNS channel', () => {
    const outcome = describePushTestOutcome({
      vapidConfigured: true,
      devicesRegistered: 1,
      created: 1,
      pushed: 0,
      deliveries: [{
        status: 'INVALID_SUBSCRIPTION',
        providerStatus: 401,
        category: 'subscription_unauthorized',
        errorReason: 'Received unexpected response code',
      }],
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.reason).toContain('Enable notifications on this device again');
    expect(outcome.reason).toContain('401');
  });

  it('does not hide a provider rejection behind a generic sentence', () => {
    const outcome = describePushTestOutcome({
      vapidConfigured: true,
      devicesRegistered: 1,
      created: 1,
      pushed: 0,
      deliveries: [{
        status: 'FAILED',
        providerStatus: 500,
        category: 'web_push_rejected',
        errorReason: 'push service unavailable',
      }],
    });
    expect(outcome.reason).toBe('push service unavailable');
  });
});
