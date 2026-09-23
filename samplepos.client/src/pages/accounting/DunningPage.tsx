import { useState } from 'react';
import { useDunningLevels, useCreateDunningLevel, useDunningAnalysis } from '../../hooks/useAccountingModules';
import { getBusinessDate } from '../../utils/businessDate';
import { DatePicker } from '../../components/ui/date-picker';
import { AlertTriangle, Plus, Search, X } from 'lucide-react';

interface DunningLevel {
  id: string;
  levelNumber: number;
  name?: string;
  daysOverdue: number;
  feeAmount: number;
  feePercentage?: number;
  interestRate?: number;
  letterTemplate: string;
  blockFurtherCredit: boolean;
  isActive: boolean;
}

interface DunningProposal {
  customerId: string;
  customerName: string;
  totalOverdue: number;
  currentLevel: number;
  proposedLevel: number;
  daysOverdue: number;
  proposedFee?: number;
  proposedInterest?: number;
  shouldBlockCredit?: boolean;
  overdueItems?: Array<{
    invoiceId: string;
    invoiceNumber: string;
    amount: number;
    amountDue: number;
    daysOverdue: number;
  }>;
}

export default function DunningPage() {
  const [showForm, setShowForm] = useState(false);
  const [showAnalysis, setShowAnalysis] = useState(false);
  const [analysisDate, setAnalysisDate] = useState(getBusinessDate());
  const { data: levels, isLoading } = useDunningLevels();
  const createMutation = useCreateDunningLevel();
  const analysisMutation = useDunningAnalysis();

  const items = (Array.isArray(levels) ? levels : []) as DunningLevel[];
  const nextLevelNumber = () =>
    items.reduce((max, l) => Math.max(max, Number(l.levelNumber) || 0), 0) + 1;

  const emptyForm = (levelNumber: number) => ({
    levelNumber,
    name: '',
    daysOverdue: 30,
    feeAmount: 0,
    letterTemplate: '',
    blockFurtherCredit: false,
  });

  const [form, setForm] = useState(() => emptyForm(1));

  // Analysis response has nested proposals
  const analysisData = analysisMutation.data?.data?.data as { proposals?: DunningProposal[] } | undefined;
  const analysisResults = (Array.isArray(analysisData?.proposals) ? analysisData.proposals : []) as DunningProposal[];

  const openForm = () => {
    setForm(emptyForm(nextLevelNumber()));
    setShowForm(true);
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = form.name.trim() || `Level ${form.levelNumber}`;
    try {
      await createMutation.mutateAsync({
        levelNumber: form.levelNumber,
        name,
        daysOverdue: form.daysOverdue,
        feeAmount: form.feeAmount,
        letterTemplate: form.letterTemplate,
        blockFurtherCredit: form.blockFurtherCredit,
      });
      setForm(emptyForm(form.levelNumber + 1));
      setShowForm(false);
    } catch {
      // toast handled by useCreateDunningLevel.onError
    }
  };

  const runAnalysis = () => {
    setShowAnalysis(true);
    analysisMutation.mutate({ asOfDate: analysisDate });
  };

  const fmt = (val: number) => val?.toLocaleString('en-US', { minimumFractionDigits: 0 }) ?? '0';

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Dunning Management</h1>
          <p className="text-sm text-gray-500 mt-1">Configure dunning levels and analyze overdue receivables</p>
        </div>
        <button
          onClick={openForm}
          className="inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm"
        >
          <Plus className="h-4 w-4 mr-2" /> Add Level
        </button>
      </div>

      {/* Create Form */}
      {showForm && (
        <div className="bg-white border rounded-lg p-6 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">New Dunning Level</h2>
            <button onClick={() => setShowForm(false)} className="text-gray-400 hover:text-gray-600">
              <X className="h-5 w-5" />
            </button>
          </div>
          <form onSubmit={handleCreate} className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Level Number</label>
              <input
                type="number"
                min={1}
                value={form.levelNumber}
                onChange={(e) => setForm({ ...form, levelNumber: parseInt(e.target.value) })}
                required
                className="w-full px-3 py-2 border rounded-lg text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg text-sm"
                placeholder={`Level ${form.levelNumber}`}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Days Overdue</label>
              <input
                type="number"
                min={1}
                value={form.daysOverdue}
                onChange={(e) => setForm({ ...form, daysOverdue: parseInt(e.target.value) })}
                required
                className="w-full px-3 py-2 border rounded-lg text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Fee Amount</label>
              <input
                type="number"
                step="1"
                value={form.feeAmount}
                onChange={(e) => setForm({ ...form, feeAmount: parseFloat(e.target.value) })}
                className="w-full px-3 py-2 border rounded-lg text-sm"
              />
            </div>
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">Letter Template</label>
              <textarea
                value={form.letterTemplate}
                onChange={(e) => setForm({ ...form, letterTemplate: e.target.value })}
                required
                rows={3}
                className="w-full px-3 py-2 border rounded-lg text-sm"
                placeholder="Dear customer, your account is overdue ..."
              />
            </div>
            <div className="flex items-end">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.blockFurtherCredit}
                  onChange={(e) => setForm({ ...form, blockFurtherCredit: e.target.checked })}
                  className="rounded"
                />
                Block Further Credit
              </label>
            </div>
            <div className="md:col-span-3 flex justify-end gap-2">
              <button type="button" onClick={() => setShowForm(false)} className="px-4 py-2 border rounded-lg text-sm hover:bg-gray-50">Cancel</button>
              <button type="submit" disabled={createMutation.isPending} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50">
                Create Level
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Dunning Levels Table */}
      <div className="bg-white border rounded-lg shadow-sm overflow-x-auto">
        <div className="px-6 py-4 border-b bg-gray-50">
          <h3 className="text-sm font-semibold text-gray-700">Dunning Levels</h3>
        </div>
        {isLoading ? (
          <div className="text-center py-8 text-gray-500">Loading...</div>
        ) : (
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Level</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Name</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Days Overdue</th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Fee</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Block Credit</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Template</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {items.length === 0 ? (
                <tr><td colSpan={7} className="px-6 py-8 text-center text-gray-500">No dunning levels configured.</td></tr>
              ) : items.map((level) => (
                <tr key={level.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4">
                    <span className="inline-flex items-center justify-center h-7 w-7 bg-orange-100 text-orange-700 text-sm font-bold rounded-full">
                      {level.levelNumber}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-sm">{level.name || `Level ${level.levelNumber}`}</td>
                  <td className="px-6 py-4 text-sm">{level.daysOverdue} days</td>
                  <td className="px-6 py-4 text-sm text-right font-medium">{fmt(level.feeAmount)}</td>
                  <td className="px-6 py-4 text-sm">
                    {level.blockFurtherCredit ? (
                      <span className="text-red-600 font-medium">Yes</span>
                    ) : (
                      <span className="text-gray-400">No</span>
                    )}
                  </td>
                  <td className="px-6 py-4">
                    <span className={`inline-flex px-2 py-0.5 text-xs font-medium rounded-full ${level.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}>
                      {level.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-500 max-w-xs truncate">{level.letterTemplate}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Analysis Section */}
      <div className="bg-white border rounded-lg shadow-sm p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Dunning Analysis</h3>
        <div className="flex items-end gap-4 mb-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">As of Date</label>
            <DatePicker
              value={analysisDate}
              onChange={setAnalysisDate}
              placeholder="As of date"
            />
          </div>
          <button
            onClick={runAnalysis}
            disabled={analysisMutation.isPending}
            className="inline-flex items-center px-4 py-2 bg-orange-600 text-white rounded-lg hover:bg-orange-700 text-sm disabled:opacity-50"
          >
            <Search className="h-4 w-4 mr-2" /> Run Analysis
          </button>
        </div>

        {showAnalysis && (
          <div className="mt-4">
            {analysisMutation.isPending ? (
              <div className="text-center py-8 text-gray-500">Analyzing...</div>
            ) : analysisResults.length === 0 ? (
              <div className="text-center py-8 text-gray-500">
                <AlertTriangle className="h-8 w-8 mx-auto mb-2 text-gray-300" />
                No overdue accounts found
              </div>
            ) : (
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Customer</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Overdue Amount</th>
                    <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">Current Level</th>
                    <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">Proposed Level</th>
                    <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">Days Overdue</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {analysisResults.map((r) => (
                    <tr key={r.customerId} className="hover:bg-gray-50">
                      <td className="px-4 py-3 text-sm font-medium">{r.customerName}</td>
                      <td className="px-4 py-3 text-sm text-right font-medium text-red-600">{fmt(r.totalOverdue)}</td>
                      <td className="px-4 py-3 text-sm text-center">
                        <span className="inline-flex items-center justify-center h-6 w-6 bg-gray-100 text-gray-700 text-xs font-bold rounded-full">
                          {r.currentLevel}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm text-center">
                        <span className="inline-flex items-center justify-center h-6 w-6 bg-orange-100 text-orange-700 text-xs font-bold rounded-full">
                          {r.proposedLevel}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm text-center">{r.daysOverdue}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
