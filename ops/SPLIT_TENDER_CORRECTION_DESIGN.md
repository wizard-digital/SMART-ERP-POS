# Split-tender accounting — fix, correcting journals, bank mirror (design + rehearsal results)

Status: **implemented and rehearsed locally; nothing applied to production; nothing committed or deployed.**
Production historical corrections are NOT scheduled: they need the owner's treatment decision (section 5) and an independent verification of the plan output.

## 1. Defect

`recordSaleToGL` debited **one** liquidity account for the whole sale — the header method's — so a sale tendered 60 % cash / 40 % mobile money
put 100 % in cash (1010). A single-method sale paid by MoMo/Airtel was also posted to cash when the header method was missed (Henber, April 2026).
The bank-register mirror had the same per-method gap (same-method lines collapsed into one row; one row per (sale, method) is the rule).
Total debits = total credits always held; only the **split between asset accounts 1010 / 1020 / 1030 / 1040** is wrong. Revenue, tax, COGS, AR, P&L: unaffected.

## 2. Future posting fix (local, uncommitted)

| File | Change |
|---|---|
| `src/services/saleTenderAllocation.ts` (new) | Pure allocator: non-cash lines first, in order, capped at what remains; CASH absorbs the remainder (change is clipped); shortfall → header account; DEPOSIT/unknown method → `null` (legacy single-debit path); CREDIT lines ignored. Method → account: CASH 1010, CARD 1020, BANK_TRANSFER 1030, MOBILE_MONEY / AIRTEL_MONEY 1040 |
| `src/services/glEntryService.ts` | full-payment and credit-partial branches debit per allocated account; `BANK_TRANSFER` is a recognised method |
| `src/modules/sales/salesService.ts` | passes `paymentLines` to the GL call |
| `src/services/bankingService.ts` `createFromSale` | optional `descriptionSuffix` (`" (supplement)"`); constraint-specific `23505` handling: the sale-source unique index → "already mirrored" (returns null), `transaction_number` collision → retry (6 attempts), anything else → throw; GL link falls back to a `SALE_TENDER_RECLASS` journal |

Proof (real Postgres, schema cloned from production `pos_template`; the suites skip loudly when Postgres is absent):
`saleTenderAllocation.test.ts` (unit + 2,000-case property: sum of debits = target, never negative, deterministic),
`saleTenderGl.realpg.test.ts` (8), `saleBankMirror.idempotency.realpg.test.ts` (5: 10-way concurrent mirror → 1 row, 12 different sales, retry-worker redelivery, refused mirror stays refused),
`saleTenderReclass.realpg.test.ts`, `bankMirrorReconcile.realpg.test.ts` (7). Mutation check: disabling the `23505` handling makes the concurrent test fail.

## 3. Correcting journals (historical)

Principles: posted journals are never edited; one **new** journal per sale through `AccountingCore.createJournalEntry` (source `SYSTEM_CORRECTION`,
`referenceType = SALE_TENDER_RECLASS`, `referenceId` = sale, `idempotencyKey = SALE-TENDER-RECLASS-<saleNumber>`) so governance, the open-period check and the unit of work all apply
and a retry cannot post twice.

* Target = what the payment lines say should be in each liquidity account for that sale; Posted = net of the original SALE journal **plus any earlier reclass journal**.
  Delta = Target − Posted. DR the under-stated accounts, CR the over-stated ones. A sale whose deltas do not net to zero is `REVIEW_*`, never posted.
* Plan → fingerprint (sha256 of every eligible sale's deltas) → apply must be given the **same fingerprint and an approval reference** or it refuses. Two scopes are approved separately:
  `SPLIT_TENDER` (multi-line sales) and `SINGLE_TENDER_MISPOSTED` (one method, wrong account).
* Re-plan after apply must show 0 eligible (idempotent). Non-liquidity accounts are untouched.
* `scripts/ops/tender-reclass.ts apply` **refuses any non-local host** in this version. A production-capable flag does not exist and must be added in a reviewed change after approval.

### Rehearsal on local copies of the production ledgers (`PROOF_SPLIT_TENDER_RECLASS_REHEARSAL.json`, 16/16 checks per tenant)

| | Henber | Blis |
|---|---|---|
| Sales classified | 17,455 | 4,018 |
| ELIGIBLE | **44** (28 split-tender, 16 single-method mis-posted) | **51** |
| Gross moved between liquidity accounts | 1,819,000 | 747,900 |
| Net movement 1010 / 1020 / 1030 / 1040 | −812,600 / −20,000 / 0 / +832,600 | +497,900 / +19,000 / 0 / −516,900 |
| Liquidity total before = after | 7,840,793.83 = 7,840,793.83 | equal |
| Trial balance DR = CR before and after | yes | yes |
| Non-liquid-accounts checksum, sales / payment lines / bank rows checksums before = after | identical | identical |
| `REVIEW_*` (not touched) | `REVIEW_NOT_COMPLETED` 99 | `REVIEW_NOT_COMPLETED` 9 (all others 0) |
| Second apply | 0 posted, replay no-op | same |

**Number reconciliation (important):** the earlier gate report quoted "Henber 29 sales / 964,701, Blis 51 / 771,000" from a coarser query.
The classifier gives 44 / 51. The Henber difference is explained in the proof file (`gateDefinitionReconciliation`: 39 sales / 2,860,199 when credit/deposit lines are included,
31 / 1,024,701 when excluded) and by the 16 single-method MoMo sales the first query did not look at. Use the classifier numbers; **the production plan must be re-run read-only and its numbers compared with this table before any approval.**

`REVIEW_NOT_COMPLETED` (Henber 99, Blis 9): sales that are not in a completed state (voided/refunded etc.). They are excluded from the correction and need their own review; no treatment is proposed here.

## 4. Bank mirror reconciliation (`PROOF_BANK_MIRROR_RECONCILE_REHEARSAL.json`, all checks pass)

GL is the source of truth; a bank row is a register view. One row per (sale, method), description `Sale N [METHOD]` (+ ` (supplement)` for a same-method remainder),
created only when the sale's GL (after the reclass) supports that tender. CARD is excluded by policy. Mirroring went live 2026-09-25, so two eras are separate approvals.

| | Henber | Blis |
|---|---|---|
| POST_GO_LIVE missing/under | **3 rows, 39,000** (MoMo; caused by the same defect) | **3 rows, 17,000** (1 missing + 2 under) |
| PRE_GO_LIVE missing | 1,169 rows, 37,113,010 — **not applied** | 558 rows (+1 `REVIEW_GL_DOES_NOT_SUPPORT`) — **not applied** |
| Ledger changed by the mirror step | no (journal md5 identical) | no |
| Replay | created 0 | created 0 |

Pre-go-live back-fill is a **policy decision** (it would add register rows for months in which the register was not maintained; bank reconciliation periods are probably closed). Not proposed for approval now.

Idempotency: the unique index `uq_bank_txn_sale_source_desc_live (source_id, description) WHERE source_type='SALE' AND not reversed` + the `23505` handling above means a retry (worker redelivery, double click, concurrent run) can neither create a second bank transaction nor silently drop the first.

## 5. Owner decisions (2026-10-29) — not combined, in this order

1. **Entry date: current open period**, with the sale number in each line description. History of those days is left as posted; one dated catch-up. (Rehearsal used 2026-10-28.)
2. Approve **scope 1 `SPLIT_TENDER`** and **scope 2 `SINGLE_TENDER_MISPOSTED`** per tenant, each with the fingerprint from a fresh read-only plan.
3. Approve **POST_GO_LIVE** bank rows **after** step 2 (the mirror needs the GL to support the tender). **PRE_GO_LIVE is not applied** (register was not maintained then; closed bank-reconciliation periods).
4. Independent verification: someone other than the author re-runs `plan` against production (read-only) and signs the fingerprint and totals before any production apply flag is added.

Order on production, each with its own approval reference: **deploy the fixed posting code → reclass scope 1 → reclass scope 2 → mirror POST_GO_LIVE → re-plan (0 eligible) → reconcile checks.**
Rollback of a correcting journal = a reversal through `AccountingCore` (reversal entries are the approved route); the bank rows created by the mirror are reversible through the bank module's reversal.

## 6. Not proven / open

* Production apply path is deliberately absent. The rehearsal is on copies of two tenants' ledger slices (accounts, periods, sales, payment lines, ledger, bank, period balances, outbox), not on a full tenant database.
* Closed periods: the template treats a missing `financial_periods` row as open; the production period state for the chosen entry date must be checked before approval; AccountingCore's open-period check would refuse a closed period at apply time (the plan itself does not look at period state).
* The post-deploy accuracy of **new** sales depends on the deployed code; see `PRODUCTION_CHANGE_PLAN.md` gate list.
