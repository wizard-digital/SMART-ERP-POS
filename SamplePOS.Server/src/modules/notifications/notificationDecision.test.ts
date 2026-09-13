import { describe, expect, it } from '@jest/globals';
import { getNotificationType } from './catalog.js';
import {
  defaultChannelsForRole,
  describeRecipientDecision,
  explainEligibility,
  explainWhyReceived,
  lockScreenCopy,
  resolveDevicePush,
  resolveRoleProfile,
  resolveUserChannels,
  scopeAllowsEvent,
} from './notificationDecision.js';

describe('notification intelligence', () => {
  it('maps legacy and RBAC role names without treating role as a preference store', () => {
    expect(resolveRoleProfile('ADMIN', [])).toBe('ADMIN');
    expect(resolveRoleProfile('MANAGER', [])).toBe('MANAGER');
    expect(resolveRoleProfile('CASHIER', [])).toBe('CASHIER');
    expect(resolveRoleProfile('STAFF', ['Accountant'])).toBe('ACCOUNTANT');
    expect(resolveRoleProfile('STAFF', [])).toBe('STAFF');
  });

  it('lets two managers keep different stored preferences', () => {
    const type = getNotificationType('SALE_VOIDED')!;
    const managerA = resolveUserChannels(type, { inAppEnabled: true, pushEnabled: true }, 'MANAGER');
    const managerB = resolveUserChannels(type, { inAppEnabled: false, pushEnabled: false }, 'MANAGER');
    expect(managerA.inAppEnabled).toBe(true);
    expect(managerB.inAppEnabled).toBe(false);
  });

  it('uses role defaults only when the user has no stored row', () => {
    const payment = getNotificationType('CUSTOMER_PAYMENT_RECEIVED')!;
    expect(defaultChannelsForRole(payment, 'ACCOUNTANT').inAppEnabled).toBe(true);
    expect(defaultChannelsForRole(payment, 'MANAGER').inAppEnabled).toBe(false);
    expect(defaultChannelsForRole(payment, 'CASHIER').inAppEnabled).toBe(false);
    expect(defaultChannelsForRole(payment, 'ADMIN').inAppEnabled).toBe(true);
  });

  it('keeps high-volume sales off until the user opts in', () => {
    const sale = getNotificationType('SALE_COMPLETED')!;
    expect(sale.highVolume).toBe(true);
    expect(sale.preferenceMode).toBe('OPTIONAL');
    expect(resolveUserChannels(sale, undefined, 'ADMIN').inAppEnabled).toBe(false);
    expect(resolveUserChannels(sale, { inAppEnabled: true, pushEnabled: true }, 'ADMIN').inAppEnabled).toBe(true);
  });

  it('cannot silence mandatory security in-app notifications', () => {
    const security = getNotificationType('SECURITY_PASSWORD_CHANGED')!;
    expect(security.preferenceMode).toBe('MANDATORY');
    const silenced = resolveUserChannels(security, { inAppEnabled: false, pushEnabled: false }, 'CASHIER');
    expect(silenced.inAppEnabled).toBe(true);
    expect(silenced.pushEnabled).toBe(false);
  });

  it('evaluates devices independently of the user preference row', () => {
    const iphone = resolveDevicePush({
      userPushWanted: true,
      devicePushEnabled: true,
      deviceRevoked: false,
      deviceTypePref: true,
    });
    const laptop = resolveDevicePush({
      userPushWanted: true,
      devicePushEnabled: true,
      deviceRevoked: false,
      deviceTypePref: false,
    });
    expect(iphone).toEqual({ push: true, reason: 'send' });
    expect(laptop).toEqual({ push: false, reason: 'device_type_off' });
  });

  it('does not push to a revoked or disabled installation', () => {
    expect(resolveDevicePush({
      userPushWanted: true,
      devicePushEnabled: true,
      deviceRevoked: true,
      deviceTypePref: true,
    }).reason).toBe('device_revoked');
    expect(resolveDevicePush({
      userPushWanted: true,
      devicePushEnabled: false,
      deviceRevoked: false,
      deviceTypePref: true,
    }).reason).toBe('device_subscription_disabled');
  });

  it('keeps branch-scoped users off unscoped and other-branch events', () => {
    expect(scopeAllowsEvent('kampala', 'branch', 'kampala')).toBe(true);
    expect(scopeAllowsEvent('kampala', 'branch', 'entebbe')).toBe(false);
    expect(scopeAllowsEvent(null, 'branch', 'kampala')).toBe(false);
    expect(scopeAllowsEvent('kampala', 'global', null)).toBe(true);
    expect(scopeAllowsEvent(null, 'organization', null)).toBe(true);
    expect(scopeAllowsEvent('kampala', 'warehouse', 'kampala')).toBe(true);
  });

  it('uses a privacy-safe lock screen unless tenant policy enables detail', () => {
    const type = getNotificationType('CUSTOMER_PAYMENT_RECEIVED')!;
    const safe = lockScreenCopy(type, { summary: 'John Doe paid UGX 4,500,000 for INV-000923' }, false);
    expect(safe.body).toBe(type.description);
    expect(safe.body).not.toContain('4,500,000');
    const detailed = lockScreenCopy(type, { summary: 'John Doe paid UGX 4,500,000 for INV-000923' }, true);
    expect(detailed.body).not.toMatch(/4,500,000/);
    expect(detailed.body).toContain('[amount hidden]');
  });

  it('explains eligibility from catalog audience and RBAC, not a hardcoded manager list', () => {
    const sale = getNotificationType('SALE_VOIDED')!;
    expect(explainEligibility(sale)).toContain('view sales transactions');
    const password = getNotificationType('SECURITY_PASSWORD_CHANGED')!;
    expect(explainEligibility(password)).toContain('person this event happened to');
    const role = getNotificationType('SECURITY_ROLE_CHANGED')!;
    expect(explainEligibility(role)).toContain('modify users');
  });

  it('explains why a recipient received an inbox row', () => {
    const sale = getNotificationType('SALE_VOIDED')!;
    expect(explainWhyReceived({
      type: sale,
      recipientUserId: 'mary',
      entityType: 'sale',
      entityId: 'sale-1',
    })).toBe('You received this because you can view sales transactions.');
    const password = getNotificationType('SECURITY_PASSWORD_CHANGED')!;
    expect(explainWhyReceived({
      type: password,
      recipientUserId: 'john',
      entityType: 'user',
      entityId: 'john',
    })).toBe('Required. This happened on your account.');
    const test = getNotificationType('NOTIFICATION_TEST')!;
    expect(explainWhyReceived({
      type: test,
      recipientUserId: 'john',
      entityType: 'user',
      entityId: 'john',
    })).toBe('You sent a test notification.');
  });

  it('describes the four-level recipient decision', () => {
    expect(describeRecipientDecision({
      tenantAllowed: false,
      authorized: true,
      channels: { inAppEnabled: true, pushEnabled: true },
      preferenceMode: 'OPTIONAL',
    }).reason).toBe('tenant_disabled');
    expect(describeRecipientDecision({
      tenantAllowed: true,
      authorized: false,
      channels: { inAppEnabled: true, pushEnabled: true },
      preferenceMode: 'OPTIONAL',
    }).reason).toBe('not_authorized');
    expect(describeRecipientDecision({
      tenantAllowed: true,
      authorized: true,
      channels: { inAppEnabled: false, pushEnabled: false },
      preferenceMode: 'OPTIONAL',
    }).reason).toBe('user_opted_out');
  });
});
