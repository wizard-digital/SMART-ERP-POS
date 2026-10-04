import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Target } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../../utils/api';
import { useCanAccess } from '../../authorization/useAuthorization';
import { AdaptivePage, AdaptiveToolbar } from '../../components/adaptive';
import { ReportBackLink } from '../../components/reports/ReportBackLink';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
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
};

type UserOption = { id: string; fullName?: string; full_name?: string; email?: string };
type TeamOption = { id: string; name: string; memberIds: string[]; isActive: boolean };

function periodBounds(periodType: string, anchor: string): { start: string; end: string } {
  const d = new Date(`${anchor}T00:00:00`);
  if (Number.isNaN(d.getTime())) {
    return { start: anchor, end: anchor };
  }
  const y = d.getFullYear();
  const m = d.getMonth();
  const pad = (x: number) => String(x).padStart(2, '0');
  const iso = (dt: Date) =>
    `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;

  if (periodType === 'WEEKLY') {
    const day = d.getDay();
    const mondayOffset = day === 0 ? -6 : 1 - day;
    const start = new Date(d);
    start.setDate(d.getDate() + mondayOffset);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    return { start: iso(start), end: iso(end) };
  }
  if (periodType === 'MONTHLY') {
    const start = new Date(y, m, 1);
    const end = new Date(y, m + 1, 0);
    return { start: iso(start), end: iso(end) };
  }
  if (periodType === 'QUARTERLY') {
    const q = Math.floor(m / 3);
    const start = new Date(y, q * 3, 1);
    const end = new Date(y, q * 3 + 3, 0);
    return { start: iso(start), end: iso(end) };
  }
  if (periodType === 'YEARLY') {
    return { start: `${y}-01-01`, end: `${y}-12-31` };
  }
  return { start: anchor, end: anchor };
}

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

function subjectLabel(row: TargetRow): string {
  if (row.scope === 'GENERAL') return 'General (all cashiers)';
  if (row.scope === 'TEAM') return row.teamName || 'Team';
  return row.salespersonName || row.salespersonId || '—';
}

export default function SalesTargetsPage() {
  const navigate = useNavigate();
  const canManage = useCanAccess([], ['targets.manage']);
  const [rows, setRows] = useState<TargetRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [users, setUsers] = useState<UserOption[]>([]);
  const [teams, setTeams] = useState<TeamOption[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [showTeamForm, setShowTeamForm] = useState(false);
  const [form, setForm] = useState({
    scope: 'INDIVIDUAL',
    salespersonId: '',
    teamId: '',
    periodType: 'MONTHLY',
    periodStart: new Date().toISOString().slice(0, 10),
    periodEnd: new Date().toISOString().slice(0, 10),
    targetAmount: '',
    notes: '',
  });
  const [teamForm, setTeamForm] = useState({ name: '', memberIds: [] as string[] });
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.salesTargets.list({
        status: statusFilter || undefined,
        limit: 100,
      });
      setRows((res.data?.data as TargetRow[]) || []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load targets');
    } finally {
      setLoading(false);
    }
  };

  const loadTeams = async () => {
    try {
      const res = await api.salesTargets.listTeams();
      setTeams((res.data?.data as TeamOption[]) || []);
    } catch {
      /* optional */
    }
  };

  useEffect(() => {
    void load();
  }, [statusFilter]);

  useEffect(() => {
    if (!canManage) return;
    void api
      .get('/users', { params: { limit: 200 } })
      .then((res) => {
        const data = res.data?.data;
        const list = Array.isArray(data) ? data : data?.users || data?.items || [];
        setUsers(list as UserOption[]);
      })
      .catch(() => undefined);
    void loadTeams();
  }, [canManage]);

  useEffect(() => {
    if (form.periodType === 'CUSTOM') return;
    const bounds = periodBounds(form.periodType, form.periodStart);
    setForm((prev) =>
      prev.periodStart === bounds.start && prev.periodEnd === bounds.end
        ? prev
        : { ...prev, periodStart: bounds.start, periodEnd: bounds.end },
    );
  }, [form.periodType, form.periodStart]);

  const activeCount = useMemo(() => rows.filter((r) => r.status === 'ACTIVE').length, [rows]);
  const pendingCount = useMemo(
    () => rows.filter((r) => r.status === 'PENDING_APPROVAL').length,
    [rows],
  );

  const save = async (submit: boolean) => {
    const amount = Number(form.targetAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error('A positive target amount is required');
      return;
    }
    if (form.scope === 'INDIVIDUAL' && !form.salespersonId) {
      toast.error('Select a salesperson');
      return;
    }
    if (form.scope === 'TEAM' && !form.teamId) {
      toast.error('Select a team');
      return;
    }
    setSaving(true);
    try {
      await api.salesTargets.create({
        scope: form.scope,
        salespersonId: form.scope === 'INDIVIDUAL' ? form.salespersonId : null,
        teamId: form.scope === 'TEAM' ? form.teamId : null,
        periodType: form.periodType,
        periodStart: form.periodStart,
        periodEnd: form.periodEnd,
        targetAmount: amount,
        notes: form.notes || null,
        submit,
      });
      toast.success(submit ? 'Target submitted for approval' : 'Draft target saved');
      setShowForm(false);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save target');
    } finally {
      setSaving(false);
    }
  };

  const saveTeam = async () => {
    if (!teamForm.name.trim() || teamForm.memberIds.length === 0) {
      toast.error('Team name and at least one member are required');
      return;
    }
    setSaving(true);
    try {
      await api.salesTargets.createTeam({
        name: teamForm.name.trim(),
        memberIds: teamForm.memberIds,
      });
      toast.success('Team created');
      setShowTeamForm(false);
      setTeamForm({ name: '', memberIds: [] });
      await loadTeams();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to create team');
    } finally {
      setSaving(false);
    }
  };

  const toggleMember = (id: string) => {
    setTeamForm((f) => ({
      ...f,
      memberIds: f.memberIds.includes(id)
        ? f.memberIds.filter((x) => x !== id)
        : [...f.memberIds, id],
    }));
  };

  return (
    <AdaptivePage
      className="p-4 lg:p-6"
      backLink={<ReportBackLink to="/sales" label="Back to Sales" />}
      title="Sales Targets"
      description="Individual, General (all cashiers), or named Team targets. Achievement from posted sales (excl. VAT)."
      forceDescription
      primaryActions={
        canManage ? (
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setShowTeamForm((v) => !v)}
              className="min-h-[var(--layout-touch-target)]"
              data-sales-targets-new-team="true"
            >
              {showTeamForm ? 'Hide team' : 'New team'}
            </Button>
            <Button
              type="button"
              onClick={() => setShowForm((v) => !v)}
              className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 min-h-[var(--layout-touch-target)]"
              data-sales-targets-new="true"
            >
              <Plus className="h-4 w-4" />
              {showForm ? 'Hide form' : 'New target'}
            </Button>
          </div>
        ) : null
      }
      toolbar={
        <div
          className="bg-white rounded-lg border border-gray-200 p-3 sm:p-4"
          data-sales-targets-filters="true"
        >
          <AdaptiveToolbar
            leading={
              <div className="flex items-center gap-2 text-sm text-gray-600">
                <Target className="h-4 w-4 text-emerald-600 shrink-0" aria-hidden />
                <span>Filter by status</span>
              </div>
            }
            secondaryLabel="Status"
            secondary={
              <label className="block text-sm space-y-1 min-w-[12rem]">
                <span className="text-gray-600">Status</span>
                <select
                  className="w-full border rounded-lg px-3 py-2 min-h-[var(--layout-touch-target)]"
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  data-sales-targets-status-filter="true"
                >
                  <option value="">All</option>
                  <option value="DRAFT">Draft</option>
                  <option value="PENDING_APPROVAL">Pending approval</option>
                  <option value="ACTIVE">Active</option>
                  <option value="CLOSED">Closed</option>
                  <option value="CANCELLED">Cancelled</option>
                </select>
              </label>
            }
          />
        </div>
      }
    >
      <div className={DASHBOARD_KPI_GRID_CLASS} data-sales-targets-kpis="true">
        <div className={DASHBOARD_KPI_CARD_CLASS}>
          <div className={DASHBOARD_KPI_LABEL_CLASS}>Targets</div>
          <div className={DASHBOARD_KPI_VALUE_CLASS}>{rows.length}</div>
        </div>
        <div className={DASHBOARD_KPI_CARD_CLASS}>
          <div className={DASHBOARD_KPI_LABEL_CLASS}>Active</div>
          <div className={`${DASHBOARD_KPI_VALUE_CLASS} text-emerald-700`}>{activeCount}</div>
        </div>
        <div className={DASHBOARD_KPI_CARD_CLASS}>
          <div className={DASHBOARD_KPI_LABEL_CLASS}>Pending approval</div>
          <div className={`${DASHBOARD_KPI_VALUE_CLASS} text-amber-700`}>{pendingCount}</div>
        </div>
      </div>

      {showTeamForm && canManage && (
        <div
          className="mt-4 bg-white rounded-xl border border-gray-200 p-3 sm:p-4 space-y-3"
          data-sales-targets-team-form="true"
        >
          <h2 className="font-medium text-gray-900">Create named team</h2>
          <label className="text-sm space-y-1 block">
            <span className="text-gray-600">Team name</span>
            <input
              className="w-full border rounded-lg px-3 py-2 min-h-[var(--layout-touch-target)]"
              value={teamForm.name}
              onChange={(e) => setTeamForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="e.g. Cashiers"
            />
          </label>
          <div className="text-sm text-gray-600">Members</div>
          <div className="max-h-48 overflow-y-auto border rounded-lg p-2 space-y-1">
            {users.map((u) => (
              <label key={u.id} className="flex items-center gap-2 text-sm py-1">
                <input
                  type="checkbox"
                  checked={teamForm.memberIds.includes(u.id)}
                  onChange={() => toggleMember(u.id)}
                />
                <span>{u.fullName || u.full_name || u.email || u.id}</span>
              </label>
            ))}
          </div>
          <Button
            type="button"
            disabled={saving}
            onClick={() => void saveTeam()}
            className="bg-emerald-600 hover:bg-emerald-700 min-h-[var(--layout-touch-target)]"
          >
            Save team
          </Button>
        </div>
      )}

      {showForm && canManage && (
        <div
          className="mt-4 bg-white rounded-xl border border-gray-200 p-3 sm:p-4 space-y-3"
          data-sales-targets-create-form="true"
        >
          <h2 className="font-medium text-gray-900">Create target</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="text-sm space-y-1">
              <span className="text-gray-600">Scope</span>
              <select
                className="w-full border rounded-lg px-3 py-2 min-h-[var(--layout-touch-target)]"
                value={form.scope}
                onChange={(e) => setForm((f) => ({ ...f, scope: e.target.value }))}
                data-sales-targets-scope="true"
              >
                <option value="INDIVIDUAL">Individual</option>
                <option value="GENERAL">General (all cashiers)</option>
                <option value="TEAM">Named team</option>
              </select>
            </label>
            {form.scope === 'INDIVIDUAL' && (
              <label className="text-sm space-y-1">
                <span className="text-gray-600">Salesperson</span>
                <select
                  className="w-full border rounded-lg px-3 py-2 min-h-[var(--layout-touch-target)]"
                  value={form.salespersonId}
                  onChange={(e) => setForm((f) => ({ ...f, salespersonId: e.target.value }))}
                  data-sales-targets-salesperson="true"
                >
                  <option value="">Select…</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.fullName || u.full_name || u.email || u.id}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {form.scope === 'TEAM' && (
              <label className="text-sm space-y-1">
                <span className="text-gray-600">Team</span>
                <select
                  className="w-full border rounded-lg px-3 py-2 min-h-[var(--layout-touch-target)]"
                  value={form.teamId}
                  onChange={(e) => setForm((f) => ({ ...f, teamId: e.target.value }))}
                  data-sales-targets-team="true"
                >
                  <option value="">Select…</option>
                  {teams
                    .filter((t) => t.isActive)
                    .map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name} ({t.memberIds.length})
                      </option>
                    ))}
                </select>
              </label>
            )}
            <label className="text-sm space-y-1">
              <span className="text-gray-600">Period</span>
              <select
                className="w-full border rounded-lg px-3 py-2 min-h-[var(--layout-touch-target)]"
                value={form.periodType}
                onChange={(e) => setForm((f) => ({ ...f, periodType: e.target.value }))}
                data-sales-targets-period-type="true"
              >
                <option value="WEEKLY">Weekly</option>
                <option value="MONTHLY">Monthly</option>
                <option value="QUARTERLY">Quarterly</option>
                <option value="YEARLY">Yearly</option>
                <option value="CUSTOM">Custom</option>
              </select>
            </label>
            <label className="text-sm space-y-1">
              <span className="text-gray-600">Start date</span>
              <input
                type="date"
                className="w-full border rounded-lg px-3 py-2 min-h-[var(--layout-touch-target)]"
                value={form.periodStart}
                onChange={(e) => setForm((f) => ({ ...f, periodStart: e.target.value }))}
              />
            </label>
            <label className="text-sm space-y-1">
              <span className="text-gray-600">End date</span>
              <input
                type="date"
                className="w-full border rounded-lg px-3 py-2 min-h-[var(--layout-touch-target)]"
                value={form.periodEnd}
                onChange={(e) => setForm((f) => ({ ...f, periodEnd: e.target.value }))}
                disabled={form.periodType !== 'CUSTOM'}
              />
            </label>
            <label className="text-sm space-y-1 sm:col-span-2">
              <span className="text-gray-600">Target amount</span>
              <input
                type="number"
                min="0.01"
                step="0.01"
                className="w-full border rounded-lg px-3 py-2 min-h-[var(--layout-touch-target)]"
                value={form.targetAmount}
                onChange={(e) => setForm((f) => ({ ...f, targetAmount: e.target.value }))}
                data-sales-targets-amount="true"
              />
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={() => void save(false)}
              className="min-h-[var(--layout-touch-target)]"
              data-sales-targets-save-draft="true"
            >
              Save draft
            </Button>
            <Button
              type="button"
              disabled={saving}
              onClick={() => void save(true)}
              className="bg-emerald-600 hover:bg-emerald-700 min-h-[var(--layout-touch-target)]"
              data-sales-targets-submit="true"
            >
              Submit for approval
            </Button>
          </div>
        </div>
      )}

      <div className="mt-4 bg-white rounded-xl border border-gray-200 overflow-x-auto" data-sales-targets-table="true">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-left text-gray-600">
            <tr>
              <th className="px-3 py-2">Scope</th>
              <th className="px-3 py-2">Subject</th>
              <th className="px-3 py-2">Period</th>
              <th className="px-3 py-2">Target</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td className="px-3 py-4 text-gray-500" colSpan={6}>
                  Loading…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td className="px-3 py-4 text-gray-500" colSpan={6}>
                  No targets found.
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id} className="border-t border-gray-100">
                  <td className="px-3 py-2">{row.scope || 'INDIVIDUAL'}</td>
                  <td className="px-3 py-2">{subjectLabel(row)}</td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {row.periodStart} → {row.periodEnd}
                    <div className="text-xs text-gray-400">{row.periodType}</div>
                  </td>
                  <td className="px-3 py-2 tabular-nums">{formatCurrency(row.targetAmount)}</td>
                  <td className="px-3 py-2">
                    <Badge className={`${statusBadgeClass(row.status)} border-0`}>{row.status}</Badge>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Button
                      type="button"
                      variant="ghost"
                      className="text-emerald-700 min-h-[var(--layout-touch-target)]"
                      onClick={() => navigate(`/sales/targets/${row.id}`)}
                    >
                      Open
                    </Button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </AdaptivePage>
  );
}
