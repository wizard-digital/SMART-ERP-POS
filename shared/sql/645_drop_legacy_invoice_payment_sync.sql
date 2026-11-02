-- Migration 645: Drop legacy invoice_payments sync trigger/function (PascalCase drift)
--
-- Live incident (2026-11-02, pos_tenant_bliss_interior_ltd):
--   Credit/partial-credit POS sale failed ERR_SALE_007 with:
--     column "InvoiceNumber" does not exist
-- Root cause: enabled trigger trg_invoice_payment_sync → fn_sync_invoice_payment
-- still referenced invoices."InvoiceNumber" / "AmountPaid" / "Id" after migration 030
-- renamed invoices to snake_case.
--
-- Why this is the SECOND time:
--   067 (2026-05-22 15:41) and 253 (15:42) removed/disabled the object on Bliss.
--   comprehensive_invoice_triggers.sql (15:42:56 SAME DAY, later) re-created it.
--   Henber never applied comprehensive → stayed clean. Ledger said "fixed"; live object returned.
--
-- Hard stops: this file + postcondition + comprehensive_invoice_triggers.sql now DROP-only
-- for this trigger (never CREATE). App SSOT: invoiceRepository.recalcInvoice.
-- Idempotent.

DROP TRIGGER IF EXISTS trg_invoice_payment_sync ON invoice_payments;
DROP FUNCTION IF EXISTS fn_sync_invoice_payment() CASCADE;
DROP FUNCTION IF EXISTS fn_post_invoice_payment_to_ledger_manual(uuid) CASCADE;

INSERT INTO schema_version (version) VALUES (645)
ON CONFLICT DO NOTHING;
