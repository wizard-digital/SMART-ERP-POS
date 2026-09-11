# PROOF — Management P&L Category KPI SSOT

Generated: 2026-09-11T08:08:41.128Z
Passed: true

- [x] **KPI_FROM_CATEGORY**: summary.totalRevenue/COGS/GP derived from Section 2 category sum
- [x] **GL_RETURNS_FIELD**: exposes glSalesReturns / glNetRevenue for cross-period 4010 disclosure
- [x] **NO_GL_NET_AS_PRIMARY**: does not use GL-net revenue as Management Total Revenue
- [x] **PAYMENT_TO_CATEGORY**: payment method filter passed into getSalesByCategory
- [x] **SPLIT_GL_SALES**: split sales/returns
- [x] **NET_COGS**: net COGS includes refund credits
- [x] **PAYMENT_SCOPE_SUMMARY**: summary totals respect payment method on sale/refund joins
- [x] **SECTION_SCOPED_KPI**: KPI strip switches by visible section
- [x] **SUPPLIER_GATED**: Section 4b respects section filter
- [x] **NO_RETURNS_BANNER**: no noisy returns banner on Management P&L
- [x] **CATEGORY_SUBTITLE**: Section 2 copy matches sale_items SSOT
