/**
 * Category Intelligence Report
 *
 * Filter-first, print-ready, accounting-grade category analysis.
 * Six report types: Inventory Position | Sales | Purchases |
 *                   Stock Valuation | Expiry Exposure | Full Statement
 *
 * All numbers derived from ledger/stock tables — never from UI grouping.
 */

import { useEffect, useState, useCallback, useMemo } from 'react';
import {
    Download,
    Layers,
    BarChart2,
    ShoppingCart,
    Package,
    AlertTriangle,
    FileText,
    RefreshCw,
    Search,
} from 'lucide-react';
import Layout from '../../components/Layout';
import { ResponsiveTableWrapper } from '../../components/ui/ResponsiveTableWrapper';
import { ReportBackLink } from '../../components/reports/ReportBackLink';
import { DatePicker } from '../../components/ui/date-picker';
import { formatCurrency } from '../../utils/currency';
import apiClient from '../../utils/api';
import { downloadFile } from '../../utils/download';
import {
    classifyExpiryUrgency,
    filterExpiringRowsBySearch,
} from '@shared/reports/expiringItemsSsot';

// ── Types ─────────────────────────────────────────────────────────

type CategoryIntelligenceReportType =
    | 'INVENTORY_POSITION'
    | 'SALES'
    | 'PURCHASES'
    | 'STOCK_VALUATION'
    | 'EXPIRY_EXPOSURE'
    | 'FULL_STATEMENT';

interface UomLevel {
    uomId: string;
    name: string;
    symbol: string | null;
    conversionFactor: number;
    isDefault: boolean;
}

interface CategoryInventoryPositionRow {
    productId: string;
    sku: string | null;
    productName: string;
    unitOfMeasure: string | null;
    qtyOnHand: number;
    reorderLevel: number;
    unitCost: number;
    stockValue: number;
    uomLevels: UomLevel[];
}

/**
 * Break down a base-unit quantity into higher UoM denominations.
 * e.g. qty=39, levels=[Box×100, strip×10, tablet×1]
 *      → "3 strips + 9 tablets"
 * Returns empty string when there is only one UoM level.
 */
function breakdownQty(qtyInBase: number, uomLevels: UomLevel[]): string {
    if (!uomLevels || uomLevels.length <= 1) return '';
    // Sort largest pack first, skip base (factor ≤ 1)
    const packs = [...uomLevels]
        .filter((u) => u.conversionFactor > 1)
        .sort((a, b) => b.conversionFactor - a.conversionFactor);
    if (packs.length === 0) return '';

    const base = uomLevels.find((u) => u.conversionFactor <= 1) ?? uomLevels[uomLevels.length - 1];
    const baseLabel = base.symbol || base.name;

    let remaining = Math.floor(qtyInBase);
    const parts: string[] = [];

    for (const pack of packs) {
        const factor = Math.round(pack.conversionFactor);
        const count = Math.floor(remaining / factor);
        if (count > 0) {
            parts.push(`${count} ${pack.symbol || pack.name}`);
            remaining -= count * factor;
        }
    }
    if (remaining > 0) {
        parts.push(`${remaining} ${baseLabel}`);
    }
    // If qtyInBase was an exact multiple (remainder=0) and all counts 0 for some reason, skip
    return parts.join(' + ');
}

interface CategorySalesProductRow {
    productId: string;
    sku: string | null;
    productName: string;
    totalQuantitySold: number;
    totalRevenue: number;
    totalCost: number;
    grossProfit: number;
    profitMargin: number;
    transactionCount: number;
}

interface CategoryPurchasesRow {
    productId: string;
    sku: string | null;
    productName: string;
    unitOfMeasure: string | null;
    supplierName: string;
    receivedDate: string;
    grNumber: string;
    totalQtyReceived: number;
    totalPurchaseValue: number;
    avgUnitCost: number;
}

interface CategoryExpiryExposureRow {
    productId: string;
    sku: string | null;
    productName: string;
    unitOfMeasure: string | null;
    batchNumber: string;
    expiryDate: string;
    remainingQuantity: number;
    costPrice: number;
    exposedValue: number;
    status: string;
    daysUntilExpiry: number;
}

interface CategoryIntelligenceReport {
    category: string;
    sectionType: CategoryIntelligenceReportType;
    parameters: { startDate: string; endDate: string; daysAhead: number };
    inventoryPosition: CategoryInventoryPositionRow[] | null;
    inventorySummary: { productCount: number; totalQtyOnHand: number; totalStockValue: number; belowReorderCount: number } | null;
    sales: CategorySalesProductRow[] | null;
    salesSummary: { totalRevenue: number; totalCost: number; grossProfit: number; totalTransactions: number; productCount?: number } | null;
    purchases: CategoryPurchasesRow[] | null;
    purchasesSummary: { totalQtyReceived: number; totalPurchaseValue: number; deliveryCount: number } | null;
    expiry: CategoryExpiryExposureRow[] | null;
    expirySummary: { batchCount: number; totalExposedQty: number; totalExposedValue: number; expiredCount: number; expiringSoonCount: number } | null;
    executionTimeMs: number;
}

// ── Constants ─────────────────────────────────────────────────────

const REPORT_TYPES: { value: CategoryIntelligenceReportType; label: string; icon: React.ReactNode }[] = [
    { value: 'INVENTORY_POSITION', label: 'Inventory Position', icon: <Package className="w-4 h-4" /> },
    { value: 'SALES', label: 'Sales', icon: <BarChart2 className="w-4 h-4" /> },
    { value: 'PURCHASES', label: 'Purchases', icon: <ShoppingCart className="w-4 h-4" /> },
    { value: 'STOCK_VALUATION', label: 'Stock Valuation', icon: <Layers className="w-4 h-4" /> },
    { value: 'EXPIRY_EXPOSURE', label: 'Expiry Exposure', icon: <AlertTriangle className="w-4 h-4" /> },
    { value: 'FULL_STATEMENT', label: 'Full Statement', icon: <FileText className="w-4 h-4" /> },
];

// ── Component ─────────────────────────────────────────────────────

export default function CategoryIntelligencePage() {
    const today = new Date().toISOString().slice(0, 10);
    const firstOfMonth = today.slice(0, 8) + '01';

    const [categories, setCategories] = useState<string[]>([]);
    const [selectedCategory, setSelectedCategory] = useState('');
    const [reportType, setReportType] = useState<CategoryIntelligenceReportType>('FULL_STATEMENT');
    const [startDate, setStartDate] = useState(firstOfMonth);
    const [endDate, setEndDate] = useState(today);
    const [daysAhead, setDaysAhead] = useState(90);

    const [data, setData] = useState<CategoryIntelligenceReport | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    /** Same smart find as Expiring Items (product / SKU / batch). */
    const [expirySearch, setExpirySearch] = useState('');

    const filteredExpiryRows = useMemo(() => {
        if (!data?.expiry) return [];
        return filterExpiringRowsBySearch(data.expiry, expirySearch);
    }, [data?.expiry, expirySearch]);

    // Load category list on mount
    useEffect(() => {
        apiClient
            .get('/reports/product-categories')
            .then((r) => {
                const list: string[] = r.data?.data ?? [];
                setCategories(list);
                if (list.length > 0) setSelectedCategory(list[0]);
            })
            .catch(() => {/* silent — user can still type manually */ });
    }, []);

    const generate = useCallback(() => {
        if (!selectedCategory) return;
        setLoading(true);
        setError(null);
        setData(null);
        setExpirySearch('');
        apiClient
            .get('/reports/category-intelligence', {
                params: {
                    category: selectedCategory,
                    report_type: reportType,
                    start_date: startDate,
                    end_date: endDate,
                    days_ahead: daysAhead,
                    format: 'json',
                },
            })
            .then((r) => setData(r.data?.data as CategoryIntelligenceReport))
            .catch((e) => setError(e?.response?.data?.error || e.message))
            .finally(() => setLoading(false));
    }, [selectedCategory, reportType, startDate, endDate, daysAhead]);

    const exportPdf = async () => {
        if (!selectedCategory) return;
        const qs = new URLSearchParams({
            category: selectedCategory,
            report_type: reportType,
            start_date: startDate,
            end_date: endDate,
            days_ahead: String(daysAhead),
            format: 'pdf',
        });
        try {
            await downloadFile(
                `/reports/category-intelligence?${qs.toString()}`,
                `category_intelligence_${selectedCategory.replace(/\s+/g, '_')}_${reportType}.pdf`
            );
        } catch (err) {
            alert(err instanceof Error ? err.message : 'PDF export failed');
        }
    };

    const exportCsv = () => {
        if (!data) return;
        const sections: string[] = [];

        if (data.inventoryPosition && data.inventoryPosition.length > 0) {
            sections.push('Inventory Position');
            sections.push(['Product', 'SKU', 'UoM', 'Qty on Hand', 'Reorder Level', 'Unit Cost', 'Stock Value'].join(','));
            data.inventoryPosition.forEach((r) => {
                sections.push(
                    [r.productName, r.sku ?? '', r.unitOfMeasure ?? '', r.qtyOnHand, r.reorderLevel, r.unitCost, r.stockValue].map((v) => JSON.stringify(v)).join(',')
                );
            });
            sections.push('');
        }

        if (data.sales && data.sales.length > 0) {
            sections.push('Sales Performance');
            sections.push(['Product', 'SKU', 'Qty Sold', 'Revenue', 'Cost', 'Gross Profit', 'Margin %', 'Transactions'].join(','));
            data.sales.forEach((r) => {
                sections.push(
                    [r.productName, r.sku ?? '', r.totalQuantitySold, r.totalRevenue, r.totalCost, r.grossProfit, r.profitMargin, r.transactionCount].map((v) => JSON.stringify(v)).join(',')
                );
            });
            sections.push('');
        }

        if (data.purchases && data.purchases.length > 0) {
            sections.push('Purchase History');
            sections.push(['Product', 'GR #', 'Supplier', 'Date', 'Qty Received', 'Avg Unit Cost', 'Total Value'].join(','));
            data.purchases.forEach((r) => {
                sections.push(
                    [r.productName, r.grNumber, r.supplierName, r.receivedDate, r.totalQtyReceived, r.avgUnitCost, r.totalPurchaseValue].map((v) => JSON.stringify(v)).join(',')
                );
            });
            sections.push('');
        }

        if (data.expiry && data.expiry.length > 0) {
            sections.push('Expiry Exposure');
            sections.push(['Product', 'SKU', 'Batch #', 'Expiry Date', 'Days Left', 'Qty Remaining', 'Unit Cost', 'Exposed Value'].join(','));
            filterExpiringRowsBySearch(data.expiry, expirySearch).forEach((r) => {
                sections.push(
                    [r.productName, r.sku ?? '', r.batchNumber, r.expiryDate, r.daysUntilExpiry <= 0 ? 'EXPIRED' : r.daysUntilExpiry, r.remainingQuantity, r.costPrice, r.exposedValue].map((v) => JSON.stringify(v)).join(',')
                );
            });
        }

        const csv = sections.join('\n');
        const a = Object.assign(document.createElement('a'), {
            href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })),
            download: `category_intelligence_${selectedCategory.replace(/\s+/g, '_')}_${reportType}.csv`,
        });
        a.click();
    };

    const hasData = data !== null;

    return (
        <Layout>
            <div className="p-3 sm:p-6 max-w-7xl mx-auto space-y-5">
                {/* ── Header ── */}
                <header className="space-y-3">
                    <ReportBackLink />
                    <div className="flex items-center gap-3">
                        <Layers className="w-6 h-6 text-indigo-600" />
                        <div>
                            <h1 className="text-lg sm:text-2xl font-bold">Category Intelligence</h1>
                            <p className="text-sm text-gray-500">
                                Accounting-grade analysis — Inventory · Sales · Purchases · Expiry
                            </p>
                        </div>
                    </div>
                </header>

                {/* ── Filters ── */}
                <div className="bg-white border rounded-lg p-4 space-y-4">
                    <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Filters</p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                        {/* Category */}
                        <div className="space-y-1">
                            <label className="text-sm font-medium text-gray-700">Category *</label>
                            {categories.length > 0 ? (
                                <select
                                    value={selectedCategory}
                                    onChange={(e) => setSelectedCategory(e.target.value)}
                                    className="w-full border rounded-md px-2 py-1.5 text-sm"
                                >
                                    {categories.map((c) => (
                                        <option key={c} value={c}>{c}</option>
                                    ))}
                                </select>
                            ) : (
                                <input
                                    type="text"
                                    value={selectedCategory}
                                    onChange={(e) => setSelectedCategory(e.target.value)}
                                    placeholder="Type category name"
                                    className="w-full border rounded-md px-2 py-1.5 text-sm"
                                />
                            )}
                        </div>

                        {/* Report type */}
                        <div className="space-y-1">
                            <label className="text-sm font-medium text-gray-700">Report Type</label>
                            <select
                                value={reportType}
                                onChange={(e) => setReportType(e.target.value as CategoryIntelligenceReportType)}
                                className="w-full border rounded-md px-2 py-1.5 text-sm"
                            >
                                {REPORT_TYPES.map((rt) => (
                                    <option key={rt.value} value={rt.value}>{rt.label}</option>
                                ))}
                            </select>
                        </div>

                        {/* Expiry days */}
                        {(reportType === 'EXPIRY_EXPOSURE' || reportType === 'FULL_STATEMENT') && (
                            <div className="space-y-1">
                                <label className="text-sm font-medium text-gray-700">Expiry Look-ahead (days)</label>
                                <input
                                    type="number"
                                    min={1}
                                    max={365}
                                    value={daysAhead}
                                    onChange={(e) => setDaysAhead(Number(e.target.value))}
                                    className="w-full border rounded-md px-2 py-1.5 text-sm"
                                />
                            </div>
                        )}
                    </div>

                    {/* Date range — shown for sales/purchases/full */}
                    {(reportType === 'SALES' || reportType === 'PURCHASES' || reportType === 'FULL_STATEMENT') && (
                        <div className="flex flex-wrap items-center gap-3">
                            <div className="flex items-center gap-2">
                                <label className="text-sm text-gray-600">From</label>
                                <DatePicker
                                    value={startDate}
                                    onChange={setStartDate}
                                    placeholder="From"
                                />
                            </div>
                            <div className="flex items-center gap-2">
                                <label className="text-sm text-gray-600">To</label>
                                <DatePicker
                                    value={endDate}
                                    onChange={setEndDate}
                                    placeholder="To"
                                />
                            </div>
                        </div>
                    )}

                    {/* Action buttons */}
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                        <button
                            onClick={generate}
                            disabled={!selectedCategory || loading}
                            className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-md hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        >
                            {loading ? (
                                <RefreshCw className="w-4 h-4 animate-spin" />
                            ) : (
                                <BarChart2 className="w-4 h-4" />
                            )}
                            Generate Report
                        </button>

                        {hasData && (
                            <>
                                <button
                                    onClick={exportCsv}
                                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm border border-gray-300 rounded-md bg-white hover:bg-gray-50 transition-colors"
                                >
                                    <Download className="w-4 h-4" />
                                    <span className="hidden sm:inline">Export CSV</span>
                                </button>
                                <button
                                    onClick={exportPdf}
                                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm border border-indigo-300 rounded-md bg-indigo-50 hover:bg-indigo-100 text-indigo-700 transition-colors"
                                >
                                    <Download className="w-4 h-4" />
                                    <span className="hidden sm:inline">Export PDF</span>
                                </button>
                            </>
                        )}
                    </div>
                </div>

                {/* ── Status ── */}
                {loading && (
                    <div className="flex items-center gap-2 text-sm text-gray-500">
                        <RefreshCw className="w-4 h-4 animate-spin" /> Generating report…
                    </div>
                )}
                {error && (
                    <div className="rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
                        {error}
                    </div>
                )}

                {/* ── Results ── */}
                {data && (
                    <div className="space-y-8">
                        <p className="text-xs text-gray-400 text-right">
                            Generated in {data.executionTimeMs}ms
                        </p>

                        {/* Inventory Position */}
                        {data.inventoryPosition && data.inventorySummary && (
                            <section className="space-y-4">
                                <SectionHeading
                                    icon={<Package className="w-5 h-5 text-blue-600" />}
                                    title="Inventory Position"
                                    subtitle={`As of today — ${data.inventorySummary.productCount} products`}
                                />
                                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                                    <SummaryCard label="Products" value={data.inventorySummary.productCount.toLocaleString()} />
                                    <SummaryCard label="Total Qty on Hand" value={data.inventorySummary.totalQtyOnHand.toLocaleString()} />
                                    <SummaryCard label="Total Stock Value" value={formatCurrency(data.inventorySummary.totalStockValue)} highlight />
                                    <SummaryCard
                                        label="Below Reorder Level"
                                        value={data.inventorySummary.belowReorderCount.toLocaleString()}
                                        variant={data.inventorySummary.belowReorderCount > 0 ? 'danger' : 'success'}
                                    />
                                </div>
                                <ResponsiveTableWrapper>
                                    <table className="min-w-full text-sm">
                                        <thead className="bg-gray-50">
                                            <tr>
                                                <th className="px-3 py-2 text-left font-medium">Product</th>
                                                <th className="px-3 py-2 text-left font-medium">SKU</th>
                                                <th className="px-3 py-2 text-left font-medium">UoM</th>
                                                <th className="px-3 py-2 text-right font-medium">Qty on Hand</th>
                                                <th className="px-3 py-2 text-right font-medium">Reorder Lvl</th>
                                                <th className="px-3 py-2 text-right font-medium">Unit Cost</th>
                                                <th className="px-3 py-2 text-right font-medium">Stock Value</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y">
                                            {data.inventoryPosition.length === 0 ? (
                                                <tr><td colSpan={7} className="px-3 py-6 text-center text-gray-400">No products found for this category.</td></tr>
                                            ) : data.inventoryPosition.map((r) => (
                                                <tr key={r.productId} className={`hover:bg-gray-50 ${r.qtyOnHand < r.reorderLevel ? 'bg-red-50' : ''}`}>
                                                    <td className="px-3 py-2">{r.productName}</td>
                                                    <td className="px-3 py-2 text-gray-500">{r.sku ?? '—'}</td>
                                                    <td className="px-3 py-2 text-gray-500">{r.unitOfMeasure ?? '—'}</td>
                                                    <td className="px-3 py-2 text-right">
                                                        <span>{r.qtyOnHand.toLocaleString()}</span>
                                                        {breakdownQty(r.qtyOnHand, r.uomLevels) && (
                                                            <div className="text-xs text-gray-400 font-normal leading-tight">
                                                                ({breakdownQty(r.qtyOnHand, r.uomLevels)})
                                                            </div>
                                                        )}
                                                    </td>
                                                    <td className="px-3 py-2 text-right text-gray-500">{r.reorderLevel.toLocaleString()}</td>
                                                    <td className="px-3 py-2 text-right">{formatCurrency(r.unitCost)}</td>
                                                    <td className="px-3 py-2 text-right font-medium">{formatCurrency(r.stockValue)}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                        {data.inventoryPosition.length > 0 && (
                                            <tfoot className="bg-gray-50 font-medium">
                                                <tr>
                                                    <td colSpan={2} className="px-3 py-2 text-right">Total</td>
                                                    <td className="px-3 py-2 text-right">{data.inventorySummary.totalQtyOnHand.toLocaleString()}</td>
                                                    <td />
                                                    <td />
                                                    <td className="px-3 py-2 text-right">{formatCurrency(data.inventorySummary.totalStockValue)}</td>
                                                </tr>
                                            </tfoot>
                                        )}
                                    </table>
                                </ResponsiveTableWrapper>
                            </section>
                        )}

                        {/* Sales Performance */}
                        {data.sales !== null && data.salesSummary && (
                            <section className="space-y-4">
                                <SectionHeading
                                    icon={<BarChart2 className="w-5 h-5 text-green-600" />}
                                    title="Sales Performance"
                                    subtitle={`${data.parameters.startDate} – ${data.parameters.endDate} · ${selectedCategory}`}
                                />
                                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                                    <SummaryCard label="Revenue" value={formatCurrency(data.salesSummary.totalRevenue)} highlight />
                                    <SummaryCard label="Gross Profit" value={formatCurrency(data.salesSummary.grossProfit)} variant="success" />
                                    <SummaryCard label="Products Sold" value={(data.salesSummary.productCount ?? data.sales.length).toLocaleString()} />
                                    <SummaryCard label="Sale Transactions" value={data.salesSummary.totalTransactions.toLocaleString()} />
                                </div>
                                <ResponsiveTableWrapper>
                                    <table className="min-w-full text-sm">
                                        <thead className="bg-gray-50">
                                            <tr>
                                                <th className="px-3 py-2 text-left font-medium">Product</th>
                                                <th className="px-3 py-2 text-left font-medium">SKU</th>
                                                <th className="px-3 py-2 text-right font-medium">Qty Sold</th>
                                                <th className="px-3 py-2 text-right font-medium">Revenue</th>
                                                <th className="px-3 py-2 text-right font-medium">Cost</th>
                                                <th className="px-3 py-2 text-right font-medium">Gross Profit</th>
                                                <th className="px-3 py-2 text-right font-medium">Margin %</th>
                                                <th className="px-3 py-2 text-right font-medium">Trans.</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y">
                                            {data.sales.length === 0 ? (
                                                <tr><td colSpan={8} className="px-3 py-6 text-center text-gray-400">No sales for this category in the selected period.</td></tr>
                                            ) : data.sales.map((r) => (
                                                <tr key={r.productId} className="hover:bg-gray-50">
                                                    <td className="px-3 py-2">{r.productName}</td>
                                                    <td className="px-3 py-2 text-gray-500">{r.sku ?? '—'}</td>
                                                    <td className="px-3 py-2 text-right">{r.totalQuantitySold.toLocaleString()}</td>
                                                    <td className="px-3 py-2 text-right">{formatCurrency(r.totalRevenue)}</td>
                                                    <td className="px-3 py-2 text-right">{formatCurrency(r.totalCost)}</td>
                                                    <td className="px-3 py-2 text-right font-medium text-green-700">{formatCurrency(r.grossProfit)}</td>
                                                    <td className="px-3 py-2 text-right">
                                                        <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-medium ${r.profitMargin >= 20 ? 'bg-green-100 text-green-700' : r.profitMargin >= 10 ? 'bg-yellow-100 text-yellow-700' : 'bg-red-100 text-red-700'}`}>
                                                            {r.profitMargin.toFixed(1)}%
                                                        </span>
                                                    </td>
                                                    <td className="px-3 py-2 text-right">{r.transactionCount.toLocaleString()}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                        {data.sales.length > 0 && (
                                            <tfoot className="bg-gray-50 font-medium">
                                                <tr>
                                                    <td colSpan={2} className="px-3 py-2 text-right">Total</td>
                                                    <td className="px-3 py-2 text-right">{formatCurrency(data.salesSummary.totalRevenue)}</td>
                                                    <td className="px-3 py-2 text-right">{formatCurrency(data.salesSummary.totalCost)}</td>
                                                    <td className="px-3 py-2 text-right">{formatCurrency(data.salesSummary.grossProfit)}</td>
                                                    <td className="px-3 py-2 text-right">
                                                        {data.salesSummary.totalRevenue > 0
                                                            ? `${((data.salesSummary.grossProfit / data.salesSummary.totalRevenue) * 100).toFixed(1)}%`
                                                            : '—'}
                                                    </td>
                                                    <td className="px-3 py-2 text-right">{data.salesSummary.totalTransactions.toLocaleString()}</td>
                                                </tr>
                                            </tfoot>
                                        )}
                                    </table>
                                </ResponsiveTableWrapper>
                            </section>
                        )}

                        {/* Purchases */}
                        {data.purchases !== null && data.purchasesSummary && (
                            <section className="space-y-4">
                                <SectionHeading
                                    icon={<ShoppingCart className="w-5 h-5 text-amber-600" />}
                                    title="Purchase History"
                                    subtitle={`${data.parameters.startDate} – ${data.parameters.endDate}`}
                                />
                                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                                    <SummaryCard label="Deliveries (GR)" value={data.purchasesSummary.deliveryCount.toLocaleString()} />
                                    <SummaryCard label="Total Qty Received" value={data.purchasesSummary.totalQtyReceived.toLocaleString()} />
                                    <SummaryCard label="Total Purchase Value" value={formatCurrency(data.purchasesSummary.totalPurchaseValue)} variant="warning" />
                                </div>
                                <ResponsiveTableWrapper>
                                    <table className="min-w-full text-sm">
                                        <thead className="bg-gray-50">
                                            <tr>
                                                <th className="px-3 py-2 text-left font-medium">Product</th>
                                                <th className="px-3 py-2 text-left font-medium">GR #</th>
                                                <th className="px-3 py-2 text-left font-medium">Supplier</th>
                                                <th className="px-3 py-2 text-left font-medium">Date</th>
                                                <th className="px-3 py-2 text-right font-medium">Qty Received</th>
                                                <th className="px-3 py-2 text-right font-medium">Avg Unit Cost</th>
                                                <th className="px-3 py-2 text-right font-medium">Total Value</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y">
                                            {data.purchases.length === 0 ? (
                                                <tr><td colSpan={7} className="px-3 py-6 text-center text-gray-400">No purchases found for this category in the selected period.</td></tr>
                                            ) : data.purchases.map((r, i) => (
                                                <tr key={`${r.grNumber}-${r.productId}-${i}`} className="hover:bg-gray-50">
                                                    <td className="px-3 py-2">{r.productName}</td>
                                                    <td className="px-3 py-2 font-mono text-xs text-indigo-700">{r.grNumber}</td>
                                                    <td className="px-3 py-2 text-gray-600">{r.supplierName}</td>
                                                    <td className="px-3 py-2 text-gray-600">{r.receivedDate}</td>
                                                    <td className="px-3 py-2 text-right">{r.totalQtyReceived.toLocaleString()}</td>
                                                    <td className="px-3 py-2 text-right">{formatCurrency(r.avgUnitCost)}</td>
                                                    <td className="px-3 py-2 text-right font-medium">{formatCurrency(r.totalPurchaseValue)}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                        {data.purchases.length > 0 && (
                                            <tfoot className="bg-gray-50 font-medium">
                                                <tr>
                                                    <td colSpan={4} className="px-3 py-2 text-right">Total</td>
                                                    <td className="px-3 py-2 text-right">{data.purchasesSummary.totalQtyReceived.toLocaleString()}</td>
                                                    <td />
                                                    <td className="px-3 py-2 text-right">{formatCurrency(data.purchasesSummary.totalPurchaseValue)}</td>
                                                </tr>
                                            </tfoot>
                                        )}
                                    </table>
                                </ResponsiveTableWrapper>
                            </section>
                        )}

                        {/* Expiry Exposure */}
                        {data.expiry && data.expirySummary && data.expiry.length > 0 && (
                            <section className="space-y-4" data-category-expiry-section="true">
                                <SectionHeading
                                    icon={<AlertTriangle className="w-5 h-5 text-red-600" />}
                                    title={`Expiry Exposure — next ${data.parameters.daysAhead} days`}
                                    subtitle="Same rules as Expiring Items · business date · ACTIVE on-hand · day-0 under Expired · search by product / SKU / batch"
                                />
                                <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                                    <SummaryCard label="Active Batches" value={data.expirySummary.batchCount.toLocaleString()} />
                                    <SummaryCard
                                        label="Expired (≤0 days)"
                                        value={data.expirySummary.expiredCount.toLocaleString()}
                                        variant={data.expirySummary.expiredCount > 0 ? 'danger' : 'success'}
                                    />
                                    <SummaryCard label="Total Exposed Qty" value={data.expirySummary.totalExposedQty.toLocaleString()} />
                                    <SummaryCard label="Total Exposed Value" value={formatCurrency(data.expirySummary.totalExposedValue)} variant="danger" />
                                    <SummaryCard
                                        label="Expiring ≤ 30 Days"
                                        value={data.expirySummary.expiringSoonCount.toLocaleString()}
                                        variant={data.expirySummary.expiringSoonCount > 0 ? 'warning' : 'success'}
                                    />
                                </div>
                                <div className="relative max-w-md">
                                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                                    <input
                                        type="search"
                                        value={expirySearch}
                                        onChange={(e) => setExpirySearch(e.target.value)}
                                        placeholder="Find product, SKU, or batch…"
                                        data-category-expiry-search="true"
                                        className="w-full rounded-lg border border-gray-300 py-2 pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-red-400"
                                        autoComplete="off"
                                    />
                                </div>
                                <ResponsiveTableWrapper>
                                    <table className="min-w-full text-sm">
                                        <thead className="bg-gray-50">
                                            <tr>
                                                <th className="px-3 py-2 text-left font-medium">Product</th>
                                                <th className="px-3 py-2 text-left font-medium">SKU</th>
                                                <th className="px-3 py-2 text-left font-medium">Batch #</th>
                                                <th className="px-3 py-2 text-left font-medium">Expiry Date</th>
                                                <th className="px-3 py-2 text-right font-medium">Days Left</th>
                                                <th className="px-3 py-2 text-right font-medium">Qty Remaining</th>
                                                <th className="px-3 py-2 text-right font-medium">Unit Cost</th>
                                                <th className="px-3 py-2 text-right font-medium">Exposed Value</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y">
                                            {filteredExpiryRows.length === 0 ? (
                                                <tr>
                                                    <td colSpan={8} className="px-3 py-6 text-center text-gray-400">
                                                        {expirySearch.trim()
                                                            ? `No match for “${expirySearch.trim()}”. Day-0 lots are Expired (≤0 days).`
                                                            : 'No expiring batches found for this category.'}
                                                    </td>
                                                </tr>
                                            ) : filteredExpiryRows.map((r, i) => {
                                                const band = classifyExpiryUrgency(r.daysUntilExpiry);
                                                const urgency =
                                                    band === 'expired'
                                                        ? 'bg-red-100'
                                                        : band === 'critical'
                                                          ? 'bg-rose-50'
                                                          : band === 'warning'
                                                            ? 'bg-orange-50'
                                                            : '';
                                                return (
                                                    <tr key={`${r.batchNumber}-${i}`} className={`hover:bg-gray-50 ${urgency}`}>
                                                        <td className="px-3 py-2">{r.productName}</td>
                                                        <td className="px-3 py-2 font-mono text-xs">{r.sku || '—'}</td>
                                                        <td className="px-3 py-2 font-mono text-xs">{r.batchNumber}</td>
                                                        <td className="px-3 py-2">{r.expiryDate}</td>
                                                        <td className="px-3 py-2 text-right">
                                                            {band === 'expired' ? (
                                                                <span className="inline-block px-1.5 py-0.5 rounded text-xs font-bold bg-red-200 text-red-800">
                                                                    {r.daysUntilExpiry === 0 ? '0 · EXPIRED' : 'EXPIRED'}
                                                                </span>
                                                            ) : (
                                                                <span className={`font-medium ${band === 'warning' || band === 'critical' ? 'text-orange-600' : ''}`}>
                                                                    {r.daysUntilExpiry}
                                                                </span>
                                                            )}
                                                        </td>
                                                        <td className="px-3 py-2 text-right">{r.remainingQuantity.toLocaleString()}</td>
                                                        <td className="px-3 py-2 text-right">{formatCurrency(r.costPrice)}</td>
                                                        <td className="px-3 py-2 text-right font-medium text-red-700">{formatCurrency(r.exposedValue)}</td>
                                                    </tr>
                                                );
                                            })}
                                        </tbody>
                                        {filteredExpiryRows.length > 0 && (
                                            <tfoot className="bg-gray-50 font-medium">
                                                <tr>
                                                    <td colSpan={5} className="px-3 py-2 text-right">
                                                        {expirySearch.trim()
                                                            ? `Showing ${filteredExpiryRows.length} of ${data.expiry.length}`
                                                            : 'Total'}
                                                    </td>
                                                    <td className="px-3 py-2 text-right">
                                                        {filteredExpiryRows
                                                            .reduce((s, r) => s + r.remainingQuantity, 0)
                                                            .toLocaleString()}
                                                    </td>
                                                    <td />
                                                    <td className="px-3 py-2 text-right">
                                                        {formatCurrency(
                                                            filteredExpiryRows.reduce((s, r) => s + r.exposedValue, 0),
                                                        )}
                                                    </td>
                                                </tr>
                                            </tfoot>
                                        )}
                                    </table>
                                </ResponsiveTableWrapper>
                            </section>
                        )}

                        {/* Fallback: no sections have any data */}
                        {(() => {
                            const hasAny =
                                (data.inventoryPosition && data.inventoryPosition.length > 0) ||
                                (data.sales && data.sales.length > 0) ||
                                (data.purchases && data.purchases.length > 0) ||
                                (data.expiry && data.expiry.length > 0);
                            return !hasAny ? (
                                <div className="flex flex-col items-center justify-center py-16 text-center text-gray-400 space-y-2">
                                    <FileText className="w-12 h-12 opacity-30" />
                                    <p className="font-medium text-gray-500">No data found for <span className="font-bold">{data.category}</span></p>
                                    <p className="text-sm">Try a different date range or report type.</p>
                                </div>
                            ) : null;
                        })()}
                    </div>
                )}
            </div>
        </Layout>
    );
}

// ── Sub-components ────────────────────────────────────────────────

function SectionHeading({
    icon,
    title,
    subtitle,
}: {
    icon: React.ReactNode;
    title: string;
    subtitle?: string;
}) {
    return (
        <div className="flex items-center gap-2 border-b pb-2">
            {icon}
            <div>
                <h2 className="text-base font-semibold">{title}</h2>
                {subtitle && <p className="text-xs text-gray-500">{subtitle}</p>}
            </div>
        </div>
    );
}

type SummaryCardVariant = 'default' | 'success' | 'danger' | 'warning';

function SummaryCard({
    label,
    value,
    highlight,
    variant = 'default',
}: {
    label: string;
    value: string;
    highlight?: boolean;
    variant?: SummaryCardVariant;
}) {
    const variantClasses: Record<SummaryCardVariant, string> = {
        default: highlight ? 'border-blue-200 bg-blue-50' : 'bg-white',
        success: 'border-green-200 bg-green-50',
        danger: 'border-red-200 bg-red-50',
        warning: 'border-amber-200 bg-amber-50',
    };
    return (
        <div className={`rounded-lg border p-4 ${variantClasses[variant]}`}>
            <p className="text-xs uppercase tracking-wide text-gray-500">{label}</p>
            <p className="mt-1 text-lg font-semibold truncate">{value}</p>
        </div>
    );
}
