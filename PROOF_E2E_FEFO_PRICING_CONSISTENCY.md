# PROOF: E2E FEFO / pricing consistency

- Verdict: **PASS**
- Evidence class: `api+db-live` on `http://localhost:3001`
- At: 2026-10-12 (this run)

## Executed live

| Pack | Result | Proven |
|------|--------|--------|
| `proof:fefo-allocated-cost:e2e` | **6/6** | DB FEFO cost = API floor; sale at floor 201; below → `BELOW_ALLOCATED_COST` |
| `proof:sale-below-cost:local` | **18/18** | Exact/above OK; below + walk-in blocked; audit events written |
| `proof:pos-at-cost-reprice:local` | **18/18** | Live AT_COST + `baseQuantity` (CTN×24) |
| `proof:pos-pricing:local` | **PASS** | Full gate including units + live packs above |

## Consistency rule proven on live path

Physical issue floor is FEFO (expiry → received → lotNumber).  
`POST /api/sales` rejects below that floor with `BELOW_ALLOCATED_COST`, and the API `minimumUnitPrice` matched the DB FEFO walk (`1000` = `1000`).

## Not E2E in this pack

- WIP pack (`proof-wip-production-relevant.mjs`) — unit/structural only
- Live multi-batch layer blend — skipped when one FEFO batch alone covers qty (unit/Ozempic covers blend)
