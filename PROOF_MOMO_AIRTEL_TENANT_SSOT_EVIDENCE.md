# PROOF: MoMo / Airtel / tenant SSOT — evidence pack

**Verdict: PASS**  
**Generated:** 2026-09-24T22:57:32.657Z (script) / re-run pack below  
**Schema:** `CURRENT_SCHEMA_VERSION = 627`

## Executed evidence (not grep-only)

| Gate | Result | Artifact |
| --- | --- | --- |
| Server Jest (5 suites) | **27/27 PASS** | `PROOF_TENANT_MOMO_COLUMN_SSOT.jest.json` |
| Client Vitest | **7/7 PASS** | `PROOF_POS_MOMO_AIRTEL_SALE_ZOD.json` |
| Executed script `safeParse` + schema files | **10/10 checks PASS** | `PROOF_MOMO_AIRTEL_PAYMENT_SSOT.json` |
| Rollup | **PASS** | `PROOF_MOMO_AIRTEL_TENANT_SSOT_EVIDENCE.json` |

## What was actually exercised

1. **`POSSaleSchema.safeParse`** — accepts `MOBILE_MONEY` + `AIRTEL_MONEY`; rejects unknown method  
2. **`BankingService.createFromSale`** — MoMo/Airtel mirror inserts bank row linked to SALE GL; **never** `createTransaction`  
3. **`BankingService.createFromExpense`** — MoMo pay inserts WITHDRAWAL linked to EXPENSE_PAYMENT GL; **never** categoryId as contra  
4. **`migrationHasColumnDrift('627_…')`** — **true** when `gl_transaction_id` missing; **false** when complete  
5. Schema **625/626/627** files + postcondition list + required tables (`bank_*`, `payment_methods`)

## Commands re-run for this pack

```bash
cd SamplePOS.Server
node --experimental-vm-modules ./node_modules/jest/bin/jest.js \
  src/modules/system/tenantMigrationDrift.test.ts \
  src/services/momoAirtelPaymentSsot.evidence.test.ts \
  src/services/expenseMarkPaidMomo.evidence.test.ts \
  src/services/bankingSalePaymentRouting.proof.test.ts \
  src/services/bankingOwnerCapital.evidence.test.ts \
  --forceExit --json --outputFile=../PROOF_TENANT_MOMO_COLUMN_SSOT.jest.json

npx tsx scripts/proof-momo-airtel-payment-ssot.ts

cd ../samplepos.client
npx vitest run src/__tests__/pos-momo-airtel-sale-zod.proof.test.ts \
  src/__tests__/airtel-money-payment-methods.evidence.test.ts \
  --reporter=json --outputFile=../PROOF_POS_MOMO_AIRTEL_SALE_ZOD.json
```

## Invariants proven

- No tenant mix (same schema 627 + column anchors + postconditions)  
- No missing-column hide (`gl_transaction_id` drift flags 627)  
- No duplicate GL (sale/expense bank mirrors link only)  
- Airtel + MTN same path on client Zod and bank routing  

**Deploy:** local evidence only until commit/push requested.
