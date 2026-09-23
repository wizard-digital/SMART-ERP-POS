import { useMemo, type ReactNode } from 'react';
import {
  AdaptiveDataGrid,
  type AdaptiveDataColumn,
} from '../adaptive/AdaptiveDataGrid';
import { buildSupplierBillSettlement, isSupplierBillCancelledStatus } from '@shared/utils/supplierBillSettlement';
import { formatCurrency } from '../../utils/currency';
import { isSupplierCreditNote } from '../../utils/supplierOpenItemSummary';

export type SupplierInvoiceGridRow = {
  id: string;
  invoiceNumber: string;
  supplierInvoiceNumber: string | null;
  invoiceDate: string;
  dueDate: string | null;
  totalAmount: number;
  amountPaid: number;
  creditsApplied?: number;
  outstandingBalance: number;
  status: string;
  documentType?: string | null;
};

type SupplierInvoicesAdaptiveGridProps<T extends SupplierInvoiceGridRow> = {
  rows: T[];
  canCreatePayment: boolean;
  multiSelected: Map<string, number | string>;
  downloadingPdf: string | null;
  selectedInvoiceId: string | null;
  formatDisplayDate: (date: string | null | undefined) => string;
  isPayableInvoice: (inv: T) => boolean;
  onToggleMulti: (inv: T) => void;
  onSetMultiAmount: (id: string, value: string) => void;
  onToggleExpand: (invoiceId: string) => void;
  onDownloadPdf: (invoiceId: string, invoiceNumber: string) => void;
  onPay: (inv: T) => void;
  renderExpanded: (inv: T) => ReactNode;
};

function statusBadgeClass(inv: SupplierInvoiceGridRow): string {
  const settlement = buildSupplierBillSettlement(inv);
  const isCn = isSupplierCreditNote(inv);
  if (isSupplierBillCancelledStatus(inv.status) || settlement.displayStatus === 'Cancelled') {
    return 'bg-gray-200 text-gray-700';
  }
  if (isCn) return 'bg-teal-100 text-teal-800';
  if (settlement.displayStatus === 'Paid') return 'bg-green-100 text-green-800';
  if (
    settlement.displayStatus === 'Partially settled'
    || settlement.displayStatus === 'Partially paid'
  ) {
    return 'bg-yellow-100 text-yellow-800';
  }
  if (settlement.displayStatus === 'Open') return 'bg-blue-100 text-blue-800';
  return 'bg-gray-100 text-gray-800';
}

/**
 * Phase 1 pilot: supplier invoices use AdaptiveDataGrid (cards / reduced / full).
 */
export function SupplierInvoicesAdaptiveGrid<T extends SupplierInvoiceGridRow>({
  rows,
  canCreatePayment,
  multiSelected,
  downloadingPdf,
  selectedInvoiceId,
  formatDisplayDate,
  isPayableInvoice,
  onToggleMulti,
  onSetMultiAmount,
  onToggleExpand,
  onDownloadPdf,
  onPay,
  renderExpanded,
}: SupplierInvoicesAdaptiveGridProps<T>) {
  const columns = useMemo((): AdaptiveDataColumn<T>[] => {
    const cols: AdaptiveDataColumn<T>[] = [
      {
        id: 'invoiceNumber',
        header: 'Invoice #',
        priority: 'primary',
        cardRole: 'title',
        cell: (inv) => {
          const isCn = isSupplierCreditNote(inv);
          return (
            <div className="flex items-center gap-2">
              <span className="font-medium text-blue-600">{inv.invoiceNumber}</span>
              {isCn && (
                <span className="inline-flex px-1.5 py-0.5 text-[10px] font-semibold rounded bg-teal-100 text-teal-800 whitespace-nowrap">
                  Credit note
                </span>
              )}
            </div>
          );
        },
      },
      {
        id: 'ref',
        header: 'Ref',
        priority: 'detail',
        cardRole: 'hidden',
        cell: (inv) => inv.supplierInvoiceNumber || '—',
      },
      {
        id: 'date',
        header: 'Date',
        priority: 'secondary',
        cardRole: 'meta',
        cell: (inv) => formatDisplayDate(inv.invoiceDate),
      },
      {
        id: 'dueDate',
        header: 'Due Date',
        priority: 'detail',
        cardRole: 'meta',
        cell: (inv) => (inv.dueDate ? formatDisplayDate(inv.dueDate) : '—'),
      },
      {
        id: 'status',
        header: 'Status',
        priority: 'primary',
        cardRole: 'status',
        cell: (inv) => {
          const settlement = buildSupplierBillSettlement(inv);
          return (
            <span
              className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${statusBadgeClass(inv)}`}
              title={settlement.equationHint}
            >
              {settlement.displayStatus}
            </span>
          );
        },
      },
      {
        id: 'total',
        header: 'Total',
        priority: 'secondary',
        cardRole: 'meta',
        align: 'right',
        cell: (inv) => {
          const settlement = buildSupplierBillSettlement(inv);
          return (
            <span className="font-semibold">{formatCurrency(settlement.invoiceTotal)}</span>
          );
        },
      },
      {
        id: 'payments',
        header: 'Payments',
        priority: 'secondary',
        cardRole: 'meta',
        align: 'right',
        cell: (inv) => {
          if (isSupplierCreditNote(inv)) return '—';
          const settlement = buildSupplierBillSettlement(inv);
          return (
            <span className="text-green-600">{formatCurrency(settlement.payments)}</span>
          );
        },
      },
      {
        id: 'credits',
        header: 'Credits',
        priority: 'secondary',
        cardRole: 'meta',
        align: 'right',
        cell: (inv) => {
          if (isSupplierCreditNote(inv)) return '—';
          const settlement = buildSupplierBillSettlement(inv);
          return (
            <span className="text-teal-700">{formatCurrency(settlement.creditsApplied)}</span>
          );
        },
      },
      {
        id: 'balanceDue',
        header: 'Balance due',
        priority: 'primary',
        cardRole: 'amount',
        align: 'right',
        cell: (inv) => {
          const settlement = buildSupplierBillSettlement(inv);
          const balance = settlement.balanceDue;
          const isCn = isSupplierCreditNote(inv);
          const cancelled = isSupplierBillCancelledStatus(inv.status);
          if (cancelled) {
            return (
              <span className="font-semibold text-gray-500" title={settlement.equationHint}>
                {formatCurrency(0)}
              </span>
            );
          }
          if (balance > 0) {
            return (
              <span className={`font-semibold ${isCn ? 'text-teal-700' : 'text-red-600'}`}>
                {isCn ? `Credit ${formatCurrency(balance)}` : formatCurrency(balance)}
              </span>
            );
          }
          if (balance < 0) {
            return (
              <span className="font-semibold text-green-600">
                Overpaid {formatCurrency(Math.abs(balance))}
              </span>
            );
          }
          return <span className="font-semibold text-green-600">Paid</span>;
        },
      },
    ];

    if (canCreatePayment) {
      cols.push({
        id: 'payAmount',
        header: 'Pay Amount',
        priority: 'secondary',
        cardRole: 'hidden',
        align: 'right',
        cell: (inv) => {
          const checked = multiSelected.has(inv.id);
          if (!checked) return null;
          const balance = buildSupplierBillSettlement(inv).balanceDue;
          return (
            <div className="flex items-center gap-1 justify-end">
              <input
                type="number"
                value={String(multiSelected.get(inv.id) ?? '')}
                onChange={(e) => onSetMultiAmount(inv.id, e.target.value)}
                onClick={(e) => e.stopPropagation()}
                className="w-28 border border-purple-300 rounded px-2 py-1 text-xs text-right focus:ring-1 focus:ring-purple-500 min-h-[var(--layout-touch-target)]"
                max={balance}
                step="1"
              />
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onSetMultiAmount(inv.id, balance.toString());
                }}
                className="text-xs text-purple-600 hover:text-purple-800 underline whitespace-nowrap min-h-[var(--layout-touch-target)] px-1"
              >
                Full
              </button>
            </div>
          );
        },
      });
    }

    return cols;
  }, [canCreatePayment, formatDisplayDate, multiSelected, onSetMultiAmount]);

  return (
    <AdaptiveDataGrid
      rows={rows}
      columns={columns}
      getRowId={(inv) => inv.id}
      emptyMessage="No invoices match your search."
      expandedRowId={selectedInvoiceId}
      onRowClick={(inv) => onToggleExpand(inv.id)}
      rowClassName={(inv) => {
        const checked = multiSelected.has(inv.id);
        const isCn = isSupplierCreditNote(inv);
        if (checked) return 'border-purple-400 bg-purple-50';
        if (isCn) return 'border-teal-200 bg-teal-50/40';
        return undefined;
      }}
      renderLeading={
        canCreatePayment
          ? (inv) => {
              if (!isPayableInvoice(inv)) return null;
              return (
                <input
                  type="checkbox"
                  checked={multiSelected.has(inv.id)}
                  onChange={() => onToggleMulti(inv)}
                  className="w-4 h-4 accent-purple-600 cursor-pointer"
                  title="Select for payment"
                />
              );
            }
          : undefined
      }
      renderRowActions={(inv) => {
        const settlement = buildSupplierBillSettlement(inv);
        const balance = settlement.balanceDue;
        const isExpanded = selectedInvoiceId === inv.id;
        const checked = multiSelected.has(inv.id);
        const canPay =
          balance > 0 &&
          !isSupplierBillCancelledStatus(inv.status) &&
          !['DRAFT', 'Draft'].includes(inv.status || '');

        return (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-center sm:gap-1">
            {checked && (
              <div className="flex items-center gap-2 sm:hidden">
                <span className="text-xs text-purple-700 font-medium">Pay:</span>
                <input
                  type="number"
                  value={String(multiSelected.get(inv.id) ?? '')}
                  onChange={(e) => onSetMultiAmount(inv.id, e.target.value)}
                  className="flex-1 border border-purple-300 rounded px-2 py-1 text-xs focus:ring-1 focus:ring-purple-500 min-h-[var(--layout-touch-target)]"
                  max={balance}
                  step="1"
                />
                <button
                  type="button"
                  onClick={() => onSetMultiAmount(inv.id, balance.toString())}
                  className="text-xs text-purple-600 hover:text-purple-800 underline whitespace-nowrap"
                >
                  Full
                </button>
              </div>
            )}
            <div className="flex gap-2 sm:gap-1">
              <button
                type="button"
                onClick={() => onToggleExpand(inv.id)}
                className="flex-1 sm:flex-none px-2 py-1 text-xs bg-blue-50 text-blue-700 rounded hover:bg-blue-100 transition-colors min-h-[var(--layout-touch-target)]"
                title={isExpanded ? 'Hide Details' : 'View Details'}
              >
                {isExpanded ? '▾ Hide' : '▸ View'}
              </button>
              <button
                type="button"
                onClick={() => onDownloadPdf(inv.id, inv.invoiceNumber)}
                disabled={downloadingPdf === inv.id}
                className="flex-1 sm:flex-none px-2 py-1 text-xs bg-green-50 text-green-700 rounded hover:bg-green-100 transition-colors disabled:opacity-50 min-h-[var(--layout-touch-target)]"
                title="Download PDF"
              >
                {downloadingPdf === inv.id ? '⏳' : '📄'} PDF
              </button>
              {canPay && (
                <button
                  type="button"
                  onClick={() => onPay(inv)}
                  className="flex-1 sm:flex-none px-2 py-1 text-xs bg-purple-50 text-purple-700 rounded hover:bg-purple-100 transition-colors font-semibold min-h-[var(--layout-touch-target)]"
                  title="Record Payment"
                >
                  💰 Pay
                </button>
              )}
            </div>
          </div>
        );
      }}
      renderExpanded={renderExpanded}
    />
  );
}