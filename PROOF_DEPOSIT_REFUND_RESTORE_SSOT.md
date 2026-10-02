# PROOF — Deposit refund restore SSOT

**Generated:** 2026-10-02T18:31:46.019Z  
**Verdict:** **PASS** (46/46 gates)

## Why this proof exists

Returning a sale that had consumed a customer deposit used to:

1. Leave `pos_deposit_applications` and `amount_used` in place  
2. Pay cash from the till for the whole refund (CASH header), **or** credit Customer Deposits (2200) again (DEPOSIT header)  
3. Leave deposit availability and liability 2200 inconsistent going forward  

That must **never** happen on new refunds/voids.

## Permanent SSOT

| Step | Rule |
|------|------|
| Refund / DEPOSIT void | Call `restoreSaleDepositApplicationsInTransaction` **inside** the same UnitOfWork **before** sale refund/void GL |
| Restore | Reverse `DEPOSIT_APPLICATION` JE (or post partial DR AR / CR 2200) **and** put the same amount back on the deposit |
| No JE | Leave application used — do not invent 2200 (protects historical cash refunds) |
| Refund JE | Credit **AR** for `depositRestoredAmount`; credit original tender only for the remainder; **never** credit 2200 again |

## Guarantees locked by gates

1. `refundSale` restores before `recordSaleRefundToGL` and passes `depositRestoredAmount`  
2. `voidSale` restores for DEPOSIT tender before `recordSaleVoidToGL`  
3. Full deposit refund → CR AR only (no cash, no second 2200)  
4. Mixed restore → CR AR + CR cash remainder  
5. Orphan application (no journal) → zero restore, row kept  
6. Removed historical DEPOSIT tender → CR 2200 path  

## Gates

| Gate | Result | Detail |
|------|--------|--------|
| `REFUND_CALLS_RESTORE` | PASS | refundSale calls restoreSaleDepositApplicationsInTransaction |
| `REFUND_RESTORE_BEFORE_GL` | PASS | restore runs before recordSaleRefundToGL |
| `REFUND_PASSES_RESTORED` | PASS | refund GL receives depositRestore.restored |
| `REFUND_RESTORE_NOT_OWN_UOW` | PASS | refund must not call reverseDepositsForSale (own UnitOfWork) |
| `VOID_DEPOSIT_GUARD` | PASS | void restore only for DEPOSIT tender |
| `VOID_CALLS_RESTORE` | PASS | voidSale calls restore for DEPOSIT sales |
| `VOID_RESTORE_BEFORE_GL` | PASS | restore runs before recordSaleVoidToGL |
| `RESTORE_FN_EXISTS` | PASS | restoreSaleDepositApplicationsInTransaction exported |
| `RESTORE_USES_REVERSE_TX` | PASS | full restore reverses DEPOSIT_APPLICATION JE |
| `RESTORE_PARTIAL_JE` | PASS | partial restore posts balanced reverse slice |
| `RESTORE_SKIP_NO_JOURNAL` | PASS | no journal → leave deposit used |
| `RESTORE_NEWEST_FIRST` | PASS | newest applications restored first |
| `REVERSE_FOR_SALE_USES_RESTORE` | PASS | reverseDepositsForSale delegates to in-tx restore (GL+balance) |
| `PLAN_FN_EXPORTED` | PASS | planDepositRefundCredits exported |
| `SALE_REFUND_DATA_RESTORED` | PASS | SaleRefundData carries depositRestoredAmount |
| `DEPOSIT_TENDER_CREDITS_AR_NOT_2200` | PASS | DEPOSIT refund tender credits AR via customerArLine; no case DEPOSIT → 2200 |
| `SPLIT_FULL_DEPOSIT` | PASS | full deposit restore → tender 0 |
| `SPLIT_PARTIAL` | PASS | partial restore → AR 40 + tender 60 |
| `SPLIT_NONE` | PASS | no restore → all tender |
| `SPLIT_CAP` | PASS | restore capped to refund total |
| `JE_FULL_AR` | PASS | CR AR = restored |
| `JE_FULL_NO_CASH` | PASS | no cash credit |
| `JE_FULL_NO_2200` | PASS | no second 2200 credit |
| `JE_FULL_BALANCED` | PASS | DR=CR |
| `JE_MIX_AR` | PASS | CR AR = restored slice |
| `JE_MIX_CASH` | PASS | CR cash = remainder |
| `JE_MIX_NO_2200` | PASS | refund JE does not credit 2200 |
| `JE_MIX_BALANCED` | PASS | DR=CR |
| `JE_ZERO_RESTORE_AR` | PASS | CR AR |
| `JE_ZERO_RESTORE_NO_2200` | PASS | never CR 2200 on refund JE |
| `RESTORE_RESULT_FULL` | PASS | {"restored":275000,"applications":1} |
| `RESTORE_CALLS_REVERSE` | PASS | AccountingCore.reverseTransaction once |
| `RESTORE_IDEM_KEY` | PASS | idempotency DEPOSIT_APP_RESTORE-{appId} |
| `RESTORE_DELETES_APP` | PASS | application row removed |
| `ORPHAN_NO_RESTORE` | PASS | {"restored":0,"applications":0} |
| `ORPHAN_NO_REVERSE` | PASS | no reverseTransaction |
| `ORPHAN_NO_DELETE` | PASS | orphan application left in place |
| `PARTIAL_RESULT` | PASS | {"restored":100,"applications":1} |
| `PARTIAL_NO_FULL_REVERSE` | PASS | partial does not reverse whole JE |
| `PARTIAL_SOURCE` | PASS | source=SYSTEM_CORRECTION |
| `PARTIAL_CR_2200` | PASS | CR 2200 = slice |
| `PARTIAL_DR_AR` | PASS | DR AR = slice |
| `PARTIAL_BALANCED` | PASS | DR=CR |
| `PARTIAL_REDUCES_APP` | PASS | amount_applied reduced |
| `BUG_NO_DEPOSIT_CASE_2200` | PASS | removed: DEPOSIT refund tender → CR 2200 |
| `BUG_REFUND_MUST_RESTORE` | PASS | refund without restore is forbidden |

## Re-run

```bash
cd SamplePOS.Server
npm test -- --runInBand src/services/depositRefundRestoreSsot.evidence.test.ts
```

Do **not** data-heal Blis SALE-2026-1812 / SALE-2026-2053 (cash already paid).
