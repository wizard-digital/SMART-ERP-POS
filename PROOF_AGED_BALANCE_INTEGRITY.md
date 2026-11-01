# PROOF — Aged Balances integrity

**Generated:** 2026-11-01T08:04:46.205Z  
**Verdict:** **PASS** (17/17 gates)

## Bugs fixed

1. UI table used `details` instead of `entities`  
2. UI `summary.total` vs API `grandTotal`  
3. AR double-count / AP cartesian  
4. **PG 22P02** `payment_method: ""` — never `COALESCE(enum, '')`; compare via `::text`  
5. Sale/status filters cast via `::text` so invented values never enter enum IN lists  

## Gates

| Gate | Result | Detail |
|------|--------|--------|
| `HAS_TOTAL_ALIAS` | PASS | summary.total set |
| `HAS_GRAND_TOTAL` | PASS | grandTotal retained |
| `HAS_ENTITIES` | PASS | entities array |
| `AR_OPEN_ITEM_SSOT` | PASS | AR aging = invoice amount_due open-item SSOT |
| `AP_UNION_BILLS` | PASS | bills query |
| `AP_UNION_PO` | PASS | PO residual query |
| `AP_NO_CARTESIAN` | PASS | no SI×PO cartesian FROM suppliers |
| `NO_COALESCE_PM_EMPTY` | PASS | no COALESCE(payment_method, '') |
| `INVOICE_STATUS_AS_TEXT` | PASS | invoice status via ::text |
| `UNALLOC_NETTING` | PASS | unallocated receipts net the same way as reports aging |
| `UI_NORMALIZE` | PASS | normalizeAgedReport |
| `UI_ENTITIES` | PASS | uses entities |
| `UI_TOTAL` | PASS | total or grandTotal |
| `UI_NOT_DETAILS_AS_TABLE` | PASS | does not map details as entity rows |
| `NORM_TOTAL` | PASS | total=150 |
| `NORM_ENTITIES_LEN` | PASS | n=1 |
| `NORM_NAME` | PASS | Alice |

## Re-run

```bash
cd SamplePOS.Server
npm test -- --runInBand src/services/agedBalanceIntegrity.evidence.test.ts
```
