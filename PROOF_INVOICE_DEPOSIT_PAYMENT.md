# PROOF: Invoice deposit payment integrity

**PASS**

- Gates: 50
- Failed: 0

| Gate | OK | Detail |
|------|----|--------|
| SSOT_DECIMAL | yes | decimal.js |
| SSOT_NO_MATH_ROUND | yes | no Math.round |
| SSOT_NO_MATH_MIN | yes | no Math.min |
| SSOT_FIFO | yes | FIFO allocator |
| SSOT_CAP | yes | cap helper |
| SSOT_ASSERT_APPLIED | yes | applied==requested |
| CAP_MIN | yes | deposit smaller |
| CAP_OUTSTANDING | yes | outstanding smaller |
| CAP_ZERO_DEP | yes | no deposit → 0 |
| CAP_ZERO_AR | yes | no AR → 0 |
| ASSERT_OK | yes | exact deposit apply |
| ASSERT_OVER_CAP | yes | over deposit rejected |
| ASSERT_ZERO | yes | zero rejected |
| FIFO_COUNT | yes | 2 rows |
| FIFO_OLD | yes | old 100 |
| FIFO_NEW | yes | new 30 |
| FIFO_TOTAL | yes | 130.00 applied |
| FIFO_SHORT | yes | shortfall throws INSUFFICIENT_DEPOSIT |
| INV_USES_ASSERT_AMOUNT | yes | server validates via SSOT |
| INV_USES_ASSERT_APPLIED | yes | applied == requested |
| INV_NO_INVOICE_AS_SALE | yes | never invoice UUID as sale_id |
| INV_PASSES_INVOICE_ID | yes | passes invoiceId option |
| INV_BALANCE_ON_CLIENT | yes | balance check inside tx |
| INV_ORPHAN_SALE_FALLBACK | yes | orphan sale_id falls back to invoice target |
| INV_NEVER_REWRITE_CREDIT_TO_DEPOSIT | yes | never rewrite CREDIT → DEPOSIT/CASH on sale header |
| GL_SKIP_DEPOSIT_CASH | yes | DEPOSIT invoice payment does not post cash |
| GL_APPLY_SOURCE | yes | apply posts DEPOSIT_APPLICATION |
| LOCK_FN | yes | lock helper |
| LOCK_SQL | yes | FOR UPDATE |
| APPLY_USES_FIFO | yes | service uses FIFO SSOT |
| APPLY_USES_LOCK | yes | service locks first |
| APPLY_MONEY_FIXED | yes | 2dp write |
| APPLY_NO_TONUMBER_LOOP | yes | no toNumber in apply loop |
| MIG_600 | yes | migration 600 present |
| APPLY_SCHEMA_PREFLIGHT | yes | invoice-only apply asserts migration 600 schema before INSERT |
| APPLY_SALE_FK_LOUD | yes | sale FK violation fails loud (not generic constraint) |
| POSTCOND_600 | yes | migration 600 postcondition heals tenant drift |
| POSTCOND_597 | yes | migration 597 postcondition keeps DEPOSIT_APPLICATION on 1200/2200 |
| UI_HOOK | yes | shared fetch hook |
| HOOK_NO_SILENT_ZERO | yes | fetch fail → error, not 0 |
| MODAL_HOOK | yes | modal uses hook |
| MODAL_DEPOSIT_OPTION | yes | DEPOSIT option |
| MODAL_SSOT_CAP | yes | modal uses cap SSOT |
| MODAL_SSOT_ASSERT | yes | modal asserts amount |
| MODAL_NO_SILENT_CATCH | yes | modal no silent 0 |
| PAGE_HOOK | yes | page uses hook |
| PAGE_DEPOSIT_OPTION | yes | page DEPOSIT option |
| PAGE_SSOT_ASSERT | yes | page asserts amount |
| PAGE_NO_SILENT_ZERO | yes | page no silent 0 |
| SALE_ASSERT_APPLIED | yes | POS deposit apply identity |

## Identities
- Apply GL: `DEPOSIT_APPLICATION` DR 2200 / CR AR 1200
- Invoice payment row records the same 2dp amount as applied
- Cash receipt is not posted for DEPOSIT
- FIFO lock: `FOR UPDATE` then allocateDepositFifo
- Receive Payment never treats a failed balance fetch as zero

Apply migration `shared/sql/600_deposit_apply_invoice.sql` so invoices without a sale can apply deposits.
