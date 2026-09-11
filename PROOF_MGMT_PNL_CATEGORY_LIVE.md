# PROOF — Management P&L Category Live (Sep 2026)

Generated: 2026-09-11T08:08:43.848Z
Passed: true

Total Revenue (KPI): 156000
Category sum: 156000
GL sales / returns / net: 155000 / 240000 / -85000
Gross Profit: 29000
Money In: 155000

- [x] **KPI_EQ_CATEGORY_REVENUE**: summary.totalRevenue 156000 === category sum 156000
- [x] **KPI_EQ_CATEGORY_COGS**: summary.totalCogs 126000 === category sum 126000
- [x] **KPI_EQ_CATEGORY_GP**: summary.grossProfit 29000 === category sum 29000
- [x] **REVENUE_POSITIVE_WHEN_SALES**: period sales revenue 156000 (sales 27)
- [x] **RETURNS_DISCLOSED**: glSalesReturns=240000 glNetRevenue=-85000
- [x] **PRIOR_BUG_SHAPE_FIXED**: Management Total Revenue is not negative while category rows are positive
- [x] **MONEY_IN_NEAR_SALES**: Money In 155000 ≈ GL sales revenue 155000
- [x] **PAYMENT_FILTER_SHRINKS_OR_EQ**: CASH rev 152000 / sales 26 ≤ ALL 156000 / 27
