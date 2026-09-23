# PROOF — GRN bill prompt defaults

**Generated:** 2026-09-23T06:14:26.153Z  
**Verdict:** **PASS** (25/25 gates)  
**Scope:** Proven: draft + bill prompt show paper vs GR + variance; paper may exceed GR for visibility; AP posts only at ≤ GR via Bill at GR; rounding reason ≤1 under only

## Out of scope

- Live tenant POST from-grn mutation
- Editable supplier picker (intentionally absent)

## Gates

| Gate | Result | Detail |
|------|--------|--------|
| `TOTAL_PREFILL` | PASS | computed total → 2dp input string |
| `INV_NUMBER` | PASS | INV-{GR} default invoice number |
| `SUPPLIER_LABEL` | PASS | supplier display from GR name or locked fallback |
| `MATCH_EPS` | PASS | paper vs computed match within 0.005 |
| `BUILD_DEFAULTS` | PASS | buildGrnBillPromptDefaults packs all prompt fields |
| `PAPER_OVERRIDE` | PASS | paper override keeps supplier figure; GR total unchanged |
| `VARIANCE_UNDER` | PASS | paper < GR → under; abs + short summary |
| `VARIANCE_OVER` | PASS | paper 701000 vs GR 700999.20 → over 0.80; both figures kept |
| `VARIANCE_MATCH_NONE` | PASS | match when equal; none until paper total entered |
| `ALIGN_TO_GR` | PASS | explicit align-to-GR + over guidance (no silent clamp) |
| `REASON_ROUNDING_GATED` | PASS | rounding reason only when \|diff\| ≤ 1; auto-suggest then |
| `DIGIT_SHIFT_TYPO` | PASS | ≈10× / ≈0.1× paper vs GR flagged as digit typo; ordinary discounts not |
| `UI_IMPORTS_SSOT` | PASS | GoodsReceiptsPage imports bill prompt SSOT |
| `UI_COMPACT_SHELL` | PASS | modal scrolls body; footer sticky with Create bill |
| `UI_VARIANCE_PANEL` | PASS | single variance panel + gated reasons from SSOT |
| `UI_USES_BUILD` | PASS | setBillPrompt uses buildGrnBillPromptDefaults + draft paper carry |
| `UI_DRAFT_MATCH` | PASS | draft GR match check + bill-at-GR action (integrity) |
| `UI_NO_SILENT_CLAMP` | PASS | paper typing is not silently clamped to GR |
| `UI_NO_SUPPLIER_PICKER` | PASS | prompt POST has no supplier picker; only grnId + reported total |
| `UI_BILLABLE_PREVIEW` | PASS | computed amount from server billable-total preview |
| `API_NO_SUPPLIER_ID` | PASS | CreateInvoiceFromGRNSchema has no supplierId field |
| `SVC_SUPPLIER_FROM_GR` | PASS | createInvoiceFromGRN takes supplierId from GR only |
| `SVC_ROUNDING_MAX` | PASS | server rejects ROUNDING when \|diff\| > 1 |
| `SVC_DIGIT_SHIFT` | PASS | server rejects ≈10× / ≈0.1× paper vs GR as digit typo |
| `SSOT_FILE` | PASS | shared/domain/grnBillPromptSsot.ts present |
