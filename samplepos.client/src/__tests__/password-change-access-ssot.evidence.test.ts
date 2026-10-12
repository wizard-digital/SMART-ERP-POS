/**
 * Password change access SSOT — every authenticated role can change their own password.
 * Structural gates only (no browser).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isAuthRecoveryPath } from '../lib/offlineLoginCredentials';
import { isPublicApiRoute } from '../lib/apiPublicRoutes';
import { isCashierAllowedPath } from '../utils/cashierLockdown';
import { isWaiterAllowedPath } from '../utils/restaurantWaiterLockdown';

const root = join(__dirname, '..');
const serverAuth = join(__dirname, '..', '..', '..', 'SamplePOS.Server', 'src', 'modules', 'auth');

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

describe('password-change-access-ssot', () => {
  it('STRUCT: /settings/security is not gated by system.read', () => {
    const app = read('App.tsx');
    const securityBlock = app.match(
      /path="\/settings\/security"[\s\S]{0,280}?<\/ProtectedRoute>/,
    )?.[0];
    expect(securityBlock, 'security route must exist').toBeTruthy();
    expect(securityBlock).not.toMatch(/system\.read/);
    expect(securityBlock).toMatch(/<ProtectedRoute>/);
  });

  it('STRUCT: cashiers and waiters may open /settings/security only', () => {
    expect(isCashierAllowedPath('/settings/security')).toBe(true);
    expect(isCashierAllowedPath('/settings')).toBe(false);
    expect(isWaiterAllowedPath('/settings/security')).toBe(true);
    expect(isWaiterAllowedPath('/settings')).toBe(false);
  });

  it('STRUCT: security page is an auth recovery path', () => {
    expect(isAuthRecoveryPath('/settings/security')).toBe(true);
    expect(isAuthRecoveryPath('/settings')).toBe(false);
    expect(isAuthRecoveryPath('/pos')).toBe(false);
  });

  it('STRUCT: password policy/validate stay public; change/expiry stay protected', () => {
    expect(isPublicApiRoute('auth/password/policy', 'GET')).toBe(true);
    expect(isPublicApiRoute('auth/password/validate', 'POST')).toBe(true);
    expect(isPublicApiRoute('auth/password/change', 'POST')).toBe(false);
    expect(isPublicApiRoute('auth/password/expiry', 'GET')).toBe(false);
    expect(isPublicApiRoute('auth/password/must-change', 'GET')).toBe(false);
  });

  it('STRUCT: password hooks use shared apiClient (token refresh SSOT)', () => {
    const hooks = read('hooks/usePasswordPolicy.ts');
    expect(hooks).toMatch(/from ['"]\.\.\/utils\/api['"]/);
    expect(hooks).toMatch(/apiClient\.(get|post)/);
    expect(hooks).not.toMatch(/from ['"]axios['"]/);
    expect(hooks).toMatch(/auth\/password\/change/);
  });

  it('STRUCT: login soft-redirects expired passwords to security settings', () => {
    const login = read('pages/LoginPage.tsx');
    expect(login).toMatch(/mustChangePassword/);
    expect(login).toMatch(/\/settings\/security/);
    expect(login).toMatch(/passwordExpiry/);
    expect(login).toMatch(/softMustChangeFromLoginPayload/);
    // 2FA success path must not skip soft-expiry (same SSOT as password login)
    const twoFaIdx = login.indexOf('const handle2FASuccess');
    expect(twoFaIdx).toBeGreaterThan(-1);
    const twoFaBody = login.slice(twoFaIdx);
    expect(twoFaBody).toMatch(/softMustChangeFromLoginPayload/);
    expect(twoFaBody).toMatch(/auth\/password\/must-change/);
    expect(twoFaBody).toMatch(/\/settings\/security/);
  });

  it('STRUCT: banner never links Change it now behind system settings', () => {
    const banner = read('components/auth/PasswordExpiryWarning.tsx');
    expect(banner).toMatch(/to="\/settings\/security"/);
    expect(banner).toMatch(/useMustChangePassword/);
    expect(banner).toMatch(/Your password has expired/);
  });

  it('STRUCT: Layout exposes Change password for all authenticated shells', () => {
    const layout = read('components/Layout.tsx');
    expect(layout).toMatch(/to="\/settings\/security"/);
    expect(layout).toMatch(/Change password/);
  });

  it('STRUCT: 2FA verify returns the same soft-expiry payload as password login', () => {
    const routes = readFileSync(join(serverAuth, 'twoFactorRoutes.ts'), 'utf8');
    expect(routes).toMatch(/mustChangePassword/);
    expect(routes).toMatch(/passwordExpiry/);
    expect(routes).toMatch(/getPasswordExpiryStatus/);
    expect(routes).toMatch(/mustChangePassword\(/);
  });
});
