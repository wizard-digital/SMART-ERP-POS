/**
 * PROOF: Post-finalize GR bill prompt — compact variance UX + smart reason gating.
 *
 * Emits (repo root):
 *   PROOF_GRN_BILL_PROMPT_DEFAULTS.json
 *   PROOF_GRN_BILL_PROMPT_DEFAULTS.md
 *
 * Run:
 *   npx vitest run src/__tests__/grn-bill-prompt-defaults.evidence.test.ts
 */
import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  alignPaperTotalToGrAmount,
  buildGrnBillPromptDefaults,
  defaultSupplierInvoiceNumberFromGr,
  formatGrnBillableTotalForInput,
  GRN_BILL_PROMPT_COPY,
  isGrnBillRoundingReasonAllowed,
  isLikelyGrnBillDigitShiftTypo,
  isSupplierReportedTotalMatchingComputed,
  listGrnBillUnderVarianceReasons,
  resolveGrnBillDigitShiftGuidance,
  resolveGrnBillOverGuidance,
  resolveGrnBillPromptSupplierLabel,
  resolveGrnBillPromptVariance,
  suggestGrnBillVarianceReason,
} from '@shared/domain/grnBillPromptSsot';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

type Gate = { id: string; ok: boolean; detail: string };
const gates: Gate[] = [];

function gate(id: string, ok: boolean, detail: string): void {
  gates.push({ id, ok, detail });
  expect({ id, ok, detail }).toEqual({ id, ok: true, detail });
}

function read(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

function fileHas(rel: string, needle: string | RegExp): boolean {
  const p = path.join(repoRoot, rel);
  if (!existsSync(p)) return false;
  const src = readFileSync(p, 'utf8');
  return typeof needle === 'string' ? src.includes(needle) : needle.test(src);
}

describe('PROOF: GRN bill prompt defaults SSOT', () => {
  it('pure defaults: total prefill, invoice #, supplier label, match epsilon', () => {
    gate(
      'TOTAL_PREFILL',
      formatGrnBillableTotalForInput(700999.2) === '700999.20' &&
        formatGrnBillableTotalForInput(700999.204) === '700999.20' &&
        formatGrnBillableTotalForInput(0) === '',
      'computed total → 2dp input string',
    );
    gate(
      'INV_NUMBER',
      defaultSupplierInvoiceNumberFromGr('GR-2026-0007') === 'INV-GR-2026-0007' &&
        defaultSupplierInvoiceNumberFromGr('') === '',
      'INV-{GR} default invoice number',
    );
    gate(
      'SUPPLIER_LABEL',
      resolveGrnBillPromptSupplierLabel('BECCA KATO') === 'BECCA KATO' &&
        resolveGrnBillPromptSupplierLabel('') === 'From goods receipt (locked)',
      'supplier display from GR name or locked fallback',
    );
    gate(
      'MATCH_EPS',
      isSupplierReportedTotalMatchingComputed(700999.2, 700999.2) &&
        isSupplierReportedTotalMatchingComputed(700999.2, 700999.204) &&
        !isSupplierReportedTotalMatchingComputed(701000, 700999.2),
      'paper vs computed match within 0.005',
    );

    const defaults = buildGrnBillPromptDefaults({
      grId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      grNumber: 'GR-2026-0007',
      computedTotal: 700999.2,
      supplierName: 'BECCA KATO',
      invoiceDate: '2026-08-29',
    });
    gate(
      'BUILD_DEFAULTS',
      defaults.supplierInvoiceNumber === 'INV-GR-2026-0007' &&
        defaults.supplierReportedTotal === '700999.20' &&
        defaults.supplierName === 'BECCA KATO' &&
        defaults.varianceReason === '' &&
        defaults.total === 700999.2,
      'buildGrnBillPromptDefaults packs all prompt fields',
    );

    const withPaper = buildGrnBillPromptDefaults({
      grId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      grNumber: 'GR-2026-0008',
      computedTotal: 700999.2,
      supplierName: 'BECCA KATO',
      paperTotalOverride: 701000,
    });
    gate(
      'PAPER_OVERRIDE',
      withPaper.supplierReportedTotal === '701000.00' && withPaper.total === 700999.2,
      'paper override keeps supplier figure; GR total unchanged',
    );

    const under = resolveGrnBillPromptVariance(1000, '980');
    const over = resolveGrnBillPromptVariance(700999.2, '701000');
    const match = resolveGrnBillPromptVariance(1000, '1000');
    const empty = resolveGrnBillPromptVariance(1000, '');
    gate(
      'VARIANCE_UNDER',
      under.direction === 'under' &&
        under.absVariance === 20 &&
        under.varianceAmount === 20 &&
        under.summary === 'Under 20.00',
      'paper < GR → under; abs + short summary',
    );
    gate(
      'VARIANCE_OVER',
      over.direction === 'over' &&
        over.absVariance === 0.8 &&
        over.paperTotal === 701000 &&
        over.computedTotal === 700999.2 &&
        over.summary.includes('Over'),
      'paper 701000 vs GR 700999.20 → over 0.80; both figures kept',
    );
    gate(
      'VARIANCE_MATCH_NONE',
      match.direction === 'match' &&
        match.absVariance === 0 &&
        empty.direction === 'none' &&
        !empty.hasPaperTotal,
      'match when equal; none until paper total entered',
    );

    gate(
      'ALIGN_TO_GR',
      alignPaperTotalToGrAmount(700999.2) === '700999.20' &&
        resolveGrnBillOverGuidance(0.8).includes('bill at GR amount'),
      'explicit align-to-GR + over guidance (no silent clamp)',
    );

    const reasonsSmall = listGrnBillUnderVarianceReasons(0.5);
    const reasonsBig = listGrnBillUnderVarianceReasons(20);
    gate(
      'REASON_ROUNDING_GATED',
      isGrnBillRoundingReasonAllowed(0.5) &&
        !isGrnBillRoundingReasonAllowed(20) &&
        reasonsSmall.some((r) => r.value === 'ROUNDING_DIFFERENCE') &&
        !reasonsBig.some((r) => r.value === 'ROUNDING_DIFFERENCE') &&
        suggestGrnBillVarianceReason('under', 0.5) === 'ROUNDING_DIFFERENCE' &&
        suggestGrnBillVarianceReason('under', 20) === '',
      'rounding reason only when |diff| ≤ 1; auto-suggest then',
    );
    gate(
      'DIGIT_SHIFT_TYPO',
      isLikelyGrnBillDigitShiftTypo(136_000.04, 1_360_000) &&
        isLikelyGrnBillDigitShiftTypo(136_000.04, 13_600) &&
        !isLikelyGrnBillDigitShiftTypo(100_000, 85_000) &&
        !isLikelyGrnBillDigitShiftTypo(100_000, 100_000) &&
        resolveGrnBillDigitShiftGuidance(136_000.04, 1_360_000).includes('extra zero'),
      '≈10× / ≈0.1× paper vs GR flagged as digit typo; ordinary discounts not',
    );
  });

  it('client wiring: GoodsReceiptsPage uses SSOT for compact prompt', () => {
    const page = read('samplepos.client/src/pages/inventory/GoodsReceiptsPage.tsx');
    gate(
      'UI_IMPORTS_SSOT',
      page.includes('grnBillPromptSsot') &&
        page.includes('buildGrnBillPromptDefaults') &&
        page.includes('resolveGrnBillPromptSupplierLabel') &&
        page.includes('resolveGrnBillPromptVariance') &&
        page.includes('alignPaperTotalToGrAmount') &&
        page.includes('resolveGrnBillOverGuidance') &&
        page.includes('isLikelyGrnBillDigitShiftTypo') &&
        page.includes('resolveGrnBillDigitShiftGuidance') &&
        page.includes('listGrnBillUnderVarianceReasons') &&
        page.includes('GRN_BILL_PROMPT_COPY'),
      'GoodsReceiptsPage imports bill prompt SSOT',
    );
    gate(
      'UI_COMPACT_SHELL',
      page.includes('max-h-[min(92vh,640px)]') &&
        page.includes('overflow-y-auto') &&
        page.includes('shrink-0') &&
        page.includes('Create bill'),
      'modal scrolls body; footer sticky with Create bill',
    );
    gate(
      'UI_VARIANCE_PANEL',
      page.includes('resolveGrnBillPromptVariance') &&
        page.includes('GRN_BILL_PROMPT_COPY.variancePanelTitle') &&
        page.includes('variance.computedTotal') &&
        page.includes('variance.paperTotal') &&
        page.includes('variance.absVariance') &&
        page.includes('listGrnBillUnderVarianceReasons'),
      'single variance panel + gated reasons from SSOT',
    );
    gate(
      'UI_USES_BUILD',
      /setBillPrompt\(\s*buildGrnBillPromptDefaults\(/.test(page) &&
        page.includes('paperTotalOverride: draftPaperInvoiceTotal'),
      'setBillPrompt uses buildGrnBillPromptDefaults + draft paper carry',
    );
    gate(
      'UI_DRAFT_MATCH',
      page.includes('draftPaperInvoiceTotal') &&
        page.includes('Supplier invoice (paper)') &&
        page.includes('GRN_BILL_PROMPT_COPY.billAtGrLabel') &&
        page.includes('alignPaperTotalToGrAmount'),
      'draft GR match check + bill-at-GR action (integrity)',
    );
    gate(
      'UI_NO_SILENT_CLAMP',
      !page.includes('clampPaperTotalToGrCeiling') &&
        !page.includes('max={billPrompt.total}'),
      'paper typing is not silently clamped to GR',
    );
    gate(
      'UI_NO_SUPPLIER_PICKER',
      !page.includes('Select supplier') &&
        page.includes('body.supplierReportedTotal = supplierTotalNum'),
      'prompt POST has no supplier picker; only grnId + reported total',
    );
    gate(
      'UI_BILLABLE_PREVIEW',
      page.includes('/supplier-payments/grns/') && page.includes('billable-total'),
      'computed amount from server billable-total preview',
    );
  });

  it('server: from-grn has no client supplierId; rounding gated', () => {
    const routes = read('SamplePOS.Server/src/modules/supplier-payments/supplierPaymentRoutes.ts');
    const svc = read('SamplePOS.Server/src/modules/supplier-payments/supplierPaymentService.ts');
    const validation = read(
      'SamplePOS.Server/src/modules/supplier-payments/supplierInvoiceGrnValidation.ts',
    );

    const schemaSlice = routes.slice(
      routes.indexOf('CreateInvoiceFromGRNSchema'),
      routes.indexOf('CreateAllocationSchema'),
    );
    gate(
      'API_NO_SUPPLIER_ID',
      schemaSlice.includes('grnId') &&
        schemaSlice.includes('supplierReportedTotal') &&
        !schemaSlice.includes('supplierId'),
      'CreateInvoiceFromGRNSchema has no supplierId field',
    );
    gate(
      'SVC_SUPPLIER_FROM_GR',
      /export async function createInvoiceFromGRN[\s\S]*?const supplierId = \(gr as \{ supplierId\?: string \}\)\.supplierId/.test(
        svc,
      ) && svc.includes('has no supplier — cannot create invoice'),
      'createInvoiceFromGRN takes supplierId from GR only',
    );
    gate(
      'SVC_ROUNDING_MAX',
      validation.includes('isGrnBillRoundingReasonAllowed') &&
        validation.includes('GRN_BILL_ROUNDING_MAX') &&
        validation.includes('ROUNDING_DIFFERENCE only allowed'),
      'server rejects ROUNDING when |diff| > 1',
    );
    gate(
      'SVC_DIGIT_SHIFT',
      validation.includes('isLikelyGrnBillDigitShiftTypo') &&
        validation.includes('resolveGrnBillDigitShiftGuidance'),
      'server rejects ≈10× / ≈0.1× paper vs GR as digit typo',
    );
    gate(
      'SSOT_FILE',
      fileHas('shared/domain/grnBillPromptSsot.ts', 'listGrnBillUnderVarianceReasons') &&
        fileHas('shared/domain/grnBillPromptSsot.ts', 'isLikelyGrnBillDigitShiftTypo'),
      'shared/domain/grnBillPromptSsot.ts present',
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
    feature: 'GRN_BILL_PROMPT_DEFAULTS',
    summary: { pass, fail, total: gates.length, verdict },
    scope:
      'Proven: draft + bill prompt show paper vs GR + variance; paper may exceed GR for visibility; AP posts only at ≤ GR via Bill at GR; rounding reason ≤1 under only',
    outOfScope: [
      'Live tenant POST from-grn mutation',
      'Editable supplier picker (intentionally absent)',
    ],
    gates,
  };

  writeFileSync(path.join(repoRoot, 'PROOF_GRN_BILL_PROMPT_DEFAULTS.json'), JSON.stringify(evidence, null, 2));
  writeFileSync(
    path.join(repoRoot, 'PROOF_GRN_BILL_PROMPT_DEFAULTS.md'),
    `# PROOF — GRN bill prompt defaults

**Generated:** ${at}  
**Verdict:** **${verdict}** (${pass}/${gates.length} gates)  
**Scope:** ${evidence.scope}

## Out of scope

${evidence.outOfScope.map((x) => `- ${x}`).join('\n')}

## Gates

| Gate | Result | Detail |
|------|--------|--------|
${gates.map((g) => `| \`${g.id}\` | ${g.ok ? 'PASS' : 'FAIL'} | ${g.detail.replace(/\|/g, '\\|')} |`).join('\n')}
`,
  );
  expect(fail).toBe(0);
});
