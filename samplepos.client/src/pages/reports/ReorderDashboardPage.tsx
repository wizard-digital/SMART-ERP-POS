import { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatCurrency } from '../../utils/currency';
import { ResponsiveTableWrapper } from '../../components/ui/ResponsiveTableWrapper';
import { ReportBackLink } from '../../components/reports/ReportBackLink';

// ── Types ──
type ReorderPriority = 'URGENT' | 'HIGH' | 'MEDIUM' | 'DEAD_STOCK' | 'HEALTHY';

interface ReorderItem {
    productId: string;
    name: string;
    sku: string;
    category: string | null;
    currentStock: number;
    unitsSold30d: number;
    unitsSold7d: number;
    qtyOnOrder: number;
    dailySalesVelocity: number;
    daysUntilStockout: number | null;
    suggestedOrderQty: number;
    estimatedOrderCost: number | null;
    priority: ReorderPriority;
    reason: string;
    leadTimeDays: number;
    reorderPoint: number;
    reorderLevel: number;
    safetyStock: number;
    costPrice: number | null;
    preferredSupplier: string | null;
    preferredSupplierId: string | null;
}

const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 50;

interface DashboardSummary {
    urgentCount: number;
    highCount: number;
    mediumCount: number;
    deadStockCount: number;
    itemsToReorderCount: number;
    totalReorderCost: number;
    totalDeadStockValue: number;
}

interface DashboardData {
    summary: DashboardSummary;
    urgent: ReorderItem[];
    high: ReorderItem[];
    deadStock: ReorderItem[];
    medium: ReorderItem[];
    executionTimeMs: number;
}

type TabKey = 'urgent' | 'high' | 'deadStock' | 'medium';

const TABS: { key: TabKey; label: string; color: string; badgeColor: string }[] = [
    { key: 'urgent', label: 'Urgent', color: 'text-red-700', badgeColor: 'bg-red-100 text-red-800 border-red-200' },
    { key: 'high', label: 'High Priority', color: 'text-orange-700', badgeColor: 'bg-orange-100 text-orange-800 border-orange-200' },
    { key: 'deadStock', label: 'Dead Stock', color: 'text-gray-700', badgeColor: 'bg-gray-100 text-gray-800 border-gray-200' },
    { key: 'medium', label: 'Normal', color: 'text-yellow-700', badgeColor: 'bg-yellow-100 text-yellow-800 border-yellow-200' },
];

const PRIORITY_BADGE: Record<ReorderPriority, string> = {
    URGENT: 'bg-red-600 text-white',
    HIGH: 'bg-orange-500 text-white',
    MEDIUM: 'bg-yellow-500 text-white',
    DEAD_STOCK: 'bg-gray-500 text-white',
    HEALTHY: 'bg-green-500 text-white',
};

type SortField = 'name' | 'currentStock' | 'dailySalesVelocity' | 'daysUntilStockout' | 'suggestedOrderQty' | 'estimatedOrderCost';

function getAuthHeaders(): Record<string, string> {
    const token = localStorage.getItem('auth_token');
    return token ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' };
}

export default function ReorderDashboardPage() {
    const navigate = useNavigate();
    const [data, setData] = useState<DashboardData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [activeTab, setActiveTab] = useState<TabKey>('urgent');
    /** Array (not Set) so React reliably re-renders checkboxes when switching tabs */
    const [selectedProductIds, setSelectedProductIds] = useState<string[]>([]);
    const selectedIdSet = useMemo(() => new Set(selectedProductIds), [selectedProductIds]);
    const isSelected = useCallback(
        (productId: string) => selectedIdSet.has(productId),
        [selectedIdSet]
    );
    const [sortField, setSortField] = useState<SortField>('daysUntilStockout');
    const [sortAsc, setSortAsc] = useState(true);
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
    const [exporting, setExporting] = useState<'pdf' | 'csv' | null>(null);
    /** Find out-of-stock (qty 0) and other lines by name / SKU / category. */
    const [itemSearch, setItemSearch] = useState('');

    const fetchDashboard = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const resp = await fetch('/api/reports/reorder-dashboard', { headers: getAuthHeaders() });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const json = await resp.json();
            if (!json.success) throw new Error(json.error || 'Failed to load');
            setData(json.data);
            setItemSearch('');
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unknown error');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { fetchDashboard(); }, [fetchDashboard]);

    const fullTabItems = useMemo(() => {
        if (!data) return [];
        const q = itemSearch.trim().toLowerCase();
        const items = (data[activeTab] ?? []).filter((a) => {
            if (!q) return true;
            const hay = `${a.name} ${a.sku} ${a.category ?? ''}`.toLowerCase();
            return hay.includes(q) || q.split(/\s+/).every((t) => t && hay.includes(t));
        });
        return [...items].sort((a, b) => {
            let aVal: number | string = 0;
            let bVal: number | string = 0;
            switch (sortField) {
                case 'name': aVal = a.name.toLowerCase(); bVal = b.name.toLowerCase(); break;
                case 'currentStock': aVal = a.currentStock; bVal = b.currentStock; break;
                case 'dailySalesVelocity': aVal = a.dailySalesVelocity; bVal = b.dailySalesVelocity; break;
                case 'daysUntilStockout': aVal = a.daysUntilStockout ?? 9999; bVal = b.daysUntilStockout ?? 9999; break;
                case 'suggestedOrderQty': aVal = a.suggestedOrderQty; bVal = b.suggestedOrderQty; break;
                case 'estimatedOrderCost': aVal = a.estimatedOrderCost ?? 0; bVal = b.estimatedOrderCost ?? 0; break;
            }
            if (typeof aVal === 'string') return sortAsc ? aVal.localeCompare(bVal as string) : (bVal as string).localeCompare(aVal);
            return sortAsc ? aVal - (bVal as number) : (bVal as number) - aVal;
        });
    }, [data, activeTab, sortField, sortAsc, itemSearch]);

    const totalInTab = fullTabItems.length;
    const totalPages = Math.max(1, Math.ceil(totalInTab / pageSize));
    const safePage = Math.min(page, totalPages);

    const tabItems = useMemo(() => {
        const start = (safePage - 1) * pageSize;
        return fullTabItems.slice(start, start + pageSize);
    }, [fullTabItems, safePage, pageSize]);

    useEffect(() => {
        setPage(1);
    }, [activeTab, pageSize, itemSearch]);

    /** All items across tabs — used for cross-tab PO creation */
    const allDashboardItems = useMemo(() => {
        if (!data) return [];
        return [...data.urgent, ...data.high, ...data.medium, ...data.deadStock];
    }, [data]);

    const selectedCountInTab = useMemo(
        () => fullTabItems.filter((i) => isSelected(i.productId)).length,
        [fullTabItems, isSelected]
    );

    const selectedCountByTab = useMemo(() => {
        if (!data) return { urgent: 0, high: 0, deadStock: 0, medium: 0 };
        return {
            urgent: data.urgent.filter((i) => isSelected(i.productId)).length,
            high: data.high.filter((i) => isSelected(i.productId)).length,
            deadStock: data.deadStock.filter((i) => isSelected(i.productId)).length,
            medium: data.medium.filter((i) => isSelected(i.productId)).length,
        };
    }, [data, isSelected]);

    const handleSort = (field: SortField) => {
        if (sortField === field) { setSortAsc(!sortAsc); }
        else { setSortField(field); setSortAsc(true); }
    };

    const toggleSelect = (id: string) => {
        setSelectedProductIds((prev) =>
            prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
        );
    };

    const toggleAllOnPage = () => {
        const pageIds = tabItems.map((i) => i.productId);
        const allPageSelected = pageIds.length > 0 && pageIds.every((id) => isSelected(id));
        if (allPageSelected) {
            setSelectedProductIds((prev) => prev.filter((id) => !pageIds.includes(id)));
        } else {
            setSelectedProductIds((prev) => [...new Set([...prev, ...pageIds])]);
        }
    };

    const selectAllInTab = () => {
        const tabIds = fullTabItems.map((i) => i.productId);
        const allInTabSelected = tabIds.length > 0 && tabIds.every((id) => isSelected(id));
        setSelectedProductIds((prev) => {
            const next = new Set(prev);
            tabIds.forEach((id) => (allInTabSelected ? next.delete(id) : next.add(id)));
            return [...next];
        });
    };

    const clearSelection = () => setSelectedProductIds([]);

    /** Qty for PO/PDF — matches server effectiveReorderQty; min 1 only when building PO lines */
    const effectiveOrderQty = useCallback((item: ReorderItem): number => {
        if (item.suggestedOrderQty > 0) return item.suggestedOrderQty;
        const net = Math.ceil(item.reorderPoint - item.currentStock - item.qtyOnOrder);
        if (net > 0) return net;
        if (item.currentStock <= 0 && item.reorderLevel > 0) return Math.ceil(item.reorderLevel);
        return 0;
    }, []);

    const effectiveOrderQtyForPo = useCallback(
        (item: ReorderItem): number => {
            const q = effectiveOrderQty(item);
            return q > 0 ? q : 1;
        },
        [effectiveOrderQty]
    );

    const buildPurchaseOrderItems = useCallback(
        (productIds: string[]) => {
            const idSet = new Set(productIds);
            return allDashboardItems
                .filter((i) => idSet.has(i.productId))
                .map((i) => ({
                    productId: i.productId,
                    productName: i.name,
                    suggestedQty: effectiveOrderQty(i),
                    costPrice: i.costPrice,
                    currentStock: i.currentStock,
                    reorderPoint: i.reorderPoint,
                    preferredSupplierId: i.preferredSupplierId,
                }));
        },
        [allDashboardItems, effectiveOrderQtyForPo]
    );

    const handleExport = useCallback(
        async (format: 'pdf' | 'csv') => {
            if (selectedProductIds.length === 0) {
                alert('Select at least one product to export.');
                return;
            }
            setExporting(format);
            const date = new Date().toISOString().slice(0, 10);
            try {
                const resp = await fetch(`/api/reports/reorder-dashboard/${format}`, {
                    method: 'POST',
                    headers: getAuthHeaders(),
                    body: JSON.stringify({ productIds: selectedProductIds }),
                });
                if (!resp.ok) {
                    const errJson = await resp.json().catch(() => ({}));
                    throw new Error(errJson.error || `Export failed (${resp.status})`);
                }
                const blob = await resp.blob();
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `reorder-intelligence-${date}.${format}`;
                a.click();
                URL.revokeObjectURL(url);
            } catch (err) {
                alert(err instanceof Error ? err.message : `${format.toUpperCase()} export failed`);
            } finally {
                setExporting(null);
            }
        },
        [selectedProductIds]
    );

    const handleCreatePurchaseOrder = useCallback(() => {
        const snapshotIds = [...selectedProductIds];
        const selectedItems = buildPurchaseOrderItems(snapshotIds);
        if (selectedItems.length === 0) {
            alert('Select at least one product to create a purchase order.');
            return;
        }
        if (selectedItems.length < snapshotIds.length) {
            const found = new Set(selectedItems.map((i) => i.productId));
            const missing = snapshotIds.filter((id) => !found.has(id));
            console.warn('Reorder PO: some selected IDs were not on dashboard', missing);
        }
        navigate('/inventory/purchase-orders', {
            state: { openCreate: true, reorderItems: selectedItems },
        });
    }, [selectedProductIds, buildPurchaseOrderItems, navigate]);

    /** Tab badges always match row arrays (same source as summary after server build) */
    const tabCount = (key: TabKey): number => {
        if (!data) return 0;
        return data[key]?.length ?? 0;
    };

    const SortIcon = ({ field }: { field: SortField }) => (
        <span className="ml-1 text-xs opacity-60">
            {sortField === field ? (sortAsc ? '▲' : '▼') : '⇅'}
        </span>
    );

    // ── Loading / Error ──
    if (loading) {
        return (
            <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-4">
                <ReportBackLink />
                <div className="flex items-center justify-center min-h-[40vh]">
                    <div className="text-center">
                        <div className="animate-spin h-10 w-10 border-4 border-blue-500 border-t-transparent rounded-full mx-auto mb-4" />
                        <p className="text-gray-500">Analyzing inventory...</p>
                    </div>
                </div>
            </div>
        );
    }

    if (error) {
        return (
            <div className="max-w-3xl mx-auto mt-12 p-6 space-y-4">
                <ReportBackLink />
                <div className="bg-red-50 border border-red-200 rounded-xl text-center p-6">
                    <p className="text-red-700 font-medium">{error}</p>
                    <button onClick={fetchDashboard} className="mt-4 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700">
                        Retry
                    </button>
                </div>
            </div>
        );
    }

    if (!data) return null;
    const { summary } = data;

    return (
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-6">
            {/* ── Header ── */}
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div>
                    <ReportBackLink />
                    <h1 className="text-2xl font-bold text-gray-900">Reorder Intelligence</h1>
                    <p className="text-sm text-gray-500 mt-1">Business-driven inventory decision engine</p>
                </div>
                <div className="flex gap-2">
                    <button
                        onClick={fetchDashboard}
                        className="px-3 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
                    >
                        Refresh
                    </button>
                </div>
            </div>

            {/* ── Summary Cards ── */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <SummaryCard
                    label="Critical Restock"
                    value={tabCount('urgent')}
                    subtitle={tabCount('urgent') > 0
                        ? `${tabCount('urgent')} out-of-stock or stockout within 2 days`
                        : 'No urgent items'}
                    color="red"
                    onClick={() => setActiveTab('urgent')}
                />
                <SummaryCard
                    label="High Priority"
                    value={tabCount('high')}
                    subtitle="Fast movers at risk within lead time"
                    color="orange"
                    onClick={() => setActiveTab('high')}
                />
                <SummaryCard
                    label="Dead Stock"
                    value={tabCount('deadStock')}
                    subtitle={`${formatCurrency(summary.totalDeadStockValue)} tied up`}
                    color="gray"
                    onClick={() => setActiveTab('deadStock')}
                />
                <SummaryCard
                    label="Total Reorder Cost"
                    value={formatCurrency(summary.totalReorderCost)}
                    subtitle={`${summary.itemsToReorderCount ?? 0} items with order qty`}
                    color="blue"
                    onClick={() => setActiveTab('urgent')}
                />
            </div>

            {/* Cross-tab selection — always visible above tabs */}
            {selectedProductIds.length > 0 && (
                <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 shadow-sm">
                    <div className="text-sm text-blue-900">
                        <span className="font-semibold">{selectedProductIds.length}</span>
                        {' '}item{selectedProductIds.length !== 1 ? 's' : ''} selected across tabs
                        <span className="text-blue-700 ml-2">
                            (Urgent {selectedCountByTab.urgent} · High {selectedCountByTab.high} · Normal {selectedCountByTab.medium} · Dead {selectedCountByTab.deadStock})
                        </span>
                    </div>
                    <div className="flex gap-2 shrink-0">
                        <button
                            type="button"
                            onClick={clearSelection}
                            className="px-3 py-1.5 text-sm border border-blue-300 rounded-lg bg-white hover:bg-blue-100 text-blue-800"
                        >
                            Clear all
                        </button>
                        <button
                            type="button"
                            onClick={() => handleExport('csv')}
                            disabled={exporting !== null}
                            className="px-3 py-1.5 text-sm border border-blue-400 rounded-lg bg-white hover:bg-blue-100 text-blue-900 font-medium disabled:opacity-50"
                        >
                            {exporting === 'csv' ? 'Exporting…' : 'Export CSV'}
                        </button>
                        <button
                            type="button"
                            onClick={() => handleExport('pdf')}
                            disabled={exporting !== null}
                            className="px-3 py-1.5 text-sm border border-blue-400 rounded-lg bg-white hover:bg-blue-100 text-blue-900 font-medium disabled:opacity-50"
                        >
                            {exporting === 'pdf' ? 'Exporting…' : 'Export PDF'}
                        </button>
                        <button
                            type="button"
                            onClick={handleCreatePurchaseOrder}
                            className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium"
                        >
                            Create Purchase Order
                        </button>
                    </div>
                </div>
            )}

            {/* ── Tabs ── */}
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                <div className="border-b border-gray-200 flex overflow-x-auto">
                    {TABS.map((tab) => {
                        const count = tabCount(tab.key);
                        const isActive = activeTab === tab.key;
                        return (
                            <button
                                key={tab.key}
                                onClick={() => { setActiveTab(tab.key); }}
                                className={`flex items-center gap-2 px-5 py-3 text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${isActive
                                    ? `border-blue-600 ${tab.color} bg-blue-50/40`
                                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-50'
                                    }`}
                            >
                                {tab.label}
                                <span className={`inline-flex items-center justify-center px-2 py-0.5 text-xs font-semibold rounded-full border ${isActive ? tab.badgeColor : 'bg-gray-50 text-gray-500 border-gray-200'
                                    }`}>
                                    {count}
                                </span>
                                {!isActive && selectedCountByTab[tab.key] > 0 && (
                                    <span className="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1 text-xs font-bold rounded-full bg-blue-600 text-white" title="Items selected on this tab">
                                        {selectedCountByTab[tab.key]}
                                    </span>
                                )}
                            </button>
                        );
                    })}
                </div>

                {/* ── Bulk Actions ── */}
                <div className="bg-gray-50 border-b border-gray-200 px-4 py-2 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-3 flex-1 min-w-[12rem]">
                        <label className="relative block w-full sm:max-w-xs">
                            <span className="sr-only">Search product or SKU</span>
                            <input
                                type="search"
                                value={itemSearch}
                                onChange={(e) => setItemSearch(e.target.value)}
                                placeholder="Find product, SKU, or category (incl. stock 0)…"
                                data-reorder-search="true"
                                className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                                autoComplete="off"
                            />
                        </label>
                        <span className="text-sm text-gray-700">
                            {totalInTab === 0
                                ? itemSearch.trim()
                                    ? `No match for “${itemSearch.trim()}” in this tab`
                                    : 'No items in this tab'
                                : `Showing ${(safePage - 1) * pageSize + 1}–${Math.min(safePage * pageSize, totalInTab)} of ${totalInTab}`}
                        </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <label className="text-xs text-gray-600 flex items-center gap-1">
                            Per page
                            <select
                                value={pageSize}
                                onChange={(e) => setPageSize(Number(e.target.value))}
                                className="border border-gray-300 rounded px-2 py-1 text-sm"
                            >
                                {PAGE_SIZE_OPTIONS.map((n) => (
                                    <option key={n} value={n}>{n}</option>
                                ))}
                            </select>
                        </label>
                        {totalInTab > 0 && (
                            <button
                                type="button"
                                onClick={selectAllInTab}
                                className="px-2 py-1 text-xs border border-gray-300 rounded-lg hover:bg-white"
                            >
                                {selectedCountInTab === totalInTab && totalInTab > 0
                                    ? `Deselect all ${totalInTab} in tab`
                                    : `Select all ${totalInTab} in tab`}
                            </button>
                        )}
                        {selectedProductIds.length > 0 && (
                            <button
                                type="button"
                                onClick={clearSelection}
                                className="px-2 py-1 text-xs text-gray-600 hover:underline"
                            >
                                Clear selection
                            </button>
                        )}
                    </div>
                </div>

                {/* ── Table ── */}
                {tabItems.length === 0 ? (
                    <div className="flex items-center justify-center py-16 text-gray-400">
                        <div className="text-center">
                            <div className="text-4xl mb-3">{activeTab === 'deadStock' ? '🎉' : '✅'}</div>
                            <p className="font-medium">
                                {activeTab === 'deadStock'
                                    ? 'No dead stock — all products are moving!'
                                    : activeTab === 'urgent'
                                        ? 'No urgent items — inventory is healthy'
                                        : 'Nothing here'}
                            </p>
                        </div>
                    </div>
                ) : (
                    <div className="overflow-x-auto max-h-[min(70vh,900px)] overflow-y-auto">
                        <ResponsiveTableWrapper>
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="bg-gray-50 text-left text-gray-600 text-xs uppercase tracking-wider">
                                        <th className="pl-4 py-3 w-10">
                                            <input
                                                type="checkbox"
                                                checked={tabItems.length > 0 && tabItems.every((i) => isSelected(i.productId))}
                                                onChange={toggleAllOnPage}
                                                className="rounded border-gray-300"
                                                aria-label="Select all"
                                            />
                                        </th>
                                        <th className="px-3 py-3 cursor-pointer select-none" onClick={() => handleSort('name')}>
                                            Product<SortIcon field="name" />
                                        </th>
                                        <th className="px-3 py-3">Category</th>
                                        <th className="px-3 py-3 text-right cursor-pointer select-none" onClick={() => handleSort('currentStock')}>
                                            Stock<SortIcon field="currentStock" />
                                        </th>
                                        <th className="px-3 py-3 text-right">On PO</th>
                                        <th className="px-3 py-3 text-right">Sold 30d</th>
                                        <th className="px-3 py-3 text-right cursor-pointer select-none" onClick={() => handleSort('dailySalesVelocity')}>
                                            Daily Avg<SortIcon field="dailySalesVelocity" />
                                        </th>
                                        <th className="px-3 py-3 text-right cursor-pointer select-none" onClick={() => handleSort('daysUntilStockout')}>
                                            Days Left<SortIcon field="daysUntilStockout" />
                                        </th>
                                        <th className="px-3 py-3 text-right cursor-pointer select-none" onClick={() => handleSort('suggestedOrderQty')}>
                                            Order Qty<SortIcon field="suggestedOrderQty" />
                                        </th>
                                        <th className="px-3 py-3 text-right cursor-pointer select-none" onClick={() => handleSort('estimatedOrderCost')}>
                                            Est. Cost<SortIcon field="estimatedOrderCost" />
                                        </th>
                                        <th className="px-3 py-3">Priority</th>
                                        <th className="px-3 py-3">Reason</th>
                                        <th className="px-3 py-3">Supplier</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-gray-100">
                                    {tabItems.map((item) => (
                                        <tr key={item.productId} className={`hover:bg-gray-50 ${isSelected(item.productId) ? 'bg-blue-50/60' : ''}`}>
                                            <td className="pl-4 py-2.5">
                                                <input
                                                    type="checkbox"
                                                    checked={isSelected(item.productId)}
                                                    onChange={() => toggleSelect(item.productId)}
                                                    className="rounded border-gray-300"
                                                    aria-label={`Select ${item.name}`}
                                                />
                                            </td>
                                            <td className="px-3 py-2.5">
                                                <div className="font-medium text-gray-900 truncate max-w-[200px]" title={item.name}>
                                                    {item.name}
                                                </div>
                                                {item.sku && <div className="text-xs text-gray-400">{item.sku}</div>}
                                            </td>
                                            <td className="px-3 py-2.5 text-gray-600 truncate max-w-[120px]" title={item.category ?? ''}>
                                                {item.category || '—'}
                                            </td>
                                            <td className={`px-3 py-2.5 text-right tabular-nums font-medium ${item.currentStock <= 0 ? 'text-red-600' : 'text-gray-900'}`}>
                                                {item.currentStock}
                                            </td>
                                            <td className="px-3 py-2.5 text-right tabular-nums text-blue-700">
                                                {item.qtyOnOrder > 0 ? item.qtyOnOrder : '—'}
                                            </td>
                                            <td className="px-3 py-2.5 text-right tabular-nums text-gray-600">
                                                {item.unitsSold30d > 0 ? item.unitsSold30d : '—'}
                                            </td>
                                            <td className="px-3 py-2.5 text-right tabular-nums text-gray-700">
                                                {item.dailySalesVelocity > 0 ? item.dailySalesVelocity.toFixed(1) : '—'}
                                            </td>
                                            <td className="px-3 py-2.5 text-right tabular-nums">
                                                {item.daysUntilStockout !== null ? (
                                                    <span className={item.daysUntilStockout <= 2 ? 'text-red-600 font-bold' : item.daysUntilStockout <= 7 ? 'text-orange-600 font-medium' : 'text-gray-700'}>
                                                        {item.daysUntilStockout}d
                                                    </span>
                                                ) : (
                                                    <span className="text-gray-400">—</span>
                                                )}
                                            </td>
                                            <td className="px-3 py-2.5 text-right tabular-nums font-medium text-gray-900">
                                                {(() => {
                                                    const q = effectiveOrderQty(item);
                                                    return q > 0 ? q : '—';
                                                })()}
                                            </td>
                                            <td className="px-3 py-2.5 text-right tabular-nums text-gray-700">
                                                {(() => {
                                                    const q = effectiveOrderQty(item);
                                                    const cost = q > 0 && item.costPrice != null
                                                        ? q * item.costPrice
                                                        : item.estimatedOrderCost;
                                                    return cost != null && cost > 0
                                                        ? formatCurrency(cost)
                                                        : '—';
                                                })()}
                                            </td>
                                            <td className="px-3 py-2.5">
                                                <span className={`inline-flex px-2 py-0.5 text-xs font-semibold rounded-full ${PRIORITY_BADGE[item.priority]}`}>
                                                    {item.priority === 'DEAD_STOCK' ? 'DEAD' : item.priority}
                                                </span>
                                            </td>
                                            <td className="px-3 py-2.5 text-xs text-gray-500 max-w-[180px] truncate" title={item.reason}>
                                                {item.reason}
                                            </td>
                                            <td className="px-3 py-2.5 text-gray-600 text-xs truncate max-w-[120px]" title={item.preferredSupplier ?? ''}>
                                                {item.preferredSupplier || '—'}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </ResponsiveTableWrapper>
                    </div>
                )}

                {totalInTab > 0 && totalPages > 1 && (
                    <div className="border-t border-gray-200 px-4 py-3 flex items-center justify-between bg-gray-50">
                        <button
                            type="button"
                            disabled={safePage <= 1}
                            onClick={() => setPage((p) => Math.max(1, p - 1))}
                            className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg disabled:opacity-40 hover:bg-white"
                        >
                            Previous
                        </button>
                        <span className="text-sm text-gray-600">
                            Page {safePage} of {totalPages}
                        </span>
                        <button
                            type="button"
                            disabled={safePage >= totalPages}
                            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                            className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg disabled:opacity-40 hover:bg-white"
                        >
                            Next
                        </button>
                    </div>
                )}
            </div>

            {/* ── Footer ── */}
            <p className="text-xs text-gray-400 text-right">
                Generated in {data.executionTimeMs}ms
            </p>
        </div>
    );
}

// ── Summary Card Component ──
function SummaryCard({
    label,
    value,
    subtitle,
    color,
    onClick,
}: {
    label: string;
    value: number | string;
    subtitle: string;
    color: 'red' | 'orange' | 'gray' | 'blue';
    onClick?: () => void;
}) {
    const colorMap = {
        red: 'border-red-200 bg-red-50',
        orange: 'border-orange-200 bg-orange-50',
        gray: 'border-gray-200 bg-gray-50',
        blue: 'border-blue-200 bg-blue-50',
    };
    const valueColor = {
        red: 'text-red-700',
        orange: 'text-orange-700',
        gray: 'text-gray-700',
        blue: 'text-blue-700',
    };

    const Wrapper = onClick ? 'button' : 'div';
    return (
        <Wrapper
            type={onClick ? 'button' : undefined}
            onClick={onClick}
            className={`rounded-xl border p-4 text-left w-full ${colorMap[color]} ${onClick ? 'hover:ring-2 hover:ring-blue-300 cursor-pointer transition-shadow' : ''}`}
        >
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">{label}</p>
            <p className={`text-2xl font-bold mt-1 ${valueColor[color]}`}>{value}</p>
            <p className="text-xs text-gray-500 mt-1 line-clamp-2">{subtitle}</p>
        </Wrapper>
    );
}
