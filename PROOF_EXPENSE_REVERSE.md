# PROOF — Expense reverse (mistake correction)

**Verdict:** **PASS** (executed tests; original GL not deleted; post-reverse net-active = 0)

Posted expenses (APPROVED or PAID) reverse through `AccountingCore.reverseTransaction`: opposite debit/credit, original journals kept, double reverse blocked. Reverse fails closed if any posted journal remains or net-active GL for the document is not zero.

## Gates

| Gate | Result |
|------|--------|
| Jest reverse behavior | 8/8 PASS (`expenseReverse.behavior.test.ts`) |
| Jest reverse consistency SSOT | 3/3 PASS (`expenseReverse.consistency.evidence.test.ts`) |
| Vitest ExpensesPage Reverse control | PASS (`expenses-petty-ux-proof.test.ts`) |
| Vitest expense reports live spend | PASS (`expense-reports-sap-proof.test.ts`) |
| Schema 622 on pos_system | version 622, `reversed_by/at/reason`, status CHECK includes `REVERSED` |

## Behavior (executed)

- DRAFT → `ERR_EXPENSE_013`, no GL reverse
- Already `REVERSED` → `ERR_EXPENSE_012`
- Empty reason → validation error
- PAID with EXPENSE_PAYMENT + EXPENSE journals → reverse both, then status `REVERSED`
- PAID with linked BANK_TXN → reverse expense, payment, **and** bank GL
- APPROVED with no posted GL → `ERR_EXPENSE_014`, expense not marked reversed
- Leftover posted journal after reverse → `ERR_EXPENSE_016`, voucher not marked reversed
- Net-active residual on any account → `ERR_EXPENSE_016`, voucher not marked reversed

## After reverse (no mismatch)

| Surface | Result |
|---------|--------|
| Voucher | `status=REVERSED`, `payment_status=UNPAID`, `payment_account_id` cleared |
| GL | Original journals immutable + opposite `REVERSAL` pair; leftover POSTED originals blocked |
| P&L / expense reports | `LEDGER_NET_ACTIVE_SQL` (both reverse-pair legs excluded) |
| Spend totals | `REVERSED` excluded from live `total_amount` / voucher counts; recognized stays APPROVED+PAID |
| Cash / bank | Linked `bank_transactions` flagged reversed; bank GL reversed with the same pair rule |
| Payment picker / liquidity | Already net-active (`postedLedgerBalance`) |

UI: Expenses detail → **Reverse** (approved or paid) → reason required → `POST /api/expenses/:id/reverse`

Not deployed.
