import { MultistoreGate } from './MultistoreGate';
import type { StockViewMode } from './stockViewPrefs';

interface StockViewModeToggleProps {
  mode: StockViewMode;
  onChange: (mode: StockViewMode) => void;
}

export function StockViewModeToggle({ mode, onChange }: StockViewModeToggleProps) {
  return (
    <MultistoreGate>
      <div className="mb-4 flex flex-col sm:flex-row sm:items-center gap-2">
        <span className="text-sm font-medium text-gray-700">Stock</span>
        <div
          className="inline-flex rounded-lg border border-gray-200 bg-gray-50 p-0.5"
          role="group"
          aria-label="Stock view mode"
        >
          <button
            type="button"
            onClick={() => onChange('company')}
            className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${
              mode === 'company'
                ? 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            Company
          </button>
          <button
            type="button"
            onClick={() => onChange('store')}
            className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${
              mode === 'store'
                ? 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            By Store
          </button>
        </div>
        <span className="text-xs text-gray-500">
          {mode === 'company'
            ? 'Warehouse + shops (MAIN and selling stores). The register uses shops only.'
            : 'Open Filters to pick a warehouse or a shop. MAIN is not POS stock.'}
        </span>
      </div>
    </MultistoreGate>
  );
}
