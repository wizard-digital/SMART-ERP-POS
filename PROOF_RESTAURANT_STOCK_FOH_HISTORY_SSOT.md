# PROOF: Restaurant FOH stock + product-history balance SSOT

**Verdict: PASS** (2026-11-14)  
**Proof ID:** `RESTAURANT_STOCK_FOH_HISTORY_SSOT`  
**Deploy/commit:** not done (proof-only; await explicit ask)

---

## 1. Investigation — AMSTEL “double sale” (`SALE-2026-0004`)

| Observation | Conclusion |
|-------------|------------|
| Two “Sale” cards, same sale number, same second, −2 each | **Two `sale_items` on one SALE**, not two sale documents |
| Total OUT **4.00**, net **+18** from IN **22** | Stock math matches one payment that settled two lines |
| Both cards showed **Balance: 18** | **Display bug**: running balance keyed by `eventDate\|type\|quantityChange` → Map overwrite |
| Batch Remaining 20 vs product ~18 | Current batch join snapshot — not historical post-line balance |

**How two lines are created (enterprise FOH):** add → KOT → add same SKU again → pay once. Same sale number; two history cards is correct. Identical balances were not.

---

## 2. Fixes proven

### A. Product history running balance

- SSOT: `shared/utils/productHistoryRunningBalance.ts` (balance by **originalIndex**, same-second tie-break)
- Wired: `productHistoryService.ts` → `applyProductHistoryRunningBalances`
- Sale qty per card: `si.base_qty` / `sale_item_id` (never `SUM(stock_movements)` per sale×product)

**Unit proof:** two identical −2 SALE lines at the same timestamp get **distinct** balances `[20, 18]` after +22 open — never both `18`.

### B. Service vs inventory (reuse, no duplicate path)

| Product type | Menu remaining | FOH warn | Pay / createSale |
|--------------|----------------|----------|------------------|
| `service` | hidden (`null`) | never | `planSaleStockDeduction` → **skip** parent stock |
| `inventory` / `consumable` | **X left** | when oversell OFF + short | existing BR-INV-001 / FEFO hard fail |

### C. Restaurant allow-oversell (Toast-style soft FOH)

- Migration **647**: `system_settings.restaurant_allow_oversell` default **FALSE**
- Settings toggle: *Restaurant: allow order when stock is low*
- `GET /api/restaurant/enabled` → `{ enabled, allowOversell }`
- **OFF:** soft warn on add + KOT (“Avoid printing…”)
- **ON:** no FOH warn; order/KOT allowed when low
- **Pay:** still hard-fails insufficient stock (true negative inventory **not** shipped)

`sendKot` still does **not** call `validateStockAvailability` (kitchen fire stays soft; warn is FOH client).

---

## 3. Test evidence (executed)

```text
cwd: samplepos.client
command:
  npx vitest run
    src/__tests__/product-history-running-balance.unit.test.ts
    src/__tests__/restaurant-stock-policy.unit.test.ts
    src/__tests__/restaurant-stock-foh.evidence.test.ts
    --reporter=json
    --outputFile=../PROOF_GATES_ARTIFACTS/restaurant-stock-foh-vitest.json

result: 14 passed / 0 failed / 14 total
artifact: PROOF_GATES_ARTIFACTS/restaurant-stock-foh-vitest.json
sha256: 5151c309e46541468438c5ee892c0dc1af65863dc6e1412b950f3e690a8964fc
```

| File | Assertions | Status |
|------|------------|--------|
| `product-history-running-balance.unit.test.ts` | 2 | PASS |
| `restaurant-stock-policy.unit.test.ts` | 5 | PASS |
| `restaurant-stock-foh.evidence.test.ts` | 7 | PASS |

---

## 4. Gate checklist

| Gate | Name | Result |
|------|------|--------|
| H1 | AMSTEL same-second lines distinct balances | **PASS** |
| H2 | No `date\|type\|qty` balance key collision | **PASS** |
| H3 | Sale history qty = `sale_item` `base_qty` SSOT | **PASS** |
| S1 | Service skips menu remaining | **PASS** |
| S2 | Service never FOH stock warn | **PASS** |
| S3 | createSale `planSaleStockDeduction` skip for service | **PASS** |
| F1 | Oversell OFF warns KOT avoid printing | **PASS** |
| F2 | Oversell ON suppresses FOH warn | **PASS** |
| F3 | Menu `remaining_quantity` wired | **PASS** |
| F4 | FOH paints `data-menu-remaining-qty` | **PASS** |
| F5 | Settings + `/restaurant/enabled` `allowOversell` | **PASS** |
| F6 | Migration 647 + `CURRENT_SCHEMA_VERSION = 647` | **PASS** |
| F7 | `sendKot` does not `validateStockAvailability` | **PASS** |

---

## 5. Explicitly not proven (honest scope)

- Live DB inspection of `SALE-2026-0004` rows (no local Postgres in this run)
- Browser click path on production FOH
- Negative inventory at **pay** when oversell ON (deferred on purpose)
- Git commit / production deploy

---

## 6. Artifacts

- `PROOF_RESTAURANT_STOCK_FOH_HISTORY_SSOT.json`
- `PROOF_RESTAURANT_STOCK_FOH_HISTORY_SSOT.md`
- `PROOF_GATES_ARTIFACTS/restaurant-stock-foh-vitest.json`
- `PROOF_GATES_ARTIFACTS/restaurant-stock-foh-vitest.json.sha256`

## Verdict

**PASS — certified** for history balance SSOT + restaurant FOH remaining/oversell soft policy (unit + structural evidence). Not committed or deployed.
