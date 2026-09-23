import { useState } from 'react';
import { useCurrencies, useCurrencyConfig, useSetExchangeRate, useUpdateCurrencyConfig } from '../../hooks/useAccountingModules';
import { api, getErrorMessage } from '../../utils/api';
import { Globe, Plus, X, ArrowRightLeft, Settings } from 'lucide-react';
import toast from 'react-hot-toast';
import { getBusinessDate } from '../../utils/businessDate';
import { DatePicker } from '../../components/ui/date-picker';

interface Currency {
  id: string;
  code: string;
  name: string;
  symbol?: string;
  decimalPlaces: number;
  isActive: boolean;
  createdAt?: string;
}

interface CurrencyConfig {
  functionalCurrency: string;
  reportingCurrency?: string;
  exchangeRateType?: string;
}

export default function MultiCurrencyPage() {
  const [tab, setTab] = useState<'currencies' | 'rates' | 'convert' | 'config'>('currencies');
  const [showRateForm, setShowRateForm] = useState(false);
  const { data: currencies, isLoading } = useCurrencies();
  const { data: configData } = useCurrencyConfig();
  const setRate = useSetExchangeRate();
  const updateConfig = useUpdateCurrencyConfig();

  const [rateForm, setRateForm] = useState({ fromCurrency: '', toCurrency: '', rate: 0, effectiveDate: getBusinessDate() });
  const [convertForm, setConvertForm] = useState({ from: 'USD', to: 'UGX', amount: 100, date: '' });
  const [convertResult, setConvertResult] = useState<{ convertedAmount?: number; rate?: number } | null>(null);
  const [configForm, setConfigForm] = useState({ functionalCurrency: '', reportingCurrency: '', exchangeRateType: 'SPOT' });
  const [configEditing, setConfigEditing] = useState(false);

  const currencyList = (Array.isArray(currencies) ? currencies : []) as Currency[];
  const config = (configData || {}) as CurrencyConfig;

  const handleSetRate = async (e: React.FormEvent) => {
    e.preventDefault();
    await setRate.mutateAsync(rateForm);
    setRateForm({ fromCurrency: '', toCurrency: '', rate: 0, effectiveDate: getBusinessDate() });
    setShowRateForm(false);
  };

  const handleConvert = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await api.currency.convert({
        from: convertForm.from,
        to: convertForm.to,
        amount: convertForm.amount,
        date: convertForm.date || undefined,
      });
      setConvertResult(res.data?.data as { convertedAmount?: number; rate?: number } | null);
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  };

  const handleSaveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    await updateConfig.mutateAsync({ functionalCurrency: configForm.functionalCurrency, reportingCurrency: configForm.reportingCurrency || undefined, exchangeRateType: configForm.exchangeRateType });
    setConfigEditing(false);
  };

  const startConfigEdit = () => {
    setConfigForm({ functionalCurrency: config.functionalCurrency || 'UGX', reportingCurrency: config.reportingCurrency || '', exchangeRateType: config.exchangeRateType || 'SPOT' });
    setConfigEditing(true);
  };

  const fmt = (val?: number) => typeof val === 'number' ? val.toLocaleString('en-US', { minimumFractionDigits: 2 }) : '—';

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Multi-Currency</h1>
          <p className="text-sm text-gray-500 mt-1">Manage currencies, exchange rates, and conversions</p>
        </div>
        {tab === 'rates' && (
          <button onClick={() => setShowRateForm(true)} className="inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm">
            <Plus className="h-4 w-4 mr-2" /> Set Rate
          </button>
        )}
      </div>

      {/* Config Banner */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Globe className="h-5 w-5 text-blue-600" />
          <div>
            <span className="text-sm font-medium text-blue-900">Base Currency: </span>
            <span className="text-sm font-bold text-blue-700">{config.functionalCurrency || 'Not Set'}</span>
          </div>
        </div>
        <button onClick={() => { setTab('config'); startConfigEdit(); }} className="text-xs text-blue-600 hover:text-blue-800 font-medium">
          <Settings className="h-4 w-4" />
        </button>
      </div>

      {/* Tabs */}
      <div className="flex border-b">
        {['currencies', 'rates', 'convert', 'config'].map((t) => (
          <button
            key={t}
            onClick={() => setTab(t as typeof tab)}
            className={`px-4 py-2 text-sm font-medium border-b-2 capitalize ${tab === t ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Set Rate Form */}
      {showRateForm && tab === 'rates' && (
        <div className="bg-white border rounded-lg p-6 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">Set Exchange Rate</h2>
            <button onClick={() => setShowRateForm(false)} className="text-gray-400 hover:text-gray-600"><X className="h-5 w-5" /></button>
          </div>
          <form onSubmit={handleSetRate} className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">From Currency</label>
              <input type="text" value={rateForm.fromCurrency} onChange={(e) => setRateForm({ ...rateForm, fromCurrency: e.target.value.toUpperCase() })} required maxLength={10} className="w-full px-3 py-2 border rounded-lg text-sm" placeholder="USD" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">To Currency</label>
              <input type="text" value={rateForm.toCurrency} onChange={(e) => setRateForm({ ...rateForm, toCurrency: e.target.value.toUpperCase() })} required maxLength={10} className="w-full px-3 py-2 border rounded-lg text-sm" placeholder="UGX" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Rate</label>
              <input type="number" min={0} step="0.000001" value={rateForm.rate} onChange={(e) => setRateForm({ ...rateForm, rate: parseFloat(e.target.value) })} required className="w-full px-3 py-2 border rounded-lg text-sm" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Effective Date</label>
              <DatePicker value={rateForm.effectiveDate} onChange={(v) => setRateForm({ ...rateForm, effectiveDate: v })} required placeholder="Effective date" />
            </div>
            <div className="md:col-span-4 flex justify-end gap-2">
              <button type="button" onClick={() => setShowRateForm(false)} className="px-4 py-2 border rounded-lg text-sm hover:bg-gray-50">Cancel</button>
              <button type="submit" disabled={setRate.isPending} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50">Save Rate</button>
            </div>
          </form>
        </div>
      )}

      {/* Currencies Tab */}
      {tab === 'currencies' && (
        isLoading ? (
          <div className="text-center py-12 text-gray-500">Loading...</div>
        ) : (
          <div className="bg-white border rounded-lg shadow-sm overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Code</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Name</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Symbol</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {currencyList.length === 0 ? (
                  <tr><td colSpan={4} className="px-6 py-8 text-center text-gray-500">
                    <Globe className="h-8 w-8 mx-auto mb-2 text-gray-300" />
                    No currencies configured.
                  </td></tr>
                ) : currencyList.map((c) => (
                  <tr key={c.code} className="hover:bg-gray-50">
                    <td className="px-6 py-4 text-sm font-medium text-gray-900">{c.code}</td>
                    <td className="px-6 py-4 text-sm text-gray-700">{c.name}</td>
                    <td className="px-6 py-4 text-sm text-gray-500">{c.symbol || '—'}</td>
                    <td className="px-6 py-4">
                      <span className={`inline-flex px-2 py-0.5 text-xs font-medium rounded-full ${c.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}>
                        {c.isActive ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {/* Rates Tab */}
      {tab === 'rates' && !showRateForm && (
        <div className="bg-white border rounded-lg shadow-sm p-6 text-center text-gray-500">
          <ArrowRightLeft className="h-12 w-12 mx-auto mb-3 text-gray-300" />
          <p className="text-sm">Use the "Set Rate" button to add or update exchange rates.</p>
          <p className="text-xs text-gray-400 mt-1">Rates are stored with effective dates for historical tracking.</p>
        </div>
      )}

      {/* Convert Tab */}
      {tab === 'convert' && (
        <div className="bg-white border rounded-lg shadow-sm p-6">
          <h3 className="text-lg font-semibold mb-4">Currency Converter</h3>
          <form onSubmit={handleConvert} className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">From</label>
              <input type="text" value={convertForm.from} onChange={(e) => setConvertForm({ ...convertForm, from: e.target.value.toUpperCase() })} required maxLength={10} className="w-full px-3 py-2 border rounded-lg text-sm" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">To</label>
              <input type="text" value={convertForm.to} onChange={(e) => setConvertForm({ ...convertForm, to: e.target.value.toUpperCase() })} required maxLength={10} className="w-full px-3 py-2 border rounded-lg text-sm" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Amount</label>
              <input type="number" step="1" value={convertForm.amount} onChange={(e) => setConvertForm({ ...convertForm, amount: parseFloat(e.target.value) })} required className="w-full px-3 py-2 border rounded-lg text-sm" />
            </div>
            <div className="flex items-end">
              <button type="submit" className="w-full px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">
                Convert
              </button>
            </div>
          </form>
          {convertResult && (
            <div className="bg-green-50 border border-green-200 rounded-lg p-4">
              <div className="flex items-center gap-3">
                <ArrowRightLeft className="h-5 w-5 text-green-600" />
                <div>
                  <div className="text-lg font-bold text-green-800">
                    {convertForm.amount} {convertForm.from} = {fmt(convertResult.convertedAmount)} {convertForm.to}
                  </div>
                  <div className="text-xs text-green-600">Rate: {convertResult.rate}</div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Config Tab */}
      {tab === 'config' && (
        <div className="bg-white border rounded-lg shadow-sm p-6">
          <h3 className="text-lg font-semibold mb-4">Currency Configuration</h3>
          {configEditing ? (
            <form onSubmit={handleSaveConfig} className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Functional Currency</label>
                <input type="text" value={configForm.functionalCurrency} onChange={(e) => setConfigForm({ ...configForm, functionalCurrency: e.target.value.toUpperCase() })} required maxLength={10} className="w-full px-3 py-2 border rounded-lg text-sm" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Reporting Currency</label>
                <input type="text" value={configForm.reportingCurrency} onChange={(e) => setConfigForm({ ...configForm, reportingCurrency: e.target.value.toUpperCase() })} maxLength={10} className="w-full px-3 py-2 border rounded-lg text-sm" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Exchange Rate Type</label>
                <select value={configForm.exchangeRateType} onChange={(e) => setConfigForm({ ...configForm, exchangeRateType: e.target.value })} className="w-full px-3 py-2 border rounded-lg text-sm">
                  <option value="SPOT">Spot</option>
                  <option value="BUDGET">Budget</option>
                  <option value="AVERAGE">Average</option>
                </select>
              </div>
              <div className="md:col-span-3 flex justify-end gap-2">
                <button type="button" onClick={() => setConfigEditing(false)} className="px-4 py-2 border rounded-lg text-sm hover:bg-gray-50">Cancel</button>
                <button type="submit" disabled={updateConfig.isPending} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50">Save</button>
              </div>
            </form>
          ) : (
            <div className="space-y-4">
              <div className="flex justify-between items-center p-4 bg-gray-50 rounded-lg">
                <div>
                  <div className="text-sm font-medium text-gray-700">Functional Currency</div>
                  <div className="text-lg font-bold">{config.functionalCurrency || 'Not configured'}</div>
                </div>
                <button onClick={startConfigEdit} className="px-4 py-2 border rounded-lg text-sm hover:bg-gray-100">Edit</button>
              </div>
              <div className="p-4 bg-gray-50 rounded-lg">
                <div className="text-sm font-medium text-gray-700">Reporting Currency</div>
                <div className="text-lg font-bold">{config.reportingCurrency || 'Not configured'}</div>
              </div>
              <div className="p-4 bg-gray-50 rounded-lg">
                <div className="text-sm font-medium text-gray-700">Exchange Rate Type</div>
                <div className="text-lg font-bold">{config.exchangeRateType || 'SPOT'}</div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}