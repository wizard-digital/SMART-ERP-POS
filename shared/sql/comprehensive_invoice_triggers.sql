-- ============================================================================
-- COMPREHENSIVE INVOICE TRIGGERS FOR CUSTOMERS AND SUPPLIERS
-- ============================================================================
-- Ensures all invoice data is database-triggered for consistency and accuracy
--
-- CUSTOMER SIDE:
--   - invoices (PascalCase columns)
--   - invoice_payments (snake_case columns)
--   - customers (snake_case columns)
--
-- SUPPLIER SIDE:
--   - supplier_invoices (PascalCase columns)
--   - supplier_payments (PascalCase columns)
--   - supplier_payment_allocations
--   - suppliers (PascalCase columns)
-- ============================================================================

-- ============================================================================
-- PART 1: CUSTOMER INVOICE TRIGGERS
-- ============================================================================

-- 1A. When an invoice is created/updated, update customer balance
CREATE OR REPLACE FUNCTION fn_sync_customer_on_invoice_change()
RETURNS TRIGGER AS $$
DECLARE
    v_customer_id UUID;
BEGIN
    IF TG_OP = 'DELETE' THEN
        v_customer_id := OLD."CustomerId";
    ELSE
        v_customer_id := NEW."CustomerId";
        -- Handle customer change
        IF TG_OP = 'UPDATE' AND OLD."CustomerId" IS DISTINCT FROM NEW."CustomerId" THEN
            PERFORM fn_recalculate_customer_ar_balance(OLD."CustomerId");
        END IF;
    END IF;
    
    IF v_customer_id IS NOT NULL THEN
        PERFORM fn_recalculate_customer_ar_balance(v_customer_id);
    END IF;
    
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    ELSE
        RETURN NEW;
    END IF;
    -- FIXED: Removed EXCEPTION WHEN OTHERS - errors must propagate to abort transaction
END;
$$ LANGUAGE plpgsql;

-- 1B. Recalculate customer AR balance from all ISSUED invoices
-- CANONICAL FORMULA: Used by all trigger functions and app code
-- Draft invoices are NOT yet issued to customers → excluded from AR
CREATE OR REPLACE FUNCTION fn_recalculate_customer_ar_balance(p_customer_id UUID)
RETURNS VOID AS $$
DECLARE
    v_total_outstanding NUMERIC;
BEGIN
    -- Sum outstanding balances from all ISSUED invoices for this customer
    SELECT COALESCE(SUM("OutstandingBalance"), 0)
    INTO v_total_outstanding
    FROM invoices
    WHERE "CustomerId" = p_customer_id
      AND "Status" NOT IN ('Paid', 'Cancelled', 'Voided', 'Draft');
    
    -- Update customer balance (customers table uses snake_case)
    UPDATE customers
    SET balance = v_total_outstanding,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = p_customer_id;
    
    RAISE NOTICE 'Updated customer % AR balance to %', p_customer_id, v_total_outstanding;
    -- FIXED: Removed EXCEPTION WHEN OTHERS - errors must propagate
END;
$$ LANGUAGE plpgsql;

-- 1C. Invoice payment sync trigger — REMOVED (service-layer SSOT).
-- Live regression (Bliss Interior 2026-11-02): this file was applied AFTER 067/253
-- and re-created trg_invoice_payment_sync / fn_sync_invoice_payment against PascalCase
-- invoices."InvoiceNumber", breaking credit sales (ERR_SALE_007). Never recreate.
-- App path: invoiceRepository.recalcInvoice + syncCustomerBalanceFromInvoices.
DROP TRIGGER IF EXISTS trg_invoice_payment_sync ON invoice_payments;
DROP FUNCTION IF EXISTS fn_sync_invoice_payment() CASCADE;

-- Create/replace customer invoice triggers
DROP TRIGGER IF EXISTS trg_sync_customer_on_invoice ON invoices;
CREATE TRIGGER trg_sync_customer_on_invoice
    AFTER INSERT OR UPDATE OR DELETE ON invoices
    FOR EACH ROW
    EXECUTE FUNCTION fn_sync_customer_on_invoice_change();

-- ============================================================================
-- PART 2: SUPPLIER INVOICE TRIGGERS
-- ============================================================================

-- 2A. When a supplier invoice is created/updated, update supplier balance
CREATE OR REPLACE FUNCTION fn_sync_supplier_on_invoice_change()
RETURNS TRIGGER AS $$
DECLARE
    v_supplier_id UUID;
BEGIN
    IF TG_OP = 'DELETE' THEN
        v_supplier_id := OLD."SupplierId";
    ELSE
        v_supplier_id := NEW."SupplierId";
        -- Handle supplier change
        IF TG_OP = 'UPDATE' AND OLD."SupplierId" IS DISTINCT FROM NEW."SupplierId" THEN
            PERFORM fn_recalculate_supplier_ap_balance(OLD."SupplierId");
        END IF;
    END IF;
    
    IF v_supplier_id IS NOT NULL THEN
        PERFORM fn_recalculate_supplier_ap_balance(v_supplier_id);
    END IF;
    
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    ELSE
        RETURN NEW;
    END IF;
    -- FIXED: Removed EXCEPTION WHEN OTHERS - errors must propagate
END;
$$ LANGUAGE plpgsql;

-- 2B. Recalculate supplier AP balance from all unpaid invoices
CREATE OR REPLACE FUNCTION fn_recalculate_supplier_ap_balance(p_supplier_id UUID)
RETURNS VOID AS $$
DECLARE
    v_total_outstanding NUMERIC;
BEGIN
    -- Sum outstanding balances from all supplier invoices
    SELECT COALESCE(SUM("OutstandingBalance"), 0)
    INTO v_total_outstanding
    FROM supplier_invoices
    WHERE "SupplierId" = p_supplier_id
      AND "Status" NOT IN ('Cancelled', 'Voided')
      AND deleted_at IS NULL;
    
    -- Update supplier balance (suppliers uses PascalCase)
    UPDATE suppliers
    SET "OutstandingBalance" = v_total_outstanding,
        "UpdatedAt" = CURRENT_TIMESTAMP
    WHERE "Id" = p_supplier_id;
    
    RAISE NOTICE 'Updated supplier % AP balance to %', p_supplier_id, v_total_outstanding;
    -- FIXED: Removed EXCEPTION WHEN OTHERS - errors must propagate
END;
$$ LANGUAGE plpgsql;

-- 2C. Supplier payment allocation trigger - update invoice and supplier balance
CREATE OR REPLACE FUNCTION fn_sync_supplier_payment_allocation()
RETURNS TRIGGER AS $$
DECLARE
    v_invoice_id UUID;
    v_supplier_id UUID;
    v_total_paid NUMERIC;
    v_total_amount NUMERIC;
    v_new_status TEXT;
BEGIN
    IF TG_OP = 'DELETE' THEN
        v_invoice_id := OLD."SupplierInvoiceId";
    ELSE
        v_invoice_id := NEW."SupplierInvoiceId";
    END IF;
    
    -- Get invoice details (supplier_invoices uses PascalCase)
    SELECT "SupplierId", "TotalAmount"
    INTO v_supplier_id, v_total_amount
    FROM supplier_invoices WHERE "Id" = v_invoice_id;
    
    -- Sum all allocations for this invoice
    SELECT COALESCE(SUM("Amount"), 0)
    INTO v_total_paid
    FROM supplier_payment_allocations
    WHERE "SupplierInvoiceId" = v_invoice_id;
    
    -- Determine new status
    IF v_total_paid >= v_total_amount THEN
        v_new_status := 'Paid';
    ELSIF v_total_paid > 0 THEN
        v_new_status := 'PartiallyPaid';
    ELSE
        v_new_status := 'Unpaid';
    END IF;
    
    -- Update supplier invoice
    UPDATE supplier_invoices
    SET "AmountPaid" = v_total_paid,
        "OutstandingBalance" = GREATEST(v_total_amount - v_total_paid, 0),
        "Status" = v_new_status,
        "UpdatedAt" = CURRENT_TIMESTAMP
    WHERE "Id" = v_invoice_id;
    
    -- Update supplier AP balance
    IF v_supplier_id IS NOT NULL THEN
        PERFORM fn_recalculate_supplier_ap_balance(v_supplier_id);
    END IF;
    
    RAISE NOTICE 'Supplier invoice % updated: paid=%, status=%', v_invoice_id, v_total_paid, v_new_status;
    
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    ELSE
        RETURN NEW;
    END IF;
    -- FIXED: Removed EXCEPTION WHEN OTHERS - errors must propagate
END;
$$ LANGUAGE plpgsql;

-- 2D. Supplier payment trigger - update supplier balance
CREATE OR REPLACE FUNCTION fn_sync_supplier_on_payment()
RETURNS TRIGGER AS $$
DECLARE
    v_supplier_id UUID;
BEGIN
    IF TG_OP = 'DELETE' THEN
        v_supplier_id := OLD."SupplierId";
    ELSE
        v_supplier_id := NEW."SupplierId";
    END IF;
    
    IF v_supplier_id IS NOT NULL THEN
        PERFORM fn_recalculate_supplier_ap_balance(v_supplier_id);
    END IF;
    
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    ELSE
        RETURN NEW;
    END IF;
    -- FIXED: Removed EXCEPTION WHEN OTHERS - errors must propagate
END;
$$ LANGUAGE plpgsql;

-- Create/replace supplier invoice triggers
DROP TRIGGER IF EXISTS trg_sync_supplier_on_invoice ON supplier_invoices;
CREATE TRIGGER trg_sync_supplier_on_invoice
    AFTER INSERT OR UPDATE OR DELETE ON supplier_invoices
    FOR EACH ROW
    EXECUTE FUNCTION fn_sync_supplier_on_invoice_change();

DROP TRIGGER IF EXISTS trg_supplier_payment_allocation_sync ON supplier_payment_allocations;
CREATE TRIGGER trg_supplier_payment_allocation_sync
    AFTER INSERT OR UPDATE OR DELETE ON supplier_payment_allocations
    FOR EACH ROW
    EXECUTE FUNCTION fn_sync_supplier_payment_allocation();

DROP TRIGGER IF EXISTS trg_sync_supplier_on_payment ON supplier_payments;
CREATE TRIGGER trg_sync_supplier_on_payment
    AFTER INSERT OR UPDATE OR DELETE ON supplier_payments
    FOR EACH ROW
    EXECUTE FUNCTION fn_sync_supplier_on_payment();

-- ============================================================================
-- PART 3: GL POSTING TRIGGERS FOR INVOICES
-- ============================================================================

-- 3A. Post customer invoice to GL when issued
CREATE OR REPLACE FUNCTION fn_post_customer_invoice_to_ledger()
RETURNS TRIGGER AS $$
DECLARE
    v_transaction_id UUID;
    v_transaction_number TEXT;
    v_ar_account_id UUID;
    v_revenue_account_id UUID;
    v_line_number INTEGER := 0;
BEGIN
    -- Only trigger on status change to 'Issued' or 'Sent'
    IF NEW."Status" IN ('Issued', 'Sent') AND (OLD."Status" IS NULL OR OLD."Status" = 'Draft') THEN
        
        -- Get account IDs
        SELECT "Id" INTO v_ar_account_id FROM accounts WHERE "AccountCode" = '1200';
        SELECT "Id" INTO v_revenue_account_id FROM accounts WHERE "AccountCode" = '4000';
        
        IF v_ar_account_id IS NULL OR v_revenue_account_id IS NULL THEN
            RAISE WARNING 'GL accounts not found for invoice posting';
            RETURN NEW;
        END IF;
        
        -- Generate transaction number
        v_transaction_number := 'LT-' || TO_CHAR(CURRENT_DATE, 'YYYY') || '-' || 
                                LPAD((SELECT COALESCE(MAX(CAST(SUBSTRING("TransactionNumber" FROM '[0-9]+$') AS INTEGER)), 0) + 1 
                                      FROM ledger_transactions)::TEXT, 6, '0');
        v_transaction_id := gen_random_uuid();
        
        -- Create ledger transaction
        INSERT INTO ledger_transactions (
            "Id", "TransactionNumber", "TransactionDate", "ReferenceType", "ReferenceId",
            "ReferenceNumber", "Description", "TotalDebitAmount", "TotalCreditAmount",
            "Status", "CreatedAt", "UpdatedAt", "IsReversed"
        ) VALUES (
            v_transaction_id,
            v_transaction_number,
            CURRENT_TIMESTAMP,
            'INVOICE',
            NEW."Id",
            NEW."InvoiceNumber",
            'Customer Invoice: ' || NEW."InvoiceNumber",
            NEW."TotalAmount",
            NEW."TotalAmount",
            'POSTED',
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP,
            FALSE
        );
        
        -- DR Accounts Receivable
        v_line_number := v_line_number + 1;
        INSERT INTO ledger_entries (
            "Id", "TransactionId", "LedgerTransactionId", "AccountId", "EntryType",
            "Amount", "DebitAmount", "CreditAmount", "Description", "LineNumber",
            "EntityType", "EntityId", "EntryDate", "RunningBalance", "CreatedAt"
        ) VALUES (
            gen_random_uuid(), v_transaction_id, v_transaction_id, v_ar_account_id, 'DEBIT',
            NEW."TotalAmount", NEW."TotalAmount", 0, 
            'Invoice ' || NEW."InvoiceNumber" || ' - ' || NEW."CustomerName",
            v_line_number, 'INVOICE', NEW."Id"::TEXT, CURRENT_TIMESTAMP, 0, CURRENT_TIMESTAMP
        );
        
        -- CR Revenue
        v_line_number := v_line_number + 1;
        INSERT INTO ledger_entries (
            "Id", "TransactionId", "LedgerTransactionId", "AccountId", "EntryType",
            "Amount", "DebitAmount", "CreditAmount", "Description", "LineNumber",
            "EntityType", "EntityId", "EntryDate", "RunningBalance", "CreatedAt"
        ) VALUES (
            gen_random_uuid(), v_transaction_id, v_transaction_id, v_revenue_account_id, 'CREDIT',
            NEW."TotalAmount", 0, NEW."TotalAmount",
            'Revenue - Invoice ' || NEW."InvoiceNumber",
            v_line_number, 'INVOICE', NEW."Id"::TEXT, CURRENT_TIMESTAMP, 0, CURRENT_TIMESTAMP
        );
        
        RAISE NOTICE 'Posted customer invoice % to ledger as %', NEW."InvoiceNumber", v_transaction_number;
    END IF;
    
    RETURN NEW;
    -- FIXED: Removed EXCEPTION WHEN OTHERS - GL failures MUST abort transaction
END;
$$ LANGUAGE plpgsql;

-- 3B. Post supplier invoice to GL when received
CREATE OR REPLACE FUNCTION fn_post_supplier_invoice_to_ledger()
RETURNS TRIGGER AS $$
DECLARE
    v_transaction_id UUID;
    v_transaction_number TEXT;
    v_ap_account_id UUID;
    v_expense_account_id UUID;
    v_line_number INTEGER := 0;
    v_supplier_name TEXT;
BEGIN
    -- Only trigger on status change to 'Received' or 'Approved'
    IF NEW."Status" IN ('Received', 'Approved') AND (OLD."Status" IS NULL OR OLD."Status" = 'Draft') THEN
        
        -- Get supplier name
        SELECT "Name" INTO v_supplier_name FROM suppliers WHERE "Id" = NEW."SupplierId";
        
        -- Get account IDs
        SELECT "Id" INTO v_ap_account_id FROM accounts WHERE "AccountCode" = '2000';
        SELECT "Id" INTO v_expense_account_id FROM accounts WHERE "AccountCode" = '5100';
        
        IF v_ap_account_id IS NULL THEN
            RAISE WARNING 'AP account not found for supplier invoice posting';
            RETURN NEW;
        END IF;
        
        -- Generate transaction number
        v_transaction_number := 'LT-' || TO_CHAR(CURRENT_DATE, 'YYYY') || '-' || 
                                LPAD((SELECT COALESCE(MAX(CAST(SUBSTRING("TransactionNumber" FROM '[0-9]+$') AS INTEGER)), 0) + 1 
                                      FROM ledger_transactions)::TEXT, 6, '0');
        v_transaction_id := gen_random_uuid();
        
        -- Create ledger transaction
        INSERT INTO ledger_transactions (
            "Id", "TransactionNumber", "TransactionDate", "ReferenceType", "ReferenceId",
            "ReferenceNumber", "Description", "TotalDebitAmount", "TotalCreditAmount",
            "Status", "CreatedAt", "UpdatedAt", "IsReversed"
        ) VALUES (
            v_transaction_id,
            v_transaction_number,
            CURRENT_TIMESTAMP,
            'SUPPLIER_INVOICE',
            NEW."Id",
            NEW."SupplierInvoiceNumber",
            'Supplier Invoice: ' || NEW."SupplierInvoiceNumber" || ' - ' || COALESCE(v_supplier_name, 'Unknown'),
            NEW."TotalAmount",
            NEW."TotalAmount",
            'POSTED',
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP,
            FALSE
        );
        
        -- DR Expense/Inventory (simplified - using general expense account)
        IF v_expense_account_id IS NOT NULL THEN
            v_line_number := v_line_number + 1;
            INSERT INTO ledger_entries (
                "Id", "TransactionId", "LedgerTransactionId", "AccountId", "EntryType",
                "Amount", "DebitAmount", "CreditAmount", "Description", "LineNumber",
                "EntityType", "EntityId", "EntryDate", "RunningBalance", "CreatedAt"
            ) VALUES (
                gen_random_uuid(), v_transaction_id, v_transaction_id, v_expense_account_id, 'DEBIT',
                NEW."TotalAmount", NEW."TotalAmount", 0,
                'Expense - ' || NEW."SupplierInvoiceNumber",
                v_line_number, 'SUPPLIER_INVOICE', NEW."Id"::TEXT, CURRENT_TIMESTAMP, 0, CURRENT_TIMESTAMP
            );
        END IF;
        
        -- CR Accounts Payable
        v_line_number := v_line_number + 1;
        INSERT INTO ledger_entries (
            "Id", "TransactionId", "LedgerTransactionId", "AccountId", "EntryType",
            "Amount", "DebitAmount", "CreditAmount", "Description", "LineNumber",
            "EntityType", "EntityId", "EntryDate", "RunningBalance", "CreatedAt"
        ) VALUES (
            gen_random_uuid(), v_transaction_id, v_transaction_id, v_ap_account_id, 'CREDIT',
            NEW."TotalAmount", 0, NEW."TotalAmount",
            'AP - Invoice ' || NEW."SupplierInvoiceNumber",
            v_line_number, 'SUPPLIER_INVOICE', NEW."Id"::TEXT, CURRENT_TIMESTAMP, 0, CURRENT_TIMESTAMP
        );
        
        RAISE NOTICE 'Posted supplier invoice % to ledger as %', NEW."SupplierInvoiceNumber", v_transaction_number;
    END IF;
    
    RETURN NEW;
    -- FIXED: Removed EXCEPTION WHEN OTHERS - GL failures MUST abort transaction
END;
$$ LANGUAGE plpgsql;

-- Create GL posting triggers
DROP TRIGGER IF EXISTS trg_post_customer_invoice_to_ledger ON invoices;
CREATE TRIGGER trg_post_customer_invoice_to_ledger
    AFTER INSERT OR UPDATE ON invoices
    FOR EACH ROW
    EXECUTE FUNCTION fn_post_customer_invoice_to_ledger();

DROP TRIGGER IF EXISTS trg_post_supplier_invoice_to_ledger ON supplier_invoices;
CREATE TRIGGER trg_post_supplier_invoice_to_ledger
    AFTER INSERT OR UPDATE ON supplier_invoices
    FOR EACH ROW
    EXECUTE FUNCTION fn_post_supplier_invoice_to_ledger();

-- ============================================================================
-- PART 4: INVOICE PAYMENT GL POSTING
-- ============================================================================

-- 4A. Post customer invoice payment to GL
CREATE OR REPLACE FUNCTION fn_post_invoice_payment_to_ledger()
RETURNS TRIGGER AS $$
DECLARE
    v_transaction_id UUID;
    v_transaction_number TEXT;
    v_cash_account_id UUID;
    v_ar_account_id UUID;
    v_invoice_number TEXT;
    v_line_number INTEGER := 0;
BEGIN
    IF TG_OP = 'INSERT' THEN
        -- Get invoice number
        SELECT "InvoiceNumber" INTO v_invoice_number FROM invoices WHERE "Id" = NEW.invoice_id;
        
        -- Get account IDs
        SELECT "Id" INTO v_cash_account_id FROM accounts WHERE "AccountCode" = '1010';
        SELECT "Id" INTO v_ar_account_id FROM accounts WHERE "AccountCode" = '1200';
        
        IF v_cash_account_id IS NULL OR v_ar_account_id IS NULL THEN
            RAISE WARNING 'GL accounts not found for payment posting';
            RETURN NEW;
        END IF;
        
        -- Generate transaction number
        v_transaction_number := 'LT-' || TO_CHAR(CURRENT_DATE, 'YYYY') || '-' || 
                                LPAD((SELECT COALESCE(MAX(CAST(SUBSTRING("TransactionNumber" FROM '[0-9]+$') AS INTEGER)), 0) + 1 
                                      FROM ledger_transactions)::TEXT, 6, '0');
        v_transaction_id := gen_random_uuid();
        
        -- Create ledger transaction
        INSERT INTO ledger_transactions (
            "Id", "TransactionNumber", "TransactionDate", "ReferenceType", "ReferenceId",
            "ReferenceNumber", "Description", "TotalDebitAmount", "TotalCreditAmount",
            "Status", "CreatedAt", "UpdatedAt", "IsReversed"
        ) VALUES (
            v_transaction_id,
            v_transaction_number,
            CURRENT_TIMESTAMP,
            'INVOICE_PAYMENT',
            NEW.id,
            NEW.receipt_number,
            'Invoice Payment: ' || NEW.receipt_number || ' for ' || COALESCE(v_invoice_number, 'Unknown'),
            NEW.amount,
            NEW.amount,
            'POSTED',
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP,
            FALSE
        );
        
        -- DR Cash
        v_line_number := v_line_number + 1;
        INSERT INTO ledger_entries (
            "Id", "TransactionId", "LedgerTransactionId", "AccountId", "EntryType",
            "Amount", "DebitAmount", "CreditAmount", "Description", "LineNumber",
            "EntityType", "EntityId", "EntryDate", "RunningBalance", "CreatedAt"
        ) VALUES (
            gen_random_uuid(), v_transaction_id, v_transaction_id, v_cash_account_id, 'DEBIT',
            NEW.amount, NEW.amount, 0,
            'Payment received - ' || NEW.receipt_number,
            v_line_number, 'INVOICE_PAYMENT', NEW.id::TEXT, CURRENT_TIMESTAMP, 0, CURRENT_TIMESTAMP
        );
        
        -- CR Accounts Receivable
        v_line_number := v_line_number + 1;
        INSERT INTO ledger_entries (
            "Id", "TransactionId", "LedgerTransactionId", "AccountId", "EntryType",
            "Amount", "DebitAmount", "CreditAmount", "Description", "LineNumber",
            "EntityType", "EntityId", "EntryDate", "RunningBalance", "CreatedAt"
        ) VALUES (
            gen_random_uuid(), v_transaction_id, v_transaction_id, v_ar_account_id, 'CREDIT',
            NEW.amount, 0, NEW.amount,
            'AR reduced - ' || NEW.receipt_number,
            v_line_number, 'INVOICE_PAYMENT', NEW.id::TEXT, CURRENT_TIMESTAMP, 0, CURRENT_TIMESTAMP
        );
        
        RAISE NOTICE 'Posted invoice payment % to ledger as %', NEW.receipt_number, v_transaction_number;
    END IF;
    
    RETURN NEW;
    -- FIXED: Removed EXCEPTION WHEN OTHERS - GL failures MUST abort transaction
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_post_invoice_payment_to_ledger ON invoice_payments;
CREATE TRIGGER trg_post_invoice_payment_to_ledger
    AFTER INSERT ON invoice_payments
    FOR EACH ROW
    EXECUTE FUNCTION fn_post_invoice_payment_to_ledger();

-- ============================================================================
-- SUMMARY OF TRIGGERS CREATED
-- ============================================================================
SELECT 'COMPREHENSIVE INVOICE TRIGGERS INSTALLED' AS status;

SELECT '=== CUSTOMER INVOICE TRIGGERS ===' AS section
UNION ALL
SELECT 'trg_sync_customer_on_invoice - Updates customer balance when invoice changes'
UNION ALL
SELECT 'trg_invoice_payment_sync - REMOVED (service-layer SSOT; never recreate)'
UNION ALL
SELECT 'trg_post_customer_invoice_to_ledger - Posts invoice to GL'
UNION ALL
SELECT 'trg_post_invoice_payment_to_ledger - Posts payment to GL'
UNION ALL
SELECT '=== SUPPLIER INVOICE TRIGGERS ==='
UNION ALL
SELECT 'trg_sync_supplier_on_invoice - Updates supplier balance when invoice changes'
UNION ALL
SELECT 'trg_supplier_payment_allocation_sync - Updates invoice when payment allocated'
UNION ALL
SELECT 'trg_sync_supplier_on_payment - Updates supplier balance on payment'
UNION ALL
SELECT 'trg_post_supplier_invoice_to_ledger - Posts supplier invoice to GL';
