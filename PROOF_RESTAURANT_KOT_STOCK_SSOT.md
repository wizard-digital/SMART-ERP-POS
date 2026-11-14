# PROOF — Restaurant KOT stock (SambaPOS-style)

## Verdict

Restaurant mode: **KOT deducts** inventory/consumable (and AT_SALE recipe ingredients); **void/cancel restores**; **pay does not double-deduct** when `sourceOrderItemId` has open `RESTAURANT_KOT` movements. Menu shows **available + ordered**. Service parents never deduct.

## SSOT

| Concern | Location |
|--------|----------|
| Policy | `shared/restaurant/restaurantKotStockPolicy.ts` |
| Soft FOH warn | `shared/restaurant/restaurantStockPolicy.ts` + `restaurant_allow_oversell` (647) |
| Issue / restore / net / ordered | `SamplePOS.Server/src/modules/restaurant/restaurantKotStockService.ts` |
| Wire fire / void / cancel / menu | `restaurantService.ts` |
| Pay skip + COGS from KOT | `salesService.ts` + `ordersRoutes` `sourceOrderItemId` |
| Offline | `restaurantOfflineOps.ts` (deduct on fire, restore on void, skip on pay if sent) |
| Menu paint | `RestaurantPosPage` + `formatRestaurantMenuStockLabel` |

## Movements

- Out: `ADJUSTMENT_OUT` / `reference_type=RESTAURANT_KOT` / `reference_id=order_item_id`
- In: `ADJUSTMENT_IN` / `reference_type=RESTAURANT_KOT_VOID`
- Oversell ON + short stock at KOT → skip deduct; pay still hard-fails BR-INV-001

## Tests

- `shared/restaurant/restaurantKotStockPolicy.test.ts`
- `SamplePOS.Server/src/modules/restaurant/restaurantKotStock.evidence.test.ts`
- Architecture / FOH evidence updated for KOT deduct
