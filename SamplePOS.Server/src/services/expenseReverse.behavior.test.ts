/**
 * Expense reverse uses AccountingCore.reverseTransaction (immutable original GL).
 * After reverse: no leftover posted journals, net-active GL = 0.
 * Executed behavior — not grep-only.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

type MockFn = (...args: unknown[]) => Promise<unknown>;

const mockExpenseRepo = {
  getExpenseById: jest.fn<MockFn>(),
  markExpenseReversed: jest.fn<MockFn>(),
};

const reverseTransaction = jest.fn<MockFn>().mockResolvedValue({ transactionId: 'rev-1' });

jest.unstable_mockModule('../repositories/expenseRepository.js', () => ({
  getExpenseById: mockExpenseRepo.getExpenseById,
  markExpenseReversed: mockExpenseRepo.markExpenseReversed,
}));

jest.unstable_mockModule('../db/pool.js', () => ({
  pool: { query: jest.fn<MockFn>().mockResolvedValue({ rows: [] }) },
}));

const mockClient = {
  query: jest.fn<MockFn>(),
};

jest.unstable_mockModule('../db/unitOfWork.js', () => ({
  UnitOfWork: {
    run: jest.fn(async (_pool: unknown, fn: (client: unknown) => Promise<unknown>) => fn(mockClient)),
  },
}));

jest.unstable_mockModule('../middleware/errorHandler.js', () => ({
  BusinessError: class extends Error {
    errorCode: string;
    constructor(msg: string, code: string) {
      super(msg);
      this.name = 'BusinessError';
      this.errorCode = code;
    }
  },
  NotFoundError: class extends Error {
    constructor(msg: string) {
      super(`${msg} not found`);
      this.name = 'NotFoundError';
    }
  },
  ValidationError: class extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = 'ValidationError';
    }
  },
}));

jest.unstable_mockModule('./accountingCore.js', () => ({
  AccountingCore: { reverseTransaction },
}));

jest.unstable_mockModule('./glEntryService.js', () => ({
  recordExpenseApprovalToGL: jest.fn<MockFn>(),
  recordExpensePaymentToGL: jest.fn<MockFn>(),
}));

jest.unstable_mockModule('./bankingService.js', () => ({
  BankingService: { createFromExpense: jest.fn<MockFn>() },
}));

jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('../utils/dateRange.js', () => ({
  getBusinessDate: () => '2026-09-23',
}));

jest.unstable_mockModule('../modules/notifications/notificationPublisher.js', () => ({
  publishNotificationEvent: jest.fn(),
}));

jest.unstable_mockModule('../modules/notifications/businessNotificationPayload.js', () => ({
  buildBusinessNotificationPayload: () => ({}),
  expenseDetailLabel: () => 'expense',
}));

const { reverseExpense } = await import('./expenseService.js');

type JournalRow = { Id: string; ReferenceType: string };
type BankRow = {
  id: string;
  gl_transaction_id: string | null;
  is_reconciled: boolean;
  is_reversed: boolean;
};

function installClient(opts: {
  journals?: JournalRow[];
  leftover?: JournalRow[];
  bankExists?: boolean;
  bankGl?: JournalRow[];
  leftoverBankGl?: JournalRow[];
  banks?: BankRow[];
  residual?: Array<{ AccountCode: string; net: string }>;
}) {
  let journalCalls = 0;
  let bankGlCalls = 0;
  mockClient.query.mockImplementation(async (sql: unknown) => {
    const s = String(sql);
    if (s.includes("table_name = 'bank_transactions'")) {
      return { rows: [{ exists: Boolean(opts.bankExists) }] };
    }
    if (s.includes('HAVING ABS')) {
      return { rows: opts.residual ?? [] };
    }
    if (s.includes('UPDATE bank_transactions')) {
      return { rows: [] };
    }
    if (s.includes('FROM bank_transactions') && s.includes('JOIN ledger_transactions')) {
      bankGlCalls += 1;
      return {
        rows: bankGlCalls === 1 ? (opts.bankGl ?? []) : (opts.leftoverBankGl ?? []),
      };
    }
    if (s.includes('FROM bank_transactions') && s.includes('source_type')) {
      return { rows: opts.banks ?? [] };
    }
    if (s.includes('EXPENSE_PAYMENT')) {
      journalCalls += 1;
      return { rows: journalCalls === 1 ? (opts.journals ?? []) : (opts.leftover ?? []) };
    }
    return { rows: [] };
  });
}

describe('reverseExpense', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockClient.query.mockReset();
    mockExpenseRepo.markExpenseReversed.mockResolvedValue({
      id: 'e1',
      status: 'REVERSED',
      expenseNumber: 'EXP-202609-7779',
    });
  });

  it('rejects draft (nothing posted)', async () => {
    mockExpenseRepo.getExpenseById.mockResolvedValue({
      id: 'e1',
      status: 'DRAFT',
      expenseNumber: 'EXP-1',
    });
    await expect(reverseExpense('e1', 'u1', 'mistaken entry')).rejects.toMatchObject({
      errorCode: 'ERR_EXPENSE_013',
    });
    expect(reverseTransaction).not.toHaveBeenCalled();
  });

  it('rejects double reverse', async () => {
    mockExpenseRepo.getExpenseById.mockResolvedValue({
      id: 'e1',
      status: 'REVERSED',
      expenseNumber: 'EXP-1',
    });
    await expect(reverseExpense('e1', 'u1', 'mistaken entry')).rejects.toMatchObject({
      errorCode: 'ERR_EXPENSE_012',
    });
    expect(reverseTransaction).not.toHaveBeenCalled();
  });

  it('requires a reason', async () => {
    await expect(reverseExpense('e1', 'u1', '  ')).rejects.toThrow(/reason/i);
    expect(reverseTransaction).not.toHaveBeenCalled();
  });

  it('reverses payment then recognition GL via AccountingCore.reverseTransaction', async () => {
    mockExpenseRepo.getExpenseById.mockResolvedValue({
      id: 'e1',
      status: 'PAID',
      expenseNumber: 'EXP-202609-7779',
      amount: 56050,
    });
    installClient({
      journals: [
        { Id: 'pay-gl', ReferenceType: 'EXPENSE_PAYMENT' },
        { Id: 'appr-gl', ReferenceType: 'EXPENSE' },
      ],
      leftover: [],
      residual: [],
    });

    const result = await reverseExpense('e1', 'u1', 'Paid from the wrong account');
    expect(result?.status).toBe('REVERSED');
    expect(reverseTransaction).toHaveBeenCalledTimes(2);
    expect(reverseTransaction.mock.calls[0][0]).toMatchObject({
      originalTransactionId: 'pay-gl',
      idempotencyKey: 'REV-EXPENSE_PAYMENT-e1',
    });
    expect(reverseTransaction.mock.calls[1][0]).toMatchObject({
      originalTransactionId: 'appr-gl',
      idempotencyKey: 'REV-EXPENSE-e1',
    });
    expect(mockExpenseRepo.markExpenseReversed).toHaveBeenCalledWith(
      'e1',
      { reversedBy: 'u1', reversalReason: 'Paid from the wrong account' },
      mockClient
    );
  });

  it('reverses linked BANK_TXN GL with the expense journals', async () => {
    mockExpenseRepo.getExpenseById.mockResolvedValue({
      id: 'e1',
      status: 'PAID',
      expenseNumber: 'EXP-9',
      amount: 100,
    });
    installClient({
      bankExists: true,
      journals: [
        { Id: 'pay-gl', ReferenceType: 'EXPENSE_PAYMENT' },
        { Id: 'appr-gl', ReferenceType: 'EXPENSE' },
      ],
      bankGl: [{ Id: 'bank-gl', ReferenceType: 'BANK_TXN' }],
      leftover: [],
      leftoverBankGl: [],
      residual: [],
      banks: [
        {
          id: 'bt-1',
          gl_transaction_id: 'bank-gl',
          is_reconciled: false,
          is_reversed: false,
        },
      ],
    });

    await reverseExpense('e1', 'u1', 'wrong bank');
    expect(reverseTransaction).toHaveBeenCalledTimes(3);
    expect(reverseTransaction.mock.calls.map((c) => (c[0] as { originalTransactionId: string }).originalTransactionId)).toEqual(
      ['pay-gl', 'appr-gl', 'bank-gl']
    );
    expect(reverseTransaction.mock.calls[2][0]).toMatchObject({
      originalTransactionId: 'bank-gl',
      idempotencyKey: 'REV-EXPENSE-BANK-bt-1',
    });
    expect(mockExpenseRepo.markExpenseReversed).toHaveBeenCalled();
  });

  it('fails closed when posted status has no GL', async () => {
    mockExpenseRepo.getExpenseById.mockResolvedValue({
      id: 'e1',
      status: 'APPROVED',
      expenseNumber: 'EXP-1',
    });
    installClient({ journals: [], leftover: [] });
    await expect(reverseExpense('e1', 'u1', 'wrong amount')).rejects.toMatchObject({
      errorCode: 'ERR_EXPENSE_014',
    });
    expect(reverseTransaction).not.toHaveBeenCalled();
    expect(mockExpenseRepo.markExpenseReversed).not.toHaveBeenCalled();
  });

  it('fails closed when a posted journal remains after reverse', async () => {
    mockExpenseRepo.getExpenseById.mockResolvedValue({
      id: 'e1',
      status: 'PAID',
      expenseNumber: 'EXP-1',
    });
    installClient({
      journals: [{ Id: 'pay-gl', ReferenceType: 'EXPENSE_PAYMENT' }],
      leftover: [{ Id: 'bank-gl', ReferenceType: 'BANK_TXN' }],
      residual: [],
    });
    await expect(reverseExpense('e1', 'u1', 'wrong amount')).rejects.toMatchObject({
      errorCode: 'ERR_EXPENSE_016',
    });
    expect(reverseTransaction).toHaveBeenCalledTimes(1);
    expect(mockExpenseRepo.markExpenseReversed).not.toHaveBeenCalled();
  });

  it('fails closed when net-active GL is not zero after reverse', async () => {
    mockExpenseRepo.getExpenseById.mockResolvedValue({
      id: 'e1',
      status: 'PAID',
      expenseNumber: 'EXP-1',
    });
    installClient({
      journals: [{ Id: 'appr-gl', ReferenceType: 'EXPENSE' }],
      leftover: [],
      residual: [{ AccountCode: '6400', net: '100.00' }],
    });
    await expect(reverseExpense('e1', 'u1', 'wrong amount')).rejects.toMatchObject({
      errorCode: 'ERR_EXPENSE_016',
    });
    expect(mockExpenseRepo.markExpenseReversed).not.toHaveBeenCalled();
  });
});
