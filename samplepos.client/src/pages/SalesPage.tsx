import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import Layout from '../components/Layout';
import { useSales, useSalesSummary, useSalesSummaryByDate, useSalesByCashier } from '../hooks/useApi';
import { useAuth } from '../hooks/useAuth';
import { shouldRestrictSalesToOwnUser, shouldLockSalesToBusinessDay } from '@shared/authorization/salesPolicy';
import {
  AGED_SALE_RETURN_DAYS,
  canProcessAgedSaleReturn,
  agedSaleReturnDeniedMessage,
} from '@shared/authorization/agedSaleReturnPolicy';
import { formatCurrency } from '../utils/currency';
import { BUSINESS_TIMEZONE, getBusinessDate, formatTimestamp, formatTimestampDate } from '../utils/businessDate';
import Decimal from 'decimal.js';
import { api } from '../utils/api';
import { DatePicker } from '../components/ui/date-picker';
import { toast } from 'react-hot-toast';
import { printReceipt } from '../lib/print';
import {
  fetchReceiptPrintConfig,
  isReceiptPrintingEnabled,
  applyReceiptPrintPresentation,
} from '../lib/receiptPrintConfig';
import {
  buildReceiptDataFromSale,
  mergeSaleForReceipt,
  fetchInvoiceSettingsForReceipt,
  type InvoiceSettingsForReceipt,
  type SaleForReceipt,
} from '../lib/receiptFromSale';
import { DocumentFlowButton } from '../components/shared/DocumentFlowButton';
import { VoidSaleModal } from '../components/sales/VoidSaleModal';
import { RefundSaleModal } from '../components/sales/RefundSaleModal';
import { ProductExchangeModal } from '../components/sales/ProductExchangeModal';
import { SaleCustomerReassignmentModal } from '../components/sales/SaleCustomerReassignmentModal';
import { SaleTaxRestatementModal } from '../components/sales/SaleTaxRestatementModal';
import {
  AdaptivePage,
  AdaptiveSearch,
  AdaptiveToolbar,
} from '../components/adaptive';
import {
  ADAPTIVE_PAGE_PAD_CLASS,
  KPI_ACCENT_GRID_CLASS,
  KPI_ACCENT_LABEL_CLASS,
  KPI_ACCENT_SUB_CLASS,
  KPI_ACCENT_VALUE_CLASS,
  kpiAccentCardClass,
} from '../lib/adaptiveDashboard';
import { useBackendPermission } from '../hooks/useBackendPermission';
import { useCanAccess } from '../components/auth/ProtectedRoute';
import { CreateExpenseForm } from '../components/expenses/CreateExpenseForm';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../components/ui/temp-ui-components';
import { SortableTableHeader } from '../components/ui/SortableTableHeader';
import { MobileSortSelect } from '../components/ui/MobileSortSelect';
import { useColumnSort } from '../hooks/useColumnSort';
import { useServerTableSort } from '../hooks/useServerTableSort';
import { applyTableSort } from '../lib/tableSortUtils';

// ── Local type definitions ──────────────────────────────────────────────

/** Normalized sale row for UI display (financial fields are numbers) */
interface SaleRow {
  id: string;
  saleNumber: string;
  customerId?: string;
  customerName?: string;
  customerPhone?: string;
  customerEmail?: string;
  cashierId?: string;
  cashierName?: string;
  soldById?: string;
  soldByName?: string;
  saleDate: string;
  subtotal: number;
  taxAmount: number;
  discountAmount: number;
  totalAmount: number;
  totalCost: number;
  profit: number;
  profitMargin: number;
  amountPaid: number;
  paymentReceived: number;
  changeAmount: number;
  paymentMethod: string;
  status: string;
  notes?: string;
  createdAt: string;
  items?: SaleItemRow[];
  paymentLines?: PaymentLine[];
  /** Raw snake_case aliases used defensively in modal */
  discount_amount?: number | string;
  tax_amount?: number | string;
}

interface SaleItemRow {
  id?: string;
  productId?: string;
  productName?: string;
  product_name?: string;
  quantity: number | string;
  qty?: number | string;
  unitPrice?: number | string;
  unit_price?: number | string;
  price?: number | string;
  subtotal?: number | string;
  totalPrice?: number | string;
  total_price?: number | string;
  lineTotal?: number | string;
  line_total?: number | string;
  discountAmount?: number | string;
  discount_amount?: number | string;
  taxAmount?: number | string;
  totalAmount?: number | string;
  batchNumber?: string;
}

interface PaymentLine {
  paymentMethod?: string;
  payment_method?: string;
  amount: number | string;
  reference?: string;
}

interface CustomerGroup {
  customerId: string;
  customerName: string;
  salesCount: number;
  totalAmount: Decimal;
  totalProfit: Decimal;
  sales: SaleRow[];
}

interface UserGroup {
  userId: string;
  userName: string;
  salesCount: number;
  totalAmount: Decimal;
  totalProfit: Decimal;
  sales: SaleRow[];
}

interface SalesSummary {
  totalAmount?: string;
  total_amount?: string;
  totalProfit?: string;
  total_profit?: string;
  totalSales?: string;
  total_sales?: string;
  totalDiscounts?: string;
  total_discounts?: string;
  creditSalesCount?: number;
  credit_sales_count?: number;
  partialPaymentCount?: number;
  partial_payment_count?: number;
  byPaymentMethod?: Record<string, string | undefined>[];
  by_payment_method?: Record<string, string | undefined>[];
}

interface NormalizedPaymentMethod {
  paymentMethod: string;
  count: number;
  totalAmount: number;
}

interface SalesTableProps {
  sales: SaleRow[];
  onSelectSale: (sale: SaleRow) => void;
  pagination?: { page: number; totalPages: number; total: number; limit: number };
  currentPage: number;
  onPageChange: (page: number) => void;
  sortField: SalesTableSortField;
  sortOrder: 'asc' | 'desc';
  onColumnSort: (field: string) => void;
  onToggleSortOrder: () => void;
}

interface CustomerSalesViewProps {
  customers: CustomerGroup[];
  onSelectSale: (sale: SaleRow) => void;
}

interface UserSalesViewProps {
  users: UserGroup[];
  onSelectSale: (sale: SaleRow) => void;
  startDate?: string;
  endDate?: string;
}

interface CreditSalesViewProps {
  onSelectSale: (sale: SaleRow) => void;
  startDate?: string;
  endDate?: string;
}

interface PartialPaymentsViewProps {
  onSelectSale: (sale: SaleRow) => void;
  startDate?: string;
  endDate?: string;
}

interface OrderGroup {
  userId: string;
  userName: string;
  orderCount: number;
  pendingCount: number;
  completedCount: number;
  cancelledCount: number;
  totalValue: Decimal;
}

interface OrderedByViewProps {
  groups: OrderGroup[];
  startDate?: string;
  endDate?: string;
}

interface SaleDetailModalProps {
  sale: SaleRow;
  onClose: () => void;
  onSaleUpdated?: () => void;
}

type TabType = 'overview' | 'by-customer' | 'by-user' | 'ordered-by' | 'invoices' | 'payments' | 'all-sales';
type DateFilterType =
  | 'today'
  | 'yesterday'
  | 'this-week'
  | 'last-week'
  | 'this-month'
  | 'last-month'
  | 'custom';

// Format date string from database (YYYY-MM-DD or ISO) to readable format
function formatDisplayDate(dateString: string | null | undefined): string {
  if (!dateString) return 'N/A';

  // If it's already in YYYY-MM-DD format, return as-is
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
    return dateString;
  }

  // If it's an ISO string, extract the date part
  if (dateString.includes('T')) {
    return dateString.split('T')[0];
  }

  return dateString;
}

/** Single date+time column for sales (business TZ). Prefers createdAt, then saleDate. */
function formatSaleDateTime(sale: { saleDate?: string; createdAt?: string }): string {
  const ts = sale.createdAt || sale.saleDate;
  if (!ts) return 'N/A';
  if (/^\d{4}-\d{2}-\d{2}$/.test(ts)) {
    return formatTimestampDate(ts);
  }
  return formatTimestamp(ts);
}

// Format timestamp to display time (HH:MM:SS format) in business timezone
function formatDisplayTime(timestamp: string | null | undefined): string {
  if (!timestamp) return 'N/A';

  try {
    const date = new Date(timestamp);
    if (isNaN(date.getTime())) return 'N/A';

    // Format as HH:MM:SS in 24-hour format, pinned to business timezone
    return date.toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZone: BUSINESS_TIMEZONE,
    });
  } catch {
    return 'N/A';
  }
}

type SalesTableSortField = 'saleNumber' | 'date' | 'customer' | 'amount' | 'profit' | 'payment' | 'status';
type CreditSalesSortField = 'saleNumber' | 'customer' | 'date' | 'total' | 'paid' | 'outstanding';
type PartialPaymentsSortField = 'saleNumber' | 'customer' | 'date' | 'total' | 'paid' | 'balance';
type NestedSaleSortField = 'saleNumber' | 'date' | 'customer' | 'amount' | 'payment';
type OrderedBySortField = 'orderNumber' | 'customer' | 'date' | 'status' | 'amount';

function saleSortDate(sale: { saleDate?: string; createdAt?: string }): string {
  return sale.createdAt || sale.saleDate || '';
}

function saleOutstanding(sale: SaleRow): number {
  return new Decimal(sale.totalAmount || 0)
    .minus(sale.paymentReceived || sale.amountPaid || 0)
    .toNumber();
}

function saleAmountPaid(sale: SaleRow): number {
  return sale.paymentReceived || sale.amountPaid || 0;
}

// Utility functions for precise date calculations
function getDateRange(filterType: DateFilterType): { start: string; end: string } {
  // Simple date formatting without any timezone manipulation
  const formatDate = (year: number, month: number, day: number): string => {
    const m = String(month).padStart(2, '0');
    const d = String(day).padStart(2, '0');
    return `${year}-${m}-${d}`;
  };

  // Use business timezone date (Africa/Kampala) instead of browser local date
  const todayStr = getBusinessDate(); // YYYY-MM-DD in business timezone
  const [yearStr, monthStr, dayStr] = todayStr.split('-');
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10); // 1-12
  const day = parseInt(dayStr, 10);
  // Construct Date from business-date parts for calendar math (weekday, month boundaries)
  const today = new Date(year, month - 1, day);

  let startYear = year,
    startMonth = month,
    startDay = day;
  let endYear = year,
    endMonth = month,
    endDay = day;

  switch (filterType) {
    case 'today':
      // Start and end are today
      break;

    case 'yesterday': {
      const yesterday = new Date(year, month - 1, day - 1);
      startYear = endYear = yesterday.getFullYear();
      startMonth = endMonth = yesterday.getMonth() + 1;
      startDay = endDay = yesterday.getDate();
      break;
    }

    case 'this-week': {
      // Find Monday of current week
      const currentDay = today.getDay(); // 0 = Sunday, 1 = Monday, etc.
      const daysFromMonday = currentDay === 0 ? 6 : currentDay - 1;
      const monday = new Date(year, month - 1, day - daysFromMonday);
      startYear = monday.getFullYear();
      startMonth = monday.getMonth() + 1;
      startDay = monday.getDate();
      break;
    }

    case 'last-week': {
      // Find Monday and Sunday of last week
      const currentWeekDay = today.getDay();
      const daysToLastSunday = currentWeekDay === 0 ? 7 : currentWeekDay;
      const lastSunday = new Date(year, month - 1, day - daysToLastSunday);
      const lastMonday = new Date(year, month - 1, day - daysToLastSunday - 6);

      startYear = lastMonday.getFullYear();
      startMonth = lastMonday.getMonth() + 1;
      startDay = lastMonday.getDate();
      endYear = lastSunday.getFullYear();
      endMonth = lastSunday.getMonth() + 1;
      endDay = lastSunday.getDate();
      break;
    }

    case 'this-month':
      startDay = 1; // First day of current month
      break;

    case 'last-month': {
      const lastMonth = new Date(year, month - 2, 1); // month - 2 because getMonth() is 0-based
      const lastDayOfLastMonth = new Date(year, month - 1, 0); // Day 0 = last day of previous month

      startYear = lastMonth.getFullYear();
      startMonth = lastMonth.getMonth() + 1;
      startDay = 1;
      endYear = lastDayOfLastMonth.getFullYear();
      endMonth = lastDayOfLastMonth.getMonth() + 1;
      endDay = lastDayOfLastMonth.getDate();
      break;
    }

    default:
      return { start: '', end: '' };
  }

  return {
    start: formatDate(startYear, startMonth, startDay),
    end: formatDate(endYear, endMonth, endDay),
  };
}

// Statuses that should not count in revenue/profit totals
const VOID_STATUSES = ['VOID', 'REFUNDED', 'VOIDED_BY_RETURN'];

export default function SalesPage() {
  const { user, permissions } = useAuth();
  const isScopedSalesUser = useMemo(
    () => shouldRestrictSalesToOwnUser(permissions, user?.role),
    [permissions, user?.role],
  );
  const lockSalesToBusinessDay = useMemo(
    () => shouldLockSalesToBusinessDay(permissions, user?.role),
    [permissions, user?.role],
  );
  const [activeTab, setActiveTab] = useState<TabType>(isScopedSalesUser ? 'all-sales' : 'overview');
  const [dateFilter, setDateFilter] = useState<DateFilterType>(
    lockSalesToBusinessDay ? 'today' : 'this-month',
  );

  // Initialize with this month's date range (cashiers: business day only)
  const initialRange = getDateRange(lockSalesToBusinessDay ? 'today' : 'this-month');
  const [startDate, setStartDate] = useState<string>(initialRange.start);
  const [endDate, setEndDate] = useState<string>(initialRange.end);
  const [paymentMethodFilter, setPaymentMethodFilter] = useState<string>('ALL');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [selectedSale, setSelectedSale] = useState<SaleRow | null>(null);
  const [isCreateExpenseOpen, setIsCreateExpenseOpen] = useState(false);
  const canCreateExpense = useCanAccess([], ['expenses.create']);

  const [currentPage, setCurrentPage] = useState(1);
  const limit = 50;

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchQuery.trim()), 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  useEffect(() => {
    setCurrentPage(1);
  }, [paymentMethodFilter, statusFilter, debouncedSearch, startDate, endDate]);

  const {
    sortField: salesSortField,
    sortOrder: salesSortOrder,
    handleColumnSort: handleSalesColumnSort,
    setSortOrder: setSalesSortOrder,
    serverListParams: salesServerParams,
  } = useServerTableSort<SalesTableSortField>({
    defaultField: 'date',
    defaultOrder: 'desc',
    onQueryChange: () => setCurrentPage(1),
  });

  // Handle date filter change
  const handleDateFilterChange = (filter: DateFilterType) => {
    if (lockSalesToBusinessDay && filter !== 'today') return;
    setDateFilter(filter);
    if (filter !== 'custom') {
      const range = getDateRange(filter);
      setStartDate(range.start);
      setEndDate(range.end);
    }
  };

  useEffect(() => {
    if (!lockSalesToBusinessDay) return;
    const range = getDateRange('today');
    setDateFilter('today');
    setStartDate(range.start);
    setEndDate(range.end);
  }, [lockSalesToBusinessDay]);

  // Fetch sales data (send dates without timezone conversion)
  const { data: salesData, isLoading: salesLoading, refetch: refetchSales } = useSales(currentPage, limit, {
    startDate: startDate ? startDate : undefined,
    endDate: endDate ? endDate : undefined,
    cashierId: isScopedSalesUser ? user?.id : undefined,
    status: statusFilter !== 'ALL' ? statusFilter : undefined,
    paymentMethod: paymentMethodFilter !== 'ALL' ? paymentMethodFilter : undefined,
    search: debouncedSearch || undefined,
    ...salesServerParams,
  });

  // Fetch summary data
  const { data: summaryData, isLoading: summaryLoading } = useSalesSummary(
    startDate ? startDate : undefined,
    endDate ? endDate : undefined
  );

  // Fetch daily sales trend
  const { data: dailyTrendData } = useSalesSummaryByDate('day', {
    startDate: startDate ? startDate : undefined,
    endDate: endDate ? endDate : undefined,
  });

  // Fetch server-side cashier performance (correct totals, not limited by pagination)
  const { data: cashierData } = useSalesByCashier({
    startDate: startDate ? startDate : undefined,
    endDate: endDate ? endDate : undefined,
  });

  // Extract data from API responses
  // useSales now returns { data: [...], pagination: {...} }
  const sales = salesData?.data || [];
  const pagination = salesData?.pagination;

  // useSalesSummary uses default selector which extracts response.data.data (the summary object)
  const summary = summaryData || {};

  // dailyTrendData is already extracted by the hook's selector (response.data.data)
  // So it's the array directly, not wrapped in another data property
  const dailyTrendRaw = Array.isArray(dailyTrendData) ? dailyTrendData : [];

  // Normalize daily trend data (convert snake_case from DB to camelCase)
  const dailyTrend = useMemo(() => {
    return dailyTrendRaw.map((day: Record<string, unknown>) => ({
      period: String(day.period || ''),
      date: String(day.period || ''), // Use period as date
      count: Number(day.transaction_count || 0),
      totalAmount: Number(day.total_revenue || 0),
      totalCost: Number(day.total_cost || 0),
      totalProfit: Number(day.total_profit || 0),
      avgTransaction: Number(day.avg_transaction_value || 0),
    }));
  }, [dailyTrendRaw]);

  // Normalize sales data (convert snake_case from DB to camelCase for UI)
  // Following MANDATORY TypeScript Standards from copilot-instructions.md
  const normalizedSales: SaleRow[] = useMemo(() => {
    return (sales as Record<string, unknown>[]).map((sale) => {
      // Parse all financial fields as numbers (PostgreSQL numeric returns as string)
      const totalAmount = Number(sale.total_amount || sale.totalAmount || 0);
      const totalCost = Number(sale.total_cost || sale.totalCost || 0);
      const profit = Number(sale.profit || 0);
      const subtotal = Number(sale.subtotal || 0);
      const taxAmount = Number(sale.tax_amount || sale.taxAmount || 0);

      return {
        // Dual ID System (per instructions)
        id: String(sale.id || ''), // UUID - keep internal
        saleNumber: String(sale.sale_number || sale.saleNumber || ''), // Business ID - display everywhere

        // Relations
        customerId: String(sale.customer_id || sale.customerId || ''),
        customerName: String(sale.customer_name || sale.customerName || ''),
        customerPhone: String(sale.customer_phone || sale.customerPhone || '') || undefined,
        customerEmail: String(sale.customer_email || sale.customerEmail || '') || undefined,
        cashierId: String(sale.cashier_id || sale.cashierId || ''),
        cashierName: String(sale.cashier_name || sale.cashierName || ''),
        soldById: String(sale.cashier_id || sale.cashierId || ''), // Alias
        soldByName: String(sale.cashier_name || sale.cashierName || ''), // Alias

        // Financial fields (always numbers, never strings)
        totalAmount,
        totalCost,
        profit,
        profitMargin: Number(sale.profit_margin || sale.profitMargin || 0),
        subtotal,
        taxAmount,
        discountAmount: Number(sale.discount_amount || sale.discountAmount || 0),
        amountPaid: Number(sale.amount_paid || sale.amountPaid || 0),
        paymentReceived: Number(sale.amount_paid || sale.amountPaid || sale.paymentReceived || 0),
        changeAmount: Number(sale.change_amount || sale.changeAmount || 0),

        // Metadata
        saleDate: String(sale.sale_date || sale.saleDate || ''),
        createdAt: String(sale.created_at || sale.createdAt || ''),
        paymentMethod: String(sale.payment_method || sale.paymentMethod || '') as
          | 'CASH'
          | 'CARD'
          | 'MOBILE_MONEY'
          | 'CREDIT',
        status: String(sale.status || 'COMPLETED') as 'COMPLETED' | 'PENDING' | 'CANCELLED' | 'VOID' | 'REFUNDED' | 'PARTIALLY_RETURNED' | 'VOIDED_BY_RETURN',
        notes: sale.notes ? String(sale.notes) : undefined,
      };
    });
  }, [sales]);

  // Calculate KPIs
  const kpis = useMemo(() => {
    if (!summary || typeof summary !== 'object') {
      return {
        totalSales: 0,
        totalProfit: 0,
        totalDiscounts: 0,
        salesCount: 0,
        avgSale: 0,
        profitMargin: 0,
        paymentMethods: [] as NormalizedPaymentMethod[],
        creditSalesCount: 0,
        partialPaymentCount: 0,
      };
    }

    const summaryObj = summary as SalesSummary;
    const totalSales = Number(summaryObj.totalAmount || summaryObj.total_amount || 0);
    const totalProfit = Number(summaryObj.totalProfit || summaryObj.total_profit || 0);
    const totalDiscounts = Number(summaryObj.totalDiscounts || summaryObj.total_discounts || 0);
    const salesCount = Number(summaryObj.totalSales || summaryObj.total_sales || 0);
    const avgSale = salesCount > 0 ? new Decimal(totalSales).dividedBy(salesCount).toNumber() : 0;
    const profitMargin =
      totalSales > 0 ? new Decimal(totalProfit).dividedBy(totalSales).times(100).toNumber() : 0;

    // Normalize payment methods data
    const paymentMethodsRaw = summaryObj.byPaymentMethod || summaryObj.by_payment_method || [];
    const paymentMethods: NormalizedPaymentMethod[] = Array.isArray(paymentMethodsRaw)
      ? paymentMethodsRaw.map((pm) => ({
        paymentMethod: String(pm.payment_method || pm.paymentMethod || ''),
        count: Number(pm.count || 0),
        totalAmount: Number(pm.total_amount || pm.totalAmount || 0),
      }))
      : [];

    // Credit sales count from server-side summary (not limited by pagination)
    const creditSalesCount = Number(summaryObj.creditSalesCount || summaryObj.credit_sales_count || 0);
    const partialPaymentCount = Number(summaryObj.partialPaymentCount || summaryObj.partial_payment_count || 0);

    return {
      totalSales,
      totalProfit,
      totalDiscounts,
      salesCount,
      avgSale,
      profitMargin,
      paymentMethods,
      creditSalesCount,
      partialPaymentCount,
    };
  }, [summary]);

  // Client-side filter for grouped overview tabs (all-sales uses server-side filters)
  const filteredSales = useMemo(() => {
    return normalizedSales.filter((sale) => {
      const matchesPayment =
        paymentMethodFilter === 'ALL' || sale.paymentMethod === paymentMethodFilter;
      const matchesStatus = statusFilter === 'ALL' || sale.status === statusFilter;
      const matchesSearch =
        !searchQuery ||
        sale.saleNumber?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        sale.customerName?.toLowerCase().includes(searchQuery.toLowerCase());

      return matchesPayment && matchesStatus && matchesSearch;
    });
  }, [normalizedSales, paymentMethodFilter, statusFilter, searchQuery]);

  // Group sales by customer
  const salesByCustomer = useMemo(() => {
    const grouped = new Map<string, CustomerGroup>();

    filteredSales
      .filter((sale) => !VOID_STATUSES.includes(sale.status))
      .forEach((sale) => {
        const customerId = sale.customerId || 'WALK-IN';
        const customerName = sale.customerName || 'Walk-in Customer';

        if (!grouped.has(customerId)) {
          grouped.set(customerId, {
            customerId,
            customerName,
            salesCount: 0,
            totalAmount: new Decimal(0),
            totalProfit: new Decimal(0),
            sales: [],
          });
        }

        const customer = grouped.get(customerId)!;
        customer.salesCount++;
        customer.totalAmount = customer.totalAmount.plus(sale.totalAmount || 0);
        customer.totalProfit = customer.totalProfit.plus(sale.profit || 0);
        customer.sales.push(sale);
      });

    return Array.from(grouped.values()).sort(
      (a, b) => b.totalAmount.toNumber() - a.totalAmount.toNumber()
    );
  }, [filteredSales]);

  // Group sales by user — use SERVER-SIDE aggregation for accurate totals
  // (client-side grouping from paginated data gives wrong totals)
  const salesByUser = useMemo(() => {
    const serverRows = Array.isArray(cashierData) ? cashierData : [];

    // Build a map of paginated sales by cashier for the expandable detail view
    const salesByCashierId = new Map<string, SaleRow[]>();
    filteredSales.forEach((sale) => {
      const uid = sale.cashierId || sale.soldById || 'UNKNOWN';
      if (!salesByCashierId.has(uid)) salesByCashierId.set(uid, []);
      salesByCashierId.get(uid)!.push(sale);
    });

    if (serverRows.length > 0) {
      // Use server-side totals (accurate across all pages)
      return serverRows.map((row: Record<string, unknown>) => ({
        userId: String(row.user_id || ''),
        userName: String(row.cashier_name || 'Unknown User'),
        salesCount: Number(row.total_transactions || 0),
        totalAmount: new Decimal(Number(row.total_revenue || 0)),
        totalProfit: new Decimal(Number(row.total_profit || 0)),
        sales: salesByCashierId.get(String(row.user_id || '')) || [],
      })).sort((a: UserGroup, b: UserGroup) => b.salesCount - a.salesCount);
    }

    // Fallback: client-side grouping if server data not yet loaded
    const grouped = new Map<string, UserGroup>();
    filteredSales
      .filter((sale) => !VOID_STATUSES.includes(sale.status))
      .forEach((sale) => {
        const userId = sale.cashierId || sale.soldById || 'UNKNOWN';
        const userName = sale.cashierName || sale.soldByName || 'Unknown User';

        if (!grouped.has(userId)) {
          grouped.set(userId, {
            userId,
            userName,
            salesCount: 0,
            totalAmount: new Decimal(0),
            totalProfit: new Decimal(0),
            sales: [],
          });
        }

        const user = grouped.get(userId)!;
        user.salesCount++;
        user.totalAmount = user.totalAmount.plus(sale.totalAmount || 0);
        user.totalProfit = user.totalProfit.plus(sale.profit || 0);
        user.sales.push(sale);
      });

    return Array.from(grouped.values()).sort((a, b) => b.salesCount - a.salesCount);
  }, [filteredSales, cashierData]);

  // Fetch orders and group by creator (for "Ordered By" tab)
  const [orderGroups, setOrderGroups] = useState<OrderGroup[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setOrdersLoading(true);
    api.orders.list({ page: 1, limit: 1000, startDate, endDate })
      .then((resp) => {
        if (cancelled) return;
        const rows = (resp.data?.data ?? []) as Record<string, unknown>[];
        const grouped = new Map<string, OrderGroup>();
        rows.forEach((o) => {
          const uid = String(o.createdBy || '');
          const uname = String(o.createdByName || 'Unknown');
          if (!grouped.has(uid)) {
            grouped.set(uid, {
              userId: uid,
              userName: uname,
              orderCount: 0,
              pendingCount: 0,
              completedCount: 0,
              cancelledCount: 0,
              totalValue: new Decimal(0),
            });
          }
          const g = grouped.get(uid)!;
          g.orderCount++;
          const st = String(o.status || '');
          if (st === 'PENDING') g.pendingCount++;
          else if (st === 'COMPLETED') g.completedCount++;
          else if (st === 'CANCELLED') g.cancelledCount++;
          g.totalValue = g.totalValue.plus(Number(o.totalAmount || 0));
        });
        setOrderGroups(Array.from(grouped.values()).sort((a, b) => b.orderCount - a.orderCount));
      })
      .catch(() => { if (!cancelled) setOrderGroups([]); })
      .finally(() => { if (!cancelled) setOrdersLoading(false); });
    return () => { cancelled = true; };
  }, [startDate, endDate]);

  const tabs = [
    { id: 'overview' as TabType, label: 'Overview', icon: '📊', adminOnly: true },
    {
      id: 'all-sales' as TabType,
      label: isScopedSalesUser ? 'My Sales' : 'All Sales',
      icon: '📝',
      adminOnly: false,
    },
    { id: 'by-customer' as TabType, label: 'By Customer', icon: '👥', adminOnly: true },
    { id: 'by-user' as TabType, label: 'By Cashier', icon: '🧑‍💼', adminOnly: true },
    { id: 'ordered-by' as TabType, label: 'Ordered By', icon: '📋', adminOnly: true },
    { id: 'invoices' as TabType, label: 'Credit Sales', icon: '📄', adminOnly: false },
    { id: 'payments' as TabType, label: 'Partial Payments', icon: '💰', adminOnly: false },
  ].filter((tab) => !isScopedSalesUser || !tab.adminOnly);

  return (
    <Layout>
      <AdaptivePage
        className={ADAPTIVE_PAGE_PAD_CLASS}
        title={isScopedSalesUser ? 'My Sales' : 'Sales Analytics'}
        description={
          isScopedSalesUser
            ? 'View your sales transactions'
            : 'Sales reporting and insights'
        }
        primaryActions={
          canCreateExpense ? (
            <button
              type="button"
              onClick={() => setIsCreateExpenseOpen(true)}
              className="px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-colors flex items-center justify-center gap-2 min-h-[var(--layout-touch-target)] w-full sm:w-auto"
              data-sales-expense-cta="true"
              aria-label="Create expense"
            >
              New Expense
            </button>
          ) : undefined
        }
        toolbar={
          <div className="bg-white rounded-lg shadow p-2.5 sm:p-4" data-sales-filters="true">
            <AdaptiveToolbar
              modeOverride="compact"
              leading={
                <AdaptiveSearch
                  value={searchQuery}
                  onChange={setSearchQuery}
                  placeholder="Sale # or Customer..."
                  label="Search sales"
                  presentationOverride="compact"
                />
              }
              secondaryLabel="Period"
              secondary={({ close }) => (
                <div className="space-y-3 w-full" data-sales-period-panel="true">
                  <div className="flex flex-wrap gap-2">
                    {(
                      [
                        ['today', 'Today'],
                        ['yesterday', 'Yesterday'],
                        ['this-week', 'This Week'],
                        ['last-week', 'Last Week'],
                        ['this-month', 'This Month'],
                        ['last-month', 'Last Month'],
                        ['custom', 'Custom Range'],
                      ] as const
                    )
                      .filter(([key]) => !lockSalesToBusinessDay || key === 'today')
                      .map(([key, label]) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() => {
                          handleDateFilterChange(key);
                          if (key !== 'custom') close();
                        }}
                        disabled={lockSalesToBusinessDay && key !== 'today'}
                        className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors min-h-[var(--layout-touch-target)] ${
                          dateFilter === key
                            ? 'bg-blue-600 text-white'
                            : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  {lockSalesToBusinessDay ? (
                    <p className="text-xs text-stone-500" data-sales-day-lock="true">
                      Cashiers can view today&apos;s sales only.
                    </p>
                  ) : null}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {!lockSalesToBusinessDay ? (
                      <>
                    <div>
                      <label htmlFor="startDate" className="block text-sm font-medium text-gray-700 mb-1">
                        Start Date
                      </label>
                      <DatePicker
                        value={startDate}
                        onChange={(date) => {
                          setStartDate(date);
                          setDateFilter('custom');
                        }}
                        placeholder="Select start date"
                        maxDate={endDate ? new Date(endDate) : undefined}
                      />
                    </div>
                    <div>
                      <label htmlFor="endDate" className="block text-sm font-medium text-gray-700 mb-1">
                        End Date
                      </label>
                      <DatePicker
                        value={endDate}
                        onChange={(date) => {
                          setEndDate(date);
                          setDateFilter('custom');
                        }}
                        placeholder="Select end date"
                        minDate={startDate ? new Date(startDate) : undefined}
                      />
                    </div>
                      </>
                    ) : null}
                    <div>
                      <label
                        htmlFor="paymentMethod"
                        className="block text-sm font-medium text-gray-700 mb-1"
                      >
                        Payment Method
                      </label>
                      <select
                        id="paymentMethod"
                        value={paymentMethodFilter}
                        onChange={(e) => {
                          setPaymentMethodFilter(e.target.value);
                          close();
                        }}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent min-h-[var(--layout-touch-target)]"
                      >
                        <option value="ALL">All Methods</option>
                        <option value="CASH">Cash</option>
                        <option value="CARD">Card</option>
                        <option value="MOBILE_MONEY">MTN Mobile Money</option>
                        <option value="AIRTEL_MONEY">Airtel Money</option>
                        <option value="CREDIT">Credit</option>
                      </select>
                    </div>
                    <div>
                      <label
                        htmlFor="statusFilter"
                        className="block text-sm font-medium text-gray-700 mb-1"
                      >
                        Status
                      </label>
                      <select
                        id="statusFilter"
                        value={statusFilter}
                        onChange={(e) => {
                          setStatusFilter(e.target.value);
                          close();
                        }}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent min-h-[var(--layout-touch-target)]"
                      >
                        <option value="ALL">All Status</option>
                        <option value="COMPLETED">Completed</option>
                        <option value="PENDING">Pending</option>
                        <option value="CANCELLED">Cancelled</option>
                        <option value="VOID">Voided</option>
                        <option value="REFUNDED">Refunded</option>
                      </select>
                    </div>
                  </div>
                  {dateFilter === 'custom' ? (
                    <button
                      type="button"
                      onClick={() => close()}
                      className="w-full rounded-md bg-stone-900 px-3 py-2 text-sm font-medium text-white min-h-[var(--layout-touch-target)]"
                      data-sales-period-done="true"
                    >
                      Done
                    </button>
                  ) : null}
                </div>
              )}
            />
          </div>
        }
      >
        {/* Filters moved into AdaptiveToolbar — body starts with tabs / KPIs */}

        {/* KPI Cards - Overview Tab — 2-up compact on phone (SSOT) */}
        {activeTab === 'overview' && (
          <div className={KPI_ACCENT_GRID_CLASS} data-sales-kpis="true">
            <div className={kpiAccentCardClass('blue')}>
              <div className={KPI_ACCENT_LABEL_CLASS}>Total Sales</div>
              <div className={KPI_ACCENT_VALUE_CLASS}>{formatCurrency(kpis.totalSales)}</div>
              <div className={KPI_ACCENT_SUB_CLASS}>{kpis.salesCount} transactions</div>
            </div>
            <div className={kpiAccentCardClass('green')}>
              <div className={KPI_ACCENT_LABEL_CLASS}>Total Profit</div>
              <div className={KPI_ACCENT_VALUE_CLASS}>{formatCurrency(kpis.totalProfit)}</div>
              <div className={KPI_ACCENT_SUB_CLASS}>{kpis.profitMargin.toFixed(2)}% margin</div>
            </div>
            <div className={kpiAccentCardClass('purple')}>
              <div className={KPI_ACCENT_LABEL_CLASS}>Average Sale</div>
              <div className={KPI_ACCENT_VALUE_CLASS}>{formatCurrency(kpis.avgSale)}</div>
              <div className={KPI_ACCENT_SUB_CLASS}>Per transaction</div>
            </div>
            <div className={kpiAccentCardClass('orange')}>
              <div className={KPI_ACCENT_LABEL_CLASS}>Credit Sales</div>
              <div className={KPI_ACCENT_VALUE_CLASS}>{kpis.creditSalesCount}</div>
              <div className={KPI_ACCENT_SUB_CLASS}>{kpis.partialPaymentCount} partial</div>
            </div>
            <div className={kpiAccentCardClass('pink')}>
              <div className={KPI_ACCENT_LABEL_CLASS}>Total Discounts</div>
              <div className={KPI_ACCENT_VALUE_CLASS}>{formatCurrency(kpis.totalDiscounts)}</div>
              <div className={KPI_ACCENT_SUB_CLASS}>
                {kpis.totalSales > 0
                  ? `${new Decimal(kpis.totalDiscounts).dividedBy(new Decimal(kpis.totalSales).plus(kpis.totalDiscounts)).times(100).toDecimalPlaces(1).toNumber()}% of gross`
                  : 'No sales'}
              </div>
            </div>
          </div>
        )}

        {/* Tabs */}
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <div className="border-b border-gray-200">
            <div className="flex overflow-x-auto">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center gap-1.5 sm:gap-2 px-3 sm:px-6 py-3 sm:py-4 font-medium text-sm transition-colors whitespace-nowrap ${activeTab === tab.id
                    ? 'border-b-2 border-blue-600 text-blue-600 bg-blue-50'
                    : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50'
                    }`}
                >
                  <span>{tab.icon}</span>
                  <span>{tab.label}</span>
                  {tab.id === 'invoices' && kpis.creditSalesCount > 0 && (
                    <span className="ml-2 px-2 py-0.5 text-xs font-semibold rounded-full bg-orange-100 text-orange-800">
                      {kpis.creditSalesCount}
                    </span>
                  )}
                  {tab.id === 'payments' && kpis.partialPaymentCount > 0 && (
                    <span className="ml-2 px-2 py-0.5 text-xs font-semibold rounded-full bg-yellow-100 text-yellow-800">
                      {kpis.partialPaymentCount}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>

          <div className="p-6">
            {salesLoading || summaryLoading ? (
              <div className="text-center py-12">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
                <p className="text-gray-600 mt-4">Loading sales data...</p>
              </div>
            ) : (
              <>
                {/* Overview Tab Content */}
                {activeTab === 'overview' && (
                  <div className="space-y-6">
                    {/* Payment Methods Breakdown */}
                    <div>
                      <h3 className="text-lg font-semibold text-gray-900 mb-4">
                        Payment Methods Breakdown
                      </h3>
                      {kpis.paymentMethods.length > 0 ? (
                        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                          {kpis.paymentMethods.map((pm) => (
                            <div key={pm.paymentMethod} className="bg-gray-50 rounded-lg p-4">
                              <div className="flex items-center justify-between mb-2">
                                <span className="text-sm font-medium text-gray-700">
                                  {pm.paymentMethod}
                                </span>
                                <span className="text-xs px-2 py-1 bg-blue-100 text-blue-800 rounded-full">
                                  {pm.count} sales
                                </span>
                              </div>
                              <div className="text-2xl font-bold text-gray-900">
                                {formatCurrency(pm.totalAmount)}
                              </div>
                              <div className="text-sm text-gray-600 mt-1">
                                Avg:{' '}
                                {formatCurrency(
                                  pm.count > 0
                                    ? new Decimal(pm.totalAmount).dividedBy(pm.count).toNumber()
                                    : 0
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="bg-gray-50 rounded-lg p-8 text-center text-gray-500">
                          No sales data available for the selected date range
                        </div>
                      )}
                    </div>

                    {/* Daily Trend */}
                    {dailyTrend.length > 0 && (
                      <div>
                        <h3 className="text-lg font-semibold text-gray-900 mb-4">
                          Daily Sales Trend
                        </h3>
                        <div className="bg-gray-50 rounded-lg p-4 overflow-x-auto">
                          <table className="min-w-full">
                            <thead>
                              <tr className="text-left text-sm text-gray-600">
                                <th className="pb-2">Date</th>
                                <th className="pb-2 text-right">Sales</th>
                                <th className="pb-2 text-right">Amount</th>
                                <th className="pb-2 text-right">Profit</th>
                                <th className="pb-2 text-right">Margin</th>
                              </tr>
                            </thead>
                            <tbody className="text-sm">
                              {dailyTrend.slice(0, 10).map((day, idx) => (
                                <tr key={idx} className="border-t border-gray-200">
                                  <td className="py-2">{day.period}</td>
                                  <td className="py-2 text-right">{day.count}</td>
                                  <td className="py-2 text-right font-medium">
                                    {formatCurrency(day.totalAmount)}
                                  </td>
                                  <td className="py-2 text-right text-green-600">
                                    {formatCurrency(day.totalProfit)}
                                  </td>
                                  <td className="py-2 text-right">
                                    {day.totalAmount > 0
                                      ? new Decimal(day.totalProfit)
                                        .dividedBy(day.totalAmount)
                                        .times(100)
                                        .toFixed(1)
                                      : '0.0'}
                                    %
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* All Sales Tab */}
                {activeTab === 'all-sales' && (
                  <>
                    {(pagination?.total ?? normalizedSales.length) > 0 ? (
                      <SalesTable
                        sales={normalizedSales}
                        onSelectSale={setSelectedSale}
                        pagination={pagination}
                        currentPage={currentPage}
                        onPageChange={setCurrentPage}
                        sortField={salesSortField}
                        sortOrder={salesSortOrder}
                        onColumnSort={handleSalesColumnSort}
                        onToggleSortOrder={() =>
                          setSalesSortOrder((o) => (o === 'asc' ? 'desc' : 'asc'))
                        }
                      />
                    ) : (
                      <div className="text-center py-12">
                        <p className="text-gray-500 text-lg">
                          No sales found for the selected period
                        </p>
                        <p className="text-gray-400 text-sm mt-2">
                          Try adjusting your date range or filters
                        </p>
                      </div>
                    )}
                  </>
                )}

                {/* By Customer Tab */}
                {activeTab === 'by-customer' && (
                  <>
                    {salesByCustomer.length > 0 ? (
                      <CustomerSalesView
                        customers={salesByCustomer}
                        onSelectSale={setSelectedSale}
                      />
                    ) : (
                      <div className="text-center py-12">
                        <p className="text-gray-500 text-lg">No customer sales found</p>
                        <p className="text-gray-400 text-sm mt-2">
                          Sales will appear here once transactions are recorded
                        </p>
                      </div>
                    )}
                  </>
                )}

                {/* By User Tab */}
                {activeTab === 'by-user' && (
                  <>
                    {salesByUser.length > 0 ? (
                      <UserSalesView users={salesByUser} onSelectSale={setSelectedSale} startDate={startDate} endDate={endDate} />
                    ) : (
                      <div className="text-center py-12">
                        <p className="text-gray-500 text-lg">No cashier sales found</p>
                        <p className="text-gray-400 text-sm mt-2">
                          Sales by cashier will appear here
                        </p>
                      </div>
                    )}
                  </>
                )}

                {/* Ordered By Tab */}
                {activeTab === 'ordered-by' && (
                  <>
                    {ordersLoading ? (
                      <div className="text-center py-12">
                        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto mb-4" />
                        <p className="text-gray-500">Loading orders...</p>
                      </div>
                    ) : orderGroups.length > 0 ? (
                      <OrderedByView groups={orderGroups} startDate={startDate} endDate={endDate} />
                    ) : (
                      <div className="text-center py-12">
                        <p className="text-gray-500 text-lg">No orders found</p>
                        <p className="text-gray-400 text-sm mt-2">
                          Orders by user will appear here
                        </p>
                      </div>
                    )}
                  </>
                )}

                {/* Credit Sales Tab */}
                {activeTab === 'invoices' && (
                  <CreditSalesView onSelectSale={setSelectedSale} startDate={startDate} endDate={endDate} />
                )}

                {/* Partial Payments Tab */}
                {activeTab === 'payments' && (
                  <PartialPaymentsView onSelectSale={setSelectedSale} startDate={startDate} endDate={endDate} />
                )}
              </>
            )}
          </div>
        </div>

        {/* Sale Detail Modal */}
        {selectedSale && (
          <SaleDetailModal
            sale={selectedSale}
            onClose={() => setSelectedSale(null)}
            onSaleUpdated={() => { refetchSales(); }}
          />
        )}

        {/* Expense create — ops path: expenses.create only (no Accounting feature) */}
        <Dialog open={isCreateExpenseOpen} onOpenChange={setIsCreateExpenseOpen}>
          <DialogContent className="max-w-5xl max-h-[95vh] overflow-hidden flex flex-col">
            <div data-sales-expense-dialog="true" className="contents">
            <DialogHeader className="flex-shrink-0">
              <DialogTitle className="text-xl sm:text-2xl">Create New Expense</DialogTitle>
              <DialogDescription>
                Record an operating expense (transport, supplies, allowances). Accounting menu access is not required.
              </DialogDescription>
            </DialogHeader>
            <div className="overflow-y-auto flex-1 -mx-6 px-6" data-sales-expense-form="true">
              <CreateExpenseForm
                onSuccess={() => setIsCreateExpenseOpen(false)}
                onCancel={() => setIsCreateExpenseOpen(false)}
              />
            </div>
            </div>
          </DialogContent>
        </Dialog>
      </AdaptivePage>
    </Layout>
  );
}

// Sales Table Component
function SalesTable({
  sales,
  onSelectSale,
  pagination,
  currentPage,
  onPageChange,
  sortField,
  sortOrder,
  onColumnSort,
  onToggleSortOrder,
}: SalesTableProps) {
  const hasDiscounts = sales.some((s) => s.discountAmount > 0);

  const mobileSortOptions = [
    { value: 'saleNumber', label: 'Sort by Sale #' },
    { value: 'date', label: 'Sort by Date' },
    { value: 'customer', label: 'Sort by Customer' },
    { value: 'amount', label: 'Sort by Amount' },
    { value: 'profit', label: 'Sort by Profit' },
    { value: 'payment', label: 'Sort by Payment' },
    { value: 'status', label: 'Sort by Status' },
  ];

  return (
    <div className="space-y-4">
      <MobileSortSelect
        sortField={sortField}
        sortOrder={sortOrder}
        options={mobileSortOptions}
        onFieldChange={onColumnSort}
        onToggleOrder={onToggleSortOrder}
        className="px-2"
      />
      {/* Mobile Card View */}
      <div className="block sm:hidden space-y-3 px-2">
        {sales.map((sale: SaleRow) => (
          <div
            key={sale.id}
            className="bg-white border border-gray-200 rounded-lg p-4 shadow-sm active:bg-gray-50"
            onClick={() => onSelectSale(sale)}
          >
            <div className="flex justify-between items-start mb-2">
              <div>
                <div className="text-sm font-semibold text-blue-600">{sale.saleNumber || sale.id.slice(0, 8)}</div>
                <div className="text-xs text-gray-500">{formatSaleDateTime(sale)}</div>
              </div>
              <div className="flex gap-1">
                <span className={`px-2 py-0.5 text-xs font-semibold rounded-full ${sale.paymentMethod === 'CASH' ? 'bg-green-100 text-green-800' : sale.paymentMethod === 'CARD' ? 'bg-blue-100 text-blue-800' : sale.paymentMethod === 'CREDIT' ? 'bg-orange-100 text-orange-800' : 'bg-gray-100 text-gray-800'}`}>
                  {sale.paymentMethod}
                </span>
                <span className={`px-2 py-0.5 text-xs font-semibold rounded-full ${sale.status === 'COMPLETED' ? 'bg-green-100 text-green-800' : sale.status === 'PENDING' ? 'bg-yellow-100 text-yellow-800' : sale.status === 'VOID' ? 'bg-gray-100 text-gray-800' : sale.status === 'REFUNDED' ? 'bg-amber-100 text-amber-800' : sale.status === 'PARTIALLY_RETURNED' ? 'bg-orange-100 text-orange-800' : sale.status === 'VOIDED_BY_RETURN' ? 'bg-purple-100 text-purple-800' : 'bg-red-100 text-red-800'}`}>
                  {sale.status === 'VOIDED_BY_RETURN' ? 'RETURNED' : sale.status === 'PARTIALLY_RETURNED' ? 'PARTIAL RETURN' : sale.status}
                </span>
              </div>
            </div>
            <div className="flex justify-between items-center">
              <div className="text-sm text-gray-700">{sale.customerName || 'Walk-in'}</div>
              <div className="text-right">
                <div className="text-base font-bold text-gray-900">{formatCurrency(sale.totalAmount)}</div>
                <div className="text-xs text-green-600">Profit: {formatCurrency(sale.profit || 0)}</div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Desktop Table View */}
      <div className="hidden sm:block overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <SortableTableHeader label="Sale #" field="saleNumber" activeField={sortField} direction={sortOrder} onSort={onColumnSort} />
              <SortableTableHeader label="Date & Time" field="date" activeField={sortField} direction={sortOrder} onSort={onColumnSort} />
              <SortableTableHeader label="Customer" field="customer" activeField={sortField} direction={sortOrder} onSort={onColumnSort} />
              <SortableTableHeader label="Amount" field="amount" activeField={sortField} direction={sortOrder} onSort={onColumnSort} align="right" />
              {hasDiscounts && (
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">
                  Discount
                </th>
              )}
              <SortableTableHeader label="Profit (Margin)" field="profit" activeField={sortField} direction={sortOrder} onSort={onColumnSort} align="right" />
              <SortableTableHeader label="Payment" field="payment" activeField={sortField} direction={sortOrder} onSort={onColumnSort} />
              <SortableTableHeader label="Status" field="status" activeField={sortField} direction={sortOrder} onSort={onColumnSort} />
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {sales.map((sale: SaleRow) => (
              <tr
                key={sale.id}
                className="hover:bg-gray-50 cursor-pointer"
                onClick={() => onSelectSale(sale)}
              >
                <td className="px-4 py-3 text-sm font-medium text-blue-600">
                  {sale.saleNumber || sale.id.slice(0, 8)}
                </td>
                <td className="px-4 py-3 text-sm text-gray-900 whitespace-nowrap">
                  {formatSaleDateTime(sale)}
                </td>
                <td className="px-4 py-3 text-sm text-gray-900">
                  {sale.customerName || 'Walk-in'}
                </td>
                <td className="px-4 py-3 text-sm text-right font-medium text-gray-900">
                  {formatCurrency(sale.totalAmount)}
                </td>
                {hasDiscounts && (
                  <td className="px-4 py-3 text-sm text-right font-medium text-red-600">
                    {sale.discountAmount > 0 ? `-${formatCurrency(sale.discountAmount)}` : '-'}
                  </td>
                )}
                <td className="px-4 py-3 text-sm text-right font-medium text-green-600">
                  <div>{formatCurrency(sale.profit || 0)}</div>
                  {sale.profitMargin > 0 && <div className="text-xs text-gray-500">({(sale.profitMargin * 100).toFixed(1)}%)</div>}
                </td>
                <td className="px-4 py-3 text-sm">
                  <span
                    className={`px-2 py-1 text-xs font-semibold rounded-full ${sale.paymentMethod === 'CASH'
                      ? 'bg-green-100 text-green-800'
                      : sale.paymentMethod === 'CARD'
                        ? 'bg-blue-100 text-blue-800'
                        : sale.paymentMethod === 'CREDIT'
                          ? 'bg-orange-100 text-orange-800'
                          : 'bg-gray-100 text-gray-800'
                      }`}
                  >
                    {sale.paymentMethod}
                  </span>
                </td>
                <td className="px-4 py-3 text-sm">
                  <span
                    className={`px-2 py-1 text-xs font-semibold rounded-full ${sale.status === 'COMPLETED'
                      ? 'bg-green-100 text-green-800'
                      : sale.status === 'PENDING'
                        ? 'bg-yellow-100 text-yellow-800'
                        : sale.status === 'VOID'
                          ? 'bg-gray-100 text-gray-800'
                          : sale.status === 'REFUNDED'
                            ? 'bg-amber-100 text-amber-800'
                            : sale.status === 'PARTIALLY_RETURNED'
                              ? 'bg-orange-100 text-orange-800'
                              : sale.status === 'VOIDED_BY_RETURN'
                                ? 'bg-purple-100 text-purple-800'
                                : 'bg-red-100 text-red-800'
                      }`}
                  >
                    {sale.status === 'VOIDED_BY_RETURN' ? 'RETURNED' : sale.status === 'PARTIALLY_RETURNED' ? 'PARTIAL RETURN' : sale.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-sm text-right">
                  <button className="text-blue-600 hover:text-blue-800 font-medium">View</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {pagination && (
        <div className="flex justify-between items-center mt-4">
          <div className="text-sm text-gray-600">
            Showing {(currentPage - 1) * pagination.limit + 1} to{' '}
            {Math.min(currentPage * pagination.limit, pagination.total)} of {pagination.total} sales
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => onPageChange(currentPage - 1)}
              disabled={currentPage === 1}
              className="px-3 py-1 border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Previous
            </button>
            <span className="px-3 py-1 border border-blue-600 bg-blue-50 text-blue-600 rounded font-medium">
              {currentPage}
            </span>
            <button
              onClick={() => onPageChange(currentPage + 1)}
              disabled={currentPage >= pagination.totalPages}
              className="px-3 py-1 border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Customer Sales View Component
function CustomerSalesView({ customers, onSelectSale }: CustomerSalesViewProps) {
  const [expandedCustomer, setExpandedCustomer] = useState<string | null>(null);
  const { sortField, sortOrder, handleSort } = useColumnSort<NestedSaleSortField>('date', 'desc');

  const nestedSaleSortAccessors = useMemo(
    () => ({
      saleNumber: (s: SaleRow) => s.saleNumber || '',
      date: (s: SaleRow) => saleSortDate(s),
      customer: (s: SaleRow) => s.customerName || 'Walk-in',
      amount: (s: SaleRow) => s.totalAmount,
      payment: (s: SaleRow) => s.paymentMethod,
    }),
    [],
  );

  const handleColumnSort = (field: string) => {
    handleSort(field as NestedSaleSortField);
  };

  const sortCustomerSales = useCallback(
    (rows: SaleRow[]) => applyTableSort(rows, sortField, sortOrder, nestedSaleSortAccessors),
    [sortField, sortOrder, nestedSaleSortAccessors],
  );

  return (
    <div className="space-y-4">
      <div className="text-sm text-gray-600 mb-4">
        Showing sales for {customers.length} customers
      </div>

      {customers.map((customer: CustomerGroup) => (
        <div
          key={customer.customerId}
          className="border border-gray-200 rounded-lg overflow-hidden"
        >
          <button
            onClick={() =>
              setExpandedCustomer(
                expandedCustomer === customer.customerId ? null : customer.customerId
              )
            }
            className="w-full bg-gray-50 hover:bg-gray-100 p-4 flex items-center justify-between transition-colors"
          >
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 bg-blue-600 text-white rounded-full flex items-center justify-center font-bold text-lg">
                {customer.customerName.charAt(0).toUpperCase()}
              </div>
              <div className="text-left">
                <div className="font-semibold text-gray-900">{customer.customerName}</div>
                <div className="text-sm text-gray-600">{customer.salesCount} sales</div>
              </div>
            </div>
            <div className="text-right">
              <div className="text-xl font-bold text-gray-900">
                {formatCurrency(customer.totalAmount.toNumber())}
              </div>
              <div className="text-sm text-green-600">
                Profit: {formatCurrency(customer.totalProfit.toNumber())}
              </div>
            </div>
          </button>

          {expandedCustomer === customer.customerId && (
            <div className="p-4 bg-white border-t border-gray-200">
              <table className="min-w-full">
                <thead className="text-xs text-gray-500 uppercase">
                  <tr>
                    <SortableTableHeader label="Sale #" field="saleNumber" activeField={sortField} direction={sortOrder} onSort={handleColumnSort} className="px-0 py-2" />
                    <SortableTableHeader label="Date & Time" field="date" activeField={sortField} direction={sortOrder} onSort={handleColumnSort} className="px-0 py-2" />
                    <SortableTableHeader label="Amount" field="amount" activeField={sortField} direction={sortOrder} onSort={handleColumnSort} align="right" className="px-0 py-2" />
                    <SortableTableHeader label="Payment" field="payment" activeField={sortField} direction={sortOrder} onSort={handleColumnSort} className="px-0 py-2" />
                    <th className="text-right pb-2 px-0 py-2 text-xs font-medium uppercase tracking-wider text-gray-500">Actions</th>
                  </tr>
                </thead>
                <tbody className="text-sm">
                  {sortCustomerSales(customer.sales).map((sale: SaleRow) => (
                    <tr key={sale.id} className="border-t border-gray-100">
                      <td className="py-2 font-medium text-blue-600">{sale.saleNumber}</td>
                      <td className="py-2 whitespace-nowrap">{formatSaleDateTime(sale)}</td>
                      <td className="py-2 text-right font-medium">
                        {formatCurrency(sale.totalAmount)}
                      </td>
                      <td className="py-2">
                        <span className="px-2 py-1 text-xs font-semibold rounded-full bg-gray-100 text-gray-800">
                          {sale.paymentMethod}
                        </span>
                      </td>
                      <td className="py-2 text-right">
                        <button
                          onClick={() => onSelectSale(sale)}
                          className="text-blue-600 hover:text-blue-800 font-medium"
                        >
                          View
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// User Sales View Component
function UserSalesView({ users, onSelectSale, startDate, endDate }: UserSalesViewProps) {
  const [expandedUser, setExpandedUser] = useState<string | null>(null);
  const [expandedSales, setExpandedSales] = useState<SaleRow[]>([]);
  const [loadingSales, setLoadingSales] = useState(false);
  const { sortField, sortOrder, handleSort } = useColumnSort<NestedSaleSortField>('date', 'desc');

  const nestedSaleSortAccessors = useMemo(
    () => ({
      saleNumber: (s: SaleRow) => s.saleNumber || '',
      date: (s: SaleRow) => saleSortDate(s),
      customer: (s: SaleRow) => s.customerName || 'Walk-in',
      amount: (s: SaleRow) => s.totalAmount,
      payment: (s: SaleRow) => s.paymentMethod,
    }),
    [],
  );

  const handleColumnSort = (field: string) => {
    handleSort(field as NestedSaleSortField);
  };

  const sortedExpandedSales = useMemo(
    () => applyTableSort(expandedSales, sortField, sortOrder, nestedSaleSortAccessors),
    [expandedSales, sortField, sortOrder, nestedSaleSortAccessors],
  );

  // Fetch sales for the expanded cashier on-demand
  useEffect(() => {
    if (!expandedUser) {
      setExpandedSales([]);
      return;
    }
    let cancelled = false;
    setLoadingSales(true);
    api.sales.list({ page: 1, limit: 200, cashierId: expandedUser, startDate, endDate })
      .then((resp) => {
        if (cancelled) return;
        const rows = (resp.data?.data ?? []) as Record<string, unknown>[];
        setExpandedSales(rows.map((sale) => ({
          id: String(sale.id || ''),
          saleNumber: String(sale.sale_number || sale.saleNumber || ''),
          saleDate: String(sale.sale_date || sale.saleDate || ''),
          createdAt: String(sale.created_at || sale.createdAt || ''),
          totalAmount: Number(sale.total_amount || sale.totalAmount || 0),
          profit: Number(sale.profit || 0),
          customerName: String(sale.customer_name || sale.customerName || ''),
          paymentMethod: String(sale.payment_method || sale.paymentMethod || ''),
          status: String(sale.status || ''),
          cashierId: String(sale.cashier_id || sale.cashierId || ''),
          cashierName: String(sale.cashier_name || sale.cashierName || ''),
          soldById: String(sale.cashier_id || sale.cashierId || ''),
          soldByName: String(sale.cashier_name || sale.cashierName || ''),
        } as SaleRow)));
      })
      .catch(() => { if (!cancelled) setExpandedSales([]); })
      .finally(() => { if (!cancelled) setLoadingSales(false); });
    return () => { cancelled = true; };
  }, [expandedUser, startDate, endDate]);

  return (
    <div className="space-y-4">
      <div className="text-sm text-gray-600 mb-4">Performance for {users.length} cashiers</div>

      {users.map((user: UserGroup) => (
        <div key={user.userId} className="border border-gray-200 rounded-lg overflow-hidden">
          <button
            onClick={() => setExpandedUser(expandedUser === user.userId ? null : user.userId)}
            className="w-full bg-gray-50 hover:bg-gray-100 p-4 flex items-center justify-between transition-colors"
          >
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 bg-purple-600 text-white rounded-full flex items-center justify-center font-bold text-lg">
                {user.userName.charAt(0).toUpperCase()}
              </div>
              <div className="text-left">
                <div className="font-semibold text-gray-900">{user.userName}</div>
                <div className="text-sm text-gray-600">{user.salesCount} sales</div>
              </div>
            </div>
            <div className="text-right">
              <div className="text-xl font-bold text-gray-900">
                {formatCurrency(user.totalAmount.toNumber())}
              </div>
              <div className="text-sm text-green-600">
                Profit: {formatCurrency(user.totalProfit.toNumber())}
              </div>
            </div>
          </button>

          {expandedUser === user.userId && (
            <div className="p-4 bg-white border-t border-gray-200">
              {loadingSales ? (
                <div className="text-center py-4 text-gray-500">Loading sales...</div>
              ) : expandedSales.length === 0 ? (
                <div className="text-center py-4 text-gray-400">No sales found</div>
              ) : (
                <table className="min-w-full">
                  <thead className="text-xs text-gray-500 uppercase">
                    <tr>
                      <SortableTableHeader label="Sale #" field="saleNumber" activeField={sortField} direction={sortOrder} onSort={handleColumnSort} className="px-0 py-2" />
                      <SortableTableHeader label="Customer" field="customer" activeField={sortField} direction={sortOrder} onSort={handleColumnSort} className="px-0 py-2" />
                      <SortableTableHeader label="Date & Time" field="date" activeField={sortField} direction={sortOrder} onSort={handleColumnSort} className="px-0 py-2" />
                      <SortableTableHeader label="Amount" field="amount" activeField={sortField} direction={sortOrder} onSort={handleColumnSort} align="right" className="px-0 py-2" />
                      <th className="text-right pb-2 px-0 py-2 text-xs font-medium uppercase tracking-wider text-gray-500">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="text-sm">
                    {sortedExpandedSales.map((sale: SaleRow) => (
                      <tr key={sale.id} className="border-t border-gray-100">
                        <td className="py-2 font-medium text-blue-600">{sale.saleNumber}</td>
                        <td className="py-2">{sale.customerName || 'Walk-in'}</td>
                        <td className="py-2 whitespace-nowrap">{formatSaleDateTime(sale)}</td>
                        <td className="py-2 text-right font-medium">
                          {formatCurrency(sale.totalAmount)}
                        </td>
                        <td className="py-2 text-right">
                          <button
                            onClick={() => onSelectSale(sale)}
                            className="text-blue-600 hover:text-blue-800 font-medium"
                          >
                            View
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// Ordered By View Component — shows orders grouped by who created them
function OrderedByView({ groups, startDate, endDate }: OrderedByViewProps) {
  const [expandedUser, setExpandedUser] = useState<string | null>(null);
  const [expandedOrders, setExpandedOrders] = useState<Record<string, unknown>[]>([]);
  const [loadingOrders, setLoadingOrders] = useState(false);
  const { sortField, sortOrder, handleSort } = useColumnSort<OrderedBySortField>('date', 'desc');

  const orderSortAccessors = useMemo(
    () => ({
      orderNumber: (o: Record<string, unknown>) => String(o.orderNumber || ''),
      customer: (o: Record<string, unknown>) => String(o.customerName || 'Walk-in'),
      date: (o: Record<string, unknown>) =>
        String(o.orderDate || o.order_date || o.createdAt || o.created_at || ''),
      status: (o: Record<string, unknown>) => String(o.status || ''),
      amount: (o: Record<string, unknown>) => Number(o.totalAmount || 0),
    }),
    [],
  );

  const handleColumnSort = (field: string) => {
    handleSort(field as OrderedBySortField);
  };

  const sortedExpandedOrders = useMemo(
    () => applyTableSort(expandedOrders, sortField, sortOrder, orderSortAccessors),
    [expandedOrders, sortField, sortOrder, orderSortAccessors],
  );

  useEffect(() => {
    if (!expandedUser) {
      setExpandedOrders([]);
      return;
    }
    let cancelled = false;
    setLoadingOrders(true);
    api.orders.list({ page: 1, limit: 200, startDate, endDate })
      .then((resp) => {
        if (cancelled) return;
        const all = (resp.data?.data ?? []) as Record<string, unknown>[];
        setExpandedOrders(all.filter((o) => String(o.createdBy || '') === expandedUser));
      })
      .catch(() => { if (!cancelled) setExpandedOrders([]); })
      .finally(() => { if (!cancelled) setLoadingOrders(false); });
    return () => { cancelled = true; };
  }, [expandedUser, startDate, endDate]);

  const totalOrders = groups.reduce((s, g) => s + g.orderCount, 0);
  const totalValue = groups.reduce((s, g) => s.plus(g.totalValue), new Decimal(0));

  return (
    <div className="space-y-4">
      {/* Summary bar */}
      <div className="flex flex-wrap gap-4 text-sm text-gray-600 mb-4">
        <span>{groups.length} users</span>
        <span>{totalOrders} total orders</span>
        <span>Value: {formatCurrency(totalValue.toNumber())}</span>
      </div>

      {groups.map((g) => (
        <div key={g.userId} className="border border-gray-200 rounded-lg overflow-hidden">
          <button
            onClick={() => setExpandedUser(expandedUser === g.userId ? null : g.userId)}
            className="w-full bg-gray-50 hover:bg-gray-100 p-4 flex items-center justify-between transition-colors"
          >
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 bg-orange-600 text-white rounded-full flex items-center justify-center font-bold text-lg">
                {g.userName.charAt(0).toUpperCase()}
              </div>
              <div className="text-left">
                <div className="font-semibold text-gray-900">{g.userName}</div>
                <div className="text-sm text-gray-600">{g.orderCount} orders</div>
              </div>
            </div>
            <div className="flex items-center gap-6">
              <div className="text-right text-sm space-y-0.5">
                {g.completedCount > 0 && (
                  <div className="text-green-600">{g.completedCount} completed</div>
                )}
                {g.pendingCount > 0 && (
                  <div className="text-yellow-600">{g.pendingCount} pending</div>
                )}
                {g.cancelledCount > 0 && (
                  <div className="text-red-600">{g.cancelledCount} cancelled</div>
                )}
              </div>
              <div className="text-right">
                <div className="text-xl font-bold text-gray-900">
                  {formatCurrency(g.totalValue.toNumber())}
                </div>
              </div>
            </div>
          </button>

          {expandedUser === g.userId && (
            <div className="p-4 bg-white border-t border-gray-200">
              {loadingOrders ? (
                <div className="text-center py-4 text-gray-500">Loading orders...</div>
              ) : expandedOrders.length === 0 ? (
                <div className="text-center py-4 text-gray-400">No orders found</div>
              ) : (
                <table className="min-w-full">
                  <thead className="text-xs text-gray-500 uppercase">
                    <tr>
                      <SortableTableHeader label="Order #" field="orderNumber" activeField={sortField} direction={sortOrder} onSort={handleColumnSort} className="px-0 py-2" />
                      <SortableTableHeader label="Customer" field="customer" activeField={sortField} direction={sortOrder} onSort={handleColumnSort} className="px-0 py-2" />
                      <SortableTableHeader label="Date & Time" field="date" activeField={sortField} direction={sortOrder} onSort={handleColumnSort} className="px-0 py-2" />
                      <SortableTableHeader label="Status" field="status" activeField={sortField} direction={sortOrder} onSort={handleColumnSort} className="px-0 py-2" />
                      <SortableTableHeader label="Amount" field="amount" activeField={sortField} direction={sortOrder} onSort={handleColumnSort} align="right" className="px-0 py-2" />
                      <th className="text-left pb-2 px-0 py-2 text-xs font-medium uppercase tracking-wider text-gray-500">Cancel Reason</th>
                    </tr>
                  </thead>
                  <tbody className="text-sm">
                    {sortedExpandedOrders.map((o) => {
                      const st = String(o.status || '');
                      const statusColor = st === 'COMPLETED' ? 'text-green-600' : st === 'CANCELLED' ? 'text-red-600' : 'text-yellow-600';
                      const orderDate = formatDisplayDate(String(o.orderDate || o.order_date || ''));
                      const orderTime = formatDisplayTime(String(o.createdAt || o.created_at || ''));
                      return (
                        <tr key={String(o.id)} className="border-t border-gray-100">
                          <td className="py-2 font-medium text-blue-600">{String(o.orderNumber || '')}</td>
                          <td className="py-2">{String(o.customerName || 'Walk-in')}</td>
                          <td className="py-2">{orderTime !== 'N/A' ? `${orderDate} ${orderTime}` : orderDate}</td>
                          <td className={`py-2 font-medium ${statusColor}`}>{st}</td>
                          <td className="py-2 text-right font-medium">{formatCurrency(Number(o.totalAmount || 0))}</td>
                          <td className="py-2 text-gray-500 text-xs">{st === 'CANCELLED' ? String(o.cancelReason || '-') : ''}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// Credit Sales View Component
function CreditSalesView({ onSelectSale, startDate, endDate }: CreditSalesViewProps) {
  const [sales, setSales] = useState<SaleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [filterOutstandingOnly, setFilterOutstandingOnly] = useState(false);
  const { sortField, sortOrder, handleSort, setSortOrder } = useColumnSort<CreditSalesSortField>('outstanding', 'desc');

  const creditSaleSortAccessors = useMemo(
    () => ({
      saleNumber: (s: SaleRow) => s.saleNumber || '',
      customer: (s: SaleRow) => s.customerName || '',
      date: (s: SaleRow) => saleSortDate(s),
      total: (s: SaleRow) => s.totalAmount,
      paid: (s: SaleRow) => saleAmountPaid(s),
      outstanding: (s: SaleRow) => saleOutstanding(s),
    }),
    [],
  );

  const handleColumnSort = (field: string) => {
    const f = field as CreditSalesSortField;
    if (f === 'outstanding') {
      setFilterOutstandingOnly(true);
      handleSort(f, { defaultOrder: 'desc' });
      return;
    }
    setFilterOutstandingOnly(false);
    handleSort(f);
  };

  const sortedSales = useMemo(() => {
    let rows = [...sales];
    if (filterOutstandingOnly) {
      rows = rows.filter((s) => saleOutstanding(s) > 0);
    }
    return applyTableSort(rows, sortField, sortOrder, creditSaleSortAccessors);
  }, [sales, filterOutstandingOnly, sortField, sortOrder, creditSaleSortAccessors]);

  const mobileSortOptions = [
    { value: 'saleNumber', label: 'Sort by Sale #' },
    { value: 'customer', label: 'Sort by Customer' },
    { value: 'date', label: 'Sort by Date' },
    { value: 'total', label: 'Sort by Total' },
    { value: 'paid', label: 'Sort by Paid' },
    { value: 'outstanding', label: 'Sort by Outstanding' },
  ];

  // Fetch all credit sales on-demand from API
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFetchError(null);
    const params = { page: 1, limit: 500, paymentMethod: 'CREDIT' as const, startDate, endDate };
    api.sales.list(params)
      .then((resp) => {
        if (cancelled) return;
        // Handle both direct data array and wrapped {success, data} response shapes
        const body = resp.data;
        const salesArray = Array.isArray(body?.data) ? body.data
          : Array.isArray(body) ? body
            : [];
        const rows = salesArray as Record<string, unknown>[];
        const mapped = rows.map((sale) => ({
          id: String(sale.id || ''),
          saleNumber: String(sale.saleNumber || sale.sale_number || ''),
          saleDate: String(sale.saleDate || sale.sale_date || ''),
          createdAt: String(sale.createdAt || sale.created_at || ''),
          totalAmount: Number(sale.totalAmount || sale.total_amount || 0),
          profit: Number(sale.profit || 0),
          customerName: String(sale.customerName || sale.customer_name || ''),
          customerId: String(sale.customerId || sale.customer_id || ''),
          paymentMethod: String(sale.paymentMethod || sale.payment_method || '') as 'CREDIT',
          status: String(sale.status || '') as 'COMPLETED' | 'PENDING' | 'CANCELLED' | 'VOID' | 'REFUNDED' | 'PARTIALLY_RETURNED' | 'VOIDED_BY_RETURN',
          cashierId: String(sale.cashierId || sale.cashier_id || ''),
          cashierName: String(sale.cashierName || sale.cashier_name || ''),
          amountPaid: Number(sale.amountPaid || sale.amount_paid || 0),
          paymentReceived: Number(sale.amountPaid || sale.amount_paid || sale.paymentReceived || 0),
        }) as SaleRow);

        // "Credit Sales" should reflect credit docs that still have an outstanding AR balance.
        const filtered = mapped.filter((s) => {
          const st = String(s.status || '').toUpperCase();
          if (['CANCELLED', 'VOID', 'REFUNDED', 'VOIDED_BY_RETURN'].includes(st)) return false;

          const total = new Decimal(s.totalAmount || 0);
          const paid = new Decimal(s.paymentReceived || s.amountPaid || 0);
          const outstanding = total.minus(paid);

          return outstanding.greaterThan(0.01);
        });

        setSales(filtered);
      })
      .catch((err) => {
        if (cancelled) return;
        const msg = err?.response?.data?.error || err?.message || 'Unknown error';
        console.error('[CreditSalesView] Fetch failed:', msg, err);
        setFetchError(msg);
        setSales([]);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [startDate, endDate]);

  const totalOutstanding = useMemo(() => {
    return sales.reduce((sum: Decimal, sale: SaleRow) => {
      const total = new Decimal(sale.totalAmount || 0);
      const paid = new Decimal(sale.paymentReceived || sale.amountPaid || 0);
      return sum.plus(total.minus(paid));
    }, new Decimal(0));
  }, [sales]);

  if (loading) {
    return <div className="text-center py-12 text-gray-500">Loading credit sales...</div>;
  }

  if (sales.length === 0) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-500 text-lg">
          {fetchError ? 'Failed to load credit sales' : 'No credit sales found'}
        </p>
        <p className="text-gray-400 text-sm mt-2">
          {fetchError
            ? `Error: ${fetchError}`
            : 'Credit sales will appear here when payment method is CREDIT'}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="bg-orange-50 border border-orange-200 rounded-lg p-3 sm:p-4">
        <div className="flex justify-between items-center gap-3">
          <div className="min-w-0">
            <div className="text-xs sm:text-sm text-orange-800 font-medium">Total Outstanding</div>
            <div className="text-lg sm:text-3xl font-bold text-orange-900 mt-0.5 sm:mt-1 tabular-nums break-words">
              {formatCurrency(totalOutstanding.toNumber())}
            </div>
          </div>
          <div className="text-right shrink-0">
            <div className="text-xs sm:text-sm text-orange-800">Credit Sales</div>
            <div className="text-lg sm:text-2xl font-bold text-orange-900">{sales.length}</div>
          </div>
        </div>
      </div>

      <MobileSortSelect
        sortField={sortField}
        sortOrder={sortOrder}
        options={mobileSortOptions}
        onFieldChange={handleColumnSort}
        onToggleOrder={() => setSortOrder((o) => (o === 'asc' ? 'desc' : 'asc'))}
      />

      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <SortableTableHeader label="Sale #" field="saleNumber" activeField={sortField} direction={sortOrder} onSort={handleColumnSort} />
              <SortableTableHeader label="Customer" field="customer" activeField={sortField} direction={sortOrder} onSort={handleColumnSort} />
              <SortableTableHeader label="Date" field="date" activeField={sortField} direction={sortOrder} onSort={handleColumnSort} />
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                Time
              </th>
              <SortableTableHeader label="Total" field="total" activeField={sortField} direction={sortOrder} onSort={handleColumnSort} align="right" />
              <SortableTableHeader label="Paid" field="paid" activeField={sortField} direction={sortOrder} onSort={handleColumnSort} align="right" />
              <SortableTableHeader label="Outstanding" field="outstanding" activeField={sortField} direction={sortOrder} onSort={handleColumnSort} align="right" filtered={filterOutstandingOnly} />
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {sortedSales.map((sale: SaleRow) => {
              const total = new Decimal(sale.totalAmount || 0);
              const paid = new Decimal(sale.paymentReceived || sale.amountPaid || 0);
              const outstanding = total.minus(paid);

              return (
                <tr key={sale.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-sm font-medium text-blue-600">{sale.saleNumber}</td>
                  <td className="px-4 py-3 text-sm text-gray-900">{sale.customerName}</td>
                  <td className="px-4 py-3 text-sm text-gray-600">
                    {formatDisplayDate(sale.saleDate)}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-600">
                    {formatDisplayTime(sale.createdAt)}
                  </td>
                  <td className="px-4 py-3 text-sm text-right font-medium">
                    {formatCurrency(total.toNumber())}
                  </td>
                  <td className="px-4 py-3 text-sm text-right text-green-600">
                    {formatCurrency(paid.toNumber())}
                  </td>
                  <td className="px-4 py-3 text-sm text-right font-bold text-orange-600">
                    {formatCurrency(outstanding.toNumber())}
                  </td>
                  <td className="px-4 py-3 text-sm text-right">
                    <button
                      onClick={() => onSelectSale(sale)}
                      className="text-blue-600 hover:text-blue-800 font-medium"
                    >
                      View
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Partial Payments View Component
function PartialPaymentsView({ onSelectSale, startDate, endDate }: PartialPaymentsViewProps) {
  const [sales, setSales] = useState<SaleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [filterBalanceOnly, setFilterBalanceOnly] = useState(false);
  const { sortField, sortOrder, handleSort, setSortOrder } = useColumnSort<PartialPaymentsSortField>('balance', 'desc');

  const partialPaymentSortAccessors = useMemo(
    () => ({
      saleNumber: (s: SaleRow) => s.saleNumber || '',
      customer: (s: SaleRow) => s.customerName || '',
      date: (s: SaleRow) => saleSortDate(s),
      total: (s: SaleRow) => s.totalAmount,
      paid: (s: SaleRow) => saleAmountPaid(s),
      balance: (s: SaleRow) => saleOutstanding(s),
    }),
    [],
  );

  const handleColumnSort = (field: string) => {
    const f = field as PartialPaymentsSortField;
    if (f === 'balance') {
      setFilterBalanceOnly(true);
      handleSort(f, { defaultOrder: 'desc' });
      return;
    }
    setFilterBalanceOnly(false);
    handleSort(f);
  };

  const sortedSales = useMemo(() => {
    let rows = [...sales];
    if (filterBalanceOnly) {
      rows = rows.filter((s) => saleOutstanding(s) > 0);
    }
    return applyTableSort(rows, sortField, sortOrder, partialPaymentSortAccessors);
  }, [sales, filterBalanceOnly, sortField, sortOrder, partialPaymentSortAccessors]);

  const mobileSortOptions = [
    { value: 'saleNumber', label: 'Sort by Sale #' },
    { value: 'customer', label: 'Sort by Customer' },
    { value: 'date', label: 'Sort by Date' },
    { value: 'total', label: 'Sort by Total' },
    { value: 'paid', label: 'Sort by Paid' },
    { value: 'balance', label: 'Sort by Balance' },
  ];

  // Fetch credit sales, then filter for partial payments client-side
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFetchError(null);
    const params = { page: 1, limit: 500, paymentMethod: 'CREDIT' as const, startDate, endDate };
    api.sales.list(params)
      .then((resp) => {
        if (cancelled) return;
        const body = resp.data;
        const salesArray = Array.isArray(body?.data) ? body.data
          : Array.isArray(body) ? body
            : [];
        const rows = salesArray as Record<string, unknown>[];
        const allCredit = rows.map((sale) => ({
          id: String(sale.id || ''),
          saleNumber: String(sale.saleNumber || sale.sale_number || ''),
          saleDate: String(sale.saleDate || sale.sale_date || ''),
          createdAt: String(sale.createdAt || sale.created_at || ''),
          totalAmount: Number(sale.totalAmount || sale.total_amount || 0),
          profit: Number(sale.profit || 0),
          customerName: String(sale.customerName || sale.customer_name || ''),
          customerId: String(sale.customerId || sale.customer_id || ''),
          paymentMethod: String(sale.paymentMethod || sale.payment_method || '') as 'CREDIT',
          status: String(sale.status || '') as 'COMPLETED' | 'PENDING' | 'CANCELLED' | 'VOID' | 'REFUNDED' | 'PARTIALLY_RETURNED' | 'VOIDED_BY_RETURN',
          cashierId: String(sale.cashierId || sale.cashier_id || ''),
          cashierName: String(sale.cashierName || sale.cashier_name || ''),
          amountPaid: Number(sale.amountPaid || sale.amount_paid || 0),
          paymentReceived: Number(sale.amountPaid || sale.amount_paid || sale.paymentReceived || 0),
        }) as SaleRow);
        // Filter for partial: paid > 0 AND outstanding > 0 (with tolerance).
        setSales(allCredit.filter((s) => {
          const st = String(s.status || '').toUpperCase();
          if (['CANCELLED', 'VOID', 'REFUNDED', 'VOIDED_BY_RETURN'].includes(st)) return false;

          const total = new Decimal(s.totalAmount || 0);
          const paid = new Decimal(s.paymentReceived || s.amountPaid || 0);
          const outstanding = total.minus(paid);

          return paid.greaterThan(0.01) && outstanding.greaterThan(0.01);
        }));
      })
      .catch((err) => {
        if (cancelled) return;
        const msg = err?.response?.data?.error || err?.message || 'Unknown error';
        console.error('[PartialPaymentsView] Fetch failed:', msg, err);
        setFetchError(msg);
        setSales([]);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [startDate, endDate]);

  if (loading) {
    return <div className="text-center py-12 text-gray-500">Loading partial payments...</div>;
  }

  if (sales.length === 0) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-500 text-lg">
          {fetchError ? 'Failed to load partial payments' : 'No partial payments found'}
        </p>
        <p className="text-gray-400 text-sm mt-2">
          {fetchError
            ? `Error: ${fetchError}`
            : 'Partial payments will appear here when credit sales are partially paid'}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
        <div className="text-sm text-yellow-800 font-medium">Partial Payments</div>
        <div className="text-2xl font-bold text-yellow-900 mt-1">{sales.length} Sales</div>
        <div className="text-sm text-yellow-700 mt-1">Require follow-up for remaining balance</div>
      </div>

      <MobileSortSelect
        sortField={sortField}
        sortOrder={sortOrder}
        options={mobileSortOptions}
        onFieldChange={handleColumnSort}
        onToggleOrder={() => setSortOrder((o) => (o === 'asc' ? 'desc' : 'asc'))}
      />

      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <SortableTableHeader label="Sale #" field="saleNumber" activeField={sortField} direction={sortOrder} onSort={handleColumnSort} />
              <SortableTableHeader label="Customer" field="customer" activeField={sortField} direction={sortOrder} onSort={handleColumnSort} />
              <SortableTableHeader label="Date" field="date" activeField={sortField} direction={sortOrder} onSort={handleColumnSort} />
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                Time
              </th>
              <SortableTableHeader label="Total" field="total" activeField={sortField} direction={sortOrder} onSort={handleColumnSort} align="right" />
              <SortableTableHeader label="Paid" field="paid" activeField={sortField} direction={sortOrder} onSort={handleColumnSort} align="right" />
              <SortableTableHeader label="Balance" field="balance" activeField={sortField} direction={sortOrder} onSort={handleColumnSort} align="right" filtered={filterBalanceOnly} />
              <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">
                % Paid
              </th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {sortedSales.map((sale: SaleRow) => {
              const total = new Decimal(sale.totalAmount || 0);
              const paid = new Decimal(sale.paymentReceived || sale.amountPaid || 0);
              const balance = total.minus(paid);
              const percentPaid = total.greaterThan(0)
                ? paid.dividedBy(total).times(100)
                : new Decimal(0);

              return (
                <tr key={sale.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-sm font-medium text-blue-600">{sale.saleNumber}</td>
                  <td className="px-4 py-3 text-sm text-gray-900">{sale.customerName}</td>
                  <td className="px-4 py-3 text-sm text-gray-600">
                    {formatDisplayDate(sale.saleDate)}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-600">
                    {formatDisplayTime(sale.createdAt)}
                  </td>
                  <td className="px-4 py-3 text-sm text-right font-medium">
                    {formatCurrency(total.toNumber())}
                  </td>
                  <td className="px-4 py-3 text-sm text-right text-green-600">
                    {formatCurrency(paid.toNumber())}
                  </td>
                  <td className="px-4 py-3 text-sm text-right font-bold text-orange-600">
                    {formatCurrency(balance.toNumber())}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <div className="flex items-center justify-center gap-2">
                      <progress value={percentPaid.toNumber()} max="100" className="w-16 h-2" />
                      <span className="text-xs text-gray-600 whitespace-nowrap">
                        {percentPaid.toFixed(0)}%
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm text-right">
                    <button
                      onClick={() => onSelectSale(sale)}
                      className="text-blue-600 hover:text-blue-800 font-medium"
                    >
                      View
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Sale Detail Modal Component with improved accessibility and design
function SaleDetailModal({ sale, onClose, onSaleUpdated }: SaleDetailModalProps) {
  const { user } = useAuth();
  const canVoidSale = useBackendPermission('sales.void');
  const canRefundSale = useBackendPermission('sales.refund');
  const canExchangeSale = useBackendPermission('sales.exchange') || canRefundSale;
  const canReprintReceipt = useBackendPermission('sales.reprint');
  const canReassignCustomer = useBackendPermission('sales.reassign_customer');
  const canRestateTax = useBackendPermission('sales.tax_restatement');
  // Hooks first — aged-return date may read sale detail state after it is declared.
  const [saleDetails, setSaleDetails] = useState<SaleRow | null>(null);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showVoidModal, setShowVoidModal] = useState(false);
  const [showRefundModal, setShowRefundModal] = useState(false);
  const [showExchangeModal, setShowExchangeModal] = useState(false);
  const [showReassignCustomerModal, setShowReassignCustomerModal] = useState(false);
  const [showTaxRestatementModal, setShowTaxRestatementModal] = useState(false);
  const [invoiceSettings, setInvoiceSettings] = useState<InvoiceSettingsForReceipt | null>(null);
  const [isReprinting, setIsReprinting] = useState(false);
  const modalRef = useRef<HTMLDivElement>(null);

  const saleDateForAge = String(
    (saleDetails as { saleDate?: string; sale_date?: string } | null)?.saleDate
      ?? (saleDetails as { sale_date?: string } | null)?.sale_date
      ?? (sale as { saleDate?: string; sale_date?: string }).saleDate
      ?? (sale as { sale_date?: string }).sale_date
      ?? '',
  ).slice(0, 10);
  const agedReturnGate = saleDateForAge
    ? canProcessAgedSaleReturn({
        saleDate: saleDateForAge,
        asOfDate: getBusinessDate(),
        actorRole: user?.role,
      })
    : { allowed: true, ageDays: 0, requiresAdmin: false };
  const agedReturnBlocked = agedReturnGate.requiresAdmin && !agedReturnGate.allowed;
  const agedReturnTitle = agedReturnBlocked
    ? agedSaleReturnDeniedMessage(agedReturnGate.ageDays, AGED_SALE_RETURN_DAYS)
    : undefined;

  // Handle escape key and focus trap
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);

    // Focus the modal when it opens
    modalRef.current?.focus();

    // Prevent body scroll when modal is open
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  // Fetch sale details including items when modal opens
  useEffect(() => {
    const fetchSaleDetails = async () => {
      setLoadingDetails(true);
      setError(null);
      try {
        const response = await api.sales.getById(sale.id);
        if (response.data.success) {
          const responseData = response.data.data;
          // Backend returns { sale: {...}, items: [...], paymentLines: [...] }
          // Flatten into a single SaleRow so all fields are accessible at top level
          if (responseData && typeof responseData === 'object' && 'sale' in responseData) {
            const nested = responseData as {
              sale: Record<string, unknown>;
              items?: SaleItemRow[];
              paymentLines?: PaymentLine[];
            };
            setSaleDetails({
              ...nested.sale,
              items: nested.items || [],
              paymentLines: nested.paymentLines || [],
            } as SaleRow);
          } else {
            setSaleDetails(responseData as SaleRow);
          }
        } else {
          setError('Failed to load sale details');
        }
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to load sale details');
      } finally {
        setLoadingDetails(false);
      }
    };

    fetchSaleDetails();
  }, [sale.id]);

  // Load invoice/receipt branding so reprints match original POS receipts
  useEffect(() => {
    fetchInvoiceSettingsForReceipt().then(setInvoiceSettings);
  }, []);

  const items = saleDetails?.items || [];

  // Click outside to close
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        onClose();
      }
    },
    [onClose]
  );

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto" onClick={handleBackdropClick}>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/50 transition-opacity" aria-hidden="true" />

      {/* Modal positioning */}
      <div className="flex min-h-full items-center justify-center p-4">
        <div
          ref={modalRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="sale-modal-title"
          tabIndex={-1}
          className="relative bg-white w-full max-w-[95vw] sm:max-w-4xl rounded-xl shadow-2xl border border-gray-200 max-h-[90vh] overflow-hidden flex flex-col transform transition-all"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="border-b border-gray-200 px-6 py-4 flex justify-between items-center bg-gray-50 flex-shrink-0">
            <div className="flex items-center space-x-4">
              <div className="h-12 w-12 bg-blue-100 rounded-full flex items-center justify-center">
                <svg
                  className="h-6 w-6 text-blue-600"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                  />
                </svg>
              </div>
              <div>
                <h2 id="sale-modal-title" className="text-xl font-semibold text-gray-900">
                  {sale.saleNumber || `Sale #${sale.id.slice(0, 8)}`}
                </h2>
                <p className="text-sm text-gray-500">
                  {formatDisplayDate(sale.saleDate)} at {formatDisplayTime(sale.createdAt)}
                </p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="p-2 rounded-lg hover:bg-gray-200 transition-colors"
              aria-label="Close modal"
            >
              <svg
                className="h-6 w-6 text-gray-500"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto p-6">
            {/* Quick Stats */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
              <div className="bg-blue-50 rounded-lg p-4 border border-blue-100">
                <div className="text-sm text-blue-600 font-medium">Total Amount</div>
                <div className="text-xl font-bold text-blue-900">
                  {formatCurrency(sale.totalAmount || 0)}
                </div>
              </div>
              <div className="bg-green-50 rounded-lg p-4 border border-green-100">
                <div className="text-sm text-green-600 font-medium">Profit</div>
                <div className="text-xl font-bold text-green-900">
                  {formatCurrency(sale.profit || 0)}
                </div>
              </div>
              <div className="bg-purple-50 rounded-lg p-4 border border-purple-100">
                <div className="text-sm text-purple-600 font-medium">Items</div>
                <div className="text-xl font-bold text-purple-900">{items.length}</div>
              </div>
              <div
                className={`rounded-lg p-4 border ${(saleDetails?.status || sale.status) === 'COMPLETED'
                  ? 'bg-green-50 border-green-100'
                  : (saleDetails?.status || sale.status) === 'PENDING'
                    ? 'bg-yellow-50 border-yellow-100'
                    : (saleDetails?.status || sale.status) === 'VOID'
                      ? 'bg-gray-50 border-gray-200'
                      : (saleDetails?.status || sale.status) === 'REFUNDED'
                        ? 'bg-amber-50 border-amber-100'
                        : 'bg-red-50 border-red-100'
                  }`}
              >
                <div
                  className={`text-sm font-medium ${(saleDetails?.status || sale.status) === 'COMPLETED'
                    ? 'text-green-600'
                    : (saleDetails?.status || sale.status) === 'PENDING'
                      ? 'text-yellow-600'
                      : (saleDetails?.status || sale.status) === 'VOID'
                        ? 'text-gray-500'
                        : (saleDetails?.status || sale.status) === 'REFUNDED'
                          ? 'text-amber-600'
                          : 'text-red-600'
                    }`}
                >
                  Status
                </div>
                <div
                  className={`text-xl font-bold ${(saleDetails?.status || sale.status) === 'COMPLETED'
                    ? 'text-green-900'
                    : (saleDetails?.status || sale.status) === 'PENDING'
                      ? 'text-yellow-900'
                      : (saleDetails?.status || sale.status) === 'VOID'
                        ? 'text-gray-700'
                        : (saleDetails?.status || sale.status) === 'REFUNDED'
                          ? 'text-amber-900'
                          : 'text-red-900'
                    }`}
                >
                  {saleDetails?.status || sale.status}
                </div>
              </div>
            </div>

            {/* Sale Info */}
            <div className="bg-white rounded-lg border border-gray-200 p-4 mb-6">
              <h3 className="text-lg font-semibold text-gray-900 mb-4">Sale Information</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="flex justify-between py-2 border-b border-gray-100">
                  <span className="text-gray-500">Customer</span>
                  <span className="font-medium text-gray-900">
                    {sale.customerName || 'Walk-in Customer'}
                  </span>
                </div>
                <div className="flex justify-between py-2 border-b border-gray-100">
                  <span className="text-gray-500">Cashier</span>
                  <span className="font-medium text-gray-900">
                    {sale.soldByName || sale.cashierName || 'N/A'}
                  </span>
                </div>
                <div className="flex justify-between py-2 border-b border-gray-100">
                  <span className="text-gray-500">Payment Method</span>
                  <span
                    className={`px-2 py-1 text-xs font-semibold rounded-full ${sale.paymentMethod === 'CASH'
                      ? 'bg-green-100 text-green-800'
                      : sale.paymentMethod === 'CARD'
                        ? 'bg-blue-100 text-blue-800'
                        : sale.paymentMethod === 'MOBILE_MONEY'
                          ? 'bg-purple-100 text-purple-800'
                          : sale.paymentMethod === 'CREDIT'
                            ? 'bg-orange-100 text-orange-800'
                            : 'bg-gray-100 text-gray-800'
                      }`}
                  >
                    {sale.paymentMethod}
                  </span>
                </div>
                <div className="flex justify-between py-2 border-b border-gray-100">
                  <span className="text-gray-500">Sale ID</span>
                  <span className="font-mono text-sm text-gray-600">{sale.id.slice(0, 8)}...</span>
                </div>
              </div>

              {/* Split Payment Details */}
              {saleDetails?.paymentLines && saleDetails.paymentLines.length > 1 && (
                <div className="mt-4 pt-4 border-t border-gray-200">
                  <div className="text-sm font-medium text-gray-900 mb-2">
                    Split Payment Breakdown:
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {saleDetails.paymentLines.map((payment: PaymentLine, idx: number) => (
                      <div
                        key={idx}
                        className="flex items-center justify-between gap-2 p-2 bg-gray-50 rounded-lg"
                      >
                        <span
                          className={`px-2 py-1 text-xs font-semibold rounded-full ${(payment.paymentMethod || payment.payment_method) === 'CASH'
                            ? 'bg-green-100 text-green-800'
                            : (payment.paymentMethod || payment.payment_method) === 'CARD'
                              ? 'bg-blue-100 text-blue-800'
                              : (payment.paymentMethod || payment.payment_method) ===
                                'MOBILE_MONEY'
                                ? 'bg-purple-100 text-purple-800'
                                : (payment.paymentMethod || payment.payment_method) === 'CREDIT'
                                  ? 'bg-orange-100 text-orange-800'
                                  : 'bg-gray-100 text-gray-800'
                            }`}
                        >
                          {payment.paymentMethod || payment.payment_method}
                        </span>
                        <span className="text-sm font-medium">
                          {formatCurrency(parseFloat(String(payment.amount || 0)))}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Line Items */}
            <div className="bg-white rounded-lg border border-gray-200 p-4">
              <h3 className="text-lg font-semibold text-gray-900 mb-4">Line Items</h3>

              {loadingDetails ? (
                <div className="text-center py-8">
                  <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
                  <p className="text-gray-600 mt-2">Loading items...</p>
                </div>
              ) : error ? (
                <div className="text-red-600 p-4 bg-red-50 rounded-lg border border-red-200">
                  <div className="flex items-center gap-2">
                    <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                      <path
                        fillRule="evenodd"
                        d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"
                        clipRule="evenodd"
                      />
                    </svg>
                    {error}
                  </div>
                </div>
              ) : items.length === 0 ? (
                <div className="text-gray-500 text-center py-8 bg-gray-50 rounded-lg">
                  <svg
                    className="h-12 w-12 mx-auto text-gray-400 mb-2"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1}
                      d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
                    />
                  </svg>
                  No items found for this sale
                </div>
              ) : (
                <div className="overflow-x-auto -mx-4 sm:mx-0">
                  {(() => {
                    const hasAnyDiscount = items.some((item: SaleItemRow) => {
                      const disc = parseFloat(
                        String(item.discountAmount || item.discount_amount || 0)
                      );
                      return disc > 0;
                    });
                    return (
                      <table className="min-w-full divide-y divide-gray-200">
                        <thead className="bg-gray-50">
                          <tr>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                              Product
                            </th>
                            <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                              Qty
                            </th>
                            <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                              Unit Price
                            </th>
                            {hasAnyDiscount && (
                              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                                Discount
                              </th>
                            )}
                            <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                              Subtotal
                            </th>
                          </tr>
                        </thead>
                        <tbody className="bg-white divide-y divide-gray-200">
                          {items.map((item: SaleItemRow, index: number) => {
                            const quantity = parseFloat(String(item.quantity || item.qty || 0));
                            const itemDiscount = parseFloat(
                              String(item.discountAmount || item.discount_amount || 0)
                            );
                            const storedLineTotal = parseFloat(
                              String(
                                item.totalPrice ||
                                  item.total_price ||
                                  item.lineTotal ||
                                  item.line_total ||
                                  0,
                              ),
                            );
                            const subtotal =
                              storedLineTotal > 0
                                ? storedLineTotal
                                : new Decimal(quantity)
                                    .times(
                                      parseFloat(
                                        String(item.unitPrice || item.unit_price || item.price || 0),
                                      ),
                                    )
                                    .minus(itemDiscount)
                                    .toNumber();
                            const displayUnitPrice =
                              quantity > 0
                                ? new Decimal(subtotal).plus(itemDiscount).dividedBy(quantity).toNumber()
                                : parseFloat(
                                    String(item.unitPrice || item.unit_price || item.price || 0),
                                  );

                            return (
                              <tr key={index} className="hover:bg-gray-50">
                                <td className="px-4 py-3 text-sm text-gray-900">
                                  {item.productName || item.product_name || 'Unknown Product'}
                                </td>
                                <td className="px-4 py-3 text-sm text-gray-900 text-right font-medium">
                                  {quantity.toFixed(quantity % 1 === 0 ? 0 : 2)}
                                </td>
                                <td className="px-4 py-3 text-sm text-gray-600 text-right">
                                  {formatCurrency(displayUnitPrice)}
                                </td>
                                {hasAnyDiscount && (
                                  <td className="px-4 py-3 text-sm text-right">
                                    {itemDiscount > 0 ? (
                                      <span className="text-red-600 font-medium">
                                        -{formatCurrency(itemDiscount)}
                                      </span>
                                    ) : (
                                      <span className="text-gray-400">—</span>
                                    )}
                                  </td>
                                )}
                                <td className="px-4 py-3 text-sm font-semibold text-gray-900 text-right">
                                  {formatCurrency(subtotal)}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    );
                  })()}
                </div>
              )}
            </div>

            {/* Totals Summary */}
            <div className="bg-gray-50 rounded-lg border border-gray-200 p-4 mt-6">
              <div className="space-y-2">
                {(() => {
                  // Compute effective discount: sale-level OR sum of item-level discounts
                  const saleDiscount = parseFloat(
                    String(sale.discountAmount || sale.discount_amount || 0)
                  );
                  const itemDiscountTotal =
                    saleDiscount > 0
                      ? 0
                      : items.reduce((sum: number, item: SaleItemRow) => {
                        return (
                          sum +
                          parseFloat(String(item.discountAmount || item.discount_amount || 0))
                        );
                      }, 0);
                  const effectiveDiscount = saleDiscount > 0 ? saleDiscount : itemDiscountTotal;
                  // Show pre-discount subtotal when there's a discount
                  const displaySubtotal =
                    effectiveDiscount > 0
                      ? new Decimal(sale.totalAmount || 0).plus(effectiveDiscount).toNumber()
                      : sale.subtotal || sale.totalAmount || 0;

                  return (
                    <>
                      <div className="flex justify-between text-gray-600">
                        <span>Subtotal:</span>
                        <span className="font-medium">{formatCurrency(displaySubtotal)}</span>
                      </div>
                      {effectiveDiscount > 0 && (
                        <div className="flex justify-between text-red-600">
                          <span>Discount:</span>
                          <span className="font-medium">-{formatCurrency(effectiveDiscount)}</span>
                        </div>
                      )}
                    </>
                  );
                })()}
                {Number(sale.taxAmount || sale.tax_amount || 0) > 0 && (
                  <div className="flex justify-between text-gray-600">
                    <span>Tax:</span>
                    <span className="font-medium">
                      {formatCurrency(sale.taxAmount || sale.tax_amount || 0)}
                    </span>
                  </div>
                )}
                <div className="flex justify-between text-gray-900 text-lg font-bold border-t border-gray-200 pt-3 mt-3">
                  <span>Total:</span>
                  <span className="text-blue-600">{formatCurrency(sale.totalAmount || 0)}</span>
                </div>
                {sale.paymentMethod === 'CASH' && (
                  <>
                    <div className="flex justify-between text-gray-600 border-t border-gray-200 pt-2 mt-2">
                      <span>Amount Tendered:</span>
                      <span className="font-medium">
                        {formatCurrency(sale.paymentReceived || sale.amountPaid || 0)}
                      </span>
                    </div>
                    <div className="flex justify-between text-green-600">
                      <span>Change Given:</span>
                      <span className="font-medium">
                        {formatCurrency(
                          Math.max(
                            0,
                            (sale.paymentReceived || sale.amountPaid || 0) - (sale.totalAmount || 0)
                          )
                        )}
                      </span>
                    </div>
                  </>
                )}
                {sale.paymentMethod === 'CREDIT' && (
                  <>
                    <div className="flex justify-between text-gray-600 border-t border-gray-200 pt-2 mt-2">
                      <span>Amount Paid:</span>
                      <span className="font-medium">
                        {formatCurrency(sale.paymentReceived || sale.amountPaid || 0)}
                      </span>
                    </div>
                    {(() => {
                      const totalAmount = sale.totalAmount || 0;
                      const amountPaid = sale.paymentReceived || sale.amountPaid || 0;
                      const balance = new Decimal(totalAmount).minus(amountPaid).toNumber();

                      if (balance > 0) {
                        return (
                          <div className="flex justify-between text-orange-600 font-semibold">
                            <span>Outstanding Balance:</span>
                            <span>{formatCurrency(balance)}</span>
                          </div>
                        );
                      } else if (balance < 0) {
                        return (
                          <div className="flex justify-between text-blue-600 font-semibold">
                            <span>Overpayment:</span>
                            <span>{formatCurrency(Math.abs(balance))}</span>
                          </div>
                        );
                      } else {
                        return (
                          <div className="flex justify-between text-green-600 font-semibold">
                            <span>Status:</span>
                            <span>✓ Fully Paid</span>
                          </div>
                        );
                      }
                    })()}
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="border-t border-gray-200 px-6 py-4 bg-gray-50 flex flex-col-reverse sm:flex-row justify-between gap-3 flex-shrink-0">
            {/* Left side: Void & Refund actions */}
            <div className="flex flex-col sm:flex-row gap-2">
              {['COMPLETED', 'PARTIALLY_RETURNED'].includes(
                (saleDetails?.status || sale.status) as string
              ) &&
                canReassignCustomer && (
                  <button
                    onClick={() => setShowReassignCustomerModal(true)}
                    title="Correct sale billed to the wrong customer (managers/admins only)."
                    className="w-full sm:w-auto px-4 py-2 border border-violet-300 text-violet-800 rounded-lg hover:bg-violet-50 transition-colors font-medium text-sm flex items-center justify-center gap-2"
                  >
                    Reassign customer
                  </button>
                )}
              {['COMPLETED', 'PARTIALLY_RETURNED'].includes(
                (saleDetails?.status || sale.status) as string
              ) &&
                canRestateTax && (
                  <button
                    onClick={() => setShowTaxRestatementModal(true)}
                    title="Recompute VAT from product + customer rules and apply omitted tax to this sale/invoice without voiding."
                    className="w-full sm:w-auto px-4 py-2 border border-emerald-300 text-emerald-900 rounded-lg hover:bg-emerald-50 transition-colors font-medium text-sm flex items-center justify-center gap-2"
                  >
                    Apply omitted VAT
                  </button>
                )}
              {/* Void is FORBIDDEN for completed POS sales (ERP discipline: SAP/Odoo-style).
                  Stock, invoice, and payment are already posted. Use Return instead.
                  Only shown for non-posted statuses — none exist in current enum by design. */}
              {!['COMPLETED', 'PARTIALLY_RETURNED', 'VOID', 'REFUNDED', 'VOIDED_BY_RETURN'].includes(
                (saleDetails?.status || sale.status) as string
              ) &&
                canVoidSale && (
                  <button
                    onClick={() => setShowVoidModal(true)}
                    className="w-full sm:w-auto px-4 py-2 border border-red-300 text-red-700 rounded-lg hover:bg-red-50 transition-colors font-medium text-sm flex items-center justify-center gap-2"
                  >
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                    </svg>
                    Void Sale
                  </button>
                )}
              {/* Return button — for COMPLETED and PARTIALLY_RETURNED sales.
                  PARTIALLY_RETURNED: prior returns exist; further returns allowed until fully reversed (VOIDED_BY_RETURN). */}
              {['COMPLETED', 'PARTIALLY_RETURNED'].includes(
                (saleDetails?.status || sale.status) as string
              ) &&
                (canExchangeSale || canRefundSale) && (
                  <>
                  {canExchangeSale && (
                  <button
                    onClick={() => !agedReturnBlocked && setShowExchangeModal(true)}
                    disabled={agedReturnBlocked}
                    title={
                      agedReturnTitle
                      ?? 'Return wrong item(s) and sell the correct product with store credit (full ticket OK for single-item sales).'
                    }
                    className={`w-full sm:w-auto px-4 py-2 border rounded-lg transition-colors font-medium text-sm flex items-center justify-center gap-2 ${
                      agedReturnBlocked
                        ? 'border-gray-200 text-gray-400 cursor-not-allowed bg-gray-50'
                        : 'border-indigo-300 text-indigo-700 hover:bg-indigo-50'
                    }`}
                  >
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                    </svg>
                    Exchange
                  </button>
                  )}
                  {canRefundSale && (
                  <button
                    onClick={() => !agedReturnBlocked && setShowRefundModal(true)}
                    disabled={agedReturnBlocked}
                    title={
                      agedReturnTitle
                      ?? 'Return items, restore stock, and issue a refund to the original payment method.'
                    }
                    className={`w-full sm:w-auto px-4 py-2 border rounded-lg transition-colors font-medium text-sm flex items-center justify-center gap-2 ${
                      agedReturnBlocked
                        ? 'border-gray-200 text-gray-400 cursor-not-allowed bg-gray-50'
                        : 'border-amber-300 text-amber-700 hover:bg-amber-50'
                    }`}
                  >
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
                    </svg>
                    {(saleDetails?.status || sale.status) === 'PARTIALLY_RETURNED' ? 'Return More Items' : 'Return'}
                  </button>
                  )}
                  {agedReturnBlocked && (
                    <span className="text-xs text-amber-700 self-center max-w-xs" title={agedReturnTitle}>
                      Return/Exchange locked — sale older than {AGED_SALE_RETURN_DAYS} days (ADMIN only)
                    </span>
                  )}
                  </>
                )}
              {/* Hint: explain why Void is not available for posted sales */}
              {['COMPLETED', 'PARTIALLY_RETURNED'].includes(
                (saleDetails?.status || sale.status) as string
              ) && (
                  <span className="text-xs text-gray-500 italic self-center hidden sm:inline" title="ERP rule: a posted sale cannot be deleted. Use Return to reverse it — the original sale stays in the audit trail.">
                    Void not allowed — sale is posted
                  </span>
                )}
            </div>
            {/* Right side: Document flow, Close, Print */}
            <div className="flex flex-col sm:flex-row gap-2">
              <DocumentFlowButton entityType="SALE" entityId={sale.id} size="sm" />
              <button
                onClick={onClose}
                className="w-full sm:w-auto px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-100 transition-colors text-gray-700 font-medium"
              >
                Close
              </button>
              {canReprintReceipt && (
                <button
                  disabled={isReprinting || loadingDetails}
                  onClick={async () => {
                    if (isReprinting) return;
                    setIsReprinting(true);
                    try {
                      // Prefer fully loaded detail (items + payments); refetch if still thin
                      let detail: SaleRow | null = saleDetails;
                      if (!detail?.items?.length) {
                        const response = await api.sales.getById(sale.id);
                        if (response.data?.success && response.data.data) {
                          const responseData = response.data.data;
                          if (responseData && typeof responseData === 'object' && 'sale' in responseData) {
                            const nested = responseData as {
                              sale: Record<string, unknown>;
                              items?: SaleItemRow[];
                              paymentLines?: PaymentLine[];
                            };
                            detail = {
                              ...nested.sale,
                              items: nested.items || [],
                              paymentLines: nested.paymentLines || [],
                            } as SaleRow;
                            setSaleDetails(detail);
                          } else {
                            detail = responseData as SaleRow;
                            setSaleDetails(detail);
                          }
                        }
                      }

                      let branding = invoiceSettings;
                      if (!branding) {
                        branding = await fetchInvoiceSettingsForReceipt();
                        setInvoiceSettings(branding);
                      }

                      const s = mergeSaleForReceipt(sale as SaleForReceipt, detail as SaleForReceipt | null);
                      if (!s.items?.length) {
                        toast.error('Sale has no line items to print. Reload and try again.');
                        return;
                      }

                      // Audit trail (non-blocking) — never toast if sale missing
                      try {
                        await api.post(`/sales/${sale.id}/reprint`, undefined, {
                          silentErrorToast: true,
                        });
                      } catch (err) {
                        if (import.meta.env.DEV) {
                          console.warn('[Sales] Receipt reprint audit failed', err);
                        }
                      }

                      const printCfg = await fetchReceiptPrintConfig();
                      if (!isReceiptPrintingEnabled(printCfg)) {
                        toast.error(
                          'Receipt printing is disabled in Settings → Printing. KOT and guest bills still print.',
                        );
                        return;
                      }
                      const receiptData = applyReceiptPrintPresentation(
                        buildReceiptDataFromSale(s, branding, {
                          isReprint: true,
                        }),
                        printCfg,
                      );
                      await printReceipt(receiptData, { printerName: printCfg.printerName });
                      toast.success('Receipt sent to printer');
                    } catch (err) {
                      console.error('Print failed:', err);
                      toast.error(
                        err instanceof Error ? err.message : 'Failed to reprint receipt',
                      );
                    } finally {
                      setIsReprinting(false);
                    }
                  }}
                  className="w-full sm:w-auto px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                    <path
                      fillRule="evenodd"
                      d="M5 4v3H4a2 2 0 00-2 2v3a2 2 0 002 2h1v2a2 2 0 002 2h6a2 2 0 002-2v-2h1a2 2 0 002-2V9a2 2 0 00-2-2h-1V4a2 2 0 00-2-2H7a2 2 0 00-2 2zm8 0H7v3h6V4zm0 8H7v4h6v-4z"
                      clipRule="evenodd"
                    />
                  </svg>
                  {isReprinting ? 'Printing…' : loadingDetails ? 'Loading…' : 'Reprint Receipt'}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Void Sale Modal */}
      {showVoidModal && (
        <VoidSaleModal
          saleId={sale.id}
          saleNumber={sale.saleNumber || `Sale #${sale.id.slice(0, 8)}`}
          totalAmount={sale.totalAmount}
          onClose={() => setShowVoidModal(false)}
          onSuccess={() => {
            setShowVoidModal(false);
            onSaleUpdated?.();
            onClose();
          }}
        />
      )}

      {/* Refund Sale Modal */}
      {showRefundModal && saleDetails && (
        <RefundSaleModal
          saleId={sale.id}
          saleNumber={sale.saleNumber || `Sale #${sale.id.slice(0, 8)}`}
          totalAmount={sale.totalAmount}
          items={saleDetails.items || []}
          onClose={() => setShowRefundModal(false)}
          onSuccess={() => {
            setShowRefundModal(false);
            onSaleUpdated?.();
            onClose();
          }}
        />
      )}

      {/* Wrong-customer reassignment (manager/admin) */}
      {showReassignCustomerModal && (
        <SaleCustomerReassignmentModal
          saleId={sale.id}
          saleNumber={saleDetails?.saleNumber || sale.saleNumber || `Sale #${sale.id.slice(0, 8)}`}
          fromCustomerId={saleDetails?.customerId || sale.customerId || null}
          fromCustomerName={saleDetails?.customerName || sale.customerName || null}
          onClose={() => setShowReassignCustomerModal(false)}
          onSuccess={() => {
            setShowReassignCustomerModal(false);
            toast.success('Sale reassigned to the correct customer');
            onSaleUpdated?.();
            // Refresh detail while keeping modal pattern of parent
            void api.sales.getById(sale.id).then((response) => {
              if (response.data.success) {
                const responseData = response.data.data as {
                  sale?: SaleRow;
                  items?: SaleRow['items'];
                  paymentLines?: SaleRow['paymentLines'];
                };
                if (responseData.sale) {
                  setSaleDetails({
                    ...responseData.sale,
                    items: responseData.items,
                    paymentLines: responseData.paymentLines,
                  });
                }
              }
            });
          }}
        />
      )}

      {/* Omitted VAT restatement (manager/admin) */}
      {showTaxRestatementModal && (
        <SaleTaxRestatementModal
          saleId={sale.id}
          saleNumber={saleDetails?.saleNumber || sale.saleNumber || `Sale #${sale.id.slice(0, 8)}`}
          onClose={() => setShowTaxRestatementModal(false)}
          onSuccess={() => {
            setShowTaxRestatementModal(false);
            toast.success('Omitted VAT applied to sale and linked invoices');
            onSaleUpdated?.();
            void api.sales.getById(sale.id).then((response) => {
              if (response.data.success) {
                const responseData = response.data.data as {
                  sale?: SaleRow;
                  items?: SaleRow['items'];
                  paymentLines?: SaleRow['paymentLines'];
                };
                if (responseData.sale) {
                  setSaleDetails({
                    ...responseData.sale,
                    items: responseData.items,
                    paymentLines: responseData.paymentLines,
                  });
                }
              }
            });
          }}
        />
      )}

      {/* Product exchange — guided return → replace → settle */}
      {showExchangeModal && saleDetails && (
        <ProductExchangeModal
          saleId={sale.id}
          saleNumber={sale.saleNumber || `Sale #${sale.id.slice(0, 8)}`}
          totalAmount={sale.totalAmount}
          paymentMethod={sale.paymentMethod || saleDetails.paymentMethod}
          customerId={saleDetails.customerId || sale.customerId}
          customerName={saleDetails.customerName || sale.customerName}
          items={saleDetails.items || []}
          onClose={() => setShowExchangeModal(false)}
          onSuccess={() => {
            setShowExchangeModal(false);
            onSaleUpdated?.();
          }}
        />
      )}
    </div>
  );
}
