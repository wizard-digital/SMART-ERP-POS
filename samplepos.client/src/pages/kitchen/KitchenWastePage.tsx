/**
 * Kitchen Production Phase 4 — Waste / Yield workspace (ADR-005).
 * Write off leftovers, cooking loss, spoilage into Inventory Engine (LOSS_DISPOSAL).
 */

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Layout from '../../components/Layout';
import { api } from '../../utils/api';
import { useCanAccess } from '../../authorization/useAuthorization';
import { toast } from 'react-hot-toast';
import { toastApiError } from '../../utils/errorHandler';

interface WasteLine {
  productId: string;
  productName?: string;
  plannedQtyBase: number;
  qtyBase: number;
}

interface WasteDoc {
  id: string;
  documentNumber: string;
  documentType: string;
  status: string;
  wasteDate: string;
  reason: string;
  expenseAccountCode: string | null;
  totalCost: number;
  notes: string | null;
  buffetSessionNumber?: string;
  lines: WasteLine[];
}

interface ProductOpt {
  id: string;
  name: string;
  productType?: string;
  isPreparedFood?: boolean;
}

const REASONS = [
  { value: 'LEFTOVER', label: 'Leftover' },
  { value: 'COOKING_LOSS', label: 'Cooking loss / trim' },
  { value: 'STAFF_MEAL', label: 'Staff meal' },
  { value: 'SPOILAGE', label: 'Spoilage' },
  { value: 'OVERPRODUCTION', label: 'Overproduction' },
  { value: 'OTHER', label: 'Other' },
] as const;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function KitchenWastePage() {
  const queryClient = useQueryClient();
  const canRead = useCanAccess(undefined, ['kitchen.production.read']);
  const canCreate = useCanAccess(undefined, ['kitchen.production.create']);
  const canPost = useCanAccess(undefined, ['kitchen.production.post']);

  const [reason, setReason] = useState<string>('LEFTOVER');
  const [wasteDate, setWasteDate] = useState(todayIso);
  const [storeLocationId, setStoreLocationId] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<WasteLine[]>([]);
  const [filter, setFilter] = useState('');

  const enabledQuery = useQuery({
    queryKey: ['kitchen-production', 'enabled'],
    queryFn: async () => {
      const res = await api.kitchenProduction.enabled();
      return Boolean(res.data.data?.enabled);
    },
  });

  const listQuery = useQuery({
    queryKey: ['kitchen-production', 'waste'],
    queryFn: async () => {
      const res = await api.kitchenProduction.listWaste({ limit: 50 });
      return (res.data.data || []) as WasteDoc[];
    },
    enabled: !!enabledQuery.data && canRead,
  });

  const productsQuery = useQuery({
    queryKey: ['kitchen-production', 'producible', 'waste'],
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
    enabled: !!enabledQuery.data && canCreate,
  });

  const storesQuery = useQuery({
    queryKey: ['store-locations', 'kitchen-waste'],
    queryFn: async () => {
      try {
        const res = await api.warehouse.storeLocations.list();
        return (res.data.data || []) as Array<{ id: string; name: string; code?: string }>;
      } catch {
        return [];
      }
    },
    enabled: !!enabledQuery.data && canCreate,
  });

  const stockProducts = useMemo(
    () =>
      (productsQuery.data || []).filter(
        (p) => String(p.productType || 'inventory').toLowerCase() !== 'service',
      ),
    [productsQuery.data],
  );

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const rows = listQuery.data || [];
    if (!q) return rows;
    return rows.filter(
      (d) =>
        d.documentNumber.toLowerCase().includes(q) ||
        d.reason.toLowerCase().includes(q) ||
        d.status.toLowerCase().includes(q),
    );
  }, [listQuery.data, filter]);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['kitchen-production', 'waste'] });
  };

  const addLine = (productId: string) => {
    if (!productId) return;
    if (lines.some((l) => l.productId === productId)) {
      toast.error('Product already on document');
      return;
    }
    const p = stockProducts.find((x) => x.id === productId);
    setLines((prev) => [
      ...prev,
      {
        productId,
        productName: p?.name,
        plannedQtyBase: 0,
        qtyBase: 1,
      },
    ]);
  };

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!lines.length) throw new Error('Add at least one product line');
      const res = await api.kitchenProduction.createWaste({
        documentType: 'WASTE_YIELD',
        wasteDate,
        reason,
        storeLocationId: storeLocationId || null,
        notes: notes || null,
        lines: lines.map((l, i) => ({
          productId: l.productId,
          plannedQtyBase: l.plannedQtyBase,
          qtyBase: l.qtyBase,
          sortOrder: i,
        })),
      });
      return res.data.data as WasteDoc;
    },
    onSuccess: () => {
      toast.success('Waste draft created');
      setLines([]);
      setNotes('');
      invalidate();
    },
    onError: (err) => toastApiError(err, 'Create failed'),
  });

  const postMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await api.kitchenProduction.postWaste(id);
      return res.data.data;
    },
    onSuccess: () => {
      toast.success('Posted — inventory written off (loss expense)');
      invalidate();
    },
    onError: (err) => toastApiError(err, 'Post failed'),
  });

  const cancelMutation = useMutation({
    mutationFn: async (id: string) => {
      await api.kitchenProduction.cancelWaste(id);
    },
    onSuccess: () => {
      toast.success('Draft cancelled');
      invalidate();
    },
    onError: (err) => toastApiError(err, 'Cancel failed'),
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
          <h1 className="text-xl font-semibold text-stone-900">Kitchen Waste & Yield</h1>
          <p className="mt-3 text-stone-600">
            Disabled. Turn on <strong>Restaurant Module</strong>, then Enable Kitchen Production, in
            system settings (migration 590).
          </p>
        </div>
      </Layout>
    );
  }

  if (!canRead) {
    return (
      <Layout>
        <div className="p-6 text-stone-600">You do not have permission to view kitchen waste.</div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="mx-auto max-w-6xl space-y-8 p-4 sm:p-6">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold text-stone-900">Kitchen Waste & Yield</h1>
            <p className="mt-1 max-w-2xl text-sm text-stone-600">
              Write off leftovers, cooking loss, and spoilage. Posts through inventory lots (FEFO) as
              loss disposal — not a second stock ledger.
            </p>
          </div>
          <div className="flex flex-wrap gap-3 text-sm">
            <Link
              to="/kitchen/buffet-sessions"
              className="font-medium text-amber-900 underline-offset-2 hover:underline"
            >
              Buffet sessions
            </Link>
            <Link
              to="/kitchen/analytics"
              className="font-medium text-amber-900 underline-offset-2 hover:underline"
            >
              Food-cost analytics
            </Link>
            <Link
              to="/kitchen/production"
              className="font-medium text-amber-900 underline-offset-2 hover:underline"
            >
              Production batches
            </Link>
            <Link
              to="/kitchen/store-issues"
              className="font-medium text-amber-900 underline-offset-2 hover:underline"
            >
              Store issue
            </Link>
          </div>
        </header>

        {canCreate && (
          <section className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">
              New waste document
            </h2>
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <label className="block text-sm">
                <span className="text-stone-600">Reason</span>
                <select
                  className="mt-1 w-full rounded border border-stone-300 px-2 py-1.5"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                >
                  {REASONS.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm">
                <span className="text-stone-600">Date</span>
                <input
                  type="date"
                  className="mt-1 w-full rounded border border-stone-300 px-2 py-1.5"
                  value={wasteDate}
                  onChange={(e) => setWasteDate(e.target.value)}
                />
              </label>
              {(storesQuery.data || []).length > 0 && (
                <label className="block text-sm">
                  <span className="text-stone-600">Kitchen store</span>
                  <select
                    className="mt-1 w-full rounded border border-stone-300 px-2 py-1.5"
                    value={storeLocationId}
                    onChange={(e) => setStoreLocationId(e.target.value)}
                  >
                    <option value="">Select…</option>
                    {(storesQuery.data || []).map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                        {s.code ? ` (${s.code})` : ''}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="block text-sm sm:col-span-2 lg:col-span-3">
                <span className="text-stone-600">Notes</span>
                <input
                  className="mt-1 w-full rounded border border-stone-300 px-2 py-1.5"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </label>
            </div>

            <div className="mt-4 border-t border-stone-100 pt-4">
              <label className="block text-sm">
                <span className="text-stone-600">Add product</span>
                <select
                  className="mt-1 w-full max-w-md rounded border border-stone-300 px-2 py-1.5"
                  defaultValue=""
                  onChange={(e) => {
                    addLine(e.target.value);
                    e.target.value = '';
                  }}
                >
                  <option value="">Select…</option>
                  {stockProducts.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                      {p.isPreparedFood ? ' · prepared' : ''}
                    </option>
                  ))}
                </select>
              </label>
              {lines.length > 0 && (
                <ul className="mt-3 divide-y divide-stone-100 rounded border border-stone-200">
                  {lines.map((l, idx) => (
                    <li
                      key={l.productId}
                      className="flex flex-wrap items-center gap-2 p-2 text-sm"
                    >
                      <span className="min-w-[8rem] flex-1 font-medium text-stone-800">
                        {l.productName || l.productId}
                      </span>
                      <label className="flex items-center gap-1">
                        Qty
                        <input
                          type="number"
                          min={0.000001}
                          step="any"
                          className="w-24 rounded border border-stone-300 px-2 py-1"
                          value={l.qtyBase}
                          onChange={(e) => {
                            const v = Number(e.target.value);
                            setLines((prev) =>
                              prev.map((row, i) => (i === idx ? { ...row, qtyBase: v } : row)),
                            );
                          }}
                        />
                      </label>
                      <button
                        type="button"
                        className="text-red-700 hover:underline"
                        onClick={() => setLines((prev) => prev.filter((_, i) => i !== idx))}
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="mt-4">
              <button
                type="button"
                disabled={createMutation.isPending}
                onClick={() => createMutation.mutate()}
                className="rounded bg-amber-800 px-4 py-2 text-sm font-medium text-white hover:bg-amber-900 disabled:opacity-50"
              >
                Create draft
              </button>
            </div>
          </section>
        )}

        <section>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">
              Documents
            </h2>
            <input
              className="ml-auto rounded border border-stone-300 px-2 py-1 text-sm"
              placeholder="Filter…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>

          {listQuery.isLoading ? (
            <p className="text-sm text-stone-500">Loading…</p>
          ) : filtered.length === 0 ? (
            <p className="rounded border border-dashed border-stone-300 p-6 text-sm text-stone-500">
              No waste documents yet.
            </p>
          ) : (
            <ul className="space-y-3">
              {filtered.map((d) => (
                <li
                  key={d.id}
                  className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-sm text-stone-500">
                          {d.documentNumber}
                        </span>
                        <span className="rounded bg-stone-100 px-2 py-0.5 text-xs font-medium text-stone-700">
                          {d.status}
                        </span>
                        <span className="text-xs text-stone-500">{d.documentType}</span>
                      </div>
                      <p className="mt-1 text-sm text-stone-800">
                        {d.reason} · {d.wasteDate}
                        {d.expenseAccountCode ? ` · acct ${d.expenseAccountCode}` : ''}
                        {d.status === 'POSTED' ? ` · cost ${d.totalCost.toFixed(2)}` : ''}
                      </p>
                      {d.buffetSessionNumber && (
                        <p className="text-xs text-stone-500">Session {d.buffetSessionNumber}</p>
                      )}
                      {d.lines?.length > 0 && (
                        <ul className="mt-2 text-xs text-stone-600">
                          {d.lines.map((l) => (
                            <li key={l.productId}>
                              {l.productName || l.productId}: {l.qtyBase}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {d.status === 'DRAFT' && canPost && (
                        <button
                          type="button"
                          className="rounded bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-800"
                          disabled={postMutation.isPending}
                          onClick={() => postMutation.mutate(d.id)}
                        >
                          Post
                        </button>
                      )}
                      {d.status === 'DRAFT' && canCreate && (
                        <button
                          type="button"
                          className="rounded border border-red-300 px-3 py-1.5 text-xs font-medium text-red-800 hover:bg-red-50"
                          disabled={cancelMutation.isPending}
                          onClick={() => {
                            if (window.confirm(`Cancel ${d.documentNumber}?`)) {
                              cancelMutation.mutate(d.id);
                            }
                          }}
                        >
                          Cancel
                        </button>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Layout>
  );
}
