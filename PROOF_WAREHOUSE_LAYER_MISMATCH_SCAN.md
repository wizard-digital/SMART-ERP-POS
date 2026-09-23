# Warehouse layer mismatch — all-tenant scan

**Generated:** 2026-09-18T13:37:38.182Z
**Verdict:** PASS_NO_MISMATCHES (at rest)

## Investigation (MIRABAL / MAIN-f0097255ec)

**Error seen in UI:** `Lot MAIN-f0097255ec: balances=3, batch=4` during Adjust Inventory decrease.

| Check | Result |
|-------|--------|
| Product tenant | `pos_tenant_bliss_interior_ltd` only |
| Multistore tenants in prod | **1** (Bliss). Henber, Dynamics, Acme, Blis, template, system = multistore **off** |
| Layer mismatches now | **0** across all tenants |
| Live lot state | batch=5, SELLING on_hand=5, MAIN has **no** balance row |
| Dual-write @ SELLING | OK (simulate OUT 1 → 4/4, then ROLLBACK) |
| Dual-write @ MAIN | Would fail **insufficient stock** (stock is not on MAIN) |

**SSOT meaning:** for each `inventory_batch_id`, `SUM(inventory_balances.quantity_on_hand)` must equal `inventory_batches.remaining_quantity`. `syncProductQuantity` asserts this and rolls back on drift (`ERR_WAREHOUSE_LAYER_COUPLING`).

**Root cause of the operator failure path:** Adjustments UI defaulted the store to **MAIN** while sellable stock for this SKU sits on **SELLING**. The toast you saw is the warehouse-layer integrity guard when batch vs store balances diverge mid-path. At rest the Bliss layer is currently clean (5=5); the fix is INV-POS SSOT so Adjustments always target SELLING by default and refuse wrong-store OUT with a clear message.

## Tenant summary

- Databases scanned: 7
- Multistore tenants: 1
- Multistore with mismatches: 0
- Target product found in: pos_tenant_bliss_interior_ltd

## Tenants with drift

_(none)_

## Target product detail
### pos_tenant_bliss_interior_ltd
```json
{
  "productId": "9ae85de5-b5f6-44d5-a47f-7129e6c8c60f",
  "aggregates": { "pi": 5, "products_qoh": 5 },
  "rows": [
    {
      "batch_id": "f0097255-ec13-47ff-9a09-267b764a23d2",
      "batch_number": "MAIN",
      "batch_remaining": 5,
      "lot_number": "MAIN-f0097255ec",
      "store_code": "SELLING",
      "on_hand": 5
    }
  ]
}
```

## Reproduce scan

```bash
node SamplePOS.Server/scripts/diag-warehouse-layer-mismatch-all-tenants.mjs
node SamplePOS.Server/scripts/diag-bliss-mirabal-adjust-mismatch.mjs
```
