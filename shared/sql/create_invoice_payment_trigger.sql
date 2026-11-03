-- ==========================================
-- INVOICE PAYMENT → SALE SYNC (NEUTRALIZED)
-- ==========================================
-- Historical script CREATEd trg_sync_invoice_payment which UPDATE'd
-- sales.amount_paid only (left CREDIT) and violated chk_sales_credit_has_debt
-- on full tender. Service SSOT: invoiceRepository.syncLinkedSaleFromInvoice.
-- Migration 646 permanently drops the objects. This file is DROP-only so any
-- re-apply cannot resurrect the trigger (067 → recreate lesson).

DROP TRIGGER IF EXISTS trg_sync_invoice_payment ON invoice_payments;
DROP FUNCTION IF EXISTS sync_invoice_payment_to_sales_and_customer() CASCADE;
