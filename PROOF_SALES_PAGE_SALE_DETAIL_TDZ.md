# PROOF: SalesPage SaleDetailModal TDZ

**Result:** PASS
**As of:** 2026-09-07T16:46:11.999Z

## Prior prod error

ReferenceError: Cannot access 'h' before initialization (SaleDetailModal / SalesPage-*.js)

## Why it broke

- **Commit:** `a9c3c61bf732159edb1a88d22b77c78ff7b6a83a` — *fix(sales): lock refund GL dual-ref SSOT and ADMIN-only aged returns*
- **Mistake:** `saleDateForAge` read `saleDetails` **above** `useState` → TDZ (`Cannot access 'h' before initialization` after minify).
- **Trigger:** Sales → open sale detail (View).
- **Not** caused by the later Sales Expense / adaptive chrome change.

## Gates
- PASS `SALE_DETAILS_BEFORE_AGE` — useState@629 saleDateForAge@1409
- PASS `NO_SALE_DETAILS_BEFORE_HOOK` — saleDetails absent before useState
- PASS `CURRENT_PAGE_BEFORE_EFFECT` — useState@1396 setCurrentPage@1662

## Deploy note

Local source is fixed; Henber still serves the broken SalesPage chunk until this fix is deployed.
