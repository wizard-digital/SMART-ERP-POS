/**
 * Inbox / lock-screen copy. Actor identity comes from the committed event,
 * never from the job worker's session.
 */

import type { NotificationTypeDefinition } from './catalog.js';

export type NotificationPriority = 'CRITICAL' | 'HIGH' | 'NORMAL' | 'LOW';

export function priorityFromType(type: NotificationTypeDefinition): NotificationPriority {
  if (type.severity === 'CRITICAL') return 'CRITICAL';
  if (type.severity === 'WARNING') return 'HIGH';
  if (type.highVolume) return 'LOW';
  return 'NORMAL';
}

export function groupingKeyFor(
  type: NotificationTypeDefinition,
  storeLocationId: string | null,
  occurredAt: Date,
): string | null {
  if (!type.highVolume) return null;
  const hour = occurredAt.toISOString().slice(0, 13);
  return `${type.typeKey}:${storeLocationId || 'all'}:${hour}`;
}

export type InboxOperatorFilter = 'attention' | 'waiting' | 'cash' | 'all';

export function inboxMatchesFilter(
  operatorBand: string | null | undefined,
  filter: InboxOperatorFilter,
): boolean {
  if (filter === 'all') return true;
  if (filter === 'attention') {
    return operatorBand === 'EXCEPTIONS' || operatorBand === 'SECURITY' || operatorBand === 'SYSTEM';
  }
  if (filter === 'waiting') return operatorBand === 'APPROVALS';
  if (filter === 'cash') return operatorBand === 'MONEY';
  return true;
}

export function formatAmountLabel(amount: unknown, currency?: unknown): string | null {
  const n = typeof amount === 'number' ? amount : Number(amount);
  if (!Number.isFinite(n)) return null;
  const cur = typeof currency === 'string' && currency.trim() ? currency.trim() : '';
  const formatted = n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  return cur ? `${cur} ${formatted}` : formatted;
}

export function formatInboxBody(input: {
  actorDisplay: string | null;
  actorRole: string | null;
  documentRef: string | null;
  locationLabel: string | null;
  amountLabel: string | null;
  fallback: string;
}): string {
  const actor = [input.actorDisplay, input.actorRole].filter(Boolean).join(' — ');
  const headline = [actor || null, input.documentRef].filter(Boolean).join(' · ');
  const context = [input.locationLabel, input.amountLabel].filter(Boolean).join(' · ');
  const lines = [headline, context].filter(Boolean);
  if (lines.length === 0) return input.fallback;
  return lines.join('\n');
}

export function payloadString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function shouldNotifyActorAsRecipient(audience: NotificationTypeDefinition['audience']): boolean {
  return audience === 'subject_user' || audience === 'subject_and_admins';
}
