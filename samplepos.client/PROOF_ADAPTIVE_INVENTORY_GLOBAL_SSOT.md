# PROOF — Adaptive inventory global SSOT

**Verdict:** PASS
**Generated:** 2026-09-13T08:19:55.587Z
**Gates:** 51/51

- PASS `WORKLIST_2UP` — worklist grids are 2-up on phone
- PASS `WORKLIST_RESOLVER` — worklistKpiGridClass maps count → grid class
- PASS `WORKLIST_DENSITY_TOKEN` — ADAPTIVE_WORKLIST_DENSITY dense + search debounce 300ms
- PASS `KPI_STRIP_SSOT` — AdaptiveKpiStrip + barrel export
- PASS `DENSE_PRODUCTSPAGE` — pages/inventory/ProductsPage.tsx: ADAPTIVE_WORKLIST_DENSITY + toolbarInline
- PASS `SEARCH_PRODUCTSPAGE` — pages/inventory/ProductsPage.tsx: AdaptiveSearch in AdaptiveToolbar leading (no blank toolbar)
- PASS `CREATE_FIRST_PRODUCTSPAGE` — pages/inventory/ProductsPage.tsx: create-first CTAs before Search
- PASS `DENSE_PURCHASEORDERSPAGE` — pages/inventory/PurchaseOrdersPage.tsx: ADAPTIVE_WORKLIST_DENSITY + toolbarInline
- PASS `SEARCH_PURCHASEORDERSPAGE` — pages/inventory/PurchaseOrdersPage.tsx: AdaptiveSearch in AdaptiveToolbar leading (no blank toolbar)
- PASS `CREATE_FIRST_PURCHASEORDERSPAGE` — pages/inventory/PurchaseOrdersPage.tsx: create-first CTAs before Search
- PASS `SERVER_SEARCH_PURCHASEORDERSPAGE` — pages/inventory/PurchaseOrdersPage.tsx: debounced server search (accurate, not per-keystroke)
- PASS `DENSE_GOODSRECEIPTSPAGE` — pages/inventory/GoodsReceiptsPage.tsx: ADAPTIVE_WORKLIST_DENSITY + toolbarInline
- PASS `SEARCH_GOODSRECEIPTSPAGE` — pages/inventory/GoodsReceiptsPage.tsx: AdaptiveSearch in AdaptiveToolbar leading (no blank toolbar)
- PASS `CREATE_FIRST_GOODSRECEIPTSPAGE` — pages/inventory/GoodsReceiptsPage.tsx: create-first CTAs before Search
- PASS `SERVER_SEARCH_GOODSRECEIPTSPAGE` — pages/inventory/GoodsReceiptsPage.tsx: debounced server search (accurate, not per-keystroke)
- PASS `DENSE_STOCKMOVEMENTSPAGE` — pages/inventory/StockMovementsPage.tsx: ADAPTIVE_WORKLIST_DENSITY + toolbarInline
- PASS `SEARCH_STOCKMOVEMENTSPAGE` — pages/inventory/StockMovementsPage.tsx: AdaptiveSearch in AdaptiveToolbar leading (no blank toolbar)
- PASS `CREATE_FIRST_STOCKMOVEMENTSPAGE` — pages/inventory/StockMovementsPage.tsx: create-first CTAs before Search
- PASS `SERVER_SEARCH_STOCKMOVEMENTSPAGE` — pages/inventory/StockMovementsPage.tsx: debounced server search (accurate, not per-keystroke)
- PASS `DENSE_INVENTORYADJUSTMENTSPAGE` — pages/inventory/InventoryAdjustmentsPage.tsx: ADAPTIVE_WORKLIST_DENSITY + toolbarInline
- PASS `SEARCH_INVENTORYADJUSTMENTSPAGE` — pages/inventory/InventoryAdjustmentsPage.tsx: AdaptiveSearch in AdaptiveToolbar leading (no blank toolbar)
- PASS `CREATE_FIRST_INVENTORYADJUSTMENTSPAGE` — pages/inventory/InventoryAdjustmentsPage.tsx: create-first CTAs before Search
- PASS `DENSE_BATCHMANAGEMENTPAGE` — pages/inventory/BatchManagementPage.tsx: ADAPTIVE_WORKLIST_DENSITY + toolbarInline
- PASS `SEARCH_BATCHMANAGEMENTPAGE` — pages/inventory/BatchManagementPage.tsx: AdaptiveSearch in AdaptiveToolbar leading (no blank toolbar)
- PASS `DENSE_STOCKLEVELSPAGE` — pages/inventory/StockLevelsPage.tsx: ADAPTIVE_WORKLIST_DENSITY + toolbarInline
- PASS `SEARCH_STOCKLEVELSPAGE` — pages/inventory/StockLevelsPage.tsx: AdaptiveSearch in AdaptiveToolbar leading (no blank toolbar)
- PASS `DENSE_SUPPLIERRETURNSPAGE` — pages/inventory/SupplierReturnsPage.tsx: ADAPTIVE_WORKLIST_DENSITY + toolbarInline
- PASS `SEARCH_SUPPLIERRETURNSPAGE` — pages/inventory/SupplierReturnsPage.tsx: AdaptiveSearch in AdaptiveToolbar leading (no blank toolbar)
- PASS `SERVER_SEARCH_SUPPLIERRETURNSPAGE` — pages/inventory/SupplierReturnsPage.tsx: debounced server search (accurate, not per-keystroke)
- PASS `PO_KPI_STRIP` — PO uses AdaptiveKpiStrip; no cols-1×6 towers
- PASS `PO_FILTERS_TOOLBAR` — PO: Create + Filters + Search on AdaptiveToolbar (search fills dead space)
- PASS `ADJ_ADAPTIVE_SHELL` — Adjustments uses AdaptivePage chrome
- PASS `ADJ_DATA_GRID` — batch list uses AdaptiveDataGrid (cards on phone)
- PASS `ADJ_PC_KPI` — physical count stats use AdaptiveKpiStrip
- PASS `MOVEMENTS_SSOT` — Movement History: dense Adjustments+Filters+More — no CTA towers
- PASS `BATCHES_SSOT` — Batch Management: dense Refresh in toolbar More — no hero Refresh CTA
- PASS `STOCK_KPI_SSOT` — Stock Levels: dense Filters with close() + More Refresh
- PASS `ADJ_NO_CTA_TOWER` — Adjustments: Physical Count before Search; Movement History in More
- PASS `RETURNS_SSOT` — Supplier Returns inherits AdaptivePage/Toolbar/facets/row-actions SSOT
- PASS `PRODUCTS_SSOT` — Products: title + Add/Filters/Search share one header row (no white band)
- PASS `PRODUCTS_ACTIONS_BEFORE_SEARCH` — Products: + Add Product and Filters sit before Search on one row
- PASS `PRODUCTS_MOBILE_CARD_ALIGN` — Phone product cards: hide Active (default); only Inactive + ··· aligned — no right-column stack
- PASS `ACTIONS_BEFORE_LEADING_PROP` — AdaptiveToolbar exposes actionsBeforeLeading for create-first worklists
- PASS `PAGE_TOOLBAR_INLINE` — AdaptivePage: title above full-width toolbar until md; then title|toolbar inline
- PASS `CREATE_FIRST_RESPONSIVE` — create-first: no phone flex-basis blank band; sm+ Search grows on one row
- PASS `MORE_OVERFLOW_ELLIPSIS` — More trigger is ··· on phone (SAP/Square overflow), labeled More on sm+
- PASS `MOBILE_SORT_IN_MORE` — Phone sort lives in More overflow — no separate Sort row under Search
- PASS `FILTERS_POPOVER` — Filters: full-bleed overlay under chrome + Escape/outside-click close; portaled Select stays open
- PASS `FILTERS_MORE_MUTEX` — Filters XOR More: controlled AdaptiveMoreMenu + scroll panel — never stacked overlays
- PASS `SORT_MENU_LABEL_SSOT` — More sort items use Sort by X once — never Sort: Sort by …
- PASS `FILTER_PANEL_PHONE_SSOT` — AdaptiveFilterPanel: dense 2-up grid + full-bleed Filters fit on phone

## Integrity
Global inventory adaptive SSOT: dense + toolbarInline + AdaptiveSearch; Filters XOR More (mutex); sort labels SSOT; create-first CTAs; debounced server search; Filters popover — no stacked chrome or Sort: Sort by forks.
