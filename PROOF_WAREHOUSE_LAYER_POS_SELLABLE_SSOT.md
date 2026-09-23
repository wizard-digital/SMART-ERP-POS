# PROOF_WAREHOUSE_LAYER_POS_SELLABLE_SSOT

Verdict: **PASS** (21/21)

## SSOT

- **Batch subledger:** `inventory_batches.remaining_quantity`
- **Store balances:** `SUM(inventory_balances.quantity_on_hand) per inventory_batch_id`
- **Projection:** `product_lots keyed by inventory_batch_id (prefer existing; no MAIN vs MAIN-{id} dup)`
- **POS sellable:** `SELLING store sellable qty; RETURN/DAMAGE/EXPIRED = quarantine not broken`
- **Sync hook:** `syncProductQuantity → assertWarehouseLayerConsistent → assertPosSellableProjectionConsistent`

## Gates

- PASS `COUPLING_GROUP_BY_BATCH`: findWarehouseLayerMismatches aggregates per batch (not orphan projection row)
- PASS `COUPLING_ALIGN_BY_BATCH`: alignBatchSubledgerToStoreBalances rebases batch from store balances
- PASS `COUPLING_ERR_CODE`: mismatch throws ERR_WAREHOUSE_LAYER_COUPLING and rolls back
- PASS `PROJECTION_BY_BATCH_ID`: upsertProjection updates existing row for inventory_batch_id before insert
- PASS `PROJECTION_NO_DUP_MAIN`: documents heal MAIN-{id} vs batch_number MAIN duplicate hazard
- PASS `GET_LOT_DETERMINISTIC`: getProductLotIdByBatchId is deterministic (oldest projection)
- PASS `SYNC_CALLS_COUPLING`: syncProductQuantity calls assertWarehouseLayerConsistent
- PASS `COUPLING_CALLS_POS_PROJECTION`: consistent layer then asserts POS projection
- PASS `REASON_QUARANTINE`: classifies RETURN/DAMAGE/EXPIRED as quarantine (not broken projection)
- PASS `PROJECTION_FILTER`: projection assert fails only NO_LOT / SELLING_ZERO_NO_BALANCES
- PASS `RETURN_PATH_USES_RETURN_STORE`: customer return lands on RETURN store via returnLot
- PASS `ADJUST_MULTISTORE`: adjustBatch delegates to adjustAtStore when multistore on
- PASS `ADJUST_ALIGN_BEFORE`: adjustAtStore aligns batch to balances before mutating
- PASS `ADJUST_IN_RETURN_LOT`: ADJUSTMENT_IN mutates via lotService.returnLot (projection + balance)
- PASS `HANDLER_SOURCE_STORE`: processMovement outbound passes sourceStoreLocationId into consumeLot
- PASS `CONSUME_DEFAULT_CROSS_STORE`: consumeLot defaults to cross-store balance deduct for specific-lot multistore consume
- PASS `ADJUST_NO_PRE_BALANCE_OUT`: adjustAtStore OUT does not pre-decrement balances before processMovement
- PASS `ADJUST_PASSES_SOURCE_STORE`: adjustAtStore OUT passes sourceStoreLocationId to processMovement
- PASS `HEAL_BALANCES_TO_BATCH`: heal snaps store balances to batch then asserts INV-002
- PASS `BEHAVIOR_RETURN_CASE`: behavior test covers RETURN quarantine allow-path
- PASS `MULTISTORE_HELPER`: isMultistoreEnabled export present

## Incidents closed

### BLISS_SKU3273_RETURN
- Symptom: POS sellable projection missing (syncProductQuantity …). SKU-3273: batch=1 (SELLING_ZERO_NO_BALANCES)
- Cause: Customer return correctly parked qty on RETURN store; projection assert treated as broken
- Fix: SELLING_ZERO_QUARANTINE_HAS excluded from hard-fail projection assert
### BLISS_SKU3730_ADJUST
- Symptom: Warehouse inventory mismatch … Lot MAIN: balances=0, batch=14 (ERR_WAREHOUSE_LAYER_COUPLING)
- Cause: upsertProjection inserted second product_lots row lot_number=MAIN while heal used MAIN-{id}
- Fix: upsertProjection updates by inventory_batch_id; coupling groups by batch

## Live rollback scripts

- return SKU-3273: `C:\Users\Chase\source\repos\SamplePOS\SamplePOS.Server\scripts\proof-bliss-return-sku3273-rollback.mjs` exists=true
- adjust SKU-3730: `C:\Users\Chase\source\repos\SamplePOS\SamplePOS.Server\scripts\proof-bliss-adjust-sku3730-rollback.mjs` exists=true
