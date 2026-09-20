-- Migration 618: Product category name SSOT — case-insensitive unique names
--
-- Problem: product_categories.name had only a case-sensitive UNIQUE, so
-- "Beverages" / "beverages" / " Beverages " could coexist and break pricing,
-- restaurant menu links, and inventory filters.
--
-- Order matters: drop case-sensitive unique BEFORE normalize/merge, otherwise
-- TRIM collisions abort the transaction under product_categories_name_key.

BEGIN;

-- 1. Drop case-sensitive unique / name indexes so heal can rewrite rows
ALTER TABLE product_categories DROP CONSTRAINT IF EXISTS product_categories_name_key;
DROP INDEX IF EXISTS product_categories_name_key;
DROP INDEX IF EXISTS idx_product_categories_name;

-- 2. Normalize whitespace
UPDATE product_categories
SET name = TRIM(BOTH FROM regexp_replace(name, '\s+', ' ', 'g')),
    updated_at = NOW()
WHERE name IS DISTINCT FROM TRIM(BOTH FROM regexp_replace(name, '\s+', ' ', 'g'));

-- 3. Merge case-insensitive duplicates into the oldest row
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    WITH ranked AS (
      SELECT
        id,
        name,
        LOWER(TRIM(name)) AS name_key,
        ROW_NUMBER() OVER (
          PARTITION BY LOWER(TRIM(name))
          ORDER BY created_at ASC NULLS LAST, id ASC
        ) AS rn
      FROM product_categories
    )
    SELECT
      d.id AS source_id,
      s.id AS target_id,
      s.name AS target_name
    FROM ranked d
    INNER JOIN ranked s
      ON s.name_key = d.name_key
     AND s.rn = 1
    WHERE d.rn > 1
  LOOP
    UPDATE products
    SET category_id = r.target_id,
        category = r.target_name
    WHERE category_id = r.source_id;

    UPDATE products
    SET category_id = r.target_id,
        category = r.target_name
    WHERE category_id IS NULL
      AND LOWER(TRIM(COALESCE(category, ''))) = LOWER(TRIM(r.target_name))
      AND TRIM(COALESCE(category, '')) <> '';

    UPDATE price_rules
    SET category_id = r.target_id
    WHERE category_id = r.source_id;

    -- Retire duplicate row (rename + deactivate) so the CI unique index can apply.
    -- Avoid hard row removal in migration SQL (hook flags destructive DML).
    UPDATE product_categories
    SET is_active = FALSE,
        name = LEFT(TRIM(name), 200) || ' (merged ' || substr(id::text, 1, 8) || ')',
        updated_at = NOW()
    WHERE id = r.source_id;
  END LOOP;
END $$;

-- 4. SSOT: one category per case-insensitive trimmed name
CREATE UNIQUE INDEX IF NOT EXISTS uq_product_categories_name_ci
  ON product_categories (LOWER(TRIM(name)));

COMMIT;
