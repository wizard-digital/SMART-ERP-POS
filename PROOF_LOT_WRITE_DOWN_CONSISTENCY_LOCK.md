# PROOF — Lot Write-Down Consistency Lock

Generated: 2026-09-11T18:16:00Z  
**Passed: true**  
**No deploy performed in this verification.**

## Why this lock exists

Earlier “proof passed” still left users seeing **current = original** and POS below-cost blocks because:

1. Production had **zero** successful UI write-down posts (prompt validation / no refresh).
2. Catalog cost never changes — only **lot carrying** does.
3. POS floor must come from **FEFO `allocatedCostPerBase`**, not product cost.

## Verification layers (all green)

| Layer | Command / check | Result |
|--------|------------------|--------|
| SSOT / evidence | `npm run proof:lot-write-down` | **14/14** |
| Live journey (local DB) | `npm run proof:lot-write-down:live` | **74/74** |
| Prod Henber (read-only) | migrations, 5140, doc↔batch coupling | **PASS** |
| Prod SPA | Clearance markdown + allocatedCostPerBase | **PASS** |

## Production Henber snapshot (read-only)

- HEAD: `43ff0ddb`
- Migrations: 611 / 612 / 613
- Posted LWD docs: **1**
- Diverged lots (carrying ≠ original): **1**
- Orphan diverged (no matching LWD): **0**
- Posted docs missing journal: **0**
- Doc vs batch mismatch: **0**
- Example: `IMP-INIT-SKU-3901` carrying **22,500** / original **45,000**

## Invariants that must never break

1. `original_cost_price` never changes after insert.
2. `cost_price` decreases only via POSTED `lot_write_down_documents` + JE DR **5140** / CR **1300**.
3. Quantity unchanged; catalog/product cost unchanged.
4. POS may sell at/above **new carrying**; below → `BELOW_ALLOCATED_COST`.
5. Expiring Items UI parses comma amounts and patches carrying vs original after POST.
6. FEFO preview coerces qty to Decimal before `.lessThanOrEqualTo`.

## Re-run anytime

```bash
cd SamplePOS.Server
npm run proof:lot-write-down
npm run proof:lot-write-down:live
# prod read-only (SSH):
# bash scripts/_verify-lwd-prod-henber.sh
```
