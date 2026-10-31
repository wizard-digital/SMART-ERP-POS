/**
 * Store Issue workspace — compose (SAP Create GI) and display (SAP Display GI).
 * Same SlideDrawer chrome as TransferCreateWorkspace.
 */

import { useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import SlideDrawer from '@/components/ui/SlideDrawer';
import { StoreLocationSelect } from '@/components/inventory/StoreLocationSelect';
import { DataTable, type DataTableColumn } from '@/components/shared/DataTable';
import type { StoreLocation } from '../../../../shared/types/warehouseNetwork';
import {
  formatQtyWithUom,
  type StoreIssueIssuedTo,
} from '@shared/store-issue/issuePlan';
import {
  StoreIssueLinePicker,
  type StoreIssueDraftLine,
} from './StoreIssueLinePicker';

const ISSUED_TO: Array<{ value: StoreIssueIssuedTo; label: string }> = [
  { value: 'KITCHEN', label: 'Kitchen' },
  { value: 'BAR', label: 'Bar' },
  { value: 'HOUSEKEEPING', label: 'Housekeeping' },
  { value: 'OTHER', label: 'Other' },
];

export type StoreIssueWorkspaceMode = 'compose' | 'display';

export interface StoreIssueCreateWorkspaceProps {
  open: boolean;
  onClose: () => void;
  mode?: StoreIssueWorkspaceMode;
  documentNumber?: string | null;
  status?: string | null;
  issuedTo: StoreIssueIssuedTo;
  onIssuedToChange: (value: StoreIssueIssuedTo) => void;
  issueDate: string;
  onIssueDateChange: (value: string) => void;
  warehouseMode: boolean;
  stores: StoreLocation[];
  storeLocationId: string;
  onStoreLocationIdChange: (id: string) => void;
  storeLabel: string;
  requestedByName: string;
  onRequestedByNameChange: (value: string) => void;
  notes: string;
  onNotesChange: (value: string) => void;
  lines: StoreIssueDraftLine[];
  onLinesChange: (lines: StoreIssueDraftLine[]) => void;
  pickerSessionKey: number;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  lineCount: number;
  overStock: boolean;
  canSave: boolean;
  canPost: boolean;
  saving: boolean;
  posting: boolean;
  onSaveDraft: () => void;
  onIssueNow: () => void;
  canExportPdf?: boolean;
  onExportPdf?: () => void;
  canEditDraft?: boolean;
  onEditDraft?: () => void;
  canReverse?: boolean;
  reversing?: boolean;
  reverseArmed?: boolean;
  reversalReason?: string;
  onReversalReasonChange?: (value: string) => void;
  savedReversalReason?: string | null;
  fourEyesBlocked?: boolean;
  onArmReverse?: () => void;
  onReverse?: () => void;
}

function issuedToLabel(value: string): string {
  const found = ISSUED_TO.find((o) => o.value === value);
  return found?.label || value;
}

export function StoreIssueCreateWorkspace({
  open,
  onClose,
  mode = 'compose',
  documentNumber,
  status,
  issuedTo,
  onIssuedToChange,
  issueDate,
  onIssueDateChange,
  warehouseMode,
  stores,
  storeLocationId,
  onStoreLocationIdChange,
  storeLabel,
  requestedByName,
  onRequestedByNameChange,
  notes,
  onNotesChange,
  lines,
  onLinesChange,
  pickerSessionKey,
  searchInputRef,
  lineCount,
  overStock,
  canSave,
  canPost,
  saving,
  posting,
  onSaveDraft,
  onIssueNow,
  canExportPdf = false,
  onExportPdf,
  canEditDraft = false,
  onEditDraft,
  canReverse = false,
  reversing = false,
  reverseArmed = false,
  reversalReason = '',
  onReversalReasonChange,
  savedReversalReason = null,
  fourEyesBlocked = false,
  onArmReverse,
  onReverse,
}: StoreIssueCreateWorkspaceProps) {
  const display = mode === 'display';
  const disabled = saving || posting || reversing || display;
  const pickerReady = !warehouseMode || Boolean(storeLocationId);
  const busy = saving || posting || reversing;
  const title = documentNumber
    ? `${documentNumber}${status ? ` · ${status}` : ''}`
    : 'Store Issue to Expense';
  const subtitle = display ? 'Goods issue' : 'Issue from warehouse stock';

  const displayColumns = useMemo((): DataTableColumn<StoreIssueDraftLine>[] => {
    return [
      {
        id: 'product',
        header: 'Product',
        cell: (line) => (
          <div className="min-w-[10rem]">
            <p className="font-medium text-sm text-gray-900">{line.productName}</p>
            {line.sku ? <p className="text-xs text-gray-500">SKU {line.sku}</p> : null}
          </div>
        ),
      },
      {
        id: 'requested',
        header: 'Requested',
        align: 'right',
        cell: (line) => (
          <span className="font-mono text-sm">
            {formatQtyWithUom(Number(line.requestedQty) || 0, line.uomName)}
          </span>
        ),
      },
      {
        id: 'issued',
        header: 'Issued',
        align: 'right',
        cell: (line) => (
          <span className="font-mono text-sm">
            {formatQtyWithUom(Number(line.issuedQty) || 0, line.uomName)}
          </span>
        ),
      },
      {
        id: 'uom',
        header: 'UoM',
        cell: (line) => <span className="text-sm text-gray-700">{line.uomName || '—'}</span>,
      },
      {
        id: 'cost',
        header: 'Amount',
        align: 'right',
        cell: (line) =>
          line.actualLineCost != null ? (
            <span className="font-mono text-sm">{line.actualLineCost.toLocaleString()}</span>
          ) : (
            <span className="text-gray-400">—</span>
          ),
      },
    ];
  }, []);

  const footer = (
    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
      <p className="text-sm text-gray-600">
        {lineCount > 0 ? (
          <>
            {lineCount} item{lineCount !== 1 ? 's' : ''}
            {storeLabel ? ` · ${storeLabel}` : ''}
            {!display && overStock ? ' · exceeds free qty' : ''}
          </>
        ) : display ? (
          'No lines on this issue.'
        ) : (
          'Search and press Enter to add products — no blank rows.'
        )}
      </p>
      <div className="flex flex-wrap gap-2 justify-end">
        <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
          {display ? 'Close' : 'Cancel'}
        </Button>
        {canExportPdf && onExportPdf && (
          <Button type="button" variant="outline" onClick={onExportPdf} disabled={busy}>
            PDF
          </Button>
        )}
        {display && canEditDraft && onEditDraft && (
          <Button type="button" variant="outline" onClick={onEditDraft} disabled={busy}>
            Edit
          </Button>
        )}
        {display && canReverse && onReverse && (
          <Button
            type="button"
            variant={reverseArmed ? 'default' : 'outline'}
            className={reverseArmed ? 'bg-amber-600 hover:bg-amber-700' : ''}
            onClick={() => (reverseArmed ? onReverse() : onArmReverse?.())}
            disabled={
              busy ||
              (reverseArmed &&
                (fourEyesBlocked || reversalReason.trim().length < 3))
            }
          >
            {reversing ? 'Reversing…' : reverseArmed ? 'Confirm reverse' : 'Reverse'}
          </Button>
        )}
        {!display && (
          <>
            <Button type="button" variant="outline" onClick={onSaveDraft} disabled={!canSave || busy}>
              {saving ? 'Saving…' : 'Save draft'}
            </Button>
            <Button
              type="button"
              onClick={onIssueNow}
              disabled={!canPost || busy}
              className="bg-blue-600 hover:bg-blue-700"
            >
              {posting ? 'Posting…' : 'Issue now (F9)'}
            </Button>
          </>
        )}
      </div>
    </div>
  );

  return (
    <SlideDrawer
      open={open}
      onClose={onClose}
      title={title}
      subtitle={subtitle}
      width="full"
      transactional
      footer={footer}
    >
      <div className="space-y-6">
        <header className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 pb-4 border-b border-gray-200">
          <div>
            <Label className="text-xs font-medium text-gray-500 uppercase">Issue to</Label>
            {display ? (
              <p className="mt-1 text-base font-semibold text-gray-900">{issuedToLabel(issuedTo)}</p>
            ) : (
              <Select
                value={issuedTo}
                onValueChange={(next) => onIssuedToChange(next as StoreIssueIssuedTo)}
                disabled={disabled}
              >
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ISSUED_TO.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <div>
            <Label htmlFor="store-issue-date" className="text-xs font-medium text-gray-500 uppercase">
              Date
            </Label>
            {display ? (
              <p className="mt-1 text-base font-semibold text-gray-900">{issueDate}</p>
            ) : (
              <Input
                id="store-issue-date"
                type="date"
                className="mt-1"
                value={issueDate}
                onChange={(e) => onIssueDateChange(e.target.value)}
                disabled={disabled}
              />
            )}
          </div>
          {warehouseMode ? (
            display ? (
              <div>
                <Label className="text-xs font-medium text-gray-500 uppercase">From store</Label>
                <p className="mt-1 text-base font-semibold text-gray-900">{storeLabel || '—'}</p>
              </div>
            ) : (
              <StoreLocationSelect
                id="store-issue-from"
                label="From store"
                stores={stores}
                value={storeLocationId}
                onChange={onStoreLocationIdChange}
                disabled={disabled}
                filter={(s) => s.isActive && (s.storeType === 'MAIN' || s.storeType === 'SELLING')}
              />
            )
          ) : (
            <div>
              <Label className="text-xs font-medium text-gray-500 uppercase">From store</Label>
              <p className="mt-1 text-base font-semibold text-indigo-800">Company stock</p>
            </div>
          )}
          <div>
            <Label htmlFor="store-issue-requested-by" className="text-xs font-medium text-gray-500 uppercase">
              Requested by
            </Label>
            {display ? (
              <p className="mt-1 text-base font-semibold text-gray-900">{requestedByName || '—'}</p>
            ) : (
              <Input
                id="store-issue-requested-by"
                className="mt-1"
                value={requestedByName}
                onChange={(e) => onRequestedByNameChange(e.target.value)}
                disabled={disabled}
              />
            )}
          </div>
        </header>

        {display ? (
          <DataTable
            columns={displayColumns}
            data={lines}
            getRowKey={(line) => line.productId}
            stickyHeader
            emptyMessage="No lines on this issue."
            className="shadow-none border rounded-lg"
          />
        ) : pickerReady ? (
          <StoreIssueLinePicker
            key={pickerSessionKey}
            lines={lines}
            onChange={onLinesChange}
            storeLocationId={storeLocationId}
            storeLabel={storeLabel}
            warehouseMode={warehouseMode}
            disabled={disabled}
            searchInputRef={searchInputRef}
          />
        ) : (
          <p className="text-sm text-gray-500 py-8 text-center bg-gray-50 rounded-lg border border-dashed">
            Select a store to search stock.
          </p>
        )}

        {display && reverseArmed && canReverse ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 space-y-2">
            <Label htmlFor="store-issue-reversal-reason" className="text-xs font-medium text-amber-900 uppercase">
              Reason for reverse
            </Label>
            {fourEyesBlocked ? (
              <p className="text-sm text-amber-900">
                You cannot reverse a goods issue you posted. A second authorized user must reverse it.
              </p>
            ) : (
              <>
                <Textarea
                  id="store-issue-reversal-reason"
                  value={reversalReason}
                  onChange={(e) => onReversalReasonChange?.(e.target.value)}
                  rows={3}
                  className="w-full bg-white"
                  disabled={busy}
                  placeholder="Why is this posted issue being reversed?"
                />
                <p className="text-xs text-amber-800">Required. Stock is restored and the 5150 / 1300 journal is reversed.</p>
              </>
            )}
          </div>
        ) : null}

        {display && savedReversalReason ? (
          <div>
            <Label className="text-xs font-medium text-gray-500 uppercase">Reverse reason</Label>
            <p className="mt-1 text-sm text-gray-800 whitespace-pre-wrap">{savedReversalReason}</p>
          </div>
        ) : null}

        {display ? (
          notes ? (
            <div>
              <Label className="text-xs font-medium text-gray-500 uppercase">Notes</Label>
              <p className="mt-1 text-sm text-gray-800 whitespace-pre-wrap">{notes}</p>
            </div>
          ) : null
        ) : (
          <div>
            <Label htmlFor="store-issue-notes">Notes (optional)</Label>
            <Textarea
              id="store-issue-notes"
              value={notes}
              onChange={(e) => onNotesChange(e.target.value)}
              rows={3}
              className="w-full mt-1"
              disabled={disabled}
            />
          </div>
        )}
      </div>
    </SlideDrawer>
  );
}
