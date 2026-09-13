import { describe, expect, it } from 'vitest';
import { detectPushCapability } from './pushCapability';

describe('push capability feature detection', () => {
  it('requires PushManager + Notification + serviceWorker to subscribe', () => {
    const caps = detectPushCapability({
      Notification: { permission: 'default' },
      PushManager: function PushManager() {},
      navigator: { serviceWorker: {} },
      matchMedia: () => ({ matches: false }),
    });
    expect(caps.canSubscribe).toBe(true);
    expect(caps.needsHomeScreenInstall).toBe(false);
  });

  it('guides Home Screen install when SW exists but PushManager does not and the app is not standalone', () => {
    const caps = detectPushCapability({
      navigator: { serviceWorker: {}, standalone: false },
      matchMedia: () => ({ matches: false }),
    });
    expect(caps.canSubscribe).toBe(false);
    expect(caps.needsHomeScreenInstall).toBe(true);
  });

  it('does not treat a missing window as a supported push environment', () => {
    const caps = detectPushCapability(null);
    expect(caps.canSubscribe).toBe(false);
    expect(caps.permission).toBe('unsupported');
  });

  it('does not offer subscribe on an insecure non-localhost page', () => {
    const caps = detectPushCapability({
      Notification: { permission: 'granted' },
      PushManager: function PushManager() {},
      isSecureContext: false,
      navigator: { serviceWorker: {} },
      matchMedia: () => ({ matches: false }),
    });
    expect(caps.canSubscribe).toBe(false);
  });
});
