# PROOF — Adjust Inventory drawer SSOT

**Verdict:** PASS
**Generated:** 2026-09-20T16:57:17.097Z
**Gates:** 7/7

- PASS `DRAWER_SSOT_FILE` — Shared drawer owns BatchAdjustmentSchema + useAdjustBatch submit
- PASS `ADJ_PAGE_USES_SHARED_DRAWER` — Adjustments page mounts shared drawer only (no inline adjust form)
- PASS `PRODUCTS_EDIT_ADJUST_BUTTON` — Edit Product has Adjust button beside QOH opening shared drawer
- PASS `PRODUCTS_ADJUST_QTY_STORE_SSOT` — Edit Product: store picker + FEFO lot/batch select; store lots carry inventoryBatchId
- PASS `API_STORE_PRODUCT_LOTS_BATCH_ID` — listLotsForProductAtStore returns inventoryBatchId for lot↔batch coupling
- PASS `NO_DUPLICATE_ADJUST_SUBMIT_UI` — Products has no forked adjust schema; Adjustments keeps PHYSICAL_COUNT only
- PASS `DRAWER_INITIAL_CATEGORY` — Damage row action prefills shared drawer category (no local form state)

## Integrity
Adjust Inventory UI+submit is one AdjustInventoryDrawer; Inventory Adjustments and Products Edit Product both mount it; no duplicated single-adjust form.
