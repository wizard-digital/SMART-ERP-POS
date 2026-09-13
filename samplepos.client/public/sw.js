/**
 * Service Worker for SMART-ERP-POS
 *
 * Caching strategies:
 *   - Static assets (JS, CSS, images):  CacheFirst
 *   - App shell / navigation:           NetworkFirst → cached shell → offline page
 *   - API GET requests (products, inventory, customers): NetworkFirst → cache fallback
 *   - API mutations (POST/PUT/DELETE):  NetworkOnly (handled by offline queue in app)
 *
 * The SW never intercepts POST/PUT/DELETE since the app's useOfflineMode hook
 * already queues those locally and syncs on reconnect.
 */

const CACHE_VERSION = 'v12';
const STATIC_CACHE = `pos-static-${CACHE_VERSION}`;
const API_CACHE = `pos-api-${CACHE_VERSION}`;
const APP_SHELL_CACHE = `pos-shell-${CACHE_VERSION}`;

// API routes we want to cache for offline use (GET only)
const CACHEABLE_API_PATTERNS = [
  '/api/products',
  '/api/inventory/stock-levels',
  '/api/inventory/batches',
  '/api/customers',
  '/api/uom',
  '/api/settings',
  '/api/invoice-settings',
];

// Max age for API cache entries (15 minutes)
const API_CACHE_MAX_AGE = 15 * 60 * 1000;

// ── Install ───────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  // Never fail install because a precache URL 404s — that would block Web Push.
  self.skipWaiting();

  event.waitUntil(
    caches.open(APP_SHELL_CACHE).then((cache) => {
      const urls = ['./offline.html', './manifest.json'];
      return Promise.all(urls.map((url) => cache.add(url).catch(() => undefined)));
    })
  );
});

// ── Activate ──────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  // Clean up old caches
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys
          .filter((key) => {
            return (
              key !== STATIC_CACHE &&
              key !== API_CACHE &&
              key !== APP_SHELL_CACHE
            );
          })
          .map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim()).then(() => {
      // Notify all controlled clients that a new version is live
      self.clients.matchAll({ type: 'window' }).then((clients) => {
        clients.forEach((client) => client.postMessage({ type: 'SW_UPDATED' }));
      });
    })
  );
});

// ── Fetch ─────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin requests
  if (url.origin !== self.location.origin) return;

  // Skip non-GET requests (mutations handled by app offline queue)
  if (request.method !== 'GET') return;

  // ── API requests: NetworkFirst with cache fallback ─────────
  if (url.pathname.startsWith('/api/')) {
    if (isCacheableApiRoute(url.pathname)) {
      event.respondWith(networkFirstApi(request));
    }
    // Non-cacheable API routes: let browser handle normally
    return;
  }

  // ── Static assets (JS, CSS, images, fonts): CacheFirst ─────
  if (isStaticAsset(url.pathname)) {
    event.respondWith(cacheFirstStatic(request));
    return;
  }

  // ── Navigation requests: NetworkFirst → cached → offline ──
  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(request));
    return;
  }
});

// ── Strategy: NetworkFirst for API ────────────────────────────
async function networkFirstApi(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(API_CACHE);
      // Clone and store with timestamp header
      const cloned = response.clone();
      const headers = new Headers(cloned.headers);
      headers.set('sw-cache-time', Date.now().toString());
      const body = await cloned.blob();
      const cachedResponse = new Response(body, {
        status: cloned.status,
        statusText: cloned.statusText,
        headers,
      });
      cache.put(request, cachedResponse);
    }
    return response;
  } catch {
    // Network failed — serve from cache
    const cached = await caches.match(request);
    if (cached) {
      return cached;
    }
    // Return empty JSON response so the app doesn't crash
    return new Response(
      JSON.stringify({ success: false, error: 'Offline — serving cached data', data: null }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

// ── Strategy: CacheFirst for static assets ────────────────────
async function cacheFirstStatic(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(STATIC_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // Static asset unavailable — return empty response
    return new Response('', { status: 503 });
  }
}

// ── Strategy: NetworkFirst for navigation ─────────────────────
async function networkFirstNavigation(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(APP_SHELL_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // Try cached version of any navigated page (SPA — index.html)
    const cached = await caches.match(request);
    if (cached) return cached;

    // Try the root index (SPA fallback)
    const rootCached = await caches.match('./');
    if (rootCached) return rootCached;

    // Last resort: offline page
    const offlinePage = await caches.match('./offline.html');
    if (offlinePage) return offlinePage;

    return new Response('Offline', { status: 503 });
  }
}

// ── Helpers ───────────────────────────────────────────────────
function isCacheableApiRoute(pathname) {
  return CACHEABLE_API_PATTERNS.some((pattern) => pathname.startsWith(pattern));
}

function isStaticAsset(pathname) {
  return /\.(js|css|woff2?|ttf|png|jpg|jpeg|gif|svg|ico|webp)(\?.*)?$/.test(pathname);
}

// ── Message handling ──────────────────────────────────────────
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }

  // Allow the app to trigger API cache pre-warming
  if (event.data?.type === 'CACHE_API_ROUTES') {
    const routes = event.data.routes || CACHEABLE_API_PATTERNS;
    event.waitUntil(prewarmApiCache(routes));
  }

  // Allow clearing API cache
  if (event.data?.type === 'CLEAR_API_CACHE') {
    event.waitUntil(caches.delete(API_CACHE));
  }
});

async function prewarmApiCache(routes) {
  const cache = await caches.open(API_CACHE);
  for (const route of routes) {
    try {
      const response = await fetch(route);
      if (response.ok) {
        cache.put(route, response);
      }
    } catch {
      // Silently skip routes that fail
    }
  }
}

// ── Background Sync ───────────────────────────────────────────
// Fired by the browser when connectivity is restored, even if the
// tab is closed. The app registers 'sync-offline-sales' tag via
// navigator.serviceWorker.ready.sync.register(...)
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-offline-sales') {
    event.waitUntil(syncPendingOfflineSales());
  }
});

/**
 * Background Sync handler: reads the immutable event journal from
 * the open client and POSTs each PENDING event to /api/pos/sync-events.
 *
 * NOTE: Service Workers cannot access localStorage. The journal data
 * is read by sending a message to any open client. If no client is open,
 * Background Sync will retry on the next opportunity.
 */
async function syncPendingOfflineSales() {
  // Ask an open client for the auth token and event journal
  const clients = await self.clients.matchAll({ type: 'window' });
  if (clients.length === 0) {
    // No open tabs — browser will retry Background Sync later
    return;
  }

  // Request data from the first available client
  const data = await requestDataFromClient(clients[0]);
  if (!data || !data.events || data.events.length === 0) return;

  const { events, syncState, authToken, apiBase } = data;

  // Filter to PENDING/FAILED events only
  const unsyncedEvents = events.filter((e) => {
    const status = syncState?.[e.key]?.status ?? 'PENDING';
    return status === 'PENDING' || status === 'FAILED';
  });
  if (unsyncedEvents.length === 0) return;

  const syncedKeys = [];
  const reviewKeys = [];

  for (const event of unsyncedEvents) {
    try {
      const response = await fetch(`${apiBase}/pos/sync-events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify({ event }),
      });

      if (response.ok) {
        const body = await response.json().catch(() => ({}));
        if (body.requiresReview) {
          reviewKeys.push(event.key);
        } else {
          syncedKeys.push(event.key);
        }
      } else if (response.status === 409) {
        // Idempotency hit — already exists
        syncedKeys.push(event.key);
      } else if (response.status === 422) {
        reviewKeys.push(event.key);
      }
    } catch {
      // Network still flaky — Background Sync will retry
      return;
    }
  }

  // Tell the client to update journal sync state
  for (const client of clients) {
    client.postMessage({
      type: 'BACKGROUND_SYNC_COMPLETE',
      syncedKeys,
      reviewKeys,
    });
  }
}

/**
 * Send a message to a client and wait for a reply.
 * The client listens for 'SW_REQUEST_SYNC_DATA' and responds
 * with the queue, auth token, and API base URL.
 */
function requestDataFromClient(client) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = (event) => resolve(event.data);
    // Time out after 3 seconds if client doesn't respond
    setTimeout(() => resolve(null), 3000);
    client.postMessage({ type: 'SW_REQUEST_SYNC_DATA' }, [channel.port2]);
  });
}

// ── Web Push ──────────────────────────────────────────────────
self.addEventListener('push', (event) => {
  let payload = { title: 'SMART-ERP-POS', body: 'You have a new notification.', path: '/', notificationId: null };
  try {
    if (event.data) {
      payload = { ...payload, ...event.data.json() };
    }
  } catch {
    // iOS requires a visible notification on every push
  }
  const title = payload.title || 'SMART-ERP-POS';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || '',
      data: {
        path: payload.path,
        notificationId: payload.notificationId,
      },
      tag: payload.notificationId || payload.typeKey || 'smart-erp-pos',
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const nid = data.notificationId ? String(data.notificationId) : '';
  const dest = nid ? `/?nid=${encodeURIComponent(nid)}` : '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      const existing = clientList.find((client) => 'focus' in client);
      if (existing) {
        return existing.focus().then(() => {
          if (typeof existing.navigate === 'function') {
            return existing.navigate(dest);
          }
          existing.postMessage({ type: 'NOTIFICATION_CLICK', nid });
        });
      }
      return self.clients.openWindow(dest);
    })
  );
});

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clients) => {
      clients.forEach((client) => client.postMessage({ type: 'PUSH_SUBSCRIPTION_CHANGE' }));
    })
  );
});
