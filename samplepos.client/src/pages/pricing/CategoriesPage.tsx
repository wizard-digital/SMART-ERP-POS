/**
 * Category Management Page
 * CRUD for product categories with search and status toggle
 */

import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import toast from 'react-hot-toast';
import { formatTimestampDate } from '../../utils/businessDate';
import { extractApiError } from '../../utils/extractApiError';
import { useSubmitOnEnter } from '../../hooks/useSubmitOnEnter';
import Layout from '../../components/Layout';
import {
  useCategories,
  useAllCategories,
  useCreateCategory,
  useUpdateCategory,
  useMergeCategory,
} from '../../hooks/usePricing';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '../../components/ui/dialog';
import { Badge } from '../../components/ui/badge';
import PricingTabs from '../../components/PricingTabs';
import type {
  ProductCategory,
  CreateProductCategoryInput,
  UpdateProductCategoryInput,
  CategoryFilters,
} from '../../types/pricing';
import {
  normalizeProductCategoryName,
  productCategoryNamesEqual,
} from '../../../../shared/utils/productCategoryName';

// ============================================================================
// Component
// ============================================================================

export default function CategoriesPage() {
  // ── Filters ──
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [filterActive, setFilterActive] = useState('');
  const limit = 20;

  // Debounced search
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current); }, []);
  const handleSearchChange = useCallback((value: string) => {
    setSearch(value);
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    searchTimeoutRef.current = setTimeout(() => {
      setDebouncedSearch(value);
      setPage(1);
    }, 300);
  }, []);

  const filters: CategoryFilters = useMemo(() => ({
    page,
    limit,
    search: debouncedSearch || undefined,
    isActive: filterActive === '' ? undefined : filterActive === 'true',
  }), [page, debouncedSearch, filterActive]);

  // ── Data ──
  const { data: categoriesData, isLoading, error } = useCategories(filters);
  const categories = categoriesData?.data ?? [];
  const pagination = categoriesData?.pagination;

  // ── Mutations ──
  const createMutation = useCreateCategory();
  const updateMutation = useUpdateCategory();
  const mergeMutation = useMergeCategory();

  // Fetch all categories (staleTime:0) so the merge dialog always has current data.
  // Falls back to the current visible page while loading, so the list is never empty.
  const { data: allCategoriesData } = useAllCategories();
  const allCategories = useMemo(() => {
    const fromAll = allCategoriesData?.data ?? [];
    if (fromAll.length > 0) return fromAll;
    return categories; // fallback: current page data (user selected from here anyway)
  }, [allCategoriesData, categories]);

  // ── Per-item loading (UX2) ──
  const [pendingToggleId, setPendingToggleId] = useState<string | null>(null);

  // ── Modal State ──
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingCategory, setEditingCategory] = useState<ProductCategory | null>(null);
  const [formData, setFormData] = useState<CreateProductCategoryInput>({ name: '', description: '' });
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});

  // ── Merge State (Shopify/HubSpot-style checkbox + survivor) ──
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showMergeDialog, setShowMergeDialog] = useState(false);
  const [survivorId, setSurvivorId] = useState<string>('');
  const [mergeDialogSearch, setMergeDialogSearch] = useState('');
  const [mergeProgress, setMergeProgress] = useState<string | null>(null);

  // Categories shown in the merge dialog (searchable full list)
  const mergeDialogCategories = useMemo(() => {
    const q = mergeDialogSearch.toLowerCase().trim();
    return allCategories
      .filter(c => !q || c.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [allCategories, mergeDialogSearch]);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    if (categories.every(c => selectedIds.has(c.id))) {
      setSelectedIds(prev => {
        const next = new Set(prev);
        categories.forEach(c => next.delete(c.id));
        return next;
      });
    } else {
      setSelectedIds(prev => {
        const next = new Set(prev);
        categories.forEach(c => next.add(c.id));
        return next;
      });
    }
  }, [categories, selectedIds]);

  const allOnPageSelected = categories.length > 0 && categories.every(c => selectedIds.has(c.id));
  const someOnPageSelected = categories.some(c => selectedIds.has(c.id)) && !allOnPageSelected;

  const closeMerge = useCallback(() => {
    setShowMergeDialog(false);
    setSurvivorId('');
    setMergeDialogSearch('');
    setMergeProgress(null);
  }, []);

  // Checked cats in the dialog (includes pre-selected from table)
  const [dialogCheckedIds, setDialogCheckedIds] = useState<Set<string>>(new Set());

  const openMergeDialog = useCallback((preselect: Set<string>) => {
    setDialogCheckedIds(new Set(preselect));
    setSurvivorId(preselect.size === 1 ? [...preselect][0] : '');
    setMergeDialogSearch('');
    setMergeProgress(null);
    setShowMergeDialog(true);
  }, []);

  const toggleDialogCheck = useCallback((id: string) => {
    setDialogCheckedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        // if survivor was this one, clear survivor
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleMerge = useCallback(async () => {
    if (!survivorId || dialogCheckedIds.size < 2) return;
    const sources = [...dialogCheckedIds].filter(id => id !== survivorId);
    const survivorCat = allCategories.find(c => c.id === survivorId);
    if (!survivorCat) return;
    let totalMoved = 0;
    try {
      for (let i = 0; i < sources.length; i++) {
        const srcId = sources[i];
        const srcCat = allCategories.find(c => c.id === srcId);
        setMergeProgress(`Merging ${i + 1} of ${sources.length}: "${srcCat?.name ?? srcId}"…`);
        const result = await mergeMutation.mutateAsync({ targetId: survivorId, sourceId: srcId });
        totalMoved += result.movedProducts ?? 0;
      }
      toast.success(`Merged ${sources.length} categor${sources.length > 1 ? 'ies' : 'y'} into "${survivorCat.name}" — ${totalMoved} products moved`);
      setSelectedIds(new Set());
      setDialogCheckedIds(new Set());
      closeMerge();
    } catch (err: unknown) {
      setMergeProgress(null);
      toast.error(extractApiError(err, 'Merge failed'));
    }
  }, [survivorId, dialogCheckedIds, allCategories, mergeMutation, closeMerge]);

  // ── Form Handlers ──
  const openCreate = useCallback(() => {
    setFormData({ name: '', description: '' });
    setFormErrors({});
    setShowCreateModal(true);
  }, []);

  const openEdit = useCallback((category: ProductCategory) => {
    setEditingCategory(category);
    setFormData({ name: category.name, description: category.description ?? '' });
    setFormErrors({});
  }, []);

  const closeModal = useCallback(() => {
    setShowCreateModal(false);
    setEditingCategory(null);
    setFormErrors({});
  }, []);

  // ── Validation ──
  const validateForm = useCallback((): boolean => {
    const errors: Record<string, string> = {};
    const normalized = normalizeProductCategoryName(formData.name);
    if (!normalized) errors.name = 'Category name is required';
    if (normalized.length > 255) errors.name = 'Name must be 255 characters or less';
    if (formData.description && formData.description.length > 1000) {
      errors.description = 'Description must be 1000 characters or less';
    }
    // SSOT: no duplicate names (case-insensitive), excluding the row being edited
    if (normalized && !errors.name) {
      const clash = allCategories.find(
        (c) =>
          productCategoryNamesEqual(c.name, normalized) &&
          (!editingCategory || c.id !== editingCategory.id),
      );
      if (clash) {
        errors.name = `Category "${clash.name}" already exists. Names must be unique.`;
      }
    }
    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  }, [formData, allCategories, editingCategory]);

  // ── Submit ──
  const handleSubmit = useCallback(async () => {
    if (!validateForm()) return;

    try {
      const normalizedName = normalizeProductCategoryName(formData.name);
      if (editingCategory) {
        const data: UpdateProductCategoryInput = {
          name: normalizedName,
          description: formData.description?.trim() || null,
        };
        await updateMutation.mutateAsync({ id: editingCategory.id, data });
        toast.success('Category updated');
      } else {
        await createMutation.mutateAsync({
          name: normalizedName,
          description: formData.description?.trim() || undefined,
        });
        toast.success('Category created');
      }
      closeModal();
    } catch (err: unknown) {
      toast.error(extractApiError(err));
    }
  }, [formData, editingCategory, validateForm, createMutation, updateMutation, closeModal]);

  // ── Toggle Active ──
  const handleToggleActive = useCallback(async (category: ProductCategory) => {
    setPendingToggleId(category.id);
    try {
      await updateMutation.mutateAsync({
        id: category.id,
        data: { isActive: !category.isActive },
      });
      toast.success(category.isActive ? 'Category deactivated' : 'Category activated');
    } catch (err: unknown) {
      toast.error(extractApiError(err, 'Failed to toggle category'));
    } finally {
      setPendingToggleId(null);
    }
  }, [updateMutation]);

  const isMutating = createMutation.isPending || updateMutation.isPending;

  useSubmitOnEnter(showCreateModal || !!editingCategory, !isMutating, handleSubmit);

  return (
    <Layout>
      <PricingTabs />
      <div className="p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Product Categories</h1>
            <p className="text-sm text-gray-500 mt-1">
              Organize products into categories for group pricing rules
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => openMergeDialog(selectedIds.size >= 2 ? selectedIds : new Set())}
              className="px-4 py-2 bg-orange-500 text-white rounded-lg hover:bg-orange-600 transition-colors text-sm font-medium flex items-center gap-1.5"
              title="Merge duplicate categories"
            >
              ⇄ Merge Categories
              {selectedIds.size >= 2 && (
                <span className="bg-white text-orange-600 rounded-full text-xs font-bold px-1.5 py-0.5 leading-none">
                  {selectedIds.size}
                </span>
              )}
            </button>
            <button
              onClick={openCreate}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
            >
              + New Category
            </button>
          </div>
        </div>

        {/* Search + Filters */}
        <div className="flex flex-wrap gap-3 items-center bg-gray-50 rounded-lg p-4">
          <div className="relative flex-1 min-w-[200px]">
            <input
              type="text"
              value={search}
              onChange={e => handleSearchChange(e.target.value)}
              placeholder="Search categories..."
              className="w-full border rounded-md pl-9 pr-3 py-2 text-sm bg-white"
              aria-label="Search categories"
            />
            <span className="absolute left-3 top-2.5 text-gray-400 text-sm">🔍</span>
          </div>

          <select
            value={filterActive}
            onChange={e => { setFilterActive(e.target.value); setPage(1); }}
            className="border rounded-md px-3 py-2 text-sm bg-white"
            aria-label="Filter by status"
          >
            <option value="">All Status</option>
            <option value="true">Active</option>
            <option value="false">Inactive</option>
          </select>

          {(debouncedSearch || filterActive) && (
            <button
              onClick={() => { setSearch(''); setDebouncedSearch(''); setFilterActive(''); setPage(1); }}
              className="text-sm text-blue-600 hover:underline"
            >
              Clear
            </button>
          )}
        </div>

        {/* Table */}
        {isLoading ? (
          <div className="flex justify-center py-12">
            <div className="animate-spin h-8 w-8 border-4 border-blue-500 border-t-transparent rounded-full" />
          </div>
        ) : error ? (
          <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-4">
            Failed to load categories. Please try again.
          </div>
        ) : categories.length === 0 ? (
          <div className="text-center py-12 text-gray-500">
            <p className="text-lg font-medium">No categories found</p>
            <p className="text-sm mt-1">
              {debouncedSearch ? 'Try a different search term' : 'Create your first category'}
            </p>
          </div>
        ) : (
          <>
            <div className="border rounded-lg overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow className="bg-gray-50">
                    <TableHead className="w-10">
                      <input
                        type="checkbox"
                        checked={allOnPageSelected}
                        ref={el => { if (el) el.indeterminate = someOnPageSelected; }}
                        onChange={toggleSelectAll}
                        className="rounded border-gray-300 accent-orange-500 cursor-pointer"
                        aria-label="Select all on this page"
                      />
                    </TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {categories.map(cat => {
                    const isChecked = selectedIds.has(cat.id);
                    return (
                      <TableRow
                        key={cat.id}
                        className={[
                          !cat.isActive ? 'opacity-60' : '',
                          isChecked ? 'bg-orange-50 border-l-4 border-l-orange-400' : 'hover:bg-gray-50',
                        ].join(' ')}
                      >
                        <TableCell className="w-10">
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => toggleSelect(cat.id)}
                            className="rounded border-gray-300 accent-orange-500 cursor-pointer"
                            aria-label={`Select ${cat.name}`}
                          />
                        </TableCell>
                        <TableCell className="font-medium">{cat.name}</TableCell>
                        <TableCell className="text-sm text-gray-500 max-w-xs truncate">
                          {cat.description || <span className="italic text-gray-300">No description</span>}
                        </TableCell>
                        <TableCell>
                          <Badge variant={cat.isActive ? 'default' : 'secondary'}>
                            {cat.isActive ? 'Active' : 'Inactive'}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-sm text-gray-500">
                          {formatTimestampDate(cat.createdAt)}
                        </TableCell>
                        <TableCell className="text-right space-x-2">
                          <button
                            onClick={() => handleToggleActive(cat)}
                            disabled={pendingToggleId === cat.id}
                            className="text-xs text-gray-500 hover:text-gray-700 disabled:opacity-50"
                            title={cat.isActive ? 'Deactivate' : 'Activate'}
                          >
                            {pendingToggleId === cat.id ? '⏳' : cat.isActive ? '⏸' : '▶'}
                          </button>
                          <button
                            onClick={() => openEdit(cat)}
                            className="text-xs text-blue-600 hover:text-blue-800"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => openMergeDialog(new Set([cat.id]))}
                            className="text-xs text-orange-600 hover:text-orange-800"
                            title="Merge this category"
                          >
                            Merge
                          </button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>

            {/* Floating Selection Bar - appears when 1+ rows checked */}
            {selectedIds.size > 0 && (
              <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 bg-gray-900 text-white rounded-full px-5 py-3 shadow-2xl text-sm font-medium animate-in slide-in-from-bottom-4">
                <span className="bg-orange-500 text-white rounded-full text-xs font-bold w-5 h-5 flex items-center justify-center">
                  {selectedIds.size}
                </span>
                <span>{selectedIds.size} categor{selectedIds.size > 1 ? 'ies' : 'y'} selected</span>
                <div className="w-px h-4 bg-gray-600" />
                <button
                  onClick={() => setSelectedIds(new Set())}
                  className="text-gray-400 hover:text-white transition-colors"
                >
                  Clear
                </button>
                <button
                  onClick={() => openMergeDialog(selectedIds)}
                  disabled={selectedIds.size < 2}
                  className="bg-orange-500 hover:bg-orange-400 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-full px-4 py-1.5 text-sm font-semibold transition-colors"
                >
                  ⇄ Merge {selectedIds.size} Categories
                </button>
              </div>
            )}
          </>
        )}

        {/* Pagination */}
        {pagination && pagination.totalPages > 1 && (
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-500">
              Page {pagination.page} of {pagination.totalPages} ({pagination.total} categories)
            </span>
            <div className="flex gap-2">
              <button
                disabled={page <= 1}
                onClick={() => setPage(p => p - 1)}
                className="px-3 py-1 text-sm border rounded-md hover:bg-gray-50 disabled:opacity-50"
              >
                Previous
              </button>
              <button
                disabled={page >= pagination.totalPages}
                onClick={() => setPage(p => p + 1)}
                className="px-3 py-1 text-sm border rounded-md hover:bg-gray-50 disabled:opacity-50"
              >
                Next
              </button>
            </div>
          </div>
        )}

        {/* Create / Edit Modal */}
        <Dialog open={showCreateModal || !!editingCategory} onOpenChange={() => closeModal()}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>
                {editingCategory ? 'Edit Category' : 'Create Category'}
              </DialogTitle>
            </DialogHeader>

            <div className="space-y-4 py-2">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Name <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={e => setFormData(f => ({ ...f, name: e.target.value }))}
                  placeholder="e.g., Pharmaceuticals"
                  className={`w-full border rounded-md px-3 py-2 text-sm ${formErrors.name ? 'border-red-500' : ''}`}
                  autoFocus
                />
                {formErrors.name && (
                  <p className="text-red-500 text-xs mt-1">{formErrors.name}</p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Description
                </label>
                <textarea
                  value={formData.description ?? ''}
                  onChange={e => setFormData(f => ({ ...f, description: e.target.value }))}
                  placeholder="Optional description..."
                  rows={3}
                  className={`w-full border rounded-md px-3 py-2 text-sm resize-none ${formErrors.description ? 'border-red-500' : ''}`}
                />
                {formErrors.description && (
                  <p className="text-red-500 text-xs mt-1">{formErrors.description}</p>
                )}
              </div>
            </div>

            <DialogFooter>
              <button
                onClick={closeModal}
                className="px-4 py-2 border rounded-md text-sm hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleSubmit}
                disabled={isMutating}
                className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm hover:bg-blue-700 disabled:opacity-50"
              >
                {isMutating ? 'Saving...' : editingCategory ? 'Update' : 'Create'}
              </button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Merge Dialog — Shopify/HubSpot-style checkbox list + survivor radio */}
        <Dialog open={showMergeDialog} onOpenChange={() => closeMerge()}>
          <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col">
            <DialogHeader className="flex-shrink-0">
              <DialogTitle className="flex items-center gap-2">
                <span className="text-orange-500 text-lg">⇄</span>
                Merge Categories
              </DialogTitle>
              <p className="text-xs text-gray-400 mt-1">
                Tick the categories to consolidate. Pick one as the <strong>survivor</strong> — the rest will be permanently deleted.
              </p>
            </DialogHeader>

            {/* Search */}
            <div className="flex-shrink-0 relative mt-2">
              <span className="absolute left-3 top-2.5 text-gray-400 text-sm">🔍</span>
              <input
                type="text"
                value={mergeDialogSearch}
                onChange={e => setMergeDialogSearch(e.target.value)}
                placeholder="Search categories…"
                className="w-full border rounded-lg pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-200"
                autoFocus
              />
            </div>

            {/* Category list with checkboxes */}
            <div className="flex-1 overflow-y-auto border rounded-lg min-h-0 mt-2">
              {mergeDialogCategories.length === 0 ? (
                <p className="text-center text-gray-400 text-sm py-8">No categories found</p>
              ) : (
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-gray-50 border-b z-10">
                    <tr>
                      <th className="w-10 px-3 py-2">
                        <input
                          type="checkbox"
                          checked={mergeDialogCategories.length > 0 && mergeDialogCategories.every(c => dialogCheckedIds.has(c.id))}
                          ref={el => { if (el) el.indeterminate = mergeDialogCategories.some(c => dialogCheckedIds.has(c.id)) && !mergeDialogCategories.every(c => dialogCheckedIds.has(c.id)); }}
                          onChange={() => {
                            const allChecked = mergeDialogCategories.every(c => dialogCheckedIds.has(c.id));
                            setDialogCheckedIds(prev => {
                              const next = new Set(prev);
                              mergeDialogCategories.forEach(c => allChecked ? next.delete(c.id) : next.add(c.id));
                              return next;
                            });
                          }}
                          className="rounded border-gray-300 accent-orange-500 cursor-pointer"
                        />
                      </th>
                      <th className="text-left px-3 py-2 font-semibold text-gray-600">Category</th>
                      <th className="text-left px-3 py-2 font-semibold text-gray-600">Status</th>
                      <th className="w-28 px-3 py-2 text-center font-semibold text-emerald-700">Survivor ★</th>
                    </tr>
                  </thead>
                  <tbody>
                    {mergeDialogCategories.map(cat => {
                      const isChecked = dialogCheckedIds.has(cat.id);
                      const isSurvivor = survivorId === cat.id;
                      return (
                        <tr
                          key={cat.id}
                          onClick={() => toggleDialogCheck(cat.id)}
                          className={[
                            'border-b cursor-pointer transition-colors',
                            isSurvivor ? 'bg-emerald-50' : isChecked ? 'bg-orange-50' : 'hover:bg-gray-50',
                          ].join(' ')}
                        >
                          <td className="px-3 py-2.5" onClick={e => e.stopPropagation()}>
                            <input
                              type="checkbox"
                              checked={isChecked}
                              onChange={() => toggleDialogCheck(cat.id)}
                              className="rounded border-gray-300 accent-orange-500 cursor-pointer"
                            />
                          </td>
                          <td className="px-3 py-2.5">
                            <span className={`font-medium ${isSurvivor ? 'text-emerald-700' : isChecked ? 'text-orange-700' : 'text-gray-800'
                              }`}>
                              {cat.name}
                            </span>
                            {isSurvivor && (
                              <span className="ml-2 text-xs bg-emerald-100 text-emerald-700 rounded-full px-2 py-0.5 font-semibold">Keep</span>
                            )}
                            {isChecked && !isSurvivor && (
                              <span className="ml-2 text-xs bg-orange-100 text-orange-600 rounded-full px-2 py-0.5">Delete</span>
                            )}
                          </td>
                          <td className="px-3 py-2.5">
                            <span className={`text-xs px-2 py-0.5 rounded-full ${cat.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                              }`}>
                              {cat.isActive ? 'Active' : 'Inactive'}
                            </span>
                          </td>
                          <td className="px-3 py-2.5 text-center" onClick={e => e.stopPropagation()}>
                            {isChecked && (
                              <input
                                type="radio"
                                name="survivor"
                                checked={isSurvivor}
                                onChange={() => setSurvivorId(cat.id)}
                                className="accent-emerald-600 cursor-pointer w-4 h-4"
                                title="This category survives — all others are deleted"
                              />
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>

            {/* Summary strip */}
            <div className="flex-shrink-0 mt-3 space-y-2">
              {dialogCheckedIds.size >= 2 && !survivorId && (
                <div className="flex items-center gap-2 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  <span>⚠️</span>
                  <span>Pick the <strong>Survivor ★</strong> — click a radio button on the category to keep.</span>
                </div>
              )}
              {dialogCheckedIds.size >= 2 && survivorId && !mergeProgress && (
                <div className="text-sm text-gray-600 bg-gray-50 border rounded-lg px-3 py-2">
                  <span className="text-emerald-700 font-semibold">★ Keeping:</span>{' '}
                  {allCategories.find(c => c.id === survivorId)?.name}
                  {'  '}
                  <span className="text-orange-600 font-semibold">✕ Deleting:</span>{' '}
                  {[...dialogCheckedIds].filter(id => id !== survivorId).map(id => allCategories.find(c => c.id === id)?.name).filter(Boolean).join(', ')}
                </div>
              )}
              {mergeProgress && (
                <div className="flex items-center gap-2 text-sm text-blue-700 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2">
                  <div className="animate-spin h-4 w-4 border-2 border-blue-500 border-t-transparent rounded-full flex-shrink-0" />
                  {mergeProgress}
                </div>
              )}
            </div>

            <DialogFooter className="flex-shrink-0">
              <span className="text-xs text-gray-400 mr-auto">
                {dialogCheckedIds.size} selected
              </span>
              <button
                onClick={closeMerge}
                disabled={mergeMutation.isPending}
                className="px-4 py-2 border rounded-md text-sm hover:bg-gray-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleMerge}
                disabled={dialogCheckedIds.size < 2 || !survivorId || mergeMutation.isPending}
                className="px-4 py-2 bg-orange-600 text-white rounded-md text-sm hover:bg-orange-700 disabled:opacity-50 font-semibold"
              >
                {mergeMutation.isPending
                  ? 'Merging…'
                  : `Merge & Keep "${allCategories.find(c => c.id === survivorId)?.name ?? '…'}"`}
              </button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </Layout>
  );
}
