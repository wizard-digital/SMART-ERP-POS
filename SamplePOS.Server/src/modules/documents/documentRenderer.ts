/**
 * DocumentRenderer — the SINGLE entry point for every PDF/print export in the ERP.
 *
 * No module is allowed to instantiate pdfkit (or any other PDF library) directly.
 * All exports flow through this dispatcher:
 *
 *     await DocumentRenderer.render(pool, { type: 'INVOICE', id, paperSize }, res)
 *
 * Adding a new document type = adding ONE entry to the resolver table.
 */

import type { Pool } from 'pg';
import type { Writable } from 'stream';
import {
    createDocument,
    finalizeDocument,
    type DocumentMeta,
} from './baseDocumentLayout.js';
import { loadDocumentTheme, type DocumentTheme } from './documentTheme.js';
import type { PaperSize } from './documentTheme.js';
import { invoiceService } from '../invoices/invoiceService.js';
import { salesService } from '../sales/salesService.js';
import { quotationService } from '../quotations/quotationService.js';
import { purchaseOrderService } from '../purchase-orders/purchaseOrderService.js';
import { PricingEngine } from '../../utils/pricingEngine.js';
import { goodsReceiptService } from '../goods-receipts/goodsReceiptService.js';
import { deliveryNoteRepository } from '../delivery-notes/deliveryNoteRepository.js';
import {
    creditDebitNoteService,
    supplierCreditDebitNoteService,
} from '../credit-debit-notes/creditDebitNoteService.js';
import { renderInvoiceBody, type InvoiceBodyData } from './bodies/invoiceBody.js';
import { renderReceiptBody, type ReceiptBodyData } from './bodies/receiptBody.js';
import { systemSettingsService } from '../system-settings/systemSettingsService.js';
import {
    aggregateReceiptTaxLines,
    buildReceiptTaxRows,
    buildReceiptVerificationPayload,
} from '@shared/utils/receiptPrintDisplay.js';
import { renderQuotationBody, type QuotationBodyData } from './bodies/quotationBody.js';
import { hasTaxableQuotationLines, hasQuotationLineDiscounts } from '@shared/utils/quotationCalculations.js';
import {
  quotationDownloadFilename,
  quotationPdfReferenceDisplay,
} from '@shared/utils/quotationReferenceDetails.js';
import { resolveInvoiceSourceQuotation, resolveInvoiceAuthorisedByName } from '../invoices/invoiceSourceQuotation.js';
import {
    renderPurchaseOrderBody,
    type PurchaseOrderBodyData,
} from './bodies/purchaseOrderBody.js';
import {
    renderGoodsReceiptBody,
    type GoodsReceiptBodyData,
} from './bodies/goodsReceiptBody.js';
import {
    renderDeliveryNoteBody,
    type DeliveryNoteBodyData,
} from './bodies/deliveryNoteBody.js';
import { renderCreditNoteBody, type CreditNoteBodyData } from './bodies/creditNoteBody.js';
import {
    renderCustomerStatementBody,
    type CustomerStatementBodyData,
} from './bodies/customerStatementBody.js';
import {
    renderSupplierStatementBody,
    type SupplierStatementBodyData,
} from './bodies/supplierStatementBody.js';
import {
    renderPaymentVoucherBody,
    type PaymentVoucherBodyData,
} from './bodies/paymentVoucherBody.js';
import {
    renderSupplierInvoiceBody,
    type SupplierInvoiceBodyData,
} from './bodies/supplierInvoiceBody.js';
import { getCustomerStatement } from '../customers/customerService.js';
import { findCustomerById } from '../customers/customerRepository.js';
import { getSmartSupplierStatementData } from '../reports/cnDnReportService.js';
import {
    getSupplierPaymentById,
    getSupplierInvoiceWithDetails,
} from '../supplier-payments/supplierPaymentService.js';
import { findAllocationsByPaymentId } from '../supplier-payments/supplierPaymentRepository.js';
import {
    renderProfitLossBody,
    type ProfitLossBodyData,
} from './bodies/profitLossBody.js';
import {
    renderBalanceSheetBody,
    type BalanceSheetBodyData,
} from './bodies/balanceSheetBody.js';
import {
    renderTrialBalanceBody,
    type TrialBalanceBodyData,
} from './bodies/trialBalanceBody.js';
import {
    renderCashFlowBody,
    type CashFlowBodyData,
} from './bodies/cashFlowBody.js';
import {
    renderGeneralLedgerBody,
    type GeneralLedgerBodyData,
} from './bodies/generalLedgerBody.js';
import { renderAgingBody, type AgingBodyData } from './bodies/agingBody.js';
import { getProfitLossReportService } from '../../services/profitLossReportService.js';
import {
    getBalanceSheet,
    getTrialBalance,
    getCashFlowSummary,
} from '../../repositories/glPeriodBalancesRepository.js';
import {
    getLedgerEntries,
    getAccountById,
} from '../../repositories/accountingRepository.js';
import { AgedBalanceService } from '../../services/agedBalanceService.js';
import { Money } from '../../utils/money.js';

// =============================================================================
// REGISTERED DOCUMENT TYPES
// =============================================================================

export type DocumentType =
    | 'INVOICE'
    | 'RECEIPT'
    | 'QUOTATION'
    | 'PURCHASE_ORDER'
    | 'GOODS_RECEIPT'
    | 'DELIVERY_NOTE'
    | 'CREDIT_NOTE'
    | 'CUSTOMER_STATEMENT'
    | 'SUPPLIER_STATEMENT'
    | 'SUPPLIER_INVOICE'
    | 'PAYMENT_VOUCHER'
    | 'PROFIT_LOSS'
    | 'BALANCE_SHEET'
    | 'TRIAL_BALANCE'
    | 'CASH_FLOW'
    | 'GENERAL_LEDGER'
    | 'AGED_RECEIVABLES'
    | 'AGED_PAYABLES';

export interface RenderRequest {
    type: DocumentType;
    /** Business identifier or UUID of the document */
    id: string;
    paperSize?: PaperSize;
    /** When 'preview' = show watermark "DRAFT" if status is draft, etc. */
    variant?: 'final' | 'preview';
    /** Period start (YYYY-MM-DD) — required for statement document types */
    startDate?: string;
    /** Period end (YYYY-MM-DD) — required for statement document types */
    endDate?: string;
}

export interface RenderResult {
    filename: string;
    contentType: 'application/pdf';
}

// =============================================================================
// MAIN RENDER FUNCTION
// =============================================================================

export async function render(
    pool: Pool,
    req: RenderRequest,
    output: Writable,
): Promise<RenderResult> {
    const theme = await loadDocumentTheme(pool);

    switch (req.type) {
        case 'INVOICE':
            return renderInvoice(pool, req, theme, output);
        case 'RECEIPT':
            return renderReceipt(pool, req, theme, output);
        case 'QUOTATION':
            return renderQuotation(pool, req, theme, output);
        case 'PURCHASE_ORDER':
            return renderPurchaseOrder(pool, req, theme, output);
        case 'GOODS_RECEIPT':
            return renderGoodsReceipt(pool, req, theme, output);
        case 'DELIVERY_NOTE':
            return renderDeliveryNote(pool, req, theme, output);
        case 'CREDIT_NOTE':
            return renderCreditNote(pool, req, theme, output);
        case 'CUSTOMER_STATEMENT':
            return renderCustomerStatement(pool, req, theme, output);
        case 'SUPPLIER_STATEMENT':
            return renderSupplierStatement(pool, req, theme, output);
        case 'SUPPLIER_INVOICE':
            return renderSupplierInvoice(pool, req, theme, output);
        case 'PAYMENT_VOUCHER':
            return renderPaymentVoucher(pool, req, theme, output);
        case 'PROFIT_LOSS':
            return renderProfitLoss(pool, req, theme, output);
        case 'BALANCE_SHEET':
            return renderBalanceSheet(pool, req, theme, output);
        case 'TRIAL_BALANCE':
            return renderTrialBalance(pool, req, theme, output);
        case 'CASH_FLOW':
            return renderCashFlow(pool, req, theme, output);
        case 'GENERAL_LEDGER':
            return renderGeneralLedger(pool, req, theme, output);
        case 'AGED_RECEIVABLES':
            return renderAging(pool, req, theme, output, 'RECEIVABLE');
        case 'AGED_PAYABLES':
            return renderAging(pool, req, theme, output, 'PAYABLE');
        default: {
            const _exhaustive: never = req.type;
            throw new Error(`Unsupported document type: ${String(_exhaustive)}`);
        }
    }
}

// =============================================================================
// HELPERS
// =============================================================================

const num = (v: unknown): number => Money.toNumber(Money.parseDb(String(v ?? '0')));
const isoDate = (v: unknown): string | null => {
    if (!v) return null;
    if (typeof v === 'string') return v;
    if (v instanceof Date) return v.toISOString();
    return String(v);
};

// =============================================================================
// INVOICE
// =============================================================================

async function renderInvoice(
    pool: Pool,
    req: RenderRequest,
    theme: DocumentTheme,
    output: Writable,
): Promise<RenderResult> {
    const result = await invoiceService.getInvoiceById(pool, req.id);
    if (!result?.invoice) throw new Error('Invoice not found');
    const inv = result.invoice;

    const cId = inv.customer_id;
    let customer = {
        name: '—',
        email: null as string | null,
        phone: null as string | null,
        address: null as string | null,
    };
    if (cId) {
        const cr = await pool.query(
            'SELECT name, email, phone, address FROM customers WHERE id = $1',
            [cId],
        );
        if (cr.rows[0]) {
            customer = {
                name: cr.rows[0].name ?? '—',
                email: cr.rows[0].email ?? null,
                phone: cr.rows[0].phone ?? null,
                address: cr.rows[0].address ?? null,
            };
        }
    }

    const number = inv.invoice_number;
    const status = String(inv.status ?? 'DRAFT').toUpperCase();

    const meta: DocumentMeta = {
        title: 'INVOICE',
        number,
        subtitle: customer.name,
        watermark:
            status === 'VOID' || status === 'CANCELLED'
                ? 'VOID'
                : status === 'DRAFT'
                    ? 'DRAFT'
                    : undefined,
    };

    const ctx = createDocument(meta, theme, output, { paperSize: req.paperSize ?? 'A4' });

    const resolvedSource = await resolveInvoiceSourceQuotation(pool, inv);
    const invoiceAuthorisedByName = await resolveInvoiceAuthorisedByName(pool, inv);
    const sourceQuotation: InvoiceBodyData['sourceQuotation'] = resolvedSource
      ? {
          quoteNumber: resolvedSource.quoteNumber,
          reference: resolvedSource.reference,
          quotationAuthorisedByName: resolvedSource.quotationAuthorisedByName,
        }
      : null;

    const body: InvoiceBodyData = {
        invoice: {
            invoiceNumber: number,
            issueDate: isoDate(inv.issue_date),
            dueDate: isoDate(inv.due_date),
            status,
            subtotal: num(inv.subtotal),
            taxAmount: num(inv.tax_amount),
            discountAmount: Math.max(0, num(inv.subtotal) - num(inv.total_amount) - num(inv.tax_amount)),
            totalAmount: num(inv.total_amount),
            amountPaid: num(inv.amount_paid) > 0 ? num(inv.amount_paid) : num(inv.total_amount) - num(inv.balance),
            amountDue: num(inv.balance),
            notes: inv.notes ?? null,
        },
        sourceQuotation,
        invoiceAuthorisedByName,
        customer,
        items: (result.items ?? []).map((it, index) => ({
            lineNumber: index + 1,
            productName: it.productName ?? null,
            productCode: it.productCode ?? it.sku ?? null,
            quantity: it.quantity,
            uomName: it.uomName ?? null,
            unitPrice: it.unitPrice,
            lineTotal: it.lineTotal,
        })),
        payments: (result.payments ?? []).map(p => ({
            paymentDate: p.payment_date ? new Date(p.payment_date).toISOString() : '',
            paymentMethod: p.payment_method ?? '—',
            amount: num(p.amount),
            reference: p.reference_number ?? null,
        })),
    };

    renderInvoiceBody(ctx, body);
    finalizeDocument(ctx, meta);

    return { filename: `invoice-${number || req.id}.pdf`, contentType: 'application/pdf' };
}

// =============================================================================
// RECEIPT
// =============================================================================

async function renderReceipt(
    pool: Pool,
    req: RenderRequest,
    theme: DocumentTheme,
    output: Writable,
): Promise<RenderResult> {
    const result = await salesService.getSaleById(pool, req.id);
    // SaleRecord declares camelCase but `SELECT *` returns snake_case
    const s = result.sale as unknown as Record<string, unknown>;
    const items = result.items as unknown as Record<string, unknown>[];
    const paymentLines = (result.paymentLines ?? []) as Record<string, unknown>[];

    let cashierName: string | null = null;
    const soldBy = s.sold_by as string | undefined;
    if (soldBy) {
        const ur = await pool.query(
            'SELECT COALESCE(full_name, email) AS name FROM users WHERE id = $1',
            [soldBy],
        );
        cashierName = (ur.rows[0]?.name as string) ?? null;
    }

    let customerName: string | null = (s.customer_name as string) ?? null;
    let customerPhone: string | null = (s.customer_phone as string) ?? null;
    let customerEmail: string | null = (s.customer_email as string) ?? null;
    if ((!customerName || !customerPhone || !customerEmail) && s.customer_id) {
        const cr = await pool.query(
            'SELECT name, phone, email FROM customers WHERE id = $1',
            [s.customer_id],
        );
        customerName = customerName ?? (cr.rows[0]?.name as string) ?? null;
        customerPhone = customerPhone ?? (cr.rows[0]?.phone as string) ?? null;
        customerEmail = customerEmail ?? (cr.rows[0]?.email as string) ?? null;
    }

    const saleNumber = (s.sale_number as string) ?? '';
    const status = String(s.status ?? 'COMPLETED').toUpperCase();

    const meta: DocumentMeta = {
        title: 'RECEIPT',
        number: saleNumber,
        subtitle: customerName ?? undefined,
        watermark: status === 'VOID' || status === 'CANCELLED' ? 'VOID' : undefined,
    };

    const ctx = createDocument(meta, theme, output, {
        paperSize: req.paperSize ?? 'RECEIPT_80MM',
    });

    const receiptPrint = await systemSettingsService.getReceiptPrintConfig(pool);
    const taxName =
        (await systemSettingsService.getTaxConfig(pool).catch(() => null))?.taxName || 'Tax';
    const lineItems = items.map(it => ({
        productName: (it.product_name as string) ?? '—',
        quantity: num(it.quantity),
        unitPrice: num(it.unit_price),
        lineTotal: num(it.total_price ?? it.line_total),
        taxAmount: num(it.tax_amount),
        taxRate: num(it.tax_rate),
        isTaxable: it.is_taxable === true || num(it.tax_amount) > 0,
    }));
    const taxLines = aggregateReceiptTaxLines(
        lineItems.map((it) => ({
            taxAmount: it.taxAmount,
            taxRate: it.taxRate,
            taxName,
            isTaxable: it.isTaxable,
        })),
        taxName,
    );
    const taxAmount = num(s.tax_amount);
    const taxRows = buildReceiptTaxRows({
        showTaxBreakdown: receiptPrint.showTaxBreakdown !== false,
        taxAmount,
        taxName,
        taxLines,
    });
    const verificationPayload =
        receiptPrint.showQrCode === true
            ? buildReceiptVerificationPayload({
                  saleNumber,
                  totalAmount: num(s.total_amount),
                  taxAmount,
                  saleDate: isoDate(s.sale_date) ?? isoDate(s.created_at) ?? '',
                  companyTin: theme.company.tin || null,
              })
            : null;

    const body: ReceiptBodyData = {
        sale: {
            saleNumber,
            saleDate: isoDate(s.sale_date) ?? isoDate(s.created_at) ?? '',
            customerName,
            customerPhone,
            customerEmail,
            cashierName,
            paymentMethod: (s.payment_method as string) ?? '—',
            status,
            subtotal: num(s.subtotal),
            taxAmount,
            taxName,
            discountAmount: num(s.discount_amount),
            totalAmount: num(s.total_amount),
            amountPaid: num(s.amount_paid ?? s.payment_received),
            changeAmount: num(s.change_amount),
        },
        items: lineItems,
        paymentLines: paymentLines.map(p => ({
            paymentMethod: (p.payment_method as string) ?? '—',
            amount: num(p.amount),
            reference: (p.reference as string) ?? null,
        })),
        showTaxBreakdown: receiptPrint.showTaxBreakdown !== false,
        taxRows,
        verificationPayload,
    };

    renderReceiptBody(ctx, body);
    finalizeDocument(ctx, meta);

    return { filename: `receipt-${saleNumber || req.id}.pdf`, contentType: 'application/pdf' };
}

// =============================================================================
// QUOTATION
// =============================================================================

async function renderQuotation(
    pool: Pool,
    req: RenderRequest,
    theme: DocumentTheme,
    output: Writable,
): Promise<RenderResult> {
    const result = await quotationService.getQuotationById(pool, req.id);
    if (!result) throw new Error('Quotation not found');
    const q = result.quotation;
    const status = String(q.status ?? 'OPEN').toUpperCase();

    const meta: DocumentMeta = {
        title: 'QUOTATION',
        number: quotationPdfReferenceDisplay(q.reference, q.quoteNumber),
        subtitle: q.customerName ?? undefined,
        watermark:
            status === 'CANCELLED' ? 'CANCELLED' : status === 'EXPIRED' ? 'EXPIRED' : undefined,
    };

    const ctx = createDocument(meta, theme, output, { paperSize: req.paperSize ?? 'A4' });

    const lineCalcs = result.items.map((it) => ({
        quantity: Number(it.quantity),
        unitPrice: Number(it.unitPrice),
        discountAmount: Number(it.discountAmount ?? 0),
        isTaxable: it.isTaxable !== false,
        taxRate: Number(it.taxRate ?? 0),
    }));

    const body: QuotationBodyData = {
        showTax: hasTaxableQuotationLines(lineCalcs) && Number(q.taxAmount ?? 0) > 0,
        showDiscount: hasQuotationLineDiscounts(result.items),
        quotation: {
            quoteNumber: q.quoteNumber,
            quoteType: q.quoteType,
            status,
            validFrom: q.validFrom,
            validUntil: q.validUntil,
            customerName: q.customerName,
            customerEmail: q.customerEmail,
            customerPhone: q.customerPhone,
            reference: q.reference,
            description: q.description,
            subtotal: q.subtotal,
            discountAmount: q.discountAmount,
            taxAmount: q.taxAmount,
            totalAmount: q.totalAmount,
            paymentTerms: q.paymentTerms ?? null,
            deliveryTerms: q.deliveryTerms ?? null,
            termsAndConditions: q.termsAndConditions ?? null,
        },
        items: result.items.map(it => ({
            lineNumber: it.lineNumber,
            sku: it.sku,
            description: it.description,
            quantity: it.quantity,
            uomName: it.uomName,
            unitPrice: it.unitPrice,
            discountAmount: it.discountAmount,
            taxAmount: it.taxAmount,
            lineTotal: it.lineTotal,
            isTaxable: it.isTaxable,
            taxRate: it.taxRate,
        })),
    };

    renderQuotationBody(ctx, body);
    finalizeDocument(ctx, meta);

    return {
        filename: quotationDownloadFilename(q.reference, q.quoteNumber || req.id),
        contentType: 'application/pdf',
    };
}

// =============================================================================
// PURCHASE ORDER
// =============================================================================

/**
 * PO service returns camelCase via mapPurchaseOrderRow / mapPurchaseOrderItemRow.
 * Accept both camelCase and DB snake_case so the PDF never renders blank meta.
 */
function pickField(row: Record<string, unknown>, ...keys: string[]): unknown {
    for (const k of keys) {
        if (row[k] !== undefined && row[k] !== null && row[k] !== '') return row[k];
    }
    return undefined;
}

async function renderPurchaseOrder(
    pool: Pool,
    req: RenderRequest,
    theme: DocumentTheme,
    output: Writable,
): Promise<RenderResult> {
    const result = await purchaseOrderService.getPOById(pool, req.id);
    const po = result.po as unknown as Record<string, unknown>;
    const items = result.items as unknown as Record<string, unknown>[];

    const supplierId = pickField(po, 'supplierId', 'supplier_id') as string | undefined;
    let supplier = {
        name: String(pickField(po, 'supplierName', 'supplier_name') ?? '—'),
        email: null as string | null,
        phone: null as string | null,
        address: null as string | null,
        tin: null as string | null,
    };
    if (supplierId) {
        const sr = await pool.query(
            `SELECT "CompanyName" AS name, "Email" AS email, "Phone" AS phone,
              "Address" AS address, "TaxId" AS tin
         FROM suppliers WHERE "Id" = $1`,
            [supplierId],
        );
        if (sr.rows[0]) {
            supplier = {
                name: sr.rows[0].name ?? supplier.name,
                email: sr.rows[0].email ?? null,
                phone: sr.rows[0].phone ?? null,
                address: sr.rows[0].address ?? null,
                tin: sr.rows[0].tin ?? null,
            };
        }
    }

    const poNumber = String(pickField(po, 'poNumber', 'order_number') ?? '');
    const status = String(pickField(po, 'status') ?? 'DRAFT').toUpperCase();

    const meta: DocumentMeta = {
        title: 'PURCHASE ORDER',
        number: poNumber,
        subtitle: supplier.name,
        watermark: status === 'CANCELLED' ? 'CANCELLED' : status === 'DRAFT' ? 'DRAFT' : undefined,
    };

    const ctx = createDocument(meta, theme, output, { paperSize: req.paperSize ?? 'A4' });

    const body: PurchaseOrderBodyData = {
        po: {
            poNumber,
            status,
            orderDate: isoDate(pickField(po, 'orderDate', 'order_date')),
            expectedDate: isoDate(pickField(po, 'expectedDate', 'expected_date', 'expected_delivery_date')),
            totalAmount: num(pickField(po, 'totalAmount', 'total_amount')),
            notes: (pickField(po, 'notes') as string) ?? null,
        },
        supplier,
        items: items.map((it) => {
            const qty = num(pickField(it, 'quantity', 'ordered_quantity'));
            const unitCost = num(pickField(it, 'unitCost', 'unit_price'));
            // SSOT: always qty × unit via PricingEngine (ignore stale total_price)
            const lineTotal = PricingEngine.calculateLineTotal(qty, unitCost)
                .toDecimalPlaces(2)
                .toNumber();
            return {
                productName: String(
                    pickField(it, 'productName', 'product_name') ?? '—',
                ),
                quantity: qty,
                uomName: (pickField(it, 'uomName', 'uom_name') as string) ?? null,
                unitCost,
                lineTotal,
                receivedQuantity: num(
                    pickField(
                        it,
                        'netReceivedQuantity',
                        'receivedQuantity',
                        'net_received_quantity',
                        'received_quantity',
                        'gross_received_quantity',
                    ),
                ),
            };
        }),
    };

    body.po.totalAmount = PricingEngine.calculateDocumentTotal(
        body.items.map((it) => ({ quantity: it.quantity, unitCost: it.unitCost })),
    ).toNumber();

    renderPurchaseOrderBody(ctx, body);
    finalizeDocument(ctx, meta);

    return { filename: `po-${poNumber || req.id}.pdf`, contentType: 'application/pdf' };
}

// =============================================================================
// GOODS RECEIPT
// =============================================================================

async function renderGoodsReceipt(
    pool: Pool,
    req: RenderRequest,
    theme: DocumentTheme,
    output: Writable,
): Promise<RenderResult> {
    const result = await goodsReceiptService.getGRById(pool, req.id);
    // GR uses SQL aliases → runtime is camelCase
    const gr = result.gr as unknown as Record<string, unknown>;
    const items = result.items as unknown as Record<string, unknown>[];

    const grNumber = (gr.grNumber as string) ?? '';
    const status = String(gr.status ?? 'DRAFT').toUpperCase();

    const meta: DocumentMeta = {
        title: 'GOODS RECEIPT NOTE',
        number: grNumber,
        subtitle: (gr.supplierName as string) ?? undefined,
        watermark: status === 'CANCELLED' ? 'CANCELLED' : status === 'DRAFT' ? 'DRAFT' : undefined,
    };

    const ctx = createDocument(meta, theme, output, { paperSize: req.paperSize ?? 'A4' });

    const body: GoodsReceiptBodyData = {
        gr: {
            grNumber,
            status,
            receivedDate: isoDate(gr.receivedDate),
            poNumber: (gr.poNumber as string) ?? null,
            supplierName: (gr.supplierName as string) ?? null,
            receivedByName: (gr.receivedByName as string) ?? null,
            supplierDeliveryNote: (gr.supplierDeliveryNote as string) ?? null,
        },
        items: items.map(it => ({
            productName: (it.productName as string) ?? '—',
            orderedQuantity: num(it.orderedQuantity),
            receivedQuantity: num(it.receivedQuantity),
            uomName: (it.uomName as string) ?? null,
            unitCost: num(it.unitCost),
            batchNumber: (it.batchNumber as string) ?? null,
            expiryDate: isoDate(it.expiryDate),
            isBonus: Boolean(it.isBonus),
        })),
    };

    renderGoodsReceiptBody(ctx, body);
    finalizeDocument(ctx, meta);

    return { filename: `gr-${grNumber || req.id}.pdf`, contentType: 'application/pdf' };
}

// =============================================================================
// DELIVERY NOTE
// =============================================================================

async function renderDeliveryNote(
    pool: Pool,
    req: RenderRequest,
    theme: DocumentTheme,
    output: Writable,
): Promise<RenderResult> {
    const dn = await deliveryNoteRepository.getById(pool, req.id);
    if (!dn) throw new Error('Delivery note not found');

    // Resolve canonical customer name + delivery address (fall back to customer master)
    let resolvedCustomerName = dn.customerName ?? '—';
    let resolvedDeliveryAddress = dn.deliveryAddress;
    if (dn.customerId) {
        const cr = await pool.query(
            'SELECT name, address FROM customers WHERE id = $1',
            [dn.customerId],
        );
        if (cr.rows[0]) {
            resolvedCustomerName = (cr.rows[0].name as string) ?? resolvedCustomerName;
            resolvedDeliveryAddress =
                dn.deliveryAddress ?? (cr.rows[0].address as string) ?? null;
        }
    }

    // Batch-fetch product names for lines
    const productIds = Array.from(new Set(dn.lines.map(l => l.productId).filter(Boolean)));
    const productNameMap = new Map<string, string>();
    if (productIds.length > 0) {
        const pr = await pool.query(
            `SELECT id, name FROM products WHERE id = ANY($1::uuid[])`,
            [productIds],
        );
        pr.rows.forEach(r => productNameMap.set(r.id as string, r.name as string));
    }

    const status = String(dn.status ?? 'DRAFT').toUpperCase();

    const meta: DocumentMeta = {
        title: 'DELIVERY NOTE',
        number: dn.deliveryNoteNumber,
        subtitle: resolvedCustomerName,
        watermark: status === 'DRAFT' ? 'DRAFT' : undefined,
    };

    const ctx = createDocument(meta, theme, output, { paperSize: req.paperSize ?? 'A4' });

    const body: DeliveryNoteBodyData = {
        dn: {
            deliveryNoteNumber: dn.deliveryNoteNumber,
            status,
            deliveryDate: isoDate(dn.deliveryDate),
            quotationNumber: dn.quotationNumber ?? null,
            invoiceNumber: dn.invoiceNumber ?? null,
            customerName: resolvedCustomerName,
            deliveryAddress: resolvedDeliveryAddress,
            driverName: dn.driverName,
            vehicleNumber: dn.vehicleNumber,
            warehouseNotes: dn.warehouseNotes,
            totalAmount: dn.totalAmount,
        },
        lines: dn.lines.map(l => ({
            productName: productNameMap.get(l.productId) ?? null,
            description: l.description,
            quantityDelivered: l.quantityDelivered,
            uomName: l.uomName,
            unitPrice: l.unitPrice,
            lineTotal: l.lineTotal,
        })),
    };

    renderDeliveryNoteBody(ctx, body);
    finalizeDocument(ctx, meta);

    return {
        filename: `dn-${dn.deliveryNoteNumber || req.id}.pdf`,
        contentType: 'application/pdf',
    };
}

// =============================================================================
// CREDIT / DEBIT NOTE  (customer + supplier variants share the body)
// =============================================================================

async function renderCreditNote(
    pool: Pool,
    req: RenderRequest,
    theme: DocumentTheme,
    output: Writable,
): Promise<RenderResult> {
    const customerNote = await creditDebitNoteService.getNoteById(pool, req.id);
    if (customerNote) {
        return renderCustomerNote(pool, req, theme, output, customerNote);
    }
    const supplierNote = await supplierCreditDebitNoteService.getNoteById(pool, req.id);
    if (supplierNote) {
        return renderSupplierNote(pool, req, theme, output, supplierNote);
    }
    throw new Error('Credit/Debit note not found');
}

async function renderCustomerNote(
    pool: Pool,
    req: RenderRequest,
    theme: DocumentTheme,
    output: Writable,
    data: NonNullable<Awaited<ReturnType<typeof creditDebitNoteService.getNoteById>>>,
): Promise<RenderResult> {
    const { note, lineItems } = data;

    let party = {
        label: 'Customer',
        name: note.customerName ?? '—',
        email: null as string | null,
        phone: null as string | null,
        address: null as string | null,
    };
    if (note.customerId) {
        const cr = await pool.query(
            'SELECT name, email, phone, address FROM customers WHERE id = $1',
            [note.customerId],
        );
        if (cr.rows[0]) {
            party = {
                ...party,
                name: cr.rows[0].name ?? party.name,
                email: cr.rows[0].email ?? null,
                phone: cr.rows[0].phone ?? null,
                address: cr.rows[0].address ?? null,
            };
        }
    }

    const isCredit = note.documentType === 'CREDIT_NOTE';
    const title = isCredit ? 'CREDIT NOTE' : 'DEBIT NOTE';
    const status = String(note.status ?? 'DRAFT').toUpperCase();

    const meta: DocumentMeta = {
        title,
        number: note.invoiceNumber,
        subtitle: party.name,
        watermark:
            status === 'CANCELLED' ? 'CANCELLED' : status === 'DRAFT' ? 'DRAFT' : undefined,
    };

    const ctx = createDocument(meta, theme, output, { paperSize: req.paperSize ?? 'A4' });

    const body: CreditNoteBodyData = {
        note: {
            invoiceNumber: note.invoiceNumber,
            documentType: note.documentType,
            referenceInvoiceNumber: note.referenceInvoiceNumber ?? null,
            issueDate: note.issueDate ?? null,
            status,
            subtotal: note.subtotal,
            taxAmount: note.taxAmount,
            totalAmount: note.totalAmount,
            reason: note.reason,
            notes: note.notes,
            returnsGoods: note.returnsGoods,
        },
        party,
        items: lineItems.map(li => ({
            lineNumber: li.lineNumber,
            productName: li.productName,
            description: li.description,
            quantity: li.quantity,
            unitPrice: li.unitPrice,
            taxAmount: li.taxAmount,
            lineTotal: li.lineTotal,
        })),
    };

    renderCreditNoteBody(ctx, body);
    finalizeDocument(ctx, meta);

    return {
        filename: `${isCredit ? 'cn' : 'dn'}-${note.invoiceNumber || req.id}.pdf`,
        contentType: 'application/pdf',
    };
}

// =============================================================================
// CUSTOMER STATEMENT
// =============================================================================

async function renderCustomerStatement(
    pool: Pool,
    req: RenderRequest,
    theme: DocumentTheme,
    output: Writable,
): Promise<RenderResult> {
    const stmt = await getCustomerStatement(
        req.id,
        req.startDate,
        req.endDate,
        1,
        1000,
        pool,
    );

    // Resolve customer contact details
    const customerRow = (await findCustomerById(req.id, pool)) as Record<string, unknown> | null;

    const customer = {
        name: (customerRow?.name as string) ?? '—',
        email: (customerRow?.email as string) ?? null,
        phone: (customerRow?.phone as string) ?? null,
        address: (customerRow?.address as string) ?? null,
    };

    const meta: DocumentMeta = {
        title: 'CUSTOMER STATEMENT',
        number: `${stmt.periodStart} → ${stmt.periodEnd}`,
        subtitle: customer.name,
    };

    const ctx = createDocument(meta, theme, output, { paperSize: req.paperSize ?? 'A4' });

    const body: CustomerStatementBodyData = {
        customer,
        period: { start: stmt.periodStart, end: stmt.periodEnd },
        openingBalance: stmt.openingBalance,
        closingBalance: stmt.closingBalance,
        entries: stmt.entries
            .filter(e => e.type !== 'OPENING')
            .map(e => ({
                date: e.date,
                type: e.type,
                reference: e.reference ?? null,
                description: e.description ?? null,
                debit: e.debit,
                credit: e.credit,
                balanceAfter: e.balanceAfter,
            })),
    };

    renderCustomerStatementBody(ctx, body);
    finalizeDocument(ctx, meta);

    return {
        filename: `customer-statement-${req.id}-${stmt.periodEnd}.pdf`,
        contentType: 'application/pdf',
    };
}

// =============================================================================
// SUPPLIER STATEMENT
// =============================================================================

async function renderSupplierStatement(
    pool: Pool,
    req: RenderRequest,
    theme: DocumentTheme,
    output: Writable,
): Promise<RenderResult> {
    if (!req.startDate || !req.endDate) {
        throw new Error('startDate and endDate query parameters are required for SUPPLIER_STATEMENT');
    }
    const stmt = await getSmartSupplierStatementData(pool, req.id, req.startDate, req.endDate);

    // Resolve supplier contact details
    const sr = await pool.query(
        `SELECT "CompanyName" AS name, "Email" AS email, "Phone" AS phone, "Address" AS address
       FROM suppliers WHERE "Id" = $1`,
        [req.id],
    );
    const supplier = {
        name: (sr.rows[0]?.name as string) ?? stmt.supplierName ?? '—',
        email: (sr.rows[0]?.email as string) ?? null,
        phone: (sr.rows[0]?.phone as string) ?? null,
        address: (sr.rows[0]?.address as string) ?? null,
    };

    const meta: DocumentMeta = {
        title: 'SUPPLIER STATEMENT',
        number: `${stmt.periodStart} → ${stmt.periodEnd}`,
        subtitle: supplier.name,
    };

    const ctx = createDocument(meta, theme, output, { paperSize: req.paperSize ?? 'A4' });

    const body: SupplierStatementBodyData = {
        supplier,
        period: { start: stmt.periodStart, end: stmt.periodEnd },
        openingBalance: stmt.openingBalance,
        closingBalance: stmt.closingBalance,
        entries: stmt.entries.map(e => ({
            date: e.date,
            type: e.vchType,
            reference: e.vchNo ?? null,
            description: e.particulars ?? null,
            debit: e.debit,
            credit: e.credit,
            balanceAfter: e.balanceAfter,
        })),
    };

    renderSupplierStatementBody(ctx, body);
    finalizeDocument(ctx, meta);

    return {
        filename: `supplier-statement-${req.id}-${stmt.periodEnd}.pdf`,
        contentType: 'application/pdf',
    };
}

// =============================================================================
// SUPPLIER INVOICE (AP bill)
// =============================================================================

async function renderSupplierInvoice(
    pool: Pool,
    req: RenderRequest,
    theme: DocumentTheme,
    output: Writable,
): Promise<RenderResult> {
    const details = await getSupplierInvoiceWithDetails(pool, req.id);
    if (!details) throw new Error('Supplier invoice not found');

    const { invoice, lineItems, allocations } = details;
    const status = String(invoice.status ?? 'DRAFT');
    const meta: DocumentMeta = {
        title: 'SUPPLIER INVOICE',
        number: invoice.invoiceNumber,
        subtitle: invoice.supplierName ?? undefined,
        watermark:
            status.toUpperCase() === 'CANCELLED'
                ? 'CANCELLED'
                : status.toUpperCase() === 'DRAFT'
                    ? 'DRAFT'
                    : undefined,
    };

    const ctx = createDocument(meta, theme, output, { paperSize: req.paperSize ?? 'A4' });

    const body: SupplierInvoiceBodyData = {
        invoice: {
            invoiceNumber: invoice.invoiceNumber,
            supplierInvoiceNumber: invoice.supplierInvoiceNumber ?? null,
            invoiceDate: isoDate(invoice.invoiceDate),
            dueDate: isoDate(invoice.dueDate),
            status,
            subtotal: num(invoice.subtotal ?? invoice.totalAmount),
            taxAmount: num(invoice.taxAmount),
            totalAmount: num(invoice.totalAmount),
            amountPaid: num(invoice.amountPaid),
            outstandingBalance: num(invoice.outstandingBalance),
            notes: invoice.notes ?? null,
        },
        supplier: {
            name: invoice.supplierName ?? '—',
            contactName: invoice.supplierContactName ?? null,
            email: invoice.supplierEmail ?? null,
            phone: invoice.supplierPhone ?? null,
            address: invoice.supplierAddress ?? null,
        },
        lineItems: lineItems.map((item) => ({
            lineNumber: item.lineNumber,
            productName: item.productName,
            quantity: num(item.quantity),
            unitOfMeasure: item.unitOfMeasure,
            unitCost: num(item.unitCost),
            lineTotal: num(item.lineTotal),
        })),
        allocations: allocations.map((a) => ({
            paymentNumber: a.paymentNumber,
            allocationDate: isoDate(a.allocationDate),
            paymentMethod: a.paymentMethod,
            amountAllocated: num(a.amountAllocated),
        })),
    };

    renderSupplierInvoiceBody(ctx, body);
    finalizeDocument(ctx, meta);

    return {
        filename: `supplier-invoice-${invoice.invoiceNumber || req.id}.pdf`,
        contentType: 'application/pdf',
    };
}

// =============================================================================
// PAYMENT VOUCHER (supplier disbursement)
// =============================================================================

async function renderPaymentVoucher(
    pool: Pool,
    req: RenderRequest,
    theme: DocumentTheme,
    output: Writable,
): Promise<RenderResult> {
    const payment = await getSupplierPaymentById(pool, req.id);
    if (!payment) throw new Error('Payment voucher not found');

    // Supplier contact lookup
    const sr = await pool.query(
        `SELECT "CompanyName" AS name, "Email" AS email, "Phone" AS phone, "Address" AS address,
            "ContactName" AS "contactPerson"
       FROM suppliers WHERE "Id" = $1`,
        [payment.supplierId],
    );
    const supplier = {
        name: (sr.rows[0]?.name as string) ?? payment.supplierName ?? '—',
        email: (sr.rows[0]?.email as string) ?? null,
        phone: (sr.rows[0]?.phone as string) ?? null,
        address: (sr.rows[0]?.address as string) ?? null,
        contactPerson: (sr.rows[0]?.contactPerson as string) ?? null,
    };

    const allocations = await findAllocationsByPaymentId(pool, payment.id);

    const paymentNumber = payment.paymentNumber;

    const meta: DocumentMeta = {
        title: 'PAYMENT VOUCHER',
        number: paymentNumber,
        subtitle: supplier.name,
    };

    const ctx = createDocument(meta, theme, output, { paperSize: req.paperSize ?? 'A4' });

    const body: PaymentVoucherBodyData = {
        payment: {
            paymentNumber,
            paymentDate: isoDate(payment.paymentDate),
            paymentMethod: payment.paymentMethod,
            amount: Money.toNumber(Money.parseDb(String(payment.amount ?? '0'))),
            allocatedAmount: Money.toNumber(Money.parseDb(String(payment.allocatedAmount ?? '0'))),
            unallocatedAmount: Money.toNumber(
                Money.parseDb(String(payment.unallocatedAmount ?? '0')),
            ),
            reference: payment.reference,
            notes: payment.notes,
        },
        supplier,
        allocations: (allocations as unknown as Record<string, unknown>[]).map(a => ({
            invoiceNumber: (a.invoiceNumber as string) ?? null,
            allocatedAt: isoDate(a.allocatedAt),
            amount: Money.toNumber(Money.parseDb(String(a.amount ?? '0'))),
        })),
    };

    renderPaymentVoucherBody(ctx, body);
    finalizeDocument(ctx, meta);

    return {
        filename: `payment-voucher-${paymentNumber || req.id}.pdf`,
        contentType: 'application/pdf',
    };
}

async function renderSupplierNote(
    pool: Pool,
    req: RenderRequest,
    theme: DocumentTheme,
    output: Writable,
    data: NonNullable<Awaited<ReturnType<typeof supplierCreditDebitNoteService.getNoteById>>>,
): Promise<RenderResult> {
    const { note, lineItems } = data;

    let party = {
        label: 'Supplier',
        name: note.supplierName ?? '—',
        email: null as string | null,
        phone: null as string | null,
        address: null as string | null,
    };
    if (note.supplierId) {
        const sr = await pool.query(
            `SELECT "CompanyName" AS name, "Email" AS email, "Phone" AS phone, "Address" AS address
         FROM suppliers WHERE "Id" = $1`,
            [note.supplierId],
        );
        if (sr.rows[0]) {
            party = {
                ...party,
                name: sr.rows[0].name ?? party.name,
                email: sr.rows[0].email ?? null,
                phone: sr.rows[0].phone ?? null,
                address: sr.rows[0].address ?? null,
            };
        }
    }

    const isCredit = note.documentType === 'SUPPLIER_CREDIT_NOTE';
    const title = isCredit ? 'SUPPLIER CREDIT NOTE' : 'SUPPLIER DEBIT NOTE';
    const status = String(note.status ?? 'DRAFT').toUpperCase();

    const meta: DocumentMeta = {
        title,
        number: note.invoiceNumber,
        subtitle: party.name,
        watermark:
            status === 'CANCELLED' ? 'CANCELLED' : status === 'DRAFT' ? 'DRAFT' : undefined,
    };

    const ctx = createDocument(meta, theme, output, { paperSize: req.paperSize ?? 'A4' });

    const body: CreditNoteBodyData = {
        note: {
            invoiceNumber: note.invoiceNumber,
            documentType: note.documentType,
            referenceInvoiceNumber: note.referenceInvoiceNumber ?? null,
            issueDate: note.issueDate ?? null,
            status,
            subtotal: note.subtotal,
            taxAmount: note.taxAmount,
            totalAmount: note.totalAmount,
            reason: note.reason,
            notes: note.notes,
            returnsGoods: false,
        },
        party,
        items: (lineItems as unknown as Record<string, unknown>[]).map((li, idx) => ({
            lineNumber: (li.lineNumber as number) ?? idx + 1,
            productName: (li.productName as string) ?? '—',
            description: (li.description as string) ?? null,
            quantity: num(li.quantity),
            unitPrice: num(li.unitPrice),
            taxAmount: num(li.taxAmount),
            lineTotal: num(li.lineTotal),
        })),
    };

    renderCreditNoteBody(ctx, body);
    finalizeDocument(ctx, meta);

    return {
        filename: `s${isCredit ? 'cn' : 'dn'}-${note.invoiceNumber || req.id}.pdf`,
        contentType: 'application/pdf',
    };
}

// =============================================================================
// FINANCIAL REPORTS — Profit & Loss
// =============================================================================

function requireDateRange(req: RenderRequest, label: string): { start: string; end: string } {
    if (!req.startDate || !req.endDate) {
        throw new Error(
            `startDate and endDate query parameters are required for ${label}`,
        );
    }
    return { start: req.startDate, end: req.endDate };
}

function requireAsOfDate(req: RenderRequest, label: string): string {
    const asOf = req.endDate ?? req.startDate;
    if (!asOf) {
        throw new Error(`endDate (as-of date) query parameter is required for ${label}`);
    }
    return asOf;
}

async function renderProfitLoss(
    pool: Pool,
    req: RenderRequest,
    theme: DocumentTheme,
    output: Writable,
): Promise<RenderResult> {
    const { start, end } = requireDateRange(req, 'PROFIT_LOSS');
    const service = getProfitLossReportService(pool);
    const report = await service.getProfitLossReport(start, end);

    const meta: DocumentMeta = {
        title: 'PROFIT & LOSS STATEMENT',
        number: `${start} → ${end}`,
    };
    const ctx = createDocument(meta, theme, output, { paperSize: req.paperSize ?? 'A4' });

    const mapRows = (xs: typeof report.revenueAccounts) =>
        xs.map(r => ({
            accountCode: r.accountCode,
            accountName: r.accountName,
            displayAmount: r.displayAmount,
        }));

    const body: ProfitLossBodyData = {
        periodStart: report.periodStart,
        periodEnd: report.periodEnd,
        revenueAccounts: mapRows(report.revenueAccounts),
        cogsAccounts: mapRows(report.cogsAccounts),
        expenseAccounts: mapRows(report.expenseAccounts),
        summary: {
            totalRevenue: report.summary.totalRevenue,
            totalCogs: report.summary.totalCogs,
            grossProfit: report.summary.grossProfit,
            grossMarginPercent: report.summary.grossMarginPercent,
            totalOperatingExpenses: report.summary.totalOperatingExpenses,
            operatingIncome: report.summary.operatingIncome,
            netIncome: report.summary.netIncome,
            netMarginPercent: report.summary.netMarginPercent,
        },
    };

    renderProfitLossBody(ctx, body);
    finalizeDocument(ctx, meta);
    return { filename: `profit-loss-${start}-to-${end}.pdf`, contentType: 'application/pdf' };
}

// =============================================================================
// FINANCIAL REPORTS — Balance Sheet
// =============================================================================

async function renderBalanceSheet(
    pool: Pool,
    req: RenderRequest,
    theme: DocumentTheme,
    output: Writable,
): Promise<RenderResult> {
    const asOf = requireAsOfDate(req, 'BALANCE_SHEET');
    const data = await getBalanceSheet(asOf, pool);

    const meta: DocumentMeta = { title: 'BALANCE SHEET', number: asOf };
    const ctx = createDocument(meta, theme, output, { paperSize: req.paperSize ?? 'A4' });

    const body: BalanceSheetBodyData = {
        asOfDate: asOf,
        assets: data.assets.map(a => ({
            accountCode: a.accountCode,
            accountName: a.accountName,
            balance: a.balance,
        })),
        liabilities: data.liabilities.map(a => ({
            accountCode: a.accountCode,
            accountName: a.accountName,
            balance: a.balance,
        })),
        equity: data.equity.map(a => ({
            accountCode: a.accountCode,
            accountName: a.accountName,
            balance: a.balance,
        })),
        totalAssets: data.totalAssets,
        totalLiabilities: data.totalLiabilities,
        totalEquity: data.totalEquity,
    };

    renderBalanceSheetBody(ctx, body);
    finalizeDocument(ctx, meta);
    return { filename: `balance-sheet-${asOf}.pdf`, contentType: 'application/pdf' };
}

// =============================================================================
// FINANCIAL REPORTS — Trial Balance
// =============================================================================

async function renderTrialBalance(
    pool: Pool,
    req: RenderRequest,
    theme: DocumentTheme,
    output: Writable,
): Promise<RenderResult> {
    const asOf = requireAsOfDate(req, 'TRIAL_BALANCE');
    const rows = await getTrialBalance(asOf, pool);

    const meta: DocumentMeta = { title: 'TRIAL BALANCE', number: asOf };
    const ctx = createDocument(meta, theme, output, { paperSize: req.paperSize ?? 'A4' });

    const body: TrialBalanceBodyData = {
        asOfDate: asOf,
        rows: rows.map(r => ({
            accountCode: r.accountCode,
            accountName: r.accountName,
            accountType: r.accountType,
            totalDebits: r.totalDebits,
            totalCredits: r.totalCredits,
            balance: r.balance,
        })),
    };

    renderTrialBalanceBody(ctx, body);
    finalizeDocument(ctx, meta);
    return { filename: `trial-balance-${asOf}.pdf`, contentType: 'application/pdf' };
}

// =============================================================================
// FINANCIAL REPORTS — Cash Flow
// =============================================================================

async function renderCashFlow(
    pool: Pool,
    req: RenderRequest,
    theme: DocumentTheme,
    output: Writable,
): Promise<RenderResult> {
    const { start, end } = requireDateRange(req, 'CASH_FLOW');
    const cf = await getCashFlowSummary(start, end, pool);

    const meta: DocumentMeta = { title: 'CASH FLOW STATEMENT', number: `${start} → ${end}` };
    const ctx = createDocument(meta, theme, output, { paperSize: req.paperSize ?? 'A4' });

    const body: CashFlowBodyData = {
        periodStart: start,
        periodEnd: end,
        beginningBalance: cf.beginningBalance,
        periodDebits: cf.periodDebits,
        periodCredits: cf.periodCredits,
        netMovement: cf.netMovement,
        endingBalance: cf.endingBalance,
    };

    renderCashFlowBody(ctx, body);
    finalizeDocument(ctx, meta);
    return { filename: `cash-flow-${start}-to-${end}.pdf`, contentType: 'application/pdf' };
}

// =============================================================================
// FINANCIAL REPORTS — General Ledger
// =============================================================================

async function renderGeneralLedger(
    pool: Pool,
    req: RenderRequest,
    theme: DocumentTheme,
    output: Writable,
): Promise<RenderResult> {
    // req.id is the account UUID, or 'ALL' for full GL
    const isAll = !req.id || req.id.toUpperCase() === 'ALL';
    const accountId = isAll ? undefined : req.id;

    const account = accountId ? await getAccountById(accountId, pool) : null;

    const result = await getLedgerEntries(
        {
            accountId,
            dateFrom: req.startDate,
            dateTo: req.endDate,
            page: 1,
            limit: 1000,
        },
        pool,
    );

    const periodLabel =
        req.startDate && req.endDate ? `${req.startDate} → ${req.endDate}` : 'All Periods';
    const subtitle = account ? `${account.accountCode} — ${account.accountName}` : 'All Accounts';

    const meta: DocumentMeta = {
        title: 'GENERAL LEDGER',
        number: periodLabel,
        subtitle,
    };
    const ctx = createDocument(meta, theme, output, { paperSize: req.paperSize ?? 'A4' });

    const body: GeneralLedgerBodyData = {
        periodStart: req.startDate ?? null,
        periodEnd: req.endDate ?? null,
        accountCode: account?.accountCode ?? null,
        accountName: account?.accountName ?? null,
        entries: result.entries.map(e => ({
            entryDate: e.entryDate,
            accountCode: e.accountCode,
            accountName: e.accountName,
            reference: e.reference ?? '',
            description: e.description ?? '',
            debitAmount: e.debitAmount,
            creditAmount: e.creditAmount,
        })),
        totalCount: result.total,
    };

    renderGeneralLedgerBody(ctx, body);
    finalizeDocument(ctx, meta);

    const fnameAccount = account ? account.accountCode : 'all';
    const fnamePeriod = req.endDate ?? new Date().toISOString().slice(0, 10);
    return {
        filename: `general-ledger-${fnameAccount}-${fnamePeriod}.pdf`,
        contentType: 'application/pdf',
    };
}

// =============================================================================
// FINANCIAL REPORTS — Aged Receivables / Payables
// =============================================================================

async function renderAging(
    pool: Pool,
    req: RenderRequest,
    theme: DocumentTheme,
    output: Writable,
    reportType: 'RECEIVABLE' | 'PAYABLE',
): Promise<RenderResult> {
    const asOf = requireAsOfDate(
        req,
        reportType === 'RECEIVABLE' ? 'AGED_RECEIVABLES' : 'AGED_PAYABLES',
    );
    const report =
        reportType === 'RECEIVABLE'
            ? await AgedBalanceService.agedReceivables(asOf, pool)
            : await AgedBalanceService.agedPayables(asOf, pool);

    const title = reportType === 'RECEIVABLE' ? 'AGED RECEIVABLES' : 'AGED PAYABLES';
    const meta: DocumentMeta = { title, number: asOf };
    const ctx = createDocument(meta, theme, output, { paperSize: req.paperSize ?? 'A4' });

    const body: AgingBodyData = {
        reportType: report.reportType,
        asOfDate: report.asOfDate,
        summary: report.summary,
        entities: report.entities.map(e => ({
            entityName: e.entityName,
            current: e.current,
            days1to30: e.days1to30,
            days31to60: e.days31to60,
            days61to90: e.days61to90,
            over90: e.over90,
            total: e.total,
        })),
        details: report.details.map(d => ({
            entityName: d.entityName,
            invoiceNumber: d.invoiceNumber,
            invoiceDate: d.invoiceDate,
            dueDate: d.dueDate,
            daysOverdue: d.daysOverdue,
            outstandingAmount: d.outstandingAmount,
            bucket: d.bucket,
        })),
    };

    renderAgingBody(ctx, body);
    finalizeDocument(ctx, meta);

    const slug = reportType === 'RECEIVABLE' ? 'aged-receivables' : 'aged-payables';
    return { filename: `${slug}-${asOf}.pdf`, contentType: 'application/pdf' };
}

