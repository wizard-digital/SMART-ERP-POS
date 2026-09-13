import { useState, useEffect, useRef } from 'react';
import { useNavigate, useLocation, Navigate, Link } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { resolvePostLoginPath } from '../utils/cashierLockdown';
import { api } from '../utils/api';
import { TwoFactorVerifyModal } from '../components/auth/TwoFactorVerifyModal';
import type { UserRole } from '../types';
import { Shield, Eye, EyeOff, Loader2, AlertCircle, Store, WifiOff, Fingerprint } from 'lucide-react';
import { useTenant } from '../contexts/TenantContext';
import { MathCaptcha } from '../components/auth/MathCaptcha';
import {
  fetchRestaurantEnabled,
  restaurantEnabledQueryKey,
  useRestaurantModeForRouting,
} from '../hooks/useRestaurantEnabled';
import { RestaurantModeBoot } from '../components/auth/RestaurantModeBoot';
import { useQueryClient } from '@tanstack/react-query';
import { requestSoftKeyboard, softKeyboardAttrs } from '../lib/softKeyboard';
import {
  cacheLoginCredential,
  validateOfflineLogin,
  beginOfflineLoginSession,
} from '../lib/offlineLoginCredentials';
import { appendNotificationQuery, locationFromState, notificationIdFromPath } from '../lib/notificationNavigation';

function readCachedPermissionKeys(): string[] {
  try {
    const raw = localStorage.getItem('rbac_permissions');
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

function homeAfterLogin(
  role: string | undefined,
  intended?: string,
  restaurantEnabled?: boolean,
): string {
  return resolvePostLoginPath(
    { role, permissions: readCachedPermissionKeys(), restaurantEnabled },
    intended,
  );
}

/** Shape returned by POST /auth/login inside `data.data` */
interface LoginResponseData {
  isSuperAdmin?: boolean;
  redirectTo?: string;
  requires2FA?: boolean;
  userId?: string;
  requires2FASetup?: boolean;
  user: { id: string; email: string; fullName: string; role: UserRole };
  token: string;
  accessToken?: string;
  refreshToken?: string;
  expiresIn?: number;
}

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [requires2FA, setRequires2FA] = useState(false);
  const [pendingUserId, setPendingUserId] = useState<string | null>(null);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  // CAPTCHA state — server tells us when to require it
  const [requiresCaptcha, setRequiresCaptcha] = useState(false);
  const [captchaVerified, setCaptchaVerified] = useState(false);
  const [captchaResetKey, setCaptchaResetKey] = useState(0);
  const { login, isAuthenticated, user } = useAuth();
  const { config } = useTenant();
  const queryClient = useQueryClient();
  const { restaurantEnabled, isReady } = useRestaurantModeForRouting();
  const brandName = config.branding.companyName || config.name || 'SMART ERP';
  const navigate = useNavigate();
  const location = useLocation();
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  // Open system soft keyboard on mount (tablets / Windows touch / PWA).
  useEffect(() => {
    const t = window.setTimeout(() => requestSoftKeyboard(emailRef.current), 50);
    return () => window.clearTimeout(t);
  }, []);

  const resolveHomeAfterAuth = async (
    role: string | undefined,
    intended?: string,
  ): Promise<string> => {
    const enabled = await queryClient.fetchQuery({
      queryKey: restaurantEnabledQueryKey,
      queryFn: fetchRestaurantEnabled,
    });
    return homeAfterLogin(role, intended, enabled);
  };

  useEffect(() => {
    const goOnline = () => setIsOnline(true);
    const goOffline = () => setIsOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => { window.removeEventListener('online', goOnline); window.removeEventListener('offline', goOffline); };
  }, []);

  // Where to go after login — honours ProtectedRoute's "from" state
  const from = locationFromState((location.state as { from?: { pathname?: string; search?: string } })?.from);
  const nid = notificationIdFromPath(from);

  // Capture once on mount — reading/removing sessionStorage during render caused the
  // banner to vanish on the next re-render (common on mobile after focus/resize).
  const [sessionExpiredBanner] = useState(() => {
    try {
      const flag = sessionStorage.getItem('session_expired');
      if (flag) {
        sessionStorage.removeItem('session_expired');
        return true;
      }
    } catch {
      /* private mode / blocked storage */
    }
    return (location.state as { sessionExpired?: boolean } | null)?.sessionExpired === true;
  });

  // Redirect if already authenticated — wait for restaurant flag so we never flash retail POS
  if (isAuthenticated) {
    if (!isReady) {
      return <RestaurantModeBoot />;
    }
    return <Navigate to={appendNotificationQuery(homeAfterLogin(user?.role, from, restaurantEnabled), nid)} replace />;
  }
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    // Block if CAPTCHA is required but not yet solved
    if (requiresCaptcha && !captchaVerified) {
      setError('Please solve the security challenge first.');
      return;
    }
    setLoading(true);

    try {
      // Offline login: validate against cached credentials
      if (!navigator.onLine) {
        try {
          const offlineUser = await validateOfflineLogin(email, password);
          if (offlineUser) {
            // Never reuse prior JWT/RT — would bind UI to wrong server identity
            const offlineToken = beginOfflineLoginSession(offlineUser);
            await login(offlineUser, offlineToken);
            navigate(appendNotificationQuery(await resolveHomeAfterAuth(offlineUser.role, from), nid), { replace: true });
            return;
          }
        } catch (offlineErr) {
          console.warn(
            '[Auth] Offline login validation failed:',
            offlineErr instanceof Error ? offlineErr.message : offlineErr,
          );
        }
        setError('Offline login failed. You must have logged in online at least once with these credentials.');
        return;
      }

      const response = await api.auth.login({ email, password });

      if (response.data.success && response.data.data) {
        const loginData = response.data.data as LoginResponseData;

        // Super admin detected — redirect to platform portal
        if (loginData.isSuperAdmin && loginData.redirectTo) {
          navigate(loginData.redirectTo);
          return;
        }

        // Check if 2FA is required
        if (loginData.requires2FA) {
          setPendingUserId(loginData.userId ?? null);
          setRequires2FA(true);
          setLoading(false);
          return;
        }

        // Check if 2FA setup is required (role requires it but not set up)
        if (loginData.requires2FASetup) {
          const { user, token, accessToken, refreshToken, expiresIn } = loginData;
          await login(user, accessToken || token, refreshToken, expiresIn);
          // Cache for offline login
          await cacheLoginCredential(email, password, user);
          navigate('/settings/security', {
            state: { message: '2FA setup is required for your role. Please set it up now.' }
          });
          return;
        }

        const { user, token, accessToken, refreshToken, expiresIn } = loginData;
        await login(user, accessToken || token, refreshToken, expiresIn);
        // Cache for offline login
        await cacheLoginCredential(email, password, user);
        navigate(appendNotificationQuery(await resolveHomeAfterAuth(user.role, from), nid), { replace: true });
      } else {
        setError(response.data.error || 'Login failed');
      }
    } catch (err: unknown) {
      // Determine if this is a server-unreachable error (not a clear auth rejection)
      const axiosErr = err as { code?: string; response?: { status?: number; data?: { error?: string; data?: { requiresCaptcha?: boolean; failedAttempts?: number; locked?: boolean; remainingMinutes?: number | null } } } };
      const status = axiosErr.response?.status;
      const isServerUnreachable =
        !navigator.onLine ||
        axiosErr.code === 'ERR_NETWORK' ||
        axiosErr.code === 'ECONNABORTED' ||
        status === 502 || status === 503 || status === 504 ||
        !axiosErr.response; // No response at all = server unreachable

      // If server is unreachable, try offline login before showing error
      if (isServerUnreachable) {
        try {
          const offlineUser = await validateOfflineLogin(email, password);
          if (offlineUser) {
            const offlineToken = beginOfflineLoginSession(offlineUser);
            await login(offlineUser, offlineToken);
            navigate(appendNotificationQuery(await resolveHomeAfterAuth(offlineUser.role, from), nid), { replace: true });
            return;
          }
        } catch (offlineErr) {
          console.warn(
            '[Auth] Offline fallback after unreachable server failed:',
            offlineErr instanceof Error ? offlineErr.message : offlineErr,
          );
        }
      }

      // Parse CAPTCHA requirement from structured error response
      const loginMeta = axiosErr.response?.data?.data;
      if (loginMeta?.requiresCaptcha) {
        setRequiresCaptcha(true);
        setCaptchaVerified(false);
        setCaptchaResetKey(k => k + 1);
      }

      if (axiosErr.response?.data?.error) {
        setError(axiosErr.response.data.error);
      } else {
        setError(err instanceof Error ? err.message : 'Login failed. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  const handle2FASuccess = async (data: {
    user: { id: string; email: string; fullName: string; role: string };
    token: string;
    accessToken?: string;
    refreshToken?: string;
    expiresIn?: number;
  }): Promise<void> => {
    const token = data.accessToken || data.token;

    if (!token) {
      setError('Authentication failed: No token received');
      setRequires2FA(false);
      setPendingUserId(null);
      return;
    }

    // Clear 2FA state BEFORE login to prevent any rendering issues
    setRequires2FA(false);
    setPendingUserId(null);

    const authUser = {
      ...data.user,
      role: data.user.role as UserRole,
    };
    await login(authUser, token, data.refreshToken, data.expiresIn);
    // Cache for offline login (email/password are still in component state)
    if (email && password) {
      cacheLoginCredential(email, password, authUser).catch((cacheErr) => {
        console.error('[Auth] Offline credential cache failed after 2FA:', cacheErr);
      });
    }
    navigate(appendNotificationQuery(await resolveHomeAfterAuth(authUser.role, from), nid), { replace: true });
  };

  const handle2FACancel = () => {
    setRequires2FA(false);
    setPendingUserId(null);
    setEmail('');
    setPassword('');
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 via-white to-indigo-50 px-4">
      {requires2FA && pendingUserId && (
        <TwoFactorVerifyModal
          userId={pendingUserId}
          onSuccess={handle2FASuccess}
          onCancel={handle2FACancel}
        />
      )}

      <div className="max-w-md w-full">
        {/* Logo / Branding */}
        <div className="text-center mb-8">
          <div className="mx-auto w-16 h-16 bg-blue-600 rounded-2xl flex items-center justify-center shadow-lg mb-4">
            <Store className="w-9 h-9 text-white" />
          </div>
          <h1 className="text-3xl font-bold text-gray-900 tracking-tight">
            {brandName}
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            Point of Sale &amp; Inventory Management
          </p>
        </div>

        {/* Card */}
        <div className="bg-white rounded-2xl shadow-xl border border-gray-100 p-8">
          <h2 className="text-lg font-semibold text-gray-900 mb-6">
            Sign in to your account
          </h2>

          {/* Session-expired banner */}
          {sessionExpiredBanner && !error && (
            <div className="mb-4 flex items-start gap-2 rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>Your session expired due to inactivity. Please sign in again.</span>
            </div>
          )}

          {/* Offline mode banner */}
          {!isOnline && (
            <div className="mb-4 flex items-start gap-2 rounded-lg bg-orange-50 border border-orange-200 px-4 py-3 text-sm text-orange-800">
              <WifiOff className="w-4 h-4 mt-0.5 shrink-0" />
              <span>You are offline. Sign in with your last used credentials to continue working.</span>
            </div>
          )}

          <form className="space-y-5" onSubmit={handleSubmit}>
            {/* Error alert */}
            {error && (
              <div
                role="alert"
                aria-live="assertive"
                className="flex items-start gap-2 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700"
              >
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {/* Email */}
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">
                Email address
              </label>
              <input
                ref={emailRef}
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                autoFocus
                required
                {...softKeyboardAttrs('email', 'next')}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onFocus={(e) => requestSoftKeyboard(e.currentTarget)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    requestSoftKeyboard(passwordRef.current);
                  }
                }}
                className="block w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm shadow-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors"
                placeholder="you@company.com"
              />
            </div>

            {/* Password with visibility toggle */}
            <div>
              <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-1">
                Password
              </label>
              <div className="relative">
                <input
                  ref={passwordRef}
                  id="password"
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  required
                  {...softKeyboardAttrs('text', 'go')}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onFocus={(e) => requestSoftKeyboard(e.currentTarget)}
                  className="block w-full px-3 py-2.5 pr-10 border border-gray-300 rounded-lg text-sm shadow-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors"
                  placeholder="••••••••"
                />
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute inset-y-0 right-0 flex items-center pr-3 text-gray-400 hover:text-gray-600"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {/* CAPTCHA — shown after 3+ failed login attempts */}
            {requiresCaptcha && (
              <MathCaptcha
                onVerified={() => setCaptchaVerified(true)}
                resetKey={captchaResetKey}
              />
            )}

            {/* Submit */}
            <button
              type="submit"
              disabled={loading || (requiresCaptcha && !captchaVerified)}
              className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-lg text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
            >
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Signing in…
                </>
              ) : (
                'Sign in'
              )}
            </button>
          </form>

          {/* Quick Login link */}
          <div className="mt-4 text-center">
            <Link
              to="/quick-login"
              className="inline-flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-700 font-medium transition-colors"
            >
              <Fingerprint className="w-4 h-4" />
              POS Quick Login
            </Link>
          </div>

          {/* Footer */}
          <div className="mt-6 flex items-center justify-center gap-1.5 text-xs text-gray-400">
            <Shield className="w-3.5 h-3.5" />
            <span>Protected by Two-Factor Authentication</span>
          </div>
        </div>

        {/* Copyright */}
        <p className="mt-6 text-center text-xs text-gray-400">
          &copy; {new Date().getFullYear()} {brandName}. All rights reserved.
        </p>
      </div>
    </div>
  );
}
