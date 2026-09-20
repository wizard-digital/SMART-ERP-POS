import { useState, useRef, useEffect, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { pricingApi } from '../../api/pricing';
import type { ProductCategory } from '../../types/pricing';
import {
  normalizeProductCategoryName,
  productCategoryNamesEqual,
} from '../../../../shared/utils/productCategoryName';

interface CategoryComboboxProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

export default function CategoryCombobox({ value, onChange, disabled = false }: CategoryComboboxProps) {
  const [search, setSearch] = useState(value);
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string>('');

  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const queryClient = useQueryClient();

  useEffect(() => {
    setSearch(value);
  }, [value]);

  useEffect(() => {
    clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      setDebouncedSearch(search);
    }, 200);
    return () => clearTimeout(debounceTimer.current);
  }, [search]);

  const { data: categoriesData, isLoading } = useQuery({
    queryKey: ['product-categories-search', debouncedSearch],
    queryFn: () => pricingApi.listCategories({ search: debouncedSearch, isActive: true, limit: 20 }),
    enabled: isOpen,
    staleTime: 30_000,
  });

  const categories = categoriesData?.data ?? [];

  const exactMatch = categories.find((c) => productCategoryNamesEqual(c.name, search));
  const showCreateOption = search.trim().length > 0 && !exactMatch && !isLoading;
  const totalItems = categories.length + (showCreateOption ? 1 : 0);

  const selectCategory = useCallback(
    (name: string) => {
      setSearch(name);
      onChange(name);
      setIsOpen(false);
      setHighlightedIndex(-1);
      setCreateError('');
    },
    [onChange],
  );

  const createMutation = useMutation({
    mutationFn: (name: string) =>
      pricingApi.createCategory({ name: normalizeProductCategoryName(name) }),
    onSuccess: (created: ProductCategory) => {
      queryClient.invalidateQueries({ queryKey: ['product-categories-search'] });
      queryClient.invalidateQueries({ queryKey: ['product-categories'] });
      selectCategory(created.name);
      setIsCreating(false);
      setCreateError('');
    },
    onError: (err: unknown) => {
      setIsCreating(false);
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        'Category already exists or could not be created';
      setCreateError(msg);
      const existing = categories.find((c) => productCategoryNamesEqual(c.name, search));
      if (existing) selectCategory(existing.name);
    },
  });

  const handleCreateNew = useCallback(() => {
    const trimmed = normalizeProductCategoryName(search);
    if (!trimmed || isCreating) return;
    setIsCreating(true);
    setCreateError('');
    createMutation.mutate(trimmed);
  }, [search, isCreating, createMutation]);

  /** Reuse existing SSOT name; never invent a case-variant duplicate. */
  const commitTypedValue = useCallback(() => {
    const typed = normalizeProductCategoryName(search);
    if (!typed) {
      onChange('');
      setSearch('');
      return;
    }
    const match =
      categories.find((c) => productCategoryNamesEqual(c.name, typed)) ??
      (productCategoryNamesEqual(value, typed) ? { name: value } : null);
    if (match) {
      selectCategory(match.name);
      return;
    }
    onChange(typed);
    setSearch(typed);
  }, [search, categories, value, onChange, selectCategory]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(target) &&
        inputRef.current &&
        !inputRef.current.contains(target)
      ) {
        setIsOpen(false);
        commitTypedValue();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [commitTypedValue]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isOpen) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        setIsOpen(true);
        e.preventDefault();
      }
      return;
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setHighlightedIndex((prev) => (prev + 1) % Math.max(totalItems, 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setHighlightedIndex((prev) => (prev - 1 + Math.max(totalItems, 1)) % Math.max(totalItems, 1));
        break;
      case 'Enter':
        e.preventDefault();
        if (highlightedIndex >= 0 && highlightedIndex < categories.length) {
          selectCategory(categories[highlightedIndex].name);
        } else if (highlightedIndex === categories.length && showCreateOption) {
          handleCreateNew();
        } else if (exactMatch) {
          selectCategory(exactMatch.name);
        } else if (categories.length === 1) {
          selectCategory(categories[0].name);
        } else if (showCreateOption) {
          handleCreateNew();
        }
        break;
      case 'Escape':
        setIsOpen(false);
        setHighlightedIndex(-1);
        break;
      case 'Tab':
        setIsOpen(false);
        commitTypedValue();
        break;
    }
  };

  useEffect(() => {
    if (highlightedIndex < 0 || !dropdownRef.current) return;
    const items = dropdownRef.current.querySelectorAll('[data-combobox-item]');
    items[highlightedIndex]?.scrollIntoView({ block: 'nearest' });
  }, [highlightedIndex]);

  return (
    <div className="relative">
      <input
        ref={inputRef}
        id="product-category"
        type="text"
        role="combobox"
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-controls="category-listbox"
        aria-activedescendant={highlightedIndex >= 0 ? `category-option-${highlightedIndex}` : undefined}
        autoComplete="off"
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          setIsOpen(true);
          setHighlightedIndex(-1);
          setCreateError('');
        }}
        onFocus={() => setIsOpen(true)}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent pr-8"
        placeholder="Search or create category..."
        data-category-combobox="true"
      />
      <button
        type="button"
        tabIndex={-1}
        onClick={() => {
          setIsOpen(!isOpen);
          inputRef.current?.focus();
        }}
        disabled={disabled}
        className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
        aria-label="Toggle category list"
      >
        <svg
          className={`w-4 h-4 transition-transform ${isOpen ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isOpen && (
        <div
          ref={dropdownRef}
          id="category-listbox"
          role="listbox"
          className="absolute z-50 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-60 overflow-auto"
        >
          {isLoading && <div className="px-3 py-2 text-sm text-gray-500">Searching...</div>}
          {!isLoading && categories.length === 0 && !showCreateOption && (
            <div className="px-3 py-2 text-sm text-gray-500">No categories found</div>
          )}
          {categories.map((cat, index) => (
            <div
              key={cat.id}
              id={`category-option-${index}`}
              role="option"
              aria-selected={highlightedIndex === index}
              data-combobox-item
              className={`px-3 py-2 text-sm cursor-pointer ${
                highlightedIndex === index ? 'bg-blue-50 text-blue-900' : 'text-gray-900 hover:bg-gray-50'
              }`}
              onMouseDown={(e) => {
                e.preventDefault();
                selectCategory(cat.name);
              }}
              onMouseEnter={() => setHighlightedIndex(index)}
            >
              {cat.name}
            </div>
          ))}
          {showCreateOption && (
            <div
              id={`category-option-${categories.length}`}
              role="option"
              aria-selected={highlightedIndex === categories.length}
              data-combobox-item
              data-category-create-option="true"
              className={`px-3 py-2 text-sm cursor-pointer border-t border-gray-100 ${
                highlightedIndex === categories.length
                  ? 'bg-blue-50 text-blue-900'
                  : 'text-blue-700 hover:bg-blue-50'
              }`}
              onMouseDown={(e) => {
                e.preventDefault();
                handleCreateNew();
              }}
              onMouseEnter={() => setHighlightedIndex(categories.length)}
            >
              {isCreating ? 'Creating…' : `+ Create "${normalizeProductCategoryName(search)}"`}
            </div>
          )}
        </div>
      )}
      {createError ? (
        <p className="text-xs text-red-600 mt-1" data-category-create-error="true">
          {createError}
        </p>
      ) : null}
    </div>
  );
}
