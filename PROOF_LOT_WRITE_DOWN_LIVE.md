# PROOF — Lot carrying-value write-down / inventory clearance markdown (LIVE)

**Verdict:** PASS
**Proven at:** 2026-09-11T18:41:17.503Z
**Stamp / SKU:** 20260911184112 / LWD-20260911184112

**Contract:** Lot carrying-value write-down / inventory clearance markdown: original_cost_price immutable; cost_price decreases only with a posted LWD document; 5140≠5120/5130; disposal uses remaining carrying; concurrent sale/write-down serializes on FOR UPDATE; offline/edge cannot overwrite carrying; POS floor is server FEFO carrying.

## Fixture

```json
{
  "productId": "eb86d14c-93fa-4908-b945-88414db780c0",
  "criticalId": "802ef284-a032-432b-aaf9-44e742bdbd6a",
  "sixtyId": "1b8de602-3e4c-4e0c-8503-b567ca4721dc",
  "warningId": "73378d49-b0ac-46e5-be24-526471926162",
  "expiredId": "6c25604c-5716-4159-91a0-736a186bba69",
  "noExpiryId": "6df7c418-e4bc-47c2-be3d-c5238547ffdb",
  "quarantinedId": "62f0c96a-3f20-4b14-8330-864a67bd19cb",
  "raceId": "b25c0f23-6f84-4059-a860-01366904bfda",
  "disposeId": "a6dad84e-cfa8-47ac-9303-0459998133c1",
  "businessDate": "2026-09-11",
  "criticalExpiry": "2026-09-16",
  "sixtyExpiry": "2026-11-10",
  "beyondExpiry": "2026-11-11",
  "carrying": 10000,
  "newCost": 6000,
  "qty": 10
}
```

## Gates (measured)

- PASS `MIG_611`: original_cost_price present
- PASS `MIG_612`: lot_write_down_documents present
- PASS `MIG_613`: carrying increase blocked + deferred journal; applied=already-current
- PASS `USER`: userId=7aa55a55-db98-4a9d-a743-d877c7d8dd21
- PASS `GL_ACCOUNTS`: accounts present: 1300,5140
- PASS `SEED_PRODUCT`: productId=eb86d14c-93fa-4908-b945-88414db780c0 sku=LWD-20260911184112
- PASS `SEED_BATCHES`: seeded 9 batches biz=2026-09-11
  - measured: `{"rows":[{"id":"1b8de602-3e4c-4e0c-8503-b567ca4721dc","batch_number":"LWD-20260911184112-60","remaining_quantity":"10.0000","status":"ACTIVE","expiry_date":"2026-11-10","cost_price":"10000.00","original_cost_price":"10000.000000"},{"id":"80`
- PASS `SEED_ORIGINAL`: critical original=10000.000000 carrying=10000.00
- PASS `LIVE_FORGE_POSTED_NULL_JE`: POSTED lot write-down requires a posted journal
  - measured: `{"docs":{"n":"0"}}`
- PASS `LIVE_FORGE_TX_COST_DROP`: after carrying=10000.00 qty=10.0000 docs=0 err=POSTED lot write-down requires a posted journal
  - measured: `{"before":{"cost_price":"10000.00","remaining_quantity":"10.0000"},"after":{"cost_price":"10000.00","remaining_quantity":"10.0000"}}`
- PASS `LIVE_COST_INCREASE_FORBIDDEN`: inventory_batches.cost_price cannot increase after lot creation
- PASS `LIVE_REJECT_QUARANTINE`: LOT_WRITE_DOWN_NOT_ACTIVE
  - measured: `{"message":"Quarantined, expired, or blocked lots cannot be written down. Damaged stock stays in quarantine."}`
- PASS `LIVE_REJECT_EXPIRED`: LOT_WRITE_DOWN_EXPIRED
  - measured: `{"message":"Calendar-expired stock cannot be written down to sell. Quarantine then dispose (5130)."}`
- PASS `LIVE_REJECT_NO_EXPIRY`: LOT_WRITE_DOWN_NO_EXPIRY
  - measured: `{"message":"Write-down is only for soon-to-expire lots. This batch has no expiry date. If it is damaged, use quarantine."}`
- PASS `LIVE_REJECT_BEYOND_60`: LOT_WRITE_DOWN_NOT_CRITICAL
  - measured: `{"message":"Write-down is only for lots expiring within 60 days that are still sellable. Expired stock must be quarantined."}`
- PASS `LIVE_REJECT_SAME_COST`: LOT_WRITE_DOWN_NOT_BELOW_CARRYING
  - measured: `{"message":"New carrying cost must be below the current book cost."}`
- PASS `LIVE_ACCEPT_60`: 60d markdown=40000 doc=LWD-2026-00203
  - measured: `{"sixtyResult":{"documentId":"06c9e959-3112-480a-abd4-0ab67d201b00","documentNumber":"LWD-2026-00203","inventoryBatchId":"1b8de602-3e4c-4e0c-8503-b567ca4721dc","productId":"eb86d14c-93fa-4908-b945-88414db780c0","quantity":10,"originalUnitCo`
- PASS `LIVE_WINDOW_1`: 1d band=critical markdown=8000 carrying=6000.00 original=10000.000000
  - measured: `{"posted":{"documentId":"3a573e0b-4189-48de-9af9-c58820153093","documentNumber":"LWD-2026-00204","inventoryBatchId":"337b495f-d0eb-4692-a6d5-e4e2088239fc","productId":"cf9b8070-ff90-4d48-8614-38020a9a93c6","quantity":2,"originalUnitCost":10`
- PASS `LIVE_WINDOW_7`: 7d band=critical markdown=8000 carrying=6000.00 original=10000.000000
  - measured: `{"posted":{"documentId":"7de73c96-cb71-4ba4-8ec9-f4d255bd7ce9","documentNumber":"LWD-2026-00205","inventoryBatchId":"4c8ebf7c-4347-4069-b229-06fc562e3884","productId":"cf9b8070-ff90-4d48-8614-38020a9a93c6","quantity":2,"originalUnitCost":10`
- PASS `LIVE_WINDOW_8`: 8d band=warning markdown=8000 carrying=6000.00 original=10000.000000
  - measured: `{"posted":{"documentId":"ca0ff4ab-12b0-4f8e-9f00-cb32e83a0cad","documentNumber":"LWD-2026-00206","inventoryBatchId":"b46b6459-a40c-4f8e-87e7-29a6851c1653","productId":"cf9b8070-ff90-4d48-8614-38020a9a93c6","quantity":2,"originalUnitCost":10`
- PASS `LIVE_WINDOW_20`: 20d band=warning markdown=8000 carrying=6000.00 original=10000.000000
  - measured: `{"posted":{"documentId":"aaa28b65-7437-41a9-84e4-11526a7a04b8","documentNumber":"LWD-2026-00207","inventoryBatchId":"eb58ec17-0b80-4563-a008-1322ca3cdd1c","productId":"cf9b8070-ff90-4d48-8614-38020a9a93c6","quantity":2,"originalUnitCost":10`
- PASS `LIVE_WINDOW_30`: 30d band=warning markdown=8000 carrying=6000.00 original=10000.000000
  - measured: `{"posted":{"documentId":"7cc6a246-d59f-470f-8d09-7241901c6996","documentNumber":"LWD-2026-00208","inventoryBatchId":"1cf6698e-5953-4251-a0ad-a0ddda491bcc","productId":"cf9b8070-ff90-4d48-8614-38020a9a93c6","quantity":2,"originalUnitCost":10`
- PASS `LIVE_WINDOW_45`: 45d band=watch markdown=8000 carrying=6000.00 original=10000.000000
  - measured: `{"posted":{"documentId":"8e8b8c7d-333f-4c15-85b5-9c46bd344439","documentNumber":"LWD-2026-00209","inventoryBatchId":"f167bfc0-f181-4610-81e7-a1d1f2fe2ae4","productId":"cf9b8070-ff90-4d48-8614-38020a9a93c6","quantity":2,"originalUnitCost":10`
- PASS `LIVE_WINDOW_60`: 60d band=watch markdown=8000 carrying=6000.00 original=10000.000000
  - measured: `{"posted":{"documentId":"248811f5-bbfb-4842-b235-bd7b7e2d20f5","documentNumber":"LWD-2026-00210","inventoryBatchId":"5e549fc3-fdac-4ae5-a99e-a4ecde912c7b","productId":"cf9b8070-ff90-4d48-8614-38020a9a93c6","quantity":2,"originalUnitCost":10`
- PASS `LIVE_WINDOW_REJECT_61`: LOT_WRITE_DOWN_NOT_CRITICAL
  - measured: `{"message":"Write-down is only for lots expiring within 60 days that are still sellable. Expired stock must be quarantined."}`
- PASS `LIVE_WINDOW_WARNING_WATCH`: 20d band=warning 45d band=watch (Critical KPI stays ≤7d)
  - measured: `{"warningPosted":{"days":20,"band":"warning","eligible":true,"amount":8000,"carrying":"6000.00","original":"10000.000000"},"watchPosted":{"days":45,"band":"watch","eligible":true,"amount":8000,"carrying":"6000.00","original":"10000.000000"}`
- PASS `LIVE_WINDOW_POS_AT_NEW`: POS at new carrying 6000 allowed after warning/watch markdown (below original 10000)
- PASS `LIVE_WINDOW_POS_BELOW_NEW`: POS below new carrying rejected (BELOW_ALLOCATED_COST)
- PASS `LIVE_REPORT_HORIZON_60`: Expiring Items horizon 60 lists 20/45/60d, excludes 61d
  - measured: `{"horizon":60,"has20":true,"has45":true,"has60":true,"has61":false}`
- PASS `LIVE_REPORT_HORIZON_30_MISS_WATCH`: Horizon 30 lists 20d warning, misses 45/60d watch — default UI horizon must be 60
  - measured: `{"horizon":30,"has20":true,"has45":false,"has60":false}`
- PASS `LIVE_WINDOW_MATRIX`: SSOT window 1–60; reject 61
  - measured: `{"accept":[1,7,8,20,30,45,60],"reject":61,"posted":[{"days":1,"band":"critical","eligible":true,"amount":8000,"carrying":"6000.00","original":"10000.000000"},{"days":7,"band":"critical","eligible":true,"amount":8000,"carrying":"6000.00","or`
- PASS `LIVE_POS_CATALOG_UNCHANGED`: valSell=10000.00 valCost=5000.00 batch=3000.00 original=5000.000000
  - measured: `{"catalogAfter":{"selling_price":"10000.00","cost_price":"5000.00","product_selling":"10000.00","product_cost":"5000.00"},"batchAfter":{"cost_price":"3000.00","original_cost_price":"5000.000000"}}`
- PASS `LIVE_POS_ENGINE_FLOOR`: engine sell=10000 allocated=3000 bulkAlloc=3000 scope=base
  - measured: `{"enginePrice":{"finalPrice":10000,"basePrice":10000,"discount":0,"appliedRule":{"ruleId":null,"ruleName":null,"ruleType":null,"ruleValue":null,"scope":"base"},"allocatedCostPerBase":3000,"allocatedLayers":[{"baseQuantity":1,"unitCostPerBas`
- PASS `LIVE_POS_SALE_AT_NEW_CARRYING`: createSale at 3000 after markdown (catalog sell 10000) saleId=8d309bcc-331d-4765-a8ff-200a3f1f7683
  - measured: `{"saleAtCarry":{"ok":true,"code":"","saleId":"8d309bcc-331d-4765-a8ff-200a3f1f7683"}}`
- PASS `LIVE_POS_SALE_BELOW_NEW_CARRYING`: BELOW_ALLOCATED_COST
  - measured: `{"saleBelow":{"ok":false,"code":"BELOW_ALLOCATED_COST","message":"Sale blocked. Selling price cannot be below actual inventory cost."}}`
- PASS `LIVE_POS_SALE_AT_CATALOG`: createSale at unchanged catalog 10000 saleId=bb64ceab-d0f7-4960-9901-65275cab9d35
  - measured: `{"saleCatalog":{"ok":true,"code":"","saleId":"bb64ceab-d0f7-4960-9901-65275cab9d35"}}`
- PASS `LIVE_POS_SQL_DOC`: doc=LWD-2026-00211 status=POSTED orig=5000.000000 new=3000.000000 amt=8000.00 je=c5966f8e-09d2-4548-9eff-073d93d3c273
  - measured: `{"posDoc":{"document_number":"LWD-2026-00211","status":"POSTED","reason":"NEAR_EXPIRY","quantity":"4.0000","original_unit_cost":"5000.000000","previous_carrying_unit_cost":"5000.000000","new_carrying_unit_cost":"3000.000000","total_amount":`
- PASS `LIVE_POS_SQL_WD_GL`: DR5140=8000 CR1300=8000 forbidden=none
  - measured: `{"posGl":[{"account":"5140","debit":"8000.000000","credit":"0.000000","source":"INVENTORY_MOVE","ref_type":"LOT_WRITE_DOWN"},{"account":"1300","debit":"0.000000","credit":"8000.000000","source":"INVENTORY_MOVE","ref_type":"LOT_WRITE_DOWN"}]`
- PASS `LIVE_POS_SQL_SALES`: at SALE-2026-0247 price=3000.00 cogs=3000.00; cat SALE-2026-0248 price=10000.00 cogs=3000.00
  - measured: `{"postedSales":[{"id":"8d309bcc-331d-4765-a8ff-200a3f1f7683","sale_number":"SALE-2026-0247","total_amount":"3000.00","total_cost":"3000.00","profit":"0.00","idempotency_key":"POS-AT-20260911184112","unit_price":"3000.00","unit_cost":"3000.0`
- PASS `LIVE_POS_SQL_NO_BELOW_SALE`: below-cost idempotency POS-BELOW-20260911184112 sales=0 code=BELOW_ALLOCATED_COST
  - measured: `{"belowPosted":{"n":"0"},"saleBelow":{"ok":false,"code":"BELOW_ALLOCATED_COST","message":"Sale blocked. Selling price cannot be below actual inventory cost."}}`
- PASS `LIVE_POS_SQL_QTY_AND_FLOOR`: remaining=2.0000 carrying=3000.00 original=5000.000000
  - measured: `{"qtyAfterSales":{"remaining_quantity":"2.0000","cost_price":"3000.00","original_cost_price":"5000.000000"}}`
- PASS `LIVE_POS_SQL_SALE_GL`: cashDR=13000 revCR=13000 cogsDR=6000 invCR=6000 forbidden=none
  - measured: `{"posSaleGl":[{"ref_type":"SALE","source":"SALES_INVOICE","account":"1010","debit":"3000.000000","credit":"0.000000","sale_id":"8d309bcc-331d-4765-a8ff-200a3f1f7683"},{"ref_type":"SALE","source":"SALES_INVOICE","account":"4000","debit":"0.0`
- PASS `LIVE_POS_SQL_GROSS_PROFIT`: sale.profit sum=7000 GL 4000-5000=7000; COGS uses carrying 3000 not original 5000
  - measured: `{"saleProfitSum":7000,"glGross":7000,"sqlAt":{"id":"8d309bcc-331d-4765-a8ff-200a3f1f7683","sale_number":"SALE-2026-0247","total_amount":"3000.00","total_cost":"3000.00","profit":"0.00","idempotency_key":"POS-AT-20260911184112","unit_price":`
- PASS `LIVE_POS_SQL_VALUATION_IDENTITY`: open 20000 - WD 8000 - COGS 6000 = 6000; subledger 2×3000=6000; cash+inv-open=-1000 P&L=-1000
  - measured: `{"openingInv":20000,"markdown1300":8000,"cogs1300":6000,"remainingInv":6000,"cash":13000,"revenue":13000,"cogs":6000,"markdown5140":8000,"netPnl":-1000}`
- PASS `LIVE_POS_SQL_NO_DOUBLE_COUNT`: 5140=8000 is clearance expense; COGS 5000=6000 is remaining carrying not original 10000
  - measured: `{"markdown5140":8000,"cogs5000":6000}`
- PASS `LIVE_DOC`: doc=LWD-2026-00212 account=5140 amount=40000
  - measured: `{"result":{"documentId":"27d1df4f-bf29-4dea-80e6-4581b7790ba7","documentNumber":"LWD-2026-00212","inventoryBatchId":"802ef284-a032-432b-aaf9-44e742bdbd6a","productId":"eb86d14c-93fa-4908-b945-88414db780c0","quantity":10,"originalUnitCost":1`
- PASS `LIVE_QTY_UNCHANGED`: remaining=10
- PASS `LIVE_AMOUNT`: markdown=40000 expected=40000
- PASS `LIVE_ORIGINAL_KEPT`: original=10000.000000 carrying=6000.00 status=ACTIVE
  - measured: `{"after":{"remaining_quantity":"10.0000","cost_price":"6000.00","original_cost_price":"10000.000000","status":"ACTIVE"}}`
- PASS `LIVE_STATUS_ACTIVE`: status=ACTIVE qty=10.0000
- PASS `LIVE_DOC_ROW`: reason=NEAR_EXPIRY account=5140 je=dbc7c1d4-0678-4c3a-b5b5-d0c8a5d0ccfc
- PASS `LIVE_GL_SHAPE`: DR5140=40000 CR1300=40000 forbidden=none
  - measured: `{"gl":[{"txn":"TXN-000432","account":"1300","debit":"0.000000","credit":"40000.000000","ref_type":"LOT_WRITE_DOWN","source":"INVENTORY_MOVE"},{"txn":"TXN-000432","account":"5140","debit":"40000.000000","credit":"0.000000","ref_type":"LOT_WR`
- PASS `LIVE_GL_SOURCE`: ref=LOT_WRITE_DOWN source=INVENTORY_MOVE
- PASS `LIVE_COUPLING`: qty×delta=40000 matches DR5140=40000
- PASS `LIVE_NO_STOCK_MOVEMENT`: stock_movements for critical batch=0
- PASS `LIVE_FEFO_CARRYING`: FEFO first cost_price=6000.00 (expected 6000); layers=1
  - measured: `{"fefo":[{"remaining_quantity":"10.0000","cost_price":"6000.00"}]}`
- PASS `LIVE_POS_AT_NEW_COST`: sale at 6000 allowed
- PASS `LIVE_POS_BELOW_NEW_COST`: BELOW_ALLOCATED_COST
- PASS `LIVE_ORIGINAL_IMMUTABLE`: original_cost_price is immutable after lot creation
- PASS `LIVE_COST_NEEDS_DOC`: inventory_batches.cost_price may decrease only via a posted lot write-down document
- PASS `LIVE_REPEAT_WRITE_DOWN`: second carrying=3000 amount=30000
- PASS `LIVE_REPEAT_ORIGINAL_KEPT`: original=10000.000000 carrying=3000.00
- PASS `LIVE_REJECT_FLOOR`: LOT_WRITE_DOWN_BELOW_FLOOR
  - measured: `{"message":"New carrying cost cannot be below the governed floor (0.01)."}`
- PASS `LIVE_FEFO_CONSUME_CARRYING`: consume costPrice=3000 expected 3000
  - measured: `{"layers":[{"lotId":"802ef284-a032-432b-aaf9-44e742bdbd6a","lotNumber":"LWD-20260911184112-C","quantity":1,"costPrice":3000,"productLotId":null}]}`
- PASS `LIVE_OFFLINE_SYNC_COST_SSOT`: after edge cost overwrite attempt carrying=3000.00 original=10000.000000
- PASS `LIVE_OFFLINE_STALE_BELOW`: server SSOT rejects price below current carrying regardless of client cache
- PASS `LIVE_CONCURRENT_QTY`: write-down after concurrent consume qty=9 amount=36000
- PASS `LIVE_CONCURRENT_NO_STALE_COST`: race remaining=9.0000 carrying=6000.00
- PASS `LIVE_DISPOSE_PRE_WD`: dispose-lot markdown=40000
- PASS `LIVE_DISPOSE_EXPIRED_STORE`: expiredStore=b2c1492f-fa73-46bb-b377-68fd597ee340
- PASS `LIVE_DISPOSE_QUARANTINE`: multistore EXPIRED store + lot 64455330-6c08-419e-823b-62f8a55c67b3
- PASS `LIVE_DISPOSE_REJECT_ORIGINAL`: Disposal must use remaining carrying cost 6000; caller supplied 10000. Original acquisition cost is not used after a write-down.
- PASS `LIVE_DISPOSE_ACCOUNT`: dispose account=5130
- PASS `LIVE_DISPOSE_CARRYING_NOT_ORIGINAL`: DR5130=60000 CR1300=60000 DR5140=0 (must be remaining carrying 60000, not original 100000)
  - measured: `{"glDisp":[{"account":"5130","debit":"60000.000000","credit":"0.000000"},{"account":"1300","debit":"0.000000","credit":"60000.000000"}]}`

## Reproduce

```bash
cd SamplePOS.Server && npx tsx scripts/proof-lot-write-down-live.ts
npm run proof:lot-write-down:live
```

Requires: `DATABASE_URL`, accounts 1300/5140, migration 611. Exit 2 if DATABASE_URL missing. Unexpected errors are not swallowed.
