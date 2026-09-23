/**
 * RECONCILIATION TAB
 *
 * Bank reconciliation (classic / QBO style):
 *   Cleared = Last reconciled (0 if never) + selected deposits − selected withdrawals
 *   Difference = Statement ending − Cleared  → must be ~0 to post
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import Decimal from 'decimal.js';
import { CheckCircle2, Circle, Calculator } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { DatePicker } from '@/components/ui/date-picker';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Checkbox } from '@/components/ui/checkbox';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
    useBankAccounts,
    useBankTransactions,
    useReconcileTransactions,
} from '../../hooks/useBanking';
import { formatCurrency } from '../../utils/currency';
import { formatTimestampDate } from '../../utils/businessDate';

const INFLOW = new Set(['DEPOSIT', 'TRANSFER_IN', 'INTEREST']);
const OUTFLOW = new Set(['WITHDRAWAL', 'TRANSFER_OUT', 'FEE']);

function txnDay(date: string): string {
    return String(date).slice(0, 10);
}

export const ReconciliationTab: React.FC = () => {
    const [selectedAccountId, setSelectedAccountId] = useState<string>('');
    const [statementBalance, setStatementBalance] = useState<string>('');
    const [statementDate, setStatementDate] = useState(new Date().toLocaleDateString('en-CA'));
    const [selectedTransactionIds, setSelectedTransactionIds] = useState<Set<string>>(new Set());
    const [showReconciled, setShowReconciled] = useState(false);
    const [reconcileResult, setReconcileResult] = useState<{
        reconciledCount: number;
        newBalance: number;
        clearedBalance: number;
        bookBalance: number;
    } | null>(null);
    /** User typed statement ending manually — do not overwrite with auto-fill. */
    const statementBalanceTouched = useRef(false);

    const { data: accounts = [] } = useBankAccounts();
    const { data: transactionsData } = useBankTransactions({
        bankAccountId: selectedAccountId || undefined,
        isReconciled: showReconciled ? undefined : false,
        limit: 500,
    });
    const reconcileMutation = useReconcileTransactions();

    const allTransactions = transactionsData?.transactions || [];
    const selectedAccount = accounts.find((a) => a.id === selectedAccountId);

    // Only statement-period transactions participate in this reconcile
    const transactions = useMemo(() => {
        if (!statementDate) return allTransactions;
        return allTransactions.filter((t) => {
            if (t.isReconciled) return showReconciled;
            return txnDay(t.transactionDate) <= statementDate;
        });
    }, [allTransactions, statementDate, showReconciled]);

    const lastReconciled = selectedAccount?.lastReconciledBalance ?? 0;
    const neverReconciled = selectedAccount != null && selectedAccount.lastReconciledBalance == null;

    const totals = useMemo(() => {
        const selected = transactions.filter((t) => selectedTransactionIds.has(t.id));
        const unselected = transactions.filter(
            (t) => !selectedTransactionIds.has(t.id) && !t.isReconciled,
        );

        const sumIn = (rows: typeof selected) =>
            rows
                .filter((t) => INFLOW.has(t.type))
                .reduce((sum, t) => new Decimal(sum).plus(t.amount).toNumber(), 0);
        const sumOut = (rows: typeof selected) =>
            rows
                .filter((t) => OUTFLOW.has(t.type))
                .reduce((sum, t) => new Decimal(sum).plus(t.amount).toNumber(), 0);

        const selectedDeposits = sumIn(selected);
        const selectedWithdrawals = sumOut(selected);
        const selectedNet = new Decimal(selectedDeposits).minus(selectedWithdrawals).toNumber();
        const clearedBalance = new Decimal(lastReconciled).plus(selectedNet).toNumber();

        return {
            selectedDeposits,
            selectedWithdrawals,
            selectedNet,
            clearedBalance,
            unselectedDeposits: sumIn(unselected),
            unselectedWithdrawals: sumOut(unselected),
            unselectedNet: new Decimal(sumIn(unselected)).minus(sumOut(unselected)).toNumber(),
            selectedCount: selected.length,
            unselectedCount: unselected.length,
        };
    }, [transactions, selectedTransactionIds, lastReconciled]);

    const difference = useMemo(() => {
        if (!statementBalance || !selectedAccount) return null;
        const stmtBal = parseFloat(statementBalance);
        if (isNaN(stmtBal)) return null;
        return new Decimal(stmtBal).minus(totals.clearedBalance).toNumber();
    }, [statementBalance, selectedAccount, totals.clearedBalance]);

    const isBalanced = difference != null && Math.abs(difference) <= 0.01;

    const reconcileDisabledReason = useMemo(() => {
        if (!selectedAccountId) return 'Select a bank account';
        if (selectedTransactionIds.size === 0) return 'Select at least one transaction on the statement';
        if (!statementBalance.trim()) {
            return 'Enter the statement ending balance from your bank (for first reconciliation, this is usually the opening balance)';
        }
        if (difference == null) return 'Enter a valid statement ending balance';
        if (!isBalanced) {
            return `Difference must be zero (currently ${formatCurrency(difference)}). Adjust selected items or the statement ending balance.`;
        }
        return null;
    }, [
        selectedAccountId,
        selectedTransactionIds.size,
        statementBalance,
        difference,
        isBalanced,
    ]);

    // First reconciliation: when user checks transactions, pre-fill statement ending = cleared.
    useEffect(() => {
        if (statementBalanceTouched.current) return;
        if (selectedTransactionIds.size === 0 || totals.clearedBalance === 0) return;
        setStatementBalance(String(totals.clearedBalance));
    }, [selectedTransactionIds, totals.clearedBalance]);

    const handleToggleTransaction = (transactionId: string) => {
        setSelectedTransactionIds((prev) => {
            const next = new Set(prev);
            if (next.has(transactionId)) next.delete(transactionId);
            else next.add(transactionId);
            return next;
        });
    };

    const handleSelectAll = () => {
        const unreconciledIds = transactions
            .filter((t) => !t.isReconciled && !t.isReversed)
            .map((t) => t.id);
        setSelectedTransactionIds(new Set(unreconciledIds));
    };

    const handleSelectNone = () => setSelectedTransactionIds(new Set());

    const handleReconcile = async () => {
        if (!selectedAccountId || selectedTransactionIds.size === 0) return;

        const stmtBal = parseFloat(statementBalance);
        if (isNaN(stmtBal)) {
            alert('Please enter a valid statement ending balance');
            return;
        }
        if (!isBalanced) {
            alert(
                `Reconciliation is not balanced (difference ${formatCurrency(difference ?? 0)}). ` +
                    'Statement ending must equal last reconciled + selected net.',
            );
            return;
        }

        try {
            const result = await reconcileMutation.mutateAsync({
                bankAccountId: selectedAccountId,
                transactionIds: Array.from(selectedTransactionIds),
                statementBalance: stmtBal,
                statementDate,
            });

            setReconcileResult({
                reconciledCount: result.reconciledCount,
                newBalance: result.newBalance,
                clearedBalance: result.clearedBalance,
                bookBalance: result.bookBalance,
            });
            setSelectedTransactionIds(new Set());
            setStatementBalance('');
        } catch (error) {
            alert((error as Error).message);
        }
    };

    const getTransactionSign = (type: string) => (INFLOW.has(type) ? '+' : '-');
    const getTransactionColor = (type: string) =>
        INFLOW.has(type) ? 'text-green-600' : 'text-red-600';

    return (
        <div className="space-y-6">
            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <Calculator className="h-5 w-5" />
                        Bank Reconciliation
                    </CardTitle>
                    <CardDescription>
                        Match your bank statement with recorded transactions. Cleared balance must
                        equal the statement ending balance before you can complete.
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                        <div className="space-y-2">
                            <Label>Bank Account</Label>
                            <Select
                                value={selectedAccountId}
                                onValueChange={(id) => {
                                    setSelectedAccountId(id);
                                    setSelectedTransactionIds(new Set());
                                    setReconcileResult(null);
                                    setStatementBalance('');
                                    statementBalanceTouched.current = false;
                                }}
                            >
                                <SelectTrigger>
                                    <SelectValue placeholder="Select account..." />
                                </SelectTrigger>
                                <SelectContent>
                                    {accounts.map((acc) => (
                                        <SelectItem key={acc.id} value={acc.id}>
                                            {acc.name}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>

                        <div className="space-y-2">
                            <Label>Statement Date</Label>
                            <DatePicker
                                value={statementDate}
                                onChange={(d) => {
                                    setStatementDate(d);
                                    setSelectedTransactionIds(new Set());
                                    setStatementBalance('');
                                    statementBalanceTouched.current = false;
                                }}
                                placeholder="Statement date"
                            />
                        </div>

                        <div className="space-y-2">
                            <Label>Statement Ending Balance</Label>
                            <div className="flex gap-2">
                                <Input
                                    type="number"
                                    step="1"
                                    value={statementBalance}
                                    onChange={(e) => {
                                        statementBalanceTouched.current = true;
                                        setStatementBalance(e.target.value);
                                    }}
                                    placeholder="0.00"
                                />
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    className="shrink-0"
                                    disabled={totals.clearedBalance === 0}
                                    onClick={() => {
                                        statementBalanceTouched.current = true;
                                        setStatementBalance(String(totals.clearedBalance));
                                    }}
                                >
                                    Use cleared
                                </Button>
                            </div>
                            {neverReconciled && (
                                <p className="text-xs text-muted-foreground">
                                    First reconciliation: check the opening-balance line, then enter the
                                    same amount as your statement ending balance.
                                </p>
                            )}
                        </div>

                        <div className="space-y-2">
                            <Label>Last Reconciled Balance</Label>
                            <div className="h-10 flex items-center px-3 border rounded-md bg-muted font-medium">
                                {selectedAccount
                                    ? formatCurrency(lastReconciled)
                                    : 'Select account…'}
                            </div>
                        </div>
                    </div>

                    {selectedAccount && (
                        <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
                            <span>
                                {neverReconciled
                                    ? 'Never reconciled — opening for this run is 0.00'
                                    : selectedAccount.lastReconciledAt
                                      ? `Last reconciled: ${formatTimestampDate(selectedAccount.lastReconciledAt)}`
                                      : null}
                            </span>
                            <span>
                                Book (GL) balance: {formatCurrency(selectedAccount.currentBalance)}
                            </span>
                            <span>
                                Cleared (this run): {formatCurrency(totals.clearedBalance)}
                            </span>
                        </div>
                    )}
                </CardContent>
            </Card>

            {selectedAccountId && (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <Card>
                        <CardHeader className="pb-2">
                            <CardTitle className="text-sm font-medium">
                                Selected for Reconciliation
                            </CardTitle>
                        </CardHeader>
                        <CardContent>
                            <div className="text-2xl font-bold">{totals.selectedCount} transactions</div>
                            <div className="text-sm text-muted-foreground">
                                <span className="text-green-600">
                                    +{formatCurrency(totals.selectedDeposits)}
                                </span>
                                {' / '}
                                <span className="text-red-600">
                                    −{formatCurrency(totals.selectedWithdrawals)}
                                </span>
                            </div>
                            <div className="text-sm font-medium mt-1">
                                Net: {formatCurrency(totals.selectedNet)}
                            </div>
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader className="pb-2">
                            <CardTitle className="text-sm font-medium">Uncleared (in period)</CardTitle>
                        </CardHeader>
                        <CardContent>
                            <div className="text-2xl font-bold">{totals.unselectedCount} transactions</div>
                            <div className="text-sm text-muted-foreground">
                                Deposits in transit or outstanding checks
                            </div>
                            <div className="text-sm font-medium mt-1">
                                Net: {formatCurrency(totals.unselectedNet)}
                            </div>
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader className="pb-2">
                            <CardTitle className="text-sm font-medium">
                                Reconciliation Difference
                            </CardTitle>
                        </CardHeader>
                        <CardContent>
                            <div
                                className={`text-2xl font-bold ${
                                    difference !== null && !isBalanced
                                        ? 'text-red-600'
                                        : 'text-green-600'
                                }`}
                            >
                                {difference !== null ? formatCurrency(difference) : '—'}
                            </div>
                            <div className="text-sm text-muted-foreground">
                                {difference === null
                                    ? 'Enter statement ending balance'
                                    : isBalanced
                                      ? '✓ Balanced — ready to complete'
                                      : 'Statement − (last reconciled + selected net)'}
                            </div>
                        </CardContent>
                    </Card>
                </div>
            )}

            {reconcileResult && (
                <Alert>
                    <CheckCircle2 className="h-4 w-4" />
                    <AlertTitle>Reconciliation Complete</AlertTitle>
                    <AlertDescription>
                        {reconcileResult.reconciledCount} transactions marked as reconciled.
                        New last reconciled balance: {formatCurrency(reconcileResult.newBalance)}.
                        Cleared {formatCurrency(reconcileResult.clearedBalance)}; book (GL){' '}
                        {formatCurrency(reconcileResult.bookBalance)}.
                    </AlertDescription>
                </Alert>
            )}

            {selectedAccountId && (
                <Card>
                    <CardHeader>
                        <div className="flex items-center justify-between gap-4 flex-wrap">
                            <div>
                                <CardTitle>Transactions to Reconcile</CardTitle>
                                <CardDescription>
                                    Check off items on the statement through {statementDate || '…'}
                                </CardDescription>
                            </div>
                            <div className="flex gap-2 flex-wrap">
                                <Button variant="outline" size="sm" onClick={handleSelectAll}>
                                    Select All
                                </Button>
                                <Button variant="outline" size="sm" onClick={handleSelectNone}>
                                    Select None
                                </Button>
                                <Button
                                    variant="default"
                                    size="sm"
                                    onClick={handleReconcile}
                                    disabled={
                                        !!reconcileDisabledReason ||
                                        reconcileMutation.isPending
                                    }
                                    title={reconcileDisabledReason ?? undefined}
                                >
                                    {reconcileMutation.isPending
                                        ? 'Reconciling...'
                                        : 'Reconcile Selected'}
                                </Button>
                            </div>
                            {reconcileDisabledReason && selectedTransactionIds.size > 0 && (
                                <p className="text-sm text-amber-700 mt-2">{reconcileDisabledReason}</p>
                            )}
                        </div>
                    </CardHeader>
                    <CardContent>
                        <div className="mb-4">
                            <label className="flex items-center gap-2 text-sm">
                                <Checkbox
                                    checked={showReconciled}
                                    onCheckedChange={(checked) => setShowReconciled(!!checked)}
                                />
                                Show already reconciled transactions
                            </label>
                        </div>

                        {transactions.length === 0 ? (
                            <div className="text-center py-8 text-muted-foreground">
                                <Circle className="h-12 w-12 mx-auto mb-4 text-muted-foreground/50" />
                                <p>No unreconciled transactions on or before the statement date</p>
                            </div>
                        ) : (
                            <div className="rounded-md border">
                                <Table>
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead className="w-12">
                                                <Checkbox
                                                    checked={
                                                        selectedTransactionIds.size ===
                                                            transactions.filter((t) => !t.isReconciled)
                                                                .length &&
                                                        transactions.some((t) => !t.isReconciled)
                                                    }
                                                    onCheckedChange={(checked) =>
                                                        checked ? handleSelectAll() : handleSelectNone()
                                                    }
                                                />
                                            </TableHead>
                                            <TableHead>Date</TableHead>
                                            <TableHead>Description</TableHead>
                                            <TableHead>Reference</TableHead>
                                            <TableHead>Type</TableHead>
                                            <TableHead className="text-right">Amount</TableHead>
                                            <TableHead>Status</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {transactions.map((txn) => (
                                            <TableRow
                                                key={txn.id}
                                                className={txn.isReconciled ? 'bg-muted/30' : undefined}
                                            >
                                                <TableCell>
                                                    <Checkbox
                                                        checked={
                                                            selectedTransactionIds.has(txn.id) ||
                                                            txn.isReconciled
                                                        }
                                                        disabled={txn.isReconciled}
                                                        onCheckedChange={() =>
                                                            handleToggleTransaction(txn.id)
                                                        }
                                                    />
                                                </TableCell>
                                                <TableCell className="whitespace-nowrap">
                                                    {formatTimestampDate(txn.transactionDate)}
                                                </TableCell>
                                                <TableCell
                                                    className="max-w-xs truncate"
                                                    title={txn.description}
                                                >
                                                    {txn.description}
                                                </TableCell>
                                                <TableCell className="text-muted-foreground">
                                                    {txn.reference || '—'}
                                                </TableCell>
                                                <TableCell>
                                                    <Badge variant="outline" className="capitalize">
                                                        {txn.type.toLowerCase().replace('_', ' ')}
                                                    </Badge>
                                                </TableCell>
                                                <TableCell
                                                    className={`text-right font-medium ${getTransactionColor(txn.type)}`}
                                                >
                                                    {getTransactionSign(txn.type)}
                                                    {formatCurrency(txn.amount)}
                                                </TableCell>
                                                <TableCell>
                                                    {txn.isReconciled ? (
                                                        <Badge
                                                            variant="default"
                                                            className="bg-green-100 text-green-800"
                                                        >
                                                            <CheckCircle2 className="h-3 w-3 mr-1" />
                                                            Reconciled
                                                        </Badge>
                                                    ) : (
                                                        <Badge variant="secondary">Pending</Badge>
                                                    )}
                                                </TableCell>
                                            </TableRow>
                                        ))}
                                    </TableBody>
                                </Table>
                            </div>
                        )}
                    </CardContent>
                </Card>
            )}
        </div>
    );
};

export default ReconciliationTab;
