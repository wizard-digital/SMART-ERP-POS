/**
 * Feature-detect Web Push / Notification capability.
 * Does not use user-agent as device identity. iOS Home Screen is detected via
 * display-mode / navigator.standalone because PushManager is absent in Safari tabs.
 */

export type PushCapability = {
  serviceWorker: boolean;
  notificationApi: boolean;
  pushManager: boolean;
  standalone: boolean;
  permission: NotificationPermission | 'unsupported';
  canSubscribe: boolean;
  needsHomeScreenInstall: boolean;
};

export type PushCapabilityHost = {
  Notification?: { permission?: NotificationPermission };
  PushManager?: unknown;
  isSecureContext?: boolean;
  navigator?: {
    serviceWorker?: unknown;
    standalone?: boolean;
  };
  matchMedia?: (query: string) => { matches: boolean };
};

export function detectPushCapability(
  host: PushCapabilityHost | null | undefined = typeof window !== 'undefined'
    ? (window as unknown as PushCapabilityHost)
    : null,
): PushCapability {
  if (!host) {
    return {
      serviceWorker: false,
      notificationApi: false,
      pushManager: false,
      standalone: false,
      permission: 'unsupported',
      canSubscribe: false,
      needsHomeScreenInstall: false,
    };
  }

  const serviceWorker = Boolean(host.navigator && 'serviceWorker' in host.navigator);
  const notificationApi = typeof host.Notification !== 'undefined';
  const pushManager = typeof host.PushManager !== 'undefined';
  const secure = host.isSecureContext !== false;
  const standalone =
    (typeof host.matchMedia === 'function' && host.matchMedia('(display-mode: standalone)').matches)
    || host.navigator?.standalone === true;
  const permission: NotificationPermission | 'unsupported' = notificationApi
    ? (host.Notification?.permission ?? 'default')
    : 'unsupported';
  const canSubscribe = secure && serviceWorker && notificationApi && pushManager;
  const needsHomeScreenInstall = serviceWorker && !pushManager && !standalone;

  return {
    serviceWorker,
    notificationApi,
    pushManager,
    standalone,
    permission,
    canSubscribe,
    needsHomeScreenInstall,
  };
}
