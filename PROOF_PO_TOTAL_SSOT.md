# PROOF — PO line total preservation

**Generated:** 2026-09-23T06:13:49.503Z  
**Verdict:** **PASS** (20/20)  
**Scope:** Typed line total is preserved (7000 stays 7000). Root cause of residual 24×291.67=7000.08: DB unit_price NUMERIC(*,2) truncated precise units; migration 610 widens to 6dp; Edit load hydrates from stored total.

## Live math (why some lines still show 7000.08)

| Path | Unit | Line total |
|------|------|------------|
| Entered total 7000 ÷ 24 (needed) | 291.666667 | **7000.00** |
| DB `unit_price NUMERIC(15,2)` truncate | 291.67 | **7000.08** |

## Gates

| Gate | Result | Detail |
|------|--------|--------|
| `BUG_2DP_WOULD_BREAK` | PASS | documents the bad path: 24×291.67 = 7000.08 |
| `PRESERVE_7000` | PASS | typed 7000 stays 7000.00; unit precision only as needed |
| `SAVE_PRESERVES_TOTAL` | PASS | save finalize keeps 7000 when line total was entered |
| `PREFER_2DP_WHEN_CLEAN` | PASS | clean totals still use 2dp unit cost |
| `UNIT_LED_OK` | PASS | unit-cost lead still PE(qty×2dp unit) |
| `UNIT_BLUR_KEEPS_PRECISE` | PASS | blur must not 2dp-snap a total-led unit (would create 7000.08) |
| `UNIT_BLUR_TRUE_EDIT` | PASS | blur snaps a true unit edit that no longer matches the line total |
| `RESOLVE_MIN_DP` | PASS | resolver does not stop at 2dp when that breaks the total |
| `PE_ENGINE` | PASS | PricingEngine agrees with preserved total |
| `EDIT_LOAD_BARE_QTY_UNIT_BUG` | PASS | bare qty×unit (old Edit load) produces 7000.08 |
| `HYDRATE_PREFERS_STORED_TOTAL` | PASS | hydrate prefers stored 7000 over 2dp unit that would yield 7000.08 |
| `HYDRATE_KEEPS_LEGACY_PAIR` | PASS | legacy consistent 291.67/7000.08 rows stay honest until re-edited |
| `DB_TRUNCATE_MATH` | PASS | 6dp unit keeps 7000; 2dp truncate forces 7000.08 |
| `MIGRATION_610_UNIT_6DP` | PASS | migration widens purchase_order_items.unit_price to 6dp |
| `POSTCONDITION_610` | PASS | migration postcondition requires unit_price scale >= 6 |
| `UI_HYDRATE_WIRING` | PASS | Edit/details hydrate from stored total — no bare qty×unit reload |
| `SSOT_PRESERVE_LAW` | PASS | SSOT documents preserve-total law |
| `UI_SYNC_PRESERVE` | PASS | UI blur/save/load use preserve-total helpers |
| `SERVER_UNIT_6DP` | PASS | server stores precise unit so PE line can equal entered total |
| `SSOT_FILES` | PASS | po-line-uom SSOT + 610 migration present |
