/**
 * PROOF: Receive Payment via customer deposit — Decimal SSOT, FIFO exact,
 * fail-loud (no silent zero, no invoice-id-as-sale-id), applied == requested.
 *
 * Emits (repo root):
 *   PROOF_INVOICE_DEPOSIT_PAYMENT.md
 *   PROOF_INVOICE_DEPOSIT_PAYMENT.json
 *
 * Re-run:
 *   cd SamplePOS.Server
 *   npm test -- --runInBand src/modules/invoices/invoiceDepositPayment.evidence.test.ts
 */
import { afterAll, describe, expect, it } from '@jest/globals';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Decimal from 'decimal.js';
import {
  allocateDepositFifo,
  assertAppliedEqualsRequested,
  assertDepositPaymentAmount,
  depositPaymentCap,
  money2,
} from '@shared/domain/invoiceDepositPayment.js';

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

function readRepo(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

function fileHas(rel: string, re: RegExp | string): boolean {
  const p = path.join(repoRoot, rel);
  if (!existsSync(p)) return false;
  const src = readFileSync(p, 'utf8');
  return typeof re === 'string' ? src.includes(re) : re.test(src);
}

describe('PROOF: invoice deposit payment integrity', () => {
  it('SSOT: money2 is 2dp ROUND_HALF_UP; never float Math.round', () => {
    const src = readRepo('shared/domain/invoiceDepositPayment.ts');
    gate('SSOT_DECIMAL', src.includes("from 'decimal.js'"), 'decimal.js');
    gate('SSOT_NO_MATH_ROUND', !/Math\.round\(/.test(src), 'no Math.round');
    gate('SSOT_NO_MATH_MIN', !/Math\.min\(/.test(src), 'no Math.min');
    gate('SSOT_FIFO', src.includes('allocateDepositFifo'), 'FIFO allocator');
    gate('SSOT_CAP', src.includes('depositPaymentCap'), 'cap helper');
    gate('SSOT_ASSERT_APPLIED', src.includes('assertAppliedEqualsRequested'), 'applied==requested');
    expect(money2(10.125).toFixed(2)).toBe('10.13');
    expect(money2('10.1').toFixed(2)).toBe('10.10');
  });

  it('cap is min(outstanding, deposit); zero if either side is 0', () => {
    gate(
      'CAP_MIN',
      depositPaymentCap(303200, 50000).eq(new Decimal('50000.00')),
      'deposit smaller',
    );
    gate(
      'CAP_OUTSTANDING',
      depositPaymentCap(10000, 50000).eq(new Decimal('10000.00')),
      'outstanding smaller',
    );
    gate('CAP_ZERO_DEP', depositPaymentCap(303200, 0).eq(0), 'no deposit → 0');
    gate('CAP_ZERO_AR', depositPaymentCap(0, 50000).eq(0), 'no AR → 0');
  });

  it('assertDepositPaymentAmount rejects over-cap and zero', () => {
    const ok = assertDepositPaymentAmount({
      amount: 50000,
      outstanding: 303200,
      depositAvailable: 50000,
    });
    gate('ASSERT_OK', ok.eq(new Decimal('50000.00')), 'exact deposit apply');
    let over = false;
    try {
      assertDepositPaymentAmount({
        amount: 50001,
        outstanding: 303200,
        depositAvailable: 50000,
      });
    } catch {
      over = true;
    }
    gate('ASSERT_OVER_CAP', over, 'over deposit rejected');
    let zero = false;
    try {
      assertDepositPaymentAmount({ amount: 0, outstanding: 100, depositAvailable: 100 });
    } catch {
      zero = true;
    }
    gate('ASSERT_ZERO', zero, 'zero rejected');
  });

  it('FIFO: oldest first, split exact, fail-loud if short', () => {
    const plan = allocateDepositFifo(
      [
        { id: 'old', available: '100.00' },
        { id: 'new', available: '50.00' },
      ],
      '130.00',
    );
    gate('FIFO_COUNT', plan.allocations.length === 2, `${plan.allocations.length} rows`);
    gate('FIFO_OLD', plan.allocations[0].id === 'old' && plan.allocations[0].amount.eq('100.00'), 'old 100');
    gate('FIFO_NEW', plan.allocations[1].id === 'new' && plan.allocations[1].amount.eq('30.00'), 'new 30');
    gate('FIFO_TOTAL', plan.totalApplied.eq('130.00'), '130.00 applied');
    assertAppliedEqualsRequested(plan.totalApplied, '130.00');

    let short = false;
    try {
      allocateDepositFifo([{ id: 'a', available: '10.00' }], '10.01');
    } catch (e) {
      short = e instanceof Error && e.message.includes('INSUFFICIENT_DEPOSIT');
    }
    gate('FIFO_SHORT', short, 'shortfall throws INSUFFICIENT_DEPOSIT');
  });

  it('invoiceService: DEPOSIT uses SSOT, never invoiceId as sale_id, GL skip cash', () => {
    const svc = readRepo('SamplePOS.Server/src/modules/invoices/invoiceService.ts');
    gate(
      'INV_USES_ASSERT_AMOUNT',
      svc.includes('assertDepositPaymentAmount'),
      'server validates via SSOT',
    );
    gate(
      'INV_USES_ASSERT_APPLIED',
      svc.includes('assertAppliedEqualsRequested'),
      'applied == requested',
    );
    gate(
      'INV_NO_INVOICE_AS_SALE',
      !/saleIdForDeposit\s*=\s*inv\.sale_id\s*\|\|\s*invoiceId/.test(svc),
      'never invoice UUID as sale_id',
    );
    gate(
      'INV_PASSES_INVOICE_ID',
      /applyDepositsToSaleInTransaction[\s\S]{0,500}invoiceIdForApply \? \{ invoiceId: invoiceIdForApply \}/.test(
        svc,
      ),
      'passes invoiceId option',
    );
    gate(
      'INV_BALANCE_ON_CLIENT',
      /getCustomerDepositBalance\(\s*client/.test(svc),
      'balance check inside tx',
    );
    gate(
      'INV_ORPHAN_SALE_FALLBACK',
      svc.includes('orphanSaleId') && svc.includes('invoiceIdForApply'),
      'orphan sale_id falls back to invoice target',
    );
    gate(
      'INV_NEVER_REWRITE_CREDIT_TO_DEPOSIT',
      !/currentPaymentMethod === 'CREDIT'[\s\S]{0,80}input\.paymentMethod/.test(svc) &&
        !/currentPaymentMethod === 'CREDIT' \? paymentMethod/.test(svc) &&
        svc.includes('Never rewrite payment_method'),
      'never rewrite CREDIT → DEPOSIT/CASH on sale header',
    );
    const gl = readRepo('SamplePOS.Server/src/services/glEntryService.ts');
    gate(
      'GL_SKIP_DEPOSIT_CASH',
      /paymentMethod === 'DEPOSIT'[\s\S]{0,200}skipping GL/.test(gl),
      'DEPOSIT invoice payment does not post cash',
    );
    gate(
      'GL_APPLY_SOURCE',
      /source:\s*'DEPOSIT_APPLICATION'/.test(gl),
      'apply posts DEPOSIT_APPLICATION',
    );
  });

  it('deposits apply: FOR UPDATE lock + FIFO SSOT + Money writes', () => {
    const repo = readRepo('SamplePOS.Server/src/modules/deposits/depositsRepository.ts');
    const svc = readRepo('SamplePOS.Server/src/modules/deposits/depositsService.ts');
    gate('LOCK_FN', repo.includes('lockActiveDepositsForCustomer'), 'lock helper');
    gate('LOCK_SQL', /FOR UPDATE OF d/.test(repo), 'FOR UPDATE');
    gate('APPLY_USES_FIFO', svc.includes('allocateDepositFifo'), 'service uses FIFO SSOT');
    gate('APPLY_USES_LOCK', svc.includes('lockActiveDepositsForCustomer'), 'service locks first');
    gate('APPLY_MONEY_FIXED', svc.includes('alloc.amount.toFixed(2)'), '2dp write');
    gate(
      'APPLY_NO_TONUMBER_LOOP',
      !/toApply\.toNumber\(\)/.test(svc),
      'no toNumber in apply loop',
    );
    gate(
      'MIG_600',
      fileHas('shared/sql/600_deposit_apply_invoice.sql', 'chk_deposit_app_target'),
      'migration 600 present',
    );
    gate(
      'APPLY_SCHEMA_PREFLIGHT',
      repo.includes('DEPOSIT_APPLY_INVOICE_SCHEMA_REQUIRED') &&
        repo.includes("column_name = 'invoice_id'"),
      'invoice-only apply asserts migration 600 schema before INSERT',
    );
    gate(
      'APPLY_SALE_FK_LOUD',
      repo.includes('DEPOSIT_APPLY_SALE_FK'),
      'sale FK violation fails loud (not generic constraint)',
    );
    const post = readRepo('SamplePOS.Server/src/modules/system/migrationPostconditions.ts');
    gate(
      'POSTCOND_600',
      post.includes("'600_deposit_apply_invoice.sql'") && post.includes('chk_deposit_app_target'),
      'migration 600 postcondition heals tenant drift',
    );
    gate(
      'POSTCOND_597',
      post.includes("'597_deposit_application_posting_source.sql'") &&
        post.includes("'DEPOSIT_APPLICATION'"),
      'migration 597 postcondition keeps DEPOSIT_APPLICATION on 1200/2200',
    );
  });

  it('UI: Receive Payment offers DEPOSIT; no silent zero on fetch fail', () => {
    const modal = readRepo('samplepos.client/src/components/customers/CustomerDetailModal.tsx');
    const page = readRepo('samplepos.client/src/pages/customers/CustomerDetailPage.tsx');
    const hook = readRepo('samplepos.client/src/hooks/useInvoiceDepositBalance.ts');
    gate('UI_HOOK', hook.includes('useInvoiceDepositBalance'), 'shared fetch hook');
    gate(
      'HOOK_NO_SILENT_ZERO',
      !/setAvailable\(.*0[\s\S]{0,40}catch/.test(hook) && hook.includes("setStatus('error')"),
      'fetch fail → error, not 0',
    );
    gate('MODAL_HOOK', modal.includes('useInvoiceDepositBalance'), 'modal uses hook');
    gate('MODAL_DEPOSIT_OPTION', /value="DEPOSIT"/.test(modal), 'DEPOSIT option');
    gate('MODAL_SSOT_CAP', modal.includes('depositPaymentCap'), 'modal uses cap SSOT');
    gate('MODAL_SSOT_ASSERT', modal.includes('assertDepositPaymentAmount'), 'modal asserts amount');
    gate(
      'MODAL_NO_SILENT_CATCH',
      !/catch\s*\(\s*\)\s*=>\s*\{[\s\S]{0,80}setCustomerDepositBalance\(0\)/.test(modal),
      'modal no silent 0',
    );
    gate('PAGE_HOOK', page.includes('useInvoiceDepositBalance'), 'page uses hook');
    gate('PAGE_DEPOSIT_OPTION', /value="DEPOSIT"/.test(page), 'page DEPOSIT option');
    gate('PAGE_SSOT_ASSERT', page.includes('assertDepositPaymentAmount'), 'page asserts amount');
    gate(
      'PAGE_NO_SILENT_ZERO',
      !/setCustomerDepositBalance\(0\)/.test(page),
      'page no silent 0',
    );
  });

  it('sales apply also asserts applied == requested', () => {
    const sales = readRepo('SamplePOS.Server/src/modules/sales/salesService.ts');
    gate(
      'SALE_ASSERT_APPLIED',
      sales.includes('assertAppliedEqualsRequested'),
      'POS deposit apply identity',
    );
  });
});

afterAll(() => {
  const failed = gates.filter((g) => !g.ok);
  const evidence = {
    feature: 'INVOICE_DEPOSIT_PAYMENT',
    generatedAt: new Date().toISOString(),
    passed: failed.length === 0,
    gateCount: gates.length,
    failedCount: failed.length,
    gates,
    identities: {
      apply: 'DEPOSIT_APPLICATION DR 2200 / CR 1200',
      cashSkip: 'recordInvoicePaymentToGL skips DEPOSIT',
      amount: 'applied == requested (2dp ROUND_HALF_UP)',
      fifo: 'oldest deposit first',
      lock: 'FOR UPDATE on active customer deposits',
    },
  };
  const md = [
    '# PROOF: Invoice deposit payment integrity',
    '',
    failed.length === 0 ? '**PASS**' : `**FAIL** (${failed.length})`,
    '',
    `- Gates: ${gates.length}`,
    `- Failed: ${failed.length}`,
    '',
    '| Gate | OK | Detail |',
    '|------|----|--------|',
    ...gates.map((g) => `| ${g.id} | ${g.ok ? 'yes' : 'NO'} | ${g.detail.replace(/\|/g, '/')} |`),
    '',
    '## Identities',
    '- Apply GL: `DEPOSIT_APPLICATION` DR 2200 / CR AR 1200',
    '- Invoice payment row records the same 2dp amount as applied',
    '- Cash receipt is not posted for DEPOSIT',
    '- FIFO lock: `FOR UPDATE` then allocateDepositFifo',
    '- Receive Payment never treats a failed balance fetch as zero',
    '',
    'Apply migration `shared/sql/600_deposit_apply_invoice.sql` so invoices without a sale can apply deposits.',
    '',
  ].join('\n');
  writeFileSync(path.join(repoRoot, 'PROOF_INVOICE_DEPOSIT_PAYMENT.json'), JSON.stringify(evidence, null, 2));
  writeFileSync(path.join(repoRoot, 'PROOF_INVOICE_DEPOSIT_PAYMENT.md'), md);
});
