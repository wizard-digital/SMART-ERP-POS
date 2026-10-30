-- ============================================================================
-- Migration: 638_sale_totals_trigger_ssot.sql
-- Fail-closed: trg_sync_sale_totals must be absent on every tenant and the template.
--
-- This trigger recalculates sales.total_amount / discount_amount from sale_items
-- only. Cart/header discount is not on the lines, so the trigger overwrites the
-- charged total (saleDiscountSsot). Migration 407 dropped it; some DBs still
-- had it because comprehensive_data_triggers.sql recreated it after 407.
--
-- Same DROP on every database. No tenant-specific branch. Do not rewrite
-- posted sales or GL.
-- ============================================================================

DROP TRIGGER IF EXISTS trg_sync_sale_totals ON sale_items;

INSERT INTO schema_version (version)
SELECT 638 WHERE NOT EXISTS (SELECT 1 FROM schema_version WHERE version = 638);
