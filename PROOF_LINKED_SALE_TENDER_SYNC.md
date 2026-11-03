# PROOF: Linked sale tender sync (chk_sales_credit_has_debt)

**PASS** — exercised on real Postgres scratch

- Gates: 9
- Failed: 0

| Gate | OK | Detail |
|------|----|--------|
| CONSTRAINT_PRESENT | yes | chk_sales_credit_has_debt on scratch |
| TRIGGER_646_GONE | yes | trg_sync_invoice_payment dropped by 646 |
| PLANTED_TRIGGER_FULL_DEPOSIT_FAILS | yes | new row for relation "sales" violates check constraint "chk_sales_credit_has_debt" |
| REHEAL_646 | yes | 646 drops planted trigger |
| RECALC_OK | yes | balance=0.000000 paid=50000.000000 |
| FULL_DEPOSIT_LEAVES_CREDIT | yes | {"method":"DEPOSIT","paid":50000,"total":50000} |
| AMOUNT_PAID_ONLY_UNDER_CREDIT_FAILS | yes | new row for relation "sales" violates check constraint "chk_sales_credit_has_debt" |
| WRITEOFF_KEEPS_CREDIT_ZERO_TENDER | yes | {"method":"CREDIT","paid":0,"total":50000} |
| PARTIAL_STAYS_CREDIT | yes | {"method":"CREDIT","paid":10000,"total":50000} |

## Rule

- sales.amount_paid = liquidity tender only
- CREDIT + full tender → leave CREDIT to clearing method in one UPDATE
- Write-off / CN must not set sales.amount_paid = total under CREDIT
