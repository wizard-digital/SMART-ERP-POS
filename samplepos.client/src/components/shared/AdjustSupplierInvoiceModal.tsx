/**
 * AdjustSupplierInvoiceModal
 *
 * 3-step modal for adjusting a supplier invoice:
 *   Step 1 — Choose intent (RETURN or PRICE_CORRECTION), auto-preselected
 *   Step 2A — Return goods: select GRN lines + quantities
 *   Step 2B — Price correction: enter credit amount + reason
 *   Step 3 — Review & confirm
 */

import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter,
    Button,
    Label,
    Input,
} from '../ui/temp-ui-components';
import { formatCurrency } from '../../utils/currency';
import { useTransactionGuard, ZINDEX } from '../../hooks/useTransactionGuard';
import type { GuardHandle } from '../../hooks/useTransactionGuard';
import { toast } from 'react-hot-toast';
import { useQueryClient } from '@tanstack/react-query';
import {
    supplierAdjustmentApi,
    type AdjustmentContext,
    type ReturnableItem,
    type AdjustReturnLine,
} from '../../services/supplierAdjustmentApi';

// ─── Types ──────────────────────────────────────────────────────────────────

interface Props {
    open: boolean;
    onClose: () => void;
    invoiceId: string;
    invoiceNumber?: string;
}

interface ReturnLineState {
    item: ReturnableItem;
    selected: boolean;
    quantity: string; // string for controlled input
}

type Step = 1 | 2 | 3;
type Intent = 'RETURN' | 'PRICE_CORRECTION';

// ─── Helpers ────────────────────────────────────────────────────────────────

function safeNum(v: string): number {
    const n = parseFloat(v);
    return isNaN(n) ? 0 : n;
}

// ─── Component ──────────────────────────────────────────────────────────────

export function AdjustSupplierInvoiceModal({ open, onClose, invoiceId, invoiceNumber }: Props) {
    const queryClient = useQueryClient();
    const { openGuard, closeGuard } = useTransactionGuard();
    const guardRef = useRef<GuardHandle | null>(null);

    useEffect(() => {
        if (open) {
            guardRef.current = openGuard({ cancellable: false, label: `Adjust invoice ${invoiceNumber ?? invoiceId.slice(0, 8)}` });
            return () => {
                if (guardRef.current) {
                    closeGuard(guardRef.current.id);
                    guardRef.current = null;
                }
            };
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    const [loading, setLoading] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [context, setContext] = useState<AdjustmentContext | null>(null);
    const [contextError, setContextError] = useState<string | null>(null);

    const [step, setStep] = useState<Step>(1);
    const [intent, setIntent] = useState<Intent>('PRICE_CORRECTION');

    // Step 2A — return goods
    const [returnLines, setReturnLines] = useState<ReturnLineState[]>([]);
    const [returnReason, setReturnReason] = useState('');
    const [returnNotes, setReturnNotes] = useState('');

    // Step 2B — price correction
    const [correctionAmount, setCorrectionAmount] = useState('');
    const [correctionReason, setCorrectionReason] = useState('');
    const [correctionNotes, setCorrectionNotes] = useState('');

    // ── Load context when modal opens ───────────────────────────────────────
    useEffect(() => {
        if (!open || !invoiceId) return;
        setStep(1);
        setContext(null);
        setContextError(null);
        setReturnLines([]);
        setReturnReason('');
        setReturnNotes('');
        setCorrectionAmount('');
        setCorrectionReason('');
        setCorrectionNotes('');

        setLoading(true);
        supplierAdjustmentApi.getContext(invoiceId)
            .then(res => {
                const ctx = res.data.data;
                setContext(ctx);
                setIntent(ctx.suggestedIntent);
                // Initialise return lines for all returnable items (not selected by default)
                setReturnLines(
                    ctx.returnableItems.map(item => ({
                        item,
                        selected: false,
                        quantity: String(item.returnableQuantity),
                    })),
                );
            })
            .catch(err => {
                const msg: string =
                    (err as { response?: { data?: { error?: string } } })?.response?.data?.error ||
                    'Failed to load invoice context';
                setContextError(msg);
            })
            .finally(() => setLoading(false));
    }, [open, invoiceId]);

    // ── Derived ─────────────────────────────────────────────────────────────

    const selectedLines = useMemo(
        () => returnLines.filter(l => l.selected),
        [returnLines],
    );

    const returnTotal = useMemo(
        () => selectedLines.reduce((sum, l) => sum + safeNum(l.quantity) * l.item.unitCost, 0),
        [selectedLines],
    );

    // ── Return line controls ─────────────────────────────────────────────────

    function toggleLine(idx: number) {
        setReturnLines(prev =>
            prev.map((l, i) => (i === idx ? { ...l, selected: !l.selected } : l)),
        );
    }

    function updateQty(idx: number, val: string) {
        setReturnLines(prev =>
            prev.map((l, i) => {
                if (i !== idx) return l;
                const max = l.item.returnableQuantity;
                const num = parseFloat(val);
                const clamped = !isNaN(num) && num > max ? String(max) : val;
                return { ...l, quantity: clamped };
            }),
        );
    }

    // ── Validation ───────────────────────────────────────────────────────────

    function validateStep2(): string | null {
        if (intent === 'RETURN') {
            if (selectedLines.length === 0) return 'Select at least one item to return.';
            for (const l of selectedLines) {
                const q = safeNum(l.quantity);
                if (q <= 0) return `Quantity for ${l.item.productName} must be positive.`;
                if (q > l.item.returnableQuantity) {
                    const consumed = l.item.consumedQuantity ?? 0;
                    if (consumed > 0) {
                        return `${l.item.productName}: only ${l.item.returnableQuantity} on hand can be returned; ${consumed} were sold or consumed.`;
                    }
                    return `Quantity for ${l.item.productName} exceeds returnable amount (${l.item.returnableQuantity}).`;
                }
            }
            if (!returnReason.trim()) return 'Reason is required.';
        } else {
            const amt = safeNum(correctionAmount);
            if (amt <= 0) return 'Amount must be positive.';
            if (context && amt > context.invoice.outstandingBalance) {
                return `Amount (${formatCurrency(amt)}) exceeds outstanding balance (${formatCurrency(context.invoice.outstandingBalance)}).`;
            }
            if (!correctionReason.trim()) return 'Reason is required.';
        }
        return null;
    }

    // ── Navigation ───────────────────────────────────────────────────────────

    function goNext() {
        if (step === 1) {
            setStep(2);
            return;
        }
        if (step === 2) {
            const err = validateStep2();
            if (err) { toast.error(err); return; }
            setStep(3);
        }
    }

    function goBack() {
        if (step === 3) setStep(2);
        else if (step === 2) setStep(1);
    }

    // ── Submit ───────────────────────────────────────────────────────────────

    async function handleSubmit() {
        const err = validateStep2();
        if (err) { toast.error(err); return; }

        setSubmitting(true);
        try {
            // Build unique GRN ID (all selected lines come from the same GRN in this flow;
            // if context has mixed GRNs the user selects per line, we group by grnId).
            let result;
            if (intent === 'RETURN') {
                const grnId = selectedLines[0].item.grnId;
                const lines: AdjustReturnLine[] = selectedLines.map(l => ({
                    grItemId: l.item.grItemId,
                    productId: l.item.productId,
                    batchId: l.item.batchId ?? null,
                    uomId: l.item.uomId ?? null,
                    quantity: safeNum(l.quantity),
                    unitCost: l.item.unitCost,
                }));
                result = await supplierAdjustmentApi.adjust({
                    intent: 'RETURN',
                    invoiceId,
                    grnId,
                    reason: returnReason,
                    notes: returnNotes || undefined,
                    lines,
                });
            } else {
                result = await supplierAdjustmentApi.adjust({
                    intent: 'PRICE_CORRECTION',
                    invoiceId,
                    reason: correctionReason,
                    notes: correctionNotes || undefined,
                    amount: safeNum(correctionAmount),
                });
            }

            const data = result.data.data;
            if (intent === 'RETURN') {
                toast.success(
                    `Return posted: ${data.returnGrnNumber} → Credit Note: ${data.creditNoteNumber}. Apply it to open bills in Credit Notes.`,
                    { duration: 8000 },
                );
            } else {
                toast.success(`Credit note issued: ${data.creditNoteNumber}`, { duration: 6000 });
            }

            // Invalidate relevant queries
            void queryClient.invalidateQueries({ queryKey: ['supplierInvoices'] });
            void queryClient.invalidateQueries({ queryKey: ['suppliers'] });
            void queryClient.invalidateQueries({ queryKey: ['supplierPayments'] });
            void queryClient.invalidateQueries({ queryKey: ['supplierCreditNotes'] });

            onClose();
        } catch (e) {
            const msg: string =
                (e as { response?: { data?: { error?: string } } })?.response?.data?.error ||
                'Adjustment failed. Please try again.';
            toast.error(msg);
        } finally {
            setSubmitting(false);
        }
    }

    // ── Render ───────────────────────────────────────────────────────────────

    const maxCorrectionAmount = context?.invoice.outstandingBalance ?? 0;

    return (
        <Dialog open={open} onOpenChange={v => { if (!v) onClose(); }} zIndex={guardRef.current?.panelZIndex ?? ZINDEX.PANEL}>
            <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>Adjust Invoice {invoiceNumber ?? invoiceId.slice(0, 8)}</DialogTitle>
                    <DialogDescription>
                        {context
                            ? `${context.invoice.supplierName} · Outstanding: ${formatCurrency(context.invoice.outstandingBalance)}`
                            : 'Loading invoice details…'}
                    </DialogDescription>
                </DialogHeader>

                {/* Step indicator */}
                <div className="flex items-center gap-2 text-xs text-gray-500 mb-2">
                    {(['1. Intent', '2. Details', '3. Review'] as const).map((label, i) => (
                        <React.Fragment key={label}>
                            <span className={step === i + 1 ? 'font-bold text-blue-700' : ''}>{label}</span>
                            {i < 2 && <span>›</span>}
                        </React.Fragment>
                    ))}
                </div>

                {/* Loading / error */}
                {loading && <p className="text-sm text-gray-500 py-4 text-center">Loading…</p>}
                {contextError && <p className="text-sm text-red-600 py-4">{contextError}</p>}

                {!loading && !contextError && context && (
                    <>
                        {/* ── Step 1: Intent ───────────────────────────────── */}
                        {step === 1 && (
                            <div className="space-y-4">
                                <p className="text-sm text-gray-600">What would you like to do?</p>

                                <label className={`flex items-start gap-3 border rounded-lg p-4 cursor-pointer transition ${intent === 'RETURN' ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:border-blue-300'}`}>
                                    <input
                                        type="radio"
                                        name="intent"
                                        value="RETURN"
                                        checked={intent === 'RETURN'}
                                        onChange={() => setIntent('RETURN')}
                                        className="mt-1"
                                        disabled={context.returnableItems.length === 0}
                                    />
                                    <div>
                                        <div className="font-medium">Return goods to supplier</div>
                                        <div className="text-xs text-gray-500 mt-0.5">
                                            Physical return — reduces both stock and the invoice balance.
                                            {context.returnableItems.length === 0 && (
                                                <span className="text-amber-600 ml-1">(No returnable items found on linked GRNs)</span>
                                            )}
                                        </div>
                                    </div>
                                </label>

                                <label className={`flex items-start gap-3 border rounded-lg p-4 cursor-pointer transition ${intent === 'PRICE_CORRECTION' ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:border-blue-300'}`}>
                                    <input
                                        type="radio"
                                        name="intent"
                                        value="PRICE_CORRECTION"
                                        checked={intent === 'PRICE_CORRECTION'}
                                        onChange={() => setIntent('PRICE_CORRECTION')}
                                        className="mt-1"
                                    />
                                    <div>
                                        <div className="font-medium">Price correction / overcharge</div>
                                        <div className="text-xs text-gray-500 mt-0.5">
                                            Supplier billed too much — issues a Vendor Credit Memo, no stock movement.
                                        </div>
                                    </div>
                                </label>
                            </div>
                        )}

                        {/* ── Step 2A: Return goods ────────────────────────── */}
                        {step === 2 && intent === 'RETURN' && (
                            <div className="space-y-4">
                                <p className="text-sm font-medium text-gray-700">Select items to return:</p>

                                <div className="border rounded-lg overflow-hidden divide-y">
                                    {/* Group by GRN */}
                                    {Array.from(new Set(returnLines.map(l => l.item.grnId))).map(grnId => {
                                        const grnLines = returnLines.filter(l => l.item.grnId === grnId);
                                        const grnNumber = grnLines[0].item.grnNumber;
                                        return (
                                            <div key={grnId}>
                                                <div className="bg-gray-50 px-3 py-1.5 text-xs font-semibold text-gray-600">
                                                    GRN: {grnNumber}
                                                </div>
                                                {grnLines.map((line, lineIdx) => {
                                                    const globalIdx = returnLines.indexOf(line);
                                                    return (
                                                        <div
                                                            key={line.item.grItemId}
                                                            className={`flex items-center gap-3 px-3 py-2 ${lineIdx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}`}
                                                        >
                                                            <input
                                                                type="checkbox"
                                                                checked={line.selected}
                                                                onChange={() => toggleLine(globalIdx)}
                                                                id={`line-${line.item.grItemId}`}
                                                                className="flex-shrink-0"
                                                            />
                                                            <label htmlFor={`line-${line.item.grItemId}`} className="flex-1 min-w-0 cursor-pointer">
                                                                <div className="text-sm font-medium truncate">{line.item.productName}</div>
                                                                <div className="text-xs text-gray-500">
                                                                    Batch: {line.item.batchNumber ?? '—'} | On hand: {line.item.onHandQuantity ?? '—'}
                                                                    {(line.item.consumedQuantity ?? 0) > 0 && (
                                                                        <span className="text-amber-700">
                                                                            {' '}| Sold/used: {line.item.consumedQuantity}
                                                                        </span>
                                                                    )}
                                                                    {' '}| Max return: {line.item.returnableQuantity}
                                                                </div>
                                                                {line.item.returnBlockReason && (
                                                                    <div className="text-xs text-amber-700 mt-0.5">{line.item.returnBlockReason}</div>
                                                                )}
                                                            </label>
                                                            <div className="flex items-center gap-1 flex-shrink-0">
                                                                <span className="text-xs text-gray-500">Qty</span>
                                                                <input
                                                                    type="number"
                                                                    min="0"
                                                                    max={String(line.item.returnableQuantity)}
                                                                    step="0.001"
                                                                    value={line.quantity}
                                                                    onChange={e => updateQty(globalIdx, e.target.value)}
                                                                    disabled={!line.selected || line.item.returnableQuantity <= 0}
                                                                    className="w-24 text-right text-sm border border-gray-300 rounded px-2 py-1 disabled:opacity-50"
                                                                />
                                                                <span className="text-xs text-gray-400">/ {line.item.returnableQuantity}</span>
                                                            </div>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        );
                                    })}
                                </div>

                                {selectedLines.length > 0 && (
                                    <div className="text-sm text-right font-semibold text-blue-700">
                                        Return total: {formatCurrency(returnTotal)}
                                    </div>
                                )}

                                <div>
                                    <Label htmlFor="return-reason">Reason <span className="text-red-500">*</span></Label>
                                    <Input
                                        id="return-reason"
                                        value={returnReason}
                                        onChange={e => setReturnReason(e.target.value)}
                                        placeholder="e.g. Damaged goods, wrong items received"
                                        className="mt-1"
                                    />
                                </div>
                                <div>
                                    <Label htmlFor="return-notes">Notes</Label>
                                    <Input
                                        id="return-notes"
                                        value={returnNotes}
                                        onChange={e => setReturnNotes(e.target.value)}
                                        placeholder="Optional internal notes"
                                        className="mt-1"
                                    />
                                </div>
                            </div>
                        )}

                        {/* ── Step 2B: Price correction ─────────────────────── */}
                        {step === 2 && intent === 'PRICE_CORRECTION' && (
                            <div className="space-y-4">
                                <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm">
                                    <div className="font-medium text-amber-800">Outstanding balance: {formatCurrency(maxCorrectionAmount)}</div>
                                    <div className="text-amber-700 text-xs mt-0.5">Credit amount cannot exceed outstanding balance.</div>
                                </div>

                                <div>
                                    <Label htmlFor="correction-amount">Credit amount <span className="text-red-500">*</span></Label>
                                    <Input
                                        id="correction-amount"
                                        type="number"
                                        max={String(maxCorrectionAmount)}
                                        step="1"
                                        value={correctionAmount}
                                        onChange={e => setCorrectionAmount(e.target.value)}
                                        placeholder="0.00"
                                        className="mt-1"
                                    />
                                </div>
                                <div>
                                    <Label htmlFor="correction-reason">Reason <span className="text-red-500">*</span></Label>
                                    <Input
                                        id="correction-reason"
                                        value={correctionReason}
                                        onChange={e => setCorrectionReason(e.target.value)}
                                        placeholder="e.g. Invoice price higher than agreed PO price"
                                        className="mt-1"
                                    />
                                </div>
                                <div>
                                    <Label htmlFor="correction-notes">Notes</Label>
                                    <Input
                                        id="correction-notes"
                                        value={correctionNotes}
                                        onChange={e => setCorrectionNotes(e.target.value)}
                                        placeholder="Optional internal notes"
                                        className="mt-1"
                                    />
                                </div>
                            </div>
                        )}

                        {/* ── Step 3: Review ───────────────────────────────── */}
                        {step === 3 && (
                            <div className="space-y-4">
                                <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-sm space-y-2">
                                    <div className="font-semibold text-blue-800">Review & Confirm</div>

                                    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-gray-700">
                                        <span className="font-medium">Invoice:</span>
                                        <span>{context.invoice.invoiceNumber}</span>

                                        <span className="font-medium">Supplier:</span>
                                        <span>{context.invoice.supplierName}</span>

                                        <span className="font-medium">Action:</span>
                                        <span>{intent === 'RETURN' ? 'Return Goods' : 'Price Correction'}</span>

                                        {intent === 'RETURN' && (
                                            <>
                                                <span className="font-medium">Items:</span>
                                                <span>{selectedLines.length} line(s)</span>
                                                <span className="font-medium">Return total:</span>
                                                <span>{formatCurrency(returnTotal)}</span>
                                                <span className="font-medium">Reason:</span>
                                                <span>{returnReason}</span>
                                            </>
                                        )}

                                        {intent === 'PRICE_CORRECTION' && (
                                            <>
                                                <span className="font-medium">Credit amount:</span>
                                                <span>{formatCurrency(safeNum(correctionAmount))}</span>
                                                <span className="font-medium">Reason:</span>
                                                <span>{correctionReason}</span>
                                            </>
                                        )}
                                    </div>
                                </div>

                                <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 text-xs text-gray-600 space-y-1">
                                    <div className="font-semibold text-gray-700">Documents that will be created:</div>
                                    {intent === 'RETURN' ? (
                                        <>
                                            <div>• <span className="font-medium">Return GRN (RGRN-…)</span> — stock will be deducted</div>
                                            <div>• <span className="font-medium">Supplier Credit Note (SCN-…)</span> — posted to GL; apply to bill in Credit Notes</div>
                                            <div className="mt-1 text-gray-500">GL: DR AP / CR Inventory (net effect)</div>
                                        </>
                                    ) : (
                                        <>
                                            <div>• <span className="font-medium">Vendor Credit Memo (SCN-…)</span> — reduces invoice balance</div>
                                            <div className="mt-1 text-gray-500">GL: DR AP / CR GRN/IR Clearing</div>
                                        </>
                                    )}
                                </div>
                            </div>
                        )}
                    </>
                )}

                <DialogFooter className="gap-2 mt-4">
                    {step > 1 && !submitting && (
                        <Button variant="outline" onClick={goBack}>Back</Button>
                    )}
                    <Button variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
                    {step < 3 && !contextError && !loading && (
                        <Button onClick={goNext} disabled={!context}>Next →</Button>
                    )}
                    {step === 3 && (
                        <Button
                            onClick={handleSubmit}
                            disabled={submitting}
                            className="bg-blue-700 hover:bg-blue-800 text-white"
                        >
                            {submitting ? 'Processing…' : 'Confirm & Submit'}
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}