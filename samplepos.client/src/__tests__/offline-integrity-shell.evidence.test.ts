/**
 * PROOF: Offline integrity — critical shell eager; failures typed & logged; no swallow.
 * Consistency lock across App / ErrorBoundary / SW / docs / integrity codes.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  createOfflineModuleError,
  isOfflineModuleError,
} from '../lib/chunkLoadError';
import {
  OfflineIntegrityCode,
  reportOfflineIntegrityEvent,
  readRecentOfflineIntegrityEvents,
  warmCriticalOfflineModules,
} from '../lib/offlineIntegrity';
import { resolveOfflineRecoveryHome } from '../lib/offlineRecoveryHome';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, '..');
const clientRoot = resolve(srcRoot, '..');
const repoRoot = resolve(clientRoot, '..');

const gates: Array<{ id: string; ok: boolean; detail: string }> = [];
function gate(id: string, ok: boolean, detail: string) {
  gates.push({ id, ok, detail });
  expect(ok).toBe(true);
}

describe('PROOF: offline integrity shell', () => {
  it('Login + POS + QuickLogin are eager (not lazyWithRetry)', () => {
    const app = readFileSync(resolve(srcRoot, 'App.tsx'), 'utf8');
    gate(
      'EAGER_LOGIN',
      app.includes("import LoginPage from './pages/LoginPage'") &&
        !/const LoginPage = lazyWithRetry/.test(app),
      'LoginPage static import',
    );
    gate(
      'EAGER_POS',
      app.includes("import POSPage from './pages/pos/POSPage'") &&
        !/const POSPage = lazyWithRetry/.test(app),
      'POSPage static import',
    );
    gate(
      'EAGER_QUICK_LOGIN',
      app.includes("import QuickLoginScreen from './pages/pos/QuickLoginScreen'") &&
        !/const QuickLoginScreen = lazyWithRetry/.test(app),
      'QuickLoginScreen static import',
    );
    gate(
      'WARMUP_MOUNTED',
      app.includes('CriticalOfflineWarmup') &&
        app.includes('<CriticalOfflineWarmup'),
      'CriticalOfflineWarmup mounted for authenticated sessions',
    );
    gate(
      'LAZY_RETRY_USES_INTEGRITY_CODES',
      app.includes('OfflineIntegrityCode.CHUNK_LOAD_OFFLINE') &&
        app.includes('OfflineIntegrityCode.CHUNK_LOAD_DEV') &&
        app.includes('OfflineIntegrityCode.CHUNK_LOAD_STALE_AFTER_RELOAD'),
      'lazyWithRetry maps failures to OfflineIntegrityCode',
    );
  });

  it('ErrorBoundary + docs stay consistent with integrity SSOT', () => {
    const boundary = readFileSync(resolve(srcRoot, 'components/ErrorBoundary.tsx'), 'utf8');
    gate(
      'BOUNDARY_OFFLINE_UI',
      boundary.includes('isOfflineModuleError') &&
        boundary.includes('reportOfflineIntegrityEvent') &&
        (boundary.includes("You&apos;re offline") || boundary.includes("You're offline")),
      'ErrorBoundary offline card + integrity report',
    );
    gate(
      'BOUNDARY_RESTAURANT_AWARE_RECOVERY',
      boundary.includes('resolveOfflineRecoveryHome'),
      'ErrorBoundary recovery uses restaurant-aware home (not hard-coded /pos)',
    );
    const recovery = readFileSync(resolve(srcRoot, 'lib/offlineRecoveryHome.ts'), 'utf8');
    gate(
      'RECOVERY_HOME_SSOT',
      recovery.includes("'/restaurant'") &&
        recovery.includes("'/pos'") &&
        recovery.includes('readCachedRestaurantEnabled'),
      'offlineRecoveryHome: restaurant → /restaurant, else /pos',
    );
    const docs = readFileSync(resolve(repoRoot, 'docs/OFFLINE_ARCHITECTURE_RULES.md'), 'utf8');
    gate(
      'DOCS_SHELL_INTEGRITY',
      docs.includes('Shell integrity') &&
        docs.includes('CriticalOfflineWarmup') &&
        docs.includes('eager'),
      'OFFLINE_ARCHITECTURE_RULES documents shell integrity',
    );
    const warmup = readFileSync(resolve(srcRoot, 'components/CriticalOfflineWarmup.tsx'), 'utf8');
    gate(
      'WARMUP_USES_SSOT',
      warmup.includes('warmCriticalOfflineModules') &&
        warmup.includes('useOfflineContext') &&
        warmup.includes('isAuthenticated'),
      'warmup only when authenticated + online',
    );
  });

  it('SW error_code strings match OfflineIntegrityCode constants', () => {
    const sw = readFileSync(resolve(clientRoot, 'public/sw.js'), 'utf8');
    gate(
      'SW_CODE_API',
      sw.includes(OfflineIntegrityCode.SW_API_MISS) && sw.includes('console.warn'),
      'API miss logged + coded',
    );
    gate(
      'SW_CODE_STATIC',
      sw.includes(OfflineIntegrityCode.SW_STATIC_MISS),
      'static miss coded',
    );
    gate(
      'SW_CODE_NAV',
      sw.includes(OfflineIntegrityCode.SW_NAV_FALLBACK),
      'nav fallback coded',
    );
    gate(
      'SW_NO_SILENT_EMPTY',
      !sw.includes("return new Response('', { status: 503 })"),
      'no empty 503 swallow',
    );
  });

  it('offline module errors preserve cause and report integrity codes', () => {
    const cause = new Error('Failed to fetch dynamically imported module');
    const err = createOfflineModuleError(cause, OfflineIntegrityCode.CHUNK_LOAD_OFFLINE);
    gate('TYPED_ERROR', isOfflineModuleError(err), 'OFFLINE_MODULE_LOAD name');
    gate(
      'CAUSE_PRESERVED',
      (err as Error & { cause?: unknown }).cause === cause,
      'Error.cause attached',
    );
    const recent = readRecentOfflineIntegrityEvents();
    gate(
      'EVENT_LOGGED',
      recent.some((e) => e.code === OfflineIntegrityCode.CHUNK_LOAD_OFFLINE),
      'memory integrity log has CHUNK_LOAD_OFFLINE',
    );
  });

  it('resolveOfflineRecoveryHome is restaurant-aware', () => {
    expect(resolveOfflineRecoveryHome(true)).toEqual({
      path: '/restaurant',
      label: 'Go to Restaurant',
    });
    expect(resolveOfflineRecoveryHome(false)).toEqual({ path: '/pos', label: 'Go to POS' });
    expect(resolveOfflineRecoveryHome(null)).toEqual({ path: '/pos', label: 'Go to POS' });
    gate('RECOVERY_RUNTIME', true, 'restaurant flag drives recovery path');
  });

  it('reportOfflineIntegrityEvent never returns empty / silent', () => {
    const ev = reportOfflineIntegrityEvent(
      OfflineIntegrityCode.WARMUP_FAILED,
      'test warmup failure',
      new Error('synthetic'),
      { moduleId: 'test' },
    );
    gate('EVENT_HAS_CODE', !!ev.code && !!ev.message && !!ev.at, 'structured event');
  });

  it('warmCriticalOfflineModules is structured (ok/failed, report on miss — no swallow)', () => {
    const src = readFileSync(resolve(srcRoot, 'lib/offlineIntegrity.ts'), 'utf8');
    gate(
      'WARM_LIST_ORDERS',
      src.includes('orders-queue') &&
        src.includes('customers') &&
        src.includes('products') &&
        src.includes('stock-levels') &&
        src.includes('sales') &&
        src.includes('restaurant-pos') &&
        src.includes('security-settings'),
      'warmup covers orders/customers/products/stock/sales/restaurant/security',
    );
    gate(
      'WARM_REPORTS_FAILURE',
      src.includes('OfflineIntegrityCode.WARMUP_FAILED') &&
        src.includes('reportOfflineIntegrityEvent'),
      'per-module warmup failure is reported',
    );
    gate(
      'WARM_RETURNS_SHAPE',
      src.includes('ok: string[]') &&
        src.includes('failed: Array<{ id: string; error: string }>') &&
        src.includes('return { ok, failed }'),
      'warmCriticalOfflineModules returns { ok, failed }',
    );
    // Export exists for runtime warmup (do not import() pages in evidence — hangs in Vitest)
    gate(
      'WARM_EXPORT',
      typeof warmCriticalOfflineModules === 'function',
      'warmCriticalOfflineModules exported',
    );
  });

  it('writes proof artifact', () => {
    const passed = gates.filter((g) => g.ok).length;
    const payload = {
      feature: 'OFFLINE_INTEGRITY_SHELL',
      verdict: passed === gates.length ? 'PASS' : 'FAIL',
      passed,
      total: gates.length,
      gates,
      consistency: {
        eagerShell: ['LoginPage', 'POSPage', 'QuickLoginScreen'],
        warmupModules: [
          'orders-queue',
          'customers',
          'products',
          'stock-levels',
          'sales',
          'restaurant-pos',
          'security-settings',
        ],
        swCodes: [
          OfflineIntegrityCode.SW_API_MISS,
          OfflineIntegrityCode.SW_STATIC_MISS,
          OfflineIntegrityCode.SW_NAV_FALLBACK,
        ],
      },
      at: new Date().toISOString(),
    };
    writeFileSync(resolve(repoRoot, 'PROOF_OFFLINE_INTEGRITY_SHELL.json'), JSON.stringify(payload, null, 2));
    writeFileSync(resolve(clientRoot, 'PROOF_OFFLINE_INTEGRITY_SHELL.json'), JSON.stringify(payload, null, 2));
    expect(payload.verdict).toBe('PASS');
  });
});
