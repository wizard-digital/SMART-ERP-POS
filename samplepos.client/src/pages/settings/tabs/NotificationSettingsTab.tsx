import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { apiClient } from '../../../utils/api';
import { detectPushCapability } from '../../../lib/pushCapability';
import { getOrCreateInstallationId, subscribeThisBrowser, platformHintFromCapabilities, rememberSubscriptionId } from '../../../lib/pushSubscription';
import { useAdaptiveLayoutOptional } from '../../../components/adaptive';

type CatalogType = {
  typeKey: string;
  category: string;
  categoryLabel: string;
  label: string;
  description: string;
  severity: string;
  highVolume?: boolean;
  preferenceMode?: string;
  preferenceModeLabel?: string;
  whyYouReceive?: string;
  inAppEnabled: boolean;
  pushEnabled: boolean;
  inAppLocked?: boolean;
};

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

  const grouped = useMemo(() => {
    const map = new Map<string, CatalogType[]>();
    for (const item of prefRows) {
      const list = map.get(item.categoryLabel) || [];
      list.push(item);
      map.set(item.categoryLabel, list);
    }
    return [...map.entries()];
  }, [prefRows]);

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
    if (device.platformHint === 'android') return 'Android';
    if (device.platformHint === 'desktop') return 'Windows / desktop';
    return device.displayName || device.platformHint;
  }

  function deviceMutes(device: Device): DeviceOverride[] {
    const rows = device.typeOverrides || device.typePreferences || [];
    return rows.filter((row) => row.pushEnabled === false);
  }

  async function patchDevice(deviceId: string, body: Record<string, unknown>) {
    await apiClient.patch(`/notifications/devices/${deviceId}`, body);
    await queryClient.invalidateQueries({ queryKey: ['notifications', 'devices'] });
  }

  const thisDeviceRows = deviceRows.filter((device) => device.clientInstallationId === thisInstallationId);
  const otherDeviceRows = deviceRows.filter((device) => device.clientInstallationId !== thisInstallationId);

  function renderDeviceCard(device: Device) {
    const mutes = deviceMutes(device);
    const muteCandidates = prefRows.filter(
      (item) => item.pushEnabled && !mutes.some((row) => row.typeKey === item.typeKey),
    );
    return (
      <li key={device.id} className="py-4 text-sm">
        <p className="font-medium text-gray-900">
          {deviceTitle(device)}{device.revoked ? ' (removed)' : ''}
        </p>
        <p className="text-xs text-gray-500">
          {device.pushEnabled ? 'Lock-screen push on' : 'Lock-screen push off'}
          {' · last active '}
          {new Date(device.lastSeenAt).toLocaleString()}
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
                  .then(() => queryClient.invalidateQueries({ queryKey: ['notifications', 'devices'] }))
              }
            >
              Remove
            </button>
          </div>
        )}
        {!device.revoked && (
          <div className="mt-3 rounded-md border border-gray-100 bg-gray-50 p-3">
            <p className="text-xs font-semibold text-gray-800">Exceptions on this device</p>
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
      </li>
    );
  }

  return (
    <div className="space-y-6">
      <section className="bg-white rounded-lg shadow-sm p-6">
        <h2 className="text-xl font-semibold text-gray-900">How delivery works</h2>
        <ol className="mt-3 space-y-2 text-sm text-gray-700 list-decimal list-inside">
          <li>
            <span className="font-medium">Company policy</span>
            {' — '}
            administrators decide which types exist for this tenant. Required security types cannot be switched off.
          </li>
          <li>
            <span className="font-medium">Your notification types</span>
            {' — '}
            In SMART-ERP-POS is the inbox. Lock screen is OS push on devices you register.
          </li>
          <li>
            <span className="font-medium">Each device</span>
            {' — '}
            a master push switch. Turning a phone off does not change your types or other devices.
          </li>
          <li>
            <span className="font-medium">Device exceptions</span>
            {' — '}
            mute a type on one device only. Empty exceptions means this device follows your types.
          </li>
        </ol>
      </section>

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
        <h2 className="text-xl font-semibold text-gray-900">Your notification types</h2>
        <p className="text-sm text-gray-600 mt-1">
          In SMART-ERP-POS is the bell inbox. Lock screen is OS push. High-volume types stay off until you enable them. Required security types cannot be silenced in-app.
        </p>
        {prefsQuery.isError && (
          <p className="mt-3 text-sm text-red-700">Could not load notification types. The API may be unavailable.</p>
        )}
        <div className={`mt-4 ${layout?.tier === 'mobile' ? 'space-y-6' : 'space-y-8'}`}>
          {grouped.map(([category, items]) => (
            <div key={category}>
              <h3 className="text-sm font-semibold text-gray-800 mb-2">{category}</h3>
              <ul className="divide-y divide-gray-100">
                {items.map((item) => (
                  <li key={item.typeKey} className="py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                    <div>
                      <p className="text-sm font-medium text-gray-900">
                        {item.label}
                        {item.preferenceModeLabel ? (
                          <span className="ml-2 text-[11px] font-normal text-gray-500">{item.preferenceModeLabel}</span>
                        ) : null}
                        {item.highVolume ? (
                          <span className="ml-2 text-[11px] font-normal text-amber-800">Off by default</span>
                        ) : null}
                      </p>
                      <p className="text-xs text-gray-500">{item.description}</p>
                      {item.whyYouReceive ? (
                        <p className="text-xs text-gray-500 mt-1">{item.whyYouReceive}</p>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-4 text-sm">
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={item.inAppEnabled}
                          disabled={item.inAppLocked}
                          onChange={(e) => {
                            const next = prefRows.map((row) =>
                              row.typeKey === item.typeKey ? { ...row, inAppEnabled: e.target.checked } : row,
                            );
                            queryClient.setQueryData(['notifications', 'preferences'], next);
                          }}
                        />
                        In SMART-ERP-POS{item.inAppLocked ? ' (required)' : ''}
                      </label>
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={item.pushEnabled}
                          onChange={(e) => {
                            const next = prefRows.map((row) =>
                              row.typeKey === item.typeKey ? { ...row, pushEnabled: e.target.checked } : row,
                            );
                            queryClient.setQueryData(['notifications', 'preferences'], next);
                          }}
                        />
                        Lock screen
                      </label>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <button
          type="button"
          className="mt-4 px-4 py-2 bg-blue-600 text-white rounded-lg min-h-[var(--layout-touch-target)]"
          onClick={() => savePrefs.mutate(prefRows)}
        >
          Save preferences
        </button>
      </section>

      <section className="bg-white rounded-lg shadow-sm p-6">
        <h2 className="text-xl font-semibold text-gray-900">Devices</h2>
        <p className="text-sm text-gray-600 mt-1">
          Each phone, tablet, or browser is independent. A device with no exceptions follows your notification types. Muting a type here does not change other devices or your type list.
        </p>
        <h3 className="text-sm font-semibold text-gray-800 mt-4">This device</h3>
        {thisDeviceRows.length === 0 && (
          <p className="mt-2 text-sm text-gray-500">Not registered yet. Enable notifications on this browser first.</p>
        )}
        <ul className="mt-2 divide-y divide-gray-100">
          {thisDeviceRows.map((device) => renderDeviceCard(device))}
        </ul>
        <h3 className="text-sm font-semibold text-gray-800 mt-6">Other devices</h3>
        {otherDeviceRows.length === 0 && (
          <p className="mt-2 text-sm text-gray-500">No other phones, tablets, or browsers are registered on this account.</p>
        )}
        <ul className="mt-2 divide-y divide-gray-100">
          {otherDeviceRows.map((device) => renderDeviceCard(device))}
        </ul>
      </section>

      {canAdmin && (
        <section className="bg-white rounded-lg shadow-sm p-6">
          <h2 className="text-xl font-semibold text-gray-900">Company policy</h2>
          <p className="text-sm text-gray-600 mt-1">
            Layer 1 of delivery. Available types can be chosen by users. Required security types stay on. Lock-screen detail is off by default and never includes amounts.
          </p>
          <ul className="mt-3 divide-y divide-gray-100">
            {policyRows.map((item) => (
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
