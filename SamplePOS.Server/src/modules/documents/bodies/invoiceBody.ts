/**
 * Invoice PDF body — Bill To: name, email, phone; reference separate when from quotation.
 */
import type { LayoutContext } from '../baseDocumentLayout.js';
import { Layout } from '../baseDocumentLayout.js';
import { Money } from '../../../utils/money.js';

function displayReference(reference: string | null | undefined): string | null {
    const trimmed = reference?.trim();
    return trimmed || null;
}

/** Customer invoices are credit sales. "UNPAID" on the document reads as a collection failure. */
export function displayInvoiceStatus(status: string): string {
    const normalized = status.trim().toUpperCase().replace(/[\s-]+/g, '_');
    if (normalized === 'UNPAID') return 'CREDIT SALE';
    return status;
}

export interface InvoiceBodyData {
    invoice: {
        invoiceNumber: string;
        issueDate: string | null;
        dueDate: string | null;
        status: string;
        subtotal: number;
        taxAmount: number;
        discountAmount: number;
        totalAmount: number;
        amountPaid: number;
        amountDue: number;
        notes: string | null;
    };
    sourceQuotation?: {
        quoteNumber: string;
        reference: string | null;
        quotationAuthorisedByName: string | null;
    } | null;
    invoiceAuthorisedByName: string | null;
    customer: {
        name: string;
        email: string | null;
        phone: string | null;
        address: string | null;
    };
    items: Array<{
        lineNumber: number;
        productName: string | null;
        productCode: string | null;
        quantity: number;
        uomName?: string | null;
        unitPrice: number;
        lineTotal: number;
    }>;
    payments: Array<{
        paymentDate: string;
        paymentMethod: string;
        amount: number;
        reference?: string | null;
    }>;
}

export function renderInvoiceBody(ctx: LayoutContext, data: InvoiceBodyData): void {
    const { theme, doc, contentLeft, contentWidth } = ctx;
    const fmt = (n: number) => Money.formatCurrency(n);
    const fmtDate = (d: string | null) =>
        d ? new Date(d).toLocaleDateString('en-US', { timeZone: 'Africa/Kampala' }) : '—';

    const colW = (contentWidth - theme.spacing.lg) / 2;
    const startY = doc.y;

    const billToLines = [data.customer.name, data.customer.email, data.customer.phone]
        .map((l) => (typeof l === 'string' ? l.trim() : ''))
        .filter((l): l is string => Boolean(l));
    const refText = data.sourceQuotation ? displayReference(data.sourceQuotation.reference) : null;
    const showReferenceRow = !!data.sourceQuotation;
    const leftContentRows =
        billToLines.length
        + (showReferenceRow ? 2 + 1 : 0);

    const metaPairs: Array<[string, string]> = [
        ...(data.sourceQuotation
            ? [['Quotation Number', data.sourceQuotation.quoteNumber] as [string, string]]
            : []),
        ['Issue Date', fmtDate(data.invoice.issueDate)],
        ['Due Date', fmtDate(data.invoice.dueDate)],
        ['Status', displayInvoiceStatus(data.invoice.status)],
        ['Amount Due', fmt(data.invoice.amountDue)],
    ];

    const panelHeight = Math.max(
        20 + leftContentRows * 13 + 16,
        20 + metaPairs.length * 16 + 8,
    );

    // Left: Bill To (+ reference when from quotation)
    doc
        .roundedRect(contentLeft, startY, colW, panelHeight, 4)
        .fillAndStroke(theme.colors.bgSubtle, theme.colors.border);
    doc
        .fillColor(theme.colors.primary)
        .font(theme.fonts.familyBold)
        .fontSize(theme.fonts.size.sm)
        .text('BILL TO', contentLeft + 8, startY + 8, { width: colW - 16 });
    doc.fillColor(theme.colors.text).font(theme.fonts.family).fontSize(theme.fonts.size.base);
    let by = startY + 24;
    billToLines.forEach(l => {
        doc.text(l, contentLeft + 8, by, { width: colW - 16, ellipsis: true });
        by += 13;
    });
    if (showReferenceRow) {
        if (billToLines.length > 0) by += 4;
        doc
            .fillColor(theme.colors.muted)
            .font(theme.fonts.family)
            .fontSize(theme.fonts.size.xs)
            .text('Reference', contentLeft + 8, by, { width: colW - 16 });
        by += 12;
        if (refText) {
            doc
                .fillColor(theme.colors.text)
                .font(theme.fonts.familyBold)
                .fontSize(theme.fonts.size.base)
                .text(refText, contentLeft + 8, by, { width: colW - 16 });
        } else {
            doc
                .fillColor(theme.colors.text)
                .font(theme.fonts.family)
                .fontSize(theme.fonts.size.base)
                .text('—', contentLeft + 8, by, { width: colW - 16 });
        }
    }

    // Right: dates, status, quotation number
    const rightX = contentLeft + colW + theme.spacing.lg;
    doc
        .roundedRect(rightX, startY, colW, panelHeight, 4)
        .fillAndStroke(theme.colors.bgSubtle, theme.colors.border);
    let my = startY + 8;
    metaPairs.forEach(([label, value]) => {
        doc
            .fillColor(theme.colors.muted)
            .font(theme.fonts.family)
            .fontSize(theme.fonts.size.xs)
            .text(label, rightX + 8, my, { width: colW * 0.45 });
        doc
            .fillColor(theme.colors.text)
            .font(theme.fonts.familyBold)
            .fontSize(theme.fonts.size.base)
            .text(value, rightX + colW * 0.45 + 8, my, {
                width: colW * 0.55 - 16,
                align: 'right',
            });
        my += 16;
    });

    doc.y = startY + panelHeight + theme.spacing.lg;
    doc.x = contentLeft;

    Layout.sectionTitle(ctx, 'Items');
    const tableItems = data.items.map((item, index) => ({ ...item, lineNumber: index + 1 }));
    Layout.table(
        ctx,
        tableItems,
        [
            {
                header: '#', key: 'lineNumber' as const, width: 0.08, align: 'left' as const, format: (_v, row) => {
                    const r = row as InvoiceBodyData['items'][number];
                    const code = r.productCode?.trim();
                    return code || String(r.lineNumber);
                }
            },
            { header: 'Description', key: 'productName' as const, width: 0.47, format: (v) => (v as string) || '—' },
            { header: 'Qty', key: 'quantity' as const, width: 0.1, align: 'right' as const, format: (v, row) => {
                const r = row as InvoiceBodyData['items'][number];
                return r.uomName ? `${v} ${r.uomName}` : String(v);
            } },
            { header: 'Unit Price', key: 'unitPrice' as const, width: 0.15, align: 'right' as const, format: (v) => fmt(v as number) },
            { header: 'Total', key: 'lineTotal' as const, width: 0.2, align: 'right' as const, format: (v) => fmt(v as number) },
        ],
    );

    Layout.totalsBlock(ctx, [
        { label: 'Subtotal', value: fmt(data.invoice.subtotal) },
        ...(data.invoice.discountAmount > 0
            ? [{ label: 'Discount', value: `-${fmt(data.invoice.discountAmount)}` }]
            : []),
        ...(theme.flags.showTaxBreakdown && data.invoice.taxAmount > 0
            ? [{ label: 'Tax', value: fmt(data.invoice.taxAmount) }]
            : []),
        { label: 'Total', value: fmt(data.invoice.totalAmount), emphasize: true },
        { label: 'Amount Paid', value: fmt(data.invoice.amountPaid) },
        { label: 'Amount Due', value: fmt(data.invoice.amountDue), emphasize: data.invoice.amountDue > 0 },
    ]);

    if (data.payments.length > 0) {
        Layout.sectionTitle(ctx, 'Payments Received');
        Layout.table(
            ctx,
            data.payments,
            [
                { header: 'Date', key: 'paymentDate' as const, width: 0.2, format: (v) => fmtDate(v as string) },
                { header: 'Method', key: 'paymentMethod' as const, width: 0.25 },
                { header: 'Reference', key: 'reference' as const, width: 0.3, format: (v) => (v as string) || '—' },
                { header: 'Amount', key: 'amount' as const, width: 0.25, align: 'right' as const, format: (v) => fmt(v as number) },
            ],
        );
    }

    if (theme.flags.showPaymentInstructions) {
        // Missing showOnInvoice must mean ON (settings Zod default); only explicit false excludes.
        const onInvoice = theme.paymentAccounts.filter((a) => a.showOnInvoice !== false);
        if (onInvoice.length > 0 || theme.copy.paymentInstructions) {
            Layout.sectionTitle(ctx, 'Payment Instructions');
            if (onInvoice.length > 0) {
                // One line per account — fixed row height must fit multi-line-safe copy.
                // columns:1 so BANK + MOBILE_MONEY both appear (never silent type drop).
                Layout.kvGrid(
                    ctx,
                    onInvoice.map((a) => ({
                        label: a.provider,
                        value: `${a.accountName} — ${a.accountNumber}${a.branchOrCode ? ` (${a.branchOrCode})` : ''}`,
                    })),
                    { columns: 1, rowHeight: 22 },
                );
            }
            if (theme.copy.paymentInstructions) {
                Layout.text(ctx, theme.copy.paymentInstructions);
                doc.moveDown(0.5);
            }
        }
    }

    if (data.invoice.notes) {
        Layout.sectionTitle(ctx, 'Notes');
        Layout.text(ctx, data.invoice.notes);
        doc.moveDown(0.5);
    }

    Layout.sectionTitle(ctx, 'Authorisation');
    const authRows: Array<{ label: string; value: string }> = [];
    if (data.sourceQuotation) {
        authRows.push({
            label: 'Quotation Authorised By',
            value: data.sourceQuotation.quotationAuthorisedByName?.trim() || '—',
        });
    }
    authRows.push({
        label: 'Invoice Authorised By',
        value: data.invoiceAuthorisedByName?.trim() || '—',
    });
    Layout.kvGrid(ctx, authRows, { columns: authRows.length > 1 ? 2 : 1 });
    doc.moveDown(0.3);

    if (theme.copy.termsAndConditions) {
        Layout.sectionTitle(ctx, 'Terms & Conditions');
        Layout.text(ctx, theme.copy.termsAndConditions, { width: contentWidth });
    }
}
