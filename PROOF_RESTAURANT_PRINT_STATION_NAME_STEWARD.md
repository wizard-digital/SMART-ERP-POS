# PROOF: Restaurant print — station name + Steward

**Verdict: PASS** (2026-11-14)

## Requirement

- Printed documents show the **station name** (e.g. `bar`), not the station code (`002`).
- Guest bill shows the user as **Steward**, not Waiter.
- KOT and bill use the **same** Steward reading.

## Proof

Behavioral vitest:

- `restaurant-print-station-name-steward.evidence.test.ts` — KOT HTML `Station: bar` + `Steward: …`; bill HTML Steward; no Waiter label; server/offline gates.
- `restaurant-kot-sent-by.evidence.test.ts` — Steward SSOT retained.
- `restaurant-station-printer-routing.evidence.test.ts` — printer still routes by station **code**.

## Implementation SSOT

| Surface | Behavior |
|--------|----------|
| Server `kotToPrintPayload` | `station` = name; `stationCode` = code; `stewardName` + `waiterName` |
| Server `requestBill` | `stewardName` + `waiterName` (same person) |
| KOT thermal | `Steward:` via shared html/escpos renderers |
| Guest bill | meta label `Steward` via `thermalGuestDocument` |
| Offline KOT | ticket.station = name; ticket.stationCode = code for printer map |
