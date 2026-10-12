/**
 * While online + authenticated, prefetch critical route chunks into the browser
 * module/HTTP cache so offline navigation does not fail those screens.
 *
 * Failures are reported via offlineIntegrity (never swallowed).
 */
import { useEffect, useRef } from 'react';
import { useAuth } from '../hooks/useAuth';
import { useOfflineContext } from '../contexts/OfflineContext';
import { warmCriticalOfflineModules } from '../lib/offlineIntegrity';

export default function CriticalOfflineWarmup() {
  const { isAuthenticated } = useAuth();
  const { isOnline } = useOfflineContext();
  const ranRef = useRef(false);

  useEffect(() => {
    if (!isAuthenticated || !isOnline || ranRef.current) return;
    ranRef.current = true;

    void warmCriticalOfflineModules().then((result) => {
      if (result.failed.length > 0) {
        // Already reported per-module; keep a summary for operators in DEV.
        if (import.meta.env.DEV) {
          console.warn('[CriticalOfflineWarmup] partial:', result);
        }
      }
    });
  }, [isAuthenticated, isOnline]);

  // Re-arm warmup when coming back online so newly deployed chunks cache.
  useEffect(() => {
    if (!isOnline) {
      ranRef.current = false;
    }
  }, [isOnline]);

  return null;
}
