# Sales Targets Integrity (Guru)

Proven: 2026-10-04T15:53:01.747Z
Gates: 30/30

Opt-in flag default off; Money.round precision; Kampala toUtcRange achievement; progress embed; admin self-approve SoD; no client revenue duplicate math; API/UI gated

- PASS MIG_631: 631 creates sales_targets
- PASS MIG_631_NO_ACHIEVED_COL: no stored achievement column (derived SSOT)
- PASS MIG_632_DEFAULT_OFF: 632 flag default FALSE
- PASS MIG_633_SCOPES: 633 adds GENERAL + TEAM + team tables
- PASS SETTINGS_HELPER: flag helper pre-migration safe
- PASS SYS_TYPES: systemSettings maps salesTargetsEnabled
- PASS SETTINGS_UI: Settings toggle + query invalidate
- PASS SERVER_MOUNT: mounted under /api/sales-targets + pos plan feature
- PASS ROUTE_ENABLED: /enabled before requireSalesTargetsEnabled
- PASS ROUTE_PROGRESS: /progress before /:id
- PASS ROUTE_DISABLED_CODE: disabled tenants get ERR_SALES_TARGETS_DISABLED
- PASS RBAC_KEYS: targets.* in permission catalog
- PASS ACH_MONEY: achievement uses Money.round
- PASS REPO_MONEY: repository money() uses Money.round
- PASS REPO_TZ: achievement bounds sale_date via Kampala UTC range (not UTC::date)
- PASS PROGRESS_BIZDATE: progress asOf uses getBusinessDate
- PASS PROGRESS_PRIORITY: progress priority + advisory lock against duplicate live targets
- PASS CLIENT_NO_REV_MATH: strip fetches server progress — no client revenue math
- PASS PREC_HALF_UP: Money half-up: 10.005 → 10.01
- PASS PREC_VOIDED_BY_RETURN: VOIDED_BY_RETURN + refund nets to zero
- PASS PREC_VOID_EXCL: VOID sales excluded
- PASS SOD_MANAGER: non-admin creator cannot self-approve
- PASS SOD_ADMIN_OK: ADMIN/SUPER_ADMIN may self-approve
- PASS ZOD_NO_MASS_ASSIGN: CreateSalesTargetSchema is .strict() without achievement/status fields
- PASS EMBED_SALES: Sales embeds strip
- PASS EMBED_DASH: Dashboard embeds strip
- PASS NAV_FLAG: nav gated by tenant flag
- PASS ROUTE_GATE: routes wrapped in feature gate
- PASS API_CLIENT: client API: enabled + progress
- PASS STRIP_FLAG: strip respects feature flag
