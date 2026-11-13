/**
 * Restaurant FOH print policy SSOT — silent thermal via local Printer Service.
 *
 * Browsers cannot print silently to a named Windows printer. Restaurant KOT/Bill
 * therefore use localhost:1811 only. Browser print dialog is an emergency opt-in
 * for terminals without the service (off by default).
 */

import { getPrinterServiceHealthCache } from './printAgentHealth';

const BROWSER_FALLBACK_KEY = 'pos.restaurant.allowBrowserPrintFallback.v1';

export function isRestaurantBrowserPrintFallbackEnabled(): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    return localStorage.getItem(BROWSER_FALLBACK_KEY) === '1';
  } catch {
    return false;
  }
}

export function setRestaurantBrowserPrintFallbackEnabled(enabled: boolean): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (enabled) localStorage.setItem(BROWSER_FALLBACK_KEY, '1');
    else localStorage.removeItem(BROWSER_FALLBACK_KEY);
  } catch {
    // ignore
  }
}

function serviceLooksOnline(): boolean {
  const h = getPrinterServiceHealthCache();
  return h.status === 'online' || h.status === 'restarting';
}

/**
 * User-facing print failure — never say "agent offline" when /health is online.
 * Usual case: station mapped to a name that is not a real Windows printer.
 */
export function silentPrintFailureMessage(printerName?: string | null): string {
  const name = String(printerName ?? '').trim() || undefined;
  const online = serviceLooksOnline();

  if (name) {
    if (online) {
      return `Printer "${name}" is not available on this PC. Remap the station under Restaurant → Stations to an exact Windows name (see Printers → Installed printers). Ticket is on KDS.`;
    }
    return `Could not print to "${name}" — Printer Service is offline. Ask a manager to start it (Restaurant → Printers). Ticket is on KDS.`;
  }

  if (online) {
    return 'Print failed — map Kitchen/Bar printers under Restaurant → Stations (exact Windows names). Ticket is on KDS.';
  }
  return 'Print failed — Printer Service is offline on this PC. Ask a manager to start it. Ticket is on KDS.';
}

/** FOH toast when KOT committed but paper delivery failed. */
export function kotPrintPartialSuccessMessage(kotCount: number, printFailures: number): string {
  const online = serviceLooksOnline();
  if (online) {
    return `KOT recorded (${kotCount}) — ${printFailures} ticket(s) did not print. Check station printer mapping (exact Windows names). Use KDS until fixed.`;
  }
  return `KOT recorded (${kotCount}) — ${printFailures} ticket(s) did not print. Printer Service is offline — ask a manager (Restaurant → Printers). Use KDS until fixed.`;
}
