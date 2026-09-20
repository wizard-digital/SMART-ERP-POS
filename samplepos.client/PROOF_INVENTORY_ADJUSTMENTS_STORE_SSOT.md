# PROOF — Inventory adjustments store SSOT

**Verdict:** PASS
**Generated:** 2026-09-20T16:57:17.095Z
**Gates:** 5/5

- PASS `UI_ADJ_DEFAULT_SELLING` — Adjustments default store is SELLING (INV-POS), not MAIN
- PASS `UI_ADJ_STORE_AVAILABLE_QTY` — Modal Current Quantity uses store-available lot/batch FEFO, not batch master alone
- PASS `API_ADJ_DEFAULT_SELLING` — resolveDefaultStoreId prefers POS SELLING
- PASS `API_ADJ_STORE_SELLABLE_PREFLIGHT` — OUT adjustments refuse wrong-store debit with clear message
- PASS `API_STORE_LOTS_BATCH_ID` — listLotsAtStore returns inventoryBatchId for batch coupling

## Integrity
Multistore Adjustments default to SELLING; Current Quantity is store-available; OUT preflights sellable at chosen store; store lots expose inventoryBatchId.
