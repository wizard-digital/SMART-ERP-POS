# PROOF: Sales order proceed path (inventory ATP → delivery → AR)

- Runner: `cd SamplePOS.Server && npm test -- --runInBand src/modules/distribution/distSalesOrderProceed.evidence.test.ts`
- Companion: `PROOF_DIST_SALES_ORDER_TOTALS_SSOT.md` (order value SSOT)
- Verdict: see JSON (`PROOF_DIST_SALES_ORDER_PROCEED_ATP_SSOT.json`)

## Root cause (Confirmed = 1, Available = 0)

ATP used to count **global** ACTIVE batches while delivery deducted at **MAIN**. Stock for Abchlor eye droped sat on POS **SELLING 002** (sellable 6); MAIN had 0 → toast Available: 0 despite “ATP reserved”.

**Fix:** `resolveDistributionIssueStoreId` = active POS SELLING, else MAIN. Multistore ATP and `deductStockFEFO` both use that store. Reconfirm recalculates confirmed from the same ATP.

## Global document flow

```
Customer ──► Sales Order (DSO) ──► Confirm from ATP ──► Delivery ──► Invoice (AR) ──► Payment/Clearing
                 │                      │                    │
                 │                      │                    └─ FEFO deduct at issue store
                 │                      └─ issue-store sellable − reserved
                 └─ created_by; credit_limit at delivery
```

| Domain | Connection |
|---|---|
| **Inventory** | `confirmed = min(ordered, ATP)`. Multistore ATP = sellable balances at issue store − undelivered confirmed on open DSOs. Delivery deducts at the same store. |
| **Customers** | SO requires `customer_id`. Credit limit at delivery. Clearing uses customer AR + deposits. |
| **Accounting** | Delivery creates dist invoice (AR). Payment via distribution clearing. |
| **Delivery** | Only confirmed undelivered qty can ship. |
| **Users** | `created_by`; permissions `distribution.*`, `delivery.*`, `accounting.*`, `inventory.read`. |

## How to proceed on DSO-2026-0001

1. Restart API if it was running before this fix.
2. Open the order → **Confirm Delivery** (Confirmed already 1; stock is on shop outlet 002).
3. If Confirmed was wrong after older ATP, use **Refresh confirmation** first.
