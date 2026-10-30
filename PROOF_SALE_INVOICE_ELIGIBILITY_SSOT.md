# Sale invoice eligibility SSOT

Run: 2026-10-30T12:15:49.555Z

Verdict: **PASS** — executed eligibility numbers, not tenant-specific branches.

| Check | Result |
|---|---|
| credit-sale-eligible | PASS |
| quote-eligible | PASS |
| cash-underpay-eligible | PASS |
| fully-paid-cash-blocked | PASS |
| voided-by-return-blocked | PASS |
| header-paid-fallback | PASS |
| picker-rows-same-eligibility | PASS |

CREDIT, quote, and outstanding CASH are eligible on every tenant. Fully paid CASH and voided sales are not.
