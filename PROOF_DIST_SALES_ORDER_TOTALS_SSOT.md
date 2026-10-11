# PROOF: Distribution sales order totals SSOT

- Date: see `PROOF_DIST_SALES_ORDER_TOTALS_SSOT.json`
- Runner: `cd SamplePOS.Server && npm test -- --runInBand src/modules/distribution/distSalesOrderTotals.evidence.test.ts`
- Verdict: **PASS**

## Incident

**DSO-2026-0001** showed Order Total / Line Total **UGX 0.00** while:

| Product | Ordered | Confirmed | Unit Price |
|---|---|---|---|
| Abmist Eye drops | 1 | 0 (backorder) | 10,000 |
| Ace-Paracetamol Syrup | 1 | 0 (backorder) | 6,000 |

Create/Edit UI previewed **16,000**; after save the detail page showed **0**.

## Root cause

`line_total` and `total_amount` were computed as **confirmedQty × unitPrice**. ATP=0 → Confirmed=0 → commercial totals collapsed to zero. Delivery / invoice / payment were already on delivered qty (correct) and were not the bug.

## Fix (no break to deliver / invoice / pay)

| Quantity base | Field | Meaning |
|---|---|---|
| **Ordered** | Line Total, Order Total | Commercial order value |
| **Confirmed** | Confirmed Value | ATP reserved |
| **Delivered** | delivery + invoice lines | What can be billed |
| **Invoice AR** | Invoice Due on detail | Open amount on posted invoices |

Write path (`addSalesOrderLine` / `updateSalesOrderLine`) and read path (list/get aggregates + line select + normalizer) all use **ordered × price** for commercial totals. Credit check on delivery still uses **delivery qty × price**.

## UI

Detail summary now shows **Order Total**, **Confirmed Value**, and **Invoice Due** (renamed from Amount Due so zero is not confused with a broken order total when nothing is invoiced yet).

## How to re-verify in UI

1. Hard-refresh the Sales Order detail for DSO-2026-0001 (API restart if server was already running before the fix).
2. Expect Order Total **UGX 16,000.00**, line totals **10,000** and **6,000**, Confirmed Value **0**, Invoice Due **0** until a delivery creates an invoice.
