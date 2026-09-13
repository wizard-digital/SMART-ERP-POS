/**
 * Presentation helpers for notification Settings.
 * Type keys stay independently controllable; this file only groups them.
 */

export type NotificationPrefType = {
  typeKey: string;
  category?: string;
  categoryLabel?: string;
  operatorBand?: string;
  operatorBandLabel?: string;
  uxArea?: string;
  uxAreaLabel?: string;
  uxAreaDescription?: string;
  uxAreaEmoji?: string;
  uxAreaAlwaysOn?: boolean;
  label: string;
  description?: string;
  whyYouReceive?: string;
  highVolume?: boolean;
  preferenceMode?: string;
  preferenceModeLabel?: string;
  recommendedInApp?: boolean;
  recommendedPush?: boolean;
  inAppEnabled: boolean;
  pushEnabled: boolean;
  inAppLocked?: boolean;
};

export type NotificationAreaGroup = {
  area: string;
  label: string;
  emoji: string;
  description: string;
  alwaysOn: boolean;
  preview: string;
  items: NotificationPrefType[];
  on: boolean;
};

export const UX_AREA_CARD_ORDER = [
  'SALES',
  'CUSTOMERS',
  'PURCHASING',
  'INVENTORY',
  'APPROVALS',
  'SECURITY',
  'FINANCE',
  'RESTAURANT',
] as const;

const AREA_FALLBACK_LABEL: Record<string, { label: string; emoji: string; description: string }> = {
  SALES: {
    label: 'Sales',
    emoji: '🛒',
    description: 'Sales activity, returns, discounts and price changes.',
  },
  CUSTOMERS: {
    label: 'Customers & Payments',
    emoji: '👥',
    description: 'Customer payments, credits and account changes.',
  },
  PURCHASING: {
    label: 'Purchasing',
    emoji: '📦',
    description: 'Purchase orders, receiving and supplier payments.',
  },
  INVENTORY: {
    label: 'Inventory',
    emoji: '📊',
    description: 'Stock levels, expiry, transfers and adjustments.',
  },
  APPROVALS: {
    label: 'Approvals',
    emoji: '✅',
    description: 'Things that require your attention or have been approved or rejected.',
  },
  SECURITY: {
    label: 'Security',
    emoji: '🔐',
    description: 'Account and permission changes.',
  },
  FINANCE: {
    label: 'Financial control',
    emoji: '💰',
    description: 'Important accounting and period-control events.',
  },
  RESTAURANT: {
    label: 'Restaurant',
    emoji: '🍽️',
    description: 'Restaurant operational activity.',
  },
};

const RECOMMENDED_AREA_LABEL: Record<string, string> = {
  SALES: 'Sales exceptions',
  CUSTOMERS: 'Customer payments',
  PURCHASING: 'Purchasing',
  INVENTORY: 'Stock alerts',
  APPROVALS: 'Approval requests',
  SECURITY: 'Security',
  FINANCE: 'Financial control',
  RESTAURANT: 'Restaurant',
};

const BAND_SORT = ['EXCEPTIONS', 'APPROVALS', 'MONEY', 'ACTIVITY', 'SECURITY', 'SYSTEM'];

export function isSettingsAreaCard(area: string): boolean {
  return area !== 'DEVICE';
}

export function resolveUxArea(item: NotificationPrefType): string {
  if (item.uxArea) return item.uxArea;
  if (item.category === 'CUSTOMER_AR') return 'CUSTOMERS';
  if (item.category === 'PURCHASING_AP') return 'PURCHASING';
  if (item.category === 'SYSTEM' && item.operatorBand === 'SYSTEM') return 'DEVICE';
  if (item.category === 'SYSTEM') return 'FINANCE';
  return item.category || 'SALES';
}

export function typeIsReceiving(item: NotificationPrefType): boolean {
  return item.inAppEnabled || item.pushEnabled;
}

export function areaIsOn(items: NotificationPrefType[]): boolean {
  return items.some(typeIsReceiving);
}

export type AreaPreferenceMode = 'always-on' | 'on' | 'off' | 'custom';

export type TypeDelivery = 'off' | 'in-app' | 'push' | 'both';

function channelsKey(items: NotificationPrefType[]): string {
  return items
    .map((item) => `${item.typeKey}:${item.inAppEnabled ? 1 : 0}:${item.pushEnabled ? 1 : 0}`)
    .join('|');
}

export function areaPreferenceMode(
  items: NotificationPrefType[],
  alwaysOn = false,
): AreaPreferenceMode {
  if (alwaysOn) return 'always-on';
  const current = channelsKey(items);
  if (current === channelsKey(applyAreaOn(items))) return 'on';
  if (current === channelsKey(applyAreaOff(items))) return 'off';
  return 'custom';
}

export function areaStatusLabel(mode: AreaPreferenceMode): string {
  if (mode === 'always-on') return 'Always on';
  if (mode === 'custom') return 'Custom';
  if (mode === 'on') return 'On';
  return 'Off';
}

export function typeDelivery(item: NotificationPrefType): TypeDelivery {
  if (item.inAppEnabled && item.pushEnabled) return 'both';
  if (item.inAppEnabled) return 'in-app';
  if (item.pushEnabled) return 'push';
  return 'off';
}

export function applyTypeDelivery(item: NotificationPrefType, delivery: TypeDelivery): NotificationPrefType {
  if (delivery === 'off') return applyTypeReceive(item, false);
  if (delivery === 'in-app') {
    if (item.inAppLocked || item.preferenceMode === 'MANDATORY') {
      return { ...item, inAppEnabled: true, pushEnabled: false };
    }
    return { ...item, inAppEnabled: true, pushEnabled: false };
  }
  if (delivery === 'push') {
    return {
      ...item,
      inAppEnabled: item.inAppLocked === true || item.preferenceMode === 'MANDATORY',
      pushEnabled: true,
    };
  }
  return {
    ...item,
    inAppEnabled: true,
    pushEnabled: true,
  };
}

export function previewTypeLabels(items: NotificationPrefType[], max = 5): string {
  return items.slice(0, max).map((item) => item.label).join(' · ');
}

function sortAreaItems(items: NotificationPrefType[]): NotificationPrefType[] {
  return items.slice().sort((a, b) => {
    const ai = BAND_SORT.indexOf(a.operatorBand || '');
    const bi = BAND_SORT.indexOf(b.operatorBand || '');
    const band = (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    if (band !== 0) return band;
    return a.label.localeCompare(b.label);
  });
}

export function groupPreferenceAreas(rows: NotificationPrefType[]): NotificationAreaGroup[] {
  const map = new Map<string, NotificationPrefType[]>();
  for (const item of rows) {
    const area = resolveUxArea(item);
    if (!isSettingsAreaCard(area)) continue;
    const list = map.get(area) || [];
    list.push(item);
    map.set(area, list);
  }
  return UX_AREA_CARD_ORDER
    .filter((area) => map.has(area))
    .map((area) => {
      const items = sortAreaItems(map.get(area) || []);
      const meta = AREA_FALLBACK_LABEL[area];
      const first = items[0];
      return {
        area,
        label: first?.uxAreaLabel || meta?.label || area,
        emoji: first?.uxAreaEmoji || meta?.emoji || '',
        description: first?.uxAreaDescription || meta?.description || '',
        alwaysOn: first?.uxAreaAlwaysOn === true || area === 'SECURITY',
        preview: previewTypeLabels(items),
        items,
        on: areaIsOn(items),
      };
    });
}

export function applyAreaOn(items: NotificationPrefType[]): NotificationPrefType[] {
  return items.map((item) => {
    const recommendedInApp = item.recommendedInApp === true || item.inAppLocked === true;
    const recommendedPush = item.recommendedPush === true;
    if (item.inAppLocked) {
      return { ...item, inAppEnabled: true, pushEnabled: recommendedPush };
    }
    return { ...item, inAppEnabled: recommendedInApp, pushEnabled: recommendedPush };
  });
}

export function applyAreaOff(items: NotificationPrefType[]): NotificationPrefType[] {
  return items.map((item) => {
    if (item.inAppLocked || item.preferenceMode === 'MANDATORY') {
      return { ...item, inAppEnabled: true, pushEnabled: false };
    }
    return { ...item, inAppEnabled: false, pushEnabled: false };
  });
}

export function applyTypeReceive(item: NotificationPrefType, receive: boolean): NotificationPrefType {
  if (!receive) {
    if (item.inAppLocked || item.preferenceMode === 'MANDATORY') {
      return { ...item, pushEnabled: false };
    }
    return { ...item, inAppEnabled: false, pushEnabled: false };
  }
  const recIn = item.recommendedInApp === true;
  const recPush = item.recommendedPush === true;
  if (recIn || recPush) {
    return {
      ...item,
      inAppEnabled: recIn || item.inAppLocked === true,
      pushEnabled: recPush,
    };
  }
  return { ...item, inAppEnabled: true };
}

export function applyTypeChannel(
  item: NotificationPrefType,
  channel: 'inApp' | 'push',
  enabled: boolean,
): NotificationPrefType {
  if (channel === 'inApp') {
    if (item.inAppLocked || item.preferenceMode === 'MANDATORY') return item;
    return { ...item, inAppEnabled: enabled, pushEnabled: enabled ? item.pushEnabled : false };
  }
  return { ...item, pushEnabled: enabled };
}

export function replaceAreaItems(
  rows: NotificationPrefType[],
  area: string,
  nextItems: NotificationPrefType[],
): NotificationPrefType[] {
  const byKey = new Map(nextItems.map((item) => [item.typeKey, item]));
  return rows.map((row) => {
    if (resolveUxArea(row) !== area) return row;
    return byKey.get(row.typeKey) || row;
  });
}

export function replaceType(
  rows: NotificationPrefType[],
  typeKey: string,
  next: NotificationPrefType,
): NotificationPrefType[] {
  return rows.map((row) => (row.typeKey === typeKey ? next : row));
}

export function recommendedAreaEntries(rows: NotificationPrefType[]): Array<{ area: string; label: string }> {
  const entries: Array<{ area: string; label: string }> = [];
  for (const area of UX_AREA_CARD_ORDER) {
    const items = rows.filter((row) => resolveUxArea(row) === area);
    if (items.length === 0) continue;
    const recommended = area === 'SECURITY' || items.some((item) => item.recommendedInApp || item.recommendedPush);
    if (!recommended) continue;
    entries.push({
      area,
      label: RECOMMENDED_AREA_LABEL[area] || items[0]?.uxAreaLabel || area,
    });
  }
  return entries;
}

/** Areas recommended for this role — not every type in the catalog. */
export function recommendedAreaLabels(rows: NotificationPrefType[]): string[] {
  return recommendedAreaEntries(rows).map((entry) => entry.label);
}

export function deviceMutedCount(device: {
  typePreferences?: Array<{ pushEnabled: boolean }>;
  typeOverrides?: Array<{ pushEnabled: boolean }>;
}): number {
  const rows = device.typeOverrides || device.typePreferences || [];
  return rows.filter((row) => row.pushEnabled === false).length;
}

export function lastActiveLabel(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  if (date.toDateString() === now.toDateString()) return 'Today';
  return date.toLocaleDateString();
}
