# PROOF — Lot Write-Down Consistency Lock

Generated: 2026-09-11T21:12:00Z  
**Passed: true**  
**Admin-only: locked** (`PROOF_LOT_WRITE_DOWN_ADMIN_ONLY`)

## Why this lock exists

Earlier “proof passed” still left users seeing **current = original** and POS below-cost blocks because:

1. Production had **zero** successful UI write-down posts (prompt validation / no refresh).
2. Catalog cost never changes — only **lot carrying** does.
3. POS floor must come from **FEFO `allocatedCostPerBase`**, not product cost.
4. Clearance markdown must be **ADMIN-only** — `inventory.adjust` must never bypass.

## Verification layers (all green)

| Layer | Command / check | Result |
|--------|------------------|--------|
| SSOT / evidence | `npm run proof:lot-write-down` | **19/19** |
| ADMIN-only integrity | `npm run proof:lot-write-down:admin` | **17/17** |
| Live journey (local DB) | `npm run proof:lot-write-down:live` | **74/74** |

## Invariants that must never break

1. `original_cost_price` never changes after insert.
2. `cost_price` decreases only via POSTED `lot_write_down_documents` + JE DR **5140** / CR **1300**.
3. Quantity unchanged; catalog/product cost unchanged.
4. POS may sell at/above **new carrying**; below → `BELOW_ALLOCATED_COST`.
5. Expiring Items UI parses comma amounts and patches carrying vs original after POST.
6. FEFO preview coerces qty to Decimal before `.lessThanOrEqualTo`.
7. **Clearance markdown = absolute ADMIN / SUPER_ADMIN only** (`ERR_LOT_WRITE_DOWN_ADMIN_ONLY`). Route + service DB role + UI. Manager/cashier/`inventory.adjust` cannot post.

## Re-run anytime

```bash
cd SamplePOS.Server
npm run proof:lot-write-down:admin
npm run proof:lot-write-down
npm run proof:lot-write-down:live
```
