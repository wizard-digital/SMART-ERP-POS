/**
 * SSOT create dialog for flat-amount credit/debit notes:
 * customer debit · supplier credit · supplier debit.
 * Customer credit notes use SelectCustomerInvoiceDialog → AdjustCustomerInvoiceModal.
 */

import React, { useEffect, useRef, useState } from 'react';
import { toast } from 'react-hot-toast';
import {
    CreateCustomerDebitNoteSchema,
    CreateSupplierCreditNoteSchema,
    CreateSupplierDebitNoteSchema,
} from '@shared/zod/creditDebitNote';
import {
    getAmountNoteMeta,
    type AmountNoteKind,
} from '@shared/utils/creditDebitNoteSsot';
import { useTransactionGuard, ZINDEX } from '../../../hooks/useTransactionGuard';
import type { GuardHandle } from '../../../hooks/useTransactionGuard';
import {
    AdaptiveDialog,
    AdaptiveFormField,
    AdaptiveFormLayout,
} from '../../adaptive';
import { Button, Input, Label, Textarea } from '../../ui/temp-ui-components';
import { creditDebitNoteService } from '../../../services/creditDebitNoteService';
import { LinkedInvoiceField } from './LinkedInvoiceField';
import type { LinkedInvoiceOption } from './linkedInvoiceSearch';

export interface CreateAmountNoteDialogProps {
    kind: AmountNoteKind;
    open: boolean;
    onClose: () => void;
    onSuccess: () => void;
    onCreated?: (note: { id: string; invoiceNumber: string }) => void;
}

export function CreateAmountNoteDialog({
    kind,
    open,
    onClose,
    onSuccess,
    onCreated,
}: CreateAmountNoteDialogProps) {
    const meta = getAmountNoteMeta(kind);
    const [selectedInvoice, setSelectedInvoice] = useState<LinkedInvoiceOption | null>(null);
    const [reason, setReason] = useState('');
    const [amount, setAmount] = useState('');
    const [notes, setNotes] = useState('');
    const [submitting, setSubmitting] = useState(false);

    const { openGuard, closeGuard } = useTransactionGuard();
    const guardRef = useRef<GuardHandle | null>(null);

    useEffect(() => {
        if (open) {
            guardRef.current = openGuard({
                cancellable: false,
                label: meta.title,
            });
            return () => {
                if (guardRef.current) {
                    closeGuard(guardRef.current.id);
                    guardRef.current = null;
                }
            };
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, kind]);

    const resetForm = () => {
        setSelectedInvoice(null);
        setReason('');
        setAmount('');
        setNotes('');
    };

    const parseForm = () => {
        if (!selectedInvoice?.id) {
            toast.error('Please select an invoice');
            return null;
        }
        if (!reason.trim()) {
            toast.error('Reason is required');
            return null;
        }
        const parsedAmount = parseFloat(amount);
        if (!amount || Number.isNaN(parsedAmount) || parsedAmount <= 0) {
            toast.error('Amount must be a positive number');
            return null;
        }

        const base = {
            invoiceId: selectedInvoice.id,
            reason: reason.trim(),
            amount: parsedAmount,
            notes: notes.trim() || undefined,
        };

        let parsed;
        if (kind === 'CUSTOMER_DEBIT_NOTE') {
            parsed = CreateCustomerDebitNoteSchema.safeParse(base);
        } else if (kind === 'SUPPLIER_CREDIT_NOTE') {
            parsed = CreateSupplierCreditNoteSchema.safeParse({
                ...base,
                noteType: 'PRICE_CORRECTION' as const,
            });
        } else {
            parsed = CreateSupplierDebitNoteSchema.safeParse(base);
        }

        if (!parsed.success) {
            const msg = parsed.error.issues[0]?.message ?? 'Invalid note data';
            toast.error(msg);
            return null;
        }
        return { payload: parsed.data, amount: parsedAmount };
    };

    const handleSubmit = async (postAfterCreate: boolean) => {
        const form = parseForm();
        if (!form) return;

        setSubmitting(true);
        try {
            let noteId: string | undefined;
            let noteNumber: string | undefined;

            if (kind === 'CUSTOMER_DEBIT_NOTE') {
                const res = await creditDebitNoteService.createCustomerDebitNote({
                    invoiceId: form.payload.invoiceId,
                    reason: form.payload.reason,
                    amount: form.amount,
                    notes: form.payload.notes,
                });
                const note = res.data?.note ?? res.data?.data?.note ?? res.data;
                noteId = note?.id as string | undefined;
                noteNumber = note?.invoiceNumber as string | undefined;
                if (postAfterCreate && noteId) {
                    await creditDebitNoteService.postCustomerNote(noteId);
                    toast.success(`${noteNumber ?? 'Debit note'} posted.`);
                } else {
                    toast.success(`${noteNumber ?? 'Debit note'} saved as draft.`);
                }
            } else if (kind === 'SUPPLIER_CREDIT_NOTE') {
                const res = await creditDebitNoteService.createSupplierCreditNote({
                    invoiceId: form.payload.invoiceId,
                    reason: form.payload.reason,
                    noteType: 'PRICE_CORRECTION',
                    amount: form.amount,
                    notes: form.payload.notes,
                });
                const note = res.data?.note ?? res.data;
                noteId = note?.id as string | undefined;
                noteNumber = note?.invoiceNumber as string | undefined;
                if (postAfterCreate && noteId) {
                    await creditDebitNoteService.postSupplierNote(noteId);
                    toast.success(`${noteNumber ?? 'Credit note'} posted and applied.`);
                } else {
                    toast.success(`${noteNumber ?? 'Credit note'} saved as draft.`);
                }
            } else {
                const res = await creditDebitNoteService.createSupplierDebitNote({
                    invoiceId: form.payload.invoiceId,
                    reason: form.payload.reason,
                    amount: form.amount,
                    notes: form.payload.notes,
                });
                const note = res.data?.note ?? res.data;
                noteId = note?.id as string | undefined;
                noteNumber = note?.invoiceNumber as string | undefined;
                if (postAfterCreate && noteId) {
                    await creditDebitNoteService.postSupplierNote(noteId);
                    toast.success(`${noteNumber ?? 'Debit note'} posted.`);
                } else {
                    toast.success(`${noteNumber ?? 'Debit note'} saved as draft.`);
                }
            }

            if (noteId && noteNumber) {
                onCreated?.({ id: noteId, invoiceNumber: noteNumber });
            }
            onSuccess();
            resetForm();
            onClose();
        } catch (err: unknown) {
            toast.error(err instanceof Error ? err.message : 'Failed to create note');
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <AdaptiveDialog
            open={open}
            onOpenChange={(v) => {
                if (!v) onClose();
            }}
            preventDismiss
            zIndex={guardRef.current?.panelZIndex ?? ZINDEX.PANEL}
            size="md"
            title={meta.title}
            description={meta.description}
            footer={
                <>
                    <Button
                        variant="outline"
                        onClick={onClose}
                        disabled={submitting}
                        className="min-h-[var(--layout-touch-target)]"
                    >
                        Cancel
                    </Button>
                    <Button
                        variant="outline"
                        onClick={() => void handleSubmit(false)}
                        disabled={submitting}
                        className="min-h-[var(--layout-touch-target)]"
                    >
                        {submitting ? 'Saving...' : 'Save draft'}
                    </Button>
                    <Button
                        onClick={() => void handleSubmit(true)}
                        disabled={submitting}
                        className="bg-emerald-600 hover:bg-emerald-700 text-white min-h-[var(--layout-touch-target)]"
                    >
                        {submitting ? 'Posting...' : 'Create & post'}
                    </Button>
                </>
            }
        >
            <AdaptiveFormLayout>
                <AdaptiveFormField span="full">
                    <LinkedInvoiceField
                        party={meta.party}
                        label={meta.invoiceLabel}
                        searchPlaceholder={meta.invoiceSearchPlaceholder}
                        selected={selectedInvoice}
                        onSelect={setSelectedInvoice}
                        onClear={() => setSelectedInvoice(null)}
                    />
                </AdaptiveFormField>

                <AdaptiveFormField span="full">
                    <Label>Reason *</Label>
                    <Textarea
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        placeholder="Reason for this note..."
                        rows={2}
                    />
                </AdaptiveFormField>

                <AdaptiveFormField>
                    <Label>Amount *</Label>
                    <Input
                        type="number"
                        step="1"
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                        placeholder="0.00"
                        className="min-h-[var(--layout-touch-target)]"
                    />
                </AdaptiveFormField>

                <AdaptiveFormField>
                    <Label>Additional notes</Label>
                    <Textarea
                        value={notes}
                        onChange={(e) => setNotes(e.target.value)}
                        placeholder="Optional..."
                        rows={2}
                    />
                </AdaptiveFormField>
            </AdaptiveFormLayout>
        </AdaptiveDialog>
    );
}