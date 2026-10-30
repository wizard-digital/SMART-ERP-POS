-- ============================================================================
-- COMPREHENSIVE DATABASE TRIGGERS FOR DATA CONSISTENCY
-- ============================================================================
-- All business data is calculated and maintained at the DATABASE level.
-- Frontend NEVER calculates - it only displays what the database provides.
-- ============================================================================

-- ============================================================================
-- 0. UTILITY FUNCTIONS
-- ============================================================================

-- Generate unique movement number for stock_movements (SM-YYYY-######)
CREATE OR REPLACE FUNCTION generate_movement_number()
RETURNS VARCHAR AS $$
DECLARE
    v_sequence INT;
    v_prefix VARCHAR := 'SM';
    v_year VARCHAR := TO_CHAR(CURRENT_DATE, 'YYYY');
BEGIN
    -- Get next sequence number for this year
    SELECT COALESCE(MAX(
        CASE 
            WHEN movement_number LIKE 'SM-' || v_year || '-%' THEN
                NULLIF(REGEXP_REPLACE(SUBSTRING(movement_number FROM 9), '[^0-9]', '', 'g'), '')::INT
            ELSE 0
        END
    ), 0) + 1
    INTO v_sequence
    FROM stock_movements;
    
    RETURN v_prefix || '-' || v_year || '-' || LPAD(v_sequence::TEXT, 6, '0');
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- 1. CUSTOMER BALANCE TRIGGERS
-- Customer balance is ALWAYS calculated from their transactions
-- ============================================================================

-- Function to recalculate customer balance from all sources
-- NOTE: customer_payments uses PascalCase columns ("CustomerId")
--       sales uses snake_case columns (customer_id)
CREATE OR REPLACE FUNCTION fn_recalculate_customer_balance()
RETURNS TRIGGER AS $$
DECLARE
    v_customer_id UUID;
BEGIN
    -- Determine which customer to update
    IF TG_TABLE_NAME = 'sales' THEN
        -- sales table uses snake_case
        IF TG_OP = 'DELETE' THEN
            v_customer_id := OLD.customer_id;
        ELSE
            v_customer_id := NEW.customer_id;
            -- Also handle customer change
            IF TG_OP = 'UPDATE' AND OLD.customer_id IS DISTINCT FROM NEW.customer_id AND OLD.customer_id IS NOT NULL THEN
                PERFORM fn_update_customer_balance_internal(OLD.customer_id);
            END IF;
        END IF;
    ELSIF TG_TABLE_NAME = 'customer_payments' THEN
        -- customer_payments uses PascalCase: "CustomerId"
        IF TG_OP = 'DELETE' THEN
            v_customer_id := OLD."CustomerId";
        ELSE
            v_customer_id := NEW."CustomerId";
        END IF;
    ELSIF TG_TABLE_NAME = 'credit_notes' THEN
        IF TG_OP = 'DELETE' THEN
            v_customer_id := OLD.customer_id;
        ELSE
            v_customer_id := NEW.customer_id;
        END IF;
    END IF;
    
    IF v_customer_id IS NOT NULL THEN
        PERFORM fn_update_customer_balance_internal(v_customer_id);
    END IF;
    
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    ELSE
        RETURN NEW;
    END IF;
    -- FIXED: Removed EXCEPTION WHEN OTHERS - errors must propagate
END;
$$ LANGUAGE plpgsql;

-- Internal function to update a single customer's balance
-- NOTE: customer_payments uses PascalCase ("Amount", "CustomerId", "Status")
--       sales uses snake_case (customer_id, payment_method, status)
CREATE OR REPLACE FUNCTION fn_update_customer_balance_internal(p_customer_id UUID)
RETURNS VOID AS $$
DECLARE
    v_total_credit_sales NUMERIC;
    v_total_payments NUMERIC;
    v_new_balance NUMERIC;
BEGIN
    -- Sum all CREDIT sales (unpaid portion) - sales table uses snake_case
    SELECT COALESCE(SUM(
        CASE 
            WHEN payment_method = 'CREDIT' AND status = 'COMPLETED' 
            THEN total_amount - COALESCE(amount_paid, 0)
            ELSE 0 
        END
    ), 0)
    INTO v_total_credit_sales
    FROM sales
    WHERE customer_id = p_customer_id;
    
    -- Sum all customer payments applied to AR
    -- customer_payments uses PascalCase: "Amount", "CustomerId", "Status"
    SELECT COALESCE(SUM("Amount"), 0)
    INTO v_total_payments
    FROM customer_payments
    WHERE "CustomerId" = p_customer_id
      AND "Status" = 'COMPLETED';
    
    -- Balance = Credit Sales - Payments received
    v_new_balance := v_total_credit_sales - v_total_payments;
    
    -- Update customer balance (customers table uses snake_case)
    UPDATE customers
    SET balance = v_new_balance,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = p_customer_id;
    
    RAISE NOTICE 'Updated customer % balance to %', p_customer_id, v_new_balance;
    -- FIXED: Removed EXCEPTION WHEN OTHERS - errors must propagate
END;
$$ LANGUAGE plpgsql;

-- Trigger on sales for customer balance
DROP TRIGGER IF EXISTS trg_sync_customer_balance_on_sale ON sales;
CREATE TRIGGER trg_sync_customer_balance_on_sale
    AFTER INSERT OR UPDATE OR DELETE ON sales
    FOR EACH ROW
    EXECUTE FUNCTION fn_recalculate_customer_balance();

-- Trigger on customer_payments for customer balance
DROP TRIGGER IF EXISTS trg_sync_customer_balance_on_payment ON customer_payments;
CREATE TRIGGER trg_sync_customer_balance_on_payment
    AFTER INSERT OR UPDATE OR DELETE ON customer_payments
    FOR EACH ROW
    EXECUTE FUNCTION fn_recalculate_customer_balance();

-- ============================================================================
-- 2. INVENTORY QUANTITY TRIGGERS
-- Product stock quantities are ALWAYS calculated from batch data
-- ============================================================================

CREATE OR REPLACE FUNCTION fn_recalculate_product_stock()
RETURNS TRIGGER AS $$
DECLARE
    v_product_id UUID;
    v_total_quantity NUMERIC;
BEGIN
    -- Determine which product to update
    IF TG_OP = 'DELETE' THEN
        v_product_id := OLD.product_id;
    ELSE
        v_product_id := NEW.product_id;
        -- Also handle product change on UPDATE
        IF TG_OP = 'UPDATE' AND OLD.product_id IS DISTINCT FROM NEW.product_id THEN
            PERFORM fn_update_product_stock_internal(OLD.product_id);
        END IF;
    END IF;
    
    IF v_product_id IS NOT NULL THEN
        PERFORM fn_update_product_stock_internal(v_product_id);
    END IF;
    
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    ELSE
        RETURN NEW;
    END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fn_update_product_stock_internal(p_product_id UUID)
RETURNS VOID AS $$
DECLARE
    v_total_quantity NUMERIC;
BEGIN
    -- Sum all batch quantities for this product
    -- Note: inventory_batches uses 'status' column (enum), not 'is_active'
    SELECT COALESCE(SUM(remaining_quantity), 0)
    INTO v_total_quantity
    FROM inventory_batches
    WHERE product_id = p_product_id
      AND status = 'ACTIVE';
    
    -- Update product stock quantity (column is quantity_on_hand, not stock_quantity)
    UPDATE products
    SET quantity_on_hand = v_total_quantity,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = p_product_id;
    
    RAISE NOTICE 'Updated product % stock to %', p_product_id, v_total_quantity;
    -- FIXED: Removed EXCEPTION WHEN OTHERS - errors must propagate
END;
$$ LANGUAGE plpgsql;

-- Trigger on inventory_batches for product stock
DROP TRIGGER IF EXISTS trg_sync_product_stock_on_batch ON inventory_batches;
CREATE TRIGGER trg_sync_product_stock_on_batch
    AFTER INSERT OR UPDATE OR DELETE ON inventory_batches
    FOR EACH ROW
    EXECUTE FUNCTION fn_recalculate_product_stock();

-- ============================================================================
-- 3. SUPPLIER BALANCE TRIGGERS  
-- Supplier balance = GR value received - payments made
-- ============================================================================

CREATE OR REPLACE FUNCTION fn_recalculate_supplier_balance()
RETURNS TRIGGER AS $$
DECLARE
    v_supplier_id UUID;
BEGIN
    -- Determine which supplier to update
    IF TG_TABLE_NAME = 'goods_receipts' THEN
        IF TG_OP = 'DELETE' THEN
            v_supplier_id := OLD.supplier_id;
        ELSE
            v_supplier_id := NEW.supplier_id;
        END IF;
    ELSIF TG_TABLE_NAME = 'supplier_payments' THEN
        IF TG_OP = 'DELETE' THEN
            v_supplier_id := OLD."SupplierId";
        ELSE
            v_supplier_id := NEW."SupplierId";
        END IF;
    ELSIF TG_TABLE_NAME = 'purchase_orders' THEN
        IF TG_OP = 'DELETE' THEN
            v_supplier_id := OLD.supplier_id;
        ELSE
            v_supplier_id := NEW.supplier_id;
        END IF;
    END IF;
    
    IF v_supplier_id IS NOT NULL THEN
        PERFORM fn_update_supplier_balance_internal(v_supplier_id);
    END IF;
    
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    ELSE
        RETURN NEW;
    END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fn_update_supplier_balance_internal(p_supplier_id UUID)
RETURNS VOID AS $$
DECLARE
    v_total_payable NUMERIC;
    v_total_paid NUMERIC;
    v_new_balance NUMERIC;
BEGIN
    -- Sum all completed GR values
    SELECT COALESCE(SUM(gri.received_quantity * gri.cost_price), 0)
    INTO v_total_payable
    FROM goods_receipts gr
    JOIN goods_receipt_items gri ON gri.goods_receipt_id = gr.id
    WHERE gr.supplier_id = p_supplier_id
      AND gr.status = 'COMPLETED';
    
    -- Sum all supplier payments
    SELECT COALESCE(SUM("Amount"), 0)
    INTO v_total_paid
    FROM supplier_payments
    WHERE "SupplierId" = p_supplier_id
      AND "Status" = 'COMPLETED';
    
    -- Balance = What we owe - What we paid
    v_new_balance := v_total_payable - v_total_paid;
    
    -- Update supplier balance (correct column is "OutstandingBalance")
    UPDATE suppliers
    SET "OutstandingBalance" = v_new_balance,
        "UpdatedAt" = CURRENT_TIMESTAMP
    WHERE "Id" = p_supplier_id;
    
    RAISE NOTICE 'Updated supplier % balance to %', p_supplier_id, v_new_balance;
END;
$$ LANGUAGE plpgsql;

-- Trigger on goods_receipts for supplier balance
DROP TRIGGER IF EXISTS trg_sync_supplier_balance_on_gr ON goods_receipts;
CREATE TRIGGER trg_sync_supplier_balance_on_gr
    AFTER INSERT OR UPDATE OR DELETE ON goods_receipts
    FOR EACH ROW
    EXECUTE FUNCTION fn_recalculate_supplier_balance();

-- Trigger on supplier_payments for supplier balance
DROP TRIGGER IF EXISTS trg_sync_supplier_balance_on_payment ON supplier_payments;
CREATE TRIGGER trg_sync_supplier_balance_on_payment
    AFTER INSERT OR UPDATE OR DELETE ON supplier_payments
    FOR EACH ROW
    EXECUTE FUNCTION fn_recalculate_supplier_balance();

-- ============================================================================
-- 4. SALE TOTALS TRIGGER
-- Sale total, cost, and profit are calculated from sale_items
-- ============================================================================

CREATE OR REPLACE FUNCTION fn_recalculate_sale_totals()
RETURNS TRIGGER AS $$
DECLARE
    v_sale_id UUID;
    v_total_amount NUMERIC;
    v_total_cost NUMERIC;
    v_total_discount NUMERIC;
    v_item_count INTEGER;
BEGIN
    -- Determine which sale to update
    IF TG_OP = 'DELETE' THEN
        v_sale_id := OLD.sale_id;
    ELSE
        v_sale_id := NEW.sale_id;
        -- Handle sale change on UPDATE
        IF TG_OP = 'UPDATE' AND OLD.sale_id IS DISTINCT FROM NEW.sale_id THEN
            PERFORM fn_update_sale_totals_internal(OLD.sale_id);
        END IF;
    END IF;
    
    IF v_sale_id IS NOT NULL THEN
        PERFORM fn_update_sale_totals_internal(v_sale_id);
    END IF;
    
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    ELSE
        RETURN NEW;
    END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fn_update_sale_totals_internal(p_sale_id UUID)
RETURNS VOID AS $$
DECLARE
    v_total_amount NUMERIC;
    v_total_cost NUMERIC;
    v_total_discount NUMERIC;
    v_profit NUMERIC;
    v_profit_margin NUMERIC;
    v_tax_amount NUMERIC;
    v_subtotal NUMERIC;
BEGIN
    -- Get the existing tax_amount from the sale (preserve user input)
    SELECT tax_amount INTO v_tax_amount FROM sales WHERE id = p_sale_id;
    v_tax_amount := COALESCE(v_tax_amount, 0);
    
    -- Calculate totals from sale items (using correct column names)
    -- NOTE: sales table does NOT have item_count or updated_at columns
    SELECT 
        COALESCE(SUM(quantity * unit_price), 0),
        COALESCE(SUM(quantity * COALESCE(unit_cost, 0)), 0),
        COALESCE(SUM(COALESCE(discount_amount, 0)), 0)
    INTO v_subtotal, v_total_cost, v_total_discount
    FROM sale_items
    WHERE sale_id = p_sale_id;
    
    -- Calculate TOTAL including tax: (subtotal - discount) + tax
    v_total_amount := v_subtotal - v_total_discount + v_tax_amount;
    
    -- Calculate profit (EXCLUDING tax - tax is government money, not profit)
    -- Profit = Revenue - Cost, where Revenue = Subtotal - Discount (before tax)
    v_profit := (v_subtotal - v_total_discount) - v_total_cost;
    
    -- Calculate profit margin as decimal ratio (0.25 = 25%), NOT percentage
    -- The profit_margin column is DECIMAL(5,4), so max value is ~9.9999
    -- Margin based on revenue BEFORE tax
    IF (v_subtotal - v_total_discount) > 0 THEN
        v_profit_margin := v_profit / (v_subtotal - v_total_discount);
    ELSE
        v_profit_margin := 0;
    END IF;
    
    -- Update sale record - only columns that exist in the sales table
    UPDATE sales
    SET total_amount = v_total_amount,
        total_cost = v_total_cost,
        profit = v_profit,
        profit_margin = v_profit_margin,
        discount_amount = v_total_discount
    WHERE id = p_sale_id;
    
    RAISE NOTICE 'Updated sale % totals: subtotal=%, tax=%, total=%, cost=%, profit=%', 
        p_sale_id, v_subtotal - v_total_discount, v_tax_amount, v_total_amount, v_total_cost, v_profit;
END;
$$ LANGUAGE plpgsql;

-- trg_sync_sale_totals is forbidden. Application layer (salesService +
-- saleDiscountSsot) is SSOT for sale totals. Recreating this trigger overwrites
-- cart/header discount on the charged total. 407 dropped it; 638 drops it again.
-- This reference file must DROP only — never CREATE.
DROP TRIGGER IF EXISTS trg_sync_sale_totals ON sale_items;

-- ============================================================================
-- 5. PURCHASE ORDER TOTALS TRIGGER
-- PO total is calculated from po_items
-- ============================================================================

CREATE OR REPLACE FUNCTION fn_recalculate_po_totals()
RETURNS TRIGGER AS $$
DECLARE
    v_po_id UUID;
BEGIN
    IF TG_OP = 'DELETE' THEN
        v_po_id := OLD.purchase_order_id;
    ELSE
        v_po_id := NEW.purchase_order_id;
        IF TG_OP = 'UPDATE' AND OLD.purchase_order_id IS DISTINCT FROM NEW.purchase_order_id THEN
            PERFORM fn_update_po_totals_internal(OLD.purchase_order_id);
        END IF;
    END IF;
    
    IF v_po_id IS NOT NULL THEN
        PERFORM fn_update_po_totals_internal(v_po_id);
    END IF;
    
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    ELSE
        RETURN NEW;
    END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fn_update_po_totals_internal(p_po_id UUID)
RETURNS VOID AS $$
DECLARE
    v_total_amount NUMERIC;
    v_item_count INTEGER;
BEGIN
    SELECT 
        COALESCE(SUM(quantity * unit_price), 0),
        COUNT(*)
    INTO v_total_amount, v_item_count
    FROM purchase_order_items
    WHERE purchase_order_id = p_po_id;
    
    UPDATE purchase_orders
    SET total_amount = v_total_amount,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = p_po_id;
    
    RAISE NOTICE 'Updated PO % total to %', p_po_id, v_total_amount;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_po_totals ON purchase_order_items;
CREATE TRIGGER trg_sync_po_totals
    AFTER INSERT OR UPDATE OR DELETE ON purchase_order_items
    FOR EACH ROW
    EXECUTE FUNCTION fn_recalculate_po_totals();

-- ============================================================================
-- 6. GOODS RECEIPT TOTALS TRIGGER
-- GR total is calculated from gr_items
-- ============================================================================

CREATE OR REPLACE FUNCTION fn_recalculate_gr_totals()
RETURNS TRIGGER AS $$
DECLARE
    v_gr_id UUID;
BEGIN
    IF TG_OP = 'DELETE' THEN
        v_gr_id := OLD.goods_receipt_id;
    ELSE
        v_gr_id := NEW.goods_receipt_id;
        IF TG_OP = 'UPDATE' AND OLD.goods_receipt_id IS DISTINCT FROM NEW.goods_receipt_id THEN
            PERFORM fn_update_gr_totals_internal(OLD.goods_receipt_id);
        END IF;
    END IF;
    
    IF v_gr_id IS NOT NULL THEN
        PERFORM fn_update_gr_totals_internal(v_gr_id);
    END IF;
    
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    ELSE
        RETURN NEW;
    END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fn_update_gr_totals_internal(p_gr_id UUID)
RETURNS VOID AS $$
DECLARE
    v_total_value NUMERIC;
    v_item_count INTEGER;
BEGIN
    SELECT 
        COALESCE(SUM(received_quantity * cost_price), 0),
        COUNT(*)
    INTO v_total_value, v_item_count
    FROM goods_receipt_items
    WHERE goods_receipt_id = p_gr_id;
    
    UPDATE goods_receipts
    SET total_value = v_total_value,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = p_gr_id;
    
    RAISE NOTICE 'Updated GR % total to %', p_gr_id, v_total_value;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_gr_totals ON goods_receipt_items;
CREATE TRIGGER trg_sync_gr_totals
    AFTER INSERT OR UPDATE OR DELETE ON goods_receipt_items
    FOR EACH ROW
    EXECUTE FUNCTION fn_recalculate_gr_totals();

-- ============================================================================
-- 7. INVOICE BALANCE TRIGGER
-- Invoice balance = total - payments received
-- ============================================================================

CREATE OR REPLACE FUNCTION fn_recalculate_invoice_balance()
RETURNS TRIGGER AS $$
DECLARE
    v_invoice_id UUID;
BEGIN
    IF TG_OP = 'DELETE' THEN
        v_invoice_id := OLD.invoice_id;
    ELSE
        v_invoice_id := NEW.invoice_id;
    END IF;
    
    IF v_invoice_id IS NOT NULL THEN
        PERFORM fn_update_invoice_balance_internal(v_invoice_id);
    END IF;
    
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    ELSE
        RETURN NEW;
    END IF;
END;
$$ LANGUAGE plpgsql;

-- NOTE: invoices uses PascalCase ("TotalAmount", "AmountPaid", "OutstandingBalance", "Status")
--       invoice_payments uses snake_case (amount, invoice_id)
CREATE OR REPLACE FUNCTION fn_update_invoice_balance_internal(p_invoice_id UUID)
RETURNS VOID AS $$
DECLARE
    v_total_amount NUMERIC;
    v_total_paid NUMERIC;
    v_balance NUMERIC;
    v_new_status TEXT;
BEGIN
    -- Get invoice total (invoices table has PascalCase columns)
    SELECT COALESCE("TotalAmount", 0)
    INTO v_total_amount
    FROM invoices
    WHERE "Id" = p_invoice_id;
    
    -- Sum payments for this invoice (invoice_payments has lowercase columns)
    SELECT COALESCE(SUM(amount), 0)
    INTO v_total_paid
    FROM invoice_payments
    WHERE invoice_id = p_invoice_id;
    
    v_balance := v_total_amount - v_total_paid;
    
    -- Determine status (invoices table uses: Paid, PartiallyPaid, Unpaid)
    IF v_balance <= 0 THEN
        v_new_status := 'Paid';
    ELSIF v_total_paid > 0 THEN
        v_new_status := 'PartiallyPaid';
    ELSE
        v_new_status := 'Unpaid';
    END IF;
    
    -- Update invoice (use OutstandingBalance not BalanceDue)
    UPDATE invoices
    SET "AmountPaid" = v_total_paid,
        "OutstandingBalance" = GREATEST(v_balance, 0),
        "Status" = v_new_status,
        "UpdatedAt" = CURRENT_TIMESTAMP
    WHERE "Id" = p_invoice_id;
    
    RAISE NOTICE 'Updated invoice % balance to %, status=%', p_invoice_id, v_balance, v_new_status;
    -- FIXED: Removed EXCEPTION WHEN OTHERS - errors must propagate
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_invoice_balance ON invoice_payments;
CREATE TRIGGER trg_sync_invoice_balance
    AFTER INSERT OR UPDATE OR DELETE ON invoice_payments
    FOR EACH ROW
    EXECUTE FUNCTION fn_recalculate_invoice_balance();

-- ============================================================================
-- 8. STOCK MOVEMENT AUDIT TRIGGER
-- Automatically log all stock movements
-- ============================================================================

CREATE OR REPLACE FUNCTION fn_log_stock_movement()
RETURNS TRIGGER AS $$
DECLARE
    v_movement_type movement_type;  -- Use actual enum type, not TEXT
    v_quantity_change NUMERIC;
    v_reference_type TEXT;
    v_reference_id UUID;
    v_movement_number VARCHAR;  -- Required NOT NULL field
BEGIN
    -- GUARD: Skip if the application is already handling stock movements.
    -- App code (StockMovementHandler, salesService, inventoryRepository) creates
    -- proper MOV- stock_movements alongside batch updates. Without this guard,
    -- the trigger creates duplicate SM- movements that also get GL-posted via
    -- trg_post_stock_movement_to_ledger, causing double ledger entries.
    IF current_setting('app.skip_stock_movement_trigger', true) = 'true' THEN
        IF TG_OP = 'DELETE' THEN
            RETURN OLD;
        ELSE
            RETURN NEW;
        END IF;
    END IF;

    -- Skip if no actual change in quantity
    IF TG_OP = 'UPDATE' AND NEW.remaining_quantity = OLD.remaining_quantity THEN
        RETURN NEW;
    END IF;
    
    -- Generate movement number (SM-YYYY-######)
    v_movement_number := generate_movement_number();
    
    -- Determine movement type and quantity
    -- movement_type enum values: GOODS_RECEIPT, SALE, ADJUSTMENT_IN, ADJUSTMENT_OUT, TRANSFER_IN, TRANSFER_OUT, RETURN, DAMAGE, EXPIRY
    IF TG_OP = 'INSERT' THEN
        v_movement_type := 'GOODS_RECEIPT'::movement_type;
        v_quantity_change := NEW.remaining_quantity;
        v_reference_type := COALESCE(NEW.source_type, 'GOODS_RECEIPT');
        v_reference_id := NEW.source_reference_id;
    ELSIF TG_OP = 'UPDATE' THEN
        v_quantity_change := NEW.remaining_quantity - OLD.remaining_quantity;
        IF v_quantity_change > 0 THEN
            v_movement_type := 'ADJUSTMENT_IN'::movement_type;
        ELSIF v_quantity_change < 0 THEN
            v_movement_type := 'ADJUSTMENT_OUT'::movement_type;
        ELSE
            RETURN NEW; -- No change, skip logging
        END IF;
        v_reference_type := COALESCE(NEW.source_type, 'ADJUSTMENT');
        v_reference_id := NEW.source_reference_id;
    ELSIF TG_OP = 'DELETE' THEN
        v_movement_type := 'DAMAGE'::movement_type;
        v_quantity_change := OLD.remaining_quantity;
        v_reference_type := 'BATCH_DELETE';
        v_reference_id := OLD.id;
    END IF;
    
    -- Insert stock movement record WITH movement_number (required NOT NULL field)
    INSERT INTO stock_movements (
        id, movement_number, product_id, batch_id, movement_type, quantity,
        reference_type, reference_id, unit_cost, notes, created_by_id, created_at
    ) VALUES (
        gen_random_uuid(),
        v_movement_number,
        CASE WHEN TG_OP = 'DELETE' THEN OLD.product_id ELSE NEW.product_id END,
        CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END,
        v_movement_type,
        v_quantity_change,
        v_reference_type,
        v_reference_id,
        CASE WHEN TG_OP = 'DELETE' THEN OLD.cost_price ELSE NEW.cost_price END,
        CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.notes END,
        COALESCE(current_setting('app.current_user_id', true)::UUID, NULL),
        CURRENT_TIMESTAMP
    );
    
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    ELSE
        RETURN NEW;
    END IF;
EXCEPTION
    WHEN undefined_table THEN
        -- stock_movements table doesn't exist, skip logging (acceptable)
        IF TG_OP = 'DELETE' THEN
            RETURN OLD;
        ELSE
            RETURN NEW;
        END IF;
    -- FIXED: Removed WHEN OTHERS - only undefined_table is acceptable
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_log_stock_movement ON inventory_batches;
CREATE TRIGGER trg_log_stock_movement
    AFTER INSERT OR UPDATE OR DELETE ON inventory_batches
    FOR EACH ROW
    EXECUTE FUNCTION fn_log_stock_movement();

-- ============================================================================
-- 9. EXPENSE TOTALS BY CATEGORY (for dashboard)
-- Materialized view refreshed by trigger
-- ============================================================================

-- Create or replace materialized view for expense summaries
DROP MATERIALIZED VIEW IF EXISTS mv_expense_summary;
CREATE MATERIALIZED VIEW mv_expense_summary AS
SELECT 
    ec.id as category_id,
    ec.name as category_name,
    DATE_TRUNC('month', e.expense_date) as month,
    COUNT(*) as expense_count,
    SUM(e.amount) as total_amount
FROM expenses e
JOIN expense_categories ec ON e.category_id = ec.id
WHERE e.status = 'APPROVED'
GROUP BY ec.id, ec.name, DATE_TRUNC('month', e.expense_date);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_expense_summary 
ON mv_expense_summary (category_id, month);

-- Function to refresh materialized view
CREATE OR REPLACE FUNCTION fn_refresh_expense_summary()
RETURNS TRIGGER AS $$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_expense_summary;
    RETURN NULL;
EXCEPTION
    WHEN OTHERS THEN
        -- If concurrent refresh fails, do regular refresh (acceptable fallback)
        BEGIN
            REFRESH MATERIALIZED VIEW mv_expense_summary;
        EXCEPTION WHEN OTHERS THEN
            RAISE WARNING 'Expense summary refresh failed: % - dashboard may be stale', SQLERRM;
        END;
        RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Trigger to refresh on expense changes (deferred to avoid blocking)
DROP TRIGGER IF EXISTS trg_refresh_expense_summary ON expenses;
-- Note: For better performance, consider refreshing this via scheduled job instead

-- ============================================================================
-- 10. DAILY SALES SUMMARY (for dashboard)
-- ============================================================================

DROP MATERIALIZED VIEW IF EXISTS mv_daily_sales_summary;
CREATE MATERIALIZED VIEW mv_daily_sales_summary AS
SELECT 
    DATE(sale_date) as sale_day,
    COUNT(*) as transaction_count,
    SUM(total_amount) as total_revenue,
    SUM(total_cost) as total_cost,
    SUM(profit) as total_profit,
    AVG(total_amount) as avg_transaction,
    COUNT(DISTINCT customer_id) as unique_customers
FROM sales
WHERE status = 'COMPLETED'
GROUP BY DATE(sale_date);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_daily_sales 
ON mv_daily_sales_summary (sale_day);

-- ============================================================================
-- VERIFICATION
-- ============================================================================
SELECT 
    event_object_table as table_name,
    COUNT(*) as trigger_count
FROM information_schema.triggers 
WHERE trigger_schema = 'public'
  AND trigger_name LIKE 'trg_sync%'
GROUP BY event_object_table
ORDER BY event_object_table;

SELECT 'Comprehensive triggers installed successfully!' as status;
