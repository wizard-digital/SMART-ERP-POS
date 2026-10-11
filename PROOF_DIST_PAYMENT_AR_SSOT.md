# PROOF: Distribution payment → customer invoice AR SSOT

- Runner: `cd SamplePOS.Server && npm test -- --runInBand src/modules/distribution/distPaymentArSsot.evidence.test.ts`
- Verdict: see `PROOF_DIST_PAYMENT_AR_SSOT.json`

## Rule

One payment engine. Distribution UIs are shortcuts only.

| Entry | Posts via |
|---|---|
| Customers → Invoices → Receive Payment | `invoiceService.addPayment` (AR SSOT / DEPOSIT) |
| Sales Order → Payment | `processClearing` → same `addPayment` |
| Distribution → Clearing | `processClearing` → same `addPayment` |

New payments do **not** write `dist_receipts` or `dist_down_payment_clearings`.
Invoice settlement = `invoice_payments` (+ legacy dist rows for history) via `getInvoiceSettlement`.
