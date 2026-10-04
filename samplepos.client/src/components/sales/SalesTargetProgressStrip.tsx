/**
 * Embeddable sales-target progress — Target / Achieved / Remaining / %.
 * Fetches server SSOT via GET /sales-targets/progress (no client revenue math).
 * Reuses adaptive KPI_ACCENT + formatCurrency.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../utils/api';
import { formatCurrency } from '../../utils/currency';
import { useSalesTargetsEnabled } from '../../hooks/useSalesTargetsEnabled';
import { useCanAccess } from '../auth/ProtectedRoute';
import {
  KPI_ACCENT_GRID_CLASS,
  KPI_ACCENT_LABEL_CLASS,
  KPI_ACCENT_SUB_CLASS,
  KPI_ACCENT_VALUE_CLASS,
  kpiAccentCardClass,
} from '../../lib/adaptiveDashboard';

export type SalesTargetProgressItem = {
  targetId: string;
  targetScope?: string;
  salespersonId: string | null;
  salespersonName: string | null;
  teamId?: string | null;
  teamName?: string | null;
  periodType: string;
  periodStart: string;
  periodEnd: string;
  targetAmount: number;
  achievedAmount: number;
  remainingAmount: number;
  achievementPercent: number;
  status: string;
};

type ProgressPayload = {
  asOfDate?: string;
  scope?: 'self' | 'team' | 'general';
  items?: SalesTargetProgressItem[];
};

export function SalesTargetProgressStrip(props?: {
  /** Optional override when a manager views another salesperson */
  salespersonId?: string;
  className?: string;
}) {
  const { data: featureEnabled = false, isFetched: featureFetched } = useSalesTargetsEnabled();
  const canRead = useCanAccess([], ['targets.read', 'targets.manage', 'targets.approve']);
  const canManage = useCanAccess([], ['targets.manage', 'targets.approve']);
  const [items, setItems] = useState<SalesTargetProgressItem[]>([]);
  const [scope, setScope] = useState<'self' | 'team' | 'general'>('self');
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!featureFetched) return;
    if (!featureEnabled || !canRead) {
      setLoaded(true);
      setItems([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await api.salesTargets.progress({
          salespersonId: props?.salespersonId,
        });
        const payload = (res.data?.data ?? null) as ProgressPayload | null;
        if (!cancelled) {
          setItems(Array.isArray(payload?.items) ? payload!.items! : []);
          setScope(
            payload?.scope === 'general'
              ? 'general'
              : payload?.scope === 'team'
                ? 'team'
                : 'self',
          );
          setLoaded(true);
        }
      } catch {
        if (!cancelled) {
          setItems([]);
          setLoaded(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [canRead, featureEnabled, featureFetched, props?.salespersonId]);

  if (!featureFetched || !featureEnabled || !canRead || !loaded) return null;

  // Managers: show empty hint so Sales Analytics is not a dead surface
  if (items.length === 0) {
    if (!canManage) return null;
    return (
      <div
        className={props?.className ?? 'mb-3 sm:mb-4'}
        data-sales-target-progress-strip="true"
        data-sales-target-progress-empty="true"
      >
        <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 px-3 py-2.5 flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0 text-sm text-gray-600">
            No <span className="font-medium text-gray-800">ACTIVE</span> sales target covers
            today. Approve a target to see Target / Achieved / Remaining here.
          </div>
          <Link
            to="/sales/targets"
            className="text-xs font-medium text-emerald-700 hover:underline min-h-[var(--layout-touch-target)] inline-flex items-center shrink-0"
            data-sales-target-progress-manage="true"
          >
            Sales Targets
          </Link>
        </div>
      </div>
    );
  }

  const primary = items[0]!;
  const reached = Number(primary.remainingAmount) <= 0;
  const pct = Math.min(Math.max(Number(primary.achievementPercent) || 0, 0), 999);
  const periodLabel = `${primary.periodStart} → ${primary.periodEnd}`;
  const who =
    primary.targetScope === 'GENERAL' || scope === 'general'
      ? 'General'
      : primary.targetScope === 'TEAM' || scope === 'team'
        ? primary.teamName || 'Team'
        : primary.salespersonName;

  return (
    <div
      className={props?.className ?? 'mb-3 sm:mb-4'}
      data-sales-target-progress-strip="true"
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-gray-900">
            {reached ? 'Sales target reached' : 'Sales target progress'}
            {who ? ` · ${who}` : ''}
          </div>
          <div className="text-xs text-gray-500 truncate">
            {primary.periodType} · {periodLabel}
            {items.length > 1 ? ` · +${items.length - 1} more` : ''}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Link
            to={`/sales/targets/${primary.targetId}`}
            className="text-xs font-medium text-emerald-700 hover:underline min-h-[var(--layout-touch-target)] inline-flex items-center"
            data-sales-target-progress-detail="true"
          >
            Details
          </Link>
          {canManage ? (
            <Link
              to="/sales/targets"
              className="text-xs font-medium text-gray-600 hover:underline min-h-[var(--layout-touch-target)] inline-flex items-center"
              data-sales-target-progress-manage="true"
            >
              Manage
            </Link>
          ) : null}
        </div>
      </div>

      <div className={KPI_ACCENT_GRID_CLASS} data-sales-target-progress-kpis="true">
        <div className={kpiAccentCardClass('blue')}>
          <div className={KPI_ACCENT_LABEL_CLASS}>Target</div>
          <div className={KPI_ACCENT_VALUE_CLASS}>{formatCurrency(primary.targetAmount)}</div>
          <div className={KPI_ACCENT_SUB_CLASS}>Period goal (excl. VAT)</div>
        </div>
        <div className={kpiAccentCardClass('green')}>
          <div className={KPI_ACCENT_LABEL_CLASS}>Achieved</div>
          <div className={KPI_ACCENT_VALUE_CLASS}>{formatCurrency(primary.achievedAmount)}</div>
          <div className={KPI_ACCENT_SUB_CLASS}>Net sales − returns</div>
        </div>
        <div className={kpiAccentCardClass(reached ? 'green' : 'orange')}>
          <div className={KPI_ACCENT_LABEL_CLASS}>Remaining</div>
          <div className={KPI_ACCENT_VALUE_CLASS}>
            {formatCurrency(primary.remainingAmount)}
          </div>
          <div className={KPI_ACCENT_SUB_CLASS}>
            {reached ? 'Target reached' : 'Still to go'}
          </div>
        </div>
        <div className={kpiAccentCardClass('purple')}>
          <div className={KPI_ACCENT_LABEL_CLASS}>Progress</div>
          <div className={KPI_ACCENT_VALUE_CLASS}>{pct.toFixed(1)}%</div>
          <div className={KPI_ACCENT_SUB_CLASS}>
            <div className="mt-1 h-1.5 rounded-full bg-white/30 overflow-hidden">
              <div
                className="h-full bg-white/90"
                style={{ width: `${Math.min(pct, 100)}%` }}
                data-sales-target-progress-bar="true"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
