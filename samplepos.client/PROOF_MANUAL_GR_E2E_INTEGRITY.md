# PROOF — Manual GR E2E integrity

**Verdict:** PASS
**Generated:** 2026-09-23T06:13:52.793Z
**Gates:** 10/10

- PASS `BEH_CREATE_STATUSES` — Create: PO PENDING + GR DRAFT; post: PO COMPLETED
- PASS `BEH_LINE_PARITY` — Manual lines: ordered must equal received
- PASS `BEH_FINALIZE_MATRIX` — Finalize open for PENDING and legacy COMPLETED+manual; blocked for normal COMPLETED
- PASS `BEH_PO_ALLOW_SSOT` — poAllowsGoodsReceiptFinalize matches Manual GR matrix
- PASS `WIRE_MANUAL_PO_PENDING` — createManualPO inserts PENDING + manual_receipt — never COMPLETED before GR post
- PASS `WIRE_ORDERED_EQ_RECEIVED` — Manual create path forces ordered = received (UI + server)
- PASS `WIRE_SAVE_AS_DRAFT` — ManualGRModal: Save as Draft + MANUAL source + supplier XOR PO
- PASS `WIRE_PO_MANUAL_FLAG_API` — GR get/list exposes poManualReceipt; detail Finalize uses it
- PASS `WIRE_SERVER_RECEIVE_MANUAL` — assertPOAllowsReceiving allows manual PENDING/COMPLETED; finalize syncs PO
- PASS `WIRE_FINALIZE_CTA` — Detail shows Finalize when receivable; clarifying banner for manual shells

## Integrity
Manual GR E2E: PO PENDING+manual_receipt on create, GR DRAFT until Finalize, ordered=received, legacy COMPLETED+manual still receivable, sync sole COMPLETED writer — no false “already received” mismatch.
