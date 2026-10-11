/**
 * Distribution Module — API Client
 */
import apiClient from '../utils/api';

// ─── Types ──────────────────────────────────────────────────

export interface SalesOrder {
  id: string;
  orderNumber: string;
  customerId: string;
  customerName: string;
  creditLimit: number;
  status: string;
  orderDate: string;
  notes: string | null;
  createdBy: string;
  createdAt: string;
  totalAmount: number;
  totalConfirmed: number;
  totalDelivered: number;
}

export interface SalesOrderLine {
  id: string;
  salesOrderId: string;
  productId: string;
  productName: string;
  sku: string;
  orderedQty: number;
  confirmedQty: number;
  deliveredQty: number;
  openQty: number;
  unitPrice: number;
  lineTotal: number;
}

export interface Delivery {
  id: string;
  deliveryNumber: string;
  salesOrderId: string;
  orderNumber: string;
  customerId: string;
  customerName: string;
  status: string;
  deliveryDate: string;
  notes: string | null;
  createdBy: string;
  createdAt: string;
  totalAmount: number;
  totalCost: number;
}

export interface DistInvoice {
  id: string;
  invoiceNumber: string;
  salesOrderId: string;
  orderNumber: string;
  deliveryId: string;
  deliveryNumber: string;
  customerId: string;
  customerName: string;
  totalAmount: number;
  amountPaid: number;
  amountDue: number;
  status: string;
  issueDate: string;
  dueDate: string | null;
  notes: string | null;
  createdBy: string;
  createdAt: string;
}

export interface AtpResult {
  productId: string;
  productName: string;
  sku: string;
  onHand: number;
  reserved: number;
  atp: number;
}

export interface BackorderLine {
  orderId: string;
  orderNumber: string;
  customerName: string;
  lineId: string;
  productId: string;
  productName: string;
  openQty: number;
}

export interface DepositInfo {
  id: string;
  depositNumber: string;
  amount: number;
  usedAmount: number;
  remainingAmount: number;
  paymentMethod: string;
  createdAt: string;
}

export interface ClearingScreenData {
  invoices: DistInvoice[];
  deposits: DepositInfo[];
  outstanding: number;
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

// ─── API Functions ──────────────────────────────────────────

const distributionApi = {
  // Sales Orders
  async createSalesOrder(data: {
    customerId: string;
    orderDate?: string;
    notes?: string;
    lines: Array<{ productId: string; orderedQty: number; unitPrice: number }>;
  }): Promise<{ order: SalesOrder; lines: SalesOrderLine[] }> {
    const res = await apiClient.post('/distribution/sales-orders', data);
    return res.data.data;
  },

  async listSalesOrders(params: { page?: number; limit?: number; status?: string; customerId?: string }): Promise<{ data: SalesOrder[]; pagination: Pagination }> {
    const res = await apiClient.get('/distribution/sales-orders', { params });
    return { data: res.data.data, pagination: res.data.pagination };
  },

  async getSalesOrder(id: string): Promise<{ order: SalesOrder; lines: SalesOrderLine[] }> {
    const res = await apiClient.get(`/distribution/sales-orders/${id}`);
    return res.data.data;
  },

  async editSalesOrder(id: string, data: {
    orderDate?: string;
    notes?: string;
    lines: Array<{ id?: string; productId: string; orderedQty: number; unitPrice: number }>;
  }): Promise<{ order: SalesOrder; lines: SalesOrderLine[] }> {
    const res = await apiClient.put(`/distribution/sales-orders/${id}`, data);
    return res.data.data;
  },

  // Deliveries
  async createDelivery(data: {
    salesOrderId: string;
    deliveryDate?: string;
    notes?: string;
    lines: Array<{ salesOrderLineId: string; quantity: number }>;
  }): Promise<{ delivery: Delivery; invoice: DistInvoice }> {
    const res = await apiClient.post('/distribution/deliveries', data);
    return res.data.data;
  },

  async listDeliveries(params: { page?: number; limit?: number; salesOrderId?: string; status?: string; customerId?: string }): Promise<{ data: Delivery[]; pagination: Pagination }> {
    const res = await apiClient.get('/distribution/deliveries', { params });
    return { data: res.data.data, pagination: res.data.pagination };
  },

  async getDelivery(id: string): Promise<Delivery> {
    const res = await apiClient.get(`/distribution/deliveries/${id}`);
    return res.data.data;
  },

  // Invoices
  async listInvoices(params: { page?: number; limit?: number; customerId?: string; status?: string; salesOrderId?: string }): Promise<{ data: DistInvoice[]; pagination: Pagination }> {
    const res = await apiClient.get('/distribution/invoices', { params });
    return { data: res.data.data, pagination: res.data.pagination };
  },

  async getInvoice(id: string): Promise<DistInvoice> {
    const res = await apiClient.get(`/distribution/invoices/${id}`);
    return res.data.data;
  },

  // ATP
  async checkAtp(productIds: string[]): Promise<AtpResult[]> {
    const res = await apiClient.post('/distribution/atp', { productIds });
    return res.data.data;
  },

  // Clearing
  async getClearingScreen(customerId: string): Promise<ClearingScreenData> {
    const res = await apiClient.get(`/distribution/clearing/screen/${customerId}`);
    return res.data.data;
  },

  async processClearing(data: {
    customerId: string;
    invoiceId: string;
    depositAllocations: Array<{ depositId: string; amount: number }>;
    cashPayment?: { amount: number; paymentMethod: 'CASH' | 'CARD' | 'MOBILE_MONEY' | 'BANK_TRANSFER'; referenceNumber?: string };
    notes?: string;
  }): Promise<{
    clearingNumbers: string[];
    receiptNumber?: string;
    totalCleared: number;
    changeGiven?: number;
    cashTendered?: number;
    cashApplied?: number;
  }> {
    const res = await apiClient.post('/distribution/clearing', data);
    return res.data.data;
  },

  // Backorders
  async listBackorders(productId?: string): Promise<BackorderLine[]> {
    const res = await apiClient.get('/distribution/backorders', { params: productId ? { productId } : {} });
    return res.data.data;
  },

  async reconfirmBackorders(productId: string): Promise<{ confirmed: number }> {
    const res = await apiClient.post('/distribution/backorders/reconfirm', { productId });
    return res.data.data;
  },

  async reconfirmSalesOrder(id: string): Promise<{
    confirmedUnits: number;
    order: SalesOrder;
    lines: SalesOrderLine[];
  }> {
    const res = await apiClient.post(`/distribution/sales-orders/${id}/reconfirm`);
    return res.data.data;
  },

  // Quotation Conversion
  async convertFromQuotation(quotationId: string): Promise<{ order: SalesOrder; lines: SalesOrderLine[]; quotationNumber: string }> {
    const res = await apiClient.post(`/distribution/from-quotation/${quotationId}`);
    return res.data.data;
  },
};

export default distributionApi;
