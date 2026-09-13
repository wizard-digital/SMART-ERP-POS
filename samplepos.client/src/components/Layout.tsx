import { useMemo, useState, useEffect } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useTenant } from '../contexts/TenantContext';
import { PasswordExpiryWarning } from './auth/PasswordExpiryWarning';
import ServerClock from './ServerClock';
import NotificationCenter from './notifications/NotificationCenter';
import ErrorBoundary from './ErrorBoundary';
import { isCashierLockdownActive, resolveCashierNavItems } from '../utils/cashierLockdown';
import {
  isRestaurantWaiterProfile,
  WAITER_NAV_ITEMS,
} from '../utils/restaurantWaiterLockdown';
import { createClientAuthorization } from '../authorization/authorizationService';
import { useRestaurantEnabled } from '../hooks/useRestaurantEnabled';
import { shouldHideRetailPos } from '../utils/retailPosVisibility';
import {
  AdaptiveAppShell,
  AdaptiveBottomNav,
  AdaptiveNavigation,
  AdaptiveShellBar,
  useAdaptiveLayout,
  useAdaptiveWorkspaceOptional,
} from './adaptive';
import { shellNavChromeFromWorkspace } from '../lib/adaptiveShellNav';

interface LayoutProps {
  children: React.ReactNode;
}

interface NavItem {
  name: string;
  path: string;
  icon: string;
  color: string;
  permissions?: string[];
  feature?: string;
  requiresRestaurant?: boolean;
}

export default function Layout({ children }: LayoutProps) {
  const { pathname } = useLocation();
  return (
    <AdaptiveAppShell pathname={pathname}>
      <LayoutChrome>{children}</LayoutChrome>
    </AdaptiveAppShell>
  );
}

function LayoutChrome({ children }: LayoutProps) {
  const layout = useAdaptiveLayout();
  const workspace = useAdaptiveWorkspaceOptional();
  const shellNav = shellNavChromeFromWorkspace(workspace, layout.tier);
  const [sidebarOpen, setSidebarOpen] = useState(() => shellNav.defaultExpanded);
  const { user, logout, permissions } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { config, loading: tenantLoading } = useTenant();
  const brandName = config.branding.companyName || config.name || 'SMART ERP';
  const { data: restaurantEnabled = false } = useRestaurantEnabled();
  const userInitial = user?.fullName?.charAt(0).toUpperCase() || 'U';

  useEffect(() => {
    setSidebarOpen(shellNav.defaultExpanded);
  }, [layout.tier, workspace?.id, workspace?.navPattern, shellNav.defaultExpanded]);

  const navItems: NavItem[] = [
    { name: 'Dashboard', path: '/dashboard', icon: '📊', color: 'text-blue-600' },
    { name: 'Point of Sale', path: '/pos', icon: '🛒', color: 'text-green-600', permissions: ['pos.read', 'pos.create'], feature: 'pos' },
    {
      name: 'Restaurant',
      path: '/restaurant',
      icon: '🍽️',
      color: 'text-amber-700',
      permissions: ['restaurant.read', 'restaurant.order'],
      feature: 'pos',
      requiresRestaurant: true,
    },
    {
      name: 'Kitchen Display',
      path: '/restaurant/kitchen',
      icon: '👨‍🍳',
      color: 'text-orange-700',
      permissions: ['restaurant.kitchen'],
      feature: 'pos',
      requiresRestaurant: true,
    },
    {
      name: 'Stations',
      path: '/restaurant/stations',
      icon: '🖨️',
      color: 'text-stone-700',
      permissions: ['restaurant.manage'],
      feature: 'pos',
      requiresRestaurant: true,
    },
    {
      name: 'Printers',
      path: '/restaurant/printer-diagnostics',
      icon: '📟',
      color: 'text-stone-600',
      permissions: ['restaurant.manage'],
      feature: 'pos',
      requiresRestaurant: true,
    },
    {
      name: 'Recipes',
      path: '/restaurant/recipes',
      icon: '🥗',
      color: 'text-lime-700',
      permissions: ['restaurant.manage'],
      feature: 'pos',
      requiresRestaurant: true,
    },
    {
      name: 'Kitchen Production',
      path: '/kitchen',
      icon: '🍲',
      color: 'text-orange-800',
      permissions: [
        'kitchen.production.read',
        'kitchen.production.create',
        'kitchen.production.post',
      ],
      feature: 'pos',
      // Restaurant-domain capability — must not appear on pure retail tenants
      requiresRestaurant: true,
    },
    {
      name: 'Order tags',
      path: '/restaurant/order-tags',
      icon: '🏷️',
      color: 'text-amber-700',
      permissions: ['restaurant.manage'],
      feature: 'pos',
      requiresRestaurant: true,
    },
    { name: 'Orders Queue', path: '/orders-queue', icon: '📋', color: 'text-orange-600', permissions: ['orders.read', 'orders.pay'], feature: 'pos' },
    { name: 'Inventory', path: '/inventory', icon: '📦', color: 'text-purple-600', permissions: ['inventory.read'], feature: 'inventory' },
    { name: 'Customers', path: '/customers', icon: '👥', color: 'text-yellow-600', permissions: ['customers.read'], feature: 'customers' },
    { name: 'Suppliers', path: '/suppliers', icon: '🏢', color: 'text-indigo-600', permissions: ['suppliers.read'], feature: 'purchase_orders' },
    { name: 'Sales', path: '/sales', icon: '💰', color: 'text-emerald-600', permissions: ['sales.read'], feature: 'pos' },
    { name: 'Quotations', path: '/quotations', icon: '💼', color: 'text-blue-500', permissions: ['quotations.read'], feature: 'invoices' },
    { name: 'CRM', path: '/crm', icon: '🤝', color: 'text-violet-600', permissions: ['crm.read'], feature: 'crm' },
    { name: 'HR & Payroll', path: '/hr', icon: '📇', color: 'text-pink-600', permissions: ['hr.read'], feature: 'hr' },
    { name: 'Sales Orders', path: '/distribution/sales-orders', icon: '📦', color: 'text-indigo-600', permissions: ['orders.read'], feature: 'invoices' },
    { name: 'Dispatch', path: '/delivery', icon: '🚚', color: 'text-teal-600', permissions: ['delivery.read'], feature: 'invoices' },
    { name: 'Pricing', path: '/pricing', icon: '🏷️', color: 'text-rose-600', permissions: ['settings.read'], feature: 'pricing' },
    { name: 'Accounting', path: '/accounting', icon: '🧾', color: 'text-orange-600', permissions: ['accounting.read'], feature: 'accounting' },
    { name: 'Reports', path: '/reports', icon: '📈', color: 'text-cyan-600', permissions: ['reports.read', 'reports.sales_view', 'reports.financial_view'], feature: 'reports' },
    { name: 'Category Reports', path: '/reports/category-intelligence', icon: '🏷️', color: 'text-indigo-600', permissions: ['reports.financial_view'], feature: 'reports' },
  ];

  const adminNavItems: NavItem[] = [
    { name: 'Import', path: '/import', icon: '📥', color: 'text-violet-600', permissions: ['admin.create'] },
    { name: 'Settings', path: '/settings', icon: '⚙️', color: 'text-gray-600', permissions: ['system.read'] },
    {
      name: 'Roles',
      path: '/admin/roles',
      icon: '🔐',
      color: 'text-pink-600',
      permissions: ['system.roles_update', 'admin.update'],
    },
  ];

  const planFeatures = config.planFeatures ?? [];

  const allNavItems = useMemo(() => {
    // Default Cashier grant set → minimal nav. Extra Role Management ticks → full permission nav.
    if (isCashierLockdownActive({ role: user?.role, permissions })) {
      return resolveCashierNavItems(restaurantEnabled, permissions).map((item) => ({
        name: item.name,
        path: item.path,
        icon: item.icon,
        color: 'text-gray-700',
      }));
    }

    if (
      isRestaurantWaiterProfile({
        role: user?.role,
        permissions,
        restaurantEnabled,
      })
    ) {
      // Waiters: Restaurant FOH only — never Kitchen Display / Stations / Recipes / Order tags.
      const authz = createClientAuthorization(user, permissions);
      return WAITER_NAV_ITEMS.filter((item) => {
        if (item.path === '/customers') {
          return !!authz?.hasPermission('customers.read');
        }
        return true;
      }).map((item) => ({
        name: item.name,
        path: item.path,
        icon: item.icon,
        color: 'text-gray-700',
      }));
    }

    const items = [...navItems, ...adminNavItems];
    const authz = createClientAuthorization(user, permissions);
    return items.filter((item) => {
      // Restaurant tenant = FOH, not retail POS.
      if (item.path === '/pos' && shouldHideRetailPos(restaurantEnabled)) return false;
      if (item.requiresRestaurant && !restaurantEnabled) return false;
      if (item.feature) {
        if (tenantLoading) return false;
        if (planFeatures.length > 0 && !planFeatures.includes(item.feature)) return false;
      }
      if (!item.permissions) return true;
      if (!authz) return false;
      return item.permissions.some((p) => authz.hasPermission(p));
    });
  }, [user, permissions, planFeatures, tenantLoading, restaurantEnabled]);

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const isActive = (path: string) => {
    if (path === '/settings/invoice') {
      return location.pathname.startsWith('/settings');
    }
    if (path.startsWith('/settings?tab=')) {
      const tab = new URLSearchParams(path.split('?')[1] || '').get('tab');
      return (
        location.pathname === '/settings' &&
        (location.search.includes(`tab=${tab}`) ||
          (!location.search && tab === 'invoice'))
      );
    }
    if (path === '/settings') {
      return location.pathname === '/settings';
    }
    if (path === '/restaurant') {
      return location.pathname === '/restaurant';
    }
    return location.pathname === path || location.pathname.startsWith(path + '/');
  };

  return (
    <>
      <AdaptiveShellBar
        brandName={brandName}
        userInitial={userInitial}
        onMenuClick={() => setSidebarOpen(!sidebarOpen)}
        trailing={
          <>
            <ErrorBoundary section="NotificationCenter">
              <NotificationCenter />
            </ErrorBoundary>
            <ServerClock />
          </>
        }
      />

      <div
        className="app-body"
        data-shell-nav={shellNav.pattern}
        data-workspace={workspace?.id}
        data-pos-panel={workspace?.posPanelMode ?? undefined}
      >
        <AdaptiveNavigation
          brandName={brandName}
          items={allNavItems}
          isActive={isActive}
          expanded={sidebarOpen}
          onExpandedChange={setSidebarOpen}
          userName={user?.fullName}
          userRole={user?.role}
          userInitial={userInitial}
          footer={({ showLabels, persistentNav }) => (
            <>
              <Link
                to="/settings/notifications"
                className={`${showLabels ? 'w-full flex items-center gap-2' : 'w-10 justify-center flex'} mt-3 px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors min-h-[var(--layout-touch-target)]`}
                title={!showLabels && persistentNav ? 'Notifications' : undefined}
              >
                {showLabels ? '🔔 Notifications' : '🔔'}
              </Link>
              <Link
                to="/my/quick-login"
                className={`${showLabels ? 'w-full flex items-center gap-2' : 'w-10 justify-center flex'} mt-3 px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors min-h-[var(--layout-touch-target)]`}
                title={!showLabels && persistentNav ? 'Quick Login Setup' : undefined}
              >
                {showLabels ? '🔑 Quick Login Setup' : '🔑'}
              </Link>
              <button
                type="button"
                onClick={handleLogout}
                className={`${showLabels ? 'w-full' : 'w-10'} mt-3 px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 transition-colors min-h-[var(--layout-touch-target)]`}
                title={!showLabels && persistentNav ? 'Logout' : undefined}
              >
                {showLabels ? 'Logout' : '🚪'}
              </button>
            </>
          )}
        />

        <main className="page-container">
          <div className="page-container-inner">
            <PasswordExpiryWarning />
            {children}
          </div>
        </main>
      </div>

      <AdaptiveBottomNav
        items={allNavItems}
        isActive={isActive}
        onOpenFullMenu={() => setSidebarOpen(true)}
      />
    </>
  );
}
