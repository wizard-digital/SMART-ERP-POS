# PROOF_FEFO_SSOT_ALL_TENANTS

Verdict: **PASS**

Structural: PASS
Tenants: 7/7

## pos_accounting_clean — PASS
- PASS `DB_CONNECTED`: pos_accounting_clean
- PASS `HAS_INVENTORY_BATCHES`: 
- PASS `HAS_PRODUCT_VALUATION`: present
- PASS `HAS_MIN_DAYS_COLUMN`: present
- PASS `HAS_SYSTEM_SETTINGS`: 
- PASS `MULTISTORE_SELF_CONSISTENT`: enabledPath=false store_locations=true
- PASS `FEFO_FLOOR_SAMPLE`: SKIP no sellable batches

## pos_system — PASS
- PASS `DB_CONNECTED`: pos_system
- PASS `HAS_INVENTORY_BATCHES`: 
- PASS `HAS_PRODUCT_VALUATION`: present
- PASS `HAS_MIN_DAYS_COLUMN`: present
- PASS `HAS_SYSTEM_SETTINGS`: 
- PASS `MULTISTORE_SELF_CONSISTENT`: enabledPath=true store_locations=true
- PASS `FEFO_FLOOR_SAMPLE`: product=98cc5e26 cost=1000 lots=1 multistore=true minDaysCol=true statusCol=true

## pos_template — PASS
- PASS `DB_CONNECTED`: pos_template
- PASS `HAS_INVENTORY_BATCHES`: 
- PASS `HAS_PRODUCT_VALUATION`: present
- PASS `HAS_MIN_DAYS_COLUMN`: present
- PASS `HAS_SYSTEM_SETTINGS`: 
- PASS `MULTISTORE_SELF_CONSISTENT`: enabledPath=false store_locations=true
- PASS `FEFO_FLOOR_SAMPLE`: SKIP no sellable batches

## pos_tenant_acme_store — PASS
- PASS `DB_CONNECTED`: pos_tenant_acme_store
- PASS `HAS_INVENTORY_BATCHES`: 
- PASS `HAS_PRODUCT_VALUATION`: present
- PASS `HAS_MIN_DAYS_COLUMN`: present
- PASS `HAS_SYSTEM_SETTINGS`: 
- PASS `MULTISTORE_SELF_CONSISTENT`: enabledPath=false store_locations=true
- PASS `FEFO_FLOOR_SAMPLE`: SKIP no sellable batches

## pos_tenant_proof_alpha_p1c9x — PASS
- PASS `DB_CONNECTED`: pos_tenant_proof_alpha_p1c9x
- PASS `HAS_INVENTORY_BATCHES`: 
- PASS `HAS_PRODUCT_VALUATION`: present
- PASS `HAS_MIN_DAYS_COLUMN`: present
- PASS `HAS_SYSTEM_SETTINGS`: 
- PASS `MULTISTORE_SELF_CONSISTENT`: enabledPath=false store_locations=true
- PASS `FEFO_FLOOR_SAMPLE`: SKIP no sellable batches

## pos_tenant_proof_beta_p1c9x — PASS
- PASS `DB_CONNECTED`: pos_tenant_proof_beta_p1c9x
- PASS `HAS_INVENTORY_BATCHES`: 
- PASS `HAS_PRODUCT_VALUATION`: present
- PASS `HAS_MIN_DAYS_COLUMN`: present
- PASS `HAS_SYSTEM_SETTINGS`: 
- PASS `MULTISTORE_SELF_CONSISTENT`: enabledPath=false store_locations=true
- PASS `FEFO_FLOOR_SAMPLE`: SKIP no sellable batches

## pos_wh_audit — PASS
- PASS `DB_CONNECTED`: pos_wh_audit
- PASS `HAS_INVENTORY_BATCHES`: 
- PASS `HAS_PRODUCT_VALUATION`: present
- PASS `HAS_MIN_DAYS_COLUMN`: present
- PASS `HAS_SYSTEM_SETTINGS`: 
- PASS `MULTISTORE_SELF_CONSISTENT`: enabledPath=true store_locations=true
- PASS `FEFO_FLOOR_SAMPLE`: product=98cc5e26 cost=1250 lots=3 multistore=true minDaysCol=true statusCol=true
