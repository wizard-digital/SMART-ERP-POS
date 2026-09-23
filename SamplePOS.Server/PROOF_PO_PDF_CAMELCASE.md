# PROOF — Purchase Order PDF camelCase mapping

**Generated:** 2026-08-10T06:41:54.695Z  
**Verdict:** **PASS** (5/5 gates)

## Root cause

Local PO preview showed company header (e.g. BLIZ INTERNATIONAL LTD) with:

- SUPPLIER **—**
- PURCHASE ORDER **—**
- product names **—**
- totals **UGX 0.00**

Quantities still appeared (shared key `quantity`). Status worked (`status` same in both shapes).

**Fix:** `documentRenderer.renderPurchaseOrder` uses camelCase + snake_case `pickField`; repository map keeps `supplierName`.

## Gates

| Gate | Result | Detail |
|------|--------|--------|
| `SIM_PO_NUMBER` | PASS | PO-2026-0090 |
| `SIM_TOTAL` | PASS | 1500000 |
| `SIM_PRODUCT` | PASS | Paracetamol 500mg |
| `SIM_UNIT` | PASS | 1000 |
| `OLD_SNAKE_FAILS` | PASS | snake-only would be 0 on camel object |

## Re-run

```bash
cd SamplePOS.Server
npm test -- --runInBand src/modules/documents/purchaseOrderPdf.evidence.test.ts
```
