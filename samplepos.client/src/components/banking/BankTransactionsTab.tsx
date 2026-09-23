/**
 * BANK TRANSACTIONS TAB
 * 
 * Displays bank transactions with filtering, manual entry, and transfers.
 */

import React, { useState, useMemo, useRef, useEffect } from 'react';
import { useTransactionGuard, ZINDEX } from '../../hooks/useTransactionGuard';
import type { GuardHandle } from '../../hooks/useTransactionGuard';
import { Plus, ArrowUpRight, ArrowDownLeft, ArrowLeftRight, Search, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/temp-ui-components';
import { Input } from '@/components/ui/input';
import { DatePicker } from '@/components/ui/date-picker';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useQuery } from '@tanstack/react-query';
import {
    useBankAccounts,
    useBankTransactions,
    useBankCategories,
    useCreateBankTransaction,
    useCreateBankTransfer,
    useReverseBankTransaction,
    BankTransaction
} from '../../hooks/useBanking';
import { useTreasuryEnabled } from '../../hooks/useTreasuryEnabled';
import { formatCurrency } from '../../utils/currency';
import { toast } from 'react-hot-toast';
import { api } from '../../services/api';

/** CoA posting accounts for bank receipt/payment offset (same source as Journal Entries). */
type GlAccount = {
    id: string;
    accountNumber: string;
    accountName: string;
    accountType: string;
};

/**
 * Bank receipt offset: not AR, not sales, not OBE, not cash/bank (those have their own screens).
 */
function isBankOffsetAccount(acc: GlAccount): boolean {
    const code = String(acc.accountNumber || '');
    const name = String(acc.accountName || '');
    if (!code) return false;
    if (['1200', '1250', '1300', '4000', '1015', '3050'].includes(code)) return false;
    if (/^10\d{2}/.test(code)) return false;
    if (/opening balance/i.test(name)) return false;
    return true;
}

function resolveOwnerCapitalId(accounts: GlAccount[]): string {
    const named = accounts.find((a) => /owner\s*capital/i.test(a.accountName));
    if (named) return named.id;
    const code3200 = accounts.find((a) => a.accountNumber === '3200');
    if (code3200) return code3200.id;
    const equity = accounts.find((a) => a.accountNumber === '3000' && /equity|capital/i.test(a.accountName));
    return equity?.id || '';
}

function resolveOwnerDrawingId(accounts: GlAccount[]): string {
    const named = accounts.find((a) => /owner\s*drawing/i.test(a.accountName));
    if (named) return named.id;
    return accounts.find((a) => a.accountNumber === '3300')?.id || '';
}

/** Disambiguate same-named bank books (e.g. three "PHARMACURE ACCOUNT") in dropdowns. */
function formatBankAccountLabel(
    acc: { name: string; bankName?: string | null; glAccountCode?: string | null; currentBalance?: number | null },
    opts?: { showBalance?: boolean },
): string {
    const bits = [acc.name];
    if (acc.bankName) bits.push(acc.bankName);
    if (acc.glAccountCode) bits.push(acc.glAccountCode);
    let label = bits.join(' · ');
    if (opts?.showBalance) {
        label += ` (${formatCurrency(acc.currentBalance || 0)})`;
    }
    return label;
}

/** Bank ↔ bank transfer destinations must be Cash/Bank liquidity GLs (not AR 1200). */
function isTransferEligibleBankAccount(acc: { glAccountCode?: string | null }): boolean {
    const code = String(acc.glAccountCode || '');
    if (!code) return false;
    if (['1000', '1015', '1200', '1250', '1300', '1500', '2100', '2200', '3050'].includes(code)) {
        return false;
    }
    if (/^12\d{2}/.test(code) || /^2\d{3}/.test(code) || /^3\d{3}/.test(code) || /^[4567]\d{3}/.test(code)) {
        return false;
    }
    // Cash / bank / MoMo / card / extra bank books (10xx liquidity range)
    return /^10\d{2}/.test(code) || /^10\d{3,}/.test(code);
}

type TransactionFormData = {
    bankAccountId: string;
    transactionDate: string;
    type: 'DEPOSIT' | 'WITHDRAWAL' | 'FEE' | 'INTEREST';
    categoryId: string;
    /** Offset ledger — same idea as Journal Entry / Tally Receipt “Particulars”. */
    contraAccountId: string;
    description: string;
    reference: string;
    amount: number;
};

type TransferFormData = {
    fromAccountId: string;
    toAccountId: string;
    transactionDate: string;
    amount: number;
    description: string;
    reference: string;
};

const emptyTransactionForm: TransactionFormData = {
    bankAccountId: '',
    transactionDate: new Date().toLocaleDateString('en-CA'),
    type: 'DEPOSIT',
    categoryId: '',
    contraAccountId: '',
    description: '',
    reference: '',
    amount: 0
};

const emptyTransferForm: TransferFormData = {
    fromAccountId: '',
    toAccountId: '',
    transactionDate: new Date().toLocaleDateString('en-CA'),
    amount: 0,
    description: '',
    reference: ''
};

export const BankTransactionsTab: React.FC = () => {
    const [filterAccountId, setFilterAccountId] = useState<string>('');
    const [filterType, setFilterType] = useState<string>('');
    const [searchText, setSearchText] = useState('');

    const [isTransactionModalOpen, setIsTransactionModalOpen] = useState(false);
    const [isTransferModalOpen, setIsTransferModalOpen] = useState(false);
    const [isReverseModalOpen, setIsReverseModalOpen] = useState(false);

    // ── Transaction Guard ──────────────────────────────────────────────────
    const { openGuard, closeGuard } = useTransactionGuard();
    const transactionGuardRef = useRef<GuardHandle | null>(null);
    const transferGuardRef = useRef<GuardHandle | null>(null);
    const reverseGuardRef = useRef<GuardHandle | null>(null);

    useEffect(() => {
        if (isTransactionModalOpen) {
            transactionGuardRef.current = openGuard({ cancellable: false, label: 'Add bank transaction' });
            return () => { if (transactionGuardRef.current) { closeGuard(transactionGuardRef.current.id); transactionGuardRef.current = null; } };
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isTransactionModalOpen]);

    useEffect(() => {
        if (isTransferModalOpen) {
            transferGuardRef.current = openGuard({ cancellable: false, label: 'Bank transfer' });
            return () => { if (transferGuardRef.current) { closeGuard(transferGuardRef.current.id); transferGuardRef.current = null; } };
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isTransferModalOpen]);

    useEffect(() => {
        if (isReverseModalOpen) {
            reverseGuardRef.current = openGuard({ cancellable: false, label: 'Reverse bank transaction' });
            return () => { if (reverseGuardRef.current) { closeGuard(reverseGuardRef.current.id); reverseGuardRef.current = null; } };
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isReverseModalOpen]);
    const [selectedTransaction, setSelectedTransaction] = useState<BankTransaction | null>(null);
    const [reverseReason, setReverseReason] = useState('');

    const [transactionForm, setTransactionForm] = useState<TransactionFormData>(emptyTransactionForm);
    const [transferForm, setTransferForm] = useState<TransferFormData>(emptyTransferForm);
    const [transactionError, setTransactionError] = useState<string | null>(null);

    const { data: accounts = [] } = useBankAccounts();
    const { data: categories = [] } = useBankCategories();
    const { data: treasuryOn = false } = useTreasuryEnabled();
    const { data: glAccounts = [] } = useQuery({
        queryKey: ['chart-of-accounts', 'bank-offset'],
        queryFn: async (): Promise<GlAccount[]> => {
            const { data } = await api.get('/accounting/chart-of-accounts?isPostingAccount=true&isActive=true');
            const rows = (data?.data || data || []) as Array<Record<string, unknown>>;
            return rows
                .map((a) => ({
                    id: String(a.id ?? a.Id ?? ''),
                    accountNumber: String(a.accountNumber ?? a.AccountCode ?? a.accountCode ?? ''),
                    accountName: String(a.accountName ?? a.AccountName ?? ''),
                    accountType: String(a.accountType ?? a.AccountType ?? ''),
                }))
                .filter((a) => a.id && a.accountNumber && isBankOffsetAccount(a));
        },
        staleTime: 5 * 60_000,
    });
    const { data: transactionsData, isLoading, refetch } = useBankTransactions({
        bankAccountId: filterAccountId || undefined,
        type: filterType || undefined,
        limit: 100
    });

    const transactions = transactionsData?.transactions || [];

    /** Only bank books linked to Cash/Bank GLs may appear in transfer From/To (TD-INV-6). */
    const transferAccounts = useMemo(
        () => accounts.filter((a) => a.isActive !== false && isTransferEligibleBankAccount(a)),
        [accounts],
    );
    const blockedTransferCount = accounts.filter(
        (a) => a.isActive !== false && !isTransferEligibleBankAccount(a),
    ).length;

    const preferredCapitalAccountId = useMemo(() => resolveOwnerCapitalId(glAccounts), [glAccounts]);
    const preferredDrawingAccountId = useMemo(() => resolveOwnerDrawingId(glAccounts), [glAccounts]);

    const offsetAccounts = useMemo(() => {
        const preferred =
            transactionForm.type === 'DEPOSIT' || transactionForm.type === 'INTEREST'
                ? preferredCapitalAccountId
                : preferredDrawingAccountId;
        if (!preferred) return glAccounts;
        const head = glAccounts.find((a) => a.id === preferred);
        const rest = glAccounts.filter((a) => a.id !== preferred);
        return head ? [head, ...rest] : glAccounts;
    }, [glAccounts, preferredCapitalAccountId, preferredDrawingAccountId, transactionForm.type]);

    const resolveDefaultsForType = (type: TransactionFormData['type']) => {
        const isIn = type === 'DEPOSIT' || type === 'INTEREST';
        const contra = isIn ? preferredCapitalAccountId : preferredDrawingAccountId;
        const catCode = isIn ? 'OWNER_CAPITAL' : 'OWNER_DRAWING';
        const cat = categories.find((c) => c.code === catCode);
        return {
            categoryId: cat?.id || '',
            contraAccountId: contra,
            description: isIn
                ? 'Capital investment by owner'
                : type === 'WITHDRAWAL'
                  ? 'Owner withdrawal / drawings'
                  : '',
        };
    };

    const createTransactionMutation = useCreateBankTransaction();
    const createTransferMutation = useCreateBankTransfer();
    const reverseMutation = useReverseBankTransaction();

    // Filter by search text
    const filteredTransactions = useMemo(() => {
        if (!searchText) return transactions;
        const lower = searchText.toLowerCase();
        return transactions.filter(t =>
            t.description?.toLowerCase().includes(lower) ||
            t.reference?.toLowerCase().includes(lower) ||
            t.transactionNumber?.toLowerCase().includes(lower)
        );
    }, [transactions, searchText]);

    const handleOpenTransactionModal = () => {
        const defaults = resolveDefaultsForType('DEPOSIT');
        setTransactionForm({
            ...emptyTransactionForm,
            bankAccountId: filterAccountId || accounts[0]?.id || '',
            ...defaults,
        });
        setTransactionError(null);
        setIsTransactionModalOpen(true);
    };

    const handleOpenTransferModal = () => {
        setTransferForm({
            ...emptyTransferForm,
            fromAccountId: transferAccounts[0]?.id || accounts[0]?.id || '',
            toAccountId: accounts[1]?.id || ''
        });
        setIsTransferModalOpen(true);
    };

    const handleOpenReverseModal = (txn: BankTransaction) => {
        setSelectedTransaction(txn);
        setReverseReason('');
        setIsReverseModalOpen(true);
    };

    const handleSubmitTransaction = async (e: React.FormEvent) => {
        e.preventDefault();
        setTransactionError(null);
        if (!transactionForm.contraAccountId) {
            setTransactionError('Select who the money is from or to (e.g. Owner Capital).');
            return;
        }
        if (!Number.isFinite(transactionForm.amount) || transactionForm.amount <= 0) {
            setTransactionError('Enter an amount greater than 0.');
            return;
        }
        try {
            await createTransactionMutation.mutateAsync({
                bankAccountId: transactionForm.bankAccountId,
                transactionDate: transactionForm.transactionDate,
                type: transactionForm.type,
                categoryId: transactionForm.categoryId || undefined,
                contraAccountId: transactionForm.contraAccountId,
                description: transactionForm.description,
                reference: transactionForm.reference || undefined,
                amount: transactionForm.amount
            });
            toast.success('Transaction saved');
            setIsTransactionModalOpen(false);
            refetch();
        } catch (error) {
            setTransactionError((error as Error).message || 'Failed to create transaction');
        }
    };

    const handleSubmitTransfer = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!Number.isFinite(transferForm.amount) || transferForm.amount <= 0) {
            toast.error('Enter an amount greater than 0.');
            return;
        }
        try {
            await createTransferMutation.mutateAsync({
                fromAccountId: transferForm.fromAccountId,
                toAccountId: transferForm.toAccountId,
                transactionDate: transferForm.transactionDate,
                amount: transferForm.amount,
                description: transferForm.description || undefined,
                reference: transferForm.reference || undefined
            });
            setIsTransferModalOpen(false);
            refetch();
        } catch (error) {
            console.error('Failed to create transfer:', error);
        }
    };

    const handleReverseTransaction = async () => {
        if (!selectedTransaction || !reverseReason.trim()) return;
        try {
            await reverseMutation.mutateAsync({
                id: selectedTransaction.id,
                reason: reverseReason
            });
            toast.success('Transaction reversed');
            setIsReverseModalOpen(false);
            setSelectedTransaction(null);
            refetch();
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to reverse transaction';
            toast.error(message);
            console.error('Failed to reverse transaction:', error);
        }
    };

    const getTypeIcon = (type: string) => {
        switch (type) {
            case 'DEPOSIT':
            case 'TRANSFER_IN':
            case 'INTEREST':
                return <ArrowDownLeft className="h-4 w-4 text-green-500" />;
            case 'WITHDRAWAL':
            case 'TRANSFER_OUT':
            case 'FEE':
                return <ArrowUpRight className="h-4 w-4 text-red-500" />;
            default:
                return <ArrowLeftRight className="h-4 w-4" />;
        }
    };

    const getTypeBadge = (type: string) => {
        const variants: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
            DEPOSIT: 'default',
            WITHDRAWAL: 'destructive',
            TRANSFER_IN: 'secondary',
            TRANSFER_OUT: 'secondary',
            FEE: 'outline',
            INTEREST: 'default'
        };
        return <Badge variant={variants[type] || 'outline'}>{type.replace('_', ' ')}</Badge>;
    };

    if (isLoading) {
        return <div className="flex items-center justify-center py-8">Loading transactions...</div>;
    }

    return (
        <Card>
            <CardHeader className="flex flex-row items-center justify-between">
                <div>
                    <CardTitle>Transactions</CardTitle>
                    <CardDescription>
                        View and manage bank transactions
                    </CardDescription>
                </div>
                <div className="flex items-center gap-2">
                    <Button variant="outline" onClick={handleOpenTransferModal}>
                        <ArrowLeftRight className="h-4 w-4 mr-2" />
                        Transfer
                    </Button>
                    <Button onClick={handleOpenTransactionModal}>
                        <Plus className="h-4 w-4 mr-2" />
                        Add Transaction
                    </Button>
                </div>
            </CardHeader>
            <CardContent className="space-y-4">
                {/* Filters */}
                <div className="flex flex-wrap gap-4">
                    <div className="flex-1 min-w-[200px]">
                        <div className="relative">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                            <Input
                                placeholder="Search transactions..."
                                value={searchText}
                                onChange={e => setSearchText(e.target.value)}
                                className="pl-9"
                            />
                        </div>
                    </div>
                    <Select value={filterAccountId || '_all'} onValueChange={(v) => setFilterAccountId(v === '_all' ? '' : v)}>
                        <SelectTrigger className="w-[200px]">
                            <SelectValue placeholder="All Accounts" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="_all">All Accounts</SelectItem>
                            {accounts.map(acc => (
                                <SelectItem key={acc.id} value={acc.id}>{formatBankAccountLabel(acc)}</SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <Select value={filterType || '_all'} onValueChange={(v) => setFilterType(v === '_all' ? '' : v)}>
                        <SelectTrigger className="w-[150px]">
                            <SelectValue placeholder="All Types" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="_all">All Types</SelectItem>
                            <SelectItem value="DEPOSIT">Deposit</SelectItem>
                            <SelectItem value="WITHDRAWAL">Withdrawal</SelectItem>
                            <SelectItem value="TRANSFER_IN">Transfer In</SelectItem>
                            <SelectItem value="TRANSFER_OUT">Transfer Out</SelectItem>
                            <SelectItem value="FEE">Fee</SelectItem>
                            <SelectItem value="INTEREST">Interest</SelectItem>
                        </SelectContent>
                    </Select>
                </div>

                {/* Transactions Table */}
                {filteredTransactions.length === 0 ? (
                    <div className="text-center py-8 text-muted-foreground">
                        <ArrowLeftRight className="h-12 w-12 mx-auto mb-4 opacity-50" />
                        <p>No transactions found</p>
                    </div>
                ) : (
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>Date</TableHead>
                                <TableHead>Reference</TableHead>
                                <TableHead>Description</TableHead>
                                <TableHead>Account</TableHead>
                                <TableHead>Type</TableHead>
                                <TableHead>Category</TableHead>
                                <TableHead className="text-right">Amount</TableHead>
                                <TableHead>Status</TableHead>
                                <TableHead className="text-right">Actions</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {filteredTransactions.map(txn => (
                                <TableRow key={txn.id}>
                                    <TableCell>{txn.transactionDate}</TableCell>
                                    <TableCell className="font-mono text-sm">
                                        {txn.transactionNumber}
                                    </TableCell>
                                    <TableCell className="max-w-[200px] truncate" title={txn.description}>
                                        {txn.description}
                                    </TableCell>
                                    <TableCell>{txn.bankAccountName || '-'}</TableCell>
                                    <TableCell>
                                        <div className="flex items-center gap-2">
                                            {getTypeIcon(txn.type)}
                                            {getTypeBadge(txn.type)}
                                        </div>
                                    </TableCell>
                                    <TableCell>{txn.categoryName || '-'}</TableCell>
                                    <TableCell className="text-right font-mono">
                                        <span className={
                                            ['DEPOSIT', 'TRANSFER_IN', 'INTEREST'].includes(txn.type)
                                                ? 'text-green-600'
                                                : 'text-red-600'
                                        }>
                                            {['DEPOSIT', 'TRANSFER_IN', 'INTEREST'].includes(txn.type) ? '+' : '-'}
                                            {formatCurrency(txn.amount)}
                                        </span>
                                    </TableCell>
                                    <TableCell>
                                        {txn.isReconciled ? (
                                            <Badge variant="secondary">Reconciled</Badge>
                                        ) : (
                                            <Badge variant="outline">Pending</Badge>
                                        )}
                                    </TableCell>
                                    <TableCell className="text-right">
                                        {!txn.isReconciled && (
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                onClick={() => handleOpenReverseModal(txn)}
                                                title="Reverse transaction"
                                            >
                                                <RotateCcw className="h-4 w-4" />
                                            </Button>
                                        )}
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                )}
            </CardContent>

            {/* Add Transaction Modal */}
            <Dialog open={isTransactionModalOpen} onOpenChange={setIsTransactionModalOpen} zIndex={transactionGuardRef.current?.panelZIndex ?? ZINDEX.PANEL}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>Add Transaction</DialogTitle>
                        <DialogDescription>
                            Record money into or out of a bank book.
                        </DialogDescription>
                    </DialogHeader>
                    <form noValidate onSubmit={handleSubmitTransaction} className="space-y-4">
                        <div className="space-y-2">
                            <Label htmlFor="txn-account">Bank Account *</Label>
                            <Select
                                value={transactionForm.bankAccountId}
                                onValueChange={value => setTransactionForm(prev => ({ ...prev, bankAccountId: value }))}
                            >
                                <SelectTrigger>
                                    <SelectValue placeholder="Select account..." />
                                </SelectTrigger>
                                <SelectContent>
                                    {accounts.map(acc => (
                                        <SelectItem key={acc.id} value={acc.id}>{formatBankAccountLabel(acc)}</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>

                        <div className="grid grid-cols-2 gap-4">
                            <div className="space-y-2">
                                <Label htmlFor="txn-date">Date *</Label>
                                <DatePicker
                                    id="txn-date"
                                    value={transactionForm.transactionDate}
                                    onChange={(v) => setTransactionForm(prev => ({ ...prev, transactionDate: v }))}
                                    required
                                    placeholder="Transaction date"
                                />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="txn-type">Type *</Label>
                                <Select
                                    value={transactionForm.type}
                                    onValueChange={value => {
                                        const type = value as TransactionFormData['type'];
                                        setTransactionForm((prev) => ({
                                            ...prev,
                                            type,
                                            ...resolveDefaultsForType(type),
                                        }));
                                    }}
                                >
                                    <SelectTrigger>
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="DEPOSIT">Deposit</SelectItem>
                                        <SelectItem value="WITHDRAWAL">Withdrawal</SelectItem>
                                        <SelectItem value="FEE">Bank Fee</SelectItem>
                                        <SelectItem value="INTEREST">Interest</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                        </div>

                        <div className="space-y-2">
                            <Label htmlFor="txn-offset">
                                {transactionForm.type === 'DEPOSIT' || transactionForm.type === 'INTEREST'
                                    ? 'Received from *'
                                    : 'Paid to *'}
                            </Label>
                            <Select
                                value={transactionForm.contraAccountId || undefined}
                                onValueChange={(value) =>
                                    setTransactionForm((prev) => ({ ...prev, contraAccountId: value }))
                                }
                            >
                                <SelectTrigger id="txn-offset">
                                    <SelectValue placeholder="Select account..." />
                                </SelectTrigger>
                                <SelectContent>
                                    {offsetAccounts.map((acc) => (
                                        <SelectItem key={acc.id} value={acc.id}>
                                            {acc.accountNumber} – {acc.accountName}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>

                        {transactionError && (
                            <p className="text-sm text-destructive">{transactionError}</p>
                        )}

                        <div className="space-y-2">
                            <Label htmlFor="txn-amount">Amount *</Label>
                            <Input
                                id="txn-amount"
                                type="number"
                                step="1"
                                value={transactionForm.amount || ''}
                                onChange={e => setTransactionForm(prev => ({ ...prev, amount: parseFloat(e.target.value) || 0 }))}
                                required
                            />
                        </div>

                        <div className="space-y-2">
                            <Label htmlFor="txn-description">Description *</Label>
                            <Input
                                id="txn-description"
                                value={transactionForm.description}
                                onChange={e => setTransactionForm(prev => ({ ...prev, description: e.target.value }))}
                                placeholder="Transaction description"
                                required
                            />
                        </div>

                        <div className="space-y-2">
                            <Label htmlFor="txn-reference">Reference</Label>
                            <Input
                                id="txn-reference"
                                value={transactionForm.reference}
                                onChange={e => setTransactionForm(prev => ({ ...prev, reference: e.target.value }))}
                                placeholder="Optional reference number"
                            />
                        </div>

                        <DialogFooter>
                            <Button type="button" variant="outline" onClick={() => setIsTransactionModalOpen(false)}>
                                Cancel
                            </Button>
                            <Button type="submit" disabled={createTransactionMutation.isPending}>
                                {createTransactionMutation.isPending ? 'Saving...' : 'Save'}
                            </Button>
                        </DialogFooter>
                    </form>
                </DialogContent>
            </Dialog>

            {/* Transfer Modal */}
            <Dialog open={isTransferModalOpen} onOpenChange={setIsTransferModalOpen} zIndex={transferGuardRef.current?.panelZIndex ?? ZINDEX.PANEL}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>Bank account transfer</DialogTitle>
                        <DialogDescription>
                            {treasuryOn
                                ? 'Moves money between bank accounts and posts a liquidity document (same engine as Banking → Move money). Use Move money for cash or mobile money.'
                                : 'Transfer funds between bank accounts. Cross-account cash / mobile money moves become available when Treasury Documents are enabled in Settings → Tax.'}
                        </DialogDescription>
                    </DialogHeader>
                    <form noValidate onSubmit={handleSubmitTransfer} className="space-y-4">
                        <div className="space-y-2">
                            <Label htmlFor="transfer-from">From Account *</Label>
                            <Select
                                value={transferForm.fromAccountId}
                                onValueChange={value => setTransferForm(prev => ({ ...prev, fromAccountId: value }))}
                            >
                                <SelectTrigger>
                                    <SelectValue placeholder="Select account..." />
                                </SelectTrigger>
                                <SelectContent>
                                    {transferAccounts.map(acc => (
                                        <SelectItem key={acc.id} value={acc.id}>
                                            {formatBankAccountLabel(acc, { showBalance: true })}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>

                        <div className="space-y-2">
                            <Label htmlFor="transfer-to">To Account *</Label>
                            <Select
                                value={transferForm.toAccountId}
                                onValueChange={value => setTransferForm(prev => ({ ...prev, toAccountId: value }))}
                            >
                                <SelectTrigger>
                                    <SelectValue placeholder="Select account..." />
                                </SelectTrigger>
                                <SelectContent>
                                    {transferAccounts
                                        .filter(acc => acc.id !== transferForm.fromAccountId)
                                        .map(acc => (
                                            <SelectItem key={acc.id} value={acc.id}>
                                                {formatBankAccountLabel(acc, { showBalance: true })}
                                            </SelectItem>
                                        ))}
                                </SelectContent>
                            </Select>
                            {blockedTransferCount > 0 && (
                                <p className="text-xs text-amber-700">
                                    {blockedTransferCount} bank book(s) hidden — linked to a non-bank GL (e.g. AR 1200).
                                    Edit them under Banking → Accounts and use Create & use this GL for a real bank Asset.
                                </p>
                            )}
                        </div>

                        <div className="grid grid-cols-2 gap-4">
                            <div className="space-y-2">
                                <Label htmlFor="transfer-date">Date *</Label>
                                <DatePicker
                                    id="transfer-date"
                                    value={transferForm.transactionDate}
                                    onChange={(v) => setTransferForm(prev => ({ ...prev, transactionDate: v }))}
                                    required
                                    placeholder="Transfer date"
                                />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="transfer-amount">Amount *</Label>
                                <Input
                                    id="transfer-amount"
                                    type="number"
                                    step="1"
                                    value={transferForm.amount || ''}
                                    onChange={e => setTransferForm(prev => ({ ...prev, amount: parseFloat(e.target.value) || 0 }))}
                                    required
                                />
                            </div>
                        </div>

                        <div className="space-y-2">
                            <Label htmlFor="transfer-description">Description</Label>
                            <Input
                                id="transfer-description"
                                value={transferForm.description}
                                onChange={e => setTransferForm(prev => ({ ...prev, description: e.target.value }))}
                                placeholder="e.g., Weekly transfer to savings"
                            />
                        </div>

                        <DialogFooter>
                            <Button type="button" variant="outline" onClick={() => setIsTransferModalOpen(false)}>
                                Cancel
                            </Button>
                            <Button type="submit" disabled={createTransferMutation.isPending}>
                                {createTransferMutation.isPending ? 'Transferring...' : 'Transfer'}
                            </Button>
                        </DialogFooter>
                    </form>
                </DialogContent>
            </Dialog>

            {/* Reverse Transaction Modal */}
            <Dialog open={isReverseModalOpen} onOpenChange={setIsReverseModalOpen} zIndex={reverseGuardRef.current?.panelZIndex ?? ZINDEX.PANEL}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>Reverse Transaction</DialogTitle>
                        <DialogDescription>
                            {treasuryOn
                                ? 'Creates a reversing liquidity document (original stays on file). Linked bank lines drop off the live register. Blocked if already statement-reconciled.'
                                : 'This will create a reversing entry. This action cannot be undone.'}
                        </DialogDescription>
                    </DialogHeader>
                    {selectedTransaction && (
                        <div className="space-y-4">
                            <div className="bg-muted p-4 rounded-lg">
                                <div className="text-sm text-muted-foreground">Transaction</div>
                                <div className="font-mono">{selectedTransaction.transactionNumber}</div>
                                <div className="mt-2 text-sm text-muted-foreground">Amount</div>
                                <div className="font-mono">{formatCurrency(selectedTransaction.amount)}</div>
                                <div className="mt-2 text-sm text-muted-foreground">Description</div>
                                <div>{selectedTransaction.description}</div>
                            </div>

                            <div className="space-y-2">
                                <Label htmlFor="reverse-reason">Reason for reversal *</Label>
                                <Textarea
                                    id="reverse-reason"
                                    value={reverseReason}
                                    onChange={e => setReverseReason(e.target.value)}
                                    placeholder="Enter reason for reversing this transaction"
                                    required
                                />
                            </div>

                            <DialogFooter>
                                <Button type="button" variant="outline" onClick={() => setIsReverseModalOpen(false)}>
                                    Cancel
                                </Button>
                                <Button
                                    variant="destructive"
                                    onClick={handleReverseTransaction}
                                    disabled={!reverseReason.trim() || reverseMutation.isPending}
                                >
                                    {reverseMutation.isPending ? 'Reversing...' : 'Reverse Transaction'}
                                </Button>
                            </DialogFooter>
                        </div>
                    )}
                </DialogContent>
            </Dialog>
        </Card>
    );
};
