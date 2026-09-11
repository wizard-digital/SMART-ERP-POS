import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ReportBackLink } from '../../../components/reports/ReportBackLink';
import Layout from '../../../components/Layout';
import { ResponsiveTableWrapper } from '../../../components/ui/ResponsiveTableWrapper';
import { Button } from '../../../components/ui/button';
import { useWarehouseNetworkReport } from '../../../hooks/useWarehouseReports';
import { useMultistoreEnabled } from '../../../hooks/useMultistore';

import { NetworkKpiCard } from '../../../components/inventory/NetworkKpiCard';

function formatQty(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatMoney(n: number): string {
  return n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

export default function StoreNetworkReportPage() {
  const [days, setDays] = useState(7);
  const { isMultistoreEnabled, isLoading: flagLoading } = useMultistoreEnabled();
  const { data, isLoading, error, refetch, isFetching } = useWarehouseNetworkReport(
    days,
    isMultistoreEnabled,
  );

  return (
    <Layout>
      <div className="p-3 sm:p-6 max-w-6xl mx-auto space-y-8">
        <header className="space-y-3">
          <ReportBackLink />
          <div>
            <h1 className="text-lg sm:text-2xl font-bold text-gray-900">Store Network Reports</h1>
            <p className="text-sm text-gray-600 mt-1">
              Store-scoped inventory, transfers, expiry, and quarantine balances.
            </p>
          </div>
        </header>

        {flagLoading && <p className="text-gray-500">Loading…</p>}

        {!flagLoading && !isMultistoreEnabled && (
          <div className="bg-gray-50 border rounded-lg p-8 text-center text-gray-600">
            <p className="font-medium text-gray-900 mb-2">Multi-store mode is not enabled</p>
            <p className="text-sm">
              Enable the warehouse network under Settings → System → Inventory, then return here.
            </p>
            <Link
              to="/settings"
              className="inline-block mt-4 text-sm font-medium text-blue-600 hover:underline"
            >
              Open Settings
            </Link>
          </div>
        )}

        {!flagLoading && isMultistoreEnabled && isLoading && (
          <p className="text-gray-500">Loading network reports…</p>
        )}

        {!flagLoading && isMultistoreEnabled && !isLoading && (error || !data) && (
          <div>
            <p className="text-red-600">Failed to load warehouse network reports.</p>
            <Button type="button" variant="outline" className="mt-3" onClick={() => refetch()}>
              Retry
            </Button>
          </div>
        )}

        {!flagLoading && isMultistoreEnabled && !isLoading && data && (
          <>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <p className="text-sm text-gray-600">As of {data.summary.asOfDate}</p>
              <div className="flex items-center gap-2">
                <label className="text-sm text-gray-600">
                  Transfer window
                  <select
                    className="ml-2 border rounded-md px-2 py-1 text-sm"
                    value={days}
                    onChange={(e) => setDays(Number(e.target.value))}
                  >
                    <option value={7}>7 days</option>
                    <option value={30}>30 days</option>
                    <option value={90}>90 days</option>
                  </select>
                </label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => refetch()}
                  disabled={isFetching}
                >
                  {isFetching ? 'Refreshing…' : 'Refresh'}
                </Button>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              <NetworkKpiCard
                label="Sellable (base units)"
                value={formatQty(data.summary.totalSellableQty)}
                hint="MUoM breakdown per product in Stock / Assortment"
              />
              <NetworkKpiCard label="Inventory value" value={formatMoney(data.summary.totalInventoryValue)} />
              <NetworkKpiCard label="Active stores" value={String(data.summary.activeStoreCount)} />
              <NetworkKpiCard
                label="Pending transfers"
                value={String(data.summary.pendingTransferCount)}
                hint={`${data.summary.transfersLast7Days} in last ${days}d`}
              />
              <NetworkKpiCard label="Low stock SKUs" value={String(data.summary.lowStockProductCount)} />
              <NetworkKpiCard
                label="Near expiry (30d)"
                value={formatQty(data.summary.nearExpiryQty)}
                hint="MAIN + SELLING"
              />
              <NetworkKpiCard label="Expired on hand" value={formatQty(data.summary.expiredQtyOnHand)} />
              <NetworkKpiCard
                label="Quarantine qty"
                value={formatQty(data.summary.quarantineQty)}
                hint="EXPIRED/DAMAGE/RETURN"
              />
            </div>

            <section>
              <h4 className="font-semibold text-gray-900 mb-3">Stock by store</h4>
              <ResponsiveTableWrapper>
                <table className="min-w-full text-sm">
                  <thead className="bg-gray-50 text-left text-xs text-gray-600 uppercase">
                    <tr>
                      <th className="px-3 py-2">Store</th>
                      <th className="px-3 py-2">Type</th>
                      <th className="px-3 py-2 text-right">Products</th>
                      <th className="px-3 py-2 text-right">Lots</th>
                      <th className="px-3 py-2 text-right">Sellable (base)</th>
                      <th className="px-3 py-2 text-right">Reserved</th>
                      <th className="px-3 py-2 text-right">Value</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y bg-white">
                    {data.stockByStore.map((row) => (
                      <tr key={row.storeLocationId}>
                        <td className="px-3 py-2">
                          <Link
                            to={`/inventory/stores/${row.storeLocationId}`}
                            className="font-medium text-blue-600 hover:underline"
                          >
                            {row.storeName}
                          </Link>
                          <div className="text-xs text-gray-500">{row.storeCode}</div>
                        </td>
                        <td className="px-3 py-2 text-gray-700">{row.storeType}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{row.productCount}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{row.lotCount}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatQty(row.sellableQty)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatQty(row.reservedQty)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {formatMoney(row.inventoryValue)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ResponsiveTableWrapper>
            </section>

            <div className="grid gap-8 lg:grid-cols-2">
              <section>
                <h4 className="font-semibold text-gray-900 mb-3">Transfer activity ({days}d)</h4>
                {data.transferActivity.length === 0 ? (
                  <p className="text-sm text-gray-500">No transfers in this period.</p>
                ) : (
                  <ResponsiveTableWrapper>
                    <table className="min-w-full text-sm">
                      <thead className="bg-gray-50 text-left text-xs text-gray-600 uppercase">
                        <tr>
                          <th className="px-3 py-2">Status</th>
                          <th className="px-3 py-2 text-right">Count</th>
                          <th className="px-3 py-2 text-right">Qty</th>
                          <th className="px-3 py-2 text-right">Value</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y bg-white">
                        {data.transferActivity.map((row) => (
                          <tr key={row.status}>
                            <td className="px-3 py-2">{row.status}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{row.count}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{formatQty(row.totalQty)}</td>
                            <td className="px-3 py-2 text-right tabular-nums">
                              {formatMoney(row.totalValue)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </ResponsiveTableWrapper>
                )}
              </section>

              <section>
                <h4 className="font-semibold text-gray-900 mb-3">Transfers by store ({days}d)</h4>
                {data.transfersByStore.length === 0 ? (
                  <p className="text-sm text-gray-500">No store-level transfer flow yet.</p>
                ) : (
                  <ResponsiveTableWrapper>
                    <table className="min-w-full text-sm">
                      <thead className="bg-gray-50 text-left text-xs text-gray-600 uppercase">
                        <tr>
                          <th className="px-3 py-2">Store</th>
                          <th className="px-3 py-2">Dir</th>
                          <th className="px-3 py-2 text-right">Transfers</th>
                          <th className="px-3 py-2 text-right">Qty</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y bg-white">
                        {data.transfersByStore.map((row) => (
                          <tr key={`${row.storeLocationId}-${row.direction}`}>
                            <td className="px-3 py-2">
                              {row.storeName}
                              <div className="text-xs text-gray-500">{row.storeCode}</div>
                            </td>
                            <td className="px-3 py-2">{row.direction}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{row.transferCount}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{formatQty(row.totalQty)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </ResponsiveTableWrapper>
                )}
              </section>
            </div>

            <div className="grid gap-8 lg:grid-cols-2">
              <section>
                <h4 className="font-semibold text-gray-900 mb-3">Expiry exposure (MAIN + SELLING)</h4>
                {data.expiryExposure.length === 0 ? (
                  <p className="text-sm text-gray-500">
                    No expired or near-expiry stock at selling locations.
                  </p>
                ) : (
                  <ResponsiveTableWrapper>
                    <table className="min-w-full text-sm">
                      <thead className="bg-gray-50 text-left text-xs text-gray-600 uppercase">
                        <tr>
                          <th className="px-3 py-2">Store</th>
                          <th className="px-3 py-2 text-right">Expired</th>
                          <th className="px-3 py-2 text-right">≤30 days</th>
                          <th className="px-3 py-2 text-right">Lots</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y bg-white">
                        {data.expiryExposure.map((row) => (
                          <tr key={row.storeLocationId}>
                            <td className="px-3 py-2">{row.storeName}</td>
                            <td className="px-3 py-2 text-right tabular-nums text-red-700">
                              {formatQty(row.expiredQty)}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums text-amber-700">
                              {formatQty(row.expiringWithin30DaysQty)}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums">{row.lotCount}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </ResponsiveTableWrapper>
                )}
              </section>

              <section>
                <h4 className="font-semibold text-gray-900 mb-3">Quarantine stores</h4>
                {data.quarantineStores.length === 0 ? (
                  <p className="text-sm text-gray-500">
                    No stock in EXPIRED, DAMAGE, or RETURN stores.
                  </p>
                ) : (
                  <ResponsiveTableWrapper>
                    <table className="min-w-full text-sm">
                      <thead className="bg-gray-50 text-left text-xs text-gray-600 uppercase">
                        <tr>
                          <th className="px-3 py-2">Store</th>
                          <th className="px-3 py-2">Type</th>
                          <th className="px-3 py-2 text-right">Products</th>
                          <th className="px-3 py-2 text-right">Qty</th>
                          <th className="px-3 py-2 text-right">Value</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y bg-white">
                        {data.quarantineStores.map((row) => (
                          <tr key={row.storeLocationId}>
                            <td className="px-3 py-2">{row.storeName}</td>
                            <td className="px-3 py-2">{row.storeType}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{row.productCount}</td>
                            <td className="px-3 py-2 text-right tabular-nums">
                              {formatQty(row.sellableQty)}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums">
                              {formatMoney(row.inventoryValue)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </ResponsiveTableWrapper>
                )}
              </section>
            </div>
          </>
        )}
      </div>
    </Layout>
  );
}
