import { useMemo } from 'react';
import Decimal from 'decimal.js';
import Layout from '../components/Layout';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useHasPermission } from '../authorization/useAuthorization';
import { shouldRestrictSalesToOwnUser } from '@shared/authorization/salesPolicy';
import { formatCurrency } from '../utils/currency';
import { BUSINESS_TIMEZONE, getBusinessDate, addDaysToDateString } from '../utils/businessDate';
import {
  useSalesSummary,
  useTopSellingProducts,
  useSalesSummaryByDate,
  useSales,
} from '../hooks/useApi';
import { useNeedingReorder, useStockLevels } from '../hooks/useInventory';
import ExpiryAlertsWidget from '../components/ExpiryAlertsWidget';
import { SalesTargetProgressStrip } from '../components/sales/SalesTargetProgressStrip';
import { isCashierRole, resolveCashierHomePath } from '../utils/cashierLockdown';
import {
  isRestaurantWaiterProfile,
  WAITER_HOME_PATH,
} from '../utils/restaurantWaiterLockdown';
import { useRestaurantEnabled, useRestaurantModeForRouting } from '../hooks/useRestaurantEnabled';
import { RestaurantModeBoot } from '../components/auth/RestaurantModeBoot';
import { shouldHideRetailPos } from '../utils/retailPosVisibility';
import {
  DASHBOARD_KPI_CARD_CLASS,
  DASHBOARD_KPI_GRID_CLASS,
  DASHBOARD_KPI_ICON_CLASS,
  DASHBOARD_KPI_ICON_WRAP_CLASS,
  DASHBOARD_KPI_LABEL_CLASS,
  DASHBOARD_KPI_SUB_CLASS,
  DASHBOARD_KPI_VALUE_CLASS,
  DASHBOARD_PAGE_FRAME_CLASS,
} from '../lib/adaptiveDashboard';
import {
  ShoppingCart,
  UtensilsCrossed,
  Package,
  BarChart3,
  Users,
  Truck,
  ClipboardList,
  PackageCheck,
  DollarSign,
  ArrowUpDown,
  FileText,
  TrendingUp,
  AlertTriangle,
  ArrowRight,
  ShieldCheck,
  ScrollText,
  Clock,
  CreditCard,
  Banknote,
  Smartphone,
  Receipt,
  Wallet,
} from 'lucide-react';

// ─── Dashboard-specific interfaces ──────────────────────────────
interface PaymentMethodBreakdown {
  paymentMethod: string;
  totalAmount: number;
  count: number;
}

interface SummaryData {
  totalAmount?: number;
  totalSales?: number;
  totalProfit?: number;
  byPaymentMethod?: PaymentMethodBreakdown[];
}

interface TopProductEntry {
  product_id?: string;
  productId?: string;
  product_name?: string;
  productName?: string;
  total_revenue?: number | string;
  totalRevenue?: number | string;
  total_quantity?: number | string;
  totalQuantity?: number | string;
  sale_count?: number | string;
  saleCount?: number | string;
}

interface DailyTrendEntry {
  period?: string;
  date?: string;
  total_revenue?: number | string;
  totalRevenue?: number | string;
  transaction_count?: number | string;
  transactionCount?: number | string;
  total_profit?: number | string;
  totalProfit?: number | string;
  avg_transaction_value?: number | string;
  avgTransactionValue?: number | string;
}

interface RecentSaleEntry {
  id: string;
  sale_number?: string;
  saleNumber?: string;
  customer_name?: string;
  customerName?: string;
  total_amount?: number | string;
  totalAmount?: number | string;
  payment_method?: string;
  paymentMethod?: string;
  sale_date?: string;
  saleDate?: string;
}

interface StockLevelEntry {
  quantity_on_hand?: number | string;
  reorder_level?: number | string;
}

interface ReorderEntry {
  productId?: string;
  productName?: string;
  product_name?: string;
  name?: string;
  currentStock?: number | string;
  reorderLevel?: number | string;
}

interface StockLevelResponse {
  data?: StockLevelEntry[];
}

interface ReorderResponse {
  data?: ReorderEntry[];
}

// ─── Helper: safe numeric coercion (guards NaN/undefined/null) ───
function safeNum(v: unknown): number {
  if (v == null) return 0;
  const n = typeof v === 'string' ? parseFloat(v) : Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ─── Helper: Today's date as YYYY-MM-DD ──────────────────────────
function todayStr(): string {
  return getBusinessDate();
}

// ─── Helper: 7 days ago ──────────────────────────────────────────
function weekAgoStr(): string {
  return addDaysToDateString(getBusinessDate(), -7);
}

// ─── Mini sparkline bar chart (pure CSS) ─────────────────────────
function MiniBarChart({ data, color = 'bg-blue-500' }: { data: number[]; color?: string }) {
  if (!data.length) return null;
  const max = Math.max(...data, 1);
  return (
    <div className="flex items-end gap-[2px] h-6 sm:h-10">
      {data.map((v, i) => (
        <div
          key={i}
          className={`${color} rounded-t min-w-[4px] flex-1 transition-all`}
          style={{ height: `${Math.max((v / max) * 100, 4)}%` }}
          title={formatCurrency(v, true, 0)}
        />
      ))}
    </div>
  );
}

// ─── Payment method icon ─────────────────────────────────────────
function PaymentMethodIcon({ method }: { method: string }) {
  switch (method) {
    case 'CASH':
      return <Banknote className="w-4 h-4 text-green-600" />;
    case 'CARD':
      return <CreditCard className="w-4 h-4 text-blue-600" />;
    case 'MOBILE_MONEY':
      return <Smartphone className="w-4 h-4 text-purple-600" />;
    case 'CREDIT':
      return <Receipt className="w-4 h-4 text-orange-600" />;
    case 'DEPOSIT':
      return <Wallet className="w-4 h-4 text-teal-600" />;
    case 'BANK_TRANSFER':
      return <ArrowUpDown className="w-4 h-4 text-indigo-600" />;
    default:
      return <DollarSign className="w-4 h-4 text-gray-600" />;
  }
}

export default function Dashboard() {
  const { user, permissions } = useAuth();
  const { restaurantEnabled, isReady } = useRestaurantModeForRouting();
  if (!isReady) {
    return <RestaurantModeBoot />;
  }
  if (isCashierRole(user?.role)) {
    return <Navigate to={resolveCashierHomePath(restaurantEnabled)} replace />;
  }
  if (
    isRestaurantWaiterProfile({
      role: user?.role,
      permissions,
      restaurantEnabled,
    })
  ) {
    return <Navigate to={WAITER_HOME_PATH} replace />;
  }
  return <DashboardContent />;
}

function DashboardContent() {
  const navigate = useNavigate();
  const { user, permissions } = useAuth();
  const { data: restaurantEnabled = false } = useRestaurantEnabled();
  const isScopedSalesUser = useMemo(
    () => shouldRestrictSalesToOwnUser(permissions, user?.role),
    [permissions, user?.role],
  );
  const canAccessDataManagement = useHasPermission('admin.delete');
  const canAccessAuditTrail = useHasPermission('admin.read');
  const today = todayStr();
  const weekAgo = weekAgoStr();

  // ─── Data hooks ──────────────────────────────────────────────────
  const { data: todaySummary, isLoading: todayLoading } = useSalesSummary(today, today);
  const { data: weekSummary, isLoading: weekLoading } = useSalesSummary(weekAgo, today);
  const { data: allTimeSummary } = useSalesSummary();
  const { data: topProducts, isLoading: topLoading } = useTopSellingProducts(5, { startDate: weekAgo, endDate: today });
  const { data: dailyTrend } = useSalesSummaryByDate('day', { startDate: weekAgo, endDate: today });
  const { data: recentSalesData } = useSales(1, 5);
  const { data: reorderData } = useNeedingReorder();
  const { data: stockLevelsData } = useStockLevels();

  // ─── Parse summary data ──────────────────────────────────────────
  // useApiQuery hooks (useSalesSummary, useTopSellingProducts, etc.) select response.data.data by default
  // useInventory hooks return response.data = { success, data }
  // useSales has custom select returning { data, pagination }
  const todayData = todaySummary as SummaryData | undefined;
  const weekData = weekSummary as SummaryData | undefined;
  const allTimeData = allTimeSummary as SummaryData | undefined;
  const topItems: TopProductEntry[] = Array.isArray(topProducts) ? topProducts : [];
  const dailyData: DailyTrendEntry[] = Array.isArray(dailyTrend) ? dailyTrend : [];
  const recentSales: RecentSaleEntry[] = (recentSalesData?.data ?? []) as RecentSaleEntry[];
  const reorderItems: ReorderEntry[] = (reorderData as ReorderResponse)?.data ?? (Array.isArray(reorderData) ? reorderData : []);

  // Low stock count from stock levels
  const lowStockCount = useMemo(() => {
    const raw = stockLevelsData as StockLevelResponse | StockLevelEntry[] | undefined;
    const items: StockLevelEntry[] = (raw as StockLevelResponse)?.data ?? (Array.isArray(raw) ? raw : []);
    return items.filter(
      (item: StockLevelEntry) =>
        item.quantity_on_hand != null &&
        item.reorder_level != null &&
        Number(item.quantity_on_hand) <= Number(item.reorder_level)
    ).length;
  }, [stockLevelsData]);

  // Revenue spark data (last 7 days, ordered chronologically)
  const sparkData = useMemo(() => {
    if (!dailyData?.length) return [];
    return [...dailyData]
      .reverse()
      .map((d: DailyTrendEntry) => safeNum(d.total_revenue ?? d.totalRevenue));
  }, [dailyData]);

  // Today profit margin
  const todayMargin = todayData?.totalAmount
    ? new Decimal(todayData.totalProfit ?? 0).dividedBy(todayData.totalAmount).times(100).toNumber()
    : 0;

  const isLoading = todayLoading || weekLoading;

  // ─── Greeting ────────────────────────────────────────────────────
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  // ─── Quick‑access modules ────────────────────────────────────────
  const sellModule = shouldHideRetailPos(restaurantEnabled)
    ? {
        name: 'Restaurant',
        path: '/restaurant',
        icon: UtensilsCrossed,
        color: 'bg-amber-600',
        hoverColor: 'hover:bg-amber-700',
      }
    : {
        name: 'Point of Sale',
        path: '/pos',
        icon: ShoppingCart,
        color: 'bg-blue-500',
        hoverColor: 'hover:bg-blue-600',
      };

  const modules = isScopedSalesUser
    ? [
      sellModule,
      { name: 'My Sales', path: '/sales', icon: DollarSign, color: 'bg-orange-500', hoverColor: 'hover:bg-orange-600' },
      { name: 'Customers', path: '/customers', icon: Users, color: 'bg-amber-500', hoverColor: 'hover:bg-amber-600' },
    ]
    : [
      sellModule,
      { name: 'Products', path: '/inventory/products', icon: Package, color: 'bg-emerald-500', hoverColor: 'hover:bg-emerald-600' },
      { name: 'Inventory', path: '/inventory', icon: BarChart3, color: 'bg-purple-500', hoverColor: 'hover:bg-purple-600' },
      { name: 'Customers', path: '/customers', icon: Users, color: 'bg-amber-500', hoverColor: 'hover:bg-amber-600' },
      { name: 'Suppliers', path: '/suppliers', icon: Truck, color: 'bg-indigo-500', hoverColor: 'hover:bg-indigo-600' },
      { name: 'Purchase Orders', path: '/inventory/purchase-orders', icon: ClipboardList, color: 'bg-pink-500', hoverColor: 'hover:bg-pink-600' },
      { name: 'Goods Receipts', path: '/inventory/goods-receipts', icon: PackageCheck, color: 'bg-teal-500', hoverColor: 'hover:bg-teal-600' },
      { name: 'Sales', path: '/sales', icon: DollarSign, color: 'bg-orange-500', hoverColor: 'hover:bg-orange-600' },
      { name: 'Stock Movements', path: '/inventory/stock-movements', icon: ArrowUpDown, color: 'bg-red-500', hoverColor: 'hover:bg-red-600' },
      { name: 'Reports', path: '/reports', icon: FileText, color: 'bg-cyan-500', hoverColor: 'hover:bg-cyan-600' },
    ];

  const adminModules = [
    ...(canAccessDataManagement
      ? [{ name: 'Data Management', path: '/admin/data-management', icon: ShieldCheck, color: 'bg-gray-700', hoverColor: 'hover:bg-gray-800' }]
      : []),
    ...(canAccessAuditTrail
      ? [{ name: 'Audit Trail', path: '/admin/audit-trail', icon: ScrollText, color: 'bg-slate-600', hoverColor: 'hover:bg-slate-700' }]
      : []),
  ];

  const allModules = [...modules, ...adminModules];

  return (
    <Layout>
      <div className={DASHBOARD_PAGE_FRAME_CLASS}>
        {/* ─── Header ───────────────────────────────────────────── */}
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-2">
          <div className="min-w-0">
            <h1 className="text-xl sm:text-3xl font-bold text-gray-900 tracking-tight">
              {greeting}, {user?.fullName?.split(' ')[0] || 'there'}
            </h1>
            <p className="text-xs sm:text-sm text-gray-500 mt-0.5 sm:mt-1">
              {isScopedSalesUser
                ? "Here\u0027s your activity today"
                : "Here\u0027s what\u0027s happening with your business today"}
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs sm:text-sm text-gray-500">
            <Clock className="w-3.5 h-3.5 sm:w-4 sm:h-4 shrink-0" />
            {new Date().toLocaleDateString('en-UG', {
              weekday: 'long',
              year: 'numeric',
              month: 'long',
              day: 'numeric',
              timeZone: BUSINESS_TIMEZONE,
            })}
          </div>
        </div>

        {/* Active target progress — reuse Sales strip (server SSOT) */}
        <SalesTargetProgressStrip />

        {/* ─── KPI Cards — 2-up on phone (never full-bleed towers) ─ */}
        <div className={DASHBOARD_KPI_GRID_CLASS} data-dashboard-kpis="true">
          {/* Today's Revenue */}
          <div className={DASHBOARD_KPI_CARD_CLASS}>
            <div className="flex items-start justify-between gap-2 mb-1.5 sm:mb-3">
              <p className={DASHBOARD_KPI_LABEL_CLASS}>Today&apos;s Revenue</p>
              <div className={`${DASHBOARD_KPI_ICON_WRAP_CLASS} bg-blue-50`}>
                <DollarSign className={`${DASHBOARD_KPI_ICON_CLASS} text-blue-600`} />
              </div>
            </div>
            {isLoading ? (
              <div className="h-6 sm:h-8 bg-gray-100 rounded animate-pulse" />
            ) : (
              <>
                <p className={`${DASHBOARD_KPI_VALUE_CLASS} text-gray-900`}>
                  {formatCurrency(todayData?.totalAmount || 0, true, 0)}
                </p>
                <p className={DASHBOARD_KPI_SUB_CLASS}>
                  {todayData?.totalSales || 0} transaction
                  {(todayData?.totalSales || 0) !== 1 ? 's' : ''}
                </p>
              </>
            )}
          </div>

          {/* Today's Profit — hidden for cashiers */}
          {!isScopedSalesUser && (
            <div className={DASHBOARD_KPI_CARD_CLASS}>
              <div className="flex items-start justify-between gap-2 mb-1.5 sm:mb-3">
                <p className={DASHBOARD_KPI_LABEL_CLASS}>Today&apos;s Profit</p>
                <div className={`${DASHBOARD_KPI_ICON_WRAP_CLASS} bg-green-50`}>
                  <TrendingUp className={`${DASHBOARD_KPI_ICON_CLASS} text-green-600`} />
                </div>
              </div>
              {isLoading ? (
                <div className="h-6 sm:h-8 bg-gray-100 rounded animate-pulse" />
              ) : (
                <>
                  <p
                    className={`${DASHBOARD_KPI_VALUE_CLASS} ${(todayData?.totalProfit || 0) >= 0 ? 'text-green-600' : 'text-red-600'}`}
                  >
                    {formatCurrency(todayData?.totalProfit || 0, true, 0)}
                  </p>
                  <p className={DASHBOARD_KPI_SUB_CLASS}>{todayMargin.toFixed(1)}% margin</p>
                </>
              )}
            </div>
          )}

          {/* This Week */}
          <div className={DASHBOARD_KPI_CARD_CLASS}>
            <div className="flex items-start justify-between gap-2 mb-1.5 sm:mb-3">
              <p className={DASHBOARD_KPI_LABEL_CLASS}>This Week</p>
              <div className={`${DASHBOARD_KPI_ICON_WRAP_CLASS} bg-purple-50`}>
                <BarChart3 className={`${DASHBOARD_KPI_ICON_CLASS} text-purple-600`} />
              </div>
            </div>
            {weekLoading ? (
              <div className="h-6 sm:h-8 bg-gray-100 rounded animate-pulse" />
            ) : (
              <>
                <p className={`${DASHBOARD_KPI_VALUE_CLASS} text-gray-900`}>
                  {formatCurrency(weekData?.totalAmount || 0, true, 0)}
                </p>
                <div className="mt-1.5 sm:mt-2">
                  <MiniBarChart data={sparkData} color="bg-purple-400" />
                </div>
              </>
            )}
          </div>

          {/* Alerts */}
          <div className={DASHBOARD_KPI_CARD_CLASS}>
            <div className="flex items-start justify-between gap-2 mb-1.5 sm:mb-3">
              <p className={DASHBOARD_KPI_LABEL_CLASS}>Alerts</p>
              <div
                className={`${DASHBOARD_KPI_ICON_WRAP_CLASS} ${lowStockCount + reorderItems.length > 0 ? 'bg-red-50' : 'bg-gray-50'}`}
              >
                <AlertTriangle
                  className={`${DASHBOARD_KPI_ICON_CLASS} ${lowStockCount + reorderItems.length > 0 ? 'text-red-500' : 'text-gray-400'}`}
                />
              </div>
            </div>
            <div className="space-y-0.5 sm:space-y-1">
              <button
                type="button"
                onClick={() => navigate('/inventory/stock-levels')}
                className="flex items-center justify-between w-full text-left group min-h-[1.75rem]"
              >
                <span className="text-xs sm:text-sm text-gray-600 group-hover:text-blue-600">Low stock</span>
                <span className={`text-xs sm:text-sm font-bold ${lowStockCount > 0 ? 'text-red-600' : 'text-green-600'}`}>
                  {lowStockCount}
                </span>
              </button>
              <button
                type="button"
                onClick={() => navigate('/inventory/stock-levels')}
                className="flex items-center justify-between w-full text-left group min-h-[1.75rem]"
              >
                <span className="text-xs sm:text-sm text-gray-600 group-hover:text-blue-600">Reorder</span>
                <span
                  className={`text-xs sm:text-sm font-bold ${reorderItems.length > 0 ? 'text-orange-600' : 'text-green-600'}`}
                >
                  {reorderItems.length}
                </span>
              </button>
            </div>
          </div>
        </div>

        {/* ─── Mid section: Recent Sales + Top Products ──────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
          {/* Recent Sales */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <h2 className="text-base font-semibold text-gray-900">Recent Sales</h2>
              <button
                onClick={() => navigate('/sales')}
                className="text-sm text-blue-600 hover:text-blue-700 flex items-center gap-1"
              >
                View all <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="divide-y divide-gray-50">
              {recentSales.length === 0 ? (
                <p className="px-5 py-8 text-center text-sm text-gray-400">No recent sales</p>
              ) : (
                recentSales.map((sale: RecentSaleEntry) => (
                  <div
                    key={sale.id || sale.sale_number}
                    className="flex items-center justify-between px-5 py-3 hover:bg-gray-50 cursor-pointer transition-colors"
                    onClick={() =>
                      navigate(`/sales/${sale.sale_number || sale.saleNumber || sale.id}`)
                    }
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <PaymentMethodIcon
                        method={sale.payment_method || sale.paymentMethod || ''}
                      />
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-900 truncate">
                          {sale.sale_number || sale.saleNumber || `#${sale.id?.slice(0, 8)}`}
                        </p>
                        <p className="text-xs text-gray-400">
                          {sale.customer_name || sale.customerName || 'Walk-in'}
                        </p>
                      </div>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <p className="text-sm font-semibold text-gray-900">
                        {formatCurrency(
                          safeNum(sale.total_amount ?? sale.totalAmount),
                          true,
                          0
                        )}
                      </p>
                      <p className="text-xs text-gray-400">
                        {sale.sale_date || sale.saleDate || ''}
                      </p>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Top Selling Products (This Week) */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <h2 className="text-base font-semibold text-gray-900">Top Products (7d)</h2>
              <button
                onClick={() => navigate('/reports')}
                className="text-sm text-blue-600 hover:text-blue-700 flex items-center gap-1"
              >
                Reports <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="divide-y divide-gray-50">
              {topLoading ? (
                <div className="px-5 py-8 space-y-3">
                  {[...Array(5)].map((_, i) => (
                    <div key={i} className="h-6 bg-gray-100 rounded animate-pulse" />
                  ))}
                </div>
              ) : topItems.length === 0 ? (
                <p className="px-5 py-8 text-center text-sm text-gray-400">
                  No sales data this week
                </p>
              ) : (
                topItems.map((product: TopProductEntry, i: number) => {
                  const maxRev = Math.max(
                    ...topItems.map((p: TopProductEntry) =>
                      safeNum(p.total_revenue ?? p.totalRevenue)
                    ),
                    1
                  );
                  const rev = safeNum(product.total_revenue ?? product.totalRevenue);
                  const pct = (rev / maxRev) * 100;
                  return (
                    <div key={product.product_id || product.productId || i} className="px-5 py-3">
                      <div className="flex items-center justify-between mb-1">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-xs font-bold text-gray-400 w-5">#{i + 1}</span>
                          <span className="text-sm font-medium text-gray-900 truncate">
                            {product.product_name || product.productName}
                          </span>
                        </div>
                        <span className="text-sm font-semibold text-gray-700 flex-shrink-0 ml-2">
                          {formatCurrency(rev, true, 0)}
                        </span>
                      </div>
                      <div className="ml-7">
                        <div className="w-full bg-gray-100 rounded-full h-1.5">
                          <div
                            className="bg-blue-500 h-1.5 rounded-full transition-all"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <p className="text-xs text-gray-400 mt-0.5">
                          {safeNum(product.total_quantity ?? product.totalQuantity)} units
                          &middot; {safeNum(product.sale_count ?? product.saleCount)} sales
                        </p>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>

        {/* ─── Payment Breakdown + 7-Day Trend ───────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Payment Method Breakdown (Today) */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
            <h2 className="text-base font-semibold text-gray-900 mb-4">
              Today by Payment Method
            </h2>
            {(todayData?.byPaymentMethod?.length ?? 0) > 0 ? (
              <div className="space-y-3">
                {todayData!.byPaymentMethod!.map((pm: PaymentMethodBreakdown) => {
                  const total = todayData!.totalAmount || 1;
                  const pct = new Decimal(pm.totalAmount || 0).dividedBy(total).times(100).toNumber();
                  return (
                    <div key={pm.paymentMethod} className="flex items-center gap-3">
                      <PaymentMethodIcon method={pm.paymentMethod} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-gray-600 capitalize">
                            {(pm.paymentMethod || '').replace('_', ' ').toLowerCase()}
                          </span>
                          <span className="font-medium text-gray-900">
                            {formatCurrency(pm.totalAmount || 0, true, 0)}
                          </span>
                        </div>
                        <div className="w-full bg-gray-100 rounded-full h-1.5 mt-1">
                          <div
                            className="bg-blue-500 h-1.5 rounded-full"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>
                      <span className="text-xs text-gray-400 w-10 text-right">{pm.count}</span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-sm text-gray-400 text-center py-4">No sales today yet</p>
            )}
          </div>

          {/* Daily Trend Table */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5 lg:col-span-2">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold text-gray-900">7-Day Trend</h2>
              <button
                onClick={() => navigate('/reports')}
                className="text-xs text-blue-600 hover:text-blue-700 flex items-center gap-1"
              >
                Full reports <ArrowRight className="w-3 h-3" />
              </button>
            </div>
            {dailyData.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-gray-500 border-b border-gray-100">
                      <th className="pb-2 font-medium">Date</th>
                      <th className="pb-2 font-medium text-right">Sales</th>
                      <th className="pb-2 font-medium text-right">Revenue</th>
                      {!isScopedSalesUser && <th className="pb-2 font-medium text-right">Profit</th>}
                      <th className="pb-2 font-medium text-right hidden sm:table-cell">Avg</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {dailyData.map((day: DailyTrendEntry, i: number) => (
                      <tr key={i} className="hover:bg-gray-50">
                        <td className="py-2 text-gray-700">{day.period}</td>
                        <td className="py-2 text-right text-gray-600">
                          {day.transaction_count || day.transactionCount}
                        </td>
                        <td className="py-2 text-right font-medium text-gray-900">
                          {formatCurrency(
                            safeNum(day.total_revenue ?? day.totalRevenue),
                            true,
                            0
                          )}
                        </td>
                        {!isScopedSalesUser && (
                          <td
                            className={`py-2 text-right font-medium ${safeNum(day.total_profit ?? day.totalProfit) >= 0 ? 'text-green-600' : 'text-red-600'}`}
                          >
                            {formatCurrency(
                              safeNum(day.total_profit ?? day.totalProfit),
                              true,
                              0
                            )}
                          </td>
                        )}
                        <td className="py-2 text-right text-gray-500 hidden sm:table-cell">
                          {formatCurrency(
                            safeNum(day.avg_transaction_value ?? day.avgTransactionValue),
                            true,
                            0
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-gray-400 text-center py-4">No data available</p>
            )}
          </div>
        </div>

        {/* ─── Expiry Alerts ────────────────────────────────────── */}
        <ExpiryAlertsWidget maxAlerts={5} />

        {/* ─── All-Time Summary ──────────────────────────────────── */}
        {allTimeData && (
          <div className="bg-gradient-to-r from-gray-50 to-gray-100 rounded-xl border border-gray-200 p-5">
            <h2 className="text-base font-semibold text-gray-700 mb-3">
              {isScopedSalesUser ? 'My All-Time Summary' : 'All-Time Summary'}
            </h2>
            <div className={`grid grid-cols-2 ${isScopedSalesUser ? '' : 'sm:grid-cols-4'} gap-4`}>
              <div>
                <p className="text-xs text-gray-500 uppercase tracking-wide">Total Sales</p>
                <p className="text-lg font-bold text-gray-900">
                  {(allTimeData?.totalSales || 0).toLocaleString()}
                </p>
              </div>
              <div>
                <p className="text-xs text-gray-500 uppercase tracking-wide">Total Revenue</p>
                <p className="text-lg font-bold text-gray-900">
                  {formatCurrency(allTimeData?.totalAmount || 0, true, 0)}
                </p>
              </div>
              {!isScopedSalesUser && (
                <>
                  <div>
                    <p className="text-xs text-gray-500 uppercase tracking-wide">Total Profit</p>
                    <p
                      className={`text-lg font-bold ${(allTimeData?.totalProfit || 0) >= 0 ? 'text-green-600' : 'text-red-600'}`}
                    >
                      {formatCurrency(allTimeData?.totalProfit || 0, true, 0)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-500 uppercase tracking-wide">Avg Margin</p>
                    <p className="text-lg font-bold text-gray-900">
                      {allTimeData?.totalAmount
                        ? new Decimal(allTimeData.totalProfit ?? 0).dividedBy(allTimeData.totalAmount).times(100).toFixed(1)
                        : '0.0'}
                      %
                    </p>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {/* ─── Quick Navigation ─────────────────────────────────── */}
        <div>
          <h2 className="text-base font-semibold text-gray-900 mb-3">Quick Access</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3">
            {allModules.map((mod) => {
              const Icon = mod.icon;
              return (
                <button
                  key={mod.path}
                  onClick={() => navigate(mod.path)}
                  className={`${mod.color} ${mod.hoverColor} text-white p-4 rounded-xl shadow-sm hover:shadow-md transition-all duration-200 text-left group`}
                >
                  <Icon className="w-6 h-6 mb-2 opacity-90 group-hover:opacity-100" />
                  <p className="text-sm font-medium leading-tight">{mod.name}</p>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </Layout>
  );
}
