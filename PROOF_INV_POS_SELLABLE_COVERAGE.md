# PROOF_INV_POS_SELLABLE_COVERAGE

Verdict: **PASS** (10/10)

- PASS `RESOLVE_DEFAULT_SELLING`: Implicit GR allocate prefers POS SELLING via shared resolver
- PASS `OPENING_ALLOCATES`: Opening balance allocates to store balances under multistore
- PASS `ENABLE_BACKFILL`: Enabling multistore runs POS sellable backfill
- PASS `BACKFILL_MOVES_MAIN`: Backfill moves MAIN→SELLING and asserts INV-POS
- PASS `COVERAGE_REASONS`: INV-POS gap detector + quarantine reason + projection assert exist
- PASS `PROJECTION_ALLOWS_QUARANTINE`: projection hard-fail is NO_LOT / SELLING_ZERO_NO_BALANCES only
- PASS `COUPLING_WIRES_POS`: Warehouse coupling asserts POS projection gaps
- PASS `NETWORK_COMPANY_STOCK`: Inventory company qty is MAIN+shops; POS catalog and visibility stay selling-store scoped
- PASS `UI_STOCK_DEFAULT_SELLING`: Products and Stock Levels put warehouse→shop picker in Filters; company overlays network stock-levels SSOT
- PASS `UI_GR_DEFAULT_SELLING`: Goods Receipt default destination is SELLING
