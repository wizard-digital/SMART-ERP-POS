# PROOF — Product category name SSOT

**Verdict:** PASS
**Generated:** 2026-09-20T16:57:17.121Z
**Gates:** 6/6

- PASS `NORMALIZE_COLLAPSE_WS` — normalize trims and collapses whitespace
- PASS `EQUAL_CASE_INSENSITIVE` — equal ignores case and surrounding spaces
- PASS `SQL_CI_UNIQUE_INDEX` — Migration 618 merges dups + unique on LOWER(TRIM(name))
- PASS `ZOD_NORMALIZE_NAME` — Create/Update schemas normalize category names
- PASS `API_CI_LOOKUP` — API lookup + ConflictError on duplicate / unique violation
- PASS `UI_DUP_GUARD` — Categories page + combobox block duplicate names

## Integrity
Product categories cannot share the same name ignoring case/whitespace; DB unique index + API ConflictError + UI guards.
