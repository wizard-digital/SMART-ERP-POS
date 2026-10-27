# Sale discount + exchange SSOT

Run: 2026-10-27T22:02:12.556Z

Verdict: **PASS** — executed persist/exchange/presentation numbers, not source greps.

| Check | Result |
|---|---|
| fail-312000-minus-6000-is-not-300000 | PASS |
| exchange-persist-306k-unit-6k-cart-300k-charge | PASS |
| fail-exchange-must-not-consume-cart-plus-line | PASS |
| fail-copied-cart-onto-line-dump | PASS |
| historic-display-never-invents-312000 | PASS |
| pos-payload-cart-stays-on-header | PASS |
| vat-modes-close | PASS |
| pos-schema-persist-2210-close | PASS |

312000 − 6000 = 306000, not 300000. Exchange credit 6,000 on a 306,000 replacement charges 300,000 and keeps unit 306,000.
