/**
 * Invoice Ledger Integration Page
 * 
 * Uses the existing C# LedgerController to record invoice transactions
 * and integrate with the accounting system when sales are finalized.
 */

import { useState, useEffect } from 'react';
import { Plus, Search, FileText, DollarSign, Loader, AlertCircle } from 'lucide-react';
import { Button } from '../../components/ui/temp-ui-components';
import { Input } from '../../components/ui/temp-ui-components';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '../../components/ui/temp-ui-components';
import { Label } from '../../components/ui/temp-ui-components';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/temp-ui-components';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/temp-ui-components';
import { Badge } from '../../components/ui/temp-ui-components';
import { Textarea } from '../../components/ui/temp-ui-components';
import { DatePicker } from '../../components/ui/date-picker';
import { formatCurrency } from '../../utils/currency';
import toast from 'react-hot-toast';
import { accountingApi } from '../../services/api';
import { api } from '../../utils/api';

// Types for integration with existing systems
interface Sale {
    id: string;
    saleNumber: string;
    customerId?: string;
    customerName?: string;
    totalAmount: number;
    totalCost: number;
    profit: number;
    saleDate: string;
    paymentMethod: 'CASH' | 'CARD' | 'MOBILE_MONEY' | 'CREDIT';
    status: 'COMPLETED' | 'PENDING' | 'CANCELLED';
    createdAt: string;
}

interface Customer {
    id: string;
    name: string;
    email?: string;
    phone?: string;
}

interface Product {
    id: string;
    name: string;
    cost: number;
    price: number;
    barcode?: string;
}

// Ledger integration types (based on C# API)
interface InvoiceLedgerRequest {
    saleId: string;
    customerId?: string;
    totalAmount: number;
    items: InvoiceLedgerItem[];
    paymentMethod: string;
    saleDate: string;
    description?: string;
}

interface InvoiceLedgerItem {
    productId: string;
    productName: string;
    quantity: number;
    unitPrice: number;
    totalAmount: number;
    costOfGoods: number;
}

interface PaymentLedgerRequest {
    saleId: string;
    customerId?: string;
    paymentAmount: number;
    paymentMethod: string;
    paymentDate: string;
    reference?: string;
    description?: string;
}

interface LedgerTransaction {
    id: string;
    transactionId: string;
    description: string;
    totalAmount: number;
    createdAt: string;
    status: string;
    saleId?: string;
    customerId?: string;
}

const InvoiceLedgerIntegrationPage = () => {
    const [sales, setSales] = useState<Sale[]>([]);
    const [, setCustomers] = useState<Customer[]>([]);
    const [, setProducts] = useState<Product[]>([]);
    const [transactions, setTransactions] = useState<LedgerTransaction[]>([]);
    const [loading, setLoading] = useState(true);
    const [searchTerm, setSearchTerm] = useState('');
    const [selectedSale, setSelectedSale] = useState<Sale | null>(null);

    // Dialog states
    const [showIntegrateDialog, setShowIntegrateDialog] = useState(false);
    const [showPaymentDialog, setShowPaymentDialog] = useState(false);
    const [integrating, setIntegrating] = useState(false);

    // Form states
    const [integrationForm, setIntegrationForm] = useState<{
        description: string;
        items: InvoiceLedgerItem[];
    }>({
        description: '',
        items: []
    });

    const [paymentForm, setPaymentForm] = useState<PaymentLedgerRequest>({
        saleId: '',
        customerId: '',
        paymentAmount: 0,
        paymentMethod: 'CASH',
        paymentDate: new Date().toLocaleDateString('en-CA'),
        reference: '',
        description: ''
    });

    useEffect(() => {
        loadInitialData();
    }, []);

    const loadInitialData = async () => {
        try {
            setLoading(true);
            await Promise.all([
                loadSales(),
                loadCustomers(),
                loadProducts(),
                loadRecentTransactions()
            ]);
        } finally {
            setLoading(false);
        }
    };

    const loadSales = async () => {
        try {
            const response = await api.sales.list();
            if (response.data.success) {
                setSales((response.data.data || []) as Sale[]);
            }
        } catch (error: unknown) {
            console.error('Error loading sales:', error);
            toast.error(`Failed to load sales: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    };

    const loadCustomers = async () => {
        try {
            const response = await api.customers.list({ page: 1, limit: 5000 });
            if (response.data.success) {
                setCustomers((response.data.data || []) as Customer[]);
            }
        } catch (error: unknown) {
            console.error('Error loading customers:', error);
        }
    };

    const loadProducts = async () => {
        try {
            const response = await api.products.list();
            if (response.data.success) {
                setProducts((response.data.data || []) as Product[]);
            }
        } catch (error: unknown) {
            console.error('Error loading products:', error);
        }
    };

    const loadRecentTransactions = async () => {
        try {
            // This would need to be implemented in the C# API
            // For now, we'll show empty state
            setTransactions([]);
        } catch (error: unknown) {
            console.error('Error loading transactions:', error);
        }
    };

    const handleIntegrateInvoice = async () => {
        if (!selectedSale) return;

        try {
            setIntegrating(true);

            // Prepare invoice data for C# Ledger API
            const invoiceData: InvoiceLedgerRequest = {
                saleId: selectedSale.id,
                customerId: selectedSale.customerId,
                totalAmount: selectedSale.totalAmount,
                items: integrationForm.items,
                paymentMethod: selectedSale.paymentMethod,
                saleDate: selectedSale.saleDate,
                description: integrationForm.description || `Invoice integration for sale ${selectedSale.saleNumber}`
            };

            // Call C# Ledger API to record invoice
            const response = await accountingApi.post('/ledger/invoice', invoiceData);

            if (response.data.success) {
                toast.success('Invoice integrated with accounting system successfully');
                setShowIntegrateDialog(false);
                loadRecentTransactions();

                // Update sale status if needed
                loadSales();
            } else {
                throw new Error(response.data.error || 'Failed to integrate invoice');
            }
        } catch (error: unknown) {
            console.error('Error integrating invoice:', error);
            toast.error(`Failed to integrate invoice: ${error instanceof Error ? error.message : 'Unknown error'}`);
        } finally {
            setIntegrating(false);
        }
    };

    const handleRecordPayment = async () => {
        if (!selectedSale) return;

        try {
            // Call C# Ledger API to record payment
            const response = await accountingApi.post('/ledger/payment', paymentForm);

            if (response.data.success) {
                toast.success('Payment recorded in accounting system successfully');
                setShowPaymentDialog(false);
                setPaymentForm(prev => ({ ...prev, paymentAmount: 0, reference: '', description: '' }));
                loadRecentTransactions();
            } else {
                throw new Error(response.data.error || 'Failed to record payment');
            }
        } catch (error: unknown) {
            console.error('Error recording payment:', error);
            toast.error(`Failed to record payment: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    };

    const handleSelectSale = (sale: Sale) => {
        setSelectedSale(sale);

        // Pre-populate integration form
        setIntegrationForm({
            description: `Invoice for sale ${sale.saleNumber}`,
            items: [] // Would need to load sale items
        });

        // Pre-populate payment form
        setPaymentForm(prev => ({
            ...prev,
            saleId: sale.id,
            customerId: sale.customerId || '',
            paymentAmount: sale.totalAmount,
            paymentMethod: sale.paymentMethod,
            paymentDate: sale.saleDate,
            description: `Payment for sale ${sale.saleNumber}`
        }));
    };

    const getStatusBadge = (status: string) => {
        const colors = {
            'COMPLETED': 'bg-green-100 text-green-800',
            'PENDING': 'bg-yellow-100 text-yellow-800',
            'CANCELLED': 'bg-red-100 text-red-800'
        };
        return colors[status as keyof typeof colors] || 'bg-gray-100 text-gray-800';
    };

    const getPaymentMethodBadge = (method: string) => {
        const colors = {
            'CASH': 'bg-green-100 text-green-800',
            'CARD': 'bg-blue-100 text-blue-800',
            'MOBILE_MONEY': 'bg-purple-100 text-purple-800',
            'CREDIT': 'bg-orange-100 text-orange-800'
        };
        return colors[method as keyof typeof colors] || 'bg-gray-100 text-gray-800';
    };

    const filteredSales = sales.filter(sale =>
        sale.saleNumber.toLowerCase().includes(searchTerm.toLowerCase()) ||
        sale.customerName?.toLowerCase().includes(searchTerm.toLowerCase())
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

    return (
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
            {/* Header */}
            <div className="mb-8">
                <h1 className="text-3xl font-bold text-gray-900 mb-2">Invoice Ledger Integration</h1>
                <p className="text-gray-600">Integrate sales invoices with the accounting ledger system</p>
            </div>

            {/* Stats */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-6 mb-8">
                <Card>
                    <CardContent className="pt-6">
                        <div className="flex items-center">
                            <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium text-gray-600">Total Sales</p>
                                <p className="text-base sm:text-2xl font-bold text-gray-900">{sales.length}</p>
                            </div>
                            <FileText className="h-8 w-8 text-gray-400 flex-shrink-0" />
                        </div>
                    </CardContent>
                </Card>

                <Card>
                    <CardContent className="pt-6">
                        <div className="flex items-center">
                            <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium text-gray-600">Completed Sales</p>
                                <p className="text-base sm:text-2xl font-bold text-green-900">
                                    {sales.filter(s => s.status === 'COMPLETED').length}
                                </p>
                            </div>
                            <DollarSign className="h-8 w-8 text-green-400 flex-shrink-0" />
                        </div>
                    </CardContent>
                </Card>

                <Card>
                    <CardContent className="pt-6">
                        <div className="flex items-center">
                            <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium text-gray-600">Total Revenue</p>
                                <p className="text-base sm:text-2xl font-bold text-blue-900">
                                    {formatCurrency(sales.reduce((sum, sale) => sum + (sale.status === 'COMPLETED' ? sale.totalAmount : 0), 0))}
                                </p>
                            </div>
                            <DollarSign className="h-8 w-8 text-blue-400 flex-shrink-0" />
                        </div>
                    </CardContent>
                </Card>

                <Card>
                    <CardContent className="pt-6">
                        <div className="flex items-center">
                            <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium text-gray-600">Ledger Transactions</p>
                                <p className="text-base sm:text-2xl font-bold text-purple-900">{transactions.length}</p>
                            </div>
                            <FileText className="h-8 w-8 text-purple-400 flex-shrink-0" />
                        </div>
                    </CardContent>
                </Card>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                {/* Sales List */}
                <div className="lg:col-span-2">
                    <Card>
                        <CardHeader>
                            <div className="flex items-center justify-between">
                                <CardTitle>Sales & Invoices</CardTitle>
                                <div className="flex items-center gap-2">
                                    {selectedSale && (
                                        <>
                                            <Dialog open={showIntegrateDialog} onOpenChange={setShowIntegrateDialog}>
                                                <DialogTrigger asChild>
                                                    <Button size="sm" className="flex items-center gap-2">
                                                        <Plus className="h-4 w-4" />
                                                        Integrate Invoice
                                                    </Button>
                                                </DialogTrigger>
                                                <DialogContent>
                                                    <DialogHeader>
                                                        <DialogTitle>Integrate Invoice with Accounting</DialogTitle>
                                                        <DialogDescription>
                                                            Record invoice {selectedSale.saleNumber} in the accounting ledger
                                                        </DialogDescription>
                                                    </DialogHeader>
                                                    <div className="space-y-4">
                                                        <div className="bg-gray-50 p-4 rounded-lg">
                                                            <h4 className="font-medium text-gray-900 mb-2">Sale Details</h4>
                                                            <div className="grid grid-cols-2 gap-2 text-sm">
                                                                <div>Sale: {selectedSale.saleNumber}</div>
                                                                <div>Amount: {formatCurrency(selectedSale.totalAmount)}</div>
                                                                <div>Customer: {selectedSale.customerName || 'Walk-in'}</div>
                                                                <div>Date: {formatDate(selectedSale.saleDate)}</div>
                                                            </div>
                                                        </div>
                                                        <div>
                                                            <Label htmlFor="integration-description">Description</Label>
                                                            <Textarea
                                                                id="integration-description"
                                                                value={integrationForm.description}
                                                                onChange={(e) => setIntegrationForm(prev => ({
                                                                    ...prev,
                                                                    description: e.target.value
                                                                }))}
                                                                placeholder="Invoice description for accounting records"
                                                                rows={3}
                                                            />
                                                        </div>
                                                        <div className="bg-yellow-50 p-4 rounded-lg">
                                                            <div className="flex">
                                                                <AlertCircle className="h-5 w-5 text-yellow-400" />
                                                                <div className="ml-3">
                                                                    <h3 className="text-sm font-medium text-yellow-800">
                                                                        Integration Notice
                                                                    </h3>
                                                                    <p className="text-sm text-yellow-700 mt-1">
                                                                        This will create journal entries in the accounting system for revenue recognition and COGS.
                                                                    </p>
                                                                </div>
                                                            </div>
                                                        </div>
                                                    </div>
                                                    <DialogFooter>
                                                        <Button variant="outline" onClick={() => setShowIntegrateDialog(false)}>
                                                            Cancel
                                                        </Button>
                                                        <Button onClick={handleIntegrateInvoice} disabled={integrating}>
                                                            {integrating && <Loader className="mr-2 h-4 w-4 animate-spin" />}
                                                            Integrate Invoice
                                                        </Button>
                                                    </DialogFooter>
                                                </DialogContent>
                                            </Dialog>

                                            <Dialog open={showPaymentDialog} onOpenChange={setShowPaymentDialog}>
                                                <DialogTrigger asChild>
                                                    <Button variant="outline" size="sm" className="flex items-center gap-2">
                                                        <DollarSign className="h-4 w-4" />
                                                        Record Payment
                                                    </Button>
                                                </DialogTrigger>
                                                <DialogContent>
                                                    <DialogHeader>
                                                        <DialogTitle>Record Payment in Ledger</DialogTitle>
                                                        <DialogDescription>
                                                            Record payment for sale {selectedSale.saleNumber} in accounting system
                                                        </DialogDescription>
                                                    </DialogHeader>
                                                    <div className="space-y-4">
                                                        <div>
                                                            <Label htmlFor="payment-amount">Payment Amount</Label>
                                                            <Input
                                                                id="payment-amount"
                                                                type="number"
                                                                value={String(paymentForm.paymentAmount || '')}
                                                                onChange={(e) => setPaymentForm(prev => ({
                                                                    ...prev,
                                                                    paymentAmount: parseFloat(e.target.value) || 0
                                                                }))}
                                                                placeholder="0.00"
                                                                step="1"
                                                            />
                                                        </div>
                                                        <div>
                                                            <Label htmlFor="payment-method-ledger">Payment Method</Label>
                                                            <Select
                                                                value={paymentForm.paymentMethod}
                                                                onValueChange={(value) => setPaymentForm(prev => ({ ...prev, paymentMethod: value }))}
                                                            >
                                                                <SelectTrigger>
                                                                    <SelectValue />
                                                                </SelectTrigger>
                                                                <SelectContent>
                                                                    <SelectItem value="CASH">Cash</SelectItem>
                                                                    <SelectItem value="CARD">Card</SelectItem>
                                                                    <SelectItem value="MOBILE_MONEY">Mobile Money</SelectItem>
                                                                    <SelectItem value="CREDIT">Credit</SelectItem>
                                                                </SelectContent>
                                                            </Select>
                                                        </div>
                                                        <div>
                                                            <Label htmlFor="payment-date">Payment Date</Label>
                                                            <DatePicker
                                                                value={paymentForm.paymentDate}
                                                                onChange={(date) => setPaymentForm(prev => ({ ...prev, paymentDate: date }))}
                                                                placeholder="Select payment date"
                                                            />
                                                        </div>
                                                        <div>
                                                            <Label htmlFor="payment-reference">Reference</Label>
                                                            <Input
                                                                id="payment-reference"
                                                                value={paymentForm.reference || ''}
                                                                onChange={(e) => setPaymentForm(prev => ({ ...prev, reference: e.target.value }))}
                                                                placeholder="Payment reference or transaction ID"
                                                            />
                                                        </div>
                                                        <div>
                                                            <Label htmlFor="payment-description">Description</Label>
                                                            <Textarea
                                                                id="payment-description"
                                                                value={paymentForm.description || ''}
                                                                onChange={(e) => setPaymentForm(prev => ({ ...prev, description: e.target.value }))}
                                                                placeholder="Payment description for accounting records"
                                                                rows={2}
                                                            />
                                                        </div>
                                                    </div>
                                                    <DialogFooter>
                                                        <Button variant="outline" onClick={() => setShowPaymentDialog(false)}>
                                                            Cancel
                                                        </Button>
                                                        <Button onClick={handleRecordPayment}>
                                                            Record Payment
                                                        </Button>
                                                    </DialogFooter>
                                                </DialogContent>
                                            </Dialog>
                                        </>
                                    )}
                                </div>
                            </div>
                            <CardDescription>Select a sale to integrate with accounting system</CardDescription>
                        </CardHeader>
                        <CardContent>
                            {/* Search */}
                            <div className="relative mb-4">
                                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 h-4 w-4" />
                                <Input
                                    type="text"
                                    placeholder="Search sales..."
                                    value={searchTerm}
                                    onChange={(e) => setSearchTerm(e.target.value)}
                                    className="pl-10"
                                />
                            </div>

                            {/* Sales List */}
                            <div className="space-y-2 max-h-96 overflow-y-auto">
                                {loading ? (
                                    <div className="flex items-center justify-center py-8">
                                        <Loader className="h-8 w-8 animate-spin text-gray-400" />
                                    </div>
                                ) : filteredSales.length === 0 ? (
                                    <p className="text-gray-500 text-center py-8">No sales found</p>
                                ) : (
                                    filteredSales.map((sale) => (
                                        <div
                                            key={sale.id}
                                            onClick={() => handleSelectSale(sale)}
                                            className={`p-4 rounded-lg border cursor-pointer transition-colors ${selectedSale?.id === sale.id
                                                ? 'border-orange-300 bg-orange-50'
                                                : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                                                }`}
                                        >
                                            <div className="flex items-center justify-between">
                                                <div>
                                                    <div className="font-medium text-gray-900">{sale.saleNumber}</div>
                                                    <div className="text-sm text-gray-500">
                                                        {sale.customerName || 'Walk-in Customer'}
                                                    </div>
                                                    <div className="text-sm text-gray-500">{formatDate(sale.saleDate)}</div>
                                                </div>
                                                <div className="text-right">
                                                    <div className="font-medium text-gray-900">{formatCurrency(sale.totalAmount)}</div>
                                                    <div className="flex gap-2 mt-1">
                                                        <Badge className={getStatusBadge(sale.status)}>
                                                            {sale.status}
                                                        </Badge>
                                                        <Badge className={getPaymentMethodBadge(sale.paymentMethod)}>
                                                            {sale.paymentMethod}
                                                        </Badge>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    ))
                                )}
                            </div>
                        </CardContent>
                    </Card>
                </div>

                {/* Selected Sale Details */}
                <div>
                    <Card>
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2">
                                <FileText className="h-5 w-5" />
                                Sale Details
                            </CardTitle>
                        </CardHeader>
                        <CardContent>
                            {selectedSale ? (
                                <div className="space-y-4">
                                    <div>
                                        <h3 className="font-medium text-gray-900 mb-2">Sale Information</h3>
                                        <div className="space-y-2 text-sm">
                                            <div className="flex justify-between">
                                                <span className="text-gray-600">Sale Number:</span>
                                                <span className="font-medium">{selectedSale.saleNumber}</span>
                                            </div>
                                            <div className="flex justify-between">
                                                <span className="text-gray-600">Customer:</span>
                                                <span className="font-medium">{selectedSale.customerName || 'Walk-in'}</span>
                                            </div>
                                            <div className="flex justify-between">
                                                <span className="text-gray-600">Date:</span>
                                                <span className="font-medium">{formatDate(selectedSale.saleDate)}</span>
                                            </div>
                                            <div className="flex justify-between">
                                                <span className="text-gray-600">Payment Method:</span>
                                                <Badge className={getPaymentMethodBadge(selectedSale.paymentMethod)}>
                                                    {selectedSale.paymentMethod}
                                                </Badge>
                                            </div>
                                            <div className="flex justify-between">
                                                <span className="text-gray-600">Status:</span>
                                                <Badge className={getStatusBadge(selectedSale.status)}>
                                                    {selectedSale.status}
                                                </Badge>
                                            </div>
                                        </div>
                                    </div>

                                    <div>
                                        <h3 className="font-medium text-gray-900 mb-2">Financial Summary</h3>
                                        <div className="space-y-2 text-sm">
                                            <div className="flex justify-between">
                                                <span className="text-gray-600">Total Amount:</span>
                                                <span className="font-medium text-lg">{formatCurrency(selectedSale.totalAmount)}</span>
                                            </div>
                                            <div className="flex justify-between">
                                                <span className="text-gray-600">Total Cost:</span>
                                                <span className="font-medium">{formatCurrency(selectedSale.totalCost)}</span>
                                            </div>
                                            <div className="flex justify-between">
                                                <span className="text-gray-600">Profit:</span>
                                                <span className="font-medium text-green-600">{formatCurrency(selectedSale.profit)}</span>
                                            </div>
                                        </div>
                                    </div>

                                    <div className="pt-4 border-t">
                                        <div className="text-sm text-gray-500">
                                            Select this sale to integrate with the accounting ledger system or record payments.
                                        </div>
                                    </div>
                                </div>
                            ) : (
                                <p className="text-gray-500 text-center py-8">Select a sale to view details</p>
                            )}
                        </CardContent>
                    </Card>

                    {/* Recent Transactions */}
                    <Card className="mt-6">
                        <CardHeader>
                            <CardTitle className="text-lg">Recent Ledger Transactions</CardTitle>
                        </CardHeader>
                        <CardContent>
                            {transactions.length === 0 ? (
                                <p className="text-gray-500 text-center py-8">No recent transactions</p>
                            ) : (
                                <div className="space-y-2">
                                    {transactions.map((transaction) => (
                                        <div key={transaction.id} className="p-3 bg-gray-50 rounded-lg">
                                            <div className="font-medium text-sm">{transaction.description}</div>
                                            <div className="text-sm text-gray-500 flex justify-between mt-1">
                                                <span>{formatDate(transaction.createdAt)}</span>
                                                <span className="font-medium">{formatCurrency(transaction.totalAmount)}</span>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </CardContent>
                    </Card>
                </div>
            </div>
        </div>
    );
};

export default InvoiceLedgerIntegrationPage;