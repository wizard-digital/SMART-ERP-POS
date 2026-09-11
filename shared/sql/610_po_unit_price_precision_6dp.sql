-- Migration 610: PO unit_price must keep up to 6dp so line-total-led costs survive.
-- Bug: 7000/24 = 291.666667 → NUMERIC(15,2) stores 291.67 → PE line becomes 7000.08.
-- total_price stays 2dp (money). unit_price needs 6dp so PE(qty×unit) can equal the entered total.

ALTER TABLE purchase_order_items
  ALTER COLUMN unit_price TYPE NUMERIC(18, 6)
  USING ROUND(unit_price::numeric, 6);

COMMENT ON COLUMN purchase_order_items.unit_price IS
  'Unit cost up to 6dp so PricingEngine(qty×unit) can match an entered 2dp line total (e.g. 7000÷24).';

INSERT INTO schema_version (version) VALUES (610) ON CONFLICT DO NOTHING;
