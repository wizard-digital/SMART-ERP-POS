/**
 * Phase 3 — Recipe / BOM editor (+ Kitchen Phase 2 usage mode).
 * AT_SALE: ingredients on payment. AT_PRODUCTION: BOM for kitchen production; sale deducts parent stock.
 */

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Layout from '../../components/Layout';
import { api } from '../../utils/api';
import { useRestaurantEnabled } from '../../hooks/useRestaurantEnabled';
import { useCanAccess } from '../../authorization/useAuthorization';
import { toast } from 'react-hot-toast';
import axios from 'axios';

interface RecipeLine {
  id?: string;
  componentProductId: string;
  componentName?: string;
  quantityBase: string | number;
  sortOrder?: number;
}

interface Recipe {
  id: string;
  parentProductId: string;
  parentProductName?: string;
  name: string;
  isActive: boolean;
  notes: string | null;
  usageMode?: 'AT_SALE' | 'AT_PRODUCTION';
  lines: RecipeLine[];
}

interface MenuProduct {
  id: string;
  name: string;
  sku: string | null;
  categoryName: string | null;
  availableInRestaurant: boolean;
}

function apiErr(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as { error?: string; message?: string } | undefined;
    return data?.error || data?.message || err.message || fallback;
  }
  if (err instanceof Error) return err.message;
  return fallback;
}

export default function RestaurantRecipesPage() {
  const queryClient = useQueryClient();
  const { data: restaurantEnabled, isLoading: flagLoading } = useRestaurantEnabled();
  const canManage = useCanAccess(undefined, ['restaurant.manage']);

  const [parentProductId, setParentProductId] = useState('');
  const [recipeName, setRecipeName] = useState('');
  const [notes, setNotes] = useState('');
  const [usageMode, setUsageMode] = useState<'AT_SALE' | 'AT_PRODUCTION'>('AT_SALE');
  const [lines, setLines] = useState<Array<{ componentProductId: string; quantityBase: string }>>([
    { componentProductId: '', quantityBase: '1' },
  ]);
  const [filter, setFilter] = useState('');

  const recipesQuery = useQuery({
    queryKey: ['restaurant', 'recipes'],
    queryFn: async () => {
      const res = await api.restaurant.listRecipes();
      return (res.data.data || []) as Recipe[];
    },
    enabled: !!restaurantEnabled,
  });

  const productsQuery = useQuery({
    queryKey: ['restaurant', 'menu', 'products', 'recipes'],
    queryFn: async () => {
      const res = await api.restaurant.menuProducts();
      return (res.data.data || []) as MenuProduct[];
    },
    enabled: !!restaurantEnabled && canManage,
  });

  const products = productsQuery.data || [];
  const filteredRecipes = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const all = recipesQuery.data || [];
    if (!q) return all;
    return all.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        (r.parentProductName || '').toLowerCase().includes(q),
    );
  }, [recipesQuery.data, filter]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const cleaned = lines
        .filter((l) => l.componentProductId && Number(l.quantityBase) > 0)
        .map((l, i) => ({
          componentProductId: l.componentProductId,
          quantityBase: Number(l.quantityBase),
          sortOrder: (i + 1) * 10,
        }));
      if (!parentProductId) throw new Error('Select a menu product');
      if (!recipeName.trim()) throw new Error('Enter a recipe name');
      if (cleaned.length === 0) throw new Error('Add at least one ingredient');
      const res = await api.restaurant.upsertRecipe({
        parentProductId,
        name: recipeName.trim(),
        notes: notes.trim() || null,
        isActive: true,
        usageMode,
        lines: cleaned,
      });
      return res.data.data;
    },
    onSuccess: () => {
      toast.success('Recipe saved');
      setParentProductId('');
      setRecipeName('');
      setNotes('');
      setUsageMode('AT_SALE');
      setLines([{ componentProductId: '', quantityBase: '1' }]);
      void queryClient.invalidateQueries({ queryKey: ['restaurant', 'recipes'] });
    },
    onError: (err: unknown) => toast.error(apiErr(err, 'Failed to save recipe')),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await api.restaurant.deleteRecipe(id);
    },
    onSuccess: () => {
      toast.success('Recipe deleted');
      void queryClient.invalidateQueries({ queryKey: ['restaurant', 'recipes'] });
    },
    onError: (err: unknown) => toast.error(apiErr(err, 'Failed to delete recipe')),
  });

  const loadRecipe = (recipe: Recipe) => {
    setParentProductId(recipe.parentProductId);
    setRecipeName(recipe.name);
    setNotes(recipe.notes || '');
    setUsageMode(recipe.usageMode === 'AT_PRODUCTION' ? 'AT_PRODUCTION' : 'AT_SALE');
    setLines(
      recipe.lines.map((l) => ({
        componentProductId: l.componentProductId,
        quantityBase: String(l.quantityBase),
      })),
    );
  };

  if (flagLoading) {
    return (
      <Layout>
        <div className="p-6 text-stone-500">Loading…</div>
      </Layout>
    );
  }

  if (!restaurantEnabled) {
    return (
      <Layout>
        <div className="p-6">
          <p className="text-stone-700">Restaurant module is disabled.</p>
          <Link to="/settings" className="text-amber-700 underline text-sm">
            Enable in Settings
          </Link>
        </div>
      </Layout>
    );
  }

  if (!canManage) {
    return (
      <Layout>
        <div className="p-6 text-stone-600">Recipes require restaurant.manage permission.</div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="p-4 md:p-6 max-w-5xl mx-auto space-y-6">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-xl font-semibold text-stone-900">Recipes / BOM</h1>
            <p className="text-sm text-stone-600 mt-1">
              Cook-to-order: consume on payment. Cook-to-stock: set usage to &quot;On production&quot;
              and produce via Kitchen Production before selling the finished product.
            </p>
          </div>
          <div className="flex gap-3 text-sm">
            <Link to="/kitchen" className="text-amber-900 underline">
              Kitchen Production
            </Link>
            <Link to="/kitchen/store-issues" className="text-amber-900 underline">
              Issue without recipe
            </Link>
            <Link to="/restaurant" className="text-amber-800 underline">
              Back to Restaurant POS
            </Link>
          </div>
        </div>

        <div className="rounded-lg border border-stone-200 bg-white p-4 space-y-3">
          <h2 className="text-sm font-semibold text-stone-800 uppercase tracking-wide">
            {parentProductId && (recipesQuery.data || []).some((r) => r.parentProductId === parentProductId)
              ? 'Edit recipe'
              : 'New recipe'}
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-stone-600">Menu product (parent)</label>
              <select
                className="w-full border border-stone-300 rounded px-2 py-2 text-sm mt-1"
                value={parentProductId}
                onChange={(e) => {
                  setParentProductId(e.target.value);
                  const p = products.find((x) => x.id === e.target.value);
                  if (p && !recipeName) setRecipeName(p.name);
                }}
              >
                <option value="">Select product…</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.categoryName ? ` · ${p.categoryName}` : ''}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs text-stone-600">Recipe name</label>
              <input
                className="w-full border border-stone-300 rounded px-2 py-2 text-sm mt-1"
                value={recipeName}
                onChange={(e) => setRecipeName(e.target.value)}
                placeholder="e.g. Chicken Pilau"
              />
            </div>
          </div>
          <div>
            <label className="text-xs text-stone-600">When are ingredients consumed?</label>
            <select
              className="w-full border border-stone-300 rounded px-2 py-2 text-sm mt-1"
              value={usageMode}
              onChange={(e) => setUsageMode(e.target.value as 'AT_SALE' | 'AT_PRODUCTION')}
            >
              <option value="AT_SALE">On payment (cook-to-order / kit)</option>
              <option value="AT_PRODUCTION">On kitchen production (cook-to-stock)</option>
            </select>
            <p className="text-xs text-stone-500 mt-1">
              {usageMode === 'AT_PRODUCTION'
                ? 'Sale deducts finished goods only. Produce via Kitchen Production first.'
                : 'Sale explodes ingredients (FEFO). No pre-production required.'}
            </p>
          </div>
          <div>
            <label className="text-xs text-stone-600">Notes</label>
            <input
              className="w-full border border-stone-300 rounded px-2 py-2 text-sm mt-1"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional"
            />
          </div>

          <div className="space-y-2">
            <div className="text-xs font-medium text-stone-600 uppercase">Ingredients (base UoM qty)</div>
            {lines.map((line, idx) => (
              <div key={idx} className="grid grid-cols-1 md:grid-cols-12 gap-2">
                <select
                  className="md:col-span-8 border border-stone-300 rounded px-2 py-2 text-sm"
                  value={line.componentProductId}
                  onChange={(e) => {
                    const next = [...lines];
                    next[idx] = { ...next[idx], componentProductId: e.target.value };
                    setLines(next);
                  }}
                >
                  <option value="">Ingredient…</option>
                  {products
                    .filter((p) => p.id !== parentProductId)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                </select>
                <input
                  type="number"
                  min={0}
                  step="any"
                  className="md:col-span-3 border border-stone-300 rounded px-2 py-2 text-sm"
                  value={line.quantityBase}
                  onChange={(e) => {
                    const next = [...lines];
                    next[idx] = { ...next[idx], quantityBase: e.target.value };
                    setLines(next);
                  }}
                  placeholder="Qty"
                />
                <button
                  type="button"
                  className="md:col-span-1 text-sm text-red-700"
                  onClick={() => setLines(lines.filter((_, i) => i !== idx))}
                  disabled={lines.length <= 1}
                >
                  ✕
                </button>
              </div>
            ))}
            <button
              type="button"
              className="text-sm text-stone-700 underline"
              onClick={() => setLines([...lines, { componentProductId: '', quantityBase: '1' }])}
            >
              + Add ingredient
            </button>
          </div>

          <button
            type="button"
            disabled={saveMutation.isPending}
            onClick={() => saveMutation.mutate()}
            className="px-4 py-2 rounded bg-stone-900 text-white text-sm font-medium disabled:opacity-40"
          >
            Save recipe
          </button>
        </div>

        <div className="rounded-lg border border-stone-200 bg-white p-4">
          <div className="flex items-center justify-between gap-3 mb-3">
            <h2 className="text-sm font-semibold text-stone-800 uppercase tracking-wide">
              Saved recipes
            </h2>
            <input
              className="border border-stone-300 rounded px-2 py-1.5 text-sm"
              placeholder="Filter…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
          {recipesQuery.isError && (
            <p className="text-sm text-red-600">
              {apiErr(recipesQuery.error, 'Failed to load recipes. Apply migration 565.')}
            </p>
          )}
          <ul className="divide-y divide-stone-100">
            {filteredRecipes.map((recipe) => (
              <li key={recipe.id} className="py-3 flex justify-between gap-3 items-start">
                <div>
                  <div className="font-medium text-stone-900">{recipe.name}</div>
                  <div className="text-xs text-stone-500">
                    {recipe.parentProductName || recipe.parentProductId}
                    {' · '}
                    {recipe.usageMode === 'AT_PRODUCTION' ? 'On production' : 'On payment'}
                    {!recipe.isActive ? ' · inactive' : ''}
                  </div>
                  <ul className="mt-1 text-sm text-stone-700">
                    {recipe.lines.map((l) => (
                      <li key={l.id || l.componentProductId}>
                        {Number(l.quantityBase)} × {l.componentName || l.componentProductId}
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="flex gap-2 shrink-0">
                  <button
                    type="button"
                    className="text-sm text-amber-800 underline"
                    onClick={() => loadRecipe(recipe)}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="text-sm text-red-700 underline"
                    disabled={deleteMutation.isPending}
                    onClick={() => {
                      if (confirm(`Delete recipe "${recipe.name}"?`)) {
                        deleteMutation.mutate(recipe.id);
                      }
                    }}
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
            {!recipesQuery.isLoading && filteredRecipes.length === 0 && (
              <li className="py-6 text-sm text-stone-500 text-center">No recipes yet</li>
            )}
          </ul>
        </div>
      </div>
    </Layout>
  );
}
