import { describe, expect, it } from 'vitest';
import {
  appendNotificationQuery,
  isNotificationId,
  locationFromState,
  notificationIdFromPath,
  resolveAuthorizedNotificationPath,
  toInAppLocation,
} from './notificationNavigation';

describe('notification navigation', () => {
  it('accepts in-app paths and rejects off-app URLs', () => {
    expect(resolveAuthorizedNotificationPath('/sales')).toBe('/sales');
    expect(resolveAuthorizedNotificationPath('/customers/abc')).toBe('/customers/abc');
    expect(resolveAuthorizedNotificationPath('/settings?tab=users')).toBe('/settings?tab=users');
    expect(resolveAuthorizedNotificationPath('https://evil.example/x')).toBe('/settings/notifications');
    expect(resolveAuthorizedNotificationPath('//evil.example')).toBe('/settings/notifications');
    expect(resolveAuthorizedNotificationPath('javascript:alert(1)')).toBe('/settings/notifications');
  });

  it('splits query strings out of pathname for object navigation', () => {
    expect(toInAppLocation('/settings?tab=users')).toEqual({
      pathname: '/settings',
      search: '?tab=users',
    });
    expect(toInAppLocation('/sales')).toEqual({ pathname: '/sales', search: '' });
    expect(toInAppLocation('https://evil.example/x')).toEqual({
      pathname: '/settings/notifications',
      search: '',
    });
  });

  it('preserves nid across home redirects without accepting junk ids', () => {
    const nid = '11111111-2222-4333-a444-555555555555';
    expect(isNotificationId(nid)).toBe(true);
    expect(appendNotificationQuery('/dashboard', nid)).toBe(`/dashboard?nid=${nid}`);
    expect(appendNotificationQuery('/pos?x=1', nid)).toBe(`/pos?x=1&nid=${nid}`);
    expect(appendNotificationQuery('/dashboard', 'not-a-uuid')).toBe('/dashboard');
  });

  it('rebuilds login intended location from pathname + search', () => {
    expect(locationFromState({ pathname: '/', search: '?nid=11111111-2222-4333-a444-555555555555' }))
      .toBe('/?nid=11111111-2222-4333-a444-555555555555');
    expect(locationFromState({ pathname: '/sales' })).toBe('/sales');
  });

  it('extracts a notification id from an intended path', () => {
    const nid = '11111111-2222-4333-a444-555555555555';
    expect(notificationIdFromPath(`/?nid=${nid}`)).toBe(nid);
    expect(notificationIdFromPath('/dashboard')).toBeNull();
  });
});
