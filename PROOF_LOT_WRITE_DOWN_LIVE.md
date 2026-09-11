# PROOF — Lot carrying-value write-down / inventory clearance markdown (LIVE)

**Verdict:** PASS
**Proven at:** 2026-09-11T07:32:31.442Z
**Stamp / SKU:** 20260911073228 / LWD-20260911073228

**Contract:** Lot carrying-value write-down / inventory clearance markdown: original_cost_price immutable; cost_price decreases only with a posted LWD document; 5140≠5120/5130; disposal uses remaining carrying; concurrent sale/write-down serializes on FOR UPDATE; offline/edge cannot overwrite carrying; POS floor is server FEFO carrying.

## Fixture

```json
{
  "productId": "05258c35-7b2a-469f-a32b-ccc9d0f12ada",
  "criticalId": "4e6dc657-dc5b-4715-b3e0-3ddc25397420",
  "sixtyId": "9e502332-a6f0-440f-8587-37b6c61e57b8",
  "warningId": "cb0b0f94-6b6b-415a-aedd-608a29321847",
  "expiredId": "3f05f940-5cc1-402a-a80d-02a5e35d6cfa",
  "noExpiryId": "e578e395-2bd1-448d-aa11-c4040e7dbdf5",
  "quarantinedId": "0f1cb351-e5a8-40ff-86eb-7dbd33050db2",
  "raceId": "7cc56a27-d75a-47c1-a2c4-26e12aea0918",
  "disposeId": "6e54ec2e-7ad1-4bfd-8152-dd189a1d62b9",
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
- PASS `SEED_PRODUCT`: productId=05258c35-7b2a-469f-a32b-ccc9d0f12ada sku=LWD-20260911073228
- PASS `SEED_BATCHES`: seeded 9 batches biz=2026-09-11
  - measured: `{"rows":[{"id":"9e502332-a6f0-440f-8587-37b6c61e57b8","batch_number":"LWD-20260911073228-60","remaining_quantity":"10.0000","status":"ACTIVE","expiry_date":"2026-11-10","cost_price":"10000.00","original_cost_price":"10000.000000"},{"id":"4e`
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
- PASS `LIVE_ACCEPT_60`: 60d markdown=40000 doc=LWD-2026-00176
  - measured: `{"sixtyResult":{"documentId":"afda502b-04da-4e0d-b1d3-a7fdea835005","documentNumber":"LWD-2026-00176","inventoryBatchId":"9e502332-a6f0-440f-8587-37b6c61e57b8","productId":"05258c35-7b2a-469f-a32b-ccc9d0f12ada","quantity":10,"originalUnitCo`
- PASS `LIVE_WINDOW_1`: 1d band=critical markdown=8000 carrying=6000.00 original=10000.000000
  - measured: `{"posted":{"documentId":"009569d0-e505-4c1e-aa90-00a761dc451c","documentNumber":"LWD-2026-00177","inventoryBatchId":"07054693-5b12-41a1-967e-806305c36fb4","productId":"ae1e6986-0b8d-49b1-a2bb-6b14d0452f7b","quantity":2,"originalUnitCost":10`
- PASS `LIVE_WINDOW_7`: 7d band=critical markdown=8000 carrying=6000.00 original=10000.000000
  - measured: `{"posted":{"documentId":"b6a5932b-cc89-472b-bf1f-5dcece5f5d46","documentNumber":"LWD-2026-00178","inventoryBatchId":"acba4ecd-9970-457e-8207-94a9296b5a03","productId":"ae1e6986-0b8d-49b1-a2bb-6b14d0452f7b","quantity":2,"originalUnitCost":10`
- PASS `LIVE_WINDOW_8`: 8d band=warning markdown=8000 carrying=6000.00 original=10000.000000
  - measured: `{"posted":{"documentId":"62651be7-a4c5-4b1e-9fd2-687f7c172368","documentNumber":"LWD-2026-00179","inventoryBatchId":"71eedd7e-c4e0-451d-84d3-a488b9067c44","productId":"ae1e6986-0b8d-49b1-a2bb-6b14d0452f7b","quantity":2,"originalUnitCost":10`
- PASS `LIVE_WINDOW_20`: 20d band=warning markdown=8000 carrying=6000.00 original=10000.000000
  - measured: `{"posted":{"documentId":"43964563-cb5c-4bc8-9571-2bc7b6508813","documentNumber":"LWD-2026-00180","inventoryBatchId":"f25da6d1-a2ca-417b-bb43-86bbfc119f39","productId":"ae1e6986-0b8d-49b1-a2bb-6b14d0452f7b","quantity":2,"originalUnitCost":10`
- PASS `LIVE_WINDOW_30`: 30d band=warning markdown=8000 carrying=6000.00 original=10000.000000
  - measured: `{"posted":{"documentId":"0f6fd9c9-c38d-4f4b-bde0-02da78d3376d","documentNumber":"LWD-2026-00181","inventoryBatchId":"af26cb85-1f97-4024-ae4e-5f0476a3dd00","productId":"ae1e6986-0b8d-49b1-a2bb-6b14d0452f7b","quantity":2,"originalUnitCost":10`
- PASS `LIVE_WINDOW_45`: 45d band=watch markdown=8000 carrying=6000.00 original=10000.000000
  - measured: `{"posted":{"documentId":"17106289-cee1-4339-be1a-cd88ea702917","documentNumber":"LWD-2026-00182","inventoryBatchId":"3de9d7bf-41b9-4c2a-b601-861f56984a7c","productId":"ae1e6986-0b8d-49b1-a2bb-6b14d0452f7b","quantity":2,"originalUnitCost":10`
- PASS `LIVE_WINDOW_60`: 60d band=watch markdown=8000 carrying=6000.00 original=10000.000000
  - measured: `{"posted":{"documentId":"874f5d83-ee27-4109-ba5d-1f357340d7cf","documentNumber":"LWD-2026-00183","inventoryBatchId":"be03fe58-5145-42bb-adc3-9a9b0c4ae13e","productId":"ae1e6986-0b8d-49b1-a2bb-6b14d0452f7b","quantity":2,"originalUnitCost":10`
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
- PASS `LIVE_POS_SALE_AT_NEW_CARRYING`: createSale at 3000 after markdown (catalog sell 10000) saleId=3bbf596c-aedd-4fd4-8edd-dddde678450e
  - measured: `{"saleAtCarry":{"ok":true,"code":"","saleId":"3bbf596c-aedd-4fd4-8edd-dddde678450e"}}`
- PASS `LIVE_POS_SALE_BELOW_NEW_CARRYING`: BELOW_ALLOCATED_COST
  - measured: `{"saleBelow":{"ok":false,"code":"BELOW_ALLOCATED_COST","message":"Sale blocked. Selling price cannot be below actual inventory cost."}}`
- PASS `LIVE_POS_SALE_AT_CATALOG`: createSale at unchanged catalog 10000 saleId=cbe702a9-5e65-405c-b584-24384332b251
  - measured: `{"saleCatalog":{"ok":true,"code":"","saleId":"cbe702a9-5e65-405c-b584-24384332b251"}}`
- PASS `LIVE_POS_SQL_DOC`: doc=LWD-2026-00184 status=POSTED orig=5000.000000 new=3000.000000 amt=8000.00 je=cd3a3108-6bf4-4d0b-8e21-933193813090
  - measured: `{"posDoc":{"document_number":"LWD-2026-00184","status":"POSTED","reason":"NEAR_EXPIRY","quantity":"4.0000","original_unit_cost":"5000.000000","previous_carrying_unit_cost":"5000.000000","new_carrying_unit_cost":"3000.000000","total_amount":`
- PASS `LIVE_POS_SQL_WD_GL`: DR5140=8000 CR1300=8000 forbidden=none
  - measured: `{"posGl":[{"account":"5140","debit":"8000.000000","credit":"0.000000","source":"INVENTORY_MOVE","ref_type":"LOT_WRITE_DOWN"},{"account":"1300","debit":"0.000000","credit":"8000.000000","source":"INVENTORY_MOVE","ref_type":"LOT_WRITE_DOWN"}]`
- PASS `LIVE_POS_SQL_SALES`: at SALE-2026-0242 price=3000.00 cogs=3000.00; cat SALE-2026-0243 price=10000.00 cogs=3000.00
  - measured: `{"postedSales":[{"id":"3bbf596c-aedd-4fd4-8edd-dddde678450e","sale_number":"SALE-2026-0242","total_amount":"3000.00","total_cost":"3000.00","profit":"0.00","idempotency_key":"POS-AT-20260911073228","unit_price":"3000.00","unit_cost":"3000.0`
- PASS `LIVE_POS_SQL_NO_BELOW_SALE`: below-cost idempotency POS-BELOW-20260911073228 sales=0 code=BELOW_ALLOCATED_COST
  - measured: `{"belowPosted":{"n":"0"},"saleBelow":{"ok":false,"code":"BELOW_ALLOCATED_COST","message":"Sale blocked. Selling price cannot be below actual inventory cost."}}`
- PASS `LIVE_POS_SQL_QTY_AND_FLOOR`: remaining=2.0000 carrying=3000.00 original=5000.000000
  - measured: `{"qtyAfterSales":{"remaining_quantity":"2.0000","cost_price":"3000.00","original_cost_price":"5000.000000"}}`
- PASS `LIVE_POS_SQL_SALE_GL`: cashDR=13000 revCR=13000 cogsDR=6000 invCR=6000 forbidden=none
  - measured: `{"posSaleGl":[{"ref_type":"SALE","source":"SALES_INVOICE","account":"1010","debit":"3000.000000","credit":"0.000000","sale_id":"3bbf596c-aedd-4fd4-8edd-dddde678450e"},{"ref_type":"SALE","source":"SALES_INVOICE","account":"4000","debit":"0.0`
- PASS `LIVE_POS_SQL_GROSS_PROFIT`: sale.profit sum=7000 GL 4000-5000=7000; COGS uses carrying 3000 not original 5000
  - measured: `{"saleProfitSum":7000,"glGross":7000,"sqlAt":{"id":"3bbf596c-aedd-4fd4-8edd-dddde678450e","sale_number":"SALE-2026-0242","total_amount":"3000.00","total_cost":"3000.00","profit":"0.00","idempotency_key":"POS-AT-20260911073228","unit_price":`
- PASS `LIVE_POS_SQL_VALUATION_IDENTITY`: open 20000 - WD 8000 - COGS 6000 = 6000; subledger 2×3000=6000; cash+inv-open=-1000 P&L=-1000
  - measured: `{"openingInv":20000,"markdown1300":8000,"cogs1300":6000,"remainingInv":6000,"cash":13000,"revenue":13000,"cogs":6000,"markdown5140":8000,"netPnl":-1000}`
- PASS `LIVE_POS_SQL_NO_DOUBLE_COUNT`: 5140=8000 is clearance expense; COGS 5000=6000 is remaining carrying not original 10000
  - measured: `{"markdown5140":8000,"cogs5000":6000}`
- PASS `LIVE_DOC`: doc=LWD-2026-00185 account=5140 amount=40000
  - measured: `{"result":{"documentId":"95968246-426e-4566-87cb-883d8424cf6c","documentNumber":"LWD-2026-00185","inventoryBatchId":"4e6dc657-dc5b-4715-b3e0-3ddc25397420","productId":"05258c35-7b2a-469f-a32b-ccc9d0f12ada","quantity":10,"originalUnitCost":1`
- PASS `LIVE_QTY_UNCHANGED`: remaining=10
- PASS `LIVE_AMOUNT`: markdown=40000 expected=40000
- PASS `LIVE_ORIGINAL_KEPT`: original=10000.000000 carrying=6000.00 status=ACTIVE
  - measured: `{"after":{"remaining_quantity":"10.0000","cost_price":"6000.00","original_cost_price":"10000.000000","status":"ACTIVE"}}`
- PASS `LIVE_STATUS_ACTIVE`: status=ACTIVE qty=10.0000
- PASS `LIVE_DOC_ROW`: reason=NEAR_EXPIRY account=5140 je=98737aa2-555f-4f0c-be30-762c3faf4e19
- PASS `LIVE_GL_SHAPE`: DR5140=40000 CR1300=40000 forbidden=none
  - measured: `{"gl":[{"txn":"TXN-000391","account":"1300","debit":"0.000000","credit":"40000.000000","ref_type":"LOT_WRITE_DOWN","source":"INVENTORY_MOVE"},{"txn":"TXN-000391","account":"5140","debit":"40000.000000","credit":"0.000000","ref_type":"LOT_WR`
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
  - measured: `{"layers":[{"lotId":"4e6dc657-dc5b-4715-b3e0-3ddc25397420","lotNumber":"LWD-20260911073228-C","quantity":1,"costPrice":3000,"productLotId":null}]}`
- PASS `LIVE_OFFLINE_SYNC_COST_SSOT`: after edge cost overwrite attempt carrying=3000.00 original=10000.000000
- PASS `LIVE_OFFLINE_STALE_BELOW`: server SSOT rejects price below current carrying regardless of client cache
- PASS `LIVE_CONCURRENT_QTY`: write-down after concurrent consume qty=9 amount=36000
- PASS `LIVE_CONCURRENT_NO_STALE_COST`: race remaining=9.0000 carrying=6000.00
- PASS `LIVE_DISPOSE_PRE_WD`: dispose-lot markdown=40000
- PASS `LIVE_DISPOSE_EXPIRED_STORE`: expiredStore=b2c1492f-fa73-46bb-b377-68fd597ee340
- PASS `LIVE_DISPOSE_QUARANTINE`: multistore EXPIRED store + lot 36a64a41-511b-4113-bb0e-15dcc26c97c2
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
