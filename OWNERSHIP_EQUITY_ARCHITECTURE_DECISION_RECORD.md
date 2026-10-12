# OWNERSHIP & EQUITY ARCHITECTURE DECISION RECORD

Status: **APPROVED for Option A implementation** (2026-10-12).

Approved decisions:

- Keep `3200` Owner Capital, `3300` Owner Drawings, `3050` Opening Balance Equity, `3100` Retained Earnings, `3000` Equity header unchanged.
- New accounts only: `3400` Share Capital, `2450` Dividends Payable, `2600` Shareholder Loans.
- Posting source: `OWNERSHIP_EQUITY` via `AccountingCore.createJournalEntry` only.
- Migration file: `shared/sql/636_ownership_equity.sql` (schema stamp 636; after expense 635).
- Permissions: `ownership.read|manage|issue|transfer|dividend_approve` plus existing `accounting.post` for journals.
- Legal form default: `SOLE_PROPRIETOR`. Switch to `COMPANY` is reversible only when shares, open loans, and open dividends are clear.
- Preference shares and non-cash consideration remain deferred.

Explicitly not approved: renaming `3200` to share capital, re-applying `021` cost-layer trigger, posting ownership journals outside AccountingCore, or computing ownership percent from equity balances.

Evidence labels: PROVEN, NOT PROVEN, INFERRED, REQUIRES DECISION.

Read-only production probe at 2026-09-26 (UTC) against `samplepos-postgres` on the production host. Databases listed from `pg_database`: `pos_system`, `pos_template`, `pos_tenant_acme_store`, `pos_tenant_blis`, `pos_tenant_bliss_interior_ltd`, `pos_tenant_dynamics`, `pos_tenant_henber_pharmacy`. No rows were inserted, updated, or deleted.

---

## 1. Current accounting architecture

PROVEN in source, and left untouched:

| Function | Where it lives | What it does |
| --- | --- | --- |
| Journal creation | `AccountingCore.createJournalEntry` | Balanced journal, period check, idempotency, UnitOfWork or caller transaction |
| Posting rules | `PostingGovernanceService` | Source, account, and journal validation before the ledger |
| Header rejection | `journalEntryService` `ERR_JOURNAL_007` | A line whose `IsPostingAccount` is false cannot be posted |
| Year-end close | `FiscalYearCloseService.closeFiscalYear` | Default retained-earnings account `3100`, reference `YEAR_END_CLOSE` |
| Tenant data | One PostgreSQL database per tenant | `req.tenantPool`; `pos_system` is the directory |
| Opening balance equity | Account `3050` | Bank opening uses `3050`, not sales and not `3200` |
| Owner capital | Account `3200` Owner Capital | Journal preset and bank owner-capital path |
| Owner drawings | Account `3300` Owner Drawings | Journal preset |
| Audit | `audit_log` | Existing trail |
| Permissions | `src/rbac/permissions.ts` | `accounting.read/create/post/approve/...` |

Live chart on every probed database, including `pos_template`:

| Code | Name | Posting | Ledger lines |
| --- | --- | --- | --- |
| 3000 | Equity | false (header) | 0 |
| 3050 | Opening Balance Equity | true | Henber 2437, Bliss Interior 9, Blis 2, others 0 |
| 3100 | Retained Earnings | true | 0 |
| 3200 | Owner Capital | true, manual allowed | 0 |
| 3300 | Owner Drawings | true, manual allowed | 0 |

PROVEN: `3200` is named Owner Capital and is a posting account. PROVEN: those six databases have no ledger lines on `3200` or `3300`. That does not authorize a rename. Code, heal scripts `623`/`624`, and the journal preset still define the meaning of a future `DR Cash / CR 3200`.

There is no `legal_form`, `company_type`, or `share_capital` column or constant in application or SQL. NOT PROVEN that any tenant is a company rather than a sole proprietor. REQUIRES DECISION before any share register is stored.

---

## 2. 3200 trigger investigation

File: `shared/sql/021_cost_layer_gl_trigger.sql`.

What the file does, PROVEN from the file text:

- Function `fn_post_cost_layer_to_gl`.
- Trigger `trg_cost_layer_gl_failsafe`, `BEFORE INSERT ON cost_layers`.
- Fires only when `goods_receipt_id` is null, `gl_transaction_id` is null, and quantity times unit cost is greater than zero.
- Inserts `ledger_transactions` with number prefix `CLGL-` and `ReferenceType = 'COST_LAYER'`, plus description `TRIGGER: Cost layer ...`.
- Debits account `1300` and credits account `3200`.
- The comment calls `3200` "Opening Balance Equity". That comment is historically wrong relative to the live chart. The credit target in the function is the account whose code is `3200`, which is now Owner Capital.

Supersession, PROVEN in source:

- `shared/sql/253_disable_business_logic_triggers.sql` disables `trg_cost_layer_gl_failsafe` because cost-layer GL belongs in the service layer.
- `shared/sql/061_drop_disabled_triggers.sql` drops that trigger and `DROP FUNCTION IF EXISTS fn_post_cost_layer_to_gl() CASCADE`.
- The tenant runner records files in `schema_migrations` and does not list `021` anywhere except inside that file. Filename order places `021` before `061`.

What the postcondition does not lock, PROVEN in source:

- `legacyTriggerPostconditions.ts` checks other triggers after `061`. It does not list `trg_cost_layer_gl_failsafe`. Absence of this trigger is proven by the database probe, not by that automated check.

Live database probe, PROVEN, all six databases:

| Database | Trigger rows | Function rows | `CLGL-` journals | `ReferenceType = COST_LAYER` | Description `TRIGGER:%` |
| --- | --- | --- | --- | --- | --- |
| pos_template | 0 | 0 | 0 | 0 | 0 |
| pos_tenant_henber_pharmacy | 0 | 0 | 0 | 0 | 0 |
| pos_tenant_dynamics | 0 | 0 | 0 | 0 | 0 |
| pos_tenant_bliss_interior_ltd | 0 | 0 | 0 | 0 | 0 |
| pos_tenant_acme_store | 0 | 0 | 0 | 0 | 0 |
| pos_tenant_blis | 0 | 0 | 0 | 0 | 0 |

Conclusion:

1. Still in current schema: no. PROVEN on these databases.
2. Installed in tenant databases: no. PROVEN on these databases, and on the template new tenants are cloned from.
3. Active: no. There is no trigger row, so `tgenabled` is not applicable.
4. Can execute: no. The function is also absent.
5. Reachable from current inventory workflows: the application still inserts `cost_layers` from sales, returns, and stock movement. If the trigger were reinstalled, those inserts could fire it. Today they cannot, because the trigger is absent. PROVEN absent. INFERRED that an insert would have been the reachability path when the trigger existed.
6. Has ever posted: no `CLGL-`, `COST_LAYER`, or `TRIGGER:%` journals remain. PROVEN for remaining rows. NOT PROVEN that such rows were never created and later deleted by a data reset.
7. Superseded: yes, by migrations `253` and `061` and by service-layer posting. PROVEN in source, and consistent with the empty trigger catalog.
8. The file is historical. It is not dead as a text artifact. Re-applying `021` after deleting its `schema_migrations` row would recreate the trigger and credit live `3200` Owner Capital. That is a regression risk, not current behavior.

Safe re-check SQL (read-only):

```sql
SELECT current_database() AS db,
       (SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_cost_layer_gl_failsafe') AS trigger_rows,
       (SELECT tgenabled::text FROM pg_trigger WHERE tgname = 'trg_cost_layer_gl_failsafe' LIMIT 1) AS enabled,
       (SELECT count(*) FROM pg_proc WHERE proname = 'fn_post_cost_layer_to_gl') AS function_rows,
       (SELECT count(*) FROM ledger_transactions WHERE "TransactionNumber" LIKE 'CLGL-%') AS clgl_journals,
       (SELECT count(*) FROM ledger_transactions WHERE "ReferenceType" = 'COST_LAYER') AS cost_layer_refs;
```

This investigation did not disable, drop, or edit the trigger.

---

## 3. 3000 constant investigation

PROVEN:

- `AccountCodes.OWNERS_EQUITY = '3000'` is declared in `glEntryService.ts`.
- No other TypeScript file reads `OWNERS_EQUITY`. Posting code does not call that constant.
- The seed file `database/seeds/001_seed_initial_data.sql` inserts `3000` as `Owner Equity`. Live databases disagree with that seed name: the account is `Equity`, `IsPostingAccount = false`, and it has zero ledger lines.
- Journal preset `capital-investment` resolves capital in this order: `3200` whose name is not opening balance, then any `3200`, then account `3000`.
- Bank owner-capital resolution prefers a name match on Owner Capital, then `3200`, then `3000` only when the name matches equity or capital.
- `journalEntryService` rejects a header account with `ERR_JOURNAL_007`.

Therefore:

- `3000` is a real chart row. It is a header, not a posting account.
- `3200` is the live owner-capital posting account.
- The constant is semantic and unused. Changing it would not change current posting, because nothing reads it.
- The UI fallback can select `3000` only when `3200` is missing. On the probed tenants `3200` exists, so the fallback does not run. If it did run, the save would fail at journal validation because `3000` is not a posting account. PROVEN by the validator and by `IsPostingAccount = false`. NOT PROVEN by an executed click on a tenant that lacks `3200`.

Recommendation: leave the constant and the fallback unchanged in this phase. A later cleanup may stop the UI from offering `3000`, after a test that a missing `3200` still shows the existing error. Do not repurpose `3000` as share capital. A header cannot carry share-capital balances.

---

## 4. Sole proprietor model

Keep the current meaning.

Owner A contributes UGX 50,000,000:

- Debit cash or bank.
- Credit `3200` Owner Capital.
- Preset and bank path already do this.
- No share count, no percentage, no shareholder row.

Owner drawings stay:

- Debit `3300` Owner Drawings.
- Credit cash or bank.

Year-end close stays a close into `3100`. Drawings are not automatically converted to shares.

PROVEN this path exists. PROVEN the probed tenants have not yet posted amounts to `3200` or `3300`. The path must still keep its meaning for the next posting.

---

## 5. Company / shareholder model

A company is not "owner capital split by percentage."

Required facts, stored as shares, not computed from the general ledger:

- Register of holders.
- Share class. Ordinary only in the first approved build. Preference is deferred.
- Shares the company has issued.
- Current holding (who holds how many now).
- History that answers who held the shares on a date.
- Issue (company creates shares) separate from transfer (holder A to holder B).
- Dividend declaration separate from dividend payment.
- Shareholder loan as a liability to a person, with no effect on share counts.

Example: 5,000 + 3,000 + 2,000 shares. Percents are 50 / 30 / 20. Retained earnings in `3100` do not change those percents.

No application code distinguishes sole proprietor from company today. REQUIRES DECISION: an explicit legal-form setting on the tenant, not an inference from whether `3200` has a balance.

---

## 6. Comparison of accounting options

### Option A — keep 3200, add a separate share-capital account

- Accounting: sole-proprietor journals stay `DR Cash / CR 3200` and `DR 3300 / CR Cash`. Company share issues post to a new equity account. Loans post to a new liability account. Dividends declare against `3100` and a new payable. `3050` and year-end `3100` stay.
- Migration: new empty tables and, only when approved, new accounts. No update of historical ledger rows.
- Existing tenants: chart rows `3000`–`3300` stay as they are. Zero lines on `3200` means there is nothing to reclassify, and also nothing that already means share capital.
- Reporting: balance sheet equity gains a share-capital line when the account exists. Owner Capital remains its own line.
- Year-end: close still targets `3100`.
- Owner contribution: unchanged, account `3200`.
- Shareholder contribution: new event, new account, only when the company receives consideration.
- Risk: two equity accounts can be confused in the journal UI if both are offered to a sole proprietor. The legal-form setting must hide share issue on sole-prop tenants.
- AccountingCore and PostingGovernance: compatible. New events call `createJournalEntry`. No second journal writer.
- Evidence fit: matches live names and heal scripts `623`/`624`.

### Option B — reinterpret 3200 as Share Capital

- Accounting: every existing and future `CR 3200` would change meaning. Bank help text, journal preset, and evidence tests (`bankingOwnerCapital.evidence.test.ts`, `tenantMigrationDrift.test.ts`) all say Owner Capital.
- Migration: a rename is a semantic migration even when the balance is zero. The next owner drawing or capital preset would post to "share capital" without shares.
- Historical data: lines are zero on probed tenants, PROVEN. The meaning in code is not zero. A later tenant or a posting after this probe would be mislabeled.
- Year-end and opening balance: `3100` and `3050` would be untouched, but `3200` would no longer be the owner-capital offset the bank screen documents.
- Risk: high. This is the option the gate forbids unless a separate approved strategy exists. This record does not approve it.
- Evidence fit: contradicted by live account name, presets, and governance tests.

### Option C — company-type-specific equity structure

- Accounting: sole prop uses `3200`/`3300`; company uses share capital, dividends payable, and shareholder loan. Same ledger engine.
- Migration: requires a legal-form row that does not exist. PROVEN absent. Without it, the system cannot know which structure to show.
- Risk: if "company type" is implemented by renaming `3200` for companies, it collapses into Option B. If it only selects which new accounts and screens are available, it is Option A plus a setting.
- Evidence fit: the setting is required and missing. The rename variant is unsafe.

---

## 7. Recommended architecture

Recommend Option A, with a legal-form setting so a company does not treat `3200` as share capital. That is the safe reading of Option C.

Do not choose Option B.

Rules:

- `3200` remains Owner Capital. `3300` remains Owner Drawings. `3050` remains Opening Balance Equity. `3100` remains Retained Earnings. `3000` remains the Equity header.
- Ownership percentage comes from share holdings. It is not `equity account / total equity`.
- The general ledger remains the financial source of truth. The share register remains the ownership source of truth.
- Every financial event calls existing `AccountingCore.createJournalEntry`, which already calls posting governance. No direct `ledger_entries` insert for this feature.
- Private transfers post no revenue and no cash journal.
- A shareholder loan does not issue shares and does not credit `3200` or `3100`.
- Do not move historical owner-capital journals into share capital. On the probed databases there are no such journals. The rule still holds if any appear later.

Account numbers for share capital, dividends payable, and shareholder loans are REQUIRES DECISION. `2100` is trade payables. `2150` is GR/IR clearing. Neither can be reused. Pick unused codes only after a chart scan in the implementation phase.

---

## 8. Database conceptual model

All of the following live in the tenant database. None of this is implemented.

Identity, PROVEN: `users` are login staff. `customers` are receivable parties. `suppliers` are payable parties. There is no person, contact, or business-partner master that can represent an owner who is not already one of those.

Shareholder row, therefore:

- Primary key in the tenant database.
- Legal name, because an owner may not be a customer or a user.
- Optional `customer_id`. Optional `user_id`. When a link is set, do not copy phone, email, or address onto the shareholder.
- Do not create a duplicate customer for every shareholder.
- A supplier link is not required for identity. Use it only if a loan is intentionally a supplier bill, which this design does not do.

Other tables:

- `company_legal_profile` — one row, `SOLE_PROPRIETOR` or `COMPANY`.
- `share_classes` — code, name, voting flag. Seed one Ordinary class when legal form is company.
- `share_issues` — class, quantity, issue date, consideration amount, journal id nullable, status.
- `share_holdings` — shareholder, class, quantity now. Maintained only by issue and transfer events.
- `share_ledger_events` — append-only: issue, transfer, cancellation. Columns include prior holder, new holder, quantity, effective date, authorization, reference. This is the "who owned these shares on date X" source. Query holdings as of a date from events, not from a rewritten current row.
- `share_transfers` — holder-to-holder. No cash assumption.
- `dividend_declarations` — proposed, approved, declared. Declared links to the journal that credits a liability.
- `dividend_payments` — payment journal id.
- `shareholder_loans` — principal, holder, liability account, status. Journal on drawdown and on repayment.

Current holding is a projection. History is the event table. Do not update an event in place.

---

## 9. Ownership lifecycle

1. Tenant stays sole proprietor until an authorized user sets legal form to company. That action does not post a journal and does not rename `3200`.
2. Company gets one ordinary class.
3. Issues and transfers append events and update current holdings.
4. Percent = holder shares / issued shares of voting classes. Retained earnings are ignored.
5. Reversing an issue or transfer is a new event, not a delete of history.

---

## 10. Share issuance lifecycle

Authorization (who, date, quantity, class, consideration) → issue record → append ledger event → update current holding → if the company received cash or another asset, one balanced journal through AccountingCore: debit the asset, credit the new share-capital account → audit.

No hardcoded percents. No update of prior events. Non-cash consideration is REQUIRES DECISION (debit the asset that was received, still through AccountingCore).

---

## 11. Share transfer lifecycle

Company issuance creates shares.

A private transfer moves existing shares:

- Previous holder, new holder, quantity, date, authorizer, reason or reference.
- Holdings after the event match the event math.
- No company cash, no revenue, no credit to `3200`.
- If money moves between two people outside the company, the company books nothing.

A transfer that would make a holding negative fails closed.

---

## 12. Dividend lifecycle

Proposal → approval → declaration → liability → payment.

- Proposal and approval change document status and audit. They do not post.
- Declaration posts one journal: debit `3100` Retained Earnings, credit a dividends-payable liability. Period must be open. Governance must accept the source.
- Payment posts: debit the payable, credit cash or bank.
- Declaration and payment are different documents and different journals.
- Reverse only through the existing reversal path, not by editing lines.
- A dividend does not change share counts.

Permissions for approve versus post are separate. See section 15.

---

## 13. Shareholder loan lifecycle

Owner A lends the company UGX 20,000,000.

- Drawdown journal: debit cash, credit shareholder-loan liability. Subledger row names A and the amount.
- The loan does not change shares, does not credit `3200`, and does not change `3100`.
- Repayment: debit the liability, credit cash.
- Do not create a second liability engine. The subledger is a document; the ledger write is AccountingCore, the same way other controlled documents post.
- Do not file the loan as a supplier invoice. Trade AP (`2100`) and GR/IR (`2150`) stay trade accounts.
- Interest, if ever charged, is a later decision and a separate expense journal.

---

## 14. Accounting integration

```text
Business event
  → ownership / equity service (documents, holdings, approvals)
  → AccountingCore.createJournalEntry
  → PostingGovernanceService
  → existing ledger
```

Events with no journal: legal-form change, private share transfer, dividend proposal.

Events with one journal: share issue for consideration, dividend declaration, dividend payment, loan drawdown, loan repayment, existing owner capital, existing owner drawing.

Idempotency keys must use the existing journal idempotency behavior so a retry does not double-post.

---

## 15. RBAC

Approved keys (seeded in `636_ownership_equity.sql` and `permissions.ts`):

| Key | Allows |
| --- | --- |
| `ownership.read` | View register, holdings, history, dividends, loans |
| `ownership.manage` | Holders, classes, legal form |
| `ownership.issue` | Create an issue document |
| `ownership.transfer` | Record a private transfer |
| `ownership.dividend_approve` | Approve a dividend |
| Existing `accounting.post` | Post the declaration, payment, issue, or loan journal |
| Existing `accounting.approve` | Approvals that already use the accounting approval permission |

Role sketch, REQUIRES DECISION before seeding:

- Admin: all of the above.
- Accountant / manager: read, and post only if they already have `accounting.post`. Approve dividends only if they have `accounting.approve` or the new dividend-approve key.
- Cashier and staff: none.
- Auditor: `ownership.read` if auditors already have accounting read.

Viewing, creating, approving, posting, and reversing stay different permissions. Reversal uses the existing journal reverse path plus `accounting` void/approve rights, not a silent delete.

---

## 16. Audit

Reuse `audit_log`. Record legal-form change, issue, transfer, dividend proposal, approval, declaration, payment, loan drawdown, and repayment, each with user and document id. Journals already carry their own transaction audit. Do not invent a second audit store.

---

## 17. Tenant isolation

PROVEN today: each tenant has its own database. Shareholder tables do not exist yet, so a cross-tenant read of them cannot be demonstrated. INFERRED from the database-per-tenant design: a table created only in the tenant database is not readable by another tenant's pool. `pos_system` stays the tenant directory. Do not add a central shareholder database.

NOT PROVEN: a future implementation that puts these tables in `pos_system` would break isolation. The implementation phase must create them only through the tenant migration runner and must prove `current_database()` on two tenants.

---

## 18. UI integration

Built under Accounting → Ownership (`/accounting/ownership`, `OwnershipEquityPage`).

- Navigation: Accounting → Ownership.
- Sole proprietor: one page showing Owner Capital and Owner Drawings help, linking to the existing journal presets. No share grid.
- Company: tabs for Holders, Share classes, Issues, Transfers, Holdings (as of a date), Dividends, Loans.
- Dialogs for issue, transfer, declare, pay, and loan, using existing dialog and React Query patterns.
- Tables use the existing adaptive table behavior.
- Mobile: same pages, stacked. No extra mobile app.
- Hide issue, transfer, and dividend actions unless the matching permission is present.

---

## 19. Migration strategy

Approved as `636_ownership_equity.sql`. Implementation checklist:

1. Do not edit `021`, `3200`, `3300`, `3050`, `3100`, or `3000`.
2. Add a tenant migration that creates the empty register tables.
3. Add new accounts only after unused codes are proven, using the same idempotent insert style as `624`, without renaming existing codes.
4. Do not backfill shares from `3200` balances. Balances are zero now, and a non-zero balance later is still owner capital until an explicit conversion document is approved per tenant.
5. Set legal form default to sole proprietor so current tenants see no share UI until someone changes it.
6. Confirm `schema_migrations` still contains `021` and `061`, so the runner does not recreate `fn_post_cost_layer_to_gl`.

---

## 20. Regression risks

- Re-running `021` would credit Owner Capital `3200` from a cost-layer insert and bypass AccountingCore. The function is absent today. The automated `061` postcondition does not watch this trigger name.
- Renaming `3200` would break the journal preset, the bank owner-capital test, and the meaning of any future capital journal.
- Pointing the unused `OWNERS_EQUITY` constant at `3200` looks tidy and changes nothing today, but a later caller could post "owners equity" to the wrong concept. Leave it until a real caller exists.
- Treating `3000` as share capital would fail (`ERR_JOURNAL_007`) or, if someone flipped it to a posting account, would mix a header with capital.
- Using `2100` or `2150` for shareholder loans would corrupt trade payables and GR/IR.
- Computing ownership from equity balances would change percents when retained earnings change.
- A private transfer that posts cash would invent company revenue.

---

## 21. Tests required before any implementation is called done

Do not treat compilation as proof.

- Owner capital preset still resolves `3200` and still refuses a header `3000` post (`ERR_JOURNAL_007`).
- Owner drawing preset still resolves `3300`.
- Bank owner-capital path still documents `3200` and still refuses to use sales revenue.
- Year-end close still defaults to `3100`.
- Trigger probe SQL still returns zero trigger rows and zero function rows on the template and at least two tenants.
- Share percent fixture: 5000 / 3000 / 2000 remains 50 / 30 / 20 after a retained-earnings journal.
- Private transfer fixture: holdings change, ledger row count does not.
- Issue fixture: one balanced journal via the journal service, share count increases, retry does not double-post.
- Loan fixture: liability increases, share count unchanged, `3200` unchanged.
- Dividend fixture: declaration creates a payable; payment clears it; proposal alone does not post.
- Two-tenant test: a holder inserted in tenant A is absent from tenant B.
- Permission test: cashier cannot issue, transfer, or approve.

---

## 22. Open decisions

Decided for this build:

1. Legal-form: `ownership.manage` may switch SOLE_PROPRIETOR ↔ COMPANY; revert blocked while shares / open loans / unpaid dividends remain.
2. Account codes: `3400` / `2450` / `2600` (fail-closed if those codes already exist under another name).
3. Non-cash share consideration: deferred (cash/liquidity consideration only).
4. Preference shares: deferred.
5. Par value: no-par (consideration amount is the journal amount).
6. Dividend approval: `ownership.dividend_approve`; journal post still requires `accounting.post`.
7. Company tenants keep `3200` on the chart; it is not renamed or hidden by migration.

Still deferred: statutory distributable-profit tests beyond book retained earnings; interest on shareholder loans.
