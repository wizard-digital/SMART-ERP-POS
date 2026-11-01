# PROOF — Aged Balances integrity

**Generated:** 2026-08-10T07:09:51.370Z  
**Verdict:** **PASS** (3/3 gates)

## Bugs fixed

1. UI table used `details` (invoice lines) instead of `entities` → all dashes + duplicate names  
2. UI read `summary.total` but API only sent `grandTotal` → Total "—"  
3. AR double-count credit sale + linked invoice  
4. AP cartesian JOIN SI × PO inflated balances  

## Gates

| Gate | Result | Detail |
|------|--------|--------|
| `NORM_TOTAL` | PASS | total=150 |
| `NORM_ENTITIES_LEN` | PASS | n=1 |
| `NORM_NAME` | PASS | Alice |

## Re-run

```bash
cd SamplePOS.Server
npm test -- --runInBand src/services/agedBalanceIntegrity.evidence.test.ts
```
