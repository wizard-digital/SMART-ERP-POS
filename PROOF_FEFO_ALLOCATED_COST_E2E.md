# PROOF_FEFO_ALLOCATED_COST_E2E

Verdict: **PASS** (6/6)

Evidence class: `api+db-live` — login, cash session, POST /api/sales, DB FEFO walk.

- PASS `LOGIN`: ok
- PASS `CASH_SESSION`: 9b2a160b
- PASS `PRODUCT_WITH_FEFO_STOCK`: Abchlor eye drops fefoCost/1=1000
- PASS `SALE_AT_FEFO_FLOOR`: status=201
- PASS `SALE_BELOW_FEFO_BLOCKED`: status=400 code=BELOW_ALLOCATED_COST
- PASS `BLOCK_MIN_MATCHES_DB_FEFO`: apiMin=1000 dbFefo=1000
