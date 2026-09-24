# PROOF: MoMo / Airtel Money — platform SSOT

**Verdict: PASS**  
**Generated:** 2026-09-24T21:47:18.735Z

## What was executed (not grep-only)

| Gate | Command | Result |
| --- | --- | --- |
| Client Zod `safeParse` | `vitest run pos-momo-airtel-sale-zod.proof.test.ts` + airtel evidence | **7/7 PASS** → `PROOF_POS_MOMO_AIRTEL_SALE_ZOD.json` |
| Executed script | `npx tsx scripts/proof-momo-airtel-payment-ssot.ts` | **8/8 checks PASS** → `PROOF_MOMO_AIRTEL_PAYMENT_SSOT.json` |
| Server Jest SSOT | `momoAirtelPaymentSsot` + `tenantMigrationDrift` + `bankingSalePaymentRouting` | **15/15 PASS** → `PROOF_MOMO_AIRTEL_PAYMENT_SSOT.jest.json` |
| GL posting | `glEntryService.accuracy` — Airtel → 1040 | **1/1 PASS** |

## Executed `POSSaleSchema.safeParse`

- `MOBILE_MONEY` (MTN MoMo) → **accepted**
- `AIRTEL_MONEY` (Airtel Money) → **accepted** (this was the browser `VALIDATION STOPPED SALE` / `Invalid input`)
- Unknown method → **rejected** (fail closed)

## Platform lock (no Bliss/Dynamics special path)

- `CURRENT_SCHEMA_VERSION = 625`
- Heal: `shared/sql/625_momo_airtel_payment_ssot.sql` (enum + payment_methods + 1040 + SALES_INVOICE + bank book)
- Fail-closed postconditions: `554`, `571`, `625`
- Sale routing: `ensureDepositLiquidityBook` for both MTN and Airtel → GL **1040**

## Artifacts

- `PROOF_MOMO_AIRTEL_PAYMENT_SSOT.json`
- `PROOF_MOMO_AIRTEL_PAYMENT_SSOT.jest.json`
- `PROOF_POS_MOMO_AIRTEL_SALE_ZOD.json`
- `PROOF_POS_MOMO_AIRTEL_SALE_ZOD.md` (this file supersedes the earlier draft)

## Deploy

Local proofs only. Not committed/pushed unless requested.
