# PROOF — Category Intelligence accuracy LIVE

**Verdict:** PASS
**Generated:** 2026-09-20T16:57:17.230Z
**Gates:** 8/8

- PASS `LIVE_DB` — database=pos_system
- PASS `SRC_SSOT_MATCH` — Category Intelligence uses FK + CI name match helper
- PASS `DROPDOWN_NONEMPTY` — categories=81
  - evidence: `{"sample":["ANTICANCER","ART DRUGS","COLD CHAIN( FRIDGE)","CONDOMS","COSMETIC D","COSMETIC U","COSMETIC V","COSMETICS A"]}`
- PASS `DROPDOWN_NO_CI_DUPES` — dropdown names=81 uniqueCI=81
  - evidence: `{"duplicates":[]}`
- PASS `PICK_CATEGORY` — probe category="MEDICINE C" (n=151)
- PASS `SSOT_MATCH_GTE_EXACT` — ssotMatch=151 >= exactTrim=151
  - evidence: `{"category":"MEDICINE C","exactN":151,"ssotN":151}`
- PASS `INTELLIGENCE_INVENTORY_ROWS` — getCategoryInventoryPosition rows=151 (ssot products=151)
  - evidence: `{"rows":151,"productSample":["Aldomet 500mg","Alendronic Acid 70mg tabs 4s","Amady PL 5/4mg 30s"]}`
- PASS `INTELLIGENCE_COVERS_SSOT_PRODUCTS` — inventory rows 151 cover 151 SSOT-matched products
  - evidence: `{"inv":151,"ssotN":151}`

## Integrity
Category Intelligence dropdown is CI-deduped SSOT; filters use category_id + case-insensitive name so reports do not miss products.
