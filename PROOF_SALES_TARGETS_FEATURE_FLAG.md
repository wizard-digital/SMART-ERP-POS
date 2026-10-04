# Sales Targets Feature Flag

Proven: 2026-10-04T15:53:17.459Z
Gates: 8/8

sales_targets_enabled DEFAULT FALSE; Settings toggle; nav/strip/routes/API gated; opt-in per tenant

- PASS SQL_DEFAULT_OFF: migration default FALSE
- PASS SETTINGS_TOGGLE: System Settings has Enable Sales Targets checkbox
- PASS SETTINGS_INVALIDATE: saving flag invalidates enabled query
- PASS HOOK: hook fetches enabled
- PASS API_ENABLED: api.salesTargets.getEnabled
- PASS NAV_GATED: Layout hides Sales Targets when flag off
- PASS STRIP_GATED: progress strip hidden when flag off
- PASS ROUTE_GATED: routes wrapped in SalesTargetsFeatureGate
