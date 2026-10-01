import { useCallback, useState } from 'react';
import { useColumnSort } from './useColumnSort';
import { serverListParamsForState } from '../lib/customerCenterOverview';

interface UseServerTableSortOptions<T extends string> {
  defaultField: T;
  defaultOrder?: 'asc' | 'desc';
  /** Column click enables this filter (e.g. outstanding balance). */
  filterField?: T;
  filterParam?: 'outstandingOnly' | 'balanceGt' | 'stockGt';
  onQueryChange?: () => void;
}

/**
 * Enterprise table sort — drives server-side ORDER BY / WHERE, resets page on change.
 */
export function useServerTableSort<T extends string>({
  defaultField,
  defaultOrder = 'asc',
  filterField,
  filterParam = 'outstandingOnly',
  onQueryChange,
}: UseServerTableSortOptions<T>) {
  const { sortField, sortOrder, handleSort, setSortField, setSortOrder, resetSort } =
    useColumnSort<T>(defaultField, defaultOrder);
  const [columnFilterActive, setColumnFilterActive] = useState(false);

  const handleColumnSort = useCallback(
    (field: string) => {
      const f = field as T;
      if (filterField && f === filterField) {
        setColumnFilterActive(true);
        handleSort(f, { defaultOrder: 'desc' });
      } else {
        setColumnFilterActive(false);
        handleSort(f, { defaultOrder: f === defaultField ? defaultOrder : 'asc' });
      }
      onQueryChange?.();
    },
    [defaultField, defaultOrder, filterField, handleSort, onQueryChange],
  );

  const clearColumnFilter = useCallback(() => {
    setColumnFilterActive(false);
    resetSort();
    onQueryChange?.();
  }, [onQueryChange, resetSort]);

  const applyListPreset = useCallback(
    (preset: { field: T; order: 'asc' | 'desc'; filter: boolean }) => {
      setSortField(preset.field);
      setSortOrder(preset.order);
      setColumnFilterActive(preset.filter);
      onQueryChange?.();
    },
    [onQueryChange, setSortField, setSortOrder],
  );

  const serverListParams = serverListParamsForState(
    { sortField, sortOrder, columnFilterActive },
    filterParam,
  );

  return {
    sortField,
    sortOrder,
    setSortField,
    setSortOrder,
    handleColumnSort,
    columnFilterActive,
    clearColumnFilter,
    applyListPreset,
    serverListParams,
  };
}
