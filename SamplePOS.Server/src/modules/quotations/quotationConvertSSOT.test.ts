/**
 * SSOT routing test for quotationService.convertQuotationToSale.
 *
 * Asserts the conversion path delegates to salesRepository.createSale +
 * salesRepository.addSaleItems (the Sales SSOT), instead of inlining raw SQL.
 * This guarantees the conversion gains:
 *   - generateSaleNumber advisory_lock (no sale_number race)
 *   - checkAccountingPeriodOpen (period control)
 *   - idempotency_key / cash_register_session_id columns
 *   - canonical profit formula (subtotal - discount) - totalCost
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { Pool, PoolClient } from 'pg';

type MockFn = (...args: unknown[]) => Promise<unknown>;

const mockSalesRepo = {
  createSale: jest.fn<MockFn>(),
  addSaleItems: jest.fn<MockFn>(),
  generateSaleNumber: jest.fn<MockFn>(),
};

const mockQuotationRepo = {
  getQuotationById: jest.fn<MockFn>(),
  canConvertQuotation: jest.fn<MockFn>(),
  markQuotationAsConverted: jest.fn<MockFn>(),
};

const mockGlEntryService = {
  recordSaleToGL: jest.fn<MockFn>().mockResolvedValue(undefined),
};

const mockDocumentFlowService = {
  linkDocuments: jest.fn<MockFn>().mockResolvedValue(undefined),
};

const mockInvoiceService = {
  createInvoice: jest.fn<MockFn>().mockResolvedValue({ invoice: { id: 'inv-1' } }),
  addPayment: jest.fn<MockFn>().mockResolvedValue(undefined),
};

const mockClient = {
  query: jest.fn<MockFn>(),
  release: jest.fn(),
} as unknown as PoolClient;

const mockPool = {
  connect: jest.fn(async () => mockClient),
  query: jest.fn<MockFn>(),
} as unknown as Pool;

jest.unstable_mockModule('../sales/salesRepository.js', () => ({
  salesRepository: mockSalesRepo,
  default: mockSalesRepo,
}));

jest.unstable_mockModule('./quotationRepository.js', () => ({
  quotationRepository: mockQuotationRepo,
  default: mockQuotationRepo,
}));

jest.unstable_mockModule('../../services/glEntryService.js', () => mockGlEntryService);

jest.unstable_mockModule('../document-flow/documentFlowService.js', () => mockDocumentFlowService);

jest.unstable_mockModule('../invoices/invoiceService.js', () => ({
  invoiceService: mockInvoiceService,
}));

jest.unstable_mockModule('../../db/unitOfWork.js', () => ({
  UnitOfWork: {
    run: async <T>(_pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> => fn(mockClient),
    runOrJoin: async <T>(_handle: unknown, fn: (c: PoolClient) => Promise<T>): Promise<T> => fn(mockClient),
    isPool: (_handle: unknown): boolean => true,
  },
}));

jest.unstable_mockModule('../../utils/maintenanceGuard.js', () => ({
  checkMaintenanceMode: jest.fn<MockFn>().mockResolvedValue(undefined),
}));

jest.unstable_mockModule('../../utils/fefoDeduction.js', () => ({
  deductStockFEFO: jest.fn<MockFn>().mockResolvedValue({ totalCost: 0 }),
}));

jest.unstable_mockModule('../../middleware/businessRules.js', () => ({
  InventoryBusinessRules: {
    validateStockAvailability: jest.fn<MockFn>().mockResolvedValue(undefined),
  },
  SalesBusinessRules: {
    validateProductActive: jest.fn<MockFn>().mockResolvedValue(undefined),
    validateCreditSale: jest.fn<MockFn>().mockResolvedValue(undefined),
  },
}));

jest.unstable_mockModule('../../services/masterDataGuard.js', () => ({
  assertItemHasSellingPrice: jest.fn<MockFn>().mockResolvedValue(undefined),
}));

jest.unstable_mockModule('./quotationSaleUom.js', () => ({
  buildQuoteConversionLineSnapshots: jest.fn<MockFn>().mockResolvedValue([
    { baseQuantity: 10, baseUomId: 'uom-base', conversionFactor: 1, deductQuantity: { toNumber: () => 10 }, baseUnitCost: 100 },
  ]),
}));

jest.unstable_mockModule('./quotationUomResolver.js', () => ({
  loadMasterUoms: jest.fn<MockFn>().mockResolvedValue([]),
  normalizeQuotationLineUom: jest.fn(),
}));

jest.unstable_mockModule('../../utils/dateRange.js', () => ({
  getBusinessDate: () => '2026-06-20',
  getBusinessYear: () => 2026,
  formatDateBusiness: (d: string) => d,
  addDaysToDateString: (d: string, _n: number) => d,
}));

// ============================================================================
// TESTS
// ============================================================================

describe('quotationService.convertQuotationToSale — Sales SSOT routing (P0-A)', () => {
  let quotationService: typeof import('./quotationService.js').quotationService;

  beforeEach(async () => {
    jest.clearAllMocks();

    // Canonical OPEN, RETAIL, valid quotation
    mockQuotationRepo.getQuotationById.mockResolvedValue({
      quotation: {
        id: 'quote-uuid-1',
        quote_number: 'QUOTE-2026-0001',
        customer_id: 'cust-uuid-1',
        customer_name: 'Test Customer',
        fulfillment_mode: 'RETAIL',
        valid_until: '2030-01-01',
        subtotal: '1000.00',
        tax_amount: '180.00',
        discount_amount: '0.00',
        total_amount: '1180.00',
      },
      items: [
        {
          product_id: 'prod-uuid-1',
          description: 'Widget',
          quantity: '10',
          unit_price: '100.00',
          unit_cost: '60.00',
          uom_id: 'uom-base',
          uom_name: 'Each',
          line_total: '1180.00',
        },
      ],
    });
    mockQuotationRepo.canConvertQuotation.mockResolvedValue({ can: true });
    mockQuotationRepo.markQuotationAsConverted.mockResolvedValue({});

    // Pool.query stubs for: default UoM lookup ('Each'), UoM existence check.
    // mockClient.query is used inside the conversion; we return the 'Each' uom row.
    (mockClient.query as jest.Mock).mockImplementation(async (sql: unknown) => {
      const text = String(sql);
      if (text.includes("WHERE name = 'Each'")) return { rows: [{ id: 'uom-each' }] };
      if (text.includes('min_days_before_expiry_sale') || text.includes('product_valuation')) {
        return { rows: [{ min_days: 0, cost_price: '60', average_cost: '0' }] };
      }
      if (text.includes('FROM inventory_batches')) {
        return {
          rows: [{
            id: 'batch-1',
            batch_number: 'B1',
            product_id: 'prod-uuid-1',
            remaining_quantity: '10',
            cost_price: '60',
            expiry_date: '2099-01-01',
            received_date: '2026-01-01',
            created_at: '2026-01-01',
          }],
        };
      }
      if (text.includes('FROM product_uoms')) return { rows: [{ max_factor: '1' }] };
      if (text.includes('WHERE id = $1')) return { rows: [{ id: 'uom-base' }] };
      if (text.includes('FROM customers WHERE id = $1')) {
        return { rows: [{ credit_limit: 0, current_balance: 0 }] };
      }
      return { rows: [] };
    });

    mockSalesRepo.createSale.mockResolvedValue({
      id: 'sale-uuid-1',
      saleNumber: 'SALE-2026-0001',
      customerId: 'cust-uuid-1',
      saleDate: '2026-06-20',
      subtotal: 1000,
      taxAmount: 180,
      discountAmount: 0,
      totalAmount: 1180,
      totalCost: 600,
      profit: 400,
      profitMargin: 0.4,
      paymentMethod: 'CASH',
      paymentReceived: 1180,
      amountPaid: 1180,
      changeAmount: 0,
      cashierId: 'cashier-uuid-1',
      quoteId: 'quote-uuid-1',
      cashRegisterSessionId: 'session-uuid-1',
      createdAt: new Date('2026-06-20T08:00:00Z'),
    });
    mockSalesRepo.addSaleItems.mockResolvedValue([]);

    ({ quotationService } = await import('./quotationService.js'));
  });

  it('routes the sale header insert through salesRepository.createSale (SSOT)', async () => {
    await quotationService.convertQuotationToSale(mockPool, 'quote-uuid-1', {
      paymentOption: 'full',
      depositMethod: 'CASH',
      cashierId: 'cashier-uuid-1',
      cashRegisterSessionId: 'session-uuid-1',
    });

    expect(mockSalesRepo.createSale).toHaveBeenCalledTimes(1);
    const [client, saleData] = mockSalesRepo.createSale.mock.calls[0] as [PoolClient, Record<string, unknown>];
    expect(client).toBe(mockClient);

    // Critical SSOT fields that the OLD raw INSERT silently dropped:
    expect(saleData.idempotencyKey).toBe('QC:quote-uuid-1');
    expect(saleData.cashRegisterSessionId).toBe('session-uuid-1');
    expect(saleData.quoteId).toBe('quote-uuid-1');

    // Header amounts are sourced from the quote header (not recomputed from lines)
    expect(saleData.customerId).toBe('cust-uuid-1');
    expect(saleData.subtotal).toBe(1000);
    expect(saleData.taxAmount).toBe(180);
    expect(saleData.totalAmount).toBe(1180);

    // Cashier is taken from controller input (req.user.id), not request body
    expect(saleData.soldBy).toBe('cashier-uuid-1');
  });

  it('routes line inserts through salesRepository.addSaleItems with MUoM snapshot', async () => {
    await quotationService.convertQuotationToSale(mockPool, 'quote-uuid-1', {
      paymentOption: 'full',
      depositMethod: 'CASH',
      cashierId: 'cashier-uuid-1',
    });

    expect(mockSalesRepo.addSaleItems).toHaveBeenCalledTimes(1);
    const [client, items] = mockSalesRepo.addSaleItems.mock.calls[0] as [
      PoolClient,
      Array<Record<string, unknown>>,
    ];
    expect(client).toBe(mockClient);
    expect(items).toHaveLength(1);

    const line = items[0];
    expect(line.saleId).toBe('sale-uuid-1');
    expect(line.productId).toBe('prod-uuid-1');
    // MUoM snapshot persisted on every converted line (SAP discipline)
    expect(line.baseQty).toBe(10);
    expect(line.baseUomId).toBe('uom-base');
    expect(line.conversionFactor).toBe(1);
  });

  it('uses CREDIT payment method when paymentOption=none (credit sale)', async () => {
    await quotationService.convertQuotationToSale(mockPool, 'quote-uuid-1', {
      paymentOption: 'none',
      cashierId: 'cashier-uuid-1',
    });

    const [, saleData] = mockSalesRepo.createSale.mock.calls[0] as [PoolClient, Record<string, unknown>];
    expect(saleData.paymentMethod).toBe('CREDIT');
    expect(saleData.paymentReceived).toBe(0);
  });

  it('does not execute the legacy raw INSERT INTO sales subquery', async () => {
    await quotationService.convertQuotationToSale(mockPool, 'quote-uuid-1', {
      paymentOption: 'full',
      depositMethod: 'CASH',
      cashierId: 'cashier-uuid-1',
    });

    // The old path inlined: INSERT INTO sales ... (SELECT CONCAT('SALE-', ...
    const inlineInsertCall = (mockClient.query as jest.Mock).mock.calls.find((args) =>
      String(args[0]).includes('INSERT INTO sales'),
    );
    expect(inlineInsertCall).toBeUndefined();

    // And no per-line raw INSERT INTO sale_items
    const inlineSaleItemCall = (mockClient.query as jest.Mock).mock.calls.find((args) =>
      String(args[0]).includes('INSERT INTO sale_items'),
    );
    expect(inlineSaleItemCall).toBeUndefined();
  });

  it('still links QUOTATION→SALE document and marks quotation CONVERTED inside the same transaction', async () => {
    await quotationService.convertQuotationToSale(mockPool, 'quote-uuid-1', {
      paymentOption: 'full',
      depositMethod: 'CASH',
      cashierId: 'cashier-uuid-1',
    });

    expect(mockDocumentFlowService.linkDocuments).toHaveBeenCalledWith(
      mockClient,
      'QUOTATION',
      'quote-uuid-1',
      'SALE',
      'sale-uuid-1',
      'CREATED_FROM',
    );
    expect(mockQuotationRepo.markQuotationAsConverted).toHaveBeenCalledWith(
      mockClient,
      'quote-uuid-1',
      'sale-uuid-1',
      'inv-1',
    );
  });

  it('throws when conversion attempted on a WHOLESALE quotation (BR-QUOTE-010 preserved)', async () => {
    mockQuotationRepo.getQuotationById.mockResolvedValue({
      quotation: {
        id: 'quote-uuid-2',
        quote_number: 'QUOTE-2026-0002',
        customer_id: 'cust-uuid-1',
        fulfillment_mode: 'WHOLESALE',
        valid_until: '2030-01-01',
        subtotal: '1000',
        tax_amount: '0',
        discount_amount: '0',
        total_amount: '1000',
      },
      items: [],
    });

    await expect(
      quotationService.convertQuotationToSale(mockPool, 'quote-uuid-2', {
        paymentOption: 'full',
        depositMethod: 'CASH',
        cashierId: 'cashier-uuid-1',
      }),
    ).rejects.toThrow(/WHOLESALE/);

    expect(mockSalesRepo.createSale).not.toHaveBeenCalled();
  });

  // ==========================================================================
  // P0-C / P1: Validator SSOT routing (added after P0-A)
  // ==========================================================================

  it('enforces credit-limit via SalesBusinessRules.validateCreditSale on credit conversion', async () => {
    const { SalesBusinessRules } = (await import('../../middleware/businessRules.js')) as unknown as {
      SalesBusinessRules: { validateCreditSale: jest.Mock };
    };

    await quotationService.convertQuotationToSale(mockPool, 'quote-uuid-1', {
      paymentOption: 'none',
      cashierId: 'cashier-uuid-1',
    });

    expect(SalesBusinessRules.validateCreditSale).toHaveBeenCalledWith(
      mockClient,
      'cust-uuid-1',
      1180, // full total goes to credit
      'CREDIT',
    );
  });

  it('enforces credit-limit on partial-payment with outstanding balance', async () => {
    const { SalesBusinessRules } = (await import('../../middleware/businessRules.js')) as unknown as {
      SalesBusinessRules: { validateCreditSale: jest.Mock };
    };

    await quotationService.convertQuotationToSale(mockPool, 'quote-uuid-1', {
      paymentOption: 'partial',
      depositAmount: 500,
      depositMethod: 'CASH',
      cashierId: 'cashier-uuid-1',
    });

    // Outstanding = 1180 - 500 = 680
    expect(SalesBusinessRules.validateCreditSale).toHaveBeenCalledWith(
      mockClient,
      'cust-uuid-1',
      680,
      'CREDIT',
    );
  });

  it('skips credit-limit check on full-payment conversion (no outstanding)', async () => {
    const { SalesBusinessRules } = (await import('../../middleware/businessRules.js')) as unknown as {
      SalesBusinessRules: { validateCreditSale: jest.Mock };
    };

    await quotationService.convertQuotationToSale(mockPool, 'quote-uuid-1', {
      paymentOption: 'full',
      depositMethod: 'CASH',
      cashierId: 'cashier-uuid-1',
    });

    expect(SalesBusinessRules.validateCreditSale).not.toHaveBeenCalled();
  });

  it('runs validateProductActive and assertItemHasSellingPrice per regular product line', async () => {
    const { SalesBusinessRules } = (await import('../../middleware/businessRules.js')) as unknown as {
      SalesBusinessRules: { validateProductActive: jest.Mock };
    };
    const masterDataGuard = (await import('../../services/masterDataGuard.js')) as unknown as {
      assertItemHasSellingPrice: jest.Mock;
    };

    await quotationService.convertQuotationToSale(mockPool, 'quote-uuid-1', {
      paymentOption: 'full',
      depositMethod: 'CASH',
      cashierId: 'cashier-uuid-1',
    });

    expect(SalesBusinessRules.validateProductActive).toHaveBeenCalledWith(mockClient, 'prod-uuid-1');
    expect(masterDataGuard.assertItemHasSellingPrice).toHaveBeenCalledWith(mockClient, 'prod-uuid-1');
  });

  it('rejects conversion when quote unit price is below FEFO allocated carrying', async () => {
    mockQuotationRepo.getQuotationById.mockResolvedValue({
      quotation: {
        id: 'quote-uuid-1',
        quote_number: 'QUOTE-2026-0001',
        customer_id: 'cust-uuid-1',
        customer_name: 'Test Customer',
        fulfillment_mode: 'RETAIL',
        valid_until: '2030-01-01',
        subtotal: '10.00',
        tax_amount: '0.00',
        discount_amount: '0.00',
        total_amount: '10.00',
      },
      items: [
        {
          product_id: 'prod-uuid-1',
          description: 'Widget',
          quantity: '10',
          unit_price: '1.00',
          unit_cost: '60.00',
          uom_id: 'uom-base',
          uom_name: 'Each',
          line_total: '10.00',
        },
      ],
    });

    await expect(
      quotationService.convertQuotationToSale(mockPool, 'quote-uuid-1', {
        paymentOption: 'full',
        depositMethod: 'CASH',
        cashierId: 'cashier-uuid-1',
      }),
    ).rejects.toMatchObject({ errorCode: 'BELOW_ALLOCATED_COST' });
    expect(mockSalesRepo.createSale).not.toHaveBeenCalled();
  });

  // ==========================================================================
  // P0-B: Phase 2 is now atomic with Phase 1 — invoice failure rolls back sale
  // ==========================================================================

  it('propagates invoice-creation failure directly so the surrounding UnitOfWork rolls back the sale atomically', async () => {
    mockInvoiceService.createInvoice.mockRejectedValueOnce(new Error('AR posting blew up'));

    const err = await quotationService
      .convertQuotationToSale(mockPool, 'quote-uuid-1', {
        paymentOption: 'full',
        depositMethod: 'CASH',
        cashierId: 'cashier-uuid-1',
      })
      .catch((e: unknown) => e);

    // The underlying error propagates verbatim — no BR-QUOTE-PHASE2-FAIL wrapping
    // because we no longer have an "orphan sale" recovery scenario. The whole
    // UnitOfWork.run callback throws, so the transaction is rolled back atomically.
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('AR posting blew up');

    // markQuotationAsConverted now runs AFTER invoice creation, so an invoice
    // failure must prevent the quotation from ever being marked CONVERTED.
    expect(mockQuotationRepo.markQuotationAsConverted).not.toHaveBeenCalled();
  });
});
