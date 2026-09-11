# PROOF — Lot write-down / clearance markdown ADMIN-only

**Verdict:** PASS (17/17)
**Proven at:** 2026-09-11T21:30:21.988Z

**Contract:** Clearance markdown (lot write-down) is absolute ADMIN/SUPER_ADMIN only. inventory.adjust must never authorize. Route + service DB role + UI gate + live HTTP 403.

**Error code:** `ERR_LOT_WRITE_DOWN_ADMIN_ONLY`

- PASS `ERR_CODE`: ERR_LOT_WRITE_DOWN_ADMIN_ONLY
- PASS `MSG`: Clearance markdown (lot write-down) can only be performed by an ADMIN.
- PASS `ADMIN_OK`: ADMIN
- PASS `SUPER_ADMIN_OK`: SUPER_ADMIN
- PASS `MANAGER_DENY`: MANAGER denied
- PASS `CASHIER_DENY`: CASHIER/STAFF denied
- PASS `NULL_DENY`: null/undefined denied
- PASS `ROUTE_NO_INVENTORY_ADJUST`: route never grants via requirePermission(inventory.adjust)
- PASS `ROUTE_ADMIN_MIDDLEWARE`: HTTP middleware checks users.role + ADMIN SSOT
- PASS `SERVICE_DB_ROLE`: posting transaction re-checks DB role (JWT alone insufficient)
- PASS `UI_ADMIN_GATE`: Clearance markdown button requires ADMIN
- PASS `SSOT_DOCUMENTED`: SSOT documents no adjust bypass
- PASS `LIVE_USES_ADMIN_USER`: live proof posts only as ADMIN/SUPER_ADMIN
- PASS `LIVE_HTTP_CASHIER_403`: live surfaces prove cashier HTTP → 403
- PASS `LIVE_HTTP_MANAGER_403`: live surfaces prove manager HTTP → 403 (adjust cannot bypass)
- PASS `LIVE_SERVICE_MANAGER_DENY`: live surfaces prove MANAGER service call rejected with ADMIN-only code
- PASS `EXEC_MANAGER_CASHIER`: execution proof rejects MANAGER and CASHIER codes

```bash
cd SamplePOS.Server && npm run proof:lot-write-down:admin
cd SamplePOS.Server && npm run proof:lot-write-down
cd SamplePOS.Server && npm run proof:lot-write-down:live
```
