import { useState, useEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { api } from '../../utils/api';
import { extractApiError } from '../../utils/extractApiError';
import { formatCurrency } from '../../utils/currency';
import { useTransactionGuard, ZINDEX } from '../../hooks/useTransactionGuard';
import type { GuardHandle } from '../../hooks/useTransactionGuard';

import { formatSellingQuantityWithBaseHint, sellingQtyToBase } from '@shared/utils/sale-item-uom';
import { projectSaleRefundChargedFromSale } from '@shared/domain/saleDiscountSsot';

interface RefundItem {
    saleItemId: string;
    productName: string;
    quantity: number;
    refundedQty: number;
    unitPrice: number;
    maxRefundable: number;
    selected: boolean;
    refundQuantity: number;
    lineNet: number;
    uomSymbol: string | null;
    uomName: string | null;
    baseUomSymbol: string | null;
    conversionFactor: number;
}

interface RefundSaleModalProps {
    saleId: string;
    saleNumber: string;
    totalAmount: number;
    taxAmount?: number;
    refundedChargedTotal?: number;
    items: {
        id?: string;
        productName?: string;
        product_name?: string;
        quantity: number | string;
        qty?: number | string;
        unitPrice?: number | string;
        unit_price?: number | string;
        price?: number | string;
        refundedQty?: number | string;
        refunded_qty?: number | string;
        conversionFactor?: number | string;
        conversion_factor?: number | string;
        uomSymbol?: string | null;
        uom_symbol?: string | null;
        uomName?: string | null;
        uom_name?: string | null;
        baseUomSymbol?: string | null;
        base_uom_symbol?: string | null;
        totalPrice?: number | string;
        total_price?: number | string;
        lineTotal?: number | string;
        line_total?: number | string;
    }[];
    /** refund = full/partial return; exchange = wrong-product swap (store credit + replacement) */
    mode?: 'refund' | 'exchange';
    customerId?: string;
    customerName?: string;
    onClose: () => void;
    onSuccess: () => void;
}

export function RefundSaleModal({
    saleId,
    saleNumber,
    totalAmount,
    taxAmount = 0,
    refundedChargedTotal = 0,
    items,
    mode = 'refund',
    customerId,
    customerName,
    onClose,
    onSuccess,
}: RefundSaleModalProps) {
    const navigate = useNavigate();
    const isExchange = mode === 'exchange';
    const [reason, setReason] = useState(isExchange ? 'Customer exchange - wrong product selected' : '');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [successResult, setSuccessResult] = useState<{
        refundId: string;
        refundNumber: string;
        totalAmount: number;
        isFullRefund: boolean;
        itemsRestored: number;
    } | null>(null);
    const modalRef = useRef<HTMLDivElement>(null);

    // ── Transaction Guard ──────────────────────────────────────────────────
    const { openGuard, closeGuard } = useTransactionGuard();
    const guardRef = useRef<GuardHandle | null>(null);
    useEffect(() => {
        guardRef.current = openGuard({ cancellable: false, label: isExchange ? 'Process product exchange' : 'Process sale refund/return' });
        return () => { if (guardRef.current) { closeGuard(guardRef.current.id); guardRef.current = null; } };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Build refundable items list
    const [refundItems, setRefundItems] = useState<RefundItem[]>(() =>
        items
            .filter((item) => item.id) // Only items with IDs can be refunded
            .map((item) => {
                const qty = Number(item.quantity || item.qty || 0);
                const refundedQty = Number(item.refundedQty || item.refunded_qty || 0);
                const maxRefundable = qty - refundedQty;
                const conversionFactor = Number(
                    item.conversionFactor ?? item.conversion_factor ?? 1,
                );
                return {
                    saleItemId: item.id!,
                    productName: item.productName || item.product_name || 'Unknown Product',
                    quantity: qty,
                    refundedQty,
                    unitPrice: Number(item.unitPrice || item.unit_price || item.price || 0),
                    lineNet: Number(
                        item.totalPrice || item.total_price || item.lineTotal || item.line_total || 0,
                    ),
                    maxRefundable,
                    selected: false,
                    refundQuantity: maxRefundable,
                    uomSymbol: item.uomSymbol ?? item.uom_symbol ?? null,
                    uomName: item.uomName ?? item.uom_name ?? null,
                    baseUomSymbol: item.baseUomSymbol ?? item.base_uom_symbol ?? null,
                    conversionFactor: Number.isFinite(conversionFactor) && conversionFactor > 0
                        ? conversionFactor
                        : 1,
                };
            })
            .filter((item) => item.maxRefundable > 0) // Only show items with remaining refundable qty
    );

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [onClose]);

    const toggleItem = (idx: number) => {
        setRefundItems((prev) =>
            prev.map((item, i) =>
                i === idx ? { ...item, selected: !item.selected } : item
            )
        );
    };

    const updateQuantity = (idx: number, qty: number) => {
        const safeQty = Number.isFinite(qty) ? qty : 1;
        setRefundItems((prev) =>
            prev.map((item, i) =>
                i === idx
                    ? { ...item, refundQuantity: Math.max(1, Math.min(safeQty, item.maxRefundable)) }
                    : item
            )
        );
    };

    const selectAll = () => {
        const allSelected = refundItems.every((i) => i.selected);
        setRefundItems((prev) =>
            prev.map((item) => ({
                ...item,
                selected: !allSelected,
                refundQuantity: !allSelected ? item.maxRefundable : item.refundQuantity,
            }))
        );
    };

    const selectedItems = useMemo(() => refundItems.filter((i) => i.selected), [refundItems]);

    const refundCharged = useMemo(() => {
        const thisQtyByItemId: Record<string, number> = {};
        for (const item of selectedItems) {
            thisQtyByItemId[item.saleItemId] = item.refundQuantity;
        }
        return projectSaleRefundChargedFromSale({
            sale: { totalAmount, taxAmount, refundedChargedTotal },
            items: refundItems.map((item) => ({
                id: item.saleItemId,
                quantity: item.quantity,
                remainingQty: item.maxRefundable,
                unitPrice: item.unitPrice,
                totalPrice: item.lineNet,
            })),
            thisQtyByItemId,
            alreadyRefundedCharged: refundedChargedTotal,
        });
    }, [selectedItems, refundItems, totalAmount, taxAmount, refundedChargedTotal]);
    const refundTotal = refundCharged.refundChargedTotal;

    const isFullRefund = useMemo(() => {
        return refundItems.length > 0 && refundItems.every(
            (item) => item.selected && item.refundQuantity === item.maxRefundable
        );
    }, [refundItems]);

    const handleRefund = async () => {
        if (selectedItems.length === 0) {
            setError('Select at least one item to refund');
            return;
        }
        if (!reason.trim()) {
            setError('A reason is required for the refund');
            return;
        }
        if (reason.trim().length < 5) {
            setError('Reason must be at least 5 characters');
            return;
        }

        setError(null);
        setIsSubmitting(true);
        try {
            const invalidQty = selectedItems.some((item) => !Number.isFinite(item.refundQuantity) || item.refundQuantity <= 0);
            if (invalidQty) {
                setError('One or more return quantities are invalid');
                setIsSubmitting(false);
                return;
            }
            const response = await api.sales.refundSale(saleId, {
                items: selectedItems.map((item) => ({
                    saleItemId: item.saleItemId,
                    quantity: item.refundQuantity,
                })),
                reason: reason.trim(),
                refundType: isExchange ? 'EXCHANGE' : 'REFUND',
            });
            const data = response.data.data as {
                refund: { id: string; refundNumber: string; totalAmount: number | string };
                isFullRefund: boolean;
                itemsRestored: number;
            };
            setSuccessResult({
                refundNumber: data.refund.refundNumber,
                refundId: data.refund.id,
                totalAmount: Number(data.refund.totalAmount),
                isFullRefund: data.isFullRefund,
                itemsRestored: data.itemsRestored,
            });
        } catch (err: unknown) {
            setError(extractApiError(err, 'Failed to process return'));
        } finally {
            setIsSubmitting(false);
        }
    };

    // Success state
    if (successResult) {
        return createPortal(
            <div
                className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center"
                style={{ zIndex: guardRef.current?.panelZIndex ?? ZINDEX.PANEL }}
                onClick={(e) => { if (e.target === e.currentTarget) onSuccess(); }}
                role="dialog"
                aria-modal="true"
            >
                <div className="bg-white rounded-lg max-w-md w-full mx-4 shadow-xl">
                    <div className="px-6 py-8 text-center">
                        <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
                            <svg className="h-8 w-8 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                            </svg>
                        </div>
                        <h3 className="text-lg font-semibold text-gray-900 mb-2">
                            {isExchange ? 'Exchange Credit Posted' : 'Return Processed'}
                        </h3>
                        <p className="text-sm text-gray-600 mb-2">
                            {isExchange
                                ? 'Wrong item(s) returned to stock. Sell the replacement at POS and apply this credit.'
                                : successResult.isFullRefund
                                    ? 'Full return completed successfully.'
                                    : 'Partial return completed successfully.'}
                        </p>
                        <p className="text-xs text-gray-500 mb-4">
                            Stock restored
                            {isExchange ? ' · Store credit ready for replacement sale' : ' · Return document posted · Refund issued'}
                        </p>
                        <div className="bg-gray-50 rounded-lg p-4 border border-gray-200 mb-4 space-y-2">
                            <div className="flex justify-between text-sm">
                                <span className="text-gray-500">{isExchange ? 'Exchange return #' : 'Return #'}</span>
                                <span className="font-mono font-semibold text-gray-900">{successResult.refundNumber}</span>
                            </div>
                            <div className="flex justify-between text-sm">
                                <span className="text-gray-500">{isExchange ? 'Exchange Credit' : 'Refund Amount'}</span>
                                <span className="font-semibold text-gray-900">{formatCurrency(successResult.totalAmount)}</span>
                            </div>
                            <div className="flex justify-between text-sm">
                                <span className="text-gray-500">Items Restored to Stock</span>
                                <span className="font-semibold text-gray-900">{successResult.itemsRestored}</span>
                            </div>
                        </div>
                        {isExchange ? (
                            <div className="flex flex-col gap-2">
                                <button
                                    onClick={() => {
                                        sessionStorage.setItem(
                                            'pos_exchange_credit',
                                            JSON.stringify({
                                                refundId: successResult.refundId,
                                                amount: successResult.totalAmount,
                                                saleNumber,
                                                refundNumber: successResult.refundNumber,
                                                customerId: customerId || null,
                                                customerName: customerName || null,
                                            })
                                        );
                                        onSuccess();
                                        navigate('/pos');
                                    }}
                                    className="w-full px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium text-sm"
                                >
                                    Sell Replacement at POS
                                </button>
                                <button
                                    onClick={onSuccess}
                                    className="w-full px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 font-medium text-sm"
                                >
                                    Done
                                </button>
                            </div>
                        ) : (
                            <button
                                onClick={onSuccess}
                                className="w-full px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium text-sm"
                            >
                                Done
                            </button>
                        )}
                    </div>
                </div>
            </div>,
            document.body
        );
    }

    return createPortal(
        <div
            className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center"
            style={{ zIndex: guardRef.current?.panelZIndex ?? ZINDEX.PANEL }}
            onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="refund-modal-title"
        >
            <div ref={modalRef} className="bg-white rounded-lg max-w-2xl w-full mx-4 shadow-xl max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
                {/* Header */}
                <div className="flex items-center gap-3 px-6 py-4 border-b border-gray-200 bg-amber-50 rounded-t-lg flex-shrink-0">
                    <div className="flex-shrink-0 w-10 h-10 bg-amber-100 rounded-full flex items-center justify-center">
                        <svg className="h-5 w-5 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
                        </svg>
                    </div>
                    <div className="flex-1">
                        <h3 id="refund-modal-title" className="text-lg font-semibold text-amber-900">
                            {isExchange ? 'Exchange Product' : 'Return Sale'}
                        </h3>
                        <p className="text-sm text-amber-700">{saleNumber} &middot; {formatCurrency(totalAmount)}</p>
                    </div>
                </div>

                {/* Body */}
                <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
                    {/* Brief path label only */}
                    <p className="text-sm text-gray-600">
                        {isExchange
                            ? 'Select items to exchange for a different product.'
                            : 'Select items to return. Refund uses the original payment method.'}
                    </p>
                    {refundItems.length === 0 ? (
                        <div className="bg-gray-50 rounded-lg p-6 text-center text-gray-500">
                            <p className="font-medium">No items available for return</p>
                            <p className="text-sm mt-1">All items in this sale have already been fully returned.</p>
                        </div>
                    ) : (
                        <>
                            {/* Select All */}
                            <div className="flex items-center justify-between">
                                <span className="text-sm font-medium text-gray-700">
                                    Select items to return ({selectedItems.length} of {refundItems.length})
                                </span>
                                <button
                                    type="button"
                                    onClick={selectAll}
                                    className="text-sm text-blue-600 hover:text-blue-800 font-medium"
                                >
                                    {refundItems.every((i) => i.selected) ? 'Deselect All' : isExchange ? 'Select All Items' : 'Select All (Full Return)'}
                                </button>
                            </div>

                            {/* Item List */}
                            <div className="border border-gray-200 rounded-lg divide-y divide-gray-200">
                                {refundItems.map((item, idx) => (
                                    <div
                                        key={item.saleItemId}
                                        className={`p-4 transition-colors ${item.selected ? 'bg-blue-50' : 'hover:bg-gray-50'}`}
                                    >
                                        <div className="flex items-start gap-3">
                                            <input
                                                type="checkbox"
                                                checked={item.selected}
                                                onChange={() => toggleItem(idx)}
                                                className="mt-1 h-4 w-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                                                disabled={isSubmitting}
                                            />
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center justify-between">
                                                    <span className="font-medium text-gray-900 truncate">{item.productName}</span>
                                                    <span className="text-sm font-semibold text-gray-900 ml-2 flex-shrink-0">
                                                        {formatCurrency(
                                                            refundCharged.lines.find((line) => line.saleItemId === item.saleItemId)?.lineCharged || 0,
                                                        )}
                                                    </span>
                                                </div>
                                                <div className="flex items-center gap-4 mt-1 text-xs text-gray-500 flex-wrap">
                                                    <span>Unit price: {formatCurrency(item.unitPrice)}</span>
                                                    <span>
                                                        Sold:{' '}
                                                        {formatSellingQuantityWithBaseHint(item.quantity, {
                                                            uomSymbol: item.uomSymbol,
                                                            uomName: item.uomName,
                                                            baseUomSymbol: item.baseUomSymbol,
                                                            conversionFactor: item.conversionFactor,
                                                        })}
                                                    </span>
                                                    {item.refundedQty > 0 && (
                                                        <span className="text-amber-600">
                                                            Already returned:{' '}
                                                            {formatSellingQuantityWithBaseHint(item.refundedQty, {
                                                                uomSymbol: item.uomSymbol,
                                                                uomName: item.uomName,
                                                                baseUomSymbol: item.baseUomSymbol,
                                                                conversionFactor: item.conversionFactor,
                                                            })}
                                                        </span>
                                                    )}
                                                    <span className="text-blue-600">
                                                        Available:{' '}
                                                        {formatSellingQuantityWithBaseHint(item.maxRefundable, {
                                                            uomSymbol: item.uomSymbol,
                                                            uomName: item.uomName,
                                                            baseUomSymbol: item.baseUomSymbol,
                                                            conversionFactor: item.conversionFactor,
                                                        })}
                                                    </span>
                                                </div>
                                                {/* Quantity selector — visible when item is selected */}
                                                {item.selected && (
                                                    <div className="mt-3 flex items-center gap-2 flex-wrap">
                                                        <label className="text-xs text-gray-600">
                                                            Return qty ({item.uomSymbol || item.uomName || 'unit'}):
                                                        </label>
                                                        <div className="flex items-center border border-gray-300 rounded-lg overflow-hidden">
                                                            <button
                                                                type="button"
                                                                onClick={() => updateQuantity(idx, item.refundQuantity - 1)}
                                                                className="px-2.5 py-1 bg-gray-100 hover:bg-gray-200 text-gray-600 text-sm font-medium"
                                                                disabled={isSubmitting || item.refundQuantity <= 1}
                                                            >
                                                                −
                                                            </button>
                                                            <input
                                                                type="number"
                                                                min={1}
                                                                max={item.maxRefundable}
                                                                value={item.refundQuantity}
                                                                onChange={(e) => updateQuantity(idx, parseInt(e.target.value) || 1)}
                                                                className="w-14 text-center text-sm border-x border-gray-300 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500"
                                                                disabled={isSubmitting}
                                                            />
                                                            <button
                                                                type="button"
                                                                onClick={() => updateQuantity(idx, item.refundQuantity + 1)}
                                                                className="px-2.5 py-1 bg-gray-100 hover:bg-gray-200 text-gray-600 text-sm font-medium"
                                                                disabled={isSubmitting || item.refundQuantity >= item.maxRefundable}
                                                            >
                                                                +
                                                            </button>
                                                        </div>
                                                        <span className="text-xs text-gray-400">
                                                            of {item.maxRefundable} {item.uomSymbol || item.uomName || 'units'}
                                                            {item.conversionFactor > 1 && (
                                                                <> → {sellingQtyToBase(item.refundQuantity, item.conversionFactor)} {item.baseUomSymbol || 'base'} to stock</>
                                                            )}
                                                        </span>
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>

                            {/* Refund Summary */}
                            {selectedItems.length > 0 && (
                                <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
                                    <div className="flex justify-between items-center">
                                        <div>
                                            <div className="text-sm text-gray-500">
                                                {isFullRefund ? 'Full Return' : 'Partial Return'} &middot; {selectedItems.length} item{selectedItems.length !== 1 ? 's' : ''}
                                            </div>
                                            {isFullRefund && (
                                                <div className="text-xs text-purple-700 mt-0.5">
                                                    Sale status will change to <span className="font-semibold">RETURNED</span>
                                                </div>
                                            )}
                                            {!isFullRefund && (
                                                <div className="text-xs text-orange-700 mt-0.5">
                                                    Sale status will change to <span className="font-semibold">PARTIAL RETURN</span>
                                                </div>
                                            )}
                                        </div>
                                        <div className="text-right">
                                            <div className="text-sm text-gray-500">Refund Due</div>
                                            <div className="text-xl font-bold text-gray-900">{formatCurrency(refundTotal)}</div>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {/* Reason */}
                            <div>
                                <label htmlFor="refund-reason" className="block text-sm font-medium text-gray-700 mb-1">
                                    Reason for return <span className="text-red-500">*</span>
                                </label>
                                <textarea
                                    id="refund-reason"
                                    rows={2}
                                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-amber-500 focus:border-amber-500 text-sm resize-none"
                                    placeholder="e.g., Customer returned defective item, wrong product delivered..."
                                    value={reason}
                                    onChange={(e) => setReason(e.target.value)}
                                    disabled={isSubmitting}
                                />
                            </div>
                        </>
                    )}

                    {error && (
                        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
                            {error}
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="flex justify-end gap-3 px-6 py-4 border-t border-gray-200 bg-gray-50 rounded-b-lg flex-shrink-0">
                    <button
                        type="button"
                        onClick={onClose}
                        className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-100 text-gray-700 font-medium text-sm"
                        disabled={isSubmitting}
                    >
                        Cancel
                    </button>
                    {refundItems.length > 0 && (
                        <button
                            type="button"
                            onClick={handleRefund}
                            disabled={isSubmitting || selectedItems.length === 0 || !reason.trim()}
                            className="px-5 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed font-medium text-sm flex items-center gap-2"
                        >
                            {isSubmitting ? (
                                <>
                                    <span className="animate-spin">⏳</span>
                                    Processing...
                                </>
                            ) : (
                                <>
                                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
                                    </svg>
                                    Process Return ({formatCurrency(refundTotal)})
                                </>
                            )}
                        </button>
                    )}
                </div>
            </div>
        </div>,
        document.body
    );
}
