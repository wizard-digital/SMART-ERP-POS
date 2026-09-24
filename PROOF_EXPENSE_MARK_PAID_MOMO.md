# PROOF: Expense Mark as Paid — Mobile Money

**Verdict: PASS**  
**Screenshot error:** `Not found: Contra account 8ef047a1-… not found` when Confirm Payment from **MOBILE MONEY**.

## Root cause

`markExpensePaid` called `BankingService.createFromExpense(..., existingExpense.categoryId)`.  
That UUID is an **expense category** id, not an `accounts."Id"`. Lookup failed → toast. Cash pays skipped this path (`paymentMethod === 'CASH'`), so it looked “tenant / method inconsistent.”

Also `createFromExpense` posted a **second** GL via `createTransaction`, which would double-credit MoMo if the contra had resolved.

## Fix

1. After `recordExpensePaymentToGL`, mirror Banking with `paymentAccountCode` + `existingGlTransactionId` (link only — no second journal).
2. Never pass `categoryId` as contra.
3. MoMo (`1040`) uses `ensureDepositLiquidityBook`.
4. Schema 625 also ensures `EXPENSE_PAYMENT` on liquidity accounts.

## Proof

```bash
cd SamplePOS.Server
node --experimental-vm-modules ./node_modules/jest/bin/jest.js src/services/expenseMarkPaidMomo.evidence.test.ts --forceExit
```

**Result:** 4/4 PASS (see `PROOF_EXPENSE_MARK_PAID_MOMO.jest.json`)

Executed path: `createFromExpense` with `paymentAccountCode: '1040'` + `existingGlTransactionId` inserts `bank_transactions` and does **not** call `createTransaction`.
