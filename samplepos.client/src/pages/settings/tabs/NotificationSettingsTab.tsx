import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { apiClient } from '../../../utils/api';
import { detectPushCapability } from '../../../lib/pushCapability';
import { getOrCreateInstallationId, subscribeThisBrowser, platformHintFromCapabilities, rememberSubscriptionId } from '../../../lib/pushSubscription';
import { useAdaptiveLayoutOptional } from '../../../components/adaptive';
import {
  applyAreaOff,
  applyAreaOn,
  applyTypeDelivery,
  areaPreferenceMode,
  areaStatusLabel,
  deviceMutedCount,
  groupPreferenceAreas,
  lastActiveLabel,
  recommendedAreaEntries,
  replaceAreaItems,
  replaceType,
  typeDelivery,
  type NotificationPrefType,
} from '../../../lib/notificationAreas';

type CatalogType = NotificationPrefType;

type DeviceOverride = { typeKey: string; pushEnabled: boolean; label?: string };

type Device = {
  id: string;
  clientInstallationId?: string;
  platformHint: string;
  browserHint: string | null;
  displayName: string | null;
  pushEnabled: boolean;
  lastSeenAt: string;
  revoked: boolean;
  typePreferences?: DeviceOverride[];
  typeOverrides?: DeviceOverride[];
  followsUserTypes?: boolean;
};

function asList<T>(data: unknown): T[] {
  return Array.isArray(data) ? (data as T[]) : [];
}

function describePushRegisterError(err: unknown): string {
  if (!err || typeof err !== 'object') return 'In-app notifications still work.';
  const rec = err as {
    name?: string;
    message?: string;
    response?: { data?: { error?: string; message?: string } };
  };
  const api = rec.response?.data?.error || rec.response?.data?.message;
  if (api) return api;
  if (rec.name === 'InvalidStateError') {
    return 'This browser already had a push subscription. Reload and enable again.';
  }
  if (rec.name === 'NotAllowedError') return 'Notification permission was not granted.';
  if (rec.name === 'AbortError') return 'The browser aborted the push subscription.';
  if (rec.message) return rec.message;
  return 'In-app notifications still work.';
}

type AdminPolicy = {
  typeKey: string;
  operatorBand?: string;
  operatorBandLabel?: string;
  uxArea?: string;
  uxAreaLabel?: string;
  categoryLabel: string;
  label: string;
  description: string;
  isAllowed: boolean;
  lockScreenDetail: boolean;
  preferenceMode?: string;
};

type CatalogMeta = {
  vapidConfigured?: boolean;
  vapidPublicKey?: string | null;
};

export default function NotificationSettingsTab({ canAdmin = false }: { canAdmin?: boolean }) {
  const layout = useAdaptiveLayoutOptional();
  const queryClient = useQueryClient();
  const capability = useMemo(() => detectPushCapability(), []);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [mutePick, setMutePick] = useState<Record<string, string>>({});
  const [selectedArea, setSelectedArea] = useState<string>('');
  const [selectedPolicyArea, setSelectedPolicyArea] = useState<string>('');
  const [managingDeviceId, setManagingDeviceId] = useState<string | null>(null);
  const [customizeOpen, setCustomizeOpen] = useState(true);

  const catalogQuery = useQuery({
    queryKey: ['notifications', 'catalog'],
    retry: false,
    queryFn: async () => {
      const res = await apiClient.get('/notifications/catalog', { silentErrorToast: true });
      return (res.data?.data || {}) as CatalogMeta;
    },
  });

  const prefsQuery = useQuery({
    queryKey: ['notifications', 'preferences'],
    retry: false,
    queryFn: async () => {
      const res = await apiClient.get('/notifications/preferences', { silentErrorToast: true });
      return asList<CatalogType>(res.data?.data);
    },
  });

  const devicesQuery = useQuery({
    queryKey: ['notifications', 'devices'],
    retry: false,
    queryFn: async () => {
      const res = await apiClient.get('/notifications/devices', { silentErrorToast: true });
      return asList<Device>(res.data?.data);
    },
  });

  const policyQuery = useQuery({
    queryKey: ['notifications', 'admin-policy'],
    enabled: canAdmin,
    retry: false,
    queryFn: async () => {
      const res = await apiClient.get('/notifications/admin/policy', { silentErrorToast: true });
      return asList<AdminPolicy>(res.data?.data);
    },
  });

  const savePrefs = useMutation({
    mutationFn: async (items: CatalogType[]) =>
      apiClient.put('/notifications/preferences', {
        items: items.map((t) => ({
          typeKey: t.typeKey,
          inAppEnabled: t.inAppEnabled,
          pushEnabled: t.pushEnabled,
        })),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications', 'preferences'] });
      toast.success('Notification preferences saved');
    },
    onError: () => toast.error('Could not save preferences'),
  });

  const savePolicy = useMutation({
    mutationFn: async (items: AdminPolicy[]) =>
      apiClient.put('/notifications/admin/policy', {
        items: items.map((t) => ({
          typeKey: t.typeKey,
          isAllowed: t.isAllowed,
          lockScreenDetail: t.lockScreenDetail,
        })),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
      toast.success('Company notification policy saved');
    },
  });

  const thisInstallationId = useMemo(() => getOrCreateInstallationId(), []);
  const prefRows = asList<CatalogType>(prefsQuery.data);
  const deviceRows = asList<Device>(devicesQuery.data);
  const policyRows = asList<AdminPolicy>(policyQuery.data);
  const thisDevice = deviceRows.find((d) => d.clientInstallationId === thisInstallationId);
  const areas = useMemo(() => groupPreferenceAreas(prefRows), [prefRows]);
  const recommended = useMemo(() => recommendedAreaEntries(prefRows), [prefRows]);
  const selectedGroup = areas.find((group) => group.area === selectedArea) || areas[0] || null;
  const selectedMode = selectedGroup
    ? areaPreferenceMode(selectedGroup.items, selectedGroup.alwaysOn)
    : 'off';

  const policyGrouped = useMemo(() => {
    const map = new Map<string, AdminPolicy[]>();
    for (const item of policyRows) {
      const key = item.uxArea || item.operatorBand || item.categoryLabel || 'other';
      const list = map.get(key) || [];
      list.push(item);
      map.set(key, list);
    }
    return [...map.entries()].map(([area, items]) => ({
      area,
      label: items[0]?.uxAreaLabel || items[0]?.operatorBandLabel || items[0]?.categoryLabel || area,
      items,
    }));
  }, [policyRows]);
  const selectedPolicyGroup = policyGrouped.find((group) => group.area === selectedPolicyArea) || policyGrouped[0] || null;

  useEffect(() => {
    if (areas.length === 0) return;
    if (!selectedArea || !areas.some((group) => group.area === selectedArea)) {
      setSelectedArea(areas[0].area);
    }
  }, [areas, selectedArea]);

  useEffect(() => {
    if (policyGrouped.length === 0) return;
    if (!selectedPolicyArea || !policyGrouped.some((group) => group.area === selectedPolicyArea)) {
      setSelectedPolicyArea(policyGrouped[0].area);
    }
  }, [policyGrouped, selectedPolicyArea]);

  async function enablePush() {
    const caps = detectPushCapability();
    if (caps.needsHomeScreenInstall) {
      toast.error('Add SMART-ERP-POS to your Home Screen, then open it from the icon to enable notifications.');
      return;
    }
    if (!caps.canSubscribe) {
      toast.error(
        caps.needsHomeScreenInstall
          ? 'Add SMART-ERP-POS to your Home Screen, then open it from the icon to enable notifications.'
          : 'This browser cannot receive Web Push notifications. Use HTTPS or localhost.',
      );
      return;
    }
    if (!('serviceWorker' in navigator)) {
      toast.error('Service worker is required for push notifications.');
      return;
    }
    const catalog = catalogQuery.data
      || ((await apiClient.get('/notifications/catalog', { silentErrorToast: true })).data?.data as CatalogMeta | undefined);
    const publicKey = catalog?.vapidPublicKey || undefined;
    if (!publicKey) {
      toast.error('OS push is not available on this server yet. In-app notifications still work.');
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      toast.error('Notification permission was not granted.');
      return;
    }
    try {
      const json = await subscribeThisBrowser(publicKey);
      const coarse = window.matchMedia('(pointer: coarse)').matches;
      const created = await apiClient.post('/notifications/devices', {
        endpoint: json.endpoint,
        keys: json.keys,
        clientInstallationId: getOrCreateInstallationId(),
        platformHint: platformHintFromCapabilities({ standalone: caps.standalone, coarsePointer: coarse }),
        browserHint: navigator.userAgent.slice(0, 64),
        displayName: caps.standalone ? 'Installed app' : 'Browser',
        permissionState: 'granted',
      });
      if (created.data?.data?.id) {
        rememberSubscriptionId(String(created.data.data.id));
      }
      queryClient.invalidateQueries({ queryKey: ['notifications', 'devices'] });
      toast.success('This device is registered for push notifications.');
    } catch (err: unknown) {
      toast.error(`Could not register this browser for OS push: ${describePushRegisterError(err)}`);
    }
  }

  async function sendTest() {
    setTestResult(null);
    const caps = detectPushCapability();
    if (caps.permission !== 'granted' && caps.canSubscribe) {
      setTestResult('permission not granted');
    }
    const res = await apiClient.post('/notifications/test');
    const data = res.data?.data;
    setTestResult(`${data?.status || 'unknown'}: ${data?.reason || ''}`);
    queryClient.invalidateQueries({ queryKey: ['notifications'] });
  }

  function deviceTitle(device: Device): string {
    if (device.platformHint === 'ios') return 'iPhone / iPad';
    if (device.platformHint === 'android') return 'Android phone';
    if (device.platformHint === 'desktop') return 'Windows';
    return device.displayName || device.platformHint;
  }

  function browserLabel(device: Device): string | null {
    const hint = (device.browserHint || device.displayName || '').toLowerCase();
    if (hint.includes('edg')) return 'Edge';
    if (hint.includes('chrome')) return 'Chrome';
    if (hint.includes('firefox')) return 'Firefox';
    if (hint.includes('safari')) return 'Safari';
    if (device.displayName) return device.displayName;
    return null;
  }

  function deviceHeadline(device: Device): string {
    const browser = browserLabel(device);
    return browser ? `${deviceTitle(device)} · ${browser}` : deviceTitle(device);
  }

  function deviceMutes(device: Device): DeviceOverride[] {
    const rows = device.typeOverrides || device.typePreferences || [];
    return rows.filter((row) => row.pushEnabled === false);
  }

  async function patchDevice(deviceId: string, body: Record<string, unknown>) {
    await apiClient.patch(`/notifications/devices/${deviceId}`, body);
    await queryClient.invalidateQueries({ queryKey: ['notifications', 'devices'] });
  }

  function writePrefs(next: CatalogType[]) {
    queryClient.setQueryData(['notifications', 'preferences'], next);
  }

  const thisDeviceRows = deviceRows.filter((device) => device.clientInstallationId === thisInstallationId);
  const otherDeviceRows = deviceRows.filter((device) => device.clientInstallationId !== thisInstallationId);
  const managingDevice = deviceRows.find((device) => device.id === managingDeviceId) || null;

  function renderDeviceManage(device: Device) {
    const mutes = deviceMutes(device);
    const muteCandidates = prefRows.filter(
      (item) => item.pushEnabled && !mutes.some((row) => row.typeKey === item.typeKey),
    );
    return (
      <div className="py-2 text-sm">
        <p className="font-medium text-gray-900">
          {deviceHeadline(device)}{device.revoked ? ' (removed)' : ''}
        </p>
        <p className="text-xs text-gray-500">
          {device.pushEnabled ? 'Push: On' : 'Push: Off'}
          {' · last active '}
          {lastActiveLabel(device.lastSeenAt)}
        </p>
        {!device.revoked && (
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              className="px-3 py-1 border border-gray-300 rounded-lg text-xs min-h-[var(--layout-touch-target)]"
              onClick={() => void patchDevice(device.id, { pushEnabled: !device.pushEnabled })}
            >
              {device.pushEnabled ? 'Turn off lock-screen push' : 'Turn on lock-screen push'}
            </button>
            <button
              type="button"
              className="px-3 py-1 border border-red-200 text-red-700 rounded-lg text-xs min-h-[var(--layout-touch-target)]"
              onClick={() =>
                void apiClient
                  .delete(`/notifications/devices/${device.id}`)
                  .then(() => {
                    setManagingDeviceId(null);
                    queryClient.invalidateQueries({ queryKey: ['notifications', 'devices'] });
                  })
              }
            >
              Remove
            </button>
          </div>
        )}
        {!device.revoked && (
          <div className="mt-3 rounded-md border border-gray-100 bg-gray-50 p-3">
            <p className="text-xs font-semibold text-gray-800">Exceptions on this device</p>
            <p className="mt-1 text-xs text-gray-600">
              Muting a type here does not change your notification types or other devices.
            </p>
            {!device.pushEnabled && (
              <p className="mt-1 text-xs text-gray-600">
                Exceptions apply only when lock-screen push is on for this device.
              </p>
            )}
            {mutes.length === 0 ? (
              <p className="mt-1 text-xs text-gray-600" data-testid="device-follows-user-types">
                This device follows your notification types. No exceptions.
              </p>
            ) : (
              <ul className="mt-2 space-y-1">
                {mutes.map((row) => (
                  <li key={`${device.id}-${row.typeKey}`} className="flex items-center justify-between gap-2">
                    <span className="text-xs text-gray-800">
                      {row.label || prefRows.find((item) => item.typeKey === row.typeKey)?.label || row.typeKey}
                      {' — muted on this device'}
                    </span>
                    <button
                      type="button"
                      className="text-xs text-blue-600 hover:underline min-h-[var(--layout-touch-target)]"
                      onClick={() =>
                        void patchDevice(device.id, {
                          typeKeys: [{ typeKey: row.typeKey, pushEnabled: true }],
                        })
                      }
                    >
                      Unmute
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {device.pushEnabled && muteCandidates.length > 0 && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <select
                  className="text-xs border border-gray-300 rounded-lg px-2 py-1 min-h-[var(--layout-touch-target)]"
                  value={mutePick[device.id] || ''}
                  onChange={(e) => setMutePick((prev) => ({ ...prev, [device.id]: e.target.value }))}
                  aria-label={`Mute a type on ${deviceTitle(device)}`}
                >
                  <option value="">Mute a lock-screen type…</option>
                  {muteCandidates.map((item) => (
                    <option key={item.typeKey} value={item.typeKey}>{item.label}</option>
                  ))}
                </select>
                <button
                  type="button"
                  className="px-3 py-1 border border-gray-300 rounded-lg text-xs min-h-[var(--layout-touch-target)]"
                  disabled={!mutePick[device.id]}
                  onClick={() => {
                    const typeKey = mutePick[device.id];
                    if (!typeKey) return;
                    void patchDevice(device.id, {
                      typeKeys: [{ typeKey, pushEnabled: false }],
                    }).then(() => setMutePick((prev) => ({ ...prev, [device.id]: '' })));
                  }}
                >
                  Mute on this device
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  function renderDeviceSummary(device: Device) {
    const muted = deviceMutedCount(device);
    return (
      <li key={device.id} className="py-3 flex items-start justify-between gap-3 text-sm">
        <div>
          <p className="font-medium text-gray-900">
            {deviceHeadline(device)}{device.revoked ? ' (removed)' : ''}
          </p>
          <p className="text-xs text-gray-500">
            {device.pushEnabled ? 'Push: On' : 'Push: Off'}
            {muted > 0 ? ` · ${muted} notification type${muted === 1 ? '' : 's'} customized` : ''}
            {' · last active '}
            {lastActiveLabel(device.lastSeenAt)}
          </p>
        </div>
        {!device.revoked && (
          <button
            type="button"
            className="text-sm text-blue-700 hover:underline min-h-[var(--layout-touch-target)]"
            onClick={() => setManagingDeviceId(device.id)}
          >
            Manage device →
          </button>
        )}
      </li>
    );
  }

  return (
    <div className="space-y-6">
      <section className="bg-white rounded-lg shadow-sm p-6">
        <h2 className="text-xl font-semibold text-gray-900">Recommended for you</h2>
        <p className="text-sm text-gray-600 mt-1">
          We&apos;ve selected important notifications based on your role and the areas you can access.
        </p>
        {recommended.length > 0 ? (
          <ul className="mt-3 list-disc list-inside text-sm text-gray-800 space-y-1">
            {recommended.map((entry) => (
              <li key={entry.area}>
                <button
                  type="button"
                  className="text-blue-700 hover:underline"
                  onClick={() => {
                    setCustomizeOpen(true);
                    setSelectedArea(entry.area);
                  }}
                >
                  {entry.label}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-gray-500">Your role defaults will appear here once preferences load.</p>
        )}
        <button
          type="button"
          className="mt-4 text-sm text-blue-700 hover:underline min-h-[var(--layout-touch-target)]"
          onClick={() => setCustomizeOpen((open) => !open)}
        >
          {customizeOpen ? 'Hide customization' : 'Customize notifications'}
        </button>
      </section>

      {customizeOpen && (
        <section className="bg-white rounded-lg shadow-sm p-6">
          <h2 className="text-xl font-semibold text-gray-900">Notifications</h2>
          <p className="text-sm text-gray-600 mt-1">Choose the areas you want to be notified about.</p>
          {prefsQuery.isError && (
            <p className="mt-3 text-sm text-red-700">Could not load notification types. The API may be unavailable.</p>
          )}
          {areas.length > 0 && selectedGroup && (
            <div className={`mt-4 ${layout?.tier === 'mobile' ? 'space-y-3' : 'space-y-4'}`}>
              <label className="block text-sm font-medium text-gray-800">
                Category
                <select
                  className="mt-1 block w-full border border-gray-300 rounded-lg px-3 py-2 bg-white text-sm min-h-[var(--layout-touch-target)]"
                  aria-label="Notification category"
                  value={selectedGroup.area}
                  onChange={(e) => setSelectedArea(e.target.value)}
                >
                  {areas.map((group) => {
                    const mode = areaPreferenceMode(group.items, group.alwaysOn);
                    return (
                      <option key={group.area} value={group.area}>
                        {group.emoji} {group.label} — {areaStatusLabel(mode)}
                      </option>
                    );
                  })}
                </select>
              </label>
              <div className="rounded-lg border border-gray-200 p-4">
                <div className={`flex ${layout?.tier === 'mobile' ? 'flex-col gap-3' : 'items-start justify-between gap-4'}`}>
                  <div>
                    <h3 className="text-sm font-semibold text-gray-900">
                      <span className="mr-1" aria-hidden="true">{selectedGroup.emoji}</span>
                      {selectedGroup.label}
                    </h3>
                    <p className="text-xs text-gray-500 mt-0.5">{selectedGroup.description}</p>
                    <p className="text-xs text-gray-400 mt-1">{selectedGroup.preview}</p>
                  </div>
                  {selectedGroup.alwaysOn ? (
                    <span className="shrink-0 text-xs font-semibold uppercase tracking-wide text-gray-600 bg-gray-100 px-2 py-1 rounded">
                      Always on
                    </span>
                  ) : (
                    <label className="block text-xs font-medium text-gray-700 shrink-0">
                      Notify me
                      <select
                        className="mt-1 block border border-gray-300 rounded-lg px-3 py-2 bg-white text-sm min-h-[var(--layout-touch-target)]"
                        aria-label={`${selectedGroup.label} notification status`}
                        value={selectedMode === 'custom' ? 'custom' : selectedMode}
                        onChange={(e) => {
                          const next = e.target.value;
                          if (next === 'custom') return;
                          const nextItems = next === 'off'
                            ? applyAreaOff(selectedGroup.items)
                            : applyAreaOn(selectedGroup.items);
                          writePrefs(replaceAreaItems(prefRows, selectedGroup.area, nextItems));
                        }}
                      >
                        <option value="on">On</option>
                        <option value="off">Off</option>
                        {selectedMode === 'custom' ? <option value="custom">Custom</option> : null}
                      </select>
                    </label>
                  )}
                </div>
                <div className="mt-4 border-t border-gray-100 pt-3">
                  <h4 className="text-sm font-semibold text-gray-800">{selectedGroup.label} notifications</h4>
                  <ul className="mt-2 divide-y divide-gray-100">
                    {selectedGroup.items.map((item) => {
                      const delivery = typeDelivery(item);
                      return (
                        <li key={item.typeKey} className={`py-3 ${layout?.tier === 'mobile' ? 'space-y-2' : 'flex items-start justify-between gap-4'}`}>
                          <div>
                            <p className="text-sm font-medium text-gray-900">
                              {item.label}
                              {item.preferenceModeLabel ? (
                                <span className="ml-2 text-[11px] font-normal text-gray-500">{item.preferenceModeLabel}</span>
                              ) : null}
                            </p>
                            <p className="text-xs text-gray-500">{item.description}</p>
                            {item.whyYouReceive ? (
                              <p className="text-xs text-gray-500 mt-1">{item.whyYouReceive}</p>
                            ) : null}
                          </div>
                          <label className="block text-xs font-medium text-gray-700 shrink-0">
                            Deliver to
                            <select
                              className="mt-1 block border border-gray-300 rounded-lg px-3 py-2 bg-white text-sm min-h-[var(--layout-touch-target)]"
                              aria-label={`Deliver ${item.label}`}
                              value={delivery}
                              onChange={(e) => {
                                writePrefs(
                                  replaceType(
                                    prefRows,
                                    item.typeKey,
                                    applyTypeDelivery(item, e.target.value as 'off' | 'in-app' | 'push' | 'both'),
                                  ),
                                );
                              }}
                            >
                              {!item.inAppLocked ? <option value="off">Off</option> : null}
                              <option value="in-app">In-app</option>
                              <option value="push">Push</option>
                              <option value="both">In-app and push</option>
                            </select>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </div>
            </div>
          )}
          <button
            type="button"
            className="mt-4 px-4 py-2 bg-blue-600 text-white rounded-lg min-h-[var(--layout-touch-target)]"
            onClick={() => savePrefs.mutate(prefRows)}
          >
            Save preferences
          </button>
        </section>
      )}

      <section className="bg-white rounded-lg shadow-sm p-6">
        <h2 className="text-xl font-semibold text-gray-900">This browser</h2>
        <p className="text-sm text-gray-600 mt-1">
          In-app notifications are stored in SMART-ERP-POS. Lock-screen push needs permission on this device
          {capability.needsHomeScreenInstall ? ' and an installed Home Screen app on iPhone/iPad' : ''}.
        </p>
        {capability.needsHomeScreenInstall && (
          <div className="mt-3 p-3 rounded bg-amber-50 text-amber-900 text-sm">
            iPhone/iPad: use Share → Add to Home Screen, then open SMART-ERP-POS from the Home Screen icon before enabling notifications. An ordinary Safari tab cannot receive Web Push.
          </div>
        )}
        {!capability.canSubscribe && !capability.needsHomeScreenInstall && (
          <div className="mt-3 p-3 rounded bg-gray-50 text-gray-700 text-sm">
            This environment does not expose the Push API. You can still use the in-app notification center.
          </div>
        )}
        {catalogQuery.data && catalogQuery.data.vapidConfigured === false && (
          <div className="mt-3 p-3 rounded bg-amber-50 text-amber-900 text-sm">
            OS lock-screen push is not configured on this server. In-app notifications still work.
          </div>
        )}
        <p className="mt-3 text-sm text-gray-700">
          Push status: {capability.canSubscribe
            ? (capability.permission === 'granted' ? 'permission granted' : 'permission not granted yet')
            : capability.needsHomeScreenInstall
              ? 'install the app to the Home Screen first'
              : 'not available in this browser'}
          {thisDevice ? (thisDevice.pushEnabled ? ' · this device is registered' : ' · registered but lock-screen push is off') : ' · this device is not registered'}
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void enablePush()}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg min-h-[var(--layout-touch-target)]"
          >
            Enable notifications on this device
          </button>
          <button
            type="button"
            onClick={() => void sendTest()}
            className="px-4 py-2 border border-gray-300 rounded-lg min-h-[var(--layout-touch-target)]"
          >
            Send test notification
          </button>
        </div>
        {testResult && <p className="mt-2 text-sm text-gray-700" data-testid="notification-test-result">{testResult}</p>}
      </section>

      <section className="bg-white rounded-lg shadow-sm p-6">
        <h2 className="text-xl font-semibold text-gray-900">Devices</h2>
        {managingDevice ? (
          <div>
            <button
              type="button"
              className="text-sm text-blue-700 hover:underline min-h-[var(--layout-touch-target)]"
              onClick={() => setManagingDeviceId(null)}
            >
              ← Back to devices
            </button>
            <p className="text-sm text-gray-600 mt-2">
              Device exceptions never rewrite your notification types.
            </p>
            {renderDeviceManage(managingDevice)}
          </div>
        ) : (
          <>
            <p className="text-sm text-gray-600 mt-1">
              Each phone, tablet, or browser is independent. Open a device only when you need to change push or mute a type there.
            </p>
            <h3 className="text-sm font-semibold text-gray-800 mt-4">This device</h3>
            {thisDeviceRows.length === 0 && (
              <p className="mt-2 text-sm text-gray-500">Not registered yet. Enable notifications on this browser first.</p>
            )}
            <ul className="mt-2 divide-y divide-gray-100">
              {thisDeviceRows.map((device) => renderDeviceSummary(device))}
            </ul>
            <h3 className="text-sm font-semibold text-gray-800 mt-6">Other devices</h3>
            {otherDeviceRows.length === 0 && (
              <p className="mt-2 text-sm text-gray-500">No other phones, tablets, or browsers are registered on this account.</p>
            )}
            <ul className="mt-2 divide-y divide-gray-100">
              {otherDeviceRows.map((device) => renderDeviceSummary(device))}
            </ul>
          </>
        )}
      </section>

      {canAdmin && (
        <section className="bg-white rounded-lg shadow-sm p-6">
          <h2 className="text-xl font-semibold text-gray-900">Company policy</h2>
          <p className="text-sm text-gray-600 mt-1">
            Administrators decide which types exist for this tenant. Required security types cannot be switched off.
            Lock-screen detail is off by default and never includes amounts.
          </p>
          {policyGrouped.length > 0 && (
            <div className="mt-3 space-y-4">
              <label className="block text-sm font-medium text-gray-800">
                Category
                <select
                  className="mt-1 block w-full border border-gray-300 rounded-lg px-3 py-2 bg-white text-sm min-h-[var(--layout-touch-target)]"
                  aria-label="Company policy category"
                  value={selectedPolicyArea || policyGrouped[0].area}
                  onChange={(e) => setSelectedPolicyArea(e.target.value)}
                >
                  {policyGrouped.map((group) => (
                    <option key={group.area} value={group.area}>{group.label}</option>
                  ))}
                </select>
              </label>
              {selectedPolicyGroup && (
                  <div>
                    <h3 className="text-sm font-semibold text-gray-800">{selectedPolicyGroup.label}</h3>
                    <ul className="mt-2 divide-y divide-gray-100">
                      {selectedPolicyGroup.items.map((item) => (
                        <li key={item.typeKey} className="py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                          <div>
                            <p className="text-sm font-medium">{item.label}</p>
                            <p className="text-xs text-gray-500">{item.categoryLabel}</p>
                          </div>
                          <div className="flex items-center gap-4 text-sm">
                            <label className="flex items-center gap-2">
                              <input
                                type="checkbox"
                                checked={item.isAllowed}
                                disabled={item.preferenceMode === 'MANDATORY'}
                                onChange={(e) => {
                                  const next = policyRows.map((row) =>
                                    row.typeKey === item.typeKey ? { ...row, isAllowed: e.target.checked } : row,
                                  );
                                  queryClient.setQueryData(['notifications', 'admin-policy'], next);
                                }}
                              />
                              Available
                            </label>
                            <label className="flex items-center gap-2">
                              <input
                                type="checkbox"
                                checked={item.lockScreenDetail}
                                onChange={(e) => {
                                  const next = policyRows.map((row) =>
                                    row.typeKey === item.typeKey ? { ...row, lockScreenDetail: e.target.checked } : row,
                                  );
                                  queryClient.setQueryData(['notifications', 'admin-policy'], next);
                                }}
                              />
                              Lock-screen detail
                            </label>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
              )}
            </div>
          )}
          <button
            type="button"
            className="mt-4 px-4 py-2 bg-blue-600 text-white rounded-lg min-h-[var(--layout-touch-target)]"
            onClick={() => savePolicy.mutate(policyRows)}
          >
            Save company policy
          </button>
        </section>
      )}
    </div>
  );
}
