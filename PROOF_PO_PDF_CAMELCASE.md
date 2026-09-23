# PROOF — Purchase Order PDF camelCase mapping

**Generated:** 2026-09-23T06:13:43.875Z  
**Verdict:** **PASS** (19/19 gates)

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
| `PICK_HELPER` | PASS | pickField helper |
| `CAMEL_PO_NUMBER` | PASS | reads poNumber |
| `CAMEL_ORDER_DATE` | PASS | reads orderDate |
| `CAMEL_EXPECTED` | PASS | reads expectedDate |
| `CAMEL_TOTAL` | PASS | reads totalAmount |
| `CAMEL_SUPPLIER_ID` | PASS | reads supplierId |
| `CAMEL_PRODUCT` | PASS | reads productName |
| `CAMEL_UNIT_COST` | PASS | reads unitCost |
| `CAMEL_LINE_TOTAL` | PASS | reads lineTotal |
| `SNAKE_FALLBACK` | PASS | snake_case still accepted |
| `MAP_SUPPLIER_NAME` | PASS | map includes supplierName |
| `MAP_UNIT_COST` | PASS | map unitCost |
| `MAP_PRODUCT` | PASS | map productName |
| `SERVICE_RETURNS_MAPPED` | PASS | getPOById returns mapped rows |
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
