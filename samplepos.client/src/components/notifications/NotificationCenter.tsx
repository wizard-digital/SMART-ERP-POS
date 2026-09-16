import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../../utils/api';
import { useAdaptiveLayoutOptional } from '../adaptive';
import { resolveAuthorizedNotificationPath, inboxMatchesFilter, type InboxOperatorFilter } from '../../lib/notificationNavigation';
import {
  notificationCenterMaxHeightCss,
  notificationCenterWidthClass,
  resolveNotificationCenterPresentation,
} from '../../lib/notificationCenterLayout';

type InboxItem = {
  id: string;
  typeKey: string;
  severity: string;
  title: string;
  body: string;
  navigationPath: string | null;
  isRead: boolean;
  createdAt: string;
  actorDisplay?: string | null;
  documentRef?: string | null;
  locationLabel?: string | null;
  groupingKey?: string | null;
  priority?: string;
  categoryLabel?: string | null;
  operatorBand?: string | null;
  operatorBandLabel?: string | null;
};

type InboxResponse = {
  success: boolean;
  data: { rows: InboxItem[]; total: number; unreadCount: number };
};

type DisplayRow =
  | { kind: 'single'; item: InboxItem }
  | { kind: 'group'; items: InboxItem[] };

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const delta = Math.max(0, Date.now() - then);
  const minutes = Math.floor(delta / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleString();
}

function groupInbox(rows: InboxItem[]): DisplayRow[] {
  const out: DisplayRow[] = [];
  let i = 0;
  while (i < rows.length) {
    const current = rows[i];
    const key = current.groupingKey;
    if (!key) {
      out.push({ kind: 'single', item: current });
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < rows.length && rows[j].groupingKey === key) j += 1;
    const slice = rows.slice(i, j);
    if (slice.length === 1) out.push({ kind: 'single', item: current });
    else out.push({ kind: 'group', items: slice });
    i = j;
  }
  return out;
}

export default function NotificationCenter() {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<InboxOperatorFilter>('attention');
  const rootRef = useRef<HTMLDivElement>(null);
  const layout = useAdaptiveLayoutOptional();
  const tier = layout?.tier ?? null;
  const presentation = resolveNotificationCenterPresentation(tier);
  const narrow = tier === 'mobile' || tier === 'compact';
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const unreadQuery = useQuery({
    queryKey: ['notifications', 'unread-count'],
    retry: false,
    queryFn: async () => {
      const res = await apiClient.get('/notifications/unread-count', { silentErrorToast: true });
      return Number(res.data?.data?.unreadCount || 0);
    },
    refetchInterval: 60000,
  });

  const listQuery = useQuery({
    queryKey: ['notifications', 'inbox'],
    enabled: open,
    retry: false,
    queryFn: async () => {
      const res = await apiClient.get<InboxResponse>('/notifications', {
        params: { limit: 40 },
        silentErrorToast: true,
      });
      return res.data?.data;
    },
  });

  const markRead = useMutation({
    mutationFn: async (id: string) => apiClient.post(`/notifications/${id}/read`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });

  const markAll = useMutation({
    mutationFn: async () => apiClient.post('/notifications/read-all'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });

  const unread = unreadQuery.data || 0;
  const filteredRows = useMemo(
    () => (listQuery.data?.rows || []).filter((row) => inboxMatchesFilter(row.operatorBand, filter)),
    [listQuery.data?.rows, filter],
  );
  const displayRows = useMemo(() => groupInbox(filteredRows), [filteredRows]);

  const close = useCallback(() => setOpen(false), []);

  const openItem = useCallback(
    (item: InboxItem) => {
      if (!item.isRead) markRead.mutate(item.id);
      close();
      const path = resolveAuthorizedNotificationPath(item.navigationPath);
      navigate(path);
    },
    [close, markRead, navigate],
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    const onPointer = (e: MouseEvent | TouchEvent) => {
      const root = rootRef.current;
      if (!root) return;
      const target = e.target;
      if (target instanceof Node && !root.contains(target)) close();
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('touchstart', onPointer);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('touchstart', onPointer);
    };
  }, [open, close]);

  const listMaxHeight = notificationCenterMaxHeightCss(tier);

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="relative p-2 rounded-lg hover:bg-gray-100 min-h-[var(--layout-touch-target)] min-w-[var(--layout-touch-target)] flex items-center justify-center"
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
        aria-expanded={open}
        data-testid="notification-center-toggle"
        data-notification-presentation={presentation}
      >
        <svg className="w-5 h-5 text-gray-700" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.4-1.4A2 2 0 0118 14.2V11a6 6 0 10-12 0v3.2a2 2 0 01-.6 1.4L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
        </svg>
        {unread > 0 && (
          <span className="absolute top-1 right-1 min-w-[1.1rem] h-4 px-1 rounded-full bg-red-600 text-white text-[10px] leading-4 text-center">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open ? (
        <div
          className={[
            'z-50 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg',
            // Narrow: dock under the shell bar with side inset — compact dropdown, not a sheet.
            narrow
              ? 'fixed left-2 right-2 top-[calc(3.5rem+env(safe-area-inset-top,0px))]'
              : `absolute right-0 mt-2 ${notificationCenterWidthClass(tier)}`,
          ].join(' ')}
          role="dialog"
          aria-label="Notification center"
          data-notification-center="dropdown"
          data-notification-narrow={narrow ? 'true' : 'false'}
        >
          <div className="flex items-center justify-between gap-3 px-3 py-2 border-b border-gray-100">
            <h2 className="text-sm font-semibold text-gray-900 min-w-0">Notifications</h2>
            <div className="flex items-center gap-3 shrink-0">
              <button
                type="button"
                className="text-xs text-blue-600 hover:underline min-h-[var(--layout-touch-target)] px-1"
                onClick={() => markAll.mutate()}
              >
                Mark all read
              </button>
              <Link
                to="/settings/notifications"
                className="text-xs text-gray-600 hover:underline min-h-[var(--layout-touch-target)] inline-flex items-center px-1"
                onClick={close}
              >
                Settings
              </Link>
            </div>
          </div>
          <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-gray-100">
            {([
              ['attention', 'Need attention'],
              ['waiting', 'Waiting'],
              ['cash', 'Cash'],
              ['all', 'All'],
            ] as const).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={`px-2 py-1 rounded-full text-[11px] min-h-[var(--layout-touch-target)] ${
                  filter === id ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-700'
                }`}
                onClick={() => setFilter(id)}
              >
                {label}
              </button>
            ))}
          </div>
          <div
            className="overflow-y-auto overscroll-contain"
            style={{ maxHeight: listMaxHeight }}
          >
            {displayRows.length === 0 && (
              <p className="p-4 text-sm text-gray-500">
                {(listQuery.data?.rows || []).length > 0
                  ? 'Nothing in this category. Try All.'
                  : 'No notifications yet.'}
              </p>
            )}
            {displayRows.map((row) => {
              if (row.kind === 'group') {
                const latest = row.items[0];
                const unreadGroup = row.items.some((item) => !item.isRead);
                return (
                  <button
                    key={latest.groupingKey || latest.id}
                    type="button"
                    onClick={() => openItem(latest)}
                    className={`w-full text-left px-3 py-3 border-b border-gray-50 hover:bg-gray-50 min-w-0 ${unreadGroup ? '' : 'opacity-70'}`}
                  >
                    <div className="flex items-start justify-between gap-2 min-w-0">
                      <span className="text-sm font-medium text-gray-900 break-words min-w-0">
                        {latest.title} · {row.items.length} events
                      </span>
                      {unreadGroup && <span className="w-2 h-2 mt-1.5 rounded-full bg-blue-600 flex-shrink-0" />}
                    </div>
                    {latest.operatorBandLabel || latest.categoryLabel ? (
                      <p className="text-[11px] text-gray-400 mt-0.5 break-words">
                        {[latest.operatorBandLabel, latest.categoryLabel].filter(Boolean).join(' · ')}
                      </p>
                    ) : null}
                    <p className="text-xs text-gray-600 mt-1 whitespace-pre-line break-words">
                      {latest.body}
                    </p>
                    <p className="text-[11px] text-gray-400 mt-1">{relativeTime(latest.createdAt)}</p>
                  </button>
                );
              }
              const item = row.item;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => openItem(item)}
                  className={`w-full text-left px-3 py-3 border-b border-gray-50 hover:bg-gray-50 min-w-0 ${item.isRead ? 'opacity-70' : ''}`}
                >
                  <div className="flex items-start justify-between gap-2 min-w-0">
                    <span className="text-sm font-medium text-gray-900 break-words min-w-0">{item.title}</span>
                    {!item.isRead && <span className="w-2 h-2 mt-1.5 rounded-full bg-blue-600 flex-shrink-0" />}
                  </div>
                  {item.operatorBandLabel || item.categoryLabel ? (
                    <p className="text-[11px] text-gray-400 mt-0.5 break-words">
                      {[item.operatorBandLabel, item.categoryLabel].filter(Boolean).join(' · ')}
                    </p>
                  ) : null}
                  <p className="text-xs text-gray-600 mt-1 whitespace-pre-line break-words">{item.body}</p>
                  <p className="text-[11px] text-gray-400 mt-1">{relativeTime(item.createdAt)}</p>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
