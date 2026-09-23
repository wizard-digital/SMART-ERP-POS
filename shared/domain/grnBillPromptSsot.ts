/**
 * Post-finalize GR → supplier bill prompt SSOT.
 * Defaults, variance math, and reason gating must match GoodsReceiptsPage + createInvoiceFromGRN.
 *
 * Integrity: AP / supplier bill must never exceed GR received value.
 * Paper may be entered above GR for visibility — posting still requires match or under.
 */

export const GRN_BILL_VARIANCE_EPS = 0.005;

/** ROUNDING_DIFFERENCE only when |GR − paper| is at most this (currency units). */
export const GRN_BILL_ROUNDING_MAX = 1;

/**
 * Relative tolerance when detecting one-digit (×10 / ÷10) typos.
 * e.g. 1,360,000 vs 136,000.04 → ratio ≈ 10 within 2%.
 */
export const GRN_BILL_DIGIT_SHIFT_RATIO_TOL = 0.02;

/** Variance reasons accepted by UI + API (PRICE_VARIANCE removed — over-bill never allowed). */
export const GRN_BILL_VARIANCE_REASON_CODES = [
  'SUPPLIER_DISCOUNT',
  'ROUNDING_DIFFERENCE',
  'EDIT_LINE_PRICES',
] as const;

/** Money input prefill — 2 dp, matches UI currency rounding used for variance checks. */
export function formatGrnBillableTotalForInput(computedTotal: number): string {
  const n = Number(computedTotal);
  if (!Number.isFinite(n) || n <= 0) return '';
  return (Math.round(n * 100) / 100).toFixed(2);
}

/** Rounded money for display / variance math (2 dp). */
export function roundGrnBillMoney(amount: number): number {
  const n = Number(amount);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

/** Default supplier invoice number when user has not typed a paper number yet. */
export function defaultSupplierInvoiceNumberFromGr(grNumber: string | null | undefined): string {
  const gr = String(grNumber || '').trim();
  return gr ? `INV-${gr}` : '';
}

/**
 * Display label for supplier on the prompt — always from GR, never a picker.
 * Empty name still shows locked copy (server posts from GR.supplierId).
 */
export function resolveGrnBillPromptSupplierLabel(
  supplierName: string | null | undefined,
): string {
  const name = String(supplierName || '').trim();
  return name || 'From goods receipt (locked)';
}

export type GrnBillVarianceDirection = 'match' | 'under' | 'over' | 'none';

export type GrnBillVarianceReasonCode =
  | 'SUPPLIER_DISCOUNT'
  | 'ROUNDING_DIFFERENCE'
  | 'EDIT_LINE_PRICES';

export interface GrnBillPromptVariance {
  /** Valid paper total entered */
  hasPaperTotal: boolean;
  computedTotal: number;
  paperTotal: number;
  /** computed − paper (positive ⇒ supplier billed less than GR) */
  varianceAmount: number;
  absVariance: number;
  direction: GrnBillVarianceDirection;
  /** Short status for UI chips — not a paragraph */
  summary: string;
}

export interface GrnBillVarianceReasonOption {
  value: GrnBillVarianceReasonCode;
  label: string;
  /** Prefer / auto-select when under and within rounding band */
  preferred?: boolean;
}

/**
 * Align paper field to GR ceiling for posting (explicit user action — never silent).
 */
export function alignPaperTotalToGrAmount(computedTotal: number): string {
  return formatGrnBillableTotalForInput(computedTotal);
}

/** @deprecated Use alignPaperTotalToGrAmount for explicit align; do not silent-clamp typing. */
export function clampPaperTotalToGrCeiling(
  paperTotalRaw: string,
  computedTotal: number,
): string {
  const raw = String(paperTotalRaw ?? '').trim();
  if (raw === '') return '';
  const parsed = parseFloat(raw);
  if (!Number.isFinite(parsed)) return raw;
  const ceiling = roundGrnBillMoney(computedTotal);
  if (parsed > ceiling + GRN_BILL_VARIANCE_EPS) {
    return formatGrnBillableTotalForInput(ceiling);
  }
  return raw;
}

export function isGrnBillRoundingReasonAllowed(absVariance: number): boolean {
  const abs = Math.abs(Number(absVariance) || 0);
  return abs > GRN_BILL_VARIANCE_EPS && abs <= GRN_BILL_ROUNDING_MAX + GRN_BILL_VARIANCE_EPS;
}

/**
 * Detect classic extra/missing-zero typos: paper ≈ 10× GR or paper ≈ GR/10.
 * Only |log10(ratio)| ≈ 1 (one digit shift) within 2% — real discounts like 5–50% stay allowed.
 * Matches SBILL-style mistakes (e.g. 1,360,000 vs 136,000.04).
 */
export function isLikelyGrnBillDigitShiftTypo(
  computedTotal: number,
  paperTotal: number,
): boolean {
  const computed = roundGrnBillMoney(computedTotal);
  const paper = roundGrnBillMoney(paperTotal);
  if (!(computed > 0) || !(paper > 0)) return false;
  const ratio = paper / computed;
  if (!(ratio > 0) || !Number.isFinite(ratio)) return false;
  const log10 = Math.log10(ratio);
  if (!Number.isFinite(log10)) return false;
  const nearest = Math.round(log10);
  if (Math.abs(nearest) !== 1) return false;
  const reconstructed = 10 ** nearest;
  return Math.abs(ratio / reconstructed - 1) <= GRN_BILL_DIGIT_SHIFT_RATIO_TOL;
}

/** Operator guidance when paper looks like a digit/zero typo vs GR. */
export function resolveGrnBillDigitShiftGuidance(
  computedTotal: number,
  paperTotal: number,
): string {
  const computed = roundGrnBillMoney(computedTotal);
  const paper = roundGrnBillMoney(paperTotal);
  const direction = paper > computed ? 'extra zero' : 'missing digit';
  return (
    `Paper total ${paper.toFixed(2)} looks like a ${direction} typo vs GR ${computed.toFixed(2)}. ` +
    `Correct the paper amount (use Bill at GR amount) — do not post a 10× / 0.1× bill.`
  );
}

/** Reasons allowed for under-bill, filtered by variance size (rounding only ≤ 1). */
export function listGrnBillUnderVarianceReasons(
  absVariance: number,
): GrnBillVarianceReasonOption[] {
  const options: GrnBillVarianceReasonOption[] = [];
  if (isGrnBillRoundingReasonAllowed(absVariance)) {
    options.push({
      value: 'ROUNDING_DIFFERENCE',
      label: 'Rounding (≤ 1)',
      preferred: true,
    });
  }
  options.push({
    value: 'SUPPLIER_DISCOUNT',
    label: 'Supplier discount',
  });
  options.push({
    value: 'EDIT_LINE_PRICES',
    label: 'Wrong GR costs — fix GR first',
  });
  return options;
}

/** Auto-pick rounding when under and |diff| ≤ 1; otherwise leave blank for user. */
export function suggestGrnBillVarianceReason(
  direction: GrnBillVarianceDirection,
  absVariance: number,
): GrnBillVarianceReasonCode | '' {
  if (direction === 'under' && isGrnBillRoundingReasonAllowed(absVariance)) {
    return 'ROUNDING_DIFFERENCE';
  }
  return '';
}

/** One-line over-bill guidance — AP must not exceed GR. */
export function resolveGrnBillOverGuidance(absVariance: number): string {
  const abs = roundGrnBillMoney(absVariance);
  if (isGrnBillRoundingReasonAllowed(abs)) {
    return `Paper is ${abs.toFixed(2)} above GR (rounding). AP cannot exceed stock — bill at GR amount.`;
  }
  return `Paper is ${abs.toFixed(2)} above GR. AP cannot exceed stock — bill at GR amount, or correct the paper total.`;
}

/**
 * Live variance between GR computed total and paper invoice total.
 * Same sign convention as the prompt UI / GL preview (GR − paper).
 */
export function resolveGrnBillPromptVariance(
  computedTotal: number,
  paperTotalRaw: string | number | null | undefined,
  eps = GRN_BILL_VARIANCE_EPS,
): GrnBillPromptVariance {
  const computed = roundGrnBillMoney(computedTotal);
  const paperParsed =
    typeof paperTotalRaw === 'number'
      ? paperTotalRaw
      : parseFloat(String(paperTotalRaw ?? '').trim());
  const hasPaperTotal = Number.isFinite(paperParsed) && paperParsed > 0;
  if (!hasPaperTotal) {
    return {
      hasPaperTotal: false,
      computedTotal: computed,
      paperTotal: 0,
      varianceAmount: 0,
      absVariance: 0,
      direction: 'none',
      summary: 'Enter paper total',
    };
  }
  const paper = roundGrnBillMoney(paperParsed);
  const varianceAmount = roundGrnBillMoney(computed - paper);
  const absVariance = Math.abs(varianceAmount);
  if (absVariance <= eps) {
    return {
      hasPaperTotal: true,
      computedTotal: computed,
      paperTotal: paper,
      varianceAmount: 0,
      absVariance: 0,
      direction: 'match',
      summary: 'Match',
    };
  }
  if (paper > computed + eps) {
    return {
      hasPaperTotal: true,
      computedTotal: computed,
      paperTotal: paper,
      varianceAmount,
      absVariance,
      direction: 'over',
      summary: `Over ${absVariance.toFixed(2)}`,
    };
  }
  return {
    hasPaperTotal: true,
    computedTotal: computed,
    paperTotal: paper,
    varianceAmount,
    absVariance,
    direction: 'under',
    summary: `Under ${absVariance.toFixed(2)}`,
  };
}

export const GRN_BILL_PROMPT_COPY = {
  supplierLockedHint: 'From this GR (locked)',
  supplierTotalHint: 'Enter the paper invoice total — GR, paper, and variance stay visible',
  computedAmountHint: 'From GR lines (read-only)',
  variancePanelTitle: 'Match',
  billAtGrLabel: 'Bill at GR amount',
} as const;

/** True when paper total matches computed within AP variance epsilon (0.005). */
export function isSupplierReportedTotalMatchingComputed(
  reported: number,
  computed: number,
  eps = GRN_BILL_VARIANCE_EPS,
): boolean {
  return resolveGrnBillPromptVariance(computed, reported, eps).direction === 'match';
}

/**
 * Build initial prompt state after finalize — single place for defaults.
 * Optional paperTotalOverride keeps supplier paper figure when entered on the GR.
 */
export function buildGrnBillPromptDefaults(input: {
  grId: string;
  grNumber: string;
  computedTotal: number;
  supplierName?: string | null;
  invoiceDate?: string;
  /** Paper invoice total from GR draft match check (may differ from computed). */
  paperTotalOverride?: string | number | null;
}): {
  grId: string;
  grNumber: string;
  total: number;
  supplierName: string;
  supplierInvoiceNumber: string;
  invoiceDate: string;
  supplierReportedTotal: string;
  varianceReason: '';
} {
  const total = Number(input.computedTotal) || 0;
  const overrideRaw =
    input.paperTotalOverride === null || input.paperTotalOverride === undefined
      ? ''
      : String(input.paperTotalOverride).trim();
  const overrideNum = parseFloat(overrideRaw);
  const supplierReportedTotal =
    overrideRaw !== '' && Number.isFinite(overrideNum) && overrideNum > 0
      ? formatGrnBillableTotalForInput(overrideNum)
      : formatGrnBillableTotalForInput(total);
  return {
    grId: input.grId,
    grNumber: input.grNumber,
    total,
    supplierName: String(input.supplierName || '').trim(),
    supplierInvoiceNumber: defaultSupplierInvoiceNumberFromGr(input.grNumber),
    invoiceDate: input.invoiceDate || new Date().toLocaleDateString('en-CA'),
    supplierReportedTotal,
    varianceReason: '',
  };
}
