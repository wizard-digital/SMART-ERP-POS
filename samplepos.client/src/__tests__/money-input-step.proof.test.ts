/**
 * PROOF: Money number-input spinner SSOT (unit gates).
 * Chromium E2E: `scripts/proof-money-input-step-e2e.mjs` (canonical artifacts).
 * Runner: `npm run proof:money-input-step`
 */
import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { validateProductValues, buildCreateProductInput } from '@/validation/product';
import type { ProductFormValues } from '@/components/products/ProductForm';
import { validateProductPricing } from '@/utils/validation';
import {
  MONEY_INPUT_STEP,
  applyMoneySpinnerStep,
  resolveNumberInputStep,
  isHtmlNumberStepValid,
  isBrokenMoneyMinStepPair,
  moneyStepShouldOmitHtmlMin,
  jsxMoneyInputRejectsWholeAmount,
} from '@/utils/numberInputSsot';

const repoRoot = resolve(__dirname, '../../..');
const clientSrc = resolve(__dirname, '..');
const gates: Array<{ id: string; ok: boolean; detail?: string }> = [];
const results: string[] = [];

function gate(id: string, ok: boolean, detail?: string) {
  gates.push({ id, ok, detail });
  results.push(ok ? `- PASS ${id}${detail ? ` — ${detail}` : ''}` : `- FAIL ${id}${detail ? ` — ${detail}` : ''}`);
  expect(ok, detail ?? id).toBe(true);
}

const masterUoms = [{ id: '11111111-1111-4111-8111-111111111111', name: 'EACH' }];

function inventoryForm(overrides: Partial<ProductFormValues> = {}): ProductFormValues {
  return {
    name: 'Abchlor eye droped',
    sku: 'PRD-MRJ76HE-7L9A',
    barcode: '321450000',
    description: '',
    category: 'ART DRUGS',
    productType: 'inventory',
    genericName: '',
    costPrice: '200.11',
    sellingPrice: '1200.06',
    costingMethod: 'FIFO',
    isTaxable: true,
    taxRate: '8.02',
    pricingFormula: '',
    autoUpdatePrice: false,
    reorderLevel: '10',
    trackExpiry: false,
    minDaysBeforeExpirySale: '0',
    isActive: true,
    availableInRestaurant: false,
    isPreparedFood: false,
    isBuffetCover: false,
    preferredSupplierId: '',
    supplierProductCode: '',
    purchaseUomId: '',
    leadTimeDays: '0',
    reorderQuantity: '0',
    ...overrides,
  };
}

const FORBIDDEN_STEP_RE = /step\s*=\s*(?:\{\s*0\.(?:01|1)\s*\}|["']0\.(?:01|1)["'])/g;
const FORBIDDEN_MIN_RE = /min\s*=\s*(?:["']0\.01["']|\{\s*0\.01\s*\})/g;

function walkTsx(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__' || name === 'dist') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkTsx(p, out);
    else if (/\.(tsx|ts|jsx|js)$/.test(name) && !name.includes('.test.') && !name.includes('.spec.')) {
      out.push(p);
    }
  }
  return out;
}

describe('PROOF: Money input spinner step SSOT (unit)', () => {
  it('SSOT constant is 1 and HTML min must be omitted for step 1', () => {
    gate('SSOT_CONSTANT', MONEY_INPUT_STEP === '1', `MONEY_INPUT_STEP=${MONEY_INPUT_STEP}`);
    gate('SSOT_OMIT_MIN', moneyStepShouldOmitHtmlMin(MONEY_INPUT_STEP) === true, 'omit HTML min with step 1');
  });

  it('HTML5 model: min 0.01 + step 1 rejects whole amounts', () => {
    gate('MODEL_BUG_PAIR', isBrokenMoneyMinStepPair(0.01, 1) === true, '1000 stepMismatch under min=0.01');
    gate(
      'MODEL_200000',
      isHtmlNumberStepValid(200000, 1, 0.01) === false && isHtmlNumberStepValid(200000, 1, 0) === true,
      'Receive Payment 200000',
    );
    gate(
      'MODEL_JSX_MIN_EXPR',
      jsxMoneyInputRejectsWholeAmount('<input type="number" min={0.01} step="1" />') === true
        && jsxMoneyInputRejectsWholeAmount('<input type="number" step="1" />') === false,
      'min={0.01} is the same trap as min="0.01"',
    );
  });

  it('resolveNumberInputStep defaults type=number to MONEY_INPUT_STEP', () => {
    expect(resolveNumberInputStep('number', undefined)).toBe('1');
    expect(resolveNumberInputStep('number', '0.001')).toBe('0.001');
    gate('INPUT_DEFAULT_RESOLVE', true, 'type=number → step 1');
  });

  it('behavioral spinner ±1 keeps cents', () => {
    expect(applyMoneySpinnerStep(1200.06, 1)).toBeCloseTo(1201.06, 2);
    expect(applyMoneySpinnerStep(1200.06, -1)).toBeCloseTo(1199.06, 2);
    expect(applyMoneySpinnerStep(0.05, 1)).toBeCloseTo(1.05, 2);
    gate('SPINNER_DELTA_ONE', true, '1200.06±1 and 0.05→1.05');
  });

  it('typed decimals still validate', () => {
    const values = inventoryForm();
    const validated = validateProductValues(values, 'update');
    expect(validated.valid, JSON.stringify(validated.errors)).toBe(true);
    expect(validateProductPricing(200.11, 1200.06).valid).toBe(true);
    const payload = buildCreateProductInput(values, { masterUoms });
    expect(payload.ok).toBe(true);
    gate('TYPED_DECIMALS_OK', true, '200.11 / 1200.06 / 8.02');
  });

  it('Banking Add Transaction: noValidate + step 1 + no min + amount>0', () => {
    const tab = readFileSync(join(clientSrc, 'components/banking/BankTransactionsTab.tsx'), 'utf8');
    gate(
      'BANKING_NOVALIDATE',
      tab.includes('noValidate onSubmit={handleSubmitTransaction}')
        && tab.includes('noValidate onSubmit={handleSubmitTransfer}'),
      'txn + transfer forms',
    );
    const txnIdx = tab.indexOf('id="txn-amount"');
    const txnBlock = txnIdx >= 0 ? tab.slice(txnIdx, txnIdx + 450) : '';
    gate('BANKING_AMOUNT_STEP', /step="1"/.test(txnBlock), 'step=1');
    gate('BANKING_AMOUNT_NO_MIN', !/\bmin=/.test(txnBlock.split('/>')[0] ?? txnBlock), 'min omitted');
    gate('BANKING_AMOUNT_GT_ZERO_GUARD', tab.includes('Enter an amount greater than 0'), 'JS amount > 0');
  });

  it('Move money: quiet hover help + amount step 1 without min', () => {
    const page = readFileSync(join(clientSrc, 'pages/accounting/TreasuryTransferPage.tsx'), 'utf8');
    gate('MOVE_MONEY_QUIET', page.includes('QuietHoverHelp') && !page.includes('Move between any liquidity account'), 'essays behind hover');
    const amtIdx = page.indexOf('<Label>Amount</Label>');
    const amtBlock = amtIdx >= 0 ? page.slice(amtIdx, amtIdx + 280) : '';
    gate('MOVE_MONEY_AMOUNT_STEP', /step="1"/.test(amtBlock), 'step=1');
    gate('MOVE_MONEY_AMOUNT_NO_MIN', !/\bmin=/.test(amtBlock), 'min omitted');
  });

  it('Petty cash / Deposit worksheet amount fields omit HTML min with step 1', () => {
    const petty = readFileSync(join(clientSrc, 'pages/accounting/PettyCashPage.tsx'), 'utf8');
    const deposit = readFileSync(join(clientSrc, 'pages/accounting/DepositWorksheetPage.tsx'), 'utf8');
    const pettyAmt = petty.slice(petty.indexOf('<Label>Amount</Label>'), petty.indexOf('<Label>Amount</Label>') + 220);
    gate('PETTY_AMOUNT_NO_MIN', /step="1"/.test(pettyAmt) && !/\bmin=/.test(pettyAmt), 'petty amount');
    gate(
      'DEPOSIT_NO_MIN_STEP1',
      !/min=\{0\}[\s\S]{0,40}step="1"|step="1"[\s\S]{0,40}min=\{0\}/.test(deposit)
        && !/min="0"[\s\S]{0,40}step="1"/.test(deposit),
      'deposit worksheet money fields',
    );
  });

  it('Receive Payment: step 1, no HTML min, form noValidate so 200000 and 202499.99 save', () => {
    const modal = readFileSync(join(clientSrc, 'components/customers/CustomerDetailModal.tsx'), 'utf8');
    const formIdx = modal.indexOf('Receive Payment</h3>');
    const formOpen = formIdx >= 0 ? modal.slice(formIdx, formIdx + 900) : '';
    gate('RECEIVE_PAYMENT_NOVALIDATE', /<form\b[^>]*\bnoValidate\b/.test(formOpen), 'payment form noValidate');
    const amountIdx = modal.indexOf('Amount *</label>', formIdx);
    const methodIdx = modal.indexOf('Payment Method', amountIdx);
    const amountBlock = amountIdx >= 0 && methodIdx > amountIdx ? modal.slice(amountIdx, methodIdx) : '';
    gate('RECEIVE_PAYMENT_STEP', /step="1"/.test(amountBlock), 'step=1');
    gate('RECEIVE_PAYMENT_NO_MIN', !/\bmin=/.test(amountBlock), 'HTML min omitted');
    gate(
      'RECEIVE_PAYMENT_WHOLE_OK',
      jsxMoneyInputRejectsWholeAmount('<input type="number" step="1" />') === false
        && !/min\s*=\s*(?:["']0\.01["']|\{\s*0\.01\s*\})/.test(amountBlock),
      'whole shilling is not a step mismatch',
    );
  });

  it('client lock: no money step 0.01/0.1 and no min=0.01', () => {
    const stepHits: string[] = [];
    const minHits: string[] = [];
    // Bound the walk: only app source, skip assets/heavy trees
    const roots = ['components', 'pages', 'utils', 'hooks', 'lib'].map((d) => join(clientSrc, d));
    for (const root of roots) {
      try {
        for (const file of walkTsx(root)) {
          const rel = relative(repoRoot, file).replace(/\\/g, '/');
          if (rel.endsWith('/utils/numberInputSsot.ts')) continue;
          const src = readFileSync(file, 'utf8');
          FORBIDDEN_STEP_RE.lastIndex = 0;
          if (FORBIDDEN_STEP_RE.test(src)) stepHits.push(rel);
          FORBIDDEN_MIN_RE.lastIndex = 0;
          if (FORBIDDEN_MIN_RE.test(src)) minHits.push(rel);
        }
      } catch {
        /* missing dir ok */
      }
    }
    gate('NO_FRACTIONAL_MONEY_STEP', stepHits.length === 0, stepHits.join(', ') || 'clean');
    gate('NO_MIN_001_ON_MONEY', minHits.length === 0, minHits.join(', ') || 'clean');
  }, 30_000);
});

afterAll(() => {
  if (process.env.MONEY_STEP_PROOF_SKIP_WRITE === '1') return;
  const failed = gates.filter((g) => !g.ok);
  const verdict = failed.length === 0 ? 'PASS' : 'FAIL';
  writeFileSync(
    join(repoRoot, 'PROOF_MONEY_INPUT_STEP_SSOT.unit.json'),
    JSON.stringify(
      {
        proof: 'MONEY_INPUT_STEP_SSOT_UNIT',
        verdict,
        generatedAt: new Date().toISOString(),
        passed: gates.filter((g) => g.ok).length,
        total: gates.length,
        gates,
        note: 'Canonical E2E artifacts from scripts/proof-money-input-step-e2e.mjs',
      },
      null,
      2,
    ),
    'utf8',
  );
});
