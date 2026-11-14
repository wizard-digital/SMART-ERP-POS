# LIVE PROOF — Restaurant KOT stock (Samba)

**Verdict: PASS** (scratch DB clone → exercise → drop)

Script: `SamplePOS.Server/scripts/proof-restaurant-kot-stock-live.ts`  
Artifact: `PROOF_RESTAURANT_KOT_STOCK_LIVE.json`

## Measured path

| Step | Evidence |
|------|----------|
| Batch before KOT | **20** |
| `sendKot` | KOT-2026-0001 fired |
| Batch after KOT | **17** (Δ −3) |
| Movement | `ADJUSTMENT_OUT` / `RESTAURANT_KOT` qty=3 unit_cost=4000 |
| Void qty 1 | Batch **18** (Δ +1) |
| Movement | `ADJUSTMENT_IN` / `RESTAURANT_KOT_VOID` qty=1 |
| Net after void | qty=2 cost=8000 |
| `createSale` pay | `Skipping inventory deduction — restaurant KOT already issued` |
| Batch after pay | **18** (unchanged — no double deduct) |
| SALE stock movements | **0** |

Final math: start 20 → KOT −3 → void +1 → pay 0 = **18**. Net kitchen issue remaining = 2 (paid).

## Coupling fix proven

Pay COGS catches GL 1300 up after KOT physical issue. `assertInventoryCouplingUnchanged` now expects gap to shrink by `kotPreIssuedCost` when KOT already issued.
