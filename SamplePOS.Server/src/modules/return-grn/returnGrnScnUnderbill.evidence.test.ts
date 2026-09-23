/**
 * PROOF: Return SCN under-bill ceiling (Henber 88004 goods vs 88000 AP).
 *
 * npm run proof:scn-underbill-return
 */
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JournalEntryRequest, JournalLine } from '../../services/accountingCore.js';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const repoRoot = path.resolve(serverRoot, '..');

type Gate = { id: string; ok: boolean; detail: string };
const gates: Gate[] = [];

function gate(id: string, ok: boolean, detail: string): void {
  gates.push({ id, ok, detail });
  if (!ok) {
    expect({ id, ok, detail }).toEqual({ id, ok: true, detail });
  }
}

function readRel(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

type MockFn = (...args: unknown[]) => Promise<unknown>;

let capturedEntries: JournalEntryRequest[] = [];
const createJournalEntryMock = jest.fn<MockFn>(async (request: unknown) => {
  capturedEntries.push(request as JournalEntryRequest);
  return {
    transactionId: 'txn-underbill',
    transactionNumber: 'TXN-UNDERBILL',
    status: 'POSTED',
    totalDebits: 0,
    totalCredits: 0,
  };
});

jest.unstable_mockModule('../../services/accountingCore.js', () => ({
  AccountingCore: {
    createJournalEntry: createJournalEntryMock,
    reverseTransaction: jest.fn<MockFn>(),
  },
  AccountingError: class extends Error {
    constructor(msg: string, public readonly code: string) {
      super(msg);
      this.name = 'AccountingError';
    }
  },
}));

jest.unstable_mockModule('../../db/pool.js', () => ({
  pool: { query: jest.fn<MockFn>() },
  default: { query: jest.fn<MockFn>() },
}));

jest.unstable_mockModule('../../utils/logger.js', () => ({
  default: {
    info: jest.fn<MockFn>(),
    error: jest.fn<MockFn>(),
    warn: jest.fn<MockFn>(),
    debug: jest.fn<MockFn>(),
  },
}));

jest.unstable_mockModule('../../utils/constants.js', () => ({
  SYSTEM_USER_ID: 'system-user',
}));

const { recordSupplierCreditNoteToGL, AccountCodes } = await import(
  '../../services/glEntryService.js'
);

const HENBER = {
  returnGoods: 88004,
  billTotal: 88000,
  billSubtotal: 88004,
  variance: 4,
} as const;

function findLine(lines: JournalLine[], code: string): JournalLine | undefined {
  return lines.find((l) => l.accountCode === code);
}

function sumSide(lines: JournalLine[], side: 'debit' | 'credit'): number {
  return lines.reduce(
    (s, l) => s + (side === 'debit' ? l.debitAmount : l.creditAmount),
    0,
  );
}

describe('PROOF SCN under-bill return — scenario math', () => {
  it('Henber numbers: return equals Subtotal and exceeds TotalAmount by 4', () => {
    gate(
      'SCENARIO_EXCEED_TOTAL',
      HENBER.returnGoods > HENBER.billTotal,
      `${HENBER.returnGoods} > AP ${HENBER.billTotal}`,
    );
    gate(
      'SCENARIO_WITHIN_SUBTOTAL',
      HENBER.returnGoods <= HENBER.billSubtotal,
      `${HENBER.returnGoods} ≤ Subtotal ${HENBER.billSubtotal}`,
    );
    gate(
      'SCENARIO_VARIANCE',
      HENBER.returnGoods - HENBER.billTotal === HENBER.variance,
      `PPV reverse ${HENBER.variance}`,
    );
  });
});

describe('PROOF SCN under-bill return — source SSOT', () => {
  it('createCreditNoteFromReturn caps AP and skips open-balance gate', () => {
    const svc = readRel('SamplePOS.Server/src/modules/return-grn/returnGrnService.ts');
    const block = svc.slice(
      svc.indexOf('async createCreditNoteFromReturn'),
      svc.indexOf('return { creditNoteId: postedScn.id'),
    );

    gate(
      'CAP_AT_BILL_TOTAL',
      block.includes('scnAmount = billTotal') && block.includes('billSubtotal'),
      'cap SCN when return ≤ Subtotal and > TotalAmount',
    );
    gate(
      'ERR_EXCEEDS_BILL_KEPT',
      block.includes('ERR_SCN_EXCEEDS_BILL'),
      'hard fail when return exceeds Subtotal too',
    );
    gate(
      'NO_OPEN_BALANCE_GATE',
      !block.includes('ERR_SCN_EXCEEDS_BILL_OPEN'),
      'paid bills allowed — on-account SCN',
    );
    gate(
      'HEADER_USES_SCN_AMOUNT',
      /totalAmount:\s*scnAmount/.test(block) && /subtotal:\s*scnAmount/.test(block),
      'SCN document amounts = capped AP',
    );
    gate(
      'GL_SPLIT_GOODS_VS_AP',
      /subtotal:\s*returnTotalNum/.test(block) && /totalAmount:\s*scnAmount/.test(block),
      'GL clearing = goods; AP = scnAmount',
    );
  });

  it('recordSupplierCreditNoteToGL posts Price Variance when goods ≠ AP', () => {
    const gl = readRel('SamplePOS.Server/src/services/glEntryService.ts');
    const fn = gl.slice(
      gl.indexOf('export async function recordSupplierCreditNoteToGL'),
      gl.indexOf('export async function recordSupplierDebitNoteToGL'),
    );
    gate(
      'GL_PPV_LINE',
      fn.includes('PRICE_VARIANCE') && fn.includes('varianceAmount'),
      'SCN GL balances under-bill via 5020',
    );
  });
});

describe('PROOF SCN under-bill return — GL posting', () => {
  beforeEach(() => {
    capturedEntries = [];
    createJournalEntryMock.mockClear();
  });

  it('posts DR AP 88000 + DR PPV 4 / CR clearing 88004 (balanced)', async () => {
    await recordSupplierCreditNoteToGL({
      noteId: 'scn-henber-underbill',
      noteNumber: 'SCN-PROOF-88000',
      noteDate: '2026-09-07',
      subtotal: HENBER.returnGoods,
      taxAmount: 0,
      totalAmount: HENBER.billTotal,
      supplierId: 'sup-top-medical',
      supplierName: 'TOP MEDICAL',
      clearingAccountCode: AccountCodes.GRIR_CLEARING,
    });

    expect(capturedEntries).toHaveLength(1);
    const lines = capturedEntries[0].lines;
    const ap = findLine(lines, AccountCodes.ACCOUNTS_PAYABLE);
    const clearing = findLine(lines, AccountCodes.GRIR_CLEARING);
    const ppv = findLine(lines, AccountCodes.PRICE_VARIANCE);
    const balanced = Math.abs(sumSide(lines, 'debit') - sumSide(lines, 'credit')) < 0.001;

    gate(
      'GL_AP_DEBIT',
      ap?.debitAmount === HENBER.billTotal,
      `AP debit ${ap?.debitAmount ?? 'missing'}`,
    );
    gate(
      'GL_CLEARING_CREDIT',
      clearing?.creditAmount === HENBER.returnGoods,
      `clearing credit ${clearing?.creditAmount ?? 'missing'}`,
    );
    gate(
      'GL_PPV_DEBIT',
      ppv?.debitAmount === HENBER.variance,
      `PPV debit ${ppv?.debitAmount ?? 'missing'}`,
    );
    gate('GL_BALANCED', balanced, `DR=${sumSide(lines, 'debit')} CR=${sumSide(lines, 'credit')}`);
    gate(
      'GL_NO_PURCHASE_RETURNS',
      !findLine(lines, AccountCodes.PURCHASE_RETURNS),
      'return path uses clearing not 5010',
    );
  });
});

afterAll(() => {
  const outMd = path.join(repoRoot, 'PROOF_SCN_UNDERBILL_RETURN.md');
  const outJson = path.join(repoRoot, 'PROOF_SCN_UNDERBILL_RETURN.json');
  const outServerJson = path.join(serverRoot, 'PROOF_SCN_UNDERBILL_RETURN.json');
  const outServerMd = path.join(serverRoot, 'PROOF_SCN_UNDERBILL_RETURN.md');
  const passed = gates.every((g) => g.ok);
  const payload = {
    proof: 'SCN_UNDERBILL_RETURN',
    passed,
    asOf: new Date().toISOString(),
    scenario: {
      label: 'Henber RGRN full return vs under-billed paid SI',
      returnGoods: HENBER.returnGoods,
      billSubtotal: HENBER.billSubtotal,
      billTotalAmount: HENBER.billTotal,
      scnApCap: HENBER.billTotal,
      priceVarianceReverse: HENBER.variance,
      priorError: 'ERR_SCN_EXCEEDS_BILL — Return credit note would exceed supplier bill total (88000.00)',
    },
    gates,
    claims: [
      'Return line sum can exceed SI TotalAmount when SI was under-billed (Subtotal=GR, Total=supplier AP)',
      'Create Credit Note caps SCN AP at bill TotalAmount when return ≤ Subtotal',
      'Paid bills are allowed — return SCNs post on-account (no ERR_SCN_EXCEEDS_BILL_OPEN)',
      'GL: DR AP (capped) + DR 5020 (variance) / CR clearing (return goods)',
    ],
  };
  const md = [
    '# PROOF: SCN under-bill return ceiling',
    '',
    `**Result:** ${passed ? 'PASS' : 'FAIL'}`,
    `**As of:** ${payload.asOf}`,
    '',
    '## Scenario (Henber)',
    '',
    `| Field | Value |`,
    `|---|---|`,
    `| Return goods | ${HENBER.returnGoods} |`,
    `| Bill Subtotal | ${HENBER.billSubtotal} |`,
    `| Bill TotalAmount (AP) | ${HENBER.billTotal} |`,
    `| SCN AP cap | ${HENBER.billTotal} |`,
    `| PPV reverse (5020) | ${HENBER.variance} |`,
    '',
    '## Claims',
    ...payload.claims.map((c) => `- ${c}`),
    '',
    '## Gates',
    ...gates.map((g) => `- ${g.ok ? '✅' : '❌'} \`${g.id}\` — ${g.detail}`),
    '',
  ].join('\n');

  writeFileSync(outJson, JSON.stringify(payload, null, 2));
  writeFileSync(outMd, md);
  writeFileSync(outServerJson, JSON.stringify(payload, null, 2));
  writeFileSync(outServerMd, md);
  expect(passed).toBe(true);
});
