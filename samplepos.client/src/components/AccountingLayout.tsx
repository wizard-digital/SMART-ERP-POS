import { useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  BarChart3, Calculator, TrendingUp, BookOpen, CreditCard, DollarSign,
  Building, Truck, FileText, Calendar, Scale, ClipboardCheck,
  ChevronDown, ChevronRight, Home, ArrowLeft, Menu, X, Building2, FileMinus,
  Landmark, FileCheck, AlertTriangle, Receipt, Package, ShieldCheck, Banknote, Globe,
  CalendarCheck, Percent, RefreshCw, Clock, ArrowRightLeft, FileWarning
} from 'lucide-react';
import ServerClock from './ServerClock';
import { useBackendPermission } from '../hooks/useBackendPermission';
import { AdaptiveAppShell } from './adaptive';

interface AccountingLayoutProps {
  children: React.ReactNode;
}

interface NavGroup {
  name: string;
  items: {
    name: string;
    path: string;
    icon: React.ReactNode;
    description: string;
  }[];
}

export default function AccountingLayout({ children }: AccountingLayoutProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const canManageAccounting = useBackendPermission('accounting.manage');
  const canReadAccounting = useBackendPermission('accounting.read');
  const canReadBanking = useBackendPermission('banking.read');
  const canReadOwnership = useBackendPermission('ownership.read');
  const showDiagnosticsNav = canManageAccounting || canReadAccounting;
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set(['Overview', 'ERP Controls', 'Advanced Accounting']));
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Grouped navigation items
  const navGroups: NavGroup[] = useMemo(() => {
    const groups: NavGroup[] = [
    {
      name: 'Overview',
      items: [
        {
          name: 'Dashboard',
          path: '/accounting/dashboard',
          icon: <BarChart3 className="h-4 w-4" />,
          description: 'Accounting summary and integration status'
        }
      ]
    },
    {
      name: 'Core Accounting',
      items: [
        {
          name: 'Chart of Accounts',
          path: '/accounting/chart-of-accounts',
          icon: <BookOpen className="h-4 w-4" />,
          description: 'Account structure and types'
        },
        {
          name: 'General Ledger',
          path: '/accounting/general-ledger',
          icon: <Building className="h-4 w-4" />,
          description: 'All transactions and entries'
        },
        {
          name: 'Trial Balance',
          path: '/accounting/trial-balance',
          icon: <Calculator className="h-4 w-4" />,
          description: 'Verify debits equal credits'
        }
      ]
    },
    {
      name: 'Expenses & Payables',
      items: [
        {
          name: 'Expenses',
          path: '/accounting/expenses',
          icon: <DollarSign className="h-4 w-4" />,
          description: 'Expense vouchers — approve, then pay from bank'
        },
        {
          name: 'Expense Categories',
          path: '/accounting/expense-categories',
          icon: <CreditCard className="h-4 w-4" />,
          description: 'Categories and budgets'
        },
        {
          name: 'Supplier Payments',
          path: '/accounting/supplier-payments',
          icon: <Truck className="h-4 w-4" />,
          description: 'Bills and payments'
        },
        {
          name: 'Customer Payments',
          path: '/accounting/customer-payments',
          icon: <DollarSign className="h-4 w-4" />,
          description: 'Receipts and AR allocation'
        },
        {
          name: 'Credit/Debit Notes',
          path: '/accounting/credit-debit-notes',
          icon: <FileMinus className="h-4 w-4" />,
          description: 'Customer & supplier notes'
        }
      ]
    },
    {
      name: 'Reports',
      items: [
        {
          name: 'Balance Sheet',
          path: '/accounting/balance-sheet',
          icon: <Scale className="h-4 w-4" />,
          description: 'Statement of financial position'
        },
        {
          name: 'Financial Statements',
          path: '/accounting/financial-statements',
          icon: <TrendingUp className="h-4 w-4" />,
          description: 'Balance sheet, income, cash flow'
        },
        {
          name: 'P&L Reports',
          path: '/accounting/profit-loss',
          icon: <FileText className="h-4 w-4" />,
          description: 'By period, customer, category'
        }
      ]
    },
    {
      name: 'ERP Controls',
      items: [
        {
          name: 'Banking & Liquidity',
          path: '/accounting/banking',
          icon: <Building2 className="h-4 w-4" />,
          description: 'Accounts, undeposited receipts, move money, reconcile'
        },
        {
          name: 'Financial Control Tower',
          path: '/accounting/reconciliation',
          icon: <Scale className="h-4 w-4" />,
          description: 'Month-end close, exceptions, and work queue'
        },
        {
          name: 'Journal Entries',
          path: '/accounting/journal-entries',
          icon: <ClipboardCheck className="h-4 w-4" />,
          description: 'Manual journal entries'
        },
        {
          name: 'Period Management',
          path: '/accounting/periods',
          icon: <Calendar className="h-4 w-4" />,
          description: 'Open, close, lock periods'
        }
      ]
    },
    {
      name: 'Advanced Accounting',
      items: [
        {
          name: 'Cost Centers',
          path: '/accounting/cost-centers',
          icon: <Landmark className="h-4 w-4" />,
          description: 'Organizational cost allocation'
        },
        {
          name: 'GR/IR Clearing',
          path: '/accounting/grir-clearing',
          icon: <FileCheck className="h-4 w-4" />,
          description: 'Goods receipt & invoice matching'
        },
        {
          name: 'Down Payment Clearing',
          path: '/accounting/down-payment-clearing',
          icon: <ArrowRightLeft className="h-4 w-4" />,
          description: 'Clear customer deposits against invoices'
        },
        {
          name: 'Dunning',
          path: '/accounting/dunning',
          icon: <AlertTriangle className="h-4 w-4" />,
          description: 'Overdue receivables management'
        },
        {
          name: 'Withholding Tax',
          path: '/accounting/withholding-tax',
          icon: <Receipt className="h-4 w-4" />,
          description: 'Types, remit, recover, certificates'
        },
        {
          name: 'VAT Remittance',
          path: '/accounting/vat-remittance',
          icon: <Landmark className="h-4 w-4" />,
          description: 'Clear tax payable to the authority'
        },
        {
          name: 'Bad Debt Write-off',
          path: '/accounting/bad-debt',
          icon: <FileWarning className="h-4 w-4" />,
          description: 'Uncollectible AR → expense 5210 (not credit notes)'
        },
        {
          name: 'Asset Accounting',
          path: '/accounting/assets',
          icon: <Package className="h-4 w-4" />,
          description: 'Fixed assets & depreciation'
        },
        {
          name: 'JE Approval',
          path: '/accounting/je-approval',
          icon: <ShieldCheck className="h-4 w-4" />,
          description: 'Journal entry approval workflow'
        },
        {
          name: 'Payment Program',
          path: '/accounting/payment-program',
          icon: <Banknote className="h-4 w-4" />,
          description: 'Automated payment runs'
        },
        {
          name: 'Multi-Currency',
          path: '/accounting/multi-currency',
          icon: <Globe className="h-4 w-4" />,
          description: 'Exchange rates & conversions'
        }
      ]
    },
    {
      name: 'Enterprise Accounting',
      items: [
        ...(canReadOwnership
          ? [
              {
                name: 'Ownership & Equity',
                path: '/accounting/ownership',
                icon: <Landmark className="h-4 w-4" />,
                description: 'Legal form, owner capital, and company shares',
              },
            ]
          : []),
        {
          name: 'Fiscal Year Close',
          path: '/accounting/fiscal-year-close',
          icon: <CalendarCheck className="h-4 w-4" />,
          description: 'Year-end close & retained earnings'
        },
        {
          name: 'GL Entry Matching',
          path: '/accounting/gl-reconciliation',
          icon: <Scale className="h-4 w-4" />,
          description: 'Match & reconcile individual GL entries'
        },
        {
          name: 'Tax Engine',
          path: '/accounting/tax-engine',
          icon: <Percent className="h-4 w-4" />,
          description: 'Tax definitions & computation'
        },
        {
          name: 'Currency Revaluation',
          path: '/accounting/currency-revaluation',
          icon: <RefreshCw className="h-4 w-4" />,
          description: 'Period-end FX revaluation (see Multi-Currency for rates)'
        },
        {
          name: 'Financial Diagnostics',
          path: '/accounting/financial-diagnostics',
          icon: <ShieldCheck className="h-4 w-4" />,
          description: 'Reconciliation engine & system health (admin)'
        },
        {
          name: 'GL Integrity Audit',
          path: '/accounting/gl-integrity',
          icon: <ShieldCheck className="h-4 w-4" />,
          description: 'System-wide accounting audit'
        },
        {
          name: 'Aged Balances',
          path: '/accounting/aged-balances',
          icon: <Clock className="h-4 w-4" />,
          description: 'Aged receivables & payables (see Dunning for actions)'
        }
      ]
    }
    ];

    if (!showDiagnosticsNav) {
      return groups.map((g) => ({
        ...g,
        items: g.items.filter((item) => item.path !== '/accounting/financial-diagnostics'),
      }));
    }
    return groups;
  }, [showDiagnosticsNav, canReadOwnership]);

  const visibleNavGroups = useMemo(() => {
    if (canReadBanking) return navGroups;
    return navGroups.map((g) => ({
      ...g,
      items: g.items.filter((item) => item.path !== '/accounting/banking'),
    }));
  }, [navGroups, canReadBanking]);

  const isActive = (path: string) => {
    return location.pathname === path ||
      (path === '/accounting/dashboard' && location.pathname === '/accounting');
  };

  const toggleGroup = (groupName: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(groupName)) {
        next.delete(groupName);
      } else {
        next.add(groupName);
      }
      return next;
    });
  };

  // Find current page info for header
  const currentPage = navGroups.flatMap(g => g.items).find(item => isActive(item.path));

  const SidebarContent = () => (
    <>
      {/* Back to Dashboard */}
      <div className="p-4 border-b">
        <button
          onClick={() => navigate('/dashboard')}
          className="flex items-center space-x-2 text-sm text-gray-600 hover:text-gray-900 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          <span>Back to Main</span>
        </button>
      </div>

      {/* Navigation Groups */}
      <nav className="flex-1 overflow-y-auto py-4 px-3">
        {visibleNavGroups.map((group) => (
          <div key={group.name} className="mb-2">
            {/* Group Header */}
            <button
              onClick={() => toggleGroup(group.name)}
              className="w-full flex items-center justify-between px-3 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wider hover:text-gray-700"
            >
              <span>{group.name}</span>
              {expandedGroups.has(group.name) ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
            </button>

            {/* Group Items */}
            {expandedGroups.has(group.name) && (
              <div className="mt-1 space-y-1">
                {group.items.map((item) => (
                  <Link
                    key={item.path}
                    to={item.path}
                    onClick={() => setSidebarOpen(false)}
                    className={`group flex items-center px-3 py-2.5 rounded-lg text-sm transition-all ${isActive(item.path)
                      ? 'bg-blue-50 text-blue-700 font-medium'
                      : 'text-gray-700 hover:bg-gray-100 hover:text-gray-900'
                      }`}
                    title={item.description}
                  >
                    <span className={`mr-3 ${isActive(item.path) ? 'text-blue-600' : 'text-gray-400 group-hover:text-gray-600'}`}>
                      {item.icon}
                    </span>
                    <div className="flex-1 min-w-0">
                      <span className="block truncate">{item.name}</span>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>
        ))}
      </nav>

      {/* Quick Stats Footer */}
      <div className="p-4 border-t bg-gray-50">
        <div className="text-xs text-gray-500">
          <div className="flex items-center space-x-2">
            <Home className="h-3 w-3" />
            <span>Accounting Module</span>
          </div>
        </div>
      </div>
    </>
  );

  return (
    <AdaptiveAppShell className="h-full" pathname={location.pathname}>
    <div className="h-full bg-gray-50 flex">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex lg:flex-col w-64 bg-white border-r shadow-sm">
        {/* Module Header */}
        <div className="h-16 flex items-center px-4 border-b border-gray-200">
          <BarChart3 className="h-7 w-7 text-blue-600" />
          <div className="ml-3">
            <h1 className="text-lg font-bold text-gray-900">Accounting</h1>
          </div>
        </div>
        <SidebarContent />
      </aside>

      {/* Mobile Sidebar Overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black bg-opacity-50 z-40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Mobile Sidebar */}
      <aside className={`fixed inset-y-0 left-0 z-50 w-64 bg-white transform transition-transform duration-300 ease-in-out lg:hidden ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}>
        {/* Mobile Header */}
        <div className="h-16 flex items-center justify-between px-4 border-b border-gray-200">
          <div className="flex items-center">
            <BarChart3 className="h-7 w-7 text-blue-600" />
            <h1 className="ml-3 text-lg font-bold text-gray-900">Accounting</h1>
          </div>
          <button
            onClick={() => setSidebarOpen(false)}
            className="p-2 rounded-lg hover:bg-gray-100"
            aria-label="Close sidebar"
          >
            <X className="h-5 w-5 text-gray-600" />
          </button>
        </div>
        <SidebarContent />
      </aside>

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        {/* Top Header */}
        <header className="h-16 bg-white border-b shadow-sm flex items-center px-4 lg:px-6">
          {/* Mobile Menu Button */}
          <button
            onClick={() => setSidebarOpen(true)}
            className="p-2 rounded-lg hover:bg-gray-100 lg:hidden mr-3"
            aria-label="Open sidebar menu"
          >
            <Menu className="h-5 w-5 text-gray-600" />
          </button>

          {/* Page Title */}
          <div className="flex-1">
            <h1 className="text-lg font-semibold text-gray-900">
              {currentPage?.name || 'Accounting'}
            </h1>
            <p className="text-sm text-gray-500 hidden sm:block">
              {currentPage?.description || 'Financial management and reporting'}
            </p>
          </div>

          {/* Clock */}
          <ServerClock />
        </header>

        {/* Page Content */}
        <main className="flex-1 overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
    </AdaptiveAppShell>
  );
}