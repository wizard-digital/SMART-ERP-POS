-- ============================================================================
-- CONCURRENCY & IDEMPOTENCY FIXES
-- ============================================================================
-- Purpose: Prevent duplicate GL postings and ensure data integrity under
--          concurrent access scenarios.
--
-- ISSUES IDENTIFIED:
-- 1. NO unique constraint on (ReferenceType, ReferenceId) in ledger_transactions
-- 2. Race condition: Two concurrent status updates can both fire GL trigger
-- 3. DUPLICATE triggers: fn_sync_invoice_payment AND fn_post_invoice_payment_to_ledger
--    BOTH create GL entries for invoice_payments
-- 4. DUPLICATE triggers: 3 triggers all sync account balance on ledger_entries
-- 5. No overpayment prevention on invoice_payments
--
-- Date: December 29, 2025
-- ============================================================================

BEGIN;

-- ============================================================================
-- FIX 1: Do NOT unique (ReferenceType, ReferenceId)
-- ============================================================================
-- Migration 017 dropped this. Split journals (sale + COGS, expense + payment)
-- and reversals share a document id on purpose. Idempotency is
-- ledger_transactions_IdempotencyKey_key. Re-adding this constraint is how
-- Bliss rejected expense reverse with HTTP 409 while other tenants did not.
-- 628 drops it again; this file must not put it back on a later full replay.

ALTER TABLE ledger_transactions
  DROP CONSTRAINT IF EXISTS uq_ledger_transactions_reference;

DROP INDEX IF EXISTS uq_ledger_transactions_reference;
DROP INDEX IF EXISTS idx_ledger_transactions_reference_unique;

-- ============================================================================
-- FIX 2: Remove duplicate invoice payment triggers
-- ============================================================================
-- Keep only trg_post_invoice_payment_to_ledger for GL posting
-- fn_sync_invoice_payment duplicates GL posting AND account updates

-- First, modify fn_sync_invoice_payment to NOT create GL entries
-- (the GL entries are created by fn_post_invoice_payment_to_ledger)

CREATE OR REPLACE FUNCTION fn_sync_invoice_payment()
RETURNS TRIGGER AS $$
DECLARE
    v_invoice RECORD;
BEGIN
    IF TG_OP = 'INSERT' THEN
        -- Get invoice details
        SELECT "InvoiceNumber", "CustomerId" INTO v_invoice
        FROM invoices WHERE "Id" = NEW.invoice_id;
        
        -- Update invoice paid amount and outstanding
        -- NOTE: GL posting is handled by trg_post_invoice_payment_to_ledger
        UPDATE invoices SET
            "AmountPaid" = "AmountPaid" + NEW.amount,
            "OutstandingBalance" = "TotalAmount" - ("AmountPaid" + NEW.amount),
            "Status" = CASE 
                WHEN ("AmountPaid" + NEW.amount) >= "TotalAmount" THEN 'PAID'
                WHEN ("AmountPaid" + NEW.amount) > 0 THEN 'PartiallyPaid'
                ELSE "Status"
            END,
            "UpdatedAt" = CURRENT_TIMESTAMP
        WHERE "Id" = NEW.invoice_id;
        
        -- Update customer balance (reduce AR)
        UPDATE customers 
        SET balance = GREATEST(0, balance - NEW.amount),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = v_invoice."CustomerId";
        
        RAISE NOTICE 'Invoice payment % synced: amount=%, receipt=%', 
            NEW.id, NEW.amount, NEW.receipt_number;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- FIX 3: Remove duplicate account balance sync triggers
-- ============================================================================
-- Keep only trg_sync_account_balance (the one we created in the reconciliation fix)

DROP TRIGGER IF EXISTS trg_sync_account_balance_insert ON ledger_entries;
DROP TRIGGER IF EXISTS trg_sync_account_balance_update ON ledger_entries;
DROP TRIGGER IF EXISTS trg_sync_account_balance_delete ON ledger_entries;
DROP TRIGGER IF EXISTS trg_sync_account_balance_on_ledger ON ledger_entries;

-- ============================================================================
-- FIX 4: Add idempotency check to sale GL posting trigger
-- ============================================================================
-- Prevents duplicate posting even under race conditions

CREATE OR REPLACE FUNCTION fn_post_sale_to_ledger()
RETURNS TRIGGER AS $$
DECLARE
    v_transaction_id UUID;
    v_transaction_number TEXT;
    v_cash_account_id UUID;
    v_ar_account_id UUID;
    v_credit_card_account_id UUID;
    v_revenue_account_id UUID;
    v_cogs_account_id UUID;
    v_inventory_account_id UUID;
    v_debit_account_id UUID;
    v_line_number INTEGER := 0;
    v_is_deposit_sale BOOLEAN := FALSE;
    v_existing_transaction UUID;
BEGIN
    -- Only trigger on status change to COMPLETED
    IF NEW.status = 'COMPLETED' AND (OLD.status IS NULL OR OLD.status != 'COMPLETED') THEN
        
        -- IDEMPOTENCY CHECK: Verify no GL transaction already exists for this sale
        SELECT "Id" INTO v_existing_transaction
        FROM ledger_transactions
        WHERE "ReferenceType" = 'SALE' AND "ReferenceId" = NEW.id
        LIMIT 1;
        
        IF v_existing_transaction IS NOT NULL THEN
            RAISE NOTICE 'Sale % already posted to GL as %, skipping duplicate', 
                NEW.sale_number, v_existing_transaction;
            RETURN NEW;
        END IF;
        
        -- Get account IDs from Chart of Accounts
        SELECT "Id" INTO v_cash_account_id FROM accounts WHERE "AccountCode" = '1010';
        SELECT "Id" INTO v_credit_card_account_id FROM accounts WHERE "AccountCode" = '1020';
        SELECT "Id" INTO v_ar_account_id FROM accounts WHERE "AccountCode" = '1200';
        SELECT "Id" INTO v_revenue_account_id FROM accounts WHERE "AccountCode" = '4000';
        SELECT "Id" INTO v_cogs_account_id FROM accounts WHERE "AccountCode" = '5000';
        SELECT "Id" INTO v_inventory_account_id FROM accounts WHERE "AccountCode" = '1300';
        
        -- Check if this is a DEPOSIT sale
        v_is_deposit_sale := (NEW.payment_method::TEXT = 'DEPOSIT');
        
        -- Determine debit account based on payment method
        IF v_is_deposit_sale THEN
            v_debit_account_id := NULL;
            RAISE NOTICE 'DEPOSIT sale % - skipping asset debit', NEW.sale_number;
        ELSE
            CASE NEW.payment_method::TEXT
                WHEN 'CASH' THEN v_debit_account_id := v_cash_account_id;
                WHEN 'CARD' THEN v_debit_account_id := v_credit_card_account_id;
                WHEN 'CREDIT' THEN v_debit_account_id := v_ar_account_id;
                WHEN 'MOBILE_MONEY' THEN v_debit_account_id := v_cash_account_id;
                ELSE v_debit_account_id := v_cash_account_id;
            END CASE;
        END IF;
        
        -- Generate transaction number
        v_transaction_number := COALESCE(
            (SELECT generate_ledger_transaction_number()),
            'LT-' || TO_CHAR(CURRENT_DATE, 'YYYY') || '-' || 
            LPAD((SELECT COALESCE(MAX(CAST(SUBSTRING("TransactionNumber" FROM '[0-9]+$') AS INTEGER)), 0) + 1 
                  FROM ledger_transactions)::TEXT, 6, '0')
        );
        v_transaction_id := gen_random_uuid();
        
        -- Create ledger transaction with idempotency key
        INSERT INTO ledger_transactions (
            "Id", "TransactionNumber", "TransactionDate", "ReferenceType", "ReferenceId",
            "ReferenceNumber", "Description", "TotalDebitAmount", "TotalCreditAmount",
            "Status", "CreatedAt", "UpdatedAt", "IsReversed", "IdempotencyKey"
        ) VALUES (
            v_transaction_id,
            v_transaction_number,
            CURRENT_TIMESTAMP,
            'SALE',
            NEW.id,
            NEW.sale_number,
            'Sale: ' || NEW.sale_number,
            COALESCE(NEW.total_amount, 0) + COALESCE(NEW.total_cost, 0),
            COALESCE(NEW.total_amount, 0) + COALESCE(NEW.total_cost, 0),
            'POSTED',
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP,
            FALSE,
            'SALE:' || NEW.id::TEXT  -- Idempotency key
        );
        
        -- Entry 1: DR Cash/Card/AR (amount received) - SKIP FOR DEPOSIT SALES
        IF v_debit_account_id IS NOT NULL THEN
            v_line_number := v_line_number + 1;
            INSERT INTO ledger_entries (
                "Id", "TransactionId", "LedgerTransactionId", "AccountId", "EntryType",
                "Amount", "DebitAmount", "CreditAmount", "Description", "LineNumber",
                "EntityType", "EntityId", "EntryDate", "RunningBalance", "CreatedAt"
            ) VALUES (
                gen_random_uuid(),
                v_transaction_id,
                v_transaction_id,
                v_debit_account_id,
                'DEBIT',
                COALESCE(NEW.total_amount, 0),
                COALESCE(NEW.total_amount, 0),
                0,
                'Sale payment - ' || NEW.sale_number,
                v_line_number,
                'SALE',
                NEW.id::TEXT,
                CURRENT_TIMESTAMP,
                0,
                CURRENT_TIMESTAMP
            );
        END IF;
        
        -- Entry 2: CR Sales Revenue
        v_line_number := v_line_number + 1;
        INSERT INTO ledger_entries (
            "Id", "TransactionId", "LedgerTransactionId", "AccountId", "EntryType",
            "Amount", "DebitAmount", "CreditAmount", "Description", "LineNumber",
            "EntityType", "EntityId", "EntryDate", "RunningBalance", "CreatedAt"
        ) VALUES (
            gen_random_uuid(),
            v_transaction_id,
            v_transaction_id,
            v_revenue_account_id,
            'CREDIT',
            COALESCE(NEW.total_amount, 0),
            0,
            COALESCE(NEW.total_amount, 0),
            'Sales revenue - ' || NEW.sale_number,
            v_line_number,
            'SALE',
            NEW.id::TEXT,
            CURRENT_TIMESTAMP,
            0,
            CURRENT_TIMESTAMP
        );
        
        -- Entry 3: DR COGS (if there's cost)
        IF COALESCE(NEW.total_cost, 0) > 0 THEN
            v_line_number := v_line_number + 1;
            INSERT INTO ledger_entries (
                "Id", "TransactionId", "LedgerTransactionId", "AccountId", "EntryType",
                "Amount", "DebitAmount", "CreditAmount", "Description", "LineNumber",
                "EntityType", "EntityId", "EntryDate", "RunningBalance", "CreatedAt"
            ) VALUES (
                gen_random_uuid(),
                v_transaction_id,
                v_transaction_id,
                v_cogs_account_id,
                'DEBIT',
                NEW.total_cost,
                NEW.total_cost,
                0,
                'Cost of goods sold - ' || NEW.sale_number,
                v_line_number,
                'SALE',
                NEW.id::TEXT,
                CURRENT_TIMESTAMP,
                0,
                CURRENT_TIMESTAMP
            );
            
            -- Entry 4: CR Inventory
            v_line_number := v_line_number + 1;
            INSERT INTO ledger_entries (
                "Id", "TransactionId", "LedgerTransactionId", "AccountId", "EntryType",
                "Amount", "DebitAmount", "CreditAmount", "Description", "LineNumber",
                "EntityType", "EntityId", "EntryDate", "RunningBalance", "CreatedAt"
            ) VALUES (
                gen_random_uuid(),
                v_transaction_id,
                v_transaction_id,
                v_inventory_account_id,
                'CREDIT',
                NEW.total_cost,
                0,
                NEW.total_cost,
                'Inventory reduction - ' || NEW.sale_number,
                v_line_number,
                'SALE',
                NEW.id::TEXT,
                CURRENT_TIMESTAMP,
                0,
                CURRENT_TIMESTAMP
            );
        END IF;
        
        RAISE NOTICE 'Posted sale % to ledger as % (payment: %)', NEW.sale_number, v_transaction_number, NEW.payment_method;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- FIX 5: Add idempotency check to invoice payment GL posting
-- ============================================================================

CREATE OR REPLACE FUNCTION fn_post_invoice_payment_to_ledger()
RETURNS TRIGGER AS $$
DECLARE
    v_transaction_id UUID;
    v_transaction_number TEXT;
    v_cash_account_id UUID;
    v_ar_account_id UUID;
    v_invoice_number TEXT;
    v_line_number INTEGER := 0;
    v_existing_transaction UUID;
BEGIN
    IF TG_OP = 'INSERT' THEN
        -- IDEMPOTENCY CHECK: Verify no GL transaction already exists for this payment
        SELECT "Id" INTO v_existing_transaction
        FROM ledger_transactions
        WHERE "ReferenceType" = 'INVOICE_PAYMENT' AND "ReferenceId" = NEW.id
        LIMIT 1;
        
        IF v_existing_transaction IS NOT NULL THEN
            RAISE NOTICE 'Invoice payment % already posted to GL, skipping duplicate', 
                NEW.receipt_number;
            RETURN NEW;
        END IF;
        
        -- Get invoice number
        SELECT "InvoiceNumber" INTO v_invoice_number FROM invoices WHERE "Id" = NEW.invoice_id;
        
        -- Get account IDs
        SELECT "Id" INTO v_cash_account_id FROM accounts WHERE "AccountCode" = '1010';
        SELECT "Id" INTO v_ar_account_id FROM accounts WHERE "AccountCode" = '1200';
        
        IF v_cash_account_id IS NULL OR v_ar_account_id IS NULL THEN
            RAISE EXCEPTION 'GL accounts not found for payment posting';
        END IF;
        
        -- Generate transaction number
        v_transaction_number := 'LT-' || TO_CHAR(CURRENT_DATE, 'YYYY') || '-' || 
                                LPAD((SELECT COALESCE(MAX(CAST(SUBSTRING("TransactionNumber" FROM '[0-9]+$') AS INTEGER)), 0) + 1 
                                      FROM ledger_transactions)::TEXT, 6, '0');
        v_transaction_id := gen_random_uuid();
        
        -- Create ledger transaction with idempotency key
        INSERT INTO ledger_transactions (
            "Id", "TransactionNumber", "TransactionDate", "ReferenceType", "ReferenceId",
            "ReferenceNumber", "Description", "TotalDebitAmount", "TotalCreditAmount",
            "Status", "CreatedAt", "UpdatedAt", "IsReversed", "IdempotencyKey"
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
            FALSE,
            'INVOICE_PAYMENT:' || NEW.id::TEXT  -- Idempotency key
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
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- FIX 6: Add overpayment prevention trigger on invoice_payments
-- ============================================================================

CREATE OR REPLACE FUNCTION fn_prevent_invoice_overpayment()
RETURNS TRIGGER AS $$
DECLARE
    v_outstanding NUMERIC(15,2);
    v_invoice_number TEXT;
BEGIN
    -- Get current outstanding balance
    SELECT "OutstandingBalance", "InvoiceNumber" 
    INTO v_outstanding, v_invoice_number
    FROM invoices 
    WHERE "Id" = NEW.invoice_id;
    
    IF v_outstanding IS NULL THEN
        RAISE EXCEPTION 'Invoice not found: %', NEW.invoice_id;
    END IF;
    
    -- Check if payment exceeds outstanding balance
    IF NEW.amount > v_outstanding THEN
        RAISE EXCEPTION 'Payment amount % exceeds outstanding balance % for invoice %',
            NEW.amount, v_outstanding, v_invoice_number;
    END IF;
    
    -- Check if invoice is already fully paid
    IF v_outstanding <= 0 THEN
        RAISE EXCEPTION 'Invoice % is already fully paid', v_invoice_number;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop if exists and recreate
DROP TRIGGER IF EXISTS trg_prevent_invoice_overpayment ON invoice_payments;

CREATE TRIGGER trg_prevent_invoice_overpayment
    BEFORE INSERT ON invoice_payments
    FOR EACH ROW
    EXECUTE FUNCTION fn_prevent_invoice_overpayment();

-- ============================================================================
-- FIX 7: Add idempotency check to customer deposit GL posting
-- ============================================================================

CREATE OR REPLACE FUNCTION fn_post_customer_deposit_to_ledger()
RETURNS TRIGGER AS $$
DECLARE
    v_transaction_id UUID;
    v_transaction_number TEXT;
    v_cash_account_id UUID;
    v_deposit_account_id UUID;
    v_customer_name TEXT;
    v_existing_transaction UUID;
BEGIN
    IF TG_OP = 'INSERT' THEN
        -- IDEMPOTENCY CHECK
        SELECT "Id" INTO v_existing_transaction
        FROM ledger_transactions
        WHERE "ReferenceType" = 'CUSTOMER_DEPOSIT' AND "ReferenceId" = NEW.id
        LIMIT 1;
        
        IF v_existing_transaction IS NOT NULL THEN
            RAISE NOTICE 'Customer deposit % already posted to GL, skipping', NEW.deposit_number;
            RETURN NEW;
        END IF;
        
        -- Get customer name
        SELECT name INTO v_customer_name FROM customers WHERE id = NEW.customer_id;
        
        -- Get account IDs
        SELECT "Id" INTO v_cash_account_id FROM accounts WHERE "AccountCode" = '1010';
        SELECT "Id" INTO v_deposit_account_id FROM accounts WHERE "AccountCode" = '2200';
        
        IF v_cash_account_id IS NULL OR v_deposit_account_id IS NULL THEN
            RAISE EXCEPTION 'GL accounts not found for deposit posting';
        END IF;
        
        -- Generate transaction number
        v_transaction_number := 'LT-' || TO_CHAR(CURRENT_DATE, 'YYYY') || '-' || 
                                LPAD((SELECT COALESCE(MAX(CAST(SUBSTRING("TransactionNumber" FROM '[0-9]+$') AS INTEGER)), 0) + 1 
                                      FROM ledger_transactions)::TEXT, 6, '0');
        v_transaction_id := gen_random_uuid();
        
        -- Create ledger transaction with idempotency key
        INSERT INTO ledger_transactions (
            "Id", "TransactionNumber", "TransactionDate", "ReferenceType", "ReferenceId",
            "ReferenceNumber", "Description", "TotalDebitAmount", "TotalCreditAmount",
            "Status", "CreatedAt", "UpdatedAt", "IsReversed", "IdempotencyKey"
        ) VALUES (
            v_transaction_id,
            v_transaction_number,
            CURRENT_TIMESTAMP,
            'CUSTOMER_DEPOSIT',
            NEW.id,
            NEW.deposit_number,
            'Customer Deposit: ' || COALESCE(v_customer_name, 'Unknown') || ' - ' || NEW.deposit_number,
            NEW.amount,
            NEW.amount,
            'POSTED',
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP,
            FALSE,
            'CUSTOMER_DEPOSIT:' || NEW.id::TEXT
        );
        
        -- DR Cash
        INSERT INTO ledger_entries (
            "Id", "TransactionId", "LedgerTransactionId", "AccountId", "EntryType",
            "Amount", "DebitAmount", "CreditAmount", "Description", "LineNumber",
            "EntityType", "EntityId", "EntryDate", "RunningBalance", "CreatedAt"
        ) VALUES (
            gen_random_uuid(), v_transaction_id, v_transaction_id, v_cash_account_id, 'DEBIT',
            NEW.amount, NEW.amount, 0,
            'Deposit received - ' || NEW.deposit_number,
            1, 'CUSTOMER_DEPOSIT', NEW.id::TEXT, CURRENT_TIMESTAMP, 0, CURRENT_TIMESTAMP
        );
        
        -- CR Customer Deposits (liability)
        INSERT INTO ledger_entries (
            "Id", "TransactionId", "LedgerTransactionId", "AccountId", "EntryType",
            "Amount", "DebitAmount", "CreditAmount", "Description", "LineNumber",
            "EntityType", "EntityId", "EntryDate", "RunningBalance", "CreatedAt"
        ) VALUES (
            gen_random_uuid(), v_transaction_id, v_transaction_id, v_deposit_account_id, 'CREDIT',
            NEW.amount, 0, NEW.amount,
            'Customer deposit liability - ' || NEW.deposit_number,
            2, 'CUSTOMER_DEPOSIT', NEW.id::TEXT, CURRENT_TIMESTAMP, 0, CURRENT_TIMESTAMP
        );
        
        RAISE NOTICE 'Posted customer deposit % to ledger as %', NEW.deposit_number, v_transaction_number;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- VERIFICATION QUERIES
-- ============================================================================

SELECT '' as blank;
SELECT '=== VERIFICATION ===' as section;

-- Count triggers on invoice_payments
SELECT 'Invoice payment AFTER INSERT triggers:' as check_name, COUNT(*) as count
FROM information_schema.triggers
WHERE event_object_table = 'invoice_payments'
AND event_manipulation = 'INSERT'
AND action_timing = 'AFTER';

-- Check unique constraint exists
SELECT 'Unique constraint on (ReferenceType, ReferenceId):' as check_name,
       CASE WHEN COUNT(*) > 0 THEN 'EXISTS' ELSE 'MISSING' END as status
FROM pg_constraint
WHERE conname = 'uq_ledger_transactions_reference';

-- Count triggers on ledger_entries
SELECT 'Ledger entry AFTER INSERT triggers:' as check_name, COUNT(*) as count
FROM information_schema.triggers
WHERE event_object_table = 'ledger_entries'
AND event_manipulation = 'INSERT'
AND action_timing = 'AFTER';

COMMIT;

SELECT 'All concurrency and idempotency fixes applied successfully!' as result;
