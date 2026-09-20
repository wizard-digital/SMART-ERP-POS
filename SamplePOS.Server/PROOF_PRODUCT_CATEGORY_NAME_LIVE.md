# PROOF — Product category name LIVE

**Verdict:** PASS
**Generated:** 2026-09-20T16:57:13.766Z
**Gates:** 10/10
**Stamp:** 20260920165713

- PASS `LIVE_DB_CONNECTED` — connected to database pos_system
- PASS `PRODUCT_CATEGORIES_TABLE` — product_categories table exists
- PASS `CI_UNIQUE_INDEX_LIVE` — uq_product_categories_name_ci present (migrationApplied=true)
  - evidence: `{"appliedSql":true,"indexExists":true}`
- PASS `ZERO_CI_DUPLICATE_GROUPS` — case-insensitive duplicate groups = 0
  - evidence: `{"dupGroups":0}`
- PASS `CREATE_CANONICAL_OK` — created id=63b732c5-6796-4e8e-b3cd-7cb009fa9903 name="ProofCat 20260920165713"
  - evidence: `{"id":"63b732c5-6796-4e8e-b3cd-7cb009fa9903","name":"ProofCat 20260920165713"}`
- PASS `REJECT_CASE_VARIANT` — rejected "PROOFCAT 20260920165713": Product category "ProofCat 20260920165713" already exists. Names must be unique (case-insensitive).
  - evidence: `{"attempted":"PROOFCAT 20260920165713","ok":true,"message":"Product category \"ProofCat 20260920165713\" already exists. Names must be unique (case-insensitive).","status":409}`
- PASS `REJECT_WHITESPACE_VARIANT` — rejected whitespace variant: Product category "ProofCat 20260920165713" already exists. Names must be unique (case-insensitive).
  - evidence: `{"attempted":"  ProofCat 20260920165713  ","ok":true,"message":"Product category \"ProofCat 20260920165713\" already exists. Names must be unique (case-insensitive).","status":409}`
- PASS `DB_23505_ON_RAW_INSERT` — raw INSERT duplicate → pg code 23505
  - evidence: `{"pgCode":"23505","attempted":"proofcat 20260920165713"}`
- PASS `CI_LOOKUP_SINGLE_ROW` — LOWER(TRIM) lookup returns single canonical row id=63b732c5-6796-4e8e-b3cd-7cb009fa9903
  - evidence: `{"rows":[{"id":"63b732c5-6796-4e8e-b3cd-7cb009fa9903","name":"ProofCat 20260920165713"}]}`
- PASS `STILL_ZERO_CI_DUPLICATES` — duplicate groups after attempts = 0
  - evidence: `{"dupAfter":0}`

## Integrity
Measured live: unique index present, create succeeds once, case/whitespace duplicates ConflictError, raw INSERT 23505, zero CI duplicate groups.

## How to re-run
```
cd SamplePOS.Server && npx tsx scripts/proof-product-category-name-live.ts
```
