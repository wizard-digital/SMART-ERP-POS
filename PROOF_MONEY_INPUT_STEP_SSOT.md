# PROOF: Money input spinner step SSOT (Chromium E2E)

- Date: 2026-09-23T22:08:03.561Z
- Runner: `npm run proof:money-input-step`
- Mode: Playwright Chromium (HTML5 validity + ArrowUp/Down + Save)
- MONEY_INPUT_STEP: `1` · HTML min: omitted · money forms: `noValidate`

## Policy
↑↓ on money fields steps by **1** and keeps typed cents (1200.06 → 1201.06).
Never ship `min="0.01"` with `step="1"` (blocks Save on 1000).
Never ship `min="0"` with `step="1"` (Chromium snaps 1200.06 → 1201).
Banking Add Transaction / Transfer: `noValidate` + JS amount > 0.

## Results
- PASS CHROMIUM_BUG_MIN_001_BLOCKS_1000 — {"brokenValidity":{"stepMismatch":true,"valid":false},"brokenSubmitted":false}
- PASS CHROMIUM_MIN0_SNAPS_DECIMALS — got 1201 (must be 1201 snap)
- PASS CHROMIUM_SAVE_1000 — {"submitted":true,"amount":1000}
- PASS CHROMIUM_SAVE_0_05 — {"submitted":true,"amount":0.05}
- PASS CHROMIUM_ARROWUP_PLUS_ONE — got 1201.06
- PASS CHROMIUM_ARROWDOWN_MINUS_ONE — got 1199.06
- PASS WIRING_TXN_FORM_NOVALIDATE — Add Transaction form
- PASS WIRING_TRANSFER_FORM_NOVALIDATE — Transfer form
- PASS WIRING_TXN_STEP_1 — txn-amount step=1
- PASS WIRING_TXN_NO_MIN — txn-amount omits min
- PASS WIRING_NO_MIN_001 — no min=0.01 in banking tab
- PASS WIRING_AMOUNT_GT_ZERO — JS amount > 0
- PASS WIRING_MOVE_MONEY_QUIET — quiet hover
- PASS WIRING_MOVE_MONEY_STEP — move amount step=1 no min
- PASS WIRING_SSOT_STEP — MONEY_INPUT_STEP

## Verdict
**PASS** — Chromium Save + spinner ±1 (cents preserved) proven end-to-end.
