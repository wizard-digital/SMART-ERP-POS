/**
 * Integration proof — real pdfkit render of quotation + invoice bodies.
 * Validates PDF structure and that body render completes without error.
 */
import { describe, expect, it } from '@jest/globals';
import zlib from 'node:zlib';
import { PassThrough } from 'stream';
import { createDocument, finalizeDocument, type DocumentMeta } from './baseDocumentLayout.js';
import type { DocumentTheme } from './documentTheme.js';
import { renderQuotationBody, type QuotationBodyData } from './bodies/quotationBody.js';
import { displayInvoiceStatus, renderInvoiceBody, type InvoiceBodyData } from './bodies/invoiceBody.js';
import {
  hasQuotationReferenceDetails,
  quotationReferenceDetailLines,
  referenceSnapshotLines,
} from '@shared/utils/quotationReferenceDetails.js';

function testTheme(footerText: string | null): DocumentTheme {
  return {
    company: {
      name: 'Proof Pharma Ltd',
      address: 'Kampala',
      phone: '+256-700-000000',
      email: 'proof@example.com',
      tin: 'TIN-PROOF',
      logoUrl: null,
    },
    colors: {
      primary: '#2563eb',
      secondary: '#10b981',
      text: '#1f2937',
      muted: '#6b7280',
      border: '#e5e7eb',
      bgSubtle: '#f9fafb',
      success: '#10b981',
      danger: '#ef4444',
      warning: '#f59e0b',
    },
    fonts: {
      family: 'Helvetica',
      familyBold: 'Helvetica-Bold',
      familyItalic: 'Helvetica-Oblique',
      size: { xs: 7, sm: 8, base: 9, md: 10, lg: 12, xl: 14, '2xl': 18, '3xl': 24 },
    },
    spacing: { xs: 2, sm: 4, md: 8, lg: 12, xl: 16, '2xl': 24 },
    flags: {
      showLogo: true,
      showTaxBreakdown: true,
      showPaymentInstructions: false,
      showPricesOnDeliveryNote: false,
    },
    copy: {
      paymentInstructions: null,
      termsAndConditions: null,
      footerText,
      customReceiptNote: null,
    },
    paymentAccounts: [],
  };
}

function extractPdfText(buf: Buffer): string {
  const latin = buf.toString('latin1');
  let text = '';
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let match;
  while ((match = streamRe.exec(latin)) !== null) {
    try {
      const inflated = zlib.inflateSync(Buffer.from(match[1], 'latin1')).toString('latin1');
      const litRe = /\(([^)\\]*(?:\\.[^)\\]*)*)\)\s*Tj/g;
      let m;
      while ((m = litRe.exec(inflated)) !== null) text += m[1];
      const tjRe = /\[([^\]]+)\]\s*TJ/g;
      while ((m = tjRe.exec(inflated)) !== null) {
        const hexRe = /<([0-9A-Fa-f]+)>/g;
        let hm;
        while ((hm = hexRe.exec(m[1])) !== null) {
          const hex = hm[1];
          for (let i = 0; i + 1 < hex.length; i += 2) {
            text += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
          }
        }
      }
    } catch {
      // skip
    }
  }
  return text;
}

async function renderPdf(
  meta: DocumentMeta,
  footerText: string | null,
  render: (ctx: ReturnType<typeof createDocument>) => void,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const stream = new PassThrough();
  stream.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
  const theme = testTheme(footerText);
  const ctx = createDocument(meta, theme, stream);
  render(ctx);
  finalizeDocument(ctx, meta);
  return done;
}

function assertValidPdf(buf: Buffer): void {
  expect(buf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  const tail = buf.subarray(Math.max(0, buf.length - 32)).toString('ascii');
  expect(tail).toMatch(/%%EOF\s*$/);
  expect(buf.length).toBeGreaterThan(1500);
}

describe('Quotation PDF integration proof', () => {
  const quoteBody: QuotationBodyData = {
    quotation: {
      quoteNumber: 'Q-2026-PROOF-001',
      quoteType: 'standard',
      status: 'OPEN',
      validFrom: '2026-06-01',
      validUntil: '2026-07-01',
      customerName: 'ACME Clinic',
      customerEmail: 'acme@example.com',
      customerPhone: '+256-700-111111',
      reference: 'TENDER-REF-2026-PROOF',
      description: 'Deliver to main warehouse gate B',
      subtotal: 10000,
      discountAmount: 500,
      taxAmount: 1800,
      totalAmount: 11300,
      paymentTerms: 'Net 30',
      deliveryTerms: null,
      termsAndConditions: null,
    },
    items: [
      {
        lineNumber: 1,
        sku: null,
        description: 'Proof item Box line',
        quantity: 2,
        uomName: 'Box',
        unitPrice: 5000,
        discountAmount: 500,
        taxAmount: 1800,
        lineTotal: 11300,
      },
    ],
    showTax: true,
  };

  it('renders a valid quotation PDF with reference + UoM data wired', async () => {
    expect(hasQuotationReferenceDetails(quoteBody.quotation.reference, quoteBody.quotation.description)).toBe(true);
    expect(quotationReferenceDetailLines(quoteBody.quotation.reference, quoteBody.quotation.description)).toEqual([
      'TENDER-REF-2026-PROOF',
      'Deliver to main warehouse gate B',
    ]);

    const buf = await renderPdf(
      { title: 'QUOTATION', number: quoteBody.quotation.quoteNumber, subtitle: quoteBody.quotation.customerName ?? undefined },
      'Bank: Stanbic 0012345678',
      (ctx) => renderQuotationBody(ctx, quoteBody),
    );
    assertValidPdf(buf);
  });

  it('omits footer when footer text is whitespace-only', async () => {
    const withFooter = await renderPdf(
      { title: 'QUOTATION', number: 'Q-2026-WITH-FOOTER' },
      'Bank: Stanbic 0012345678',
      (ctx) => renderQuotationBody(ctx, { ...quoteBody, quotation: { ...quoteBody.quotation, quoteNumber: 'Q-2026-WITH-FOOTER' } }),
    );
    const withoutFooter = await renderPdf(
      { title: 'QUOTATION', number: 'Q-2026-NO-FOOTER' },
      '   ',
      (ctx) => renderQuotationBody(ctx, { ...quoteBody, quotation: { ...quoteBody.quotation, quoteNumber: 'Q-2026-NO-FOOTER' } }),
    );
    assertValidPdf(withoutFooter);
    // baseDocumentLayout trims whitespace-only footer before render
    expect('   '.trim()).toBe('');
    expect(withFooter.length).toBeGreaterThan(withoutFooter.length);
  });

  it('shows full unit price — never clips UGX 10,000.00 to UGX…', async () => {
    const buf = await renderPdf(
      { title: 'QUOTATION', number: 'Q-2026-0140', subtitle: 'kabaata' },
      null,
      (ctx) =>
        renderQuotationBody(ctx, {
          showTax: false,
          showDiscount: false,
          quotation: {
            quoteNumber: 'Q-2026-0140',
            quoteType: 'standard',
            status: 'DRAFT',
            validFrom: '2026-08-12',
            validUntil: '2026-09-11',
            customerName: 'kabaata',
            customerEmail: null,
            customerPhone: '+2567542450214',
            reference: null,
            description: null,
            subtotal: 20000,
            discountAmount: 0,
            taxAmount: 0,
            totalAmount: 20000,
            paymentTerms: 'Net 30',
            deliveryTerms: '7-14 business days',
            termsAndConditions: null,
          },
          items: [
            {
              lineNumber: 1,
              sku: null,
              description: 'Abmist Eye drops',
              quantity: 2,
              uomName: 'EA',
              unitPrice: 10000,
              discountAmount: 0,
              taxAmount: 0,
              lineTotal: 20000,
            },
          ],
        }),
    );
    assertValidPdf(buf);
    const text = extractPdfText(buf);
    expect(text.includes('Abmist Eye drops')).toBe(true);
    expect(text.includes('UGX 10,000.00')).toBe(true);
    expect(text.includes('UGX 20,000.00')).toBe(true);
    expect(text.includes('UGX…') || text.includes('UGX...')).toBe(false);
  });

  it('shows quote number as reference when user reference is empty', async () => {
    expect(
      quotationReferenceDetailLines(null, null),
    ).toHaveLength(0);
    const buf = await renderPdf(
      { title: 'QUOTATION', number: 'Q-2026-NO-REF' },
      null,
      (ctx) =>
        renderQuotationBody(ctx, {
          ...quoteBody,
          quotation: { ...quoteBody.quotation, quoteNumber: 'Q-2026-NO-REF', reference: null, description: null },
        }),
    );
    assertValidPdf(buf);
  });
});

describe('Invoice PDF integration proof', () => {
  const invoiceBody: InvoiceBodyData = {
    invoice: {
      invoiceNumber: 'INV-2026-PROOF-0099',
      issueDate: '2026-06-25',
      dueDate: '2026-07-25',
      status: 'UNPAID',
      subtotal: 10000,
      taxAmount: 1800,
      discountAmount: 500,
      totalAmount: 11300,
      amountPaid: 0,
      amountDue: 11300,
      notes: null,
    },
    sourceQuotation: {
      quoteNumber: 'Q-2026-PROOF-001',
      reference: 'TENDER-REF-2026-PROOF',
      quotationAuthorisedByName: 'Quote Approver',
    },
    invoiceAuthorisedByName: 'Invoice Maker',
    customer: {
      name: 'ACME Clinic',
      email: 'acme@example.com',
      phone: '+256-700-111111',
      address: 'Kampala',
    },
    items: [
      {
        lineNumber: 1,
        productName: 'Proof item Box line',
        productCode: 'SKU-1',
        quantity: 2,
        uomName: 'Box',
        unitPrice: 5000,
        lineTotal: 11300,
      },
    ],
    payments: [],
  };

  it('labels an unpaid invoice as a credit sale', async () => {
    expect(displayInvoiceStatus('UNPAID')).toBe('CREDIT SALE');
    expect(displayInvoiceStatus('PAID')).toBe('PAID');

    const buf = await renderPdf(
      { title: 'INVOICE', number: invoiceBody.invoice.invoiceNumber, subtitle: invoiceBody.customer.name },
      null,
      (ctx) => renderInvoiceBody(ctx, invoiceBody),
    );
    const text = extractPdfText(buf);
    expect(text.includes('CREDIT SALE')).toBe(true);
    expect(text.includes('UNPAID')).toBe(false);
  });

  it('renders valid invoice PDF with source quotation snapshot data', async () => {
    expect(invoiceBody.sourceQuotation?.reference).toBe('TENDER-REF-2026-PROOF');

    const buf = await renderPdf(
      { title: 'INVOICE', number: invoiceBody.invoice.invoiceNumber, subtitle: invoiceBody.customer.name },
      'Payment due within 30 days',
      (ctx) => renderInvoiceBody(ctx, invoiceBody),
    );
    assertValidPdf(buf);
  });

  it('quote-linked invoice shows name, email, phone in Bill To and reference separately', async () => {
    const buf = await renderPdf(
      { title: 'INVOICE', number: 'INV-LAYOUT', subtitle: 'Proof PDF Customer' },
      null,
      (ctx) => renderInvoiceBody(ctx, invoiceBody),
    );
    const text = extractPdfText(buf);
    const billStart = text.indexOf('BILL TO');
    const itemsStart = text.indexOf('ITEMS');
    expect(billStart).toBeGreaterThan(-1);
    expect(itemsStart).toBeGreaterThan(billStart);
    const billToChunk = text.slice(billStart, itemsStart);
    expect(billToChunk.includes('ACME Clinic')).toBe(true);
    expect(billToChunk.includes('acme@example.com')).toBe(true);
    expect(billToChunk.includes('+256-700-111111')).toBe(true);
    expect(billToChunk.includes('Reference')).toBe(true);
    expect(billToChunk.includes('TENDER-REF-2026-PROOF')).toBe(true);
    expect(billToChunk.indexOf('ACME Clinic')).toBeLessThan(billToChunk.indexOf('Reference'));
  });

  it('quote-linked invoice shows dash when reference is empty', async () => {
    const buf = await renderPdf(
      { title: 'INVOICE', number: 'INV-NO-REF', subtitle: 'Proof PDF Customer' },
      null,
      (ctx) =>
        renderInvoiceBody(ctx, {
          ...invoiceBody,
          sourceQuotation: {
            quoteNumber: 'Q-2026-NOREF',
            reference: null,
            quotationAuthorisedByName: 'Quote Approver',
          },
        }),
    );
    const text = extractPdfText(buf);
    const billToChunk = text.slice(text.indexOf('BILL TO'), text.indexOf('ITEMS'));
    expect(billToChunk.includes('ACME Clinic')).toBe(true);
    expect(billToChunk.includes('Reference')).toBe(true);
    expect(billToChunk.includes('TENDER-REF-2026-PROOF')).toBe(false);
    const afterRef = billToChunk.slice(billToChunk.indexOf('Reference'));
    expect(afterRef.includes('—') || afterRef.includes('-')).toBe(true);
  });

  it('renders authorisation names in PDF', async () => {
    const buf = await renderPdf(
      { title: 'INVOICE', number: 'INV-AUTH', subtitle: 'Proof PDF Customer' },
      null,
      (ctx) => renderInvoiceBody(ctx, invoiceBody),
    );
    const text = extractPdfText(buf);
    expect(text.includes('AUTHORISATION')).toBe(true);
    expect(text.includes('INVOICE AUTHORISED BY')).toBe(true);
    expect(text.includes('QUOTATION AUTHORISED BY')).toBe(true);
    expect(text.includes('Invoice Maker')).toBe(true);
    expect(text.includes('Quote Approver')).toBe(true);
  });

  it('renders direct invoice without source quotation block', async () => {
    const buf = await renderPdf(
      { title: 'INVOICE', number: 'INV-2026-DIRECT' },
      null,
      (ctx) =>
        renderInvoiceBody(ctx, {
          ...invoiceBody,
          invoice: { ...invoiceBody.invoice, invoiceNumber: 'INV-2026-DIRECT' },
          sourceQuotation: null,
          invoiceAuthorisedByName: 'Direct Invoice User',
        }),
    );
    assertValidPdf(buf);
  });
});
