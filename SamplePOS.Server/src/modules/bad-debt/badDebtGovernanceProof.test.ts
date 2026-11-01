/**
 * Gate E / Phase 4D governance proof — Bad Debt (ADR-006)
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BAD_DEBT_TOUCHPOINT_REGISTRY,
  countBadDebtTouchpointsByStatus,
} from './badDebtTouchpointRegistry.js';
import {
  assertCreditNoteReasonNotBadDebt,
  BadDebtInvariantError,
  CREDIT_NOTE_BAD_DEBT_REASON_PATTERN,
} from '@shared/bad-debt/index.js';
import { AR_EXPENSE_CR_ALLOWLIST } from './badDebtOrphanScan.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

function readRepo(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

describe('Bad Debt governance proof (Phase 4D)', () => {
  it('BD14–BD16 registry entries are MIGRATED', () => {
    const ids = new Set(BAD_DEBT_TOUCHPOINT_REGISTRY.map((t) => t.id));
    for (const id of ['BD14', 'BD15', 'BD16']) {
      expect(ids.has(id)).toBe(true);
      const tp = BAD_DEBT_TOUCHPOINT_REGISTRY.find((t) => t.id === id)!;
      expect(tp.status).toBe('MIGRATED');
    }
    expect(countBadDebtTouchpointsByStatus('NOT_STARTED')).toBe(0);
  });

  it('BD-INV-4 rejects uncollectible CN reasons', () => {
    expect(() => assertCreditNoteReasonNotBadDebt('Price correction')).not.toThrow();
    expect(() => assertCreditNoteReasonNotBadDebt('Bad debt write-off')).toThrow(BadDebtInvariantError);
    expect(() => assertCreditNoteReasonNotBadDebt('Customer bankrupt')).toThrow(/BD-INV-4/);
    expect(CREDIT_NOTE_BAD_DEBT_REASON_PATTERN.test('uncollectible AR')).toBe(true);
  });

  it('CN create path wires BD-INV-4 guard', () => {
    const src = readRepo(
      'SamplePOS.Server/src/modules/credit-debit-notes/creditDebitNoteService.ts',
    );
    expect(src).toMatch(/assertCreditNoteReasonNotBadDebt/);
    expect(src.match(/assertCreditNoteReasonNotBadDebt/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('BD-INV-4 rejects collection-failure CN reasons', () => {
    expect(() => assertCreditNoteReasonNotBadDebt('cannot collect')).toThrow(BadDebtInvariantError);
    expect(() => assertCreditNoteReasonNotBadDebt('refused to pay')).toThrow(BadDebtInvariantError);
  });

  it('BD-INV-5 loss disposal does not credit AR 1200', () => {
    const src = readRepo(
      'SamplePOS.Server/src/modules/loss-quarantine/lossDisposalService.ts',
    );
    expect(src).toMatch(/CR 1300|5110|5120|5130/);
    expect(src).not.toMatch(/'1200'/);
    expect(src).not.toMatch(/AR_WRITEOFF/);
  });

  it('BD-INV-6 orphan allow-list + scan module exist', () => {
    expect([...AR_EXPENSE_CR_ALLOWLIST]).toEqual(
      expect.arrayContaining(['AR_WRITEOFF', 'AR_WRITEOFF_REVERSAL', 'SYSTEM_CORRECTION']),
    );
    expect(
      existsSync(path.join(repoRoot, 'SamplePOS.Server/src/modules/bad-debt/badDebtOrphanScan.ts')),
    ).toBe(true);
  });

  it('heal/repair never invents AR_WRITEOFF', () => {
    const repair = readRepo('SamplePOS.Server/src/modules/system/glRepairService.ts');
    expect(repair).not.toMatch(/createAndPostWriteoff|source:\s*'AR_WRITEOFF'/);
    expect(repair).toMatch(/never invents AR_WRITEOFF/i);
  });

  it('E-05 period-close checklist + AR writeoff lane', () => {
    const checklist = readRepo('samplepos.client/src/lib/financialCloseChecklist.ts');
    expect(checklist).toMatch(/step-bad-debt-writeoff/);
    expect(checklist).toMatch(/\/accounting\/bad-debt/);
    expect(checklist).toMatch(/blocksClose:\s*false/);

    const provider = readRepo(
      'SamplePOS.Server/src/modules/financial-reconciliation/providers/arReconciliationProvider.ts',
    );
    expect(provider).toMatch(/computeWriteoff/);
    expect(provider).toMatch(/'writeoff'/);
  });
});
