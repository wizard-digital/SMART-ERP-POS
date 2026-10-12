# PROOF_FEFO_COLUMN_SSOT_PREDEPLOY

**Verdict: PASS** (local tested proofs)  
**Deploy: not run** — ask explicitly to deploy after this gate.

Schema version: **637** (`637_fefo_allocated_cost_column_ssot.sql`)

## Executed proofs

| Gate | Result | Evidence |
|------|--------|----------|
| Unit FEFO/schema | **PASS** 46/46 | drift, integrity, tenantCache, allocated-cost, atCost, quote convert |
| At-cost regression | **PASS** 59/59 | `npm run test:at-cost-regression` |
| All-tenant FEFO SSOT | **PASS** 7/7 | `PROOF_FEFO_SSOT_ALL_TENANTS` |
| Tenant schema SSOT | **PASS** v637 | `PROOF_TENANT_SCHEMA_SSOT` — all ACTIVE complete, no mismatches |
| E2E FEFO floor | **PASS** 6/6 | `PROOF_FEFO_ALLOCATED_COST_E2E` — sale at floor 201, below 400 |
| E2E below-cost | **PASS** 18/18 | `npm run proof:sale-below-cost:local` |
| Docker all-tenant migrate | **SKIP** | local host has no docker CLI — run on deploy host |

## Live E2E (not source grep)

- `POST /api/sales` at FEFO cost → **201**
- `POST /api/sales` below FEFO → **400 BELOW_ALLOCATED_COST**
- API `minimumUnitPrice` matches DB FEFO walk (±0.02)

## Pre-deploy host checklist

```bash
npm run migrate
npm run migrate:tenants
npm run proof:fefo-ssot-all-tenants
npm run proof:fefo-allocated-cost:e2e
npm run proof:sale-below-cost:local
# on deploy host with docker:
npm run proof:all-tenants
```
