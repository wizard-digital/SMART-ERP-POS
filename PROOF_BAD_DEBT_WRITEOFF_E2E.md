# Bad Debt Write-off — executed E2E (real Postgres)

Run: 2026-11-01T08:04:52.603Z
Verdict: PASS

Settings PATCH (the operator toggle path) turns the flag on/off. Tax-only PATCH does not clobber it. Flag off blocks post. Write-off DR 5210 / CR 1200 via AccountingCore. Invoice residual, customer.balance, workqueue, AR aging, reports P&L 5210, and ERP fn_get_profit_loss 5210 agree. Reverse restores every surface.

Invoice INV-BD-MVXJOA21 total 10000.

- PASS coa-5210-1200: {"badDebtExpense":true,"ar":true}
- PASS flag-default-off: {"enabled":false}
- PASS workqueue-age-filter: {"min30":10000,"min90":0,"invoice":"INV-BD-MVXJOA21"}
- PASS flag-off-blocks-post: {"blocked":true,"statusCode":403}
- PASS settings-patch-on-and-tax-save-does-not-clobber: {"patchedOn":true,"afterTaxSave":true}
- PASS partial-writeoff-surfaces-agree: {"document":"BD-2026-0001","gl5210":4000,"gl1200":4000,"invoiceDue":6000,"customerBalance":6000,"workqueueDue":6000,"aging":6000,"reportsPnl5210":4000,"erpPnl5210":4000,"erpSection":"OPERATING_EXPENSES","incomeStatement5210":4000,"incomeStatementNet":-4000,"agedBalances":6000,"businessReport5210":4000}
- PASS full-writeoff-clears-ar: {"document":"BD-2026-0002","invoiceDue":0,"invoiceStatus":"PAID","customerBalance":0,"workqueueDue":0,"aging":0,"gl5210Net":10000,"reportsPnl5210":10000,"erpPnl5210":10000}
- PASS reverse-restores-all-surfaces: {"invoiceDue":10000,"invoiceStatus":"UNPAID","customerBalance":10000,"workqueueDue":10000,"aging":10000,"gl5210Net":0,"gl1200NetCredit":0,"reportsPnl5210":0,"erpPnl5210":0}
- PASS settings-patch-off-blocks-post: {"patchedOff":true,"statusCode":403}
