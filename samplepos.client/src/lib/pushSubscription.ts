const INSTALL_KEY = 'smarterp_notification_installation_id';
const SUB_KEY = 'smarterp_notification_subscription_id';

function scopeKey(): string {
  try {
    return typeof window !== 'undefined' ? window.location.hostname || 'default' : 'default';
  } catch {
    return 'default';
  }
}

function readSubMap(): Record<string, string> {
  try {
    const raw = localStorage.getItem(SUB_KEY);
    if (!raw) return {};
    if (raw.startsWith('{')) {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object') return parsed as Record<string, string>;
    }
    return { [scopeKey()]: raw };
  } catch {
    return {};
  }
}

export function getOrCreateInstallationId(): string {
  try {
    const existing = localStorage.getItem(INSTALL_KEY);
    if (existing && existing.length >= 8) return existing;
    const id = crypto.randomUUID();
    localStorage.setItem(INSTALL_KEY, id);
    return id;
  } catch {
    return `ephemeral-${Date.now()}`;
  }
}

export function rememberSubscriptionId(id: string): void {
  try {
    const map = readSubMap();
    map[scopeKey()] = id;
    localStorage.setItem(SUB_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

export function takeRememberedSubscriptionId(): string | null {
  try {
    const map = readSubMap();
    return map[scopeKey()] || null;
  } catch {
    return null;
  }
}

/** Logout: drop this host/tenant's remembered id. Other tenant hosts stay intact. */
export function clearRememberedSubscriptionId(): void {
  try {
    const map = readSubMap();
    delete map[scopeKey()];
    const keys = Object.keys(map);
    if (keys.length === 0) localStorage.removeItem(SUB_KEY);
    else localStorage.setItem(SUB_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

export async function getPushRegistration(): Promise<ServiceWorkerRegistration> {
  if (!('serviceWorker' in navigator)) {
    throw new Error('Service worker is not available in this browser');
  }
  const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  if (registration.installing) {
    await waitForWorkerState(registration.installing);
  } else if (registration.waiting) {
    registration.waiting.postMessage({ type: 'SKIP_WAITING' });
    await waitForWorkerState(registration.waiting);
  }
  if (!registration.active) {
    await navigator.serviceWorker.ready;
  }
  if (!registration.active) {
    throw new Error('Service worker did not activate. Reload the page and try Enable notifications again.');
  }
  return registration;
}

function waitForWorkerState(worker: ServiceWorker): Promise<void> {
  if (worker.state === 'activated' || worker.state === 'installed') return Promise.resolve();
  return new Promise((resolve, reject) => {
    worker.addEventListener('statechange', () => {
      if (worker.state === 'activated' || worker.state === 'installed') resolve();
      if (worker.state === 'redundant') {
        reject(new Error('Service worker install failed. Reload the page and try again.'));
      }
    });
  });
}

export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String.trim() + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}

/** Chrome/Edge require a plain ArrayBuffer, not a Uint8Array view. */
export function applicationServerKeyFromVapid(publicKey: string): ArrayBuffer {
  const bytes = urlBase64ToUint8Array(publicKey);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export async function subscribeThisBrowser(publicKey: string): Promise<PushSubscriptionJSON> {
  const registration = await getPushRegistration();
  const existing = await registration.pushManager.getSubscription();
  if (existing) {
    await existing.unsubscribe();
  }
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: applicationServerKeyFromVapid(publicKey),
  });
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    throw new Error('Browser did not return push subscription keys');
  }
  return json;
}

export function platformHintFromCapabilities(input: {
  standalone: boolean;
  coarsePointer?: boolean;
}): 'android' | 'ios' | 'desktop' | 'unknown' {
  if (typeof navigator === 'undefined') return 'unknown';
  const standaloneIos = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  if (standaloneIos) return 'ios';
  if (input.coarsePointer && input.standalone) return 'android';
  if (!input.coarsePointer) return 'desktop';
  return 'unknown';
}
