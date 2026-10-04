# Sales Targets Progress Embed

Proven: 2026-10-04T15:53:17.459Z
Gates: 15/15

Cashiers see Target/Achieved/Remaining on Sales (and managers on Dashboard) via shared strip; achievement from GET /sales-targets/progress + Money.round; no client revenue duplicate math; manage nav only for targets.manage|approve

- PASS API_PROGRESS_ROUTE: GET /progress registered
- PASS API_PROGRESS_BEFORE_ID: /progress before /:id
- PASS SERVICE_GET_PROGRESS: getProgress reuses calculateTargetAchievement
- PASS SERVICE_TEAM_FALLBACK: managers fall back to team ACTIVE targets; business date SSOT
- PASS MONEY_ROUND: achievement precision uses Money.round SSOT
- PASS API_CLIENT_PROGRESS: api.salesTargets.progress wired
- PASS STRIP_FETCH: strip loads /progress
- PASS STRIP_NO_REVENUE_MATH: strip does not recompute achievement from sales lines
- PASS STRIP_CURRENCY_SSOT: strip uses formatCurrency
- PASS STRIP_KPI_SSOT: strip reuses adaptive KPI_ACCENT
- PASS STRIP_FIELDS: strip surfaces Target / Achieved / Remaining / %
- PASS STRIP_EMPTY_HINT: managers see empty hint on Sales when no ACTIVE target
- PASS SALES_EMBED: SalesPage embeds progress strip
- PASS DASHBOARD_EMBED: Dashboard embeds progress strip
- PASS NAV_MANAGE_ONLY: Layout Sales Targets nav is manage/approve + tenant flag (cashiers use Sales strip)
