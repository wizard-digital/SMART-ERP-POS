# Sales Targets — GENERAL + TEAM scopes

## Contract
- **INDIVIDUAL** — one salesperson (v1)
- **GENERAL** — all cashiers’ posted net sales in the period
- **TEAM** — named team members only (`sales_target_teams` + members)

Same revenue basis as v1 (subtotal − discount − returns, excl VAT, Kampala `toUtcRange`).

Overlap: one live target per scope key (person / team / GENERAL) per overlapping period. Individual + General + Team may coexist.

Progress strip priority: Individual → Team → General.

## Enable
1. Migrate `632` (flag) + `633` (scopes/teams)
2. Settings → System → Enable Sales Targets
3. Create teams (optional) → create GENERAL / TEAM / INDIVIDUAL targets → approve

## Tests
Server `src/modules/sales-targets` + client sales-targets evidence suites.
