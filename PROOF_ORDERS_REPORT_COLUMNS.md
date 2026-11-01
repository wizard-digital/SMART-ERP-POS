# PROOF — Orders report column chooser (never-fail / consistency)

**Verdict:** PASS
**Proven at:** 2026-11-01T10:11:51.897Z

**Contract:** never-empty columns; screen/CSV/PDF same ids via shared/reports/ordersReportColumnsSsot

- PASS `NEVER_EMPTY_ALL`: empty → defaults (all)
- PASS `DEFAULTS_ALL`: empty equals defaultsForMode(all)
- PASS `JUNK_HEAL_ALL`: unknown ids dropped (all)
- PASS `PDF_NEVER_EMPTY_ALL`: PDF param never empty (all)
- PASS `PDF_MATCH_VISIBLE_ALL`: PDF null ≡ visible null (all)
- PASS `SCREEN_PDF_SAME_ALL`: screen ids === PDF ids (all)
- PASS `SANITIZE_ALL`: sanitize(['x']) → defaults (all)
- PASS `NEVER_EMPTY_CANCELLED`: empty → defaults (cancelled)
- PASS `DEFAULTS_CANCELLED`: empty equals defaultsForMode(cancelled)
- PASS `JUNK_HEAL_CANCELLED`: unknown ids dropped (cancelled)
- PASS `PDF_NEVER_EMPTY_CANCELLED`: PDF param never empty (cancelled)
- PASS `PDF_MATCH_VISIBLE_CANCELLED`: PDF null ≡ visible null (cancelled)
- PASS `SCREEN_PDF_SAME_CANCELLED`: screen ids === PDF ids (cancelled)
- PASS `SANITIZE_CANCELLED`: sanitize(['x']) → defaults (cancelled)
- PASS `HAS_SSOT_IMPORT`: page imports column SSOT
- PASS `HAS_CHOOSER`: column chooser UI
- PASS `PERSIST_V2`: layout v2 persisted
- PASS `MIGRATE_V1`: migrates v1 layout
- PASS `HEAL`: heals columns
- PASS `ABORT`: fetch abort on race
- PASS `DATE_SWAP`: swaps inverted date range
- PASS `CSV_VISIBLE`: CSV uses visible columns
- PASS `PDF_COLUMNS_PARAM`: PDF passes columns query
- PASS `MODES`: all + cancelled modes
- PASS `MIN_COLS`: cannot toggle below 2 columns
- PASS `NO_BRAND`: no competitor brand copy
- PASS `APP_ROUTE`: App route wired
- PASS `NAV_ORDERS`: Orders Report opens designer
- PASS `NAV_CANCELLED`: Cancelled opens designer cancelled mode
- PASS `ORDERS_GENERATE_RETURNS`: Generate returns after navigating Orders Report (no unreachable compare)
- PASS `NO_DEAD_ORDERS_GENERATE_BRANCH`: Generate does not set params for ORDERS_REPORT after navigate
- PASS `SCHEMA_COLUMNS`: query schema accepts columns
- PASS `SERVER_SSOT_IMPORT`: controller imports resolvePdfColumnIds
- PASS `BUILD_HELPER`: PDF builder fail-closed helper
- PASS `ORDERS_PDF_SSOT`: orders PDF via SSOT
- PASS `CANCEL_PDF_SSOT`: cancelled PDF via SSOT
- PASS `SSOT_NEVER_EMPTY_DOC`: SSOT documents never-empty contract

```bash
cd samplepos.client && npx vitest run src/__tests__/orders-report-columns.evidence.test.ts
```
