/**
 * Kitchen Hub — ADR-005 Phase 6 central board.
 * One place for produce / start service / waste / end service (no multi-page draft rounds).
 */

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Layout from '../../components/Layout';
import { api } from '../../utils/api';
import { useCanAccess } from '../../authorization/useAuthorization';
import { toast } from 'react-hot-toast';
import { toastApiError } from '../../utils/errorHandler';

type OpsBoard = {
  serviceDate: string;
  nextAction: { code: string; title: string; detail: string; primary: boolean };
  openSessions: Array<{
    id: string;
    documentNumber: string;
    name: string;
    soldCovers: number;
    expectedCovers: number;
    remainingCovers: number | null;
    coverProductName?: string;
  }>;
  todayBatches: {
    count: number;
    totalIngredientCost: number;
    totalOutputQty: number;
    items: Array<{
      id: string;
      documentNumber: string;
      status: string;
      outputProductName?: string;
      outputQtyBase: number;
      totalIngredientCost: number;
    }>;
  };
  preparedStock: Array<{ productId: string; productName: string; qtyOnHand: number }>;
  todayWaste: { count: number; totalCost: number };
  kpis: {
    productionCost: number;
    wasteCost: number;
    soldCovers: number;
    coverRevenue: number;
    foodCostPercent: number | null;
  };
};

type ProductOpt = {
  id: string;
  name: string;
  productType?: string;
  isBuffetCover?: boolean;
  isPreparedFood?: boolean;
};

function money(n: number): string {
  return Number(n || 0).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

export default function KitchenHubPage() {
  const queryClient = useQueryClient();
  const canRead = useCanAccess(undefined, ['kitchen.production.read']);
  const canPost = useCanAccess(undefined, ['kitchen.production.post']);

  const [outputProductId, setOutputProductId] = useState('');
  const [outputQty, setOutputQty] = useState('10');
  const [storeLocationId, setStoreLocationId] = useState('');

  const [serviceName, setServiceName] = useState('Meal service');
  const [coverProductId, setCoverProductId] = useState('');
  const [expectedCovers, setExpectedCovers] = useState('50');

  const [wasteProductId, setWasteProductId] = useState('');
  const [wasteQty, setWasteQty] = useState('1');
  const [wasteReason, setWasteReason] = useState('COOKING_LOSS');

  const [leftoverProductId, setLeftoverProductId] = useState('');
  const [leftoverQty, setLeftoverQty] = useState('');
  const [endSessionId, setEndSessionId] = useState('');

  const enabledQuery = useQuery({
    queryKey: ['kitchen-production', 'enabled'],
    queryFn: async () => {
      const res = await api.kitchenProduction.enabled();
      return Boolean(res.data.data?.enabled);
    },
  });

  const boardQuery = useQuery({
    queryKey: ['kitchen-production', 'ops-board'],
    queryFn: async () => {
      const res = await api.kitchenProduction.opsBoard();
      return res.data.data as OpsBoard;
    },
    enabled: !!enabledQuery.data && canRead,
    refetchInterval: 20_000,
  });

  const productsQuery = useQuery({
    queryKey: ['kitchen-production', 'hub-products'],
    queryFn: async () => {
      try {
        const res = await api.kitchenProduction.listProducibleProducts({
          preparedOnly: false,
          limit: 400,
        });
        return (res.data.data || []) as ProductOpt[];
      } catch {
        const res = await api.products.list({ limit: 500 });
        const raw = res.data.data as unknown;
        return Array.isArray(raw) ? (raw as ProductOpt[]) : [];
      }
    },
    enabled: !!enabledQuery.data && canPost,
  });

  const allProductsQuery = useQuery({
    queryKey: ['products', 'kitchen-hub-covers'],
    queryFn: async () => {
      const res = await api.products.list({ limit: 500 });
      const raw = res.data.data as unknown;
      return Array.isArray(raw) ? (raw as ProductOpt[]) : [];
    },
    enabled: !!enabledQuery.data && canPost,
  });

  const storesQuery = useQuery({
    queryKey: ['store-locations', 'kitchen-hub'],
    queryFn: async () => {
      try {
        const res = await api.warehouse.storeLocations.list();
        return (res.data.data || []) as Array<{ id: string; name: string }>;
      } catch {
        return [];
      }
    },
    enabled: !!enabledQuery.data && canPost,
  });

  const coverProducts = useMemo(() => {
    const all = allProductsQuery.data || productsQuery.data || [];
    const covers = all.filter(
      (p) =>
        p.isBuffetCover ||
        String(p.productType || '').toLowerCase() === 'service' ||
        /cover|buffet|meal/i.test(p.name || ''),
    );
    return covers.length ? covers : all;
  }, [allProductsQuery.data, productsQuery.data]);

  const stockProducts = useMemo(
    () =>
      (productsQuery.data || []).filter(
        (p) => String(p.productType || 'inventory').toLowerCase() !== 'service',
      ),
    [productsQuery.data],
  );

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['kitchen-production'] });
  };

  const produceMutation = useMutation({
    mutationFn: async () => {
      const qty = Number(outputQty);
      if (!outputProductId) throw new Error('Select finished product');
      if (!(qty > 0)) throw new Error('Qty must be positive');
      const res = await api.kitchenProduction.quickProduce({
        outputProductId,
        outputQtyBase: qty,
        storeLocationId: storeLocationId || null,
      });
      return res.data.data as { documentNumber?: string };
    },
    onSuccess: (data) => {
      toast.success(`Produced ${data.documentNumber || 'batch'} — stock updated`);
      refresh();
    },
    onError: (err) => toastApiError(err, 'Produce failed'),
  });

  const startMutation = useMutation({
    mutationFn: async () => {
      const covers = Number(expectedCovers);
      if (!coverProductId) throw new Error('Select cover product');
      if (!(covers >= 0)) throw new Error('Expected covers invalid');
      const res = await api.kitchenProduction.startService({
        name: serviceName.trim() || 'Meal service',
        coverProductId,
        expectedCovers: covers,
        allowOverbook: true,
        storeLocationId: storeLocationId || null,
        lines: boardQuery.data?.preparedStock.slice(0, 8).map((s) => ({
          preparedProductId: s.productId,
          plannedQtyBase: s.qtyOnHand,
        })),
      });
      return res.data.data as { documentNumber?: string };
    },
    onSuccess: (data) => {
      toast.success(`Service open ${data.documentNumber || ''} — sell covers on POS`);
      refresh();
    },
    onError: (err) => toastApiError(err, 'Start service failed'),
  });

  const wasteMutation = useMutation({
    mutationFn: async () => {
      const qty = Number(wasteQty);
      if (!wasteProductId) throw new Error('Select product');
      if (!(qty > 0)) throw new Error('Qty must be positive');
      const res = await api.kitchenProduction.quickWaste({
        reason: wasteReason,
        storeLocationId: storeLocationId || null,
        lines: [{ productId: wasteProductId, qtyBase: qty }],
      });
      return res.data.data as { documentNumber?: string; totalCost?: number };
    },
    onSuccess: (data) => {
      toast.success(`Waste posted ${data.documentNumber || ''} ($${money(data.totalCost || 0)})`);
      refresh();
    },
    onError: (err) => toastApiError(err, 'Waste failed'),
  });

  const endMutation = useMutation({
    mutationFn: async () => {
      const sessionId = endSessionId || boardQuery.data?.openSessions[0]?.id;
      if (!sessionId) throw new Error('No open session');
      const leftoverLines =
        leftoverProductId && Number(leftoverQty) > 0
          ? [{ productId: leftoverProductId, qtyBase: Number(leftoverQty) }]
          : undefined;
      const res = await api.kitchenProduction.endService({
        sessionId,
        leftoverLines,
        reason: 'LEFTOVER',
        storeLocationId: storeLocationId || null,
      });
      return res.data.data as { sessionId: string; wasteDocumentId: string | null };
    },
    onSuccess: (data) => {
      toast.success(
        data.wasteDocumentId
          ? 'Service closed with leftover waste'
          : 'Service closed (no leftovers)',
      );
      setLeftoverProductId('');
      setLeftoverQty('');
      refresh();
    },
    onError: (err) => toastApiError(err, 'End service failed'),
  });

  if (enabledQuery.isLoading) {
    return (
      <Layout>
        <div className="p-6 text-stone-600">Loading…</div>
      </Layout>
    );
  }

  if (!enabledQuery.data) {
    return (
      <Layout>
        <div className="mx-auto max-w-2xl p-6">
          <h1 className="text-xl font-semibold text-stone-900">Kitchen Production</h1>
          <p className="mt-3 text-stone-600">
            Disabled. Turn on <strong>Restaurant Module</strong>, then{' '}
            <strong>Enable Kitchen Production</strong> in system settings. Pure retail tenants leave
            restaurant mode off — this module will not appear or run.
          </p>
          <p className="mt-3 text-stone-600">
            To consume store goods without recipes or production batches, use{' '}
            <Link to="/kitchen/store-issues" className="font-medium text-amber-900 underline">
              Store Issue to Expense
            </Link>
            .
          </p>
        </div>
      </Layout>
    );
  }

  if (!canRead) {
    return (
      <Layout>
        <div className="p-6 text-stone-600">You do not have permission to view kitchen operations.</div>
      </Layout>
    );
  }

  const board = boardQuery.data;
  const next = board?.nextAction;

  return (
    <Layout>
      <div className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold text-stone-900">Kitchen Production</h1>
            <p className="mt-1 max-w-2xl text-sm text-stone-600">
              Central ops board — one action posts inventory immediately. No draft → open → post
              rounds for produce, service, waste, or close.
            </p>
          </div>
          <div className="flex flex-col items-end gap-1">
            <p className="text-sm text-stone-500">
              Business day <span className="font-medium text-stone-800">{board?.serviceDate || '…'}</span>
            </p>
            <Link
              to="/kitchen/store-issues"
              className="text-sm font-medium text-amber-900 underline-offset-2 hover:underline"
            >
              Store issue to expense
            </Link>
          </div>
        </header>

        {next && (
          <section className="rounded-lg border border-amber-200 bg-amber-50/80 px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-amber-900/70">
              Next step
            </p>
            <p className="mt-1 text-base font-semibold text-amber-950">{next.title}</p>
            <p className="mt-1 text-sm text-amber-950/80">{next.detail}</p>
          </section>
        )}

        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {[
            { label: 'Production $', value: money(board?.kpis.productionCost ?? 0) },
            { label: 'Waste $', value: money(board?.kpis.wasteCost ?? 0) },
            { label: 'Sold covers', value: String(board?.kpis.soldCovers ?? 0) },
            { label: 'Cover revenue', value: money(board?.kpis.coverRevenue ?? 0) },
            {
              label: 'Food cost %',
              value:
                board?.kpis.foodCostPercent == null
                  ? '—'
                  : `${money(board.kpis.foodCostPercent)}%`,
            },
          ].map((k) => (
            <div key={k.label} className="rounded-lg border border-stone-200 bg-white px-3 py-3">
              <p className="text-xs text-stone-500">{k.label}</p>
              <p className="mt-1 text-lg font-semibold text-stone-900">{k.value}</p>
            </div>
          ))}
        </section>

        {canPost && (
          <div className="grid gap-4 lg:grid-cols-2">
            {/* Produce */}
            <section className="rounded-lg border border-stone-200 bg-white p-4">
              <h2 className="text-sm font-semibold text-stone-800">1. Produce (one shot)</h2>
              <p className="mt-1 text-xs text-stone-500">
                Recipe → FEFO issue → finished lot receipt. No separate draft screen.
              </p>
              <div className="mt-3 grid gap-2">
                <select
                  className="w-full rounded border border-stone-300 px-2 py-2 text-sm"
                  value={outputProductId}
                  onChange={(e) => setOutputProductId(e.target.value)}
                >
                  <option value="">Finished product…</option>
                  {stockProducts.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                      {p.isPreparedFood ? ' · prepared' : ''}
                    </option>
                  ))}
                </select>
                <div className="flex gap-2">
                  <input
                    type="number"
                    min={0.001}
                    step="any"
                    className="w-28 rounded border border-stone-300 px-2 py-2 text-sm"
                    value={outputQty}
                    onChange={(e) => setOutputQty(e.target.value)}
                  />
                  {(storesQuery.data || []).length > 0 && (
                    <select
                      className="min-w-0 flex-1 rounded border border-stone-300 px-2 py-2 text-sm"
                      value={storeLocationId}
                      onChange={(e) => setStoreLocationId(e.target.value)}
                    >
                      <option value="">Kitchen store (optional)</option>
                      {storesQuery.data!.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
                <button
                  type="button"
                  disabled={produceMutation.isPending}
                  onClick={() => produceMutation.mutate()}
                  className="rounded bg-amber-900 px-3 py-2 text-sm font-medium text-white hover:bg-amber-950 disabled:opacity-50"
                >
                  {produceMutation.isPending ? 'Producing…' : 'Produce & receive stock'}
                </button>
              </div>
            </section>

            {/* Start service */}
            <section className="rounded-lg border border-stone-200 bg-white p-4">
              <h2 className="text-sm font-semibold text-stone-800">2. Start service (one shot)</h2>
              <p className="mt-1 text-xs text-stone-500">
                Create + open buffet capacity so POS cover sales attach automatically.
              </p>
              <div className="mt-3 grid gap-2">
                <input
                  className="w-full rounded border border-stone-300 px-2 py-2 text-sm"
                  value={serviceName}
                  onChange={(e) => setServiceName(e.target.value)}
                  placeholder="Service name"
                />
                <select
                  className="w-full rounded border border-stone-300 px-2 py-2 text-sm"
                  value={coverProductId}
                  onChange={(e) => setCoverProductId(e.target.value)}
                >
                  <option value="">Cover product…</option>
                  {coverProducts.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <input
                  type="number"
                  min={0}
                  className="w-32 rounded border border-stone-300 px-2 py-2 text-sm"
                  value={expectedCovers}
                  onChange={(e) => setExpectedCovers(e.target.value)}
                />
                <button
                  type="button"
                  disabled={startMutation.isPending}
                  onClick={() => startMutation.mutate()}
                  className="rounded bg-amber-900 px-3 py-2 text-sm font-medium text-white hover:bg-amber-950 disabled:opacity-50"
                >
                  {startMutation.isPending ? 'Opening…' : 'Open service for POS'}
                </button>
              </div>
            </section>

            {/* Quick waste */}
            <section className="rounded-lg border border-stone-200 bg-white p-4">
              <h2 className="text-sm font-semibold text-stone-800">3. Waste (one shot)</h2>
              <p className="mt-1 text-xs text-stone-500">Post cooking loss / spoilage in one click.</p>
              <div className="mt-3 grid gap-2">
                <select
                  className="w-full rounded border border-stone-300 px-2 py-2 text-sm"
                  value={wasteProductId}
                  onChange={(e) => setWasteProductId(e.target.value)}
                >
                  <option value="">Product…</option>
                  {(board?.preparedStock?.length ? board.preparedStock : stockProducts).map((p) => {
                    const id = 'productId' in p ? p.productId : p.id;
                    const name = 'productName' in p ? p.productName : p.name;
                    return (
                      <option key={id} value={id}>
                        {name}
                      </option>
                    );
                  })}
                </select>
                <div className="flex gap-2">
                  <input
                    type="number"
                    min={0.001}
                    step="any"
                    className="w-28 rounded border border-stone-300 px-2 py-2 text-sm"
                    value={wasteQty}
                    onChange={(e) => setWasteQty(e.target.value)}
                  />
                  <select
                    className="min-w-0 flex-1 rounded border border-stone-300 px-2 py-2 text-sm"
                    value={wasteReason}
                    onChange={(e) => setWasteReason(e.target.value)}
                  >
                    <option value="COOKING_LOSS">Cooking loss</option>
                    <option value="LEFTOVER">Leftover</option>
                    <option value="SPOILAGE">Spoilage</option>
                    <option value="STAFF_MEAL">Staff meal</option>
                    <option value="OVERPRODUCTION">Overproduction</option>
                    <option value="OTHER">Other</option>
                  </select>
                </div>
                <button
                  type="button"
                  disabled={wasteMutation.isPending}
                  onClick={() => wasteMutation.mutate()}
                  className="rounded border border-stone-300 bg-stone-50 px-3 py-2 text-sm font-medium text-stone-800 hover:bg-stone-100 disabled:opacity-50"
                >
                  {wasteMutation.isPending ? 'Posting…' : 'Post waste now'}
                </button>
              </div>
            </section>

            {/* End service */}
            <section className="rounded-lg border border-stone-200 bg-white p-4">
              <h2 className="text-sm font-semibold text-stone-800">4. End service (one shot)</h2>
              <p className="mt-1 text-xs text-stone-500">
                Close open session; optionally write off leftovers in the same action.
              </p>
              <div className="mt-3 grid gap-2">
                <select
                  className="w-full rounded border border-stone-300 px-2 py-2 text-sm"
                  value={endSessionId || board?.openSessions[0]?.id || ''}
                  onChange={(e) => setEndSessionId(e.target.value)}
                  disabled={!board?.openSessions.length}
                >
                  {!board?.openSessions.length && <option value="">No open session</option>}
                  {(board?.openSessions || []).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.documentNumber} · {s.name} · {s.soldCovers}/{s.expectedCovers} covers
                    </option>
                  ))}
                </select>
                <div className="flex gap-2">
                  <select
                    className="min-w-0 flex-1 rounded border border-stone-300 px-2 py-2 text-sm"
                    value={leftoverProductId}
                    onChange={(e) => setLeftoverProductId(e.target.value)}
                  >
                    <option value="">Leftover product (optional)</option>
                    {(board?.preparedStock || []).map((p) => (
                      <option key={p.productId} value={p.productId}>
                        {p.productName} ({money(p.qtyOnHand)} on hand)
                      </option>
                    ))}
                  </select>
                  <input
                    type="number"
                    min={0}
                    step="any"
                    placeholder="Qty"
                    className="w-24 rounded border border-stone-300 px-2 py-2 text-sm"
                    value={leftoverQty}
                    onChange={(e) => setLeftoverQty(e.target.value)}
                  />
                </div>
                <button
                  type="button"
                  disabled={endMutation.isPending || !board?.openSessions.length}
                  onClick={() => endMutation.mutate()}
                  className="rounded bg-stone-800 px-3 py-2 text-sm font-medium text-white hover:bg-stone-900 disabled:opacity-50"
                >
                  {endMutation.isPending ? 'Closing…' : 'Close service'}
                </button>
              </div>
            </section>
          </div>
        )}

        <div className="grid gap-4 lg:grid-cols-2">
          <section className="rounded-lg border border-stone-200 bg-white p-4">
            <h2 className="text-sm font-semibold text-stone-800">Open service</h2>
            {!board?.openSessions.length ? (
              <p className="mt-2 text-sm text-stone-500">None open — start service when FG is ready.</p>
            ) : (
              <ul className="mt-2 divide-y divide-stone-100 text-sm">
                {board.openSessions.map((s) => (
                  <li key={s.id} className="flex justify-between gap-2 py-2">
                    <span>
                      <span className="font-medium text-stone-900">{s.documentNumber}</span>{' '}
                      {s.name}
                      <span className="block text-xs text-stone-500">
                        {s.coverProductName || 'cover'} · sold {s.soldCovers} / {s.expectedCovers}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="rounded-lg border border-stone-200 bg-white p-4">
            <h2 className="text-sm font-semibold text-stone-800">Today production</h2>
            {!board?.todayBatches.items.length ? (
              <p className="mt-2 text-sm text-stone-500">No batches yet today.</p>
            ) : (
              <ul className="mt-2 max-h-48 divide-y divide-stone-100 overflow-auto text-sm">
                {board.todayBatches.items.map((b) => (
                  <li key={b.id} className="flex justify-between gap-2 py-2">
                    <span>
                      <span className="font-medium">{b.documentNumber}</span>{' '}
                      <span className="text-stone-500">{b.status}</span>
                      <span className="block text-xs text-stone-500">
                        {b.outputProductName} × {money(b.outputQtyBase)}
                      </span>
                    </span>
                    <span className="text-stone-700">${money(b.totalIngredientCost)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="rounded-lg border border-stone-200 bg-white p-4 lg:col-span-2">
            <h2 className="text-sm font-semibold text-stone-800">Prepared food on hand</h2>
            {!board?.preparedStock.length ? (
              <p className="mt-2 text-sm text-stone-500">No prepared food QOH — produce first.</p>
            ) : (
              <ul className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {board.preparedStock.map((p) => (
                  <li
                    key={p.productId}
                    className="flex justify-between rounded border border-stone-100 px-3 py-2 text-sm"
                  >
                    <span className="text-stone-800">{p.productName}</span>
                    <span className="font-medium text-stone-900">{money(p.qtyOnHand)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <footer className="flex flex-wrap gap-4 border-t border-stone-200 pt-4 text-sm text-stone-600">
          <span className="font-medium text-stone-700">Advanced (optional):</span>
          <Link to="/kitchen/production" className="text-amber-900 underline-offset-2 hover:underline">
            Draft production
          </Link>
          <Link
            to="/kitchen/buffet-sessions"
            className="text-amber-900 underline-offset-2 hover:underline"
          >
            Buffet drafts
          </Link>
          <Link to="/kitchen/waste" className="text-amber-900 underline-offset-2 hover:underline">
            Waste drafts
          </Link>
          <Link to="/kitchen/store-issues" className="text-amber-900 underline-offset-2 hover:underline">
            Store issue to expense
          </Link>
          <Link to="/kitchen/analytics" className="text-amber-900 underline-offset-2 hover:underline">
            Analytics detail
          </Link>
          <Link to="/restaurant/recipes" className="text-amber-900 underline-offset-2 hover:underline">
            Recipes
          </Link>
          <Link to="/pos" className="text-amber-900 underline-offset-2 hover:underline">
            POS (sell covers)
          </Link>
        </footer>
      </div>
    </Layout>
  );
}
