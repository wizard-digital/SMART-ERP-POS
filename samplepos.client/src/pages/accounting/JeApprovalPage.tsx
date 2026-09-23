import { useState } from 'react';
import { useJeApprovalRules, useCreateJeApprovalRule, usePendingApprovals, useApproveEntry, useRejectEntry } from '../../hooks/useAccountingModules';
import { formatTimestampDate } from '../../utils/businessDate';
import { ShieldCheck, Plus, X, CheckCircle, XCircle } from 'lucide-react';

interface ApprovalRule {
  id: string;
  name?: string;
  minAmount: number;
  maxAmount?: number;
  requiredRole: string;
  autoApprove?: boolean;
  description?: string;
  isActive: boolean;
}

interface PendingEntry {
  id: string;
  transactionId?: string;
  referenceNumber?: string;
  description?: string;
  totalAmount: number;
  requestedAt: string;
  requestedBy?: string;
  status: string;
  reviewedBy?: string;
  reviewedAt?: string;
  reviewNotes?: string;
}

export default function JeApprovalPage() {
  const [tab, setTab] = useState<'pending' | 'rules'>('pending');
  const [showForm, setShowForm] = useState(false);
  const [rejectId, setRejectId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const { data: rules } = useJeApprovalRules();
  const { data: pending, isLoading } = usePendingApprovals();
  const createRule = useCreateJeApprovalRule();
  const approve = useApproveEntry();
  const reject = useRejectEntry();

  const [form, setForm] = useState({ minAmount: 1000000, requiredRole: 'MANAGER', description: '' });

  const ruleList = (Array.isArray(rules) ? rules : []) as ApprovalRule[];
  const pendingList = (Array.isArray(pending) ? pending : []) as PendingEntry[];

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    await createRule.mutateAsync({
      minAmount: form.minAmount,
      requiredRole: form.requiredRole,
      description: form.description || undefined,
    });
    setForm({ minAmount: 1000000, requiredRole: 'MANAGER', description: '' });
    setShowForm(false);
  };

  const handleReject = async () => {
    if (!rejectId || !rejectReason.trim()) return;
    await reject.mutateAsync({ entryId: rejectId, reason: rejectReason });
    setRejectId(null);
    setRejectReason('');
  };

  const fmt = (val?: number) => typeof val === 'number' ? val.toLocaleString('en-US', { minimumFractionDigits: 0 }) : '—';

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Journal Entry Approval</h1>
          <p className="text-sm text-gray-500 mt-1">Approval workflows for journal entries above thresholds</p>
        </div>
        {tab === 'rules' && (
          <button
            onClick={() => setShowForm(true)}
            className="inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm"
          >
            <Plus className="h-4 w-4 mr-2" /> Add Rule
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="flex border-b">
        <button
          onClick={() => setTab('pending')}
          className={`px-4 py-2 text-sm font-medium border-b-2 ${tab === 'pending' ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
        >
          Pending Approvals ({pendingList.length})
        </button>
        <button
          onClick={() => setTab('rules')}
          className={`px-4 py-2 text-sm font-medium border-b-2 ${tab === 'rules' ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
        >
          Approval Rules ({ruleList.length})
        </button>
      </div>

      {/* Create Rule Form */}
      {showForm && tab === 'rules' && (
        <div className="bg-white border rounded-lg p-6 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">New Approval Rule</h2>
            <button onClick={() => setShowForm(false)} className="text-gray-400 hover:text-gray-600"><X className="h-5 w-5" /></button>
          </div>
          <form onSubmit={handleCreate} className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Minimum Amount</label>
              <input type="number" step="1" value={form.minAmount} onChange={(e) => setForm({ ...form, minAmount: parseFloat(e.target.value) })} required className="w-full px-3 py-2 border rounded-lg text-sm" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Required Role</label>
              <select value={form.requiredRole} onChange={(e) => setForm({ ...form, requiredRole: e.target.value })} className="w-full px-3 py-2 border rounded-lg text-sm">
                <option value="MANAGER">Manager</option>
                <option value="ADMIN">Admin</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
              <input type="text" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className="w-full px-3 py-2 border rounded-lg text-sm" placeholder="Optional" />
            </div>
            <div className="md:col-span-3 flex justify-end gap-2">
              <button type="button" onClick={() => setShowForm(false)} className="px-4 py-2 border rounded-lg text-sm hover:bg-gray-50">Cancel</button>
              <button type="submit" disabled={createRule.isPending} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50">Create</button>
            </div>
          </form>
        </div>
      )}

      {/* Reject Modal */}
      {rejectId && (
        <div className="bg-white border rounded-lg p-6 shadow-sm border-red-200">
          <h3 className="text-lg font-semibold text-red-700 mb-3">Reject Entry</h3>
          <textarea
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            rows={3}
            className="w-full px-3 py-2 border rounded-lg text-sm mb-3"
            placeholder="Reason for rejection (required)"
          />
          <div className="flex justify-end gap-2">
            <button onClick={() => { setRejectId(null); setRejectReason(''); }} className="px-4 py-2 border rounded-lg text-sm hover:bg-gray-50">Cancel</button>
            <button onClick={handleReject} disabled={!rejectReason.trim() || reject.isPending} className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm hover:bg-red-700 disabled:opacity-50">
              Confirm Reject
            </button>
          </div>
        </div>
      )}

      {/* Content */}
      {isLoading ? (
        <div className="text-center py-12 text-gray-500">Loading...</div>
      ) : tab === 'pending' ? (
        <div className="bg-white border rounded-lg shadow-sm overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Entry #</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Description</th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Amount</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Created By</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Date</th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {pendingList.length === 0 ? (
                <tr><td colSpan={6} className="px-6 py-8 text-center text-gray-500">
                  <ShieldCheck className="h-8 w-8 mx-auto mb-2 text-gray-300" />
                  No entries pending approval.
                </td></tr>
              ) : pendingList.map((entry) => (
                <tr key={entry.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4 text-sm font-medium">{entry.referenceNumber || entry.id.slice(0, 8)}</td>
                  <td className="px-6 py-4 text-sm text-gray-700">{entry.description || '—'}</td>
                  <td className="px-6 py-4 text-sm text-right font-medium">{fmt(entry.totalAmount)}</td>
                  <td className="px-6 py-4 text-sm text-gray-500">{entry.requestedBy || '—'}</td>
                  <td className="px-6 py-4 text-sm text-gray-500">{formatTimestampDate(entry.requestedAt)}</td>
                  <td className="px-6 py-4 text-right">
                    <div className="flex justify-end gap-2">
                      <button
                        onClick={() => approve.mutate({ entryId: entry.id })}
                        disabled={approve.isPending}
                        className="inline-flex items-center px-2 py-1 text-xs bg-green-50 text-green-700 border border-green-200 rounded hover:bg-green-100 disabled:opacity-50"
                      >
                        <CheckCircle className="h-3 w-3 mr-1" /> Approve
                      </button>
                      <button
                        onClick={() => setRejectId(entry.id)}
                        className="inline-flex items-center px-2 py-1 text-xs bg-red-50 text-red-700 border border-red-200 rounded hover:bg-red-100"
                      >
                        <XCircle className="h-3 w-3 mr-1" /> Reject
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="bg-white border rounded-lg shadow-sm overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Min Amount</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Required Role</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Description</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {ruleList.length === 0 ? (
                <tr><td colSpan={4} className="px-6 py-8 text-center text-gray-500">No approval rules configured.</td></tr>
              ) : ruleList.map((rule) => (
                <tr key={rule.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4 text-sm text-right font-medium">{fmt(rule.minAmount)}</td>
                  <td className="px-6 py-4 text-sm">
                    <span className="inline-flex px-2 py-0.5 text-xs font-medium bg-purple-100 text-purple-700 rounded-full">{rule.requiredRole}</span>
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-500">{rule.description || rule.name || '—'}</td>
                  <td className="px-6 py-4">
                    <span className={`inline-flex px-2 py-0.5 text-xs font-medium rounded-full ${rule.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}>
                      {rule.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}