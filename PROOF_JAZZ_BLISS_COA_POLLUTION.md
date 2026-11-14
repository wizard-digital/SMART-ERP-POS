# PROOF — Jazz Bar “Bliss Interiors Stanbic / Dollar Bliss” UGX 0.00

## Verdict

**Not a cross-tenant data leak into Jazz’s bank books.**  
Jazz inherited **Chart of Accounts labels** from a polluted `pos_template` clone.

## Evidence (prod `smarterp-prod` / `samplepos-postgres`, 2026-11-14T13:30Z)

### Schema parity (already same)

| DB | schema_version | public tables | numbered migrations |
|----|----------------|---------------|---------------------|
| `pos_tenant_the_jazz_bar` | **647** | **270** | **302** |
| `pos_template` | **647** | **270** | **302** |
| `pos_tenant_bliss_interior_ltd` | 647 | 270 (+ platform extras on some probes) | 302 |

Jazz vs template table diff: **empty** (identical schema).

### What Jazz showed (BEFORE)

GL accounts (not `bank_accounts` rows):

| Code | AccountName |
|------|-------------|
| 1031 | **BLISS INTERIORS STANBIC BANK** |
| 1032 | **Dollar Bliss Interiors** |

Jazz `bank_accounts`: only `Mobile Money` (UGX 0.00).  
Ledger posts on 1031/1032 for Jazz: **0**.

Same Bliss-named CoA rows existed on:

- `pos_template` (source of new tenants)
- `pos_tenant_dynamics` (also cloned while template was polluted)
- `pos_tenant_bliss_interior_ltd` (legitimate — **left untouched**)

Henber renamed its 1031/1032 to Centenary/DFCU; Blis to Equity — proving codes are tenant-local placeholders, not a shared bank.

### How it got onto Jazz / new tenants

1. Tenant DBs are created with `CREATE DATABASE … TEMPLATE pos_template`.
2. `pos_template` CoA contained Bliss-named 1031/1032 (copied historically when template was seeded/rebuilt from Bliss-era CoA).
3. Jazz (`the-jazz-bar` → `pos_tenant_the_jazz_bar`) cloned that template → UI Banking/liquidity list shows GL `AccountName` + UGX 0.00 balance.
4. **No** Jazz `bank_accounts` row named Stanbic/Dollar Bliss; balances 0 because nothing posted.

### Fix applied (prod)

Script: `ops/security/03-fix-bliss-coa-pollution-jazz-template.sh --apply`

| DB | 1031 after | 1032 after |
|----|------------|------------|
| `pos_tenant_the_jazz_bar` | Bank Account 2 | Bank Account 3 |
| `pos_template` | Bank Account 2 | Bank Account 3 |
| `pos_tenant_dynamics` | Bank Account 2 | Bank Account 3 |
| `pos_tenant_bliss_interior_ltd` | **BLISS INTERIORS STANBIC BANK** (unchanged) | **Dollar Bliss Interiors** (unchanged) |

Guard: rename refused if any `ledger_entries` existed under Bliss names (Jazz/template/dynamics = 0).

## Operator note

Rename Jazz’s Bank Account 2/3 in Chart of Accounts / Banking to real Jazz bank names when ready. New tenants cloned after this fix will not get Bliss labels.
