# PROOF: Money input spinner step SSOT (Chromium E2E)

- Date: 2026-09-25T17:47:10.019Z
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
- PASS CHROMIUM_BUG_MIN_001_BLOCKS_200000 — {"wholeBlocked":{"stepMismatch":true,"message":"Please enter a valid value. The two nearest valid values are 199999.01 and 200000.01."},"wholeSubmitted":false}
- PASS SHIPPED_FIELD_STEP_1_NO_MIN — {"noValidate":true,"stepValue":"1","minValue":"","block":"Amount *</label>\n                                                            <input\n                                                                type=\"number\"\n                                                                value={payAmount}\n                                                                onChange={(e) => setPayAmount(e.target.value)}\n                                                                max={payMethod === 'DEPOSIT'\n                                                                    ? depositPaymentCap(selectedInvoice.outstanding, depositBalance.available).toNumber()\n                                                                    : money2(selectedInvoice.outstanding).toNumber()}\n                                                                step=\"1\"\n                                                                placeholder={`Max: ${payMethod === 'DEPOSIT'\n                                                                    ? depositPaymentCap(selectedInvoice.outstanding, depositBalance.available).toFixed(2)\n                                                                    : money2(selectedInvoice.outstanding).toFixed(2)}`}\n                                                                className=\"w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500\"\n                                                                autoFocus\n                                                                required\n                                                            />\n                                                        </div>\n                                                        <div>\n                                                            <label className=\"block text-sm font-medium text-gray-700 mb-1\">"}
- PASS TYPED_200000_SAVES — {"value":"200000","stepMismatch":false,"message":""}
- PASS TYPED_202499_99_SAVES — {"value":"202499.99","stepMismatch":true,"message":"Please enter a valid value. The nearest valid value is 202499."}
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
- PASS WIRING_RECEIVE_NOVALIDATE — Receive Payment form
- PASS WIRING_RECEIVE_STEP — amount step=1, HTML min omitted

## Verdict
**PASS** — Chromium Save + spinner ±1 (cents preserved) proven end-to-end.
