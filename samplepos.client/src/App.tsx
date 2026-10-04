import { lazy, Suspense, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation, useSearchParams } from 'react-router-dom';
import { Toaster, toast } from 'react-hot-toast';
import { Toaster as SonnerToaster } from 'sonner';
import { useAuth } from './hooks/useAuth';
import { ProtectedRoute } from './components/auth/ProtectedRoute';
import { SalesTargetsFeatureGate } from './components/sales/SalesTargetsFeatureGate';
import { CashierPathGuard } from './components/auth/CashierPathGuard';
import ErrorBoundary from './components/ErrorBoundary';
import NetworkStatusBanner from './components/NetworkStatusBanner';
import BusinessDateSync from './components/BusinessDateSync';
import { isCashierRole, resolveCashierHomePath, resolvePostLoginPath } from './utils/cashierLockdown';
import OfflineAutoSync from './components/OfflineAutoSync';
import { useRestaurantModeForRouting } from './hooks/useRestaurantEnabled';
import { RestaurantModeBoot } from './components/auth/RestaurantModeBoot';
import { appendNotificationQuery } from './lib/notificationNavigation';
import NotificationDeepLink from './components/notifications/NotificationDeepLink';

// Layouts stay static (small, shared across routes)
import Layout from './components/Layout';
import InventoryLayout from './components/InventoryLayout';
import { StoreNetworkStoresRedirect } from './components/inventory/StoreNetworkLayout';
import { StoreNetworkSection } from './components/inventory/StoreNetworkSection';
import AccountingLayout from './components/AccountingLayout';

/**
 * Lazy-load wrapper that auto-reloads the page on stale chunk errors.
 * After a deployment, Vite's hashed filenames change. If the browser still
 * has the old index cached, it tries to fetch removed chunk files → 404.
 * This wrapper catches that and does a single hard reload.
 */
function lazyWithRetry(factory: () => Promise<{ default: React.ComponentType }>) {
  return lazy(() =>
    factory().catch((err: unknown) => {
      const alreadyReloaded = sessionStorage.getItem('chunk_reload');
      if (!alreadyReloaded) {
        sessionStorage.setItem('chunk_reload', '1');
        window.location.reload();
        // Return a never-resolving promise so React doesn't render the error
        return new Promise(() => { });
      }
      // Already reloaded once — let ErrorBoundary handle it
      sessionStorage.removeItem('chunk_reload');
      throw err;
    })
  );
}

// Clear the reload flag on successful page load
if (sessionStorage.getItem('chunk_reload')) {
  sessionStorage.removeItem('chunk_reload');
}

// Lazy-loaded pages — each becomes its own chunk
const LoginPage = lazyWithRetry(() => import('./pages/LoginPage'));
const Dashboard = lazyWithRetry(() => import('./pages/Dashboard'));
const POSPage = lazyWithRetry(() => import('./pages/pos/POSPage'));
const CustomersPage = lazyWithRetry(() => import('./pages/CustomersPage'));
const CustomerDetailPage = lazyWithRetry(() => import('./pages/customers/CustomerDetailPage'));
const SuppliersPage = lazyWithRetry(() => import('./pages/SuppliersPage'));
const SalesPage = lazyWithRetry(() => import('./pages/SalesPage'));
const SalesTargetsPage = lazyWithRetry(() => import('./pages/sales/SalesTargetsPage'));
const SalesTargetDetailPage = lazyWithRetry(() => import('./pages/sales/SalesTargetDetailPage'));
const SettingsPage = lazyWithRetry(() => import('./pages/settings/SettingsPage'));
const SecuritySettingsPage = lazyWithRetry(() => import('./pages/settings/SecuritySettingsPage'));
const NotificationsSettingsPage = lazyWithRetry(() => import('./pages/settings/NotificationsSettingsPage'));
const ReportsPage = lazyWithRetry(() => import('./pages/ReportsPage'));
const ExpenseReportsPage = lazyWithRetry(() => import('./pages/reports/ExpenseReportsPage'));
const OrdersReportPage = lazyWithRetry(() => import('./pages/reports/OrdersReportPage'));
const ReorderDashboardPage = lazyWithRetry(() => import('./pages/reports/ReorderDashboardPage'));
const BusinessPerformancePage = lazyWithRetry(() => import('./pages/reports/BusinessPerformancePage'));
const InventoryValuationReportPage = lazyWithRetry(() => import('./pages/reports/inventory/InventoryValuationReportPage'));
const InventoryReconciliationReportPage = lazyWithRetry(() => import('./pages/reports/inventory/InventoryReconciliationReportPage'));
const InventoryAnalyticsReportPage = lazyWithRetry(() => import('./pages/reports/inventory/InventoryAnalyticsReportPage'));
const InventoryMarginsReportPage = lazyWithRetry(() => import('./pages/reports/inventory/InventoryMarginsReportPage'));
const CategoryIntelligencePage = lazyWithRetry(() => import('./pages/reports/CategoryIntelligencePage'));
const AdminDataManagementPage = lazyWithRetry(() => import('./pages/AdminDataManagementPage'));
const InventoryCommandCenterPage = lazyWithRetry(() => import('./pages/inventory/InventoryCommandCenterPage'));
const StockLevelsPage = lazyWithRetry(() => import('./pages/inventory/StockLevelsPage'));
const ProductsPage = lazyWithRetry(() => import('./pages/inventory/ProductsPage'));
const StockMovementsPage = lazyWithRetry(() => import('./pages/inventory/StockMovementsPage'));
const PurchaseOrdersPage = lazyWithRetry(() => import('./pages/inventory/PurchaseOrdersPage'));
const GoodsReceiptsPage = lazyWithRetry(() => import('./pages/inventory/GoodsReceiptsPage'));
const SupplierReturnsPage = lazyWithRetry(() => import('./pages/inventory/SupplierReturnsPage'));
const ReceivingWorkbench = lazyWithRetry(() => import('./pages/inventory/ReceivingWorkbench'));
const UomManagementPage = lazyWithRetry(() => import('./pages/inventory/UomManagementPage'));
const BatchManagementPage = lazyWithRetry(() => import('./pages/inventory/BatchManagementPage'));
const InventoryAdjustmentsPage = lazyWithRetry(() => import('./pages/inventory/InventoryAdjustmentsPage'));
const QuarantineWorkqueuePage = lazyWithRetry(() => import('./pages/inventory/QuarantineWorkqueuePage'));
const AuditLogPage = lazyWithRetry(() => import('./pages/AuditLogPage'));
const RoleManagementPage = lazyWithRetry(() => import('./pages/admin/RoleManagementPage'));
const QuotationsPage = lazyWithRetry(() => import('./pages/quotations/QuotationsPage'));
const NewQuotationPage = lazyWithRetry(() => import('./pages/quotations/NewQuotationPage'));
const EditQuotationPage = lazyWithRetry(() => import('./pages/quotations/EditQuotationPage'));
const QuoteDetailPage = lazyWithRetry(() => import('./pages/quotations/QuoteDetailPage'));
const QuoteConversionPage = lazyWithRetry(() => import('./pages/quotations/QuoteConversionPage'));
const ChartOfAccountsPage = lazyWithRetry(() => import('./pages/accounting/ChartOfAccountsPage'));
const GeneralLedgerPage = lazyWithRetry(() => import('./pages/accounting/GeneralLedgerPage'));
const TrialBalancePage = lazyWithRetry(() => import('./pages/accounting/TrialBalancePage'));
const FinancialStatementsPage = lazyWithRetry(() => import('./pages/accounting/FinancialStatementsPage'));
const BalanceSheetPage = lazyWithRetry(() => import('./pages/accounting/BalanceSheetPage'));
const AccountingIntegrationDashboard = lazyWithRetry(() => import('./pages/accounting/AccountingIntegrationDashboard'));
const ExpensesPage = lazyWithRetry(() => import('./pages/accounting/ExpensesPage'));
const ExpenseCategoriesPage = lazyWithRetry(() => import('./pages/accounting/ExpenseCategoriesPage'));
const SupplierPaymentsPage = lazyWithRetry(() => import('./pages/accounting/SupplierPaymentsPage'));
const CustomerPaymentsPage = lazyWithRetry(() => import('./pages/accounting/CustomerPaymentsPage'));
const CreditDebitNotesPage = lazyWithRetry(() => import('./pages/accounting/CreditDebitNotesPage'));
const ProfitLossPage = lazyWithRetry(() => import('./pages/ProfitLossPage'));
const ReconciliationPage = lazyWithRetry(() => import('./pages/ReconciliationPage'));
const SupplierReconciliationPage = lazyWithRetry(() => import('./pages/reconciliation/SupplierReconciliationPage'));
const CustomerReconciliationPage = lazyWithRetry(() => import('./pages/reconciliation/CustomerReconciliationPage'));
const InventoryReconciliationPage = lazyWithRetry(() => import('./pages/reconciliation/InventoryReconciliationPage'));
const BankReconciliationPage = lazyWithRetry(() => import('./pages/reconciliation/BankReconciliationPage'));
const GeneralLedgerReviewPage = lazyWithRetry(() => import('./pages/reconciliation/GeneralLedgerReviewPage'));
const PeriodCloseWorkspacePage = lazyWithRetry(() => import('./pages/reconciliation/PeriodCloseWorkspacePage'));
const FinancialDiagnosticsPage = lazyWithRetry(() => import('./pages/FinancialDiagnosticsPage'));
const JournalEntriesPage = lazyWithRetry(() => import('./pages/JournalEntriesPage'));
const PeriodManagementPage = lazyWithRetry(() => import('./pages/PeriodManagementPage'));
const BankingPage = lazyWithRetry(() => import('./pages/accounting/BankingPage'));
const CostCentersPage = lazyWithRetry(() => import('./pages/accounting/CostCentersPage'));
const GrirClearingPage = lazyWithRetry(() => import('./pages/accounting/GrirClearingPage'));
const DunningPage = lazyWithRetry(() => import('./pages/accounting/DunningPage'));
const WithholdingTaxPage = lazyWithRetry(() => import('./pages/accounting/WithholdingTaxPage'));
const VatRemittancePage = lazyWithRetry(() => import('./pages/accounting/VatRemittancePage'));
const BadDebtWriteoffPage = lazyWithRetry(() => import('./pages/accounting/BadDebtWriteoffPage'));
const AssetAccountingPage = lazyWithRetry(() => import('./pages/accounting/AssetAccountingPage'));
const OrdersQueuePage = lazyWithRetry(() => import('./pages/orders/OrdersQueuePage'));
const OrderPaymentPage = lazyWithRetry(() => import('./pages/orders/OrderPaymentPage'));
const RestaurantPosPage = lazyWithRetry(() => import('./pages/restaurant/RestaurantPosPage'));
const KitchenDisplayPage = lazyWithRetry(() => import('./pages/restaurant/KitchenDisplayPage'));
const RestaurantStationsPage = lazyWithRetry(() => import('./pages/restaurant/RestaurantStationsPage'));
const RestaurantPrinterDiagnosticsPage = lazyWithRetry(
  () => import('./pages/restaurant/RestaurantPrinterDiagnosticsPage'),
);
const RestaurantRecipesPage = lazyWithRetry(() => import('./pages/restaurant/RestaurantRecipesPage'));
const KitchenHubPage = lazyWithRetry(() => import('./pages/kitchen/KitchenHubPage'));
const KitchenProductionPage = lazyWithRetry(() => import('./pages/kitchen/KitchenProductionPage'));
const KitchenBuffetSessionsPage = lazyWithRetry(
  () => import('./pages/kitchen/KitchenBuffetSessionsPage'),
);
const KitchenWastePage = lazyWithRetry(() => import('./pages/kitchen/KitchenWastePage'));
const KitchenAnalyticsPage = lazyWithRetry(() => import('./pages/kitchen/KitchenAnalyticsPage'));
const RestaurantOrderTagsPage = lazyWithRetry(
  () => import('./pages/restaurant/RestaurantOrderTagsPage'),
);
const JeApprovalPage = lazyWithRetry(() => import('./pages/accounting/JeApprovalPage'));
const PaymentProgramPage = lazyWithRetry(() => import('./pages/accounting/PaymentProgramPage'));
const MultiCurrencyPage = lazyWithRetry(() => import('./pages/accounting/MultiCurrencyPage'));
const FiscalYearClosePage = lazyWithRetry(() => import('./pages/accounting/FiscalYearClosePage'));
const GLReconciliationPage = lazyWithRetry(() => import('./pages/accounting/GLReconciliationPage'));
const TaxEnginePage = lazyWithRetry(() => import('./pages/accounting/TaxEnginePage'));
const CurrencyRevaluationPage = lazyWithRetry(() => import('./pages/accounting/CurrencyRevaluationPage'));
const GLIntegrityPage = lazyWithRetry(() => import('./pages/accounting/GLIntegrityPage'));
const AgedBalancePage = lazyWithRetry(() => import('./pages/accounting/AgedBalancePage'));
const TaxComplianceReportsPage = lazyWithRetry(
  () => import('./pages/reports/TaxComplianceReportsPage'),
);
const LiquidityMovementsReportPage = lazyWithRetry(
  () => import('./pages/reports/LiquidityMovementsReportPage'),
);
const SalesAnalysisReportPage = lazyWithRetry(
  () => import('./pages/reports/SalesAnalysisReportPage'),
);
const DeliveryPage = lazyWithRetry(() => import('./pages/delivery/DeliveryPage'));
const DeliveryNotesPage = lazyWithRetry(() => import('./pages/delivery-notes/DeliveryNotesPage'));
const DistSalesOrderListPage = lazyWithRetry(() => import('./pages/distribution/DistSalesOrderListPage'));
const DistSalesOrderCreatePage = lazyWithRetry(() => import('./pages/distribution/DistSalesOrderCreatePage'));
const DistSalesOrderDetailPage = lazyWithRetry(() => import('./pages/distribution/DistSalesOrderDetailPage'));
const DistSalesOrderEditPage = lazyWithRetry(() => import('./pages/distribution/DistSalesOrderEditPage'));
const DistInvoiceListPage = lazyWithRetry(() => import('./pages/distribution/DistInvoiceListPage'));
const DistClearingPage = lazyWithRetry(() => import('./pages/distribution/DistClearingPage'));
const ImportPage = lazyWithRetry(() => import('./pages/ImportPage'));
const BarcodeLookupPage = lazyWithRetry(() => import('./pages/inventory/BarcodeLookupPage'));
const StoreManagementPage = lazyWithRetry(() => import('./pages/inventory/StoreManagementPage'));
const StoreNetworkLocationsPage = lazyWithRetry(() => import('./pages/inventory/StoreNetworkLocationsPage'));
const StoreNetworkSettingsPage = lazyWithRetry(() => import('./pages/inventory/StoreNetworkSettingsPage'));
const StoreNetworkReportPage = lazyWithRetry(() => import('./pages/reports/inventory/StoreNetworkReportPage'));
const StoreAssortmentMatrixPage = lazyWithRetry(() => import('./pages/inventory/StoreAssortmentMatrixPage'));
const StockCountsPage = lazyWithRetry(() => import('./pages/inventory/StockCountsPage'));
const StoreDashboardPage = lazyWithRetry(() => import('./pages/inventory/StoreDashboardPage'));
const StoreTransfersPage = lazyWithRetry(() => import('./pages/inventory/StoreTransfersPage'));
const TransferApprovalsPage = lazyWithRetry(() => import('./pages/inventory/TransferApprovalsPage'));
const CRMPage = lazyWithRetry(() => import('./pages/crm/CRMPage'));
const HRPage = lazyWithRetry(() => import('./pages/hr/HRPage'));
const PriceGroupsPage = lazyWithRetry(() => import('./pages/pricing/PriceGroupsPage'));
const PriceRulesPage = lazyWithRetry(() => import('./pages/pricing/PriceRulesPage'));
const CategoriesPage = lazyWithRetry(() => import('./pages/pricing/CategoriesPage'));
const PricePreviewPage = lazyWithRetry(() => import('./pages/pricing/PricePreviewPage'));
const QuickLoginScreen = lazyWithRetry(() => import('./pages/pos/QuickLoginScreen'));
const MyQuickLoginPage = lazyWithRetry(() => import('./pages/settings/MyQuickLoginPage'));
const DownPaymentClearingPage = lazyWithRetry(() => import('./pages/accounting/DownPaymentClearingPage'));

// Platform (Super Admin) imports
import { PlatformAuthProvider, usePlatformAuth } from './contexts/PlatformAuthContext';
const PlatformLoginPage = lazyWithRetry(() => import('./pages/platform/PlatformLoginPage'));
import PlatformLayout from './components/platform/PlatformLayout';
const PlatformDashboardPage = lazyWithRetry(() => import('./pages/platform/PlatformDashboardPage'));
const TenantsPage = lazyWithRetry(() => import('./pages/platform/TenantsPage'));
const AdminsPage = lazyWithRetry(() => import('./pages/platform/AdminsPage'));
const PlatformHealthPage = lazyWithRetry(() => import('./pages/platform/PlatformHealthPage'));

// Redirect home: cashiers → POS / Restaurant FOH, waiters → Restaurant FOH, else dashboard
function HomeRedirect() {
  const { user, permissions } = useAuth();
  const { restaurantEnabled, isReady } = useRestaurantModeForRouting();
  const [params] = useSearchParams();
  const nid = params.get('nid');
  if (!isReady) {
    return <RestaurantModeBoot />;
  }
  if (isCashierRole(user?.role)) {
    return <Navigate to={appendNotificationQuery(resolveCashierHomePath(restaurantEnabled), nid)} replace />;
  }
  return (
    <Navigate
      to={appendNotificationQuery(
        resolvePostLoginPath({
          role: user?.role,
          permissions,
          restaurantEnabled,
        }),
        nid,
      )}
      replace
    />
  );
}

function UnauthenticatedRedirect() {
  const location = useLocation();
  return <Navigate to="/login" replace state={{ from: location }} />;
}

// Platform route guard
function PlatformProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = usePlatformAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-100">
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-indigo-600" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/platform/login" replace />;
  }

  return <>{children}</>;
}

/** Tenant POS/ERP services — skip on platform admin (uses platform_token, not tenant auth). */
function TenantAppServices() {
  const { pathname } = useLocation();
  if (pathname.startsWith('/platform')) return null;
  return (
    <>
      <BusinessDateSync />
      <OfflineAutoSync />
      <NotificationDeepLink />
    </>
  );
}

function App() {
  const { isAuthenticated, isLoading } = useAuth();

  // Global 403 Forbidden listener — ownership copy keeps its own title (FOH SSOT)
  useEffect(() => {
    const handler = (e: Event) => {
      const msg =
        (e as CustomEvent<string>).detail ||
        'You do not have permission to perform this action. Contact an administrator if you need access.';
      const ownership = /another waiter|belongs to another|edit others|reassign/i.test(msg);
      toast.error(
        () => (
          <div>
            <div style={{ fontWeight: 600 }}>{ownership ? 'Table in use' : 'Access denied'}</div>
            <div style={{ fontSize: 13, marginTop: 4, opacity: 0.9 }}>{msg}</div>
          </div>
        ),
        { duration: 6000, icon: '🔒', id: ownership ? 'app-forbidden-ownership' : 'app-forbidden' }
      );
    };
    window.addEventListener('app:forbidden', handler);
    return () => window.removeEventListener('app:forbidden', handler);
  }, []);

  // SSOT: all other API failures (400/404/409/5xx/network) — clear title + message, never status codes
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ title?: string; message?: string; toastId?: string }>).detail;
      const title = detail?.title || 'Something went wrong';
      const message = detail?.message || 'Please try again.';
      const id = detail?.toastId || 'app-api-error';
      toast.error(
        () => (
          <div>
            <div style={{ fontWeight: 600 }}>{title}</div>
            <div style={{ fontSize: 13, marginTop: 4, opacity: 0.9 }}>{message}</div>
          </div>
        ),
        { duration: 7000, icon: '⚠️', id }
      );
    };
    window.addEventListener('app:api-error', handler);
    return () => window.removeEventListener('app:api-error', handler);
  }, []);

  // Session expiry warning — visible toast when idle timeout is about to fire
  useEffect(() => {
    const handler = () => {
      toast('Session expiring soon — move your mouse or press any key to stay logged in', {
        duration: 55000,
        icon: '⏳',
        style: { background: '#fef3c7', border: '1px solid #f59e0b', fontWeight: 500 },
      });
    };
    window.addEventListener('app:session-warning', handler);
    return () => window.removeEventListener('app:session-warning', handler);
  }, []);

  // PWA update banner — fires when the service worker activates a new version
  useEffect(() => {
    const handler = () => {
      toast(
        (t) => (
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span>New version available</span>
            <button
              onClick={() => { toast.dismiss(t.id); window.location.reload(); }}
              style={{ padding: '2px 10px', background: '#3b82f6', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontWeight: 600 }}
            >
              Update
            </button>
          </span>
        ),
        { duration: Infinity, icon: '🔄', id: 'sw-update' }
      );
    };
    window.addEventListener('sw-updated', handler);
    return () => window.removeEventListener('sw-updated', handler);
  }, []);

  // Show loading screen while authentication is being initialized
  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
          <p className="text-gray-600">Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <PlatformAuthProvider>
      <BrowserRouter>
        <NetworkStatusBanner />
        <TenantAppServices />
        <Toaster
          position="top-right"
          toastOptions={{
            duration: 3000,
            style: {
              background: '#363636',
              color: '#fff',
            },
            success: {
              duration: 2000,
              iconTheme: {
                primary: '#10b981',
                secondary: '#fff',
              },
            },
            error: {
              duration: 4000,
              iconTheme: {
                primary: '#ef4444',
                secondary: '#fff',
              },
            },
          }}
        />
        <SonnerToaster position="top-right" richColors />
        <ErrorBoundary section="Application">
          <Suspense fallback={
            <div className="min-h-screen flex items-center justify-center bg-gray-50">
              <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-600" />
            </div>
          }>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route path="/quick-login" element={<QuickLoginScreen />} />

              {/* Platform (Super Admin) Routes — own auth context */}
              <Route path="/platform/login" element={<PlatformLoginPage />} />
              <Route
                path="/platform"
                element={
                  <PlatformProtectedRoute>
                    <PlatformLayout />
                  </PlatformProtectedRoute>
                }
              >
                <Route index element={<PlatformDashboardPage />} />
                <Route path="tenants" element={<TenantsPage />} />
                <Route path="admins" element={<AdminsPage />} />
                <Route path="health" element={<PlatformHealthPage />} />
              </Route>

              {isAuthenticated ? (
                <Route element={<CashierPathGuard />}>
                  {/* Dashboard - All authenticated users */}
                  <Route
                    path="/dashboard"
                    element={
                      <ProtectedRoute>
                        <Dashboard />
                      </ProtectedRoute>
                    }
                  />

                  {/* POS */}
                  <Route
                    path="/pos"
                    element={
                      <ProtectedRoute requiredPermissions={['pos.read', 'pos.create']} requiredFeature="pos">
                        <POSPage />
                      </ProtectedRoute>
                    }
                  />

                  {/* Restaurant POS (optional module — flag checked inside page + nav) */}
                  <Route
                    path="/restaurant"
                    element={
                      <ProtectedRoute
                        requiredPermissions={['restaurant.read', 'restaurant.order']}
                        requiredFeature="pos"
                      >
                        <RestaurantPosPage />
                      </ProtectedRoute>
                    }
                  />

                  <Route
                    path="/restaurant/kitchen"
                    element={
                      <ProtectedRoute
                        requiredPermissions={['restaurant.kitchen']}
                        requiredFeature="pos"
                      >
                        <KitchenDisplayPage />
                      </ProtectedRoute>
                    }
                  />

                  <Route
                    path="/restaurant/stations"
                    element={
                      <ProtectedRoute
                        requiredPermissions={['restaurant.manage']}
                        requiredFeature="pos"
                      >
                        <RestaurantStationsPage />
                      </ProtectedRoute>
                    }
                  />

                  <Route
                    path="/restaurant/printer-diagnostics"
                    element={
                      <ProtectedRoute
                        requiredPermissions={['restaurant.manage']}
                        requiredFeature="pos"
                      >
                        <RestaurantPrinterDiagnosticsPage />
                      </ProtectedRoute>
                    }
                  />

                  <Route
                    path="/restaurant/order-tags"
                    element={
                      <ProtectedRoute
                        requiredPermissions={['restaurant.manage']}
                        requiredFeature="pos"
                      >
                        <RestaurantOrderTagsPage />
                      </ProtectedRoute>
                    }
                  />

                  <Route
                    path="/restaurant/recipes"
                    element={
                      <ProtectedRoute
                        requiredPermissions={['restaurant.manage']}
                        requiredFeature="pos"
                      >
                        <RestaurantRecipesPage />
                      </ProtectedRoute>
                    }
                  />

                  <Route
                    path="/kitchen"
                    element={
                      <ProtectedRoute
                        requiredPermissions={[
                          'kitchen.production.read',
                          'kitchen.production.create',
                          'kitchen.production.post',
                        ]}
                        requiredFeature="pos"
                      >
                        <KitchenHubPage />
                      </ProtectedRoute>
                    }
                  />

                  <Route
                    path="/kitchen/production"
                    element={
                      <ProtectedRoute
                        requiredPermissions={[
                          'kitchen.production.read',
                          'kitchen.production.create',
                          'kitchen.production.post',
                        ]}
                        requiredFeature="pos"
                      >
                        <KitchenProductionPage />
                      </ProtectedRoute>
                    }
                  />

                  <Route
                    path="/kitchen/buffet-sessions"
                    element={
                      <ProtectedRoute
                        requiredPermissions={[
                          'kitchen.production.read',
                          'kitchen.production.create',
                          'kitchen.production.post',
                        ]}
                        requiredFeature="pos"
                      >
                        <KitchenBuffetSessionsPage />
                      </ProtectedRoute>
                    }
                  />

                  <Route
                    path="/kitchen/waste"
                    element={
                      <ProtectedRoute
                        requiredPermissions={[
                          'kitchen.production.read',
                          'kitchen.production.create',
                          'kitchen.production.post',
                        ]}
                        requiredFeature="pos"
                      >
                        <KitchenWastePage />
                      </ProtectedRoute>
                    }
                  />

                  <Route
                    path="/kitchen/analytics"
                    element={
                      <ProtectedRoute
                        requiredPermissions={['kitchen.production.read']}
                        requiredFeature="pos"
                      >
                        <KitchenAnalyticsPage />
                      </ProtectedRoute>
                    }
                  />

                  {/* Orders Queue */}
                  <Route
                    path="/orders-queue"
                    element={
                      <ProtectedRoute requiredPermissions={['orders.read', 'orders.pay']} requiredFeature="pos">
                        <OrdersQueuePage />
                      </ProtectedRoute>
                    }
                  />

                  {/* Order Payment */}
                  <Route
                    path="/orders/:id/pay"
                    element={
                      <ProtectedRoute requiredPermissions={['orders.pay', 'restaurant.pay']} requiredFeature="pos">
                        <OrderPaymentPage />
                      </ProtectedRoute>
                    }
                  />

                  {/* Sales */}
                  <Route
                    path="/sales"
                    element={
                      <ProtectedRoute requiredPermissions={['sales.read']} requiredFeature="pos">
                        <SalesPage />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/sales/targets"
                    element={
                      <ProtectedRoute
                        requiredPermissions={['targets.read', 'targets.manage', 'targets.approve']}
                        requiredFeature="pos"
                      >
                        <SalesTargetsFeatureGate>
                          <SalesTargetsPage />
                        </SalesTargetsFeatureGate>
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/sales/targets/:id"
                    element={
                      <ProtectedRoute
                        requiredPermissions={['targets.read', 'targets.manage', 'targets.approve']}
                        requiredFeature="pos"
                      >
                        <SalesTargetsFeatureGate>
                          <SalesTargetDetailPage />
                        </SalesTargetsFeatureGate>
                      </ProtectedRoute>
                    }
                  />

                  {/* Customers */}
                  <Route
                    path="/customers"
                    element={
                      <ProtectedRoute requiredPermissions={['customers.read']} requiredFeature="customers">
                        <CustomersPage />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/customers/:id"
                    element={
                      <ProtectedRoute requiredPermissions={['customers.read']} requiredFeature="customers">
                        <CustomerDetailPage />
                      </ProtectedRoute>
                    }
                  />

                  {/* Suppliers */}
                  <Route
                    path="/suppliers"
                    element={
                      <ProtectedRoute requiredPermissions={['suppliers.read']} requiredFeature="purchase_orders">
                        <SuppliersPage />
                      </ProtectedRoute>
                    }
                  />

                  {/* Quotations */}
                  <Route
                    path="/quotations"
                    element={
                      <ProtectedRoute requiredPermissions={['quotations.read']} requiredFeature="invoices">
                        <QuotationsPage />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/quotations/new"
                    element={
                      <ProtectedRoute requiredPermissions={['quotations.create']} requiredFeature="invoices">
                        <NewQuotationPage />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/quotations/:quoteNumber/edit"
                    element={
                      <ProtectedRoute requiredPermissions={['quotations.update']} requiredFeature="invoices">
                        <EditQuotationPage />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/quotations/:quoteNumber/convert"
                    element={
                      <ProtectedRoute requiredPermissions={['sales.create']} requiredFeature="invoices">
                        <QuoteConversionPage />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/quotations/:quoteNumber"
                    element={
                      <ProtectedRoute requiredPermissions={['quotations.read']} requiredFeature="invoices">
                        <QuoteDetailPage />
                      </ProtectedRoute>
                    }
                  />

                  {/* CRM */}
                  <Route
                    path="/crm"
                    element={
                      <ProtectedRoute requiredPermissions={['crm.read']} requiredFeature="crm">
                        <CRMPage />
                      </ProtectedRoute>
                    }
                  />

                  {/* HR & Payroll */}
                  <Route
                    path="/hr"
                    element={
                      <ProtectedRoute requiredPermissions={['hr.read']} requiredFeature="hr">
                        <HRPage />
                      </ProtectedRoute>
                    }
                  />

                  {/* Pricing - ADMIN, MANAGER */}
                  <Route
                    path="/pricing"
                    element={<Navigate to="/pricing/price-groups" replace />}
                  />
                  <Route
                    path="/pricing/price-groups"
                    element={
                      <ProtectedRoute requiredPermissions={['settings.read']} requiredFeature="pricing">
                        <PriceGroupsPage />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/pricing/rules"
                    element={
                      <ProtectedRoute requiredPermissions={['settings.read']} requiredFeature="pricing">
                        <PriceRulesPage />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/pricing/categories"
                    element={
                      <ProtectedRoute requiredPermissions={['settings.read']} requiredFeature="pricing">
                        <CategoriesPage />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/pricing/preview"
                    element={
                      <ProtectedRoute requiredPermissions={['settings.read']} requiredFeature="pricing">
                        <PricePreviewPage />
                      </ProtectedRoute>
                    }
                  />

                  {/* Accounting Routes */}
                  <Route
                    path="/accounting"
                    element={
                      <ProtectedRoute requiredPermissions={['accounting.read']} requiredFeature="accounting">
                        <AccountingLayout>
                          <AccountingIntegrationDashboard />
                        </AccountingLayout>
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/accounting/dashboard"
                    element={
                      <ProtectedRoute requiredPermissions={['accounting.read']} requiredFeature="accounting">
                        <AccountingLayout>
                          <AccountingIntegrationDashboard />
                        </AccountingLayout>
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/accounting/chart-of-accounts"
                    element={
                      <ProtectedRoute requiredPermissions={['accounting.chart_manage', 'accounting.read']} requiredFeature="accounting">
                        <AccountingLayout>
                          <ChartOfAccountsPage />
                        </AccountingLayout>
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/accounting/general-ledger"
                    element={
                      <ProtectedRoute requiredPermissions={['accounting.read']} requiredFeature="accounting">
                        <AccountingLayout>
                          <GeneralLedgerPage />
                        </AccountingLayout>
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/accounting/trial-balance"
                    element={
                      <ProtectedRoute requiredPermissions={['accounting.read']} requiredFeature="accounting">
                        <AccountingLayout>
                          <TrialBalancePage />
                        </AccountingLayout>
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/accounting/financial-statements"
                    element={
                      <ProtectedRoute requiredPermissions={['accounting.read', 'reports.financial_view']} requiredFeature="accounting">
                        <AccountingLayout>
                          <FinancialStatementsPage />
                        </AccountingLayout>
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/accounting/balance-sheet"
                    element={
                      <ProtectedRoute requiredPermissions={['accounting.read', 'reports.financial_view']} requiredFeature="accounting">
                        <AccountingLayout>
                          <BalanceSheetPage />
                        </AccountingLayout>
                      </ProtectedRoute>
                    }
                  />
                  {/* Removed duplicates — redirect to canonical pages */}
                  <Route path="/accounting/customer-financial" element={<Navigate to="/accounting/aged-balances" replace />} />
                  <Route path="/accounting/invoice-integration" element={<Navigate to="/accounting/general-ledger" replace />} />
                  {/* Ops expenses — no accounting feature lock (cashiers / sales with expenses.*). */}
                  <Route
                    path="/expenses"
                    element={
                      <ProtectedRoute requiredPermissions={['expenses.read', 'expenses.create']}>
                        <Layout>
                          <ExpensesPage />
                        </Layout>
                      </ProtectedRoute>
                    }
                  />
                  {/* Accounting module expenses — full accounting chrome + feature flag. */}
                  <Route
                    path="/accounting/expenses"
                    element={
                      <ProtectedRoute requiredPermissions={['expenses.read']} requiredFeature="accounting">
                        <AccountingLayout>
                          <ExpensesPage />
                        </AccountingLayout>
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/accounting/expense-categories"
                    element={
                      <ProtectedRoute requiredPermissions={['expenses.read']} requiredFeature="accounting">
                        <AccountingLayout>
                          <ExpenseCategoriesPage />
                        </AccountingLayout>
                      </ProtectedRoute>
                    }
                  />
                  <Route path="/accounting/invoices" element={<Navigate to="/accounting/aged-balances" replace />} />
                  <Route
                    path="/accounting/customer-payments"
                    element={
                      <ProtectedRoute requiredPermissions={['customers.read']} requiredFeature="accounting">
                        <AccountingLayout>
                          <CustomerPaymentsPage />
                        </AccountingLayout>
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/accounting/supplier-payments"
                    element={
                      <ProtectedRoute requiredPermissions={['accounting.read']} requiredFeature="accounting">
                        <AccountingLayout>
                          <SupplierPaymentsPage />
                        </AccountingLayout>
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/accounting/credit-debit-notes"
                    element={
                      <ProtectedRoute requiredPermissions={['accounting.read']} requiredFeature="accounting">
                        <AccountingLayout>
                          <CreditDebitNotesPage />
                        </AccountingLayout>
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/accounting/profit-loss"
                    element={
                      <ProtectedRoute requiredPermissions={['accounting.read', 'reports.financial_view']} requiredFeature="accounting">
                        <AccountingLayout>
                          <ProfitLossPage />
                        </AccountingLayout>
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/accounting/reconciliation/suppliers"
                    element={
                      <ProtectedRoute requiredPermissions={['accounting.reconcile', 'accounting.read']} requiredFeature="accounting">
                        <AccountingLayout>
                          <SupplierReconciliationPage />
                        </AccountingLayout>
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/accounting/reconciliation/customers"
                    element={
                      <ProtectedRoute requiredPermissions={['accounting.reconcile', 'accounting.read']} requiredFeature="accounting">
                        <AccountingLayout>
                          <CustomerReconciliationPage />
                        </AccountingLayout>
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/accounting/reconciliation/inventory"
                    element={
                      <ProtectedRoute requiredPermissions={['accounting.reconcile', 'accounting.read']} requiredFeature="accounting">
                        <AccountingLayout>
                          <InventoryReconciliationPage />
                        </AccountingLayout>
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/accounting/reconciliation/banking"
                    element={
                      <ProtectedRoute requiredPermissions={['accounting.reconcile', 'accounting.read', 'banking.read']} requiredFeature="accounting">
                        <AccountingLayout>
                          <BankReconciliationPage />
                        </AccountingLayout>
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/accounting/reconciliation/ledger"
                    element={
                      <ProtectedRoute requiredPermissions={['accounting.reconcile', 'accounting.read']} requiredFeature="accounting">
                        <AccountingLayout>
                          <GeneralLedgerReviewPage />
                        </AccountingLayout>
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/accounting/reconciliation/period-close"
                    element={
                      <ProtectedRoute requiredPermissions={['accounting.reconcile', 'accounting.read', 'accounting.period_manage']} requiredFeature="accounting">
                        <AccountingLayout>
                          <PeriodCloseWorkspacePage />
                        </AccountingLayout>
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/accounting/reconciliation"
                    element={
                      <ProtectedRoute requiredPermissions={['accounting.reconcile', 'accounting.read', 'system.audit_read']} requiredFeature="accounting">
                        <AccountingLayout>
                          <ReconciliationPage />
                        </AccountingLayout>
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/accounting/financial-control"
                    element={<Navigate to="/accounting/reconciliation" replace />}
                  />
                  <Route
                    path="/accounting/financial-diagnostics"
                    element={
                      <ProtectedRoute requiredPermissions={['accounting.manage', 'accounting.reconcile']} requiredFeature="accounting">
                        <AccountingLayout>
                          <FinancialDiagnosticsPage />
                        </AccountingLayout>
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/accounting/journal-entries"
                    element={
                      <ProtectedRoute requiredPermissions={['accounting.post', 'accounting.read']} requiredFeature="accounting">
                        <AccountingLayout>
                          <JournalEntriesPage />
                        </AccountingLayout>
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/accounting/periods"
                    element={
                      <ProtectedRoute requiredPermissions={['accounting.period_manage', 'accounting.read']} requiredFeature="accounting">
                        <AccountingLayout>
                          <PeriodManagementPage />
                        </AccountingLayout>
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/accounting/banking"
                    element={
                      <ProtectedRoute requiredPermissions={['banking.read']} requiredFeature="accounting">
                        <AccountingLayout>
                          <BankingPage />
                        </AccountingLayout>
                      </ProtectedRoute>
                    }
                  />

                  {/* Advanced Accounting Modules */}
                  <Route
                    path="/accounting/cost-centers"
                    element={
                      <ProtectedRoute requiredPermissions={['accounting.read']} requiredFeature="accounting">
                        <AccountingLayout>
                          <Suspense fallback={<div className="p-8 text-center">Loading...</div>}>
                            <CostCentersPage />
                          </Suspense>
                        </AccountingLayout>
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/accounting/period-control"
                    element={<Navigate to="/accounting/periods" replace />}
                  />
                  <Route
                    path="/accounting/grir-clearing"
                    element={
                      <ProtectedRoute requiredPermissions={['accounting.read']} requiredFeature="accounting">
                        <AccountingLayout>
                          <Suspense fallback={<div className="p-8 text-center">Loading...</div>}>
                            <GrirClearingPage />
                          </Suspense>
                        </AccountingLayout>
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/accounting/dunning"
                    element={
                      <ProtectedRoute requiredPermissions={['accounting.read']} requiredFeature="accounting">
                        <AccountingLayout>
                          <Suspense fallback={<div className="p-8 text-center">Loading...</div>}>
                            <DunningPage />
                          </Suspense>
                        </AccountingLayout>
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/accounting/withholding-tax"
                    element={
                      <ProtectedRoute requiredPermissions={['accounting.read']} requiredFeature="accounting">
                        <AccountingLayout>
                          <Suspense fallback={<div className="p-8 text-center">Loading...</div>}>
                            <WithholdingTaxPage />
                          </Suspense>
                        </AccountingLayout>
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/accounting/vat-remittance"
                    element={
                      <ProtectedRoute requiredPermissions={['accounting.read']} requiredFeature="accounting">
                        <AccountingLayout>
                          <Suspense fallback={<div className="p-8 text-center">Loading...</div>}>
                            <VatRemittancePage />
                          </Suspense>
                        </AccountingLayout>
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/accounting/bad-debt"
                    element={
                      <ProtectedRoute requiredPermissions={['accounting.read']} requiredFeature="accounting">
                        <AccountingLayout>
                          <Suspense fallback={<div className="p-8 text-center">Loading...</div>}>
                            <BadDebtWriteoffPage />
                          </Suspense>
                        </AccountingLayout>
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/accounting/treasury"
                    element={
                      <ProtectedRoute requiredPermissions={['accounting.read']} requiredFeature="accounting">
                        <Navigate to="/accounting/banking?tab=documents" replace />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/accounting/deposit-worksheet"
                    element={
                      <ProtectedRoute requiredPermissions={['accounting.read']} requiredFeature="accounting">
                        <Navigate to="/accounting/banking?tab=undeposited" replace />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/accounting/treasury-transfer"
                    element={
                      <ProtectedRoute requiredPermissions={['accounting.read']} requiredFeature="accounting">
                        <Navigate to="/accounting/banking?tab=move-money" replace />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/accounting/petty-cash"
                    element={
                      <ProtectedRoute requiredPermissions={['accounting.read']} requiredFeature="accounting">
                        <Navigate to="/accounting/banking?tab=petty-cash" replace />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/accounting/tax-compliance-reports"
                    element={<Navigate to="/reports/tax-compliance" replace />}
                  />
                  <Route
                    path="/accounting/assets"
                    element={
                      <ProtectedRoute requiredPermissions={['accounting.read']} requiredFeature="accounting">
                        <AccountingLayout>
                          <Suspense fallback={<div className="p-8 text-center">Loading...</div>}>
                            <AssetAccountingPage />
                          </Suspense>
                        </AccountingLayout>
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/accounting/je-approval"
                    element={
                      <ProtectedRoute requiredPermissions={['accounting.post', 'accounting.read']} requiredFeature="accounting">
                        <AccountingLayout>
                          <Suspense fallback={<div className="p-8 text-center">Loading...</div>}>
                            <JeApprovalPage />
                          </Suspense>
                        </AccountingLayout>
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/accounting/payment-program"
                    element={
                      <ProtectedRoute requiredPermissions={['accounting.read']} requiredFeature="accounting">
                        <AccountingLayout>
                          <Suspense fallback={<div className="p-8 text-center">Loading...</div>}>
                            <PaymentProgramPage />
                          </Suspense>
                        </AccountingLayout>
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/accounting/multi-currency"
                    element={
                      <ProtectedRoute requiredPermissions={['accounting.read']} requiredFeature="accounting">
                        <AccountingLayout>
                          <Suspense fallback={<div className="p-8 text-center">Loading...</div>}>
                            <MultiCurrencyPage />
                          </Suspense>
                        </AccountingLayout>
                      </ProtectedRoute>
                    }
                  />

                  {/* Enterprise Accounting */}
                  <Route
                    path="/inventory/supplier-returns"
                    element={<Navigate to="/inventory/goods-receipts/returns" replace />}
                  />
                  <Route
                    path="/inventory/uoms"
                    element={
                      <ProtectedRoute requiredPermissions={['inventory.read']} requiredFeature="inventory">
                        <InventoryLayout>
                          <UomManagementPage />
                        </InventoryLayout>
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/inventory/barcode-lookup"
                    element={
                      <ProtectedRoute requiredPermissions={['inventory.read']} requiredFeature="inventory">
                        <InventoryLayout>
                          <BarcodeLookupPage />
                        </InventoryLayout>
                      </ProtectedRoute>
                    }
                  />

                  <Route path="/" element={<HomeRedirect />} />
                </Route>
              ) : (
                <Route path="*" element={<UnauthenticatedRedirect />} />
              )}
            </Routes>
          </Suspense>
        </ErrorBoundary>
      </BrowserRouter>
    </PlatformAuthProvider>
  );
}

export default App;
