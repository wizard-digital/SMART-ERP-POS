import { useMemo, useState, useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import Layout from '../../components/Layout';
import { formatCurrency } from '../../utils/currency';
import { downloadFile } from '../../utils/download';
import { useCustomer, useCustomerSummary, useCustomerTransactions, useUpdateCustomer, useInvoices, useRecordInvoicePayment, useInvoicePayments, useCreateInvoice, useCustomerSales, useInvoice, useCustomerStatement, useToggleCustomerActive, useDeleteCustomer } from '../../hooks/useApi';
import { api } from '../../utils/api';
import { AxiosError } from 'axios';
import { useModalAccessibility } from '../../hooks/useFocusTrap';
import CustomerDeposits from '../../components/customers/CustomerDeposits';
import StoreCredits from '../../components/customers/StoreCredits';
import { CustomerQuotationsTab } from '../../components/customers/CustomerQuotationsTab';
import { InvoiceSourceQuotationPanel } from '../../components/invoices/InvoiceSourceQuotationPanel';
import { DatePicker } from '../../components/ui/date-picker';
import { getBusinessDate, formatTimestamp, formatTimestampDate } from '../../utils/businessDate';
import { pricingApi } from '../../api/pricing';
import { useCustomerGroupsList } from '../../hooks/useCustomerGroups';
import {
  buildCustomerUpdatePayload,
  priceGroupIdForEffectDeps,
  syncEditPriceGroupState,
  customerIsAtCost,
  customerIsActive,
  priceGroupLabel as resolvePriceGroupLabel,
} from '../../utils/customerPriceGroupEdit';
import { AdjustCustomerInvoiceModal } from '../../components/shared/AdjustCustomerInvoiceModal';
import { useHasAnyPermission } from '../../hooks/useRbac';
import { useCanAccess } from '../../components/auth/ProtectedRoute';
import { useWhtTypes } from '../../hooks/useAccountingModules';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { useInvoiceDepositBalance } from '../../hooks/useInvoiceDepositBalance';
import {
  assertDepositPaymentAmount,
  depositPaymentCap,
  money2,
} from '@shared/domain/invoiceDepositPayment';
// ── Local interfaces for Customer Detail page ──────────────────

/** Raw invoice row from API (supports camelCase, snake_case, PascalCase keys) */
interface InvoiceRow {
  id?: string;
  Id?: string;
  invoiceNumber?: string;
  invoice_number?: string;
  InvoiceNumber?: string;
  customerId?: string;
  customer_id?: string;
  CustomerId?: string;
  saleId?: string;
  sale_id?: string;
  issueDate?: string;
  issue_date?: string;
  InvoiceDate?: string;
  dueDate?: string;
  due_date?: string;
  status?: string;
  paymentMethod?: string;
  payment_method?: string;
  subtotal?: number | string;
  taxAmount?: number | string;
  tax_amount?: number | string;
  totalAmount?: number | string;
  total_amount?: number | string;
  TotalAmount?: number | string;
  amountPaid?: number | string;
  amount_paid?: number | string;
  AmountPaid?: number | string;
  balance?: number | string;
  OutstandingBalance?: number | string;
  notes?: string | null;
  documentType?: string;
  document_type?: string;
  createdById?: string | null;
  created_by_id?: string | null;
  createdAt?: string;
  created_at?: string;
  updatedAt?: string;
  updated_at?: string;
}

/** Normalized invoice after mapping raw API data to consistent camelCase */
interface NormalizedInvoice {
  id: string | undefined;
  invoiceNumber: string | undefined;
  customerId: string | undefined;
  saleId: string | undefined;
  issueDate: string | undefined;
  dueDate: string | undefined;
  status: string | undefined;
  paymentMethod: string;
  subtotal: number;
  taxAmount: number;
  totalAmount: number;
  amountPaid: number;
  balance: number;
  documentType?: string;
  notes: string | null | undefined;
  createdById: string | null | undefined;
  createdAt: string | undefined;
  updatedAt: string | undefined;
}

interface CustomerDetailData {
  id: string;
  name: string;
  email?: string;
  phone?: string;
  address?: string;
  customerGroupId?: string | null;
  priceGroupId?: string | null;
  pricingMode?: 'STANDARD' | 'AT_COST' | null;
  balance: number | string;
  creditLimit: number | string;
  unlimitedCredit?: boolean;
  isActive: boolean;
  whtLiable?: boolean;
  defaultWhtTypeId?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

interface CustomerSummaryData {
  totalInvoices?: number | string;
  totalSpent?: number | string;
  lastPurchaseDate?: string;
}

interface StatementResponse {
  openingBalance: number | string;
  closingBalance: number | string;
  periodStart?: string;
  periodEnd?: string;
  entries?: StatementEntry[];
  deposits?: {
    summary?: {
      totalDeposited: number;
      totalUsed: number;
      availableBalance: number;
      depositCount?: number;
    };
    entries?: DepositEntry[];
  };
  page?: number;
  totalPages?: number;
}

interface StatementEntry {
  date?: string;
  type?: string;
  paymentMethod?: string;
  payment_method?: string;
  description?: string;
  reference?: string;
  balanceAfter?: number | string;
  debit?: number | string;
  credit?: number | string;
}

interface DepositEntry {
  date?: string;
  type?: string;
  reference?: string;
  description?: string;
  amount?: number | string;
  runningBalance?: number | string;
}

interface TransactionRow {
  id: string;
  transactionDate: string;
  type: string;
  amount: number | string;
  referenceNumber?: string;
  description?: string;
}

interface InvoiceDetailData {
  invoice?: {
    quote_id?: string | null;
    reference?: string | null;
  };
  sourceQuotation?: {
    quoteId: string;
    quoteNumber: string;
    reference?: string | null;
    referenceDetails?: string | null;
    quotationAuthorisedByName?: string | null;
  } | null;
  invoiceAuthorisedByName?: string | null;
  items?: InvoiceItemRow[];
  payments?: PaymentHistoryRow[];
}

interface InvoiceItemRow {
  id?: string;
  productName?: string;
  productId?: string;
  product_id?: string;
  productCode?: string;
  sku?: string;
  quantity?: number | string;
  unitPrice?: number | string;
  unit_price?: number | string;
  lineTotal?: number | string;
  line_total?: number | string;
}

interface PaymentHistoryRow {
  id: string;
  receiptNumber?: string;
  receipt_number?: string;
  paymentDate?: string;
  payment_date?: string;
  paymentMethod?: string;
  payment_method?: string;
  amount: number | string;
  referenceNumber?: string;
  reference_number?: string;
}

interface SaleRow {
  id: string;
  saleNumber?: string;
  saleDate?: string;
  totalAmount?: number | string;
  paymentMethod?: string;
}

type Tab = 'overview' | 'invoices' | 'transactions' | 'deposits' | 'credits' | 'quotations' | 'edit';

function isCustomerOpeningBalance(inv: { documentType?: string; invoiceNumber?: string }) {
  return (
    inv.documentType === 'OPENING_BALANCE' || (inv.invoiceNumber || '').startsWith('OB-')
  );
}

export default function CustomerDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();

  const [tab, setTab] = useState<Tab>('overview');

  // Initialize tab from hash or query (?tab=)
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const hash = location.hash?.replace('#', '');
    const initial = (params.get('tab') || hash) as Tab | null;
    if (initial && ['overview', 'invoices', 'transactions', 'deposits', 'credits', 'edit'].includes(initial)) {
      setTab(initial as Tab);
    }
    // Auto-open create invoice modal if requested via query params
    const createInvoiceFlag = params.get('createInvoice');
    if (createInvoiceFlag === '1') {
      setTab('invoices');
      const saleIdParam = params.get('saleId') || '';
      if (saleIdParam) setSelectedSaleId(saleIdParam);
      setTimeout(() => setCreateOpen(true), 0);
    }
  }, [location.search, location.hash]);

  // Data hooks
  const { data: customer, isLoading: isLoadingCustomer, error: customerError } = useCustomer(id);
  const { data: summary, isLoading: isLoadingSummary } = useCustomerSummary(id);

  // Pagination state for lists
  const [invoicePage, setInvoicePage] = useState(1);
  const [txPage, setTxPage] = useState(1);
  const pageSize = 20;

  const { data: invoiceData, isLoading: isLoadingInvoices } = useInvoices(invoicePage, pageSize, id);
  // Normalize invoice data (snake_case → camelCase) for consistent rendering
  const invoices = useMemo(() => {
    if (!Array.isArray(invoiceData)) return [] as NormalizedInvoice[];
    return (invoiceData as InvoiceRow[]).map((r: InvoiceRow) => ({
      id: r.id,
      invoiceNumber: r.invoiceNumber ?? r.invoice_number,
      customerId: r.customerId ?? r.customer_id,
      saleId: r.saleId ?? r.sale_id,
      issueDate: r.issueDate ?? (r.issue_date ? new Date(r.issue_date).toISOString() : undefined),
      dueDate: r.dueDate ?? (r.due_date ? new Date(r.due_date).toISOString() : undefined),
      status: r.status,
      paymentMethod: r.paymentMethod ?? r.payment_method ?? 'CREDIT',
      subtotal: typeof r.subtotal === 'number' ? r.subtotal : Number(r.subtotal ?? 0),
      taxAmount: typeof r.taxAmount === 'number' ? r.taxAmount : Number(r.tax_amount ?? r.taxAmount ?? 0),
      totalAmount: typeof r.totalAmount === 'number' ? r.totalAmount : Number(r.total_amount ?? r.totalAmount ?? 0),
      amountPaid: typeof r.amountPaid === 'number' ? r.amountPaid : Number(r.amount_paid ?? r.amountPaid ?? 0),
      balance: typeof r.balance === 'number' ? r.balance : Number(r.balance ?? (Number(r.total_amount ?? r.totalAmount ?? 0) - Number(r.amount_paid ?? r.amountPaid ?? 0))),
      documentType: r.documentType ?? r.document_type,
      notes: r.notes ?? null,
      createdById: r.createdById ?? r.created_by_id ?? null,
      createdAt: r.createdAt ?? (r.created_at ? new Date(r.created_at).toISOString() : undefined),
      updatedAt: r.updatedAt ?? (r.updated_at ? new Date(r.updated_at).toISOString() : undefined),
    }));
  }, [invoiceData]);
  // Local inventory cache: map productId -> productName for item name fallback
  const inventoryNameById = useMemo(() => {
    try {
      const raw = localStorage.getItem('inventory_items');
      const arr = raw ? JSON.parse(raw) : [];
      const map = new Map<string, string>();
      if (Array.isArray(arr)) {
        for (const it of arr) {
          const key1 = it?.id ? String(it.id) : null;
          const key2 = it?.productId ? String(it.productId) : null;
          const name = it?.name || it?.productName;
          if (key1 && name) map.set(key1, name);
          if (key2 && name) map.set(key2, name);
        }
      }
      return map;
    } catch {
      return new Map<string, string>();
    }
  }, []);
  const { data: txData, isLoading: isLoadingTx } = useCustomerTransactions(id, txPage, pageSize);
  // Customer statement (precision running balance)
  const [stmtStart, setStmtStart] = useState<string>('');
  const [stmtEnd, setStmtEnd] = useState<string>('');
  const [stmtPage, setStmtPage] = useState<number>(1);
  const stmtLimit = 100;
  const { data: statement } = useCustomerStatement(id, {
    start: stmtStart ? new Date(stmtStart).toISOString() : undefined,
    end: stmtEnd ? new Date(stmtEnd).toISOString() : undefined,
    page: stmtPage,
    limit: stmtLimit,
  });

  // Debug: Log invoice data
  useEffect(() => {
    console.log('Invoice data (raw → normalized):', { raw: invoiceData, normalized: invoices, isLoadingInvoices, customerId: id });
  }, [invoiceData, invoices, isLoadingInvoices, id]);

  const updateCustomer = useUpdateCustomer();

  const sum = summary as CustomerSummaryData | undefined;
  const title = useMemo(() => (customer as CustomerDetailData | undefined)?.name ?? 'Customer', [customer]);

  const { data: priceGroups = [] } = useQuery({
    queryKey: ['pricing', 'price-groups', true],
    queryFn: () => pricingApi.listPriceGroups(true),
    staleTime: 5 * 60 * 1000,
    enabled: tab === 'edit',
  });
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
  const { data: customerGroups = [] } = useCustomerGroupsList();
  const customerGroupName = useMemo(() => {
    const cust = customer as CustomerDetailData | undefined;
    return customerGroups.find((g) => g.id === cust?.customerGroupId)?.name ?? null;
  }, [customerGroups, customer]);
  const priceGroupLabel = useMemo(
    () => resolvePriceGroupLabel(customer as CustomerDetailData | undefined, priceGroups),
    [customer, priceGroups],
  );

  const [editPriceGroupId, setEditPriceGroupId] = useState('');
  const initialPriceGroupIdRef = useRef<string | null>(null);
  const [editWhtLiable, setEditWhtLiable] = useState(false);
  const [editDefaultWhtTypeId, setEditDefaultWhtTypeId] = useState('');
  const [editUnlimitedCredit, setEditUnlimitedCredit] = useState(false);

  useEffect(() => {
    if (tab === 'edit' && customer) {
      const { editValue, initialRef } = syncEditPriceGroupState(customer as CustomerDetailData);
      setEditPriceGroupId(editValue);
      initialPriceGroupIdRef.current = initialRef;
      const c = customer as CustomerDetailData;
      setEditWhtLiable(c.whtLiable === true);
      setEditDefaultWhtTypeId(c.defaultWhtTypeId || '');
      setEditUnlimitedCredit(c.unlimitedCredit === true);
    }
  }, [tab, customer, priceGroupIdForEffectDeps(customer as CustomerDetailData | undefined)]);

  const toNumber = (v: unknown): number => {
    if (typeof v === 'number') return v;
    const parsed = parseFloat(String(v ?? '0'));
    return isNaN(parsed) ? 0 : parsed;
  };

  const onEditSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!customer) return;
    const form = e.currentTarget;
    const formData = new FormData(form);
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
      },
    );
    await updateCustomer.mutateAsync({ id, data: payload });
  };

  // Record Payment Modal state
  const [isPaymentOpen, setPaymentOpen] = useState(false);
  const [selectedInvoice, setSelectedInvoice] = useState<NormalizedInvoice | null>(null);
  const [payAmount, setPayAmount] = useState('');
  const [payMethod, setPayMethod] = useState('CASH');
  const [payReferenceNumber, setPayReferenceNumber] = useState('');
  const [payNotes, setPayNotes] = useState('');
  const [payDate, setPayDate] = useState<string>(() => getBusinessDate()); // yyyy-MM-dd
  const [showInvoicePicker, setShowInvoicePicker] = useState(false);
  const [fetchedUnpaidInvoices, setFetchedUnpaidInvoices] = useState<NormalizedInvoice[]>([]);
  const [isFetchingUnpaid, setIsFetchingUnpaid] = useState(false);
  const modalRef = useModalAccessibility(isPaymentOpen, () => setPaymentOpen(false));
  const recordPayment = useRecordInvoicePayment();
  const depositBalance = useInvoiceDepositBalance(id, isPaymentOpen);

  useEffect(() => {
    if (!isPaymentOpen || !selectedInvoice || !depositBalance.hasDeposit) return;
    setPayMethod((current) => {
      if (current !== 'CASH') return current;
      const outstanding = money2(selectedInvoice.balance);
      const cap = depositPaymentCap(outstanding, depositBalance.available);
      if (cap.gt(0)) setPayAmount(cap.toFixed(2));
      return 'DEPOSIT';
    });
  }, [isPaymentOpen, selectedInvoice, depositBalance.hasDeposit, depositBalance.available]);

  const openPaymentModal = (invoice: NormalizedInvoice) => {
    setSelectedInvoice(invoice);
    setPayAmount('');
    setPayMethod('CASH');
    setPayReferenceNumber('');
    setPayNotes('');
    setPayDate(getBusinessDate());
    setShowInvoicePicker(false);
    setPaymentOpen(true);
  };

  const onSubmitPayment = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    // Prevent double submission
    if (recordPayment.isPending) return;

    if (!selectedInvoice) {
      alert('⚠️ Error\n\nNo invoice selected. Please try again.');
      return;
    }

    let amountDec;
    try {
      amountDec = money2(payAmount);
    } catch {
      alert('⚠️ Invalid Amount\n\nPlease enter a valid payment amount.\n\nExample: 50000 for UGX 50,000');
      return;
    }

    if (amountDec.lte(0)) {
      alert('⚠️ Invalid Amount\n\nPayment amount must be greater than zero.');
      return;
    }

    const invoiceBalance = money2(selectedInvoice.balance);

    if (amountDec.gt(invoiceBalance)) {
      alert(`⚠️ Payment Exceeds Balance\n\nInvoice Balance: ${formatCurrency(invoiceBalance.toNumber())}\nPayment Amount: ${formatCurrency(amountDec.toNumber())}\nOverpayment: ${formatCurrency(amountDec.minus(invoiceBalance).toNumber())}\n\n❌ Overpayment is not allowed.\nPlease enter an amount up to ${formatCurrency(invoiceBalance.toNumber())}.`);
      return;
    }

    if (!payMethod) {
      alert('⚠️ Payment Method Required\n\nPlease select a payment method.');
      return;
    }

    if (payMethod === 'DEPOSIT') {
      try {
        assertDepositPaymentAmount({
          amount: amountDec,
          outstanding: invoiceBalance,
          depositAvailable: depositBalance.available,
        });
      } catch (err: unknown) {
        alert(`⚠️ Deposit payment rejected\n\n${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }

    try {
      await recordPayment.mutateAsync({
        invoiceId: String(selectedInvoice.id),
        data: {
          amount: amountDec.toNumber(),
          paymentMethod: payMethod,
          referenceNumber: payReferenceNumber || undefined,
          paymentDate: payDate ? new Date(payDate).toISOString() : undefined,
          notes: payNotes || undefined,
        },
      });
      setPaymentOpen(false);

      alert(`✅ Payment Recorded\n\nAmount: ${formatCurrency(amountDec.toNumber())}\nMethod: ${payMethod}${payMethod === 'DEPOSIT' ? '\n\n🏦 Deposit balance updated.' : ''}\n\nInvoice updated successfully!`);
    } catch (error: unknown) {
      console.error('Payment recording error:', error);
      const axErr = error instanceof AxiosError ? error.response?.data?.error : undefined;
      const errorMsg = axErr || (error instanceof Error ? error.message : 'Unknown error');
      alert(`❌ Payment Recording Failed\n\n${errorMsg}\n\n💡 Please:\n• Check your internet connection\n• Verify payment details\n• Try again\n\nIf error persists, contact support.`);
    }
  };

  // Invoice Details Drawer (payments history)
  const [isDetailsOpen, setDetailsOpen] = useState(false);
  const [detailsInvoice, setDetailsInvoice] = useState<NormalizedInvoice | null>(null);
  const [adjustInvoiceOpen, setAdjustInvoiceOpen] = useState(false);
  const canAdjustInvoices = useHasAnyPermission(['customers.adjust']);
  const canPostOpeningBalance = useCanAccess([], ['accounting.opening_balance']);

  const detailsRef = useModalAccessibility(isDetailsOpen, () => setDetailsOpen(false));
  const { data: paymentHistory, isLoading: isLoadingPayments } = useInvoicePayments(detailsInvoice?.id || '',);
  // Fetch full invoice detail (includes items + payments)
  const { data: invoiceDetail } = useInvoice(detailsInvoice?.id || '');
  const openDetails = (invoice: NormalizedInvoice) => {
    setDetailsInvoice(invoice);
    setDetailsOpen(true);
  };

  // Create Invoice Modal
  const [isCreateOpen, setCreateOpen] = useState(false);
  const createRef = useModalAccessibility(isCreateOpen, () => setCreateOpen(false));
  const [selectedSaleId, setSelectedSaleId] = useState<string>('');
  const [dueDate, setDueDate] = useState<string>('');
  const [initialPayment, setInitialPayment] = useState<string>('');
  const [createNotes, setCreateNotes] = useState<string>('');
  const [createError, setCreateError] = useState<string | null>(null);
  const { data: customerSales, isLoading: isLoadingCustomerSales } = useCustomerSales(id, 1, 20);
  const createInvoice = useCreateInvoice();

  // Filter out sales that already have invoices
  const salesWithoutInvoices = useMemo(() => {
    if (!customerSales || !Array.isArray(customerSales)) return [];
    const salesArray = customerSales as SaleRow[];

    // Create a Set of saleIds that have invoices
    const invoicedSaleIds = new Set<string>();
    if (Array.isArray(invoices)) {
      invoices.forEach((inv: NormalizedInvoice) => {
        if (inv.saleId) {
          invoicedSaleIds.add(String(inv.saleId));
        }
      });
    }

    // Filter out sales that already have invoices
    return salesArray.filter(sale => !invoicedSaleIds.has(String(sale.id)));
  }, [customerSales, invoices]);

  // Customer status management
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const deleteConfirmRef = useModalAccessibility(deleteConfirmOpen, () => setDeleteConfirmOpen(false));
  const toggleActiveM = useToggleCustomerActive();
  const deleteCustomerM = useDeleteCustomer();

  const handleToggleActive = async () => {
    if (!customer) return;
    const newStatus = !customerIsActive(customer as CustomerDetailData);
    try {
      await toggleActiveM.mutateAsync({ id, isActive: newStatus });
      alert(`Customer ${newStatus ? 'activated' : 'deactivated'} successfully`);
    } catch (err: unknown) {
      const axErr = err instanceof AxiosError ? err.response?.data?.error : undefined;
      alert(axErr || (err instanceof Error ? err.message : 'Failed to update customer status'));
    }
  };

  const handleDelete = async () => {
    try {
      await deleteCustomerM.mutateAsync(id);
      setDeleteConfirmOpen(false);
      alert('Customer deleted successfully');
      navigate('/customers');
    } catch (err: unknown) {
      const axErr = err instanceof AxiosError ? err.response?.data?.error : undefined;
      alert(axErr || (err instanceof Error ? err.message : 'Failed to delete customer'));
    }
  };

  const openCreateInvoice = () => {
    setSelectedSaleId('');
    setDueDate('');
    setInitialPayment('');
    setCreateNotes('');
    setCreateError(null);
    setCreateOpen(true);
  };
  const onSubmitCreateInvoice = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!id) return;
    setCreateError(null);
    try {
      await createInvoice.mutateAsync({
        customerId: id,
        saleId: selectedSaleId || undefined,
        dueDate: dueDate ? new Date(dueDate).toISOString() : undefined,
        initialPaymentAmount: initialPayment ? Number(initialPayment) : undefined,
        notes: createNotes || undefined,
      });
      setCreateOpen(false);
    } catch (err: unknown) {
      const axiosErr = err instanceof AxiosError ? err : undefined;
      const status = axiosErr?.response?.status;
      const msg = axiosErr?.response?.data?.error || (err instanceof Error ? err.message : 'Failed to create invoice');
      if (status === 409) {
        setCreateError('An invoice already exists for this sale. You cannot create another.');
      } else {
        setCreateError(msg);
      }
    }
  };

  return (
    <Layout>
      <div className="p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <button onClick={() => navigate('/customers')} className="text-sm text-gray-600 hover:text-gray-900">← Back to Customers</button>
            <div className="flex items-center gap-2 flex-wrap mt-1">
              <h1 className="text-3xl font-bold text-gray-900">{title}</h1>
              {customerIsAtCost(customer as CustomerDetailData | undefined) && (
                <span className="inline-flex px-2.5 py-0.5 text-sm font-medium rounded-full bg-amber-100 text-amber-800">
                  At cost
                </span>
              )}
              {(customer as CustomerDetailData | undefined)?.whtLiable && (
                <span className="inline-flex px-2.5 py-0.5 text-sm font-medium rounded-full bg-sky-100 text-sky-800">
                  WHT liable
                </span>
              )}
            </div>
            {customer ? (
              <p className="text-gray-600 mt-1">ID: <span className="font-mono text-xs">{(customer as CustomerDetailData).id}</span></p>
            ) : null}
          </div>
          <div className="flex items-center gap-3">
            <span className={`px-3 py-1 rounded-full text-sm ${customerIsActive(customer as CustomerDetailData | undefined) ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'}`}>
              {customerIsActive(customer as CustomerDetailData | undefined) ? 'Active' : 'Inactive'}
            </span>
            <button
              onClick={handleToggleActive}
              disabled={toggleActiveM.isPending}
              className={`px-4 py-2 border rounded-lg hover:bg-gray-50 ${customerIsActive(customer as CustomerDetailData | undefined) ? 'border-gray-300 text-gray-700' : 'border-green-500 text-green-700 bg-green-50'}`}
            >
              {toggleActiveM.isPending ? '...' : (customerIsActive(customer as CustomerDetailData | undefined) ? 'Deactivate' : 'Activate')}
            </button>
            <button
              onClick={() => setDeleteConfirmOpen(true)}
              className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700"
            >
              Delete
            </button>
            <button onClick={() => setTab('edit')} className="px-4 py-2 bg-white border border-gray-300 rounded-lg hover:bg-gray-50">Edit</button>
          </div>
        </div>

        {/* Header cards */}
        {customer ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-6">
            <div className="bg-white rounded-lg shadow p-5 border border-gray-200">
              <p className="text-sm text-gray-600">{toNumber((customer as CustomerDetailData).balance) >= 0 ? 'Balance (Owed)' : 'Customer Credit'}</p>
              <p className={`text-2xl font-bold ${toNumber((customer as CustomerDetailData).balance) > 0 ? 'text-red-600' : toNumber((customer as CustomerDetailData).balance) < 0 ? 'text-green-600' : 'text-gray-900'}`}>
                {formatCurrency(Math.abs(toNumber((customer as CustomerDetailData).balance)))}
              </p>
              {toNumber((customer as CustomerDetailData).balance) < 0 && <p className="text-xs text-green-600 mt-1">Overpaid — credit on account</p>}
              {toNumber((customer as CustomerDetailData).balance) > 0 && <p className="text-xs text-gray-500 mt-1">Outstanding receivable</p>}
              {toNumber((customer as CustomerDetailData).balance) === 0 && <p className="text-xs text-gray-500 mt-1">Account settled</p>}
            </div>
            <div className="bg-white rounded-lg shadow p-5 border border-gray-200">
              <p className="text-sm text-gray-600">Credit Limit</p>
              <p className="text-2xl font-bold text-gray-900">
                {(customer as CustomerDetailData).unlimitedCredit
                  ? 'Unlimited'
                  : formatCurrency(typeof (customer as CustomerDetailData).creditLimit === 'string' ? (customer as CustomerDetailData).creditLimit : Number((customer as CustomerDetailData).creditLimit))}
              </p>
              <p className="text-xs text-gray-500 mt-1">
                {(customer as CustomerDetailData).unlimitedCredit
                  ? 'No hard AR ceiling'
                  : 'Maximum credit allowed'}
              </p>
            </div>
            <div className="bg-white rounded-lg shadow p-5 border border-gray-200">
              <p className="text-sm text-gray-600">Total Invoices</p>
              <p className="text-2xl font-bold text-gray-900">{sum?.totalInvoices ?? (isLoadingSummary ? '…' : 0)}</p>
              <p className="text-xs text-gray-500 mt-1">All-time</p>
            </div>
            <div className="bg-white rounded-lg shadow p-5 border border-gray-200">
              <p className="text-sm text-gray-600">Total Spent</p>
              <p className="text-2xl font-bold text-gray-900">{formatCurrency(sum?.totalSpent ?? 0)}</p>
              <p className="text-xs text-gray-500 mt-1">All-time</p>
            </div>
          </div>
        ) : null}

        {/* Tabs */}
        <div className="border-b border-gray-200 mb-6 overflow-x-auto">
          <nav className="-mb-px flex space-x-3 sm:space-x-8 min-w-max">
            {(['overview', 'invoices', 'transactions', 'deposits', 'credits', 'quotations', 'edit'] as Tab[]).map(t => (
              <button key={t} onClick={() => setTab(t)} className={`py-3 px-1 border-b-2 font-medium text-sm whitespace-nowrap ${tab === t ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'}`}>
                {t === 'overview' ? 'Overview' :
                  t === 'invoices' ? 'Invoices' :
                    t === 'transactions' ? 'Transactions' :
                      t === 'deposits' ? 'Deposits' :
                        t === 'credits' ? 'Store Credits' :
                          t === 'quotations' ? 'Quotations' :
                            'Edit'}
              </button>
            ))}
          </nav>
        </div>

        {/* Content */}
        {isLoadingCustomer ? (
          <div className="text-gray-600">Loading customer…</div>
        ) : null}
        {customerError ? (
          <div className="text-red-600">Failed to load customer</div>
        ) : null}

        {customer && tab === 'overview' ? (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="bg-white rounded-lg shadow border border-gray-200 p-6 lg:col-span-2">
              <h2 className="text-lg font-semibold mb-4">Recent Invoices</h2>
              {isLoadingInvoices ? (
                <div className="text-gray-500">Loading…</div>
              ) : invoices.length === 0 ? (
                <div className="text-gray-500">No invoices</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Invoice</th>
                        <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Date</th>
                        <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Payment Type</th>
                        <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Total</th>
                        <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Paid</th>
                        <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                        <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase"></th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                      {invoices.slice(0, 10).map((inv) => (
                        <tr key={inv.id} className="hover:bg-gray-50">
                          <td className="px-4 py-2 font-medium">
                            <span className="inline-flex flex-wrap items-center gap-2">
                              {inv.invoiceNumber}
                              {isCustomerOpeningBalance(inv) && (
                                <span className="px-2 py-0.5 rounded-full text-xs bg-indigo-100 text-indigo-800 border border-indigo-200">
                                  Opening Balance
                                </span>
                              )}
                            </span>
                          </td>
                          <td className="px-4 py-2 text-sm text-gray-600">{inv.issueDate ? formatTimestamp(inv.issueDate) : '-'}</td>
                          <td className="px-4 py-2 text-sm text-gray-600">{inv.paymentMethod || 'CREDIT'}</td>
                          <td className="px-4 py-2 font-semibold">{formatCurrency(inv.totalAmount)}</td>
                          <td className="px-4 py-2 text-sm text-gray-600">{formatCurrency(inv.amountPaid)}</td>
                          <td className="px-4 py-2"><span className={`px-2 py-1 rounded-full text-xs ${inv.status === 'PAID' ? 'bg-green-100 text-green-800' : inv.status === 'PARTIALLY_PAID' ? 'bg-yellow-100 text-yellow-800' : 'bg-gray-100 text-gray-800'}`}>{inv.status}</span></td>
                          <td className="px-4 py-2 text-right space-x-2">
                            <button className="px-3 py-1 text-sm border border-gray-300 rounded bg-white hover:bg-gray-50" onClick={() => openDetails(inv)}>View Details</button>
                            {inv.status !== 'PAID' && (
                              <button className="px-3 py-1 text-sm border border-gray-300 rounded bg-white hover:bg-gray-50" onClick={() => openPaymentModal(inv)}>Record Payment</button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="bg-white rounded-lg shadow border border-gray-200 p-6">
              <h2 className="text-lg font-semibold mb-4">Details</h2>
              <dl className="divide-y divide-gray-200">
                <div className="py-3 grid grid-cols-3 gap-4">
                  <dt className="text-sm font-medium text-gray-500">Email</dt>
                  <dd className="mt-1 text-sm text-gray-900 col-span-2">{(customer as CustomerDetailData).email || '-'}</dd>
                </div>
                <div className="py-3 grid grid-cols-3 gap-4">
                  <dt className="text-sm font-medium text-gray-500">Phone</dt>
                  <dd className="mt-1 text-sm text-gray-900 col-span-2">{(customer as CustomerDetailData).phone || '-'}</dd>
                </div>
                <div className="py-3 grid grid-cols-3 gap-4">
                  <dt className="text-sm font-medium text-gray-500">Address</dt>
                  <dd className="mt-1 text-sm text-gray-900 col-span-2 whitespace-pre-wrap">{(customer as CustomerDetailData).address || '-'}</dd>
                </div>
                <div className="py-3 grid grid-cols-3 gap-4">
                  <dt className="text-sm font-medium text-gray-500">Customer group</dt>
                  <dd className="mt-1 text-sm text-gray-900 col-span-2">
                    {customerGroupName ?? '—'}
                    <span className="block text-xs text-gray-400">Discounts and price rules (retail-based)</span>
                  </dd>
                </div>
                <div className="py-3 grid grid-cols-3 gap-4">
                  <dt className="text-sm font-medium text-gray-500">Price group</dt>
                  <dd className="mt-1 text-sm text-gray-900 col-span-2">{priceGroupLabel}</dd>
                </div>
                <div className="py-3 grid grid-cols-3 gap-4">
                  <dt className="text-sm font-medium text-gray-500">Last Purchase</dt>
                  <dd className="mt-1 text-sm text-gray-900 col-span-2">{sum?.lastPurchaseDate ? formatTimestamp(sum.lastPurchaseDate) : '-'}</dd>
                </div>
              </dl>

              {canPostOpeningBalance && (
                <div className="mt-6 p-4 border border-indigo-200 bg-indigo-50/50 rounded-lg">
                  <h4 className="text-sm font-semibold text-indigo-900 mb-1">Opening balance (cutover)</h4>
                  <p className="text-xs text-indigo-800 mb-2">
                    Post or correct AR for <strong>{(customer as CustomerDetailData).name}</strong> from
                    Customer Payments (audited).
                  </p>
                  <a
                    href="/accounting/customer-payments"
                    className="text-sm font-medium text-indigo-700 hover:text-indigo-900 underline"
                  >
                    Open Customer Payments → Opening balance
                  </a>
                </div>
              )}
            </div>
          </div>
        ) : null}

        {customer && tab === 'invoices' ? (
          <div className="bg-white rounded-lg shadow border border-gray-200">
            <div className="flex items-center justify-between px-6 py-4">
              <div />
              <button className="px-3 py-2 text-sm border border-gray-300 rounded bg-white hover:bg-gray-50" onClick={openCreateInvoice}>Create Invoice</button>
            </div>
            {isLoadingInvoices ? (
              <div className="text-center py-10 text-gray-500">Loading invoices…</div>
            ) : invoices.length === 0 ? (
              <div className="text-center py-10 text-gray-500">No invoices found</div>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Invoice</th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Date</th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Payment Type</th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Total</th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Paid</th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                        <th className="px-6 py-3" />
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                      {invoices.map((inv) => (
                        <tr key={inv.id} className="hover:bg-gray-50">
                          <td className="px-6 py-4">
                            <span className="inline-flex flex-wrap items-center gap-2">
                              {inv.invoiceNumber}
                              {isCustomerOpeningBalance(inv) && (
                                <span className="px-2 py-0.5 rounded-full text-xs bg-indigo-100 text-indigo-800 border border-indigo-200">
                                  Opening Balance
                                </span>
                              )}
                            </span>
                          </td>
                          <td className="px-6 py-4 text-sm text-gray-600">{inv.issueDate ? formatTimestamp(inv.issueDate) : '-'}</td>
                          <td className="px-6 py-4 text-sm text-gray-600">{inv.paymentMethod || 'CREDIT'}</td>
                          <td className="px-6 py-4 font-semibold">{formatCurrency(inv.totalAmount)}</td>
                          <td className="px-6 py-4 text-sm text-gray-600">{formatCurrency(inv.amountPaid)}</td>
                          <td className="px-6 py-4"><span className={`px-2 py-1 rounded-full text-xs ${inv.status === 'PAID' ? 'bg-green-100 text-green-800' : inv.status === 'PARTIALLY_PAID' ? 'bg-yellow-100 text-yellow-800' : 'bg-gray-100 text-gray-800'}`}>{inv.status}</span></td>
                          <td className="px-6 py-4 text-right space-x-2">
                            <button className="px-3 py-1 text-sm border border-gray-300 rounded bg-white hover:bg-gray-50" onClick={() => openDetails(inv)}>View Details</button>
                            {inv.status !== 'PAID' && (
                              <button className="px-3 py-1 text-sm border border-gray-300 rounded bg-white hover:bg-gray-50" onClick={() => openPaymentModal(inv)}>Record Payment</button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="bg-gray-50 px-6 py-4 border-t border-gray-200 flex items-center justify-between">
                  <div className="text-sm text-gray-700">Page {invoicePage}</div>
                  <div className="flex gap-2">
                    <button className="px-3 py-1 border border-gray-300 rounded bg-white hover:bg-gray-50 disabled:opacity-50" onClick={() => setInvoicePage(Math.max(1, invoicePage - 1))} disabled={invoicePage === 1}>Previous</button>
                    <button className="px-3 py-1 border border-gray-300 rounded bg-white hover:bg-gray-50" onClick={() => setInvoicePage(invoicePage + 1)}>Next</button>
                  </div>
                </div>
              </>
            )}
          </div>
        ) : null}

        {customer && tab === 'transactions' ? (
          <div className="bg-white rounded-lg shadow border border-gray-200">
            {/* Receive Payment button — always visible on transactions tab for customer with any invoices */}
            <div className="px-6 pt-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-gray-900">Transaction Statement</h2>
              <div className="relative">
                <button
                  disabled={isFetchingUnpaid}
                  onClick={async () => {
                    // Use already-loaded invoice data if available
                    const cached = invoices.filter((inv: NormalizedInvoice) => inv.status !== 'PAID' && Number(inv.balance || 0) > 0);
                    if (cached.length === 1) {
                      openPaymentModal(cached[0]);
                      return;
                    }
                    if (cached.length > 1) {
                      setFetchedUnpaidInvoices(cached);
                      setShowInvoicePicker(true);
                      return;
                    }
                    // Invoices not loaded yet — fetch on demand
                    setIsFetchingUnpaid(true);
                    try {
                      const resp = await api.invoices.list({ page: 1, limit: 50, customerId: id });
                      const raw = resp.data?.data || [];
                      const mapped: NormalizedInvoice[] = (Array.isArray(raw) ? raw : []).map((r: InvoiceRow) => ({
                        id: r.id || r.Id,
                        invoiceNumber: r.invoiceNumber ?? r.invoice_number ?? r.InvoiceNumber,
                        customerId: r.customerId ?? r.customer_id ?? r.CustomerId,
                        saleId: r.saleId ?? r.sale_id,
                        issueDate: r.issueDate ?? r.issue_date ?? r.InvoiceDate,
                        dueDate: r.dueDate ?? r.due_date,
                        status: String(r.status || 'UNPAID').toUpperCase().includes('PARTIAL') ? 'PARTIALLY_PAID' : String(r.status || '').toUpperCase() === 'PAID' ? 'PAID' : 'UNPAID',
                        paymentMethod: r.paymentMethod ?? r.payment_method ?? 'CREDIT',
                        subtotal: 0,
                        taxAmount: 0,
                        totalAmount: Number(r.totalAmount ?? r.total_amount ?? r.TotalAmount ?? 0),
                        amountPaid: Number(r.amountPaid ?? r.amount_paid ?? r.AmountPaid ?? 0),
                        balance: Number(r.balance ?? r.OutstandingBalance ?? 0),
                        notes: r.notes ?? null,
                        createdById: null,
                        createdAt: r.createdAt ?? r.created_at,
                        updatedAt: r.updatedAt ?? r.updated_at,
                      }));
                      const unpaid = mapped.filter((inv) => inv.status !== 'PAID' && Number(inv.balance || 0) > 0);
                      if (unpaid.length === 1) {
                        openPaymentModal(unpaid[0]);
                      } else if (unpaid.length > 1) {
                        setFetchedUnpaidInvoices(unpaid);
                        setShowInvoicePicker(true);
                      } else {
                        alert('No unpaid invoices found for this customer.');
                      }
                    } catch (err) {
                      console.error('Failed to fetch unpaid invoices:', err);
                      alert('Failed to load invoices. Please try again.');
                    } finally {
                      setIsFetchingUnpaid(false);
                    }
                  }}
                  className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 font-medium text-sm flex items-center gap-2"
                  aria-label="Receive Payment"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M4 4a2 2 0 00-2 2v4a2 2 0 002 2V6h10a2 2 0 00-2-2H4zm2 6a2 2 0 012-2h8a2 2 0 012 2v4a2 2 0 01-2 2H8a2 2 0 01-2-2v-4zm6 1a1 1 0 100 2 1 1 0 000-2z" clipRule="evenodd" />
                  </svg>
                  {isFetchingUnpaid ? 'Loading...' : 'Receive Payment'}
                </button>
                {showInvoicePicker && fetchedUnpaidInvoices.length > 0 && (
                  <div className="absolute right-0 top-full mt-1 w-80 bg-white border border-gray-200 rounded-lg shadow-lg z-50 max-h-64 overflow-y-auto">
                    <div className="px-3 py-2 border-b border-gray-100 text-xs text-gray-500 font-medium uppercase">Select Invoice to Pay</div>
                    {fetchedUnpaidInvoices.map((inv) => (
                      <button
                        key={inv.id}
                        className="w-full px-3 py-2 hover:bg-gray-50 text-left flex items-center justify-between border-b border-gray-50 last:border-0"
                        onClick={() => {
                          setShowInvoicePicker(false);
                          openPaymentModal(inv);
                        }}
                      >
                        <div>
                          <div className="text-sm font-medium text-gray-900">{inv.invoiceNumber}</div>
                          <div className="text-xs text-gray-500">{inv.issueDate ? formatTimestampDate(inv.issueDate) : '-'}</div>
                        </div>
                        <div className="text-right">
                          <div className="text-sm font-semibold text-red-600">{formatCurrency(inv.balance)}</div>
                          <span className={`text-xs px-1.5 py-0.5 rounded ${inv.status === 'PARTIALLY_PAID' ? 'bg-yellow-100 text-yellow-800' : 'bg-gray-100 text-gray-800'}`}>{inv.status}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
            {/* Prefer precision statement if available; fallback to transactions */}
            {statement ? (
              <>
                <div className="px-6 pt-4">
                  <div className="flex flex-wrap items-end gap-3 mb-3" aria-label="Statement Filters">
                    <div>
                      <label className="block text-xs text-gray-600" htmlFor="stmtStart">Start</label>
                      <DatePicker
                        value={stmtStart}
                        onChange={(date) => { setStmtStart(date); setStmtPage(1); }}
                        placeholder="Start date"
                        maxDate={stmtEnd ? new Date(stmtEnd) : undefined}
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-600" htmlFor="stmtEnd">End</label>
                      <DatePicker
                        value={stmtEnd}
                        onChange={(date) => { setStmtEnd(date); setStmtPage(1); }}
                        placeholder="End date"
                        minDate={stmtStart ? new Date(stmtStart) : undefined}
                      />

                    </div>
                    <button className="px-3 py-2 border border-gray-300 rounded bg-white hover:bg-gray-50" onClick={() => { setStmtStart(''); setStmtEnd(''); setStmtPage(1); }} aria-label="Reset Statement Filters">Reset</button>
                    <div className="flex gap-2 ml-auto">
                      <button
                        onClick={() => {
                          const params = [
                            stmtStart ? `start=${new Date(stmtStart).toISOString()}` : '',
                            stmtEnd ? `end=${new Date(stmtEnd).toISOString()}` : ''
                          ].filter(Boolean).join('&');
                          const url = `/customers/${id}/statement/export.csv${params ? '?' + params : ''}`;
                          downloadFile(url, `statement-${id}-${getBusinessDate()}.csv`);
                        }}
                        className="px-3 py-2 border border-gray-300 rounded bg-white hover:bg-gray-50 text-sm"
                        aria-label="Export Statement CSV"
                      >
                        Export CSV
                      </button>
                      <button
                        onClick={() => {
                          const params = [
                            stmtStart ? `start=${new Date(stmtStart).toISOString()}` : '',
                            stmtEnd ? `end=${new Date(stmtEnd).toISOString()}` : ''
                          ].filter(Boolean).join('&');
                          const url = `/customers/${id}/statement/export.pdf${params ? '?' + params : ''}`;
                          downloadFile(url, `statement-${id}-${getBusinessDate()}.pdf`);
                        }}
                        className="px-3 py-2 border border-gray-300 rounded bg-white hover:bg-gray-50 text-sm"
                        aria-label="Export Statement PDF"
                      >
                        Export PDF
                      </button>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="bg-gray-50 border border-gray-200 rounded p-3">
                      <div className="text-xs text-gray-600">Opening Balance</div>
                      <div className={`text-lg font-semibold ${Number((statement as StatementResponse).openingBalance || 0) > 0 ? 'text-red-600' : Number((statement as StatementResponse).openingBalance || 0) < 0 ? 'text-green-600' : ''}`}>
                        {formatCurrency(Math.abs(Number((statement as StatementResponse).openingBalance || 0)))}
                        {Number((statement as StatementResponse).openingBalance || 0) < 0 && <span className="text-xs ml-1">(CR)</span>}
                      </div>
                    </div>
                    <div className="bg-gray-50 border border-gray-200 rounded p-3">
                      <div className="text-xs text-gray-600">Closing Balance</div>
                      <div className={`text-lg font-semibold ${Number((statement as StatementResponse).closingBalance || 0) > 0 ? 'text-red-600' : Number((statement as StatementResponse).closingBalance || 0) < 0 ? 'text-green-600' : ''}`}>
                        {formatCurrency(Math.abs(Number((statement as StatementResponse).closingBalance || 0)))}
                        {Number((statement as StatementResponse).closingBalance || 0) < 0 && <span className="text-xs ml-1">(CR)</span>}
                      </div>
                    </div>
                    <div className="bg-gray-50 border border-gray-200 rounded p-3">
                      <div className="text-xs text-gray-600">Period</div>
                      <div className="text-sm">{new Date((statement as StatementResponse).periodStart || '').toLocaleDateString()} → {new Date((statement as StatementResponse).periodEnd || '').toLocaleDateString()}</div>
                    </div>
                  </div>
                </div>
                <div className="overflow-x-auto mt-4">
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Date</th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Type</th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Payment Method</th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Reference</th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Description</th>
                        <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Sale Amount</th>
                        <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Amount Paid</th>
                        <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Balance</th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                      {((statement as StatementResponse).entries || []).map((e: StatementEntry, idx: number) => {
                        try {
                          // Extract payment method from description or metadata
                          const paymentMethod = e.paymentMethod || e.payment_method ||
                            (e.description?.match(/\((.*?)\)/)?.[1]) || '-';

                          const balanceAfter = Number(e.balanceAfter || 0);
                          const debitAmount = e.debit ? Number(e.debit) : null;
                          const creditAmount = e.credit ? Number(e.credit) : null;

                          return (
                            <tr key={idx} className="hover:bg-gray-50">
                              <td className="px-6 py-4 text-sm text-gray-600">
                                {e.date ? formatTimestamp(e.date) : '-'}
                              </td>
                              <td className="px-6 py-4">
                                <span className={`px-2 py-1 rounded text-xs ${e.type === 'PAYMENT' ? 'bg-green-100 text-green-800' :
                                  e.type === 'SALE' ? 'bg-blue-100 text-blue-800' :
                                    e.type === 'INVOICE' ? 'bg-yellow-100 text-yellow-800' :
                                      e.type === 'DEPOSIT' ? 'bg-amber-100 text-amber-800' :
                                        e.type === 'DEPOSIT_APPLIED' ? 'bg-purple-100 text-purple-800' :
                                          'bg-gray-100 text-gray-800'
                                  }`}>
                                  {e.type === 'DEPOSIT' ? 'DEPOSIT' :
                                    e.type === 'DEPOSIT_APPLIED' ? 'DEPOSIT APPLIED' :
                                      e.type || 'UNKNOWN'}
                                </span>
                              </td>
                              <td className="px-6 py-4 text-sm font-medium text-gray-700">
                                {paymentMethod === 'CREDIT' ? 'Balance' : paymentMethod}
                              </td>
                              <td className="px-6 py-4 text-sm text-gray-600">{e.reference || '-'}</td>
                              <td className="px-6 py-4 text-sm text-gray-600">{e.description || '-'}</td>
                              <td className="px-6 py-4 text-sm text-right text-gray-700">
                                {debitAmount !== null ? <span className="text-red-600 font-semibold">{formatCurrency(debitAmount)}</span> : '-'}
                              </td>
                              <td className="px-6 py-4 text-sm text-right text-gray-700">
                                {creditAmount !== null ? <span className="text-green-600 font-semibold">{formatCurrency(creditAmount)}</span> : '-'}
                              </td>
                              <td className="px-6 py-4 text-sm text-right">
                                <span className={`font-bold ${balanceAfter > 0 ? 'text-red-600' :
                                  balanceAfter < 0 ? 'text-green-600' :
                                    'text-gray-900'
                                  }`}>
                                  {formatCurrency(Math.abs(balanceAfter))}
                                  {balanceAfter < 0 && <span className="text-xs ml-1">(CR)</span>}
                                </span>
                              </td>
                            </tr>
                          );
                        } catch (error) {
                          console.error('Error rendering statement entry:', error, e);
                          return (
                            <tr key={`error-${idx}`} className="bg-red-50">
                              <td colSpan={8} className="px-6 py-4 text-sm text-red-600">
                                ⚠️ Error displaying transaction (Index: {idx}) - Data may be corrupted
                              </td>
                            </tr>
                          );
                        }
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="bg-gray-50 px-6 py-4 border-t border-gray-200 flex items-center justify-between mt-2">
                  <div className="text-sm text-gray-700">Page {(statement as StatementResponse)?.page || stmtPage}</div>
                  <div className="flex gap-2">
                    <button className="px-3 py-1 border border-gray-300 rounded bg-white hover:bg-gray-50 disabled:opacity-50" onClick={() => setStmtPage(Math.max(1, stmtPage - 1))} disabled={((statement as StatementResponse)?.page || stmtPage) === 1}>Previous</button>
                    <button className="px-3 py-1 border border-gray-300 rounded bg-white hover:bg-gray-50" onClick={() => setStmtPage(stmtPage + 1)}>Next</button>
                  </div>
                </div>

                {/* Deposit Activity Section */}
                {(() => {
                  const stmtTyped = statement as StatementResponse;
                  const depositData = stmtTyped?.deposits;
                  const depositEntries = depositData?.entries || [];
                  const depositSummary = depositData?.summary;
                  if (depositEntries.length === 0 && !depositSummary) return null;

                  return (
                    <div className="mt-6 px-6 pb-4">
                      <h3 className="text-lg font-semibold text-gray-900 mb-3">💰 Deposit Activity</h3>

                      {/* Deposit Summary Cards */}
                      {depositSummary && (
                        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-4">
                          <div className="bg-amber-50 border border-amber-200 rounded p-3">
                            <div className="text-xs text-amber-700">Total Deposited</div>
                            <div className="text-lg font-semibold text-amber-900">{formatCurrency(Number(depositSummary.totalDeposited || 0))}</div>
                          </div>
                          <div className="bg-blue-50 border border-blue-200 rounded p-3">
                            <div className="text-xs text-blue-700">Total Used</div>
                            <div className="text-lg font-semibold text-blue-900">{formatCurrency(Number(depositSummary.totalUsed || 0))}</div>
                          </div>
                          <div className="bg-green-50 border border-green-200 rounded p-3">
                            <div className="text-xs text-green-700">Available Balance</div>
                            <div className="text-lg font-semibold text-green-900">{formatCurrency(Number(depositSummary.availableBalance || 0))}</div>
                          </div>
                          <div className="bg-gray-50 border border-gray-200 rounded p-3">
                            <div className="text-xs text-gray-600">Active Deposits</div>
                            <div className="text-lg font-semibold text-gray-900">{depositSummary.depositCount || 0}</div>
                          </div>
                        </div>
                      )}

                      {/* Deposit Entries Table */}
                      {depositEntries.length > 0 && (
                        <div className="overflow-x-auto">
                          <table className="min-w-full divide-y divide-gray-200">
                            <thead className="bg-amber-50">
                              <tr>
                                <th className="px-6 py-3 text-left text-xs font-medium text-amber-700 uppercase tracking-wider">Date</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-amber-700 uppercase tracking-wider">Type</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-amber-700 uppercase tracking-wider">Reference</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-amber-700 uppercase tracking-wider">Description</th>
                                <th className="px-6 py-3 text-right text-xs font-medium text-amber-700 uppercase tracking-wider">Amount</th>
                                <th className="px-6 py-3 text-right text-xs font-medium text-amber-700 uppercase tracking-wider">Running Balance</th>
                              </tr>
                            </thead>
                            <tbody className="bg-white divide-y divide-gray-200">
                              {depositEntries.map((de: DepositEntry, idx: number) => (
                                <tr key={idx} className="hover:bg-amber-50/50">
                                  <td className="px-6 py-4 text-sm text-gray-600">
                                    {de.date ? formatTimestamp(de.date) : '-'}
                                  </td>
                                  <td className="px-6 py-4">
                                    <span className={`px-2 py-1 rounded text-xs ${de.type === 'DEPOSIT_IN' ? 'bg-green-100 text-green-800' :
                                      de.type === 'DEPOSIT_OUT' ? 'bg-red-100 text-red-800' :
                                        'bg-gray-100 text-gray-800'
                                      }`}>
                                      {de.type === 'DEPOSIT_IN' ? 'Deposit Received' :
                                        de.type === 'DEPOSIT_OUT' ? 'Deposit Applied' :
                                          de.type || 'UNKNOWN'}
                                    </span>
                                  </td>
                                  <td className="px-6 py-4 text-sm text-gray-600">{de.reference || '-'}</td>
                                  <td className="px-6 py-4 text-sm text-gray-600">{de.description || '-'}</td>
                                  <td className="px-6 py-4 text-sm text-right">
                                    <span className={`font-semibold ${Number(de.amount || 0) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                      {Number(de.amount || 0) >= 0 ? '+' : ''}{formatCurrency(Number(de.amount || 0))}
                                    </span>
                                  </td>
                                  <td className="px-6 py-4 text-sm text-right font-bold text-gray-900">
                                    {formatCurrency(Number(de.runningBalance || 0))}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  );
                })()}
              </>
            ) : isLoadingTx ? (
              <div className="text-center py-10 text-gray-500">Loading transactions…</div>
            ) : !txData || (Array.isArray(txData) && txData.length === 0) ? (
              <div className="text-center py-10 text-gray-500">No transactions found</div>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Date</th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Type</th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Amount</th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Reference</th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Description</th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                      {(txData as TransactionRow[]).map((t) => (
                        <tr key={t.id} className="hover:bg-gray-50">
                          <td className="px-6 py-4 text-sm text-gray-600">{formatTimestamp(t.transactionDate)}</td>
                          <td className="px-6 py-4 text-sm text-gray-600">{t.type}</td>
                          <td className={`px-6 py-4 font-semibold ${t.type === 'PAYMENT' ? 'text-red-600' : 'text-green-700'}`}>{formatCurrency(t.amount)}</td>
                          <td className="px-6 py-4 text-sm text-gray-600">{t.referenceNumber || '-'}</td>
                          <td className="px-6 py-4 text-sm text-gray-600">{t.description}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="bg-gray-50 px-6 py-4 border-t border-gray-200 flex items-center justify-between">
                  <div className="text-sm text-gray-700">Page {txPage}</div>
                  <div className="flex gap-2">
                    <button className="px-3 py-1 border border-gray-300 rounded bg-white hover:bg-gray-50 disabled:opacity-50" onClick={() => setTxPage(Math.max(1, txPage - 1))} disabled={txPage === 1}>Previous</button>
                    <button className="px-3 py-1 border border-gray-300 rounded bg-white hover:bg-gray-50" onClick={() => setTxPage(txPage + 1)}>Next</button>
                  </div>
                </div>
              </>
            )}
          </div>
        ) : null}

        {customer && tab === 'edit' ? (
          <div className="bg-white rounded-lg shadow border border-gray-200 p-6 max-w-3xl">
            <h2 className="text-lg font-semibold mb-4">Edit Customer</h2>
            <form className="space-y-4" onSubmit={onEditSubmit}>
              <div>
                <label htmlFor="name" className="block text-sm font-medium text-gray-700">Name</label>
                <input id="name" name="name" placeholder="Customer name" defaultValue={(customer as CustomerDetailData).name} className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500" />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="email" className="block text-sm font-medium text-gray-700">Email</label>
                  <input id="email" name="email" type="email" placeholder="name@example.com" defaultValue={(customer as CustomerDetailData).email ?? ''} className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500" />
                </div>
                <div>
                  <label htmlFor="phone" className="block text-sm font-medium text-gray-700">Phone</label>
                  <input id="phone" name="phone" placeholder="+256 700 000000" defaultValue={(customer as CustomerDetailData).phone ?? ''} className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500" />
                </div>
              </div>
              <div>
                <label htmlFor="address" className="block text-sm font-medium text-gray-700">Address</label>
                <textarea id="address" name="address" placeholder="Street, City, Country" defaultValue={(customer as CustomerDetailData).address ?? ''} rows={3} className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500" />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="creditLimit" className="block text-sm font-medium text-gray-700">Credit Limit</label>
                  <input
                    id="creditLimit"
                    name="creditLimit"
                    type="number"
                    step="1"
                    placeholder="0.00"
                    defaultValue={(customer as CustomerDetailData).creditLimit}
                    disabled={editUnlimitedCredit}
                    className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100"
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
                      <span className="text-gray-500"> — no hard AR ceiling</span>
                    </span>
                  </label>
                  {editUnlimitedCredit ? (
                    <p className="text-xs text-indigo-700 mt-1">
                      Credit/on-account sales will not be blocked by a numeric limit.
                    </p>
                  ) : (
                    <p className="text-xs text-gray-500 mt-1">Set to 0 for cash-only (no credit headroom).</p>
                  )}
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700">Customer group</label>
                  <p className="mt-1 px-3 py-2 border border-gray-200 rounded-lg bg-gray-50 text-sm text-gray-700">
                    {customerGroupName ?? 'Not assigned'}
                  </p>
                  <p className="text-xs text-gray-400 mt-1">
                    Assign via Customers → Customer Groups
                  </p>
                </div>
              </div>
              <div>
                <label htmlFor="customerPriceGroup" className="block text-sm font-medium text-gray-700">Price group</label>
                <select
                  id="customerPriceGroup"
                  value={editPriceGroupId}
                  onChange={(e) => setEditPriceGroupId(e.target.value)}
                  className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">— Standard pricing —</option>
                  {priceGroups.map((pg) => (
                    <option key={pg.id} value={pg.id}>
                      {pg.name}{pg.pricingMode === 'AT_COST' ? ' (At Cost)' : ''}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-gray-400 mt-1">
                  At Cost sells at inventory cost. Leave empty for normal retail pricing.
                </p>
              </div>
              <div className="rounded-lg border border-sky-200 bg-sky-50/60 p-4 space-y-3">
                <div className="flex items-start gap-3">
                  <Checkbox
                    id="customer-wht-liable"
                    checked={editWhtLiable}
                    onCheckedChange={(checked) => {
                      const on = checked === true;
                      setEditWhtLiable(on);
                      if (!on) setEditDefaultWhtTypeId('');
                    }}
                  />
                  <div>
                    <Label htmlFor="customer-wht-liable" className="text-sm font-medium text-gray-900">
                      Customer withholds tax (WHT receivable)
                    </Label>
                    <p className="text-xs text-gray-600 mt-0.5">
                      When this customer deducts WHT from payments to you, receipts will suggest that type.
                    </p>
                  </div>
                </div>
                {editWhtLiable && (
                  <div>
                    <Label htmlFor="customer-default-wht" className="text-sm font-medium text-gray-700">
                      Default WHT type
                    </Label>
                    <select
                      id="customer-default-wht"
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
                  </div>
                )}
              </div>
              <div className="flex items-center gap-3">
                <button type="submit" className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50" disabled={updateCustomer.isPending}>Save Changes</button>
                <button type="button" className="px-4 py-2 bg-white border border-gray-300 rounded-lg hover:bg-gray-50" onClick={() => setTab('overview')}>Cancel</button>
              </div>
              {updateCustomer.isError && (
                <p className="text-sm text-red-600">Failed to update customer</p>
              )}
              {updateCustomer.isSuccess && (
                <p className="text-sm text-green-700">Customer updated</p>
              )}
            </form>
          </div>
        ) : null}

        {/* Deposits Tab */}
        {customer && tab === 'deposits' ? (
          <CustomerDeposits
            customerId={id}
            customerName={String((customer as { name?: string }).name ?? '').trim() || 'Customer'}
            onDepositChange={() => {
              window.location.reload();
            }}
          />
        ) : null}

        {/* Store Credits Tab */}
        {customer && tab === 'credits' ? (
          <StoreCredits
            customerId={id}
            customerName={String((customer as { name?: string }).name ?? '').trim() || 'Customer'}
            onCreditChange={() => {
              window.location.reload();
            }}
          />
        ) : null}

        {/* Quotations Tab */}
        {customer && tab === 'quotations' ? (
          <CustomerQuotationsTab customerId={id} />
        ) : null}
      </div>

      {/* Record Payment Modal */}
      {isPaymentOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => setPaymentOpen(false)}>
          <div ref={modalRef} role="dialog" aria-modal="true" aria-label="Record Payment" className="bg-white w-full max-w-md rounded-lg shadow-lg border border-gray-200 p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold">Record Payment</h3>
              <button onClick={() => setPaymentOpen(false)} className="p-2 rounded hover:bg-gray-100" aria-label="Close">✕</button>
            </div>
            <form className="space-y-4" onSubmit={onSubmitPayment}>
              <div>
                <label className="block text-sm font-medium text-gray-700">Invoice</label>
                <div className="mt-1 text-sm text-gray-900">{selectedInvoice?.invoiceNumber} · Balance: {formatCurrency(selectedInvoice?.balance ?? 0)}</div>
              </div>
              <div>
                <label htmlFor="amount" className="block text-sm font-medium text-gray-700">Amount</label>
                <input id="amount" name="amount" inputMode="decimal" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} placeholder="0.00" className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500" required autoFocus />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label htmlFor="method" className="block text-sm font-medium text-gray-700">Method</label>
                  <select id="method" name="method" value={payMethod} onChange={(e) => {
                    const next = e.target.value;
                    setPayMethod(next);
                    if (next === 'DEPOSIT' && depositBalance.hasDeposit) {
                      setPayAmount(
                        depositPaymentCap(selectedInvoice?.balance ?? 0, depositBalance.available).toFixed(2),
                      );
                    }
                  }} className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500" disabled={depositBalance.status === 'loading'}>
                    <option value="CASH">Cash</option>
                    <option value="CARD">Card</option>
                    <option value="MOBILE_MONEY">Mobile Money</option>
                    <option value="BANK_TRANSFER">Bank Transfer</option>
                    <option value="CREDIT">Credit</option>
                    <option value="DEPOSIT" disabled={depositBalance.status !== 'ready' || depositBalance.available.lte(0)}>
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
                      Could not load deposit balance. {depositBalance.error}{' '}
                      <button type="button" className="underline font-medium" onClick={depositBalance.retry}>Retry</button>
                    </p>
                  )}
                  {payMethod === 'DEPOSIT' && depositBalance.hasDeposit && (
                    <p className="mt-1 text-sm text-amber-600 font-medium">
                      Using customer deposit. Available: {formatCurrency(depositBalance.available.toNumber())}
                    </p>
                  )}
                </div>
                <div>
                  <label htmlFor="paidAt" className="block text-sm font-medium text-gray-700">Date</label>
                  <input id="paidAt" name="paidAt" type="datetime-local" value={payDate} onChange={(e) => setPayDate(e.target.value)} className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500" />
                </div>
              </div>
              <div>
                <label htmlFor="reference" className="block text-sm font-medium text-gray-700">Reference</label>
                <input id="reference" name="reference" value={payReferenceNumber} onChange={(e) => setPayReferenceNumber(e.target.value)} placeholder="Txn ID / Ref" className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label htmlFor="notes" className="block text-sm font-medium text-gray-700">Notes</label>
                <textarea id="notes" name="notes" value={payNotes} onChange={(e) => setPayNotes(e.target.value)} className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500" rows={2} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} />
              </div>
              {recordPayment.isError && (
                <p className="text-sm text-red-600">Failed to record payment</p>
              )}
              <div className="flex items-center justify-end gap-3 pt-2">
                <button type="button" className="px-4 py-2 bg-white border border-gray-300 rounded-lg hover:bg-gray-50" onClick={() => setPaymentOpen(false)}>Cancel</button>
                <button type="submit" className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50" disabled={recordPayment.isPending || depositBalance.status === 'loading' || (payMethod === 'DEPOSIT' && depositBalance.status !== 'ready')}>Save Payment</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Invoice Details Drawer */}
      {isDetailsOpen && (
        <div className="fixed inset-0 z-40">
          <div className="absolute inset-0 bg-black/40" onClick={() => setDetailsOpen(false)} />
          <div ref={detailsRef} role="dialog" aria-modal="true" aria-label="Invoice Details" className="absolute right-0 top-0 h-full w-full max-w-lg bg-white shadow-xl border-l border-gray-200 p-6 overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold">Invoice Details</h3>
              <div className="flex items-center gap-2">
                {detailsInvoice &&
                  canAdjustInvoices &&
                  !isCustomerOpeningBalance(detailsInvoice) &&
                  Number(detailsInvoice.balance ?? 0) > 0.009 && (
                  <button
                    type="button"
                    onClick={() => setAdjustInvoiceOpen(true)}
                    className="px-3 py-1 text-sm border border-amber-500 text-amber-800 rounded bg-amber-50 hover:bg-amber-100"
                  >
                    Adjust
                  </button>
                )}
                {detailsInvoice && (
                  <button
                    onClick={() => downloadFile(
                      `/invoices/${detailsInvoice.id}/export.pdf`,
                      `invoice-${detailsInvoice.invoiceNumber}.pdf`
                    )}
                    className="px-3 py-1 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
                    aria-label="Export PDF"
                  >
                    📄 PDF
                  </button>
                )}
                <button onClick={() => setDetailsOpen(false)} className="p-2 rounded hover:bg-gray-100" aria-label="Close">✕</button>
              </div>
            </div>
            {detailsInvoice ? (
              <div className="space-y-4">
                <div className="bg-gray-50 border border-gray-200 rounded p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm text-gray-600">Invoice</div>
                      <div className="text-lg font-semibold">{detailsInvoice.invoiceNumber}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-sm text-gray-600">Status</div>
                      <span className={`px-2 py-1 rounded-full text-xs ${detailsInvoice.status === 'PAID' ? 'bg-green-100 text-green-800' : detailsInvoice.status === 'PARTIALLY_PAID' ? 'bg-yellow-100 text-yellow-800' : 'bg-gray-100 text-gray-800'}`}>{detailsInvoice.status}</span>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4 mt-3 text-sm">
                    <div>
                      <div className="text-gray-600">Issued</div>
                      <div className="text-gray-900">{detailsInvoice.issueDate ? formatTimestamp(detailsInvoice.issueDate) : '-'}</div>
                    </div>
                    <div>
                      <div className="text-gray-600">Due</div>
                      <div className="text-gray-900">{detailsInvoice.dueDate ? formatTimestampDate(detailsInvoice.dueDate) : '-'}</div>
                    </div>
                    <div>
                      <div className="text-gray-600">Total</div>
                      <div className="font-semibold">{formatCurrency(detailsInvoice.totalAmount)}</div>
                    </div>
                    <div>
                      <div className="text-gray-600">Balance</div>
                      <div className="font-semibold">{formatCurrency(detailsInvoice.balance)}</div>
                    </div>
                  </div>
                </div>

                {(() => {
                  const source = (invoiceDetail as InvoiceDetailData | undefined)?.sourceQuotation;
                  if (!source) return null;
                  return (
                    <InvoiceSourceQuotationPanel
                      source={source}
                      customer={{
                        name: (customer as CustomerDetailData | undefined)?.name ?? '',
                        email: (customer as CustomerDetailData | undefined)?.email ?? null,
                        phone: (customer as CustomerDetailData | undefined)?.phone ?? null,
                      }}
                      invoiceAuthorisedByName={(invoiceDetail as InvoiceDetailData | undefined)?.invoiceAuthorisedByName}
                      className="mb-4"
                    />
                  );
                })()}

                {/* Invoice Items */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <h4 className="text-md font-semibold">Items</h4>
                  </div>
                  {(() => {
                    const items = (invoiceDetail as InvoiceDetailData | undefined)?.items;
                    if (!items || items.length === 0) {
                      return <div className="text-gray-500">No items</div>;
                    }
                    return (
                      <div className="overflow-x-auto">
                        <table className="min-w-full divide-y divide-gray-200">
                          <thead className="bg-gray-50">
                            <tr>
                              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Product</th>
                              <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">Qty</th>
                              <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">Unit Price</th>
                              <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">Line Total</th>
                            </tr>
                          </thead>
                          <tbody className="bg-white divide-y divide-gray-200">
                            {items.map((it) => {
                              const displayName = (it.productName
                                || inventoryNameById.get(String(it.productId ?? it.product_id))
                                || it.productCode
                                || it.sku
                                || String(it.productId ?? it.product_id));
                              return (
                                <tr key={it.id || it.productId || it.product_id} className="hover:bg-gray-50">
                                  <td className="px-4 py-2 text-sm text-gray-700">{displayName}</td>
                                  <td className="px-4 py-2 text-sm text-gray-700 text-right">{it.quantity}</td>
                                  <td className="px-4 py-2 text-sm text-gray-700 text-right">{formatCurrency(Number(it.unitPrice ?? it.unit_price ?? 0))}</td>
                                  <td className="px-4 py-2 font-semibold text-right">{formatCurrency(Number(it.lineTotal ?? it.line_total ?? (Number(it.unitPrice ?? it.unit_price ?? 0) * Number(it.quantity ?? 0))))}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    );
                  })()}
                </div>

                <div>
                  <div className="flex items-center justify-between mb-2">
                    <h4 className="text-md font-semibold">Payments</h4>
                    {detailsInvoice.status !== 'PAID' && (
                      <button className="px-3 py-1 text-sm border border-gray-300 rounded bg-white hover:bg-gray-50" onClick={() => { setPaymentOpen(true); setSelectedInvoice(detailsInvoice); }}>Record Payment</button>
                    )}
                  </div>
                  {isLoadingPayments ? (
                    <div className="text-gray-500">Loading payments…</div>
                  ) : (() => {
                    const payments = ((invoiceDetail as InvoiceDetailData | undefined)?.payments as PaymentHistoryRow[]) || (paymentHistory as PaymentHistoryRow[]);
                    if (!payments || payments.length === 0) {
                      return <div className="text-gray-500">No payments recorded</div>;
                    }
                    return (
                      <div className="overflow-x-auto">
                        <table className="min-w-full divide-y divide-gray-200">
                          <thead className="bg-gray-50">
                            <tr>
                              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Receipt</th>
                              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Date</th>
                              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Method</th>
                              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Amount</th>
                              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Reference</th>
                            </tr>
                          </thead>
                          <tbody className="bg-white divide-y divide-gray-200">
                            {payments.map((p) => (
                              <tr key={p.id} className="hover:bg-gray-50">
                                <td className="px-4 py-2 text-sm text-gray-700">{p.receiptNumber ?? p.receipt_number}</td>
                                <td className="px-4 py-2 text-sm text-gray-600">{p.paymentDate ? formatTimestamp(p.paymentDate) : (p.payment_date ? formatTimestamp(p.payment_date) : '-')}</td>
                                <td className="px-4 py-2 text-sm text-gray-600">{p.paymentMethod ?? p.payment_method}</td>
                                <td className="px-4 py-2 font-semibold">{formatCurrency(typeof p.amount === 'number' ? p.amount : Number(p.amount ?? 0))}</td>
                                <td className="px-4 py-2 text-sm text-gray-600">{p.referenceNumber ?? p.reference_number ?? '-'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    );
                  })()}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      )}

      {/* Create Invoice Modal */}
      {isCreateOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => setCreateOpen(false)}>
          <div ref={createRef} role="dialog" aria-modal="true" aria-label="Create Invoice" className="bg-white w-full max-w-[95vw] sm:max-w-2xl rounded-lg shadow-lg border border-gray-200 p-4 sm:p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold">Create Invoice</h3>
              <button onClick={() => setCreateOpen(false)} className="p-2 rounded hover:bg-gray-100" aria-label="Close">✕</button>
            </div>
            <form className="space-y-4" onSubmit={onSubmitCreateInvoice}>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Select Sale</label>
                {isLoadingCustomerSales ? (
                  <div className="text-gray-500">Loading sales…</div>
                ) : salesWithoutInvoices.length === 0 ? (
                  <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                    <p className="text-sm text-blue-800">
                      ℹ️ All credit sales for this customer already have invoices.
                    </p>
                    <p className="text-xs text-blue-600 mt-2">
                      Invoices are automatically created when credit sales are completed.
                    </p>
                  </div>
                ) : (
                  <div className="max-h-64 overflow-auto border border-gray-200 rounded">
                    <table className="min-w-full divide-y divide-gray-200">
                      <thead className="bg-gray-50 sticky top-0">
                        <tr>
                          <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Select</th>
                          <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Sale</th>
                          <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Date</th>
                          <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Total</th>
                          <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Payment</th>
                        </tr>
                      </thead>
                      <tbody className="bg-white divide-y divide-gray-200">
                        {salesWithoutInvoices.map((s) => (
                          <tr key={s.id} className="hover:bg-gray-50">
                            <td className="px-4 py-2">
                              <input
                                type="radio"
                                name="sale"
                                value={s.id}
                                checked={selectedSaleId === String(s.id)}
                                onChange={() => setSelectedSaleId(String(s.id))}
                                aria-label={`Select sale ${s.saleNumber}`}
                              />
                            </td>
                            <td className="px-4 py-2 text-sm text-gray-700">{s.saleNumber}</td>
                            <td className="px-4 py-2 text-sm text-gray-600">{s.saleDate ? formatTimestamp(s.saleDate) : '-'}</td>
                            <td className="px-4 py-2 font-semibold">{formatCurrency(s.totalAmount ?? 0)}</td>
                            <td className="px-4 py-2">
                              <span className={`px-2 py-1 rounded text-xs ${s.paymentMethod === 'CREDIT' ? 'bg-yellow-100 text-yellow-800' : 'bg-green-100 text-green-800'}`}>
                                {s.paymentMethod}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label htmlFor="dueDate" className="block text-sm font-medium text-gray-700">Due Date</label>
                  <DatePicker
                    value={dueDate}
                    onChange={(date) => setDueDate(date)}
                    placeholder="Select due date"
                    minDate={new Date()}
                  />
                </div>
                <div>
                  <label htmlFor="initialPayment" className="block text-sm font-medium text-gray-700">Initial Payment</label>
                  <input id="initialPayment" name="initialPayment" inputMode="decimal" value={initialPayment} onChange={(e) => setInitialPayment(e.target.value)} placeholder="0.00" className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500" />
                </div>
              </div>
              <div>
                <label htmlFor="createNotes" className="block text-sm font-medium text-gray-700">Notes</label>
                <textarea id="createNotes" name="createNotes" value={createNotes} onChange={(e) => setCreateNotes(e.target.value)} className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500" rows={3} />
              </div>
              {(createInvoice.isError || createError) && (
                <p className="text-sm text-red-600">{createError || 'Failed to create invoice'}</p>
              )}
              <div className="flex items-center justify-end gap-3 pt-2">
                <button type="button" className="px-4 py-2 bg-white border border-gray-300 rounded-lg hover:bg-gray-50" onClick={() => setCreateOpen(false)}>Cancel</button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
                  disabled={createInvoice.isPending || (!selectedSaleId && !id) || salesWithoutInvoices.length === 0}
                >
                  Create
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteConfirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50" onClick={() => setDeleteConfirmOpen(false)}>
          <div
            ref={deleteConfirmRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-confirm-title"
            className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4 p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="delete-confirm-title" className="text-lg font-semibold text-gray-900 mb-4">Delete Customer</h3>
            <p className="text-gray-600 mb-6">
              Are you sure you want to delete <span className="font-semibold">{(customer as CustomerDetailData | undefined)?.name}</span>?
              This will deactivate the customer (soft delete) while preserving all transaction history.
            </p>
            <div className="flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => setDeleteConfirmOpen(false)}
                className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDelete}
                disabled={deleteCustomerM.isPending}
                className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50"
              >
                {deleteCustomerM.isPending ? 'Deleting...' : 'Delete Customer'}
              </button>
            </div>
          </div>
        </div>
      )}

      {detailsInvoice?.id && (
        <AdjustCustomerInvoiceModal
          open={adjustInvoiceOpen}
          onClose={() => setAdjustInvoiceOpen(false)}
          invoiceId={detailsInvoice.id}
          invoiceNumber={detailsInvoice.invoiceNumber}
          customerId={id}
        />
      )}
    </Layout>
  );
}
