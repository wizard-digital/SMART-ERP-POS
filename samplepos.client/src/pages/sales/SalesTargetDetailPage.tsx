import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from '../../utils/api';
import { useCanAccess } from '../../authorization/useAuthorization';
import { AdaptivePage } from '../../components/adaptive';
import { ReportBackLink } from '../../components/reports/ReportBackLink';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/temp-ui-components';
import { formatCurrency } from '../../utils/currency';
import {
  DASHBOARD_KPI_CARD_CLASS,
  DASHBOARD_KPI_GRID_CLASS,
  DASHBOARD_KPI_LABEL_CLASS,
  DASHBOARD_KPI_VALUE_CLASS,
} from '../../lib/adaptiveDashboard';

type TargetRow = {
  id: string;
  scope?: string;
  salespersonId: string | null;
  salespersonName: string | null;
  teamId?: string | null;
  teamName?: string | null;
  periodType: string;
  periodStart: string;
  periodEnd: string;
  targetAmount: number;
  status: string;
  rowVersion: number;
  amendmentReason?: string | null;
  cancelReason?: string | null;
  approvedByName?: string | null;
  createdByName?: string | null;
};

type AchievementPayload = {
  achievement: {
    targetAmount: number;
    achievedAmount: number;
    remainingAmount: number;
    achievementPercent: number;
    eligibleSalesRevenue: number;
    eligibleSalesCount: number;
    refundsExclVat: number;
    refundCount: number;
    notes: string[];
  };
  sales: Array<{
    saleId: string;
    saleNumber: string;
    saleDate: string;
    status: string;
    revenueExclVat: number;
  }>;
  refunds: Array<{
    refundId: string;
    refundNumber: string;
    refundDate: string;
    saleNumber: string;
    refundExclVat: number;
  }>;
  glReconciliation?: {
    note?: string;
    orgGlNetSales?: { sales4000: number; returns4010: number; net: number } | null;
  };
};

function statusBadgeClass(status: string): string {
  const colors: Record<string, string> = {
    DRAFT: 'bg-gray-100 text-gray-800',
    PENDING_APPROVAL: 'bg-yellow-100 text-yellow-800',
    ACTIVE: 'bg-green-100 text-green-800',
    CLOSED: 'bg-blue-100 text-blue-800',
    CANCELLED: 'bg-gray-100 text-gray-800',
  };
  return colors[status] || 'bg-gray-100 text-gray-800';
}

export default function SalesTargetDetailPage() {
  const { id = '' } = useParams();
  const canManage = useCanAccess([], ['targets.manage']);
  const canApprove = useCanAccess([], ['targets.approve']);
  const [target, setTarget] = useState<TargetRow | null>(null);
  const [achievement, setAchievement] = useState<AchievementPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');

  const reload = async () => {
    setLoading(true);
    try {
      const [tRes, aRes] = await Promise.all([
        api.salesTargets.getById(id),
        api.salesTargets.achievement(id),
      ]);
      setTarget((tRes.data?.data as TargetRow) || null);
      setAchievement((aRes.data?.data as AchievementPayload) || null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load target');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (id) void reload();
  }, [id]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(ok);
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <AdaptivePage className="p-4 lg:p-6" title="Target vs Achievement">
        <p className="text-gray-600">Loading target…</p>
      </AdaptivePage>
    );
  }

  if (!target || !achievement) {
    return (
      <AdaptivePage
        className="p-4 lg:p-6"
        backLink={<ReportBackLink to="/sales/targets" label="Back to Sales Targets" />}
        title="Target not found"
      >
        <p className="text-gray-600">This sales target could not be loaded.</p>
      </AdaptivePage>
    );
  }

  const a = achievement.achievement;
  const pct = Math.min(Math.max(a.achievementPercent, 0), 100);

  return (
    <AdaptivePage
      className="p-4 lg:p-6"
      backLink={<ReportBackLink to="/sales/targets" label="Back to Sales Targets" />}
      title="Target vs Achievement"
      description={`${
        target.scope === 'GENERAL'
          ? 'General'
          : target.scope === 'TEAM'
            ? target.teamName || 'Team'
            : target.salespersonName || target.salespersonId || 'Individual'
      } · ${target.scope || 'INDIVIDUAL'} · ${target.periodStart} → ${target.periodEnd}`}
      forceDescription
      primaryActions={
        <div className="flex flex-wrap items-center justify-end gap-2" data-sales-targets-actions="true">
          <Badge className={`${statusBadgeClass(target.status)} border-0`}>{target.status}</Badge>
          {canManage && target.status === 'DRAFT' && (
            <Button
              type="button"
              disabled={busy}
              className="bg-emerald-600 hover:bg-emerald-700 min-h-[var(--layout-touch-target)]"
              data-sales-targets-submit-action="true"
              onClick={() =>
                void act(
                  () => api.salesTargets.submit(target.id, target.rowVersion),
                  'Submitted for approval',
                )
              }
            >
              Submit for approval
            </Button>
          )}
          {canApprove && target.status === 'PENDING_APPROVAL' && (
            <Button
              type="button"
              disabled={busy}
              className="bg-emerald-600 hover:bg-emerald-700 min-h-[var(--layout-touch-target)]"
              data-sales-targets-approve-action="true"
              onClick={() =>
                void act(
                  () => api.salesTargets.approve(target.id, target.rowVersion),
                  'Target approved',
                )
              }
            >
              Approve
            </Button>
          )}
          {(canManage || canApprove) && target.status === 'ACTIVE' && (
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              className="min-h-[var(--layout-touch-target)]"
              data-sales-targets-close-action="true"
              onClick={() =>
                void act(
                  () => api.salesTargets.close(target.id, target.rowVersion),
                  'Target closed',
                )
              }
            >
              Close
            </Button>
          )}
          {(canManage || canApprove) &&
            ['DRAFT', 'PENDING_APPROVAL', 'ACTIVE'].includes(target.status) && (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                className="border-red-200 text-red-700 min-h-[var(--layout-touch-target)]"
                data-sales-targets-cancel-action="true"
                onClick={() => {
                  setCancelReason('');
                  setCancelOpen(true);
                }}
              >
                Cancel
              </Button>
            )}
        </div>
      }
    >
      <div className={DASHBOARD_KPI_GRID_CLASS} data-sales-targets-detail-kpis="true">
        <div className={DASHBOARD_KPI_CARD_CLASS}>
          <div className={DASHBOARD_KPI_LABEL_CLASS}>Target</div>
          <div className={DASHBOARD_KPI_VALUE_CLASS}>{formatCurrency(a.targetAmount)}</div>
        </div>
        <div className={DASHBOARD_KPI_CARD_CLASS}>
          <div className={DASHBOARD_KPI_LABEL_CLASS}>Achieved (excl. VAT)</div>
          <div className={`${DASHBOARD_KPI_VALUE_CLASS} text-emerald-700`}>
            {formatCurrency(a.achievedAmount)}
          </div>
        </div>
        <div className={DASHBOARD_KPI_CARD_CLASS}>
          <div className={DASHBOARD_KPI_LABEL_CLASS}>Remaining</div>
          <div className={DASHBOARD_KPI_VALUE_CLASS}>{formatCurrency(a.remainingAmount)}</div>
        </div>
        <div className={DASHBOARD_KPI_CARD_CLASS}>
          <div className={DASHBOARD_KPI_LABEL_CLASS}>Achievement</div>
          <div className={DASHBOARD_KPI_VALUE_CLASS}>{a.achievementPercent.toFixed(1)}%</div>
        </div>
      </div>

      <div className="mt-4 bg-white rounded-xl border border-gray-200 p-3 sm:p-4">
        <div className="h-3 rounded-full bg-gray-100 overflow-hidden" data-sales-targets-progress="true">
          <div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} />
        </div>
        <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
          <div>
            <div className="text-gray-500">Eligible sales</div>
            <div className="font-medium tabular-nums">
              {formatCurrency(a.eligibleSalesRevenue)} ({a.eligibleSalesCount})
            </div>
          </div>
          <div>
            <div className="text-gray-500">Returns (excl. VAT)</div>
            <div className="font-medium tabular-nums">
              {formatCurrency(a.refundsExclVat)} ({a.refundCount})
            </div>
          </div>
          <div>
            <div className="text-gray-500">Created by</div>
            <div className="font-medium">{target.createdByName || '—'}</div>
          </div>
          <div>
            <div className="text-gray-500">Approved by</div>
            <div className="font-medium">{target.approvedByName || '—'}</div>
          </div>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-white rounded-xl border border-gray-200 overflow-x-auto" data-sales-targets-sales-table="true">
          <div className="px-3 py-2 font-medium border-b">Eligible sales</div>
          <table className="min-w-full text-sm">
            <thead className="text-left text-gray-500">
              <tr>
                <th className="px-3 py-2">Sale</th>
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2">Revenue</th>
              </tr>
            </thead>
            <tbody>
              {achievement.sales.length === 0 ? (
                <tr>
                  <td className="px-3 py-3 text-gray-500" colSpan={3}>
                    No eligible sales in period.
                  </td>
                </tr>
              ) : (
                achievement.sales.map((s) => (
                  <tr key={s.saleId} className="border-t">
                    <td className="px-3 py-2">
                      {s.saleNumber}
                      <div className="text-xs text-gray-400">{s.status}</div>
                    </td>
                    <td className="px-3 py-2">{s.saleDate}</td>
                    <td className="px-3 py-2 tabular-nums">{formatCurrency(s.revenueExclVat)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 overflow-x-auto" data-sales-targets-refunds-table="true">
          <div className="px-3 py-2 font-medium border-b">Returns</div>
          <table className="min-w-full text-sm">
            <thead className="text-left text-gray-500">
              <tr>
                <th className="px-3 py-2">Refund</th>
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2">Excl. VAT</th>
              </tr>
            </thead>
            <tbody>
              {achievement.refunds.length === 0 ? (
                <tr>
                  <td className="px-3 py-3 text-gray-500" colSpan={3}>
                    No POS returns in period.
                  </td>
                </tr>
              ) : (
                achievement.refunds.map((r) => (
                  <tr key={r.refundId} className="border-t">
                    <td className="px-3 py-2">
                      {r.refundNumber}
                      <div className="text-xs text-gray-400">{r.saleNumber}</div>
                    </td>
                    <td className="px-3 py-2">{r.refundDate}</td>
                    <td className="px-3 py-2 tabular-nums">{formatCurrency(r.refundExclVat)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {achievement.glReconciliation?.orgGlNetSales && (
        <div className="mt-4 bg-white rounded-xl border border-gray-200 p-3 sm:p-4 text-sm text-gray-600 space-y-1">
          <div className="font-medium text-gray-800">GL sense-check (org-wide, not by salesperson)</div>
          <p>{achievement.glReconciliation.note}</p>
          <p>
            4000: {formatCurrency(achievement.glReconciliation.orgGlNetSales.sales4000)} · 4010:{' '}
            {formatCurrency(achievement.glReconciliation.orgGlNetSales.returns4010)} · Net:{' '}
            {formatCurrency(achievement.glReconciliation.orgGlNetSales.net)}
          </p>
        </div>
      )}

      <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <DialogContent data-sales-targets-cancel-dialog="true">
          <DialogHeader>
            <DialogTitle>Cancel sales target</DialogTitle>
            <DialogDescription>
              Cancelling preserves the audit history. Provide a reason (minimum 3 characters).
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="sales-target-cancel-reason">Reason</Label>
            <Textarea
              id="sales-target-cancel-reason"
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              rows={3}
              data-sales-targets-cancel-reason="true"
            />
          </div>
          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              className="min-h-[var(--layout-touch-target)]"
              onClick={() => setCancelOpen(false)}
            >
              Keep target
            </Button>
            <Button
              type="button"
              disabled={busy || cancelReason.trim().length < 3}
              className="bg-red-600 hover:bg-red-700 min-h-[var(--layout-touch-target)]"
              data-sales-targets-cancel-confirm="true"
              onClick={() => {
                void act(async () => {
                  await api.salesTargets.cancel(target.id, cancelReason.trim(), target.rowVersion);
                  setCancelOpen(false);
                }, 'Target cancelled');
              }}
            >
              Confirm cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdaptivePage>
  );
}
