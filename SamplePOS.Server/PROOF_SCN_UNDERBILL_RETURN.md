# PROOF: SCN under-bill return ceiling

**Result:** PASS
**As of:** 2026-09-23T06:13:57.989Z

## Scenario (Henber)

| Field | Value |
|---|---|
| Return goods | 88004 |
| Bill Subtotal | 88004 |
| Bill TotalAmount (AP) | 88000 |
| SCN AP cap | 88000 |
| PPV reverse (5020) | 4 |

## Claims
- Return line sum can exceed SI TotalAmount when SI was under-billed (Subtotal=GR, Total=supplier AP)
- Create Credit Note caps SCN AP at bill TotalAmount when return ≤ Subtotal
- Paid bills are allowed — return SCNs post on-account (no ERR_SCN_EXCEEDS_BILL_OPEN)
- GL: DR AP (capped) + DR 5020 (variance) / CR clearing (return goods)

## Gates
- ✅ `SCENARIO_EXCEED_TOTAL` — 88004 > AP 88000
- ✅ `SCENARIO_WITHIN_SUBTOTAL` — 88004 ≤ Subtotal 88004
- ✅ `SCENARIO_VARIANCE` — PPV reverse 4
- ✅ `CAP_AT_BILL_TOTAL` — cap SCN when return ≤ Subtotal and > TotalAmount
- ✅ `ERR_EXCEEDS_BILL_KEPT` — hard fail when return exceeds Subtotal too
- ✅ `NO_OPEN_BALANCE_GATE` — paid bills allowed — on-account SCN
- ✅ `HEADER_USES_SCN_AMOUNT` — SCN document amounts = capped AP
- ✅ `GL_SPLIT_GOODS_VS_AP` — GL clearing = goods; AP = scnAmount
- ✅ `GL_PPV_LINE` — SCN GL balances under-bill via 5020
- ✅ `GL_AP_DEBIT` — AP debit 88000
- ✅ `GL_CLEARING_CREDIT` — clearing credit 88004
- ✅ `GL_PPV_DEBIT` — PPV debit 4
- ✅ `GL_BALANCED` — DR=88004 CR=88004
- ✅ `GL_NO_PURCHASE_RETURNS` — return path uses clearing not 5010
