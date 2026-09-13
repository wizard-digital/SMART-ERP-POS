import React from 'react';
import ReactDOM from 'react-dom/client';
import axios from 'axios';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from './contexts/AuthContext';
import { OfflineProvider } from './contexts/OfflineContext';
import { TenantProvider } from './contexts/TenantContext';
import { TransactionGuardProvider } from './contexts/TransactionGuardContext';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import { installGlobalApiToastDedupe } from './utils/errorHandler';
import './index.css';

// SSOT: one API error toast — interceptor notifies; page catch toast.error(msg) is suppressed
installGlobalApiToastDedupe();

// Comprehensive browser extension error suppression
const suppressExtensionErrors = (event: ErrorEvent | PromiseRejectionEvent) => {
  const filename = ('filename' in event ? event.filename : '') || '';
  const message = ('message' in event ? event.message : '') || (event instanceof PromiseRejectionEvent ? String(event.reason || '') : '');
  const stack = ('error' in event && event.error ? event.error.stack : '') || '';

  // Check for browser extension patterns
  const extensionPatterns = [
    'proxy.js',
    'backendManager.js',
    'bridge.js',
    'content_script',
    'chrome-extension://',
    'moz-extension://',
    'extension',
    'disconnected port object',
    'Extension context invalidated',
    'handleMessageFromPage',
    'postMessage',
    'send @ backendManager'
  ];

  const isExtensionError = extensionPatterns.some(pattern =>
    filename.includes(pattern) ||
    message.includes(pattern) ||
    stack.includes(pattern)
  );

  if (isExtensionError) {
    event.preventDefault?.();
    event.stopPropagation?.();
    return true;
  }

  return false;
};

// Suppress browser extension errors
window.addEventListener('error', suppressExtensionErrors, true);

// Suppress unhandled promise rejections from browser extensions  
window.addEventListener('unhandledrejection', (event) => {
  if (suppressExtensionErrors(event)) {
    event.preventDefault();
  }
}, true);

// Override console.error to filter extension errors
const originalConsoleError = console.error;
console.error = (...args: unknown[]) => {
  const message = args.join(' ');
  const extensionKeywords = [
    'proxy.js',
    'disconnected port object',
    'backendManager',
    'bridge.js',
    'Extension context',
    'chrome-extension',
    'moz-extension'
  ];

  const isExtensionError = extensionKeywords.some(keyword =>
    message.includes(keyword)
  );

  if (!isExtensionError) {
    originalConsoleError.apply(console, args);
  }
};

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => {
        const status = axios.isAxiosError(error)
          ? error.response?.status
          : (error as { status?: number })?.status;
        if (status && status >= 400 && status < 500) return false;
        return failureCount < 1;
      },
      staleTime: 5 * 60 * 1000, // 5 minutes
      gcTime: 30 * 60 * 1000, // Keep unused cache for 30 min (helps offline)
      networkMode: 'offlineFirst', // Don't fire queries when offline — use cache
    },
    mutations: {
      // Mutations should not retry by default — offline queue handles retries
      retry: 0,
      networkMode: 'offlineFirst',
    },
  },
});

// ── Service Worker Registration (skip in dev — self-signed certs block SW) ──
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .then((registration) => {
        console.log('[SW] Registered:', registration.scope);

        // Listen for updates
        registration.addEventListener('updatefound', () => {
          const newWorker = registration.installing;
          if (newWorker) {
            newWorker.addEventListener('statechange', () => {
              if (newWorker.state === 'activated') {
                console.log('[SW] New service worker activated');
              }
            });
          }
        });
      })
      .catch((err) => {
        console.warn('[SW] Registration failed:', err);
      });
  });

  // ── SW ↔ Client messaging for Background Sync ────────────
  navigator.serviceWorker.addEventListener('message', (event) => {
    // SW requesting sync data (auth token + offline event journal)
    if (event.data?.type === 'SW_REQUEST_SYNC_DATA') {
      import('./lib/offlineEventJournal').then(({ getAllEvents, getAllSyncState }) => {
        const events = getAllEvents();
        const syncState = getAllSyncState();
        const authToken = localStorage.getItem('auth_token');
        const apiBase = import.meta.env.VITE_API_URL || '/api';
        // Reply via the MessageChannel port the SW sent
        if (event.ports[0]) {
          event.ports[0].postMessage({ events, syncState, authToken, apiBase });
        }
      });
    }

    // New SW activated — notify the app to show a reload banner
    if (event.data?.type === 'SW_UPDATED') {
      window.dispatchEvent(new CustomEvent('sw-updated'));
    }

    // SW finished Background Sync — mark synced keys in the journal
    if (event.data?.type === 'BACKGROUND_SYNC_COMPLETE') {
      const syncedKeys: string[] = event.data.syncedKeys || [];
      const reviewKeys: string[] = event.data.reviewKeys || [];
      if (syncedKeys.length > 0 || reviewKeys.length > 0) {
        import('./lib/offlineEventJournal').then(({ markSynced, markReview }) => {
          for (const key of syncedKeys) markSynced(key);
          for (const key of reviewKeys) markReview(key, 'Background sync review');
          window.dispatchEvent(new CustomEvent('offline-queue-updated'));
        });
      }
    }

    if (event.data?.type === 'NOTIFICATION_CLICK' && typeof event.data.nid === 'string') {
      const nid = event.data.nid;
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(nid)) {
        window.location.assign(`/?nid=${encodeURIComponent(nid)}`);
      }
    }

    if (event.data?.type === 'PUSH_SUBSCRIPTION_CHANGE') {
      void import('./lib/pushSubscription').then(async (push) => {
        try {
          if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
          const token = localStorage.getItem('auth_token');
          if (!token) return;
          const baseUrl = import.meta.env.VITE_API_BASE_URL || '/api';
          const catalogRes = await fetch(`${baseUrl}/notifications/catalog`, {
            headers: { Authorization: `Bearer ${token}` },
            credentials: 'include',
          });
          const catalog = await catalogRes.json();
          const publicKey = catalog?.data?.vapidPublicKey as string | undefined;
          if (!publicKey || !('serviceWorker' in navigator)) return;
          const registration = await navigator.serviceWorker.ready;
          const subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: push.urlBase64ToUint8Array(publicKey),
          });
          const json = subscription.toJSON();
          const createdRes = await fetch(`${baseUrl}/notifications/devices`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            credentials: 'include',
            body: JSON.stringify({
              endpoint: json.endpoint,
              keys: json.keys,
              clientInstallationId: push.getOrCreateInstallationId(),
              platformHint: push.platformHintFromCapabilities({
                standalone: window.matchMedia('(display-mode: standalone)').matches,
                coarsePointer: window.matchMedia('(pointer: coarse)').matches,
              }),
              permissionState: 'granted',
            }),
          });
          const created = await createdRes.json();
          if (created?.data?.id) push.rememberSubscriptionId(String(created.data.id));
        } catch {
          /* best-effort subscription renewal */
        }
      });
    }
  });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary section="Root">
      <QueryClientProvider client={queryClient}>
        <TenantProvider>
          <OfflineProvider>
            <AuthProvider>
              <TransactionGuardProvider>
                <App />
              </TransactionGuardProvider>
            </AuthProvider>
          </OfflineProvider>
        </TenantProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  </React.StrictMode>
);
