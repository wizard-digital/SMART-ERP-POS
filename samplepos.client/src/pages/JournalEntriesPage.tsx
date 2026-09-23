import { useState, useEffect, useRef } from 'react';
import Decimal from 'decimal.js';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { useTransactionGuard, ZINDEX } from '../hooks/useTransactionGuard';
import type { GuardHandle } from '../hooks/useTransactionGuard';
import { ClipboardCheck, Plus, RotateCcw, Search, RefreshCw, AlertTriangle, CheckCircle, X, ArrowDownLeft, ArrowUpRight } from 'lucide-react';
import { formatCurrency } from '../utils/currency';
import { DatePicker } from '../components/ui/date-picker';
import { ResponsiveTableWrapper } from '../components/ui/ResponsiveTableWrapper';
import { AdaptivePage, AdaptiveToolbar } from '../components/adaptive';
import { api } from '../services/api';

// API functions — axios with token refresh (ERP session policy)
const fetchJournalEntries = async (params: { dateFrom?: string; dateTo?: string; status?: string; page?: number; limit?: number }) => {
    const searchParams = new URLSearchParams();
    if (params.dateFrom) searchParams.set('dateFrom', params.dateFrom);
    if (params.dateTo) searchParams.set('dateTo', params.dateTo);
    if (params.status) searchParams.set('status', params.status);
    if (params.page) searchParams.set('page', params.page.toString());
    if (params.limit) searchParams.set('limit', params.limit.toString());

    const { data } = await api.get(`/erp-accounting/journal-entries?${searchParams}`);
    return data;
};

const fetchJournalEntry = async (id: string) => {
    const { data } = await api.get(`/erp-accounting/journal-entries/${id}`);
    return data;
};

const createJournalEntry = async (data: {
    transactionDate: string;
    description: string;
    referenceNumber?: string;
    lines: Array<{
        accountId: string;
        debitAmount?: number;
        creditAmount?: number;
        description?: string;
    }>;
}) => {
    // Map frontend field names to backend expected names
    const payload = {
        entryDate: data.transactionDate,
        narration: data.description,
        reference: data.referenceNumber || undefined,
        lines: data.lines.map(line => ({
            accountId: line.accountId,
            debitAmount: line.debitAmount || 0,
            creditAmount: line.creditAmount || 0,
            description: line.description
        }))
    };

    const { data: result } = await api.post('/erp-accounting/journal-entries', payload);
    return result;
};

const reverseJournalEntry = async ({ id, reason }: { id: string; reason: string }) => {
    try {
        const { data: result } = await api.post(`/erp-accounting/journal-entries/${id}/reverse`, { reason });
        return result;
    } catch (err: unknown) {
        const ax = err as { response?: { data?: { error?: string } } };
        throw new Error(ax.response?.data?.error || 'Failed to reverse journal entry');
    }
};

const fetchAccounts = async () => {
    const { data } = await api.get('/accounting/chart-of-accounts?isPostingAccount=true&isActive=true');
    return data;
};

const checkPeriodOpen = async (date: string): Promise<boolean> => {
    try {
        const { data } = await api.get(`/erp-accounting/periods/check-open?date=${date}`);
        return (data as { data?: { isOpen?: boolean } })?.data?.isOpen ?? true;
    } catch {
        return true;
    }
};

interface JournalLine {
    accountId: string;
    accountCode?: string;
    accountName?: string;
    debitAmount: number;
    creditAmount: number;
    description: string;
    entityType?: string;
    entityId?: string;
}

interface JournalEntryForm {
    transactionDate: string;
    description: string;
    referenceNumber: string;
    lines: JournalLine[];
}

interface Account {
    id: string;
    accountNumber: string;
    accountName: string;
    accountType: string;
    isPostingAccount: boolean;
    isActive: boolean;
    currentBalance: number;
}

interface JournalEntryListItem {
    id: string;
    entryDate: string;
    entryNumber?: string;
    reference?: string;
    narration: string;
    totalDebit: number;
    totalCredit: number;
    status: string;
}

interface JournalEntryDetailLine {
    accountCode: string;
    accountName: string;
    description?: string;
    debitAmount?: number;
    creditAmount?: number;
}

export default function JournalEntriesPage() {
    const queryClient = useQueryClient();
    const today = new Date();
    const [dateFrom, setDateFrom] = useState(format(new Date(today.getFullYear(), today.getMonth(), 1), 'yyyy-MM-dd'));
    const [dateTo, setDateTo] = useState(format(today, 'yyyy-MM-dd'));
    const [statusFilter, setStatusFilter] = useState<'POSTED' | 'REVERSED' | ''>('');
    const [showCreateModal, setShowCreateModal] = useState(false);
    const [showReverseModal, setShowReverseModal] = useState<string | null>(null);
    const [selectedEntry, setSelectedEntry] = useState<string | null>(null);
    const [reverseReason, setReverseReason] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [activePreset, setActivePreset] = useState<'capital-investment' | 'owner-withdrawal' | null>(null);
    const [presetAmount, setPresetAmount] = useState<number>(0);

    // ── Transaction Guard ─────────────────────────────────────────────────────
    // Lock the ERP UI whenever a journal posting or reversal dialog is open.
    // This prevents filter/date changes behind an open journal entry dialog
    // and eliminates double-posting from rapid button clicks.
    const { openGuard, closeGuard, singleSubmit } = useTransactionGuard();
    const createGuardRef = useRef<GuardHandle | null>(null);
    const reverseGuardRef = useRef<GuardHandle | null>(null);

    useEffect(() => {
        if (showCreateModal) {
            createGuardRef.current = openGuard({
                cancellable: true,
                label: 'New Journal Entry',
            });
            return () => {
                if (createGuardRef.current) {
                    closeGuard(createGuardRef.current.id);
                    createGuardRef.current = null;
                }
            };
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [showCreateModal]);

    useEffect(() => {
        if (showReverseModal) {
            reverseGuardRef.current = openGuard({
                cancellable: true,
                label: 'Reverse Journal Entry',
            });
            return () => {
                if (reverseGuardRef.current) {
                    closeGuard(reverseGuardRef.current.id);
                    reverseGuardRef.current = null;
                }
            };
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [showReverseModal]);

    // Wrap submit handlers with double-submission prevention
    const handleSubmitOnce = singleSubmit(async () => { handleSubmit(); });
    const handleReverseOnce = singleSubmit(async () => {
        if (!showReverseModal || !reverseReason.trim()) return;
        reverseMutation.mutate({ id: showReverseModal, reason: reverseReason.trim() });
    });

    // Form state for new journal entry
    const [form, setForm] = useState<JournalEntryForm>({
        transactionDate: format(today, 'yyyy-MM-dd'),
        description: '',
        referenceNumber: '',
        lines: [
            { accountId: '', debitAmount: 0, creditAmount: 0, description: '' },
            { accountId: '', debitAmount: 0, creditAmount: 0, description: '' }
        ]
    });

    // Check for pre-fill data from Reconciliation page (or any external source)
    useEffect(() => {
        const PREFILL_KEY = 'recon_adjust_prefill';
        const raw = sessionStorage.getItem(PREFILL_KEY);
        if (raw) {
            sessionStorage.removeItem(PREFILL_KEY);
            try {
                const prefill = JSON.parse(raw) as {
                    transactionDate?: string;
                    description?: string;
                    referenceNumber?: string;
                    lines?: Array<{
                        accountId: string;
                        debitAmount: number;
                        creditAmount: number;
                        description: string;
                    }>;
                };
                setForm({
                    transactionDate: prefill.transactionDate || format(today, 'yyyy-MM-dd'),
                    description: prefill.description || '',
                    referenceNumber: prefill.referenceNumber || '',
                    lines: prefill.lines && prefill.lines.length >= 2
                        ? prefill.lines
                        : [
                            { accountId: '', debitAmount: 0, creditAmount: 0, description: '' },
                            { accountId: '', debitAmount: 0, creditAmount: 0, description: '' }
                        ]
                });
                setShowCreateModal(true);
            } catch {
                // Ignore invalid JSON
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Queries
    const { data: entriesData, isLoading: entriesLoading, refetch } = useQuery({
        queryKey: ['journal-entries', dateFrom, dateTo, statusFilter],
        queryFn: () => fetchJournalEntries({ dateFrom, dateTo, status: statusFilter || undefined })
    });

    const { data: entryDetail, isLoading: detailLoading } = useQuery({
        queryKey: ['journal-entry', selectedEntry],
        queryFn: () => selectedEntry ? fetchJournalEntry(selectedEntry) : null,
        enabled: !!selectedEntry
    });

    const { data: accountsData } = useQuery({
        queryKey: ['accounts'],
        queryFn: fetchAccounts
    });

    // Mutations
    const createMutation = useMutation({
        mutationFn: createJournalEntry,
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['journal-entries'] });
            setShowCreateModal(false);
            resetForm();
            setError(null);
        },
        onError: (err: Error) => {
            setError(err.message);
        }
    });

    const reverseMutation = useMutation({
        mutationFn: reverseJournalEntry,
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['journal-entries'] });
            queryClient.invalidateQueries({ queryKey: ['journal-entry', showReverseModal] });
            setShowReverseModal(null);
            setReverseReason('');
            setError(null);
        },
        onError: (err: Error) => {
            setError(err.message);
        }
    });

    const entries = entriesData?.data?.entries || [];
    const accounts = accountsData?.data || [];
    const detail = entryDetail?.data;

    const resetForm = () => {
        setForm({
            transactionDate: format(today, 'yyyy-MM-dd'),
            description: '',
            referenceNumber: '',
            lines: [
                { accountId: '', debitAmount: 0, creditAmount: 0, description: '' },
                { accountId: '', debitAmount: 0, creditAmount: 0, description: '' }
            ]
        });
        setActivePreset(null);
        setPresetAmount(0);
    };

    // SAP-grade preset: system decides debit/credit sides; user enters amount only.
    const applyPreset = (preset: 'capital-investment' | 'owner-withdrawal') => {
        const accountList = accounts as Account[];
        const cashOrBank = accountList.find(a => a.accountNumber === '1010') || accountList.find(a => a.accountNumber === '1020');
        const ownerCapital =
            accountList.find(a => a.accountNumber === '3200' && !/opening balance/i.test(a.accountName)) ||
            accountList.find(a => a.accountNumber === '3200') ||
            accountList.find(a => a.accountNumber === '3000');
        const ownerDrawings = accountList.find(a => a.accountNumber === '3300');

        if (preset === 'capital-investment') {
            if (!cashOrBank || !ownerCapital) {
                setError('Required accounts not found (Cash/Bank 1010 or Owner Capital 3200). Check Chart of Accounts.');
                return;
            }
            // Dr Cash (increases) / Cr Owner Capital — the ONLY valid direction for cash coming in
            setForm(prev => ({
                ...prev,
                description: 'Capital investment by owner',
                lines: [
                    { accountId: cashOrBank.id, debitAmount: 0, creditAmount: 0, description: 'Capital received' },
                    { accountId: ownerCapital.id, debitAmount: 0, creditAmount: 0, description: 'Owner capital contribution' }
                ]
            }));
        } else {
            if (!cashOrBank || !ownerDrawings) {
                setError('Required accounts not found (Cash/Bank 1010 or Owner Drawings 3300). Check Chart of Accounts.');
                return;
            }
            // Dr Owner Drawings / Cr Cash (decreases) — the ONLY valid direction for cash going out
            setForm(prev => ({
                ...prev,
                description: 'Owner withdrawal / drawings',
                lines: [
                    { accountId: ownerDrawings.id, debitAmount: 0, creditAmount: 0, description: 'Owner drawings' },
                    { accountId: cashOrBank.id, debitAmount: 0, creditAmount: 0, description: 'Cash paid out' }
                ]
            }));
        }
        setActivePreset(preset);
        setPresetAmount(0);
        setError(null);
    };

    const clearPreset = () => {
        setActivePreset(null);
        setPresetAmount(0);
        setForm(prev => ({
            ...prev,
            description: '',
            lines: [
                { accountId: '', debitAmount: 0, creditAmount: 0, description: '' },
                { accountId: '', debitAmount: 0, creditAmount: 0, description: '' }
            ]
        }));
    };

    // When preset is active, derive debit/credit automatically from the single amount.
    // Capital investment: line[0]=Dr (Cash in), line[1]=Cr (Equity up)
    // Owner withdrawal:   line[0]=Dr (Drawings up), line[1]=Cr (Cash out)
    const handlePresetAmountChange = (amount: number) => {
        setPresetAmount(amount);
        setForm(prev => ({
            ...prev,
            lines: [
                { ...prev.lines[0], debitAmount: amount, creditAmount: 0 },
                { ...prev.lines[1], debitAmount: 0, creditAmount: amount }
            ]
        }));
    };

    const addLine = () => {
        setForm(prev => ({
            ...prev,
            lines: [...prev.lines, { accountId: '', debitAmount: 0, creditAmount: 0, description: '' }]
        }));
    };

    const removeLine = (index: number) => {
        if (form.lines.length <= 2) return;
        setForm(prev => ({
            ...prev,
            lines: prev.lines.filter((_, i) => i !== index)
        }));
    };

    const updateLine = (index: number, field: keyof JournalLine, value: string | number) => {
        setForm(prev => ({
            ...prev,
            lines: prev.lines.map((line, i) =>
                i === index ? { ...line, [field]: value } : line
            )
        }));
    };

    const totalDebits = form.lines.reduce((sum, line) => new Decimal(sum).plus(line.debitAmount || 0).toNumber(), 0);
    const totalCredits = form.lines.reduce((sum, line) => new Decimal(sum).plus(line.creditAmount || 0).toNumber(), 0);
    const isBalanced = Math.abs(totalDebits - totalCredits) < 0.01;

    const handleSubmit = () => {
        setError(null);

        // Validate
        if (!form.description.trim()) {
            setError('Description is required');
            return;
        }
        if (!isBalanced) {
            setError('Journal entry must be balanced (debits must equal credits)');
            return;
        }
        if (totalDebits === 0) {
            setError('Journal entry must have at least one debit and one credit');
            return;
        }

        // Filter out empty lines and prepare data
        const validLines = form.lines
            .filter(line => line.accountId && (line.debitAmount > 0 || line.creditAmount > 0))
            .map(line => ({
                accountId: line.accountId,
                debitAmount: line.debitAmount > 0 ? line.debitAmount : undefined,
                creditAmount: line.creditAmount > 0 ? line.creditAmount : undefined,
                description: line.description || undefined
            }));

        if (validLines.length < 2) {
            setError('Journal entry must have at least 2 lines');
            return;
        }

        createMutation.mutate({
            transactionDate: form.transactionDate,
            description: form.description,
            referenceNumber: form.referenceNumber || undefined,
            lines: validLines
        });
    };

    return (
        <AdaptivePage
            className="p-4 lg:p-6"
            title="Journal Entries"
            description="Post and reverse general-ledger journal entries"
            primaryActions={
                <button
                    type="button"
                    onClick={() => {
                        setShowCreateModal(true);
                        setError(null);
                    }}
                    className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 flex items-center space-x-2 shadow-sm min-h-[var(--layout-touch-target)]"
                >
                    <Plus className="h-4 w-4" />
                    <span>New Journal Entry</span>
                </button>
            }
            toolbar={
                <div className="bg-white rounded-lg shadow-sm border p-4" data-je-filters="true">
                    <AdaptiveToolbar
                        secondaryLabel="Filters"
                        secondary={
                            <div className="flex flex-col gap-3 min-w-[14rem] sm:flex-row sm:flex-wrap sm:items-end">
                                <div className="min-w-[160px]">
                                    <label className="block text-sm font-semibold text-gray-700 mb-2">From</label>
                                    <DatePicker
                                        value={dateFrom}
                                        onChange={(date) => setDateFrom(date)}
                                        placeholder="Select start date"
                                        maxDate={dateTo ? new Date(dateTo) : undefined}
                                    />
                                </div>
                                <div className="min-w-[160px]">
                                    <label className="block text-sm font-semibold text-gray-700 mb-2">To</label>
                                    <DatePicker
                                        value={dateTo}
                                        onChange={(date) => setDateTo(date)}
                                        placeholder="Select end date"
                                        minDate={dateFrom ? new Date(dateFrom) : undefined}
                                    />
                                </div>
                                <div className="min-w-[140px]">
                                    <label className="block text-sm font-semibold text-gray-700 mb-2">Status</label>
                                    <select
                                        value={statusFilter}
                                        onChange={(e) => setStatusFilter(e.target.value as '' | 'POSTED' | 'REVERSED')}
                                        className="w-full px-3 py-2.5 border rounded-lg focus:ring-2 focus:ring-blue-500"
                                        title="Status filter"
                                    >
                                        <option value="">All</option>
                                        <option value="POSTED">Posted</option>
                                        <option value="REVERSED">Reversed</option>
                                    </select>
                                </div>
                            </div>
                        }
                    >
                        <button
                            type="button"
                            onClick={() => refetch()}
                            className="px-4 py-2.5 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 flex items-center space-x-2 transition-colors min-h-[var(--layout-touch-target)]"
                        >
                            <Search className="h-4 w-4" />
                            <span>Refresh</span>
                        </button>
                    </AdaptiveToolbar>
                </div>
            }
        >
            {/* Entries List */}
            <div className="bg-white rounded-lg shadow-sm border">
                {entriesLoading ? (
                    <div className="flex justify-center py-12">
                        <RefreshCw className="h-8 w-8 text-gray-400 animate-spin" />
                    </div>
                ) : entries.length === 0 ? (
                    <div className="text-center py-12 text-gray-500">
                        <ClipboardCheck className="h-12 w-12 mx-auto mb-4 text-gray-300" />
                        <p>No journal entries found</p>
                    </div>
                ) : (
                    <ResponsiveTableWrapper>
                        <table className="w-full">
                            <thead className="bg-gray-50">
                                <tr>
                                    <th className="text-left px-6 py-3 text-sm font-medium text-gray-500">Date</th>
                                    <th className="text-left px-6 py-3 text-sm font-medium text-gray-500">Entry #</th>
                                    <th className="text-left px-6 py-3 text-sm font-medium text-gray-500">Description</th>
                                    <th className="text-right px-6 py-3 text-sm font-medium text-gray-500">Debits</th>
                                    <th className="text-right px-6 py-3 text-sm font-medium text-gray-500">Credits</th>
                                    <th className="text-center px-6 py-3 text-sm font-medium text-gray-500">Status</th>
                                    <th className="text-right px-6 py-3 text-sm font-medium text-gray-500">Actions</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y">
                                {entries.map((entry: JournalEntryListItem) => (
                                    <tr key={entry.id} className="hover:bg-gray-50">
                                        <td className="px-6 py-4">{entry.entryDate}</td>
                                        <td className="px-6 py-4 font-mono text-sm">{entry.entryNumber || entry.reference || '-'}</td>
                                        <td className="px-6 py-4">{entry.narration}</td>
                                        <td className="px-6 py-4 text-right">{formatCurrency(entry.totalDebit)}</td>
                                        <td className="px-6 py-4 text-right">{formatCurrency(entry.totalCredit)}</td>
                                        <td className="px-6 py-4 text-center">
                                            {entry.reference?.startsWith('REV-') ? (
                                                <span className="px-2 py-1 rounded text-xs font-medium bg-orange-100 text-orange-800">
                                                    REVERSAL
                                                </span>
                                            ) : (
                                                <span className={`px-2 py-1 rounded text-xs font-medium ${entry.status === 'POSTED' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
                                                    {entry.status}
                                                </span>
                                            )}
                                        </td>
                                        <td className="px-6 py-4 text-right">
                                            <div className="flex items-center justify-end space-x-2">
                                                <button
                                                    onClick={() => setSelectedEntry(entry.id)}
                                                    className="text-blue-600 hover:text-blue-700 text-sm font-medium"
                                                >
                                                    View
                                                </button>
                                                {entry.status === 'POSTED' && !entry.reference?.startsWith('REV-') && (
                                                    <button
                                                        onClick={() => {
                                                            setShowReverseModal(entry.id);
                                                            setError(null);
                                                        }}
                                                        className="text-red-600 hover:text-red-700 text-sm font-medium flex items-center space-x-1"
                                                    >
                                                        <RotateCcw className="h-3 w-3" />
                                                        <span>Reverse</span>
                                                    </button>
                                                )}
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </ResponsiveTableWrapper>
                )}
            </div>

            {/* Create Modal — guarded: ERP UI is locked while journal entry is being composed */}
            {showCreateModal && (
                <div
                    className="fixed inset-0 flex items-center justify-center p-4"
                    style={{ zIndex: createGuardRef.current?.panelZIndex ?? ZINDEX.PANEL }}
                    onClick={(e) => { if (e.target === e.currentTarget) setShowCreateModal(false); }}
                >
                    <div className="bg-white rounded-lg shadow-xl max-w-[95vw] sm:max-w-4xl w-full max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
                        <div className="px-6 py-4 border-b flex items-center justify-between">
                            <h2 className="text-xl font-semibold">New Journal Entry</h2>
                            <button
                                onClick={() => setShowCreateModal(false)}
                                className="text-gray-400 hover:text-gray-600"
                                title="Close"
                                aria-label="Close modal"
                            >
                                <X className="h-5 w-5" />
                            </button>
                        </div>
                        <div className="p-6">
                            {error && (
                                <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg flex items-center space-x-2 text-red-700">
                                    <AlertTriangle className="h-4 w-4" />
                                    <span>{error}</span>
                                </div>
                            )}

                            {/* Quick Presets */}
                            <div className="mb-5 p-3 bg-gray-50 rounded-lg border border-gray-200">
                                <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">Quick Presets</p>
                                <div className="flex flex-wrap gap-2">
                                    <button
                                        type="button"
                                        onClick={() => applyPreset('capital-investment')}
                                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md bg-green-50 text-green-700 border border-green-200 hover:bg-green-100 transition-colors"
                                    >
                                        <ArrowDownLeft className="h-3.5 w-3.5" />
                                        Capital Investment
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => applyPreset('owner-withdrawal')}
                                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md bg-amber-50 text-amber-700 border border-amber-200 hover:bg-amber-100 transition-colors"
                                    >
                                        <ArrowUpRight className="h-3.5 w-3.5" />
                                        Owner Withdrawal
                                    </button>
                                </div>
                            </div>

                            {/* Header Fields */}
                            <div className="grid grid-cols-3 gap-4 mb-6">
                                <div>
                                    <label className="block text-sm font-semibold text-gray-700 mb-2">📅 Transaction Date *</label>
                                    <DatePicker
                                        value={form.transactionDate}
                                        onChange={async (date) => {
                                            setForm(prev => ({ ...prev, transactionDate: date }));
                                            // Check if period is open
                                            const isOpen = await checkPeriodOpen(date);
                                            if (!isOpen) {
                                                setError(`Warning: Period for ${date} may be closed. Entry may fail.`);
                                            } else {
                                                setError(null);
                                            }
                                        }}
                                        placeholder="Select date"
                                        maxDate={new Date()}
                                    />
                                </div>
                                <div>
                                    <label htmlFor="jeRefNumber" className="block text-sm font-medium text-gray-700 mb-1">Reference Number</label>
                                    <input
                                        id="jeRefNumber"
                                        type="text"
                                        value={form.referenceNumber}
                                        onChange={(e) => setForm(prev => ({ ...prev, referenceNumber: e.target.value }))}
                                        placeholder="e.g., JE-001"
                                        className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
                                    />
                                </div>
                                <div>
                                    <label className="block text-sm font-medium text-gray-700 mb-1">Description *</label>
                                    <input
                                        type="text"
                                        value={form.description}
                                        onChange={(e) => setForm(prev => ({ ...prev, description: e.target.value }))}
                                        placeholder="Journal entry description"
                                        className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
                                    />
                                </div>
                            </div>

                            {/* Lines */}
                            <div className="mb-4">
                                <div className="flex items-center justify-between mb-2">
                                    <h3 className="font-medium">Journal Lines</h3>
                                    {!activePreset && (
                                        <button
                                            type="button"
                                            onClick={addLine}
                                            className="text-sm text-blue-600 hover:text-blue-700 flex items-center space-x-1"
                                        >
                                            <Plus className="h-4 w-4" />
                                            <span>Add Line</span>
                                        </button>
                                    )}
                                </div>

                                {/* SAP-grade preset mode: single Amount input, system controls Dr/Cr sides */}
                                {activePreset && (
                                    <div className="mb-3 p-3 bg-blue-50 border border-blue-200 rounded-lg">
                                        <div className="flex items-center justify-between mb-2">
                                            <span className="text-xs font-semibold text-blue-700 uppercase tracking-wide">
                                                Preset active — system controls debit/credit direction
                                            </span>
                                            <button
                                                type="button"
                                                onClick={clearPreset}
                                                className="text-xs text-blue-600 hover:text-blue-800 underline"
                                            >
                                                Clear preset (manual mode)
                                            </button>
                                        </div>
                                        <div className="flex items-center gap-3">
                                            <label className="text-sm font-medium text-blue-800 whitespace-nowrap">Amount *</label>
                                            <input
                                                type="number"
                                                value={presetAmount || ''}
                                                onChange={(e) => handlePresetAmountChange(parseFloat(e.target.value) || 0)}
                                                placeholder="Enter total amount"
                                                step="1"
                                                className="w-52 px-3 py-1.5 border border-blue-300 rounded-lg text-right focus:ring-2 focus:ring-blue-500 bg-white"
                                                autoFocus
                                            />
                                            <span className="text-sm text-blue-600">
                                                {activePreset === 'capital-investment'
                                                    ? '→ Dr Cash (in) / Cr Owner Capital'
                                                    : '→ Dr Owner Drawings / Cr Cash (out)'}
                                            </span>
                                        </div>
                                    </div>
                                )}

                                <ResponsiveTableWrapper>
                                    <table className="w-full text-sm">
                                        <thead className="bg-gray-50">
                                            <tr>
                                                <th className="text-left px-3 py-2">Account</th>
                                                <th className="text-left px-3 py-2">Description</th>
                                                {activePreset ? (
                                                    <>
                                                        <th className="text-center px-3 py-2 w-20">Side</th>
                                                        <th className="text-right px-3 py-2 w-32">Amount</th>
                                                    </>
                                                ) : (
                                                    <>
                                                        <th className="text-right px-3 py-2 w-32">Debit</th>
                                                        <th className="text-right px-3 py-2 w-32">Credit</th>
                                                    </>
                                                )}
                                                <th className="w-10"></th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {form.lines.map((line, idx) => {
                                                const acc = (accounts as Account[]).find(a => a.id === line.accountId);
                                                const isDebitLine = line.debitAmount > 0;
                                                return (
                                                    <tr key={idx} className="border-b">
                                                        <td className="px-3 py-2">
                                                            {activePreset ? (
                                                                <span className="px-2 py-1 text-sm font-medium text-gray-800">
                                                                    {acc ? `${acc.accountNumber} – ${acc.accountName}` : '—'}
                                                                </span>
                                                            ) : (
                                                                <select
                                                                    value={line.accountId}
                                                                    onChange={(e) => updateLine(idx, 'accountId', e.target.value)}
                                                                    className="w-full px-2 py-1 border rounded focus:ring-2 focus:ring-blue-500"
                                                                    title={`Select account for line ${idx + 1}`}
                                                                    aria-label={`Account for line ${idx + 1}`}
                                                                >
                                                                    <option value="">Select account...</option>
                                                                    {(accounts as Account[]).map((a) => (
                                                                        <option key={a.id} value={a.id}>
                                                                            {a.accountNumber} - {a.accountName}
                                                                        </option>
                                                                    ))}
                                                                </select>
                                                            )}
                                                        </td>
                                                        <td className="px-3 py-2">
                                                            <input
                                                                type="text"
                                                                value={line.description}
                                                                onChange={(e) => updateLine(idx, 'description', e.target.value)}
                                                                placeholder="Line description"
                                                                className="w-full px-2 py-1 border rounded focus:ring-2 focus:ring-blue-500"
                                                                readOnly={activePreset !== null && line.description !== ''}
                                                            />
                                                        </td>
                                                        {activePreset ? (
                                                            <>
                                                                <td className="px-3 py-2 text-center">
                                                                    <span className={`inline-block px-2 py-0.5 rounded text-xs font-bold ${isDebitLine ? 'bg-green-100 text-green-700' : 'bg-orange-100 text-orange-700'}`}>
                                                                        {isDebitLine ? 'DR' : 'CR'}
                                                                    </span>
                                                                </td>
                                                                <td className="px-3 py-2 text-right font-mono text-gray-700">
                                                                    {presetAmount > 0 ? formatCurrency(presetAmount) : '—'}
                                                                </td>
                                                            </>
                                                        ) : (
                                                            <>
                                                                <td className="px-3 py-2">
                                                                    <input
                                                                        type="number"
                                                                        value={line.debitAmount || ''}
                                                                        onChange={(e) => {
                                                                            updateLine(idx, 'debitAmount', parseFloat(e.target.value) || 0);
                                                                            if (parseFloat(e.target.value) > 0) updateLine(idx, 'creditAmount', 0);
                                                                        }}
                                                                        placeholder="0.00"
                                                                        step="1"
                                                                        className="w-full px-2 py-1 border rounded text-right focus:ring-2 focus:ring-blue-500"
                                                                    />
                                                                </td>
                                                                <td className="px-3 py-2">
                                                                    <input
                                                                        type="number"
                                                                        value={line.creditAmount || ''}
                                                                        onChange={(e) => {
                                                                            updateLine(idx, 'creditAmount', parseFloat(e.target.value) || 0);
                                                                            if (parseFloat(e.target.value) > 0) updateLine(idx, 'debitAmount', 0);
                                                                        }}
                                                                        placeholder="0.00"
                                                                        step="1"
                                                                        className="w-full px-2 py-1 border rounded text-right focus:ring-2 focus:ring-blue-500"
                                                                    />
                                                                </td>
                                                            </>
                                                        )}
                                                        <td className="px-3 py-2">
                                                            {!activePreset && form.lines.length > 2 && (
                                                                <button
                                                                    type="button"
                                                                    onClick={() => removeLine(idx)}
                                                                    className="text-red-400 hover:text-red-600"
                                                                    title="Remove line"
                                                                    aria-label={`Remove line ${idx + 1}`}
                                                                >
                                                                    <X className="h-4 w-4" />
                                                                </button>
                                                            )}
                                                        </td>
                                                    </tr>
                                                );
                                            })}
                                        </tbody>
                                        <tfoot className="bg-gray-50 font-semibold">
                                            <tr>
                                                <td colSpan={2} className="px-3 py-2 text-right">Totals:</td>
                                                <td className="px-3 py-2 text-right">{formatCurrency(totalDebits)}</td>
                                                <td className="px-3 py-2 text-right">{formatCurrency(totalCredits)}</td>
                                                <td></td>
                                            </tr>
                                            <tr>
                                                <td colSpan={2} className="px-3 py-2 text-right">Difference:</td>
                                                <td colSpan={2} className={`px-3 py-2 text-center ${isBalanced ? 'text-green-600' : 'text-red-600'}`}>
                                                    {isBalanced ? (
                                                        <span className="flex items-center justify-center space-x-1">
                                                            <CheckCircle className="h-4 w-4" />
                                                            <span>Balanced</span>
                                                        </span>
                                                    ) : (
                                                        formatCurrency(Math.abs(totalDebits - totalCredits))
                                                    )}
                                                </td>
                                                <td></td>
                                            </tr>
                                        </tfoot>
                                    </table>
                                </ResponsiveTableWrapper>
                            </div>

                            {/* Actions */}
                            <div className="flex justify-end space-x-3 pt-4 border-t">
                                <button
                                    onClick={() => setShowCreateModal(false)}
                                    className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={() => handleSubmitOnce()}
                                    disabled={createMutation.isPending || !isBalanced}
                                    className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center space-x-2"
                                >
                                    {createMutation.isPending ? (
                                        <RefreshCw className="h-4 w-4 animate-spin" />
                                    ) : (
                                        <CheckCircle className="h-4 w-4" />
                                    )}
                                    <span>Post Journal Entry</span>
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Reverse Modal — guarded: prevents re-reversal or context change during reversal */}
            {showReverseModal && (
                <div
                    className="fixed inset-0 flex items-center justify-center p-4"
                    style={{ zIndex: reverseGuardRef.current?.panelZIndex ?? ZINDEX.PANEL }}
                    onClick={(e) => { if (e.target === e.currentTarget) { setShowReverseModal(null); setReverseReason(''); } }}
                >
                    <div className="bg-white rounded-lg shadow-xl max-w-md w-full" onClick={(e) => e.stopPropagation()}>
                        <div className="px-6 py-4 border-b">
                            <h2 className="text-xl font-semibold">Reverse Journal Entry</h2>
                        </div>
                        <div className="p-6">
                            {error && (
                                <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg flex items-center space-x-2 text-red-700">
                                    <AlertTriangle className="h-4 w-4" />
                                    <span>{error}</span>
                                </div>
                            )}
                            <p className="text-gray-600 mb-4">
                                This will create a reversing entry. Please provide a reason for the reversal.
                            </p>
                            <textarea
                                value={reverseReason}
                                onChange={(e) => setReverseReason(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter' && !e.shiftKey && reverseReason.length >= 5 && !reverseMutation.isPending) {
                                        e.preventDefault();
                                        reverseMutation.mutate({ id: showReverseModal, reason: reverseReason });
                                    }
                                }}
                                placeholder="Reason for reversal (required, min 5 chars) - Press Enter to submit"
                                rows={3}
                                className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
                            />
                            <p className="text-xs text-gray-500 mt-1">Press Enter to submit, Shift+Enter for new line</p>
                            <div className="flex justify-end space-x-3 mt-4">
                                <button
                                    onClick={() => {
                                        setShowReverseModal(null);
                                        setReverseReason('');
                                    }}
                                    className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={() => handleReverseOnce()}
                                    disabled={reverseMutation.isPending || reverseReason.length < 5}
                                    className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 flex items-center space-x-2"
                                >
                                    {reverseMutation.isPending ? (
                                        <RefreshCw className="h-4 w-4 animate-spin" />
                                    ) : (
                                        <RotateCcw className="h-4 w-4" />
                                    )}
                                    <span>Reverse Entry</span>
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Detail Modal */}
            {selectedEntry && (
                <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setSelectedEntry(null)}>
                    <div className="bg-white rounded-lg shadow-xl max-w-[95vw] sm:max-w-3xl w-full max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
                        <div className="px-6 py-4 border-b flex items-center justify-between">
                            <h2 className="text-xl font-semibold">Journal Entry Details</h2>
                            <button
                                onClick={() => setSelectedEntry(null)}
                                className="text-gray-400 hover:text-gray-600"
                                title="Close"
                                aria-label="Close details modal"
                            >
                                <X className="h-5 w-5" />
                            </button>
                        </div>
                        {detailLoading ? (
                            <div className="flex justify-center py-12">
                                <RefreshCw className="h-8 w-8 text-gray-400 animate-spin" />
                            </div>
                        ) : detail ? (
                            <div className="p-6">
                                <div className="grid grid-cols-3 gap-4 mb-6">
                                    <div>
                                        <p className="text-sm text-gray-500">Date</p>
                                        <p className="font-medium">{detail.entryDate}</p>
                                    </div>
                                    <div>
                                        <p className="text-sm text-gray-500">Entry #</p>
                                        <p className="font-medium font-mono">{detail.entryNumber}</p>
                                        {detail.reference && (
                                            <p className="text-xs text-gray-500">Ref: {detail.reference}</p>
                                        )}
                                    </div>
                                    <div>
                                        <p className="text-sm text-gray-500">Status</p>
                                        {detail.reference?.startsWith('REV-') ? (
                                            <span className="px-2 py-1 rounded text-xs font-medium bg-orange-100 text-orange-800">
                                                REVERSAL
                                            </span>
                                        ) : (
                                            <span className={`px-2 py-1 rounded text-xs font-medium ${detail.status === 'POSTED' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
                                                {detail.status}
                                            </span>
                                        )}
                                    </div>
                                </div>
                                <div className="mb-6">
                                    <p className="text-sm text-gray-500">Description</p>
                                    <p className="font-medium">{detail.narration}</p>
                                </div>

                                <ResponsiveTableWrapper>
                                    <table className="w-full text-sm">
                                        <thead className="bg-gray-50">
                                            <tr>
                                                <th className="text-left px-4 py-2">Account</th>
                                                <th className="text-left px-4 py-2">Description</th>
                                                <th className="text-right px-4 py-2">Debit</th>
                                                <th className="text-right px-4 py-2">Credit</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y">
                                            {detail.lines?.map((line: JournalEntryDetailLine, idx: number) => (
                                                <tr key={idx}>
                                                    <td className="px-4 py-2">{line.accountCode} - {line.accountName}</td>
                                                    <td className="px-4 py-2">{line.description || '-'}</td>
                                                    <td className="px-4 py-2 text-right">{line.debitAmount ? formatCurrency(line.debitAmount) : '-'}</td>
                                                    <td className="px-4 py-2 text-right">{line.creditAmount ? formatCurrency(line.creditAmount) : '-'}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                        <tfoot className="bg-gray-50 font-semibold">
                                            <tr>
                                                <td colSpan={2} className="px-4 py-2 text-right">Totals:</td>
                                                <td className="px-4 py-2 text-right">{formatCurrency(detail.totalDebit)}</td>
                                                <td className="px-4 py-2 text-right">{formatCurrency(detail.totalCredit)}</td>
                                            </tr>
                                        </tfoot>
                                    </table>
                                </ResponsiveTableWrapper>
                            </div>
                        ) : null}
                    </div>
                </div>
            )}
        </AdaptivePage>
    );
}