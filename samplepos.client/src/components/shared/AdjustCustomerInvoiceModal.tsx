/**
 * AdjustCustomerInvoiceModal — SAP/Odoo-style customer invoice correction wizard.
 */

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
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
    customerInvoiceAdjustmentApi,
    type AdjustmentContext,
    type OverchargeLine,
    type ReturnableSaleLine,
} from '../../services/customerInvoiceAdjustmentApi';
import { formatSellingQuantityWithBaseHint, sellingQtyToBase } from '@shared/utils/sale-item-uom';

interface Props {
    open: boolean;
    onClose: () => void;
    invoiceId: string;
    invoiceNumber?: string;
    customerId?: string;
}

type Step = 1 | 2 | 3;
type Intent = 'PRICE_CORRECTION' | 'RETURN_GOODS';

interface ReturnLineState {
    line: ReturnableSaleLine;
    selected: boolean;
    quantity: string;
}

function AdjustmentCapacityHint({
    step,
    intent,
    existingCreditNoteTotal = 0,
    maxAdditionalCredit = 0,
}: {
    step: Step;
    intent: Intent;
    existingCreditNoteTotal?: number;
    maxAdditionalCredit?: number;
}) {
    // Only surface operational limits — not training copy.
    if (step === 2 && intent === 'PRICE_CORRECTION' && existingCreditNoteTotal > 0) {
        return (
            <p className="mb-3 text-xs text-amber-800">
                Prior credit notes on this invoice: {formatCurrency(existingCreditNoteTotal)}.
                Remaining capacity: {formatCurrency(maxAdditionalCredit)}.
            </p>
        );
    }
    return null;
}

export function AdjustCustomerInvoiceModal({
    open,
    onClose,
    invoiceId,
    invoiceNumber,
    customerId,
}: Props) {
    const queryClient = useQueryClient();
    const { openGuard, closeGuard } = useTransactionGuard();
    const guardRef = useRef<GuardHandle | null>(null);

    useEffect(() => {
        if (open) {
            guardRef.current = openGuard({
                cancellable: false,
                label: `Adjust invoice ${invoiceNumber ?? invoiceId.slice(0, 8)}`,
            });
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

    const [selectedOvercharge, setSelectedOvercharge] = useState<Set<string>>(new Set());
    const [priceReason, setPriceReason] = useState('');
    const [priceNotes, setPriceNotes] = useState('');

    const [returnLines, setReturnLines] = useState<ReturnLineState[]>([]);
    const [returnReason, setReturnReason] = useState('');
    const [returnNotes, setReturnNotes] = useState('');

    useEffect(() => {
        if (!open || !invoiceId) return;
        setStep(1);
        setContext(null);
        setContextError(null);
        setPriceReason('');
        setPriceNotes('');
        setReturnReason('');
        setReturnNotes('');

        setLoading(true);
        customerInvoiceAdjustmentApi.getContext(invoiceId)
            .then(res => {
                const ctx = res.data.data;
                setContext(ctx);
                const suggested = ctx.suggestedIntent === 'NONE'
                    ? (ctx.overchargeLines.length > 0 ? 'PRICE_CORRECTION' : 'RETURN_GOODS')
                    : ctx.suggestedIntent;
                setIntent(suggested as Intent);
                setSelectedOvercharge(new Set(ctx.overchargeLines.map(l => l.saleItemId)));
                setReturnLines(
                    ctx.returnableLines.map(line => ({
                        line,
                        selected: false,
                        quantity: String(line.returnableQuantity),
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

    const selectedOverchargeLines = useMemo(
        () => (context?.overchargeLines ?? []).filter(l => selectedOvercharge.has(l.saleItemId)),
        [context, selectedOvercharge],
    );

    const priceCorrectionTotal = useMemo(
        () => selectedOverchargeLines.reduce((sum, l) => sum + l.suggestedLineCredit, 0),
        [selectedOverchargeLines],
    );

    const maxAdditionalCredit = context?.maxAdditionalCredit ?? 0;

    const selectedReturnLines = useMemo(
        () => returnLines.filter(l => l.selected),
        [returnLines],
    );

    const returnTotal = useMemo(
        () => selectedReturnLines.reduce((sum, l) => {
            const qty = parseFloat(l.quantity || '0');
            const net = qty * l.line.unitPrice;
            const rate = Number(l.line.taxRate || 0);
            return sum + net * (1 + rate / 100);
        }, 0),
        [selectedReturnLines],
    );

    function toggleOvercharge(id: string) {
        setSelectedOvercharge(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }

    function toggleReturn(idx: number) {
        setReturnLines(prev =>
            prev.map((l, i) => (i === idx ? { ...l, selected: !l.selected } : l)),
        );
    }

    function updateReturnQty(idx: number, val: string) {
        setReturnLines(prev =>
            prev.map((l, i) => {
                if (i !== idx) return l;
                const max = l.line.returnableQuantity;
                const num = parseFloat(val);
                const clamped = !isNaN(num) && num > max ? String(max) : val;
                return { ...l, quantity: clamped };
            }),
        );
    }

    function validateStep2(): string | null {
        if (intent === 'PRICE_CORRECTION') {
            if (selectedOverchargeLines.length === 0) return 'Select at least one overcharged line.';
            if (priceCorrectionTotal > maxAdditionalCredit + 0.01) {
                return `Selected credit (${formatCurrency(priceCorrectionTotal)}) exceeds the maximum allowed (${formatCurrency(maxAdditionalCredit)}).`;
            }
            if (maxAdditionalCredit <= 0.01) {
                return 'No further price correction is available on this invoice (prior credit notes may already apply).';
            }
            if (!priceReason.trim()) return 'Reason is required.';
        } else {
            if (selectedReturnLines.length === 0) return 'Select at least one line to return.';
            for (const l of selectedReturnLines) {
                const q = parseFloat(l.quantity);
                if (!q || q <= 0) return `Quantity for ${l.line.productName} must be positive.`;
                if (q > l.line.returnableQuantity) {
                    return `Quantity for ${l.line.productName} exceeds sale quantity.`;
                }
            }
            if (!returnReason.trim()) return 'Reason is required.';
        }
        return null;
    }

    function goNext() {
        if (step === 1) {
            if (!context || context.suggestedIntent === 'NONE' &&
                context.overchargeLines.length === 0 && context.returnableLines.length === 0) {
                toast.error('No adjustments available for this invoice.');
                return;
            }
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

    async function handleSubmit() {
        const err = validateStep2();
        if (err) { toast.error(err); return; }

        setSubmitting(true);
        try {
            let result;
            if (intent === 'PRICE_CORRECTION') {
                result = await customerInvoiceAdjustmentApi.adjust({
                    intent: 'PRICE_CORRECTION',
                    invoiceId,
                    reason: priceReason,
                    notes: priceNotes || undefined,
                    lines: selectedOverchargeLines.map(l => ({ saleItemId: l.saleItemId })),
                });
            } else {
                result = await customerInvoiceAdjustmentApi.adjust({
                    intent: 'RETURN_GOODS',
                    invoiceId,
                    reason: returnReason,
                    notes: returnNotes || undefined,
                    lines: selectedReturnLines.map(l => {
                        const q = parseFloat(l.quantity);
                        if (!Number.isFinite(q) || q <= 0) {
                            throw new Error(`Invalid return quantity for ${l.line.productName}`);
                        }
                        return {
                            saleItemId: l.line.saleItemId,
                            quantity: q,
                        };
                    }),
                });
            }

            const data = result.data.data;
            toast.success(
                `Credit note ${data.creditNoteNumber} posted (${formatCurrency(data.totalCredit)})`,
                { duration: 6000 },
            );

            void queryClient.invalidateQueries({ queryKey: ['invoices'] });
            if (customerId) {
                void queryClient.invalidateQueries({ queryKey: ['customers', customerId] });
                void queryClient.invalidateQueries({ queryKey: ['customer', customerId] });
            }

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

    const canPriceCorrect = (context?.overchargeLines.length ?? 0) > 0;
    const canReturn = (context?.returnableLines.length ?? 0) > 0;

    function renderOverchargeTable(lines: OverchargeLine[]) {
        return (
            <div className="overflow-x-auto border rounded">
                <table className="min-w-full text-sm">
                    <thead className="bg-gray-50">
                        <tr>
                            <th className="px-2 py-1 text-left" />
                            <th className="px-2 py-1 text-left">Product</th>
                            <th className="px-2 py-1 text-right">Qty</th>
                            <th className="px-2 py-1 text-right">Charged</th>
                            <th className="px-2 py-1 text-right">Correct</th>
                            <th className="px-2 py-1 text-right">Credit</th>
                        </tr>
                    </thead>
                    <tbody>
                        {lines.map(line => (
                            <tr key={line.saleItemId} className="border-t">
                                <td className="px-2 py-1">
                                    <input
                                        type="checkbox"
                                        checked={selectedOvercharge.has(line.saleItemId)}
                                        onChange={() => toggleOvercharge(line.saleItemId)}
                                    />
                                </td>
                                <td className="px-2 py-1">{line.productName}</td>
                                <td className="px-2 py-1 text-right">{line.quantity}</td>
                                <td className="px-2 py-1 text-right">{formatCurrency(line.unitPriceCharged)}</td>
                                <td className="px-2 py-1 text-right">{formatCurrency(line.suggestedCorrectUnitPrice)}</td>
                                <td className="px-2 py-1 text-right font-medium">{formatCurrency(line.suggestedLineCredit)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        );
    }

    if (!open) return null;

    const panelZ = guardRef.current?.panelZIndex ?? ZINDEX.NESTED_PANEL;

    return createPortal(
        <div
            className="fixed inset-0 flex items-center justify-center bg-black/50 p-4 overflow-y-auto"
            style={{ zIndex: panelZ }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="adjust-invoice-title"
            onClick={(e) => {
                if (e.target === e.currentTarget && !submitting) onClose();
            }}
        >
            <div
                className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto flex flex-col"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="p-6 border-b border-gray-200">
                    <h2 id="adjust-invoice-title" className="text-lg font-semibold text-gray-900">
                        Create Credit Note — {invoiceNumber ?? invoiceId.slice(0, 8)}
                    </h2>
                    <p className="text-sm text-gray-500 mt-1">
                        {context
                            ? `${context.invoice.customerName} · Invoice balance: ${formatCurrency(context.invoice.outstandingBalance)}`
                            : 'Loading invoice lines…'}
                    </p>
                </div>
                <div className="p-6 flex-1 overflow-y-auto">

                <div className="flex items-center gap-2 text-xs text-gray-500 mb-2">
                    {(['1. Intent', '2. Lines', '3. Review'] as const).map((label, i) => (
                        <React.Fragment key={label}>
                            <span className={step === i + 1 ? 'font-bold text-blue-700' : ''}>{label}</span>
                            {i < 2 && <span>›</span>}
                        </React.Fragment>
                    ))}
                </div>

                {loading && <p className="text-gray-500">Loading adjustment context…</p>}
                {contextError && <p className="text-red-600">{contextError}</p>}

                {!loading && !contextError && context && (
                    <>
                        <AdjustmentCapacityHint
                            step={step}
                            intent={intent}
                            existingCreditNoteTotal={context?.existingCreditNoteTotal ?? 0}
                            maxAdditionalCredit={maxAdditionalCredit}
                        />
                        {step === 1 && (
                            <div className="space-y-3">
                                <p className="text-sm text-gray-600">
                                    Pricing mode: <strong>{context.customerPricingMode}</strong>
                                    {context.invoice.saleNumber && (
                                        <> · Sale: <strong>{context.invoice.saleNumber}</strong></>
                                    )}
                                </p>
                                <div className="grid gap-2">
                                    <label className={`flex items-start gap-3 p-3 border rounded cursor-pointer ${!canPriceCorrect ? 'opacity-50' : ''}`}>
                                        <input
                                            type="radio"
                                            name="intent"
                                            checked={intent === 'PRICE_CORRECTION'}
                                            disabled={!canPriceCorrect}
                                            onChange={() => setIntent('PRICE_CORRECTION')}
                                        />
                                        <div>
                                            <div className="font-medium">Price correction</div>
                                            <div className="text-sm text-gray-600">
                                                Credit note for overcharged lines (no stock movement).
                                                {canPriceCorrect && ` ${context.overchargeLines.length} line(s) eligible.`}
                                            </div>
                                        </div>
                                    </label>
                                    <label className={`flex items-start gap-3 p-3 border rounded cursor-pointer ${!canReturn ? 'opacity-50' : ''}`}>
                                        <input
                                            type="radio"
                                            name="intent"
                                            checked={intent === 'RETURN_GOODS'}
                                            disabled={!canReturn}
                                            onChange={() => setIntent('RETURN_GOODS')}
                                        />
                                        <div>
                                            <div className="font-medium">Return goods</div>
                                            <div className="text-sm text-gray-600">
                                                Credit note + stock return + COGS reversal.
                                            </div>
                                        </div>
                                    </label>
                                </div>
                            </div>
                        )}

                        {step === 2 && intent === 'PRICE_CORRECTION' && (
                            <div className="space-y-3">
                                {renderOverchargeTable(context.overchargeLines)}
                                <p className="text-sm font-medium">
                                    Selected credit: {formatCurrency(priceCorrectionTotal)}
                                </p>
                                <div>
                                    <Label htmlFor="price-reason">Reason *</Label>
                                    <Input
                                        id="price-reason"
                                        value={priceReason}
                                        onChange={e => setPriceReason(e.target.value)}
                                        placeholder="e.g. AT_COST pricing correction"
                                    />
                                </div>
                                <div>
                                    <Label htmlFor="price-notes">Notes</Label>
                                    <Input
                                        id="price-notes"
                                        value={priceNotes}
                                        onChange={e => setPriceNotes(e.target.value)}
                                    />
                                </div>
                            </div>
                        )}

                        {step === 2 && intent === 'RETURN_GOODS' && (
                            <div className="space-y-3">
                                <div className="overflow-x-auto border rounded">
                                    <table className="min-w-full text-sm">
                                        <thead className="bg-gray-50">
                                            <tr>
                                                <th />
                                                <th className="px-2 py-1 text-left">Product</th>
                                                <th className="px-2 py-1 text-right">Sold / available</th>
                                                <th className="px-2 py-1 text-right">Return qty</th>
                                                <th className="px-2 py-1 text-right">Unit price</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {returnLines.map((rl, idx) => (
                                                <tr key={rl.line.saleItemId} className="border-t">
                                                    <td className="px-2 py-1">
                                                        <input
                                                            type="checkbox"
                                                            checked={rl.selected}
                                                            onChange={() => toggleReturn(idx)}
                                                        />
                                                    </td>
                                                    <td className="px-2 py-1">{rl.line.productName}</td>
                                                    <td className="px-2 py-1 text-right text-xs text-gray-600">
                                                        {formatSellingQuantityWithBaseHint(rl.line.quantity, {
                                                            uomSymbol: rl.line.uomSymbol,
                                                            uomName: rl.line.uomName,
                                                            baseUomSymbol: rl.line.baseUomSymbol,
                                                            conversionFactor: rl.line.conversionFactor,
                                                        })}
                                                        {rl.line.refundedQuantity > 0 && (
                                                            <div className="text-amber-700">
                                                                Returned: {formatSellingQuantityWithBaseHint(rl.line.refundedQuantity, {
                                                                    uomSymbol: rl.line.uomSymbol,
                                                                    uomName: rl.line.uomName,
                                                                    baseUomSymbol: rl.line.baseUomSymbol,
                                                                    conversionFactor: rl.line.conversionFactor,
                                                                })}
                                                            </div>
                                                        )}
                                                        <div className="text-blue-700">
                                                            Max: {formatSellingQuantityWithBaseHint(rl.line.returnableQuantity, {
                                                                uomSymbol: rl.line.uomSymbol,
                                                                uomName: rl.line.uomName,
                                                                baseUomSymbol: rl.line.baseUomSymbol,
                                                                conversionFactor: rl.line.conversionFactor,
                                                            })}
                                                        </div>
                                                    </td>
                                                    <td className="px-2 py-1 text-right">
                                                        <input
                                                            className="w-20 border rounded px-1 text-right"
                                                            value={rl.quantity}
                                                            disabled={!rl.selected}
                                                            onChange={e => updateReturnQty(idx, e.target.value)}
                                                        />
                                                        {rl.selected && rl.line.conversionFactor > 1 && (
                                                            <div className="text-[10px] text-gray-500 mt-0.5">
                                                                → {sellingQtyToBase(parseFloat(rl.quantity) || 0, rl.line.conversionFactor)}{' '}
                                                                {rl.line.baseUomSymbol || 'base'} to stock
                                                            </div>
                                                        )}
                                                    </td>
                                                    <td className="px-2 py-1 text-right">{formatCurrency(rl.line.unitPrice)}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                                <div>
                                    <Label htmlFor="return-reason">Reason *</Label>
                                    <Input
                                        id="return-reason"
                                        value={returnReason}
                                        onChange={e => setReturnReason(e.target.value)}
                                    />
                                </div>
                                <div>
                                    <Label htmlFor="return-notes">Notes</Label>
                                    <Input
                                        id="return-notes"
                                        value={returnNotes}
                                        onChange={e => setReturnNotes(e.target.value)}
                                    />
                                </div>
                            </div>
                        )}

                        {step === 3 && (
                            <div className="space-y-2 text-sm">
                                <p><strong>Intent:</strong> {intent === 'PRICE_CORRECTION' ? 'Price correction' : 'Return goods'}</p>
                                <p><strong>Total credit:</strong> {formatCurrency(intent === 'PRICE_CORRECTION' ? priceCorrectionTotal : returnTotal)}</p>
                                {intent === 'PRICE_CORRECTION' && (context?.existingCreditNoteTotal ?? 0) > 0 && (
                                    <p className="text-amber-800 text-xs">
                                        Prior posted credits: {formatCurrency(context.existingCreditNoteTotal)}.
                                        {' '}Maximum for this post: {formatCurrency(maxAdditionalCredit)}.
                                    </p>
                                )}
                                {intent === 'PRICE_CORRECTION' && (
                                    <ul className="list-disc pl-5">
                                        {selectedOverchargeLines.map(l => (
                                            <li key={l.saleItemId}>
                                                {l.productName} × {l.quantity}: {formatCurrency(l.suggestedLineCredit)}
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </div>
                        )}
                    </>
                )}

                </div>

                <div className="p-6 border-t border-gray-200 flex flex-wrap justify-end gap-2">
                    {step > 1 && (
                        <Button variant="outline" onClick={goBack} disabled={submitting}>
                            Back
                        </Button>
                    )}
                    <Button variant="outline" onClick={onClose} disabled={submitting}>
                        Cancel
                    </Button>
                    {step < 3 ? (
                        <Button onClick={goNext} disabled={loading || !!contextError}>
                            Next
                        </Button>
                    ) : (
                        <Button onClick={() => void handleSubmit()} disabled={submitting || loading}>
                            {submitting ? 'Posting…' : 'Post credit note'}
                        </Button>
                    )}
                </div>
            </div>
        </div>,
        document.body,
    );
}
