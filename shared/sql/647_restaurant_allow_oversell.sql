-- Migration 647: Restaurant FOH allow-oversell (soft order/KOT when stock low)
--
-- Default OFF (enterprise-strict): warn on add/KOT; createSale still hard-fails
-- insufficient inventory for inventory/consumable parents (service already skips).
-- When ON: FOH may order/send KOT even when remaining is low (Toast-style).
-- Settlement stock rules stay in salesService + productTypeRules (no negative GL).

ALTER TABLE system_settings
  ADD COLUMN IF NOT EXISTS restaurant_allow_oversell BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN system_settings.restaurant_allow_oversell IS
  'Restaurant FOH: when true, allow ordering/KOT even if menu remaining is low. '
  'Default false — warn stewards to avoid printing; pay still enforces insufficient stock. '
  'Service parents never use this (no parent qty).';

INSERT INTO schema_version (version)
SELECT 647 WHERE NOT EXISTS (SELECT 1 FROM schema_version WHERE version = 647);
