-- ============================================================================
-- CUSTOMER TRANSACTION CONSISTENCY & ACCURACY
-- ============================================================================
-- This script ensures ALL customer financial data is consistent:
-- 1. Customer deposits → GL Account 2200 (Customer Deposits Liability)
-- 2. Customer invoices (AR) → GL Account 1200 (Accounts Receivable)
-- 3. Invoice payments → Reduces AR, increases Cash
-- 4. Customer balances = Outstanding invoice amounts
-- ============================================================================

-- ============================================================================
-- PART 1: RECONCILE AR ACCOUNT TO ACTUAL OUTSTANDING INVOICES
-- ============================================================================

DO $$
DECLARE
    v_expected_ar NUMERIC;
    v_current_ar NUMERIC;
    v_discrepancy NUMERIC;
    v_ar_account_id UUID;
BEGIN
    -- Get expected AR from actual outstanding invoices
    SELECT COALESCE(SUM("OutstandingBalance"), 0) INTO v_expected_ar
    FROM invoices WHERE "Status" NOT IN ('CANCELLED', 'PAID');
    
    -- Get current AR balance
    SELECT "Id", "CurrentBalance" INTO v_ar_account_id, v_current_ar
    FROM accounts WHERE "AccountCode" = '1200';
    
    v_discrepancy := v_current_ar - v_expected_ar;
    
    IF ABS(v_discrepancy) > 0.01 THEN
        RAISE NOTICE 'AR Discrepancy detected: Current=%, Expected=%, Diff=%', 
            v_current_ar, v_expected_ar, v_discrepancy;
        
        -- Correct the AR balance
        UPDATE accounts SET 
            "CurrentBalance" = v_expected_ar,
            "UpdatedAt" = CURRENT_TIMESTAMP
        WHERE "AccountCode" = '1200';
        
        RAISE NOTICE 'AR Account (1200) corrected to: %', v_expected_ar;
    ELSE
        RAISE NOTICE 'AR Account (1200) is accurate: %', v_current_ar;
    END IF;
END;
$$;

-- ============================================================================
-- PART 2: RECONCILE CUSTOMER BALANCES TO OUTSTANDING INVOICES  
-- ============================================================================

DO $$
DECLARE
    v_customer RECORD;
    v_expected_balance NUMERIC;
    v_updated_count INTEGER := 0;
BEGIN
    FOR v_customer IN 
        SELECT c.id, c.name, c.balance as current_balance,
               COALESCE(SUM(i."OutstandingBalance"), 0) as expected_balance
        FROM customers c
        LEFT JOIN invoices i ON i."CustomerId" = c.id 
            AND i."Status" NOT IN ('CANCELLED', 'PAID')
        GROUP BY c.id, c.name, c.balance
        HAVING c.balance != COALESCE(SUM(i."OutstandingBalance"), 0)
    LOOP
        UPDATE customers 
        SET balance = v_customer.expected_balance,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = v_customer.id;
        
        v_updated_count := v_updated_count + 1;
        RAISE NOTICE 'Corrected customer % balance: % → %', 
            v_customer.name, v_customer.current_balance, v_customer.expected_balance;
    END LOOP;
    
    IF v_updated_count = 0 THEN
        RAISE NOTICE 'All customer balances are accurate';
    ELSE
        RAISE NOTICE 'Corrected % customer balances', v_updated_count;
    END IF;
END;
$$;

-- ============================================================================
-- PART 3: COMPREHENSIVE INVOICE/AR TRIGGER (Single Source of Truth)
-- ============================================================================

-- Function to sync AR and customer balance when invoice changes
CREATE OR REPLACE FUNCTION fn_sync_invoice_ar_balance()
RETURNS TRIGGER AS $$
DECLARE
    v_ar_account_id UUID;
    v_old_outstanding NUMERIC := 0;
    v_new_outstanding NUMERIC := 0;
    v_delta NUMERIC;
BEGIN
    -- Get AR account ID
    SELECT "Id" INTO v_ar_account_id FROM accounts WHERE "AccountCode" = '1200';
    
    IF TG_OP = 'UPDATE' THEN
        v_old_outstanding := COALESCE(OLD."OutstandingBalance", 0);
        v_new_outstanding := COALESCE(NEW."OutstandingBalance", 0);
        v_delta := v_new_outstanding - v_old_outstanding;
        
        -- Only update if there's a change and not cancelled
        IF ABS(v_delta) > 0.001 AND NEW."Status" != 'CANCELLED' THEN
            -- Update AR account
            UPDATE accounts 
            SET "CurrentBalance" = "CurrentBalance" + v_delta,
                "UpdatedAt" = CURRENT_TIMESTAMP
            WHERE "Id" = v_ar_account_id;
            
            -- Update customer balance
            UPDATE customers 
            SET balance = balance + v_delta,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = NEW."CustomerId";
            
            RAISE NOTICE 'Invoice % AR updated: delta=%', NEW."InvoiceNumber", v_delta;
        END IF;
        
        -- Handle cancellation
        IF NEW."Status" = 'CANCELLED' AND OLD."Status" != 'CANCELLED' THEN
            -- Reverse the outstanding from AR
            UPDATE accounts 
            SET "CurrentBalance" = "CurrentBalance" - v_old_outstanding,
                "UpdatedAt" = CURRENT_TIMESTAMP
            WHERE "Id" = v_ar_account_id;
            
            -- Reduce customer balance
            UPDATE customers 
            SET balance = balance - v_old_outstanding,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = NEW."CustomerId";
            
            RAISE NOTICE 'Invoice % cancelled, reversed AR: %', NEW."InvoiceNumber", v_old_outstanding;
        END IF;
        
    ELSIF TG_OP = 'INSERT' THEN
        v_new_outstanding := COALESCE(NEW."OutstandingBalance", NEW."TotalAmount");
        
        IF NEW."Status" NOT IN ('CANCELLED', 'PAID') THEN
            -- Add to AR account
            UPDATE accounts 
            SET "CurrentBalance" = "CurrentBalance" + v_new_outstanding,
                "UpdatedAt" = CURRENT_TIMESTAMP
            WHERE "Id" = v_ar_account_id;
            
            -- Add to customer balance
            UPDATE customers 
            SET balance = balance + v_new_outstanding,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = NEW."CustomerId";
            
            RAISE NOTICE 'New invoice % added to AR: %', NEW."InvoiceNumber", v_new_outstanding;
        END IF;
    END IF;
    
    RETURN NEW;
    -- FIXED: Removed EXCEPTION WHEN OTHERS - AR sync failures MUST abort transaction
END;
$$ LANGUAGE plpgsql;

-- Drop existing trigger if any
DROP TRIGGER IF EXISTS trg_sync_invoice_ar_balance ON invoices;

-- Create new trigger (AFTER to ensure all updates complete first)
CREATE TRIGGER trg_sync_invoice_ar_balance
    AFTER INSERT OR UPDATE ON invoices
    FOR EACH ROW
    EXECUTE FUNCTION fn_sync_invoice_ar_balance();

-- ============================================================================
-- PART 4: INVOICE PAYMENT TRIGGER (Syncs payment to AR and Cash)
-- ============================================================================

CREATE OR REPLACE FUNCTION fn_sync_invoice_payment()
RETURNS TRIGGER AS $$
DECLARE
    v_ar_account_id UUID;
    v_cash_account_id UUID;
    v_invoice RECORD;
    v_transaction_id UUID;
    v_transaction_number TEXT;
BEGIN
    IF TG_OP = 'INSERT' THEN
        -- Get account IDs
        SELECT "Id" INTO v_ar_account_id FROM accounts WHERE "AccountCode" = '1200';
        SELECT "Id" INTO v_cash_account_id FROM accounts WHERE "AccountCode" = '1010';
        
        -- Get invoice details
        SELECT "InvoiceNumber", "CustomerId" INTO v_invoice
        FROM invoices WHERE "Id" = NEW.invoice_id;
        
        -- Update invoice paid amount and outstanding
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
        
        -- Update GL accounts
        -- DR Cash (increase)
        UPDATE accounts 
        SET "CurrentBalance" = "CurrentBalance" + NEW.amount,
            "UpdatedAt" = CURRENT_TIMESTAMP
        WHERE "Id" = v_cash_account_id;
        
        -- CR AR (decrease)
        UPDATE accounts 
        SET "CurrentBalance" = "CurrentBalance" - NEW.amount,
            "UpdatedAt" = CURRENT_TIMESTAMP
        WHERE "Id" = v_ar_account_id;
        
        -- Create GL transaction
        v_transaction_number := 'LT-' || TO_CHAR(CURRENT_DATE, 'YYYY') || '-' || 
                                LPAD((SELECT COALESCE(MAX(CAST(SUBSTRING("TransactionNumber" FROM '[0-9]+$') AS INTEGER)), 0) + 1 
                                      FROM ledger_transactions)::TEXT, 6, '0');
        v_transaction_id := gen_random_uuid();
        
        INSERT INTO ledger_transactions (
            "Id", "TransactionNumber", "TransactionDate", "ReferenceType", "ReferenceId",
            "ReferenceNumber", "Description", "TotalDebitAmount", "TotalCreditAmount",
            "Status", "CreatedAt", "UpdatedAt", "IsReversed"
        ) VALUES (
            v_transaction_id, v_transaction_number, CURRENT_TIMESTAMP,
            'INVOICE_PAYMENT', NEW.id, NEW.receipt_number,
            'Invoice Payment: ' || COALESCE(v_invoice."InvoiceNumber", 'Unknown'),
            NEW.amount, NEW.amount, 'POSTED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, FALSE
        );
        
        -- DR Cash
        INSERT INTO ledger_entries (
            "Id", "TransactionId", "LedgerTransactionId", "AccountId", "EntryType",
            "Amount", "DebitAmount", "CreditAmount", "Description", "LineNumber",
            "EntityType", "EntityId", "EntryDate", "RunningBalance", "CreatedAt"
        ) VALUES (
            gen_random_uuid(), v_transaction_id, v_transaction_id, v_cash_account_id, 'DEBIT',
            NEW.amount, NEW.amount, 0, 'Payment received - ' || COALESCE(v_invoice."InvoiceNumber", ''),
            1, 'INVOICE_PAYMENT', NEW.id::TEXT, CURRENT_TIMESTAMP, 0, CURRENT_TIMESTAMP
        );
        
        -- CR AR
        INSERT INTO ledger_entries (
            "Id", "TransactionId", "LedgerTransactionId", "AccountId", "EntryType",
            "Amount", "DebitAmount", "CreditAmount", "Description", "LineNumber",
            "EntityType", "EntityId", "EntryDate", "RunningBalance", "CreatedAt"
        ) VALUES (
            gen_random_uuid(), v_transaction_id, v_transaction_id, v_ar_account_id, 'CREDIT',
            NEW.amount, 0, NEW.amount, 'AR reduction - ' || COALESCE(v_invoice."InvoiceNumber", ''),
            2, 'INVOICE_PAYMENT', NEW.id::TEXT, CURRENT_TIMESTAMP, 0, CURRENT_TIMESTAMP
        );
        
        RAISE NOTICE 'Invoice payment % recorded: amount=%, receipt=%', 
            NEW.id, NEW.amount, NEW.receipt_number;
    END IF;
    
    RETURN NEW;
    -- FIXED: Removed EXCEPTION WHEN OTHERS - payment sync failures MUST abort transaction
END;
$$ LANGUAGE plpgsql;

-- DROP-only: never re-CREATE trg_sync_invoice_payment (646 / chk_sales_credit_has_debt).
-- Linked-sale tender sync is service-layer SSOT (invoiceRepository.syncLinkedSaleFromInvoice).
DROP TRIGGER IF EXISTS trg_sync_invoice_payment ON invoice_payments;
DROP FUNCTION IF EXISTS sync_invoice_payment_to_sales_and_customer() CASCADE;

-- ============================================================================
-- PART 5: VERIFY FINAL CONSISTENCY
-- ============================================================================

SELECT '=== CUSTOMER TRANSACTION CONSISTENCY REPORT ===' AS header;

SELECT 'Customer Deposits' as category, 
       'pos_customer_deposits' as source,
       COUNT(*) as records,
       SUM(amount) as total,
       SUM(amount_available) as available
FROM pos_customer_deposits WHERE status IN ('ACTIVE', 'DEPLETED')
UNION ALL
SELECT 'Deposit GL (2200)', 'accounts', 1, "CurrentBalance", "CurrentBalance"
FROM accounts WHERE "AccountCode" = '2200';

SELECT '---' as separator;

SELECT 'Outstanding Invoices' as category,
       'invoices' as source, 
       COUNT(*) as records,
       SUM("OutstandingBalance") as total,
       0 as extra
FROM invoices WHERE "Status" NOT IN ('CANCELLED', 'PAID')
UNION ALL
SELECT 'AR GL (1200)', 'accounts', 1, "CurrentBalance", 0
FROM accounts WHERE "AccountCode" = '1200'
UNION ALL
SELECT 'Customer Balances Sum', 'customers', COUNT(*), SUM(balance), 0
FROM customers WHERE balance > 0;

SELECT '=== INDIVIDUAL CUSTOMER BALANCES ===' AS header;

SELECT c.name as customer,
       c.balance as customer_balance,
       COALESCE(SUM(i."OutstandingBalance"), 0) as invoice_outstanding,
       COALESCE(SUM(d.amount_available), 0) as deposit_available,
       CASE WHEN c.balance = COALESCE(SUM(i."OutstandingBalance"), 0) 
            THEN '✓ OK' ELSE '✗ MISMATCH' END as status
FROM customers c
LEFT JOIN invoices i ON i."CustomerId" = c.id AND i."Status" NOT IN ('CANCELLED', 'PAID')
LEFT JOIN pos_customer_deposits d ON d.customer_id = c.id AND d.status = 'ACTIVE'
GROUP BY c.id, c.name, c.balance
HAVING c.balance > 0 OR COALESCE(SUM(i."OutstandingBalance"), 0) > 0 OR COALESCE(SUM(d.amount_available), 0) > 0
ORDER BY c.name;

SELECT 'CUSTOMER TRANSACTION TRIGGERS INSTALLED' AS status;
