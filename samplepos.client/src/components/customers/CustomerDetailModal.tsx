import { useState, useEffect, Fragment, useRef, useMemo } from 'react';
import Decimal from 'decimal.js';
import { useModalAccessibility } from '../../hooks/useFocusTrap';
import { useInvoiceDepositBalance } from '../../hooks/useInvoiceDepositBalance';
import {
    assertDepositPaymentAmount,
    depositPaymentCap,
    money2,
} from '@shared/domain/invoiceDepositPayment';
import { useCustomer, useCustomerSummary, useUpdateCustomer, useToggleCustomerActive, useDeleteCustomer, useCustomerStatement, useInvoices, useRecordInvoicePayment } from '../../hooks/useApi';
import { formatCurrency } from '../../utils/currency';
import { downloadFile } from '../../utils/download';
import { api } from '../../utils/api';
import { DatePicker } from '../ui/date-picker';
import CustomerDeposits from './CustomerDeposits';
import { CustomerQuotationsTab } from './CustomerQuotationsTab';
import { AxiosError } from 'axios';
import { getBusinessDate, formatTimestampDate } from '../../utils/businessDate';
import { pricingApi } from '../../api/pricing';
import type { PriceGroup } from '../../types/pricing';
import {
    buildCustomerUpdatePayload,
    priceGroupIdForEffectDeps,
    syncEditPriceGroupState,
    customerIsActive,
} from '../../utils/customerPriceGroupEdit';
import { AdjustCustomerInvoiceModal } from '../shared/AdjustCustomerInvoiceModal';
import { InvoiceSourceQuotationPanel } from '../invoices/InvoiceSourceQuotationPanel';
import { useHasAnyPermission } from '../../hooks/useRbac';
import { CustomerSmartStatementPanel } from './CustomerSmartStatementPanel';
import { useWhtTypes } from '../../hooks/useAccountingModules';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import {
    isAdjustableCustomerInvoice,
    isListableCustomerInvoice,
    type CustomerInvoiceListRow,
} from '../../utils/customerInvoiceListFilters';
import {
    describeCustomerTaxStatus,
    isIncompleteVatRegistration,
    vatRegistrationTinError,
} from '@shared/utils/customerTaxProfileIntegrity';

interface CustomerData {
    id: string;
    name: string;
    email?: string;
    phone?: string;
    address?: string;
    creditLimit?: number | string;
    credit_limit?: number | string;
    unlimitedCredit?: boolean;
    currentBalance?: number | string;
    current_balance?: number | string;
    balance?: number | string;
    isActive?: boolean;
    is_active?: boolean;
    groupName?: string;
    group_name?: string;
    customerNumber?: string;
    customerGroupId?: string | null;
    priceGroupId?: string | null;
    pricingMode?: 'STANDARD' | 'AT_COST' | null;
    whtLiable?: boolean;
    defaultWhtTypeId?: string | null;
    vatRegistered?: boolean;
    tin?: string | null;
    taxProfile?: 'STANDARD' | 'VAT_REGISTERED' | 'EXEMPT' | 'ZERO_RATED';
    defaultVatRate?: number | null;
    vatRegistrationDate?: string | null;
    taxEffectiveFrom?: string | null;
    taxExempt?: boolean;
    allowTaxOverride?: boolean;
    createdAt?: string;
}

interface SummaryData {
    totalPurchases?: number | string;
    total_purchases?: number | string;
    balance?: number | string;
    currentBalance?: number | string;
    current_balance?: number | string;
    creditLimit?: number | string;
    credit_limit?: number | string;
    salesCount?: number | string;
    invoiceCount?: number | string;
    depositBalance?: number | string;
    totalOrders?: number | string;
    totalSales?: number | string;
    totalInvoices?: number | string;
    totalSpent?: number | string;
    lifetimeValue?: number | string;
    averageOrderValue?: number | string;
    pendingInvoices?: number | string;
}

interface InvoiceRow extends CustomerInvoiceListRow {
    id: string;
    issueDate?: string;
    issue_date?: string;
    dueDate?: string;
    due_date?: string;
    status: string;
    notes?: string;
}

interface InvoiceDetailItem {
    id: string;
    productName?: string | null;
    product_name?: string | null;
    quantity?: number | string;
    unitPrice?: number | string;
    unit_price?: number | string;
    lineTotal?: number | string;
    line_total?: number | string;
    total_price?: number | string;
    unitCost?: number | string;
}

interface InvoiceDetailPayment {
    id: string;
    amount?: number | string;
    paymentMethod?: string;
    paymentDate?: string;
    referenceNumber?: string;
    notes?: string;
    createdAt?: string;
}

interface InvoiceDetailResponse {
    invoice: InvoiceRow & {
        subtotal?: number | string;
        taxAmount?: number | string;
        amountPaid?: number | string;
        amount_paid?: number | string;
    };
    items: InvoiceDetailItem[];
    payments: InvoiceDetailPayment[];
    sourceQuotation?: {
        quoteId: string;
        quoteNumber: string;
        reference?: string | null;
        referenceDetails?: string | null;
        quotationAuthorisedByName?: string | null;
    } | null;
    invoiceAuthorisedByName?: string | null;
}

interface StatementResponse {
    openingBalance?: number | string;
    closingBalance?: number | string;
    periodStart?: string;
    periodEnd?: string;
    entries?: StatementEntry[];
    page?: number;
    totalPages?: number;
}

interface StatementEntry {
    date: string;
    type: string;
    reference?: string;
    description?: string;
    debit?: number | string;
    credit?: number | string;
    balance?: number | string;
    balanceAfter?: number | string;
}

type Tab = 'overview' | 'invoices' | 'transactions' | 'deposits' | 'quotations' | 'edit';

interface CustomerDetailModalProps {
    isOpen: boolean;
    onClose: () => void;
    customerId: string | null;
    initialTab?: Tab;
    onCustomerUpdated?: () => void;
    onCustomerDeleted?: () => void;
}

export default function CustomerDetailModal({
    isOpen,
    onClose,
    customerId,
    initialTab = 'overview',
    onCustomerUpdated,
    onCustomerDeleted,
}: CustomerDetailModalProps) {
    const modalRef = useModalAccessibility(isOpen, onClose);
    const [tab, setTab] = useState<Tab>(initialTab);
    const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

    // Invoice state
    const [invoicePage, setInvoicePage] = useState(1);
    const [paymentOpen, setPaymentOpen] = useState(false);
    const [selectedInvoice, setSelectedInvoice] = useState<(InvoiceRow & { outstanding: number }) | null>(null);
    const [payAmount, setPayAmount] = useState('');
    const [payMethod, setPayMethod] = useState<string>('CASH');
    const [payRefNum, setPayRefNum] = useState('');
    const [payNotes, setPayNotes] = useState('');
    const depositBalance = useInvoiceDepositBalance(customerId, paymentOpen);
    const [expandedInvoiceId, setExpandedInvoiceId] = useState<string | null>(null);
    const [expandedInvoiceDetails, setExpandedInvoiceDetails] = useState<InvoiceDetailResponse | null>(null);
    const [loadingExpandedInvoiceId, setLoadingExpandedInvoiceId] = useState<string | null>(null);
    const [downloadingPdfId, setDownloadingPdfId] = useState<string | null>(null);
    const [adjustInvoiceOpen, setAdjustInvoiceOpen] = useState(false);
    const [adjustInvoice, setAdjustInvoice] = useState<{ id: string; invoiceNumber: string } | null>(null);
    const canAdjustInvoices = useHasAnyPermission(['customers.adjust']);

    // Statement state
    const [stmtStart, setStmtStart] = useState<string>('');
    const [stmtEnd, setStmtEnd] = useState<string>('');
    const [stmtPage, setStmtPage] = useState<number>(1);
    const [stmtView] = useState<'smart' | 'legacy'>('smart');
    const stmtLimit = 100;

    // Data hooks
    const { data: customer, isLoading: isLoadingCustomer, refetch: refetchCustomer } = useCustomer(customerId || '');
    const { data: summary } = useCustomerSummary(customerId || '');
    const { data: statement } = useCustomerStatement(customerId || '', {
        start: stmtView === 'legacy' && stmtStart ? new Date(stmtStart).toISOString() : undefined,
        end: stmtView === 'legacy' && stmtEnd ? new Date(stmtEnd).toISOString() : undefined,
        page: stmtPage,
        limit: stmtLimit,
    });

    const { data: invoicesData, isLoading: isLoadingInvoices, refetch: refetchInvoices } = useInvoices(invoicePage, 20, customerId || undefined);
    const recordPayment = useRecordInvoicePayment();

    useEffect(() => {
        if (!paymentOpen || !selectedInvoice || !depositBalance.hasDeposit) return;
        setPayMethod((current) => {
            if (current !== 'CASH') return current;
            const cap = depositPaymentCap(selectedInvoice.outstanding, depositBalance.available);
            if (cap.gt(0)) setPayAmount(cap.toFixed(2));
            return 'DEPOSIT';
        });
    }, [paymentOpen, selectedInvoice, depositBalance.hasDeposit, depositBalance.available]);

    const openReceivePayment = (invoice: InvoiceRow & { outstanding: number }) => {
        setSelectedInvoice(invoice);
        setPayAmount(String(invoice.outstanding));
        setPayMethod('CASH');
        setPayRefNum('');
        setPayNotes('');
        setPaymentOpen(true);
    };
    const allInvoiceRows: InvoiceRow[] = Array.isArray(invoicesData) ? invoicesData : [];
    /** Full invoice list (incl. paid / OB); Adjust button still gated by isAdjustableCustomerInvoice */
    const salesInvoices = allInvoiceRows.filter(isListableCustomerInvoice);

    const updateCustomer = useUpdateCustomer();
    const toggleActiveM = useToggleCustomerActive();
    const deleteCustomerM = useDeleteCustomer();

    const [priceGroups, setPriceGroups] = useState<PriceGroup[]>([]);
    const [editPriceGroupId, setEditPriceGroupId] = useState('');
    const initialPriceGroupIdRef = useRef<string | null>(null);
    const [editWhtLiable, setEditWhtLiable] = useState(false);
    const [editDefaultWhtTypeId, setEditDefaultWhtTypeId] = useState('');
    const [editVatRegistered, setEditVatRegistered] = useState(false);
    const [editTaxExempt, setEditTaxExempt] = useState(false);
    const [editAllowTaxOverride, setEditAllowTaxOverride] = useState(false);
    const [editUnlimitedCredit, setEditUnlimitedCredit] = useState(false);
    const [editTin, setEditTin] = useState('');
    const [editDefaultVatRate, setEditDefaultVatRate] = useState('');
    const [editVatRegistrationDate, setEditVatRegistrationDate] = useState('');
    const [editTaxEffectiveFrom, setEditTaxEffectiveFrom] = useState('');
    const { data: whtTypesRaw } = useWhtTypes();
    const customerWhtTypes = useMemo(() => {
        const items = (Array.isArray(whtTypesRaw) ? whtTypesRaw : []) as Array<{
            id: string;
            code: string;
            name: string;
            rate: number;
            appliesTo?: string;
            isActive?: boolean;
        }>;
        return items.filter((t) => {
            const a = String(t.appliesTo || '').toUpperCase();
            return t.isActive !== false && (a === 'CUSTOMER' || a === 'BOTH');
        });
    }, [whtTypesRaw]);

    useEffect(() => {
        if (tab === 'edit') {
            pricingApi.listPriceGroups(true).then(setPriceGroups).catch(() => { });
        }
    }, [tab]);

    const sum = summary as SummaryData;

    useEffect(() => {
        if (tab === 'edit' && customer) {
            const { editValue, initialRef } = syncEditPriceGroupState(customer as CustomerData);
            setEditPriceGroupId(editValue);
            initialPriceGroupIdRef.current = initialRef;
            const c = customer as CustomerData;
            setEditWhtLiable(c.whtLiable === true);
            setEditDefaultWhtTypeId(c.defaultWhtTypeId || '');
            setEditVatRegistered(c.vatRegistered === true || c.taxProfile === 'VAT_REGISTERED');
            setEditTaxExempt(c.taxExempt === true || c.taxProfile === 'EXEMPT');
            setEditAllowTaxOverride(c.allowTaxOverride === true);
            setEditUnlimitedCredit(c.unlimitedCredit === true);
            setEditTin(c.tin || '');
            setEditDefaultVatRate(
                c.defaultVatRate != null && c.defaultVatRate !== undefined
                    ? String(c.defaultVatRate)
                    : '',
            );
            setEditVatRegistrationDate(
                c.vatRegistrationDate ? String(c.vatRegistrationDate).slice(0, 10) : '',
            );
            setEditTaxEffectiveFrom(
                c.taxEffectiveFrom ? String(c.taxEffectiveFrom).slice(0, 10) : '',
            );
        }
    }, [tab, customer, priceGroupIdForEffectDeps(customer as CustomerData | undefined)]);

    // Apply initialTab only when the modal opens or the customer changes — never while browsing tabs.
    const wasOpenRef = useRef(false);
    const openCustomerIdRef = useRef<string | null>(null);
    useEffect(() => {
        if (!isOpen) {
            wasOpenRef.current = false;
            openCustomerIdRef.current = null;
            return;
        }
        const justOpened = !wasOpenRef.current;
        const customerChanged =
            openCustomerIdRef.current !== null && openCustomerIdRef.current !== customerId;
        wasOpenRef.current = true;
        openCustomerIdRef.current = customerId;
        if (!justOpened && !customerChanged) return;

        setTab(initialTab);
        setStmtStart('');
        setStmtEnd('');
        setStmtPage(1);
        setInvoicePage(1);
        setPaymentOpen(false);
        setSelectedInvoice(null);
        setExpandedInvoiceId(null);
        setExpandedInvoiceDetails(null);
        setLoadingExpandedInvoiceId(null);
    }, [isOpen, customerId, initialTab]);

    const toNumber = (v: unknown): number => {
        if (typeof v === 'number') return v;
        const parsed = parseFloat(String(v ?? '0'));
        return isNaN(parsed) ? 0 : parsed;
    };

    const onEditSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        if (!customer || !customerId) return;
        const form = e.currentTarget;
        const formData = new FormData(form);
        const taxProfile = editTaxExempt
            ? 'EXEMPT'
            : editVatRegistered
                ? 'VAT_REGISTERED'
                : 'STANDARD';
        const tinCheck = vatRegistrationTinError({
            vatRegistered: editVatRegistered,
            taxExempt: editTaxExempt,
            taxProfile,
            tin: editTin,
        });
        if (tinCheck) {
            alert(`❌ ${tinCheck}`);
            return;
        }
        const payload = buildCustomerUpdatePayload(
            initialPriceGroupIdRef.current,
            editPriceGroupId,
            {
                name: formData.get('name')?.toString() || undefined,
                email: formData.get('email')?.toString() || undefined,
                phone: formData.get('phone')?.toString() || undefined,
                address: formData.get('address')?.toString() || undefined,
                creditLimit: formData.get('creditLimit') ? Number(formData.get('creditLimit')) : undefined,
                unlimitedCredit: editUnlimitedCredit,
                whtLiable: editWhtLiable,
                defaultWhtTypeId: editWhtLiable ? editDefaultWhtTypeId || null : null,
                vatRegistered: editVatRegistered,
                taxExempt: editTaxExempt,
                allowTaxOverride: editAllowTaxOverride,
                tin: editTin.trim() || null,
                defaultVatRate: editDefaultVatRate !== '' ? Number(editDefaultVatRate) : null,
                vatRegistrationDate: editVatRegistrationDate || null,
                taxEffectiveFrom: editTaxEffectiveFrom || null,
                taxProfile,
            },
        );
        try {
            await updateCustomer.mutateAsync({ id: customerId, data: payload });
            alert('✅ Customer updated successfully!');
            refetchCustomer();
            onCustomerUpdated?.();
            setTab('overview');
        } catch (error: unknown) {
            alert(`❌ Failed to update customer: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    };

    const handleToggleActive = async () => {
        if (!customer || !customerId) return;
        const newStatus = !customerIsActive(customer as CustomerData);
        try {
            await toggleActiveM.mutateAsync({ id: customerId, isActive: newStatus });
            alert(`Customer ${newStatus ? 'activated' : 'deactivated'} successfully`);
            refetchCustomer();
            onCustomerUpdated?.();
        } catch (err: unknown) {
            const axErr = err instanceof AxiosError ? err.response?.data?.error : undefined;
            alert(axErr || (err instanceof Error ? err.message : 'Failed to update customer status'));
        }
    };

    const handleDelete = async () => {
        if (!customerId) return;
        try {
            await deleteCustomerM.mutateAsync(customerId);
            setDeleteConfirmOpen(false);
            alert('Customer deleted successfully');
            onCustomerDeleted?.();
            onClose();
        } catch (err: unknown) {
            const axErr = err instanceof AxiosError ? err.response?.data?.error : undefined;
            alert(axErr || (err instanceof Error ? err.message : 'Failed to delete customer'));
        }
    };

    const toggleInvoiceInlineDetails = async (invoiceId: string) => {
        if (expandedInvoiceId === invoiceId) {
            setExpandedInvoiceId(null);
            setExpandedInvoiceDetails(null);
            return;
        }

        setExpandedInvoiceId(invoiceId);
        setExpandedInvoiceDetails(null);
        setLoadingExpandedInvoiceId(invoiceId);
        try {
            const response = await api.invoices.getById(invoiceId);
            if (response.data.success) {
                const payload = response.data.data as InvoiceDetailResponse & {
                    lineItems?: InvoiceDetailItem[];
                    saleItems?: InvoiceDetailItem[];
                };

                let normalizedItems: InvoiceDetailItem[] = Array.isArray(payload.items)
                    ? payload.items
                    : Array.isArray(payload.lineItems)
                        ? payload.lineItems
                        : Array.isArray(payload.saleItems)
                            ? payload.saleItems
                            : [];

                if (normalizedItems.length === 0) {
                    const saleId = (payload.invoice as { saleId?: string; sale_id?: string })?.saleId
                        || (payload.invoice as { saleId?: string; sale_id?: string })?.sale_id;

                    if (saleId) {
                        try {
                            const saleResponse = await api.sales.getById(String(saleId));
                            const saleData = saleResponse.data.data as {
                                items?: InvoiceDetailItem[];
                                saleItems?: InvoiceDetailItem[];
                            };
                            normalizedItems = Array.isArray(saleData?.items)
                                ? saleData.items
                                : Array.isArray(saleData?.saleItems)
                                    ? saleData.saleItems
                                    : [];
                        } catch (saleError) {
                            console.error('Failed to load fallback sale items:', saleError);
                        }
                    }
                }

                setExpandedInvoiceDetails({
                    ...payload,
                    items: normalizedItems,
                    payments: Array.isArray(payload.payments) ? payload.payments : [],
                });
            }
        } catch (error) {
            console.error('Failed to load invoice details:', error);
        } finally {
            setLoadingExpandedInvoiceId(null);
        }
    };

    const handleDownloadInvoicePdf = async (invoiceId: string, invoiceNumber: string) => {
        setDownloadingPdfId(invoiceId);
        try {
            await downloadFile(`/documents/INVOICE/${invoiceId}`, `invoice-${invoiceNumber}.pdf`);
        } catch (error) {
            alert(`PDF export failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        } finally {
            setDownloadingPdfId(null);
        }
    };



    if (!isOpen || !customerId) return null;

    const tabLabels: Record<Tab, string> = {
        overview: 'Overview',
        invoices: 'Invoices',
        transactions: 'Transactions',
        deposits: 'Deposits',
        quotations: 'Quotations',
        edit: 'Edit',
    };

    return (
        <div className="fixed inset-0 z-50 overflow-y-auto">
            <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden="true" />
            <div className="relative z-10 flex min-h-full items-center justify-center p-4 pointer-events-none">
                <div
                    ref={modalRef}
                    role="dialog"
                    aria-modal="true"
                    aria-label={`Customer Details - ${(customer as CustomerData | undefined)?.name || 'Loading'}`}
                    className="pointer-events-auto relative bg-white w-full max-w-[95vw] sm:max-w-5xl rounded-lg shadow-xl border border-gray-200 max-h-[90vh] overflow-hidden flex flex-col"
                >
                    {/* Header */}
                    <div className="shrink-0 border-b border-gray-200 px-4 sm:px-6 py-3 sm:py-4 flex items-start sm:items-center justify-between bg-gray-50 gap-3">
                        <div className="flex items-center space-x-3 sm:space-x-4 min-w-0">
                            <div className="h-10 w-10 sm:h-12 sm:w-12 bg-blue-100 rounded-full flex items-center justify-center flex-shrink-0">
                                <span className="text-blue-600 font-bold text-base sm:text-lg">
                                    {(customer as CustomerData | undefined)?.name?.charAt(0)?.toUpperCase() || '?'}
                                </span>
                            </div>
                            <div className="min-w-0">
                                <h2 className="text-lg sm:text-xl font-semibold text-gray-900 truncate">{(customer as CustomerData | undefined)?.name || 'Loading...'}</h2>
                                <p className="text-xs sm:text-sm text-gray-500 truncate">{(customer as CustomerData | undefined)?.email || (customer as CustomerData | undefined)?.phone || 'No contact info'}</p>
                            </div>
                        </div>
                        <button
                            type="button"
                            onClick={onClose}
                            className="p-2 rounded hover:bg-gray-200 transition-colors flex-shrink-0"
                            aria-label="Close"
                        >
                            <span className="text-xl">✕</span>
                        </button>
                    </div>

                    {/* Tabs — sticky above scrollable body so statement never covers them */}
                    <div className="shrink-0 sticky top-0 z-20 border-b border-gray-200 px-4 sm:px-6 bg-white overflow-x-auto">
                        <nav className="-mb-px flex space-x-3 sm:space-x-6 min-w-max" role="tablist" aria-label="Customer sections">
                            {(['overview', 'invoices', 'transactions', 'deposits', 'quotations', 'edit'] as Tab[]).map((t) => (
                                <button
                                    key={t}
                                    type="button"
                                    role="tab"
                                    aria-selected={tab === t}
                                    onClick={() => setTab(t)}
                                    className={`py-3 px-2 border-b-2 font-medium text-sm whitespace-nowrap ${tab === t
                                        ? 'border-blue-500 text-blue-600'
                                        : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                                        }`}
                                >
                                    {tabLabels[t]}
                                </button>
                            ))}
                        </nav>
                    </div>

                    {/* Content */}
                    <div className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-6">
                        {isLoadingCustomer ? (
                            <div className="flex items-center justify-center py-12">
                                <div className="text-gray-500">Loading customer details...</div>
                            </div>
                        ) : !customer ? (
                            <div className="text-center py-12 text-red-600">Customer not found</div>
                        ) : (
                            <>
                                {/* Overview Tab */}
                                {tab === 'overview' && (
                                    <div className="space-y-6">
                                        {/* Summary Cards */}
                                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                            <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
                                                <div className="text-sm text-gray-600">
                                                    {toNumber((customer as CustomerData).balance) >= 0 ? 'Balance (Owed)' : 'Customer Credit'}
                                                </div>
                                                <div className={`text-xl sm:text-2xl font-bold ${toNumber((customer as CustomerData).balance) > 0 ? 'text-red-600' : toNumber((customer as CustomerData).balance) < 0 ? 'text-green-600' : 'text-gray-900'}`}>
                                                    {formatCurrency(Math.abs(toNumber((customer as CustomerData).balance)))}
                                                </div>
                                                {toNumber((customer as CustomerData).balance) < 0 && (
                                                    <div className="text-xs text-green-600 mt-1">Overpaid — credit on account</div>
                                                )}
                                            </div>
                                            <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
                                                <div className="text-sm text-gray-600">Credit Limit</div>
                                                <div className="text-xl sm:text-2xl font-bold text-gray-900">
                                                    {(customer as CustomerData).unlimitedCredit
                                                        ? 'Unlimited'
                                                        : formatCurrency((customer as CustomerData).creditLimit || 0)}
                                                </div>
                                                {(customer as CustomerData).unlimitedCredit ? (
                                                    <div className="text-xs text-indigo-600 mt-1">
                                                        On-account / credit sales are not capped
                                                    </div>
                                                ) : null}
                                            </div>
                                            <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
                                                <div className="text-sm text-gray-600">Status</div>
                                                <div className="flex items-center mt-1 gap-2 flex-wrap">
                                                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-sm font-medium ${(customer as CustomerData).isActive ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'
                                                        }`}>
                                                        {(customer as CustomerData).isActive ? '✓ Active' : '✗ Inactive'}
                                                    </span>
                                                    {((customer as CustomerData).whtLiable) && (
                                                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-sm font-medium bg-sky-100 text-sky-800">
                                                            WHT liable
                                                        </span>
                                                    )}
                                                    {(() => {
                                                        const taxUi = describeCustomerTaxStatus(customer as CustomerData);
                                                        if (taxUi.status === 'VAT_INCOMPLETE') {
                                                            return (
                                                                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-sm font-medium bg-amber-100 text-amber-950">
                                                                    VAT incomplete
                                                                </span>
                                                            );
                                                        }
                                                        if (taxUi.status === 'VAT_REGISTERED') {
                                                            return (
                                                                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-sm font-medium bg-emerald-100 text-emerald-800">
                                                                    VAT registered
                                                                </span>
                                                            );
                                                        }
                                                        if (taxUi.status === 'EXEMPT') {
                                                            return (
                                                                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-sm font-medium bg-amber-100 text-amber-900">
                                                                    Tax exempt
                                                                </span>
                                                            );
                                                        }
                                                        return null;
                                                    })()}
                                                </div>
                                            </div>
                                        </div>

                                        {/* Customer Info */}
                                        <div className="bg-white rounded-lg border border-gray-200 p-4">
                                            <h3 className="text-lg font-semibold text-gray-900 mb-4">Customer Information</h3>
                                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                                                <div>
                                                    <span className="text-gray-500">Name:</span>
                                                    <span className="ml-2 text-gray-900 font-medium">{(customer as CustomerData).name}</span>
                                                </div>
                                                <div>
                                                    <span className="text-gray-500">Email:</span>
                                                    <span className="ml-2 text-gray-900">{(customer as CustomerData).email || '-'}</span>
                                                </div>
                                                <div>
                                                    <span className="text-gray-500">Phone:</span>
                                                    <span className="ml-2 text-gray-900">{(customer as CustomerData).phone || '-'}</span>
                                                </div>
                                                <div>
                                                    <span className="text-gray-500">Address:</span>
                                                    <span className="ml-2 text-gray-900">{(customer as CustomerData).address || '-'}</span>
                                                </div>
                                                <div>
                                                    <span className="text-gray-500">Withholding tax:</span>
                                                    <span className="ml-2 text-gray-900 font-medium">
                                                        {(customer as CustomerData).whtLiable
                                                            ? 'Liable (customer deducts WHT)'
                                                            : 'Not liable'}
                                                    </span>
                                                </div>
                                                <div>
                                                    <span className="text-gray-500">Customer Number:</span>
                                                    <span className="ml-2 text-gray-900 font-mono">{(customer as CustomerData).customerNumber || (customer as CustomerData).id?.slice(0, 8)}</span>
                                                </div>
                                                <div>
                                                    <span className="text-gray-500">Created:</span>
                                                    <span className="ml-2 text-gray-900">
                                                        {(customer as CustomerData).createdAt ? formatTimestampDate((customer as CustomerData).createdAt) : '-'}
                                                    </span>
                                                </div>
                                            </div>
                                        </div>

                                        <div className="bg-white rounded-lg border border-gray-200 p-4">
                                            <h3 className="text-lg font-semibold text-gray-900 mb-4">Tax details</h3>
                                            {isIncompleteVatRegistration(customer as CustomerData) && (
                                                <div
                                                    className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950"
                                                    role="status"
                                                >
                                                    This customer is marked VAT registered but has no TIN. Document tax may
                                                    still follow product VAT rules for registered customers; fix by adding a
                                                    TIN (Edit) or switching tax status to Standard if they are not VAT
                                                    registered.
                                                </div>
                                            )}
                                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                                                <div>
                                                    <span className="text-gray-500">Tax status:</span>
                                                    <span className="ml-2 text-gray-900 font-medium">
                                                        {describeCustomerTaxStatus(customer as CustomerData).label}
                                                    </span>
                                                </div>
                                                <div>
                                                    <span className="text-gray-500">TIN:</span>
                                                    <span className="ml-2 text-gray-900 font-mono">
                                                        {(customer as CustomerData).tin || '—'}
                                                    </span>
                                                </div>
                                                <div>
                                                    <span className="text-gray-500">Default VAT rate:</span>
                                                    <span className="ml-2 text-gray-900 font-medium">
                                                        {(customer as CustomerData).defaultVatRate != null
                                                            ? `${(customer as CustomerData).defaultVatRate}%`
                                                            : '—'}
                                                    </span>
                                                </div>
                                                <div>
                                                    <span className="text-gray-500">Allow tax override:</span>
                                                    <span className="ml-2 text-gray-900 font-medium">
                                                        {(customer as CustomerData).allowTaxOverride ? 'Yes' : 'No'}
                                                    </span>
                                                </div>
                                                <div>
                                                    <span className="text-gray-500">VAT registration date:</span>
                                                    <span className="ml-2 text-gray-900">
                                                        {(customer as CustomerData).vatRegistrationDate
                                                            ? formatTimestampDate(
                                                                  String(
                                                                      (customer as CustomerData).vatRegistrationDate,
                                                                  ).slice(0, 10),
                                                              )
                                                            : '—'}
                                                    </span>
                                                </div>
                                                <div>
                                                    <span className="text-gray-500">Effective from:</span>
                                                    <span className="ml-2 text-gray-900">
                                                        {(customer as CustomerData).taxEffectiveFrom
                                                            ? formatTimestampDate(
                                                                  String(
                                                                      (customer as CustomerData).taxEffectiveFrom,
                                                                  ).slice(0, 10),
                                                              )
                                                            : '—'}
                                                    </span>
                                                </div>
                                            </div>
                                        </div>

                                        {/* Summary Stats */}
                                        {sum && (
                                            <div className="bg-white rounded-lg border border-gray-200 p-4">
                                                <h3 className="text-lg font-semibold text-gray-900 mb-4">Activity Summary</h3>
                                                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4 text-sm">
                                                    <div className="text-center p-2 sm:p-3 bg-blue-50 rounded-lg">
                                                        <div className="text-xl sm:text-2xl font-bold text-blue-600">{sum.totalOrders || sum.totalInvoices || sum.totalSales || 0}</div>
                                                        <div className="text-gray-600">Total Invoices</div>
                                                    </div>
                                                    <div className="text-center p-2 sm:p-3 bg-green-50 rounded-lg">
                                                        <div className="text-xl sm:text-2xl font-bold text-green-600">{formatCurrency(Number(sum.lifetimeValue || sum.totalSpent) || 0)}</div>
                                                        <div className="text-gray-600">Lifetime Value</div>
                                                    </div>
                                                    <div className="text-center p-2 sm:p-3 bg-purple-50 rounded-lg">
                                                        <div className="text-xl sm:text-2xl font-bold text-purple-600">{formatCurrency(
                                                            (() => {
                                                                const total = Number(sum.lifetimeValue || sum.totalSpent) || 0;
                                                                const count = Number(sum.totalOrders || sum.totalInvoices || sum.totalSales) || 1;
                                                                return total / count;
                                                            })()
                                                        )}</div>
                                                        <div className="text-gray-600">Avg Invoice</div>
                                                    </div>
                                                    <div className="text-center p-2 sm:p-3 bg-yellow-50 rounded-lg">
                                                        <div className="text-xl sm:text-2xl font-bold text-yellow-600">{Number(sum.pendingInvoices) || 0}</div>
                                                        <div className="text-gray-600">Pending Invoices</div>
                                                    </div>
                                                </div>
                                            </div>
                                        )}

                                        {/* Quick Actions */}
                                        <div className="flex flex-wrap gap-3">
                                            <button
                                                onClick={() => setTab('edit')}
                                                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
                                            >
                                                ✏️ Edit Customer
                                            </button>
                                            <button
                                                onClick={handleToggleActive}
                                                className={`px-4 py-2 rounded-lg ${(customer as CustomerData).isActive
                                                    ? 'bg-yellow-100 text-yellow-800 hover:bg-yellow-200'
                                                    : 'bg-green-100 text-green-800 hover:bg-green-200'
                                                    }`}
                                            >
                                                {(customer as CustomerData).isActive ? '⏸️ Deactivate' : '▶️ Activate'}
                                            </button>
                                            <button
                                                onClick={() => setDeleteConfirmOpen(true)}
                                                className="px-4 py-2 bg-red-100 text-red-800 rounded-lg hover:bg-red-200"
                                            >
                                                🗑️ Delete
                                            </button>
                                        </div>
                                    </div>
                                )}

                                {/* Invoices Tab */}
                                {tab === 'invoices' && (
                                    <div className="space-y-4">
                                        <div className="flex items-center justify-between gap-4">
                                            <div>
                                                <h3 className="text-lg font-semibold text-gray-900">Invoices</h3>
                                                <p className="text-xs text-gray-500 mt-1">
                                                    Use <strong>Adjust</strong> to fix wrong prices or return goods.
                                                    Posted credit notes appear on the <strong>Transactions</strong> tab.
                                                </p>
                                            </div>
                                        </div>

                                        {isLoadingInvoices ? (
                                            <div className="text-center py-10 text-gray-500">Loading invoices…</div>
                                        ) : salesInvoices.length === 0 ? (
                                            <div className="text-center py-10 text-gray-500">No invoices found for this customer</div>
                                        ) : (
                                            <>
                                                {/* Mobile Invoice Cards */}
                                                <div className="block sm:hidden space-y-3">
                                                    {salesInvoices.map((inv: InvoiceRow) => {
                                                        const total = Number(inv.totalAmount || inv.total_amount || 0);
                                                        const paid = Number(inv.amountPaid || inv.amount_paid || 0);
                                                        const outstanding = Number(inv.balance ?? inv.amount_due ?? new Decimal(total).minus(paid).toNumber());
                                                        const invoiceNo = String(inv.invoiceNumber || inv.invoice_number || inv.id);
                                                        const status = (inv.status || '').toUpperCase();
                                                        const statusLabel = status === 'PARTIALLYPAID' || status === 'PARTIALLY_PAID' ? 'Partial' : status === 'PAID' ? 'Paid' : status === 'UNPAID' ? 'Unpaid' : inv.status;
                                                        const statusColor = status === 'PAID' ? 'bg-green-100 text-green-800' : (status.includes('PARTIAL') ? 'bg-yellow-100 text-yellow-800' : 'bg-red-100 text-red-800');
                                                        const isExpanded = expandedInvoiceId === inv.id;
                                                        return (
                                                            <div key={inv.id} className="border border-gray-200 rounded-lg p-3">
                                                                <div className="flex items-center justify-between mb-2">
                                                                    <span className="text-sm font-medium text-gray-900">{invoiceNo}</span>
                                                                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${statusColor}`}>{statusLabel}</span>
                                                                </div>
                                                                <div className="text-xs text-gray-500 mb-2">
                                                                    {inv.issueDate || inv.issue_date ? new Date(String(inv.issueDate || inv.issue_date)).toLocaleDateString() : '-'}
                                                                </div>
                                                                <div className="grid grid-cols-3 gap-2 text-center text-xs mb-2">
                                                                    <div>
                                                                        <div className="text-gray-500">Total</div>
                                                                        <div className="font-semibold">{formatCurrency(total)}</div>
                                                                    </div>
                                                                    <div>
                                                                        <div className="text-gray-500">Paid</div>
                                                                        <div className="text-gray-600">{formatCurrency(paid)}</div>
                                                                    </div>
                                                                    <div>
                                                                        <div className="text-gray-500">Due</div>
                                                                        <div className="font-semibold text-red-600">{formatCurrency(outstanding)}</div>
                                                                    </div>
                                                                </div>
                                                                <div className="flex gap-2 mb-2">
                                                                    <button
                                                                        onClick={() => toggleInvoiceInlineDetails(inv.id)}
                                                                        className="flex-1 py-1.5 text-xs bg-blue-50 text-blue-700 rounded-lg hover:bg-blue-100"
                                                                    >
                                                                        {isExpanded ? 'Hide Items' : 'View Items'}
                                                                    </button>
                                                                    <button
                                                                        onClick={() => handleDownloadInvoicePdf(inv.id, invoiceNo)}
                                                                        disabled={downloadingPdfId === inv.id}
                                                                        className="flex-1 py-1.5 text-xs bg-green-50 text-green-700 rounded-lg hover:bg-green-100 disabled:opacity-50"
                                                                    >
                                                                        {downloadingPdfId === inv.id ? 'Generating...' : 'Export PDF'}
                                                                    </button>
                                                                </div>
                                                                {isExpanded && (
                                                                    <div className="mt-2 border border-blue-200 rounded-lg p-2 bg-blue-50/30 space-y-2">
                                                                        {expandedInvoiceDetails?.sourceQuotation && (
                                                                            <InvoiceSourceQuotationPanel
                                                                                source={expandedInvoiceDetails.sourceQuotation}
                                                                                customer={{
                                                                                    name: (customer as CustomerData | undefined)?.name ?? '',
                                                                                    email: (customer as CustomerData | undefined)?.email ?? null,
                                                                                    phone: (customer as CustomerData | undefined)?.phone ?? null,
                                                                                }}
                                                                                invoiceAuthorisedByName={expandedInvoiceDetails.invoiceAuthorisedByName}
                                                                                className="!p-3"
                                                                            />
                                                                        )}
                                                                        {loadingExpandedInvoiceId === inv.id ? (
                                                                            <div className="text-xs text-gray-600">Loading invoice items...</div>
                                                                        ) : expandedInvoiceDetails?.items?.length ? (
                                                                            <div className="space-y-2">
                                                                                {expandedInvoiceDetails.items.map((item: InvoiceDetailItem, idx: number) => (
                                                                                    <div key={item.id || `${inv.id}-item-${idx}`} className="flex items-center justify-between text-xs">
                                                                                        <div>
                                                                                            <div className="font-medium text-gray-900">{item.productName || item.product_name || 'Item'}</div>
                                                                                            <div className="text-gray-500">Qty: {item.quantity || 0}</div>
                                                                                        </div>
                                                                                        <div className="font-semibold text-gray-900">{formatCurrency(Number(item.lineTotal || item.line_total || item.total_price || 0))}</div>
                                                                                    </div>
                                                                                ))}
                                                                            </div>
                                                                        ) : (
                                                                            <div className="text-xs text-gray-500">No line items found.</div>
                                                                        )}
                                                                    </div>
                                                                )}
                                                                {status !== 'PAID' && outstanding > 0 && (
                                                                    <button
                                                                        onClick={() => openReceivePayment({ ...inv, outstanding })}
                                                                        className="w-full py-1.5 text-xs bg-green-600 text-white rounded-lg hover:bg-green-700"
                                                                    >
                                                                        Receive Payment
                                                                    </button>
                                                                )}
                                                            </div>
                                                        );
                                                    })}
                                                </div>

                                                {/* Desktop Invoice Table */}
                                                <div className="hidden sm:block overflow-x-auto border border-gray-200 rounded-lg">
                                                    <table className="min-w-full divide-y divide-gray-200">
                                                        <thead className="bg-gray-50">
                                                            <tr>
                                                                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Invoice #</th>
                                                                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Date</th>
                                                                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Total</th>
                                                                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Paid</th>
                                                                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Outstanding</th>
                                                                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                                                                <th className="px-4 py-3" />
                                                            </tr>
                                                        </thead>
                                                        <tbody className="bg-white divide-y divide-gray-200">
                                                            {salesInvoices.map((inv: InvoiceRow) => {
                                                                const total = Number(inv.totalAmount || inv.total_amount || 0);
                                                                const paid = Number(inv.amountPaid || inv.amount_paid || 0);
                                                                const outstanding = Number(inv.balance ?? inv.amount_due ?? new Decimal(total).minus(paid).toNumber());
                                                                const invoiceNo = String(inv.invoiceNumber || inv.invoice_number || inv.id);
                                                                const status = (inv.status || '').toUpperCase();
                                                                const statusLabel = status === 'PARTIALLYPAID' || status === 'PARTIALLY_PAID' ? 'Partial' : status === 'PAID' ? 'Paid' : status === 'UNPAID' ? 'Unpaid' : inv.status;
                                                                const statusColor = status === 'PAID' ? 'bg-green-100 text-green-800' : (status.includes('PARTIAL') ? 'bg-yellow-100 text-yellow-800' : 'bg-red-100 text-red-800');
                                                                const isExpanded = expandedInvoiceId === inv.id;
                                                                return (
                                                                    <Fragment key={inv.id}>
                                                                        <tr key={inv.id} onClick={() => toggleInvoiceInlineDetails(inv.id)} className={`hover:bg-gray-50 cursor-pointer ${isExpanded ? 'bg-blue-50/40' : ''}`}>
                                                                            <td className="px-4 py-3 text-sm font-medium text-gray-900">{invoiceNo}</td>
                                                                            <td className="px-4 py-3 text-sm text-gray-600">{inv.issueDate || inv.issue_date ? new Date(String(inv.issueDate || inv.issue_date)).toLocaleDateString() : '-'}</td>
                                                                            <td className="px-4 py-3 text-sm text-right font-semibold">{formatCurrency(total)}</td>
                                                                            <td className="px-4 py-3 text-sm text-right text-gray-600">{formatCurrency(paid)}</td>
                                                                            <td className="px-4 py-3 text-sm text-right font-semibold text-red-600">{formatCurrency(outstanding)}</td>
                                                                            <td className="px-4 py-3"><span className={`px-2 py-1 rounded-full text-xs font-medium ${statusColor}`}>{statusLabel}</span></td>
                                                                            <td className="px-4 py-3 text-right">
                                                                                <div className="flex justify-end gap-2">
                                                                                    <button
                                                                                        onClick={(e) => {
                                                                                            e.stopPropagation();
                                                                                            toggleInvoiceInlineDetails(inv.id);
                                                                                        }}
                                                                                        className="px-3 py-1.5 text-sm bg-blue-50 text-blue-700 rounded-lg hover:bg-blue-100"
                                                                                    >
                                                                                        {isExpanded ? 'Hide' : 'View'}
                                                                                    </button>
                                                                                    <button
                                                                                        onClick={(e) => {
                                                                                            e.stopPropagation();
                                                                                            handleDownloadInvoicePdf(inv.id, invoiceNo);
                                                                                        }}
                                                                                        disabled={downloadingPdfId === inv.id}
                                                                                        className="px-3 py-1.5 text-sm bg-green-50 text-green-700 rounded-lg hover:bg-green-100 disabled:opacity-50"
                                                                                    >
                                                                                        {downloadingPdfId === inv.id ? 'Generating...' : 'PDF'}
                                                                                    </button>
                                                                                    {canAdjustInvoices && isAdjustableCustomerInvoice(inv) && (
                                                                                        <button
                                                                                            type="button"
                                                                                            onClick={(e) => {
                                                                                                e.stopPropagation();
                                                                                                setAdjustInvoice({ id: inv.id, invoiceNumber: invoiceNo });
                                                                                                setAdjustInvoiceOpen(true);
                                                                                            }}
                                                                                            className="px-3 py-1.5 text-sm border border-amber-500 text-amber-800 bg-amber-50 rounded-lg hover:bg-amber-100"
                                                                                        >
                                                                                            Adjust
                                                                                        </button>
                                                                                    )}
                                                                                    {status !== 'PAID' && outstanding > 0 && (
                                                                                        <button
                                                                                            onClick={(e) => {
                                                                                                e.stopPropagation();
                                                                                                openReceivePayment({ ...inv, outstanding });
                                                                                            }}
                                                                                            className="px-3 py-1.5 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700"
                                                                                        >
                                                                                            Receive Payment
                                                                                        </button>
                                                                                    )}
                                                                                </div>
                                                                            </td>
                                                                        </tr>
                                                                        {isExpanded && (
                                                                            <tr className="bg-blue-50/20">
                                                                                <td colSpan={7} className="px-4 py-4">
                                                                                    {loadingExpandedInvoiceId === inv.id ? (
                                                                                        <div className="text-sm text-gray-600">Loading invoice details...</div>
                                                                                    ) : expandedInvoiceDetails ? (
                                                                                        <div className="border border-blue-200 rounded-lg overflow-hidden bg-white">
                                                                                            <div className="bg-blue-50 px-4 py-3 flex items-center justify-between">
                                                                                                <div>
                                                                                                    <div className="text-sm font-semibold text-gray-900">{invoiceNo}</div>
                                                                                                    <div className="text-xs text-gray-600">Items and payment history</div>
                                                                                                </div>
                                                                                                <div className="flex gap-2">
                                                                                                    {canAdjustInvoices && isAdjustableCustomerInvoice(inv) && (
                                                                                                        <button
                                                                                                            type="button"
                                                                                                            onClick={() => {
                                                                                                                setAdjustInvoice({ id: inv.id, invoiceNumber: invoiceNo });
                                                                                                                setAdjustInvoiceOpen(true);
                                                                                                            }}
                                                                                                            className="px-3 py-1.5 text-xs border border-amber-500 text-amber-800 bg-amber-50 rounded-lg hover:bg-amber-100"
                                                                                                        >
                                                                                                            Adjust
                                                                                                        </button>
                                                                                                    )}
                                                                                                    <button
                                                                                                        onClick={() => handleDownloadInvoicePdf(inv.id, invoiceNo)}
                                                                                                        disabled={downloadingPdfId === inv.id}
                                                                                                        className="px-3 py-1.5 text-xs bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50"
                                                                                                    >
                                                                                                        {downloadingPdfId === inv.id ? 'Generating...' : 'Export PDF'}
                                                                                                    </button>
                                                                                                </div>
                                                                                            </div>
                                                                                            <div className="p-4 space-y-4">
                                                                                                {expandedInvoiceDetails.sourceQuotation && (
                                                                                                    <InvoiceSourceQuotationPanel
                                                                                                        source={expandedInvoiceDetails.sourceQuotation}
                                                                                                        customer={{
                                                                                                            name: (customer as CustomerData | undefined)?.name ?? '',
                                                                                                            email: (customer as CustomerData | undefined)?.email ?? null,
                                                                                                            phone: (customer as CustomerData | undefined)?.phone ?? null,
                                                                                                        }}
                                                                                                        invoiceAuthorisedByName={expandedInvoiceDetails.invoiceAuthorisedByName}
                                                                                                    />
                                                                                                )}
                                                                                                {expandedInvoiceDetails.items && expandedInvoiceDetails.items.length > 0 ? (
                                                                                                    <div>
                                                                                                        <h4 className="text-xs font-semibold text-gray-700 uppercase tracking-wide mb-2">Line Items</h4>
                                                                                                        <table className="min-w-full divide-y divide-gray-200 text-xs">
                                                                                                            <thead className="bg-gray-50">
                                                                                                                <tr>
                                                                                                                    <th className="px-3 py-2 text-left font-medium text-gray-500 uppercase">Item</th>
                                                                                                                    <th className="px-3 py-2 text-right font-medium text-gray-500 uppercase">Qty</th>
                                                                                                                    <th className="px-3 py-2 text-right font-medium text-gray-500 uppercase">Unit Price</th>
                                                                                                                    <th className="px-3 py-2 text-right font-medium text-gray-500 uppercase">Total</th>
                                                                                                                </tr>
                                                                                                            </thead>
                                                                                                            <tbody className="divide-y divide-gray-100">
                                                                                                                {expandedInvoiceDetails.items.map((item: InvoiceDetailItem, idx: number) => (
                                                                                                                    <tr key={item.id || `${inv.id}-detail-item-${idx}`}>
                                                                                                                        <td className="px-3 py-2 text-gray-900 font-medium">{item.productName || item.product_name || 'Item'}</td>
                                                                                                                        <td className="px-3 py-2 text-right text-gray-700">{Number(item.quantity || 0)}</td>
                                                                                                                        <td className="px-3 py-2 text-right text-gray-700">{formatCurrency(Number(item.unitPrice || item.unit_price || 0))}</td>
                                                                                                                        <td className="px-3 py-2 text-right text-gray-900 font-semibold">{formatCurrency(Number(item.lineTotal || item.line_total || item.total_price || 0))}</td>
                                                                                                                    </tr>
                                                                                                                ))}
                                                                                                            </tbody>
                                                                                                        </table>
                                                                                                    </div>
                                                                                                ) : (
                                                                                                    <div className="text-xs text-gray-500">No line items found for this invoice.</div>
                                                                                                )}

                                                                                                {expandedInvoiceDetails.payments && expandedInvoiceDetails.payments.length > 0 && (
                                                                                                    <div>
                                                                                                        <h4 className="text-xs font-semibold text-gray-700 uppercase tracking-wide mb-2">Payments</h4>
                                                                                                        <div className="space-y-2">
                                                                                                            {expandedInvoiceDetails.payments.map((payment: InvoiceDetailPayment, idx: number) => (
                                                                                                                <div key={payment.id || `${inv.id}-payment-${idx}`} className="flex items-center justify-between text-xs bg-green-50 px-3 py-2 rounded-lg">
                                                                                                                    <div className="text-gray-700">
                                                                                                                        <span className="font-medium">{payment.paymentMethod || 'Payment'}</span>
                                                                                                                        {payment.referenceNumber && <span className="ml-2 text-gray-500">Ref: {payment.referenceNumber}</span>}
                                                                                                                    </div>
                                                                                                                    <div className="font-semibold text-green-700">{formatCurrency(Number(payment.amount || 0))}</div>
                                                                                                                </div>
                                                                                                            ))}
                                                                                                        </div>
                                                                                                    </div>
                                                                                                )}
                                                                                            </div>
                                                                                        </div>
                                                                                    ) : (
                                                                                        <div className="text-sm text-gray-500">Unable to load invoice details.</div>
                                                                                    )}
                                                                                </td>
                                                                            </tr>
                                                                        )}
                                                                    </Fragment>
                                                                );
                                                            })}
                                                        </tbody>
                                                    </table>
                                                </div>

                                                <div className="flex items-center justify-between">
                                                    <div className="text-sm text-gray-700">Page {invoicePage}</div>
                                                    <div className="flex gap-2">
                                                        <button onClick={() => setInvoicePage(Math.max(1, invoicePage - 1))} disabled={invoicePage === 1} className="px-3 py-1 border border-gray-300 rounded bg-white hover:bg-gray-50 disabled:opacity-50">Previous</button>
                                                        <button onClick={() => setInvoicePage(invoicePage + 1)} className="px-3 py-1 border border-gray-300 rounded bg-white hover:bg-gray-50">Next</button>
                                                    </div>
                                                </div>
                                            </>
                                        )}

                                        {/* Receive Payment Modal */}
                                        {paymentOpen && selectedInvoice && (
                                            <div className="fixed inset-0 z-[60] flex items-center justify-center">
                                                <div className="absolute inset-0 bg-black/40" onClick={() => setPaymentOpen(false)} />
                                                <div className="relative bg-white rounded-lg shadow-xl p-6 max-w-md w-full mx-4 z-10">
                                                    <h3 className="text-lg font-semibold text-gray-900 mb-1">Receive Payment</h3>
                                                    <p className="text-sm text-gray-500 mb-4">
                                                        Invoice: <span className="font-medium">{selectedInvoice.invoiceNumber || selectedInvoice.invoice_number}</span>
                                                        {' — Outstanding: '}<span className="font-medium text-red-600">{formatCurrency(selectedInvoice.outstanding)}</span>
                                                    </p>

                                                    <form className="space-y-3" onSubmit={async (e) => {
                                                        e.preventDefault();
                                                        try {
                                                            const outstanding = money2(selectedInvoice.outstanding);
                                                            const amt = money2(payAmount);
                                                            if (payMethod === 'DEPOSIT') {
                                                                assertDepositPaymentAmount({
                                                                    amount: amt,
                                                                    outstanding,
                                                                    depositAvailable: depositBalance.available,
                                                                });
                                                            } else if (amt.lte(0) || amt.gt(outstanding)) {
                                                                alert('Invalid amount');
                                                                return;
                                                            }
                                                            await recordPayment.mutateAsync({
                                                                invoiceId: String(selectedInvoice.id),
                                                                data: {
                                                                    amount: amt.toNumber(),
                                                                    paymentMethod: payMethod,
                                                                    referenceNumber: payRefNum || undefined,
                                                                    notes: payNotes || undefined,
                                                                },
                                                            });
                                                            alert(payMethod === 'DEPOSIT'
                                                                ? '✅ Payment recorded from customer deposit.'
                                                                : '✅ Payment recorded successfully!');
                                                            setPaymentOpen(false);
                                                            setSelectedInvoice(null);
                                                            refetchInvoices();
                                                            refetchCustomer();
                                                        } catch (err: unknown) {
                                                            const axErr = err instanceof AxiosError ? err.response?.data?.error : undefined;
                                                            alert(`❌ Payment failed: ${axErr || (err instanceof Error ? err.message : 'Unknown error')}`);
                                                        }
                                                    }}>
                                                        <div>
                                                            <label className="block text-sm font-medium text-gray-700 mb-1">Amount *</label>
                                                            <input
                                                                type="number"
                                                                value={payAmount}
                                                                onChange={(e) => setPayAmount(e.target.value)}
                                                                max={payMethod === 'DEPOSIT'
                                                                    ? depositPaymentCap(selectedInvoice.outstanding, depositBalance.available).toNumber()
                                                                    : money2(selectedInvoice.outstanding).toNumber()}
                                                                min={0.01}
                                                                step="1"
                                                                placeholder={`Max: ${payMethod === 'DEPOSIT'
                                                                    ? depositPaymentCap(selectedInvoice.outstanding, depositBalance.available).toFixed(2)
                                                                    : money2(selectedInvoice.outstanding).toFixed(2)}`}
                                                                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                                                                autoFocus
                                                                required
                                                            />
                                                        </div>
                                                        <div>
                                                            <label className="block text-sm font-medium text-gray-700 mb-1">Payment Method</label>
                                                            <select
                                                                value={payMethod}
                                                                onChange={(e) => {
                                                                    const next = e.target.value;
                                                                    setPayMethod(next);
                                                                    if (next === 'DEPOSIT' && depositBalance.hasDeposit) {
                                                                        setPayAmount(
                                                                            depositPaymentCap(
                                                                                selectedInvoice.outstanding,
                                                                                depositBalance.available,
                                                                            ).toFixed(2),
                                                                        );
                                                                    }
                                                                }}
                                                                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                                                                disabled={depositBalance.status === 'loading'}
                                                            >
                                                                <option value="CASH">Cash</option>
                                                                <option value="CARD">Card</option>
                                                                <option value="MOBILE_MONEY">Mobile Money</option>
                                                                <option value="BANK_TRANSFER">Bank Transfer</option>
                                                                <option
                                                                    value="DEPOSIT"
                                                                    disabled={depositBalance.status !== 'ready' || depositBalance.available.lte(0)}
                                                                >
                                                                    {depositBalance.status === 'loading'
                                                                        ? 'Customer Deposit (Loading...)'
                                                                        : depositBalance.status === 'error'
                                                                            ? 'Customer Deposit (unavailable — retry)'
                                                                            : depositBalance.available.gt(0)
                                                                                ? `Customer Deposit (${formatCurrency(depositBalance.available.toNumber())} available)`
                                                                                : 'Customer Deposit (none available)'}
                                                                </option>
                                                            </select>
                                                            {depositBalance.status === 'error' && (
                                                                <p className="mt-1 text-sm text-red-700">
                                                                    Could not load deposit balance. {depositBalance.error}
                                                                    {' '}
                                                                    <button type="button" className="underline font-medium" onClick={depositBalance.retry}>
                                                                        Retry
                                                                    </button>
                                                                </p>
                                                            )}
                                                            {payMethod === 'DEPOSIT' && depositBalance.hasDeposit && (
                                                                <p className="mt-1 text-sm text-amber-700">
                                                                    Applying customer deposit. Available: {formatCurrency(depositBalance.available.toNumber())}
                                                                </p>
                                                            )}
                                                        </div>
                                                        <div>
                                                            <label className="block text-sm font-medium text-gray-700 mb-1">Reference #</label>
                                                            <input
                                                                type="text"
                                                                value={payRefNum}
                                                                onChange={(e) => setPayRefNum(e.target.value)}
                                                                placeholder="Optional"
                                                                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                                                            />
                                                        </div>
                                                        <div>
                                                            <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                                                            <textarea
                                                                value={payNotes}
                                                                onChange={(e) => setPayNotes(e.target.value)}
                                                                rows={2}
                                                                placeholder="Optional"
                                                                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                                                                onKeyDown={(e) => {
                                                                    if (e.key === 'Enter' && !e.shiftKey) {
                                                                        e.preventDefault();
                                                                        e.currentTarget.form?.requestSubmit();
                                                                    }
                                                                }}
                                                            />
                                                        </div>

                                                        <div className="flex justify-end gap-3 mt-5">
                                                            <button
                                                                type="button"
                                                                onClick={() => setPaymentOpen(false)}
                                                                className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200"
                                                            >
                                                                Cancel
                                                            </button>
                                                            <button
                                                                type="submit"
                                                                disabled={
                                                                    recordPayment.isPending
                                                                    || depositBalance.status === 'loading'
                                                                    || (payMethod === 'DEPOSIT' && depositBalance.status !== 'ready')
                                                                    || !payAmount
                                                                    || money2(payAmount).lte(0)
                                                                    || money2(payAmount).gt(
                                                                        payMethod === 'DEPOSIT'
                                                                            ? depositPaymentCap(selectedInvoice.outstanding, depositBalance.available)
                                                                            : money2(selectedInvoice.outstanding),
                                                                    )
                                                                }
                                                                className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50"
                                                            >
                                                                {recordPayment.isPending ? 'Processing...' : 'Save Payment'}
                                                            </button>
                                                        </div>
                                                    </form>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                )}

                                {/* Transactions Tab (Statement) */}
                                {tab === 'transactions' && (
                                    <div className="space-y-4">
                                        <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-end gap-3">
                                            <div className="grid grid-cols-2 gap-2 sm:flex sm:gap-3">
                                                <div>
                                                    <label className="block text-xs text-gray-600">Start Date</label>
                                                    <DatePicker
                                                        value={stmtStart}
                                                        onChange={(date) => { setStmtStart(date); setStmtPage(1); }}
                                                        placeholder="Start date"
                                                        maxDate={stmtEnd ? new Date(stmtEnd) : undefined}
                                                    />
                                                </div>
                                                <div>
                                                    <label className="block text-xs text-gray-600">End Date</label>
                                                    <DatePicker
                                                        value={stmtEnd}
                                                        onChange={(date) => { setStmtEnd(date); setStmtPage(1); }}
                                                        placeholder="End date"
                                                        minDate={stmtStart ? new Date(stmtStart) : undefined}
                                                    />
                                                </div>
                                            </div>
                                            <div className="flex gap-2">
                                                <button
                                                    onClick={() => { setStmtStart(''); setStmtEnd(''); setStmtPage(1); }}
                                                    className="px-3 py-2 border border-gray-300 rounded bg-white hover:bg-gray-50 text-sm"
                                                >
                                                    Reset
                                                </button>
                                                <div className="flex gap-2 sm:ml-auto">
                                                    <button
                                                        onClick={() => {
                                                            const params = [
                                                                stmtStart ? `start=${new Date(stmtStart).toISOString()}` : '',
                                                                stmtEnd ? `end=${new Date(stmtEnd).toISOString()}` : ''
                                                            ].filter(Boolean).join('&');
                                                            const url = `/customers/${customerId}/statement/export.csv${params ? '?' + params : ''}`;
                                                            downloadFile(url, `statement-${customerId}-${getBusinessDate()}.csv`);
                                                        }}
                                                        className="px-3 py-2 border border-gray-300 rounded bg-white hover:bg-gray-50 text-sm"
                                                    >
                                                        Export CSV
                                                    </button>
                                                    <button
                                                        onClick={() => {
                                                            const params = [
                                                                stmtStart ? `start=${new Date(stmtStart).toISOString()}` : '',
                                                                stmtEnd ? `end=${new Date(stmtEnd).toISOString()}` : ''
                                                            ].filter(Boolean).join('&');
                                                            const url = `/customers/${customerId}/statement/export.pdf${params ? '?' + params : ''}`;
                                                            downloadFile(url, `statement-${customerId}-${getBusinessDate()}.pdf`);
                                                        }}
                                                        className="px-3 py-2 border border-gray-300 rounded bg-white hover:bg-gray-50 text-sm"
                                                    >
                                                        Export PDF
                                                    </button>
                                                </div>
                                            </div>
                                        </div>

                                        {stmtView === 'smart' && customerId && (
                                            <CustomerSmartStatementPanel
                                                customerId={customerId}
                                                startDate={stmtStart}
                                                endDate={stmtEnd}
                                            />
                                        )}

                                        {stmtView === 'legacy' && (
                                        <>
                                        {/* Summary Cards */}
                                        {(() => {
                                            const stmt = statement as StatementResponse | undefined;
                                            if (!stmt) return null;
                                            return (
                                            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                                <div className="bg-gray-50 border border-gray-200 rounded p-3">
                                                    <div className="text-xs text-gray-600">Opening Balance</div>
                                                    <div className={`text-lg font-semibold ${Number(stmt.openingBalance || 0) > 0 ? 'text-red-600' : Number(stmt.openingBalance || 0) < 0 ? 'text-green-600' : ''}`}>
                                                        {formatCurrency(Math.abs(Number(stmt.openingBalance || 0)))}
                                                        {Number(stmt.openingBalance || 0) < 0 && <span className="text-xs ml-1">(CR)</span>}
                                                    </div>
                                                </div>
                                                <div className="bg-gray-50 border border-gray-200 rounded p-3">
                                                    <div className="text-xs text-gray-600">Closing Balance</div>
                                                    <div className={`text-lg font-semibold ${Number(stmt.closingBalance || 0) > 0 ? 'text-red-600' : Number(stmt.closingBalance || 0) < 0 ? 'text-green-600' : ''}`}>
                                                        {formatCurrency(Math.abs(Number(stmt.closingBalance || 0)))}
                                                        {Number(stmt.closingBalance || 0) < 0 && <span className="text-xs ml-1">(CR)</span>}
                                                    </div>
                                                </div>
                                                <div className="bg-gray-50 border border-gray-200 rounded p-3">
                                                    <div className="text-xs text-gray-600">Period</div>
                                                    <div className="text-sm">
                                                        {stmt.periodStart ? new Date(String(stmt.periodStart)).toLocaleDateString() : 'All time'} →{' '}
                                                        {stmt.periodEnd ? new Date(String(stmt.periodEnd)).toLocaleDateString() : 'Now'}
                                                    </div>
                                                </div>
                                            </div>
                                            );
                                        })()}

                                        {statement != null && (() => {
                                            const entries = (statement as StatementResponse).entries || [];
                                            const closing = Number((statement as StatementResponse).closingBalance || 0);
                                            const ledgerOverpaid = entries.some(
                                                (e) => Number(e.balanceAfter ?? 0) < -0.01,
                                            );
                                            if (!ledgerOverpaid || Math.abs(closing) > 0.01) return null;
                                            return (
                                                <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                                                    A payment in this list exceeds what was owed after credit notes.
                                                    Closing balance is <strong>{formatCurrency(0)}</strong> (correct AR).
                                                    Reverse or correct the extra receipt (e.g. duplicate payment) in accounting.
                                                </div>
                                            );
                                        })()}

                                        {/* Statement - Mobile Cards */}
                                        <div className="block sm:hidden space-y-3">
                                            {!statement || ((statement as StatementResponse).entries || []).length === 0 ? (
                                                <div className="text-center py-8 text-gray-500">No transactions in this period</div>
                                            ) : ((statement as StatementResponse).entries || []).map((e: StatementEntry, idx: number) => (
                                                <div key={idx} className="border border-gray-200 rounded-lg p-3">
                                                    <div className="flex items-center justify-between mb-2">
                                                        <span className="text-xs text-gray-500">{formatTimestampDate(e.date)}</span>
                                                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${e.type === 'INVOICE' ? 'bg-blue-100 text-blue-800' :
                                                            e.type === 'PAYMENT' ? 'bg-green-100 text-green-800' :
                                                                'bg-gray-100 text-gray-800'
                                                            }`}>
                                                            {e.type}
                                                        </span>
                                                    </div>
                                                    {(e.reference || e.description) && (
                                                        <div className="text-xs text-gray-600 mb-2 truncate">
                                                            {e.reference && <span className="font-medium">{e.reference}</span>}
                                                            {e.reference && e.description && ' — '}
                                                            {e.description}
                                                        </div>
                                                    )}
                                                    <div className="grid grid-cols-3 gap-2 text-center text-xs">
                                                        <div>
                                                            <div className="text-gray-500">Debit</div>
                                                            <div className="text-red-600 font-medium">{e.debit ? formatCurrency(Number(e.debit)) : '-'}</div>
                                                        </div>
                                                        <div>
                                                            <div className="text-gray-500">Credit</div>
                                                            <div className="text-green-600 font-medium">{e.credit ? formatCurrency(Number(e.credit)) : '-'}</div>
                                                        </div>
                                                        <div>
                                                            <div className="text-gray-500">Balance</div>
                                                            <div className={`font-semibold ${Number(e.balanceAfter || 0) > 0 ? 'text-red-600' : Number(e.balanceAfter || 0) < 0 ? 'text-green-600' : ''}`}>
                                                                {formatCurrency(Math.abs(Number(e.balanceAfter || 0)))}
                                                                {Number(e.balanceAfter || 0) < 0 && <span className="ml-0.5">(CR)</span>}
                                                            </div>
                                                        </div>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>

                                        {/* Statement - Desktop Table */}
                                        <div className="hidden sm:block overflow-x-auto border border-gray-200 rounded-lg">
                                            <table className="min-w-full divide-y divide-gray-200">
                                                <thead className="bg-gray-50">
                                                    <tr>
                                                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Date</th>
                                                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Type</th>
                                                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Reference</th>
                                                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Description</th>
                                                        <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Debit</th>
                                                        <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Credit</th>
                                                        <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Balance</th>
                                                    </tr>
                                                </thead>
                                                <tbody className="bg-white divide-y divide-gray-200">
                                                    {!statement || ((statement as StatementResponse).entries || []).length === 0 ? (
                                                        <tr>
                                                            <td colSpan={7} className="px-4 py-8 text-center text-gray-500">
                                                                No transactions in this period
                                                            </td>
                                                        </tr>
                                                    ) : ((statement as StatementResponse).entries || []).map((e: StatementEntry, idx: number) => (
                                                        <tr key={idx} className="hover:bg-gray-50">
                                                            <td className="px-4 py-3 text-sm text-gray-600">{formatTimestampDate(e.date)}</td>
                                                            <td className="px-4 py-3 text-sm">
                                                                <span className={`px-2 py-1 rounded-full text-xs font-medium ${e.type === 'INVOICE' ? 'bg-blue-100 text-blue-800' :
                                                                    e.type === 'PAYMENT' ? 'bg-green-100 text-green-800' :
                                                                        'bg-gray-100 text-gray-800'
                                                                    }`}>
                                                                    {e.type}
                                                                </span>
                                                            </td>
                                                            <td className="px-4 py-3 text-sm text-gray-600">{e.reference || '-'}</td>
                                                            <td className="px-4 py-3 text-sm text-gray-600">{e.description || '-'}</td>
                                                            <td className="px-4 py-3 text-sm text-right text-red-600">{e.debit ? formatCurrency(Number(e.debit)) : '-'}</td>
                                                            <td className="px-4 py-3 text-sm text-right text-green-600">{e.credit ? formatCurrency(Number(e.credit)) : '-'}</td>
                                                            <td className={`px-4 py-3 text-sm text-right font-semibold ${Number(e.balanceAfter || 0) > 0 ? 'text-red-600' : Number(e.balanceAfter || 0) < 0 ? 'text-green-600' : ''}`}>
                                                                {formatCurrency(Math.abs(Number(e.balanceAfter || 0)))}
                                                                {Number(e.balanceAfter || 0) < 0 && <span className="text-xs ml-1">(CR)</span>}
                                                            </td>
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                        </div>

                                        {/* Pagination */}
                                        <div className="flex items-center justify-between">
                                            <div className="text-sm text-gray-700">Page {stmtPage}</div>
                                            <div className="flex gap-2">
                                                <button
                                                    onClick={() => setStmtPage(Math.max(1, stmtPage - 1))}
                                                    disabled={stmtPage === 1}
                                                    className="px-3 py-1 border border-gray-300 rounded bg-white hover:bg-gray-50 disabled:opacity-50"
                                                >
                                                    Previous
                                                </button>
                                                <button
                                                    onClick={() => setStmtPage(stmtPage + 1)}
                                                    className="px-3 py-1 border border-gray-300 rounded bg-white hover:bg-gray-50"
                                                >
                                                    Next
                                                </button>
                                            </div>
                                        </div>
                                        </>
                                        )}
                                    </div>
                                )}

                                {/* Deposits Tab */}
                                {tab === 'deposits' && customerId && customer && (
                                    <CustomerDeposits
                                        customerId={customerId}
                                        customerName={String((customer as { name?: string }).name ?? '').trim() || 'Customer'}
                                    />
                                )}

                                {/* Quotations Tab */}
                                {tab === 'quotations' && customerId && (
                                    <CustomerQuotationsTab customerId={customerId} />
                                )}

                                {/* Edit Tab */}
                                {tab === 'edit' && (
                                    <form onSubmit={onEditSubmit} className="space-y-4 max-w-xl">
                                        <div>
                                            <label htmlFor="customerName" className="block text-sm font-medium text-gray-700 mb-1">Name *</label>
                                            <input
                                                id="customerName"
                                                name="name"
                                                type="text"
                                                defaultValue={(customer as CustomerData).name}
                                                required
                                                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                                            />
                                        </div>
                                        <div>
                                            <label htmlFor="customerEmail" className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                                            <input
                                                id="customerEmail"
                                                name="email"
                                                type="email"
                                                defaultValue={(customer as CustomerData).email || ''}
                                                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                                            />
                                        </div>
                                        <div>
                                            <label htmlFor="customerPhone" className="block text-sm font-medium text-gray-700 mb-1">Phone</label>
                                            <input
                                                id="customerPhone"
                                                name="phone"
                                                type="tel"
                                                defaultValue={(customer as CustomerData).phone || ''}
                                                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                                            />
                                        </div>
                                        <div>
                                            <label htmlFor="customerAddress" className="block text-sm font-medium text-gray-700 mb-1">Address</label>
                                            <textarea
                                                id="customerAddress"
                                                name="address"
                                                defaultValue={(customer as CustomerData).address || ''}
                                                rows={2}
                                                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                                            />
                                        </div>
                                        <div>
                                            <label htmlFor="customerCreditLimit" className="block text-sm font-medium text-gray-700 mb-1">Credit Limit</label>
                                            <input
                                                id="customerCreditLimit"
                                                name="creditLimit"
                                                type="number"
                                                defaultValue={(customer as CustomerData).creditLimit || 0}
                                                min={0}
                                                step={1000}
                                                disabled={editUnlimitedCredit}
                                                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100 disabled:text-gray-500"
                                            />
                                            <label className="mt-2 flex items-center gap-2 text-sm text-gray-800 cursor-pointer select-none">
                                                <input
                                                    type="checkbox"
                                                    checked={editUnlimitedCredit}
                                                    onChange={(e) => setEditUnlimitedCredit(e.target.checked)}
                                                    className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                                                />
                                                <span>
                                                    <span className="font-medium">Unlimited credit</span>
                                                    <span className="text-gray-500"> — on-account sales not capped by limit</span>
                                                </span>
                                            </label>
                                            {editUnlimitedCredit ? (
                                                <p className="mt-1 text-xs text-indigo-700">
                                                    Hard credit ceiling is off. Optional amount above is kept only as a soft reference.
                                                </p>
                                            ) : null}
                                        </div>
                                        <div>
                                            <label htmlFor="customerPriceGroup" className="block text-sm font-medium text-gray-700 mb-1">Price Group</label>
                                            <select
                                                id="customerPriceGroup"
                                                value={editPriceGroupId}
                                                onChange={(e) => setEditPriceGroupId(e.target.value)}
                                                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                                            >
                                                <option value="">— Standard pricing —</option>
                                                {priceGroups.map((pg) => (
                                                    <option key={pg.id} value={pg.id}>
                                                        {pg.name}{pg.pricingMode === 'AT_COST' ? ' (At Cost — 0% margin)' : ''}
                                                    </option>
                                                ))}
                                            </select>
                                            <p className="mt-1 text-xs text-gray-500">
                                                Set to <strong>At Cost</strong> to always sell to this customer at inventory cost price (zero margin).
                                            </p>
                                        </div>
                                        <div className="rounded-lg border border-gray-200 bg-white p-4 space-y-4">
                                            <div>
                                                <p className="text-sm font-semibold text-gray-900">Tax details</p>
                                                <p className="text-xs text-gray-500 mt-0.5">
                                                    DocumentTax uses this profile for output VAT determination on sales, invoices, and credit notes.
                                                </p>
                                            </div>

                                            <fieldset className="space-y-2">
                                                <legend className="text-sm font-medium text-gray-700">Tax status</legend>
                                                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                                                    {(
                                                        [
                                                            {
                                                                id: 'standard',
                                                                label: 'Standard',
                                                                hint: 'Product / mapping tax rules apply',
                                                                active: !editVatRegistered && !editTaxExempt,
                                                                onSelect: () => {
                                                                    setEditVatRegistered(false);
                                                                    setEditTaxExempt(false);
                                                                },
                                                            },
                                                            {
                                                                id: 'vat',
                                                                label: 'VAT registered',
                                                                hint: 'B2B VAT customer',
                                                                active: editVatRegistered && !editTaxExempt,
                                                                onSelect: () => {
                                                                    setEditVatRegistered(true);
                                                                    setEditTaxExempt(false);
                                                                },
                                                            },
                                                            {
                                                                id: 'exempt',
                                                                label: 'Tax exempt',
                                                                hint: 'No output VAT',
                                                                active: editTaxExempt,
                                                                onSelect: () => {
                                                                    setEditTaxExempt(true);
                                                                    setEditVatRegistered(false);
                                                                },
                                                            },
                                                        ] as const
                                                    ).map((opt) => (
                                                        <button
                                                            key={opt.id}
                                                            type="button"
                                                            onClick={opt.onSelect}
                                                            className={`text-left rounded-lg border px-3 py-2 transition-colors ${
                                                                opt.active
                                                                    ? 'border-blue-600 bg-blue-50 ring-1 ring-blue-600'
                                                                    : 'border-gray-200 bg-gray-50 hover:border-gray-300'
                                                            }`}
                                                            aria-pressed={opt.active}
                                                        >
                                                            <span className="block text-sm font-medium text-gray-900">
                                                                {opt.label}
                                                            </span>
                                                            <span className="block text-xs text-gray-500 mt-0.5">
                                                                {opt.hint}
                                                            </span>
                                                        </button>
                                                    ))}
                                                </div>
                                            </fieldset>

                                            {(editVatRegistered && !editTaxExempt) && (
                                                <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-950">
                                                    TIN is required for VAT-registered customers (e.g. Uganda TIN). Leave empty only if you set status to Standard.
                                                </div>
                                            )}

                                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                                <div className="sm:col-span-2">
                                                    <Label htmlFor="modal-customer-tin" className="text-sm font-medium text-gray-700">
                                                        TIN
                                                        {editVatRegistered && !editTaxExempt ? (
                                                            <span className="text-red-600"> *</span>
                                                        ) : null}
                                                    </Label>
                                                    <input
                                                        id="modal-customer-tin"
                                                        value={editTin}
                                                        onChange={(e) => setEditTin(e.target.value)}
                                                        className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 bg-white font-mono text-sm"
                                                        placeholder="e.g. 100011036589475"
                                                        autoComplete="off"
                                                        required={editVatRegistered && !editTaxExempt}
                                                    />
                                                </div>

                                                <div>
                                                    <Label htmlFor="modal-customer-default-vat" className="text-sm font-medium text-gray-700">
                                                        Default VAT rate (%)
                                                    </Label>
                                                    <input
                                                        id="modal-customer-default-vat"
                                                        type="number"
                                                        step={1}
                                                        value={editDefaultVatRate}
                                                        onChange={(e) => setEditDefaultVatRate(e.target.value)}
                                                        disabled={editTaxExempt}
                                                        className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 bg-white disabled:bg-gray-100 disabled:text-gray-500"
                                                        placeholder="18"
                                                    />
                                                    <p className="mt-1 text-xs text-gray-500">
                                                        Used when a line has no product tax mapping or bridge rate.
                                                    </p>
                                                </div>

                                                <div>
                                                    <Label htmlFor="modal-customer-vat-reg-date" className="text-sm font-medium text-gray-700">
                                                        VAT registration date
                                                    </Label>
                                                    <div className="mt-1">
                                                        <DatePicker
                                                            id="modal-customer-vat-reg-date"
                                                            value={editVatRegistrationDate}
                                                            onChange={setEditVatRegistrationDate}
                                                            placeholder="Select registration date"
                                                            disabled={editTaxExempt}
                                                            aria-label="VAT registration date"
                                                        />
                                                    </div>
                                                </div>

                                                <div className="sm:col-span-2">
                                                    <Label htmlFor="modal-customer-tax-effective" className="text-sm font-medium text-gray-700">
                                                        Effective from
                                                    </Label>
                                                    <div className="mt-1 max-w-sm">
                                                        <DatePicker
                                                            id="modal-customer-tax-effective"
                                                            value={editTaxEffectiveFrom}
                                                            onChange={setEditTaxEffectiveFrom}
                                                            placeholder="Select effective date"
                                                            disabled={editTaxExempt}
                                                            aria-label="Tax profile effective from"
                                                        />
                                                    </div>
                                                    <p className="mt-1 text-xs text-gray-500">
                                                        Profile is inactive for DocumentTax before this business date (falls back to registration date if empty).
                                                    </p>
                                                </div>
                                            </div>

                                            <div className="border-t border-gray-100 pt-3">
                                                <div className="flex items-start gap-3">
                                                    <Checkbox
                                                        id="modal-customer-allow-tax-override"
                                                        checked={editAllowTaxOverride}
                                                        onCheckedChange={(checked) =>
                                                            setEditAllowTaxOverride(checked === true)
                                                        }
                                                    />
                                                    <div>
                                                        <Label
                                                            htmlFor="modal-customer-allow-tax-override"
                                                            className="text-sm font-medium text-gray-900"
                                                        >
                                                            Allow tax override
                                                        </Label>
                                                        <p className="text-xs text-gray-600 mt-0.5">
                                                            Lets cashiers with <span className="font-mono">sales.tax_override</span> force
                                                            exempt or a custom rate on a document (audited).
                                                        </p>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                        <div className="rounded-lg border border-sky-200 bg-sky-50/60 p-4 space-y-3">
                                            <div className="flex items-start gap-3">
                                                <Checkbox
                                                    id="modal-customer-wht-liable"
                                                    checked={editWhtLiable}
                                                    onCheckedChange={(checked) => {
                                                        const on = checked === true;
                                                        setEditWhtLiable(on);
                                                        if (!on) setEditDefaultWhtTypeId('');
                                                    }}
                                                />
                                                <div>
                                                    <Label htmlFor="modal-customer-wht-liable" className="text-sm font-medium text-gray-900">
                                                        Customer withholds tax (WHT receivable)
                                                    </Label>
                                                    <p className="text-xs text-gray-600 mt-0.5">
                                                        When this customer deducts WHT from payments to you, receipts will suggest that type.
                                                    </p>
                                                </div>
                                            </div>
                                            {editWhtLiable && (
                                                <div>
                                                    <Label htmlFor="modal-customer-default-wht" className="text-sm font-medium text-gray-700">
                                                        Default WHT type
                                                    </Label>
                                                    <select
                                                        id="modal-customer-default-wht"
                                                        value={editDefaultWhtTypeId}
                                                        onChange={(e) => setEditDefaultWhtTypeId(e.target.value)}
                                                        className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 bg-white"
                                                    >
                                                        <option value="">— Select when receiving payment —</option>
                                                        {customerWhtTypes.map((t) => (
                                                            <option key={t.id} value={t.id}>
                                                                {t.code} — {t.name} ({(Number(t.rate) * 100).toFixed(1)}%)
                                                            </option>
                                                        ))}
                                                    </select>
                                                    {customerWhtTypes.length === 0 && (
                                                        <p className="text-xs text-amber-800 mt-1">
                                                            No customer WHT types yet. Create one under Accounting → Withholding Tax.
                                                        </p>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                        <div className="flex gap-3 pt-4">
                                            <button
                                                type="submit"
                                                disabled={updateCustomer.isPending}
                                                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
                                            >
                                                {updateCustomer.isPending ? 'Saving...' : 'Save Changes'}
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setTab('overview')}
                                                className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200"
                                            >
                                                Cancel
                                            </button>
                                        </div>
                                    </form>
                                )}
                            </>
                        )}
                    </div>

                    {/* Delete Confirmation Modal */}
                    {deleteConfirmOpen && (
                        <div className="absolute inset-0 bg-black/40 flex items-center justify-center z-10">
                            <div className="bg-white rounded-lg shadow-xl p-6 max-w-md mx-4">
                                <h3 className="text-lg font-semibold text-gray-900 mb-4">Delete Customer?</h3>
                                <p className="text-gray-600 mb-6">
                                    Are you sure you want to delete <strong>{(customer as CustomerData | undefined)?.name}</strong>? This action cannot be undone.
                                </p>
                                <div className="flex justify-end gap-3">
                                    <button
                                        onClick={() => setDeleteConfirmOpen(false)}
                                        className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200"
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        onClick={handleDelete}
                                        disabled={deleteCustomerM.isPending}
                                        className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50"
                                    >
                                        {deleteCustomerM.isPending ? 'Deleting...' : 'Delete'}
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}

                </div>
            </div>
            {adjustInvoice && (
                <AdjustCustomerInvoiceModal
                    open={adjustInvoiceOpen}
                    onClose={() => {
                        setAdjustInvoiceOpen(false);
                        setAdjustInvoice(null);
                        void refetchInvoices();
                        void refetchCustomer();
                    }}
                    invoiceId={adjustInvoice.id}
                    invoiceNumber={adjustInvoice.invoiceNumber}
                    customerId={customerId ?? undefined}
                />
            )}
        </div>
    );
}