# PROOF: Legacy invoice payment sync (PascalCase InvoiceNumber)

**PASS** — exercised on real Postgres scratch

- Gates: 9
- Failed: 0

| Gate | OK | Detail |
|------|----|--------|
| PLANTED_TRIGGER | yes | Bliss-class trigger attached |
| INSERT_FAILS_INVOICENUMBER | yes | column "InvoiceNumber" does not exist |
| AFTER_645_TRIGGER_GONE | yes | 645 dropped trigger |
| AFTER_645_FN_GONE | yes | 645 dropped function |
| INSERT_SUCCEEDS_AFTER_645 | yes | payment rows=1 |
| REPLANTED | yes | replanted for comprehensive check |
| COMPREHENSIVE_NO_CREATE_SYNC | yes | comprehensive no longer CREATEs trg_invoice_payment_sync |
| COMPREHENSIVE_DROP_CLEARS | yes | DROP path clears replant |
| FORBIDDEN_LIST_BLOCKS_SYNC | yes | [{"table":"sale_items","trigger":"trg_sync_sale_totals"}] |

## Production truth (read-only, 2026-11-02)

- Bliss Interior: `trg_invoice_payment_sync` = present, PascalCase body
- 067 + 253 marked applied May 2026; `comprehensive_invoice_triggers.sql` re-created later same day
- Henber: trigger absent (never applied comprehensive)
- Fix not live until schema 645 deploys
