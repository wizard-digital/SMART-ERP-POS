-- ============================================================================
-- Migration: 637_fefo_allocated_cost_column_ssot.sql
-- Fail-closed: every tenant has FEFO / allocated-cost columns.
-- Missing-column drift (ledger copied without DDL) is healed — never left as a special case.
-- ============================================================================

-- batch_status enum (001) — required before inventory_batches.status
DO $$ BEGIN
  CREATE TYPE batch_status AS ENUM ('ACTIVE', 'DEPLETED', 'EXPIRED', 'QUARANTINED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- costing_method enum — required by product_valuation
DO $$ BEGIN
  CREATE TYPE costing_method AS ENUM ('FIFO', 'AVCO', 'STANDARD');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- 052 pharmacy FEFO threshold + bonus markers
ALTER TABLE products ADD COLUMN IF NOT EXISTS generic_name VARCHAR(255);
ALTER TABLE products ADD COLUMN IF NOT EXISTS min_days_before_expiry_sale INTEGER NOT NULL DEFAULT 0;

ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS status batch_status DEFAULT 'ACTIVE';
ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS received_date TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS is_bonus BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'goods_receipt_items'
  ) THEN
    ALTER TABLE goods_receipt_items ADD COLUMN IF NOT EXISTS is_bonus BOOLEAN NOT NULL DEFAULT false;
  END IF;
END $$;

-- 410 valuation partition (CREATE IF NOT EXISTS — does not drop/move legacy products columns)
CREATE TABLE IF NOT EXISTS product_valuation (
    product_id       UUID PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
    cost_price       DECIMAL(15, 2)  NOT NULL DEFAULT 0.00,
    selling_price    DECIMAL(15, 2)  NOT NULL DEFAULT 0.00,
    costing_method   costing_method  NOT NULL DEFAULT 'FIFO',
    average_cost     DECIMAL(15, 2)  NOT NULL DEFAULT 0.00,
    last_cost        DECIMAL(15, 2)  NOT NULL DEFAULT 0.00,
    pricing_formula  TEXT,
    auto_update_price BOOLEAN        NOT NULL DEFAULT false,
    updated_at       TIMESTAMPTZ     NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE product_valuation ADD COLUMN IF NOT EXISTS cost_price DECIMAL(15, 2) NOT NULL DEFAULT 0.00;
ALTER TABLE product_valuation ADD COLUMN IF NOT EXISTS selling_price DECIMAL(15, 2) NOT NULL DEFAULT 0.00;
ALTER TABLE product_valuation ADD COLUMN IF NOT EXISTS average_cost DECIMAL(15, 2) NOT NULL DEFAULT 0.00;
ALTER TABLE product_valuation ADD COLUMN IF NOT EXISTS costing_method costing_method NOT NULL DEFAULT 'FIFO';

CREATE INDEX IF NOT EXISTS idx_batches_status ON inventory_batches(status);
CREATE INDEX IF NOT EXISTS idx_products_generic_name ON products(generic_name);

CREATE TABLE IF NOT EXISTS schema_version (
  version INT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO schema_version (version)
SELECT 637 WHERE NOT EXISTS (SELECT 1 FROM schema_version WHERE version = 637);
