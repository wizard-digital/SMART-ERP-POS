# PROOF — Tenant schema integrity and consistency

**Generated:** 2026-10-12T20:24:08.049Z
**Verdict:** **PASS**
**CURRENT_SCHEMA_VERSION:** 637

A tenant is current only when numbered files, integer version, required tables, critical columns, and postconditions all match. Copied `schema_migrations` rows without DDL do not count.

## Gates (executed)

| Gate | Result | Detail |
|------|--------|--------|
| Jest SSOT tests | PASS | 24 passed, 0 failed |
| Version 637 + 621 stamp | PASS | const 637 and 621 stamp file |
| Critical column coverage | PASS | customer_group_id, pos_session_policy, FEFO min_days/status/valuation, employee_id |
| Poisoned 502 ledger heal | PASS | drifted=true restored=true |
| Complete tenants identical SSOT | PASS | pos_system, acme-store, default, proof-alpha-p1c9x, proof-beta-p1c9x |
| Fail-closed not marked verified | PASS | none |

## Complete tenant fingerprints (must match)

| Tenant | version | numbered files | hash | pending | required missing | critical missing | post drift | 620 participants | policy col | policy chk | 618 CI |
|--------|---------|----------------|------|---------|------------------|------------------|------------|------------------|------------|------------|--------|
| pos_system | 637 | 290 | b58534ae | 0 | 0 | 0 | 0 | true | true | true | true |
| acme-store | 637 | 290 | b58534ae | 0 | 0 | 0 | 0 | true | true | true | true |
| default | 637 | 290 | b58534ae | 0 | 0 | 0 | 0 | true | true | true | true |
| proof-alpha-p1c9x | 637 | 290 | b58534ae | 0 | 0 | 0 | 0 | true | true | true | true |
| proof-beta-p1c9x | 637 | 290 | b58534ae | 0 | 0 | 0 | 0 | true | true | true | true |

No SSOT fingerprint mismatches among complete tenants.

## Fail closed

- none

Not deployed.
