/**
 * Store Issue (Goods Issue) — SAP GI / B1 goods-issue print.
 */

import type { LayoutContext } from '../baseDocumentLayout.js';
import { Layout } from '../baseDocumentLayout.js';
import { Money } from '../../../utils/money.js';
import type { StoreIssueDocument } from '../../../../../shared/store-issue/index.js';
import { formatQtyWithUom, storeIssueEntryQty } from '../../../../../shared/store-issue/issuePlan.js';

export interface StoreIssueBodyData {
  header: {
    documentNumber: string;
    status: string;
    issueDate: string | null;
    issuedTo: string;
    storeName: string;
    requestedByName: string | null;
    expenseAccountCode: string;
    notes: string | null;
    reversalReason: string | null;
    totalCost: number;
    posted: boolean;
  };
  items: Array<{
    productName: string;
    sku: string | null;
    requestedQty: number;
    issuedQty: number;
    uomName: string | null;
    unitCost: number | null;
    lineCost: number | null;
  }>;
}

function issuedToLabel(value: string): string {
  const raw = String(value || '').trim();
  if (!raw) return '—';
  return raw.charAt(0) + raw.slice(1).toLowerCase();
}

export function toStoreIssueBodyData(doc: StoreIssueDocument): StoreIssueBodyData {
  return {
    header: {
      documentNumber: doc.documentNumber,
      status: doc.status,
      issueDate: doc.issueDate,
      issuedTo: issuedToLabel(doc.issuedTo),
      storeName: doc.storeLocationName || 'Company stock',
      requestedByName: doc.requestedByName,
      expenseAccountCode: doc.expenseAccountCode || '5150',
      notes: doc.notes,
      reversalReason: doc.reversalReason,
      totalCost: Number(doc.totalCost || 0),
      posted: doc.status === 'POSTED' || doc.status === 'REVERSED',
    },
    items: doc.lines.map((line) => ({
      productName: line.productName || line.productId,
      sku: line.sku ?? null,
      requestedQty: storeIssueEntryQty(line.requestedQtyBase, line.conversionFactor),
      issuedQty: storeIssueEntryQty(line.issuedQtyBase, line.conversionFactor),
      uomName: line.uomName,
      unitCost: line.actualUnitCost,
      lineCost: line.actualLineCost,
    })),
  };
}

function fmtQty(n: number, uomName?: string | null): string {
  return formatQtyWithUom(n, uomName);
}

export function renderStoreIssueBody(ctx: LayoutContext, data: StoreIssueBodyData): void {
  const { theme, doc, contentWidth, contentLeft } = ctx;
  const fmt = (n: number) => Money.formatCurrency(n);
  const fmtDate = (d: string | null) =>
    d ? new Date(d).toLocaleDateString('en-US', { timeZone: 'Africa/Kampala' }) : '—';

  Layout.kvGrid(ctx, [
    { label: 'Document', value: data.header.documentNumber },
    { label: 'Date', value: fmtDate(data.header.issueDate) },
    { label: 'Issue to', value: data.header.issuedTo },
    { label: 'From store', value: data.header.storeName },
    { label: 'Requested by', value: data.header.requestedByName ?? '—' },
    { label: 'Status', value: data.header.status },
    { label: 'Account', value: data.header.expenseAccountCode },
  ]);

  Layout.sectionTitle(ctx, 'Issued items');
  Layout.table(ctx, data.items, [
    {
      header: 'Product',
      key: 'productName' as const,
      width: 0.34,
      format: (v, row) => {
        const r = row as StoreIssueBodyData['items'][number];
        return r.sku ? `${v as string}  (${r.sku})` : String(v);
      },
    },
    {
      header: 'Requested',
      key: 'requestedQty' as const,
      width: 0.14,
      align: 'right' as const,
      format: (v, row) => {
        const r = row as StoreIssueBodyData['items'][number];
        return fmtQty(v as number, r.uomName);
      },
    },
    {
      header: 'Issued',
      key: 'issuedQty' as const,
      width: 0.14,
      align: 'right' as const,
      format: (v, row) => {
        const r = row as StoreIssueBodyData['items'][number];
        return fmtQty(v as number, r.uomName);
      },
    },
    {
      header: 'Unit cost',
      key: 'unitCost' as const,
      width: 0.18,
      align: 'right' as const,
      format: (v) => (v == null ? '—' : fmt(v as number)),
    },
    {
      header: 'Amount',
      key: 'lineCost' as const,
      width: 0.2,
      align: 'right' as const,
      format: (v) => (v == null ? '—' : fmt(v as number)),
    },
  ]);

  if (data.header.posted) {
    Layout.totalsBlock(ctx, [
      { label: 'Total cost', value: fmt(data.header.totalCost), emphasize: true },
    ]);
  }

  if (data.header.reversalReason) {
    Layout.sectionTitle(ctx, 'Reverse reason');
    Layout.text(ctx, data.header.reversalReason);
    doc.moveDown(0.3);
  }

  if (data.header.notes) {
    Layout.sectionTitle(ctx, 'Notes');
    Layout.text(ctx, data.header.notes);
    doc.moveDown(0.3);
  }

  doc.moveDown(1);
  const sigY = doc.y;
  const sigW = (contentWidth - theme.spacing.lg) / 2;
  doc
    .strokeColor(theme.colors.border)
    .lineWidth(0.5)
    .moveTo(contentLeft, sigY + 30)
    .lineTo(contentLeft + sigW, sigY + 30)
    .stroke()
    .moveTo(contentLeft + sigW + theme.spacing.lg, sigY + 30)
    .lineTo(contentLeft + contentWidth, sigY + 30)
    .stroke();
  doc
    .fillColor(theme.colors.muted)
    .font(theme.fonts.family)
    .fontSize(theme.fonts.size.xs)
    .text('Issued by', contentLeft, sigY + 35, { width: sigW })
    .text('Received by', contentLeft + sigW + theme.spacing.lg, sigY + 35, { width: sigW });
}
