/**
 * Station / kitchen_station codes are varchar identifiers (may look numeric: "002", "1000").
 * Always normalize through String before .trim() / .toUpperCase().
 */

export function normalizeStationCode(code: unknown): string {
  return String(code ?? '')
    .trim()
    .toUpperCase();
}

/** Exact match, or digit-only numeric equivalence (2 ↔ 002). */
export function stationCodesEquivalent(a: unknown, b: unknown): boolean {
  const left = normalizeStationCode(a);
  const right = normalizeStationCode(b);
  if (!left || !right) return false;
  if (left === right) return true;
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
    return Number(left) === Number(right);
  }
  return false;
}

export function normalizePrinterName(name: unknown): string | null {
  const n = String(name ?? '').trim();
  return n || null;
}
