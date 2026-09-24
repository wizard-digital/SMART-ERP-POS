# PROOF: MoMo / Airtel — no duplicate GL, no book mismatch

**Verdict: PASS**  
**Schema:** `CURRENT_SCHEMA_VERSION = 626`

## Invariants locked

| Rule | How |
| --- | --- |
| One GL per sale / expense payment | Bank mirror **links** to existing `SALE` / `EXPENSE_PAYMENT` journal — never `createTransaction` |
| No category-as-contra | Expense never passes `categoryId` as `accounts."Id"` |
| Book ↔ pay-from match | Bank book `AccountCode` must equal MoMo `1040` (or selected pay-from) |
| GL ↔ method match | Sale mirror requires SALE journal **debits** liquidity; expense mirror requires payment journal **credits** pay-from |
| No duplicate bank rows | Unique indexes `uq_bank_txn_expense_source_live`, `uq_bank_txn_sale_source_desc_live` (migration 626) |
| Same on every tenant | 625 heal + 626 indexes + fail-closed postconditions |

## Proof

```bash
cd SamplePOS.Server
node --experimental-vm-modules ./node_modules/jest/bin/jest.js \
  src/services/expenseMarkPaidMomo.evidence.test.ts \
  src/services/momoAirtelPaymentSsot.evidence.test.ts \
  src/services/bankingSalePaymentRouting.proof.test.ts \
  src/modules/system/tenantMigrationDrift.test.ts --forceExit

npx tsx scripts/proof-momo-airtel-payment-ssot.ts
```

**Results:** Jest **20/20 PASS** (`PROOF_MOMO_AIRTEL_NO_DUP.jest.json`); script **9/9 checks PASS** (`PROOF_MOMO_AIRTEL_PAYMENT_SSOT.json`).

Also: expense reverse dedupes journals by id when bank points at the same `EXPENSE_PAYMENT` GL — no double reverse.
