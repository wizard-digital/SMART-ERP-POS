/**
 * HANDLER PROOF: invoiceService.createInvoice is invoked — not a grep.
 *
 * CREDIT (Henber), cash underpay (no payment lines), fully paid cash, voided return,
 * quote conversion, and header-vs-lines so payments are not double-counted.
 *
 * Run: node --experimental-vm-modules ./node_modules/jest/bin/jest.js src/modules/invoices/invoiceService.createInvoice.harness.test.ts --no-coverage --forceExit
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PoolClient } from 'pg';

type MockFn = (...args: unknown[]) => Promise<unknown>;

const mockInvoiceRepo = {
  findBySaleId: jest.fn<MockFn>(),
  createInvoice: jest.fn<MockFn>(),
  addPayment: jest.fn<MockFn>(),
  recalcInvoice: jest.fn<MockFn>(),
};

const mockSalesRepo = {
  getSaleById: jest.fn<MockFn>(),
};

const mockQuery = jest.fn<MockFn>();
const mockClient = {
  query: mockQuery,
  release: jest.fn(),
} as unknown as PoolClient;

jest.unstable_mockModule('./invoiceRepository.js', () => ({
  invoiceRepository: mockInvoiceRepo,
}));

jest.unstable_mockModule('../sales/salesRepository.js', () => ({
  salesRepository: mockSalesRepo,
}));

jest.unstable_mockModule('../../db/unitOfWork.js', () => ({
  UnitOfWork: {
    run: async <T>(_pool: unknown, fn: (c: PoolClient) => Promise<T>): Promise<T> => fn(mockClient),
    runOrJoin: async <T>(_handle: unknown, fn: (c: PoolClient) => Promise<T>): Promise<T> =>
      fn(mockClient),
    isPool: () => false,
  },
}));

jest.unstable_mockModule('../document-flow/documentFlowService.js', () => ({
  linkDocuments: jest.fn<MockFn>().mockResolvedValue(undefined),
}));

jest.unstable_mockModule('../../utils/customerBalanceSync.js', () => ({
  syncCustomerBalanceFromInvoices: jest.fn<MockFn>().mockResolvedValue(undefined),
}));

jest.unstable_mockModule('../../services/accountingApiClient.js', () => ({
  accountingApiClient: { postJournalEntry: jest.fn<MockFn>().mockResolvedValue(undefined) },
}));

jest.unstable_mockModule('../deposits/depositsService.js', () => ({
  getCustomerDepositBalance: jest.fn<MockFn>().mockResolvedValue(0),
  applyDeposit: jest.fn<MockFn>().mockResolvedValue(undefined),
}));

const { invoiceService } = await import('./invoiceService.js');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

const evidence: Array<{ name: string; ok: true; detail: Record<string, unknown> }> = [];

function prove(name: string, detail: Record<string, unknown>): void {
  evidence.push({ name, ok: true, detail });
}

function saleBundle(over: Record<string, unknown> = {}, paymentLines: unknown[] | undefined = undefined) {
  return {
    sale: {
      id: 'sale-1',
      customer_id: 'cust-1',
      subtotal: 3_200_000,
      tax_amount: 0,
      total_amount: 3_200_000,
      amount_paid: 0,
      payment_method: 'CREDIT',
      status: 'COMPLETED',
      quote_id: null,
      ...over,
    },
    paymentLines,
  };
}

describe('createInvoice handler (executed)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockInvoiceRepo.findBySaleId.mockResolvedValue(null);
    mockInvoiceRepo.createInvoice.mockResolvedValue({ id: 'inv-1' });
    mockInvoiceRepo.addPayment.mockResolvedValue({ id: 'pay-1' });
    mockInvoiceRepo.recalcInvoice.mockResolvedValue({
      id: 'inv-1',
      sale_id: 'sale-1',
      customer_id: 'cust-1',
    });
    mockQuery.mockImplementation(async (...args: unknown[]) => {
      const sql = String(args[0] ?? '');
      if (sql.includes('SELECT name FROM customers')) {
        return { rows: [{ name: 'Test Customer' }] };
      }
      if (sql.includes('quote_id')) {
        return { rows: [{ quote_id: null }] };
      }
      return { rows: [] };
    });
  });

  it('Henber CREDIT sale creates an invoice for the full charged total', async () => {
    mockSalesRepo.getSaleById.mockResolvedValue(
      saleBundle(
        { payment_method: 'CREDIT', amount_paid: 0, total_amount: 100_000, subtotal: 100_000 },
        [{ id: 'pl-1', payment_method: 'CREDIT', amount: 100_000 }],
      ),
    );
    const result = await invoiceService.createInvoice(mockClient, {
      customerId: 'cust-1',
      saleId: 'sale-1',
    });
    expect(result.invoice.id).toBe('inv-1');
    expect(mockInvoiceRepo.createInvoice).toHaveBeenCalledTimes(1);
    const created = mockInvoiceRepo.createInvoice.mock.calls[0][1] as { totalAmount: number };
    expect(created.totalAmount).toBe(100_000);
    expect(mockInvoiceRepo.addPayment).not.toHaveBeenCalled();
    prove('credit-sale-creates-full-invoice', { totalAmount: created.totalAmount, payments: 0 });
  });

  it('CASH underpay with no payment lines creates invoice and copies header paid', async () => {
    mockSalesRepo.getSaleById.mockResolvedValue(
      saleBundle({
        payment_method: 'CASH',
        amount_paid: 1_000_000,
        total_amount: 3_200_000,
        subtotal: 3_200_000,
      }),
    );
    await invoiceService.createInvoice(mockClient, {
      customerId: 'cust-1',
      saleId: 'sale-1',
    });
    const created = mockInvoiceRepo.createInvoice.mock.calls[0][1] as { totalAmount: number };
    expect(created.totalAmount).toBe(3_200_000);
    expect(mockInvoiceRepo.addPayment).toHaveBeenCalledTimes(1);
    const pay = mockInvoiceRepo.addPayment.mock.calls[0][1] as {
      amount: number;
      paymentMethod: string;
    };
    expect(pay.amount).toBe(1_000_000);
    expect(pay.paymentMethod).toBe('CASH');
    prove('cash-underpay-header-paid', { invoiceTotal: created.totalAmount, copiedPaid: pay.amount });
  });

  it('CREDIT + CASH payment lines do not double-count the header', async () => {
    mockSalesRepo.getSaleById.mockResolvedValue(
      saleBundle(
        {
          payment_method: 'CREDIT',
          amount_paid: 50_000,
          total_amount: 100_000,
          subtotal: 100_000,
        },
        [
          { id: 'pl-c', payment_method: 'CASH', amount: 50_000 },
          { id: 'pl-r', payment_method: 'CREDIT', amount: 50_000 },
        ],
      ),
    );
    await invoiceService.createInvoice(mockClient, {
      customerId: 'cust-1',
      saleId: 'sale-1',
    });
    expect(mockInvoiceRepo.addPayment).toHaveBeenCalledTimes(1);
    const pay = mockInvoiceRepo.addPayment.mock.calls[0][1] as { amount: number };
    expect(pay.amount).toBe(50_000);
    prove('split-tender-no-double-count', { addPaymentCalls: 1, amount: pay.amount });
  });

  it('fully paid CASH is refused', async () => {
    mockSalesRepo.getSaleById.mockResolvedValue(
      saleBundle({
        payment_method: 'CASH',
        amount_paid: 80_000,
        total_amount: 80_000,
        subtotal: 80_000,
      }),
    );
    await expect(
      invoiceService.createInvoice(mockClient, { customerId: 'cust-1', saleId: 'sale-1' }),
    ).rejects.toThrow(/fully paid/);
    expect(mockInvoiceRepo.createInvoice).not.toHaveBeenCalled();
    prove('fully-paid-cash-refused', { created: false });
  });

  it('VOIDED_BY_RETURN is refused', async () => {
    mockSalesRepo.getSaleById.mockResolvedValue(
      saleBundle({
        status: 'VOIDED_BY_RETURN',
        payment_method: 'CASH',
        amount_paid: 0,
        total_amount: 3_200_000,
      }),
    );
    await expect(
      invoiceService.createInvoice(mockClient, { customerId: 'cust-1', saleId: 'sale-1' }),
    ).rejects.toThrow(/voided or fully returned/);
    expect(mockInvoiceRepo.createInvoice).not.toHaveBeenCalled();
    prove('voided-by-return-refused', { created: false });
  });

  it('quote-linked fully paid cash still creates (conversion path)', async () => {
    mockSalesRepo.getSaleById.mockResolvedValue(
      saleBundle({
        payment_method: 'CASH',
        amount_paid: 50_000,
        total_amount: 50_000,
        subtotal: 50_000,
        quote_id: 'quote-1',
      }),
    );
    await invoiceService.createInvoice(mockClient, {
      customerId: 'cust-1',
      saleId: 'sale-1',
      quoteId: 'quote-1',
    });
    expect(mockInvoiceRepo.createInvoice).toHaveBeenCalledTimes(1);
    prove('quote-conversion-creates', { created: true });
  });

  it('writes executed handler evidence', () => {
    expect(evidence.length).toBe(6);
    const payload = {
      title: 'PROOF_SALE_INVOICE_CREATE_HANDLER',
      runAt: new Date().toISOString(),
      verdict: 'PASS',
      exercised: 'invoiceService.createInvoice',
      checks: evidence,
    };
    const json = JSON.stringify(payload, null, 2);
    writeFileSync(path.join(repoRoot, 'PROOF_SALE_INVOICE_CREATE_HANDLER.json'), json);
    writeFileSync(
      path.join(repoRoot, 'SamplePOS.Server/PROOF_SALE_INVOICE_CREATE_HANDLER.json'),
      json,
    );
  });
});
