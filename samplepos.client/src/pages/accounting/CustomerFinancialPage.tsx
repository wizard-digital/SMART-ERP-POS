/**
 * Customer Financial Management Page
 * 
 * Uses the existing C# CustomerFinancialController API to manage
 * customer deposits, credits, and account balances.
 */

import { useState, useEffect, useRef } from 'react';
import { useTransactionGuard, ZINDEX } from '../../hooks/useTransactionGuard';
import type { GuardHandle } from '../../hooks/useTransactionGuard';
import Decimal from 'decimal.js';
import { Plus, Search, CreditCard, DollarSign, Users, Loader } from 'lucide-react';
import {
    Button,
    Input,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogFooter,
    Label,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
    Badge,
    Textarea
} from '../../components/ui/temp-ui-components';
import { DatePicker } from '../../components/ui/date-picker';
import { formatCurrency } from '../../utils/currency';
import toast from 'react-hot-toast';
import { apiClient } from '../../utils/api';
import { accountingApi, customersApi } from '../../services/api';
import { formatTimestampDate } from '../../utils/businessDate';
import { useSubmitOnEnter } from '../../hooks/useSubmitOnEnter';

// Types based on existing C# API DTOs
interface CustomerAccount {
    id: string;
    customerId: string;
    customerName: string;
    totalDepositBalance: number;
    totalCreditBalance: number;
    availableDepositBalance: number;
    availableCreditBalance: number;
    // Debt/Receivables Management
    outstandingBalance: number;
    creditLimit: number;
    unlimitedCredit?: boolean;
    accountsReceivable: CustomerReceivable[];
    deposits: CustomerDeposit[];
    credits: CustomerCredit[];
}

// Customer debt/receivables tracking
interface CustomerReceivable {
    id: string;
    invoiceNumber?: string;
    amount: number;
    remainingAmount: number;
    dueDate: string;
    status: 'PENDING' | 'OVERDUE' | 'PAID';
    createdAt: string;
    description?: string;
    daysPastDue?: number;
}

interface CustomerDeposit {
    id: string;
    amount: number;
    remainingAmount: number;
    paymentMethod: string;
    reference?: string;
    createdAt: string;
}

interface CustomerCredit {
    id: string;
    amount: number;
    remainingAmount: number;
    creditType: string;
    reason?: string;
    createdAt: string;
}

interface Customer {
    id: string;
    name: string;
    email?: string;
    phone?: string;
    balance?: number;
    creditLimit?: number;
    unlimitedCredit?: boolean;
}

/** Raw deposit shape returned by the Node.js /deposits API */
interface DepositApiRow {
    id: string;
    amount: number;
    amountAvailable: number;
    paymentMethod: string;
    reference?: string;
    createdAt: string;
}

/** Axios-style error with optional response payload */
interface ApiError extends Error {
    response?: { data?: { error?: string } };
}

// Create deposit request
interface CreateDepositRequest {
    customerId: string;
    customerName: string;
    amount: number;
    paymentMethod: 'CASH' | 'CARD' | 'MOBILE_MONEY' | 'BANK_TRANSFER';
    reference?: string;
}

// Create credit request
interface CreateCreditRequest {
    customerId: string;
    customerName: string;
    amount: number;
    creditType: 'LOYALTY_POINTS' | 'REFUND' | 'PROMOTIONAL' | 'COMPENSATION';
    reason?: string;
}

// Create receivable/debt request
interface CreateReceivableRequest {
    customerId: string;
    customerName: string;
    amount: number;
    dueDate: string;
    description?: string;
    invoiceNumber?: string;
}

const CustomerFinancialPage = () => {
    const [customers, setCustomers] = useState<Customer[]>([]);
    const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
    const [customerAccount, setCustomerAccount] = useState<CustomerAccount | null>(null);
    const [loading, setLoading] = useState(false);
    const [accountLoading, setAccountLoading] = useState(false);
    const [searchTerm, setSearchTerm] = useState('');

    // Dialog states
    const [showDepositDialog, setShowDepositDialog] = useState(false);
    const [showCreditDialog, setShowCreditDialog] = useState(false);
    const [showReceivableDialog, setShowReceivableDialog] = useState(false);

    // ── Transaction Guard ──────────────────────────────────────────────────
    const { openGuard, closeGuard } = useTransactionGuard();
    const depositGuardRef = useRef<GuardHandle | null>(null);
    const creditGuardRef = useRef<GuardHandle | null>(null);
    const receivableGuardRef = useRef<GuardHandle | null>(null);

    useEffect(() => {
        if (showDepositDialog) {
            depositGuardRef.current = openGuard({ cancellable: false, label: 'Record customer deposit' });
            return () => { if (depositGuardRef.current) { closeGuard(depositGuardRef.current.id); depositGuardRef.current = null; } };
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [showDepositDialog]);

    useEffect(() => {
        if (showCreditDialog) {
            creditGuardRef.current = openGuard({ cancellable: false, label: 'Add customer credit' });
            return () => { if (creditGuardRef.current) { closeGuard(creditGuardRef.current.id); creditGuardRef.current = null; } };
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [showCreditDialog]);

    useEffect(() => {
        if (showReceivableDialog) {
            receivableGuardRef.current = openGuard({ cancellable: false, label: 'Record customer debt' });
            return () => { if (receivableGuardRef.current) { closeGuard(receivableGuardRef.current.id); receivableGuardRef.current = null; } };
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [showReceivableDialog]);

    // Form states
    const [depositForm, setDepositForm] = useState<CreateDepositRequest>({
        customerId: '',
        customerName: '',
        amount: 0,
        paymentMethod: 'CASH',
        reference: ''
    });

    const [creditForm, setCreditForm] = useState<CreateCreditRequest>({
        customerId: '',
        customerName: '',
        amount: 0,
        creditType: 'LOYALTY_POINTS',
        reason: ''
    });

    const [receivableForm, setReceivableForm] = useState<CreateReceivableRequest>({
        customerId: '',
        customerName: '',
        amount: 0,
        dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toLocaleDateString('en-CA'), // 30 days from now
        description: '',
        invoiceNumber: ''
    });

    useEffect(() => {
        loadCustomers();
    }, []);

    const loadCustomers = async () => {
        try {
            setLoading(true);
            // Load customers using the authenticated API client
            const response = await customersApi.list(1, 100); // Get more customers for selection
            if (response.success) {
                setCustomers((response.data || []) as unknown as Customer[]);
            } else {
                throw new Error(response.error || 'Failed to load customers');
            }
        } catch (error: unknown) {
            console.error('Error loading customers:', error);
            toast.error(`Failed to load customers: ${error instanceof Error ? error.message : 'Unknown error'}`);
            setCustomers([]);
        } finally {
            setLoading(false);
        }
    };

    const loadCustomerAccount = async (customer: Customer) => {
        try {
            setAccountLoading(true);

            // Load deposits from Node.js API (Single Source of Truth)
            let deposits: CustomerDeposit[] = [];
            let depositBalance = 0;
            try {
                const [depositsResponse, balanceResponse] = await Promise.all([
                    apiClient.get(`deposits`, { params: { customerId: customer.id } }),
                    apiClient.get(`deposits/customer/${customer.id}/balance`)
                ]);

                if (depositsResponse.data?.success && depositsResponse.data?.data?.deposits) {
                    deposits = depositsResponse.data.data.deposits.map((d: DepositApiRow) => ({
                        id: d.id,
                        amount: d.amount,
                        remainingAmount: d.amountAvailable,
                        paymentMethod: d.paymentMethod,
                        reference: d.reference,
                        createdAt: d.createdAt
                    }));
                }

                if (balanceResponse.data?.success && balanceResponse.data?.data) {
                    depositBalance = balanceResponse.data.data.availableBalance || 0;
                }
            } catch (depositError) {
                console.warn('Failed to load deposits from Node.js API:', depositError);
            }

            // Try C# CustomerFinancial API for credits (still C# owned)
            let credits: CustomerCredit[] = [];
            let creditBalance = 0;
            try {
                const response = await accountingApi.get(`/customer/${customer.id}?customerName=${encodeURIComponent(customer.name)}`);
                if (response.data.success && response.data.data) {
                    credits = response.data.data.credits || [];
                    creditBalance = response.data.data.availableCreditBalance || 0;
                }
            } catch {
                console.warn('C# Accounting API not available for credits');
            }

            // Build unified customer account from both sources
            const customerAccount: CustomerAccount = {
                id: customer.id,
                customerId: customer.id,
                customerName: customer.name,
                outstandingBalance: customer.balance || 0,
                creditLimit: customer.creditLimit || 0,
                unlimitedCredit: customer.unlimitedCredit === true,
                totalDepositBalance: deposits.reduce((sum, d) => new Decimal(sum).plus(d.amount).toNumber(), 0),
                totalCreditBalance: credits.reduce((sum, c) => new Decimal(sum).plus(c.amount).toNumber(), 0),
                availableDepositBalance: depositBalance,
                availableCreditBalance: creditBalance,
                accountsReceivable: [],
                deposits: deposits,
                credits: credits
            };

            setCustomerAccount(customerAccount);

        } catch (error: unknown) {
            console.error('Error loading customer account:', error);
            toast.error(`Failed to load customer account: ${error instanceof Error ? error.message : 'Unknown error'}`);
            setCustomerAccount(null);
        } finally {
            setAccountLoading(false);
        }
    };

    const handleSelectCustomer = (customer: Customer) => {
        setSelectedCustomer(customer);
        setDepositForm(prev => ({ ...prev, customerId: customer.id, customerName: customer.name }));
        setCreditForm(prev => ({ ...prev, customerId: customer.id, customerName: customer.name }));
        setReceivableForm(prev => ({ ...prev, customerId: customer.id, customerName: customer.name }));
        loadCustomerAccount(customer);
    };

    const handleCreateDeposit = async () => {
        try {
            if (!selectedCustomer || depositForm.amount <= 0) {
                toast.error('Please select a customer and enter a valid amount');
                return;
            }

            // Use Node.js API for deposits (Single Source of Truth)
            try {
                const response = await apiClient.post('deposits', {
                    customerId: depositForm.customerId,
                    amount: depositForm.amount,
                    paymentMethod: depositForm.paymentMethod,
                    reference: depositForm.reference || undefined
                });
                if (response.data.success) {
                    toast.success('Deposit recorded successfully');
                    setShowDepositDialog(false);
                    setDepositForm(prev => ({ ...prev, amount: 0, reference: '' }));
                    loadCustomerAccount(selectedCustomer);
                    return;
                } else {
                    throw new Error(response.data.error || 'Failed to create deposit');
                }
            } catch (err: unknown) {
                const apiError = err as ApiError;
                console.error('Failed to create deposit via Node.js API:', apiError);
                const errorMessage = apiError.response?.data?.error || apiError.message || 'Failed to create deposit';
                toast.error(`Failed to record deposit: ${errorMessage}`);
                return;
            }

        } catch (error: unknown) {
            console.error('Error creating deposit:', error);
            toast.error(`Failed to record deposit: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    };

    const handleCreateCredit = async () => {
        try {
            if (!selectedCustomer || creditForm.amount <= 0) {
                toast.error('Please select a customer and enter a valid amount');
                return;
            }

            try {
                const response = await accountingApi.post('/credits', creditForm);
                if (response.data.success) {
                    toast.success('Credit recorded successfully');
                    setShowCreditDialog(false);
                    setCreditForm(prev => ({ ...prev, amount: 0, reason: '' }));
                    loadCustomerAccount(selectedCustomer);
                    return;
                }
            } catch {
                console.warn('C# Accounting API not available for credits');
                toast.error('Credit recording requires the Accounting API to be running. Please contact administrator.');
                return;
            }

        } catch (error: unknown) {
            console.error('Error creating credit:', error);
            toast.error(`Failed to record credit: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    };

    const handleCreateReceivable = async () => {
        try {
            if (!selectedCustomer || receivableForm.amount <= 0) {
                toast.error('Please select a customer and enter a valid amount');
                return;
            }

            if (!receivableForm.dueDate) {
                toast.error('Please select a due date');
                return;
            }

            try {
                const response = await accountingApi.post('/receivables', receivableForm);
                if (response.data.success) {
                    toast.success('Customer debt recorded successfully');
                    setShowReceivableDialog(false);
                    setReceivableForm(prev => ({ ...prev, amount: 0, description: '', invoiceNumber: '' }));
                    loadCustomerAccount(selectedCustomer);
                    return;
                }
            } catch {
                console.warn('C# Accounting API not available for receivables');
                toast.error('Debt recording requires the Accounting API to be running. Please contact administrator.');
                return;
            }

        } catch (error: unknown) {
            console.error('Error creating receivable:', error);
            toast.error(`Failed to record debt: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    };

    const filteredCustomers = customers.filter(customer =>
        customer.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        customer.email?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        customer.phone?.includes(searchTerm)
    );

    const formatDate = (dateString: string) => {
        return new Date(dateString).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    };

    const getPaymentMethodBadge = (method: string) => {
        const colors = {
            'CASH': 'bg-green-100 text-green-800',
            'CARD': 'bg-blue-100 text-blue-800',
            'MOBILE_MONEY': 'bg-purple-100 text-purple-800',
            'BANK_TRANSFER': 'bg-indigo-100 text-indigo-800'
        };
        return colors[method as keyof typeof colors] || 'bg-gray-100 text-gray-800';
    };

    const getCreditTypeBadge = (type: string) => {
        const colors = {
            'LOYALTY_POINTS': 'bg-yellow-100 text-yellow-800',
            'REFUND': 'bg-red-100 text-red-800',
            'PROMOTIONAL': 'bg-green-100 text-green-800',
            'COMPENSATION': 'bg-orange-100 text-orange-800'
        };
        return colors[type as keyof typeof colors] || 'bg-gray-100 text-gray-800';
    };

    const getReceivableStatusBadge = (status: string) => {
        const colors = {
            'PENDING': 'bg-blue-100 text-blue-800',
            'OVERDUE': 'bg-red-100 text-red-800',
            'PAID': 'bg-green-100 text-green-800'
        };
        return colors[status as keyof typeof colors] || 'bg-gray-100 text-gray-800';
    };

    const calculateDaysPastDue = (dueDate: string): number => {
        const due = new Date(dueDate);
        const now = new Date();
        const diffTime = now.getTime() - due.getTime();
        return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    };

    useSubmitOnEnter(showDepositDialog, true, handleCreateDeposit);
    useSubmitOnEnter(showCreditDialog, true, handleCreateCredit);
    useSubmitOnEnter(showReceivableDialog, true, handleCreateReceivable);

    return (
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
            {/* Header */}
            <div className="mb-8">
                <h1 className="text-3xl font-bold text-gray-900 mb-2">Customer Financial Management</h1>
                <p className="text-gray-600">Manage customer deposits, credits, outstanding debts, and account balances</p>
                <div className="mt-4 p-4 bg-blue-50 border border-blue-200 rounded-lg">
                    <div className="flex items-start gap-3">
                        <div className="text-blue-600 mt-0.5">
                            <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 20 20">
                                <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
                            </svg>
                        </div>
                        <div>
                            <h3 className="font-medium text-blue-900">Comprehensive Customer Account Management</h3>
                            <div className="mt-2 text-sm text-blue-800 space-y-1">
                                <div>• <strong>Outstanding Debts:</strong> Track what customers owe (accounts receivable)</div>
                                <div>• <strong>Credit Limits:</strong> Monitor customer credit usage and limits</div>
                                <div>• <strong>Deposits:</strong> Manage customer prepayments and deposits</div>
                                <div>• <strong>Store Credits:</strong> Handle refunds, loyalty points, and promotional credits</div>
                                <div>• <strong>Aging Reports:</strong> View overdue accounts and payment history</div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                {/* Customer Selection */}
                <div>
                    <Card>
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2">
                                <Users className="h-5 w-5" />
                                Select Customer
                            </CardTitle>
                            <CardDescription>Choose a customer to view and manage their financial account</CardDescription>
                        </CardHeader>
                        <CardContent>
                            {/* Search */}
                            <div className="relative mb-4">
                                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 h-4 w-4" />
                                <Input
                                    type="text"
                                    placeholder="Search customers..."
                                    value={searchTerm}
                                    onChange={(e) => setSearchTerm(e.target.value)}
                                    className="pl-10"
                                />
                            </div>

                            {/* Customer List */}
                            <div className="space-y-2 max-h-96 overflow-y-auto">
                                {loading ? (
                                    <div className="flex items-center justify-center py-8">
                                        <Loader className="h-8 w-8 animate-spin text-gray-400" />
                                    </div>
                                ) : filteredCustomers.length === 0 ? (
                                    <p className="text-gray-500 text-center py-8">No customers found</p>
                                ) : (
                                    filteredCustomers.map((customer) => (
                                        <div
                                            key={customer.id}
                                            onClick={() => handleSelectCustomer(customer)}
                                            className={`p-3 rounded-lg border cursor-pointer transition-colors ${selectedCustomer?.id === customer.id
                                                ? 'border-orange-300 bg-orange-50'
                                                : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                                                }`}
                                        >
                                            <div className="flex items-center justify-between">
                                                <div className="font-medium text-gray-900">{customer.name}</div>
                                                {/* Show balance indicator if customer has debt/balance */}
                                                {customer.balance && customer.balance > 0 && (
                                                    <Badge variant="outline" className="text-xs bg-red-50 text-red-700 border-red-200">
                                                        {formatCurrency(customer.balance)}
                                                    </Badge>
                                                )}
                                            </div>
                                            <div className="text-sm text-gray-500">
                                                {customer.email && <span>{customer.email}</span>}
                                                {customer.phone && <span className="ml-2">{customer.phone}</span>}
                                                {/* Credit limit indicator */}
                                                {customer.unlimitedCredit ? (
                                                    <div className="mt-1 text-xs text-indigo-600">
                                                        Credit Limit: Unlimited
                                                    </div>
                                                ) : customer.creditLimit && customer.creditLimit > 0 ? (
                                                    <div className="mt-1 text-xs text-blue-600">
                                                        Credit Limit: {formatCurrency(customer.creditLimit)}
                                                    </div>
                                                ) : null}
                                            </div>
                                        </div>
                                    ))
                                )}
                            </div>
                        </CardContent>
                    </Card>
                </div>

                {/* Customer Account Details */}
                <div>
                    {selectedCustomer ? (
                        <Card>
                            <CardHeader>
                                <CardTitle className="flex items-center gap-2">
                                    <DollarSign className="h-5 w-5" />
                                    {selectedCustomer.name} - Account Summary
                                </CardTitle>
                                <div className="flex gap-2">
                                    <Button size="sm" className="flex items-center gap-2" onClick={() => setShowDepositDialog(true)}>
                                        <Plus className="h-4 w-4" />
                                        Record Deposit
                                    </Button>
                                    <Dialog open={showDepositDialog} onOpenChange={setShowDepositDialog} zIndex={depositGuardRef.current?.panelZIndex ?? ZINDEX.PANEL}>
                                        <DialogContent>
                                            <DialogHeader>
                                                <DialogTitle>Record Customer Deposit</DialogTitle>
                                                <DialogDescription>
                                                    Add a new deposit for {selectedCustomer.name}
                                                </DialogDescription>
                                            </DialogHeader>
                                            <div className="space-y-4">
                                                <div>
                                                    <Label htmlFor="deposit-amount">Amount</Label>
                                                    <Input
                                                        id="deposit-amount"
                                                        type="number"
                                                        value={(depositForm.amount || 0).toString()}
                                                        onChange={(e) => setDepositForm(prev => ({
                                                            ...prev,
                                                            amount: parseFloat(e.target.value) || 0
                                                        }))}
                                                        placeholder="0.00"
                                                        step="1"
                                                    />
                                                </div>
                                                <div>
                                                    <Label htmlFor="payment-method">Payment Method</Label>
                                                    <Select
                                                        value={depositForm.paymentMethod}
                                                        onValueChange={(value) =>
                                                            setDepositForm(prev => ({ ...prev, paymentMethod: value as 'CASH' | 'CARD' | 'MOBILE_MONEY' | 'BANK_TRANSFER' }))
                                                        }
                                                    >
                                                        <SelectTrigger>
                                                            <SelectValue />
                                                        </SelectTrigger>
                                                        <SelectContent>
                                                            <SelectItem value="CASH">Cash</SelectItem>
                                                            <SelectItem value="CARD">Card</SelectItem>
                                                            <SelectItem value="MOBILE_MONEY">Mobile Money</SelectItem>
                                                            <SelectItem value="BANK_TRANSFER">Bank Transfer</SelectItem>
                                                        </SelectContent>
                                                    </Select>
                                                </div>
                                                <div>
                                                    <Label htmlFor="reference">Reference (Optional)</Label>
                                                    <Input
                                                        id="reference"
                                                        value={depositForm.reference || ''}
                                                        onChange={(e) => setDepositForm(prev => ({ ...prev, reference: e.target.value }))}
                                                        placeholder="Transaction reference or note"
                                                    />
                                                </div>
                                            </div>
                                            <DialogFooter>
                                                <Button variant="outline" onClick={() => setShowDepositDialog(false)}>
                                                    Cancel
                                                </Button>
                                                <Button onClick={handleCreateDeposit}>
                                                    Record Deposit
                                                </Button>
                                            </DialogFooter>
                                        </DialogContent>
                                    </Dialog>

                                    <Button variant="outline" size="sm" className="flex items-center gap-2" onClick={() => setShowCreditDialog(true)}>
                                        <CreditCard className="h-4 w-4" />
                                        Add Credit
                                    </Button>
                                    <Dialog open={showCreditDialog} onOpenChange={setShowCreditDialog} zIndex={creditGuardRef.current?.panelZIndex ?? ZINDEX.PANEL}>
                                        <DialogContent>
                                            <DialogHeader>
                                                <DialogTitle>Add Customer Credit</DialogTitle>
                                                <DialogDescription>
                                                    Add store credit for {selectedCustomer.name}
                                                </DialogDescription>
                                            </DialogHeader>
                                            <div className="space-y-4">
                                                <div>
                                                    <Label htmlFor="credit-amount">Amount</Label>
                                                    <Input
                                                        id="credit-amount"
                                                        type="number"
                                                        value={(creditForm.amount || 0).toString()}
                                                        onChange={(e) => setCreditForm(prev => ({
                                                            ...prev,
                                                            amount: parseFloat(e.target.value) || 0
                                                        }))}
                                                        placeholder="0.00"
                                                        step="1"
                                                    />
                                                </div>
                                                <div>
                                                    <Label htmlFor="credit-type">Credit Type</Label>
                                                    <Select
                                                        value={creditForm.creditType}
                                                        onValueChange={(value) =>
                                                            setCreditForm(prev => ({ ...prev, creditType: value as 'LOYALTY_POINTS' | 'REFUND' | 'PROMOTIONAL' | 'COMPENSATION' }))
                                                        }
                                                    >
                                                        <SelectTrigger>
                                                            <SelectValue />
                                                        </SelectTrigger>
                                                        <SelectContent>
                                                            <SelectItem value="LOYALTY_POINTS">Loyalty Points</SelectItem>
                                                            <SelectItem value="REFUND">Refund</SelectItem>
                                                            <SelectItem value="PROMOTIONAL">Promotional</SelectItem>
                                                            <SelectItem value="COMPENSATION">Compensation</SelectItem>
                                                        </SelectContent>
                                                    </Select>
                                                </div>
                                                <div>
                                                    <Label htmlFor="credit-reason">Reason (Optional)</Label>
                                                    <Textarea
                                                        id="credit-reason"
                                                        value={creditForm.reason || ''}
                                                        onChange={(e) => setCreditForm(prev => ({ ...prev, reason: e.target.value }))}
                                                        placeholder="Reason for credit"
                                                        rows={3}
                                                    />
                                                </div>
                                            </div>
                                            <DialogFooter>
                                                <Button variant="outline" onClick={() => setShowCreditDialog(false)}>
                                                    Cancel
                                                </Button>
                                                <Button onClick={handleCreateCredit}>
                                                    Add Credit
                                                </Button>
                                            </DialogFooter>
                                        </DialogContent>
                                    </Dialog>

                                    <Button variant="outline" size="sm" className="flex items-center gap-2" onClick={() => setShowReceivableDialog(true)}>
                                        <Plus className="h-4 w-4" />
                                        Record Debt
                                    </Button>
                                    <Dialog open={showReceivableDialog} onOpenChange={setShowReceivableDialog} zIndex={receivableGuardRef.current?.panelZIndex ?? ZINDEX.PANEL}>
                                        <DialogContent>
                                            <DialogHeader>
                                                <DialogTitle>Record Customer Debt</DialogTitle>
                                                <DialogDescription>
                                                    Add outstanding debt/receivable for {selectedCustomer.name}
                                                </DialogDescription>
                                            </DialogHeader>
                                            <div className="space-y-4">
                                                <div>
                                                    <Label htmlFor="receivable-amount">Amount Owed</Label>
                                                    <Input
                                                        id="receivable-amount"
                                                        type="number"
                                                        value={(receivableForm.amount || 0).toString()}
                                                        onChange={(e) => setReceivableForm(prev => ({
                                                            ...prev,
                                                            amount: parseFloat(e.target.value) || 0
                                                        }))}
                                                        placeholder="0.00"
                                                        step="1"
                                                    />
                                                </div>
                                                <div>
                                                    <Label htmlFor="receivable-due-date">Due Date</Label>
                                                    <DatePicker
                                                        value={receivableForm.dueDate}
                                                        onChange={(date) => setReceivableForm(prev => ({ ...prev, dueDate: date }))}
                                                        placeholder="Select due date"
                                                        minDate={new Date()}
                                                    />
                                                </div>
                                                <div>
                                                    <Label htmlFor="receivable-invoice">Invoice Number (Optional)</Label>
                                                    <Input
                                                        id="receivable-invoice"
                                                        value={receivableForm.invoiceNumber || ''}
                                                        onChange={(e) => setReceivableForm(prev => ({ ...prev, invoiceNumber: e.target.value }))}
                                                        placeholder="INV-001"
                                                    />
                                                </div>
                                                <div>
                                                    <Label htmlFor="receivable-description">Description (Optional)</Label>
                                                    <Textarea
                                                        id="receivable-description"
                                                        value={receivableForm.description || ''}
                                                        onChange={(e) => setReceivableForm(prev => ({ ...prev, description: e.target.value }))}
                                                        placeholder="Description of the debt or service"
                                                        rows={3}
                                                    />
                                                </div>
                                            </div>
                                            <DialogFooter>
                                                <Button variant="outline" onClick={() => setShowReceivableDialog(false)}>
                                                    Cancel
                                                </Button>
                                                <Button onClick={handleCreateReceivable}>
                                                    Record Debt
                                                </Button>
                                            </DialogFooter>
                                        </DialogContent>
                                    </Dialog>
                                </div>
                            </CardHeader>
                            <CardContent>
                                {accountLoading ? (
                                    <div className="flex items-center justify-center py-8">
                                        <Loader className="h-8 w-8 animate-spin text-gray-400" />
                                    </div>
                                ) : customerAccount ? (
                                    <div className="space-y-6">
                                        {/* Balance Summary */}
                                        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                                            <div className="bg-red-50 p-4 rounded-lg">
                                                <div className="text-sm text-red-600 font-medium">Outstanding Debt</div>
                                                <div className="text-2xl font-bold text-red-900">
                                                    {formatCurrency(customerAccount.outstandingBalance || 0)}
                                                </div>
                                                <div className="text-sm text-red-600">
                                                    Amount owed by customer
                                                </div>
                                            </div>
                                            <div className="bg-blue-50 p-4 rounded-lg">
                                                <div className="text-sm text-blue-600 font-medium">Credit Limit</div>
                                                <div className="text-2xl font-bold text-blue-900">
                                                    {customerAccount.unlimitedCredit
                                                        ? 'Unlimited'
                                                        : formatCurrency(customerAccount.creditLimit || 0)}
                                                </div>
                                                <div className="text-sm text-blue-600">
                                                    {customerAccount.unlimitedCredit
                                                        ? 'No hard AR ceiling'
                                                        : customerAccount.creditLimit && customerAccount.outstandingBalance
                                                        ? `${Math.round((customerAccount.outstandingBalance / customerAccount.creditLimit) * 100)}% used`
                                                        : 'Available credit'}
                                                </div>
                                            </div>
                                            <div className="bg-green-50 p-4 rounded-lg">
                                                <div className="text-sm text-green-600 font-medium">Total Deposits</div>
                                                <div className="text-2xl font-bold text-green-900">
                                                    {formatCurrency(customerAccount.totalDepositBalance)}
                                                </div>
                                                <div className="text-sm text-green-600">
                                                    Available: {formatCurrency(customerAccount.availableDepositBalance)}
                                                </div>
                                            </div>
                                            <div className="bg-purple-50 p-4 rounded-lg">
                                                <div className="text-sm text-purple-600 font-medium">Total Credits</div>
                                                <div className="text-2xl font-bold text-purple-900">
                                                    {formatCurrency(customerAccount.totalCreditBalance)}
                                                </div>
                                                <div className="text-sm text-purple-600">
                                                    Available: {formatCurrency(customerAccount.availableCreditBalance)}
                                                </div>
                                            </div>
                                        </div>

                                        {/* Accounts Receivable */}
                                        {customerAccount.accountsReceivable && customerAccount.accountsReceivable.length > 0 && (
                                            <div>
                                                <h3 className="text-lg font-medium text-gray-900 mb-3">Outstanding Debts/Receivables</h3>
                                                <div className="space-y-2">
                                                    {customerAccount.accountsReceivable.slice(0, 10).map((receivable) => {
                                                        const daysPastDue = calculateDaysPastDue(receivable.dueDate);
                                                        const isOverdue = daysPastDue > 0;
                                                        return (
                                                            <div key={receivable.id} className={`flex items-center justify-between p-3 rounded-lg ${isOverdue ? 'bg-red-50 border border-red-200' : 'bg-gray-50'
                                                                }`}>
                                                                <div>
                                                                    <div className="font-medium">{formatCurrency(receivable.amount)}</div>
                                                                    <div className="text-sm text-gray-500">
                                                                        Due: {formatTimestampDate(receivable.dueDate)}
                                                                        {isOverdue && <span className="text-red-600 ml-2">({daysPastDue} days overdue)</span>}
                                                                    </div>
                                                                    {receivable.invoiceNumber && (
                                                                        <div className="text-sm text-gray-500">Invoice: {receivable.invoiceNumber}</div>
                                                                    )}
                                                                    {receivable.description && (
                                                                        <div className="text-sm text-gray-500">{receivable.description}</div>
                                                                    )}
                                                                </div>
                                                                <div className="text-right">
                                                                    <Badge className={getReceivableStatusBadge(receivable.status)}>
                                                                        {receivable.status}
                                                                    </Badge>
                                                                    <div className="text-sm text-gray-500 mt-1">
                                                                        Remaining: {formatCurrency(receivable.remainingAmount)}
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            </div>
                                        )}

                                        {/* Recent Deposits */}
                                        {customerAccount.deposits && customerAccount.deposits.length > 0 && (
                                            <div>
                                                <h3 className="text-lg font-medium text-gray-900 mb-3">Recent Deposits</h3>
                                                <div className="space-y-2">
                                                    {customerAccount.deposits.slice(0, 5).map((deposit) => (
                                                        <div key={deposit.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                                                            <div>
                                                                <div className="font-medium">{formatCurrency(deposit.amount)}</div>
                                                                <div className="text-sm text-gray-500">{formatDate(deposit.createdAt)}</div>
                                                                {deposit.reference && (
                                                                    <div className="text-sm text-gray-500">Ref: {deposit.reference}</div>
                                                                )}
                                                            </div>
                                                            <div className="text-right">
                                                                <Badge className={getPaymentMethodBadge(deposit.paymentMethod)}>
                                                                    {deposit.paymentMethod.replace('_', ' ')}
                                                                </Badge>
                                                                <div className="text-sm text-gray-500 mt-1">
                                                                    Remaining: {formatCurrency(deposit.remainingAmount)}
                                                                </div>
                                                            </div>
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        )}

                                        {/* Recent Credits */}
                                        {customerAccount.credits && customerAccount.credits.length > 0 && (
                                            <div>
                                                <h3 className="text-lg font-medium text-gray-900 mb-3">Recent Credits</h3>
                                                <div className="space-y-2">
                                                    {customerAccount.credits.slice(0, 5).map((credit) => (
                                                        <div key={credit.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                                                            <div>
                                                                <div className="font-medium">{formatCurrency(credit.amount)}</div>
                                                                <div className="text-sm text-gray-500">{formatDate(credit.createdAt)}</div>
                                                                {credit.reason && (
                                                                    <div className="text-sm text-gray-500">{credit.reason}</div>
                                                                )}
                                                            </div>
                                                            <div className="text-right">
                                                                <Badge className={getCreditTypeBadge(credit.creditType)}>
                                                                    {credit.creditType.replace('_', ' ')}
                                                                </Badge>
                                                                <div className="text-sm text-gray-500 mt-1">
                                                                    Remaining: {formatCurrency(credit.remainingAmount)}
                                                                </div>
                                                            </div>
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                ) : (
                                    <p className="text-gray-500 text-center py-8">Select a customer to view account details</p>
                                )}
                            </CardContent>
                        </Card>
                    ) : (
                        <Card>
                            <CardContent className="py-8">
                                <p className="text-gray-500 text-center">Select a customer to view account details</p>
                            </CardContent>
                        </Card>
                    )}
                </div>
            </div>
        </div>
    );
};

export default CustomerFinancialPage;