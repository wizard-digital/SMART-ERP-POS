/**
 * Evidence: restaurant FOH remaining qty + oversell soft policy reuse SSOT.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../../..');
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8');

describe('restaurant FOH stock policy evidence', () => {
  it('shared policy: service skips remaining; oversell gates KOT warn', () => {
    const policy = read('shared/restaurant/restaurantStockPolicy.ts');
    expect(policy).toMatch(/isServiceProductType/);
    expect(policy).toMatch(/restaurant_allow_oversell/);
    expect(policy).toMatch(/Avoid sending to kitchen/);
    expect(policy).toMatch(/showRestaurantMenuRemainingQty/);
  });

  it('migration 647 + schema version 647', () => {
    const sql = read('shared/sql/647_restaurant_allow_oversell.sql');
    expect(sql).toMatch(/restaurant_allow_oversell/);
    expect(sql).toMatch(/647/);
    const ver = read('SamplePOS.Server/src/constants/schemaVersion.ts');
    expect(ver).toMatch(/CURRENT_SCHEMA_VERSION = 647/);
  });

  it('menu list exposes remaining_quantity; service null', () => {
    const repo = read('SamplePOS.Server/src/modules/restaurant/restaurantRepository.ts');
    expect(repo).toMatch(/remaining_quantity/);
    expect(repo).toMatch(/product_type, 'inventory'\) = 'service' THEN NULL/);
    expect(repo).toMatch(/inventory_balances|product_inventory/);
  });

  it('FOH paints remaining (+ ordered) and warns on add/KOT via shared policy', () => {
    const pos = read('samplepos.client/src/pages/restaurant/RestaurantPosPage.tsx');
    expect(pos).toMatch(/restaurantFohStockWarnMessage/);
    expect(pos).toMatch(/restaurantFohStockWarnForLines/);
    expect(pos).toMatch(/data-menu-remaining-qty/);
    expect(pos).toMatch(/formatRestaurantMenuStockLabel/);
    expect(pos).toMatch(/invalidateMenuStock/);
  });

  it('settings toggle + enabled API expose allowOversell', () => {
    const tab = read('samplepos.client/src/pages/settings/tabs/SystemSettingsTab.tsx');
    expect(tab).toMatch(/restaurantAllowOversell/);
    expect(tab).toMatch(/data-restaurant-allow-oversell-toggle/);
    const routes = read('SamplePOS.Server/src/modules/restaurant/restaurantRoutes.ts');
    expect(routes).toMatch(/allowOversell/);
    const settings = read('SamplePOS.Server/src/modules/restaurant/restaurantSettings.ts');
    expect(settings).toMatch(/isRestaurantAllowOversellEnabled/);
  });

  it('product history balance uses index SSOT (no date|type|qty collision)', () => {
    const bal = read('shared/utils/productHistoryRunningBalance.ts');
    expect(bal).toMatch(/originalIndex/);
    expect(bal).not.toMatch(/eventDate\}\|\$\{.*type/);
    const svc = read('SamplePOS.Server/src/modules/products/productHistoryService.ts');
    expect(svc).toMatch(/applyProductHistoryRunningBalances/);
    const repo = read('SamplePOS.Server/src/modules/products/productHistoryRepository.ts');
    expect(repo).toMatch(/si\.base_qty/);
    expect(repo).toMatch(/sale_item_id/);
    expect(repo).not.toMatch(/sm_agg/);
  });

  it('sendKot deducts via restaurantKotStockService; void restores; pay skips double', () => {
    const service = read('SamplePOS.Server/src/modules/restaurant/restaurantService.ts');
    const sendKot = service.slice(
      service.indexOf('async sendKot('),
      service.indexOf('async voidCheckItems('),
    );
    expect(sendKot).toMatch(/issueStockOnRestaurantKot/);
    expect(sendKot).not.toMatch(/validateStockAvailability/);
    const voidBlock = service.slice(
      service.indexOf('async voidCheckItems('),
      service.indexOf('async listKitchenBoard('),
    );
    expect(voidBlock).toMatch(/restoreStockOnRestaurantKotVoid/);
    const sales = read('SamplePOS.Server/src/modules/sales/salesService.ts');
    expect(sales).toMatch(/getNetRestaurantKotIssue/);
    expect(sales).toMatch(/sourceOrderItemId/);
  });
});
