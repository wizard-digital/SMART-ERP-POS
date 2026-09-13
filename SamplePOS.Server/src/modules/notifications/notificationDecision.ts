/**
 * Notification intelligence — four-level delivery decisions.
 *
 * Role is used for eligibility defaults only. Stored user preferences always win
 * except for MANDATORY types (in-app cannot be silenced). Device preferences
 * overlay user push intent per installation and must not be collapsed into
 * the user preference row.
 */

import { getPermission } from '../../rbac/permissions.js';
import type { NotificationTypeDefinition, PreferenceMode, RoleProfile } from './catalog.js';

export type { PreferenceMode, RoleProfile };

export interface ChannelPreference {
  inAppEnabled: boolean;
  pushEnabled: boolean;
}

export function resolveRoleProfile(legacyRole: string | null | undefined, rbacRoleNames: string[] = []): RoleProfile {
  const names = rbacRoleNames.map((n) => n.trim().toLowerCase());
  if (names.some((n) => n === 'accountant' || n.includes('accountant'))) return 'ACCOUNTANT';
  const role = (legacyRole || '').toUpperCase();
  if (role === 'ADMIN') return 'ADMIN';
  if (role === 'MANAGER') return 'MANAGER';
  if (role === 'CASHIER') return 'CASHIER';
  if (role === 'STAFF') return 'STAFF';
  if (names.some((n) => n === 'admin' || n === 'administrator' || n === 'director')) return 'ADMIN';
  if (names.some((n) => n === 'manager')) return 'MANAGER';
  if (names.some((n) => n === 'cashier')) return 'CASHIER';
  return 'OTHER';
}

/**
 * Matches recipient SQL: unscoped events go to tenant-wide scopes only.
 * Branch/warehouse roles receive an event only when the event has a matching location.
 */
export function scopeAllowsEvent(
  storeLocationId: string | null,
  scopeType: string | null | undefined,
  scopeId: string | null | undefined,
): boolean {
  if (!scopeType || scopeType === 'global' || scopeType === 'organization') return true;
  if (
    storeLocationId
    && (scopeType === 'branch' || scopeType === 'warehouse')
    && scopeId === storeLocationId
  ) {
    return true;
  }
  return false;
}

export function defaultChannelsForRole(
  type: NotificationTypeDefinition,
  role: RoleProfile,
): ChannelPreference {
  const override = type.roleDefaults?.[role];
  if (override) return { inAppEnabled: override.inApp, pushEnabled: override.push };
  return { inAppEnabled: type.defaultInApp, pushEnabled: type.defaultPush };
}

export function resolveUserChannels(
  type: NotificationTypeDefinition,
  stored: ChannelPreference | undefined,
  role: RoleProfile,
): ChannelPreference {
  const fallback = defaultChannelsForRole(type, role);
  const merged: ChannelPreference = stored
    ? { inAppEnabled: stored.inAppEnabled, pushEnabled: stored.pushEnabled }
    : fallback;

  if (type.preferenceMode === 'MANDATORY') {
    return { inAppEnabled: true, pushEnabled: merged.pushEnabled };
  }
  return merged;
}

export function resolveDevicePush(input: {
  userPushWanted: boolean;
  devicePushEnabled: boolean;
  deviceRevoked: boolean;
  deviceTypePref: boolean | undefined;
}): { push: boolean; reason: string } {
  if (input.deviceRevoked) return { push: false, reason: 'device_revoked' };
  if (!input.devicePushEnabled) return { push: false, reason: 'device_subscription_disabled' };
  if (!input.userPushWanted) return { push: false, reason: 'user_push_off' };
  if (input.deviceTypePref === false) return { push: false, reason: 'device_type_off' };
  return { push: true, reason: 'send' };
}

const AMOUNT_LIKE = /(?:UGX|USD|TZS|KES|EUR|GBP)\s*[\d,.]+|[\d]{1,3}(?:,\d{3})+(?:\.\d+)?/gi;

export function lockScreenCopy(
  type: Pick<NotificationTypeDefinition, 'label' | 'description'>,
  payload: Record<string, unknown>,
  lockScreenDetail: boolean,
): { title: string; body: string } {
  const title = type.label;
  if (!lockScreenDetail) {
    return { title, body: type.description };
  }
  const detail = typeof payload.summary === 'string' ? payload.summary : type.description;
  const redacted = detail.replace(AMOUNT_LIKE, '[amount hidden]');
  return { title, body: redacted.slice(0, 180) };
}

export function catalogPolicyLabel(mode: PreferenceMode): string {
  if (mode === 'MANDATORY') return 'Required';
  if (mode === 'ROLE_DEFAULT') return 'Role default';
  return 'Optional';
}

function lowerFirst(value: string): string {
  if (!value) return value;
  return value.charAt(0).toLowerCase() + value.slice(1);
}

export function permissionCapabilityLabel(permissionKey: string | null | undefined): string | null {
  if (!permissionKey) return null;
  const permission = getPermission(permissionKey);
  return permission?.description || permissionKey;
}

/** Settings copy: who this type is for. Catalog + RBAC only — not a second recipient engine. */
export function explainEligibility(type: NotificationTypeDefinition): string {
  const cap = permissionCapabilityLabel(type.requiredPermission);
  if (type.audience === 'subject_user') {
    return 'Delivered to the person this event happened to.';
  }
  if (type.audience === 'subject_and_admins') {
    return cap
      ? `Delivered to the person this happened to, and to people who can ${lowerFirst(cap)}.`
      : 'Delivered to the person this happened to, and to user administrators.';
  }
  if (cap) return `Delivered to people who can ${lowerFirst(cap)}.`;
  return 'Delivered to eligible users for this type.';
}

/** Inbox copy: why this recipient got this row. Same audience/permission SSOT as the worker. */
export function explainWhyReceived(input: {
  type: NotificationTypeDefinition;
  recipientUserId: string;
  entityType: string | null;
  entityId: string | null;
}): string {
  if (input.type.typeKey === 'NOTIFICATION_TEST') {
    return 'You sent a test notification.';
  }
  const happenedToYou =
    (input.type.audience === 'subject_user' || input.type.audience === 'subject_and_admins')
    && input.entityType === 'user'
    && input.entityId === input.recipientUserId;
  if (happenedToYou) {
    return input.type.preferenceMode === 'MANDATORY'
      ? 'Required. This happened on your account.'
      : 'This happened on your account.';
  }
  const cap = permissionCapabilityLabel(input.type.requiredPermission);
  if (input.type.preferenceMode === 'MANDATORY' && cap) {
    return `Required. You received this because you can ${lowerFirst(cap)}.`;
  }
  if (cap) {
    return `You received this because you can ${lowerFirst(cap)}.`;
  }
  if (input.type.audience === 'subject_and_admins') {
    return 'You received this because you can manage user access.';
  }
  return 'You are in the recipient set for this notification type.';
}

export type DeliveryDecisionReason =
  | 'tenant_disabled'
  | 'not_authorized'
  | 'user_opted_out'
  | 'in_app_only'
  | 'send_in_app_and_push'
  | 'mandatory_in_app';

export function describeRecipientDecision(input: {
  tenantAllowed: boolean;
  authorized: boolean;
  channels: ChannelPreference;
  preferenceMode: PreferenceMode;
}): { inApp: boolean; push: boolean; reason: DeliveryDecisionReason } {
  if (!input.tenantAllowed) return { inApp: false, push: false, reason: 'tenant_disabled' };
  if (!input.authorized) return { inApp: false, push: false, reason: 'not_authorized' };
  if (!input.channels.inAppEnabled && !input.channels.pushEnabled) {
    return { inApp: false, push: false, reason: 'user_opted_out' };
  }
  if (input.channels.inAppEnabled && !input.channels.pushEnabled) {
    return {
      inApp: true,
      push: false,
      reason: input.preferenceMode === 'MANDATORY' ? 'mandatory_in_app' : 'in_app_only',
    };
  }
  return {
    inApp: input.channels.inAppEnabled || input.preferenceMode === 'MANDATORY',
    push: input.channels.pushEnabled,
    reason: 'send_in_app_and_push',
  };
}
