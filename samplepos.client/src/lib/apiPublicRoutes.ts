/**
 * Public API routes — must work without an access token.
 * Keep aligned with server routes (auth login, quick-login public endpoints).
 */

const PUBLIC_QUICK_LOGIN: ReadonlyArray<{ segment: string; methods: readonly string[] }> = [
  { segment: 'auth/quick-login/users', methods: ['GET'] },
  { segment: 'auth/quick-login/pin-only', methods: ['POST'] },
  { segment: 'auth/quick-login/pin', methods: ['POST'] },
  { segment: 'auth/quick-login/biometric', methods: ['POST'] },
  { segment: 'auth/quick-login/check-device', methods: ['POST'] },
];

function normalizeApiPath(url: string): string {
  return url.replace(/^\/+/, '').replace(/^api\/+/, '');
}

function normalizeMethod(method: string | undefined): string {
  return (method ?? 'GET').toUpperCase();
}

/** True when the request may proceed without Authorization (login / public quick-login). */
export function isPublicApiRoute(url: string | undefined, method?: string): boolean {
  if (!url) return false;

  const m = normalizeMethod(method);
  const path = normalizeApiPath(url);

  if (
    path === 'auth/token/refresh' ||
    path.startsWith('auth/token/refresh?') ||
    path === 'health' ||
    path.startsWith('health?')
  ) {
    return true;
  }

  if (path === 'auth/register' || path.startsWith('auth/register?')) {
    return true;
  }

  // Tenant branding/config — public before login (login page branding, platform shell)
  if (
    (path === 'tenant/config' || path.startsWith('tenant/config?')) &&
    m === 'GET'
  ) {
    return true;
  }

  // Password login (auth/login, platform/login) — not quick-login setup routes
  if (path.includes('/login') && !path.includes('/quick-login')) {
    return true;
  }

  // Password policy helpers used before / during change-password forms
  if (
    (path === 'auth/password/policy' || path.startsWith('auth/password/policy?')) &&
    m === 'GET'
  ) {
    return true;
  }
  if (
    (path === 'auth/password/validate' || path.startsWith('auth/password/validate?')) &&
    m === 'POST'
  ) {
    return true;
  }

  for (const { segment, methods } of PUBLIC_QUICK_LOGIN) {
    if ((path === segment || path.startsWith(`${segment}?`)) && methods.includes(m)) {
      return true;
    }
  }

  return false;
}
