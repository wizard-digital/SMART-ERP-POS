# Bad Debt Settings Toggle

Proven: 2026-11-01T06:12:32.359Z
Gates: 8/8

Flag default off. Enable Bad Debt Write-off is outside Save Tax Settings and PATCHes immediately. Reports P&L includes AR_WRITEOFF.

- PASS SQL_DEFAULT_OFF: migration default FALSE
- PASS TYPES_AND_PATCH: DTO + repository PATCH column
- PASS TOGGLE_INSTANT_SAVE: checkbox saves immediately, not via tax form
- PASS NOT_INSIDE_TAX_SAVE: Save Tax Settings payload cannot include the flag
- PASS INVALIDATE_QUERY: saving flag invalidates bad-debt queries
- PASS BANNER_DEEP_LINK: disabled banner opens System → Tax
- PASS WORKQUEUE_AGE_HINT: empty workqueue explains the 30-day filter
- PASS REPORTS_PNL_AR_WRITEOFF: reports + ERP P&L put 5210 write-offs in operating expenses
