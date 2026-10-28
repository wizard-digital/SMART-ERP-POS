# TXN-002362 (Henber) — investigation and decision record

Status: **Option A approved 2026-10-29.** The posted journal is not edited. The fingerprint lives in `ops/ledger-known-exceptions.json` and the G4 header-integrity gate fails if it changes, disappears, or if any other mismatch appears.
Nothing was written to production. Evidence source: read-only copy of the Henber ledger slice (`rehearsal_henber`, local), taken from production with `pg_dump` over SSH.

## Facts (reconciled header ↔ entries ↔ source sale)

| Item | Value |
|---|---|
| Journal | `TXN-002362`, `POSTED`, `ReferenceType=SALE`, `ReferenceNumber=SALE-2026-0011`, dated 2026-04-04, created 2026-04-04 17:31:08 (never updated afterwards) |
| Idempotency key | `SALE-5f711cd2-5d8d-445d-b56b-9ccd1a7e936c` (present, unique) |
| Source sale | `SALE-2026-0011`: list price 9,000, discount 1,000, `total_amount` **8,000**, `amount_paid` 9,000 (cash tendered), one `CASH` payment line of 9,000 (1,000 change) |
| Header totals | `TotalDebitAmount = TotalCreditAmount = 14,850` |
| Entries, `DebitAmount`/`CreditAmount` columns (what every GL report reads) | DR 1010 Cash **8,000** · CR 4000 Revenue **8,000** · DR 5000 COGS 5,850 · CR 1300 Inventory 5,850 → **13,850 = 13,850, balanced** |
| Entries, `Amount` column | Cash row 9,000, Revenue row 9,000 (the pre-discount price), COGS 5,850, Inventory 5,850 → 14,850 each side |

So the **economic posting is correct** (cash received 8,000 = sale total; revenue 8,000 = list price − discount). The defect is
that the header totals and the `Amount` column of two rows kept the **pre-discount 9,000** while the debit/credit columns carry the net 8,000.
This is an April-2026 (pre-discount-SSOT) posting artefact: current `AccountingCore` writes all of them from the same number.

## Population (is it only this one?)

| Check (all POSTED journals) | Henber | Blis |
|---|---|---|
| `Amount ≠ DebitAmount + CreditAmount` on an entry | **2 entries, both in TXN-002362** | 0 |
| header total ≠ sum of entry debit/credit | **1 journal (TXN-002362)** | 0 |
| journal unbalanced by debit/credit columns | 0 | 0 |

## What is affected

* Trial balance, P&L, balance sheet, cash book, period balances: **not affected** (they read `DebitAmount` / `CreditAmount`; no code reads
  `ledger_entries.Amount` as a ledger value, and `ledger_transactions.TotalDebitAmount` is read only for the `YEAR_END_CLOSE` journal).
* Integrity checks that compare header totals with entries (the gates' "header ≠ entries" check) report 1 failure.

## Options

| | Treatment | Pros | Cons |
|---|---|---|---|
| **A (recommended)** | Leave the journal as is; record it as a **documented, owner-approved exception** (this file); the integrity gate would then expect exactly this one journal as a known exception (that gate change is not made yet) | No edit of a posted journal; zero risk to balances; audit trail untouched | One permanent header/`Amount` inconsistency in the table |
| B | Reverse `TXN-002362` and re-post the identical economics through `AccountingCore` (approved reversal/adjustment path) | Table becomes consistent | Two new journals for zero economic change; the sale's cash/revenue move out and back in (report noise on the day posted, an open-period question); more risk than the defect |
| C | `UPDATE` the header total and the two `Amount` values in place | Smallest change | **Edits a posted journal** — forbidden by the posting rules; would need a separately approved audited data-fix procedure |

Recommendation: **A** — **chosen 2026-10-29.** Neither B nor C is prepared as a script, deliberately: there is nothing economic to correct.

Encoded so it cannot silently grow:
* `ops/ledger-known-exceptions.json` lists this one journal with header 14,850 / entries 13,850 / Amount 14,850, economically balanced.
* `evaluateLedgerHeaderIntegrity` (and G4.`headerMismatch`) pass only when that fingerprint is present and nothing else is.
* `AccountingCore.assertWrittenJournalMatchesHeader` refuses any new journal of this class (create and reverse).

## Related findings from the same population scan (also not corrected)

* Two POSTED journals were modified after creation: `TXN-010322` (SALE, created 2026-05-20 10:10, updated 11:02) and `TXN-022675`
  (SUPPLIER_INVOICE, created 2026-07-14, updated 2026-07-28). Their debit = credit and they reconcile to their sources; the process that
  updated them is not identified. Treat as a **controls finding**: posted journals are supposed to be immutable.
* 11 POSTED Henber journals have no idempotency key (`CORRECTION` ×4, `SUPPLIER_INVOICE` ×3, `CUTOVER_ASSET_CORRECTION`,
  `INVENTORY_ADJUSTMENT`, `REVERSAL`, `SALE_REFUND_CORRECTION`, 2026-01-01 … 2026-07-22). Manual/legacy posting paths; no duplicate risk found.
* Schema drift: the template has `CHECK chk_posted_requires_idempotency`; the Henber and Blis databases do not. It would reject exactly those 11 rows.
  Do not add the constraint to the tenants until the 11 rows are accounted for.

## Decision

Owner chose **A** on 2026-10-29. The two modified-journal findings (`TXN-010322`, `TXN-022675`) and the 11 journals without idempotency keys remain **controls findings**, not data fixes. Production is unchanged.
