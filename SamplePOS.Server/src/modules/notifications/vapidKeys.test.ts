import { describe, expect, it } from '@jest/globals';
import { applyVapidPairToEnv, shouldAutoProvisionVapid, vapidPairFromEnv } from './vapidKeys.js';

describe('vapid key sourcing', () => {
  it('reads a complete pair from env and ignores a public key alone', () => {
    expect(
      vapidPairFromEnv({
        VAPID_PUBLIC_KEY: 'pub',
        VAPID_PRIVATE_KEY: 'priv',
        VAPID_SUBJECT: 'mailto:ops@example.com',
      }),
    ).toEqual({
      publicKey: 'pub',
      privateKey: 'priv',
      subject: 'mailto:ops@example.com',
    });
    expect(vapidPairFromEnv({ VAPID_PUBLIC_KEY: 'pub' })).toBeNull();
  });

  it('auto-provisions only outside production and test', () => {
    expect(shouldAutoProvisionVapid('development')).toBe(true);
    expect(shouldAutoProvisionVapid('production')).toBe(false);
    expect(shouldAutoProvisionVapid('test')).toBe(false);
  });

  it('applies a pair onto env without wiping an existing subject', () => {
    const env: NodeJS.ProcessEnv = { VAPID_SUBJECT: 'mailto:keep@example.com' };
    applyVapidPairToEnv(
      { publicKey: 'a', privateKey: 'b', subject: 'mailto:ops@localhost' },
      env,
    );
    expect(env.VAPID_PUBLIC_KEY).toBe('a');
    expect(env.VAPID_PRIVATE_KEY).toBe('b');
    expect(env.VAPID_SUBJECT).toBe('mailto:keep@example.com');
  });
});
