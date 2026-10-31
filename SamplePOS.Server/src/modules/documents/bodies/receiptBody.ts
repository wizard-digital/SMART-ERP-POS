/**
 * ReceiptBody — POS sale receipt.
 *
 * Designed primarily for thermal receipt paper (RECEIPT_80MM / RECEIPT_58MM)
 * but also degrades gracefully on A4/A5 (auto via Layout primitives).
 */

import type { LayoutContext } from '../baseDocumentLayout.js';
import { Layout } from '../baseDocumentLayout.js';
import { Money } from '../../../utils/money.js';
import { giftPaymentLabel } from '@shared/domain/saleGiftFocSsot.js';

export interface ReceiptBodyData {
    sale: {
        saleNumber: string;
        saleDate: string | null;
        customerName: string | null;
        customerPhone?: string | null;
        customerEmail?: string | null;
        cashierName: string | null;
        paymentMethod: string;
        status: string;
        subtotal: number;
        taxAmount: number;
        taxName?: string | null;
        discountAmount: number;
        totalAmount: number;
        amountPaid: number;
        changeAmount: number;
    };
    items: Array<{
        productName: string;
        quantity: number;
        unitPrice: number;
        lineTotal: number;
        taxAmount?: number;
        taxRate?: number;
        isTaxable?: boolean;
    }>;
    paymentLines: Array<{
        paymentMethod: string;
        amount: number;
        reference?: string | null;
    }>;
    /** Prefer system receipt flag; falls back to invoice theme flag when omitted */
    showTaxBreakdown?: boolean;
    taxRows?: Array<{ label: string; amount: number }>;
    verificationPayload?: string | null;
}

function customerMetaRows(sale: ReceiptBodyData['sale']): Array<[string, string]> {
    const rows: Array<[string, string]> = [
        ['Customer', sale.customerName?.trim() || 'Walk-in'],
    ];
    if (sale.customerPhone?.trim()) {
        rows.push(['Phone', sale.customerPhone.trim()]);
    }
    if (sale.customerEmail?.trim()) {
        rows.push(['Email', sale.customerEmail.trim()]);
    }
    return rows;
}

export function renderReceiptBody(ctx: LayoutContext, data: ReceiptBodyData): void {
    const { theme, paper, doc, contentWidth } = ctx;
    const fmt = (n: number) => Money.formatCurrency(n);

    // ── Sale meta ──
    if (paper.isReceipt) {
        // Single-column compact for thermal paper
        const compact: Array<[string, string]> = [
            ['Date', formatDate(data.sale.saleDate)],
            ['Cashier', data.sale.cashierName ?? '—'],
            ...customerMetaRows(data.sale),
            ['Payment', giftPaymentLabel(data.sale.paymentMethod) || data.sale.paymentMethod],
        ];
        Layout.kvGrid(ctx, compact.map(([label, value]) => ({ label, value })), { columns: 1 });

        // Items: simple list (no table for narrow paper)
        Layout.sectionTitle(ctx, 'Items');
        data.items.forEach(it => {
            doc
                .fillColor(theme.colors.text)
                .font(theme.fonts.familyBold)
                .fontSize(theme.fonts.size.base)
                .text(it.productName, { width: contentWidth, ellipsis: true });
            doc
                .font(theme.fonts.family)
                .fontSize(theme.fonts.size.xs)
                .fillColor(theme.colors.muted)
                .text(`  ${it.quantity} × ${fmt(it.unitPrice)}`, { continued: true })
                .text(`  ${fmt(it.lineTotal)}`, { width: contentWidth, align: 'right' });
            doc.moveDown(0.2);
        });

        Layout.hr(ctx);
        Layout.totalsBlock(
            ctx,
            buildTotalsRows(data, data.showTaxBreakdown ?? theme.flags.showTaxBreakdown),
        );
    } else {
        // A4/A5/Letter — full-width layout
        Layout.kvGrid(ctx, [
            { label: 'Sale Date', value: formatDate(data.sale.saleDate) },
            { label: 'Cashier', value: data.sale.cashierName ?? '—' },
            ...customerMetaRows(data.sale).map(([label, value]) => ({ label, value })),
            { label: 'Payment Method', value: giftPaymentLabel(data.sale.paymentMethod) || data.sale.paymentMethod },
        ]);

        Layout.sectionTitle(ctx, 'Items');
        Layout.table(
            ctx,
            data.items,
            [
                { header: 'Description', key: 'productName' as const, width: 0.55 },
                { header: 'Qty', key: 'quantity' as const, width: 0.1, align: 'right' as const, format: v => String(v) },
                { header: 'Unit Price', key: 'unitPrice' as const, width: 0.15, align: 'right' as const, format: v => fmt(v as number) },
                { header: 'Total', key: 'lineTotal' as const, width: 0.2, align: 'right' as const, format: v => fmt(v as number) },
            ],
        );

        Layout.totalsBlock(
            ctx,
            buildTotalsRows(data, data.showTaxBreakdown ?? theme.flags.showTaxBreakdown),
        );

        if (data.paymentLines.length > 1) {
            Layout.sectionTitle(ctx, 'Payment Breakdown');
            Layout.table(
                ctx,
                data.paymentLines,
                [
                    { header: 'Method', key: 'paymentMethod' as const, width: 0.4, format: v => giftPaymentLabel(String(v || '')) || String(v || '') },
                    { header: 'Reference', key: 'reference' as const, width: 0.35, format: v => (v as string) || '—' },
                    { header: 'Amount', key: 'amount' as const, width: 0.25, align: 'right' as const, format: v => fmt(v as number) },
                ],
            );
        }
    }

    // ── Footer copy ──
    if (theme.copy.customReceiptNote) {
        doc.moveDown(0.5);
        Layout.text(ctx, theme.copy.customReceiptNote, { align: 'center', width: contentWidth });
    }
}

function formatDate(d: string | null): string {
    if (!d) return '—';
    return new Date(d).toLocaleString('en-US', { timeZone: 'Africa/Kampala' });
}

function buildTotalsRows(
    data: ReceiptBodyData,
    showTax: boolean,
): Array<{ label: string; value: string; emphasize?: boolean }> {
    const fmt = (n: number) => Money.formatCurrency(n);
    const taxName = data.sale.taxName || 'Tax';
    const taxRows =
        showTax && data.sale.taxAmount > 0
            ? data.taxRows && data.taxRows.length > 0
                ? data.taxRows.map((r) => ({ label: r.label, value: fmt(r.amount) }))
                : [{ label: taxName, value: fmt(data.sale.taxAmount) }]
            : [];
    return [
        { label: 'Subtotal', value: fmt(data.sale.subtotal) },
        ...(data.sale.discountAmount > 0
            ? [{ label: 'Discount', value: `-${fmt(data.sale.discountAmount)}` }]
            : []),
        ...taxRows,
        { label: 'Total', value: fmt(data.sale.totalAmount), emphasize: true },
        { label: 'Paid', value: fmt(data.sale.amountPaid) },
        ...(data.sale.changeAmount > 0
            ? [{ label: 'Change', value: fmt(data.sale.changeAmount) }]
            : []),
    ];
}
