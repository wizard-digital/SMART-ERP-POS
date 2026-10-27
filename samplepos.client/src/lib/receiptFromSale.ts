import Decimal from 'decimal.js';
import type { ReceiptData } from './print';
import { api } from '../utils/api';
import { accountsForReceipt } from '@shared/utils/paymentAccountsVisibility';
import {
  documentReductionLabel,
  presentPersistedSaleDiscounts,
} from '@shared/domain/saleDiscountSsot';

/** Invoice/receipt branding fields from tenant settings */
export interface InvoiceSettingsForReceipt {
  companyName?: string;
  companyAddress?: string | null;
  companyPhone?: string | null;
  companyTin?: string | null;
  /** Invoice Settings → Footer Text (closing line under note) */
  footerText?: string | null;
  customReceiptNote?: string | null;
  paymentAccounts?: Array<{
    type: string;
    provider: string;
    accountName: string;
    accountNumber: string;
    branchOrCode?: string;
    isActive: boolean;
    showOnReceipt: boolean;
    sortOrder?: number;
  }>;
}

export interface SaleItemForReceipt {
  productName?: string;
  product_name?: string;
  quantity?: number | string;
  qty?: number | string;
  unitPrice?: number | string;
  unit_price?: number | string;
  price?: number | string;
  subtotal?: number | string;
  totalPrice?: number | string;
  total_price?: number | string;
  totalAmount?: number | string;
  lineTotal?: number | string;
  line_total?: number | string;
  discountAmount?: number | string;
  discount_amount?: number | string;
  uom?: string;
  taxAmount?: number | string;
  tax_amount?: number | string;
  taxRate?: number | string;
  tax_rate?: number | string;
  isTaxable?: boolean;
  is_taxable?: boolean;
  taxName?: string;
  tax_name?: string;
}

export interface PaymentLineForReceipt {
  paymentMethod?: string;
  payment_method?: string;
  amount: number | string;
  reference?: string;
}

export interface SaleForReceipt {
  saleNumber?: string;
  sale_number?: string;
  saleDate?: string;
  sale_date?: string;
  createdAt?: string;
  created_at?: string;
  totalAmount?: number | string;
  total_amount?: number | string;
  subtotal?: number;
  discountAmount?: number | string;
  discount_amount?: number | string;
  exchangeCreditApplied?: number | string;
  exchange_credit_applied?: number | string;
  taxAmount?: number | string;
  tax_amount?: number | string;
  cashierName?: string;
  soldByName?: string;
  cashier_name?: string;
  sold_by_name?: string;
  customerName?: string;
  customer_name?: string;
  customerPhone?: string;
  customer_phone?: string;
  customerEmail?: string;
  customer_email?: string;
  paymentMethod?: string;
  payment_method?: string;
  amountPaid?: number;
  amount_paid?: number;
  paymentReceived?: number;
  payment_received?: number;
  changeAmount?: number;
  change_amount?: number;
  items?: SaleItemForReceipt[];
  paymentLines?: PaymentLineForReceipt[];
}

export interface CheckoutReceiptInput {
  saleNumber: string;
  saleDate?: string;
  subtotal?: number;
  discountAmount?: number;
  discountLabel?: string;
  exchangeCreditApplied?: number;
  taxAmount?: number;
  totalAmount: number;
  cashierName?: string;
  customer?: { name?: string; phone?: string | null; email?: string | null } | null;
  items?: Array<{
    name: string;
    quantity: number;
    unitPrice: number;
    subtotal: number;
    uom?: string;
    discountAmount?: number;
    taxAmount?: number;
    taxRate?: number;
    isTaxable?: boolean;
    taxName?: string;
  }>;
  payments?: ReceiptData['payments'];
  paymentMethod?: string;
  amountPaid?: number;
  changeGiven?: number;
  invoiceSettings?: InvoiceSettingsForReceipt | null;
  isReprint?: boolean;
}

function pickString(...values: Array<string | null | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function pickNumber(...values: Array<number | string | null | undefined>): number | undefined {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const n = typeof value === 'number' ? value : Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** Resolve customer block fields from any sale row shape (list, detail, snake/camel). */
export function resolveReceiptCustomerFields(
  sale: SaleForReceipt
): Pick<ReceiptData, 'customerName' | 'customerPhone' | 'customerEmail'> {
  return {
    customerName: pickString(sale.customerName, sale.customer_name),
    customerPhone: pickString(sale.customerPhone, sale.customer_phone),
    customerEmail: pickString(sale.customerEmail, sale.customer_email),
  };
}

/**
 * Merge list-row sale with detail payload so reprints keep customer/cashier when
 * either source has them (detail wins for line items and payments).
 */
export function mergeSaleForReceipt(
  listSale: SaleForReceipt,
  detail: SaleForReceipt | null | undefined
): SaleForReceipt {
  if (!detail) return listSale;

  const listCustomer = resolveReceiptCustomerFields(listSale);
  const detailCustomer = resolveReceiptCustomerFields(detail);

  return {
    ...listSale,
    ...detail,
    saleNumber: pickString(detail.saleNumber, detail.sale_number, listSale.saleNumber, listSale.sale_number),
    saleDate: pickString(detail.saleDate, detail.sale_date, listSale.saleDate, listSale.sale_date),
    createdAt: pickString(detail.createdAt, detail.created_at, listSale.createdAt, listSale.created_at),
    customerName: detailCustomer.customerName ?? listCustomer.customerName,
    customerPhone: detailCustomer.customerPhone ?? listCustomer.customerPhone,
    customerEmail: detailCustomer.customerEmail ?? listCustomer.customerEmail,
    cashierName: pickString(
      detail.cashierName,
      detail.soldByName,
      detail.cashier_name,
      detail.sold_by_name,
      listSale.cashierName,
      listSale.soldByName,
      listSale.cashier_name,
      listSale.sold_by_name
    ),
    totalAmount:
      pickNumber(detail.totalAmount, detail.total_amount, listSale.totalAmount, listSale.total_amount) ??
      listSale.totalAmount,
    subtotal: pickNumber(detail.subtotal, listSale.subtotal),
    taxAmount: pickNumber(detail.taxAmount, detail.tax_amount, listSale.taxAmount, listSale.tax_amount),
    discountAmount: pickNumber(
      detail.discountAmount,
      detail.discount_amount,
      listSale.discountAmount,
      listSale.discount_amount
    ),
    amountPaid: pickNumber(
      detail.amountPaid,
      detail.amount_paid,
      detail.paymentReceived,
      detail.payment_received,
      listSale.amountPaid,
      listSale.amount_paid,
      listSale.paymentReceived,
      listSale.payment_received
    ),
    changeAmount: pickNumber(detail.changeAmount, detail.change_amount, listSale.changeAmount, listSale.change_amount),
    paymentMethod: pickString(detail.paymentMethod, detail.payment_method, listSale.paymentMethod, listSale.payment_method),
    items: detail.items?.length ? detail.items : listSale.items,
    paymentLines: detail.paymentLines?.length ? detail.paymentLines : listSale.paymentLines,
  };
}

/** Format a Date into a receipt-friendly date+time string: DD/MM/YYYY h:mm AM/PM */
export function formatReceiptDateTime(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Kampala',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(date);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('day')}/${get('month')}/${get('year')} ${get('hour')}:${get('minute')} ${get('dayPeriod').toUpperCase()}`;
}

export async function fetchInvoiceSettingsForReceipt(): Promise<InvoiceSettingsForReceipt | null> {
  try {
    const response = await api.settings.getInvoiceSettings();
    if (response.data?.success && response.data?.data) {
      return response.data.data as InvoiceSettingsForReceipt;
    }
  } catch (error) {
    console.error('Failed to fetch invoice settings for receipt:', error);
  }
  return null;
}

export function invoiceSettingsToReceiptBranding(
  invoiceSettings?: InvoiceSettingsForReceipt | null
): Pick<
  ReceiptData,
  | 'companyName'
  | 'companyAddress'
  | 'companyPhone'
  | 'companyTin'
  | 'paymentAccounts'
  | 'customReceiptNote'
  | 'footerText'
> {
  if (!invoiceSettings) {
    return {};
  }

  // SSOT with invoice PDF — default ON, type-agnostic (BANK + MOBILE_MONEY share rules).
  const accounts = accountsForReceipt(invoiceSettings.paymentAccounts || []).map((a) => ({
    type: a.type,
    provider: a.provider,
    accountName: a.accountName,
    accountNumber: a.accountNumber,
    branchOrCode: a.branchOrCode,
  }));

  return {
    companyName: invoiceSettings.companyName,
    companyAddress: invoiceSettings.companyAddress || undefined,
    companyPhone: invoiceSettings.companyPhone || undefined,
    companyTin: invoiceSettings.companyTin || undefined,
    paymentAccounts: accounts.length > 0 ? accounts : undefined,
    customReceiptNote: invoiceSettings.customReceiptNote?.trim() || undefined,
    footerText: invoiceSettings.footerText?.trim() || undefined,
  };
}

function resolveSaleDate(sale: SaleForReceipt): string {
  const raw = sale.createdAt || sale.created_at || sale.saleDate || sale.sale_date;
  if (raw) {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) {
      return formatReceiptDateTime(parsed);
    }
  }
  return formatReceiptDateTime(new Date());
}

/** SSOT — build receipt payload from a persisted sale (reprint, PDF bridge). */
export function buildReceiptDataFromSale(
  sale: SaleForReceipt,
  invoiceSettings?: InvoiceSettingsForReceipt | null,
  options?: { isReprint?: boolean }
): ReceiptData {
  const discountView = presentPersistedSaleDiscounts(
    sale as unknown as Record<string, unknown>,
    (sale.items || []) as unknown as Array<Record<string, unknown>>,
  );
  const effectiveDisc = discountView.cartDiscount;
  const totalAmount = pickNumber(sale.totalAmount, sale.total_amount) ?? 0;
  const changeAmount = Number(pickNumber(sale.changeAmount, sale.change_amount) ?? 0);
  const customer = resolveReceiptCustomerFields(sale);

  return {
    isReprint: options?.isReprint,
    saleNumber: pickString(sale.saleNumber, sale.sale_number) ?? '',
    saleDate: resolveSaleDate(sale),
    totalAmount,
    subtotal:
      discountView.merchandiseNet > 0
        ? discountView.merchandiseNet
        : effectiveDisc > 0
          ? new Decimal(totalAmount).plus(effectiveDisc).toNumber()
          : pickNumber(sale.subtotal),
    discountAmount: effectiveDisc > 0 ? effectiveDisc : undefined,
    discountLabel: documentReductionLabel(
      Number(pickNumber(sale.exchangeCreditApplied, sale.exchange_credit_applied) ?? 0) > 0.02,
    ),
    taxAmount: pickNumber(sale.taxAmount, sale.tax_amount),
    cashierName: pickString(
      sale.cashierName,
      sale.soldByName,
      sale.cashier_name,
      sale.sold_by_name
    ),
    ...customer,
    paymentMethod: pickString(sale.paymentMethod, sale.payment_method),
    amountPaid: pickNumber(
      sale.amountPaid,
      sale.amount_paid,
      sale.paymentReceived,
      sale.payment_received
    ),
    changeAmount: changeAmount > 0 ? changeAmount : undefined,
    changeGiven: changeAmount > 0 ? changeAmount : undefined,
    items: sale.items?.map((item, index) => ({
      name: item.productName || item.product_name || 'Unknown',
      quantity: Number(item.quantity || item.qty || 0),
      unitPrice: discountView.lines[index]?.unitPrice ?? Number(item.unitPrice || item.unit_price || item.price || 0),
      subtotal:
        discountView.lines[index]?.lineNet ??
        Number(
          item.totalPrice ||
            item.total_price ||
            item.subtotal ||
            item.totalAmount ||
            item.lineTotal ||
            item.line_total ||
            0
        ),
      uom: item.uom,
      discountAmount:
        (discountView.lines[index]?.lineDiscount || 0) > 0
          ? discountView.lines[index]?.lineDiscount
          : undefined,
      taxAmount: pickNumber(item.taxAmount, item.tax_amount),
      taxRate: pickNumber(item.taxRate, item.tax_rate),
      isTaxable: item.isTaxable === true || item.is_taxable === true,
      taxName: pickString(item.taxName, item.tax_name),
    })),
    payments: sale.paymentLines?.map((pl) => ({
      method: pl.paymentMethod || pl.payment_method || 'CASH',
      amount: Number(pl.amount),
      reference: pl.reference,
    })),
    ...invoiceSettingsToReceiptBranding(invoiceSettings),
  };
}

/** SSOT — build receipt payload at POS checkout (live customer selection). */
export function buildReceiptDataFromCheckout(input: CheckoutReceiptInput): ReceiptData {
  return buildReceiptDataFromSale(
    {
      saleNumber: input.saleNumber,
      saleDate: input.saleDate,
      subtotal: input.subtotal,
      discountAmount: input.discountAmount,
      exchangeCreditApplied: input.exchangeCreditApplied,
      taxAmount: input.taxAmount,
      totalAmount: input.totalAmount,
      cashierName: input.cashierName,
      customerName: input.customer?.name,
      customerPhone: input.customer?.phone ?? undefined,
      customerEmail: input.customer?.email ?? undefined,
      paymentMethod: input.paymentMethod,
      amountPaid: input.amountPaid,
      changeAmount: input.changeGiven,
      items: input.items?.map((item) => ({
        productName: item.name,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        totalPrice: item.subtotal,
        uom: item.uom,
        discountAmount: item.discountAmount,
        taxAmount: item.taxAmount,
        taxRate: item.taxRate,
        isTaxable: item.isTaxable,
        taxName: item.taxName,
      })),
      paymentLines: input.payments?.map((p) => ({
        paymentMethod: p.method,
        amount: p.amount,
        reference: p.reference,
      })),
    },
    input.invoiceSettings,
    { isReprint: input.isReprint }
  );
}
