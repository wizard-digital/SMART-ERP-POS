-- Migration 565: Restaurant Phase 3 — Recipes / BOM (ingredient consumption on sale)
-- Requires 560. AT_SALE recipe ingredients deduct on restaurant KOT (Samba) via
-- restaurantKotStockService; createSale skips when KOT already issued.
-- Retail products without a recipe are unchanged.

CREATE TABLE IF NOT EXISTS product_recipes (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_product_id  UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name               VARCHAR(120) NOT NULL,
  is_active          BOOLEAN NOT NULL DEFAULT TRUE,
  notes              TEXT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_product_recipes_parent UNIQUE (parent_product_id)
);

CREATE INDEX IF NOT EXISTS idx_product_recipes_active
  ON product_recipes (is_active)
  WHERE is_active = TRUE;

COMMENT ON TABLE product_recipes IS
  'Phase 3: one recipe per menu/parent product. Sale of parent consumes recipe lines via FEFO.';

CREATE TABLE IF NOT EXISTS product_recipe_lines (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_id             UUID NOT NULL REFERENCES product_recipes(id) ON DELETE CASCADE,
  component_product_id  UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  quantity_base         NUMERIC(18, 6) NOT NULL CHECK (quantity_base > 0),
  sort_order            INTEGER NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_product_recipe_lines_component UNIQUE (recipe_id, component_product_id)
);

CREATE INDEX IF NOT EXISTS idx_product_recipe_lines_recipe
  ON product_recipe_lines (recipe_id, sort_order);

CREATE INDEX IF NOT EXISTS idx_product_recipe_lines_component
  ON product_recipe_lines (component_product_id);

COMMENT ON COLUMN product_recipe_lines.quantity_base IS
  'Ingredient qty in component base UoM consumed per 1 parent base unit sold';
