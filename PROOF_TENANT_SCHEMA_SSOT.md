# PROOF — Tenant schema integrity and consistency

**Generated:** 2026-09-23T19:39:56.857Z
**Verdict:** **PASS**
**CURRENT_SCHEMA_VERSION:** 622

A tenant is current only when numbered files, integer version, required tables, critical columns, and postconditions all match. Copied `schema_migrations` rows without DDL do not count.

## Gates (executed)

| Gate | Result | Detail |
|------|--------|--------|
| Jest SSOT tests | PASS | 20 passed, 0 failed |
| Version 622 + 621 stamp | PASS | const 622 and 621 stamp file |
| Critical column coverage | PASS | customer_group_id, pos_session_policy, cash_register_session_id, employee_id |
| Poisoned 502 ledger heal | PASS | drifted=true restored=true |
| Complete tenants identical SSOT | PASS | pos_system, default, proof-alpha-p1c9x, proof-beta-p1c9x |
| Fail-closed not marked verified | PASS | acme-store |

## Complete tenant fingerprints (must match)

| Tenant | version | numbered files | hash | pending | required missing | critical missing | post drift | 620 participants | policy col | policy chk | 618 CI |
|--------|---------|----------------|------|---------|------------------|------------------|------------|------------------|------------|------------|--------|
| pos_system | 622 | 275 | 30787218 | 0 | 0 | 0 | 0 | true | true | true | true |
| default | 622 | 275 | 30787218 | 0 | 0 | 0 | 0 | true | true | true | true |
| proof-alpha-p1c9x | 622 | 275 | 30787218 | 0 | 0 | 0 | 0 | true | true | true | true |
| proof-beta-p1c9x | 622 | 275 | 30787218 | 0 | 0 | 0 | 0 | true | true | true | true |

No SSOT fingerprint mismatches among complete tenants.

## Fail closed

- **acme-store**: verified=false, current=false, relation "accounts" does not exist


Not deployed.
