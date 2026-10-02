/**
 * PROOF: Deposit refund restore SSOT — permanent anti-regression.
 *
 * Failure mode (historical / Blis):
 *   Sale used a customer deposit (pos_deposit_applications + DEPOSIT_APPLICATION JE:
 *   DR 2200 / CR AR). Full return via refundSale:
 *     - never restored the deposit balance
 *     - never reversed the application journal
 *     - CASH-header refund credited cash for the whole amount
 *     - DEPOSIT-header refund credited 2200 a second time
 *   Result: customer deposit stayed DEPLETED/used while cash left the till,
 *   or liability 2200 moved without the deposit subledger (or the reverse).
 *
 * SSOT (locked going forward):
 *   1) restoreSaleDepositApplicationsInTransaction runs INSIDE the refund/void
 *      UnitOfWork BEFORE recordSaleRefundToGL / recordSaleVoidToGL.
 *   2) Balance moves only when the matching DEPOSIT_APPLICATION journal moves.
 *   3) Refund credits AR for depositRestoredAmount; tender credit = remainder.
 *      Never credit 2200 again on the refund when the application was restored.
 *   4) DEPOSIT-method tender with zero restore credits AR (sale parked on AR),
 *      never 2200.
 *   5) Historical cash-refunded applications without heal stay as-is
 *      (no journal → leave subledger; do not invent 2200).
 *
 * npm test -- --runInBand src/services/depositRefundRestoreSsot.evidence.test.ts
 */
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JournalEntryRequest, JournalLine } from './accountingCore.js';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = path.resolve(serverRoot, '..');

type Gate = { id: string; ok: boolean; detail: string };
const gates: Gate[] = [];

function gate(id: string, ok: boolean, detail: string): void {
  gates.push({ id, ok, detail });
  if (!ok) expect({ id, ok, detail }).toEqual({ id, ok: true, detail });
}

function readRepo(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

function sliceFn(src: string, marker: string, nextMarker?: string): string {
  const start = src.indexOf(marker);
  if (start < 0) return '';
  const from = start;
  const end = nextMarker ? src.indexOf(nextMarker, from + marker.length) : -1;
  return end < 0 ? src.slice(from) : src.slice(from, end);
}

type MockFn = (...args: unknown[]) => Promise<unknown>;

const capturedEntries: JournalEntryRequest[] = [];
const createJournalEntryMock = jest.fn<MockFn>(async (request: unknown) => {
  capturedEntries.push(request as JournalEntryRequest);
  return {
    transactionId: 'txn-partial',
    transactionNumber: 'TXN-P',
    status: 'POSTED',
    totalDebits: 0,
    totalCredits: 0,
  };
});
const reverseTransactionMock = jest.fn<MockFn>(async () => ({
  transactionId: 'txn-rev',
  transactionNumber: 'TXN-R',
  status: 'POSTED',
  totalDebits: 0,
  totalCredits: 0,
}));

jest.unstable_mockModule('./accountingCore.js', () => ({
  AccountingCore: {
    createJournalEntry: createJournalEntryMock,
    reverseTransaction: reverseTransactionMock,
  },
  AccountingError: class extends Error {
    constructor(msg: string, public readonly code: string) {
      super(msg);
      this.name = 'AccountingError';
    }
  },
}));

jest.unstable_mockModule('../db/pool.js', () => ({
  pool: { query: jest.fn<MockFn>() },
  default: { query: jest.fn<MockFn>() },
}));

jest.unstable_mockModule('../utils/logger.js', () => ({
  default: {
    info: jest.fn<MockFn>(),
    error: jest.fn<MockFn>(),
    warn: jest.fn<MockFn>(),
    debug: jest.fn<MockFn>(),
  },
}));

jest.unstable_mockModule('../utils/constants.js', () => ({
  SYSTEM_USER_ID: 'system-user',
}));

const { planDepositRefundCredits, recordSaleRefundToGL, AccountCodes } = await import('./glEntryService.js');
const { restoreSaleDepositApplicationsInTransaction } = await import('../modules/deposits/depositsService.js');

function creditsTo(lines: JournalLine[], code: string): number {
  return lines
    .filter((line) => line.accountCode === code)
    .reduce((sum, line) => sum + line.creditAmount, 0);
}

function assertBalanced(lines: JournalLine[]): boolean {
  const d = lines.reduce((s, l) => s + l.debitAmount, 0);
  const c = lines.reduce((s, l) => s + l.creditAmount, 0);
  return Math.abs(d - c) < 0.001;
}

describe('PROOF deposit refund restore SSOT', () => {
  beforeEach(() => {
    capturedEntries.length = 0;
    createJournalEntryMock.mockClear();
    reverseTransactionMock.mockClear();
  });

  it('source: refund restores deposits before refund GL and passes restored amount', () => {
    const sales = readRepo('SamplePOS.Server/src/modules/sales/salesService.ts');
    const body = sliceFn(sales, 'async refundSale(', '\n  async ');
    const restoreAt = body.indexOf('restoreSaleDepositApplicationsInTransaction');
    const journalAt = body.indexOf('recordSaleRefundToGL');
    gate('REFUND_CALLS_RESTORE', restoreAt > 0, 'refundSale calls restoreSaleDepositApplicationsInTransaction');
    gate('REFUND_RESTORE_BEFORE_GL', journalAt > restoreAt, 'restore runs before recordSaleRefundToGL');
    gate(
      'REFUND_PASSES_RESTORED',
      body.includes('depositRestoredAmount: depositRestore.restored'),
      'refund GL receives depositRestore.restored',
    );
    gate(
      'REFUND_RESTORE_NOT_OWN_UOW',
      !/reverseDepositsForSale\s*\(/.test(body),
      'refund must not call reverseDepositsForSale (own UnitOfWork)',
    );
  });

  it('source: deposit-method void restores before sale void GL', () => {
    const sales = readRepo('SamplePOS.Server/src/modules/sales/salesService.ts');
    const body = sliceFn(sales, 'async voidSale(', '\n  async ');
    const restoreAt = body.indexOf('restoreSaleDepositApplicationsInTransaction');
    const journalAt = body.indexOf('recordSaleVoidToGL');
    gate('VOID_DEPOSIT_GUARD', body.includes("sale.payment_method === 'DEPOSIT'"), 'void restore only for DEPOSIT tender');
    gate('VOID_CALLS_RESTORE', restoreAt > 0, 'voidSale calls restore for DEPOSIT sales');
    gate('VOID_RESTORE_BEFORE_GL', journalAt > restoreAt, 'restore runs before recordSaleVoidToGL');
  });

  it('source: restore helper moves journal with balance; skips orphan apps', () => {
    const svc = readRepo('SamplePOS.Server/src/modules/deposits/depositsService.ts');
    const body = sliceFn(svc, 'export async function restoreSaleDepositApplicationsInTransaction', 'export async function reverseDepositsForSale');
    gate('RESTORE_FN_EXISTS', body.length > 0, 'restoreSaleDepositApplicationsInTransaction exported');
    gate('RESTORE_USES_REVERSE_TX', body.includes('AccountingCore.reverseTransaction'), 'full restore reverses DEPOSIT_APPLICATION JE');
    gate('RESTORE_PARTIAL_JE', body.includes('DEPOSIT_APPLICATION_REVERSAL'), 'partial restore posts balanced reverse slice');
    gate('RESTORE_SKIP_NO_JOURNAL', body.includes('no unreversed journal'), 'no journal → leave deposit used');
    gate('RESTORE_NEWEST_FIRST', /ORDER BY a\.applied_at DESC/.test(body), 'newest applications restored first');
    gate(
      'REVERSE_FOR_SALE_USES_RESTORE',
      /reverseDepositsForSale[\s\S]{0,800}restoreSaleDepositApplicationsInTransaction/.test(svc),
      'reverseDepositsForSale delegates to in-tx restore (GL+balance)',
    );
  });

  it('source: refund credit plan + DEPOSIT tender never double-credits 2200', () => {
    const gl = readRepo('SamplePOS.Server/src/services/glEntryService.ts');
    gate('PLAN_FN_EXPORTED', gl.includes('export function planDepositRefundCredits'), 'planDepositRefundCredits exported');
    gate('SALE_REFUND_DATA_RESTORED', gl.includes('depositRestoredAmount?: number'), 'SaleRefundData carries depositRestoredAmount');
    const tender = sliceFn(gl, 'function buildTenderRefundCreditLines', 'export interface SaleRefundData');
    gate(
      'DEPOSIT_TENDER_CREDITS_AR_NOT_2200',
      /paymentMethod === 'DEPOSIT'[\s\S]{0,500}customerArLine/.test(tender) &&
        !/case 'DEPOSIT':[\s\S]{0,120}CUSTOMER_DEPOSITS/.test(tender),
      'DEPOSIT refund tender credits AR via customerArLine; no case DEPOSIT → 2200',
    );
  });

  it('runtime: credit split math', () => {
    gate(
      'SPLIT_FULL_DEPOSIT',
      JSON.stringify(planDepositRefundCredits(275000, 275000)) === JSON.stringify({ depositBack: 275000, tender: 0 }),
      'full deposit restore → tender 0',
    );
    gate(
      'SPLIT_PARTIAL',
      JSON.stringify(planDepositRefundCredits(100, 40)) === JSON.stringify({ depositBack: 40, tender: 60 }),
      'partial restore → AR 40 + tender 60',
    );
    gate(
      'SPLIT_NONE',
      JSON.stringify(planDepositRefundCredits(100, 0)) === JSON.stringify({ depositBack: 0, tender: 100 }),
      'no restore → all tender',
    );
    gate(
      'SPLIT_CAP',
      JSON.stringify(planDepositRefundCredits(50, 80)) === JSON.stringify({ depositBack: 50, tender: 0 }),
      'restore capped to refund total',
    );
  });

  it('runtime: full deposit refund credits AR only (never cash, never second 2200)', async () => {
    const tx = { query: async () => ({ rows: [{ Id: 'sale-tx' }] }) };
    await recordSaleRefundToGL({
      refundId: 'ref-1',
      refundNumber: 'REF-1',
      saleId: 'sale-1',
      saleNumber: 'SALE-1',
      refundDate: '2026-10-02',
      reason: 'Returned',
      totalAmount: 275000,
      totalCost: 0,
      paymentMethod: 'DEPOSIT',
      customerId: 'cust-1',
      depositRestoredAmount: 275000,
    }, undefined, tx as never);

    const lines = capturedEntries[0].lines;
    gate('JE_FULL_AR', creditsTo(lines, AccountCodes.ACCOUNTS_RECEIVABLE) === 275000, 'CR AR = restored');
    gate('JE_FULL_NO_CASH', creditsTo(lines, AccountCodes.CASH) === 0, 'no cash credit');
    gate('JE_FULL_NO_2200', creditsTo(lines, AccountCodes.CUSTOMER_DEPOSITS) === 0, 'no second 2200 credit');
    gate('JE_FULL_BALANCED', assertBalanced(lines), 'DR=CR');
  });

  it('runtime: cash sale partial deposit restore splits AR + cash', async () => {
    const tx = { query: async () => ({ rows: [{ Id: 'sale-tx' }] }) };
    await recordSaleRefundToGL({
      refundId: 'ref-2',
      refundNumber: 'REF-2',
      saleId: 'sale-2',
      saleNumber: 'SALE-2',
      refundDate: '2026-10-02',
      reason: 'Returned',
      totalAmount: 100,
      totalCost: 0,
      paymentMethod: 'CASH',
      customerId: 'cust-1',
      depositRestoredAmount: 40,
    }, undefined, tx as never);

    const lines = capturedEntries[0].lines;
    gate('JE_MIX_AR', creditsTo(lines, AccountCodes.ACCOUNTS_RECEIVABLE) === 40, 'CR AR = restored slice');
    gate('JE_MIX_CASH', creditsTo(lines, AccountCodes.CASH) === 60, 'CR cash = remainder');
    gate('JE_MIX_NO_2200', creditsTo(lines, AccountCodes.CUSTOMER_DEPOSITS) === 0, 'refund JE does not credit 2200');
    gate('JE_MIX_BALANCED', assertBalanced(lines), 'DR=CR');
  });

  it('runtime: DEPOSIT tender with zero restore still credits AR not 2200', async () => {
    const tx = { query: async () => ({ rows: [{ Id: 'sale-tx' }] }) };
    await recordSaleRefundToGL({
      refundId: 'ref-3',
      refundNumber: 'REF-3',
      saleId: 'sale-3',
      saleNumber: 'SALE-3',
      refundDate: '2026-10-02',
      reason: 'Returned',
      totalAmount: 100,
      totalCost: 0,
      paymentMethod: 'DEPOSIT',
      customerId: 'cust-1',
      depositRestoredAmount: 0,
    }, undefined, tx as never);

    const lines = capturedEntries[0].lines;
    gate('JE_ZERO_RESTORE_AR', creditsTo(lines, AccountCodes.ACCOUNTS_RECEIVABLE) === 100, 'CR AR');
    gate('JE_ZERO_RESTORE_NO_2200', creditsTo(lines, AccountCodes.CUSTOMER_DEPOSITS) === 0, 'never CR 2200 on refund JE');
  });

  it('runtime: restore reverses JE + deletes app when journal exists', async () => {
    const sql: string[] = [];
    const client = {
      query: async (text: string) => {
        sql.push(text);
        if (text.includes('FROM pos_deposit_applications a')) {
          return {
            rows: [{
              id: 'app-1',
              amount_applied: '275000.00',
              customer_id: 'cust-1',
              deposit_number: 'DEP-1',
            }],
          };
        }
        if (text.includes("ReferenceType\" = 'DEPOSIT_APPLICATION'")) {
          return { rows: [{ Id: 'txn-app' }] };
        }
        if (text.includes('SELECT * FROM pos_deposit_applications')) {
          return {
            rows: [{
              id: 'app-1',
              amount_applied: '275000.00',
              deposit_id: 'dep-1',
            }],
          };
        }
        return { rows: [] };
      },
    };

    const result = await restoreSaleDepositApplicationsInTransaction(client as never, {} as never, {
      saleId: 'sale-1',
      amount: 275000,
      reversalDate: '2026-10-02',
      reason: 'Refund',
      userId: 'user-1',
    });

    gate('RESTORE_RESULT_FULL', result.restored === 275000 && result.applications === 1, JSON.stringify(result));
    gate('RESTORE_CALLS_REVERSE', reverseTransactionMock.mock.calls.length === 1, 'AccountingCore.reverseTransaction once');
    gate(
      'RESTORE_IDEM_KEY',
      (reverseTransactionMock.mock.calls[0]?.[0] as { idempotencyKey?: string })?.idempotencyKey ===
        'DEPOSIT_APP_RESTORE-app-1',
      'idempotency DEPOSIT_APP_RESTORE-{appId}',
    );
    gate('RESTORE_DELETES_APP', sql.some((t) => t.includes('DELETE FROM pos_deposit_applications')), 'application row removed');
  });

  it('runtime: no journal → leave deposit used (historical Blis-safe)', async () => {
    const sql: string[] = [];
    const client = {
      query: async (text: string) => {
        sql.push(text);
        if (text.includes('FROM pos_deposit_applications a')) {
          return {
            rows: [{
              id: 'app-orphan',
              amount_applied: '275000.00',
              customer_id: 'cust-1',
              deposit_number: 'DEP-1',
            }],
          };
        }
        return { rows: [] };
      },
    };

    const result = await restoreSaleDepositApplicationsInTransaction(client as never, {} as never, {
      saleId: 'sale-1',
      amount: 275000,
      reversalDate: '2026-10-02',
      reason: 'Refund',
      userId: 'user-1',
    });

    gate('ORPHAN_NO_RESTORE', result.restored === 0 && result.applications === 0, JSON.stringify(result));
    gate('ORPHAN_NO_REVERSE', reverseTransactionMock.mock.calls.length === 0, 'no reverseTransaction');
    gate(
      'ORPHAN_NO_DELETE',
      !sql.some((t) => t.includes('DELETE FROM pos_deposit_applications')),
      'orphan application left in place',
    );
  });

  it('runtime: partial restore posts DR AR / CR 2200 and reduces application', async () => {
    const sql: string[] = [];
    const client = {
      query: async (text: string) => {
        sql.push(text);
        if (text.includes('FROM pos_deposit_applications a')) {
          return {
            rows: [{
              id: 'app-1',
              amount_applied: '275000.00',
              customer_id: 'cust-1',
              deposit_number: 'DEP-1',
            }],
          };
        }
        if (text.includes("ReferenceType\" = 'DEPOSIT_APPLICATION'")) {
          return { rows: [{ Id: 'txn-app' }] };
        }
        if (text.includes('SELECT amount_applied, deposit_id')) {
          return { rows: [{ amount_applied: '275000.00', deposit_id: 'dep-1' }] };
        }
        return { rows: [] };
      },
    };

    const result = await restoreSaleDepositApplicationsInTransaction(client as never, {} as never, {
      saleId: 'sale-1',
      amount: 100,
      reversalDate: '2026-10-02',
      reason: 'Partial refund',
      userId: 'user-1',
    });

    const posted = capturedEntries[0];
    gate('PARTIAL_RESULT', result.restored === 100 && result.applications === 1, JSON.stringify(result));
    gate('PARTIAL_NO_FULL_REVERSE', reverseTransactionMock.mock.calls.length === 0, 'partial does not reverse whole JE');
    gate('PARTIAL_SOURCE', posted?.source === 'SYSTEM_CORRECTION', `source=${posted?.source}`);
    gate('PARTIAL_CR_2200', creditsTo(posted.lines, AccountCodes.CUSTOMER_DEPOSITS) === 100, 'CR 2200 = slice');
    gate(
      'PARTIAL_DR_AR',
      posted.lines.find((l) => l.accountCode === AccountCodes.ACCOUNTS_RECEIVABLE)?.debitAmount === 100,
      'DR AR = slice',
    );
    gate('PARTIAL_BALANCED', assertBalanced(posted.lines), 'DR=CR');
    gate('PARTIAL_REDUCES_APP', sql.some((t) => t.includes('UPDATE pos_deposit_applications')), 'amount_applied reduced');
  });

  it('anti-regression: old bug shapes must stay impossible in source', () => {
    const gl = readRepo('SamplePOS.Server/src/services/glEntryService.ts');
    const tender = sliceFn(gl, 'function buildTenderRefundCreditLines', 'export interface SaleRefundData');
    // Historical: case 'DEPOSIT': creditAccountCode = CUSTOMER_DEPOSITS on refund tender
    gate(
      'BUG_NO_DEPOSIT_CASE_2200',
      !/case\s+'DEPOSIT'\s*:[\s\S]{0,200}CUSTOMER_DEPOSITS/.test(tender),
      'removed: DEPOSIT refund tender → CR 2200',
    );
    const sales = readRepo('SamplePOS.Server/src/modules/sales/salesService.ts');
    const refundBody = sliceFn(sales, 'async refundSale(', '\n  async ');
    gate(
      'BUG_REFUND_MUST_RESTORE',
      refundBody.includes('restoreSaleDepositApplicationsInTransaction'),
      'refund without restore is forbidden',
    );
  });
});

afterAll(() => {
  const pass = gates.filter((g) => g.ok).length;
  const fail = gates.filter((g) => !g.ok).length;
  const verdict = fail === 0 ? 'PASS' : 'FAIL';
  const at = new Date().toISOString();
  const evidence = {
    at,
    feature: 'DEPOSIT_REFUND_RESTORE_SSOT',
    historicalBug: {
      tenants: ['pos_tenant_blis'],
      symptom:
        'Full return of a deposit-applied sale left pos_deposit_applications in place; CASH refund paid till cash; DEPOSIT refund could credit 2200 twice; deposit available and account 2200 diverged',
      cause:
        'refundSale/voidSale never called deposit reverse; reverseDepositsForSale existed but had zero callers and did not reverse GL; buildTenderRefundCreditLines credited 2200 for DEPOSIT tender',
      doNotHeal:
        'Blis SALE-2026-1812 / SALE-2026-2053 already cash-refunded — restoring those deposits would double-pay. Orphan apps (no JE) stay used.',
    },
    ssot: {
      restore: 'restoreSaleDepositApplicationsInTransaction on refund/void client before GL',
      journalCouple: 'subledger moves only with DEPOSIT_APPLICATION reverse (or partial DR AR / CR 2200)',
      refundCredits: 'CR AR for depositRestoredAmount; tender = remainder; never second CR 2200',
      depositTender: 'DEPOSIT paymentMethod refund credits AR (sale parked on AR), not 2200',
    },
    summary: { pass, fail, total: gates.length, verdict },
    gates,
  };

  const md = `# PROOF — Deposit refund restore SSOT

**Generated:** ${at}  
**Verdict:** **${verdict}** (${pass}/${gates.length} gates)

## Why this proof exists

Returning a sale that had consumed a customer deposit used to:

1. Leave \`pos_deposit_applications\` and \`amount_used\` in place  
2. Pay cash from the till for the whole refund (CASH header), **or** credit Customer Deposits (2200) again (DEPOSIT header)  
3. Leave deposit availability and liability 2200 inconsistent going forward  

That must **never** happen on new refunds/voids.

## Permanent SSOT

| Step | Rule |
|------|------|
| Refund / DEPOSIT void | Call \`restoreSaleDepositApplicationsInTransaction\` **inside** the same UnitOfWork **before** sale refund/void GL |
| Restore | Reverse \`DEPOSIT_APPLICATION\` JE (or post partial DR AR / CR 2200) **and** put the same amount back on the deposit |
| No JE | Leave application used — do not invent 2200 (protects historical cash refunds) |
| Refund JE | Credit **AR** for \`depositRestoredAmount\`; credit original tender only for the remainder; **never** credit 2200 again |

## Guarantees locked by gates

1. \`refundSale\` restores before \`recordSaleRefundToGL\` and passes \`depositRestoredAmount\`  
2. \`voidSale\` restores for DEPOSIT tender before \`recordSaleVoidToGL\`  
3. Full deposit refund → CR AR only (no cash, no second 2200)  
4. Mixed restore → CR AR + CR cash remainder  
5. Orphan application (no journal) → zero restore, row kept  
6. Removed historical DEPOSIT tender → CR 2200 path  

## Gates

| Gate | Result | Detail |
|------|--------|--------|
${gates.map((g) => `| \`${g.id}\` | ${g.ok ? 'PASS' : 'FAIL'} | ${g.detail.replace(/\|/g, '\\\\|')} |`).join('\n')}

## Re-run

\`\`\`bash
cd SamplePOS.Server
npm test -- --runInBand src/services/depositRefundRestoreSsot.evidence.test.ts
\`\`\`

Do **not** data-heal Blis SALE-2026-1812 / SALE-2026-2053 (cash already paid).
`;

  writeFileSync(path.join(repoRoot, 'PROOF_DEPOSIT_REFUND_RESTORE_SSOT.json'), JSON.stringify(evidence, null, 2));
  writeFileSync(path.join(repoRoot, 'PROOF_DEPOSIT_REFUND_RESTORE_SSOT.md'), md);
});
