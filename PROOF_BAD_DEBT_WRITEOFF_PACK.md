# Bad Debt Write-off — proof pack

Run: 2026-11-01T06:12:24.658Z


## 1. Real Postgres posting integrity

- **PASS** realpg E2E — Tests:       1 passed, 1 total

## 2. Settings toggle wiring + Chromium click

- **PASS** vitest settings wiring — Tests  2 passed (2)
- **PASS** Chromium toggle click vs Save Tax Settings — PASS 6/6 click isolation

## 3. Live API (operator PATCH)

API: http://localhost:3001

- **PASS** API health — 200
- **PASS** Admin login — admin@samplepos.com
- **PASS** GET /api/bad-debt/enabled — enabled=true
- **PASS** GET /api/system-settings exposes badDebtWriteoffEnabled — value=true
- **PASS** PATCH flag on (toggle contract) — badDebtWriteoffEnabled=true
- **PASS** GET /api/bad-debt/enabled after on — enabled=true
- **PASS** Tax-only PATCH does not clobber flag — still enabled
- **PASS** Restore original flag — enabled=true

## Realpg evidence

- PASS coa-5210-1200: `{"badDebtExpense":true,"ar":true}`
- PASS flag-default-off: `{"enabled":false}`
- PASS workqueue-age-filter: `{"min30":10000,"min90":0,"invoice":"INV-BD-MVXFNR2Y"}`
- PASS flag-off-blocks-post: `{"blocked":true,"statusCode":403}`
- PASS settings-patch-on-and-tax-save-does-not-clobber: `{"patchedOn":true,"afterTaxSave":true}`
- PASS partial-writeoff-surfaces-agree: `{"document":"BD-2026-0001","gl5210":4000,"gl1200":4000,"invoiceDue":6000,"customerBalance":6000,"workqueueDue":6000,"aging":6000,"reportsPnl5210":4000,"erpPnl5210":4000,"erpSection":"OPERATING_EXPENSES","businessReport5210":4000}`
- PASS full-writeoff-clears-ar: `{"document":"BD-2026-0002","invoiceDue":0,"invoiceStatus":"PAID","customerBalance":0,"workqueueDue":0,"aging":0,"gl5210Net":10000,"reportsPnl5210":10000,"erpPnl5210":10000}`
- PASS reverse-restores-all-surfaces: `{"invoiceDue":10000,"invoiceStatus":"UNPAID","customerBalance":10000,"workqueueDue":10000,"aging":10000,"gl5210Net":0,"gl1200NetCredit":0,"reportsPnl5210":0,"erpPnl5210":0}`
- PASS settings-patch-off-blocks-post: `{"patchedOff":true,"statusCode":403}`

## Verdict

- PASS: 11
- FAIL: 0
- SKIP: 0

**Overall: PASS**

