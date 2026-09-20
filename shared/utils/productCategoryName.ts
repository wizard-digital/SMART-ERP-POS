/**
 * Product category name SSOT — normalize + compare.
 * Duplicate names are not allowed regardless of case / surrounding spaces.
 */
export function normalizeProductCategoryName(name: string): string {
  return String(name ?? '')
    .trim()
    .replace(/\s+/g, ' ');
}

export function productCategoryNamesEqual(a: string, b: string): boolean {
  return (
    normalizeProductCategoryName(a).toLowerCase() ===
    normalizeProductCategoryName(b).toLowerCase()
  );
}
