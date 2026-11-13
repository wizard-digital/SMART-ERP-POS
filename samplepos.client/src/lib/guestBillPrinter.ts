/**
 * Guest bill printer SSOT — FOH check print target (not a kitchen station).
 * Cached for offline bill print; live value from restaurant/guest-bill-printer.
 */

const CACHE_KEY = 'pos.restaurant.guestBillPrinter.v1';

export function readCachedGuestBillPrinter(): string | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const v = localStorage.getItem(CACHE_KEY);
    const t = (v || '').trim();
    return t || null;
  } catch {
    return null;
  }
}

export function writeCachedGuestBillPrinter(printerName: string | null): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const t = String(printerName ?? '').trim();
    if (!t) localStorage.removeItem(CACHE_KEY);
    else localStorage.setItem(CACHE_KEY, t);
  } catch {
    // ignore
  }
}
