import { describe, expect, it } from 'vitest';
import {
  notificationCenterMaxHeightCss,
  notificationCenterWidthClass,
  resolveNotificationCenterPresentation,
} from './notificationCenterLayout';

describe('notification center layout SSOT', () => {
  it('always presents as a compact dropdown, never a full-screen sheet', () => {
    expect(resolveNotificationCenterPresentation('mobile')).toBe('dropdown');
    expect(resolveNotificationCenterPresentation('compact')).toBe('dropdown');
    expect(resolveNotificationCenterPresentation('desktop')).toBe('dropdown');
    expect(resolveNotificationCenterPresentation('wide')).toBe('dropdown');
  });

  it('caps phone height so the panel does not swallow the screen', () => {
    expect(notificationCenterMaxHeightCss('mobile')).toContain('50dvh');
    expect(notificationCenterMaxHeightCss('mobile')).toContain('22rem');
    expect(notificationCenterMaxHeightCss('desktop')).toContain('24rem');
  });

  it('uses near-full usable width on phone and a card width on desk', () => {
    expect(notificationCenterWidthClass('mobile')).toContain('100vw-1rem');
    expect(notificationCenterWidthClass('desktop')).toContain('24rem');
  });
});
