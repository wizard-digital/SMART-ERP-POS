# PROOF: Production-relevant WIP

- Verdict: **PASS** (4/4)
- Runner: `node scripts/proof-wip-production-relevant.mjs`
- At: 2026-10-12T19:57:25.425Z

## Suites

- **USER_DELETE_FK_RELEASE**: PASS — Permanent user delete — FK release matrix (login rows delete; history reassign/null)
- **QUOTE_CONVERT_ALLOCATED_COST**: PASS — Quotation→sale convert — shared saleAllocatedCostPreview SSOT + BELOW_ALLOCATED_COST
- **MULTISTORE_SOFT_ASSERT**: PASS — Multistore enable — softAssert backfill (heal then warn, do not 400-block enable)
- **ORDER_PAYMENT_SESSION_FAILCLOSED**: PASS — Order payment — POS session policy SSOT; session error fail-closed

## What actually happens

### USER_DELETE_FK_RELEASE
Evidence class: `pure-function + SSOT alignment`
Proven: userFkReleaseAction matrix; SYSTEM_USER_ID === utils/constants (…0000); identity tables → delete-rows; sales/audit/treasury NOT NULL → reassign. Service hard-delete no longer blocked by userHasData (release is the path).
Not proven: releaseAndDeleteUser SQL not executed against a live DB in this pack.

### QUOTE_CONVERT_ALLOCATED_COST
Evidence class: `behavioral-mocked + shared SSOT helper`
Proven: convertQuotationToSale and createSale both use previewProductLineAllocatedCost; convert rejects BELOW_ALLOCATED_COST; saleAllocatedCostPreview unit covers store (no double shortfall) vs legacy FEFO shortfall pad.
Not proven: No real DB FEFO layers; no browser convert click.

### MULTISTORE_SOFT_ASSERT
Evidence class: `structural-source`
Proven: Enable path softAssert: true; softAssert catch warns instead of throw. Missing SELLING store remains hard-fail (bootstrap, not soft).
Not proven: ensurePosSellableFromBatches not invoked under throw in this pack.

### ORDER_PAYMENT_SESSION_FAILCLOSED
Evidence class: `ssot-unit + structural-source`
Proven: Policy helpers execute; OrderPayment fail-closed gate; session-error UX is Retry (matches POS), not Open Register.
Not proven: No React render/click with isSessionError=true.
