# Sale discount + exchange SSOT (end-to-end)

Run: 2026-10-27T22:02:14.140Z

Verdict: **PASS**

POS checkout → POSSaleSchema → completeProductExchange → createSale persist → 2210 apply → sale modal → receipt → thermal HTML

| Hop | Result |
|---|---|
| 1-pos-checkout-payload | PASS |
| 2-pos-schema | PASS |
| 3-complete-product-exchange | PASS |
| 4-create-sale-persist-closed | PASS |
| 5-apply-2210-cart-only | PASS |
| 6-sales-modal | PASS |
| 7-receipt-from-sale | PASS |
| 8-thermal-html | PASS |
| 9-fail-closed | PASS |

312000 − 6000 = 306000, not 300000. Exchange charges 300000 at unit 306000. Thermal HTML contains Exchange credit and does not contain 312000.
