import { useState, useEffect, useMemo, useRef } from 'react';
import {
  useAssetCategories, useCreateAssetCategory, useAssets, useCreateAsset, useRunDepreciation,
  useDisposeAsset, useCutoverPreview, useApplyCutoverCorrections,
} from '../../hooks/useAccountingModules';
import { useTransactionGuard, ZINDEX } from '../../hooks/useTransactionGuard';
import type { GuardHandle } from '../../hooks/useTransactionGuard';
import {
  Building, Plus, X, Play, Package, Search, Eye,
  Trash2, DollarSign, BarChart3, FileText, Settings, ArrowRight,
  CheckCircle, AlertTriangle, Clock, TrendingDown, ShieldAlert,
} from 'lucide-react';
import { formatCurrency } from '../../utils/currency';
import { api } from '../../services/api';
import { DatePicker } from '../../components/ui/date-picker';

// ─── Types ──────────────────────────────────────────────────────────
interface AssetCategory {
  id: string;
  code: string;
  name: string;
  usefulLifeMonths: number;
  depreciationMethod: string;
  depreciationRate?: number;
  assetAccountCode: string;
  depreciationAccountCode: string;
  accumDepreciationAccountCode: string;
  isActive: boolean;
}

interface Asset {
  id: string;
  assetNumber: string;
  name: string;
  description?: string;
  categoryId: string;
  acquisitionDate: string;
  acquisitionCost: number;
  salvageValue: number;
  usefulLifeMonths: number;
  depreciationMethod: string;
  depreciationStartDate: string;
  accumulatedDepreciation: number;
  netBookValue: number;
  status: string;
  disposedDate?: string;
  disposalAmount?: number;
  costCenterId?: string;
  location?: string;
  serialNumber?: string;
  createdAt: string;
}

interface CutoverCorrectionResult {
  assetId: string;
  assetNumber: string;
  assetName: string;
  correctionTransactionId: string | null;
  status: 'APPLIED' | 'SKIPPED_ALREADY_CORRECTED' | 'SKIPPED_PROTECTED_SOURCE';
  reason?: string;
}

interface CutoverSummary {
  cutoverDate: string;
  candidatesFound: number;
  applied: number;
  skipped: number;
  dryRun: boolean;
  results: CutoverCorrectionResult[];
}

interface ChartAccount {
  id: string;
  accountCode: string;
  accountName: string;
  accountType: string;
  normalBalance: string;
  isActive: boolean;
}

type TabId = 'register' | 'categories' | 'depreciation' | 'corrections';

// ─── Constants ──────────────────────────────────────────────────────
const DEPRECIATION_METHODS = [
  { value: 'STRAIGHT_LINE', label: 'Straight-Line', desc: '(Cost − Salvage) ÷ Life' },
  { value: 'DECLINING_BALANCE', label: 'Declining Balance', desc: 'NBV × Rate (double-declining)' },
];

const STATUS_CONFIG: Record<string, { bg: string; text: string; icon: typeof CheckCircle }> = {
  ACTIVE: { bg: 'bg-green-50 border-green-200', text: 'text-green-700', icon: CheckCircle },
  DISPOSED: { bg: 'bg-red-50 border-red-200', text: 'text-red-700', icon: Trash2 },
  WRITTEN_OFF: { bg: 'bg-gray-50 border-gray-200', text: 'text-gray-600', icon: AlertTriangle },
  FULLY_DEPRECIATED: { bg: 'bg-amber-50 border-amber-200', text: 'text-amber-700', icon: Clock },
};

// ─── Component ──────────────────────────────────────────────────────
export default function AssetAccountingPage() {
  const [activeTab, setActiveTab] = useState<TabId>('register');
  const [showCategoryForm, setShowCategoryForm] = useState(false);
  const [showAssetForm, setShowAssetForm] = useState(false);
  const [showDepRun, setShowDepRun] = useState(false);
  const [selectedAsset, setSelectedAsset] = useState<Asset | null>(null);

  // ── Transaction Guards ─────────────────────────────────────────────
  const { openGuard: openCatGuard, closeGuard: closeCatGuard } = useTransactionGuard();
  const catGuardRef = useRef<GuardHandle | null>(null);
  useEffect(() => {
    if (showCategoryForm) {
      catGuardRef.current = openCatGuard({ cancellable: false, label: 'Create asset category' });
      return () => { if (catGuardRef.current) { closeCatGuard(catGuardRef.current.id); catGuardRef.current = null; } };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showCategoryForm]);
  const { openGuard: openAssetGuard, closeGuard: closeAssetGuard } = useTransactionGuard();
  const assetGuardRef = useRef<GuardHandle | null>(null);
  useEffect(() => {
    if (showAssetForm) {
      assetGuardRef.current = openAssetGuard({ cancellable: false, label: 'Acquire fixed asset' });
      return () => { if (assetGuardRef.current) { closeAssetGuard(assetGuardRef.current.id); assetGuardRef.current = null; } };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showAssetForm]);
  const { openGuard: openDepGuard, closeGuard: closeDepGuard } = useTransactionGuard();
  const depGuardRef = useRef<GuardHandle | null>(null);
  useEffect(() => {
    if (showDepRun) {
      depGuardRef.current = openDepGuard({ cancellable: false, label: 'Run depreciation' });
      return () => { if (depGuardRef.current) { closeDepGuard(depGuardRef.current.id); depGuardRef.current = null; } };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showDepRun]);
  const { openGuard: openDetailGuard, closeGuard: closeDetailGuard } = useTransactionGuard();
  const detailGuardRef = useRef<GuardHandle | null>(null);
  useEffect(() => {
    if (selectedAsset) {
      detailGuardRef.current = openDetailGuard({ cancellable: true, label: 'View asset details' });
      return () => { if (detailGuardRef.current) { closeDetailGuard(detailGuardRef.current.id); detailGuardRef.current = null; } };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAsset]);

  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [categoryFilter, setCategoryFilter] = useState('ALL');
  const [accounts, setAccounts] = useState<ChartAccount[]>([]);

  const { data: categories } = useAssetCategories();
  const { data: assets, isLoading } = useAssets();
  const createCategory = useCreateAssetCategory();
  const createAsset = useCreateAsset();
  const runDep = useRunDepreciation();
  const disposeAsset = useDisposeAsset();

  const [showDisposeForm, setShowDisposeForm] = useState(false);
  const [disposeForm, setDisposeForm] = useState({ disposalDate: '', disposalAmount: '0' });

  // ── Cutover Correction State ──────────────────────────────────────
  const [cutoverDate, setCutoverDate] = useState('2026-02-01');
  const [cutoverPreviewData, setCutoverPreviewData] = useState<CutoverSummary | null>(null);
  const [cutoverApplyResult, setCutoverApplyResult] = useState<CutoverSummary | null>(null);
  const [showApplyConfirm, setShowApplyConfirm] = useState(false);
  const cutoverPreview = useCutoverPreview();
  const applyCutover = useApplyCutoverCorrections();

  const handleCutoverPreview = async () => {
    setCutoverPreviewData(null);
    setCutoverApplyResult(null);
    const res = await cutoverPreview.mutateAsync({ cutoverDate });
    const summary = (res as { data?: { data?: CutoverSummary } })?.data?.data;
    if (summary) setCutoverPreviewData(summary);
  };

  const handleCutoverApply = async () => {
    setShowApplyConfirm(false);
    setCutoverApplyResult(null);
    const res = await applyCutover.mutateAsync({ cutoverDate });
    const summary = (res as { data?: { data?: CutoverSummary } })?.data?.data;
    if (summary) { setCutoverApplyResult(summary); setCutoverPreviewData(null); }
  };

  const cats: AssetCategory[] = useMemo(() => Array.isArray(categories) ? categories : [], [categories]);
  const assetList: Asset[] = useMemo(() => Array.isArray(assets) ? assets : [], [assets]);

  // Fetch chart of accounts for GL assignment
  useEffect(() => {
    api.get('/accounting/chart-of-accounts?isActive=true')
      .then((res) => {
        const data = res.data as { success?: boolean; data?: Record<string, unknown>[] };
        if (data.success && Array.isArray(data.data)) {
          setAccounts(data.data.map((a) => ({
            id: (a.Id || a.id) as string,
            accountCode: (a.AccountCode || a.accountCode) as string,
            accountName: (a.AccountName || a.accountName) as string,
            accountType: (a.AccountType || a.accountType) as string,
            normalBalance: (a.NormalBalance || a.normalBalance) as string,
            isActive: (a.IsActive ?? a.isActive ?? true) as boolean,
          })));
        }
      })
      .catch(() => { /* silent */ });
  }, []);

  // ─── Category Form State ──────────────────────────────────────────
  const [catForm, setCatForm] = useState({
    code: '', name: '', usefulLifeMonths: 60,
    depreciationMethod: 'STRAIGHT_LINE', depreciationRate: '',
    assetAccountCode: '1500', depreciationAccountCode: '6500', accumDepreciationAccountCode: '1550',
  });

  // ─── Asset Form State ─────────────────────────────────────────────
  const [assetForm, setAssetForm] = useState<{
    name: string; categoryId: string; acquisitionDate: string; acquisitionCost: string;
    salvageValue: string; description: string; location: string; serialNumber: string;
    registrationMode: 'PURCHASE' | 'OPENING';
    paymentMethod: 'CASH' | 'BANK' | 'AP';
  }>({
    name: '', categoryId: '', acquisitionDate: '', acquisitionCost: '',
    salvageValue: '0', description: '', location: '', serialNumber: '',
    registrationMode: 'PURCHASE',
    paymentMethod: 'CASH',
  });

  // ─── Depreciation Run State ───────────────────────────────────────
  const [depForm, setDepForm] = useState({
    year: new Date().getFullYear(),
    month: new Date().getMonth() + 1,
  });

  // ─── Filtered Assets ──────────────────────────────────────────────
  const filteredAssets = useMemo(() => {
    return assetList.filter(a => {
      const matchSearch = !searchTerm ||
        a.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        a.assetNumber.toLowerCase().includes(searchTerm.toLowerCase()) ||
        (a.serialNumber || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
        (a.location || '').toLowerCase().includes(searchTerm.toLowerCase());
      const matchStatus = statusFilter === 'ALL' || a.status === statusFilter;
      const matchCategory = categoryFilter === 'ALL' || a.categoryId === categoryFilter;
      return matchSearch && matchStatus && matchCategory;
    });
  }, [assetList, searchTerm, statusFilter, categoryFilter]);

  // ─── Summary Stats ────────────────────────────────────────────────
  const summary = useMemo(() => {
    const active = assetList.filter(a => a.status === 'ACTIVE');
    return {
      totalAssets: assetList.length,
      activeAssets: active.length,
      totalCost: active.reduce((s, a) => s + a.acquisitionCost, 0),
      totalNbv: active.reduce((s, a) => s + a.netBookValue, 0),
      totalDepr: active.reduce((s, a) => s + a.accumulatedDepreciation, 0),
    };
  }, [assetList]);

  // ─── Handlers ─────────────────────────────────────────────────────
  const handleCreateCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    await createCategory.mutateAsync({
      code: catForm.code,
      name: catForm.name,
      usefulLifeMonths: catForm.usefulLifeMonths,
      depreciationMethod: catForm.depreciationMethod,
      depreciationRate: catForm.depreciationRate ? parseFloat(catForm.depreciationRate) : undefined,
      assetAccountCode: catForm.assetAccountCode,
      depreciationAccountCode: catForm.depreciationAccountCode,
      accumDepreciationAccountCode: catForm.accumDepreciationAccountCode,
    });
    setCatForm({ code: '', name: '', usefulLifeMonths: 60, depreciationMethod: 'STRAIGHT_LINE', depreciationRate: '', assetAccountCode: '1500', depreciationAccountCode: '6500', accumDepreciationAccountCode: '1550' });
    setShowCategoryForm(false);
  };

  const handleCreateAsset = async (e: React.FormEvent) => {
    e.preventDefault();
    await createAsset.mutateAsync({
      name: assetForm.name,
      categoryId: assetForm.categoryId,
      acquisitionDate: assetForm.acquisitionDate,
      acquisitionCost: parseFloat(assetForm.acquisitionCost),
      salvageValue: parseFloat(assetForm.salvageValue) || 0,
      description: assetForm.description || undefined,
      location: assetForm.location || undefined,
      serialNumber: assetForm.serialNumber || undefined,
      mode: assetForm.registrationMode,
      // Only pass paymentMethod for PURCHASE — never for OPENING.
      ...(assetForm.registrationMode === 'PURCHASE' && { paymentMethod: assetForm.paymentMethod }),
    });
    setAssetForm({ name: '', categoryId: '', acquisitionDate: '', acquisitionCost: '', salvageValue: '0', description: '', location: '', serialNumber: '', registrationMode: 'PURCHASE', paymentMethod: 'CASH' });
    setShowAssetForm(false);
  };

  const handleRunDep = async (e: React.FormEvent) => {
    e.preventDefault();
    await runDep.mutateAsync({ year: depForm.year, month: depForm.month });
    setShowDepRun(false);
  };

  const handleDispose = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedAsset) return;
    await disposeAsset.mutateAsync({
      assetId: selectedAsset.id,
      disposalDate: disposeForm.disposalDate,
      disposalAmount: parseFloat(disposeForm.disposalAmount) || 0,
    });
    setShowDisposeForm(false);
    setSelectedAsset(null);
  };

  const getAccountLabel = (code: string) => {
    const acc = accounts.find(a => a.accountCode === code);
    return acc ? `${acc.accountCode} – ${acc.accountName}` : code;
  };

  const getCategoryName = (id: string) => cats.find(c => c.id === id)?.name ?? '—';

  const depreciationPercent = (a: Asset) => {
    if (a.acquisitionCost <= 0) return 0;
    return Math.min(100, Math.round((a.accumulatedDepreciation / a.acquisitionCost) * 100));
  };

  // ─── Render ───────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Building className="h-6 w-6 text-blue-600" />
            Asset Accounting
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Fixed asset register, depreciation management & GL integration
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setShowDepRun(true)}
            className="inline-flex items-center px-3 py-2 text-sm border border-amber-300 bg-amber-50 text-amber-800 rounded-lg hover:bg-amber-100 transition-colors"
          >
            <Play className="h-4 w-4 mr-2" /> Run Depreciation
          </button>
          {activeTab === 'register' && (
            <button
              onClick={() => setShowAssetForm(true)}
              className="inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm transition-colors"
            >
              <Plus className="h-4 w-4 mr-2" /> Acquire Asset
            </button>
          )}
          {activeTab === 'categories' && (
            <button
              onClick={() => setShowCategoryForm(true)}
              className="inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm transition-colors"
            >
              <Plus className="h-4 w-4 mr-2" /> New Asset Class
            </button>
          )}
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <SummaryCard icon={Package} label="Total Assets" value={String(summary.totalAssets)} sub={`${summary.activeAssets} active`} color="blue" />
        <SummaryCard icon={DollarSign} label="Acquisition Cost" value={formatCurrency(summary.totalCost)} color="green" />
        <SummaryCard icon={TrendingDown} label="Accum. Depreciation" value={formatCurrency(summary.totalDepr)} color="amber" />
        <SummaryCard icon={BarChart3} label="Net Book Value" value={formatCurrency(summary.totalNbv)} color="indigo" />
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200">
        <nav className="flex gap-1 -mb-px overflow-x-auto" aria-label="Tabs">
          {([
            { id: 'register' as TabId, label: 'Asset Register', icon: FileText, count: assetList.length },
            { id: 'categories' as TabId, label: 'Asset Classes', icon: Settings, count: cats.length },
            { id: 'depreciation' as TabId, label: 'Depreciation', icon: TrendingDown },
            { id: 'corrections' as TabId, label: 'Cutover Fix', icon: ShieldAlert },
          ]).map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${activeTab === tab.id
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
            >
              <tab.icon className="h-4 w-4" />
              {tab.label}
              {tab.count !== undefined && (
                <span className={`ml-1 px-2 py-0.5 text-xs rounded-full ${activeTab === tab.id ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'
                  }`}>{tab.count}</span>
              )}
            </button>
          ))}
        </nav>
      </div>

      {/* ═══════════════ Depreciation Run Modal ═══════════════ */}
      {showDepRun && (
        <Modal title="Run Monthly Depreciation" onClose={() => setShowDepRun(false)} zIndex={depGuardRef.current?.panelZIndex ?? ZINDEX.PANEL}>
          <p className="text-sm text-gray-600 mb-4">
            Posts GL entries for all active assets: DR Depreciation Expense, CR Accumulated Depreciation.
            Already-processed periods are skipped (idempotent).
          </p>
          <form onSubmit={handleRunDep} className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Fiscal Year</label>
              <input type="number" min={2020} max={2099} value={depForm.year}
                onChange={e => setDepForm({ ...depForm, year: parseInt(e.target.value) })}
                required className="w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Period (Month)</label>
              <select value={depForm.month} onChange={e => setDepForm({ ...depForm, month: parseInt(e.target.value) })}
                className="w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
                {Array.from({ length: 12 }, (_, i) => (
                  <option key={i + 1} value={i + 1}>
                    {new Date(2000, i).toLocaleString('default', { month: 'long' })} ({String(i + 1).padStart(2, '0')})
                  </option>
                ))}
              </select>
            </div>
            <div className="sm:col-span-2 flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setShowDepRun(false)} className="px-4 py-2 border rounded-lg text-sm hover:bg-gray-50">Cancel</button>
              <button type="submit" disabled={runDep.isPending}
                className="px-4 py-2 bg-amber-600 text-white rounded-lg text-sm hover:bg-amber-700 disabled:opacity-50 inline-flex items-center">
                <Play className="h-4 w-4 mr-2" /> {runDep.isPending ? 'Processing...' : 'Execute Run'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* ═══════════════ New Category Form ═══════════════ */}
      {showCategoryForm && (
        <Modal title="Create Asset Class" onClose={() => setShowCategoryForm(false)} wide zIndex={catGuardRef.current?.panelZIndex ?? ZINDEX.PANEL}>
          <p className="text-sm text-gray-500 mb-4">
            Define GL account determination and depreciation parameters for this asset class.
          </p>
          <form onSubmit={handleCreateCategory} className="space-y-6">
            {/* General */}
            <fieldset className="border border-gray-200 rounded-lg p-4">
              <legend className="text-sm font-semibold text-gray-700 px-2">General</legend>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <FormField label="Class Code *" placeholder="e.g., VEHICLE" value={catForm.code}
                  onChange={v => setCatForm({ ...catForm, code: v })} required />
                <FormField label="Class Name *" placeholder="e.g., Motor Vehicles" value={catForm.name}
                  onChange={v => setCatForm({ ...catForm, name: v })} required />
              </div>
            </fieldset>

            {/* Depreciation Parameters */}
            <fieldset className="border border-gray-200 rounded-lg p-4">
              <legend className="text-sm font-semibold text-gray-700 px-2">Depreciation Parameters</legend>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Method *</label>
                  <select value={catForm.depreciationMethod}
                    onChange={e => setCatForm({ ...catForm, depreciationMethod: e.target.value })}
                    className="w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
                    {DEPRECIATION_METHODS.map(m => (
                      <option key={m.value} value={m.value}>{m.label}</option>
                    ))}
                  </select>
                  <p className="text-xs text-gray-400 mt-1">
                    {DEPRECIATION_METHODS.find(m => m.value === catForm.depreciationMethod)?.desc}
                  </p>
                </div>
                <FormField label="Useful Life (Months) *" type="number" min={1} value={String(catForm.usefulLifeMonths)}
                  onChange={v => setCatForm({ ...catForm, usefulLifeMonths: parseInt(v) || 60 })} required />
                {catForm.depreciationMethod === 'DECLINING_BALANCE' && (
                  <FormField label="Annual Rate (%)" type="number" step="1" placeholder="e.g., 0.20"
                    value={catForm.depreciationRate}
                    onChange={v => setCatForm({ ...catForm, depreciationRate: v })} />
                )}
              </div>
            </fieldset>

            {/* GL Account Determination */}
            <fieldset className="border border-blue-100 bg-blue-50/30 rounded-lg p-4">
              <legend className="text-sm font-semibold text-blue-700 px-2">GL Account Determination</legend>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <AccountSelect label="Asset Account (BS)" value={catForm.assetAccountCode}
                  onChange={v => setCatForm({ ...catForm, assetAccountCode: v })}
                  accounts={accounts} filterType="ASSET" />
                <AccountSelect label="Depreciation Expense (PL)" value={catForm.depreciationAccountCode}
                  onChange={v => setCatForm({ ...catForm, depreciationAccountCode: v })}
                  accounts={accounts} filterType="EXPENSE" />
                <AccountSelect label="Accum. Depreciation (BS)" value={catForm.accumDepreciationAccountCode}
                  onChange={v => setCatForm({ ...catForm, accumDepreciationAccountCode: v })}
                  accounts={accounts} filterType="ASSET" />
              </div>
              <p className="text-xs text-blue-600 mt-3">
                These accounts are posted automatically during acquisition and depreciation runs.
              </p>
            </fieldset>

            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setShowCategoryForm(false)} className="px-4 py-2 border rounded-lg text-sm hover:bg-gray-50">Cancel</button>
              <button type="submit" disabled={createCategory.isPending}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50">
                {createCategory.isPending ? 'Creating...' : 'Create Asset Class'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* ═══════════════ Acquire Asset Form ═══════════════ */}
      {showAssetForm && (
        <Modal title="Acquire Fixed Asset" onClose={() => setShowAssetForm(false)} wide zIndex={assetGuardRef.current?.panelZIndex ?? ZINDEX.PANEL}>
          <p className="text-sm text-gray-500 mb-4">
            Register a new asset. A GL journal entry will be posted automatically:
            DR Fixed Assets, CR {assetForm.paymentMethod === 'CASH' ? 'Cash' : 'Accounts Payable'}.
          </p>
          {cats.length === 0 ? (
            <div className="text-center py-8 bg-amber-50 rounded-lg border border-amber-200">
              <AlertTriangle className="h-8 w-8 text-amber-500 mx-auto mb-2" />
              <p className="text-sm text-amber-800 font-medium">No asset classes defined.</p>
              <p className="text-xs text-amber-600 mt-1">Create an asset class first to define GL accounts and depreciation settings.</p>
              <button onClick={() => { setShowAssetForm(false); setActiveTab('categories'); setShowCategoryForm(true); }}
                className="mt-3 px-4 py-2 bg-amber-600 text-white rounded-lg text-sm hover:bg-amber-700 inline-flex items-center">
                <Plus className="h-4 w-4 mr-1" /> Create Asset Class
              </button>
            </div>
          ) : (
            <form onSubmit={handleCreateAsset} className="space-y-6">
              {/* General Info */}
              <fieldset className="border border-gray-200 rounded-lg p-4">
                <legend className="text-sm font-semibold text-gray-700 px-2">Asset Information</legend>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <FormField label="Asset Name *" placeholder="e.g., Delivery Van - Toyota Hilux" value={assetForm.name}
                    onChange={v => setAssetForm({ ...assetForm, name: v })} required />
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Asset Class *</label>
                    <select value={assetForm.categoryId}
                      onChange={e => setAssetForm({ ...assetForm, categoryId: e.target.value })}
                      required className="w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
                      <option value="">Select asset class...</option>
                      {cats.map(c => (
                        <option key={c.id} value={c.id}>{c.code} – {c.name} ({c.usefulLifeMonths}m, {c.depreciationMethod.replace(/_/g, ' ')})</option>
                      ))}
                    </select>
                  </div>
                  <FormField label="Description" placeholder="Optional description" value={assetForm.description}
                    onChange={v => setAssetForm({ ...assetForm, description: v })} />
                  <FormField label="Serial Number" placeholder="e.g., VIN or S/N" value={assetForm.serialNumber}
                    onChange={v => setAssetForm({ ...assetForm, serialNumber: v })} />
                  <FormField label="Location" placeholder="e.g., Main Office, Warehouse A" value={assetForm.location}
                    onChange={v => setAssetForm({ ...assetForm, location: v })} />
                </div>
              </fieldset>

              {/* Financial */}
              <fieldset className="border border-green-100 bg-green-50/30 rounded-lg p-4">
                <legend className="text-sm font-semibold text-green-700 px-2">Financial Details</legend>

                {/* ── Registration Mode ──────────────────────────────────────── */}
                <div className="mb-4">
                  <label className="block text-sm font-semibold text-gray-700 mb-2">Registration Mode *</label>
                  <div className="flex gap-4">
                    <label className="flex items-start gap-2 cursor-pointer">
                      <input
                        type="radio" name="registrationMode" value="PURCHASE"
                        checked={assetForm.registrationMode === 'PURCHASE'}
                        onChange={() => setAssetForm({ ...assetForm, registrationMode: 'PURCHASE' })}
                        className="mt-0.5"
                      />
                      <div>
                        <div className="text-sm font-medium text-gray-800">New Asset Purchase</div>
                        <div className="text-xs text-gray-500">Asset is being bought now. Credits Cash, Bank, or Accounts Payable.</div>
                      </div>
                    </label>
                    <label className="flex items-start gap-2 cursor-pointer">
                      <input
                        type="radio" name="registrationMode" value="OPENING"
                        checked={assetForm.registrationMode === 'OPENING'}
                        onChange={() => setAssetForm({ ...assetForm, registrationMode: 'OPENING' })}
                        className="mt-0.5"
                      />
                      <div>
                        <div className="text-sm font-medium text-gray-800">Opening Asset (pre-ERP)</div>
                        <div className="text-xs text-gray-500">Asset existed before ERP go-live. Credits Opening Balance Equity — Cash is not affected.</div>
                      </div>
                    </label>
                  </div>
                </div>

                {/* Opening mode info banner */}
                {assetForm.registrationMode === 'OPENING' && (
                  <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-800">
                    <strong>Opening Balance mode:</strong> This asset existed before your ERP go-live date.
                    The acquisition will credit <strong>Opening Balance Equity (3050)</strong> — not Cash or Payables.
                    No payment is recorded; this is a balance sheet state declaration.
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                  <FormField label="Acquisition Date *" type="date" value={assetForm.acquisitionDate}
                    onChange={v => setAssetForm({ ...assetForm, acquisitionDate: v })} required />
                  <FormField label="Acquisition Cost *" type="number" step="1" placeholder="0.00" value={assetForm.acquisitionCost}
                    onChange={v => setAssetForm({ ...assetForm, acquisitionCost: v })} required />
                  <FormField label="Salvage Value" type="number" step="1" placeholder="0.00" value={assetForm.salvageValue}
                    onChange={v => setAssetForm({ ...assetForm, salvageValue: v })} />
                  {/* Payment Method — PURCHASE mode only */}
                  {assetForm.registrationMode === 'PURCHASE' ? (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Payment Method *</label>
                      <select value={assetForm.paymentMethod}
                        onChange={e => setAssetForm({ ...assetForm, paymentMethod: e.target.value as 'CASH' | 'BANK' | 'AP' })}
                        className="w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
                        <option value="CASH">Cash (CR 1010 – Cash)</option>
                        <option value="BANK">Bank Transfer (CR 1010 – Cash)</option>
                        <option value="AP">Accounts Payable (CR 2100 – AP)</option>
                      </select>
                    </div>
                  ) : (
                    <div className="flex items-end">
                      <div className="w-full px-3 py-2 border border-blue-200 bg-blue-50 rounded-lg text-sm text-blue-700 font-medium">
                        CR: 3050 – Opening Balance Equity
                      </div>
                    </div>
                  )}
                </div>
              </fieldset>

              {/* Auto GL Preview */}
              {assetForm.categoryId && assetForm.acquisitionCost && (
                <div className="bg-gray-50 border rounded-lg p-4">
                  <h4 className="text-sm font-semibold text-gray-700 mb-2 flex items-center gap-2">
                    <ArrowRight className="h-4 w-4" /> GL Journal Preview
                  </h4>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm min-w-[400px]">
                      <thead>
                        <tr className="border-b text-xs text-gray-500">
                          <th className="text-left py-1">Account</th>
                          <th className="text-right py-1">Debit</th>
                          <th className="text-right py-1">Credit</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr>
                          <td className="py-1 font-mono text-gray-700">
                            {getAccountLabel(cats.find(c => c.id === assetForm.categoryId)?.assetAccountCode || '1500')}
                          </td>
                          <td className="py-1 text-right font-mono text-red-600">{formatCurrency(parseFloat(assetForm.acquisitionCost) || 0)}</td>
                          <td className="py-1 text-right">—</td>
                        </tr>
                        <tr>
                          <td className="py-1 font-mono text-gray-700">
                            {assetForm.registrationMode === 'OPENING'
                              ? <span className="text-blue-700">3050 – Opening Balance Equity</span>
                              : assetForm.paymentMethod === 'AP'
                                ? getAccountLabel('2100')
                                : getAccountLabel('1010')
                            }
                          </td>
                          <td className="py-1 text-right">—</td>
                          <td className="py-1 text-right font-mono text-green-600">{formatCurrency(parseFloat(assetForm.acquisitionCost) || 0)}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                  {assetForm.registrationMode === 'OPENING' && (
                    <p className="mt-2 text-xs text-blue-600">Cash balance is unaffected — this is an opening balance entry.</p>
                  )}
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setShowAssetForm(false)} className="px-4 py-2 border rounded-lg text-sm hover:bg-gray-50">Cancel</button>
                <button type="submit" disabled={createAsset.isPending}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50">
                  {createAsset.isPending ? 'Registering...' : 'Acquire Asset'}
                </button>
              </div>
            </form>
          )}
        </Modal>
      )}

      {/* ═══════════════ Asset Detail ═══════════════ */}
      {selectedAsset && (
        <Modal title={`${selectedAsset.assetNumber} — ${selectedAsset.name}`} onClose={() => setSelectedAsset(null)} wide zIndex={detailGuardRef.current?.panelZIndex ?? ZINDEX.PANEL}>
          <div className="space-y-4">
            {/* Status Bar */}
            <div className={`flex items-center gap-2 px-4 py-2 rounded-lg border ${STATUS_CONFIG[selectedAsset.status]?.bg || 'bg-gray-50 border-gray-200'}`}>
              <StatusIcon status={selectedAsset.status} />
              <span className={`text-sm font-semibold ${STATUS_CONFIG[selectedAsset.status]?.text || 'text-gray-600'}`}>
                {selectedAsset.status.replace(/_/g, ' ')}
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              <DetailField label="Asset Number" value={selectedAsset.assetNumber} mono />
              <DetailField label="Category" value={getCategoryName(selectedAsset.categoryId)} />
              <DetailField label="Acquisition Date" value={selectedAsset.acquisitionDate} />
              <DetailField label="Acquisition Cost" value={formatCurrency(selectedAsset.acquisitionCost)} mono />
              <DetailField label="Salvage Value" value={formatCurrency(selectedAsset.salvageValue)} mono />
              <DetailField label="Useful Life" value={`${selectedAsset.usefulLifeMonths} months`} />
              <DetailField label="Depreciation Method" value={selectedAsset.depreciationMethod.replace(/_/g, ' ')} />
              <DetailField label="Accum. Depreciation" value={formatCurrency(selectedAsset.accumulatedDepreciation)} mono />
              <DetailField label="Net Book Value" value={formatCurrency(selectedAsset.netBookValue)} mono highlight />
              {selectedAsset.serialNumber && <DetailField label="Serial Number" value={selectedAsset.serialNumber} mono />}
              {selectedAsset.location && <DetailField label="Location" value={selectedAsset.location} />}
            </div>

            {/* Depreciation Progress */}
            <div className="bg-gray-50 rounded-lg p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-gray-700">Depreciation Progress</span>
                <span className="text-sm font-mono text-gray-600">{depreciationPercent(selectedAsset)}%</span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-3">
                <div
                  className={`h-3 rounded-full transition-all ${depreciationPercent(selectedAsset) >= 100 ? 'bg-amber-500' : 'bg-blue-500'}`}
                  style={{ width: `${Math.min(100, depreciationPercent(selectedAsset))}%` }}
                />
              </div>
              <div className="flex justify-between mt-1 text-xs text-gray-500">
                <span>Cost: {formatCurrency(selectedAsset.acquisitionCost)}</span>
                <span>NBV: {formatCurrency(selectedAsset.netBookValue)}</span>
              </div>
            </div>

            {/* Dispose Action (ACTIVE only) */}
            {selectedAsset.status === 'ACTIVE' && (
              <div className="border border-red-200 bg-red-50 rounded-lg p-4">
                {!showDisposeForm ? (
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-semibold text-red-800">Dispose Asset</p>
                      <p className="text-xs text-red-600 mt-0.5">
                        Removes asset from register and posts disposal journal: DR Cash + Accum. Depr., CR Fixed Asset, +/– Gain/Loss.
                      </p>
                    </div>
                    <button
                      onClick={() => { setDisposeForm({ disposalDate: '', disposalAmount: '0' }); setShowDisposeForm(true); }}
                      className="ml-4 px-3 py-1.5 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 inline-flex items-center gap-1.5 shrink-0"
                    >
                      <Trash2 className="h-3.5 w-3.5" /> Dispose
                    </button>
                  </div>
                ) : (
                  <form onSubmit={handleDispose} className="space-y-3">
                    <p className="text-sm font-semibold text-red-800">Confirm Disposal — {selectedAsset.assetNumber}</p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-medium text-gray-700 mb-1">Disposal Date *</label>
                        <DatePicker
                          required
                          value={disposeForm.disposalDate}
                          onChange={(v) => setDisposeForm({ ...disposeForm, disposalDate: v })}
                          placeholder="Disposal date"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-700 mb-1">Proceeds / Sale Amount</label>
                        <input type="number" step="1" value={disposeForm.disposalAmount}
                          onChange={e => setDisposeForm({ ...disposeForm, disposalAmount: e.target.value })}
                          className="w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-red-500 focus:border-red-500" />
                        <p className="text-xs text-gray-500 mt-0.5">Enter 0 for write-off with no proceeds</p>
                      </div>
                    </div>
                    <div className="flex justify-end gap-2">
                      <button type="button" onClick={() => setShowDisposeForm(false)}
                        className="px-3 py-1.5 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
                      <button type="submit" disabled={disposeAsset.isPending}
                        className="px-4 py-1.5 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 inline-flex items-center gap-1.5">
                        <Trash2 className="h-3.5 w-3.5" />
                        {disposeAsset.isPending ? 'Posting GL...' : 'Confirm Disposal'}
                      </button>
                    </div>
                  </form>
                )}
              </div>
            )}
          </div>
        </Modal>
      )}

      {/* ═══════════════ TAB: Asset Register ═══════════════ */}
      {activeTab === 'register' && (
        <div className="space-y-4">
          {/* Filters */}
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
              <input
                type="text" placeholder="Search assets by name, number, serial, location..."
                value={searchTerm} onChange={e => setSearchTerm(e.target.value)}
                className="w-full pl-10 pr-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
              className="w-full sm:w-40 px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
              <option value="ALL">All Status</option>
              <option value="ACTIVE">Active</option>
              <option value="DISPOSED">Disposed</option>
              <option value="WRITTEN_OFF">Written Off</option>
            </select>
            <select value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)}
              className="w-full sm:w-48 px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
              <option value="ALL">All Classes</option>
              {cats.map(c => <option key={c.id} value={c.id}>{c.code} – {c.name}</option>)}
            </select>
          </div>

          {/* Table */}
          {isLoading ? (
            <div className="text-center py-12 text-gray-500">Loading asset register...</div>
          ) : filteredAssets.length === 0 ? (
            <div className="text-center py-16 bg-white border rounded-lg">
              <Package className="h-12 w-12 mx-auto mb-3 text-gray-300" />
              <h3 className="text-lg font-medium text-gray-900">No assets found</h3>
              <p className="text-sm text-gray-500 mt-1">
                {assetList.length === 0
                  ? 'Get started by acquiring your first fixed asset.'
                  : 'Try adjusting your search or filters.'}
              </p>
              {assetList.length === 0 && (
                <button onClick={() => setShowAssetForm(true)}
                  className="mt-4 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 inline-flex items-center">
                  <Plus className="h-4 w-4 mr-1" /> Acquire Asset
                </button>
              )}
            </div>
          ) : (
            <div className="bg-white border rounded-lg shadow-sm overflow-hidden">
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Asset #</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Name</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase hidden md:table-cell">Class</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase hidden lg:table-cell">Acquired</th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Cost</th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase hidden sm:table-cell">Accum. Depr.</th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">NBV</th>
                      <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase hidden sm:table-cell">Depr %</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                      <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">View</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200">
                    {filteredAssets.map(a => {
                      const pct = depreciationPercent(a);
                      return (
                        <tr key={a.id} className="hover:bg-gray-50 transition-colors">
                          <td className="px-4 py-3 text-sm font-mono font-medium text-blue-700">{a.assetNumber}</td>
                          <td className="px-4 py-3 text-sm text-gray-900">
                            <div>{a.name}</div>
                            {a.serialNumber && <div className="text-xs text-gray-400">S/N: {a.serialNumber}</div>}
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-500 hidden md:table-cell">{getCategoryName(a.categoryId)}</td>
                          <td className="px-4 py-3 text-sm text-gray-500 hidden lg:table-cell">{a.acquisitionDate}</td>
                          <td className="px-4 py-3 text-sm text-right font-mono">{formatCurrency(a.acquisitionCost)}</td>
                          <td className="px-4 py-3 text-sm text-right font-mono text-amber-600 hidden sm:table-cell">{formatCurrency(a.accumulatedDepreciation)}</td>
                          <td className="px-4 py-3 text-sm text-right font-mono font-semibold">{formatCurrency(a.netBookValue)}</td>
                          <td className="px-4 py-3 text-center hidden sm:table-cell">
                            <div className="inline-flex items-center gap-1.5">
                              <div className="w-16 bg-gray-200 rounded-full h-1.5">
                                <div className={`h-1.5 rounded-full ${pct >= 100 ? 'bg-amber-500' : 'bg-blue-500'}`}
                                  style={{ width: `${Math.min(100, pct)}%` }} />
                              </div>
                              <span className="text-xs text-gray-500 w-8 text-right">{pct}%</span>
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <span className={`inline-flex px-2 py-0.5 text-xs font-medium rounded-full border ${STATUS_CONFIG[a.status]?.bg || 'bg-gray-100'} ${STATUS_CONFIG[a.status]?.text || 'text-gray-600'}`}>
                              {a.status}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-center">
                            <button onClick={() => setSelectedAsset(a)}
                              className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors"
                              title="View details">
                              <Eye className="h-4 w-4" />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ═══════════════ TAB: Categories / Asset Classes ═══════════════ */}
      {activeTab === 'categories' && (
        <div className="space-y-4">
          {cats.length === 0 ? (
            <div className="text-center py-16 bg-white border rounded-lg">
              <Settings className="h-12 w-12 mx-auto mb-3 text-gray-300" />
              <h3 className="text-lg font-medium text-gray-900">No asset classes defined</h3>
              <p className="text-sm text-gray-500 mt-1">
                Asset classes define depreciation rules and GL account mapping for fixed assets.
              </p>
              <button onClick={() => setShowCategoryForm(true)}
                className="mt-4 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 inline-flex items-center">
                <Plus className="h-4 w-4 mr-1" /> Create First Asset Class
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {cats.map(cat => (
                <div key={cat.id} className="bg-white border rounded-lg shadow-sm hover:shadow transition-shadow">
                  <div className="px-5 py-4 border-b bg-gray-50 rounded-t-lg">
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="text-xs font-mono text-gray-500 uppercase">{cat.code}</span>
                        <h3 className="text-base font-semibold text-gray-900">{cat.name}</h3>
                      </div>
                      <span className="px-2 py-0.5 bg-blue-100 text-blue-700 text-xs font-medium rounded-full">
                        {cat.depreciationMethod.replace(/_/g, ' ')}
                      </span>
                    </div>
                  </div>
                  <div className="p-5 space-y-3">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-gray-500">Useful Life</span>
                      <span className="font-medium text-gray-900">{cat.usefulLifeMonths} months ({Math.round(cat.usefulLifeMonths / 12 * 10) / 10} years)</span>
                    </div>
                    {cat.depreciationRate != null && (
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-gray-500">Depreciation Rate</span>
                        <span className="font-medium">{(cat.depreciationRate * 100).toFixed(1)}%</span>
                      </div>
                    )}
                    <div className="border-t pt-3 space-y-2">
                      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">GL Account Determination</p>
                      <AccountRow label="Asset Account" code={cat.assetAccountCode} accounts={accounts} type="DR" />
                      <AccountRow label="Depr. Expense" code={cat.depreciationAccountCode} accounts={accounts} type="DR" />
                      <AccountRow label="Accum. Depr." code={cat.accumDepreciationAccountCode} accounts={accounts} type="CR" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ═══════════════ TAB: Cutover Correction ═══════════════ */}
      {activeTab === 'corrections' && (
        <div className="space-y-5">
          {/* Explanation banner */}
          <div className="bg-amber-50 border border-amber-300 rounded-lg p-5">
            <div className="flex gap-3">
              <ShieldAlert className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
              <div>
                <h3 className="text-sm font-semibold text-amber-900">Pre-ERP Assets Incorrectly Debited Cash</h3>
                <p className="text-sm text-amber-800 mt-1">
                  Assets that existed <strong>before the ERP go-live</strong> must credit <strong>Opening Balance Equity (3050)</strong>,
                  not Cash. If they were registered as <em>New Asset Purchase</em>, the system incorrectly
                  posted: <span className="font-mono text-xs bg-amber-100 px-1 rounded">DR Fixed Assets / CR Cash</span>.
                </p>
                <p className="text-sm text-amber-800 mt-1">
                  The correction posts: <span className="font-mono text-xs bg-amber-100 px-1 rounded">DR Cash (reverse) / CR Opening Balance Equity</span> — restoring
                  your cash balance and declaring the correct opening position. This is idempotent: already-corrected assets are skipped.
                </p>
              </div>
            </div>
          </div>

          {/* Controls */}
          <div className="bg-white border rounded-lg p-5">
            <h3 className="text-base font-semibold text-gray-900 mb-4 flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-amber-600" /> Cutover Correction Tool
            </h3>
            <div className="flex flex-col sm:flex-row items-start sm:items-end gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  ERP Go-Live Date (Cutover Date)
                </label>
                <DatePicker
                  value={cutoverDate}
                  onChange={(v) => { setCutoverDate(v); setCutoverPreviewData(null); setCutoverApplyResult(null); }}
                  placeholder="Cutover date"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Assets acquired <em>before</em> this date are candidates for correction.
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleCutoverPreview}
                  disabled={cutoverPreview.isPending}
                  className="inline-flex items-center px-4 py-2 bg-amber-50 text-amber-800 border border-amber-300 rounded-lg text-sm hover:bg-amber-100 disabled:opacity-50 transition-colors"
                >
                  <ShieldAlert className="h-4 w-4 mr-2" />
                  {cutoverPreview.isPending ? 'Scanning...' : 'Preview Candidates'}
                </button>
                {cutoverPreviewData && cutoverPreviewData.candidatesFound > 0 && (
                  <button
                    onClick={() => setShowApplyConfirm(true)}
                    className="inline-flex items-center px-4 py-2 bg-orange-600 text-white rounded-lg text-sm hover:bg-orange-700 transition-colors"
                  >
                    <CheckCircle className="h-4 w-4 mr-2" />
                    Apply {cutoverPreviewData.results.filter(r => r.status === 'APPLIED').length} Corrections
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Apply Confirmation */}
          {showApplyConfirm && cutoverPreviewData && (
            <div className="bg-orange-50 border border-orange-300 rounded-lg p-5">
              <div className="flex items-start gap-3">
                <AlertTriangle className="h-5 w-5 text-orange-600 shrink-0 mt-0.5" />
                <div className="flex-1">
                  <h4 className="text-sm font-semibold text-orange-900">Confirm: Post Correction Journals</h4>
                  <p className="text-sm text-orange-800 mt-1">
                    This will post <strong>{cutoverPreviewData.results.filter(r => r.status === 'APPLIED').length} correction journal entries</strong> to the GL,
                    reversing the incorrect Cash credit and crediting Opening Balance Equity (3050) for each asset.
                    This action is <strong>reversible via GL</strong> but should only be done once.
                  </p>
                  <div className="flex gap-2 mt-3">
                    <button
                      onClick={handleCutoverApply}
                      disabled={applyCutover.isPending}
                      className="px-4 py-2 bg-orange-600 text-white rounded-lg text-sm hover:bg-orange-700 disabled:opacity-50 inline-flex items-center gap-2"
                    >
                      <CheckCircle className="h-4 w-4" />
                      {applyCutover.isPending ? 'Posting GL...' : 'Confirm & Post'}
                    </button>
                    <button onClick={() => setShowApplyConfirm(false)}
                      className="px-4 py-2 border rounded-lg text-sm hover:bg-gray-50">
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Preview Results */}
          {cutoverPreviewData && (
            <CutoverResultsTable summary={cutoverPreviewData} />
          )}

          {/* Apply Results */}
          {cutoverApplyResult && (
            <CutoverResultsTable summary={cutoverApplyResult} />
          )}
        </div>
      )}

      {/* ═══════════════ TAB: Depreciation Overview ═══════════════ */}
      {activeTab === 'depreciation' && (
        <div className="space-y-4">
          <div className="bg-white border rounded-lg shadow-sm overflow-hidden">
            <div className="px-5 py-4 border-b bg-gray-50 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
              <div>
                <h3 className="text-base font-semibold text-gray-900">Active Assets — Depreciation Status</h3>
                <p className="text-xs text-gray-500">Assets eligible for periodic depreciation</p>
              </div>
              <button onClick={() => setShowDepRun(true)}
                className="inline-flex items-center px-3 py-1.5 text-sm bg-amber-50 text-amber-800 border border-amber-300 rounded-lg hover:bg-amber-100">
                <Play className="h-3.5 w-3.5 mr-1.5" /> Run Depreciation
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Asset</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase hidden sm:table-cell">Method</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Cost</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase hidden sm:table-cell">Salvage</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Accum.</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">NBV</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase hidden md:table-cell">Monthly Est.</th>
                    <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">Progress</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {assetList.filter(a => a.status === 'ACTIVE').length === 0 ? (
                    <tr><td colSpan={8} className="px-4 py-8 text-center text-gray-500 text-sm">No active assets</td></tr>
                  ) : assetList.filter(a => a.status === 'ACTIVE').map(a => {
                    const pct = depreciationPercent(a);
                    const depreciable = a.acquisitionCost - a.salvageValue;
                    const monthlyEst = a.depreciationMethod === 'STRAIGHT_LINE' && a.usefulLifeMonths > 0
                      ? depreciable / a.usefulLifeMonths
                      : a.netBookValue * (2 / a.usefulLifeMonths);
                    return (
                      <tr key={a.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3">
                          <div className="text-sm font-medium text-gray-900">{a.name}</div>
                          <div className="text-xs font-mono text-gray-400">{a.assetNumber}</div>
                        </td>
                        <td className="px-4 py-3 text-xs text-gray-500 hidden sm:table-cell">{a.depreciationMethod.replace(/_/g, ' ')}</td>
                        <td className="px-4 py-3 text-sm text-right font-mono">{formatCurrency(a.acquisitionCost)}</td>
                        <td className="px-4 py-3 text-sm text-right font-mono text-gray-500 hidden sm:table-cell">{formatCurrency(a.salvageValue)}</td>
                        <td className="px-4 py-3 text-sm text-right font-mono text-amber-600">{formatCurrency(a.accumulatedDepreciation)}</td>
                        <td className="px-4 py-3 text-sm text-right font-mono font-semibold">{formatCurrency(a.netBookValue)}</td>
                        <td className="px-4 py-3 text-sm text-right font-mono text-gray-500 hidden md:table-cell">~{formatCurrency(monthlyEst)}</td>
                        <td className="px-4 py-3 text-center">
                          <div className="inline-flex items-center gap-1.5">
                            <div className="w-16 bg-gray-200 rounded-full h-1.5">
                              <div className={`h-1.5 rounded-full ${pct >= 100 ? 'bg-amber-500' : 'bg-blue-500'}`}
                                style={{ width: `${Math.min(100, pct)}%` }} />
                            </div>
                            <span className="text-xs text-gray-500 w-8 text-right">{pct}%</span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Subcomponents ──────────────────────────────────────────────────

function SummaryCard({ icon: Icon, label, value, sub, color }: {
  icon: typeof Package; label: string; value: string; sub?: string; color: string;
}) {
  const colorMap: Record<string, string> = {
    blue: 'bg-blue-50 text-blue-700 border-blue-200',
    green: 'bg-green-50 text-green-700 border-green-200',
    amber: 'bg-amber-50 text-amber-700 border-amber-200',
    indigo: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  };
  return (
    <div className={`rounded-lg border p-4 ${colorMap[color] || colorMap.blue}`}>
      <div className="flex items-center gap-3">
        <Icon className="h-5 w-5 shrink-0" />
        <div className="min-w-0">
          <p className="text-xs font-medium opacity-80 truncate">{label}</p>
          <p className="text-lg font-bold truncate">{value}</p>
          {sub && <p className="text-xs opacity-70">{sub}</p>}
        </div>
      </div>
    </div>
  );
}

function Modal({ title, children, onClose, wide, zIndex }: {
  title: string; children: React.ReactNode; onClose: () => void; wide?: boolean; zIndex?: number;
}) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-start justify-center pt-8 px-4 overflow-y-auto" style={{ zIndex: zIndex ?? 50 }} onClick={onClose}>
      <div className={`bg-white rounded-xl shadow-xl w-full ${wide ? 'max-w-3xl' : 'max-w-lg'} mb-8`} onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="px-6 py-5">{children}</div>
      </div>
    </div>
  );
}

function FormField({ label, value, onChange, type = 'text', placeholder, required, min, step }: {
  label: string; value: string; onChange: (v: string) => void;
  type?: string; placeholder?: string; required?: boolean; min?: number; step?: string;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      {type === 'date' ? (
        <DatePicker
          value={value}
          onChange={onChange}
          placeholder={placeholder || label}
          required={required}
        />
      ) : (
        <input type={type} value={value} onChange={e => onChange(e.target.value)}
          placeholder={placeholder} required={required} min={min} step={step}
          className="w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
      )}
    </div>
  );
}

function AccountSelect({ label, value, onChange, accounts, filterType }: {
  label: string; value: string; onChange: (v: string) => void;
  accounts: ChartAccount[]; filterType: string;
}) {
  const filtered = accounts.filter(a => a.accountType === filterType);
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <select value={value} onChange={e => onChange(e.target.value)}
        className="w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
        <option value="">Select account...</option>
        {filtered.map(a => (
          <option key={a.id} value={a.accountCode}>{a.accountCode} – {a.accountName}</option>
        ))}
        {/* Always show current value even if not in filtered list */}
        {value && !filtered.find(a => a.accountCode === value) && (
          <option value={value}>{value}</option>
        )}
      </select>
    </div>
  );
}

function AccountRow({ label, code, accounts, type }: {
  label: string; code: string; accounts: ChartAccount[]; type: 'DR' | 'CR';
}) {
  const acc = accounts.find(a => a.accountCode === code);
  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between text-sm gap-1">
      <span className="text-gray-500">{label}</span>
      <span className="font-mono text-gray-800 flex items-center gap-1.5">
        <span className={`text-xs px-1 rounded ${type === 'DR' ? 'bg-red-100 text-red-600' : 'bg-green-100 text-green-600'}`}>{type}</span>
        {code}{acc ? ` – ${acc.accountName}` : ''}
      </span>
    </div>
  );
}

function DetailField({ label, value, mono, highlight }: {
  label: string; value: string; mono?: boolean; highlight?: boolean;
}) {
  return (
    <div className={`${highlight ? 'bg-blue-50 border border-blue-200 rounded-lg p-3' : ''}`}>
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">{label}</p>
      <p className={`text-sm font-medium text-gray-900 mt-0.5 ${mono ? 'font-mono' : ''} ${highlight ? 'text-blue-800 text-lg' : ''}`}>
        {value}
      </p>
    </div>
  );
}

function CutoverResultsTable({ summary }: {
  summary: CutoverSummary;
}) {
  const statusConfig: Record<CutoverCorrectionResult['status'], { bg: string; text: string; label: string }> = {
    APPLIED: { bg: 'bg-green-50 border-green-200', text: 'text-green-700', label: summary.dryRun ? 'Will Apply' : 'Applied' },
    SKIPPED_ALREADY_CORRECTED: { bg: 'bg-gray-50 border-gray-200', text: 'text-gray-500', label: 'Already Fixed' },
    SKIPPED_PROTECTED_SOURCE: { bg: 'bg-blue-50 border-blue-200', text: 'text-blue-700', label: 'Protected (AP)' },
  };
  return (
    <div className="bg-white border rounded-lg shadow-sm overflow-hidden">
      <div className="px-5 py-4 border-b bg-gray-50 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
        <div>
          <h3 className="text-base font-semibold text-gray-900">
            {summary.dryRun ? 'Preview Results' : 'Correction Results'} — cutover {summary.cutoverDate}
          </h3>
          <p className="text-xs text-gray-500 mt-0.5">
            {summary.candidatesFound} candidate(s) found &bull; {summary.applied} {summary.dryRun ? 'will be applied' : 'applied'} &bull; {summary.skipped} skipped
          </p>
        </div>
        {summary.dryRun ? (
          <span className="px-3 py-1 bg-amber-100 text-amber-800 text-xs font-semibold rounded-full border border-amber-200">
            DRY-RUN — No changes written
          </span>
        ) : (
          <span className="px-3 py-1 bg-green-100 text-green-800 text-xs font-semibold rounded-full border border-green-200">
            LIVE — GL entries posted
          </span>
        )}
      </div>
      {summary.results.length === 0 ? (
        <div className="px-5 py-8 text-center text-gray-500 text-sm">
          No candidates found before {summary.cutoverDate}. All assets are correctly registered.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Asset #</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Name</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Correction</th>
                <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">Status</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase hidden sm:table-cell">GL Ref</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {summary.results.map(r => {
                const cfg = statusConfig[r.status];
                return (
                  <tr key={r.assetId} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-sm font-mono font-medium text-blue-700">{r.assetNumber}</td>
                    <td className="px-4 py-3 text-sm text-gray-900">{r.assetName}</td>
                    <td className="px-4 py-3 text-sm text-right text-gray-500 font-mono text-xs">
                      {r.status === 'APPLIED' ? (
                        <span>DR Cash / CR 3050</span>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={`inline-flex px-2 py-0.5 text-xs font-medium rounded-full border ${cfg.bg} ${cfg.text}`}>
                        {cfg.label}
                      </span>
                      {r.reason && (
                        <div className="text-xs text-gray-400 mt-0.5 max-w-xs">{r.reason}</div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs font-mono text-gray-400 hidden sm:table-cell">
                      {r.correctionTransactionId ? r.correctionTransactionId.slice(0, 8) + '…' : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function StatusIcon({ status }: { status: string }) {
  const config = STATUS_CONFIG[status];
  if (!config) return null;
  const Icon = config.icon;
  return <Icon className={`h-4 w-4 ${config.text}`} />;
}