# PROOF — Supplier invoice ≤ GRN received value

**Verdict:** PASS
**Proven at:** 2026-09-23T06:13:56.041Z

**Contract:** GR-linked supplier invoices cannot exceed PricingEngine billable total; one SSOT path for validation, billing, GL, and UI preview; linked GRs must be COMPLETED with billable qty

## Gates

- PASS `OVER_NO_PV`: over-GRN rejects even with obsolete PRICE_VARIANCE reason
- PASS `OVER_NO_DISCOUNT`: over-GRN rejects SUPPLIER_DISCOUNT
- PASS `UNDER_NO_PV`: under-GRN rejects obsolete PRICE_VARIANCE reason
- PASS `DIGIT_SHIFT_10X`: ≈10× paper rejected as digit typo (Touren-class)
- PASS `DIGIT_SHIFT_01X`: ≈0.1× paper rejected as digit typo
- PASS `ORDINARY_DISCOUNT_OK`: ordinary under-bill discount still allowed
- PASS `MODULE`: validation module enforces GR ready + PricingEngine SSOT + no over-billing AP + digit-shift guard
- PASS `CREATE_WIRE`: createSupplierInvoice asserts linked GRs then validates variance
- PASS `FROM_GRN_WIRE`: createInvoiceFromGRN validates supplierReportedTotal
- PASS `POST_WIRE`: postInvoiceToGL re-validates before GL
- PASS `ROUTES`: API: from-grn + billable-total preview + varianceReason
- PASS `ROUTES_CANCEL`: cancel unpaid bill route + service wired
- PASS `BLOCK_BILL_REVERSED_GR`: UI + from-grn block Create Supplier Bill after reverse
- PASS `FULL_REVERSE_AUTO_CANCEL_BILLS`: Full reverse: unpaid cancel OK; paid + consumed blocked
- PASS `UI_CANCEL_BILL`: Supplier Payments cancel bill button gated
- PASS `CANCEL_SSOT`: Cancel eligibility shared SSOT + server pre-checks
- PASS `UI_BLOCK_MANUAL_GR`: manual bill UI blocks GR-referenced notes
- PASS `UI_FROM_GRN`: GR billing UI uses server billable total + blocks over-bill + digit-shift typos

## Reproduce

```bash
cd SamplePOS.Server && npm run proof:supplier-invoice-grn-bounds
cd SamplePOS.Server && npx tsx scripts/proof-digit-shift-bill-guard.ts
```
