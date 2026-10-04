# Sales Targets UI SSOT

Proven: 2026-10-04T15:53:17.494Z
Gates: 25/25

Sales Targets list/detail match AdaptivePage + Expenses patterns (Button, Badge, formatCurrency, ReportBackLink, touch targets, Dialog cancel)

Browser: NOT_AVAILABLE — no Playwright/Cypress in client package; this is source+contract evidence

- PASS ROUTE_LIST: list route registered
- PASS ROUTE_DETAIL: detail route registered
- PASS ROUTE_PERMS: ProtectedRoute uses targets.* permissions (any-of)
- PASS NAV_ITEM: Layout nav Sales Targets present (manage/approve + tenant flag)
- PASS LIST_ADAPTIVE: SalesTargetsPage uses AdaptivePage
- PASS LIST_TOOLBAR: list uses AdaptiveToolbar
- PASS LIST_BACK: list uses ReportBackLink → /sales
- PASS LIST_BUTTON: list uses Button SSOT
- PASS LIST_BADGE: list uses Badge for status
- PASS LIST_CURRENCY: list uses formatCurrency (not ad-hoc formatMoney)
- PASS LIST_KPI_SSOT: list KPI strip uses adaptiveDashboard SSOT
- PASS LIST_TOUCH: list primary controls use touch-target token
- PASS LIST_NO_WINDOW_PROMPT: list has no window.prompt
- PASS EXPENSES_BASELINE: Expenses SSOT still AdaptivePage+Badge
- PASS DETAIL_ADAPTIVE: detail uses AdaptivePage
- PASS DETAIL_BACK: detail back → Sales Targets
- PASS DETAIL_BUTTON: detail uses Button
- PASS DETAIL_BADGE: detail status Badge
- PASS DETAIL_CURRENCY: detail uses formatCurrency
- PASS DETAIL_KPI: detail KPI strip SSOT
- PASS DETAIL_CANCEL_DIALOG: cancel uses Dialog (not window.prompt)
- PASS DETAIL_ACTIONS: approve/submit action hooks present
- PASS DETAIL_TOUCH: detail actions use touch-target token
- PASS LIST_MANAGE_GATE: create gated on targets.manage
- PASS DETAIL_APPROVE_GATE: approve gated on targets.approve
