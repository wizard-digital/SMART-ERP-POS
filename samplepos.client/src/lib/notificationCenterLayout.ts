/**
 * Notification center chrome SSOT — how the inbox popup is presented.
 *
 * Notifications are a compact dropdown from the bell, never a full-screen sheet.
 * Mobile/compact still use a viewport-safe panel so text stays readable.
 */

import type { LayoutTier } from './layoutTiers';

export type NotificationCenterPresentation = 'dropdown';

/**
 * Always a dropdown. Tier only changes sizing/anchoring in the component.
 * Kept as a resolver so callers do not hard-code presentation.
 */
export function resolveNotificationCenterPresentation(
  _tier: LayoutTier | null | undefined,
): NotificationCenterPresentation {
  return 'dropdown';
}

/** Max panel height — readable list without swallowing the screen. */
export function notificationCenterMaxHeightCss(tier: LayoutTier | null | undefined): string {
  if (tier === 'mobile' || tier === 'compact') {
    return 'min(50dvh, 22rem)';
  }
  return 'min(24rem, calc(100dvh - 6rem))';
}

/** Panel width — fills usable width on phone, fixed card on desk. */
export function notificationCenterWidthClass(tier: LayoutTier | null | undefined): string {
  if (tier === 'mobile' || tier === 'compact') {
    return 'w-[calc(100vw-1rem)] max-w-[calc(100vw-1rem)]';
  }
  return 'w-[min(24rem,calc(100vw-1.5rem))] max-w-[calc(100vw-1rem)]';
}
