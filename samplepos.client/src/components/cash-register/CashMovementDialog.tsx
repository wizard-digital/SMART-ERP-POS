/**
 * Cash Movement Dialog
 *
 * Dialog for recording cash in/out transactions during a session.
 * Supports categorized movement types for proper accounting:
 * - Float: Cash added for change (not revenue)
 * - Customer Payment: Debt collection (reduces AR)
 * - Other: Miscellaneous cash movements
 */

import { useState, useEffect, useRef } from 'react';
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
import { NumericSoftKeyboardInput } from '../keyboard/NumericSoftKeyboardInput';
import { Label } from '../ui/label';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '../ui/select';
import { useRecordMovement } from '../../hooks/useCashRegister';
import { Loader2, ArrowUpCircle, ArrowDownCircle, Wallet, CreditCard, Building2, Receipt } from 'lucide-react';
import type { CashInSubType, CashOutSubType } from '../../types/cashRegister';
import { useQuery } from '@tanstack/react-query';
import type { Customer } from '@shared/zod/customer';
import { arPaymentService, type ArOpenInvoice } from '../../services/arPayments';
import { formatCurrency } from '../../utils/currency';
import { api } from '../../utils/api';

interface CashMovementDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    sessionId: string | undefined;
    type: 'CASH_IN' | 'CASH_OUT';
    onSuccess?: () => void;
}

// Sub-type options for Cash In
const cashInSubTypes: { value: CashInSubType; label: string; description: string; icon: typeof Wallet }[] = [
    {
        value: 'CASH_IN_FLOAT',
        label: 'Float / Change',
        description: 'Cash for making change (not revenue)',
        icon: Wallet
    },
    {
        value: 'CASH_IN_PAYMENT',
        label: 'Customer Payment',
        description: 'Collect outstanding invoice — posts AR and till cash together',
        icon: CreditCard
    },
    {
        value: 'CASH_IN_OTHER',
        label: 'Other Income',
        description: 'Miscellaneous cash received',
        icon: Receipt
    },
];

// Sub-type options for Cash Out
const cashOutSubTypes: { value: CashOutSubType; label: string; description: string; icon: typeof Wallet }[] = [
    {
        value: 'CASH_OUT_BANK',
        label: 'Bank Deposit',
        description: 'Cash taken to bank',
        icon: Building2
    },
    {
        value: 'CASH_OUT_EXPENSE',
        label: 'Spend from petty float',
        description: 'Pay from the petty cash float — not the till drawer. For bank-paid expense vouchers use Accounting → Expenses.',
        icon: Receipt
    },
    {
        value: 'CASH_OUT_OTHER',
        label: 'Drawer Withdrawal',
        description: 'Cash removed from the till drawer (not the petty float)',
        icon: Wallet
    },
];

function parsedAmountSafe(value: string): number {
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : 0;
}

export function CashMovementDialog({
    open,
    onOpenChange,
    sessionId,
    type,
    onSuccess,
}: CashMovementDialogProps) {
    const [amount, setAmount] = useState<string>('');
    const [reason, setReason] = useState<string>('');
    const [subType, setSubType] = useState<CashInSubType | CashOutSubType | ''>('');
    const [customer, setCustomer] = useState<Customer | null>(null);
    const [invoiceId, setInvoiceId] = useState<string>('');
    const [customerSearch, setCustomerSearch] = useState('');
    const [customerListOpen, setCustomerListOpen] = useState(false);

    const recordMovement = useRecordMovement();

    // ── Transaction Guard ──────────────────────────────────────────────────────
    const { openGuard, closeGuard } = useTransactionGuard();
    const guardRef = useRef<GuardHandle | null>(null);
    useEffect(() => {
        if (open) {
            guardRef.current = openGuard({ cancellable: false, label: 'Record cash movement' });
            return () => { if (guardRef.current) { closeGuard(guardRef.current.id); guardRef.current = null; } };
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    const isCashIn = type === 'CASH_IN';
    const subTypes = isCashIn ? cashInSubTypes : cashOutSubTypes;
    const isTillAr = subType === 'CASH_IN_PAYMENT';

    const { data: customerHits = [], isLoading: searchingCustomers } = useQuery({
        queryKey: ['till-ar-customer-search', customerSearch],
        queryFn: async () => {
            const asCustomers = (raw: unknown): Customer[] =>
                Array.isArray(raw) ? (raw as Customer[]) : [];
            const q = customerSearch.trim();
            if (q) {
                const res = await api.customers.search(q, 20);
                if (!res.data.success) return [] as Customer[];
                return asCustomers(res.data.data);
            }
            const res = await api.customers.list({ page: 1, limit: 20, outstandingOnly: true });
            if (!res.data.success) return [] as Customer[];
            return asCustomers(res.data.data);
        },
        enabled: isTillAr && !customer && customerListOpen,
        staleTime: 15_000,
    });

    const { data: openInvoices = [], isLoading: loadingInvoices } = useQuery({
        queryKey: ['till-ar-open-invoices', customer?.id],
        queryFn: () => arPaymentService.getOpenInvoices(customer!.id),
        enabled: isTillAr && !!customer?.id,
    });

    const selectedInvoice: ArOpenInvoice | undefined = openInvoices.find((inv) => inv.id === invoiceId);

    // Reset form when dialog opens
    useEffect(() => {
        if (open) {
            setAmount('');
            setReason('');
            setSubType('');
            setCustomer(null);
            setInvoiceId('');
            setCustomerSearch('');
            setCustomerListOpen(false);
        }
    }, [open]);

    useEffect(() => {
        if (!isTillAr) {
            setCustomer(null);
            setInvoiceId('');
            setCustomerSearch('');
            setCustomerListOpen(false);
            return;
        }
        if (!customer) {
            setCustomerListOpen(true);
        }
    }, [isTillAr, customer]);

    useEffect(() => {
        setInvoiceId('');
        setAmount('');
    }, [customer?.id]);

    useEffect(() => {
        if (!isTillAr) return;
        if (openInvoices.length === 1) {
            setInvoiceId(openInvoices[0].id);
        }
    }, [isTillAr, openInvoices]);

    useEffect(() => {
        if (!selectedInvoice) return;
        setAmount(String(Math.round(selectedInvoice.amountDue)));
        setReason(`${customer?.name ?? ''} ${selectedInvoice.invoiceNumber}`.trim());
    }, [selectedInvoice?.id, customer?.name]);

    const tillArValid =
        !isTillAr ||
        (!!customer?.id &&
            !!selectedInvoice &&
            parsedAmountSafe(amount) > 0 &&
            parsedAmountSafe(amount) <= selectedInvoice.amountDue + 0.009);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();

        const parsedAmount = parseFloat(amount);
        if (!sessionId || !amount || isNaN(parsedAmount) || parsedAmount <= 0 || !subType) {
            return;
        }
        if (isTillAr) {
            if (!customer?.id || !invoiceId) return;
            if (selectedInvoice && parsedAmount > selectedInvoice.amountDue + 0.009) return;
        } else if (!reason.trim()) {
            return;
        }

        try {
            await recordMovement.mutateAsync({
                sessionId,
                movementType: subType,
                amount: parsedAmount,
                reason: isTillAr
                    ? `${customer?.name ?? ''} ${selectedInvoice?.invoiceNumber ?? ''}`.trim()
                    : reason.trim(),
                customerId: isTillAr ? customer?.id : undefined,
                invoiceId: isTillAr ? invoiceId : undefined,
            });
            onOpenChange(false);
            onSuccess?.();
        } catch (error: unknown) {
            console.error('Failed to record movement:', error);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange} zIndex={guardRef.current?.panelZIndex ?? ZINDEX.PANEL}>
            <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        {isCashIn ? (
                            <>
                                <ArrowDownCircle className="h-5 w-5 text-green-600" />
                                Cash In
                            </>
                        ) : (
                            <>
                                <ArrowUpCircle className="h-5 w-5 text-red-600" />
                                Cash Out
                            </>
                        )}
                    </DialogTitle>
                    <DialogDescription>
                        {isCashIn
                            ? 'Record cash being added to the register. Select the type to ensure proper accounting.'
                            : 'Record cash being removed from the register. Select the type for accurate tracking.'}
                    </DialogDescription>
                </DialogHeader>

                <form onSubmit={handleSubmit} className="space-y-4 mt-4">
                    {/* Movement Sub-Type Selection */}
                    <div className="space-y-2">
                        <Label htmlFor="subType">
                            Type <span className="text-red-500">*</span>
                        </Label>
                        <Select value={subType} onValueChange={(val) => setSubType(val as CashInSubType | CashOutSubType)}>
                            <SelectTrigger id="subType">
                                <SelectValue placeholder="Select type of transaction" />
                            </SelectTrigger>
                            <SelectContent>
                                {subTypes.map((st) => (
                                    <SelectItem key={st.value} value={st.value}>
                                        <div className="flex items-center gap-2">
                                            <st.icon className="h-4 w-4" />
                                            <span>{st.label}</span>
                                        </div>
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        {subType && (
                            <p className="text-xs text-gray-500">
                                {subTypes.find(st => st.value === subType)?.description}
                            </p>
                        )}
                    </div>

                    {isTillAr && (
                        <div className="space-y-3">
                            <div className="space-y-2">
                                <Label>
                                    Customer <span className="text-red-500">*</span>
                                </Label>
                                {customer ? (
                                    <div className="flex items-start justify-between gap-2 rounded-md border border-gray-200 bg-gray-50 p-3">
                                        <div className="min-w-0">
                                            <div className="font-medium text-sm text-gray-900 truncate">{customer.name}</div>
                                            {customer.phone ? (
                                                <div className="text-xs text-gray-500">{customer.phone}</div>
                                            ) : null}
                                            <div className="text-xs text-gray-600 mt-1">
                                                Open AR: {formatCurrency(customer.balance)}
                                            </div>
                                        </div>
                                        <Button
                                            type="button"
                                            variant="outline"
                                            size="sm"
                                            onClick={() => {
                                                setCustomer(null);
                                                setInvoiceId('');
                                                setAmount('');
                                                setCustomerSearch('');
                                                setCustomerListOpen(true);
                                            }}
                                        >
                                            Change
                                        </Button>
                                    </div>
                                ) : (
                                    <div className="space-y-2">
                                        <Input
                                            value={customerSearch}
                                            onChange={(e) => {
                                                setCustomerSearch(e.target.value);
                                                setCustomerListOpen(true);
                                            }}
                                            onFocus={() => setCustomerListOpen(true)}
                                            placeholder="Search existing customer with an open invoice"
                                            autoComplete="off"
                                            aria-label="Search customers for till AR collection"
                                        />
                                        {customerListOpen && (
                                            <div
                                                className="w-full bg-white border border-gray-200 rounded-md max-h-48 overflow-y-auto"
                                                role="listbox"
                                                aria-label="Customer search results"
                                            >
                                                {searchingCustomers ? (
                                                    <p className="p-3 text-sm text-gray-500">Searching…</p>
                                                ) : customerHits.length === 0 ? (
                                                    <p className="p-3 text-sm text-gray-500">
                                                        No customer found. Create the customer and invoice in Customers first — till collection cannot create AR.
                                                    </p>
                                                ) : (
                                                    customerHits.map((hit) => (
                                                        <button
                                                            key={hit.id}
                                                            type="button"
                                                            className="w-full text-left px-3 py-2 border-b last:border-b-0 hover:bg-gray-50"
                                                            onClick={() => {
                                                                setCustomer(hit);
                                                                setCustomerSearch('');
                                                                setCustomerListOpen(false);
                                                            }}
                                                        >
                                                            <div className="text-sm font-medium text-gray-900 truncate">{hit.name}</div>
                                                            <div className="text-xs text-gray-500">
                                                                {hit.phone ? `${hit.phone} · ` : ''}
                                                                AR {formatCurrency(hit.balance)}
                                                            </div>
                                                        </button>
                                                    ))
                                                )}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                            {customer && (
                                <div className="space-y-2">
                                    <Label>
                                        Open invoice <span className="text-red-500">*</span>
                                    </Label>
                                    {loadingInvoices ? (
                                        <p className="text-xs text-gray-500">Loading invoices…</p>
                                    ) : openInvoices.length === 0 ? (
                                        <p className="text-xs text-red-600">
                                            This customer has no open invoices. Customer Payment is only for outstanding AR.
                                        </p>
                                    ) : (
                                        <Select value={invoiceId} onValueChange={setInvoiceId}>
                                            <SelectTrigger>
                                                <SelectValue placeholder="Select invoice to collect" />
                                            </SelectTrigger>
                                            <SelectContent>
                                                {openInvoices.map((inv) => (
                                                    <SelectItem key={inv.id} value={inv.id}>
                                                        {inv.invoiceNumber} — due {formatCurrency(inv.amountDue)}
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                    )}
                                </div>
                            )}
                        </div>
                    )}

                    {(!isTillAr || selectedInvoice) && (
                    <div className="space-y-2">
                        <Label htmlFor="amount">Amount (UGX)</Label>
                        <NumericSoftKeyboardInput
                            id="amount"
                            mode="integer"
                            placeholder="Enter amount"
                            value={amount}
                            onChange={(value) => setAmount(value.replace(/[^0-9]/g, ''))}
                            className="text-lg pr-12"
                            aria-label="Cash movement amount"
                        />
                        {amount && parseFloat(amount) <= 0 && (
                            <p className="text-xs text-red-500">Amount must be greater than 0</p>
                        )}
                        {isTillAr && selectedInvoice && parsedAmountSafe(amount) > selectedInvoice.amountDue + 0.009 && (
                            <p className="text-xs text-red-500">
                                Cannot exceed outstanding {formatCurrency(selectedInvoice.amountDue)}
                            </p>
                        )}
                    </div>
                    )}

                    {!isTillAr && (
                    <div className="space-y-2">
                        <Label htmlFor="reason">
                            Reason <span className="text-red-500">*</span>
                        </Label>
                        <Input
                            id="reason"
                            placeholder={
                                subType === 'CASH_IN_FLOAT' ? 'e.g., Float from manager' :
                                    subType === 'CASH_IN_OTHER' ? 'e.g., Refund from supplier' :
                                        subType === 'CASH_OUT_BANK' ? 'e.g., Daily deposit to Bank X' :
                                            subType === 'CASH_OUT_EXPENSE' ? 'e.g., Office supplies from float' :
                                                subType === 'CASH_OUT_OTHER' ? 'e.g., Returned to owner' :
                                                    'Enter description'
                            }
                            value={reason}
                            onChange={(e) => setReason(e.target.value)}
                        />
                        {amount && parseFloat(amount) > 0 && !reason.trim() && (
                            <p className="text-xs text-red-500">Please enter a description</p>
                        )}
                    </div>
                    )}

                    {isTillAr && (
                        <div className="p-3 bg-blue-50 border border-blue-200 rounded-md text-sm text-blue-700">
                            Posts DR Cash Drawer 1010 / CR Accounts Receivable 1200 against the selected invoice.
                            Does not use Undeposited Funds. Bank this cash later with Cash Out → Bank Deposit.
                        </div>
                    )}

                    {recordMovement.error && (
                        <div className="p-3 bg-red-50 border border-red-200 rounded-md text-sm text-red-600">
                            {recordMovement.error instanceof Error
                                ? recordMovement.error.message
                                : typeof recordMovement.error === 'object' && recordMovement.error !== null
                                    ? JSON.stringify((recordMovement.error as unknown as { response?: { data?: { error?: string } } }).response?.data?.error || recordMovement.error)
                                    : 'Failed to record movement'}
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
                                !subType ||
                                !amount ||
                                parseFloat(amount) <= 0 ||
                                recordMovement.isPending ||
                                (isTillAr ? !tillArValid : !reason.trim())
                            }
                            className={
                                isCashIn
                                    ? 'bg-green-600 hover:bg-green-700'
                                    : 'bg-red-600 hover:bg-red-700'
                            }
                        >
                            {recordMovement.isPending ? (
                                <>
                                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                    Recording...
                                </>
                            ) : (
                                `Record ${isCashIn ? 'Cash In' : 'Cash Out'}`
                            )}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
