import { useEffect } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { getAccessToken } from '../../hooks/useTokenRefresh';
import { apiClient } from '../../utils/api';
import { isNotificationId, toInAppLocation } from '../../lib/notificationNavigation';

function stripNid(search: string): string {
  const params = new URLSearchParams(search);
  params.delete('nid');
  const next = params.toString();
  return next ? `?${next}` : '';
}

/**
 * Push / in-app deep links pass ?nid=<notificationId>.
 * Authorization is re-checked by fetching the inbox row; the payload path is not trusted.
 *
 * Must not navigate to /settings/notifications on fetch failure: a 401 already
 * force-logs-out, and bouncing to settings first is the black-screen blink.
 */
export default function NotificationDeepLink() {
  const { isAuthenticated } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const nid = params.get('nid');

  useEffect(() => {
    if (!isAuthenticated || !getAccessToken()) return;
    if (!isNotificationId(nid)) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiClient.get(`/notifications/${nid}`, { silentErrorToast: true });
        const path = res.data?.data?.navigationPath;
        if (!cancelled) {
          const next = toInAppLocation(path);
          navigate({ pathname: next.pathname, search: next.search }, { replace: true });
        }
      } catch {
        if (!cancelled) {
          navigate({ pathname: location.pathname, search: stripNid(location.search) }, { replace: true });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [nid, isAuthenticated, navigate, location.search, location.pathname]);

  return null;
}
