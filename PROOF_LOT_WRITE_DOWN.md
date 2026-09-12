# PROOF: Near-expiry lot write-down (NRV)

**Result:** PASS
**As of:** 2026-09-12T05:44:00.908Z

## Claims
- Still-sellable lots expiring within 60 days may be written down; original cost is preserved.
- Carrying cost_price is the POS/FEFO/AT_COST floor; no till override.
- Damaged/quarantined/calendar-expired/no-expiry cannot use write-down.
- GL DR 5140 / CR 1300; qty unchanged; not 5110/5120/5130 disposal.
- UI, API default, PDF fallback, and live window matrix all use LOT_WRITE_DOWN_MAX_DAYS (60).
- POS walk-in selling price stays catalog; till floor is FEFO carrying after write-down (edit down to new carrying allowed).
- Valuation SSOT is remaining qty × carrying; GL 1300 matches; COGS 5000 uses carrying not original; 5140 is separate P&L (no double-count).

## Gates
- PASS `SQL_ORIGINAL_COST` — original_cost_price on inventory_batches
- PASS `SQL_TRIGGER_INSERT_ONLY` — original set on insert only
- PASS `SQL_DOC` — NEAR_EXPIRY document
- PASS `SQL_5140` — 5140 clearance markdown
- PASS `SQL_NO_QTY_CONSUME` — does not consume qty in SQL
- PASS `SQL_ORIGINAL_IMMUTABLE` — 612 freezes original after insert
- PASS `SQL_613_NO_NULL_JE_AUTH` — 613: decrease not authorized by NULL JE; increases forbidden; deferred journal required
- PASS `NO_HANDLER` — no SM consume path
- PASS `NO_CONSUME_LOT` — no lot consume
- PASS `NO_DISPOSAL_ACCOUNTS` — does not debit 5110-5130
- PASS `USES_5140` — 5140
- PASS `UPDATES_CARRYING` — carrying only
- PASS `GL_INVENTORY_MOVE` — Rule H 1300 source
- PASS `REF_TYPE` — reference LOT_WRITE_DOWN
- PASS `FEFO_COST_PRICE` — FEFO reads batch cost_price
- PASS `BELOW_COST_HARD` — till has no write-down bypass
- PASS `BAND_SSOT` — write-down 1–60 days; Critical KPI stays ≤7d
- PASS `CRITICAL_OK` — 2 × 400 markdown
- PASS `SIXTY_OK` — day 60 still eligible
- PASS `SIXTY_ONE_BLOCK` — day 61 blocked
- PASS `QUARANTINE_BLOCK` — quarantined blocked
- PASS `EXPIRED_BLOCK` — calendar expired blocked
- PASS `NO_EXPIRY_BLOCK` — no expiry (in-transit damage path) blocked
- PASS `UI_WRITE_DOWN` — write-down on Expiring Items
- PASS `UI_CLEARANCE_NAME` — named clearance markdown not below-cost sale
- PASS `UI_ADMIN_ONLY` — Clearance markdown UI gated to absolute ADMIN
- PASS `UI_60_DAY_WINDOW` — UI uses 60-day write-down SSOT
- PASS `UI_QUARANTINE_EXPIRED` — quarantine still expired-only
- PASS `EXPENSE_ACCOUNT` — 5140 constant
- PASS `SSOT_ZOD_HORIZON` — Expiring Items API default = LOT_WRITE_DOWN_MAX_DAYS
- PASS `SSOT_PDF_FALLBACK` — PDF days fallback = LOT_WRITE_DOWN_MAX_DAYS
- PASS `SSOT_REJECT_MSG` — reject copy uses LOT_WRITE_DOWN_MAX_DAYS
- PASS `SSOT_LIVE_MATRIX` — live proof measures 1/7/8/20/30/45/60 + report horizon + POS 10000/3000 SQL + P&L/valuation identity
- PASS `SSOT_ENGINE_ALLOCATED` — pricing engine attaches live FEFO carrying on every resolved price
- PASS `SSOT_POS_ALLOCATED_FLOOR` — POS walk-in syncs cart cost floor from allocated FEFO carrying
- PASS `UI_COMMA_PARSE` — write-down submits the typed figure on Enter (form SSOT, no prompt default)
- PASS `UI_PATCH_AFTER_POST` — after POST: patch carrying vs original in open report + surface API errors
- PASS `FEFO_COERCE_DECIMAL` — FEFO preview coerces numeric qty to Decimal (no lessThanOrEqualTo crash)
- PASS `ROUTE_NOT_INVENTORY_ADJUST` — HTTP route is ADMIN-only — inventory.adjust cannot authorize write-down
- PASS `SERVICE_DB_ROLE_GATE` — service re-checks users.role inside the posting transaction
- PASS `SSOT_ADMIN_HELPERS` — shared SSOT exports ADMIN-only helpers

## Executed / live (not source greps)

- `PROOF_LOT_WRITE_DOWN_EXECUTED.json` — service called with mocked PG; rejects throw.
- `PROOF_LOT_WRITE_DOWN_LIVE.md` — `npm run proof:lot-write-down:live` against DATABASE_URL.
