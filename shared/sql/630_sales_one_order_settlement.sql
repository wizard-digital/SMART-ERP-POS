-- One completed sale per POS order.
-- Concurrent terminals can race the application check; the unique index is the last line.
-- Existing duplicates must be resolved before this index is applied.

CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_one_settlement_per_order
  ON sales (from_order_id)
  WHERE from_order_id IS NOT NULL;
