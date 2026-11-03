-- Migration 646: Drop trg_sync_invoice_payment (amount_paid-only linked-sale sync)
--
-- Live class (Blis / template clone, 2026-11-03):
--   Full DEPOSIT (or any liquidity) on a CREDIT sale+invoice fails:
--     chk_sales_credit_has_debt
--   because AFTER INSERT on invoice_payments the trigger
--   sync_invoice_payment_to_sales_and_customer() does:
--     UPDATE sales SET amount_paid = SUM(payments)  -- leaves payment_method = CREDIT
--   Constraint: CREDIT ⇒ amount_paid < total_amount.
--
-- Why 067 was not enough:
--   067 DROP FUNCTION … CASCADE removed it once.
--   create_invoice_payment_trigger.sql / customer_transaction_consistency.sql
--   re-CREATEd the trigger (same pattern as Bliss PascalCase sync / 645).
--
-- App SSOT: invoiceRepository.syncLinkedSaleFromInvoice
--   tender-only amount_paid; liquidity full settle leaves CREDIT → clearing method.
-- Idempotent. Never CREATE this trigger again.

DROP TRIGGER IF EXISTS trg_sync_invoice_payment ON invoice_payments;
DROP FUNCTION IF EXISTS sync_invoice_payment_to_sales_and_customer() CASCADE;

INSERT INTO schema_version (version) VALUES (646)
ON CONFLICT DO NOTHING;
