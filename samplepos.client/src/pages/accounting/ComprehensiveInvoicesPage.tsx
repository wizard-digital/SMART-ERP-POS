/**
 * Comprehensive Invoices Page
 * 
 * Complete invoice management system that integrates with existing customers and sales
 * Handles invoice creation, payments, aging, and full lifecycle management
 */

import React, { useState, useEffect, useRef } from 'react';
import { useTransactionGuard, ZINDEX } from '../../hooks/useTransactionGuard';
import type { GuardHandle } from '../../hooks/useTransactionGuard';
import { AxiosError } from 'axios';
import { Plus, Search, Eye, FileText, DollarSign, AlertTriangle, Printer } from 'lucide-react';
import { DocumentFlowButton } from '../../components/shared/DocumentFlowButton';
import { downloadFile } from '../../utils/download';
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
    Badge,
    Textarea,
    Tabs,
    TabsContent,
    TabsList,
    TabsTrigger
} from '../../components/ui/temp-ui-components';
import { DatePicker } from '../../components/ui/date-picker';
import { formatCurrency } from '../../utils/currency';
import { toast } from 'react-hot-toast';
import {
    comprehensiveInvoiceService,
    customerPaymentService
} from '../../services/comprehensive-accounting';
import { api } from '../../services/api';
import type {
    ComprehensiveInvoice,
    CustomerAgingReport,
    CreateInvoiceRequest,
    CreateCustomerPaymentRequest
} from '../../types/comprehensive-accounting';
import type { Customer, Product } from '../../types/business';
import { formatTimestampDate } from '../../utils/businessDate';
import { useSubmitOnEnter } from '../../hooks/useSubmitOnEnter';

const INVOICE_STATUSES = [
    { value: '__all__', label: 'All Statuses' },
    { value: 'DRAFT', label: 'Draft', color: 'bg-gray-100 text-gray-800' },
    { value: 'ISSUED', label: 'Issued', color: 'bg-blue-100 text-blue-800' },
    { value: 'PARTIALLY_PAID', label: 'Partially Paid', color: 'bg-yellow-100 text-yellow-800' },
    { value: 'PAID', label: 'Paid', color: 'bg-green-100 text-green-800' },
    { value: 'CANCELLED', label: 'Cancelled', color: 'bg-red-100 text-red-800' }
];

const ComprehensiveInvoicesPage: React.FC = () => {
    const [activeTab, setActiveTab] = useState('invoices');
    const [invoices, setInvoices] = useState<ComprehensiveInvoice[]>([]);
    const [agingReport, setAgingReport] = useState<CustomerAgingReport[]>([]);
    const [customers, setCustomers] = useState<Customer[]>([]);
    const [products, setProducts] = useState<Product[]>([]);
    const [loading, setLoading] = useState(true);
    const [searchTerm, setSearchTerm] = useState('');
    const [selectedCustomerId, setSelectedCustomerId] = useState<string>('');
    const [selectedStatus, setSelectedStatus] = useState<string>('__all__');

    // Modal states
    const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
    const [isPaymentModalOpen, setIsPaymentModalOpen] = useState(false);
    const [isViewModalOpen, setIsViewModalOpen] = useState(false);
    // Invoice PDF export — direct download via downloadFile (no modal needed)

    // ── Transaction Guard ──────────────────────────────────────────────────
    const { openGuard, closeGuard } = useTransactionGuard();
    const createGuardRef = useRef<GuardHandle | null>(null);
    const paymentGuardRef = useRef<GuardHandle | null>(null);
    const viewGuardRef = useRef<GuardHandle | null>(null);

    useEffect(() => {
        if (isCreateModalOpen) {
            createGuardRef.current = openGuard({ cancellable: false, label: 'Create invoice' });
            return () => { if (createGuardRef.current) { closeGuard(createGuardRef.current.id); createGuardRef.current = null; } };
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isCreateModalOpen]);

    useEffect(() => {
        if (isPaymentModalOpen) {
            paymentGuardRef.current = openGuard({ cancellable: false, label: 'Record invoice payment' });
            return () => { if (paymentGuardRef.current) { closeGuard(paymentGuardRef.current.id); paymentGuardRef.current = null; } };
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isPaymentModalOpen]);

    useEffect(() => {
        if (isViewModalOpen) {
            viewGuardRef.current = openGuard({ cancellable: true, label: 'View invoice details' });
            return () => { if (viewGuardRef.current) { closeGuard(viewGuardRef.current.id); viewGuardRef.current = null; } };
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isViewModalOpen]);

    const [selectedInvoice, setSelectedInvoice] = useState<ComprehensiveInvoice | null>(null);

    // Form states
    const [invoiceFormData, setInvoiceFormData] = useState<CreateInvoiceRequest>({
        customerId: '',
        dueDate: '',
        notes: '',
        lineItems: [{
            productId: '',
            quantity: '1',
            unitPrice: '',
            description: ''
        }]
    });

    const [paymentFormData, setPaymentFormData] = useState<CreateCustomerPaymentRequest>({
        customerId: '',
        amount: '',
        paymentMethod: 'CASH',
        reference: '',
        paymentDate: new Date().toLocaleDateString('en-CA'),
        notes: '',
        allocations: []
    });

    useEffect(() => {
        loadData();
    }, [activeTab]);

    useEffect(() => {
        if (searchTerm || selectedCustomerId || (selectedStatus && selectedStatus !== '__all__')) {
            filterData();
        } else {
            loadData();
        }
    }, [searchTerm, selectedCustomerId, selectedStatus]);

    const loadData = async () => {
        try {
            setLoading(true);

            // Load customers
            const customersResponse = await api.get('/customers');
            if (customersResponse.data.success) {
                setCustomers(customersResponse.data.data || []);
            }

            // Load products  
            const productsResponse = await api.get('/products');
            if (productsResponse.data.success) {
                setProducts(productsResponse.data.data || []);
            }

            if (activeTab === 'invoices') {
                await loadInvoices();
            } else if (activeTab === 'aging') {
                await loadAgingReport();
            }
        } catch (error) {
            console.error('Error loading data:', error);
            toast.error('Failed to load data');
        } finally {
            setLoading(false);
        }
    };

    const loadInvoices = async () => {
        try {
            const response = await comprehensiveInvoiceService.getCustomerInvoices({
                customerId: selectedCustomerId || undefined,
                status: selectedStatus && selectedStatus !== '__all__' ? selectedStatus : undefined,
                search: searchTerm || undefined
            });

            if (response.items) {
                setInvoices(response.items || []);
            }
        } catch (error) {
            console.error('Error loading invoices:', error);
        }
    };

    const loadAgingReport = async () => {
        try {
            const response = await comprehensiveInvoiceService.getCustomerAging();

            if (response.success && response.data) {
                setAgingReport(response.data);
            }
        } catch (error) {
            console.error('Error loading aging report:', error);
        }
    };

    const filterData = async () => {
        if (activeTab === 'invoices') {
            await loadInvoices();
        } else if (activeTab === 'aging') {
            await loadAgingReport();
        }
    };

    const handleCreateInvoice = async () => {
        try {
            if (!invoiceFormData.customerId || invoiceFormData.customerId === '__none__') {
                toast.error('Please select a customer');
                return;
            }
            if (invoiceFormData.lineItems.length === 0) {
                toast.error('Please add at least one line item');
                return;
            }

            const validLineItems = invoiceFormData.lineItems.filter(item =>
                item.productId && item.productId !== '__none__' && item.quantity && item.unitPrice
            );

            if (validLineItems.length === 0) {
                toast.error('Each line needs a product, quantity, and unit price');
                return;
            }

            const response = await comprehensiveInvoiceService.createInvoice({
                ...invoiceFormData,
                lineItems: validLineItems.map(item => ({
                    ...item,
                    quantity: parseFloat(item.quantity.toString()),
                    unitPrice: parseFloat(item.unitPrice.toString())
                }))
            });

            if (response.success) {
                toast.success('Invoice created successfully');
                setIsCreateModalOpen(false);
                resetInvoiceForm();
                loadInvoices();
            }
        } catch (error: unknown) {
            console.error('Error creating invoice:', error);
            const errMsg = error instanceof AxiosError
                ? (error.response?.data as { error?: string })?.error
                : error instanceof Error ? error.message : undefined;
            toast.error(errMsg || 'Failed to create invoice');
        }
    };

    const handleRecordPayment = async () => {
        try {
            if (!paymentFormData.customerId) {
                toast.error('Please select a customer');
                return;
            }
            const amount = parseFloat(paymentFormData.amount.toString());
            if (!Number.isFinite(amount) || amount <= 0) {
                toast.error('Please enter a valid payment amount greater than zero');
                return;
            }

            const response = await customerPaymentService.createCustomerPayment({
                ...paymentFormData,
                amount
            });

            if (response.success) {
                toast.success('Payment recorded successfully');
                setIsPaymentModalOpen(false);
                resetPaymentForm();
                loadInvoices();
            }
        } catch (error: unknown) {
            console.error('Error recording payment:', error);
            const errMsg = error instanceof AxiosError
                ? (error.response?.data as { error?: string })?.error
                : error instanceof Error ? error.message : undefined;
            toast.error(errMsg || 'Failed to record payment');
        }
    };

    const handleVoidInvoice = async (invoiceId: string) => {
        try {
            const response = await comprehensiveInvoiceService.voidInvoice(invoiceId);

            if (response.success) {
                toast.success('Invoice voided successfully');
                loadInvoices();
            }
        } catch (error: unknown) {
            console.error('Error voiding invoice:', error);
            const errMsg = error instanceof AxiosError
                ? (error.response?.data as { error?: string })?.error
                : error instanceof Error ? error.message : undefined;
            toast.error(errMsg || 'Failed to void invoice');
        }
    };

    const openPaymentModal = (invoice: ComprehensiveInvoice) => {
        setPaymentFormData({
            customerId: invoice.customerId,
            amount: invoice.outstandingBalance.toString(),
            paymentMethod: 'CASH',
            reference: '',
            paymentDate: new Date().toLocaleDateString('en-CA'),
            notes: `Payment for ${invoice.invoiceNumber}`,
            allocations: [{
                invoiceId: invoice.id,
                amount: parseFloat(invoice.outstandingBalance.toString())
            }]
        });
        setIsPaymentModalOpen(true);
    };

    const viewInvoiceDetails = async (invoice: ComprehensiveInvoice) => {
        try {
            const response = await comprehensiveInvoiceService.getInvoice(invoice.id);

            if (response.success && response.data) {
                setSelectedInvoice(response.data);
                setIsViewModalOpen(true);
            }
        } catch (error) {
            console.error('Error loading invoice details:', error);
            toast.error('Failed to load invoice details');
        }
    };

    const addLineItem = () => {
        setInvoiceFormData(prev => ({
            ...prev,
            lineItems: [...prev.lineItems, {
                productId: '',
                quantity: '1',
                unitPrice: '',
                description: ''
            }]
        }));
    };

    const updateLineItem = (index: number, field: string, value: string) => {
        setInvoiceFormData(prev => ({
            ...prev,
            lineItems: prev.lineItems.map((item, i) => {
                if (i === index) {
                    const updated = { ...item, [field]: value };

                    // Auto-populate unit price when product is selected
                    if (field === 'productId' && value) {
                        const product = products.find(p => p.id === value);
                        if (product) {
                            updated.unitPrice = product.sellingPrice.toString();
                            updated.description = product.name;
                        }
                    }

                    return updated;
                }
                return item;
            })
        }));
    };

    const removeLineItem = (index: number) => {
        setInvoiceFormData(prev => ({
            ...prev,
            lineItems: prev.lineItems.filter((_, i) => i !== index)
        }));
    };

    const resetInvoiceForm = () => {
        setInvoiceFormData({
            customerId: '',
            dueDate: '',
            notes: '',
            lineItems: [{
                productId: '',
                quantity: '1',
                unitPrice: '',
                description: ''
            }]
        });
    };

    const resetPaymentForm = () => {
        setPaymentFormData({
            customerId: '',
            amount: '',
            paymentMethod: 'CASH',
            reference: '',
            paymentDate: new Date().toLocaleDateString('en-CA'),
            notes: '',
            allocations: []
        });
    };

    const getStatusBadgeColor = (status: string) => {
        const statusConfig = INVOICE_STATUSES.find(s => s.value === status);
        return statusConfig?.color || 'bg-gray-100 text-gray-800';
    };

    const isOverdue = (invoice: ComprehensiveInvoice) => {
        if (!invoice.dueDate || invoice.status === 'PAID') return false;
        return new Date(invoice.dueDate) < new Date() && parseFloat(invoice.outstandingBalance.toString()) > 0;
    };

    const getTotalLineItemsValue = () => {
        return invoiceFormData.lineItems.reduce((sum, item) => {
            const quantity = parseFloat(item.quantity.toString()) || 0;
            const unitPrice = parseFloat(item.unitPrice.toString()) || 0;
            return sum + (quantity * unitPrice);
        }, 0);
    };

    useSubmitOnEnter(isCreateModalOpen, true, handleCreateInvoice);
    useSubmitOnEnter(isPaymentModalOpen, true, handleRecordPayment);

    if (loading) {
        return (
            <div className="flex items-center justify-center h-64">
                <div className="text-lg">Loading invoices...</div>
            </div>
        );
    }

    return (
        <div className="space-y-6">
            {/* Header */}
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                <div>
                    <h1 className="text-3xl font-bold text-gray-900">Invoice Management</h1>
                    <p className="text-gray-600">Create, manage and track customer invoices and payments</p>
                </div>

                <Button className="flex items-center gap-2" onClick={() => setIsCreateModalOpen(true)}>
                    <Plus className="h-4 w-4" />
                    Create Invoice
                </Button>
            </div>

            {/* Filters */}
            <div className="flex flex-col sm:flex-row gap-4">
                <div className="flex-1">
                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 h-4 w-4" />
                        <Input
                            placeholder="Search invoices..."
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            className="pl-10"
                        />
                    </div>
                </div>

                <div className="w-full sm:w-48">
                    <Select
                        value={selectedCustomerId || '__all__'}
                        onValueChange={(v) => setSelectedCustomerId(v === '__all__' ? '' : v)}
                    >
                        <SelectTrigger>
                            <SelectValue placeholder="All customers" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="__all__">All customers</SelectItem>
                            {customers.map(customer => (
                                <SelectItem key={customer.id} value={customer.id}>
                                    {customer.name}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>

                <div className="w-full sm:w-40">
                    <Select value={selectedStatus} onValueChange={setSelectedStatus}>
                        <SelectTrigger>
                            <SelectValue placeholder="All statuses" />
                        </SelectTrigger>
                        <SelectContent>
                            {INVOICE_STATUSES.map(status => (
                                <SelectItem key={status.value} value={status.value}>
                                    {status.label}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
            </div>

            {/* Tabs */}
            <Tabs value={activeTab} onValueChange={setActiveTab}>
                <TabsList className="grid w-full grid-cols-2">
                    <TabsTrigger value="invoices">Invoices</TabsTrigger>
                    <TabsTrigger value="aging">Aging Report</TabsTrigger>
                </TabsList>

                <TabsContent value="invoices" className="space-y-4">
                    {/* Invoices List */}
                    <div className="grid gap-4">
                        {invoices.length === 0 ? (
                            <Card>
                                <CardContent className="text-center py-8">
                                    <FileText className="h-12 w-12 text-gray-400 mx-auto mb-4" />
                                    <h3 className="text-lg font-semibold text-gray-900 mb-2">No invoices found</h3>
                                    <p className="text-gray-600">No invoices match your criteria.</p>
                                </CardContent>
                            </Card>
                        ) : (
                            invoices.map((invoice) => (
                                <Card key={invoice.id}>
                                    <CardContent className="p-6">
                                        <div className="flex items-center justify-between">
                                            <div className="flex-1">
                                                <div className="flex items-center gap-3 mb-2">
                                                    <h3 className="text-lg font-semibold">{invoice.invoiceNumber}</h3>
                                                    <Badge className={`text-xs ${getStatusBadgeColor(invoice.status)}`}>
                                                        {invoice.status.replace('_', ' ')}
                                                    </Badge>
                                                    {isOverdue(invoice) && (
                                                        <Badge variant="destructive" className="text-xs">
                                                            <AlertTriangle className="h-3 w-3 mr-1" />
                                                            Overdue
                                                        </Badge>
                                                    )}
                                                </div>

                                                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 text-sm text-gray-600">
                                                    <div>
                                                        <span className="font-medium">Customer:</span>
                                                        <div>{invoice.customerName}</div>
                                                    </div>
                                                    <div>
                                                        <span className="font-medium">Total:</span>
                                                        <div className="text-lg font-semibold text-blue-600">
                                                            {formatCurrency(parseFloat(invoice.totalAmount.toString()))}
                                                        </div>
                                                    </div>
                                                    <div>
                                                        <span className="font-medium">Outstanding:</span>
                                                        <div className={`font-semibold ${parseFloat(invoice.outstandingBalance.toString()) > 0
                                                            ? 'text-red-600'
                                                            : 'text-green-600'
                                                            }`}>
                                                            {formatCurrency(parseFloat(invoice.outstandingBalance.toString()))}
                                                        </div>
                                                    </div>
                                                    <div>
                                                        <span className="font-medium">Date:</span>
                                                        <div>{formatTimestampDate(invoice.invoiceDate)}</div>
                                                    </div>
                                                </div>

                                                {invoice.dueDate && (
                                                    <div className="mt-2 text-sm text-gray-600">
                                                        <span className="font-medium">Due:</span> {formatTimestampDate(invoice.dueDate)}
                                                        {isOverdue(invoice) && (
                                                            <span className="ml-2 text-red-600 font-medium">
                                                                ({Math.floor((new Date().getTime() - new Date(invoice.dueDate).getTime()) / (1000 * 60 * 60 * 24))} days overdue)
                                                            </span>
                                                        )}
                                                    </div>
                                                )}
                                            </div>

                                            <div className="flex items-center gap-2 ml-4">
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onClick={() => viewInvoiceDetails(invoice)}
                                                    className="flex items-center gap-1"
                                                >
                                                    <Eye className="h-4 w-4" />
                                                    View
                                                </Button>

                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onClick={() => downloadFile(`/documents/INVOICE/${invoice.id}`, `invoice-${invoice.invoiceNumber}.pdf`).catch((err: Error) => alert(`PDF export failed: ${err.message}`))}
                                                    className="flex items-center gap-1"
                                                >
                                                    <Printer className="h-4 w-4" />
                                                    Print
                                                </Button>

                                                {parseFloat(invoice.outstandingBalance.toString()) > 0 && invoice.status !== 'CANCELLED' && (
                                                    <Button
                                                        variant="outline"
                                                        size="sm"
                                                        onClick={() => openPaymentModal(invoice)}
                                                        className="flex items-center gap-1"
                                                    >
                                                        <DollarSign className="h-4 w-4" />
                                                        Pay
                                                    </Button>
                                                )}

                                                {invoice.status === 'DRAFT' && (
                                                    <Button
                                                        variant="outline"
                                                        size="sm"
                                                        onClick={() => handleVoidInvoice(invoice.id)}
                                                        className="text-red-600 hover:text-red-700"
                                                    >
                                                        Void
                                                    </Button>
                                                )}
                                            </div>
                                        </div>
                                    </CardContent>
                                </Card>
                            ))
                        )}
                    </div>
                </TabsContent>

                <TabsContent value="aging" className="space-y-4">
                    {/* Aging Report */}
                    <div className="bg-white rounded-lg shadow overflow-hidden">
                        <div className="px-6 py-4 border-b border-gray-200">
                            <h3 className="text-lg font-semibold">Customer Aging Report</h3>
                            <p className="text-sm text-gray-600">Outstanding balances by aging buckets</p>
                        </div>

                        <div className="overflow-x-auto">
                            <table className="min-w-full divide-y divide-gray-200">
                                <thead className="bg-gray-50">
                                    <tr>
                                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                            Customer
                                        </th>
                                        <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                                            Current
                                        </th>
                                        <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                                            1-30 Days
                                        </th>
                                        <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                                            31-60 Days
                                        </th>
                                        <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                                            61-90 Days
                                        </th>
                                        <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                                            Over 90 Days
                                        </th>
                                        <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                                            Total Outstanding
                                        </th>
                                    </tr>
                                </thead>
                                <tbody className="bg-white divide-y divide-gray-200">
                                    {agingReport.length === 0 ? (
                                        <tr>
                                            <td colSpan={7} className="px-6 py-8 text-center text-gray-500">
                                                No aging data available
                                            </td>
                                        </tr>
                                    ) : (
                                        agingReport.map((record) => (
                                            <tr key={record.customerId} className="hover:bg-gray-50">
                                                <td className="px-6 py-4 whitespace-nowrap">
                                                    <div className="font-medium text-gray-900">{record.customerName}</div>
                                                </td>
                                                <td className="px-6 py-4 whitespace-nowrap text-right text-sm">
                                                    {formatCurrency(parseFloat(record.current.toString()))}
                                                </td>
                                                <td className="px-6 py-4 whitespace-nowrap text-right text-sm">
                                                    {formatCurrency(parseFloat(record.days30.toString()))}
                                                </td>
                                                <td className="px-6 py-4 whitespace-nowrap text-right text-sm text-yellow-600">
                                                    {formatCurrency(parseFloat(record.days60.toString()))}
                                                </td>
                                                <td className="px-6 py-4 whitespace-nowrap text-right text-sm text-orange-600">
                                                    {formatCurrency(parseFloat(record.days90.toString()))}
                                                </td>
                                                <td className="px-6 py-4 whitespace-nowrap text-right text-sm text-red-600">
                                                    {formatCurrency(parseFloat(record.over90.toString()))}
                                                </td>
                                                <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-semibold">
                                                    {formatCurrency(parseFloat(record.totalOutstanding.toString()))}
                                                </td>
                                            </tr>
                                        ))
                                    )}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </TabsContent>
            </Tabs>

            {/* Create Invoice Modal */}
            <Dialog open={isCreateModalOpen} onOpenChange={setIsCreateModalOpen} zIndex={createGuardRef.current?.panelZIndex ?? ZINDEX.PANEL}>
                <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
                    <DialogHeader>
                        <DialogTitle>Create New Invoice</DialogTitle>
                        <DialogDescription>
                            Create a new invoice for a customer
                        </DialogDescription>
                    </DialogHeader>

                    <div className="grid gap-4 py-4">
                        <div className="grid grid-cols-1 sm:grid-cols-4 items-center gap-4">
                            <Label htmlFor="customer" className="text-right">Customer</Label>
                            <div className="col-span-3">
                                <Select
                                    value={invoiceFormData.customerId || '__none__'}
                                    onValueChange={(value) =>
                                        setInvoiceFormData((prev) => ({
                                            ...prev,
                                            customerId: value === '__none__' ? '' : value,
                                        }))
                                    }
                                >
                                    <SelectTrigger>
                                        <SelectValue placeholder="Select customer" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="__none__">Select customer…</SelectItem>
                                        {customers.map(customer => (
                                            <SelectItem key={customer.id} value={customer.id}>
                                                {customer.name}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-4 items-center gap-4">
                            <Label htmlFor="dueDate" className="text-right">Due Date</Label>
                            <div className="col-span-3">
                                <DatePicker
                                    value={invoiceFormData.dueDate || ''}
                                    onChange={(date) => setInvoiceFormData(prev => ({ ...prev, dueDate: date }))}
                                    placeholder="Select due date"
                                    minDate={new Date()}
                                />
                            </div>
                        </div>

                        {/* Line Items */}
                        <div className="col-span-4">
                            <Label className="text-sm font-medium">Line Items</Label>
                            <div className="space-y-3 mt-2">
                                {invoiceFormData.lineItems.map((item, index) => (
                                    <div key={index} className="grid grid-cols-12 gap-2 items-end">
                                        <div className="col-span-4">
                                            <Select
                                                value={item.productId || '__none__'}
                                                onValueChange={(value) =>
                                                    updateLineItem(
                                                        index,
                                                        'productId',
                                                        value === '__none__' ? '' : value,
                                                    )
                                                }
                                            >
                                                <SelectTrigger>
                                                    <SelectValue placeholder="Select product" />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="__none__">Select product…</SelectItem>
                                                    {products.map(product => (
                                                        <SelectItem key={product.id} value={product.id}>
                                                            {product.name}
                                                        </SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                        </div>
                                        <div className="col-span-2">
                                            <Input
                                                placeholder="Qty"
                                                type="number"
                                                value={item.quantity.toString()}
                                                onChange={(e) => updateLineItem(index, 'quantity', e.target.value)}
                                            />
                                        </div>
                                        <div className="col-span-2">
                                            <Input
                                                placeholder="Price"
                                                type="number"
                                                step="1"
                                                value={item.unitPrice.toString()}
                                                onChange={(e) => updateLineItem(index, 'unitPrice', e.target.value)}
                                            />
                                        </div>
                                        <div className="col-span-2">
                                            <div className="text-right font-medium">
                                                {formatCurrency((parseFloat(item.quantity.toString()) || 0) * (parseFloat(item.unitPrice.toString()) || 0))}
                                            </div>
                                        </div>
                                        <div className="col-span-2">
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                onClick={() => removeLineItem(index)}
                                                disabled={invoiceFormData.lineItems.length === 1}
                                            >
                                                Remove
                                            </Button>
                                        </div>
                                    </div>
                                ))}
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={addLineItem}
                                    className="w-full"
                                >
                                    Add Line Item
                                </Button>

                                <div className="border-t pt-3">
                                    <div className="flex justify-between text-lg font-semibold">
                                        <span>Total:</span>
                                        <span>{formatCurrency(getTotalLineItemsValue())}</span>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-4 items-center gap-4">
                            <Label htmlFor="notes" className="text-right">Notes</Label>
                            <Textarea
                                id="notes"
                                value={invoiceFormData.notes || ''}
                                onChange={(e) => setInvoiceFormData(prev => ({ ...prev, notes: e.target.value }))}
                                className="col-span-3"
                                placeholder="Invoice notes"
                            />
                        </div>
                    </div>

                    <DialogFooter>
                        <Button variant="outline" onClick={() => setIsCreateModalOpen(false)}>
                            Cancel
                        </Button>
                        <Button onClick={handleCreateInvoice}>
                            Create Invoice
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Record Payment Modal */}
            <Dialog open={isPaymentModalOpen} onOpenChange={setIsPaymentModalOpen} zIndex={paymentGuardRef.current?.panelZIndex ?? ZINDEX.PANEL}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle>Record Payment</DialogTitle>
                        <DialogDescription>
                            Record a payment against this invoice
                        </DialogDescription>
                    </DialogHeader>

                    <div className="grid gap-4 py-4">
                        <div className="grid grid-cols-1 sm:grid-cols-4 items-center gap-4">
                            <Label htmlFor="amount" className="text-right">Amount</Label>
                            <Input
                                id="amount"
                                type="number"
                                step="1"
                                value={paymentFormData.amount.toString()}
                                onChange={(e) => setPaymentFormData(prev => ({ ...prev, amount: parseFloat(e.target.value) || 0 }))}
                                className="col-span-3"
                                placeholder="0.00"
                            />
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-4 items-center gap-4">
                            <Label htmlFor="method" className="text-right">Method</Label>
                            <div className="col-span-3">
                                <Select
                                    value={paymentFormData.paymentMethod}
                                    onValueChange={(value: string) => setPaymentFormData(prev => ({ ...prev, paymentMethod: value as CreateCustomerPaymentRequest['paymentMethod'] }))}
                                >
                                    <SelectTrigger>
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="CASH">Cash</SelectItem>
                                        <SelectItem value="CARD">Card</SelectItem>
                                        <SelectItem value="MOBILE_MONEY">Mobile Money</SelectItem>
                                        <SelectItem value="BANK_TRANSFER">Bank Transfer</SelectItem>
                                        <SelectItem value="OTHER">Other</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-4 items-center gap-4">
                            <Label htmlFor="reference" className="text-right">Reference</Label>
                            <Input
                                id="reference"
                                value={paymentFormData.reference || ''}
                                onChange={(e) => setPaymentFormData(prev => ({ ...prev, reference: e.target.value }))}
                                className="col-span-3"
                                placeholder="Payment reference"
                            />
                        </div>
                    </div>

                    <DialogFooter>
                        <Button variant="outline" onClick={() => setIsPaymentModalOpen(false)}>
                            Cancel
                        </Button>
                        <Button onClick={handleRecordPayment}>
                            Record Payment
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Invoice Details Modal */}
            <Dialog open={isViewModalOpen} onOpenChange={setIsViewModalOpen} zIndex={viewGuardRef.current?.panelZIndex ?? ZINDEX.PANEL}>
                <DialogContent className="max-w-2xl">
                    <DialogHeader>
                        <DialogTitle>Invoice Details</DialogTitle>
                        <DialogDescription>
                            {selectedInvoice?.invoiceNumber}
                        </DialogDescription>
                    </DialogHeader>

                    {selectedInvoice && (
                        <div className="space-y-4">
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                <div>
                                    <Label className="text-sm font-medium text-gray-600">Customer</Label>
                                    <div className="font-medium">{selectedInvoice.customerName}</div>
                                </div>
                                <div>
                                    <Label className="text-sm font-medium text-gray-600">Status</Label>
                                    <Badge className={`text-xs ${getStatusBadgeColor(selectedInvoice.status)}`}>
                                        {selectedInvoice.status.replace('_', ' ')}
                                    </Badge>
                                </div>
                                <div>
                                    <Label className="text-sm font-medium text-gray-600">Invoice Date</Label>
                                    <div>{formatTimestampDate(selectedInvoice.invoiceDate)}</div>
                                </div>
                                <div>
                                    <Label className="text-sm font-medium text-gray-600">Due Date</Label>
                                    <div>{selectedInvoice.dueDate ? formatTimestampDate(selectedInvoice.dueDate) : 'N/A'}</div>
                                </div>
                            </div>

                            <div className="border-t pt-4">
                                <Label className="text-sm font-medium text-gray-600">Line Items</Label>
                                <div className="mt-2 space-y-2">
                                    {selectedInvoice.lineItems?.map((item, index) => (
                                        <div key={index} className="flex justify-between items-center py-2 border-b">
                                            <div>
                                                <div className="font-medium">{item.productName}</div>
                                                <div className="text-sm text-gray-600">{item.description}</div>
                                            </div>
                                            <div className="text-right">
                                                <div className="font-medium">{formatCurrency(parseFloat(item.totalPrice.toString()))}</div>
                                                <div className="text-sm text-gray-600">
                                                    {item.quantity.toString()} × {formatCurrency(parseFloat(item.unitPrice.toString()))}
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>

                            <div className="border-t pt-4 space-y-2">
                                <div className="flex justify-between">
                                    <span>Subtotal:</span>
                                    <span>{formatCurrency(parseFloat(selectedInvoice.subtotal.toString()))}</span>
                                </div>
                                <div className="flex justify-between">
                                    <span>Tax:</span>
                                    <span>{formatCurrency(parseFloat(selectedInvoice.taxAmount.toString()))}</span>
                                </div>
                                <div className="flex justify-between font-semibold text-lg">
                                    <span>Total:</span>
                                    <span>{formatCurrency(parseFloat(selectedInvoice.totalAmount.toString()))}</span>
                                </div>
                                <div className="flex justify-between">
                                    <span>Amount Paid:</span>
                                    <span className="text-green-600">{formatCurrency(parseFloat(selectedInvoice.amountPaid.toString()))}</span>
                                </div>
                                <div className="flex justify-between font-semibold">
                                    <span>Outstanding:</span>
                                    <span className="text-red-600">{formatCurrency(parseFloat(selectedInvoice.outstandingBalance.toString()))}</span>
                                </div>
                            </div>

                            {selectedInvoice.notes && (
                                <div className="border-t pt-4">
                                    <Label className="text-sm font-medium text-gray-600">Notes</Label>
                                    <div className="mt-1 text-sm">{selectedInvoice.notes}</div>
                                </div>
                            )}
                        </div>
                    )}

                    <DialogFooter>
                        {selectedInvoice && (
                            <DocumentFlowButton entityType="INVOICE" entityId={selectedInvoice.id} size="sm" />
                        )}
                        <Button onClick={() => setIsViewModalOpen(false)}>Close</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

        </div>
    );
};

export default ComprehensiveInvoicesPage;
