# PROOF — PO list search focus while typing

**Verdict:** PASS
**Generated:** 2026-09-16T21:26:48.728Z
**Gates:** 8/8

- PASS `COLD_START_SHOWS_LOADER` — First visit with no rows may show full-page loading
- PASS `SEARCH_REFETCH_KEEPS_SHELL` — While previous rows exist, spinner must not unmount AdaptiveSearch
- PASS `FETCHING_WITH_DATA_KEEPS_SHELL` — isFetching/placeholder path keeps page shell + search mounted
- PASS `EMPTY_SUCCESS_KEEPS_SHELL` — Empty result set still keeps search mounted
- PASS `HOOK_KEEP_PREVIOUS` — usePurchaseOrders keeps prior list while search queryKey changes
- PASS `PAGE_INITIAL_ONLY_LOADER` — Page uses isLoading && !posData — never bare isLoading early return
- PASS `SEARCH_AFTER_LOADER_GATE` — AdaptiveSearch renders only on the non-loader path (after gate)
- PASS `SEARCH_CONTROLLED_LOCAL_STATE` — Typing updates local searchTerm immediately; query uses debounce

## Integrity
PO list AdaptiveSearch must stay mounted while typing. keepPreviousData + isLoading&&!posData; bare isLoading full-page return is forbidden.
