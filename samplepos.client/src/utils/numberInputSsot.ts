/**
 * Number-input spinner SSOT (browser ↑↓ / mouse wheel on type="number").
 *
 * Money fields:
 * - step = 1 (clear ↑↓, UGX-friendly)
 * - do NOT set HTML min with step=1 — Chromium uses min as step base and snaps
 *   1200.06 → 1201 on ArrowUp when min="0". Enforce amount > 0 in JS instead.
 * - money <form> MUST use noValidate so typed decimals (0.05, 200.11) Save
 *   without HTML5 stepMismatch blocking submit.
 *
 * Fine-grain qty/UoM conversion may set an explicit smaller step (+ optional min).
 */
export const MONEY_INPUT_STEP = '1' as const;

/** @deprecated use MONEY_INPUT_STEP — alias for call sites that say “amount” */
export const AMOUNT_INPUT_STEP = MONEY_INPUT_STEP;

/**
 * Browser spinner semantics: value += direction * step.
 * Matches Chromium ArrowUp/Down when step=1 and min is omitted.
 */
export function applyMoneySpinnerStep(value: number, direction: 1 | -1): number {
  return value + direction * Number(MONEY_INPUT_STEP);
}

/** Shared Input default: type=number with no step → MONEY_INPUT_STEP. */
export function resolveNumberInputStep(
  type: string | undefined,
  step: string | number | undefined | null,
): string | number | undefined {
  if (type === 'number' && (step === undefined || step === null || step === '')) {
    return MONEY_INPUT_STEP;
  }
  return step === null ? undefined : step;
}

/**
 * HTML5 step validity (Chromium/WHATWG) when min is present:
 * (value - min) / step must be an integer.
 */
export function isHtmlNumberStepValid(value: number, step: number, min: number): boolean {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) return false;
  const n = (value - min) / step;
  return Math.abs(n - Math.round(n)) < 1e-8;
}

/** True for the shipping bug: min=0.01 + step=1 rejects amount 1000 in Chromium. */
export function isBrokenMoneyMinStepPair(min: number, step: number): boolean {
  return step === 1 && !isHtmlNumberStepValid(1000, step, min);
}

/** True when min is set with step 1 — Chromium will snap fractional money on ↑↓. */
export function moneyStepShouldOmitHtmlMin(step: string | number = MONEY_INPUT_STEP): boolean {
  return String(step) === '1' || Number(step) === 1;
}

/**
 * One JSX number tag that pairs step 1 with a min Chromium will not align to
 * a whole amount. `min={0.01}` is the Receive Payment failure: 200000 is rejected
 * and the nearest allowed values are *.01.
 */
export function jsxMoneyInputRejectsWholeAmount(tag: string): boolean {
  if (!/\bstep\s*=\s*(?:["']1["']|\{\s*1\s*\})/.test(tag)) return false;
  const min = tag.match(/\bmin\s*=\s*(?:["']([0-9]*\.?[0-9]+)["']|\{\s*([0-9]*\.?[0-9]+)\s*\})/);
  if (!min) return false;
  const n = Number(min[1] ?? min[2]);
  return Number.isFinite(n) && isBrokenMoneyMinStepPair(n, 1);
}
