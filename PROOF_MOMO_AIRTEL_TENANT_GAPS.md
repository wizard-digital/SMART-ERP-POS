# PROOF: Which tenants have MoMo / Airtel issues

**Generated:** 2026-09-24T23:10:50.967Z  
**Host:** `209.38.203.138` (live probe)  
**Script:** `SamplePOS.Server/scripts/proof-momo-airtel-tenant-gaps.mjs`  
**Artifact:** `PROOF_MOMO_AIRTEL_TENANT_GAPS.json`

## Verdict

| Layer | Who was affected |
| --- | --- |
| **Client Zod** missing `AIRTEL_MONEY` | **All tenants** on that build (platform) — Bliss/Dynamics noticed because they tried Airtel sales |
| **Expense Mark Paid** `categoryId` as contra | **All tenants** on that build when paying expense from MoMo (platform code) |
| **DB gaps (live now)** | **Every** prod tenant below — all still on schema **v624**; migrations **625–627** not applied yet |

## Live DB probe — affected tenants

All **5** tenant databases probed. **0 healthy** until 625–627 deploy.

| Tenant slug | DB | Schema | AIRTEL enum | 1040 + SALES/EXPENSE sources | MoMo bank book | No-dup indexes | Pending 625–627 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `acme_store` | `pos_tenant_acme_store` | 624 | yes | yes | **missing** | **missing** | 3 |
| `blis` | `pos_tenant_blis` | 624 | yes | yes | **missing** | **missing** | 3 |
| `bliss_interior_ltd` | `pos_tenant_bliss_interior_ltd` | 624 | yes | yes | **missing** | **missing** | 3 |
| `dynamics` | `pos_tenant_dynamics` | 624 | yes | yes | **missing** | **missing** | 3 |
| `henber_pharmacy` | `pos_tenant_henber_pharmacy` | 624 | yes | yes | **missing** | **missing** | 3 |

### Same issues on every tenant (including Bliss + Dynamics)

- `missing_bank_book:1040`
- `missing_index:uq_bank_txn_expense_source_live`
- `missing_index:uq_bank_txn_sale_source_desc_live`
- `pending_momo_migrations:3`

### Not a Bliss/Dynamics-only enum/column poison

Live check shows **AIRTEL enum present**, **payment_methods rows present**, **1040 present** with `SALES_INVOICE` + `EXPENSE_PAYMENT`, **no missing banking columns** on any of the five. The reported POS/expense failures match **shared app bugs** + **shared missing MoMo bank book / undeployed 625–627**.

## Reported operators vs evidence

- **Bliss** → maps to `bliss_interior_ltd` / `blis` — **confirmed in affected list**
- **Dynamics** → `dynamics` — **confirmed in affected list**
- Same DB gap profile as `acme_store` and `henber_pharmacy` (they just may not have hit MoMo as often)

## Re-run

```bash
cd SamplePOS.Server
node scripts/proof-momo-airtel-tenant-gaps.mjs
```
