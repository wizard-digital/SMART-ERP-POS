const CARD_CLASS =
  'bg-white rounded-lg shadow p-4 sm:p-6 border border-gray-200 text-left w-full min-w-0 hover:border-blue-400 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500';

export function CustomerCenterOverviewCards({
  totalCustomers,
  activeCustomers,
  totalArText,
  totalArTone,
  customersWithDebt,
  recentActivityText,
  onOpenAll,
  onOpenOwing,
  onOpenRecent,
}: {
  totalCustomers: number;
  activeCustomers: number;
  totalArText: string;
  totalArTone: 'due' | 'credit' | 'zero';
  customersWithDebt: number;
  recentActivityText: string;
  onOpenAll: () => void;
  onOpenOwing: () => void;
  onOpenRecent: () => void;
}) {
  const arClass =
    totalArTone === 'due' ? 'text-red-600' : totalArTone === 'credit' ? 'text-green-600' : 'text-gray-900';

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-6 mb-6 sm:mb-8">
      <button type="button" data-card="all" onClick={onOpenAll} aria-label="Open all customers" className={CARD_CLASS}>
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-xs sm:text-sm font-medium text-gray-600">Total Customers</p>
            <p className="text-xl sm:text-3xl font-bold text-gray-900 mt-1 sm:mt-2 tabular-nums">{totalCustomers}</p>
          </div>
          <div className="w-8 h-8 sm:w-12 sm:h-12 bg-blue-100 rounded-full flex items-center justify-center flex-shrink-0">
            <span className="text-base sm:text-2xl">👥</span>
          </div>
        </div>
        <p className="text-xs text-green-600 mt-2 sm:mt-3">↑ {activeCustomers} active</p>
      </button>

      <button
        type="button"
        data-card="ar"
        onClick={onOpenOwing}
        aria-label="Open customers with an outstanding balance"
        className={CARD_CLASS}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-xs sm:text-sm font-medium text-gray-600">Total AR Balance</p>
            <p
              className={`mt-1 sm:mt-2 font-bold leading-tight tabular-nums break-all ${arClass}`}
              style={{ fontSize: 'clamp(1rem, 1.5vw, 1.75rem)' }}
              title={totalArText}
            >
              {totalArText}
            </p>
          </div>
          <div className="w-8 h-8 sm:w-12 sm:h-12 bg-green-100 rounded-full flex items-center justify-center flex-shrink-0">
            <span className="text-base sm:text-2xl">💰</span>
          </div>
        </div>
        <p className="text-xs text-gray-500 mt-2 sm:mt-3">Total receivables</p>
      </button>

      <button type="button" data-card="debt" onClick={onOpenOwing} aria-label="Open customers with debt" className={CARD_CLASS}>
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-xs sm:text-sm font-medium text-gray-600">With Debt</p>
            <p className="text-xl sm:text-3xl font-bold text-gray-900 mt-1 sm:mt-2 tabular-nums">{customersWithDebt}</p>
          </div>
          <div className="w-8 h-8 sm:w-12 sm:h-12 bg-yellow-100 rounded-full flex items-center justify-center flex-shrink-0">
            <span className="text-base sm:text-2xl">⚠️</span>
          </div>
        </div>
        <p className="text-xs text-yellow-600 mt-2 sm:mt-3">Require attention</p>
      </button>

      <button
        type="button"
        data-card="activity"
        onClick={onOpenRecent}
        aria-label="Open sales from the last 7 days"
        className={CARD_CLASS}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-xs sm:text-sm font-medium text-gray-600">Recent Activity</p>
            <p className="text-xl sm:text-3xl font-bold text-gray-900 mt-1 sm:mt-2 tabular-nums">{recentActivityText}</p>
          </div>
          <div className="w-8 h-8 sm:w-12 sm:h-12 bg-purple-100 rounded-full flex items-center justify-center flex-shrink-0">
            <span className="text-base sm:text-2xl">📊</span>
          </div>
        </div>
        <p className="text-xs text-gray-500 mt-2 sm:mt-3">Last 7 days</p>
      </button>
    </div>
  );
}
