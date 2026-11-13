/**
 * Restaurant architecture proof — Phase 1 foundation
 * Ensures SSOT: pos_orders + createSale, flag-off default, no parallel sales engine.
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

function readRepo(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

describe('Restaurant architecture proof (Phase 1)', () => {
  it('migration ships flag default FALSE and reuses pos_orders', () => {
    const sql = readRepo('shared/sql/560_restaurant_foundation.sql');
    expect(sql).toMatch(/restaurant_mode_enabled\s+BOOLEAN\s+NOT\s+NULL\s+DEFAULT\s+FALSE/i);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS restaurant_tables/i);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS restaurant_kot/i);
    expect(sql).toMatch(/ALTER TABLE pos_orders/i);
    expect(sql).not.toMatch(/CREATE TABLE IF NOT EXISTS restaurant_orders/i);
    expect(sql).toMatch(/INTENTIONALLY NO PRICE COLUMNS/i);
  });

  it('settings helper defaults off when column missing', () => {
    const settings = readRepo(
      'SamplePOS.Server/src/modules/restaurant/restaurantSettings.ts',
    );
    expect(settings).toMatch(/isRestaurantModeEnabled/);
    expect(settings).toMatch(/tableHasColumn/);
    expect(settings).toMatch(/return false/);
  });

  it('mutating service asserts restaurant enabled', () => {
    const service = readRepo('SamplePOS.Server/src/modules/restaurant/restaurantService.ts');
    expect(service).toMatch(/assertRestaurantEnabled/);
    expect(service).toMatch(/ordersService\.createOrder/);
    expect(service).toMatch(/ForbiddenError|restaurant_mode_enabled/);
    expect(service).not.toMatch(/createSale\s*\(/);
  });

  it('KOT items have no price fields in repository insert', () => {
    const repo = readRepo('SamplePOS.Server/src/modules/restaurant/restaurantRepository.ts');
    expect(repo).toMatch(/restaurant_kot_items/);
    expect(repo).toMatch(/product_name, quantity, line_notes/);
    expect(repo).not.toMatch(/INSERT INTO restaurant_kot_items[\s\S]*unit_price/i);
  });

  it('routes mount under /api/restaurant and expose enabled', () => {
    const routes = readRepo('SamplePOS.Server/src/modules/restaurant/restaurantRoutes.ts');
    expect(routes).toMatch(/\/enabled/);
    expect(routes).toMatch(/restaurant\.order/);
    expect(routes).toMatch(/checks\/:orderId\/kot/);

    const server = readRepo('SamplePOS.Server/src/server.ts');
    expect(server).toMatch(/\/api\/restaurant/);
    expect(server).toMatch(/restaurantRoutes/);
  });

  it('order complete/cancel release table hook exists', () => {
    const ordersRoutes = readRepo('SamplePOS.Server/src/modules/orders/ordersRoutes.ts');
    expect(ordersRoutes).toMatch(/releaseTableForOrder/);

    // status_updated_by is UUID NULL — never write "system"/"kds-reconcile" labels
    // (that aborted floor release and left ghost OCCUPIED tables after offline cancel).
    const repo = readRepo('SamplePOS.Server/src/modules/restaurant/restaurantRepository.ts');
    expect(repo).toMatch(/asUserUuidOrNull/);
    expect(repo).toMatch(/status_updated_by = \$2/);
    expect(repo).not.toMatch(/updatedBy = 'system'/);

    const svc = readRepo('SamplePOS.Server/src/modules/restaurant/restaurantService.ts');
    const release = svc.slice(
      svc.indexOf('async releaseTableForOrder'),
      svc.indexOf('async requestBill'),
    );
    expect(release).toMatch(/Kitchen bump failed/);
    expect(release).toMatch(/releaseTableByOrderId/);
    expect(release).not.toMatch(/'system'/);

    const replayer = readRepo('SamplePOS.Server/src/modules/pos/posEventReplayer.ts');
    expect(replayer).toMatch(/updatedBy:\s*userId/);
  });

  it('restaurant cancel check uses orders SSOT', () => {
    const service = readRepo('SamplePOS.Server/src/modules/restaurant/restaurantService.ts');
    expect(service).toMatch(/cancelCheck/);
    expect(service).toMatch(/ordersService\.cancelOrder/);
    const routes = readRepo('SamplePOS.Server/src/modules/restaurant/restaurantRoutes.ts');
    expect(routes).toMatch(/checks\/:orderId\/cancel/);
  });

  it('Phase 2.1 kitchen board + status advance exist', () => {
    const sql = readRepo('shared/sql/562_restaurant_kitchen_display.sql');
    expect(sql).toMatch(/restaurant_kot/);
    expect(sql).toMatch(/SENT.*PREPARING.*READY.*BUMPED/s);

    const service = readRepo('SamplePOS.Server/src/modules/restaurant/restaurantService.ts');
    expect(service).toMatch(/listKitchenBoard/);
    expect(service).toMatch(/advanceKotStatus/);
    expect(service).toMatch(/syncOrderKitchenStatusFromKots/);

    const routes = readRepo('SamplePOS.Server/src/modules/restaurant/restaurantRoutes.ts');
    expect(routes).toMatch(/kitchen\/board/);
    expect(routes).toMatch(/kitchen\/tickets\/:kotId\/advance/);

    expect(
      existsSync(path.join(repoRoot, 'samplepos.client/src/pages/restaurant/KitchenDisplayPage.tsx')),
    ).toBe(true);
  });

  it('Phase 2.2 station registry routes KOT printers', () => {
    const sql = readRepo('shared/sql/563_restaurant_stations.sql');
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS restaurant_stations/i);
    expect(sql).toMatch(/printer_name/);

    const service = readRepo('SamplePOS.Server/src/modules/restaurant/restaurantService.ts');
    expect(service).toMatch(/resolveStation/);
    expect(service).toMatch(/listStations/);
    expect(service).toMatch(/printerName/);
    const sendKot = service.slice(
      service.indexOf('async sendKot('),
      service.indexOf('async voidCheckItems('),
    );
    expect(sendKot).toMatch(/byStation/);
    expect(sendKot).toMatch(/Split by resolved station/);
    // Heal null line stations from products before split — prevents one-default-printer collapse.
    expect(sendKot).toMatch(/healUnsentLineKitchenStations/);
    expect(sendKot).toMatch(/printJobsService\.enqueue/);
    expect(sendKot).toMatch(/return \{ kots, printJobs \}/);

    const repo = readRepo('SamplePOS.Server/src/modules/restaurant/restaurantRepository.ts');
    expect(repo).toMatch(/healUnsentLineKitchenStations/);
    expect(repo).toMatch(/COALESCE\(\s*NULLIF\(BTRIM\(oi\.kitchen_station\)/);
    expect(repo).toMatch(/LEFT JOIN products p ON p\.id = oi\.product_id/);
    // Numeric-looking station codes must not crash .trim() after camelCase coercion.
    expect(repo).toMatch(/normalizeStationCode\(code\)/);
    expect(repo).toMatch(/stationCodesEquivalent/);

    const ops = readRepo('samplepos.client/src/lib/restaurantOfflineOps.ts');
    expect(ops).toMatch(/resolveOfflineKotStation/);
    expect(ops).toMatch(/byStation/);

    const routes = readRepo('SamplePOS.Server/src/modules/restaurant/restaurantRoutes.ts');
    expect(routes).toMatch(/\/stations/);

    const print = readRepo('samplepos.client/src/lib/printRestaurant.ts');
    expect(print).toMatch(/X-Printer-Name/);
    expect(print).toMatch(/renderThermalTicketEscPos|buildKotThermalTicket/);
    expect(print).toMatch(/companyName/);
    // Matched station must NOT fall through to default printer (BAR/PIZZA collapse).
    expect(print).toMatch(/never steal the default station printer/);
    expect(print).toMatch(/normalizePrinterName\(match\.printerName\)/);
    expect(print).toMatch(/stationCodesEquivalent/);

    const branding = readRepo('samplepos.client/src/lib/documentCompanyBranding.ts');
    expect(branding).toMatch(/brandingFromTenant/);
    expect(branding).toMatch(/documentCompanyHeaderHtml/);

    expect(
      existsSync(path.join(repoRoot, 'samplepos.client/src/pages/restaurant/RestaurantStationsPage.tsx')),
    ).toBe(true);
    // Receipt printing stays in Settings; restaurant stations stay in restaurant module.
    expect(
      existsSync(
        path.join(repoRoot, 'samplepos.client/src/pages/settings/tabs/PrintingSettingsTab.tsx'),
      ),
    ).toBe(true);
    const settingsPage = readRepo('samplepos.client/src/pages/settings/SettingsPage.tsx');
    expect(settingsPage).toMatch(/PrintingSettingsTab/);
    expect(settingsPage).toMatch(/value=\"printing\"/);
    const printingTab = readRepo(
      'samplepos.client/src/pages/settings/tabs/PrintingSettingsTab.tsx',
    );
    expect(printingTab).toMatch(/ReceiptPrintingSettings/);
    expect(printingTab).not.toMatch(/RestaurantStationsPage/);
    const appRoutes = readRepo('samplepos.client/src/App.tsx');
    expect(appRoutes).toMatch(/path=\"\/restaurant\/stations\"/);
    expect(appRoutes).toMatch(/RestaurantStationsPage/);
    expect(appRoutes).not.toMatch(/Navigate to=\"\/settings\?tab=printing\"/);
    expect(
      existsSync(
        path.join(repoRoot, 'samplepos.client/src/components/restaurant/StationPrinterPicker.tsx'),
      ),
    ).toBe(true);
    const stationsPage = readRepo('samplepos.client/src/pages/restaurant/RestaurantStationsPage.tsx');
    expect(stationsPage).toMatch(/StationPrinterPicker/);
    expect(stationsPage).toMatch(/guest-bill-printer|Guest bill printer/);
    expect(stationsPage).toMatch(/never pick a printer|Waiters only press/i);
    const bridge = readRepo('samplepos.client/src/lib/localPrintBridge.ts');
    expect(bridge).toMatch(/listLocalPrintBridgePrinters/);
    expect(bridge).toMatch(/localhost:1811/);
    expect(bridge).toMatch(/readCachedBridgePrinters|writeCachedBridgePrinters/);

    // Official SMART Print Agent is a first-class platform component
    expect(
      existsSync(path.join(repoRoot, 'smart-print-agent/src/index.ts')),
    ).toBe(true);
    const agentPkg = readRepo('smart-print-agent/package.json');
    expect(agentPkg).toMatch(/"name":\s*"@smart-erp\/print-agent"/);
    const agentServer = readRepo('smart-print-agent/src/server.ts');
    expect(agentServer).toMatch(/\/health/);
    expect(agentServer).toMatch(/\/printers/);
    expect(agentServer).toMatch(/\/print/);
    expect(agentServer).toMatch(/\/cashdrawer/);
    expect(agentServer).toMatch(/formats: \['html', 'escpos'\]/);
    // Printer assert is worker-side (never blocks /print accept).
    expect(readRepo('smart-print-agent/src/printers.ts')).toMatch(/assertPrinterExists/);
    // Client refuses unknown mapped names before claiming silent success.
    expect(print).toMatch(/unknown_printer|readCachedBridgePrinters/);
    expect(agentServer).toMatch(/\/test-print/);
    expect(agentServer).toMatch(/\/restart/);
    expect(agentServer).toMatch(/uptime/);
    expect(agentServer).toMatch(/X-Printer-Name|x-printer-name/);
    expect(stationsPage).toMatch(/Printer Service|SMART Print/);
    expect(
      existsSync(path.join(repoRoot, 'smart-print-agent/scripts/install-print-service.ps1')),
    ).toBe(true);

    // Guest bill default printer SSOT (migration 579) — Bill knows where to print
    const guestBillSql = readRepo('shared/sql/579_guest_bill_printer.sql');
    expect(guestBillSql).toMatch(/guest_bill_printer_name/);
    expect(routes).toMatch(/\/guest-bill-printer/);
    expect(print).toMatch(/resolveStationPrinterName/);
    expect(print).toMatch(/isRestaurantBrowserPrintFallbackEnabled/);
    expect(print).toMatch(/silentPrintFailureMessage/);
    expect(print).toMatch(/X-Printer-Name/);
    expect(print).toMatch(/if \(allowBrowser\) return printHtmlDocument/);

    // Qty-pad add must copy menu kitchenStation (not hardcode null).
    const pos = readRepo('samplepos.client/src/pages/restaurant/RestaurantPosPage.tsx');
    expect(pos).toMatch(/kitchenStation: menuProduct\?\.kitchenStation/);
  });

  it('Phase 2.3 takeaway/delivery guest details on checks', () => {
    const sql = readRepo('shared/sql/564_restaurant_takeaway_delivery.sql');
    expect(sql).toMatch(/guest_name/);
    expect(sql).toMatch(/delivery_address/);
    expect(sql).toMatch(/pickup_label/);

    const service = readRepo('SamplePOS.Server/src/modules/restaurant/restaurantService.ts');
    expect(service).toMatch(/updateCheckGuest/);
    expect(service).toMatch(/assertChannelGuest/);
    expect(service).toMatch(/customerId/);

    const routes = readRepo('SamplePOS.Server/src/modules/restaurant/restaurantRoutes.ts');
    expect(routes).toMatch(/checks\/:orderId\/guest/);

    const print = readRepo('samplepos.client/src/lib/printRestaurant.ts');
    expect(print).toMatch(/orderChannel|guestName/);
    expect(print).toMatch(/guestName/);
    const escpos = readRepo('shared/printing/escposRenderer.ts');
    expect(escpos).toMatch(/TAKE AWAY/);
    expect(escpos).toMatch(/DELIVERY/);

    // Guest uses customers SSOT (CustomerSelector) when provided — optional for TA/DL/Quick.
    const pos = readRepo('samplepos.client/src/pages/restaurant/RestaurantPosPage.tsx');
    expect(pos).toMatch(/CustomerSelector/);
    expect(pos).toMatch(/selectedCustomer/);
    expect(pos).toMatch(/Customer \(optional\)/);
    expect(pos).toMatch(/customer \+ address are optional/);
    expect(pos).toMatch(/updateRestaurantGuestOffline/);
    expect(pos).toMatch(/compact/);
    expect(pos).toMatch(/handleSelectServiceCustomer/);
    // No duplicate free-text guest forms — customer SSOT only.
    expect(pos).not.toMatch(/Guest name \(from customer\)/);
    expect(pos).not.toMatch(/Pickup label/);
  });

  it('Phase 2.4 waiter assignment uses pos_orders.waiter_id', () => {
    const foundation = readRepo('shared/sql/560_restaurant_foundation.sql');
    expect(foundation).toMatch(/waiter_id/);

    const repo = readRepo('SamplePOS.Server/src/modules/restaurant/restaurantRepository.ts');
    expect(repo).toMatch(/listAssignableWaiters/);
    expect(repo).toMatch(/waiter_id/);

    const service = readRepo('SamplePOS.Server/src/modules/restaurant/restaurantService.ts');
    expect(service).toMatch(/assignWaiter/);
    expect(service).toMatch(/listAssignableWaiters/);
    // Multi-ticket: prefer actor's sibling when current_order_id points at a peer check.
    expect(service).toMatch(/scopedSiblings/);

    const routes = readRepo('SamplePOS.Server/src/modules/restaurant/restaurantRoutes.ts');
    expect(routes).toMatch(/\/waiters/);
    expect(routes).toMatch(/checks\/:orderId\/waiter/);
    // Ownership actor must merge legacy pay/manage when RBAC perms empty.
    expect(routes).toMatch(/legacyRoleGrantsPermission/);
    expect(routes).toMatch(/restaurant\.edit_others/);

    const pos = readRepo('samplepos.client/src/pages/restaurant/RestaurantPosPage.tsx');
    expect(pos).toMatch(/assignWaiter|listWaiters/);
    expect(pos).toMatch(/Waiter/);
    // Online floor must trust server occupancy (not stale cached FREE).
    expect(pos).toMatch(/trust server occupancy|Online: trust server/);
    expect(pos).toMatch(/never steal waiters\[0\]|Prefer the signed-in user/);
  });

  it('Phase 3 recipes/BOM explode into createSale FEFO (not KOT)', () => {
    const sql = readRepo('shared/sql/565_restaurant_recipes.sql');
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS product_recipes/i);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS product_recipe_lines/i);
    expect(sql).toMatch(/quantity_base/);
    expect(sql).toMatch(/Deduction happens only in salesService\.createSale/);

    const explosion = readRepo('SamplePOS.Server/src/modules/sales/saleRecipeExplosion.ts');
    expect(explosion).toMatch(/explodeActiveRecipe/);
    expect(explosion).toMatch(/planSaleStockDeduction/);

    const sales = readRepo('SamplePOS.Server/src/modules/sales/salesService.ts');
    expect(sales).toMatch(/explodeActiveRecipe/);
    expect(sales).toMatch(/planSaleStockDeduction/);

    const restaurantService = readRepo(
      'SamplePOS.Server/src/modules/restaurant/restaurantService.ts',
    );
    expect(restaurantService).toMatch(/upsertRecipe/);
    expect(restaurantService).not.toMatch(/createSale\s*\(/);
    expect(restaurantService).toMatch(/cannot be a service product/);

    const sendKot = restaurantService.slice(
      restaurantService.indexOf('async sendKot('),
      restaurantService.indexOf('async listKitchenBoard('),
    );
    expect(sendKot).not.toMatch(/explodeActiveRecipe|validateStockAvailability|stock_movements/);

    const routes = readRepo('SamplePOS.Server/src/modules/restaurant/restaurantRoutes.ts');
    expect(routes).toMatch(/\/recipes/);

    expect(
      existsSync(path.join(repoRoot, 'samplepos.client/src/pages/restaurant/RestaurantRecipesPage.tsx')),
    ).toBe(true);
  });

  it('EVIDENCE gate: Samba order tags denormalize to line_notes for KOT', () => {
    const sql = readRepo('shared/sql/570_restaurant_order_tags.sql');
    expect(sql).toMatch(/restaurant_order_tag_groups/);
    expect(sql).toMatch(/restaurant_order_tags/);
    expect(sql).toMatch(/restaurant_order_tag_mappings/);
    expect(sql).toMatch(/order_tags JSONB/);
    expect(sql).toMatch(/INSERT INTO schema_version \(version\) VALUES \(570\)/);

    const util = readRepo('shared/utils/restaurantOrderTags.ts');
    expect(util).toMatch(/formatOrderTagsAsLineNotes/);
    expect(util).toMatch(/formatOrderTagLabel/);

    const routes = readRepo('SamplePOS.Server/src/modules/restaurant/restaurantRoutes.ts');
    expect(routes).toMatch(/\/order-tags/);
    expect(routes).toMatch(/item-tags/);
    expect(routes).toMatch(/orderTags/);

    const pos = readRepo('samplepos.client/src/pages/restaurant/RestaurantPosPage.tsx');
    expect(pos).toMatch(/RestaurantOrderTagPad/);
    expect(pos).toMatch(/openOrderTagPad/);
    expect(pos).toMatch(/Order tags…/);

    expect(
      existsSync(path.join(repoRoot, 'samplepos.client/src/pages/restaurant/RestaurantOrderTagsPage.tsx')),
    ).toBe(true);
    expect(
      existsSync(
        path.join(repoRoot, 'samplepos.client/src/__tests__/restaurant-order-tags.evidence.test.ts'),
      ),
    ).toBe(true);
  });

  it('EVIDENCE gate: KOT consolidates same product+notes into qty (not 1,1,1,1)', () => {
    const util = readRepo('shared/utils/consolidateKotLines.ts');
    expect(util).toMatch(/consolidateKotLines/);
    expect(util).toMatch(/kotLineNotesMergeKey/);

    const service = readRepo('SamplePOS.Server/src/modules/restaurant/restaurantService.ts');
    const sendKot = service.slice(
      service.indexOf('async sendKot('),
      service.indexOf('async voidCheckItems('),
    );
    expect(sendKot).toMatch(/toConsolidatedKotItems|consolidateKotLines/);

    const print = readRepo('samplepos.client/src/lib/printRestaurant.ts');
    expect(print).toMatch(/buildKotThermalTicket|renderThermalTicketEscPos/);
    // Bound to BillPrintData — do not include bill types (unitPrice/lineTotal live there).
    const kotStart = print.indexOf('export async function printKitchenTicket');
    const kotEnd = print.indexOf('export interface BillPrintData');
    expect(kotStart).toBeGreaterThanOrEqual(0);
    expect(kotEnd).toBeGreaterThan(kotStart);
    const kotFn = print.slice(kotStart, kotEnd);
    expect(kotFn).toMatch(/buildKotThermalTicket/);
    expect(kotFn).toMatch(/renderThermalTicketEscPos/);
    expect(kotFn).not.toMatch(/formatCurrency/);
    expect(kotFn).not.toMatch(/unitPrice|lineTotal/);

    const kotTicket = readRepo('shared/printing/buildKotTicket.ts');
    expect(kotTicket).toMatch(/consolidateKotLines/);
    expect(kotTicket).toMatch(/NO PRICES/);
    const escpos = readRepo('shared/printing/escposRenderer.ts');
    expect(escpos).toMatch(/Steward:/);
    expect(escpos).toMatch(/NO PRICES/);

    // Bill + receipt share thermalGuestDocument SSOT
    const guest = readRepo('samplepos.client/src/lib/thermalGuestDocument.ts');
    expect(guest).toMatch(/buildThermalGuestDocumentHtml/);
    expect(guest).toMatch(/billToThermalGuestDocument/);
    expect(guest).toMatch(/receiptToThermalGuestDocument/);
    expect(guest).toMatch(/consolidatePricedLines/);
    expect(print).toMatch(/buildThermalGuestDocumentHtml|billToThermalGuestDocument/);
    const receiptPrint = readRepo('samplepos.client/src/lib/print.ts');
    expect(receiptPrint).toMatch(/buildThermalGuestDocumentHtml/);
    expect(receiptPrint).toMatch(/receiptToThermalGuestDocument/);
  });

  it('EVIDENCE gate: service parent never quantity-checked (planSaleStockDeduction skip)', () => {
    const rules = readRepo('shared/utils/productTypeRules.ts');
    expect(rules).toMatch(/type === 'service' && !hasRecipeLines/);
    expect(rules).toMatch(/kind: 'skip'/);

    const sales = readRepo('SamplePOS.Server/src/modules/sales/salesService.ts');
    expect(sales).toMatch(/stockPlan\.kind === 'skip'/);
    expect(sales).toMatch(/Skipping inventory deduction for service item/);

    const offline = readRepo('samplepos.client/src/lib/restaurantOfflineOps.ts');
    expect(offline).toMatch(/isServiceProductType\(productType\)/);

    expect(
      existsSync(
        path.join(
          repoRoot,
          'SamplePOS.Server/src/modules/sales/serviceProductNeverQuantityIssues.evidence.test.ts',
        ),
      ),
    ).toBe(true);
  });

  it('Multistore restaurant uses shop/SELLING store — never MAIN warehouse', () => {
    const storeRepo = readRepo(
      'SamplePOS.Server/src/modules/inventory/warehouse/storeLocationRepository.ts',
    );
    expect(storeRepo).toMatch(/getActivePosSellingStore/);
    expect(storeRepo).toMatch(/store_type = 'SELLING'/);
    // Must not accept MAIN via is_pos_selling alone.
    const sellingFn = storeRepo.slice(
      storeRepo.indexOf('async getActivePosSellingStore'),
      storeRepo.indexOf('async getDefaultReceivingStore'),
    );
    expect(sellingFn).toMatch(/store_type = 'SELLING'/);
    expect(sellingFn).not.toMatch(/is_pos_selling = true\s*\n\s*OR store_type/);

    const fragments = readRepo(
      'SamplePOS.Server/src/modules/inventory/warehouse/inventoryStockSqlFragments.ts',
    );
    expect(fragments).toMatch(/POS_SELLING_STORE_FALLBACK_FILTER_SQL[\s\S]*store_type = 'SELLING'/);

    const restaurantService = readRepo(
      'SamplePOS.Server/src/modules/restaurant/restaurantService.ts',
    );
    expect(restaurantService).toMatch(/resolveRestaurantShopStoreId/);
    expect(restaurantService).toMatch(/isMultistoreEnabled/);
    expect(restaurantService).toMatch(/resolveActiveSellingStoreId/);
    expect(restaurantService).toMatch(/not MAIN warehouse/);

    const restaurantRepo = readRepo(
      'SamplePOS.Server/src/modules/restaurant/restaurantRepository.ts',
    );
    expect(restaurantRepo).toMatch(/sellingStoreId/);
    expect(restaurantRepo).toMatch(/productPosVisibleAtStoreSql/);

    const sales = readRepo('SamplePOS.Server/src/modules/sales/salesService.ts');
    expect(sales).toMatch(/resolveSellingStoreId/);
    expect(sales).toMatch(/warehouseSaleDeductionService/);

    const cache = readRepo('samplepos.client/src/lib/restaurantOfflineCache.ts');
    expect(cache).toMatch(/syncProductCatalog/);
  });

  it('Restaurant menu categories match category_id or free-text category', () => {
    const repo = readRepo('SamplePOS.Server/src/modules/restaurant/restaurantRepository.ts');
    expect(repo).toMatch(/syncProductCategoryLinks/);
    expect(repo).toMatch(/LOWER\(TRIM\(p\.category\)\) = LOWER\(TRIM\(c\.name\)\)/);
    expect(repo).toMatch(/listMenuCategories/);

    const sql567 = readRepo('shared/sql/567_restaurant_menu_category_visibility.sql');
    expect(sql567).toMatch(/available_in_restaurant = TRUE/);
    expect(sql567).toMatch(/category_id = c\.id/);
  });

  it('KOT/Close: waiter logout on multi-ticket; sole ticket stays with sent lines', () => {
    const pos = readRepo('samplepos.client/src/pages/restaurant/RestaurantPosPage.tsx');
    const kotBlock = pos.slice(
      pos.indexOf('const fireUnsentKotTickets'),
      pos.indexOf('const handleBill'),
    );
    expect(kotBlock).toMatch(/api\.restaurant\.sendKot/);
    expect(kotBlock).toMatch(/fireRestaurantKotOffline/);
    expect(kotBlock).toMatch(/shouldUseLocalRestaurantMutation|isJournalLocalOrderId/);
    expect(kotBlock).toMatch(/useLocalKot/);
    expect(kotBlock).toMatch(/Already sent to kitchen/);
    expect(kotBlock).toMatch(/maybeAutoLogoutAfterPrint\('kot'\)/);
    expect(kotBlock).toMatch(/leaveAfterKot/);
    expect(kotBlock).toMatch(/resolveKotSessionLeave/);
    expect(kotBlock).toMatch(/returnToFloor\(\)/);
    expect(kotBlock).toMatch(/refreshSelectedTicketAfterKot/);
    expect(kotBlock).toMatch(/cancelQueries\(\{ queryKey: \['restaurant', 'check', selectedTableId\] \}\)/);
    expect(kotBlock).toMatch(/setActiveOrderId\(serverKotOrderId\)/);
    expect(kotBlock).toMatch(/getTableCheck\(selectedTableId/);
    expect(kotBlock).toMatch(/paintServerCheckWithInFlight/);
    expect(kotBlock).toMatch(/printFailures|printOk/);
    expect(kotBlock).toMatch(/printKitchenTicket/);
    // createKot must resolve hasStatus before use (never ReferenceError on KOT fire).
    const repo = readRepo('SamplePOS.Server/src/modules/restaurant/restaurantRepository.ts');
    const createKot = repo.slice(repo.indexOf('async createKot('), repo.indexOf('async getOrderRestaurantMeta('));
    expect(createKot).toMatch(/const hasStatus = await tableHasColumn/);

    const svc = readRepo('SamplePOS.Server/src/modules/restaurant/restaurantService.ts');
    const sendKot = svc.slice(svc.indexOf('async sendKot('), svc.indexOf('async voidCheckItems('));
    expect(sendKot).toMatch(/no unsent items/);
    expect(sendKot).not.toMatch(/ERR_RESTAURANT_KOT_EMPTY/);
  });

  it('Expert Bill flow: mark BILLING then return to floor; print is best-effort', () => {
    const pos = readRepo('samplepos.client/src/pages/restaurant/RestaurantPosPage.tsx');
    const billHandler = pos.slice(
      pos.indexOf('const handleBill'),
      pos.indexOf('const activateSibling'),
    );
    // Bill fires unsent KOT first, then prints guest check for the selected ticket.
    expect(billHandler).toMatch(/fireUnsentKotTickets/);
    expect(billHandler).toMatch(/requestBill|markRestaurantBillRequestedOffline/);
    expect(billHandler).toMatch(/returnToFloor/);
    expect(billHandler).toMatch(/Bill printed|Bill marked/);
    expect(billHandler).toMatch(/printOk/);
    expect(billHandler).toMatch(/printRestaurantBill/);
    expect(billHandler).toMatch(/getGuestBillPrinter|guestBillPrinterName/);
    expect(billHandler).toMatch(/shouldUseLocalRestaurantMutation|isJournalLocalOrderId/);
    expect(billHandler).not.toMatch(/Print the guest bill anyway/);
    // Multi-ticket: bill selected order only; stay on table when siblings remain.
    expect(billHandler).toMatch(/remainingTickets/);
    expect(billHandler).toMatch(/activateSibling/);
    expect(billHandler).toMatch(/Bill printed for/);

    const svc = readRepo('SamplePOS.Server/src/modules/restaurant/restaurantService.ts');
    expect(svc).toMatch(/async requestBill\(/);
    expect(svc).toMatch(/markBilling/);
    const markBilling = svc.slice(
      svc.indexOf('async markBilling'),
      svc.indexOf('async releaseTableForOrder'),
    );
    expect(markBilling).toMatch(/listPendingOrdersForTable/);
    expect(markBilling).toMatch(/siblings\.length\s*<=\s*1/);
    const routes = readRepo('SamplePOS.Server/src/modules/restaurant/restaurantRoutes.ts');
    expect(routes).toMatch(/router\.post\(\s*'\/checks\/:orderId\/bill'/);
  });

  it('Restaurant POS buttons are touch-first (44px+ targets, touch-manipulation)', () => {
    const pos = readRepo('samplepos.client/src/pages/restaurant/RestaurantPosPage.tsx');
    expect(pos).toMatch(/touch-manipulation/);
    expect(pos).toMatch(/const touchBtn/);
    expect(pos).toMatch(/min-h-12/);
    expect(pos).toMatch(/min-h-14/);
    expect(pos).toMatch(/active:scale-\[0\.98\]/);
    // Phones: menu always on; Order/Details/More open as sheets on button press
    expect(pos).toMatch(/mobileSheet/);
    expect(pos).toMatch(/menuQtyPadOpen|bottom half always visible|Ticket/);
    expect(pos).not.toMatch(/max-h-\[52vh\]/);
    expect(pos).not.toMatch(/mobilePane/);
    // SambaPOS/Toast: consolidate lines; tap select → Void / Move; ticket tabs
    expect(pos).toMatch(/consolidateTicketLines/);
    expect(pos).toMatch(/toggleGroupSelection/);
    expect(pos).toMatch(/handleMoveSelected|handleVoidSelected/);
    expect(pos).toMatch(/border-amber-500 bg-amber-100|Selected/);
    expect(pos).toMatch(/ticketTabs/);
    expect(pos).toMatch(/ticketTabAccent|TICKET_TAB_ACCENTS/);
    expect(pos).toMatch(/Active ·/);
    expect(pos).toMatch(/Tickets on table/);
    expect(pos).toMatch(/activateSibling/);
    expect(pos).toMatch(/Instant ticket switch|placeholderData/);
    expect(pos).toMatch(/prefetchQuery/);
    expect(pos).toMatch(/attachSiblingTabs/);
    expect(pos).toMatch(/Moved to new ticket/);
    expect(pos).toMatch(/paintAfterSplitMove/);
    expect(pos).toMatch(/selectedMoveUnits/);
    expect(pos).toMatch(/Change table/);
    expect(pos).toMatch(/← Tables|Back to tables/);
    expect(pos).toMatch(/returnToFloor/);
    expect(pos).not.toMatch(/startLineLongPress/);
    expect(pos).toMatch(/handleLinePlusOne/);
    expect(pos).toMatch(/handleLineMinusOne/);
  });

  it('Restaurant POS Pay is gated by restaurant.pay (cashier/accountant/admin)', () => {
    const pos = readRepo('samplepos.client/src/pages/restaurant/RestaurantPosPage.tsx');
    expect(pos).toMatch(/canRestaurantPay/);
    expect(pos).toMatch(/restaurant\.pay/);
    expect(pos).toMatch(/canRestaurantPay \? \(/);
    expect(pos).toMatch(/canOrder/);
    expect(pos).toMatch(/restaurant\.order/);
    // Pay settles the selected ticket only (same rule as Bill on multi-ticket tables).
    const payHandler = pos.slice(pos.indexOf('const handlePay'), pos.indexOf('if (flagLoading)'));
    expect(payHandler).toMatch(/returnToFloor/);
    expect(payHandler).toMatch(/returnTo=.*restaurant|pay\?returnTo/);
    expect(payHandler).toMatch(/remainingTickets/);
    expect(payHandler).toMatch(/activateSibling|Paid .* still open/);
    expect(payHandler).toMatch(/paidOrderNumber|order\.orderNumber/);
    expect(payHandler).toMatch(/Other tickets on this table stay open|ticket\(s\) still open/);
    // Online server checks open tender screen; after pay always return to restaurant floor.
    expect(payHandler).toMatch(/shouldUseLocalRestaurantMutation/);
    expect(payHandler).toMatch(/navigate\(`\/orders\/\$\{paidOrderId\}\/pay/);
    expect(payHandler).toMatch(/returnTo=\$\{encodeURIComponent\('\/restaurant'\)\}|returnTo.*\/restaurant/);
    expect(payHandler).toMatch(/returnToFloor\(\)/);
    expect(payHandler).not.toMatch(/\/restaurant\?table=/);

    const payPage = readRepo('samplepos.client/src/pages/orders/OrderPaymentPage.tsx');
    expect(payPage).toMatch(/returnToPath/);
    expect(payPage).toMatch(/\/restaurant/);
    expect(payPage).toMatch(/Back to Tables/);
    expect(payPage).toMatch(/canSettleThisOrder/);
    expect(payPage).toMatch(/restaurant\.pay/);

    const ordersRoutes = readRepo('SamplePOS.Server/src/modules/orders/ordersRoutes.ts');
    expect(ordersRoutes).toMatch(/isRestaurantCheck/);
    expect(ordersRoutes).toMatch(/restaurant\.pay/);
    expect(ordersRoutes).toMatch(/orders\.pay/);

    const restRoutes = readRepo('SamplePOS.Server/src/modules/restaurant/restaurantRoutes.ts');
    expect(restRoutes).toMatch(/void-items[\s\S]*requirePermission\('restaurant\.order'\)/s);
    expect(restRoutes).not.toMatch(/void-items[\s\S]*orders\.cancel/s);

    const grants = readRepo('shared/authorization/systemRoleGrants.ts');
    expect(grants).toMatch(/restaurant\.pay/);
    expect(grants).toMatch(/if \(permission\.key === 'restaurant\.pay'\) return false/);

    const sql568 = readRepo('shared/sql/568_restaurant_pay_role_scope.sql');
    expect(sql568).toMatch(/Accountant/);
    expect(sql568).toMatch(/Cashier/);
    expect(sql568).toMatch(/DELETE FROM rbac_role_permissions[\s\S]*Manager/s);
  });

  it('Restaurant void after KOT prints VOID tickets and removes lines', () => {
    const sql569 = readRepo('shared/sql/569_restaurant_kot_void.sql');
    expect(sql569).toMatch(/ticket_kind/);
    expect(sql569).toMatch(/FIRE.*VOID|VOID.*FIRE/s);

    const service = readRepo('SamplePOS.Server/src/modules/restaurant/restaurantService.ts');
    expect(service).toMatch(/async voidCheckItems\(/);
    expect(service).toMatch(/ticketKind: 'VOID'/);
    expect(service).toMatch(/reduceOrderItemQuantity/);
    expect(service).toMatch(/resolveStationForVoidItem/);
    // Partial voids ignore stale itemIds (already gone / wrong tab).
    expect(service).toMatch(/ignoring stale item ids not on check/);
    expect(service).toMatch(/Those lines are no longer on this check/);
    expect(service).toMatch(/cancelCheck[\s\S]*ticketKind: 'VOID'/s);

    const routes = readRepo('SamplePOS.Server/src/modules/restaurant/restaurantRoutes.ts');
    expect(routes).toMatch(/checks\/:orderId\/void-items/);
    expect(routes).toMatch(/quantity/);

    const pos = readRepo('samplepos.client/src/pages/restaurant/RestaurantPosPage.tsx');
    expect(pos).toMatch(/handleVoidLines/);
    expect(pos).toMatch(/preferLocalRestaurantWrites\(order\.id\)/);
    expect(pos).toMatch(/allowKitchenSent/);
    expect(pos).toMatch(/Open restaurant check required to void/);
    expect(pos).toMatch(/Check was already closed/);
    expect(pos).toMatch(/voidItems/);
    expect(pos).toMatch(/allocateVoidQuantity/);
    // Kitchen-sent voids: managers/cashiers only; waiters remove unsent lines.
    expect(pos).toMatch(/canVoidKitchenSentRestaurantItems/);
    expect(pos).toMatch(/RESTAURANT_VOID_SENT_RESTRICTED_MESSAGE/);
    expect(pos).toMatch(/data-ticket-void-reason/);
    expect(pos).toMatch(/data-ticket-voids/);
    expect(pos).toMatch(/Voided by/);
    expect(pos).not.toMatch(/No confirm\/prompt — FOH voids must be one-tap/);
    expect(pos).not.toMatch(/Kitchen will be notified\./);
    expect(pos).not.toMatch(/Void reason \(kitchen will get a VOID ticket\)/);
    // Touch qty pad for partial void / set qty — never window.prompt for quantities.
    expect(pos).toMatch(/qtyPadSheet|QtyPadSheetState/);
    expect(pos).toMatch(/confirmQtyPadSheet|purpose: 'void-qty'/);
    expect(pos).not.toMatch(/How many to void/);
    expect(pos).toMatch(/pendingQtyDigits|parsePendingOrderQty|restaurantPendingQty/);
    expect(pos).toMatch(/appendQtyDigit/);
    expect(pos).toMatch(/openServiceLane|SERVICE_LANE_DEFS/);
    expect(pos).toMatch(/pendingMobileSheetRef/);
    expect(pos).toMatch(/Quick order|Takeaway/);
    // One Service lane tile per channel — not "Delivery" button + separate DL table.
    expect(pos).toMatch(/One tile per lane|no duplicate/);
    expect(pos).not.toMatch(/Open service tickets/);
    expect(pos).toMatch(/isServiceLaneCode/);
    expect(pos).toMatch(/Set qty/);
    expect(pos).toMatch(/ticketKind: 'VOID'/);
    expect(service).toMatch(/canVoidKitchenSentRestaurantItems/);
    expect(service).toMatch(/listVoidTicketsForOrder/);
    const ownership = readRepo('shared/utils/restaurantCheckOwnership.ts');
    expect(ownership).toMatch(/role === 'ACCOUNTANT'/);
    // Unsent / On bill / KOT — never "New" (confused with bill-printed).
    expect(pos).toMatch(/ticketLineStatus/);
    expect(pos).toMatch(/On bill/);
    expect(pos).toMatch(/Unsent/);
    expect(pos).not.toMatch(/Kitchen: \$\{[\s\S]*\? 'New'/);
    expect(pos).toMatch(/Removed before kitchen send/);
    expect(pos).toMatch(/Cancel reason is required when kitchen has been notified/);
    expect(pos).toMatch(/Remove \(unsent\)/);
    // Bill auto-fires KOT then prints guest check.
    expect(pos).toMatch(/fireUnsentKotTickets/);
    expect(pos).toMatch(/Bill printed/);
    // Samba-style wide layout: vertical category rail + keypad under products.
    expect(pos).toMatch(/vertical category|bg-orange-600 text-white/);
    expect(pos).toMatch(/keypad under products|compact bar \+ dialer|Quantity pad|menuQtyPadOpen/);
    // Phone: split menu + ticket (always visible), not order-hidden behind a dock.
    expect(pos).toMatch(/Phone: full dialer sheet|compact bar stays in the split|menuQtyPadOpen/);
    expect(pos).not.toMatch(/Mobile dock — open sheets/);
    // Inline ± on unsent ticket lines.
    expect(pos).toMatch(/Inline ± on New|Decrease quantity|Inline ± on/);

    const qtyLib = readRepo('samplepos.client/src/lib/restaurantPendingQty.ts');
    expect(qtyLib).toMatch(/parsePendingOrderQty/);
    expect(qtyLib).toMatch(/clampOrderQty/);
    expect(qtyLib).toMatch(/appendQtyDigit/);

    const print = readRepo('samplepos.client/src/lib/printRestaurant.ts');
    expect(print).toMatch(/VOID|ticketKind/);
    const escposVoid = readRepo('shared/printing/escposRenderer.ts');
    expect(escposVoid).toMatch(/DO NOT PREPARE|KOT_VOID/);
  });

  it('Phase 4 split/merge/transfer reuse pos_orders', () => {
    const sql = readRepo('shared/sql/566_restaurant_split_merge_transfer.sql');
    expect(sql).toMatch(/idx_pos_orders_table_pending/);

    const service = readRepo('SamplePOS.Server/src/modules/restaurant/restaurantService.ts');
    expect(service).toMatch(/transferCheck/);
    expect(service).toMatch(/mergeChecks/);
    expect(service).toMatch(/splitCheck/);
    expect(service).toMatch(/moveOrderItems|activateCheck/);
    expect(service).toMatch(/ERR_RESTAURANT_CHECK_CLOSED/);
    expect(service).toMatch(/listPendingOrdersForTable/);
    expect(service).toMatch(/cloneOrderItemPartial/);
    expect(service).not.toMatch(/CREATE TABLE.*restaurant_orders/i);
    // Stale paid/cancelled orderId on addItems: open new check when no PENDING siblings.
    const addItems = service.slice(
      service.indexOf('async addItemsToTable'),
      service.indexOf('async sendKot'),
    );
    expect(addItems).toMatch(/closed orderId with no open siblings/);
    expect(addItems).toMatch(/binding remaining open check/);
    expect(addItems).toMatch(/resolveClosedCheckAddRetry/);
    expect(addItems).toMatch(/openOrderIds/);
    expect(addItems).toMatch(/ERR_RESTAURANT_CHECK_CLOSED/);

    const repo = readRepo('SamplePOS.Server/src/modules/restaurant/restaurantRepository.ts');
    expect(repo).toMatch(/moveOrderItems/);
    expect(repo).toMatch(/cloneOrderItemPartial/);
    expect(repo).toMatch(/listPendingOrdersForTable/);

    const routes = readRepo('SamplePOS.Server/src/modules/restaurant/restaurantRoutes.ts');
    expect(routes).toMatch(/checks\/:orderId\/transfer/);
    expect(routes).toMatch(/checks\/:orderId\/merge/);
    expect(routes).toMatch(/checks\/:orderId\/split/);
    expect(routes).toMatch(/quantity: z\.number\(\)\.positive\(\)\.optional\(\)/);

    const pos = readRepo('samplepos.client/src/pages/restaurant/RestaurantPosPage.tsx');
    expect(pos).toMatch(/transferCheck|splitCheck|mergeChecks/);
    expect(pos).toMatch(/purpose: 'move-qty'/);
    expect(pos).toMatch(/allocateVoidQuantity/);
    // Merge is same-table only (Samba).
    expect(pos).toMatch(/merge only other tickets on the same table/);
    expect(service).toMatch(/same table/);
    // Client recovers from closed check on add (retry once without orderId).
    expect(pos).toMatch(/isRestaurantCheckClosedError/);
    expect(pos).toMatch(/resolveClosedCheckAddRetry|closedCheckAddRetryFromError/);
    expect(pos).toMatch(/openOrderIdsFromDetails/);
    // Party list + Ticket opens a new check; menu add never force-news from the list.
    expect(pos).not.toMatch(/samba-open-ticket-first/);
    expect(service).toMatch(/forceNewCheck/);
    expect(routes).toMatch(/forceNewCheck/);
    // Samba empty multi-ticket open (party tabs) — does not cancel/merge siblings.
    expect(service).toMatch(/async openEmptyCheck/);
    expect(service).toMatch(/ERR_RESTAURANT_TOO_MANY_CHECKS/);
    expect(service).toMatch(/MAX_OPEN_CHECKS_PER_TABLE/);
    expect(routes).toMatch(/tables\/:id\/open-check/);
    expect(pos).toMatch(/openNewTicketOnTable|openCheck/);
    expect(pos).toMatch(/\+ Ticket/);
    // Floor multi-ticket session signal (not only current_order_id pointer).
    expect(repo).toMatch(/open_check_count/);
    expect(repo).toMatch(/open_checks_total/);
    // release still re-points siblings when one tab closes.
    expect(repo).toMatch(/releaseTableByOrderId/);
  });

  it('Phase 5.1 restaurant offline uses existing event journal', () => {
    const journal = readRepo('samplepos.client/src/lib/offlineEventJournal.ts');
    expect(journal).toMatch(/RESTAURANT_KOT_FIRED/);
    expect(journal).toMatch(/JOURNAL_KEY = 'pos_offline_events'/);
    expect(journal).not.toMatch(/restaurant_offline_events/);

    const ops = readRepo('samplepos.client/src/lib/restaurantOfflineOps.ts');
    expect(ops).toMatch(/appendRestaurantItemOffline/);
    expect(ops).toMatch(/fireRestaurantKotOffline/);
    expect(ops).toMatch(/appendEvent/);

    const cache = readRepo('samplepos.client/src/lib/restaurantOfflineCache.ts');
    expect(cache).toMatch(/refreshRestaurantOfflineCache/);

    const selectors = readRepo('samplepos.client/src/lib/offlineEventSelectors.ts');
    expect(selectors).toMatch(/deriveRestaurantOpenChecks/);
    expect(selectors).toMatch(/deriveRestaurantCheckForTable/);

    const replayer = readRepo('SamplePOS.Server/src/modules/pos/posEventReplayer.ts');
    expect(replayer).toMatch(/RESTAURANT_KOT_FIRED/);

    const pos = readRepo('samplepos.client/src/pages/restaurant/RestaurantPosPage.tsx');
    expect(pos).toMatch(/appendRestaurantItemOffline/);
    expect(pos).toMatch(/fireRestaurantKotOffline/);
    expect(pos).toMatch(/isOnline/);

    const adr = readRepo('docs/architecture/RESTAURANT_OFFLINE_ADR.md');
    expect(adr).toMatch(/Local First/);
  });

  it('Phase 5.2 offline cash pay uses SALE_COMPLETED + releases table on replay', () => {
    const ops = readRepo('samplepos.client/src/lib/restaurantOfflineOps.ts');
    expect(ops).toMatch(/payRestaurantCheckOffline/);
    expect(ops).toMatch(/SALE_COMPLETED/);
    expect(ops).not.toMatch(/createSale\(/);

    const journal = readRepo('samplepos.client/src/lib/offlineEventJournal.ts');
    expect(journal).toMatch(/tableId\?:/);

    const replayer = readRepo('SamplePOS.Server/src/modules/pos/posEventReplayer.ts');
    expect(replayer).toMatch(/releaseTableForOrder/);
    expect(replayer).toMatch(/fromOrderId/);

    const syncRoutes = readRepo('SamplePOS.Server/src/modules/pos/syncEventsRoutes.ts');
    expect(syncRoutes).toMatch(/RESTAURANT_KOT_FIRED/);
    expect(syncRoutes).toMatch(/tableId/);

    const pos = readRepo('samplepos.client/src/pages/restaurant/RestaurantPosPage.tsx');
    expect(pos).toMatch(/payRestaurantCheckOffline/);
    expect(pos).toMatch(/OfflineSyncStatusPanel/);
    expect(pos).toMatch(/printReceipt/);
  });

  it('Phase 5.x offline-first requires behavioral proof (not structure-only)', () => {
    const proof = readRepo('samplepos.client/src/lib/restaurantOfflineOps.proof.test.ts');
    expect(proof).toMatch(/Restaurant offline-first ops \(behavioral proof\)/);
    expect(proof).toMatch(/appendRestaurantItemOffline/);
    expect(proof).toMatch(/cancelRestaurantCheckOffline/);
    expect(proof).toMatch(/payRestaurantCheckOffline/);
    expect(proof).toMatch(/seedRestaurantCheckFromServer/);
    expect(proof).toMatch(/removeRestaurantLinesOffline/);
    expect(proof).toMatch(/fireRestaurantKotOffline/);
    expect(proof).toMatch(/updateRestaurantGuestOffline/);
    expect(proof).toMatch(/shouldUseLocalRestaurantMutation/);
    expect(proof).toMatch(/ofl_ord_\* KOT fires locally/);
    expect(proof).toMatch(/getUnsyncedEvents/);
    expect(proof).toMatch(/installMemoryLocalStorage|localStorage/);
    // Multi-ticket Bill/Pay: structure alone is not acceptance — EVIDENCE cases required.
    expect(proof).toMatch(/EVIDENCE multi-ticket bill marks only the selected order number/);
    expect(proof).toMatch(/EVIDENCE multi-ticket pay settles only the selected order number/);
    expect(proof).toMatch(
      /EVIDENCE journal-local void of kitchen-sent lines emits VOID KOT/,
    );
    expect(proof).toMatch(
      /EVIDENCE reconcile drops journal ghosts when server table is FREE/,
    );
    expect(proof).toMatch(
      /EVIDENCE multi-ticket append with orderId stays on selected sibling/,
    );
    expect(proof).toMatch(
      /EVIDENCE partial qty move keeps remainder on source and preserves kitchenSentAt/,
    );
    expect(proof).toMatch(/reconcileRestaurantJournalWithServerTables/);
    expect(proof).toMatch(/markRestaurantCheckSettledInJournal/);
    expect(proof).toMatch(/markRestaurantBillRequestedOffline/);
    expect(proof).toMatch(/isRestaurantOrderBillRequestedOffline/);
    expect(proof).toMatch(/splitRestaurantCheckOffline/);
    expect(proof).toMatch(/remainingTickets/);
    expect(proof).toMatch(/resolveOfflineProductType/);

    const optimisticProof = readRepo(
      'samplepos.client/src/lib/restaurantCheckOptimistic.proof.test.ts',
    );
    expect(optimisticProof).toMatch(
      /EVIDENCE optimistic open paints tmp_ord \+ tmp_line before API/,
    );
    expect(optimisticProof).toMatch(
      /EVIDENCE rapid taps stack optimistic lines without wiping prior temp/,
    );
    expect(optimisticProof).toMatch(
      /EVIDENCE soft-refresh mid-race keeps sibling in-flight temp lines/,
    );
    expect(optimisticProof).toMatch(
      /EVIDENCE tmp_ord never becomes API \?orderId= \(avoids Postgres 22P02\)/,
    );
    expect(optimisticProof).toMatch(
      /EVIDENCE tmp_ord never becomes switchable sibling \(activate-check 400\)/,
    );

    const ops = readRepo('samplepos.client/src/lib/restaurantOfflineOps.ts');
    expect(ops).toMatch(/export function shouldUseLocalRestaurantMutation/);
    expect(ops).toMatch(/export function isJournalLocalOrderId/);
    expect(ops).toMatch(/export function markRestaurantCheckSettledInJournal/);
    expect(ops).toMatch(/export function reconcileRestaurantJournalWithServerTables/);
    expect(ops).toMatch(/orderId\?: string \| null/);
    expect(ops).toMatch(/existing\.orderId/);

    const optimistic = readRepo('samplepos.client/src/lib/restaurantCheckOptimistic.ts');
    expect(optimistic).toMatch(/export function appendOptimisticMenuItem/);
    expect(optimistic).toMatch(/export function mergeInFlightOptimisticLines/);
    expect(optimistic).toMatch(/export function isTempRestaurantId/);
    expect(optimistic).toMatch(/export function toServerRestaurantOrderId/);
    expect(optimistic).toMatch(/export function scrubRestaurantTicketTabs/);

    const repo = readRepo('SamplePOS.Server/src/modules/restaurant/restaurantRepository.ts');
    expect(repo).toMatch(/bumpKitchenTicketsForOrder/);
    expect(repo).toMatch(/purgeSettledKitchenTickets/);
    expect(repo).toMatch(/o\.status = 'PENDING'/);
    expect(repo).not.toMatch(/INTERVAL '4 hours'/);

    const svc = readRepo('SamplePOS.Server/src/modules/restaurant/restaurantService.ts');
    expect(svc).toMatch(/purgeSettledKitchenTickets/);
    expect(svc).toMatch(/input\.orderId/);
    expect(svc).toMatch(/Order does not belong to this table/);
    expect(svc).toMatch(/ignore client temp\/journal ids/);

    const routes = readRepo('SamplePOS.Server/src/modules/restaurant/restaurantRoutes.ts');
    expect(routes).toMatch(/orderId: z\.string\(\)\.uuid\(\)\.optional\(\)/);
    expect(routes).toMatch(/ORDER_ID_UUID_RE/);
    expect(routes).toMatch(/tmp_ord_\*|ofl_ord_\*/);

    const pos = readRepo('samplepos.client/src/pages/restaurant/RestaurantPosPage.tsx');
    expect(pos).toMatch(/toServerRestaurantOrderId/);
    expect(pos).toMatch(/isTempRestaurantId\(order\.id\)/);
    expect(pos).toMatch(/Never seed optimistic tmp_ord_/);
    expect(pos).toMatch(/scrubRestaurantTicketTabs/);
    expect(pos).toMatch(/Ghost optimistic tickets are not activatable/);
    expect(pos).toMatch(/preferLocalRestaurantWrites/);
    expect(pos).toMatch(/paintJournalCheck/);
    expect(pos).toMatch(/settleCheckOnFloor/);
    expect(pos).toMatch(/paintRestaurantTableFreeOffline/);
    expect(pos).toMatch(/reconcileRestaurantJournalWithServerTables/);
    expect(pos).toMatch(/refreshRestaurantCheckSeedFromServer/);
    expect(pos).toMatch(/shouldUseLocalRestaurantMutation/);
    expect(pos).toMatch(/CustomerSelector/);
    expect(pos).toMatch(/appendOptimisticMenuItem/);
    expect(pos).toMatch(/mergeInFlightOptimisticLines/);
    expect(pos).toMatch(/orderId: orderIdForApi/);
    expect(pos).toMatch(/isRestaurantCheckClosedError/);
    expect(pos).not.toMatch(/disabled=\{addItemMutation\.isPending\}/);
    // ofl_ord_* journal-first; server UUID checks use API online (void needs real line UUIDs).
    expect(pos).toMatch(
      /preferLocalRestaurantWrites = \(orderId\?: string \| null\) =>\s*shouldUseLocalRestaurantMutation\(isOnline, orderId\)/,
    );

    const payPage = readRepo('samplepos.client/src/pages/orders/OrderPaymentPage.tsx');
    expect(payPage).toMatch(/markRestaurantCheckSettledInJournal/);
    expect(payPage).toMatch(/publishLanKdsBoardChanged/);
  });

  it('Phase 5.3 offline cancel, waiter assign, crash restore from journal', () => {
    const ops = readRepo('samplepos.client/src/lib/restaurantOfflineOps.ts');
    expect(ops).toMatch(/cancelRestaurantCheckOffline/);
    expect(ops).toMatch(/assignRestaurantWaiterOffline/);
    expect(ops).toMatch(/removeRestaurantLinesOffline/);
    expect(ops).toMatch(/seedRestaurantCheckFromServer/);
    expect(ops).toMatch(/ORDER_CANCELLED/);

    const journal = readRepo('samplepos.client/src/lib/offlineEventJournal.ts');
    expect(journal).toMatch(/journalCache/);
    expect(journal).toMatch(/invalidateJournalMemoryCache/);
    expect(journal).toMatch(/appendSyncedEvent/);

    const replayer = readRepo('SamplePOS.Server/src/modules/pos/posEventReplayer.ts');
    expect(replayer).toMatch(/updateOrder/);
    expect(replayer).toMatch(/voidCheckItems/);
    expect(replayer).toMatch(/computeVoidItemsFromUpdatedLines/);
    expect(replayer).toMatch(/cancelOrder/);
    expect(replayer).toMatch(/releaseTableForOrder/);
    expect(replayer).toMatch(/pos_orders/);

    const pos = readRepo('samplepos.client/src/pages/restaurant/RestaurantPosPage.tsx');
    expect(pos).toMatch(/cancelRestaurantCheckOffline/);
    expect(pos).toMatch(/assignRestaurantWaiterOffline/);
    expect(pos).toMatch(/paintJournalCheck/);
    expect(pos).toMatch(/preferLocalRestaurantWrites/);
    expect(pos).toMatch(/refreshRestaurantCheckSeedFromServer/);
    expect(pos).toMatch(/hasPendingRestaurantMutations/);
    expect(pos).toMatch(/syncOfflineSales/);
    expect(pos).toMatch(/resolveDesiredLinesBeforePay/);
    expect(pos).toMatch(/Reconcile voided lines before pay/);
    expect(pos).toMatch(/payRestaurantCheckOffline/);
    expect(pos).toMatch(/deriveRestaurantOpenChecks/);
    expect(pos).toMatch(/Restored .* open check/);

    const opsRefresh = readRepo('samplepos.client/src/lib/restaurantOfflineOps.ts');
    expect(opsRefresh).toMatch(/hasPendingRestaurantMutations/);
    expect(opsRefresh).toMatch(/getLastNonSeedRestaurantLineSnapshot/);
    expect(opsRefresh).toMatch(/resolveDesiredLinesBeforePay/);
    expect(opsRefresh).toMatch(/Skips overwrite when unsynced/);

    // Pay-time reconcile lives on Restaurant FOH (RestaurantPosPage), not OrderPaymentPage.
  });

  it('Phase 5.4 offline split/merge/transfer reuse journal + Phase 4 service', () => {
    const journal = readRepo('samplepos.client/src/lib/offlineEventJournal.ts');
    expect(journal).toMatch(/RESTAURANT_CHECK_TRANSFERRED/);
    expect(journal).toMatch(/RESTAURANT_CHECK_MERGED/);
    expect(journal).toMatch(/RESTAURANT_CHECK_SPLIT/);

    const ops = readRepo('samplepos.client/src/lib/restaurantOfflineOps.ts');
    expect(ops).toMatch(/transferRestaurantCheckOffline/);
    expect(ops).toMatch(/mergeRestaurantChecksOffline/);
    expect(ops).toMatch(/splitRestaurantCheckOffline/);

    const selectors = readRepo('samplepos.client/src/lib/offlineEventSelectors.ts');
    expect(selectors).toMatch(/RESTAURANT_CHECK_SPLIT/);
    expect(selectors).toMatch(/deriveRestaurantSiblingChecks/);

    const replayer = readRepo('SamplePOS.Server/src/modules/pos/posEventReplayer.ts');
    expect(replayer).toMatch(/transferRestaurantCheck/);
    expect(replayer).toMatch(/mergeRestaurantChecks/);
    expect(replayer).toMatch(/splitRestaurantCheck/);
    expect(replayer).toMatch(/resolveSourceOrderIdForSplit/);
    expect(replayer).toMatch(/transferCheck/);
    expect(replayer).toMatch(/mergeChecks/);
    expect(replayer).toMatch(/splitCheck/);

    const syncRoutes = readRepo('SamplePOS.Server/src/modules/pos/syncEventsRoutes.ts');
    expect(syncRoutes).toMatch(/RESTAURANT_CHECK_TRANSFERRED/);
    expect(syncRoutes).toMatch(/RESTAURANT_CHECK_MERGED/);
    expect(syncRoutes).toMatch(/RESTAURANT_CHECK_SPLIT/);

    const pos = readRepo('samplepos.client/src/pages/restaurant/RestaurantPosPage.tsx');
    expect(pos).toMatch(/transferRestaurantCheckOffline/);
    expect(pos).toMatch(/mergeRestaurantChecksOffline/);
    expect(pos).toMatch(/splitRestaurantCheckOffline/);
    expect(pos).toMatch(/preferLocalRestaurantWrites\(order\.id\)/);
    // Move/split must not POST ofl_ord_*/ofl_line_* to the UUID-validated API while "online".
    const splitHandler = pos.slice(pos.indexOf('const runSplit'), pos.indexOf('const toggleGroupSelection'));
    expect(splitHandler).toMatch(/preferLocalRestaurantWrites\(order\.id\)/);
    expect(splitHandler).toMatch(/splitRestaurantCheckOffline/);
    expect(splitHandler).toMatch(/paintAfterSplitMove\(split\.orderId/);
    expect(splitHandler).toMatch(/getTableCheck/);
  });

  it('Phase 5.5 LAN KDS uses journal board + BroadcastChannel (no cloud dependency)', () => {
    const journal = readRepo('samplepos.client/src/lib/offlineEventJournal.ts');
    expect(journal).toMatch(/RESTAURANT_KOT_STATUS/);

    const selectors = readRepo('samplepos.client/src/lib/offlineEventSelectors.ts');
    expect(selectors).toMatch(/deriveRestaurantKitchenBoard/);

    const lan = readRepo('samplepos.client/src/lib/restaurantLanKds.ts');
    expect(lan).toMatch(/BroadcastChannel/);
    expect(lan).toMatch(/publishLanKds/);

    const ops = readRepo('samplepos.client/src/lib/restaurantOfflineOps.ts');
    expect(ops).toMatch(/advanceRestaurantKotOffline/);
    expect(ops).toMatch(/publishLanKdsBoardChanged/);

    const kds = readRepo('samplepos.client/src/pages/restaurant/KitchenDisplayPage.tsx');
    expect(kds).toMatch(/deriveRestaurantKitchenBoard/);
    expect(kds).toMatch(/subscribeLanKds/);
    expect(kds).toMatch(/advanceRestaurantKotOffline/);
    expect(kds).toMatch(/isOnline/);

    const syncRoutes = readRepo('SamplePOS.Server/src/modules/pos/syncEventsRoutes.ts');
    expect(syncRoutes).toMatch(/RESTAURANT_KOT_STATUS/);

    const replayer = readRepo('SamplePOS.Server/src/modules/pos/posEventReplayer.ts');
    expect(replayer).toMatch(/RESTAURANT_KOT_STATUS/);
  });

  it('error integrity: restaurant sync failures surface REVIEW/FAILED (not swallowed)', () => {
    const replayer = readRepo('SamplePOS.Server/src/modules/pos/posEventReplayer.ts');
    expect(replayer).not.toMatch(/Restaurant table link skipped/);
    expect(replayer).toMatch(/Order created but restaurant table link failed/);
    expect(replayer).toMatch(/releaseRestaurantFloorAfterSale/);
    expect(replayer).toMatch(/table release failed/);
    expect(replayer).toMatch(/status: 'REVIEW'/);
    expect(replayer).toMatch(/status: 'FAILED'/);

    const kds = readRepo('samplepos.client/src/pages/restaurant/KitchenDisplayPage.tsx');
    expect(kds).toMatch(/console\.error/);
    expect(kds).toMatch(/toast\.error/);
    expect(kds).not.toMatch(/catch \{\s*\/\/ Fall back/);

    const pos = readRepo('samplepos.client/src/pages/restaurant/RestaurantPosPage.tsx');
    expect(pos).toMatch(/Offline cache warm failed/);
  });

  it('system settings DTO includes restaurantModeEnabled', () => {
    const types = readRepo('shared/types/systemSettings.ts');
    expect(types).toMatch(/restaurantModeEnabled/);
    expect(types).toMatch(/restaurant_mode_enabled/);
  });

  it('module files exist', () => {
    for (const rel of [
      'SamplePOS.Server/src/modules/restaurant/restaurantSettings.ts',
      'SamplePOS.Server/src/modules/restaurant/restaurantRepository.ts',
      'SamplePOS.Server/src/modules/restaurant/restaurantService.ts',
      'SamplePOS.Server/src/modules/restaurant/restaurantRoutes.ts',
      'samplepos.client/src/pages/restaurant/RestaurantPosPage.tsx',
      'samplepos.client/src/hooks/useRestaurantEnabled.ts',
    ]) {
      expect(existsSync(path.join(repoRoot, rel))).toBe(true);
    }
  });
});
