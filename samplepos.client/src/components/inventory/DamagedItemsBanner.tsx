/**
 * DamagedItemsBanner
 *
 * Master Data Guard — Rule 3: "Post-reset damaged items"
 *
 * Shows a warning banner when there are products with quantity > 0 but cost = 0.
 * Provides per-item unit cost input and a "Repair Valuation" action which posts
 * DR Inventory / CR Opening Balance Equity to the GL.
 *
 * Also exposes an "Opening Stock" mode for adding NEW stock with valuation.
 */

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, getErrorMessage } from '../../utils/api';
import { formatCurrency } from '../../utils/currency';

// ─── Types ────────────────────────────────────────────────────────────────────

interface DamagedItem {
    productId: string;
    productName: string;
    sku: string;
    quantityOnHand: number;
    costPrice: number;
    averageCost: number;
    sellingPrice: number;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function DamagedItemsBanner({
    onRepairComplete,
}: {
    onRepairComplete?: () => void;
}) {
    const queryClient = useQueryClient();
    const [showDialog, setShowDialog] = useState(false);
    const [unitCosts, setUnitCosts] = useState<Record<string, string>>({});
    const [repairing, setRepairing] = useState<string | null>(null);
    const [errors, setErrors] = useState<Record<string, string>>({});
    const [success, setSuccess] = useState<Record<string, string>>({});

    // Fetch damaged items (poll every 60s)
    const { data, isLoading } = useQuery({
        queryKey: ['products', 'damaged'],
        queryFn: async () => {
            const res = await api.products.getDamagedItems();
            return (res.data?.data ?? []) as DamagedItem[];
        },
        refetchInterval: 60_000,
        staleTime: 30_000,
    });

    const damagedItems = data ?? [];

    // Repair mutation
    const repairMutation = useMutation({
        mutationFn: async ({ productId, unitCost }: { productId: string; unitCost: number }) => {
            const res = await api.products.repairValuation(productId, { unitCost });
            return res.data?.data;
        },
        onSuccess: (_result, { productId }) => {
            setSuccess((prev) => ({ ...prev, [productId]: 'Valuation repaired ✓' }));
            setErrors((prev) => {
                const next = { ...prev };
                delete next[productId];
                return next;
            });
            // Invalidate damaged list + product list
            queryClient.invalidateQueries({ queryKey: ['products', 'damaged'] });
            queryClient.invalidateQueries({ queryKey: ['products'] });
            onRepairComplete?.();
        },
        onError: (err, { productId }) => {
            setErrors((prev) => ({ ...prev, [productId]: getErrorMessage(err) }));
        },
        onSettled: () => setRepairing(null),
    });

    const handleRepair = async (productId: string) => {
        const raw = unitCosts[productId];
        const cost = parseFloat(raw ?? '');
        if (!raw || isNaN(cost) || cost <= 0) {
            setErrors((prev) => ({
                ...prev,
                [productId]: 'Enter a unit cost greater than 0',
            }));
            return;
        }
        setRepairing(productId);
        repairMutation.mutate({ productId, unitCost: cost });
    };

    // Don't render while loading or when there are no issues
    if (isLoading || damagedItems.length === 0) return null;

    return (
        <>
            {/* ── Banner ──────────────────────────────────────────────────────── */}
            <div
                className="mb-4 bg-amber-50 border border-amber-300 rounded-lg p-3 flex items-center justify-between gap-3"
                role="alert"
            >
                <div className="flex items-center gap-2 text-amber-800 text-sm">
                    <span className="text-lg">⚠️</span>
                    <span>
                        <strong>{damagedItems.length} product{damagedItems.length !== 1 ? 's' : ''}</strong>{' '}
                        {damagedItems.length === 1 ? 'has' : 'have'} stock with no valuation.
                        These items cannot be sold or adjusted until cost is set.
                    </span>
                </div>
                <button
                    onClick={() => setShowDialog(true)}
                    className="shrink-0 px-3 py-1.5 bg-amber-600 text-white text-sm font-medium rounded-md hover:bg-amber-700 transition-colors"
                >
                    Fix Now
                </button>
            </div>

            {/* ── Repair Dialog ───────────────────────────────────────────────── */}
            {showDialog && (
                <div
                    className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
                    role="dialog"
                    aria-modal="true"
                    aria-label="Repair Item Valuations"
                >
                    <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col mx-4">
                        {/* Header */}
                        <div className="px-6 py-4 border-b flex items-center justify-between">
                            <div>
                                <h2 className="text-lg font-semibold text-gray-900">
                                    Repair Item Valuations
                                </h2>
                                <p className="text-sm text-gray-500 mt-0.5">
                                    Enter the unit cost for each item to restore GL accuracy.
                                    Posts DR&nbsp;Inventory / CR&nbsp;Opening Balance Equity.
                                </p>
                            </div>
                            <button
                                onClick={() => setShowDialog(false)}
                                className="text-gray-400 hover:text-gray-600 text-2xl leading-none"
                                aria-label="Close"
                            >
                                ×
                            </button>
                        </div>

                        {/* Body */}
                        <div className="overflow-y-auto flex-1 px-6 py-4 space-y-3">
                            {damagedItems.map((item) => (
                                <div
                                    key={item.productId}
                                    className={`rounded-lg border p-4 ${success[item.productId]
                                            ? 'border-green-300 bg-green-50'
                                            : 'border-amber-200 bg-amber-50'
                                        }`}
                                >
                                    <div className="flex items-start justify-between gap-3">
                                        <div>
                                            <div className="font-medium text-gray-900">{item.productName}</div>
                                            <div className="text-sm text-gray-500 mt-0.5">
                                                SKU: {item.sku} &bull; Qty on hand:{' '}
                                                <strong>{item.quantityOnHand}</strong> &bull; Selling:{' '}
                                                {item.sellingPrice > 0
                                                    ? formatCurrency(item.sellingPrice)
                                                    : <span className="text-red-600">Not set</span>}
                                            </div>
                                        </div>

                                        {success[item.productId] ? (
                                            <span className="text-green-700 text-sm font-medium shrink-0">
                                                {success[item.productId]}
                                            </span>
                                        ) : (
                                            <div className="flex items-center gap-2 shrink-0">
                                                <input
                                                    type="number"
                                                    step="1"
                                                    placeholder="Unit cost"
                                                    value={unitCosts[item.productId] ?? ''}
                                                    onChange={(e) =>
                                                        setUnitCosts((prev) => ({
                                                            ...prev,
                                                            [item.productId]: e.target.value,
                                                        }))
                                                    }
                                                    className="w-32 px-3 py-1.5 border border-gray-300 rounded-md text-sm focus:ring-1 focus:ring-amber-500 focus:border-amber-500"
                                                    aria-label={`Unit cost for ${item.productName}`}
                                                />
                                                <button
                                                    onClick={() => handleRepair(item.productId)}
                                                    disabled={repairing === item.productId}
                                                    className="px-3 py-1.5 bg-amber-600 text-white text-sm font-medium rounded-md hover:bg-amber-700 disabled:opacity-60 transition-colors"
                                                >
                                                    {repairing === item.productId ? 'Repairing…' : 'Repair'}
                                                </button>
                                            </div>
                                        )}
                                    </div>

                                    {errors[item.productId] && (
                                        <p className="mt-2 text-sm text-red-600">{errors[item.productId]}</p>
                                    )}

                                    {!success[item.productId] && unitCosts[item.productId] && (
                                        <p className="mt-1 text-xs text-gray-500">
                                            GL value:{' '}
                                            {formatCurrency(
                                                item.quantityOnHand * parseFloat(unitCosts[item.productId] || '0'),
                                            )}{' '}
                                            ({item.quantityOnHand} × {formatCurrency(parseFloat(unitCosts[item.productId] || '0'))})
                                        </p>
                                    )}
                                </div>
                            ))}
                        </div>

                        {/* Footer */}
                        <div className="px-6 py-3 border-t flex justify-end">
                            <button
                                onClick={() => setShowDialog(false)}
                                className="px-4 py-2 text-sm text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
                            >
                                Close
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}

// ─── Opening Stock Dialog ─────────────────────────────────────────────────────

interface OpeningStockProduct {
    id: string;
    name: string;
    sku: string;
}

export function OpeningStockDialog({
    product,
    onClose,
    onSuccess,
}: {
    product: OpeningStockProduct;
    onClose: () => void;
    onSuccess?: () => void;
}) {
    const queryClient = useQueryClient();
    const [quantity, setQuantity] = useState('');
    const [unitCost, setUnitCost] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [done, setDone] = useState(false);

    const mutation = useMutation({
        mutationFn: async () => {
            const qty = parseFloat(quantity);
            const cost = parseFloat(unitCost);
            const res = await api.products.createOpeningStock(product.id, {
                quantity: qty,
                unitCost: cost,
            });
            return res.data?.data;
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['products'] });
            queryClient.invalidateQueries({ queryKey: ['products', 'damaged'] });
            setDone(true);
            onSuccess?.();
        },
        onError: (err) => setError(getErrorMessage(err)),
    });

    const handleSubmit = () => {
        setError(null);
        const qty = parseFloat(quantity);
        const cost = parseFloat(unitCost);
        if (!quantity || isNaN(qty) || qty <= 0) {
            setError('Quantity must be greater than 0');
            return;
        }
        if (!unitCost || isNaN(cost) || cost <= 0) {
            setError('Unit cost must be greater than 0');
            return;
        }
        mutation.mutate();
    };

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
            role="dialog"
            aria-modal="true"
            aria-label="Opening Stock Entry"
        >
            <div className="bg-white rounded-xl shadow-2xl w-full max-w-md mx-4">
                <div className="px-6 py-4 border-b flex items-center justify-between">
                    <div>
                        <h2 className="text-lg font-semibold text-gray-900">Opening Stock with Valuation</h2>
                        <p className="text-sm text-gray-500 mt-0.5">{product.name} — {product.sku}</p>
                    </div>
                    <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-2xl leading-none">×</button>
                </div>

                <div className="px-6 py-5 space-y-4">
                    {done ? (
                        <div className="text-center py-4">
                            <div className="text-3xl mb-2">✅</div>
                            <p className="text-green-700 font-medium">Opening stock created successfully!</p>
                            <p className="text-sm text-gray-500 mt-1">
                                GL entry posted: DR Inventory / CR Opening Balance Equity
                            </p>
                        </div>
                    ) : (
                        <>
                            <p className="text-sm text-gray-600">
                                Enter the physical quantity on hand and its purchase cost.
                                This posts <strong>DR Inventory / CR Opening Balance Equity</strong> to the GL.
                            </p>

                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">
                                    Quantity
                                </label>
                                <input
                                    type="number"
                                    min="0.001"
                                    step="0.001"
                                    value={quantity}
                                    onChange={(e) => setQuantity(e.target.value)}
                                    placeholder="e.g. 50"
                                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                                />
                            </div>

                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">
                                    Unit Cost
                                </label>
                                <input
                                    type="number"
                                    step="1"
                                    value={unitCost}
                                    onChange={(e) => setUnitCost(e.target.value)}
                                    placeholder="e.g. 2500"
                                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                                />
                            </div>

                            {quantity && unitCost && parseFloat(quantity) > 0 && parseFloat(unitCost) > 0 && (
                                <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm text-blue-800">
                                    <strong>Total GL value:</strong>{' '}
                                    {formatCurrency(parseFloat(quantity) * parseFloat(unitCost))}
                                </div>
                            )}

                            {error && (
                                <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                                    {error}
                                </p>
                            )}
                        </>
                    )}
                </div>

                <div className="px-6 py-3 border-t flex justify-end gap-3">
                    <button
                        onClick={onClose}
                        className="px-4 py-2 text-sm text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg"
                    >
                        {done ? 'Close' : 'Cancel'}
                    </button>
                    {!done && (
                        <button
                            onClick={handleSubmit}
                            disabled={mutation.isPending}
                            className="px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-60 transition-colors"
                        >
                            {mutation.isPending ? 'Posting…' : 'Create Opening Stock'}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}