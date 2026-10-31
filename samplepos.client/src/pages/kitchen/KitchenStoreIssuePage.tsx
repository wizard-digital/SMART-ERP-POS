/**
 * Store Issue to Expense — list + create workspace (same pattern as store transfers).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Layout from '../../components/Layout';
import { api } from '../../utils/api';
import { useRestaurantEnabled } from '../../hooks/useRestaurantEnabled';
import { useCanAccess } from '../../authorization/useAuthorization';
import { useAuth } from '../../contexts/AuthContext';
import { useMultistoreEnabled } from '../../hooks/useMultistore';
import { useStoreLocations } from '../../hooks/useWarehouse';
import { toast } from 'react-hot-toast';
import { toastApiError } from '../../utils/errorHandler';
import { downloadFile } from '../../utils/download';
import { Button } from '@/components/ui/button';
import { DataTable, type DataTableColumn } from '@/components/shared/DataTable';
import {
  buildStoreLabelMap,
  resolveStoreLabel,
} from '../../components/inventory/storeLocationUtils';
import {
  StoreIssueCreateWorkspace,
  type StoreIssueWorkspaceMode,
} from '../../components/kitchen/StoreIssueCreateWorkspace';
import type { StoreIssueDraftLine } from '../../components/kitchen/StoreIssueLinePicker';
import {
  canReverseStoreIssue,
  defaultIssueStoreId,
  formatQtyWithUom,
  issuedExceedsAvailable,
  storeIssueEntryQty,
  storeIssueStepComplete,
  storeIssueUiGate,
  type StoreIssueIssuedTo,
  type StoreIssueStatus,
} from '@shared/store-issue/issuePlan';
import {
  convertPoLineQuantityForUomChange,
  poLineBaseQuantity,
} from '@shared/utils/po-line-uom';

type IssueDoc = {
  id: string;
  documentNumber: string;
  status: string;
  issueDate: string;
  issuedTo: string;
  requestedByName: string | null;
  totalCost: number;
  expenseAccountCode: string;
  notes: string | null;
  storeLocationId?: string | null;
  storeLocationName?: string;
  postedBy?: string | null;
  reversalReason?: string | null;
  lines: Array<{
    productId: string;
    productName?: string;
    sku?: string | null;
    requestedQtyBase: number;
    issuedQtyBase: number;
    uomId?: string | null;
    uomName?: string | null;
    conversionFactor?: number;
    actualUnitCost?: number | null;
    actualLineCost?: number | null;
  }>;
};

type IssueTableRow = {
  id: string;
  documentNumber: string;
  issuedTo: string;
  storeLabel: string;
  issueDate: string;
  status: string;
  totalCost: number;
  qtySummary: string;
};

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function statusClass(status: string): string {
  if (status === 'POSTED') return 'bg-green-100 text-green-800';
  if (status === 'REVERSED') return 'bg-orange-100 text-orange-800';
  if (status === 'CANCELLED') return 'bg-gray-100 text-gray-500';
  return 'bg-yellow-100 text-yellow-800';
}

function mapDocLines(doc: IssueDoc): StoreIssueDraftLine[] {
  return (doc.lines || []).map((l) => {
    const factor = Number(l.conversionFactor || 1) || 1;
    return {
      productId: l.productId,
      productName: l.productName || l.productId,
      sku: l.sku,
      availableQty: 0,
      requestedQty: convertPoLineQuantityForUomChange(l.requestedQtyBase, 1, factor),
      issuedQty: convertPoLineQuantityForUomChange(l.issuedQtyBase, 1, factor),
      selectedUomId: l.uomId ?? null,
      conversionFactor: String(factor),
      uomName: l.uomName || '',
      actualUnitCost: l.actualUnitCost ?? null,
      actualLineCost: l.actualLineCost ?? null,
    };
  });
}

function qtySummary(doc: IssueDoc): string {
  const lines = doc.lines || [];
  if (!lines.length) return '—';
  const first = lines[0];
  const factor = Number(first.conversionFactor || 1) || 1;
  const issued = formatQtyWithUom(storeIssueEntryQty(first.issuedQtyBase, factor), first.uomName);
  const requested = formatQtyWithUom(
    storeIssueEntryQty(first.requestedQtyBase, factor),
    first.uomName,
  );
  const extra = lines.length > 1 ? ` +${lines.length - 1}` : '';
  return requested === issued ? `${issued}${extra}` : `${requested} → ${issued}${extra}`;
}

export default function KitchenStoreIssuePage() {
  const queryClient = useQueryClient();
  const { data: restaurantEnabled, isLoading: flagLoading } = useRestaurantEnabled();
  const { isMultistoreEnabled } = useMultistoreEnabled();
  const canRead = useCanAccess(undefined, [
    'kitchen.production.read',
    'inventory.read',
    'inventory.adjust',
  ]);
  const { user } = useAuth();
  const canCreate = useCanAccess(undefined, ['kitchen.production.create', 'inventory.adjust']);
  const canPostPerm = useCanAccess(undefined, ['kitchen.production.post', 'inventory.adjust']);
  const canReversePerm = useCanAccess(undefined, ['kitchen.production.reverse']);
  const canOverrideFourEyes = useCanAccess(undefined, ['inventory.approve']);
  const canViewAudit = useCanAccess(undefined, ['reports.inventory_view', 'reports.read']);

  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [workspaceMode, setWorkspaceMode] = useState<StoreIssueWorkspaceMode>('compose');
  const [reverseArmed, setReverseArmed] = useState(false);
  const [reversalReason, setReversalReason] = useState('');
  const [savedReversalReason, setSavedReversalReason] = useState<string | null>(null);
  const [postedBy, setPostedBy] = useState<string | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [draftNumber, setDraftNumber] = useState<string | null>(null);
  const [docStatus, setDocStatus] = useState<string | null>(null);
  const [displayStoreName, setDisplayStoreName] = useState('');
  const [issueDate, setIssueDate] = useState(todayIso);
  const [storeLocationId, setStoreLocationId] = useState('');
  const [issuedTo, setIssuedTo] = useState<StoreIssueIssuedTo>('KITCHEN');
  const [requestedByName, setRequestedByName] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<StoreIssueDraftLine[]>([]);
  const [pickerSessionKey, setPickerSessionKey] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const workspaceOn = storeIssueUiGate(restaurantEnabled) === 'ok' && canRead;

  const listQuery = useQuery({
    queryKey: ['kitchen-production', 'issues'],
    queryFn: async () => {
      const res = await api.kitchenProduction.listIssues({ limit: 80 });
      return (res.data.data || []) as IssueDoc[];
    },
    enabled: workspaceOn,
  });

  const { data: stores = [] } = useStoreLocations(workspaceOn && isMultistoreEnabled);
  const warehouseMode = isMultistoreEnabled;
  const storeLabelMap = useMemo(() => buildStoreLabelMap(stores), [stores]);

  useEffect(() => {
    if (!warehouseMode || storeLocationId) return;
    const id = defaultIssueStoreId(stores);
    if (id) setStoreLocationId(id);
  }, [warehouseMode, stores, storeLocationId]);

  const storeLabel = resolveStoreLabel(storeLabelMap, storeLocationId);
  const linesIssuedPositive =
    lines.length > 0 &&
    lines.every((l) => poLineBaseQuantity(l.issuedQty, l.conversionFactor) > 0);
  const overStock = lines.some((l) =>
    issuedExceedsAvailable(poLineBaseQuantity(l.issuedQty, l.conversionFactor), l.availableQty),
  );
  const storeReady = !warehouseMode || Boolean(storeLocationId);
  const composing = workspaceMode === 'compose';
  const fourEyesBlocked = Boolean(postedBy && user?.id && postedBy === user.id && !canOverrideFourEyes);
  const canIssueNow =
    composing &&
    storeIssueStepComplete({
      step: 4,
      issuedTo,
      lineCount: lines.length,
      linesIssuedPositive,
    }) &&
    storeReady &&
    !overStock &&
    canPostPerm;

  const tableRows = useMemo((): IssueTableRow[] => {
    return (listQuery.data || [])
      .filter((d) => d.status !== 'CANCELLED')
      .map((d) => ({
        id: d.id,
        documentNumber: d.documentNumber,
        issuedTo: d.issuedTo,
        storeLabel: d.storeLocationName || resolveStoreLabel(storeLabelMap, d.storeLocationId),
        issueDate: d.issueDate.slice(0, 10),
        status: d.status,
        totalCost: Number(d.totalCost || 0),
        qtySummary: qtySummary(d),
      }));
  }, [listQuery.data, storeLabelMap]);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['kitchen-production', 'issues'] });
  };

  const resetWorkspace = useCallback(() => {
    setDraftId(null);
    setDraftNumber(null);
    setDocStatus(null);
    setDisplayStoreName('');
    setWorkspaceMode('compose');
    setReverseArmed(false);
    setReversalReason('');
    setSavedReversalReason(null);
    setPostedBy(null);
    setIssueDate(todayIso());
    setNotes('');
    setRequestedByName('');
    setIssuedTo('KITCHEN');
    setLines([]);
    setPickerSessionKey((k) => k + 1);
    const id = defaultIssueStoreId(stores);
    if (id) setStoreLocationId(id);
  }, [stores]);

  const handleStoreChange = (nextId: string) => {
    if (nextId !== storeLocationId && lines.length > 0) {
      setLines([]);
      setPickerSessionKey((k) => k + 1);
    }
    setStoreLocationId(nextId);
  };

  const openNew = () => {
    resetWorkspace();
    setWorkspaceMode('compose');
    setWorkspaceOpen(true);
  };

  const applyDocHeader = (doc: IssueDoc) => {
    setDraftId(doc.id);
    setDraftNumber(doc.documentNumber);
    setDocStatus(doc.status);
    setIssueDate(doc.issueDate.slice(0, 10));
    setIssuedTo((doc.issuedTo as StoreIssueIssuedTo) || 'KITCHEN');
    setRequestedByName(doc.requestedByName || '');
    setNotes(doc.notes || '');
    setDisplayStoreName(doc.storeLocationName || '');
    setPostedBy(doc.postedBy || null);
    setSavedReversalReason(doc.reversalReason || null);
    setReversalReason('');
    setReverseArmed(false);
    if (doc.storeLocationId) setStoreLocationId(doc.storeLocationId);
  };

  const openDisplay = (doc: IssueDoc) => {
    applyDocHeader(doc);
    setLines(mapDocLines(doc));
    setWorkspaceMode('display');
    setReverseArmed(false);
    setPickerSessionKey((k) => k + 1);
    setWorkspaceOpen(true);
  };

  const exportPdf = (id: string, documentNumber: string) => {
    void downloadFile(`/documents/STORE_ISSUE/${id}`, `${documentNumber}.pdf`).catch((err: unknown) => {
      toast.error(err instanceof Error ? err.message : 'PDF export failed');
    });
  };

  const payload = () => ({
    issueDate,
    storeLocationId: warehouseMode ? storeLocationId || null : null,
    issuedTo,
    requestedByName: requestedByName.trim() || null,
    notes: notes.trim() || null,
    lines: lines.map((l, i) => ({
      productId: l.productId,
      requestedQtyBase: poLineBaseQuantity(l.requestedQty, l.conversionFactor),
      issuedQtyBase: poLineBaseQuantity(l.issuedQty, l.conversionFactor),
      sortOrder: i,
      uomId: l.selectedUomId || null,
      uomName: l.uomName?.trim() || null,
      conversionFactor: Number(l.conversionFactor) || 1,
    })),
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!lines.length) throw new Error('Add at least one product');
      if (draftId) {
        const res = await api.kitchenProduction.updateIssue(draftId, payload());
        return res.data.data as IssueDoc;
      }
      const res = await api.kitchenProduction.createIssue(payload());
      return res.data.data as IssueDoc;
    },
    onSuccess: (doc) => {
      setDraftId(doc.id);
      setDraftNumber(doc.documentNumber);
      setDocStatus(doc.status);
      toast.success(`Draft ${doc.documentNumber} saved`);
      invalidate();
    },
    onError: (err) => toastApiError(err, 'Save failed'),
  });

  const postMutation = useMutation({
    mutationFn: async () => {
      if (!lines.length) throw new Error('Add at least one product');
      if (!linesIssuedPositive) throw new Error('Set issued quantity on every line');
      if (overStock) {
        throw new Error('Issued quantity exceeds available stock at the issuing store');
      }
      if (warehouseMode && !storeLocationId) throw new Error('Select the issuing store');
      if (draftId) {
        await api.kitchenProduction.updateIssue(draftId, payload());
        const res = await api.kitchenProduction.postIssue(draftId);
        return res.data.data as IssueDoc;
      }
      const res = await api.kitchenProduction.postIssueNow(payload());
      return res.data.data as IssueDoc;
    },
    onSuccess: (doc) => {
      toast.success(`${doc.documentNumber} posted`);
      setWorkspaceOpen(false);
      resetWorkspace();
      invalidate();
    },
    onError: (err) => toastApiError(err, 'Issue failed'),
  });

  const reverseMutation = useMutation({
    mutationFn: async (input: { id: string; reason: string }) => {
      const res = await api.kitchenProduction.reverseIssue(input.id, input.reason);
      return res.data.data as IssueDoc;
    },
    onSuccess: (doc) => {
      toast.success(`${doc.documentNumber} reversed`);
      applyDocHeader(doc);
      setLines(mapDocLines(doc));
      setWorkspaceMode('display');
      setReverseArmed(false);
      setReversalReason('');
      invalidate();
    },
    onError: (err) => toastApiError(err, 'Reverse failed'),
  });

  const cancelMutation = useMutation({
    mutationFn: async (id: string) => {
      await api.kitchenProduction.cancelIssue(id);
    },
    onSuccess: (_void, id) => {
      toast.success('Draft cancelled');
      if (draftId === id) {
        setWorkspaceOpen(false);
        resetWorkspace();
      }
      invalidate();
    },
    onError: (err) => toastApiError(err, 'Cancel failed'),
  });

  const loadDraft = async (doc: IssueDoc) => {
    if (doc.status !== 'DRAFT') return;
    applyDocHeader(doc);
    setWorkspaceMode('compose');
    setReverseArmed(false);
    const storeId = warehouseMode ? doc.storeLocationId || storeLocationId : null;
    const mapped = await Promise.all(
      (doc.lines || []).map(async (l) => {
        let availableQty = 0;
        let storeName = doc.storeLocationName || undefined;
        try {
          const res = await api.kitchenProduction.issueAvailability(l.productId, storeId);
          availableQty = Number(res.data.data?.availableQty ?? 0);
          storeName = res.data.data?.storeLabel || storeName;
        } catch {
          availableQty = 0;
        }
        const factor = Number(l.conversionFactor || 1) || 1;
        return {
          productId: l.productId,
          productName: l.productName || l.productId,
          sku: l.sku,
          availableQty,
          requestedQty: convertPoLineQuantityForUomChange(l.requestedQtyBase, 1, factor),
          issuedQty: convertPoLineQuantityForUomChange(l.issuedQtyBase, 1, factor),
          selectedUomId: l.uomId ?? null,
          conversionFactor: String(factor),
          uomName: l.uomName || '',
          storeName,
        };
      }),
    );
    setLines(mapped);
    setPickerSessionKey((k) => k + 1);
    setWorkspaceOpen(true);
  };

  useEffect(() => {
    if (!workspaceOpen || !storeReady || workspaceMode !== 'compose') return;
    const timer = setTimeout(() => searchInputRef.current?.focus(), 120);
    return () => clearTimeout(timer);
  }, [workspaceOpen, storeReady, pickerSessionKey, workspaceMode]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === 'n' && canCreate && workspaceOn) {
        e.preventDefault();
        resetWorkspace();
        setWorkspaceOpen(true);
      }
      if (e.key === 'F9' && workspaceOpen && composing && canIssueNow) {
        e.preventDefault();
        postMutation.mutate();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canCreate, workspaceOn, workspaceOpen, composing, canIssueNow, resetWorkspace, postMutation]);

  const findDoc = (id: string) => (listQuery.data || []).find((d) => d.id === id);

  const columns = useMemo((): DataTableColumn<IssueTableRow>[] => [
    {
      id: 'number',
      header: 'Issue',
      cell: (row) => (
        <button
          type="button"
          className="font-medium text-indigo-700 hover:text-indigo-900"
          onClick={() => {
            const doc = findDoc(row.id);
            if (doc) openDisplay(doc);
          }}
        >
          {row.documentNumber}
        </button>
      ),
    },
    {
      id: 'issuedTo',
      header: 'Issue to',
      cell: (row) => <span className="text-gray-600">{row.issuedTo}</span>,
    },
    {
      id: 'store',
      header: 'From store',
      cell: (row) => <span className="text-gray-600">{row.storeLabel}</span>,
    },
    {
      id: 'qty',
      header: 'Requested / issued',
      cell: (row) => <span className="font-mono text-sm text-gray-800">{row.qtySummary}</span>,
    },
    {
      id: 'date',
      header: 'Date',
      cellClassName: 'text-gray-500',
      cell: (row) => row.issueDate,
    },
    {
      id: 'status',
      header: 'Status',
      cell: (row) => (
        <span className={`text-xs px-2 py-1 rounded-full ${statusClass(row.status)}`}>
          {row.status}
        </span>
      ),
    },
    {
      id: 'cost',
      header: 'Cost',
      align: 'right',
      cell: (row) =>
        row.status === 'POSTED' || row.status === 'REVERSED' ? (
          <span className="font-mono text-sm">{row.totalCost.toLocaleString()}</span>
        ) : (
          <span className="text-gray-400">—</span>
        ),
    },
    {
      id: 'actions',
      header: '',
      align: 'right',
      cell: (row) => (
          <div className="flex justify-end gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-indigo-600 hover:text-indigo-800"
              onClick={() => {
                const doc = findDoc(row.id);
                if (doc) openDisplay(doc);
              }}
            >
              Open
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-indigo-600 hover:text-indigo-800"
              onClick={() => exportPdf(row.id, row.documentNumber)}
            >
              PDF
            </Button>
            {row.status === 'DRAFT' && canCreate && (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-indigo-600 hover:text-indigo-800"
                  onClick={() => {
                    const doc = findDoc(row.id);
                    if (doc) void loadDraft(doc);
                  }}
                >
                  Edit
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-gray-400 hover:text-red-600"
                  onClick={() => cancelMutation.mutate(row.id)}
                >
                  Cancel
                </Button>
              </>
            )}
          </div>
        ),
    },
  ], [canCreate, listQuery.data]);

  if (flagLoading) {
    return (
      <Layout>
        <div className="p-6 text-gray-500">Loading…</div>
      </Layout>
    );
  }

  if (storeIssueUiGate(restaurantEnabled) === 'restaurant-off') {
    return (
      <Layout>
        <div className="p-6">
          <div className="bg-gray-50 border rounded-lg p-8 text-center text-gray-600">
            <h2 className="text-2xl font-bold text-gray-900">Store Issue to Expense</h2>
            <p className="mt-2">Restaurant mode is required.</p>
            <Link to="/settings" className="mt-3 inline-block text-sm text-indigo-600 hover:text-indigo-800">
              Open settings
            </Link>
          </div>
        </div>
      </Layout>
    );
  }

  if (!canRead) {
    return (
      <Layout>
        <div className="p-6 text-gray-600">You do not have permission to view store issues.</div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="p-6">
        <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4 mb-6">
          <div>
            <h2 className="text-2xl font-bold text-gray-900">Store Issue to Expense</h2>
            <p className="text-gray-600 mt-1">Issue warehouse stock to kitchen or bar cost.</p>
            {canViewAudit && (
              <Link
                to="/reports/inventory/store-issues"
                className="mt-2 inline-block text-sm text-indigo-600 hover:text-indigo-800"
              >
                Store Issue Audit
              </Link>
            )}
          </div>
          {canCreate && (
            <Button
              type="button"
              onClick={() => {
                if (workspaceOpen) {
                  setWorkspaceOpen(false);
                  resetWorkspace();
                } else {
                  openNew();
                }
              }}
            >
              {workspaceOpen ? 'Cancel' : '+ New issue'}
            </Button>
          )}
        </div>

        <StoreIssueCreateWorkspace
          open={workspaceOpen && (workspaceMode === 'display' || canCreate)}
          onClose={() => {
            setWorkspaceOpen(false);
            resetWorkspace();
          }}
          mode={workspaceMode}
          documentNumber={draftNumber}
          status={docStatus}
          issuedTo={issuedTo}
          onIssuedToChange={setIssuedTo}
          issueDate={issueDate}
          onIssueDateChange={setIssueDate}
          warehouseMode={warehouseMode}
          stores={stores}
          storeLocationId={storeLocationId}
          onStoreLocationIdChange={handleStoreChange}
          storeLabel={
            displayStoreName || (storeLabel === '—' ? '' : storeLabel)
          }
          requestedByName={requestedByName}
          onRequestedByNameChange={setRequestedByName}
          notes={notes}
          onNotesChange={setNotes}
          lines={lines}
          onLinesChange={setLines}
          pickerSessionKey={pickerSessionKey}
          searchInputRef={searchInputRef}
          lineCount={lines.length}
          overStock={overStock}
          canSave={lines.length > 0}
          canPost={canIssueNow}
          saving={saveMutation.isPending}
          posting={postMutation.isPending}
          onSaveDraft={() => saveMutation.mutate()}
          onIssueNow={() => postMutation.mutate()}
          canExportPdf={Boolean(draftId)}
          onExportPdf={() => {
            if (!draftId) return;
            exportPdf(draftId, draftNumber || 'GI');
          }}
          canEditDraft={workspaceMode === 'display' && docStatus === 'DRAFT' && canCreate}
          onEditDraft={() => {
            const doc = draftId ? findDoc(draftId) : undefined;
            if (doc) void loadDraft(doc);
          }}
          canReverse={
            workspaceMode === 'display' &&
            canReversePerm &&
            canReverseStoreIssue((docStatus || '') as StoreIssueStatus)
          }
          reversing={reverseMutation.isPending}
          reverseArmed={reverseArmed}
          reversalReason={reversalReason}
          onReversalReasonChange={setReversalReason}
          savedReversalReason={savedReversalReason}
          fourEyesBlocked={fourEyesBlocked}
          onArmReverse={() => setReverseArmed(true)}
          onReverse={() => {
            const reason = reversalReason.trim();
            if (!draftId || fourEyesBlocked || reason.length < 3) return;
            reverseMutation.mutate({ id: draftId, reason });
          }}
        />

        <DataTable
          columns={columns}
          data={tableRows}
          getRowKey={(row) => row.id}
          isLoading={listQuery.isLoading}
          emptyMessage="No store issues yet."
        />
      </div>
    </Layout>
  );
}
