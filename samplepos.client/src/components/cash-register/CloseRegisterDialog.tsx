/**
 * Close Register Dialog
 * 
 * Dialog for closing a cash register session.
 * Shows summary and captures actual closing amount.
 */

import { useState, useEffect, useRef } from 'react';
import Decimal from 'decimal.js';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter,
} from '../ui/temp-ui-components';
import { useTransactionGuard, ZINDEX } from '../../hooks/useTransactionGuard';
import type { GuardHandle } from '../../hooks/useTransactionGuard';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Textarea } from '../ui/textarea';
import { useSessionSummary, useCloseSession } from '../../hooks/useCashRegister';
import { Loader2, Calculator, AlertTriangle, CheckCircle } from 'lucide-react';
import { formatCurrency } from '../../utils/currency';

interface CloseRegisterDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    sessionId: string | undefined;
    onSuccess?: () => void;
}

export function CloseRegisterDialog({
    open,
    onOpenChange,
    sessionId,
    onSuccess,
}: CloseRegisterDialogProps) {
    const [actualClosing, setActualClosing] = useState<string>('');
    const [varianceReason, setVarianceReason] = useState<string>('');
    const [notes, setNotes] = useState<string>('');

    const { data: summary, isLoading } = useSessionSummary(sessionId);
    const closeSession = useCloseSession();

    // ── Transaction Guard ──────────────────────────────────────────────────────
    const { openGuard, closeGuard } = useTransactionGuard();
    const guardRef = useRef<GuardHandle | null>(null);
    useEffect(() => {
        if (open) {
            guardRef.current = openGuard({ cancellable: false, label: 'Close cash register' });
            return () => { if (guardRef.current) { closeGuard(guardRef.current.id); guardRef.current = null; } };
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    // Reset form when dialog opens
    useEffect(() => {
        if (open) {
            setActualClosing('');
            setVarianceReason('');
            setNotes('');
        }
    }, [open, sessionId]);

    // Calculate variance if actual closing is entered
    const actualAmount = parseFloat(actualClosing) || 0;
    const expectedAmount = summary?.summary?.expectedClosing || 0;
    const variance = new Decimal(actualAmount).minus(expectedAmount).toNumber();
    const hasVariance = Math.abs(variance) > 0.01;

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();

        if (!sessionId || !actualClosing) return;

        try {
            await closeSession.mutateAsync({
                sessionId,
                data: {
                    actualClosing: actualAmount,
                    varianceReason: hasVariance ? varianceReason : undefined,
                    notes: notes || undefined,
                },
            });
            onOpenChange(false);
            onSuccess?.();
        } catch (error: unknown) {
            console.error('Failed to close session:', error);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange} zIndex={guardRef.current?.panelZIndex ?? ZINDEX.PANEL}>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Calculator className="h-5 w-5 text-blue-600" />
                        Close Cash Register
                    </DialogTitle>
                    <DialogDescription>
                        Count the cash in your drawer and enter the total amount below.
                    </DialogDescription>
                </DialogHeader>

                {isLoading ? (
                    <div className="flex items-center justify-center py-8">
                        <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
                    </div>
                ) : summary ? (
                    <form onSubmit={handleSubmit} className="space-y-4 mt-4">
                        {/* Session Summary */}
                        <div className="bg-gray-50 p-4 rounded-lg space-y-2">
                            <h3 className="font-medium text-sm text-gray-700">Session Summary</h3>
                            <div className="grid grid-cols-2 gap-2 text-sm">
                                <div>Opening Float:</div>
                                <div className="text-right font-medium">
                                    {formatCurrency(summary.summary.openingFloat)}
                                </div>
                                <div>Cash Sales:</div>
                                <div className="text-right font-medium text-green-600">
                                    + {formatCurrency(summary.summary.totalSales)}
                                </div>
                                <div>Cash In:</div>
                                <div className="text-right font-medium text-green-600">
                                    + {formatCurrency(summary.summary.totalCashIn)}
                                </div>
                                <div>Cash Out:</div>
                                <div className="text-right font-medium text-red-600">
                                    - {formatCurrency(summary.summary.totalCashOut)}
                                </div>
                                <div>Refunds:</div>
                                <div className="text-right font-medium text-red-600">
                                    - {formatCurrency(summary.summary.totalRefunds)}
                                </div>
                                {(summary.summary.breakdown?.cashOutExpense || 0) > 0.009 && (
                                    <>
                                        <div className="text-gray-500">Petty spend (not till):</div>
                                        <div className="text-right font-medium text-gray-500">
                                            {formatCurrency(summary.summary.breakdown?.cashOutExpense || 0)}
                                        </div>
                                    </>
                                )}
                                <div className="border-t pt-2 font-semibold">Expected Total:</div>
                                <div className="border-t pt-2 text-right font-bold text-lg">
                                    {formatCurrency(summary.summary.expectedClosing)}
                                </div>
                            </div>
                        </div>

                        {/* Actual Closing Input */}
                        <div className="space-y-2">
                            <Label htmlFor="actualClosing">Actual Cash Count (UGX)</Label>
                            <Input
                                id="actualClosing"
                                type="number"
                                min="0"
                                step="100"
                                placeholder="Enter counted cash amount"
                                value={actualClosing}
                                onChange={(e) => setActualClosing(e.target.value)}
                                className="text-lg"
                                autoFocus
                            />
                        </div>

                        {/* Variance Display */}
                        {actualClosing && (
                            <div
                                className={`p-3 rounded-lg flex items-center gap-2 ${hasVariance
                                    ? variance > 0
                                        ? 'bg-yellow-50 border border-yellow-200 text-yellow-800'
                                        : 'bg-red-50 border border-red-200 text-red-800'
                                    : 'bg-green-50 border border-green-200 text-green-800'
                                    }`}
                            >
                                {hasVariance ? (
                                    <AlertTriangle className="h-5 w-5" />
                                ) : (
                                    <CheckCircle className="h-5 w-5" />
                                )}
                                <div>
                                    <div className="font-medium">
                                        {hasVariance
                                            ? variance > 0
                                                ? `Overage: ${formatCurrency(variance)}`
                                                : `Shortage: ${formatCurrency(Math.abs(variance))}`
                                            : 'Cash balanced!'}
                                    </div>
                                    {hasVariance && (
                                        <div className="text-xs opacity-75">
                                            Expected: {formatCurrency(expectedAmount)}
                                        </div>
                                    )}
                                </div>
                            </div>
                        )}

                        {/* Variance Reason (required if variance) */}
                        {hasVariance && (
                            <div className="space-y-2">
                                <Label htmlFor="varianceReason">
                                    Reason for Variance <span className="text-red-500">*</span>
                                </Label>
                                <Input
                                    id="varianceReason"
                                    placeholder="Explain the variance"
                                    value={varianceReason}
                                    onChange={(e) => setVarianceReason(e.target.value)}
                                />
                            </div>
                        )}

                        {/* Notes */}
                        <div className="space-y-2">
                            <Label htmlFor="notes">Notes (Optional)</Label>
                            <Textarea
                                id="notes"
                                placeholder="Any additional notes about this shift"
                                value={notes}
                                onChange={(e) => setNotes(e.target.value)}
                                rows={2}
                            />
                        </div>

                        {closeSession.error && (
                            <div className="p-3 bg-red-50 border border-red-200 rounded-md text-sm text-red-600">
                                {closeSession.error instanceof Error
                                    ? closeSession.error.message
                                    : 'Failed to close register'}
                            </div>
                        )}

                        <DialogFooter className="gap-2 mt-6">
                            <Button
                                type="button"
                                variant="outline"
                                onClick={() => onOpenChange(false)}
                            >
                                Cancel
                            </Button>
                            <Button
                                type="submit"
                                disabled={
                                    !actualClosing ||
                                    (hasVariance && !varianceReason) ||
                                    closeSession.isPending
                                }
                                className="bg-blue-600 hover:bg-blue-700"
                            >
                                {closeSession.isPending ? (
                                    <>
                                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                        Closing...
                                    </>
                                ) : (
                                    'Close Register'
                                )}
                            </Button>
                        </DialogFooter>
                    </form>
                ) : (
                    <div className="py-8 text-center text-gray-500">
                        No session data available
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}
